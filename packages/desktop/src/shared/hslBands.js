'use strict'
/**
 * 分区 HSL（八个色相带，各自调 色相 / 饱和度 / 亮度）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这个功能只能用 3D LUT 做
 * ══════════════════════════════════════════════════════════════════
 * 「分区」的数学核心是 `权重 = f(像素自己的色相)`。这条式子**无法**用现有的
 * SVG 滤镜链表达 —— `feColorMatrix` 是线性的、`feComponentTransfer` 是逐通道一维的，
 * 两者都算不出"这个像素属于哪个色相带、占几成"。同理 ffmpeg 的 `curves` /
 * `lutrgb` 也表达不了（它们也是一维的），`huesaturation` 只能同时改一个色族。
 *
 * 所以这一族**只有一条路**：把整套映射烘焙成一张 **3D LUT**。
 *   · 预览：LUT 上传成 WebGL 的 3D 纹理，片元着色器里一次三线性采样；
 *   · 导出：同一份 LUT 写成 `.cube`，交给 ffmpeg 的 `lut3d`。
 *
 * ⚠️ 两侧必须用**同一种插值**：ffmpeg 的 `lut3d` 默认是 `tetrahedral`，
 *    GPU 是 `trilinear`。两者对平滑函数只差 1 个色阶，但"只差一点"正是本项目
 *    最忌的那种 —— 预览看着对、成片单帧比对差一点点，没人说得清是哪边错。
 *    所以导出侧固定写 `interp=trilinear`（见 main/render.js），与 GPU 逐字一致。
 *
 * ⚠️ 权重公式只需要在 JS 里实现**一次**（烘焙时用）。预览只采样、导出只写文件，
 *    所以"两边各写一份数学"的风险在这里天然不存在 —— 这是选 3D LUT 最大的好处。
 */

/**
 * 八个色相带的中心（度）。
 *
 * 为什么是这八个：这是行业里"色相条"的通用切法（红橙黄绿青蓝紫品红），
 * 也是用户拿取色器去量一片叶子时会说的那个词。等距 45° 分八份更好算，
 * 但"橙黄之间那一带"就没有名字了，界面上只能写"色带 3"，没人知道该拖哪个。
 */
const BANDS = [
  { key: 'red', label: '红', center: 0, hex: '#e5484d' },
  { key: 'orange', label: '橙', center: 30, hex: '#f76b15' },
  { key: 'yellow', label: '黄', center: 60, hex: '#ffd400' },
  { key: 'green', label: '绿', center: 120, hex: '#30a46c' },
  { key: 'cyan', label: '青', center: 180, hex: '#00b8d9' },
  { key: 'blue', label: '蓝', center: 240, hex: '#3e63dd' },
  { key: 'purple', label: '紫', center: 285, hex: '#8e4ec6' },
  { key: 'magenta', label: '品红', center: 320, hex: '#d6409f' }
]

const BAND_BY_KEY = new Map(BANDS.map((band) => [band.key, band]))

/**
 * 每个色带的窗口半径 = 到**较远那个邻带中心**的整段距离。
 *
 * ⚠️ 这里踩过一次：最初取"到较远邻带的**一半**"，结果相邻两带在自己边界上
 *    权重同时为 0（红在 15° 处 0、橙在 15° 处也是 0），归一化时整段归零 ——
 *    表现是"色相条上 15° 那一条窄带里，八个带怎么拖画面都不动"。
 *    取**整段**距离后，边界处两侧各剩 0.5 左右，归一化后正好一人一半，
 *    任意色相都能被至少两个带覆盖到（自测里逐度扫 360 次验证和为 1）。
 *
 * 无论取多少，**后面都必须归一化** —— 色带间隔不均匀（绿→青 60°、紫→品红 35°），
 * 不归一化就会出现"黄绿之间调得动、紫红之间调不动"这种说不清的差异。
 */
const HALF_WIDTH = new Map(
  BANDS.map((band, index) => {
    const prev = BANDS[(index - 1 + BANDS.length) % BANDS.length]
    const next = BANDS[(index + 1) % BANDS.length]
    const toPrev = ringDistance(band.center, prev.center)
    const toNext = ringDistance(band.center, next.center)
    return [band.key, Math.max(toPrev, toNext)]
  })
)

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value)
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)

/** 色相环上的最短角距（度，0–180） */
function ringDistance(a, b) {
  const diff = Math.abs(((a % 360) + 360) % 360 - ((b % 360) + 360) % 360)
  return diff > 180 ? 360 - diff : diff
}

/** 0–1 平滑过渡：低于 lo 为 0、高于 hi 为 1。用来做"低饱和像素不受影响"的门控 */
function smoothstep(lo, hi, value) {
  if (hi <= lo) return value >= hi ? 1 : 0
  const t = clamp01((value - lo) / (hi - lo))
  return t * t * (3 - 2 * t)
}

/* ------------------------------------------------------------------ *
 * 参数读写
 * ------------------------------------------------------------------ */

/** 默认值：全 0（中性）。`h` / `s` / `l` 都在 [-1, 1] */
function neutralBand() {
  return { h: 0, s: 0, l: 0 }
}

/**
 * 规范化一份参数。缺键 / 脏值 / 越界 / 老草稿里存的数组全部收进来。
 *
 * ⚠️ 钳位必须在 `num()` 之后做：`clamp(Number(undefined), -1, 1)` 会返回**下界**
 *    （NaN 比较恒假，落进 else 分支），于是"没设过"会变成"拉到底"——
 *    色轮那一次就是这么炸的（见 shared/wheels.js 的注释）。这里先兜 0 再钳。
 */
function readBands(raw) {
  const out = {}
  for (const band of BANDS) {
    const source = raw && raw[band.key] ? raw[band.key] : {}
    out[band.key] = {
      h: Math.max(-1, Math.min(1, num(source.h))),
      s: Math.max(-1, Math.min(1, num(source.s))),
      l: Math.max(-1, Math.min(1, num(source.l)))
    }
  }
  return out
}

/** 是否中性（全部为 0）。中性时**整条链路都不启用** —— 不烘 LUT、不改导出滤镜 */
function isNeutral(bands) {
  const read = readBands(bands)
  return BANDS.every((band) => {
    const item = read[band.key]
    return Math.abs(item.h) < 1e-6 && Math.abs(item.s) < 1e-6 && Math.abs(item.l) < 1e-6
  })
}

/** 单一色带是否被调过（面板用来给色带圆点打"已调"标记） */
function bandActive(bands, key) {
  const read = readBands(bands)
  const item = read[key]
  if (!item) return false
  return Math.abs(item.h) > 1e-6 || Math.abs(item.s) > 1e-6 || Math.abs(item.l) > 1e-6
}

/* ------------------------------------------------------------------ *
 * 色彩空间
 * ------------------------------------------------------------------ */

/** RGB（0–1）→ HSL（h 0–1，s 0–1，l 0–1）。屏幕取色用的是 sRGB，不做线性化 */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

/** HSL → RGB（0–1） */
function hslToRgb(h, s, l) {
  const hue = ((h % 1) + 1) % 1
  if (s <= 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)]
}

/**
 * 某个色相在八个带上的权重（归一化，和为 1）。
 *
 * 三步，每一步都是被具体的错法逼出来的：
 *   ① 三角窗：`w = max(0, 1 - d / half)`，连续、无台阶；
 *   ② **平方再加权归一化**（`w² / Σw²`）。只做一次归一化时，纯红（色相 2°）的
 *      权重只有 0.89 —— 邻带分走了 11%。用户把"红"的饱和度拉到 -1，红色只会
 *      褪掉 89%，剩一点点粉：界面上滑杆到底了、颜色还没干净，用户会以为滑杆坏了。
 *      平方之后纯红的权重是 0.99，边界处仍然是两侧对称的 0.5/0.5（平方不破坏对称）；
 *   ③ 归一化本身保证**没有死区**：色带间隔不均匀（绿→青 60°、紫→品红 35°），
 *      不归一化就会出现"黄绿之间调得动、紫红之间调不动"这种说不清的差异。
 */
function weightsOf(hueDegrees) {
  const raw = BANDS.map((band) => {
    const half = HALF_WIDTH.get(band.key) || 30
    const d = ringDistance(hueDegrees, band.center)
    return Math.max(0, 1 - d / half)
  })
  const sharp = raw.map((value) => value * value)
  const sum = sharp.reduce((total, value) => total + value, 0)
  if (sum <= 1e-9) return raw.map(() => 0)
  return sharp.map((value) => value / sum)
}

/**
 * 单点调色。`rgb` 三项都是 0–1，返回新的 0–1 三元组。
 *
 * 三条幅度约定（写死在函数里，不开放给用户）：
 *   · 色相 `h` 满量程 = ±30°：超过 30° 会让"红色"直接跑到"黄色"，
 *     用户会以为拖的是另一个色带；
 *   · 饱和度 `s` 是**乘性**的（`s × (1 + ds)`）：-1 完全去色、+1 双倍饱和。
 *     加性会让本来就很淡的颜色一拖就过曝；
 *   · 亮度 `l` 乘一个 `1 - |2l - 1|` 的钟形：纯黑和纯白处不动。
 *     不加这个的话，把"绿色亮度 +1"会让画面里的暗部绿色变成灰雾。
 */
function applyBands(r, g, b, bands) {
  const [h0, s0, l0] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b))
  /* 低饱和像素（灰、白、黑）的色相是"任意的"，不门控就会被红带误伤 ——
     整块灰墙跟着"红带宽 +1"一起变色，是最典型的"这功能不太对"的观感。 */
  const gate = smoothstep(0.02, 0.12, s0)
  if (gate <= 0) return [r, g, b]
  const weights = weightsOf(h0 * 360)
  let dh = 0
  let ds = 0
  let dl = 0
  for (let i = 0; i < BANDS.length; i += 1) {
    const item = bands[BANDS[i].key]
    const k = weights[i] * gate
    if (k === 0) continue
    dh += k * item.h
    ds += k * item.s
    dl += k * item.l
  }
  const h = h0 + (dh * 30) / 360
  const s = clamp01(s0 * (1 + ds))
  const l = clamp01(l0 + dl * 0.35 * (1 - Math.abs(2 * l0 - 1)))
  return hslToRgb(h, s, l)
}

/* ------------------------------------------------------------------ *
 * LUT 烘焙
 * ------------------------------------------------------------------ */

/**
 * 烘焙一张 `size³` 的 LUT，返回 **GPU 顺序**的字节数组（RGB，每通道 0–255）。
 *
 * ⚠️ 两个顺序千万别搞反：
 *   · WebGL 的 `texImage3D` 要求 **x（也就是 r）变化最快**；
 *   · `.cube` 文件规范要求 **b 变化最快、r 最慢**（`for r { for g { for b } }`）。
 *   反过来写不会报错，只会把颜色通道接错 —— 画面变成了"另一套配色"，
 *   看起来像调色成功，实际每个像素都取了别人的值。所以这里分成两个函数，
 *   并用 `assertSameLut()` 在自测里逐个格点比对。
 */
function buildLutGpu(bands, size = 33) {
  const n = Math.max(2, Math.min(65, Math.round(Number(size) || 33)))
  const read = readBands(bands)
  const out = new Uint8Array(n * n * n * 3)
  let at = 0
  const step = 1 / (n - 1)
  for (let bi = 0; bi < n; bi += 1) {
    for (let gi = 0; gi < n; gi += 1) {
      for (let ri = 0; ri < n; ri += 1) {
        const [rr, gg, bb] = applyBands(ri * step, gi * step, bi * step, read)
        out[at] = Math.round(rr * 255)
        out[at + 1] = Math.round(gg * 255)
        out[at + 2] = Math.round(bb * 255)
        at += 3
      }
    }
  }
  return out
}

/**
 * 生成 `.cube` 文本（ffmpeg `lut3d` 吃这个格式）。
 *
 * ⚠️ **顺序：b 最慢、r 变化最快**（`for b { for g { for r } }`）。
 *    这和 WebGL `texImage3D` 的要求**完全一样**，所以两种输出共用同一个循环。
 *    这一条是实测出来的，不是推的：最初按"cube 先列 r"写成 r 最慢，
 *    ffmpeg 不报错、退出码 0，只是把纯红 (253,0,0) 变成了纯蓝 (0,0,253) ——
 *    通道被当成转置矩阵读了一遍。画面"变了"，但完全是另一回事。
 *    自测里有一条专门打这个：第 2 行必须是"R 走一步、G/B 不动"。
 *
 * 数值用 6 位小数：3 位会让 33³ 的格点之间出现台阶（相邻格点差 0.002 就被吞掉）。
 */
function cubeText(bands, size = 33) {
  const n = Math.max(2, Math.min(65, Math.round(Number(size) || 33)))
  const read = readBands(bands)
  const lines = [`TITLE "yjai-hsl"`, `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', '']
  const step = 1 / (n - 1)
  for (let bi = 0; bi < n; bi += 1) {
    for (let gi = 0; gi < n; gi += 1) {
      for (let ri = 0; ri < n; ri += 1) {
        const [rr, gg, bb] = applyBands(ri * step, gi * step, bi * step, read)
        lines.push(`${rr.toFixed(6)} ${gg.toFixed(6)} ${bb.toFixed(6)}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

/** LUT 边长。33 是行业默认：`applyBands` 连续，33³ 的插值误差肉眼不可见 */
const LUT_SIZE = 33

module.exports = {
  BANDS,
  BAND_BY_KEY,
  HALF_WIDTH,
  LUT_SIZE,
  ringDistance,
  smoothstep,
  rgbToHsl,
  hslToRgb,
  weightsOf,
  applyBands,
  readBands,
  neutralBand,
  isNeutral,
  bandActive,
  buildLutGpu,
  cubeText
}
