#!/usr/bin/env node
/**
 * 复合片段（嵌套时间线）闸门。
 *
 * 这一块最容易出的错**全都不报错**，所以必须两头钉：
 *   ① 纯算术（`shared/compound.js`）—— 新建 / 展开 / 解除的坐标换算，
 *      错了的表现是"复合之后内部内容整体错位半秒"，画面照常在播；
 *   ② **真导出** —— 复合片段在导出侧是被摊平成普通片段的，摊平这一步没接上，
 *      成片里就只剩第一段（后面全是黑场），而 ffmpeg 一行错都不报。
 *
 * 判据全部取"消费端"：展开后的片段表、成片的时长与**像素颜色**。
 * 断言"函数返回了什么"是不够的 —— 那测的是实现，不是"用户看到的成片"。
 *
 * 用法：node tools/check-compound.mjs
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
const compound = require(path.join(SHARED, 'compound.js'))
const speed = require(path.join(SHARED, 'speed.js'))
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

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

const near = (a, b, tol = 0.002) => Math.abs(Number(a) - Number(b)) <= tol

/* ------------------------------ 夹具 ------------------------------ */

const mk = (id, start, duration, extra = {}) => ({
  id,
  track: 'video',
  kind: 'video',
  path: `${id}.mp4`,
  start,
  duration,
  offset: 0,
  sourceDuration: 12,
  name: id,
  ...extra
})

console.log('\n=== ① 新建：内部时间线从 0 开始，时间线位置跟着最早那一段 ===')

const A = mk('a', 5, 2)
const B = mk('b', 7, 2)
const list0 = [A, B, mk('keep', 20, 1)]
const built = compound.makeCompound(list0, ['a', 'b'], { id: 'C1' })
check('选中的两段合成一个复合片段', Boolean(built && built.clip), String(built))
check('复合片段落在最早那一段的起点上（5）', near(built.clip.start, 5), String(built.clip.start))
check('占位 = 内部总跨度（4 秒）', near(built.clip.duration, 4), String(built.clip.duration))
check('内部第一段从 0 开始（相对坐标）', near(built.clip.compound.children[0].start, 0))
check('内部第二段从 2 开始', near(built.clip.compound.children[1].start, 2))
check('sourceDuration = 内部跨度（修剪上限靠它）', near(built.clip.sourceDuration, 4), String(built.clip.sourceDuration))
check('源入点归零、原速', built.clip.offset === 0 && built.clip.speed === 1)
check('时间线上不再有被收进去的那两段', built.rest.length === 1 && built.rest[0].id === 'keep')
check('kind 标成 compound（渲染侧认它）', built.clip.kind === 'compound' && compound.isCompound(built.clip))
check('纯音频的三段会落到音频轨', compound.makeCompound(
  [mk('x', 0, 1, { track: 'audio', kind: 'audio' }), mk('y', 1, 1, { track: 'audio', kind: 'audio' })],
  ['x', 'y'],
  { id: 'CA' }
).clip.track === 'audio')
check('没有选中任何片段时返回 null', compound.makeCompound(list0, [], { id: 'C' }) === null)

console.log('\n=== ② 展开：内部内容摊回时间线（预览与导出同一个出口） ===')

const C1 = built.clip
const flat = compound.expandCompounds([C1, built.rest[0]])
check('展开后不再有复合片段', flat.every((item) => item.kind !== 'compound'))
check('展开出两段（+ 未被收进去的那一段）', flat.length === 3, String(flat.length))
const [f0, f1] = flat.filter((item) => item.ownerId === 'C1')
check('第一段回到 5 秒处', near(f0.start, 5), String(f0.start))
check('第二段回到 7 秒处', near(f1.start, 7), String(f1.start))
check('两段时长各 2 秒', near(f0.duration, 2) && near(f1.duration, 2))
check('两段都记着归属（预览点选/右栏靠它落到外层）', f0.ownerId === 'C1' && f1.ownerId === 'C1')
check('展开后的 id 唯一且确定（React key / E2E 点名）', f0.id === 'C1~a' && f1.id === 'C1~b', `${f0.id} / ${f1.id}`)
const twice = compound.expandCompounds([C1]).map((item) => item.id)
check('同一份输入展开两次得到同一批 id', JSON.stringify(twice) === JSON.stringify(['C1~a', 'C1~b']))
check('展开一次能覆盖的内部总长 = 复合片段占位', near(f1.start + f1.duration - f0.start, C1.duration))

/* 整块搬走 */
const moved = { ...C1, start: 12 }
const m0 = compound.expandCompounds([moved])[0]
check('复合片段整体移到 12 秒 ⇒ 内部第一段也跟着到 12', near(m0.start, 12), String(m0.start))

console.log('\n=== ③ 裁剪：从内部第几秒开始播（offset）===')
/* 内部两段各 2 秒；把复合片段左端裁掉 1 秒 ⇒ 第一段只剩后半截，且源入点前移 1 秒 */
const trimmed = { ...C1, start: 10, offset: 1, duration: 2 }
const [t0, t1] = compound.expandCompounds([trimmed])
check('左端裁 1 秒后第一段从 10 开始', near(t0.start, 10), String(t0.start))
check('第一段只剩 1 秒', near(t0.duration, 1), String(t0.duration))
check('第一段的源入点前移 1 秒（否则会把裁掉的那一秒又播一遍）', near(t0.offset, 1), String(t0.offset))
check('第二段从 11 开始（接在第一段后面）', near(t1.start, 11), String(t1.start))
check('第二段时长 1 秒（右端被裁）', near(t1.duration, 1), String(t1.duration))
check('第二段的源入点不变（右端裁剪不动 offset）', near(t1.offset, 0), String(t1.offset))

/* 裁到只剩第二段中间：第一段整段被裁掉 */
const onlySecond = { ...C1, start: 0, offset: 2.5, duration: 1 }
const kept = compound.expandCompounds([onlySecond])
check('完全落在第二段里的窗口只展开出第二段', kept.length === 1 && kept[0].id === 'C1~b', kept.map((i) => i.id).join(','))
check('它内部的偏移 = 0.5 秒（从第二段中间开始）', near(kept[0].offset, 0.5), String(kept[0].offset))

console.log('\n=== ④ 倍速：占位除以 k，内部速率乘 k（源消耗守恒）===')

const fast = { ...C1, speed: 2, duration: 2 }
const [s0, s1] = compound.expandCompounds([fast])
check('2 倍速：第一段占 1 秒', near(s0.duration, 1), String(s0.duration))
check('2 倍速：第二段从 6 秒处开始（5 + 2/2）', near(s1.start, 6), String(s1.start))
check('2 倍速：内部片段自身倍速也乘 2（否则声音与画面不同步）', near(s0.speed, 2) && near(s1.speed, 2), `${s0.speed}/${s1.speed}`)
check('源消耗守恒：新时长 × 新倍速 = 旧时长 × 旧倍速', near(s0.duration * s0.speed, 2) && near(s1.duration * s1.speed, 2))

/* 内部片段自带曲线 ⇒ 只缩放曲线高度，平均倍速跟着乘 k */
const curved = { ...C1, speed: 1, compound: { ...C1.compound, children: [{ ...C1.compound.children[0], speedCurve: { points: speed.CURVE_PRESETS.find((p) => p.key === 'bullet').points } }] } }
const curveKid = compound.expandCompounds([curved])[0]
const before = speed.curveMean(speed.CURVE_PRESETS.find((p) => p.key === 'bullet').points)
check(
  '内部曲线在展开后原样保留（面积 = 原面积）',
  near(speed.curveMean(curveKid.speedCurve), before, 0.01),
  String(speed.curveMean(curveKid.speedCurve))
)
const curvedFast = { ...curved, speed: 2, duration: 1 }
const curveKid2 = compound.expandCompounds([curvedFast])[0]
check(
  '外层 2 倍速时内部曲线的平均速率也 ×2（不是被忽略）',
  near(speed.curveMean(curveKid2.speedCurve), before * 2, 0.02),
  String(speed.curveMean(curveKid2.speedCurve))
)

console.log('\n=== ⑤ 倒放：外层倒放 = 内部各段方向整体翻一次 ===')

const reversed = { ...C1, reverse: true }
const [r0, r1] = compound.expandCompounds([reversed])
check('倒放后第一段（内部开头）落到时间线**后面**', near(r0.start, 7) && r0.id === 'C1~a', `${r0.id}@${r0.start}`)
check('倒放后第二段（内部结尾）落到时间线**前面**', near(r1.start, 5) && r1.id === 'C1~b', `${r1.id}@${r1.start}`)
check('内部片段各自被翻成倒放', r0.reverse === true && r1.reverse === true)
const doubleReverse = { ...C1, reverse: true, compound: { ...C1.compound, children: C1.compound.children.map((child) => ({ ...child, reverse: true })) } }
check(
  '两层倒放 = 正放（方向逻辑不能是"见 true 就设 true"）',
  compound.expandCompounds([doubleReverse]).every((item) => item.reverse === false)
)

console.log('\n=== ⑥ 内部空隙：复合片段不压缩内部时间 ===')
const gapCompound = compound.makeCompound([mk('g1', 0, 2), mk('g2', 5, 1)], ['g1', 'g2'], { id: 'CG' }).clip
const gapFlat = compound.expandCompounds([gapCompound])
check('内部跨度算到 6 秒（含 3 秒空隙）', near(gapCompound.duration, 6), String(gapCompound.duration))
check('空隙原样保留（第二段在第 5 秒）', near(gapFlat[1].start, 5), String(gapFlat[1].start))

console.log('\n=== ⑦ 嵌套：复合里再套复合 ===')
const innerC = compound.makeCompound([mk('i1', 0, 1), mk('i2', 1, 1)], ['i1', 'i2'], { id: 'IN' }).clip
const outerC = compound.makeCompound([innerC, mk('o2', 3, 1)], ['IN', 'o2'], { id: 'OUT' }).clip
const deep = compound.expandCompounds([outerC])
check('两层嵌套一路摊平（展开结果里没有复合片段）', deep.every((item) => item.kind !== 'compound'))
check('嵌套里的三段都在', deep.length === 3, String(deep.length))
check('嵌套段的 id 是两层拼起来的', deep.some((item) => item.id === 'OUT~IN~i1'), deep.map((i) => i.id).join(','))
check('时间位置正确（0 / 1 / 3）', near(deep[0].start, 0) && near(deep[1].start, 1) && near(deep[2].start, 3))

console.log('\n=== ⑧ 解除：还原成普通片段 ===')
const back = compound.ungroupCompound(C1, (index) => `u${index}`)
check('解除得到两段', back.length === 2, String(back.length))
check('位置与展开完全一致', near(back[0].start, 5) && near(back[1].start, 7))
check('id 重新发（不复用父~子，否则复制过的复合片段解除时会撞 id）', back.every((item, index) => item.id === `u${index}`))
check('解除后不再带 ownerId（它现在是顶层片段）', back.every((item) => item.ownerId === undefined))
const backTrimmed = compound.ungroupCompound(trimmed, (index) => `t${index}`)
check(
  '解除裁剪过的复合片段：几何与展开一致（1 秒 + 1 秒，源入点 1 / 0）',
  near(backTrimmed[0].start, 10) &&
    near(backTrimmed[0].duration, 1) &&
    near(backTrimmed[0].offset, 1) &&
    near(backTrimmed[1].start, 11) &&
    near(backTrimmed[1].offset, 0),
  JSON.stringify(backTrimmed.map((i) => [i.start, i.duration, i.offset]))
)
check('非复合片段解除 ⇒ 空数组（不抛错）', compound.ungroupCompound(A, (i) => `n${i}`).length === 0)

console.log('\n=== ⑨ 轨道开关要"穿过"复合片段 ===')
check('外层所在轨被隐藏 ⇒ 内部一段都不出', compound.expandCompounds([C1], { trackState: { hidden: ['video'] } }).length === 0)
check('外层被停用 ⇒ 内部一段都不出', compound.expandCompounds([{ ...C1, enabled: false }]).length === 0)
const mixed = compound.makeCompound(
  [mk('v', 0, 2), mk('au', 0, 2, { track: 'audio', kind: 'audio' })],
  ['v', 'au'],
  { id: 'CM' }
).clip
const mutedFlat = compound.expandCompounds([mixed], { trackState: { muted: ['video'] } })
check('外层视频轨静音 ⇒ 内部音频段的 gain 也被压到 0（否则"画面静了、声音还响"）', mutedFlat.every((item) => item.gain === 0))
check('但画面段仍然在合成里（静音不等于隐藏）', mutedFlat.length === 2)
const soloFlat = compound.expandCompounds([mixed], { trackState: { solo: ['audio'] } })
check('独奏音频轨 ⇒ 复合片段里的音频段保留、画面段 gain 归 0', soloFlat.length === 2 && soloFlat.find((i) => i.track === 'video').gain === 0)

console.log('\n=== ⑩ 不改入参 / 空数据不炸 ===')
const snapshot = JSON.stringify(list0)
compound.makeCompound(list0, ['a', 'b'], { id: 'CX' })
compound.expandCompounds([C1])
compound.ungroupCompound(trimmed, (i) => `z${i}`)
check('三个函数都不修改传入的片段表', JSON.stringify(list0) === snapshot)
check(
  '内部为空的复合片段按普通片段透传（不能凭空消失）',
  compound.expandCompounds([{ ...C1, compound: { children: [] } }]).length === 1
)

console.log('\n=== ⑪ 音量：外层的滑杆乘到内部每一段上 ===')
const quiet = compound.expandCompounds([{ ...mixed, gain: 50 }])
check('外层音量 50% ⇒ 内部各段的 gain 也乘 0.5（否则拖到 0 也照样响）', quiet.every((item) => item.gain === 50), JSON.stringify(quiet.map((i) => i.gain)))
const loud = compound.expandCompounds([{ ...mixed, gain: 100 }])
/* 100% 时不写字段（undefined 在消费端就等同 100）—— 不能"补一个 100 进去"，
   那会让每一段都多出一个本来没有的字段，草稿 diff 处处变化 */
check('外层 100% ⇒ 内部 gain 一个都不改（不凭空补字段）', loud.every((item) => item.gain === undefined))

/* ------------------------- ⑫ 真导出 ------------------------- */

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('\nCOMPOUND_EXPORT_SKIPPED 本机没有 ffmpeg（成片侧无法验证）')
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  process.exit(fail ? 1 : 2)
}
const ffmpeg = found.ffmpeg
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-compound-'))
const red = path.join(work, 'red.mp4')
const blue = path.join(work, 'blue.mp4')

for (const [file, color] of [['red', 'red'], ['blue', 'blue']]) {
  spawnCapture(
    ffmpeg,
    [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=25`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      path.join(work, `${file}.mp4`)
    ],
    { tag: `mk-${file}` }
  )
}
check('两段夹具生成完毕（红 / 蓝，各 4 秒带音轨）', fs.existsSync(red) && fs.existsSync(blue))

const clipRed = { id: 'r', track: 'video', kind: 'video', path: red, start: 0, duration: 2, offset: 0, sourceDuration: 4, name: 'r' }
const clipBlue = { id: 'bl', track: 'video', kind: 'video', path: blue, start: 2, duration: 2, offset: 0, sourceDuration: 4, name: 'bl' }
const comp = compound.makeCompound([clipRed, clipBlue], ['r', 'bl'], { id: 'CMP' }).clip

/** 取某一时刻的**中心像素**（rgb24）。判据取成片像素，不读滤镜串 */
function centerPixel(file, at) {
  const out = spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', path.join(work, `px-${at}.rgb`)],
    { tag: `px-${at}` }
  )
  const probe = path.join(work, `px-${at}.rgb`)
  if (!fs.existsSync(probe)) return null
  const buf = fs.readFileSync(probe)
  /* 8×8 的第 (4,4) 个像素 = 偏移 (4*8+4)*3 */
  const i = (4 * 8 + 4) * 3
  return out ? [buf[i], buf[i + 1], buf[i + 2]] : null
}

function probeOut(file) {
  const out = spawnCapture(ffmpeg, ['-hide_banner', '-i', file], { tag: 'probe' })
  const text = String(out.stderr || '') + String(out.stdout || '')
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(text)
  return {
    seconds: match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN,
    audio: /Stream #\d+:\d+.*: Audio:/.test(text)
  }
}

const outPath = path.join(work, 'out.mp4')
const result = await render.render({
  clips: [comp],
  outPath,
  options: { width: 320, height: 240, fps: 25 }
})
check('复合片段导出成功', result.ok === true, String(result.error || '').slice(0, 300))
check(`成片时长 = 复合片段占位（4 秒）`, near(result.duration, 4, 0.02), String(result.duration))

const info = fs.existsSync(outPath) ? probeOut(outPath) : { seconds: NaN, audio: false }
check('成片文件时长 ≈ 4 秒', Math.abs(info.seconds - 4) < 0.15, String(info.seconds))
check('成片保留音轨（内部片段自带的声音没被丢）', info.audio === true)
const pxEarly = centerPixel(outPath, 0.6)
const pxLate = centerPixel(outPath, 3.0)
check(
  '0.6 秒处是**第一段**（红）',
  Boolean(pxEarly) && pxEarly[0] > 140 && pxEarly[2] < 110,
  JSON.stringify(pxEarly)
)
check(
  '3.0 秒处是**第二段**（蓝）—— 这一条能抓住"只有第一段被渲染"',
  Boolean(pxLate) && pxLate[2] > 140 && pxLate[0] < 110,
  JSON.stringify(pxLate)
)

/* 对照：同一批片段直接放时间线（不做复合），成片必须一模一样 ——
   展开这一步如果悄悄改了时长/顺序，这里立刻露出来 */
const directOut = path.join(work, 'direct.mp4')
const direct = await render.render({
  clips: [{ ...clipRed, start: 0 }, { ...clipBlue, start: 2 }],
  outPath: directOut,
  options: { width: 320, height: 240, fps: 25 }
})
check('对照组（不复合）导出成功', direct.ok === true, String(direct.error || '').slice(0, 200))
check(
  '复合前后总时长一致（展开没有偷偷加减时长）',
  near(direct.duration, result.duration, 0.02),
  `${direct.duration} vs ${result.duration}`
)
const pxDirectLate = centerPixel(directOut, 3.0)
check(
  '复合片段 3 秒处的颜色与"直接排两段"一致',
  Boolean(pxDirectLate) && Boolean(pxLate) &&
    Math.abs(pxDirectLate[2] - pxLate[2]) < 40 &&
    Math.abs(pxDirectLate[0] - pxLate[0]) < 40,
  `${JSON.stringify(pxLate)} vs ${JSON.stringify(pxDirectLate)}`
)

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('COMPOUND_FAILED')
  for (const item of problems) console.log(`  - ${item}`)
  console.log(`夹具目录（保留证据）：${work}`)
  process.exit(1)
}
console.log('COMPOUND_OK')
process.exit(0)
