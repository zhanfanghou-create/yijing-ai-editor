#!/usr/bin/env node
/**
 * 工作台左栏（`WB_TREE`）的看门狗 —— 「每个功能标签都有内容、没有死入口」的机械保证。
 *
 * 为什么需要它：左栏是**功能的总目录**，但它是一张数据表，任何一项写错了都不会报错：
 *   · 一项既没有 `caps` 也没有 `panel` → 中间栏退化成"显示全部素材"，
 *     看着像"点了没反应"（用户以为功能丢了，其实是入口没接）；
 *   · `panel` 写了一个 `SidePanels` 里没有的名字 → 中间栏显示
 *     「左侧选一个功能开始」的空壳；
 *   · `caps` 里写了不存在（或写成连字符形式）的能力码 → 那一项**永远筛不出任何素材**；
 *   · `Icon` 写了个不存在的导出 → 那一格渲染成空白；
 *   · **落点（defaultNodeOf 的结果）落在一个"尚未接入"的占位面板上** →
 *     导入完素材，中间栏显示的是"还没做"的说明，用户看不到自己刚导进来的东西。
 * 最后这一条不是假想：`素材` 标签的落点曾经就是「录制」，那个面板写着
 * 「应用内录制尚未接入」。它躺了很久没人发现，因为只有**真的按下导入按钮**
 * 才会显形 —— 合成片那道 E2E 的导入断言因 contextBridge 冻结恒为 SKIP，
 * 只有真实影片 E2E 走主进程打桩、真的按得下去。本脚本把这条钉成静态断言。
 *
 * 断言总数 = 10（全局）+ 1 × 左栏节点数（含可折叠子项）。节点数变了要同步改 scripts/verify.mjs 的 expected。
 *
 * 用法：
 *   node tools/check-workbench-tree.mjs            # 校验（闸门用）
 *   node tools/check-workbench-tree.mjs --selftest # 自证：拿合成夹具把每条失败分支走一遍
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  blockOf,
  readExportedNames,
  splitTopLevel,
  skipString,
  stripComments
} from './lib/source-scan.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

const PATHS = {
  tree: path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'components', 'AssetTree.jsx'),
  side: path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'components', 'SidePanels.jsx'),
  /* ⚠️ 开源版**没有能力码表**：`capabilityMeta.js` 与 `enhancePresets.js` 已随
     那一版的能力页一起删掉。这两个键留在这里是为了让自证夹具仍能注入自己的表
     （下面的断言因此不用改判据）—— 真实运行时读到空串，能力码集合为空，
     而左栏也已经没有任何 caps / enhance 项，两边一致 ⇒ 断言照旧成立。 */
  meta: path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'capabilityMeta.js'),
  icons: path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'icons.jsx'),
  enhance: path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'enhancePresets.js'),
  /* `panel: 'ref-art'` 的项还要带 `refArt: <配图族>`，族名的真值表在 artSet.js */
  refArt: path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'artSet.js')
}

/**
 * 「尚未接入」这类占位面板的判据。
 * 面板组件身体里出现这些词，就认为它还不是一个能给用户用的面板。
 */
const PLACEHOLDER_PHRASES = /尚未接入|还没接上|即将上线|暂未接入|敬请期待/

/* ------------------------------------------------------------- 结构解析 */

/** 与 lib 里同源的最小括号平衡读取：只数同一对括号，字符串感知 */
function balanced(text, open) {
  const o = text[open]
  const c = o === '{' ? '}' : ']'
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i) - 1
      continue
    }
    if (ch === o) depth += 1
    else if (ch === c) {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return ''
}

/** 取 `prop: { … }` 或 `prop: [ … ]` 的**内部**文本 */
function valueBody(text, prop) {
  const match = new RegExp(`(?:^|[\\s,{])${prop}\\s*:`).exec(text)
  if (!match) return ''
  const from = match.index
  const objAt = text.indexOf('{', from)
  const arrAt = text.indexOf('[', from)
  let open = -1
  if (objAt !== -1 && arrAt !== -1) open = Math.min(objAt, arrAt)
  else open = objAt === -1 ? arrAt : objAt
  if (open === -1) return ''
  return balanced(text, open)
}

/**
 * 同 `balanced`，但返回**区间**：`close` 是收尾括号的下标。
 * `balanced` 只给内部文本，调用方拿不到"值到哪结束"，抹不掉这一段。
 */
function balancedSpan(text, open) {
  const inner = balanced(text, open)
  if (!inner) return null
  return { open, close: open + inner.length + 1 }
}

/**
 * 抹掉 `children: …` 这一段，只留下节点**自身**的属性。
 *
 * ⚠️ 不抹掉就会**串味**：`propString(text, 'enhance')` 会命中子项里的
 * `enhance: 'scene'`，于是父项被标成"落点是场景增强"；`propFlag(text, 'mine')`
 * 同理命中子项里的 `mine: true`，把「我的创作」类节点数成 2 个（自证夹具当场抓住）。
 * 根因是这些取值函数都在**整段文本**上跑，而 children 就嵌在这段文本里。
 */
function ownProps(nodeText) {
  const m = /(?:^|[\s,{])children\s*:\s*/.exec(nodeText)
  if (!m) return nodeText
  const at = m.index + m[0].length
  let end = at
  if (nodeText[at] === '[' || nodeText[at] === '{') {
    const span = balancedSpan(nodeText, at)
    end = span ? span.close + 1 : nodeText.length
  } else {
    const name = /^[A-Za-z_$][\w$]*/.exec(nodeText.slice(at))
    end = name ? at + name[0].length : at
  }
  return `${nodeText.slice(0, m.index)} ${nodeText.slice(end)}`
}

const propString = (text, name) => new RegExp(`(?:^|[\\s,{])${name}\\s*:\\s*'([^']*)'`).exec(text)?.[1] || ''
const propFlag = (text, name) => new RegExp(`(?:^|[\\s,{])${name}\\s*:\\s*true\\b`).test(text)

/** `code: { … }` 的一层条目 → [{ key, body }] */
function entriesOf(body) {
  const out = []
  for (const part of splitTopLevel(body)) {
    const key = part.match(/^([A-Za-z_$][\w$]*)\s*:/)?.[1]
    if (key) out.push({ key, body: part })
  }
  return out
}

/**
 * 解析一个左栏节点。
 *
 * 节点有两种来源，但**形状完全相同**：一级项（`items` 里）与可折叠子项
 * （`root.children` / 某一项的 `children` 里）。同一份解析逻辑必须共用，
 * 否则加了一层子项就等于加了一片没有断言的荒地。
 */
function parseNode(text) {
  const capsLiteral = valueBody(text, 'caps')
  const capsRef = /caps\s*:\s*CAPABILITY_GROUPS\.([A-Za-z_$][\w$]*)\.codes/.exec(text)?.[1] || ''
  // 图标可能是字面量（`Icon: IconFolder`），也可能是推导出来的
  // （`Icon: capabilityIcon('tts')`）—— 后者要把**函数名**排除掉，
  // 否则会去 icons.jsx 里找一个叫 capabilityIcon 的导出。
  const iconMatch = /(?:^|[\s,{])Icon\s*:\s*([A-Za-z_$][\w$]*)/.exec(text)
  const iconIsCall = /(?:^|[\s,{])Icon\s*:\s*[A-Za-z_$][\w$]*\s*\(/.test(text)
  return {
    key: propString(text, 'key'),
    label: propString(text, 'label'),
    panel: propString(text, 'panel'),
    Icon: iconMatch && !iconIsCall ? iconMatch[1] : '',
    plain: propFlag(text, 'plain'),
    landing: propFlag(text, 'landing'),
    tasks: propFlag(text, 'tasks'),
    mine: propFlag(text, 'mine'),
    source: propString(text, 'source'),
    /* `generated: true` —— **第三根筛选轴**：只看带 taskNo 的产物（AI 生成结果）。
       与 `source`（用户导入的本地文件）、`tasks`（下载任务列表）不是一回事，
       判"有没有去向"时三条都要认，否则这个入口会被报成死入口。 */
    generated: propFlag(text, 'generated'),
    /* `enhance: 'scene'` —— 中间栏换成增强预设画廊，落点是 enhancePresets 里的组 */
    enhance: propString(text, 'enhance'),
    /* `refArt: 'digitalHuman'` —— 中间栏换成参考配图画廊，落点是 refArt.js 里的族 */
    refArt: propString(text, 'refArt'),
    capsRef,
    // 「有没有 caps」和「caps 里有哪些码」是两回事：`caps` 可以是字面量数组，
    // 也可以是 `Object.values(CAPABILITY_GROUPS).flatMap(…)` 这种表达式。
    // 只看能不能解析出数组，会把后者误判成"没有去向"。
    capsDeclared: /(?:^|[\s,{])caps\s*:/.test(text),
    /* `kinds: ['video']` —— 按**素材自身的产出类型**筛（「素材库 → 视频库 / 图片库 /
       动画库」走这一轴）。它和 caps（按能力码筛）是两条不同的筛选轴，
       判"有没有去向"时必须一起认，否则这三项会被误报成死入口。 */
    kindsDeclared: /(?:^|[\s,{])kinds\s*:/.test(text),
    caps: capsLiteral
      ? splitTopLevel(capsLiteral)
          .map((code) => code.trim().replace(/['"]/g, ''))
          .filter(Boolean)
      : []
  }
}

/**
 * 本文件里**顶层的数组字面量常量**：`const NAME = [ … ]` → 名字 → 内部文本。
 * 用途见 `childrenOf`：`children:` 常常引用一个具名常量而不是直接写数组。
 */
function namedArrayLiterals(text) {
  const out = new Map()
  for (const m of text.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g)) {
    const open = m.index + m[0].length - 1
    const inner = balanced(text, open)
    if (inner) out.set(m[1], inner)
  }
  return out
}

/**
 * 取 `children:` 的值并解析成子节点。三种写法：
 *   children: [ { … }, { … } ]            直接字面量
 *   children: VIDEO_ENHANCE_CHILDREN      本文件里用数组字面量定义的具名常量
 *   children: <别的任何东西>               ⇒ **报为"解析不到"**
 *
 * ⚠️ 第三种绝不能静默当成"没有子项"。实测就是这么栽的：上游把这张表从字面量
 * 改成 `ENHANCE_GROUPS.map(…).filter(…)` 一类推导之后，5 个子项在检查器眼里
 * **一个都不存在** ⇒ 整片看门狗无声消失，而界面上一切照常。
 * 所以解析不到必须是一条可见的失败，附上是个什么名字/表达式。
 */
function childrenOf(nodeText, named) {
  const m = /(?:^|[\s,{])children\s*:\s*/.exec(nodeText)
  if (!m) return { items: [], unresolved: '' }
  const at = m.index + m[0].length
  const parseList = (inner) =>
    splitTopLevel(inner)
      .filter((part) => part.trim().startsWith('{'))
      .map(parseNode)
  if (nodeText[at] === '[') return { items: parseList(balanced(nodeText, at)), unresolved: '' }
  const name = /^[A-Za-z_$][\w$]*/.exec(nodeText.slice(at))?.[0]
  if (name && named.has(name)) return { items: parseList(named.get(name)), unresolved: '' }
  return { items: [], unresolved: (name || nodeText.slice(at, at + 30).split('\n')[0]).trim() }
}

/**
 * 解析 `WB_TREE`。
 * @returns {{tabs:Array<object>, unresolved:Array<{where:string,raw:string}>}}
 */
export function parseTree(text) {
  const named = namedArrayLiterals(text)
  const tabs = []
  const unresolved = []
  for (const tab of entriesOf(blockOf(text, 'WB_TREE'))) {
    const tabBody = valueBody(tab.body, tab.key)
    const rootBody = valueBody(tabBody, 'root')
    const rootKey = propString(ownProps(rootBody), 'key')
    const rootChildren = childrenOf(rootBody, named)
    if (rootChildren.unresolved) {
      unresolved.push({ where: `${tab.key}/${rootKey || 'root'}`, raw: rootChildren.unresolved })
    }
    const items = []
    for (const item of splitTopLevel(valueBody(tabBody, 'items'))) {
      if (!item.trim().startsWith('{')) continue
      // ⚠️ parseNode 收 ownProps(item)：不抹掉 children 就会串味，见 ownProps 注释
      const node = parseNode(ownProps(item))
      const kids = childrenOf(item, named)
      if (kids.unresolved) unresolved.push({ where: `${tab.key}/${node.key}`, raw: kids.unresolved })
      items.push({ ...node, children: kids.items })
    }
    tabs.push({
      key: tab.key,
      root: { key: rootKey, label: propString(ownProps(rootBody), 'label'), children: rootChildren.items },
      items
    })
  }
  return { tabs, unresolved }
}

/** `CAPABILITY_META` 的能力码集合 */
function readCapabilities(text) {
  const codes = new Set()
  for (const part of splitTopLevel(blockOf(text, 'CAPABILITY_META'))) {
    const code = part.match(/^([a-z][a-z0-9_]*)\s*:/)?.[1]
    if (code) codes.add(code)
  }
  return codes
}

/**
 * 取一张「组名 → 组」表的键集合。
 * ⚠️ 名字必须能传：能力元数据里叫 `CAPABILITY_GROUPS`，侧栏那份叫 `GROUPS`
 * —— 写死成前者会让侧栏的四个组（avatar/subtitle/audio/effect）全部读不到，
 * 于是报出一堆"面板名认不出来"的假错。
 */
function readGroupKeys(text, name = 'CAPABILITY_GROUPS') {
  return new Set(entriesOf(blockOf(text, name)).map((entry) => entry.key))
}

/**
 * `ENHANCE_GROUPS` 的组名集合 —— 左栏 `enhance: 'scene'` 这类落点的真值表。
 * 只认 `key: '…'`、只认带 `presets` 的那些条目（`ENHANCE_PRESETS` 里的预设也用 `key:`，
 * 但它们没有 `presets` 数组，靠这一点区分）。
 */
function readEnhanceGroupKeys(text) {
  const body = stripComments(text)
  const block = /ENHANCE_GROUPS\s*=\s*\[([\s\S]*?)\n\]/.exec(body)?.[1]
  if (!block) return new Set()
  const keys = new Set()
  for (const part of splitTopLevel(block)) {
    if (!/^\s*\{/.test(part)) continue
    if (!/\bpresets\s*:/.test(part)) continue
    const key = /(?:^|[\s,{])key\s*:\s*'([^']*)'/.exec(part)?.[1]
    if (key) keys.add(key)
  }
  return keys
}

/**
 * `REF_ART_FAMILIES` → `族名 → Set(能力码)`。
 *
 * 为什么要连能力码一起解析：配图族有**两条挂载路径**，只认其中一条会误报。
 *   ① 节点显式挂：`panel: 'ref-art', refArt: '<族>'` —— 一个族一个专属面板；
 *   ② 能力卡片区挂：`GroupPanel` 里按 `refArtOf(capability)` 取，凡是左栏能走到
 *      某个能力的地方都会带出它的卡片（字幕/音频/特效/图片各组都靠这条路）。
 * 所以「这个族有没有入口」的判据是：**被节点点名** 或 **它某个卡片的能力码可达**。
 * 只按 ① 判的话，② 挂上去的族会被误报成"导了图没人用"（实测就是这样报出 5 个假错）。
 *
 * 族里的 `items:` 是**具名数组常量**（`IMAGE_ENHANCE_PRESETS` 之类），
 * 所以要先取本文件的顶层数组字面量表再逐项读 `capability:`。
 */
function readRefArtFamilies(text) {
  const body = stripComments(text)
  /* 两个名字都认：`REF_ART_FAMILIES` 是旧名，`ART_FAMILIES` 是开源版改名后的名字
     （配图族现在全部自有版权，不再叫"参考配图"）。自证夹具仍在用旧名。 */
  const block = /REF_ART_FAMILIES\s*=\s*\[([\s\S]*?)\n\]/.exec(body)?.[1] ||
    /\bART_FAMILIES\s*=\s*\[([\s\S]*?)\n\]/.exec(body)?.[1]
  const out = new Map()
  if (!block) return out
  const arrays = namedArrayLiterals(body)
  for (const part of splitTopLevel(block)) {
    if (!/^\s*\{/.test(part)) continue
    const key = /(?:^|[\s,{])key\s*:\s*'([^']*)'/.exec(part)?.[1]
    if (!key) continue
    const caps = new Set()
    const itemsExpr = /\bitems\s*:\s*([\s\S]*)$/.exec(part)?.[1] || ''
    for (const nm of itemsExpr.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const inner = arrays.get(nm[1])
      if (!inner) continue
      for (const c of inner.matchAll(/capability\s*:\s*'([^']+)'/g)) caps.add(c[1])
    }
    out.set(key, caps)
  }
  return out
}

/** 一张「组名 → 组」表里每个组的码列表。`CAPABILITY_GROUPS[x].codes` / `GROUPS[m].capabilities` 共用。 */
function readGroupCodes(text, name, field) {
  const map = new Map()
  for (const entry of entriesOf(blockOf(text, name))) {
    const lit = valueBody(entry.body, field)
    const codes = lit
      ? splitTopLevel(lit)
          .map((s) => s.trim().replace(/['"]/g, ''))
          .filter(Boolean)
      : []
    map.set(entry.key, codes)
  }
  return map
}

/** SidePanels 的事实：显式 mode、GROUPS 的键、以及每个 mode 的组件是不是占位面板 */
function readSidePanels(text) {
  const body = stripComments(text)
  const explicitModes = new Set([...body.matchAll(/mode === '([a-z0-9-]+)'/g)].map((m) => m[1]))
  const groupKeys = readGroupKeys(text, 'GROUPS')

  // mode → 它渲染的组件名（`if (mode === 'record') return <RecordPanel …/>`）。
  // ⚠️ `mode === 'x')` 与 `<Component` 之间既可能是 ` return <X/>`（同一行），
  // 也可能是 `) { return ( <X … /> ) }`（多行）。早先只写了这两种精确形状，
  // 结果一个都匹配不上，"占位面板"永远识别出 0 个 —— 而那条断言一旦识别不到就恒真。
  const modeToComponent = new Map()
  for (const m of body.matchAll(/mode === '([a-z0-9-]+)'[\s\S]{0,200}?<([A-Z]\w+)/g)) {
    modeToComponent.set(m[1], m[2])
  }

  // 组件身体 → 是否含占位文案
  const componentOf = (name) => {
    const at = body.search(new RegExp(`function\\s+${name}\\s*\\(`))
    if (at === -1) return ''
    const braceAt = body.indexOf('{', body.indexOf(')', at))
    if (braceAt === -1) return ''
    return balanced(body, braceAt)
  }

  const placeholderModes = new Set()
  for (const [mode, component] of modeToComponent) {
    if (PLACEHOLDER_PHRASES.test(componentOf(component))) placeholderModes.add(mode)
  }

  return { explicitModes, groupKeys, placeholderModes, modeToComponent }
}

/* ------------------------------------------------------------------ 主校验 */

/**
 * @returns {{total:number, ok:number, problems:string[], counts:object}}
 */
export function runCheck(paths = PATHS) {
  const problems = []
  let ok = 0
  let total = 0
  const claim = (pass, label, detail = '') => {
    total += 1
    if (pass) ok += 1
    else problems.push(detail || label)
    console.log(`  ${pass ? '✓' : '✗'} ${label}${pass || !detail ? '' : ` —— ${detail}`}`)
  }
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }

  const treeText = read(paths.tree)
  const sideText = read(paths.side)
  const metaText = read(paths.meta)
  const iconsText = read(paths.icons)
  const enhanceText = read(paths.enhance)
  const refArtText = read(paths.refArt)
  /* ⚠️ 必读的只有这四份。`meta` / `enhance` 是**可选**的：开源版没有能力码表与
     增强预设表，要求它们在位只会让这道闸在"功能已移除"之后一直红。 */
  if (!treeText || !sideText || !iconsText || !refArtText) {
    const missing = [
      ['tree', paths.tree],
      ['side', paths.side],
      ['icons', paths.icons],
      ['refArt', paths.refArt]
    ]
      .filter(([key]) => !read(paths[key]))
      .map(([key]) => key)
    const detail = `读不到这些源文件：${missing.join(' / ')}`
    problems.push(detail)
    return { total: 1, ok: 0, problems, counts: {} }
  }

  const { tabs, unresolved } = parseTree(treeText)
  const capabilities = readCapabilities(metaText)
  const groupKeys = readGroupKeys(metaText)
  const exported = readExportedNames(iconsText)
  const side = readSidePanels(sideText)
  const enhanceGroups = readEnhanceGroupKeys(enhanceText)
  const refArtFamilies = readRefArtFamilies(refArtText)

  /**
   * 左栏里**会渲染成行**的每一个节点：一级项 + 根卡片的子项 + 一级项自己的子项。
   * ⚠️ 只遍历 `items` 是不够的 —— 子项同样是"点下去要能看到东西"的入口，
   * 漏掉它们等于给了一片没有断言的荒地（左栏改成手风琴之后就是这样）。
   */
  const allNodes = tabs.flatMap((tab) => {
    const rootKids = (tab.root.children || []).map((node) => ({ ...node, tab: tab.key, parent: tab.root.key }))
    const itemNodes = tab.items.flatMap((item) => [
      { ...item, tab: tab.key },
      ...(item.children || []).map((node) => ({ ...node, tab: tab.key, parent: item.key }))
    ])
    return [...rootKids, ...itemNodes]
  })

  const panelResolvable = (name) => side.explicitModes.has(name) || side.groupKeys.has(name)

  // ---- 全局 1/10：树解析成功（含「子项写法的解析器看懂了」）----
  const badRoots = tabs.filter((tab) => !tab.root.key || !tab.root.label).map((tab) => tab.key)
  claim(
    /* 8 = 开源版的标签数（素材 / 音频 / 文字 / 特效 / 转场 / 字幕 / 滤镜 / 调节）。
       数字人与素材(贴纸)两页随那一版的功能一起删掉了，下界同步下调；
       「调节」是真功能，补上后下界回升到 8。 */
    tabs.length >= 8 && !badRoots.length && !unresolved.length,
    `WB_TREE 解析出 ${tabs.length} 个标签，每个标签都有 root（键 + 文案），且 children 的写法都看得懂`,
    [
      tabs.length < 8 ? `只解析出 ${tabs.length} 个标签，解析器可能坏了` : '',
      badRoots.length ? `这些标签的 root 缺 key/label：${badRoots.join(', ')}` : '',
      unresolved.length
        ? `children 解析不到（子项会整片失去看门狗）：${unresolved
            .map((u) => `${u.where} → ${u.raw}`)
            .join('；')}。children 只能是数组字面量，或本文件里用数组字面量定义的具名常量`
        : ''
    ]
      .filter(Boolean)
      .join('；')
  )

  // ---- 全局 2/10：同一标签内 key 唯一且不与 root 撞 ----
  // 子项与父项、子项与子项之间也会撞（同一个标签页里渲染成同一列），一并查。
  const dupKeys = []
  for (const tab of tabs) {
    const seen = new Map([[tab.root.key, 1]])
    /* 「标签必须有内容」的真值 = items 或根卡片子项至少有一者非空 ——
       转场/滤镜/特效的分组全挂在根卡片子项上（参考左栏就是根分组展开的子行），
       items 为空是合法形态；一个可点节点都没有才算缺失。 */
    if (!tab.items.length && !(tab.root.children || []).length) dupKeys.push(`${tab.key}（没有 items）`)
    const rows = [
      ...(tab.root.children || []).map((node) => ({ key: node.key, where: `${tab.key}/${tab.root.key}` })),
      ...tab.items.flatMap((item) => [
        { key: item.key, where: `${tab.key}/${item.key}` },
        ...(item.children || []).map((node) => ({ key: node.key, where: `${tab.key}/${item.key}` }))
      ])
    ]
    for (const row of rows) {
      const count = (seen.get(row.key) || 0) + 1
      seen.set(row.key, count)
      if (count === 2) dupKeys.push(`${row.where}（${row.key} 撞了）`)
    }
  }
  claim(!dupKeys.length, '同一标签内所有节点（含子项）的 key 唯一、不与 root 撞、且每个标签都有可点内容（items 或根子项）', `重复或缺失：${dupKeys.join(', ')}`)

  // ---- 全局 3/10：每个节点都有去向 ----
  // 通用项（按来源/按任务/按产物来源列素材，如「本地」「下载」「生成结果」）是刻意不筛的，不算死入口
  const generic = (item) => Boolean(item.source || item.tasks || item.generated)
  const dead = allNodes.filter(
    (item) => !item.panel && !item.capsDeclared && !item.kindsDeclared && !item.enhance && !generic(item)
  )
  claim(
    !dead.length,
    `每个左栏节点都有去向（筛选 / 面板 / 增强组）：${allNodes.length} 个里 ${allNodes.length - dead.length} 个有去向`,
    `既没有 caps 也没有 panel/enhance（点下去是"显示全部素材"，看着像没反应）：${dead.map((item) => `${item.tab}/${item.key}`).join(', ')}`
  )

  // ---- 全局 4/10：每个 panel 都能解析到真实内容 ----
  const panels = [...new Set(allNodes.map((item) => item.panel).filter(Boolean))]
  const badPanels = panels.filter((name) => !panelResolvable(name))
  claim(
    !badPanels.length,
    `左栏用到的 ${panels.length} 个面板名都能解析（显式 mode 分支或 GROUPS 的键）`,
    `这些名字 SidePanels 认不出来 —— 中间栏会显示「左侧选一个功能开始」的空壳：${badPanels.join(', ')}`
  )

  // ---- 全局 5/10：caps 里的能力码都真的存在 ----
  const badCaps = []
  for (const item of allNodes) {
    if ('caps' in item && item.capsRef) continue
    for (const code of item.caps) if (!capabilities.has(code)) badCaps.push(`${item.tab}/${item.key} → ${code}`)
  }
  claim(
    !badCaps.length,
    '左栏筛选用的能力码都在 CAPABILITY_META 里（写成连字符形式会永远筛不出素材）',
    `不认识的能力码：${badCaps.join(', ')}`
  )

  // ---- 全局 6/10：caps 引用的分组存在 ----
  const refs = [...new Set(allNodes.map((item) => item.capsRef).filter(Boolean))]
  const badRefs = refs.filter((key) => !groupKeys.has(key))
  claim(
    !badRefs.length,
    `左栏点名的 ${refs.length} 个能力组都存在`,
    `CAPABILITY_GROUPS 里没有这些组：${badRefs.join(', ')}`
  )

  // ---- 全局 7/10：图标都能导出 ----
  const icons = [...new Set(allNodes.map((item) => item.Icon).filter(Boolean))]
  const badIcons = icons.filter((name) => !exported.has(name))
  claim(
    !badIcons.length,
    `左栏引用的 ${icons.length} 个图标都能从 icons.jsx 导出`,
    `icons.jsx 里没有这些导出（构建不报错，那一格是空白）：${badIcons.join(', ')}`
  )

  // ---- 全局 8/10：enhance 落点与 ENHANCE_GROUPS 一一对应 ----
  /* 这是「点了没反应」最隐蔽的一类：`enhance: 'scne'` 拼错时中间栏画廊是**空的**，
     既不抛错也不影响构建 —— 静态看只是个字符串。所以两个方向都钉：
       · 每个 `enhance:` 都能在 enhancePresets 的 ENHANCE_GROUPS 里找到组；
       · 反过来，每个**非 mine** 的组也都要有左栏入口（加了预设组却忘了挂入口 = 用户永远看不到）。
     防空洞：组读不到（0 个）或节点读不到（0 个）时直接判失败 —— 否则集合相等恒成立。 */
  const enhanceNodes = allNodes.filter((item) => item.enhance)
  const enhanceUsed = [...new Set(enhanceNodes.map((item) => item.enhance))]
  const enhanceExpected = [...enhanceGroups].filter((key) => key !== 'mine')
  const enhanceMissing = enhanceUsed.filter((key) => !enhanceGroups.has(key))
  const enhanceUnmounted = enhanceExpected.filter((key) => !enhanceUsed.includes(key))
  const mineNodes = allNodes.filter((item) => item.mine)
  /* 开源版没有增强预设这一屏 ⇒ 表与入口**同时为空**是合法的，不能判失败。
     只要有一边出现（有表没入口 / 有入口没表），判据立刻按原样生效。 */
  const enhanceOff = enhanceGroups.size === 0 && enhanceNodes.length === 0
  claim(
    enhanceOff ||
      (enhanceGroups.size > 1 &&
        enhanceNodes.length > 0 &&
        !enhanceMissing.length &&
        !enhanceUnmounted.length &&
        mineNodes.length === 1),
    enhanceOff
      ? '左栏没有增强项、也没有增强预设表（开源版不含这一屏）'
      : `「视频增强」子项与 ENHANCE_GROUPS 一一对应（${enhanceExpected.length} 组预设 + 1 组「我的创作」）`,
    enhanceOff
      ? ''
      : enhanceGroups.size <= 1 || !enhanceNodes.length
        ? `检测器空转：解析到 ${enhanceGroups.size} 个组、${enhanceNodes.length} 个 enhance 节点 —— 这条断言会恒真`
        : [
          enhanceMissing.length ? `enhance 写了不存在的组：${enhanceMissing.join(', ')}` : '',
          enhanceUnmounted.length ? `ENHANCE_GROUPS 里有组没有左栏入口：${enhanceUnmounted.join(', ')}` : '',
          mineNodes.length === 1 ? '' : `「我的创作」那类节点应恰好 1 个，实际 ${mineNodes.length} 个`
        ]
          .filter(Boolean)
          .join('；')
  )

  // ---- 全局 9/10：refArt 落点与 REF_ART_FAMILIES 一一对应 ----
  /* 与上一条同形，但治的是另一处：`panel: 'ref-art'` 的项靠 `refArt:` 取配图族，
     拼错一个字母（`'digitalHumna'`）时 RefArtPanel 会渲染「未找到配图族」——
     既不抛错也不影响构建，界面上是一块占位说明，看着像"还没做"。
     两个方向都钉：
       · 每个 `refArt:` 都能在 refArt.js 的 REF_ART_FAMILIES 里找到族；
       · 反过来，每个族也都要**走得到** —— 见下面对"两条挂载路径"的说明。
     防空洞：族读不到或节点读不到时直接判失败 —— 否则集合相等恒成立。 */
  const refArtNodes = allNodes.filter((item) => item.refArt)
  const refArtUsed = [...new Set(refArtNodes.map((item) => item.refArt))]
  const refArtMissing = refArtUsed.filter((key) => !refArtFamilies.has(key))

  /* 「走得到」= 被节点点名(路径①) 或 卡片的能力码可达(路径②)。
     路径② 的可达集合 = 左栏所有能出现的能力码：
       字面 caps ∪ `CAPABILITY_GROUPS.x.codes` ∪ 该节点落到的 `GROUPS[mode].capabilities`。
     第三条必须算上 —— 「字幕/音频/特效」这些分组面板正是靠它把能力卡片带出来的。 */
  const metaGroupCodes = readGroupCodes(metaText, 'CAPABILITY_GROUPS', 'codes')
  const sideGroupCaps = readGroupCodes(sideText, 'GROUPS', 'capabilities')
  const reachableCaps = new Set()
  for (const item of allNodes) {
    for (const c of item.caps) reachableCaps.add(c)
    if (item.capsRef) for (const c of metaGroupCodes.get(item.capsRef) || []) reachableCaps.add(c)
    if (item.panel) for (const c of sideGroupCaps.get(item.panel) || []) reachableCaps.add(c)
  }
  const mountedByNode = (key) => refArtUsed.includes(key)
  const mountedByCapability = (key) => [...(refArtFamilies.get(key) || [])].some((c) => reachableCaps.has(c))
  const refArtOrphan = [...refArtFamilies.keys()].filter((key) => !mountedByNode(key) && !mountedByCapability(key))
  /* 防空洞的第二层：路径① 必须至少命中一个族 —— 若 `refArt:` 的解析静默失效
     （比如 propString 认不出这个字段），"被节点点名"永远为假，所有族一起变成孤儿。
     ⚠️ 路径②（能力卡片区）在开源版**已经不存在**（没有能力码），所以不再要求它有样本：
     现在可达集合恒为空，要求它反而会假红。判据收成"每个族都得有专属面板入口"。 */
  const nodeMountedCount = [...refArtFamilies.keys()].filter(mountedByNode).length
  const capMountedCount = [...refArtFamilies.keys()].filter((k) => !mountedByNode(k) && mountedByCapability(k)).length
  void capMountedCount
  claim(
    refArtFamilies.size > 0 &&
      refArtNodes.length > 0 &&
      !refArtMissing.length &&
      !refArtOrphan.length &&
      nodeMountedCount === refArtFamilies.size,
    `每个配图族都有左栏入口（专属面板 ${nodeMountedCount} / 共 ${refArtFamilies.size} 个族）`,
    refArtFamilies.size === 0 || !refArtNodes.length
      ? `检测器空转：解析到 ${refArtFamilies.size} 个族、${refArtNodes.length} 个 refArt 节点 —— 这条断言会恒真`
      : [
          refArtMissing.length ? `refArt 写了不存在的族：${refArtMissing.join(', ')}` : '',
          refArtOrphan.length ? `ART_FAMILIES 里有族既没被节点点名、能力码也不可达（导了图没人能走到）：${refArtOrphan.join(', ')}` : '',
          nodeMountedCount === refArtFamilies.size ? '' : `有 ${refArtFamilies.size - nodeMountedCount} 个族没有专属面板入口`
        ]
          .filter(Boolean)
          .join('；')
  )

  // ---- 全局 10/10：标签的落点不是"尚未接入"的占位面板 ----
  // 落点顺序必须与 AssetTree 的 `defaultNodeOf()` 一致：先根卡片的子项，再一级项。
  const landings = tabs.map((tab) => {
    const pool = [...(tab.root.children || []), ...tab.items]
    const explicit = pool.find((item) => item.landing)
    const withPanel = pool.find((item) => item.panel)
    const chosen = explicit || withPanel || null
    return { tab: tab.key, key: chosen ? chosen.key : tab.root.key, panel: chosen ? chosen.panel : '', explicit: Boolean(explicit) }
  })
  const onPlaceholder = landings.filter((item) => item.panel && side.placeholderModes.has(item.panel))
  // 防空转：如果占位检测器一个都认不出来，"落点不是占位面板"就恒真了 —— 那是假绿
  claim(
    side.placeholderModes.size > 0 && !onPlaceholder.length,
    `每个标签的落点都不是占位面板（识别到占位面板 ${side.placeholderModes.size} 个：${[...side.placeholderModes].join('/') || '（无）'}）`,
    side.placeholderModes.size === 0
      ? '一个占位面板都没识别出来 —— 检测器本身可能坏了（若占位面板已全部实现，请删掉这条断言并说明）'
      : `这些标签会落在"尚未接入"的面板上：${onPlaceholder.map((item) => `${item.tab} → ${item.key}（panel=${item.panel}）`).join('；')}`
  )

  // ---- 逐节点 1 条（含可折叠子项）----
  for (const item of allNodes) {
    const where = `${item.tab}/${item.key}${item.parent ? `（${item.parent} 的子项）` : ''}`
    const detail = []
    if (!item.key) detail.push('缺 key')
    if (!item.label) detail.push('缺 label')
    const hasDest =
      Boolean(item.panel) ||
      item.capsDeclared ||
      item.kindsDeclared ||
      Boolean(item.enhance) ||
      Boolean(item.refArt) ||
      generic(item)
    if (!hasDest) detail.push('没有去向（既无 panel / enhance / refArt，也无 caps / kinds，也不是通用项）')
    if (item.panel && !panelResolvable(item.panel)) detail.push(`panel「${item.panel}」认不出来`)
    if (item.enhance && !enhanceGroups.has(item.enhance)) detail.push(`enhance「${item.enhance}」在 ENHANCE_GROUPS 里没有`)
    if (item.refArt && !refArtFamilies.has(item.refArt)) detail.push(`refArt「${item.refArt}」在 REF_ART_FAMILIES 里没有`)
    /* refArt 只在 `panel: 'ref-art'` 下被消费；挂在别的面板上等于写了个没人读的字段，
       界面上不会有任何反应 —— 这类"看着接上了、其实没接线"必须报出来。 */
    if (item.refArt && item.panel !== 'ref-art') detail.push(`refArt「${item.refArt}」挂在 panel=${item.panel || '（无）'} 上，不会被消费（只有 panel:'ref-art' 才读它）`)
    if (item.Icon && !exported.has(item.Icon)) detail.push(`图标 ${item.Icon} 未导出`)
    const dest = item.panel
      ? ` → 面板 ${item.panel}${item.refArt ? `（配图族 ${item.refArt}）` : ''}`
      : item.enhance
        ? ` → 增强组 ${item.enhance}`
        : item.capsRef
          ? ` → 组 ${item.capsRef}`
          : item.caps.length
            ? ` → 筛 ${item.caps.length} 个能力`
            : item.capsDeclared
              ? ' → 筛能力（表达式）'
                : item.kindsDeclared
                  ? ' → 按素材类型筛'
                  : item.generated
                    ? ' → 只看生成产物（带 taskNo）'
                    : ' → 通用列表'
    claim(!detail.length, `${where} · ${item.label || '（无文案）'}${dest}`, `${where}：${detail.join('；')}`)
  }

  return {
    total,
    ok,
    problems,
    counts: {
      tabs: tabs.length,
      /* 含可折叠子项 —— 断言总数 = 10 + 这个数 */
      items: allNodes.length,
      panels: panels.length,
      placeholderModes: side.placeholderModes.size,
      enhanceGroups: enhanceGroups.size,
      refArtFamilies: refArtFamilies.size
    }
  }
}

/* ---------------------------------------------------------------------- CLI */

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  } catch {
    return false
  }
})()

if (isMain && process.argv.includes('--selftest')) {
  runSelftest()
  process.exit(process.exitCode || 0)
}

if (isMain) {
  const result = runCheck()
  console.log(`\nWORKBENCH_TREE_CHECK_STATS ok=${result.ok} total=${result.total} problems=${result.problems.length}`)
  if (result.problems.length) {
    console.error('\nWORKBENCH_TREE_CHECK_FAILED')
    for (const problem of result.problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('WORKBENCH_TREE_CHECK_OK')
}

/* ----------------------------------------------------------------- selftest */

/**
 * 自证：拿合成夹具把每条失败分支真的走一遍。
 * 一个只会说 OK 的检查器比没有检查更糟 —— 尤其"落点不是占位面板"这条，
 * 它天生容易变成恒真（检测器认不出占位面板就永远绿），所以自证里既要有
 * "落在占位面板上要报"，也要有"检测器空转要报"。
 */
function runSelftest() {
  let total = 0
  let pass = 0
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-wbtree-'))
  const check = (name, cond, detail = '') => {
    total += 1
    if (cond) {
      pass += 1
      console.log(`  ✓ ${name}`)
    } else {
      console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
    }
  }
  /**
   * 统一的失败detail。
   * ⚠️ 不许直接 `why(r)`：报出 0 条问题时会拼出**空字符串**，
   * 于是屏幕上只剩一个光秃秃的 ✗，分不清"检测器没触发"还是"报了别的问题被
   * `some()` 过滤掉了"。首版 case 7 就这么白跑了一轮。
   */
  const why = (r) =>
    r.problems.length ? `${r.problems.length} 条：${r.problems.join('；')}` : '一条问题都没报出 —— 检测器没被触发'

  const write = (rel, text) => {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text, 'utf8')
    return abs
  }

  const ICONS = `export {\n  IconFolder,\n  IconWand\n} from './iconsLocal.jsx'\n`
  const META = `export const CAPABILITY_META = {
  text_to_image: { label: '文生图', Icon: IconTextImage, kind: 'image', hint: 'h' },
  digital_human: { label: '数字人', Icon: IconUser, kind: 'video', hint: 'h' },
  tts: { label: '语音合成', Icon: IconVolume, kind: 'audio', hint: 'h' }
}

export const CAPABILITY_GROUPS = {
  image: { label: 'AI 图片', hint: 'h', codes: ['text_to_image'] }
}
`

  /**
   * `enhancePresets.js` 的夹具。
   * ⚠️ 里面**必须有 `presets:` 字段** —— 检测器靠它把 `ENHANCE_GROUPS` 的组
   * 与 `ENHANCE_PRESETS` 里的预设区分开（两者都写 `key: '…'`）。
   */
  const ENHANCE = `export const ENHANCE_GROUPS = [
  { key: 'scene', label: '场景增强', presets: ['a'] },
  { key: 'repair', label: '视频修复', presets: ['b'] },
  { key: 'mine', label: '我的创作', mine: true, presets: [] }
]
`

  /** 根卡片夹具：带一个「本地」子项（同时也是显式落点，与真实树一致） */
  const ROOT_WITH_CHILDREN = `    root: {
      key: 'material',
      label: '素材',
      children: [
        { key: 'local', label: '本地', plain: true, source: 'local', landing: true }
      ]
    }`

  /** 左栏树夹具：8 个标签，才能过"至少 8 个标签"那条 */
  const treeOf = (mediaItems, root = ROOT_WITH_CHILDREN) => {
    const filler = ['b', 'c', 'd', 'e', 'f', 'g', 'h']
      .map(
        (name, i) => `
  t${name}: {
    root: { key: 'r-${name}', label: '标签${i}' },
    items: [
      { key: 'i-${name}', label: '项', Icon: IconWand, panel: 'text' }
    ]
  },`
      )
      .join('')
    return `export const WB_TREE = {
  media: {
${root},
    items: [
${mediaItems.join(',\n')}
    ]
  },${filler}
}
`
  }

  const SIDE_OK = `
const GROUPS = {
  enhance: { kicker: 'E', title: '视频增强', note: 'n', capabilities: ['tts'] },
  text: { kicker: 'T', title: '文字', note: 'n', capabilities: ['tts'] }
}

function TextPanel(props) { return <div>可用</div> }
function RecordPanel(props) { return <div><b>应用内录制尚未接入。</b></div> }

export default function SidePanels(props) {
  const { mode } = props
  if (mode === 'text') return <TextPanel />
  if (mode === 'record') return <RecordPanel />
  if (mode === 'ref-art') return <TextPanel />
  const group = GROUPS[mode]
  if (!group) return <div>左侧选一个功能开始</div>
  return <div>{group.title}</div>
}
`

  /**
   * `refArt.js` 的夹具。
   *
   * 故意造**两个族**，因为配图族有两条挂载路径，两条都必须有样本，
   * 否则基线要么过不了新断言，要么让新断言变成单边恒真（见全局 9/10 的说明）：
   *   · `imageEnhance` —— 走路径①：被左栏节点 `refArt:` 点名；
   *   · `digitalHuman` —— 走路径②：靠 `capability: 'digital_human'` 从有该能力码的左栏项可达。
   */
  const REFART = `const IMAGE_ENHANCE_PRESETS = [
  { key: 'ie-a', label: '通用增强', en: 'General Enhance', art: a, capability: 'image_upscale' }
]
const DIGITAL_HUMAN_PRESETS = [
  { key: 'dh-a', label: 'Avatar 1.0', en: 'Avatar 1.0', art: b, capability: 'digital_human' }
]
export const REF_ART_FAMILIES = [
  { key: 'imageEnhance', title: '图片增强', items: IMAGE_ENHANCE_PRESETS },
  { key: 'digitalHuman', title: '数字人', items: DIGITAL_HUMAN_PRESETS }
]
`

  const GOOD_ITEMS = [
    "      { key: 'ai-image', label: 'AI图片', Icon: IconFolder, caret: true, caps: ['text_to_image'] }",
    "      { key: 'audio-tools', label: '音频', Icon: IconWand, caret: true, panel: 'text' }",
    /* 带子项的一级项：子项走 `enhance:` 落点，与 ENHANCE_GROUPS 的 {scene, repair} 对齐 */
    '      {\n' +
      "        key: 'video-enhance',\n" +
      "        label: '视频增强',\n" +
      '        Icon: IconWand,\n' +
      "        panel: 'enhance',\n" +
      '        children: [\n' +
      "          { key: 've-scene', label: '场景增强', enhance: 'scene' },\n" +
      "          { key: 've-repair', label: '视频修复', enhance: 'repair' },\n" +
      "          { key: 've-mine', label: '我的创作', mine: true, caps: ['tts'] }\n" +
      '        ]\n' +
      '      }',
    /* 配图画廊入口：`panel: 'ref-art'` + `refArt: '<族>'`。
       ⚠️ 两个族**各自都要有一个专属入口**：开源版没有能力卡片区，
       「能走到」只剩"被左栏节点点名"这一条路，少一个就是孤儿族。 */
    "      { key: 'image-enhance', label: '图片增强', Icon: IconWand, panel: 'ref-art', refArt: 'imageEnhance', caps: ['digital_human'] }",
    "      { key: 'digital-human', label: '数字人', Icon: IconWand, panel: 'ref-art', refArt: 'digitalHuman' }"
  ]

  const probe = (over = {}) => {
    const tree = write('AssetTree.jsx', over.tree ?? treeOf(over.items ?? GOOD_ITEMS))
    const side = write('SidePanels.jsx', over.side ?? SIDE_OK)
    const meta = write('capabilityMeta.js', over.meta ?? META)
    const icons = write('icons.jsx', over.icons ?? ICONS)
    const enhance = write('enhancePresets.js', over.enhance ?? ENHANCE)
    const refArt = write('refArt.js', over.refArt ?? REFART)
    const original = console.log
    console.log = () => {}
    try {
      return runCheck({ tree, side, meta, icons, enhance, refArt })
    } finally {
      console.log = original
    }
  }

  try {
    // 1) 基准
    let r = probe()
    check('基准夹具通过（8 标签 / 6 个节点（含 3 个子项）/ 面板与能力都认得）', r.problems.length === 0, why(r))
    check(
      '基准夹具断言总数 = 10 + 左栏节点数（含子项）',
      r.total === 10 + r.counts.items,
      `实际 ${r.total}，节点数 ${r.counts.items}`
    )
    check(
      '基准夹具的节点数把根卡片子项与一级项子项都算进来了（9 + 7 = 16）',
      r.counts.items === 16,
      `实际 ${r.counts.items}，应为 1（根卡片子项 local）+ 5（一级项）+ 3（video-enhance 的子项）+ 7×1（填充标签）= 16`
    )

    // 2) 既没 caps 也没 panel 又不是通用项
    r = probe({ items: [...GOOD_ITEMS, "      { key: 'orphan', label: '孤儿项', Icon: IconFolder, caret: true }"] })
    check(
      '左栏项没有去向 → 报出（死入口）',
      r.problems.some((p) => p.includes('既没有 caps 也没有 panel')),
      why(r)
    )

    // 3) panel 名字 SidePanels 认不出来
    r = probe({ items: [...GOOD_ITEMS, "      { key: 'ghost', label: '幽灵面板', Icon: IconFolder, panel: 'nope' }"] })
    check(
      'panel 名认不出来 → 报出（会显示空壳）',
      r.problems.some((p) => p.includes('空壳')),
      why(r)
    )

    // 4) caps 里写了不存在的能力码
    r = probe({ items: [...GOOD_ITEMS, "      { key: 'typo', label: '错码', Icon: IconFolder, caps: ['text-to-video'] }"] })
    check(
      'caps 里有不认识的能力码 → 报出',
      r.problems.some((p) => p.includes('不认识的能力码')),
      why(r)
    )

    // 5) key 重复（这里特意让**一级项**去撞**根卡片的子项** —— 两级都在同一列里渲染）
    r = probe({ items: [...GOOD_ITEMS, "      { key: 'local', label: '重复键', Icon: IconFolder, panel: 'text' }"] })
    check('key 重复（跨"一级项 vs 根卡片子项"）→ 报出', r.problems.some((p) => p.includes('重复或缺失')), why(r))

    // 6) 图标未导出
    r = probe({ items: [...GOOD_ITEMS, "      { key: 'badicon', label: '坏图标', Icon: IconGhost, panel: 'text' }"] })
    check('图标未导出 → 报出', r.problems.some((p) => p.includes('那一格是空白')), why(r))

    // 7) 落点落在"尚未接入"的占位面板上
    //    这条不是假想：`素材` 标签的落点曾经就是「录制」，那个面板写着
    //    「应用内录制尚未接入」—— 导入完素材，中间栏显示的是"还没做"的说明。
    //    ⚠️ 夹具必须把 `record` 做成**真的落点**。默认落点规则是"先看显式
    //    landing，否则取第一个带 panel 的项"；GOOD_ITEMS 里的 local 带着
    //    landing，直接拼进来落点仍是 local，这条断言就永远碰不到 —— 首版
    //    正是这么假绿的（连 detail 都是空的，看不出来）。
    r = probe({
      /* ⚠️ 根卡片要换成**没有子项**的版本：根卡片子项里的「本地」带 landing，
         它排在一级项前面，落点就会是「本地」⇒ 这条用例永远碰不到占位面板。 */
      tree: treeOf(
        [
          "      { key: 'record', label: '录制', plain: true, panel: 'record' }",
          "      { key: 'local', label: '本地', plain: true, source: 'local' }",
          "      { key: 'ai-image', label: 'AI图片', Icon: IconFolder, caret: true, caps: ['text_to_image'] }"
        ],
        "    root: { key: 'material', label: '素材' }"
      )
    })
    check(
      '落点是占位面板（尚未接入）→ 报出',
      r.problems.some((p) => p.includes('尚未接入')),
      why(r)
    )

    // 8) 占位检测器空转（SidePanels 里没有占位文案）→ 也要报，防这条断言恒真
    r = probe({ side: SIDE_OK.replace('<b>应用内录制尚未接入。</b>', '可用') })
    check(
      '占位检测器一个都没识别到 → 报出（防空转）',
      r.problems.some((p) => p.includes('检测器本身可能坏了')),
      why(r)
    )

    // 9) caps 引用了一个不存在的组
    r = probe({ items: [...GOOD_ITEMS, "      { key: 'badref', label: '坏引用', Icon: IconFolder, caps: CAPABILITY_GROUPS.nope.codes }"] })
    check('caps 引用不存在的组 → 报出', r.problems.some((p) => p.includes('CAPABILITY_GROUPS 里没有这些组')), why(r))

    // 10) 某个标签没有任何可点内容（items 与根子项全空）→ 报出
    //     ⚠️ 标签键是 `tb` 不是 `t b`（treeOf 用 `t${name}` 拼出来），
    //     首版正则按模板字面量的空格去写，永远匹配不上 ⇒ 替换静默失效、断言恒绿。
    r = probe({
      tree: treeOf(GOOD_ITEMS).replace(
        /  tb: \{[\s\S]*?\n  \},/,
        "  tb: {\n    root: { key: 'r-b', label: '标签0' },\n    items: []\n  },"
      )
    })
    check('某个标签没有任何可点内容 → 报出', r.problems.some((p) => p.includes('没有 items')), why(r))

    // 10b) 反向：items 为空但根卡片带子项（转场/滤镜/特效的参考分组树形态）→ 不报
    r = probe({
      tree: treeOf(GOOD_ITEMS).replace(
        /  tb: \{[\s\S]*?\n  \},/,
        "  tb: {\n    root: { key: 'r-b', label: '标签0', children: [{ key: 'r-b0', label: '子项', panel: 't-b' }] },\n    items: []\n  },"
      )
    })
    check('items 空 + 根子项非空 → 不算缺失', !r.problems.some((p) => p.includes('没有 items')), why(r))

    // 11) 文件读不到 → 报错而不是崩
    let crashed = null
    let r11 = null
    try {
      const original = console.log
      console.log = () => {}
      try {
        r11 = runCheck({
          tree: path.join(dir, 'nope-tree.jsx'),
          side: path.join(dir, 'nope-side.jsx'),
          meta: path.join(dir, 'nope-meta.js'),
          icons: path.join(dir, 'nope-icons.jsx'),
          enhance: path.join(dir, 'nope-enhance.js')
        })
      } finally {
        console.log = original
      }
    } catch (error) {
      crashed = error
    }
    check(
      '文件读不到 → 报错且不崩',
      !crashed && r11 && r11.problems.some((p) => p.includes('读不到')),
      crashed ? `抛异常：${crashed.message}` : (r11?.problems || []).join('；')
    )

    // 12) label 为空
    r = probe({ items: [...GOOD_ITEMS, "      { key: 'nolabel', label: '', Icon: IconFolder, panel: 'text' }"] })
    check('label 为空 → 报出', r.problems.some((p) => p.includes('缺 label')), why(r))

    /* 13) `enhance:` 写了 ENHANCE_GROUPS 里没有的组
     *     这一类的症状最隐蔽：中间栏画廊是**空的**，不抛错、不影响构建，
     *     静态看只是个字符串 —— 正是"点了没反应"四类里最难发现的那种。 */
    r = probe({
      tree: treeOf([
        ...GOOD_ITEMS.slice(0, 2),
        '      {\n' +
          "        key: 'video-enhance',\n" +
          "        label: '视频增强',\n" +
          '        Icon: IconWand,\n' +
          "        panel: 'enhance',\n" +
          '        children: [\n' +
          "          { key: 've-scene', label: '场景增强', enhance: 'scne' },\n" +
          "          { key: 've-repair', label: '视频修复', enhance: 'repair' },\n" +
          "          { key: 've-mine', label: '我的创作', mine: true, caps: ['tts'] }\n" +
          '        ]\n' +
          '      }'
      ])
    })
    check(
      'enhance 写了不存在的组（拼错）→ 报出',
      r.problems.some((p) => p.includes('enhance 写了不存在的组')),
      why(r)
    )

    /* 14) 反过来：ENHANCE_GROUPS 里加了组，却忘了在左栏挂入口
     *     ⇒ 用户永远看不到那组预设（预设有、图有、能力也有，就是没入口）。 */
    r = probe({
      enhance: ENHANCE.replace(
        "{ key: 'repair', label: '视频修复', presets: ['b'] },",
        "{ key: 'repair', label: '视频修复', presets: ['b'] },\n  { key: 'portrait', label: '人像修复', presets: ['c'] },"
      )
    })
    check(
      'ENHANCE_GROUPS 里有组却没有左栏入口 → 报出',
      r.problems.some((p) => p.includes('有组没有左栏入口')),
      why(r)
    )

    /* 15) 检测器空转：解析不到任何 enhance 节点 / 任何组 ⇒ 集合相等恒真，必须报出来 */
    r = probe({
      enhance: 'export const ENHANCE_GROUPS = []\n',
      items: GOOD_ITEMS.slice(0, 2)
    })
    check(
      'enhance 组与节点都解析不到 → 报出（防空转）',
      r.problems.some((p) => p.includes('检测器空转')),
      why(r)
    )

    /* 16) `children:` 写成了检查器看不懂的东西 ⇒ 必须报出来，不能静默当成"没有子项"
     *     （真实教训：上游把它改成 `.map()` 一类的推导之后，子项整片失去看门狗） */
    r = probe({
      tree: treeOf([
        ...GOOD_ITEMS.slice(0, 2),
        '      {\n' +
          "        key: 'video-enhance',\n" +
          "        label: '视频增强',\n" +
          '        Icon: IconWand,\n' +
          "        panel: 'enhance',\n" +
          '        children: ENHANCE_GROUPS.map((g) => ({ key: g.key, label: g.label }))\n' +
          '      }'
      ])
    })
    check(
      'children 解析不到（推导写法）→ 报出，且不是静默为空',
      r.problems.some((p) => p.includes('children 解析不到') && p.includes('ENHANCE_GROUPS')),
      why(r)
    )

    /* 17) `refArt:` 拼错一个字母 —— RefArtPanel 渲染「未找到配图族」，
     *     不抛错、不影响构建，界面上是一块说明文字，看着像"这功能还没做"。
     *     与 13) 同类，只是换到了配图这条路。 */
    r = probe({
      tree: treeOf([
        ...GOOD_ITEMS.slice(0, 2),
        "      { key: 'ie', label: '图片增强', Icon: IconWand, panel: 'ref-art', refArt: 'imageEnhnace' }"
      ])
    })
    check(
      'refArt 写了不存在的族（拼错）→ 报出',
      r.problems.some((p) => p.includes('refArt 写了不存在的族')),
      why(r)
    )

    /* 18) 反过来：导了图、写了数据，但既没被节点点名、能力码也不可达
     *     ⇒ 那批图白占安装包，用户一辈子走不到。 */
    r = probe({
      refArt: REFART.replace(
        "  { key: 'digitalHuman', title: '数字人', items: DIGITAL_HUMAN_PRESETS }",
        "  { key: 'digitalHuman', title: '数字人', items: DIGITAL_HUMAN_PRESETS },\n  { key: 'orphanFam', title: '没人用', items: IMAGE_ENHANCE_PRESETS }"
      )
    })
    check(
      'REF_ART_FAMILIES 里有族没人挂载（导了图走不到）→ 报出',
      r.problems.some((p) => p.includes('既没被节点点名、能力码也不可达')),
      why(r)
    )

    /* 19) `refArt:` 挂在非 ref-art 的面板上 —— 字段写在那但没人读，界面上毫无反应。
     *     这类"看着接上了、其实没接线"静态读代码是看不出来的。 */
    r = probe({
      tree: treeOf([
        ...GOOD_ITEMS.slice(0, 2),
        "      { key: 'ie', label: '图片增强', Icon: IconWand, panel: 'text', refArt: 'imageEnhance' }"
      ])
    })
    check(
      'refArt 挂在非 ref-art 面板上 → 报出（写了没人读）',
      r.problems.some((p) => p.includes('不会被消费')),
      why(r)
    )

    /* 20) 只靠能力码可达、却没有专属面板入口的族必须报出来。
     *     开源版没有能力卡片区，所以"能走到"只剩「被左栏节点点名」这一条路；
     *     这条夹具正是为了钉住它 —— 少了它，孤儿族会静默变绿。 */
    r = probe({
      items: GOOD_ITEMS.filter((line) => !line.includes("key: 'digital-human'"))
    })
    check(
      '只靠能力码可达的族 → 报出（没有专属面板入口）',
      r.problems.some((p) => p.includes('没有专属面板入口')),
      why(r)
    )
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录残留不影响结论 */
    }
  }

  console.log(`\nWORKBENCH_TREE_CHECK_SELFTEST pass=${pass} total=${total}`)
  if (pass !== total) {
    console.error('WORKBENCH_TREE_CHECK_SELFTEST_FAILED')
    process.exitCode = 1
    return
  }
  console.log('WORKBENCH_TREE_CHECK_SELFTEST_OK')
}
