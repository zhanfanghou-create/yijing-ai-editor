/**
 * 时间线标记（用户标记）的纯逻辑。
 *
 * 标记本身很简单，但有三件事一旦写错就**看不出来**，所以单独拿出来能被断言：
 *
 *   1. **排序与去重**：用户是先跳到 12 秒打一个、再回到 3 秒打一个的。
 *      不排序的话「上一个/下一个标记」会跳反；不去重的话同一处会叠出两个点，
 *      视觉上是一个，跳的时候要按两次。
 *   2. **夹取**：播放头可能在负值（拖动时的中间态）或超出时长（缩放后残留），
 *      直接存下去就得到一个永远到不了的标记。
 *   3. **就近吸附**：在已经打过标记的地方再点一次应当**取消**它，
 *      而不是在它旁边 0.01 秒处再打一个（两个点重叠，看着像"删不掉"）。
 *
 * ⚠️ 标记**不进成片**，所以不需要和主进程共用（不像 speed / aspect 那样有两侧换算）。
 *    它是编辑器状态，只在渲染层闭环 —— 这也是它能放在 renderer 而不是 shared 的理由。
 */

/** 两个标记的"同一处"阈值（秒）。约等于 4 帧，比手抖能引起的偏差大、比一个镜头短 */
export const MARKER_MERGE_SECONDS = 0.12

/**
 * 规范化标记列表：过滤非数字 → 夹到 ≥0 → 排序 → 合并过近的点。
 *
 * @param {number[]} list 原始列表（可能来自 settings，什么脏数据都有）
 * @returns {number[]} 干净的、升序的、两两间距 > MARKER_MERGE_SECONDS 的列表
 */
export function normalizeMarkers(list) {
  if (!Array.isArray(list)) return []
  const clean = []
  for (const item of list) {
    /* ⚠️ 必须先挡 null：`Number(null)` 是 **0**（不是 NaN），
       所以一个 null 会静默变成一个"打在 0 秒的标记"，而且永远删不掉
       （它看起来就像播放头位置的那根线）。 */
    if (item === null || item === undefined) continue
    const value = Number(item)
    if (!Number.isFinite(value) || value < 0) continue
    clean.push(value)
  }
  clean.sort((a, b) => a - b)
  const out = []
  for (const value of clean) {
    if (!out.length || value - out[out.length - 1] > MARKER_MERGE_SECONDS) out.push(value)
  }
  return out
}

/**
 * 找一个离 `at` 足够近、可以直接取消的标记下标。
 *
 * @returns {number} 下标；没有则 -1
 */
export function markerIndexAt(list, at) {
  const t = Number(at)
  if (!Array.isArray(list) || !Number.isFinite(t)) return -1
  for (let i = 0; i < list.length; i += 1) {
    if (Math.abs(Number(list[i]) - t) <= MARKER_MERGE_SECONDS) return i
  }
  return -1
}

/**
 * 「跳到上/下一个标记」。
 *
 * 语义按剪辑软件的通例：**严格大于/小于**当前播放头，不是"最近的一个" ——
 * 否则连按两下会原地不动（播放头正好压在标记上时，最近的就是它自己）。
 *
 * @param {number[]} list 标记列表（应已 normalize）
 * @param {number} playhead 当前播放头（秒）
 * @param {1|-1} direction 1 = 下一个，-1 = 上一个
 * @returns {number|null} 目标时刻；没有更远的标记时返回 null（调用方保持原位）
 */
export function stepMarker(list, playhead, direction) {
  if (!Array.isArray(list) || !list.length) return null
  const t = Number(playhead) || 0
  const eps = 1e-4
  if (direction >= 0) {
    for (const value of list) if (value > t + eps) return value
    return null
  }
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] < t - eps) return list[i]
  return null
}
