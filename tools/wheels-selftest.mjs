/**
 * 一级色轮（阴影 / 中间调 / 高光 / 全局）纯逻辑自测。
 *
 * 证三件事：
 *   ① 手柄方向 → 颜色的换算是对的（色相、强度、半径归一）；
 *   ② 三段式语义真的成立（阴影只动暗部、高光只动亮部、中间调两端不动）；
 *   ③ 预览（SVG 256 项表）与导出（ffmpeg `lutrgb` 表达式）**是同一份映射** ——
 *      最后几条拿本机 ffmpeg 把 0..255 渐变跑一遍，逐值比三路输出。
 *
 * 第 ③ 条是重点：`lutrgb` 的表达式是我们自己拼的，拼错一个符号（比如把
 * `1/gamma` 写成 `gamma`）在断言①②里全都看不出来 —— 那两条只看形状不看数值。
 * 只有真 ffmpeg 的输出能证明"预览里那一档，成片里也是那一档"。
 *
 * 跑法：node tools/wheels-selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wheels = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'wheels.js'))

let pass = 0
let fail = 0
let skip = 0
const failures = []
const skipped = []

function check(name, ok, detail = '') {
  if (ok) pass += 1
  else {
    fail += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
  }
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 环境不足记 SKIP（不是 FAIL）：总数恒定，否则"断言数不符"与"真的少验了"分不开 */
function skipOne(name, why) {
  skip += 1
  skipped.push(name + (why ? ` — ${why}` : ''))
  console.log(`  [SKIP] ${name}  — ${why}`)
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

console.log('=== 一级色轮自测 ===')

/* ------------------------------ ① 读取与规范化 ------------------------------ */

console.log('\n-- 轮子读取 --')
const neutral = wheels.readWheels(undefined)
check('缺省读取：四个轮都在圆心、亮度 0',
  wheels.WHEEL_RANGES.every((r) => near(neutral[r.key].x, 0)
    && near(neutral[r.key].y, 0) && near(neutral[r.key].level, 0)))

check('isNeutral：空对象判中性', wheels.isNeutral({}) === true)
check('isNeutral：缺省参数判中性', wheels.isNeutral(undefined) === true)
check('isNeutral：任一轮推离圆心就不中性',
  wheels.isNeutral({ shadow: { x: 0.2, y: 0 } }) === false)
check('isNeutral：只动亮度滑杆也不中性',
  wheels.isNeutral({ mid: { level: 30 } }) === false)

const corner = wheels.readWheel({ x: 1, y: 1 })
check('圆外的位置被钳进单位圆（半径 = 1，不是 1.414）',
  near(Math.hypot(corner.x, corner.y), 1, 1e-6), `半径 ${Math.hypot(corner.x, corner.y).toFixed(4)}`)

const overflow = wheels.readWheel({ x: 3, y: 4, level: 500 })
check('超远的位置沿同方向钳回圆周（色相不变）',
  near(overflow.x, 0.6, 1e-6) && near(overflow.y, 0.8, 1e-6))
check('亮度钳在 -100..100', overflow.level === 100)

const junk = wheels.readWheel({ x: NaN, y: 'oops', level: undefined })
check('NaN / 字符串 / 缺字段都不抛错，退回中性',
  junk.x === 0 && junk.y === 0 && junk.level === 0)

/* ------------------------------- ② 颜色换算 ------------------------------- */

console.log('\n-- 手柄方向 → 颜色 --')
check('色相：右=0°（红）、上=90°、左=180°、下=270°',
  near(wheels.hueOf(1, 0), 0) && near(wheels.hueOf(0, 1), 90)
  && near(wheels.hueOf(-1, 0), 180) && near(wheels.hueOf(0, -1), 270))

const center = wheels.vectorOf({ x: 0, y: 0 })
check('圆心：三分量全 0（不动画面）',
  center.r === 0 && center.g === 0 && center.b === 0)

const halfRed = wheels.vectorOf({ x: 0.5, y: 0 })
check('半量程推红：红 +0.5、绿蓝 -0.5',
  near(halfRed.r, 0.5) && near(halfRed.g, -0.5) && near(halfRed.b, -0.5),
  `${halfRed.r}/${halfRed.g}/${halfRed.b}`)

/* 强度必须在任意色相下一致，否则"推到顶"在蓝方向和红方向不是同一个重量 */
let uniform = true
let worstHue = ''
for (let i = 0; i < 24; i += 1) {
  const angle = (i / 24) * Math.PI * 2
  const vec = wheels.vectorOf({ x: Math.cos(angle) * 0.7, y: Math.sin(angle) * 0.7 })
  const magnitude = Math.max(Math.abs(vec.r), Math.abs(vec.g), Math.abs(vec.b))
  if (Math.abs(magnitude - 0.7) > 1e-6) {
    uniform = false
    worstHue = `${(angle * 180 / Math.PI).toFixed(0)}° → ${magnitude.toFixed(4)}`
  }
}
check('任意色相推 0.7 半径，最大分量都是 0.7（强度不随色相变）', uniform, worstHue)

const opposite = wheels.vectorOf({ x: -0.5, y: 0 })
check('相对方向的手柄得到相反的向量',
  near(opposite.r, -0.5) && near(opposite.g, 0.5) && near(opposite.b, 0.5))

/* ------------------------------- ③ 三段式语义 ------------------------------- */

console.log('\n-- 阴影 / 中间调 / 高光 / 全局 各自的作用区 --')
const lutOf = (src, ch = 'b') => wheels.lutOf(src, ch)

const shadowBlue = lutOf({ shadow: { x: -0.26, y: -0.16 } })
check('阴影推蓝：黑位明显变蓝', shadowBlue[0] > 0.03, `lut[0] = ${shadowBlue[0].toFixed(4)}`)
check('阴影推蓝：白位仍钉在 1（加性被 255 钳住，只影响暗部）',
  near(shadowBlue[255], 1, 1e-9), `lut[255] = ${shadowBlue[255].toFixed(4)}`)

const highWarm = lutOf({ high: { x: 0.44, y: 0 } })
check('高光推暖：红通道黑位几乎不动', Math.abs(highWarm[0]) < 0.02, `lut[0] = ${highWarm[0].toFixed(4)}`)
check('高光推暖：红通道白位被压到 1 以下（乘性作用在高光）',
  highWarm[255] < 0.99, `lut[255] = ${highWarm[255].toFixed(4)}`)

const midGamma = lutOf({ mid: { level: 80 } })
check('中间调提亮：两端不动（0 还是 0、1 还是 1）',
  near(midGamma[0], 0, 1e-9) && near(midGamma[255], 1, 1e-9),
  `${midGamma[0].toFixed(4)} / ${midGamma[255].toFixed(4)}`)
check('中间调提亮：中点被抬起来', midGamma[128] > 0.6, `lut[128] = ${midGamma[128].toFixed(4)}`)

const globalTint = lutOf({ global: { x: -0.3, y: 0 } })
check('全局染色：连黑位一起偏（与"只动暗部"的阴影轮不同）',
  globalTint[0] > 0.02 && globalTint[255] > 1 - 1e-9,
  `黑 ${globalTint[0].toFixed(4)} / 白 ${globalTint[255].toFixed(4)}`)

/* 亮度滑杆与手柄必须作用在同一次换算上：两条路都要能推动画面 */
const byHandle = lutOf({ mid: { x: 0, y: 0.5 } }, 'g')
const byLevel = lutOf({ mid: { level: 50 } }, 'g')
check('中间调：推手柄与拉亮度滑杆都会提亮绿通道（同一处换算）',
  byHandle[128] > 0.52 && byLevel[128] > 0.52,
  `手柄 ${byHandle[128].toFixed(4)} / 滑杆 ${byLevel[128].toFixed(4)}`)

check('亮度推到 +100 时 gamma 不会撞成 0（除零保护）',
  Number.isFinite(wheels.stagesOf({ mid: { level: 100 } }).g.gamma)
  && wheels.stagesOf({ mid: { level: 100 } }).g.gamma > 0.2)

/* ------------------------------ ④ 两个消费端 ------------------------------ */

console.log('\n-- 预览 / 导出 两种输出形态 --')
const luts = wheels.lutsOf({ shadow: { x: -0.26, y: -0.16 } })
check(`三路表长度都是 ${wheels.LUT_SIZE}`,
  luts.r.length === wheels.LUT_SIZE && luts.g.length === wheels.LUT_SIZE && luts.b.length === wheels.LUT_SIZE)
check('表的值域钳在 0..1',
  [...luts.r, ...luts.g, ...luts.b].every((v) => v >= 0 && v <= 1))

const neutralTables = wheels.tableValuesOf({})
const neutralR = neutralTables.r.split(' ').map(Number)
check('中性轮：表就是恒等表（i/255）',
  neutralR.every((v, i) => near(v, i / 255, 1e-5)),
  `中点 ${neutralR[128]}`)

const tables = wheels.tableValuesOf({ shadow: { x: -0.26, y: -0.16 } })
const items = tables.b.split(' ')
check('tableValues 有 256 项（feComponentTransfer 的粒度）', items.length === wheels.LUT_SIZE, `${items.length} 项`)
check('tableValues 全是普通小数（无科学计数、无 NaN）',
  items.every((s) => /^\d+(\.\d{1,6})?$/.test(s)), items.slice(0, 3).join(','))

check('ffmpeg 串：中性时返回空（不挂恒等滤镜）', wheels.ffmpegWheels({}) === '')
const expr = wheels.ffmpegWheels({ shadow: { x: -0.26, y: -0.16 }, high: { x: 0.4, y: 0 } })
check('ffmpeg 串：是 lutrgb 且三路都给了',
  /^lutrgb=r='.+':g='.+':b='.+$/.test(expr), expr.slice(0, 60))
check('ffmpeg 串：表达式里用 val/255 归一（不是直接用 val）',
  /pow\(clip\(val\/255,0,1\)/.test(expr))
check('ffmpeg 串：没有科学计数法（ffmpeg 的表达式解析器不认 1e-7）',
  !/e-?\d/.test(expr))

/* -------------------------------- ⑤ 预置 -------------------------------- */

console.log('\n-- 预置 --')
const presetWarm = wheels.applyPreset({}, 'warm')
check('预置「暖调」把阴影与高光都推向暖色',
  presetWarm.shadow.y > 0 && presetWarm.high.x > 0,
  `阴影 y=${presetWarm.shadow.y} / 高光 x=${presetWarm.high.x}`)
check('预置可叠加在已有手柄上（不是覆盖）',
  wheels.applyPreset({ shadow: { x: 0.2, y: 0.2 } }, 'warm').shadow.x > 0.4)
check('预置叠加后仍被钳进单位圆',
  Math.hypot.apply(null, (() => {
    const w = wheels.applyPreset({ shadow: { x: 0.9, y: 0.9 } }, 'warm').shadow
    return [w.x, w.y]
  })()) <= 1 + 1e-9)
check('预置「归零」把四个轮全部清回中性',
  wheels.isNeutral(wheels.applyPreset({ shadow: { x: 0.5, y: 0.5 }, mid: { level: 40 } }, 'none')))
check('未知预置名退回「归零」（不抛错）',
  wheels.isNeutral(wheels.applyPreset({ shadow: { x: 0.5, y: 0 } }, 'nope')))

/* ------------------------------ ⑥ 色环渐变 ------------------------------ */

console.log('\n-- 色环 conic 渐变的停止点 --')
const stops = wheels.hueStops(30)
check('12 个停止点（每 30° 一个）', stops.length === 12, `${stops.length} 个`)
check('停止点按 t 递增（CSS 要求顺序）',
  stops.every((s, i) => i === 0 || s.t > stops[i - 1].t))
/* 手柄在正右方时色相 0（红）。屏幕坐标里正右方 = 顺时针 90°，所以红色要停在 90° 处。
   如果这里算成 0°（照抄色相），色环会把蓝画在"红"的位置上 —— 拖了才发现，靠试很难定位。 */
check('红色（色相 0）停在 90°：手柄向右拖，环上那个方向也是红',
  stops.find((s) => s.h === 0).t === 90)
check('蓝色（色相 240）停在 -150° 归一后的 210°',
  stops.find((s) => s.h === 240).t === 210)

/* --------------------- ⑦ 真 ffmpeg 对表（有就必跑） --------------------- */

console.log('\n-- 与真 ffmpeg 的 lutrgb 逐项对表 --')
function findFfmpeg() {
  const candidate = [
    process.env.YIJAI_FFMPEG,
    process.env.FFMPEG_PATH,
    path.join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe'),
    'ffmpeg.exe',
    'ffmpeg'
  ].filter(Boolean)
  for (const bin of candidate) {
    const r = spawnCapture(bin, ['-hide_banner', '-version'], { tag: 'ver' })
    if (r.status === 0) return bin
  }
  return ''
}

const ffmpeg = findFfmpeg()
const W = wheels.LUT_SIZE
const rawFile = path.join(os.tmpdir(), `yjai-wheels-${process.pid}.rgb`)
const rampFile = path.join(os.tmpdir(), `yjai-wheels-${process.pid}-ramp.bmp`)

/**
 * 自己写一张 256×1 的 BMP 灰阶渐变，像素值 (i,i,i) 由我们定死。
 *
 * 为什么不用 lavfi 的 `nullsrc,geq=lum='X'`：那条路出来的先是 YUV，
 * 再 `format=rgb24` 会按 limited-range 拉伸（16→0、235→255），
 * 于是"第 231 个像素"其实不是 231 —— 与我们的表逐项比对会差出十几级，
 * 看着像"表达式算错了"，实际是进来之前就被动过（本机实测偏差 18）。
 * BMP 是未压缩 BGR，ffmpeg 解出来就是原值，一个矩阵都不经过。
 */
function writeRamp() {
  const rowBytes = W * 3
  const buf = Buffer.alloc(54 + rowBytes)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(54 + rowBytes, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(W, 18)
  buf.writeInt32LE(1, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(rowBytes, 34)
  for (let i = 0; i < W; i += 1) {
    buf[54 + i * 3] = i
    buf[54 + i * 3 + 1] = i
    buf[54 + i * 3 + 2] = i
  }
  fs.writeFileSync(rampFile, buf)
  return rampFile
}

/** 把这张渐变按给定 lutrgb 串处理一遍，输出 rgb24 原始字节 */
function ffmpegRamp(filter) {
  writeRamp()
  const r = spawnCapture(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', rampFile,
    '-vf', `format=rgb24,${filter}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawFile
  ], { tag: 'ramp' })
  if (r.status !== 0) return null
  try {
    return fs.readFileSync(rawFile)
  } catch {
    return null
  }
}

if (!ffmpeg) {
  for (const name of ['阴影推蓝', '高光暖 + 中间调压', '全局染色']) {
    skipOne(`ffmpeg 对表 · ${name}`, '本机没有 ffmpeg（设 FFMPEG_PATH 后重跑）')
  }
} else {
  const cases = [
    { name: '阴影推蓝', src: { shadow: { x: -0.26, y: -0.16 } } },
    { name: '高光暖 + 中间调压', src: { high: { x: 0.44, y: 0 }, mid: { level: -40 } } },
    { name: '全局染色', src: { global: { x: -0.3, y: 0 } } }
  ]
  for (const item of cases) {
    const raw = ffmpegRamp(wheels.ffmpegWheels(item.src))
    if (!raw || raw.length !== W * 3) {
      check(`ffmpeg 对表 · ${item.name}`, false, `输出 ${raw ? raw.length : 'null'} 字节（应为 ${W * 3}）`)
      continue
    }
    const ours = wheels.lutsOf(item.src)
    let worst = 0
    let worstAt = ''
    for (const [ch, offset] of [['r', 0], ['g', 1], ['b', 2]]) {
      for (let i = 0; i < W; i += 1) {
        const diff = Math.abs(raw[i * 3 + offset] - Math.round(ours[ch][i] * 255))
        if (diff > worst) {
          worst = diff
          worstAt = `${ch}[${i}]（它 ${raw[i * 3 + offset]} / 我们 ${Math.round(ours[ch][i] * 255)}）`
        }
      }
    }
    /* 容差 2：它内部是 8bit 整数运算、我们是浮点，边界处各差 1 是正常的。
       再大就说明表达式与 transfer() 不是同一条式子（把 1/gamma 写成 gamma 会差 20 以上）。 */
    check(`ffmpeg 对表 · ${item.name}（最大偏差 ≤ 2）`, worst <= 2,
      `最大偏差 ${worst} @ ${worstAt}`)
  }
  for (const leftover of [rawFile, rampFile]) {
    try {
      fs.unlinkSync(leftover)
    } catch {
      /* ignore */
    }
  }
}

console.log('')
if (failures.length) {
  console.log('失败项：')
  for (const item of failures) console.log('  · ' + item)
}
if (skipped.length) {
  console.log('跳过项：')
  for (const item of skipped) console.log('  · ' + item)
}
const total = pass + fail + skip
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
console.log(`WHEELS_SELFTEST_STATS total=${total} pass=${pass} fail=${fail} skip=${skip}`)
if (!fail) console.log('WHEELS_SELFTEST_OK')
process.exit(fail ? 1 : 0)
