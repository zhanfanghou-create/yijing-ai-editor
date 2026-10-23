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

/**
 * 蒙版形状。
 *
 * `linear` / `mirror` 是**带方向的条带**：
 *   · linear —— 按 `axis` 决定横向还是纵向的一条带（位置与宽度可调）；
 *   · mirror —— 同一条带，但强制居中（左右/上下对称），x/y 不起作用。
 * 两者与 rect 走同一套解析式（布尔区间 + 羽化），所以预览的渐变与导出的
 * geq 表达式是同一个几何，不存在"预览软边、成片硬边"。
 */
const MASK_SHAPES = [
  { key: 'none', label: '无' },
  { key: 'rect', label: '矩形' },
  { key: 'circle', label: '圆形' },
  { key: 'ellipse', label: '椭圆' },
  { key: 'linear', label: '线性' },
  { key: 'mirror', label: '镜面' }
]

/** 条带类蒙版的朝向：横向（沿 X 取带）/ 纵向（沿 Y 取带） */
const MASK_AXES = [
  { key: 'x', label: '横向' },
  { key: 'y', label: '纵向' }
]

/** 镜像（左右 / 上下）。两轴可同时开，等价于旋转 180° */
const MIRROR_AXES = [
  { key: 'h', label: '左右' },
  { key: 'v', label: '上下' }
]
/** 蒙版羽化上限（基准 px） */
const MASK_FEATHER_MAX = 200

/** 描边 / 阴影 */
const STROKE_MAX = 40
const SHADOW_MAX_OFFSET = 200
const SHADOW_MAX_BLUR = 200
/** 内阴影的扩散上限（基准 px）。它与外阴影的 blur 不是一回事：spread 是"边缘内缩多少" */
const SHADOW_MAX_SPREAD = 200

/**
 * 描边样式。
 *
 * ⚠️ 这里**只收两端都能真做出来的**样式：
 *   · solid  —— 沿画面**轮廓**外扩一圈（预览 8 向 drop-shadow / 导出 dilation 环）；
 *   · double —— 沿轮廓两圈同心（宽的在外、窄的在内，两色可不同）；
 *   · glow   —— 沿轮廓的羽化光晕（导出是 dilation + 大 sigma 高斯）；
 *   · dashed —— **沿画框四边**的虚线框（不是沿轮廓）。
 *
 * 为什么虚线只能做矩形边框：沿"任意 alpha 轮廓"的虚线要求把轮廓描成路径再按
 * dash 切开 —— 视频里没有轮廓路径，只有逐像素 alpha。硬做出来的东西要么只在
 * 特定形状上对、要么在导出里根本不存在。所以这一种的定位如实写成"画框虚线边框"，
 * 界面上也这么叫，不冒充"沿轮廓的虚线描边"。
 */
const STROKE_STYLES = [
  { key: 'solid', label: '实线' },
  { key: 'double', label: '双线' },
  { key: 'glow', label: '发光' },
  { key: 'dashed', label: '虚线框' }
]

/** 虚线的段长 / 间隔上限（基准 px） */
const DASH_MAX = 120

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

/**
 * 自由变形（四角透视）住在 `effects.warp` 里，但**换算不在本文件** ——
 * 单应矩阵、CSS matrix3d、ffmpeg perspective 三段全在 `shared/warp.js`。
 * 这里只做一件事：把它读成规范化结构，并参与"这层到底中不中性"的判定。
 */
const warpTable = require('./warp.js')

/** 读一组效果参数：缺省 / 脏数据一律回落中性值，不抛错、不产生 NaN */
function readEffects(src) {
  const s = src && typeof src === 'object' ? src : {}
  const key = s.key && typeof s.key === 'object' ? s.key : {}
  const mask = s.mask && typeof s.mask === 'object' ? s.mask : {}
  const stroke = s.stroke && typeof s.stroke === 'object' ? s.stroke : {}
  const shadow = s.shadow && typeof s.shadow === 'object' ? s.shadow : {}
  const corners = s.corners && typeof s.corners === 'object' ? s.corners : {}
  const mirror = s.mirror && typeof s.mirror === 'object' ? s.mirror : {}
  const blendKey = String(s.blend || 'normal')
  return {
    radius: clamp(num(s.radius, 0), 0, RADIUS_MAX),
    /* 四角独立圆角：`on` 为真时**优先于** radius（radius 作为整体值留给旧草稿） */
    corners: {
      on: Boolean(corners.on),
      tl: clamp(num(corners.tl, 0), 0, RADIUS_MAX),
      tr: clamp(num(corners.tr, 0), 0, RADIUS_MAX),
      br: clamp(num(corners.br, 0), 0, RADIUS_MAX),
      bl: clamp(num(corners.bl, 0), 0, RADIUS_MAX)
    },
    mirror: {
      h: Boolean(mirror.h),
      v: Boolean(mirror.v)
    },
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
      axis: MASK_AXES.some((item) => item.key === mask.axis) ? mask.axis : 'x',
      x: clamp(num(mask.x, 50), -50, 150),
      y: clamp(num(mask.y, 50), -50, 150),
      w: clamp(num(mask.w, 60), 2, 200),
      h: clamp(num(mask.h, 60), 2, 200),
      feather: clamp(num(mask.feather, 0), 0, MASK_FEATHER_MAX)
    },
    stroke: {
      on: Boolean(stroke.on),
      width: clamp(num(stroke.width, 3), 0, STROKE_MAX),
      color: isHexColor(stroke.color) ? String(stroke.color) : '#ffffff',
      style: STROKE_STYLES.some((item) => item.key === stroke.style) ? stroke.style : 'solid',
      /* 双线的内圈颜色（只有 double 用得上，其余样式忽略） */
      color2: isHexColor(stroke.color2) ? String(stroke.color2) : '#000000',
      /* 虚线的段长与间隔（只有 dashed 用得上） */
      dash: clamp(num(stroke.dash, 18), 2, DASH_MAX),
      gap: clamp(num(stroke.gap, 12), 2, DASH_MAX)
    },
    shadow: {
      on: Boolean(shadow.on),
      /* 内阴影：阴影落在画面**里面**（沿轮廓向内散开）。与外阴影共用偏移/模糊/颜色，
         额外多一个 spread（边缘内缩的厚度）。两个可以同时开。 */
      inner: Boolean(shadow.inner),
      x: clamp(num(shadow.x, 8), -SHADOW_MAX_OFFSET, SHADOW_MAX_OFFSET),
      y: clamp(num(shadow.y, 8), -SHADOW_MAX_OFFSET, SHADOW_MAX_OFFSET),
      blur: clamp(num(shadow.blur, 12), 0, SHADOW_MAX_BLUR),
      spread: clamp(num(shadow.spread, 10), 0, SHADOW_MAX_SPREAD),
      color: isHexColor(shadow.color) ? String(shadow.color) : '#000000',
      opacity: clamp(num(shadow.opacity, 60), 0, 100)
    },
    /* 自由变形（四角透视）—— 换算全在 shared/warp.js，这里只做规范化 */
    warp: warpTable.readWarp(s.warp)
  }
}

/** 全部中性？（用来决定"这一层到底要不要多挂东西"） */
function isNeutralEffects(fx) {
  if (!fx) return true
  return (
    fx.radius < 0.01 &&
    !hasCorners(fx) &&
    !fx.mirror.h &&
    !fx.mirror.v &&
    Math.abs(fx.skewX) < 0.01 &&
    Math.abs(fx.skewY) < 0.01 &&
    fx.blend === 'normal' &&
    !fx.key.on &&
    fx.mask.shape === 'none' &&
    !fx.stroke.on &&
    !fx.shadow.on &&
    !hasWarp(fx)
  )
}

/** 四角圆角里有没有真的设了值（`on` 开着但四角全 0 = 等于没开） */
const hasCorners = (fx) =>
  Boolean(fx && fx.corners && fx.corners.on) &&
  [fx.corners.tl, fx.corners.tr, fx.corners.br, fx.corners.bl].some((value) => num(value) > 0.01)

/** 是否镜像（任一轴） */
const hasMirror = (fx) => Boolean(fx && (fx.mirror.h || fx.mirror.v))

/** 是否有"剪裁类"效果（圆角 / 四角圆角 / 蒙版）—— 预览据此决定要不要插一个遮罩盒 */
const hasClip = (fx) =>
  Boolean(fx) && (fx.radius >= 0.01 || hasCorners(fx) || (fx.mask && fx.mask.shape !== 'none'))

/** 是否有会在 filter 链上多加东西的效果（描边 / 阴影） */
const hasFilterFx = (fx) => Boolean(fx) && (fx.stroke.on || fx.shadow.on)

/** 是否开了自由变形（四角透视） */
const hasWarp = (fx) => Boolean(fx) && !warpTable.isNeutralWarp(fx.warp)

/**
 * 阴影是**外阴影**还是**内阴影**。
 *
 * ⚠️ `shadow.inner` 是**模式**而不是"叠加开关"：`on + inner` = 内阴影，
 *    `on` 单独 = 外阴影。早先的导出链一律按 `shadow.on` 判外阴影，
 *    于是"开了内阴影"会同时画出一道外阴影 —— 而且预览里看不出来
 *    （预览的内阴影是另一个叠加层，外阴影的 filter 也在），只有成片才知道。
 */
const hasOuterShadow = (fx) => Boolean(fx) && Boolean(fx.shadow && fx.shadow.on) && !(fx.shadow && fx.shadow.inner)
const hasInnerShadow = (fx) => Boolean(fx) && Boolean(fx.shadow && fx.shadow.on) && Boolean(fx.shadow && fx.shadow.inner)

/* ------------------------------- 圆角 ------------------------------- */

/** 圆角（预览）：`border-radius` 用 cqw，与导出按同一个比例。
 *  ⚠️ 四角独立时写四个值（顺序 = 左上 右上 右下 左下，与 CSS 一致）。 */
function cssRadius(fx) {
  if (!fx) return ''
  if (hasCorners(fx)) {
    const c = fx.corners
    const one = (v) => (num(v) > 0.01 ? `${(ratioOf(v) * 100).toFixed(4)}cqw` : '0')
    return `${one(c.tl)} ${one(c.tr)} ${one(c.br)} ${one(c.bl)}`
  }
  if (fx.radius < 0.01) return ''
  return `${(ratioOf(fx.radius) * 100).toFixed(4)}cqw`
}

/* ------------------------------- 镜像 ------------------------------- */

/**
 * 镜像（预览）→ `scaleX(-1)` / `scaleY(-1)`。
 * ⚠️ 导出侧是 `hflip` / `vflip`，两者都是"以元素中心为轴翻转"，
 *    所以这里不需要额外的 transform-origin（默认 center 正好对应）。
 */
function cssMirror(fx) {
  if (!fx || !fx.mirror) return ''
  const parts = []
  if (fx.mirror.h) parts.push('scaleX(-1)')
  if (fx.mirror.v) parts.push('scaleY(-1)')
  return parts.join(' ')
}

/** 镜像（导出）→ `hflip,vflip`（无镜像时返回 ''） */
function mirrorFilters(fx) {
  if (!fx || !fx.mirror) return ''
  const parts = []
  if (fx.mirror.h) parts.push('hflip')
  if (fx.mirror.v) parts.push('vflip')
  return parts.join(',')
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

  /* 条带（线性 / 镜面）：沿一个轴取带、另一轴铺满，与导出的布尔区间表达式同一几何 */
  if (m.shape === 'linear' || m.shape === 'mirror') {
    const axis = m.axis === 'y' ? 'y' : 'x'
    const center = m.shape === 'mirror' ? 50 : axis === 'x' ? m.x : m.y
    const span = axis === 'x' ? m.w : m.h
    const lo = center - span / 2
    const hi = center + span / 2
    const f = m.feather < 0.01 ? 0 : Math.min(45, (m.feather / Math.max(1, span)) * 100)
    const dir = axis === 'x' ? 'to right' : 'to bottom'
    return {
      maskImage: `linear-gradient(${dir}, transparent ${pct(lo)}, #000 ${pct(lo + f)}, #000 ${pct(hi - f)}, transparent ${pct(hi)})`,
      maskComposite: ''
    }
  }

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

  if (shape === 'rect' || shape === 'circle' || shape === 'ellipse' || shape === 'linear' || shape === 'mirror') {
    if (shape === 'linear' || shape === 'mirror') {
      /* 条带：中心沿 `axis` 取带，另一轴铺满。
         mirror 强制居中（对称），linear 用 x / y 自己定位置。 */
      const axis = m.axis === 'y' ? 'y' : 'x'
      const center = shape === 'mirror' ? 50 : axis === 'x' ? m.x : m.y
      const half = (axis === 'x' ? m.w : m.h) / 2
      const lo = center - half
      const hi = center + half
      terms.push(
        axis === 'x'
          ? `gte(X,${wx(lo / 100)})*lte(X,${wx(hi / 100)})`
          : `gte(Y,${hy(lo / 100)})*lte(Y,${hy(hi / 100)})`
      )
    } else if (shape === 'rect') {
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

  /**
   * 圆角。四角独立时**每个角用自己的半径**，合成方式是四个角的条件相乘：
   * 每个角都满足「不在这个角的方块里，或者离角心不超过半径」。
   *
   * ⚠️ geq 没有 `and/or`，比较结果就是 0/1，所以 OR 写成"相加再 >=1"。
   *    写成 `max()` 也能表达 OR（max 是"至少一个为真"），但 max 里再套 hypot 会让
   *    表达式长到难以核对；这里用加法，语义一眼可见。
   */
  if (hasCorners(fx)) {
    const c = fx.corners
    const cornerTerm = (rPx, dxExpr, dyExpr) => {
      if (rPx <= 0.01) return ''
      const r = `W*(${round4(rPx / REF_WIDTH)})`
      return `gte(gte(${dxExpr},${r})+gte(${dyExpr},${r})+lte(hypot(max(0,${r}-${dxExpr}),max(0,${r}-${dyExpr})),${r}),1)`
    }
    const tl = cornerTerm(c.tl, 'X', 'Y')
    const tr = cornerTerm(c.tr, '(W-1-X)', 'Y')
    const br = cornerTerm(c.br, '(W-1-X)', '(H-1-Y)')
    const bl = cornerTerm(c.bl, 'X', '(H-1-Y)')
    const all = [tl, tr, br, bl].filter(Boolean)
    if (all.length) terms.push(all.join('*'))
  } else if (rFrac > 0) {
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

/** 当前描边样式（缺省 solid —— 老草稿不带这个字段） */
const strokeStyleOf = (fx) => (fx && fx.stroke && fx.stroke.style ? fx.stroke.style : 'solid')

/** 是不是"画框虚线框"（它不走轮廓那一套，预览与导出各自走另一条路） */
const strokeIsDashed = (fx) => Boolean(fx && fx.stroke.on) && strokeStyleOf(fx) === 'dashed'

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
function strokeLut(fx, round = round4, which = 'color') {
  if (!fx || !fx.stroke.on) return ''
  const c = readHexColor(which === 'color2' ? fx.stroke.color2 : fx.stroke.color, '#ffffff')
  return `r=${round(c.r, 4)}:g=${round(c.g, 4)}:b=${round(c.b, 4)}`
}

/**
 * 描边（导出）→ **一层层的环**，底 → 顶。
 *
 * 每种样式都由"膨胀几像素 + 什么颜色 + 要不要模糊"这三件事拼出来：
 *   · solid  —— 一圈；
 *   · double —— 两圈：宽的在外（color）、窄的在内（color2）；
 *   · glow   —— 一圈 + 大 sigma 模糊（光晕）；
 *   · dashed —— 空数组，走 `dashedBoxExpr` 那条独立的路（画框虚线框）。
 *
 * ⚠️ 顺序是有意义的：宽环必须先 overlay（垫在底下），窄环后 overlay（盖在上面）。
 *    反过来的话窄环会被宽环整个吃掉 —— 屏幕上只剩一圈，而且颜色是宽环那个。
 */
function strokeLayers(fx, width) {
  if (!fx || !fx.stroke.on) return []
  if (strokeIsDashed(fx)) return []
  const style = strokeStyleOf(fx)
  const wide = strokeDilations(fx, width)
  if (wide <= 0) return []
  if (style === 'double') {
    /* 内圈至少留 1 级，否则"双线"会退化成一根粗线（用户看不出选了 double） */
    const narrow = Math.max(1, Math.round(wide * 0.45))
    return [
      { dilations: wide, color: 'color', blur: 0 },
      { dilations: narrow, color: 'color2', blur: 0 }
    ]
  }
  if (style === 'glow') {
    const sigma = Math.max(0.6, round4(wide / 2))
    return [{ dilations: wide, color: 'color', blur: sigma }]
  }
  return [{ dilations: wide, color: 'color', blur: 0 }]
}

/**
 * 虚线框（预览）→ 叠加层的四条边（`repeating-linear-gradient`）。
 *
 * 只在**画框四边**画，不沿 alpha 轮廓（理由见 STROKE_STYLES 的说明）。
 * 用 `cqw` 让线宽随画框缩放，与导出按同一个比例。
 *
 * ⚠️ 为什么不用 `border: … dashed`：CSS 虚线的段长/间隔由**浏览器**决定
 *    （Chrome 是"3 倍线宽实、3 倍线宽虚"，Chrome 之外又不一样），
 *    而导出是按用户设的 dash / gap 精确取模画出来的 —— 两者必然对不上，
 *    表现为"预览里是密密的短划线，成片里是长划线"。这里用四条
 *    `repeating-linear-gradient` 把段长与间隔**显式写成 cqw**，
 *    与导出同一个几何，用户设多少就是多少。
 *
 * 单位说明：两个方向都用 `cqw`（画框宽度的 1%），与导出的像素算法同源
 * （导出那边也是 `ratio × 画框宽`）。
 */
function dashedBoxCss(fx) {
  if (!strokeIsDashed(fx) || fx.stroke.width < 0.01) return null
  const w = Math.max(0.05, ratioOf(fx.stroke.width) * 100)
  const dash = Math.max(0.05, ratioOf(fx.stroke.dash) * 100)
  const gap = Math.max(0.05, ratioOf(fx.stroke.gap) * 100)
  const period = dash + gap
  const color = isHexColor(fx.stroke.color) ? fx.stroke.color : '#ffffff'
  const fix = (v) => v.toFixed(4)
  /** 一段"实 + 虚"的色标序列，横向/纵向由渐变方向决定 */
  const stops = `${color} 0 ${fix(dash)}cqw, rgba(0, 0, 0, 0) ${fix(dash)}cqw ${fix(period)}cqw`
  const style = {
    backgroundImage: [
      `repeating-linear-gradient(90deg, ${stops})`,
      `repeating-linear-gradient(90deg, ${stops})`,
      `repeating-linear-gradient(180deg, ${stops})`,
      `repeating-linear-gradient(180deg, ${stops})`
    ].join(', '),
    /* 上、下边：整宽 × 线宽；左、右边：线宽 × 整高 */
    backgroundSize: [`100% ${fix(w)}cqw`, `100% ${fix(w)}cqw`, `${fix(w)}cqw 100%`, `${fix(w)}cqw 100%`].join(', '),
    backgroundPosition: 'left top, left bottom, left top, right top',
    backgroundRepeat: 'no-repeat'
  }
  return { style, width: w, dash, gap }
}

/**
 * 虚线框（导出）→ geq 的亮度表达式（生成一张遮罩 PNG，缓存复用）。
 *
 * 四条边各自判断：落在边带内 + 沿边方向的取模落在段内。
 * geq 里 `W`/`H` 是这一帧的宽高，`X`/`Y` 是当前像素坐标，全部是大写常量。
 *
 * @param {object} fx
 * @param {number} width 像素宽
 * @param {number} height 像素高
 * @param {(v:number,d?:number)=>number} round
 */
function dashedBoxExpr(fx, width, height, round = round4) {
  if (!strokeIsDashed(fx)) return ''
  const W = Math.max(2, Math.round(Number(width) || 0))
  const H = Math.max(2, Math.round(Number(height) || 0))
  const lw = Math.max(1, Math.min(Math.floor(Math.min(W, H) / 2), strokePx(fx, width)))
  /* 段长与间隔按**实际像素**取整：表达式里全是整数取模，避免浮点误差累积成"半段" */
  const dash = Math.max(2, Math.round((ratioOf(fx.stroke.dash) * W)))
  const gap = Math.max(1, Math.round((ratioOf(fx.stroke.gap) * W)))
  const period = dash + gap
  const inDashX = `lt(mod(X,${period}),${dash})`
  const inDashY = `lt(mod(Y,${period}),${dash})`
  /**
   * ⚠️ 这里的括号不能省：`onH` 是"两条边求和"，本身带 `+`。
   *    写成 `lt(Y,lw)+gte(Y,H-lw)*inDashX` 时，`*` 只绑定后一项 ——
   *    上边（`lt(Y,lw)`）就变成一个**永远成立**的条件，整条边恒亮，
   *    虚线框退化成实线框（还带一圈断续的右边）。表达式不报错、图也生成了，
   *    只有把生成的 PNG 逐像素取出来才看得见。
   */
  const onH = `(lt(Y,${lw})+gte(Y,${H - lw}))`
  const onV = `(lt(X,${lw})+gte(X,${W - lw}))`
  /* 上/下边按 X 取模，左/右边按 Y 取模 */
  const edge = `gt(${onH}*${inDashX}+${onV}*${inDashY},0)`
  return `if(${edge},255,0)`
}

/**
 * 描边（预览）→ 8 向 `drop-shadow`（按样式变形）。
 *
 * 为什么不用 SVG `feMorphology`：HTML 元素上的 SVG filter 用的是**元素自身的 CSS px**，
 * 而预览元素的尺寸随窗口变 —— 在参数层算不出该写多少 px 的膨胀半径，写死就会
 * "窗口一大描边就细得看不见"。`drop-shadow` 的长度可以写 `cqw`（画框宽度的 1%），
 * 与导出按同一个比例，窗口缩放自动等比。
 * 8 个方向叠加出来的外轮廓在圆角处比真正的形态学膨胀稍钝，属于可接受的手感差异。
 *
 * 各样式：
 *   · solid  —— 一圈 8 向，无模糊；
 *   · double —— **两圈**：先窄（color2）后宽（color）。
 *               ⚠️ 顺序必须是"窄的先写"：CSS 的 filter 是**串联**的，
 *               后一个 drop-shadow 作用在前一个的输出上 —— 宽的那个写在后面才会在外层。
 *               反过来的话宽圈把窄圈整个盖住，屏幕上只剩一圈。
 *   · glow   —— 一圈 8 向 + 模糊（模糊半径 = 线宽，视觉上就是"向外散开的光"）；
 *   · dashed —— 空串：虚线框不是轮廓，走 `dashedBoxCss` 那条叠加层的路。
 */
function strokeShadows(fx) {
  if (!fx || !fx.stroke.on || fx.stroke.width < 0.01) return ''
  if (strokeIsDashed(fx)) return ''
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
  const ring = (rPct, color, blurPct = 0) =>
    dirs
      .map(
        ([dx, dy]) =>
          `drop-shadow(${(dx * rPct).toFixed(4)}cqw ${(dy * rPct).toFixed(4)}cqw ${blurPct.toFixed(4)}cqw ${color})`
      )
      .join(' ')
  const style = strokeStyleOf(fx)
  const wide = ratioOf(fx.stroke.width) * 100
  if (style === 'double') {
    const narrow = Math.max(0.01, wide * 0.45)
    return `${ring(narrow, fx.stroke.color2)} ${ring(wide, fx.stroke.color)}`
  }
  if (style === 'glow') return ring(wide, fx.stroke.color, wide)
  return ring(wide, fx.stroke.color)
}

/* ------------------------------- 阴影 ------------------------------- */

/**
 * 阴影（预览）→ `drop-shadow(x y blur color)`。
 * CSS 的 blur 半径与 ffmpeg `gblur` 的 sigma 不是同一个量纲（CSS 的半径 ≈ 2σ），
 * 所以导出侧用 `sigma = blur / 2` —— 同一个观感、不同的换算，见 shadowSigma。
 */
function shadowFilter(fx) {
  if (!hasOuterShadow(fx)) return ''
  const s = fx.shadow
  const c = readHexColor(s.color, '#000000')
  const dx = (ratioOf(s.x) * 100).toFixed(4)
  const dy = (ratioOf(s.y) * 100).toFixed(4)
  const blur = (ratioOf(s.blur) * 100).toFixed(4)
  return `drop-shadow(${dx}cqw ${dy}cqw ${blur}cqw rgba(${c.r}, ${c.g}, ${c.b}, ${round4(s.opacity / 100)}))`
}

/** 阴影（导出）→ gblur 的 sigma（= 预览 blur 半径的一半，见上） */
const shadowSigma = (fx, width) => {
  if (!hasOuterShadow(fx)) return 0
  const px = ratioOf(fx.shadow.blur) * (Number(width) > 0 ? Number(width) : REF_WIDTH)
  return Math.max(0, Math.min(200, round4(px / 2)))
}

/** 阴影（导出）→ 偏移像素 */
const shadowOffset = (fx, width) => {
  const w = Number(width) > 0 ? Number(width) : REF_WIDTH
  if (!hasOuterShadow(fx)) return { x: 0, y: 0 }
  return { x: Math.round(ratioOf(fx.shadow.x) * w), y: Math.round(ratioOf(fx.shadow.y) * w) }
}

/* ------------------------------ 内阴影 ------------------------------ */

/**
 * 内阴影（预览）→ `box-shadow: inset ...`。
 *
 * 为什么不挂在媒体元素上：`inset` 阴影画在**背景之上、内容之下**，
 * 而媒体元素的内容就是那一帧画面 —— 阴影会被画面整个盖住，一像素都看不见。
 * 所以它是**叠在画面上方的一个透明层**（见 Stage.jsx 的 `.canvas-inset`），
 * 这一层只负责阴影本身，不参与任何其它效果。
 *
 * 单位与其它效果一致：`cqw`（画框宽度的 1%），窗口缩放自动等比。
 * 圆角会跟着 `border-radius` 走；**蒙版形状（椭圆等）跟不了** ——
 * 这是 CSS box-shadow 的固有边界，界面上如实写在提示里。
 */
function innerShadowStyle(fx) {
  if (!hasInnerShadow(fx)) return ''
  const s = fx.shadow
  const c = readHexColor(s.color, '#000000')
  const unit = (v) => `${(ratioOf(v) * 100).toFixed(4)}cqw`
  return `inset ${unit(s.x)} ${unit(s.y)} ${unit(s.blur)} ${unit(s.spread)} rgba(${c.r}, ${c.g}, ${c.b}, ${round4(s.opacity / 100)})`
}

/**
 * 内阴影 → 生成"距离场 PNG"所需的全部参数（像素口径）。
 *
 * 这张图是**纯距离场 + 已算好的落差曲线**：沿画框四边的一条带子，越靠边越浓。
 * 它是常量（与素材内容无关），所以按尺寸+参数缓存一次就够。
 *
 * @returns {null|{width:number,height:number,spreadPx:number,blurPx:number,dx:number,dy:number,opacity:number}}
 */
function innerShadowSpec(fx, width, height) {
  if (!hasInnerShadow(fx)) return null
  const w = Math.max(4, Math.round(Number(width) > 0 ? Number(width) : REF_WIDTH))
  const h = Math.max(4, Math.round(Number(height) > 0 ? Number(height) : (w * 9) / 16))
  return {
    width: w,
    height: h,
    /* 带子厚度：至少要 1px，否则 geq 里会出现除零 */
    spreadPx: Math.max(1, Math.round(ratioOf(fx.shadow.spread) * w)),
    /* 落差带宽度：CSS 的 blur 半径 ≈ 可见过渡带的宽度（不折成 sigma，
       因为这里不再走 gblur，直接在表达式里把落差算准） */
    blurPx: Math.min(200, Math.round(ratioOf(fx.shadow.blur) * w)),
    dx: Math.round(ratioOf(fx.shadow.x) * w),
    dy: Math.round(ratioOf(fx.shadow.y) * w),
    opacity: round4(clamp(num(fx.shadow.opacity, 60), 0, 100) / 100)
  }
}

/** 内阴影距离场的 geq 亮度表达式（render.js 用它落 PNG） */
function innerShadowExpr(spec) {
  if (!spec) return ''
  const { width: W, height: H, spreadPx: S, blurPx: B, dx: DX, dy: DY, opacity: OP } = spec
  /* 到"偏移后的四条边"的距离，四个方向各自夹到非负 —— 夹这一步是为了让
     "偏移量大于半幅"这种极端值退化成"整条边都厚"，而不是算出负距离后全图变黑。 */
  const d = `min(min(max(0,X+${DX}),max(0,${W - 1}-X-${DX})),min(max(0,Y+${DY}),max(0,${H - 1}-Y-${DY})))`
  /**
   * 落差曲线：`spread` 以内全浓，`spread` 之后再用 `blur` 宽的平滑带降到 0。
   * 这就是 CSS `box-shadow: inset` 的语义（实心 spread + 高斯模糊边缘），
   * 只是把模糊直接算进距离场，链上不再做 `gblur`。
   *
   * ⚠️ 为什么不用"线性渐变 + gblur"：实测 20px 的带子配 sigma=12.8 的模糊，
   *    角上最浓处只剩 3/255 —— 平均把强度整个冲没了，看起来像"内阴影没生效"。
   *    落差曲线直接烘在 PNG 里，强度与厚度都可预期，也不会因为改了画布尺寸而变淡。
   */
  const A = round4(Math.max(0, S - B / 2))
  const span = round4(Math.max(1, B))
  const t = `min(1,max(0,(${d}-${A})/${span}))`
  return `${OP}*255*(1-${t}*${t}*(3-2*${t}))`
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
  MASK_AXES,
  MIRROR_AXES,
  MASK_FEATHER_MAX,
  STROKE_MAX,
  STROKE_STYLES,
  DASH_MAX,
  SHADOW_MAX_OFFSET,
  SHADOW_MAX_BLUR,
  SHADOW_MAX_SPREAD,
  BLEND_MODES,
  KEYFRAME_PROPS,
  readEffects,
  isNeutralEffects,
  hasClip,
  hasCorners,
  hasMirror,
  hasFilterFx,
  hasWarp,
  hasOuterShadow,
  hasInnerShadow,
  warpTable,
  ratioOf,
  readHexColor,
  hexOf,
  isHexColor,
  cssRadius,
  cssMirror,
  mirrorFilters,
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
  strokeStyleOf,
  strokeIsDashed,
  strokeDilations,
  strokeLut,
  strokeLayers,
  strokeShadows,
  dashedBoxCss,
  dashedBoxExpr,
  shadowFilter,
  shadowSigma,
  shadowOffset,
  innerShadowStyle,
  innerShadowSpec,
  innerShadowExpr,
  readKeyframes,
  hasKeyframes,
  keyframeValue
}
