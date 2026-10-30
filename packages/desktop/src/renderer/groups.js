/**
 * 艺镜AI剪辑 · 组合（逻辑成组，纯逻辑）
 *
 * 「组合」与「复合片段」是**两件完全不同**的事，名字像、快捷键也像（Alt+G / Ctrl+G），
 * 混起来的代价是数据模型被污染：
 *
 *   复合片段 = 收成**一个**片段：内部变成子片段，时间线上只剩一段，
 *              移动/裁剪/变速都作用于整体，渲染时展开（见 shared/compound.js）。
 *   组合     = 只是**一起选中 / 一起移动 / 一起删**：片段仍然各管各的，
 *              轨道、时长、渲染全不变，只是在同一根轨或不同轨上被"绑"成一个集合。
 *
 * 本文件只提供三件最容易被写错的事：
 *   ① 组合的成员怎么找（`groupIdsOf`）——按 `clip.group` 这个**扁平字段**，
 *      不维护成员表。理由与 trim.js 里 `linkedIds` 按 assetId 分组一样：
 *      成员表会过期（片段被删后留下幽灵 id），下一次拖动就"少带一条、还不报错"。
 *   ② 组号怎么打（`withGroup`）——**必须覆盖旧组号**。允许一条片段同时属于两个组
 *      等于允许"拖它一下，两组都动"，而这种错误在界面上表现为"画面莫名多移了一段"。
 *   ③ 解组怎么清（`clearGroupOf`）——只清**这一组**的成员，不能顺手把别的组也清了。
 *
 * 为什么值得单开一个文件而不是塞进 App.jsx：这三件事都可以在 node 里直接断言
 * （见 `tools/groups-selftest.mjs`），塞进组件里就只能靠手点，而手点是没人会回归的。
 */

/** 组合最少要几段：一段的"组"没有任何意义，只会让选中集合变成隐形的 */
export const MIN_GROUP_SIZE = 2

/**
 * 找到 `clipId` 所属组合的全部成员 id（按片段表顺序）。
 *
 * 不在任何组合里 ⇒ 返回 `[clipId]`（**不是空数组**）：
 * 调用方几乎都是"把这个集合当移动/删除的作用域"，返回空数组会让"单独一条片段"
 * 走到"什么都不动"的分支上去。
 *
 * @param {Array} clips 全部片段
 * @param {string} clipId 片段 id
 * @returns {string[]} 成员 id
 */
export function groupIdsOf(clips, clipId) {
  const list = Array.isArray(clips) ? clips : []
  const target = list.find((item) => item.id === clipId)
  if (!target) return []
  if (!target.group) return [target.id]
  const ids = list.filter((item) => item.group === target.group).map((item) => item.id)
  return ids.length ? ids : [target.id]
}

/** 片段属于哪个组合（没有则空串） */
export function groupOf(clips, clipId) {
  const list = Array.isArray(clips) ? clips : []
  const target = list.find((item) => item.id === clipId)
  return (target && target.group) || ''
}

/**
 * 把 `ids` 打成一个新组合，返回新的片段表。
 *
 * `groupId` 由调用方发号（App.jsx 的 `nextId('grp')`）—— 纯函数里造 id 会让
 * 同一份输入产生不同输出，夹具就没法比对了。
 *
 * 少于 `MIN_GROUP_SIZE` 段时**原样返回**（引用相等），调用方据此判断"没成组"，
 * 不要在这一层抛错或弹提示：这一层不认识 toast。
 *
 * 已在别的组里的片段会被**改挂**到新组（旧组若因此只剩一段，那段自动散组，
 * 因为 `groupIdsOf` 只认成员集合、不认组号是否还在别的片段上残留）。
 *
 * @param {Array} clips 全部片段
 * @param {string[]} ids 要成组的片段 id
 * @param {string} groupId 新组号
 * @returns {Array} 新片段表（未成组时返回原数组）
 */
export function withGroup(clips, ids, groupId) {
  const list = Array.isArray(clips) ? clips : []
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))
  if (wanted.size < MIN_GROUP_SIZE) return list
  if (!groupId) return list
  const present = list.filter((item) => wanted.has(item.id))
  if (present.length < MIN_GROUP_SIZE) return list
  /* 组内不允许跨"锁定轨"的片段混在一起吗？——不禁止。组合只是逻辑集合，
     锁定拦的是**结构性编辑**（删/改/切），一起"被选中"不属于结构性编辑。 */
  return list.map((item) => (wanted.has(item.id) ? { ...item, group: groupId } : item))
}

/**
 * 解开 `clipId` 所在的组合，返回 `{ clips, count }`。
 *
 * `count` 是**被解开的成员数**（0 = 本来就不在组里），提示语与闸门都用它 ——
 * 拿"片段表长度差"去反算会漏掉"本来只剩一段的残组"。
 *
 * @param {Array} clips 全部片段
 * @param {string} clipId 组内任一片段
 * @returns {{clips: Array, count: number}}
 */
export function clearGroupOf(clips, clipId) {
  const list = Array.isArray(clips) ? clips : []
  const target = list.find((item) => item.id === clipId)
  if (!target || !target.group) return { clips: list, count: 0 }
  const tag = target.group
  let count = 0
  const next = list.map((item) => {
    if (item.group !== tag) return item
    count += 1
    const copy = { ...item }
    delete copy.group
    return copy
  })
  return { clips: next, count }
}

/**
 * 组合成员一起平移时，除被拖那一条以外的成员 id。
 *
 * 单独给这个函数是为了让 App.jsx 的 dragClip 只需要"再传一批 id"给
 * `linkMovePatches`，而**不必再写一遍钳位算术** —— 两份钳位必然会在
 * "往左拖到 0"这一刻算出两个不同的位移，表现是组员之间静默错位。
 *
 * @param {Array} clips 全部片段
 * @param {string} clipId 被拖的片段
 * @returns {string[]} 除自身外的组员 id
 */
export function groupPeers(clips, clipId) {
  return groupIdsOf(clips, clipId).filter((id) => id !== clipId)
}
