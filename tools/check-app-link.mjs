#!/usr/bin/env node
/**
 * 闸门：首页左栏「无线画布」→ 主区整块打开在线画布。
 *
 * ── 为什么值得一道闸门 ──────────────────────────────────────────
 * 这条链路有六个"单独看都对、合起来是坏的"层：
 *   ① 地址真源在 shared/appLink.js，CSP 的 frame-src 在 index.html ——
 *      两处不一致时 iframe **一片空白**，控制台只有一句 "Refused to frame"，
 *      界面上什么都不显示（连"加载失败"都没有）；
 *   ② shared 下的 CJS 模块没进 vite 的 commonjsOptions.include ⇒ 渲染层 import 到
 *      空对象，左栏那一项连同整页一起消失（"根本没有这个功能"），构建不报错；
 *   ③ 首页导航是 `pickNav` 统一分发的：新增的 `canvas` 若不改判定口径，
 *      会被当成"未知入口"，点下去弹一句「还没有可用的入口」—— 页面照样切了，
 *      但明摆着说自己坏了；
 *   ④ 画布页若套在 `.home-body` 里 ⇒ 带 24px 内边距与滚动条，
 *      网页四周留缝、滚轮被 iframe 吃掉，看着像"滚不动"；
 *   ⑤ 入口若同时挂在剪辑器左栏 ⇒ 两处都能开，但那是两个不同的界面状态；
 *      2026-11-07 Jason 明确要求的是**打开软件时那个窗口**的左栏；
 *   ⑥ 地址栏 / 刷新 / 关闭这些按钮是**明确不要的**（同日），
 *      加回来不会有任何报错，只有看截图才知道。
 *
 * ── 判据一律读消费端 ────────────────────────────────────────────
 * 不信 src 属性（src 写对了但被 CSP 拦掉，它照样是那个值），而是读
 * Playwright 的 `page.frames()` —— 那个 frame 真的存在，才算真加载了。
 * 面板尺寸与 `.home-main` **相对比**：绝对像素换个窗口大小就假红。
 *
 * 依赖外网：源不可达 ⇒ 整段记 SKIP（如实说没验证），可达但加载不出来 ⇒ 红。
 *
 * 用法：node tools/check-app-link.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { reachable } from './net-probe.mjs'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.app-link-${process.pid}`)

const STATIC_CHECKS = 8
const LIVE_CHECKS = 10
const TOTAL_ASSERTIONS = STATIC_CHECKS + LIVE_CHECKS
const WATCHDOG_MS = 5 * 60 * 1000

let failures = 0
let ran = 0
let skipped = 0

function check(name, ok, detail = '') {
  ran += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function skipBlock(reason) {
  skipped = LIVE_CHECKS
  console.log(`  [SKIP] 真机九条没有验（${reason}）—— 跳过的条目不等于验过，网络恢复后请复跑`)
}

function summary() {
  /* 先校账：实跑条数必须等于声明的总数，否则 verify 里那条 expected 就是错的 */
  if (ran + skipped !== TOTAL_ASSERTIONS) {
    failures += 1
    console.log(`  [FAIL] 断言数与实际不符：实跑 ${ran} + 跳过 ${skipped} ≠ 声明 ${TOTAL_ASSERTIONS}`)
  }
  const pass = ran - failures
  console.log(`\n[app-link] ${pass}/${TOTAL_ASSERTIONS} 通过${skipped ? `，跳过 ${skipped}` : ''}`)
  /* fail 直接报 failures，**不要**用 total-pass-skip 反算 ——
     反算会把"断言数与实际不符"抹成 0 失败（本轮就踩了：真跑 18 条、
     total 写的 17，FAILED 那行却报 fail=0）。 */
  console.log(`APP_LINK_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures} skip=${skipped}`)
  if (failures) console.log('APP_LINK_FAILED')
  else console.log('APP_LINK_OK')
  return failures ? 1 : 0
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), ms))
  ])
}

/* 收尾必须有超时兜底：真机窗口偶尔不退（GPU 进程占着），
   裸等 app.close() 会让整道闸门挂到套件的看门狗上（以前挂过 28 分钟）。 */
async function closeApp(app) {
  try {
    await withTimeout(app.close(), 8000, 'app.close')
    return
  } catch {
    const pid = app.process()?.pid
    if (!pid) return
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 已经退了 */
    }
  }
}

/** 静态部分：源码 + CSP + 构建白名单的接线 */
function staticChecks() {
  console.log('\n=== A. 接线（源码与 CSP 必须指向同一个源） ===')
  const shared = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'appLink.js'))
  const link = shared.appLinkOf()
  check(
    '地址真源可用：https + 能解析出 origin',
    Boolean(link && link.url.startsWith('https://') && link.origin.startsWith('https://')),
    link ? `${link.label} → ${link.url}` : 'appLinkOf() 返回 null'
  )

  const html = read('packages/desktop/index.html')
  const csp = (/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(html) || [])[1] || ''
  const frameSrc = (/frame-src([^;]*)/.exec(csp) || [])[1] || ''
  check(
    'CSP 的 frame-src 放行了这个 origin（漏了 ⇒ iframe 一片空白且界面无提示）',
    Boolean(link) && frameSrc.includes(link.origin),
    frameSrc.trim() || '（CSP 里没有 frame-src）'
  )
  check(
    'frame-src 不是通配（白名单精确到源，不是 https:）',
    Boolean(frameSrc) && !/(^|\s)https:(\s|$)/.test(frameSrc),
    frameSrc.trim()
  )

  const vite = read('packages/desktop/vite.config.mjs')
  check(
    'shared/appLink.js 进了 vite 的 commonjs 白名单（漏了 ⇒ 首页这一项整体消失）',
    vite.includes('appLink'),
    vite.includes('appLink') ? 'commonjsOptions.include' : '白名单里没有 appLink'
  )

  /* 首页导航：这一项必须是"首页内部切一屏"，不能被上报给 App 当成未知入口。
     判据落在 `enterEditor` 上 —— 那是 pickNav 唯一的上报条件。 */
  const homeSrc = read('packages/desktop/src/renderer/components/Home.jsx')
  const navBlock = (/const NAV = \[[\s\S]*?\n\]/.exec(homeSrc) || [''])[0]
  const pickBlock = (/const pickNav = \(item\) => \{[\s\S]*?\n  \}/.exec(homeSrc) || [''])[0]
  check(
    '首页左栏 NAV 里有「无线画布」（page: canvas），且 pickNav 按 enterEditor 上报（否则弹「还没有可用的入口」）',
    /key: 'canvas'[\s\S]{0,80}label: '无线画布'/.test(navBlock) &&
      /page: 'canvas'/.test(navBlock) &&
      /* 上报必须**带条件，而且只有一处**：无条件再来一次
         `onNavigate?.(item)` 会让 canvas 落到 App 的"未知入口"分支 ——
         页面照切，但弹一句「还没有可用的入口」（负对照实测过）。
         所以不只要"有 if"，还要数一数调用次数。 */
      /if \(item\.enterEditor\)\s*onNavigate\?\.\(item\)/.test(pickBlock) &&
      (pickBlock.match(/onNavigate\?\.\(item\)/g) || []).length === 1,
    navBlock ? `NAV ${(navBlock.match(/key: '/g) || []).length} 项` : '找不到 NAV'
  )

  const paneSrc = read('packages/desktop/src/renderer/components/WebPane.jsx')
  check(
    'iframe 的 src 来自地址真源（不是写死的网址），且面板里没有任何按钮',
    paneSrc.includes('src={link.url}') && !/https?:\/\/www\./.test(paneSrc) && !paneSrc.includes('<button'),
    paneSrc.includes('<button') ? '又出现按钮了' : 'src={link.url} + 无按钮'
  )

  /* 剪辑器左栏不许再有这一项：那是"打开软件时那个窗口"之外的第二个入口，
     两个入口对应两个不同的界面状态（覆盖播放器 vs 换一屏）。 */
  const treeSrc = read('packages/desktop/src/renderer/components/AssetTree.jsx')
  const appSrc = read('packages/desktop/src/renderer/App.jsx')
  check(
    '剪辑器左栏**没有**第二个入口（AssetTree 不接 links、App 不渲染 WebPane）',
    !treeSrc.includes('data-wb-link') && !treeSrc.includes('onOpenLink') &&
      !appSrc.includes('WebPane') && !appSrc.includes('data-wb-link'),
    `tree=${treeSrc.includes('data-wb-link')} app=${appSrc.includes('WebPane')}`
  )

  /* ⚠️ 先剥注释再匹配：注释里也写着类名，不剥的话删掉真声明照样命中 —— 假绿。
     （2026-11-07 实测过一次：注入"拿掉 grid-row"后静态断言仍然 PASS。） */
  const css = read('packages/desktop/src/renderer/home.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const canvasOk = /\.home-canvas \{[^}]*flex:\s*1/.test(css)
  const webOk = /\.app-web \{[^}]*position:\s*relative[^}]*min-height:\s*0/.test(css)
  check(
    '画布页与网页卡片有真实尺寸（.home-canvas flex:1 / .app-web min-height:0，漏了就是 0 高度白块）',
    canvasOk && webOk,
    `home-canvas=${canvasOk} app-web=${webOk}`
  )
}

/** 真机部分：首页点开 → 真加载 → 切回去 */
async function liveChecks() {
  console.log('\n=== B. 真机（真窗口，无窗模式） ===')
  const app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined, YJAI_NO_WINDOW: '1' }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.waitForSelector('.home', { timeout: 30000 })
    await sleep(700)
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(1920, 1032)
    }).catch(() => {})
    await sleep(400)

    const link = page.locator('[data-home-nav="canvas"]')
    const count = await link.count()
    const text = count ? (await link.first().innerText()).trim() : ''
    check('首页左栏有这一项，文案是「无线画布」', count === 1 && text === '无线画布', `count=${count} 文案="${text}"`)

    /* 可视区：挂着但滚到看不见 = 等于没做 */
    const railBox = await page.locator('.home-rail').boundingBox()
    const linkBox = count ? await link.first().boundingBox() : null
    check('这一项真的在栏的可视区内（没被挤出去）', Boolean(
      railBox && linkBox &&
      linkBox.y >= railBox.y - 1 &&
      linkBox.y + linkBox.height <= railBox.y + railBox.height + 1 &&
      linkBox.height > 30
    ), linkBox ? `项 y=${Math.round(linkBox.y)} h=${Math.round(linkBox.height)}` : '量不到')

    /* 点开 */
    await link.first().click()
    const appeared = await page.locator('[data-home-page="canvas"]').waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
    check('点一下主区换成画布页（创作内容让位）', appeared &&
      (await page.locator('.home-hero-row').count()) === 0,
    appeared ? `hero 还剩 ${await page.locator('.home-hero-row').count()} 个` : '15 秒内没切页')

    /* 尺寸：与 .home-main 相对比，不用绝对像素（换个窗口大小就假红） */
    const mainBox = await page.locator('.home-main').boundingBox()
    const paneBox = appeared ? await page.locator('[data-web-pane="canvas"]').boundingBox() : null
    const fills = Boolean(
      mainBox && paneBox &&
      paneBox.y >= mainBox.y + 40 &&                                  // 在顶栏（56px）之下
      paneBox.y + paneBox.height <= mainBox.y + mainBox.height - 8 && // 底部留白还在
      paneBox.width >= mainBox.width * 0.85 &&                        // 左右各 24px 以内
      paneBox.height > 400
    )
    check('画布页占满主区（顶栏之下、底部留白、宽度 ≥ 主区 85%）', fills,
      paneBox && mainBox
        ? `面板 ${Math.round(paneBox.width)}×${Math.round(paneBox.height)} @y${Math.round(paneBox.y)} / 主区 ${Math.round(mainBox.width)}×${Math.round(mainBox.height)} @y${Math.round(mainBox.y)}`
        : '量不到')

    /* 不要地址栏、不要刷新/关闭 —— 面板里一个 <button> 都不许有 */
    const paneButtons = appeared ? await page.locator('[data-home-page="canvas"] button').count() : -1
    check('画布页里没有任何按钮（刷新 / 在浏览器打开 / 关闭都不要）', paneButtons === 0, `button=${paneButtons}`)

    /* 真加载：读 page.frames()，不是读我们自己的 src */
    let frame = null
    for (let i = 0; i < 80; i += 1) {
      const hit = page.frames().filter((f) => /yjai\.top/.test(f.url()))
      if (hit.length) { frame = hit[0]; break }
      await sleep(500)
    }
    check('子 frame 真的加载了对方站点（不是只有 src 值）', Boolean(frame),
      frame ? frame.url() : '40 秒内没有出现这个 frame')

    const ready = await page.locator('.app-web-frame.is-ready').waitFor({ timeout: 30000 }).then(() => true).catch(() => false)
    check('iframe 的 load 事件真的触发过（遮罩退场）', ready, ready ? 'is-ready' : '30 秒内遮罩没退')

    /* 不许弹「还没有可用的入口」—— pickNav 的判定口径错了就会弹 */
    const toastText = (await page.locator('.toast').allInnerTexts().catch(() => [])).join(' ').trim()
    check('切页没有报错提示（没有「还没有可用的入口」）', !/还没有可用的入口/.test(toastText), toastText || '无提示')

    /* 切回去：点「创作视频」 */
    await page.locator('[data-home-nav="create"]').click()
    await sleep(500)
    const paneGone = await page.locator('[data-web-pane="canvas"]').count()
    const heroBack = await page.locator('.home-hero-row').count()
    check('切回「创作视频」：画布页消失、创作内容回来', paneGone === 0 && heroBack === 1,
      `画布页 ${paneGone} 个 / hero ${heroBack} 个`)

    /* 页面级报错：只收未捕获异常（跨源 iframe 自己的 console 报错不算我们的） */
    check('全程没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '干净')
  } finally {
    await closeApp(app)
    await sleep(300)
    try { process.kill(app.process()?.pid || 0, 'SIGKILL') } catch { /* 已退出 */ }
  }
}

const watchdog = setTimeout(() => {
  console.log(`[app-link] 看门狗触发（${WATCHDOG_MS / 60000} 分钟）`)
  console.log(`APP_LINK_STATS total=${TOTAL_ASSERTIONS} pass=0 fail=1 skip=0`)
  console.log('APP_LINK_FAILED')
  process.exit(1)
}, WATCHDOG_MS)

async function main() {
  staticChecks()

  const shared = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'appLink.js'))
  const link = shared.appLinkOf()
  const up = link ? await reachable(link.url) : false
  if (!up) {
    skipBlock(link ? '目标站此刻不可达' : '地址真源不可用')
    return summary()
  }

  await liveChecks()
  return summary()
}

main()
  .then((code) => {
    clearTimeout(watchdog)
    process.exit(code)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.log(`[app-link] 崩了：${(err && err.stack) || err}`)
    console.log(`APP_LINK_STATS total=${TOTAL_ASSERTIONS} pass=0 fail=1 skip=0`)
    console.log('APP_LINK_FAILED')
    process.exit(1)
  })
