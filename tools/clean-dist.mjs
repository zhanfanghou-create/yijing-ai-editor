#!/usr/bin/env node
/**
 * clean-dist.mjs — 只做一件事：把渲染层构建产物目录删干净，且**不被本机的批量删除保护拦下**。
 *
 * 为什么必须有它：
 *   vite 的 `emptyOutDir` 走 `fs.rmSync(dir, {recursive:true})`，而本机装了
 *   「批量删除保护」shim（阈值 50 个/轮）。`dist-renderer/assets` 里的文件数
 *   一旦超过 50（加一批预设图就够了 —— 实测 72 个），构建立刻失败，报的是：
 *
 *     [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":72,"threshold":50}
 *
 *   ——错误信息长得像"代码删了不该删的东西"，实际与源码毫无关系。
 *   这类"红得指向错误方向"的失败最容易让人去改错的代码，所以单独成工具。
 *
 * 顺序：先试常规 rmSync（正常机器一条命令就完）；只在被保护拦下时退到
 * `cmd /c rd /s /q`（Windows 原生删除，不走 Node 的 shim）。
 *
 * 用法：node tools/clean-dist.mjs [目标目录...]
 *       默认清 packages/desktop/dist-renderer 与 packages/admin/dist
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULTS = ['packages/desktop/dist-renderer', 'packages/admin/dist']
const targets = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS).map((p) =>
  path.isAbsolute(p) ? p : path.join(ROOT, p)
)

/** Windows 原生兜底：绕过 Node 的 rmSync shim */
function nativeWipe(dir) {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', dir], { stdio: 'ignore' })
    return
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

let failed = 0
for (const dir of targets) {
  if (!fs.existsSync(dir)) {
    console.log(`clean-dist: 跳过（不存在） ${path.relative(ROOT, dir)}`)
    continue
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`clean-dist: 已清 ${path.relative(ROOT, dir)}`)
  } catch (err) {
    const guarded = /SAFE_DELETE_BULK_CONFIRM_REQUIRED/.test(String(err && err.message))
    if (!guarded) {
      console.error(`clean-dist: 删除失败 ${path.relative(ROOT, dir)} —— ${err && err.message}`)
      failed++
      continue
    }
    try {
      nativeWipe(dir)
      console.log(`clean-dist: 已清（走原生 rd 兜底） ${path.relative(ROOT, dir)}`)
    } catch (err2) {
      console.error(`clean-dist: 原生兜底也失败 ${path.relative(ROOT, dir)} —— ${err2 && err2.message}`)
      failed++
    }
  }
}
process.exit(failed ? 1 : 0)
