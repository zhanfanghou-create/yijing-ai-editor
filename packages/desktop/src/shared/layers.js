/**
 * 画面层级（自由层级）—— 同一条轨道内**谁压住谁**的唯一真源。
 *
 * 为什么需要它：叠加轨（画中画）以前只有"起点靠后的在上"这一条规则
 * （见 composite.layerOrder 的历史实现）。那套规则在"两段画中画完全重叠"时
 * 等于**没得选** —— 用户想让 A 压住 B，唯一办法是把 A 往后拖（改时间），
 * 而画面层级与时间先后本来是两件事。参考客户端里这两件事是分开的：
 * 时间线位置决定"什么时候出现"，层级决定"压住谁"。
 *
 * 口径（预览与导出必须同一份，否则"预览里 A 在上、成片里 B 在上"，
 * 两边单独看都没错，合起来是错的）：
 *   · `clip.z` 是**同轨内的层号**，大的在上；缺省 0；
 *   · 层号相同时退回旧规则（起点靠后的在上，再相同按创建序号），
 *     所以**老草稿不动一个字段，层叠顺序与改动前逐帧一致**；
 *   · z 只在本轨内比较：叠加轨整条本来就压在视频轨之上（DOM 顺序与
 *     ffmpeg 的 overlay 链顺序都是这样），跨轨不靠 z 表达。
 *
 * ⚠️ 本文件是 CJS：预览（ESM）与主进程（CJS）都要 require 同一份比较函数。
 *    主进程 require 不了渲染层的 ESM 模块，所以共享模块一律放 shared/ 并写成 CJS，
 *    同时**必须**加进 packages/desktop/vite.config.mjs 的 commonjsOptions.include，
 *    漏了会在渲染层 import 到空对象（`undefined is not a function`，构建不报错）。
 */

/** 层号的上下限：够用（±20 层）且能把脏数据挡住 —— NaN/Infinity 一律回落 0 */
const Z_LIMIT = 20

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 读层号。缺省 0，夹进 [-20, 20] 且取整。
 * 所有读 `clip.z` 的地方都必须走这里，不许直接 `clip.z || 0`
 * （`|| 0` 会把负数 -3 之外的 0 都当缺省，但更重要的是 NaN 会一路传进比较函数，
 *  让 Array.sort 的比较结果变成随机 —— 表现是"顺序偶尔不一样"，极难复现）。
 */
function readZ(clip) {
  const raw = Number(clip && clip.z)
  /* NaN（脏数据 / 老字段）与 ±Infinity 要分开处理：
     NaN 一律当缺省 0；无穷大夹到上下限 —— 都用 `num()` 会被统一当成 0，
     于是"写了个极大值想放最上层"变成"什么都没写"，而界面上看不出任何异常。 */
  if (Number.isNaN(raw)) return 0
  const rounded = Math.round(raw)
  if (rounded > Z_LIMIT) return Z_LIMIT
  if (rounded < -Z_LIMIT) return -Z_LIMIT
  return Number.isFinite(rounded) ? rounded : 0
}

/** 片段 id 的尾号（`clip_x_10` 要排在 `clip_x_2` 之后，字典序会反过来） */
function idSeq(id) {
  const matched = /_(\d+)$/.exec(String(id == null ? '' : id))
  return matched ? Number(matched[1]) : Number.NaN
}

/**
 * 层叠比较器：底 → 顶。
 *
 * 先比 z，再比起点（后摆上去的压住先摆的），最后比创建序号。
 * 第二、三级就是改动前的规则 —— 保留它才能让老草稿零改动地保持原样。
 */
function compareLayers(a, b) {
  const za = readZ(a)
  const zb = readZ(b)
  if (za !== zb) return za - zb
  const delta = num(a && a.start) - num(b && b.start)
  if (Math.abs(delta) > 1e-6) return delta
  const sa = idSeq(a && a.id)
  const sb = idSeq(b && b.id)
  if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb
  const strA = String((a && a.id) == null ? '' : a.id)
  const strB = String((b && b.id) == null ? '' : b.id)
  return strA < strB ? -1 : strA > strB ? 1 : 0
}

/** 同一轨道的片段，按底 → 顶排好（返回新数组，不改入参） */
function sameTrackOrdered(clips, track) {
  return (Array.isArray(clips) ? clips : [])
    .filter((clip) => clip && clip.track === track)
    .slice()
    .sort(compareLayers)
}

/**
 * 上移 / 下移一层。
 *
 * 返回值是**补丁数组**（`[{ id, z }]`），不是整份片段表：
 * App 用的是"按 id 打补丁"的更新路径（`onDragClip` 同款），
 * 返回整份表反而要在这里重新造一遍所有片段对象。
 *
 * 实现上**重新编号**（把该轨所有片段的 z 写成 0..n-1），而不是"z += 1"：
 *   · `z += 1` 在两段本来就同 z 时没有任何效果（用户点了没反应）；
 *   · 在 z 相差很大的历史数据上要加好几次才动一格。
 * 重新编号后"点一次动一格"永远成立，且同一轨内 z 从此唯一、顺序稳定。
 *
 * @param {Array} clips 全部片段
 * @param {string} id 目标片段
 * @param {number} dir +1 = 上移（更靠上/更晚被画上去）；-1 = 下移
 * @returns {Array<{id:string,z:number}>} 需要写回的补丁（无需移动时为空数组）
 */
function moveLayer(clips, id, dir) {
  const list = Array.isArray(clips) ? clips : []
  const target = list.find((clip) => clip && clip.id === id)
  if (!target) return []
  const step = dir > 0 ? 1 : -1
  const ordered = sameTrackOrdered(list, target.track)
  const from = ordered.findIndex((clip) => clip.id === id)
  const to = from + step
  if (from < 0 || to < 0 || to >= ordered.length) return []
  const next = ordered.slice()
  const moved = next.splice(from, 1)[0]
  next.splice(to, 0, moved)
  const patches = []
  next.forEach((clip, index) => {
    if (readZ(clip) !== index) patches.push({ id: clip.id, z: index })
  })
  return patches
}

/** 目标片段在这一轨里还能不能继续上移 / 下移（菜单项置灰用同一份判断） */
function canMoveLayer(clips, id, dir) {
  const list = Array.isArray(clips) ? clips : []
  const target = list.find((clip) => clip && clip.id === id)
  if (!target) return false
  const ordered = sameTrackOrdered(list, target.track)
  const from = ordered.findIndex((clip) => clip.id === id)
  const to = from + (dir > 0 ? 1 : -1)
  return from >= 0 && to >= 0 && to < ordered.length
}

/**
 * 这一轨按层叠顺序排好的 id 列表（取证 / 闸门用）。
 * 预览侧读 DOM 顺序、导出侧读 overlay 链顺序，两边都应该等于这个列表。
 */
function layerStack(clips, track) {
  return sameTrackOrdered(clips, track).map((clip) => clip.id)
}

module.exports = {
  Z_LIMIT,
  readZ,
  compareLayers,
  moveLayer,
  canMoveLayer,
  layerStack
}
