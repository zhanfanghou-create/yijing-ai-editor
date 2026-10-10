/**
 * 安装器「外壳测试台」（仅测试用，不参与打包）。
 *
 * 为什么需要它：
 *   packages/installer/electron/main.js 的 getMeta 会调用
 *   win-integration.queryInstallLocation()，后者执行 reg.exe。
 *   在某些受限环境里 reg.exe 被进程级安全策略拦截，且拦截会直接终止整个进程树，
 *   连「只想截一张界面图」都做不到。
 *
 * 这个外壳用与 main.js **完全相同**的窗口参数和 preload 文件，
 * 只把 IPC 换成桩实现 —— 因此它照样能验证：
 *   · 窗口 650×360 / 650×560 的真实尺寸与 setBounds 行为
 *   · preload 暴露的 API 形状与通道名
 *   · 渲染层在真实 Electron 里的布局与交互
 *
 * 真实安装流程请用 packages/installer/electron/main.js（见 tools/installer-e2e.mjs）。
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const INSTALLER = path.join(ROOT, 'packages', 'installer')

const WIN_WIDTH = 650
const WIN_H_COLLAPSED = 360
const WIN_H_EXPANDED = 560

let mainWindow = null

const META = {
  appName: '艺镜AI剪辑',
  appId: 'com.yijing.aieditor',
  version: '1.0.0',
  defaultPath: 'C:\\Program Files\\YiJing AI Editor',
  isUpgrade: false,
  licenseText:
    '艺镜AI剪辑 最终用户许可协议\n\n' +
    '版本号：1.0.0\n\n' +
    '请在使用本软件前仔细阅读本协议。安装或使用本软件，即表示您已阅读、理解并同意本协议全部条款。\n\n' +
    '（本段文字由测试外壳提供，用于验证协议浮层的排版与滚动行为。）\n'.repeat(8),
  platform: 'win32',
  requiredGB: 2.0,
  payloadOk: true,
  payloadError: '',
  payloadMB: 77.2,
  payloadDir: path.join(INSTALLER, 'payload')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_H_COLLAPSED,
    minWidth: WIN_WIDTH,
    maxWidth: WIN_WIDTH,
    minHeight: WIN_H_COLLAPSED,
    maxHeight: WIN_H_EXPANDED,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: '#ffffff',
    title: '艺镜AI剪辑 安装程序',
    webPreferences: {
      preload: path.join(INSTALLER, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.loadFile(path.join(INSTALLER, 'dist-renderer', 'index.html'))
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

ipcMain.handle('installer:getMeta', async () => META)
ipcMain.handle('installer:pickDirectory', async () => null)
ipcMain.handle('installer:dirInfo', async () => ({ freeGB: 373, exists: false, ok: true }))
ipcMain.handle('installer:openPath', async () => true)
ipcMain.handle('installer:launchApp', async () => true)
ipcMain.handle('installer:minimize', async () => mainWindow && mainWindow.minimize())

ipcMain.handle('installer:setHeight', async (_e, height) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const h = Math.round(Number(height))
  if (!Number.isFinite(h) || h < WIN_H_COLLAPSED || h > WIN_H_EXPANDED) return false
  const b = mainWindow.getBounds()
  if (b.height === h) return true
  mainWindow.setBounds({ x: b.x, y: b.y, width: WIN_WIDTH, height: h })
  return true
})

// 桩安装：只发进度，不落盘、不碰注册表、不创建快捷方式。
// 通过环境变量 HARNESS_MODE 驱动不同终局，供取景脚本抓「安装中 / 完成 / 失败」三种版式：
//   fake（默认）  跑完整假进度后成功
//   installing   永远不返回，停在给定进度上
//   done         直接成功
//   error        直接返回失败原因
const HARNESS_MODE = process.env.HARNESS_MODE || 'fake'

ipcMain.handle('installer:start', async () => {
  const progress = (payload) => send('installer:progress', payload)

  if (HARNESS_MODE === 'error') {
    await new Promise((r) => setTimeout(r, 200))
    return { ok: false, reason: '目标磁盘可用空间不足：剩余 0.82 GB，需要 2.0 GB。请改用其他位置后重试。' }
  }

  if (HARNESS_MODE === 'done') {
    progress({ percent: 100, phase: 'done', label: '安装完成' })
    return { ok: true }
  }

  if (HARNESS_MODE === 'installing') {
    await new Promise((r) => setTimeout(r, 150))
    progress({ percent: 42, phase: 'extract', label: '释放主程序文件 42%' })
    send('installer:log', { level: 'info', text: '释放主程序文件 42%' })
    return new Promise(() => {}) // 永不结束，停在安装中
  }

  const steps = [
    [6, 'verify', '安装包校验通过'],
    [10, 'prepare', '安装目录就绪'],
    [45, 'extract', '释放文件 46%'],
    [85, 'extract', '主程序文件释放完成'],
    [93, 'shortcut', '快捷方式处理完成'],
    [98, 'register', '系统登记完成'],
    [100, 'done', '安装完成']
  ]
  for (const [percent, phase, label] of steps) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 240))
    progress({ percent, phase, label })
    send('installer:log', { level: 'info', text: label })
  }
  return { ok: true }
})

ipcMain.handle('installer:quit', async () => app.quit())

app.requestSingleInstanceLock()
app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
