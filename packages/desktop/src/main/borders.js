/**
 * 内置边框库 —— 读取逻辑在 `main/materialPack.js`（与贴纸共用一套）。
 *
 * 素材由 `tools/gen-borders.py` **程序生成**（不是抓的），每张 1080×1080、
 * 中间透明、四周一圈带子，见 `resources/borders/catalog.json`。
 *
 * 为什么是正方形而且中间透明：
 *   · 成片画框可能是 16:9 / 9:16 / 1:1 / 4:3。按 16:9 画的边框拉到竖屏会塌，
 *     正方形 + 按边长百分比给带子宽度，拉伸到任意比例时上下左右各占自己那一维的
 *     同一个百分比 —— 与 CSS 的百分比边框观感一致。
 *   · 中间必须真的透明（alpha=0），否则边框会把整幅画面盖死。
 *     `tools/check-borders.mjs` 会逐张读 PNG 的 alpha 判这一条。
 *
 * 与贴纸的区别（**别混**）：贴纸是「投放成叠加轨上的 image 片段」，
 * 边框是「片段的属性」（`clip.border = 'br-xxx'`），跟着片段自己的画面框走 ——
 * 画中画加了边框，边框也在画中画那个小框上，而不是铺满整个画布。
 */
const { packRootOf, readPack, MAX_ITEMS } = require('./materialPack')

const DIR = 'borders'
const LABEL = '边框'

function borderRootOf(deps = {}) {
  return packRootOf(DIR, deps)
}

function readCatalog(deps = {}) {
  return readPack(DIR, { ...deps, label: LABEL, fallbackSize: 1080 })
}

module.exports = { borderRootOf, readCatalog, MAX_ITEMS }
