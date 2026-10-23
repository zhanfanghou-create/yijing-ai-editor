/**
 * 场景切换检测（自动切点）—— 解析 ffmpeg 的检测输出 + 把切点换算到时间线。
 *
 * 为什么非要单独的模块：这里有两段**都容易静默出错**的算术。
 *   ① ffmpeg 的 `pts_time` 是**源文件里的绝对秒数**，而时间线上要的是**片段内秒数**；
 *      漏掉 `clip.offset` ⇒ 切点整体偏移入点；漏掉 `clip.speed` ⇒ 2 倍速下每个切点
 *      都偏一半。两种都"切得出来、不报错"，只是每次都切在画面变换的旁边。
 *   ② 切点离片段两端太近会切出 0.0x 秒的碎段（一串肉眼看不见的细条），
 *      那种片段在时间线上像灰尘，删也不是留也不是。
 *
 * 刻意不做的事：曲线变速与倒放片段**不给**自动切点。
 *   · 曲线：源时间 → 时间线时间要反解曲线下面积，而 ffmpeg 侧的切点又是按常速段拼的，
 *     两边反解口径一旦有分毫差别就是"切点漂移"；
 *   · 倒放：源时间前进 = 时间线后退，切点顺序要整段反过来。
 * 这两类直接由调用方拒绝并说明原因，比"切出来看着差不多"诚实。
 *
 * ⚠️ CJS：主进程解析 ffmpeg 输出要用，渲染层换算切点也要用（同一份，不许各写一套）。
 *    已加进 packages/desktop/vite.config.mjs 的 commonjsOptions.include。
 */
const region = require('./region.js')

/** 相邻切点最小间隔（秒）：比这更近的两个切点合成一个 */
const SCENE_MIN_GAP = 0.3
/** 单段最短长度（秒）：离两端太近的切点直接丢掉（避免切出"灰尘片段"） */
const MIN_SEGMENT = 0.2
/** 默认灵敏度：参考客户端默认档位附近的经验值，0.3 对「硬切」很稳 */
const DEFAULT_THRESHOLD = 0.3

/** `frame:  123  pts: 4423680  pts_time:1.536` */
const PTS_RE = /pts_time:([0-9]+(?:\.[0-9]+)?)/
/** `lavfi.scene_score=0.412` */
const SCORE_RE = /lavfi\.scene_score=([0-9]*\.?[0-9]+)/

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
const round3 = (value) => Math.round(Number(value) * 1000) / 1000

/**
 * 解析 ffmpeg 的场景检测输出。
 *
 * 输出长这样（metadata=mode=print 会把每个命中帧的元数据打出来）：
 *   frame:  180  pts: 4492800  pts_time:3.2
 *   lavfi.scene_score=0.421
 * 也可能两行顺序反过来，或者夹着别的日志 —— 所以按"逐行找 pts_time，
 * 分数就近配对"来解析，不假设行的相对位置。
 *
 * @param {string} text ffmpeg 的 stdout+stderr
 * @returns {Array<{at:number, score:number}>} 按时间升序
 */
function parseScenes(text) {
  const lines = String(text || '').split(/\r?\n/)
  const hits = []
  let pending = null
  /* 分数行可能出现在 pts 行**之前**（ffmpeg 的 metadata 打印顺序不保证），
     所以先记下来，等下一条 pts 出现时带上 —— 否则分数恒为 0，
     而 0 分与"根本没检测到"在调用方看起来是一样的。 */
  let leadingScore = 0
  for (const line of lines) {
    const pts = PTS_RE.exec(line)
    if (pts) {
      if (pending) hits.push(pending)
      pending = { at: round3(Number(pts[1])), score: leadingScore }
      leadingScore = 0
      continue
    }
    const score = SCORE_RE.exec(line)
    if (score) {
      if (pending) pending.score = Number(score[1])
      else leadingScore = Number(score[1])
    }
  }
  if (pending) hits.push(pending)
  return hits
    .filter((hit) => Number.isFinite(hit.at) && hit.at > 0)
    .sort((a, b) => a.at - b.at)
}

/**
 * 片段能不能做自动切点。返回 `{ ok, reason }`，理由直接给用户看。
 */
function sceneSupport(clip) {
  if (!clip) return { ok: false, reason: '没有选中片段' }
  if (clip.reverse === true) return { ok: false, reason: '倒放片段不做自动切点（源时间与时间线方向相反，切点会整体错位）' }
  const points = clip.speedCurve && Array.isArray(clip.speedCurve.points) ? clip.speedCurve.points : null
  if (points && points.length >= 2) {
    return { ok: false, reason: '曲线变速片段不做自动切点（源时间要反解曲线面积，和导出侧的切段口径对不齐）' }
  }
  return { ok: true, reason: '' }
}

/**
 * 把**源文件绝对秒数**的切点换算成**时间线秒数**，并做去噪。
 *
 * 换算：`timeline = clip.start + (source - clip.offset) / speed`
 *   · 减 offset：源里前 N 秒没被用上，直接加会把整条切点往前顶；
 *   · 除 speed：2 倍速下源里走 2 秒，时间线上只占 1 秒。
 *
 * 去噪三件事：只留落在片段用掉的那一段里的、离两端不足 MIN_SEGMENT 的丢掉、
 * 相邻太近的只留一个（否则切出一串 0.1 秒的碎段）。
 *
 * @param {object} clip 片段
 * @param {Array<{at:number}>} scenes parseScenes 的结果
 * @returns {number[]} 时间线上的切点（升序，不含片段两端）
 */
function timelineCuts(clip, scenes) {
  if (!clip || !sceneSupport(clip).ok) return []
  const start = num(clip.start)
  const duration = num(clip.duration)
  if (!(duration > 0)) return []
  const speed = num(clip.speed) > 0 ? num(clip.speed) : 1
  const offset = num(clip.offset)
  /* ⚠️ 必须先按时间升序再走"相邻太近就合并"：
     那一刻的判断是"和**上一条已保留**的切点比距离"，输入乱序时会拿大数去比小数，
     差值恒为负 ⇒ 后面的切点被整片丢掉（实测就丢过一个）。 */
  const list = (Array.isArray(scenes) ? scenes.slice() : []).sort((a, b) => num(a && a.at) - num(b && b.at))
  const cuts = []
  for (const hit of list) {
    const source = num(hit && hit.at)
    if (!(source > 0)) continue
    const local = (source - offset) / speed
    if (!(local > MIN_SEGMENT)) continue
    if (!(local < duration - MIN_SEGMENT)) continue
    const at = round3(start + local)
    if (cuts.length && at - cuts[cuts.length - 1] < SCENE_MIN_GAP) continue
    cuts.push(at)
  }
  return cuts
}

/**
 * 按切点把片段切成若干段。
 *
 * 切片的算术**全部走 `region.sliceClip`**（曲线残段重参数化、倒放取区间结尾
 * 这些已经在那边钉住了 75 项断言）。这里再写一份"顺手拼一下"的切片代码，
 * 就是给同一个坑留两个入口 —— 而曲线上那种错法不报错、只是速度分布变了。
 *
 * @param {object} clip 片段
 * @param {number[]} cuts 时间线切点
 * @param {(index:number)=>string} makeId 发号器（第一段沿用原 id，其余发新号）
 * @returns {Array} 新片段表（长度 = 切点个数 + 1；不合法时返回 [clip]）
 */
function splitByScenes(clip, cuts, makeId) {
  if (!clip) return []
  const start = num(clip.start)
  const end = start + num(clip.duration)
  const points = (Array.isArray(cuts) ? cuts : [])
    .map((value) => num(value))
    .filter((value) => value > start + MIN_SEGMENT - 1e-6 && value < end - MIN_SEGMENT + 1e-6)
    .sort((a, b) => a - b)
  if (!points.length) return [clip]
  const bounds = [start, ...points, end]
  const out = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const piece = region.sliceClip(clip, bounds[i], bounds[i + 1])
    if (!piece) continue
    piece.id = i === 0 ? clip.id : (typeof makeId === 'function' ? makeId(i) : `${clip.id}_s${i}`)
    out.push(piece)
  }
  return out.length ? out : [clip]
}

module.exports = {
  SCENE_MIN_GAP,
  MIN_SEGMENT,
  DEFAULT_THRESHOLD,
  parseScenes,
  sceneSupport,
  timelineCuts,
  splitByScenes
}
