'use strict'
/**
 * 字体入库 —— **唯一实现**。界面（`index.js` 的 `font:pick`）与 MCP 工具
 * （`yijing_import_font`）都调这里，谁也别各写一份。
 *
 * 为什么要入库而不是"记住原路径"：
 *   · 用户在素材库/桌面里把 .ttf 删掉之后，工程里的标题就静默退回系统字体了 ——
 *     导出成片才发现字体变了，而且没有任何报错。复制一份进 `userData/fonts/` 才算交付；
 *   · 字体家族名（`SourceHanSans`）极容易撞名，按原名落地会互相覆盖：
 *     用户导了两种黑体，实际只剩后一种。所以文件名带原路径短哈希。
 *
 * 为什么放在 `src/main/` 而不是 `src/shared/`：本模块要落盘、要按 userData 定位目录，
 * 是**主进程侧**的事；MCP server 是独立进程，靠 `userDataDir` 参数注入同一个目录，
 * 于是两个进程落到同一个 `fonts/` 下 —— 界面导的字体 agent 看得见，反之亦然。
 */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const FONT_EXTS = ['.ttf', '.otf', '.ttc']

/** `userData/fonts` —— 界面与 MCP 共用同一个目录，靠调用方把 userDataDir 传进来 */
const fontsDirOf = (userDataDir) => path.join(String(userDataDir || ''), 'fonts')

/**
 * 把一个字体文件复制进素材目录。
 *
 * @returns {{id:string,name:string,path:string,ext:string,bytes:number,basename:string}|null}
 *          扩展名不认识 / 读不了 / 落盘失败一律 null（调用方自己决定怎么报）
 */
function importFontFile(options) {
  const opts = options || {}
  const sourcePath = String(opts.sourcePath || '')
  const userDataDir = String(opts.userDataDir || '')
  if (!sourcePath || !userDataDir) return null

  const absolute = path.resolve(sourcePath)
  const ext = path.extname(absolute).toLowerCase()
  if (!FONT_EXTS.includes(ext)) return null

  try {
    /* 先确认是可读的普通文件：目录、快捷方式、被占用都别往下走 */
    if (!fs.statSync(absolute).isFile()) return null
    const dir = fontsDirOf(userDataDir)
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(absolute, path.extname(absolute)).replace(/[^\w\u4e00-\u9fa5-]/g, '_')
    const stamp = createHash('sha1').update(absolute).digest('hex').slice(0, 8)
    const target = path.join(dir, `${base}-${stamp}${ext}`)
    if (!fs.existsSync(target)) fs.copyFileSync(absolute, target)
    return {
      /* id 用哈希：同一个字体重复导入得到同一个 id，设置里不会出现两条一样的 */
      id: stamp,
      name: base,
      basename: path.basename(target),
      path: target,
      ext,
      bytes: fs.statSync(target).size
    }
  } catch {
    return null
  }
}

/**
 * 已入库字体（磁盘为准）。设置里记的条目可能指向已被删掉的文件，
 * 所以**不回读设置**，直接扫目录 —— 判据读消费端。
 */
function listFonts(options) {
  const dir = fontsDirOf(options && options.userDataDir)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const ext = path.extname(name).toLowerCase()
    if (!FONT_EXTS.includes(ext)) continue
    const full = path.join(dir, name)
    try {
      if (!fs.statSync(full).isFile()) continue
      out.push({
        id: (name.match(/-([0-9a-f]{8})\.(ttf|otf|ttc)$/i) || [])[1] || createHash('sha1').update(full).digest('hex').slice(0, 8),
        name: path.basename(name, ext).replace(/-[0-9a-f]{8}$/i, ''),
        basename: name,
        path: full,
        ext
      })
    } catch {
      /* 读不了就跳过 */
    }
  }
  return out
}

module.exports = { FONT_EXTS, fontsDirOf, importFontFile, listFonts }
