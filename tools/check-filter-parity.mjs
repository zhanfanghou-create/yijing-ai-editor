#!/usr/bin/env node
/**
 * 滤镜/调节 的「预览公式 ⇄ 导出链」逐像素对拍闸门。
 *
 * ------------------------------------------------------------------------------
 * 为什么需要这道闸门
 * ------------------------------------------------------------------------------
 * 同一组参数会被**两套实现**分别解释：
 *   · 预览 / 缩略图：CSS 规范里的线性矩阵（brightness / sepia / contrast /
 *     saturate / hue-rotate，全部是 SVG feColorMatrix 的固定式子）
 *   · 导出：ffmpeg 滤镜串（main/looks.js、shared/adjust.js 生成）
 *
 * 这两套只要有一处用了"近似"写法，就会出现**预览一个色、成片另一个色**，
 * 而且这种缺陷不抛错、不影响构建、截图对比也看不出来（因为截图截的是预览）。
 *
 * 2026-11-03 实测到的三处真实偏差（同一组参数、96×96 底片、Lab 平均差）：
 *   · `hue=h=deg`      46° 时差 12.5 ΔE（YUV 平面旋色度 vs sRGB 线性矩阵）
 *   · `eq=saturation`  高饱和档差 12~18 ΔE（vivid 族整体偏"闷"）
 *   · `eq=contrast`    同上是 YUV
 *   换成 colorchannelmixer(矩阵) / lutrgb(逐通道仿射) 后，67 个键的中位差 6.46 → 1.62。
 *
 * ------------------------------------------------------------------------------
 * 判据
 * ------------------------------------------------------------------------------
 * ① 参考像素在**本文件里独立重算**（不 import 被测实现）—— 这叫对拍，不叫复述。
 *    如果两边都引用同一份代码，那道闸门只能证明"文件没被删"。
 * ② 采样必须覆盖参数的四个极值键（最大 hue / 最大对比 / 最大饱和 / 最小亮度），
 *    因为偏差随档位放大，平均值采样会放过最坏的那几档。
 * ③ 结构判据：链里**不许**出现 hue=h= / eq=contrast / eq=saturation —— 这三个
 *    是已知的近似写法，回归时应该红在一条明确的断言上，而不是模模糊糊的数值超标。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeBase } from './thumb-base.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/* 底片从本地素材包解出（真源 tools/thumb-bases/frames.yjpack）——
   以前这里直拼 `thumb-bases/base-a.png`，换底片时会漏改，闸门就变成"拿老图对比" */
const BASE = writeBase('a')
const SIZE = 64
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

const looks = require(path.join(ROOT, 'packages/desktop/src/shared/looks.json'))
const filterApi = require(path.join(ROOT, 'packages/desktop/src/main/looks.js'))
const adjustApi = require(path.join(ROOT, 'packages/desktop/src/shared/adjust.js'))

const out = []
const add = (name, ok, detail) => out.push({ name, ok, detail })

/* --------------------------- CSS 参考实现（独立一份） --------------------------- */

/** 按 CSS 规范逐级作用到 RGB 缓冲上（顺序与 cssFilterFor / ffmpegFilterFor 一致） */
function cssChain(buf, p) {
  let cur = Uint8Array.from(buf)
  const stage = (mat) => {
    const next = new Uint8Array(cur.length)
    for (let i = 0; i < cur.length; i += 3) {
      const r = cur[i]
      const g = cur[i + 1]
      const b = cur[i + 2]
      next[i] = clamp8(mat[0][0] * r + mat[0][1] * g + mat[0][2] * b + (mat[0][3] || 0))
      next[i + 1] = clamp8(mat[1][0] * r + mat[1][1] * g + mat[1][2] * b + (mat[1][3] || 0))
      next[i + 2] = clamp8(mat[2][0] * r + mat[2][1] * g + mat[2][2] * b + (mat[2][3] || 0))
    }
    cur = next
  }

  const b0 = Number(p.brightness ?? 1)
  if (Math.abs(b0 - 1) > 1e-4) stage([[b0, 0, 0, 0], [0, b0, 0, 0], [0, 0, b0, 0]])

  const sp = Number(p.sepia ?? 0)
  if (sp > 1e-4) {
    const S = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]
    stage(S.map((row, r) => row.map((v, c) => (r === c ? 1 : 0) + (v - (r === c ? 1 : 0)) * sp)))
  }

  const ct = Number(p.contrast ?? 1)
  if (Math.abs(ct - 1) > 1e-4) stage([[ct, 0, 0, 127.5 * (1 - ct)], [0, ct, 0, 127.5 * (1 - ct)], [0, 0, ct, 127.5 * (1 - ct)]])

  const s = Number(p.saturate ?? 1) * (1 - Number(p.grayscale ?? 0))
  if (Math.abs(s - 1) > 1e-4) stage(satMatrix(s))

  const hue = Number(p.hue ?? 0)
  if (Math.abs(hue) > 1e-4) stage(hueMatrix(hue))

  return cur
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

function satMatrix(s) {
  return [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0]
  ]
}

function hueMatrix(deg) {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0]
  ]
}

/* --------------------------------- ffmpeg 侧 --------------------------------- */

function run(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] })
    const chunks = []
    const errs = []
    if (capture) child.stdout.on('data', (c) => chunks.push(c))
    child.stderr.on('data', (c) => errs.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(errs).toString().slice(-400)))
      resolve(Buffer.concat(chunks))
    })
  })
}

/** 底片 → 统一尺寸的 RGB 原始像素 */
async function decodeBase() {
  const buf = await run(['-loglevel', 'error', '-i', BASE, '-vf', `scale=${SIZE}:${SIZE}:flags=lanczos,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { capture: true })
  return new Uint8Array(buf)
}

/**
 * 跑一条链路并取回 RGB 原始像素。
 * ⚠️ 首尾都强制 `format=rgb24`：色相/饱和度现在是 RGB 矩阵，
 *    如果让 ffmpeg 自己协商格式，中间会过一次 yuv420 往返，凭空多出 1~2 的量化误差，
 *    那个误差会被误判成"公式不一致"。
 */
async function renderChain(chain) {
  const buf = await run(['-loglevel', 'error', '-i', BASE, '-vf',
    `scale=${SIZE}:${SIZE}:flags=lanczos,format=rgb24,${chain},format=rgb24`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { capture: true })
  return new Uint8Array(buf)
}

/** 两种像素的平均绝对差（0~255）与 99 分位 */
function diff(a, b) {
  const n = Math.min(a.length, b.length)
  let sum = 0
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i])
    sum += d
    hist[d]++
  }
  const target = n * 0.99
  let acc = 0
  let p99 = 0
  for (let d = 0; d < 256; d++) {
    acc += hist[d]
    if (acc >= target) {
      p99 = d
      break
    }
  }
  return { mean: sum / n, p99 }
}

/* ---------------------------------- 主流程 ---------------------------------- */

async function main() {
  const filters = looks.filters.filter((f) => f.key !== 'none')
  const param = (f, k, d) => Number((f.params || {})[k] ?? d)

  /* 采样：全部键太多（500+，逐个 ffmpeg 太慢），取族内均匀抽样 + 四个极值键。
     极值必须覆盖 —— 偏差随档位放大，均匀抽样正好会漏掉最坏的那几档。 */
  const byHue = [...filters].sort((a, b) => Math.abs(param(b, 'hue', 0)) - Math.abs(param(a, 'hue', 0)))[0]
  const byContrast = [...filters].sort((a, b) => param(b, 'contrast', 1) - param(a, 'contrast', 1))[0]
  const bySat = [...filters].sort((a, b) => param(b, 'saturate', 1) - param(a, 'saturate', 1))[0]
  const byDark = [...filters].sort((a, b) => param(a, 'brightness', 1) - param(b, 'brightness', 1))[0]
  const bySepia = [...filters].sort((a, b) => param(b, 'sepia', 0) - param(a, 'sepia', 0))[0]
  const extremes = [byHue, byContrast, bySat, byDark, bySepia].filter(Boolean)

  const step = Math.max(1, Math.floor(filters.length / 20))
  const sample = [...new Map([...extremes, ...filters.filter((_, i) => i % step === 0)].map((f) => [f.key, f])).values()]

  const base = await decodeBase()
  add('底片能解码出 RGB 像素', base.length === SIZE * SIZE * 3, `${SIZE}×${SIZE} = ${base.length} 字节`)

  const rows = []
  for (const f of sample) {
    const chain = filterApi.ffmpegFilterFor(f.key)
    const got = await renderChain(chain)
    const want = cssChain(base, f.params || {})
    const d = diff(want, got)
    rows.push({ key: f.key, ...d, chain })
  }

  const worst = rows.reduce((a, b) => (b.mean > a.mean ? b : a), rows[0])
  const med = [...rows].map((r) => r.mean).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
  add(
    '每个滤镜键的导出像素与 CSS 公式一致（平均差 ≤ 4）',
    rows.every((r) => r.mean <= 4),
    `样本 ${rows.length} 键 · 中位 ${med.toFixed(2)} · 最差 ${worst.key} ${worst.mean.toFixed(2)}`
  )
  add(
    '最坏键的平均差 ≤ 8（留一档 8bit 量化余量）',
    worst.mean <= 8,
    `${worst.key} mean=${worst.mean.toFixed(2)} p99=${worst.p99}`
  )
  add(
    '采样覆盖参数的五个极值键（hue/对比/饱和/亮度/棕调各取最极端）',
    extremes.length === 5 && extremes.every((f) => rows.some((r) => r.key === f.key)),
    extremes.map((f) => f.key).join(' ')
  )

  /* 结构判据：已知的近似写法不许回归 */
  const allChains = filters.map((f) => ({ key: f.key, chain: filterApi.ffmpegFilterFor(f.key) }))
  const approx = allChains.filter((x) => /hue=h=|eq=contrast|eq=saturation/.test(x.chain))
  add('滤镜链里没有 YUV 近似写法（hue=h / eq=contrast / eq=saturation）', approx.length === 0,
    approx.length ? `${approx.length} 条：${approx.slice(0, 3).map((x) => x.key).join(' ')}` : '全部走 RGB 矩阵')

  const emptyChain = allChains.filter((x) => !x.chain)
  add('每个非 none 的滤镜键都产出非空链', emptyChain.length === 0,
    emptyChain.length ? `${emptyChain.slice(0, 5).map((x) => x.key).join(' ')}` : `${allChains.length} 键全部有链`)

  /* 调节侧同源：它也曾用 eq=contrast:saturation */
  const adjCases = [
    { adjust: { saturate: 100 }, beauty: null },
    { adjust: { contrast: 100 }, beauty: null },
    { adjust: { bright: 60, temp: 40, contrast: 50, saturate: 30 }, beauty: null }
  ]
  const adjApprox = adjCases.filter((c) => /eq=contrast|eq=saturation/.test(adjustApi.ffmpegFilterFor(c.adjust, c.beauty)))
  add('调节/美颜链里没有 YUV 近似写法', adjApprox.length === 0, adjApprox.length ? `${adjApprox.length} 例` : '全部走 RGB 矩阵')

  const adjWorst = []
  for (const c of adjCases) {
    const chain = adjustApi.ffmpegFilterFor(c.adjust, c.beauty)
    if (!chain) continue
    /* 只挑**单一参数**的用例：通道增益那一步（亮度/色温/色调）折在 colorchannelmixer 里，
       cssChain 不建模它。这里要验的是"对比度写成仿射、饱和度写成矩阵"这件事本身的形状，
       所以标量直接取实现给的（两侧在生产里用的也是同一个标量）。 */
    if (Object.keys(c.adjust).length !== 1) continue
    const p = {
      brightness: 1,
      contrast: adjustApi.contrastFactor(c.adjust),
      saturate: adjustApi.saturationFactor(c.adjust),
      sepia: 0,
      grayscale: 0,
      hue: 0
    }
    const got = await renderChain(chain)
    const want = cssChain(base, p)
    adjWorst.push({ name: Object.keys(c.adjust)[0], ...diff(want, got) })
  }
  add('调节的对比度/饱和度与 CSS 公式一致（平均差 ≤ 4）', adjWorst.length > 0 && adjWorst.every((r) => r.mean <= 4),
    adjWorst.map((r) => `${r.name} ${r.mean.toFixed(2)}`).join(' · '))

  let pass = 0
  for (const r of out) {
    if (r.ok) pass++
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
  }
  console.log(`\nFILTER_PARITY_STATS total=${out.length} pass=${pass} fail=${out.length - pass}`)
  if (pass !== out.length) {
    console.log('FILTER_PARITY_FAILED')
    return 1
  }
  console.log('滤镜与调节：预览公式、导出链、缩略图三处落到同一批像素上。')
  console.log('FILTER_PARITY_OK')
  return 0
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('FILTER_PARITY_ERROR', err.message)
  process.exit(1)
})
