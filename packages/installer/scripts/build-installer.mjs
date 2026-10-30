#!/usr/bin/env node
/**
 * 一键出安装包：
 *   1) 构建桌面客户端渲染层      (vite build  -> packages/desktop/dist-renderer)
 *   2) 打包客户端免安装目录      (electron-builder --dir -> packages/desktop/dist-app/win-unpacked)
 *   3) 压缩为主程序数据包        (payload/app.7z)
 *   4) 构建安装器渲染层          (vite build  -> packages/installer/dist-renderer)
 *   5) 生成安装器单文件 exe      (electron-builder portable -> packages/installer/dist-installer)
 *
 * 用法：
 *   node packages/installer/scripts/build-installer.mjs
 *   node packages/installer/scripts/build-installer.mjs --skip-app     # 跳过 1~3 步，只重出安装器
 *   node packages/installer/scripts/build-installer.mjs --skip-installer
 *   node packages/installer/scripts/build-installer.mjs --app-out <目录> --installer-out <目录>
 *
 * 为什么中间产物可能落到工作区外（重要，别"顺手优化"掉）：
 *   electron-builder 打包第一步是「清空输出目录」。实测发现，只要工程目录里存在
 *   win-unpacked/resources/app.asar，IDE/宿主就会打开它做 asar 扫描并一直持有句柄，
 *   且该句柄不允许删除（Win32 DeleteFileW 返回 err=32 共享冲突；父目录也改名不了，err=5）。
 *   于是"同一个输出目录构建第二次"必定失败，严重时 go-fs-util 会静默卡十几分钟。
 *
 *   同一个 app.asar 放到工作区外则完全不被占用（已实测对照），所以这里在检测到默认输出
 *   目录被占时，自动把中间产物改落到系统临时目录下的 yjai-build/。最终交付物
 *   （payload/app.7z 与安装器 exe）都不带这个锁，仍按原路径落回仓库。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const installerRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(installerRoot, '..', '..')
const desktopRoot = path.join(repoRoot, 'packages', 'desktop')

const args = process.argv.slice(2)
const skipApp = args.includes('--skip-app')
const skipInstaller = args.includes('--skip-installer')

/** 取 `--flag value` 形式的参数值 */
function argValue(flag, fallback) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}

/** 显式传入的输出目录（未传则 undefined，交给 resolveOutputDir 自动决定） */
const appOutArg = argValue('--app-out', undefined)
const installerOutArg = argValue('--installer-out', undefined)

/** 是否至少有一次落到了工作区外的临时目录（末尾据此提示中间产物位置） */
let usedScratch = false

/**
 * 决定中间产物的输出目录。
 *
 * 优先用仓库内声明的默认目录；只有当它已被上一次构建的 app.asar 占住（宿主 asar 扫描器
 * 持有、不许删除）时，才自动改用系统临时目录 —— 工作区外的同名文件实测不被占用。
 *
 * 探测手法：对被占用的文件做原地 rename 会抛 EBUSY/EPERM，空闲文件原地 rename 是合法的
 * 空操作。本机没有 handle.exe，reg.exe/wmic 又被安全策略拉黑，这是最省事的判据。
 * 想知道到底是谁占的，用 tools/who-locks.py。
 */
function resolveOutputDir(root, dirName, flag, explicit) {
  const preferred = path.isAbsolute(dirName) ? dirName : path.join(root, dirName)
  if (explicit) {
    const probe = path.join(preferred, 'win-unpacked', 'resources', 'app.asar')
    if (fs.existsSync(probe)) {
      try {
        fs.renameSync(probe, probe)
      } catch {
        fail(
          [
            `输出目录被占用，无法清空：${preferred}`,
            `        查占用者：node tools/who-locks.py "${probe}"`,
            `        或换一个目录：${flag} <另一个目录>`
          ].join('\n')
        )
      }
    }
    return preferred
  }

  const probe = path.join(preferred, 'win-unpacked', 'resources', 'app.asar')
  if (!fs.existsSync(probe)) return preferred
  try {
    fs.renameSync(probe, probe)
    return preferred
  } catch {
    const fallback = path.join(os.tmpdir(), 'yjai-build', path.basename(preferred))
    usedScratch = true
    console.log(`\n[提示] ${probe}`)
    console.log('       被其他进程占用（IDE/宿主正在扫描上一次构建出的 app.asar），无法清空输出目录。')
    console.log(`       本次自动改用工作区外的临时目录：${fallback}`)
    console.log('       想让它回到仓库内：关掉占用它的程序（或重启 IDE）后重跑。')
    console.log(`       查占用者：node tools/who-locks.py "<上面的路径>"`)
    return fallback
  }
}

const NODE = process.execPath
const VITE = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const BUILDER = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js')

/** 安装器单文件 exe 的文件名，与 packages/installer/electron-builder.yml 的 artifactName 对应 */
const EXE_NAME = 'YiJingAIEditor-Setup-Windows-x64.exe'

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
}

function step(no, title) {
  console.log(`\n${'='.repeat(64)}\n[${no}] ${title}\n${'='.repeat(64)}`)
}

function run(file, argv, cwd, label) {
  const r = spawnSync(file, argv, { cwd, stdio: 'inherit', env })
  if (r.status !== 0) {
    console.error(`\n[失败] ${label}（退出码 ${r.status}）`)
    process.exit(r.status || 1)
  }
}

function requireFile(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`[失败] ${label} 不存在：${p}`)
    process.exit(1)
  }
}

function fail(msg) {
  console.error(`\n[失败] ${msg}`)
  process.exit(1)
}

/**
 * 发布前置：仓库内图形资产必须**全部自有**。
 *
 * 这一条以前由「占位素材清单」（根目录 PLACEHOLDERS.json + tools/check-placeholders.mjs）
 * 把关：那时图标与配图是从别处逐字节取出的他人作品，打包前必须确认已换完。
 * 现在全部改由程序生成（图标 tools/build-own-icons.mjs、配图 tools/gen-own-art.py、
 * 素材缩略图 tools/gen-material-thumbs.py），仓库里再没有第三方图形资产，
 * 这条闸门连同那份清单一并删除 —— 留着只会去读一个不存在的文件而硬失败。
 * 改素材来源时，请把「是否自有」重新写成一条可机械判定的闸门，不要只写进注释。
 */

/**
 * ffmpeg 随包状态（**可选**）。
 *
 * 打包方式定成「可选随包」而不是"构建时自动下载"或"npm 装 ffmpeg-static"：
 * ffmpeg 是 LGPL/GPL，本项目是 MIT —— 默认把 GPL/LGPL 的二进制打进 MIT 的发行物，
 * 会让整份发行物的许可证说不清。所以仓库不带、默认不带，
 * 需要"装完就能导出"时由打包者显式跑 `npm run ffmpeg:fetch` 再构建。
 *
 * 这里只**如实报告**带不带：不静默（打包完才发现没带上）、也不硬失败
 * （没带上是合法选择 —— 用户仍可用系统 PATH 上的 ffmpeg）。
 */
const ffmpegDir = path.join(desktopRoot, 'resources', 'ffmpeg')
const ffmpegExe = path.join(ffmpegDir, 'ffmpeg.exe')
const hasFfmpeg = fs.existsSync(ffmpegExe)
if (hasFfmpeg) {
  console.log('[i] ffmpeg：随包带走（resources/ffmpeg/ffmpeg.exe）')
  console.log('    ⚠️ 这个包里含 LGPL/GPL 的 ffmpeg —— 对外分发前确认这是你要的许可口径。')
} else {
  console.log('[i] ffmpeg：不随包（resources/ffmpeg/ 里没有 ffmpeg.exe）')
  console.log('    成片导出将退回使用系统 PATH 上的 ffmpeg；装完就能用请跑 npm run ffmpeg:fetch 后重新构建。')
}

// ------------------------------------------------------------------ 1~3
if (!skipApp) {
  step(1, '构建桌面客户端渲染层')
  run(NODE, [VITE, 'build'], desktopRoot, '客户端 vite build')
  requireFile(path.join(desktopRoot, 'dist-renderer', 'index.html'), '客户端渲染层产物')

  step(2, '打包客户端免安装目录（electron-builder --dir）')
  /* 默认产物目录跟 desktop/electron-builder.yml 的 `directories.output` 保持一致。
     2026-10-31 从 dist-win 改成 dist-app：本机 dist-win/win-unpacked/resources/app.asar
     长期被某个进程独占，打包清旧产物那步必失败（详见 electron-builder.yml 里的注释）。 */
  const appOut = resolveOutputDir(desktopRoot, appOutArg || 'dist-app', '--app-out', appOutArg)
  run(
    NODE,
    [BUILDER, '--config', 'electron-builder.yml', '--win', 'dir', '--x64', '-c.directories.output=' + appOut],
    desktopRoot,
    '客户端 electron-builder'
  )
  const unpacked = path.join(appOut, 'win-unpacked')
  requireFile(path.join(unpacked, 'YiJingAIEditor.exe'), '客户端主程序')

  step(3, '压缩主程序数据包 payload/app.7z')
  run(NODE, [path.join(__dirname, 'pack-payload.mjs'), unpacked], installerRoot, 'pack-payload')
} else {
  console.log('\n[跳过] 1~3 步（--skip-app），复用已有 payload/app.7z')
  requireFile(path.join(installerRoot, 'payload', 'app.7z'), 'payload/app.7z')
}

// ------------------------------------------------------------------ 4~5
if (!skipInstaller) {
  step(4, '构建安装器渲染层')
  run(NODE, [VITE, 'build'], installerRoot, '安装器 vite build')
  requireFile(path.join(installerRoot, 'dist-renderer', 'index.html'), '安装器渲染层产物')

  step(5, '生成安装器单文件 exe（portable）')
  const installerOut = resolveOutputDir(installerRoot, installerOutArg || 'dist-installer', '--installer-out', installerOutArg)
  run(
    NODE,
    [BUILDER, '--config', 'electron-builder.yml', '--win', 'portable', '--x64', '-c.directories.output=' + installerOut],
    installerRoot,
    '安装器 electron-builder'
  )

  const rawExe = path.join(installerOut, EXE_NAME)
  requireFile(rawExe, '安装器 exe')

  // 交付物统一落到仓库内的 dist-installer/：这个 exe 不在 win-unpacked 里，
  // 不会被宿主的 asar 扫描器占用，可以稳定覆盖。
  const deliverDir = path.join(installerRoot, 'dist-installer')
  const deliverExe = path.join(deliverDir, EXE_NAME)
  if (path.resolve(deliverExe) !== path.resolve(rawExe)) {
    fs.mkdirSync(deliverDir, { recursive: true })
    fs.copyFileSync(rawExe, deliverExe)
    console.log(`\n已归位交付物：${deliverExe}`)
  }

  const size = fs.statSync(deliverExe).size
  console.log('\n产物：')
  console.log(`  ${EXE_NAME}  ${(size / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  路径：${deliverExe}`)
}

// 中间产物用的是工作区外的临时目录时，提示一下它占多大、可不可以删。
// 不自动删：构建中途失败时它是唯一的现场。
if (usedScratch) {
  const scratchRoot = path.join(os.tmpdir(), 'yjai-build')
  console.log(`\n中间产物（工作区外，构建失败时用于排查，可安全删除）：${scratchRoot}`)
}

console.log('\n全部完成。')
