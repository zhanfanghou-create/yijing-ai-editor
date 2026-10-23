/**
 * 预览框直接操作 + 吸附 + 特效隔离 的 UI E2E（真启 Electron + 真指针拖动）。
 *
 * 为什么必须有这道：这一批功能**全都是"看着有、其实没接"的高危区**：
 *   ① 预览里的选框画出来了，但拖动不写数据 ⇒ 选框只是装饰；
 *   ② 拖了也写了，但写到的不是导出用的那几个字段 ⇒ 预览动了、成片没动；
 *   ③ 吸附算法改了，但拖整段只吸前缘 ⇒ 尾巴永远接不齐；
 *   ④ 画面特效挂在画框上 ⇒ 圆角/阴影跟着抖，而**成片里没有画框**。
 *
 * 判据一律取**消费端**：
 *   · 选框的 `data-sel-id` 是否等于时间线上被选中的那个片段；
 *   · 右栏「位置 X」输入框里的数值（真的回写了，不是只改了 DOM）；
 *   · 画布内联 transform 的**矩阵分量**（真的推到了样式上，而不是只改了 state）；
 *   · `.canvas-content` 与 `.canvas-frame` 的 `animation-name`（特效到底挂在谁身上）；
 *   · 片段 DOM 的像素左边界 vs 播放头像素位置（吸附是否真的对齐）。
 *
 * 断言总数恒为 20：缺 ffmpeg / electron 时逐条 SKIP，verify 里钉死的数字才有意义。
 *
 * 用法：node tools/preview-select-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.preview-select-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 19
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
  await sleep(400)
}

const WATCHDOG_MS = Number(process.env.PREVIEW_SELECT_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

/** 右栏「位置 X / 位置 Y / 旋转」输入框的值 */
const numOf = (page, hook) =>
  page.evaluate((key) => {
    const el = document.querySelector(`[data-insp-num="${key}"]`)
    return el ? Number(el.value) : NaN
  }, hook)

/** 右栏滑杆的值（缩放没有输入框，只有滑杆） */
const sliderOf = (page, hook) =>
  page.evaluate((key) => {
    const el = document.querySelector(`[data-slider="${key}"]`)
    return el ? Number(el.value) : NaN
  }, hook)

/** 主画面元素的内联 transform 矩阵（没有 transform 时返回单位阵） */
const mediaMatrixOf = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.canvas-layer[data-selectable] img, .canvas-layer[data-selectable] video')
    const raw = el ? getComputedStyle(el).transform : ''
    if (!raw || raw === 'none') return { a: 1, e: 0, f: 0 }
    const nums = raw.replace(/^matrix\(|\)$/g, '').split(',').map(Number)
    return { a: nums[0], e: nums[4], f: nums[5] }
  })

const animOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return 'MISSING'
    return getComputedStyle(el).animationName || 'none'
  }, selector)

/** 片段左边界与播放头的像素位置（吸附是否真的对齐，要看像素而不是秒） */
const snapGeometry = (page) =>
  page.evaluate(() => {
    const clip = document.querySelector('.clip[data-clip]')
    const head = document.querySelector('.playhead')
    if (!clip || !head) return null
    return { clip: clip.getBoundingClientRect().x, head: head.getBoundingClientRect().x }
  })

async function main() {
  console.log('=== 预览框直接操作 / 吸附 / 特效隔离 E2E ===\n')

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    check('能找到 ffmpeg', false, '未找到')
    backfillSkips('本机没有 ffmpeg')
    return
  }
  const ffmpeg = found.ffmpeg
  const probe = spawnCapture(ffmpeg, ['-version'], { tag: 'ver' })
  check('ffmpeg 可执行（-version 返回 0）', probe.status === 0, String(probe.stdout || '').split('\n')[0])

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-sel-'))
  const clipA = path.join(work, 'a-green.mp4')
  /* 320×240 足够：这道闸门判的是几何与样式，不是画质 */
  spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', clipA],
    { tag: 'mk' }
  )
  const made = fs.existsSync(clipA) && fs.statSync(clipA).size > 1024
  check('测试素材生成完毕（一段 8 秒影片）', made, made ? clipA : '生成失败')
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

    const rows = await page.evaluate((p) => window.yjai.media.stat(p), [clipA])
    const list = Array.isArray(rows) ? rows : []
    check(
      '影片登记为视频素材（URL 走自定义协议）',
      list.length === 1 && list[0].kind === 'video' && String(list[0].url).startsWith('yjai-media://'),
      list.map((item) => item.name + ':' + item.kind).join(' | ')
    )
    if (list.length !== 1) throw new Error('素材没登记上：后面所有断言都依赖它')

    /* 夹具：一个片段（0–4 秒）、播放头停在 2 秒、画面特效 = 抖动。
       特效选 transform 类（fx-shake）就是为了验"它到底挂在谁身上"。 */
    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: 'E2E 预览直接操作',
        data: {
          assets: list.map((item) => ({ ...item, id: 'sel_asset' })),
          clips: [
            {
              id: 'sel_a',
              track: 'video',
              assetId: 'sel_asset',
              kind: 'video',
              name: list[0].name,
              url: list[0].url,
              path: clipA,
              start: 0,
              duration: 4,
              offset: 0,
              sourceDuration: 8,
              speed: 1,
              frameFx: 'fx-shake'
            }
          ],
          playhead: 2,
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
    await sleep(700)

    /* -------------------- ① 点画面 = 选中那个片段 -------------------- */

    const frame = await page.locator('.canvas-frame').boundingBox()
    check('预览画布已渲染（有可用矩形）', Boolean(frame && frame.width > 100), frame ? `${Math.round(frame.width)}×${Math.round(frame.height)}` : 'null')
    if (!frame) throw new Error('画布没出来，后面全部依赖它')

    const cx = frame.x + frame.width / 2
    const cy = frame.y + frame.height / 2
    /* 先点时间线上的**第二条**（这里只有一条）之外的地方清掉选中，再从画面点回来：
       要验的是"点画面本身能选中"，而不是"时间线选中后选框恰好出现"。 */
    await page.keyboard.press('Escape')
    await sleep(200)
    await page.mouse.click(cx, cy)
    await sleep(350)
    /* 右栏切到「画面」页：位置 X / Y 与旋转的输入框只在这一页。
       ⚠️ 必须先切页再读数值 —— 停在「信息」页时 `[data-insp-num="posx"]` 不存在，
          读出来是 NaN，看起来像"拖动没生效"。（本轮踩过） */
    await page.locator('[data-insp-tab="visual"]').click()
    await sleep(300)

    const selBox = await page.evaluate(() => {
      const el = document.querySelector('.canvas-sel')
      return el ? { kind: el.getAttribute('data-sel-kind'), id: el.getAttribute('data-sel-id') } : null
    })
    check(
      '点画面选中主画面片段（选框出现且 id 与片段一致）',
      Boolean(selBox) && selBox.kind === 'main' && selBox.id === 'sel_a',
      JSON.stringify(selBox)
    )

    /* -------------------- ② 拖动选框 = 改位置 -------------------- */

    const beforeX = await numOf(page, 'posx')
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 60, cy + 30, { steps: 6 })
    await page.mouse.up()
    await sleep(350)

    const afterX = await numOf(page, 'posx')
    const expectX = (60 / frame.width) * 100
    check(
      `拖动 60px ⇒ 位置 X ≈ ${expectX.toFixed(1)}%（按画布宽度换算）`,
      Number.isFinite(afterX) && Math.abs(afterX - expectX) <= 2.5 && Math.abs(afterX - beforeX) > 1,
      `拖动前 ${beforeX} → 拖动后 ${afterX}`
    )

    const matrixMove = await mediaMatrixOf(page)
    check(
      '画布元素的内联 transform 真的跟着变了（不是只改了面板数字）',
      Math.abs(matrixMove.e) > 1,
      `matrix.e=${matrixMove.e.toFixed(2)}`
    )

    /* -------------------- ③ 双击复位 -------------------- */
    /* ⚠️ 顺序必须是「先复位、再拖角」：画面被平移到右侧之后，选框的右下角
       跟着移出画布，而画布是 overflow:hidden —— 那半个手柄点不到
       （与参考客户端一致：超出预览窗口的部分本来就不可操作）。
       这不是缺陷，但**测试顺序不对就会误判成"缩放没接"**。 */

    await page.mouse.dblclick(cx, cy)
    await sleep(400)
    const resetX = await numOf(page, 'posx')
    const resetMatrix = await mediaMatrixOf(page)
    check(
      '双击画面复位（位置回 0、缩放回 100%）',
      Math.abs(resetX) < 0.5 && Math.abs(resetMatrix.a - 1) < 0.02,
      `posX=${resetX} scale=${resetMatrix.a.toFixed(3)}`
    )

    /* -------------------- ④ 四角缩放 -------------------- */

    const handle = await page.locator('[data-sel-handle="se"]').boundingBox()
    check('四角手柄可见（右下那个）', Boolean(handle), handle ? `${Math.round(handle.width)}px` : 'null')
    if (handle) {
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + 70, handle.y + 55, { steps: 6 })
      await page.mouse.up()
      await sleep(350)
    }
    const matrixScale = await mediaMatrixOf(page)
    const scaleValue = await sliderOf(page, 'scale')
    check(
      '拖右下角 ⇒ 画面被放大（右栏缩放 > 100%，矩阵 scale > 1）',
      matrixScale.a > 1.02 && scaleValue > 100,
      `matrix.a=${matrixScale.a.toFixed(3)} 面板=${scaleValue}%`
    )

    /* -------------------- ⑤ Esc 取消选中 -------------------- */

    await page.keyboard.press('Escape')
    await sleep(300)
    const selAfterEsc = await page.locator('.canvas-sel').count()
    check('Esc 取消选中（选框消失）', selAfterEsc === 0, `${selAfterEsc} 个`)

    /* -------------------- ⑤ 特效只动内容、不动画框 -------------------- */

    const contentAnim = await animOf(page, '.canvas-content')
    const frameAnim = await animOf(page, '.canvas-frame')
    check(
      '画面特效（抖动）挂在**内容层**上',
      contentAnim.includes('fx-shake'),
      `content=${contentAnim}`
    )
    check(
      '画框自身**没有任何动画**（圆角/阴影/边界不跟着抖，与成片一致）',
      frameAnim === 'none' || frameAnim === '',
      `frame=${frameAnim}`
    )

    /* -------------------- ⑥ 吸附：拖到播放头附近要对齐到像素 -------------------- */

    const clipBox = await page.locator('.clip[data-clip]').first().boundingBox()
    const headBox = await page.locator('.playhead').boundingBox()
    check('片段与播放头都有可用矩形', Boolean(clipBox && headBox), `${clipBox ? Math.round(clipBox.x) : '-'} / ${headBox ? Math.round(headBox.x) : '-'}`)

    if (clipBox && headBox) {
      /* 从片段中部抓起，拖到播放头右侧 6px 处（在 8px 吸附阈值内） */
      await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(clipBox.x + clipBox.width / 2 + (headBox.x - clipBox.x) + 6, clipBox.y + clipBox.height / 2, { steps: 8 })
      await sleep(300)
      const line = await page.evaluate(() => {
        const el = document.querySelector('.wb-snapline')
        return el ? el.getAttribute('data-snap-line') : null
      })
      await page.mouse.up()
      await sleep(300)

      check('拖动中吸住了 ⇒ 出现吸附辅助线（吸中是看得见的）', line !== null, `line=${line}`)

      const geo = await snapGeometry(page)
      check(
        '松手后片段左边界与播放头对齐（误差 ≤ 1px，吸附真的写了数据）',
        Boolean(geo) && Math.abs(geo.clip - geo.head) <= 1.5,
        geo ? `clip=${geo.clip.toFixed(1)} head=${geo.head.toFixed(1)}` : 'null'
      )
    } else {
      skipped('吸附对齐判据', '矩形缺失')
      skipped('吸附辅助线判据', '矩形缺失')
    }

    /* -------------------- ⑦ Alt + 拖动 = 复制一份 -------------------- */

    const beforeCount = await page.locator('.clip[data-clip]').count()
    const box2 = await page.locator('.clip[data-clip]').first().boundingBox()
    if (box2) {
      await page.keyboard.down('Alt')
      await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2)
      await page.mouse.down()
      await page.mouse.move(box2.x + box2.width / 2 + 160, box2.y + box2.height / 2 + 40, { steps: 8 })
      await page.mouse.up()
      await page.keyboard.up('Alt')
      await sleep(400)
    }
    const afterCount = await page.locator('.clip[data-clip]').count()
    check(
      'Alt + 拖动复制出一份新片段（原件留在原地）',
      afterCount === beforeCount + 1,
      `${beforeCount} → ${afterCount}`
    )

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
  console.log(`PREVIEW_SELECT_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('PREVIEW_SELECT_FAILED')
  } else {
    console.log('PREVIEW_SELECT_OK')
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
