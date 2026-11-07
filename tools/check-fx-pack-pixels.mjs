#!/usr/bin/env node
/**
 * 素材型画面特效的**真渲染**闸门：预览里真的在播 + 导出真的叠上去了。
 *
 * ## 为什么两道都要
 * `check-fx-packs` 证明了"包里的帧是真的、在动、接得上"，但它证明不了：
 *   · 预览那一层到底有没有显示出来（CSS 类挂上了、background-image 加载失败 →
 *     computedStyle 一切正常、画面一像素没有）；
 *   · 成片到底叠没叠（`looks.frameFxFilterFor` 对这些键返回空串，如果 render.js
 *     那段 overlay 没接上，导出**完全正常、不报错**，只是没有特效）。
 *
 * 这两类都属于「接了但看不见 / 接了但没生效」，静态判据一律抓不到。
 *
 * ## 做法
 *   A. 预览：真实 Electron 里挂应用自己的 `.canvas-fx.fx-pack.fm-bubble` + 内联雪碧图，
 *      隔 500ms 截两张图 —— 既要"有内容"，也要"两张不一样"（证明 steps 动画在走）。
 *   B. 导出：直接调主进程的 `render.buildPlan` 造两条计划（有 / 无特效），真跑 ffmpeg，
 *      抽同一时刻的帧比像素 —— 只有成片层面能证明"素材真的叠上去了"。
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const FF =
  process.env.FFMPEG_PATH ||
  (fs.existsSync('D:/ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe')
    ? 'D:/ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe'
    : 'ffmpeg')
const TAG = process.env.YJAI_FX_PACK_TAG || String(process.pid)
const TMP = path.join(os.tmpdir(), 'yjai-e2e', 'fx-pack-pixel', TAG)
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.fx-pack-profile-${TAG}`)
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

/**
 * app.close() 的超时兜底。
 * ⚠️ 必须包：这个环境里 `app.close()` 有可能**永不返回**（实测挂死 28 分钟，
 *    断言早就跑完、结论也落盘了，卡住的只是退出那一步）。`check-e2e-teardown`
 *    会扫每个 `app.close()`，裸等直接判红。
 */
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

const require = createRequire(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'x.js'))
const fxpack = require('./fxpack')
const render = require('./render')

const results = []
const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail })

const env = { ...process.env, YJAI_NO_WINDOW: '1', YJAI_PROFILE: PROFILE }
delete env.ELECTRON_RUN_AS_NODE

/* ============================ A. 预览真的在播 ============================ */

let previewMetrics = null
const app = await electron.launch({ executablePath: EXE, args: [MAIN], env })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  /* 渲染层自己那次请求会顺带把内置包装上；这里再问一次拿 URL，
     走的是**应用同一个** IPC —— 不是我们另外拼的路径。 */
  const state = await page.evaluate(async () => {
    const api = window.yjai && window.yjai.fxpack
    if (!api) return { unsupported: true }
    return api.state()
  })

  const effects = (state && state.effects) || {}
  const keys = Object.keys(effects)
  add('主进程报得出 10 个素材特效', keys.length === 10, `${keys.length} 个：${keys.slice(0, 4).join(',')}…`)
  add(
    '每个效果都有雪碧图 URL（缺了就是"覆盖层是空的"）',
    keys.every((k) => /^yjai-media:\/\//.test(String(effects[k].sheetUrl || ''))),
    keys.filter((k) => !/^yjai-media:\/\//.test(String(effects[k].sheetUrl || ''))).join(',') || '全部有'
  )
  add(
    '包信息能被界面读到（用于"未安装"提示）',
    Array.isArray(state && state.packs) && state.packs.length > 0 && state.packs[0].count === 10,
    JSON.stringify(state && state.packs)
  )

  /* 挂一层真实覆盖层：类名与内联参数完全按 Stage.jsx 的算法来 */
  const meta = effects['fm-bubble']
  if (meta) {
    await page.evaluate(
      ({ url, frames, fps }) => {
        document.getElementById('fxpack-probe')?.remove()
        const box = document.createElement('div')
        box.id = 'fxpack-probe'
        box.style.cssText =
          'position:fixed;left:0;top:0;width:480px;height:270px;z-index:2147483000;background:#243447;'
        const fx = document.createElement('span')
        fx.className = 'canvas-fx fx-pack fm-bubble'
        fx.style.animationDuration = `${(frames / fps).toFixed(3)}s`
        fx.style.animationTimingFunction = `steps(${frames})`
        fx.style.backgroundImage = `url("${url}")`
        fx.style.backgroundSize = `${frames * 100}% 100%`
        box.appendChild(fx)
        document.body.appendChild(box)
      },
      { url: meta.sheetUrl, frames: meta.frames, fps: meta.fps }
    )
    /* 等雪碧图解码完，再取两个相隔半个循环的时刻 */
    await page.waitForTimeout(900)
    const css = await page.evaluate(() => {
      const el = document.querySelector('#fxpack-probe .canvas-fx')
      if (!el) return {}
      const s = getComputedStyle(el)
      return {
        name: s.animationName,
        timing: s.animationTimingFunction,
        image: s.backgroundImage.slice(0, 60),
        size: s.backgroundSize,
        pos: s.backgroundPosition
      }
    })
    add('覆盖层的动画规则命中（fx-pack-run）', /fx-pack-run/.test(css.name || ''), css.name)
    add('steps 步进生效（不是 linear 匀速插值）', /steps\(/.test(css.timing || ''), css.timing)
    add('雪碧图真的加载了（computed background-image 含 yjai-media）', /yjai-media/.test(css.image || ''), css.image)

    const shotA = path.join(TMP, 'preview-a.png')
    const shotB = path.join(TMP, 'preview-b.png')
    const clip = { x: 0, y: 0, width: 480, height: 270 }
    await page.screenshot({ path: shotA, clip })
    await page.waitForTimeout(700)
    await page.screenshot({ path: shotB, clip })
    previewMetrics = { shotA, shotB }
  }
} finally {
  await withTimeout(app.close(), 8000, 'app.close').catch(() => {})
}

/* ============================ B. 导出真的叠了 ============================ */

const fxDeps = {
  resourcesPath: path.join(ROOT, 'packages', 'desktop', 'resources'),
  appPath: path.join(ROOT, 'packages', 'desktop'),
  mainDir: path.join(ROOT, 'packages', 'desktop', 'src', 'main'),
  userData: path.join(os.tmpdir(), 'yjai-e2e', 'fxpack-gate'),
  mediaUrlOf: (p) => `yjai-media://local/${p}`
}
const fxPacks = fxpack.effects(fxDeps)
add('导出侧能解析到帧目录（不是只有预览能用）', Boolean(fxPacks['fm-bubble'] && fxPacks['fm-bubble'].dir), fxPacks['fm-bubble'] && fxPacks['fm-bubble'].dir)

/* 造一条 2 秒底片 */
const base = path.join(TMP, 'base.mp4')
execFileSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi',
  '-i', 'color=c=0x2b3a4a:s=480x270:r=25', '-t', '2', '-pix_fmt', 'yuv420p', base], { timeout: 120000 })

const planOf = (frameFx) => {
  const clips = [{
    id: 'c1',
    kind: 'video',
    track: 'video',
    path: base,
    url: `file:///${base.replace(/\\/g, '/')}`,
    start: 0,
    duration: 2,
    offset: 0,
    frameFx
  }]
  return render.buildPlan({
    clips,
    streamInfo: {},
    outPath: path.join(TMP, `out-${frameFx || 'none'}.mp4`),
    options: { width: 480, height: 270, fps: 25, quality: 80, codec: 'h264' },
    assumeVideoAudio: false,
    ffmpegPath: FF,
    effectMasks: null,
    fxPacks
  })
}

const plan = planOf('fm-bubble')
const argText = (plan.args || []).join(' ')
add('计划里把帧序列挂成了循环输入（-stream_loop -1）', /-stream_loop -1/.test(argText), '-stream_loop -1')
add(
  '计划里有按区间生效的 overlay（enable=between）',
  /overlay=0:0:format=auto:enable='between\(t,/.test(argText),
  (argText.match(/overlay=[^;]*enable=[^;\]]*/) || ['(没有)'])[0].slice(0, 80)
)
add(
  '计划里帧序号路径指向真实文件（f%03d.png 且目录存在）',
  argText.includes('f%03d.png') && fs.existsSync(fxPacks['fm-bubble'].dir),
  fxPacks['fm-bubble'].dir
)

let exportDiff = null
try {
  execFileSync(FF, plan.args, { timeout: 240000, stdio: 'pipe' })
  const planNone = planOf('none')
  execFileSync(FF, planNone.args, { timeout: 240000, stdio: 'pipe' })
  /* 抽同一时刻（1.0s）各一帧，量平均像素差 */
  const a = path.join(TMP, 'frame-fx.png')
  const b = path.join(TMP, 'frame-none.png')
  execFileSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', '-ss', '1', '-i',
    path.join(TMP, 'out-fm-bubble.mp4'), '-frames:v', '1', a], { timeout: 120000 })
  execFileSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', '-ss', '1', '-i',
    path.join(TMP, 'out-none.mp4'), '-frames:v', '1', b], { timeout: 120000 })
  const stat = JSON.parse(execFileSync('python', ['-W', 'ignore', '-c', `
import json, sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
d = ImageChops.difference(a, b).convert('L')
px = list(d.getdata())
# ⚠️ 不能只看全画面平均差：泡泡只覆盖 2% 的像素，平均下来必然只有 2~3，
#    于是"真的叠上去了"会被判成红。要分开量两件事：
#      · changed —— 有多少像素确实变了（占画面比例）
#      · strong  —— **变了的那些像素**平均差多少（够不够肉眼看见）
hit = [v for v in px if v > 12]
print(json.dumps({
    'mean': round(sum(px) / len(px), 3),
    'changed': round(len(hit) / float(len(px)), 4),
    'strong': round(sum(hit) / len(hit), 2) if hit else 0
}))
`, a, b], { encoding: 'utf8', timeout: 120000 }))
  exportDiff = stat
} catch (err) {
  add('导出能跑完（ffmpeg 不报错）', false, String(err.message).slice(0, 160))
}

if (exportDiff) {
  add('导出能跑完（ffmpeg 不报错）', true, '两条成片都出来了')
  add(
    '成片里真的有素材（被改动的像素 ≥ 1%）',
    exportDiff.changed >= 0.01,
    `changed=${(exportDiff.changed * 100).toFixed(2)}%  mean=${exportDiff.mean}`
  )
  add(
    '改动足够可见（变了的那些像素平均差 ≥ 8）',
    exportDiff.strong >= 8,
    `strong=${exportDiff.strong}`
  )
}

/* 预览截图对比（放在最后，避免 python 缺席时前面的结论被吞掉） */
if (previewMetrics) {
  try {
    const stat = JSON.parse(execFileSync('python', ['-W', 'ignore', '-c', `
import json, sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
d = ImageChops.difference(a, b).convert('L')
px = list(d.getdata())
# 与"纯背景色 #243447"的差异 = 覆盖层画出来的东西
base = (0x24, 0x34, 0x47)
vis = 0
for r, g, bb in a.getdata():
    if abs(r - base[0]) + abs(g - base[1]) + abs(bb - base[2]) > 24:
        vis += 1
print(json.dumps({'between': round(sum(px) / len(px), 3), 'visible': round(vis / float(len(px)), 4)}))
`, previewMetrics.shotA, previewMetrics.shotB], { encoding: 'utf8', timeout: 120000 }))
    add('预览覆盖层真的画出了东西（≥ 2% 像素偏离底色）', stat.visible >= 0.02, `visible=${(stat.visible * 100).toFixed(2)}%`)
    add('预览在播（相隔 700ms 的两张截图不同）', stat.between >= 1, `帧间差=${stat.between}`)
  } catch (err) {
    add('预览像素可量（python + Pillow 可用）', false, String(err.message).slice(0, 120))
  }
}

/* ============================== 汇总 ============================== */

let pass = 0
let failed = 0
for (const r of results) {
  if (r.ok) pass += 1
  else failed += 1
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
}
console.log(`\nFX_PACK_PIXELS_STATS total=${results.length} pass=${pass} fail=${failed}`)
if (failed === 0) {
  console.log('素材型特效在预览里真的在播，在成片里真的叠上去了。')
  console.log('FX_PACK_PIXELS_OK')
} else {
  console.log('FX_PACK_PIXELS_FAILED')
}
process.exit(failed === 0 ? 0 : 1)
