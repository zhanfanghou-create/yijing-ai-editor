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
export default function SidePanels() {
  const startRender = async () => {
    const result = await bridge.render.start({
      outPath: target,
      options: { width: 1920, height: 1080 },
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
  /* 带 alpha 又没背景时压到黑底：否则编码器直接丢掉 alpha，透明只存在于滤镜图里 */
  if (needAlpha && !withBackdrop) {
    filters.push('color=c=black:s=1920x1080[blkbg]')
    filters.push('[blkbg]' + videoLabel + 'overlay=0:0:format=auto[vflat]')
  }
  return { args: filters }
}

async function render({ clips, outPath, options, onProgress, ffmpegPath, signal, backdrop = '' }) {
  const stageBackdrop = backdropToLocal(backdrop)
  const effectMasks = await prepareEffectMasks(bin, clips, options)
  const plan = buildPlan({ clips, streamInfo, outPath, options, assumeVideoAudio: true, backdrop: stageBackdrop })
  return plan
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

  /* 17. 源文件缺失 → 退出码 2（"没查成"不能混进"查出问题"） */
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
