'use strict'
/**
 * 文字 / 字幕的入场·出场·循环动画（真源唯一）。
 *
 * 为什么必须是一份：
 *   预览走 CSS @keyframes（renderer/styles.css 的 .ta-*），
 *   导出走 ffmpeg drawtext 的**时间表达式**（alpha / x / y / fontsize）。
 *   这是两套完全不同的实现，但它们必须描述**同一件事**：偏移多少、持续多久、
 *   曲线什么形状。只要两边各写一遍，就一定出现"预览里字幕是滑进来的、
 *   成片里硬生生跳出来"——而且导出文件能正常打开、进度条正常走，看不出哪里错了。
 *
 * 三个槽位（互不干扰，可以任意组合）：
 *   in    入场（片段开头）
 *   out   出场（片段结尾）
 *   loop  持续期间的低幅度循环
 *
 * ⚠️ 单位的唯一口径：**画幅的百分比**（6% = 画布宽的 6%）。
 *    预览里 translateY 的 % 是"元素自身高度"的百分比，而外框是整条画布宽的元素，
 *    高度也等于画布高 —— 所以 translateY(6%) 恰好等于"画布高的 6%"。
 *    导出侧就用 width/height 乘同一个系数，两边逐字对应。
 *
 * ⚠️ 这里**只描述形状**，不描述像素：具体像素由调用方用 width/height 换算，
 *    这样 720p 与 4K 导出看到的是同一种动画幅度（写死 px 的话 4K 里就几乎看不出来）。
 *
 * CommonJS（与 shared/speed.js、shared/reverse.js 同一形制）。
 * ⚠️ 新增 shared 下的 CJS 模块必须同步加进 packages/desktop/vite.config.mjs 的
 *    `commonjsOptions.include`，否则渲染层 import 到的是空对象。
 */

/** 入场动画。`shift` 是"从哪里来"的方向与幅度（画幅百分比，正数 = 从正方向来） */
const IN_TYPES = [
  { key: 'none', label: '无', shift: 0, axis: null, opacity: false, zoom: false },
  { key: 'fade', label: '淡入', shift: 0, axis: null, opacity: true, zoom: false },
  { key: 'up', label: '上浮', shift: 0.06, axis: 'y', opacity: true, zoom: false },
  { key: 'down', label: '下落', shift: -0.06, axis: 'y', opacity: true, zoom: false },
  { key: 'left', label: '左滑', shift: 0.06, axis: 'x', opacity: true, zoom: false },
  { key: 'right', label: '右滑', shift: -0.06, axis: 'x', opacity: true, zoom: false },
  { key: 'zoom', label: '放大', shift: 0, axis: null, opacity: true, zoom: true }
]

/**
 * 出场动画。
 * ⚠️ 出场只有"淡出 / 平移 / 缩放"这几种**位移与透明度**变化 ——
 *    不做"擦除""翻页"这类需要遮罩的效果：drawtext 没有遮罩，
 *    做了就只能是"预览里有、成片里没有"。
 */
const OUT_TYPES = [
  { key: 'none', label: '无', shift: 0, axis: null, opacity: false, zoom: false },
  { key: 'fade', label: '淡出', shift: 0, axis: null, opacity: true, zoom: false },
  /* ⚠️ 出场的位移符号与入场**相反**：入场是"从偏移处回到零"，出场是"从零走到偏移处"。
     两边共用同一张符号表的话，写"上飘"就会得到"往下沉" —— 而且是**两边一起错**，
     预览与导出居然还是一致的，只有逐帧看片子才发现方向反了。 */
  { key: 'up', label: '上飘', shift: -0.06, axis: 'y', opacity: true, zoom: false },
  { key: 'down', label: '下沉', shift: 0.06, axis: 'y', opacity: true, zoom: false },
  { key: 'left', label: '左移', shift: -0.06, axis: 'x', opacity: true, zoom: false },
  { key: 'right', label: '右移', shift: 0.06, axis: 'x', opacity: true, zoom: false },
  { key: 'zoom', label: '缩小淡出', shift: 0, axis: null, opacity: true, zoom: true }
]

/**
 * 循环动画。幅度刻意很小（1.5% / 8° 以内）：
 * 字幕在整段里一直动，幅度一大就变成"晃得看不下去"。
 */
const LOOP_TYPES = [
  { key: 'none', label: '无', period: 0, amp: 0 },
  { key: 'breathe', label: '呼吸', period: 2.6, amp: 0.18 },
  { key: 'float', label: '浮动', period: 3.2, amp: 0.015 },
  { key: 'sway', label: '摇摆', period: 3.6, amp: 0.01 }
]

/**
 * 样式表里那条 `anim`（fade / slideup / pop / typewriter / glow）→ 本文件的入场类型。
 *
 * 这是**唯一**的一层映射：样式表自带的动画不再单独走一套 CSS 类，
 * 而是成为"片段没有指定入场时的默认值"。两套并存的毛病是：
 *   样式动画用 `animation: ... both` 停在终态，会把循环动画（呼吸）整个盖住 ——
 *   表现为"选了呼吸，完全没有反应"，而代码里两处都写着、都"执行"了。
 */
const STYLE_ANIM_MAP = {
  fade: 'fade',
  slideup: 'up',
  pop: 'zoom',
  typewriter: 'fade',
  glow: 'fade'
}

const DUR_DEFAULT = 0.4
const DUR_MIN = 0.1
const DUR_MAX = 2

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const pick = (list, key) => list.find((item) => item.key === key) || list[0]

/**
 * 片段 → 归一化的动画参数。
 *
 * ⚠️ 时长必须夹到 `[DUR_MIN, DUR_MAX]`：0 会让进度除零（导出表达式变成 `inf`，
 *    整条滤镜串解析失败 ⇒ 一条字幕都画不出来），而大于片段时长会让
 *    "入场还没结束就开始出场"，中段黑掉。
 */
function readTextAnim(clip, styleAnim = '') {
  const src = clip || {}
  const inDur = clamp(num(src.textInDur, DUR_DEFAULT), DUR_MIN, DUR_MAX)
  const outDur = clamp(num(src.textOutDur, DUR_DEFAULT), DUR_MIN, DUR_MAX)
  /* 片段显式设过 textIn（含显式的 'none'）就用它，否则跟样式表走 */
  const inKey = src.textIn ? pick(IN_TYPES, src.textIn).key : STYLE_ANIM_MAP[styleAnim] || 'none'
  return {
    in: inKey,
    out: pick(OUT_TYPES, src.textOut || 'none').key,
    loop: pick(LOOP_TYPES, src.textLoop || 'none').key,
    inDur,
    outDur
  }
}

/** 有没有开任何一项（面板据此决定是否显示"恢复默认"） */
const hasTextAnim = (clip) => {
  const a = readTextAnim(clip)
  return a.in !== 'none' || a.out !== 'none' || a.loop !== 'none'
}

const resetTextAnim = () => ({
  textIn: 'none',
  textOut: 'none',
  textLoop: 'none',
  textInDur: DUR_DEFAULT,
  textOutDur: DUR_DEFAULT
})

const inDef = (key) => pick(IN_TYPES, key)
const outDef = (key) => pick(OUT_TYPES, key)
const loopDef = (key) => pick(LOOP_TYPES, key)

/* ------------------------- 导出侧：ffmpeg 表达式 ------------------------- */

/**
 * 进度变量：0 → 1，夹在两端（不加 clamp 的话出场前 alpha 会变成负数，整条黑掉）。
 *
 * ⚠️ 这里**只写数学，不做转义**：逗号就是逗号。
 *    转义（`,` → `\,`）是导出侧唯一的收口点（subtitles.js 的 exprOpt）。
 *    两边都转一次会得到 `\\,` —— ffmpeg 只吃一层，第二层会原样喂给表达式求值器，
 *    报 `Missing ')' or too many args`，而且报错行看着完全正常（外面看不出多了一个反斜杠）。
 */
const progress = (start, dur) => `min(max((t-${start.toFixed(3)})/${dur.toFixed(3)},0),1)`

/**
 * 入场 / 出场 / 循环 → 三段可组合的表达式。
 *
 * 返回的是**裸表达式片段**，由调用方决定乘到哪里：
 *   · a   透明度（多个之间相乘）
 *   · dx  水平位移（像素，正数向右）
 *   · dy  垂直位移（像素，正数向下）
 *   · fs  字号倍数（默认 1）
 *
 * @param {object} anim readTextAnim 的结果
 * @param {object} box  { start, duration, width, height }
 */
function animExpr(anim, box) {
  const start = Math.max(0, num(box.start, 0))
  const duration = Math.max(0.01, num(box.duration, 0.01))
  const width = Math.max(1, num(box.width, 1920))
  const height = Math.max(1, num(box.height, 1080))

  const inDur = Math.min(anim.inDur, duration)
  const outDur = Math.min(anim.outDur, duration)
  const p = progress(start, inDur)
  const q = progress(start + duration - outDur, outDur)

  const parts = { a: [], dx: [], dy: [], fs: [] }
  const inT = inDef(anim.in)
  const outT = outDef(anim.out)

  /* 入场：位移从 ±shift 回到 0，透明度 0→1，字号 0.86→1 */
  if (inT.shift) {
    const px = (inT.shift * (inT.axis === 'x' ? width : height)).toFixed(1)
    const expr = `${px}*(1-${p})`
    if (inT.axis === 'x') parts.dx.push(expr)
    else parts.dy.push(expr)
  }
  if (inT.opacity) parts.a.push(p)
  if (inT.zoom) parts.fs.push(`(0.86+0.14*${p})`)

  /* 出场：反过来 —— 从 0 走到 ±shift */
  if (outT.shift) {
    const px = (outT.shift * (outT.axis === 'x' ? width : height)).toFixed(1)
    const expr = `${px}*${q}`
    if (outT.axis === 'x') parts.dx.push(expr)
    else parts.dy.push(expr)
  }
  if (outT.opacity) parts.a.push(`(1-${q})`)
  if (outT.zoom) parts.fs.push(`(1-0.14*${q})`)

  /* 循环：正弦，周期以秒计。breathe 只动透明度，float 只动 y，sway 只动 x */
  const loop = loopDef(anim.loop)
  if (loop.period > 0) {
    const wave = `sin(2*PI*(t-${start.toFixed(3)})/${loop.period})`
    if (anim.loop === 'breathe') {
      /* ⚠️ amp 是**全幅**（0.18 = 峰谷差 18%），所以半幅才是 ±0.09：
         写成 `0.82 + 0.18*sin` 会让最低点掉到 0.64 —— 比 CSS 那边的 0.82 暗得多，
         而两边都"在动"，只有把同一时刻的透明度算出来比才看得见差。
         保留三位小数：`1 - 0.09` 在 JS 里是 0.9100000000000001。 */
      const half = loop.amp / 2
      parts.a.push(`(${Number((1 - half).toFixed(3))}+${Number(half.toFixed(3))}*${wave})`)
    }
    if (anim.loop === 'float') parts.dy.push(`${(loop.amp * height).toFixed(1)}*${wave}`)
    if (anim.loop === 'sway') parts.dx.push(`${(loop.amp * width).toFixed(1)}*${wave}`)
  }

  return {
    alpha: parts.a.length ? parts.a.join('*') : '',
    dx: parts.dx.join('+'),
    dy: parts.dy.join('+'),
    fontScale: parts.fs.length ? parts.fs.join('*') : ''
  }
}

module.exports = {
  STYLE_ANIM_MAP,
  IN_TYPES,
  OUT_TYPES,
  LOOP_TYPES,
  DUR_DEFAULT,
  DUR_MIN,
  DUR_MAX,
  readTextAnim,
  hasTextAnim,
  resetTextAnim,
  inDef,
  outDef,
  loopDef,
  animExpr
}
