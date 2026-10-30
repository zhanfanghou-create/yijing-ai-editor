/**
 * 时间线导航的纯逻辑自证（切点 / 步进 / 适配全片）。
 *
 * 为什么单开这道闸门：这三件事全都是**算得出来但编译不报错、界面也不报警**的 ——
 *   · 切点算重了 → 按一下 ↑ 只动半格，看起来像"键不太灵"；
 *   · 步进用 >= 而不是 >  → 站在切点上按 ↓ 原地不动，看起来像"键坏了"；
 *   · 适配把空时间线也算一遍 → zoom 被压到 0.05，整条时间线缩成一条线。
 * 只有把边界（站在切点上 / 到两头 / 零长片段 / 空表 / 量不到视口）逐条钉住才靠谱。
 *
 * 用法：node tools/timeline-nav-selftest.mjs
 */
import {
  CUT_TOL,
  contentEnd,
  cutPoints,
  fitZoom,
  stepCut
} from '../packages/desktop/src/renderer/timelineNav.js'

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

/** 造片段（只给算切点要用的字段） */
const clip = (start, duration) => ({ id: `c${start}_${duration}`, start, duration })

const JOIN = (list) => JSON.stringify(list)

console.log('\n=== A. 剪切点表 ===\n')
ok('空表 → 空数组', JOIN(cutPoints([])) === '[]', JOIN(cutPoints([])))
ok('null 不抛', JOIN(cutPoints(null)) === '[]')
ok('单段 0~5 的切点只有 5（0 不算切点，起点用 Home 回）', JOIN(cutPoints([clip(0, 5)])) === '[5]', JOIN(cutPoints([clip(0, 5)])))
ok(
  '两段首尾相接 0~5 / 5~10 → [5,10]（接缝只算一个）',
  JOIN(cutPoints([clip(0, 5), clip(5, 5)])) === '[5,10]',
  JOIN(cutPoints([clip(0, 5), clip(5, 5)]))
)
ok(
  '乱序输入也按升序输出',
  JOIN(cutPoints([clip(8, 2), clip(0, 3), clip(4, 1)])) === '[3,4,5,8,10]',
  JOIN(cutPoints([clip(8, 2), clip(0, 3), clip(4, 1)]))
)
ok(
  '零长 / 负长片段被跳过（它们不占时间线位置）',
  JOIN(cutPoints([clip(3, 0), clip(6, -2), clip(10, 2)])) === '[10,12]',
  JOIN(cutPoints([clip(3, 0), clip(6, -2), clip(10, 2)]))
)
ok(
  '浮点累加出来的两个"同一秒"只算一个',
  // 0.1 + 0.2 = 0.30000000000000004，与 0.3 必须视为同一个切点
  JOIN(cutPoints([clip(0, 0.1), clip(0.1, 0.2), clip(0.3, 0.2)])) === `[0.1,0.3,0.5]`,
  JOIN(cutPoints([clip(0, 0.1), clip(0.1, 0.2), clip(0.3, 0.2)]))
)
ok(
  '非法字段（字符串 / undefined / null 项）不产生切点也不抛',
  JOIN(cutPoints([clip('a', 3), clip(2, undefined), null, clip(4, 2)])) === '[4,6]',
  JOIN(cutPoints([clip('a', 3), clip(2, undefined), null, clip(4, 2)]))
)
ok(
  '同一个 start 出现多次只算一个切点',
  JOIN(cutPoints([clip(2, 3), clip(2, 5)])) === '[2,5,7]',
  JOIN(cutPoints([clip(2, 3), clip(2, 5)]))
)

console.log('\nB. 按切点步进 ===\n')
const SHOW = [clip(0, 3), clip(3, 4), clip(9, 2)] // 切点 = 3 / 7 / 9 / 11（9 是第三段的起点）
ok('从 0 往后 → 第一个切点 3', stepCut(SHOW, 0, 1) === 3, String(stepCut(SHOW, 0, 1)))
/**
 * 这条是本文件的核心：站在切点上按「下一个」必须走到**下一个**切点。
 * 判据若写成 `>=`，这里会返回 3（原地不动）—— 界面上只表现为"有时候按两下才动"。
 */
ok('站在切点 3 上往后 → 7（不是原地）', stepCut(SHOW, 3, 1) === 7, String(stepCut(SHOW, 3, 1)))
ok('从 5 往前 → 3', stepCut(SHOW, 5, -1) === 3, String(stepCut(SHOW, 5, -1)))
ok('站在切点 7 上往前 → 3', stepCut(SHOW, 7, -1) === 3, String(stepCut(SHOW, 7, -1)))
ok('最后一个切点往后 → null（到头就明说，不偷偷跳回 0）', stepCut(SHOW, 11, 1) === null, String(stepCut(SHOW, 11, 1)))
ok('第一个切点往前 → null', stepCut(SHOW, 3, -1) === null, String(stepCut(SHOW, 3, -1)))
ok('空表两个方向都是 null', stepCut([], 5, 1) === null && stepCut([], 5, -1) === null)
ok(
  '半帧容差以内视为"就在切点上"（0.004 秒的抖动不会把它当成独立位置）',
  // 3 + 0.004 < 3 + CUT_TOL，所以"往后"仍然跳到 7
  stepCut(SHOW, 3 + 0.004, 1) === 7,
  String(stepCut(SHOW, 3 + 0.004, 1))
)
ok(
  '连按往下能把所有切点走一遍，最后停在 null',
  (() => {
    const seen = []
    let at = 0
    for (let i = 0; i < 10; i += 1) {
      const next = stepCut(SHOW, at, 1)
      if (next === null) break
      seen.push(next)
      at = next
    }
    return JOIN(seen) === '[3,7,9,11]'
  })(),
  (() => {
    const seen = []
    let at = 0
    for (let i = 0; i < 10; i += 1) {
      const next = stepCut(SHOW, at, 1)
      if (next === null) break
      seen.push(next)
      at = next
    }
    return JOIN(seen)
  })()
)
ok('CUT_TOL 是半帧的一半以内（小于 1/60 秒，肉眼不可见）', CUT_TOL > 0 && CUT_TOL < 1 / 60, String(CUT_TOL))

console.log('\nC. 内容末点 ===\n')
ok('取最大 end', contentEnd([clip(0, 3), clip(3, 4), clip(9, 2)]) === 11, String(contentEnd(SHOW)))
ok('空表 → 0', contentEnd([]) === 0)
ok('null → 0', contentEnd(null) === 0)
ok('忽略非法项', contentEnd([clip(0, 2), clip('x', 9), null]) === 2, String(contentEnd([clip(0, 2), clip('x', 9), null])))

console.log('\nD. 适配全片的缩放 ===\n')
const BASE = 46 // 与 Timeline.jsx 的 BASE_DPS 一致（这里写死是**故意**的：
// 从被测代码里读期望值等于没测；这个数变了闸门就该红一次，让人回去核对）
const VIEW = 1200
ok(
  '1200px 视口 / 60 秒 → 0.417（(1200-48)/2760）',
  Math.abs(fitZoom(60, VIEW, BASE, { min: 0.05, max: 4 }) - 0.417) < 0.001,
  String(fitZoom(60, VIEW, BASE, { min: 0.05, max: 4 }))
)
ok(
  '算出来的缩放真的能装下（内容宽 × 缩放 + 右侧留白 ≤ 视口）',
  (() => {
    const z = fitZoom(60, VIEW, BASE, { min: 0.05, max: 4 })
    return 60 * BASE * z + 48 <= VIEW
  })()
)
ok(
  '长片撞下限而不是算出 0.007（否则整条时间线缩成一条线）',
  fitZoom(3600, VIEW, BASE, { min: 0.05, max: 4 }) === 0.05,
  String(fitZoom(3600, VIEW, BASE, { min: 0.05, max: 4 }))
)
ok(
  '极短片撞上限而不是放到 25 倍',
  fitZoom(1, VIEW, BASE, { min: 0.05, max: 4 }) === 4,
  String(fitZoom(1, VIEW, BASE, { min: 0.05, max: 4 }))
)
ok('空时间线 → null（不许把 zoom 压成 0.05）', fitZoom(0, VIEW, BASE, { min: 0.05, max: 4 }) === null)
ok('视口还没量出来（0）→ null', fitZoom(60, 0, BASE, { min: 0.05, max: 4 }) === null)
ok('视口比留白还窄 → null', fitZoom(60, 30, BASE, { min: 0.05, max: 4 }) === null)
ok('非法输入 → null', fitZoom('x', VIEW, BASE, { min: 0.05, max: 4 }) === null && fitZoom(60, VIEW, 'y', { min: 0.05, max: 4 }) === null)
ok('上下限缺失/颠倒 → null（宁可不动，也别算出个负数缩放）',
  fitZoom(60, VIEW, BASE, { min: 4, max: 0.05 }) === null && fitZoom(60, VIEW, BASE, {}) === null)
/**
 * 视口从 1200 涨到 2400，缩放增量应当正好是「多出来的宽度 / 内容宽度」= 1200/2760。
 * **不是**两倍 —— 右侧留白是固定值，不随视口走。按"两倍"去写这条断言会红，
 * 而红的那一方是断言、不是实现（这里踩过一次，记一笔免得下次又改错方向）。
 */
ok(
  '视口变宽，缩放按「多出来的宽度 ÷ 内容宽度」线性增长',
  Math.abs(
    fitZoom(60, 2400, BASE, { min: 0.01, max: 8 }) -
      fitZoom(60, 1200, BASE, { min: 0.01, max: 8 }) -
      1200 / (60 * BASE)
  ) < 0.01,
  `${fitZoom(60, 1200, BASE, { min: 0.01, max: 8 })} → ${fitZoom(60, 2400, BASE, { min: 0.01, max: 8 })}`
)
ok(
  '结果保留 3 位小数（滑块拖动/回显不会出现 0.4173913043）',
  String(fitZoom(60, VIEW, BASE, { min: 0.05, max: 4 })).length <= 6,
  String(fitZoom(60, VIEW, BASE, { min: 0.05, max: 4 }))
)

console.log('\nE. 三条能力的接缝 ===\n')
ok(
  '适配用的末点与切点表的末点一致（一个用 contentEnd、一个用 cutPoints，不许两套算法）',
  contentEnd(SHOW) === cutPoints(SHOW).at(-1),
  `${contentEnd(SHOW)} vs ${cutPoints(SHOW).at(-1)}`
)

const total = pass + failures.length
console.log(`\nTIMELINE_NAV_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
console.log(failures.length ? 'TIMELINE_NAV_SELFTEST_FAILED' : 'TIMELINE_NAV_SELFTEST_PASSED')
process.exitCode = failures.length ? 1 : 0
