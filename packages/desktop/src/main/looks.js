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
 *   · contrast / saturate（含去色）→ lutrgb 逐通道仿射 / colorchannelmixer 矩阵
 *     （**不用** eq=contrast:saturation —— 那条在 YUV 上算，与 CSS 的 sRGB 式子
 *      在强对比/高饱和档位能差 12~18 ΔE，实测见 saturateMatrix 注释）；
 *   · hue        → colorchannelmixer 套 **CSS 那条 hueRotate 矩阵**（见 HUE_MATRIX）。
 *   brightness 与 sepia 都是线性矩阵，先乘再交给 colorchannelmixer，只占一环。
 */
const looks = require('../shared/looks.json')
/* 画面特效的参数轴（与预览 CSS 变量的真源同一份） */
const { fxFamily, fxParamsOf } = require('../shared/fxParams.js')

/* 转场的表达式不再在规划阶段拼（`geo` 原样带出去，由 render.js 在拼滤波器时
   用 shared/transitionMask.js 的 xfadeArgs 现算）—— 那里才知道这一段的 pixFmt，
   而闪黑/闪白要不要求 RGB 平面取决于它。 */
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

/**
 * CSS `hue-rotate(deg)` 的矩阵 —— 就是 SVG feColorMatrix type="hueRotate" 的规范式。
 *
 * ⚠️ 这里**不能用 ffmpeg 的 `hue=h=deg`**：那条走 YUV 平面旋转色度，
 *    与 CSS 的 sRGB 线性矩阵不是一回事。实测（tools/gen-material-thumbs 的底片，
 *    32×32 探针，Lab 平均差）：
 *       6° → 2.32   18° → 5.30   26° → 7.43   46° → 12.48
 *    也就是说角度越大，"预览一个色、成片另一个色"越明显，而这种缺陷不抛错、不报警。
 *    换成 colorchannelmixer 直接套下面这个矩阵后，同一组角度稳定在 1.1~1.2 ΔE
 *    （残差来自 8bit 取整与 Python 侧的截断，不是公式差异）。
 *
 * 三处必须同式：预览的 CSS `hue-rotate()`、这里的矩阵、缩略图的
 * gen-material-thumbs.apply_look_photo（用 PIL 的 convert 矩阵走同一条式子）。
 */
function hueMatrix(deg) {
  const a = (Number(deg) * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]
  ]
}

/** 3×3 → colorchannelmixer 参数串 */
function mixArgs(m) {
  return (
    `rr=${fmt(m[0][0])}:rg=${fmt(m[0][1])}:rb=${fmt(m[0][2])}` +
    `:gr=${fmt(m[1][0])}:gg=${fmt(m[1][1])}:gb=${fmt(m[1][2])}` +
    `:br=${fmt(m[2][0])}:bg=${fmt(m[2][1])}:bb=${fmt(m[2][2])}`
  )
}

/**
 * CSS `saturate(s)` 的矩阵（SVG feColorMatrix type="saturate" 规范式）。
 *
 * ⚠️ 不能用 `eq=saturation=`：eq 是在 YUV 上动色度，与 CSS 的 sRGB 亮度加权矩阵
 *    不是一回事。实测同一组参数下，vivid 族（饱和 1.45~1.95）两者相差 12~18 ΔE ——
 *    比 hue 那条还大，而这正是"卡片上很艳、成片却发闷"的来源。
 */
function saturateMatrix(s) {
  return [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]
  ]
}

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
    chain.push(`colorchannelmixer=${mixArgs(mix)}`)
  }

  const sat = Number((p.saturate * (1 - p.grayscale)).toFixed(4))

  // 对比度：CSS 的 contrast(k) 是逐通道仿射 (x-127.5)·k+127.5。
  // colorchannelmixer 没有偏移项（纯 3×3），而 eq=contrast 在 YUV 上算 —— 两者都不是这条式子，
  // 所以用 lutrgb 把同一条仿射式逐通道写出来。
  if (Math.abs(p.contrast - 1) > 1e-4) {
    const expr = `clip((val-127.5)*${fmt(p.contrast)}+127.5,0,255)`
    chain.push(`lutrgb=r='${expr}':g='${expr}':b='${expr}'`)
  }

  // 饱和度（含去色）：CSS 的亮度加权矩阵，直接交给 colorchannelmixer（纯乘性，正好契合）
  if (Math.abs(sat - 1) > 1e-4) chain.push(`colorchannelmixer=${mixArgs(saturateMatrix(sat))}`)

  // 色相留在链尾（与 cssFilterFor 同序）。矩阵形式而不是 hue=h=，理由见 hueMatrix 注释。
  if (Math.abs(p.hue) > 1e-4) chain.push(`colorchannelmixer=${mixArgs(hueMatrix(p.hue))}`)
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
 *   fx-blur       gblur（预览是覆盖层 backdrop-filter: blur，成片是整幅高斯模糊，方向一致）
 *   fx-mono       hue 去饱和 + 微加对比（预览是 backdrop-filter: grayscale）
 *   fx-vintage    curves 自带 vintage 预设（预览是 backdrop-filter: sepia+sat）
 *   fx-noise      noise 逐帧随机（预览是 SVG feTurbulence 抖动，都是"满屏细颗粒在动"）
 *   fx-glow       eq 提亮 + 轻模糊 ≈ 柔光泛开（预览是中心径向柔光；**不用 split/blend**：
 *                 滤镜链是按逗号拼进 -vf 的，带 `;` 的多链会改变后续链的接续，风险大于收益）
 *   fx-fire       colorbalance 暖推 + hue 亮度按 |sin| 起伏（对应预览从下缘舔上来的火苗）
 *   fx-cold       colorbalance 冷推 + 微提亮（对应预览那层冷青雾）
 *
 * ⚠️ **素材类（pack，键以 `fm-` 开头）在这里一律返回空串**：它们的像素不在滤镜里，
 *    而是把素材包里同一批 PNG 序列 overlay 上去（见 render.js 的 fxPackOverlay）。
 *    在这里返回任何近似值都等于"成片里多一层假效果叠在真素材上"。
 *
 * ⚠️ 表达式里的逗号写在单引号内，不要再加 `\,` —— 引号内的反斜杠会原样进入
 *    表达式，ffmpeg 解析函数参数时直接报"无法解析"，表现为导出任务失败。
 * @returns {string} 空串表示无特效
 */
function frameFxFilterFor(key, { width = 1920, height = 1080 } = {}) {
  /* 素材类不参与滤镜链（前缀判定与 shared 的 pack 表一致：全部是 fm-） */
  if (typeof key === 'string' && key.startsWith('fm-')) return ''
  /**
   * ⚠️ 2026-11-03：键可以是 `fx-glow@2140` 这种带参数后缀的（一族最多 320 个档位组合，
   *    见 shared/fxParams.json）。switch 必须按**族键**分派，否则所有参数化过的键都落到
   *    default 返回空串 —— 表现是"预览在动、成片原样"，而且不报错。
   *    参数从同一张轴表解出来，所以"预览用的数"与"这里用的数"是同一份。
   */
  const p = fxParamsOf(key)
  switch (fxFamily(key)) {
    case 'fx-shake': {
      /* 预览是 translate3d(±t%)（t 为画幅宽的百分数），导出用 crop 原点抖动。
         幅度换算：t% × 画幅宽，取一半做半径，保证峰峰值与预览一致。 */
      const amp = Math.max(2, Math.round((width * p.t) / 100))
      const per = (p.d / 1000).toFixed(3)
      return `crop=w=iw-${amp * 2}:h=ih-${amp * 2}:x='${amp}+${amp}*sin(2*PI*t/${per})':y='${amp}+${amp}*cos(2*PI*t/${per})'`
    }
    case 'fx-pulse': {
      const w = Math.round(width * p.t)
      const h = Math.round(height * p.t)
      const per = (p.d / 1000).toFixed(3)
      return (
        `scale=${w}:${h},` +
        `crop=w=${width}:h=${height}` +
        `:x='(in_w-out_w)/2+${Math.round((w - width) / 2)}*sin(2*PI*t/${per})'` +
        `:y='(in_h-out_h)/2+${Math.round((h - height) / 2)}*cos(2*PI*t/${per})'`
      )
    }
    case 'fx-flash': {
      /* 预览是一片径向亮斑，颜色由 h 决定。导出侧只能近似：亮度按时序打闪（与预览
         同一个 1.5s 节拍），色偏用 colorbalance 往 h 的方向推 —— 暖色推红、冷色推蓝。 */
      const rb = (p.a * 0.16).toFixed(3)
      const bal =
        p.h <= 180
          ? `colorbalance=rs=${rb}:bs=${(-rb * 0.8).toFixed(3)}`
          : `colorbalance=rs=${(-rb * 0.5).toFixed(3)}:bs=${rb}`
      return `${bal},hue=b='${(p.a * 0.26).toFixed(3)}*pow(max(0,sin(2*PI*t/1.5)),6)'`
    }
    case 'fx-glitch': {
      /* 红/蓝通道反向错位；条数轴转成错位像素（预览是 6/11 条扫线，成片是整体色差） */
      const off = Math.max(3, Math.round(p.n * p.t))
      return `rgbashift=rh=${off}:bh=${-off}`
    }
    case 'fx-scan':
      return `drawgrid=w=iw:h=${Math.max(2, Math.round(Number(p.n)))}:t=1:c=black@0.35`
    case 'fx-lightleak': {
      const rb = (p.a * 0.22).toFixed(3)
      return `colorbalance=rs=${rb}:gs=${(p.a * 0.09).toFixed(3)}:bs=${(-p.a * 0.22).toFixed(3)},eq=contrast=0.97:brightness=${(p.a * 0.1).toFixed(3)}`
    }
    case 'fx-vignette':
      /* a 越大越压暗 ⇒ vignette 的角度参数越小（PI/2 是"几乎不压"，PI/8 很重） */
      return `vignette=PI/${(2.2 + (1 - p.a) * 5).toFixed(2)}`
    case 'fx-blur':
      return `gblur=sigma=${Math.max(1, p.b)},eq=brightness=${p.t.toFixed(3)},hue=s=${p.s.toFixed(3)}`
    case 'fx-mono':
      return `hue=s=0,eq=contrast=${Number(p.t).toFixed(3)}`
    case 'fx-vintage':
      return `curves=preset=vintage,eq=contrast=${(0.9 + p.t * 0.14).toFixed(3)}:saturation=${(0.72 + p.s * 0.1).toFixed(3)}`
    case 'fx-noise':
      // alls=14 时同样的 0.8 秒测试片从 40KB 涨到 268KB（颗粒不可压缩）——
      // 10 已经够"胶片颗粒"，再高只是让导出文件变大
      return `noise=alls=${Math.max(4, Math.round(p.a * 22))}:allf=t`
    case 'fx-glow': {
      const rb = (p.a * 0.18).toFixed(3)
      const sigma = (1.2 + p.r * 4).toFixed(2)
      return `eq=brightness=${(p.a * 0.18).toFixed(3)}:saturation=0.94,colorbalance=rs=${rb}:bs=${(rb * 0.5).toFixed(3)},gblur=sigma=${sigma}`
    }
    case 'fx-fire':
      return `colorbalance=rs=${(p.a * 0.36).toFixed(3)}:gs=${(p.a * 0.08).toFixed(3)}:bs=${(-p.a * 0.36).toFixed(3)},hue=b='${(p.a * 0.16).toFixed(3)}*abs(sin(3*PI*t))'`
    case 'fx-cold':
      return `colorbalance=rs=${(-p.a * 0.4).toFixed(3)}:bs=${(p.a * 0.48).toFixed(3)},eq=brightness=${(p.a * 0.07).toFixed(3)}`
    case 'fx-fisheye':
      /* 桶形畸变。k1 **负值**才是"制造畸变"（正值是校正别人镜头带来的畸变）。
         实测 -0.35 几乎看不出、-0.45 是"像鱼眼且边缘还没崩"的最大值，
         -0.6 边缘开始出现明显拉丝（像素被拽出画布外），所以默认钉在 -0.45。
         ⚠️ 与预览的 SVG 位移贴图是**两种算法**，只保证方向与幅度接近，
            不保证逐像素相同 —— 鱼眼这类重映射做不到位图级一致（CSS 没有镜头模型）。 */
      return `lenscorrection=k1=${Number(p.t).toFixed(2)}:k2=0`
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
      transitionOut: d > 0 ? { key: def.key, ffmpeg: def.ffmpeg, geo: def.geo || null, duration: d } : null
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
