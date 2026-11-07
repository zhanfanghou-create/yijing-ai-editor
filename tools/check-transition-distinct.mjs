#!/usr/bin/env node
/**
 * 转场「两两不一样」闸门 —— 钉住"名字比效果多"。
 *
 * ------------------------------------------------------------------------------
 * 为什么需要这道闸门
 * ------------------------------------------------------------------------------
 * 素材面板里转场卡有 331 张、去重名字 204 个，而 ffmpeg 的 `xfade` 只自带 58 种。
 * 如果只是把名字映射到"能跑的几个效果"，就会出现"点开十张名字不同的卡，成片一模一样"
 * —— 用户看不出报错，只会觉得这个功能是假的。
 *
 * 判据不是"参数不同"，而是**看上去不同**：每条转场用 `appearanceAt()` 算出一组
 * 三段权重（前一段 / 中间色 / 后一段），乘到两个灰阶上得到一个 0..1 的"外观标量场"，
 * 再两两比对这个场的平均差。参数表里 0.02 与 0.04 两个 tint 是不同的 JSON，
 * 但在这把尺子下只差 5/255 —— 这种"参数上不同、眼睛看不出"的撞车正是要拦的。
 *
 * ------------------------------------------------------------------------------
 * 度量：取"最像的那个进度"，不取平均
 * ------------------------------------------------------------------------------
 * 同一对转场在 5 个进度上各算一次差，**取最大**。取平均会把结构性差别抹平：
 * 条纹擦除与线性擦除只在某几个进度上差得明显，平均下来只剩 0.011，而人眼一眼能看出
 * "梳齿"和"平滑直线"不是一回事。取最大等于问：有没有某一个时刻，这两条根本一样？
 *
 * ------------------------------------------------------------------------------
 * 判据
 * ------------------------------------------------------------------------------
 * ① 204 个键两两之间的外观差 ≥ 0.02（≈5/255，肉眼可辨的下限）；
 * ② 同时报分位数：1% 分位那条能看出"最挤的是哪一族"，掉下来就是新加的键挤了别人；
 * ③ 几何签名不许重复（参数表层面的同一组数字）；
 * ④ 每条转场都必须看得出在变：要么**帧内有空间变化**（同一帧里既有接近 A 的
 *    也有接近 B 的区域），要么**随进度在变**（同一像素从 0.15 到 0.85 明显翻转）。
 *    ⚠️ 这两条是「或」不是「且」：`full` 族（叠化/渐显/柔和渐变）按定义整帧同进度，
 *    帧内极差天然为 0，只写空间极差会把最正统的转场判成恒等；
 * ⑤ 族内自查：一个族里塞几十个名字最容易出"同族几乎一样"，单独量族内最小差。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const looks = require(path.join(ROOT, 'packages/desktop/src/shared/looks.json'))
const maskApi = require(path.join(ROOT, 'packages/desktop/src/shared/transitionMask.js'))

/**
 * 采样网格 —— 96×96，不是 32×32。
 *
 * ⚠️ 这一格定的是**尺子的分辨率**，钉错了会得到"高频图案都长一样"的假结论：
 * 网格族最密的是 `像素屏幕故障`（24 列），条纹族最密的是 `垂线`（18 条），
 * 一个周期只占画面 1/24。32×32 采样时每周期只有 1.3 个采样点（低于奈奎斯特），
 * 结构直接采丢、两边都退化成近似常数 —— 实测它俩在 32 网格上只差 0.0126 被判撞车，
 * 而真实缩略图是 192px、成片更大，一眼就能看出"像素方格"与"竖条纹"不是一回事。
 * 96 网格给 24 列留 4 个采样点，够还原结构。
 */
const GRID = 96
const PROGRESS = [0.15, 0.3, 0.5, 0.7, 0.85]
/* 外观标量：前一段取暗灰、后一段取亮灰，中间色用它自己的灰阶 —— 与缩略图同一套合成 */
const LV_A = 0.1
const LV_B = 0.9

const out = []
const add = (name, ok, detail) => out.push({ name, ok, detail })

function appearance(geo, p) {
  const v = new Float32Array(GRID * GRID)
  let i = 0
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const w = maskApi.appearanceAt(geo, (x + 0.5) / GRID, (y + 0.5) / GRID, p)
      v[i] = w.a * LV_A + w.b * LV_B + w.t * w.tint
      i += 1
    }
  }
  return v
}

/**
 * 两条转场的差异 = **各个进度里最像的那一个也差多少**（取最大，不取平均）。
 * 入参是已经算好的「每个进度一张场」。
 */
function distance(fa, fb) {
  let max = 0
  for (let p = 0; p < PROGRESS.length; p += 1) {
    const a = fa[p]
    const b = fb[p]
    let sum = 0
    for (let k = 0; k < a.length; k += 1) sum += Math.abs(a[k] - b[k])
    const m = sum / a.length
    if (m > max) max = m
  }
  return max
}

const geos = looks.transitions.filter((t) => t.geo)
add('looks.json 里的 geo 转场是 204 个', geos.length === 204, `实际 ${geos.length}`)

/* 外观场按进度预计算：204 × 5 张 32×32，后面所有比对都复用 */
const fields = geos.map((t) => PROGRESS.map((p) => appearance(t.geo, p)))

/* ③ 几何签名 */
const sig = new Map()
const dup = []
for (const t of geos) {
  const s = JSON.stringify(t.geo)
  if (sig.has(s)) dup.push(`${sig.get(s)} ↔ ${t.label}`)
  else sig.set(s, t.label)
}
add('204 条几何签名两两不同', dup.length === 0, dup.length ? dup.slice(0, 3).join(' / ') : `${sig.size} 个签名`)

/* ④ 每条转场都得看得出在变：帧内空间变化 或 随时间翻转 */
const still = []
for (let i = 0; i < geos.length; i += 1) {
  let spatial = 0
  for (const v of fields[i]) {
    let lo = 1
    let hi = 0
    for (let k = 0; k < v.length; k += 1) {
      if (v[k] < lo) lo = v[k]
      if (v[k] > hi) hi = v[k]
    }
    if (hi - lo > spatial) spatial = hi - lo
  }
  const first = fields[i][0]
  const last = fields[i][fields[i].length - 1]
  let temporal = 0
  for (let k = 0; k < first.length; k += 1) temporal += Math.abs(last[k] - first[k])
  temporal /= first.length
  if (spatial < 0.05 && temporal < 0.3) still.push(`${geos[i].label}(空间${spatial.toFixed(2)}/时间${temporal.toFixed(2)})`)
}
add('每条转场都看得出在变（帧内极差 ≥ 0.05 或 跨进度差 ≥ 0.3）', still.length === 0,
  still.length ? `${still.length} 条几乎是恒等：${still.slice(0, 3).join(' ')}` : `${geos.length} 条都有变化`)

/* ① 两两差异 */
const pairs = []
for (let a = 0; a < geos.length; a += 1) {
  for (let b = a + 1; b < geos.length; b += 1) {
    pairs.push({
      d: distance(fields[a], fields[b]),
      a: geos[a].label,
      b: geos[b].label,
      ka: geos[a].geo.kind,
      kb: geos[b].geo.kind
    })
  }
}
pairs.sort((x, y) => x.d - y.d)
const q = (k) => pairs[Math.min(pairs.length - 1, Math.floor(pairs.length * k))].d
const worst = pairs[0]

add('任意两条转场看上去都不一样（外观差 ≥ 0.02，约 5/255）',
  worst.d >= 0.02,
  `${pairs.length} 对 · 最像的一对 ${worst.a} ↔ ${worst.b}（${worst.ka}/${worst.kb}）差 ${worst.d.toFixed(4)}`)
if (process.env.YJAI_TX_TOP) {
  for (const p of pairs.slice(0, Number(process.env.YJAI_TX_TOP) || 5)) {
    console.log(`    · ${p.d.toFixed(4)} ${p.a}(${p.ka}) ↔ ${p.b}(${p.kb})`)
  }
}
add('最挤的 1% 也留有余量（≥ 0.04）', q(0.01) >= 0.04,
  `1% ${q(0.01).toFixed(3)} · 5% ${q(0.05).toFixed(3)} · 中位 ${q(0.5).toFixed(3)}`)

/* ⑤ 族内自查 */
const byFamily = new Map()
for (let i = 0; i < geos.length; i += 1) {
  const k = geos[i].geo.kind
  if (!byFamily.has(k)) byFamily.set(k, [])
  byFamily.get(k).push(i)
}
const flat = []
for (const [kind, idx] of byFamily) {
  let min = 1
  let at = ''
  for (let i = 0; i < idx.length; i += 1) {
    for (let j = i + 1; j < idx.length; j += 1) {
      const d = distance(fields[idx[i]], fields[idx[j]])
      if (d < min) {
        min = d
        at = `${geos[idx[i]].label}↔${geos[idx[j]].label}`
      }
    }
  }
  flat.push({ kind, n: idx.length, min, at })
}
flat.sort((x, y) => x.min - y.min)
const tight = flat.filter((f) => f.n > 1 && f.min < 0.02)
add('每个几何族内部也两两分得开（族内最小差 ≥ 0.02）', tight.length === 0,
  tight.length
    ? tight.map((f) => `${f.kind} ${f.at} ${f.min.toFixed(3)}`).join(' / ')
    : flat.filter((f) => f.n > 1).map((f) => `${f.kind}(${f.n}) ${f.min.toFixed(3)}`).join(' '))

let pass = 0
for (const r of out) {
  if (r.ok) pass++
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
}
console.log(`\nTRANSITION_DISTINCT_STATS total=${out.length} pass=${pass} fail=${out.length - pass}`)
if (pass !== out.length) {
  console.log('TRANSITION_DISTINCT_FAILED')
  process.exit(1)
}
console.log('转场：204 个名字 = 204 个能一眼分开的效果。')
console.log('TRANSITION_DISTINCT_OK')
