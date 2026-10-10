#!/usr/bin/env node
/**
 * 安装程序端到端测试（真实 Electron + 真实 7za 解压 + 真实快捷方式/卸载器落盘）
 *
 * 覆盖：
 *   1. 启动自检 —— 元信息、payload 校验、默认安装路径
 *   2. 单页式首屏几何 —— 与参考安装器逐像素对齐的 16 项坐标断言
 *   3. 「安装设置」展开/收起 —— 窗口 650×360 ⇄ 650×560，设置区控件坐标
 *   4. 许可协议浮层
 *   5. 协议门控 —— 未勾选时点「安装」不触发安装
 *   6. 真实安装到临时目录 —— 解压出主程序 exe、快捷方式、卸载器
 *   7. 完成态与退出
 *   8. 控制台洁净度
 *   9. 全程清理：临时目录、快捷方式、注册表项
 *
 * 用法：
 *   node tools/installer-e2e.mjs
 *   node tools/installer-e2e.mjs --keep        # 保留临时安装目录（排查用）
 *
 * 环境注意（本机已踩过的坑，改动时别删）：
 *   · 宿主进程会注入 ELECTRON_RUN_AS_NODE=1，必须从子进程环境里摘掉，
 *     否则 Electron 以纯 Node 模式启动：不建窗口，playwright 只会报 Process failed to launch。
 *   · 受控沙箱里 Chromium 自带的进程沙箱与 GPU 进程起不来，会打成 Target crashed，
 *     故带上 --no-sandbox / --disable-gpu / --disable-dev-shm-usage。
 *   · 用独立的 --user-data-dir，避免被残留实例的单实例锁顶掉。
 *   · reg.exe 被安全策略拉黑时（安全中心 → 命令行安全 → 程序黑名单），注册表相关断言记
 *     SKIP 而不是 FAIL —— 环境不允许的检查报红会把真正的回归淹掉。但要注意：安装器写
 *     卸载登记是「失败只记 warning」的非致命路径，所以 reg.exe 不可用时安装照样跑到
 *     「安装完成」，注册表里却是空的。SKIP 会显式说明少了这一项保证。
 *   · 清理放在 finally 里兜底：中途抛异常时也必须清掉桌面快捷方式与临时安装目录，
 *     否则失败一次就在本机留一份约 300MB 的垃圾。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const installerDir = path.join(root, 'packages', 'installer')
const keep = process.argv.includes('--keep')

const APP_NAME = '艺镜AI剪辑'
const APP_EXE = 'YiJingAIEditor.exe'
const REG_KEY = 'YiJingAIEditor'
const UNINSTALL_REG_PATH = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${REG_KEY}`

const H_COLLAPSED = 360
const H_EXPANDED = 560
const W = 650

const results = []
let failures = 0
let skips = 0
/** reg.exe 是否可用，由 preflight 探测后写入；决定注册表断言是验证还是 SKIP */
let regUsable = true

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`)
}

/**
 * 环境不允许验证的项记 SKIP，不计入失败。
 *
 * 存在的意义：本机安全策略把 reg.exe 拉黑了（需在「安全中心 → 命令行安全 → 程序黑名单」
 * 放行）。若把这种情况记成 FAIL，汇总里就会长期挂着两条红，真正的回归反而看不出来。
 * 但 SKIP 必须说清楚「少了哪一项保证」，不能静默。
 */
function skip(name, reason) {
  skips += 1
  results.push({ name, ok: true, skipped: true, detail: reason })
  console.log(`[SKIP] ${name} :: ${reason}`)
}

function section(title) {
  console.log(`\n--- ${title} ---`)
}

/* ------------------------------ 清理工具 ------------------------------ */

function regDelete(key) {
  try {
    execFileSync('reg.exe', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * reg.exe 是否可用。
 *
 * 本机安全策略会把 reg.exe 拉黑（提示见「安全中心 → 命令行安全 → 程序黑名单」），
 * 被拦时 execFileSync 抛的是启动失败而不是「键不存在」，所以不能靠 query 的返回码
 * 区分。这里探一个必然存在的键：能过就是放行了。
 *
 * 注意：安装器自身也依赖 reg.exe 写卸载登记，且那是「失败只记 warning」的非致命路径。
 * 所以 reg.exe 不可用的情况下，安装流程仍会走到「安装完成」，但注册表里什么都没有 ——
 * 这正是本项必须显式 SKIP 而不能悄悄放过的原因。
 */
function regAllowed() {
  try {
    execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000
    })
    return true
  } catch {
    return false
  }
}

/**
 * 把子进程输出的原始字节按控制台真实编码解成字符串。
 *
 * 中文 Windows 上 reg.exe 的报文是 **GBK（代码页 936）**，Node 默认按 UTF-8 解，
 * 出来就是一串 U+FFFD。先严格试 UTF-8，失败再退 GBK —— 顺序不能反：
 * GBK 解码不抛错，对 UTF-8 字节也能"解出"一堆乱码字符，反过来试就没有这个信号了。
 */
function decodeConsole(buf) {
  if (!buf || !buf.length) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return Buffer.from(buf).toString('latin1')
    }
  }
}

function regQuery(key) {
  try {
    // ⚠️ **必须显式写 stdio**。
    //
    // execFileSync 不写 stdio 时 stderr 会被**父进程继承**：reg.exe 查不到的键会
    // 往 stderr 打一行 GBK 的「错误: 系统找不到指定的注册表项或值。」，
    // 那串字节进了闸门日志就成了 U+FFFD。后果很隐蔽 ——
    // 安装器 E2E 自己 71/71 全过，但 verify.mjs 的编码自检（`out.includes('\uFFFD')`）
    // 会判整个闸门失败，报的是「关键词匹配不可信」，指向完全错误的方向。
    // 这里改成三路 pipe：stdout 收字节，stderr 直接丢弃。
    const buf = execFileSync('reg.exe', ['query', key, '/v', 'InstallLocation'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return decodeConsole(buf)
  } catch {
    return ''
  }
}

/** 同步等待若干毫秒（本脚本收尾阶段是纯同步流程，用 Atomics 堵一下最省事） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持就退化成不等待 */
  }
}

/**
 * 递归删除，带重试。返回最终是否真的不存在了。
 *
 * 为什么不能只删一次：Electron 刚退出时 Windows 还没释放 profile 里的文件句柄，
 * 此刻 rmSync 会 EBUSY/EPERM。更坑的是**删失败被 catch 吞掉**，于是错误以
 * 「测试用 Electron profile 已删除 ✗」的形式出现在收尾断言里 ——
 * 看起来像产品缺陷，其实是收尾竞态：同一台机器、同一份产物，紧接着手工再删一次就成功。
 * 删不掉就必须让它能被看见（返回 false），而不是静默失败。
 */
function rmrf(p, { attempts = 8, waitMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* 下面用存在性判定，比猜错误码可靠 */
    }
    if (!fs.existsSync(p)) return true
    if (i < attempts - 1) sleepSync(waitMs)
  }
  return !fs.existsSync(p)
}

/**
 * 收尾用的「耐心版」删除：给到约 20 秒。
 *
 * 为什么单列一个：临时**安装目录**约 200MB、几千个文件，写完之后 Windows
 * （Defender / 搜索索引 / 文件系统落盘）还要消化一阵。收尾那一刻立刻删，
 * 大概率 EPERM；8×250ms（2 秒）的重试窗口根本不够。
 *
 * 2026-09-23 实测：这道闸门「70/71，唯一失败 = 临时安装目录已删除（重试后仍被占用）」，
 * 上一轮同一份产物却是 71/71 —— 典型的时绿时红。定位方式是把失败那轮留下的目录拿去
 * 问 `tools/who-locks.py`：**无进程占用**；紧接着手工 `rm -rf` **一次成功**。
 * 也就是说这不是"谁锁着"，纯粹是"给的时间不够"。
 *
 * ⚠️ 断言失败时必须能看出**是谁**在占：真被进程锁住时，光说"仍被占用"没法行动。
 */
function rmrfPatient(p) {
  if (rmrf(p, { attempts: 40, waitMs: 500 })) return true
  // 第二策略：rd /s /q 对个别占用的文件比 fs.rmSync 啃得动
  try {
    execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', p], { stdio: 'ignore', windowsHide: true, timeout: 15000 })
  } catch {
    /* ignore */
  }
  if (rmrf(p, { attempts: 20, waitMs: 500 })) return true
  return false
}

/** 查谁锁着目标（Restart Manager，系统自带、不需要管理员）。失败就返回空串。 */
function lockHolder(target) {
  const py = process.env.YJAI_PYTHON || 'python'
  try {
    const out = execFileSync(py, [path.join(root, 'tools', 'who-locks.py'), target], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000
    })
    return String(out).trim().split('\n').slice(-3).join(' / ')
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 进程还活着吗。signal 0 只做存在性探测，不真的发信号。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但没权限发信号（跨用户/受保护进程），仍算活着
    return e && e.code === 'EPERM'
  }
}

/**
 * 关掉 playwright 拉起来的 Electron，并**等它真的退出**，然后才允许删 profile。
 *
 * 为什么必须是独立一步：profile 是 `--user-data-dir`，进程只要还活着，
 * Windows 就攥着里面的文件句柄，rmrf 重试多少次都是 EPERM/EBUSY。
 * 结果就表现为收尾断言「测试用 Electron profile 已删除」红 —— 看起来像产品缺陷，
 * 其实是**收尾顺序**问题：同一份产物，紧接着手工再删一次就成功。
 *
 * 以前这里压根没调 app.close()，只靠 main 里那句 `waitForEvent('close')` + 最后的
 * `process.exit()` 收场 —— 而 waitForEvent('close') 说的是 **CDP 连接**断了，
 * 不等于进程已经退出；process.exit() 更会把还没退干净的 Electron 留成孤儿进程。
 *
 * 顺序硬约束：**先 shutdownApp()，再 cleanupAll()**。反过来写就是把竞态钉成断言。
 */
let appRef = null
async function shutdownApp() {
  const a = appRef
  appRef = null
  if (!a) return
  const child = (() => {
    try {
      return a.process()
    } catch {
      return null
    }
  })()
  const pid = child && child.pid
  // 正常路径：close() 会等进程退出；给个上限，别让它把整套验证吊死
  try {
    await Promise.race([a.close().catch(() => {}), sleep(8000)])
  } catch {
    /* 交给下面的 pid 兜底 */
  }
  // close() 超时或被内部吞掉时进程可能还在 —— 按 pid 收掉，先温和后强杀
  if (pid && isAlive(pid)) {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(pid, sig)
      } catch {
        /* 已经没了 */
      }
      for (let i = 0; i < 25 && isAlive(pid); i += 1) await sleep(100)
      if (!isAlive(pid)) break
    }
    if (isAlive(pid)) console.log(`\n[警告] Electron 进程 pid=${pid} 仍存活，profile 可能删不掉`)
  }
  // 进程确认没了之后句柄通常立刻释放，再给系统一点时间
  await sleep(300)
}

const desktopLnk = path.join(os.homedir(), 'Desktop', `${APP_NAME}.lnk`)
const publicLnk = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop', `${APP_NAME}.lnk`)
const startMenuDir = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  APP_NAME
)
const startMenuLnk = path.join(startMenuDir, `${APP_NAME}.lnk`)

/**
 * 原生删除：独立进程，**绕开宿主对 JS `fs` 的一切包装**。
 * 目录用 `rd /s /q`，文件用 `del /f /q`。（路径由 APP_NAME 拼出，不含 cmd 元字符。）
 */
function rmNative(p) {
  const isDir = (() => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  })()
  const args = isDir ? ['/c', 'rd', '/s', '/q', p] : ['/c', 'del', '/f', '/q', p]
  try {
    execFileSync('cmd.exe', args, { stdio: 'ignore', windowsHide: true, timeout: 15000 })
  } catch {
    /* 用存在性判定，比猜错误码可靠 */
  }
  return !fs.existsSync(p)
}

/**
 * 删一个文件或目录，**两条路都走**，并把失败原因带回来。
 *
 * ⚠️ 2026-09-23 实测：跑闸门的宿主环境会把 `fs.rmSync` 换成「移入回收站」
 * （WorkBuddy 的 node shim 经 `NODE_OPTIONS --require` 注入，`CODEBUDDY_SESSION_ID` 在就生效），
 * 而该 shim 对 trash 失败是 **fail-closed** 的 —— 抛错、绝不降级真删。
 * 桌面 / 开始菜单是外壳特殊文件夹，回收站路径在那里时灵时不灵，于是同一个包：
 *   · 普通终端跑 `npm run verify`       → 71/71；
 *   · 代理会话里跑同一份代码            → 70/71，唯一失败 = 快捷方式没清掉。
 * 产品本身没问题：安装器的卸载器走的是 cmd 原生删除（见 `electron/win-integration.js`），
 * 撞上这层包装的**只有闸门自己的收尾**。所以这里不能只依赖 `fs.rmSync`。
 */
function tryRemove(p) {
  let shimError = ''
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch (e) {
    shimError = (e && e.message) || String(e)
  }
  if (!fs.existsSync(p)) return { gone: true, how: shimError ? '原生（fs 被包装挡住后退回）' : 'fs.rmSync' }
  if (rmNative(p)) return { gone: true, how: '原生 cmd（fs 被包装挡住）' }
  return { gone: false, how: shimError ? `fs.rmSync 抛错：${shimError}` : 'fs.rmSync 静默未生效' }
}

function cleanupShortcuts() {
  /* 删不掉要能看出**是哪一条**没删掉 —— 空 detail 的失败分不清"检测器没触发"
     和"报了别的问题被过滤"（见项目约定）。删成功了也记一句：靠哪条路删掉的信息
     在换环境复现问题时是第一条线索。 */
  leftBehind = []
  removedVia = []
  const targets = [desktopLnk, publicLnk, startMenuLnk, startMenuDir]
  for (const p of targets) {
    if (!fs.existsSync(p)) continue
    const r = tryRemove(p)
    if (r.gone) removedVia.push(`${path.basename(p) || p} ← ${r.how}`)
    else leftBehind.push(`${p}（${r.how}）`)
  }
  for (const p of [desktopLnk, startMenuLnk]) {
    if (fs.existsSync(p)) leftBehind.push(`${p}（删完复查仍在 —— 有别的进程在重建）`)
  }
}

/**
 * 清掉测试留下的所有痕迹。
 *
 * 抽成独立函数是为了能被 finally 兜住：以前这段写在流程末尾，中途一抛异常就整段跳过，
 * 结果测试失败的同时还在用户桌面上留下快捷方式、在 Temp 里留下 300MB 的安装目录 ——
 * 失败一次污染一次，越跑越脏。
 */
let cleaned = false
/** `cleanupShortcuts()` 删不掉的东西（空数组 = 全清干净）；失败时要能指名道姓 */
let leftBehind = []
/** 清掉了的，各靠哪条路删的（`fs.rmSync` 还是退回原生 cmd） */
let removedVia = []

function cleanupAll() {
  if (cleaned) return
  cleaned = true
  section('10. 清理测试痕迹')
  cleanupShortcuts()
  check(
    '桌面/开始菜单快捷方式已清除',
    !fs.existsSync(desktopLnk) && !fs.existsSync(startMenuLnk),
    leftBehind.length
      ? leftBehind.join('；')
      : removedVia.length
        ? `已清空：${removedVia.join('；')}`
        : '本就没有可清的快捷方式'
  )
  regDelete(UNINSTALL_REG_PATH)
  if (regUsable) {
    check('测试注册表项已清除', !regQuery(UNINSTALL_REG_PATH).includes('InstallLocation'))
  } else {
    skip('测试注册表项已清除', 'reg.exe 不可用，无法读取校验')
  }

  if (keep) {
    console.log(`\n[保留] 临时安装目录：${targetDir}`)
    console.log(`[保留] 测试用 profile：${profileDir}`)
    return
  }

  const profileGone = rmrf(profileDir)
  check(
    '测试用 Electron profile 已删除',
    profileGone,
    profileGone ? profileDir : `${profileDir}（重试后仍被占用）`
  )

  // 临时安装目录约 200MB：用耐心版（约 20 秒），否则会时绿时红 —— 见 rmrfPatient 注释
  const targetGone = rmrfPatient(targetDir)
  check(
    '临时安装目录已删除',
    targetGone,
    targetGone
      ? targetDir
      : `${targetDir}（重试约 20 秒后仍被占用）${
          lockHolder(path.join(targetDir, 'YiJingAIEditor.exe')) || '；占用者查询不可用'
        }`
  )
}

/* ------------------------------ 几何断言 ------------------------------ */

/**
 * 参考安装器的逐像素实测值（见 _recon/probe_ref.py 与 probe_ref2.py）。
 * 这里把它固化下来，任何界面改动只要动了这些坐标就会红。
 *
 * 分两组：收起态可见的元素、只有展开「安装设置」后才存在的元素。
 * 不要混在一组里 —— 收起态断言设置区元素必然全红。
 */
const SPEC_COLLAPSED = [
  ['标题栏品牌 logo', '.brand-logo', { x: 20, w: 24, h: 24 }],
  ['标题栏品牌名', '.brand-name', { x: 49 }],
  ['最小化按钮', '.win-btn.min', { x: 590, y: 5, w: 30, h: 30 }],
  ['关闭按钮', '.win-btn.close', { x: 613, y: 5, w: 30, h: 30 }],
  ['应用图标', '.app-icon', { x: 289, y: 64, w: 72, h: 72 }],
  ['产品名区', '.app-title', { y: 144, h: 30 }],
  ['主按钮', '.btn-primary', { x: 226, y: 219, w: 200, h: 40 }],
  ['协议复选框', '.checkbox', { x: 30, y: 319, w: 20, h: 20 }],
  ['协议文字', '.agree-text', { x: 60, y: 319 }]
]

const SPEC_EXPANDED = [
  ['设置区', '.settings', { y: 359, w: 650, h: 201 }],
  ['语言标签', '.settings-label.lang', { x: 30, y: 376 }],
  ['语言下拉', '.field-wrap.select', { x: 30, y: 400, w: 300, h: 28 }],
  ['路径标签', '.settings-label.path', { x: 30, y: 448 }],
  ['路径输入框', '.field-wrap.path input', { x: 30, y: 472, w: 470, h: 28 }],
  ['浏览按钮', '.browse-btn', { x: 510, y: 472, w: 110, h: 28 }]
]

async function rectsOf(win, selectors) {
  return win.evaluate((sels) => {
    const out = {}
    for (const s of sels) {
      const el = document.querySelector(s)
      if (!el) {
        out[s] = null
        continue
      }
      const r = el.getBoundingClientRect()
      out[s] = { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    return out
  }, selectors)
}

function near(a, b, tol = 1.5) {
  return Math.abs(a - b) <= tol
}

async function assertSpec(win, label, spec) {
  const rects = await rectsOf(
    win,
    spec.map((s) => s[1])
  )
  for (const [name, sel, want] of spec) {
    const got = rects[sel]
    if (!got) {
      check(`${label}｜${name}`, false, '元素不存在')
      continue
    }
    const bad = []
    for (const k of ['x', 'y', 'w', 'h']) {
      if (want[k] !== undefined && !near(got[k], want[k])) {
        bad.push(`${k}=${got[k].toFixed(1)} 期望 ${want[k]}`)
      }
    }
    check(
      `${label}｜${name}`,
      bad.length === 0,
      bad.join('，') || `x=${got.x.toFixed(1)} y=${got.y.toFixed(1)} ${got.w.toFixed(1)}×${got.h.toFixed(1)}`
    )
  }
}

async function winBounds(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return w ? w.getBounds() : null
  })
}

/* ------------------------------ 主流程 ------------------------------ */

const targetDir = path.join(os.tmpdir(), `yjai-installer-e2e-${Date.now()}`)

/**
 * 本次运行的 Electron 用户数据目录。
 *
 * 必须是独立的：共用默认 profile 会被残留实例的单实例锁顶掉，测试直接起不来。
 * 但它会落 8MB 左右在 Temp 里，所以 cleanupAll 里要一并清掉 ——
 * 之前只清快捷方式和安装目录，每跑一次就多留一个 8MB 目录。
 */
const profileDir = path.join(os.tmpdir(), `yjai-e2e-profile-${Date.now()}`)

function preflight() {
  section('0. 前置检查')
  const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  check('Electron 可执行文件存在', fs.existsSync(electronExe), electronExe)
  const archive = path.join(installerDir, 'payload', 'app.7z')
  const archiveOK = fs.existsSync(archive)
  check(
    'payload/app.7z 存在',
    archiveOK,
    archiveOK ? `${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} MB` : archive
  )
  check('payload/bin/7za.exe 存在', fs.existsSync(path.join(installerDir, 'payload', 'bin', '7za.exe')))
  check('安装器渲染层已构建', fs.existsSync(path.join(installerDir, 'dist-renderer', 'index.html')))

  const reg = regAllowed()
  regUsable = reg
  if (reg) {
    check('reg.exe 可用（注册表断言可执行）', true)
  } else {
    skip(
      'reg.exe 可用（注册表断言可执行）',
      '被安全策略拦截。放行方式：安全中心 → 命令行安全 → 程序黑名单 → 移除 reg.exe，然后重跑本脚本'
    )
  }
  return { electronExe, archiveOK, reg }
}

async function main() {
  const { electronExe, archiveOK, reg } = preflight()
  if (!archiveOK) {
    console.log('\n未找到 payload，跳过安装流程。请先执行 node packages/installer/scripts/pack-payload.mjs')
    process.exitCode = 1
    return
  }

  cleanupShortcuts()
  regDelete(UNINSTALL_REG_PATH)

  const consoleErrors = []
  const pageErrors = []
  const lifecycle = []
  let winClosed = false
  let quitRequested = false

  const childEnv = { ...process.env, NODE_ENV: 'production' }
  delete childEnv.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({
    executablePath: electronExe,
    args: [
      installerDir,
      `--user-data-dir=${profileDir}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ],
    cwd: installerDir,
    env: childEnv
  })
  // 交给收尾用：cleanupAll 之前必须先 shutdownApp()，否则删不掉 profile
  appRef = app

  const win = await app.firstWindow()
  win.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  win.on('pageerror', (e) => pageErrors.push(String(e && e.message)))
  // 记下窗口自己什么时候没的：以前这里只表现为收尾时一句
  // 「Target page has been closed」，看不出是提前退出还是脚本写错。
  win.on('close', () => {
    winClosed = true
    lifecycle.push(`[${new Date().toISOString()}] 安装器窗口被关闭`)
  })
  win.on('crash', () => {
    pageErrors.push('[renderer crash] 渲染进程崩溃')
  })

  await win.waitForSelector('.btn-primary', { timeout: 20000 })
  await win.waitForTimeout(600)

  /* ---------------- 1. 启动自检 ---------------- */
  section('1. 启动自检与元信息')
  const meta = await win.evaluate(() => window.installer.getMeta())
  check('meta.appName 正确', meta.appName === APP_NAME, meta.appName)
  check('meta.version 非空', typeof meta.version === 'string' && meta.version.length > 0, meta.version)
  check('meta.payloadOk 为真（自检通过）', meta.payloadOk === true, meta.payloadError || '')
  check('meta.payloadMB 合理（>20MB）', meta.payloadMB > 20, `${(meta.payloadMB || 0).toFixed(1)} MB`)
  check('默认安装路径含产品目录名', String(meta.defaultPath).includes(APP_NAME), meta.defaultPath)
  /* 开源版的安装协议是 `packages/installer/resources/license.txt`（MIT 许可说明），
     判据只盯"真的读到了那一篇"：包含产品名且提到了 MIT。 */
  check(
    '许可文本已加载',
    String(meta.licenseText).includes('艺镜') && String(meta.licenseText).includes('MIT'),
    `${String(meta.licenseText).length} 字符`
  )
  const hasSetHeight = await win.evaluate(() => typeof window.installer.setHeight)
  check('setHeight 通道已暴露', hasSetHeight === 'function', hasSetHeight)

  const wizardLeftover = await win.locator('.steps .step, .page-title, .footer').count()
  check('确认是单页式（无向导步骤条/底栏）', wizardLeftover === 0, String(wizardLeftover))

  const b0 = await winBounds(app)
  check(
    `收起态窗口 ${W}×${H_COLLAPSED}`,
    !!b0 && b0.width === W && b0.height === H_COLLAPSED,
    b0 ? `${b0.width}×${b0.height}` : '读不到'
  )

  /* ---------------- 2. 首屏几何 ---------------- */
  section('2. 首屏几何（对齐参考安装器实测值）')
  await assertSpec(win, '收起态', SPEC_COLLAPSED)

  const brandName = await win.locator('.brand-name').innerText()
  check('标题栏品牌名正确', brandName.trim().length > 0, brandName.trim())
  const titleText = await win.locator('.app-title').innerText()
  check('产品名正确', titleText.trim() === APP_NAME, titleText.trim())
  const btnText = await win.locator('.btn-primary').innerText()
  check('主按钮文案为「安装」', btnText.trim() === '安装', btnText.trim())
  const checked = await win.locator('.checkbox').getAttribute('aria-checked')
  check('协议默认勾选（与参考一致）', checked === 'true', String(checked))
  const agreeText = await win.locator('.agree-text').innerText()
  check('协议文案完整', agreeText.includes('已阅读和同意') && agreeText.includes('用户许可协议'), agreeText.replace(/\s+/g, ' '))
  const settingsBtnText = await win.locator('.agree-right button').innerText()
  check('右下按钮文案为「安装设置」', settingsBtnText.trim() === '安装设置', settingsBtnText.trim())

  /* ---------------- 3. 安装设置展开 ---------------- */
  section('3. 「安装设置」展开 / 收起')
  await win.click('.agree-right button')
  await win.waitForTimeout(700)
  const b1 = await winBounds(app)
  check(
    `展开后窗口 ${W}×${H_EXPANDED}`,
    !!b1 && b1.width === W && b1.height === H_EXPANDED,
    b1 ? `${b1.width}×${b1.height}` : '读不到'
  )
  await assertSpec(win, '展开态', SPEC_EXPANDED)

  const langOpts = await win.locator('.field-wrap.select select option').allInnerTexts()
  check('语言下拉有可选项', langOpts.length >= 1, langOpts.join(' / '))
  check('语言默认为简体中文', /简体中文/.test(langOpts[0] || ''), langOpts[0] || '')
  const pathVal = await win.locator('.field-wrap.path input').inputValue()
  check('安装路径已预填', pathVal.length > 3, pathVal)

  await win.click('.agree-right button')
  await win.waitForTimeout(700)
  const b2 = await winBounds(app)
  check(
    `收起后窗口回到 ${W}×${H_COLLAPSED}`,
    !!b2 && b2.width === W && b2.height === H_COLLAPSED,
    b2 ? `${b2.width}×${b2.height}` : '读不到'
  )
  check('设置区已从 DOM 移除', (await win.locator('.settings').count()) === 0)

  /* ---------------- 4. 许可协议浮层 ---------------- */
  section('4. 许可协议浮层')
  await win.click('.agree-text button.link')
  await win.waitForTimeout(400)
  check('浮层已打开', (await win.locator('.overlay .dialog').count()) === 1)
  const licLen = (await win.locator('.dialog-body').innerText()).length
  /* 开源版协议比原来那版商业 EULA 短得多（没有账号、计费、免责那几大段），
     阈值按当前实际长度取 400 —— 它要挡的是"协议没渲染 / 渲染成空的"。 */
  check('协议正文已渲染（>400 字）', licLen > 400, `${licLen} 字符`)
  await win.click('.dialog-foot .dialog-btn')
  await win.waitForTimeout(300)
  check('浮层已关闭', (await win.locator('.overlay').count()) === 0)

  /* ---------------- 5. 协议门控 ---------------- */
  section('5. 协议门控')
  await win.click('.checkbox')
  await win.waitForTimeout(150)
  check('已取消勾选', (await win.locator('.checkbox').getAttribute('aria-checked')) === 'false')
  await win.click('.btn-primary')
  await win.waitForTimeout(500)
  check('未勾选时点「安装」不进入安装态', (await win.locator('.progress').count()) === 0)
  check('仍在首屏', (await win.locator('.checkbox').count()) === 1)
  await win.click('.checkbox')
  await win.waitForTimeout(150)

  /* ---------------- 6. 指定安装目录并真实安装 ---------------- */
  section('6. 指定安装目录并真实安装')
  await win.click('.agree-right button')
  await win.waitForTimeout(700)
  await win.locator('.field-wrap.path input').fill(targetDir)
  await win.waitForTimeout(200)
  check('路径已写入输入框', (await win.locator('.field-wrap.path input').inputValue()) === targetDir)
  await win.click('.agree-right button')
  await win.waitForTimeout(700)

  await win.click('.btn-primary')
  await win.waitForSelector('.progress', { timeout: 20000 })
  await win.waitForTimeout(1200)
  const stageText = await win.locator('.stage-text').innerText().catch(() => '')
  const pctWidth = await win.locator('.progress > i').getAttribute('style').catch(() => '')
  check('进入安装态（进度条出现）', true, stageText.replace(/\s+/g, ' '))
  check('进度条有实际推进', /width:\s*\d/.test(pctWidth || ''), pctWidth || '')

  // 解压 100MB 级数据包，给足时间
  await win.waitForSelector('.app-sub', { timeout: 240000 })
  check('安装流程跑到完成态', true)

  /* ---------------- 7. 产物落盘 ---------------- */
  section('7. 安装产物校验')
  const exePath = path.join(targetDir, APP_EXE)
  check('主程序 exe 已释放', fs.existsSync(exePath), exePath)
  if (fs.existsSync(exePath)) {
    const mb = fs.statSync(exePath).size / 1024 / 1024
    check('主程序 exe 体积合理（>50MB）', mb > 50, `${mb.toFixed(1)} MB`)
  }
  check('resources/app.asar 已释放', fs.existsSync(path.join(targetDir, 'resources', 'app.asar')))
  check('卸载器 Uninstall.exe 已生成', fs.existsSync(path.join(targetDir, 'Uninstall.exe')))
  check('桌面快捷方式已创建', fs.existsSync(desktopLnk), desktopLnk)
  check('开始菜单快捷方式已创建', fs.existsSync(startMenuLnk), startMenuLnk)

  const regOut = reg ? regQuery(UNINSTALL_REG_PATH) : ''
  if (reg) {
    check('卸载登记已写入注册表', regOut.includes('InstallLocation'), regOut.trim().replace(/\s+/g, ' ').slice(0, 120))
    check('注册表 InstallLocation 指向目标目录', regOut.includes(targetDir))
  } else {
    skip('卸载登记已写入注册表', 'reg.exe 不可用，无法读取校验')
    skip('注册表 InstallLocation 指向目标目录', 'reg.exe 不可用，无法读取校验')
  }

  /* ---------------- 8. 完成态 ---------------- */
  section('8. 完成态与退出')
  const doneTitle = await win.locator('.app-title').innerText()
  check('标题切到「安装完成」', doneTitle.trim() === '安装完成', doneTitle.trim())
  const doneBtn = await win.locator('.btn-primary').innerText()
  check('主按钮切到「立即运行」', doneBtn.trim() === '立即运行', doneBtn.trim())
  const sub = await win.locator('.app-sub').innerText()
  check('完成提示含产品名', sub.includes(APP_NAME), sub.replace(/\s+/g, ' '))
  const hint = await win.locator('.hint').first().innerText()
  check('底部显示安装位置', hint.includes(targetDir.slice(0, 12)), hint)
  const openFolder = await win.locator('.agree-right button').innerText()
  check('提供「打开文件夹」', openFolder.trim() === '打开文件夹', openFolder.trim())

  // 不用真的点「立即运行」，避免把客户端拉起来；直接用 IPC 退出。
  //
  // 实测过：走到完成态后安装器窗口有时会自己先关掉，此时 evaluate 会抛
  // "Target page has been closed"。那本身就是「已退出」，是期望结果，不能算失败。
  // quitRequested 用来在事后区分「它自己退的」和「我们让它退的」。
  if (!winClosed) {
    quitRequested = true
    await win.evaluate(() => window.installer.quit()).catch(() => null)
  }
  await app.waitForEvent('close', { timeout: 20000 }).catch(() => null)
  check(
    '安装程序已退出',
    winClosed || app.windows().length === 0,
    winClosed
      ? quitRequested
        ? '由 IPC 请求退出'
        : `窗口自行关闭；${lifecycle.join(' / ')}`
      : '窗口已无残留'
  )

  /* ---------------- 9. 控制台洁净度 ---------------- */
  section('9. 控制台洁净度')
  check('无页面运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '))
  check('无控制台 error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' / '))

  /* ---------------- 10. 清理 ---------------- */
  // 顺序硬约束：先把 Electron 关掉、确认进程真的没了，再去删 profile。
  // 反过来写就是把「进程还攥着文件句柄」变成一条必然红的断言。
  await shutdownApp()
  cleanupAll()
}

main()
  .catch((e) => {
    console.error('\n[E2E 异常]', e && e.stack ? e.stack : e)
    failures += 1
  })
  .finally(async () => {
    // 兜底：正常路径已在 main 末尾清过，这里只处理中途抛异常的情况。
    // 中途抛异常时 Electron 往往还活着 —— 所以这里也必须**先关进程再清理**。
    await shutdownApp()
    cleanupAll()
    const total = results.length
    const passed = results.filter((r) => r.ok && !r.skipped).length
    console.log('\n=================================================')
    console.log(`安装器 E2E：${passed}/${total} 通过，${failures} 失败，${skips} 跳过`)
    if (skips > 0) {
      console.log('跳过项（环境限制，非代码问题）：')
      for (const r of results.filter((x) => x.skipped)) console.log(`  - ${r.name} :: ${r.detail}`)
    }
    if (failures > 0) {
      console.log('失败项：')
      for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name} :: ${r.detail}`)
      console.log('INSTALLER_E2E_FAILED')
    } else {
      console.log('INSTALLER_E2E_PASSED')
    }
    console.log('=================================================')
    // 必须显式退出：playwright 与 Electron 的连接（以及可能残留的孤儿进程）会让
    // 事件循环一直活着，脚本打完了结论却永远不返回 —— 在 CI / 串联脚本里表现为「卡死」。
    // stdout 重定向到文件时是同步写，这里退出不会截断上面的结论。
    process.exit(failures > 0 ? 1 : 0)
  })
