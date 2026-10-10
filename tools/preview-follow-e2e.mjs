/**
 * 预览区跟随播放头 E2E：真启 Electron、真按键、真读 DOM。
 *
 * 为什么必须单独一道闸门：这段逻辑的**纯算术部分**已经有夹具了
 * （tools/trim-selftest.mjs 的 `sourceTimeAt` 段），但纯算术证不了**接线** ——
 * 就算 sourceTimeAt 全对，App 只要仍然把 `playhead` 当源时间传下去、
 * 或者仍然按 `selection.clipId` 选素材，闸门照样全绿。而这一层的缺陷表现是：
 *   1. 选中 A 播放，播放头走到 B 上，画面还是 A；
 *   2. 片段被拖到时间线别处（start≠0）或被剪过左端（offset≠0）后，
 *      预览显示的是**源文件里另一处**的画面 —— 界面上完全看不出异常，
 *      只有把预览和成片逐帧对看才能发现。
 * 所以这里断言的是 DOM 上的两个事实：预览显示的是**哪个素材**、以及
 * `.wb-player[data-source-time]` 这个数（由 App 计算、Stage 只负责画出来）。
 *
 * 为什么不读 `<video>.currentTime`：那个值会被 seek / play 的异步时序影响
 * （metadata 没到位时是 0，seek 是异步生效的），拿它做断言必然 flaky。
 * 所以 Stage 把算好的源时间挂成 `data-source-time` 属性，断言这个稳定值。
 *
 * 为什么素材都用 `kind: 'text'`：文本素材的预览是**纯 DOM**（渲染成
 * `.canvas-placeholder > strong` 显示素材名），不依赖编解码、不依赖文件、
 * 不依赖媒体加载时序，所以断言是稳态的。本闸门要验的是"选哪个素材 + 跳到源文件第几秒"，
 * 不是媒体解码。
 *
 * 断言总数恒为 18：找不到 electron、看门狗超时或中途出错时，没跑到的断言逐条补成
 * SKIP（backfillSkips）而不是少跑 —— 少跑会让 verify.mjs 只报"断言数不符"，看不出真因。
 *
 * 用法：node tools/preview-follow-e2e.mjs
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
 * profile 目录必须**按 pid 唯一**：固定目录名在前一轮异常退出时删不掉，
 * 下一轮就会带着上一轮的自定义设置启动，把"应该是默认值"的断言变成莫名其妙的假红。
 */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.preview-profile-${process.pid}`)

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
const TOTAL_ASSERTIONS = 18
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

/** 中断时把没跑到的那几条补成 SKIP，保证总数守恒（见文件头说明） */
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

/**
 * 关掉 Electron 实例：先礼后兵。超时后按 pid 强杀进程树 —— 这里**不把超时判成失败**，
 * 它是环境属性，不是被测逻辑的问题（本项目多个脚本都撞过无边框窗口关不干净）。
 */
async function shutdown(app) {
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

/**
 * 全局看门狗。verify.mjs 用 spawnSync 跑闸门且没传 timeout，这里一挂整个套件就永久卡死，
 * 且不产出任何可读信息 —— 所以宁可由这里主动判失败并退出。
 */
const WATCHDOG_MS = Number(process.env.PREVIEW_E2E_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

/**
 * 夹具时间线（秒）。四个片段的 start / offset **刻意都不相等**，
 * 这样"把 playhead 当源时间"和"忘了减 start"两类写法都会当场红。
 *
 *   lane  素材      时间线区间     源入点
 *   视频  甲片段    [ 0.0,  5.0)   30
 *   视频  乙片段    [ 5.0, 10.0)   50
 *   字幕  字幕丁    [ 6.0,  8.0)   80   ← 故意与乙重叠，用来验轨道优先级
 *   字幕  字幕片段  [10.5, 12.5)   70   ← 6.0~10.5 之间空着，用来验"间隙退回选中"
 *
 * 期望的源时间一律按 `offset + (t - start)` 手算，不从被测代码里取。
 */
const ASSETS = [
  { id: 'asset_a', kind: 'text', name: '甲片段', text: '甲' },
  { id: 'asset_b', kind: 'text', name: '乙片段', text: '乙' },
  { id: 'asset_c', kind: 'text', name: '字幕片段', text: '丙' },
  { id: 'asset_d', kind: 'text', name: '字幕丁', text: '丁' }
]

const CLIPS = [
  { id: 'clip_a', track: 'video', assetId: 'asset_a', name: '甲片段', start: 0, duration: 5, offset: 30, sourceDuration: 60 },
  { id: 'clip_b', track: 'video', assetId: 'asset_b', name: '乙片段', start: 5, duration: 5, offset: 50, sourceDuration: 60 },
  { id: 'clip_d', track: 'text', assetId: 'asset_d', name: '字幕丁', start: 6, duration: 2, offset: 80, sourceDuration: 90 },
  { id: 'clip_c', track: 'text', assetId: 'asset_c', name: '字幕片段', start: 10.5, duration: 2, offset: 70, sourceDuration: 90 }
]

/** 全局快捷键右箭头 = 后一帧，帧率 30 ⇒ N 次按键 = N/30 秒（stepFrame 会吸附到帧网格） */
const FPS = 30

async function launch() {
  const app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForSelector('.home', { timeout: 30000 })
  return { app, page }
}

/** 预览区当前显示的素材名（文本素材渲染成 .canvas-placeholder > strong） */
async function previewName(page) {
  const text = await page
    .locator('.wb-player .canvas-placeholder strong')
    .first()
    .textContent()
    .catch(() => '')
  return String(text || '').trim()
}

/** 源时间属性（App 算好、Stage 挂上来的那个数） */
async function previewSourceTime(page) {
  const value = await page.locator('.wb-player').first().getAttribute('data-source-time').catch(() => null)
  return value === null ? '<缺失>' : String(value)
}

/** 逐帧步进：靠真按键，不靠改状态 —— 这样连"按键派发"一起验了 */
async function stepFrames(page, times) {
  for (let i = 0; i < times; i += 1) await page.keyboard.press('ArrowRight')
}

/** 前进 1 秒（Shift+Right）。注意它不走帧网格吸附，所以要和帧步进配合使用 */
async function stepSeconds(page, times) {
  for (let i = 0; i < times; i += 1) await page.keyboard.press('Shift+ArrowRight')
}

async function main() {
  console.log('=== 预览区跟随播放头 E2E（真实 Electron + 真实按键）===\n')

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

    /* --------------------------- 准备：夹具草稿 --------------------------- */

    const info = await page.evaluate(() => window.yjai.info())
    check('1. 拿到 userData 目录', Boolean(info?.userData), info?.userData)

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: 'E2E 预览跟随',
        data: { clips: CLIPS, assets: ASSETS, playhead: 0, volume: 80, zoom: 1 }
      }
    )
    check('2. 夹具草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    // 从首页草稿列表打开草稿：这条路径同时会把 draftId 记进设置（重启后自动恢复靠它）。
    // 刷新一次是必须的 —— 首页的「最近草稿」是挂载时拉的，刚写完的草稿要重进才看得见。
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(400)

    const clipCount = await page.locator('.clip[data-clip]').count()
    check('3. 打开草稿后时间线出现 4 个片段', clipCount === 4, `${clipCount} 个`)

    // 选中乙片段（播放头在 3 秒处时，它**不是**应该显示的那个）
    await page.locator('.clip[data-clip="clip_b"]').click()
    await sleep(150)
    const classes = String((await page.locator('.clip[data-clip="clip_b"]').getAttribute('class')) || '')
    check('4. 乙片段处于选中态（后续断言靠它区分"选中"与"播放头"）', classes.includes('selected'), classes)

    /**
     * 把播放头精确送回 0。
     *
     * ⚠️ 这一步是 2026-09-22 补的，因为"单击片段"的语义变了：
     * 现在单击片段会**把播放头挪到点击处**（用户口径的"时间线点击移动播放头"，
     * 也是主流剪辑软件的通用行为）。所以上面那次 `.click()` 顺手把播放头
     * 带到了片段中心的 7.5s —— 而本用例的前提是"选中的乙片段与播放头错开"。
     *
     * 用 `Home`（toStart）而不是点刻度尺复位：本文件下面 7 条断言要求播放头
     * **精确**在 0（接着 90 次逐帧步进要正好落在第 90 帧、源时间要正好 33.000），
     * 而"点第 0 秒刻度"最多只能点到 0.01s 量级，会把这 7 条变成假红。
     */
    await page.keyboard.press('Home')
    await sleep(200)

    const hasFrame = await page.locator('.wb-player .canvas-frame').count()
    check('5. 预览区画布已出现', hasFrame === 1, `canvas-frame ${hasFrame} 个`)

    /* ------------------- A. 播放头在 3.0：显示的必须是甲，不是选中的乙 ------------------- */

    await stepFrames(page, 90)
    await sleep(150)
    // 2026-10-08 起播放条改为参考客户端那种帧号时码 HH:MM:SS:FF（原来是 00:00:03.0 + 单独一个「90f」角标）。
    // 判据不但没放宽，反而更硬：必须同时读对「秒」和「帧」两段，写成 00:00:02:29 或 00:00:03:01 都算红。
    const frameText = String((await page.locator('.wb-player .wb-time b').first().textContent()) || '').trim()
    check('6. 按 90 次「后一帧」后播放头落在第 90 帧', frameText === '00:00:03:00', frameText)

    const nameAt3 = await previewName(page)
    check(
      '7. 播放头 3.0s → 预览显示播放头所在的甲片段（不是选中的乙片段）',
      nameAt3 === '甲片段',
      `显示「${nameAt3}」（选中是「乙片段」）`
    )

    const timeAt3 = await previewSourceTime(page)
    check(
      '8. 播放头 3.0s → 源时间是 30+3=33.000（不是播放头本身 3.000）',
      timeAt3 === '33.000',
      timeAt3
    )

    /* ------------------- B. 接缝 5.0：区间必须左闭右开 ------------------- */

    await stepFrames(page, 60)
    await sleep(150)
    const nameAt5 = await previewName(page)
    check(
      '9. 接缝 5.0s → 归后一个片段（左闭右开；闭区间会仍然停在甲）',
      nameAt5 === '乙片段',
      `显示「${nameAt5}」`
    )
    const timeAt5 = await previewSourceTime(page)
    check('10. 接缝 5.0s → 源时间是 50+0=50.000', timeAt5 === '50.000', timeAt5)

    /* ------------------- C. 7.0：视频轨压过重叠的字幕轨 ------------------- */

    await stepFrames(page, 60)
    await sleep(150)
    const nameAt7 = await previewName(page)
    check(
      '11. 7.0s → 视频轨优先（此时字幕丁也在 6~8 区间内）',
      nameAt7 === '乙片段',
      `显示「${nameAt7}」`
    )
    const timeAt7 = await previewSourceTime(page)
    check('12. 7.0s → 源时间是 50+2=52.000', timeAt7 === '52.000', timeAt7)

    /* ------------------- D. 10.0：空白处退回选中片段，且夹到末帧 ------------------- */

    await stepSeconds(page, 3)
    await sleep(150)
    const nameAt10 = await previewName(page)
    check(
      '13. 10.0s（片段之间的空白）→ 退回选中的乙片段而不是空着',
      nameAt10 === '乙片段',
      `显示「${nameAt10}」`
    )
    const timeAt10 = await previewSourceTime(page)
    check(
      '14. 10.0s 空白处 → 源时间夹到选中片段末帧 50+5=55.000（不越界）',
      timeAt10 === '55.000',
      timeAt10
    )

    /* ------------------- E. 11.0：只剩字幕轨时显示字幕 ------------------- */

    // 从 10.0 用「前进 1 秒」到 11.0 —— 落在字幕片段内部 0.5 秒处。
    // 这里刻意不用逐帧步进：15 帧正好落在 10.5（片段**起点**），那时源时间恰好等于
    // 入点 70，区分不出"映射对"和"永远返回入点"。取片段内部才能把映射真正验出来。
    await stepSeconds(page, 1)
    await sleep(150)
    const nameAt105 = await previewName(page)
    check('15. 11.0s → 该处只有字幕片段，显示字幕片段', nameAt105 === '字幕片段', `显示「${nameAt105}」`)
    const timeAt105 = await previewSourceTime(page)
    check('16. 11.0s → 源时间是 70+(11-10.5)=70.500', timeAt105 === '70.500', timeAt105)

    /* ------------------- F. End：跳到结尾后仍按选中片段夹到末帧 ------------------- */

    await page.keyboard.press('End')
    await sleep(150)
    const timeAtEnd = await previewSourceTime(page)
    check(
      '17. 跳到结尾后源时间仍是选中片段的末帧 55.000（夹取与选中兜底都还在）',
      timeAtEnd === '55.000',
      timeAtEnd
    )

    const realErrors = pageErrors.filter((text) => !/Failed to load resource|net::ERR|403|401/i.test(text))
    check('18. 全程无页面错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    // 中断本身占**最后一条**断言：先补齐到 TOTAL-1，再用一条失败断言收尾。
    // 直接 fail += 1 不占位的话总数会变成 TOTAL+1，verify 里的 expected 就对不上了，
    // 而"断言数不符"这种报法会把真因（是这里中断了）盖掉。
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    clearTimeout(watchdog)
    await shutdown(app)
    app = null
    /* ⚠️ 收尾**不再**删 profile 目录，这是刻意的取舍 —— 完整实录（同步版堵死主线程、
     * 异步版 8 秒也删不净）见 `tools/home-entries-e2e.mjs` 收尾处的注释，同一根因：
     * Electron 关掉之后目录里仍有它攥着的文件，删除会**一直不返回**；
     * 那一步既危险又没用（目录名带 pid、每轮独占，残留它不影响下一轮）。
     * 启动阶段那次 `rmrf(PROFILE)` 保留：那时还没有任何进程持句柄。 */
    console.log(`\n测试用 Electron profile 保留不删（此刻文件仍被占用，删它会卡死主线程）：${PROFILE}`)
  }
}

function summary() {
  clearTimeout(watchdog)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`PREVIEW_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('PREVIEW_E2E_FAILED')
  } else {
    console.log('PREVIEW_E2E_OK')
  }

  const code = fail ? 1 : 0
  process.exitCode = code
  // 必须显式退出：playwright 的连接、以及被强杀的子进程留下的管道，会让事件循环常驻。
  // 只设 exitCode 不够 —— 实测断言全绿、PREVIEW_E2E_OK 也打出来了，进程却一直不退，
  // 于是 verify.mjs 的 spawnSync 照样永久等待（"绿了但卡住"这种最隐蔽的形态）。
  // 先等 stdout 排空再退，避免管道里丢掉 PREVIEW_E2E_OK 这个通过标记。
  process.stdout.write('', () => process.exit(code))
  setTimeout(() => process.exit(code), 1000).unref()
}

main()
  .catch((error) => {
    console.error('[!] 未捕获异常：' + String(error?.stack || error))
    fail += 1
  })
  .finally(summary)
