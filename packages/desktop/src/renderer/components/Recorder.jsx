import { useCallback, useEffect, useRef, useState } from 'react'
import { IconClose, IconMic } from '../icons.jsx'
import { isDesktop } from '../platform.js'
import { timecode } from '../ui.jsx'

/**
 * 录音配音。
 *
 * 三件事必须在**同一个控件**里闭环，否则用户只会看到"点了没反应"：
 *   ① 真的拿到麦克风（getUserMedia）。主进程那边有一道权限闸，只放行音频
 *      （见 main/index.js 的 setPermissionRequestHandler 注释）；
 *   ② 真的在录（MediaRecorder），并且**看得见在录** —— 计时器 + 电平条。
 *      没有这两样，用户不确定自己有没有在说话，录出来才发现全是静音；
 *   ③ 真的落了盘、真的变成了音频轨上一个片段（落盘在主进程，见 recording:save）。
 *
 * MediaRecorder 优先选 `audio/webm;codecs=opus`：体积小、ffmpeg 直接吃，
 * 波形峰值（主进程抽 PCM）也走得通。容器不支持时退回默认 mime，
 * 扩展名由主进程按 mime 决定，两边不各猜一套。
 *
 * ⚠️ 时长取「按下开始 → 按下停止」的墙钟时间，不读 `blob.duration`：
 *    MediaRecorder 产的 webm 头里没有时长，`<audio>` 读到的是 Infinity。
 *    这个数直接决定新片段在时间线上占多长 —— 读错就是"录了 5 秒、占位 0 秒"。
 */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']

export default function Recorder({ open = false, onClose, onRecorded, onBusyChange }) {
  /** 'idle' | 'recording' | 'saving' */
  const [phase, setPhase] = useState('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState('')
  const [error, setError] = useState('')

  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const ctxRef = useRef(null)
  const rafRef = useRef(0)
  const timerRef = useRef(0)
  const startAtRef = useRef(0)

  const bridge = isDesktop && typeof window !== 'undefined' ? window.yjai : null

  /** 把设备相关的资源全部放掉（轨道不 stop 的话，麦克风指示灯会一直亮着） */
  const releaseMedia = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = 0
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    const stream = streamRef.current
    streamRef.current = null
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          /* 已经停了 */
        }
      }
    }
    const ctx = ctxRef.current
    ctxRef.current = null
    if (ctx && typeof ctx.close === 'function') Promise.resolve(ctx.close()).catch(() => {})
    setLevel(0)
  }, [])

  /* 关闭 / 卸载时一定要放掉麦克风：漏一次，用户下次会看到"设备被占用" */
  useEffect(() => {
    if (open) return undefined
    const rec = recorderRef.current
    recorderRef.current = null
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch {
        /* 已经停了 */
      }
    }
    releaseMedia()
    setPhase('idle')
    setElapsed(0)
    setError('')
    return undefined
  }, [open, releaseMedia])

  useEffect(() => () => releaseMedia(), [releaseMedia])

  /* 打开面板时列一次输入设备。未授权前 label 是空的 —— 这时给"麦克风 1/2…"，
     不给一串空白选项（空白选项会让人以为是设备坏了）。 */
  useEffect(() => {
    if (!open || typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return undefined
    let alive = true
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        if (!alive) return
        const inputs = list
          .filter((item) => item.kind === 'audioinput')
          .map((item, index) => ({ id: item.deviceId, label: item.label || `麦克风 ${index + 1}` }))
        setDevices(inputs)
        setDeviceId((current) => current || (inputs[0] ? inputs[0].id : ''))
      })
      .catch(() => {
        if (alive) setDevices([])
      })
    return () => {
      alive = false
    }
  }, [open])

  const start = useCallback(async () => {
    if (!bridge?.recorder) {
      setError('录音需要在桌面客户端里运行')
      return
    }
    setError('')
    try {
      /* ⚠️ 约束里只给 audio：带上任何 video 约束，主进程的权限闸会整条拒掉
         （见 main/index.js —— 那是故意的，不给"顺手开摄像头"留缝）。 */
      const constraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream

      /* 电平条：AnalyserNode 读时域 RMS。它不是"装饰"—— 用户靠它判断
         "是不是录到了声音"，而录音最常见的失败就是录到一片静音。 */
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        ctxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        const buffer = new Uint8Array(analyser.fftSize)
        const tick = () => {
          analyser.getByteTimeDomainData(buffer)
          let sum = 0
          for (const value of buffer) {
            const centered = (value - 128) / 128
            sum += centered * centered
          }
          setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 4))
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
      } catch {
        /* 拿不到 AudioContext 也要能录 —— 电平条只是反馈，不是录音本身 */
        setLevel(0)
      }

      const mimeType = MIME_CANDIDATES.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunksRef.current.push(event.data)
      }
      recorder.onerror = (event) => {
        setError(`录音出错：${(event && event.error && event.error.message) || '未知原因'}`)
        releaseMedia()
        setPhase('idle')
      }
      recorderRef.current = recorder
      recorder.start(200)
      startAtRef.current = performance.now()
      setElapsed(0)
      setPhase('recording')
      timerRef.current = setInterval(() => {
        setElapsed(Math.max(0, (performance.now() - startAtRef.current) / 1000))
      }, 100)
    } catch (err) {
      releaseMedia()
      setPhase('idle')
      const name = String((err && err.name) || '')
      setError(
        name === 'NotAllowedError'
          ? '没有拿到麦克风权限：系统的「隐私 → 麦克风」里允许本应用，再点一次开始录音'
          : name === 'NotFoundError'
            ? '没有找到可用的麦克风设备'
            : `打不开麦克风：${(err && err.message) || name || '未知原因'}`
      )
    }
  }, [bridge, deviceId, releaseMedia])

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    const duration = Math.max(0, (performance.now() - startAtRef.current) / 1000)
    setPhase('saving')
    recorder.onstop = async () => {
      const chunks = chunksRef.current
      chunksRef.current = []
      recorderRef.current = null
      releaseMedia()
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      if (!blob.size) {
        setError('没有录到内容：确认麦克风没有被别的程序占用')
        setPhase('idle')
        return
      }
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const result = await bridge.recorder.save({ bytes, mime: blob.type, duration })
        if (!result || !result.ok) {
          setError((result && result.error) || '保存失败')
          setPhase('idle')
          return
        }
        /* 交给 App 落成片段：素材入库 + 音频轨在**播放头**处插一段。
           录音不放在"轨道末尾"—— 配音是"对着画面说"，落点必须是当前播放头。 */
        if (onRecorded) onRecorded(result.asset, duration)
        setPhase('idle')
        setElapsed(0)
        if (onClose) onClose()
      } catch (err) {
        setError(`保存失败：${(err && err.message) || '未知原因'}`)
        setPhase('idle')
      }
    }
    try {
      recorder.stop()
    } catch (err) {
      setError(`停止录音失败：${(err && err.message) || '未知原因'}`)
      releaseMedia()
      setPhase('idle')
    }
  }, [bridge, onClose, onRecorded, releaseMedia])

  const recording = phase === 'recording'
  const saving = phase === 'saving'

  /* 把"正忙"透给 App：Esc / 关面板这类"看起来无害"的动作用它挡住 —— 
     录音中关掉面板会连麦克风一起放掉，用户以为录好了，其实什么都没有。 */
  useEffect(() => {
    if (typeof onBusyChange === 'function') onBusyChange(recording || saving)
  }, [recording, saving, onBusyChange])

  if (!open) return null

  return (
    <div className="mask" onClick={(event) => event.target === event.currentTarget && !recording && !saving && onClose && onClose()}>
      <div className="modal" style={{ width: 420, maxWidth: '92vw' }} data-recorder="1" data-rec-phase={phase}>
        <header>
          <div>
            <h3>录音配音</h3>
            <p>对着画面说，录完会作为音频片段落在播放头处。</p>
          </div>
          <button type="button" onClick={() => onClose && onClose()} aria-label="关闭" disabled={saving}>
            <IconClose size={14} />
          </button>
        </header>

        <div className="modal-body" style={{ padding: '14px 16px 18px' }}>
          <div className="field">
            <span>输入设备</span>
            <select
              className="select"
              data-rec-device="1"
              value={deviceId}
              disabled={recording || saving}
              onChange={(event) => setDeviceId(event.target.value)}
            >
              {devices.length ? (
                devices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))
              ) : (
                <option value="">默认麦克风</option>
              )}
            </select>
          </div>

          {/* 计时 + 电平：录音时最要紧的两个反馈，缺一个都会让人怀疑"到底有没有在录" */}
          <div className="wb-rec-meter" data-rec-meter="1">
            <div className="wb-rec-time" data-rec-timer={Number(elapsed.toFixed(2))}>
              {timecode(elapsed, false)}
            </div>
            <div className="wb-rec-bars" aria-hidden="true">
              {Array.from({ length: 18 }).map((_, index) => {
                const lit = recording && level * 18 > index
                return <i key={index} className={lit ? 'on' : ''} data-rec-bar={lit ? 'on' : 'off'} />
              })}
            </div>
          </div>

          <div className="wb-rec-actions">
            {recording ? (
              <button type="button" className="btn" data-rec-btn="stop" onClick={stop}>
                停止录音
              </button>
            ) : (
              <button type="button" className="btn" data-rec-btn="start" onClick={start} disabled={saving}>
                <IconMic size={14} />
                {saving ? '正在保存…' : '开始录音'}
              </button>
            )}
          </div>

          {error ? (
            <p className="wb-insphint" data-rec-error="1" style={{ color: 'var(--warn, #e8b04b)' }}>
              {error}
            </p>
          ) : (
            <p className="wb-insphint" data-rec-hint="1">
              录音会存进项目的配音目录，并作为音频素材入素材库；
              落点由播放头决定，想重新对齐就把播放头挪过去再录一条。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
