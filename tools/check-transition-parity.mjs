#!/usr/bin/env node
/**
 * 转场「导出表达式 ⇄ JS 外观模型」逐像素对拍闸门。
 *
 * ------------------------------------------------------------------------------
 * 为什么需要这道闸门
 * ------------------------------------------------------------------------------
 * 一个转场有**三套消费方**，共用 `shared/transitionMask.js` 里的一份数学：
 *   · 导出：`geoToExpr()` 拼出的 `xfade=transition=custom` 表达式；
 *   · 预览：`geoToCss()` 生成的 mask / clip-path；
 *   · 缩略图：`appearanceAt()` 导出的矩阵。
 * 三处同源只保证"用的是同一个函数"，**不保证这个函数在 ffmpeg 里算得对**。
 * 2026-11-03 就踩到两次，两次都静默：
 *   ① `st(0,m)+ld(0)` 复用中间量 —— 同一份表达式连跑三次给出三组不同像素；
 *   ② 闪黑/闪白用常量写中间色 —— 在 yuv 平面上常量同时进 Y/U/V，中点是品红。
 * 这两条都不会报错，只会让成片"某一帧颜色不对/随机变脏"。
 *
 * ------------------------------------------------------------------------------
 * 判据
 * ------------------------------------------------------------------------------
 * ① 期望像素在**本文件里独立重算**（只用 `appearanceAt` 给出的三段权重 × 两张
 *    源图的 RGB），ffmpeg 那边跑的是真滤波器 —— 这叫对拍，不叫复述。
 * ② 源图先各自过一次 `format=yuv420p` 再取 RGB 当参考：真实导出是 yuv420p
 *    （闪族是 gbrp），不先把参考图对齐到同一条量化路径，8bit 往返误差会被
 *    误判成"公式不一致"（这也是 filter-parity 那条闸门的教训）。
 * ③ 结构判据：所有表达式里**不许出现 st( / ld(** —— 见上面第 ① 条踩坑。
 * ④ 闪族的表达式必须走 RGB 平面（xfadeArgs 的 rgb 非空），其余族必须不走 ——
 *    走反了不会报错，只会让白闪变品红、或者白白多两次格式转换。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeBase } from './thumb-base.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 64
const FPS = 10
/* 帧号 → 进度：(k/FPS - offset) / duration，取 offset=1、duration=2，
   于是进度 0.1/0.3/0.5/0.7/0.9 正好落在整数帧上（不会因为取整说话不算数） */
const OFFSET = 1
const DUR = 2
const PROGRESS = [0.1, 0.3, 0.5, 0.7, 0.9]
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

const looks = require(path.join(ROOT, 'packages/desktop/src/shared/looks.json'))
const maskApi = require(path.join(ROOT, 'packages/desktop/src/shared/transitionMask.js'))

const SRC_A = writeBase('a')
const SRC_B = writeBase('b')

const out = []
const add = (name, ok, detail) => out.push({ name, ok, detail })

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

/** 源图 → 与真实导出同一条量化路径上的 RGB（yuv420p 往返） */
async function refImage(file) {
  const buf = await run(
    ['-loglevel', 'error', '-i', file, '-vf',
      `scale=${SIZE}:${SIZE}:flags=lanczos,format=yuv420p,format=rgb24`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { capture: true }
  )
  return new Uint8Array(buf)
}

/**
 * 跑一次接缝，取回指定进度那一帧的 RGB。
 * 输入结构与 render.js 的真实现一致：两侧先归一到 pixFmt，闪族再转 RGB 平面。
 */
async function renderSeam(geo, ffmpegName, pixFmt, progress) {
  const { spec, rgb } = maskApi.xfadeArgs(geo, { ffmpeg: ffmpegName, pixFmt })
  const left = rgb ? `format=${pixFmt},format=${rgb}` : `format=${pixFmt}`
  const post = rgb ? `,format=${pixFmt}` : ''
  const graph =
    `[0:v]scale=${SIZE}:${SIZE},${left}[a];[1:v]scale=${SIZE}:${SIZE},${left}[b];` +
    `[a][b]xfade=${spec}:duration=${DUR}:offset=${OFFSET}[x];[x]null${post},format=rgb24[v]`
  const frame = Math.round((progress * DUR + OFFSET) * FPS)
  const buf = await run(
    ['-loglevel', 'error',
      '-loop', '1', '-framerate', String(FPS), '-t', '4', '-i', SRC_A,
      '-loop', '1', '-framerate', String(FPS), '-t', '4', '-i', SRC_B,
      '-filter_complex', graph, '-map', '[v]',
      '-frames:v', String(frame + 1), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { capture: true }
  )
  const frameBytes = SIZE * SIZE * 3
  return new Uint8Array(buf.subarray(buf.length - frameBytes))
}

/**
 * 问 ffmpeg：这一帧的 `P` 是多少？`1-P` 就是进度。
 *
 * 单独量这件事的理由：`P` 在 YUV 平面上会被压扁到约 3 倍速（见
 * shared/transitionMask.js 文件头坑 3b），那样"转场一闪而过、后半段干等"，
 * 而像素对拍只在中段取帧，未必发现。这里逐帧对齐帧号，专门钉这一条。
 */
async function readProgress(frame) {
  const graph =
    `[0:v]scale=${SIZE}:${SIZE},format=gbrp[a];[1:v]scale=${SIZE}:${SIZE},format=gbrp[b];` +
    `[a][b]xfade=transition=custom:expr='255*P':duration=${DUR}:offset=${OFFSET}[x];` +
    '[x]null,format=rgb24[v]'
  const buf = await run(
    ['-loglevel', 'error',
      '-loop', '1', '-framerate', String(FPS), '-t', '4', '-i', SRC_A,
      '-loop', '1', '-framerate', String(FPS), '-t', '4', '-i', SRC_B,
      '-filter_complex', graph, '-map', '[v]',
      '-frames:v', String(frame + 1), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { capture: true }
  )
  const px = new Uint8Array(buf.subarray(buf.length - SIZE * SIZE * 3))
  return 1 - px[(32 * SIZE + 32) * 3] / 255
}

/**
 * 4×4 块平均之后再比 —— **判据的主体**。
 *
 * 为什么不直接逐像素判：遮罩边界在 64×64 的采样分辨率上是"一像素宽的刀口"，
 * 颗粒族（60×60 格）和同心环族（环距 < 1 像素）的边界正好压在这条刀口上。
 * 相邻像素本来就该是"全 A"与"全 B"，只要有一丝亚像素差，整像素就会翻转 ——
 * 逐像素看是 p99=70，块平均之后立刻回落到 2 上下。而**公式写错**（整帧错开、
 * 进度被压扁）时块平均照样红，所以这条既稳又能抓真问题。
 */
function blockDiff(a, b, n = 4) {
  let sum = 0
  let count = 0
  const hist = new Uint32Array(256)
  for (let by = 0; by < SIZE; by += n) {
    for (let bx = 0; bx < SIZE; bx += n) {
      for (let c = 0; c < 3; c += 1) {
        let sa = 0
        let sb = 0
        for (let y = by; y < by + n; y += 1) {
          for (let x = bx; x < bx + n; x += 1) {
            const i = (y * SIZE + x) * 3 + c
            sa += a[i]
            sb += b[i]
          }
        }
        const d = Math.abs(Math.round(sa / (n * n)) - Math.round(sb / (n * n)))
        sum += d
        count += 1
        hist[d] += 1
      }
    }
  }
  const target = count * 0.99
  let acc = 0
  let p99 = 0
  for (let d = 0; d < 256; d += 1) {
    acc += hist[d]
    if (acc >= target) {
      p99 = d
      break
    }
  }
  return { mean: sum / count, p99 }
}

/**
 * 期望像素：三段权重 × 两张源图 + 中间色（在本文件里独立算）。
 *
 * ⚠️ 采样坐标用 `x / SIZE` 而不是 `(x + 0.5) / SIZE`：表达式里的 X 是**像素列号**
 *    （0..W-1），`X/W` 取到的是像素左边沿。颗粒/网格/条纹这些**按格子**分组的族
 *    对半个像素极其敏感 —— 用中心点采样时，64 个像素里排 60 个格子，格边界几乎
 *    逐像素错位，逐像素差会被放大成"两条式子不一致"（实测 noise 族就是这么红的）。
 */
function expectAt(geo, A, B, progress) {
  const outBuf = new Uint8Array(SIZE * SIZE * 3)
  const tint = Math.round(Math.min(1, Math.max(0, Number(geo.tint ?? 0))) * 255)
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const w = maskApi.appearanceAt(geo, x / SIZE, y / SIZE, progress)
      const i = (y * SIZE + x) * 3
      for (let c = 0; c < 3; c += 1) {
        outBuf[i + c] = Math.round(A[i + c] * w.a + B[i + c] * w.b + tint * w.t)
      }
    }
  }
  return outBuf
}

function diff(a, b) {
  const n = Math.min(a.length, b.length)
  let sum = 0
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i += 1) {
    const d = Math.abs(a[i] - b[i])
    sum += d
    hist[d] += 1
  }
  const target = n * 0.99
  let acc = 0
  let p99 = 0
  for (let d = 0; d < 256; d += 1) {
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
  const geos = looks.transitions.filter((t) => t.geo)
  add('looks.json 里的 geo 转场是 204 个', geos.length === 204, `实际 ${geos.length}`)

  /* 采样：每个几何族取两头 + 闪族三种形态各取一个（全量 204 个逐个跑 ffmpeg 太慢） */
  const byKind = new Map()
  for (const t of geos) {
    if (!byKind.has(t.geo.kind)) byKind.set(t.geo.kind, [])
    byKind.get(t.geo.kind).push(t)
  }
  const sample = []
  for (const [, list] of byKind) {
    sample.push(list[0])
    if (list.length > 1) sample.push(list[list.length - 1])
  }
  const flash = byKind.get('flash') || []
  const pick = (fn) => flash.find(fn)
  for (const t of [
    pick((t) => !t.geo.shape && !t.geo.band),
    pick((t) => t.geo.band),
    pick((t) => t.geo.shape)
  ]) {
    if (t && !sample.includes(t)) sample.push(t)
  }
  add('采样覆盖全部几何族', byKind.size === 11 && [...byKind.keys()].every((k) => sample.some((s) => s.geo.kind === k)),
    [...byKind.keys()].join(' '))

  const A = await refImage(SRC_A)
  const B = await refImage(SRC_B)
  add('两张源图都能解出 RGB', A.length === SIZE * SIZE * 3 && B.length === SIZE * SIZE * 3,
    `${SIZE}×${SIZE}×3`)

  const rows = []
  for (const t of sample) {
    for (const p of PROGRESS) {
      const got = await renderSeam(t.geo, t.ffmpeg, 'yuv420p', p)
      const want = expectAt(t.geo, A, B, p)
      rows.push({ label: t.label, kind: t.geo.kind, p, ...diff(want, got), block: blockDiff(want, got) })
    }
  }
  if (process.env.YJAI_TX_DEBUG) {
    const top = [...rows].sort((a, b) => b.block.mean - a.block.mean).slice(0, 8)
    for (const r of top) {
      console.log(`    · ${r.kind.padEnd(8)} ${r.label} p=${r.p} 块平均=${r.block.mean.toFixed(2)} 逐像素=${r.mean.toFixed(2)}`)
    }
  }

  const worst = rows.reduce((a, b) => (b.block.mean > a.block.mean ? b : a), rows[0])
  const med = [...rows].map((r) => r.block.mean).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
  add('每条采样的每个进度都跟 JS 模型对上（4×4 块平均后 ≤ 4）',
    rows.every((r) => r.block.mean <= 4),
    `${rows.length} 帧 · 中位 ${med.toFixed(2)} · 最差 ${worst.label} p=${worst.p} ${worst.block.mean.toFixed(2)}`)
  add('同一批帧逐像素也没有整块错位（平均差 ≤ 20）',
    rows.every((r) => r.mean <= 20),
    `最差 ${[...rows].sort((a, b) => b.mean - a.mean)[0].mean.toFixed(2)}（刀口像素翻转，见 blockDiff 注释）`)

  /* 结构判据：坑 4 不许回归 */
  const withState = geos.filter((t) => /\bst\(|\bld\(/.test(maskApi.geoToExpr(t.geo)))
  add('所有转场表达式都是无状态的（没有 st / ld）', withState.length === 0,
    withState.length ? `${withState.length} 条：${withState.slice(0, 3).map((t) => t.label).join(' ')}` : '全部内联')

  const emptyExpr = geos.filter((t) => !maskApi.geoToExpr(t.geo))
  add('全部 204 条表达式非空', emptyExpr.length === 0,
    emptyExpr.length ? `${emptyExpr.length} 条空：${emptyExpr.slice(0, 3).map((t) => t.label).join(' ')}` : `${geos.length} 条都有表达式`)

  /* 平面判据：custom 一律走 RGB（闪族的常量 + P 的进度压扁，两条都在文件头记着） */
  const wrongPlane = []
  for (const t of geos) {
    const { spec, rgb } = maskApi.xfadeArgs(t.geo, { ffmpeg: t.ffmpeg, pixFmt: 'yuv420p' })
    if (!spec.includes("expr='")) wrongPlane.push(`${t.label} 没走 custom`)
    if (rgb !== 'gbrp') wrongPlane.push(`${t.label} 平面错（${rgb || 'yuv'}）`)
  }
  add('每个 custom 转场都走 gbrp 平面（YUV 上进度会被压扁成 3 倍速）', wrongPlane.length === 0,
    wrongPlane.length ? wrongPlane.slice(0, 3).join(' / ') : `${geos.length} 条全部 gbrp`)

  const withAlpha = maskApi.xfadeArgs(geos[0].geo, { pixFmt: 'yuva420p' })
  add('带 alpha 的工程用 gbra 而不是 gbrp（否则背景变黑）', withAlpha.rgb === 'gbra', withAlpha.rgb)

  /* 原生键不该走表达式：那 58 个走 ffmpeg 自带的名字，进度由 ffmpeg 自己算 */
  const native = looks.transitions.filter((t) => !t.geo && t.key !== 'none')
  const wrongNative = native.filter((t) => maskApi.xfadeArgs(null, { ffmpeg: t.ffmpeg, pixFmt: 'yuv420p' }).rgb)
  add('原生 58 个键不走 custom（也就不会被转成 RGB）', wrongNative.length === 0,
    `${native.length} 个原生键`)

  /* 逐帧进度判据：P 与帧号线性对齐 —— 这条能直接钉住"3 倍速"的回归 */
  const drift = []
  for (const p of PROGRESS) {
    const frame = Math.round((p * DUR + OFFSET) * FPS)
    const seen = await readProgress(frame)
    drift.push({ p, seen, err: Math.abs(seen - p) })
  }
  const worstDrift = drift.reduce((a, b) => (b.err > a.err ? b : a), drift[0])
  add('转场进度与帧号线性对齐（误差 ≤ 0.06，即不到一帧）', worstDrift.err <= 0.06,
    drift.map((d) => `${d.p}:${d.seen.toFixed(2)}`).join(' '))

  let pass = 0
  for (const r of out) {
    if (r.ok) pass++
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
  }
  console.log(`\nTRANSITION_PARITY_STATS total=${out.length} pass=${pass} fail=${out.length - pass}`)
  if (pass !== out.length) {
    console.log('TRANSITION_PARITY_FAILED')
    return 1
  }
  console.log('转场：导出表达式、预览模型、缩略图矩阵落在同一批像素上。')
  console.log('TRANSITION_PARITY_OK')
  return 0
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('TRANSITION_PARITY_ERROR', err.message)
  process.exit(1)
})
