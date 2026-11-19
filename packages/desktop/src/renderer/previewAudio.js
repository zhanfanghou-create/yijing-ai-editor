/**
 * 预览侧的音频效果链路（WebAudio）。
 *
 * 解决的是这一类问题：**面板上拖了、成片里真变了、预览里一点没变**。
 * 以前「人声增强」「立体声平衡」「电话/电台/机器人变声」都只有导出侧认
 * （`render.js` 的 ffmpeg 链），界面上只能写一句「只在导出时生效」。
 *
 * 做法：把媒体元素接进一张 WebAudio 图（`createMediaElementSource`），
 * 节点按 `shared/audioGraph.js` 产出的计划串起来：
 *
 *   source → 高通 → 低通 → 峰值 ×2 → 压缩器 → 补偿增益 → 变声(滤波/位深/颤动) → 左右增益 → destination
 *
 * 三条必须守住的规矩：
 *
 *  ① **只在非中性时接管**。计划为空（没调过任何效果）时一律不碰元素 ——
 *     `createMediaElementSource` 每个元素只能建一次，而一旦接进图，
 *     元素的声音就只从图里出（图被挂起 = 整条预览静音）。让 99% 的普通片段
 *     走原来的 `<video>.volume` 老路，是这件事唯一安全的做法。
 *  ② **建失败就永久放弃这个元素**，并且把 `data-audio-graph` 标成 `failed`。
 *     绝不回退到"重建一次试试"——那样会一半有声一半没声，比直接没效果更难查。
 *  ③ **音量与淡入淡出不走这里**。它们走 `el.volume`（与音量包络同一条路，
 *     `shared/audio.js` 的 `fadeGainAt`），在这里再乘一次就变成平方衰减 ——
 *     症状是"调了淡入，声音小得离谱但形状对"。
 *
 * 元素音量（`el.volume`）在 WebAudio 里作用于**源节点之前**，所以两条路可以叠加，
 * 不会互相顶掉。
 */
import { planOf, signatureOf, crushCurve } from '../shared/audioGraph.js'

/** 全局唯一上下文：一张图里跨元素共享时钟，切片段时不会各走各的 */
let ctx = null
let ctxBroken = false

/** 元素 → 已建的图（WeakMap：元素被 React 丢弃后自动回收，不需要手工登记） */
const graphs = new WeakMap()

function context() {
  if (ctx || ctxBroken) return ctx
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) {
    ctxBroken = true
    return null
  }
  try {
    ctx = new Ctor({ latencyHint: 'playback' })
  } catch {
    ctxBroken = true
    ctx = null
  }
  return ctx
}

/**
 * 计划里的一个节点 → WebAudio 节点。
 * 每个分支都返回"输入 → 输出"可串联的一小组节点，由 `wire()` 按顺序连起来。
 */
function buildNode(c, spec) {
  switch (spec.kind) {
    case 'highpass':
    case 'lowpass': {
      const node = c.createBiquadFilter()
      node.type = spec.kind
      node.frequency.value = spec.freq
      /* 一阶（12dB/oct 是 biquad 的默认斜率）；Q=0.7071 是 Butterworth，最平。
         ffmpeg 的 highpass 默认是 poles=2（同斜率），两边在这里对得上。 */
      node.Q.value = 0.7071
      return node
    }
    case 'peaking': {
      const node = c.createBiquadFilter()
      node.type = 'peaking'
      node.frequency.value = spec.freq
      node.Q.value = spec.q
      node.gain.value = spec.gain
      return node
    }
    case 'compressor': {
      const node = c.createDynamicsCompressor()
      node.threshold.value = spec.threshold
      node.ratio.value = spec.ratio
      node.attack.value = spec.attack
      node.release.value = spec.release
      /* knee 取 0：ffmpeg 的 acompressor 默认是硬拐点，WebAudio 默认 30dB 软拐点，
         不改成 0 的话"压平"会提前 30dB 就开始起作用，听感比成片更糊。 */
      node.knee.value = 0
      return node
    }
    case 'gain': {
      const node = c.createGain()
      node.gain.value = Math.pow(10, Number(spec.db || 0) / 20)
      return node
    }
    case 'crush': {
      const shaper = c.createWaveShaper()
      shaper.curve = crushCurve(spec.bits, spec.mix)
      /* 'none' 不做超采样：位深压缩本来就是"阶梯"，oversample 会把它抹平 */
      shaper.oversample = 'none'
      return shaper
    }
    case 'tremolo': {
      /* 一个 GainNode 被 32Hz 的振荡器调制：底值 = 1 − d/2，摆幅 = d/2，
         于是增益在 [1−d, 1] 之间来回 —— 与 ffmpeg 的 tremolo f=32:d=0.75 同义 */
      const depth = Math.min(1, Math.max(0, Number(spec.depth) || 0))
      const amp = c.createGain()
      amp.gain.value = 1 - depth / 2
      const lfo = c.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = Number(spec.freq) || 30
      const swing = c.createGain()
      swing.gain.value = depth / 2
      lfo.connect(swing).connect(amp.gain)
      lfo.start()
      /* 用一个"入口"节点把这条支路也变成可串联的：输入直通到 amp，
         调制器已经挂在 amp.gain 上了。 */
      return { input: amp, output: amp, extra: [lfo, swing] }
    }
    case 'pan': {
      /* 平衡（balance）不是声像（panning）：左右各自乘一个增益，
         中心必须恰好 1/1。用 StereoPanner 会把立体声折成单声道再摆位，
         与导出的 `pan=c0=l*c0|c1=r*c1` 不是一回事 —— 听感是"声场变窄"。 */
      const split = c.createChannelSplitter(2)
      const merge = c.createChannelMerger(2)
      const left = c.createGain()
      const right = c.createGain()
      left.gain.value = Number(spec.left ?? 1)
      right.gain.value = Number(spec.right ?? 1)
      split.connect(left, 0)
      split.connect(right, 1)
      left.connect(merge, 0, 0)
      right.connect(merge, 0, 1)
      return { input: split, output: merge, extra: [left, right] }
    }
    default:
      return null
  }
}

function wire(nodes) {
  for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].output.connect(nodes[i + 1].input)
}

/**
 * 把 buildNode 的返回值统一成"可串联、可拆除"的一段。
 * 单个节点与"输入/输出不同"的复合段（颤动、声像）在这里收口，
 * 外面只认 `input / output / disconnect`，不用关心它内部有几个节点。
 */
function asPiece(built) {
  if (!built) return null
  if (built.input) {
    return {
      input: built.input,
      output: built.output,
      extra: built.extra || [],
      disconnect: () => {
        built.input.disconnect()
        if (built.output !== built.input) built.output.disconnect()
      }
    }
  }
  return { input: built, output: built, extra: [], disconnect: () => built.disconnect() }
}

/** 拆掉旧链路（保留 source 与 destination：source 每个元素只能建一次） */
function teardown(graph) {
  const meter = graph.meter
  if (meter) {
    if (meter.raf) cancelAnimationFrame(meter.raf)
    for (const node of [meter.split, meter.aL, meter.aR, meter.sink]) {
      try {
        node.disconnect()
      } catch {
        /* 已断开就忽略 */
      }
    }
    graph.meter = null
  }
  for (const piece of graph.pieces) {
    try {
      piece.disconnect()
    } catch {
      /* 已断开就忽略 */
    }
    for (const extra of piece.extra || []) {
      try {
        if (typeof extra.stop === 'function') extra.stop()
        extra.disconnect()
      } catch {
        /* 同上 */
      }
    }
  }
  graph.pieces = []
  graph.sig = ''
}

/**
 * 在链路末端挂一个**左右声道的电平表**，把实测 RMS 写进 `data-audio-level-l/r`。
 *
 * 为什么需要它：声音的效果"看不见"。`data-audio-graph="on"` 只能证明"接上了"，
 * 证明不了"左右真的分了"。Analyser 单只是混单声道的，所以要先 ChannelSplitter 再各接一只，
 * 这样拖到最左时左声道 RMS 明显大于右声道 —— 这是声像生效的硬证据（E2E 读这两个数）。
 *
 * 表本身是**排水**的（sink 增益 0），不影响听感；只在有非中性效果时存在。
 */
function attachMeter(c, out, graph, el) {
  const split = c.createChannelSplitter(2)
  const aL = c.createAnalyser()
  const aR = c.createAnalyser()
  for (const node of [aL, aR]) {
    node.fftSize = 512
    node.smoothingTimeConstant = 0.3
  }
  const sink = c.createGain()
  sink.gain.value = 0
  out.connect(split)
  split.connect(aL, 0)
  split.connect(aR, 1)
  aL.connect(sink)
  aR.connect(sink)
  sink.connect(c.destination)

  const bufL = new Float32Array(aL.fftSize)
  const bufR = new Float32Array(aR.fftSize)
  const rms = (node, buf) => {
    node.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  }
  const meter = { split, aL, aR, sink, raf: 0, at: 0 }
  const tick = () => {
    meter.raf = requestAnimationFrame(tick)
    const now = performance.now()
    /* 6Hz 就够：再快也只是把同一个数字写十遍，还会让 DOM 变更抢渲染线程 */
    if (now - meter.at < 160) return
    meter.at = now
    const l = rms(aL, bufL)
    const r = rms(aR, bufR)
    el.dataset.audioLevelL = l.toFixed(4)
    el.dataset.audioLevelR = r.toFixed(4)
  }
  meter.raf = requestAnimationFrame(tick)
  graph.meter = meter
}

/**
 * 给一个媒体元素套上音频效果。
 *
 * @param {HTMLMediaElement} el  `<video>` / `<audio>`
 * @param {object} clip         片段（读 pan / voiceBoost / voiceFx / audioDenoise）
 * @returns {'none'|'graph'|'failed'} 实际走的路（`none` = 计划为空、没接管）
 */
export function applyAudioFx(el, clip) {
  /* 只有真正能出声的元素才接：图片 / 文字层也走同一段代码，
     在 <img> 上建 MediaElementSource 会抛错，还会把 `data-audio-graph` 标成 failed。 */
  if (!el || typeof el !== 'object' || typeof el.volume !== 'number') return 'none'
  const plan = planOf(clip)
  if (plan.neutral) {
    /* 计划变中性：把已经建好的链路拆掉，声音回到元素自己的音量上 */
    const graph = graphs.get(el)
    if (graph) {
      teardown(graph)
      try {
        graph.source.disconnect()
        graph.source.connect(ctx.destination)
      } catch {
        /* 忽略 */
      }
      el.dataset.audioGraph = 'none'
      delete el.dataset.audioLevelL
      delete el.dataset.audioLevelR
    }
    return 'none'
  }

  const c = context()
  if (!c) {
    el.dataset.audioGraph = 'failed'
    return 'failed'
  }

  let graph = graphs.get(el)
  if (!graph) {
    if (graph === false) {
      /* 之前建失败过：不再重试（见文件头 ②） */
      el.dataset.audioGraph = 'failed'
      return 'failed'
    }
    let source = null
    try {
      source = c.createMediaElementSource(el)
    } catch {
      graphs.set(el, false)
      el.dataset.audioGraph = 'failed'
      return 'failed'
    }
    graph = { source, pieces: [], sig: '' }
    graphs.set(el, graph)
  }

  const sig = signatureOf(plan)
  if (sig !== graph.sig) {
    teardown(graph)
    const pieces = []
    for (const spec of plan.chain) {
      const piece = asPiece(buildNode(c, spec))
      if (piece) pieces.push(piece)
    }
    try {
      /* 先断掉 source 原有的全部出口：重建时它可能还连着上一轮的第一个节点，
         不断的话声音会同时进新旧两条链（旧链末端已断开，听不出来，但节点会越积越多） */
      graph.source.disconnect()
      if (pieces.length) {
        graph.source.connect(pieces[0].input)
        wire(pieces)
        pieces[pieces.length - 1].output.connect(c.destination)
        attachMeter(c, pieces[pieces.length - 1].output, graph, el)
      } else {
        graph.source.connect(c.destination)
      }
    } catch {
      graphs.set(el, false)
      el.dataset.audioGraph = 'failed'
      return 'failed'
    }
    graph.pieces = pieces
    graph.sig = sig
  }

  /* 图挂起时元素的声音会被吞掉，所以只要有东西要放就顺手唤醒一次 */
  if (typeof c.resume === 'function' && c.state === 'suspended') c.resume().catch(() => {})
  el.dataset.audioGraph = plan.chain.length ? 'on' : 'none'
  return 'graph'
}

/** 元素卸载时调用：断开但不销毁上下文（下一个片段还要用） */
export function detachAudioFx(el) {
  const graph = el ? graphs.get(el) : null
  if (!graph) return
  teardown(graph)
  try {
    graph.source.disconnect()
  } catch {
    /* 忽略 */
  }
  graphs.delete(el)
}
