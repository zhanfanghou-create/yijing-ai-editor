#!/usr/bin/env node
/**
 * 把「已构建的桌面客户端产物目录」压缩为 payload/app.7z，供安装器释放。
 *
 * 用法：
 *   node scripts/pack-payload.mjs                       # 默认读 ../desktop/dist-app/win-unpacked
 *   node scripts/pack-payload.mjs <win-unpacked 目录>    # 显式指定
 *   node scripts/pack-payload.mjs --keep                # 保留旧压缩包（默认覆盖）
 *
 * 约定：payload/bin/7za.exe 必须存在（随包提交），它是安装阶段的解压器。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const installerRoot = path.resolve(__dirname, '..')
const payloadDir = path.join(installerRoot, 'payload')
const binDir = path.join(payloadDir, 'bin')

const args = process.argv.slice(2)
const sourceArg = args.find((a) => !a.startsWith('--'))
const source = sourceArg
  ? path.resolve(sourceArg)
  : path.resolve(installerRoot, '..', 'desktop', 'dist-app', 'win-unpacked')

function fail(msg) {
  console.error(`[pack-payload] ${msg}`)
  process.exit(1)
}

if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
  fail(`主程序目录不存在：${source}\n请先构建桌面客户端，或显式传入 win-unpacked 目录。`)
}

// 主程序可执行文件必须存在，否则打出来的包在安装后无法启动
const exeName = 'YiJingAIEditor.exe'
if (!fs.existsSync(path.join(source, exeName))) {
  const found = fs.readdirSync(source).filter((f) => f.toLowerCase().endsWith('.exe'))
  fail(`目录中未找到主程序 ${exeName}。实际存在：${found.join(', ') || '（无 exe）'}`)
}

const sevenZip = path.join(binDir, process.platform === 'win32' ? '7za.exe' : '7zz')
if (!fs.existsSync(sevenZip)) fail(`解压器不存在：${sevenZip}`)

// 校验 7za 是有效可执行文件（避免 0 字节 / 错误页导致安装阶段 ENOENT）
{
  const st = fs.statSync(sevenZip)
  const fd = fs.openSync(sevenZip, 'r')
  const head = Buffer.alloc(2)
  fs.readSync(fd, head, 0, 2, 0)
  fs.closeSync(fd)
  if (st.size < 100 * 1024 || head.toString('ascii') !== 'MZ') {
    fail(`解压器不是有效的 Windows 可执行文件：${sevenZip}（${st.size} 字节）`)
  }
}

fs.mkdirSync(payloadDir, { recursive: true })
fs.mkdirSync(binDir, { recursive: true })

const archive = path.join(payloadDir, 'app.7z')
if (!args.includes('--keep')) {
  try {
    fs.rmSync(archive, { force: true })
  } catch {
    /* ignore */
  }
}

console.log(`[pack-payload] 源目录   : ${source}`)
console.log(`[pack-payload] 压缩工具 : ${sevenZip}`)
console.log(`[pack-payload] 输出     : ${archive}`)

const t0 = Date.now()
// -mx=5 在体积与耗时之间取平衡；-ms=on 启用固实压缩，对大量小文件收益明显
const r = spawnSync(sevenZip, ['a', '-t7z', '-mx=5', '-ms=on', '-mmt=on', archive, path.join(source, '*')], {
  stdio: 'inherit'
})
if (r.status !== 0) fail(`7-Zip 压缩失败，退出码 ${r.status}`)

const sizeMB = fs.statSync(archive).size / 1024 / 1024
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`[pack-payload] 完成：${sizeMB.toFixed(1)} MB，耗时 ${secs}s`)

if (sizeMB < 20) {
  fail(`压缩包体积异常偏小（${sizeMB.toFixed(1)} MB），请检查源目录是否完整。`)
}
