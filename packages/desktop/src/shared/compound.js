'use strict'
/**
 * 复合片段（嵌套时间线）—— 真源唯一。
 *
 * 「复合片段」= 把时间线上选中的若干片段打包成**一个**片段。它在时间线上占一格，
 * 内部还记得那几段原本在什么位置、多长、在哪个轨。参考客户端里它同时是
 * 「多机位 / 嵌套序列 / 模板」三件事的地基，所以数据形状必须一次定对。
 *
 * ## 为什么不用"导出成子视频再当素材"那套
 * 那套要落一个中间文件：改一个内部片段就得重新渲染整段、还得管理中间文件的生命周期
 * （清理、失效、草稿里存绝对路径 —— 换台机器就打不开）。这里走的是**展开**：
 * 渲染前把复合片段按内部的子片段摊平回一条普通时间线，之后预览与导出照旧。
 * 好处是零中间文件、改内部片段即时生效；代价是外层不能做「曲线变速 / 倒放」
 * 这类非线性时间映射（见下面 rate 一节，UI 里也已经不给这两个控件）。
 *
 * ## 三条必须同时成立的不变式（`tools/check-compound.mjs` 逐条钉住）
 *   ① **时长守恒**：展开后子片段占的总跨度 = 复合片段的时间线占位
 *      （外层倍速 k 会把内部时长整体除以 k，除此之外不许改）；
 *   ② **源消耗守恒**：子片段的 `offset + duration × 自身倍速` 不变
 *      （裁剪只能改"从哪儿开始、吃多少"，不能把内容拉长）；
 *   ③ **同一个出口**：预览（composite.js）与导出（main/render.js）都调 `expandCompounds`，
 *      不是各写一份 —— 否则"预览里是两段、成片里只有第一段"这种鬼问题查不出来。
 *
 * ## 时间坐标
 * 子片段的 `start` 是**复合片段内部的秒**（从 0 开始），不是时间线秒。
 * 外层把 `[start, start + duration)` 这一段放到时间线上，内部内容是
 * `[offset, offset + duration × rate)` 这段源内容。展开时按这层线性映射换算。
 *
 * ⚠️ 本文件是 **CommonJS**：主进程是 CJS，渲染层由 vite 的 commonjs 插件转。
 *    新增（或改这个文件的名字）时，`packages/desktop/vite.config.mjs` 的
 *    `commonjsOptions.include` 必须同步 —— 漏了的话渲染层 import 到的是空对象，
 *    复合片段展开成空数组、时间线上直接少一半内容，而构建与静态扫描都不报错。
 */

const speedTable = require('./speed')
const reverseTable = require('./reverse')

const { clipSpeed, readCurve, normalizeCurve, curveSourceTime } = speedTable
const { isReversed } = reverseTable

/** 与 trim.js 同量级的容差（秒）。比一帧小两个数量级，够用来判"有没有交集" */
const EPSILON = 1e-4
/** 嵌套层数上限：防止草稿被手工改成自引用时把渲染卡死 */
const MAX_DEPTH = 6
/** 能出声的轨（静音烘焙只对这几条有意义，与 composite.js 的 AUDIO_CAPABLE 同口径） */
const AUDIO_CAPABLE = new Set(['video', 'overlay', 'audio'])

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 是不是复合片段（只有 kind 与内部子片段都在才算，避免半截数据把片段弄没） */
function isCompound(clip) {
  if (!clip || clip.kind !== 'compound') return false
  return Array.isArray(clip.compound && clip.compound.children) && clip.compound.children.length > 0
}

/** 内部子片段（永远返回数组，调用方不用判空） */
function childrenOf(clip) {
  if (!clip || !clip.compound) return []
  return Array.isArray(clip.compound.children) ? clip.compound.children : []
}

/** 内部内容的**总跨度**（内部时间线上从 0 到最右端），单位秒 */
function compoundSpan(clip) {
  let span = 0
  for (const child of childrenOf(clip)) {
    span = Math.max(span, num(child.start) + num(child.duration))
  }
  return span
}

/**
 * 复合片段名称。
 *
 * 不带"（N 段）"后缀：轨道上的角标已经写了段数，名字里再写一遍会让
 * 长名字被挤掉（`clip-name` 是 ellipsis，前 4 个字才是有效信息），
 * 而且用户改名之后还要不要跟段数同步 —— 那是个没答案的问题。
 */
function compoundName() {
  return '复合片段'
}

/**
 * 新建复合片段。
 *
 * 内部时间线从 0 开始：`origin` = 选中片段里最早的起点，所有子片段整体左移这么多。
 * 这样同一个选择无论什么时候复合，内部布局都一样（与它在时间线上摆在哪无关）。
 *
 * @param {Array} clips 时间线全部片段
 * @param {string[]} ids 被选中的片段 id
 * @param {{id:string, name?:string}} options 新片段 id（必填，由调用方统一发号）
 * @returns {{clip:object, rest:Array}|null} 新复合片段 + 剩下没被包进去的片段
 */
function makeCompound(clips, ids, options = {}) {
  const list = Array.isArray(clips) ? clips : []
  const wanted = new Set(Array.isArray(ids) ? ids.filter(Boolean) : [])
  const picked = list.filter((item) => wanted.has(item.id) && num(item.duration) > EPSILON)
  if (!picked.length) return null
  const origin = picked.reduce((min, item) => Math.min(min, num(item.start)), Number.POSITIVE_INFINITY)
  const children = picked
    .slice()
    .sort((a, b) => num(a.start) - num(b.start))
    .map((item) => ({ ...item, start: Number((num(item.start) - origin).toFixed(4)) }))
  const span = children.reduce((max, item) => Math.max(max, num(item.start) + num(item.duration)), 0)
  if (!(span > EPSILON)) return null
  /**
   * 复合片段放在哪条轨：
   * 有画面就放视频轨（它本来就是个"画面 + 声音"的整体），纯音频放音频轨，
   * 纯字幕素材放字幕轨。⚠️ 不要一律放视频轨 —— 纯音频的复合片段放到视频轨以后
   * 它既没有画面也不会进音频链，成片里凭空少一段声音。
   */
  const tracks = new Set(children.map((item) => item.track || 'video'))
  const track = tracks.has('video') || tracks.has('overlay')
    ? 'video'
    : tracks.has('audio')
      ? 'audio'
      : 'text'
  const clip = {
    id: options.id,
    track,
    kind: 'compound',
    start: Number(origin.toFixed(4)),
    duration: Number(span.toFixed(4)),
    /* 源入点 / 倍速：新复合片段永远从内部第 0 秒、原速开始。
       之后拖动两端改 offset/duration，与普通片段同一套语义。 */
    offset: 0,
    speed: 1,
    /* 复合片段的"源时长"就是内部总跨度 —— 修剪上限、split 的钳位都读它 */
    sourceDuration: Number(span.toFixed(4)),
    name: options.name || compoundName(children.length),
    compound: {
      children,
      span: Number(span.toFixed(4)),
      /* 记下内部用过的轨，供时间线画缩略图/角标时显示（不含任何渲染逻辑） */
      tracks: Array.from(tracks)
    },
    assetId: '',
    url: '',
    path: ''
  }
  const rest = list.filter((item) => !wanted.has(item.id))
  return { clip, rest }
}

/**
 * 把子片段按"丢掉前 f 秒 / 后 b 秒"裁剪。
 *
 * ⚠️ 正放与倒放的裁剪方向**正好相反**，这也是最容易写错的一处：
 *    · 正放：丢掉的**前** f 秒 = 源里最前面那段 ⇒ offset 前移；
 *    · 倒放：丢掉的**前** f 秒 = 源里**最后**那段 ⇒ 只缩 duration，offset 不动；
 *      而丢掉**后** b 秒才轮到 offset 前移。
 *    写反了的表现是"复合片段裁一刀之后，内部内容整段错位"，而画面依然在播。
 *
 * 有曲线变速的子片段前移量走 `curveSourceTime`（按曲线累计面积算），
 * 与单段的源消耗口径完全相同 —— 自己乘 f × 平均倍速会在缓入缓出处差一小截。
 */
function cropChild(child, front, back) {
  const duration = num(child.duration)
  const total = Math.min(duration, front + back)
  if (!(duration - total > EPSILON)) return null
  const next = { ...child }
  const reversed = isReversed(child)
  const rate = clipSpeed(child)
  if (reversed) {
    if (back > EPSILON) next.offset = num(child.offset) + back * rate
    next.duration = Number((duration - total).toFixed(4))
    return next
  }
  if (front > EPSILON) {
    const at = num(child.start) + front
    const curved = readCurve(child) ? curveSourceTime(child, at) : null
    next.offset = Number((Number.isFinite(curved) ? curved : num(child.offset) + front * rate).toFixed(4))
  }
  next.duration = Number((duration - total).toFixed(4))
  return next
}

/**
 * 把外层倍速 k 合进子片段。
 *
 * 外层播 k 倍速 = 内部所有内容也 k 倍速前进 ⇒ 子片段的有效倍速乘以 k，
 * 时间线占位除以 k（两者相乘 = 源消耗不变，见文件头不变式 ②）。
 *
 * 子片段自己有曲线时**只能改曲线的高度**（点的时间位置 p 是"片段内进度"，
 * 与时间线占位无关，所以 p 原样保留）。这不是近似：曲线在时间线上的面积
 * 正好被 k 缩放，源消耗与占位的关系仍然是原来那个式子。
 */
function composeRate(child, k) {
  if (Math.abs(k - 1) < 1e-6) return child
  const points = readCurve(child)
  if (points) {
    const scaled = normalizeCurve(points).map((point) => [point.p, Number((point.v * k).toFixed(6))])
    return { ...child, speedCurve: { points: scaled } }
  }
  return { ...child, speed: Number((clipSpeed(child) * k).toFixed(6)) }
}

/**
 * 展开一个复合片段（递归，支持复合里再套复合）。
 *
 * @param {object} clip 复合片段
 * @param {object} ctx { silent:boolean, owner:string, depth:number, sink:Array }
 */
function expandOne(clip, ctx) {
  const children = childrenOf(clip)
  if (!children.length || ctx.depth >= MAX_DEPTH) return
  const rate = Math.max(0.01, clipSpeed(clip))
  const reversed = isReversed(clip)
  const start = num(clip.start)
  const duration = num(clip.duration)
  if (!(duration > EPSILON)) return
  /**
   * 内部可视窗口（内部秒）。外层的 offset 就是"从内部第几秒开始播"，
   * 播 duration 秒、按 rate 倍速 ⇒ 内部走过 duration × rate 秒。
   * 倒放时走的还是同一个窗口，只是方向相反（与 shared/reverse.js 的口径一致）。
   */
  const win0 = num(clip.offset)
  const win1 = win0 + duration * rate
  /* 外层整体音量（1 = 100%）。乘到子片段上，见下面 next.gain 那一段 */
  const parentGain = Number.isFinite(Number(clip.gain)) ? Number(clip.gain) / 100 : 1

  for (const child of children) {
    if (!child || child.enabled === false) continue
    const c0 = num(child.start)
    const c1 = c0 + num(child.duration)
    if (!(c1 - c0 > EPSILON)) continue
    const w0 = Math.max(c0, win0)
    const w1 = Math.min(c1, win1)
    if (!(w1 - w0 > EPSILON)) continue

    /* ⚠️ 先裁再定位：裁剪要读子片段**原来**的 start（曲线换算要用它当时间轴原点），
       定位之后 start 已经变了，再裁就会按错的原点算 offset。 */
    let next = cropChild(child, w0 - c0, c1 - w1)
    if (!next) continue

    next.start = Number((start + (reversed ? win1 - w1 : w0 - win0) / rate).toFixed(4))
    next.duration = Number(((w1 - w0) / rate).toFixed(4))
    next = composeRate(next, rate)
    /* 倒放的外层 ⇒ 子片段的播放方向整体翻一次（两层倒放 = 正放） */
    if (reversed) next.reverse = !isReversed(child)
    next.track = child.track || 'video'
    /**
     * id 必须**确定**且**唯一**：同一份草稿每次渲染算出来的 id 要一样
     * （React key / 选中高亮 / E2E 点名都靠它），但又不能和顶层片段撞。
     * 用 `父id~子id` 拼，天然满足这两条；嵌套时再往外拼一层。
     */
    next.id = `${clip.id}~${child.id}`
    /* 归属：选中高亮、右栏检查器都认这一层（用户选的是外层的复合片段） */
    next.ownerId = ctx.owner || clip.id
    /**
     * 外层音量要真的生效：复合片段的「音量」滑杆是**整块**的音量，
     * 乘到每个子片段上（预览的 `<video>.volume` 与导出的 `volume=` 读的都是这个 gain）。
     * 不乘的话，滑杆拖到 0 也一点声音都不变 —— 又一个"状态变了、成片没变"。
     */
    if (Math.abs(parentGain - 1) > 1e-6) {
      const base = Number.isFinite(Number(next.gain)) ? Number(next.gain) : 100
      next.gain = Number((base * parentGain).toFixed(2))
    }
    if (ctx.silent && AUDIO_CAPABLE.has(next.track)) next.gain = 0

    if (isCompound(next)) {
      expandOne(next, { ...ctx, depth: ctx.depth + 1 })
    } else {
      ctx.sink.push(next)
    }
  }
}

/**
 * 把整条时间线上的复合片段摊平成普通片段。
 *
 * 调用的两个地方（也是**唯一**该写的两个地方）：
 *   · 预览：`App.jsx` 的 activeClips（先展开、再走 effectiveClips）；
 *   · 导出：`main/render.js` 的 render()（任何调用方都不会漏）。
 *
 * @param {Array} clips 片段表
 * @param {{trackState?: object}} [options] 轨道开关（隐藏/静音/独奏要"穿过"复合片段）
 * @returns {Array} 新数组（不改入参；不含任何复合片段）
 */
function expandCompounds(clips, options = {}) {
  const list = Array.isArray(clips) ? clips : []
  const state = options.trackState && typeof options.trackState === 'object' ? options.trackState : {}
  const hidden = new Set(Array.isArray(state.hidden) ? state.hidden : [])
  const muted = new Set(Array.isArray(state.muted) ? state.muted : [])
  const solo = new Set((Array.isArray(state.solo) ? state.solo : []).filter((key) => AUDIO_CAPABLE.has(key)))
  const anySolo = solo.size > 0
  const sink = []
  for (const clip of list) {
    if (!clip) continue
    if (!isCompound(clip)) {
      sink.push(clip)
      continue
    }
    /* 外层是被停用的 / 所在轨被隐藏的 ⇒ 整块内容都不进合成（与普通片段同一口径） */
    if (clip.enabled === false) continue
    if (hidden.has(clip.track)) continue
    const silent = muted.has(clip.track) || (anySolo && AUDIO_CAPABLE.has(clip.track) && !solo.has(clip.track))
    expandOne(clip, { silent, owner: clip.id, depth: 0, sink })
  }
  return sink
}

/**
 * 解除复合片段：把内部子片段还回时间线（就地、按当前裁剪与倍速换算）。
 *
 * ⚠️ id 一律重新发：同一个复合片段可能被复制过多份，各自解除时会与原件撞 id，
 *    撞了以后"选中一个删两个"、"拖动一个动两个"这类问题会一直跟着草稿。
 *
 * @param {object} clip 复合片段
 * @param {(index:number)=>string} nextId 发号函数（由调用方提供，保持全项目 id 格式统一）
 * @returns {Array} 可以并回时间线的子片段（已按当前裁剪/倍速换算到时间线坐标）
 */
function ungroupCompound(clip, nextId) {
  if (!isCompound(clip)) return []
  const sink = []
  expandOne(clip, { silent: false, owner: '', depth: 0, sink })
  return sink.map((child, index) => {
    const { ownerId, ...rest } = child
    const id = typeof nextId === 'function' ? nextId(index) : `${clip.id}_u${index}`
    return { ...rest, id, enabled: child.enabled !== false }
  })
}

module.exports = {
  isCompound,
  childrenOf,
  compoundSpan,
  compoundName,
  makeCompound,
  expandCompounds,
  ungroupCompound,
  MAX_DEPTH
}
