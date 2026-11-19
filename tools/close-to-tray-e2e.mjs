/**
 * 「关闭窗口 → 缩到通知栏」的真机 E2E。
 *
 * 为什么必须有这道：这一改**改变了用户最熟悉的那一个操作**，而它的三种失效
 * 方式全都不报错：
 *   ① 拦截没接上 —— 点叉直接把软件关了（用户以为"没保存就没了"）；
 *   ② 拦得太死 —— 托盘的「退出」也退不掉，只能去任务管理器杀；
 *   ③ 叫不回来 —— 窗口隐藏了、托盘图标却不响应，软件变成孤儿进程。
 *
 * 判据一律取**消费端事实**：
 *   · `BrowserWindow.isVisible()` / `isDestroyed()` / `isMinimized()` / `isFocused()`；
 *   · `app.__yjaiRuntimeProbe()` 报的 Tray 运行时快照；
 *   · 调 `app.__yjaiTrayShow()`（托盘菜单与左键单击走的**同一个** show()）之后
 *     窗口是否回到可见 —— 而不是读源码里有没有那行；
 *   · 调 `app.__yjaiTrayExit()`（托盘菜单「退出」**那一项自己的 click**）之后进程还在不在。
 *
 * 断言总数恒为 15 = 3(启动态) + 4(点叉后) + 1(托盘仍在) + 2(叫回来)
 *   + 1(设置关掉后点叉就退出) + 1(无页面异常) + 3(另一个实例：点叉仍缩下去 /
 *   托盘「退出」真能退 / 退出码 0)。
 *
 * 用法：node tools/close-to-tray-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.tray-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 15
let emitted = 0
let pass = 0
let fail = 0
let skip = 0
const failures = []
const pageErrors = []

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    })
  ])
}

/** 轮询直到 `fn()` 返回真值；超时返回 null（判据由调用方自己给，别在这里兜底成"通过"） */
async function waitFor(fn, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() >= deadline) return null
    await sleep(200)
  }
}

/** 点叉（走窗口自己的 close 事件，而不是杀进程）；不抛：应用已经死了就如实返回 false */
async function closeWindow(app) {
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w && !w.isDestroyed()) w.close()
    })
    return true
  } catch {
    return false
  }
}

/** 触发托盘 show()（与托盘菜单、左键单击走的是同一个函数） */
async function invokeTrayShow(app) {
  try {
    return await app.evaluate(({ app: electronApp }) => {
      if (typeof electronApp.__yjaiTrayShow !== 'function') return { ok: false, why: '没有托盘 show 钩子' }
      electronApp.__yjaiTrayShow()
      return { ok: true }
    })
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) }
  }
}

/**
 * 触发托盘菜单的「退出」。
 *
 * ⚠️ 返回值**不作为判据**：`app.quit()` 会在这次 evaluate 还没返回时就开始拆窗口，
 * 调用本身很可能以 "Target closed" 拒绝 —— 那恰恰是成功的样子。
 * 真正的判据只看两件消费端事实：进程在不在、退出码是多少。
 */
async function invokeTrayExit(app) {
  try {
    return await app.evaluate(({ app: electronApp }) => {
      const fn = electronApp.__yjaiTrayExit
      if (typeof fn !== 'function') return { ok: false, why: '没有托盘退出钩子' }
      return fn()
    })
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e), maybeQuit: true }
  }
}

/** 启一个实例并等首页画出来 */
async function launchApp(profile) {
  fs.mkdirSync(profile, { recursive: true })
  const application = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  const page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForSelector('.home', { timeout: 30000 })
  return { app: application, page }
}

async function shutdown(app) {
  if (!app) return
  try {
    await withTimeout(app.close(), 8000, 'app.close')
    return
  } catch {
    /* 落到强杀 */
  }
  try {
    const pid = app.process()?.pid
    if (pid) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 可能已经退了 */
  }
  await sleep(400)
}

/**
 * 窗口的运行时事实。
 *
 * ⚠️ **失败必须返回"死掉了"这个事实，而不是抛异常。**
 * 第一版直接 `app.evaluate`，一旦应用提前退出就会抛 `Target page, context or browser
 * has been closed`，然后被外层 catch 一句 `failures.push` 收走 —— 而 `fail` 计数器
 * 不动 ⇒ 剩余 9 条全被 backfill 记成 SKIP、汇总行照打 `TRAY_E2E_PASSED`。
 * 实测就这样绿过一次（断言 3/12 通过、9 跳过），绿色掩盖了"点叉把软件关了"。
 * 现在每次都把 exitCode 带出来：进程是**优雅退出**（0）还是**崩了**（非 0），
 * 一眼可分，不用再猜。
 */
const winState = async (app) => {
  try {
    return await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows()
      const w = wins[0]
      if (!w) return { count: 0, visible: false, destroyed: true, minimized: false, focused: false }
      return {
        count: wins.length,
        visible: w.isVisible(),
        destroyed: w.isDestroyed(),
        /* ⚠️ Electron **没有** `isSkipTaskbar()`（只有 setter），读不到就别假装能读。
           判"是不是缩到托盘"改用 isMinimized：hide 与 minimize 在任务栏表现相近，
           但语义完全不同 —— 我们做的是 hide（任务栏按钮随之消失），不是 minimize。 */
        minimized: w.isMinimized(),
        focused: w.isFocused()
      }
    })
  } catch (e) {
    /* ⚠️ `app.process()` 本身也会抛：连接已经断了的时候 Playwright 内部
       再去取 `_object` 就是 undefined（实测 `Cannot read properties of
       undefined (reading '_object')`）。诊断代码不许比被测代码更脆。 */
    let exitCode = null
    try {
      const proc = app.process()
      exitCode = proc ? proc.exitCode : null
    } catch {
      exitCode = '未知（连接已断）'
    }
    return {
      count: 0,
      visible: false,
      destroyed: true,
      minimized: true,
      focused: false,
      dead: true,
      exitCode,
      why: String((e && e.message) || e)
    }
  }
}

/** 托盘运行时快照（主进程挂的只读钩子）；同样不抛，死了就报死 */
const trayState = async (app) => {
  try {
    return await app.evaluate(({ app: electronApp }) => {
      const fn = electronApp.__yjaiRuntimeProbe
      if (typeof fn !== 'function') return { missing: true }
      const snap = fn()
      const tray = (snap && snap.tray) || {}
      return { alive: Boolean(tray.alive), labels: tray.menuLabels || [], error: tray.error || '' }
    })
  } catch (e) {
    return { missing: true, dead: true, why: String((e && e.message) || e) }
  }
}

const WATCHDOG_MS = Number(process.env.TRAY_E2E_TIMEOUT_MS || 4 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完`)
  failures.push('看门狗超时')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

function summary() {
  console.log(`\n关闭到通知栏 E2E：${pass}/${TOTAL_ASSERTIONS} 通过，${fail} 失败，${skip} 跳过`)
  // verify.mjs 只认这一行（具名捕获 p/f/s/t），上面的中文汇总是给人看的
  console.log(`TRAY_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：')
    for (const item of failures) console.log(`  - ${item}`)
    console.log('TRAY_E2E_FAILED')
  } else {
    console.log('TRAY_E2E_PASSED')
  }
  return { pass, fail, skip }
}

let app = null
try {
  const first = await launchApp(PROFILE)
  app = first.app
  const page = first.page
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })

  /* ---------------- ① 启动态 ---------------- */

  const before = await winState(app)
  check('1. 启动后主窗口可见', before.count === 1 && before.visible === true, `visible=${before.visible}`)

  const tray1 = await trayState(app)
  check(
    '2. 托盘图标真的建起来了（运行时事实，不是源码里有那行）',
    tray1.missing ? false : tray1.alive === true,
    tray1.missing ? '没有自检钩子' : `alive=${tray1.alive}${tray1.error ? ' err=' + tray1.error : ''}`
  )
  check(
    '3. 托盘菜单里有「退出」（缩到托盘之后，这是唯一正经的退出口）',
    Array.isArray(tray1.labels) && tray1.labels.includes('退出'),
    (tray1.labels || []).join(' / ')
  )

  /* ---------------- ② 点叉 = 缩到通知栏 ---------------- */

  await closeWindow(app)
  await sleep(800)

  const after = await winState(app)
  check(
    '4. 点叉之后进程还活着（IPC 仍能往返）',
    after.count === 1 && !after.dead,
    after.dead ? `进程已不在：exitCode=${after.exitCode}` : `count=${after.count}`
  )
  check('5. 窗口没被销毁', after.destroyed === false, `destroyed=${after.destroyed}`)
  check('6. 窗口已隐藏（用户看不到了）', after.visible === false, `visible=${after.visible}`)
  check(
    '7. 是"隐藏"而不是"最小化"（最小化的窗口仍占任务栏，点一下又冒出来）',
    after.minimized === false,
    `minimized=${after.minimized}`
  )

  const tray2 = await trayState(app)
  check('8. 缩下去之后托盘图标仍在（不然就再也叫不回来）', tray2.alive === true, `alive=${tray2.alive}`)

  /* ---------------- ③ 从托盘叫回来 ---------------- */

  const invoked = await invokeTrayShow(app)
  /* ⚠️ 焦点不能用"睡 600ms 再读一次"来判。show()+focus() 之后前台权是**异步**交给
     窗口的（Windows 的 SetForegroundWindow 还要过一遍前台锁），机器忙一点就还没落地。
     实测同一个构建：单独跑 12/12（600ms 够），经 verify 串行跑就红在第 10 条 ——
     这正是"等 N 秒再看结果"的断言必须回答的那个问题：**慢一倍会怎样**。
     改成轮询到 6s（≈ 实测 600ms 的 10 倍），既不改判据也不留运气。 */
  const back = await waitFor(async () => {
    const st = await winState(app)
    return st.visible && st.focused ? st : null
  }, 6000)
  const backState = back || (await winState(app))
  check('9. 从托盘叫回来：窗口重新可见', invoked.ok && backState.visible === true, `visible=${backState.visible}`)
  check(
    '10. 叫回来之后窗口拿到了焦点（show()+focus() 的消费端证据）',
    backState.focused === true,
    backState.focused ? '' : `6s 内没拿到焦点（visible=${backState.visible} dead=${Boolean(backState.dead)}）`
  )

  /* ---------------- ④ 设置关掉之后点叉就是真退出 ---------------- */

  await page.evaluate(() => window.yjai.settings.set('closeToTray', false))
  await sleep(200)
  await closeWindow(app)
  await sleep(800)
  const gone = await winState(app)
  check(
    '11. 设置里选「退出程序」后，点叉真的关窗（证明设置不是摆设）',
    gone.dead === true || gone.count === 0 || gone.destroyed === true,
    gone.dead ? '进程已退出' : `count=${gone.count} destroyed=${gone.destroyed}`
  )

  check(
    '12. 全程没有页面异常（pageerror / console.error）',
    pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | ')
  )

  /* ---------------- ⑤ 托盘菜单的「退出」必须真能退 ---------------- */

  /* 为什么另起一个实例：④ 已经把上一个实例关掉了（那正是它要证明的事）。
     这一段测的是相反方向的事故 —— **拦得太死**：托盘「退出」被 close 拦截吃掉，
     用户点了没反应、只能去任务管理器杀进程。它比"没缩到托盘"难受得多，
     而且和 ④ 共用实例时测不出来（④ 已经让应用退出了）。 */
  await shutdown(app)
  app = null

  const profileB = path.join(os.tmpdir(), 'yjai-e2e', `.tray-exit-${process.pid}`)
  const second = await launchApp(profileB)
  app = second.app
  /* 退出之后 `app.process()` 本身会抛，先把进程引用攥在手里 */
  const procRef = app.process()
  await closeWindow(app)
  await sleep(600)
  const hiddenB = await winState(app)
  check('13. 换一个实例：点叉仍然缩下去（默认行为不依赖上一个实例）', hiddenB.visible === false && !hiddenB.dead, `visible=${hiddenB.visible}`)
  await invokeTrayExit(app)
  const goneB = await waitFor(async () => {
    const st = await winState(app)
    return st.dead ? st : null
  }, 8000)
  /* ⚠️ 必须包成对象再交给 poll：`exitCode === 0` 是**假值**，
     直接把 0 当"拿到了"会让轮询一路等到超时、最后报 `exitCode=null`（假红）。 */
  const codeB = await waitFor(() => {
    const v = procRef ? procRef.exitCode : null
    return v === null || v === undefined ? null : { code: v }
  }, 5000)
  const exitCodeB = codeB ? codeB.code : null
  check(
    '14. 托盘菜单的「退出」真的能退（拦得太死＝只能去任务管理器杀）',
    Boolean(goneB),
    goneB ? `exitCode=${exitCodeB}` : '8s 内进程仍在'
  )
  /* 退出码单独判：0 = 正常退出；非 0 表示走的是崩溃/强杀路径，
     那就不是"用户点退出"该有的结果。 */
  check('15. 退出码是 0（不是被杀或崩退）', exitCodeB === 0, `exitCode=${exitCodeB}`)
} catch (e) {
  console.error(`\n[异常] ${(e && e.stack) || e}`)
  /* ⚠️ **必须走 check(…, false)**，不能只 push 一句话。
     只 push 的话 `fail` 计数器不动，而 finally 里会把没跑到的条目一律记成 SKIP ——
     于是"断言 3 条通过 / 9 条跳过"照样打印 `TRAY_E2E_PASSED`。
     本闸门第一版就这样绿过一次，掩盖的正是"点叉把软件关了"这个最严重的情况。 */
  check('运行中出现异常（前面的通过项不算数，必须重跑）', false, String((e && e.message) || e))
} finally {
  clearTimeout(watchdog)
  await shutdown(app)
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, '前面有环节提前退出')
  const stats = summary()
  process.exitCode = stats.fail ? 1 : 0
}
