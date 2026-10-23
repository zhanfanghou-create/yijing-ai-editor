/**
 * 预览合成器 —— 把「整条时间线」翻译成「这一帧画面上有哪几层」。
 *
 * 为什么必须单独一个文件，而且必须是**纯逻辑**：
 *   预览以前是「取播放头所在的**一个**片段，把它塞进**一个** <video>」。
 *   这套写法有三个只在真机上才现形的缺陷，而且**都不会报错**：
 *     ① 切片段时 <video> 的 src 被换掉 ⇒ 要重新加载、重新解码，
 *        接缝处必有一帧黑（片段越短越明显），转场的第一帧尤其明显
 *        —— 因为转场层是在交叠窗口**开始的那一刻**才挂载一个新 <video> 的；
 *     ② 同一轨上重叠的片段只画一个，重叠的部分凭空消失；
 *     ③ 片段自己的**音量**根本没有接到预览上（属性面板的音量滑杆改了 clips 里的
 *        gain，导出是真的变小声，预览一点没变 —— 典型的"状态变了画面没变"）。
 *   这三条的共同点是：纯算术没错、构建没错、静态扫描也看不出来，
 *   只有「按播放键从头看一遍」才知道。所以这里把它抽成纯函数，
 *   由 `tools/composite-selftest.mjs` 在 node 里直接断言。
 *
 * 本文件只回答三个问题：
 *   · 这一刻**看得见**的是哪几层（按层叠顺序，底 → 顶）；
 *   · 还要**提前挂载**哪几层（热点窗口，用来消除上面的 ①）；
 *   · 音频轨 / 叠加轨 / 字幕轨上分别有哪些片段在这一刻生效。
 *
 * ⚠️ 时间轴口径：本文件**一律用原始时间线坐标**（clip.start / clip.duration 本来是多少
 *    就是多少），不按转场做平移。转场会让成片比时间线短（见 looks.js 的 resolveTrack），
 *    那是**导出**的事；预览必须跟用户在时间线上看到的那一格对齐，
 *    否则播放头压在接缝上、画面却已经是后一段的中间，那才叫"对不上"。
 */

import { EPSILON, clipRateAt, isReversed, sourceTimeAt } from './trim.js'
import { effectiveTransitions } from './looks.js'
import { pipOf } from './pip.js'
import { textStyleDef } from './textStyles.js'
/* 关键帧插值（预览与导出共用的唯一口径，见 shared/effects.js） */
import { readKeyframes, hasKeyframes, keyframeValue } from '../shared/effects.js'
/* 音量包络：预览每帧把插值结果乘进 <video>.volume，导出写成 ffmpeg 的 volume 表达式 */
import { hasVolumeKf, readVolumeKf, volumeAt } from '../shared/audio.js'
/* 画面层级（自由层级）：层叠比较器与导出侧**同一份**（主进程require的是它） */
import { compareLayers, readZ } from '../shared/layers.js'

/**
 * 能出声的轨道（静音 / 独奏只影响这几条）。
 *
 * 字幕轨不在此列 —— 它没有音轨，给它挂「喇叭」和「独奏」两个按钮，
 * 点下去画面一个像素都不会变，那就是纯装饰。参考客户端的字幕轨头
 * 也只有「锁」和「眼」，没有这两个。
 */
export const AUDIO_CAPABLE = new Set(['video', 'overlay', 'audio'])

/** 热点窗口：播放头**之前**还要留住的秒数（往回拖 / 转场交叠要用） */
export const HOT_BEFORE = 2
/** 热点窗口：播放头**之后**提前挂载的秒数 —— 这一条就是"连续播放不黑帧"的全部秘密 */
export const HOT_AFTER = 6
/**
 * 热点窗口的量化步长（秒）。
 *
 * ⚠️ 必须量化：播放头每一帧都在变，窗口要是跟着每帧重算，
 *    React 就会每帧挂载/卸载 <video> —— 那比不预加载还糟（解码器反复启停）。
 *    按 2 秒跳一格，窗口每 2 秒才变一次，元素在整个片段期间是同一个。
 */
export const HOT_STEP = 2

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 片段 id 比较：`clip_<base36>_<seq>`。
 * 直接按字符串比会把 `_10` 排到 `_2` 前面（字典序），同轨同起点的两层就会反过来，
 * 所以尾号是数字时按数字比。
 */
function idSeq(id) {
  const matched = /_(\d+)$/.exec(String(id ?? ''))
  return matched ? Number(matched[1]) : Number.NaN
}

export function cmpId(a, b) {
  const sa = idSeq(a)
  const sb = idSeq(b)
  if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb
  const strA = String(a ?? '')
  const strB = String(b ?? '')
  return strA < strB ? -1 : strA > strB ? 1 : 0
}

/** 播放头落在片段内（左闭右开：首尾相接的两段不会在同一帧同时命中） */
export function spansAt(clip, t) {
  const start = num(clip && clip.start)
  const duration = num(clip && clip.duration)
  if (!(duration > 0) || !Number.isFinite(Number(t))) return false
  return Number(t) >= start - EPSILON && Number(t) < start + duration - EPSILON
}

/**
 * 轨道开关与「停用片段」的统一结算。
 *
 * 背景（为什么必须有这个函数）：轨道头上的「隐藏 / 静音 / 锁定」与右键菜单的
 * 「停用片段」以前只活在时间线组件的本地 state 里 —— 轨道灯亮了、lane 变暗了，
 * 但预览照播、导出照渲，是「状态变了、成片一个像素没变」的静默失效。
 *
 * 口径（预览与导出必须走**同一份**，否则又是"预览关了、成片里还有"）：
 *   · `enabled === false` 的片段（停用）—— 整段退出合成；
 *   · 隐藏轨道上的片段 —— 整段退出合成（隐藏的视频轨会让画面掉到下一优先级，
 *     与 visualCandidates 的 video → text → audio 口径自然衔接）；
 *   · 静音轨道只静音**音频**：该轨上的音频片段退出合成（音频片段没有画面可留）；
 *     视频 / 叠加轨被静音时画面**保留**、只把 gain 压到 0
 *     —— 参考客户端就是「眼」管画面、「喇叭」管声音，两件事分开。
 *   · 独奏（solo）：只要有任何一条轨独奏，**其余能出声的轨**一律静音。
 *     同样分两种：音频轨整段退出合成；视频 / 叠加轨留画面、gain 归 0。
 *
 * 为什么静音视频轨用「gain 归 0」而不是从列表里删掉：删掉等于连画面一起没了，
 * 那就和「隐藏」没区别了 —— 两个按钮做出同一个效果 = 其中一个必然是假的。
 * gain 归 0 两头都吃：预览里 MediaLayer 把 `gain` 乘进 `<video>.volume`，
 * 导出里 render.js 把它写成 ffmpeg 的 `volume=0`。一处生效、两处一致。
 *
 * 锁定不在这里：锁定只拦「编辑」（拖动 / 修剪 / 删除 / 分割），不拦播放 ——
 * 锁的是轨道上的片段别被误操作，不是把这条轨从成片里抠掉。
 *
 * @param {Array} clips 全部片段
 * @param {{hidden?: string[], muted?: string[], locked?: string[], solo?: string[]}} trackState 轨道开关
 * @returns {Array} 参与预览与导出的片段（新数组，不改入参）
 */
export function effectiveClips(clips, trackState) {
  const list = Array.isArray(clips) ? clips : []
  const state = trackState && typeof trackState === 'object' ? trackState : {}
  const hidden = Array.isArray(state.hidden) ? new Set(state.hidden) : null
  const muted = Array.isArray(state.muted) ? new Set(state.muted) : null
  const solo = Array.isArray(state.solo) ? new Set(state.solo.filter((key) => AUDIO_CAPABLE.has(key))) : null
  const anySolo = solo && solo.size > 0
  // 一条轨要被消音：自己被静音，或（有独奏存在且自己不是被独奏的那条）
  const silentTrack = (track) =>
    muted?.has(track) || (Boolean(anySolo) && AUDIO_CAPABLE.has(track) && !solo.has(track))

  const keep = list.filter((item) => {
    if (!item || item.enabled === false) return false
    if (hidden?.has(item.track)) return false
    // 音频轨没有画面可留，消音就是整段退出合成
    if (silentTrack(item.track) && item.track === 'audio') return false
    return true
  })

  const needSilence = (item) => item.track !== 'audio' && silentTrack(item.track)
  if (!keep.some(needSilence)) return keep
  // 只给真正要消音的那几条改 gain，其余对象原样透传（引用不变 ⇒ 不会白白触发重渲染）
  return keep.map((item) => (needSilence(item) ? { ...item, gain: 0 } : item))
}

/** 片段与 [from, to) 这个时间窗有交集（用来挑"该提前挂载谁"） */
export function overlapsWindow(clip, from, to) {
  const start = num(clip && clip.start)
  const duration = num(clip && clip.duration)
  if (!(duration > 0)) return false
  return start < to && start + duration > from
}

/**
 * 热点窗口（按 HOT_STEP 量化）。
 * @returns {[number, number]} [from, to)
 */
export function hotWindowAt(t) {
  const time = Number.isFinite(Number(t)) ? Number(t) : 0
  const origin = Math.floor(time / HOT_STEP) * HOT_STEP
  return [origin - HOT_BEFORE, origin + HOT_STEP + HOT_AFTER]
}

/**
 * 层叠顺序：底 → 顶。
 *
 * 规则的真源搬到了 `shared/layers.js`（导出侧的主进程 require 同一份）：
 * 先比 `clip.z`（画面层级/自由层级），再比起点（后摆上去的压住先摆的），
 * 最后比创建序号。**缺省 z 时与改动前逐帧一致** —— 老草稿不写这个字段也照样对。
 *
 * ⚠️ 以前这里的实现是"起点靠后在上"，在两段画中画完全重叠时等于没得选：
 *    用户唯一能让 A 压住 B 的办法是改时间。画面层级与时间先后是两件事，
 *    这也是"自由层级"存在的理由。
 */
export function layerOrder(list) {
  return [...(list || [])].sort(compareLayers)
}

/**
 * 这一刻"该显示什么"的候选片段。
 *
 * 优先级与改动前完全一致（视频轨 → 文字素材 → 音频轨），
 * 这条顺序是被 E2E 钉住的（字幕片段叠在画面上、音频只在没有画面时露脸），不要调。
 */
export function visualCandidates(clips, t) {
  const list = Array.isArray(clips) ? clips : []
  const video = list.filter((item) => item.track === 'video' && spansAt(item, t))
  if (video.length) return video
  const text = list.filter((item) => item.track === 'text' && item.assetId && spansAt(item, t))
  if (text.length) return text
  return list.filter((item) => item.track === 'audio' && spansAt(item, t))
}

/**
 * 播放头落在某个**真的会生效**的转场窗口里时，给出这一帧该怎么混。
 *
 * 窗口 = [接缝时刻 − 时长, 接缝时刻)，与 `effectiveTransitions` 同一份规则
 * （也就是与时间线角标、导出结算同一份），所以不会出现"角标画了但预览没转"。
 *
 * @returns {null|{key:string, duration:number, progress:number, incomingId:string, incomingSourceTime:number}}
 */
export function transitionAt(clips, t) {
  const list = Array.isArray(clips) ? clips : []
  const marks = effectiveTransitions(list)
  if (!marks.length) return null
  const hit = marks.find((mark) => t >= mark.at - mark.duration - EPSILON && t < mark.at - EPSILON)
  if (!hit) return null
  const lane = list
    .filter((item) => item.track === 'video' && num(item.duration) > 0.01)
    .sort((a, b) => num(a.start) - num(b.start))
  const idx = lane.findIndex((item) => `tr_${item.id}` === hit.id)
  const incoming = lane[idx + 1]
  if (!incoming) return null
  const progress = Math.min(1, Math.max(0, (t - (hit.at - hit.duration)) / hit.duration))
  /* 后一段在这一刻才走了 progress × d 秒，所以要按**它的**源时间取画面 */
  const offset = num(incoming.offset)
  const limit = num(incoming.sourceDuration) > 0 ? num(incoming.sourceDuration) - 0.05 : Number.POSITIVE_INFINITY
  return {
    key: hit.key,
    duration: hit.duration,
    progress,
    incomingId: incoming.id,
    incomingSourceTime: Math.max(0, Math.min(offset + progress * hit.duration, limit))
  }
}

/** 需要解码器参与的素材类型。只有这几类值得"提前挂载"（见 compositeAt 里的说明） */
export const MEDIA_KINDS = ['video', 'image']

/** 片段的类型（片段上没记就回素材表） */
function kindOf(clip, assets) {
  return clip.kind || assetOf(clip, assets)?.kind || 'video'
}

/**
 * 片段对应的素材。
 *
 * ⚠️ **片段没记 assetId 时必须返回 null**，不能去素材表里 find：
 *    `item.id === undefined` 会命中**第一个**没带 id 的素材，
 *    于是同一条时间线上的好几段会去播同一个素材 —— 不报错、不空屏，
 *    只是"画面不对"，属于最难查的那一类。
 *    旧草稿 / 手工构造的片段确实可能没有 assetId，这时一律退回片段自己记的 url。
 */
function assetOf(clip, assets) {
  if (!clip || !clip.assetId) return null
  return (assets || []).find((item) => item.id === clip.assetId) || null
}

/** 素材 url：片段上记的优先（本地素材带 path，导出也读它），其次回素材表 */
function urlOf(clip, assets) {
  const asset = assetOf(clip, assets)
  return asset?.url || clip?.url || ''
}

/** 片段 → 一层画面。纯描述，不带任何 DOM 语义 */
export /* 倒放片段在**预览**里只能静音：浏览器没有负速播放（`playbackRate = -1` 会被规范
   静默忽略成 1），也就不可能把声音反着放。导出侧的 `areverse` 是完整的 ——
   这是一个**写在面板上、说得出来**的取舍，不是静默失效。
   ⚠️ 别改成"正着放"，那是错的；也别改成"整条音轨静音"，只该压这一段。 */
const audible = (clip, gain) => (isReversed(clip) ? 0 : gain)

function describeLayer(clip, assets, t, options = {}) {
  const asset = assetOf(clip, assets)
  const sourceTime = Number.isFinite(Number(options.sourceTime))
    ? Number(options.sourceTime)
    : sourceTimeAt(clip, t)
  /* 关键帧：**在合成这一步**就把这一帧该用的值算出来（不是留给组件去插值）——
     预览与导出共用 shared/effects.js 的 keyframeValue，两边同一份线性插值。
     ⚠️ 关键帧的时间轴是**片段内部的秒**（t − clip.start），不是时间线时间。 */
  const kf = readKeyframes(clip.keyframes)
  const local = Math.max(0, Number(t) - Number(clip.start || 0))
  const kv = (prop, fallback) => (hasKeyframes(kf) ? keyframeValue(kf, prop, local, fallback) : Number(fallback))
  /**
   * 音量：包络优先。插值与导出侧的 `volumeExpr` 是同一份线性口径，
   * 所以"面板上画的那条渐弱曲线"在预览里听得到、在成片里也一样。
   * ⚠️ 包络的采样点是**片段内秒数**（与关键帧同一时间轴），不是时间线秒数。
   */
  const baseGain = Number.isFinite(Number(clip.gain)) ? Number(clip.gain) : 100
  const volumeKf = readVolumeKf(clip.volumeKf)
  const gain = hasVolumeKf(volumeKf) ? volumeAt(volumeKf, local, baseGain) : baseGain
  return {
    id: clip.id,
    clipId: clip.id,
    /**
     * 归属的**外层**复合片段（普通片段为空）。
     *
     * 复合片段展开之后，这一层是内部的某个子片段 —— 它的 id 在 clips 里查不到。
     * 预览里的点选、选框、右栏、角标全都要落到"用户真正选中的那个片段"上，
     * 所以必须把归属一起带出去，否则"点一下画面里复合片段的内部"会选中一个不存在的 id，
     * 表现是右栏空白、选框不出现、拖动毫无反应。
     */
    ownerId: clip.ownerId || '',
    /* 画面层级（自由层级）：只决定"谁压住谁"，与时间无关。
       预览按它排序、导出按**同一份**比较函数排 overlay 链。 */
    z: readZ(clip),
    assetId: clip.assetId || '',
    kind: clip.kind || asset?.kind || 'video',
    url: urlOf(clip, assets),
    name: clip.name || asset?.name || '',
    text: clip.text || asset?.text || '',
    sourceTime,
    filter: clip.filter || 'none',
    filterIntensity: Number.isFinite(Number(clip.filterIntensity)) ? Number(clip.filterIntensity) : 1,
    scale: kv('scale', Number.isFinite(Number(clip.scale)) ? Number(clip.scale) : 100),
    opacity: kv('opacity', Number.isFinite(Number(clip.opacity)) ? Number(clip.opacity) : 100),
    /* 片段音量（属性面板的音量滑杆 + 音量包络）。⚠️ 以前它只进导出、不进预览：
       滑杆改了 clips 里的 gain，成片真的变小声，预览一点没变。
       ⚠️ 倒放片段在预览里被压到 0（浏览器不能反放声音，见上面 audible 的说明）。 */
    gain: audible(clip, gain),
    /* 倒放（预览靠 sourceTimeAt 反向取帧；这里把标记带给组件，用来提示"预览静音"） */
    reverse: isReversed(clip),
    /* 自由裁剪框（裁剪 + 铺满）。真源换算在 shared/crop.js，导出读的是同一个字段 */
    crop: clip.crop || null,
    /* 「画面 · 位置/旋转」（属性面板）—— 预览靠它拼 transform，
       导出侧 render.js 用同一组字段拼 pad/crop 偏移与 rotate，两边同一口径。 */
    posX: kv('posX', Number.isFinite(Number(clip.posX)) ? Number(clip.posX) : 0),
    posY: kv('posY', Number.isFinite(Number(clip.posY)) ? Number(clip.posY) : 0),
    rotate: kv('rotate', Number.isFinite(Number(clip.rotate)) ? Number(clip.rotate) : 0),
    /* 「调整 / 美颜」—— 原样带过去，换算在 shared/adjust.js 里，两侧共用 */
    adjust: clip.adjust || null,
    beauty: clip.beauty || null,
    /* 「效果」—— 圆角 / 蒙版 / 抠像 / 混合 / 变形 / 描边 / 阴影。
       原样带过去，换算全在 shared/effects.js，两侧共用（见那份文件的说明）。 */
    effects: clip.effects || null,
    /* 倍速。预览靠它设 playbackRate；**源时间的换算不在这里** ——
       那件事由 sourceTimeAt 负责（它内部乘了倍速），两者必须同时成立：
       只设 playbackRate 会让"画面起始点"错，只乘 sourceTime 会让"推进速度"错。 */
    speed: clipRateAt(clip, t),
    /* 「变速保留音高」：预览侧靠 `HTMLMediaElement.preservesPitch` 实现，
       关掉就是"快放会变尖"；导出侧对应 atempo（保音高）与 asetrate（不保）。
       两边读同一个布尔，缺省视为开。 */
    keepPitch: clip.keepPitch !== false,
    visible: Boolean(options.visible),
    role: options.role || 'hidden',
    xfade: options.xfade || null
  }
}

/**
 * 求这一帧的合成结果。
 *
 * @param {Array} clips 全部片段
 * @param {Array} assets 素材表
 * @param {number} playhead 播放头（**原始时间线坐标**）
 * @param {{fallbackClip?: object}} [options] fallbackClip：没有任何片段覆盖这一刻时的
 *        兜底片段（= 选中的那一段）。这一条是被 E2E 钉住的行为：时间线空白处的
 *        播放头不该让画面变成一片黑，退回选中的片段才符合"点一下也能看一眼"。
 * @returns {{layers:Array, main:object|null, audio:Array, pip:Array, text:Array, transition:object|null, window:[number,number]}}
 */
export function compositeAt(clips, assets, playhead, options = {}) {
  const list = Array.isArray(clips) ? clips : []
  const pool = Array.isArray(assets) ? assets : []
  const t = Number.isFinite(Number(playhead)) ? Number(playhead) : 0
  const tr = transitionAt(list, t)

  const [from, to] = hotWindowAt(t)

  /* 画面层的候选池：视频轨 + 带素材的文字片段 + 音频轨（三者优先级见 visualCandidates） */
  const poolClips = list.filter(
    (item) => item.track === 'video' || (item.track === 'text' && item.assetId) || item.track === 'audio'
  )
  const hot = poolClips.filter((item) => overlapsWindow(item, from, to))

  /* 转场的后一段**此刻还没轮到它**（播放头还在前一段里），但它马上就要出场，
     所以它必须先在 DOM 里 —— 晚了就又是"转场第一帧黑一下"。 */
  const incomingId = tr ? tr.incomingId : ''
  const need = new Set(hot.map((item) => item.id))
  if (incomingId) need.add(incomingId)

  const visibleRaw = visualCandidates(list, t)
  const visibleIds = new Set(visibleRaw.map((item) => item.id))

  /**
   * 只有**需要解码的**片段（视频 / 图片）才值得"提前挂载"。
   *
   * 文字素材与音频轨的那一层画出来只是一张占位卡，预挂载它除了往 DOM 里塞一堆
   * 看不见的元素、让"画面上现在显示的是谁"变得含混之外没有任何收益 ——
   * 它治的病（换 src 要重新解码）本来就不存在。
   */
  const mounted = poolClips.filter((item) => {
    if (!need.has(item.id)) return false
    if (visibleIds.has(item.id) || item.id === incomingId) return true
    return MEDIA_KINDS.includes(kindOf(item, pool))
  })

  /**
   * 顶层（最上面那一层可见画面）。
   *
   * 转场期间刻意**不算** incoming：那时"主画面"仍是前一段（它在时间线上确实还占着这一格），
   * 后一段只是"正在盖过来的一层"。把它算进来会让"播放头压在接缝前一帧"时
   * 播出的源时间突然跳到后一段的入点。
   */
  const ordered = layerOrder(mounted)
  const layers = ordered.map((clip) => {
    if (clip.id === incomingId) {
      return describeLayer(clip, pool, t, {
        visible: true,
        role: 'incoming',
        sourceTime: tr.incomingSourceTime,
        xfade: { key: tr.key, progress: tr.progress }
      })
    }
    if (!visibleIds.has(clip.id)) return describeLayer(clip, pool, t, { visible: false, role: 'hot' })
    return describeLayer(clip, pool, t, { visible: true, role: 'overlap' })
  })

  /**
   * 顶层可见层 = 主层：它负责发声、负责 `.wb-player[data-source-time]`、
   * 也负责属性面板与角标。转场期间 incoming 虽然在最上面，但它是"正在盖过来的一层"，
   * 不算主层（见上面的说明）。
   */
  let main = null
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    if (layers[i].visible && layers[i].role !== 'incoming') {
      layers[i].role = 'main'
      main = layers[i]
      break
    }
  }

  /* 兜底：这一刻没有任何片段覆盖（时间线空白、或播放头在全部片段之后） */
  if (!main && options.fallbackClip) {
    const fallback = describeLayer(options.fallbackClip, pool, t, { visible: true, role: 'fallback' })
    layers.push(fallback)
    main = fallback
  }

  /* 音频轨：这一刻**所有**在播的片段（以前只取 id 最大的一条，重叠的配乐凭空少一条） */
  const audio = layerOrder(list.filter((item) => item.track === 'audio' && spansAt(item, t))).map((clip) => {
    const asset = assetOf(clip, pool)
    const localAudio = Math.max(0, t - num(clip.start))
    const vkf = readVolumeKf(clip.volumeKf)
    const base = Number.isFinite(Number(clip.gain)) ? Number(clip.gain) : 100
    return {
      id: clip.id,
      clipId: clip.id,
      ownerId: clip.ownerId || '',
      url: asset?.url || clip.url || '',
      sourceTime: sourceTimeAt(clip, t),
      gain: audible(clip, hasVolumeKf(vkf) ? volumeAt(vkf, localAudio, base) : base),
      speed: clipRateAt(clip, t),
      keepPitch: clip.keepPitch !== false,
      reverse: isReversed(clip)
    }
  })

  /* 叠加轨（画中画）：同样取全部 */
  const pip = layerOrder(list.filter((item) => item.track === 'overlay' && spansAt(item, t)))
    .map((clip) => {
      const asset = assetOf(clip, pool)
      const url = asset?.url || clip.url || ''
      if (!url) return null
      const localPip = Math.max(0, t - num(clip.start))
      const pipVkf = readVolumeKf(clip.volumeKf)
      const pipBase = Number.isFinite(Number(clip.gain)) ? Number(clip.gain) : 100
      return {
        id: clip.id,
        clipId: clip.id,
        ownerId: clip.ownerId || '',
        /* 素材 id：预览画质要按它决定"这一层用不用代理文件"（代理只换 url，不换素材） */
        assetId: clip.assetId || '',
        url,
        kind: clip.kind || asset?.kind || 'video',
        sourceTime: sourceTimeAt(clip, t),
        /* 画中画的层级：两段画中画完全重叠时，唯一能决定谁压住谁的就是它 */
        z: readZ(clip),
        ...pipOf(clip),
        opacity: Number.isFinite(Number(clip.opacity)) ? Number(clip.opacity) : 100,
        gain: audible(clip, hasVolumeKf(pipVkf) ? volumeAt(pipVkf, localPip, pipBase) : pipBase),
        speed: clipRateAt(clip, t),
        keepPitch: clip.keepPitch !== false,
        reverse: isReversed(clip),
        /* 画中画也吃「效果」（圆角/蒙版/抠像/描边/阴影/斜切/混合）——
           真源同一份，导出侧 render.js 的 pip 链用的是同一组换算。 */
        effects: clip.effects || null
      }
    })
    .filter(Boolean)

  /* 字幕轨：样式面板建出来的那一种（没有 assetId），一律叠在画面上 */
  const text = layerOrder(
    list.filter((item) => item.track === 'text' && !item.assetId && spansAt(item, t))
  ).map((clip) => ({
    id: clip.id,
    text: clip.text || clip.name,
    style: textStyleDef(clip.textStyle).key,
    /* 右侧检查器对**这一条**字幕的覆写（字号倍率 / 颜色 / 锚点 / 偏移）。
       原样带给 Stage —— 它走 shared/textOverrides.js 与导出侧同一个函数，
       所以"面板上把这条字幕调成红的"在预览与成片里是同一个红。 */
    textScale: clip.textScale,
    textColor: clip.textColor,
    textAnchor: clip.textAnchor,
    textOffset: clip.textOffset,
    /* 排版三项：行距 / 对齐 / 背景框。原样带给 Stage，与导出侧共用同一套字段 */
    textLineHeight: clip.textLineHeight,
    textAlign: clip.textAlign,
    textBgOn: clip.textBgOn,
    textBgColor: clip.textBgColor,
    textBgOpacity: clip.textBgOpacity,
    textBgPad: clip.textBgPad,
    /* 文字动画：入场 / 出场 / 循环 + 两个时长。时间轴需要 start/duration
       才能算出"出场何时开始"，而 overlay 这一层**必须**带上它们 ——
       少了就只剩入场，出场永远不触发（元素不会自己知道自己是几秒的片段）。 */
    start: clip.start,
    duration: clip.duration,
    textIn: clip.textIn,
    textOut: clip.textOut,
    textLoop: clip.textLoop,
    textInDur: clip.textInDur,
    textOutDur: clip.textOutDur,
    /* 自定义字体：family 给预览（CSS），path 给导出（drawtext 的 fontfile） */
    textFont: clip.textFont,
    textFontPath: clip.textFontPath
  }))

  return { layers, main, audio, pip, text, transition: tr, window: [from, to] }
}
