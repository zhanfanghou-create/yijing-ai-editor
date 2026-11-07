#!/usr/bin/env node
/**
 * 闸门：字幕识别的**档位选择**（人这条通道）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 两个识别模型（中文轻量 78MB / 多语种 228MB）早就登记在注册表里，agent 能通过
 * `yijing_recognize_subtitles(modelId=…)` 指定用哪一档；但界面上一直写死用默认档 ——
 * 「双通道对等」的第一条（人在界面上能独立做完）在这里是断的。
 * 断的表现是"功能都能用"，所以不会有任何报错，只能靠一条闸门钉住"下拉真的在"。
 *
 * ── 判据读消费端 ────────────────────────────────────────────────
 * 不读 App 的 state：看 DOM 里 `<option>` 的真实数量与 disabled 状态，
 * 以及选完之后 localStorage 里到底存了什么（下次启动读的就是它）。
 *
 * ⚠️ 无窗：自己注入 YJAI_NO_WINDOW=1。
 * 用法：node tools/check-speech-tiers.mjs
 */
import { execFileSync } from 'node:child_process'
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', 'speech-shared')
const CACHE = path.join(os.tmpdir(), 'yjai-e2e', 'cache')
const WAV = path.join(CACHE, 'speech-zh-0.wav')
const WAV_BYTES = 179646
const WAV_SECONDS = 5.61
const WAV_URLS = [
  'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav',
  'https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav'
]

const TOTAL_ASSERTIONS = 7
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
  let coverage = 0
  if (ran !== TOTAL_ASSERTIONS) {
    coverage = 1
    console.log(`  [FAIL] 断言覆盖 · 期望 ${TOTAL_ASSERTIONS} 项，实际只跑了 ${ran} 项`)
  }
  const fail = failures + coverage
  const pass = ran - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  console.log(`SPEECH_TIERS_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail}`)
  if (!fail && !aborted) console.log('SPEECH_TIERS_OK')
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
      https
        .get(list[i], { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            go([res.headers.location, ...list.slice(i + 1)], 0)
            return
          }
          if (res.statusCode !== 200) {
            res.resume()
            go(list, i + 1)
            return
          }
          const file = fs.createWriteStream(dest)
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
        })
        .on('error', () => go(list, i + 1))
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

/**
 * ⚠️ 这个 profile **不清空**（只在开头删草稿）：装好的识别模型（78MB）要跨次复用，
 *    否则每跑一次闸门就重下一次 —— 而这道闸的目的恰恰是"装上之后能选"。
 *    草稿目录必须清：首页「最近草稿」取第一条，残留的旧草稿会让断言跑在别的片子上。
 */
function resetProfile() {
  fs.mkdirSync(PROFILE, { recursive: true })
  for (const name of fs.readdirSync(PROFILE)) {
    if (name === 'models') continue
    fs.rmSync(path.join(PROFILE, name), { recursive: true, force: true })
  }
}

async function main() {
  resetProfile()
  fs.mkdirSync(CACHE, { recursive: true })

  if (!fs.existsSync(WAV) || fs.statSync(WAV).size !== WAV_BYTES) {
    console.log('[speech-tiers] 下载样例音频（175KB）…')
    await download(WAV_URLS, WAV).catch(() => {})
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

    /* 造一个带音频的草稿：字幕页要选中片段才有意义（也让档位下拉有上下文） */
    const mediaUrl = await page.evaluate(async (file) => {
      await window.yjai.media.stat([file])
      return window.yjai.media.url(file)
    }, WAV)
    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: '档位闸门',
        data: {
          clips: [
            {
              id: 'c_tier',
              track: 'video',
              assetId: 'a_tier',
              name: '说话的片段',
              kind: 'video',
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

    /** 进「字幕 → 字幕模板」页（每次 reload 之后都要重走一遍） */
    const openSubtitlePage = async () => {
      await page.waitForSelector('.wb-timeline', { timeout: 20000 })
      await sleep(600)
      await page.locator('[data-wb-tab="subtitle"]').click()
      await sleep(400)
      await page.locator('[data-wb-node="subtitle-custom"]').click()
      await sleep(900)
    }
    const reopenFromHome = async () => {
      await page.waitForSelector('.home', { timeout: 30000 })
      await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
      await page.waitForSelector('.home-draft-row', { timeout: 10000 })
      await page.locator('.home-draft-open').first().click()
      await openSubtitlePage()
    }
    const readOpts = async () =>
      page.locator('[data-sub-model] option').evaluateAll((nodes) =>
        nodes.map((n) => ({ value: n.value, text: (n.textContent || '').trim(), disabled: n.disabled }))
      )

    await openSubtitlePage()

    /* ---------- 1. 下拉真的在 ---------- */
    const sel = page.locator('[data-sub-model]')
    const visible = await sel.isVisible().catch(() => false)
    check('1. 「字幕 → 字幕模板」页里出现「识别档位」下拉', visible)
    if (!visible) return summary()

    /* ---------- 2. 列出全部已登记的识别模型（不是只列能用的） ---------- */
    const opts = await readOpts()
    check(
      '2. 两档都在下拉里（轻量中文 / 多语种）',
      opts.length === 2 && opts.some((o) => o.value === 'speech-paraformer') && opts.some((o) => o.value === 'speech-sensevoice'),
      opts.map((o) => o.value).join(' / ') || '没有 option'
    )

    /* ---------- 3. 没装的那档必须写明「未安装」且不可选 ---------- */
    const notReady = opts.filter((o) => o.disabled)
    check(
      '3. 没装的档位标出「（未安装）」并且不可选（不能让人选了才发现跑不了）',
      notReady.length === 0 || notReady.every((o) => /未安装/.test(o.text)),
      notReady.length ? notReady.map((o) => o.text).join(' / ') : '两档都已装'
    )

    /* ---------- 4. 装一档之后它就该可选（78MB，走应用自己的下载器） ---------- */
    let hasPick = opts.some((o) => !o.disabled)
    if (!hasPick) {
      const dl = await page.evaluate(() => window.yjai.models.download('speech-paraformer'))
      hasPick = Boolean(dl && dl.ok)
      if (!hasPick) {
        check('4. 装上轻量档之后，下拉里这一档可被选中', false, (dl && dl.error) || '下载失败')
        return summary()
      }
      /* reload 相当于"用户下次打开面板"：清单要重新从主进程拉一次 */
      await page.reload()
      await reopenFromHome()
    }
    const afterInstall = await readOpts()
    check(
      '4. 装上轻量档之后，下拉里这一档可被选中（未装的那档仍禁用）',
      afterInstall.some((o) => o.value === 'speech-paraformer' && !o.disabled) &&
        afterInstall.filter((o) => o.disabled).every((o) => /未安装/.test(o.text)),
      afterInstall.map((o) => `${o.value}${o.disabled ? '(禁)' : ''}`).join(' / ')
    )

    /* ---------- 5. 选了之后真的记在偏好里 ---------- */
    await sel.selectOption('speech-paraformer')
    await sleep(400)
    const saved = await page.evaluate(() => {
      try {
        return window.localStorage.getItem('yjai.speechModel') || ''
      } catch {
        return ''
      }
    })
    check('5. 选择结果写进偏好（下次启动读的就是它）', saved === 'speech-paraformer', `存的是 ${saved || '（空）'}`)

    /* ---------- 6. 刷新界面后仍停在那一档 ---------- */
    await page.reload()
    await reopenFromHome()
    const after = await page.locator('[data-sub-model]').inputValue().catch(() => '')
    check('6. 重启界面后下拉仍停在用户选的那一档', after === 'speech-paraformer', after || '（空）')

    check('7. 全程没有页面级报错', errs.length === 0, errs.slice(0, 2).join(' | ') || '干净')
  } finally {
    await closeApp(app)
  }
  return summary()
}

const watchdog = setTimeout(() => {
  console.log(`[speech-tiers] 看门狗触发（${WATCHDOG_MS / 60000} 分钟）`)
  process.exit(1)
}, WATCHDOG_MS)

main()
  .then((ok) => {
    clearTimeout(watchdog)
    process.exit(ok ? 0 : 1)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.log(`[speech-tiers] 崩了：${(err && err.stack) || err}`)
    console.log(`SPEECH_TIERS_STATS total=${TOTAL_ASSERTIONS} pass=${ran - failures} fail=${TOTAL_ASSERTIONS - (ran - failures)}`)
    console.log('SPEECH_TIERS_FAILED')
    process.exit(1)
  })
