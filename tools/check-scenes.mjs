#!/usr/bin/env node
/**
 * 场景切换检测（自动切点）闸门。
 *
 * 这一块的错**全都不报错**，而且都表现为"切得出来、看着差不多"：
 *   ① ffmpeg 的 `pts_time` 是**源文件绝对秒**，直接当时间线秒用 ⇒ 整条切点顶到入点后面；
 *   ② 漏乘/漏除 `clip.speed` ⇒ 2 倍速下每个切点都偏一半（画面变换永远差半秒）；
 *   ③ 切点不做过近过滤 ⇒ 切出一串 0.0x 秒的碎段（时间线上像灰尘）；
 *   ④ 切片不复用 region 的算术 ⇒ 曲线片段的残段速度分布整个变掉。
 *
 * 判据三层：解析（真 ffmpeg 输出格式）+ 换算（源秒 → 时间线秒）+ **真跑 ffmpeg 检测**
 * （造一段红/蓝/绿三段视频，切点必须落在 1s 与 2s 附近）。
 *
 * 用法：node tools/check-scenes.mjs
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
const SHARED = path.join(ROOT, 'packages', 'desktop', 'src', 'shared')
const scenes = require(path.join(SHARED, 'scenes.js'))
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? `  —— ${detail}` : ''}`)
  } else {
    fail += 1
    problems.push(label)
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const near = (a, b, tol = 0.002) => Math.abs(Number(a) - Number(b)) <= tol
const mk = (id, extra = {}) => ({
  id,
  track: 'video',
  kind: 'video',
  path: `${id}.mp4`,
  url: `yjai-media://${id}`,
  start: 0,
  duration: 3,
  offset: 0,
  sourceDuration: 10,
  name: id,
  ...extra
})

/* ---------------------- ① 解析 ffmpeg 输出 ---------------------- */

console.log('\n=== ① 解析：pts_time 与 scene_score 的配对 ===')

/* 真实 ffmpeg 的输出长这样（metadata=mode=print 打到 stdout，日志在 stderr） */
const SAMPLE = [
  'frame:  25  pts: 64000  pts_time:1.0',
  'lavfi.scene_score=0.512',
  'frame:  50  pts: 128000  pts_time:2.0',
  'lavfi.scene_score=0.733'
].join('\n')
const parsed = scenes.parseScenes(SAMPLE)
check('两个命中帧都被解析出来', parsed.length === 2, JSON.stringify(parsed))
check('时间取 pts_time（源文件秒数）', near(parsed[0].at, 1) && near(parsed[1].at, 2), JSON.stringify(parsed.map((hit) => hit.at)))
check('分数就近配对（没有配成 0）', parsed[0].score > 0.5 && parsed[1].score > 0.7, JSON.stringify(parsed.map((hit) => hit.score)))

const REVERSED = ['lavfi.scene_score=0.4', 'frame: 10 pts: 1 pts_time:0.4'].join('\n')
check('分数行在 pts 之前也能配上（不假设行序）', scenes.parseScenes(REVERSED)[0].score === 0.4,
  JSON.stringify(scenes.parseScenes(REVERSED)))

check('没有命中 ⇒ 空数组（不是抛错）', scenes.parseScenes('').length === 0)
check('夹着普通日志也能解析', scenes.parseScenes('[in#0] x\nframe: 5 pts: 1 pts_time:0.2\nlavfi.scene_score=0.31\n[out#0] done').length === 1)
check('pts_time=0 的帧被丢掉（0 秒不是"切换"，是文件开头）', scenes.parseScenes('frame: 0 pts: 0 pts_time:0.0\nlavfi.scene_score=0.9').length === 0)

/* ---------------------- ② 支持范围 ---------------------- */

console.log('\n=== ② 支持范围：倒放 / 曲线明确拒绝（不是"切出来看着差不多"） ===')

check('普通片段支持', scenes.sceneSupport(mk('p')).ok === true)
check('倒放片段拒绝，并说明原因', scenes.sceneSupport(mk('r', { reverse: true })).ok === false &&
  /倒放/.test(scenes.sceneSupport(mk('r', { reverse: true })).reason))
check('曲线变速片段拒绝，并说明原因',
  scenes.sceneSupport(mk('c', { speedCurve: { points: [[0, 2], [1, 0.5]] } })).ok === false &&
  /曲线/.test(scenes.sceneSupport(mk('c', { speedCurve: { points: [[0, 2], [1, 0.5]] } })).reason))
check('只有一个点的"曲线"不算曲线（等于常速）', scenes.sceneSupport(mk('c1', { speedCurve: { points: [[0, 1]] } })).ok === true)

/* ---------------------- ③ 源秒 → 时间线秒 ---------------------- */

console.log('\n=== ③ 换算：入点与倍速都要参与 ===')

const plain = mk('p', { start: 0, duration: 4, offset: 0, speed: 1 })
check('常速、入点 0：源 1 秒 = 时间线 1 秒', near(scenes.timelineCuts(plain, [{ at: 1 }])[0], 1))
check('常速、入点 2：源 3 秒 = 时间线 1 秒（漏减入点会算成 3）',
  near(scenes.timelineCuts(mk('o', { offset: 2, duration: 4 }), [{ at: 3 }])[0], 1),
  JSON.stringify(scenes.timelineCuts(mk('o', { offset: 2, duration: 4 }), [{ at: 3 }])))
check('2 倍速：源 2 秒 = 时间线 1 秒（漏除倍速会算成 2）',
  near(scenes.timelineCuts(mk('f', { speed: 2, duration: 4 }), [{ at: 2 }])[0], 1),
  JSON.stringify(scenes.timelineCuts(mk('f', { speed: 2, duration: 4 }), [{ at: 2 }])))
check('片段不在 0 开始：切点要加上 clip.start',
  near(scenes.timelineCuts(mk('s', { start: 5, duration: 4 }), [{ at: 1 }])[0], 6))
check('落在入点之前的切点被丢掉（源里那一段没被用上）',
  scenes.timelineCuts(mk('o2', { offset: 2, duration: 4 }), [{ at: 1 }]).length === 0)
check('超出片段长度的切点被丢掉',
  scenes.timelineCuts(mk('o3', { duration: 2 }), [{ at: 5 }]).length === 0)
check('太贴边的切点被丢掉（不切 0.0x 秒的碎段）',
  scenes.timelineCuts(mk('edge', { duration: 4 }), [{ at: 0.05 }]).length === 0)
check('相邻太近的两个切点合成一个', scenes.timelineCuts(mk('gap', { duration: 4 }), [{ at: 2 }, { at: 2.1 }]).length === 1,
  JSON.stringify(scenes.timelineCuts(mk('gap', { duration: 4 }), [{ at: 2 }, { at: 2.1 }])))
check('输入乱序也输出升序', JSON.stringify(scenes.timelineCuts(mk('ord', { duration: 6 }), [{ at: 3 }, { at: 1 }])) === '[1,3]',
  JSON.stringify(scenes.timelineCuts(mk('ord', { duration: 6 }), [{ at: 3 }, { at: 1 }])))
check('倒放片段直接返回空切点', scenes.timelineCuts(mk('rev', { reverse: true }), [{ at: 1 }]).length === 0)

/* ---------------------- ④ 切片 ---------------------- */

console.log('\n=== ④ 切片：总量守恒、入点连续、发号正确 ===')

let seq = 0
const makeId = () => `new_${++seq}`
const pieces = scenes.splitByScenes(mk('p', { duration: 6, offset: 1, speed: 2 }), [2, 4], makeId)
check('两个切点切成三段', pieces.length === 3, String(pieces.length))
check('第一段沿用原 id（撤销/选中不至于全丢）', pieces[0].id === 'p')
check('后面几段发新号', pieces[1].id !== 'p' && pieces[2].id !== pieces[1].id)
check('总时长守恒', near(pieces.reduce((sum, clip) => sum + clip.duration, 0), 6),
  String(pieces.reduce((sum, clip) => sum + clip.duration, 0)))
check(
  '每段的源入点首尾相接（差一点就是"切完画面跳一格"）',
  near(pieces[1].offset, pieces[0].offset + pieces[0].duration * 2) &&
    near(pieces[2].offset, pieces[1].offset + pieces[1].duration * 2),
  JSON.stringify(pieces.map((clip) => Number(clip.offset).toFixed(2)))
)
check('每段仍标着原来的 2 倍速', pieces.every((clip) => Number(clip.speed) === 2))
check('没有切点 ⇒ 原样返回一段', scenes.splitByScenes(mk('n'), [], makeId).length === 1)

/* ---------------------- ⑤ 真跑 ffmpeg 检测 ---------------------- */

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('\nSCENES_FFMPEG_SKIPPED 本机没有 ffmpeg（检测那一步没法验）')
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  process.exit(fail ? 1 : 2)
}
const ffmpeg = found.ffmpeg
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-scenes-'))
const fixture = path.join(work, 'three.mp4')

/* 红 1 秒 → 蓝 1 秒 → 绿 1 秒：两次硬切，位置确定（1.0s / 2.0s） */
spawnCapture(
  ffmpeg,
  ['-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25:d=1',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture],
  { tag: 'mk-three' }
)
check('三段夹具生成完毕', fs.existsSync(fixture), fixture)

const detected = await render.detectScenes({ sourcePath: fixture, threshold: 0.3 })
check('检测本身成功', detected.ok === true, String(detected.error || ''))
const hits = Array.isArray(detected.scenes) ? detected.scenes : []
check('检测到 2 个切点（两处硬切）', hits.length === 2, JSON.stringify(hits.map((hit) => hit.at)))
check('第一个切点在 1 秒附近（±0.2）', hits.length >= 1 && Math.abs(hits[0].at - 1) <= 0.2, hits[0] ? String(hits[0].at) : '无')
check('第二个切点在 2 秒附近（±0.2）', hits.length >= 2 && Math.abs(hits[1].at - 2) <= 0.2, hits[1] ? String(hits[1].at) : '无')
check('分数都是正数（不是"有帧号没分数"）', hits.every((hit) => hit.score > 0), JSON.stringify(hits.map((hit) => hit.score)))

const cuts = scenes.timelineCuts(mk('t', { duration: 3, offset: 0, sourceDuration: 3 }), hits)
check('换算到时间线后仍是两个切点', cuts.length === 2, JSON.stringify(cuts))
check('切点落在 1s / 2s 附近（±0.2）', cuts.length === 2 && Math.abs(cuts[0] - 1) <= 0.2 && Math.abs(cuts[1] - 2) <= 0.2,
  JSON.stringify(cuts.map((value) => Number(value).toFixed(2))))

const finalPieces = scenes.splitByScenes(mk('t', { duration: 3, offset: 0, sourceDuration: 3 }), cuts, makeId)
check('按检测结果切成 3 段', finalPieces.length === 3, String(finalPieces.length))
check('三段总时长 = 原片长（3 秒）', near(finalPieces.reduce((sum, clip) => sum + clip.duration, 0), 3),
  String(finalPieces.reduce((sum, clip) => sum + clip.duration, 0)))

/* 阈值抬高：同样的素材应当检不出来（证明阈值真的喂进去了，不是写死的） */
const strict = await render.detectScenes({ sourcePath: fixture, threshold: 0.9 })
check('阈值 0.9 时检不出切点（阈值真的生效，不是摆设）',
  strict.ok === true && (strict.scenes || []).length === 0, JSON.stringify((strict.scenes || []).map((hit) => hit.at)))

/* 全黑片：一个切点都没有，也必须 ok（不是"功能坏了"） */
const flat = path.join(work, 'flat.mp4')
spawnCapture(
  ffmpeg,
  ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', flat],
  { tag: 'mk-flat' }
)
const flatDetected = await render.detectScenes({ sourcePath: flat, threshold: 0.3 })
check('整段一个镜头：ok=true 且 scenes 为空（"没有切点"不是错误）',
  flatDetected.ok === true && (flatDetected.scenes || []).length === 0, JSON.stringify(flatDetected))

console.log('')
if (!fail) console.log('SCENES_OK')
console.log(`=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('失败项：')
  for (const item of problems) console.log(`  - ${item}`)
}
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch {
  /* 删不掉就留着 */
}
process.exit(fail ? 1 : 0)
