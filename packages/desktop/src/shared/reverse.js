'use strict'
/**
 * 片段倒放（真源唯一）。
 *
 * 「倒放」在预览侧与导出侧的实现方式**完全不是一回事**，所以最容易分叉：
 *   · 导出：ffmpeg 直接把帧序列反着吐（`reverse` / `areverse`），片段内容天然倒序；
 *   · 预览：`<video>` 的 `playbackRate` **不接受负数**（负值会被规范静默忽略成 1），
 *          所以不可能靠"倒着播"实现，只能把**源时间映射**反过来 ——
 *          播放头往前走，取的源帧往回退。
 *
 * 如果只做了导出那半边，症状是：面板上「倒放」点亮了、成片确实是倒的，
 * 预览却照旧正放 —— 用户会以为没生效，反复点。反之只做预览那半边，
 * 成片正放，是最典型的「预览好看、导出打脸」。
 *
 * 所以这里只放**一份**局部时间翻转口径，渲染层（trim.js 的 sourceTimeAt）
 * 与主进程（render.js 的滤镜链）都从这里取。
 *
 * ⚠️ 倒放翻转的是**片段内的局部秒**，不是源文件秒：
 *    源入点、倍速这两件事由调用方按原来的顺序处理（先翻转局部时间、再乘倍速），
 *    这样「2 倍速 + 倒放」= 从片段末尾往回 2 倍速走，与导出的
 *    `trim → reverse → setpts` 顺序逐字对应。
 *
 * ⚠️ 音频预览的已知取舍：浏览器同样没有「反向播放音频」的能力
 *    （`<audio>` 也没有负 playbackRate），预览里倒放片段的**声音会静音**，
 *    由右栏「倒放」开关下方明写提示；成片里的 `areverse` 是完整的。
 *    这是一个**说出来的**取舍，不是静默失效 —— 静默失效才是要避免的。
 *
 * 本文件是 **CommonJS**：主进程是 CJS，渲染层由 vite 的 commonjs 插件转，
 * 新增模块必须在 packages/desktop/vite.config.mjs 的 `commonjsOptions.include`
 * 里加一条白名单，否则渲染层 import 到的是空对象（开关点了永远不生效）。
 */

/** 片段是否倒放。历史上草稿里可能存成 1 / 'true'，这里统一按真值判断 */
function isReversed(clip) {
  if (!clip) return false
  const raw = clip.reverse
  return raw === true || raw === 1 || raw === 'true' || raw === '1'
}

/**
 * 把片段内的**局部秒**翻转到倒放后的位置。
 *
 * 正放：局部 0 秒 → 源入点；倒放：局部 0 秒 → 源**出点**。
 * 越界一律夹到 [0, duration]（与 sourceTimeAt 的夹取口径一致），
 * 否则播放头略微越过片段末尾时会返回负数，`<video>.currentTime = -0.03`
 * 在各版本 Electron 上表现不一（有的抛异常、有的跳回 0）。
 *
 * @param {object} clip 片段（需 duration）
 * @param {number} localSeconds 片段内局部秒（播放头 − 片段起点）
 * @returns {number} 翻转后的局部秒；不倒放时原样返回
 */
function reverseLocal(clip, localSeconds) {
  const local = Number(localSeconds)
  const safe = Number.isFinite(local) ? local : 0
  if (!isReversed(clip)) return safe
  const duration = Number(clip && clip.duration) || 0
  if (!(duration > 0)) return safe
  return duration - Math.min(Math.max(safe, 0), duration)
}

/**
 * 导出侧视频链要插入的片段。
 *
 * 为什么返回带前导逗号的串：调用方是拼在 `trim=...,setpts=PTS-STARTPTS` 之后的，
 * 与项目里其余 `*Part`（gradePart / fxPart / cropPart）保持同一种形状，
 * 原样插入即可，不需要在每个调用点多写一层条件。
 *
 * ⚠️ 必须插在 `setpts` **之后**、倍速的 setpts **之前**：`reverse` 会重排帧序，
 *    它要求输入时间戳是干净的从 0 开始，否则报 "Invalid argument" 且指不到这里。
 */
function videoReversePart(clip) {
  return isReversed(clip) ? ',reverse' : ''
}

/** 导出侧音频链要插入的片段（同上，插在 `asetpts=PTS-STARTPTS` 之后） */
function audioReversePart(clip) {
  return isReversed(clip) ? ',areverse' : ''
}

module.exports = {
  isReversed,
  reverseLocal,
  videoReversePart,
  audioReversePart
}
