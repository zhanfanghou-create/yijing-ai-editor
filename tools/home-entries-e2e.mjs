/**
 * 首页入口 E2E：证明首页**每一个**入口都通向真实去处，没有一个是占位。
 *
 * 为什么必须单独立一道：首页入口最容易"看起来做好了"——
 * 按钮都在、样式都对、点下去也跳转了，但跳的是一个空壳面板。
 * 这种缺陷不会报错、不会让构建变红，只有真点一遍才发现。
 *
 * 开源版的落点只有两类，且都是本机就有的：
 *   · 进剪辑器型 —— 真的切到工作台，并选中对应的标签 + 左栏节点；
 *   · 本地页型   —— 真的切到「最近草稿」页 / 真的打开设置弹窗。
 *
 * 顺带钉住两件曾经静默坏掉的事：
 *   ① 启动后**不许有账号闸门**（开源版没有账号系统，拦一下就是"软件打不开"）；
 *   ② 工具卡的 `tab` / `node` 必须落在左栏真实存在的节点上
 *      （`nodeOf` 找不到会静默退回根，中栏变"左侧选一个功能开始"）。
 *
 * 断言总数恒为 20（8 骨架 + 7 工具卡 + 5 本地页与收尾）：
 * 找不到 electron 或被中断时，没跑到的逐条补成 SKIP（backfillSkips）。
 *
 * 前置：不需要后端（开源版纯本地，任何联网入口都不存在）。
 * 用法：node tools/home-entries-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
/**
 * 每轮一个**独有**的 profile 目录（带 pid）。
 *
 * 固定目录名的代价实测过两次：上一轮的 Electron 句柄未释放时目录删不掉，
 * 于是本轮会带着上一轮的 `SingletonLock` / `Local State` / localStorage 启动，
 * 表现为"窗口始终没创建"这种完全指不出原因的卡死。一目录一轮彻底排除这个可能。
 */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.home-profile-${process.pid}`)

/** Electron 退出后文件句柄不会立刻释放，删 profile 要重试（Windows 收尾竞态） */
function rmrf(target, { attempts = 8, waitMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      /* 按存在性判定，下面的重试兜底 */
    }
    if (!fs.existsSync(target)) return true
    if (i < attempts - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
    }
  }
  return !fs.existsSync(target)
}

let pass = 0
let fail = 0
let skip = 0
const failures = []

/** 合约：断言总数恒为这个数。中断时靠 backfillSkips 补齐，verify.mjs 里的 expected 才不会误报。 */
const TOTAL_ASSERTIONS = 20
let emitted = 0

function check(label, ok, detail = '') {
  emitted += 1
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

function skipped(label, why) {
  emitted += 1
  skip += 1
  console.log(`  - ${label}  [SKIP] ${why}`)
}

/** 中途出错 / 环境缺失时把没跑到的那几条补成 SKIP，保证总数守恒 */
function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
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

/** 进程还活着吗：ESRCH = 不存在；EPERM = 存在但无权（仍算活着） */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 关掉一个 Electron 实例：先礼后兵。
 * 无边框窗口下 app.close() 偶尔等不到退出（本项目多个脚本都撞过）。
 * 强杀优先用 `process.kill`：沙箱里 `taskkill` 跨进程命名空间杀不掉。
 * 两条都失败也不抛 —— 这是收尾，不该把已经跑完的断言带崩。
 */
async function shutdown(app) {
  if (!app) return
  const pid = app.process()?.pid
  try {
    await withTimeout(app.close(), 8000, 'app.close')
  } catch {
    /* 落到下面的强杀 */
  }
  if (!pid || !alive(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 进程可能已经退了，杀不到不算问题 */
    }
  }
  await sleep(500)
}

/**
 * 全局看门狗：一挂就没有任何可读信息，宁可由这里主动出结论并退出。
 * ⚠️ 两种"挂"分开处理：断言没跑完 → 判失败；只剩收尾 → 那是环境属性，不判失败。
 */
let assertionsDone = false
const WATCHDOG_MS = Number(process.env.HOME_E2E_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完`)
  if (assertionsDone) {
    console.error('    断言已全部跑完，只有收尾没结束 —— 按环境属性处理，不判失败')
    summary()
    return
  }
  while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '看门狗超时，本项未执行')
  check('E2E 未中断地跑完', false, `看门狗 ${Math.round(WATCHDOG_MS / 1000)}s 超时（进程被强杀）`)
  summary()
}, WATCHDOG_MS)

/**
 * 首页七个工具卡 → 工作台的落点（与 Home.jsx 的 TOOLS **独立写死**）。
 * 不从被测代码 import：让它自己出考卷的话，删掉一个入口它也会跟着"通过"。
 */
const TOOLS = [
  { key: 'media', label: '素材库', tab: 'media', node: 'local' },
  { key: 'transition', label: '转场', tab: 'transition', node: 'transition-root' },
  { key: 'filter', label: '滤镜', tab: 'filter', node: 'filter-root' },
  { key: 'effect', label: '特效', tab: 'effect', node: 'effect-root' },
  { key: 'text', label: '文字', tab: 'text', node: 'text-create' },
  { key: 'subtitle', label: '字幕', tab: 'subtitle', node: 'sub-new' },
  { key: 'audio', label: '音频', tab: 'audio', node: 'audio-root' }
]

async function launch() {
  const app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  /* ⚠️ `firstWindow()` **没有超时**（`page.setDefaultTimeout()` 管不到它）。
     主进程起来了却始终不创建窗口时会永久挂住，套上限之后变成一条计数在内、
     指向明确的失败，套件能接着往下跑。45s 远大于本机正常值（3~5s），不会假红。 */
  const page = await withTimeout(app.firstWindow(), 45000, '等待窗口创建')
  page.setDefaultTimeout(15000)
  await page.waitForSelector('.home', { timeout: 30000 })
  return { app, page }
}

/** 回首页：直接 reload 最稳（工作台里没有"回首页"按钮，这是唯一确定的路径） */
async function backHome(page) {
  await page.reload()
  await page.waitForSelector('.home', { timeout: 30000 })
  await sleep(300)
}

/** 进工作台后读"落在哪"：标签 + 左栏选中节点 */
async function landing(page) {
  return page.evaluate(() => ({
    tab: document.querySelector('.wb-tab.active')?.getAttribute('data-wb-tab') || '',
    node: document.querySelector('.wb-tree .wb-node.active')?.getAttribute('data-wb-node') || ''
  }))
}

async function main() {
  console.log('=== 首页入口 E2E（每一个入口都必须通向真实去处）===\n')

  if (!fs.existsSync(EXE)) {
    backfillSkips(`找不到 electron：${EXE}`)
    return
  }

  rmrf(PROFILE)
  let app = null
  let page = null
  const pageErrors = []

  try {
    ;({ app, page } = await launch())
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })

    /* --------------------------- 骨架与启动闸门 --------------------------- */

    console.log('-- 1. 首页骨架（且启动没有账号闸门）--')

    check('1. 启动后直接渲染出首页', (await page.locator('.home').count()) === 1)

    /* 开源版没有账号系统：启动后任何遮罩/弹窗都意味着"软件打不开"。
       等 800ms 是为了让"首帧之后才弹"的那种闸门也来得及出现。 */
    await sleep(800)
    const gateCount = await page.locator('.mask, [role="dialog"], .dialog').count()
    check('2. 启动后没有账号 / 授权弹窗', gateCount === 0, `遮罩·弹窗 ${gateCount} 个`)

    const navCount = await page.locator('.home-nav-item').count()
    check('3. 侧栏导航两项（创作视频 / 最近草稿）', navCount === 2, `${navCount} 项`)

    const heroCount = await page.locator('.home-hero').count()
    check('4. 首页大卡两张', heroCount === 2, `${heroCount} 张`)

    const toolLabels = (await page.locator('.home-tool-label').allTextContents()).map((s) => s.trim())
    const toolsMatch =
      toolLabels.length === TOOLS.length && TOOLS.every((tool, i) => toolLabels[i] === tool.label)
    check(
      `5. 工具卡 ${TOOLS.length} 张且顺序与映射表一致`,
      toolsMatch,
      toolLabels.join('/') || '(空)'
    )

    /* ------------------------------ 两张大卡 ------------------------------ */

    console.log('\n-- 2. 两张大卡 --')

    await page.locator('.home-hero-video').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    check('6.「视频剪辑器」进入剪辑工作台', true, '已切到工作台')

    await backHome(page)
    await page.locator('.home-hero-ai').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(300)
    const stockLanding = await landing(page)
    check(
      '7.「素材库」进工作台并落在「媒体文件 / 素材库」',
      stockLanding.tab === 'media' && stockLanding.node === 'stock',
      JSON.stringify(stockLanding)
    )

    await backHome(page)
    check('8. 重载后仍回到首页（不是卡在工作台）', (await page.locator('.home').count()) === 1)

    /* ------------------------- 七张工具卡逐个点 ------------------------- */

    console.log('\n-- 3. 七张工具卡逐个点（落到真实标签 + 真实节点）--')

    for (const tool of TOOLS) {
      await backHome(page)
      await page.locator(`.home-tool[data-home-tool="${tool.key}"]`).click()
      await page.waitForSelector('.wb-timeline', { timeout: 20000 })
      await sleep(250)
      const at = await landing(page)
      check(
        `9. 工具「${tool.label}」→ ${tool.tab}/${tool.node}`,
        at.tab === tool.tab && at.node === tool.node,
        `实际 ${JSON.stringify(at)}`
      )
    }

    /* ------------------------------ 本地页面 ------------------------------ */

    console.log('\n-- 4. 本地页与设置 --')

    await backHome(page)
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-page', { timeout: 8000 })
    const draftsHead = await page.locator('.home-page h2').first().textContent().catch(() => '')
    check('16. 侧栏「最近草稿」切到草稿页', /最近草稿/.test(String(draftsHead || '')), String(draftsHead || '').trim())

    await page.locator('[data-home-round="settings"]').click()
    await sleep(400)
    const settingsOpened = await page.evaluate(
      () => Boolean(document.querySelector('[role="dialog"], .dialog, .mask'))
    )
    check('17. 首页设置按钮真的打开设置弹窗', settingsOpened)

    await page.keyboard.press('Escape')
    await sleep(300)
    const overlaysLeft = await page.locator('.mask').count()
    check('18. Esc 能关掉设置弹窗（遮罩不残留）', overlaysLeft === 0, `残留 ${overlaysLeft} 个`)

    /* ------------------------------ 无占位 / 无异常 ------------------------------ */

    const allToasts = (await page.locator('.toast').allTextContents()).join(' | ')
    check(
      '19. 全程没有出现占位提示（还没有可用的入口 / 即将上线）',
      !/还没有可用的入口/.test(allToasts) && !/即将上线/.test(allToasts),
      allToasts.trim().slice(0, 120) || '（无）'
    )

    const realErrors = pageErrors.filter((text) => !/Failed to load resource|net::ERR/i.test(text))
    check('20. 全程无页面错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
    // 到这里断言已全部跑完。此后若还卡住，那只会是收尾 —— 看门狗据此不判失败。
    assertionsDone = true
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    // 中断本身占**最后一条**断言：先补齐到 TOTAL-1，再用一条失败断言收尾，
    // 否则总数会变成 TOTAL+1，verify 只会报"断言数不符"，把真因盖掉。
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    /* ⚠️ 顺序是**反直觉但必需**的：先把结论落盘，再收尾。
     * 收尾里某个同步调用一旦堵死主线程，定时器全部停摆；
     * "结论在前"能保证至少结论与通过标记已经在盘上。 */
    emitSummary()
    try {
      await shutdown(app)
      /* 收尾**不删** profile：Electron 关掉之后目录里仍有被它攥着的文件，
         同步 `fs.rmSync` 会永久阻塞而不是抛 EBUSY（实测挂过 10 分半）。
         目录名带 pid、一轮一份，残留不会污染下一轮。 */
      console.log(`  [i] 测试 profile 保留不删（此刻文件仍被占用）：${PROFILE}`)
    } finally {
      clearTimeout(watchdog)
    }
  }
}

let summarized = false
/** 只负责把结论**落盘**（幂等），不负责退出 —— 理由见上面 finally 的注释。 */
function emitSummary() {
  if (summarized) return
  summarized = true
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`HOME_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('HOME_E2E_FAILED')
  } else {
    console.log('HOME_E2E_OK')
  }
}

function summary() {
  emitSummary()
  clearTimeout(watchdog)
  const code = fail ? 1 : 0
  process.exitCode = code
  /* 显式退出是必须的：playwright 的连接与被强杀的子进程留下的管道
     会让事件循环常驻，只设 exitCode 不够。 */
  process.exit(code)
}

main()
  .catch((error) => {
    console.error('[!] 未捕获异常：' + String(error?.stack || error))
    fail += 1
  })
  .finally(summary)
