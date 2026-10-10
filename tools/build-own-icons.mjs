/**
 * build-own-icons.mjs —— 生成**自有版权**的界面图标源 SVG。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这个脚本
 * ---------------------------------------------------------------------------
 * `assets/icons/raw/` 原来放的是从别处逐字节取出的 SVG，那是**他人作品**，
 * 要开源就必须换掉（那份清单记在已删除的 PLACEHOLDERS.json 里）。
 * 换图的方式不是"再找个图标库拷进来"（那是换一个侵权源），而是**自己画**：
 * 24×24 网格、单色 `currentColor`、线性无底板，与界面现有图标同一套规格。
 *
 * 产物落在 `raw/` 而不是另开目录：`tools/build-icons.mjs` 的源目录是写死的
 * （`assets/icons/raw`），且 MAPPING.json 用 `file` 字段指向它。
 * 换**内容**不换**路径**，可以让"图标角色 → 组件"这条链一动不动，
 * 于是 `ownIcons.jsx` / `icons.jsx` / 所有调用点都不需要改 —— 只有字形变了。
 *
 * ⚠️ 每次改完这里都要重跑 `node tools/build-icons.mjs`（不带 --check），
 *    否则 `icons` 闸门会红着提醒"产物与输入不一致"。
 *
 * 用法：
 *   node tools/build-own-icons.mjs            # 写 SVG + 改写 MAPPING.json
 *   node tools/build-own-icons.mjs --check    # 只校验：49 个角色是否都有自绘源
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const ASSET_DIR = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'icons')
const RAW = path.join(ASSET_DIR, 'raw')
const MAPPING = path.join(ASSET_DIR, 'MAPPING.json')
const CHECK = process.argv.includes('--check')

/* ────────────────────────── 画笔 ──────────────────────────
 * 颜色一律写 `currentColor`：build-icons.mjs 会把所有颜色归一成它，
 * 这里提前写成它，是为了让"源文件本身"就是可直接用的图标（不依赖生成器）。
 */
const W = 1.7 // 默认线宽

/** 描边元素 */
const line = (d, w = W) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`

/** 实心元素（三角形/箭头这类没有面积就看不见的形） */
const solid = (d) => `<path d="${d}" fill="currentColor" stroke="none"/>`

/** 描边圆 */
const circle = (cx, cy, r, w = W) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="${w}"/>`

/** 实心小圆点（警告/信息的那一点） */
const dot = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`

/** 描边圆角矩形 */
const rect = (x, y, w, h, rx = 2, sw = W) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="none" stroke="currentColor" stroke-width="${sw}"/>`

/** 四角星（"AI/增强"的统一记号，8 个顶点，几何生成，手写会很啰嗦） */
function star4(cx, cy, r) {
  const pts = []
  const k = 0.26 // 腰宽比例：越小越尖
  const seq = [
    [0, -1],
    [k, -k],
    [1, 0],
    [k, k],
    [0, 1],
    [-k, k],
    [-1, 0],
    [-k, -k]
  ]
  for (const [dx, dy] of seq) pts.push(`${(cx + dx * r).toFixed(2)} ${(cy + dy * r).toFixed(2)}`)
  return solid(`M${pts.join('L')}Z`)
}

/** 齿轮辐条（Settings）：8 根等分放射线，几何生成 */
function gearSpokes(cx, cy, r0, r1) {
  const out = []
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4
    const x0 = (cx + Math.cos(a) * r0).toFixed(2)
    const y0 = (cy + Math.sin(a) * r0).toFixed(2)
    const x1 = (cx + Math.cos(a) * r1).toFixed(2)
    const y1 = (cy + Math.sin(a) * r1).toFixed(2)
    out.push(line(`M${x0} ${y0}L${x1} ${y1}`, 1.9))
  }
  return out
}

/* ────────────────────────── 49 个字形 ──────────────────────────
 * 键 = MAPPING.json 里的 role。缺一个，build-icons 就会退回手绘款，
 * 于是界面上会"少一个参考图标"而不报错 —— 所以下面这份表要与 MAPPING 逐条对得上。
 */
const ICONS = {
  /* 播放控制 */
  IconPlay: [solid('M8 5.5L19 12L8 18.5Z')],
  IconPause: [line('M9.5 5v14', 2.4), line('M14.5 5v14', 2.4)],
  IconSkipBack: [solid('M18 6v12L8.5 12Z'), line('M6 6v12', 2)],
  IconSkipForward: [solid('M6 6v12L15.5 12Z'), line('M18 6v12', 2)],

  /* 编辑 */
  IconUndo: [line('M9 14L4 9L9 4'), line('M20 20v-7a4 4 0 0 0-4-4H4')],
  IconRedo: [line('M15 14L20 9L15 4'), line('M4 20v-7a4 4 0 0 1 4-4h12')],
  IconScissors: [
    circle(6.5, 17.5, 2.8),
    circle(6.5, 6.5, 2.8),
    line('M8.9 8.9L19 19'),
    line('M8.9 15.1L19 5')
  ],
  IconTrash: [
    line('M4 7h16'),
    line('M9.5 7V5.2h5V7'),
    line('M6.6 7L7.7 19.6h8.6L17.4 7'),
    line('M10.4 10.6v6', 1.4),
    line('M13.6 10.6v6', 1.4)
  ],
  IconPlus: [line('M12 5v14'), line('M5 12h14')],
  IconClose: [line('M6 6l12 12'), line('M18 6L6 18')],
  IconCheck: [line('M4.5 12.5L9.5 17.5L19.5 6.5', 2.1)],

  /* 浏览 / 查找 */
  IconSearch: [circle(10.5, 10.5, 6.5), line('M15.4 15.4L20.5 20.5', 2)],
  IconSettings: [circle(12, 12, 3.2), ...gearSpokes(12, 12, 5.8, 9)],
  IconRefresh: [
    line('M20 12a8 8 0 1 1-2.34-5.66'),
    line('M17.66 1v5.34h5.34')
  ],
  IconZoomIn: [circle(11, 11, 7), line('M16.2 16.2L21 21', 2), line('M8.5 11h5'), line('M11 8.5v5')],
  IconGridView: [rect(3.5, 3.5, 7.5, 7.5, 1.6), rect(13, 3.5, 7.5, 7.5, 1.6), rect(3.5, 13, 7.5, 7.5, 1.6), rect(13, 13, 7.5, 7.5, 1.6)],
  IconListView: [
    rect(3.5, 5, 5, 5, 1.2),
    line('M11.5 7.5h9'),
    rect(3.5, 14, 5, 5, 1.2),
    line('M11.5 16.5h9')
  ],
  IconMenu: [line('M4 7h16'), line('M4 12h16'), line('M4 17h16')],

  /* 素材与时间线 */
  IconMedia: [rect(3, 4.5, 18, 15, 3), solid('M10.5 9.5L16 12L10.5 14.5Z')],
  IconMusic: [line('M9 17.5V5l10-2v12.5'), circle(6.5, 17.5, 2.6), circle(16.5, 15.5, 2.6)],
  IconCaption: [rect(3, 5, 18, 14, 2.5), line('M6.5 15.5h8'), line('M6.5 11.5h11')],
  IconText: [line('M5 6h14', 2), line('M12 6v13', 2)],
  IconFolder: [line('M3 7.5A2 2 0 0 1 5 5.5h3.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')],
  IconLayers: [line('M12 2.5L21.5 8L12 13.5L2.5 8Z'), line('M2.5 13L12 18.5L21.5 13')],
  IconClock: [circle(12, 12, 9), line('M12 6.5v5.5L16 14')],

  /* 导入导出 */
  IconExport: [
    line('M21 15v3.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V15'),
    line('M7.5 10L12 5.5L16.5 10'),
    line('M12 5.5V15')
  ],
  IconDownload: [
    line('M21 15v3.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V15'),
    line('M7.5 8L12 12.5L16.5 8'),
    line('M12 12.5V3')
  ],
  IconUpload: [
    line('M16 16L12 12L8 16'),
    line('M12 12v9'),
    line('M20.4 18.4A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3')
  ],

  /* 视图与音量 */
  IconFullscreen: [
    line('M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9'),
    line('M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9'),
    line('M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15'),
    line('M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15')
  ],
  IconVolume: [solid('M4 9.5h3L12 5.5v13L7 14.5H4Z'), line('M15.5 9a4 4 0 0 1 0 6'), line('M18.5 6.5a7.5 7.5 0 0 1 0 11')],
  IconVolumeOff: [solid('M4 9.5h3L12 5.5v13L7 14.5H4Z'), line('M16 9.5l5 5'), line('M21 9.5l-5 5')],
  IconEye: [line('M2.5 12S6 6.5 12 6.5S21.5 12 21.5 12S18 17.5 12 17.5S2.5 12 2.5 12Z'), circle(12, 12, 3.2)],
  IconEyeOff: [line('M2.5 12S6 6.5 12 6.5S21.5 12 21.5 12S18 17.5 12 17.5S2.5 12 2.5 12Z'), line('M4 20L20 4')],
  IconChevronDown: [line('M6 9.5l6 6l6-6', 2)],
  IconChevronRight: [line('M9.5 6l6 6l-6 6', 2)],

  /* 状态与账户 */
  IconUser: [circle(12, 8, 4), line('M4.5 20.5c0-3.6 3.4-5.8 7.5-5.8s7.5 2.2 7.5 5.8')],
  IconAlert: [line('M12 3.5L21.5 20.5h-19Z'), line('M12 9.5v4.5'), dot(12, 17, 1.05)],
  IconInfo: [circle(12, 12, 9), line('M12 11v6'), dot(12, 7.8, 1.05)],
  IconWand: [line('M4.5 19.5L15 9', 2.2), star4(18.5, 5.5, 3.2), star4(9, 4.5, 2)]

  ,
  /* 首页左栏四个导航（参考里是"实心圆角块 + 挖空"，我们是线性，语义一致） */
  IconCreateVideo: [rect(3, 4.5, 18, 15, 3), line('M12 8.5v7'), line('M8.5 12h7')],
  IconDraft: [
    line('M13.5 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9.5Z'),
    line('M13.5 3.5v6h6'),
    line('M8.5 13.5h7', 1.4),
    line('M8.5 16.8h4', 1.4)
  ],
  IconTemplate: [
    rect(3.5, 7.5, 17, 11.5, 2),
    line('M5 4.2h14l1.5 3.3'),
    line('M7.2 4.4L8.7 7.4', 1.4),
    line('M12 4.4L13.5 7.4', 1.4),
    line('M16.8 4.4L18.3 7.4', 1.4),
    solid('M10.6 11L14.4 13.2L10.6 15.4Z')
  ],
  IconToolbox: [
    rect(3, 7.5, 18, 12, 2.5),
    line('M8 7.5V5.5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'),
    line('M3 12.5h18', 1.4),
    line('M9.5 12.5v3', 1.4),
    line('M14.5 12.5v3', 1.4)
  ],

  /* 工作台左栏六个功能（原"实心块 + 挖空"款，改为线性同规格） */
  IconAiVideo: [rect(2.5, 5.5, 13.5, 13, 2.2), solid('M6.5 9.4L11 12L6.5 14.6Z'), star4(19.5, 5.5, 3)],
  IconAiImage: [
    rect(2.5, 5, 13.5, 14, 2.2),
    circle(7, 9.2, 1.7, 1.4),
    line('M3.6 17.6L8 12.6L10.6 15.4L12.6 13.4L15.6 17.6Z', 1.4),
    star4(19.5, 5, 3)
  ],
  IconVideoBoost: [
    rect(2.5, 5.5, 13.5, 13, 2.2),
    line('M6 15L9.2 11.2L11.4 13.6L15 9', 1.6),
    line('M15 9h-2.6', 1.6),
    line('M15 9v2.6', 1.6),
    star4(19.5, 5.5, 3)
  ],
  IconImageBoost: [
    rect(2.5, 5, 13.5, 14, 2.2),
    circle(7, 9.2, 1.7, 1.4),
    line('M3.6 17.6L8 12.6L10.6 15.4L12.6 13.4L15.6 17.6Z', 1.4),
    star4(6.4, 14.6, 2.4)
  ],
  IconLibrary: [rect(3, 6, 5.5, 12, 1.5), rect(9.5, 6, 5.5, 12, 1.5), rect(16, 6, 5.5, 12, 1.5)],
  IconSmartCut: [rect(3, 6.5, 18, 11, 2), line('M12 4.2v15.6'), star4(19.6, 4.4, 2.7)]
}

const HEAD = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
const TAIL = '</svg>'

function svgOf(role) {
  const body = ICONS[role]
  return `${HEAD}\n${body.join('\n')}\n${TAIL}\n`
}

/* ────────────────────────── 主流程 ────────────────────────── */

const mapping = JSON.parse(fs.readFileSync(MAPPING, 'utf8'))
const mapped = mapping.items.filter((x) => x.file)

if (CHECK) {
  const missing = mapped.filter((x) => !ICONS[x.role]).map((x) => x.role)
  if (missing.length) {
    console.error(`OWN_ICONS_MISSING：${missing.length} 个角色没有自绘源：${missing.join(' ')}`)
    process.exit(1)
  }
  console.log(`OWN_ICONS_CHECK_OK 角色 ${mapped.length} 个，自绘源齐全`)
  console.log('OWN_ICONS_CHECK_STATS total=%d ok=%d fail=0', mapped.length, mapped.length)
  process.exit(0)
}

// 1) 清掉旧的参考提取物：raw/ 下的哈希命名件 + 顶层归一化副本（顶层是 raw 的副本，
//    生成器早已不再另存，留着只会让人以为图标"有两份真源"）
const HASH_NAME = /^\d{4}_[0-9a-f]{12}\.svg$/
let removed = 0
if (fs.existsSync(RAW)) {
  for (const name of fs.readdirSync(RAW)) {
    if (HASH_NAME.test(name)) {
      fs.rmSync(path.join(RAW, name))
      removed += 1
    }
  }
}
for (const name of fs.readdirSync(ASSET_DIR)) {
  if (name.endsWith('.svg')) {
    fs.rmSync(path.join(ASSET_DIR, name))
    removed += 1
  }
}

// 2) 写自绘源（文件名 = 角色名，一眼对得上 MAPPING）
let written = 0
for (const role of Object.keys(ICONS)) {
  fs.writeFileSync(path.join(RAW, `${role}.svg`), svgOf(role), 'utf8')
  written += 1
}

// 3) 改写 MAPPING.json：来源从"参考提取物"改成"自绘"
for (const item of mapping.items) {
  if (!ICONS[item.role]) continue
  item.file = `${item.role}.svg`
  item.set = 'own'
  item.page = null
  item.idx = null
  item.dim = '24x24'
  item.confidence = 'high'
  item.notes = '自有版权：tools/build-own-icons.mjs 按 24×24 网格几何生成（单色 currentColor、线性无底板）'
}
fs.writeFileSync(MAPPING, JSON.stringify(mapping, null, 2) + '\n', 'utf8')

console.log(`自有图标源：写入 ${written} 个（24×24 / currentColor / 线性无底板），清掉参考提取物 ${removed} 个`)
console.log(`OWN_ICONS_WROTE total=${written} removed=${removed}`)
