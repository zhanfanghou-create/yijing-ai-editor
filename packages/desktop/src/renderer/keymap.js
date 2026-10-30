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
  /* 联动 / 组合 / 属性剪贴板：命令名沿用参考客户端的具名命令（`linkage`、
     `segmentCombination`、`copySegAttribute`…），这样"自定义快捷键"里显示的名字
     与行业方案（FCP / PR）能对得上，迁移过来的人不用重新学一遍。
     ⚠️ 这四个 G 系命令是**两对**，语义完全不同，键位也必须成对区分：
       · 组合 Alt+G / 解除组合 Alt+Shift+G —— 只是"一起选中、一起动"，还是几段；
       · 复合 Ctrl+G / 解除复合 Ctrl+Shift+G —— 收成**一段**（渲染成一个整体）。 */
  { id: 'linkage', group: '编辑', label: '主轨联动开关（同源音画一起动）', keys: ['Ctrl+L'], scope: 'editor' },
  { id: 'segmentCombination', group: '编辑', label: '新建组合', keys: ['Alt+G'], scope: 'editor' },
  { id: 'segmentRemoveCombination', group: '编辑', label: '取消组合', keys: ['Alt+Shift+G'], scope: 'editor' },
  { id: 'segmentMakeGroup', group: '编辑', label: '新建复合片段', keys: ['Ctrl+G'], scope: 'editor' },
  { id: 'segmentRemoveGroup', group: '编辑', label: '解除复合片段', keys: ['Ctrl+Shift+G'], scope: 'editor' },
  { id: 'copySegAttribute', group: '编辑', label: '复制选中片段的属性', keys: ['Ctrl+Alt+C'], scope: 'editor' },
  { id: 'pasteSegAttribute', group: '编辑', label: '把属性粘贴到选中片段', keys: ['Ctrl+Alt+V'], scope: 'editor' },
  { id: 'batchCut', group: '编辑', label: '在播放头处分割所有轨道', keys: ['Ctrl+Shift+K'], scope: 'editor' },
  /* 用户标记：M 打点/取消，Ctrl+← → 在标记之间跳。
     跳转键用 Ctrl+方向 而不是 Shift+方向：后者已经是"后退/前进 1 秒"，
     让"跳一秒"和"跳一个标记"共用同一组键只会让人分不清按了几次。 */
  { id: 'toggleMarker', group: '编辑', label: '在播放头处打 / 取消标记', keys: ['M'], scope: 'editor' },
  /* 时间区域：I / O 是剪辑台上的通用词汇（入点 / 出点），Shift+Delete 是"连时间一起删"。
     这三条都只改选中的**区间**，不动片段选中 —— 与「删除选中片段」是两件事，
     所以键位也必须分开（同一个 Delete 既要删片段又要删区间，按下就不知道要删哪个）。 */
  { id: 'regionIn', group: '编辑', label: '标时间区域入点', keys: ['I'], scope: 'editor' },
  { id: 'regionOut', group: '编辑', label: '标时间区域出点', keys: ['O'], scope: 'editor' },
  { id: 'regionDelete', group: '编辑', label: '删除时间区域（后面内容前移）', keys: ['Shift+Delete'], scope: 'editor' },

  /* 播放 */
  { id: 'playPause', group: '播放', label: '播放 / 暂停', keys: ['Space'], scope: 'editor' },
  /* 三键播放（J / K / L）：剪辑台上左手三指的标准落点 —— J 往回、K 停、L 往前。
     它与「空格」的区别不是顺手，而是**语义**：空格是"切换"，J / K / L 是"指定"。
     反复回看某一刀时，空格要先想一下"现在是播还是停"，K 按下去必定停。
     倒放的取舍见 shared/reverse.js：画面靠往回 seek，音轨静音（浏览器没有负向倍速）。 */
  { id: 'playForward', group: '播放', label: '正向播放', keys: ['L'], scope: 'editor' },
  { id: 'pause', group: '播放', label: '暂停', keys: ['K'], scope: 'editor' },
  { id: 'playBackward', group: '播放', label: '倒放', keys: ['J'], scope: 'editor' },
  { id: 'toStart', group: '播放', label: '回到开头', keys: ['Home'], scope: 'editor' },
  { id: 'toEnd', group: '播放', label: '跳到结尾', keys: ['End'], scope: 'editor' },

  /* 跳转 */
  { id: 'prevFrame', group: '跳转', label: '前一帧', keys: ['Left'], scope: 'editor' },
  { id: 'nextFrame', group: '跳转', label: '后一帧', keys: ['Right'], scope: 'editor' },
  { id: 'prevSecond', group: '跳转', label: '后退 1 秒', keys: ['Shift+Left'], scope: 'editor' },
  { id: 'nextSecond', group: '跳转', label: '前进 1 秒', keys: ['Shift+Right'], scope: 'editor' },
  { id: 'prevMarker', group: '跳转', label: '跳到上一个标记', keys: ['Ctrl+Left'], scope: 'editor' },
  { id: 'nextMarker', group: '跳转', label: '跳到下一个标记', keys: ['Ctrl+Right'], scope: 'editor' },
  /* 剪切点跳转（↑ / ↓）：剪辑台上用得最多的一对键 —— 修完一段下刀口，手不用回鼠标
     就能落到下一个接缝。它与「逐帧」(← →) 是两件事、两对键：
       左右 = 按帧微调；上下 = 按接缝跳。
     都挂在方向键上但分轴，是为了手感（右手方向键区一竖一横，不会按混）。 */
  { id: 'prevCut', group: '跳转', label: '跳到上一个剪切点', keys: ['Up'], scope: 'editor' },
  { id: 'nextCut', group: '跳转', label: '跳到下一个剪切点', keys: ['Down'], scope: 'editor' },

  /* 视图 */
  { id: 'zoomIn', group: '视图', label: '时间线放大', keys: ['Ctrl+='], scope: 'editor' },
  { id: 'zoomOut', group: '视图', label: '时间线缩小', keys: ['Ctrl+-'], scope: 'editor' },
  { id: 'zoomReset', group: '视图', label: '时间线缩放重置', keys: ['Ctrl+0'], scope: 'editor' },
  /* 适配全片（Shift+Z）：把整条时间线缩到刚好装满可视宽度。
     与「重置」的区别是它是**算出来的**，不是回到 1 —— 一条 10 分钟的项目按 Ctrl+0
     仍然是 1 倍，照样看不全。 */
  { id: 'zoomFit', group: '视图', label: '时间线适配全片', keys: ['Shift+Z'], scope: 'editor' },
  { id: 'fullscreen', group: '视图', label: '全屏预览', keys: ['F11'], scope: 'editor' },

  /* 项目 */
  { id: 'save', group: '项目', label: '保存草稿', keys: ['Ctrl+S'], scope: 'global' },
  { id: 'openSettings', group: '项目', label: '打开设置', keys: ['Ctrl+,'], scope: 'global' },
  { id: 'importMedia', group: '项目', label: '导入素材', keys: ['Ctrl+I'], scope: 'editor' },
  { id: 'exportVideo', group: '项目', label: '导出视频', keys: ['Ctrl+E'], scope: 'editor' }
]

/** 固定键位：不参与自定义，也不参与冲突检测（面板里会单独说明） */
export const FIXED_KEYS = [
  { label: '关闭弹窗 / 退出全屏 / 取消选中', keys: ['Esc'], note: '固定键位，不可修改' }
]

/* ------------------------------------------------------------------ *
 * 键位方案（整套替换）
 * ------------------------------------------------------------------ */

/**
 * 为什么要有方案：参考客户端的「快捷键」页带**多套预置方案**，迁移过来的人不用把
 * 几十条命令一条条重绑。我们之前只有单套 —— 对"从别的剪辑软件过来"的人等于重学一遍。
 *
 * 三条设计约束（每条都对应一种错法）：
 *
 *  ① **只写 overrides，整表由 `presetKeymap` 从默认表派生**。
 *     方案里复制一份完整键位表的话，以后新增动作只改默认表、忘了改三套方案，
 *     那三套里新动作就永远"未绑定"——而且没有任何一处会报错。
 *
 *  ② **每套都必须是完整可用的方案，不只是"改了几个键"**。
 *     闸门逐套验「覆盖全部动作 + 内部无冲突」，所以这里不能写"半套方案"。
 *     冲突检测与用户手改共用同一份 `findConflicts`，不另写一套判据。
 *
 *  ③ **名字不许出现第三方品牌**（可执行的开源版要求见 tools/check-oss-clean.mjs）。
 *     所以方案按**键位风格**命名，不按"某某软件的方案"命名 ——
 *     既守住了品牌边界，也真的说清了它是什么。
 */
export const KEYMAP_PRESETS = [
  {
    id: 'default',
    name: '默认',
    note: '出厂键位：常用动作给单键（V / N / M / I / O），其余挂 Ctrl / Alt',
    overrides: {}
  },
  {
    id: 'singleKey',
    name: '单键流',
    note: '分割 S、删除 D、缩放 = - 0：剪片时手不离开主键区',
    overrides: {
      split: ['S'],
      batchCut: ['Shift+S'],
      deleteClip: ['D'],
      clearTimeline: ['Shift+D'],
      zoomIn: ['='],
      zoomOut: ['-'],
      zoomReset: ['0']
    }
  },
  {
    id: 'modifierFirst',
    name: '修饰优先',
    note: '所有会改内容的动作都挂修饰键，单键只留播放与方向键：防误触 / 手写笔场景',
    overrides: {
      split: ['Ctrl+K'],
      deleteClip: ['Ctrl+Delete'],
      toggleDisableClip: ['Ctrl+D'],
      toggleSnap: ['Ctrl+Shift+N'],
      toggleMarker: ['Ctrl+M'],
      regionIn: ['Ctrl+Shift+I'],
      regionOut: ['Ctrl+Shift+O'],
      /* 默认的 Ctrl+I 是导入素材，这里要把入点让出来 —— 两个动作抢同一个键
         正是"看起来都绑上了、按下去只响应一个"的来源。 */
      importMedia: ['Ctrl+Alt+I'],
      toStart: ['Ctrl+Home'],
      toEnd: ['Ctrl+End'],
      prevFrame: ['Ctrl+Left'],
      nextFrame: ['Ctrl+Right'],
      prevSecond: ['Ctrl+Shift+Left'],
      nextSecond: ['Ctrl+Shift+Right'],
      prevMarker: ['Ctrl+Alt+Left'],
      nextMarker: ['Ctrl+Alt+Right']
    }
  },

  /* ---- 行业键位两套 ----------------------------------------------------
   * 上一版只有「默认 / 单键流 / 修饰优先」三套，都是**我们自己的**手感，
   * 对"从行业软件迁过来"的人等于重学一遍。这两套按剪辑台上的**物理作业面**分：
   * 一套把左手钉在三键播放上（手不离主键区），一套把编辑动作全推到拇指位（单手可完成）。
   *
   * ⚠️ 两套都**不写品牌名**：按"它是怎么用的"命名，而不是"它抄的是谁"。
   *    这既是开源版的词表要求（tools/check-oss-clean.mjs），也真的比品牌名好懂。
   */
  {
    id: 'editDesk',
    name: '剪辑台式',
    note: '左手三指 J / K / L 控制播放，剪辑动作全落主键区：B 分割、N 吸附、M 标记、I / O 入出点、\\ 适配全片',
    overrides: {
      /* 三键播放：J 往回、K 停、L 往前。这三个键的物理位置连成一排，
         左手食指/中指/无名指各占一个，闭眼也不会按错。 */
      playBackward: ['J'],
      pause: ['K'],
      playForward: ['L'],
      /* 刀片 B 是这一派的核心：与 J K L 同一竖列区域，切完立刻能播回去看 */
      split: ['B'],
      batchCut: ['Shift+B'],
      deleteClip: ['Delete'],
      toggleSnap: ['N'],
      toggleMarker: ['M'],
      regionIn: ['I'],
      regionOut: ['O'],
      /* 逐帧走 , . —— 右手不用离开主键区就能一帧一帧找刀口 */
      prevFrame: [','],
      nextFrame: ['.'],
      prevSecond: ['Shift+,'],
      nextSecond: ['Shift+.'],
      zoomIn: ['='],
      zoomOut: ['-'],
      zoomReset: ['0'],
      /* 适配全片：一个反斜杠按到底，比 Shift+Z 少一次换指 */
      zoomFit: ['\\']
    }
  },
  {
    id: 'thumbOnly',
    name: '拇指单手',
    note: '除播放外所有编辑动作都挂 Alt：左手拇指按住 Alt、右手点字母，一只手就能剪完；避免与 Ctrl 系混用',
    overrides: {
      playBackward: ['J'],
      pause: ['K'],
      playForward: ['L'],
      split: ['Alt+S'],
      batchCut: ['Alt+Shift+S'],
      deleteClip: ['Alt+Delete'],
      toggleDisableClip: ['Alt+V'],
      toggleSnap: ['Alt+N'],
      toggleMarker: ['Alt+M'],
      regionIn: ['Alt+I'],
      regionOut: ['Alt+O'],
      regionDelete: ['Alt+Shift+Delete'],
      /* Ctrl+I 是导入素材、Ctrl+Shift+I 在这里被入点让出来 ⇒ 导入统一走 Alt 系，
         避免"两个动作抢同一个键"那种"看起来都绑上了、按下去只响应一个"的坑。 */
      importMedia: ['Alt+Shift+I'],
      zoomIn: ['Alt+='],
      zoomOut: ['Alt+-'],
      zoomReset: ['Alt+0'],
      zoomFit: ['Alt+Z'],
      /* 组合 / 复合这两对本来就在 Alt 系上（Alt+G / Alt+Shift+G），
         与上面新增的 Alt+N / Alt+M 不重叠，保持原样即可。 */
      prevFrame: ['Alt+,'],
      nextFrame: ['Alt+.'],
      prevSecond: ['Alt+Shift+,'],
      nextSecond: ['Alt+Shift+.']
    }
  }
]

/**
 * 时间线缩放范围，与 Timeline.jsx 的滑块保持一致（滑块也读这两个常量，不许再写死）。
 *
 * 下限为什么是 0.05 而不是 0.3：0.3 × 46px/秒 ≈ 14px/秒，一条 3 分钟的片子要 2500px，
 * 1920 宽的工作台装不下 —— 按「适配全片」也还是看不全，那这个功能就是假的。
 * 0.05 × 46 ≈ 2.3px/秒，约 12 分钟的片子能一屏看完。下限放宽**不影响**默认手感：
 * 出厂 zoom 仍是 1，只有用户自己缩小或按适配才会走到这区间。
 */
export const ZOOM_MIN = 0.05
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
 * 取某一套方案的完整键位表。
 *
 * 从 `defaultKeymap()` 派生再覆盖 —— 理由见 `KEYMAP_PRESETS` 的第 ① 条约束：
 * 以后新增动作时，三套方案自动带上新动作的默认键位，不会静默留空。
 *
 * 未知 id 一律退回第一套（默认），不抛错：这一层会被设置页与 E2E 直接调用，
 * 抛错只会把"配置里存了一个旧方案 id"变成一次白屏。
 */
export function presetKeymap(id) {
  const preset = KEYMAP_PRESETS.find((item) => item.id === id) || KEYMAP_PRESETS[0]
  const map = defaultKeymap()
  for (const [actionId, keys] of Object.entries(preset.overrides || {})) {
    /* 方案里写了一个不存在的动作 id（拼错 / 动作被删）⇒ 跳过。
       静默跳过是有意的：它不该让软件起不来，但 `keymap-selftest` 会逐条核对
       "方案引用的 id 都真实存在"，所以拼错在闸门里是红的。 */
    if (!ACTION_BY_ID.has(actionId)) continue
    const list = []
    const seen = new Set()
    for (const item of Array.isArray(keys) ? keys : [keys]) {
      const combo = normalizeCombo(item)
      if (!combo || seen.has(combo)) continue
      seen.add(combo)
      list.push(combo)
    }
    map[actionId] = list
  }
  return map
}

/**
 * 反查：这份键位表属于哪套方案？不属于任何一套 ⇒ 返回 `''`（界面显示"自定义"）。
 *
 * 判据是**逐条相等**而不是"包含方案的每一条覆盖"：用户把单键流改了一条之后，
 * 它就不再是单键流了 —— 继续显示"单键流"会让人以为"我改坏了，它还是原来的方案"。
 */
export function presetOf(keymap) {
  const current = mergeKeymap(keymap)
  for (const preset of KEYMAP_PRESETS) {
    const target = presetKeymap(preset.id)
    const same = ACTIONS.every(
      (action) => JSON.stringify(current[action.id] || []) === JSON.stringify(target[action.id] || [])
    )
    if (same) return preset.id
  }
  return ''
}

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
