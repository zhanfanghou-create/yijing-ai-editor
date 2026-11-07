/**
 * 智能抠像的推理层（渲染层）。
 *
 * 与人物特效（`facefx.js`）同一套路：**同一个 wasm 运行时，不同的 task**。
 * 这里只做「输入一张画面 → 输出一张带 alpha 的画面」，位置/时间/落轨全交给上层。
 *
 * 三个必须照做的约束（都踩过，见 facefx.js 顶部）：
 *  ① 自己构造 fileset `{ wasmLoaderPath, wasmBinaryPath }`，不能传 FilesetResolver 本体；
 *  ② 加载器走 blob，不让素材协议进 CSP 的 script-src；
 *  ③ 逐帧 seek 求可复现，不靠播放。
 *
 * ⚠️ `ImageSegmenter` 的 `runningMode` 在 createFromOptions 时就定死了，
 *    同一个实例不能既跑图片又跑视频（切模式会抛）。
 *    所以图片与视频**各缓存一个实例** —— 共用会让"先抠图再抠视频"报错，
 *    而这个错只在用户连续用两次时才出现，最容易漏测。
 *
 * ⚠️ selfie_segmenter 只认「人 / 非人」。画面里没有人的时候它不会报错，
 *    而是给出一份几乎全 0 的 mask —— 直接乘上去就是**整张透明**。
 *    所以这里算完会回报 `coverage`（前景占比），
 *    上层据此拦下"抠完什么都没有"的情况，而不是写一个全透明的空素材进库。
 */
import { MATTE_FPS, MATTE_MAX_EDGE, MATTE_MIN_COVERAGE } from '../shared/matte.js'

let runtimePromise = null

/**
 * 加载运行时（只加载一次）。
 *
 * @returns {Promise<{ vision:object, fileset:object, model:string }>}
 * @throws 缺文件时抛出可读错误（缺哪个说哪个）
 */
export function loadMatteRuntime() {
  if (runtimePromise) return runtimePromise
  runtimePromise = (async () => {
    const rt = await window.yjai?.matte?.runtime?.()
    if (!rt) throw new Error('主进程没有响应抠像运行时查询')
    if (!rt.ok) {
      throw new Error(`智能抠像运行时缺失：${(rt.missing || []).join('、') || '未知'}`)
    }
    /* 加载器与人物特效是同一个文件（vision_wasm_internal.js），
       复用它那条 IPC 而不是再开一条 —— 两条通路读同一个文件，
       迟早会出现"一边能读一边读不出"的分叉。 */
    const loader = await window.yjai?.facefx?.loader?.()
    if (!loader || !loader.ok) {
      throw new Error(`wasm 加载器读不出来：${(loader && loader.error) || '未知原因'}`)
    }
    const vision = await import('@mediapipe/tasks-vision')
    const blobUrl = URL.createObjectURL(new Blob([loader.text], { type: 'text/javascript' }))
    return {
      vision,
      fileset: { wasmLoaderPath: blobUrl, wasmBinaryPath: rt.wasm },
      model: rt.model
    }
  })()
  runtimePromise.catch(() => {
    runtimePromise = null
  })
  return runtimePromise
}

/** 两个实例：图片 / 视频各一个（runningMode 不可中途切换） */
const segments = { IMAGE: null, VIDEO: null }

async function ensureSegmenter(mode) {
  if (segments[mode]) return segments[mode]
  const { vision, fileset, model } = await loadMatteRuntime()
  segments[mode] = await vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate: 'GPU' },
    runningMode: mode,
    outputCategoryMask: false,
    /* 只要 confidence：它是 0~1 的软值，边缘天然带羽化。
       用 categoryMask（0/255 硬分类）会把头发丝切出锯齿。 */
    outputConfidenceMasks: true
  })
  return segments[mode]
}

/** 释放实例（切换项目 / 测试收尾时用） */
export function disposeSegmenters() {
  for (const key of Object.keys(segments)) {
    try {
      segments[key]?.close?.()
    } catch {
      /* 已经关了 */
    }
    segments[key] = null
  }
}

/**
 * 把任意图源画进 canvas（限制最大边长）。
 *
 * @param {CanvasImageSource} source
 * @param {number} nw 源自然宽
 * @param {number} nh 源自然高
 * @returns {HTMLCanvasElement}
 */
function drawToCanvas(source, nw, nh) {
  const k = Math.min(1, MATTE_MAX_EDGE / Math.max(nw || 1, nh || 1))
  const w = Math.max(2, Math.round((nw || 1) * k))
  const h = Math.max(2, Math.round((nh || 1) * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(source, 0, 0, w, h)
  return canvas
}

/**
 * 把 confidence mask 乘进 alpha 通道。
 *
 * @param {HTMLCanvasElement} canvas 已经画好原图的画布（就地修改）
 * @param {Float32Array} data 置信度，长度 mw*mh
 * @param {number} mw
 * @param {number} mh
 * @param {number} softness 0~100：0 = 原样（最软），100 = 近乎硬边
 * @returns {{ coverage:number, edge:number }}
 */
function applyMask(canvas, data, mw, mh, softness) {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const frame = ctx.getImageData(0, 0, w, h)
  const px = frame.data

  /* 软化/硬化在**置信度上**做，不是在 alpha 上做：
     alpha 已经是 0~255 的量化值，再做一次曲线会把暗部整片抹成 0。 */
  const s = Math.max(0, Math.min(100, Number(softness) || 0)) / 100
  const lo = 0.5 - 0.5 * (1 - s) * 0.9
  const hi = 0.5 + 0.5 * (1 - s) * 0.9
  const span = Math.max(1e-4, hi - lo)

  let fg = 0
  let edge = 0
  for (let y = 0; y < h; y += 1) {
    const my = Math.min(mh - 1, Math.floor((y * mh) / h))
    const rowOffset = my * mw
    for (let x = 0; x < w; x += 1) {
      const mx = Math.min(mw - 1, Math.floor((x * mw) / w))
      const c = data[rowOffset + mx]
      let a = (c - lo) / span
      if (a < 0) a = 0
      else if (a > 1) a = 1
      const v = Math.round(a * 255)
      px[(y * w + x) * 4 + 3] = v
      if (v > 250) fg += 1
      else if (v > 8 && v < 250) edge += 1
    }
  }
  ctx.putImageData(frame, 0, 0)
  const total = w * h
  return { coverage: fg / total, edge: edge / total }
}

/**
 * 抠一张图（照片 / 视频暂停的那一帧 / 任何 CanvasImageSource）。
 *
 * @param {CanvasImageSource} source
 * @param {number} nw 自然宽
 * @param {number} nh 自然高
 * @param {object} [opts]
 * @param {number} [opts.softness] 边缘软硬，0~100，默认 50（保留模型原本的柔边）
 * @param {number} [opts.timestamp] 视频模式下必传，毫秒
 * @returns {Promise<{ canvas:HTMLCanvasElement, coverage:number, edge:number, ms:number }>}
 */
export async function matteOne(source, nw, nh, opts = {}) {
  const startedAt = performance.now()
  const seg = await ensureSegmenter('IMAGE')
  const canvas = drawToCanvas(source, nw, nh)
  const res = seg.segment(canvas)
  const mask = res?.confidenceMasks?.[0]
  if (!mask) throw new Error('抠像模型没有返回遮罩')
  const stat = applyMask(canvas, mask.getAsFloat32Array(), mask.width, mask.height, opts.softness)
  return { canvas, ...stat, ms: Math.round(performance.now() - startedAt) }
}

/** 等 seek 完成（带超时：某些容器 seek 到关键帧边界不触发 seeked） */
function seekTo(video, t, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      video.removeEventListener('seeked', finish)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    video.addEventListener('seeked', finish, { once: true })
    try {
      video.currentTime = t
    } catch {
      finish()
    }
  })
}

/**
 * 把抠好的主体合到一个新背景上。
 *
 * 为什么必须合成背景，而不是交一条"透明视频"（见 render.js 里 encodeMatteSequence
 * 顶部那段）：ffmpeg 编不出 Chromium 能播的带 alpha 视频，
 * 所以视频抠像的产物是**已经合好背景的普通 mp4** —— 预览播什么、成片就是什么。
 *
 * @param {HTMLCanvasElement} matted 已经乘过 alpha 的画面
 * @param {HTMLVideoElement} video 同一帧的原视频（取背景用）
 * @param {{mode:'blur'|'color', color?:string}} bg
 * @returns {HTMLCanvasElement}
 */
function composeBackground(matted, video, bg) {
  const w = matted.width
  const h = matted.height
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (bg && bg.mode === 'color') {
    ctx.fillStyle = String(bg.color || '#000000')
    ctx.fillRect(0, 0, w, h)
  } else {
    /* 背景虚化：先放大 8% 再 blur，模糊的边界不会在四边露出空档 */
    const k = 1.08
    ctx.save()
    ctx.filter = 'blur(28px)'
    ctx.drawImage(video, -(w * (k - 1)) / 2, -(h * (k - 1)) / 2, w * k, h * k)
    ctx.restore()
    /* 压暗一档：不压的话主体和背景明度接近，看着像没抠 */
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(matted, 0, 0)
  return out
}

/**
 * 抠一段视频：逐帧算 mask，把"主体 + 新背景"交出去。
 *
 * 不在这里编码视频 —— 编码交给主进程的 ffmpeg（`encodeMatteSequence`），
 * 渲染层只管"给我一帧，我给你一张画好的 PNG"。
 *
 * @param {HTMLVideoElement} video 已挂源、metadata 就绪
 * @param {object} opts
 * @param {number} [opts.fps] 采样帧率，默认 MATTE_FPS
 * @param {number} [opts.start] 起点（秒）
 * @param {number} [opts.duration] 时长（秒）
 * @param {number} [opts.softness]
 * @param {{mode:'blur'|'color', color?:string}} [opts.bg] 背景，默认虚化
 * @param {(p:{done:number,total:number,coverage:number})=>void} [opts.onProgress]
 * @param {(png:{base64:string, index:number})=>Promise<void>} opts.onFrame 每帧回调
 * @returns {Promise<{ frames:number, coverage:number, ms:number, truncated:boolean }>}
 */
export async function matteVideo(video, opts = {}) {
  const startedAt = performance.now()
  const seg = await ensureSegmenter('VIDEO')
  const fps = Math.max(2, Math.min(30, Number(opts.fps) || MATTE_FPS))
  const start = Math.max(0, Number(opts.start) || 0)
  const duration = Math.max(0.1, Number(opts.duration) || Math.max(0, (video.duration || 0) - start))
  const total = Math.max(1, Math.ceil(duration * fps))

  const prevTime = video.currentTime
  const prevPaused = video.paused
  let frames = 0
  let sumCoverage = 0
  let maxCoverage = 0

  try {
    for (let i = 0; i < total; i += 1) {
      const t = Math.min(start + i / fps, start + duration)
      await seekTo(video, t)
      const canvas = drawToCanvas(video, video.videoWidth, video.videoHeight)
      const res = seg.segmentForVideo(canvas, Math.round(i * (1000 / fps)))
      const mask = res?.confidenceMasks?.[0]
      if (!mask) break
      const stat = applyMask(canvas, mask.getAsFloat32Array(), mask.width, mask.height, opts.softness)
      sumCoverage += stat.coverage
      if (stat.coverage > maxCoverage) maxCoverage = stat.coverage
      frames += 1

      if (typeof opts.onFrame === 'function') {
        const composed = composeBackground(canvas, video, opts.bg)
        const dataUrl = composed.toDataURL('image/png')
        await opts.onFrame({ base64: dataUrl.slice(dataUrl.indexOf(',') + 1), index: i })
      }
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({ done: i + 1, total, coverage: stat.coverage })
      }
    }
  } finally {
    try {
      await seekTo(video, prevTime)
      if (prevPaused) video.pause()
    } catch {
      /* 还原失败不影响结果 */
    }
  }

  const avg = frames ? sumCoverage / frames : 0
  return {
    frames,
    coverage: avg,
    /* 逐帧都抠不到人 ⇒ 这段素材不适合抠像。交给上层拦下来，
       而不是产出一条"背景虚化的原视频"让用户以为抠成功了。 */
    truncated: maxCoverage < MATTE_MIN_COVERAGE,
    ms: Math.round(performance.now() - startedAt)
  }
}
