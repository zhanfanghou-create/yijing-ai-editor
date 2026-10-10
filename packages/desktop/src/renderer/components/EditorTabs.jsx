/**
 * 工作台顶部的功能标签行。
 *
 * 七个一级功能横排在顶部（不是左侧竖栏），高 44px、
 * 每个 58px、图标在上文字在下。
 *
 * ⚠️ 图标必须与该标签**真实做的事**对得上。这里曾经有两处名实不符：
 *   · 「转场」顶着换脸图标（IconFaceSwap）—— 因为转场当时没有自己的字形；
 *   · 「滤镜」与「特效」共用同一个 IconEnhance。
 * 两类都不会报错，只有盯着看才发现。现在转场/滤镜各自取
 * capabilityMeta 与 iconsLocal 里的专属字形，由 tools/check-workbench-tree.mjs
 * 断言各标签的图标互不相同。
 *
 * ⚠️ 七个是有意的：数字人与在线素材库那两类不在本机完成，已并入
 * 「媒体文件」下的左栏节点。改这张表必须同步 tools/workbench-buttons-e2e.mjs
 * 的 TABS 与 tools/check-card-specs.mjs 的标签数。
 */
import { IconCaption, IconFilter, IconLayers, IconMedia, IconMusic, IconText, IconTransition, IconWand } from '../icons.jsx'

export const WB_TABS = [
  { key: 'media', label: '媒体文件', Icon: IconMedia, hint: '本地导入的素材' },
  { key: 'text', label: '文字', Icon: IconText, hint: '标题、花字与文字模板' },
  { key: 'subtitle', label: '字幕', Icon: IconCaption, hint: '字幕样式与手写字幕' },
  { key: 'audio', label: '音频', Icon: IconMusic, hint: '提取音频与本地音乐' },
  { key: 'transition', label: '转场', Icon: IconTransition, hint: '片段之间的过渡' },
  { key: 'filter', label: '滤镜', Icon: IconFilter, hint: '画面调色预设' },
  { key: 'effect', label: '特效', Icon: IconWand, hint: '画面特效' }
]

export default function EditorTabs({ active, onChange }) {
  return (
    <nav className="wb-tabs" aria-label="功能分类">
      {WB_TABS.map(({ key, label, Icon, hint }) => (
        <button
          key={key}
          type="button"
          className={`wb-tab ${active === key ? 'active' : ''}`}
          onClick={() => onChange(key)}
          title={hint}
          data-wb-tab={key}
        >
          <Icon size={19} />
          <span>{label}</span>
        </button>
      ))}
      <span className="wb-tabs-grow" />
    </nav>
  )
}
