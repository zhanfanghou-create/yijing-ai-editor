'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')

const { APP_NAME, APP_EXE, REG_KEY, APP_ID } = require('./product')
const { verifyPayload, payloadRoot, archiveSizeMB } = require('./payload')
const { runInstall, freeSpaceGB } = require('./install')
const win = require('./win-integration')

const isDev = process.env.NODE_ENV === 'development'

let mainWindow = null
let installing = false

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

// ---------------------------------------------------------------- 生命周期

process.on('uncaughtException', (err) => {
  send('installer:log', { level: 'error', text: `安装器异常：${(err && err.message) || String(err)}` })
})
process.on('unhandledRejection', (reason) => {
  send('installer:log', { level: 'error', text: `安装器未处理异常：${String(reason)}` })
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
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
