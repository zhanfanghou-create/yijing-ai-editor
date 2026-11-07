#!/usr/bin/env node
/**
 * 闸门：界面通道的 AI 语音降噪（左栏「音频 → 提取音频」面板里的那个按钮）。
 *
 * ── 为什么要单独一道 ─────────────────────────────────────────────
 * agent 那条路由 `tools/check-mcp-denoise.mjs` 验（共享 speech.js）。但界面上这条路
 * 还有三层别的东西，任一层断了都不会报错：
 *   ① preload 白名单里有没有 `speech.denoise`（漏了 = 点了没反应）；
 *   ② 「就地下载 0.5MB 模型」这条分支 —— 模型没装时点按钮应当自己下，而不是弹一句"请去设置"；
 *   ③ 产物要进素材库（`onAddAsset`），否则处理完了用户找不到文件。
 *
 * ── 判据读消费端 ────────────────────────────────────────────────
 * 不读按钮返回值：模型要看**磁盘上的字节数**、结果要看**提示条文本**、
 * 素材要看**离开这一页之后还能不能找到那条记录**。
 *
 * ⚠️ 全程无窗：`YJAI_NO_WINDOW=1` 由本脚本自己注入（不依赖调起方式），
 *    移屏 + showInactive 的实现在 main/index.js 的 NO_WINDOW 分支。
 *
 * 用法：node tools/check-denoise-ui.mjs
 */
import { execFileSync } from 'node:child_process'
import { reachable } from './net-probe.mjs'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.denoise-ui-${process.pid}`)
const CACHE = path.join(os.tmpdir(), 'yjai-e2e', 'cache')
const WAV = path.join(CACHE, 'speech-zh-0.wav')
const WAV_BYTES = 179646
const WAV_SECONDS = 5.61
const WAV_URLS = [
  'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav',
  'https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav'
]

/** 降噪模型装上后的固定体积（注册表里的硬校验值，必须一模一样） */
const MODEL_BYTES = 535638

/** 固定断言数（改断言必须同步这里与 scripts/verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 8
/** 看门狗：下载 0.5MB + 启动 + 处理 5.6s，给 6 分钟足够 */
const WATCHDOG_MS = 6 * 60 * 1000

let failures = 0
let ran = 0
let aborted = ''

function check(name, ok, detail = '') {
  ran += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  let coverage = 0
  if (ran !== TOTAL_ASSERTIONS) {
    coverage = 1
    console.log(`  [FAIL] 断言覆盖 · 期望 ${TOTAL_ASSERTIONS} 项，实际只跑了 ${ran} 项`)
  }
  const fail = failures + coverage
  const pass = ran - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  console.log(`DENOISE_UI_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail} skip=0`)
  if (!fail && !aborted) console.log('DENOISE_UI_OK')
  return fail === 0 && !aborted
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

function download(urls, dest) {
  return new Promise((resolve, reject) => {
    const go = (list, i) => {
      if (i >= list.length) {
        reject(new Error('所有地址都失败了'))
        return
      }
      const file = fs.createWriteStream(dest)
      https
        .get(list[i], { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close()
            try {
              fs.unlinkSync(dest)
            } catch {
              /* 没生成就算了 */
            }
            go([res.headers.location, ...list.slice(i + 1)], 0)
            return
          }
          if (res.statusCode !== 200) {
            file.close()
            go(list, i + 1)
            return
          }
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
        })
        .on('error', () => {
          file.close()
          go(list, i + 1)
        })
    }
    go(urls, 0)
  })
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
  const file = path.join(PROFILE, 'models', 'speech-denoiser', 'gtcrn_simple.onnx')
  try {
    return fs.statSync(file).size
  } catch {
    return -1
  }
}

async function main() {
  /* ---------- 0. 前置：模型下载源此刻通不通 ----------
   * 这道闸要真下 0.5MB 模型。源不可达时如实跳过，不判红 ——
   * 理由见 tools/net-probe.mjs 顶部（"网络断了"与"功能坏了"长得一样，处置相反）。
   * 2026-11-03 实录：本机直连 github.com 恒不通（连代理也 exit 7），而这道闸报的是
   * "只看到 4 项通过" 这类长得像功能坏了的话 —— 实际是源不可达。
   * 之后已给这个模型加了国内镜像兜底；这里再补一层"不可达就说不可达"。 */
  /* 可用 YJ_PROBE_URL 覆盖（只在验证"跳过分支真的会走"时这样用） */
  const PROBE_URL =
    process.env.YJ_PROBE_URL ||
    'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx'
  if (!(await reachable(PROBE_URL))) {
    console.log('  – 前置探测：降噪模型下载源 15 秒内无响应，本次不验证「下载 → 降噪」这条链路')
    console.log('DENOISE_UI_STATS total=8 pass=0 fail=0 skip=8')
    console.log('DENOISE_UI_SKIPPED 网络不可达（跳过的条目不等于验过，网络恢复后请复跑）')
    process.exit(0)
  }

  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })
  fs.mkdirSync(CACHE, { recursive: true })

  if (!fs.existsSync(WAV) || fs.statSync(WAV).size !== WAV_BYTES) {
    console.log('[denoise-ui] 下载样例音频（175KB）…')
    await download(WAV_URLS, WAV).catch(() => {})
  }
  if (!fs.existsSync(WAV) || fs.statSync(WAV).size !== WAV_BYTES) {
    aborted = '样例音频拿不到'
    return summary()
  }

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    /* 绝不弹窗：用户要能继续干别的 */
    YJAI_NO_WINDOW: '1'
  }
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
    }, WAV)
    if (!mediaUrl) {
      aborted = '样例音频没能登记进白名单'
      return summary()
    }

    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: '降噪闸门',
        data: {
          clips: [
            {
              id: 'c_dn',
              track: 'audio',
              assetId: 'a_dn',
              name: '带噪声的片段',
              kind: 'audio',
              path: WAV,
              url: mediaUrl,
              start: 0,
              duration: WAV_SECONDS,
              offset: 0,
              sourceDuration: WAV_SECONDS
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

    /* ---------- 1. 入口：左栏 音频 → 提取音频 ---------- */
    await page.locator('[data-wb-tab="audio"]').click()
    await sleep(500)
    await page.locator('[data-wb-node="audio-extract"]').click()
    await sleep(700)

    const btn = page.locator('[data-ai-denoise]')
    const visible = await btn.isVisible().catch(() => false)
    const label = (await btn.innerText().catch(() => '')).trim()
    check('1. 「音频 → 提取音频」页里有 AI 降噪按钮', visible, label || '看不到按钮')
    check(
      '2. 模型没装时按钮自己说清"要下 0.5MB"（不是让用户去别处找）',
      /0\.5MB/.test(label),
      `文案：${label}`
    )
    if (!visible) return summary()

    /* 选中片段，否则按钮是禁用的（面板取 selectedClip || activeClip） */
    await page.locator('.clip[data-clip="c_dn"]').click()
    await sleep(400)

    /* ---------- 2. 点它：应当自己下模型 → 自己降噪 ---------- */
    await btn.click()
    /* 等模型真的落盘：判据是磁盘字节数，不是按钮文案。
       ⚠️ 等的同时**必须看提示条**：0.5MB 走 CDN，网络抖一下就失败，而应用这时
       弹的是「降噪模型下载失败」。早先这里盲等 120 秒，等完提示条早就淡出了，
       报出来是「-1 字节 / 只看到：无提示条」—— 看起来像"点了没反应"（UX 坏了），
       实际是"下载失败但说了、只是没人看"。判据要能区分这两件事。 */
    const FAIL_RE = /下载失败|降噪失败|降噪需要|没装好|运行时/
    let landed = -1
    let sawFail = ''
    for (let i = 0; i < 120; i += 1) {
      landed = modelBytes()
      if (landed === MODEL_BYTES) break
      const texts = await page.locator('.toast').allInnerTexts().catch(() => [])
      const bad = texts.find((t) => FAIL_RE.test(t))
      if (bad) {
        sawFail = bad.trim()
        break
      }
      await sleep(1000)
    }
    check(
      '3. 点一下就自己把 0.5MB 降噪模型下载到位（体积与注册表逐字节一致）',
      landed === MODEL_BYTES,
      sawFail ? `${landed} 字节（界面提示：${sawFail}）` : `${landed} 字节`
    )

    /* 等处理完成：**不能只等第一个含「降噪」的提示条** —— 点击时先出现的
       「正在降噪…」里也有「降噪」二字，那样会立刻拿到过程提示就往下走，
       把"处理其实是失败的"当成通过（第一版就这么假绿了）。 */
    let toastText = ''
    let lastSeen = []
    /* 上一段已经看见「下载失败」时不必再空等 90 秒：那 90 秒一定什么都等不到，
       只会把一条明确的错因拖成"超时"。（FAIL_RE 已含下载失败/运行时缺失。） */
    const rounds = sawFail ? 0 : 90
    for (let i = 0; i < rounds; i += 1) {
      const texts = await page.locator('.toast').allInnerTexts().catch(() => [])
      lastSeen = texts
      const hit = texts.find((t) => /已降噪|降噪失败|降噪需要|下载失败/.test(t))
      if (hit) {
        toastText = hit
        break
      }
      await sleep(1000)
    }
    if (sawFail && !toastText) toastText = sawFail
    check('4. 处理完成有明确反馈（提示条里出现「已降噪」）', /已降噪/.test(toastText), toastText || `只看到：${lastSeen.join(' | ') || '无提示条'}`)
    check('5. 反馈里带实测降噪量（dB）—— 否则用户无从判断是真处理了还是原样复制', /约\s*[\d.]+\s*dB/.test(toastText), toastText)

    /* 按钮恢复可点：处理完还挂着 busy 的话，用户会以为没结束 */
    const enabledAgain = await btn.isEnabled().catch(() => false)
    check('6. 处理完按钮恢复可点（不是一直挂在「处理中…」）', enabledAgain)

    /* ---------- 3. 产物进素材库：离开这一页也能找到 ---------- */
    await page.locator('[data-wb-node="audio-music"]').click()
    await sleep(1200)
    const rows = await page.locator('text=· 降噪').count().catch(() => 0)
    check('7. 素材库里真的多了一条「… · 降噪」记录', rows >= 1, `命中 ${rows} 处`)

    check('8. 全程没有页面级报错', errs.length === 0, errs.slice(0, 2).join(' | ') || '干净')
  } finally {
    await closeApp(app)
  }
  return summary()
}

const watchdog = setTimeout(() => {
  console.log(`[denoise-ui] 看门狗触发（${WATCHDOG_MS / 60000} 分钟）`)
  process.exit(1)
}, WATCHDOG_MS)

main()
  .then((ok) => {
    clearTimeout(watchdog)
    process.exit(ok ? 0 : 1)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.log(`[denoise-ui] 崩了：${(err && err.stack) || err}`)
    console.log(`DENOISE_UI_STATS total=${TOTAL_ASSERTIONS} pass=${ran - failures} fail=${TOTAL_ASSERTIONS - (ran - failures)} skip=0`)
    console.log('DENOISE_UI_FAILED')
    process.exit(1)
  })
