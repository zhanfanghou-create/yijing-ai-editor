/**
 * 时间线导航的纯逻辑：剪切点表、按剪切点步进、以及「适配全片」要缩到多少。
 *
 * 为什么单独抽出来：
 *  1. 这三件事都是**算得出来但看不见**的 —— 切点算错只表现为"按一下上箭头跑到奇怪的地方"，
 *     适配算错只表现为"按了没反应"。所以它们必须有 node 侧自证（tools/timeline-nav-selftest.mjs），
 *     不能只挂在 React 组件里靠手点。
 *  2. 组件里读 DOM（lane.clientWidth）那部分只负责"把量到的数交进来"，判断留在这里。
 *
 * 不依赖 DOM，也不依赖 React。
 */

/** 半帧容差：切点在帧边界上，浮点累加会让「正好相等」变成「差 1e-13」 */
export const CUT_TOL = 1 / 120

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** 只保留 3 位小数再入表：同一秒上的两个切点不该算成两个（否则按一下会"跳两下"） */
const q = (v) => Math.round(v * 1000) / 1000

/**
 * 全部剪切点（升序去重）。
 *
 * 取每个**有效片段**的 start 与 start+duration；`duration <= 0` 的片段跳过 ——
 * 零长片段在时间线上本来就不占位置，把它当切点会让 ↑/↓ 连按两下都不动。
 * 0 秒不作为切点：起点用 Home 回，不需要再占一个「切点」位。
 */
export function cutPoints(clips) {
  const set = new Set()
  for (const clip of clips || []) {
    if (!clip) continue
    const start = num(clip.start)
    const duration = num(clip.duration)
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) continue
    if (start > CUT_TOL) set.add(q(start))
    set.add(q(start + duration))
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * 从 `at` 出发找相邻剪切点。`dir > 0` 往后，否则往前。
 * 没有就返回 `null`（**不要**退回到 0 或末尾 —— 那会让「到头了」变成「偷偷跳走」）。
 *
 * 正好站在切点上时，往后要跳到**下一个**，不是原地：这就是容差的用处。
 */
export function stepCut(clips, at, dir) {
  const list = cutPoints(clips)
  const now = Number.isFinite(num(at)) ? num(at) : 0
  if (dir > 0) {
    for (const point of list) if (point > now + CUT_TOL) return point
    return null
  }
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] < now - CUT_TOL) return list[i]
  return null
}

/** 片段表真正占到的时间末点（不含刻度余量） */
export function contentEnd(clips) {
  return (clips || []).reduce((max, clip) => {
    if (!clip) return max
    const start = num(clip.start)
    const duration = num(clip.duration)
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return max
    return Math.max(max, start + duration)
  }, 0)
}

/**
 * 「适配全片」的缩放比例。
 *
 * 返回 `null` 表示**量不到，别动** —— 三种情况都算量不到：
 *   · 视口宽度还没量出来（首帧、面板折叠中）；
 *   · 时间线是空的（没有内容可适配，此时把 zoom 改成 0.05 只会让用户以为界面坏了）；
 *   · 输入不是数。
 * 调用方拿到 null 就保持原状，这比"缩到一个猜出来的值"安全得多。
 *
 * `pad` 是右侧留白：贴到最右边时最后一段的把手会被视口边缘切掉一半。
 */
export function fitZoom(endSeconds, viewportWidth, baseDps, { min, max, pad = 48, minUsable = 120 } = {}) {
  const usable = num(viewportWidth) - num(pad)
  const span = num(endSeconds) * num(baseDps)
  const lo = num(min)
  const hi = num(max)
  if (!Number.isFinite(usable) || usable < num(minUsable)) return null
  if (!Number.isFinite(span) || span <= 0) return null
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null
  return Math.min(hi, Math.max(lo, Math.round((usable / span) * 1000) / 1000))
}
