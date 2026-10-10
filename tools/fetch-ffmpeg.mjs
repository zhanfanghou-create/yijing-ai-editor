#!/usr/bin/env node
/**
 * 下载 ffmpeg / ffprobe 到 `packages/desktop/resources/ffmpeg/`（**可选**）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是"可选"，而不是安装时自动带
 * ---------------------------------------------------------------------------
 * 本项目是 MIT，ffmpeg 是 LGPL/GPL。把 GPL/LGPL 的二进制**默认**打进我们的发行物，
 * 会让整份发行物的许可证说不清 —— 这不是技术问题，是能不能这么发的问题。
 * 所以：
 *   · 仓库不带 ffmpeg（.gitignore 排除了 *.exe / *.zip）；
 *   · 默认构建也不下载它；
 *   · 需要"装完就能导出"的人，显式跑一次这个脚本，再构建安装器 ——
 *     `build-installer.mjs` 检测到目录里有 ffmpeg.exe 就随包带走，没有就跳过。
 *
 * 决定权因此留在**打包者**手上：内部自用可以带上，对外分发默认不带。
 *
 * ---------------------------------------------------------------------------
 * 为什么不用 npm 包（ffmpeg-static 那一类）
 * ---------------------------------------------------------------------------
 * 那类包会在 `npm install` 时无条件下载 80MB 二进制 —— 于是每个克隆仓库的人
 * 都被迫接受了那份许可证，而这恰恰是上面要避免的"默认带上"。
 *
 * 用法：
 *   node tools/fetch-ffmpeg.mjs          # 下载并解压到 resources/ffmpeg/
 *   node tools/fetch-ffmpeg.mjs --dry    # 只打印将要做什么，不动盘、不联网
 *   node tools/fetch-ffmpeg.mjs --force  # 已存在也重新下载
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'packages', 'desktop', 'resources', 'ffmpeg')

const DRY = process.argv.includes('--dry')
const FORCE = process.argv.includes('--force')

/** Windows 官方推荐的 essentials 构建（gyan.dev，与 ffmpeg.org 页面上指向的是同一份） */
const URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

function exeName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base
}

function main() {
  const want = [exeName('ffmpeg'), exeName('ffprobe')]
  const have = want.filter((name) => fs.existsSync(path.join(OUT, name)))

  if (have.length === want.length && !FORCE) {
    console.log(`已经有了：${have.join(' / ')} —— 跳过（要重新下载加 --force）`)
    return 0
  }

  if (process.platform !== 'win32') {
    console.error('这个脚本目前只做 Windows（本项目当前只发 Windows 安装包）。')
    console.error('其它平台请把 ffmpeg / ffprobe 直接放到：' + OUT)
    return 1
  }

  if (DRY) {
    console.log(`[dry] 将下载 ${URL}`)
    console.log(`[dry] 解压 ffmpeg.exe / ffprobe.exe 到 ${OUT}`)
    return 0
  }

  fs.mkdirSync(OUT, { recursive: true })
  const zip = path.join(os.tmpdir(), `yjai-ffmpeg-${process.pid}.zip`)
  const dir = path.join(os.tmpdir(), `yjai-ffmpeg-${process.pid}`)

  try {
    /* 用系统自带的下载与解压，不为这件事引入第三方依赖：
       · Windows 上 PowerShell 一定有（装 Electron 的前提就是有 PowerShell）；
       · 引入 node 的 unzip 依赖 = 给一个可选步骤背上常驻依赖，不划算。 */
    console.log(`下载 ${URL} …`)
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${URL}' -OutFile '${zip}'`
      ],
      { stdio: 'inherit' }
    )

    console.log('解压 …')
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -Path '${zip}' -DestinationPath '${dir}' -Force`
      ],
      { stdio: 'inherit' }
    )

    /* 包内路径是 <版本>/bin/ffmpeg.exe —— 按名字找，不要假设版本目录名 */
    let found = 0
    for (const name of want) {
      const hit = findFile(dir, name)
      if (!hit) {
        console.error(`包里没找到 ${name}`)
        continue
      }
      fs.copyFileSync(hit, path.join(OUT, name))
      found += 1
      console.log(`  ✓ ${name}`)
    }

    if (found !== want.length) {
      console.error('ffmpeg 没配齐，导出功能仍然会用不了。')
      return 1
    }
    console.log(`\n已就位：${OUT}`)
    console.log('下一步：node packages/installer/scripts/build-installer.mjs（会把它随包带走）')
    return 0
  } finally {
    try {
      fs.rmSync(zip, { force: true })
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }
}

function findFile(root, name) {
  if (!fs.existsSync(root)) return ''
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.toLowerCase() === name.toLowerCase()) return full
    }
  }
  return ''
}

process.exit(main())
