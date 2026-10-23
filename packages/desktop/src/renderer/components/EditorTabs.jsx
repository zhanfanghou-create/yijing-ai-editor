/**
 * 工作台顶部的功能标签行。
 *
 * 一级功能横排在顶部（不是左侧竖栏），图标在上文字在下。
 *
 * ⚠️ 图标必须与该标签**真实做的事**对得上。这里曾经有两处名实不符：
 *   · 「转场」顶着换脸图标（IconFaceSwap）—— 因为转场当时没有自己的字形；
 *   · 「滤镜」与「特效」共用同一个 IconEnhance。
 * 两类都不会报错，只有盯着看才发现。现在每一枚都取 iconsLocal / capabilityMeta
 * 里的专属字形，由 tools/check-workbench-tree.mjs 断言各标签的图标互不相同。
 *
 * ⚠️ 顺序与参考 11.6 一致（截去本项目没有的贴纸 / 智能包装 / 模板 / 数字人 / 插件）：
 *   素材 · 音频 · 文字 · 特效 · 转场 · 字幕 · 滤镜 · 调节。
 *   参考里「滤镜」与「调节」是相邻的两枚，且**顺序固定**：滤镜是套风格、调节是修画面，
 *   反了之后用户找"提亮"会先点进滤镜（然后发现里面全是风格预设）。
 *
 * ⚠️ 为什么不做满参考的 13 枚：贴纸 / 智能包装 / 模板 / 数字人 / 插件在本项目里
 *   没有本机数据源（需要素材云或模型服务），摆上去就是"点进去一片空白"的假入口 ——
 *   这正是本项目一直在清的那类缺陷。缺的那几枚已记在 MEMORY.md 的待办里。
 *
 * 改这张表必须同步 tools/workbench-buttons-e2e.mjs 的 TABS、
 * tools/workbench-tabs-e2e.mjs 的 TABS，以及 tools/check-card-specs.mjs /
 * tools/check-workbench-tree.mjs 里钉住的标签数。
 */
import {
  IconAdjust,
  IconCaption,
  IconColorFilter,
  IconMedia,
  IconMusic,
  IconText,
  IconTransition,
  IconWand
} from '../icons.jsx'

export const WB_TABS = [
  { key: 'media', label: '素材', Icon: IconMedia, hint: '本地导入的素材' },
  { key: 'audio', label: '音频', Icon: IconMusic, hint: '提取音频与本地音乐' },
  { key: 'text', label: '文字', Icon: IconText, hint: '标题、花字与文字模板' },
  { key: 'effect', label: '特效', Icon: IconWand, hint: '画面特效' },
  { key: 'transition', label: '转场', Icon: IconTransition, hint: '片段之间的过渡' },
  { key: 'subtitle', label: '字幕', Icon: IconCaption, hint: '字幕样式与手写字幕' },
  { key: 'filter', label: '滤镜', Icon: IconColorFilter, hint: '画面调色预设' },
  /* 「调节」：亮度 / 对比度 / 饱和度 / 色温 / 色调的预设，写的是片段的 adjust 字段 */
  { key: 'adjust', label: '调节', Icon: IconAdjust, hint: '亮度、对比度、饱和度与色温' }
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
          <Icon size={22} />
          <span>{label}</span>
        </button>
      ))}
      <span className="wb-tabs-grow" />
    </nav>
  )
}
