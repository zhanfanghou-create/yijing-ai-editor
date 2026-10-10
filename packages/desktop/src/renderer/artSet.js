/**
 * artSet.js —— 工作台「素材库 → 背景」那一屏的配图（12 张，全部自有版权）。
 *
 * 图从哪来：由 `tools/gen-own-art.py` 程序化生成（PIL，seeded，可逐字节复现），
 * 不是从任何第三方产品里取出来的。重画整族：`python tools/gen-own-art.py`。
 *
 * 这一族**没有能力码**：背景不是某种额外能力，而是把选中的图铺到视频后面当底图
 * （视频保持原比例居中，四周由这张图填满）。所以条目上是 `backdrop: true` ——
 * 点卡片 = 把这张图设为预览画面的底图（见 SidePanels.jsx 的 RefArtPanel）。
 *
 * `label` 是编号不是名字：这一屏的卡片上不显示文字，`label` 只用于 tooltip 与
 * 「已选择」提示，不冒充任何现成文案。
 */
import artBg01 from './assets/art/background/01.png'
import artBg02 from './assets/art/background/02.png'
import artBg03 from './assets/art/background/03.png'
import artBg04 from './assets/art/background/04.png'
import artBg05 from './assets/art/background/05.png'
import artBg06 from './assets/art/background/06.png'
import artBg07 from './assets/art/background/07.png'
import artBg08 from './assets/art/background/08.png'
import artBg09 from './assets/art/background/09.png'
import artBg10 from './assets/art/background/10.png'
import artBg11 from './assets/art/background/11.png'
import artBg12 from './assets/art/background/12.png'

export const BACKGROUND_PRESETS = [
  { key: 'bg-01', label: '背景 01', art: artBg01, backdrop: true },
  { key: 'bg-02', label: '背景 02', art: artBg02, backdrop: true },
  { key: 'bg-03', label: '背景 03', art: artBg03, backdrop: true },
  { key: 'bg-04', label: '背景 04', art: artBg04, backdrop: true },
  { key: 'bg-05', label: '背景 05', art: artBg05, backdrop: true },
  { key: 'bg-06', label: '背景 06', art: artBg06, backdrop: true },
  { key: 'bg-07', label: '背景 07', art: artBg07, backdrop: true },
  { key: 'bg-08', label: '背景 08', art: artBg08, backdrop: true },
  { key: 'bg-09', label: '背景 09', art: artBg09, backdrop: true },
  { key: 'bg-10', label: '背景 10', art: artBg10, backdrop: true },
  { key: 'bg-11', label: '背景 11', art: artBg11, backdrop: true },
  { key: 'bg-12', label: '背景 12', art: artBg12, backdrop: true }
]

/** 全部族（顺序即界面上的展示顺序） */
export const ART_FAMILIES = [
  /* 背景：卡片规格与其它面板不同（130x75 且不显示名字），由 RefArtPanel
     按 `family.size` 挂另一套网格修饰类，见 workbench.css 的 `.enh-grid.is-bg`。 */
  { key: 'background', title: '背景', items: BACKGROUND_PRESETS, size: 'bg' }
]

/** 全部卡片，拍平。闸门与自检用。 */
export const ALL_ART = ART_FAMILIES.flatMap((f) => f.items)
