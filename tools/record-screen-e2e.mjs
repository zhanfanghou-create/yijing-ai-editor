#!/usr/bin/env node
/**
 * 客户端 E2E · 应用内录制（屏幕 / 摄像头）。
 *
 * 这一块最容易出的不是"崩"，而是**看着成功了**：
 *   ① 点开始没反应（权限闸没放行，getUserMedia 抛 NotAllowedError，界面只闪一句）；
 *   ② 提示"需要单独确认"就没了下文（用户以为功能没做）；
 *   ③ 录完没落盘 → 时间线上一个 0 秒片段；
 *   ④ 落了盘却不是 webm（只有容器头、没有帧）—— 文件大小看着有，播放全黑。
 *
 * 判据取消费端、且跨进程：
 *   · DOM：确认框是否出现 / 取消后是否回 idle / 停止键是否出现 / 计时器秒数 / 预览 videoWidth；
 *   · IPC：`recorder.sources()` 的真实返回（结构而不是"有没有"）；
 *   · 磁盘：`<userData>/recordings` 下真有 `录屏-*.webm`，> 20KB，头四字节是 EBML magic；
 *   · 时间线：片段数与位置（px / 46 = 秒，与 recorder-e2e 同一把尺）。
 *
 * **负对照是本文件的核心**：主进程的权限闸只认一次性票据（见 main/index.js 的
 * recordGrant），所以必须先证明"没票据拿不到摄像头、camera 票据开不了屏"，
 * 否则"录制能用"完全可能只是因为闸门被整条放开了 —— 而放开的闸门在界面上
 * 和正常一模一样。三条负对照都插在打桩之前，走真实权限路径。
 *
 * ⚠️ 不能加 `--use-fake-ui-for-media-stream`（recorder-e2e 用了它）：
 *    那个开关让 Chromium 直接 auto-allow，权限回调根本不参与，
 *    负对照会全部假绿。这里只加 `--use-fake-device-for-media-stream`（给假设备，不代替授权）。
 *
 * 屏幕这条链路在无桌面会话的机器上拿不到真实源，所以「建流」这一步用
 * `canvas.captureStream()` 替身（页面里替换 getDisplayMedia）——
 * 但**录制、编码、落盘、落片段全是真的**，只有"画面从哪来"被替换。
 *
 * 用法：node tools/record-screen-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.record-screen-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]
/** 时间线像素/秒（与 recorder-e2e 同一把尺，zoom=1） */
const DPS = 46
/** 播放头放在 1 秒处：录屏必须落在它上面 */
const PLAYHEAD = 1

const ASSETS = [{ id: 'a_t1', kind: 'text', name: '文字甲', text: '录制背景', url: '' }]
const CLIPS = [
  { id: 'c_one', track: 'video', assetId: 'a_t1', name: '片段甲', kind: 'text', start: 0, duration: 6, offset: 0, sourceDuration: 6 }
]

const TOTAL_ASSERTIONS = 29

let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`RECORD_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('RECORD_E2E_OK')
  return failures === 0 && !aborted
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

/** 摄像头能不能用：返回 'ok' 或错误名（NotAllowedError / NotFoundError …） */
const probeCamera = (page) =>
  page.evaluate(() =>
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop())
        return 'ok'
      })
      .catch((error) => String((error && error.name) || 'Error'))
  )

/** 录屏能不能用（真实权限路径，不打桩）：同上 */
const probeDisplay = (page) =>
  page.evaluate(() =>
    navigator.mediaDevices
      .getDisplayMedia({ video: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop())
        return 'ok'
      })
      .catch((error) => String((error && error.name) || 'Error'))
  )

async function main() {
  console.log('=== 应用内录制 E2E（权限票据 / 应用内确认 / 真 MediaRecorder / 真落盘 / 落播放头）===\n')

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
    app = await electron.launch({
      executablePath: EXE,
      args: [
        MAIN,
        `--user-data-dir=${PROFILE}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        /* 只给假设备，**不给** --use-fake-ui-for-media-stream：那个开关会替我们授权，
           负对照就全成了假绿 */
        '--use-fake-device-for-media-stream'
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

    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const recDir = path.join(userData, 'recordings')

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 应用内录制', data: { clips: CLIPS, assets: ASSETS, playhead: PLAYHEAD, volume: 80, zoom: 1 } }
    )
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(700)
    await resize()
    await sleep(300)

    const clipCount = () => page.locator('.clip[data-clip]').count()
    check('夹具 · 时间线上有 1 个片段', (await clipCount()) === 1, `实测 ${await clipCount()}`)

    /* ---------------- 负对照：权限闸真的在管（都在打桩之前） ---------------- */

    await page.evaluate(() => window.yjai.recorder.cancelGrant())
    const noGrantCam = await probeCamera(page)
    check('负对照 · 没有票据时拿不到摄像头（闸门没被整条放开）', noGrantCam === 'NotAllowedError', noGrantCam)

    await page.evaluate(() => window.yjai.recorder.grant({ scope: 'camera' }))
    const cameraWithGrant = await probeCamera(page)
    check('负对照 · 拿到 camera 票据后摄像头可用（放行的确是票据带来的）', cameraWithGrant === 'ok', cameraWithGrant)

    const displayWithCameraGrant = await probeDisplay(page)
    check(
      '负对照 · camera 票据开不了屏（scope 不能串用）',
      displayWithCameraGrant !== 'ok',
      displayWithCameraGrant
    )
    await page.evaluate(() => window.yjai.recorder.cancelGrant())

    /* ---------------------------- 打开录制面板 ---------------------------- */

    await page.locator('.wb-tab[data-wb-tab="media"]').click()
    await sleep(250)
    await page.locator('.wb-tree .wb-node[data-wb-node="record"]').click()
    await sleep(600)

    check('点左栏「录制」· 面板出现', (await page.locator('[data-rec-mode="screen"]').count()) === 1)
    check(
      '面板有「屏幕 / 摄像头」两种录制方式',
      (await page.locator('[data-rec-mode="screen"]').count()) === 1 &&
        (await page.locator('[data-rec-mode="camera"]').count()) === 1
    )

    const panelText = await page.locator('.wb-media').innerText()
    /* 这条是本次需求的正面判据：那段"尚未接入 / 要放开 media 权限 / 需单独确认"的话必须消失。
       注意别写成"整页不含 media 二字" —— 正常文案里也会出现这个词。 */
    const banned = ['尚未接入', '还没有实现', '暂未接入', '需要单独确认', '不支持应用内录制', 'OpenFX']
    const hits = banned.filter((word) => panelText.includes(word))
    check('面板里没有任何"未接入 / 需单独确认"的说法', !hits.length, hits.join(' / '))

    const sourcesReply = await page.evaluate(() => window.yjai.recorder.sources())
    check('主进程能列出可录的画面（record:sources 返回 ok）', sourcesReply && sourcesReply.ok === true, JSON.stringify(sourcesReply && sourcesReply.error))
    const sourceList = (sourcesReply && sourcesReply.sources) || []
    check(
      '源的结构完整（id / name / kind / thumbnail 四件都在）',
      sourceList.every(
        (item) => typeof item.id === 'string' && item.id && typeof item.name === 'string' && typeof item.kind === 'string' && typeof item.thumbnail === 'string'
      ),
      `${sourceList.length} 个源`
    )
    check('屏幕源列表区已渲染', (await page.locator('[data-rec-source-list="1"]').count()) === 1)
    check('有「开始录制」按钮', (await page.locator('[data-rec-btn="start"]').count()) === 1)

    /* ------------------- 应用内确认：出现 → 取消 → 票据作废 ------------------- */

    await page.locator('[data-rec-btn="start"]').click()
    await sleep(350)
    check('点开始 · 先弹应用内确认（不是直接开录）', (await page.locator('[data-rec-confirm="1"]').count()) === 1)
    const confirmText = await page.locator('[data-rec-confirm="1"]').innerText()
    check(
      '确认框说清了"录什么 + 只存在本机"',
      confirmText.includes('只保存在本机') && /屏幕|窗口|摄像头/.test(confirmText),
      confirmText.replace(/\s+/g, ' ').slice(0, 60)
    )

    await page.locator('[data-rec-deny="1"]').click()
    await sleep(300)
    check(
      '点「暂不录制」· 确认框消失且没有偷偷开录',
      (await page.locator('[data-rec-confirm="1"]').count()) === 0 &&
        (await page.locator('[data-rec-btn="stop"]').count()) === 0 &&
        (await page.locator('[data-rec-btn="start"]').count()) === 1
    )
    const afterCancelCam = await probeCamera(page)
    check('取消后票据已作废（摄像头又被拒）', afterCancelCam === 'NotAllowedError', afterCancelCam)

    /* ------------------ 允许并开始：打桩画面源，其余全真 ------------------ */

    await page.evaluate(() => {
      /* 只替换"画面从哪来"：canvas 每 40ms 换一帧，保证 MediaRecorder 有真实帧可编 */
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 360
      const ctx = canvas.getContext('2d')
      let n = 0
      window.__yjaiE2eFrames = setInterval(() => {
        n += 1
        ctx.fillStyle = n % 2 ? '#1b2438' : '#2a1b38'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#ffffff'
        ctx.font = 'bold 64px sans-serif'
        ctx.fillText(`E2E ${n}`, 80, 210)
      }, 40)
      navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(25)
    })

    /* 屏幕模式下要有可选的源；没有源就选不到东西 —— 用主进程报回来的第一个 */
    if (sourceList.length) {
      await page.locator(`[data-rec-source="${sourceList[0].id}"]`).click()
      await sleep(200)
    }

    await page.locator('[data-rec-btn="start"]').click()
    await sleep(300)
    await page.locator('[data-rec-allow="1"]').click()
    await sleep(1800)

    check('点「允许并开始」· 进入录制（出现停止键）', (await page.locator('[data-rec-btn="stop"]').count()) === 1)
    check('录制中 · 有"录制中"标记', (await page.locator('[data-rec-live="1"]').count()) === 1)

    const timer = Number(await page.locator('[data-rec-timer]').getAttribute('data-rec-timer'))
    check('录制中 · 计时器在走（> 1 秒）', timer > 1, String(timer))

    const previewSize = await page.evaluate(() => {
      const video = document.querySelector('[data-rec-preview="1"]')
      if (!video) return { w: 0, h: 0, paused: true }
      return { w: video.videoWidth, h: video.videoHeight, paused: video.paused }
    })
    check(
      '录制中 · 预览有真实画面（videoWidth > 0 且没暂停）',
      previewSize.w > 0 && previewSize.h > 0 && previewSize.paused === false,
      JSON.stringify(previewSize)
    )

    await page.locator('[data-rec-btn="stop"]').click()

    /* 保存是异步的：等停止键消失（回到 idle），最多 20 秒 */
    let backToIdle = false
    for (let i = 0; i < 40; i += 1) {
      await sleep(500)
      if ((await page.locator('[data-rec-btn="stop"]').count()) === 0) {
        backToIdle = true
        break
      }
    }
    check('点停止 · 回到 idle（停止键消失）', backToIdle)

    await page.evaluate(() => {
      if (window.__yjaiE2eFrames) clearInterval(window.__yjaiE2eFrames)
    })

    /* ------------------------------ 落盘与落片段 ------------------------------ */

    let files = []
    try {
      files = fs
        .readdirSync(recDir)
        .filter((name) => name.startsWith('录屏-') && name.endsWith('.webm'))
        .map((name) => {
          const full = path.join(recDir, name)
          return { name, size: fs.statSync(full).size, full }
        })
        .sort((a, b) => b.size - a.size)
    } catch {
      files = []
    }
    const file = files[0]
    check('落盘 · recordings 下有 录屏-*.webm', Boolean(file), file ? `${file.name} ${file.size}B` : `目录 ${recDir}`)
    /* 20KB 是底线：2 秒 vp9 640×360 约 30–200KB；几百字节只会是"只有容器头" */
    check('落盘 · 文件里真有帧数据（> 20KB）', Boolean(file) && file.size > 20 * 1024, file ? String(file.size) : '无文件')

    let magic = ''
    if (file) {
      try {
        magic = fs.readFileSync(file.full).subarray(0, 4).toString('hex')
      } catch {
        magic = ''
      }
    }
    /* EBML magic：1A 45 DF A3 —— webm / mkv 都是它。这不是"能解码"的证明，
       但能挡掉"写了个空文件 / 写成了纯文本"这类整段没落盘的错法 */
    check('落盘 · 文件头是 webm（EBML 1a45dfa3）', magic === '1a45dfa3', magic || '读不到')

    const after = await clipCount()
    check('时间线 · 多了一个片段（1 → 2）', after === 2, `实测 ${after}`)

    const geometry = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.clip[data-clip]')]
      const last = nodes[nodes.length - 1]
      return last ? { left: last.offsetLeft, cls: last.className } : null
    })
    const seconds = geometry ? geometry.left / DPS : -1
    check(
      '时间线 · 新片段落在播放头（≈1 秒，不是轨道末尾）',
      Boolean(geometry) && Math.abs(seconds - PLAYHEAD) < 0.8,
      geometry ? `${seconds.toFixed(2)}s（left=${geometry.left}px）` : '找不到片段'
    )

    check('没有渲染层异常（0 pageerror）', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  } catch (error) {
    aborted = String((error && error.stack) || error)
    check('执行过程未抛异常', false, aborted.split('\n')[0])
  } finally {
    await closeApp(app)
  }

  return summary()
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error('RECORD_E2E_CRASH', error)
    process.exit(1)
  })
