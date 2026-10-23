'use strict'
/**
 * 节拍检测（"变速卡点"的耳朵）。
 *
 * 输入是主进程用 ffmpeg 抽出来的**振幅包络**（`media:peaks`，每个桶一个 0–1 的数），
 * 输出是一串"重音发生的秒数"。整个文件是纯函数：不碰 DOM、不碰文件、不碰 IPC，
 * 所以可以用一条命令跑几百组夹具（见 tools/check-speed-curve.mjs）。
 *
 * 为什么不用音高/频段分析：包络已经够用 —— 卡点要的是"鼓点落在哪"，不是"什么乐器"。
 * 用频谱通量（spectral flux）当然更准，但那要求拿到 FFT，代价是引入一个 DSP 依赖，
 * 而这里的精度要求是"人耳听着对得上"，包络差分完全够。
 *
 * 算法（三步，全在时间域）：
 *   ① 平滑：三点滑动平均。ffmpeg 的包络桶本身有毛刺，不平滑的话"上升沿"到处都是；
 *   ② 通量：`max(0, e[i] - e[i-1])`，只保留**变响**的时刻（变轻不是鼓点）；
 *   ③ 阈值：局部均值 × 倍率，并加一条全局下限。只用全局阈值时，
 *      安静的段落会被漏掉、整首同响的会被判成一串连击。
 *
 * ⚠️ 分辨率 = 桶的宽度（`secondsPerBucket`）。桶太粗（比如整首 480 个桶），
 *    相邻鼓点会挤进同一个桶，检测出来就"少了一半" —— 所以取包络时
 *    桶数应给到 ~60 个/秒（见 renderer 侧的 BUCKETS_PER_SECOND）。
 */

/** 桶的平均值；空数组返回 0（不是 NaN —— NaN 会让后面所有比较恒假，静默返回 0 个节拍） */
function average(list) {
  if (!Array.isArray(list) || !list.length) return 0
  let sum = 0
  for (const value of list) sum += Number(value) || 0
  return sum / list.length
}

/**
 * 三点滑动平均（两端按可用长度算，不补零 —— 补零会在首尾造出假的下沉）。
 *
 * @param {number[]} list
 * @returns {number[]}
 */
function smooth(list) {
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const lo = Math.max(0, i - 1)
    const hi = Math.min(list.length - 1, i + 1)
    out.push(average(list.slice(lo, hi + 1)))
  }
  return out
}

/**
 * 检测节拍。
 *
 * @param {number[]} peaks 振幅包络（每个桶 0–1，等间隔）
 * @param {number} secondsPerBucket 每个桶代表多少秒
 * @param {{window?:number, ratio?:number, floor?:number, minGap?:number, sensitivity?:number}} [options]
 *        window：局部阈值的窗口（秒，默认 0.6）；ratio：局部均值倍率（默认 1.6）；
 *        floor：全局均值倍率（默认 1.2，防止在静音段里"检测"出一堆噪声）；
 *        minGap：两个节拍的最小间隔（秒，默认 0.14 = 每分钟 428 拍，足够快）；
 *        sensitivity：0–100 的界面滑杆，越大越灵敏（会同时放宽 ratio 与 floor）。
 * @returns {number[]} 节拍时刻（秒，升序）；数据不可用时返回空数组
 */
function detectBeats(peaks, secondsPerBucket, options = {}) {
  const list = (Array.isArray(peaks) ? peaks : []).map((item) => Math.abs(Number(item) || 0))
  const spb = Number(secondsPerBucket)
  if (list.length < 8 || !(spb > 0)) return []

  const smoothList = smooth(list)
  const flux = smoothList.map((value, index) => (index === 0 ? 0 : Math.max(0, value - smoothList[index - 1])))

  const sensitivity = Math.min(100, Math.max(0, Number(options.sensitivity) || 50))
  /* 灵敏度只调**两档阈值**，不碰算法结构：
     0 → 倍率 ×2.4 / 全局 ×1.8（只挑最响的重音）
     100 → ×1.05 / ×0.9（连轻微的打击都算） */
  const ratio = Number(options.ratio) || 2.4 - (sensitivity / 100) * 1.35
  const floor = Number(options.floor) || 1.8 - (sensitivity / 100) * 0.9
  const windowSec = Number(options.window) || 0.6
  const win = Math.max(3, Math.round(windowSec / spb))
  const minGap = Math.max(1, Math.round((Number(options.minGap) || 0.14) / spb))
  const globalMean = average(flux)

  const hits = []
  for (let i = 1; i < flux.length - 1; i += 1) {
    const value = flux[i]
    if (!(value > 0)) continue
    // 局部极大：只认峰顶，否则一个上升沿会被算成好几个节拍
    if (value < flux[i - 1] || value < flux[i + 1]) continue
    const lo = Math.max(0, i - win)
    const hi = Math.min(flux.length - 1, i + win)
    const localMean = average(flux.slice(lo, hi + 1))
    const threshold = Math.max(localMean * ratio, globalMean * floor, 1e-5)
    if (value < threshold) continue
    const prev = hits[hits.length - 1]
    if (prev !== undefined && i - prev < minGap) {
      /* 太近：保留更响的那个。直接丢弃会让"密集段落里第一个鼓点之后的全都丢"，
         表现为卡点曲线整体偏前半拍。 */
      if (value > flux[prev]) hits[hits.length - 1] = i
      continue
    }
    hits.push(i)
  }
  return hits.map((index) => Number((index * spb).toFixed(3)))
}

/**
 * 取落在 [from, to] 区间内的节拍，并**平移到区间起点**（返回片段内秒数）。
 *
 * 边界各让 0.02 秒：正好落在片段首尾的节拍放不进去（开头的慢窗会伸到片段外，
 * 导出分段时会取到负的源时间）。
 *
 * @param {number[]} beats 绝对秒数
 * @param {number} from 区间起点（秒）
 * @param {number} to 区间终点（秒）
 * @returns {number[]} 相对 from 的秒数
 */
function beatsInRange(beats, from, to) {
  const start = Number(from) || 0
  const end = Number(to) || 0
  if (!(end > start)) return []
  return (Array.isArray(beats) ? beats : [])
    .map((item) => Number(item) - start)
    .filter((item) => Number.isFinite(item) && item > 0.02 && item < end - start - 0.02)
}

module.exports = { detectBeats, beatsInRange, average, smooth }
