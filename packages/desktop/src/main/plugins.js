/**
 * 本地插件（素材包）的安装与管理。
 *
 * 形态：一个文件夹 = 一个插件。里面有（可选的）`manifest.json` 和若干 PNG。
 * 安装后复制到 `<userData>/plugins/<id>/`，图片统一改名成 `001.png`、`002.png`…
 *
 * ## 为什么图片要改名
 *
 * 用户给的文件名里几乎一定有中文、空格、括号、`#`、`%`。这些字符要出现在
 * `yjai-media://` 的路径里、要当 React key、要进草稿 JSON —— 每一处都是坑。
 * 统一改序号名，原始名字单独记在清单的 `images[].name` 里给面板显示。
 * 顺带的好处：`pv-<id>-<序号>` 这个 key 与文件名一一对应，重装同一个插件
 * 时顺序不变 ⇒ 草稿里 `clip.border` 不会失效。
 *
 * ## 为什么装的时候就把宽高写进清单
 *
 * 面板要按宽高比画格子。每次打开都读 40 张 PNG 的头太浪费，而且用户可能在
 * 安装后手动删掉某张图 —— 所以 `listPlugins` 里仍然逐张 `statSync` 核一遍，
 * 盘上没有的条目直接不列（"点了没反应"比"看不到"更迷惑，这条与 materialPack 一致）。
 */
const fs = require('node:fs')
const path = require('node:path')

const P = require('../shared/pluginPack')

/** 最多装多少个插件。防止误选一个装满子目录的盘符根目录 */
const MAX_PLUGINS = 50

/** 扫图片时最多下潜几层（插件夹里套一层 `images/` 很常见） */
const MAX_DEPTH = 3

/**
 * 找插件根目录（不需要预先存在，安装时会 mkdir）。
 *
 * @param {object} deps `{ userData }`；自测时传假的临时目录
 */
function pluginRootOf(deps = {}) {
  const userData = String(deps.userData || '')
  if (!userData) return ''
  return path.join(userData, 'plugins')
}

/** 递归收集 PNG 绝对路径（按路径排序 ⇒ 同一份素材每次装出来的序号一致） */
function collectPngs(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  const files = entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.png')
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b))
  /* 顶层文件排在子目录之前：用户把主图放外面、附件放 `extra/` 时，主图序号更小 */
  out.push(...files)
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b))
  for (const sub of dirs) collectPngs(sub, depth + 1, out)
  return out
}

/**
 * 从素材包里安全复制一张图。
 *
 * 目标名由调用方给（`001.png`），源路径必须仍在插件源目录之内 ——
 * 源目录是用户选的，理论上不会越界，但 `manifest.json` 里的 `images[].file`
 * 是用户可写的，不校验就能让它指向盘上任意文件（同 materialPack 里那条）。
 */
function copyInto(src, dstDir, dstName, sourceRoot) {
  const absSrc = path.resolve(src)
  const rel = path.relative(path.resolve(sourceRoot), absSrc)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const dst = path.join(dstDir, dstName)
  fs.copyFileSync(absSrc, dst)
  return dst
}

/**
 * 安装一个插件文件夹。
 *
 * @param {string} srcDir 用户选的目录
 * @param {object} deps `{ userData }`
 * @returns {{ ok:boolean, plugin?:object, error?:string, skipped?:string[] }}
 */
function install(srcDir, deps = {}) {
  const root = pluginRootOf(deps)
  if (!root) return { ok: false, error: '拿不到用户数据目录' }

  const from = String(srcDir || '')
  if (!from) return { ok: false, error: '没选目录' }
  let stat = null
  try {
    stat = fs.statSync(from)
  } catch {
    return { ok: false, error: '这个目录读不到' }
  }
  if (!stat.isDirectory()) return { ok: false, error: '请选择一个文件夹（插件包的根目录）' }

  let existing = []
  try {
    existing = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    /* 还没建过，正常 */
  }
  if (existing.length >= MAX_PLUGINS) {
    return { ok: false, error: `插件数量已达上限（${MAX_PLUGINS} 个），先删掉几个` }
  }

  /* 清单是可选的：没有就按"整个文件夹都是一类素材"处理，类型必须能从别处知道 ——
     所以没有清单时**要求**用户给一个：这种情况由调用方（对话框）先问，不该静默猜 */
  let raw = null
  let hadManifest = false
  try {
    const text = fs.readFileSync(path.join(from, 'manifest.json'), 'utf8')
    raw = JSON.parse(text)
    hadManifest = true
  } catch (err) {
    if (err && err.code && err.code !== 'ENOENT') {
      return { ok: false, error: `manifest.json 读不了：${err.message}` }
    }
  }
  if (!hadManifest) return { ok: false, error: '这个文件夹里没有 manifest.json（插件包需要说明它是边框还是贴纸）' }

  const norm = P.normalizeManifest(raw, path.basename(from))
  if (!norm.ok) return { ok: false, error: norm.error }
  const manifest = norm.manifest

  const files = collectPngs(from)
  if (!files.length) return { ok: false, error: '这个插件里一张 PNG 都没有' }

  const images = []
  const skipped = []
  for (const abs of files) {
    if (images.length >= P.MAX_IMAGES) {
      skipped.push(`${path.basename(abs)}（超出 ${P.MAX_IMAGES} 张上限）`)
      continue
    }
    let size = 0
    let head = null
    try {
      size = fs.statSync(abs).size
      /* 只读前 24 字节：读整个文件去判 PNG 头纯属浪费，一张 8K 的能到几十 MB */
      const fd = fs.openSync(abs, 'r')
      try {
        head = Buffer.alloc(24)
        fs.readSync(fd, head, 0, 24, 0)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      skipped.push(`${path.basename(abs)}（读不了）`)
      continue
    }
    if (size > P.MAX_BYTES) {
      skipped.push(`${path.basename(abs)}（${(size / 1048576).toFixed(1)}MB，超过 20MB）`)
      continue
    }
    const info = P.pngInfo(head)
    if (!info.ok) {
      skipped.push(`${path.basename(abs)}（${info.error}）`)
      continue
    }
    images.push({
      src: abs,
      /* 面板显示用的名字：原文件名去掉扩展名，太长的截断 */
      name: path.basename(abs, path.extname(abs)).slice(0, 30) || `图 ${images.length + 1}`,
      w: info.w,
      h: info.h
    })
  }
  if (!images.length) {
    return { ok: false, error: '没有一张能用的 PNG', skipped }
  }

  /* 落盘：先做在 `<root>/.tmp-<id>` 里，成了再整体替换 ——
     中途失败（磁盘满 / 权限）留下半个目录，会让面板显示一个残缺插件 */
  const target = path.join(root, manifest.id)
  const staging = path.join(root, `.tmp-${manifest.id}`)
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
  } catch (err) {
    return { ok: false, error: `建目录失败：${err.message}` }
  }

  const stored = []
  try {
    images.forEach((img, i) => {
      const name = `${String(i + 1).padStart(3, '0')}.png`
      copyInto(img.src, staging, name, from)
      stored.push({ file: name, name: img.name, w: img.w, h: img.h })
    })
  } catch (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      /* 清不掉就留着，下次安装会先 rm 一遍 */
    }
    return { ok: false, error: `复制图片失败：${err.message}` }
  }

  const record = {
    schema: manifest.schema,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    kind: manifest.kind,
    enabled: true,
    /* 重装同一个插件时保留原来的启停状态：用户关掉它是有意的，重新导入不该偷偷打开 */
    installedAt: new Date().toISOString(),
    images: stored
  }
  try {
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(record, null, 2), 'utf8')
  } catch (err) {
    return { ok: false, error: `写清单失败：${err.message}` }
  }

  try {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(staging, target)
  } catch (err) {
    return { ok: false, error: `装不上（目录可能被占用）：${err.message}` }
  }

  return { ok: true, plugin: { ...record, dir: target, imageCount: stored.length }, skipped }
}

/** 读盘上一个装好的插件（目录名是 id，清单里可能被改坏 ⇒ 全部兜底） */
function readOne(dir) {
  const id = path.basename(dir)
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
  const norm = P.normalizeManifest(raw, id)
  if (!norm.ok) return null
  const images = (Array.isArray(raw.images) ? raw.images : [])
    .map((img) => {
      const file = String((img && img.file) || '')
      /* 路径穿越校验：清单是用户可写的，`../` 能让面板读到盘上任意 PNG */
      if (!file || file.includes('/') || file.includes('\\') || file.startsWith('.')) return null
      const abs = path.join(dir, file)
      try {
        if (!fs.statSync(abs).isFile()) return null
      } catch {
        return null
      }
      return {
        file,
        name: String((img && img.name) || path.basename(file, '.png')),
        w: Number(img && img.w) > 0 ? Number(img.w) : 0,
        h: Number(img && img.h) > 0 ? Number(img.h) : 0,
        abs
      }
    })
    .filter(Boolean)
  return {
    ...norm.manifest,
    /* 目录名才是权威 id：清单里的 id 与目录不一致时，key 会指向不存在的分组 */
    id,
    enabled: raw.enabled !== false,
    installedAt: String(raw.installedAt || ''),
    dir,
    images,
    imageCount: images.length
  }
}

/** 列出全部已装插件（按拼音排，面板顺序不会跳） */
function listPlugins(deps = {}) {
  const root = pluginRootOf(deps)
  if (!root) return []
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const one = readOne(path.join(root, e.name))
    if (one && one.imageCount > 0) out.push(one)
  }
  return P.sortPlugins(out)
}

/** 启停。改的是我们自己的清单，写坏了大不了下次读时按"启用"处理 */
function setEnabled(id, on, deps = {}) {
  const root = pluginRootOf(deps)
  const key = String(id || '')
  if (!root || !P.ID_RE.test(key)) return { ok: false, error: 'id 不合法' }
  const file = path.join(root, key, 'manifest.json')
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, error: '这个插件不在了' }
  }
  raw.enabled = Boolean(on)
  try {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
  } catch (err) {
    return { ok: false, error: `写清单失败：${err.message}` }
  }
  return { ok: true }
}

/**
 * 卸载。走回收站而不是直接删 —— 插件是用户自己攒的素材，
 * 误点一下就永久没了是不可接受的（同 fs.rmSync 走回收站那条约定）。
 *
 * @param {object} deps `{ userData, trash }`；trash 由主进程注入 `shell.trashItem`
 */
async function remove(id, deps = {}) {
  const root = pluginRootOf(deps)
  const key = String(id || '')
  if (!root || !P.ID_RE.test(key)) return { ok: false, error: 'id 不合法' }
  const dir = path.join(root, key)
  if (!fs.existsSync(dir)) return { ok: false, error: '这个插件不在了' }
  const trash = typeof deps.trash === 'function' ? deps.trash : null
  if (!trash) return { ok: false, error: '当前环境没有回收站，已阻止删除' }
  try {
    await trash(dir)
  } catch (err) {
    return { ok: false, error: `删不掉（可能被占用）：${err.message}` }
  }
  return { ok: true }
}

/**
 * 组装给 `materialPack.readPack` 的额外分组。
 *
 * 只返回**已启用**的插件；已停用的插件必须从列表里消失而不是留着点不动 ——
 * 停用的意思是"它不许再影响这条时间线"。
 *
 * @returns {object[]} `[{ key, name, items:[{key,name,file,abs,w,h}] }]`
 */
function groupsOf(kind, deps = {}) {
  const want = String(kind || '')
  const plugins = listPlugins(deps).filter((p) => p.enabled && p.kind === want)
  return plugins.map((p) => ({
    key: P.groupKeyOf(p.id),
    /* 分组名带插件名，面板上就能看出"这组是我的插件"而不是内置素材 */
    name: p.name,
    items: p.images.map((img, i) => ({
      key: P.itemKeyOf(p.id, i),
      name: img.name,
      file: img.file,
      abs: img.abs,
      w: img.w,
      h: img.h
    }))
  }))
}

module.exports = { pluginRootOf, install, listPlugins, setEnabled, remove, groupsOf, MAX_PLUGINS }
