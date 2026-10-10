/**
 * 源码文本扫描的共享基建。
 *
 * 为什么单独抽出来：`tools/check-capability-meta.mjs` 与 `tools/check-workbench-tree.mjs`
 * 都要从 JSX 源码里取"数据表"（能力元数据 / 工作台左栏树）。这些扫描器本身踩过四次坑
 * ——剥注释压掉换行导致行号失真、惰性正则吞掉后续条目、匹配到外层数组就不再往里看、
 * 字符串里的 `//` 被当成注释。**两份实现必然各自演化，然后其中一份静默地漏报**。
 * 所以只留一份，谁要谁引。
 *
 * 统一的取舍（都写在各自的注释里）：
 *   · 一切扫描都是**单趟、从左到右、字符串感知**；
 *   · 一切"跳过一段"都**保留换行**，否则报出的行号会指向不存在的行；
 *   · 一切"匹配到就把这段吃掉"的做法都别用 —— 内层还没看呢。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 跳过从 start 处开始的字符串字面量，返回它的结束位置之后 */
export function skipString(text, start) {
  const quote = text[start]
  let i = start + 1
  const n = text.length
  while (i < n) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === quote) return i + 1
    // 单双引号串不许跨行 —— 否则 JSX 文案里的一个撇号会吞掉后面整段代码
    if (text[i] === '\n' && quote !== '`') return i
    i += 1
  }
  return n
}

/**
 * 去注释，但**保留行号**。
 *
 * 这里是踩过的坑：曾把 `/* … *\/` 整段换成一个空格，多行注释被压成一行，
 * 于是所有报出的行号都指向**不存在的行**（报 `AssetTree.jsx:38`，而真正的问题在 57 行）。
 * 行号错了，读报告的人第一眼就会以为检查器在胡说 —— 所以换成等量空白、照样留换行。
 *
 * 不用正则：正则版本数不清 `'a\'b'` 里的转义，也认不出字符串内部的 `//`（`'https://…'`）。
 */
export function stripComments(text) {
  let out = ''
  let i = 0
  const n = text.length
  const blank = (from, to) => text.slice(from, to).replace(/[^\n]/g, ' ')
  while (i < n) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += blank(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2)
      const stop = end === -1 ? n : end
      out += blank(i, stop)
      i = stop
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const stop = skipString(text, i)
      out += text.slice(i, stop)
      i = stop
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 行号（1 起） */
export function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/**
 * 把对象字面量 / 数组字面量的 body 按**顶层逗号**切成条目。
 *
 * 不能用正则：曾用 `/^\s*key\s*:\s*\{([\s\S]*?)\n\s*\}\s*,?\s*$/gm`，
 * 惰性 `*?` 配上跨行的 `\s*$` 让**第一个匹配一路吞掉了后面几组**，
 * 结果 7 个分组只认出 1 个，报出"18 个能力没有归组"这种完全失真的结论。
 * 括号/方括号/字符串感知的单趟扫描没有这个问题。
 */
export function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  const n = body.length
  while (i < n) {
    const ch = body[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(body, i)
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  parts.push(body.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/**
 * `const NAME = { … }` 在**去注释后**文本里的字符区间（`export` 可有可无）。
 * 供"定义处不算抄本""按区块豁免"这类判断用 —— 整份文件豁免是危险动作，别做。
 *
 * ⚠️ `export` 必须可选：`capabilityMeta.js` 是 `export const X = {`，
 * 而 `SidePanels.jsx` 是 `const GROUPS = {`。只认前者会让后者的整张表读成空，
 * 于是"面板名认不出来"报一堆假错。
 * @returns {{start:number, end:number, open:number}|null}
 */
export function blockRange(text, name) {
  const body = stripComments(text)
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\{`).exec(body)
  if (!match) return null
  const start = match.index
  const open = body.indexOf('{', start)
  let depth = 0
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === "'" || body[i] === '"' || body[i] === '`') {
      i = skipString(body, i) - 1
      continue
    }
    if (body[i] === '{') depth += 1
    else if (body[i] === '}') {
      depth -= 1
      if (depth === 0) return { start, end: i + 1, open }
    }
  }
  return null
}

/** 取出 `const NAME = { ... }` 花括号内的文本（括号平衡，字符串感知） */
export function blockOf(text, name) {
  const range = blockRange(text, name)
  if (!range) return ''
  return stripComments(text).slice(range.open + 1, range.end - 1)
}

/**
 * 取出 `const NAME = [ ... ]` 方括号内的文本（括号平衡，字符串感知）。
 *
 * `blockRange` 只认 `= {`，所以"表是个数组"的情况（如方舟模型目录 `ARK_MODELS = [...]`）
 * 得用它。返回的 `body` 可以直接喂给 `splitTopLevel` 拿每一项。
 * @returns {{body:string, start:number}|null}
 */
export function arrayRange(text, name) {
  const body = stripComments(text)
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[`).exec(body)
  if (!match) return null
  const open = body.indexOf('[', match.index)
  let depth = 0
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === "'" || body[i] === '"' || body[i] === '`') {
      i = skipString(body, i) - 1
      continue
    }
    if (body[i] === '[' || body[i] === '{' || body[i] === '(') depth += 1
    else if (body[i] === ']' || body[i] === '}' || body[i] === ')') {
      depth -= 1
      if (depth === 0) return { body: body.slice(open + 1, i), start: open + 1 }
    }
  }
  return null
}

/** 取出 `const NAME = [...]` 的每一项文本（顶层逗号切分） */
export function arrayItemsOf(text, name) {
  const range = arrayRange(text, name)
  if (!range) return []
  return splitTopLevel(range.body)
}

/**
 * 源码里所有 `[ '…', '…' ]` 字面量数组（字符串感知、括号平衡）。
 *
 * ⚠️ 匹配到一个 `[` 之后**只前进一格**，不能直接跳到配对的 `]`。
 * 早先版本跳过去了，于是"外层数组一旦匹配上就吃掉了整段"，
 * 嵌在里面的数组再也不被访问 —— 而界面上真正装数据的形状恰恰是
 * `items: [ { caps: [...] }, { caps: [...] } ]`（外层数组 / 内层对象 / 最内层数组）。
 */
export function arrayLiterals(text) {
  const out = []
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i)
      continue
    }
    if (ch !== '[') {
      i += 1
      continue
    }
    const items = []
    let nested = false
    let depth = 1
    let j = i + 1
    while (j < n && depth > 0) {
      const cj = text[j]
      if (cj === "'" || cj === '"' || cj === '`') {
        const stop = skipString(text, j)
        if (depth === 1 && cj !== '`') items.push(text.slice(j + 1, stop - 1))
        else nested = true
        j = stop
        continue
      }
      if (cj === '[' || cj === '{' || cj === '(') depth += 1
      else if (cj === ']' || cj === '}' || cj === ')') depth -= 1
      j += 1
    }
    out.push({ index: i, items, nested })
    i += 1
  }
  return out
}

/** `export { … }` 桶导出的名字集合（含 `X as Y` 的 Y） */
export function readExportedNames(text) {
  const names = new Set()
  const body = stripComments(text)
  for (const m of body.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const part of m[1].split(',')) {
      const raw = part.trim()
      if (!raw) continue
      const asMatch = raw.match(/^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/)
      names.add(asMatch ? asMatch[1] : raw)
    }
  }
  return names
}

/** 递归收集目录下指定后缀的文件（跳过 node_modules 与点开头目录） */
export function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, exts, out)
    else if (exts.test(entry.name)) out.push(full)
  }
  return out
}

/** 一组目录下的全部源码文件；目录不存在就跳过（不抛错） */
export function filesOf(dirs) {
  const files = []
  for (const dir of dirs || []) if (fs.existsSync(dir)) files.push(...walk(dir, /\.(m?js|cjs|tsx?|jsx)$/))
  return files
}

/** 读文件；读不到返回空串（让调用方走"缺文件"分支，而不是崩） */
export function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
