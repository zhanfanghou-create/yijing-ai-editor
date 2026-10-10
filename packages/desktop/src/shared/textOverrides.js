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
  if (ANCHORS.includes(src.textAnchor)) out.anchor = src.textAnchor

  const offset = num(src.textOffset, NaN)
  if (Number.isFinite(offset)) out.offset = clamp(offset, 0, TEXT_OFFSET_MAX)

  return out
}

/** 片段上有没有任何一项覆写（面板据此显示「恢复默认」与角标） */
function hasTextOverrides(clip) {
  const src = clip || {}
  if (Math.abs(num(src.textScale, 1) - 1) > 0.001) return true
  if (isHexColor(src.textColor)) return true
  if (ANCHORS.includes(src.textAnchor)) return true
  if (Number.isFinite(num(src.textOffset, NaN))) return true
  return false
}

/** 片段覆写 → patch（「恢复默认」用；值给 null 让 JSON 里干净落成 null） */
const resetTextOverrides = () => ({ textScale: 1, textColor: '', textAnchor: '', textOffset: null })

module.exports = {
  STYLES,
  TEXT_SCALE_MIN,
  TEXT_SCALE_MAX,
  TEXT_OFFSET_MAX,
  ANCHORS,
  isHexColor,
  applyTextOverrides,
  hasTextOverrides,
  resetTextOverrides
}
