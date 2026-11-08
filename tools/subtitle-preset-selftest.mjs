#!/usr/bin/env node
/**
 * 字幕预设（857 款口播动态排版）的自证夹具。
 *
 * 为什么值得单开一道：这一层的错法**全是静默的**，而且错完看起来"功能是好的"。
 *
 *   ① **键名写错**。片段上要落的是 `textIn/textOut/textAnchor/textOffset/textAlign/
 *      textScale`（见 shared/textAnim.js 与 shared/textOverrides.js）。写成 `anim`、
 *      `anchor`、`align`（预设对象里的名字）也能存进草稿，界面不报错、时间线上也
 *      真出现一条字幕 —— 只是落点还在底部、也没有入场动画。判据只能读**消费端读的键**。
 *   ② **多行当多条**。曾经把「举例3点」拆成三条片段（每块一拍），
 *      而名字说的是一屏并列三点。判据 = 多行预设必须产出**1 条**片段、正文里含 `\n`。
 *   ③ **清单与分组漂移**。分组 count 是生成时数出来的，界面拿它做 chip 上的数字；
 *      清单被改过而 counts 没跟着改，用户会看到"写着 318、点进去 317 张卡"。
 *   ④ **样式 key 不存在**。落在 `subStyles.json` 之外的 key 会让 `textStyleDef` 退回
 *      fallback —— 857 款里那一批全变成同一个样子，而谁都不报错。
 *
 * 判据一律对**真源**（textStyles.json / textAnim.js 的动画表），不从被测函数反算期望值。
 *
 * 输出：SUBTITLE_PRESET_SELFTEST_PASSED / _FAILED
 *       + 「SUBTITLE_PRESET_SELFTEST_STATS total=N pass=P fail=F」
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const presets = require('../packages/desktop/src/shared/subtitlePresets.js')
const textStyles = require('../packages/desktop/src/shared/textStyles.json')
const textAnim = require('../packages/desktop/src/shared/textAnim.js')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  ::  ${detail}`}`)
}

const STYLE_KEYS = new Set(textStyles.styles.map((s) => s.key))
const IN_KEYS = new Set(textAnim.IN_TYPES.map((t) => t.key))
const OUT_KEYS = new Set(textAnim.OUT_TYPES.map((t) => t.key))
const LOOP_KEYS = new Set(textAnim.LOOP_TYPES.map((t) => t.key))

/* ---------------------------------------------- A. 清单本身的完整性 */

check(
  '清单条数与「900 款」这个说法对得上（857 = 素材包里真有 draft 的那些）',
  presets.PRESET_COUNT === 857,
  `实际 ${presets.PRESET_COUNT}`
)

const counted = presets.PRESET_GROUPS.reduce((n, g) => n + g.count, 0)
check('六组 count 之和 = 清单条数（分组的数字不是手写的）', counted === presets.PRESET_COUNT, `${counted} ≠ ${presets.PRESET_COUNT}`)

check('分组是六组（高级排版 / 精选十款 / 名字动画 / 口播覆盖 / 基础动效 / 主图介绍）', presets.PRESET_GROUPS.length === 6, `实际 ${presets.PRESET_GROUPS.length}`)

check(
  '每组 presetsOfGroup 的条数 = 该组 count',
  presets.PRESET_GROUPS.every((g) => presets.presetsOfGroup(g.key).length === g.count),
  presets.PRESET_GROUPS.map((g) => `${g.label}:${presets.presetsOfGroup(g.key).length}/${g.count}`).join(' ')
)

check("presetsOfGroup('all') 与 '' 都返回全量", presets.presetsOfGroup('all').length === 857 && presets.presetsOfGroup('').length === 857)

check('未知分组返回空数组（不抛错、也不退回全量）', presets.presetsOfGroup('nope').length === 0)

{
  const keys = new Set()
  let dup = ''
  for (const p of presets.PRESETS) {
    if (keys.has(p.key)) dup = p.key
    keys.add(p.key)
  }
  check('key 全局唯一', !dup, `重复：${dup}`)
}

{
  const tag = new Set()
  let dup = ''
  for (const p of presets.PRESETS) {
    const k = `${p.group}/${p.name}`
    if (tag.has(k)) dup = k
    tag.add(k)
  }
  check('同组内不重名（重名 = 一对一模一样的卡）', !dup, `重复：${dup}`)
}

/* ---------------------------------------------- B. 参数落在真源的取值范围内 */

check(
  '每款的样式 key 都在 textStyles.json 里（否则退回 fallback，857 款会撞成一片）',
  presets.PRESETS.every((p) => STYLE_KEYS.has(p.style)),
  [...new Set(presets.PRESETS.filter((p) => !STYLE_KEYS.has(p.style)).map((p) => p.style))].join(',')
)

check(
  '每款的入场 / 出场 / 循环都在 textAnim 的动画表里',
  presets.PRESETS.every((p) => IN_KEYS.has(p.in) && OUT_KEYS.has(p.out) && LOOP_KEYS.has(p.loop)),
  [...new Set(presets.PRESETS.filter((p) => !IN_KEYS.has(p.in) || !OUT_KEYS.has(p.out) || !LOOP_KEYS.has(p.loop)).map((p) => `${p.in}/${p.out}/${p.loop}`))].join(',')
)

check(
  '锚点只可能是 top / center / bottom',
  presets.PRESETS.every((p) => ['top', 'center', 'bottom'].includes(p.anchor))
)

check(
  '对齐只可能是 left / center / right',
  presets.PRESETS.every((p) => ['left', 'center', 'right'].includes(p.align))
)

check(
  '文本偏移落在 0..600（与 textOverrides.TEXT_OFFSET_MAX 同界）',
  presets.PRESETS.every((p) => p.offset >= 0 && p.offset <= 600)
)

check(
  '字号倍数落在 0.4..2.5（与 textOverrides 同界）',
  presets.PRESETS.every((p) => p.scale >= 0.4 && p.scale <= 2.5)
)

check('行数 1..3、条数 1..4', presets.PRESETS.every((p) => p.rows >= 1 && p.rows <= 3 && p.chain >= 1 && p.chain <= 4))

check(
  '居中时 offset 一律归零（否则界面会出现"居中了但离顶 200px"这种看不懂的状态）',
  presets.PRESETS.filter((p) => p.anchor === 'center').every((p) => p.offset === 0)
)

/* ---------------------------------------------- C. 名字与参数的关系（规则的落点） */

const byName = (n) => presets.PRESETS.find((p) => p.name === n)

check('「三排字幕」→ 三行（名字说了行数就听名字）', (byName('三排字幕') || {}).rows === 3)

check('「屏幕下方」→ 底部锚点', (byName('温1-2句一短一长屏幕下方') || {}).anchor === 'bottom')

check('「弹出」→ 缩放入场', (byName('毛刺弹出字体') || {}).in === 'zoom')

check('「发光」→ 霓虹发光样式', (byName('发光模糊') || {}).style === 'sub-neon')

check('「覆盖」→ 多条依次（条数 = 行数）', (() => {
  const hit = presets.PRESETS.find((p) => p.name.includes('覆盖') && p.chain > 1)
  return Boolean(hit) && hit.mode === 'seq'
})())

check('「叠加」→ 多条叠着出现（mode=stack）', (() => {
  const hit = byName('三字叠加')
  return Boolean(hit) && hit.chain === 3 && hit.mode === 'stack'
})())

/* ---------------------------------------------- D. blockTexts：多行 ≠ 多条 */

const multiRow = byName('举例3点')
{
  const blocks = presets.blockTexts(multiRow)
  check('多行预设只产出 1 块（"三点"是一屏里的三行，不是三条片段）', blocks.length === 1, `实际 ${blocks.length} 块`)
  check('多行预设的正文里带换行（预览靠 pre-wrap、导出靠 textfile 多行）', blocks[0].split('\n').length === 3, JSON.stringify(blocks[0]))
  check('带「点/序号」的多行写成「1. 第一点」这种可读的分点', blocks[0].startsWith('1. '), JSON.stringify(blocks[0]))
}

{
  const blocks = presets.blockTexts(byName('三字叠加'))
  check('叠加预设产出 3 块、每块一个字（逐字往外蹦）', blocks.length === 3 && blocks.every((t) => t.length === 1), JSON.stringify(blocks))
}

{
  const blocks = presets.blockTexts(byName('便利贴'))
  check('名字动画组的采样文字是「你的名字」而不是字幕句', blocks[0] === '你的名字', blocks[0])
}

/* ---------------------------------------------- E. planPreset：落在消费端读的键上 */

const plan = presets.planPreset(byName('两句话字幕'), { start: 12, idFor: (i) => `c${i}` })
const clip0 = plan.clips[0]

check('planPreset 从给定起点开始（不是永远 0）', clip0.start === 12, `实际 ${clip0.start}`)

check(
  '片段落在字幕轨、kind=text（落错轨会变成一段黑屏素材）',
  clip0.track === 'text' && clip0.kind === 'text',
  `${clip0.track}/${clip0.kind}`
)

const NEEDED = ['textStyle', 'textAnchor', 'textOffset', 'textAlign', 'textScale', 'textIn', 'textOut', 'textLoop', 'textInDur', 'textOutDur']
check(
  '片段带齐消费端读的十个键（少一个就是"点了没变化"，而且不报错）',
  NEEDED.every((k) => clip0[k] !== undefined),
  NEEDED.filter((k) => clip0[k] === undefined).join(',')
)

check(
  '片段上的 textStyle 就是预设的样式（不是退回 sub-plain）',
  clip0.textStyle === byName('两句话字幕').style,
  `${clip0.textStyle} vs ${byName('两句话字幕').style}`
)

check(
  '片段上的 textAnchor 就是预设的锚点（键名对不上 ⇒ 落点永远是底部）',
  clip0.textAnchor === byName('两句话字幕').anchor,
  `${clip0.textAnchor} vs ${byName('两句话字幕').anchor}`
)

check(
  '片段上的入场动画就是预设的入场（键名对不上 ⇒ 永远没有动画）',
  clip0.textIn === byName('两句话字幕').in,
  `${clip0.textIn} vs ${byName('两句话字幕').in}`
)

check('idFor 被真的调用（id 由调用方给，planPreset 不自己造）', clip0.id === 'c0', clip0.id)

/* chain > 1：条数、错峰、总时长 */
{
  const p = byName('四宫格顺序出现')
  const seq = presets.planPreset(p, { start: 0, idFor: (i) => `s${i}` })
  check('多条预设产出的片段数 = chain', seq.clips.length === p.chain, `${seq.clips.length} vs ${p.chain}`)
  const starts = seq.clips.map((c) => c.start)
  check('依次出现的起点严格递增（错峰没生效 ⇒ 四块全叠在第 0 秒）', starts.every((s, i) => i === 0 || s > starts[i - 1]), starts.join(','))
  const last = seq.clips[seq.clips.length - 1]
  check(
    'duration = 最后一块的结束 − 起点（不是把每块时长加起来）',
    Math.abs(seq.duration - (last.start + last.duration)) < 0.001,
    `${seq.duration} vs ${last.start + last.duration}`
  )
  check(
    '错峰间隔 = staggerOf 给出的值（两块之间的距离可复现）',
    Math.abs(starts[1] - starts[0] - presets.staggerOf(p)) < 0.001,
    `${starts[1] - starts[0]} vs ${presets.staggerOf(p)}`
  )
}

{
  const p = byName('三字叠加')
  const st = presets.planPreset(p, { start: 0, idFor: (i) => `x${i}` })
  check(
    '叠加模式的间隔比依次模式短（叠着来才有一串字往外蹦的感觉）',
    presets.staggerOf(p) < presets.staggerOf(byName('四宫格顺序出现')),
    `${presets.staggerOf(p)} vs ${presets.staggerOf(byName('四宫格顺序出现'))}`
  )
  check('叠加模式三块的时间区间互相重叠（不是排成一条队）', st.clips[0].start + st.clips[0].duration > st.clips[1].start)
}

/* 负对照：故意把 chain 写坏 —— 断言必须能红 */
{
  const bad = presets.normalizePreset({ key: 'x', name: 'x', chain: 99, rows: 99, anchor: 'nowhere', align: 'nowhere', scale: 99 })
  check('非法条数 / 行数 / 锚点 / 对齐 / 字号都被夹回合法域（脏数据进不了时间线）',
    bad.chain === 4 && bad.rows === 3 && bad.anchor === 'bottom' && bad.align === 'center' && bad.scale === 2.5,
    JSON.stringify(bad))
}

check(
  'describePreset 写的是中文锚点（卡片悬停提示与 MCP 共用这一句）',
  /底部|居中|顶部/.test(presets.describePreset(byName('三排字幕'))),
  presets.describePreset(byName('三排字幕'))
)

check('presetByKey 找不到时返回 null（调用方可以据此报错，而不是拿到一个空对象）', presets.presetByKey('nope') === null)

/* ---------------------------------------------- 结果 */

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\nSUBTITLE_PRESET_SELFTEST_STATS total=${results.length} pass=${passed} fail=${failed}`)
if (failed) {
  console.log('SUBTITLE_PRESET_SELFTEST_FAILED')
  process.exitCode = 1
} else {
  console.log('SUBTITLE_PRESET_SELFTEST_PASSED')
  process.exitCode = 0
}
