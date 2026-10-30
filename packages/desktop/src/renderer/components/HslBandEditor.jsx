import { useState } from 'react'
import { BANDS, bandActive, readBands } from '../../shared/hslBands.js'
import { Slider } from '../ui.jsx'

/**
 * 分区 HSL 面板：八个色带各有一组「色相 / 饱和度 / 亮度」。
 *
 * 为什么是"先选色带、再拖三根滑杆"，而不是 24 根滑杆平铺：
 * 剪辑台上调色是**针对一个颜色**解决问题（"肤色太黄"、"天空太青"），
 * 一次只该看一个带。平铺 24 根滑杆的话，用户要先在脑子里记住哪三根是"黄"。
 *
 * ⚠️ 色带按钮上的那个小圆点（`data-hsl-dirty`）不是装饰：24 个参数、
 *    只显示当前带的三根滑杆时，用户很容易忘了"橙带还留着昨天的 +30"。
 *    圆点标出**哪些带被调过**，配合分节标题上的"已修改"标记，能一眼看出该不该整体重置。
 *
 * ⚠️ 幅度 100 = 满量程，但三根滑杆的"满量程"不是同一个物理量（见 shared/hslBands.js
 *    的 applyBands 注释：色相 ±30°、饱和度是乘性、亮度带钟形衰减）。
 *    界面上统一成 ±100 只是为了让手感一致，不是"三个都是同一回事"。
 */
export default function HslBandEditor({ value, onChange }) {
  const bands = readBands(value)
  const [active, setActive] = useState('red')
  const band = BANDS.find((item) => item.key === active) || BANDS[0]
  const current = bands[band.key]

  const set = (patch) => {
    onChange({ ...bands, [band.key]: { ...current, ...patch } })
  }
  const toUi = (raw) => Math.round(raw * 100)
  const fromUi = (ui) => Math.max(-1, Math.min(1, ui / 100))

  return (
    <div data-hsl-editor="1" data-hsl-active={band.key}>
      <div className="hsl-bands" data-hsl-bands="1">
        {BANDS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`hsl-band ${item.key === band.key ? 'active' : ''}`}
            data-hsl-band={item.key}
            aria-pressed={item.key === band.key}
            title={`${item.label}（色相 ${item.center}°）`}
            onClick={() => setActive(item.key)}
          >
            <span className="hsl-band-swatch" style={{ background: item.hex }} />
            <span>{item.label}</span>
            {bandActive(bands, item.key) ? <i className="hsl-band-dot" data-hsl-dirty="1" /> : null}
          </button>
        ))}
      </div>

      <Slider
        label={`${band.label} · 色相`}
        min={-100}
        max={100}
        step={1}
        value={toUi(current.h)}
        hook={`hsl-h-${band.key}`}
        format={(ui) => `${ui > 0 ? '+' : ''}${ui}`}
        onChange={(ui) => set({ h: fromUi(ui) })}
      />
      <Slider
        label={`${band.label} · 饱和度`}
        min={-100}
        max={100}
        step={1}
        value={toUi(current.s)}
        hook={`hsl-s-${band.key}`}
        format={(ui) => `${ui > 0 ? '+' : ''}${ui}`}
        onChange={(ui) => set({ s: fromUi(ui) })}
      />
      <Slider
        label={`${band.label} · 亮度`}
        min={-100}
        max={100}
        step={1}
        value={toUi(current.l)}
        hook={`hsl-l-${band.key}`}
        format={(ui) => `${ui > 0 ? '+' : ''}${ui}`}
        onChange={(ui) => set({ l: fromUi(ui) })}
      />

      <p className="hsl-note">
        只影响画面里接近这个色相的部分；灰色与纯黑纯白不受影响。参数按 3D 查找表烘焙，
        预览与导出用同一张表。
      </p>
    </div>
  )
}
