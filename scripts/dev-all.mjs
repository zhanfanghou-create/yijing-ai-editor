#!/usr/bin/env node
/**
 * 一键开发环境（npm run dev）：渲染层 dev server + Electron 客户端。
 *
 * 为什么需要它：客户端的开发模式要同时满足两个条件才成立 ——
 *   1) 渲染层 dev server 在 5173（热更新）
 *   2) 用 YIJAI_USE_DEV_SERVER=1 启动 Electron，主进程才会 loadURL 到 dev server
 *      （见 packages/desktop/src/main/index.js；不带这个变量会去加载 dist-renderer 的构建产物）
 * 两个终端手工敲很容易漏掉第 2 条，而漏掉的表现是"改了代码没反应"，很难往环境变量上想。
 *
 * 用法：
 *   npm run dev                     # 全起（会打开客户端窗口）
 *   npm run dev -- --services-only  # 只起渲染层 dev server，不开窗口
 *
 * 退出：Ctrl+C，或关掉客户端窗口 —— 两者都会被收干净。
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const NODE = process.execPath

const argv = process.argv.slice(2)
const servicesOnly = argv.includes('--services-only')

const RENDERER_URL = 'http://127.0.0.1:5173'

const children = []
let shuttingDown = false

function tag(name, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim()) console.log(`[${name}] ${line}`)
  }
}

function spawnChild(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd || root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...(opts.env || {}) },
    stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true
  })
  children.push({ name, child })
  if (opts.silent) {
    child.stdout.on('data', (d) => tag(name, d.toString('utf8')))
    child.stderr.on('data', (d) => tag(name, d.toString('utf8')))
  }
  child.on('exit', (code) => {
    if (shuttingDown) return
    console.log(`[dev] ${name} 已退出（code=${code}）`)
    if (name === '客户端') shutdown(0)
  })
  return child
}

function probe(url, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitReady(url, label, tries = 60) {
  for (let i = 1; i <= tries; i++) {
    if (await probe(url)) {
      console.log(`[dev] ${label} 就绪 ${url}（第 ${i} 次探测）`)
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`[dev] ${label} 在 ${(tries * 0.5).toFixed(0)} 秒内未就绪：${url}`)
  return false
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[dev] 正在收尾…')
  for (const { name, child } of children) {
    try {
      if (!child.killed && child.exitCode === null) {
        child.kill()
        console.log(`[dev] 已停止 ${name}`)
      }
    } catch {
      /* ignore */
    }
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function main() {
  console.log('[dev] 启动开发环境…')

  // 1) 渲染层 dev server（vite，端口见 packages/desktop/vite.config.mjs）
  if (await probe(RENDERER_URL)) {
    console.log(`[dev] 渲染层 dev server 已在跑，复用 ${RENDERER_URL}`)
  } else {
    spawnChild('渲染层', NODE, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {
      cwd: path.join(root, 'packages', 'desktop'),
      silent: true
    })
    if (!(await waitReady(RENDERER_URL, '渲染层 dev server'))) return shutdown(1)
  }

  if (servicesOnly) {
    console.log('\n[dev] --services-only：dev server 已就绪，未启动客户端窗口。Ctrl+C 退出。')
    return
  }

  // 2) 客户端：必须带 YIJAI_USE_DEV_SERVER=1，否则主进程会去加载 dist-renderer 的构建产物
  const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(electronExe)) {
    console.log(`[dev] 找不到 Electron：${electronExe}`)
    return shutdown(1)
  }
  spawnChild('客户端', electronExe, ['.', '--no-sandbox', '--disable-gpu'], {
    cwd: path.join(root, 'packages', 'desktop'),
    env: { YIJAI_USE_DEV_SERVER: '1', YIJAI_DEV_URL: RENDERER_URL, NODE_ENV: 'development' }
  })
  console.log('[dev] 客户端已拉起（关闭窗口或 Ctrl+C 结束）')
}

main().catch((e) => {
  console.error('[dev] 异常：', e && e.stack ? e.stack : e)
  shutdown(2)
})
