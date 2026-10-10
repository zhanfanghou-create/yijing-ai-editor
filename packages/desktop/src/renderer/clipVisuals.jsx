/**
 * 轨道上片段的「内容可视化」—— 视频轨抽帧、音频轨波形、字幕轨文字。
 *
 * 为什么单独一层：这三件事都**不是纯 UI**，各自要真的去解码素材。
 * 混进 Timeline.jsx 会让那个文件既管交互又管解码，而解码部分的失败模式
 * （元数据读不出、画布被跨源污染、容器不支持 seek）跟交互完全无关，
 * 混在一起排查时会互相干扰。
 *
 * 三条硬约束（都是踩过同类坑才写下来的）：
 *
 *  1. **失败必须静默降级，不能让轨道崩掉。** 抽帧/解码都是"锦上添花"：
 *     素材是罕见容器、协议读不到、画布被污染……任何一种都要退回
 *     "只有底色的片段"，而不是抛出去把整条时间线带崩。
 *  2. **失败只试一次。** 结果（含失败）按 key 记住。否则每个片段每次重渲染
 *     都会再起一个 `<video>` 去 seek，用户看到的是一片抖动。
 *  3. **绝不吃指针事件。** 这些图形是画在片段体内的背景，而片段自己要拖、
 *     两端要修剪。所以容器和内容全部 `pointer-events: none`（见 styles.css），
 *     这一条漏了就会表现成"片段突然拖不动了"，而且看不出是谁挡的。
 *
 * 跨源画布污染的说明：视频抽帧要把 `<video>` 画到 canvas 再取 dataURL，
 * 而 `yjai-media://` 与 `file://` 不同源。所以抽帧用的 video 必须带
 * `crossOrigin="anonymous"`，同时主进程把这个协议声明成 `corsEnabled`
 * 并且每个响应都带回 ACAO（两处缺一不可，见 main/index.js 的
 * registerSchemesAsPrivileged 与 protocol.handle）。
 */
import { useEffect, useRef, useState } from 'react'
import { mediaPeaks } from './platform.js'

/* --------------------------- 纯函数（可单测） --------------------------- */

/**
 * 抽哪几帧：每段取**中点**。
 * 刻意不取 0 —— 视频首帧常常是黑场或台标，缩略图位取首帧看着就像"加载失败"。
 */
export function frameTimes(offset, duration, count) {
  const n = Math.max(1, Math.floor(Number(count) || 1))
  const start = Math.max(0, Number(offset) || 0)
  const span = Math.max(0, Number(duration) || 0)
  const list = []
  for (let i = 0; i < n; i += 1) list.push(start + (span * (i + 0.5)) / n)
  return list
}

/**
 * 采样点 → N 个归一化振幅（0..1），每桶取绝对值最大。
 * 归一化到本片段自己的峰值：同一条音轨里一段很轻的旁白也要画出形状，
 * 不能因为别处有爆音就压成一条直线。
 */
export function peakBuckets(samples, buckets) {
  const n = Math.max(1, Math.floor(Number(buckets) || 1))
  const out = new Array(n).fill(0)
  if (!samples || !samples.length) return out
  const per = samples.length / n
  let max = 0
  for (let b = 0; b < n; b += 1) {
    const from = Math.floor(b * per)
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((b + 1) * per)))
    let peak = 0
    for (let i = from; i < to; i += 1) {
      const value = samples[i] < 0 ? -samples[i] : samples[i]
      if (value > peak) peak = value
    }
    out[b] = peak
    if (peak > max) max = peak
  }
  if (max > 0) for (let b = 0; b < n; b += 1) out[b] = out[b] / max
  return out
}

/** 拖到很长的片段不必画上百帧；也很短的片段至少给一帧 */
export function stripCount(widthPx) {
  return Math.max(1, Math.min(8, Math.round((Number(widthPx) || 0) / 78)))
}

/* ------------------------------- 抽帧实现 ------------------------------- */

/** 已定论的结果：`dataURL[]` 或 `null`（试过、不行，不再试） */
const frameResults = new Map()
/** 在飞的请求：同一个 key 只抽一次，多个片段共用时不会各抽一遍 */
const frameFlight = new Map()

function seekTo(video, time) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      video.removeEventListener('seeked', finish)
      resolve()
    }
    video.addEventListener('seeked', finish)
    video.currentTime = time
    // 个别容器 seek 不出事件（无索引的 mkv 等），不能一直挂着
    setTimeout(finish, 1500)
  })
}

function loadMetadata(video, url) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', ok)
      video.removeEventListener('error', bad)
      if (error) reject(error)
      else resolve()
    }
    const ok = () => finish(null)
    const bad = () => finish(new Error('读不出视频元数据'))
    video.addEventListener('loadedmetadata', ok)
    video.addEventListener('error', bad)
    const timer = setTimeout(() => finish(new Error('读元数据超时')), 8000)
    // ⚠️ 必须先挂监听再赋 src：反过来写的话，元数据可能在你挂上之前就已经读到，
    //    于是 loadedmetadata 永远不再触发，只能干等超时（表现为"预览要 8 秒才出现"）。
    video.src = url
  })
}

async function extractFrames(url, times) {
  const video = document.createElement('video')
  // 不带这个就会污染 canvas ⇒ toDataURL 抛 SecurityError
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  video.setAttribute('playsinline', '')
  await loadMetadata(video, url)
  if (!video.videoWidth) throw new Error('不是视频（没有视频轨）')
  const height = 64
  const canvas = document.createElement('canvas')
  canvas.height = height
  canvas.width = Math.max(24, Math.round((video.videoWidth / video.videoHeight) * height))
  const ctx = canvas.getContext('2d')
  const out = []
  for (const time of times) {
    await seekTo(video, time)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    out.push(canvas.toDataURL('image/jpeg', 0.62))
  }
  video.removeAttribute('src')
  video.load()
  return out
}

/** 视频轨：一排抽帧。返回 null 表示这次画不出来，调用方保持原样即可 */
export function ClipFilmstrip({ url, offset, duration, count }) {
  const times = frameTimes(offset, duration, count)
  const key = url ? `${url}|${times.map((t) => t.toFixed(2)).join(',')}` : ''
  const [frames, setFrames] = useState(() => frameResults.get(key) || null)

  useEffect(() => {
    if (!key) return undefined
    const settled = frameResults.get(key)
    if (settled !== undefined) {
      setFrames(settled)
      return undefined
    }
    let alive = true
    let flight = frameFlight.get(key)
    if (!flight) {
      flight = extractFrames(url, times)
      frameFlight.set(key, flight)
    }
    flight.then(
      (list) => {
        frameResults.set(key, list)
        frameFlight.delete(key)
        if (alive) setFrames(list)
      },
      () => {
        frameResults.set(key, null)
        frameFlight.delete(key)
        if (alive) setFrames(null)
      }
    )
    return () => {
      alive = false
    }
    // times 由 offset/duration/count 决定，而 key 已经把三者编码进去了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!frames || !frames.length) return null
  return (
    <span className="clip-strip">
      {frames.map((src, index) => (
        <img key={index} src={src} alt="" draggable={false} />
      ))}
    </span>
  )
}

/* ------------------------------- 波形实现 ------------------------------- */

/**
 * ffmpeg 抽出来的峰值（渲染层拿不到 ffmpeg，只能问主进程）。
 *
 * 为什么还需要这条路：`decodeAudioData` 对**视频容器**不可靠 —— mp4 / mov 里的
 * AAC 经常直接抛 EncodingError，而"视频片段底部那条橙色波形"恰恰是最需要的一个。
 * 而且 WebAudio 那条路要先 `fetch` **整个文件**再解码，给一段 70 秒的成片画波形
 * 等于把整部片子下进内存；ffmpeg 那条路在输入侧 seek，只解片段用掉的那一截。
 */
const pcmResults = new Map()
const pcmFlight = new Map()

async function ffmpegPeaks(url, offset, duration, buckets) {
  const from = Math.max(0, Number(offset) || 0)
  const span = Math.max(0, Number(duration) || 0)
  const key = `${url}|${from.toFixed(3)}|${span.toFixed(3)}|${buckets}`
  const settled = pcmResults.get(key)
  if (settled !== undefined) return settled
  let flight = pcmFlight.get(key)
  if (!flight) {
    flight = mediaPeaks({ url, offset: from, duration: span, buckets })
    pcmFlight.set(key, flight)
  }
  const peaks = await flight
  pcmResults.set(key, peaks)
  pcmFlight.delete(key)
  return peaks
}

/**
 * ffmpeg 峰值的 React 包装。**失败只问一次**（结果含 null 也会记进缓存），
 * 否则"没有音轨"的素材每次重渲染都要再起一次 ffmpeg。
 */
function useFfmpegPeaks(url, offset, duration, buckets) {
  const [peaks, setPeaks] = useState(null)
  const key = url ? `${url}|${(Number(offset) || 0).toFixed(3)}|${(Number(duration) || 0).toFixed(3)}|${buckets}` : ''
  useEffect(() => {
    if (!key) return undefined
    let alive = true
    ffmpegPeaks(url, offset, duration, buckets).then(
      (list) => {
        if (alive) setPeaks(list)
      },
      () => {
        if (alive) setPeaks(null)
      }
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return peaks
}

const waveResults = new Map()
const waveFlight = new Map()

/**
 * 解码成振幅。
 *
 * 刻意走 `fetch` + WebAudio：波形是**自己画的柱子**，不是素材里的像素，
 * 所以不存在画布污染问题 —— 这条路比视频抽帧稳得多。
 * 依赖的是渲染层能 fetch 自定义协议（主进程已带 ACAO，见其注释）。
 */
async function decodePeaks(url, buckets) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`取音频失败 ${response.status}`)
  const buffer = await response.arrayBuffer()
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) throw new Error('这个环境没有 WebAudio')
  const ctx = new Ctor()
  try {
    const audio = await ctx.decodeAudioData(buffer)
    return peakBuckets(audio.getChannelData(0), buckets)
  } finally {
    // 不解码完就关掉会把解码过程一起掐掉；这里已经拿到数据了
    if (ctx.close) ctx.close().catch(() => {})
  }
}

/** 音频轨：真实波形。画不出来就返回 null，由 CSS 退回原来的装饰条 */
export function ClipWaveform({ url, buckets = 160 }) {
  const canvasRef = useRef(null)
  const [peaks, setPeaks] = useState(() => (url ? waveResults.get(url) || null : null))

  useEffect(() => {
    if (!url) return undefined
    const settled = waveResults.get(url)
    if (settled !== undefined) {
      setPeaks(settled)
      return undefined
    }
    let alive = true
    let flight = waveFlight.get(url)
    if (!flight) {
      flight = decodePeaks(url, buckets)
      waveFlight.set(url, flight)
    }
    flight.then(
      (list) => {
        waveResults.set(url, list)
        waveFlight.delete(url)
        if (alive) setPeaks(list)
      },
      () => {
        waveFlight.delete(url)
        if (!alive) return
        /* WebAudio 解不出来时退到主进程的 ffmpeg（视频容器里最常见），
           两条路都失败才真的放弃 —— 仍然只问一次，结果照样进缓存。 */
        ffmpegPeaks(url, 0, 0, buckets).then(
          (list) => {
            waveResults.set(url, list)
            if (alive) setPeaks(list)
          },
          () => {
            waveResults.set(url, null)
            if (alive) setPeaks(null)
          }
        )
      }
    )
    return () => {
      alive = false
    }
  }, [url, buckets])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return
    drawBars(canvas, peaks, 480, 48, 'rgba(255, 255, 255, 0.72)', 0.55, 8)
  }, [peaks])

  if (!peaks) return null
  return <canvas className="clip-wave" ref={canvasRef} aria-hidden="true" />
}

/**
 * 视频 / 叠加片段底部的那条波形（参考客户端形制：贴底一条、橙色、约 10px 高）。
 *
 * 与音频轨那个大波形是两件事：
 *   · 这里只画**片段用掉的那一截**（-ss/-t 由片段入点与时长给出）；
 *   · 视频片段自己的声音在预览里未必听得到（只有主层出声），但波形必须照画 ——
 *     它是"素材里有没有声音"的证据，不是"现在响不响"的指示灯。
 *
 * 画不出来（没音轨 / 找不到 ffmpeg）就返回 null，片段保持原来的样子，
 * 绝不留一条假的直波纹充数。
 */
export function ClipAudioWave({ url, offset = 0, duration = 0, buckets = 160 }) {
  const canvasRef = useRef(null)
  const peaks = useFfmpegPeaks(url, offset, duration, buckets)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return
    // 固定分辨率 + CSS 拉伸：缩放时间线时不必重画（片宽是跟着 zoom 变的）
    drawBars(canvas, peaks, 480, 16, '#E87830', 0.6, 2)
  }, [peaks])

  if (!peaks) return null
  return <canvas className="clip-wave clip-wave-inline" ref={canvasRef} aria-hidden="true" />
}

/** 把 N 个振幅画成上下对称的柱子（中间对齐，不是从底部长上来） */
function drawBars(canvas, peaks, width, height, color, fillRatio, inset) {
  // 固定分辨率 + CSS 拉伸：缩放时间线时不必重画，也不会因为忘了监听 resize
  // 而出现"放大后波形还是旧的"这类错位（片宽是跟着 zoom 变的）。
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = color
  const step = width / peaks.length
  const barWidth = Math.max(1, step * fillRatio)
  const mid = height / 2
  for (let i = 0; i < peaks.length; i += 1) {
    const half = Math.max(1, (peaks[i] * (height - inset)) / 2)
    ctx.fillRect(i * step, mid - half, barWidth, half * 2)
  }
}

/* ------------------------------- 文字实现 ------------------------------- */

/** 字幕轨：把文字内容直接铺在轨道上，不用点开属性面板才知道这段写了什么 */
export function ClipText({ text }) {
  if (!text) return null
  return <span className="clip-textbody">{text}</span>
}

/** 图片素材落在视频轨时的静帧预览 */
export function ClipStill({ url }) {
  if (!url) return null
  return <img className="clip-still" src={url} alt="" draggable={false} />
}
