'use strict'
/**
 * 转场遮罩的**唯一定义处** —— 预览（CSS）、导出（ffmpeg）、缩略图（Pillow）三处同源。
 *
 * 背景：转场卡片 331 张 / 去重名字 204 个，而 ffmpeg 的 `xfade` 只自带 58 种。
 * 名字比效果多，就会出现"点了两张卡，成片一模一样"。本模块把每个转场统一描述成
 * 一个**空间场** `field(x, y) ∈ [0,1]`（该点"轮到后一段"的时刻）+ 软边宽度 soft：
 *
 *     m = clamp((phase(p) - field(x, y)) / soft + 0.5, 0, 1)
 *     成片像素 = A * (1 - m) + B * m
 *
 * 于是 204 个名字只需不同的 (kind, 参数) 就能真的互不相同，且：
 *   · ffmpeg 侧由 `geoToExpr()` 用**同一组数字**拼出 `xfade=transition=custom` 表达式；
 *   · 预览侧由 `geoToCss()` 用**同一个 field** 生成 mask / clip-path；
 *   · 缩略图由 `tools/export-transition-masks.mjs` 导出同一份 field 的矩阵。
 * 三处任一处的数字改了，另两处自动跟着改 —— 这是"预览一个样、成片另一个样"的根治办法。
 *
 * ⚠️ 两个必须记住的坑（都实测过，见 PITFALLS）：
 *   1. `xfade` 的 custom 表达式返回的是**像素值**，不是混合系数。写 `clip(P,0,1)` 会把
 *      整帧写成 RGB(0,136,0)（Y=U=V=0）；只有 `A*(1-m)+B*m` 才是混合。
 *   2. 表达式里的坐标必须用 **W / H**（当前平面的宽高），不是 SW / SH。
 *      ffmpeg 这版**没有** SW / SH 变量（写了会直接 "Undefined constant" 把整个滤镜
 *      配置打掉，成片是纯色帧而不是报错）。W / H 在每个平面里是该平面自己的尺寸，
 *      所以 YUV420 的色度平面上 `X/W` 一样会归一化到 0..1，遮罩与 luma 对齐。
 *
 * ⚠️ 坑 3（2026-11-03 实测）：`X / Y / W / H` 在**所有平面里都是帧坐标**。
 *   色度平面没有自己的坐标系 —— `if(gt(X,240),235,128)` 这个探针里，x=300 的
 *   色度也拿到了 235（成片是品红 RGB(255,126,255)），说明色度平面看到的 X
 *   一直走到帧宽。好消息是 `X/W` 因此在色度上也是 0..1，遮罩天然对齐；
 *   坏消息是**没有任何变量能区分平面**，于是"整帧压到某个中间色"不能写成常量 ——
 *   常量 235 会同时写进 Y/U/V，得到品红而不是白。
 *   所以闪黑/闪白这一族在接缝处走 **RGB 平面**（gbrp / gbra，见 xfadeArgs），
 *   RGB 三个平面同权，常量才真的是灰/白/黑。其余族照旧走 yuv420p。
 *
 * ⚠️ 坑 3b（同一轮实测，更要命）：**YUV 平面上 `P` 的进度是压扁的**。
 *   同一段 `255*P` 探针，2 秒 / 10fps 的转场在 gray / gbrp / rgb24 上是标准的
 *   20 帧走完，在 yuv420p / yuv444p 上 7 帧就走完了（≈3 倍速），之后一直停在 B。
 *   不报错、不告警，只是"转场一闪而过、后半段干等"。所以现在**所有** custom
 *   转场都在 RGB 平面上做（见 xfadeArgs），代价是每个接缝多一次格式往返。
 *
 * ⚠️ 坑 4（2026-11-03 实测）：**表达式里不要用 `st()/ld()`**。
 *   `st(0,m)+ld(0)` 这种"把 m 存起来复用"的写法看起来省字符，但这版 ffmpeg 里
 *   它不可靠：同一个表达式连跑三次会给出三组不同像素（开两个槽必坏；只开一个槽
 *   时，短表达式还好，一旦 st 的参数里带 `clip(...,0,1)` 这种转义逗号也会坏）。
 *   对照实验：把同一个式子**内联写三遍**，三次结果逐像素一致，且与单槽版相同。
 *   所以现在一律内联（`A*(1-(m))+B*(m)`），表达式长一点无所谓 —— 这个坑不报错，
 *   只让成片随机变脏，而且只在中段某一帧出现。
 *
 * 形制：CommonJS（主进程 require、渲染层 import，见 vite.config.mjs 的
 * commonjsOptions.include 白名单 —— 新增 shared 模块必须同时加进去）。
 */

const TAU = Math.PI * 2
const DEG = Math.PI / 180

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const frac = (v) => v - Math.floor(v)
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** 进度曲线：curve = 幂指数（>1 慢起快收，<1 快起慢收），缺省 1 线性 */
function phaseAt(geo, p) {
  const q = clamp01(num(p))
  const k = num(geo && geo.curve, 1)
  if (!(k > 0) || k === 1) return q
  return Math.pow(q, k)
}

/* ──────────────────────────── 空间场 ──────────────────────────── */

function fieldLin(g, x, y) {
  const a = num(g.angle) * DEG
  const c = Math.cos(a)
  const s = Math.sin(a)
  /* 2*range 是 (x,y) ∈ [0,1]² 上 (x-.5)c+(y-.5)s 的实际跨度，除以它才归一化到 0..1 */
  const range = (Math.abs(c) + Math.abs(s)) / 2 || 0.5
  return clamp01(((x - 0.5) * c + (y - 0.5) * s) / (2 * range) + 0.5)
}

function fieldRadial(g, x, y) {
  const cx = num(g.cx, 0.5)
  const cy = num(g.cy, 0.5)
  const rmax = Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)) || 0.5
  let t = Math.hypot(x - cx, y - cy) / rmax
  if (num(g.rings) > 0) t = frac(t * num(g.rings, 1))
  if (g.invert) t = 1 - t
  return clamp01(t)
}

function fieldAngular(g, x, y) {
  const cx = num(g.cx, 0.5)
  const cy = num(g.cy, 0.5)
  const arms = Math.max(1, Math.round(num(g.arms, 1)))
  const a = Math.atan2(y - cy, x - cx) / TAU + 0.5
  return frac(a * arms - num(g.offset, 0))
}

/** 距离场形状：manhattan 菱形 / chebyshev 方形 / euclid 圆形 */
function fieldShape(g, x, y) {
  const cx = num(g.cx, 0.5)
  const cy = num(g.cy, 0.5)
  const dx = Math.abs(x - cx)
  const dy = Math.abs(y - cy)
  const mx = Math.max(cx, 1 - cx)
  const my = Math.max(cy, 1 - cy)
  const metric = g.metric || 'manhattan'
  let d
  let dmax
  if (metric === 'chebyshev') {
    d = Math.max(dx, dy)
    dmax = Math.max(mx, my)
  } else if (metric === 'euclid') {
    d = Math.hypot(dx, dy)
    dmax = Math.hypot(mx, my)
  } else {
    d = dx + dy
    dmax = mx + my
  }
  let t = d / (dmax || 0.5)
  if (g.invert) t = 1 - t
  return clamp01(t)
}

function fieldGrid(g, x, y) {
  const nx = Math.max(1, Math.round(num(g.nx, 4)))
  const ny = Math.max(1, Math.round(num(g.ny, nx)))
  const ix = Math.min(nx - 1, Math.floor(x * nx))
  const iy = Math.min(ny - 1, Math.floor(y * ny))
  const order = num(g.order, 0)
  if (order === 1) return (iy + ix * ny + 0.5) / (nx * ny)
  if (order === 2) return ((ix + iy) % 2) * 0.5 + ((ix + iy * nx) / (nx * ny)) * 0.5
  if (order === 3) {
    const dmax = Math.hypot((nx - 1) / 2, (ny - 1) / 2) || 1
    return clamp01(Math.hypot(ix - (nx - 1) / 2, iy - (ny - 1) / 2) / dmax)
  }
  /* 4 = 乱序翻转：像素块随机跳（`像素屏幕故障` / `块故障` 用这个）。
     ⚠️ 必须与 `fieldExpr` 里 grid/order 4 同式，否则预览一个顺序、成片另一个顺序。
     ⚠️ 用黄金比例低差异序列而不是 `sin()` 哈希：`sin` 的末位差异被 ×43758 放大后
        两边会算出**不同的翻块顺序**；这里只有整数乘加与一次乘法，逐位一致。
     ⚠️ 乘子必须**大**（下面这三个质数）。用 `ix*7+iy*13` 这种小系数时，
        5×3 这种小网格会退化成"竖条"：每列只差 0.33、每行只差 0.03，
        一列之内同生同灭 —— 实测 `块故障` 出来是竖条纹，不是散块。
        乘上 7e7 级别之后，乘积的小数部分才是真正离散的。 */
  if (order === 4) {
    const n = ix * 73856093 + iy * 19349663 + num(g.seed, 1) * 83492791
    return frac(n * 0.6180339887498949)
  }
  return (ix + iy * nx + 0.5) / (nx * ny)
}

function fieldStripe(g, x, y) {
  const n = Math.max(2, Math.round(num(g.n, 8)))
  const u = num(g.axis) ? y : x
  const k = Math.min(n - 1, Math.floor(u * n))
  const phase = num(g.phase, 0)
  if (phase === 1) return k % 2 ? 0.55 : 0.05
  if (phase === 2) return frac(Math.sin(k * 12.9898 + num(g.seed, 1)) * 43758.5453)
  return (k + 0.5) / n
}

function fieldWave(g, x, y) {
  const a = num(g.angle) * DEG
  const c = Math.cos(a)
  const s = Math.sin(a)
  const range = (Math.abs(c) + Math.abs(s)) / 2 || 0.5
  const base = ((x - 0.5) * c + (y - 0.5) * s) / (2 * range) + 0.5
  const proj = -(x - 0.5) * s + (y - 0.5) * c
  return clamp01(base + num(g.amp, 0.08) * Math.sin(proj * num(g.freq, 4) * TAU))
}

function fieldNoise(g, x, y) {
  const sc = Math.max(1, num(g.scale, 12))
  const px = Math.floor(x * sc)
  const py = Math.floor(y * sc)
  return noiseHash(px, py, num(g.seed, 1))
}

/**
 * 格子哈希 —— **只用乘法和取小数**，不用 sin。
 *
 * ⚠️ 经典写法 `frac(sin(a)*43758.5453)` 在 JS 与 ffmpeg 里结果不一致：
 *    sin 用各自的 libm，大参数下最低位差一点，乘 43758 之后被放大到整数级，
 *    于是"同一个格子两边落在不同的批次"—— 成片上是一块块错位的方块，
 *    而两边的代码逐字相同、m 的公式也相同（实测 p99 差 85/255）。
 *    换成整数乘 + 黄金比小数后，两边都是 IEEE double 上的精确运算，逐位一致。
 */
function noiseHash(px, py, seed) {
  const n = px * 7 + py * 13 + seed * 3
  return frac(n * 0.6180339887498949)
}

function fieldSpiral(g, x, y) {
  const cx = num(g.cx, 0.5)
  const cy = num(g.cy, 0.5)
  const rmax = Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)) || 0.5
  const a = Math.atan2(y - cy, x - cx) / TAU + 0.5
  const r = Math.hypot(x - cx, y - cy) / rmax
  return frac(a + r * num(g.turns, 2))
}

/* ─────────────────── 光带（扫光 / 光束 / 电光 那一类） ─────────────────── */

/**
 * 一条光带在画面上的位置（0..1 的投影坐标）。
 * 与 `fieldAt` 的区别：field 是"该点何时切换"，proj 是"该点在这条带上的排序"，
 * 光带只是**部分**点亮画面 —— 一圈白光滑过，两端仍然是 A / B 的原样。
 */
function bandProj(b, x, y) {
  const g = b || {}
  switch (g.kind) {
    case 'lin':
      return fieldLin(g, x, y)
    case 'radial': {
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const rmax = Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)) || 0.5
      let t = Math.hypot(x - cx, y - cy) / rmax
      if (num(g.rings) > 0) t = frac(t * num(g.rings, 1))
      return clamp01(g.invert ? 1 - t : t)
    }
    case 'angular': {
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const arms = Math.max(1, Math.round(num(g.arms, 1)))
      const a = Math.atan2(y - cy, x - cx) / TAU + 0.5
      return frac(a * arms - num(g.offset, 0))
    }
    case 'stripe': {
      const n = Math.max(2, Math.round(num(g.n, 6)))
      const u = num(g.axis) ? y : x
      return frac(u * n)
    }
    default:
      return clamp01(x)
  }
}

/**
 * 光带权重：`pos` 从 -hw 走到 1+hw，所以两端画面原样、中间才有亮带。
 * @returns {number} 0..1
 */
function bandWeight(b, x, y, q) {
  const hw = Math.max(0.02, num(b && b.hw, 0.2))
  const pos = -hw + clamp01(q) * (1 + 2 * hw)
  return clamp01(1 - Math.abs(bandProj(b, x, y) - pos) / hw)
}

/**
 * 空间场总入口。x / y 是**归一化画面坐标**（0..1，原点左上）。
 * @returns {number} 0..1 —— 该点切换到后一段的时刻
 */
function fieldAt(geo, x, y) {
  const g = geo || {}
  switch (g.kind) {
    case 'lin':
      return fieldLin(g, x, y)
    case 'radial':
      return fieldRadial(g, x, y)
    case 'angular':
      return fieldAngular(g, x, y)
    case 'shape':
      return fieldShape(g, x, y)
    case 'grid':
      return fieldGrid(g, x, y)
    case 'stripe':
      return fieldStripe(g, x, y)
    case 'wave':
      return fieldWave(g, x, y)
    case 'noise':
      return fieldNoise(g, x, y)
    case 'spiral':
      return fieldSpiral(g, x, y)
    /* 全屏同刻：m = p，等价于最朴素的叠化（闪黑/闪白靠 ffmpeg 原生调色，见 flash 段） */
    case 'full':
      return 0
    default:
      return 0
  }
}

/**
 * 混合系数：0 = 完全是前一段，1 = 完全是后一段。
 * soft 是过渡带宽度（归一化），0.004 以下按硬边处理 —— 硬边在 ffmpeg 侧走
 * `gt()` 而不是除法，避免 soft 趋零时出现 1/0。
 *
 * 闪黑/闪白这一族**不是两段混合**（中间还有一个纯色），maskAt 只能返回它里面
 * "后一段"那一份权重（= b）。要看完整的三段权重用 appearanceAt。
 */
function maskAt(geo, x, y, p) {
  const g = geo || {}
  const q = phaseAt(g, p)
  /* 全屏类没有空间结构，直接由进度给系数。
     ⚠️ 不能落到下面的通用分支：field 恒 0 + soft 0 会得到"m 恒为 1"，
        整帧一直是后一段（缩略图全白、差异度量算成 0 对 0）。 */
  if (g.kind === 'full') return q
  /* 闪黑/闪白：先压到中间色再亮起，只在中间色那一段不适用二段混合 */
  if (g.kind === 'flash') return flashWeights(g, x, y, q).b
  const t = fieldAt(g, x, y)
  const soft = num(g.soft, 0)
  if (soft < 0.004) return t <= q ? 1 : 0
  return clamp01((q - t) / soft + 0.5)
}

/**
 * 闪黑 / 闪白 / 闪灰：**三段权重** {a, t, b}（前一段 / 中间色 / 后一段，和为 1）。
 *
 * 为什么不能塞进二段混合：整帧在中点要变成"后一段之前先经过一个纯色"，
 * 二段混合在 m=0.5 时只会给出 A、B 的平均，永远到不了纯白。
 *
 * `shape`（可选）把"经过中间色"这件事变成一次带形状的推进：
 *   shape 缺省 → 整帧同时压到中间色（tint 0 闪黑 / 1 闪白）；
 *   shape 给出 → 中间色像遮罩一样从某个方向扫过（扫光 / 光束 / 炫光 / 故障条纹），
 *                于是 16 个名字既靠 tint 也靠形状彼此区分。
 * `depth`（0..1）只压到多少 —— 0.82 是"闪到八成黑"，与纯黑一眼能分开。
 */
/**
 * 闪黑 / 闪白 / 扫光 / 光束：**三段权重** {a, t, b}（前一段 / 中间色 / 后一段，和为 1）。
 *
 * 为什么不能塞进二段混合：整帧在中点要变成"后一段之前先经过一个纯色"，
 * 二段混合在 m=0.5 时只会给出 A、B 的平均，永远到不了纯白。
 *
 * 中间色按什么形状出现，有两种：
 *   · `band`  —— 一条**光带**从画面上扫过（扫光 / 光束 / 电光 / 炫光 / 故障条纹）。
 *               两端画面仍是原来的 A、B，只有亮带经过的地方发光 ——
 *               这是"光效"页那批名字该有的样子。
 *   · `shape` —— 中间色像遮罩一样把整张画面**铺满**再退掉（闪烁光芒 / 白色溶解）。
 *               中点是整整一帧中间色那种"闪"。
 *   · 都没有  —— 整帧同时压到中间色（闪黑 / 闪白 / 闪黑叠化）。
 * `depth`（0..1）只压到几成 —— 0.78 是"闪到八成黑"，与纯黑一眼能分开。
 */
function flashWeights(g, x, y, q) {
  const tint = clamp01(num(g.tint, 0))
  const depth = clamp01(num(g.depth, 1))
  const soft = Math.max(0.02, num(g.soft, 0.3))
  const p = clamp01(q)
  let e
  if (g.band) {
    e = bandWeight(g.band, x, y, p)
  } else if (!g.shape) {
    /* 整帧同时压暗/提亮：三角包络，中点为 1 */
    e = 1 - Math.abs(1 - 2 * p)
  } else {
    /* 带形状：一条边扫过去（前半程铺满中间色），再一条边扫回来（后半程退成后一段）。
       两条边都从 -soft/2 起步，中点那一刻才不会留半格没盖住。 */
    const f = fieldAt(g.shape, x, y)
    const p1 = 2 * p * (1 + soft) - soft / 2
    const p2 = (2 * p - 1) * (1 + soft) - soft / 2
    e = p < 0.5 ? clamp01((p1 - f) / soft + 0.5) : 1 - clamp01((p2 - f) / soft + 0.5)
  }
  const k = clamp01(e * depth)
  const rest = 1 - k
  return { a: rest * (1 - p), b: rest * p, t: k, tint }
}

/**
 * 一个点最终长什么样 —— **三段权重**。这是缩略图、差异度量与 ffmpeg 表达式
 * 共同的模型：
 *
 *     rgb = A * a + T * t + B * b      （T = tint × 255，三个通道同值）
 *
 * 预览（CSS）没有"中间色层"，只能近似，见 geoToCss。
 */
function appearanceAt(geo, x, y, p) {
  const g = geo || {}
  const q = phaseAt(g, p)
  if (g.kind === 'flash') return flashWeights(g, x, y, q)
  if (g.kind === 'full') return { a: 1 - q, t: 0, b: q, tint: 0 }
  const m = maskAt(g, x, y, p)
  return { a: 1 - m, t: 0, b: m, tint: 0 }
}

/* ─────────────────────── ffmpeg 表达式生成 ─────────────────────── */

/** filtergraph 里 `,` 是参数/滤镜分隔符，表达式内的逗号必须转义 */
const esc = (s) => String(s).replace(/,/g, '\\,')
/** 数字写字面量：固定 6 位，去掉多余的 0，避免 `1e-7` 这种 ffmpeg 不认的形式 */
const lit = (v) => {
  const n = num(v)
  if (Math.abs(n) < 1e-9) return '0'
  return String(Number(n.toFixed(6)))
}

/* x / y 一律归一化到 0..1 —— 见文件头坑 2（这版 ffmpeg 没有 SW/SH） */
const NX = '(X/W)'
const NY = '(Y/H)'

/** 空间场 → ffmpeg 表达式（与 fieldAt 逐条对应，参数取自同一个 geo） */
function fieldExpr(geo) {
  const g = geo || {}
  switch (g.kind) {
    case 'lin': {
      const a = num(g.angle) * DEG
      const c = Math.cos(a)
      const s = Math.sin(a)
      const range = (Math.abs(c) + Math.abs(s)) / 2 || 0.5
      const denom = lit(2 * range)
      return `((${NX}-0.5)*${lit(c)}+(${NY}-0.5)*${lit(s)})/${denom}+0.5`
    }
    case 'radial': {
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const rmax = Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)) || 0.5
      let t = `hypot(${NX}-${lit(cx)},${NY}-${lit(cy)})/${lit(rmax)}`
      if (num(g.rings) > 0) t = `mod(${t}*${lit(g.rings)},1)`
      if (g.invert) t = `1-(${t})`
      return t
    }
    case 'angular': {
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const arms = Math.max(1, Math.round(num(g.arms, 1)))
      const conv = `(atan2(${NY}-${lit(cy)},${NX}-${lit(cx)})/(2*PI)+0.5)`
      const off = num(g.offset, 0)
      if (arms === 1) return `mod(${conv}-${lit(off)},1)`
      return `mod(${conv}*${arms}-${lit(off)},1)`
    }
    case 'shape': {
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const dx = `abs(${NX}-${lit(cx)})`
      const dy = `abs(${NY}-${lit(cy)})`
      const metric = g.metric || 'manhattan'
      const mx = Math.max(cx, 1 - cx)
      const my = Math.max(cy, 1 - cy)
      let d
      let dmax
      if (metric === 'chebyshev') {
        d = `max(${dx},${dy})`
        dmax = Math.max(mx, my)
      } else if (metric === 'euclid') {
        d = `hypot(${dx},${dy})`
        dmax = Math.hypot(mx, my)
      } else {
        d = `(${dx}+${dy})`
        dmax = mx + my
      }
      const t = `${d}/${lit(dmax || 0.5)}`
      return g.invert ? `1-(${t})` : t
    }
    case 'grid': {
      const nx = Math.max(1, Math.round(num(g.nx, 4)))
      const ny = Math.max(1, Math.round(num(g.ny, nx)))
      const ix = `min(floor(${NX}*${nx}),${nx - 1})`
      const iy = `min(floor(${NY}*${ny}),${ny - 1})`
      const order = num(g.order, 0)
      if (order === 1) return `((${iy})+(${ix})*${ny}+0.5)/${nx * ny}`
      if (order === 2) return `mod((${ix})+(${iy}),2)*0.5+((${ix})+(${iy})*${nx}+0.5)/${nx * ny}*0.5`
      if (order === 3) {
        const dmax = Math.hypot((nx - 1) / 2, (ny - 1) / 2) || 1
        return `hypot((${ix})-${lit((nx - 1) / 2)},(${iy})-${lit((ny - 1) / 2)})/${lit(dmax)}`
      }
      /* 4 = 乱序翻转，与 `fieldGrid` 的 order 4 同式（乘子必须同为大质数，理由见那边） */
      if (order === 4) {
        const n = `(${ix}*73856093+${iy}*19349663+${lit(num(g.seed, 1) * 83492791)})`
        return `mod(${n}*0.6180339887498949,1)`
      }
      return `((${ix})+(${iy})*${nx}+0.5)/${nx * ny}`
    }
    case 'stripe': {
      const n = Math.max(2, Math.round(num(g.n, 8)))
      const u = num(g.axis) ? NY : NX
      const k = `min(floor(${u}*${n}),${n - 1})`
      const phase = num(g.phase, 0)
      if (phase === 1) return `if(mod(${k},2),0.55,0.05)`
      if (phase === 2) return `mod(sin(${k}*12.9898+${lit(num(g.seed, 1))})*43758.5453,1)`
      return `((${k})+0.5)/${n}`
    }
    case 'wave': {
      const a = num(g.angle) * DEG
      const c = Math.cos(a)
      const s = Math.sin(a)
      const range = (Math.abs(c) + Math.abs(s)) / 2 || 0.5
      const base = `((${NX}-0.5)*${lit(c)}+(${NY}-0.5)*${lit(s)})/${lit(2 * range)}+0.5`
      const proj = `(-(${NX}-0.5)*${lit(s)}+(${NY}-0.5)*${lit(c)})`
      const amp = num(g.amp, 0.08)
      const freq = num(g.freq, 4)
      return `clip(${base}+${lit(amp)}*sin(${proj}*${lit(freq * TAU)}),0,1)`
    }
    case 'noise': {
      const sc = Math.max(1, num(g.scale, 12))
      const px = `floor(${NX}*${lit(sc)})`
      const py = `floor(${NY}*${lit(sc)})`
      return `mod((${px}*7+${py}*13+${lit(num(g.seed, 1) * 3)})*0.6180339887498949,1)`
    }
    case 'spiral': {
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const rmax = Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)) || 0.5
      const a = `(atan2(${NY}-${lit(cy)},${NX}-${lit(cx)})/(2*PI)+0.5)`
      const r = `hypot(${NX}-${lit(cx)},${NY}-${lit(cy)})/${lit(rmax)}`
      return `mod(${a}+${r}*${lit(num(g.turns, 2))},1)`
    }
    case 'full':
      return '0'
    default:
      return '0'
  }
}

/**
 * 光带投影的表达式版（与 bandProj 逐条对应）。
 * lin / radial / angular 三个的投影与同族 field 完全同式，直接复用 fieldExpr；
 * stripe 不同（field 是"第几条依次切换"，band 是 `frac(x*n)` 的周期带），单独写。
 */
function bandProjExpr(b) {
  const g = b || {}
  if (g.kind === 'stripe') {
    const n = Math.max(2, Math.round(num(g.n, 6)))
    return `mod((${num(g.axis) ? NY : NX})*${n},1)`
  }
  if (g.kind === 'lin' || g.kind === 'radial' || g.kind === 'angular') return fieldExpr(g)
  return NX
}

/**
 * 闪黑/闪白的表达式：三段混合 `A*(1-k)*(1-q) + B*(1-k)*q + T*k`，中间色是
 * **常量** tint×255（k = 压色量，与 flashWeights 逐字对应）。
 *
 * ⚠️ 常量只有落到 RGB 平面上才对（见文件头坑 3）—— 调用方必须走
 *    `xfadeArgs()` 拿 rgb 标记，把接缝两侧先转 gbrp/gbra。写成 yuv 上的同一份
 *    表达式，中点那一帧会是品红（常量同时写进 Y/U/V）。
 *
 * ⚠️ **表达式必须是纯函数（不许 st/ld）**（见文件头坑 4）：xfade 是**切片多线程**
 *    的，`st()` 写的是共享变量，线程之间互相覆盖 —— 实测同一份表达式连跑三次
 *    给出三组不同像素。所以 q 就地内联 `(1-P)`，不用变量周转。
 */
function flashExpr(g) {
  const tint = Math.round(clamp01(num(g.tint, 0)) * 255)
  const depth = clamp01(num(g.depth, 1))
  const soft = Math.max(0.02, num(g.soft, 0.3))
  const S = lit(soft)
  const prog = '(1-P)'
  const q = num(g.curve, 1) === 1 ? prog : `pow(${prog},${lit(g.curve)})`
  let e
  if (g.band) {
    /* 光带：pos 从 -hw 走到 1+hw，画面两端保持原样 */
    const hw = Math.max(0.02, num(g.band.hw, 0.2))
    e = `clip(1-abs((${bandProjExpr(g.band)})-(${lit(-hw)}+${q}*${lit(1 + 2 * hw)}))/${lit(hw)},0,1)`
  } else if (g.shape) {
    /* 带形状：一条边扫过整张画面再扫回来（中点整帧是中间色） */
    const f = fieldExpr(g.shape)
    e =
      `if(lt(${q},0.5),` +
      `clip((2*${q}*${lit(1 + soft)}-${lit(soft / 2)}-(${f}))/${S}+0.5,0,1),` +
      `1-clip(((2*${q}-1)*${lit(1 + soft)}-${lit(soft / 2)}-(${f}))/${S}+0.5,0,1))`
  } else {
    e = `1-abs(1-2*${q})`
  }
  const k = depth < 1 ? `${lit(depth)}*(${e})` : e
  /* 内联三遍而不是 st/ld —— 见文件头坑 4 */
  const mix = `(A*(1-${q})+B*${q})`
  return esc(`${mix}+(${tint}-${mix})*(${k})`)
}

/**
 * 生成 `xfade=transition=custom` 用的 expr（**已转义**，可直接拼进 filtergraph）。
 *
 * 形状 `A*(1-(m))+B*(m)`：
 *   · 返回值是**像素**不是系数（坑 1），必须自己做完混合；
 *   · m 写两遍而**不是** `st(0,m)+ld(0)` —— 见坑 4，那套在这版 ffmpeg 上会随机出脏帧；
 *   · 求值顺序无所谓了：整个表达式是纯函数，没有任何状态。
 */
function geoToExpr(geo) {
  const g = geo || {}
  /* 闪黑/闪白不是二段混合，走自己的三段表达式 */
  if (g.kind === 'flash') return flashExpr(g)
  /* ⚠️ 这版 ffmpeg 的 `P` 是**剩余量**（1 − 进度），不是进度。
     实测：0.3 进度那一帧里 `A*(1-P)+B*P` 输出 0.7*255 —— 也就是 P=0.7。
     这个方向反了不会报错，只会让"转场左右颠倒"，而且在 progress=0.5 那一帧
     完全看不出来（中点对称），所以单看中间帧的自测会全绿。
     这里统一写成 (1-P)，后续一律按"进度"理解。 */
  const prog = '(1-P)'
  const q = num(g.curve, 1) === 1 ? prog : `pow(${prog},${lit(g.curve)})`
  /* 全屏叠化：m 就是进度本身。
     ⚠️ 不能落到下面的通用分支：`full` 没有 soft（=0），会拼出 `gt(q,0)`
        这个"恒为 1"，成片就成了硬切 —— 而 `gt(q,0)` 看着完全正常。 */
  if (g.kind === 'full') return esc(`A*(1-(${q}))+B*(${q})`)
  const t = fieldExpr(g)
  const soft = num(g.soft, 0)
  const m =
    soft < 0.004 ? `gt(${q},(${t}))` : `clip((${q}-(${t}))/${lit(soft)}+0.5,0,1)`
  return esc(`A*(1-(${m}))+B*(${m})`)
}

/**
 * 一个接缝该怎么接 —— `render.js` 与闸门共用这一个出口。
 *
 * @param {object|null} geo     转场几何；空则走 ffmpeg 原生名
 * @param {object} opts         { ffmpeg: 原生名, pixFmt: 目标像素格式 }
 * @returns {{spec: string, rgb: string}} `spec` 直接拼进 `xfade=`；
 *          `rgb` 非空时，接缝两侧要先转成这个格式（见下面两条理由）。
 *
 * ⚠️ **custom 转场一律走 RGB 平面**，两个理由都是实测出来的：
 *   ① 色度常量：闪黑/闪白要把整帧压成一个常量色，yuv 上常量会同时写进 Y/U/V
 *      ⇒ 中点是品红（坑 3）。
 *   ② **进度 P 在 YUV 上是压扁的**：同一段 `255*P` 探针，2 秒 / 10fps 的转场
 *      在 `gray` / `gbrp` / `rgb24` 上是标准的 20 帧走完，在 `yuv420p` /
 *      `yuv444p` 上只有 7 帧就走完了（≈3 倍速），然后剩下的时间一直停在 B。
 *      也就是说 YUV 上的自定义转场会"转得飞快、后半段干等着"，不报错、不告警。
 *      换成 RGB 平面之后，逐帧读回来的 `1-P` 与 `(帧号/帧率-offset)/duration`
 *      完全对齐（每帧 0.05）。
 * 代价是每个接缝多一次 yuv→RGB→yuv 的格式往返；0.6 秒的转场看不出差别。
 * 原生那 58 个键不经过表达式，仍留在 yuv 上（ffmpeg 自己算进度不会错）。
 */
function xfadeArgs(geo, opts) {
  const o = opts || {}
  const expr = geo ? geoToExpr(geo) : ''
  if (!expr) return { spec: `transition=${o.ffmpeg}`, rgb: '' }
  /* 带 alpha 的工程用 gbra：转 gbrp 会把 alpha 丢掉，背景变黑 */
  const rgb = String(o.pixFmt || '').includes('a') ? 'gbra' : 'gbrp'
  return { spec: `transition=custom:expr='${expr}'`, rgb }
}

/* ───────────────────────── 预览用 CSS ───────────────────────── */

const pct = (v) => `${(Number(v) * 100).toFixed(2)}%`

/**
 * 空间场 → CSS 遮罩。
 *
 * 返回 React 的 style 对象（`maskImage` 让"后一段"按遮罩显形）。
 * 能几何等价的族走 mask / clip-path（linear / radial / conic / polygon）；
 * grid 的乱序与 noise / spiral 只能近似 —— 如实返回 `approx: true`，
 * 由调用方写进 `data-xfade-map`，闸门按属性断言，免得把近似当成一样。
 *
 * @returns {{style: object, approx: boolean}}
 */
function geoToCss(geo, progress) {
  const g = geo || {}
  const p = clamp01(num(progress))
  const q = phaseAt(g, p)
  const soft = num(g.soft, 0)
  const half = soft / 2
  /* 软边两侧的停点：q 之前全显形，q+half 之后完全不显形 */
  const a = Math.max(0, q - half)
  const b = Math.min(1, q + half)
  const hard = soft < 0.004
  const maskOf = (image) => ({ WebkitMaskImage: image, maskImage: image })

  switch (g.kind) {
    case 'lin': {
      const angle = num(g.angle) * DEG
      /* CSS 0deg 指向正上、顺时针；场的方向向量是 (cos, sin)，y 轴朝下 */
      const cssDeg = (Math.atan2(Math.cos(angle), -Math.sin(angle)) / DEG + 360) % 360
      const stops = hard
        ? `rgba(0,0,0,1) ${pct(q)}, rgba(0,0,0,0) calc(${pct(q)} + 0.01%)`
        : `rgba(0,0,0,1) ${pct(a)}, rgba(0,0,0,0) ${pct(b)}`
      return { style: maskOf(`linear-gradient(${cssDeg.toFixed(2)}deg, ${stops})`), approx: false }
    }
    case 'radial': {
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const rmax = Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)) || 0.5
      const at = `at ${pct(cx)} ${pct(cy)}`
      const size = `${pct(rmax)} ${pct(rmax)}`
      if (num(g.rings) > 0) {
        /* 同心环：CSS 没有"随进度整体推进的重复环"，用重复径向渐变近似 */
        const ring = 1 / Math.max(1, num(g.rings))
        const img = `repeating-radial-gradient(ellipse ${size} ${at}, rgba(0,0,0,1) 0, rgba(0,0,0,0) ${pct(ring * q)})`
        return { style: maskOf(img), approx: true }
      }
      const inner = g.invert ? 1 - a : a
      const outer = g.invert ? 1 - b : b
      /* 反向（从外向内）时中心是透明的，停点顺序要跟着翻 */
      const stops = g.invert
        ? `rgba(0,0,0,0) ${pct(outer)}, rgba(0,0,0,1) ${pct(inner)}`
        : `rgba(0,0,0,1) ${pct(inner)}, rgba(0,0,0,0) ${pct(outer)}`
      return { style: maskOf(`radial-gradient(ellipse ${size} ${at}, ${stops})`), approx: false }
    }
    case 'angular': {
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const arms = Math.max(1, Math.round(num(g.arms, 1)))
      const off = num(g.offset, 0)
      /* 场里的 a 从"正右"起算且朝下为正；conic 从"正上"起算且顺时针 */
      const from = ((off * 360) % 360 + 360) % 360
      const at = `at ${pct(cx)} ${pct(cy)}`
      const span = 360 / arms
      if (arms === 1) {
        const stops = hard
          ? `rgba(0,0,0,1) ${pct(q * 100)}, rgba(0,0,0,0) calc(${pct(q * 100)} + 0.01%)`
          : `rgba(0,0,0,1) ${pct(a * 100)}, rgba(0,0,0,0) ${pct(b * 100)}`
        return { style: maskOf(`conic-gradient(from ${from.toFixed(2)}deg ${at}, ${stops})`), approx: false }
      }
      const stops = `rgba(0,0,0,1) 0 ${pct(q * span / 360)}, rgba(0,0,0,0) 0 ${pct(span / 360)}`
      return {
        style: maskOf(`repeating-conic-gradient(from ${from.toFixed(2)}deg ${at}, ${stops})`),
        approx: true
      }
    }
    case 'shape': {
      /* 菱形 / 方形 / 圆形都用 polygon 画等值线：4 个顶点，随 q 外扩 */
      const cx = num(g.cx, 0.5)
      const cy = num(g.cy, 0.5)
      const mx = Math.max(cx, 1 - cx)
      const my = Math.max(cy, 1 - cy)
      const metric = g.metric || 'manhattan'
      const r = g.invert ? 1 - q : q
      const pts = []
      if (metric === 'chebyshev') {
        const w = r * mx * 2
        const h = r * my * 2
        pts.push([cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2])
      } else if (metric === 'euclid') {
        /* clip-path 画不了圆，用 32 边形 —— 肉眼在 1080p 上看不出 */
        const rad = r * Math.hypot(mx, my)
        for (let i = 0; i < 32; i += 1) {
          const t = (i / 32) * TAU
          pts.push([cx + Math.cos(t) * rad, cy + Math.sin(t) * rad])
        }
      } else {
        const dx = r * mx
        const dy = r * my
        pts.push([cx, cy - dy], [cx + dx, cy], [cx, cy + dy], [cx - dx, cy])
      }
      const poly = pts.map(([px, py]) => `${pct(px)} ${pct(py)}`).join(', ')
      return { style: { clipPath: `polygon(${poly})` }, approx: metric === 'euclid' && g.invert }
    }
    case 'stripe': {
      /* 梳子形多边形：已跳出的条画满，未跳出的整条空 —— 单环，clip-path 能精确表达 */
      const n = Math.max(2, Math.round(num(g.n, 8)))
      const vertical = !num(g.axis)
      const pts = []
      for (let k = 0; k < n; k += 1) {
        const t0 = fieldStripe(g, vertical ? (k + 0.5) / n : 0.5, vertical ? 0.5 : (k + 0.5) / n)
        const on = hard ? t0 <= q : clamp01((q - t0) / soft + 0.5) > 0.5
        if (!on) continue
        if (vertical) {
          pts.push([k / n, 0], [(k + 1) / n, 0], [(k + 1) / n, 1], [k / n, 1])
        } else {
          pts.push([0, k / n], [1, k / n], [1, (k + 1) / n], [0, (k + 1) / n])
        }
      }
      if (!pts.length) return { style: { opacity: 0 }, approx: false }
      if (pts.length >= n * 4) return { style: { opacity: 1 }, approx: false }
      /* 多条互不相连 → clip-path 单环画不出来，改用 mask 的重复渐变（近似） */
      const period = 2 / n
      const img = vertical
        ? `repeating-linear-gradient(90deg, rgba(0,0,0,1) 0 ${pct(1 / n)}, rgba(0,0,0,0) 0 ${pct(period)})`
        : `repeating-linear-gradient(0deg, rgba(0,0,0,1) 0 ${pct(1 / n)}, rgba(0,0,0,0) 0 ${pct(period)})`
      const sweep = vertical
        ? `inset(0 ${pct(1 - q)} 0 0)`
        : `inset(${pct(1 - q)} 0 0 0)`
      return { style: { ...maskOf(img), clipPath: sweep }, approx: true }
    }
    case 'grid': {
      const nx = Math.max(1, Math.round(num(g.nx, 4)))
      const ny = Math.max(1, Math.round(num(g.ny, nx)))
      const order = num(g.order, 0)
      if (order > 1) {
        /* 乱序网格无单环表达，退化为整体栅格淡入 */
        const img = `repeating-linear-gradient(90deg, rgba(0,0,0,1) 0 ${pct(1 / nx)}, rgba(0,0,0,0) 0 ${pct(2 / nx)})`
        return { style: { ...maskOf(img), opacity: q, clipPath: `inset(0 ${pct(1 - q)} 0 0)` }, approx: true }
      }
      /* 行/列优先时"已跳出的格"是一个阶梯形，单环可画 */
      const cell = order === 1 ? 1 / ny : 1 / nx
      const full = Math.floor(q * (nx * ny))
      const pts = []
      if (order === 0) {
        const rows = Math.floor(full / nx)
        const rest = full - rows * nx
        if (rows > 0) pts.push([0, 0], [1, 0], [1, rows / ny], [0, rows / ny])
        if (rest > 0) {
          const y0 = rows / ny
          const y1 = (rows + 1) / ny
          pts.push([0, y0], [rest / nx, y0], [rest / nx, y1], [0, y1])
        }
      } else {
        const cols = Math.floor(full / ny)
        const rest = full - cols * ny
        if (cols > 0) pts.push([0, 0], [cols / nx, 0], [cols / nx, 1], [0, 1])
        if (rest > 0) {
          const x0 = cols / nx
          const x1 = (cols + 1) / nx
          pts.push([x0, 0], [x1, 0], [x1, rest / ny], [x0, rest / ny])
        }
      }
      if (!pts.length) return { style: { opacity: 0 }, approx: false }
      if (q >= 1) return { style: { opacity: 1 }, approx: false }
      const poly = pts.map(([px, py]) => `${pct(px)} ${pct(py)}`).join(', ')
      return { style: { clipPath: `polygon(${poly})` }, approx: false, cell }
    }
    case 'wave': {
      /* 波浪边界：沿 x 扫描 24 列，二分求出每列"边界所在 y"，连成折线。
         直接采样空间场而不是解析正弦 —— 斜角/多波峰时解析式容易写错，
         而场本身已经是唯一真源。 */
      const steps = 24
      const edge = []
      for (let i = 0; i <= steps; i += 1) {
        const x = i / steps
        let lo = 0
        let hi = 1
        for (let k = 0; k < 18; k += 1) {
          const mid = (lo + hi) / 2
          if (fieldAt(g, x, mid) < q) lo = mid
          else hi = mid
        }
        edge.push([x, (lo + hi) / 2])
      }
      const poly = [[0, 0], [1, 0], ...edge.slice().reverse()]
        .map(([px, py]) => `${pct(px)} ${pct(py)}`)
        .join(', ')
      return { style: { clipPath: `polygon(${poly})` }, approx: true }
    }
    case 'noise':
    case 'spiral':
      /* 颗粒溶解 / 螺旋：浏览器没有等价滤镜，用点阵 / 扇形近似 */
      if (g.kind === 'noise') {
        const img = 'radial-gradient(circle, #000 calc(var(--dp) * 1px), transparent 0)'
        return {
          style: { ...maskOf(img), WebkitMaskSize: '4px 4px', maskSize: '4px 4px', '--dp': (q * 2.35).toFixed(3) },
          approx: true
        }
      }
      return { style: maskOf(`conic-gradient(rgba(0,0,0,1) 0 ${pct(q * 100)}, rgba(0,0,0,0) 0)`), approx: true }
    case 'full':
      return { style: { opacity: q.toFixed(4) }, approx: false }
    case 'flash': {
      /* 闪黑/闪白：DOM 里只有"后一段"这一层，没有中间色层。
         近似口径：只要中间色在场（t>0）就把后一段显出来，用亮度去顶替那个纯色。
         成片是精确的三段混合（见 flashExpr），预览这一层如实标 approx。 */
      const w = flashWeights(g, 0.5, 0.5, q)
      const lit0 = 1 + (w.tint - 0.5) * 2 * 1.4
      const gain = Math.max(0, 1 + (lit0 - 1) * w.t)
      return {
        style: { opacity: clamp01(w.b + w.t).toFixed(4), filter: `brightness(${gain.toFixed(3)})` },
        approx: true
      }
    }
    default:
      return { style: { opacity: q.toFixed(4) }, approx: true }
  }
}

module.exports = {
  fieldAt,
  maskAt,
  phaseAt,
  flashWeights,
  appearanceAt,
  geoToExpr,
  geoToCss,
  xfadeArgs
}
