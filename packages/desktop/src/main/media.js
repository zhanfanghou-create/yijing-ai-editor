/**
 * 本地素材描述（纯 Node，不依赖 electron）。
 *
 * 为什么单独成模块：主进程与 **MCP server（镜枢对接时以纯 Node 模式运行的同一个 exe）**
 * 都要把磁盘路径变成"素材对象"。两边各写一份的代价是规则分叉 ——
 * 一边认某个扩展名、另一边不认；一边算 `yjai-media://` 的 base64url、另一边用别的编码。
 * 分叉的后果是"agent 建的草稿在软件里预览是一片空白"，而两边单独看都"没问题"。
 *
 * ⚠️ 白名单（`allowedMedia`）**不在这里**：那是主进程的内存态访问控制，
 *    MCP server 是独立进程、拿不到也用不上（草稿恢复时软件会重新登记一遍素材）。
 *    这里只做**无副作用的形状换算**。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 可导入的扩展名 → 素材类型 */
const MEDIA_KIND_BY_EXT = {
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video', '.avi': 'video',
  '.m4v': 'video', '.wmv': 'video', '.flv': 'video', '.mpg': 'video', '.mpeg': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.aac': 'audio', '.m4a': 'audio', '.flac': 'audio',
  '.ogg': 'audio', '.oga': 'audio', '.opus': 'audio', '.wma': 'audio',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
  '.gif': 'image', '.bmp': 'image', '.avif': 'image'
}

const MEDIA_SCHEME = 'yjai-media'

/** 路径归一 + 扩展名白名单校验；不合法返回空串（调用方一律先过这一关） */
function normalizeMediaPath(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const absolute = path.resolve(text)
  return MEDIA_KIND_BY_EXT[path.extname(absolute).toLowerCase()] ? absolute : ''
}

/** 绝对路径 → 渲染层可直接用的 URL（base64url 编码，彻底避开中文/空格/# 的转义问题） */
function mediaUrlOf(absolutePath) {
  return `${MEDIA_SCHEME}://local/${Buffer.from(absolutePath, 'utf8').toString('base64url')}`
}

/**
 * 描述一个本地文件。文件不存在、不是普通文件、扩展名不支持，一律返回 null。
 * **无副作用**（不碰白名单）—— 调用方需要访问控制就自己加。
 */
function describeMedia(raw) {
  const absolute = normalizeMediaPath(raw)
  if (!absolute) return null
  let stat
  try {
    stat = fs.statSync(absolute)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size <= 0) return null
  const ext = path.extname(absolute).toLowerCase()
  return {
    path: absolute,
    name: path.basename(absolute),
    displayName: path.basename(absolute, path.extname(absolute)),
    ext,
    size: stat.size,
    mtime: stat.mtimeMs,
    kind: MEDIA_KIND_BY_EXT[ext],
    url: mediaUrlOf(absolute)
  }
}

module.exports = {
  MEDIA_KIND_BY_EXT,
  MEDIA_SCHEME,
  normalizeMediaPath,
  mediaUrlOf,
  describeMedia
}
