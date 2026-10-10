#!/usr/bin/env node
/**
 * 开发版启动器：拉起真实 Electron 窗口，走 5173 的渲染层 dev server（热更新）。
 *
 * 为什么单独写一个：主进程只有在 `YIJAI_USE_DEV_SERVER=1` 时才 loadURL 到 dev server
 * （见 packages/desktop/src/main/index.js:435），不带这个变量会去加载 dist-renderer 的
 * 构建产物 —— 表现是"改了代码没反应"，很难往环境变量上想。
 *
 * 用法：
 *   node tools/dev-launch.mjs            # 起窗口（detached，本脚本立即退出）
 *   node tools/dev-launch.mjs --front    # 前台跑，Ctrl+C 关窗口
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const APP = path.join(ROOT, 'packages', 'desktop')

const foreground = process.argv.includes('--front')

/* ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：本机 shell 环境里它被设成了 1（装/调试 node 工具链时留下），
   带着它 electron.exe 会退化成纯 node 去跑 main/index.js，`app` 是 undefined，
   报 "Cannot read properties of undefined (reading 'isPackaged')" —— 窗口根本不起来。 */
const env = { ...process.env, YIJAI_USE_DEV_SERVER: '1', YIJAI_DEV_URL: 'http://127.0.0.1:5173' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(EXE, [APP], {
  cwd: APP,
  env,
  stdio: foreground ? 'inherit' : 'ignore',
  windowsHide: true,
  detached: !foreground
})

child.on('error', (err) => {
  console.error('[dev-launch] 启动失败：', err.message)
  process.exit(1)
})

if (!foreground) {
  child.unref()
  console.log(`[dev-launch] 已拉起开发版窗口（pid=${child.pid}），渲染层走 http://127.0.0.1:5173`)
}
