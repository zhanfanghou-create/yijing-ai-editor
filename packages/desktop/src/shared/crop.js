'use strict'
/**
 * 片段「自由裁剪框」真源（裁剪 + 铺满）。
 *
 * 语义（必须与参考客户端的裁剪工具一致）：
 *   在**画布坐标系**里框一个矩形（百分比），框外的内容裁掉，
 *   框内的内容**铺满**画布（按 cover 口径：等比放大到刚好盖满，多出的部分再裁掉）。
 *
 * 为什么单独一个 shared 模块：与 adjust.js / effects.js 同一个病 ——
 *   「裁剪框 50%」在**预览**里必须真的让画面变近，在**导出**里必须真的多两级
 *   ffmpeg 滤镜（crop + scale）。两边各写一份，迟早一边漏掉，
 *   症状是"面板上框了、预览也变了、成片还是原样"，而构建/静态扫描都看不出来。
 *
 * 两侧的换算（逐字对应）：
 *   预览 → `transform: scale(k) translate(tx, ty)`，k = max(1/w, 1/h)
 *   导出 → `crop=W*w:H*h:W*x:H*y,scale=W:H:force_original_aspect_ratio=increase,crop=W:H`
 *
 * ⚠️ 预览那条 transform 的**函数顺序不能反**：CSS 的 transform 从右往左作用，
 *    `scale(k) translate(t)` 是"先平移再放大"，正好等于导出里"先裁再放大"。
 *    写成 `translate(...) scale(k)` 会让平移量被放大 k 倍（裁得越狠跑得越远）。
 */

/** 裁剪比例预设。`free` = 不受比例约束（手动拉框） */
const CROP_RATIOS = [
  { key: 'free', label: '自由' },
  { key: '1:1', label: '1:1', ratio: 1 },
  { key: '4:3', label: '4:3', ratio: 4 / 3 },
  { key: '3:4', label: '3:4', ratio: 3 / 4 },
  { key: '16:9', label: '16:9', ratio: 16 / 9 },
  { key: '9:16', label: '9:16', ratio: 9 / 16 },
  { key: '2.35:1', label: '2.35:1', ratio: 2.35 }
]

/** 裁剪框最小边长（画布百分比）—— 再小就只剩几个像素，导出的 scale 会溢出 */
const CROP_MIN = 4

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const round4 = (value) => Number(Number(value).toFixed(4))

/** 读裁剪参数：缺省 / 脏数据一律回落「不裁剪」，不抛错、不产生 NaN */
function readCrop(src) {
  const s = src && typeof src === 'object' ? src : {}
  const w = clamp(num(s.w, 100), CROP_MIN, 100)
  const h = clamp(num(s.h, 100), CROP_MIN, 100)
  return {
    on: Boolean(s.on),
    // x/y 是**左上角**，且保证整个框在画布内（x + w <= 100）
    x: clamp(num(s.x, 0), 0, 100 - w),
    y: clamp(num(s.y, 0), 0, 100 - h),
    w,
    h
  }
}

/** 是否等于「整幅画面」（等于不做裁剪） */
const isNeutralCrop = (crop) => {
  const c = readCrop(crop)
  return !c.on || (c.x < 0.01 && c.y < 0.01 && c.w > 99.99 && c.h > 99.99)
}

/**
 * 按比例算一个居中的最大裁剪框。
 *
 * @param {string} key    CROP_RATIOS 里的 key
 * @param {number} frameAr 画布宽高比（宽 / 高）
 * @returns {{x:number,y:number,w:number,h:number}} 百分比矩形
 */
function cropRectFor(key, frameAr = 16 / 9) {
  const item = CROP_RATIOS.find((entry) => entry.key === key)
  const target = item && item.ratio ? item.ratio : 0
  if (!target) return { x: 0, y: 0, w: 100, h: 100 }
  /* 框在画布里的像素宽高 = w% × W 与 h% × H；要求两者之比 = target
     ⇒ (w/100·W) / (h/100·H) = target ⇒ w/h = target × H/W = target / frameAr */
  const ratio = target / (Number(frameAr) > 0 ? Number(frameAr) : 16 / 9)
  let w = ratio >= 1 ? 100 : ratio * 100
  let h = ratio >= 1 ? (100 / ratio) : 100
  w = Math.min(100, w)
  h = Math.min(100, h)
  return {
    x: round4((100 - w) / 2),
    y: round4((100 - h) / 2),
    w: round4(w),
    h: round4(h)
  }
}

/**
 * 裁剪 → 预览用的 `transform` 片段（无裁剪时返回 ''）。
 *
 * @param {object} crop 片段上的 crop
 * @returns {string} 形如 `scale(2) translate(-25%, -25%)`
 */
function cssCropTransform(crop) {
  if (isNeutralCrop(crop)) return ''
  const c = readCrop(crop)
  const w = c.w / 100
  const h = c.h / 100
  // 等比放大到刚好盖满画布（cover），与导出的 force_original_aspect_ratio=increase 同口径
  const k = Math.max(1 / w, 1 / h)
  const tx = (1 / (2 * k) - (c.x / 100 + w / 2)) * 100
  const ty = (1 / (2 * k) - (c.y / 100 + h / 2)) * 100
  return `scale(${round4(k)}) translate(${round4(tx)}%, ${round4(ty)}%)`
}

/**
 * 裁剪 → 导出用的滤镜串（不含前导逗号；无裁剪时返回 ''）。
 *
 * ⚠️ 必须排在「铺满画布 crop」**之后**、缩放/位置**之前**：
 *    语义就是"先成帧，再在帧里框一块，再放大回原尺寸"。
 */
function ffmpegCropFor(crop, width, height, round = (v, d = 3) => Number(Number(v).toFixed(d))) {
  if (isNeutralCrop(crop)) return ''
  const c = readCrop(crop)
  const W = Math.max(2, Math.round(num(width, 1920)))
  const H = Math.max(2, Math.round(num(height, 1080)))
  const cw = Math.max(2, Math.round((W * c.w) / 100 / 2) * 2)
  const ch = Math.max(2, Math.round((H * c.h) / 100 / 2) * 2)
  const cx = Math.round((W * c.x) / 100)
  const cy = Math.round((H * c.y) / 100)
  return (
    `crop=${cw}:${ch}:${cx}:${cy},` +
    `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
  )
}

module.exports = {
  CROP_RATIOS,
  CROP_MIN,
  readCrop,
  isNeutralCrop,
  cropRectFor,
  cssCropTransform,
  ffmpegCropFor
}
