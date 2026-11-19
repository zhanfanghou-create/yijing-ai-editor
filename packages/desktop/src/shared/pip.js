/**
 * 画中画（叠加轨）的几何与参数归一化 —— **预览与导出共用这一份**。
 *
 * 数据真源是 `shared/pip.json`。这里只做三件事：夹取、把 (锚点, 尺寸, 位移) 换算成
 * 画面里的矩形、以及把片段上可能残缺的 pip 字段补齐。
 *
 * 为什么要单独一个文件：几何以前分在两处（`renderer/pip.js` 算 CSS、`main/render.js`
 * 算 ffmpeg overlay 坐标），两边各写一份公式。它们必须逐字等价，而"预览在右下、
 * 成片在中间"这类缺陷两边单独看都对，只有把成片和预览并排摆着才看得出来。
 * 现在两边都调 `boxOf()`：预览传 (100, 100) 拿百分比，导出传 (width, height) 拿像素，
 * 同一行代码算出同一个矩形。
 */
const PIP = require('./pip.json')

const PIP_ANCHORS = PIP.anchors
const PIP_DEFAULT_ANCHOR = PIP.defaultAnchor
const PIP_DEFAULT_SIZE = PIP.defaultSize
const PIP_MIN_SIZE = PIP.minSize
const PIP_MAX_SIZE = PIP.maxSize
const PIP_OFFSET_LIMIT = Number(PIP.offsetLimit) || 100
/* 边距（占画布宽的比例）：拖角缩放反算 offset 时要用，必须与 boxOf 取同一个数 */
const PIP_MARGIN = PIP.margin
/** 别名，读起来顺手的写法（`ANCHOR.find(...)`） */
const ANCHOR = PIP_ANCHORS

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** 锚点 key → 定义。写错/缺省一律退回默认锚点，不让画面飞到画布外 */
function anchorOf(key) {
  const hit = PIP_ANCHORS.find((item) => item.key === key)
  return hit || PIP_ANCHORS.find((item) => item.key === PIP_DEFAULT_ANCHOR)
}

/** 尺寸夹到合法区间（滑块越界、旧草稿里的脏值都在这里收口） */
function sizeOf(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return PIP_DEFAULT_SIZE
  return Math.min(PIP_MAX_SIZE, Math.max(PIP_MIN_SIZE, Math.round(n)))
}

/** 位移（画布宽/高的百分比）。缺省 0 —— 老草稿没有这个字段，必须退回"不偏移" */
function offsetOf(raw) {
  return {
    x: clamp(num(raw && raw.x, 0), -PIP_OFFSET_LIMIT, PIP_OFFSET_LIMIT),
    y: clamp(num(raw && raw.y, 0), -PIP_OFFSET_LIMIT, PIP_OFFSET_LIMIT)
  }
}

/**
 * 片段上的画中画参数。片段可能来自旧草稿（没有 pip 字段）或叠加轨以外的轨，
 * 一律给可用默认值。
 *
 * ⚠️ `size` 的缺省是 100（铺满），不是 30。旧草稿里**存过** 30 的仍然按 30 渲染 ——
 *    这里只影响"从没设过"的情况，不改用户已有的数据。
 */
function pipOf(clip) {
  const raw = clip && clip.pip
  return {
    anchor: anchorOf(raw && raw.anchor).key,
    size: sizeOf(raw && raw.size !== undefined ? raw.size : PIP_DEFAULT_SIZE),
    offset: offsetOf(raw && raw.offset)
  }
}

/**
 * 盒子的**定位基准**（左上角，还没减去自身尺寸）。
 *
 * ⚠️ 为什么返回的是"基准"而不是最终矩形：盒子**高度由素材比例决定**，构建时拿不到
 *    （预览要等 metadata、导出要等 `overlay_h`）。所以两边都先按锚点把"盒子左上角"
 *    放到对应位置，再按自身尺寸往回拉：
 *      · 预览 = `transform: translate(-fx×100%, -fy×100%)`（百分比按自身尺寸算）；
 *      · 导出 = 表达式里用 `overlay_w / overlay_h` 减掉。
 *    这样同一行公式在两个环境里都成立，谁都不用提前知道高度。
 *    早先试过"直接算出最终 left/top"，那需要高度 —— 于是 size=100 时盒子会整体偏出画布。
 *
 * @returns {{x:number,y:number,w:number,fx:number,fy:number,offX:number,offY:number}}
 */
function boxOf(raw, canvasW, canvasH) {
  const anchor = anchorOf(raw && raw.anchor)
  const size = sizeOf(raw && raw.size !== undefined ? raw.size : PIP_DEFAULT_SIZE)
  const off = offsetOf(raw && raw.offset)
  const W = Math.max(1, num(canvasW, 100))
  const H = Math.max(1, num(canvasH, 100))
  const m = PIP.margin
  const w = (W * size) / 100
  const offX = (off.x / 100) * W
  const offY = (off.y / 100) * H
  return {
    x: m * W + anchor.fx * (W - 2 * m * W) + offX,
    y: m * W + anchor.fy * (H - 2 * m * W) + offY,
    w,
    fx: anchor.fx,
    fy: anchor.fy,
    offX,
    offY
  }
}

module.exports = {
  PIP_ANCHORS,
  PIP_DEFAULT_ANCHOR,
  PIP_DEFAULT_SIZE,
  PIP_MIN_SIZE,
  PIP_MAX_SIZE,
  PIP_OFFSET_LIMIT,
  /** 边距（占画布宽的比例）。拖角缩放时要反算 offset，与 boxOf 用的是同一个数 */
  PIP_MARGIN,
  ANCHOR,
  anchorOf,
  sizeOf,
  offsetOf,
  pipOf,
  boxOf
}
