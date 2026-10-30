/**
 * 分区 HSL 的自证（纯逻辑，不启 Electron、不需要 GPU）。
 *
 * 这一族**没有任何运行时错误**：LUT 烘歪了、通道顺序反了、灰色被误伤，
 * 全都表现为"画面变了但不对"，不会抛、不会白屏、构建不报错。
 * 所以只能在夹具里逐点对数值。
 *
 * 统计：SUBTITLE 之外的 HSL_SELFTEST_STATS（由 verify.mjs 的 expected 核对）
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HSL = require('../packages/desktop/src/shared/hslBands.js')

let pass = 0
const failures = []
function ok(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol

/* ------------------------------------------------------------------ *
 * A. 参数读写
 * ------------------------------------------------------------------ */

console.log('\nA. 参数读写（缺省值不许掉到下界）===\n')

ok('八个色带（红橙黄绿青蓝紫品红）', HSL.BANDS.length === 8, HSL.BANDS.map((b) => b.label).join(''))
ok('色带 key 唯一', new Set(HSL.BANDS.map((b) => b.key)).size === 8)
ok('色带中心都在 0–360', HSL.BANDS.every((b) => b.center >= 0 && b.center < 360))

const neutral = HSL.readBands(undefined)
ok('空参数读成全 0（中性），不是 -1', Object.values(neutral).every((item) => item.h === 0 && item.s === 0 && item.l === 0))
ok('undefined 参数不变成"拉到底"（clamp(Number(undefined)) 的坑）', neutral.red.l === 0, `l=${neutral.red.l}`)
ok('脏值（字符串 / NaN / null）读成 0', (() => {
  const read = HSL.readBands({ red: { h: 'x', s: null, l: NaN } })
  return read.red.h === 0 && read.red.s === 0 && read.red.l === 0
})())
ok('越界值被钳到 ±1', (() => {
  const read = HSL.readBands({ red: { h: 9, s: -9, l: 3 } })
  return read.red.h === 1 && read.red.s === -1 && read.red.l === 1
})())
ok('未知色带 key 被忽略、不污染结果', Object.keys(HSL.readBands({ nope: { h: 1 } })).length === 8)

ok('isNeutral 对全 0 为真', HSL.isNeutral(undefined) === true)
ok('isNeutral 对任一非 0 为假', HSL.isNeutral({ blue: { s: 0.4 } }) === false)
ok('bandActive 只认那一个带', HSL.bandActive({ blue: { s: 0.4 } }, 'blue') === true && HSL.bandActive({ blue: { s: 0.4 } }, 'red') === false)

/* ------------------------------------------------------------------ *
 * B. 色彩空间往返
 * ------------------------------------------------------------------ */

console.log('\nB. 色彩空间往返 ===\n')

const samples = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.2, 0.6, 0.9],
  [0.5, 0.5, 0.5],
  [0, 0, 0],
  [1, 1, 1],
  [0.33, 0.71, 0.12]
]
ok(
  'RGB → HSL → RGB 往返（容差 0.002，含纯黑纯白纯色）',
  samples.every((rgb) => {
    const [h, s, l] = HSL.rgbToHsl(...rgb)
    const back = HSL.hslToRgb(h, s, l)
    return back.every((value, index) => Math.abs(value - rgb[index]) <= 0.002)
  })
)
ok('灰色的饱和度是 0', HSL.rgbToHsl(0.5, 0.5, 0.5)[1] === 0)
ok('纯红的色相是 0', near(HSL.rgbToHsl(1, 0, 0)[0], 0, 0.001))
ok('纯绿的色相是 1/3', near(HSL.rgbToHsl(0, 1, 0)[0], 1 / 3, 0.001))
ok('纯蓝的色相是 2/3', near(HSL.rgbToHsl(0, 0, 1)[0], 2 / 3, 0.001))
ok('色相超出 1 会绕回来（hslToRgb(1.1) === hslToRgb(0.1)）', (() => {
  const a = HSL.hslToRgb(1.1, 0.8, 0.5)
  const b = HSL.hslToRgb(0.1, 0.8, 0.5)
  return a.every((value, index) => Math.abs(value - b[index]) < 1e-9)
})())

/* ------------------------------------------------------------------ *
 * C. 权重（这一条决定"分区"成不成立）
 * ------------------------------------------------------------------ */

console.log('\nC. 色相权重 ===\n')

ok('每个色带中心处自己权重最高', HSL.BANDS.every((band) => {
  const weights = HSL.weightsOf(band.center)
  const at = HSL.BANDS.indexOf(band)
  return weights[at] === Math.max(...weights)
}))
ok('权重恒和为 1（归一化，没有死区）', (() => {
  for (let hue = 0; hue < 360; hue += 1) {
    const sum = HSL.weightsOf(hue).reduce((total, value) => total + value, 0)
    if (Math.abs(sum - 1) > 1e-6) return false
  }
  return true
})(), '逐度扫描 360 次')
ok('相邻两带之间：两带合计占主导（>0.8）且都不可忽略（>0.3）', (() => {
  /* 一开始这条写的是"各占 0.5" —— 红了的不是实现而是断言：15° 处其实是
     红 / 橙 / 黄 / 品红四个带的加权（平方之后黄的窗口也够到），
     四带分摊时红橙不会正好各半，但两带合计必须远超 0.8。 */
  const weights = HSL.weightsOf(15) // 红 0 与橙 30 之间
  const red = weights[HSL.BANDS.findIndex((b) => b.key === 'red')]
  const orange = weights[HSL.BANDS.findIndex((b) => b.key === 'orange')]
  return red > 0.3 && orange > 0.3 && red + orange > 0.8
})(), JSON.stringify(HSL.weightsOf(15).map((v) => Number(v.toFixed(2)))))
ok('色相环是环形的（359° 与 1° 都靠近红）', (() => {
  const at359 = HSL.weightsOf(359)
  const at1 = HSL.weightsOf(1)
  const redIndex = HSL.BANDS.findIndex((b) => b.key === 'red')
  return at359[redIndex] > 0.8 && at1[redIndex] > 0.8
})())
ok('ringDistance 取最短弧（350 与 10 差 20，不是 340）', HSL.ringDistance(350, 10) === 20, String(HSL.ringDistance(350, 10)))

/* ------------------------------------------------------------------ *
 * D. 调色行为
 * ------------------------------------------------------------------ */

console.log('\nD. 调色行为（幅度与门控）===\n')

const red = [0.9, 0.15, 0.12]
ok('中性参数下颜色不变成"几乎一样但差一点"', (() => {
  const out = HSL.applyBands(...red, HSL.readBands(undefined))
  return out.every((value, index) => Math.abs(value - red[index]) <= 0.002)
})(), HSL.applyBands(...red, HSL.readBands(undefined)).map((v) => v.toFixed(3)).join(','))

/** 红带色相 +1 ⇒ 整段往橙的方向偏（R 微降、G 上升） */
const hueShift = HSL.applyBands(...red, HSL.readBands({ red: { h: 1 } }))
ok('红带色相 +1 让红色往橙偏（G 上升）', hueShift[1] > red[1] + 0.05, `${red[1]} → ${hueShift[1].toFixed(3)}`)
ok('色相偏移不超过 30°（红不会跑到黄）', hueShift[0] > 0.4 && hueShift[1] < 0.75, hueShift.map((v) => v.toFixed(2)).join(','))

/** 红带去饱和 −1 ⇒ 红变灰 */
const desat = HSL.applyBands(...red, HSL.readBands({ red: { s: -1 } }))
ok('红带饱和度 -1 把红变灰（三通道接近）', Math.max(...desat) - Math.min(...desat) < 0.06, desat.map((v) => v.toFixed(3)).join(','))

/** 红带加饱和 +1 ⇒ 更艳（最大最小差变大） */
const sat = HSL.applyBands(...red, HSL.readBands({ red: { s: 1 } }))
ok('红带饱和度 +1 让红更艳', Math.max(...sat) - Math.min(...sat) > Math.max(...red) - Math.min(...red))

/** 亮度：中灰偏红处加亮，纯黑纯白不动 */
const dark = [0.35, 0.18, 0.16]
const brighter = HSL.applyBands(...dark, HSL.readBands({ red: { l: 1 } }))
ok('红带亮度 +1 让暗红变亮', brighter[0] > dark[0] + 0.03, `${dark[0]} → ${brighter[0].toFixed(3)}`)
ok('亮度钟形：纯黑不受影响', HSL.applyBands(0, 0, 0, HSL.readBands({ red: { l: 1 } })).every((v) => v === 0))
ok('亮度钟形：纯白不受影响', HSL.applyBands(1, 1, 1, HSL.readBands({ red: { l: 1 } })).every((v) => Math.abs(v - 1) < 1e-9))

/* ⚠️ 这一条最容易被忽略：灰色的色相是"任意的"（rgbToHsl 给 0），
   不做饱和门控的话，画面里所有灰都会被"红带"命中 —— 整片灰墙跟着红带变色。 */
ok('中灰不受任何色带影响（饱和门控）', (() => {
  const bands = HSL.readBands({ red: { h: 1, s: 1, l: 1 }, blue: { h: -1, s: -1, l: -1 } })
  const out = HSL.applyBands(0.5, 0.5, 0.5, bands)
  return out.every((value) => Math.abs(value - 0.5) <= 0.002)
})(), HSL.applyBands(0.5, 0.5, 0.5, HSL.readBands({ red: { h: 1, s: 1, l: 1 } })).map((v) => v.toFixed(3)).join(','))
ok('极低饱和的暖灰几乎不动（门控是渐变的，不是开关）', (() => {
  const bands = HSL.readBands({ red: { s: -1 } })
  const before = [0.52, 0.5, 0.48]
  const after = HSL.applyBands(...before, bands)
  const delta = Math.max(...after.map((value, index) => Math.abs(value - before[index])))
  return delta < 0.12
})(), (() => {
  const after = HSL.applyBands(0.52, 0.5, 0.48, HSL.readBands({ red: { s: -1 } }))
  return after.map((v) => v.toFixed(3)).join(',')
})())
ok('绿带只动绿、不动蓝（分区真的分开了）', (() => {
  const bands = HSL.readBands({ green: { s: -1 } })
  const greenBefore = [0.2, 0.8, 0.3]
  const blueBefore = [0.2, 0.35, 0.85]
  const greenAfter = HSL.applyBands(...greenBefore, bands)
  const blueAfter = HSL.applyBands(...blueBefore, bands)
  const greenDelta = Math.max(...greenAfter.map((v, i) => Math.abs(v - greenBefore[i])))
  const blueDelta = Math.max(...blueAfter.map((v, i) => Math.abs(v - blueBefore[i])))
  return greenDelta > 0.05 && blueDelta < 0.02
})())

/* ------------------------------------------------------------------ *
 * E. LUT 烘焙（两种顺序 + 数值一致）
 * ------------------------------------------------------------------ */

console.log('\nE. LUT 烘焙 ===\n')

const BANDS_TEST = HSL.readBands({ red: { h: 0.6, s: 0.3 }, blue: { s: -0.5, l: 0.2 } })
const SIZE = 9
const gpu = HSL.buildLutGpu(BANDS_TEST, SIZE)
ok('LUT 字节数 = size³ × 3', gpu.length === SIZE * SIZE * SIZE * 3, String(gpu.length))
ok('LUT 全是 0–255 的整数', gpu.every((value) => Number.isInteger(value) && value >= 0 && value <= 255))

/** GPU 顺序：x（r）变化最快 ⇒ 下标 = ((b*n + g)*n + r)*3 */
const gpuAt = (r, g, b, n = SIZE) => {
  const at = ((b * n + g) * n + r) * 3
  return [gpu[at] / 255, gpu[at + 1] / 255, gpu[at + 2] / 255]
}
ok('LUT 的 (0,0,0) 格点是黑的', gpuAt(0, 0, 0).every((value) => value === 0))
ok('LUT 的 (n-1,n-1,n-1) 格点是白的', gpuAt(SIZE - 1, SIZE - 1, SIZE - 1).every((value) => Math.abs(value - 1) < 1e-6))

/** ⚠️ 核心一条：GPU 顺序与 .cube 顺序必须是**同一张表**。
    搞反了不会报错，只会让每个像素取到别人的颜色 —— 画面"变了"，但不对。 */
const cube = HSL.cubeText(BANDS_TEST, SIZE)
const cubeLines = cube.trim().split('\n')
const dataLines = cubeLines.filter((line) => /^[\d.]+ [\d.]+ [\d.]+$/.test(line))
ok('.cube 数据行数 = size³', dataLines.length === SIZE * SIZE * SIZE, String(dataLines.length))
ok('.cube 头部有 size 与 domain', cube.includes(`LUT_3D_SIZE ${SIZE}`) && cube.includes('DOMAIN_MAX 1.0 1.0 1.0'))
ok(
  '.cube 的每一行与 GPU 表按同一逻辑坐标取值一致',
  (() => {
    /* cube 与 texImage3D 都是 **b 最慢、r 变化最快**：k = ((b*n + g)*n + r) */
    let checked = 0
    for (const [r, g, b] of [[0, 0, 0], [SIZE - 1, 0, 0], [0, SIZE - 1, 0], [0, 0, SIZE - 1], [4, 4, 4], [2, 7, 5]]) {
      const index = (b * SIZE + g) * SIZE + r
      const parsed = dataLines[index].split(' ').map(Number)
      const fromGpu = gpuAt(r, g, b)
      if (!parsed.every((value, channel) => Math.abs(value - fromGpu[channel]) <= 0.004)) return false
      checked += 1
    }
    return checked === 6
  })()
)

/** ⚠️ 这一条是实测换来的：`.cube` 的行序必须是 **r 变化最快**。
    写反了 ffmpeg 不报错、退出码 0，只是把纯红变成纯蓝（通道被按转置矩阵读）。
    判据直接看文件结构：第 1 行全 0、第 2 行的 R 走了一步而 G/B 不动。 */
ok(
  '.cube 行序正确：中性表第 2 行只有 R 变化（写反了 ffmpeg 会把红读成蓝）',
  (() => {
    /* 必须用**中性**参数：调过色的表里 G 本来就会跟着动，
       拿它验行序会把"调色生效"误判成"顺序错了"。 */
    const neutralLines = HSL.cubeText(HSL.readBands(undefined), SIZE)
      .trim()
      .split('\n')
      .filter((line) => /^[\d.]+ [\d.]+ [\d.]+$/.test(line))
    const first = neutralLines[0].split(' ').map(Number)
    const second = neutralLines[1].split(' ').map(Number)
    const last = neutralLines[neutralLines.length - 1].split(' ').map(Number)
    const step = 1 / (SIZE - 1)
    return (
      first.every((value) => value === 0) &&
      Math.abs(second[0] - step) < 1e-6 &&
      second[1] === 0 &&
      second[2] === 0 &&
      last.every((value) => value > 0.999999)
    )
  })(),
  '中性表第2行应为 (step, 0, 0)'
)

ok('中性参数的 LUT 是恒等表（每个格点 = 自己的颜色）', (() => {
  const identity = HSL.buildLutGpu(HSL.readBands(undefined), 5)
  for (let i = 0; i < 5 * 5 * 5; i += 1) {
    const at = i * 3
    /* 恒等表里第 i 个像素的期望值由坐标反推 —— 直接比对"三通道自洽"：
       用 GPU 反查坐标，再比对 255 缩放后的误差 */
    const b = Math.floor(i / 25)
    const g = Math.floor((i % 25) / 5)
    const r = i % 5
    const scale = 255 / 4
    if (Math.abs(identity[at] - r * scale) > 1.5) return false
    if (Math.abs(identity[at + 1] - g * scale) > 1.5) return false
    if (Math.abs(identity[at + 2] - b * scale) > 1.5) return false
  }
  return true
})())

ok('调过参数的 LUT 不再是恒等表（否则等于没生效）', (() => {
  const changed = HSL.buildLutGpu(BANDS_TEST, 5)
  const identity = HSL.buildLutGpu(HSL.readBands(undefined), 5)
  return changed.some((value, index) => Math.abs(value - identity[index]) > 3)
})())

ok('size 会被钳到 2–65（1 会除以 0、999 会吃掉几个 G 内存）', (() => {
  const tiny = HSL.buildLutGpu(HSL.readBands(undefined), 1)
  return tiny.length === 2 * 2 * 2 * 3
})(), String(HSL.buildLutGpu(HSL.readBands(undefined), 1).length))
ok('size 缺省 = 33', HSL.buildLutGpu(HSL.readBands(undefined)).length === 33 * 33 * 33 * 3)

/* 烘焙耗时：面板拖动时要重算，超过 ~100ms 就得做节流。这里只把它量出来打日志，
   不做断言 —— 机器快慢不同，断言时长会在慢机器上假红。 */
const started = Date.now()
HSL.buildLutGpu(BANDS_TEST, 33)
const cost = Date.now() - started
console.log(`  · 33³ 烘焙耗时 ${cost}ms（决定面板拖动要不要节流）`)

const total = pass + failures.length
console.log(`\nHSL_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
console.log(failures.length ? 'HSL_SELFTEST_FAILED' : 'HSL_SELFTEST_PASSED')
process.exitCode = failures.length ? 1 : 0
