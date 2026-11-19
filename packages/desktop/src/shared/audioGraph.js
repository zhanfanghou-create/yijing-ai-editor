'use strict'
/**
 * 音频效果的**唯一真源**：把一个片段编成一串"要做什么"的节点计划。
 *
 * 为什么要有这一层：
 *   导出侧（`render.js`）把效果写成 ffmpeg 滤镜串，预览侧（`renderer/previewAudio.js`）
 *   要写成 WebAudio 节点图。两边如果各写一份参数，迟早出现"面板上调了、预览听着变了、
 *   成片却是另一个声"—— 而声音的差异**闸门比不出来**，只有耳朵能发现。
 *   所以这里只产出**数值**（频点、增益、位深、压缩器参数），格式交给两个执行器各自拼。
 *
 * ⚠️ 三类事情本文件明确**不给预览做**（带 `exportOnly` 理由，面板上照实写）：
 *   · 频域降噪（`afftdn`）：要频谱统计，WebAudio 没有等价节点；
 *   · 变调（花栗鼠 / 低沉）：改音高同时保时长需要时间伸缩，媒体元素上无开关；
 *   · 视频降噪 / 防抖 / 响度统一：它们本来就不是"声音效果"，另有各自的原因。
 *
 * 本文件是**纯函数 + CJS**，主进程与渲染层都能 require（Electron 两侧不同打包目标，
 * 用 ESM 会让主进程侧报错）。
 */

const audio = require('./audio.js')

const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round4 = (value) => Number(Number(value).toFixed(4))

/**
 * 倍频程带宽 → peaking 滤波器的 Q。
 *
 * ffmpeg 的 `equalizer` 用 `width_type=o` 给**倍频程**，WebAudio 的 `peaking` 只认 Q。
 * 换算式：`Q = √(2^N) / (2^N − 1)`（N = 倍频程数；N=1 时 Q≈1.41，与常见表格一致）。
 * 不做换算直接拿 1.6 当 Q 用，听感会窄一大截（"提亮"变成"尖锐"）。
 */
function octaveToQ(octaves) {
  const w = Math.pow(2, Math.max(0.05, num(octaves, 1)))
  return round4(Math.sqrt(w) / (w - 1))
}

/**
 * 位深压缩（`acrusher` 的近似）的传输曲线。
 *
 * `acrusher` 的 `mix` 是干湿比，这里直接烘进曲线 —— 位深压缩是**无记忆**的逐采样映射，
 * 所以"干湿混合"与"混合后的曲线"完全等价，不需要两条并联支路（省一堆节点）。
 *
 * @param {number} bits 位深（越小越糙）
 * @param {number} mix  0–1 干湿比
 * @param {number} samples 曲线取样个数（WaveShaper 的标准做法，1024 够用）
 * @returns {Float32Array}
 */
function crushCurve(bits, mix, samples = 1024) {
  const b = clamp(num(bits, 8), 1, 16)
  const m = clamp(num(mix, 0), 0, 1)
  const levels = Math.max(1, Math.pow(2, b - 1))
  const curve = new Float32Array(samples)
  for (let i = 0; i < samples; i += 1) {
    const x = (i / (samples - 1)) * 2 - 1
    const y = Math.round(x * levels) / levels
    curve[i] = (1 - m) * x + m * y
  }
  return curve
}

/**
 * 片段 → 音频节点计划。
 *
 * 链序与 `render.js` 的 ffmpeg 尾段**逐段对应**：
 *   降噪（仅导出）→ 人声增强 → 变声 → 立体声平衡。
 * 音量与淡入淡出**不在这里** —— 它们走 `<video>.volume`（与音量包络同一条路），
 * 放进 WebAudio 反而会和元素音量重复相乘。
 *
 * @param {object} clip 片段（读 pan / voiceBoost / voiceFx / audioDenoise）
 * @returns {{neutral:boolean, chain:Array, pan:object|null, exportOnly:string[]}}
 */
function planOf(clip) {
  const chain = []
  const exportOnly = []

  const denoise = clamp(num(clip?.audioDenoise, 0), 0, 100)
  if (denoise >= 1) exportOnly.push('denoise')

  const boost = audio.voiceEnhanceParams(num(clip?.voiceBoost, 0))
  if (boost) {
    chain.push({ kind: 'highpass', freq: boost.hp })
    chain.push({ kind: 'lowpass', freq: boost.lp })
    chain.push({ kind: 'peaking', freq: boost.cutFreq, q: octaveToQ(boost.cutWidth), gain: boost.cutGain })
    chain.push({ kind: 'peaking', freq: boost.midFreq, q: octaveToQ(boost.midWidth), gain: boost.midGain })
    chain.push({
      kind: 'compressor',
      threshold: boost.threshold,
      ratio: boost.ratio,
      attack: boost.attack,
      release: boost.release
    })
    /* makeup：ffmpeg 的 `makeup=2` 是 dB，折成线性增益挂在压缩器后面 */
    chain.push({ kind: 'gain', db: boost.makeup })
  }

  const voice = audio.voiceChangeParams(clip?.voiceFx)
  if (voice) {
    if (voice.exportOnly) exportOnly.push(String(clip.voiceFx))
    if (voice.hp) chain.push({ kind: 'highpass', freq: voice.hp })
    if (voice.lp) chain.push({ kind: 'lowpass', freq: voice.lp })
    if (voice.crush) chain.push({ kind: 'crush', bits: voice.crush.bits, mix: voice.crush.mix })
    if (voice.tremolo) {
      chain.push({ kind: 'tremolo', freq: voice.tremolo.f, depth: voice.tremolo.d })
    }
    if (voice.comp) {
      chain.push({
        kind: 'compressor',
        threshold: voice.comp.threshold,
        ratio: voice.comp.ratio,
        attack: voice.comp.attack,
        release: voice.comp.release
      })
    }
  }

  const pan = audio.panGains(clip?.pan)
  if (pan) chain.push({ kind: 'pan', left: pan.left, right: pan.right })

  return {
    /* `neutral` 是"能不能完全不碰 WebAudio"的判据。
       ⚠️ 只有导出项（降噪 / 花栗鼠 / 低沉）时也算中性 —— 预览里没有你要做的事，
          就别为它把元素接进音频图（接进去就多了静音风险，换不来任何听感）。 */
    neutral: chain.length === 0,
    chain,
    pan,
    exportOnly
  }
}

/** 计划 → 稳定字符串（渲染层用它判断"要不要重建链路"，避免每帧重连） */
function signatureOf(plan) {
  if (!plan || plan.neutral) return ''
  return plan.chain
    .map((node) => Object.keys(node).sort().map((k) => `${k}=${node[k]}`).join(':'))
    .join('|')
}

module.exports = { planOf, signatureOf, crushCurve, octaveToQ }
