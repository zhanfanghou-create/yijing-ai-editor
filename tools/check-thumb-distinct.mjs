#!/usr/bin/env node
/**
 * 闸门 · 947 张素材缩略图「两两看得出差别」。
 *
 * 为什么单独一道：结构层的判据全绿，用户眼前却是两张一模一样的卡 ——
 *   · check-material-thumbs  —— 每张卡都有图、键与图一一对应、不是空壳 ✓
 *   · check-transition-distinct —— 204 条转场的**空间场**两两差 ≥ 0.02 ✓
 * 实测：`水平线` 与 `下移` 的场差 0.036（闸门眼里的"安全区"），缩略图却只有
 * 1.92 平均色差 —— 48×27 的卡片上肉眼分不出；`马赛克`(grid order 0) 更离谱，
 * 场是"整行推进"，任何进度都是"上面若干整行已翻"，与横带擦除同形，三张几乎相同。
 * **场差 ≠ 观感差**：32×32 单通道亮度场把"A 还是 B"糊成两个标量，局部差异被平均掉，
 * 而用户看的是彩色小图、约 96×54 的卡片。
 *
 * 判据在 Python 里（要解码 webp，Node 侧没有零依赖解码器），这份 mjs 只负责
 * 找解释器并转发退出码，保持"闸门都是 node tools/check-*.mjs"的统一入口。
 *
 * 用法：node tools/check-thumb-distinct.mjs
 *       node tools/check-thumb-distinct.mjs --selftest
 * 退出码：0 通过 / 1 失败 / 2 本机没有 Python + Pillow（如实跳过）
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'tools', 'thumb-distinct.py')

/* Windows 上 `python` 常常是 Microsoft Store 的占位程序（跑起来直接失败），
   所以要真的探一次 `import PIL` —— 只探 `--version` 会选中那个假的。
   ⚠️ 探测必须走 spawnCapture（文件重定向）：本机进程内 spawn 走管道会 EBUSY
   （status=null、stdout=''），于是探测恒判"没装"、闸门静默跳过 ——
   而跳过在汇总里长得像通过。 */
const CANDIDATES = ['python', 'python3', 'py']
let runner = null
for (const cmd of CANDIDATES) {
  const r = spawnCapture(cmd, ['-c', 'import PIL; print(1)'], { tag: 'thumb-distinct-probe' })
  if (r.status === 0 && String(r.stdout).includes('1')) {
    runner = cmd
    break
  }
}

if (!runner) {
  console.log('THUMB_DISTINCT_SKIPPED 本机没有 Python + Pillow（像素层无法取证）')
  process.exit(2)
}

const args = [SCRIPT]
if (process.argv.includes('--selftest')) args.push('--selftest')

/* 真正跑判据时 stdio 用 inherit —— 那是直接接到本进程的既有 fd，不是新建管道，
   输出要原样进日志（`THUMB_DISTINCT_STATS` 那行由 verify.mjs 数）。 */
const r = spawnSync(runner, args, { stdio: 'inherit' })
process.exit(r.status === null ? 1 : r.status)
