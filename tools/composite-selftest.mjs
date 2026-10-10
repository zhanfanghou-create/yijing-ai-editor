/**
 * 预览合成器的自证夹具。
 *
 * 为什么必须有：合成器算的是「这一帧画面上有哪几层」，它**错了不会报错** ——
 * 画面要么少一层、要么在接缝处黑一帧，而这两种症状在静态扫描里都是全绿的，
 * 连逐像素比对都抓不到（截图永远拍在稳定态）。所以这里逐条钉住：
 *
 *   A. 命中区间（左闭右开，接缝那一帧只归后一段）
 *   B. 热点窗口的量化（窗口必须每 2 秒才跳一格，否则 <video> 每帧挂载/卸载）
 *   C. 层叠顺序（同轨重叠：起点靠后的在上；同起点按创建序号，_2 不能排到 _10 后面）
 *   D. 连续播放：跨片段时前后两层的 id **始终都在** ⇒ 不换 src ⇒ 不黑帧
 *   E. 转场：后一段必须**提前**在 DOM 里，且它的源时间按 progress 推进
 *   F. 音频轨 / 叠加轨取**全部**命中的片段（不是只取一条）
 *   G. 片段音量透到预览层（以前只进导出）
 *   H. 空白处的兜底片段与时间线优先级（视频 > 文字素材 > 音频；字幕只叠不占位）
 *   I. 不变量：任意时刻至多一个主层；层 id 不重复
 *
 * 用法：node tools/composite-selftest.mjs
 */
import {
  HOT_AFTER,
  HOT_BEFORE,
  HOT_STEP,
  cmpId,
  compositeAt,
  effectiveClips,
  hotWindowAt,
  layerOrder,
  overlapsWindow,
  spansAt,
  transitionAt,
  visualCandidates
} from '../packages/desktop/src/renderer/composite.js'
import { replacePatch, sourceTimeAt } from '../packages/desktop/src/renderer/trim.js'

const results = []

function check(label, ok, detail = '') {
  results.push({ label, ok: Boolean(ok) })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
}

const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps
const ids = (list) => (list || []).map((item) => item.id).join(',')
const roles = (list) => (list || []).map((item) => `${item.id}:${item.role}`).join(' ')

console.log('=== 预览合成器自证（纯逻辑夹具）===\n')

/* ------------------------------------------------------------ A. 命中区间 */

console.log('A. 命中区间')

const seg = { id: 'a', track: 'video', start: 5, duration: 4, offset: 30, sourceDuration: 60 }
check('区间内命中', spansAt(seg, 5) && spansAt(seg, 8.9))
check('左边界闭（5.0 归这一段）', spansAt(seg, 5))
check('右边界开（9.0 归后一段，接缝不会同时命中两段）', !spansAt(seg, 9))
check('区间外不命中', !spansAt(seg, 4.99) && !spansAt(seg, 9.01))
check('与热点窗求交', overlapsWindow(seg, 0, 6) && !overlapsWindow(seg, 0, 5) && overlapsWindow(seg, 8, 20))

/* -------------------------------------------------------- B. 热点窗口量化 */

console.log('\nB. 热点窗口量化')

const w0 = hotWindowAt(0.0)
const w1 = hotWindowAt(1.99)
const w2 = hotWindowAt(2.0)
check('同一格内窗口不变（0.0 与 1.99 同格）', w0[0] === w1[0] && w0[1] === w1[1], `${w0} / ${w1}`)
check('跨格才跳（2.0 换一格）', w2[0] !== w0[0], `${w0} → ${w2}`)
check(`窗口覆盖播放头之前 ${HOT_BEFORE}s`, w0[0] === -HOT_BEFORE, String(w0[0]))
check(`窗口覆盖播放头之后至少 ${HOT_AFTER}s`, w0[1] >= HOT_AFTER, String(w0[1]))
check('窗口是 HOT_STEP 的整数倍（元素不会每帧重挂）', w0[0] % HOT_STEP === 0 && w2[0] % HOT_STEP === 0)
check('非数字播放头不产生 NaN 窗口', hotWindowAt(NaN).every((v) => Number.isFinite(v)))

/* ------------------------------------------------------------ C. 层叠顺序 */

console.log('\nC. 层叠顺序')

const lane = [
  { id: 'clip_x_10', track: 'video', start: 5, duration: 3 },
  { id: 'clip_x_2', track: 'video', start: 5, duration: 3 },
  { id: 'clip_x_1', track: 'video', start: 0, duration: 3 }
]
const ordered = layerOrder(lane)
check('起点升序（底 → 顶）', ids(ordered) === 'clip_x_1,clip_x_2,clip_x_10', ids(ordered))
check('同起点按创建序号（_10 在 _2 之上，不能按字典序）', cmpId('clip_x_2', 'clip_x_10') < 0)
check('layerOrder 不改入参', ids(lane) === 'clip_x_10,clip_x_2,clip_x_1')

/* ------------------------------------------- D. 连续播放（这一轮的核心） */

console.log('\nD. 连续播放：跨片段不换元素')

const ASSETS = [
  { id: 'as_a', kind: 'video', name: '甲', url: 'm://a.mp4' },
  { id: 'as_b', kind: 'video', name: '乙', url: 'm://b.mp4' },
  { id: 'as_c', kind: 'video', name: '丙', url: 'm://c.mp4' }
]
const CLIPS = [
  { id: 'c1', track: 'video', assetId: 'as_a', kind: 'video', name: '甲', start: 0, duration: 4, offset: 10, sourceDuration: 30 },
  { id: 'c2', track: 'video', assetId: 'as_b', kind: 'video', name: '乙', start: 4, duration: 4, offset: 20, sourceDuration: 30 },
  { id: 'c3', track: 'video', assetId: 'as_c', kind: 'video', name: '丙', start: 8, duration: 4, offset: 0, sourceDuration: 30 }
]

/** 扫一遍整条时间线，记录"每个时刻挂载了哪些层" */
function scan(step = 0.25) {
  const out = []
  for (let t = 0; t <= 11.75; t += step) out.push({ t, ...compositeAt(CLIPS, ASSETS, t) })
  return out
}
const frames = scan()

const at = (t) => frames.find((f) => Math.abs(f.t - t) < 1e-9)

const before = at(3.75)
const after = at(4.0)
check(
  '接缝前后两层**都**已挂载（换的是显示哪层，不是换 src）',
  ['c1', 'c2'].every((id) => before.layers.some((l) => l.id === id)) &&
    ['c1', 'c2'].every((id) => after.layers.some((l) => l.id === id)),
  `3.75s=${ids(before.layers)} / 4.0s=${ids(after.layers)}`
)
check('接缝前主层是前一段', before.main?.id === 'c1', String(before.main?.id))
check('接缝后主层是后一段', after.main?.id === 'c2', String(after.main?.id))
check(
  '源时间跨片段连续（3.75s→甲 13.75；4.0s→乙 20.0）',
  near(before.main.sourceTime, 13.75) && near(after.main.sourceTime, 20),
  `${before.main.sourceTime} / ${after.main.sourceTime}`
)

/* 预挂载的关键：后一段必须在它出场**之前**就挂上。
   以前是在它成为"当前片段"的那一刻才挂载 ⇒ 解码器刚起步 ⇒ 黑一帧。 */
const firstMountOfC2 = frames.find((f) => f.layers.some((l) => l.id === 'c2'))
const firstVisibleOfC2 = frames.find((f) => f.layers.some((l) => l.id === 'c2' && l.visible))
check(
  '后一段**提前**挂载（挂载时刻早于出场时刻）',
  firstMountOfC2 && firstVisibleOfC2 && firstMountOfC2.t < firstVisibleOfC2.t,
  `挂载于 ${firstMountOfC2?.t}s，出场于 ${firstVisibleOfC2?.t}s`
)
check(
  '提前量不小于一个热点步长（够解码器缓冲）',
  firstVisibleOfC2.t - firstMountOfC2.t >= HOT_STEP,
  `${(firstVisibleOfC2.t - firstMountOfC2.t).toFixed(2)}s`
)

/**
 * 只有**需要解码**的片段才预挂载。
 * 文字素材 / 音频轨的那一层画出来只是一张占位卡，提前挂一堆看不见的占位卡
 * 没有任何收益，反而让"画面上此刻显示的是谁"变得含混（DOM 里同一个选择器能命中好几个）。
 */
const TEXT_ONLY = [
  { id: 'x1', track: 'video', assetId: 'as_a', kind: 'text', name: '文字一', start: 0, duration: 3, offset: 0, sourceDuration: 30 },
  { id: 'x2', track: 'video', assetId: 'as_b', kind: 'text', name: '文字二', start: 3, duration: 3, offset: 0, sourceDuration: 30 }
]
check('占位卡类的片段不预挂载（DOM 里同时只有该显示的那一层）', ids(compositeAt(TEXT_ONLY, ASSETS, 1).layers) === 'x1', ids(compositeAt(TEXT_ONLY, ASSETS, 1).layers))
check('需要解码的片段照样预挂载（视频 / 图片）', compositeAt(CLIPS, ASSETS, 1).layers.length > 1, String(compositeAt(CLIPS, ASSETS, 1).layers.length))

/* -------------------------------------------------------------- E. 转场 */

console.log('\nE. 转场：后一段提前在 DOM 里')

const TR_CLIPS = [
  { id: 't1', track: 'video', assetId: 'as_a', kind: 'video', name: '甲', start: 0, duration: 5, offset: 0, sourceDuration: 30, transition: 'fade', transitionDuration: 1 },
  { id: 't2', track: 'video', assetId: 'as_b', kind: 'video', name: '乙', start: 5, duration: 5, offset: 0, sourceDuration: 30 }
]
const tr = transitionAt(TR_CLIPS, 4.5)
check('交叠窗口内拿到转场', Boolean(tr) && tr.key === 'fade', JSON.stringify(tr))
check('进度按窗口推进（4.5s 距 4.0s 半个时长）', tr && near(tr.progress, 0.5), String(tr?.progress))
check('后一段的源时间 = 入点 + progress × 时长', tr && near(tr.incomingSourceTime, 0.5), String(tr?.incomingSourceTime))
check('窗口外无转场（3.9s / 5.0s）', transitionAt(TR_CLIPS, 3.9) === null && transitionAt(TR_CLIPS, 5.0) === null)

const mid = compositeAt(TR_CLIPS, ASSETS, 4.5)
const incoming = mid.layers.find((l) => l.role === 'incoming')
check('转场中后一段以 incoming 层在场', Boolean(incoming), roles(mid.layers))
check('incoming 层带 xfade（key + progress）', incoming?.xfade?.key === 'fade' && near(incoming.xfade.progress, 0.5))
check('转场中主层仍是前一段（播放头还压在前一段那一格上）', mid.main?.id === 't1', String(mid.main?.id))
check('转场中前一段的源时间照常推进（4.5s）', near(mid.main.sourceTime, 4.5), String(mid.main.sourceTime))

/* -------------------------------------------- F. 音频轨 / 叠加轨取全部 */

console.log('\nF. 音频轨与叠加轨')

const MULTI = [
  { id: 'v1', track: 'video', assetId: 'as_a', kind: 'video', name: '甲', start: 0, duration: 10, offset: 0, sourceDuration: 30 },
  { id: 'b1', track: 'audio', assetId: 'as_b', kind: 'audio', name: '配乐一', start: 0, duration: 6, offset: 0, sourceDuration: 30, gain: 40 },
  { id: 'b2', track: 'audio', assetId: 'as_c', kind: 'audio', name: '配乐二', start: 3, duration: 6, offset: 0, sourceDuration: 30, gain: 70 },
  { id: 'p1', track: 'overlay', assetId: 'as_b', kind: 'video', name: '画中画一', start: 1, duration: 3, offset: 0, sourceDuration: 30, pip: { anchor: 'left-top', size: 25 } },
  { id: 'p2', track: 'overlay', assetId: 'as_c', kind: 'image', name: '画中画二', start: 2, duration: 3, offset: 0, pip: { anchor: 'bottom-right', size: 35 } }
]
const both = compositeAt(MULTI, ASSETS, 3.5)
check('重叠的两条配乐**都**在（不是只取一条）', ids(both.audio) === 'b1,b2', ids(both.audio))
check('配乐的音量各自透出（40 / 70）', both.audio.map((a) => a.gain).join(',') === '40,70')
check('重叠的两个画中画**都**在', ids(both.pip) === 'p1,p2', ids(both.pip))
check('画中画带自己的锚点与尺寸', both.pip[0].anchor === 'left-top' && both.pip[0].size === 25, JSON.stringify(both.pip[0]))
check('画中画锚点写错/缺省时退回默认锚点（不让画面飞出画布）', (() => {
  const dirty = [{ ...MULTI[3], pip: { anchor: 'top-left', size: 999 } }]
  const shot = compositeAt(dirty, ASSETS, 2)
  return shot.pip[0].anchor === 'right-bottom' && shot.pip[0].size === 60
})())
check('错开之后只剩各自的（t=7.5 无画中画、只剩配乐二）', compositeAt(MULTI, ASSETS, 7.5).pip.length === 0 && ids(compositeAt(MULTI, ASSETS, 7.5).audio) === 'b2')

/* -------------------------------------------------------------- G. 音量 */

console.log('\nG. 片段音量进预览')

const gainClip = [{ id: 'g1', track: 'video', assetId: 'as_a', kind: 'video', name: '甲', start: 0, duration: 5, offset: 0, sourceDuration: 30, gain: 25 }]
check('片段 gain 透到画面层（以前只进导出，预览完全没接）', compositeAt(gainClip, ASSETS, 1).main.gain === 25)
check('没设 gain 的片段按 100（原音量）', compositeAt(CLIPS, ASSETS, 1).main.gain === 100)

/* ------------------------------------------ H. 优先级 / 兜底 / 字幕分层 */

console.log('\nH. 优先级、兜底与字幕分层')

const MIXED = [
  { id: 'mv', track: 'video', assetId: 'as_a', kind: 'video', name: '画面', start: 0, duration: 2, offset: 0, sourceDuration: 30 },
  { id: 'mt', track: 'text', assetId: 'as_b', kind: 'text', name: '文字素材', start: 1, duration: 4, offset: 0, sourceDuration: 30 },
  { id: 'ma', track: 'audio', assetId: 'as_c', kind: 'audio', name: '配乐', start: 1, duration: 4, offset: 0, sourceDuration: 30 },
  { id: 'ms', track: 'text', kind: 'text', name: '字幕', text: '你好', start: 1, duration: 4, textStyle: 'sub-bar' }
]
check('视频优先（1.5s 三层同时在场时取视频）', visualCandidates(MIXED, 1.5)[0]?.id === 'mv')
check('无视频时退到文字素材（2.5s）', visualCandidates(MIXED, 2.5)[0]?.id === 'mt')
check('再退到音频（只有音频时）', visualCandidates(MIXED.filter((c) => c.id !== 'mt'), 2.5)[0]?.id === 'ma')
check(
  '字幕（无 assetId）不当画面、只进叠加层',
  !compositeAt(MIXED, ASSETS, 1.5).layers.some((l) => l.id === 'ms') &&
    compositeAt(MIXED, ASSETS, 1.5).text.some((item) => item.id === 'ms')
)
check('字幕轨可以有多条同时在场', (() => {
  const two = [...MIXED, { id: 'ms2', track: 'text', kind: 'text', name: '字幕二', text: '第二行', start: 1.5, duration: 2, textStyle: 'sub-neon' }]
  return compositeAt(two, ASSETS, 2).text.length === 2
})())

const blank = compositeAt(CLIPS, ASSETS, 20)
check('时间线空白处主层为空（不是硬凑一个）', blank.main === null, String(blank.main))
const fallback = compositeAt(CLIPS, ASSETS, 20, { fallbackClip: CLIPS[1] })
check('给兜底片段时画面退回它（点一下也能看一眼）', fallback.main?.id === 'c2', String(fallback.main?.id))
check('兜底片段的源时间夹到末帧（不越界）', near(fallback.main.sourceTime, sourceTimeAt(CLIPS[1], 20)), String(fallback.main.sourceTime))

/* ------------------------------------------------------------ I. 不变量 */

console.log('\nI. 不变量')

const mine = compositeAt(MULTI, ASSETS, 5)
check('任意时刻至多一个主层', mine.layers.filter((l) => l.role === 'main').length === 1)
check('层 id 不重复', new Set(mine.layers.map((l) => l.id)).size === mine.layers.length)
check('同一时刻重复调用结果一致（无隐藏状态）', ids(compositeAt(MULTI, ASSETS, 5).layers) === ids(mine.layers))

/* 同一轨重叠：两层都要在，且起点靠后的在上 */
const OVERLAP = [
  { id: 'o1', track: 'video', assetId: 'as_a', kind: 'video', name: '先摆的', start: 0, duration: 6, offset: 0, sourceDuration: 30 },
  { id: 'o2', track: 'video', assetId: 'as_b', kind: 'video', name: '后摆的', start: 3, duration: 6, offset: 0, sourceDuration: 30 }
]
const ov = compositeAt(OVERLAP, ASSETS, 4)
check('同轨重叠：两层都可见（重叠部分不会凭空少一层）', ov.layers.filter((l) => l.visible).length === 2, roles(ov.layers))
check('同轨重叠：起点靠后的在上（后摆的压住先摆的）', ov.main?.id === 'o2', String(ov.main?.id))

/* 随机扫描：整条时间线上逐点查不变量（固定步长，可复现） */
let invariantBad = 0
let mainBad = 0
for (let t = 0; t <= 12.0001; t += 0.1) {
  const shot = compositeAt(CLIPS, ASSETS, t)
  if (new Set(shot.layers.map((l) => l.id)).size !== shot.layers.length) invariantBad += 1
  if (shot.layers.filter((l) => l.role === 'main').length > 1) invariantBad += 1
  if (shot.main && !near(shot.main.sourceTime, sourceTimeAt(CLIPS.find((c) => c.id === shot.main.id), t), 1e-6)) mainBad += 1
}
check('逐点扫描：层 id 唯一且主层唯一', invariantBad === 0, `违例 ${invariantBad} 处`)
check('逐点扫描：主层源时间恒等于 sourceTimeAt（预览与导出同一套算术）', mainBad === 0, `偏差 ${mainBad} 处`)

/* 退化输入 */
check('空时间线不抛且无层', compositeAt([], [], 3).layers.length === 0)
/**
 * 片段没记 assetId 时**不能**错配到素材表的第一条。
 * `item.id === undefined` 会命中第一个没带 id 的素材 ⇒ 好几段去播同一个素材，
 * 不报错也不空屏，只是"画面不对"，是最难查的那一类。
 */
check('片段缺 assetId 时退回片段自己的 url（不去素材表乱配）', (() => {
  const bare = [
    { id: 'n1', track: 'video', url: 'm://one.mp4', kind: 'video', name: '一', start: 0, duration: 3, offset: 0, sourceDuration: 3 },
    { id: 'n2', track: 'video', url: 'm://two.mp4', kind: 'video', name: '二', start: 3, duration: 3, offset: 0, sourceDuration: 3 }
  ]
  const noId = [{ id: 'as_x', kind: 'video', name: '素材表第一条', url: 'm://wrong.mp4' }]
  const shot = compositeAt(bare, noId, 1)
  return shot.main.url === 'm://one.mp4'
})())
check('片段缺 assetId 时各段各播各的（不会都播第一条）', (() => {
  const bare = [
    { id: 'n1', track: 'video', url: 'm://one.mp4', kind: 'video', name: '一', start: 0, duration: 3, offset: 0, sourceDuration: 3 },
    { id: 'n2', track: 'video', url: 'm://two.mp4', kind: 'video', name: '二', start: 3, duration: 3, offset: 0, sourceDuration: 3 }
  ]
  const noId = [{ id: 'as_x', kind: 'video', name: '素材表第一条', url: 'm://wrong.mp4' }]
  return new Set(compositeAt(bare, noId, 1).layers.map((l) => l.url)).size === 2
})())
check('素材表缺失时 url 为空但不抛', compositeAt(CLIPS, [], 1).main.url === '' || compositeAt(CLIPS, [], 1).main.url === 'm://a.mp4')
check('playhead 为 NaN 时不抛', compositeAt(CLIPS, ASSETS, NaN).layers.length >= 0)

/* ------------------------------------------------------------------ J. 轨道开关与停用片段 */

check('停用片段退出合成（enabled=false）', (() => {
  const list = [
    { id: 'd1', track: 'video', url: 'm://a.mp4', start: 0, duration: 3, enabled: false },
    { id: 'd2', track: 'video', url: 'm://b.mp4', start: 3, duration: 3 }
  ]
  return ids(effectiveClips(list, {})) === 'd2'
})())
check('隐藏轨整轨退出合成', (() => {
  const list = [
    { id: 'h1', track: 'video', url: 'm://a.mp4', start: 0, duration: 3 },
    { id: 'h2', track: 'overlay', url: 'm://b.mp4', start: 0, duration: 3 }
  ]
  return ids(effectiveClips(list, { hidden: ['overlay'] })) === 'h1'
})())
check('静音只静音音频轨，视频片段不动', (() => {
  const list = [
    { id: 'm1', track: 'audio', url: 'm://a.mp3', start: 0, duration: 3 },
    { id: 'm2', track: 'video', url: 'm://b.mp4', start: 0, duration: 3 }
  ]
  return ids(effectiveClips(list, { muted: ['audio'] })) === 'm2'
})())
check('锁定轨不参与结算（锁的是编辑不是播放）', (() => {
  const list = [{ id: 'l1', track: 'video', url: 'm://a.mp4', start: 0, duration: 3 }]
  return ids(effectiveClips(list, { locked: ['video'] })) === 'l1'
})())
check('轨道开关缺省/脏数据不抛且返回全量（停用除外）', (() => {
  const list = [
    { id: 'x1', track: 'video', url: 'm://a.mp4', start: 0, duration: 3 },
    { id: 'x2', track: 'audio', url: 'm://a.mp3', start: 0, duration: 3, enabled: false }
  ]
  const dirty = effectiveClips(list, { hidden: 'video', muted: 42, locked: null })
  return ids(dirty) === 'x1' && effectiveClips(list, null).length === 1
})())
check('停用片段在预览里真的不显像（层列表里没有它的 url）', (() => {
  const list = [
    { id: 'p1', track: 'video', url: 'm://disabled.mp4', start: 0, duration: 6, enabled: false },
    { id: 'p2', track: 'video', url: 'm://alive.mp4', start: 0, duration: 6 }
  ]
  const shot = compositeAt(effectiveClips(list, {}), [], 1)
  return shot.layers.every((layer) => layer.url !== 'm://disabled.mp4') && shot.main.url === 'm://alive.mp4'
})())

/* ---------- K 组：独奏（solo）—— 只让一条轨出声，其余能出声的轨静音 ---------- */

const SOLO_LIST = [
  { id: 'v1', track: 'video', url: 'm://v.mp4', start: 0, duration: 4, gain: 100 },
  { id: 'a1', track: 'audio', url: 'm://a.mp3', start: 0, duration: 4, gain: 100 },
  { id: 'o1', track: 'overlay', url: 'm://o.mp4', start: 0, duration: 4, gain: 100 },
  { id: 't1', track: 'text', url: '', start: 0, duration: 4 }
]

check('独奏视频轨 · 音频轨整段退出合成', (() => {
  const shot = effectiveClips(SOLO_LIST, { solo: ['video'] })
  return ids(shot) === 'v1,o1,t1'
})())
check('独奏视频轨 · 叠加轨留画面但 gain 归 0（不是连画面一起删）', (() => {
  const shot = effectiveClips(SOLO_LIST, { solo: ['video'] })
  const overlay = shot.find((item) => item.id === 'o1')
  const video = shot.find((item) => item.id === 'v1')
  return Boolean(overlay) && overlay.gain === 0 && video.gain === 100
})())
check('独奏 · 静音视频轨与隐藏视频轨不是同一个效果（隐藏连画面一起没）', (() => {
  const muted = compositeAt(effectiveClips(SOLO_LIST, { solo: ['audio'] }), [], 1)
  const hidden = compositeAt(effectiveClips(SOLO_LIST, { hidden: ['video'] }), [], 1)
  return muted.layers.some((l) => l.url === 'm://v.mp4') && !hidden.layers.some((l) => l.url === 'm://v.mp4')
})())
check('独奏音频轨 · 视频轨不再发声（gain 0）而画面仍在', (() => {
  const shot = effectiveClips(SOLO_LIST, { solo: ['audio'] })
  const video = shot.find((item) => item.id === 'v1')
  const audio = shot.find((item) => item.id === 'a1')
  return video.gain === 0 && Boolean(audio) && audio.gain === 100
})())
check('无人独奏时 · 独奏字段不影响任何片段', (() => {
  const shot = effectiveClips(SOLO_LIST, { solo: [] })
  return shot.every((item) => item.gain === undefined || item.gain === 100)
})())
check('独奏 + 静音叠加 · 两条规则都成立（独奏不救被静音的轨）', (() => {
  const shot = effectiveClips(SOLO_LIST, { solo: ['audio'], muted: ['audio'] })
  return ids(shot) === 'v1,o1,t1'
})())
check('独奏字幕轨是空操作（它没有音轨，不该把别的轨消掉）', (() => {
  const shot = effectiveClips(SOLO_LIST, { solo: ['text'] })
  return shot.length === SOLO_LIST.length && shot.every((item) => item.gain === undefined || item.gain === 100)
})())

/* ----------------------------------------------- K 组：替换片段（换源不换位置） */

/**
 * 「替换片段」的四条不变式。这一组存在的理由和别的组一样：**错法不报错**。
 * 下面每一条算错，界面上都看不出来 —— 换了素材，时间线悄悄变形，
 * 或者预览取到源素材里另一处（黑屏 / 首帧不对），导出才现形。
 */
const NEW_SRC = { url: 'yjai-media://local/L2YlbmV3Lm1wNA', path: 'F:\\new.mp4', name: '新素材', kind: 'video', assetId: 'a_new' }

check('替换 · 换源不换起点（start 不在补丁里，位置一动不动）', (() => {
  const patch = replacePatch({ start: 12.5, duration: 4, offset: 2, speed: 1 }, NEW_SRC, 30)
  return patch && patch.start === undefined && patch.duration === 4
})())

check('替换 · 源入点归零（沿用旧 offset 会指向不存在的位置）', (() => {
  const patch = replacePatch({ start: 0, duration: 4, offset: 7.25 }, NEW_SRC, 30)
  return patch && patch.offset === 0
})())

check('替换 · 倍速守恒：2 倍速 + 新素材 10s ⇒ 占位上限 5s', (() => {
  const clip = { start: 0, duration: 9, offset: 0, speed: 2 }
  const patch = replacePatch(clip, NEW_SRC, 10)
  return patch && Math.abs(patch.duration - 5) < 0.01
})())

check('替换 · 新素材更长时不撑大占位（换素材不该打乱剪辑结果）', (() => {
  const patch = replacePatch({ start: 0, duration: 3, offset: 0, speed: 1 }, NEW_SRC, 72.5)
  return patch && patch.duration === 3
})())

check('替换 · 时长探测失败时不动时长（猜一个数比保持现状更糟）', (() => {
  const patch = replacePatch({ start: 0, duration: 6, offset: 0, speed: 1 }, NEW_SRC, 0)
  const nan = replacePatch({ start: 0, duration: 6, offset: 0, speed: 1 }, NEW_SRC, Number.NaN)
  return patch && patch.duration === 6 && nan && nan.duration === 6
})())

check('替换 · 新素材没有 url 时不给补丁（不许写出一个空片段）', (() => {
  return replacePatch({ duration: 4 }, { url: '', name: 'x' }, 30) === null &&
    replacePatch(null, NEW_SRC, 30) === null
})())

/* ------------------------------------------------------------------ 汇总 */

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\nCOMPOSITE_SELFTEST_STATS total=${results.length} pass=${passed} fail=${failed}`)
if (failed) {
  console.log('失败项：' + results.filter((r) => !r.ok).map((r) => r.label).join(' | '))
  console.log('COMPOSITE_SELFTEST_FAILED')
  process.exitCode = 1
} else {
  console.log('COMPOSITE_SELFTEST_PASSED')
  process.exitCode = 0
}
