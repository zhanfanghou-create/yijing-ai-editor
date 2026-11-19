'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')

const { APP_NAME, APP_EXE, REG_KEY, APP_ID } = require('./product')
const { verifyPayload, payloadRoot, archiveSizeMB } = require('./payload')
const { runInstall, freeSpaceGB } = require('./install')
const silent = require('./silent')
const win = require('./win-integration')

const isDev = process.env.NODE_ENV === 'development'

/** 智能体无人值守安装：带 --silent 就完全不开窗口，装完写结果文件并退出。
 *  也认 `YJAI_SETUP_*` 环境变量 —— 两条通道同时给（`ExecWait` 必然继承环境），
 *  命令行优先。排查历史见 silent.js 里 applyEnv 的注释。 */
const silentOpts = silent.parseSilentArgs(process.argv.slice(1), process.env)

let mainWindow = null
let installing = false

/**
 * 静默安装的**早期现场**（只在 `--silent` 下写）。
 *
 * 为什么需要：静默模式不开窗口，一旦在 `runSilentInstall` 走完之前就退出，
 * 调用方只看得到"结果文件没出现"这一个二值。2026-11-15 实测过一次真实翻车：
 * 客户端自动更新要拉起 `--silent`，而当时**带任何参数启动都以退出码 9 结束、连结果
 * 文件都不留**，完全查不出卡在哪一步。真因是宿主注入了 `ELECTRON_RUN_AS_NODE=1`
 * （安装器退化成纯 Node，主进程一行都跑不到）—— 但这套 trace 正是查出它的工具，
 * 以后遇到同类"点了没反应"也先看它。
 *
 * ⚠️ **非终态阶段绝不能写进结果文件**（2026-11-15 踩过，代价是整条 agent 安装链路红）。
 * 第一版把 `boot` / `started` 也覆盖写进 `--result` 指定的那个文件，注释还写着
 * "最后的结果会把它盖掉"—— 那句话只对**装完才读一次**的调用方成立。
 * 而 `yijing_install`（以及任何轮询式调用方）是"文件一出现就读"：
 * 它读到 `{phase:'started'}` 里面没有 ok / code / reason，于是判
 * `安装失败（code=undefined）：未知原因` —— 而安装器其实 3.9 秒就装成功了。
 * 现在只有两种情况写结果文件：`crash`（终态，能把"等到 300s 超时"变成一句可读
 * 的失败原因）与正常收尾（`writeResult` 由 runSilentInstall 自己写）。
 * 早期现场一律只进下面那份 append 日志。
 */
function silentTrace(phase, extra) {
  if (!silentOpts.silent) return
  if (phase === 'crash') {
    try {
      silent.writeResult(silentOpts.resultFile, {
        ok: false,
        code: 3,
        silent: true,
        reason: `安装器异常：${(extra && extra.reason) || '未知错误'}`,
        resultFile: silentOpts.resultFile
      })
    } catch {
      /* 写不进去还有下面的 append 日志 */
    }
  }
  /* 追加到一个固定路径：覆盖写的结果文件在进程被杀时只剩半截现场，
     这份 append 日志能回答"到底走到第几步"（拿到用户机器上排障时最省事） */
  try {
    const setupEnv = Object.keys(process.env)
      .filter((k) => k.startsWith('YJAI_SETUP_'))
      .map((k) => `${k}=${process.env[k]}`)
      .join(' ')
    const line = `${new Date().toISOString()}\t${phase}\t pid=${process.pid}\t argv=${JSON.stringify(process.argv.slice(1))}\t ${setupEnv}\n`
    fs.appendFileSync(path.join(os.tmpdir(), 'yjai-installer-trace.log'), line, 'utf8')
  } catch {
    /* 写不进去绝不能把安装带崩 */
  }
}

/* 顶层就落一份：这一行能证明"参数确实到了安装器进程"。
   反过来说——**这个文件不出现**，就说明连主进程都没跑起来（参数没到 / 进程被
   降级成纯 Node / 启动即崩），排查方向与"安装失败"完全不同。 */
silentTrace('boot')

// ---------------------------------------------------------------- 路径

function defaultInstallDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'Programs', APP_NAME)
  }
  return path.join('/Applications', `${APP_NAME}.app`)
}

function isRealInstall(dir) {
  try {
    return !!(dir && fs.existsSync(dir) && fs.existsSync(path.join(dir, APP_EXE)))
  } catch {
    return false
  }
}

/**
 * 反查历史安装目录（用于「升级安装」时预填路径）。
 * 顺序：命令行 --install-dir → 注册表 InstallLocation → 快捷方式 → 常见目录。
 */
async function findExistingInstallDir() {
  try {
    if (process.platform !== 'win32') {
      const macApp = path.join('/Applications', `${APP_NAME}.app`)
      return fs.existsSync(macApp) ? macApp : null
    }

    for (let i = 0; i < process.argv.length; i++) {
      const a = process.argv[i]
      if (a === '--install-dir' && process.argv[i + 1] && isRealInstall(process.argv[i + 1])) {
        return process.argv[i + 1]
      }
      if (a.startsWith('--install-dir=')) {
        const v = a.slice('--install-dir='.length)
        if (isRealInstall(v)) return v
      }
    }

    const fromReg = await win.queryInstallLocation()
    if (isRealInstall(fromReg)) return fromReg

    for (const lnk of [
      path.join(win.desktopDir(), `${APP_NAME}.lnk`),
      path.join(win.startMenuDir(), `${APP_NAME}.lnk`)
    ]) {
      const t = win.readShortcutTarget(lnk)
      if (t) {
        const dir = path.dirname(t)
        if (isRealInstall(dir)) return dir
      }
    }

    const candidates = [
      defaultInstallDir(),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', APP_NAME),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', APP_NAME),
      path.join(process.env.LOCALAPPDATA || '', APP_NAME),
      path.join('C:\\Program Files', APP_NAME),
      path.join('D:\\Program Files', APP_NAME),
      path.join('D:\\', APP_NAME)
    ]
    for (const dir of candidates) {
      if (isRealInstall(dir)) return dir
    }
    return null
  } catch {
    return null
  }
}

function readLicenseText() {
  const version = app.getVersion()
  const candidates = [
    path.join(__dirname, '..', 'resources', 'license.txt'),
    process.resourcesPath ? path.join(process.resourcesPath, 'license.txt') : ''
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        let text = fs.readFileSync(p, 'utf8')
        text = text.replace(/版本号?[：:]\s*[\d.]+/g, `版本号：${version}`)
        return text
      }
    } catch {
      /* ignore */
    }
  }
  return `${APP_NAME} 最终用户许可协议

版本号：${version}

请在使用本软件前仔细阅读本协议。安装或使用本软件，即表示您已阅读、理解并同意本协议全部条款。`
}

// ---------------------------------------------------------------- 窗口

/**
 * 窗口尺寸与参考安装器一致：收起 650×360，点「安装设置」后 650×560。
 * 高度由渲染层通过 installer:setHeight 驱动，宽度恒定。
 */
const WIN_WIDTH = 650
const WIN_HEIGHT = 360

function createWindow() {
  const winOpts = {
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: WIN_WIDTH,
    maxWidth: WIN_WIDTH,
    minHeight: WIN_HEIGHT,
    maxHeight: 560,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: '#ffffff',
    title: `${APP_NAME} 安装程序`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  }
  try {
    const iconPath = path.join(__dirname, '..', 'resources', 'icon.ico')
    if (fs.existsSync(iconPath)) winOpts.icon = iconPath
  } catch {
    /* ignore */
  }

  const w = new BrowserWindow(winOpts)
  w.setMenuBarVisibility(false)
  w.once('ready-to-show', () => w.show())

  // 安装器不需要新开窗口 / 外链导航
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    const isLocal = url.startsWith('file://') || url.startsWith('http://127.0.0.1:5190')
    if (!isLocal) e.preventDefault()
  })

  if (isDev) w.loadURL('http://127.0.0.1:5190/')
  else w.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'))

  mainWindow = w
  w.on('closed', () => {
    mainWindow = null
  })
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('installer:getMeta', async () => {
    const existing = await findExistingInstallDir()
    const payload = verifyPayload()
    return {
      appName: APP_NAME,
      appId: APP_ID,
      version: app.getVersion(),
      defaultPath: existing || defaultInstallDir(),
      isUpgrade: !!existing,
      licenseText: readLicenseText(),
      platform: process.platform,
      requiredGB: 2.0,
      payloadOk: payload.ok,
      payloadError: payload.error || '',
      payloadMB: archiveSizeMB(),
      payloadDir: payloadRoot() || ''
    }
  })

  ipcMain.handle('installer:pickDirectory', async (_e, current) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择安装位置',
      defaultPath: current || defaultInstallDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return null
    const chosen = res.filePaths[0]
    return path.basename(chosen) === APP_NAME ? chosen : path.join(chosen, APP_NAME)
  })

  ipcMain.handle('installer:dirInfo', async (_e, p) => {
    const freeGB = (await freeSpaceGB(p)) ?? 0
    return { freeGB, exists: !!p && fs.existsSync(p), ok: freeGB === 0 ? true : freeGB >= 2.0 }
  })

  ipcMain.handle('installer:start', async (_e, opts) => {
    if (installing) return { ok: false, reason: '安装已在进行中' }
    const check = verifyPayload()
    if (!check.ok) return { ok: false, reason: check.error }
    installing = true
    try {
      await runInstall(
        { ...opts, version: app.getVersion() },
        (p) => send('installer:progress', p),
        (l) => send('installer:log', l)
      )
      return { ok: true }
    } catch (e) {
      const msg = String((e && e.message) || e)
      send('installer:log', { level: 'error', text: msg })
      return { ok: false, reason: msg }
    } finally {
      installing = false
    }
  })

  ipcMain.handle('installer:openPath', async (_e, p) => {
    if (!p || !fs.existsSync(p)) return false
    const err = await shell.openPath(p)
    return !err
  })

  ipcMain.handle('installer:launchApp', async (_e, installDir) => {
    try {
      if (process.platform === 'win32') {
        const exe = path.join(installDir, APP_EXE)
        if (!fs.existsSync(exe)) return false
        spawn(exe, [], { detached: true, stdio: 'ignore', cwd: installDir }).unref()
      } else {
        spawn('open', [installDir], { detached: true, stdio: 'ignore' }).unref()
      }
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('installer:minimize', async () => mainWindow && mainWindow.minimize())

  /**
   * 展开/收起「安装设置」时调整窗口高度。
   * 只切换高度、不改宽度；每次以左上角为锚点重设 bounds，保证内容不跳动。
   */
  ipcMain.handle('installer:setHeight', async (_e, height) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const h = Math.round(Number(height))
    if (!Number.isFinite(h) || h < WIN_HEIGHT || h > 560) return false
    const b = mainWindow.getBounds()
    if (b.height === h) return true
    mainWindow.setBounds({ x: b.x, y: b.y, width: WIN_WIDTH, height: h })
    return true
  })

  ipcMain.handle('installer:quit', async () => app.quit())
}

// ---------------------------------------------------------------- 静默安装

/** 安装完成后拉起主程序（只有显式给 --launch 才做） */
async function launchInstalled(installDir) {
  try {
    if (process.platform === 'win32') {
      const exe = path.join(installDir, APP_EXE)
      if (!fs.existsSync(exe)) return false
      spawn(exe, [], { detached: true, stdio: 'ignore', cwd: installDir }).unref()
      return true
    }
    spawn('open', [installDir], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

/**
 * 无人值守跑完整个安装流程。
 * 结果一律落到 `--result`（默认 %TEMP%\yijing-install-result.json）：
 * GUI 子系统下 stdout 不连通，退出码只能表达成败，详情得靠这个文件。
 */
async function runSilentInstall() {
  const started = Date.now()
  const logs = []
  const version = app.getVersion()
  silentTrace('started')
  let target = silentOpts.targetPath
  try {
    if (!target) target = (await findExistingInstallDir()) || defaultInstallDir()
  } catch {
    target = target || defaultInstallDir()
  }
  const base = { silent: true, version, targetPath: target, resultFile: silentOpts.resultFile }
  const elapsed = () => Math.round((Date.now() - started) / 100) / 10

  try {
    const check = verifyPayload()
    if (!check.ok) throw new Error(check.error)
    logs.push(`info: 安装包校验通过（${check.archiveMB.toFixed(1)} MB）`)
    await runInstall(
      silent.installOptions({ ...silentOpts, targetPath: target }, version),
      (p) => logs.push(`[${p.percent}%] ${p.label}`),
      (l) => logs.push(`${l.level}: ${l.text}`)
    )
    const launched = silentOpts.launch ? await launchInstalled(target) : false
    silent.writeResult(silentOpts.resultFile, {
      ok: true,
      code: 0,
      ...base,
      exe: path.join(target, APP_EXE),
      launched,
      shortcuts: silentOpts.shortcuts,
      registered: silentOpts.register,
      seconds: elapsed(),
      logs: logs.slice(-60)
    })
    app.exit(0)
  } catch (e) {
    const reason = String((e && e.message) || e)
    silent.writeResult(silentOpts.resultFile, { ok: false, code: 3, ...base, reason, seconds: elapsed(), logs: logs.slice(-60) })
    app.exit(3)
  }
}

// ---------------------------------------------------------------- 生命周期

process.on('uncaughtException', (err) => {
  /* 静默模式下这是唯一的现场：不写下来，调用方只能看到"没装成" */
  silentTrace('crash', {
    reason: (err && err.message) || String(err),
    stack: String((err && err.stack) || '').slice(0, 1500)
  })
  send('installer:log', { level: 'error', text: `安装器异常：${(err && err.message) || String(err)}` })
})
process.on('unhandledRejection', (reason) => {
  silentTrace('crash', { reason: String(reason) })
  send('installer:log', { level: 'error', text: `安装器未处理异常：${String(reason)}` })
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 静默模式下别静默退出：调用方在等结果文件，留一份「有实例在跑」的说明。
  if (silentOpts.silent) {
    silent.writeResult(silentOpts.resultFile, {
      ok: false,
      code: 4,
      silent: true,
      reason: '已有安装器实例在运行',
      resultFile: silentOpts.resultFile
    })
    app.exit(4)
  } else {
    app.quit()
  }
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    if (silentOpts.silent) {
      // 无人值守：不开窗口、不建 dock，直接跑安装
      if (process.platform === 'darwin' && app.dock) app.dock.hide()
      runSilentInstall()
      return
    }
    // 启动即自检 payload，把问题提前暴露在「欢迎」页而不是安装到一半才失败
    const check = verifyPayload()
    if (!check.ok) console.error('[安装器] payload 自检失败：', check.error)
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
