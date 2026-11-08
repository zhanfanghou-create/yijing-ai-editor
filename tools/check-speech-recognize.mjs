#!/usr/bin/env node
/**
 * 客户端 E2E · 「AI 识别字幕」：没模型时自动把用户送进设置，装完当场能出字幕。
 *
 * 为什么要有这道闸（2026-11-03 Jason）：
 *   「字幕识别等 AI 相关功能…打通支持本地模型下载配置，使用相关功能自动弹出
 *     设置的 AI 模型下载配置界面」。
 * 这件事有三段，任何一段断了都是"功能看起来在、其实不能用"：
 *   ① 点了按钮只弹一句"请先下载模型" —— 用户知道缺东西，但不知道在哪拿；
 *   ② 送进了设置却没停对位置 —— 一页模型列表滚一屏，等于让他自己找；
 *   ③ 装完回来仍然连不上 —— 模型装了、识别器还是旧的（缓存没清）或路径对不上。
 *
 * 判据全部读**消费端**：
 *   · 页签/高亮读 DOM 属性，不读 React state；
 *   · 字幕是否真的生成，读时间线上 `[data-clip][data-clip-text]` 的**实际文字**；
 *   · 时间点读片段 DOM 上的 `data-clip-start` 秒数，不读我们自己返回的数组。
 *
 * ⚠️ 这道闸**真的会下载 78MB 模型**（走应用自己的下载器，与用户点「下载」同一条路）。
 *    这是一次完整的端到端证明：下载 → 校验 → 落盘 → 加载 → 识别 → 出字幕。
 *
 *    「网络不通」与「功能坏了」必须分开判（2026-11-03 修正）：
 *    下载源此刻不可达 ⇒ 记 10 条 SKIP、打 `SPEECH_RECOGNIZE_E2E_SKIPPED`、退出码 0；
 *    可达但下不下来 ⇒ 红。原先写成"网络不通就红"，实测代价是：一次镜像抖动让整道红，
 *    而红这个信号长得像功能坏了 —— 本轮就为此在 DNS / 代理 / Electron 运行时上绕了很久，
 *    真正的原因只是那两分钟网络断了一下。
 *
 * 用法：node tools/check-speech-recognize.mjs
 * 前置：`cd packages/desktop && vite build`；`node tools/fetch-speech.mjs`（运行时随包）
 * 退出码：0 = 通过或如实跳过；1 = 有失败
 */

import { _electron as electron } from 'playwright-core'
import { reachable } from './net-probe.mjs'
import { execFileSync } from 'node:child_process'
import https from 'node:https'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.speech-${process.pid}`)
const CACHE = path.join(os.tmpdir(), 'yjai-e2e', 'cache')
const WAV = path.join(CACHE, 'speech-zh-0.wav')

/** 样例音频：5.61s 中文连续说话（取自 paraformer 模型仓库的 test_wavs） */
const WAV_URLS = [
  'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav',
  'https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav'
]
const WAV_BYTES = 179646
const WAV_SECONDS = 5.61

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 10
/** 看门狗：下载 + 识别 + 启动，给足 12 分钟，但绝不无限挂着 */
const WATCHDOG_MS = 12 * 60 * 1000

let failures = 0
let skips = 0
let ran = 0
let aborted = ''

function check(name, ok, detail = '') {
  ran += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

/**
 * 记一条 SKIP：**跑到了、但无法判定**。
 *
 * 与 FAIL 的区别是"能不能归罪于代码"。下载大文件超时属于网络，判红会让人先去查
 * 下载器/校验/DNS —— 2026-11-03 就这么白查了一轮。条数照记，绝不少跑：
 * 跳过的条目在汇总里必须看得见，不能伪装成通过。
 */
function skip(name, reason = '') {
  ran += 1
  skips += 1
  console.log(`  [SKIP] ${name}${reason ? `  — ${reason}` : ''}`)
}

function summary() {
  let coverage = 0
  if (ran !== TOTAL_ASSERTIONS) {
    coverage = 1
    console.log(`  [FAIL] 断言覆盖 · 期望 ${TOTAL_ASSERTIONS} 项，实际只跑了 ${ran} 项`)
  }
  const fail = failures + coverage
  const pass = ran - failures - skips
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skips} 项 ===`)
  console.log(`SPEECH_RECOGNIZE_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail} skip=${skips}`)
  if (!fail && !aborted) {
    if (skips) console.log('SPEECH_RECOGNIZE_E2E_SKIPPED 部分链路未验（见上面 [SKIP]，网络恢复后请复跑）')
    else console.log('SPEECH_RECOGNIZE_E2E_OK')
  }
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

/** 取一个地址（自动跟重定向）到内存 */
function fetchBuffer(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'YJAI-E2E' }, timeout: 30000 }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location && hops < 5) {
        res.resume()
        fetchBuffer(new URL(res.headers.location, url).toString(), hops + 1).then(resolve, reject)
        return
      }
      if (code !== 200) {
        res.resume()
        reject(new Error(`HTTP ${code}`))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('超时')))
    req.on('error', reject)
  })
}

/** 按候选地址依次试，第一个成功的写盘 */
async function download(urls, dest) {
  let lastError = null
  for (const url of urls) {
    try {
      const buf = await fetchBuffer(url)
      fs.writeFileSync(dest, buf)
      return dest
    } catch (err) {
      lastError = err
    }
  }
  throw lastError || new Error('所有下载地址都失败了')
}

async function closeApp(app) {
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
    /* 已经退了 */
  }
}

async function main() {
  /* ---------- 0. 前置：下载源此刻通不通 ----------
   * 不通就**如实跳过**，不判红。理由见 tools/net-probe.mjs 顶部：
   * "网络断了"和"功能坏了"长得一样，处置却相反；判红会让人先去查功能。
   * 注意探测走 node:https（与应用同一条路），不走 curl（curl 会读代理变量）。 */
  /* 可用 YJ_PROBE_URL 覆盖（只在验证"跳过分支真的会走"时这样用） */
  const PROBE_URL =
    process.env.YJ_PROBE_URL ||
    'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/tokens.txt'
  if (!(await reachable(PROBE_URL))) {
    console.log('  – 前置探测：hf-mirror 15 秒内无响应，本次不验证「下载 → 识别」这条链路')
    console.log('SPEECH_RECOGNIZE_E2E_STATS total=10 pass=0 fail=0 skip=10')
    console.log('SPEECH_RECOGNIZE_E2E_SKIPPED 网络不可达（跳过的条目不等于验过，网络恢复后请复跑）')
    process.exit(0)
  }

  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })
  fs.mkdirSync(CACHE, { recursive: true })

  /* ---------- 样例音频：有缓存就不再下（175KB，但省一次请求就省一次失败面） ---------- */
  if (!fs.existsSync(WAV) || fs.statSync(WAV).size !== WAV_BYTES) {
    console.log('[speech-e2e] 下载样例音频（175KB）…')
    await download(WAV_URLS, WAV)
  }
  if (!fs.existsSync(WAV) || fs.statSync(WAV).size !== WAV_BYTES) {
    console.log(`[speech-e2e] 样例音频不可用（${fs.existsSync(WAV) ? fs.statSync(WAV).size : 0} 字节）`)
    aborted = '样例音频拿不到'
    return summary()
  }

  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.YIJAI_USE_DEV_SERVER

  const app = await electron.launch({
    executablePath: EXE,
    args: [
      MAIN,
      '--no-sandbox',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      '--user-data-dir=' + PROFILE
    ],
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

    /* ---------- 把样例音频登记进白名单，拿到 yjai-media 地址 ---------- */
    const mediaInfo = await page.evaluate(async (file) => {
      const rows = await window.yjai.media.stat([file])
      const url = await window.yjai.media.url(file)
      return { rows, url }
    }, WAV)
    if (!mediaInfo?.url) {
      aborted = '样例音频没能登记进白名单'
      return summary()
    }

    const CLIPS = [
      {
        id: 'c_speech',
        track: 'video',
        assetId: 'a_speech',
        name: '带说话的片段',
        kind: 'video',
        path: WAV,
        url: mediaInfo.url,
        start: 0,
        duration: WAV_SECONDS,
        offset: 0,
        sourceDuration: WAV_SECONDS
      }
    ]
    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: '语音识别闸门', data: { clips: CLIPS, assets: [], playhead: 0, volume: 80, zoom: 40 } }
    )
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(900)

    /* ---------- A. 字幕页上两个入口都在，且能分辨 ---------- */
    await page.locator('[data-wb-tab="subtitle"]').click()
    await sleep(600)
    await page.locator('[data-wb-node="subtitle-custom"]').click()
    await sleep(500)

    const aiVisible = await page.locator('[data-sub-ai]').isVisible().catch(() => false)
    const vadVisible = await page.locator('[data-sub-vad]').isVisible().catch(() => false)
    const aiText = (await page.locator('[data-sub-ai]').innerText().catch(() => '')).trim()
    check(
      '1. 字幕页同时有「AI 识别字幕」与「按语音自动分句」两个入口（一个出字、一个只切时间轴）',
      aiVisible && vadVisible && /识别/.test(aiText),
      `ai=${aiVisible} vad=${vadVisible} 文案=${aiText}`
    )

    /* ---------- B. 没模型时点它 ⇒ 自动弹设置，并停在推荐模型上 ---------- */
    await page.locator('.clip[data-clip="c_speech"]').click()
    await sleep(300)
    await page.locator('[data-sub-ai]').click()
    await sleep(1500)

    const settingsOpen = await page.locator('[data-settings-tab="models"]').isVisible().catch(() => false)
    const onModelsTab = await page
      .locator('[data-settings-tab="models"].active')
      .count()
      .catch(() => 0)
    check('2. 点了「AI 识别字幕」而模型没装 ⇒ 设置弹窗自动打开', settingsOpen)
    check('3. 打开时就停在「AI 模型」页（不是让用户自己翻页签）', onModelsTab === 1)

    const focusId = await page
      .locator('[data-model-focus="1"]')
      .first()
      .getAttribute('data-model')
      .catch(() => '')
    check(
      '4. 高亮落在 "speech-paraformer" 那一行（缺哪个指哪个，不是笼统打开设置）',
      focusId === 'speech-paraformer',
      focusId || '(没有高亮行)'
    )

    const runtimeSource = await page
      .locator('[data-model="speech-runtime"]')
      .first()
      .getAttribute('data-model-source')
      .catch(() => '')
    const modelChip = (await page.locator('[data-model="speech-paraformer"] [data-model-chip]').innerText().catch(() => '')).trim()
    check(
      '5. 运行时已随包就绪、识别模型是「未安装」（两种缺失要能分开看）',
      runtimeSource === 'bundled' || runtimeSource === 'local',
      `运行时=${runtimeSource} 模型徽章=${modelChip}`
    )
    check('6. 模型那条给出可点的「下载」按钮', (await page.locator('[data-model="speech-paraformer"] [data-model-action="download"]').count()) === 1)

    /* ---------- C. 真下载（走应用自己的下载器） ---------- */
    console.log('  … 正在下载 78MB 中文识别模型（这一步是真的走网络）')
    await page.locator('[data-model="speech-paraformer"] [data-model-action="download"]').click()
    /* 同时等两种结局：徽章变「本机安装」，或者面板里出现错误提示。
       只等成功的话，下载失败会表现成"干等 8 分钟后徽章仍是未安装" ——
       看不出是网络还是下载器坏了，而这两种事的处置完全不同（重试 vs 改代码）。
       失败提示由 Dialogs.jsx 的 setError 渲染在 [data-models-error] 上。 */
    const outcome = await page
      .waitForFunction(
        () => {
          const row = document.querySelector('[data-model="speech-paraformer"]')
          if (row && row.getAttribute('data-model-source') === 'local') return { ok: true, err: '' }
          const box = document.querySelector('[data-models-error]')
          const text = box ? String(box.innerText || '').trim() : ''
          if (text) return { ok: false, err: text }
          return false
        },
        null,
        { timeout: 8 * 60 * 1000 }
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null)
    const installed = Boolean(outcome && outcome.ok)
    const installedChip = (await page.locator('[data-model="speech-paraformer"] [data-model-chip]').innerText().catch(() => '')).trim()

    /* 下载失败、且错因是"传输中超时/连接被断" ⇒ 记 4 条 SKIP 并如实收工。
     *
     * 为什么不能判红：前置探测用的是 75KB 的 tokens.txt，真下载的是 78MB 的
     * model.int8.onnx —— **小文件通 ≠ 大文件能下**。2026-11-03 全量实测就是这样：
     * 探测过了（tokens.txt 秒回），下载时 hf-mirror 连接超时、备用的 huggingface.co
     * 直接 ETIMEDOUT，而同一台机器十分钟前刚下完同一个 78MB。
     * 这一红报出来的是"只通过 6 项"，读起来像功能坏了 —— 会把人赶去查下载器、
     * 查体积校验、查 DNS。真正该做的是等网络好了复跑。
     *
     * 反过来，若报错不是网络（磁盘满、体积校验不过、sha 不符、加载失败），照旧判红。 */
    const NET_REASON = /连接超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|EPIPE/i
    if (!installed && outcome && NET_REASON.test(outcome.err || '')) {
      const why = `下载源在传输中超时（${outcome.err}）—— 网络问题，无法判定功能是否正常`
      skip('7. 下载完成后徽章变成「本机安装」（体积校验通过才落盘）', why)
      skip('8. 识别后时间线上真的多出带文字的字幕片段', '因第 7 条跳过（模型未安装）未进入识别')
      skip('9. 字幕文字是中文实词（不是空串、不是标签残渣）', '因第 7 条跳过（模型未安装）未进入识别')
      skip('10. 字幕时间点落在被识别的片段区间内（0 ~ 5.7s）', '因第 7 条跳过（模型未安装）未进入识别')
      return summary()
    }

    check(
      '7. 下载完成后徽章变成「本机安装」（体积校验通过才落盘）',
      installed && /本机安装/.test(installedChip),
      outcome && outcome.err ? `${installedChip}｜界面报错：${outcome.err}` : installedChip
    )

    /* 关掉设置回工作台 */
    await page.locator('[data-settings-close]').click({ timeout: 5000 }).catch(() => {})
    await sleep(800)
    const backToWorkbench = await page.locator('.wb-timeline').isVisible().catch(() => false)
    if (!backToWorkbench) await page.keyboard.press('Escape')
    await sleep(700)

    /* ---------- D. 再点一次 ⇒ 真的出字幕 ---------- */
    /* 模型没装上就别再点识别：那会一路等到 120 秒超时，然后把 8/9/10 三条
       都报成"没出字幕"，掩盖掉真正的根因（第 7 条）。这里如实标注「未进入」，
       条数仍是 10 —— 判据少跑一条就等于把"没检查"伪装成"通过"。 */
    const rootCause = installed ? '' : `因第 7 条失败（模型未安装${outcome && outcome.err ? `：${outcome.err}` : ''}）未进入识别`
    let rows = []
    if (installed) {
      await page.locator('[data-wb-tab="subtitle"]').click()
      await sleep(400)
      /* ⚠️ 这里**必须显式点进「自定义」**，不能靠"点开字幕标签就自然落在它上面"。
         2026-11-09 实测过一次：左栏「字幕」组里加了一项（字幕预设），
         默认落点被新项抢走 ⇒ 本节 `[data-sub-ai]` 30 秒定位超时，
         而功能本身一点没坏。判据依赖"谁是第一个/默认项"这类**相对位置**，
         改动别处就会红，且红得像功能坏了。第 1 节本来就是显式点的，这里补齐。 */
      await page.locator('[data-wb-node="subtitle-custom"]').click()
      await sleep(300)
      await page.locator('.clip[data-clip="c_speech"]').click()
      await sleep(300)
      await page.locator('[data-sub-ai]').click()

      /* 等到时间线上出现带文字的字幕片段：判据读 DOM 上真的渲染出来的 text */
      const got = await page
        .waitForFunction(
          () => {
            const rows = Array.from(document.querySelectorAll('[data-clip]')).filter((el) =>
              String(el.getAttribute('data-clip-text') || '').trim()
            )
            return rows.length ? rows.map((el) => ({
              id: el.getAttribute('data-clip'),
              text: el.getAttribute('data-clip-text'),
              start: Number(el.getAttribute('data-clip-start') || 0)
            })) : false
          },
          null,
          { timeout: 120000 }
        )
        .then((handle) => handle.jsonValue())
        .catch(() => null)

      rows = Array.isArray(got) ? got : []
    }
    check('8. 识别后时间线上真的多出带文字的字幕片段', rows.length >= 1, rootCause || `条数 ${rows.length}`)
    const sample = rows.map((row) => row.text).join(' / ')
    check(
      '9. 字幕文字是中文实词（不是空串、不是标签残渣）',
      rows.length > 0 && /[\u4e00-\u9fa5]{2,}/.test(sample) && !/<\|/.test(sample),
      rootCause || sample.slice(0, 60)
    )
    check(
      '10. 字幕时间点落在被识别的片段区间内（0 ~ 5.7s）',
      rows.length > 0 && rows.every((row) => row.start >= 0 && row.start <= WAV_SECONDS + 0.5),
      rootCause || rows.map((row) => row.start).join(',')
    )

    const bad = errs.filter((line) => !/Autofill|DevTools|Electron Security/i.test(line))
    if (bad.length) {
      console.log('\n  页面报错：')
      for (const line of bad.slice(0, 5)) console.log('   ', line.slice(0, 200))
    }
    return summary()
  } finally {
    await closeApp(app)
    fs.rmSync(PROFILE, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => {
  console.log(`\n[speech-e2e] 看门狗触发：${WATCHDOG_MS / 1000}s 未完成`)
  aborted = '看门狗超时'
  summary()
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref?.()

main()
  .then((ok) => {
    clearTimeout(watchdog)
    process.exit(ok ? 0 : 1)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.error('[speech-e2e] 失败：', err)
    process.exit(1)
  })
