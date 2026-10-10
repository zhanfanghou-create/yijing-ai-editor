/**
 * 草稿存储（纯 Node，不依赖 electron）。
 *
 * 为什么单独成模块：MCP server 与主进程**都要读写同一批草稿文件**。
 * 两处各写一份的代价不是"多几行代码"，而是**两份规则迟早分叉**——
 * 一边夹了 id 长度、另一边没夹；一边先写临时文件再改名、另一边直接写。
 * 分叉的表现是"agent 建的草稿在软件里打不开"，而两边单独跑都是好的。
 * 所以规则只有这一份，主进程与 MCP server 都从这里取。
 *
 * 与 electron 的唯一耦合是**草稿根目录从哪来**：主进程用 `app.getPath('userData')`，
 * MCP server 用环境变量。所以这里把根目录做成**注入**的（传函数，因为没到 ready 时
 * 拿不到路径）。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 草稿 id 直接进文件名 ⇒ 必须限制字符集，挡掉路径穿越（`../`、盘符、分隔符） */
const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 草稿摘要：列表页/agent 都只认这几个字段，别把整个 data 抛出去 */
function draftSummary(record) {
  const clips = Array.isArray(record?.data?.clips) ? record.data.clips : []
  return {
    id: record.id,
    name: String(record.name || '未命名项目'),
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
    clipCount: clips.length,
    duration: clips.reduce((max, clip) => {
      const end = Number(clip.start || 0) + Number(clip.duration || 0)
      return Number.isFinite(end) && end > max ? end : max
    }, 0)
  }
}

/**
 * @param {() => string} getUserDataDir 返回 userData 绝对路径（延迟求值：ready 前拿不到）
 */
function createDraftStore(getUserDataDir) {
  const draftsDir = () => path.join(getUserDataDir(), 'drafts')

  const draftPath = (id) => {
    if (!DRAFT_ID_RE.test(String(id || ''))) throw new Error('草稿 id 不合法')
    return path.join(draftsDir(), `${id}.json`)
  }

  function list() {
    const dir = draftsDir()
    if (!fs.existsSync(dir)) return []
    const out = []
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'))
        if (record && typeof record === 'object' && record.id) out.push(draftSummary(record))
      } catch {
        /* 单个文件坏了不该让整张草稿列表挂掉 */
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  function save(payload) {
    const incoming = payload && typeof payload === 'object' ? payload : {}
    const id = DRAFT_ID_RE.test(String(incoming.id || '')) ? String(incoming.id) : `d${Date.now().toString(36)}`
    const file = draftPath(id)
    let previous = null
    try {
      previous = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      /* 首次保存 */
    }
    const now = new Date().toISOString()
    const record = {
      id,
      name: String(incoming.name || previous?.name || '未命名项目').slice(0, 120),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      data: incoming.data && typeof incoming.data === 'object' ? incoming.data : { clips: [] }
    }
    // 先写临时文件再改名：写到一半断电/被杀不会留下半个 JSON 把草稿弄丢
    fs.mkdirSync(draftsDir(), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8')
    fs.renameSync(tmp, file)
    return draftSummary(record)
  }

  function load(id) {
    // 白名单校验必须放在 try 外面。放在里面的话 draftPath 抛的"id 不合法"会被
    // catch 吞掉、和"文件不存在/内容坏了"混成同一个 null —— 调用方传错 id 时
    // 只表现成"打开后空空的"，查不出原因。（路径穿越本身是拦住的：文件根本没被读。）
    const file = draftPath(id)
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  function remove(id) {
    const file = draftPath(id)
    if (!fs.existsSync(file)) return false
    fs.rmSync(file, { force: true })
    return true
  }

  return { dir: draftsDir, pathOf: draftPath, list, save, load, remove }
}

module.exports = { createDraftStore, draftSummary, DRAFT_ID_RE }
