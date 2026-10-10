/**
 * 画中画（叠加轨）的几何 —— 预览这一侧。
 *
 * 数据来自 `shared/pip.json`（唯一真源），与主进程的 ffmpeg overlay 坐标**同一份**。
 * 两边各写一份必然对不上，而「预览里在右下、成片里跑到中间」恰恰是最难查的那一类：
 * 两边单独看都对，只有把成片和预览并排摆着才看得出来。
 *
 * 这里只做一件事：把 (锚点, 尺寸) 翻译成 CSS 的位置与宽度（都是百分比，
 * 于是窗口缩放与全屏自动等比，不用 JS 再算一次像素）。
 */
import PIP from '../shared/pip.json' with { type: 'json' }

export const PIP_ANCHORS = PIP.anchors
export const PIP_DEFAULT_ANCHOR = PIP.defaultAnchor
export const PIP_DEFAULT_SIZE = PIP.defaultSize
export const PIP_MIN_SIZE = PIP.minSize
export const PIP_MAX_SIZE = PIP.maxSize

/** 锚点 key → 定义。写错/缺省一律退回默认锚点，不让画面飞到画布外 */
export function pipAnchor(key) {
  const hit = PIP.anchors.find((item) => item.key === key)
  return hit || PIP.anchors.find((item) => item.key === PIP.defaultAnchor)
}

/** 尺寸夹到合法区间（滑块越界、旧草稿里的脏值都在这里收口） */
export function pipSize(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return PIP.defaultSize
  return Math.min(PIP.maxSize, Math.max(PIP.minSize, Math.round(n)))
}

/**
 * 片段上的画中画参数。
 * 片段可能来自旧草稿（没有 pip 字段）或叠加轨以外的轨，一律给可用默认值。
 */
export function pipOf(clip) {
  const raw = clip && clip.pip
  return {
    anchor: pipAnchor(raw && raw.anchor).key,
    size: pipSize(raw && raw.size !== undefined ? raw.size : PIP.defaultSize)
  }
}

/**
 * 预览里的画中画盒子。
 *
 * 单位用 **cqw / cqh**（画布宽高的百分之一），所以窗口缩放与全屏自动等比。
 * 前提是外面那层 `.canvas-pip-layer` 声明了 `container-type: size` —— 少了它
 * cqw 会退化成视口单位，画中画会跑到屏幕角上去，而且看起来只是"位置不对"。
 *
 * 定位手法：先按锚点把**盒子左上角**放到可用区里的对应点，再用
 * `translate(-fx%, -fy%)` 按自身尺寸拉回来。
 * 这样做的好处是**不需要知道画中画的高度** —— 高度由素材自身比例决定，
 * CSS 拿不到；而导出侧 ffmpeg 的 overlay 表达式里有 `overlay_w/overlay_h`，
 * 两侧公式因此能逐字对应（写成"减掉高度"的 CSS 就写不出来）。
 *
 * margin 统一用**画布宽度**（`m cqw`）做单位，与导出侧一致：宽屏画布上下的
 * 留白看起来会比左右大一点，这是刻意的 —— 宁可视觉上略不对称，
 * 也不能让预览与成片错位。
 */
export function pipBoxCss(anchorKey, size) {
  const anchor = pipAnchor(anchorKey)
  const m = PIP.margin * 100
  const w = pipSize(size)
  return {
    width: `${w}cqw`,
    left: `calc(${m}cqw + ${anchor.fx} * (100cqw - ${m * 2}cqw))`,
    top: `calc(${m}cqw + ${anchor.fy} * (100cqh - ${m * 2}cqw))`,
    transform: `translate(${(-anchor.fx * 100).toFixed(4)}%, ${(-anchor.fy * 100).toFixed(4)}%)`
  }
}
