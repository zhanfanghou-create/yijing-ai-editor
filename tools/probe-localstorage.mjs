/**
 * 一次性探针：打包客户端的 file:// 页面里 localStorage 到底能不能用。
 *
 * 为什么必须问这个问题：keymap.js 的持久化走 localStorage，
 * 而 Electron 是用 file:// 加载 dist-renderer 的。若该 origin 下 localStorage
 * 被禁（写入抛异常 / 写入成功但读回为空），表现就是"改完键位当场生效、重启回到默认"，
 * 界面不会报任何错。这一条不实测就只能是猜测。
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', '.probe-ls-profile')

fs.rmSync(PROFILE, { recursive: true, force: true })

const app = await electron.launch({
  executablePath: EXE,
  args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
})
const page = await app.firstWindow()
await page.waitForSelector('.home', { timeout: 30000 })

const out = await page.evaluate(() => {
  const report = { href: location.href, origin: location.origin, protocol: location.protocol }
  try {
    report.hasLocalStorage = typeof localStorage !== 'undefined' && localStorage !== null
  } catch (error) {
    report.hasLocalStorage = 'throw:' + String(error && error.message)
  }
  try {
    localStorage.setItem('yjai_probe', 'v1')
    report.writeOk = true
    report.readBack = localStorage.getItem('yjai_probe')
    localStorage.removeItem('yjai_probe')
  } catch (error) {
    report.writeOk = false
    report.writeError = String(error && error.message)
  }
  report.bridgeKeys = window.yjai ? Object.keys(window.yjai).join(',') : '(no bridge)'
  report.settingsGetType = window.yjai && window.yjai.settings ? typeof window.yjai.settings.get : '(none)'
  return report
})

console.log(JSON.stringify(out, null, 2))

// 顺便看看 settings 里当前存了什么
const settings = await page.evaluate(() => window.yjai.settings.get())
console.log('settings =', JSON.stringify(settings))

/* ⚠️ 裸 await app.close() 在这个环境永不返回（实测拖死整套一键验证 28 分钟），
   所以走「8 秒内正常关、超时 taskkill」的兜底 —— 与 draft-e2e 同一套。 */
let timer = null
try {
  await Promise.race([
    app.close().catch(() => {}).finally(() => timer && clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('app.close 超时')), 8000)
    })
  ])
} catch {
  const pid = app.process()?.pid
  if (pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 已经退了就算了 */
    }
  }
}
process.exit(0)
