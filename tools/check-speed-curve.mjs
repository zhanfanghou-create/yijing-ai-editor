#!/usr/bin/env node
/**
 * 曲线变速 / 卡点 / 音高 的自检（**纯函数，不开 Electron**）。
 *
 * 这一族缺陷的共同点：**每一件都算得出来，但都看不见**。
 *   · 曲线下面积算错 → 片段在时间线上占的长度不对，后面的片段被压住一截；
 *   · 源进度累计算错 → 预览的画面与成片对不上（起点对、越播越歪）；
 *   · 导出分段漏了一段 → 成片比时间线短，而 ffmpeg 一句错都不报；
 *   · 每段 speed 与 srcLen/dur 不一致 → setpts 与段长打架，画面每段跳一下；
 *   · 卡点把慢窗叠在一起 → 曲线变直线，"卡点"看起来完全没效果；
 *   · 变调用 asetrate 却没拿 atempo 抵消 → 片段在成片里变短（音画不同步）。
 *
 * 所以本脚本只做一件事：把这些量**算出来并互相校验**
 * （面积 vs 分段求和、分段时长 vs 片段占位、分段源长 vs 源跨度……）。
 *
 * 用法：
 *   node tools/check-speed-curve.mjs             # 正检
 *   node tools/check-speed-curve.mjs --selftest  # 自证：故意喂错，确认断言真的会红
 *
 * 退出码：0 = 通过；1 = 有失败。
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const SRC = path.join(root, 'packages', 'desktop', 'src', 'shared')

const speed = require(path.join(SRC, 'speed.js'))
const beat = require(path.join(SRC, 'beat.js'))

const selftest = process.argv.includes('--selftest')

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

const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0)

/* ============================ A. 规范化 ============================ */

console.log('\n== A. 曲线规范化（脏数据不许漏到下游） ==')

check('null 不是曲线', speed.normalizeCurve(null) === null)
check('空数组不是曲线', speed.normalizeCurve([]) === null)
check('只有一个点不是曲线（连不成线）', speed.normalizeCurve([[0, 2]]) === null)
check('坏点被丢掉，剩两个就成立', (speed.normalizeCurve([[0, 1], [0.5, null], [1, 2]]) || []).length === 2)
check('全坏 → null', speed.normalizeCurve([[0, 'a'], [1, undefined]]) === null)

const sorted = speed.normalizeCurve([[1, 2], [0, 1]])
check('乱序点被排序（首 p=0 末 p=1）', sorted[0].p === 0 && sorted[sorted.length - 1].p === 1)
check('乱序排序后值跟着点走', near(sorted[0].v, 1) && near(sorted[1].v, 2))

const clamped = speed.normalizeCurve([[0, 99], [1, -5]])
check('速率被夹进 0.25–4', near(clamped[0].v, speed.SPEED_MAX) && near(clamped[1].v, speed.SPEED_MIN))

const dup = speed.normalizeCurve([[0, 1], [0.5, 2], [0.5001, 3], [1, 1]])
check('同位置两点被合并（不产生 Δp=0）', dup.length === 3)
check(
  '合并后仍严格递增（否则插值除零）',
  dup.every((point, index) => index === 0 || point.p > dup[index - 1].p)
)

const partial = speed.normalizeCurve([[0.3, 2], [0.7, 2]])
check('缺首尾时自动补齐到 0 与 1', partial[0].p === 0 && partial[partial.length - 1].p === 1)
check('补齐用端点的值（水平延伸）', near(partial[0].v, 2) && near(partial[partial.length - 1].v, 2))

check(
  '对象形状 {p,v} 与数组形状 [p,v] 等价',
  JSON.stringify(speed.normalizeCurve([{ p: 0, v: 1 }, { p: 1, v: 3 }])) ===
    JSON.stringify(speed.normalizeCurve([[0, 1], [1, 3]]))
)

/* ============================ B. 面积与映射 ============================ */

console.log('\n== B. 曲线下面积 = 平均速度（源消耗的唯一口径） ==')

check('常速 1x 的面积是 1', near(speed.curveMean([[0, 1], [1, 1]]), 1))
check('常速 2x 的面积是 2', near(speed.curveMean([[0, 2], [1, 2]]), 2))
check('梯形 [0.5→1] 的面积是 0.75', near(speed.curveMean([[0, 0.5], [1, 1]]), 0.75))
check(
  '两段梯形面积可分（0.25 + 0.375 = 0.625）',
  near(speed.curveMean([[0, 0.5], [0.5, 0.5], [1, 1]]), 0.625)
)

const ramp = [[0, 0.5], [0.5, 0.5], [1, 2]]
check('curveAt 端点准确', near(speed.curveAt(ramp, 0), 0.5) && near(speed.curveAt(ramp, 1), 2))
check('curveAt 段内线性', near(speed.curveAt(ramp, 0.75), 1.25))
check('curveAt 越界夹取', near(speed.curveAt(ramp, -3), 0.5) && near(speed.curveAt(ramp, 9), 2))

check('常速曲线 p=0.5 时消耗一半', near(speed.curveSourceFrac([[0, 1], [1, 1]], 0.5), 0.5))
/* ramp 的面积 = 0.25（前段）+ 0.625（后段）= 0.875，前半只占 2/7 */
check('前慢后快：p=0.5 时只吃掉 2/7 的源', near(speed.curveSourceFrac(ramp, 0.5), 2 / 7, 1e-9))
check('p=1 时吃掉全部', near(speed.curveSourceFrac(ramp, 1), 1))

let monotonic = true
for (let i = 1; i <= 40; i += 1) {
  const a = speed.curveSourceFrac(ramp, (i - 1) / 40)
  const b = speed.curveSourceFrac(ramp, i / 40)
  if (b < a - 1e-12) monotonic = false
}
check('源进度随播放头单调不减（不会倒着取帧）', monotonic)

/* ============================ C. 片段级换算 ============================ */

console.log('\n== C. 片段：总倍速 / 源时间 / 瞬时速率 ==')

const curved = { start: 10, duration: 4, offset: 2, speed: 1, speedCurve: { points: [[0, 0.5], [0.5, 0.5], [1, 2]] } }
check('有曲线时总倍速 = 面积（不是 clip.speed）', near(speed.clipSpeed(curved), 0.875))
check('无曲线时总倍速 = clip.speed', near(speed.clipSpeed({ speed: 2.5 }), 2.5))
check('speed 缺省仍是 1', near(speed.clipSpeed({}), 1))
check('源跨度 = 占位 × 面积', near(speed.sourceSpan(curved), 3.5))

check('无曲线时 curveSourceTime 返回 null（交给常速那条路）', speed.curveSourceTime({ duration: 4, offset: 0 }, 1) === null)

const headSource = speed.curveSourceTime(curved, 10)
const tailSource = speed.curveSourceTime(curved, 14)
check('片段起点对应源入点', near(headSource, 2))
check('片段终点对应 入点 + 源跨度', near(tailSource, 5.5))
check('片段之外夹取（取首帧）', near(speed.curveSourceTime(curved, 5), 2))
check('片段之后夹取（取末帧）', near(speed.curveSourceTime(curved, 99), 5.5))

/* 中段：p=0.5 处只吃了 2/7 的源 ⇒ 2 + 3.5×(2/7) = 3。
   按平均速度乘会得到 2 + 2×0.875 = 3.75 —— 那 0.75 秒的差就是"预览与成片对不上"。 */
check('片段中点按累计面积取源（不是按平均速度乘）', near(speed.curveSourceTime(curved, 12), 3))

const rateAtHead = speed.clipRateAt(curved, 10)
const rateAtTail = speed.clipRateAt(curved, 14)
check('瞬时速率跟随曲线（头 0.5x）', near(rateAtHead, 0.5))
check('瞬时速率跟随曲线（尾 2x）', near(rateAtTail, 2))
check('倒放时不走曲线（退回总倍速）', near(speed.clipRateAt({ ...curved, reverse: true }, 10), 0.875))

/* ============================ D. 导出分段 ============================ */

console.log('\n== D. 导出分段：三条不变式 ==')

const segments = speed.curveSegments(curved.speedCurve.points, 4, 12)
check('段数 ≥ 2（否则根本不需要分段）', segments.length >= 2)
check('段数 ≤ 上限', segments.length <= 12)
check('Σ 段时长 = 时间线占位', near(sum(segments, (seg) => seg.dur), 4, 1e-6), `${sum(segments, (seg) => seg.dur)}`)
check('Σ 段源长 = 源跨度', near(sum(segments, (seg) => seg.srcLen), 3.5, 1e-6), `${sum(segments, (seg) => seg.srcLen)}`)
check(
  '每段 速率 = 该段源长 / 该段时长',
  segments.every((seg) => near(seg.speed, Math.min(4, Math.max(0.25, seg.srcLen / seg.dur)), 1e-3))
)
check('段起点连续（首段 0）', near(segments[0].srcStart, 0))
check(
  '段起点连续（末段接上源跨度）',
  near(segments[segments.length - 1].srcStart + segments[segments.length - 1].srcLen, 3.5, 1e-6)
)
check(
  '中间每段起点 = 上一段终点',
  segments.every((seg, index) => index === 0 || near(seg.srcStart, segments[index - 1].srcStart + segments[index - 1].srcLen, 1e-9))
)

const flat = speed.curveSegments([[0, 1], [1, 1]], 4, 12)
check('匀速曲线只切出一段（不白花滤镜）', flat.length === 1)

/* 预设曲线都要能切出合法分段：这是"预设点了没反应"的第一道防线 */
const presetProblems = []
for (const preset of speed.CURVE_PRESETS) {
  if (!preset.points) continue
  const segs = speed.curveSegments(preset.points, 6, 12)
  const totalDur = sum(segs, (seg) => seg.dur)
  const totalSrc = sum(segs, (seg) => seg.srcLen)
  const mean = speed.curveMean(preset.points)
  if (segs.length < 2 || Math.abs(totalDur - 6) > 1e-6 || Math.abs(totalSrc - 6 * mean) > 1e-6) {
    presetProblems.push(`${preset.key}: ${segs.length} 段 / ${totalDur} / ${totalSrc}`)
  }
}
check(`四个预设都能切出合法分段（${speed.CURVE_PRESETS.filter((item) => item.points).length} 条）`, presetProblems.length === 0, presetProblems.join(' | '))

/* ============================ E. 由曲线生成补丁 ============================ */

console.log('\n== E. 应用曲线（源跨度守恒） ==')

const patch = speed.curvePatch({ duration: 4, speed: 1 }, [[0, 0.5], [0.5, 0.5], [1, 2]])
check('补丁带新总倍速（= 面积）', patch && near(patch.speed, 0.875))
check('补丁带规范化后的点列', patch && Array.isArray(patch.speedCurve.points) && patch.speedCurve.points.length === 3)
check('点列是 [p,v] 对（草稿 JSON 更省）', patch && Array.isArray(patch.speedCurve.points[0]))
check('点列首尾覆盖 0 与 1', patch && patch.speedCurve.points[0][0] === 0 && patch.speedCurve.points[2][0] === 1)
check('坏点列返回 null（不写半个补丁进草稿）', speed.curvePatch({ duration: 4 }, [[0, 1]]) === null)

/* ============================ F. 卡点 ============================ */

console.log('\n== F. 变速卡点（由重音生成曲线） ==')

check('没有节拍 → null', speed.curveFromBeats(6, [], {}) === null)
check('节拍全在片段外 → null', speed.curveFromBeats(6, [0.001, 9], {}) === null)

const beatCurve = speed.curveFromBeats(6, [1.5, 3, 4.5], { fast: 2, slow: 0.35, hold: 0.3 })
check('三个节拍都命中', beatCurve && beatCurve.hits === 3)
check('曲线里确实存在慢档点', beatCurve && beatCurve.points.some((pair) => near(pair[1], 0.35, 0.02)))
check('曲线里确实存在快档点', beatCurve && beatCurve.points.some((pair) => near(pair[1], 2, 0.02)))
const beatMean = speed.curveMean(beatCurve.points)
check('生成曲线的平均速度在慢档与快档之间', beatMean > 0.35 && beatMean < 2, `${beatMean}`)
check(
  '生成曲线能被切成分段（不是"点了没反应"）',
  speed.curveSegments(beatCurve.points, 6, 12).length >= 2
)

const dense = Array.from({ length: 20 }, (_item, index) => 0.3 + index * 0.25)
const denseCurve = speed.curveFromBeats(6, dense, { fast: 2.2, slow: 0.3, hold: 0.3 })
check('密集节拍只取前 12 个（否则导出段数爆掉）', denseCurve && denseCurve.hits <= 12, `${denseCurve && denseCurve.hits}`)
const denseSpread = Math.max(...denseCurve.points.map((pair) => pair[1])) - Math.min(...denseCurve.points.map((pair) => pair[1]))
check('密集节拍下曲线仍有起伏（慢窗没被叠成直线）', denseSpread > 1, `${denseSpread}`)

const edge = speed.curveFromBeats(6, [0.01, 5.99, 3], {})
check('两端 0.02 秒内的节拍被丢掉', edge && edge.hits === 1)

/* ============================ G. 音高 ============================ */

console.log('\n== G. 保音高 / 变调（时长必须守恒） ==')

check('保音高走 atempo（原样）', speed.pitchChain(2, true) === speed.atempoChain(2))
check('保音高缺省（不传第二个参数）也走 atempo', speed.pitchChain(2) === speed.atempoChain(2))
const tape = speed.pitchChain(2, false)
check('不保音高走 asetrate', /asetrate=96000/.test(tape), tape)
check('不保音高后面一定跟 aresample 回 48000', /aresample=48000/.test(tape), tape)
check('不保音高时**不出现** atempo（出现了音高就白改了）', !/atempo/.test(tape), tape)
check('原速时不保音高也不需要滤镜', speed.pitchChain(1, false) === '')

check('0 半音不变调', speed.semitoneChain(0) === '')
const up = speed.semitoneChain(12)
check('+12 半音 = 八度：采样率翻倍', /asetrate=96000/.test(up), up)
check('+12 半音用 atempo=0.5 把时长拉回来', /atempo=0.5/.test(up), up)
const down = speed.semitoneChain(-12)
check('-12 半音：采样率减半', /asetrate=24000/.test(down), down)
check('-12 半音用 atempo=2 把时长拉回来', /atempo=2/.test(down), down)
check(
  '半音越界被夹到 ±12（atempo 只吃 0.5–2.0）',
  /atempo=0.5/.test(speed.semitoneChain(24)) && /atempo=2/.test(speed.semitoneChain(-24))
)

/* ============================ H. 节拍检测 ============================ */

console.log('\n== H. 节拍检测（包络 → 重音时刻） ==')

/** 合成一段包络：底噪 0.1，每 0.5 秒一个两桶宽的尖峰（=120 BPM） */
function synthetic(bpm = 120, seconds = 4, spb = 0.01) {
  const count = Math.round(seconds / spb)
  const peaks = new Array(count).fill(0.1)
  const step = 60 / bpm
  for (let t = step; t < seconds - 0.05; t += step) {
    const at = Math.round(t / spb)
    peaks[at] = 0.95
    if (at + 1 < count) peaks[at + 1] = 0.8
  }
  return { peaks, spb }
}

const syn = synthetic()
const hits = beat.detectBeats(syn.peaks, syn.spb)
check('120BPM 合成包络检出 3 个点（1.0 / 1.5 / 2.0 之外的都算）', hits.length >= 3 && hits.length <= 8, JSON.stringify(hits))
check('检出的间隔约 0.5 秒', hits.length >= 2 && near(hits[1] - hits[0], 0.5, 0.06), JSON.stringify(hits.slice(0, 4)))

const flatPeaks = new Array(400).fill(0.3)
check('全平包络检不出节拍', beat.detectBeats(flatPeaks, 0.01).length === 0)
check('空包络返回空数组', beat.detectBeats([], 0.01).length === 0)
check('桶宽非法返回空数组', beat.detectBeats(flatPeaks, 0).length === 0)
check('采样太少返回空数组（不足以判断节拍）', beat.detectBeats([1, 2, 3], 0.01).length === 0)

const lowSen = beat.detectBeats(syn.peaks, syn.spb, { sensitivity: 5 })
const highSen = beat.detectBeats(syn.peaks, syn.spb, { sensitivity: 95 })
check('灵敏度调高不会检出更少', highSen.length >= lowSen.length, `${lowSen.length} → ${highSen.length}`)

/* 两个相邻很近的尖峰：minGap 只留一个 */
const tight = new Array(200).fill(0.05)
tight[50] = 0.9
tight[52] = 0.95
check('minGap 生效（0.02 秒内的两个峰只留一个）', beat.detectBeats(tight, 0.01, { minGap: 0.14 }).length === 1)

/* 落在区间端点上（正好 0 / 正好整段）的节拍会被丢掉：慢窗会伸到片段外，
   导出分段时会取到负的源时间 */
const shifted = beat.beatsInRange([2.1, 3.5, 7.9], 2, 8)
check(
  'beatsInRange 平移成片段内秒数',
  shifted.length === 3 && near(shifted[0], 0.1) && near(shifted[1], 1.5) && near(shifted[2], 5.9),
  JSON.stringify(shifted)
)
check('beatsInRange 丢掉两端 0.02 秒内的点', beat.beatsInRange([2.01, 5, 7.995], 2, 8).length === 1)

/* ============================ 自证 ============================ */

/**
 * 自证：把"错误状态"写出来，确认它被判为假。
 * 这一层挡的是**检查器空转** —— 比如面积函数被改成恒返回 1，上面那些断言照样全绿。
 */
if (selftest) {
  console.log('\n== 自证：错误状态必须被判为假 ==\n')
  let caught = 0
  const mustFail = [
    ['面积按均值近似（梯形曲线会算成 1.0）', () => near(speed.curveMean([[0, 0.5], [1, 2]]), 1)],
    ['源进度按线性处理（前慢后快时 p=0.5 吃掉一半）', () => near(speed.curveSourceFrac([[0, 0.5], [0.5, 0.5], [1, 2]], 0.5), 0.5)],
    ['分段时长总和漏了最后一段', () => near(sum(speed.curveSegments([[0, 0.5], [0.5, 0.5], [1, 2]], 4, 12).slice(0, -1), (seg) => seg.dur), 4)],
    ['分段速率用平均速度（不是该段自己的）', () => {
      const segs = speed.curveSegments([[0, 0.5], [0.5, 0.5], [1, 2]], 4, 12)
      return segs.every((seg) => near(seg.speed, 0.75, 1e-3))
    }],
    ['变调只改采样率、没抵消时长', () => !/atempo/.test(speed.semitoneChain(12))],
    ['不保音高却仍插了 atempo', () => /atempo/.test(speed.pitchChain(2, false))],
    ['卡点慢窗叠在一起（曲线变直线）', () => {
      const denseBeats = Array.from({ length: 20 }, (_item, index) => 0.3 + index * 0.25)
      const built = speed.curveFromBeats(6, denseBeats, { fast: 2.2, slow: 0.3, hold: 0.3 })
      const values = built.points.map((pair) => pair[1])
      return Math.max(...values) - Math.min(...values) < 0.5
    }],
    /* 没有最小间隔时，一段 20Hz 的密集点击会返回一串间隔 0.05 秒的"节拍"，
       卡点曲线会因此退化成一条平线（每个点都挤在一起） */
    ['节拍检测没有最小间隔限制', () => {
      const fast = new Array(400).fill(0.02)
      for (let i = 10; i < 390; i += 5) fast[i] = 0.9
      const hits = beat.detectBeats(fast, 0.01)
      return hits.some((value, index) => index > 0 && value - hits[index - 1] < 0.13)
    }]
  ]
  for (const [label, wrongState] of mustFail) {
    if (!wrongState()) {
      caught += 1
      console.log(`  ✓ ${label} —— 错误状态为假（判据可分辨）`)
    } else {
      fail += 1
      problems.push(`自证失败：${label} 竟然成立`)
      console.log(`  ✗ 自证失败：${label} 竟然成立（判据不可分辨）`)
    }
  }
  console.log(`\n自证：${caught}/${mustFail.length} 个错误状态被判为假`)
}

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('SPEED_CURVE_FAILED')
  for (const item of problems) console.log(`  - ${item}`)
  process.exit(1)
}
console.log(selftest ? 'SPEED_CURVE_SELFTEST_OK' : 'SPEED_CURVE_OK')
process.exit(0)
