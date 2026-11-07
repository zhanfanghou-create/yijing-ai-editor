#!/usr/bin/env node
/**
 * 闸门：界面通道的智能抠像（左栏「素材 → 智能抠像」）。
 *
 * ── 为什么要单独一道 ─────────────────────────────────────────────
 * 抠像的推理在**渲染层**（要 Canvas / WebGL），主进程一行都跑不了。
 * 所以纯 Node 的自测只能验"路径算得对"，验不了"点了到底抠出东西没有"。
 * 这条链路有六层，任一层断了都不会报错：
 *   ① preload 有没有 `matte.runtime/save`（漏了 = 点了没反应）；
 *   ② wasm 与模型有没有登记进 `yjai-media://` 白名单（漏了 = fetch 403，
 *      控制台只有一条 "Failed to load resource"，看起来像文件不存在）；
 *   ③ 模型没装时会不会**就地下载**，而不是弹一句"请去设置"；
 *   ④ 推理出来的 alpha 是不是真的乘上去了（模型跑通也有人忘了乘 mask）；
 *   ⑤ 产物有没有进素材库（不进 = 处理完哪也找不到）；
 *   ⑥ 720p 图会不会被 OOM 或超时（抠像是逐帧的，视频那条更狠）。
 *
 * ── 判据读消费端 ────────────────────────────────────────────────
 * 不看按钮返回什么，也不看推理函数的返回值：
 *   · 模型：读**磁盘上的字节数**（249537，与注册表逐字节一致）；
 *   · 抠没抠干净：把产物 PNG 重新加载进 canvas，**数透明像素**；
 *   · 入没入库：离开这一页之后还能不能在素材列表里找到那条记录。
 *
 * ⚠️ 全程无窗：`YJAI_NO_WINDOW=1` 由本脚本自己注入，移屏 + showInactive，
 *    不抢用户焦点（实现在 main/index.js 的 NO_WINDOW 分支）。
 *
 * 用法：node tools/check-matte-ui.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.matte-ui-${process.pid}`)

/** 测试底图：硬光人像（红墙 / 蓝衣 / 黄条纹），从本地素材包解出（tools/thumb_base 的真源） */
const SRC = writeBase('a')

/** 抠像模型装上后的固定体积（注册表里的硬校验值，必须一模一样） */
const MODEL_BYTES = 249537

/** 固定断言数（改断言必须同步这里与 scripts/verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 9
/** 看门狗：下载 0.25MB + 启动 + 推理，给 5 分钟足够 */
const WATCHDOG_MS = 5 * 60 * 1000

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
    console.log(`[matte-ui] 中止：${aborted}`)
    console.log(`MATTE_UI_STATS total=${TOTAL_ASSERTIONS} pass=0 fail=${TOTAL_ASSERTIONS} skip=0`)
    console.log('MATTE_UI_FAILED')
    return 1
  }
  const pass = ran - failures
  console.log(`\n[matte-ui] ${pass}/${TOTAL_ASSERTIONS} 通过`)
  console.log(`MATTE_UI_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${TOTAL_ASSERTIONS - pass} skip=0`)
  if (failures) console.log('MATTE_UI_FAILED')
  else console.log('MATTE_UI_OK')
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

/** 模型文件的实际体积（-1 = 不存在） */
function modelBytes() {
  const file = path.join(PROFILE, 'models', 'matte-person', 'selfie_segmenter.tflite')
  try {
    return fs.statSync(file).size
  } catch {
    return -1
  }
}

async function main() {
  /* ---------- 0. 前置：模型源此刻通不通 ----------
   * 这道闸要真下 0.25MB 的 selfie_segmenter（来自 storage.googleapis.com）。
   * 源不可达时如实跳过、不判红 —— 理由见 tools/net-probe.mjs 顶部：
   * "网络断了"和"功能坏了"长得一样，处置却相反。 */
  const PROBE_URL =
    process.env.YJ_PROBE_URL ||
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'
  if (!(await reachable(PROBE_URL))) {
    console.log('  – 前置探测：抠像模型下载源 15 秒内无响应，本次不验证「下载 → 抠像」这条链路')
    console.log('MATTE_UI_STATS total=9 pass=0 fail=0 skip=9')
    console.log('MATTE_UI_SKIPPED 网络不可达（跳过的条目不等于验过，网络恢复后请复跑）')
    process.exit(0)
  }

  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })

  if (!fs.existsSync(SRC)) {
    aborted = `测试底图不在：${SRC}`
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
    }, SRC)
    if (!mediaUrl) {
      aborted = '测试底图没能登记进白名单'
      return summary()
    }

    /* 建一个只有一张图片的草稿：抠像面板取 selectedClip，所以必须真的有片段 */
    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: '抠像闸门',
        data: {
          clips: [
            {
              id: 'c_matte',
              track: 'video',
              assetId: 'a_matte',
              name: 'hardlight',
              kind: 'image',
              path: SRC,
              url: mediaUrl,
              start: 0,
              duration: 4,
              offset: 0,
              sourceDuration: 4
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

    /* ---------- 1. 入口在左栏「素材 → 智能抠像」 ---------- */
    await page.locator('[data-wb-tab="media"]').click()
    await sleep(500)
    await page.locator('[data-wb-node="matte"]').click()
    await sleep(700)

    const btn = page.locator('[data-matte-run]')
    const visible = await btn.isVisible().catch(() => false)
    check('1. 「素材 → 智能抠像」面板打得开、里面有抠像按钮', visible)
    if (!visible) return summary()

    const label = (await btn.innerText().catch(() => '')).trim()
    check(
      '2. 模型没装时按钮自己说清要下 0.25MB（不是让用户去别处找）',
      /0\.25MB/.test(label),
      `文案：${label || '（空）'}`
    )

    /* 选中片段：面板取 selectedClip || activeClip，不选就是禁用 */
    await page.locator('.clip[data-clip="c_matte"]').click()
    await sleep(400)

    /* ---------- 2. 点它：自己下模型 → 自己抠 ---------- */
    await btn.click()
    let landed = -1
    for (let i = 0; i < 120; i += 1) {
      landed = modelBytes()
      if (landed === MODEL_BYTES) break
      await sleep(1000)
    }
    check(
      '3. 点一下就自己把 0.25MB 抠像模型下载到位（体积与注册表逐字节一致）',
      landed === MODEL_BYTES,
      `${landed} 字节`
    )

    /* 等完成提示：**不能只匹配「抠」字** —— 点击瞬间会有「正在下载抠像模型」，
       那样会立刻命中过程文案就往下判，把失败当通过。必须匹配终态词。 */
    let toastText = ''
    let lastSeen = []
    for (let i = 0; i < 120; i += 1) {
      const texts = await page.locator('.toast').allInnerTexts().catch(() => [])
      lastSeen = texts
      const hit = texts.find((t) => /已抠像|抠不出主体|抠像失败|抠像模型下载失败/.test(t))
      if (hit) {
        toastText = hit
        break
      }
      await sleep(1000)
    }
    check('4. 处理完有明确反馈（提示条里出现「已抠像」）', /已抠像/.test(toastText), toastText || `只看到：${lastSeen.join(' | ') || '无提示条'}`)
    check(
      '5. 反馈里带实测主体占比 —— 否则用户无从判断是真抠到了还是抠了个空',
      /主体占\s*\d+%/.test(toastText) && !/主体占\s*0%/.test(toastText),
      toastText
    )

    const enabledAgain = await btn.isEnabled().catch(() => false)
    check('6. 处理完按钮恢复可点（不是一直挂在「处理中…」）', enabledAgain)

    /* ---------- 3. 产物进素材库：离开这一页也能找到 ---------- */
    await page.locator('[data-wb-node="stock"]').click()
    await sleep(1200)
    const rows = await page.locator('text=· 抠像').count().catch(() => 0)
    check('7. 素材库里真的多了一条「… · 抠像」记录', rows >= 1, `命中 ${rows} 处`)

    /* ---------- 4. 产物真的是透明的（读像素，不看返回值） ---------- */
    /* 产物路径在 <profile>/matte 下，从磁盘直接找最新那一个，
       再让渲染层把它读进 canvas 数像素 —— 判据落在"用户眼睛能看到的东西"上。 */
    const matteDir = path.join(PROFILE, 'matte')
    let newest = ''
    try {
      const files = fs
        .readdirSync(matteDir)
        .filter((n) => n.endsWith('.png'))
        .map((n) => ({ n, t: fs.statSync(path.join(matteDir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      newest = files.length ? path.join(matteDir, files[0].n) : ''
    } catch {
      newest = ''
    }

    let stat = null
    if (newest) {
      const outUrl = await page.evaluate(async (file) => {
        await window.yjai.media.stat([file])
        return window.yjai.media.url(file)
      }, newest)
      if (outUrl) {
        stat = await page.evaluate(async (url) => {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.src = url
          await img.decode()
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(img, 0, 0)
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          let clearPx = 0
          let solidPx = 0
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 8) clearPx += 1
            else if (data[i] > 247) solidPx += 1
          }
          return {
            w: canvas.width,
            h: canvas.height,
            total: canvas.width * canvas.height,
            clearPx,
            solidPx
          }
        }, outUrl)
      }
    }

    const clearRatio = stat ? stat.clearPx / stat.total : 0
    const solidRatio = stat ? stat.solidPx / stat.total : 0
    check(
      '8. 产物真的是透明的：背景被清空、主体还在（读 PNG 的 alpha 通道）',
      Boolean(stat) &&
        stat.w >= 300 &&
        clearRatio > 0.1 &&
        clearRatio < 0.95 &&
        solidRatio > 0.1,
      stat
        ? `${stat.w}×${stat.h} · 透明 ${(clearRatio * 100).toFixed(1)}% · 实心 ${(solidRatio * 100).toFixed(1)}%`
        : `找不到产物 PNG（${newest || matteDir}）`
    )

    check('9. 全程没有页面级报错', errs.length === 0, errs.slice(0, 2).join(' | ') || '干净')
  } finally {
    await closeApp(app)
  }
  return summary()
}

const watchdog = setTimeout(() => {
  console.log(`[matte-ui] 看门狗触发（${WATCHDOG_MS / 60000} 分钟）`)
  process.exit(1)
}, WATCHDOG_MS)

main()
  .then((code) => {
    clearTimeout(watchdog)
    process.exit(code)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.log(`[matte-ui] 崩了：${(err && err.stack) || err}`)
    console.log(`MATTE_UI_STATS total=${TOTAL_ASSERTIONS} pass=${ran - failures} fail=${TOTAL_ASSERTIONS - (ran - failures)}`)
    console.log('MATTE_UI_FAILED')
    process.exit(1)
  })
