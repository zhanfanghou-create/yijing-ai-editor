/**
 * 人物特效的检测器（渲染层）。
 *
 * 只做一件事：**给定一个 <video>，把整段的「人脸框序列」算出来**。
 * 检测结果的位置换算、插值、导出用的 sendcmd 全在 `shared/facefx.js`，
 * 这里不重复实现任何几何逻辑 —— 两边各写一份就是"预览跟得上、成片跟不上"。
 *
 * 三个绕不过去的实现约束（都踩过）：
 *
 * ① **必须自己构造 fileset**，不能把 `FilesetResolver` 本体传给
 *    `createFromOptions`：那样会抛 `ModuleFactory not set.`。正确形状是
 *    `{ wasmLoaderPath, wasmBinaryPath }`。
 * ② **加载器走 blob**：wasm 加载器由 MediaPipe 内部用 `createElement('script')`
 *    注入。若直接给它一个 `yjai-media://` 地址，就得把该协议放进 CSP 的
 *    `script-src` —— 而素材目录是用户可写的，等于开了"投放脚本"的口子。
 *    所以加载器源码用 `?raw` 打进 bundle，再转成 blob URL。
 * ③ **逐帧 seek，不靠播放**：靠 `timeupdate` 只能拿到"大致时间"，
 *    而导出要的是"这一帧的人脸在哪"，两者差一帧就是描边比脸慢半拍。
 *    逐帧 `currentTime = t` 然后等 `seeked`，慢但可复现 —— 同一段素材
 *    跑两次必须得到同一份 track，否则闸门没法断言。
 *
 * ⚠️ 检测是**采样**的（默认 12 fps），不是每一帧都算：
 *    1080p 逐帧 seek 解一次约 20~40ms，30fps 的 10 秒素材要 10 秒以上，
 *    而人脸在 1/12 秒内的位移远小于脸宽，中间帧由 `trackAt` 线性插值补。
 */
import { TRACK_FPS, boxOf, sampleTrack } from '../shared/facefx.js'

/** 检测用的最大边长：再大只会变慢，人脸框的位置精度已经够 */
const MAX_EDGE = 640

let runtimePromise = null

/**
 * 加载运行时（只加载一次）。
 *
 * @returns {Promise<{ FaceLandmarker:object, fileset:object }>}
 * @throws 运行时缺文件时抛出可读错误（缺哪个说哪个）
 */
export function loadFaceRuntime() {
  if (runtimePromise) return runtimePromise
  runtimePromise = (async () => {
    const rt = await window.yjai?.facefx?.runtime?.()
    if (!rt) throw new Error('主进程没有响应运行时查询')
    if (!rt.ok) {
      throw new Error(`人物特效运行时缺失：${(rt.missing || []).join('、') || '未知'}`)
    }
    /* 加载器源码由主进程读成文本（`@mediapipe/tasks-vision` 的 exports 不放行深路径，
       构建期导入会失败）。转成 blob 再注入，素材协议因此**不必**进 CSP 的 script-src。 */
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
  /* 失败要清掉缓存：否则一次"缺文件"会让后面每次点都拿到同一个 rejected promise，
     用户补上文件后仍然一直报错，只能重启应用 */
  runtimePromise.catch(() => {
    runtimePromise = null
  })
  return runtimePromise
}

/** 单个检测器实例（同一时刻只跑一段检测，不需要池化） */
let landmarker = null

async function ensureLandmarker() {
  if (landmarker) return landmarker
  const { vision, fileset, model } = await loadFaceRuntime()
  landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate: 'GPU' },
    runningMode: 'VIDEO',
    /* 两张脸就够：多人画面里判"主脸"用面积，第三张往后的框基本都在背景 */
    numFaces: 2
  })
  return landmarker
}

/** 释放检测器（切换项目/关闭面板时不必调，这里只在测试里用） */
export function disposeLandmarker() {
  try {
    landmarker?.close?.()
  } catch {
    /* 已经关了 */
  }
  landmarker = null
}

/**
 * 把 video 当前帧画进 canvas。返回实际使用的 canvas。
 *
 * 等比缩到 MAX_EDGE 以内：检测本身与人脸位置都是归一化的，
 * 缩放到哪里都不影响结果，只影响耗时。
 */
function drawFrame(video, canvas) {
  const vw = video.videoWidth || 0
  const vh = video.videoHeight || 0
  if (!vw || !vh) return null
  const k = Math.min(1, MAX_EDGE / Math.max(vw, vh))
  const w = Math.max(2, Math.round(vw * k))
  const h = Math.max(2, Math.round(vh * k))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  ctx.drawImage(video, 0, 0, w, h)
  return canvas
}

/** 等 seek 完成（带超时：某些容器 seek 到关键帧边界会不触发 seeked） */
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
 * 检测一段视频里出现过的最大人脸。
 *
 * @param {HTMLVideoElement} video 已挂上源、metadata 已就绪
 * @param {object} [opts]
 * @param {number} [opts.fps] 采样帧率，默认 TRACK_FPS
 * @param {number} [opts.start] 起点（秒），默认 0
 * @param {number} [opts.duration] 检测时长，默认视频全长
 * @param {(p:{done:number,total:number,found:number})=>void} [opts.onProgress]
 * @returns {Promise<{ track:number[][], found:number, total:number, truncated:boolean }>}
 */
export async function detectFaceTrack(video, opts = {}) {
  const fps = Math.max(2, Math.min(30, Number(opts.fps) || TRACK_FPS))
  const start = Math.max(0, Number(opts.start) || 0)
  const duration = Math.max(
    0.1,
    Number(opts.duration) || Math.max(0, (video.duration || 0) - start)
  )
  const detector = await ensureLandmarker()
  const canvas = document.createElement('canvas')

  const total = Math.max(1, Math.ceil(duration * fps))
  const frames = []
  let found = 0
  let truncated = false

  /* 记下播放状态：检测会大改 currentTime，结束后要还原成"用户原来看到的那一帧" */
  const prevTime = video.currentTime
  const prevPaused = video.paused
  try {
    for (let i = 0; i < total; i++) {
      const t = start + i / fps
      if (t > start + duration + 1e-6) break
      await seekTo(video, Math.min(t, start + duration))
      const frame = drawFrame(video, canvas)
      if (!frame) break
      const res = detector.detectForVideo(frame, Math.round(i * (1000 / fps)))
      const faces = res?.faceLandmarks || []
      /* 多人时取**面积最大**的那张：主脸不一定在中间，
         但一定比背景里的人脸大 —— 按顺序取第一张会在"路人靠近镜头"时跟错人 */
      let best = null
      for (const pts of faces) {
        const b = boxOf(pts)
        if (!b) continue
        if (!best || b.w * b.h > best.w * best.h) best = b
      }
      if (best) found += 1
      frames.push({ t: t - start, box: best })
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({ done: i + 1, total, found })
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

  const track = sampleTrack(frames)
  /* 一帧都没检到 ⇒ 不是"检测成功但零张脸"，而是这段素材用不了。
     上层据此给出"当前画面未检测到人脸"的提示，而不是写一个空 track 上去。 */
  if (!found) truncated = true
  return { track, found, total, truncated }
}
