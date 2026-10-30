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
 * ⚠️ 顺序与参考 11.6 一致（截去本项目没有的数字人）：
 *   素材 · 音频 · 文字 · 贴纸 · 特效 · 转场 · 字幕 · 滤镜 · 调节 · 模板 · 智能包装 · 插件。
 *   参考里「滤镜」与「调节」是相邻的两枚，且**顺序固定**：滤镜是套风格、调节是修画面，
 *   反了之后用户找"提亮"会先点进滤镜（然后发现里面全是风格预设）。
 *
 * ⚠️ 「插件」放在这一排的末尾，但**它不是参考里那件事**：参考的插件是 .ofx 原生特效
 *   （宿主得实现 OpenFX 的 C++ API，数月级工程），本工程装的是**素材包** ——
 *   自定义边框与贴纸，导入后立刻进对应素材库、预览与导出都直接生效。
 *   页面上把这条写明了，不假装支持 .ofx。
 *
 * ⚠️ 「贴纸」原先不在这一排里，理由是"没有本机数据源"。2026-10-30 补齐：
 *   素材来自 Noto Animated Emoji 的静态 512 帧（Apache-2.0，允许随包再分发），
 *   由 `tools/fetch-stickers.mjs` 抓到 `resources/stickers/`，随包离线可用 ——
 *   所以它是**真数据**，不是"点进去一片空白"的假入口。
 *
 * ⚠️ 「模板」2026-10-30 补齐：12 款成套预设全部由**本工程自带的原料**拼成
 *   （19 个文字样式 + 140 枚贴纸 + 24 款边框），数据在 shared/templates.json，
 *   生成逻辑在 shared/templates.js（纯函数，可脱机自测）。
 *   整套数据都在本机，点了就真的往时间线加东西（不走网络、不下载）。
 *
 * ⚠️ 「智能包装」2026-10-30 补齐：判定与成套方案在 shared/packaging.js（纯函数，
 *   内置词库匹配，不联网、不调模型），见 tools/packaging-selftest.mjs。
 *
 * ⚠️ 仍然没做的两枚（数字人 / 插件）各自缺的东西不一样：
 *   数字人必须联网调模型，这个开源版从设计上就排除；插件需要沙箱与清单机制。
 *   缺的已记在 MEMORY.md 的待办里。
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
  IconPlugin,
  IconSparkle,
  IconSticker,
  IconTemplate,
  IconText,
  IconTransition,
  IconWand
} from '../icons.jsx'

export const WB_TABS = [
  { key: 'media', label: '素材', Icon: IconMedia, hint: '本地导入的素材' },
  { key: 'audio', label: '音频', Icon: IconMusic, hint: '提取音频与本地音乐' },
  { key: 'text', label: '文字', Icon: IconText, hint: '标题、花字与文字模板' },
  /* 「贴纸」：内置 140 枚表情/手势/装饰贴纸（Apache-2.0，随包离线）。
     它排在「文字」之后，因为两者都是"叠在画面上的元素"；素材是本地文件、
     文字是本机排版，贴纸是随包图库 —— 参考的顺序也是这么放的。 */
  { key: 'sticker', label: '贴纸', Icon: IconSticker, hint: '表情、手势与装饰贴纸' },
  { key: 'effect', label: '特效', Icon: IconWand, hint: '画面特效' },
  { key: 'transition', label: '转场', Icon: IconTransition, hint: '片段之间的过渡' },
  { key: 'subtitle', label: '字幕', Icon: IconCaption, hint: '字幕样式与手写字幕' },
  { key: 'filter', label: '滤镜', Icon: IconColorFilter, hint: '画面调色预设' },
  /* 「调节」：亮度 / 对比度 / 饱和度 / 色温 / 色调的预设，写的是片段的 adjust 字段 */
  { key: 'adjust', label: '调节', Icon: IconAdjust, hint: '亮度、对比度、饱和度与色温' },
  /* 「模板」：成套预设（开场 / 结尾 / 字幕套）。点一下往时间线加一串片段 ——
     文字用内置样式表、贴纸用内置贴纸库、边框用内置边框库，
     **不引用任何外部文件**，所以它不依赖联网，也不会出现"点进去一片空白"。
     放在最后一位：它的用法是"给已经剪好的东西套一层"，不是从素材开始的第一步。 */
  { key: 'template', label: '模板', Icon: IconTemplate, hint: '成套的开场、结尾与字幕预设' },
  /* 「智能包装」：对**已经剪好的内容**批量套包装 —— 口播（字幕样式 / 关键句放大 / 配贴纸）
     与画面（主轨统一边框 + 调色）两条，都只改已有片段，不往时间线加台词。
     排在最后一位：与「模板」同类，是"收尾美化"而不是"从素材开始"的第一步。 */
  { key: 'packaging', label: '智能包装', Icon: IconSparkle, hint: '给已有字幕与画面批量套包装' },
  /* 「插件」：装的是**素材包**（自定义边框 / 贴纸），不是 .ofx 原生特效。
     排在「智能包装」之后 —— 它是"扩素材来源"，与"收尾美化"是两类事。 */
  { key: 'plugin', label: '插件', Icon: IconPlugin, hint: '导入自定义边框与贴纸' }
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
