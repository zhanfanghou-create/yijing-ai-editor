#!/usr/bin/env node
/**
 * 闸门：人物特效（识别 → 面板 → 预览真的跟着脸 → 成片也真的跟着脸）。
 *
 * 这道闸门治的是**"跟随类"功能特有的静默失效**，每一种都不会报错：
 *
 *   1. 检测跑通了但框是死的 —— 面板写着"已识别"，预览里那颗描边从头到尾钉在中间。
 *      所以判据不能是"有没有出现特效层"，而是**两个时刻的位置不同**（且方向一致）。
 *   2. 预览跟、成片不跟 —— 这是本工程最怕的一类：两侧单独看都正常。
 *      所以这里**真的导出一段成片**，再从像素里找描边的位置，比两个时刻的位移。
 *   3. 坐标口径不一致 —— 预览乘画布尺寸、导出乘成片像素，中间有一步用了时间线时间
 *      而不是片段内时间，整条特效就会平移 clip.start 那么多。第 2 条能挡住它。
 *   4. 运行时缺文件 —— 只在**装出来的包**里出现（开发模式从 node_modules 读）。
 *      静态那条直接查 resources/mediapipe 的三个文件在不在。
 *   5. CSP 悄悄放宽过头 —— `'wasm-unsafe-eval'` 是必需的，`'unsafe-eval'` 不是，
 *      两者只差几个字符，作用却差了整整一类攻击面。静态那条钉死。
 *
 * 纯静态部分可单独跑（不起 Electron）：
 *   node tools/check-facefx.mjs --static
 *
 * ⚠️ 成片那两条要求本机有 ffmpeg。缺了会 SKIP（并计入 skip，不是静默通过）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const STATIC_ONLY = process.argv.includes('--static')

const SRC = path.join(ROOT, 'packages', 'desktop', 'src')
const SHARED = path.join(SRC, 'shared', 'facefx.js')
const TREE = path.join(SRC, 'renderer', 'components', 'AssetTree.jsx')
const PANEL = path.join(SRC, 'renderer', 'components', 'SidePanels.jsx')
const STAGE = path.join(SRC, 'renderer', 'components', 'Stage.jsx')
const APP = path.join(SRC, 'renderer', 'App.jsx')
const RENDER = path.join(SRC, 'main', 'render.js')
const MAIN = path.join(SRC, 'main', 'index.js')
const PRELOAD = path.join(SRC, 'preload', 'index.js')
const MAIN_FACEFX = path.join(SRC, 'main', 'facefx.js')
const INDEX_HTML = path.join(ROOT, 'packages', 'desktop', 'index.html')
const BUILDER = path.join(ROOT, 'packages', 'desktop', 'electron-builder.yml')
const VITE = path.join(ROOT, 'packages', 'desktop', 'vite.config.mjs')
const RES_MP = path.join(ROOT, 'packages', 'desktop', 'resources', 'mediapipe')
const RES_FX = path.join(ROOT, 'packages', 'desktop', 'resources', 'facefx')
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'facefx-move.mp4')
const MAIN_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail) console.log(`      ${detail}`)
}
const skip = (name, why) => {
  results.push({ name, ok: false, skipped: true })
  console.log(`SKIP  ${name}`)
  console.log(`      ${why}`)
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ============================ 一、静态 ============================ */

console.log('\n[静态] 数据 / 接线 / 安全面\n')

const FACE = require(SHARED)

/* 1) 效果表：三款、key 唯一、都有名字与提示 */
{
  const keys = FACE.FX_LIST.map((f) => f.key)
  record(
    '效果表三款齐全且 key 唯一（blur / bright / frame）',
    keys.join(',') === 'blur,bright,frame' && new Set(keys).size === 3,
    keys.join(',')
  )
  const kinds = FACE.FX_LIST.map((f) => f.kind)
  record(
    '每款都标了导出侧的处理方式（local 局部 / stamp 叠加）',
    kinds.every((k) => k === 'local' || k === 'stamp'),
    kinds.join(',')
  )
}

/* 2) 几何公式与导出侧必须是**同一份**：shared 被 main 引用、也被渲染层引用 */
{
  const renderSrc = read(RENDER)
  const stageSrc = read(STAGE)
  record(
    'main/render.js 用 shared 的几何（buildSendcmd / cropSizeOf）',
    renderSrc.includes('facefx.buildSendcmd') && renderSrc.includes('facefx.cropSizeOf'),
    '导出侧自己算了一份几何 ⇒ 预览与成片迟早对不上'
  )
  record(
    '预览侧用 shared 的插值（trackAt），没有自己写一份',
    stageSrc.includes('trackAt(') && !stageSrc.includes('function trackAt'),
    '预览侧自己实现插值 ⇒ 两边取框不同步'
  )
}

/* 3) CJS 白名单：漏了 import 到空对象，构建不报、点下去 TypeError */
{
  const hasLine = read(VITE).split('\n').some((line) => line.includes('facefx') && line.includes('shared'))
  record('shared/facefx.js 已加入 vite 的 commonjsOptions.include', hasLine, '白名单里没有 facefx.js')
}

/* 4) CSP：只许多出 'wasm-unsafe-eval' 与 blob:，绝不许 'unsafe-eval' */
{
  const html = read(INDEX_HTML)
  /* 必须先剥注释：上面那段说明里就写着 script-src / 'unsafe-eval'，
     不剥的话 [^;]* 会从注释里那个 script-src 一路吃到 content 的分号，
     把整段说明当成 script-src 的内容 —— 于是明明没放行也判「放行了」。 */
  const bare = html.replace(/<!--[\s\S]*?-->/g, '')
  const m = bare.match(/script-src([^;]*);/)
  const scriptSrc = m ? m[1] : ''
  record(
    "CSP 放行了 'wasm-unsafe-eval'（编译 WASM 必需，无法绕过）",
    scriptSrc.includes("'wasm-unsafe-eval'"),
    scriptSrc.trim()
  )
  record(
    "CSP 放行了 blob:（注入 wasm 加载器），且**没有**放行 'unsafe-eval'",
    scriptSrc.includes('blob:') && !scriptSrc.includes("'unsafe-eval'"),
    scriptSrc.trim()
  )
  record(
    'CSP 的 script-src **没有**放行素材协议（否则素材目录可投放脚本）',
    !/script-src[^;]*yjai-media:/.test(bare),
    'script-src 里出现了 yjai-media: —— 素材目录是用户可写的'
  )
  record(
    'CSP 里 yjai-media: 仍在 img-src / media-src / connect-src 三处',
    /img-src[^;]*yjai-media:/.test(html) &&
      /media-src[^;]*yjai-media:/.test(html) &&
      /connect-src[^;]*yjai-media:/.test(html)
  )
}

/* 5) 打包：两个资源目录都要进 extraResources，否则只在安装版里缺 */
{
  const yml = read(BUILDER)
  record('打包带上了 mediapipe（wasm + 模型）', /from: resources\/mediapipe/.test(yml))
  record('打包带上了 facefx（遮罩 / 描边贴图）', /from: resources\/facefx/.test(yml))
}

/* 6) 运行时三个文件在位（不入库，要先跑抓取脚本） */
{
  const need = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'face_landmarker.task']
  const missing = need.filter((n) => {
    try {
      return fs.statSync(path.join(RES_MP, n)).size < 1000
    } catch {
      return true
    }
  })
  record(
    '人物特效运行时齐备（wasm 加载器 / wasm / 模型）',
    missing.length === 0,
    missing.length ? `缺 ${missing.join('、')} —— 先跑 node tools/fetch-mediapipe.mjs` : ''
  )
  const fxMissing = ['mask-ellipse.png', 'frame-ellipse.png'].filter((n) => {
    try {
      return fs.statSync(path.join(RES_FX, n)).size < 500
    } catch {
      return true
    }
  })
  record(
    '两枚贴图齐备（遮罩 / 描边）',
    fxMissing.length === 0,
    fxMissing.length ? `缺 ${fxMissing.join('、')} —— 先跑 py tools/gen-facefx.py` : ''
  )
}

/* 7) 接线三段：左栏节点 → 面板分支 → App 传参 */
{
  const treeSrc = read(TREE)
  const panelSrc = read(PANEL)
  const appSrc = read(APP)
  record(
    '左栏有「人物特效」且指向 panel=facefx',
    /key: 'ef-face'[^}]*panel: 'facefx'/.test(treeSrc),
    '左栏没有 ef-face 节点'
  )
  record(
    '面板有 facefx 分支且把三个回调接全',
    panelSrc.includes("mode === 'facefx'") &&
      panelSrc.includes('onDetectFace') &&
      panelSrc.includes('FaceFxPanel')
  )
  record(
    'App 真的把 onDetectFace 传下去了（漏传 = 点识别没反应）',
    appSrc.includes('onDetectFace={detectFaceForClip}')
  )
}

/* 8) 导出顺序：人物特效必须在边框**之前**（边框是画框，压在最上层） */
{
  const src = read(RENDER)
  const atFace = src.indexOf('appendFaceFx({')
  const atBorder = src.indexOf('borderFileOf(clip.border)', atFace > 0 ? atFace : 0)
  record(
    '导出链里人物特效排在边框之前',
    atFace > 0 && atBorder > atFace,
    `face@${atFace} border@${atBorder}`
  )
  record(
    '导出的跟踪数据读 clip.faceTrack（与"套哪款效果"解耦）',
    src.includes('clip.faceTrack')
  )
}

/* 9) 主进程两个接口都在，且 loader 那条**不接受入参**（否则成了任意文件读取） */
{
  const mainSrc = read(MAIN)
  const preloadSrc = read(PRELOAD)
  record(
    'IPC 有两个接口：帧运行时位置 / 加载器源码',
    mainSrc.includes("'facefx:runtime'") && mainSrc.includes("'facefx:loader'")
  )
  record(
    'facefx:loader 不接受任何入参（路径由主进程自己算）',
    /ipcMain\.handle\('facefx:loader', async \(\) =>/.test(mainSrc),
    'handler 带了入参 ⇒ 渲染层可以指定读哪个文件'
  )
  record(
    'preload 只暴露 runtime / loader 两个方法',
    preloadSrc.includes('facefx: {') && preloadSrc.includes('loader: () => ipcRenderer.invoke')
  )
  record(
    'facefx:runtime 只回四个字段（ok / missing / wasm / model，不含磁盘路径）',
    /return \{ ok: rt\.ok, missing: rt\.missing, wasm: rt\.wasm, model: rt\.model \}/.test(mainSrc),
    '返回体变了 —— 多出来的字段可能把磁盘路径漏给渲染层'
  )
  record(
    '运行时目录解析复用同一套三处兜底（打包 → 源码 → appPath）',
    read(MAIN_FACEFX).includes('process.resourcesPath') === false &&
      read(MAIN_FACEFX).includes('resourcesPath') &&
      read(MAIN_FACEFX).includes('mainDir') &&
      read(MAIN_FACEFX).includes('appPath')
  )
}

/* ============================ 二、真机 ============================ */

if (!STATIC_ONLY) {
  console.log('\n[真机] 识别 → 面板 → 预览跟随 → 成片跟随\n')
  let app = null
  let framesDir = ''
  /* 提到 try 外面：中断时 catch 要能读它把白屏原因打出来 */
  let pageErrors = []
  /* 只有真机那 8 条全跑完才置真。中断时 results 里一条真机都没有，
     静态 23 条照样全绿 ⇒ 旧写法会给一个"什么都没验"的全绿。 */
  let realDone = false
  let interrupt = ''
  try {
    if (!fs.existsSync(FIXTURE)) {
      skip('真机：夹具存在', `缺 ${path.relative(ROOT, FIXTURE)}`)
      throw new Error('no-fixture')
    }
    const { _electron: electron } = await import('playwright-core')
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-face-'))
    framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-face-out-'))
    const env = { ...process.env, NODE_ENV: 'production' }
    delete env.ELECTRON_RUN_AS_NODE

    app = await electron.launch({
      executablePath: MAIN_EXE,
      args: [
        path.join(SRC, 'main', 'index.js'),
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--disable-dev-shm-usage'
      ],
      cwd: ROOT,
      env
    })
    const page = await app.firstWindow()
    pageErrors = []
    page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
    /* MediaPipe 把 INFO 级别的日志也走 console.error，那是它的常态输出，不是故障。
       只放行这一种前缀（必须窄）：宽成"忽略所有 INFO"就等于把真错误也放过。 */
    const MP_INFO = /^INFO: /
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      if (MP_INFO.test(m.text())) return
      pageErrors.push('[console.error] ' + m.text())
    })

    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMaximized()) win.unmaximize()
        win.setContentSize(1920, 1032)
        win.center()
      }
    }, null)
    await page.waitForTimeout(1500)

    /* 把夹具登记进白名单并拿 URL（media:stat 会 describeMedia + allowedMedia.add） */
    const info = await page.evaluate((p) => window.yjai.media.stat([p]), [FIXTURE])
    const url = info && info[0] ? info[0].url : ''
    if (!url) {
      skip('真机：夹具能读出地址', 'media:stat 没返回 url')
      throw new Error('no-url')
    }

    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: '人物特效 E2E',
        data: {
          clips: [
            {
              id: 'v1',
              track: 'video',
              name: '移动人脸',
              assetId: 'a1',
              url,
              path: FIXTURE,
              kind: 'video',
              start: 0,
              duration: 3,
              offset: 0,
              sourceDuration: 3
            },
            {
              /* 字幕片段：用来验证"选了非画面片段时给提示"，
                 这是真实边界（用户在字幕上点人物特效）。 */
              id: 't1',
              track: 'text',
              assetId: '',
              name: '字幕一',
              kind: 'text',
              text: '字幕一',
              textStyle: 'sub-plain',
              start: 0,
              duration: 3,
              offset: 0
            }
          ],
          assets: [{ id: 'a1', name: '移动人脸', url, path: FIXTURE, kind: 'video', duration: 3, source: 'local' }],
          playhead: 0,
          volume: 100,
          zoom: 1
        }
      }
    )
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.waitForTimeout(400)
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await page.waitForTimeout(600)

    /* ① 特效页 → 左栏「人物特效」 */
    await page.locator('.wb-tab[data-wb-tab="effect"]').click()
    await page.waitForTimeout(500)
    const faceNode = page.locator('.wb-node[data-wb-node="ef-face"]')
    const hasNode = (await faceNode.count()) > 0
    record('真机：左栏「特效 → 人物特效」存在', hasNode)
    if (!hasNode) throw new Error('no-node')

    /* ② 选了非画面片段（字幕）时要有明确提示，不是空白面板。
       ⚠️ 不去断言"完全没选片段"：面板的取值是 `selectedClip || activeClip`，
          「播放头下的画面片段」会一直兜着底 —— 那个状态在产品里根本不存在，
          硬造只能靠把播放头挪到覆盖范围外，断言随素材长度漂。
          真实的边界是「用户在字幕上点了人物特效」，它稳定可复现。 */
    await faceNode.first().click()
    await page.waitForTimeout(500)
    await page.locator('.clip[data-clip="t1"]').click()
    await page.waitForTimeout(400)
    const emptyHint = await page
      .locator('[data-face-empty="wrong-track"]')
      .first()
      .textContent()
      .catch(() => '')
    record(
      '真机：选字幕片段时给的是提示，不是空白',
      Boolean(emptyHint && emptyHint.trim().length > 4),
      emptyHint || '(空)'
    )

    /* ③ 选中时间线上的片段 → 识别。类名是 `.clip[data-clip=<片段 id>]`，
       不是臆想的 `.tl-clip`。 */
    await page.locator('.clip[data-clip="v1"]').click()
    await page.waitForTimeout(400)
    const detectBtn = page.locator('[data-face-detect]')
    record('真机：选中片段后面板给出「识别人脸」', (await detectBtn.count()) > 0)
    await detectBtn.first().click()

    /* 识别是逐帧 seek，3 秒 × 12fps 约 2~4 秒；等到面板自己说 ready。
       ⚠️ 判据不用"按钮文字变没变"，而是下面从**草稿里读回来的 track** ——
          面板文案可以撒谎，落盘的数组不会。 */
    let statAttr = ''
    let panelErr = ''
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(500)
      statAttr = await page
        .locator('[data-face-stat]')
        .first()
        .getAttribute('data-face-stat')
        .catch(() => '')
      /* 面板自己报的错也要读：识别"跑完但没结果"时，原因只在这里 */
      panelErr = await page
        .locator('[data-face-error]')
        .first()
        .textContent()
        .catch(() => '')
      if (statAttr === 'ready') break
    }
    record(
      '真机：识别跑完，面板进入 ready',
      statAttr === 'ready',
      `stat=${statAttr}${panelErr ? `｜面板报错：${panelErr.trim()}` : ''}`
    )

    /* 自动保存是内容变化后 1.2 秒落盘 —— 等它写完再读，否则读到的是识别前那份 */
    await page.waitForTimeout(2200)
    const trackOf = async () => {
      return page.evaluate(async () => {
        const rows = await window.yjai.draft.list()
        if (!rows || !rows.length) return null
        const one = await window.yjai.draft.load(rows[0].id)
        const clips = (one && one.data && one.data.clips) || []
        const clip = clips.find((c) => c.id === 'v1')
        return clip && Array.isArray(clip.faceTrack) ? clip.faceTrack : null
      })
    }
    const track = await trackOf()
    record(
      '真机：识别结果真的落进草稿（clip.faceTrack 是一串 [t,x,y,w,h]）',
      Array.isArray(track) && track.length >= 5 && Array.isArray(track[0]) && track[0].length === 5,
      track ? `长度 ${track.length}，首项 ${JSON.stringify(track[0])}` : '(没有 faceTrack)'
    )

    /* ④ 套「主角描边」→ 预览出现跟随层 */
    const frameCard = page.locator('[data-face-grid] [data-face-fx="frame"]')
    record('真机：效果卡可点（识别完成才启用）', (await frameCard.count()) > 0)
    await frameCard.first().click()
    await page.waitForTimeout(600)
    const hasLayer = await page.locator('.canvas-face[data-face-fx]').count()
    record('真机：预览里出现人物特效层', hasLayer > 0, `${hasLayer} 层`)

    /* ⑤ 挪播放头，看位置真的变（判据 = 两个时刻的 left 不同）。
       位置按**片段自身的几何**算比例，不用"总时长"：标尺上没有 data-duration，
       写死 3 秒会变成"恰好夹具是 3 秒才过" —— 换成 10 秒素材就静默失效。 */
    const readLeft = async (ratio) => {
      await page.evaluate((r) => {
        const ruler = document.querySelector('[data-ruler]')
        const clip = document.querySelector('.clip[data-clip="v1"]')
        if (!ruler || !clip) return
        const cr = clip.getBoundingClientRect()
        const rect = ruler.getBoundingClientRect()
        const x = cr.left + cr.width * r
        ruler.dispatchEvent(
          new PointerEvent('pointerdown', { clientX: x, clientY: rect.top + 4, bubbles: true })
        )
      }, ratio)
      await page.waitForTimeout(700)
      return page.evaluate(() => {
        const el = document.querySelector('.canvas-face[data-face-fx]')
        if (!el) return null
        return { left: parseFloat(el.style.left || '0'), box: el.getAttribute('data-face-box') || '' }
      })
    }
    const at03 = await readLeft(0.1)
    const at26 = await readLeft(0.87)
    record(
      '真机：预览里的特效层随播放头移动（不是钉在原地）',
      Boolean(at03 && at26 && at26.left > at03.left + 5),
      `片段 10% 处 ${JSON.stringify(at03)} → 87% 处 ${JSON.stringify(at26)}`
    )

    /* ⑥ 成片也跟得上：真导出 3 秒，取两个时刻的帧，从像素里找描边位置 */
    const outPath = path.join(framesDir, 'facefx.mp4')
    const renderRes = await page.evaluate(
      (payload) =>
        window.yjai.render
          .start(payload)
          .then((r) => ({ ok: true, out: r }))
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
      {
        clips: [
          {
            id: 'v1',
            track: 'video',
            name: '移动人脸',
            url,
            path: FIXTURE,
            kind: 'video',
            start: 0,
            duration: 3,
            offset: 0,
            sourceDuration: 3,
            face: { fx: 'frame', strength: 0.7 },
            /* 真实识别出来的那份 track —— 这里如果留空，成片里什么都不会发生，
               而"什么都没发生"正是这道闸门要挡的事，所以宁可把数据显式传进去 */
            faceTrack: track
          }
        ],
        outPath,
        options: { width: 1280, height: 720, fps: 25, codec: 'h264' }
      }
    )
    record('真机：导出命令跑完了', Boolean(renderRes && renderRes.ok), JSON.stringify(renderRes).slice(0, 180))

    if (renderRes && renderRes.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      const W = 1280
      const H = 720
      const raw = path.join(framesDir, 'frames.rgb')
      const ok = await dumpFrames(outPath, raw, [Math.round(0.4 * 25), Math.round(2.6 * 25)])
      if (!ok) {
        skip('真机：成片里描边跟着脸走', '取帧失败（ffmpeg 不可用？）')
      } else {
        const buf = fs.readFileSync(raw)
        const frameSize = W * H * 3
        const cx = (offset) => {
          let sum = 0
          let n = 0
          for (let y = 0; y < H; y += 2) {
            for (let x = 0; x < W; x += 2) {
              const i = offset + (y * W + x) * 3
              const r = buf[i]
              const g = buf[i + 1]
              const b = buf[i + 2]
              /* 描边色 #7c5cff（压缩后会漂）：蓝高、红中、绿偏低 */
              if (b > 190 && r > 70 && r < 175 && g > 40 && g < 135) {
                sum += x
                n += 1
              }
            }
          }
          return n > 30 ? sum / n : null
        }
        const a = cx(0)
        const b = cx(frameSize)
        record(
          '真机：成片里描边跟着脸走（两个时刻的像素位置不同）',
          a !== null && b !== null && b > a + 60,
          `x@0.4s=${a === null ? '未找到描边' : a.toFixed(0)}  x@2.6s=${b === null ? '未找到描边' : b.toFixed(0)}`
        )
      }
    } else {
      skip('真机：成片里描边跟着脸走', '导出没产出文件')
    }

    /* ⑦ 全程 0 页面错误 */
    record('真机：全程 0 页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
    realDone = true
  } catch (err) {
    interrupt = String((err && err.message) || err)
    const planned = ['no-fixture', 'no-url', 'no-node']
    if (!planned.includes(interrupt)) {
      console.log(`      （真机中断：${interrupt}）`)
      /* 白屏的唯一线索就在这里，别等下次再猜 */
      if (pageErrors.length) {
        console.log('      页面错误：\n        ' + pageErrors.slice(0, 6).join('\n        '))
      }
    }
  } finally {
    record(
      '真机：整套跑到底（中断不算通过）',
      realDone,
      interrupt ? `中断于：${interrupt}` : '没走到最后一条断言'
    )
    try {
      if (app) await Promise.race([app.close(), sleep(8000)])
    } catch {
      /* 落到强杀 */
    }
  }
}

/** 用 ffmpeg 把指定帧号抽成 rgb24 裸数据（纯 Node 读像素，不依赖 python） */
function dumpFrames(video, outRaw, indexes) {
  const expr = indexes.map((n) => `eq(n\\,${n})`).join('+')
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    video,
    '-vf',
    `select='${expr}'`,
    '-vsync',
    '0',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-y',
    outRaw
  ]
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => {
      err += String(d)
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => {
      if (code !== 0) {
        console.log(`      ffmpeg 取帧失败：${err.slice(0, 200)}`)
        resolve(false)
        return
      }
      resolve(fs.existsSync(outRaw) && fs.statSync(outRaw).size >= 1280 * 720 * 3 * indexes.length)
    })
  })
}

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok && !r.skipped)
const skipped = results.filter((r) => r.skipped)
console.log(
  `\nFACEFX_STATS total=${results.length} pass=${results.filter((r) => r.ok).length} fail=${failed.length} skip=${skipped.length}`
)
if (failed.length) {
  console.log('失败项：\n  ' + failed.map((r) => r.name).join('\n  '))
  process.exit(1)
}
console.log('FACEFX_OK')
