/**
 * 工作台左栏：一棵可折叠的树。
 *
 * 结构照参考客户端实测截图（`_evidence/ref-ui/02b/02c-剪辑工作台-1920x1032.png`）：
 *   · 一个根卡片「素材」+ 一串带图标的卡片（AI视频…智能剪辑）；
 *   · **根卡片和各图标卡片都能展开**，展开后它的子项以「纯文字行」形式紧跟其后；
 *   · 一次只展开一组（手风琴）—— 参考的「素材」标签页里
 *     `02b` 展开的是根（子项：本地/下载/录制/我的预设/我的角色），
 *     而 `02c` 展开的是「视频增强」（子项：场景增强/视频修复/视频超分/色彩优化/我的创作），
 *     两张图的行数都是 13、每行节距也都是 36~38px，说明是"换了一组展开"而不是"多挂了一层"。
 *     ⚠️ 这条是本次新发现的：在此之前本项目左栏的子项是**写死的 5 行**，
 *     点「视频增强」不会换子项 —— 盒子/颜色/hover 全对，只有"点下去栏没变"，
 *     正是那种所有闸门都放过的缺陷。
 *
 * 左栏项的 key 就是素材筛选条件：带 `caps` 的项只显示命中这些**能力码**的素材；
 * 带 `panel` 的项把中间栏换成功能面板；带 `enhance` 的项把中间栏换成增强预设画廊。
 *
 * ⚠️ 这里曾经埋着一个静默失效：`caps` 写的是连字符形式（`text-to-video`、`face-swap`、
 * `live-portrait`），而服务端任务与素材上的 `asset.capability` 是下划线形式
 * （`text_to_video`、`face_swap`、`digital_human`）。两边永远不相等 ⇒
 * **点「AI视频」永远是空列表、计数永远是 0**，不抛错、不影响构建、任何断言都看不到。
 * 现在统一从 capabilityMeta.js 取真实能力码，并由 tools/check-capability-meta.mjs
 * 扫描本文件，禁止再出现连字符式的能力码。
 *
 * 另外每个二级项要么带 `caps`（筛选）、要么带 `panel`（中间栏换成功能面板），
 * 两者都没有的项会落到"显示全部素材"，这在界面上等于一个点了没反应的死入口 ——
 * 所以由 tools/check-workbench-tree.mjs 断言：除明确的通用项外，每项必须有去向。
 */
import { Fragment } from 'react'
import {
  IconAiImage,
  IconAiSwap,
  IconAiVideo,
  IconChevronDown,
  IconCreateVideo,
  IconFaceSwap,
  IconLayers,
  IconMusic,
  IconFolder,
  IconImageBoost,
  IconLibrary,
  IconScissors,
  IconSmartCut,
  IconSmartEdit,
  IconSparkle,
  IconText,
  IconToolbox,
  IconTransition,
  IconTranslate,
  IconUpscale,
  IconVideoBoost,
  IconWand,
  IconFilter
} from '../icons.jsx'

/**
 * 「视频增强」这一支筛的能力。
 * ⚠️ 父项与子项「我的创作」**必须共用这一份** —— 写成两处就是两张手写的能力码表，
 * `check-capability-kinds` 的白名单是按**表数**钉的（写死 3 张），多一张就报出来。
 * 那条规则是对的：同一份意图散成两张表时，改一张忘一张没人会发现。
 */
/**
 * 参考「文字 → 花字」的分组（实拍顺序）。
 * ⚠️ 同样写成数组字面量常量（原因同 VIDEO_ENHANCE_CHILDREN：check-workbench-tree 静态读表）。
 * 组名与 textStyles.js 里的分组编号一一对应（key 里的数字就是下标）。
 */
const TEXT_ART_CHILDREN = [
  { key: 'art-g0', label: '热门', plain: true, panel: 'text-style', textStyle: 0 },
  { key: 'art-g1', label: '基础', plain: true, panel: 'text-style', textStyle: 1 },
  { key: 'art-g2', label: '纹理', plain: true, panel: 'text-style', textStyle: 2 },
  { key: 'art-g3', label: '发光', plain: true, panel: 'text-style', textStyle: 3 },
  { key: 'art-g4', label: '黄色', plain: true, panel: 'text-style', textStyle: 4 },
  { key: 'art-g5', label: '蓝色', plain: true, panel: 'text-style', textStyle: 5 },
  { key: 'art-g6', label: '红色', plain: true, panel: 'text-style', textStyle: 6 },
  { key: 'art-g7', label: '绿色', plain: true, panel: 'text-style', textStyle: 7 }
]

/** 每个一级标签下的左栏树 */
export const WB_TREE = {
  media: {
    /* 根卡片自己也能展开：它的子项就是素材来源（参考 02b 里展开的就是这一组） */
    root: {
      key: 'material',
      label: '素材',
      children: [
        { key: 'local', label: '本地', source: 'local', landing: true },
        /*
         * 「生成结果」：AI 生成出来的产物归宿。
         *
         * 为什么必须有这一项：产物**没有** `source: 'local'`（它不是用户从电脑里导入的），
         * 而落地节点恰好是「本地」—— 于是生成成功后中栏**一条都不显示**，
         * 用户看到的是"弹窗里明明有 2 个结果，关掉之后哪也找不到"。
         * 参考客户端里这一步的产物落在「生成结果 / 我的创作」下，是单独的一类。
         */
        { key: 'record', label: '录制', tag: 'Free', panel: 'record' },
        /*
         * ⚠️ 「背景」不在这里 —— 2026-09-25 实拍确认它挂在**「素材库」**下
         * （子项 背景 / 视频库 / 图片库 / 动画库），不在「素材」根下。
         * 之前放在这里是编排猜测，与参考不符，已下移。见 `_evidence/comparison/01-左栏结构对照.md`。
         */
        { key: 'preset', label: '我的预设', panel: 'preset' }
      ]
    },
    items: [
      {
        /* 参考「素材库」展开后有四个子项：背景 / 视频库 / 图片库 / 动画库（2026-09-25 实拍）。
           背景走配图画廊（`image/BackgroundImages/` 那 12 张真图）；
           视频库/图片库/动画库按素材的 `kind` 筛（见 App.jsx 的 filteredAssets）。 */
        key: 'stock',
        label: '素材库',
        Icon: IconLibrary,
        caret: true,
        panel: 'stock',
        children: [
          { key: 'stock-bg', label: '背景', plain: true, panel: 'ref-art', refArt: 'background' },
          { key: 'stock-video', label: '视频库', plain: true, kinds: ['video'] },
          { key: 'stock-image', label: '图片库', plain: true, kinds: ['image'] },
          { key: 'stock-anim', label: '动画库', plain: true, kinds: ['other'] }
        ]
      },
      /* 参考在这两项之间留了 9px（其余卡片行只有 4px），是分组分隔 */
      { key: 'smart', label: '智能剪辑', Icon: IconSmartCut, caret: true, gapBefore: true, panel: 'smart' }
    ]
  },
  text: {
    /* 参考「文字」页左栏（实拍）：创建文字 / 自定义 / 花字[NEW]（热门·基础·纹理·发光·
       黄色·蓝色·红色·绿色…）。「收藏」需要用户素材库，暂缺（与滤镜页同处理）。 */
    root: { key: 'text-root', label: '文字' },
    items: [
      { key: 'text-create', label: '创建文字', plain: true, panel: 'text' },
      { key: 'text-custom', label: '自定义', plain: true, panel: 'text' },
      {
        key: 'text-art',
        label: '花字',
        tag: 'NEW',
        Icon: IconWand,
        caret: true,
        panel: 'text-style',
        textStyle: 0,
        children: TEXT_ART_CHILDREN
      }
    ]
  },
  subtitle: {
    /* 字幕样式（自定义）+ 手写 / 新建字幕。所有字幕都是本机编辑的内容，
       不做语音识别、不做翻译 —— 那两类要外挂模型，本机没有。 */
    root: { key: 'subtitle-root', label: '字幕' },
    items: [
      // 参考的「自定义」落的是字幕样式属性面板（PropertyPanel_SubtitleStyle 语义）：
      // 换样式 / 给播放头处的字幕换装，不是手填文本。panel 'text-style'（group 缺省 null
      // = 全部字幕样式）。此前误接到 panel 'text'，把样式网格顶成了手填面板。
      { key: 'subtitle-custom', label: '自定义', plain: true, panel: 'text-style' },
      { key: 'sub-new', label: '新建字幕', plain: true, panel: 'text' },
      { key: 'sub-hand', label: '手写字幕', plain: true, panel: 'text' }
    ]
  },
  audio: {
    /* 参考「音频」页左栏（实拍）：音色克隆 / 文字转语音 / 视频变声 / 提取音频 /
       AI音乐(歌曲·我的创作) / AI音效 / 音乐。「收藏」「音频下载」需要用户素材库，暂缺。 */
    root: { key: 'audio-root', label: '音频' },
    items: [
      /* 提取音频**不走 AI**：本地 ffmpeg 抽音轨，接不接模型都能用 */
      { key: 'audio-extract', label: '提取音频', Icon: IconScissors, caret: true, panel: 'extract-audio' },
      { key: 'audio-music', label: '音乐', Icon: IconMusic, caret: true, kinds: ['audio'] }
    ]
  },
  transition: {
    /* 参考「转场」页左栏（实拍 page-transition 系列缺、以素材缓存分组树 + 特效页实拍为准）：
       收藏 / 转场 > 子分组。收藏需要用户素材库，暂缺（已记录的已知差异）。
       子分组名与 materials.js 的 TRANSITION_GROUPS **顺序一一对应**（key 里的数字就是下标），
       生成器固定顺序，不会漂移。 */
    root: {
      key: 'transition-root',
      label: '转场',
      caret: true,
      panel: 'transition',
      material: 'transitions:0',
      children: [
        { key: 'tr-g0', label: '热门', plain: true, panel: 'transition', material: 'transitions:0' },
        { key: 'tr-g1', label: '最新', plain: true, panel: 'transition', material: 'transitions:1' },
        { key: 'tr-g2', label: '基础', plain: true, panel: 'transition', material: 'transitions:2' },
        { key: 'tr-g3', label: '叠化', plain: true, panel: 'transition', material: 'transitions:3' },
        { key: 'tr-g4', label: '幻灯片', plain: true, panel: 'transition', material: 'transitions:4' },
        { key: 'tr-g5', label: '模糊 Pro', plain: true, panel: 'transition', material: 'transitions:5' },
        { key: 'tr-g6', label: '故障', plain: true, panel: 'transition', material: 'transitions:6' },
        { key: 'tr-g7', label: '运镜', plain: true, panel: 'transition', material: 'transitions:7' },
        { key: 'tr-g8', label: '扭曲', plain: true, panel: 'transition', material: 'transitions:8' },
        { key: 'tr-g9', label: '3D', plain: true, panel: 'transition', material: 'transitions:9' },
        { key: 'tr-g10', label: '光效', plain: true, panel: 'transition', material: 'transitions:10' }
      ]
    },
    items: []
  },
  filter: {
    /* 参考「滤镜」页左栏：收藏 / 色彩匹配 / 滤镜 > 14 个子分组（page-filter2 实拍 +
       素材缓存分组树）。收藏暂缺（同转场）；「色彩匹配」落在色彩优化预设画廊（真功能）。 */
    root: {
      key: 'filter-root',
      label: '滤镜',
      caret: true,
      panel: 'filter',
      material: 'filters:0',
      children: [
        { key: 'fl-g0', label: '热门', plain: true, panel: 'filter', material: 'filters:0' },
        { key: 'fl-g1', label: '最新', plain: true, panel: 'filter', material: 'filters:1' },
        { key: 'fl-g2', label: '万圣节', plain: true, panel: 'filter', material: 'filters:2' },
        { key: 'fl-g3', label: '秋天', plain: true, panel: 'filter', material: 'filters:3' },
        { key: 'fl-g4', label: '人像', plain: true, panel: 'filter', material: 'filters:4' },
        { key: 'fl-g5', label: '电影风格', plain: true, panel: 'filter', material: 'filters:5' },
        { key: 'fl-g6', label: '婚礼', plain: true, panel: 'filter', material: 'filters:6' },
        { key: 'fl-g7', label: '风景', plain: true, panel: 'filter', material: 'filters:7' },
        { key: 'fl-g8', label: '风格化', plain: true, panel: 'filter', material: 'filters:8' },
        { key: 'fl-g9', label: '黑白', plain: true, panel: 'filter', material: 'filters:9' },
        { key: 'fl-g10', label: '快门声', plain: true, panel: 'filter', material: 'filters:10' },
        { key: 'fl-g11', label: '复古', plain: true, panel: 'filter', material: 'filters:11' },
        { key: 'fl-g12', label: '夜景', plain: true, panel: 'filter', material: 'filters:12' },
        { key: 'fl-g13', label: '美食', plain: true, panel: 'filter', material: 'filters:13' }
      ]
    },
    items: []
  },
  effect: {
    /* 参考「特效」页左栏：收藏 / 人物特效 / 边框特效 / 音频效果(NEW) / 视频特效 > 10 个
       子分组（page-effect2 实拍 + 素材缓存分组树）。收藏 / 人物特效 / 边框特效暂缺
       （素材族没提；已记录的已知差异）；「音频效果」落在音频面板（真功能）。 */
    root: {
      key: 'effect-root',
      label: '视频特效',
      caret: true,
      panel: 'effect',
      material: 'effects:0',
      children: [
        { key: 'ef-g0', label: '热门', plain: true, panel: 'effect', material: 'effects:0' },
        { key: 'ef-g1', label: '基础', plain: true, panel: 'effect', material: 'effects:1' },
        { key: 'ef-g2', label: '万圣节', plain: true, panel: 'effect', material: 'effects:2' },
        { key: 'ef-g3', label: '光效', plain: true, panel: 'effect', material: 'effects:3' },
        { key: 'ef-g4', label: '自然', plain: true, panel: 'effect', material: 'effects:4' },
        { key: 'ef-g5', label: '模糊', plain: true, panel: 'effect', material: 'effects:5' },
        { key: 'ef-g6', label: '粒子', plain: true, panel: 'effect', material: 'effects:6' },
        { key: 'ef-g7', label: '动漫', plain: true, panel: 'effect', material: 'effects:7' },
        { key: 'ef-g8', label: '节日', plain: true, panel: 'effect', material: 'effects:8' },
        { key: 'ef-g9', label: '爱心', plain: true, panel: 'effect', material: 'effects:9' }
      ]
    },
    items: []
  },
  adjust: {
    /* 「调节」：写的是片段的 adjust 五个参数（shared/adjust.js 的真源），
       与右栏「调整」页的滑杆是同一份字段 —— 点一个预设，滑杆当场跟着动。
       分组下标与 materials.js 的 ADJUST_GROUPS 顺序一一对应。 */
    root: {
      key: 'adjust-root',
      label: '调节',
      caret: true,
      panel: 'adjust',
      material: 'adjust:0',
      children: [
        { key: 'ad-g0', label: '热门', plain: true, panel: 'adjust', material: 'adjust:0' },
        { key: 'ad-g1', label: '人像', plain: true, panel: 'adjust', material: 'adjust:1' },
        { key: 'ad-g2', label: '风景', plain: true, panel: 'adjust', material: 'adjust:2' },
        { key: 'ad-g3', label: '美食', plain: true, panel: 'adjust', material: 'adjust:3' },
        { key: 'ad-g4', label: '夜景', plain: true, panel: 'adjust', material: 'adjust:4' }
      ]
    },
    items: []
  }
}

export function treeOf(tab) {
  return WB_TREE[tab] || WB_TREE.media
}

/**
 * 按 key 找节点 —— **根项、一级卡片、以及各卡片展开出来的子项都要能找到**。
 * 以前只查 `tree.items`，子项化之后（「本地」「降噪」这类）会查不到，
 * 于是 `currentNode` 变成 root，中栏静默退回"显示全部素材"。
 */
export function nodeOf(tab, key) {
  const tree = treeOf(tab)
  if (tree.root.key === key) return tree.root
  for (const item of tree.items) {
    if (item.key === key) return item
    const child = item.children?.find((c) => c.key === key)
    if (child) return child
  }
  const rootChild = tree.root.children?.find((c) => c.key === key)
  if (rootChild) return rootChild
  return null
}

/** 某个 key 是不是被展开的那一组里的（用于手风琴的高亮/箭头方向） */
export function groupOf(tab, key) {
  const tree = treeOf(tab)
  if (tree.root.children?.some((c) => c.key === key) || tree.root.key === key) return tree.root
  for (const item of tree.items) {
    if (!item.children?.length) continue
    if (item.key === key || item.children.some((c) => c.key === key)) return item
  }
  return null
}

/**
 * 切到这个标签时该落在哪个二级项上。
 *
 * **优先 `landing: true` 的那一项。** 「素材」标签的落点必须显式写死：
 * 若沿用下面"第一个带 panel 的项"的规则，会落在「录制」上 —— 而录制面板目前是
 * "应用内录制尚未接入"的说明文字，于是**导入完素材，中间栏显示的是那段说明，
 * 用户看不到自己刚导进来的东西**。这个缺陷躺了很久没人发现，因为它只有
 * "真的按下导入按钮"才会显形：合成片闸门那 6 条导入断言因 contextBridge 冻结
 * 恒为 SKIP，只有真实影片 E2E 走的是主进程打桩、真的按得下去。
 *
 * 其余标签沿用"第一个带 panel 的项"：不能一律落在 root —— root 没有 panel、
 * 也没有 caps，中间栏会退化成"显示全部素材"，于是「转场」「滤镜」这类
 * **整个标签的意义都在面板里**的标签，点进去看着就像空的。都没有再退回 root。
 */
export function defaultNodeOf(tab) {
  const tree = treeOf(tab)
  const pool = [...(tree.root.children || []), ...tree.items]
  const landing = pool.find((item) => item.landing)
  if (landing) return landing.key
  const withPanel = pool.find((item) => item.panel)
  return (withPanel || tree.root).key
}

export default function AssetTree({ tab, active, onChange, countOf }) {
  const tree = treeOf(tab)
  const openGroup = groupOf(tab, active)
  const openKey = openGroup?.key || null

  const renderNode = (node, isChild) => {
    const count = countOf && !isChild ? countOf(node) : null
    const isGroup = Boolean(node.children?.length)
    const isOpen = isGroup && openKey === node.key
    const classes = [
      'wb-node',
      isChild || node.plain ? 'plain' : 'card',
      active === node.key ? 'active' : '',
      node.gapBefore ? 'gap-before' : ''
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <button
        key={node.key}
        type="button"
        className={classes}
        onClick={() => onChange(node.key)}
        data-wb-node={node.key}
        title={node.caps?.length ? `筛选：${node.caps.join(' / ')}` : undefined}
      >
        {node.Icon ? <node.Icon size={16} /> : null}
        <span>{node.label}</span>
        {node.tag ? <i className={`wb-tag ${node.tag.toLowerCase()}`}>{node.tag}</i> : null}
        {count ? <span className="wb-count">{count}</span> : null}
        {node.caret ? <IconChevronDown size={14} className={`wb-caret ${isOpen ? 'open' : ''}`} /> : null}
      </button>
    )
  }

  return (
    <aside className="wb-tree" aria-label="素材分类">
      {/* 根卡片也是可点的（点它 = 回落到 tree.root，中栏显示该标签下的全部素材），
          所以它**也要反映选中态**。
          这里原来是 `className="wb-node root"`，永远没有 active ——
          用户点了根卡片之后左栏一处高亮都没有，看不出自己在哪一层。
          `.wb-node.active` 的底色规则早就有了，只是根卡片从来没带上这个类。
          箭头方向也跟展开态走：参考 02b 里根展开着（^），02c 里换成「视频增强」展开、
          根的箭头就朝下了（v）。 */}
      <button
        type="button"
        className={`wb-node root ${active === tree.root.key ? 'active' : ''}`}
        onClick={() => onChange(tree.root.key)}
        data-wb-node={tree.root.key}
      >
        <IconFolder size={16} />
        <span>{tree.root.label}</span>
        <IconChevronDown size={14} className={`wb-caret ${openKey === tree.root.key ? 'open' : ''}`} />
      </button>

      {openKey === tree.root.key && tree.root.children?.length
        ? tree.root.children.map((c) => renderNode(c, true))
        : null}

      {tree.items.map((item) => (
        <Fragment key={item.key}>
          {renderNode(item, false)}
          {/* 展开的那一组，子项紧跟其后、以纯文字行呈现（参考 02c 的「视频增强」） */}
          {item.children?.length && openKey === item.key ? item.children.map((c) => renderNode(c, true)) : null}
        </Fragment>
      ))}
    </aside>
  )
}
