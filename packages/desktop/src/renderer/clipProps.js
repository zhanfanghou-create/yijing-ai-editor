/**
 * 艺镜AI剪辑 · 片段属性剪贴板（纯逻辑）
 *
 * 「复制片段属性 / 粘贴片段属性」这一对动作的全部判定都在这里，App.jsx 只负责
 * 取当前选中、把补丁打回片段表。抽出来的理由与 trim.js 一样：
 * **这段逻辑错了不会报错**，只会让时间线悄悄变样 —— 而它最容易错的方式恰好是
 * "手滑把素材也搬过去了"，界面上一看是"这段片子的调色没变，画面却换成了另一条"。
 *
 * ── 三条设计决定（每条都对应一种错法） ──────────────────────────────
 *
 * ① **白名单，不是黑名单。**
 *    黑名单漏掉一个键就把 `url` / `start` 搬了过去 —— 那是"换素材 + 改位置"，
 *    比"少搬一个调色参数"严重一个量级。白名单漏一个只是少搬，看得见、改得回来。
 *
 * ② **不搬时间线占位**（`start` / `duration` / `offset` / `speed`）。
 *    `speed` 看着像属性，但它会通过 `speedPatch` 连带改变 `duration` 并**位移后续片段**
 *    （见 App.jsx 的 patchClip）—— 跨片段粘贴时那属于"改剪辑结构"，不是"套用外观"。
 *    用户按 Ctrl+Alt+V 的预期是"这条片子和那条长得一样"，不是"时间线重排一遍"。
 *
 * ③ **源上没有的外观键，要从目标上摘掉，而不是留着。**
 *    只覆盖不清理的话，"复制一条没调色的片段，粘到调过色的片段上"会得到
 *    "旧调色 + 新位置"这种谁都没预期的混合体。所以补丁分两半：`set` 与 `unset`，
 *    应用后的**外观键集合必须等于快照的键集合**（夹具钉的就是这条）。
 *
 * ⚠️ 值必须**深拷贝**。剪贴板里存的是状态对象的引用的话，接着去改目标片段的调色
 *    会把剪贴板内容一起改掉 —— 表现为"第二次粘贴的效果和第一次不一样"，
 *    而且中间没有任何操作提示。
 */

/**
 * 可搬运的属性，按「用户认知里的一组」划分。
 *
 * 键名必须与 Inspector.jsx / SidePanels.jsx 里 `onPatchClip(clip.id, { ... })`
 * 用的字段一字不差 —— 对不上不会报错，只会表现为"按了粘贴，什么都没发生"。
 */
export const ATTR_GROUPS = [
  {
    name: '画面',
    keys: ['posX', 'posY', 'scale', 'rotate', 'opacity', 'pan', 'crop', 'pip']
  },
  {
    name: '调色与特效',
    /* `hsl`（分区 HSL）必须在这一组里：它是纯调色属性，漏了之后"复制属性 → 粘贴"
       会把曲线、色轮、调色全带过去，唯独八个色带留在原地 —— 用户看不出来，
       只会在某天发现"粘贴过去的那段颜色不对"。 */
    keys: ['adjust', 'filter', 'filterIntensity', 'effects', 'looks', 'wheels', 'curves', 'hsl']
  },
  {
    name: '声音',
    keys: [
      'volume',
      'gain',
      'fadeIn',
      'fadeOut',
      'denoise',
      'audioDenoise',
      'beauty',
      'keepPitch',
      'pitch',
      'stabilize'
    ]
  },
  {
    /**
     * 文字/字幕的样式。
     *
     * `textOffset` 刻意**不在**里面：它和片段的 `offset`（源入点）在名字上几乎一样，
     * 一起搬会让"粘贴样式"变成"改时间"，而这正是 ② 要挡的那类事。
     */
    name: '文字样式',
    keys: [
      'textStyle',
      'textFont',
      'textColor',
      'textScale',
      'textAlign',
      'textAnchor',
      'textLineHeight',
      'textBgOn',
      'textBgColor',
      'textBgOpacity',
      'textBgPad',
      'textIn',
      'textInDur',
      'textOut',
      'textOutDur',
      'textLoop'
    ]
  },
  {
    name: '动画',
    keys: ['textAnim']
  }
]

/** 白名单的扁平形态（判定用） */
export const ATTR_KEYS = ATTR_GROUPS.reduce((all, group) => all.concat(group.keys), [])

const ATTR_SET = new Set(ATTR_KEYS)

/**
 * 明确**不搬**的字段，只作说明用（代码不读它）。
 * 列在这里是为了下次有人想"顺手把变速也带上"时，先看到为什么不行。
 */
export const NEVER_KEYS = [
  'id', 'assetId', 'url', 'path', 'name', 'kind', 'text', // 素材身份
  'track', 'start', 'duration', 'offset', 'speed', 'sourceDuration', // 时间线占位
  'z', 'group', 'compound', 'multicam', 'enabled' // 结构 / 开关
]

/** 深拷贝：只走 JSON 往返。这里所有值都是普通对象/数组/数字/字符串 */
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/**
 * 从片段上摘出可搬运的属性。
 *
 * 返回的 `keys` 只含**片段上真的存在**的键 —— 缺失与 `null` 不是一回事：
 * `pip: null` 是"明确没有画中画"，键不存在是"这条片段根本没有这个概念"。
 * 两者都按"没有"处理会把字幕的 `textBgOn: false` 与"没设过背景"混成一件事。
 *
 * @param {object} clip 片段
 * @returns {{keys: object, groups: string[], count: number}} 快照
 */
export function pickAttrs(clip) {
  const keys = {}
  if (!clip || typeof clip !== 'object') return { keys, groups: [], count: 0 }
  const groups = []
  for (const group of ATTR_GROUPS) {
    let hit = 0
    for (const key of group.keys) {
      if (!Object.prototype.hasOwnProperty.call(clip, key)) continue
      if (clip[key] === undefined) continue
      keys[key] = clone(clip[key])
      hit += 1
    }
    if (hit) groups.push(`${group.name} ${hit}`)
  }
  return { keys, groups, count: Object.keys(keys).length }
}

/**
 * 算出把快照套到目标片段上要打的补丁。
 *
 * 返回 `{ set, unset }`：
 *   · `set`   —— 要写入的键值（已深拷贝，调用方直接展开即可）
 *   · `unset` —— 目标上有、但快照里没有的**外观**键，要删掉
 * 快照为空时返回 null（调用方据此提示"剪贴板里没有可粘贴的属性"），
 * 而不是返回空补丁让它静默成功。
 *
 * @param {object} target 被粘贴的片段
 * @param {{keys: object}|null} snapshot pickAttrs 的产物
 * @returns {{set: object, unset: string[]}|null}
 */
export function pastePatch(target, snapshot) {
  const keys = snapshot && snapshot.keys
  if (!keys || !Object.keys(keys).length) return null
  const set = clone(keys)
  const unset = []
  if (target && typeof target === 'object') {
    for (const key of Object.keys(target)) {
      if (!ATTR_SET.has(key)) continue
      if (Object.prototype.hasOwnProperty.call(set, key)) continue
      unset.push(key)
    }
  }
  return { set, unset }
}

/**
 * 把补丁应用到片段上（纯函数，返回新对象）。
 *
 * 与 `pastePatch` 分开是因为**应用**这一步在 App.jsx 里要和撤销栈打交道，
 * 而"该改哪些键"必须能单独断言。这里不碰任何全局状态。
 */
export function applyAttrs(clip, patch) {
  if (!clip || !patch) return clip
  const next = { ...clip, ...patch.set }
  for (const key of patch.unset || []) delete next[key]
  return next
}

/** 给提示语用：`画面 3、调色与特效 2` */
export function describeAttrs(snapshot) {
  const groups = (snapshot && snapshot.groups) || []
  return groups.length ? groups.join('、') : '没有可搬运的属性'
}
