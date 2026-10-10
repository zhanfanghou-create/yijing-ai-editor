/**
 * 分隔条：工作台各区域之间的拖拽把手。
 *
 * 交互口径（对齐主流剪辑软件的通用做法，纯自绘实现）：
 *   · 竖直条调列宽（光标 col-resize），水平条调行高（row-resize）；
 *   · 按下后用 setPointerCapture 捕获指针，移动增量上报给宿主（App 统一钳制）；
 *   · 双击 = 该区域恢复默认尺寸；
 *   · 键盘可达：聚焦后方向键微调（10px），Home 回默认 —— 不依赖鼠标也能用。
 *
 * 把增量（而不是目标值）上报给宿主：值域钳制、变量命名都是 App 的事，
 * 这个组件只管"拖动了多少"。
 */
import { useRef, useState } from 'react'

export default function Splitter({ dir = 'v', which, title, onDelta, onReset, onNudge }) {
  const drag = useRef(null)
  const [active, setActive] = useState(false)

  const begin = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    drag.current =
      dir === 'v'
        ? { x: event.clientX, y: event.clientY }
        : { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
    setActive(true)
  }

  const move = (event) => {
    if (!drag.current) return
    const dx = event.clientX - drag.current.x
    const dy = event.clientY - drag.current.y
    drag.current = { x: event.clientX, y: event.clientY }
    /* 竖直条：右拖 = 后一列更宽（dx>0）；水平条：下拖 = 时间线更高（dy>0）。
       语义方向由宿主决定，这里原样上报。 */
    onDelta && onDelta(dir === 'v' ? dx : dy)
  }

  const end = (event) => {
    if (!drag.current) return
    drag.current = null
    setActive(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* 指针已释放，忽略 */
    }
  }

  const key = (event) => {
    if (!onNudge) return
    const step = event.shiftKey ? 40 : 10
    /* ⚠️ 方向键表先算好再 includes —— 不能写成 `dir === 'v' ? [表A] : [表B].includes(key)`：
       三元会让 v 分支整个表达式变成**数组本身**（恒真），任何不匹配的键
       （Shift、Ctrl……）都会触发一次反向 nudge，键盘微调从此错乱。 */
    const forward = dir === 'v' ? ['ArrowRight', 'ArrowDown'] : ['ArrowDown', 'ArrowRight']
    const backward = dir === 'v' ? ['ArrowLeft', 'ArrowUp'] : ['ArrowUp', 'ArrowLeft']
    if (forward.includes(event.key)) {
      event.preventDefault()
      onNudge(step)
    } else if (backward.includes(event.key)) {
      event.preventDefault()
      onNudge(-step)
    } else if (event.key === 'Home') {
      event.preventDefault()
      onReset && onReset()
    }
  }

  return (
    <div
      className={`wb-splitter is-${dir} ${active ? 'is-dragging' : ''}`}
      data-splitter={which}
      role="separator"
      aria-orientation={dir === 'v' ? 'vertical' : 'horizontal'}
      aria-label={title}
      title={`${title}（拖动调整，双击复位）`}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={key}
    />
  )
}
