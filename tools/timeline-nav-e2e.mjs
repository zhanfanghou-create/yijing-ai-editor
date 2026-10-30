/**
 * 时间线导航 E2E：真启 Electron + 真按键，验「切点跳转 / 适配全片 / Alt+滚轮横移」。
 *
 * 为什么纯逻辑自测（tools/timeline-nav-selftest.mjs）之外还要这一道：
 * 自测只能证明 `stepCut` / `fitZoom` 算得对，证明不了下面四件只在真机成立的事 ——
 *   1. **键真的接上了**：`prevCut`/`nextCut`/`zoomFit` 在 ACTIONS 里、在派发表里、
 *      而且按下去改的是**播放头**而不是别的状态（"接错到别的动作"是静默失效的一类）；
 *   2. **播放头真的动了**：判据读的是那根线的 `data-playhead`（用户看到的位置），
 *      不是 React state —— state 变了而线没动，截图才看得出来；
 *   3. **适配真的把内容装进了视口**：判据读 `getBoundingClientRect()`，
 *      不是读 slider 的 value。算出来的缩放写进了 state、但样式没跟上（或者反过来）
 *      都只表现为"按了没反应"；
 *   4. **Alt+滚轮真的横向滚**：wheel 监听是原生挂的，React 的 onWheel 拦不住
 *      preventDefault，这里派发真实 WheelEvent 看 scrollLeft。
 *
 * 断言总数恒为 13：找不到 electron / 中途出错时逐条补 SKIP（不是少跑）。
 * 用法：node tools/timeline-nav-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
/** profile 按 pid 唯一：固定目录名在前一轮异常退出时删不掉，会带着上一轮状态启动 */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.timeline-nav-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 16
let emitted = 0
let pass = 0
let fail = 0
let skip = 0
const failures = []

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

function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    /* 由调用方按存在性判断，不影响结论 */
  }
  return !fs.existsSync(target)
}

/**
 * 夹具：三段首尾相接的影片（0~5 / 5~10 / 10~15）。
 * 切点因此是 **5 / 10 / 15**（0 不算切点，起点用 Home 回）。
 * 三段刻意都放 video 轨且不重叠 —— 导航只关心时间点，与轨数无关。
 */
function makeClips() {
  return [0, 5, 10].map((start, i) => ({
    id: `clip_nav_${i}`,
    track: 'video',
    assetId: `asset_nav_${i}`,
    name: `导航片段 ${i + 1}`,
    text: '',
    start,
    duration: 5
  }))
}

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

async function shutdown(app) {
  if (!app) return
  try {
    await Promise.race([app.close(), sleep(8000)])
  } catch {
    /* 落到强杀由外层负责 */
  }
}

/** 播放头那根线的秒数（判据读消费端：DOM 上的 data-playhead） */
function playheadOf(page) {
  return page.evaluate(() => {
    const line = document.querySelector('.playhead')
    return line ? Number(line.getAttribute('data-playhead')) : NaN
  })
}

/** 滑块当前值 */
function zoomOf(page) {
  return page.evaluate(() => Number(document.querySelector('[data-tl-zoom]').value))
}

/**
 * 时间线的实际布局：内容右边界 vs 视口右边界。
 * 判据全部读 `getBoundingClientRect()` —— 「装进视口」这件事只存在于布局里，
 * state 里的 zoom 是 0.42 还是 4 都不能说明内容有没有露在外面。
 */
function layoutOf(page) {
  return page.evaluate(() => {
    const lane = document.querySelector('[data-tracks]')
    if (!lane) return null
    const clips = [...document.querySelectorAll('.clip[data-clip]')]
    const rect = lane.getBoundingClientRect()
    return {
      clientWidth: lane.clientWidth,
      scrollWidth: lane.scrollWidth,
      scrollLeft: lane.scrollLeft,
      laneRight: rect.right,
      clipRight: clips.length ? Math.max(...clips.map((c) => c.getBoundingClientRect().right)) : 0
    }
  })
}

let watchdog = null

async function main() {
  console.log('=== 时间线导航 E2E（真实 Electron + 真实按键）===\n')

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

    check('1. 首屏是创作中心', Boolean(await page.$('.home')))

    /* -------------------- 准备一段有三段片段的时间线 -------------------- */
    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: '导航 E2E', data: { clips: makeClips(), assets: [], playhead: 0, volume: 100, zoom: 1 } }
    )
    // 首页的「最近草稿」是保存后重进首页才刷新的（与 draft-e2e 同一现象）
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await sleep(400)
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(400)

    const clipCount = await page.locator('.clip[data-clip]').count()
    check('2. 打开草稿后时间线有三段片段', clipCount === 3, `${clipCount} 段`)

    /* ------------------------- A. 切点跳转 ↑ / ↓ ------------------------- */

    const startAt = await playheadOf(page)
    check('3. 初始播放头在 0 秒', startAt === 0, `playhead=${startAt}`)

    await page.keyboard.press('ArrowDown')
    await sleep(200)
    const cut1 = await playheadOf(page)
    check('4. 按 ↓ 跳到第一个切点 5 秒', cut1 === 5, `playhead=${cut1}`)

    await page.keyboard.press('ArrowDown')
    await sleep(200)
    const cut2 = await playheadOf(page)
    check('5. 再按 ↓ 跳到第二个切点 10 秒（不在 5 上原地打转）', cut2 === 10, `playhead=${cut2}`)

    await page.keyboard.press('ArrowUp')
    await sleep(200)
    const back = await playheadOf(page)
    check('6. 按 ↑ 回到上一个切点 5 秒', back === 5, `playhead=${back}`)

    // 到头：Home 回 0 之后再按 ↑ 应当原地不动（不是偷偷跳到最后一段）
    await page.keyboard.press('Home')
    await sleep(150)
    await page.keyboard.press('ArrowUp')
    await sleep(200)
    const atHead = await playheadOf(page)
    check('7. 已在开头时按 ↑ 停在 0（不跳走）', atHead === 0, `playhead=${atHead}`)

    /* ------------------------- B. 适配全片 Shift+Z ------------------------- */

    // 先放大到内容比视口宽，这样"适配"才有可验证的效果（否则本来就看全了）
    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Control+=')
    await sleep(300)
    const beforeFit = await layoutOf(page)
    check(
      '8. 放大后内容比视口宽（先造出"看不全"的状态）',
      Boolean(beforeFit) && beforeFit.scrollWidth > beforeFit.clientWidth + 40,
      `scrollWidth=${beforeFit?.scrollWidth} clientWidth=${beforeFit?.clientWidth}`
    )

    await page.keyboard.press('Shift+Z')
    await sleep(400)
    const afterFit = await layoutOf(page)
    check(
      '9. Shift+Z 后整条内容装进视口（右边界不超出）',
      Boolean(afterFit) && afterFit.clipRight <= afterFit.laneRight + 2,
      `clipRight=${afterFit?.clipRight?.toFixed(1)} laneRight=${afterFit?.laneRight?.toFixed(1)}`
    )
    /**
     * 幂等：再按一次结果必须一样。
     *
     * 这条比"scrollWidth 恰好等于视口"有用 —— 画布宽度是 `timelineDuration`
     * （`max(30, 内容末点) + 10`，给刻度留的余量），本来就比内容长，
     * 所以适配到内容之后**仍然**会有横向滚动余量，这是正常的。
     * 真正能抓的退化是"适配拿当前 zoom 当输入"：那样连按两次会一路缩下去。
     */
    await page.keyboard.press('Shift+Z')
    await sleep(300)
    const fitAgain = await layoutOf(page)
    check(
      '10. 连按两次 Shift+Z 结果相同（适配是幂等的，不随当前缩放漂移）',
      Boolean(fitAgain) && fitAgain.scrollLeft === 0 && Math.abs(fitAgain.clipRight - afterFit.clipRight) < 2,
      `第一次 clipRight=${afterFit?.clipRight?.toFixed(1)} 第二次=${fitAgain?.clipRight?.toFixed(1)}`
    )

    const fitZoom = await zoomOf(page)
    check(
      '11. 滑块显示的值与实际布局一致（内容宽 ≈ 视口宽 − 右侧留白）',
      Boolean(afterFit) && Math.abs(15 * 46 * fitZoom - (afterFit.clientWidth - 48)) < 8,
      `zoom=${fitZoom} 内容宽=${(15 * 46 * fitZoom).toFixed(0)} 视口=${afterFit?.clientWidth}`
    )

    /* ------------------- C. 工具栏那颗按钮走同一条路 ------------------- */

    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Control+=')
    await sleep(300)
    await page.locator('[data-tl="fit"]').click()
    await sleep(400)
    const viaButton = await zoomOf(page)
    check(
      '12. 工具栏「适配全片」按钮与 Shift+Z 得到同一缩放',
      Math.abs(viaButton - fitZoom) < 0.02,
      `按钮=${viaButton} 快捷键=${fitZoom}`
    )

    /* ---------------------- D. Alt+滚轮横向移动 ---------------------- */

    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Control+=')
    await sleep(300)
    const scrolled = await page.evaluate(() => {
      const lane = document.querySelector('[data-tracks]')
      if (!lane) return null
      const before = lane.scrollLeft
      lane.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 400, altKey: true, bubbles: true, cancelable: true })
      )
      return { before, after: lane.scrollLeft }
    })
    check(
      '13. Alt+滚轮让时间线横向滚动（普通滚轮不抢）',
      Boolean(scrolled) && scrolled.after > scrolled.before + 50,
      `scrollLeft ${scrolled?.before} → ${scrolled?.after}`
    )

    /* ---------------------- E. 三键播放 J / K / L ----------------------
     * 这一族最容易「接对了、看不见」：动作登记了、键位也对、按下去也"有反应"，
     * 但播放头一动不动（方向没进 rAF），或者 K 停不住（只清了标志位没清 rAF）。
     * 判据一律读 `.playhead[data-playhead]`，不读 React state。
     */
    await page.keyboard.press('Home')
    await sleep(120)
    await page.keyboard.press('L')
    await sleep(700)
    const afterL = await playheadOf(page)
    check(
      '14. 按 L（正向播放）播放头前进',
      afterL > 0.2,
      `playhead=${afterL?.toFixed?.(2)}`
    )

    await page.keyboard.press('K')
    await sleep(120)
    const pauseAt = await playheadOf(page)
    await sleep(450)
    const pauseStill = await playheadOf(page)
    check(
      '15. 按 K 之后播放头停住（不是"标志位停了、rAF 还在跑"）',
      Math.abs(pauseStill - pauseAt) < 0.06,
      `${pauseAt?.toFixed?.(2)} → ${pauseStill?.toFixed?.(2)}`
    )

    await page.keyboard.press('J')
    await sleep(500)
    const afterJ = await playheadOf(page)
    check(
      '16. 按 J（倒放）播放头后退',
      afterJ < pauseStill - 0.15,
      `${pauseStill?.toFixed?.(2)} → ${afterJ?.toFixed?.(2)}`
    )
    /* 收尾：让播放停下来，免得后面的闸门（若共用窗口）拿到还在跑的播放头 */
    await page.keyboard.press('K')
    await sleep(80)
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    // 中断占最后一条：先补到 TOTAL-1 再用一条失败收尾，否则总数会多一条，
    // verify 报成"断言数不符"把真因盖掉。
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    clearTimeout(watchdog)
    await shutdown(app)
    console.log(`\n测试用 Electron profile 保留不删（此刻文件仍被占用，删它会卡死主线程）：${PROFILE}`)
  }
}

function summary() {
  clearTimeout(watchdog)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`TIMELINE_NAV_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('TIMELINE_NAV_E2E_FAILED')
    process.exitCode = 1
  } else {
    console.log('TIMELINE_NAV_E2E_OK')
    process.exitCode = 0
  }
}

/* 看门狗：verify 用 spawnSync 跑且不传 timeout，这里一卡整套永久挂住且没有可读输出 */
watchdog = setTimeout(async () => {
  console.error('\n[!] 超时：强行收尾')
  backfillSkips('超时未跑到')
  summary()
  process.exit(1)
}, Number(process.env.TIMELINE_NAV_E2E_TIMEOUT_MS || 4 * 60 * 1000))

main()
  .then(() => {
    summary()
    process.exit(process.exitCode || 0)
  })
  .catch((error) => {
    console.error(`[!] 未捕获：${String(error?.stack || error)}`)
    backfillSkips('未捕获异常')
    summary()
    process.exit(1)
  })
