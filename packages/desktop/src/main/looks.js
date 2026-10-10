/**
 * 滤镜与转场 —— 主进程侧（导出用）。
 *
 * 数据来自 ../shared/looks.json（唯一真源），本文件把它翻译成 **ffmpeg 滤镜串**，
 * 并复刻渲染层的转场时长结算（ripple），供 buildPlan 构造 filter_complex。
 *
 * ⚠️ 与 src/renderer/looks.js 是一对镜像，两边**必须同序、同值**：
 *   渲染层走 CSS filter 做预览，这里走 ffmpeg 做导出，任何一侧单改都会让
 *   「预览看到的」和「导出得到的」不是一回事 —— 而这种缺陷不会抛错、不会让构建失败，
 *   只有成片出来才发现。tools/looks-selftest.mjs 用同一组夹具双向对拍把它钉住。
 *
 * 参数映射口径（与 CSS 侧一一对应）：
 *   · brightness → colorchannelmixer 的对角线（**乘性**增益，与 CSS brightness 同义；
 *     ffmpeg eq 的 brightness 是加性的，直接拿来用会导致两端亮度对不上）；
 *   · sepia      → 与 CSS 完全相同的标准棕调矩阵，与原图做线性插值；
 *   · contrast / saturate（含去色）→ eq=contrast=..:saturation=..；
 *   · hue        → hue=h=..（与 CSS hue-rotate 近似，见 looks.json 的说明）。
 *   brightness 与 sepia 都是线性矩阵，先乘再交给 colorchannelmixer，只占一环。
 */
const looks = require('../shared/looks.json')

const FILTERS = looks.filters
const TRANSITIONS = looks.transitions
const TRANSITION_LIMITS = looks.limits

const FILTER_BY_KEY = Object.fromEntries(FILTERS.map((item) => [item.key, item]))
const TRANSITION_BY_KEY = Object.fromEntries(TRANSITIONS.map((item) => [item.key, item]))

const LOOK_EPSILON = 1e-3

/** CSS 标准棕调矩阵（与 CSS `sepia()` 的规范定义一致） */
const SEPIA = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131]
]

const filterDef = (key) => FILTER_BY_KEY[key] || FILTER_BY_KEY.none
const transitionDef = (key) => TRANSITION_BY_KEY[key] || TRANSITION_BY_KEY.none

/** 与渲染层 scaleFilterParams 逐字对应（含同样的 4 位取整，保证两端用同一组数） */
function scaleFilterParams(params, intensity = 1) {
  const t = Math.min(1, Math.max(0, Number(intensity)))
  const lerp = (value, base) => Number((base + (Number(value) - base) * t).toFixed(4))
  return {
    brightness: lerp(params.brightness, 1),
    contrast: lerp(params.contrast, 1),
    saturate: lerp(params.saturate, 1),
    grayscale: lerp(params.grayscale, 0),
    sepia: lerp(params.sepia, 0),
    hue: lerp(params.hue, 0)
  }
}

/** 4 位以内的小数不要写成 "1.00000"，日志和报错里可读性差很多 */
const fmt = (value) => String(Number(Number(value).toFixed(5)))

/**
 * 参数 → ffmpeg 滤镜链（不含首尾逗号）。
 * 顺序与渲染层 cssFilterFor 完全一致：matrix(brightness+sepia) → eq(contrast+saturation) → hue。
 * @returns {string} 空串表示该滤镜等同于原片
 */
function ffmpegFilterFor(key, intensity = 1) {
  const def = filterDef(key)
  if (def.key === 'none') return ''
  const p = scaleFilterParams(def.params, intensity)
  const chain = []

  const needMatrix = Math.abs(p.brightness - 1) > 1e-4 || p.sepia > 1e-4
  if (needMatrix) {
    // (brightness 对角阵) × (sepia 与原图的插值矩阵)
    const mix = SEPIA.map((row, r) =>
      row.map((value, c) => {
        const identity = r === c ? 1 : 0
        const sepia = identity + (value - identity) * p.sepia
        return fmt(p.brightness * sepia)
      })
    )
    chain.push(
      `colorchannelmixer=rr=${mix[0][0]}:rg=${mix[0][1]}:rb=${mix[0][2]}` +
        `:gr=${mix[1][0]}:gg=${mix[1][1]}:gb=${mix[1][2]}` +
        `:br=${mix[2][0]}:bg=${mix[2][1]}:bb=${mix[2][2]}`
    )
  }

  const sat = Number((p.saturate * (1 - p.grayscale)).toFixed(4))
  if (Math.abs(p.contrast - 1) > 1e-4 || Math.abs(sat - 1) > 1e-4) {
    chain.push(`eq=contrast=${fmt(p.contrast)}:saturation=${fmt(sat)}`)
  }

  if (Math.abs(p.hue) > 1e-4) chain.push(`hue=h=${fmt(p.hue)}`)
  return chain.join(',')
}

/**
 * 画面特效（clip.frameFx）→ ffmpeg 滤镜链。
 *
 * 为什么必须存在：预览里 7 种画面特效走 CSS 动画（.canvas-frame 的 transform /
 * .canvas-fx 叠加层），但导出是 ffmpeg 重新编码 —— 这边不接线的话，用户看到
 * "预览在抖、导出来不抖"，这是"状态变了、成片一个像素没变"的导出版。
 *
 * 近似口径（预览是 CSS 动画，ffmpeg 无法逐帧等价，取方向一致的近似）：
 *   fx-shake      crop 原点随 t 抖动（crop 的 x/y 支持含 t 的表达式，逐帧求值）
 *   fx-pulse      先放大 8% 再中心裁回，裁剪原点随 t 缓慢漂移 ≈ 呼吸缩放
 *   fx-flash      hue 的亮度参数支持含 t 表达式 → 周期性短暂增亮（≈1.5s 一次闪）
 *   fx-glitch     rgbashift 红/蓝通道反向错位（色差感，静态幅度）
 *   fx-scan       drawgrid 每 3px 一条半透明横线 ≈ 扫描线
 *   fx-lightleak  暖色偏移 + 轻微提亮（方向近似，无扫过动画）
 *   fx-vignette   ffmpeg 原生 vignette
 *
 * ⚠️ 表达式里的逗号写在单引号内，不要再加 `\,` —— 引号内的反斜杠会原样进入
 *    表达式，ffmpeg 解析函数参数时直接报"无法解析"，表现为导出任务失败。
 * @returns {string} 空串表示无特效
 */
function frameFxFilterFor(key, { width = 1920, height = 1080 } = {}) {
  switch (key) {
    case 'fx-shake':
      return "crop=w=iw-16:h=ih-16:x='8+6*sin(28*t)':y='8+6*cos(31*t)'"
    case 'fx-pulse': {
      const w = Math.round(width * 1.08)
      const h = Math.round(height * 1.08)
      return (
        `scale=${w}:${h},` +
        `crop=w=${width}:h=${height}` +
        `:x='(in_w-out_w)/2+10*sin(2*PI*t/1.2)'` +
        `:y='(in_h-out_h)/2+10*cos(2*PI*t/1.2)'`
      )
    }
    case 'fx-flash':
      return "hue=b='0.25*pow(max(0,sin(2*PI*t/1.5)),6)'"
    case 'fx-glitch':
      return 'rgbashift=rh=6:bh=-6'
    case 'fx-scan':
      return 'drawgrid=w=iw:h=3:t=1:c=black@0.35'
    case 'fx-lightleak':
      return 'colorbalance=rs=0.12:gs=0.05:bs=-0.12,eq=contrast=0.97:brightness=0.05'
    case 'fx-vignette':
      return 'vignette=PI/4.5'
    default:
      return ''
  }
}

/** 时长夹取：与渲染层 clampTransitionDuration 同一套规则 */
function clampTransitionDuration(seconds, neighbors = []) {
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
 * 转场结算 —— 与渲染层 resolveTrack 同一套语义（详见那边的注释）。
 * 这里额外把每段自己的滤镜串也一起带上，buildPlan 一次就能拿到全部信息。
 */
function resolveTrack(clips) {
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
      filter: ffmpegFilterFor(clip.filter, clip.filterIntensity ?? 1),
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

module.exports = {
  FILTERS,
  TRANSITIONS,
  TRANSITION_LIMITS,
  LOOK_EPSILON,
  filterDef,
  transitionDef,
  scaleFilterParams,
  ffmpegFilterFor,
  frameFxFilterFor,
  clampTransitionDuration,
  resolveTrack
}
