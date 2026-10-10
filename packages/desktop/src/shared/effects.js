'use strict'
/**
 * 片段「效果」真源（圆角 / 蒙版 / 抠像 / 混合 / 变形 / 描边 / 阴影）。
 *
 * 为什么又是单独一个 shared 模块、又不许两边各写一份：
 *   这一组效果跟 adjust.js 那组是同一个病 ——
 *   「圆角 12」在**预览**里要真的把画面切圆，在**导出**里要真的在 ffmpeg 链上多一级；
 *   两边各写一份，迟早一边漏掉，症状是"面板上拖了、预览也圆了、成片还是方的"，
 *   而且构建不报错、静态扫描看不出来（「静默失效五类」的第 ⑤ 类：
 *   状态变了、画面一个像素没变 —— 只不过这次是"成片那个画面"）。
 *
 * 与 shared/adjust.js / shared/speed.js 同一形制：**CommonJS**，
 *   主进程 `require`、渲染层 `import`（渲染层那侧由 vite 的 commonjs 插件转）。
 *   ⚠️ **新增 shared 模块必须同步加进 `packages/desktop/vite.config.mjs` 的
 *     `commonjsOptions.include` 白名单**，漏了的话渲染层 import 到的是空对象，
 *     症状是"面板永远显示默认值、拖了没反应"，而构建完全成功。
 *
 * 两边的换算口径（长度一律按**基准宽度 1920** 折算成比例，两侧各自乘自己的宽度）：
 *   圆角   → CSS `border-radius: <r>cqw`      / ffmpeg 圆角遮罩（geq + alphamerge）
 *   蒙版   → CSS `mask-image`（渐变羽化）      / ffmpeg 形状遮罩（geq + gblur + alphamerge）
 *   抠像   → SVG `feColorMatrix`（alpha 行）   / ffmpeg `colorkey`（RGB 空间，与预览同空间）
 *   变形   → CSS `skew(a, b)`                 / ffmpeg `shear`（shx = tan(a)）
 *   混合   → CSS `mix-blend-mode`             / ffmpeg `blend=all_mode`（必须走 gbrp）
 *   描边   → CSS 8 向 `drop-shadow`           / ffmpeg `dilation` 环 + `lutrgb` 上色
 *   阴影   → CSS `drop-shadow(x y blur c)`    / ffmpeg 黑剪影 + `gblur` + 偏移 `overlay`
 *
 * ⚠️ 抠像是**近似同源**：导出走 ffmpeg 的 RGB `colorkey`（逐像素距离判定），
 *    预览只能用 SVG 的线性 alpha 行（`alpha = 1 + Σ非键通道 − Σ键通道`）。
 *    两者对**饱和的绿幕/蓝幕**结论一致（键色变透明、白/黑/肤/红保持不透明），
 *    但边缘的过渡曲线不完全相同。所以预览那一层会挂 `data-key-map="approx"`，
 *    闸门按这个属性断言 —— 免得以后有人把"近似"当成"已经一模一样"。
 */

/** 所有长度参数的基准宽度。UI 上的 px 都按这个宽度定义，两侧换算成比例后各自乘自己的宽度。 */
const REF_WIDTH = 1920

/** 圆角上限（基准 px） */
const RADIUS_MAX = 240
/** 斜切上限（度）。45° 时 tan=1，两侧都还是有限值。 */
const SKEW_LIMIT = 45

/** 抠像预设色（饱和的绿幕 / 蓝幕） */
const KEY_PRESETS = [
  { key: 'green', label: '绿幕', color: '#00B140' },
  { key: 'blue', label: '蓝幕', color: '#0047BB' }
]
const DEFAULT_KEY_COLOR = '#00B140'

/** 蒙版形状 */
const MASK_SHAPES = [
  { key: 'none', label: '无' },
  { key: 'rect', label: '矩形' },
  { key: 'circle', label: '圆形' },
  { key: 'ellipse', label: '椭圆' }
]
/** 蒙版羽化上限（基准 px） */
const MASK_FEATHER_MAX = 200

/** 描边 / 阴影 */
const STROKE_MAX = 40
const SHADOW_MAX_OFFSET = 200
const SHADOW_MAX_BLUR = 200

/**
 * 混合模式。
 *
 * ⚠️ 只列**CSS 与 ffmpeg 都有**的那几种，名字两侧对得上：
 *    CSS 用连字符（`color-dodge`），ffmpeg 用下划线（`color_dodge`）——
 *    映射表写错的话 ffmpeg 会直接报 "Invalid blend mode"，导出整个失败，
 *    而不是"混合看起来不对"，所以这里宁可多一张显式映射表。
 */
const BLEND_MODES = [
  { key: 'normal', label: '正常', css: 'normal', ffmpeg: null },
  { key: 'multiply', label: '正片叠底', css: 'multiply', ffmpeg: 'multiply' },
  { key: 'screen', label: '滤色', css: 'screen', ffmpeg: 'screen' },
  { key: 'overlay', label: '叠加', css: 'overlay', ffmpeg: 'overlay' },
  { key: 'darken', label: '变暗', css: 'darken', ffmpeg: 'darken' },
  { key: 'lighten', label: '变亮', css: 'lighten', ffmpeg: 'lighten' },
  { key: 'color-dodge', label: '颜色减淡', css: 'color-dodge', ffmpeg: 'color_dodge' },
  { key: 'color-burn', label: '颜色加深', css: 'color-burn', ffmpeg: 'color_burn' },
  { key: 'hard-light', label: '强光', css: 'hard-light', ffmpeg: 'hardlight' },
  { key: 'soft-light', label: '柔光', css: 'soft-light', ffmpeg: 'softlight' },
  { key: 'difference', label: '差值', css: 'difference', ffmpeg: 'difference' },
  { key: 'exclusion', label: '排除', css: 'exclusion', ffmpeg: 'exclusion' }
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const round4 = (value) => Number(Number(value).toFixed(4))

/** 基准 px → 占画面宽度的比例（两侧各自乘以自己的宽度即得实际像素） */
const ratioOf = (px) => round4(num(px) / REF_WIDTH)

/** `#RRGGBB` / `#RGB` → {r,g,b}（0–255）。非法一律回黑，不抛错。 */
function readHexColor(value, fallback = '#000000') {
  const raw = String(value || '').trim()
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw)
  const hex = m ? m[1] : String(fallback).replace('#', '')
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0
  }
}

/** {r,g,b} → `#RRGGBB` */
const hexOf = (rgb) =>
  '#' +
  [rgb.r, rgb.g, rgb.b]
    .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
    .join('')

/** {r,g,b} → `0xRRGGBB`（ffmpeg 的 colorkey 要这个写法） */
const ffColorOf = (rgb) => `0x${hexOf(rgb).slice(1)}`

const isHexColor = (value) => /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value || '').trim())

/** 读一组效果参数：缺省 / 脏数据一律回落中性值，不抛错、不产生 NaN */
function readEffects(src) {
  const s = src && typeof src === 'object' ? src : {}
  const key = s.key && typeof s.key === 'object' ? s.key : {}
  const mask = s.mask && typeof s.mask === 'object' ? s.mask : {}
  const stroke = s.stroke && typeof s.stroke === 'object' ? s.stroke : {}
  const shadow = s.shadow && typeof s.shadow === 'object' ? s.shadow : {}
  const blendKey = String(s.blend || 'normal')
  return {
    radius: clamp(num(s.radius, 0), 0, RADIUS_MAX),
    skewX: clamp(num(s.skewX, 0), -SKEW_LIMIT, SKEW_LIMIT),
    skewY: clamp(num(s.skewY, 0), -SKEW_LIMIT, SKEW_LIMIT),
    blend: BLEND_MODES.some((item) => item.key === blendKey) ? blendKey : 'normal',
    key: {
      on: Boolean(key.on),
      color: isHexColor(key.color) ? String(key.color) : DEFAULT_KEY_COLOR,
      similarity: clamp(num(key.similarity, 50), 0, 100)
    },
    mask: {
      shape: MASK_SHAPES.some((item) => item.key === mask.shape) ? mask.shape : 'none',
      x: clamp(num(mask.x, 50), -50, 150),
      y: clamp(num(mask.y, 50), -50, 150),
      w: clamp(num(mask.w, 60), 2, 200),
      h: clamp(num(mask.h, 60), 2, 200),
      feather: clamp(num(mask.feather, 0), 0, MASK_FEATHER_MAX)
    },
    stroke: {
      on: Boolean(stroke.on),
      width: clamp(num(stroke.width, 3), 0, STROKE_MAX),
      color: isHexColor(stroke.color) ? String(stroke.color) : '#ffffff'
    },
    shadow: {
      on: Boolean(shadow.on),
      x: clamp(num(shadow.x, 8), -SHADOW_MAX_OFFSET, SHADOW_MAX_OFFSET),
      y: clamp(num(shadow.y, 8), -SHADOW_MAX_OFFSET, SHADOW_MAX_OFFSET),
      blur: clamp(num(shadow.blur, 12), 0, SHADOW_MAX_BLUR),
      color: isHexColor(shadow.color) ? String(shadow.color) : '#000000',
      opacity: clamp(num(shadow.opacity, 60), 0, 100)
    }
  }
}

/** 全部中性？（用来决定"这一层到底要不要多挂东西"） */
function isNeutralEffects(fx) {
  if (!fx) return true
  return (
    fx.radius < 0.01 &&
    Math.abs(fx.skewX) < 0.01 &&
    Math.abs(fx.skewY) < 0.01 &&
    fx.blend === 'normal' &&
    !fx.key.on &&
    fx.mask.shape === 'none' &&
    !fx.stroke.on &&
    !fx.shadow.on
  )
}

/** 是否有"剪裁类"效果（圆角 / 蒙版）—— 预览据此决定要不要插一个遮罩盒 */
const hasClip = (fx) => Boolean(fx) && (fx.radius >= 0.01 || fx.mask.shape !== 'none')

/** 是否有会在 filter 链上多加东西的效果（描边 / 阴影） */
const hasFilterFx = (fx) => Boolean(fx) && (fx.stroke.on || fx.shadow.on)

/* ------------------------------- 圆角 ------------------------------- */

/** 圆角（预览）：`border-radius` 用 cqw，与导出按同一个比例 */
function cssRadius(fx) {
  if (!fx || fx.radius < 0.01) return ''
  return `${(ratioOf(fx.radius) * 100).toFixed(4)}cqw`
}

/** 圆角（导出）：实际像素 */
const radiusPx = (fx, width) => Math.round(ratioOf(fx && fx.radius) * (Number(width) > 0 ? Number(width) : REF_WIDTH))

/* ------------------------------- 变形 ------------------------------- */

/**
 * 斜切（预览）→ `skew(a, b)`。
 * ⚠️ 与导出的 `shear` 是同一个线性变换：CSS 的 skewX(a) 把 x 抬 `tan(a)·y`，
 *    ffmpeg 的 `shear=shx=k` 把 x 抬 `k·y`，所以 **k = tan(a)**。写反了方向，
 *    预览往左上、成片往右下，而两边各自都"看着挺正常"。
 */
function cssSkew(fx) {
  if (!fx) return ''
  const ax = Math.abs(num(fx.skewX))
  const ay = Math.abs(num(fx.skewY))
  if (ax < 0.01 && ay < 0.01) return ''
  return `skew(${round4(fx.skewX)}deg, ${round4(fx.skewY)}deg)`
}

/**
 * 斜切（导出）→ `shear=shx=..:shy=..:fillcolor=..`。
 *
 * ⚠️ ffmpeg 的 `shy` 与 CSS 的 `skewY` 同号（都是 "y 随 x 抬"），
 *    而 `shear` 的公式是 `x' = x + shx·y`、`y' = y + shy·x` —— 与 CSS skew 一致。
 *    fillcolor 用透明：斜切会在四角露出空档，露底色才是预览里看到的样子。
 */
function shearFor(fx, round = round4, fill = 'black@0') {
  if (!fx) return ''
  const ax = Math.abs(num(fx.skewX))
  const ay = Math.abs(num(fx.skewY))
  if (ax < 0.01 && ay < 0.01) return ''
  const shx = round(Math.tan((num(fx.skewX) * Math.PI) / 180), 5)
  const shy = round(Math.tan((num(fx.skewY) * Math.PI) / 180), 5)
  return `shear=shx=${shx}:shy=${shy}:fillcolor=${fill}`
}

/* ------------------------------- 抠像 ------------------------------- */

/** 抠像色（`#RRGGBB`） */
const keyColor = (fx) => (fx && fx.key.on ? fx.key.color : '')

/**
 * 抠像（预览）→ `feColorMatrix` 的 **alpha 行**（1×5）。
 *
 * 口径：`alpha = 1 + Σ(非键通道) − Σ(键通道)` —— 键色「绿幕」时即 `1 + R + B − G`：
 *   纯绿 → 0（透明）；白/黑/肤/红 → ≥1（夹到不透明）；半绿 → 部分透明（软边）。
 * 键色按最大通道归一化成"哪几个通道该减"：绿幕减 G、蓝幕减 B、青幕减 G+B。
 * ⚠️ 这是**近似**：导出走的是 ffmpeg 的 RGB `colorkey`（逐像素距离），
 *    对饱和键色的结论一致，过渡曲线不完全相同 —— 预览层挂 `data-key-map="approx"`。
 */
function keyAlphaRow(fx) {
  if (!fx || !fx.key.on) return ''
  const c = readHexColor(fx.key.color, DEFAULT_KEY_COLOR)
  const maxCh = Math.max(c.r, c.g, c.b) || 255
  // 归一化后每通道的系数：越接近键色的那个通道，越该被"减"
  const cR = 1 - (2 * c.r) / maxCh
  const cG = 1 - (2 * c.g) / maxCh
  const cB = 1 - (2 * c.b) / maxCh
  // 强度：加大"减"的倍率 —— 只会让更宽的绿被抠掉，不会误伤白色（白色本来就 ≥1）
  const gain = round4(0.6 + (fx.key.similarity / 100) * 1.4)
  return [round4(cR * gain), round4(cG * gain), round4(cB * gain), 0, 1].join(' ')
}

/**
 * 抠像（导出）→ `colorkey`。
 *
 * 为什么用 `colorkey` 而不是 `chromakey`：`colorkey` 在 **RGB** 空间判定，
 * 与预览的 feColorMatrix（也是拿 sRGB 通道算）同一个空间；`chromakey` 在 YUV，
 * 键色会被色度子采样带偏，绿幕边缘那圈会与预览差得肉眼可见。
 *
 * similarity 0–100 → 0.05–0.55（ffmpeg 的相似度阈值，越大抠得越狠）；
 * blend 固定 0.1（边缘融合），保证绿幕边缘不是硬切。
 */
function colorkeyFor(fx, round = round4) {
  if (!fx || !fx.key.on) return ''
  const c = readHexColor(fx.key.color, DEFAULT_KEY_COLOR)
  const similarity = round(0.05 + (fx.key.similarity / 100) * 0.5, 4)
  return `colorkey=${ffColorOf(c)}:${similarity}:0.1`
}

/* ------------------------------- 蒙版 ------------------------------- */

/** 蒙版（预览）：遮罩盒的定位（相对画框的百分比）—— 仅供闸门/调试读数 */
function maskBoxPercent(fx) {
  const m = fx && fx.mask ? fx.mask : null
  if (!m || m.shape === 'none') return null
  const w = m.shape === 'circle' ? Math.min(m.w, m.h) : m.w
  const h = m.shape === 'circle' ? Math.min(m.w, m.h) : m.h
  return {
    left: `${round4(m.x - w / 2)}%`,
    top: `${round4(m.y - h / 2)}%`,
    width: `${round4(w)}%`,
    height: `${round4(h)}%`
  }
}

const pct = (value) => `${round4(Math.max(-200, Math.min(300, value)))}%`

/**
 * 蒙版（预览）→ `mask-image`（**纯渐变，相对元素自身盒子**）。
 *
 * 为什么用渐变而不是"绝对定位的遮罩盒 + 内缩矩形"：
 *   定位盒需要父元素有**确定高度**才能 `inset:0`。主画面那一层有（铺满画布），
 *   但**画中画的高度是由素材比例决定的**（导出侧 `scale=w:-2` 就是这个意思），
 *   CSS 里拿不到 ⇒ 定位盒高度会塌成 0，圆角/蒙版在画中画上整个失效。
 *   改成"相对元素盒的渐变"之后，主画面与画中画**共用同一段实现**，
 *   也不会因为盒子的高度算法不同而一边生效一边不生效。
 *
 * · 圆/椭圆：`radial-gradient(<rx>% <ry>% at <x>% <y>%, ...)`，
 *   羽化 = 把内侧不动点到 100% 之间留一段过渡；
 * · 矩形：左右、上下两条线性渐变取交集（`mask-composite: intersect`）。
 *
 * ⚠️ `circle` 要的是**正圆**：盒子的宽高比不一定是 1，所以 y 方向的半径百分比要
 *    按画框宽高比换算（`ryPercent = rxPercent × ar`），否则圆会被拉成椭圆 ——
 *    而这种错"看着就是个椭圆"，很容易被当成"设计如此"。
 *
 * @param {number} ar 画框宽高比（宽 / 高）
 */
function cssMaskFor(fx, ar = 16 / 9) {
  const m = fx && fx.mask ? fx.mask : null
  if (!m || m.shape === 'none') return null
  const ratio = Number(ar) > 0 ? Number(ar) : 16 / 9
  const rx = m.w / 2
  const ry = m.shape === 'circle' ? rx * ratio : m.h / 2

  if (m.shape !== 'rect') {
    if (m.feather < 0.01) {
      return { maskImage: `radial-gradient(${pct(rx)} ${pct(ry)} at ${pct(m.x)} ${pct(m.y)}, #000 99.5%, transparent 100%)`, maskComposite: '' }
    }
    const soft = Math.min(48, (m.feather / Math.max(1, m.w)) * 100)
    return {
      maskImage: `radial-gradient(${pct(rx)} ${pct(ry)} at ${pct(m.x)} ${pct(m.y)}, #000 ${round4(100 - soft)}%, transparent 100%)`,
      maskComposite: ''
    }
  }

  const f = m.feather < 0.01 ? 0 : Math.min(45, (m.feather / Math.max(1, m.w)) * 100)
  const x0 = m.x - rx
  const x1 = m.x + rx
  const y0 = m.y - ry
  const y1 = m.y + ry
  return {
    maskImage:
      `linear-gradient(to right, transparent ${pct(x0)}, #000 ${pct(x0 + f)}, #000 ${pct(x1 - f)}, transparent ${pct(x1)}),` +
      `linear-gradient(to bottom, transparent ${pct(y0)}, #000 ${pct(y0 + f)}, #000 ${pct(y1 - f)}, transparent ${pct(y1)})`,
    maskComposite: 'intersect'
  }
}

/** 蒙版形状（导出）：形状名（none 表示不做遮罩） */
const maskShapeOf = (fx) => (fx && fx.mask ? fx.mask.shape : 'none')

/**
 * 蒙版遮罩（导出）→ geq 的 luma 表达式（`255` = 保留，`0` = 抠掉）。
 *
 * ⚠️ 表达式里**只用 geq 自带的 `X / Y / W / H`**，不写死像素数 —— 于是同一份表达式：
 *   · 主画面：喂给 `color=s=${w}x${h}` 生成一张遮罩 PNG（一次生成、逐帧 alphamerge，快）；
 *   · 画中画：直接在运行时 `geq` 求值（`W/H` 就是画中画那一帧的真实尺寸，
 *     而它的高度是由素材比例决定的，构建命令时根本算不出来）。
 *   写死像素数的话，画中画的遮罩会按错的尺寸算 —— 而"形状大致还在"，很难发现。
 *
 * 形状与圆角在**同一个表达式**里取交集 —— 分两次 alphamerge 的话，
 * 圆角那一步会把羽化过的软边重新切成硬边。
 *
 * ⚠️ 三条 ffmpeg `geq` 求值器的实测限制（2026-10-10 真机验的，写错整条导出挂掉）：
 *   ① **没有 `and()` / `or()` / `mul()`** —— 用 `*` 当"且"（比较结果本来就是 0/1）；
 *   ② 逗号在单引号内是**字面量**，不要写 `\,`（那是多余的转义）；
 *   ③ `pow` / `hypot` / `max` / `min` / `if` / `gte` / `lte` 都有。
 */
function maskExprFor(fx) {
  const m = fx && fx.mask ? fx.mask : null
  const shape = m ? m.shape : 'none'
  const rFrac = ratioOf(fx && fx.radius)
  const terms = []
  /* `W*(0.12)` 这种写法里的负号必须带括号：`W*-0.12` 在 geq 的求值器里会解析失败 */
  const wx = (frac) => `W*(${round4(frac)})`
  const hy = (frac) => `H*(${round4(frac)})`

  if (shape === 'rect' || shape === 'circle' || shape === 'ellipse') {
    if (shape === 'rect') {
      terms.push(
        `gte(X,${wx((m.x - m.w / 2) / 100)})*lte(X,${wx((m.x + m.w / 2) / 100)})*` +
          `gte(Y,${hy((m.y - m.h / 2) / 100)})*lte(Y,${hy((m.y + m.h / 2) / 100)})`
      )
    } else if (shape === 'circle') {
      /* 正圆：两个方向的半径都用**同一个像素量** `W*r`（写成 ry = rx × W/H 还要除 H，
         geq 里没法整洁地表达；直接用 `W*r` 当 y 半径的像素值即可，圆就是圆）。 */
      const r = Math.min(m.w, m.h) / 200
      terms.push(
        `lte(pow((X-${wx(m.x / 100)})/(${wx(r)}),2)+pow((Y-${hy(m.y / 100)})/(${wx(r)}),2),1)`
      )
    } else {
      terms.push(
        `lte(pow((X-${wx(m.x / 100)})/(${wx(m.w / 200)}),2)+pow((Y-${hy(m.y / 100)})/(${hy(m.h / 200)}),2),1)`
      )
    }
  }

  if (rFrac > 0) {
    const r = wx(rFrac)
    terms.push(
      `lte(max(max(hypot(max(0,${r}-X),max(0,${r}-Y)),hypot(max(0,X-(W-1-${r})),max(0,${r}-Y))),` +
        `max(hypot(max(0,${r}-X),max(0,Y-(H-1-${r}))),hypot(max(0,X-(W-1-${r})),max(0,Y-(H-1-${r}))))),${r})`
    )
  }

  if (!terms.length) return ''
  return `if(${terms.join('*')},255,0)`
}

/* ------------------------------- 混合 ------------------------------- */

const blendModeOf = (fx) => (fx && fx.blend ? fx.blend : 'normal')
/** 混合（预览）→ `mix-blend-mode`（normal 时返回 ''，不挂属性） */
function blendCss(fx) {
  const item = BLEND_MODES.find((entry) => entry.key === blendModeOf(fx))
  if (!item || !item.css || item.css === 'normal') return ''
  return item.css
}
/** 混合（导出）→ `blend=all_mode`；normal 时返回 ''（走原来的 overlay 合成） */
function blendFfmpeg(fx) {
  const item = BLEND_MODES.find((entry) => entry.key === blendModeOf(fx))
  return item && item.ffmpeg ? item.ffmpeg : ''
}

/* ------------------------------- 描边 ------------------------------- */

/** 描边宽度（基准 px → 实际像素） */
const strokePx = (fx, width) =>
  fx && fx.stroke.on ? Math.round(ratioOf(fx.stroke.width) * (Number(width) > 0 ? Number(width) : REF_WIDTH)) : 0

/**
 * 描边（导出）→ `dilation` 的级数（每级膨胀 1 像素，默认 8 邻域）。
 *
 * ⚠️ `dilation` 没有半径参数，只有 3×3 的邻域掩码 —— 想要 N 像素的描边就得串 N 级。
 *    这里上限 24 级（≈24px @1920），再多就既慢又没有观感收益。
 */
function strokeDilations(fx, width) {
  const px = strokePx(fx, width)
  return Math.max(0, Math.min(24, Math.round(px)))
}

/** 描边（导出）→ `lutrgb` 的上色串（把白色环染成描边色） */
function strokeLut(fx, round = round4) {
  if (!fx || !fx.stroke.on) return ''
  const c = readHexColor(fx.stroke.color, '#ffffff')
  return `r=${round(c.r, 4)}:g=${round(c.g, 4)}:b=${round(c.b, 4)}`
}

/**
 * 描边（预览）→ 8 向 `drop-shadow`。
 *
 * 为什么不用 SVG `feMorphology`：HTML 元素上的 SVG filter 用的是**元素自身的 CSS px**，
 * 而预览元素的尺寸随窗口变 —— 在参数层算不出该写多少 px 的膨胀半径，写死就会
 * "窗口一大描边就细得看不见"。`drop-shadow` 的长度可以写 `cqw`（画框宽度的 1%），
 * 与导出按同一个比例，窗口缩放自动等比。
 * 8 个方向叠加出来的外轮廓在圆角处比真正的形态学膨胀稍钝，属于可接受的手感差异。
 */
function strokeShadows(fx) {
  if (!fx || !fx.stroke.on || fx.stroke.width < 0.01) return ''
  const r = (ratioOf(fx.stroke.width) * 100).toFixed(4)
  const c = fx.stroke.color
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7071, 0.7071],
    [-0.7071, 0.7071],
    [0.7071, -0.7071],
    [-0.7071, -0.7071]
  ]
  return dirs
    .map(([dx, dy]) => `drop-shadow(${(dx * Number(r)).toFixed(4)}cqw ${(dy * Number(r)).toFixed(4)}cqw 0 ${c})`)
    .join(' ')
}

/* ------------------------------- 阴影 ------------------------------- */

/**
 * 阴影（预览）→ `drop-shadow(x y blur color)`。
 * CSS 的 blur 半径与 ffmpeg `gblur` 的 sigma 不是同一个量纲（CSS 的半径 ≈ 2σ），
 * 所以导出侧用 `sigma = blur / 2` —— 同一个观感、不同的换算，见 shadowSigma。
 */
function shadowFilter(fx) {
  if (!fx || !fx.shadow.on) return ''
  const s = fx.shadow
  const c = readHexColor(s.color, '#000000')
  const dx = (ratioOf(s.x) * 100).toFixed(4)
  const dy = (ratioOf(s.y) * 100).toFixed(4)
  const blur = (ratioOf(s.blur) * 100).toFixed(4)
  return `drop-shadow(${dx}cqw ${dy}cqw ${blur}cqw rgba(${c.r}, ${c.g}, ${c.b}, ${round4(s.opacity / 100)}))`
}

/** 阴影（导出）→ gblur 的 sigma（= 预览 blur 半径的一半，见上） */
const shadowSigma = (fx, width) => {
  if (!fx || !fx.shadow.on) return 0
  const px = ratioOf(fx.shadow.blur) * (Number(width) > 0 ? Number(width) : REF_WIDTH)
  return Math.max(0, Math.min(200, round4(px / 2)))
}

/** 阴影（导出）→ 偏移像素 */
const shadowOffset = (fx, width) => {
  const w = Number(width) > 0 ? Number(width) : REF_WIDTH
  if (!fx || !fx.shadow.on) return { x: 0, y: 0 }
  return { x: Math.round(ratioOf(fx.shadow.x) * w), y: Math.round(ratioOf(fx.shadow.y) * w) }
}

/* ------------------------------ 关键帧 ------------------------------ */

/** 可打关键帧的属性（都是"数"性质、能线性插值） */
const KEYFRAME_PROPS = [
  { key: 'posX', label: '位置 X', min: -50, max: 50, def: 0 },
  { key: 'posY', label: '位置 Y', min: -50, max: 50, def: 0 },
  { key: 'scale', label: '缩放', min: 10, max: 300, def: 100 },
  { key: 'rotate', label: '旋转', min: -180, max: 180, def: 0 },
  { key: 'opacity', label: '不透明度', min: 0, max: 100, def: 100 }
]

/** 读关键帧表：`{ posX: [{t, v}, ...], ... }`，按 t 升序、剔掉非法点 */
function readKeyframes(src) {
  const s = src && typeof src === 'object' ? src : {}
  const out = {}
  for (const prop of KEYFRAME_PROPS) {
    const list = Array.isArray(s[prop.key]) ? s[prop.key] : null
    if (!list || !list.length) continue
    const points = list
      .map((p) => ({ t: Math.max(0, num(p && p.t)), v: clamp(num(p && p.v, prop.def), prop.min, prop.max) }))
      .sort((a, b) => a.t - b.t)
    if (points.length) out[prop.key] = points
  }
  return out
}

const hasKeyframes = (kf) => Boolean(kf) && Object.keys(kf).length > 0

/**
 * 某一时刻的关键帧取值（**预览与导出共用的唯一插值口径**：线性、两端夹取）。
 *
 * 没有任何关键帧的属性回落到 fallback（也就是片段上的静态值）——
 * 所以"给位置打了两个关键帧"不会把缩放也顺带变成 0。
 */
function keyframeValue(kf, prop, t, fallback) {
  const points = kf && Array.isArray(kf[prop]) ? kf[prop] : null
  if (!points || !points.length) return num(fallback, 0)
  const time = Math.max(0, num(t))
  if (time <= points[0].t) return points[0].v
  const last = points[points.length - 1]
  if (time >= last.t) return last.v
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    if (time <= b.t) {
      const span = b.t - a.t
      const p = span <= 1e-6 ? 0 : (time - a.t) / span
      return round4(num(a.v) + (num(b.v) - num(a.v)) * p)
    }
  }
  return last.v
}

module.exports = {
  REF_WIDTH,
  RADIUS_MAX,
  SKEW_LIMIT,
  KEY_PRESETS,
  DEFAULT_KEY_COLOR,
  MASK_SHAPES,
  MASK_FEATHER_MAX,
  STROKE_MAX,
  SHADOW_MAX_OFFSET,
  SHADOW_MAX_BLUR,
  BLEND_MODES,
  KEYFRAME_PROPS,
  readEffects,
  isNeutralEffects,
  hasClip,
  hasFilterFx,
  ratioOf,
  readHexColor,
  hexOf,
  isHexColor,
  cssRadius,
  radiusPx,
  cssSkew,
  shearFor,
  keyColor,
  keyAlphaRow,
  colorkeyFor,
  maskBoxPercent,
  cssMaskFor,
  maskShapeOf,
  maskExprFor,
  blendModeOf,
  blendCss,
  blendFfmpeg,
  strokePx,
  strokeDilations,
  strokeLut,
  strokeShadows,
  shadowFilter,
  shadowSigma,
  shadowOffset,
  readKeyframes,
  hasKeyframes,
  keyframeValue
}
