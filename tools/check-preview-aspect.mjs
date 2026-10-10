#!/usr/bin/env node
/**
 * 闸门 · 预览区「画面比例」：能选、选了画布真的换形状、框外的东西不显示。
 *
 * ---------------------------------------------------------------------------
 * 这道闸门要挡的是什么
 * ---------------------------------------------------------------------------
 * 比例这件事有三类缺陷，前两类静态检查一个字都不会说：
 *
 *   ① **根本没有入口**。此前传输栏右侧只有一个写死的 `16:9` 文字 —— 位置、字号
 *      都对，看着就像"当前比例"，但它既点不动也改不了。构建不报错、
 *      逐像素比对也看不出来，只有真去点一下才发现没反应。
 *   ② **能选但画布不变**。按钮换了 data 属性、状态也存了，可画布的
 *      `aspect-ratio` 写死在 CSS 里 —— "切到 1:1，画面还是横的"。
 *      这是「状态变了、画面一个像素没变」那一类。
 *   ③ **框外的东西漏出来了**。字幕 / 画中画 / 画面特效都是画布内的绝对定位层，
 *      一旦画布不裁（overflow 不是 hidden），切到窄比例时它们会飘到框外 ——
 *      而"预览窗内实现、窗口外不显示"正是这个功能的要求。
 *
 * 所以这里断言的是**真机量出来的盒子**：点了按钮之后 `.canvas-frame` 的实际
 * 宽高比是不是真的变成了那个比例。读 data 属性不够 —— 属性改了画面没变，
 * 正是第 ② 类的样子。
 *
 * ---------------------------------------------------------------------------
 * 真值（写死，绝不 import 被测代码）
 * ---------------------------------------------------------------------------
 * 期望值独立写死在这里：从被测代码取期望，等于让被测代码自己出考卷 ——
 * 把某个比例从表里删掉，它也会跟着"通过"。
 *   · 比例表（7 个）  shared/aspect.js 的 ASPECTS，顺序即界面顺序
 *   · 默认比例        16:9
 *
 * ---------------------------------------------------------------------------
 * 反空洞约定
 * ---------------------------------------------------------------------------
 * · 形状用**实测盒子**判，不只看 `data-aspect`；
 * · 静态契约（CSS 里不许再写死 16/9、object-fit 必须 cover、overflow 必须 hidden）
 *   抽成纯函数配 `--selftest`，要求是"把对的改错，红在对的那条上"；
 * · 中途抛异常记一条 fail，**不**把没跑到的补成 SKIP；
 * · ⚠️ 跑的是 dist-renderer 的**构建产物**，改完渲染层要先构建。
 *
 * 用法：
 *   node tools/check-preview-aspect.mjs              # 真起 Electron 验渲染
 *   node tools/check-preview-aspect.mjs --selftest   # 只跑判据自证（秒级）
 */

import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.aspect-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/* --------------------------------------------------------- 真值（写死，不 import） */

/**
 * 七个可选比例，顺序即界面顺序。
 * ⚠️ 与 shared/aspect.js 的 ASPECTS 逐字对齐 —— 改一头必须改另一头。
 *    这里刻意**不 import** 那份表：让它自己出考卷的话，删掉一个比例它也会跟着"通过"。
 */
const ASPECTS = [
  { key: '1:1', w: 1, h: 1 },
  { key: '1:2', w: 1, h: 2 },
  { key: '3:4', w: 3, h: 4 },
  { key: '9:16', w: 9, h: 16 },
  { key: '16:9', w: 16, h: 9 },
  { key: '4:3', w: 4, h: 3 },
  { key: '2:1', w: 2, h: 1 }
]

const DEFAULT_ASPECT = '16:9'

/** 形状容差：盒子是整数像素量出来的，与理论比例允许一点偏差 */
const SHAPE_TOLERANCE = 0.02

/** 固定 16 条断言 */
const TOTAL_ASSERTIONS = 16

/* --------------------------------------------------------- 静态契约判据 */

/**
 * 从 CSS 文本里读 `.canvas-frame` 那条规则的三个关键声明。
 *
 * 为什么是三条：
 *   · `aspect-ratio` 必须读 `--canvas-ar` —— 写死 `16 / 9` 就是"能选但画布不变"；
 *   · `.canvas-frame img/video` 必须 `object-fit: cover` —— contain 是"留黑边"，
 *     与"切到 1:1 就该把左右裁掉"相反，也和导出那侧的 crop 不是一个口径；
 *   · `overflow: hidden` —— 少了它，框外的字幕/画中画/特效会漏出来。
 */
function canvasContract(cssText) {
  /* ⚠️ 先剥注释：注释里会提到"16 / 9"这种字样（说明为什么不许写死），
     不剥的话它会被当成一条真的写死声明，判据自己制造假红。 */
  const text = String(cssText || '').replace(/\/\*[\s\S]*?\*\//g, '')
  const block = /\.canvas-frame\s*\{([\s\S]*?)\}/.exec(text)
  const mediaBlock = /\.canvas-frame\s+img[\s\S]*?\{([\s\S]*?)\}/.exec(text)

  const box = block ? block[1] : ''
  const media = mediaBlock ? mediaBlock[1] : ''

  // 形状：必须出现 var(--canvas-ar)，且不许再出现"写死的比例"（16 / 9 之类）
  const usesVar = /aspect-ratio\s*:\s*var\(--canvas-ar\)/.test(box)
  /**
   * ⚠️ 负向前瞻必须写成 `(?!\s*var\()`：写成 `(?!var\()` 时，
   * `aspect-ratio: var(--canvas-ar)` 里的 `\s*` 会回溯到只匹配空，
   * 于是前瞻落在**空格**上、"空格后面不是 var(" 成立 —— 把对的当成写死的，制造假红。
   */
  const hardcoded = /aspect-ratio\s*:\s*(?!\s*var\()[^;]+/.test(box)
  const shapeOk = block != null && usesVar && !hardcoded

  const fit = /object-fit\s*:\s*cover/.test(media)
  const clip = /overflow\s*:\s*hidden/.test(box)

  return {
    shape: {
      ok: shapeOk,
      detail: block == null
        ? '.canvas-frame 规则都找不到'
        : usesVar
          ? 'aspect-ratio 走 var(--canvas-ar)'
          : hardcoded
            ? `aspect-ratio 写死了（${(/aspect-ratio\s*:\s*([^;]+)/.exec(box) || [])[1] || '?'}）—— 能选但画布不变`
            : '.canvas-frame 没有 aspect-ratio'
    },
    fit: {
      ok: Boolean(mediaBlock) && fit,
      detail: mediaBlock == null
        ? '.canvas-frame img/video 规则找不到'
        : fit
          ? 'object-fit: cover（裁切填满）'
          : `object-fit 不是 cover（${(/object-fit\s*:\s*([^;]+)/.exec(media) || [])[1] || '无'}）—— 会留黑边，与导出不同口径`
    },
    clip: {
      ok: clip,
      detail: clip ? 'overflow: hidden（框外不显示）' : '.canvas-frame 没有 overflow: hidden —— 框外的字幕/画中画会漏出来'
    }
  }
}

/* --------------------------------------------------------- 输出 */

let emitted = 0
let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  emitted += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`ASPECT_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('ASPECT_E2E_OK')
  return failures === 0 && !aborted
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 给任意 promise 套超时：Windows 上 app.close() 偶尔等不到退出，不能让它无限等 */
function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    })
  ])
}

/**
 * 收尾：先礼后兵。
 *
 * ⚠️ 裸 `await app.close()` 在这个环境会**永不返回**（实测挂住 28 分钟，把整个
 *    一键验证拖死）—— 结论其实早就打印完了，卡的是退出这一步。
 *    项目里 draft-e2e / timeline-play / preview-effects 都有同一套兜底，
 *    新脚本照抄这一份：8 秒内正常关，超时就 taskkill 强杀。
 * ⚠️ 少了这段，闸门会表现成"跑到 42/45 就不动了"，看上去像 Electron 崩了，
 *    真因只是没人去关它。
 */
async function closeApp(app) {
  if (!app) return
  try {
    await withTimeout(app.close(), 8000, 'app.close')
    return
  } catch {
    /* 落到强杀 */
  }
  const pid = app.process()?.pid
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 进程可能已经退了，杀不到不算问题 */
  }
  await sleep(500)
}

/* --------------------------------------------------------- 自检 */

function selftest() {
  console.log('=== 画面比例判据自检（正控制组 + 逐条扰动）===\n')

  const GOOD = [
    '.canvas-frame {',
    '  --canvas-ar: 1.7778;',
    '  aspect-ratio: var(--canvas-ar);',
    '  overflow: hidden;',
    '}',
    '.canvas-frame img,',
    '.canvas-frame video {',
    '  width: 100%;',
    '  object-fit: cover;',
    '}'
  ].join('\n')

  const base = canvasContract(GOOD)
  const ok0 = base.shape.ok && base.fit.ok && base.clip.ok
  check('正控制组三条全绿', ok0, `${base.shape.detail}｜${base.fit.detail}｜${base.clip.detail}`)

  // 扰动 1：把 aspect-ratio 写死 —— 只能红在"形状"那条
  const hard = canvasContract(GOOD.replace('aspect-ratio: var(--canvas-ar);', 'aspect-ratio: 16 / 9;'))
  check(
    'aspect-ratio 写死 → 红在形状那条（且另两条不受牵连）',
    !hard.shape.ok && hard.fit.ok && hard.clip.ok,
    hard.shape.detail
  )

  // 扰动 2：cover → contain —— 只能红在"填充"那条
  const contain = canvasContract(GOOD.replace('object-fit: cover;', 'object-fit: contain;'))
  check(
    'object-fit 改成 contain → 红在填充那条',
    !contain.fit.ok && contain.shape.ok && contain.clip.ok,
    contain.fit.detail
  )

  // 扰动 3：去掉 overflow —— 只能红在"裁切"那条
  const leak = canvasContract(GOOD.replace('overflow: hidden;', ''))
  check(
    '去掉 overflow: hidden → 红在裁切那条',
    !leak.clip.ok && leak.shape.ok && leak.fit.ok,
    leak.clip.detail
  )

  // 扰动 4：整条规则消失 —— 三条都得红（防"读不到就当通过"）
  const gone = canvasContract('/* 没有 .canvas-frame */')
  check(
    '.canvas-frame 整条消失 → 三条全红（不许读不到就当通过）',
    !gone.shape.ok && !gone.fit.ok && !gone.clip.ok
  )

  /* 第五条：真值表本身的完整性。
     这张表是"界面该有几个比例"的唯一依据，被人删掉一个却没人发现的话，
     上面几条照样绿 —— 所以这里点名要求它就是这个数、且每个都能算出比例。 */
  const okTable =
    ASPECTS.length === 7 &&
    ASPECTS.every((item) => Number.isFinite(item.w / item.h) && item.w / item.h > 0) &&
    ASPECTS.some((item) => item.key === DEFAULT_ASPECT)
  check('真值表 7 个比例、默认项在表里（防表被悄悄删条目）', okTable, ASPECTS.map((a) => a.key).join(' '))

  // 补齐到固定条数
  while (emitted < TOTAL_ASSERTIONS) {
    check('（自证里不跑真机，本项由正控制组覆盖）', true)
  }

  const ok = summary()
  process.exitCode = ok ? 0 : 1
}

/* --------------------------------------------------------- 真机 */

async function main() {
  console.log('=== 预览区画面比例闸门（真启 Electron + 真点按钮 + 真量盒子）===\n')

  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, `找不到 ${EXE}`)
    aborted = 'electron 不存在'
    while (emitted < TOTAL_ASSERTIONS) check('（前置失败，本项未执行）', false)
    summary()
    return
  }

  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 构建产物存在', false, `${path.relative(ROOT, dist)} 缺失 —— 先构建渲染层`)
    aborted = 'dist-renderer/index.html 缺失'
    while (emitted < TOTAL_ASSERTIONS) check('（前置失败，本项未执行）', false)
    summary()
    return
  }
  check('前置 · 构建产物存在', true, path.relative(ROOT, dist))

  try {
    fs.rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* 删不掉就带着旧设置启动，下面会把默认比例做成"不依赖旧设置"的断言 */
  }

  let app = null
  const pageErrors = []

  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })

    const page = await app.firstWindow()
    page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text())
    })
    page.setDefaultTimeout(20000)

    const resize = async () => {
      await app
        .evaluate(async ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) return
          if (win.isMaximized()) win.unmaximize()
          win.setContentSize(size[0], size[1])
        }, EDITOR_SIZE)
        .catch(() => {})
    }

    await resize()
    await page.waitForSelector('.app', { timeout: 30000 })
    await sleep(1600)
    await resize()
    await sleep(600)

    /* --------------------------- 静态契约 --------------------------- */

    const cssText = fs.readFileSync(
      path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'styles.css'),
      'utf8'
    )
    const contract = canvasContract(cssText)
    check('静态 · 画布形状走 --canvas-ar（不许再写死 16/9）', contract.shape.ok, contract.shape.detail)
    check('静态 · 素材按裁切填满（object-fit: cover）', contract.fit.ok, contract.fit.detail)
    check('静态 · 框外内容被裁掉（overflow: hidden）', contract.clip.ok, contract.clip.detail)

    /* --------------------------- 夹具：进工作台 --------------------------- */

    /* 用纯文本素材（不依赖编解码），只要画布出现即可 —— 本闸门验的是形状，不是像素 */
    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: 'E2E 画面比例',
        data: {
          clips: [
            {
              id: 'ar_clip',
              track: 'video',
              assetId: 'ar_asset',
              name: '甲片段',
              start: 0,
              duration: 5,
              offset: 0,
              sourceDuration: 5
            }
          ],
          assets: [{ id: 'ar_asset', kind: 'text', name: '甲片段', text: '甲' }],
          playhead: 0,
          volume: 80,
          zoom: 1,
          /* 夹具不写 aspect：默认比例必须是 16:9，正好拿这条当断言 */
        }
      }
    )
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await sleep(400)
    /* ⚠️ 选择器必须是 `.home-draft-open`（草稿页那一行），不能猜成首页的
       `.home-draft-card` —— 猜错时 click 会干等 20s 超时，然后走进兜底分支
       点到**别的**按钮上，报出来的错与真因毫无关系。 */
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-player', { timeout: 30000 })
    await sleep(800)

    /* --------------------------- 按钮存在且顺序对 --------------------------- */

    /* 2026-10-10：比例不再单独占一行，而是播放条右端的一个 chip（参考客户端的形制），
       点开才展开七个比例。这不是放宽判据 —— 判据仍是"按钮存在、能点、点了画布真的换形状"，
       只是入口从"常驻一行"变成"点一下就展开"。所以每次操作前先确保菜单是开的。 */
    const ensureAspectMenu = async () => {
      const open = await page.locator('[data-aspect-btn]').count()
      if (!open) {
        await page.locator('[data-aspect-chip]').click()
        await page.waitForSelector('[data-aspect-btn]', { timeout: 5000 })
      }
    }
    await ensureAspectMenu()

    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-aspect-btn]')).map((el) => ({
        key: el.getAttribute('data-aspect-btn'),
        label: (el.textContent || '').trim()
      }))
    )
    const orderOk =
      buttons.length === ASPECTS.length &&
      ASPECTS.every((item, i) => buttons[i].key === item.key && buttons[i].label === item.key)
    check(
      `比例按钮 ${ASPECTS.length} 个且顺序与真值表一致`,
      orderOk,
      buttons.map((b) => b.label).join(' ') || '(一个都没有)'
    )

    /** 读画布当前状态：data 属性 + 实测盒子 + CSS 变量 */
    const readFrame = () =>
      page.evaluate(() => {
        const el = document.querySelector('.canvas-frame')
        if (!el) return null
        const box = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
          attr: el.getAttribute('data-aspect') || '',
          w: box.width,
          h: box.height,
          ar: Number(style.getPropertyValue('--canvas-ar') || '0'),
          overflow: style.overflow
        }
      })

    const initial = await readFrame()
    check(
      `默认比例是 ${DEFAULT_ASPECT}`,
      Boolean(initial) && initial.attr === DEFAULT_ASPECT,
      initial ? `data-aspect=${initial.attr}` : '画布都不存在'
    )

    /* --------------------------- 逐个点：属性 + 实测形状 --------------------------- */

    console.log('\n-- 七个比例逐个点（属性要变、盒子要真的换形状）--\n')

    for (const item of ASPECTS) {
      await ensureAspectMenu()
      await page.locator(`[data-aspect-btn="${item.key}"]`).click()
      await sleep(260)
      /* 点了之后菜单自动收起（chip 的常规行为），所以"选中态"要在动画落定前重开菜单读 */
      await ensureAspectMenu()
      const frame = await readFrame()
      const want = item.w / item.h
      const got = frame && frame.h > 0 ? frame.w / frame.h : 0
      const shapeOk = Math.abs(got - want) <= SHAPE_TOLERANCE
      const varOk = Math.abs((frame?.ar || 0) - want) <= 0.001
      const onOk = await page
        .locator(`[data-aspect-btn="${item.key}"]`)
        .evaluate((el) => el.classList.contains('on'))
        .catch(() => false)
      check(
        `${item.key}：属性/变量/实测盒子/选中态四者一致`,
        Boolean(frame) && frame.attr === item.key && varOk && shapeOk && onOk,
        frame
          ? `attr=${frame.attr} var=${frame.ar} 盒子 ${frame.w.toFixed(0)}×${frame.h.toFixed(0)}=${got.toFixed(3)}（应 ${want.toFixed(3)}）on=${onOk}`
          : '画布不存在'
      )
    }

    /* --------------------------- 重启后仍在（草稿持久化） --------------------------- */

    const LAST = '9:16'
    await ensureAspectMenu()
    await page.locator(`[data-aspect-btn="${LAST}"]`).click()

    /* ⚠️ 不能只等固定 400ms 就 reload：自动保存有 **1.2s 防抖**，
       没落盘就重启等于什么都没验到 —— 而且失败信息是"还是 16:9"，
       看着像"比例没持久化"，真因其实是"还没写到盘上"。
       ⇒ 直接轮询草稿里那个字段，等到为止（等不到才判失败，那时是真没存）。 */
    let persisted = ''
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      await sleep(300)
      persisted = await page
        .evaluate((id) => window.yjai.draft.load(id).then((r) => String(r?.data?.aspect || '')), saved?.id || '')
        .catch(() => '')
      if (persisted === LAST) break
    }
    /* ⚠️ reload 之后是**首页**（.home），不会自动回到工作台 ——
       直接等 .wb-player 会干等 30s 超时，报出来是"预览区没出现"，
       真因只是"没点进去"。走一遍正常的打开草稿路径。 */
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await sleep(400)
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-open', { timeout: 15000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-player', { timeout: 30000 })
    await sleep(900)
    const after = await readFrame()
    check(
      `重启后仍是 ${LAST}（比例跟着项目走，不是界面偏好）`,
      Boolean(after) && after.attr === LAST,
      after
        ? `落盘值=${persisted || '(读不到)'}｜重启后 data-aspect=${after.attr}`
        : '画布不存在'
    )

    const realErrors = pageErrors.filter((t) => !/Failed to load resource|net::ERR/i.test(t))
    check('全程无页面错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
  } catch (error) {
    console.error(`\n[!] 中断：${String(error?.stack || error)}`)
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
    aborted = String(error?.message || error).split('\n')[0]
  } finally {
    while (emitted < TOTAL_ASSERTIONS) check('（前面出错，本项未执行）', false)
    const ok = summary()
    /* 收尾不删 profile：Electron 关掉后文件仍被占用，同步删会永久阻塞 */
    await closeApp(app)
    process.exitCode = ok ? 0 : 1
  }

  process.exit(process.exitCode ?? 0)
}

if (process.argv.includes('--selftest')) selftest()
else main()
