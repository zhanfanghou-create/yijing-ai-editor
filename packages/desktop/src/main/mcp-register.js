'use strict'
/**
 * 把「艺镜AI剪辑」注册进「艺镜·镜枢」的 MCP 配置。
 *
 * ── 为什么是"剪辑软件自己写"、而不是让镜枢去发现 ──────────────────
 * 镜枢启动时会读 `%APPDATA%\yegin\mcp.json` 的 `mcpServers`（见其 `mcp-client.cjs`），
 * 逐个 spawn 成 MCP server。它**不需要为剪辑软件改一行代码** —— 只要那份配置里
 * 有我们这一条。而"我们是谁、装在哪、草稿目录在哪"只有剪辑软件自己最清楚
 * （尤其 userData 是 `@yijing/desktop` 这种带作用域的怪名，靠镜枢猜必错）。
 * 所以由剪辑软件在启动时**把自己写进去**：两个软件都装好，镜枢下次启动即自动发现。
 *
 * ── 为什么 command 是 exe、还要带 ELECTRON_RUN_AS_NODE ─────────────
 * 实测（2026-10-10）：Windows 上 Electron 是 GUI 子系统，被管道拉起时 **stdin 立刻 EOF**，
 * 没法当 stdio server。必须让同一个 exe 以 `ELECTRON_RUN_AS_NODE=1` **当纯 Node** 跑，
 * 这时 stdio 才是标准 Node 行为。所以配置里 command=exe、args=脚本路径、
 * env 里带那个开关。用户**不需要额外安装任何东西** —— 用的就是已装好的 exe。
 *
 * 本模块**不依赖 electron**，路径全部注入，因此可以脱离应用单测。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 在镜枢 mcp.json 里的服务名（同时也是工具名前缀来源，别乱改） */
const SERVER_KEY = 'yijing-editor'

/**
 * 含空格/引号的路径要用双引号包起来。
 *
 * ⚠️ 镜枢的 client 在 Windows 上是 `shell: true` 起的（`mcp-client.cjs`），
 *    命令与参数会被拼成一条命令行 —— 裸空格会把 `C:\Program Files\...`
 *    从中间劈开，报"找不到文件"，看着像没装。安装目录通常没有空格，
 *    但用户名带空格时 `%LOCALAPPDATA%` 就有 —— 所以要防。
 */
function quoteIfNeeded(value) {
  const text = String(value || '')
  if (!text) return text
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

function mirrorConfigDir(appDataDir) {
  return path.join(appDataDir, 'yegin')
}

function mirrorConfigFile(appDataDir) {
  return path.join(mirrorConfigDir(appDataDir), 'mcp.json')
}

/**
 * 镜枢是否装过。
 * 判据一：它的 userData 目录（运行过至少一次就会有）—— 这同时也是我们要写进的那个目录。
 * 判据二：默认安装目录。两个都只是**便宜的目录存在性检查**，不去跑进程/查注册表
 *        （本机 spawnSync 走管道恒 EBUSY，查注册表那条路不可靠）。
 */
function isMirrorPresent(appDataDir, localAppDataDir) {
  const candidates = [mirrorConfigDir(appDataDir)]
  if (localAppDataDir) candidates.push(path.join(localAppDataDir, 'Programs', 'Yegin'))
  return candidates.some((dir) => {
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 注册（合并写入，绝不覆盖别人的 server 条目）。
 *
 * @param {object} input
 * @param {string} input.appDataDir     如 %APPDATA%
 * @param {string} input.localAppDataDir 如 %LOCALAPPDATA%（可选，用于安装目录探测）
 * @param {string} input.execPath       应用 exe 的绝对路径（process.execPath）
 * @param {string} input.serverScript   mcp-server.js 的绝对路径
 * @param {string} input.userDataDir    草稿根目录的父目录（app.getPath('userData')）
 * @param {boolean} [input.force]       true=不检查镜枢是否在场，强制写（测试用）
 * @returns {{written:boolean, changed:boolean, reason:string, file:string}}
 */
function registerMcpServer(input = {}) {
  const { appDataDir, localAppDataDir, execPath, serverScript, userDataDir } = input
  const file = appDataDir ? mirrorConfigFile(appDataDir) : ''
  const out = { written: false, changed: false, reason: '', file }

  if (!appDataDir || !execPath || !serverScript) {
    out.reason = 'missing-input'
    return out
  }
  if (!input.force && !isMirrorPresent(appDataDir, localAppDataDir)) {
    out.reason = 'mirror-not-installed'
    return out
  }

  let doc = {}
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* 没有 / 坏了都当空文档，重建即可 —— 这是"配置"不是"数据"，丢了能再生成 */
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {}
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object' || Array.isArray(doc.mcpServers)) {
    doc.mcpServers = {}
  }

  const entry = {
    command: quoteIfNeeded(execPath),
    args: [quoteIfNeeded(serverScript)],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
  if (userDataDir) entry.env.YIJAI_USER_DATA = userDataDir

  const before = JSON.stringify(doc.mcpServers[SERVER_KEY] || null)
  const after = JSON.stringify(entry)
  doc.mcpServers[SERVER_KEY] = entry

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    out.reason = 'write-failed:' + String(e && e.message)
    return out
  }

  out.written = true
  out.changed = before !== after
  out.reason = out.changed ? 'updated' : 'unchanged'
  return out
}

module.exports = { registerMcpServer, isMirrorPresent, mirrorConfigFile, mirrorConfigDir, SERVER_KEY, quoteIfNeeded }
