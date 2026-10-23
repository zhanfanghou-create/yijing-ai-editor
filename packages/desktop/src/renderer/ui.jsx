/** 通用 UI 原语：轻提示、弹窗、表单字段 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { IconClose } from './icons.jsx'

/* ------------------------------- 轻提示 ------------------------------- */

const ToastContext = createContext(() => {})

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const seq = useRef(0)

  const push = useCallback((message, tone = '') => {
    const id = ++seq.current
    setItems((list) => [...list, { id, message, tone }])
    setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), 3400)
  }, [])

  const api = useMemo(() => Object.assign(push, { good: (m) => push(m, 'good'), bad: (m) => push(m, 'bad') }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-wrap">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.tone}`} role="status">
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

/* -------------------------------- 弹窗 -------------------------------- */

export function Modal({ title, desc, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="mask" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <h3>{title}</h3>
            {desc ? <p>{desc}</p> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <IconClose size={14} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

/* -------------------------------- 字段 -------------------------------- */

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>
        {label}
        {hint ? <em>{hint}</em> : null}
      </span>
      {children}
    </label>
  )
}

/**
 * @param {(value:number)=>string} [format] 数值怎么显示。
 *   倍速这类小数滑杆要用它（0.25x 显示成 "0.25x" 而不是 "0.2500000001x"），
 *   不传就按「原值 + suffix」显示，与以前逐字相同。
 */
export function Slider({ label, value, suffix = '', min = 0, max = 100, step = 1, format, onChange, hook }) {
  return (
    <div className="slider-row">
      <label>
        {label}
        <em>{format ? format(value) : `${value}${suffix}`}</em>
      </label>
      {/* `data-slider`：滑杆的稳定钩子。
          与 `data-insp-num`（数值输入框）同一套命名 —— 闸门/E2E 断言"滑杆真的把值写出去了"
          时读这个，而不是按标签文字找元素（文案一改，测试就全都找不到）。 */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-slider={hook}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

/* ------------------------------ 时间格式 ------------------------------ */

/** 秒 → 00:00:00.0（剪辑软件惯例的时间码） */
export function timecode(seconds, withFrames = true) {
  const total = Math.max(0, Number(seconds) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const f = Math.floor((total % 1) * 10)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}${withFrames ? `.${f}` : ''}`
}

/**
 * 帧号格式时间码 `HH:MM:SS:FF`（片段头上用的那种）。
 * 与 timecode() 的区别：末尾是**帧号**（30 帧/秒）而不是十分之一秒，
 * 与剪辑软件里「片段时长 00:00:43:01」的形制一致。
 */
export function timecodeFrames(seconds, fps = 30) {
  const total = Math.max(0, Number(seconds) || 0)
  const rate = Number(fps) > 0 ? Number(fps) : 30
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const f = Math.floor((total % 1) * rate)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`
}
