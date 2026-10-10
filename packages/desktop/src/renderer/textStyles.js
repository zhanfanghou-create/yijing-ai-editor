/**
 * 字幕 / 文字样式 —— 渲染层侧。
 *
 * 数据来自 shared/textStyles.json（唯一真源）。本文件只做一件事：
 * 把样式参数翻译成**能在浏览器里真的画出效果的 CSS**，
 * 让「点了样式卡」这件事在预览画面上当场看得见，而不是只弹一个 toast。
 *
 * 两个渲染面共用同一个函数，只是「虚拟画幅」不同：
 *   · 预览区叠加层  baseWidth = 1280（样式表就是这么定的）
 *   · 侧栏样式卡片  baseWidth = CARD_BASE_WIDTH（样式在卡片上是放大看的，
 *                   参考的卡片也是"样式缩略图"而不是等比缩小的一帧画面）
 *
 * ⚠️ 单位全部用 cqw（容器宽度的百分比），不用 px：
 *   预览区会随窗口/全屏改变宽度、卡片固定宽但和真实画幅差 8 倍，
 *   写死 px 就一定有一边是错的。cqw 让同一组数字在两边都成立，
 *   而且**不需要测量**——没有 ResizeObserver、没有 resize 抖动、没有"首帧错位"。
 *   容器侧的要求：承载元素必须带 `container-type: size`
 *   （预览是 .canvas-frame，卡片是 .style-art，见 styles.css / workbench.css）。
 */
import table from '../shared/textStyles.json' with { type: 'json' }
import { applyTextOverrides } from '../shared/textOverrides.js'

export const TEXT_STYLES = table.styles
export const STYLE_BASE_WIDTH = Number(table.baseWidth) || 1280
/** 卡片预览的虚拟画幅：样式在卡片上是"放大展示"，不是等比缩到 1/8 */
export const CARD_BASE_WIDTH = 480

const BY_KEY = Object.fromEntries(TEXT_STYLES.map((item) => [item.key, item]))

export const TEXT_STYLE_KEYS = TEXT_STYLES.map((item) => item.key)

/** 样式表里没有的一律退回 fallback 项（不是退化成"没样式"） */
export const textStyleDef = (key) => BY_KEY[key] || BY_KEY[table.fallback] || TEXT_STYLES[0]

export const subtitleStyles = () => TEXT_STYLES.filter((item) => item.usage === 'subtitle')
export const titleStyles = () => TEXT_STYLES.filter((item) => item.usage === 'title')

/**
 * 「文字 → 花字」页的分组（参考实拍：热门 / 基础 / 纹理 / 发光 / 黄色 / 蓝色 / 红色 / 绿色）。
 *
 * ⚠️ 顺序与 `AssetTree.jsx` 的 TEXT_ART_CHILDREN **一一对应**（下标就是组号）——
 * 两边都是字面量数组，改一边忘一边不会报错，只会让"点第 5 组看到第 6 组的内容"，
 * 所以由 tools/check-workbench-tree.mjs 的「分组数一致」那条钉住。
 *
 * 组里挑哪些样式靠 `pick`（按 key 前缀/特征筛），不手写 key 列表：
 * 手写列表的通病是新增样式后忘了补进组 ⇒ 那个样式在页面上永远不出现。
 */
export const TEXT_STYLE_GROUPS = [
  { label: '热门', pick: (s) => s.key.startsWith('art-') || ['sub-neon', 'title-gradient'].includes(s.key) },
  { label: '基础', pick: (s) => ['sub-plain', 'sub-bar', 'title-hero', 'title-band'].includes(s.key) },
  { label: '纹理', pick: (s) => ['title-gradient', 'sub-tag', 'sub-accent'].includes(s.key) },
  { label: '发光', pick: (s) => ['sub-neon', 'art-yellow-glow', 'art-blue-glow', 'art-red-glow', 'art-green-glow'].includes(s.key) },
  { label: '黄色', pick: (s) => s.key.startsWith('art-yellow') },
  { label: '蓝色', pick: (s) => s.key.startsWith('art-blue') },
  { label: '红色', pick: (s) => s.key.startsWith('art-red') },
  { label: '绿色', pick: (s) => s.key.startsWith('art-green') }
]

/** 取某一组的样式列表（组号越界返回空数组，不抛错） */
export const textStylesOfGroup = (index) => {
  const group = TEXT_STYLE_GROUPS[Number(index) || 0]
  if (!group) return []
  return TEXT_STYLES.filter((item) => group.pick(item))
}

/**
 * px(样式表) → cqw(容器宽度百分比)。
 * 100 是 cqw 的定义（1cqw = 容器宽的 1%），所以 px / baseWidth * 100。
 */
const q = (px, base) => `${(((Number(px) || 0) / base) * 100).toFixed(4)}cqw`

/**
 * 锚点 → 绝对定位的四边值。
 * offset 是「离所贴的那条边的距离」，用 justify/align 也能做，
 * 但字幕要的是**精确到边**（多条字幕叠加时不能互相挤），所以走绝对定位。
 */
function anchorToPosition(anchor, offset, base) {
  const d = q(offset, base)
  if (anchor === 'top') return { top: d, left: 0, right: 0 }
  if (anchor === 'center') return { top: 0, bottom: 0, left: 0, right: 0 }
  return { bottom: d, left: 0, right: 0 }
}

/**
 * 一个样式 → 两组内联样式：外框（box）与文字（text）。
 *
 * 拆成两个元素是必须的：外框管背景/圆角/内边距/定位，文字管描边/阴影/渐变填充。
 * 合成一个元素的话，`-webkit-text-stroke` 会把背景块一起描边，看起来像多了个框。
 *
 * @param {string} key 样式 key
 * @param {number} base 虚拟画幅宽度（预览 1280 / 卡片 480）
 * @param {object|null} clip 片段 —— 有它就叠上「字号 / 颜色 / 位置」的 Fragment 级覆写
 *   （见 shared/textOverrides.js；导出侧 main/subtitles.js 用的是同一个函数，
 *    所以"面板上调过的字幕"在预览与成片里长得一样）
 */
export function textStyleCss(key, base = STYLE_BASE_WIDTH, clip = null) {
  const def = applyTextOverrides(textStyleDef(key), clip)
  const title = def.usage === 'title'

  const box = {
    position: 'absolute',
    display: 'flex',
    justifyContent: title ? 'center' : 'center',
    alignItems: def.anchor === 'top' ? 'flex-start' : def.anchor === 'center' ? 'center' : 'flex-end',
    ...anchorToPosition(def.anchor, def.offset, base),
    pointerEvents: 'none'
  }

  const inner = {
    display: 'inline-block',
    maxWidth: '92%',
    fontFamily: 'inherit',
    fontSize: q(def.size, base),
    fontWeight: String(def.weight || 600),
    lineHeight: 1.22,
    textAlign: def.align || 'center',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  }

  /* 背景块：底栏、色块、胶囊标签这一类。没有 bg 的样式不带任何背景。 */
  if (def.bg) {
    inner.background = def.bg
    inner.borderRadius = q(def.radius || 0, base)
    inner.padding = `${q(def.padY || 0, base)} ${q(def.padX || 0, base)}`
  }

  if (def.tracking) inner.letterSpacing = q(def.tracking, base)

  /* 渐变填充：必须三件套一起给，少一件就退化成"看不见的字"（fill-color 透明 + 没背景裁切） */
  if (def.gradient && def.gradient.length >= 2) {
    inner.backgroundImage = `linear-gradient(92deg, ${def.gradient.join(', ')})`
    inner.WebkitBackgroundClip = 'text'
    inner.backgroundClip = 'text'
    inner.WebkitTextFillColor = 'transparent'
  } else if (def.hollow) {
    /* 空心字：填充透明、只留描边。不能只给 color: transparent —— 那连描边都没了 */
    inner.WebkitTextFillColor = 'transparent'
    inner.color = 'transparent'
  } else {
    inner.color = def.color || '#FFFFFF'
  }

  if (def.stroke) {
    inner.WebkitTextStrokeWidth = q(def.stroke, base)
    inner.WebkitTextStrokeColor = def.strokeColor || '#000000'
    /* 让描边画在填充**下面**，否则细笔画会被描边吃掉（"字变粗变糊"的常见原因） */
    inner.paintOrder = 'stroke fill'
  }

  if (def.shadow) inner.textShadow = def.shadow

  return { def, box, inner }
}

/**
 * 动画类名。动画本身写在 CSS 里（@keyframes），这里只负责"用哪一个"。
 * 之所以带上 usage，是因为标题的 pop 与字幕的 pop 幅度不同
 * （标题整句弹，字幕只轻微上浮），见 styles.css 的 .style-anim-* 分组。
 */
export const animClassOf = (def) => `style-anim-${def.anim || 'fade'}`

/** 卡片/叠加层都要用的短样本，长度刻意一致，避免长短不一造成的视觉误判 */
export const sampleFor = (def) => (def.usage === 'title' ? '标题样式' : '示例字幕')
