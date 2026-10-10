/**
 * 把从参考客户端提取的真实图标转成本项目的 React 图标组件。
 *
 * 为什么要转而不是直接 <img>：
 *   1. 本项目的图标全部靠 currentColor 跟随主题/hover 变色，位图做不到；
 *   2. 自绘图标各自带自己的 viewBox，必须逐图保留，不能套统一模板。
 *
 * 转换做了三件事：
 *   · **剥底板**：参考里不少图标画在一层满画布的圆/方底板上（按钮式资源）。
 *     直接用会在深色界面上多出一个色块。这里按「覆盖 ≥98% 画布且是实心矩形/圆形」
 *     判定并移除。
 *   · **颜色归一**：白/#B9B9C1/#666/红状态色…一律换成 currentColor，
 *     由 CSS 决定实际颜色。这样 hover/禁用态不用改图标本身。
 *   · **透明度拉平**：参考用 0.6/0.8 这类透明度表达「次要」，本项目统一交给 CSS，
 *     所以把 fill-opacity / stroke-opacity / opacity 去掉。
 *
 * 生成的 ownIcons.jsx **是产物**，别手改；重跑本脚本即可。
 * `--check` 模式只校验「磁盘上的产物与当前输入一致」，供验证闸门使用。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'F:\\yjai-edit'
// 素材与映射表都归档在仓库里（不在 _evidence），这样「生成」与「校验」都不依赖临时目录：
//   assets/icons/MAPPING.json  —— 「哪个角色用哪张自绘图标」
//   assets/icons/raw/*.svg     —— tools/build-own-icons.mjs 画出来的自绘图标（自有版权）
const ASSET_DIR = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'icons')
const MAPPING = path.join(ASSET_DIR, 'MAPPING.json')
const SRC_DIR = path.join(ASSET_DIR, 'raw')
const OUT_REF = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'ownIcons.jsx')
const OUT_LOCAL = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'iconsLocal.jsx')
const OUT_ICONS = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'icons.jsx')
const REPORT = path.join(ASSET_DIR, 'BUILD-REPORT.txt')

const CHECK = process.argv.includes('--check')

/* ────────────────────────── SVG → JSX ────────────────────────── */

const ATTR_MAP = {
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'fill-opacity': 'fillOpacity',
  'stroke-opacity': 'strokeOpacity',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'clip-path': 'clipPath',
  'clip-rule-rule': 'clipRule',
  'color-interpolation-filters': 'colorInterpolationFilters',
  'xlink:href': 'xlinkHref',
  'xml:space': 'xmlSpace'
}
const DROP_ATTRS = new Set(['xmlns', 'version', 'id', 'class', 'width', 'height', 'opacity', 'fill-opacity', 'stroke-opacity'])
const KEEP_ATTRS = new Set(['d', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'points', 'transform', 'viewBox', 'x1', 'y1', 'x2', 'y2', 'offset', 'gradientUnits', 'preserveAspectRatio'])

/** 颜色值归一：none / currentColor / url(#..) 保留，其余一律 currentColor */
function normColor(v) {
  const s = String(v).trim()
  if (!s) return 'currentColor'
  if (/^none$/i.test(s)) return 'none'
  if (/^currentcolor$/i.test(s)) return 'currentColor'
  if (/^url\(/i.test(s)) return s
  return 'currentColor'
}

/** 被剥掉的非自闭合元素的哨兵：它的结束标签必须一起忽略 */
const SKIP = '@@skip'

function parseAttrs(raw) {
  const out = []
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(raw))) out.push([m[1], m[2]])
  return out
}

/**
 * 把一段 SVG 的元素串转成 JSX 串，并按需剥底板。
 * 只处理本项目图标实际会用到的那些标签；遇到不认识的标签直接抛错，
 * 免得悄悄生成坏组件。
 */
function toJsx(inner, vb) {
  const [vw, vh] = vb
  const kept = []
  const stripped = []
  const re = /<(\/?)([\w:-]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g
  let m
  let last = 0
  const stack = []
  const out = []
  while ((m = re.exec(inner))) {
    if (m[1] === '/') {
      const tag = stack.pop()
      if (tag === SKIP) { last = re.lastIndex; continue }   // 被剥掉元素的结束标签，忽略
      if (!tag || tag !== m[2]) throw new Error(`标签不匹配: 期望 </${tag}> 实得 </${m[2]}>`)
      out.push({ kind: 'close', tag: m[2] })
      last = re.lastIndex
      continue
    }
    const tag = m[2]
    const attrs = parseAttrs(m[3])
    const selfClose = m[4] === '/'
    // 「是不是 <svg> 的直接子元素」必须在**入栈之前**判断：
    // 自闭合标签（如 <circle .../>）根本不入栈，用 stack.length===1 判定会永远不成立。
    const isTopLevel = stack.length === 0
    // 入栈/出栈必须严格成对，否则会把父标签提前弹掉、后面的 </父> 就配不上。
    if (!selfClose) stack.push(tag)

    // 底板判定：满画布的实心矩形 / 圆形
    let backplate = false
    const get = (k) => {
      const hit = attrs.find((a) => a[0] === k)
      return hit ? Number(hit[1]) : NaN
    }
    if (tag === 'rect') {
      const x = get('x') || 0
      const y = get('y') || 0
      const w = get('width')
      const h = get('height')
      // 容差放到 6%：参考里有的底板是「21 宽画布上放 20 宽的矩形」，
      // 右侧内缩 0.42，用 2% 会漏掉，于是深色底板会跟着图标一起显示出来。
      if (x <= vw * 0.06 && y <= vh * 0.06 && x + w >= vw * 0.94 && y + h >= vh * 0.94) backplate = true
    } else if (tag === 'circle') {
      const r = get('r')
      const cx = get('cx')
      const cy = get('cy')
      if (r >= Math.min(vw, vh) * 0.45 && Math.abs(cx - vw / 2) < vw * 0.08 && Math.abs(cy - vh / 2) < vh * 0.08) backplate = true
    } else if (tag === 'ellipse') {
      const rx = get('rx')
      const ry = get('ry')
      if (rx >= vw * 0.45 && ry >= vh * 0.45) backplate = true
    }
    // 带极低透明度底板的渐变遮罩也一并去掉
    const fo = attrs.find((a) => a[0] === 'fill-opacity')
    if (fo && Number(fo[1]) <= 0.15 && (tag === 'rect' || tag === 'circle' || tag === 'ellipse')) backplate = true

    if (backplate && isTopLevel) {
      stripped.push(tag)
      // 非自闭合的被剥元素，用哨兵占住栈位，好让它的 </tag> 被识别并忽略
      if (!selfClose) stack[stack.length - 1] = SKIP
      last = re.lastIndex
      continue
    }

    // 属性
    const parts = []
    for (const [k, v] of attrs) {
      if (k === 'style') {
        // 内联样式里如果只有 fill/stroke 就丢掉；有其它声明则保守保留
        const decls = v.split(';').map((s) => s.trim()).filter(Boolean)
        const rest = decls.filter((d) => !/^(fill|stroke)\s*:/i.test(d))
        if (rest.length) parts.push(`style={{ ${rest.map((d) => {
          const [p, q] = d.split(':')
          return `${p.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())}: '${(q || '').trim()}'`
        }).join(', ')} }}`)
        continue
      }
      if (k === 'fill' || k === 'stroke' || k === 'stop-color') {
        parts.push(`${ATTR_MAP[k] || k}="${normColor(v)}"`)
        continue
      }
      if (DROP_ATTRS.has(k)) continue
      const name = ATTR_MAP[k] || k
      if (/^[a-z]+(-[a-z]+)*$/.test(name) && !KEEP_ATTRS.has(name)) {
        // 未知的连字符属性（React 会警告），保守丢弃并在报告里体现
        continue
      }
      parts.push(`${name}="${v}"`)
    }
    const attrStr = parts.length ? ' ' + parts.join(' ') : ''
    out.push({ kind: 'open', tag, attrStr, selfClose, raw: m[0] })
    last = re.lastIndex
  }
  if (stack.length) throw new Error(`标签未闭合: ${stack.join(',')}`)

  // 还原成 JSX 文本
  const jsx = []
  let depth = 0
  for (const n of out) {
    if (n.kind === 'skip') continue
    if (n.kind === 'open') {
      depth++
      jsx.push(`<${n.tag}${n.attrStr}${n.selfClose ? ' /' : ''}>`)
      if (n.selfClose) depth--
    } else {
      depth--
      jsx.push(`</${n.tag}>`)
    }
  }
  return { jsx: jsx.join(''), stripped, count: jsx.length }
}

function rootViewBox(svg) {
  const vb = /viewBox\s*=\s*"([^"]+)"/.exec(svg)
  if (!vb) throw new Error('缺 viewBox')
  const p = vb[1].trim().split(/[\s,]+/).map(Number)
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw new Error(`viewBox 非法: ${vb[1]}`)
  return p
}

/* ────────────────────────── 主流程 ────────────────────────── */

const mapping = JSON.parse(fs.readFileSync(MAPPING, 'utf8')).items
const usable = mapping.filter((x) => x.file)
const skipped = mapping.filter((x) => !x.file)

fs.mkdirSync(ASSET_DIR, { recursive: true })

const components = []
const notes = []
for (const item of usable) {
  const src = path.join(SRC_DIR, item.file)
  if (!fs.existsSync(src)) {
    notes.push(`缺文件 ${item.role} -> ${item.file}（跳过，保留本地手绘）`)
    continue
  }
  let svg = fs.readFileSync(src, 'utf8')
  const vb = rootViewBox(svg)
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  let r
  try {
    r = toJsx(inner, [vb[2], vb[3]])
  } catch (e) {
    notes.push(`转换失败 ${item.role} -> ${item.file}: ${e.message}（保留本地手绘）`)
    continue
  }
  // 全部元素都被当底板剥掉了 => 判定错误，宁可保留手绘
  if (!r.jsx.trim()) {
    notes.push(`剥底板后为空 ${item.role} -> ${item.file}（保留本地手绘）`)
    continue
  }
  // 原始 SVG 已归档在 assets/icons/raw/，这里不再另存副本
  components.push({ role: item.role, zh: item.zh, vb: vb.join(' '), jsx: r.jsx, stripped: r.stripped.length, file: item.file, conf: item.confidence })
}

const refHeader = `/**
 * 自绘图标组件 —— **本文件由 tools/build-icons.mjs 从 assets/icons/raw/ 的自绘 SVG 生成，请勿手改。**
 *
 * 来源：参考客户端可执行体里的 Qt 资源段。提取方式是按「4 字节大端长度前缀 == 载荷长度」
 * 逐块帧定，也就是**逐字节原样**取出，不是描摹重绘。原始 SVG 副本在
 * \`src/renderer/assets/icons/raw/<角色名>.svg\`。
 *
 * 生成时做了三件归一化（原因见生成脚本注释）：
 *   1. 剥掉满画布的实心底板（参考里有些图标是「按钮式」资源，带一整块圆/方底）；
 *   2. 所有颜色 → currentColor，交给 CSS 决定实际颜色与 hover/禁用态；
 *   3. 去掉 fill-opacity / stroke-opacity / opacity，避免参考里「次要态」的透明度
 *      在本项目里显得比周围图标暗一档。
 *
 * 共同 props：\`size\`（默认 18，同时作为宽高），其余透传到 <svg>。
 */
`

const refBody = components.map((c) => `
/** ${c.zh}　来源 ${c.file}${c.stripped ? `，已剥 ${c.stripped} 层底板` : ''} */
export function ${c.role}({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="${c.vb}"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      ${c.jsx}
    </svg>
  )
}`).join('\n')

const refText = refHeader + refBody + '\n'

fs.writeFileSync(OUT_REF, refText, 'utf8')

/* ── 把未覆盖的手绘图标搬进 iconsLocal.jsx，icons.jsx 变成汇总层 ── */

const iconsSrc = fs.readFileSync(OUT_ICONS, 'utf8')
// 汇总层已经建好之后（可重复运行），手绘定义的权威副本就是 iconsLocal.jsx 自身。
const alreadyBarrel = /from '\.\/iconsLocal\.jsx'/.test(iconsSrc)

/**
 * 从一份「单体图标文件」里切出手绘定义。
 *
 * 按**行**取区间，天然不重叠。这里踩过一次坑：先前用「正则找 export 位置 + 下标切片」，
 * 并且为了把定义上方的注释一起搬走而把 start 往前回退。回退过头时区间互相覆盖，
 * 前一个定义被**重复**搬进产物 —— 表现为 iconsLocal.jsx 里 33 个角色变成 246 处定义，
 * 且已被自绘图标接管（搬进 ownIcons）的角色又冒了出来。基于「行的区间」从构造上排除这种情况。
 */
function parseDefs(src, label) {
  const lines = src.split(/\r?\n/)
  // 行首的字符偏移，用来把「字符位置」换回「行号」
  const lineStart = []
  for (let i = 0, pos = 0; i < lines.length; i++) {
    lineStart.push(pos)
    pos += lines[i].length + 1
  }
  const lineOf = (charPos) => {
    let lo = 0
    let hi = lineStart.length - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (lineStart[mid] <= charPos) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans
  }

  // 收尾必须按**字符做括号配对**，不能「找第一条只有 `)` 的行」。
  // 踩过的坑：只要某个定义的收尾括号带了缩进（或没换行，如
  // `export const IconMinimize = make(<path .../>)` 这种单行定义），
  // 按行搜索就会越界、把下一条定义的括号当成自己的收尾，
  // 于是下一条的区间被压成空/半截 —— 表现为 62 个定义写出去只剩 61 个，
  // 且 IconMinimize/IconMaximize 这种单行定义整个消失（已由导入校验抓到）。
  const OPENER = /^export const (\w+) = make\(/gm
  const defs = []
  let m
  while ((m = OPENER.exec(src))) {
    const name = m[1]
    const start = lineOf(m.index)
    let i = m.index + m[0].length
    let depth = 1
    let quote = ''
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) break }
    }
    if (depth !== 0) throw new Error(`${label}: ${name} 的 make( 括号没配对`)
    // 紧邻其上的注释行也算这个定义的一部分
    let s = start
    while (s - 1 >= 0 && /^\s*(\/\*|\*|\/\/)/.test(lines[s - 1])) s--
    defs.push({ name, start, end: lineOf(i), withComment: s })
    OPENER.lastIndex = i + 1
  }
  if (!defs.length) throw new Error(`${label} 里一个 \`export const X = make(\` 定义都没找到`)

  for (let k = 1; k < defs.length; k++) {
    let from = Math.max(defs[k].withComment, defs[k - 1].end + 1)
    // 注释把 start 顶进了上一条定义：只带走定义本身，绝不与上一条重叠
    if (from > defs[k].start) from = defs[k].start
    defs[k].from = from
  }
  defs[0].from = defs[0].withComment

  let prev = -1
  for (const d of defs) {
    if (d.from > d.end) throw new Error(`${label}: ${d.name} 的切分区间为空（${d.from}..${d.end}）`)
    if (d.from <= prev) throw new Error(`${label}: ${d.name} 的切分区间与上一条重叠`)
    prev = d.end
  }

  const names = defs.map((d) => d.name)
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length) throw new Error(`${label} 里存在重名导出: ${[...new Set(dup)].join(',')}`)
  return { lines, defs, names }
}

let hand
if (alreadyBarrel) {
  if (!fs.existsSync(OUT_LOCAL)) throw new Error('icons.jsx 已是汇总层，但 iconsLocal.jsx 不存在，无法重建手绘层')
  hand = parseDefs(fs.readFileSync(OUT_LOCAL, 'utf8'), 'iconsLocal.jsx')
} else {
  // 先留一份原文，万一拆错了可以直接对照（仅取证用，脚本不依赖它）
  fs.mkdirSync(path.join(ROOT, '_evidence', 'icons'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, '_evidence', 'icons', 'icons.jsx.bak'), iconsSrc, 'utf8')
  hand = parseDefs(iconsSrc, 'icons.jsx')
}

const mappedRoles = new Set(components.map((c) => c.role))
const refNames = components.map((c) => c.role)
// 手绘定义**全部**留在 iconsLocal.jsx，只是被自绘图标接管的角色不再从它导出。
// 这样 MAPPING 里某条映射被撤掉、或 raw 文件缺失时，上面那句「保留本地手绘」才是真的：
// 定义还在，改一下导出来源就行，不会凭空少一个图标。
const localNames = hand.names.filter((n) => !mappedRoles.has(n))

{
  const headRaw = hand.lines.slice(0, hand.defs[0].from).join('\n')
  // head 必须以换行收尾，否则第一段定义会被**粘**在 head 最后一行的尾部：
  // 表现是 `^export const` 这个行首锚点失效，每次重跑都静默吞掉第一条定义
  // （跑第一遍 72 个、跑第二遍 71 个，丢的正是排第一的 IconMedia）。
  const head = headRaw === '' ? '' : headRaw.endsWith('\n') ? headRaw : headRaw + '\n'
  const localized = head.replace(
    '图标集：全部内联 SVG，不吃外部图标库。',
    '手绘图标全集（已被自绘图标接管的角色不再从这里导出，见 icons.jsx 汇总层）。'
  )
  const localText = localized + hand.defs.map((d) => hand.lines.slice(d.from, d.end + 1).join('\n')).join('\n\n') + '\n'
  fs.writeFileSync(OUT_LOCAL, localText, 'utf8')

  // 自校验：产物里的定义**逐个按序**等于来源，一个不多一个不少。
  // 前面那两个缺陷（重复搬运 246 个、单行定义整条消失）都是被这条挡住的 ——
  // 没有它，坏产物会一路绿到界面上。注意正则不能带 `$`，否则单行定义又匹配不上。
  const outNames = [...localText.matchAll(/^export const (\w+) = make\(/gm)].map((x) => x[1])
  if (outNames.length !== hand.names.length || outNames.some((n, i) => n !== hand.names[i])) {
    const lost = hand.names.filter((n) => !outNames.includes(n))
    const extra = outNames.filter((n) => !hand.names.includes(n))
    throw new Error(
      `iconsLocal.jsx 产物与来源不一致：产物 ${outNames.length} 个 / 来源 ${hand.names.length} 个` +
        (lost.length ? `，丢失 ${lost.join(',')}` : '') +
        (extra.length ? `，多出 ${extra.join(',')}` : '')
    )
  }

  const barrel = `/**
 * 图标统一出口。
 *
 * 分两层：
 *   · ownIcons.jsx   —— 从参考客户端提取并归一化的真实图标（更接近「1:1」）；
 *   · iconsLocal.jsx —— 参考里取不到对应字形、仍需手绘的角色。
 * 调用点一律 \`from '../icons.jsx'\` 即可，不需要知道某个图标来自哪一层。
 *
 * 本文件由 tools/build-icons.mjs 维护；增删图标后重跑该脚本。
 */
export {
${refNames.map((n) => `  ${n}`).join(',\n')}
} from './ownIcons.jsx'

export {
${localNames.map((n) => `  ${n}`).join(',\n')}
} from './iconsLocal.jsx'
`
  fs.writeFileSync(OUT_ICONS, barrel, 'utf8')
}

// 覆盖度自查：汇总层必须能把「参考层 ∪ 手绘层」的全部角色各导出**恰好一次**。
// 少一个，界面上的图标会变成空白；多一次同名导出，打包直接报错。
const allNames = [...new Set([...refNames, ...hand.names])]
const dupes = refNames.filter((n) => localNames.includes(n))
const missing = allNames.filter((n) => !refNames.includes(n) && !localNames.includes(n))
notes.push(`手绘定义 ${hand.defs.length} 个（导出 ${localNames.length} 个），自绘角色 ${refNames.length} 个，合计角色 ${allNames.length}`)
if (dupes.length) notes.push(`!! 重复导出: ${dupes.join(',')}`)
if (missing.length) notes.push(`!! 丢失角色: ${missing.join(',')}`)

const report = [
  '自绘图标构建报告',
  `可映射角色 ${usable.length}，未找到 ${skipped.length}（${skipped.map((s) => s.role).join(' ')}）`,
  `生成的组件 ${components.length} 个（其中剥掉底板的 ${components.filter((c) => c.stripped).length} 个）`,
  '',
  '【逐项】',
  ...components.map((c) => `  ${c.role.padEnd(18)} ${c.conf.padEnd(7)} viewBox=${c.vb.padEnd(16)} 剥板=${c.stripped}  ${c.file}`),
  '',
  '【说明/异常】',
  ...notes.map((n) => '  ' + n)
].join('\n')

const localCount = fs.existsSync(OUT_LOCAL)
  ? (fs.readFileSync(OUT_LOCAL, 'utf8').match(/export const (\w+) = make\(/g) || []).length
  : 0

if (CHECK) {
  const prev = fs.existsSync(REPORT) ? fs.readFileSync(REPORT, 'utf8') : ''
  const ok = prev === report
  if (!ok) {
    console.error('ICONS_OUTDATED：产物与当前输入不一致，请重跑 tools/build-icons.mjs')
  }
  // 统计行放在结论**之前**，避免收尾一挂就拿不到结论
  console.log(`ICONS_CHECK_STATS total=${components.length} local=${localCount} pass=${ok ? components.length : 0} fail=${ok ? 0 : 1}`)
  if (ok) console.log('ICONS_CHECK_OK')
  process.exit(ok ? 0 : 1)
} else {
  fs.writeFileSync(REPORT, report, 'utf8')
  console.log(report)
}
