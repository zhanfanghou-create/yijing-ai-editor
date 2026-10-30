import { useCallback, useEffect, useRef, useState } from 'react'
import {
  WHEEL_PRESETS,
  WHEEL_RANGES,
  applyPreset,
  hueOf,
  hueStops,
  isNeutral,
  readWheels
} from '../../shared/wheels.js'

/**
 * 一级色轮（阴影 / 中间调 / 高光 / 全局）。
 *
 * 交互与参考客户端一致：圆形色环上拖手柄定**方向与强度**（圆心 = 不动，外圈 = 满量程），
 * 环下方一条「亮度」滑杆定该段的明暗，双击复位。手柄方向 → 色相这件事在
 * `shared/wheels.js` 里算（`hueOf` / `vectorOf`），这里只负责"拖"与"画"。
 *
 * ⚠️ 手柄不在这里换算成 RGB —— 与曲线同一个道理：一维映射只写一次，
 *    预览的 SVG 表与导出的 ffmpeg 表达式都从那一份来。这里另算一份的结果是
 *    "色环里看是偏蓝、成片偏青"，不报错、也测不出来。
 *
 * ⚠️ 色环的 conic 停止点也来自 `shared/wheels.js` 的 `hueStops()`：
 *    屏幕角度（顺时针、从 12 点起算）与色相相差 90°，随手写 `hsl(h)` 会让
 *    "拖到蓝色那块"得到橙色 —— 画对了才叫色轮。
 */

/* 色环：色相每 30° 一格铺开，中心压暗成中性（手柄在圆心 = 不动画面） */
const RING = `radial-gradient(circle at 50% 50%, #17181b 0%, rgba(23,24,27,0) 68%), conic-gradient(${hueStops(30)
  .map((stop) => `hsl(${stop.h}deg 88% 55%) ${stop.t}deg`)
  .join(', ')})`

export default function ColorWheelEditor({ value, onChange }) {
  const wheels = readWheels(value)
  /* 哪一枚手柄在拖。空串 = 没在拖（闸门读这个钩子区分"没按下"与"按下了没跟手"） */
  const [dragKey, setDragKey] = useState('')
  const slotRefs = useRef({})
  const commitRef = useRef(null)

  commitRef.current = (key, patch) => {
    if (typeof onChange !== 'function') return
    onChange({ ...wheels, [key]: { ...wheels[key], ...patch } })
  }

  /**
   * 拖拽走 **window 上的 pointermove/pointerup**，不用 `setPointerCapture`。
   * 与颜色曲线同一个原因（2026-10-28 实测）：在元素上 setPointerCapture 之后，
   * 真机 E2E 的 `mouse.move` 仍然只派发给光标下的元素 —— 表现是"按下去了、拖了没动"。
   * 窗口监听还能让手柄拖出面板边缘时继续跟手。
   */
  const dragKeyRef = useRef(dragKey)
  dragKeyRef.current = dragKey
  useEffect(() => {
    if (!dragKey) return undefined
    const move = (event) => {
      const key = dragKeyRef.current
      const box = slotRefs.current[key] && slotRefs.current[key].getBoundingClientRect()
      if (!key || !box || !box.width) return
      /* 圆心为原点、半径归一：右 x、上 y（屏幕 y 向下，所以取负） */
      commitRef.current(key, {
        x: ((event.clientX - box.left) / box.width - 0.5) * 2,
        y: (0.5 - (event.clientY - box.top) / box.height) * 2
      })
    }
    const stop = () => setDragKey('')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragKey])

  const onDown = useCallback(
    (key) => (event) => {
      if (event.button !== undefined && event.button !== 0) return
      const box = slotRefs.current[key] && slotRefs.current[key].getBoundingClientRect()
      if (!box || !box.width) return
      /* 按下那一下就把手柄挪到位：一次手势完成"点哪拖哪"，
         不用先精确点在旧手柄上（参考客户端也是这样） */
      commitRef.current(key, {
        x: ((event.clientX - box.left) / box.width - 0.5) * 2,
        y: (0.5 - (event.clientY - box.top) / box.height) * 2
      })
      setDragKey(key)
    },
    []
  )

  const resetOne = useCallback(
    (key) => () => {
      if (typeof onChange !== 'function') return
      onChange({ ...wheels, [key]: { x: 0, y: 0, level: 0 } })
    },
    [onChange, wheels]
  )

  return (
    <div
      className="wb-wheels"
      data-wheel-editor="1"
      data-wheel-neutral={isNeutral(wheels) ? '1' : '0'}
      data-wheel-drag={dragKey}
    >
      <div className="wb-wheel-presets">
        {WHEEL_PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className="wb-lookchip"
            data-wheel-preset={preset.key}
            title={`套用「${preset.label}」色轮`}
            onClick={() => {
              if (typeof onChange === 'function') onChange(applyPreset(wheels, preset.key))
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="wb-wheel-grid">
        {WHEEL_RANGES.map((range) => {
          const wheel = wheels[range.key]
          const radius = Math.min(1, Math.hypot(wheel.x, wheel.y))
          return (
            <div className="wb-wheel" key={range.key} data-wheel={range.key}>
              <div className="wb-wheel-head">
                <span>{range.label}</span>
                <em>{wheel.level > 0 ? `+${wheel.level}` : wheel.level}</em>
              </div>
              <div
                className={`wb-wheel-slot${dragKey === range.key ? ' on' : ''}`}
                ref={(el) => {
                  slotRefs.current[range.key] = el
                }}
                data-wheel-slot={range.key}
                data-wheel-x={wheel.x.toFixed(3)}
                data-wheel-y={wheel.y.toFixed(3)}
                style={{ background: RING }}
                title="拖动定方向与强度 · 双击复位"
                onPointerDown={onDown(range.key)}
                onDoubleClick={resetOne(range.key)}
              >
                {/* 十字基准线：圆心 = 不动画面，没有这两条线就看不出手柄偏了多少 */}
                <span className="wb-wheel-axis" aria-hidden="true" />
                <span
                  className="wb-wheel-puck"
                  data-wheel-puck={range.key}
                  style={{
                    left: `${50 + wheel.x * 50}%`,
                    top: `${50 - wheel.y * 50}%`,
                    background: radius < 0.02 ? '#c9ccd4' : `hsl(${hueOf(wheel.x, wheel.y)}deg 90% 62%)`
                  }}
                />
              </div>
              <input
                type="range"
                className="wb-wheel-level"
                min={-100}
                max={100}
                step={1}
                value={wheel.level}
                data-wheel-level={range.key}
                title={`${range.label}亮度`}
                onChange={(event) => commitRef.current(range.key, { level: Number(event.target.value) })}
              />
            </div>
          )
        })}
      </div>

      <div className="wb-wheel-foot">
        <span>拖色环定方向与强度 · 双击复位</span>
        <button
          type="button"
          className="wb-ccurve-all"
          data-wheel-clear="1"
          onClick={() => {
            if (typeof onChange === 'function') onChange({})
          }}
        >
          全部复位
        </button>
      </div>
    </div>
  )
}
