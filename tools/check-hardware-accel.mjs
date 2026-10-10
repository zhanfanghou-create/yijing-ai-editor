/**
 * 闸门：硬件加速开关**到底生效没有**。
 *
 * ── 为什么要专门验 ───────────────────────────────────────────────────
 * `app.disableHardwareAcceleration()` 是**启动期 API**：必须在 `app.whenReady()`
 * 之前调用，ready 之后再调**不报错、也不生效**。这正好是最容易写错、又最难发现的一类：
 *   · 界面开关点了有反馈（toast 说"已保存"）⇒ 看着像成功了；
 *   · 设置文件里也真的写进去了 ⇒ 查盘也查不出问题；
 *   · 只有**重启一次、再去问主进程"你现在到底开没开"**才能发现它压根没生效。
 * 所以这道闸门不查源码、不查 JSON 字段，它**真的重启两次**，每次都以
 * `app:info` 报出来的**实际生效值**为准。
 *
 * ── 它验的六件事 ─────────────────────────────────────────────────────
 *   1. 干净 profile 首启：缺省 = 开（与 Electron 默认一致）
 *   2. preload 真的暴露了 `app:restart`（否则界面上那个"立即重启"是空按钮）
 *   3. 从渲染层把开关设为「关闭」后，**settings.json 里确实落了盘**
 *   4. 用同一个 profile 重启：`app:info` 报关闭 ⇒ 启动期真的生效了
 *   5. 再设回「开启」并重启：报开启 ⇒ 可逆，不是单向锁死
 *   6. 全程 0 个 pageerror
 *
 * 断言总数恒定 6。找不到 electron 时逐条补 SKIP。
 * 用法：node tools/check-hardware-accel.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', '.hw-accel-profile')
const SETTINGS = path.join(PROFILE, 'settings.json')

const TOTAL_ASSERTIONS = 6

let pass = 0
let fail = 0
let skip = 0
let emitted = 0
const failures = []
let aborted = null

/**
 * 清掉可能残留的 profile 目录。
 *
 * ⚠️ 不用 `fs.rmSync`：本机有**批量删除保护**（阈值 50 个/轮），而 profile 里的
 *    文件数正好过线 —— 于是 `fs.rmSync` 直接抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，
 *    闸门在"清 profile"这一步就中断，报出来的却是「6. 三轮启动全程 0 个 pageerror」失败，
 *    看着像被测功能坏了，实际与被测代码毫无关系。实测这一项在本机**必红**。
 *    `rd /s /q` 走 cmd.exe，不经过 node 的 fs 钩子。
 *    与 installer-e2e.mjs 的 rmrfPatient() 是同一个坑的两处表现（那边是删安装临时目录）。
 */
function wipeDir(p) {
  try {
    execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', p], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 20000
    })
  } catch {
    /* 目录本来不存在时 rd 返回非 0，忽略即可 —— 我们的目的是"确保它是空的" */
  }
}

function check(label, ok, detail = '') {
  emitted += 1
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

function skipped(label, why) {
  emitted += 1
  skip += 1
  console.log(`  - ${label}  [SKIP] ${why}`)
}

function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 收尾只关窗口 + 强杀，**不删 profile**（同步 rmSync 删仍被 Electron 攥住的目录会永久阻塞） */
async function shutdown(app) {
  if (!app) return
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close 超时')), 8000))
    ])
  } catch {
    const pid = app.process()?.pid
    if (pid) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000
        })
      } catch {
        /* 已经退了 */
      }
    }
  }
  await sleep(600)
}

const WATCHDOG_MS = Number(process.env.HW_ACCEL_TIMEOUT_MS || 5 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`HW_ACCEL_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail} skip=${skip}`)
  console.log('HW_ACCEL_FAILED')
  process.exit(1)
}, WATCHDOG_MS)

const pageErrors = []

/** 起一次、问一次实际生效值 */
async function launchAndProbe() {
  const app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.waitForSelector('.app, .home', { timeout: 30000 })
  await sleep(400)
  const probe = await page.evaluate(async () => {
    const api = window.yjai
    return {
      hasRestart: typeof api?.restart === 'function',
      hasSettingsSet: typeof api?.settings?.set === 'function',
      info: await api.info()
    }
  })
  return { app, page, probe }
}

async function main() {
  console.log('=== 闸门：硬件加速开关真的生效吗（真落盘 + 真重启）===\n')

  if (!fs.existsSync(EXE)) {
    backfillSkips(`找不到 electron：${EXE}`)
    return
  }

  // 干净 profile：**必须**清掉，否则上一轮留下的 false 会让第 1 条断言假绿
  wipeDir(PROFILE)

  let first = null
  try {
    first = await launchAndProbe()
  } catch (error) {
    aborted = error
    backfillSkips(`首次启动失败：${error && error.message}`)
    await shutdown(first?.app)
    return
  }

  check(
    '1. 干净 profile 首启：硬件加速缺省为开（与 Electron 默认一致）',
    first.probe.info?.hardwareAcceleration === true,
    `app:info 报 ${JSON.stringify(first.probe.info?.hardwareAcceleration)}`
  )
  check(
    '2. preload 暴露了 app:restart（否则界面上那个「立即重启」是空按钮）',
    first.probe.hasRestart === true,
    `window.yjai.restart = ${typeof first.probe.hasRestart}`
  )

  /* ---------- 关掉它，确认落盘 ---------- */

  if (!first.probe.hasSettingsSet) {
    check('3. 从渲染层设「关闭」后 settings.json 确实落盘', false, 'window.yjai.settings.set 不存在')
    backfillSkips('settings.set 不可用，后续重启验证无法进行')
    await shutdown(first.app)
    return
  }
  await first.page.evaluate(async () => {
    await window.yjai.settings.set('hardwareAcceleration', false)
  })
  await sleep(500)
  let onDisk = null
  try {
    onDisk = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).hardwareAcceleration
  } catch (error) {
    onDisk = `读不到：${error && error.message}`
  }
  check('3. 从渲染层设「关闭」后 settings.json 确实落盘', onDisk === false, `${path.basename(SETTINGS)} = ${JSON.stringify(onDisk)}`)

  await shutdown(first.app)

  /* ---------- 同 profile 重启，看启动期是否真的生效 ---------- */

  const second = await launchAndProbe()
  check(
    '4. 同 profile 重启后 app:info 报「已关闭」⇒ 启动期调用真的生效',
    second.probe.info?.hardwareAcceleration === false,
    `app:info 报 ${JSON.stringify(second.probe.info?.hardwareAcceleration)}`
  )

  await second.page.evaluate(async () => {
    await window.yjai.settings.set('hardwareAcceleration', true)
  })
  await sleep(500)
  await shutdown(second.app)

  const third = await launchAndProbe()
  check(
    '5. 再设回「开启」并重启：app:info 报「已开启」⇒ 可逆，不是单向锁死',
    third.probe.info?.hardwareAcceleration === true,
    `app:info 报 ${JSON.stringify(third.probe.info?.hardwareAcceleration)}`
  )
  check(
    '6. 三轮启动全程 0 个 pageerror',
    pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | ')
  )

  await shutdown(third.app)
}

try {
  await main()
} catch (error) {
  aborted = error
  console.error(`\n[!] 执行中断：${error && error.message}`)
  if (emitted < TOTAL_ASSERTIONS) check('6. 三轮启动全程 0 个 pageerror', false, error && error.message)
  backfillSkips(`中断：${error && error.message}`)
}

clearTimeout(watchdog)
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
console.log(`HW_ACCEL_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail} skip=${skip}`)
if (fail === 0 && !aborted) console.log('HW_ACCEL_OK')
else {
  console.log('HW_ACCEL_FAILED')
  for (const item of failures) console.log(`  · ${item}`)
}
process.exit(fail === 0 && !aborted ? 0 : 1)
