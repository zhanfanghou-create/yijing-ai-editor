'use strict'
/**
 * 画面特效的参数解码 —— 预览（CSS 变量）、导出（ffmpeg）、缩略图（Pillow）三处同源。
 *
 * 背景：特效页 343 张卡 / 去重名字 267 个，此前只落在 24 个效果键上（fx-glow 一个键
 * 就占了 83 张卡）。点 20 张名字不同的卡出来是同一个效果，而所有静态判据都是绿的 ——
 * 「一卡一键」在这里失效了，因为**键少、名字多**。
 *
 * 做法与滤镜页同一套：键 = `族键[@参数串]`，参数串每轴一位 base36，轴表在
 * `shared/fxParams.json`（唯一真源，Python 生成器读同一份文件）。
 *
 * 三处消费者各取所需，但**取的是同一组数字**：
 *   · 预览：`fxCssVars()` → 内联 `--fx-*` 变量，styles.css 里一族只用一条规则；
 *   · 导出：`fxParamsOf()` → main/looks.js 的 frameFxFilterFor 拼 ffmpeg 参数；
 *   · 缩略图：tools/gen-material-thumbs.py 读同一个 json 自己解一遍 base36。
 *
 * ⚠️ 键里的 `@` **不是** CSS 类名的一部分。类名只表达"哪一种特效"（族键），
 *    参数走内联变量。所以 overlayEffectClass() 必须返回族键，不能返回完整键 ——
 *    否则 `fx-glow@2140` 会被当成一个不存在的类，样式全丢，画面变成"加了特效但没变化"。
 */

const table = require('./fxParams.json')

const AXES = table.families
const DEFAULTS = table.defaults

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 族键（`fx-glow@2140` → `fx-glow`）。任何地方要用 CSS 类名都走它。 */
function fxFamily(key) {
  const s = typeof key === 'string' ? key : ''
  const at = s.indexOf('@')
  return at < 0 ? s : s.slice(0, at)
}

/** 参数串（没有 `@` 时给空串 = 全默认档） */
function fxCode(key) {
  const s = typeof key === 'string' ? key : ''
  const at = s.indexOf('@')
  return at < 0 ? '' : s.slice(at + 1)
}

/** 该族是否支持参数（不在表里的族一律视为不支持，按默认档返回） */
function fxHasAxes(family) {
  return Object.prototype.hasOwnProperty.call(AXES, family)
}

/** 某族的一轴档数（族不存在给 1，便于容量计算） */
function fxAxisLen(family, axisKey) {
  const def = AXES[family]
  if (!def) return 1
  const axis = def.axes.find((a) => a.k === axisKey)
  return axis ? axis.values.length : 1
}

/** 该族的参数组合总数（未登记的族 = 1） */
function fxCapacity(family) {
  const def = AXES[family]
  if (!def) return 1
  return def.axes.reduce((n, axis) => n * axis.values.length, 1)
}

/**
 * 键 → 完整参数对象。
 *
 * 族的默认档 = **每个轴的第一档**（也就是全 0 键的外观），不是全局 defaults ——
 * 因为同一字母在不同族里量纲不同（pulse 的 t 是缩放倍率 1.02，fire 的 t 是提亮 0.07）。
 * 用一张全局默认表去补，会得到 `scale(0.5)` 这种把画面缩掉一半的错值。
 * 全局 defaults 只服务于「族表里根本没有这个族」的情况（比如 pack 类）。
 *
 * 越界的档索引夹到最大档而不是丢弃 —— 后者会让一个手改坏的键变成"无参数"，
 * 也就是悄悄退回默认外观（正是我们要消灭的静默）。
 */
function fxParamsOf(key) {
  const family = fxFamily(key)
  const code = fxCode(key)
  const def = AXES[family]
  if (!def) return { ...DEFAULTS }
  const out = { ...DEFAULTS }
  def.axes.forEach((axis, i) => {
    const ch = code[i] || '0'
    const idx = B36.indexOf(ch.toLowerCase())
    const last = axis.values.length - 1
    const safe = idx < 0 ? 0 : Math.min(idx, last)
    out[axis.k] = axis.values[safe]
  })
  return out
}

/** 键 → 每个轴的档位索引（闸门 / 生成器读它，避免重复解 base36） */
function fxIndicesOf(key) {
  const def = AXES[fxFamily(key)]
  if (!def) return []
  const code = fxCode(key)
  return def.axes.map((axis, i) => {
    const idx = B36.indexOf((code[i] || '0').toLowerCase())
    const last = axis.values.length - 1
    return idx < 0 ? 0 : Math.min(idx, last)
  })
}

/** 档位索引 → 键（生成器与闸门用它构造键，保证与 fxParamsOf 走同一套编码） */
function fxKeyOf(family, indices) {
  const def = AXES[family]
  if (!def) return family
  const code = indices
    .map((n, i) => {
      const len = def.axes[i] ? def.axes[i].values.length : 1
      const v = Math.max(0, Math.min(len - 1, Number(n) || 0))
      return B36[v]
    })
    .join('')
  /* 全 0 档就是族键本身 —— 老草稿里的 `fx-glow` 因此天然等于「默认档」，不用迁移 */
  return /^0*$/.test(code) ? family : `${family}@${code}`
}

/** 该族所有参数组合（生成器用；容量大时会很大，只在离线脚本里调） */
function fxCombos(family) {
  const def = AXES[family]
  if (!def) return [family]
  const out = []
  const walk = (i, acc) => {
    if (i === def.axes.length) {
      out.push(fxKeyOf(family, acc))
      return
    }
    for (let n = 0; n < def.axes[i].values.length; n += 1) walk(i + 1, acc.concat(n))
  }
  walk(0, [])
  return out
}

/**
 * 预览用的内联 CSS 变量。
 *
 * 变量**带单位**，这样 styles.css 里可以 `calc()` 与直接替换混用：
 *   `--fx-r: 48%` / `--fx-b: 6px` / `--fx-d: 1200ms`。
 * 全族都补齐（哪怕这族用不到），一是让 `var()` 的兜底值永不生效（少一处静默），
 * 二是让"某族忘了给变量"表现为肉眼可见的错值而不是上一档残留。
 *
 * @param {string} key        特效键（可带 `@参数串`）
 * @param {number} fallbackMs 族表里的 durationMs —— 只有族**没有** d 轴时才用它，
 *                            否则 fx-flash 的 900ms 会被全局默认 1200ms 顶掉。
 */
function fxCssVars(key, fallbackMs) {
  const p = fxParamsOf(key)
  return {
    '--fx-h': String(Math.round(p.h)),
    '--fx-a': String(p.a),
    '--fx-r': `${Math.round(p.r * 100)}%`,
    '--fx-x': `${Math.round(p.x)}%`,
    '--fx-y': `${Math.round(p.y)}%`,
    '--fx-b': `${p.b}px`,
    '--fx-n': String(p.n),
    '--fx-s': String(p.s),
    '--fx-t': String(p.t),
    /* 几何角度：只有需要"方向"的族（冷雾的斜向）读它，其它族给了也不影响 */
    '--fx-deg': `${Math.round(Number(p.t) || 0)}deg`,
    '--fx-d': `${Math.round(fxDurationMs(key, fallbackMs))}ms`
  }
}

/**
 * 动画时长（毫秒）。
 *
 * 优先级：族有 d 轴 → 轴值；否则用族表的 durationMs；再否则全局默认。
 * 顺序不能反：fx-flash 没有 d 轴（闪光节奏由 keyframes 决定），若先取 p.d
 * 就会拿到全局默认 1200ms，把它原本的 900ms 悄悄改掉。
 */
function fxDurationMs(key, fallbackMs) {
  const def = AXES[fxFamily(key)]
  if (def && def.axes.some((a) => a.k === 'd')) return Number(fxParamsOf(key).d)
  const fb = Number(fallbackMs)
  return Number.isFinite(fb) && fb > 0 ? fb : Number(DEFAULTS.d)
}

module.exports = {
  AXES,
  DEFAULTS,
  fxFamily,
  fxCode,
  fxHasAxes,
  fxAxisLen,
  fxCapacity,
  fxParamsOf,
  fxIndicesOf,
  fxKeyOf,
  fxCombos,
  fxCssVars,
  fxDurationMs
}
