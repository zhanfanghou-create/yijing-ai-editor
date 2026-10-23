'use strict'
/**
 * 片段倍速（真源唯一）。
 *
 * 为什么单独一个文件、还不许在渲染层与主进程各写一份：
 * 倍速是「时间线秒 ↔ 源素材秒」之间的**换算因子**，预览（渲染层算 currentTime）
 * 与导出（主进程拼 ffmpeg）用的是同一个因子。两边各写一份，迟早有一边漏掉 ——
 * 症状是"预览原速、成片 2 倍速"这种预览与成片对不上、而两边单独看都没错的缺陷，
 * 静态扫描和构建都拦不住，只有真播一遍才发现。
 *
 * 项目里已有的 `main/looks.js` ↔ `renderer/looks.js` 那对镜像是**被迫**的
 * （一边要产 CSS、一边要产 ffmpeg 滤镜串，确实无法共用）；
 * 而倍速是纯算术，没有任何理由分叉 —— 所以放在 shared/ 下，两边都从这里取。
 *
 * ⚠️ 这个文件是 **CommonJS**，因为主进程（`src/main/render.js`，Electron 33 / Node 20）
 * 是 CJS、且那个 Node 版本还不支持 `require()` 一个 ESM 文件；
 * 渲染层那边由 vite 的 commonjs 插件转（见 packages/desktop/vite.config.mjs 的
 * `commonjsOptions.include` —— 只放行这一个文件，别把整个 src 都转了）。
 * 改这里的模块语法前，先确认两边都还加载得到。
 */

/* 倒放：翻转的是**片段内局部秒**，这里只是把 sourceTimeAt 那一条链拼完整。
   reverse.js 不 require 本文件，所以没有循环依赖。 */
const reverseTable = require('./reverse.js')

/** 倍速的上下限。再慢没有实用价值；再快 atempo 要拆成多段链才做得到 */
const SPEED_MIN = 0.25
const SPEED_MAX = 4

/**
 * 片段倍速。**所有**读 `clip.speed` 的地方都必须走这个函数，不许直接 `clip.speed || 1`。
 *
 * 为什么非要一个函数：speed 缺省、写成 0、写成负数、写成 NaN 这四种情况
 * 在真实数据里都会出现（老草稿没有这个字段、面板传空值、JSON 里写成 null），
 * 而每一种的后果都不一样 —— 0 会让 ffmpeg 的 `setpts=PTS/0` 直接崩、
 * 负数会把画面倒过来放、NaN 会让整条滤镜链变成 `nan`，
 * 而 ffmpeg 报出来的错完全指不到这里。统一夹一次，四种情况都变成"原速"。
 *
 * @param {object} [clip] 片段
 * @returns {number} 夹进 [SPEED_MIN, SPEED_MAX] 的倍速；缺省 1
 */
function clipSpeed(clip) {
  /* 有曲线时**总倍速 = 曲线下面积**（见下面「曲线变速」一节的说明）：
     这样"片段占多长 / 吃多少源 / 修剪上限"这三件事全都自动沿用常速那套式子，
     调用方一句都不用改 —— 否则每个读 clip.speed 的地方都得自己判断有没有曲线。 */
  const points = readCurve(clip)
  if (points) return Math.min(SPEED_MAX, Math.max(SPEED_MIN, curveMean(points)))
  const raw = Number(clip && clip.speed)
  if (!Number.isFinite(raw) || raw <= 0) return 1
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw))
}

/**
 * 这段片段在时间线上播完，要**吃掉源素材**多少秒。
 *
 * `duration` 是时间线上的占位，`sourceSpan` 是源里的消耗，换算因子就是倍速。
 * 修剪的不变式、导出时 trim 的长度、预览的源时间上限，全都用这一个口径。
 *
 * @param {object} clip 片段
 * @returns {number} 秒
 */
function sourceSpan(clip) {
  const duration = Number(clip && clip.duration) || 0
  return duration * clipSpeed(clip)
}

/**
 * 把倍速翻译成 ffmpeg 的 `atempo` 链。
 *
 * 为什么不是直接 `atempo=${speed}`：atempo 单级只接受 0.5–2.0，
 * 给它 4 会直接报 "Value out of range"（报错里完全看不出是倍速的问题）。
 * 超出就拆成多级相乘 —— 4 = 2×2，0.25 = 0.5×0.5。
 *
 * @param {number} speed 倍速
 * @param {(value:number, digits?:number)=>string} [round] 数字格式化（由调用方注入）
 * @returns {string} 形如 `,atempo=2,atempo=2`；原速返回空串
 */
function atempoChain(speed, round = (value) => String(value)) {
  const rate = clipSpeed({ speed })
  if (Math.abs(rate - 1) < 0.001) return ''
  const parts = []
  let rest = rate
  // 每级都保持在 atempo 的合法区间内，剩下的继续拆
  while (rest > 2.0001) {
    parts.push(2)
    rest /= 2
  }
  while (rest < 0.4999) {
    parts.push(0.5)
    rest /= 0.5
  }
  parts.push(rest)
  return `,${parts.map((value) => `atempo=${round(value, 4)}`).join(',')}`
}

/**
 * 视频侧的变速片段：`setpts=(PTS-STARTPTS)/speed`。
 *
 * 原速时返回 `setpts=PTS-STARTPTS`（与没做变速功能之前**逐字相同**）——
 * 这不是为了省字符，而是导出的滤镜串被 E2E 逐字断言过，
 * 无谓的改动会让一堆既有证据失效，掩盖真正的回归。
 *
 * @param {number} speed 倍速
 * @param {(value:number, digits?:number)=>string} [round] 数字格式化
 * @returns {string}
 */
function setptsExpr(speed, round = (value) => String(value)) {
  const rate = clipSpeed({ speed })
  if (Math.abs(rate - 1) < 0.001) return 'setpts=PTS-STARTPTS'
  return `setpts=(PTS-STARTPTS)/${round(rate, 4)}`
}

/* ==================================================================== *
 * 曲线变速
 * -------------------------------------------------------------------- *
 * 常速是「一个数」，曲线是「一条 v(p)」。两者必须共用同一套口径，否则
 * 「片段在时间线上占多长」这件事会有两个答案（时间线一个、成片一个）。
 *
 * 定义（改之前先把这三行读明白）：
 *   · `p` 是**片段内的时间进度** 0→1（不是源进度，也不是秒）；
 *   · `v(p)` 是该时刻的速率，分段线性，点与点之间直接连直线；
 *   · 一条曲线对外的"总倍速" = `∫₀¹ v dp`（曲线下的面积）。
 *     **面积就是平均速度**，所以 `duration × 面积 = 源素材消耗`，
 *     与常速的 `duration × speed` 是同一个式子 —— 这就是为什么常速的那套
 *     不变式（trim.js 里的 offset + duration×speed ≤ sourceDuration）不用改。
 *
 * 于是三个量互相锁定：
 *   源消耗 span = duration × mean
 *   局部时间 p 时刻的源进度 = 截至 p 的累计面积 / 总面积
 *   第 i 段的导出速率 = 该段源消耗 / 该段时间线占位
 *
 * ⚠️ 别把 p 当成源进度去用。按源进度做曲线，剪完左端再拉曲线，
 *    整条曲线的语义会跟着源入点漂移 —— 用户看到的是"曲线自己变形了"。
 */

/** 曲线最多存多少个点。上限存在是为了让导出侧的分段数可控（见 curveSegments） */
const CURVE_POINTS_MAX = 40

/**
 * 曲线预设。
 *
 * `points` 用 `[p, v]` 成对写：比 `{p,v}` 短，且在草稿 JSON 里更省。
 * 数值是"看起来对"的经验值 —— 蒙太奇要快慢交替、子弹时间要中间一段拖住、
 * 英雄时刻是先压住再冲、闪进是开头一冲然后越来越慢。
 */
const CURVE_PRESETS = [
  {
    key: 'montage',
    label: '蒙太奇',
    hint: '快慢交替，适合节奏切换的段落',
    points: [[0, 1], [0.2, 0.5], [0.36, 3], [0.52, 0.5], [0.7, 3], [0.86, 0.6], [1, 1]]
  },
  {
    key: 'bullet',
    label: '子弹时间',
    hint: '两端常速，中间压到 0.3x',
    points: [[0, 1], [0.34, 1], [0.46, 0.3], [0.62, 0.3], [0.74, 1], [1, 1]]
  },
  {
    key: 'hero',
    label: '英雄时刻',
    hint: '先压慢，再突然冲出去',
    points: [[0, 1], [0.3, 0.4], [0.56, 0.4], [0.64, 3], [0.84, 3], [1, 1]]
  },
  {
    key: 'flash',
    label: '闪进',
    hint: '开头一冲，越走越慢',
    points: [[0, 2.5], [0.26, 1.6], [0.66, 0.8], [1, 0.5]]
  },
  { key: 'custom', label: '自定义', hint: '自己拉曲线（在右边曲线上拖点）', points: null }
]

const clampSpeed = (value) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(value)))
const roundTo = (value, digits) => Number(Number(value).toFixed(digits))

/**
 * 把草稿里存的曲线**规范化**成一份可用的点列；不可用就返回 null。
 *
 * 「不可用」在真实数据里有五种样子，每一种都能把下游算成 NaN 或画出空图：
 * 数组为空、只有一个点（连不成线）、点里带 null、p 反序、整段没覆盖 0→1。
 * 统一在这里收口，下游（预览插值 / 导出分段 / 曲线编辑器）就都不用再判。
 *
 * 入参可以是 `[[p,v],...]`、`[{p,v},...]`，或者带 `points` 的对象（草稿里的形状）。
 *
 * @param {*} raw 原始值
 * @returns {Array<{p:number,v:number}>|null}
 */
function normalizeCurve(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.points) ? raw.points : null
  if (!list || list.length < 2) return null
  const parsed = []
  for (const item of list.slice(0, CURVE_POINTS_MAX * 2)) {
    if (item === null || item === undefined) continue
    const rawP = Array.isArray(item) ? item[0] : item && item.p
    const rawV = Array.isArray(item) ? item[1] : item && item.v
    /* ⚠️ 必须在 Number() 之前挡 null：`Number(null)` 是 **0**（不是 NaN），
       一个 `[0.5, null]` 会被静默读成"进度 0.5 处速率 0" → 夹成 0.25x，
       于是草稿里一个坏点变成"这一段中间莫名其妙慢了四分之一"，
       而且它在曲线上是个合法的点，从界面上完全看不出是坏数据。 */
    if (rawP === null || rawV === null || rawP === '' || rawV === '') continue
    const p = Number(rawP)
    const v = Number(rawV)
    // 坏点直接丢：留着会让插值算出 NaN，而 NaN 在 ffmpeg 里是"整条滤镜静默失效"
    if (!Number.isFinite(p) || !Number.isFinite(v)) continue
    parsed.push({ p: Math.min(1, Math.max(0, p)), v: clampSpeed(v) })
  }
  if (parsed.length < 2) return null
  parsed.sort((a, b) => a.p - b.p)
  /* 同一位置的两个点：保留后写的那个。
     拖拽时两个手柄叠在一起会让这一段 Δp=0，插值除零 ⇒ 整段速率变 Infinity。 */
  const dedup = []
  for (const point of parsed) {
    const prev = dedup[dedup.length - 1]
    if (prev && Math.abs(prev.p - point.p) < 0.002) {
      dedup[dedup.length - 1] = point
      continue
    }
    dedup.push(point)
  }
  if (dedup.length < 2) return null
  // 端点补齐：曲线必须覆盖整段。缺首尾时沿最近那个点的值水平延伸（= 常数段）
  if (dedup[0].p > 0.002) dedup.unshift({ p: 0, v: dedup[0].v })
  else dedup[0] = { p: 0, v: dedup[0].v }
  const tail = dedup[dedup.length - 1]
  if (tail.p < 0.998) dedup.push({ p: 1, v: tail.v })
  else dedup[dedup.length - 1] = { p: 1, v: tail.v }
  return dedup.slice(0, CURVE_POINTS_MAX)
}

/** 片段上的曲线（规范化后）。没有/不可用 → null（= 走常速那条路） */
function readCurve(clip) {
  return normalizeCurve(clip && clip.speedCurve)
}

/** 曲线在进度 p 处的速率（分段线性插值）。p 越界一律夹到两端 */
function curveAt(points, p) {
  const list = normalizeCurve(points)
  if (!list) return 1
  const at = Math.min(1, Math.max(0, Number(p) || 0))
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]
    const b = list[i]
    if (at <= b.p) {
      const span = b.p - a.p
      if (!(span > 0)) return b.v
      return a.v + (b.v - a.v) * ((at - a.p) / span)
    }
  }
  return list[list.length - 1].v
}

/**
 * 曲线的"总倍速" = 曲线下面积 = 平均速率。
 *
 * 分段线性 ⇒ 每段是梯形，面积精确（不是采样近似）。这个数被当作 `clipSpeed`
 * 的返回值，于是源消耗、修剪上限、转场结算全都自动沿用常速那套口径。
 */
function curveMean(points) {
  const list = normalizeCurve(points)
  if (!list) return 1
  let area = 0
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]
    const b = list[i]
    area += ((a.v + b.v) / 2) * (b.p - a.p)
  }
  return area > 0 ? area : 1
}

/**
 * 进度 p 为止，已经吃掉源素材的**比例**（0→1）。
 *
 * 用比例而不是秒：曲线只管形状，具体吃多少秒由片段的 span 决定，
 * 这样同一个预设套在 3 秒片段和 30 秒片段上都成立。
 */
function curveSourceFrac(points, p) {
  const list = normalizeCurve(points)
  if (!list) return Math.min(1, Math.max(0, Number(p) || 0))
  const at = Math.min(1, Math.max(0, Number(p) || 0))
  const total = curveMean(list)
  let area = 0
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]
    const b = list[i]
    if (at <= a.p) break
    const right = Math.min(at, b.p)
    if (right <= a.p) continue
    const vRight = a.v + (b.v - a.v) * ((right - a.p) / (b.p - a.p))
    area += ((a.v + vRight) / 2) * (right - a.p)
  }
  return total > 0 ? Math.min(1, area / total) : at
}

/**
 * 片段在时间线某时刻的**瞬时速率**（预览设 `playbackRate` 用）。
 *
 * ⚠️ 它与 `sourceTimeAt` 是两个互补的量：这个管"往后播多快"，那个管"这一刻在源里的哪一秒"。
 *    只给其中一个，预览就会"起点对、越播越歪"或"速度对、起点错"（见 Stage.jsx 的说明）。
 */
function clipRateAt(clip, timelineSeconds) {
  const points = readCurve(clip)
  /* 倒放 ≠ 曲线（见 trim.js 的说明）：倒放时退回"全程匀速"，与导出侧一致 */
  if (!points || (clip && clip.reverse === true)) return clipSpeed(clip)
  const duration = Number(clip && clip.duration) || 0
  if (!(duration > 0)) return clipSpeed(clip)
  const start = Number(clip.start) || 0
  const local = Math.min(Math.max((Number(timelineSeconds) || 0) - start, 0), duration)
  return curveAt(points, local / duration)
}

/**
 * 曲线在时间线某时刻对应的**源素材秒数**（含源入点）。
 *
 * 与 `trim.js` 的 `sourceTimeAt` 同一口径：`offset + span × 已消耗比例`。
 * 单独放在这里是因为它只依赖曲线；`sourceTimeAt` 负责倒放/常速那两路。
 */
/**
 * 时间线秒 → **源素材秒**（全工程唯一入口）。
 *
 * 三件事按固定顺序叠：入点 → 倒放（翻转局部秒）→ 倍速/曲线（乘或累加面积）。
 * 顺序不能换：先乘倍速再翻转，5 秒的片段会被翻到 duration×speed 那么远，
 * 直接越过源素材末尾（"倒放片段一路黑到结束"）。
 *
 * 为什么它住在 shared 而不是渲染层的 trim.js：
 * 「时间区域」的裁剪/复制要在**主进程**里算（导出只导出区间时也要按同一口径切片段），
 * 而主进程 require 不了渲染层的 ESM 模块。两边各写一份的后果是
 * "预览里切在 3 秒、成片里从 2.5 秒开始"——差一点点、谁都不报错。
 *
 * ⚠️ 倒放与曲线**互斥**：倒放优先（见下），导出侧的 `clip.reverse !== true` 判断
 *    必须与这里一字不差，否则预览按曲线、成片按匀速。
 *
 * @param {object} clip 片段
 * @param {number} timelineSeconds 全局时间线上的秒数
 * @returns {number} 该时刻应取的源素材秒数（已夹在片段范围内）
 */
function sourceTimeAt(clip, timelineSeconds) {
  const start = Number(clip && clip.start) || 0
  const duration = Number(clip && clip.duration) || 0
  const offset = Number(clip && clip.offset) || 0
  /* 时长为 0（片段被拖成一根线 / 老草稿缺字段）时返回 0 而不是源入点：
     这是 trim-selftest「duration 为 0 时返回 0」钉住的既有契约，
     时间区域裁剪那边传进来的片段时长为 0 时也走这条 —— 两边同一个答案。 */
  if (!(duration > 0)) return 0
  const t = Number(timelineSeconds)
  if (!Number.isFinite(t)) return offset
  /* 夹到 [0, duration]：片段 head 之前取首帧，tail 之后取末帧 */
  const local = Math.min(Math.max(t - start, 0), duration)
  if (clip && clip.reverse !== true && readCurve(clip)) {
    const curved = curveSourceTime(clip, t)
    return Number.isFinite(curved) ? curved : offset
  }
  return offset + reverseTable.reverseLocal(clip, local) * clipSpeed(clip)
}

function curveSourceTime(clip, timelineSeconds) {
  const points = readCurve(clip)
  if (!points) return null
  const duration = Number(clip && clip.duration) || 0
  if (!(duration > 0)) return null
  const offset = Number(clip && clip.offset) || 0
  const start = Number(clip && clip.start) || 0
  const local = Math.min(Math.max((Number(timelineSeconds) || 0) - start, 0), duration)
  const span = duration * curveMean(points)
  return offset + span * curveSourceFrac(points, local / duration)
}

/**
 * 把曲线切成**导出可用的常速段**：每段 = 从源的哪儿取多少、在时间线上占多久。
 *
 * 为什么要切段：ffmpeg 没有"变速曲线"这个滤镜。`setpts` 能吃时间表达式，
 * 但音频侧的 `atempo` 不认逐帧变化的速率（`atempo` 的入参是常量），
 * 两边要一起成立就只能切段 —— 每段一个 setpts + 一个 atempo，再 concat。
 *
 * ⚠️ 三条不变式（`check-speed-curve` 逐条钉住）：
 *   ① `Σ dur == 时间线占位`（否则片段在成片里会被后面那段盖住或留空）
 *   ② `Σ srcLen == span`（否则吃到的源内容与预览不是同一批）
 *   ③ 每段 `speed = srcLen / dur`（否则 setpts 与段长对不上，画面会跳）
 *
 * 段数上界 `maxSeg` 是**合并**出来的，不是抽样：合并只把"同向的多段"并成一段常数速率，
 * 面积（=源消耗）与时长仍然精确，被量化掉的只是曲线形状的细节。
 * 不合并的话，一个踩点曲线能生成 20+ 条滤镜链，导出时间会成倍上涨。
 *
 * @param {Array} points 曲线点（原始或规范化都行）
 * @param {number} duration 片段在时间线上的占位（秒）
 * @param {number} [maxSeg] 最多几段
 * @returns {Array<{srcStart:number, srcLen:number, dur:number, speed:number}>}
 */
function curveSegments(points, duration, maxSeg = 12) {
  const list = normalizeCurve(points)
  const total = Number(duration)
  if (!list || !(total > 0)) return []
  const mean = curveMean(list)
  const span = total * mean
  const limit = Math.max(2, Math.floor(Number(maxSeg) || 12))
  const target = 1 / limit
  const out = []
  let accP = 0
  let accArea = 0
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]
    const b = list[i]
    const dp = b.p - a.p
    if (!(dp > 0)) continue
    accP += dp
    accArea += ((a.v + b.v) / 2) * dp
    const tail = i === list.length - 1
    // 攒够一段就切；最后一段无论攒到多少都要切，否则尾巴丢掉
    if (accP >= target - 1e-9 || tail) {
      const dur = total * accP
      const srcLen = span * (accArea / mean)
      out.push({ srcLen, dur, speed: dur > 0 ? srcLen / dur : mean })
      accP = 0
      accArea = 0
    }
  }
  let cursor = 0
  for (const seg of out) {
    seg.srcStart = cursor
    seg.speed = clampSpeed(seg.speed)
    cursor += seg.srcLen
  }
  return out
}

/**
 * 把一条曲线应用到片段上：返回补丁（含新的总倍速）。
 *
 * **源跨度守恒**：换曲线不改变"这段片段吃源素材的哪一段"，只改它占多长 ——
 * 与常速那条（trim.js 的 speedPatch）是同一条规矩。
 * 时长由调用方的 speedPatch 按 `duration × 旧速率 / 新速率` 算出来，
 * 这里只给新速率；这样两处不会各算一遍时长然后打起来。
 */
function curvePatch(clip, points) {
  const list = normalizeCurve(points)
  if (!list) return null
  const mean = curveMean(list)
  return {
    speed: roundTo(mean, 4),
    speedCurve: { points: list.map((point) => [roundTo(point.p, 4), roundTo(point.v, 3)]) }
  }
}

/**
 * 按"节拍"生成一条卡点曲线：每个节拍处压慢一小段，节拍之间有加速。
 *
 * `beats` 是**片段内的秒数**（调用方负责把标记/检测结果换算到片段局部）。
 * 慢窗半宽会被相邻节拍夹住 —— 否则密集的节拍会让慢窗叠在一起，
 * 曲线变成一条直线慢速（"卡点"看起来完全没效果）。
 *
 * @param {number} duration 片段占位（秒）
 * @param {number[]} beats 节拍（片段内秒数）
 * @param {{fast?:number, slow?:number, hold?:number, ramp?:number}} [options]
 * @returns {{points:Array, hits:number}|null}
 */
function curveFromBeats(duration, beats, options = {}) {
  const total = Number(duration)
  if (!(total > 0)) return null
  const fast = clampSpeed(Number(options.fast) || 2)
  const slow = clampSpeed(Number(options.slow) || 0.35)
  const hold = Math.max(0.06, Number(options.hold) || 0.3)
  const ramp = Math.max(0.04, Number(options.ramp) || 0.14)
  const list = (Array.isArray(beats) ? beats : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0.02 && item < total - 0.02)
    .sort((a, b) => a - b)
  if (!list.length) return null
  // 只取前 12 个：再多也拉不开，反而是导出段数爆掉
  const picked = list.slice(0, 12)
  const raw = [{ p: 0, v: fast }]
  let guard = 0
  for (const beat of picked) {
    const p = Math.min(0.985, Math.max(0.015, beat / total))
    const halfWidth = Math.min(hold / 2 / total, 0.08)
    const rampSpan = Math.min(ramp / total, 0.05)
    const from = Math.max(guard + 0.004, p - halfWidth - rampSpan)
    const at = Math.max(from + 0.002, p - halfWidth)
    const to = Math.min(0.995, Math.max(at + 0.002, p + halfWidth))
    const after = Math.min(0.998, Math.max(to + 0.002, p + halfWidth + rampSpan))
    raw.push({ p: from, v: fast }, { p: at, v: slow }, { p: to, v: slow }, { p: after, v: fast })
    guard = after
    if (guard > 0.99) break
  }
  raw.push({ p: 1, v: fast })
  const points = normalizeCurve(raw)
  if (!points) return null
  return { points: points.map((point) => [roundTo(point.p, 4), roundTo(point.v, 3)]), hits: picked.length }
}

/**
 * 音频侧变速：**保音高 / 不保音高**两条路。
 *
 * `atempo` 是"只改时长、不改音高"的（变速后声音还是原来那个调），这是默认行为；
 * 反过来「不保音高」= 磁带快放的效果（快了就尖、慢了就沉），
 * ffmpeg 里靠 `asetrate` 改采样率实现 —— 它同时改音高和速度，正好是我们要的。
 *
 * ⚠️ `asetrate` 之后必须 `aresample` 回到 48000，否则下游 concat/xfade
 *    会因为"两段采样率不一致"直接失败，错误信息只说参数不匹配。
 * ⚠️ 先 `aformat=sample_rates=48000` 把输入固定成 48k 再乘系数：
 *    `asetrate` 的入参是绝对值，素材是 44.1k 时直接写 48000×rate 会连音高都不对。
 *
 * @param {number} speed 倍速
 * @param {boolean} keepPitch 是否保音高（默认 true）
 * @param {(value:number, digits?:number)=>string} [round]
 * @returns {string} 形如 `,asetrate=72000,aresample=48000`；无需处理返回空串
 */
function pitchChain(speed, keepPitch, round = (value) => String(value)) {
  if (keepPitch !== false) return atempoChain(speed, round)
  const rate = clipSpeed({ speed })
  if (Math.abs(rate - 1) < 0.001) return ''
  return `,aformat=sample_rates=48000,asetrate=${round(48000 * rate, 2)},aresample=48000`
}

/**
 * 主动变调（半音）。**时长不变**，只改音高 —— 靠"改采样率 + 用 atempo 抵消时长"实现。
 *
 * `asetrate` 把音高抬 factor 倍，同时把时长压到 1/factor；再用 `atempo=1/factor`
 * 把时长拉回来（1/factor 落在 0.5–2.0 之间，本项目限的半音范围 ±6 不会越界）。
 *
 * ⚠️ 这个效果**预览听不到**（浏览器没有变调播放，`preservesPitch` 只能开关"是否保音高"，
 *    不能指定音高），所以面板上如实标「导出时应用」。不标的话就是"看着有、听不到"。
 *
 * @param {number} semitones 半音，-6..6
 * @param {(value:number, digits?:number)=>string} [round]
 * @returns {string} 空串 = 不变调
 */
function semitoneChain(semitones, round = (value) => String(value)) {
  const raw = Number(semitones)
  if (!Number.isFinite(raw) || Math.abs(raw) < 0.01) return ''
  const amount = Math.min(12, Math.max(-12, raw))
  const factor = Math.pow(2, amount / 12)
  return `,asetrate=${round(48000 * factor, 2)},aresample=48000,atempo=${round(1 / factor, 6)}`
}

module.exports = {
  SPEED_MIN,
  SPEED_MAX,
  clipSpeed,
  sourceSpan,
  atempoChain,
  setptsExpr,
  CURVE_POINTS_MAX,
  CURVE_PRESETS,
  normalizeCurve,
  readCurve,
  curveAt,
  curveMean,
  curveSourceFrac,
  clipRateAt,
  curveSourceTime,
  sourceTimeAt,
  curveSegments,
  curvePatch,
  curveFromBeats,
  pitchChain,
  semitoneChain
}
