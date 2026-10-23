import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CURVE_POINTS_MAX, SPEED_MAX, SPEED_MIN, curveMean, normalizeCurve } from '../../shared/speed.js'

/**
 * 曲线变速编辑器。
 *
 * 一块 0→1 的横轴（片段进度）配一条对数纵轴（速率 0.25x–4x）。
 * 为什么**纵轴取对数**：线性轴下 0.25 与 1 之间挤在底部四分之一，
 * 而变速曲线用得最多的恰恰是 "0.3x ↔ 1x" 这一段 —— 线性轴根本拖不准；
 * 对数轴上 0.5x 正好落在中间偏下一格，1x 在正中，2x/4x 等距，手感与视觉一致。
 *
 * 为什么**横轴是进度不是秒**：进度让曲线与片段长度解耦 —— 片段被拖动、被修剪、
 * 换了倍速之后曲线形状仍然是用户画的那条，而按秒存的曲线会在每次修剪后"自己变形"。
 *
 * 交互（三条，都要能在真机上验）：
 *   · 拖手柄 —— 横向改 p、纵向改 v，自动夹在左右邻居之间（越过去会让曲线交叉）；
 *   · 点空白 —— 在鼠标位置插一个新点；
 *   · 双击手柄 —— 删掉这个点（首尾两点不能删，删了曲线就覆盖不满整段）。
 *
 * ⚠️ 手柄的命中区比画出来的圆大：`<circle r=5>` 挂在 11px 的透明命中圆上，
 *    否则 4x 附近的点在真机上要瞄准半天（小圆点是最典型的"看着能用、实际点不中"）。
 */
export default function CurveEditor({ points, onChange, height = 132, hook = 'curve', disabled = false }) {
  const boxRef = useRef(null)
  const [box, setBox] = useState({ w: 300, h: height })
  const [dragging, setDragging] = useState(-1)
  const [hover, setHover] = useState(-1)

  /** 规范化后的点（渲染用）。规范化必须与导出/预览**同一个函数**，否则看到的形状不是会生效的形状 */
  const list = normalizeCurve(points) || [
    { p: 0, v: 1 },
    { p: 1, v: 1 }
  ]

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    const measure = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0) setBox({ w: Math.round(rect.width), h: height })
    }
    measure()
    /* 容器宽度会变（右栏可拖、窗口可缩放）。没有这一步，曲线在窄栏里会被拉扁 ——
       而 SVG 会照旧"画出来"，只是手柄的位置与鼠标对不上，看起来像"拖不动"。 */
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    if (observer) observer.observe(el)
    return () => {
      if (observer) observer.disconnect()
    }
  }, [height])

  const padX = 10
  const padY = 9
  const innerW = Math.max(40, box.w - padX * 2)
  const innerH = Math.max(30, box.h - padY * 2)
  const logMin = Math.log2(SPEED_MIN)
  const logMax = Math.log2(SPEED_MAX)
  const toX = useCallback((p) => padX + Math.min(1, Math.max(0, p)) * innerW, [innerW, padX])
  const toY = useCallback(
    (v) => padY + innerH - ((Math.log2(Math.min(SPEED_MAX, Math.max(SPEED_MIN, v))) - logMin) / (logMax - logMin)) * innerH,
    [innerH, logMax, logMin, padY]
  )
  const fromX = useCallback(
    (x) => Math.min(1, Math.max(0, (x - padX) / innerW)),
    [innerW, padX]
  )
  const fromY = useCallback(
    (y) => {
      const ratio = 1 - Math.min(1, Math.max(0, (y - padY) / innerH))
      return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.pow(2, logMin + ratio * (logMax - logMin))))
    },
    [innerH, logMax, logMin, padY]
  )

  /** 发出一份新的点列（统一保留 4 位小数，避免拖拽产生一长串浮点尾巴进草稿 JSON） */
  const emit = (next) => {
    if (typeof onChange !== 'function') return
    onChange(next.map((point) => [Number(point.p.toFixed(4)), Number(point.v.toFixed(3))]))
  }

  const pointFromEvent = (event) => {
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return { p: 0, v: 1 }
    return {
      p: fromX(event.clientX - rect.left),
      v: fromY(event.clientY - rect.top)
    }
  }

  useEffect(() => {
    if (dragging < 0) return undefined
    const move = (event) => {
      const { p, v } = pointFromEvent(event)
      const next = list.map((point) => ({ ...point }))
      const index = Math.min(next.length - 1, Math.max(0, dragging))
      if (index === 0) next[0] = { p: 0, v }
      else if (index === next.length - 1) next[index] = { p: 1, v }
      else {
        /* 夹在左右邻居之间：曲线必须是"函数"（一个 p 只能有一个 v），
           让它越过去只会得到一条回头的折线，插值与导出都会算出负的 Δp */
        const left = next[index - 1].p + 0.005
        const right = next[index + 1].p - 0.005
        next[index] = { p: Math.min(right, Math.max(left, p)), v }
      }
      emit(next)
    }
    const stop = () => setDragging(-1)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  })

  /** 画曲线：按规范化后的点逐段取两端就够了 —— 分段线性，采样再多也是同一条折线 */
  const pathD = list
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${toX(point.p).toFixed(1)},${toY(point.v).toFixed(1)}`)
    .join(' ')
  /* 曲线下的填充：补到基线（0.25x 那一行），让"面积 = 平均速率"这件事看得出来 */
  const areaD = `${pathD} L${toX(1).toFixed(1)},${toY(SPEED_MIN).toFixed(1)} L${toX(0).toFixed(1)},${toY(SPEED_MIN).toFixed(1)} Z`
  const mean = curveMean(list)

  return (
    <div className={`wb-curve${disabled ? ' is-off' : ''}`} ref={boxRef} data-curve={hook}>
      <svg width={box.w} height={box.h} role="img" aria-label="变速曲线">
        {/* 参考线：1x 与 2x / 0.5x。有了这几条，"这条曲线整体是快还是慢"一眼可读 */}
        {[0.25, 0.5, 1, 2, 4].map((value) => (
          <g key={value}>
            <line
              x1={padX}
              x2={padX + innerW}
              y1={toY(value)}
              y2={toY(value)}
              className={Math.abs(value - 1) < 0.001 ? 'wb-curve-base' : 'wb-curve-grid'}
            />
            <text x={padX + 2} y={toY(value) - 3} className="wb-curve-tick">
              {value}x
            </text>
          </g>
        ))}
        <path d={areaD} className="wb-curve-area" />
        <path d={pathD} className="wb-curve-line" data-curve-path={hook} />
        {/* 空白处点击加点。挂在 rect 上而不是 svg 上：svg 上有手柄，点手柄时不该加点 */}
        <rect
          x={0}
          y={0}
          width={box.w}
          height={box.h}
          className="wb-curve-hit"
          onPointerDown={(event) => {
            if (disabled || dragging >= 0) return
            if (list.length >= CURVE_POINTS_MAX) return
            const { p, v } = pointFromEvent(event)
            if (p <= 0.01 || p >= 0.99) return
            const next = [...list, { p, v }].sort((a, b) => a.p - b.p)
            emit(next)
          }}
        />
        {list.map((point, index) => {
          const edge = index === 0 || index === list.length - 1
          return (
            <g key={`${index}-${point.p.toFixed(3)}`}>
              <circle
                cx={toX(point.p)}
                cy={toY(point.v)}
                r={11}
                className="wb-curve-grab"
                data-curve-handle={index}
                onPointerDown={(event) => {
                  if (disabled) return
                  event.stopPropagation()
                  setDragging(index)
                }}
                onPointerEnter={() => setHover(index)}
                onPointerLeave={() => setHover((current) => (current === index ? -1 : current))}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  if (disabled || edge || list.length <= 3) return
                  emit(list.filter((_item, at) => at !== index))
                }}
              />
              <circle
                cx={toX(point.p)}
                cy={toY(point.v)}
                r={hover === index || dragging === index ? 5 : 4}
                className={`wb-curve-point${edge ? ' is-edge' : ''}`}
              />
            </g>
          )
        })}
      </svg>
      <div className="wb-curve-foot">
        {/* data-curve-mean：闸门读这里验证「面板显示的平均倍速 = 真源算出的面积」 */}
        <span>
          平均 <b data-curve-mean="1">{mean.toFixed(2)}x</b>
        </span>
        <span className="wb-curve-hint">拖点改速度 · 点空白加点 · 双击删点</span>
      </div>
    </div>
  )
}
