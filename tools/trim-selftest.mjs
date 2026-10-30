#!/usr/bin/env node
/**
 * trim.js 的自证夹具。
 *
 * 为什么值得单开一道：片段修剪的算术**错了不报错**。
 * 最典型的一种是"左端往右剪时只改了 start/duration，忘了同步 offset"——
 * 界面上看不出任何异常（片段确实变短了），只有导出成片才会发现
 * 右半段画面从源文件开头重播了一遍。手拖是没人会回归的，所以用夹具钉住。
 *
 * 本夹具的重点断言是两条**代数不变量**（它们比逐例比对更能抓住本质）：
 *   1. 剪左端时 `start + duration` 恒定 —— 片段的**结束点**不该被移动；
 *   2. 剪左端时 `offset - start` 恒定 —— 源入点与时间线起点的相对关系不变，
 *      也就是"同一帧不会被播两遍 / 不会凭空跳过一帧"。
 * 再用一批随机输入扫一遍，确认任何组合下 duration ≥ min、offset ≥ 0、start ≥ 0。
 *
 * F 段是 `sourceTimeAt` 的夹具：把时间线时刻映射到**源文件时间**。
 * 它和修剪是同一套坐标换算的两个方向，缺陷表现也一样（错了不报错）——
 * 预览区会显示源文件里另一处的画面，而不是该片段该处的那一帧。
 *
 * 输出：TRIM_SELFTEST_PASSED / TRIM_SELFTEST_FAILED + 「TRIM_SELFTEST_STATS total=N pass=P fail=F」
 */
import * as trim from '../packages/desktop/src/renderer/trim.js'
import {
  MIN_CLIP_SECONDS,
  clipSpeed,
  sourceSpan,
  sourceTimeAt,
  speedPatch,
  trimPatch
} from '../packages/desktop/src/renderer/trim.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  ::  ${detail}`}`)
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

/* ------------------------------------------------- A. 退化输入不抛、返回 null */

check('edge 非法时返回 null', trimPatch({ start: 1, duration: 2, offset: 0 }, 'middle', 2) === null)
check('duration 为 0 时返回 null', trimPatch({ start: 1, duration: 0, offset: 0 }, 'end', 2) === null)
check('at 非数字时返回 null', trimPatch({ start: 1, duration: 2, offset: 0 }, 'end', NaN) === null)
check('clip 为 null 时不抛且返回 null', trimPatch(null, 'end', 2) === null)
check('offset 缺省时按 0 处理且不抛', trimPatch({ start: 0, duration: 2 }, 'start', 1) !== null)

/* ------------------------------------------------------------ B. 右端修剪 */

const base = { start: 2, duration: 4, offset: 1.5 } // 结束点 6

const grow = trimPatch(base, 'end', 7)
check('右端往右拉：时长 +1', grow && near(grow.duration, 5), JSON.stringify(grow))
check('右端往右拉：起点与入点都不动', grow && near(grow.start, 2) && near(grow.offset, 1.5), JSON.stringify(grow))

const shrink = trimPatch(base, 'end', 5)
check('右端往左拉：时长 -1', shrink && near(shrink.duration, 3), JSON.stringify(shrink))
check('右端往左拉：入点仍不动（只是提前收尾）', shrink && near(shrink.offset, 1.5), JSON.stringify(shrink))

const tooShort = trimPatch(base, 'end', 0)
check(
  `右端压不到 min 以下（结果 ${tooShort && tooShort.duration}）`,
  tooShort && near(tooShort.duration, MIN_CLIP_SECONDS),
  JSON.stringify(tooShort)
)
check('右端没动时返回 null（不写无意义状态）', trimPatch(base, 'end', 6) === null)

/* ------------------------------------------- C. 左端修剪（offset 必须同步） */

const byRight = trimPatch(base, 'start', 3)
check('左端往右剪 1 秒：起点 +1', byRight && near(byRight.start, 3), JSON.stringify(byRight))
check('左端往右剪 1 秒：时长 -1', byRight && near(byRight.duration, 3), JSON.stringify(byRight))
check('左端往右剪 1 秒：源入点 +1（不同步就是"画面重播"那个 bug）', byRight && near(byRight.offset, 2.5), JSON.stringify(byRight))
check('剪左端不移动结束点（start+duration 恒定）', byRight && near(byRight.start + byRight.duration, 6), JSON.stringify(byRight))
check('剪左端不改变源入点与起点的差值（offset-start 恒定）', byRight && near(byRight.offset - byRight.start, base.offset - base.start), JSON.stringify(byRight))

const byLeft = trimPatch(base, 'start', 1.5)
check('左端往左拉 0.5 秒：起点 -0.5 且入点 -0.5', byLeft && near(byLeft.start, 1.5) && near(byLeft.offset, 1), JSON.stringify(byLeft))
check('左端往左拉：结束点仍不动', byLeft && near(byLeft.start + byLeft.duration, 6), JSON.stringify(byLeft))

// offset 只有 1.5 秒，往左最多退到 start=0.5（此时 offset=0）
const clampOffset = trimPatch(base, 'start', -3)
check('左端往左拉过头：源入点夹到 0，不再后退', clampOffset && near(clampOffset.offset, 0), JSON.stringify(clampOffset))
check('左端往左拉过头：起点落在 start-offset 处', clampOffset && near(clampOffset.start, 0.5), JSON.stringify(clampOffset))
check('左端往左拉过头：时长等于"入点全放出来"', clampOffset && near(clampOffset.duration, 5.5), JSON.stringify(clampOffset))

// offset 为 0 时，左端往左拉应当完全没有空间
check('入点为 0 时左端不能再往左（返回 null）', trimPatch({ start: 1, duration: 2, offset: 0 }, 'start', 0.2) === null)

const minClamp = trimPatch(base, 'start', 99)
check(
  `左端压不到 min 以下（结果 ${minClamp && minClamp.duration}）`,
  minClamp && near(minClamp.duration, MIN_CLIP_SECONDS),
  JSON.stringify(minClamp)
)
check('左端没动时返回 null', trimPatch(base, 'start', 2) === null)
check('左端起点不小于 0', trimPatch({ start: 0.1, duration: 2, offset: 5 }, 'start', -10).start >= 0)

/* --------------------------- C2. 右端上限 = 源片剩余 --------------------------- */

const withSource = { start: 0, duration: 2, offset: 1, sourceDuration: 5 } // 还剩 4 秒可用

const pulled = trimPatch(withSource, 'end', 10)
check(
  '右端拉不过源片长度（否则导出尾部是黑帧）',
  pulled && near(pulled.duration, 4),
  JSON.stringify(pulled)
)
check(
  '在源片长度以内可以自由拉伸',
  (() => {
    const p = trimPatch(withSource, 'end', 3.5)
    return p && near(p.duration, 3.5)
  })(),
  JSON.stringify(trimPatch(withSource, 'end', 3.5))
)
check(
  '源片长度未知（缺字段）时视为不设上限',
  (() => {
    const p = trimPatch({ start: 0, duration: 2, offset: 1 }, 'end', 10)
    return p && near(p.duration, 10)
  })(),
  JSON.stringify(trimPatch({ start: 0, duration: 2, offset: 1 }, 'end', 10))
)
check(
  '源片只剩不到 min 时退到 min（而不是产出 0 长片段）',
  (() => {
    const p = trimPatch({ start: 0, duration: 1, offset: 4.98, sourceDuration: 5 }, 'end', 10)
    return p && near(p.duration, MIN_CLIP_SECONDS)
  })(),
  JSON.stringify(trimPatch({ start: 0, duration: 1, offset: 4.98, sourceDuration: 5 }, 'end', 10))
)

/* ------------------------------------------------- D. 随机扫描：不变量 */

let scanFail = null
let seed = 20260926
/** 固定种子的线性同余，保证每次跑同一批输入（夹具要可复现，不能真随机）。数字只是种子，无日期含义 */
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

for (let i = 0; i < 400 && !scanFail; i += 1) {
  const offset = rnd() * 8
  const duration = 0.3 + rnd() * 6
  // 三种源片长度都要扫到：未知(0) / 比片段长 / 比片段短（后者最容易漏掉上限）
  const mode = rnd()
  const sourceDuration = mode < 0.25 ? 0 : mode < 0.6 ? offset + duration + rnd() * 4 : offset + duration * (0.3 + rnd() * 0.9)
  const clip = { start: rnd() * 10, duration, offset, sourceDuration }
  const edge = rnd() < 0.5 ? 'start' : 'end'
  const at = -2 + rnd() * 20
  const patch = trimPatch(clip, edge, at)
  if (!patch) continue
  const problems = []
  if (!(patch.duration >= MIN_CLIP_SECONDS - 1e-9)) problems.push(`duration=${patch.duration}`)
  if (!(patch.offset >= -1e-9)) problems.push(`offset=${patch.offset}`)
  if (!(patch.start >= -1e-9)) problems.push(`start=${patch.start}`)
  // 取用范围与源片长度的关系。注意这不是一句「结果必须合法」——有两个原因：
  //   ① 老草稿里本来就可能存在已超源片的片段（上限是后来才加的），而左端修剪只移动
  //      左边界，按定义无法修尾部，它保证的是「不放大超出量」；
  //   ② 上限与最短时长会打架：源片只剩不到 min 时二者不可兼得，此时 min 优先
  //      （片段短到鼠标抓不回来更糟），右端也只能做到「不放大超出量」。
  // 所以统一断言单调性：超出量只减不增。对**合法输入**它退化成「结果必须合法」，
  // 是强约束；对非法输入它保证「越修越糟」不会发生。精确收敛由上面的具名用例钉住。
  if (sourceDuration > 0) {
    const overBefore = clip.offset + clip.duration - sourceDuration
    const overAfter = patch.offset + patch.duration - sourceDuration
    if (!(overAfter <= Math.max(overBefore, 0) + 1e-6)) {
      problems.push(
        `${edge === 'end' ? '右端' : '左端'}修剪把超出量放大了：${overBefore} -> ${overAfter}` +
          `（offset+duration=${patch.offset + patch.duration}, sourceDuration=${sourceDuration}）`
      )
    }
  }
  if (edge === 'start' && !near(patch.start + patch.duration, clip.start + clip.duration, 1e-6)) {
    problems.push('结束点被移动了')
  }
  if (edge === 'start' && !near(patch.offset - patch.start, clip.offset - clip.start, 1e-6)) {
    problems.push('offset-start 变了（同一帧会被播两遍）')
  }
  if (edge === 'end' && !near(patch.offset, clip.offset, 1e-9)) problems.push('右端修剪动了入点')
  if (problems.length) {
    scanFail = `${JSON.stringify({ clip, edge, at })} -> ${JSON.stringify(patch)} :: ${problems.join(' / ')}`
  }
}
check('400 组随机输入下修剪不变量成立（右端收敛到源片 / 左端不放大超出量）', !scanFail, scanFail || '')

/* --------------------------------- D2. 老草稿里「已经超源片」的片段（上限是后加的） */

// 上限是后来才加的，所以历史草稿里可能存在 offset+duration > sourceDuration 的片段。
// 这种片段的尾部本来就会导出黑帧，为此有两件事必须成立：
// ① 用户拖左端时不能把超出的部分拖得更多（否则越修越黑）；
// ② 用户拖一次右端就能把它拉回源片长度以内（可自愈，不需要用户手动删了重建）。
const legacy = { start: 1, duration: 4, offset: 3, sourceDuration: 5 } // 3+4=7 > 5，超出 2 秒
const legacyLeft = trimPatch(legacy, 'start', 2)
check(
  '老草稿里已超源片的片段：左端修剪不会让超出量变大',
  legacyLeft &&
    near(legacyLeft.offset + legacyLeft.duration, 7, 1e-9) &&
    near(legacyLeft.offset + legacyLeft.duration, legacy.offset + legacy.duration, 1e-9),
  JSON.stringify(legacyLeft)
)
const legacyRight = trimPatch(legacy, 'end', 99)
check(
  '老草稿里已超源片的片段：右端修剪一次就收敛回源片长度',
  legacyRight && legacyRight.offset + legacyRight.duration <= 5 + 1e-6 && near(legacyRight.offset, 3, 1e-9),
  JSON.stringify(legacyRight)
)

// 上限与最短时长打架的取舍：源片只剩 0.09 秒（< min=0.2），无法既满足 min 又满足上限。
// 规则是 **min 优先**（片段短到鼠标抓不回来更糟），代价是允许继续略微超上限。
// 这条用例的作用就是把"取舍方向"写死：以后谁把优先级改成上限优先，这里会红。
const tiny = { start: 0, duration: 0.5, offset: 4.91, sourceDuration: 5 }
const tinyPatch = trimPatch(tiny, 'end', 10)
check(
  '源片剩余不足 min 时：右端仍退回 min（min 优先级高于上限），且不放大超出量',
  tinyPatch &&
    near(tinyPatch.duration, MIN_CLIP_SECONDS, 1e-9) &&
    tinyPatch.offset + tinyPatch.duration <= tiny.offset + tiny.duration + 1e-9,
  JSON.stringify(tinyPatch)
)

/* --------------------------------------------------------- E. 幂等与稳定性 */

const once = trimPatch(base, 'start', 3)
const twice = trimPatch(base, 'start', 3)
check('同一输入重复调用结果一致（无隐藏状态）', JSON.stringify(once) === JSON.stringify(twice))
// 对结果再剪同一位置应当"无变化"，否则会一步一停地漂
check('对刚剪过的片段在同一位置再剪 = 无变化', trimPatch(once, 'start', 3) === null)

/* ------------------------- F. 时间线时刻 → 源文件时间（预览取帧） */

// 片段放在时间线第 10 秒起、长 4 秒、源入点 30 秒。
// 于是时间线的 10.0/12.0/14.0 依次对应源文件的 30/32/34 —— 三个数刻意**都不同**，
// 这样"直接用 playhead 当源时间"和"漏掉 offset 只减 start"两类写法都会当场红。
const placed = { start: 10, duration: 4, offset: 30 }

check('片段起点 → 源入点（不是时间线的 10 秒）', near(sourceTimeAt(placed, 10), 30))
check('片段中点 → 入点 + 偏移量', near(sourceTimeAt(placed, 12), 32))
check('片段内任意位置都满足 源时间 = offset + (t - start)', near(sourceTimeAt(placed, 13.25), 33.25))
check('片段末尾 → 入点 + 时长', near(sourceTimeAt(placed, 14), 34))

// 越界必须**夹**到片段两端。夹而不是放行，是因为各平台对越界 currentTime 的处理不一致：
// 有的取末帧、有的黑屏、有的直接抛。正确性不能寄托在播放器的实现上。
check('播放头在片段之前 → 夹到首帧（源入点）', near(sourceTimeAt(placed, 7), 30))
check('播放头在片段之后 → 夹到末帧（入点+时长）', near(sourceTimeAt(placed, 99), 34))
check('播放头为负 → 夹到首帧', near(sourceTimeAt(placed, -5), 30))

// 退化输入：预览区在时间线空白处会拿到 null 片段，不能抛
check('clip 为 null 时返回 0 且不抛', sourceTimeAt(null, 3) === 0)
check('duration 为 0 时返回 0', sourceTimeAt({ start: 5, duration: 0, offset: 2 }, 5) === 0)
check('offset 缺省时按 0 处理', near(sourceTimeAt({ start: 5, duration: 2 }, 6), 1))
check('时间非数字时退回源入点（不返回 NaN）', near(sourceTimeAt(placed, NaN), 30))

// 与修剪的联动：这正是两个缺陷会互相掩盖的地方 ——
// 剪掉左端 2 秒后 start 与 offset 同时 +2，因此"同一个绝对时刻"对应的源时间不变。
// 换句话说：剪左端**不会**让已经在播的那一帧换画面。若任一函数忘了同步，这条会红。
const trimmedHead = trimPatch(placed, 'start', 12)
check(
  '剪左端后：同一绝对时刻的源时间不变（修剪与取帧用的是同一套坐标）',
  trimmedHead && near(sourceTimeAt(trimmedHead, 12), sourceTimeAt(placed, 12)),
  JSON.stringify(trimmedHead)
)

/* ------------------------------------------------------------- 倍速 */

/**
 * 倍速这一组断言盯的是「同一个数在两个坐标系里的换算」：
 * 时间线秒 ↔ 源素材秒，换算因子就是 speed。
 * 漏掉因子的症状是**预览与成片不一致**（一边乘了一边没乘），
 * 两边单独看都对，所以必须由算术层这里钉死。
 */

check('缺省 speed 视为原速', clipSpeed({ duration: 3 }) === 1)
check('speed 为 0 视为原速（0 会让 ffmpeg 的 PTS/0 直接崩）', clipSpeed({ speed: 0 }) === 1)
check('speed 为负视为原速（负数会倒放）', clipSpeed({ speed: -2 }) === 1)
check('speed 为 NaN 视为原速', clipSpeed({ speed: NaN }) === 1)
check('speed 超上限夹到 4', clipSpeed({ speed: 99 }) === 4)
check('speed 低于下限夹到 0.25', clipSpeed({ speed: 0.01 }) === 0.25)
check('sourceSpan = 时间线占位 × 倍速', near(sourceSpan({ duration: 3, speed: 2 }), 6))

const fast = { start: 10, duration: 3, offset: 4, sourceDuration: 30, speed: 2 }
check('2 倍速：片段内第 1 秒取源里第 2 秒', near(sourceTimeAt(fast, 11), 6), String(sourceTimeAt(fast, 11)))
check('2 倍速：片段走完吃掉源 6 秒', near(sourceTimeAt(fast, 13), 10), String(sourceTimeAt(fast, 13)))
check('越界仍夹在片段端（2 倍速下按源跨度夹）', near(sourceTimeAt(fast, 40), 10))
check('原速行为不变（回归）', near(sourceTimeAt({ start: 0, duration: 4, offset: 1 }, 2), 3))

/** 2 倍速片段：源里从 offset=4 起还剩 26 秒 ⇒ 时间线上最多还能占 13 秒 */
const fastEnd = trimPatch(fast, 'end', 99)
check(
  '右端上限按倍速折算（源剩 26 秒 ⇒ 时间线最多 13 秒）',
  fastEnd && near(fastEnd.duration, 13),
  JSON.stringify(fastEnd)
)
/** 左端往左拖 1 秒（时间线）⇒ 源入点要退 2 秒 */
const fastStart = trimPatch(fast, 'start', 9)
check(
  '左端按倍速折算（退 1 秒时间线 = 退 2 秒源）',
  fastStart && near(fastStart.offset, 2) && near(fastStart.duration, 4),
  JSON.stringify(fastStart)
)
check(
  '左端不能退到源入点之前（2 倍速下最早退到 start - offset/speed）',
  near(trimPatch(fast, 'start', 0).start, 8),
  JSON.stringify(trimPatch(fast, 'start', 0))
)

const to2x = speedPatch({ start: 0, duration: 6, offset: 0, sourceDuration: 30 }, 2)
check('提速到 2x：时间线占位减半', to2x && near(to2x.duration, 3) && near(to2x.speed, 2), JSON.stringify(to2x))
check('提速后源跨度守恒（还是吃掉 6 秒源）', to2x && near(to2x.duration * to2x.speed, 6))
const toHalf = speedPatch({ start: 0, duration: 6, offset: 0, sourceDuration: 30 }, 0.5)
check('降速到 0.5x：时间线占位加倍', toHalf && near(toHalf.duration, 12), JSON.stringify(toHalf))
check('换速不跳画面：起点对应的源时间不变', to2x && near(sourceTimeAt({ start: 0, duration: to2x.duration, offset: 0, speed: 2 }, 0), 0))
check('倍速不变时返回 null（不写状态）', speedPatch({ duration: 6, speed: 2 }, 2) === null)
check('倍速越界被夹住后再换算', speedPatch({ duration: 6, sourceDuration: 30 }, 99).speed === 4)
check(
  '源不够时按剩余量收敛（不破坏 offset + duration*speed <= sourceDuration）',
  (() => {
    const p = speedPatch({ start: 0, duration: 10, offset: 0, sourceDuration: 20 }, 0.5)
    return p && p.duration * p.speed <= 20 + 1e-6 && near(p.duration, 20)
  })(),
  JSON.stringify(speedPatch({ start: 0, duration: 10, offset: 0, sourceDuration: 20 }, 0.5))
)
check('时长为 0 的片段换速返回 null', speedPatch({ duration: 0 }, 2) === null)

/* ---------------------------- 剪辑联动（linkMovePatches） ---------------------------- */

const LINK_CLIPS = [
  { id: 'v1', assetId: 'A', start: 4, duration: 6 },
  { id: 'a1', assetId: 'A', start: 4, duration: 6 },
  { id: 't1', assetId: '', start: 2, duration: 3 },
  { id: 'v2', assetId: 'B', start: 20, duration: 5 }
]

const move = trim.linkMovePatches(LINK_CLIPS, 'v1', 10, true)
check(
  '联动：拖视频到 10 秒，同源的声音一起走到 10 秒',
  move.length === 2 && move.find((x) => x.id === 'a1')?.start === 10,
  JSON.stringify(move)
)
check(
  '联动：字幕（无 assetId）与别的素材不跟着动',
  move.every((x) => x.id === 'v1' || x.id === 'a1'),
  JSON.stringify(move.map((x) => x.id))
)
check(
  '联动关掉：只动被拖的那一条',
  (() => {
    const one = trim.linkMovePatches(LINK_CLIPS, 'v1', 10, false)
    return one.length === 1 && one[0].id === 'v1' && one[0].start === 10
  })(),
  JSON.stringify(trim.linkMovePatches(LINK_CLIPS, 'v1', 10, false))
)
check(
  '往左拖过头：整组被一起夹到 0（声音不会留在原地导致音画错位）',
  (() => {
    const left = trim.linkMovePatches(LINK_CLIPS, 'v1', -5, true)
    const v = left.find((x) => x.id === 'v1')
    const a = left.find((x) => x.id === 'a1')
    return v && a && v.start === 0 && a.start === 0
  })(),
  JSON.stringify(trim.linkMovePatches(LINK_CLIPS, 'v1', -5, true))
)
check(
  '平移到任意位置：整组内部间距守恒（不会一边动一边不动）',
  (() => {
    const shifted = trim.linkMovePatches(LINK_CLIPS, 'v1', 7.5, true)
    const v = shifted.find((x) => x.id === 'v1').start
    const a = shifted.find((x) => x.id === 'a1').start
    return near(v - a, 0) && near(v, 7.5)
  })()
)
check('目标片段不存在时返回空数组（不抛错）', trim.linkMovePatches(LINK_CLIPS, '不存在', 3, true).length === 0)

/* ------------------------------------------- J. 组合成员并入同一段钳位算术 */

/**
 * 组合（Alt+G）与联动（同源音画）是两种绑定来源，但"拖一条带走一组"必须是**同一段**
 * 钳位算术。分开写必然会在"往左拖到 0"那一刻算出两个不同的位移，表现是组员静默错位。
 * 这一组钉的就是"两路来源并进同一个参与集合，只钳一次"。
 */
const GRP_CLIPS = [
  { id: 'g1', assetId: 'A', start: 5, duration: 2, group: 'G' },
  { id: 'g2', assetId: 'B', start: 6, duration: 2, group: 'G' },
  { id: 'x1', assetId: 'C', start: 9, duration: 2 }
]

const grp = trim.linkMovePatches(GRP_CLIPS, 'g1', 8, true, ['g2'])
check(
  '组合：拖组员向右 3 秒，另一个组员同步 +3',
  grp.length === 2 && grp.find((x) => x.id === 'g2')?.start === 9,
  JSON.stringify(grp)
)
check(
  '组合：组内间距守恒（g1 与 g2 的相对位置不变）',
  (() => {
    const a = grp.find((x) => x.id === 'g1')
    const b = grp.find((x) => x.id === 'g2')
    return near(b.start - a.start, 1)
  })(),
  JSON.stringify(grp)
)

const grpLeft = trim.linkMovePatches(GRP_CLIPS, 'g1', -10, true, ['g2'])
check(
  '组合：往左拖爆时整组被夹住，最早那一段落到 0（不是只夹被拖的）',
  grpLeft.find((x) => x.id === 'g1')?.start === 0 &&
    grpLeft.find((x) => x.id === 'g2')?.start === 1,
  JSON.stringify(grpLeft)
)

const grpUnlinked = trim.linkMovePatches(GRP_CLIPS, 'g1', 7, false, ['g2'])
check(
  '组合不受联动开关影响（Ctrl+L 只管同源音画，不该把组合一起拆掉）',
  grpUnlinked.length === 2 && grpUnlinked.find((x) => x.id === 'g2')?.start === 8,
  JSON.stringify(grpUnlinked)
)

const grpPlain = trim.linkMovePatches(GRP_CLIPS, 'x1', 12, true)
check(
  '不在组合里也没有同源伙伴时，只动自己（extraIds 为空不能凭空带人）',
  grpPlain.length === 1 && grpPlain[0].id === 'x1' && grpPlain[0].start === 12,
  JSON.stringify(grpPlain)
)

check(
  'extraIds 里出现被拖片段自己时不会重复返回',
  trim.linkMovePatches(GRP_CLIPS, 'g1', 6, true, ['g1', 'g2']).length === 2,
  JSON.stringify(trim.linkMovePatches(GRP_CLIPS, 'g1', 6, true, ['g1', 'g2']))
)

/* -------------------------------------------------- K. 批量分割（cutAllAt） */

const CUT_CLIPS = [
  { id: 'c1', track: 'video', start: 0, duration: 10, offset: 0 },
  { id: 'c2', track: 'audio', start: 5, duration: 10, offset: 2 },
  { id: 'c3', track: 'video', start: 10, duration: 4, offset: 0 },
  { id: 'c4', track: 'overlay', start: 0, duration: 20, offset: 0 }
]
let cutSeq = 0
const makeCutId = () => `cut_${(cutSeq += 1)}`
const cut = trim.cutAllAt(CUT_CLIPS, 6, { lockedTracks: [], nextId: makeCutId })
check(
  '批量分割：跨过播放头的 3 段被切开（起点 10 的那段不切）',
  cut.cuts.length === 3,
  JSON.stringify(cut.cuts)
)
check(
  '批量分割：片段总数 4 → 7（每切一段 +1）',
  cut.clips.length === 7,
  String(cut.clips.length)
)
check(
  '批量分割：左半段结束点 = 播放头',
  (() => {
    const left = cut.clips.find((x) => x.id === 'c1')
    return near(left.start, 0) && near(left.duration, 6)
  })(),
  JSON.stringify(cut.clips.find((x) => x.id === 'c1'))
)
check(
  '批量分割：右半段起点 = 播放头，且入点按时间线差值累加',
  (() => {
    const right = cut.clips.find((x) => x.id === cut.cuts.find((c) => c.id === 'c2').rightId)
    return near(right.start, 6) && near(right.offset, 3)
  })(),
  JSON.stringify(cut.clips.find((x) => x.id === cut.cuts.find((c) => c.id === 'c2').rightId))
)
check(
  '批量分割：右半段入点必须乘倍速（2 倍速切 1 秒，源里要走 2 秒）',
  (() => {
    const once = trim.cutAllAt(
      [{ id: 's1', track: 'video', start: 0, duration: 6, offset: 0, speed: 2 }],
      1.5,
      { nextId: makeCutId }
    )
    const right = once.clips.find((x) => x.id === once.cuts[0].rightId)
    return near(right.offset, 3, 1e-6)
  })()
)
check(
  '批量分割：总时长不变（切一刀不增减内容）',
  (() => {
    const span = (list) => list.reduce((max, x) => Math.max(max, x.start + x.duration), 0)
    return near(span(cut.clips), span(CUT_CLIPS))
  })()
)
check(
  '批量分割：锁定轨上的片段被跳过且计数',
  (() => {
    const locked = trim.cutAllAt(CUT_CLIPS, 6, { lockedTracks: ['audio'], nextId: makeCutId })
    return locked.cuts.length === 2 && locked.skipped.locked === 1
  })()
)
check(
  '批量分割：复合片段被跳过（切开会让两半各带一份同一批子片段）',
  (() => {
    /* 夹具必须是**真实形状**：makeCompound 产出的片段带 `kind: 'compound'`，
       判定走 shared/compound.js 的 isCompound。早先这条夹具只写了 `compound.children`
       而漏了 kind，恰好让"自己臆造一个更松的条件"也能通过 —— 收紧判据时它才红。 */
    const comp = trim.cutAllAt(
      [{ id: 'p1', track: 'video', start: 0, duration: 8, kind: 'compound', compound: { children: [{ id: 'a' }] } }],
      4,
      { nextId: makeCutId }
    )
    return comp.cuts.length === 0 && comp.skipped.compound === 1
  })()
)
check(
  '批量分割：两侧不足最短时长时跳过（不切出抓不回来的碎段）',
  (() => {
    const thin = trim.cutAllAt([{ id: 't1', track: 'video', start: 0, duration: 1, offset: 0 }], 0.1, {
      nextId: makeCutId
    })
    return thin.cuts.length === 0 && thin.skipped.tooShort === 1
  })()
)
check(
  '批量分割：播放头正好落在片段边界上时不切（0 秒的碎片没有意义）',
  trim.cutAllAt(CUT_CLIPS, 10, { nextId: makeCutId }).cuts.every((c) => c.id !== 'c3')
)
check('批量分割：播放头非数字时原样返回、不抛', trim.cutAllAt(CUT_CLIPS, NaN, { nextId: makeCutId }).clips.length === 4)
check(
  '批量分割：缺 nextId 直接抛（不许静默返回空结果）',
  (() => {
    try {
      trim.cutAllAt(CUT_CLIPS, 6, {})
      return false
    } catch (error) {
      return error instanceof TypeError
    }
  })()
)
check(
  '批量分割：每次切出来的 id 互不相同',
  new Set(cut.cuts.map((c) => c.rightId)).size === cut.cuts.length
)

/* ------------------------------------------------------------------ 汇总 */

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`TRIM_SELFTEST_STATS total=${results.length} pass=${passed} fail=${failed}`)
/**
 * 用 `exitCode` 自然退出，不用 `process.exit()`：
 * 后者在 stdout 被重定向到管道/文件时存在"结论行还没刷出去就退出"的风险，
 * 而 `TRIM_SELFTEST_STATS` 正是 verify 数断言的唯一依据。本脚本无待收尾句柄。
 */
if (failed) {
  console.log('TRIM_SELFTEST_FAILED')
  process.exitCode = 1
} else {
  console.log('TRIM_SELFTEST_PASSED')
  process.exitCode = 0
}
