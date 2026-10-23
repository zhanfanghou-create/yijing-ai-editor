/**
 * 预览画质 / 代理文件 —— 规则真源。
 *
 * 为什么必须有一个独立模块：这里管的是**预览与成片的分叉点**。
 * 预览可能用一份低分辨率代理，**导出永远用原片**。这条一旦写错，
 * 症状是"导出的成片比预览糊"（或者反过来，代理没生效、预览还是卡），
 * 而两边分别看都"能播、能导出"，谁都不报错。
 *
 * 三档的语义（与界面上的文案一一对应）：
 *   full   —— 原片。最清楚，4K 素材拖动时会卡。
 *   smooth —— 720p 代理。剪辑手感与清晰度折中（默认给弱机器用）。
 *   fast   —— 540p 代理。最流畅，用来粗剪。
 *
 * ⚠️ 代理只影响**预览取哪个文件**，不动素材表里的 url、也不动片段上的 path：
 *    导出侧（main/render.js）读的是 `clip.path`，它压根不知道代理的存在。
 *    这是刻意的 —— "导出用原片"不靠某处判断，而是**结构上就没有代理的入口**。
 *
 * ⚠️ CJS：主进程生成代理要用，渲染层决定"要不要请求代理"也要用（同一份档位表）。
 */

/** 档位 → 代理高度（0 = 不做代理，直接用原片） */
const QUALITY_HEIGHTS = {
  full: 0,
  smooth: 720,
  fast: 540
}

/** 界面上的顺序（渲染层直接照着画，别各写一份） */
const QUALITY_ORDER = ['full', 'smooth', 'fast']

/** 档位的中文名（提示文案用，两处共用一份） */
const QUALITY_LABELS = {
  full: '完整',
  smooth: '流畅（720p 代理）',
  fast: '极速（540p 代理）'
}

/** 不认识的档位一律回落 full —— 宁可慢一点，也不要"神秘地变糊" */
function normalizeQuality(value) {
  const key = String(value || '')
  return QUALITY_HEIGHTS[key] !== undefined ? key : 'full'
}

/** 这个档位对应的代理高度（0 表示不用代理） */
function heightFor(value) {
  return QUALITY_HEIGHTS[normalizeQuality(value)]
}

/** 要不要走代理（渲染层拿它决定是否请求主进程） */
function needsProxy(value) {
  return heightFor(value) > 0
}

/**
 * 代理文件名：`<basename>-<hash>-<height>p.mp4`。
 *
 * 用**路径的哈希**而不是完整路径：Windows 路径能长到 200+ 字符，
 * 直接拼进文件名会撞 MAX_PATH（代理生成失败，报错却是 `Invalid argument`，
 * 指不到"名字太长"）。哈希用 djb2，够稳定也够短。
 */
function proxyName(filePath, height) {
  const text = String(filePath || '')
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  const base = text.split(/[\\/]/).pop() || 'media'
  const stem = base.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'media'
  return `${stem}-${hash.toString(36)}-${Math.round(Number(height) || 0)}p.mp4`
}

/**
 * 代理的缩放滤镜。
 *
 * `scale=-2:'min(ih,H)'`：
 *   · `-2` 让宽度按比例取偶数（2650 这种奇数宽会让 libx264 直接报错）；
 *   · `min(ih,H)` 保证**放大不做**：源本来就是 480p 时，"540p 代理"不该把它插值放大，
 *     那样只会更糊更慢，用户还以为开了画质增强。
 */
function scaleFilter(height) {
  const h = Math.max(2, Math.round(Number(height) || 0))
  return `scale=-2:'min(ih,${h})'`
}

module.exports = {
  QUALITY_HEIGHTS,
  QUALITY_ORDER,
  QUALITY_LABELS,
  normalizeQuality,
  heightFor,
  needsProxy,
  proxyName,
  scaleFilter
}
