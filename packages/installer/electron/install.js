'use strict'

/**
 * 安装主流程。
 *
 * 阶段划分（百分比区间由渲染层进度条与阶段列表共同消费）：
 *   verify    0 → 6    校验安装包完整性
 *   prepare   6 → 10   建目录、结束旧进程
 *   extract  10 → 85   7za 解压 app.7z（解析 7za 的 stdout 百分比）
 *   shortcut 85 → 93   创建快捷方式
 *   register 93 → 98   写卸载登记、生成卸载器、开机自启
 *   done        → 100
 */

const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const { APP_EXE, REQUIRED_GB } = require('./product')
const { verifyPayload, payloadArchive, sevenZipExe } = require('./payload')
const win = require('./win-integration')

const PHASES = [
  { key: 'verify', label: '校验安装包' },
  { key: 'prepare', label: '准备安装目录' },
  { key: 'extract', label: '释放主程序文件' },
  { key: 'shortcut', label: '创建快捷方式' },
  { key: 'register', label: '写入系统登记' },
  { key: 'done', label: '安装完成' }
]

async function freeSpaceGB(dir) {
  try {
    const drive = (String(dir).match(/^[A-Za-z]:/) || ['C:'])[0] + '\\'
    const s = await fs.promises.statfs(drive)
    return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3
  } catch {
    return null
  }
}

/**
 * @param {{targetPath:string, createDesktopShortcut:boolean, createStartMenuShortcut:boolean, autoStart:boolean}} opts
 * @param {(p:{percent:number,phase:string,label:string})=>void} onProgress
 * @param {(l:{level:'info'|'warn'|'error',text:string})=>void} onLog
 */
async function runInstall(opts, onProgress, onLog) {
  const report = (percent, phase, label) => onProgress({ percent: Math.max(0, Math.min(100, Math.round(percent))), phase, label })
  const log = (level, text) => onLog({ level, text })

  const target = path.resolve(opts.targetPath)

  // ---------------------------------------------------------- 1. 校验
  report(0, 'verify', '校验安装包')
  const check = verifyPayload()
  if (!check.ok) {
    log('error', check.error)
    throw new Error(check.error)
  }
  log('info', `安装包校验通过，主程序数据包 ${check.archiveMB.toFixed(1)} MB`)
  report(6, 'verify', '安装包校验通过')

  // ---------------------------------------------------------- 2. 准备
  report(7, 'prepare', '检查可用空间')
  const free = await freeSpaceGB(target)
  if (free !== null && free < REQUIRED_GB) {
    const msg = `目标磁盘可用空间不足：剩余 ${free.toFixed(2)} GB，需要 ${REQUIRED_GB} GB`
    log('error', msg)
    throw new Error(msg)
  }
  if (free !== null) log('info', `目标磁盘可用空间 ${free.toFixed(2)} GB`)

  try {
    await fs.promises.mkdir(target, { recursive: true })
  } catch (e) {
    const msg = `无法创建安装目录：${target}（${e.message}）`
    log('error', msg)
    throw new Error(msg)
  }

  // 可写性预检：避免解压到一半才发现权限不足
  try {
    const probe = path.join(target, `.yjai-write-test-${Date.now()}`)
    await fs.promises.writeFile(probe, 'ok')
    await fs.promises.rm(probe, { force: true })
  } catch {
    const msg = `安装目录不可写：${target}。请改用其他位置，或以管理员身份运行。`
    log('error', msg)
    throw new Error(msg)
  }

  log('info', `目标目录：${target}`)
  await win.closeRunningApp()
  report(10, 'prepare', '安装目录就绪')

  // ---------------------------------------------------------- 3. 解压
  const archive = payloadArchive()
  const sevenZip = sevenZipExe()
  log('info', `解压器：${sevenZip}`)
  log('info', `数据包：${archive}`)
  report(10, 'extract', '开始释放文件')

  await new Promise((resolve, reject) => {
    const proc = spawn(sevenZip, ['x', archive, `-o${target}`, '-y', '-bsp1', '-bso1'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let carry = ''
    proc.stdout.on('data', (chunk) => {
      carry += chunk.toString('utf8')
      const parts = carry.split(/[\r\n]+/)
      carry = parts.pop() || ''
      for (const line of parts) {
        const m = line.match(/(\d{1,3})%/)
        if (m) {
          const raw = Number(m[1])
          if (!Number.isNaN(raw)) {
            report(10 + Math.min(75, raw * 0.75), 'extract', `释放文件 ${raw}%`)
          }
        }
      }
    })
    let errBuf = ''
    proc.stderr.on('data', (chunk) => {
      errBuf += chunk.toString('utf8')
    })
    proc.on('error', (e) => reject(new Error(`无法启动解压器：${e.message}`)))
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      const tail = errBuf.trim().split(/[\r\n]+/).slice(-3).join(' / ')
      reject(new Error(`释放主程序文件失败（7-Zip 退出码 ${code}）${tail ? '：' + tail : ''}`))
    })
  })

  const exePath = path.join(target, APP_EXE)
  if (!fs.existsSync(exePath)) {
    const msg = `解压完成但未找到主程序 ${APP_EXE}，安装包可能已损坏。`
    log('error', msg)
    throw new Error(msg)
  }
  log('info', '主程序文件释放完成')
  report(85, 'extract', '主程序文件释放完成')

  // ---------------------------------------------------------- 4. 快捷方式
  report(86, 'shortcut', '创建快捷方式')
  const created = win.createShortcuts(target, opts)
  for (const p of created) log('info', `已创建快捷方式：${p}`)
  if (!created.length) log('warn', '未创建任何快捷方式')
  report(93, 'shortcut', '快捷方式处理完成')

  // ---------------------------------------------------------- 5. 系统登记
  report(94, 'register', '写入卸载登记')
  try {
    const uninst = win.writeUninstaller(target)
    log('info', `卸载器已生成：${uninst}`)
  } catch (e) {
    log('warn', `卸载器生成失败：${e.message}`)
  }
  try {
    await win.writeUninstallRegistry(target, opts.version)
    log('info', '卸载登记写入完成')
  } catch (e) {
    log('warn', `卸载登记写入失败：${e.message}`)
  }
  if (opts.autoStart) {
    try {
      await win.setAutoStart(target, true)
      log('info', '已设置为开机自启')
    } catch (e) {
      log('warn', `开机自启设置失败：${e.message}`)
    }
  } else {
    try {
      await win.setAutoStart(target, false)
    } catch {
      /* 无旧记录，忽略 */
    }
  }
  report(98, 'register', '系统登记完成')

  report(100, 'done', '安装完成')
  log('info', '安装完成')
}

module.exports = { runInstall, PHASES, freeSpaceGB }
