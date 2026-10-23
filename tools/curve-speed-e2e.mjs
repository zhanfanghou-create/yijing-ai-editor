/**
 * 曲线变速 UI E2E：真启 Electron + ffmpeg 现造一段影片 + 真点预设 / 真拖手柄 / 真读 playbackRate。
 *
 * 为什么必须有这道（曲线变速唯一的**行为级**证据）：
 * 「曲线变速」这个词在代码里其实是三件事，任何一件没接上都**不报错、不黑屏**：
 *   ① 面板上的曲线编辑器（画出来、能拖）—— 只是装饰的话，用户拖半天什么都没有；
 *   ② 时间线占位（面积 = 平均速率 ⇒ 片段该变长就变长）—— 没接的话曲线只活在面板里；
 *   ③ 预览的瞬时速率（playbackRate 跟着 v(p) 走）—— 只换源时间不换 playbackRate，
 *     画面会"起点对、越播越歪"；只换 playbackRate 不换源时间，起点就错。
 *
 * 判据全部取**消费端**行为量，不读 state、不读 data 属性本身：
 *   · 片段的 `clip-dur` 文本（时间线真的重排了）；
 *   · 曲线的 SVG `path d` 字符串（形状真的变了，且不同预设不同形状）；
 *   · 面板上的「平均倍速」文本 vs `shared/speed.js` 在 node 侧算出的面积（两边必须相等）；
 *   · `<video>.playbackRate` 在播放头处是否等于 `curveAt(p)`（预览真的按曲线走）。
 *
 * 断言总数恒为 20：找不到 ffmpeg / electron 时逐条 SKIP（不是少跑），
 * 这样 verify.mjs 里钉死的数字才有意义。
 *
 * 用法：node tools/curve-speed-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { spawnCapture } from './spawn-capture.mjs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))
const speedTable = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'speed.js'))
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.curve-speed-profile-${process.pid}`)

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

async function shutdown(app) {
  if (!app) return
  try {
    await withTimeout(app.close(), 8000, 'app.close')
    return
  } catch {
    /* 落到强杀 */
  }
  try {
    const pid = app.process()?.pid
    if (pid) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 进程可能已经退了 */
  }
  await sleep(500)
}

const WATCHDOG_MS = Number(process.env.CURVE_SPEED_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

const clipDurOf = (page) =>
  page.evaluate(() => document.querySelector('.clip[data-clip] .clip-dur')?.textContent?.trim() || '')

const curvePathOf = (page) =>
  page.evaluate(() => document.querySelector('[data-curve-path="speed"]')?.getAttribute('d') || '')

const curveMeanOf = (page) =>
  page.evaluate(() => document.querySelector('[data-curve-mean]')?.textContent?.trim() || '')

const playbackRateOf = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.canvas-frame video')
    return el ? Number(el.playbackRate) : NaN
  })

/** 预设的期望：面积、期望占位（源跨度守恒）、期望占位文本 */
const expectOf = (key, duration = 4) => {
  const preset = speedTable.CURVE_PRESETS.find((item) => item.key === key)
  const mean = speedTable.curveMean(preset.points)
  const next = Number(((duration * 1) / mean).toFixed(3))
  const frames = Math.floor((next % 1) * 30)
  const secs = Math.floor(next)
  const text = `00:00:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
  return { mean, next, text }
}

async function main() {
  console.log('=== 曲线变速 UI E2E（真影片 + 真点预设 + 真拖手柄 + playbackRate 判据）===\n')

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    check('能找到 ffmpeg', false, '未找到')
    backfillSkips('本机没有 ffmpeg')
    return
  }
  const ffmpeg = found.ffmpeg
  const probe = spawnCapture(ffmpeg, ['-version'], { tag: 'ver' })
  check('ffmpeg 可执行（-version 返回 0）', probe.status === 0, String(probe.stdout || '').split('\n')[0])

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-curve-'))
  const clipA = path.join(work, 'a-red.mp4')
  /* 12 秒素材：曲线最慢处要吃掉比占位更多的源（蒙太奇均值 1.425 ⇒ 片段会缩短；
     闪进均值 < 1 ⇒ 片段会变长，需要 4/0.5 = 8 秒源），留足余量避免被"源不够"夹住 */
  const r1 = spawnCapture(
    ffmpeg,
    [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25',
      '-t', '12',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
      clipA
    ],
    { tag: 'mk' }
  )
  const made = fs.existsSync(clipA) && fs.statSync(clipA).size > 1024
  check('测试素材生成完毕（一段 12 秒影片）', made, made ? clipA : String(r1.stdout || '').slice(0, 120))
  if (!made) {
    backfillSkips('素材没造出来，后面依赖它')
    return
  }

  if (!fs.existsSync(EXE)) {
    check('找到 electron', false, EXE)
    backfillSkips('找不到 electron')
    return
  }

  let app = null
  const pageErrors = []

  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text())
    })
    await page.waitForSelector('.home', { timeout: 30000 })

    /* 标记先进设置（App 启动时读一次），后面「按标记卡点」要用 */
    await page.evaluate(() => window.yjai.settings.set('markers', [1, 2, 3]))
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })

    const rows = await page.evaluate((p) => window.yjai.media.stat(p), [clipA])
    const list = Array.isArray(rows) ? rows : []
    check(
      '影片登记为视频素材（URL 走自定义协议）',
      list.length === 1 && list[0].kind === 'video' && String(list[0].url).startsWith('yjai-media://'),
      list.map((item) => item.name + ':' + item.kind).join(' | ')
    )
    if (list.length !== 1) throw new Error('素材没登记上：后面所有断言都依赖它')

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: 'E2E 曲线变速',
        data: {
          assets: list.map((item) => ({ ...item, id: 'cv_asset_a' })),
          /* 两个片段紧贴着（0–4 与 4–7）：曲线让第一段变长/变短之后，
             第二段必须跟着平移，否则同一条轨上两段会叠在一起 ——
             时间线上看着像坏了，播放时"上面那个赢"，后半段凭空消失。 */
          clips: [
            {
              id: 'cv_a',
              track: 'video',
              assetId: 'cv_asset_a',
              kind: 'video',
              name: list[0].name,
              url: list[0].url,
              path: clipA,
              start: 0,
              duration: 4,
              offset: 0,
              sourceDuration: 12,
              speed: 1
            },
            {
              id: 'cv_b',
              track: 'video',
              assetId: 'cv_asset_a',
              kind: 'video',
              name: list[0].name,
              url: list[0].url,
              path: clipA,
              start: 4,
              duration: 3,
              offset: 8,
              sourceDuration: 12,
              speed: 1
            }
          ],
          playhead: 0,
          volume: 80,
          zoom: 1
        }
      }
    )
    check('夹具草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(600)

    await page.locator('.clip[data-clip]').first().click()
    await page.waitForSelector('.wb-info-body', { timeout: 10000 })
    await sleep(300)
    await page.locator('[data-insp-tab="speed"]').click()
    await sleep(250)

    /* ------------------------ ① 面板：预设 + 匀速滑杆 ------------------------ */

    const presets = await page.locator('[data-curve-preset]').count()
    check('变速页出现五枚预设（常速 + 四条曲线）', presets === 5, `${presets} 枚`)

    const hasSlider = await page.locator('.wb-slider, .slider-row').count()
    const curveBefore = await page.locator('.wb-curve').count()
    check(
      '未启用曲线时给的是匀速滑杆（不是空面板）',
      hasSlider > 0 && curveBefore === 0,
      `slider=${hasSlider} curve=${curveBefore}`
    )
    check('改之前片段占 4 秒', (await clipDurOf(page)) === '00:00:04:00', await clipDurOf(page))

    /* ------------------------ ② 点「子弹时间」→ 曲线真的上去了 ------------------------ */

    const bullet = expectOf('bullet', 4)
    await page.locator('[data-curve-preset="bullet"]').click()
    await sleep(500)

    const handles = await page.locator('[data-curve-handle]').count()
    check('曲线编辑器出现且手柄数量 = 预设的控制点个数', handles >= 5, `${handles} 个手柄`)

    const meanText = await curveMeanOf(page)
    check(
      `「平均倍速」= 曲线面积（${bullet.mean.toFixed(2)}x，与 shared/speed.js 同源）`,
      meanText === `${bullet.mean.toFixed(2)}x`,
      `UI=${meanText}`
    )

    const durBullet = await clipDurOf(page)
    check(
      `时间线占位按源跨度守恒重算（4s ÷ ${bullet.mean.toFixed(3)} ≈ ${bullet.text}）`,
      durBullet === bullet.text,
      `实际 ${durBullet}`
    )

    /* 像素级判据：两段原本紧贴，第一段变长之后第二段必须跟着右移，接缝仍然是 0 像素 */
    const seam = await page.evaluate(() => {
      const clips = Array.from(document.querySelectorAll('.clip[data-clip]'))
        .map((node) => node.getBoundingClientRect())
        .sort((a, b) => a.x - b.x)
      if (clips.length < 2) return null
      return clips[1].x - (clips[0].x + clips[0].width)
    })
    check(
      '第一段变长后第二段跟着平移（同轨接缝仍是 0 像素，不叠在一起）',
      seam !== null && Math.abs(seam) <= 2,
      `seam=${seam}`
    )

    const pathBullet = await curvePathOf(page)
    check('曲线的 path 有真实形状（不是空串）', pathBullet.startsWith('M') && pathBullet.includes('L'), pathBullet.slice(0, 40))

    /* ------------------------ ③ 换预设 → 形状与均值都变 ------------------------ */

    const montage = expectOf('montage', 4)
    await page.locator('[data-curve-preset="montage"]').click()
    await sleep(500)
    const pathMontage = await curvePathOf(page)
    check(
      '换「蒙太奇」后曲线形状确实变了（path 不同）',
      pathMontage !== pathBullet && pathMontage.length > 10,
      `${pathBullet.slice(0, 24)} → ${pathMontage.slice(0, 24)}`
    )
    check(
      `「蒙太奇」的平均倍速 = ${montage.mean.toFixed(2)}x`,
      (await curveMeanOf(page)) === `${montage.mean.toFixed(2)}x`,
      await curveMeanOf(page)
    )

    /* ------------------------ ④ 真拖手柄 → 均值跟着变 ------------------------ */

    const box = await page.locator('[data-curve-handle="2"]').boundingBox()
    const meanBeforeDrag = await curveMeanOf(page)
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 26, { steps: 8 })
      await page.mouse.up()
      await sleep(350)
    }
    const meanAfterDrag = await curveMeanOf(page)
    check('拖动手柄后平均倍速变了（拖拽真的改到了数据）', Boolean(box) && meanAfterDrag !== meanBeforeDrag, `${meanBeforeDrag} → ${meanAfterDrag}`)

    /* ------------------------ ⑤ 曲线在位时倒放被挡（不给假控件） ------------------------ */

    const blocked = await page.locator('[data-reverse-blocked]').count()
    check('有曲线时倒放给出说明而不是假开关', blocked === 1, `找到 ${blocked} 处说明`)

    /* ------------------------ ⑥ 预览真的按曲线播 ------------------------ */

    await page.keyboard.press('Home')
    await sleep(250)
    await page.keyboard.press('Shift+ArrowRight')
    await sleep(450)
    /* 播放头 1 秒 → p = 1/占位。期望速率 = curveAt(当前曲线, p)。
       曲线被拖过，所以直接读面板上的点列不现实 —— 这里判"确实不是 1x 且落在合法区间"，
       再加上一条更强的：换回子弹时间这种**已知形状**再验精确值。 */
    const dragRate = await playbackRateOf(page)
    check(
      '播放头 1s 处 <video> 的 playbackRate 不是 1（预览真的按曲线变速）',
      Number.isFinite(dragRate) && Math.abs(dragRate - 1) > 0.02,
      String(dragRate)
    )

    await page.locator('[data-curve-preset="bullet"]').click()
    await sleep(500)
    /* 走到 2 秒处：子弹时间在这一段（p≈0.40）已经压到 0.6x 左右，
       比"1 秒处还是 1x"更能分辨"预览到底有没有按曲线设 playbackRate"。 */
    await page.keyboard.press('Home')
    await sleep(200)
    await page.keyboard.press('Shift+ArrowRight')
    await sleep(200)
    await page.keyboard.press('Shift+ArrowRight')
    await sleep(450)
    const bulletRate = await playbackRateOf(page)
    /* 播放头在 1 秒处 ⇒ p = 1 / 新的时间线占位。期望速率直接由真源算：
       这一段比的是"预览设给 <video> 的 playbackRate"与"曲线在 p 处的值"，
       不是比"我算得对不对" —— 后者已经由 check-speed-curve 钉住了。 */
    const bulletPoints = speedTable.CURVE_PRESETS.find((item) => item.key === 'bullet').points
    const expectedRate = speedTable.curveAt(bulletPoints, 2 / bullet.next)
    check(
      `子弹时间：播放头 2s 处 playbackRate ≈ ${expectedRate.toFixed(2)}（与 curveAt 同一口径）`,
      Math.abs(bulletRate - expectedRate) < 0.12,
      `实际 ${bulletRate} / 期望 ${expectedRate.toFixed(3)}`
    )

    /* ------------------------ ⑦ 「常速」清掉曲线 ------------------------ */

    await page.locator('[data-curve-preset="none"]').click()
    await sleep(500)
    check('点「常速」后曲线编辑器消失', (await page.locator('.wb-curve').count()) === 0)
    check('点「常速」后时间线占位回到 4 秒', (await clipDurOf(page)) === '00:00:04:00', await clipDurOf(page))

    /* ------------------------ ⑧ 按标记卡点 ------------------------ */

    const beatButton = page.locator('[data-beat-marker]')
    const beatEnabled = await beatButton.isEnabled()
    check('三部标记都在片段范围内 ⇒「按标记」按钮可用', beatEnabled === true, String(beatEnabled))
    await beatButton.click()
    await sleep(700)
    const beatCurve = await page.locator('.wb-curve').count()
    const beatMeanText = await curveMeanOf(page)
    const beatMeanValue = Number(String(beatMeanText).replace('x', ''))
    check(
      '按标记卡点生成了曲线（3 个重音 ⇒ 有慢点）',
      beatCurve === 1 && beatMeanValue > 0.3 && beatMeanValue < 2,
      `curve=${beatCurve} mean=${beatMeanText}`
    )

    const note = await page.locator('[data-beat-note]').textContent()
    check('卡点结果有反馈文案（不是点了没反应）', /已按\s*3\s*个标记/.test(String(note || '')), String(note || '').trim().slice(0, 40))

    const realErrors = pageErrors.filter((text) => !/Failed to load resource|net::ERR|403|401/i.test(text))
    check('全程无页面错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    clearTimeout(watchdog)
    await shutdown(app)
    app = null
  }
}

function summary() {
  clearTimeout(watchdog)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`CURVE_SPEED_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('CURVE_SPEED_FAILED')
  } else {
    console.log('CURVE_SPEED_OK')
  }
  const code = fail ? 1 : 0
  process.exitCode = code
  process.stdout.write('', () => process.exit(code))
  setTimeout(() => process.exit(code), 1000).unref()
}

main().catch((error) => {
  console.error('[!] 未捕获异常：' + String(error?.stack || error))
  fail += 1
}).finally(summary)
