'use strict'
/**
 * 片段「调节」与「美颜」参数（真源唯一）。
 *
 * 为什么单独一个文件、且不许渲染层与主进程各写一份：
 *   「亮度 20」这个数在**预览**里必须表现为画面真的变亮，在**导出**里必须表现为
 *   ffmpeg 滤镜串里真的多了一级 —— 两边各写一份迟早有一边漏掉，症状是
 *   「滑杆能拖、预览也亮、成片一点没变」（或反过来），
 *   而构建不报错、界面看不出、静态扫描也拦不住。
 *
 * 与 shared/speed.js 同一形制：**CommonJS**，主进程 `require`、渲染层 `import`
 *   （渲染层那侧由 vite 的 commonjs 插件转 —— 见 packages/desktop/vite.config.mjs
 *    的 `commonjsOptions.include`，**新增 shared 模块必须同时加进那个白名单**，
 *    否则渲染层 import 到的是一个没有 default 的空对象，症状是"面板永远显示 0"）。
 *
 * 两边的换算口径（顺序也必须一致，否则同一组参数两侧画面不同）：
 *   1. 磨皮      → CSS `blur()`        / ffmpeg `smartblur`
 *   2. 各通道增益 → CSS `feColorMatrix`/ ffmpeg `colorchannelmixer`（对角增益，逐字对应）
 *   3. 对比度    → CSS `contrast()`    / ffmpeg `eq=contrast`
 *   4. 饱和度    → CSS `saturate()`    / ffmpeg `eq=saturation`
 * 「亮度 / 美白 / 色温 / 色调」都折进第 2 步的通道增益里 —— 这样 CSS 与 ffmpeg
 * 用的就是同一个乘数，而不是"一边加、一边乘"这种永远对不上的近似。
 */

/** 调节：全部以 0 为中性，±100 为界（与参考客户端的滑杆范围一致） */
const ADJUST_PARAMS = [
  { key: 'bright', label: '亮度', min: -100, max: 100, def: 0 },
  { key: 'contrast', label: '对比度', min: -100, max: 100, def: 0 },
  { key: 'saturate', label: '饱和度', min: -100, max: 100, def: 0 },
  { key: 'temp', label: '色温', min: -100, max: 100, def: 0 },
  { key: 'tint', label: '色调', min: -100, max: 100, def: 0 }
]

/** 美颜：0 = 不处理 */
const BEAUTY_PARAMS = [
  { key: 'smooth', label: '磨皮', min: 0, max: 100, def: 0 },
  { key: 'whiten', label: '美白', min: 0, max: 100, def: 0 }
]

/** 磨皮满档时，模糊半径占**画面宽度**的比例。两侧都按它换算，所以预览与成片的
 *  模糊量是同一个比例（预览宽度 1280 / 成片 1920 会各自算出各自的像素数）。
 *  ⚠️ 预览用的是 `cqw`（1cqw = 容器宽的 **1%**）—— 把比例写进 CSS 时必须 ×100，
 *     写成 `blur(0.005cqw)` 得到的是 0.005% 宽度（在 650px 的预览里就是 0.03px，
 *     等于没效果），而成片那边按 0.005×1920=9.6px 算，两边差了三百倍。 */
const SMOOTH_BLUR_RATIO = 0.005

/** 磨皮会把边缘糊出半透明，必须把画面放大一点点把毛边推出画布外。
 *  这个放大系数两侧都用同一个值 —— 否则"预览看不出边、成片一圈黑"。 */
const SMOOTH_COVER_SCALE = 1.02

/** 位置（相对画布的百分比）与旋转（角度）的可调范围。
 *  ⚠️ 位置上限 50 不是随手定的：导出侧是用「垫到 2 倍画布再按偏移裁回来」实现平移的，
 *     可用的余量正好是 ±半张画布。改大这里而没改导出，就会"预览挪得动、成片挪不动"。 */
const POS_LIMIT = 50
const ROTATE_LIMIT = 180

/** 亮度 / 美白 满档时的通道增益幅度 */
const BRIGHT_GAIN = 0.6
const WHITEN_GAIN = 0.25
/** 色温 / 色调 满档时的通道增减幅度 */
const TEMP_GAIN = 0.3
const TINT_GAIN = 0.25

/** 对比度满档时的倍率幅度（1 ± 0.6） */
const CONTRAST_GAIN = 0.6

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
/** 保留 4 位小数：ffmpeg 的滤镜串里出现 0.30000000000000004 会让对拍断言变脆 */
const round4 = (value) => Number(Number(value).toFixed(4))

/** 读一组调节参数：缺省 / 脏数据一律回落中性值（0），不抛错、不产生 NaN */
function readAdjust(src) {
  const out = {}
  for (const item of ADJUST_PARAMS) {
    const raw = src && typeof src === 'object' ? src[item.key] : undefined
    out[item.key] = clamp(num(raw, item.def), item.min, item.max)
  }
  return out
}

/** 读一组美颜参数：同上 */
function readBeauty(src) {
  const out = {}
  for (const item of BEAUTY_PARAMS) {
    const raw = src && typeof src === 'object' ? src[item.key] : undefined
    out[item.key] = clamp(num(raw, item.def), item.min, item.max)
  }
  return out
}

const isNeutralAdjust = (adjust) => ADJUST_PARAMS.every((item) => Math.abs(adjust[item.key]) < 0.01)
const isNeutralBeauty = (beauty) => BEAUTY_PARAMS.every((item) => Math.abs(beauty[item.key]) < 0.01)

/**
 * 逐通道增益 —— 亮度 / 美白 / 色温 / 色调**全部**折进这三个数。
 *
 * 折叠顺序与用户的直觉一致：
 *   亮度 = 三个通道一起乘；美白 = 再乘一点并且轻微提纯（把红蓝抬得比绿多一点，
 *   观感上是"透白"而不是"发灰"）；色温 = 红升蓝降（暖）或反过来（冷）；
 *   色调 = 绿降（品红）或绿升（青）。
 */
function channelGains(adjust, beauty) {
  const a = readAdjust(adjust)
  const b = readBeauty(beauty)

  let gain = 1 + (a.bright / 100) * BRIGHT_GAIN
  gain *= 1 + (b.whiten / 100) * WHITEN_GAIN

  const temp = (a.temp / 100) * TEMP_GAIN
  const tint = (a.tint / 100) * TINT_GAIN

  const r = clamp(gain * (1 + temp) * (1 + tint * 0.35), 0, 4)
  const g = clamp(gain * (1 - tint), 0, 4)
  const bl = clamp(gain * (1 - temp) * (1 + tint * 0.35), 0, 4)
  return { r: round4(r), g: round4(g), b: round4(bl) }
}

/** 对比度倍率（1 = 不变），两侧同一个数 */
function contrastFactor(adjust) {
  const a = readAdjust(adjust)
  return round4(clamp(1 + (a.contrast / 100) * CONTRAST_GAIN, 0, 4))
}

/** 饱和度倍率（1 = 不变），两侧同一个数 */
function saturationFactor(adjust) {
  const a = readAdjust(adjust)
  return round4(clamp(1 + a.saturate / 100, 0, 3))
}

/** 磨皮 → 画面宽度的一个比例（0 表示不磨） */
const smoothRatio = (beauty) => round4(clamp((beauty.smooth / 100) * SMOOTH_BLUR_RATIO, 0, 0.05))

/** 磨皮时的保边放大系数（1 = 不放大） */
const coverScale = (beauty) => (readBeauty(beauty).smooth > 0.01 ? SMOOTH_COVER_SCALE : 1)

/**
 * 片段的 transform / opacity（**预览**用；导出侧 render.js 的 poseFilter/zoom 是它的镜像）。
 *
 * 为什么放进 shared 而不是留在 Stage.jsx 里：
 *   「位置 X = 30」这件事在三处必须给出同一个数 —— 预览的 translateX、
 *   导出的 crop 偏移、以及闸门的判据。留在组件里就只能靠肉眼看代码对齐，
 *   而 transform 这类东西写错了界面照样"能拖、看着也动了"（只是动多动少不对）。
 *
 * 口径：
 *   · posX / posY —— 相对**画布**的百分比（导出换算成垫 2 倍画布后的 crop 偏移）；
 *   · rotate      —— 角度（导出 rotate 滤镜）；
 *   · scale       —— 百分比（导出 scale=iw*k）；
 *   · 磨皮时再乘 SMOOTH_COVER_SCALE（导出乘的是同一个系数）。
 *
 * @returns {{transform?:string, opacity?:string}|null} 全默认时返回 null，
 *   调用方据此给 `undefined`，**不在 DOM 上留一个空 style 属性**
 *   （E2E 按 `style` 判"有没有调过"，空属性会误判）。
 */
function poseStyle(src) {
  const s = src || {}
  const scale = num(s.scale, 100)
  const opacity = num(s.opacity, 100)
  const posX = clamp(num(s.posX, 0), -POS_LIMIT, POS_LIMIT)
  const posY = clamp(num(s.posY, 0), -POS_LIMIT, POS_LIMIT)
  const rotate = clamp(num(s.rotate, 0), -ROTATE_LIMIT, ROTATE_LIMIT)
  const k = (scale / 100) * coverScale(s.beauty)

  const parts = []
  if (Math.abs(posX) > 0.01) parts.push(`translateX(${posX}%)`)
  if (Math.abs(posY) > 0.01) parts.push(`translateY(${posY}%)`)
  if (Math.abs(rotate) > 0.01) parts.push(`rotate(${rotate}deg)`)
  if (Math.abs(k - 1) > 0.001) parts.push(`scale(${Number(k.toFixed(4))})`)

  const out = {}
  if (parts.length) out.transform = parts.join(' ')
  if (opacity < 99.995) out.opacity = String(Math.max(0, Math.min(1, opacity / 100)))
  return Object.keys(out).length ? out : null
}

/**
 * 5×4 颜色矩阵（SVG feColorMatrix 的 `values`）—— 只放三个通道增益。
 * 中性时返回 ''，调用方据此决定**不挂** `url(#...)`，
 * 免得白白多一层滤镜（也免得 SVG 定义缺失时把整串 filter 带塌）。
 */
function gradeMatrix(adjust, beauty) {
  const a = readAdjust(adjust)
  const b = readBeauty(beauty)
  if (isNeutralAdjust(a) && isNeutralBeauty(b)) return ''
  const g = channelGains(a, b)
  return [g.r, 0, 0, 0, 0, 0, g.g, 0, 0, 0, 0, 0, g.b, 0, 0, 0, 0, 0, 1, 0].join(' ')
}

/** 通道增益是否中性（全 1）—— ffmpeg 侧据此省掉一级 colorchannelmixer */
const isNeutralGain = (gains) =>
  Math.abs(gains.r - 1) < 1e-4 && Math.abs(gains.g - 1) < 1e-4 && Math.abs(gains.b - 1) < 1e-4

/**
 * 渲染层：调节/美颜 → CSS filter 声明（**不含** `url(#...)`，那一段由组件按层拼）。
 *
 * @returns {string} 形如 `contrast(1.12) saturate(1.2)`；无效果时返回 ''
 */
function cssFilterOps(adjust, beauty) {
  const a = readAdjust(adjust)
  const b = readBeauty(beauty)
  const parts = []
  /* ⚠️ ×100：`smoothRatio` 是"占画面宽度的比例"（0.005 = 0.5%），
     而 1cqw = 容器宽的 1%，所以写进 CSS 要乘 100。少乘这一下就是
     "预览里磨皮等于没开、成片里磨得挺明显"（差了整整 100 倍）。 */
  if (b.smooth > 0.01) parts.push(`blur(${(smoothRatio(b) * 100).toFixed(4)}cqw)`)
  const c = contrastFactor(a)
  if (Math.abs(c - 1) > 1e-4) parts.push(`contrast(${c})`)
  const s = saturationFactor(a)
  if (Math.abs(s - 1) > 1e-4) parts.push(`saturate(${s})`)
  return parts.join(' ')
}

/**
 * 主进程：调节/美颜 → ffmpeg 滤镜串（**不含**前导逗号）。
 *
 * ⚠️ 顺序与 cssFilterOps 逐级对应：磨皮 → 通道增益 → 对比度/饱和度。
 *    改这里的顺序必须同步改那边，否则同一组参数在预览与成片里是两种画面。
 *
 * @param {function} round 取整函数（主进程传自己的 round，避免多处各写一份）
 * @param {number} width 输出画布宽度 —— 磨皮半径按它换算成像素
 * @returns {string} 形如 `smartblur=luma_radius=3:luma_strength=0.6,colorchannelmixer=...`；无效果时返回 ''
 */
function ffmpegFilterFor(adjust, beauty, round = round4, width = 1920) {
  const a = readAdjust(adjust)
  const b = readBeauty(beauty)
  if (isNeutralAdjust(a) && isNeutralBeauty(b)) return ''
  const parts = []

  const ratio = smoothRatio(b)
  if (ratio > 0) {
    /* luma_radius 的单位是像素，成片宽度由调用方决定 —— 这里按**画布宽度**换算，
       与预览的 cqw（画面宽度的百分之几）是同一个比例。 */
    const w = Number(width) > 0 ? Number(width) : 1920
    const radius = Math.max(0.6, ratio * w)
    parts.push(`smartblur=luma_radius=${round(radius, 3)}:luma_strength=0.7:chroma_radius=0:chroma_strength=0`)
  }

  const gains = channelGains(a, b)
  if (!isNeutralGain(gains)) {
    parts.push(`colorchannelmixer=rr=${round(gains.r, 4)}:gg=${round(gains.g, 4)}:bb=${round(gains.b, 4)}`)
  }

  const c = contrastFactor(a)
  const s = saturationFactor(a)
  const eqParts = []
  if (Math.abs(c - 1) > 1e-4) eqParts.push(`contrast=${round(c, 4)}`)
  if (Math.abs(s - 1) > 1e-4) eqParts.push(`saturation=${round(s, 4)}`)
  if (eqParts.length) parts.push(`eq=${eqParts.join(':')}`)

  return parts.join(',')
}

module.exports = {
  ADJUST_PARAMS,
  BEAUTY_PARAMS,
  POS_LIMIT,
  ROTATE_LIMIT,
  SMOOTH_COVER_SCALE,
  readAdjust,
  readBeauty,
  isNeutralAdjust,
  isNeutralBeauty,
  channelGains,
  contrastFactor,
  saturationFactor,
  smoothRatio,
  coverScale,
  poseStyle,
  gradeMatrix,
  cssFilterOps,
  ffmpegFilterFor
}
