'use strict'
/**
 * 多机位（多角度同步 + 切换）—— 真源唯一。
 *
 * 「多机位片段」= 若干路**已经对齐**的素材（机位），在时间线上表现为**一个**片段；
 * 播放时用户按键 / 点机位缩略图，就从那一刻起换成另一路画面 —— 每次切换落一个
 * 「切换点」（cut）。成片里它变成一串普通的视频片段（每个切换区间一段），
 * 外加一条从**指定机位**取声的音频片段。
 *
 * ## 与复合片段（compound.js）的关系
 * 两者都是"容器"，渲染方式也一样：**展开（flatten）**，不落中间文件。
 * 区别是复合片段展开出来的内容由用户手工摆好（内部时间线），
 * 多机位展开出来的内容由**切换点**算出来 —— 内部时间线是"派生"的，不是"编辑"的。
 *
 * 因此：多机位的外层**不提供**内部时间线编辑（移动内部片段没有意义，
 * 它下一秒就会被切换点重新算一遍）。要在某一路上做裁剪/变速，请解除多机位，
 * 或者先在单路素材上做好再建多机位。
 *
 * ## 时间坐标（最容易搞混的一处）
 *   · **节目时间 p**：多机位片段内部从 0 开始走的秒数（= 展开后主时间线的相对位置）。
 *   · **机位源时间**：`angle.offset + p`。`offset` 是"节目第 0 秒对应这一路源文件的第几秒"，
 *     建多机位时由各片段在时间线上的**相对起点**算出来（这就是"同步"）。
 *   · 切换点 `cuts[].at` 用节目时间，`angle` 是机位序号。
 *
 * ## 三条不变式（`tools/check-multicam.mjs` 逐条钉）
 *   ① **覆盖完整**：切换点从 0 开始、首尾相接，展开后节目区间内**没有黑缝**；
 *   ② **源消耗守恒**：每个区间的 `duration × speed` = 区间长度（节目秒）；
 *   ③ **同一个出口**：预览（App 的 activeClips）与导出（main/render.js 的 render()）
 *      都调 `expandMulticams` —— 各写一份就是"预览切了、成片没切"。
 *
 * ⚠️ 本文件是 **CommonJS**：主进程是 CJS，渲染层由 vite 的 commonjs 插件转。
 *    新增模块必须同步 `packages/desktop/vite.config.mjs` 的
 *    `commonjsOptions.include` —— 漏了的话渲染层 import 到空对象，
 *    `expandMulticams` 变 undefined、多机位片段**整段消失**（画面直接黑掉），
 *    而构建与静态检查都不报错。
 */

const speedTable = require('./speed')
const reverseTable = require('./reverse')

const { clipSpeed } = speedTable
const { isReversed } = reverseTable

/** 与 trim.js 同量级的容差（秒） */
const EPSILON = 1e-4
/** 机位上限：界面上给 1–9 的切换键，超过 9 路只能点缩略图（参考也是这个数） */
const MAX_ANGLES = 9
/** 切换点上限：防草稿被改成每帧一个切换点把展开撑爆 */
const MAX_CUTS = 400
/** 能出声的轨（与 composite.js / compound.js 同口径） */
const AUDIO_CAPABLE = new Set(['video', 'overlay', 'audio'])

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
const round4 = (value) => Number(num(value).toFixed(4))

/**
 * 是不是多机位片段。
 * 判据里带上"至少两路"：只有一路的多机位在渲染上与普通片段等价，
 * 却多出切换点/机位面板这些没有意义的入口。
 */
function isMulticam(clip) {
  if (!clip || clip.kind !== 'multicam') return false
  return Array.isArray(clip.multicam && clip.multicam.angles) && clip.multicam.angles.length >= 2
}

/** 机位表（永远返回数组，调用方不用判空） */
function anglesOf(clip) {
  if (!clip || !clip.multicam) return []
  return Array.isArray(clip.multicam.angles) ? clip.multicam.angles : []
}

/** 节目总长（内部秒）：建多机位时算好存进 multicam.span，之后不再重算 */
function multicamSpan(clip) {
  const span = num(clip && clip.multicam && clip.multicam.span)
  if (span > EPSILON) return span
  return num(clip && clip.duration)
}

/**
 * 规范化切换点。
 *
 * 三条硬规则，缺一条界面就会与成片对不上：
 *   · **第一个切换点必须在 0**：否则开头那一段没有机位，展开后是黑缝；
 *   · **升序 + 去重**：同一时刻两个切换点里哪个生效取决于遍历顺序，不可预期；
 *   · **越界夹取**：最后一个切换点被拖到 span 之外时裁掉，不能让区间算出负数。
 */
function normalizeCuts(cuts, span) {
  const limit = Math.max(0, num(span))
  const list = (Array.isArray(cuts) ? cuts : [])
    .map((item) => ({
      at: Math.min(limit, Math.max(0, round4(item && item.at))),
      angle: Math.min(MAX_ANGLES - 1, Math.max(0, Math.floor(num(item && item.angle))))
    }))
    .sort((a, b) => a.at - b.at)
  const out = []
  for (const cut of list) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(prev.at - cut.at) < EPSILON) {
      /* 同一时刻：**后来者覆盖**（用户刚点的那个机位生效），不是保留第一个 */
      prev.angle = cut.angle
      continue
    }
    out.push({ ...cut })
    if (out.length >= MAX_CUTS) break
  }
  if (!out.length || out[0].at > EPSILON) out.unshift({ at: 0, angle: out.length ? out[0].angle : 0 })
  return out
}

/** 切换点（规范化后） */
function cutsOf(clip) {
  return normalizeCuts(clip && clip.multicam && clip.multicam.cuts, multicamSpan(clip))
}

/**
 * 把切换点展开成**首尾相接**的区间（节目秒）。
 * 末段一直延伸到节目末尾 —— 最后一个切换点之后仍有画面，这一点写错就是"结尾黑掉"。
 */
function segmentsOf(clip) {
  const span = multicamSpan(clip)
  const cuts = cutsOf(clip)
  const out = []
  for (let index = 0; index < cuts.length; index += 1) {
    const start = cuts[index].at
    const end = index + 1 < cuts.length ? cuts[index + 1].at : span
    if (!(end - start > EPSILON)) continue
    out.push({ start, end, angle: cuts[index].angle })
  }
  return out
}

/** 节目时间 p 处**生效**的机位序号（p 用内部秒） */
function angleIndexAt(clip, p) {
  const cuts = cutsOf(clip)
  let picked = cuts.length ? cuts[0].angle : 0
  const at = num(p)
  for (const cut of cuts) {
    if (cut.at <= at + EPSILON) picked = cut.angle
    else break
  }
  return picked
}

/**
 * 新建多机位片段。
 *
 * 「同步」= 各片段在时间线上的**相对起点**：节目第 0 秒取**所有机位都有内容**的那一刻
 * （`origin = 最晚的起点`），每一路的 `offset = 源入点 + origin - 片段起点`
 * （起点更早的那一路，源里已经走过去一截，offset 因此是正的）。
 * 也就是说，用户把两路素材摆成"画面上人对得上"的位置，建出来的多机位就是对齐的 ——
 * 这是最简单也最诚实的同步方式（自动音频对齐是另一件事，不在这里假装做了）。
 *
 * 节目区间 = 各机位在时间线上**公共重叠**的那一段（`[最晚起点, 最早终点)`），
 * 再被"源文件还剩多少"卡一道（`sourceDuration - offset`）。
 * ⚠️ 为什么不用并集：并集意味着有一段只有部分机位有内容，此时切到"还没开机"的那一路
 *    就是黑帧 —— 而界面上看不出来（面板里那一路的按钮一样是亮的）。
 *    宁可少一段，也不要一个"切过去就黑"的机位。
 * ⚠️ 完全不重叠（`最晚起点 >= 最早终点`）⇒ 返回 null，由调用方明确报错。
 *
 * @param {Array} clips 时间线全部片段
 * @param {string[]} ids 被选中的机位片段 id
 * @param {{id:string, name?:string}} options 新片段 id（必填，由调用方发号）
 * @returns {{clip:object, rest:Array}|null}
 */
function makeMulticam(clips, ids, options = {}) {
  const list = Array.isArray(clips) ? clips : []
  const wanted = new Set(Array.isArray(ids) ? ids.filter(Boolean) : [])
  const picked = list.filter(
    (item) =>
      wanted.has(item.id) &&
      num(item.duration) > EPSILON &&
      /* 只有**自带画面文件**的片段能当机位：复合片段、字幕、纯文本都没有可直接解码的源 */
      (item.track === 'video' || item.track === 'overlay') &&
      Boolean(item.path || item.url)
  )
  if (picked.length < 2) return null
  const used = picked.slice(0, MAX_ANGLES)
  /* 节目起点 = **最晚**的那个起点：早开的机位在这一刻之前还没有人跟它对齐，
     若把它们也算进节目，前一段就只有部分机位有画面（切过去即黑） */
  const origin = used.reduce((max, item) => Math.max(max, num(item.start)), Number.NEGATIVE_INFINITY)
  const end = used.reduce((min, item) => Math.min(min, num(item.start) + num(item.duration)), Number.POSITIVE_INFINITY)
  if (!Number.isFinite(origin) || !Number.isFinite(end) || !(end - origin > EPSILON)) return null

  const angles = used
    .slice()
    .sort((a, b) => num(a.start) - num(b.start))
    .map((item, index) => ({
      index,
      id: `a${index}`,
      assetId: item.assetId || '',
      name: item.name || `机位 ${index + 1}`,
      path: item.path || '',
      url: item.url || '',
      /* 节目第 0 秒在这一路源文件里的位置。
         起点比 origin 更早的那一路，源里已经走过 `origin - start` 秒 ⇒ offset 为正。 */
      offset: round4(num(item.offset) + (origin - num(item.start))),
      /* 源文件总长（0 = 未知，当作不限长） */
      sourceDuration: round4(item.sourceDuration),
      /* 建多机位时这一路在时间线上占的长度：只用于面板上的提示，不参与渲染 */
      onTimeline: round4(num(item.duration))
    }))

  let span = end - origin
  for (const angle of angles) {
    if (angle.sourceDuration > EPSILON) span = Math.min(span, angle.sourceDuration - angle.offset)
  }
  if (!(span > EPSILON)) return null

  const clip = {
    id: options.id,
    track: 'video',
    kind: 'multicam',
    start: round4(origin),
    duration: round4(span),
    offset: 0,
    speed: 1,
    sourceDuration: round4(span),
    name: options.name || '多机位片段',
    /* 音轨默认取第 1 路：多机位最常见的用法就是"画面切来切去、声音跟主麦走" */
    multicam: {
      angles,
      cuts: [{ at: 0, angle: 0 }],
      span: round4(span),
      audio: { mode: 'angle', angle: 0 }
    },
    assetId: '',
    url: '',
    path: ''
  }
  const rest = list.filter((item) => !used.some((pickedItem) => pickedItem.id === item.id))
  return { clip, rest }
}

/**
 * 在某处切到某路机位。返回要合并进片段的**补丁**（不改入参）。
 *
 * @param {object} clip 多机位片段
 * @param {number} p 节目时间（内部秒）
 * @param {number} angleIndex 机位序号
 */
function setCut(clip, p, angleIndex) {
  if (!isMulticam(clip)) return null
  const span = multicamSpan(clip)
  const at = Math.min(span, Math.max(0, round4(p)))
  const angle = Math.min(anglesOf(clip).length - 1, Math.max(0, Math.floor(num(angleIndex))))
  const cuts = normalizeCuts([...cutsOf(clip), { at, angle }], span)
  return { multicam: { ...clip.multicam, cuts } }
}

/** 换取声机位 / 模式。mode: 'angle'（单一机位取声）| 'follow'（跟着画面切）| 'none'（静音） */
function setAudio(clip, mode, angleIndex) {
  if (!isMulticam(clip)) return null
  const nextMode = mode === 'follow' || mode === 'none' ? mode : 'angle'
  const angle = Math.min(anglesOf(clip).length - 1, Math.max(0, Math.floor(num(angleIndex))))
  return { multicam: { ...clip.multicam, audio: { mode: nextMode, angle } } }
}

/** 取声模式的规范化读取（旧草稿没有这个字段时退回"第 1 路取声"） */
function audioOf(clip) {
  const raw = clip && clip.multicam && clip.multicam.audio
  const mode = raw && (raw.mode === 'follow' || raw.mode === 'none' || raw.mode === 'angle') ? raw.mode : 'angle'
  const angle = Math.min(Math.max(0, Math.floor(num(raw && raw.angle))), Math.max(0, anglesOf(clip).length - 1))
  return { mode, angle }
}

/** 机位画面片段（展开用）：一个区间一段 */
function segmentClip(clip, angle, angleIndex, segStart, segEnd, win0, rate, reversed, gainScale) {
  const start = num(clip.start) + (segStart - win0) / rate
  const duration = (segEnd - segStart) / rate
  return {
    id: `${clip.id}~m${angleIndex}_${segStart.toFixed(3)}`,
    track: 'video',
    kind: 'video',
    assetId: angle.assetId || '',
    name: angle.name || '',
    path: angle.path || '',
    url: angle.url || '',
    /* 源入点：节目 p 对应 `angle.offset + p`；区间起点就是区间的源起点 */
    offset: round4(angle.offset + segStart),
    /* 区间长度（节目秒）÷ 外层倍速 = 时间线上的占位；
       片段自身 speed 设为外层倍速 ⇒ 源消耗 = 区间长度，与不变式 ② 一致 */
    duration: round4(duration),
    speed: rate,
    sourceDuration: round4(angle.sourceDuration),
    start: round4(start),
    reverse: reversed,
    /* 音量：`gain` 是**百分比**（100 = 原声），与属性的音量滑杆同一单位。
       1 倍不加字段（消费端缺省就是 100），否则每次展开都会凭空多一个字段。 */
    ...(Math.abs(gainScale - 1) > 1e-6 ? { gain: round4(gainScale * 100) } : null),
    ownerId: clip.id
  }
}

/**
 * 展开整条时间线上的多机位片段（幂等：没有多机位时原样返回新数组）。
 *
 * 与 `expandCompounds` 的关系：两者都要跑，顺序无所谓（互不包含）。
 * App 与 render.js 的调用顺序是 `expandMulticams → expandCompounds`，
 * 因为多机位不会再包住复合片段，反过来则可能（复合里套多机位暂不支持，
 * 建多机位时已经排除了复合片段）。
 *
 * @param {Array} clips
 * @param {{trackState?: object}} [options] 轨道开关要**穿透**多机位（外层在视频轨，
 *        取声机位在音频轨：静音视频轨时声音要一起停）
 */
function expandMulticams(clips, options = {}) {
  const list = Array.isArray(clips) ? clips : []
  const state = options.trackState && typeof options.trackState === 'object' ? options.trackState : {}
  const hidden = new Set(Array.isArray(state.hidden) ? state.hidden : [])
  const muted = new Set(Array.isArray(state.muted) ? state.muted : [])
  const solo = new Set((Array.isArray(state.solo) ? state.solo : []).filter((key) => AUDIO_CAPABLE.has(key)))
  const anySolo = solo.size > 0
  const sink = []

  for (const clip of list) {
    if (!clip) continue
    if (!isMulticam(clip)) {
      sink.push(clip)
      continue
    }
    if (clip.enabled === false) continue
    if (hidden.has(clip.track)) continue

    const angles = anglesOf(clip)
    const span = multicamSpan(clip)
    const rate = Math.max(0.01, clipSpeed(clip))
    const reversed = isReversed(clip)
    const win0 = num(clip.offset)
    const win1 = win0 + num(clip.duration) * rate
    const parentGain = Number.isFinite(Number(clip.gain)) ? Number(clip.gain) / 100 : 1
    const audio = audioOf(clip)
    const silentOuter = muted.has(clip.track) || (anySolo && AUDIO_CAPABLE.has(clip.track) && !solo.has(clip.track))
    /** 画面层**不带原声**的两种情况：用户选了单一机位取声 / 明确静音 */
    const separateAudio = audio.mode === 'angle' || audio.mode === 'none'

    for (const seg of segmentsOf(clip)) {
      const w0 = Math.max(seg.start, win0)
      const w1 = Math.min(seg.end, win1)
      if (!(w1 - w0 > EPSILON)) continue
      const angle = angles[seg.angle] || angles[0]
      if (!angle) continue
      /* 画面层能不能出声：只有 follow 模式才跟着画面切（此时音量由外层给） */
      const keepGain = separateAudio ? 0 : parentGain
      const piece = segmentClip(clip, angle, seg.angle, w0, w1, win0, rate, reversed, keepGain)
      if (silentOuter) piece.gain = 0
      /* 单一机位取声：视频段一律静音（gain 0），声音由下面那条音轨提供 */
      if (separateAudio) piece.gain = 0
      sink.push(piece)
    }

    if (separateAudio && audio.mode === 'angle') {
      const angle = angles[audio.angle] || angles[0]
      if (angle) {
        const a0 = Math.max(win0, 0)
        const a1 = Math.min(win1, span)
        if (a1 - a0 > EPSILON) {
          sink.push({
            id: `${clip.id}~aud`,
            track: 'audio',
            kind: 'audio',
            assetId: angle.assetId || '',
            name: `${angle.name || '机位'} 原声`,
            path: angle.path || '',
            url: angle.url || '',
            offset: round4(angle.offset + a0),
            duration: round4((a1 - a0) / rate),
            speed: rate,
            sourceDuration: round4(angle.sourceDuration),
            start: round4(num(clip.start) + (a0 - win0) / rate),
            reverse: reversed,
            ...(silentOuter
              ? { gain: 0 }
              : Math.abs(parentGain - 1) > 1e-6
                ? { gain: round4(parentGain * 100) }
                : null),
            ownerId: clip.id
          })
        }
      }
    }
  }
  return sink
}

/**
 * 解除多机位：把当前**切换结果**摊回时间线（每个区间一段画面 + 一条取声音轨）。
 *
 * 用途与解除复合一样：想在某一路上单独做裁剪/变速/调色时，先解成普通片段。
 * 注意解除后切换点就没了 —— 再建一次多机位不会自动恢复，这是有意的
 * （否则"我明明解除了，它怎么又变回去了"）。
 */
function ungroupMulticam(clip, nextId) {
  if (!isMulticam(clip)) return []
  const expanded = expandMulticams([clip], {})
  return expanded.map((child, index) => {
    const { ownerId, ...rest } = child
    const id = typeof nextId === 'function' ? nextId(index) : `${clip.id}_u${index}`
    return { ...rest, id, enabled: true }
  })
}

module.exports = {
  MAX_ANGLES,
  MAX_CUTS,
  EPSILON,
  isMulticam,
  anglesOf,
  multicamSpan,
  audioOf,
  cutsOf,
  normalizeCuts,
  segmentsOf,
  angleIndexAt,
  makeMulticam,
  setCut,
  setAudio,
  expandMulticams,
  ungroupMulticam
}
