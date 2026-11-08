/**
 * 时间线导航 E2E：真启 Electron + 真按键 + 真拖动，验「切点跳转 / 适配全片 /
 * Alt+滚轮横移 / 播放头拖动」。
 *
 * 为什么纯逻辑自测（tools/timeline-nav-selftest.mjs）之外还要这一道：
 * 自测只能证明 `stepCut` / `fitZoom` 算得对，证明不了下面五件只在真机成立的事 ——
 *   1. **键真的接上了**：`prevCut`/`nextCut`/`zoomFit` 在 ACTIONS 里、在派发表里、
 *      而且按下去改的是**播放头**而不是别的状态（"接错到别的动作"是静默失效的一类）；
 *   2. **播放头真的动了**：判据读的是那根线的 `data-playhead`（用户看到的位置），
 *      不是 React state —— state 变了而线没动，截图才看得出来；
 *   3. **适配真的把内容装进了视口**：判据读 `getBoundingClientRect()`，
 *      不是读 slider 的 value。算出来的缩放写进了 state、但样式没跟上（或者反过来）
 *      都只表现为"按了没反应"；
 *   4. **Alt+滚轮真的横向滚**：wheel 监听是原生挂的，React 的 onWheel 拦不住
 *      preventDefault，这里派发真实 WheelEvent 看 scrollLeft；
 *   5. **按住左键真的能拖着播放头走**：pointerdown 定位一次 + 无 move 处理，
 *      和"抓手上没有 pointer-events"，两种都表现为"拖不动"，但都过得了所有静态闸门。
 *
 * 断言总数恒为 24：找不到 electron / 中途出错时逐条补 SKIP（不是少跑）。
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

const TOTAL_ASSERTIONS = 24
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

/**
 * 时间线的几何：左沿 / 可视宽 / 当前横向滚动。
 * 拖动判据全靠它把像素换成秒 —— 换算公式必须与实际实现同源：
 * 秒 = (clientX − lane.left + lane.scrollLeft) / (46 × zoom)，其中 46 是 BASE_DPS（规格常量）。
 */
function laneGeom(page) {
  return page.evaluate(() => {
    const lane = document.querySelector('[data-tracks]')
    if (!lane) return null
    const rect = lane.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: lane.clientWidth, scrollLeft: lane.scrollLeft }
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

    /* -------------------- F. 播放头拖动（按住左键随意拖） --------------------
     * Jason 报的是"拖动不灵活、不能按住左键随意拖"：
     *   · 改动前只有 pointerdown 定位一次，之后的 pointermove 没人管；
     *   · 标尺上那个白色"抓手"是 `.playhead::before` 画的装饰，父元素 pointer-events: none。
     * 所以这里既验"拖得动、跟手、松手不跳"，也验"抓手真的能被指针命中"（旧的假抓手必红）。
     * 判据一律读消费端：`.playhead[data-playhead]`、`data-scrubbing`、`elementFromPoint`。
     */
    await page.keyboard.press('Home')
    await sleep(200)
    const geom = await laneGeom(page)
    const zoomNow = await zoomOf(page)
    const dpsNow = 46 * zoomNow
    const rulerY = geom.top + 11
    /** 像素 → 秒（与实现同一口径） */
    const toSeconds = (x) => Math.max(0, (x - geom.left + geom.scrollLeft) / dpsNow)
    /**
     * 片段在**内容坐标**里的横位（= rect.left − lane.left + scrollLeft）。
     * 不能直接比 rect.left：拖到左端时会顺手把视图滚回 0（这是刻意的边缘自动滚），
     * 所有片段的视口坐标会整体平移 —— 那是滚动，不是"被挪了"。
     */
    const clipContentXs = () =>
      page.evaluate(() => {
        const lane = document.querySelector('[data-tracks]')
        const base = lane.getBoundingClientRect().left - lane.scrollLeft
        return [...document.querySelectorAll('.clip[data-clip]')].map((node) =>
          Math.round(node.getBoundingClientRect().left - base)
        )
      })
    const clipsBefore = await clipContentXs()

    const x1 = geom.left + 200
    const x2 = geom.left + 380
    await page.mouse.move(x1, rulerY)
    await page.mouse.down()
    await sleep(120)
    const pressed = await playheadOf(page)
    await page.mouse.move(x2, rulerY, { steps: 8 })
    await sleep(120)
    const dragging = await playheadOf(page)
    check(
      '17. 按住标尺拖动，松手前播放头就已经跟到指针处（实时，不是松手才跳）',
      Math.abs(dragging - toSeconds(x2)) < 0.15 && Math.abs(dragging - pressed) > 0.2,
      `按下=${pressed?.toFixed?.(2)} 拖到=${dragging?.toFixed?.(2)} 期望=${toSeconds(x2).toFixed(2)}`
    )

    const x3 = geom.left + 300
    await page.mouse.move(x3, rulerY, { steps: 6 })
    await sleep(120)
    const draggedBack = await playheadOf(page)
    check(
      '18. 继续往回拖仍然在跟（不是只认按下那一下）',
      Math.abs(draggedBack - toSeconds(x3)) < 0.15 && draggedBack < dragging,
      `拖到=${draggedBack?.toFixed?.(2)} 期望=${toSeconds(x3).toFixed(2)}`
    )

    await page.mouse.up()
    await sleep(150)
    const released = await playheadOf(page)
    const scrubFlag = await page.getAttribute('.wb-timeline', 'data-scrubbing')
    check(
      '19. 松手后停在最后位置，拖动状态复位（data-scrubbing 回到 0，没有卡在拖动态）',
      Math.abs(released - draggedBack) < 0.06 && scrubFlag === '0',
      `松手=${released?.toFixed?.(2)} 松手前=${draggedBack?.toFixed?.(2)} data-scrubbing=${scrubFlag}`
    )

    /* 抓手：能不能命中，是"真按钮 vs 装饰"唯一能自动判的东西 */
    const gripHit = await page.evaluate(() => {
      const grip = document.querySelector('[data-playhead-grip]')
      if (!grip) return null
      const rect = grip.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        onGrip: Boolean(hit && hit.getAttribute('data-playhead-grip') === '1')
      }
    })
    check(
      '20. 播放头抓手真的能被指针命中（不是 pointer-events:none 的装饰）',
      Boolean(gripHit) && gripHit.onGrip && gripHit.height >= 16,
      gripHit ? `${gripHit.width}×${gripHit.height} 命中=${gripHit.onGrip}` : '找不到 [data-playhead-grip]'
    )

    /* 抓手拖动：抓在**左沿**按下去。若实现按"指针位置"锚定，播放头会先往后跳半个抓手；
       按"播放头 + 抓取偏移"锚定则一动不动。7px ≈ 0.038s（dps=184）/ 0.108s（dps=65）。 */
    const gripBox = await page.evaluate(() => {
      const grip = document.querySelector('[data-playhead-grip]')
      const rect = grip.getBoundingClientRect()
      return { left: rect.left, top: rect.top, cy: rect.top + rect.height / 2 }
    })
    const basePlayhead = await playheadOf(page)
    const grabX = gripBox.left + 2
    await page.mouse.move(grabX, gripBox.cy)
    await page.mouse.down()
    await sleep(120)
    const afterGrab = await playheadOf(page)
    check(
      '21. 抓住手柄按下那一刻播放头不跳（保持抓取偏移，而不是吸到指针中心）',
      Math.abs(afterGrab - basePlayhead) < 0.02,
      `按下前=${basePlayhead?.toFixed?.(3)} 按下后=${afterGrab?.toFixed?.(3)}`
    )

    await page.mouse.move(grabX + 90, gripBox.cy, { steps: 6 })
    await sleep(120)
    const gripDragged = await playheadOf(page)
    await page.mouse.up()
    await sleep(120)
    check(
      '22. 抓着手柄拖 90px，播放头前进对应的秒数',
      Math.abs(gripDragged - (basePlayhead + 90 / dpsNow)) < 0.15,
      `=${gripDragged?.toFixed?.(2)} 期望=${(basePlayhead + 90 / dpsNow).toFixed(2)}`
    )

    /* 越界：拖到时间线左端之外。夹取只在 [0, duration]，不能出负数（负数会让预览 seek 到负时间） */
    await page.mouse.move(geom.left + 40, rulerY)
    await page.mouse.down()
    await page.mouse.move(geom.left - 260, rulerY, { steps: 8 })
    await sleep(250)
    const clampedLeft = await playheadOf(page)
    await page.mouse.up()
    await sleep(100)
    check(
      '23. 拖过左端夹在 0（不出负数、不把播放头甩飞）',
      clampedLeft === 0,
      `playhead=${clampedLeft}`
    )

    /* 负对照：整段拖动不许挪动任何片段 —— 拖动播放头被误接成"拖片段"是最隐蔽的一种 */
    const clipsAfter = await clipContentXs()
    check(
      '24. 拖动播放头不会挪动片段（负对照：没被误接成拖片段）',
      clipsAfter.length === clipsBefore.length && clipsAfter.every((value, index) => value === clipsBefore[index]),
      `${clipsBefore.join(',')} → ${clipsAfter.join(',')}`
    )
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
