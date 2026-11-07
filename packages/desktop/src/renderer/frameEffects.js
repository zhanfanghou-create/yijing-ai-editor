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
import { fxFamily, fxCssVars, fxDurationMs } from '../shared/fxParams.js'

export const FRAME_EFFECTS = table.effects
const BY_KEY = Object.fromEntries(FRAME_EFFECTS.map((item) => [item.key, item]))

export const FRAME_EFFECT_KEYS = FRAME_EFFECTS.map((item) => item.key)

/**
 * 键 → 族定义。
 *
 * ⚠️ 必须按**族键**查，不能按完整键查：特效卡片的 `clip.frameFx` 是
 *    `fx-glow@2140` 这种带参数后缀的键（同一族最多 320 个组合），而
 *    frameEffects.json 里只有族本身。直接查完整键会一路落到 fallback，
 *    结果所有参数化过的卡片都变成"无特效"。
 */
export const frameEffectDef = (key) =>
  BY_KEY[fxFamily(key)] || BY_KEY[table.fallback] || FRAME_EFFECTS[0]

/**
 * 预览的内联 CSS 变量（`--fx-h` / `--fx-a` / …）。
 *
 * 为什么不给每个参数组合写一条 CSS 规则：267 个组合 × 13 个族 = 上千条样式，
 * 而且每加一档参数就要手写一次。走变量后 styles.css 里一族只有一条规则，
 * 参数由这里内联给 —— 与 `--fx-*` 的唯一真源（shared/fxParams.json）对齐。
 */
export const frameEffectStyle = (key) =>
  fxCssVars(key, frameEffectDef(key).durationMs)

export const isNoopFrameEffect = (key) => frameEffectDef(key).kind === 'none'

/** 只作用于画面本身的特效（transform）—— 挂 .canvas-frame */
export const isFrameLevelEffect = (key) => frameEffectDef(key).kind === 'transform'

/** 覆盖层特效 —— 挂 .canvas-fx */
export const isOverlayEffect = (key) => frameEffectDef(key).kind === 'overlay'

/**
 * 素材类特效 —— 也挂 .canvas-fx，但里面放的是一段**素材包里的逐帧序列**。
 *
 * 与 overlay 的区别只在"里面是什么"：overlay 的像素是 CSS 画的，pack 的像素来自
 * `resources/fxpacks/*.yjpack`。拆成两类是因为调用方要做的事完全不同 ——
 * overlay 只要一个类名（CSS 里有全部规则），pack 还要去解析雪碧图 URL 与帧率。
 */
export const isPackEffect = (key) => frameEffectDef(key).kind === 'pack'

/** 素材类特效在包里对应的 key（表里没写就用自己的 key，两者永远一致） */
export const packEffectId = (key) => {
  const def = frameEffectDef(key)
  return def.kind === 'pack' ? String(def.pack || def.key) : ''
}

/**
 * 整幅重映射类（目前只有鱼眼）。
 *
 * 它既不能走 transform（形变不是位移/缩放），也不能走 overlay（它不是"叠一层"，
 * 而是把**画面上的每个像素搬到别的位置**）。预览靠 SVG `feDisplacementMap` +
 * 一张位移贴图，导出靠 ffmpeg 的 `lenscorrection`。
 */
export const isWarpEffect = (key) => frameEffectDef(key).kind === 'warp'

/**
 * 画面本身的类名。空串表示"不用加类"（无特效，或这是覆盖层特效）。
 * 返回空串而不是 null，是为了让调用方能直接拼模板字符串。
 * 注意 key 自己已经带 `fx-` 前缀，这里**不再拼前缀**（拼了会变成 fx-fx-shake）。
 *
 * ⚠️ 返回的是**族键**，不是完整键：参数走内联变量，类名只表达"哪一种特效"。
 */
export function frameEffectClass(key) {
  return isFrameLevelEffect(key) && !isNoopFrameEffect(key) ? frameEffectDef(key).key : ''
}

/**
 * 覆盖层的类名。同上，不重复拼前缀。
 *
 * ⚠️ 素材类返回**两个**类：通用播放类 `fx-pack` + 自己的 key。
 *    前者提供雪碧图步进的通用规则（styles.css 里只有一条），后者让闸门与
 *    `data-fx` 能对得上、也给"这一层到底是哪个效果"留一个可查的抓手。
 * ⚠️ 参数化族返回族键（`def.key`），**不是**传入的 `key` —— 传进来的可能是
 *    `fx-glow@2140`，那不是合法 CSS 类名，写成类名等于这一层没有任何样式。
 */
export function overlayEffectClass(key) {
  const def = frameEffectDef(key)
  if (def.kind === 'overlay') return def.key
  if (def.kind === 'pack') return `fx-pack ${def.key}`
  return ''
}

/** 动画时长（毫秒 → CSS 值）。无特效给空串。参数里的 d 轴优先。 */
export function frameEffectDuration(key) {
  const def = frameEffectDef(key)
  if (def.kind === 'none') return ''
  const ms = fxDurationMs(key, def.durationMs)
  return Number.isFinite(ms) && ms > 0 ? `${ms}ms` : ''
}
