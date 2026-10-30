#!/usr/bin/env node
/**
 * groups.js 的自证夹具（组合：逻辑成组）。
 *
 * 为什么值得单开一道：组合的三种错法在界面上都**看不出来**，只在下一次操作时咬人。
 *   ① 组合字段写成了"成员表" ⇒ 片段被删后表里留幽灵 id，下一次拖动"少带一条、还不报错"。
 *      本仓的做法是只认片段上的 `group` 扁平字段，这一组断言钉的就是"组员 = 同 tag"。
 *   ② 允许一条片段同时属于两个组（新组号不覆盖旧组号）⇒ 拖它一下两组都动，
 *      表现为"画面莫名多移了一段"，而鼠标只拖了一条。
 *   ③ 解组时连别的组一起清 ⇒ 用户的另一处组合无声消失（他得靠回忆才能发现）。
 *
 * 另外钉住两条"边界必须原样返回引用"的约定：成组不足两段、解组时本来就不在组里。
 * 调用方靠**引用相等**判断"什么都没发生"（`withGroup` 返回原数组 ⇒ 不 commit、
 * 不弹成功提示），所以这里返回新数组但内容相同也算缺陷 —— 那会让一次无效操作
 * 也进一次撤销栈。
 *
 * 输出：GROUPS_SELFTEST_PASSED / GROUPS_SELFTEST_FAILED
 *       + 「GROUPS_SELFTEST_STATS total=N pass=P fail=F」
 */
import {
  MIN_GROUP_SIZE,
  clearGroupOf,
  groupIdsOf,
  groupOf,
  groupPeers,
  withGroup
} from '../packages/desktop/src/renderer/groups.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  ::  ${detail}`}`)
}

const sorted = (list) => [...list].sort().join(',')

const CLIPS = [
  { id: 'v1', track: 'video', start: 0, duration: 5 },
  { id: 'v2', track: 'video', start: 5, duration: 5 },
  { id: 'a1', track: 'audio', start: 0, duration: 5 },
  { id: 't1', track: 'text', start: 0, duration: 3 }
]

/* ------------------------------------------------- A. groupIdsOf / groupOf */

check('没有 group 字段的片段：组员只有它自己', sorted(groupIdsOf(CLIPS, 'v1')) === 'v1')
check('组员只有自己的时候 groupOf 返回空串', groupOf(CLIPS, 'v1') === '')
check('片段不存在时 groupIdsOf 返回空数组', groupIdsOf(CLIPS, '不存在').length === 0)
check('groupOf 对空输入不抛', groupOf(null, 'v1') === '')
check('空串 group 视为"不在组里"（旧草稿可能留有空串）',
  sorted(groupIdsOf([{ id: 'x', group: '' }], 'x')) === 'x')

const grouped = withGroup(CLIPS, ['v1', 'a1'], 'G1')
check('成组返回新数组，且原数组没有被改（不可变）',
  grouped !== CLIPS && CLIPS.every((item) => !item.group))
check('成组后两段共享同一个 tag', groupOf(grouped, 'v1') === 'G1' && groupOf(grouped, 'a1') === 'G1')
check('成组后从任一段都能拿到整组', sorted(groupIdsOf(grouped, 'a1')) === 'a1,v1')
check('没参与成组的片段 group 仍为空',
  groupOf(grouped, 'v2') === '' && groupOf(grouped, 't1') === '')

/* -------------------------------------------------------- B. withGroup 边界 */

check('MIN_GROUP_SIZE 是 2（一段的"组"没有意义）', MIN_GROUP_SIZE === 2)
check('只选一段时原样返回**同一个引用**（调用方靠引用相等判断"没成组"）',
  withGroup(CLIPS, ['v1'], 'G2') === CLIPS)
check('一个都不选时原样返回', withGroup(CLIPS, [], 'G2') === CLIPS)
check('传入的 id 都不在片段表里时原样返回', withGroup(CLIPS, ['x', 'y'], 'G2') === CLIPS)
check('片段表只有一段匹配时也原样返回（数量不足）',
  withGroup(CLIPS, ['v1', '不存在'], 'G2') === CLIPS)
check('组号为空时原样返回（不许造出无 tag 的"组"）', withGroup(CLIPS, ['v1', 'a1'], '') === CLIPS)
check('null 片段表不抛', Array.isArray(withGroup(null, ['a', 'b'], 'G')) && withGroup(null, ['a', 'b'], 'G').length === 0)

/* ------------------------------------------- C. 重组成组：新组号必须覆盖旧组号 */

const regrouped = withGroup(grouped, ['v1', 'v2'], 'G3')
check('把一段从旧组搬到新组：新组号覆盖旧组号', groupOf(regrouped, 'v1') === 'G3', groupOf(regrouped, 'v1'))
check('旧组剩下的那段自动散组（组员集合只剩它自己）', sorted(groupIdsOf(regrouped, 'a1')) === 'a1')
check('一条片段不会同时属于两个组（同 tag 才算同组）',
  (() => {
    const tags = new Set(regrouped.map((item) => item.group).filter(Boolean))
    /* 允许存在多个 tag，但不允许同一段有两个 —— 数据结构上不可能有，这里钉的是"没写成数组" */
    return [...tags].every((tag) => typeof tag === 'string')
  })())

/* ------------------------------------------------------- D. clearGroupOf */

const cleared = clearGroupOf(regrouped, 'v1')
check('解组只清本组：G3 的两段都松开了', groupOf(cleared.clips, 'v1') === '' && groupOf(cleared.clips, 'v2') === '')
check('解组报出的成员数正确（2 段）', cleared.count === 2, String(cleared.count))
check('解组不动组外的片段（组外对象连引用都不换）', (() => {
  const before = regrouped.find((item) => item.id === 't1')
  return cleared.clips.find((item) => item.id === 't1') === before
})())
check('解组后原来的 group 键被删掉（不是置空串）',
  !Object.prototype.hasOwnProperty.call(cleared.clips.find((item) => item.id === 'v1'), 'group'))
check('不在组里时 count=0 且**原样返回同一个引用**', (() => {
  const plain = clearGroupOf(CLIPS, 'v1')
  return plain.count === 0 && plain.clips === CLIPS
})())
check('片段不存在时 count=0 且不抛', clearGroupOf(CLIPS, '不存在').count === 0)

const twoGroups = [
  { id: 'p', group: 'A' },
  { id: 'q', group: 'A' },
  { id: 'r', group: 'B' },
  { id: 's', group: 'B' }
]
const oneCleared = clearGroupOf(twoGroups, 'q')
check('有两个组时只解被点的那个组', oneCleared.count === 2 && groupOf(oneCleared.clips, 'r') === 'B',
  `${oneCleared.count} / ${groupOf(oneCleared.clips, 'r')}`)

/* -------------------------------------------------------- E. groupPeers */

check('groupPeers 排除被拖的那一条', sorted(groupPeers(grouped, 'v1')) === 'a1')
check('不在组里时 groupPeers 是空数组（不能凭空带人）', groupPeers(CLIPS, 'v1').length === 0)
check('片段不存在时 groupPeers 是空数组', groupPeers(CLIPS, '不存在').length === 0)

/* ------------------------------------------------- F. 与联动并存不互相污染 */

const mixed = withGroup(
  [
    { id: 'm1', assetId: 'S', start: 0, duration: 4 },
    { id: 'm2', assetId: 'S', start: 0, duration: 4 },
    { id: 'm3', assetId: 'T', start: 2, duration: 4 }
  ],
  ['m1', 'm3'],
  'MX'
)
check('组合不改变 assetId（联动仍按同源分组，两套绑定互不干扰）',
  mixed.find((item) => item.id === 'm1').assetId === 'S' &&
    mixed.find((item) => item.id === 'm3').assetId === 'T')
check('组合里的两段可以来自不同素材', groupOf(mixed, 'm1') === groupOf(mixed, 'm3'))

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\nGROUPS_SELFTEST_STATS total=${results.length} pass=${passed} fail=${failed}`)
if (failed) {
  console.log('GROUPS_SELFTEST_FAILED')
  process.exitCode = 1
} else {
  console.log('GROUPS_SELFTEST_PASSED')
  process.exitCode = 0
}
