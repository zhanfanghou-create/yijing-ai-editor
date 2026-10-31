'use strict'

/**
 * 静默安装（无人值守）—— 让「艺镜·镜枢」这类智能体把本软件装进机器。
 *
 * 为什么需要单独一个文件：`electron/main.js` 一 require 就依赖 electron，
 * 参数解析这段纯逻辑没法单测。抽到这里之后 `tools/installer-silent-selftest.mjs`
 * 可以在普通 node 下把「参数 → 安装选项」逐条钉死。
 *
 * ── 为什么结果写文件而不是 stdout ──────────────────────────────
 * Windows 上 Electron 是 GUI 子系统：exe 被父进程以管道拉起时 **stdout 不连通**
 * （同一条实测见 `src/main/mcp-server.js` 文件头）。所以除了退出码，还要把
 * 结果 JSON 落到一个**确定的路径**上，调用方读文件拿详情。
 *
 * 退出码：0 成功 / 2 参数或环境问题 / 3 安装失败 / 4 已有实例在跑
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const RESULT_NAME = 'yijing-install-result.json'

/** 默认结果文件：优先 `--result`，否则 %TEMP% */
function defaultResultFile(tmpdir) {
  return path.join(tmpdir || os.tmpdir(), RESULT_NAME)
}

function argValue(argv, i, name) {
  const a = argv[i]
  if (a === name) return { value: argv[i + 1], used: 1 }
  if (a.startsWith(name + '=')) return { value: a.slice(name.length + 1), used: 0 }
  return null
}

/**
 * 解析命令行。**只有带了 --silent / -s / /S 才算静默**，
 * 其余参数（例如 Windows 资源管理器双击时可能带进来的文件路径）一律忽略，
 * 不会把正常图形安装带偏。
 *
 * @param {string[]} argv 一般传 process.argv.slice(1)
 * @param {{tmpdir?:string}} [env]
 */
function parseSilentArgs(argv = [], env = {}) {
  const list = Array.isArray(argv) ? argv.map(String) : []
  const silent = list.some((a) => a === '--silent' || a === '-s' || a === '/S' || a === '/s')
  const out = {
    silent,
    targetPath: '',
    shortcuts: true,
    register: true,
    autoStart: false,
    launch: false,
    resultFile: defaultResultFile(env.tmpdir),
    unknown: []
  }
  if (!silent) return out

  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const dir = argValue(list, i, '--install-dir')
    if (dir) {
      if (dir.value) {
        out.targetPath = String(dir.value).trim()
        i += dir.used
      }
      continue
    }
    const result = argValue(list, i, '--result')
    if (result) {
      if (result.value) {
        out.resultFile = path.resolve(String(result.value).trim())
        i += result.used
      }
      continue
    }
    if (a === '--no-shortcuts') {
      out.shortcuts = false
      continue
    }
    if (a === '--no-register') {
      out.register = false
      continue
    }
    if (a === '--autostart') {
      out.autoStart = true
      continue
    }
    if (a === '--launch') {
      out.launch = true
      continue
    }
    if (a === '--silent' || a === '-s' || a === '/S' || a === '/s' || a === '--no-launch') continue
    if (/^--/.test(a)) out.unknown.push(a)
  }
  return out
}

/** 静默模式的安装选项（与图形界面那条路喂给 runInstall 的形状一致） */
function installOptions(parsed, version) {
  const target = parsed.targetPath || ''
  return {
    targetPath: target,
    createDesktopShortcut: parsed.shortcuts,
    createStartMenuShortcut: parsed.shortcuts,
    autoStart: parsed.autoStart,
    register: parsed.register,
    version: version || ''
  }
}

/**
 * 原子写结果文件 —— 调用方可能在轮询这个文件，写一半就被读到会解析失败。
 * 写不进去不抛（此时退出码仍然有效），只返回 false。
 */
function writeResult(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

module.exports = {
  RESULT_NAME,
  defaultResultFile,
  parseSilentArgs,
  installOptions,
  writeResult
}
