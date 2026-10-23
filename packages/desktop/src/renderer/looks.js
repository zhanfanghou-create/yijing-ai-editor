/**
 * 滤镜与转场 —— 渲染层侧（预览用）。
 *
 * 数据来自 shared/looks.json（唯一真源）。本文件只做两件事：
 *   1. 把滤镜参数翻译成 **CSS filter**，让预览里当场看得见（不是"应用了但画面不动"）；
 *   2. 把时间线按转场做一遍时长结算，供导出面板与时间线显示**真实成片时长**。
 *
 * ⚠️ 与 src/main/looks.js 是一对镜像：那边生成 ffmpeg 滤镜串。两份实现必须给出
 * 一致的结果，由 tools/looks-selftest.mjs 用同一组夹具双向对拍钉住
 * （任一侧改动而另一侧没跟上，闸门立刻红）。改这里请同步改那边。
 */
import looks from '../shared/looks.json' with { type: 'json' }

export const FILTERS = looks.filters
export const TRANSITIONS = looks.transitions
export const TRANSITION_LIMITS = looks.limits

export const FILTER_KEYS = FILTERS.map((item) => item.key)
export const TRANSITION_KEYS = TRANSITIONS.map((item) => item.key)

const FILTER_BY_KEY = Object.fromEntries(FILTERS.map((item) => [item.key, item]))
const TRANSITION_BY_KEY = Object.fromEntries(TRANSITIONS.map((item) => [item.key, item]))

/** 时间轴比较用的容差：与 trim.js 的 EPSILON 同量级，避免 0.30000000000000004 判成"有缝" */
export const LOOK_EPSILON = 1e-3

export const filterDef = (key) => FILTER_BY_KEY[key] || FILTER_BY_KEY.none
export const transitionDef = (key) => TRANSITION_BY_KEY[key] || TRANSITION_BY_KEY.none

export const filterLabel = (key) => filterDef(key).label
export const transitionLabel = (key) => transitionDef(key).label

/** 是不是"没效果"的默认项（原片 / 无转场）——用于在片段上不显示角标 */
export const isNoopFilter = (key) => filterDef(key).key === 'none'
export const isNoopTransition = (key) => transitionDef(key).key === 'none'

/**
 * 按强度把参数朝「原片」收缩。
 * intensity=1 用整组参数，intensity=0 完全等于原片。
 * 这样面板上可以给一个滑杆而不用给每个参数各做一个。
 */
export function scaleFilterParams(params, intensity = 1) {
  const t = Math.min(1, Math.max(0, Number(intensity)))
  const lerp = (value, base) => Number((base + (Number(value) - base) * t).toFixed(4))
  return {
    brightness: lerp(params.brightness, 1),
    contrast: lerp(params.contrast, 1),
    saturate: lerp(params.saturate, 1),
    grayscale: lerp(params.grayscale, 0),
    // sepia 是"从原图往棕调走多少"，基准恒为 0
    sepia: lerp(params.sepia, 0),
    hue: lerp(params.hue, 0)
  }
}

/**
 * 参数 → CSS filter 串。
 *
 * 顺序必须与 main/looks.js 的 ffmpeg 链**同序**，否则同样一组参数在两侧会得到不同画面：
 *   brightness → sepia → contrast → saturate(含去色) → hue-rotate
 * 其中去色（grayscale）折进 saturate（saturate × (1-g)），因为 CSS 与 ffmpeg 的
 * 去色都是"把饱和度压到 0"，折进去两侧都能表达，还少一环。
 */
export function cssFilterFor(key, intensity = 1) {
  const def = filterDef(key)
  if (def.key === 'none') return ''
  const p = scaleFilterParams(def.params, intensity)
  const parts = []
  if (Math.abs(p.brightness - 1) > 1e-4) parts.push(`brightness(${p.brightness})`)
  if (p.sepia > 1e-4) parts.push(`sepia(${p.sepia})`)
  if (Math.abs(p.contrast - 1) > 1e-4) parts.push(`contrast(${p.contrast})`)
  const sat = p.saturate * (1 - p.grayscale)
  if (Math.abs(sat - 1) > 1e-4) parts.push(`saturate(${Number(sat.toFixed(4))})`)
  if (Math.abs(p.hue) > 1e-4) parts.push(`hue-rotate(${p.hue}deg)`)
  return parts.join(' ')
}

/* ------------------------------- 转场时长结算 ------------------------------- */

/** 把时长夹进 [min, max]，并保证不超过相邻两段能提供的长度 */
export function clampTransitionDuration(seconds, neighbors = []) {
  const { minDuration, maxDuration } = TRANSITION_LIMITS
  const wanted = Number(seconds)
  let value = Number.isFinite(wanted) ? wanted : 0
  if (value <= 0) return 0
  value = Math.min(maxDuration, Math.max(minDuration, value))
  for (const length of neighbors) {
    const len = Number(length)
    if (Number.isFinite(len) && len > 0) value = Math.min(value, Math.max(0, len - 0.05))
  }
  return Number(value.toFixed(3))
}

/**
 * 结算一条轨道上的转场效果。
 *
 * 语义（这是"转场到底会不会改变成片时长"这个问题的唯一答案）：
 *   转场发生在**同一条轨、且首尾相接**的两个片段之间（缝隙 > 容差就当没有转场，
 *   因为 xfade 需要真实重叠，夹着黑场的两段之间做不了转场）。
 *   它取前一段的**末 d 秒**、后一段的**首 d 秒**做交叠，因此：
 *     · 后一段的**内容**不丢（前 d 秒参与了混合，后面照常播完）；
 *     · 成片总时长**减少 d**，其后的片段整体向前平移 d（ripple）。
 *   所以这个函数返回的是"结算后的片段起点"，而不是原起点 —— 时间线上的角标
 *   与导出面板的成片时长都读它，保证「显示多长」与「导出多长」是同一个数。
 *
 * @param {Array} clips 同一条轨（通常传视频轨）的片段，start/duration/transition/transitionDuration
 * @returns {{ segments: Array, total: number, saved: number }}
 */
export function resolveTrack(clips) {
  const list = (Array.isArray(clips) ? clips : [])
    .filter((clip) => Number(clip.duration) > 0.01)
    .sort((a, b) => Number(a.start) - Number(b.start))

  const segments = []
  let cursor = 0
  let saved = 0

  for (let i = 0; i < list.length; i += 1) {
    const clip = list[i]
    const rawStart = Number(clip.start)
    const duration = Number(clip.duration)
    // 起点按"原起点 - 此前累计节省"结算；但早于游标的空档不重复补
    const start = Math.max(cursor, rawStart - saved)
    const gap = Math.max(0, start - cursor)

    const next = list[i + 1]
    const def = transitionDef(clip.transition)
    const adjacent = Boolean(next) && Math.abs(rawStart + duration - Number(next.start)) <= LOOK_EPSILON
    const usable = def.key !== 'none' && adjacent
    const d = usable ? clampTransitionDuration(clip.transitionDuration ?? def.defaultDuration, [duration, Number(next.duration)]) : 0

    segments.push({
      id: clip.id,
      clip,
      start: Number(start.toFixed(3)),
      gap: Number(gap.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      transitionOut: d > 0 ? { key: def.key, ffmpeg: def.ffmpeg, duration: d } : null
    })

    cursor = start + duration
    if (d > 0) {
      saved += d
      cursor -= d
    }
  }

  return { segments, total: Number(cursor.toFixed(3)), saved: Number(saved.toFixed(3)) }
}

/** 整条时间线的结算总时长（视频轨按转场收缩，音轨与字幕轨取绝对终点） */
export function resolveTotalDuration(clips) {
  const list = Array.isArray(clips) ? clips : []
  /* ⚠️ 叠加轨**不进主链结算**：它是叠上去的一层，不占用主画面的时间轴。
     混进去之后，画中画会充当一段主画面（把成片时长与转场接缝全算错）。 */
  const video = resolveTrack(list.filter((clip) => clip.track === 'video'))
  const other = list
    .filter((clip) => clip.track === 'audio' || clip.track === 'text' || clip.track === 'overlay')
    .reduce((max, clip) => Math.max(max, Number(clip.start) + Number(clip.duration)), 0)
  return Math.max(video.total, Number(other.toFixed(3)), 0)
}

/**
 * 时间线上要画的转场角标：只给「真的会生效」的那些。
 *
 * ⚠️ 这里刻意用**原始起点**（clip.start + clip.duration）而不是 resolveTrack 结算后的
 * 起点：时间线是按原始坐标画的（转场不搬动片段），角标必须贴着用户看到的那个接缝。
 * 用结算后的坐标会让角标整体左移，越靠后的接缝偏得越多 —— 看着就像"转场没落在切点上"。
 * 判"是否生效"的规则与 resolveTrack 完全一致（同轨、首尾相接、时长夹取），
 * 所以不会出现"画了角标但导出没转场"。
 */
export function effectiveTransitions(clips) {
  const list = (Array.isArray(clips) ? clips : [])
    .filter((clip) => clip.track === 'video' && Number(clip.duration) > 0.01)
    .sort((a, b) => Number(a.start) - Number(b.start))

  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const clip = list[i]
    const next = list[i + 1]
    if (!next) continue
    const def = transitionDef(clip.transition)
    if (def.key === 'none') continue
    if (Math.abs(Number(clip.start) + Number(clip.duration) - Number(next.start)) > LOOK_EPSILON) continue
    const d = clampTransitionDuration(clip.transitionDuration ?? def.defaultDuration, [clip.duration, next.duration])
    if (d <= 0) continue
    out.push({
      id: `tr_${clip.id}`,
      at: Number((Number(clip.start) + Number(clip.duration)).toFixed(3)),
      key: def.key,
      label: def.label,
      duration: d
    })
  }
  return out
}
