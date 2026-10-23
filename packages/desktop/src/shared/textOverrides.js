'use strict'
/**
 * 字幕/文字的「片段级覆写」（真源唯一）。
 *
 * 左侧素材库选中一个样式 = 选**基线**（shared/textStyles.json 里那一项）；
 * 右侧检查器再调 字号 / 颜色 / 位置 = 在这条片段上**覆写**基线。
 *
 * 为什么必须共用一份：
 *   预览走 renderer/textStyles.js（产 CSS），导出走 main/subtitles.js（产 drawtext），
 *   两边都要做同一件事 —— 「字号乘以倍数 / 颜色换掉 / 锚点换掉」。
 *   各写一遍的话，迟早有一边漏掉某一项，症状是"预览里字幕变红了、成片里还是白的"，
 *   全程不报错、静态扫描也看不见。
 *
 * CommonJS（与 shared/speed.js、shared/adjust.js 同一形制）。
 * ⚠️ 新增 shared 下的 CJS 模块必须同步加进 packages/desktop/vite.config.mjs 的
 *    `commonjsOptions.include`，否则渲染层 import 到的是空对象。
 */

const STYLES = require('./textStyles.json')

/** 字号倍数范围：0.4×（很小的角标）到 2.5×（整屏标题） */
const TEXT_SCALE_MIN = 0.4
const TEXT_SCALE_MAX = 2.5
/** 位置偏移范围（样式表的 1280 基准 px） */
const TEXT_OFFSET_MAX = 600

const ANCHORS = ['top', 'center', 'bottom']

/** 排版：水平对齐 */
const ALIGNS = ['left', 'center', 'right']
/** 行距倍数范围（1.0 = 紧贴，2.4 = 很松）。默认 1.22 与样式表一致 */
const LINE_MIN = 1
const LINE_MAX = 2.4
const LINE_DEFAULT = 1.22
/** 背景框：内边距范围（1280 基准 px） */
const BG_PAD_MAX = 48

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 形状必须是 #RRGGBB 才认，其余（空串 / 脏值）一律"不覆写" */
const isHexColor = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)

/**
 * 基线样式 + 片段覆写 → 这一条字幕**实际**生效的样式。
 *
 * @param {object} def shared/textStyles.json 里那一项（已经由 styleDef 兜过底）
 * @param {object} clip 片段
 * @returns {object} 新的定义对象（不改原表 —— 表是全局共享的，就地改会污染别的片段）
 */
function applyTextOverrides(def, clip) {
  const out = { ...(def || {}) }
  const src = clip || {}

  const scale = num(src.textScale, 1)
  if (Math.abs(scale - 1) > 0.001) {
    const base = num(out.size, 40)
    out.size = Number((base * clamp(scale, TEXT_SCALE_MIN, TEXT_SCALE_MAX)).toFixed(2))
  }

  if (isHexColor(src.textColor)) out.color = src.textColor

  /* 自定义字体：`textFont` 存的是 CSS 家族名（由渲染层注册进 document.fonts），
     `textFontPath` 是导出侧 drawtext 要的字体文件路径。
     ⚠️ 家族名只做**白名单式**校验（字母数字下划线连字符），不拼进 CSS 字符串以外的地方：
        从这里能钻进内联 style 的值，多一个引号就能把整条样式串断掉。 */
  if (typeof src.textFont === 'string' && /^[\w-]{1,64}$/.test(src.textFont)) {
    out.fontFamily = src.textFont
  }
  if (ANCHORS.includes(src.textAnchor)) out.anchor = src.textAnchor

  const offset = num(src.textOffset, NaN)
  if (Number.isFinite(offset)) out.offset = clamp(offset, 0, TEXT_OFFSET_MAX)

  /* 以下四项是「排版」：行距 / 对齐 / 背景框开关 / 背景色。
     ⚠️ 必须与导出侧逐项对应（subtitles.js 的 line_spacing / text_align / box / boxcolor），
        少一项就是"预览调了、成片没变"。 */

  const line = num(src.textLineHeight, LINE_DEFAULT)
  out.lineHeight = clamp(line, LINE_MIN, LINE_MAX)

  if (ALIGNS.includes(src.textAlign)) out.align = src.textAlign

  /* 背景框：三态 —— null/undefined = 跟随样式表；true = 强制开；false = 强制关。
     用 Boolean(src.textBgOn) 会把"没设过"当成关，直接把 sub-bar 这类自带底栏的样式
     的底给撤掉，看起来像样式坏了。 */
  if (src.textBgOn === true || src.textBgOn === false) {
    if (!src.textBgOn) {
      out.bg = ''
      out.radius = 0
      out.padX = 0
      out.padY = 0
    } else if (!out.bg) {
      /* 本来没有底色的样式，打开背景框时给一个能看见的默认值（纯黑 55%），
         否则"打开了背景框但是什么都看不见"，用户只能反复点同一个开关。 */
      out.bg = 'rgba(0, 0, 0, 0.55)'
    }
  }

  if (src.textBgOn === true) {
    if (isHexColor(src.textBgColor)) {
      const alpha = clamp(num(src.textBgOpacity, 55), 0, 100) / 100
      out.bg = `rgba(${parseInt(src.textBgColor.slice(1, 3), 16)}, ${parseInt(
        src.textBgColor.slice(3, 5),
        16
      )}, ${parseInt(src.textBgColor.slice(5, 7), 16)}, ${Number(alpha.toFixed(3))})`
    } else if (out.bg) {
      /* 只调了不透明度没调颜色：把不透明度贴到现有底色上（rgba 才认 alpha） */
      const alpha = clamp(num(src.textBgOpacity, 55), 0, 100) / 100
      if (/^rgba?\(/.test(out.bg)) {
        const nums = out.bg.replace(/^rgba?\(|\)$/g, '').split(',').map((x) => x.trim())
        out.bg = `rgba(${nums[0]}, ${nums[1]}, ${nums[2]}, ${Number(alpha.toFixed(3))})`
      } else if (/^#[0-9a-fA-F]{6}$/.test(out.bg)) {
        out.bg = `rgba(${parseInt(out.bg.slice(1, 3), 16)}, ${parseInt(out.bg.slice(3, 5), 16)}, ${parseInt(
          out.bg.slice(5, 7),
          16
        )}, ${Number(alpha.toFixed(3))})`
      }
    }
    const pad = num(src.textBgPad, NaN)
    /* 没调过内边距也要给一个默认值：否则 `textBgOn` 打开后 padX 是 0，
       导出成为 `boxborderw=0` —— 底色紧贴笔画，看起来像"描边突然变粗了"，
       而预览里 CSS 的 padding 也是 0，两边一致地难看。 */
    const use = Number.isFinite(pad) ? pad : out.padX || 18
    out.padX = clamp(use, 0, BG_PAD_MAX)
    out.padY = clamp(use * 0.45, 0, BG_PAD_MAX)
  }

  return out
}

/** 片段上有没有任何一项覆写（面板据此显示「恢复默认」与角标） */
function hasTextOverrides(clip) {
  const src = clip || {}
  if (Math.abs(num(src.textScale, 1) - 1) > 0.001) return true
  if (isHexColor(src.textColor)) return true
  if (ANCHORS.includes(src.textAnchor)) return true
  if (Number.isFinite(num(src.textOffset, NaN))) return true
  if (Math.abs(num(src.textLineHeight, 1.22) - 1.22) > 0.001) return true
  if (ALIGNS.includes(src.textAlign)) return true
  if (src.textBgOn === true || src.textBgOn === false) return true
  return false
}

/** 片段覆写 → patch（「恢复默认」用；值给 null 让 JSON 里干净落成 null） */
const resetTextOverrides = () => ({
  textScale: 1,
  textColor: '',
  textAnchor: '',
  textOffset: null,
  /* 排版三项：行距回到 1.22、对齐回到"跟样式表"、背景框回到"跟样式表"（null 不是 false） */
  textLineHeight: 1.22,
  textAlign: '',
  textBgOn: null,
  textBgColor: '',
  textBgOpacity: 55,
  textBgPad: null,
  /* 字体回到系统默认：家族名与文件路径要一起清，只清一个会留下"名字没了但文件还在"的半截状态 */
  textFont: '',
  textFontPath: ''
})

module.exports = {
  STYLES,
  TEXT_SCALE_MIN,
  TEXT_SCALE_MAX,
  TEXT_OFFSET_MAX,
  ANCHORS,
  ALIGNS,
  LINE_MIN,
  LINE_MAX,
  LINE_DEFAULT,
  BG_PAD_MAX,
  isHexColor,
  applyTextOverrides,
  hasTextOverrides,
  resetTextOverrides
}
