/**
 * 音乐 / 音效的本地缓存：**路径与索引的纯逻辑**（不碰 electron、不碰网络）。
 *
 * 语义只有三条，其余全是它的推论：
 *   ① 清单（`musicCatalog.json`）随包发布，**永远在本地** —— 断网也能浏览分类、看到时长。
 *   ② 音频本体**不在包里**：用户点哪一条才抓哪一条，抓下来就永久留在本机
 *      （不做 LRU、不做过期、不自动清理 —— "永久"是给用户的承诺，
 *       一个会自己偷偷删本地文件的剪辑软件是不可接受的）。
 *   ③ 判断"缓存过没有"只认**磁盘上那个文件**（存在且非空），不认索引。
 *      索引只用来补时长/体积这类元信息；索引和文件打架时以文件为准。
 *
 * 为什么"只认文件"要写死：索引可能落后（上一次写到一半被杀）、
 * 也可能被用户手动清过；反过来，只要文件在，就一定能播 —— 这才是用户要的。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 缓存目录名（在 userData 下）。与「素材」「录制」同级，便于用户自己找 */
const CACHE_DIR = 'music-cache'
const INDEX_FILE = 'index.json'

function musicRootOf(userData) {
  return path.join(String(userData || '.'), CACHE_DIR)
}

/**
 * 一条清单条目落在磁盘上的文件名。
 *
 * ⚠️ 文件名只用 `id`（`sfx-1489` / `mus-127`）拼，**不用**中文名：
 *    中文名会随词表调整而变，一变文件名就变 ⇒ 已缓存的文件变成孤儿，
 *    用户看到"我明明缓存过、怎么又要下"。
 *    id 来自清单本身，是稳定的。
 */
function fileNameOf(item) {
  const id = String((item && item.id) || '').trim()
  if (!/^[a-z]+-\d+$/.test(id)) return ''
  const ext = String((item && item.ext) || 'mp3').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp3'
  return `${id}.${ext}`
}

function fileOf(root, item) {
  const name = fileNameOf(item)
  return name ? path.join(String(root || '.'), name) : ''
}

function sizeOf(file) {
  try {
    const st = fs.statSync(file)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

function readIndex(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(root || '.'), INDEX_FILE), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function writeIndex(root, map) {
  const file = path.join(String(root || '.'), INDEX_FILE)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    /* 先写临时文件再改名：中途被杀不会留下半个 JSON（半个 JSON 会让整份索引读不出来，
       于是"所有已缓存的条目都显示成未缓存"，而文件明明都在） */
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(map || {}, null, 1), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 一条清单条目在本机的状态。
 * `cached` 只由磁盘文件决定；`seconds` 优先取索引里实测的，其次用清单里标的。
 */
function stateOf(root, item, index) {
  const file = fileOf(root, item)
  const bytes = file ? sizeOf(file) : 0
  const meta = (index || {})[String((item && item.id) || '')] || {}
  return {
    id: String((item && item.id) || ''),
    cached: bytes > 0,
    bytes,
    path: bytes > 0 ? file : '',
    seconds: Number(meta.seconds) > 0 ? Number(meta.seconds) : Number((item && item.seconds) || 0)
  }
}

/** 整张清单的状态表：`{ [id]: state }`。面板一次拿全，不再逐条问 */
function statusOf(root, items) {
  const index = readIndex(root)
  const out = {}
  for (const item of Array.isArray(items) ? items : []) {
    const st = stateOf(root, item, index)
    if (st.id) out[st.id] = st
  }
  return out
}

/**
 * 清掉索引里"文件已经不在了"的条目。
 *
 * 只在读取状态时顺带做，不做删除动作 —— 这条函数**不碰音频文件**，
 * 它只是不让人在面板上看到"已缓存"却点不出声。
 */
function pruneIndex(root, items) {
  const index = readIndex(root)
  const alive = new Set((Array.isArray(items) ? items : []).map((item) => String((item && item.id) || '')))
  let changed = 0
  for (const id of Object.keys(index)) {
    const gone = !alive.has(id) || !sizeOf(path.join(String(root || '.'), `${id}.${(index[id] && index[id].ext) || 'mp3'}`))
    if (gone) {
      delete index[id]
      changed += 1
    }
  }
  if (changed) writeIndex(root, index)
  return changed
}

/** 记下一条的实测元信息（下载完成后调用） */
function remember(root, item, meta) {
  const index = readIndex(root)
  const id = String((item && item.id) || '')
  if (!id) return false
  index[id] = {
    seconds: Number(meta && meta.seconds) > 0 ? Number(meta.seconds) : Number((item && item.seconds) || 0),
    bytes: Number(meta && meta.bytes) > 0 ? Number(meta.bytes) : 0,
    ext: String((item && item.ext) || 'mp3'),
    at: new Date().toISOString()
  }
  return writeIndex(root, index)
}

/** 已占用的磁盘空间（面板上"已缓存 12 首 · 48 MB"用得到） */
function usageOf(root, items) {
  let count = 0
  let bytes = 0
  for (const item of Array.isArray(items) ? items : []) {
    const size = sizeOf(fileOf(root, item))
    if (size > 0) {
      count += 1
      bytes += size
    }
  }
  return { count, bytes }
}

module.exports = {
  CACHE_DIR,
  INDEX_FILE,
  musicRootOf,
  fileNameOf,
  fileOf,
  stateOf,
  statusOf,
  readIndex,
  writeIndex,
  pruneIndex,
  remember,
  usageOf
}
