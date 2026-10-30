/**
 * 内置贴纸库 —— 读取逻辑全部在 `main/materialPack.js`（与边框共用一套）。
 *
 * 素材由 `tools/fetch-stickers.mjs` 抓到 `resources/stickers/`，随安装包走
 * `extraResources`（与 ffmpeg 同一套方式）。面板读 `catalog.json` 拿清单，
 * 素材本体通过 `yjai-media://` 交给渲染层 —— **刻意不复用 new 协议**：
 * 贴纸落地后就是普通的本地图片，走现有协议意味着预览、导出、胶片可视化三处
 * 一行都不用改（导出侧 render.js 已经把 `yjai-media://` 解回磁盘路径）。
 *
 * 这里只保留贴纸自己的两件事：目录名、报错里那个词。
 * ⚠️ 找目录的三种情形与路径穿越校验写在 materialPack.js，别在这儿再抄一份。
 */
const { packRootOf, readPack, MAX_ITEMS } = require('./materialPack')

const DIR = 'stickers'
const LABEL = '贴纸'

function stickerRootOf(deps = {}) {
  return packRootOf(DIR, deps)
}

function readCatalog(deps = {}) {
  return readPack(DIR, { ...deps, label: LABEL, fallbackSize: 512 })
}

module.exports = { stickerRootOf, readCatalog, MAX_ITEMS }
