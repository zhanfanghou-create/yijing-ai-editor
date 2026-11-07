'use strict'
/**
 * 特效素材包 —— 定位、安装、解析。
 *
 * ## 三件事，顺序不能反
 *   ① **找包**：安装目录里带一份内置包（`resources/fxpacks/overlay-fx.yjpack`）；
 *   ② **装包**：解到 `<userData>/fxpacks/<包名>/`，用 manifest 的 sha1 判是否需要重解；
 *   ③ **解析**：把 `key → 帧序列目录 / 雪碧图 / 帧数 / 帧率` 报给渲染层与导出链。
 *
 * ## 为什么"装"要落盘而不是每次直接从包里读
 *   预览要一张**可被 `<img>`/CSS 直接取的文件**，导出要一串**可被 ffmpeg 顺序读的 PNG**。
 *   两者都要真实路径。每次启动解一遍 10MB 太浪费，所以解一次、用 sha1 判断是否需要重解。
 *
 * ## 为什么状态要"如实报缺失"
 *   卡片是从 `frameEffects.json` 来的（静态），素材是包里的（可缺）。
 *   少了文件却假装有，表现就是"卡片在、点了画面不动、导出也不报错"——
 *   这一类静默失效在 `check-fx-packs` 里有专门的断言。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const table = require('../shared/fxpack')
const { extractZip, readZip } = require('./zip')

/** 内置包所在目录：打包后在 `resources/fxpacks`，开发态在 `packages/desktop/resources/fxpacks` */
function builtinDirOf(deps = {}) {
  const candidates = [
    deps.resourcesPath ? path.join(deps.resourcesPath, 'fxpacks') : '',
    deps.appPath ? path.join(deps.appPath, 'resources', 'fxpacks') : '',
    deps.mainDir ? path.join(deps.mainDir, '..', '..', 'resources', 'fxpacks') : '',
    deps.mainDir ? path.join(deps.mainDir, '..', 'resources', 'fxpacks') : ''
  ].filter(Boolean)
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, `${table.BUILTIN_PACK}.yjpack`))) return dir
    } catch {
      /* 无权限/不存在都继续试下一个 */
    }
  }
  return ''
}

/** 安装根目录 */
function installRootOf(deps = {}) {
  const base = deps.userData || ''
  if (!base) return ''
  return path.join(base, 'fxpacks')
}

/** 包内 manifest 的 sha1（只算 manifest，不算帧：帧变了 manifest 一定变，因为 bytes 在 manifest 里） */
function manifestDigest(zipPath) {
  const entries = readZip(zipPath)
  const hit = entries.find((item) => item.name === table.MANIFEST_FILE)
  if (!hit) return ''
  return crypto.createHash('sha1').update(hit.data).digest('hex')
}

/** 读一个已解压目录的 manifest（坏包返回 null，不抛） */
function readInstalled(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, table.MANIFEST_FILE), 'utf8')
    return table.readManifest(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * 安装一个包到 `<root>/<name>/`。已安装且 sha1 一致时**什么都不做**。
 * 返回 `{ ok, installed, skipped, error }`。
 */
function installPack({ zipPath, destDir }) {
  if (!zipPath || !fs.existsSync(zipPath)) return { ok: false, error: '内置素材包不存在' }
  const digest = manifestDigest(zipPath)
  if (!digest) return { ok: false, error: '素材包里没有 manifest.json' }
  const stampPath = path.join(destDir, table.STAMP_FILE)
  try {
    if (fs.readFileSync(stampPath, 'utf8').trim() === digest) {
      /* 已装且内容一致 —— 但还要确认 manifest 真读得出来（用户可能手工删过文件） */
      if (readInstalled(destDir)) return { ok: true, skipped: true, digest }
    }
  } catch {
    /* 没有标记文件 = 没装过 */
  }
  try {
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.mkdirSync(destDir, { recursive: true })
    extractZip(zipPath, destDir)
    fs.writeFileSync(stampPath, digest, 'utf8')
  } catch (error) {
    return { ok: false, error: `解包失败：${error.message}` }
  }
  if (!readInstalled(destDir)) return { ok: false, error: '素材包的 manifest 不合法' }
  return { ok: true, skipped: false, digest }
}

/**
 * 把内置包装上（幂等）。找不到内置包时**不报错**：开源版允许用户自己删资源目录，
 * 这时特效页的素材卡会如实标成"未安装"，而不是让整个应用起不来。
 */
function installBuiltin(deps = {}) {
  const dir = builtinDirOf(deps)
  if (!dir) return { ok: false, skipped: true, error: '没有内置素材包' }
  const root = installRootOf(deps)
  if (!root) return { ok: false, error: '拿不到用户目录' }
  return installPack({
    zipPath: path.join(dir, `${table.BUILTIN_PACK}.yjpack`),
    destDir: path.join(root, table.BUILTIN_PACK)
  })
}

/** 扫 `<userData>/fxpacks/` 下所有已安装的包，按名字排序（内置包恒在最前，便于排查） */
function installedPacks(deps = {}) {
  const root = installRootOf(deps)
  const out = []
  if (!root) return out
  let names = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
  } catch {
    return out
  }
  names.sort((a, b) => (a === table.BUILTIN_PACK ? -1 : b === table.BUILTIN_PACK ? 1 : a.localeCompare(b)))
  for (const name of names) {
    const dir = path.join(root, name)
    const manifest = readInstalled(dir)
    if (!manifest) continue
    out.push({ name, dir, manifest })
  }
  return out
}

/**
 * 全部可用效果：`{ [key]: { frames, fps, dir, sheet, first, missing, pack } }`。
 *
 * ⚠️ 同名 key 由**先装的包**赢（内置包排最前），后装的包只补缺。
 *    反过来会让"用户随手放一个坏包"把内置效果整片顶掉，而界面上看不出是谁干的。
 */
function effects(deps = {}) {
  const out = {}
  const packs = installedPacks(deps)
  for (const pack of packs) {
    for (const entry of pack.manifest.effects) {
      if (out[entry.key]) continue
      const files = table.effectFiles(pack.dir, entry)
      out[entry.key] = { ...files, label: entry.label, pack: pack.name }
    }
  }
  return out
}

/** 给渲染层/导出链的完整状态（含 URL，渲染层直接用） */
function state(deps = {}) {
  const urlOf = typeof deps.mediaUrlOf === 'function' ? deps.mediaUrlOf : () => ''
  const allow = typeof deps.allow === 'function' ? deps.allow : () => {}
  const list = effects(deps)
  const ready = {}
  for (const [key, item] of Object.entries(list)) {
    if (!item.ok) continue
    /* ⚠️ 必须先登记白名单再取 URL：`yjai-media://` 协议对未登记的绝对路径直接 403，
       表现是"卡片点下去、覆盖层有了、背景图加载失败"，而控制台只有一条资源错误。
       帧目录不登记 —— 它只给 ffmpeg 读绝对路径，不走协议。 */
    allow(item.sheet)
    ready[key] = {
      frames: item.frames,
      fps: item.fps,
      /* 雪碧图给预览，帧目录给导出 —— 两者来自同一个包，不存在对不上 */
      sheetUrl: urlOf(item.sheet),
      dir: item.dir,
      label: item.label,
      pack: item.pack
    }
  }
  const packs = installedPacks(deps).map((item) => ({
    name: item.name,
    label: item.manifest.name,
    count: item.manifest.effects.length
  }))
  return { ready, effects: ready, packs, builtinDir: builtinDirOf(deps) }
}

module.exports = {
  BUILTIN_PACK: table.BUILTIN_PACK,
  builtinDirOf,
  installRootOf,
  manifestDigest,
  installPack,
  installBuiltin,
  installedPacks,
  effects,
  state
}
