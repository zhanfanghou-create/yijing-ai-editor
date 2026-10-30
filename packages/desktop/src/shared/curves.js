'use strict'
/**
 * 曲线（RGB 三通道）—— 真源唯一。
 *
 * 为什么两边必须共用这一份：
 *   曲线是**逐像素重映射**，预览与导出各算一套的话，症状不是报错，而是
 *   「预览里拉成 S 形很好看，成片还是灰的」—— 构建绿、界面绿、看不出来。
 *   所以控制点 → 查找表这件事只写一次：预览拿 `tableValues()` 去喂 SVG 的
 *   `feComponentTransfer`，导出把同一组控制点交给 ffmpeg 的 `curves` 滤镜。
 *
 * 插值必须与 ffmpeg 同一种（自然三次样条，两端二阶导为 0）：
 *   ffmpeg 的 `curves` 就是自然样条 + 采样 256 点。用单调样条（Fritsch–Carlson）
 *   看起来更"安全"（不会过冲），但两侧会得到**不同的形状** —— 预览里平滑的过渡，
 *   成片里会被拉出一点点过冲，暗部尤其明显。宁可两边一样地过冲，也不要两边不一样。
 *
 * ffmpeg 的施加顺序（vf_curves.c）：先 master，再 r/g/b。所以「RGB」通道曲线对
 *   某一路的最终效果是 `ch(master(x))`，预览侧必须按同一顺序**复合**，否则
 *   「RGB 曲线 + R 曲线」同时用时两侧不一样。
 */

/** 四条曲线，顺序即 UI 里的通道页签顺序 */
const CURVE_CHANNELS = [
  { key: 'rgb', label: 'RGB', color: '#e6e8ec' },
  { key: 'r', label: '红', color: '#ff6b6b' },
  { key: 'g', label: '绿', color: '#51cf66' },
  { key: 'b', label: '蓝', color: '#4dabf7' }
]

/** 一条曲线的中性形态：左下到右上的直线 */
const NEUTRAL_POINTS = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]

/** 控制点个数上限。存下来是为了让导出侧的 ffmpeg 串长度可控（ffmpeg 自身也只收 16 个） */
const MAX_POINTS = 16
/** 查找表长度。256 与 8bit 通道一一对应，SVG 与 ffmpeg 都是这个粒度 */
const LUT_SIZE = 256

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const round4 = (v) => Math.round(v * 10000) / 10000

/**
 * 规范化一组控制点。
 * - 端点**钉死**在 x=0 / x=1：允许端点自由上下滑动（这是做「压黑」「提白」的手法），
 *   但不允许左右移动 —— 否则曲线盖不满 0..1，找不到映射的那一段只能瞎猜。
 * - x 必须严格递增：重复 x 会让样条的三对角方程奇异（除零 → NaN 整张表）。
 * - 至少两个点、至多 MAX_POINTS 个。
 */
function readPoints(src) {
  if (!Array.isArray(src)) return NEUTRAL_POINTS.map((p) => ({ ...p }))
  const list = []
  for (const raw of src) {
    if (!raw || typeof raw !== 'object') continue
    const x = Number(raw.x)
    const y = Number(raw.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    list.push({ x: clamp01(x), y: clamp01(y) })
  }
  if (list.length < 2) return NEUTRAL_POINTS.map((p) => ({ ...p }))
  list.sort((a, b) => a.x - b.x)
  /* 去掉 x 重合的（保留后出现的那个），再钉端点 */
  const dedup = []
  for (const point of list) {
    if (dedup.length && Math.abs(point.x - dedup[dedup.length - 1].x) < 1e-6) dedup[dedup.length - 1] = point
    else dedup.push(point)
  }
  if (dedup.length < 2) return NEUTRAL_POINTS.map((p) => ({ ...p }))
  const capped = dedup.slice(0, MAX_POINTS)
  capped[0] = { x: 0, y: capped[0].y }
  capped[capped.length - 1] = { x: 1, y: capped[capped.length - 1].y }
  return capped
}

/** 四通道整体规范化；缺的通道给中性 */
function readCurves(src) {
  const out = {}
  for (const channel of CURVE_CHANNELS) {
    out[channel.key] = readPoints(src && src[channel.key])
  }
  return out
}

const samePoints = (a, b) => a.length === b.length && a.every((point, i) => Math.abs(point.x - b[i].x) < 1e-6 && Math.abs(point.y - b[i].y) < 1e-6)

/** 是否完全中性（四条都是直线）。中性时两侧都**不要**挂任何滤镜 ——
 *  挂一条恒等曲线会让画面多走一次 8bit 往返，暗部会出现本不该有的色阶断带。 */
function isNeutral(curves) {
  const list = curves || {}
  return CURVE_CHANNELS.every((channel) => samePoints(readPoints(list[channel.key]), NEUTRAL_POINTS))
}

/**
 * 自然三次样条：解三对角方程求各点二阶导，再按段求值。
 * 与 ffmpeg `curves` 用的是同一种插值（两端二阶导为 0）。
 */
function splineAt(points, x) {
  const n = points.length
  if (n === 1) return points[0].y
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n - 1]) return ys[n - 1]

  /* 段长 h，右端项按 y 的二阶差商 */
  const h = new Array(n - 1)
  for (let i = 0; i < n - 1; i += 1) h[i] = xs[i + 1] - xs[i]
  const alpha = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i += 1) {
    alpha[i] = (3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1])
  }
  /* Thomas 算法解三对角（l/mu/z 就地滚动，省两个数组） */
  const l = new Array(n).fill(1)
  const mu = new Array(n).fill(0)
  const z = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i += 1) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1]
    mu[i] = h[i] / l[i]
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i]
  }
  const c = new Array(n).fill(0)
  const b = new Array(n).fill(0)
  const d = new Array(n).fill(0)
  for (let j = n - 2; j >= 0; j -= 1) {
    c[j] = z[j] - mu[j] * c[j + 1]
    b[j] = (ys[j + 1] - ys[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3
    d[j] = (c[j + 1] - c[j]) / (3 * h[j])
  }
  /* 定位所在段（控制点很少，线性找够了） */
  let seg = 0
  for (let i = 0; i < n - 1; i += 1) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      seg = i
      break
    }
  }
  const dx = x - xs[seg]
  return ys[seg] + b[seg] * dx + c[seg] * dx * dx + d[seg] * dx * dx * dx
}

/**
 * 一条曲线 → 256 项查找表（值域 0..1）。
 * 末尾两项强制钳到 0/1：样条在端点附近可能轻微过冲（-0.002 / 1.003），
 * 不过钳的话 SVG 的 tableValues 会拿到负值（浏览器钳掉，但 ffmpeg 会直接报错）。
 */
function lutOf(points) {
  const list = readPoints(points)
  const out = new Array(LUT_SIZE)
  for (let i = 0; i < LUT_SIZE; i += 1) {
    out[i] = clamp01(splineAt(list, i / (LUT_SIZE - 1)))
  }
  out[0] = clamp01(splineAt(list, 0))
  out[LUT_SIZE - 1] = clamp01(splineAt(list, 1))
  return out
}

/** 按表取值（线性插值，用于把 master 的结果喂进通道曲线） */
function applyLut(lut, value) {
  const v = clamp01(value)
  const pos = v * (LUT_SIZE - 1)
  const i = Math.min(LUT_SIZE - 1, Math.floor(pos))
  const j = Math.min(LUT_SIZE - 1, i + 1)
  const t = pos - i
  return lut[i] + (lut[j] - lut[i]) * t
}

/**
 * 某一路通道的**最终**查找表：先过 RGB（master），再过该通道自己的曲线。
 * 顺序与 ffmpeg 一致（master 在前）；反过来的话「提亮 + 压红」与「压红 + 提亮」
 * 会得到不同的表，而人眼分辨不出是顺序错了，只会觉得"两边颜色有点不一样"。
 */
function channelLut(curves, channelKey) {
  const src = curves || {}
  const master = lutOf(src.rgb)
  if (channelKey === 'rgb') return master
  const own = lutOf(src[channelKey])
  const out = new Array(LUT_SIZE)
  for (let i = 0; i < LUT_SIZE; i += 1) out[i] = clamp01(applyLut(own, master[i]))
  return out
}

/** 预览用：`feComponentTransfer` 的 tableValues（逗号分隔，4 位小数） */
function tableValues(points) {
  return lutOf(points)
    .map((v) => round4(v))
    .join(' ')
}

/**
 * 预览用：三路 tableValues（**已经复合了 RGB 曲线**）。
 *
 * ⚠️ 这里必须是 `channelLut`，不能直接用 `tableValues(curves.r)` 这种"单通道原表"：
 *    只调 RGB 时单通道曲线是恒等的，三路原表就是恒等表 —— 定义挂上去了、画面
 *    一点没变（2026-10-28 真机踩到：表里中点读到 0.502，正好是恒等表的 128/255）。
 *    而 `isNeutral` 看的是 rgb 通道非中性，于是"有定义、恒等表"这种最隐蔽的状态出现了。
 */
function tableValuesOf(curves) {
  const toStr = (lut) => lut.map((v) => round4(v)).join(' ')
  return {
    r: toStr(channelLut(curves, 'r')),
    g: toStr(channelLut(curves, 'g')),
    b: toStr(channelLut(curves, 'b')),
    /* master 单独也给一份：只调 RGB 时它就是三路共同的那张表，便于断言与排障 */
    master: tableValues(curves && curves.rgb)
  }
}

/**
 * 导出用：ffmpeg `curves` 滤镜串。
 * 中性通道**不写**：ffmpeg 收到 `r='0/0 1/1'` 也是恒等，但多一个滤镜就多一次
 * 8bit 往返（成片暗部会多一层色阶断带），而且日志更难读。
 * 返回 '' 表示整条曲线是中性 —— 调用方据此决定要不要往链上加滤镜。
 */
function ffmpegCurves(curves) {
  const src = curves || {}
  const parts = []
  for (const channel of CURVE_CHANNELS) {
    const points = readPoints(src[channel.key])
    if (samePoints(points, NEUTRAL_POINTS)) continue
    const expr = points.map((p) => `${round4(p.x)}/${round4(p.y)}`).join(' ')
    parts.push(`${channel.key === 'rgb' ? 'master' : channel.key}='${expr}'`)
  }
  return parts.length ? parts.join(':') : ''
}

/** 随机/拖拽时用：把控制点按 x 排序并钉端点（UI 拖完直接调这个再存） */
function movePoint(points, index, x, y) {
  const list = readPoints(points).map((p) => ({ ...p }))
  if (index < 0 || index >= list.length) return list
  const isFirst = index === 0
  const isLast = index === list.length - 1
  /* 端点只能上下动 */
  const nx = isFirst ? 0 : isLast ? 1 : clamp01(x)
  list[index] = { x: nx, y: clamp01(y) }
  /* 中间的点的 x 不许穿过邻居（穿过就不是函数了） */
  for (let i = 1; i < list.length - 1; i += 1) {
    const lo = list[i - 1].x + 0.005
    const hi = list[i + 1].x - 0.005
    if (list[i].x < lo) list[i].x = lo
    if (list[i].x > hi) list[i].x = hi
  }
  return list
}

module.exports = {
  CURVE_CHANNELS,
  NEUTRAL_POINTS,
  MAX_POINTS,
  LUT_SIZE,
  readPoints,
  readCurves,
  isNeutral,
  lutOf,
  channelLut,
  applyLut,
  splineAt,
  tableValues,
  tableValuesOf,
  ffmpegCurves,
  movePoint
}
