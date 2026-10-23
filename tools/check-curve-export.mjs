#!/usr/bin/env node
/**
 * 曲线变速的**真导出**闸门：真的跑 ffmpeg，把成片导出来再读它的时长与音轨。
 *
 * 为什么纯函数闸门不够（check-speed-curve 已经把那套算术钉死了）：
 * 曲线变速在导出侧必须切成若干常速段再 concat —— 那是一串**拼出来的滤镜图**，
 * 拼错的样子不是"算错一个数"，而是：
 *   · `[caok1],asetrate=…` —— 标签后面多一个逗号，ffmpeg 报 `No such filter: ''`；
 *   · 尾段整段为空时链里夹着零个滤镜，同样报 `No such filter: ''`；
 *   · 每段缺 `aformat` —— concat 因为采样格式不一致失败；
 *   · `setpts` 忘了减 STARTPTS —— 第二段起时间戳接着走，成片越拼越长。
 * 这四种都不会被纯函数抓到，只有**真跑一次 ffmpeg** 才知道。
 *
 * 判据（全部取成片本身）：
 *   ① 四种组合（保音高 / 不保音高 / 变调 / 曲线音频轨）都必须导出成功；
 *   ② 成片时长必须等于"时间线占位"（分段拼接不许把总长改掉）；
 *   ③ 成片必须有音轨（分段音频链不许把声音丢掉）；
 *   ④ 滤镜图里真的有 concat 分段，且每段的 trim 起点严格递增。
 *
 * 用法：node tools/check-curve-export.mjs
 * 退出码：0 = 通过；1 = 有失败；2 = 本机没有 ffmpeg（如实报，不假绿）。
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
const speed = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'speed.js'))

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
  console.log('CURVE_EXPORT_SKIPPED 本机没有 ffmpeg（曲线导出无法验证）')
  process.exit(2)
}
const ffmpeg = found.ffmpeg

/* ------------------------------ 夹具 ------------------------------ */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-curve-export-'))
const src = path.join(work, 'src.mp4')
/* 12 秒 320×240 + 440Hz 正弦：视频段要验"分段拼接不改时长"，音频段要验"分段链没丢声音" */
spawnCapture(
  ffmpeg,
  [
    '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    src
  ],
  { tag: 'mk' }
)
check('测试素材生成完毕（12 秒，带音轨）', fs.existsSync(src) && fs.statSync(src).size > 4096)

const bullet = speed.CURVE_PRESETS.find((item) => item.key === 'bullet').points
const mean = speed.curveMean(bullet)
/* 时间线占位 = 源跨度 / 面积。4 秒源内容 → 4.975 秒时间线 */
const dur = Number((4 / mean).toFixed(3))
check(`夹具的时间线占位按源跨度守恒算出（4 / ${mean.toFixed(3)} = ${dur}）`, Math.abs(dur * mean - 4) < 0.01)

function clipsWith(extra = {}) {
  return [
    {
      id: 'c1',
      track: 'video',
      kind: 'video',
      path: src,
      start: 0,
      duration: dur,
      offset: 0,
      sourceDuration: 12,
      speed: mean,
      speedCurve: { points: bullet },
      ...extra
    }
  ]
}

/** 读成片：时长（秒）与有没有音轨。ffmpeg 不给输出时会退 1，但 stdout 里已经有 Duration */
function probeOut(file) {
  const out = spawnCapture(ffmpeg, ['-hide_banner', '-i', file], { tag: 'probe' })
  const text = String(out.stderr || '') + String(out.stdout || '')
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(text)
  return {
    seconds: match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN,
    audio: /Stream #\d+:\d+.*: Audio:/.test(text)
  }
}

/* --------------------- ① 滤镜图：真的有分段 --------------------- */

const plan = render.buildPlan({
  clips: clipsWith(),
  streamInfo: { c1: { hasAudio: true } },
  outPath: path.join(work, 'plan.mp4'),
  options: { width: 320, height: 240, fps: 25 }
})
const graph = (plan.args[plan.args.indexOf('-filter_complex') + 1] || '').toString()
check('滤镜图里有 concat 拼接（曲线真的被切开了）', /concat=n=\d+:v=1:a=0/.test(graph), graph.slice(0, 80))
check('视频分段用的是 (PTS-STARTPTS)/speed（不是裸 PTS/speed）', /setpts=\(PTS-STARTPTS\)\//.test(graph))
/* ⚠️ 正则必须挡住前面的字母：`atrim=start=` 里也含 `trim=start=`，
   不挡的话视频段与音频段会被混成一个升序又归零的数组（首跑就被这个假红骗过一次）。 */
const videoStarts = Array.from(graph.matchAll(/(?<!a)trim=start=([\d.]+):duration=([\d.]+)/g)).map((m) => Number(m[1]))
const audioStarts = Array.from(graph.matchAll(/atrim=start=([\d.]+):duration=([\d.]+)/g)).map((m) => Number(m[1]))
check(
  '视频每段 trim 起点严格递增（段与段之间不重叠、不留空）',
  videoStarts.length >= 2 && videoStarts.every((value, index) => index === 0 || value > videoStarts[index - 1]),
  JSON.stringify(videoStarts)
)
/* 最强的一条：视频与音频**同一批切点**。两条链各算一遍切点的话，
   音画会在每个切点上错开几十毫秒 —— 单看任何一条都对，合起来是"声音慢半拍"。 */
check(
  '视频段与音频段的切点完全一致（音画同一个时间轴）',
  videoStarts.length === audioStarts.length && videoStarts.every((value, index) => Math.abs(value - audioStarts[index]) < 1e-9),
  `v=${JSON.stringify(videoStarts)} a=${JSON.stringify(audioStarts)}`
)
check(
  `导出总时长 = 时间线占位（${dur}s）`,
  Math.abs(Number(plan.duration) - dur) < 0.02,
  String(plan.duration)
)

/* --------------------- ② 四种组合真导出 --------------------- */

const cases = [
  ['保音高', { keepPitch: true }],
  ['不保音高（asetrate）', { keepPitch: false }],
  ['变调 +2 半音', { keepPitch: true, pitch: 2 }]
]

for (const [label, extra] of cases) {
  const outPath = path.join(work, `out-${extra.pitch ? 'pitch' : extra.keepPitch === false ? 'tape' : 'keep'}.mp4`)
  const result = await render.render({ clips: clipsWith(extra), outPath, options: { width: 320, height: 240, fps: 25 } })
  const info = fs.existsSync(outPath) ? probeOut(outPath) : { seconds: NaN, audio: false }
  check(`「曲线 + ${label}」导出成功`, result.ok === true, String(result.error || '').slice(0, 200))
  check(
    `「${label}」成片时长 ≈ ${dur}s（分段拼接没改总长）`,
    Math.abs(info.seconds - dur) < 0.12,
    `${info.seconds}`
  )
  check(`「${label}」成片保留音轨`, info.audio === true)
}

/* 曲线音频轨（BGM 踩点落在音频轨上）单独一条：它走的是 bed 那条链 */
const bedOut = path.join(work, 'out-bed.mp4')
const bedResult = await render.render({
  clips: clipsWith().concat([
    {
      id: 'a1',
      track: 'audio',
      kind: 'audio',
      path: src,
      start: 0,
      duration: dur,
      offset: 6,
      sourceDuration: 12,
      speed: mean,
      speedCurve: { points: bullet }
    }
  ]),
  outPath: bedOut,
  options: { width: 320, height: 240, fps: 25 }
})
const bedInfo = fs.existsSync(bedOut) ? probeOut(bedOut) : { seconds: NaN, audio: false }
check('「曲线音频轨」导出成功', bedResult.ok === true, String(bedResult.error || '').slice(0, 200))
check(`「曲线音频轨」成片时长 ≈ ${dur}s`, Math.abs(bedInfo.seconds - dur) < 0.12, `${bedInfo.seconds}`)
check('「曲线音频轨」成片保留音轨', bedInfo.audio === true)

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('CURVE_EXPORT_FAILED')
  for (const item of problems) console.log(`  - ${item}`)
  console.log(`夹具目录（保留证据）：${work}`)
  process.exit(1)
}
console.log('CURVE_EXPORT_OK')
process.exit(0)
