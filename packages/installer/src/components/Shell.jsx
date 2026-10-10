import { IconCheck, IconChevronDown, IconWinClose, IconWinMin } from '../icons.jsx'
import logoUrl from '../assets/logo48.png'
import { BRAND } from '../brand.js'

/** 标题栏：品牌标识 + 最小化 / 关闭（自绘，与参考安装器同尺寸同位置） */
export function TitleBar({ onMinimize, onClose }) {
  return (
    <div className="titlebar">
      <div className="brand">
        <img className="brand-logo" src={logoUrl} alt="" draggable="false" />
        <span className="brand-name">{BRAND.shortName}</span>
      </div>
      <button className="win-btn min" onClick={onMinimize} title="最小化" aria-label="最小化">
        <IconWinMin />
      </button>
      <button className="win-btn close" onClick={onClose} title="关闭" aria-label="关闭">
        <IconWinClose />
      </button>
    </div>
  )
}

/** 协议勾选框：20×20，参考默认勾选 */
export function Checkbox({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="checkbox"
      onClick={() => onChange(!checked)}
    >
      <IconCheck />
    </button>
  )
}

/** 原生下拉框（自绘 V 形箭头，箭头位置与参考一致：右边距 13px） */
export function Select({ value, onChange, options, id }) {
  return (
    <div className="field-wrap select">
      <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="chev">
        <IconChevronDown />
      </span>
    </div>
  )
}
