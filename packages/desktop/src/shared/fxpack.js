'use strict'
/**
 * 特效素材包（`.yjpack` 的第二种 kind）—— 规则真源。
 *
 * ## 为什么特效要单独有一种包
 * 「工程素材包」（`shared/pack.js`，kind = `yijing-pack`）装的是**用户自己的片子**；
 * 这里装的是**应用内的一批叠加素材**（泡泡、法阵、雨丝…）。两者共用一个扩展名，
 * 但目录结构与用途完全不同，靠 manifest 的 `kind` 区分 —— 拿错类型的包来导入时
 * 两边都能明确拒绝，而不是"解出来一堆不认识的目录"。
 *
 * ## 一个效果由什么组成
 * ```
 * manifest.json
 * frames/<id>/f000.png … f029.png   ← 导出用：透明 PNG 序列
 * sheets/<id>.webp                  ← 预览用：全部帧横向拼成一张
 * ```
 *
 * ⚠️ **预览与导出必须是同一批像素**。所以两者由同一次绘制产出（tools/gen-fx-packs.py），
 *    预览不是"另画一个像样的 CSS"，那等于给用户看一个成片里不存在的东西。
 *
 * ⚠️ 为什么不能是带 alpha 的视频：Chromium 能播 VP9 alpha，但 ffmpeg 编不出来
 *    （只能编 ProRes/qtrle，而 Chromium 播不了 MOV）。详见 PITFALLS 25.1。
 *    PNG 序列是唯一能让两边落到同一份像素上的选择。
 *
 * ⚠️ 本文件是 **CommonJS**（主进程 require，渲染层由 vite 的 commonjs 插件转）。
 *    新增模块必须同步 `packages/desktop/vite.config.mjs` 的 `commonjsOptions.include`。
 */

/** 与工程包共扩展名，靠这个字段区分 */
const FXPACK_KIND = 'yijing-fxpack'
const FXPACK_VERSION = 1
/** 随安装包内置的那一份（文件名不含扩展名） */
const BUILTIN_PACK = 'overlay-fx'
const MANIFEST_FILE = 'manifest.json'
const FRAMES_DIR = 'frames'
const SHEETS_DIR = 'sheets'
/** 解压后的安装标记：内容 = manifest 的 sha1。一致就跳过重解 */
const STAMP_FILE = '.installed'
/** 单个效果允许的帧数上限（防御坏包把内存吃满：30 帧是正常量级，留了 8 倍余量） */
const MAX_FRAMES = 240
const MAX_FPS = 60

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)

/** `f000.png` 这种零填充命名，位数由帧数决定（≥1000 帧才需要 4 位，但上限是 240） */
function frameName(index) {
  return `f${String(Math.max(0, Math.floor(num(index)))).padStart(3, '0')}.png`
}

/**
 * 校验 manifest。返回 null 表示"这不是特效素材包"。
 *
 * ⚠️ `kind` 必须严格相等：工程包也是 `.yjpack`，只靠扩展名区分会把用户的工程
 *    当成素材包解，然后"特效一个都没有"——而且不报错。
 */
function readManifest(json) {
  if (!json || typeof json !== 'object') return null
  if (json.kind !== FXPACK_KIND) return null
  const version = Math.floor(num(json.version))
  if (version < 1 || version > FXPACK_VERSION) return null
  const fps = Math.min(MAX_FPS, Math.max(1, Math.floor(num(json.fps, 10))))
  const list = Array.isArray(json.effects) ? json.effects : []
  const effects = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const key = String(item.key || '')
    /* key 会进文件路径（frames/<key>/），必须自己就是安全的：
       只允许小写字母、数字、连字符，且不许以连字符开头/结尾 */
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(key)) continue
    const frames = Math.floor(num(item.frames, 0))
    if (frames < 2 || frames > MAX_FRAMES) continue
    const dir = String(item.dir || `${FRAMES_DIR}/${key}`).replace(/\\/g, '/')
    const sheet = String(item.sheet || `${SHEETS_DIR}/${key}.webp`).replace(/\\/g, '/')
    /* 包里不许出现绝对路径或向上跳（zip-slip 的第二道闸，第一道在 extractZip） */
    if (dir.includes('..') || sheet.includes('..') || /^[a-zA-Z]:/.test(dir)) continue
    effects.push({
      key,
      label: String(item.label || key),
      frames,
      fps: Math.min(MAX_FPS, Math.max(1, Math.floor(num(item.fps, fps)))),
      dir,
      sheet,
      bytes: num(item.bytes)
    })
  }
  if (!effects.length) return null
  return {
    version,
    name: String(json.name || '特效素材包'),
    fps,
    frameCount: Math.floor(num(json.frames, 0)),
    effects
  }
}

/** key → 效果条目（给主进程与闸门共用，避免各写一份查找） */
function effectIndex(manifest) {
  const out = {}
  for (const item of manifest && Array.isArray(manifest.effects) ? manifest.effects : []) {
    out[item.key] = item
  }
  return out
}

/**
 * 某个效果在解压目录里的实际文件。
 *
 * 返回 `{ ok, dir, sheet, first, frames, fps, missing }`；
 * `missing` 非空表示包里缺文件（**必须如实报**，否则表现为"卡片在、点了没反应"）。
 */
function effectFiles(rootDir, entry) {
  const path = require('node:path')
  const fs = require('node:fs')
  const root = String(rootDir || '')
  const dir = path.join(root, entry.dir.split('/').join(path.sep))
  const sheet = path.join(root, entry.sheet.split('/').join(path.sep))
  const first = path.join(dir, frameName(0))
  const missing = []
  if (!fs.existsSync(first)) missing.push(entry.dir + '/' + frameName(0))
  if (!fs.existsSync(sheet)) missing.push(entry.sheet)
  return { ok: missing.length === 0, dir, sheet, first, frames: entry.frames, fps: entry.fps, missing }
}

module.exports = {
  FXPACK_KIND,
  FXPACK_VERSION,
  BUILTIN_PACK,
  MANIFEST_FILE,
  FRAMES_DIR,
  SHEETS_DIR,
  STAMP_FILE,
  MAX_FRAMES,
  MAX_FPS,
  frameName,
  readManifest,
  effectIndex,
  effectFiles
}
