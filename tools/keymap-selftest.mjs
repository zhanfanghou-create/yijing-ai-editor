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

console.log('\nI. 持久化（无 localStorage 环境不能抛）===\n')
ok('无 localStorage 时 loadKeymap 退回默认', JSON.stringify(loadKeymap()) === JSON.stringify(base))
ok('无 localStorage 时 saveKeymap 返回 false 而不抛', saveKeymap(base) === false)
ok('无 localStorage 时 clearKeymap 返回 false 而不抛', clearKeymap() === false)

const total = pass + failures.length
console.log(`\nKEYMAP_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
console.log(failures.length ? 'KEYMAP_SELFTEST_FAILED' : 'KEYMAP_SELFTEST_PASSED')
// 见仓库约定：不调 process.exit()，避免 Windows 重定向时截断结论行
process.exitCode = failures.length ? 1 : 0
