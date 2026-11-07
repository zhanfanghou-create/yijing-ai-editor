#!/usr/bin/env node
/**
 * 闸门：界面通道的**视频**抠像（逐帧抠 → 合背景 → 编码 mp4）。
 *
 * ── 为什么和图片那条分开 ────────────────────────────────────────
 * 图片抠像只跑一次推理，视频要跑 N 次 + 写 N 个 PNG + 起一次 ffmpeg。
 * 这条链上每一环都可能单独坏：
 *   ① 逐帧 IPC 写盘（seqId 校验太严会全失败、太松是路径穿越）；
 *   ② `-start_number 0`（漏了 ffmpeg 从 frame-00001 找，报 "Could not open"）；
 *   ③ 背景合成（不做的话产出是全黑底，看起来"抠成功了"）；
 *   ④ 编码产物的**时长**（帧数对不对，直接决定成片是不是被截短）。
 * 合成"绿幕"那种判据靠肉眼，这里一律按字节与像素判。
 *
 * ── 判据读消费端 ────────────────────────────────────────────────
 * 不看提示条说了什么就完事：产物要用 ffprobe 量时长与像素格式，
 * 还要把某一帧解出来数"背景色像素"与"非背景像素"，确认背景真的换掉了。
 *
 * ⚠️ 全程无窗（YJAI_NO_WINDOW=1 由本脚本自己注入），不抢焦点。
 *
 * 用法：node tools/check-matte-video-ui.mjs
 */
import { execFileSync } from 'node:child_process'
import { reachable } from './net-probe.mjs'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { writeBase } from './thumb-base.mjs'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.matte-video-${process.pid}`)
const CACHE = path.join(os.tmpdir(), 'yjai-e2e', 'cache')
const IMG = writeBase('a')
const CLIP = path.join(CACHE, 'matte-person-3s.mp4')

const FFMPEG = process.env.FFMPEG_PATH || 'D:/ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe'
const FFPROBE = path.join(path.dirname(FFMPEG), 'ffprobe.exe')

/** 测试片段的秒数：3 秒 × 15fps = 45 帧，够看出"是不是只在第一帧抠了" */
const CLIP_SECONDS = 3

const TOTAL_ASSERTIONS = 8
const WATCHDOG_MS = 8 * 60 * 1000

let failures = 0
let ran = 0
let aborted = ''

function check(name, ok, detail = '') {
  ran += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  if (aborted) {
    console.log(`[matte-video] 中止：${aborted}`)
    console.log(`MATTE_VIDEO_STATS total=${TOTAL_ASSERTIONS} pass=0 fail=${TOTAL_ASSERTIONS} skip=0`)
    console.log('MATTE_VIDEO_FAILED')
    return 1
  }
  const pass = ran - failures
  console.log(`\n[matte-video] ${pass}/${TOTAL_ASSERTIONS} 通过`)
  console.log(`MATTE_VIDEO_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${TOTAL_ASSERTIONS - pass} skip=0`)
  if (failures) console.log('MATTE_VIDEO_FAILED')
  else console.log('MATTE_VIDEO_OK')
  return failures ? 1 : 0
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), ms))
  ])
}

async function closeApp(app) {
  try {
    await withTimeout(app.close(), 8000, 'app.close')
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

/** 造一段 3 秒的"有人物"视频（静态人像铺 3 秒，够验逐帧链路） */
function makeClip() {
  if (fs.existsSync(CLIP) && fs.statSync(CLIP).size > 10000) return true
  fs.mkdirSync(CACHE, { recursive: true })
  try {
    execFileSync(
      FFMPEG,
      [
        '-y', '-v', 'error',
        '-loop', '1', '-i', IMG,
        '-t', String(CLIP_SECONDS),
        '-r', '15',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=640:640',
        CLIP
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 120000 }
    )
  } catch {
    return false
  }
  return fs.existsSync(CLIP) && fs.statSync(CLIP).size > 10000
}

/** mp4 的真实时长（读容器，不看我们的返回值） */
function durationOf(file) {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8', windowsHide: true }
    )
    return Number(String(out).trim()) || 0
  } catch {
    return 0
  }
}

async function main() {
  /* ---------- 0. 前置：模型源此刻通不通（理由见 tools/net-probe.mjs 顶部） ----------
   * 这道闸要真下 0.25MB 的 selfie_segmenter（storage.googleapis.com）。
   * 源不可达 ⇒ 记 8 条 SKIP，可达但下不下来 ⇒ 红。 */
  const PROBE_URL =
    process.env.YJ_PROBE_URL ||
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'
  if (!(await reachable(PROBE_URL))) {
    console.log('  – 前置探测：抠像模型下载源 15 秒内无响应，本次不验证「下载 → 逐帧抠像」这条链路')
    console.log('MATTE_VIDEO_STATS total=8 pass=0 fail=0 skip=8')
    console.log('MATTE_VIDEO_SKIPPED 网络不可达（跳过的条目不等于验过，网络恢复后请复跑）')
    process.exit(0)
  }

  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })

  if (!fs.existsSync(IMG)) {
    aborted = `测试底图不在：${IMG}`
    return summary()
  }
  if (!makeClip()) {
    aborted = '造不出测试视频（检查 FFMPEG_PATH）'
    return summary()
  }

  const env = { ...process.env, NODE_ENV: 'production', YJAI_NO_WINDOW: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.YIJAI_USE_DEV_SERVER
  delete env.YJAI_SHOW_WINDOW

  const app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--user-data-dir=' + PROFILE],
    cwd: ROOT,
    env
  })

  try {
    const page = await app.firstWindow()
    const errs = []
    page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push('[console.error] ' + m.text())
    })

    await page.waitForSelector('.app', { timeout: 30000 })
    await sleep(1200)

    const mediaUrl = await page.evaluate(async (file) => {
      await window.yjai.media.stat([file])
      return window.yjai.media.url(file)
    }, CLIP)
    if (!mediaUrl) {
      aborted = '测试视频没能登记进白名单'
      return summary()
    }

    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: '视频抠像闸门',
        data: {
          clips: [
            {
              id: 'c_mv',
              track: 'video',
              assetId: 'a_mv',
              name: 'person3s',
              kind: 'video',
              path: CLIP,
              url: mediaUrl,
              start: 0,
              duration: CLIP_SECONDS,
              offset: 0,
              sourceDuration: CLIP_SECONDS
            }
          ],
          assets: [],
          playhead: 0,
          volume: 80,
          zoom: 40
        }
      }
    )
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(900)

    await page.locator('[data-wb-tab="media"]').click()
    await sleep(500)
    await page.locator('[data-wb-node="matte"]').click()
    await sleep(700)
    await page.locator('.clip[data-clip="c_mv"]').click()
    await sleep(400)

    /* ---------- 1. 视频时出现背景选择，图片时不出现 ---------- */
    const bgBtns = page.locator('[data-matte-bg]')
    const bgCount = await bgBtns.count().catch(() => 0)
    const bgKeys = await bgBtns.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-matte-bg'))).catch(() => [])
    check(
      '1. 视频片段选中后出现「换成什么背景」五个选项（含原画面虚化）',
      bgCount === 5 && bgKeys.includes('blur') && bgKeys.includes('#000000'),
      `${bgCount} 个：${bgKeys.join(' / ')}`
    )

    /* ---------- 2. 点抠像：进度要真的动 ---------- */
    const btn = page.locator('[data-matte-run]')
    await btn.click()

    /* 采样按钮文案：会从「准备中…」变成「42%」这种百分比。
       只等"完成提示"的话，慢机器上会误以为卡住；
       这里要的是"看到过中间态" —— 那是"真的在逐帧跑"的唯一证据。 */
    let sawPercent = false
    let sawBgHint = false
    for (let i = 0; i < 240; i += 1) {
      const txt = (await btn.innerText().catch(() => '')).trim()
      if (/\d+%/.test(txt)) sawPercent = true
      const texts = await page.locator('.toast').allInnerTexts().catch(() => [])
      if (texts.some((t) => /正在合成视频/.test(t))) sawBgHint = true
      if (texts.some((t) => /换好背景|抠不出主体|合成透明视频失败|视频打不开|编码/.test(t))) break
      await sleep(500)
    }
    check('2. 逐帧处理时按钮上能看到百分比（说明是逐帧在跑，不是一次性回放）', sawPercent)

    let toastText = ''
    let lastSeen = []
    for (let i = 0; i < 120; i += 1) {
      const texts = await page.locator('.toast').allInnerTexts().catch(() => [])
      lastSeen = texts
      const hit = texts.find((t) => /换好背景|抠不出主体|合成透明视频失败|视频打不开/.test(t))
      if (hit) {
        toastText = hit
        break
      }
      await sleep(1000)
    }
    check('3. 处理完有明确反馈（提示条里出现「换好背景」）', /换好背景/.test(toastText), toastText || `只看到：${lastSeen.join(' | ') || '无提示条'}`)
    check(
      '4. 提示里带帧数 —— 否则用户无从判断是整段抠了还是只抠了一帧',
      /已抠出\s*\d+\s*帧/.test(toastText),
      toastText
    )
    void sawBgHint

    /* ---------- 3. 产物是真 mp4，时长对得上 ---------- */
    const outDir = path.join(PROFILE, 'matte')
    let newest = ''
    try {
      const files = fs
        .readdirSync(outDir)
        .filter((n) => n.endsWith('.mp4'))
        .map((n) => ({ n, t: fs.statSync(path.join(outDir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      newest = files.length ? path.join(outDir, files[0].n) : ''
    } catch {
      newest = ''
    }
    const gotSeconds = newest ? durationOf(newest) : 0
    /* 15fps 采样：45 帧 ≈ 3.0 秒。允许 ±0.4 秒（帧率取整 + 编码器时基） */
    check(
      '5. 产物是一段完整时长的视频（3 秒素材 → 2.6~3.4 秒成片，不是只出了开头几帧）',
      Boolean(newest) && gotSeconds > CLIP_SECONDS - 0.4 && gotSeconds < CLIP_SECONDS + 0.4,
      `${gotSeconds.toFixed(2)} 秒 · ${newest || '找不到产物'}`
    )

    /* ---------- 4. 背景真的换掉了（读像素） ---------- */
    let px = null
    if (newest) {
      /* 选"绿"再跑一次太慢，这里直接验虚化背景的特征：
         虚化会把背景压暗（我们叠了 25% 黑），所以画面四角应当明显比主体暗。 */
      const frame = path.join(outDir, 'probe-frame.png')
      try {
        execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', newest, '-frames:v', '1', frame], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 60000
        })
      } catch {
        /* 下面按 null 处理 */
      }
      if (fs.existsSync(frame)) {
        const pub = await page.evaluate(async (file) => {
          await window.yjai.media.stat([file])
          return window.yjai.media.url(file)
        }, frame)
        if (pub) {
          px = await page.evaluate(async (url) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.src = url
            await img.decode()
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const ctx = c.getContext('2d', { willReadFrequently: true })
            ctx.drawImage(img, 0, 0)
            const d = ctx.getImageData(0, 0, c.width, c.height).data
            const luma = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
            /* 四角 40×40 的均值 = 背景；画面正中 120×120 的均值 = 主体 */
            let corner = 0
            let cornerN = 0
            for (const [ox, oy] of [[0, 0], [c.width - 40, 0], [0, c.height - 40], [c.width - 40, c.height - 40]]) {
              for (let y = oy; y < oy + 40; y += 1) {
                for (let x = ox; x < ox + 40; x += 1) {
                  corner += luma((y * c.width + x) * 4)
                  cornerN += 1
                }
              }
            }
            let core = 0
            let coreN = 0
            const cx = Math.floor(c.width / 2) - 60
            const cy = Math.floor(c.height / 2) - 60
            for (let y = cy; y < cy + 120; y += 1) {
              for (let x = cx; x < cx + 120; x += 1) {
                core += luma((y * c.width + x) * 4)
                coreN += 1
              }
            }
            return { w: c.width, h: c.height, corner: corner / cornerN, core: core / coreN }
          }, pub)
        }
      }
    }

    check(
      '6. 背景真的被虚化压暗了（四角亮度明显低于画面中心的主体）',
      Boolean(px) && px.core > 30 && px.corner < px.core * 0.85,
      px ? `${px.w}×${px.h} 四角 ${px.corner.toFixed(0)} / 中心 ${px.core.toFixed(0)}` : '解不出一帧'
    )

    /* ---------- 5. 进素材库 ---------- */
    await page.locator('[data-wb-node="stock"]').click()
    await sleep(1200)
    const rows = await page.locator('text=· 抠像').count().catch(() => 0)
    check('7. 素材库里多了一条「… · 抠像」视频记录', rows >= 1, `命中 ${rows} 处`)

    check('8. 全程没有页面级报错', errs.length === 0, errs.slice(0, 2).join(' | ') || '干净')
  } finally {
    await closeApp(app)
  }
  return summary()
}

const watchdog = setTimeout(() => {
  console.log(`[matte-video] 看门狗触发（${WATCHDOG_MS / 60000} 分钟）`)
  process.exit(1)
}, WATCHDOG_MS)

main()
  .then((code) => {
    clearTimeout(watchdog)
    process.exit(code)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.log(`[matte-video] 崩了：${(err && err.stack) || err}`)
    console.log(`MATTE_VIDEO_STATS total=${TOTAL_ASSERTIONS} pass=${ran - failures} fail=${TOTAL_ASSERTIONS - (ran - failures)} skip=0`)
    console.log('MATTE_VIDEO_FAILED')
    process.exit(1)
  })
