'use strict'
/**
 * 素材包（导出 / 导入）—— 主进程侧执行层。
 *
 * 规则（收哪些文件、路径怎么改写）全在 `shared/pack.js`；
 * 这里只做三件渲染层做不了的事：**碰磁盘**（存在性 / 读文件 / 写 zip）、
 * **走对话框**、**登记白名单**。
 *
 * ## 一条必须保住的不变式
 *   导出**不改动**原草稿：`rewriteForExport` 拿到的是克隆，原 `clips` 里的
 *   `path` 依旧是绝对路径。改错了的症状是"打完包，自己的工程全变成黑框了"
 *   —— 而且只有重新打开草稿才看得出来。
 *
 * ## 缺素材怎么办
 *   不静默跳过（那会打出一个"看起来完整、到对面缺两段"的包）。
 *   逐个 `statSync`，缺的收进 `missing` 一起回给渲染层，
 *   由界面明说「N 个素材找不到，已按离线导出」。
 */

const fs = require('node:fs')
const path = require('node:path')
const packTable = require('../shared/pack')
const { writeZip, extractZip, readZip } = require('./zip')

/** 素材文件的最小合理体积：0 字节的多半是"占位文件"或复制中断，别把它打进包 */
const MIN_BYTES = 1

/**
 * 体检：这一份草稿的素材齐不齐。渲染层在点「导出素材包」之前调它。
 * 只读 `statSync`，不动任何文件。
 */
function inspectPackData(data) {
  const { sources, refs } = packTable.collectSources(data && data.clips, data && data.assets)
  const missing = []
  let totalBytes = 0
  for (const filePath of sources) {
    let bytes = 0
    let ok = false
    try {
      const stat = fs.statSync(filePath)
      ok = stat.isFile() && stat.size >= MIN_BYTES
      bytes = stat.size
    } catch {
      ok = false
    }
    if (ok) totalBytes += bytes
    else missing.push({ path: filePath, refs: refs[filePath] || 1 })
  }
  return {
    total: sources.length,
    found: sources.length - missing.length,
    missing,
    totalBytes,
    /* 预览用：前几个缺失名（完整列表在主进程日志/DOM 的 title 里，别一次塞 200 条给界面） */
    missingNames: missing.slice(0, 5).map((item) => path.basename(item.path))
  }
}

/**
 * 导出素材包。
 *
 * @param {{ data: object, outPath: string, name?: string, createdAt?: string }} options
 * @returns {{ ok: boolean, outPath?: string, packed?: number, bytes?: number, missing?: array, error?: string }}
 */
function exportPack(options) {
  const opts = options || {}
  const data = opts.data && typeof opts.data === 'object' ? opts.data : null
  if (!data) return { ok: false, error: '没有可导出的草稿内容' }
  const outPath = String(opts.outPath || '')
  if (!outPath || !path.isAbsolute(outPath)) return { ok: false, error: '输出路径不合法' }

  const inspected = inspectPackData(data)
  /* 映射只包含**真的存在**的素材：缺失的保持原绝对路径（对面一眼看出是断的），
     而不是改成一个必然不存在的相对路径 —— 后者看起来"包是完整的"。 */
  const missingSet = new Set(inspected.missing.map((item) => item.path))
  const available = packTable.collectSources(data.clips, data.assets).sources.filter((item) => !missingSet.has(item))
  const mapping = packTable.buildMapping(available)
  const rewritten = packTable.rewriteForExport(data, mapping)

  const files = []
  const entries = []
  for (const filePath of available) {
    const rel = mapping[filePath]
    let bytes = 0
    try {
      bytes = fs.statSync(filePath).size
    } catch {
      continue
    }
    files.push({ file: rel, bytes })
    entries.push({ name: rel, file: filePath })
  }

  const name = String(opts.name || '未命名工程')
  const manifest = packTable.buildManifest({ name, files, createdAt: opts.createdAt })
  /* 顺序有意：先说明文件，再清单，再草稿，最后素材（解压时人先看到的是什么很重要） */
  entries.unshift({ name: packTable.README_FILE, data: Buffer.from(packTable.readmeText(name), 'utf8') })
  entries.unshift({ name: packTable.MANIFEST_FILE, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  entries.unshift({ name: packTable.DRAFT_FILE, data: Buffer.from(JSON.stringify(rewritten), 'utf8') })

  const tmp = `${outPath}.tmp`
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    const written = writeZip(tmp, entries)
    fs.renameSync(tmp, outPath)
    return {
      ok: true,
      outPath,
      packed: files.length,
      bytes: written.bytes,
      missing: inspected.missing,
      skipped: inspected.missing.length
    }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 删不掉就留着，反正不叫原名 */
    }
    return { ok: false, error: `写包失败：${error.message}` }
  }
}

/**
 * 导入素材包：解到 `destDir`，草稿路径改写成解出来的绝对路径，再把 url 贴回去。
 *
 * @param {{ packPath: string, destDir: string, registerUrl?: (filePath: string) => string }} options
 * @returns {{ ok: boolean, name?: string, data?: object, mediaCount?: number, missing?: array, error?: string }}
 */
function importPack(options) {
  const opts = options || {}
  const packPath = String(opts.packPath || '')
  const destDir = String(opts.destDir || '')
  if (!packPath || !fs.existsSync(packPath)) return { ok: false, error: '包文件不存在' }
  if (!destDir || !path.isAbsolute(destDir)) return { ok: false, error: '解包目录不合法' }

  try {
    fs.mkdirSync(destDir, { recursive: true })
    /* 先只读清单：不是我们的包就**别解压**（否则用户选错文件时磁盘上多出一堆垃圾） */
    let manifest = null
    try {
      const entries = readZip(packPath)
      const manifestEntry = entries.find((item) => item.name === packTable.MANIFEST_FILE)
      if (manifestEntry) manifest = packTable.readManifest(JSON.parse(manifestEntry.data.toString('utf8')))
    } catch (error) {
      return { ok: false, error: `不是有效的素材包：${error.message}` }
    }
    if (!manifest) return { ok: false, error: '这个文件不是艺镜素材包（缺少清单或版本不支持）' }

    extractZip(packPath, destDir)

    const draftFile = path.join(destDir, packTable.DRAFT_FILE)
    if (!fs.existsSync(draftFile)) return { ok: false, error: '包里没有草稿（draft.json）' }
    const raw = JSON.parse(fs.readFileSync(draftFile, 'utf8'))
    const data = packTable.rewriteForImport(raw, destDir)

    /* 重新登记白名单 + 重新生成 url（url 是按**绝对路径**编码的，必须重算） */
    const { sources } = packTable.collectSources(data.clips, data.assets)
    const urlTable = {}
    const missing = []
    for (const filePath of sources) {
      let exists = false
      try {
        exists = fs.statSync(filePath).isFile()
      } catch {
        exists = false
      }
      if (!exists) {
        missing.push(filePath)
        continue
      }
      const url = typeof opts.registerUrl === 'function' ? opts.registerUrl(filePath) : ''
      if (url) urlTable[filePath] = url
      else missing.push(filePath)
    }
    packTable.attachUrls(data, urlTable)

    return {
      ok: true,
      name: manifest.name,
      version: manifest.version,
      data,
      mediaCount: sources.length - missing.length,
      missing
    }
  } catch (error) {
    return { ok: false, error: `解包失败：${error.message}` }
  }
}

module.exports = { inspectPackData, exportPack, importPack, MIN_BYTES }
