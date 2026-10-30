/**
 * 曲线（RGB 三通道）纯逻辑自测。
 *
 * 证两件事：
 *   ① 控制点 → 256 项查找表这件事算得对（样条过点、不乱序、不越界、不越阈值）；
 *   ② 预览（SVG tableValues）与导出（ffmpeg `curves` 串）**用同一份表**——
 *      最后几条拿本机 ffmpeg 真跑一遍灰度渐变，把输出字节与我们的表逐项比对。
 *
 * 为什么非要跟 ffmpeg 对一次：`curves` 的插值在 ffmpeg 里是自然三次样条，
 *   如果我们改用单调样条（看起来更"稳"），控制点照样过点、照样单调，
 *   上面所有断言依然全绿，但成片的形状会和预览**不一样**（暗部差一档）。
 *   只有拿真 ffmpeg 的输出当判据才抓得住这类"两边都对但不一样"。
 *
 * 跑法：node tools/curves-selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const curves = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'curves.js'))

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

/** 环境不足记 SKIP（不是 FAIL）：总数恒定，否则"断言数不符"和"真的少验了"分不开 */
function skipOne(name, why) {
  skip += 1
  skipped.push(name + (why ? ` — ${why}` : ''))
  console.log(`  [SKIP] ${name}  — ${why}`)
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

console.log('=== 曲线自测 ===')

/* ------------------------------ ① 读取与规范化 ------------------------------ */

console.log('\n-- 控制点读取 --')
const neutral = curves.readCurves(undefined)
check('缺省读取：四条通道全是中性直线',
  curves.CURVE_CHANNELS.every((c) => neutral[c.key].length === 2
    && near(neutral[c.key][0].x, 0) && near(neutral[c.key][0].y, 0)
    && near(neutral[c.key][1].x, 1) && near(neutral[c.key][1].y, 1)))

check('isNeutral：空对象判中性', curves.isNeutral({}) === true)
check('isNeutral：缺省参数判中性', curves.isNeutral(undefined) === true)
check('isNeutral：任一通道动过就不中性',
  curves.isNeutral({ rgb: [{ x: 0, y: 0 }, { x: 1, y: 0.9 }] }) === false)

check('非数组输入退回中性（不是抛错）',
  curves.readPoints('oops').length === 2 && curves.readPoints({ x: 0, y: 0 }).length === 2)
check('NaN / 无穷点被丢掉',
  curves.readPoints([{ x: 0, y: 0 }, { x: NaN, y: 0.5 }, { x: 1, y: 1 }]).length === 2)
check('只有一个点的曲线退回中性',
  curves.readPoints([{ x: 0.5, y: 0.5 }]).length === 2
  && curves.readPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }]).length === 2)

const unsorted = curves.readPoints([{ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0.5, y: 0.7 }])
check('x 乱序会被排序',
  near(unsorted[0].x, 0) && near(unsorted[1].x, 0.5) && near(unsorted[2].x, 1),
  unsorted.map((p) => p.x).join(','))

const dup = curves.readPoints([{ x: 0, y: 0 }, { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }])
check('x 重合的点去重（保留后一个）',
  dup.length === 3 && near(dup[1].y, 0.6), `${dup.length} 点`)

const pinned = curves.readPoints([{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.9 }])
check('端点被钉到 x=0 / x=1（y 保留原值）',
  near(pinned[0].x, 0) && near(pinned[0].y, 0.1) && near(pinned[1].x, 1) && near(pinned[1].y, 0.9))

const many = Array.from({ length: 30 }, (_, i) => ({ x: i / 29, y: i / 29 }))
check(`最多收 ${curves.MAX_POINTS} 点（再多的截掉）`, curves.readPoints(many).length === curves.MAX_POINTS,
  `收到 ${curves.readPoints(many).length}`)

const outOfRange = curves.readPoints([{ x: 0, y: -0.4 }, { x: 1, y: 1.4 }])
check('超出 0..1 的 y 被钳住（否则 tableValues 会出负值）',
  near(outOfRange[0].y, 0) && near(outOfRange[1].y, 1))

/* ------------------------------ ② 查找表本身 ------------------------------ */

console.log('\n-- 查找表 --')
const identity = curves.lutOf(curves.NEUTRAL_POINTS)
check(`查找表长度固定 ${curves.LUT_SIZE}`, identity.length === curves.LUT_SIZE)
check('恒等曲线：lut[i] ≈ i/255（误差 < 1e-6）',
  identity.every((v, i) => near(v, i / (curves.LUT_SIZE - 1), 1e-6)),
  `最大误差 ${Math.max(...identity.map((v, i) => Math.abs(v - i / (curves.LUT_SIZE - 1))))}`)
check('恒等曲线：首尾严格是 0 与 1', identity[0] === 0 && identity[curves.LUT_SIZE - 1] === 1)

const bright = curves.lutOf([{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }])
const midIdx = Math.round((curves.LUT_SIZE - 1) / 2)
check('样条**过控制点**：x=0.5 处正好是 0.65', near(bright[midIdx], 0.65, 0.002),
  `lut[${midIdx}] = ${bright[midIdx].toFixed(5)}`)
check('提亮曲线：中点确实比恒等高', bright[midIdx] > identity[midIdx])
let monotone = true
for (let i = 1; i < bright.length; i += 1) if (bright[i] + 1e-9 < bright[i - 1]) monotone = false
check('单调输入 ⇒ 单调输出（样条没在中间回退）', monotone)
check('值域钳在 0..1', bright.every((v) => v >= 0 && v <= 1))

/* 压黑再提白：端点 y 可动，但表仍然充满 0..1 */
const sCurve = curves.lutOf([{ x: 0, y: 0.08 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.96 }])
check('端点可上下滑动（压黑 / 提白）', near(sCurve[0], 0.08, 0.002) && near(sCurve[curves.LUT_SIZE - 1], 0.96, 0.002),
  `${sCurve[0].toFixed(3)} … ${sCurve[curves.LUT_SIZE - 1].toFixed(3)}`)

/* ---------------------- ③ master 与单通道的复合顺序 ---------------------- */

console.log('\n-- 通道复合顺序（必须与 ffmpeg 一致：先 RGB，再单通道）--')
/* master 把一切压到 0.5 以内；r 曲线在 0.5 处输出 0、在 1 处输出 1。
   先 master 后 r ⇒ r(0.5)=0；反过来的话 r(1)=1 再过 master = 0.5。
   两者差 0.5，肉眼一看就能分辨，所以这条断言是**可分辨的**，不是走个形式。 */
const orderTest = {
  rgb: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }],
  r: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 1 }]
}
const rLut = curves.channelLut(orderTest, 'r')
check('先过 RGB 再过本通道（r(ch(1)) = 0，反序会得 0.5）', near(rLut[curves.LUT_SIZE - 1], 0, 0.002),
  `lut[255] = ${rLut[curves.LUT_SIZE - 1].toFixed(4)}`)
const rgbLut = curves.channelLut(orderTest, 'rgb')
check('rgb 通道就是 master 本身（不再额外复合）', near(rgbLut[curves.LUT_SIZE - 1], 0.5, 0.002),
  `lut[255] = ${rgbLut[curves.LUT_SIZE - 1].toFixed(4)}`)

check('applyLut 在端点外钳住（不抛错、不外插）',
  near(curves.applyLut(identity, -5), 0) && near(curves.applyLut(identity, 5), 1))
const half = curves.applyLut(identity, 0.5)
check('applyLut 线性插值：恒等表取 0.5 得 0.5', near(half, 0.5, 0.005), half.toFixed(4))

/* --------------------------- ④ 两个消费端的形态 --------------------------- */

console.log('\n-- 预览 / 导出 两种输出形态 --')
const tables = curves.tableValuesOf(bright ? { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }] } : {})
const items = tables.r.split(' ')
check('tableValues 有 256 项（feComponentTransfer 的粒度）', items.length === curves.LUT_SIZE, `${items.length} 项`)
check('tableValues 全是普通小数（无科学计数、无 NaN）',
  items.every((s) => /^\d+(\.\d{1,4})?$/.test(s)), items.slice(0, 3).join(','))

/* 这一条是真机踩出来的回归：只调 RGB 时，三路表必须是"复合过 RGB 的表"。
   用单通道原表的话三路都是恒等，定义挂上了、画面一点不变 —— 而 isNeutral 看的是
   rgb 通道非中性，于是"有定义 + 恒等表"这种最隐蔽的状态就这样出现了。 */
const onlyRgb = curves.tableValuesOf({ rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }] })
const rgbMid = Number(onlyRgb.r.split(' ')[128])
check('只调 RGB · 三路表已复合 RGB（中点 > 0.6，不是恒等的 0.502）', rgbMid > 0.6,
  `r 表中点 ${rgbMid}`)

check('ffmpeg 串：中性时返回空（不挂恒等滤镜）', curves.ffmpegCurves({}) === '')
const ff = curves.ffmpegCurves({ rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }], r: [{ x: 0, y: 0 }, { x: 0.4, y: 0.2 }, { x: 1, y: 1 }] })
check('ffmpeg 串：只列非中性通道', /master='/.test(ff) && /:r='/.test(ff) && !/:g='/.test(ff) && !/:b='/.test(ff), ff)
check('ffmpeg 串：RGB 通道写作 master', /^master='0\/0 0\.5\/0\.65 1\/1'/.test(ff), ff)
check('ffmpeg 串：坐标是 x/y 空格分隔、最多 4 位小数',
  /r='0\/0 0\.4\/0\.2 1\/1'/.test(ff), ff)

/* ------------------------------- ⑤ 拖点工具 ------------------------------- */

console.log('\n-- 拖拽辅助 --')
const drag = curves.movePoint([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }], 0, 0.4, 0.9)
check('端点只能上下动（x 被钉回 0）', near(drag[0].x, 0) && near(drag[0].y, 0.9))
const cross = curves.movePoint([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }], 1, 1.5, 0.5)
check('中间点不会穿过右邻居（x 被压到 1-0.005 以内）',
  cross[1].x <= 1 - 0.005 + 1e-9 && cross[1].x > 0, cross[1].x.toFixed(4))

/* --------------------- ⑥ 真 ffmpeg 对表（本机有就必跑） --------------------- */

console.log('\n-- 与真 ffmpeg 的 curves 逐项对表 --')
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
const W = curves.LUT_SIZE
const rawFile = path.join(os.tmpdir(), `yjai-curves-${process.pid}.gray`)

/** 造一条 0..255 的灰度渐变，按给定 curves 串处理后输出原始 8bit 灰度 */
function ffmpegRamp(filter) {
  const r = spawnCapture(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `nullsrc=s=${W}x1,geq=lum='X':cb=128:cr=128,format=gray`,
    '-vf', `curves=${filter}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', rawFile
  ], { tag: 'ramp' })
  if (r.status !== 0) return null
  try {
    return fs.readFileSync(rawFile)
  } catch {
    return null
  }
}

if (!ffmpeg) {
  /* 三组对表一样多记 SKIP，而不是只记一条 —— 总数恒定，闸门才能把总数钉死 */
  for (const name of ['单点提亮 0.5→0.65', 'S 形四点', '压黑提白（端点不动）']) {
    skipOne(`ffmpeg 对表 · ${name}`, '本机没有 ffmpeg（设 FFMPEG_PATH 后重跑）')
  }
} else {
  const cases = [
    { name: '单点提亮 0.5→0.65', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }] },
    { name: 'S 形四点', points: [{ x: 0, y: 0 }, { x: 0.25, y: 0.15 }, { x: 0.75, y: 0.9 }, { x: 1, y: 1 }] },
    { name: '压黑提白（端点不动）', points: [{ x: 0, y: 0 }, { x: 0.2, y: 0.1 }, { x: 0.8, y: 0.92 }, { x: 1, y: 1 }] }
  ]
  for (const item of cases) {
    const raw = ffmpegRamp(`master='${item.points.map((p) => `${p.x}/${p.y}`).join(' ')}'`)
    if (!raw || raw.length !== W) {
      check(`ffmpeg 对表 · ${item.name}`, false, `输出 ${raw ? raw.length : 'null'} 字节（应为 ${W}）`)
      continue
    }
    const ours = curves.lutOf(item.points).map((v) => Math.round(v * 255))
    let worst = 0
    let worstAt = 0
    for (let i = 0; i < W; i += 1) {
      const diff = Math.abs(raw[i] - ours[i])
      if (diff > worst) {
        worst = diff
        worstAt = i
      }
    }
    /* 容差 2：ffmpeg 内部走 rgb 再回灰度会引入 1 以内的舍入，两处相加到 2。
       再大就说明我们的样条与它的不是同一种（单调样条在这里会差到 5 以上）。 */
    check(`ffmpeg 对表 · ${item.name}（最大偏差 ≤ 2）`, worst <= 2,
      `最大偏差 ${worst} @ 输入 ${worstAt}（它 ${raw[worstAt]} / 我们 ${ours[worstAt]}）`)
  }
  try {
    fs.unlinkSync(rawFile)
  } catch {
    /* ignore */
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
console.log(`CURVES_SELFTEST_STATS total=${total} pass=${pass} fail=${fail} skip=${skip}`)
if (!fail) console.log('CURVES_SELFTEST_OK')
process.exit(fail ? 1 : 0)
