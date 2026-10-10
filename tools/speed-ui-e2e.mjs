/**
 * 倍速 UI E2E：真启 Electron + ffmpeg 现造一段影片 + 真点面板上的「2x」。
 *
 * 为什么要单独一道闸门（它是倍速唯一的**行为级**证据）：
 * 倍速落在三个地方，任意一处漏掉都不会报错、也不会空屏 ——
 *   ① 时间线占位（duration 要按 `duration × 速度` 守恒重算）
 *   ② 预览（源时间乘倍速 **且** playbackRate 设上，两者缺一都是"看起来在动，其实不对"）
 *   ③ 导出（trim 取源跨度 + setpts/atempo）
 * ③ 由 render-e2e 的六条逐像素断言钉住；**① 和 ② 只有真点一遍才知道** ——
 *    尤其是 ②：只对齐源时间、不设 playbackRate，画面在刚点下去那一帧是对的，
 *    越播越落后，而静态扫描、构建、截图（永远拍稳定态）全部全绿。
 *
 * 判据因此取两个**行为量**：
 *   · 片段在时间线上显示的时长必须减半（00:04 → 00:02）；
 *   · 播放头走 1 秒，预览的源时间必须走 2 秒（data-source-time 2.000）。
 * 后者同时钉住"源时间换算"与"playbackRate"两件事：
 * 只做了前者会停在 1.000，只做了后者起点就错。
 *
 * 断言总数恒为 12：找不到 ffmpeg / electron 时逐条 SKIP（不是少跑），
 * verify.mjs 里钉死的数字才有意义。
 *
 * 用法：node tools/speed-ui-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { spawnCapture } from './spawn-capture.mjs'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))
/** profile 目录按 pid 唯一：固定目录名在前一轮异常退出时删不掉，会带着上一轮的设置启动 */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.speed-ui-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 12
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

/** 关掉 Electron：先礼后兵。超时按 pid 强杀进程树 —— 超时是环境属性，不判失败 */
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

const WATCHDOG_MS = Number(process.env.SPEED_UI_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

const sourceTimeOf = (page) =>
  page.evaluate(() => document.querySelector('.wb-player')?.getAttribute('data-source-time') || '')

const clipDurOf = (page) =>
  page.evaluate(() => document.querySelector('.clip[data-clip] .clip-dur')?.textContent?.trim() || '')

const playbackRateOf = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.canvas-frame video')
    return el ? Number(el.playbackRate) : NaN
  })

async function main() {
  console.log('=== 倍速 UI E2E（真影片 + 真点「2x」+ 时间线占位与预览源时间双判据）===\n')

  /* ------------------------------ 素材：ffmpeg 现造 ------------------------------ */

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    check('能找到 ffmpeg', false, '未找到')
    backfillSkips('本机没有 ffmpeg')
    return
  }
  const ffmpeg = found.ffmpeg
  const probe = spawnCapture(ffmpeg, ['-version'], { tag: 'ver' })
  check('ffmpeg 可执行（-version 返回 0）', probe.status === 0, String(probe.stdout || '').split('\n')[0])

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-speed-'))
  const clipA = path.join(work, 'a-red.mp4')
  /* 6 秒：片段占 4 秒、2 倍速要吃掉 4 秒源，留 2 秒余量确保不会被"源不够"夹住 */
  const r1 = spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', clipA],
    { tag: 'mk' }
  )
  const made = fs.existsSync(clipA) && fs.statSync(clipA).size > 1024
  check('测试素材生成完毕（一段 6 秒影片）', made, made ? clipA : String(r1.stdout || '').slice(0, 120))
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

    /* ---------------------- 登记素材 → 写草稿 → 打开 ---------------------- */

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
        name: 'E2E 倍速',
        data: {
          /* ⚠️ media.stat 返回的素材**不带 id**（实测），这里必须显式给一个：
             片段的 assetId 为空时合成器一律退回片段自己的 url（见 composite.js 的
             assetOf）—— 那是防御路径，不是本用例要验的东西，夹具要走在正常路径上。 */
          assets: list.map((item) => ({ ...item, id: 'sp_asset_a' })),
          clips: [
            {
              id: 'sp_a',
              track: 'video',
              assetId: 'sp_asset_a',
              kind: 'video',
              name: list[0].name,
              url: list[0].url,
              path: clipA,
              start: 0,
              duration: 4,
              offset: 0,
              sourceDuration: 6,
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

    /* ------------------------ 选中片段 → 面板出现倍速控件 ------------------------ */

    await page.locator('.clip[data-clip]').first().click()
    await page.waitForSelector('.wb-info-body', { timeout: 10000 })
    await sleep(300)

    /* 2026-10-10：右栏改成参考客户端的**检查器**形制（页签 画面/音频/变速/调整），
       倍速控件住在「变速」页里 —— 先切到那一页再找控件。
       （以前是扁平列表，一选中就全都在。这不是放宽判据，是入口换了位置。） */
    await page.locator('[data-insp-tab="speed"]').click()
    await sleep(200)

    const presets = await page.locator('.wb-speedpresets [data-speed-preset]').count()
    check('选中片段后属性面板出现倍速预设（0.5x / 1x / 2x）', presets === 3, `${presets} 个`)
    const durBefore = await clipDurOf(page)
    /* 2026-10-08：片段头时长改成帧号形制 HH:MM:SS:FF（参照参考客户端的 00:00:43:01），
       旧形制是 00:00:04（十分之一秒）。 */
    check('改之前片段在时间线上占 4 秒', durBefore === '00:00:04:00', durBefore)

    /* ------------------------------ 点「2x」 ------------------------------ */

    await page.locator('.wb-speedpresets [data-speed-preset="2"]').click()
    await sleep(400)

    const durAfter = await clipDurOf(page)
    check(
      '点「2x」后时间线占位减半（00:00:04:00 → 00:00:02:00；吃掉的源素材仍是 4 秒）',
      durAfter === '00:00:02:00',
      `改前 ${durBefore} → 改后 ${durAfter}`
    )

    const badge = await page.locator('.clip[data-clip] [data-clip-speed]').getAttribute('data-clip-speed')
    check('片段上出现倍速角标（原速不显示，避免每段挂个 1x 噪声）', badge === '2', String(badge))

    const rate = await playbackRateOf(page)
    check('预览的 <video> 真的按 2 倍速播（playbackRate = 2）', Math.abs(rate - 2) < 0.001, String(rate))

    /* ------------------ 播放头走 1 秒 ⇒ 源时间必须走 2 秒 ------------------ */

    await page.keyboard.press('Home')
    await sleep(250)
    await page.keyboard.press('Shift+ArrowRight')
    await sleep(350)
    const t1 = await sourceTimeOf(page)
    check(
      '播放头 1.0s → 预览源时间 2.000（源时间按倍速换算，不是原速的 1.000）',
      t1 === '2.000',
      `data-source-time=${t1}`
    )

    const consume = await page.evaluate(
      () => Array.from(document.querySelectorAll('.wb-field')).find((n) => n.textContent.includes('源素材消耗'))?.textContent || ''
    )
    check(
      '面板如实标出「源素材消耗」与时间线占位（4 秒源 / 2 秒时间线）',
      consume.includes('00:00:04') && consume.includes('00:00:02'),
      consume.trim()
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
    /* 收尾不删 profile（Electron 关掉后目录仍被占用，删它会卡死主线程）；
       目录名带 pid、每轮独占，残留不影响下一轮。 */
  }
}

function summary() {
  clearTimeout(watchdog)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`SPEED_UI_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('SPEED_UI_FAILED')
  } else {
    console.log('SPEED_UI_OK')
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
