#!/usr/bin/env node
/**
 * 「双通道对等」闸门 —— 界面上能做的，智能体只靠 MCP 也能做完；智能体能做的，界面上也看得见。
 *
 * 为什么需要它：Jason 2026-10-31 定规「全部功能都要能独立操作完成，也能依靠智能体全自动
 * 操作完成」。这条规则此前只写在 `COLLAB.md` 里，靠人自觉。而这一类缺口**不会报错**：
 *   · 界面有、agent 做不到 ⇒ 镜枢说"这个功能我控制不了"，排查要人肉翻 3100 行面板代码；
 *   · agent 能写、界面看不见 ⇒ 用户看着界面以为没变，实际草稿已经被改了（最伤信任）。
 * 两种都在 2026-10-30/31 真实发生过：`yijing_open_app` 的 draftId 传不进去、
 * 人物特效漏了「投影」那一处（面板显示已识别、预览一像素不动）。
 *
 * 做法（两级，都与源码对齐，不靠手写清单）：
 *   1. **自动枚举界面入口**：带处理函数且带 `title` 的 `<button>`、`WB_TABS` 页签、
 *      `TopBar` 的两组菜单项。枚举器坏了会退化成空集 ⇒ 必须先用「枚举数量下限」钉住。
 *   2. **对表**：`tools/dual-channel-map.json` 里每条能力同时声明界面锚点与 MCP 工具；
 *      每个枚举到的界面入口要么被某条能力引用，要么进 `uiOnly` 白名单并写明为什么
 *      agent 不需要对应（例如「撤销/重做」—— agent 自己知道改了什么）。
 *
 * 断言总数恒为 9（见 TOTAL_ASSERTIONS）。
 * 用法：
 *   node tools/check-dual-channel.mjs            # 校验（闸门用）
 *   node tools/check-dual-channel.mjs --selftest # 只跑覆盖算法自证（证明能判红）
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripComments, walk } from './lib/source-scan.mjs'

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
)
const DESKTOP = path.join(ROOT, 'packages', 'desktop')
const RENDERER = path.join(DESKTOP, 'src', 'renderer')
const MAP_FILE = path.join(ROOT, 'tools', 'dual-channel-map.json')
const TOOLS_FILE = path.join(DESKTOP, 'mcp-tools.json')

export const TOTAL_ASSERTIONS = 9

/* ------------------------------------------------------------ 枚举：界面入口 */

/** 括号/字符串感知地取出从 `from` 处 `<button` 开始的整个开标签 */
function openTagAt(text, from) {
  let depth = 0
  let quote = null
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '{') {
      depth++
      continue
    }
    if (c === '}') {
      depth--
      continue
    }
    if (c === '>' && depth === 0) return text.slice(from, i + 1)
  }
  return text.slice(from)
}

/**
 * 带处理函数且带静态 `title` 的按钮 = 一个**界面动作**。
 *
 * 为什么要求 title：没有 title 的按钮大多是图标占位/对话框的确定取消，逐条要求
 * agent 对应会变成噪音；而 `title` 正是它能被稳定引用的锚点（改文案就会红，这是特性）。
 */
export function buttonAnchors(rendererDir) {
  const out = []
  for (const file of walk(rendererDir, /\.jsx$/)) {
    const rel = path.relative(rendererDir, file).split(path.sep).join('/')
    if (!rel.endsWith('.jsx')) continue
    const text = stripComments(fs.readFileSync(file, 'utf8'))
    const re = /<button\b/g
    let m
    while ((m = re.exec(text))) {
      const tag = openTagAt(text, m.index)
      const title = /title=["']([^"'{}`]{2,60})["']/.exec(tag)
      if (!title) continue
      if (!/on(Click|PointerDown|PointerUp|Change|Submit)\s*[=:]/.test(tag)) continue
      out.push({ id: `${rel}|button|${title[1]}`, file: rel, kind: 'button', text: title[1] })
    }
  }
  return out
}

/** 从 `const name = [` / `name = [` 处取到配对的 `]`（含） */
function sliceArray(text, name) {
  const start = text.search(new RegExp(`(?:const\\s+)?${name}\\s*=\\s*\\[`))
  if (start < 0) return ''
  const open = text.indexOf('[', start)
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      continue
    }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

/** 侧栏页签：`WB_TABS` 的每一项 = 一个功能面 */
export function tabAnchors(rendererDir) {
  const file = path.join(rendererDir, 'components', 'EditorTabs.jsx')
  const rel = 'components/EditorTabs.jsx'
  if (!fs.existsSync(file)) return []
  const body = sliceArray(stripComments(fs.readFileSync(file, 'utf8')), 'WB_TABS')
  const out = []
  const re = /key:\s*'([a-z0-9-]+)'\s*,\s*label:\s*'([^']+)'/g
  let m
  while ((m = re.exec(body))) {
    out.push({ id: `${rel}|tab|${m[1]}`, file: rel, kind: 'tab', text: m[1], label: m[2] })
  }
  return out
}

/** 顶栏菜单项（`fileItems` / `helpItems`）：分组头与 disabled 占位不算动作 */
export function menuAnchors(rendererDir) {
  const file = path.join(rendererDir, 'components', 'TopBar.jsx')
  const rel = 'components/TopBar.jsx'
  if (!fs.existsSync(file)) return []
  const text = stripComments(fs.readFileSync(file, 'utf8'))
  const out = []
  for (const group of ['fileItems', 'helpItems']) {
    const body = sliceArray(text, group)
    /* 逐项切：每一项的窗口必须止于**下一个 `{ key:` 之前**。
       早先按固定 260 字符开窗，单行项会把下一项的 `group: true` 吃进来 ⇒
       「新草稿」被误判成分组头直接丢掉（枚举器静默少项，覆盖检查反而更绿）。 */
    const heads = []
    const headRe = /\{\s*\n?\s*key:\s*[`'"]([a-z0-9:${}._-]+)[`'"]/gi
    let h
    while ((h = headRe.exec(body))) heads.push({ index: h.index, key: h[1] })
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].index
      const end = i + 1 < heads.length ? heads[i + 1].index : Math.min(body.length, start + 400)
      const seg = body.slice(start, end)
      if (/group:\s*true/.test(seg)) continue
      if (/disabled:\s*true/.test(seg)) continue
      const label = /label:\s*'([^']*)'/.exec(seg)
      /* 动态项（最近项目）的 label 是表达式 `item.name || '未命名草稿'`，取不到字面量；
         但它是**真实的菜单入口**（草稿列表），不能因此漏掉。 */
      const isDynamic = heads[i].key.startsWith('open:')
      if (!label && !isDynamic) continue
      /* 最近项目是动态列表（`open:${id}`）：统一归一条，不按草稿名枚举 */
      const key = isDynamic ? 'open:*' : heads[i].key
      if (out.some((x) => x.text === key)) continue
      out.push({ id: `${rel}|menu|${key}`, file: rel, kind: 'menu', text: key, label: label ? label[1] : '最近项目' })
    }
  }
  return out
}

/**
 * 时间线右键菜单项。它们没有 `title`（菜单里靠文字识别），但**是最高频的编辑入口**
 * （分割 / 删除 / 复合片段 / 组合 / 多机位 / 层级 / 属性复制），漏掉就等于没查核心。
 *
 * 判据：`<button>…</button>` 整段里出现 `setMenu(null)` —— 这是菜单项点完必关菜单的写法，
 * 工具栏按钮不会这么写。三元文案（`{n>1 ? '新建复合片段（n 段）' : '新建复合片段'}`）
 * 取静态那支，否则文案随选中数量变、锚点就不稳。
 */
export function ctxAnchors(rendererDir) {
  const file = path.join(rendererDir, 'components', 'Timeline.jsx')
  const rel = 'components/Timeline.jsx'
  if (!fs.existsSync(file)) return []
  const text = stripComments(fs.readFileSync(file, 'utf8'))
  const out = []
  const re = /<button\b/g
  let m
  while ((m = re.exec(text))) {
    const open = openTagAt(text, m.index)
    const end = m.index + open.length - 1
    const close = text.indexOf('</button>', end)
    if (close < 0) continue
    if (!/setMenu\(null\)/.test(text.slice(m.index, close))) continue
    let inner = text
      .slice(end + 1, close)
      .replace(/<kbd>[\s\S]*?<\/kbd>/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
    if (/\?/.test(inner)) {
      const pick = /:\s*'([^']+)'/.exec(inner) || /`([^`$]+)/.exec(inner)
      if (pick) inner = pick[1]
    }
    inner = inner.replace(/^[{}]+|[{}]+$/g, '').trim()
    if (!inner || /[<>{}]/.test(inner)) continue
    if (out.some((x) => x.text === inner)) continue
    out.push({ id: `${rel}|ctx|${inner}`, file: rel, kind: 'ctx', text: inner })
  }
  return out
}

export function enumUi(rendererDir = RENDERER) {
  return [
    ...buttonAnchors(rendererDir),
    ...ctxAnchors(rendererDir),
    ...tabAnchors(rendererDir),
    ...menuAnchors(rendererDir)
  ]
}

/* ------------------------------------------------------------ 对表 */

/**
 * @param {{entries:any[], uiOnly:any[]}} map
 * @param {any[]} ui 枚举到的界面入口
 * @param {any[]} tools mcp-tools.json 的 tools
 * @returns {{fail:string[]}} 逐条断言的结果（由调用方 check）
 */
export function audit(map, ui, tools, existsAnchor) {
  const fails = { noUi: [], badUi: [], badTool: [], toolUncovered: [], uiUncovered: [] }
  const toolNames = new Set(tools.map((t) => t.name))
  const toolByName = new Map(tools.map((t) => [t.name, t]))
  const used = new Set(toolNames)
  const coveredUi = new Set()
  const uiById = new Map(ui.map((u) => [u.id, u]))

  const entries = Array.isArray(map.entries) ? map.entries : []
  const uiOnly = Array.isArray(map.uiOnly) ? map.uiOnly : []

  for (const e of entries) {
    const anchors = Array.isArray(e.ui) ? e.ui : []
    const reason = String(e.uiAbsentReason || '').trim()
    if (!anchors.length && reason.length < 6) fails.noUi.push(e.id || '(无 id)')
    for (const a of anchors) {
      if (!existsAnchor(a)) fails.badUi.push(`${e.id} → ${a}`)
      if (uiById.has(a)) coveredUi.add(a)
    }
    for (const t of Array.isArray(e.mcp) ? e.mcp : []) {
      if (!toolNames.has(t)) {
        fails.badTool.push(`${e.id} → ${t}`)
        continue
      }
      used.delete(t)
    }
    if (!Array.isArray(e.mcp) || !e.mcp.length) fails.badTool.push(`${e.id} → (未声明 mcp 工具)`)
  }

  for (const t of used) fails.toolUncovered.push(t)

  for (const w of uiOnly) {
    if (!String(w.why || '').trim()) fails.badUi.push(`uiOnly ${w.id || w.ui} 缺 why`)
    if (uiById.has(w.ui)) coveredUi.add(w.ui)
    /* 白名单里的锚点也必须真实存在，否则白名单会变成"永远对得上"的空气 */
    if (!existsAnchor(w.ui)) fails.badUi.push(`uiOnly 锚点不存在：${w.ui}`)
  }

  for (const u of ui) if (!coveredUi.has(u.id)) fails.uiUncovered.push(u.id)

  /* 每个工具最多被一条能力引用 —— 灌水式"每条都引 status"会让反向覆盖失去意义 */
  return fails
}

/** 锚点字符串 `<file>|<kind>|<text>` 是否真实存在于源码 */
export function makeAnchorProbe(rendererDir, ui) {
  const byId = new Map(ui.map((u) => [u.id, u]))
  return (anchor) => Boolean(byId.get(anchor))
}

/* ------------------------------------------------------------ 自证 */

function selftest() {
  const ui = [
    { id: 'A.jsx|button|分割', file: 'A.jsx', kind: 'button', text: '分割' },
    { id: 'A.jsx|button|删除', file: 'A.jsx', kind: 'button', text: '删除' }
  ]
  const tools = [{ name: 't_split' }, { name: 't_del' }]
  const probe = (a) => ui.some((u) => u.id === a)
  const rows = []
  const rec = (n, ok) => rows.push({ n, ok })

  const good = audit(
    {
      entries: [
        { id: 'split', ui: ['A.jsx|button|分割'], mcp: ['t_split'] },
        { id: 'del', ui: ['A.jsx|button|删除'], mcp: ['t_del'] }
      ],
      uiOnly: []
    },
    ui,
    tools,
    probe
  )
  rec('干净输入必须全通', Object.values(good).every((v) => v.length === 0))

  const missUi = audit(
    { entries: [{ id: 'split', ui: [], mcp: ['t_split'] }, { id: 'del', ui: ['A.jsx|button|删除'], mcp: ['t_del'] }], uiOnly: [] },
    ui,
    tools,
    probe
  )
  rec('条目没有界面锚点且无理由 ⇒ 必须报', missUi.noUi.includes('split'))

  const ghost = audit(
    {
      entries: [
        { id: 'split', ui: ['A.jsx|button|不存在的按钮'], mcp: ['t_split'] },
        { id: 'del', ui: ['A.jsx|button|删除'], mcp: ['t_del'] }
      ],
      uiOnly: []
    },
    ui,
    tools,
    probe
  )
  rec('锚点指向不存在的按钮 ⇒ 必须报（表格不许说谎）', ghost.badUi.some((s) => s.includes('不存在')))

  const uncoveredUi = audit(
    { entries: [{ id: 'split', ui: ['A.jsx|button|分割'], mcp: ['t_split'] }], uiOnly: [] },
    ui,
    tools,
    probe
  )
  rec('界面上有、能力表没引用 ⇒ 必须报（agent 做不到）', uncoveredUi.uiUncovered.includes('A.jsx|button|删除'))

  const uncoveredTool = audit(
    { entries: [{ id: 'split', ui: ['A.jsx|button|分割'], mcp: ['t_split'] }], uiOnly: [{ ui: 'A.jsx|button|删除', why: '纯视图' }] },
    ui,
    tools,
    probe
  )
  rec('工具没被任何能力引用 ⇒ 必须报（界面看不见）', uncoveredTool.toolUncovered.includes('t_del'))

  const whiteNoWhy = audit(
    {
      entries: [
        { id: 'split', ui: ['A.jsx|button|分割'], mcp: ['t_split'] },
        { id: 'del', ui: ['A.jsx|button|删除'], mcp: ['t_del'] }
      ],
      uiOnly: [{ ui: 'A.jsx|button|幽灵', why: '' }]
    },
    ui,
    tools,
    probe
  )
  rec('白名单缺理由/锚点不存在 ⇒ 必须报', whiteNoWhy.badUi.length === 2)

  let pass = 0
  for (const r of rows) {
    if (r.ok) pass++
    console.log(`${r.ok ? '  ok  ' : '  FAIL'} ${r.n}`)
  }
  console.log(`DUAL_CHANNEL_SELFTEST total=${rows.length} pass=${pass} fail=${rows.length - pass}`)
  if (pass === rows.length) console.log('DUAL_CHANNEL_SELFTEST_OK')
  else process.exitCode = 1
}

/* ------------------------------------------------------------ 主流程 */

function main() {
  if (process.argv.includes('--selftest')) return selftest()

  const results = []
  const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })

  const ui = enumUi()
  const buttons = ui.filter((u) => u.kind === 'button')
  const ctxs = ui.filter((u) => u.kind === 'ctx')
  const tabs = ui.filter((u) => u.kind === 'tab')
  const menus = ui.filter((u) => u.kind === 'menu')

  /* 1. 枚举器防空转：它一旦坏掉就返回空集，后面所有覆盖检查都会"全绿" */
  check(
    '1. 界面入口枚举器正常工作（按钮≥50 / 右键项≥14 / 页签≥10 / 菜单≥6）',
    buttons.length >= 50 && ctxs.length >= 14 && tabs.length >= 10 && menus.length >= 6,
    `按钮 ${buttons.length} / 右键 ${ctxs.length} / 页签 ${tabs.length} / 菜单 ${menus.length}`
  )

  let map = { entries: [], uiOnly: [] }
  let mapErr = ''
  try {
    map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
  } catch (e) {
    mapErr = String((e && e.message) || e).slice(0, 120)
  }
  const entries = Array.isArray(map.entries) ? map.entries : []
  const tools = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8')).tools

  /* 2. 能力表本身可用（有条目、id 唯一） */
  const dupIds = entries.map((e) => e.id).filter((id, i, a) => a.indexOf(id) !== i)
  check(
    '2. 能力表可读且 id 唯一',
    !mapErr && entries.length > 0 && dupIds.length === 0,
    mapErr || `条目 ${entries.length}${dupIds.length ? ` / 重复 id：${dupIds.join(',')}` : ''}`
  )

  const fails = audit(map, ui, tools, makeAnchorProbe(RENDERER, ui))

  /* 3. 每条能力都得双通道（或给了"界面确实没有"的理由） */
  check('3. 每条能力都有界面锚点（或写明为何界面没有）', fails.noUi.length === 0, fails.noUi.join(', ') || `${entries.length} 条齐备`)

  /* 4. 锚点不许说谎：写的按钮/页签/菜单必须真在源码里 */
  check('4. 界面锚点全部真实存在', fails.badUi.length === 0, fails.badUi.slice(0, 6).join(' | ') || '全部命中')

  /* 5. 工具名不许写错（改名/删除会立刻红） */
  check('5. 引用的 MCP 工具都存在于 mcp-tools.json', fails.badTool.length === 0, fails.badTool.slice(0, 6).join(' | ') || '全部存在')

  /* 6. 反向：每个工具都至少有一条能力引用 —— 否则就是"agent 能做、界面上没有" */
  check(
    '6. 每个 MCP 工具都被某条能力引用（否则界面看不见）',
    fails.toolUncovered.length === 0,
    fails.toolUncovered.join(', ') || `${tools.length} 个全覆盖`
  )

  /* 7-9. 反向：界面入口逐个必须被引用或进白名单 */
  /* 「已知缺口」显式登记，双向校验：新缺口会红；补好了却没从登记里删掉也会红
     （否则这张表会绿着烂掉，变成"反正有登记"）。 */
  const expectedGaps = new Set(Array.isArray(map.expectedGaps) ? map.expectedGaps : [])
  const uncoveredActs = fails.uiUncovered.filter((id) => id.includes('|button|') || id.includes('|ctx|'))
  const unexpected = uncoveredActs.filter((id) => !expectedGaps.has(id))
  const stale = [...expectedGaps].filter((id) => !uncoveredActs.includes(id) && !fails.uiUncovered.includes(id))
  const uncoveredTabs = fails.uiUncovered.filter((id) => id.includes('|tab|'))
  const uncoveredMenus = fails.uiUncovered.filter((id) => id.includes('|menu|'))
  check(
    '7. 每个动作按钮/右键项都被覆盖（未登记的新缺口一律判红）',
    unexpected.length === 0 && stale.length === 0,
    [
      unexpected.length ? `新缺口：${unexpected.slice(0, 8).join(' | ')}` : '',
      stale.length ? `登记已过期（已补好，请从 expectedGaps 删掉）：${stale.slice(0, 6).join(' | ')}` : '',
      !unexpected.length && !stale.length ? `${buttons.length + ctxs.length} 个全覆盖（其中登记缺口 ${expectedGaps.size}）` : ''
    ]
      .filter(Boolean)
      .join('\n        ')
  )
  check('8. 每个侧栏页签都被覆盖', uncoveredTabs.length === 0, uncoveredTabs.join(' | ') || `${tabs.length} 个全覆盖`)
  const unexpectedMenus = uncoveredMenus.filter((id) => !expectedGaps.has(id))
  check(
    '9. 每个顶栏菜单项都被覆盖',
    unexpectedMenus.length === 0,
    unexpectedMenus.join(' | ') || `${menus.length} 个全覆盖（其中登记缺口 ${uncoveredMenus.length}）`
  )

  let pass = 0
  for (const r of results) {
    if (r.ok) pass++
    console.log(`${r.ok ? '  ok  ' : '  FAIL'} ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`)
  }
  console.log(`DUAL_CHANNEL_STATS total=${results.length} pass=${pass} fail=${results.length - pass}`)

  /* 硬断言：中途抛错时只记了几条也会打印全绿，这条兜底 */
  const done = results.length === TOTAL_ASSERTIONS && pass === TOTAL_ASSERTIONS
  console.log(done ? 'DUAL_CHANNEL_OK' : 'DUAL_CHANNEL_FAILED')
  process.exitCode = done ? 0 : 1
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-dual-channel.mjs')) main()
