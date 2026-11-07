#!/usr/bin/env node
/**
 * 4K 导入/导出闸门：真的生成 4K 素材、真的导出、再读**成片文件**判尺寸。
 *
 * 为什么必须真跑（纯逻辑闸门不够）：
 * `outputSizeFor` 那层算术再对，成片也可能不是那个尺寸 —— 尺寸要走
 * `render()` 的 options → `outputSizeOf` → 滤镜链 → ffmpeg，中间任何一处
 * 用了别的来源（面板算一个、主进程算一个），成片就会与界面写的不一致，
 * 而两边单独看都很正常。本项目已经在这类"两处各算一遍"上踩过多次。
 *
 * 这一道钉的是**本轮修掉的真实缺陷**：
 *   以前 `outputSizeFor` 是"在基准框里裁出比例的最大内接矩形"，于是
 *   4K + 9:16 只有 1214×2160（短边 1214），用户在界面上选的是 4K，
 *   拿到的竖屏片短边连 720 的 1.7 倍都不到。现在改成短边守恒：
 *   4K 竖屏 = 2160×3840。下面第 4 条断言就是它 —— 改回去必红。
 *
 * 判据一律读**成片文件**（ffmpeg -i 的 Stream 行），不读我们传下去的参数。
 *
 * 用法：node tools/check-4k-io.mjs
 * 退出码：0 = 通过；1 = 有失败；2 = 本机没有 ffmpeg（如实报，不假绿）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))
const aspect = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'aspect.js'))
const exportRate = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'exportRate.js'))

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    problems.push(label)
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('FOUR_K_IO_SKIPPED 本机没有 ffmpeg（4K 导入导出无法验证）')
  process.exit(2)
}
const ffmpeg = found.ffmpeg

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-4k-io-'))
process.on('exit', () => {
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* 临时目录，删不掉就算了 */ }
})

function ff(args, tag) {
  return spawnCapture(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', ...args], { tag })
}

/** 读文件里**真实**的宽高（ffmpeg -i 的 Stream 行），读不到返回 0 */
function dims(file) {
  if (!fs.existsSync(file)) return { w: 0, h: 0 }
  const out = spawnCapture(ffmpeg, ['-hide_banner', '-i', file], { tag: 'probe' })
  const text = String(out.stderr || '') + String(out.stdout || '')
  const line = text.split('\n').find((row) => /Stream #\d+:\d+.*: Video:/.test(row)) || ''
  const match = /, (\d{2,5})x(\d{2,5})[\s,]/.exec(line)
  return { w: match ? Number(match[1]) : 0, h: match ? Number(match[2]) : 0 }
}

/* ------------------------------ 夹具 ------------------------------ */

const src4k = path.join(work, 'src-4k.mp4')
const img4k = path.join(work, 'img-4k.png')
/* 2 秒 4K 视频 + 4K 静帧：一个验解码/重编码链路，一个验"图片当片段"分支 */
ff(['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src4k], 'mk-video')
ff(['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160', '-frames:v', '1', img4k], 'mk-image')
check('夹具：4K 视频源生成成功', dims(src4k).w === 3840, `${fs.existsSync(src4k) ? fs.statSync(src4k).size : 0} B`)

/* --------------------- ① 导入侧：4K 素材要被认成 4K --------------------- */

/* 主进程这条（media.describeMedia）是"这个文件能不能进素材库"的唯一权威；
   它读的是扩展名 + 文件系统，**不解码**。真正的宽高由渲染层 <img>/<video> 读
   （assets.js 的 probeMedia）—— 那条只能在真 Electron 里验，由 media-import-e2e
   的两条卡片断言负责（3840×2160 出现在素材卡上）。这里证明夹具本身是 4K 且能登记。 */
const media = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'media.js'))
const registered = media.describeMedia(src4k)
check(
  '4K 视频源能被导入登记（describeMedia 判成 video 且字节数 > 0）',
  Boolean(registered) && registered.kind === 'video' && registered.size > 0,
  registered ? `${registered.kind} / ${registered.size} B` : '登记失败'
)
const srcSize = dims(src4k)
check('4K 视频源真实尺寸 = 3840×2160（导入侧读到的宽高就来自这条流）',
  srcSize.w === 3840 && srcSize.h === 2160, `${srcSize.w}×${srcSize.h}`)
const imgProbe = dims(img4k)
check('4K 图片源 = 3840×2160（图片片段走的是另一条 ffmpeg 输入分支）',
  imgProbe.w === 3840 && imgProbe.h === 2160, `${imgProbe.w}×${imgProbe.h}`)

/* --------------------- ② 导出侧：成片必须是那个尺寸 --------------------- */

const video = {
  id: 'v4k', track: 'video', kind: 'video', path: src4k,
  start: 0, duration: 2, offset: 0, sourceDuration: 2
}
const image = {
  id: 'i4k', track: 'video', kind: 'image', path: img4k,
  start: 0, duration: 1, offset: 0, sourceDuration: 0
}

/** 真导一段，然后把成片尺寸读回来。基准尺寸一律**从档位表取**，不写死数字。 */
async function exportAndMeasure({ name, clip, resolution, ratio }) {
  const spec = exportRate.readResolution(resolution)
  const outPath = path.join(work, `out-${name}.mp4`)
  const result = await render.render({
    clips: [clip],
    outPath,
    options: { width: spec.width, height: spec.height, aspect: ratio, fps: 30, quality: 80 },
    ffmpegPath: ffmpeg
  })
  const size = dims(outPath)
  return { ok: result.ok === true, error: result.error || '', ...size, spec, outPath }
}

const r16 = await exportAndMeasure({ name: '4k-16x9', clip: video, resolution: '4k', ratio: '16:9' })
check('4K · 16:9 成片 = 3840×2160', r16.ok && r16.w === 3840 && r16.h === 2160, `${r16.w}×${r16.h}${r16.error ? ` ${r16.error}` : ''}`)

const r916 = await exportAndMeasure({ name: '4k-9x16', clip: video, resolution: '4k', ratio: '9:16' })
check(
  '4K · 9:16 成片 = 2160×3840（短边守恒；以前是 1214×2160，选 4K 却拿不到 4K）',
  r916.ok && r916.w === 2160 && r916.h === 3840,
  `${r916.w}×${r916.h}${r916.error ? ` ${r916.error}` : ''}`
)

const r11 = await exportAndMeasure({ name: '4k-1x1', clip: video, resolution: '4k', ratio: '1:1' })
check('4K · 1:1 成片 = 2160×2160（不是 2160 里再裁一刀）', r11.ok && r11.w === 2160 && r11.h === 2160, `${r11.w}×${r11.h}`)

const rImg = await exportAndMeasure({ name: '4k-image', clip: image, resolution: '4k', ratio: '16:9' })
check('4K 图片当片段导出 = 3840×2160（图片输入分支不会被静默降采样）',
  rImg.ok && rImg.w === 3840 && rImg.h === 2160, `${rImg.w}×${rImg.h}`)

const r1080 = await exportAndMeasure({ name: '1080p-9x16', clip: video, resolution: '1080p', ratio: '9:16' })
check('1080P · 9:16 成片 = 1080×1920（同一套口径的低档位）',
  r1080.ok && r1080.w === 1080 && r1080.h === 1920, `${r1080.w}×${r1080.h}`)

/* --------------------- ③ 上限：绕开档位表也得是 4K --------------------- */

/* 直接用 8K 宽高调 render —— 这就是"MCP 传 width/height"与"旧草稿存着 8K 尺寸"的样子 */
const over = path.join(work, 'out-over.mp4')
const overResult = await render.render({
  clips: [image],
  outPath: over,
  options: { width: 7680, height: 4320, aspect: '16:9', fps: 30, quality: 80 },
  ffmpegPath: ffmpeg
})
const overSize = dims(over)
check(
  '8K 宽高传进来 → 成片被夹到 3840×2160（上限不只在界面上，绕开下拉也挡住）',
  overResult.ok && overSize.w === 3840 && overSize.h === 2160,
  `${overSize.w}×${overSize.h}`
)

/* --------------------- ④ 面板与导出同式（七种比例全对） --------------------- */

let sameAll = true
const mismatches = []
for (const item of aspect.ASPECTS) {
  const want = aspect.outputSizeFor(3840, 2160, item.key)
  const got = await exportAndMeasure({
    name: `ratio-${item.key.replace(':', 'x')}`, clip: image, resolution: '4k', ratio: item.key
  })
  if (!got.ok || got.w !== want.width || got.h !== want.height) {
    sameAll = false
    mismatches.push(`${item.key}: 期望 ${want.width}×${want.height} 实际 ${got.w}×${got.h}`)
  }
}
check(
  `七种比例的面板尺寸 = 成片尺寸（4K 基准）`,
  sameAll,
  mismatches.join(' / ')
)

/* --------------------- ⑤ 档位表本身就是"最高 4K" --------------------- */

check('档位表最高一档是 4k', exportRate.RESOLUTIONS[exportRate.RESOLUTIONS.length - 1].id === '4k')
check('8k 请求落到 4k（旧草稿不会连降两档）', exportRate.readResolution('8k').id === '4k')

/* ------------------------------------------------------------------ 汇总 */
console.log(`\n=== 4K 导入导出：通过 ${pass} / 失败 ${fail} ===`)
console.log(`FOUR_K_IO_STATS total=${pass + fail} pass=${pass} fail=${fail} skip=0`)
if (fail) {
  console.log('失败项：')
  for (const item of problems) console.log(`  · ${item}`)
  process.exit(1)
}
console.log('FOUR_K_IO_OK')
process.exit(0)
