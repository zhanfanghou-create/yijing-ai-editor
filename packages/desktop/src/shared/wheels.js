'use strict'
/**
 * 一级色轮（阴影 / 中间调 / 高光 / 全局）—— 真源唯一。
 *
 * 模型：经典三段式 lift / gamma / gain，逐通道各算一条**一维曲线**。
 *   阴影轮 → lift（加性偏移）：抬黑位，被 255 钳住后自然只影响暗部；
 *   中间调轮 → gamma（幂）：暗部与亮部两端不动，中间抬得最多；
 *   高光轮 → gain（乘性）：黑位乘完几乎不动，越亮影响越大。
 *   全局轮 → 额外的加性染色：整幅画面均匀偏色（黑位也会动）。
 *   每轮的「亮度」滑杆走同一个阶段（阴影→lift、中间调→gamma、高光→gain、全局→加性），
 *   这样手柄与滑杆永远作用在同一处，不会出现"拖动了却没反应"。
 *
 * 为什么两侧能真的对上：
 *   每一通道的最终效果就是 `out = f(in)` 这样一条 0..255 的一维映射。
 *   预览把它写成 SVG `feComponentTransfer type="table"` 的 256 项表，
 *   导出把它写成 ffmpeg `lutrgb=r='expr'` —— `lutrgb` 本身就是"对 0..255 逐值求
 *   一次表达式"，与查表是同一件事。只要表达式里用的常数与我们算表时一致，
 *   两侧的差别只剩浮点舍入（自测拿真 ffmpeg 跑渐变逐值对过，容差 2）。
 *
 * 为什么不用 `colorbalance`：它有 shadows/midtones/highlights 三组 RGB，看着正好，
 *   但内部的权重函数是它自己的实现细节（含 8bit 定点与逐档查表），要在预览侧
 *   **一模一样**地复现得读它的 C 源码，而且换 ffmpeg 版本就可能变。`lutrgb` 的
 *   语义是"你给公式，我逐值算"，没有隐藏行为 —— 这类映射才守得住。
 */

/** 四个轮，顺序即 UI 顺序 */
const WHEEL_RANGES = [
  { key: 'shadow', label: '阴影' },
  { key: 'mid', label: '中间调' },
  { key: 'high', label: '高光' },
  { key: 'global', label: '全局' }
]

/** 手柄推到最外圈时的最大作用量（1.0 = 满量程）。数值小、但都在肉眼可辨的范围。 */
const SCALES = {
  lift: 0.18,
  gamma: 0.45,
  gain: 0.45,
  tint: 0.3,
  levelLift: 0.25,
  levelGamma: 0.5,
  levelGain: 0.5,
  levelTint: 0.3
}

/** 查找表长度：与 8bit 通道一一对应，SVG 与 ffmpeg 都是这个粒度 */
const LUT_SIZE = 256

const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
/**
 * 读一个数，缺省给 0。
 * ⚠️ 别写成 `clamp(Number(raw), -1, 1)`：`Number(undefined)` 是 NaN，
 *    而 clamp 对 NaN 只能返回**下界** —— 于是"没填"变成了"手柄在 (-1,-1)"，
 *    整个默认状态就是满量程偏色。这一坑在自测第一条就炸出来了（缺省读取全非中性）。
 */
const num = (v, def = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}
const round6 = (v) => Math.round(v * 1e6) / 1e6

/** 一个轮子的中性形态：手柄在圆心、亮度 0 */
const NEUTRAL_WHEEL = { x: 0, y: 0, level: 0 }

/**
 * 规范化一个轮子。
 * - 手柄位置钳进单位圆：圆外的位置没有意义（色相还是那个色相，只是强度会溢出），
 *   不钳的话推到角上会得到 1.41 倍强度，两个方向的"满量程"就不一样重了。
 * - 亮度钳在 -100..100。
 */
function readWheel(src) {
  const obj = src && typeof src === 'object' ? src : {}
  let x = num(obj.x)
  let y = num(obj.y)
  /* 先归一再去钳：先按轴钳到 ±1 会丢掉方向（(3,4) 会变成 (0.707,0.707)，
     而它本来指向 53°，应该是 (0.6,0.8)） */
  const len = Math.hypot(x, y)
  if (len > 1) {
    x /= len
    y /= len
  }
  return { x, y, level: clamp(num(obj.level), -100, 100) }
}

/** 四个轮整体规范化；缺的给中性 */
function readWheels(src) {
  const out = {}
  for (const range of WHEEL_RANGES) out[range.key] = readWheel(src && src[range.key])
  return out
}

/** 是否完全中性。中性时两侧都**不挂**任何滤镜（多一次 8bit 往返就会掉色阶） */
function isNeutral(wheels) {
  const list = wheels || {}
  return WHEEL_RANGES.every((range) => {
    const w = readWheel(list[range.key])
    return Math.hypot(w.x, w.y) < 1e-3 && Math.abs(w.level) < 0.5
  })
}

/* --------------------------------- 颜色 --------------------------------- */

/** 色相（度，0=红 120=绿 240=蓝）。手柄方向 → 色相 */
function hueOf(x, y) {
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  return (deg + 360) % 360
}

/** HSV(h, 1, 1) → RGB(0..1)，纯色相的满饱和形态 */
function hueToRgb(hue) {
  const h = ((hue % 360) + 360) % 360
  const c = 1
  const x = 1 - Math.abs(((h / 60) % 2) - 1)
  if (h < 60) return { r: c, g: x, b: 0 }
  if (h < 120) return { r: x, g: c, b: 0 }
  if (h < 180) return { r: 0, g: c, b: x }
  if (h < 240) return { r: 0, g: x, b: c }
  if (h < 300) return { r: x, g: 0, b: c }
  return { r: c, g: 0, b: x }
}

/**
 * 手柄位置 → RGB 三分量的**带符号**作用量，各自落在 -1..1。
 * 中心是 (0,0,0)（不动画面），外圈是某个色相的纯色（该分量 +1、其余 -1）。
 * 半径就是强度：0.5 半径 = 半量程。
 */
function vectorOf(wheel) {
  const w = readWheel(wheel)
  const radius = Math.min(1, Math.hypot(w.x, w.y))
  if (radius < 1e-9) return { r: 0, g: 0, b: 0 }
  const pure = hueToRgb(hueOf(w.x, w.y))
  /* (纯色 - 0.5) 的最大绝对值恒为 0.5，除回去让"半径 = 强度"在任意色相下都成立 */
  const scale = radius / 0.5
  return {
    r: (pure.r - 0.5) * scale,
    g: (pure.g - 0.5) * scale,
    b: (pure.b - 0.5) * scale
  }
}

/**
 * 四个轮 → 逐通道三段参数 `{ r: {gamma, gain, offset}, … }`。
 * `offset` 已经把 lift 与全局染色合并（两者都是加性，数学上没必要分两步）。
 */
function stagesOf(wheels) {
  const w = readWheels(wheels)
  const shadow = vectorOf(w.shadow)
  const mid = vectorOf(w.mid)
  const high = vectorOf(w.high)
  const glob = vectorOf(w.global)
  const out = {}
  for (const ch of ['r', 'g', 'b']) {
    const lift = shadow[ch] * SCALES.lift + (w.shadow.level / 100) * SCALES.levelLift
    const tint = glob[ch] * SCALES.tint + (w.global.level / 100) * SCALES.levelTint
    out[ch] = {
      /* gamma < 1 表示「用更小的指数」= 变暗；推绿/推红都按同一套算 */
      gamma: clamp(1 + mid[ch] * SCALES.gamma + (w.mid.level / 100) * SCALES.levelGamma, 0.2, 5),
      gain: clamp(1 + high[ch] * SCALES.gain + (w.high.level / 100) * SCALES.levelGain, 0.1, 4),
      offset: lift + tint
    }
  }
  return out
}

/** 一条通道的映射：`in` 0..1 → 0..1 */
function transfer(stage, input) {
  const x = clamp01(input)
  return clamp01(Math.pow(x, 1 / stage.gamma) * stage.gain + stage.offset)
}

/** 一条通道 → 256 项查找表（0..1） */
function lutOf(wheels, channel) {
  const stage = stagesOf(wheels)[channel] || stagesOf(wheels).r
  const out = new Array(LUT_SIZE)
  for (let i = 0; i < LUT_SIZE; i += 1) out[i] = transfer(stage, i / (LUT_SIZE - 1))
  return out
}

/** 三路查找表一起给（预览与断言的共同口径） */
function lutsOf(wheels) {
  return { r: lutOf(wheels, 'r'), g: lutOf(wheels, 'g'), b: lutOf(wheels, 'b') }
}

/** 预览用：`feComponentTransfer` 的 tableValues（逗号分隔，6 位小数） */
function tableValuesOf(wheels) {
  const luts = lutsOf(wheels)
  const toStr = (lut) => lut.map((v) => round6(v)).join(' ')
  return { r: toStr(luts.r), g: toStr(luts.g), b: toStr(luts.b) }
}

/**
 * 导出用：ffmpeg `lutrgb` 的逐通道表达式。
 *
 * 表达式与 `transfer()` 逐字同源：`clip(val/255,0,1)` 归一 → 幂 → 乘 → 加 → 乘回 255。
 * 中性时返回 ''（调用方据此决定要不要往链上加滤镜）。
 *
 * ⚠️ `val` 对 `lutrgb` 是 0..255 的整数，这一点不能想当然：`lut`/`lutyuv` 的 `val`
 *    是 YUV 空间的值，混用会得到"整幅画发绿"这种看不出原因的偏色。
 */
function ffmpegWheels(wheels) {
  if (isNeutral(wheels)) return ''
  const stages = stagesOf(wheels)
  const exprOf = (stage) =>
    `clip((pow(clip(val/255,0,1),${round6(1 / stage.gamma)})*${round6(stage.gain)}+${round6(stage.offset)})*255,0,255)`
  return `lutrgb=r='${exprOf(stages.r)}':g='${exprOf(stages.g)}':b='${exprOf(stages.b)}'`
}

/**
 * 预置：参考客户端里那几组常用色轮。
 * 存的是**偏移量**（不是绝对值），套用时叠加到当前值上；这样"套预置"与"手动推"
 * 走同一条路径，不会出现两套换算。
 */
const WHEEL_PRESETS = [
  { key: 'none', label: '归零', delta: {} },
  { key: 'warm', label: '暖调', delta: { shadow: { x: 0.25, y: 0.35 }, high: { x: 0.45, y: 0.2 } } },
  { key: 'cool', label: '冷调', delta: { shadow: { x: -0.3, y: -0.35 }, high: { x: -0.4, y: -0.25 } } },
  { key: 'film', label: '胶片', delta: { shadow: { x: -0.2, y: 0.45 }, high: { x: 0.3, y: -0.25 } } },
  { key: 'clean', label: '清透', delta: { mid: { x: 0, y: 0.25 }, global: { x: 0, y: 0.12 } } }
]

/** 套用一个预置：把 delta 叠加到当前手柄上（结果仍被钳进单位圆） */
function applyPreset(wheels, presetKey) {
  const preset = WHEEL_PRESETS.find((item) => item.key === presetKey) || WHEEL_PRESETS[0]
  const base = readWheels(wheels)
  if (preset.key === 'none') return readWheels({})
  for (const range of WHEEL_RANGES) {
    const delta = preset.delta[range.key]
    if (!delta) continue
    base[range.key] = readWheel({
      x: base[range.key].x + (delta.x || 0),
      y: base[range.key].y + (delta.y || 0),
      level: base[range.key].level + (delta.level || 0)
    })
  }
  return base
}

/**
 * 色环的 conic 渐变停止点。
 *
 * 手柄画在 `left = 50% + x*50%`、`top = 50% - y*50%`（屏幕 y 向下，所以取负）。
 * 该点在 CSS 里对应的**顺时针、从 12 点起算**的角度是 `φ = atan2(x, y)`；
 * 而我们的色相是 `h = atan2(y, x)`，两者满足 `φ = 90° - h`。
 * conic-gradient 的第 t 度位置上就是 `φ = t` 那个方向的颜色，所以
 * 「色相 h 的停止点」要放在 `t = 90 - h`（模 360）处。
 *
 * 这一步错了不会崩：色环照画、手柄照拖，只是把蓝拖到"蓝色"那块却得到橙色，
 * 属于必须靠推导而不能靠试的换算。
 */
function hueStops(step = 30) {
  const stops = []
  for (let h = 0; h < 360; h += step) stops.push({ h, t: ((90 - h) % 360 + 360) % 360 })
  stops.sort((a, b) => a.t - b.t)
  return stops
}

module.exports = {
  WHEEL_RANGES,
  SCALES,
  LUT_SIZE,
  NEUTRAL_WHEEL,
  WHEEL_PRESETS,
  readWheel,
  readWheels,
  isNeutral,
  hueOf,
  hueToRgb,
  vectorOf,
  stagesOf,
  transfer,
  lutOf,
  lutsOf,
  tableValuesOf,
  ffmpegWheels,
  applyPreset,
  hueStops
}
