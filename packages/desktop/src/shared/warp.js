'use strict'
/**
 * 自由变形（四角透视）真源 —— 把矩形的四个角拖到任意位置，得到一张透视投影。
 *
 * 为什么这个必须是一个**纯数学**模块，而且必须两端共用：
 *   四角变形在两个端上是两种完全不同的实现 ——
 *   预览走 CSS 的 `matrix3d`（3×3 单应矩阵塞进 4×4），导出走 ffmpeg 的
 *   `perspective` 滤镜。这两条路的参数形式、坐标口径、角点顺序全都不一样。
 *   一旦各写一份，症状是"预览里拉成了梯形、成片还是原来的矩形"，
 *   而构建成功、静态扫描无感、单元测试也只测各自（「静默失效五类」的第 ⑤ 类）。
 *   所以：**四角 → 矩阵**这一步只有这一份，两端都从这里取数。
 *
 * 数学：
 *   四个角点 → 一个 3×3 单应矩阵 H（homography）。用标准 DLT 解 8 元线性方程组，
 *   不用任何"记忆里的闭式公式" —— 那些公式的角点顺序（TL→TR→BL→BR 还是 TL→TR→BR→BL）
 *   记错一个就会得到转置或者镜像的结果，而且在轴对齐时**完全看不出来**
 *   （仿射情形下两种顺序刚好等价），只有真做透视才现形。DLT 没有这个自由度。
 *
 * 坐标口径（两端必须一致）：
 *   `u,v ∈ [0,1]` 是**元素自身的归一化坐标**（左上 0,0 → 右下 1,1）。
 *   warp 参数里的 `x/y` 是**相对宽/高的百分比偏移**（0 = 不动），
 *   所以缺省全 0 时四角就是 (0,0)(1,0)(1,1)(0,1) = 恒等变换。
 *
 * 退化：
 *   四角拖成自交（蝴蝶结）或面积趋近于 0 时，`isValidQuad` 返回 false。
 *   渲染与导出两端**都**在无效时退回"不做变形"，而不是画出一团错的东西。
 */

/** 单个角偏移的上限（相对宽/高的百分比）。±50% 已经足够做出夸张的透视 */
const WARP_LIMIT = 50

/** 四边形的最小面积（归一化坐标下的绝对值）。低于它视为退化 —— 画面被压成一条线 */
const MIN_QUAD_AREA = 0.02

/** 角点顺序固定为 TL → TR → BR → BL（顺时针）。两端都按这个顺序取数 */
const WARP_CORNERS = ['tl', 'tr', 'br', 'bl']

const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
const round4 = (v) => Number(Number(v).toFixed(4))

/** 读一组 warp 参数。缺字段 / 脏数据一律回落 0，不抛错、不产生 NaN */
function readWarp(src) {
  const s = src && typeof src === 'object' ? src : {}
  const out = { on: Boolean(s.on) }
  for (const key of WARP_CORNERS) {
    const point = s[key] && typeof s[key] === 'object' ? s[key] : {}
    out[key] = {
      x: round4(clamp(num(point.x, 0), -WARP_LIMIT, WARP_LIMIT)),
      y: round4(clamp(num(point.y, 0), -WARP_LIMIT, WARP_LIMIT))
    }
  }
  return out
}

/** 中性？（没开，或者四角全是 0 —— 开了但一像素没动，效果等于没开） */
function isNeutralWarp(warp) {
  if (!warp || !warp.on) return true
  return WARP_CORNERS.every((key) => Math.abs(num(warp[key] && warp[key].x)) < 0.01 && Math.abs(num(warp[key] && warp[key].y)) < 0.01)
}

/**
 * warp 参数 → 归一化目标四角（单位方形的四个角被拉到哪里）。
 * 返回顺序 TL → TR → BR → BL。
 */
function cornerPoints(warp) {
  const w = warp || {}
  const at = (key, dx, dy) => {
    const point = w[key] && typeof w[key] === 'object' ? w[key] : {}
    return { x: dx + num(point.x) / 100, y: dy + num(point.y) / 100 }
  }
  return [at('tl', 0, 0), at('tr', 1, 0), at('br', 1, 1), at('bl', 0, 1)]
}

/** 有向面积的绝对值（鞋带公式）。用来判退化 */
function quadArea(points) {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

/**
 * 四边形是否可用：面积够大，且四个角**同号绕向**（不自交）。
 *
 * ⚠️ 自交的四边形（蝴蝶结）在数学上仍然能解出单应矩阵，但它会把画面
 *    反折过去 —— 预览里表现为"画面中间有一道撕裂"，导出里是同一处撕裂。
 *    这不是"用户想要的创意效果"，所以直接判无效、退回不变形。
 */
function isValidQuad(points) {
  if (!Array.isArray(points) || points.length !== 4) return false
  if (points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false
  if (quadArea(points) < MIN_QUAD_AREA) return false
  let sign = 0
  for (let i = 0; i < 4; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % 4]
    const c = points[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) continue // 三点共线不算破 —— 梯形的一条腰可以共线
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/**
 * 解 8 元线性方程组（高斯消元 + 部分主元）。
 * @param {number[][]} A 8×8 系数矩阵
 * @param {number[]} b 8 元右端
 * @returns {number[]|null} 解；不可解时 null
 */
function solve8(A, b) {
  const n = 8
  const m = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null
    if (pivot !== col) {
      const tmp = m[pivot]
      m[pivot] = m[col]
      m[col] = tmp
    }
    const div = m[col][col]
    for (let k = col; k <= n; k += 1) m[col][k] /= div
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue
      const factor = m[row][col]
      if (Math.abs(factor) < 1e-15) continue
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k]
    }
  }
  return m.map((row) => row[n])
}

/**
 * 单位方形四角 → 目标四角的单应矩阵（DLT）。
 *
 * 齐次形式：`[x', y', w]ᵀ = H · [u, v, 1]ᵀ`，实际坐标是 `x'/w, y'/w`。
 * 固定 `h33 = 1`（8 个自由度），于是每组对应点给两个方程：
 *   `h11·u + h12·v + h13 − h31·u·x − h32·v·x = x`
 *   `h21·u + h22·v + h23 − h31·u·y − h32·v·y = y`
 *
 * @param {{x:number,y:number}[]} points TL → TR → BR → BL（归一化坐标）
 * @returns {number[]|null} 行主序的 9 元数组；退化时 null
 */
function homographyFromUnitSquare(points) {
  if (!Array.isArray(points) || points.length !== 4) return null
  /* 单位方形的四角，顺序与 points 严格对应：TL(0,0) TR(1,0) BR(1,1) BL(0,1) */
  const unit = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 }
  ]
  const A = []
  const b = []
  for (let i = 0; i < 4; i += 1) {
    const u = unit[i].x
    const v = unit[i].y
    const x = points[i].x
    const y = points[i].y
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x])
    b.push(x)
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y])
    b.push(y)
  }
  const h = solve8(A, b)
  if (!h || h.some((value) => !Number.isFinite(value))) return null
  return [...h, 1]
}

/** 用单应矩阵把一个归一化点映射过去（内部口径，闸门也用它反算四角） */
function applyHomography(h, point) {
  if (!h || !point) return null
  const w = h[6] * point.x + h[7] * point.y + h[8]
  if (Math.abs(w) < 1e-9) return null
  return {
    x: (h[0] * point.x + h[1] * point.y + h[2]) / w,
    y: (h[3] * point.x + h[4] * point.y + h[5]) / w
  }
}

/**
 * warp → CSS `matrix3d(...)`（作用在**元素像素坐标**上）。
 *
 * 为什么需要 `width` / `height`：
 *   单应矩阵是在归一化坐标下解的，而 CSS 的 `matrix3d` 作用在元素的 px 坐标上。
 *   两者的关系是一次共轭变换 `M_px = S · H · S⁻¹`，其中 `S = diag(W, H, 1)`。
 *   展开之后系数里会出现 `W/H` 与 `1/W` 这类比例 —— 所以**元素尺寸变了矩阵就必须重算**。
 *   （这也是"为什么不能只在 CSS 里写死一串数"的原因：窗口一缩放，透视就歪了。）
 *
 * @returns {string} 空串表示不变形（中性 / 无效 / 尺寸未知）
 */
function cssWarpTransform(warp, width, height) {
  if (isNeutralWarp(warp)) return ''
  const W = Number(width)
  const Hh = Number(height)
  if (!(W > 0) || !(Hh > 0)) return ''
  const points = cornerPoints(warp)
  if (!isValidQuad(points)) return ''
  const h = homographyFromUnitSquare(points)
  if (!h) return ''
  /* S·H·S⁻¹ 展开后的六个独立系数（见上面的推导） */
  const a11 = h[0]
  const a12 = (W / Hh) * h[1]
  const a13 = W * h[2]
  const a21 = (Hh / W) * h[3]
  const a22 = h[4]
  const a23 = Hh * h[5]
  const a31 = h[6] / W
  const a32 = h[7] / Hh
  const a33 = 1
  const n = (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : 0)
  /* matrix3d 是列主序：m11,m12,m13,m14 是第一列 */
  return (
    `matrix3d(${n(a11)},${n(a21)},0,${n(a31)},` +
    `${n(a12)},${n(a22)},0,${n(a32)},` +
    `0,0,1,0,` +
    `${n(a13)},${n(a23)},0,${n(a33)})`
  )
}

/**
 * warp → ffmpeg `perspective` 的参数字符串。
 *
 * `sense=destination`：给出的坐标是**目标图里**的四个角，源图的四角被拉过去。
 *
 * ⚠️ **角点顺序是 TL → TR → BL → BR**，不是 TL → TR → BR → BL。
 *    ffmpeg 文档写的是 "top left, top right, bottom left and bottom right"。
 *    按顺时针（TL→TR→BR→BL）传会得到一个**左右镜像**的结果 ——
 *    而在四角对称时不报错、不警告，只在真做非对称透视时才看得出来。
 *    实测记在这里，别再改回去。
 *
 * ⚠️ `perspective` **会丢掉 alpha**：源四角内缩出来的框外区域是**不透明黑**
 *    （实测 rgba 输出 alpha 恒 255）。所以量出这条链之后必须用 `warpMaskFilter`
 *    生成的有效区遮罩走一次 `alphamerge` 补回来，否则成片里变形后的画面外
 *    会是一整片黑，把下层画面全盖住。
 *
 * @param {object} warp
 * @param {number} width 这一帧的像素宽
 * @param {number} height 这一帧的像素高
 * @param {(v:number, d?:number)=>number} round 取整函数（与 render.js 同一份）
 * @returns {string} 空串表示不需要透视
 */
function perspectiveFilter(warp, width, height, round = round4) {
  if (isNeutralWarp(warp)) return ''
  const W = Number(width)
  const Hh = Number(height)
  if (!(W > 0) || !(Hh > 0)) return ''
  const points = cornerPoints(warp)
  if (!isValidQuad(points)) return ''
  /* 归一化顺序 TL,TR,BR,BL → ffmpeg 的 TL,TR,BL,BR */
  const order = [0, 1, 3, 2].map((i) => ({
    x: round(points[i].x * W, 2),
    y: round(points[i].y * Hh, 2)
  }))
  const parts = order.map((p, i) => `x${i}=${p.x}:y${i}=${p.y}`)
  return `perspective=${parts.join(':')}:sense=destination:eval=init`
}

/**
 * 有效区遮罩的边宽（像素）。
 *
 * 为什么需要黑边：`perspective` 对越界像素用的是**边缘 clamp**（把边缘那一列/行
 * 拉伸出去），所以一张纯白的遮罩图变换后连框外也是白的 —— 补出来的 alpha 还是 255。
 * 把遮罩做成「白底 + N 像素黑边」，clamp 取到的就是黑边，框外才是 0。
 * 代价是画面边缘那 N 像素也会被判成透明，3px @1080p 看不出来。
 */
const WARP_MASK_BORDER = 3

/**
 * 有效区遮罩图的生成参数（render.js 用它落一张缓存 PNG）。
 * 遮罩必须是「白底 + 黑边」，理由见 WARP_MASK_BORDER。
 */
const warpMaskBox = (width, height) => ({
  width: Math.max(4, Math.round(Number(width) || 0)),
  height: Math.max(4, Math.round(Number(height) || 0)),
  border: WARP_MASK_BORDER
})

/** 遮罩图自己的 perspective 串（与画面同一个映射，保证像素级对齐） */
const warpMaskFilter = (warp, width, height, round = round4) => perspectiveFilter(warp, width, height, round)

/**
 * 把某个角拖到某个位置后，四边形是否还有效。
 * 拖动时用它做"拖不动"的边界：无效就保留上一帧的值，而不是画出撕裂的画面。
 */
function canPlaceCorner(warp, key, x, y) {
  if (!WARP_CORNERS.includes(key)) return false
  const next = readWarp(warp)
  next[key] = { x: clamp(num(x, 0), -WARP_LIMIT, WARP_LIMIT), y: clamp(num(y, 0), -WARP_LIMIT, WARP_LIMIT) }
  return isValidQuad(cornerPoints(next))
}

module.exports = {
  WARP_LIMIT,
  MIN_QUAD_AREA,
  WARP_CORNERS,
  WARP_MASK_BORDER,
  readWarp,
  isNeutralWarp,
  cornerPoints,
  quadArea,
  isValidQuad,
  homographyFromUnitSquare,
  applyHomography,
  cssWarpTransform,
  perspectiveFilter,
  warpMaskBox,
  warpMaskFilter,
  canPlaceCorner
}
