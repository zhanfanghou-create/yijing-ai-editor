/**
 * 快捷键系统的自证夹具。
 *
 * 为什么必须有：快捷键这种东西"看起来对了"太容易了 —— 键位表填满、面板画出来、
 * 按下去没反应或者抢了输入框的键，肉眼一概看不出来。所以这里逐条钉住：
 *
 *   A. 组合串归一化（同一个物理键只能算出唯一串，否则冲突检测形同虚设）
 *   B. 默认键位表自身不能有冲突
 *   C. **注入一个冲突必须被抓到**（证明 findConflicts 不是空转）
 *   D. 用户配置合并：丢未知 id、去重、允许清空=解绑
 *   E. 派发解析、输入框豁免、逐帧步进、缩放夹取
 *   F. 动作表自身的完整性（id 唯一、分组合法、作用域合法）
 */
import {
  ACTIONS,
  ACTION_BY_ID,
  GROUPS,
  FRAME_RATE,
  KEYMAP_PRESETS,
  ZOOM_MIN,
  ZOOM_MAX,
  clampZoom,
  clearKeymap,
  comboOf,
  comboParts,
  defaultKeymap,
  findConflicts,
  conflictCombos,
  isTypingTarget,
  loadKeymap,
  mergeKeymap,
  normalizeCombo,
  presetKeymap,
  presetOf,
  resolveAction,
  saveKeymap,
  stepFrame
} from '../packages/desktop/src/renderer/keymap.js'

let pass = 0
const failures = []
function ok(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

/** 造一个 KeyboardEvent 形状的最小对象（不依赖 DOM） */
const ev = (code, { ctrl = false, alt = false, shift = false, meta = false, key = '' } = {}) => ({
  code,
  key: key || code,
  ctrlKey: ctrl,
  altKey: alt,
  shiftKey: shift,
  metaKey: meta
})

console.log('\n=== A. 组合串归一化 ===\n')
ok('Ctrl+Z', comboOf(ev('KeyZ', { ctrl: true })) === 'Ctrl+Z', comboOf(ev('KeyZ', { ctrl: true })))
ok(
  'Ctrl+Shift+Z',
  comboOf(ev('KeyZ', { ctrl: true, shift: true })) === 'Ctrl+Shift+Z',
  comboOf(ev('KeyZ', { ctrl: true, shift: true }))
)
ok('单独按 Ctrl 不构成组合', comboOf(ev('ControlLeft', { ctrl: true })) === '', `"${comboOf(ev('ControlLeft', { ctrl: true }))}"`)
ok('Space 归一成 Space', comboOf(ev('Space', { key: ' ' })) === 'Space', comboOf(ev('Space', { key: ' ' })))
ok('方向键用物理 code', comboOf(ev('ArrowLeft', { key: 'ArrowLeft' })) === 'Left', comboOf(ev('ArrowLeft')))

/**
 * 这条是本文件的重点：`key` 会随 Shift 变形，`code` 不会。
 * 如果实现退回用 event.key，Ctrl+Shift+= 会算成 `Ctrl+Shift++`，
 * 与 `Ctrl+=` 变成两个不相干的串，冲突检测就漏了。
 */
const shiftedEqual = { code: 'Equal', key: '+', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }
const realShiftedEqual = { code: 'Equal', key: '+', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }
ok('Ctrl+= 不会因 key 变成 + 而漂移', comboOf(shiftedEqual) === 'Ctrl+=', comboOf(shiftedEqual))
ok(
  'Ctrl+Shift+= 与 Ctrl+= 是两个不同的串（修饰键不同）',
  comboOf(realShiftedEqual) !== comboOf(shiftedEqual),
  `${comboOf(realShiftedEqual)} vs ${comboOf(shiftedEqual)}`
)

console.log('\nB. normalizeCombo：大小写与顺序无关 ===\n')
ok('顺序无关', normalizeCombo('shift+ctrl+z') === 'Ctrl+Shift+Z', normalizeCombo('shift+ctrl+z'))
ok('大小写无关', normalizeCombo('CTRL+ALT+DELETE') === 'Ctrl+Alt+Delete', normalizeCombo('CTRL+ALT+DELETE'))
ok('别名 Command → Ctrl', normalizeCombo('Command+S') === 'Ctrl+S', normalizeCombo('Command+S'))
ok('裸 + 折成 =', normalizeCombo('Ctrl++') === 'Ctrl+=', normalizeCombo('Ctrl++'))
ok('空输入 → 空串', normalizeCombo('') === '' && normalizeCombo('   ') === '' && normalizeCombo(null) === '')
ok('只有修饰键 → 空串', normalizeCombo('Ctrl+Shift') === '', `"${normalizeCombo('Ctrl+Shift')}"`)

console.log('\nC. 默认键位表自身必须干净 ===\n')
const base = defaultKeymap()
ok('每个动作至少一个键位', Object.values(base).every((list) => list.length >= 1), JSON.stringify(base))
ok('默认表无冲突', findConflicts(base).length === 0, JSON.stringify(findConflicts(base)))
ok(
  '默认键位都是规范形（幂等）',
  ACTIONS.every((action) => (base[action.id] || []).every((combo) => normalizeCombo(combo) === combo)),
  ACTIONS.filter((a) => (base[a.id] || []).some((c) => normalizeCombo(c) !== c)).map((a) => a.id).join(',') || '全部规范'
)
ok('comboParts 拆得开', JSON.stringify(comboParts('Ctrl+Shift+Z')) === '["Ctrl","Shift","Z"]', comboParts('Ctrl+Shift+Z').join('|'))

console.log('\nD. 冲突检测必须真的会报（非空洞）===\n')
/** 故意做一个脏表：把「撤销」和「重做」绑到同一个键位 */
const dirty = mergeKeymap({ ...base, redo: ['Ctrl+Z'] })
const dirtyConflicts = findConflicts(dirty)
ok('脏表被抓到恰好 1 处冲突', dirtyConflicts.length === 1, `实际 ${dirtyConflicts.length} 处`)
ok('冲突键位就是 Ctrl+Z', dirtyConflicts[0]?.combo === 'Ctrl+Z', dirtyConflicts[0]?.combo || '(无)')
ok(
  '冲突双方都被列出来（undo + redo）',
  JSON.stringify((dirtyConflicts[0]?.actions || []).map((a) => a.id).sort()) === '["redo","undo"]',
  JSON.stringify((dirtyConflicts[0]?.actions || []).map((a) => a.id))
)
ok('conflictCombos 给出可高亮的集合', conflictCombos(dirty).has('Ctrl+Z'), [...conflictCombos(dirty)].join(','))
ok('干净表不会误报冲突', conflictCombos(base).size === 0)
/** 同一个动作自己绑两个不同键位，不算冲突 */
ok(
  '一个动作绑多键位不算冲突',
  findConflicts(mergeKeymap({ ...base, redo: ['Ctrl+Shift+Z', 'Ctrl+Y'] })).length === 0
)

console.log('\nE. 用户配置合并 ===\n')
const withUnknown = mergeKeymap({ ...base, redo: ['Ctrl+Shift+Z'], doesNotExist: ['Ctrl+Q'] })
ok('未知 id 被丢弃', !('doesNotExist' in withUnknown), Object.keys(withUnknown).length + ' 个动作')
ok('未知 id 不产生冲突', findConflicts(withUnknown).length === 0)
const withDup = mergeKeymap({ ...base, redo: ['Ctrl+Y', 'Ctrl+Y', 'ctrl+y'] })
ok('同一动作内键位去重', JSON.stringify(withDup.redo) === '["Ctrl+Y"]', JSON.stringify(withDup.redo))
const unbound = mergeKeymap({ ...base, split: [] })
ok('空数组 = 解绑（合法）', JSON.stringify(unbound.split) === '[]', JSON.stringify(unbound.split))
const badShape = mergeKeymap({ ...base, split: 'Ctrl+B' })
ok('非数组取值被忽略，保留默认', JSON.stringify(badShape.split) === '["Ctrl+B"]', JSON.stringify(badShape.split))
ok('坏输入（null / 字符串）退回全默认', JSON.stringify(mergeKeymap(null)) === JSON.stringify(base))
ok(
  '不合法的键位串被清掉',
  JSON.stringify(mergeKeymap({ ...base, split: ['Ctrl+Shift', '   ', 'Ctrl+B'] }).split) === '["Ctrl+B"]',
  JSON.stringify(mergeKeymap({ ...base, split: ['Ctrl+Shift', '   ', 'Ctrl+B'] }).split)
)

console.log('\nF. 派发与豁免 ===\n')
ok('resolveAction 命中正确动作', resolveAction('Ctrl+B', base) === 'split', resolveAction('Ctrl+B', base))
ok('未绑定的组合解析为空', resolveAction('Ctrl+Alt+F9', base) === '', `"${resolveAction('Ctrl+Alt+F9', base)}"`)
ok(
  '解绑后不再命中',
  resolveAction('Ctrl+B', mergeKeymap({ ...base, split: [] })) === '',
  `"${resolveAction('Ctrl+B', mergeKeymap({ ...base, split: [] }))}"`
)
ok('输入框豁免', isTypingTarget({ tagName: 'INPUT' }) === true)
ok('多行文本豁免', isTypingTarget({ tagName: 'TEXTAREA' }) === true)
ok('下拉豁免', isTypingTarget({ tagName: 'select' }) === true)
ok('contenteditable 豁免', isTypingTarget({ isContentEditable: true }) === true)
ok('普通按钮不豁免', isTypingTarget({ tagName: 'BUTTON' }) === false)
ok('null 不豁免', isTypingTarget(null) === false)

console.log('\nG. 逐帧与缩放 ===\n')
ok('0 往后一帧 = 1/30', Math.abs(stepFrame(0, 1) - 1 / FRAME_RATE) < 1e-9, String(stepFrame(0, 1)))
ok('1/30 往前一帧 = 0', Math.abs(stepFrame(1 / FRAME_RATE, -1)) < 1e-9, String(stepFrame(1 / FRAME_RATE, -1)))
ok('0 再往前不会变负', stepFrame(0, -1) === 0, String(stepFrame(0, -1)))
/** 连续步进 300 帧后必须精确落在 10 秒上（浮点累加会漂，所以按帧号取整） */
let cursor = 0
for (let i = 0; i < 300; i += 1) cursor = stepFrame(cursor, 1)
ok('连走 300 帧精确到 10 秒', Math.abs(cursor - 10) < 1e-9, String(cursor))
ok('缩放夹在上界', clampZoom(99) === ZOOM_MAX, String(clampZoom(99)))
ok('缩放夹在下界', clampZoom(0) === ZOOM_MIN, String(clampZoom(0)))
ok('非法缩放退回 1', clampZoom('abc') === 1, String(clampZoom('abc')))

console.log('\nH. 动作表完整性 ===\n')
const ids = ACTIONS.map((a) => a.id)
ok('动作 id 唯一', new Set(ids).size === ids.length, `${ids.length} 个动作`)
ok('分组都在 GROUPS 里', ACTIONS.every((a) => GROUPS.includes(a.group)), ACTIONS.filter((a) => !GROUPS.includes(a.group)).map((a) => a.id).join(',') || '全部合法')
ok('作用域只有 global / editor', ACTIONS.every((a) => a.scope === 'global' || a.scope === 'editor'))
ok('每个分组都至少有一个动作', GROUPS.every((g) => ACTIONS.some((a) => a.group === g)), GROUPS.filter((g) => !ACTIONS.some((a) => a.group === g)).join(',') || '全部有动作')
ok('动作都有中文名', ACTIONS.every((a) => a.label && a.label.length >= 2))
ok('ACTION_BY_ID 与表一致', ACTIONS.every((a) => ACTION_BY_ID.get(a.id) === a))

console.log('\nG. 键位方案（整套替换）===\n')
/* 方案这一层的错法全是静的：多套表里抄了一份、少写一条覆盖、id 拼错、
   两套方案里出现同一键位 —— 界面照画、按键照跑，只有"某些键莫名其妙不响应"。
   所以这里逐套验：完整覆盖 / 内部无冲突 / 引用合法 / 可往返 / 未知 id 退回默认。 */
ok('方案 id 唯一', new Set(KEYMAP_PRESETS.map((p) => p.id)).size === KEYMAP_PRESETS.length, `${KEYMAP_PRESETS.length} 套`)
ok('每套方案都有名字与说明', KEYMAP_PRESETS.every((p) => p.name && p.note && p.name.length >= 2))
ok(
  '每套方案都覆盖全部动作（不是"只改几个键"的半套）',
  KEYMAP_PRESETS.every((preset) => {
    const map = presetKeymap(preset.id)
    return ACTIONS.every((action) => Array.isArray(map[action.id]))
  }),
  `${ACTIONS.length} 个动作`
)
ok(
  '每套方案内部无键位冲突',
  KEYMAP_PRESETS.every((preset) => findConflicts(presetKeymap(preset.id)).length === 0),
  KEYMAP_PRESETS.map((preset) => `${preset.id}:${findConflicts(presetKeymap(preset.id)).length}`).join(' ')
)
ok(
  '方案里引用的动作 id 都真实存在（拼错要在这里红，不能在界面上静默失效）',
  KEYMAP_PRESETS.every((preset) => Object.keys(preset.overrides || {}).every((id) => ACTION_BY_ID.has(id))),
  KEYMAP_PRESETS.filter((preset) => Object.keys(preset.overrides || {}).some((id) => !ACTION_BY_ID.has(id)))
    .map((preset) => preset.id)
    .join(',') || '全部合法'
)
ok(
  '默认方案与 defaultKeymap 逐条相等（方案不是第二份真源）',
  JSON.stringify(presetKeymap('default')) === JSON.stringify(defaultKeymap())
)
ok(
  'presetOf 能把每套方案认回来（界面才知道该高亮哪个）',
  KEYMAP_PRESETS.every((preset) => presetOf(presetKeymap(preset.id)) === preset.id),
  KEYMAP_PRESETS.map((preset) => presetOf(presetKeymap(preset.id))).join(',')
)
ok(
  '改过一条之后 presetOf 返回空串（不许继续冒充某套方案）',
  (() => {
    const map = presetKeymap('singleKey')
    map.split = ['F8']
    return presetOf(map) === ''
  })()
)
ok(
  '未知方案 id 退回默认而不抛（配置里残留旧方案 id 不该白屏）',
  JSON.stringify(presetKeymap('不存在的方案')) === JSON.stringify(defaultKeymap())
)

console.log('\nH2. 三键播放与行业方案 ===\n')
/** J / K / L 必须**各占一个键**，且都真的绑到了对应动作上。
 *  只验"表里有这三个动作"是不够的 —— 方案里把 pause 写成 ['L'] 也照样"有"，
 *  那样 L 既是播放又是暂停，冲突检测会报，但如果两套方案都写错、又都没引到新动作，
 *  界面上是 5 套方案看着都在、按下去全不对。 */
ok(
  'J / K / L 分别绑到 倒放 / 暂停 / 正向播放（默认方案）',
  ['playBackward', 'pause', 'playForward'].every((id) => {
    const keys = base[id]
    return Array.isArray(keys) && keys.length === 1
  }) &&
    base.playBackward[0] === 'J' &&
    base.pause[0] === 'K' &&
    base.playForward[0] === 'L',
  `J=${base.playBackward} K=${base.pause} L=${base.playForward}`
)
ok(
  '两套行业方案都带三键播放（方案不许把播放键丢掉）',
  ['editDesk', 'thumbOnly'].every((id) => {
    const map = presetKeymap(id)
    return map.playBackward[0] === 'J' && map.pause[0] === 'K' && map.playForward[0] === 'L'
  }),
  ['editDesk', 'thumbOnly']
    .map((id) => {
      const map = presetKeymap(id)
      return `${id}:${map.playBackward}/${map.pause}/${map.playForward}`
    })
    .join(' ')
)
/** 反斜杠是"适配全片"在剪辑台式里的键。它必须能**归一化**回来，
 *  否则方案里写着 `\`、用户按下去算出来是 `\\`（或反过来），面板显示已绑定而实际不触发。 */
ok(
  '反斜杠键位能归一化（\\ 写进方案后要能被 comboOf 的结果命中）',
  normalizeCombo('\\') === '\\' && presetKeymap('editDesk').zoomFit[0] === '\\',
  `${JSON.stringify(normalizeCombo('\\'))} / ${JSON.stringify(presetKeymap('editDesk').zoomFit)}`
)
ok(
  '逗号 / 句号逐帧键能归一化（剪辑台式的 , . 逐帧）',
  normalizeCombo(',') === ',' && normalizeCombo('.') === '.' && presetKeymap('editDesk').prevFrame[0] === ','
)
/** 拇指单手套：所有改内容的动作都必须带 Alt —— 抽查四条最容易漏的。 */
ok(
  '拇指单手方案：分割 / 删除 / 吸附 / 标记 全部挂 Alt',
  ['split', 'deleteClip', 'toggleSnap', 'toggleMarker'].every((id) =>
    presetKeymap('thumbOnly')[id].every((combo) => combo.startsWith('Alt+'))
  ),
  ['split', 'deleteClip', 'toggleSnap', 'toggleMarker']
    .map((id) => `${id}=${presetKeymap('thumbOnly')[id].join('|')}`)
    .join(' ')
)
/** resolveAction 是真正的派发路径：方案切过去之后，按下的键必须命中**对应**动作。
 *  这条比"表里有值"更接近用户的真实路径。 */
ok(
  '切到剪辑台式后，J / K / L / B / \\ 各自命中正确的动作',
  (() => {
    const map = presetKeymap('editDesk')
    return (
      resolveAction('J', map) === 'playBackward' &&
      resolveAction('K', map) === 'pause' &&
      resolveAction('L', map) === 'playForward' &&
      resolveAction('B', map) === 'split' &&
      resolveAction('\\', map) === 'zoomFit'
    )
  })(),
  `J=${resolveAction('J', presetKeymap('editDesk'))} B=${resolveAction('B', presetKeymap('editDesk'))} \\=${resolveAction('\\', presetKeymap('editDesk'))}`
)
ok(
  '切到拇指单手后，Alt+S 分割、Alt+I 入点（Ctrl+I 让出给「导入素材」之外的用途）',
  (() => {
    const map = presetKeymap('thumbOnly')
    /* ⚠️ 这条一开始我写成「Ctrl+I 仍是导入素材」，红了 —— 红的是**断言**、不是实现：
       拇指单手方案把导入挪到了 Alt+Shift+I，就是为了给 Alt+I（入点）腾位置。
       Ctrl+I 在这套方案里应当**谁都不绑**，这样它不会被"两个动作抢一个键"的
       冲突检测判红（`findConflicts` 只报真冲突，所以这里必须断言空）。 */
    return (
      resolveAction('Alt+S', map) === 'split' &&
      resolveAction('Alt+I', map) === 'regionIn' &&
      resolveAction('Alt+Shift+I', map) === 'importMedia' &&
      resolveAction('Ctrl+I', map) === ''
    )
  })(),
  `Alt+S=${resolveAction('Alt+S', presetKeymap('thumbOnly'))} Alt+I=${resolveAction('Alt+I', presetKeymap('thumbOnly'))} Ctrl+I="${resolveAction('Ctrl+I', presetKeymap('thumbOnly'))}"`
)

console.log('\nI. 持久化（无 localStorage 环境不能抛）===\n')
ok('无 localStorage 时 loadKeymap 退回默认', JSON.stringify(loadKeymap()) === JSON.stringify(base))
ok('无 localStorage 时 saveKeymap 返回 false 而不抛', saveKeymap(base) === false)
ok('无 localStorage 时 clearKeymap 返回 false 而不抛', clearKeymap() === false)

const total = pass + failures.length
console.log(`\nKEYMAP_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
console.log(failures.length ? 'KEYMAP_SELFTEST_FAILED' : 'KEYMAP_SELFTEST_PASSED')
// 见仓库约定：不调 process.exit()，避免 Windows 重定向时截断结论行
process.exitCode = failures.length ? 1 : 0
