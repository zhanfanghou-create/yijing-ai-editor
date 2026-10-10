'use strict'

/**
 * payload 定位与解压器解析。
 *
 * payload 目录需同时包含：
 *   app.7z            主程序压缩包（由 scripts/pack-payload.mjs 生成）
 *   bin/7za.exe       解压器
 *
 * 打包后有两条可能路径：
 *   1. extraResources  -> <resources>/payload
 *   2. asarUnpack      -> <resources>/app.asar.unpacked/payload
 * 另外开发态直接读仓库内的 payload/。
 */

const path = require('node:path')
const fs = require('node:fs')

let cached = null

function isWin() {
  return process.platform === 'win32'
}

function sevenZipName() {
  return isWin() ? '7za.exe' : '7zz'
}

function candidateRoots() {
  const list = []
  if (process.env.NODE_ENV === 'development') {
    list.push(path.resolve(__dirname, '..', 'payload'))
  }
  try {
    const { app } = require('electron')
    const appPath = app && app.getAppPath && app.getAppPath()
    if (appPath) {
      list.push(path.join(path.dirname(appPath), 'app.asar.unpacked', 'payload'))
      list.push(path.join(appPath, '..', 'app.asar.unpacked', 'payload'))
    }
  } catch {
    /* 非 Electron 环境（脚本自检）忽略 */
  }
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'payload'))
  try {
    list.push(path.join(path.dirname(process.execPath), 'resources', 'payload'))
  } catch {
    /* ignore */
  }
  list.push(path.resolve(__dirname, '..', 'payload'))
  return list
}

function isValidRoot(dir) {
  try {
    return (
      !!dir &&
      fs.existsSync(dir) &&
      fs.existsSync(path.join(dir, 'app.7z')) &&
      fs.existsSync(path.join(dir, 'bin', sevenZipName()))
    )
  } catch {
    return false
  }
}

function payloadRoot() {
  if (cached) return cached
  for (const dir of candidateRoots()) {
    if (isValidRoot(dir)) {
      cached = dir
      return dir
    }
  }
  return null
}

function payloadArchive() {
  const root = payloadRoot()
  return root ? path.join(root, 'app.7z') : null
}

function sevenZipExe() {
  const root = payloadRoot()
  if (!root) return null
  return path.join(root, 'bin', sevenZipName())
}

function archiveSizeMB() {
  try {
    const p = payloadArchive()
    if (!p) return 0
    return fs.statSync(p).size / 1024 / 1024
  } catch {
    return 0
  }
}

/**
 * 安装前自检：文件存在 + 体积合理 + 7za 是 MZ 可执行文件。
 * 返回 { ok, error?, payloadDir?, archiveMB? }，任何一项不达标都给出可读原因。
 */
function verifyPayload() {
  const root = payloadRoot()
  if (!root) {
    return { ok: false, error: '未找到主程序数据包（app.7z），安装包可能不完整，请重新下载。' }
  }
  const archive = path.join(root, 'app.7z')
  const sz = path.join(root, 'bin', sevenZipName())
  const failures = []

  for (const [label, p, min] of [
    ['主程序数据包 app.7z', archive, 1024 * 1024],
    ['解压器 ' + sevenZipName(), sz, 100 * 1024]
  ]) {
    try {
      const st = fs.statSync(p)
      if (!st.isFile() || st.size < min) {
        failures.push(`${label} 体积异常（${st.size} 字节，期望 ≥ ${min}）`)
      }
    } catch {
      failures.push(`${label} 不存在`)
    }
  }

  if (!failures.length) {
    try {
      const fd = fs.openSync(sz, 'r')
      const head = Buffer.alloc(2)
      fs.readSync(fd, head, 0, 2, 0)
      fs.closeSync(fd)
      if (head.toString('ascii') !== 'MZ') failures.push('解压器不是有效的 Windows 可执行文件')
    } catch {
      failures.push('解压器无法读取')
    }
  }

  if (failures.length) return { ok: false, error: failures.join('；') + '。请重新下载安装包。' }
  return { ok: true, payloadDir: root, archiveMB: archiveSizeMB() }
}

module.exports = {
  payloadRoot,
  payloadArchive,
  sevenZipExe,
  archiveSizeMB,
  verifyPayload,
  isWin
}
