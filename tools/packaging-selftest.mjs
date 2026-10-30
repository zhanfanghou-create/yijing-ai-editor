/**
 * 智能包装纯逻辑自证 —— 不起 Electron，直接 require shared/packaging.js。
 *
 * 为什么这道闸必须存在：
 *   包装的错法全是**静默**的 —— 判错关键句（该放大的没放大）、放大叠了两次
 *   （1.18 变成 1.39）、清除之后循环动画还在、贴纸压在已有的画中画上。
 *   这些在界面上都只表现成"看着有点怪"，没有一处会报错，也没法对着截图判断。
 *   所以把判定、加成、回滚三条都放进夹具里逐条对。
 *
 * 输出：PACKAGING_SELFTEST_PASSED / PACKAGING_SELFTEST_FAILED
 *       + 「PACKAGING_SELFTEST_STATS total=N pass=P fail=F」
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PACK = require('../packages/desktop/src/shared/packaging.js')
const TEXT = require('../packages/desktop/src/shared/textStyles.json')

let pass = 0
const failures = []
function ok(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps

const STYLE_KEYS = new Set((TEXT.styles || []).map((s) => s.key))
const STICKER_POOLS = {
  spark: ['spark-2728', 'spark-2b50', 'spark-1f31f'],
  party: ['party-1f389', 'party-1f38a'],
  mark: ['mark-2705', 'mark-2757'],
  hand: ['hand-1f44d']
}

/** 造一条字幕片段（字段与 App 的 addTextClip 一致） */
const sub = (id, text, start, duration, extra = {}) => ({
  id,
  track: 'text',
  assetId: '',
  name: text.slice(0, 12),
  url: '',
  path: '',
  kind: 'text',
  text,
  textSize: 32,
  textStyle: 'sub-plain',
  start,
  duration,
  offset: 0,
  sourceDuration: 0,
  ...extra
})

/** 把 patches 真应用到片段表上（含 drop 删键），用来验证"包装 → 清除"能原样回去 */
function applyPatch(clips, item) {
  return clips.map((clip) => {
    if (!clip || clip.id !== item.id) return clip
    const next = { ...clip, ...(item.patch || {}) }
    for (const key of item.drop || []) delete next[key]
    return next
  })
}
function applySet(clips, item) {
  return clips.map((clip) => {
    if (!clip || clip.id !== item.id) return clip
    const next = { ...clip, ...(item.set || {}) }
    for (const key of item.drop || []) delete next[key]
    return next
  })
}

/* ------------------------------------------------------------------ 数据面 */
console.log('\n[1] 数据面（风格 / 强度 / 词库）')
{
  ok('四种包装风格', PACK.PACK_STYLES.length === 4, PACK.PACK_STYLES.map((s) => s.name).join(' / '))
  ok(
    '每种风格都指向真实存在的文字样式 key',
    PACK.PACK_STYLES.every((s) => STYLE_KEYS.has(s.style)),
    PACK.PACK_STYLES.map((s) => `${s.key}→${s.style}`).join(' ')
  )
  ok(
    '风格的 key 与中文名都不重复、没有空值',
    new Set(PACK.PACK_STYLES.map((s) => s.key)).size === 4 &&
      new Set(PACK.PACK_STYLES.map((s) => s.name)).size === 4 &&
      PACK.PACK_STYLES.every((s) => s.key && s.name && s.hint)
  )
  ok(
    '极简白是唯一不配贴纸的一套（"不抢画面"必须真的什么都不加）',
    PACK.PACK_STYLES.filter((s) => !s.sticker).length === 1 &&
      PACK.PACK_STYLES.find((s) => !s.sticker).key === 'plain-white'
  )

  const scales = PACK.PACK_LEVELS.map((l) => l.emphScale)
  ok('三档强度', PACK.PACK_LEVELS.length === 3, PACK.PACK_LEVELS.map((l) => `${l.name}${l.emphScale}`).join(' '))
  ok(
    '强度越高放大越多、配贴纸越密（两列都得单调）',
    scales[0] < scales[1] && scales[1] < scales[2] &&
      PACK.PACK_LEVELS[0].every > PACK.PACK_LEVELS[1].every &&
      PACK.PACK_LEVELS[1].every > PACK.PACK_LEVELS[2].every,
    `emph=${scales.join(',')} every=${PACK.PACK_LEVELS.map((l) => l.every).join(',')}`
  )
  ok(
    '放大倍数落在合理区间（>1 且 ≤1.5，超过 1.5 会顶出画布）',
    scales.every((s) => s > 1 && s <= 1.5)
  )

  const all = Object.values(PACK.BANK).flat()
  ok('三类词库都非空', Object.values(PACK.BANK).every((list) => list.length >= 10),
    Object.entries(PACK.BANK).map(([k, v]) => `${k}:${v.length}`).join(' '))
  ok('词库没有空串', all.every((w) => typeof w === 'string' && w.length > 0))
  ok(
    '词库没有重复词（重复会让同一个词被算两次分）',
    new Set(all).size === all.length,
    all.length - new Set(all).size ? `${all.length - new Set(all).size} 个重复` : ''
  )
}

/* ------------------------------------------------------------ 关键句判定 */
console.log('\n[2] 关键句判定')
{
  const hype = PACK.analyzeLine('这个方法真的绝了')
  ok('情绪词命中 → 判为关键句', hype.score >= PACK.KEY_SCORE, `score=${hype.score} hits=${hype.hits.map((h) => h.word).join(',')}`)
  ok('命中词里含「绝了」', hype.hits.some((h) => h.word === '绝了'))

  const plain = PACK.analyzeLine('今天下午我们去拍一段素材')
  ok('平铺直叙的句子不判关键句', plain.score < PACK.KEY_SCORE, `score=${plain.score}`)

  const money = PACK.analyzeLine('限时五折，立省300元')
  ok(
    '折扣 / 价格这类量化信息判关键句',
    money.score >= PACK.KEY_SCORE,
    `score=${money.score} hits=${money.hits.map((h) => h.word).join(',')}`
  )

  const pct = PACK.analyzeLine('转化率提升了 35%')
  ok('「数字 + 百分号」不用进词库也能认出来', pct.hits.some((h) => h.label === '百分比'), `hits=${pct.hits.map((h) => h.word).join(',')}`)

  const long = PACK.analyzeLine('我花了整整三个星期把这条片子从头到尾重剪了一遍')
  ok('长句 +1（信息密度高）', long.reasons.includes('句子较长（信息密度高）'), `score=${long.score}`)

  const bang = PACK.analyzeLine('别再踩这个坑了！')
  ok('感叹号加成 且「别再」命中', bang.score >= PACK.KEY_SCORE && bang.reasons.includes('有感叹号'), `score=${bang.score}`)

  const twice = PACK.analyzeLine('一倍 一倍 一倍')
  ok(
    '同一个词出现多次只算一次分（"一倍"连写在词库里也只算一次）',
    twice.hits.filter((h) => h.word === '一倍').length === 1,
    `hits=${twice.hits.map((h) => h.word).join(',')}`
  )

  const nested = PACK.analyzeLine('你千万别这么干')
  ok(
    '被长词吃掉的短词不再单独计分（命中「千万别」就不再说「别」）',
    nested.hits.some((h) => h.word === '千万别') && !nested.hits.some((h) => h.word === '别'),
    `hits=${nested.hits.map((h) => h.word).join(',')}`
  )

  ok('空串不炸、也不判关键句', PACK.analyzeLine('').score === 0 && PACK.analyzeLine('').hits.length === 0)
  ok('null / undefined 也不炸', PACK.analyzeLine(null).score === 0 && PACK.analyzeLine(undefined).score === 0)
}

/* -------------------------------------------------------------- 片段判定 */
console.log('\n[3] 只认字幕片段')
{
  ok('文字轨纯文字 = 字幕', PACK.isSubtitleClip(sub('a', '你好', 0, 2)) === true)
  ok('带素材文件的文字轨片段不算（那是导入的字幕块还是素材，口径与渲染侧一致）', PACK.isSubtitleClip(sub('b', '你好', 0, 2, { assetId: 'x' })) === false)
  ok('叠加轨的贴纸不算', PACK.isSubtitleClip({ id: 'c', track: 'overlay', kind: 'image', url: 'x' }) === false)
  ok('空白正文不算', PACK.isSubtitleClip(sub('d', '   ', 0, 2)) === false)
  ok('null 不算', PACK.isSubtitleClip(null) === false)
}

/* -------------------------------------------------------------- 打包方案 */
console.log('\n[4] 打包方案：改什么、放大多少')
{
  const clips = [
    sub('s1', '今天给大家分享一个方法', 0, 2),
    sub('s2', '这个方法真的绝了！', 2, 2),
    sub('s3', '限时五折立省300元', 4, 2)
  ]
  const plan = PACK.planPackaging(clips, { style: 'web-yellow', level: 'normal', stickerKeys: STICKER_POOLS })
  ok('每条字幕都有一条 patch', plan.patches.length === 3, `${plan.patches.length} 条`)
  ok(
    '全部换成所选风格的文字样式',
    plan.patches.every((p) => p.patch.textStyle === 'art-yellow-solid'),
    plan.patches.map((p) => p.patch.textStyle).join(',')
  )
  ok(
    '关键句放大到该档强度、普通句回到 1（不叠乘）',
    near(plan.patches[1].patch.textScale, 1.18) &&
      near(plan.patches[2].patch.textScale, 1.18) &&
      near(plan.patches[0].patch.textScale, 1),
    `s1=${plan.patches[0].patch.textScale} s2=${plan.patches[1].patch.textScale} s3=${plan.patches[2].patch.textScale}`
  )
  ok(
    '只有关键句挂循环，普通句明确写 none',
    plan.patches[1].patch.textLoop === 'breathe' &&
      plan.patches[2].patch.textLoop === 'breathe' &&
      plan.patches[0].patch.textLoop === 'none'
  )
  ok(
    '每条 patch 都带 pack.prev，且记的是**改之前**的原值',
    plan.patches.every((p) => p.patch.pack && p.patch.pack.prev.textStyle === 'sub-plain')
  )
  ok('summary 说清识别到几条、几句关键', plan.summary.lines === 3 && plan.summary.keys === 2, JSON.stringify(plan.summary))
}

/* ------------------------------------------------------- 幂等：不叠乘 */
console.log('\n[5] 重复包装不叠乘')
{
  const clips = [sub('s1', '这个方法真的绝了', 0, 2)]
  const once = PACK.planPackaging(clips, { style: 'show-red', level: 'normal' })
  const packed = applyPatch(clips, { id: 's1', patch: once.patches[0].patch })
  const twice = PACK.planPackaging(packed, { style: 'show-red', level: 'normal' })
  ok(
    '第二次包装的放大倍数与第一次相同（不是 1.18×1.18）',
    near(twice.patches[0].patch.textScale, once.patches[0].patch.textScale),
    `${once.patches[0].patch.textScale} → ${twice.patches[0].patch.textScale}`
  )
  ok(
    '第二次包装记下的 prev 仍是**最初**的样式（不会被上一次的结果污染）',
    twice.patches[0].patch.pack.prev.textStyle === 'sub-plain',
    String(twice.patches[0].patch.pack.prev.textStyle)
  )
  const third = PACK.planPackaging(packed, { style: 'tech-blue', level: 'heavy' })
  ok('换风格再包装：prev 仍是最初的样式', third.patches[0].patch.pack.prev.textStyle === 'sub-plain')
  ok('换风格再包装：样式真的换过去了', third.patches[0].patch.textStyle === 'art-blue-glow')
}

/* ------------------------------------------------------------ 贴纸匹配 */
console.log('\n[6] 贴纸匹配：配哪组、不压别人')
{
  const clips = [
    sub('s1', '这个方法真的绝了', 0, 2),
    sub('s2', '限时五折立省300元', 2, 2),
    sub('s3', '别再踩这个坑了！', 4, 2)
  ]
  const yellow = PACK.planPackaging(clips, { style: 'web-yellow', level: 'heavy', stickerKeys: STICKER_POOLS })
  ok('网感黄配的是 spark 组', yellow.stickers.every((s) => s.key.startsWith('spark-')), yellow.stickers.map((s) => s.key).join(','))
  ok('重的强度：三句关键句各配一枚', yellow.stickers.length === 3, `${yellow.stickers.length} 枚`)
  ok(
    '贴纸落在各自那句字幕的时间范围内',
    yellow.stickers.every((s) => {
      const line = clips.find((c) => c.id === s.forClip)
      return s.at >= line.start - 1e-6 && s.at + s.duration <= line.start + line.duration + 1e-6
    })
  )
  ok('相邻两枚不用同一个锚点（否则叠在一角）', yellow.stickers[0].anchor !== yellow.stickers[1].anchor)

  const white = PACK.planPackaging(clips, { style: 'plain-white', level: 'heavy', stickerKeys: STICKER_POOLS })
  ok('极简白一枚都不配', white.stickers.length === 0)
  ok('极简白仍然做了文字包装', white.patches.length === 3)

  const light = PACK.planPackaging(clips, { style: 'show-red', level: 'light', stickerKeys: STICKER_POOLS })
  ok('轻的强度：三条关键句只配一枚（隔 3 条）', light.stickers.length === 1, `${light.stickers.length} 枚`)

  /* 已经被画中画占住的时间段：贴纸要往后让，让不开就跳过 —— 不能压上去 */
  const busyClips = [...clips, { id: 'p1', track: 'overlay', kind: 'image', url: 'x', start: 0, duration: 0.4 }]
  const shifted = PACK.planPackaging(busyClips, { style: 'web-yellow', level: 'heavy', stickerKeys: STICKER_POOLS })
  const first = shifted.stickers.find((s) => s.forClip === 's1')
  ok(
    '已占用的时间段：贴纸起点被推到那条之后（不叠在别人身上）',
    Boolean(first) && first.at >= 0.4 - 1e-6,
    first ? `at=${first.at}` : '(没配到)'
  )
  const noRoom = PACK.planPackaging(
    [...clips, { id: 'p2', track: 'overlay', kind: 'image', url: 'x', start: 0, duration: 1.9 }],
    { style: 'web-yellow', level: 'heavy', stickerKeys: STICKER_POOLS }
  )
  ok('让不开就整枚跳过（不生成一条压在别人身上的贴纸）', !noRoom.stickers.some((s) => s.forClip === 's1'))

  ok('不传贴纸清单 = 只做文字包装', PACK.planPackaging(clips, { style: 'web-yellow' }).stickers.length === 0)

  /* 主轨一直有画面 —— 它**不是**"被占用"。把它算进去会让每枚贴纸都撞车、
     全被推到句尾之外，最后一条都配不出来（真机上就是这样，一条贴纸都没有） */
  const withVideo = PACK.planPackaging(
    [...clips, { id: 'v1', track: 'video', kind: 'video', url: 'x', start: 0, duration: 6 }],
    { style: 'web-yellow', level: 'heavy', stickerKeys: STICKER_POOLS }
  )
  ok(
    '主轨有画面不算"占用"（贴纸本来就压在画面上）',
    withVideo.stickers.length === 3,
    `${withVideo.stickers.length} 枚`
  )
  ok(
    '清单里缺这一组 = 只做文字包装（不抛错）',
    PACK.planPackaging(clips, { style: 'web-yellow', stickerKeys: { party: ['party-1f389'] } }).stickers.length === 0
  )
}

/* -------------------------------------------------------------- 区间 */
console.log('\n[7] 只包装区间内的字幕')
{
  const clips = [sub('s1', '绝了', 0, 2), sub('s2', '真的绝了', 5, 2), sub('s3', '还是绝了', 10, 2)]
  const plan = PACK.planPackaging(clips, { style: 'web-yellow', start: 4, end: 8 })
  ok('只挑落在 4~8 秒的那条', plan.patches.length === 1 && plan.patches[0].id === 's2', plan.patches.map((p) => p.id).join(','))
  ok('区间外的字幕一条都没动', !plan.patches.some((p) => p.id === 's1' || p.id === 's3'))
  const all = PACK.planPackaging(clips, { style: 'web-yellow' })
  ok('不给区间 = 全轨', all.patches.length === 3)
}

/* --------------------------------------------------------- 清除与还原 */
console.log('\n[8] 清除包装：能原样回去')
{
  const clips = [
    sub('s1', '这个方法真的绝了', 0, 2, { textIn: 'zoom', textInDur: 0.6, textLoop: 'sway' }),
    sub('s2', '今天下午拍素材', 2, 2)
  ]
  const plan = PACK.planPackaging(clips, { style: 'web-yellow', level: 'heavy', stickerKeys: STICKER_POOLS })
  let packed = clips
  for (const item of plan.patches) packed = applyPatch(packed, item)
  ok('包装之后 s1 的入场被换成包装的入场', packed[0].textIn === 'up' && packed[0].textLoop === 'breathe')

  const strip = PACK.planStrip(packed)
  let back = packed
  for (const item of strip.patches) back = applySet(back, item)
  ok('清除之后：样式回到原样式', back[0].textStyle === 'sub-plain')
  ok(
    '清除之后：入场 / 循环回到用户原来的设定（zoom + sway）',
    back[0].textIn === 'zoom' && back[0].textLoop === 'sway',
    `${back[0].textIn} / ${back[0].textLoop}`
  )
  ok(
    '清除之后：原本没有的 textScale 键被**删掉**（不是留个 1 在那儿）',
    !Object.prototype.hasOwnProperty.call(back[1], 'textScale')
  )
  ok('清除之后：pack 标记被删干净', !('pack' in back[0]) && !('pack' in back[1]))
  ok('清除清单里没有"没包装过的片段"', strip.patches.every((p) => ['s1', 's2'].includes(p.id)))

  /* 自动贴纸：要能被清掉，而且只清自己加的那些 */
  const withStickers = [
    ...packed,
    { id: 'auto1', track: 'overlay', kind: 'image', url: 'yjai-media://x', start: 0, duration: 1, pack: { auto: true, mode: 'line' } },
    { id: 'user1', track: 'overlay', kind: 'image', url: 'yjai-media://y', start: 3, duration: 1 }
  ]
  const strip2 = PACK.planStrip(withStickers)
  ok('自动贴纸进删除清单', strip2.remove.includes('auto1') && !strip2.remove.includes('user1'))
  ok('用户自己的叠加片段不删', strip2.remove.length === 1)
  ok('没包装过的表：清除是空操作', PACK.planStrip(clips).patches.length === 0 && PACK.planStrip(clips).remove.length === 0)
  ok('null / 空表不炸', PACK.planStrip(null).patches.length === 0 && PACK.planStrip([]).remove.length === 0)
}

/* -------------------------------------------------------------- 统计 */
console.log('\n[9] 面板统计口径')
{
  const clips = [
    sub('s1', '这个方法真的绝了', 0, 2, { pack: { mode: 'line', style: 'web-yellow', prev: {} } }),
    sub('s2', '今天下午拍素材', 2, 2),
    { id: 'auto1', track: 'overlay', kind: 'image', url: 'x', start: 0, duration: 1, pack: { auto: true, mode: 'line' } }
  ]
  const stat = PACK.analyzeTrack(clips)
  ok('字幕条数只数文字轨', stat.total === 2, `${stat.total}`)
  ok('关键句数对了（1 条）', stat.keys.length === 1, stat.keys.map((k) => k.id).join(','))
  ok('已包装条数读 pack.style', stat.packed === 1, `${stat.packed}`)
  ok('自动贴纸条数读 pack.auto', stat.autoStickers === 1, `${stat.autoStickers}`)
  ok('空表不炸', PACK.analyzeTrack(null).total === 0 && PACK.analyzeTrack([]).keys.length === 0)
}

/* --------------------------------------------------------- 画面包装 */
console.log('\n[10] 画面包装：主轨统一边框 + 滤镜')
{
  const vid = (id, start, duration, extra = {}) => ({
    id,
    track: 'video',
    assetId: 'a1',
    name: id,
    url: 'yjai-media://x',
    path: 'C:/x.mp4',
    kind: 'video',
    start,
    duration,
    offset: 0,
    sourceDuration: duration,
    ...extra
  })
  const clips = [vid('v1', 0, 3), vid('v2', 3, 3, { border: 'br-crea-neon', filter: 'mono' }), sub('s1', '绝了', 0, 2)]
  const plan = PACK.planScene(clips, { combo: 'film' })
  ok('只改主轨，字幕片段一条都不碰', plan.patches.length === 2 && plan.patches.every((p) => p.id !== 's1'))
  ok('边框与滤镜都换成了该组合的值', plan.patches.every((p) => p.patch.border === 'br-retro-film' && p.patch.filter === 'retro'))
  ok(
    '第二段记下的原值真的是它自己的（不是前一段的）',
    plan.patches[1].patch.pack.prev.border === 'br-crea-neon' &&
      plan.patches[1].patch.pack.prev.filter === 'mono'
  )
  ok(
    '第一段原本压根没有 border 键，原值记成 undefined（清除时才能删掉这个键，而不是留个空串）',
    plan.patches[0].patch.pack.prev.border === undefined
  )

  const packed = clips.map((clip) => {
    const hit = plan.patches.find((p) => p.id === clip.id)
    return hit ? { ...clip, ...hit.patch } : clip
  })
  const strip = PACK.planStrip(packed, 'scene')
  ok('清除画面包装：只清主轨那两段', strip.patches.length === 2)
  const back = packed.map((clip) => {
    const hit = strip.patches.find((p) => p.id === clip.id)
    if (!hit) return clip
    const next = { ...clip, ...hit.set }
    for (const key of hit.drop) delete next[key]
    return next
  })
  ok('清除之后：原本有边框那段的边框回来了', back[1].border === 'br-crea-neon' && back[1].filter === 'mono')
  ok('清除之后：原本没边框那段连 border 键都没有了', !('border' in back[0]))
  ok('清除之后：pack 标记被删干净', !('pack' in back[0]))

  /* 两个面板各清各的：口播面板的「清除」不能把画面包装一起清掉 */
  const mixed = [
    ...packed,
    sub('s9', '绝了', 5, 2, { pack: { mode: 'line', style: 'web-yellow', prev: { textStyle: 'sub-plain' } } })
  ]
  const lineStrip = PACK.planStrip(mixed, 'line')
  ok(
    '口播包装的「清除」不碰画面包装（只清字幕那一条）',
    lineStrip.patches.length === 1 && lineStrip.patches[0].id === 's9'
  )
  ok('画面包装的「清除」不碰口播包装', PACK.planStrip(mixed, 'scene').patches.length === 2)

  ok(
    '未知组合 key 回落到第一款（不会把 border 写成 undefined）',
    PACK.planScene(clips, { combo: 'nope' }).patches.every((p) => p.patch.border === 'br-basic-white')
  )

  const stat = PACK.analyzeScene(mixed)
  ok('画面统计：主轨 2 段、都已包装', stat.total === 2 && stat.packed === 2, JSON.stringify(stat))
  ok('画面统计：字幕片段不算进主轨', PACK.analyzeScene([sub('x', '绝了', 0, 1)]).total === 0)
}

/* -------------------------------------------------------------- 兜底 */
console.log('\n[11] 脏输入兜底')
{
  ok('未知风格 key 回落到第一款', PACK.planPackaging([sub('s1', '绝了', 0, 2)], { style: 'nope' }).summary.style === 'web-yellow')
  ok('未知强度 key 回落到「标准」', PACK.planPackaging([sub('s1', '绝了', 0, 2)], { level: 'nope' }).summary.level === 'normal')
  ok('空片段表得到空方案', PACK.planPackaging([], {}).patches.length === 0)
  ok('null 片段表不炸', PACK.planPackaging(null, {}).patches.length === 0)
  ok('样式表里没有的 key 也能给一个合理字号', PACK.styleSize('nope') === 40, `${PACK.styleSize('nope')}`)
  const huge = Array.from({ length: 260 }, (_, i) => sub(`s${i}`, '绝了', i, 1))
  ok('一次最多处理 200 条（防止手滑把整轨上千条一起套）', PACK.planPackaging(huge, {}).patches.length === 200)
}

const total = pass + failures.length
console.log(`\nPACKAGING_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
console.log(failures.length ? 'PACKAGING_SELFTEST_FAILED' : 'PACKAGING_SELFTEST_PASSED')
process.exitCode = failures.length ? 1 : 0
