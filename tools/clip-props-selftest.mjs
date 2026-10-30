#!/usr/bin/env node
/**
 * clipProps.js 的自证夹具（片段属性剪贴板）。
 *
 * 为什么值得单开一道：这一层的错法**全是静默的**，而且错得越离谱越像"功能没做"。
 *   · 黑名单漏一个 `url` ⇒ 粘贴时"连素材一起换掉"，用户看到的是"这段的属性没变，
 *     画面却成了另一条片子"；
 *   · 只覆盖不清理 ⇒ "复制一条没调色的片段，粘到调过色的片段上"得到"旧调色 + 新位置"，
 *     谁都没预期这个结果，而且没有任何提示；
 *   · 值不深拷贝 ⇒ 剪贴板与状态共用同一个对象，接着改目标片段会把剪贴板一起改掉，
 *     表现为"第二次粘贴的效果和第一次不一样"。
 *
 * 所以这里的判据是**集合相等**与**引用独立**，而不是逐字段比对数值 ——
 * 前者能自动覆盖"以后新增一个键忘了加进白名单"这种情况。
 *
 * 输出：CLIP_PROPS_SELFTEST_PASSED / CLIP_PROPS_SELFTEST_FAILED
 *       + 「CLIP_PROPS_SELFTEST_STATS total=N pass=P fail=F」
 */
import {
  ATTR_KEYS,
  NEVER_KEYS,
  applyAttrs,
  describeAttrs,
  pastePatch,
  pickAttrs
} from '../packages/desktop/src/renderer/clipProps.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  ::  ${detail}`}`)
}

const sorted = (list) => [...list].sort().join(',')

/* ------------------------------------------- A. pickAttrs：只搬白名单里的键 */

const VIDEO = {
  id: 'c1',
  assetId: 'a1',
  url: 'yjai-media://local/xxx',
  path: 'D:/media/clip.mp4',
  name: '海边的镜头',
  kind: 'video',
  text: '',
  track: 'video',
  start: 3,
  duration: 8,
  offset: 1.5,
  speed: 2,
  sourceDuration: 20,
  z: 1,
  enabled: false,
  // 以下是外观属性
  posX: 10,
  posY: -5,
  scale: 1.2,
  rotate: 3,
  opacity: 0.8,
  crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  adjust: { brightness: 0.2 },
  filter: 'warm',
  filterIntensity: 0.6,
  volume: 0.5
}

const snap = pickAttrs(VIDEO)
const snapKeys = Object.keys(snap.keys)

check('素材身份字段一个都不搬（url / path / assetId / name / kind / text）',
  ['url', 'path', 'assetId', 'name', 'kind', 'text'].every((key) => !(key in snap.keys)),
  snapKeys.join(','))
check('时间线占位字段一个都不搬（start / duration / offset / speed / sourceDuration）',
  ['start', 'duration', 'offset', 'speed', 'sourceDuration'].every((key) => !(key in snap.keys)),
  snapKeys.join(','))
check('结构字段不搬（track / z / enabled / group / compound）',
  ['track', 'z', 'enabled', 'group', 'compound'].every((key) => !(key in snap.keys)),
  snapKeys.join(','))
check('画面/调色/声音属性都搬了', ['posX', 'scale', 'crop', 'adjust', 'filter', 'volume'].every((key) => key in snap.keys),
  snapKeys.join(','))
check('count 与 keys 数量一致', snap.count === snapKeys.length, `${snap.count} vs ${snapKeys.length}`)
check('白名单里每个键都能被 ATTR_KEYS 认出来（防止拼错键名）',
  snapKeys.every((key) => ATTR_KEYS.includes(key)), snapKeys.filter((key) => !ATTR_KEYS.includes(key)).join(','))
check('NEVER_KEYS 与 ATTR_KEYS 没有交集（不许同一个键既搬又不搬）',
  NEVER_KEYS.every((key) => !ATTR_KEYS.includes(key)),
  NEVER_KEYS.filter((key) => ATTR_KEYS.includes(key)).join(','))
check('empty clip 返回空快照且 count=0', pickAttrs(null).count === 0 && Object.keys(pickAttrs(null).keys).length === 0)
check('undefined 值的键不算"有"（缺失与 undefined 不是一回事）',
  pickAttrs({ adjust: undefined }).count === 0,
  JSON.stringify(pickAttrs({ adjust: undefined }).keys))

/* ---------------------------------------------------------- B. 深拷贝独立 */

const deep = pickAttrs(VIDEO)
deep.keys.crop.x = 0.99
check('改快照里的嵌套对象不影响原片段（值必须深拷贝）', VIDEO.crop.x === 0.1, String(VIDEO.crop.x))
const again = pickAttrs(VIDEO)
again.keys.adjust.brightness = 0.9
check('每次 pickAttrs 拿到的是各自独立的一份', snap.keys.adjust.brightness === 0.2, String(snap.keys.adjust.brightness))

/* --------------------------------- B. pastePatch：覆盖 + 清理，且不越界 */

const TARGET = {
  id: 'c2',
  url: 'other.mp4',
  start: 20,
  duration: 4,
  posX: 0,
  scale: 1,
  rotate: 0,
  /* 目标有、源没有 ⇒ 必须被摘掉（否则"套了个干净外观"却残留旧调色） */
  adjust: { brightness: -0.5 },
  looks: 'cyber'
}
const patch = pastePatch(TARGET, snap)
check('patch 非空', Boolean(patch))
check('patch.set 与快照键集合一致', sorted(Object.keys(patch.set)) === sorted(snapKeys),
  `${sorted(Object.keys(patch.set))} vs ${sorted(snapKeys)}`)
check('目标上有、源上没有的外观键进了 unset（这里的 looks）', sorted(patch.unset) === 'looks', patch.unset.join(','))
check('源上也有的外观键走覆盖而不是删除（adjust 不该出现在 unset 里）',
  !patch.unset.includes('adjust') && patch.set.adjust.brightness === 0.2,
  `${patch.unset.join(',')} / ${JSON.stringify(patch.set.adjust)}`)

const after = applyAttrs(TARGET, patch)
const afterAttrs = Object.keys(after).filter((key) => ATTR_KEYS.includes(key))
check('应用后目标的外观键集合 == 快照键集合（清理生效）', sorted(afterAttrs) === sorted(snapKeys),
  `${sorted(afterAttrs)} vs ${sorted(snapKeys)}`)
check('素材身份一个都没被改（url / start / duration）',
  after.url === 'other.mp4' && after.start === 20 && after.duration === 4)
check('applyAttrs 不改原对象（返回新对象）', TARGET.adjust && TARGET.adjust.brightness === -0.5,
  JSON.stringify(TARGET.adjust))
check('空快照返回 null（调用方据 this 提示，而不是静默成功）', pastePatch(TARGET, { keys: {} }) === null)
check('null 快照返回 null', pastePatch(TARGET, null) === null)
check('目标为空时也给出补丁（粘贴到空对象上不该崩）',
  Boolean(pastePatch(null, snap)) && pastePatch(null, snap).unset.length === 0)
check('目标上有、源上没有的键会被摘掉（回到默认值，而不是留着旧值）',
  (() => {
    const only = pastePatch({ id: 'x', posX: 1 }, { keys: { posY: 2 } })
    return only.unset.length === 1 && only.unset[0] === 'posX' && only.set.posY === 2
  })(),
  JSON.stringify(pastePatch({ id: 'x', posX: 1 }, { keys: { posY: 2 } })))
check('非外观键永远不进 unset（url / speed 之类不许被删掉）',
  (() => {
    const p = pastePatch({ id: 'x', url: 'a.mp4', speed: 2, posX: 1 }, { keys: { scale: 2 } })
    return !p.unset.includes('url') && !p.unset.includes('speed')
  })())

/* ------------------------------------------------------ C. 文字样式独立成组 */

const TEXT = { id: 't1', kind: 'text', textColor: '#fff', textFont: 'sans', textScale: 1.1, textOffset: 2 }
const textSnap = pickAttrs(TEXT)
check('文字样式被摘出来', textSnap.count === 3, Object.keys(textSnap.keys).join(','))
check('textOffset 不搬（名字像 offset，搬了就是把"套样式"变成"改时间"）', !('textOffset' in textSnap.keys))
check('文字片段不会带上画面/声音属性（它本来就没有）',
  ['posX', 'volume', 'adjust'].every((key) => !(key in textSnap.keys)))
check('describeAttrs 给出分组名与条数', /文字样式\s*3/.test(describeAttrs(textSnap)), describeAttrs(textSnap))
check('空快照的 describeAttrs 说明"没有可搬运的属性"', describeAttrs({ groups: [] }) === '没有可搬运的属性')

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\nCLIP_PROPS_SELFTEST_STATS total=${results.length} pass=${passed} fail=${failed}`)
if (failed) {
  console.log('CLIP_PROPS_SELFTEST_FAILED')
  process.exitCode = 1
} else {
  console.log('CLIP_PROPS_SELFTEST_PASSED')
  process.exitCode = 0
}
