/**
 * 托盘运行时 E2E：真启 Electron，验「右下角通知区那个图标**真的建起来了**」。
 *
 * 为什么静态闸门（tools/check-app-icon-wiring.mjs）之外还要这一道：
 * 那道闸读的是**源码文本** —— `new Tray(` 在不在、路径是不是 `../../build/icon.ico`、
 * files 白名单有没有带上它。它证明"代码照这么写"，证明不了"这一版跑起来时图标真的出现了"。
 * 而 `createTray()` 是 try/catch **静默兜底**的（托盘建不起来绝不能让主窗口跟着挂），
 * 于是下面三种失败在真机上是**无声**的，静态闸门照样全绿：
 *   1. ico 没随包 / 路径算错 ⇒ 运行期文件不存在；
 *   2. 系统拒绝（会话无交互桌面、通知区被策略关掉）⇒ new Tray 抛异常被吞；
 *   3. 托盘建了又立刻销毁（`tray` 变量被 GC / 被 close 顺带清掉）⇒ 用户看不到。
 * 这三条只有**在主进程里读活对象**才能分辨，所以判据一律读 `runtimeProbe()` 返回的
 * 运行时事实（实例是否 alive、系统给的 bounds、真实 Menu 上的条目），不读源码字符串。
 *
 * 另一条硬约束也在这里兜：托盘**不许改关闭语义**。若哪天有人把 `close` 改成 `hide`
 * （很常见的"托盘常驻"做法），本文件的第 8 条会挂在"关不掉"上 —— 而这正是全套 E2E
 * 会集体卡死的那种改动，必须单独有一条盯着。
 *
 * 断言总数恒为 8：找不到 electron 时逐条补 SKIP。
 * 用法：node tools/tray-runtime-e2e.mjs
 *       TRAY_PROBE_DUMP=1 node tools/tray-runtime-e2e.mjs   # 打印探针原始值（校准判据用）
 */
import { _electron as electron } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ICON = path.join(ROOT, 'packages', 'desktop', 'build', 'icon.ico')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.tray-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 8
let emitted = 0
let pass = 0
let fail = 0
let skip = 0
const failures = []

function check(label, ok, detail = '') {
  emitted += 1
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`)
  }
}

function skipped(label, why) {
  emitted += 1
  skip += 1
  console.log(`  ⚠ ${label} — 跳过：${why}`)
}

function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    /* profile 被占用时删不掉，下轮换新目录名，不影响结论 */
  }
}

async function launch() {
  const app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForSelector('.home', { timeout: 30000 })
  return { app, page }
}

/** 主进程里调一次探针（函数不能跨进程传，必须在 evaluate 内部调用） */
async function readProbe(app) {
  return app.evaluate(({ app: electronApp }) => {
    const fn = electronApp.__yjaiRuntimeProbe
    if (typeof fn !== 'function') return { __missing: true }
    try {
      return fn()
    } catch (e) {
      return { __threw: String((e && e.message) || e) }
    }
  })
}

let watchdog = null

async function main() {
  console.log('=== 托盘运行时 E2E（真实 Electron）===\n')

  if (!fs.existsSync(EXE)) {
    backfillSkips(`找不到 electron：${EXE}`)
    return
  }

  rmrf(PROFILE)

  let app = null
  let page = null
  const pageErrors = []
  let closedInMs = null

  try {
    ;({ app, page } = await launch())
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })
    /* 托盘在 whenReady 里同步建，但图标落进通知区是系统动作，给它一点时间 */
    await sleep(600)

    const snap = await readProbe(app)
    if (process.env.TRAY_PROBE_DUMP) {
      console.log('\n[probe] ' + JSON.stringify(snap, null, 2) + '\n')
    }
    const tray = (snap && snap.tray) || {}

    /* 1. 钩子本身在：钩子没了说明这段自检被摘掉，后面七条全都会变成"无从判起" */
    check(
      '1. 主进程暴露了只读运行时探针（app.__yjaiRuntimeProbe）',
      !snap.__missing && !snap.__threw,
      snap.__missing ? '探针不存在：whenReady 里没挂上' : snap.__threw || ''
    )

    /* 2. 托盘真的建起来了 —— 这一条是整道闸的核心 */
    check(
      '2. 通知区托盘实例**真的建起来了**（不是 try/catch 静默兜底）',
      tray.created === true,
      `created=${tray.created} error=${tray.error || 'null'}`
    )

    /* 3. 与第 2 条配对：兜底没被触发过（区分"建成功"与"建失败但程序照跑"） */
    check(
      '3. 创建过程没有抛异常（静默兜底未被触发）',
      tray.created === true && !tray.error,
      tray.error ? `被吞掉的异常：${tray.error}` : ''
    )

    /* 4. 实例是活的 —— 建完立刻被销毁/GC 掉，用户那边同样是"没有图标" */
    check(
      '4. Tray 实例存活（isDestroyed() === false）',
      tray.alive === true,
      `alive=${tray.alive}`
    )

    /* 5. 系统真的给它分配了位置（消费端事实，不是源码里的路径字符串） */
    const bounds = tray.bounds || null
    check(
      '5. 系统给托盘分配了非零尺寸的位置（getBounds 有面积）',
      Boolean(bounds && Number(bounds.width) > 0 && Number(bounds.height) > 0),
      bounds ? `x=${bounds.x} y=${bounds.y} ${bounds.width}x${bounds.height}` : 'bounds=null'
    )

    /* 6. 图标文件在磁盘上真实存在且非空（路径算错时 new Tray 不一定抛，可能只画个空白） */
    let iconBytes = 0
    try {
      iconBytes = fs.statSync(ICON).size
    } catch {
      iconBytes = 0
    }
    check(
      '6. 托盘图标文件真实存在且非空（build/icon.ico）',
      iconBytes > 0 && String(tray.iconPath || '') === ICON,
      `bytes=${iconBytes} iconPath=${tray.iconPath || '(空)'}`
    )

    /* 7. 右键菜单的两个入口都在（读真实 Menu 对象上的条目，不是回显字面量） */
    const labels = Array.isArray(tray.menuLabels) ? tray.menuLabels : []
    check(
      '7. 托盘右键菜单有「显示主界面」与「退出」两项',
      labels.includes('显示主界面') && labels.includes('退出'),
      `menu=[${labels.join(' / ')}]`
    )

    /* 8. 托盘不许改关闭语义：关窗口必须还能退出（否则全套 E2E 与用户都会被卡住） */
    const t0 = Date.now()
    await Promise.race([app.close(), sleep(20000)])
    closedInMs = Date.now() - t0
    check(
      '8. 托盘存在时关闭窗口仍能正常退出（关闭语义没被改成 hide）',
      closedInMs < 15000,
      `退出耗时 ${closedInMs}ms`
    )
    app = null
    /* 页面错误不进断言（本闸只判托盘），但有就打印一行，别让它悄悄烂着 */
    if (pageErrors.length) console.log(`  · 附注：渲染层有 ${pageErrors.length} 条错误日志（不参与本闸判定）`)
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error && error.stack ? error.stack : error)}`)
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    clearTimeout(watchdog)
    if (app) {
      try {
        await Promise.race([app.close(), sleep(8000)])
      } catch {
        /* 落到强杀 */
      }
    }
    console.log(`\n测试用 Electron profile 保留不删（此刻文件仍被占用，删它会卡死主线程）：${PROFILE}`)
  }
}

function summary() {
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`TRAY_RUNTIME_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('TRAY_RUNTIME_E2E_FAILED')
    process.exitCode = 1
  } else {
    console.log('TRAY_RUNTIME_E2E_OK')
    process.exitCode = 0
  }
}

watchdog = setTimeout(async () => {
  console.error('\n[!] 超时：强行收尾')
  backfillSkips('超时未跑到')
  summary()
  process.exit(1)
}, Number(process.env.TRAY_E2E_TIMEOUT_MS || 4 * 60 * 1000))

main()
  .then(() => {
    summary()
    process.exit(process.exitCode || 0)
  })
  .catch((error) => {
    console.error(`[!] 未捕获：${String(error?.stack || error)}`)
    backfillSkips('未捕获异常')
    summary()
    process.exit(1)
  })
