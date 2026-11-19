/**
 * 声音效果在**预览里**真不真生效 —— 真启 Electron 的 E2E。
 *
 * 这道闸门回答四个"静态检查答不了"的问题：
 *   ① 淡入 / 淡出真的在走 —— 判据是播放过程中 `<video>.volume` 的**实测轨迹**
 *      （音量滑杆、脏点、时间线全都不会因为它没接而变化，只有这个数会）；
 *   ② 声像真的分了左右 —— 判据是音频图末端电平表读出的**左右声道 RMS**，
 *      不是"状态里存了 -100"；
 *   ③ 人声增强 / 变声真的接管了元素 —— 判据是元素上的 `data-audio-graph`；
 *      且**没有重复乘音量**（增强走图，音量仍走 el.volume，两条路各管一段）；
 *   ④ 做不到的那两个照实标着 —— 花栗鼠 / 低沉**不许**接管元素（它们只在导出生效），
 *      接管了就是"预览听着变了、成片却是另一个声"。
 *
 * 为什么必须真的播：音量和电平只有在播的时候才有值。暂停状态下读 `el.volume`
 * 只能证明"赋值语句跑过"，证明不了"用户听得到"。
 *
 * 断言总数恒为 18：缺 ffmpeg / electron 时逐条 SKIP，verify 里钉死的数字才有意义。
 *
 * 用法：node tools/audio-preview-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.audio-preview-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 18
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

/** 主画面那个 `<video>`：音量、是否被音频图接管、左右声道实测电平 */
const probe = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.canvas-frame video')
    if (!el) return null
    return {
      volume: el.volume,
      muted: el.muted,
      paused: el.paused,
      graph: el.dataset.audioGraph || '',
      levelL: Number(el.dataset.audioLevelL || 0),
      levelR: Number(el.dataset.audioLevelR || 0),
      playhead: Number(document.querySelector('[data-playhead]')?.getAttribute('data-playhead') || 0)
    }
  })

/** 右栏某个方块里的滑杆（按 section 的 hook 限定，避免两个「强度」撞车） */
async function setSlider(page, hook, labelText, value) {
  return page.evaluate(
    ({ hook, labelText, value }) => {
      const sect = document.querySelector(`.wb-inspsect[data-inspsect="${hook}"]`)
      if (!sect) return false
      const row = [...sect.querySelectorAll('.slider-row')].find((item) =>
        String(item.querySelector('label')?.textContent || '').startsWith(labelText)
      )
      const input = row?.querySelector('input[type=range]')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    { hook, labelText, value }
  )
}

const WATCHDOG_MS = Number(process.env.AUDIO_PREVIEW_TIMEOUT_MS || 6 * 60 * 1000)
let finished = false
const watchdog = setTimeout(() => {
  if (finished) return
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

function summary() {
  const total = emitted
  console.log(`AUDIO_PREVIEW_E2E_STATS total=${total} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) console.log(`\nAUDIO_PREVIEW_E2E_FAILED  ${fail} 条不成立：${failures.join(' / ')}`)
  else console.log('\nAUDIO_PREVIEW_E2E_OK  淡入淡出 / 声像 / 人声增强 在预览里真的生效')
}

async function main() {
  console.log('=== 声音效果进预览 E2E ===\n')

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    check('能找到 ffmpeg', false, '未找到')
    backfillSkips('本机没有 ffmpeg')
    return
  }
  const ffmpeg = found.ffmpeg
  const ver = spawnCapture(ffmpeg, ['-version'], { tag: 'ver' })
  check('ffmpeg 可执行（-version 返回 0）', ver.status === 0, String(ver.stdout || '').split('\n')[0])

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-audiofx-'))
  const clip = path.join(work, 'tone.mp4')
  /* 4 秒：够走完 2s 淡入 + 1s 淡出；音轨必须有，否则一切音量断言都是 0 对 0 */
  spawnCapture(
    ffmpeg,
    [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:r=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip
    ],
    { tag: 'mk' }
  )
  const made = fs.existsSync(clip) && fs.statSync(clip).size > 1024
  check('测试素材生成完毕（4 秒画面 + 440Hz 音轨）', made, made ? clip : '生成失败')
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

    const rows = await page.evaluate((p) => window.yjai.media.stat(p), [clip])
    const list = Array.isArray(rows) ? rows : []
    if (list.length !== 1) throw new Error('素材没登记上：后面所有断言都依赖它')

    /* 夹具：一段 4 秒画面，淡入 2 秒、淡出 1 秒，音量 100%。
       ⚠️ 声像**故意先不写** —— 先证明"中性时不接管元素"，再去拖滑杆看它接管。 */
    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: 'E2E 声音效果进预览',
      data: {
        assets: list.map((item) => ({ ...item, id: 'a_main' })),
        clips: [
          {
            id: 'c_main',
            track: 'video',
            assetId: 'a_main',
            kind: 'video',
            name: '主画面',
            url: list[0].url,
            path: clip,
            start: 0,
            duration: 4,
            offset: 0,
            sourceDuration: 4,
            speed: 1,
            gain: 100,
            fadeIn: 2,
            fadeOut: 1
          }
        ],
        playhead: 0,
        volume: 100,
        zoom: 1
      }
    })
    check('夹具草稿已写入（淡入 2s / 淡出 1s）', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(900)

    /* -------------------- ① 淡入 / 淡出：实测音量轨迹 -------------------- */

    const at0 = await probe(page)
    check('主画面视频元素已挂上（有音量可读）', Boolean(at0) && typeof at0.volume === 'number', at0 ? `volume=${at0.volume}` : 'null')
    check(
      '播放头在 0 时音量≈0（淡入的起点真的是 0，不是"从满音量开始"）',
      Boolean(at0) && at0.volume <= 0.12,
      at0 ? `volume=${at0.volume.toFixed(3)}` : 'null'
    )

    await page.locator('.wb-transport-btns button.play').click()
    const trail = []
    /* 34 × 150ms ≈ 5s 墙钟：4 秒的片段会播到尾巴（淡出段在 3–4s，采样少了根本走不到） */
    for (let i = 0; i < 34; i += 1) {
      const snap = await probe(page)
      if (snap) trail.push(snap)
      await sleep(150)
    }
    await page.locator('.wb-transport-btns button.play').click().catch(() => {})

    const rising = trail.filter((s) => s.playhead > 0.15 && s.playhead < 1.6)
    const hold = trail.filter((s) => s.playhead > 2.2 && s.playhead < 3.0)
    const falling = trail.filter((s) => s.playhead > 3.55)

    check(
      '淡入段：音量随播放头爬升（不是"开头就满、之后不变"）',
      rising.length >= 3 &&
        rising[rising.length - 1].volume > rising[0].volume + 0.2 &&
        rising[rising.length - 1].volume < 1.001,
      rising.map((s) => `${s.playhead.toFixed(2)}s:${s.volume.toFixed(2)}`).join(' ')
    )
    check(
      '淡入结束（2s 之后）：音量到 100%',
      hold.length >= 2 && hold.every((s) => s.volume > 0.95),
      hold.map((s) => `${s.playhead.toFixed(2)}s:${s.volume.toFixed(2)}`).join(' ')
    )
    check(
      '淡出段（最后 1 秒）：音量真的掉下来了',
      falling.length >= 1 && falling[falling.length - 1].volume < 0.7,
      falling.map((s) => `${s.playhead.toFixed(2)}s:${s.volume.toFixed(2)}`).join(' ')
    )
    check(
      '全程音量不超过 1（淡入淡出没有把音量叠成两倍）',
      trail.every((s) => s.volume <= 1.0001),
      `max=${Math.max(...trail.map((s) => s.volume)).toFixed(3)}`
    )

    /* -------------------- ② 中性时不接管元素 -------------------- */

    /* 判据用**刚打开草稿时**那一份快照：此刻播到片尾了，画面上已经没有视频元素
       （播放头越过最后一段 ⇒ 没有主层），再读就是 null —— 那不是"没接管"，是"没元素"。 */
    check(
      '没调过声音效果时**不接管**元素（data-audio-graph 不是 on）',
      Boolean(at0) && at0.graph !== 'on',
      at0 ? `graph=${at0.graph || '空'}` : 'null'
    )

    /* -------------------- ③ 声像：真的分了左右 -------------------- */

    await page.locator('.wb-tllane[data-lane="video"] .clip[data-clip]').first().click()
    await sleep(300)
    await page.locator('[data-insp-tab="audio"]').click()
    await sleep(300)
    const dragged = await setSlider(page, 'pan', '左右', -100)
    await sleep(500)
    const panned = await probe(page)
    check(
      '拖「左右」到最左 ⇒ 元素被音频图接管（滑杆真接上了引擎）',
      dragged && Boolean(panned) && panned.graph === 'on',
      panned ? `graph=${panned.graph || '空'}` : 'null'
    )

    /* 回到开头再播：刚才那段已经放到片尾了，从片尾起播只剩零点几秒，电平表读不稳。
       ⚠️ 用 blur 而不是 Escape —— Escape 会**清掉选中**，之后右栏所有方块都消失，
          后面每一次拖滑杆都会静默失败（看起来像"功能没接"）。 */
    await page.evaluate(() => {
      const el = document.activeElement
      if (el && typeof el.blur === 'function') el.blur()
    })
    await page.keyboard.press('Home')
    await sleep(300)
    await page.locator('.wb-transport-btns button.play').click()
    await sleep(1200)
    const levels = await probe(page)
    await page.locator('.wb-transport-btns button.play').click().catch(() => {})
    check(
      '播起来之后左声道明显大于右声道（声像真的生效，不是"存了个 -100"）',
      Boolean(levels) && levels.levelL > 0.0005 && levels.levelL > levels.levelR * 3,
      levels ? `L=${levels.levelL.toFixed(4)} R=${levels.levelR.toFixed(4)}` : 'null'
    )

    /* 重新选中片段 + 音频页：中途按过播放 / Home，选中状态的存活不能靠猜 */
    const reselect = async () => {
      await page.locator('.wb-tllane[data-lane="video"] .clip[data-clip]').first().click()
      await sleep(250)
      await page.locator('[data-insp-tab="audio"]').click()
      await sleep(250)
    }
    await reselect()

    const back = await setSlider(page, 'pan', '左右', 0)
    await sleep(500)
    const centered = await probe(page)
    check(
      '拖回居中 ⇒ 图被拆掉、回到元素自己的音量（不留一条多余的链）',
      back && Boolean(centered) && centered.graph === 'none',
      centered ? `graph=${centered.graph || '空'}` : 'null'
    )

    /* -------------------- ④ 人声增强 / 变声 -------------------- */

    const boosted = await setSlider(page, 'voiceboost', '强度', 100)
    await sleep(500)
    const boostSnap = await probe(page)
    check(
      '人声增强 100% ⇒ 元素被音频图接管',
      boosted && Boolean(boostSnap) && boostSnap.graph === 'on',
      boostSnap ? `graph=${boostSnap.graph || '空'}` : 'null'
    )
    check(
      '人声增强**不重复乘音量**（增益仍在 el.volume 上，两条路各管一段）',
      Boolean(boostSnap) && boostSnap.volume <= 1.0001,
      boostSnap ? `volume=${boostSnap.volume.toFixed(3)}` : 'null'
    )

    /* 先把人声增强关掉：不然"变声选了花栗鼠"这一条会被增强那条链掩盖 ——
       图照样是 on，判据就变成了"增强在不在"，而不是"花栗鼠有没有假装生效"。 */
    await setSlider(page, 'voiceboost', '强度', 0)
    await sleep(400)

    const chipped = await page
      .locator('[data-inspsect="voicechange"] [data-voicefx-pick="chipmunk"]')
      .click()
      .then(() => true)
      .catch(() => false)
    await sleep(400)
    const chipSnap = await probe(page)
    check(
      '花栗鼠是导出专属：选了它**不接管**预览（不许假装生效）',
      chipped && Boolean(chipSnap) && chipSnap.graph !== 'on',
      chipSnap ? `graph=${chipSnap.graph || '空'}` : 'null'
    )
    check(
      '机器人在预览里生效（同为变声，一个能做一个不能做，必须分开判）',
      await page
        .locator('[data-inspsect="voicechange"] [data-voicefx-pick="robot"]')
        .click()
        .then(async () => {
          await sleep(400)
          const snap = await probe(page)
          return Boolean(snap) && snap.graph === 'on'
        })
        .catch(() => false)
    )

    check('全程没有页面报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } catch (error) {
    console.error(`\n[!] 执行中断：${error && error.message ? error.message : error}`)
    failures.push('执行中断')
    fail += 1
    backfillSkips('前面的步骤失败，后续依赖它')
  } finally {
    finished = true
    clearTimeout(watchdog)
    await shutdown(app)
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true })
    } catch {
      /* 目录可能被占用，留给系统清理 */
    }
    summary()
  }
}

main().then(() => {
  if (fail > 0) process.exitCode = 1
})
