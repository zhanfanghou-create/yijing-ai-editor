/**
 * 画中画（叠加轨）的几何 —— 预览这一侧。
 *
 * 换算主体在 `shared/pip.js`（预览与导出**同一份**）：这里只把它的结果翻译成 CSS。
 * 以前两边各写一份公式，而"预览里在右下、成片里跑到中间"恰恰是最难查的那一类：
 * 两边单独看都对，只有把成片和预览并排摆着才看得出来。
 */
import {
  PIP_ANCHORS,
  PIP_DEFAULT_ANCHOR,
  PIP_DEFAULT_SIZE,
  PIP_MARGIN,
  PIP_MAX_SIZE,
  PIP_MIN_SIZE,
  PIP_OFFSET_LIMIT,
  anchorOf,
  boxOf,
  offsetOf,
  pipOf,
  sizeOf
} from '../shared/pip.js'

export {
  PIP_ANCHORS,
  PIP_DEFAULT_ANCHOR,
  PIP_DEFAULT_SIZE,
  PIP_MARGIN,
  PIP_MAX_SIZE,
  PIP_MIN_SIZE,
  PIP_OFFSET_LIMIT,
  offsetOf,
  pipOf,
  sizeOf
}

/** 锚点 key → 定义。写错/缺省一律退回默认锚点，不让画面飞到画布外 */
export function pipAnchor(key) {
  return anchorOf(key)
}

/** 尺寸夹到合法区间（滑块越界、旧草稿里的脏值都在这里收口） */
export function pipSize(value) {
  return sizeOf(value)
}

/**
 * 预览里的画中画盒子（CSS）。
 *
 * 水平方向一律用**百分比**（相对容器宽度）；纵向要拆成两段：
 *   · "居中权重 × 画布高度" 这一段用 `%`（`top` 的百分比本来就按高度算）；
 *   · "边距"与"位移"这两段必须按**画布宽度**算——所以用 `cqw`（画布宽的 1%）。
 *
 * ⚠️ 为什么纵向边距不能用 `%`：`top: X%` 的 X 是按**高度**算的，而几何里
 *    （`shared/pip.js` 的 boxOf、以及导出侧 `render.js` 的 padX/padY 表达式）
 *    边距是 `margin × 画布宽度`。16:9 画布上两者差 3%×宽 − 3%×高 ≈ 7px，
 *    症状是"拖角缩放时被钉住的那个角仍然每次横移几像素"，以及
 *    "预览里的纵向位置和成片差一点点" —— 两个都不报错，只有量像素才看得见。
 *    `.canvas-frame` 带 `container-type: size`，cqw 在这里就是画布宽的 1%。
 *
 * ⚠️ 高度**不写**（交给素材自己按比例撑）：写了 height 就等于"竖屏素材进横屏画布
 *    也只能占中间一条"，永远铺不满。铺满靠的是 size=100 时宽度打满 + 溢出被裁。
 *    导出侧同一个口径：`scale=w:-2` 只定宽，高度等比。
 */
export function pipBoxCss(anchorKey, size, offset) {
  /* 传 (100, 100)：x 是"宽度的百分比"、y 是"高度的百分比"、w 是"宽度的百分比" */
  const box = boxOf({ anchor: anchorKey, size, offset }, 100, 100)
  const mPct = PIP_MARGIN * 100
  /* top = m×宽 + fy×(高 − 2·m×宽) + 位移，全部展开成 calc 里合法的两项：
       fy×100%  → 权重 × 高度
       m − 2·m·fy  → 边距那一段（cqw = 宽度百分比）
     位移本身记的就是"画布高度的百分比"，直接用 %（与导出侧 offY 的口径一致）。 */
  const marginCqw = mPct - 2 * mPct * box.fy
  return {
    width: `${box.w}%`,
    left: `${box.x}%`,
    top: `calc(${(box.fy * 100).toFixed(4)}% + ${marginCqw.toFixed(4)}cqw + ${box.offY}%)`,
    /* 按自身尺寸往回拉，把"盒子左上角"变成"锚点对齐"。
       百分比 translate 相对**自身尺寸**（宽/高），与锚点语义正好匹配，
       而且不需要提前知道盒子高度 —— 高度是素材撑出来的。 */
    transform: `translate(${(-box.fx * 100).toFixed(4)}%, ${(-box.fy * 100).toFixed(4)}%)`
  }
}
