'use strict'

/**
 * Windows 系统集成：快捷方式、注册表登记、开机自启、卸载器。
 *
 * 设计取舍 —— 全程不调用 PowerShell：
 *   快捷方式  -> Electron 原生 shell.writeShortcutLink()，天然支持 Unicode 路径
 *   注册表    -> execFile('reg.exe', [args...])，参数经 CreateProcessW 以 UTF-16 传递，
 *                中文值不会因为控制台代码页而乱码（这正是 PowerShell -Command 拼接的坑）
 *   结束进程  -> execFile('taskkill', [...])
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFile } = require('node:child_process')

const {
  APP_NAME,
  APP_EXE,
  REG_KEY,
  PUBLISHER,
  UNINSTALLER_NAME,
  UNINSTALL_KEY,
  AUTORUN_KEY
} = require('./product')

const isWin = process.platform === 'win32'

function run(file, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : 0, stdout: stdout || '', stderr: stderr || '', error: err || null })
      })
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: e })
    }
  })
}

// ---------------------------------------------------------------- 快捷方式

function desktopDir() {
  return path.join(os.homedir(), 'Desktop')
}

function startMenuDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME)
}

function publicDesktopDir() {
  return path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop')
}

/**
 * 创建快捷方式。返回已创建/已跳过的路径列表。
 * 注意：Windows 下若同名的「公共桌面」快捷方式存在，用户桌面会被覆盖语义影响，
 * 因此这里同时清理公共桌面上的同名 .lnk，保证可见性行为可预期。
 */
function createShortcuts(installDir, opts) {
  const { shell } = require('electron')
  const exe = path.join(installDir, APP_EXE)
  const created = []

  const make = (lnkPath) => {
    try {
      fs.mkdirSync(path.dirname(lnkPath), { recursive: true })
      const ok = shell.writeShortcutLink(lnkPath, 'create', {
        target: exe,
        cwd: installDir,
        description: `${APP_NAME} ${require('./product').APP_NAME_EN}`,
        icon: exe,
        iconIndex: 0,
        appUserModelId: require('./product').APP_ID
      })
      if (ok) created.push(lnkPath)
      return ok
    } catch {
      return false
    }
  }

  if (opts.createDesktopShortcut) {
    // 先清掉可能残留的公共桌面同名快捷方式，避免出现两个图标
    try {
      const pub = path.join(publicDesktopDir(), `${APP_NAME}.lnk`)
      if (fs.existsSync(pub)) fs.rmSync(pub, { force: true })
    } catch {
      /* 无权限则忽略 */
    }
    make(path.join(desktopDir(), `${APP_NAME}.lnk`))
  }
  if (opts.createStartMenuShortcut) {
    make(path.join(startMenuDir(), `${APP_NAME}.lnk`))
  }
  return created
}

function removeShortcuts() {
  const targets = [
    path.join(desktopDir(), `${APP_NAME}.lnk`),
    path.join(publicDesktopDir(), `${APP_NAME}.lnk`),
    path.join(startMenuDir(), `${APP_NAME}.lnk`)
  ]
  for (const p of targets) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true })
    } catch {
      /* ignore */
    }
  }
  try {
    const dir = startMenuDir()
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* ignore */
  }
}

/** 读取任一快捷方式的 TargetPath，用于反查历史安装目录 */
function readShortcutTarget(lnkPath) {
  try {
    if (!fs.existsSync(lnkPath)) return null
    const { shell } = require('electron')
    const info = shell.readShortcutLink(lnkPath)
    return info && info.target ? info.target : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 注册表

async function regAdd(name, type, value) {
  return run('reg.exe', ['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', String(value), '/f'])
}

async function writeUninstallRegistry(installDir, version) {
  const results = []
  results.push(await regAdd('DisplayName', 'REG_SZ', APP_NAME))
  results.push(await regAdd('DisplayVersion', 'REG_SZ', version || '1.0.0'))
  results.push(await regAdd('DisplayIcon', 'REG_SZ', path.join(installDir, APP_EXE)))
  results.push(await regAdd('InstallLocation', 'REG_SZ', installDir))
  results.push(await regAdd('Publisher', 'REG_SZ', PUBLISHER))
  results.push(await regAdd('UninstallString', 'REG_SZ', `"${path.join(installDir, UNINSTALLER_NAME)}"`))
  results.push(await regAdd('QuietUninstallString', 'REG_SZ', `"${path.join(installDir, UNINSTALLER_NAME)}" /quiet`))
  results.push(await regAdd('NoModify', 'REG_DWORD', 1))
  results.push(await regAdd('NoRepair', 'REG_DWORD', 1))
  results.push(await regAdd('EstimatedSize', 'REG_DWORD', 0))
  const failed = results.filter((r) => !r.ok)
  if (failed.length) throw new Error(`写入卸载登记失败（${failed.length} 项）`)
}

async function queryInstallLocation() {
  const r = await run('reg.exe', ['query', UNINSTALL_KEY, '/v', 'InstallLocation'])
  if (!r.ok) return null
  const m = r.stdout.match(/InstallLocation\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+(.+)/)
  return m && m[1].trim() ? m[1].trim() : null
}

async function deleteUninstallRegistry() {
  await run('reg.exe', ['delete', UNINSTALL_KEY, '/f'])
}

async function setAutoStart(installDir, enabled) {
  if (enabled) {
    const exe = path.join(installDir, APP_EXE)
    const r = await run('reg.exe', ['add', AUTORUN_KEY, '/v', REG_KEY, '/t', 'REG_SZ', '/d', `"${exe}"`, '/f'])
    if (!r.ok) throw new Error('写入开机自启失败')
  } else {
    await run('reg.exe', ['delete', AUTORUN_KEY, '/v', REG_KEY, '/f'])
  }
}

// ---------------------------------------------------------------- 进程

/** 结束正在运行的目标主程序，避免覆盖安装时 exe 被占用 */
async function closeRunningApp() {
  if (!isWin) return
  // taskkill 在无匹配进程时返回 128，属正常情况，不视为失败
  await run('taskkill', ['/IM', APP_EXE, '/F', '/T'], { timeout: 15000 })
  await new Promise((r) => setTimeout(r, 400))
}

// ---------------------------------------------------------------- 卸载器

/**
 * 生成 Uninstall.cmd（UTF-8 无 BOM + chcp 65001，避免中文乱码）。
 * 该脚本删除快捷方式、注册表项，然后延迟自删整个安装目录。
 */
function writeUninstaller(installDir) {
  const target = path.join(installDir, UNINSTALLER_NAME)
  const lines = [
    '@echo off',
    'chcp 65001 >NUL',
    'setlocal',
    `echo 正在卸载 ${APP_NAME} ...`,
    `taskkill /IM "${APP_EXE}" /F /T >NUL 2>&1`,
    'timeout /t 1 /nobreak >NUL',
    `del /Q "%USERPROFILE%\\Desktop\\${APP_NAME}.lnk" >NUL 2>&1`,
    `del /Q "%PUBLIC%\\Desktop\\${APP_NAME}.lnk" >NUL 2>&1`,
    `rmdir /S /Q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\${APP_NAME}" >NUL 2>&1`,
    `reg delete "${UNINSTALL_KEY}" /f >NUL 2>&1`,
    `reg delete "${AUTORUN_KEY}" /v "${REG_KEY}" /f >NUL 2>&1`,
    'echo 卸载完成。',
    `start "" cmd /c "timeout /t 1 /nobreak >NUL & rmdir /S /Q \\"${installDir}\\""`,
    'endlocal',
    'exit /b 0',
    ''
  ]
  fs.writeFileSync(target, lines.join('\r\n'), { encoding: 'utf8' })
  return target
}

module.exports = {
  createShortcuts,
  removeShortcuts,
  readShortcutTarget,
  writeUninstallRegistry,
  deleteUninstallRegistry,
  queryInstallLocation,
  setAutoStart,
  closeRunningApp,
  writeUninstaller,
  desktopDir,
  startMenuDir
}
