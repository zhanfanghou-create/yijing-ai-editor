/**
 * 导出规格真源（帧率档 / 分辨率档）。主进程 `require`、渲染层 `import`，同一份。
 *
 * ── 为什么要有这个模块 ─────────────────────────────────────────────
 * 以前帧率是一个 `min=24 max=60 step=6` 的**滑杆**，能落到的值只有
 * 24 / 30 / 36 / 42 / 48 / 54 / 60。三个问题一次全踩：
 *
 *   ① **25 与 50 选不出来**。PAL 地区、国内电视台与大量商用素材就是 25/50，
 *      滑杆上根本没有这两个位置 —— 用户只能导 30fps，交付时要重新转一遍（掉帧）。
 *   ② **29.97 / 59.94 选不出来**。NTSC 与网络平台母版规格，同样是滑杆落不到的点。
 *   ③ 反过来，36 / 42 / 48 **是不存在的交付规格**：既不是影视也不是广播，
 *      选它只会得到一个所有设备都要再转一次的文件。
 *
 * 帧率应该是**档位**，不是连续量。这里就按参考客户端的七档给全。
 *
 * ── 为什么 NTSC 三档要写成整数比 ─────────────────────────────────
 * 29.97 的真实值是 30000/1001 = 29.97002997…，它不是"29.97"。
 * ffmpeg 收到 `fps=29.97` 会解析成 2997/100 而不是 30000/1001。
 * 两者每小时只差约 0.1 帧 —— 这点差**看不出来**，所以更不能靠"看一遍没问题"来验证；
 * 真正麻烦的是容器里写下的 `avg_frame_rate` 变成了 2997/100 这个非标准值：
 * 广播 QC 工具与 NLE 二次导入会把它当成"帧率不规范"，要求重转。
 * 所以对外显示 29.97，交给 ffmpeg 的一律是 `30000/1001`（并且闸门按 ffprobe 读回来的
 * avg_frame_rate 判定，而不是看参数拼得对不对）。
 */

/** NTSC 三档：显示值 → ffmpeg 的整数比。键是显示值，值是真正送给 ffmpeg 的 */
const NTSC_RATES = {
  29.97: '30000/1001',
  59.94: '60000/1001',
  23.976: '24000/1001'
}

/** 七档帧率。id 就是显示值（29.97 而不是 30000/1001），方便 UI 直接当 value 用 */
const RATES = [
  { id: '24', fps: 24 },
  { id: '25', fps: 25 },
  { id: '29.97', fps: 29.97 },
  { id: '30', fps: 30 },
  { id: '50', fps: 50 },
  { id: '59.94', fps: 59.94 },
  { id: '60', fps: 60 }
]

/** 允许的帧率范围（防止手写 json 传入 0 / 负数 / 9999 把 ffmpeg 拖死） */
const FPS_MIN = 1
const FPS_MAX = 120

/**
 * 五档分辨率。上限钉在 **4K**（本产品的支持口径）。
 *
 * ⚠️ 参考客户端还有 8K 一档，这里故意不给：8K 的单帧 RGBA 是 132MB，
 *    一次导出要同时挂着几路帧缓冲与遮罩 PNG —— 本机实测一张 8K 静帧能导出来，
 *    但对真实素材是"选了就开始等，等到最后可能还给 OOM 干掉"。
 *    给一个「按下去多半失败、失败还得等十分钟才知道」的档位，比没有这一档更糟。
 *
 * ⚠️ 已经存过 8K 的草稿/接口调用不许静默掉到 1080P（那是连降两档、用户毫无察觉）：
 *    `LEGACY_RESOLUTIONS` 把 8k 映射到 4k，同档位的旧值仍然落在"最高档"。
 */
const RESOLUTIONS = [
  { id: '480p', width: 854, height: 480 },
  { id: '720p', width: 1280, height: 720 },
  { id: '1080p', width: 1920, height: 1080 },
  { id: '2k', width: 2560, height: 1440 },
  { id: '4k', width: 3840, height: 2160 }
]

/** 已下架的档位 → 现在落在哪一档（旧草稿、旧 MCP 请求、旧分享包都会带这些值） */
const LEGACY_RESOLUTIONS = { '8k': '4k' }

/**
 * 支持的最高像素档：**短边 2160**（4K 的短边）。
 *
 * 为什么按短边而不是"3840×2160 的像素总数"：
 *   · 按总像素卡，4K + 2:1 会被算成 4320×2160（9.33M > 8.29M）而被压回 3840×1920，
 *     用户明明选了 4K、成片短边却只有 1920；
 *   · 按短边卡，"4K"在竖屏就是 2160×3840、在 2:1 就是 4320×2160，短边恒定 2160，
 *     与 `outputSizeFor` 的短边守恒是同一套口径。
 */
const MAX_SHORT_SIDE = 2160

const DEFAULT_RATE = '30'
const DEFAULT_RESOLUTION = '1080p'

/**
 * 帧率 → 交给 ffmpeg 的字符串。
 *
 * @param {number|string} fps
 * @returns {string} 整数帧率返回 '30'；NTSC 返回 '30000/1001'；非法值退回默认档
 */
function rateArg(fps) {
  const n = Number(fps)
  if (!Number.isFinite(n) || n < FPS_MIN || n > FPS_MAX) return DEFAULT_RATE
  /* 容差 0.01：29.97 的真实值 29.97002997 与 29.97 只差 3e-5，直接比相等会漏 */
  for (const [shown, rational] of Object.entries(NTSC_RATES)) {
    if (Math.abs(n - Number(shown)) < 0.01) return rational
  }
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

/**
 * 规范化一个"可能是任何东西"的帧率输入：id（'29.97'）、数字（29.97）、
 * 或者旧草稿里存的 30。非法的退回默认 30，不抛。
 *
 * @returns {{ id: string, fps: number, arg: string }}
 */
function readRate(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  /* 先按 id 精确匹配（'30' 与 '29.97' 都在表里），匹配不到再按数值近似 */
  const byId = RATES.find((item) => item.id === raw)
  if (byId) return { id: byId.id, fps: byId.fps, arg: rateArg(byId.fps) }
  const n = Number(raw)
  if (Number.isFinite(n) && n >= FPS_MIN && n <= FPS_MAX) {
    const near = RATES.find((item) => Math.abs(item.fps - n) < 0.01)
    if (near) return { id: near.id, fps: near.fps, arg: rateArg(near.fps) }
    /* 表外的合法值（比如 48）照样认，但 id 用它自己的值 —— 画面上要能看出不是标准档 */
    return { id: String(n), fps: n, arg: rateArg(n) }
  }
  const fallback = RATES.find((item) => item.id === DEFAULT_RATE)
  return { id: fallback.id, fps: fallback.fps, arg: rateArg(fallback.fps) }
}

/**
 * 分辨率 id → { id, width, height }。未知 id 退回 1080P（不许把 undefined 传给渲染）。
 * ⚠️ 这里的宽高是**基准画布**（16:9 那一档），实际输出尺寸还要按画面比例展开
 *    （见 shared/aspect.js 的 outputSizeFor）：选 16:9 时 1080P 是 1920×1080，
 *    选 9:16 时是 1080×1920（短边守恒）。
 */
function readResolution(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  const id = LEGACY_RESOLUTIONS[raw] || raw
  const hit = RESOLUTIONS.find((item) => item.id === id)
  const picked = hit || RESOLUTIONS.find((item) => item.id === DEFAULT_RESOLUTION)
  return { id: picked.id, width: picked.width, height: picked.height }
}

/**
 * 把任意宽高夹到"最高 4K"（短边 ≤ 2160），保持宽高比。
 *
 * 为什么需要它：分辨率档位不是唯一的入口 —— MCP 工具可以直接传 `width/height`，
 * 旧草稿里也可能存着当年 8K 档算出来的尺寸。没有这一道，"最高 4K"就只是
 * 下拉框里的一句承诺：绕开下拉就能把渲染拖进 OOM。
 *
 * @param {number} width
 * @param {number} height
 * @returns {{width:number, height:number, clamped:boolean}}
 */
function clampSize(width, height) {
  const w = Math.max(2, Math.round(Number(width) || 0))
  const h = Math.max(2, Math.round(Number(height) || 0))
  const shortSide = Math.min(w, h)
  /* 向下取偶数：宁小 1px 也不让 ffmpeg 在 yuv420p 那一步挂掉 */
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2)
  if (shortSide <= MAX_SHORT_SIDE) return { width: even(w), height: even(h), clamped: false }
  const k = MAX_SHORT_SIDE / shortSide
  return { width: even(w * k), height: even(h * k), clamped: true }
}

module.exports = {
  RATES,
  RESOLUTIONS,
  LEGACY_RESOLUTIONS,
  MAX_SHORT_SIDE,
  FPS_MIN,
  FPS_MAX,
  DEFAULT_RATE,
  DEFAULT_RESOLUTION,
  rateArg,
  readRate,
  readResolution,
  clampSize
}
