#!/usr/bin/env node
/**
 * check-export-contract.mjs 的非空洞自证。
 *
 * 一道"契约闸"最危险的失效方式不是漏报，而是**它其实什么都没比对却报 OK** ——
 * 比如解析失败时 `clip.*` 读到 0 个字段，`子集` 判定自然成立。
 * 所以每一条判据都要有一个"必须红"的夹具，并且红在**对的那条断言**上。
 *
 * 夹具（临时目录里现造现删，不碰仓库真源文件）：
 *   good            完整契约（渲染层发齐字段 + backdrop 三段接力 + 真 overlay）      → 绿
 *   no-framefx      片段映射里删掉 frameFx，而 buildPlan 仍在读 clip.frameFx           → 红在 frameFx
 *   no-backdrop     载荷里删掉 backdrop                                              → 红在 backdrop
 *   ipc-gap         IPC 不转 backdrop（渲染层发了、render() 也收，中间断了）           → 红在 render:start
 *   render-gap      render() 形参不收 backdrop                                       → 红在 render(
 *   no-overlay      withBackdrop 分支在，但整个 filter 链里没有 overlay               → 红在 overlay
 *   extra-field     buildPlan 多读一个 clip.speed，渲染层没发                         → 红在 clip.speed
 *   missing-file    缺 SidePanels.jsx                                               → 退出码 2（不是 1）
 *
 * 用法：node tools/check-export-contract.selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHECKER = path.join(here, 'check-export-contract.mjs')

const results = []
const record = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

/** 三个源文件的「完整契约」版本。刻意写小，只要结构像，判据就能套上 */
const PANELS = `
import { coverTimeAt } from '../../shared/cover.js'
import * as EXPORT_RATE from '../../shared/exportRate.js'
export default function SidePanels() {
  const fps = EXPORT_RATE.readRate('29.97').fps
  const fpsOptions = EXPORT_RATE.RATES.map((item) => item.id)
  const resOptions = EXPORT_RATE.RESOLUTIONS.map((item) => item.id)
  const fpsSelect = <select data-export-fps="1" value={fps} />
  const startRender = async () => {
    const coverOn = true
    const coverAt = coverTimeAt(playhead, 8, 25)
    const result = await bridge.render.start({
      outPath: target,
      options: { width: 1920, height: 1080, fps, codec: codecInfo.key, cover: coverOn ? { enabled: true, at: coverAt } : null },
      backdrop: backdrop || '',
      clips: clips.map((clip) => ({
        id: clip.id,
        track: clip.track,
        kind: clip.kind,
        start: clip.start,
        duration: clip.duration,
        offset: clip.offset || 0,
        path: clip.path || '',
        url: clip.url || '',
        filter: clip.filter || 'none',
        filterIntensity: clip.filterIntensity ?? 1,
        frameFx: clip.frameFx || 'none',
        transition: clip.transition || 'none',
        gain: clip.gain ?? 100,
        speed: clip.speed ?? 1,
        opacity: clip.opacity ?? 100,
        effects: clip.effects || null,
        text: clip.text || '',
        textStyle: clip.textStyle || '',
        assetId: clip.assetId || ''
      }))
    })
    return result
  }
  return null
}
`

const RENDER = `
const speed = require('../shared/speed.js')
const effects = require('../shared/effects.js')
const coverTable = require('../shared/cover.js')
const exportRate = require('../shared/exportRate.js')
const exportCodec = require('../shared/exportCodec.js')
function encodeArgs(options, crf) {
  const pixFmt = exportCodec.pixelFormatFor(options && options.codec, options && options.encoder)
  return ['-c:v', 'libx264', '-pix_fmt', pixFmt]
}
function buildPlan({ clips, streamInfo, outPath, options, assumeVideoAudio = true, backdrop = '' }) {
  const list = clips.filter((clip) => clip.duration > 0.01)
  const videoClips = list.filter((clip) => clip.track !== 'audio' && clip.track !== 'text' && clip.track !== 'overlay')
  const overlayClips = list.filter((clip) => clip.track === 'overlay')
  overlayClips.forEach((clip, i) => { const d = clip.duration })
  const backdropSource = backdropToLocal(backdrop)
  const withBackdrop = Boolean(backdropSource)
  /* 效果（抠像/圆角/蒙版/描边/阴影）都会写 alpha ⇒ 必须参与"这条链要不要带 alpha"的判定 */
  const anyTransparent = [...videoClips, ...overlayClips].some((clip) => {
    if (Number(clip.opacity) < 99.5) return true
    const fx = effects.readEffects(clip.effects)
    return effects.hasClip(fx) || Boolean(fx.key.on) || Boolean(fx.stroke.on) || Boolean(fx.shadow.on)
  })
  const needAlpha = withBackdrop || anyTransparent
  for (const clip of list) {
    const dur = clip.duration
    const offset = clip.offset
    const grade = looks.ffmpegFilterFor(clip.filter, clip.filterIntensity ?? 1)
    const fx = looks.frameFxFilterFor(clip.frameFx, { width: 1920, height: 1080 })
    const id = clip.id
    const kind = clip.kind
    const track = clip.track
    const start = clip.start
    const rate = speed.clipSpeed(clip)
    const eff = effectsStages({ tag: id, clip })
    filters.push(eff.lines)
  }
  const subs = subtitles.buildSubtitleFilters({ clips: list, width: 1920, height: 1080, tmpDir: tmp })
  subs.filters.forEach((f, i) => { filters.push(videoLabel + f) })

  if (withBackdrop) {
    filters.push('[bgv]' + videoLabel + 'overlay=0:0:format=auto[vfin]')
  }
  /* 带 alpha 又没背景时压到黑底：否则编码器直接丢掉 alpha，透明只存在于滤镜图里。
     但「要留 Alpha 的编码格式」（ProRes 4444）不能压 —— 压了 alpha 恒为 1。 */
  const keepAlpha = exportCodec.acceptsAlpha(options && options.codec)
  if (needAlpha && !withBackdrop && !keepAlpha && finalDuration > 0.05) {
    filters.push('color=c=black:s=1920x1080[blkbg]')
    filters.push('[blkbg]' + videoLabel + 'overlay=0:0:format=auto[vflat]')
  }
  return { args: filters }
}

async function render({ clips, outPath, options, onProgress, ffmpegPath, signal, backdrop = '' }) {
  const stageBackdrop = backdropToLocal(backdrop)
  const effectMasks = await prepareEffectMasks(bin, clips, options)
  const plan = buildPlan({ clips, streamInfo, outPath, options, assumeVideoAudio: true, backdrop: stageBackdrop })
  const audio = exportCodec.audioArgs(options && options.codec)
  const result = await runRender(bin, plan.args)
  const coverResult = await writeCover({ bin, outPath, cover: options.cover })
  return { ...plan, coverPath: coverResult.path }
}
`

const SUBS_BLOCK = `  const subs = subtitles.buildSubtitleFilters({ clips: list, width: 1920, height: 1080, tmpDir: tmp })
  subs.filters.forEach((f, i) => { filters.push(videoLabel + f) })

`
const MAIN = `
ipcMain.handle('render:start', async (event, payload) => {
  return await renderTimeline({
    clips: (payload && payload.clips) || [],
    outPath,
    options: (payload && payload.options) || {},
    outPath: exportCodec.matchExtension(outPath, payload && payload.options && payload.options.codec),
    backdrop: (payload && payload.backdrop) || '',
    signal: controller.signal
  })
})
`

const APP = `
export default function App() {
  const dropAssetOnTimeline = (assetId, track, start) => {
    let targetTrack = track === 'audio' || track === 'text' || track === 'overlay' ? track : 'video'
    if (targetTrack === 'overlay') return 'overlay'
    return targetTrack
  }
  return dropAssetOnTimeline
}
`

const STAGE = `
export default function Stage({ asset, pip = null, backdrop = null }) {
  return null
}
`

/* vite 的 commonjs 白名单。渲染层 import 的每个 shared/*.js 都必须在里面，
   否则拿到的是空对象（面板白屏或算出 NaN），而构建与静态扫描都不报。 */
const VITE = `
export default defineConfig({
  build: {
    commonjsOptions: {
      include: [/node_modules/, /shared[\\\\/]cover\\.js$/, /shared[\\\\/]exportRate\\.js$/, /shared[\\\\/]exportCodec\\.js$/]
    }
  }
})
`

const mkRoot = (panels = PANELS, render = RENDER, main = MAIN, opts = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-xc-'))
  const dirs = [
    path.join(root, 'packages', 'desktop', 'src', 'renderer', 'components'),
    path.join(root, 'packages', 'desktop', 'src', 'main')
  ]
  for (const d of dirs) fs.mkdirSync(d, { recursive: true })
  if (!opts.omitPanels) {
    fs.writeFileSync(path.join(dirs[0], 'SidePanels.jsx'), panels)
  }
  fs.writeFileSync(path.join(dirs[1], 'render.js'), render)
  fs.writeFileSync(path.join(dirs[1], 'index.js'), main)
  if (!opts.omitApp) {
    fs.mkdirSync(path.join(root, 'packages', 'desktop', 'src', 'renderer'), { recursive: true })
    fs.writeFileSync(path.join(root, 'packages', 'desktop', 'src', 'renderer', 'App.jsx'), opts.app || APP)
  }
  if (!opts.omitStage) {
    fs.writeFileSync(path.join(dirs[0], 'Stage.jsx'), opts.stage || STAGE)
  }
  fs.writeFileSync(path.join(root, 'packages', 'desktop', 'vite.config.mjs'), opts.vite || VITE)
  return root
}

const run = (root) => {
  const r = spawnCapture(process.execPath, [CHECKER, root], { cwd: root, timeout: 60000 })
  return { status: r.status, out: String(r.stdout || '') }
}

let failures = 0
const expect = (label, got, want) => {
  if (got !== want) {
    failures += 1
    record(label, false, `期望 ${want}，实得 ${got}`)
  } else {
    record(label, true)
  }
}

try {
  /* 1. 完整契约 → 绿 */
  {
    const root = mkRoot()
    const r = run(root)
    expect('good：完整契约退出码 0', r.status, 0)
    record('good：打印 EXPORT_CONTRACT_OK', /EXPORT_CONTRACT_OK/.test(r.out))
    if (!/EXPORT_CONTRACT_OK/.test(r.out)) failures += 1
  }

  /* 2. 漏发 frameFx → 必须红，且红在 frameFx 上 */
  {
    const root = mkRoot(PANELS.replace(/\s*frameFx: clip\.frameFx \|\| 'none',\n/, '\n'))
    const r = run(root)
    expect('no-framefx：退出码 1', r.status, 1)
    const onPoint = /clip\.frameFx/.test(r.out)
    record('no-framefx：报错点名 frameFx（不是泛泛一句）', onPoint)
    if (!onPoint) failures += 1
  }

  /* 3. 载荷里删 backdrop → 必须红 */
  {
    const root = mkRoot(PANELS.replace(/\s*backdrop: backdrop \|\| '',\n/, '\n'))
    const r = run(root)
    expect('no-backdrop：退出码 1', r.status, 1)
    const onPoint = /backdrop/.test(r.out)
    record('no-backdrop：报错点名 backdrop', onPoint)
    if (!onPoint) failures += 1
  }

  /* 4. IPC 断了 → 必须红 */
  {
    const root = mkRoot(PANELS, RENDER, MAIN.replace(/\s*backdrop: \(payload && payload\.backdrop\) \|\| '',\n/, '\n'))
    const r = run(root)
    expect('ipc-gap：退出码 1', r.status, 1)
    const onPoint = /render:start/.test(r.out)
    record('ipc-gap：报错点名 render:start', onPoint)
    if (!onPoint) failures += 1
  }

  /* 5. render() 不收 backdrop → 必须红 */
  {
    // 只改 render() 那一行签名：RENDER 里 buildPlan 的形参也带 backdrop，
    // 用裸 `, backdrop = '' }` 去替换会先命中 buildPlan，改了个不该改的地方
    const root = mkRoot(PANELS, RENDER.replace("signal, backdrop = '' })", 'signal })'))
    const r = run(root)
    expect('render-gap：退出码 1', r.status, 1)
  }

  /* 6. 有 withBackdrop 但没有 overlay → 必须红（"只挖透明"的假接） */
  {
    const root = mkRoot(PANELS, RENDER.replace(/if \(withBackdrop\) \{[\s\S]*?\n  \}/, 'if (withBackdrop) {\n    filters.push("[noop]")\n  }'))
    const r = run(root)
    expect('no-overlay：退出码 1', r.status, 1)
    const onPoint = /overlay/.test(r.out)
    record('no-overlay：报错点名 overlay', onPoint)
    if (!onPoint) failures += 1
  }

  /* 7. buildPlan 多读一个字段 → 必须红 */
  /*    ⚠️ 这里不能用 clip.speed 当"多读的字段"了：渲染层现在**必须**发 speed
         （见下面第 14 条），用它就变成"既该发又该红"，场景自相矛盾。
         换一个渲染层确实不发的字段（caption），语义不变。 */
  {
    const root = mkRoot(PANELS, RENDER.replace('const start = clip.start', 'const start = clip.start\n    const caption = clip.caption'))
    const r = run(root)
    expect('extra-field：退出码 1', r.status, 1)
    const onPoint = /clip\.caption/.test(r.out)
    record('extra-field：报错点名 clip.caption', onPoint)
    if (!onPoint) failures += 1
  }

  /* 8. 叠加轨没从主链排除 → 必须红（成片会凭空多出一段） */
  {
    const root = mkRoot(PANELS, RENDER.replace(" && clip.track !== 'overlay'", ''))
    const r = run(root)
    expect('pip-in-mainchain：退出码 1', r.status, 1)
    const onPoint = /叠加轨/.test(r.out)
    record('pip-in-mainchain：报错点名叠加轨', onPoint)
    if (!onPoint) failures += 1
  }

  /* 9. App 没有把片段放进叠加轨的通路 → 必须红（轨道存在但没入口） */
  {
    const root = mkRoot(PANELS, RENDER, MAIN, { app: APP.replace("|| track === 'overlay'", '') })
    const r = run(root)
    expect('no-pip-entry：退出码 1', r.status, 1)
    const onPoint = /叠加轨/.test(r.out)
    record('no-pip-entry：报错点名叠加轨', onPoint)
    if (!onPoint) failures += 1
  }

  /* 10. Stage 不接收 pip → 必须红（画中画只在成片里有、预览里看不见） */
  {
    const root = mkRoot(PANELS, RENDER, MAIN, { stage: STAGE.replace('pip = null', '') })
    const r = run(root)
    expect('no-pip-preview：退出码 1', r.status, 1)
    const onPoint = /pip/.test(r.out)
    record('no-pip-preview：报错点名 pip', onPoint)
    if (!onPoint) failures += 1
  }

  /* 11. 片段没带 text → 必须红（字幕写不进成片） */
  {
    const root = mkRoot(PANELS.replace("        text: clip.text || '',", ""))
    const r = run(root)
    expect('no-sub-field：退出码 1', r.status, 1)
    const onPoint = /text/.test(r.out)
    record('no-sub-field：报错点名 text', onPoint)
    if (!onPoint) failures += 1
  }

  /* 12. render 不把字幕翻译成 drawtext → 必须红（预览有字幕、成片里没有） */
  {
    const root = mkRoot(PANELS, RENDER.replace(SUBS_BLOCK, ''))
    const r = run(root)
    expect('no-subtitle：退出码 1', r.status, 1)
    const onPoint = /drawtext|字幕/.test(r.out)
    record('no-subtitle：报错点名字幕', onPoint)
    if (!onPoint) failures += 1
  }

  /* 13. 字幕串在画中画之前 → 必须红（字幕会被画中画盖住） */
  {
    const bad = RENDER.replace(SUBS_BLOCK, '').replace('  overlayClips.forEach', SUBS_BLOCK + '  overlayClips.forEach')
    const root = mkRoot(PANELS, bad)
    const r = run(root)
    expect('sub-before-pip：退出码 1', r.status, 1)
    const onPoint = /盖住/.test(r.out)
    record('sub-before-pip：报"字幕会被画中画盖住"', onPoint)
    if (!onPoint) failures += 1
  }

  /* 14. 渲染层漏发 speed → 必须红（成片里所有片段都按原速渲染） */
  {
    const root = mkRoot(PANELS.replace(/\s*speed: clip\.speed \?\? 1,\n/, '\n'))
    const r = run(root)
    expect('no-speed-field：退出码 1', r.status, 1)
    const onPoint = /speed/.test(r.out)
    record('no-speed-field：报错点名 speed', onPoint)
    if (!onPoint) failures += 1
  }

  /* 15. 主进程用了 clipSpeed 却没引用 shared/speed.js → 必须红（真源分叉） */
  {
    const root = mkRoot(PANELS, RENDER.replace("const speed = require('../shared/speed.js')\n", ''))
    const r = run(root)
    expect('speed-not-shared：退出码 1', r.status, 1)
    const onPoint = /shared[\\/]speed\.js/.test(r.out)
    record('speed-not-shared：报错点名 shared/speed.js', onPoint)
    if (!onPoint) failures += 1
  }

  /* 16. 主进程自己又定义一份 clipSpeed → 必须红（两份都"能跑"，错的是不一致） */
  {
    const root = mkRoot(
      PANELS,
      RENDER.replace('const speed = ', 'function clipSpeed(clip) { return 1 }\nconst speed = ')
    )
    const r = run(root)
    expect('speed-duplicated：退出码 1', r.status, 1)
    const onPoint = /clipSpeed/.test(r.out)
    record('speed-duplicated：报错点名 clipSpeed', onPoint)
    if (!onPoint) failures += 1
  }

  /* 18. 面板漏发 options.cover → 必须红（勾了「导出封面图」也不会生成任何文件） */
  {
    const root = mkRoot(PANELS.replace(', cover: coverOn ? { enabled: true, at: coverAt } : null', ''))
    const r = run(root)
    expect('no-cover-field：退出码 1', r.status, 1)
    const onPoint = /options\.cover/.test(r.out)
    record('no-cover-field：报错点名 options.cover', onPoint)
    if (!onPoint) failures += 1
  }

  /* 19. 抽封面写在 runRender 之前 → 必须红（读到的会是上一轮的旧成片） */
  {
    const reversed = RENDER.replace(
      '  const result = await runRender(bin, plan.args)\n  const coverResult = await writeCover({ bin, outPath, cover: options.cover })',
      '  const coverResult = await writeCover({ bin, outPath, cover: options.cover })\n  const result = await runRender(bin, plan.args)'
    )
    const root = mkRoot(PANELS, reversed)
    const r = run(root)
    expect('cover-before-render：退出码 1', r.status, 1)
    const onPoint = /runRender 之前/.test(r.out)
    record('cover-before-render：报错点名「runRender 之前」', onPoint)
    if (!onPoint) failures += 1
  }

  /* 20. 帧率又变回滑杆 → 必须红（滑杆落不到 25 / 50 / 29.97 / 59.94） */
  {
    const slid = PANELS.replace(
      'const fpsSelect = <select data-export-fps="1" value={fps} />',
      'const fpsSelect = <Slider label="帧率" min={24} max={60} step={6} value={fps} onChange={setFps} />'
    )
    const root = mkRoot(slid)
    const r = run(root)
    expect('fps-slider：退出码 1', r.status, 1)
    const onPoint = /滑杆/.test(r.out)
    record('fps-slider：报错点名「滑杆」', onPoint)
    if (!onPoint) failures += 1
  }

  /* 21. 主进程不引用 exportRate → 必须红（帧率换算会与面板各写一份） */
  {
    const root = mkRoot(PANELS, RENDER.replace("const exportRate = require('../shared/exportRate.js')", ''))
    const r = run(root)
    expect('no-exportRate-in-render：退出码 1', r.status, 1)
    const onPoint = /exportRate\.js/.test(r.out)
    record('no-exportRate-in-render：报错点名 exportRate.js', onPoint)
    if (!onPoint) failures += 1
  }

  /* 22. vite 白名单漏 exportRate → 必须红（渲染层拿到空对象，右栏白屏）
     ⚠️ 夹具的改法：把 `exportRate` 改个名字，等价于"白名单里没有这一条"，
        但不用跟模板字符串里的反斜杠转义较劲 —— 那层转义写错一次，
        这条反例就会"照样通过"，而它恰恰是用来证明检查器不是空转的。 */
  {
    const root = mkRoot(PANELS, RENDER, MAIN, { vite: VITE.replace('exportRate', 'exportRateX') })
    const r = run(root)
    expect('vite-missing-exportRate：退出码 1', r.status, 1)
    const onPoint = /exportRate\.js/.test(r.out)
    record('vite-missing-exportRate：报错点名 exportRate.js', onPoint)
    if (!onPoint) failures += 1
  }

  /* 23. encodeArgs 写死 8 位像素格式 → 必须红（选了 10bit 也还是 8 位） */
  {
    const root = mkRoot(PANELS, RENDER.replace("'-pix_fmt', pixFmt]", "'-pix_fmt', 'yuv420p']"))
    const r = run(root)
    expect('codec-hardcoded：退出码 1', r.status, 1)
    const onPoint = /yuv420p/.test(r.out) && /pixelFormatFor|位像素格式|10bit/.test(r.out)
    record('codec-hardcoded：报错点名写死的 yuv420p（不是泛泛一句）', onPoint)
    if (!onPoint) failures += 1
  }

  /* 24. 面板不发编码格式 → 必须红（选了 ProRes，成片还是 H.264 的 MP4） */
  {
    const root = mkRoot(PANELS.replace(' codec: codecInfo.key,', ''))
    const r = run(root)
    expect('no-codec-in-panels：退出码 1', r.status, 1)
    const onPoint = /options\.codec/.test(r.out)
    record('no-codec-in-panels：报错点名 options.codec', onPoint)
    if (!onPoint) failures += 1
  }

  /* 25. 压黑那步不排除「要留 Alpha 的格式」→ 必须红（ProRes 4444 白选） */
  {
    const root = mkRoot(PANELS, RENDER.replace('!keepAlpha && ', ''))
    const r = run(root)
    expect('alpha-flattened：退出码 1', r.status, 1)
    const onPoint = /Alpha/.test(r.out) && /keepAlpha|压黑/.test(r.out)
    record('alpha-flattened：报错点名压黑 / Alpha', onPoint)
    if (!onPoint) failures += 1
  }

  /* 23. 源文件缺失 → 退出码 2（"没查成"不能混进"查出问题"） */
  {
    const root = mkRoot(PANELS, RENDER, MAIN, { omitPanels: true })
    const r = run(root)
    expect('missing-file：退出码 2', r.status, 2)
  }

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  console.log('')
  console.log(`=== 结果：通过 ${passed} 项 / 失败 ${failures} 项 ===`)
  console.log('EXPORT_CONTRACT_SELFTEST_STATS total=' + total + ' pass=' + passed + ' fail=' + failures)
  if (failures === 0) console.log('EXPORT_CONTRACT_SELFTEST_OK')
  process.exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error('自证脚本自身异常：')
  console.error(String((error && error.stack) || error))
  process.exitCode = 1
}
