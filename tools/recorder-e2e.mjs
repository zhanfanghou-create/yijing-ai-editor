#!/usr/bin/env node
/**
 * 客户端 E2E · 录音配音（假麦克风设备 + 真 MediaRecorder + 真落盘 + 真落片段）。
 *
 * 这一块的错法**大部分是"看起来成功了"**：
 *   ① 权限闸没放开 → getUserMedia 抛 NotAllowedError，界面只弹一句（或什么都不弹）；
 *   ② 录到了但没落盘 → 时间线上多了一个 0 秒片段（一根看不见的细线），
 *      重开草稿就消失（素材不在库里）；
 *   ③ 落了盘但没进 `yjai-media://` 白名单 → 片段卡片画得好好的，播放时无声；
 *   ④ 落点写在轨道末尾而不是播放头 → "对着画面说"这件事根本不成立。
 *
 * 所以判据取消费端，并且**跨进程**：
 *   · DOM：面板阶段（data-rec-phase）、计时器、电平格、音频轨上的片段数与几何；
 *   · 磁盘：`<userData>/recordings` 下真的存在一个 >5KB 的文件（1.3 秒 opus 约 10–20KB，
 *     几百字节基本就是"只有容器头、没有数据"）。
 *
 * 用 Chromium 的假设备（`--use-fake-device-for-media-stream`）而不是真麦克风：
 * CI/无人值守机器上没有可用输入设备，而"没有设备"与"功能坏了"在界面上长一样。
 *
 * 用法：node tools/recorder-e2e.mjs
 * 前置：`cd packages/desktop && vite build`
 * 退出码：0 = 通过；1 = 有失败
 */

import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.recorder-profile-${process.pid}`)
/** 假麦克风喂进去的音频文件（每次现造，不落库） */
const FAKE_WAV = path.join(os.tmpdir(), 'yjai-e2e', 'fake-mic-440hz.wav')
const EDITOR_SIZE = [1920, 1032]
const DPS = 46
/** 播放头放在 1 秒处：录音必须落在它上面（落在轨道末尾的实现在这里必红） */
const PLAYHEAD = 1

const ASSETS = [{ id: 'a_t1', kind: 'text', name: '文字甲', text: '配音背景', url: '' }]
const CLIPS = [
  { id: 'c_one', track: 'video', assetId: 'a_t1', name: '片段甲', kind: 'text', start: 0, duration: 4, offset: 0, sourceDuration: 4 }
]

const TOTAL_ASSERTIONS = 16

let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`RECORDER_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('RECORDER_E2E_OK')
  return failures === 0 && !aborted
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 造一段 48kHz / 16bit / 单声道 的 440Hz 正弦波，喂给 Chromium 的假麦克风。
 *
 * ⚠️ 只开 `--use-fake-device-for-media-stream` 时，假设备给的是一条**纯静音**轨：
 *   录音能成功、文件也有大小，但电平条一格都不会亮 —— 于是"电平条坏了"和
 *   "环境本来就是静音"分不开。给一段已知振幅的波形，电平才有确定答案。
 * ⚠️ 必须是 WAV（16bit PCM）：这个参数只认 wav，喂 mp3/webm 会被静默忽略，
 *   然后又回到"全静音"那个看不出来的状态。
 */
function writeFakeAudio(file) {
  const RATE = 48000
  const SECONDS = 4
  const AMP = 0.5
  const frames = RATE * SECONDS
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk 长度
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // 单声道
  buffer.writeUInt32LE(RATE, 24)
  buffer.writeUInt32LE(RATE * 2, 28) // byteRate
  buffer.writeUInt16LE(2, 32) // blockAlign
  buffer.writeUInt16LE(16, 34) // 位深
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * AMP * 32767)
    buffer.writeInt16LE(sample, 44 + i * 2)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buffer)
  return file
}


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
    /* 进程可能已经退了 */
  }
  await sleep(500)
}

async function main() {
  console.log('=== 录音配音 E2E（假麦克风 + 真 MediaRecorder + 真落盘）===\n')

  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, EXE)
    aborted = 'electron 不存在'
    return summary()
  }
  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 构建产物存在', false, 'dist-renderer/index.html 缺失 —— 先构建渲染层')
    aborted = '构建产物缺失'
    return summary()
  }
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* 删不掉就带着旧 profile 启动 */
  }

  let app = null
  const pageErrors = []
  try {
    try {
      writeFakeAudio(FAKE_WAV)
    } catch (err) {
      check('前置 · 假麦克风波形已生成', false, err.message)
      aborted = '造不出假音频'
      return summary()
    }
    check('前置 · 假麦克风波形已生成（4 秒 / 48kHz / 440Hz）', fs.statSync(FAKE_WAV).size > 44 + 48000, String(fs.statSync(FAKE_WAV).size))
    app = await electron.launch({
      executablePath: EXE,
      args: [
        MAIN,
        `--user-data-dir=${PROFILE}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        /* 假麦克风：没有这两条，无人值守机器上根本没有输入设备，
           "没设备"和"功能坏了"在界面上长得一模一样 */
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        /* 关键：给假设备一段**有声**波形。不传这个，假设备出的是纯静音轨，
           电平条永远 0 格 —— 届时"电平条没接"和"环境没声音"无法区分。 */
        `--use-file-for-fake-audio-capture=${FAKE_WAV}`
      ],
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })
    const page = await app.firstWindow()
    page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
    page.setDefaultTimeout(20000)

    const resize = async () => {
      await app
        .evaluate(async ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) return
          if (win.isMaximized()) win.unmaximize()
          win.setContentSize(size[0], size[1])
        }, EDITOR_SIZE)
        .catch(() => {})
    }

    await resize()
    await page.waitForSelector('.app', { timeout: 30000 })
    await sleep(1600)
    await resize()

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 录音配音', data: { clips: CLIPS, assets: ASSETS, playhead: PLAYHEAD, volume: 80, zoom: 1 } }
    )
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(600)
    await resize()
    await sleep(400)

    const allClips = () => page.locator('.clip[data-clip]').count()
    check('夹具 · 时间线上有 1 个片段（视频轨）', (await allClips()) === 1, `实测 ${await allClips()}`)

    /* ---- 打开录音面板 ---- */
    await page.locator('[data-tl="record"]').click()
    await sleep(500)
    check('点录音键 · 面板出现', (await page.locator('[data-recorder="1"]').count()) === 1)
    const phaseIdle = await page.locator('[data-recorder="1"]').getAttribute('data-rec-phase')
    check('打开时 · 阶段是 idle（没有偷偷开始录）', phaseIdle === 'idle', String(phaseIdle))

    /* ---- 开始录音 ---- */
    await page.locator('[data-rec-btn="start"]').click()
    await sleep(1200)
    const phaseRec = await page.locator('[data-recorder="1"]').getAttribute('data-rec-phase')
    check('点开始 · 阶段变成 recording', phaseRec === 'recording', String(phaseRec))

    const timer = Number(await page.locator('[data-rec-timer]').getAttribute('data-rec-timer'))
    check('录音中 · 计时器在走（> 1 秒）', timer > 1, String(timer))

    /* 电平：连续采几次取最大值。只读一瞬间可能正好落在两次重渲染之间，
       那会变成"偶发假红"，而假红比漏检更浪费人。 */
    let litBars = 0
    let levelSamples = []
    for (let i = 0; i < 5; i += 1) {
      const on = await page.locator('[data-rec-bar="on"]').count()
      levelSamples.push(on)
      if (on > litBars) litBars = on
      await sleep(100)
    }
    check(
      '录音中 · 电平条有格子亮起（证明真的采到了声音，不是录了一片静音）',
      litBars > 0,
      `亮 ${litBars} 格 / 采样 ${levelSamples.join(',')}`
    )

    /* ---- 停止：落盘 + 落片段 ---- */
    await page.locator('[data-rec-btn="stop"]').click()
    await sleep(2000)
    check('点停止 · 面板自己关掉了（录完就是录完，不再占着屏幕）', (await page.locator('[data-recorder="1"]').count()) === 0)

    const audioClips = page.locator('[data-lane="audio"] .clip[data-clip]')
    const audioCount = await audioClips.count()
    check('录完 · 音频轨上多了一段', audioCount === 1, `实测 ${audioCount}`)
    check('录完 · 时间线总共 2 段（原视频段没被动）', (await allClips()) === 2, `实测 ${await allClips()}`)

    const geom = await audioClips.first().evaluate((node) => ({
      left: parseFloat(node.style.left) || 0,
      width: parseFloat(node.style.width) || 0
    }))
    check(
      '落点 · 在播放头（1 秒 ≈ 46px），不是轨道末尾',
      Math.abs(geom.left - PLAYHEAD * DPS) < 8,
      `${geom.left}px`
    )
    const seconds = geom.width / DPS
    check(
      '时长 · 与录音的墙钟时间一致（1.5 秒左右，不是 0 秒也不是几十秒）',
      seconds > 1 && seconds < 3,
      `${seconds.toFixed(2)} 秒`
    )

    /* ---- 磁盘：录音真的落了盘（跨进程判据） ---- */
    const userData = await app.evaluate(async ({ app: electronApp }) => electronApp.getPath('userData'))
    const recDir = path.join(userData, 'recordings')
    const files = fs.existsSync(recDir)
      ? fs
          .readdirSync(recDir)
          .filter((name) => /\.(webm|m4a|ogg)$/i.test(name))
          .map((name) => ({ name, size: fs.statSync(path.join(recDir, name)).size }))
      : []
    check('磁盘 · userData/recordings 下有一个录音文件', files.length === 1, JSON.stringify(files))
    check(
      '磁盘 · 文件里真的有数据（> 5KB；几百字节通常只有容器头）',
      files.length === 1 && files[0].size > 5000,
      files.length ? `${files[0].name} ${files[0].size} 字节` : '无文件'
    )

    if (pageErrors.length) {
      check('全程无页面错误', false, pageErrors.slice(0, 3).join(' | '))
    } else {
      check('全程无页面错误', true)
    }
  } catch (error) {
    check('流程 · 未中途抛异常', false, error.message)
    aborted = error.message
  } finally {
    await closeApp(app)
  }

  summary()
  process.exit(failures === 0 && !aborted ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
