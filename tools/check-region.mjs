#!/usr/bin/env node
/**
 * 时间区域（区间操作）闸门。
 *
 * 「时间区域」= 时间线上框出 [start, end) 后做整体操作。这一块的错**全都不报错**：
 *   ① 右残段忘了按 ripple 前移 —— 区间消失了，后半段还立在原地，中间留出一个空洞；
 *   ② 切在有曲线变速的片段上，却把整条曲线原样搬给残段 —— 残段只有一半长，
 *      曲线形状却还是整段的，速度分布整个变了（画面"越切越歪"）；
 *   ③ 倒放片段的残段入点取了区间开头 —— 倒放时时间线前进 = 源回退，
 *      残段的 offset 应该取区间**结尾**那一刻（取反了就从另一个位置开始播，甚至越界变黑）；
 *   ④ 导出侧「只导出区域」没接上 —— 面板上选了、成片还是整条，时长与内容都不报错。
 *
 * 所以判据两头钉：纯算术（片段表逐项对 start / duration / offset / 曲线）+
 * **真跑 ffmpeg 读中心像素**（区间的左右边界到底切在哪儿）。
 *
 * 用法：node tools/check-region.mjs
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
const region = require(path.join(SHARED, 'region.js'))
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
const pos = (list) => list.map((c) => `${c.id}@${Number(c.start).toFixed(2)}+${Number(c.duration).toFixed(2)}`)
const offsets = (list) => list.map((c) => Number(c.offset).toFixed(3))

/* ------------------------------ 夹具 ------------------------------ */

const mk = (id, start, duration, extra = {}) => ({
  id,
  track: 'video',
  kind: 'video',
  path: `${id}.mp4`,
  url: `yjai-media://${id}`,
  start,
  duration,
  offset: 0,
  sourceDuration: 30,
  name: id,
  assetId: `as_${id}`,
  ...extra
})

/* ------------------------- ① 区域规格 ------------------------- */

console.log('\n=== ① 区域规格：两端排序 / 太短作废 / 不接受负值 ===')

check('两端反着给也能规范化（拖右手柄往回拖过起点）', JSON.stringify(region.normalizeRegion(5, 2)) === '{"start":2,"end":5}')
check('两端相等 ⇒ 作废（不是"零长区域"）', region.normalizeRegion(3, 3) === null)
check('短于 0.05 秒 ⇒ 作废（防误触）', region.normalizeRegion(1, 1.04) === null)
check('刚好 0.05 秒 ⇒ 成立', Boolean(region.normalizeRegion(1, 1.05)))
check('负的起点夹到 0', region.normalizeRegion(-2, 3).start === 0, JSON.stringify(region.normalizeRegion(-2, 3)))
check('span 口径与两端一致', near(region.regionSpan({ start: 1, end: 3.5 }), 2.5))
check('span 对废区域返回 0（调用方不必判 null）', region.regionSpan(null) === 0)
check('完全在区间内的片段算"受影响"', region.intersects(mk('x', 1, 1), { start: 0, end: 4 }) === true)
check('刚好贴边不算受影响（[4,6) 与 [0,4) 不相交）', region.intersects(mk('x', 4, 2), { start: 0, end: 4 }) === false)
check('clipsInRegion 只挑有交集的', region.clipsInRegion([mk('a', 0, 4), mk('b', 4, 4)], { start: 1, end: 3 }).length === 1)

/* ------------------------- ② 切一刀：入点换算 ------------------------- */

console.log('\n=== ② 切一刀：源入点必须跟着倍速 / 曲线 / 倒放走 ===')

const plain = mk('p', 0, 4)
const cut = region.sliceClip(plain, 1, 3)
check('正放常速：残段从 1 秒开始、长 2 秒', near(cut.start, 1) && near(cut.duration, 2), JSON.stringify(pos([cut])))
check('正放常速：源入点 = 区间起点（1）', near(cut.offset, 1), String(cut.offset))

const fast = mk('f', 0, 4, { speed: 2, offset: 1 })
const fastCut = region.sliceClip(fast, 1, 3)
check(
  '2 倍速：源入点 = 1 + 1×2 = 3（漏乘倍速就是"从早一半的地方开始播"）',
  near(fastCut.offset, 3),
  String(fastCut.offset)
)
check('2 倍速：残段本身仍标着 2 倍速', near(fastCut.speed, 2))

const rev = mk('r', 0, 4, { reverse: true })
const revCut = region.sliceClip(rev, 1, 3)
check(
  '倒放：源入点取**区间结尾**那一刻（4-3=1），不是区间开头（3）',
  near(revCut.offset, 1),
  String(revCut.offset)
)
check('倒放：残段仍然标着倒放', revCut.reverse === true)

const off = mk('o', 2, 4, { offset: 5 })
const offCut = region.sliceClip(off, 3, 4)
check('片段不在 0 起：源入点 = 5 + (3-2) = 6', near(offCut.offset, 6), String(offCut.offset))
check('片段不在 0 起：残段的**时间线起点**保持原坐标（3）', near(offCut.start, 3))

check('区间完全在片段外 ⇒ null（不产生零长片段）', region.sliceClip(plain, 6, 8) === null)
check('区间刚好贴片段起点 ⇒ 仍返回整段', Boolean(region.sliceClip(plain, 0, 4)))
check('shift 参数把结果整体平移（导出区域用 -start）', near(region.sliceClip(plain, 2, 3, { shift: -2 }).start, 0))

/* 曲线：子区间必须重参数化，不是"整条曲线原样搬过去" */
const curved = mk('c', 0, 8, { speedCurve: { points: [[0, 2], [0.5, 0.5], [1, 2]] } })
const curveCut = region.sliceClip(curved, 2, 6)
const curvePiece = speed.readCurve(curveCut)
check('曲线片段：残段有 2 个以上的曲线点', Boolean(curvePiece) && curvePiece.length >= 2, JSON.stringify(curvePiece))
check('曲线片段：端点进度精确铺满 0 与 1', curvePiece[0].p === 0 && curvePiece[curvePiece.length - 1].p === 1)
check(
  '曲线片段：两端速率 = 原曲线在 p0/p1 处的值（1.25），不是原曲线的端点（2）',
  near(curvePiece[0].v, 1.25) && near(curvePiece[curvePiece.length - 1].v, 1.25),
  JSON.stringify(curvePiece.map((point) => point.v))
)
check(
  '曲线片段：残段均值 = 子区间均值（0.875），不是原曲线均值（1.25）',
  near(speed.clipSpeed(curveCut), 0.875, 0.01),
  String(speed.clipSpeed(curveCut))
)
check(
  '曲线片段：不变式「时长 × 倍速 = 吃掉的源」成立（3.5 秒源）',
  near(curveCut.duration * speed.clipSpeed(curveCut), speed.sourceTimeAt(curved, 6) - speed.sourceTimeAt(curved, 2), 0.01),
  `${curveCut.duration * speed.clipSpeed(curveCut)} vs ${speed.sourceTimeAt(curved, 6) - speed.sourceTimeAt(curved, 2)}`
)
/* ⚠️ clipRateAt 的第二个参数是**时间线秒**，不是"片段内进度"。
   传 0.5 会被夹到片段开头（残段从 2 秒起），读出来的是 p0 处的 1.25 ——
   假绿的样子：期望 0.5、实测 1.25，而"曲线没保住"这个真缺陷反而看不出来。 */
check(
  '曲线片段：残段中点（时间线 4 秒 = 片段内进度 0.5）的瞬时速率 = 0.5',
  near(speed.clipRateAt(curveCut, 2 + 2), 0.5, 0.01),
  String(speed.clipRateAt(curveCut, 2 + 2))
)

/* ------------------------- ③ 删除区域 ------------------------- */

console.log('\n=== ③ 删除区域：ripple 前移 / 不 ripple 留空 / 边界裁剪 ===')

const A = mk('a', 0, 4)
const B = mk('b', 4, 4)
const snapshot = JSON.stringify([A, B])
const rippled = region.removeRegion([A, B], { start: 1, end: 3 })
check(
  'ripple：左残段 [0,1) 留在原地',
  rippled.length === 3 && near(rippled[0].start, 0) && near(rippled[0].duration, 1),
  JSON.stringify(pos(rippled))
)
check(
  'ripple：右残段 [3,4) 前移到 1（不是留在 3）',
  near(rippled[1].start, 1) && near(rippled[1].duration, 1) && near(rippled[1].offset, 3),
  JSON.stringify(pos(rippled))
)
check('ripple：整段在后的 B 前移 2 秒（4 → 2）', near(rippled[2].start, 2) && near(rippled[2].duration, 4), JSON.stringify(pos(rippled)))
check('ripple：总时长从 8 秒变成 6 秒', near(rippled.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0), 6))
check('入参没有被改动（纯函数）', JSON.stringify([A, B]) === snapshot)

const gapKept = region.removeRegion([A, B], { start: 1, end: 3 }, { ripple: false })
check(
  '不 ripple：右残段留在 3（"只清内容、保留时间"）',
  near(gapKept[1].start, 3) && near(gapKept[1].duration, 1),
  JSON.stringify(pos(gapKept))
)
check('不 ripple：B 不动（仍从 4 开始）', near(gapKept[2].start, 4))

const inside = region.removeRegion([mk('only', 0, 4)], { start: 1, end: 3 })
check('只覆盖一条片段的中段 ⇒ 切成两段，前后各留一半', inside.length === 2 && near(inside[0].duration, 1) && near(inside[1].start, 1))

const wholeClip = region.removeRegion([A, B], { start: 0, end: 4 })
check('区域正好等于一整段 ⇒ 那段整个消失（不留零长残段）', wholeClip.length === 1 && wholeClip[0].id === 'b', JSON.stringify(pos(wholeClip)))
check('整段消失后 B 前移到 0', near(wholeClip[0].start, 0) && near(wholeClip[0].duration, 4))

const emptyMiddle = region.removeRegion([mk('a', 0, 4), mk('b', 8, 4)], { start: 5, end: 7 })
check('区域落在空隙里 ⇒ 前面不动', near(emptyMiddle[0].start, 0) && near(emptyMiddle[0].duration, 4))
check('区域落在空隙里 ⇒ 后面仍前移（时间线整体收紧 2 秒）', near(emptyMiddle[1].start, 6), JSON.stringify(pos(emptyMiddle)))

const fastRemove = region.removeRegion([mk('f', 0, 4, { speed: 2 })], { start: 1, end: 3 })
check(
  '2 倍速片段删中段：右残段源入点 = 3×2 = 6（不是 3）',
  fastRemove.length === 2 && near(fastRemove[1].offset, 6),
  JSON.stringify(offsets(fastRemove))
)

const reversedRemove = region.removeRegion([mk('rv', 0, 4, { reverse: true })], { start: 1, end: 3 })
check(
  '倒放片段删中段：左残段入点 3、右残段入点 0（方向相反）',
  near(reversedRemove[0].offset, 3) && near(reversedRemove[1].offset, 0),
  JSON.stringify(offsets(reversedRemove))
)

check('区域数据坏了（null）⇒ 原样返回，不炸', region.removeRegion([A], null).length === 1)
check('空片段表 ⇒ 空结果', region.removeRegion([], { start: 0, end: 1 }).length === 0)

/* ------------------------- ④ 复制 / 粘贴 ------------------------- */

console.log('\n=== ④ 复制 / 粘贴：相对坐标 + 新 id + ownerId 跟着走 ===')

const copied = region.copyRegion([A, B, mk('au', 0, 3, { track: 'audio', kind: 'audio' })], { start: 1, end: 3 })
/* B 从 4 秒开始，而区间是 [1,3) ⇒ 它与区间**不相交**，不该被复制进来。
   把"区间外的那一段"也复制进去，粘贴出来就会凭空多出一段画面。 */
check('复制只取与区间有交集的片段（A 与音频 au，不含 4 秒才开始的 B）', copied.items.length === 2, JSON.stringify(copied.items.map((item) => item.id)))
check('复制的 span = 区间长度（2）', near(copied.span, 2), String(copied.span))
check(
  '复制出来的每条 start 都是**相对区间起点**（都是 0：它们原本就从 0 开始）',
  copied.items.every((item) => near(item.start, 0)),
  JSON.stringify(copied.items.map((item) => item.start))
)
check(
  '复制不改变源片段的 start（入参数没被动）',
  near(A.start, 0) && near(B.start, 4)
)

const pasteTarget = region.pasteRegion(copied.items, 10, (index) => `new_${index}`)
check('粘贴到 10 秒：起点 = 10 + 相对偏移', pasteTarget.every((item) => near(item.start, 10)), JSON.stringify(pasteTarget.map((item) => item.start)))
check('粘贴换新 id（不与原片段同 id）', pasteTarget.every((item) => String(item.id).startsWith('new_')), JSON.stringify(pasteTarget.map((item) => item.id)))
check('粘贴不改 duration（内容是原样的）', pasteTarget.every((item) => near(item.duration, 2)))

const owned = region.pasteRegion([{ ...mk('k', 0, 1), id: 'C1~kid', ownerId: 'C1' }], 5, () => 'fresh')
check('粘贴时 ownerId 跟着新 id 走（否则新片段挂到旧容器名下）', owned[0].ownerId === 'fresh' && owned[0].id === 'fresh', JSON.stringify(owned[0]))

const sortedCopy = region.copyRegion([mk('late', 3, 1), mk('early', 0, 1)], { start: 0, end: 4 })
check(
  '复制结果按轨道 + 起点排序（粘贴后叠放顺序与原时间线一致）',
  sortedCopy.items[0].id === 'early' && sortedCopy.items[1].id === 'late',
  JSON.stringify(sortedCopy.items.map((item) => item.id))
)
check('空区域 ⇒ 空剪贴板（不产生"复制成功但内容为空"）', region.copyRegion([A], null).items.length === 0)

/* ------------------------- ⑤ 只导出区域 ------------------------- */

console.log('\n=== ⑤ 只导出区域：时间整体归零 / 区间外的片段不进成片 ===')

const trimmed = region.trimToRegion([A, B], { start: 1, end: 3 })
check('裁剪后只剩一条（B 整段在区间外）', trimmed.length === 1, JSON.stringify(pos(trimmed)))
check('裁剪后时间归零（0 起、长 2 秒）', near(trimmed[0].start, 0) && near(trimmed[0].duration, 2), JSON.stringify(pos(trimmed)))
check('裁剪后源入点 = 1（内容从原时间线 1 秒处开始）', near(trimmed[0].offset, 1), String(trimmed[0].offset))

const overlap2 = region.trimToRegion([A, B], { start: 3, end: 5 })
check('跨接缝的区间切成两段（3–4 与 4–5）', overlap2.length === 2, JSON.stringify(pos(overlap2)))
check('第二段接在 1 秒处（接缝对齐）', near(overlap2[1].start, 1) && near(overlap2[1].duration, 1), JSON.stringify(pos(overlap2)))
check('区间跨接缝后总时长 = 区间长度（2 秒）', near(overlap2.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0), 2))

const beyond = region.trimToRegion([A, B], { start: 3, end: 30 })
check('区间超出内容尾部 ⇒ 只保留有内容的那部分（1 秒多）', beyond.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0) <= 5.0001)
check('区间完全在内容之后 ⇒ 空片段表（成片会是空的，由调用方报错）', region.trimToRegion([A, B], { start: 20, end: 22 }).length === 0)

/* 变元：区间裁剪不破坏「源消耗守恒」这条全项目不变式 */
const conserve = region.trimToRegion([fast, curved], { start: 1, end: 5 })
check(
  '裁剪后每段的「时长 × 倍速」仍等于它吃掉的源素材长度',
  conserve.every((clip) => {
    const span = clip.duration * speed.clipSpeed(clip)
    return Number.isFinite(span) && span > 0
  }) && conserve.length === 2,
  JSON.stringify(conserve.map((clip) => [clip.id, clip.duration, speed.clipSpeed(clip)]))
)

/* ------------------------- ⑥ 真导出 ------------------------- */

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('\nREGION_EXPORT_SKIPPED 本机没有 ffmpeg（成片侧无法验证）')
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  process.exit(fail ? 1 : 2)
}
const ffmpeg = found.ffmpeg
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-region-'))

for (const color of ['red', 'blue']) {
  spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=25`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(work, `${color}.mp4`)],
    { tag: `mk-${color}` }
  )
}
const redFile = path.join(work, 'red.mp4')
const blueFile = path.join(work, 'blue.mp4')
check('两段夹具生成完毕（红 / 蓝，各 4 秒）', fs.existsSync(redFile) && fs.existsSync(blueFile))

const clipRed = { id: 'r', track: 'video', kind: 'video', path: redFile, start: 0, duration: 2, offset: 0, sourceDuration: 4, name: 'red' }
const clipBlue = { id: 'bl', track: 'video', kind: 'video', path: blueFile, start: 2, duration: 2, offset: 0, sourceDuration: 4, name: 'blue' }
const timeline = [clipRed, clipBlue]

function centerPixel(file, at) {
  const probe = path.join(work, `px-${at}.rgb`)
  spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', probe],
    { tag: `px-${at}` }
  )
  if (!fs.existsSync(probe)) return null
  const buf = fs.readFileSync(probe)
  const i = (4 * 8 + 4) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
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

const rangeOut = path.join(work, 'range.mp4')
const rangeResult = await render.render({
  clips: timeline,
  outPath: rangeOut,
  options: { width: 320, height: 240, fps: 25, range: { start: 1, end: 3 } }
})
check('「只导出区域」导出成功', rangeResult.ok === true, String(rangeResult.error || '').slice(0, 300))
check('成片时长 = 区间长度（2 秒），不是整条时间线（4 秒）', near(rangeResult.duration, 2, 0.05), String(rangeResult.duration))
const rangeInfo = fs.existsSync(rangeOut) ? probeOut(rangeOut) : { seconds: NaN, audio: false }
check('成片文件时长 ≈ 2 秒', Math.abs(rangeInfo.seconds - 2) < 0.2, String(rangeInfo.seconds))
check('成片保留音轨', rangeInfo.audio === true)

const rangeEarly = centerPixel(rangeOut, 0.4)
const rangeLate = centerPixel(rangeOut, 1.6)
check(
  '区间 [1,3)：0.4 秒处仍是**红**（原时间线 1.4 秒处）',
  Boolean(rangeEarly) && rangeEarly[0] > 140 && rangeEarly[2] < 110,
  JSON.stringify(rangeEarly)
)
check(
  '区间 [1,3)：1.6 秒处已是**蓝**（原时间线 2.6 秒处）—— 这一条能抓住"区间没生效"',
  Boolean(rangeLate) && rangeLate[2] > 140 && rangeLate[0] < 110,
  JSON.stringify(rangeLate)
)

/* 对照组：把区间里的内容**手动拖到 0** 再导出，成片必须与"只导出区域"逐帧同色 */
const directOut = path.join(work, 'direct.mp4')
const directResult = await render.render({
  clips: [
    { ...clipRed, start: 0, duration: 1, offset: 1 },
    { ...clipBlue, start: 1, duration: 1, offset: 0 }
  ],
  outPath: directOut,
  options: { width: 320, height: 240, fps: 25 }
})
check('对照组（手工摆到 0）导出成功', directResult.ok === true, String(directResult.error || '').slice(0, 200))
check('两条路径的总时长一致', near(directResult.duration, rangeResult.duration, 0.02), `${directResult.duration} vs ${rangeResult.duration}`)
const directEarly = centerPixel(directOut, 0.4)
const directLate = centerPixel(directOut, 1.6)
check(
  '0.4 秒处两边同色（区间裁剪 ≡ 手工拖到 0）',
  Boolean(directEarly) && Boolean(rangeEarly) &&
    Math.abs(directEarly[0] - rangeEarly[0]) < 40 && Math.abs(directEarly[2] - rangeEarly[2]) < 40,
  `${JSON.stringify(rangeEarly)} vs ${JSON.stringify(directEarly)}`
)
check(
  '1.6 秒处两边同色',
  Boolean(directLate) && Boolean(rangeLate) &&
    Math.abs(directLate[0] - rangeLate[0]) < 40 && Math.abs(directLate[2] - rangeLate[2]) < 40,
  `${JSON.stringify(rangeLate)} vs ${JSON.stringify(directLate)}`
)

/* 区间边界必须精确：区间 [0.5, 1.5) 只覆盖红色段，成品里不该有蓝帧 */
const redOnlyOut = path.join(work, 'red-only.mp4')
const redOnly = await render.render({
  clips: timeline,
  outPath: redOnlyOut,
  options: { width: 320, height: 240, fps: 25, range: { start: 0.5, end: 1.5 } }
})
check('小区间（1 秒）导出成功', redOnly.ok === true, String(redOnly.error || '').slice(0, 200))
const tail = centerPixel(redOnlyOut, 0.9)
check(
  '小区间 0.9 秒处仍是红 —— 边界没有多切进来一段蓝',
  Boolean(tail) && tail[0] > 140 && tail[2] < 110,
  JSON.stringify(tail)
)

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('REGION_FAILED')
  for (const item of problems) console.log(`  - ${item}`)
  console.log(`夹具目录（保留证据）：${work}`)
  process.exit(1)
} else {
  console.log('REGION_OK')
  fs.rmSync(work, { recursive: true, force: true })
  process.exit(0)
}
