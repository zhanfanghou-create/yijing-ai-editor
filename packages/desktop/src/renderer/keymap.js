/**
 * 艺镜AI剪辑 · 快捷键系统
 *
 * 为什么要有这个文件：原先全工程只有 3 处键盘处理（Ctrl+S 散在 App.jsx、
 * Esc 散在 ui.jsx、Enter 散在 MediaPanel），既没法列出来给用户看，也没法改。
 * 参考客户端的设置里有独立的「快捷键」页、并且会提示键位「冲突」——
 * 这一层就是把它补成同样结构：
 *
 *   1. `ACTIONS` —— 一份**声明式**键位表（动作 id / 分组 / 中文名 / 默认键位 / 作用域）
 *   2. `comboOf()` —— 把 KeyboardEvent 归一化成 `Ctrl+Shift+Z` 这种可比较、可显示的串
 *   3. `findConflicts()` —— 同一个键位绑到两个动作时能报出来（对应参考的「冲突」）
 *   4. `loadKeymap()` / `saveKeymap()` —— 用户改过的键位持久化
 *
 * 这个模块**不依赖 DOM 也不依赖 React**，所以 `tools/keymap-selftest.mjs`
 * 可以直接在 node 里跑断言；只有真正的按键派发在 App.jsx 里。
 */

/* ------------------------------------------------------------------ *
 * 动作表
 * ------------------------------------------------------------------ */

/**
 * 分组的名字与顺序。分组名沿用参考客户端「快捷键」页的分类习惯
 * （编辑 / 播放 / 跳转 / 视图 / 项目）。
 */
export const GROUPS = ['编辑', '播放', '跳转', '视图', '项目']

/**
 * 所有可绑定动作。
 *
 * `scope` 的含义：
 *   - `global` —— 首页也能用（保存、打开设置）
 *   - `editor` —— 只在剪辑工作台生效
 * 派发时会先看 scope，避免在首页把 Space 吃掉。
 *
 * ⚠️ 只登记**真的实现了**的动作。不许为了「键位表好看」写一个没有处理函数的动作 ——
 * 那样用户按下去没反应，比没有这个快捷键更糟。
 */
export const ACTIONS = [
  /* 编辑 */
  { id: 'undo', group: '编辑', label: '撤销', keys: ['Ctrl+Z'], scope: 'editor' },
  { id: 'redo', group: '编辑', label: '重做', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], scope: 'editor' },
  { id: 'split', group: '编辑', label: '在播放头处分割', keys: ['Ctrl+B'], scope: 'editor' },
  { id: 'deleteClip', group: '编辑', label: '删除选中的片段', keys: ['Delete'], scope: 'editor' },
  { id: 'toggleDisableClip', group: '编辑', label: '停用 / 启用选中的片段', keys: ['V'], scope: 'editor' },
  { id: 'clearTimeline', group: '编辑', label: '清空时间线', keys: ['Ctrl+Shift+Delete'], scope: 'editor' },
  { id: 'toggleSnap', group: '编辑', label: '吸附开关', keys: ['N'], scope: 'editor' },

  /* 播放 */
  { id: 'playPause', group: '播放', label: '播放 / 暂停', keys: ['Space'], scope: 'editor' },
  { id: 'toStart', group: '播放', label: '回到开头', keys: ['Home'], scope: 'editor' },
  { id: 'toEnd', group: '播放', label: '跳到结尾', keys: ['End'], scope: 'editor' },

  /* 跳转 */
  { id: 'prevFrame', group: '跳转', label: '前一帧', keys: ['Left'], scope: 'editor' },
  { id: 'nextFrame', group: '跳转', label: '后一帧', keys: ['Right'], scope: 'editor' },
  { id: 'prevSecond', group: '跳转', label: '后退 1 秒', keys: ['Shift+Left'], scope: 'editor' },
  { id: 'nextSecond', group: '跳转', label: '前进 1 秒', keys: ['Shift+Right'], scope: 'editor' },

  /* 视图 */
  { id: 'zoomIn', group: '视图', label: '时间线放大', keys: ['Ctrl+='], scope: 'editor' },
  { id: 'zoomOut', group: '视图', label: '时间线缩小', keys: ['Ctrl+-'], scope: 'editor' },
  { id: 'zoomReset', group: '视图', label: '时间线缩放重置', keys: ['Ctrl+0'], scope: 'editor' },
  { id: 'fullscreen', group: '视图', label: '全屏预览', keys: ['F11'], scope: 'editor' },

  /* 项目 */
  { id: 'save', group: '项目', label: '保存草稿', keys: ['Ctrl+S'], scope: 'global' },
  { id: 'openSettings', group: '项目', label: '打开设置', keys: ['Ctrl+,'], scope: 'global' },
  { id: 'importMedia', group: '项目', label: '导入素材', keys: ['Ctrl+I'], scope: 'editor' },
  { id: 'exportVideo', group: '项目', label: '导出视频', keys: ['Ctrl+E'], scope: 'editor' }
]

/** 固定键位：不参与自定义，也不参与冲突检测（面板里会单独说明） */
export const FIXED_KEYS = [
  { label: '关闭弹窗 / 退出全屏', keys: ['Esc'], note: '固定键位，不可修改' }
]

/** 时间线缩放范围，与 Timeline.jsx 的滑块保持一致 */
export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 4

/** 预览帧率：逐帧跳转要用。与 Inspector 里展示的 30fps 一致 */
export const FRAME_RATE = 30

/* ------------------------------------------------------------------ *
 * 键位归一化
 * ------------------------------------------------------------------ */

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta']

/**
 * `event.code` → 显示名。
 *
 * 用 `code` 而不是 `key` 的原因：`key` 会随 Shift 变形（Ctrl+Shift+Z 的 key 是 'Z'，
 * 但 Ctrl+Shift+= 的 key 是 '+'），同一个物理键会算出两个串，冲突检测就废了。
 * `code` 是物理键位，不受修饰键影响。
 */
const CODE_LABEL = {
  Space: 'Space',
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Enter: 'Enter',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: 'Num+',
  NumpadSubtract: 'Num-'
}

/**
 * 纯修饰键：单独按下不构成组合。
 * 注意要同时覆盖 `key`（'Control'）和 `code`（'ControlLeft' / 'ShiftRight'）两种写法 ——
 * 只挡 `key` 时，一个真实的 Ctrl 按下会被算成 `Ctrl+ControlLeft` 这种鬼串。
 */
const BARE_MODS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead'])
const BARE_MOD_CODES = /^(Control|Shift|Alt|Meta)(Left|Right)?$/

function keyLabel(event) {
  const code = event.code || ''
  if (BARE_MOD_CODES.test(code)) return ''
  if (CODE_LABEL[code]) return CODE_LABEL[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  if (/^Numpad[0-9]$/.test(code)) return 'Num' + code.slice(6)
  // 没有 code（老环境 / 合成事件）时退回 key
  const key = event.key || ''
  if (!key || BARE_MODS.has(key)) return ''
  if (key === ' ') return 'Space'
  if (key === 'Escape') return 'Esc'
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * 把一次按键归一化成组合串，如 `Ctrl+Shift+Z`。
 *
 * 返回 `''` 表示这不是一个可绑定组合（只按了修饰键、或拿不到主键）。
 *
 * macOS：`Cmd` 一律记成 `Ctrl`。我们的键位表是跨平台共用一份的，
 * 把 Meta 折算掉才能让同一份配置在两端都命中；显示上也就不需要分叉。
 */
export function comboOf(event) {
  if (!event) return ''
  const key = keyLabel(event)
  if (!key) return ''
  const mods = []
  if (event.ctrlKey || event.metaKey) mods.push('Ctrl')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  return [...mods, key].join('+')
}

/**
 * 多字符键名的规范写法表。
 * `normalizeCombo('CTRL+ALT+DELETE')` 必须折成 `Ctrl+Alt+Delete`，否则
 * 用户手填的键位串和 `comboOf()` 自动生成的串对不上，配置会「看起来存了但不生效」。
 */
const CANONICAL = new Map()
for (const label of Object.values(CODE_LABEL)) CANONICAL.set(label.toLowerCase(), label)
for (let i = 1; i <= 24; i += 1) CANONICAL.set(`f${i}`, `F${i}`)
CANONICAL.set('escape', 'Esc')
CANONICAL.set('space', 'Space')
CANONICAL.set('spacebar', 'Space')
CANONICAL.set('del', 'Delete')
CANONICAL.set('arrowleft', 'Left')
CANONICAL.set('arrowright', 'Right')
CANONICAL.set('arrowup', 'Up')
CANONICAL.set('arrowdown', 'Down')

/** 修饰键的各种写法 → 规范修饰键名 */
const MOD_ALIAS = new Map([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['cmd', 'Ctrl'],
  ['command', 'Ctrl'],
  ['meta', 'Ctrl'],
  ['win', 'Ctrl'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift']
])

/** 组合串的规范形：修饰键顺序固定、多字符键名统一大小写，便于比较与去重 */
export function normalizeCombo(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''

  /**
   * `+` 本身也是分隔符，所以 `Ctrl++` 这种「Ctrl 加加号键」会被 split 吃掉。
   * 先摘掉结尾的 `++`，最后再补回 key='='。
   */
  let body = raw
  let trailingPlus = false
  if (body.endsWith('++')) {
    trailingPlus = true
    body = body.slice(0, -1)
  }

  const parts = body
    .split('+')
    .map((piece) => piece.trim())
    .filter(Boolean)
  if (!parts.length && !trailingPlus) return ''

  const mods = []
  let key = ''
  for (const part of parts) {
    const mod = MOD_ALIAS.get(part.toLowerCase())
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod)
      continue
    }
    if (part.length === 1) key = part.toUpperCase()
    else key = CANONICAL.get(part.toLowerCase()) || part
  }
  if (trailingPlus) key = '='
  if (!key) return ''

  // 按固定顺序排，'Ctrl+Shift+Z' 与 'Shift+Ctrl+Z' 归一成同一个串
  const sorted = MOD_ORDER.filter((mod) => mods.includes(mod))
  return [...sorted, key].join('+')
}

/* ------------------------------------------------------------------ *
 * 键位表读写与冲突检测
 * ------------------------------------------------------------------ */

/** 默认键位表：`{ 动作id: ['Ctrl+S'] }` */
export function defaultKeymap() {
  const map = {}
  for (const action of ACTIONS) map[action.id] = [...action.keys]
  return map
}

export const ACTION_BY_ID = new Map(ACTIONS.map((action) => [action.id, action]))

/**
 * 把外部数据（用户存过的键位）合并进默认表。
 *
 * 规则：只认 `ACTIONS` 里存在的 id（这样删掉一个动作后旧配置不会残留）；
 * 键位串逐个归一化，同一动作内去重；非法/空的键位串丢掉。
 * 某一个动作的键位被清空是**合法**的（等于取消绑定）。
 */
export function mergeKeymap(raw) {
  const map = defaultKeymap()
  if (!raw || typeof raw !== 'object') return map
  for (const action of ACTIONS) {
    if (!(action.id in raw)) continue
    const value = raw[action.id]
    if (!Array.isArray(value)) continue
    const seen = new Set()
    const list = []
    for (const item of value) {
      const combo = normalizeCombo(item)
      if (!combo || seen.has(combo)) continue
      seen.add(combo)
      list.push(combo)
    }
    map[action.id] = list
  }
  return map
}

/**
 * 冲突检测：同一个组合串被两个（或更多）动作占用。
 *
 * 这是参考客户端「快捷键」页会报的那件事（文案表里有「冲突」一条）。
 * 一个动作自己绑了两个不同键位不算冲突，同一键位绑给两个动作才算。
 */
export function findConflicts(keymap) {
  const owner = new Map()
  for (const action of ACTIONS) {
    for (const combo of keymap[action.id] || []) {
      if (!owner.has(combo)) owner.set(combo, [])
      const list = owner.get(combo)
      if (!list.some((item) => item.id === action.id)) list.push(action)
    }
  }
  return [...owner.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([combo, list]) => ({ combo, actions: list }))
}

/** 冲突涉及的组合串集合，便于界面高亮 */
export function conflictCombos(keymap) {
  const set = new Set()
  for (const item of findConflicts(keymap)) set.add(item.combo)
  return set
}

const STORAGE_KEY = 'yjai.keymap'

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    // 隐私模式 / 权限被拒时 localStorage 取值本身就会抛，不能让它拖垮启动
    return null
  }
}

/** 读用户键位；任何异常都退回默认表（键盘配置坏了不该让软件起不来） */
export function loadKeymap() {
  const box = storage()
  if (!box) return defaultKeymap()
  try {
    const text = box.getItem(STORAGE_KEY)
    if (!text) return defaultKeymap()
    return mergeKeymap(JSON.parse(text))
  } catch {
    return defaultKeymap()
  }
}

/** 存用户键位；失败只返回 false，不抛 */
export function saveKeymap(keymap) {
  const box = storage()
  if (!box) return false
  try {
    box.setItem(STORAGE_KEY, JSON.stringify(keymap))
    return true
  } catch {
    return false
  }
}

/** 清掉自定义键位，回到默认 */
export function clearKeymap() {
  const box = storage()
  if (!box) return false
  try {
    box.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 派发辅助
 * ------------------------------------------------------------------ */

/**
 * 事件是否发生在可输入控件里。
 *
 * 在输入框里按 Space / 方向键必须还是「打字」，不能被时间线快捷键抢走 ——
 * 这是这类全局快捷键最典型的踩坑点。
 */
export function isTypingTarget(node) {
  if (!node || typeof node !== 'object') return false
  const tag = String(node.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (node.isContentEditable) return true
  return false
}

/**
 * 在当前键位表下查这个组合串要执行哪个动作。
 *
 * 同一个串理论上只应有一个动作（冲突会由 `findConflicts` 报出）；
 * 真冲突时按 `ACTIONS` 里的先后顺序取第一个，保证行为确定、不随对象键序漂移。
 */
export function resolveAction(combo, keymap) {
  if (!combo) return ''
  for (const action of ACTIONS) {
    if ((keymap[action.id] || []).includes(combo)) return action.id
  }
  return ''
}

/** 把组合串拆成一个个按键片段，给界面画 kbd 小方块用 */
export function comboParts(combo) {
  return String(combo || '').split('+').filter(Boolean)
}

/** 逐帧步进：把秒数吸附到帧网格上，避免浮点误差累积（0.0333… 一直加会漂） */
export function stepFrame(seconds, direction, rate = FRAME_RATE) {
  const fps = Number(rate) > 0 ? Number(rate) : FRAME_RATE
  const frame = Math.round((Number(seconds) || 0) * fps)
  const next = frame + (direction < 0 ? -1 : 1)
  return Math.max(0, next / fps)
}

export function clampZoom(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(num.toFixed(2))))
}
