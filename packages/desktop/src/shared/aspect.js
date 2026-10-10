'use strict'
/**
 * 画面比例（真源唯一）。
 *
 * 为什么单独一个文件、还不许在渲染层与主进程各写一份：
 * 比例同时决定两件事 —— 预览画布的形状（渲染层算 CSS aspect-ratio）与成片的形状
 * （主进程算输出尺寸 + ffmpeg 的 crop）。两边各写一份，迟早有一边漏掉 ——
 * 症状是"预览里是 1:1、导出来还是 16:9"这种预览与成片对不上、而两边单独看都没错的
 * 缺陷，静态扫描和构建都拦不住，只有真导出一遍才发现。
 * 这是纯算术，没有任何理由分叉 —— 所以放在 shared/ 下，两边都从这里取。
 *
 * ⚠️ 这个文件是 **CommonJS**，因为主进程（`src/main/render.js`，Electron 33 / Node 20）
 * 是 CJS、且那个 Node 版本还不支持 `require()` 一个 ESM 文件；
 * 渲染层那边由 vite 的 commonjs 插件转（见 packages/desktop/vite.config.mjs 的
 * `commonjsOptions.include` —— 只放行这一个文件，别把整个 src 都转了）。
 * 改这里的模块语法前，先确认两边都还加载得到。
 */

/**
 * 可选比例。顺序 = 界面上的顺序（Jason 定的口径）。
 *
 * ⚠️ `label` 就是界面上按钮里写的那两个字，**不要**另起一套显示名：
 * 用户按"9:16"这个记号找按钮，按钮上写别的（比如"竖屏"）就找不着了。
 */
const ASPECTS = [
  { key: '1:1', label: '1:1', w: 1, h: 1 },
  { key: '1:2', label: '1:2', w: 1, h: 2 },
  { key: '3:4', label: '3:4', w: 3, h: 4 },
  { key: '9:16', label: '9:16', w: 9, h: 16 },
  { key: '16:9', label: '16:9', w: 16, h: 9 },
  { key: '4:3', label: '4:3', w: 4, h: 3 },
  { key: '2:1', label: '2:1', w: 2, h: 1 }
]

/** 没选过、或读到一个不在表里的值时用这个。16:9 与"新建草稿"的默认一致 */
const DEFAULT_ASPECT = '16:9'

const ASPECT_KEYS = ASPECTS.map((item) => item.key)

/** 取比例定义；不在表里就回落默认（草稿里可能存着旧版本写进去的值） */
function aspectOf(key) {
  const hit = ASPECTS.find((item) => item.key === key)
  return hit || ASPECTS.find((item) => item.key === DEFAULT_ASPECT)
}

/** 归一化成合法 key（存草稿、写 DOM 属性前都先过一遍） */
function normalizeAspect(key) {
  return ASPECT_KEYS.indexOf(key) >= 0 ? key : DEFAULT_ASPECT
}

/** 宽 / 高，浮点。CSS 的 aspect-ratio 与布局算宽度都用它 */
function aspectRatioOf(key) {
  const item = aspectOf(key)
  return item.w / item.h
}

/**
 * 在基准分辨率里裁出该比例的**最大内接矩形**，且宽高都取偶数
 * （ffmpeg 的 yuv420p 要求偶数，奇数会在编码那一步报 "width not divisible by 2"）。
 *
 * 裁而不是补：比例是"画布形状"，素材比画布宽就裁左右、比画布高就裁上下，
 * 不留黑边 —— 与预览那侧 `object-fit: cover` 是同一个口径。
 *
 * @param {number} baseW 基准宽（用户选的输出分辨率，如 1920）
 * @param {number} baseH 基准高（如 1080）
 * @param {string} key   比例 key
 * @returns {{width:number, height:number}}
 */
function outputSizeFor(baseW, baseH, key) {
  const w = Math.max(2, Math.round(Number(baseW) || 1920))
  const h = Math.max(2, Math.round(Number(baseH) || 1080))
  const ratio = aspectRatioOf(key)
  let outW = w
  let outH = h
  if (w / h > ratio) {
    // 基准比目标更宽 ⇒ 裁左右
    outW = Math.round(h * ratio)
  } else {
    // 基准比目标更高 ⇒ 裁上下
    outH = Math.round(w / ratio)
  }
  // 向下取偶数：宁可小 1px，也不要让 ffmpeg 在编码那一步挂掉
  return {
    width: Math.max(2, Math.floor(outW / 2) * 2),
    height: Math.max(2, Math.floor(outH / 2) * 2)
  }
}

module.exports = {
  ASPECTS,
  ASPECT_KEYS,
  DEFAULT_ASPECT,
  aspectOf,
  normalizeAspect,
  aspectRatioOf,
  outputSizeFor
}
