import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CURVE_CHANNELS, NEUTRAL_POINTS, isNeutral, lutOf, movePoint, readCurves } from '../../shared/curves.js'

/**
 * 颜色曲线编辑器（RGB / 红 / 绿 / 蓝 四条）。
 *
 * ⚠️ 与 `CurveEditor.jsx`（**变速**曲线）是两件事，命名与样式前缀都刻意分开
 *    （`wb-ccurve*` / `data-ccurve-*`）：变速曲线横轴是"片段进度"、纵轴是对数速率；
 *    颜色曲线横轴是输入亮度、纵轴是输出亮度，恒等时是一条 45° 直线。
 *
 * 交互与参考客户端一致：
 *   · 空白处单击 → 加点；拖控制点 → 改形状；右键点控制点 → 删点；
 *   · 两个端点只能**上下**移动（左端点压黑、右端点提白），左右钉在 0 / 1 ——
 *     端点能左右滑的话曲线就盖不满 0..255，中间那段没有映射，只能瞎补。
 *
 * 曲线**不在这里算**：控制点 → 256 项查找表全在 `shared/curves.js`，
 * 预览的 SVG 表与导出的 ffmpeg 串都从那一份来。这里只负责"拖"和"画"。
 */

const SIZE = 100
const toPx = (x, y) => [x * SIZE, (1 - y) * SIZE]

/** 把 256 项查找表画成折线（画出来的就是真正生效的那条表，不是另画的贝塞尔） */
function pathOf(points) {
  const lut = lutOf(points)
  const step = SIZE / (lut.length - 1)
  return lut.map((v, i) => `${(i * step).toFixed(2)},${((1 - v) * SIZE).toFixed(2)}`).join(' ')
}

export default function ColorCurveEditor({ value, onChange }) {
  const curves = readCurves(value)
  const [channel, setChannel] = useState('rgb')
  const [dragIndex, setDragIndex] = useState(-1)
  const svgRef = useRef(null)

  const points = curves[channel]
  const polylines = useMemo(
    () => CURVE_CHANNELS.map((item) => ({ ...item, path: pathOf(curves[item.key]) })),
    [curves]
  )

  /**
   * 拖拽靠 **window 上的 pointermove/pointerup**，不用 `setPointerCapture`。
   *
   * 为什么（2026-10-28 实测）：在 SVG 元素上 setPointerCapture 之后，真机 E2E 的
   * `mouse.move` 仍然只把事件派发给光标下的元素 —— 于是"点下去加了点、拖了没动"，
   * 那个点永远停在 0.5/0.5，看起来像"曲线不跟手"。窗口监听没有这个问题，
   * 而且指针移出画布（拖到面板外）时也能继续拖，手感更接近参考客户端。
   *
   * ⚠️ 监听里必须读 ref 里的**当前**点列：闭包里的 `points` 是按下那一刻的旧数组，
   *    拖到第二帧就会把刚加的点又丢掉一次。回调本身也走 ref，
   *    否则每次 onChange 都会重建监听（拖拽中途重新订阅会漏事件）。
   */
  const pointsRef = useRef(points)
  pointsRef.current = points
  const commitRef = useRef(null)
  commitRef.current = (next) => {
    if (typeof onChange === 'function') onChange({ ...curves, [channel]: next })
  }

  useEffect(() => {
    if (dragIndex < 0) return undefined
    const move = (event) => {
      const box = svgRef.current && svgRef.current.getBoundingClientRect()
      if (!box || !box.width) return
      const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
      const y = Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height))
      commitRef.current(movePoint(pointsRef.current, dragIndex, x, y))
    }
    const stop = () => setDragIndex(-1)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragIndex])

  const setPoints = useCallback(
    (next) => {
      if (typeof onChange === 'function') onChange({ ...curves, [channel]: next })
    },
    [channel, curves, onChange]
  )

  const onSurfaceDown = useCallback(
    (event) => {
      /* 点到控制点时由控制点自己的 pointerdown 处理，这里只管空白处加点 */
      if (event.target?.dataset && event.target.dataset.ccurvePoint !== undefined) return
      const box = svgRef.current && svgRef.current.getBoundingClientRect()
      if (!box || !box.width) return
      const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
      const y = Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height))
      const next = [...points]
      let index = next.findIndex((point) => point.x > x)
      if (index < 0) index = next.length - 1
      if (index <= 0) index = 1
      next.splice(index, 0, { x, y })
      setPoints(next)
      /* 新加的点直接进入拖拽态：一次手势就能"加 + 摆到位" */
      setDragIndex(index)
    },
    [points, setPoints]
  )

  const onPointDown = useCallback(
    (index) => (event) => {
      event.stopPropagation()
      setDragIndex(index)
    },
    []
  )

  const removePoint = useCallback(
    (index) => (event) => {
      event.preventDefault()
      event.stopPropagation()
      /* 端点不许删：删了曲线就盖不满 0..1 */
      if (index === 0 || index === points.length - 1) return
      setPoints(points.filter((_, at) => at !== index))
    },
    [points, setPoints]
  )

  return (
    <div
      className="wb-ccurve"
      data-ccurve-editor="1"
      data-ccurve-neutral={isNeutral(curves) ? '1' : '0'}
      /* 拖拽态挂成属性：闸门读它就能分辨"没按下" / "按下了但没跟手"两种失败 */
      data-ccurve-drag={dragIndex < 0 ? '' : String(dragIndex)}
    >
      <div className="wb-ccurve-tabs" role="tablist" aria-label="曲线通道">
        {CURVE_CHANNELS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={channel === item.key}
            className={`wb-ccurve-tab${channel === item.key ? ' on' : ''}`}
            style={{ '--ccurve-color': item.color }}
            data-ccurve-tab={item.key}
            onClick={() => setChannel(item.key)}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className="wb-ccurve-tab is-reset"
          data-ccurve-reset="1"
          title="把这条曲线恢复成直线"
          onClick={() => setPoints(NEUTRAL_POINTS.map((point) => ({ ...point })))}
        >
          归直
        </button>
      </div>

      <div className="wb-ccurve-box">
        <svg
          ref={svgRef}
          className="wb-ccurve-svg"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          preserveAspectRatio="none"
          data-ccurve-surface={channel}
          onPointerDown={onSurfaceDown}
        >
          <g className="wb-ccurve-grid">
            <line x1="25" y1="0" x2="25" y2="100" />
            <line x1="50" y1="0" x2="50" y2="100" />
            <line x1="75" y1="0" x2="75" y2="100" />
            <line x1="0" y1="25" x2="100" y2="25" />
            <line x1="0" y1="50" x2="100" y2="50" />
            <line x1="0" y1="75" x2="100" y2="75" />
            {/* 恒等基准线：判断"这一版是提亮还是压暗"靠它 */}
            <line className="base" x1="0" y1="100" x2="100" y2="0" />
          </g>
          {/* 其它改过的通道用淡色底纹画出来，方便对照（选哪条由页签决定） */}
          {polylines
            .filter((item) => item.key !== channel && !isNeutral(curves[item.key]))
            .map((item) => (
              <polyline
                key={`ghost-${item.key}`}
                className="wb-ccurve-ghost"
                style={{ stroke: item.color }}
                points={item.path}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          <polyline
            className="wb-ccurve-line"
            style={{ stroke: CURVE_CHANNELS.find((item) => item.key === channel)?.color }}
            points={polylines.find((item) => item.key === channel)?.path}
            data-ccurve-path={channel}
            vectorEffect="non-scaling-stroke"
          />
          {points.map((point, index) => {
            const [cx, cy] = toPx(point.x, point.y)
            return (
              <circle
                key={`${channel}-${index}`}
                className={`wb-ccurve-point${dragIndex === index ? ' on' : ''}`}
                cx={cx}
                cy={cy}
                r={2.8}
                data-ccurve-point={index}
                onPointerDown={onPointDown(index)}
                onContextMenu={removePoint(index)}
              />
            )
          })}
        </svg>
      </div>

      <div className="wb-ccurve-foot">
        <span>单击加点 · 拖动改形 · 右键删点</span>
        <button
          type="button"
          className="wb-ccurve-all"
          data-ccurve-clear="1"
          onClick={() => {
            if (typeof onChange === 'function') onChange({})
            setChannel('rgb')
          }}
        >
          全部归直
        </button>
      </div>
    </div>
  )
}
