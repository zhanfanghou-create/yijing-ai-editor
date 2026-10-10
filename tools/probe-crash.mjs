/**
 * 崩溃探针：起一次客户端，把 pageerror / console.error 全打出来再退出。
 * 用途：渲染层白屏时（`.app` / `.home` 等不到）先跑它，别靠猜。
 *
 * 用法：node tools/probe-crash.mjs
 */
import { _electron as electron } from 'playwright-core'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', '.desktop-profile')

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
delete env.YIJAI_USE_DEV_SERVER

const logs = []
const app = await electron.launch({
  executablePath: EXE,
  args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  cwd: ROOT,
  env
})
const page = await app.firstWindow()
page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)))
page.on('console', (m) => logs.push(`[console.${m.type()}] ` + m.text()))
await page.waitForTimeout(4000)
const html = await page.evaluate(() => document.body.innerHTML.slice(0, 300)).catch((e) => 'EVAL FAIL ' + e.message)
fs.writeFileSync(path.join(ROOT, '_evidence', 'probe-crash.log'), logs.join('\n') + '\n--- body ---\n' + html)
console.log('--- logs ---')
console.log(logs.slice(0, 20).join('\n') || '（无）')
console.log('--- body ---')
console.log(html)

/* 裸 await app.close() 在这台机器上不返回（MEMORY 记过），race + 强杀 */
await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 4000))])
process.exit(0)
