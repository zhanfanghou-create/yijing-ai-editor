'use strict'
/**
 * 音频的真源：**音量包络**（预览与导出必须同一份）+ **导出阶段的母带处理预设**。
 *
 * 两类东西放一个文件，但性质完全不同，注释里分得很清楚：
 *
 *   ① 音量包络（volumeKf）—— **预览与导出逐点同源**。
 *      预览每帧把插值结果乘到 `<video>.volume` 上，导出把它写成 ffmpeg 的
 *      `volume='<表达式>'`。两边的插值函数都是本文件的 `volumeAt` / `volumeExpr`，
 *      所以"时间线上一段声音渐弱"在预览里听得到、在成片里也听得到。
 *
 *   ② 母带 / 修复类（响度统一、降噪、防抖）—— 只在**导出**生效。
 *      它们不是"调一个参数、画面/声音当场变"的东西（响度统一要看整段统计），
 *      强行在预览里做只会得到一个不准的近似。所以界面上这几项都带
 *      「导出时应用」标记，不假装预览里已经生效 —— 这是本项目的硬约定。
 */

/** 音量包络的采样点上限：再多就不是"手调"了，而是在画一条曲线 */
const VOLUME_KF_MAX = 64

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const round4 = (value) => Number(Number(value).toFixed(4))

/**
 * 读音量包络：`[{t, v}]`（t = 片段内秒数，v = 音量百分比 0–200）。
 * 非法点一律丢弃；按 t 升序去重（同 t 保留后写的那一个）。
 */
function readVolumeKf(src) {
  if (!Array.isArray(src)) return []
  const out = []
  for (const point of src) {
    if (!point || typeof point !== 'object') continue
    const t = num(point.t, NaN)
    const v = num(point.v, NaN)
    if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0) continue
    out.push({ t: round4(t), v: round4(clamp(v, 0, 200)) })
  }
  out.sort((a, b) => a.t - b.t)
  const dedup = []
  for (const point of out) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1].t - point.t) < 1e-4) dedup[dedup.length - 1] = point
    else dedup.push(point)
  }
  return dedup.slice(0, VOLUME_KF_MAX)
}

const hasVolumeKf = (points) => Array.isArray(points) && points.length > 0

/**
 * 片段内 `t` 秒处的音量百分比（线性插值、两端夹取）。
 * 没有包络时返回 base（片段上那个音量滑杆的值）。
 */
function volumeAt(points, t, base = 100) {
  const list = Array.isArray(points) ? points : []
  if (!list.length) return num(base, 100)
  const time = Math.max(0, num(t))
  if (time <= list[0].t) return list[0].v
  const last = list[list.length - 1]
  if (time >= last.t) return last.v
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]
    const b = list[i]
    if (time <= b.t) {
      const span = b.t - a.t
      if (span <= 1e-6) return b.v
      const p = (time - a.t) / span
      return round4(a.v + (b.v - a.v) * p)
    }
  }
  return last.v
}

/**
 * 音量包络 → ffmpeg `volume` 的表达式（**不含** `volume=` 前缀）。
 *
 * ⚠️ 表达式里的 `t` 是**滤镜链当前时间**，而调用处已经 `asetpts=PTS-STARTPTS`
 *    把片段起点归零，所以包络的时间轴（片段内秒数）与它天然对齐。
 *    少了那次重置，2 秒处放置的片段会把包络整体推迟 2 秒生效。
 * ⚠️ 数值一律用 `0.5000` 这种定点写法：`0.30000000000000004` 会让对拍断言变脆，
 *    而 ffmpeg 的表达式求值器对超长浮点串也更慢。
 *
 * @returns {string} 形如 `if(lte(t,0),1.2000,...)`；无包络时返回 ''
 */
function volumeExpr(points) {
  const list = Array.isArray(points) ? points : []
  if (!list.length) return ''
  const v = (value) => round4(num(value) / 100)
  if (list.length === 1) return v(list[0].v).toFixed(4)
  let expr = v(list[list.length - 1].v).toFixed(4)
  for (let i = list.length - 2; i >= 0; i -= 1) {
    const a = list[i]
    const b = list[i + 1]
    const span = Number((b.t - a.t).toFixed(4))
    const va = v(a.v)
    const vb = v(b.v)
    if (span <= 1e-4) {
      expr = `if(lte(t,${a.t.toFixed(4)}),${va.toFixed(4)},${expr})`
      continue
    }
    const slope = round4((vb - va) / span)
    expr =
      `if(lte(t,${a.t.toFixed(4)}),${va.toFixed(4)},` +
      `if(lte(t,${b.t.toFixed(4)}),${va.toFixed(4)}+${slope.toFixed(4)}*(t-${a.t.toFixed(4)}),${expr}))`
  }
  return expr
}

/**
 * 片段级淡入 / 淡出的**增益倍率**（0–1）。
 *
 * 这是"预览与导出同源"的第二种东西（第一种是上面的音量包络）：
 *   · 导出侧 `render.js` 的 `fadePartFor()` 把它写成 `afade=t=in:st=0:d=<fin>`
 *     与 `afade=t=out:st=<dur-fout>:d=<fout>`；
 *   · 预览侧 `composite.js` 直接把它乘进 `gain`，每帧落成 `<video>.volume`。
 * `afade` 的默认曲线 `tri` 就是**线性**，所以这里的斜坡必须是直的，不能做成
 * 余弦 / 指数 —— 那样两边听感会不一样（而两者的差别只有耳朵能分辨，闸门比不出来）。
 *
 * ⚠️ 以前这个字段**只有导出认**：面板上拖「淡入时长」、时间线上脏点亮、成片里真有淡入，
 *    预览却一点变化都没有，而且界面上没写「仅导出」——属于最坏的一类静默失效。
 *
 * @param {object} clip  片段（读 `fadeIn` / `fadeOut`，单位秒）
 * @param {number} local 片段内秒数（= 播放头 − clip.start）
 * @param {number} dur   片段时长（秒）—— 淡出的起点是 `dur - fadeOut`
 * @returns {number} 0–1 的倍率（无淡入淡出时恒为 1）
 */
function fadeGainAt(clip, local, dur) {
  const total = Math.max(0, num(dur, 0))
  const fin = clamp(num(clip?.fadeIn, 0), 0, total)
  const fout = clamp(num(clip?.fadeOut, 0), 0, total)
  const t = Math.max(0, num(local, 0))
  let gain = 1
  if (fin > 0.01) gain = Math.min(gain, clamp(t / fin, 0, 1))
  if (fout > 0.01) gain = Math.min(gain, clamp((total - t) / fout, 0, 1))
  return round4(gain)
}

/**
 * 响度统一（导出阶段）。
 *
 * 数值是行业里那几套常用目标：
 *   · 网络 / 短视频 —— -14 LUFS（与国际流媒体平台的响度目标同一量级）
 *   · 影视广播   —— -23 LUFS（EBU R128）
 *   · 播客       —— -16 LUFS
 *
 * ⚠️ 它作用在**混完的整条音轨**上（amix 之后），不是逐片段：
 *    逐片段各自拉到同一个响度，混起来反而更乱。
 */
const LOUDNESS_MODES = [
  { key: 'off', label: '不处理' },
  { key: 'web', label: '网络 -14 LUFS', I: -14 },
  { key: 'tv', label: '广播 -23 LUFS', I: -23 },
  { key: 'podcast', label: '播客 -16 LUFS', I: -16 }
]

function loudnormFor(modeKey, round = round4) {
  const item = LOUDNESS_MODES.find((entry) => entry.key === modeKey)
  if (!item || !Number.isFinite(item.I)) return ''
  return `loudnorm=I=${round(item.I, 1)}:TP=-1.5:LRA=11`
}

/**
 * 音频降噪（导出阶段）→ `afftdn`。
 * `afftdn` 是频域降噪：对底噪（空调声 / 电流声）有效，对人声本身也会轻微打磨，
 * 所以默认档位给得保守（nr=12dB），强度可调。
 */
function audioDenoiseFilter(level, round = round4) {
  const strength = clamp(num(level, 0), 0, 100)
  if (strength < 1) return ''
  const nr = round(6 + (strength / 100) * 18, 1)
  return `afftdn=nr=${nr}:nf=-25`
}

/**
 * 视频降噪（导出阶段）→ `hqdn3d`。
 * 空间项（luma/chroma spatial）把噪点抹掉，时间项（tmp）压住闪烁。
 * 强度 0–100 映射到 0–3 的空间半径：再大画面会像糊了一层。
 */
function videoDenoiseFilter(level, round = round4) {
  const strength = clamp(num(level, 0), 0, 100)
  if (strength < 1) return ''
  const spatial = round((strength / 100) * 3, 2)
  const tmp = round((strength / 100) * 2, 2)
  return `hqdn3d=${spatial}:${spatial}:${tmp}:${tmp}`
}

/**
 * 视频防抖（导出阶段）→ `deshake`。
 *
 * 为什么用 `deshake` 而不是 `vidstab`：`vidstab` 需要两遍处理（先 detect 写
 * transforms 文件、再 transform），而我们的命令构造是**一次成型**的同步函数。
 * 为了它单独加一遍预处理，导出耗时翻倍、还要管临时文件的生命周期。
 * `deshake` 是单遍的，对"手持轻微抖动"这个主场景效果足够，代价是边缘会有裁切
 * —— 用 `edge=mirror` 把露出来的边补上，避免一圈黑边。
 */
function stabilizeFilter(level, round = round4) {
  const strength = clamp(num(level, 0), 0, 100)
  if (strength < 1) return ''
  const range = Math.round(8 + (strength / 100) * 56)
  const contrast = Math.round(80 + (strength / 100) * 80)
  return `deshake=rx=${range}:ry=${range}:edge=mirror:blocksize=8:contrast=${contrast}`
}

/**
 * 立体声平衡（pan）→ `pan=stereo|c0=gl*c0|c1=gr*c1`。
 *
 * 语义选的是**平衡（balance）**而不是**声像（panning）**：左右两条声道各乘一个
 * 独立增益，不把两声道混成单声道再摆位。理由是配音/配乐本来就是立体声，
 * 混成单声道再摆位会把立体声场压扁（听感是"变窄"），而用户拖这个滑杆
 * 想达到的是"这一轨整体偏左一点"。
 *
 * 增益用**线性**（不是等功率）：中心必须恰好是 1/1，否则"没动过"的片段
 * 也会被削 3 dB —— 那是经典误用，症状是"加了功能以后所有片子都变小声"。
 *
 * ⚠️ 预览侧从 **`panGains()`** 取同一对数（见 `shared/audioGraph.js`）：
 *    预览走 WebAudio 的「左右各乘一个增益」，导出走 `pan=c0=left*c0|c1=right*c1`，
 *    两边的系数**来自同一个函数**，不是各写一遍。
 */
function panGains(pan) {
  const value = Number(pan)
  if (!Number.isFinite(value)) return null
  const p = clamp(value, -100, 100) / 100
  if (Math.abs(p) < 0.005) return null
  return { left: round4(Math.min(1, 1 - p)), right: round4(Math.min(1, 1 + p)) }
}

function panFilter(pan, round = round4) {
  const gains = panGains(pan)
  if (!gains) return ''
  return `pan=stereo|c0=${round(gains.left, 3)}*c0|c1=${round(gains.right, 3)}*c1`
}

/**
 * 人声增强（导出阶段）→ 高通 + 中频提亮 + 压缩器。
 *
 * 和「降噪」是两件事，顺序不能反：降噪先削掉底噪（否则压缩器会把底噪一起抬起来），
 * 增强再动音色。三段的分工：
 *   · `highpass` 去 85Hz 以下的隆隆声（桌面震动、空调低频、手持摩擦）；
 *   · `equalizer` 在 280Hz 压一点（"闷"的来源）、2.8kHz 提一点（辅音的清晰度所在）；
 *   · `acompressor` 把忽大忽小压到同一个水平，`makeup` 补回被压掉的响度。
 *
 * ⚠️ 这五段在**预览里也生效**（WebAudio 有等价节点：BiquadFilter ×4 + DynamicsCompressor），
 *    数值从本函数产出的 `voiceEnhanceParams()` 取，两侧同一份（见 shared/audioGraph.js）。
 */
function voiceEnhanceParams(level, round = round4) {
  const strength = clamp(num(level, 0), 0, 100)
  if (strength < 1) return null
  const k = strength / 100
  return {
    hp: 85,
    lp: 12000,
    cutFreq: 280,
    /* 带宽单位是**倍频程**（ffmpeg 的 width_type=o）。WebAudio 的 peaking 没有倍频程，
       预览侧按 `Q = √(2^N) / (2^N − 1)` 换算（见 shared/audioGraph.js 的 octaveToQ）。 */
    cutWidth: 1.6,
    cutGain: round(-0.5 - k * 2.5, 1),
    midFreq: 2800,
    midWidth: 1.2,
    midGain: round(1.5 + k * 3.5, 1),
    threshold: round(-12 - k * 10, 0),
    ratio: round(1.5 + k * 2.5, 1),
    attack: 0.006,
    release: 0.16,
    makeup: 2
  }
}

function voiceEnhanceFilter(level, round = round4) {
  const p = voiceEnhanceParams(level, round)
  if (!p) return ''
  return (
    `highpass=f=${p.hp},lowpass=f=${p.lp},` +
    `equalizer=f=${p.cutFreq}:width_type=o:width=${p.cutWidth}:g=${p.cutGain},` +
    `equalizer=f=${p.midFreq}:width_type=o:width=${p.midWidth}:g=${p.midGain},` +
    `acompressor=threshold=${p.threshold}dB:ratio=${p.ratio}:attack=${Math.round(p.attack * 1000)}:release=${Math.round(p.release * 1000)}:makeup=${p.makeup}`
  )
}

/**
 * 变声预设（导出阶段）。
 *
 * ⚠️ 三个必须记住的约束：
 *  1. 改采样率的几个（花栗鼠 / 低沉）**必须**紧跟 `aresample` 回到 48kHz，
 *     再用 `atempo` 把时长拉回来 —— 只写 `asetrate` 的话是"变调 + 变速"，
 *     片段会短掉一截，和视频对不上，而且轨道上看着一切正常。
 *  2. `atempo` 单级只吃 0.5–2.0，这里几个预设的倍率都在范围内，不需要拆链。
 *  3. 机器人和电话是**近似**：ffmpeg 没有真正的环形调制，用 `acrusher`（位深压缩）
 *     加 `tremolo` / 频段限制来做出"机械""细窄"的听感。要更真得上模型，不在本机方案内。
 *
 *  ⚠️ 这里**故意不放回声类预设**（`aecho`）：它会把输出拖长一个尾巴（实测 3 秒的源
 *     变 3.08 秒），而片段时长是按视频定的 —— 尾巴会挤进下一段，音画对不上。
 *     要对齐就得在导出的音频链末尾再加一道按 dur 的 atrim，那是给一个"听着好玩"的
 *     效果付全局风险，不划算。
 */
const VOICE_CHANGES = [
  { key: 'none', label: '原声' },
  { key: 'chipmunk', label: '花栗鼠' },
  { key: 'deep', label: '低沉' },
  { key: 'phone', label: '电话' },
  { key: 'robot', label: '机器人' },
  { key: 'radio', label: '电台' }
]

/**
 * 变声预设的**数值参数**（预览与导出同源）。
 *
 * 返回的是"要做什么"，不是"ffmpeg 怎么写"：滤波频点、位深、颤动、压缩器参数。
 *   · 导出：`voiceChangeFilter()` 把它们拼成 ffmpeg 串；
 *   · 预览：`shared/audioGraph.js` 把它们编成 WebAudio 节点（BiquadFilter / WaveShaper /
 *     LFO 调幅 / DynamicsCompressor）。
 *
 * ⚠️ `pitch` 这一类（花栗鼠 / 低沉）预览做不了：改音高同时保持时长需要时间伸缩，
 *    `<video>`/`<audio>` 上没有任何等价开关（`playbackRate` 会连速度一起改）。
 *    它们带 `exportOnly: true` —— 面板上照实说明，不假装预览里已经变了。
 */
function voiceChangeParams(key) {
  switch (String(key || 'none')) {
    case 'chipmunk':
      /* 采样率 ×1.32 ⇒ 音高升约 5 个半音 */
      return { exportOnly: true, pitch: 1.32 }
    case 'deep':
      /* ×0.78 ⇒ 降约 4.5 个半音 */
      return { exportOnly: true, pitch: 0.78 }
    case 'phone':
      /* 300–3400Hz 是电话频段；再叠一点位深压缩做出"压缩感" */
      return { hp: 300, lp: 3400, crush: { bits: 10, mix: 0.25 } }
    case 'robot':
      /* 位深压缩 + 快速颤动 = 机械感。颤动频率取 32Hz（人声基频之上，听着像"金属"） */
      return { crush: { bits: 6, mix: 0.4 }, tremolo: { f: 32, d: 0.75 } }
    case 'radio':
      return { hp: 180, lp: 6200, comp: { threshold: -16, ratio: 5, attack: 0.004, release: 0.12 } }
    default:
      return null
  }
}

function voiceChangeFilter(key) {
  const p = voiceChangeParams(key)
  if (!p) return ''
  /* 改采样的两个：`asetrate` 吃的是**绝对采样率**，所以必须先 aformat 到 48kHz，
     再用 atempo 的倒数把时长拉回来（单级 atempo 只吃 0.5–2.0，这两档都在范围内）。 */
  if (p.exportOnly) {
    const rate = Math.round(48000 * p.pitch)
    const tempo = Number((1 / p.pitch).toFixed(4))
    return `aformat=sample_rates=48000,asetrate=${rate},aresample=48000,atempo=${tempo}`
  }
  const parts = []
  if (p.hp) parts.push(`highpass=f=${p.hp}`)
  if (p.lp) parts.push(`lowpass=f=${p.lp}`)
  if (p.crush) parts.push(`acrusher=bits=${p.crush.bits}:mode=log:mix=${p.crush.mix}`)
  if (p.tremolo) parts.push(`tremolo=f=${p.tremolo.f}:d=${p.tremolo.d}`)
  if (p.comp) {
    parts.push(
      `acompressor=threshold=${p.comp.threshold}dB:ratio=${p.comp.ratio}:attack=${Math.round(p.comp.attack * 1000)}:release=${Math.round(p.comp.release * 1000)}`
    )
  }
  return parts.join(',')
}

module.exports = {
  VOLUME_KF_MAX,
  LOUDNESS_MODES,
  VOICE_CHANGES,
  readVolumeKf,
  hasVolumeKf,
  volumeAt,
  volumeExpr,
  fadeGainAt,
  loudnormFor,
  audioDenoiseFilter,
  videoDenoiseFilter,
  stabilizeFilter,
  panGains,
  panFilter,
  voiceEnhanceParams,
  voiceEnhanceFilter,
  voiceChangeParams,
  voiceChangeFilter
}
