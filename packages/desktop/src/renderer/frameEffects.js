/**
 * 画面特效 —— 渲染层侧。
 *
 * 数据来自 shared/frameEffects.json（唯一真源）。本文件把 kind 翻译成
 * **动画挂在哪**，并给出时长。@keyframes 本身写在 styles.css 里。
 *
 * 为什么要分 kind 而不是一律挂在画面上：
 *   transform 是**改画面本身**（位移/缩放），挂在 .canvas-frame 上才会连素材一起动；
 *   overlay 是**叠在画面上的图层**（闪光/故障/扫描线/漏光/暗角），必须挂在一个独立的
 *   覆盖元素上 —— 挂在 .canvas-frame 上会连它的圆角与外阴影一起动，看起来像整个播放器在抖。
 *   这是「写对了但效果不对」的那一类，光看代码看不出来，所以用数据字段显式表达。
 *
 * ⚠️ 这张表**刻意没有 filter 类**，原因写在 frameEffects.json 的 $comment 里（与调色抢 filter，
 *    且动画优先级高于内联样式 ⇒ 会静默顶掉调色）。isFrameLevelEffect 只认 transform，
 *    闸门 check-frame-effects 会从源码侧再钉一遍，防止有人后来加了 filter 类。
 */
import table from '../shared/frameEffects.json' with { type: 'json' }

export const FRAME_EFFECTS = table.effects
const BY_KEY = Object.fromEntries(FRAME_EFFECTS.map((item) => [item.key, item]))

export const FRAME_EFFECT_KEYS = FRAME_EFFECTS.map((item) => item.key)

export const frameEffectDef = (key) => BY_KEY[key] || BY_KEY[table.fallback] || FRAME_EFFECTS[0]

export const isNoopFrameEffect = (key) => frameEffectDef(key).kind === 'none'

/** 只作用于画面本身的特效（transform）—— 挂 .canvas-frame */
export const isFrameLevelEffect = (key) => frameEffectDef(key).kind === 'transform'

/** 覆盖层特效 —— 挂 .canvas-fx */
export const isOverlayEffect = (key) => frameEffectDef(key).kind === 'overlay'

/**
 * 画面本身的类名。空串表示"不用加类"（无特效，或这是覆盖层特效）。
 * 返回空串而不是 null，是为了让调用方能直接拼模板字符串。
 * 注意 key 自己已经带 `fx-` 前缀，这里**不再拼前缀**（拼了会变成 fx-fx-shake）。
 */
export function frameEffectClass(key) {
  return isFrameLevelEffect(key) && !isNoopFrameEffect(key) ? frameEffectDef(key).key : ''
}

/** 覆盖层的类名。同上，不重复拼前缀。 */
export function overlayEffectClass(key) {
  return isOverlayEffect(key) ? frameEffectDef(key).key : ''
}

/** 动画时长（毫秒 → CSS 值）。无特效给空串。 */
export function frameEffectDuration(key) {
  const def = frameEffectDef(key)
  if (def.kind === 'none') return ''
  const ms = Number(def.durationMs)
  return Number.isFinite(ms) && ms > 0 ? `${ms}ms` : ''
}
