#!/usr/bin/env node
/**
 * 闸门 · 特效 267 个效果「两两可分辨」。
 *
 * 为什么单独一道：特效页 343 张卡 / 267 个去重名字，此前只落在 **24 个效果键**上
 * （单是 fx-glow 一个键就占了 83 张卡）。而当时所有判据都是绿的：
 *   · check-fx-wiring   —— 每个键都有样式、都有导出分支 ✓（键只有 24 个）
 *   · check-material-thumbs —— 每张卡都有图、一图一键 ✓（一一对应得整整齐齐）
 *   · check-fx-pixels   —— 柔化真的糊、黑白真的归零 ✓（量的是那 24 个）
 * 「键少、名字多」这件事本身没有任何判据盯着 —— 点 20 张名字完全不同的卡，
 * 出来是同一个效果，而"全绿"。
 *
 * 这道闸门只做一件事：把 267 张缩略图两两比一遍，确认**没有两张看起来一样**。
 * 判据在 Python 里（要解码 webp，Node 侧没有零依赖解码器），这份 mjs 只负责
 * 找到解释器并转发退出码，保持"闸门都是 node tools/check-*.mjs"的统一入口。
 *
 * 用法：node tools/check-fx-distinct.mjs
 * 退出码：0 通过 / 1 失败 / 2 本机没有 Python + Pillow（如实跳过）
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'tools', 'fx-distinct.py')

/* Windows 上 `python` 常常是 Microsoft Store 的占位程序（跑起来直接失败），
   所以要真的探一次 `-c "import PIL"` —— 只探 `--version` 会选中那个假的。
   ⚠️ 探测必须走 spawnCapture（文件重定向），不能用 `{ encoding: 'utf8' }` 让
   stdout 走管道：本机进程内 spawn 走管道会 EBUSY（status=null、stdout=''），
   于是探测恒判"没装"、闸门静默跳过 —— 而跳过在汇总里长得像通过。
   闸门 `e2e-teardown` 第 5 条会机械拦下这个写法（本轮就是被它抓住的）。 */
const CANDIDATES = ['python', 'python3', 'py']
let runner = null
for (const cmd of CANDIDATES) {
  const r = spawnCapture(cmd, ['-c', 'import PIL; print(1)'], { tag: 'fx-distinct-probe' })
  if (r.status === 0 && String(r.stdout).includes('1')) {
    runner = cmd
    break
  }
}

if (!runner) {
  console.log('FX_DISTINCT_SKIPPED 本机没有 Python + Pillow（像素层无法取证）')
  process.exit(2)
}

/* 真正跑判据时 stdio 用 inherit —— 那是直接接到本进程的既有 fd，不是新建管道，
   输出要原样进日志（`FX_DISTINCT_STATS` 那行由 verify.mjs 数）。 */
const r = spawnSync(runner, [SCRIPT], { stdio: 'inherit' })
process.exit(r.status === null ? 1 : r.status)
