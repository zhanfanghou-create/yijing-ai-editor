'use strict'
/**
 * 时间区域（真源唯一）。
 *
 * 「时间区域」= 时间线上框出来的一段 [start, end)，对它做整体操作：
 *   删除（ripple 前移）/ 复制 / 剪切 / 粘贴到播放头 / 只导出这一段。
 *
 * 为什么必须是纯逻辑、还放在 shared：
 *   · 删除与导出**都要切片段**，切法的核心是「区间边界落在某片段的第几秒 → 源素材的哪一秒」。
 *     这段换算一旦在渲染层与主进程各写一份，两侧就会差一点点（少乘倍速、忘了曲线面积、
 *     倒放方向反了），而**没有任何一处会报错**：预览里那段是从 3.0 秒开始的，
 *     导出出来是从 2.5 秒开始的 —— 只有把两段并排看才看得出。
 *   · 所以换算只走 `speed.sourceTimeAt`（全工程唯一的"时间线秒 → 源秒"入口）。
 *
 * ⚠️ 三类**不报错**的错法，本文件的判据逐条钉住（tools/check-region.mjs）：
 *   ① 右残段的 start 忘了按 ripple 前移（看上去只删了区间，其实把后半段丢在原地，
 *      于是留出一个空洞、后面的内容整体错位 span 秒）；
 *   ② 切在有曲线变速的片段上，却把整条曲线原样搬给残段（残段只有原来的一半长，
 *      曲线却还是整段的形状 ⇒ 速度分布完全变了，画面"越切越歪"）；
 *   ③ 倒放片段的残段入点取错了端点（正放取区间**开头**的源位置，倒放要取**结尾**的）。
 *
 * 本文件是 **CommonJS**：主进程 `render.js` 也要用它（只导出区域时按同一口径切片段）。
 * 新增/修改后必须在 packages/desktop/vite.config.mjs 的 `commonjsOptions.include` 里有对应白名单，
 * 否则渲染层 import 到的是空对象 —— 界面上"框了区域点删除，什么都没发生"。
 */

const speed = require('./speed.js')

/** 最短的区域长度（秒）。再短就只是"误触了一下"，不该凭空多出一个区域 */
const MIN_REGION = 0.05

/** 浮点误差；与 trim.js 的 EPSILON 同量级（都是"半帧以下"的意思） */
const EPS = 1e-4

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function round4(value) {
  return Math.round(num(value) * 10000) / 10000
}

/**
 * 规范化一个区域：两端排序 + 夹到非负 + 太短则作废。
 * @returns {{start:number,end:number}|null} 合法区域，或 null（长度不足 / 两端相等）
 */
function normalizeRegion(a, b) {
  const x = Math.max(0, num(a))
  const y = Math.max(0, num(b))
  const start = Math.min(x, y)
  const end = Math.max(x, y)
  if (!(end - start >= MIN_REGION)) return null
  return { start: round4(start), end: round4(end) }
}

/** 区域长度（秒）。非法规格一律 0 —— 调用方不必自己判 null */
function regionSpan(region) {
  if (!region) return 0
  const start = num(region.start)
  const end = num(region.end)
  return end > start ? round4(end - start) : 0
}

/** 某个片段与区域是否有交集（用于面板上的"影响 N 段"与"这里什么都没有"判断） */
function intersects(clip, region) {
  if (!clip || !region) return false
  const start = num(clip.start)
  const end = start + num(clip.duration)
  return end > num(region.start) + EPS && start < num(region.end) - EPS
}

function clipsInRegion(clips, region) {
  const list = Array.isArray(clips) ? clips : []
  return list.filter((clip) => intersects(clip, region))
}

/**
 * 把一条曲线的**子区间**取出来，并把进度重参数化到 [0,1]。
 *
 * 曲线变速的 p 是"片段内时间进度"，残段的 p 必须重新铺满 0→1：
 * 原样搬过去等于"这半段走完整条曲线的形状"，速度分布完全变了；
 * 直接按平均值拉平则丢掉了曲线本身 —— 两种都是"切完之后画面对不上，但不报错"。
 *
 * 采样点 = 两端 + 区间内原有的折点（分段线性插值下，这些点足以精确表达子曲线）。
 *
 * @param {Array<{p:number,v:number}>} points 已规范化的曲线（升序）
 * @param {number} p0 子区间起点进度（0–1）
 * @param {number} p1 子区间终点进度（0–1）
 * @returns {Array<{p:number,v:number}>|null}
 */
function subCurve(points, p0, p1) {
  const list = Array.isArray(points) && points.length ? points : null
  if (!list) return null
  const from = Math.min(1, Math.max(0, num(p0)))
  const to = Math.min(1, Math.max(0, num(p1)))
  if (!(to - from > 1e-6)) return null
  const picked = [from]
  for (const point of list) {
    const p = num(point && point.p)
    if (p > from + 1e-6 && p < to - 1e-6) picked.push(p)
  }
  picked.push(to)
  /* 折点可能很多（上限 40），残段再切一次还可以更多；这里只做"两端保留"的等距抽稀，
     因为曲线本身是分段线性的，抽稀只在极密折点时才损失细节。 */
  const capped = []
  const step = Math.max(1, Math.ceil(picked.length / speed.CURVE_POINTS_MAX))
  for (let i = 0; i < picked.length; i += step) capped.push(picked[i])
  if (capped[capped.length - 1] !== picked[picked.length - 1]) capped.push(picked[picked.length - 1])
  const out = capped
    .map((p) => ({ p: round4((p - from) / (to - from)), v: round4(speed.curveAt(list, p)) }))
    .filter((point) => Number.isFinite(point.p) && Number.isFinite(point.v))
  if (out.length < 2) return null
  /* 两端必须精确落在 0 与 1 上（抽稀后可能差一点点，会让"片段末尾"读到错误速率） */
  out[0].p = 0
  out[out.length - 1].p = 1
  return out
}

/**
 * 把片段裁到 [from, to)（**全局时间线秒**），返回新片段或 null。
 *
 * 这是整个模块的地基：删除区域的左右残段、复制区域的内容、只导出区域的片段表，
 * 全部都是它的调用方 —— 所以它只做一件事：算对**新的源入点**。
 *
 * ⚠️ 入点必须走 `speed.sourceTimeAt`：
 *    · 正放：取区间**开头**那一刻的源位置；
 *    · 倒放：取区间**结尾**那一刻的源位置（倒放时时间线前进 = 源回退，
 *      残段自己的 offset 必须是它覆盖的源范围里**最小**的那个）。
 *    取反了的表现：倒放片段被裁一下之后，画面从另一个位置开始播（甚至整段越界变黑）。
 *
 * @param {object} clip 片段
 * @param {number} from 区间起点（全局秒）
 * @param {number} to 区间终点（全局秒）
 * @param {{shift?:number}} [options] shift：结果片段整体平移多少秒（导出区域用 -region.start）
 */
function sliceClip(clip, from, to, options) {
  if (!clip) return null
  const shift = num(options && options.shift)
  const clipStart = num(clip.start)
  const clipDuration = num(clip.duration)
  if (!(clipDuration > 0)) return null
  const clipEnd = clipStart + clipDuration
  const a = Math.max(num(from), clipStart)
  const b = Math.min(num(to), clipEnd)
  if (!(b - a > EPS)) return null
  const reversed = clip.reverse === true
  const points = speed.readCurve(clip)
  const next = {
    ...clip,
    start: round4(a + shift),
    duration: round4(b - a),
    /* 源入点：正放看开头、倒放看结尾（见上） */
    offset: round4(speed.sourceTimeAt(clip, reversed ? b : a))
  }
  if (points) {
    /* 残段只覆盖原曲线的一段 ⇒ 曲线要跟着重参数化；原样搬 = 速度分布整个变形 */
    const span = clipDuration
    const sub = subCurve(points, (a - clipStart) / span, (b - clipStart) / span)
    if (sub) next.speedCurve = { points: sub }
    else delete next.speedCurve
  }
  return next
}

/**
 * 删除时间区域。
 *
 * ripple（默认）：区间之后的内容整体左移 region 长度 —— 这是剪辑里"删掉这一段"的默认语义，
 * 也是参考客户端时间区域的行为。非 ripple 会留下等长的空洞（"只清除内容、保留时间"）。
 *
 * @param {Array} clips 全量片段
 * @param {{start:number,end:number}} region 区域
 * @param {{ripple?:boolean}} [options]
 * @returns {Array} 新片段表（不改入参）
 */
function removeRegion(clips, region, options) {
  const list = Array.isArray(clips) ? clips : []
  const target = normalizeRegion(region && region.start, region && region.end)
  if (!target) return list.slice()
  const ripple = !options || options.ripple !== false
  const span = target.end - target.start
  const out = []
  for (const clip of list) {
    const clipStart = num(clip.start)
    const clipEnd = clipStart + num(clip.duration)
    /* 完全在区域之后：ripple 时整体左移 */
    if (clipStart >= target.end - EPS) {
      out.push(ripple ? { ...clip, start: round4(clipStart - span) } : clip)
      continue
    }
    /* 完全在区域之前（含正好贴边）：原样 */
    if (clipEnd <= target.start + EPS) {
      out.push(clip)
      continue
    }
    const left = sliceClip(clip, clipStart, target.start)
    if (left) out.push(left)
    const right = sliceClip(clip, target.end, clipEnd)
    if (right) out.push(ripple ? { ...right, start: target.start } : right)
  }
  return out
}

/**
 * 把区域里的内容取出来（复制 / 剪切都用它）。
 *
 * 返回的每一条 `start` 都是**相对于区域起点**的偏移量 —— 粘贴到播放头时直接用，
 * 不需要调用方再记一遍"原来在哪儿"。id 保持原样（粘贴时才换新 id）。
 *
 * @returns {{items:Array, span:number}}
 */
function copyRegion(clips, region) {
  const list = Array.isArray(clips) ? clips : []
  const target = normalizeRegion(region && region.start, region && region.end)
  if (!target) return { items: [], span: 0 }
  const items = []
  for (const clip of list) {
    const piece = sliceClip(clip, target.start, target.end)
    if (piece) items.push({ ...piece, start: round4(piece.start - target.start) })
  }
  /* 按轨道 + 起点排序：粘贴时同轨片段的先后关系与原来一致，
     时间线渲染时的叠放顺序也就一致（否则粘贴出来的画面叠放会翻过来）。 */
  items.sort((a, b) => String(a.track).localeCompare(String(b.track)) || num(a.start) - num(b.start))
  return { items, span: round4(target.end - target.start) }
}

/**
 * 粘贴到 `at` 秒。
 *
 * `makeId` 由调用方给（App 的 nextId）—— 本文件不自己造 id，
 * 因为 id 的格式是 App 的事，两边各造一套会出现"粘贴出来的片段和原片段同 id"
 * （表面上看着好的，实际选中/删除会同时命中两个）。
 */
function pasteRegion(items, at, makeId) {
  const list = Array.isArray(items) ? items : []
  const base = Math.max(0, num(at))
  return list.map((item, index) => {
    const id = typeof makeId === 'function' ? makeId(index) : `${item.id}-p${index}`
    const next = { ...item, id, start: round4(base + num(item.start)) }
    /* 复合/多机位这类容器带 ownerId；它必须跟着新 id 走，否则新片段会挂到旧容器名下 */
    if (item.ownerId) next.ownerId = id
    return next
  })
}

/**
 * 只导出区域：把片段表裁到 [start, end) 并把时间整体归零。
 *
 * 为什么在片段层面裁、而不是给 ffmpeg 加 `-ss/-to`：
 *   · `-ss/-to` 作用在**成片**上，可成片是拼滤镜图算出来的 —— 用输出侧裁，
 *     画中画/转场/音量包络的时间表达式仍然按原时间线算（裁完之后全部错位）；
 *   · 在片段表这一层裁，之后整条链（探测、遮罩、拼图）看见的都是"从 0 开始的一段"，
 *     与用户拖到时间线开头再导出**逐字等价**。
 *
 * @param {Array} clips 全量（或已展开的）片段
 * @param {{start:number,end:number}} region 区域
 * @returns {Array} 时间归零后的片段表
 */
function trimToRegion(clips, region) {
  const list = Array.isArray(clips) ? clips : []
  const target = normalizeRegion(region && region.start, region && region.end)
  if (!target) return list.slice()
  const out = []
  for (const clip of list) {
    const piece = sliceClip(clip, target.start, target.end, { shift: -target.start })
    if (piece) out.push(piece)
  }
  return out
}

module.exports = {
  MIN_REGION,
  normalizeRegion,
  regionSpan,
  intersects,
  clipsInRegion,
  subCurve,
  sliceClip,
  removeRegion,
  copyRegion,
  pasteRegion,
  trimToRegion
}
