#!/usr/bin/env node
/**
 * 相对导入 · 命名绑定校验器。
 *
 * 为什么需要它：Node 的 ESM 只在**运行时**解析相对路径，
 * `node --check` 只做语法检查、不解析导入，所以 "路径写错一层"
 * 这类错误能骗过语法检查，直到真正启动才炸。
 *
 * 后来发现更坏的一类（2026-09-21 实际踩到，代价是一轮白工）：
 *
 *   ```
 *   const k = await fetchHomeAssets(r)      // 用了
 *   ```
 *   而 `fetchHomeAssets` **压根没写进 import 列表**。
 *
 *   这类缺陷的隐蔽性在于它是"少写了一个词"，而不是"写错了一个词"：
 *     · 语法完全合法 —— 未声明的标识符在 JS 里是合法的"自由变量"引用；
 *     · `node --check` 通过；
 *     · Vite/Rollup **不报错也不告警**，把它当浏览器全局原样保留在产物里
 *       （"import 不存在"才会告警，"根本没 import"是静默的）；
 *     · 本地构建"成功"，只有真的把产物跑起来才 ReferenceError。
 *   实测产物里 `fetchHomeAssets` 只剩一个调用点、`/api/home-assets` 字面量为 0，
 *   而构建日志 0 warning —— 光看构建结果是不可能发现的。
 *
 * 所以这个脚本做三件事：
 *   1. 路径可解析（原有）；
 *   2. 命名导入**确实存在**（拼错 / 上游改名会在这条暴露）；
 *   3. 从"本文件已导入的模块"导出的名字里，找出**在正文里被使用、却既没导入
 *      也没本地声明**的符号 —— 也就是上面那个自由变量。
 *
 * 第 3 条刻意把搜索范围收窄成「本文件已经 import 过的那些模块的导出」，
 * 而不是全仓库符号表：范围越小误报越少，而本次这类缺陷恰好 100% 落在范围内
 * （既然文件已经从 api.js 导入了别的东西，那 api.js 的导出就是"触手可及"的）。
 *
 * 用法：node tools/check-imports.mjs <目录> [<目录>...]
 */
import fs from 'node:fs'
import path from 'node:path'

const roots = process.argv.slice(2)
if (!roots.length) {
  console.error('用法：node tools/check-imports.mjs <目录> [...]')
  process.exitCode = 2
} else {
  main()
}

function main() {

const EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json']
const CODE_EXTS = /\.(m?js|cjs|tsx?|jsx)$/

/**
 * 以 `set` + 大写开头、但**本来就不是本地绑定**的全局函数。
 * 只有"不带点直接调用"的才需要列在这里 —— `el.setPointerCapture(...)` 这类成员调用
 * 已被第 4 条的正则 `(?<![\w$.])` 排除，不必也不该写进白名单。
 */
const WEB_GLOBALS = new Set(['setTimeout', 'setInterval', 'setImmediate'])

/**
 * JS 关键字。第 5 条会扫"小写开头的标识符"，不排掉这些就会把 `return` 之类报成自由变量。
 * 这里只列**小写或全小写**的（大写开头的本来就不在第 5 条的候选里）。
 */
const JS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function',
  'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'set', 'static',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'true', 'false', 'null', 'undefined', 'arguments', 'eval'
])

/**
 * 这些关键字后面跟 `/`，那个 `/` 一定是正则字面量的起点而不是除号
 * （`return /x/`、`case /x/:`、`typeof /x/`）。
 * 少了这张表，`return /abc/` 会被当成 `return` 除以 `abc`，
 * 于是正则里的内容原样漏进正文 —— 正是本次实测到的那批误报。
 */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof',
  'do', 'else', 'yield', 'await', 'throw'
])

/**
 * 运行时全局。第 5 条的候选是"小写开头的裸标识符"，
 * 少了这张表就会把 `document` / `fetch` / `structuredClone` 报成自由变量。
 * 只列**真的会以裸标识符出现**的；`Element` 这类大写的天然不在候选里。
 */
const RUNTIME_GLOBALS = new Set([
  // 计时 / 调度
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'queueMicrotask', 'setImmediate',
  // 编码 / 解析
  'atob', 'btoa', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'structuredClone', 'escape', 'unescape',
  // 控制台 / 全局对象
  'console', 'window', 'document', 'navigator', 'location', 'history', 'screen', 'self',
  'globalThis', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'performance',
  'getComputedStyle', 'matchMedia', 'alert', 'confirm', 'prompt', 'postMessage', 'open',
  'close', 'focus', 'blur', 'scroll', 'scrollTo', 'scrollBy', 'addEventListener',
  'removeEventListener', 'dispatchEvent', 'fetch', 'crypto', 'webkit',
  // 尺寸 / DPR
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio',
  'visualViewport', 'pageXOffset', 'pageYOffset', 'scrollX', 'scrollY',
  // 绘制 / 媒体
  'createImageBitmap', 'requestVideoFrameCallback',
  // Node / 打包器注入
  'process', 'require', 'module', 'exports', 'Buffer', 'global',
  '__dirname', '__filename',
  // 杂项
  'NaN', 'Infinity'
])

/* ---------------- 第 5 条用的两个"自维护"白名单 ---------------- */
/**
 * JSX 的标签名与属性名是**开放集合**，手写名单只会写漏，所以从代码库自身反推：
 *   · JSX_TAGS   —— 所有出现过的小写标签名（`<div>` / `<video>` / `<section>` …）
 *   · JSX_ATTRS  —— 所有出现过的 JSX 属性名
 *
 * 为什么必须让它们自维护：JSX 的标签和属性名是**开放集合**（HTML/SVG 标签几百个、
 * 属性还有 `aria-*` / `data-*` / 各种事件名），手写名单只会写漏；
 * 而写漏的后果是**误报**，误报会让人开始无视这个检查器 —— 那比漏报更糟。
 * 反过来说，从代码库自身反推的白名单天然不会漏：只要某属性在本仓库里被用过一次，
 * 它就不可能被当成自由变量。
 *
 * 所以这两张表从代码库自身反推，见 `jsxTablesOf()`。
 * 而且它们**按文件**存、不做全库合并 —— 理由见 `jsxTablesOf()` 的注释（吃过那个亏）。
 */


/* ------------------------------------------------------------------ 词法工具 */

/**
 * 跳过一段不使用模板插值的引号串（`'...'` / `"..."`）。返回结束后的下标。
 * 普通引号不跨行：撞到换行说明这个引号其实不是串的开头（`"'"` 这种引号里套另一种
 * 引号），就地收手，别把后面整段代码吞进去。
 */
function skipSimpleString(text, i) {
  const quote = text[i]
  let j = i + 1
  const n = text.length
  while (j < n) {
    const c = text[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === quote) return j + 1
    if (c === '\n') return j
    j += 1
  }
  return n
}

/**
 * 跳过一整个模板串（含嵌套的模板串与 `${}` 插值）。返回结束后的下标。
 *
 * ⚠️ 2026-09-23 补：原来没有这个函数，模板串的收尾是靠"找同类型的下一个引号"，
 * 于是遇到**嵌套模板串**就提前收尾：
 *    `${Object.keys(patch).map((key) => `${key} = ?`).join(', ')}`
 * 扫描器把内层反引号当成了外层的收尾 ⇒ 后面的 `{key} = ?` 被当成**正文代码**漏出来，
 * 报出假自由变量 `key`。漏出来的还只是冰山一角 —— 同一段里任何字符串内容都会
 * 以"代码"的身份进入扫描，全是噪声，而噪声会让人开始无视这个检查器。
 */
function skipTemplate(text, i) {
  let j = i + 1
  const n = text.length
  while (j < n) {
    const c = text[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '`') return j + 1
    if (c === '$' && text[j + 1] === '{') {
      j = skipBraced(text, j + 2)
      continue
    }
    j += 1
  }
  return n
}

/**
 * 从 `${` 之后开始，跳过配平的 `}`。返回 `}` **之后**的下标。
 * 与 skipTemplate 互为递归（插值里可以有模板串，模板串里又可以有插值）。
 */
function skipBraced(text, i) {
  let depth = 1
  let j = i
  const n = text.length
  while (j < n) {
    const c = text[j]
    if (c === "'" || c === '"') {
      j = skipSimpleString(text, j)
      continue
    }
    if (c === '`') {
      j = skipTemplate(text, j)
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return j + 1
    }
    j += 1
  }
  return n
}

/**
 * 去掉注释与字符串字面量，避免在它们里面"发现"标识符。
 *
 * ⚠️ 必须**单趟从左到右扫描**，不能写成几个独立的正则 replace 串起来 ——
 * 那是 2026-09-21 修掉的真实缺陷：
 *
 *   旧写法先替换注释、再替换模板串、再替换引号串，各步之间**互相不知道对方的存在**。
 *   于是 `Backquote: '`'` 里那个「位于单引号串内部的**反引号**」会被模板串正则
 *   当成分隔符，跟后面 `\`F${i}\`` 的起始反引号配成一对，把两者之间**约 1500 字符
 *   的真实代码整段替换成一个空串**。落点恰好是 keymap.js 的
 *   `export function comboOf` —— 它明明存在，却被报成「导出的名字不存在」。
 *
 *   误报还只是表象。反方向才是要命的：**任何真实缺陷只要落进被吃掉的区间，就会被
 *   静默漏报** —— 而"抓这种漏报"正是本检查器存在的唯一理由。
 *   单趟扫描时引号串是**原子**的（串内部的反引号只是普通字符），这类串扰不再可能。
 *
 * 局限（已知、可接受）：正则字面量里若出现引号（如 `/["']/`），会被当成串的起点，
 * 该行剩余部分被吃掉。
 *
 * ⚠️ 2026-09-22 补：**正则字面量本身**也必须吃掉，否则第 5 条（自由变量）会大量误报 ——
 * `/\.(mp4|mov|webm)$/` 里的 `mp4/mov/webm`、`/&quot;/g` 里的 `quot`、
 * `/^[a-z0-9]+$/` 里的 `z0` 都会被当成"用了但没声明的标识符"。
 * 这是实测出来的：补这一条之前，38 条报告里过半出自正则字面量。
 *
 * 判"这个 `/` 是正则还是除号"用的是经典启发式：看**前一个有效 token**。
 * 前面是 `)`/`]`/标识符/数字 ⇒ 除号（`(a+b)/2`、`len / 3`）；
 * 前面是 `(`/`=`/`,`/`:`/`[`/`!`/`&`/`|`/`?`/`{`/`}`/`;` 这些"只能接表达式"的位置，
 * 或前面是 `return`/`typeof`/`case`/`of`/`in` 等关键字 ⇒ 正则。
 * 认错方向的代价不对称：把除号误判成正则，会吞掉一段代码 ⇒ **漏报**（可接受）；
 * 把正则误判成除号，则不吞 ⇒ 只是回到补丁之前的行为，不产生新的误报。
 * 找不到同行的收尾斜杠就原地收手（正则字面量不能跨行），避免把整段代码吃掉。
 *
 * ⚠️ 2026-09-23：模板串里的 `${...}` **插值表达式按代码保留**（而不是整段擦掉）。
 * 整段擦掉会让"只在模板串里出现过一次的自由变量"漏报 —— 方向是漏报，不能接受。
 * 插值里的字符串/注释会递归再过一遍，避免又把字符串内容当代码。
 */
function stripNoise(text, depth = 0) {
  // shebang（`#!/usr/bin/env node`）里那个 `/` 会被下面的正则启发式当成正则起点，
  // 于是 `bin` / `env` 会被当成标识符漏出来。开头这一行整行抹掉最省事。
  if (text.startsWith('#!')) {
    const eol = text.indexOf('\n')
    text = ' '.repeat(eol === -1 ? text.length : eol) + (eol === -1 ? '' : text.slice(eol))
  }

  let out = ''
  let i = 0
  const n = text.length
  /** 最近一次输出的非空白字符：用来判断 `//` 是不是正则里的转义斜杠（`/\/\//`） */
  let lastMeaningful = ''
  /** 最近一个"词"（标识符/数字），**空白不重置** —— `/` 是不是正则要看 `return /x/` 这种 */
  let lastWord = ''

  while (i < n) {
    const ch = text[i]

    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      out += ' '
      continue
    }

    if (ch === '/' && text[i + 1] === '/' && lastMeaningful !== ':' && lastMeaningful !== '\\') {
      const end = text.indexOf('\n', i + 2)
      i = end === -1 ? n : end
      out += ' '
      continue
    }

    // 正则字面量：判据见函数头注释。找不到同行的收尾斜杠就原地收手。
    // ⚠️ 字符类里**故意没有 `<`**：JSX 的闭合标签 `</g>` 会让 `<` 后的 `/` 看起来像正则起点，
    //    于是从 `</g>` 一直吞到同行的下一个 `/`（实测把 `<defs>` 整段吃掉，
    //    导致 `defs` 被当成自由变量）。`x < /re/` 这种写法现实中不存在，去掉 `<` 无代价。
    if (
      ch === '/' &&
      (!lastMeaningful || /[([{},;:=!&|?+\-*%~^>]/.test(lastMeaningful) || REGEX_AFTER_KEYWORD.has(lastWord))
    ) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n) {
        const c = text[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '\n') break
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) {
          j += 1
          closed = true
          break
        }
        j += 1
      }
      if (closed) {
        // ⚠️ 收尾斜杠后面的**修饰符**（`g` / `i` / `m` …）必须一起吃掉。
        //    只吃到收尾斜杠的话，`/\&quot;/g` 会留下一个孤零零的 `g`、
        //    `/\.(mp4|mov|webm)$/i` 会留下 `i`，两者都会被第 5 条当成自由变量。
        //    语法上正则字面量后面直接跟字母只可能是修饰符，不会误伤真实标识符。
        while (j < n && text[j] >= 'a' && text[j] <= 'z') j += 1
        out += ' '
        i = j
        lastMeaningful = '/'
        lastWord = ''
        continue
      }
    }

    if (ch === "'" || ch === '"') {
      const j = skipSimpleString(text, i)
      out += '""'
      i = j
      lastMeaningful = '"'
      lastWord = ''
      continue
    }

    if (ch === '`') {
      /**
       * 模板串：字面片段擦成 `""`，但 `${...}` 里的**表达式按代码保留**。
       * 理由见函数头注释（整段擦掉会让只在模板串里出现过的自由变量漏报）。
       * 表达式会递归再过一遍 stripNoise，去掉其中的字符串与注释。
       * 深度上限 3：模板套模板套模板已属异常写法，再深就整段擦掉（宁可漏报不误报）。
       */
      let j = i + 1
      let piece = '""'
      while (j < n) {
        const c = text[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '`') {
          j += 1
          break
        }
        if (c === '$' && text[j + 1] === '{') {
          const close = skipBraced(text, j + 2)
          const expr = text.slice(j + 2, Math.max(j + 2, close - 1))
          piece += ` ${depth < 3 ? stripNoise(expr, depth + 1) : ' '} `
          j = close
          continue
        }
        j += 1
      }
      out += piece
      i = j
      lastMeaningful = '"'
      lastWord = ''
      continue
    }

    out += ch
    if (ch.trim()) lastMeaningful = ch
    if (/\s/.test(ch)) {
      /* 空白不重置 lastWord */
    } else if (/[A-Za-z0-9_$]/.test(ch)) {
      lastWord += ch
    } else {
      lastWord = ''
    }
    i += 1
  }
  return out
}

/** 一个模块里所有对外可见的名字 */
const EXPORT_RES = [
  /(?:^|\n)\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*export\s+class\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
]

const cache = new Map()

function exportsOf(file, depth = 0) {
  const abs = path.resolve(file)
  if (cache.has(abs)) return cache.get(abs)
  if (depth > 5) return new Set()
  cache.set(abs, new Set()) // 先占位，防循环导入无限递归

  let text
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    return new Set()
  }
  const names = new Set()
  const body = stripNoise(text)

  for (const re of EXPORT_RES) {
    for (const m of body.matchAll(re)) names.add(m[1])
  }
  if (/(?:^|\n)\s*export\s+default\b/.test(body)) names.add('default')

  // export { a, b as c } [from './x']
  for (const m of body.matchAll(/(?:^|\n)\s*export\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?/g)) {
    const clause = m[1]
    const source = m[2]
    if (source) {
      const target = resolveSpecifier(abs, source)
      const inner = target ? exportsOf(target, depth + 1) : new Set()
      for (const part of clause.split(',')) {
        const raw = part.trim()
        if (!raw) continue
        const asMatch = raw.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        if (asMatch && inner.has(asMatch[1])) names.add(asMatch[2])
      }
    } else {
      for (const part of clause.split(',')) {
        const raw = part.trim()
        if (!raw) continue
        const asMatch = raw.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        names.add(asMatch ? asMatch[2] : raw)
      }
    }
  }

  // export * from './x'
  for (const m of body.matchAll(/(?:^|\n)\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveSpecifier(abs, m[1])
    if (target) for (const n of exportsOf(target, depth + 1)) names.add(n)
  }

  /**
   * CommonJS 的 `module.exports = { a, b, c }`。
   *
   * ⚠️ 必须认：`src/shared/` 下的真源文件（speed.js / aspect.js）**刻意写成 CJS** ——
   * 主进程是 CJS、Electron 33 的 Node 20 还不支持 require 一个 ESM 文件，
   * 渲染层那边由 vite 的 commonjs 插件转。不认这种写法的话，
   * 渲染层 `import { x } from '../shared/aspect.js'` 会被报成
   * 「导出的名字不存在」—— 名字明明存在，是检查器自己看不懂，
   * 于是一条**假红**会逼着人去改一份本来没错的代码。
   */
  for (const m of text.matchAll(/module\.exports\s*=\s*\{([\s\S]*?)\}/g)) {
    for (const part of m[1].split(',')) {
      const raw = part.trim()
      if (!raw) continue
      // 只收 `name` 与 `name: value` 两种；`...spread` 之类收不了，宁可不收也不猜
      const asMatch = raw.match(/^([A-Za-z_$][\w$]*)\s*:/)
      if (asMatch) names.add(asMatch[1])
      else if (/^[A-Za-z_$][\w$]*$/.test(raw)) names.add(raw)
    }
  }
  // `exports.foo = ...` / `module.exports.foo = ...`
  for (const m of text.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1])

  cache.set(abs, names)
  return names
}

/** specifier → 真实文件；解析不到返回 null */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [
    base,
    ...EXTS.map((e) => base + e),
    ...EXTS.map((e) => path.join(base, 'index' + e))
  ]
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      /* try next */
    }
  }
  return null
}

/** 解析一条 import/export-from 的导入子句，返回 { spec, names[] } */
function importClauses(text) {
  const out = []
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g
  for (const m of text.matchAll(re)) {
    const statement = m[0]
    const spec = m[1]
    const names = []
    // 默认导入要**独立于花括号**取：`import config, { ensureDirs } from './config.js'`
    // 这种混写若不单独处理，`config` 会被当成"用了但没导入"（实为误报）。
    const def = statement.match(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from)/)
    if (def) names.push({ imported: 'default', local: def[1] })
    const ns = statement.match(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/)
    if (ns) names.push({ imported: '*', local: ns[1] })

    const brace = statement.match(/\{([\s\S]*?)\}/)
    if (brace) {
      for (const part of brace[1].split(',')) {
        const raw = part.trim()
        if (!raw) continue
        const asMatch = raw.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        if (asMatch) names.push({ imported: asMatch[1], local: asMatch[2] })
        else if (/^[A-Za-z_$][\w$]*$/.test(raw)) names.push({ imported: raw, local: raw })
      }
    }
    out.push({ spec, names })
  }
  return out
}

/**
 * 从 `open` 处的 `{` / `[` 起做**配平**，返回括号**内部**的文本；配不平返回 `null`。
 *
 * ⚠️ 为什么非配平不可（2026-09-23 实测，是一条**假报**的根因）：
 * 这里原来是 `/\{([^}]*)\}/`，一遇到嵌套的 `}` 就当场收尾。`SidePanels.jsx` 的
 * props 解构里有一项 `catalog = { models: [] }`，`[^}]*` 只吃到
 * `catalog = { models: []`，于是它**后面**的所有名字（`projectName` … `enhanceGroup`）
 * 集体失去出生证明，被第 5 条报成假自由变量 —— 而真正该看的东西淹没在这堆噪声里。
 *
 * 入参是已经过 stripNoise 的正文（索引与主循环同一套坐标）。字符串内容已被抹平，
 * 但引号还在，所以这里仍然按引号跳过，避免残留的引号对搞乱计数。
 */
function balancedInner(text, open) {
  const o = text[open]
  if (o !== '{' && o !== '[') return null
  const c = o === '{' ? '}' : ']'
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === '\\') i += 1
        else if (text[i] === quote) break
        // 模板串可以跨行，其余引号不能：没有收尾就当配不平，交给调用方放弃
        else if (text[i] === '\n' && quote !== '`') return null
      }
      continue
    }
    if (ch === o) depth += 1
    else if (ch === c) {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return null
}

/** 本文件自己绑定的名字（含参数与解构，宁可宽松也不误报） */
function localBindings(text) {
  const names = new Set()
  const body = stripNoise(text)
  const add = (n) => {
    if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
  }

  for (const m of body.matchAll(/(?:^|[\s;{(,])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of body.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of body.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g)) add(m[1])

  /**
   * 参数列表里也常有解构：`function pollUntil({ ok, intervalMs = 3000 })`。
   * 早期版本直接按 `[^()]*` 切分再取首个标识符，遇到 `{ ok` 这种以花括号开头的
   * 片段就取不到名字，于是 `ok` 被误报成"用了但没导入"。
   */
  /**
   * 参数表 / 解构模式里的名字。三种写法共用一个实现，避免三份逻辑各自退化：
   *   `function pollUntil({ ok, intervalMs = 3000 })`   ← 形参解构
   *   `const { a, b: c, ...rest } = props`              ← 对象解构
   *   `const [x, y] = pair`                             ← 数组解构
   * ⚠️ 先把 `{}[]` 拍平成空格再按 `,` 切：嵌套路数不定（`a = { b: [1] }`），
   * 不拍平就会出现"某一项被嵌套括号切断"的半截名字。
   */
  const addFromPattern = (params) => {
    const flat = params.replace(/[{}[\]]/g, ' ')
    for (const part of flat.split(',')) {
      const piece = part.split('=')[0].trim().replace(/^\.\.\./, '')
      if (!piece) continue
      const pair = piece.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)$/)
      add(pair ? pair[1] : piece.match(/^([A-Za-z_$][\w$]*)/)?.[1])
    }
  }

  // const { a, b: c, ...rest } = ...   /   const [a, b] = ...
  // ⚠️ 必须用 balancedInner 取括号内部，不能写 `[^}]*` —— 理由见 balancedInner 注释。
  for (const m of body.matchAll(/(?:const|let|var)\s*([{\[])/g)) {
    const open = m.index + m[0].length - 1
    const inner = balancedInner(body, open)
    if (inner === null) continue
    addFromPattern(inner)
  }
  // `(a, b) =>` 与 `function f(a, b)` 两处参数列表
  for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g)) addFromPattern(m[1])
  for (const m of body.matchAll(/function\s*[A-Za-z_$]*\s*\(([^()]*)\)/g)) addFromPattern(m[1])
  for (const m of body.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of body.matchAll(/(?:import|export)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const raw = part.trim()
      if (!raw) continue
      const asMatch = raw.match(/^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/)
      add(asMatch ? asMatch[1] : raw)
    }
  }
  const defImport = body.match(/(?:^|\n)\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from)/)
  if (defImport) add(defImport[1])

  return names
}

/**
 * 取出文件里所有「带对象解构参数的函数」的**作用域区间**与解构名。
 *
 * 与 `propNamesOf` 的区别：那个只回答"这个文件里有没有解构参数"（用来决定第 5 条
 * 跑不跑这个文件），本函数还要回答"**哪个函数**解构了哪些名字、它的函数体从哪到哪"。
 *
 * 为什么非要区间不可 —— 2026-09-23 实测：
 *   `function Inner({ onImport }) {…}` 里的 `onImport` 只是 **Inner 的参数**，
 *   而 `localBindings()` 把它提升成了**文件级**绑定。于是同一个文件里
 *   `Host(props)` 里那个没解构的 `onImport` 被自己邻居的参数洗白，第 5 条当场失灵。
 *   而"某个 prop 名 A 组件解构了、B 组件没解构"恰恰是 prop 名最常见的形状
 *   （prop 名是全项目复用率最高的一类标识符），所以这不是边角情形，是主场景。
 *
 * 入参是**已经过 stripNoise 的正文**（索引与第 5 条的扫描区间必须同一套坐标）。
 */
function propScopesOf(body) {
  const scopes = []
  const all = new Set()

  /** 取解构参数的绑定名；不是解构（不以 `{` 开头）返回 null。 */
  const destructuredNames = (paramText) => {
    const brace = paramText.match(/^\s*\{([\s\S]*)\}\s*$/)
    if (!brace) return null
    const names = new Set()
    for (const part of brace[1].replace(/[{}[\]]/g, ' ').split(',')) {
      const piece = part.trim().replace(/^\.\.\./, '').split('=')[0].trim()
      if (!piece) continue
      const pair = piece.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)$/)
      const name = pair ? pair[1] : piece.match(/^([A-Za-z_$][\w$]*)/)?.[1]
      if (name) names.add(name)
    }
    return names
  }
  const push = (names, start, end) => {
    if (!names || !names.size) return
    scopes.push({ names, start, end })
    for (const name of names) all.add(name)
  }

  // ① 函数 / 变量赋值的箭头：`function Name({ a })` / `const Name = ({ a }) =>`
  const headerRe =
    /(?:function\s+[A-Za-z_$][\w$]*|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?)\s*\(([^()]*)\)/g
  for (const m of body.matchAll(headerRe)) {
    const names = destructuredNames(m[1])
    if (!names) continue
    // 函数体：参数表之后第一个 `{`，用 skipBraced 配平；找不到就退化成"到文件末尾"
    const braceStart = body.indexOf('{', m.index + m[0].length)
    const end = braceStart === -1 ? body.length : skipBraced(body, braceStart + 1)
    push(names, m.index, end)
  }

  /**
   * ② **对象属性里的箭头处理函数**：`handler: ({ draftId }) => …`。
   *
   * ⚠️ 2026-10-10 补这一条：MCP server（`src/main/mcp-server.js`）的工具表就是这种写法，
   *    `handler: ({ draftId }) => readDraftData(draftId)` 的参数**明明绑定了**，却因为
   *    headerRe 只认 `function Name(` 与 `const Name = (` 而拿不到作用域区间 ⇒
   *    该参数在**自己那个箭头里**被第 5 条报成自由变量（假红，实测 3 条：
   *    `draftId` / `aspectKey` / `clipId`）。这是**回调**不是 React 组件，不能按
   *    "组件 prop 忘了解构"处理。
   *
   * ⚠️ 必须要求收尾的 `=>`：只写 `key: (...)` 会把对象字面量里**括号包起来的普通表达式**
   *   也当成函数头（`{ w: (a + b) }`），进而算出一段**错误的作用域区间**把后面的真实代码
   *    吞进去 —— 那是"漏报"方向，比假红更坏。`=>` 保证它确实是箭头函数。
   *
   * ⚠️ 区间必须在**箭头体**上算，不能复用 `① 的 indexOf('{')`：表达式体（无 `{}`）
   *    的箭头若按"下一个 `{`"取，区间会一直延伸到后面某个不相干的对象，同样吞掉代码。
   */
  const propArrowRe =
    /(?:^|[,{;\n])\s*[A-Za-z_$][\w$]*\s*:\s*(?:async\s*)?\(([^()]*)\)\s*=>/g
  for (const m of body.matchAll(propArrowRe)) {
    const names = destructuredNames(m[1])
    if (!names) continue
    push(names, m.index, arrowBodyEnd(body, m.index + m[0].length))
  }

  return { scopes, all }
}

/**
 * 箭头函数体的结束下标。入参 `i` 指向 `=>` **之后**。
 *   · 块体 `{ … }` ⇒ 走 skipBraced 配平；
 *   · 表达式体 ⇒ 扫到**深度 0** 的 `,` / `;` / 或把深度压到负的分隔符（`)` / `]` / `}`）。
 * 分不清就退化成"到文件末尾"（区间偏大 ⇒ 偏宽松 ⇒ 至多漏报，不误报）。
 */
function arrowBodyEnd(body, i) {
  let j = i
  while (j < body.length && /\s/.test(body[j])) j += 1
  if (body[j] === '{') return skipBraced(body, j + 1)
  let depth = 0
  while (j < body.length) {
    const c = body[j]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return j
      depth -= 1
    } else if ((c === ',' || c === ';') && depth === 0) return j
    j += 1
  }
  return body.length
}

/**
 * 只取「**非**解构形式」的形参名。
 *
 * 为什么要单独算一张表：`localBindings()` 把形参一律当文件级绑定
 * （正则取不到作用域，宁可宽松）。于是同一个名字可能是
 * 「A 函数的普通形参」+「B 函数解构出来的 prop」。前者让它在文件级就有出生证明，
 * 后者又要求"必须在声明它的那个函数体内"—— 两条规则撞在一起会把
 * `function f(channelConfig)` 这种正常写法误报成自由变量。
 * 所以这里把普通形参名单独收出来，从 prop 名单里剔掉：普通形参沿用原来的文件级口径。
 */
function plainParamNames(body) {
  const names = new Set()
  const addFrom = (params) => {
    // 解构参数（以 `{` 开头）不算普通形参
    if (/^\s*\{/.test(params)) return
    for (const part of params.replace(/[{}[\]]/g, ' ').split(',')) {
      const piece = part.split('=')[0].trim().replace(/^\.\.\./, '')
      if (/^[A-Za-z_$][\w$]*$/.test(piece)) names.add(piece)
    }
  }
  for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g)) addFrom(m[1])
  /**
   * ⚠️ 参数表里允许出现**一层嵌套括号**：`function isRuleLive(rule, at = Date.now())`
   * 的实参里有 `Date.now()`，写成 `[^()]*` 会让整条函数头匹配失败 ⇒
   * 该函数的形参一个都收不到。实测代价：`at` 被误报成自由变量
   * （services/pricing.js）。原实现在这里靠"全库并集"兜住了，
   * 收紧作用域之后必须自己认全。
   */
  for (const m of body.matchAll(/function\s*[A-Za-z_$]*\s*\(((?:[^()]|\([^()]*\))*)\)/g)) addFrom(m[1])
  return names
}

/**
 * 「硬声明」的名字：import / const / let / var / function / class。
 *
 * 用途只有一个：把 `propScopesOf().all` 里那些**同时**还有文件级声明的名字剔掉。
 * 同名两处声明（既是某组件解构出来的 prop，又是文件级 `const`）时，
 * 文件级那份才是它的真正出生证明，不该按"只在那个组件里有效"来判。
 */
function hardBindings(body) {
  const names = new Set()
  const add = (n) => {
    if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
  }
  for (const m of body.matchAll(/(?:^|[\s;{(,])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  /**
   * ⚠️ 必须连**解构声明**一起认：`const { taskId, balance } = tx(() => {...})`
   * 里那个 `taskId` 是正经的文件级绑定（localBindings 认它，所以 `bindings` 里也有它），
   * 但它的声明形式不是"`const` + 标识符"。漏认的后果是它被当成
   * "只会出现在某组件的解构参数里"的名字 ⇒ 一律按函数级判 ⇒
   * 文件里其它正常引用全被误报。实测漏这一条会多报 `taskId`（services/generation.js）。
   */
  for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const raw = part.trim().replace(/^\.\.\./, '')
      if (!raw) continue
      const pair = raw.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)$/)
      add(pair ? pair[1] : raw.match(/^([A-Za-z_$][\w$]*)/)?.[1])
    }
  }
  for (const m of body.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(',')) add(part.trim().replace(/^\.\.\./, ''))
  }
  for (const m of body.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of body.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of body.matchAll(/(?:import|export)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const raw = part.trim()
      if (!raw) continue
      const asMatch = raw.match(/^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/)
      add(asMatch ? asMatch[1] : raw)
    }
  }
  const defImport = body.match(/(?:^|\n)\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from)/)
  if (defImport) add(defImport[1])
  return names
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (CODE_EXTS.test(entry.name)) out.push(full)
  }
  return out
}

/* ---------------- 第 5 条：组件 prop 用了但没解构 ---------------- */

/**
 * 取出文件里所有「带对象解构参数的函数」的解构名。
 *
 * 认三种写法（都是 React 组件的常见定义）：
 *   function Name({ a, b }) {}
 *   export default function Name({ a, b }) {}
 *   const Name = ({ a, b }) => …
 *
 * 只取**参数表第一个 `{...}`**：第二个参数起在本仓库里没有出现过解构用法，
 * 少认一点只是少报，方向是对的。嵌套解构（`{ a: { b } }`）复用 addFromParams
 * 那套"拍平"逻辑，取到的是外层名 `a` —— 对本判据够用（外层名没绑上就已经是缺陷）。
 */
function propNamesOf(text) {
  const names = new Set()
  const body = stripNoise(text)
  const add = (n) => {
    if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
  }
  const collect = (paramText) => {
    const brace = paramText.match(/^\s*\{([\s\S]*)\}/)
    if (!brace) return
    for (const part of brace[1].replace(/[{}[\]]/g, ' ').split(',')) {
      const piece = part.trim().replace(/^\.\.\./, '').split('=')[0].trim()
      if (!piece) continue
      const pair = piece.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)$/)
      add(pair ? pair[1] : piece.match(/^([A-Za-z_$][\w$]*)/)?.[1])
    }
  }
  // function Name( ... )   /   const Name = ( ... ) =>
  for (const m of body.matchAll(
    /(?:function\s+[A-Za-z_$][\w$]*|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?)\s*\(([^()]*)\)/g
  )) {
    collect(m[1])
  }
  /**
   * ⚠️ 2026-10-10：**对象属性里的箭头处理函数**（`handler: ({ a }) => …`）也必须算数。
   * 本函数只回答"这个文件要不要跑第 5 条" —— 只认上面两种写法的话，一个**只**用
   * 对象属性箭头解构的文件会被判成"没有解构参数" ⇒ 第 5 条**整个不跑** ⇒
   * 该文件里的自由变量全部漏报（漏报方向，正是本检查器最该避免的）。
   * 与 `propScopesOf()` 的第 ② 条保持同一形状，两处一起改。
   */
  for (const m of body.matchAll(/(?:^|[,{;\n])\s*[A-Za-z_$][\w$]*\s*:\s*(?:async\s*)?\(([^()]*)\)\s*=>/g)) {
    collect(m[1])
  }
  return names
}

/**
 * 从 JSX 区间里收标签名与属性名，喂给自维护白名单。
 *
 * ⚠️ 这两张表**必须按文件**算，不能全库合并 —— 这是实测踩出来的坑：
 * `initialCapability` 在 App.jsx 里是 `<AiPanel initialCapability={aiCap} />` 的**属性名**，
 * 拿到全库合并的白名单里，就等于把"这个名字合法"写进了全局事实；
 * 于是 AiPanel.jsx 里那个真正的自由变量被自己调用点的属性名放过了 —— 判据自废武功。
 * 属性名只在**它出现的那个文件**里是"合法的不算引用"。
 */
function jsxTablesOf(text) {
  const tags = new Set()
  const attrs = new Set()
  const body = stripNoise(text)
  /* ⚠️ 属性部分必须允许 `{...}` 分组（且允许一层嵌套）：JSX 里
   * `onClick={() => onChange(item.key)}` 含 `=>`（一个 `>`），
   * 只写 `[^<>]*` 会让**整个元素匹配失败**，于是它的所有属性名都收不进白名单。
   * 实测代价：`data-wb-node` 的 `wb` 因此漏网，被报成自由变量。
   *
   * ⚠️ 2026-09-23：属性区**必须收紧**，不能用 `[^<>{}]` 这种"什么字符都吃"的写法。
   * 那种写法可以跨行吃下大段真实代码，于是**一个匹配吞掉后面好几个标签**，
   * 只有第一个标签名被登记 —— 被吞掉的标签名就漏了。实测代价：
   * `<kbd key={part}>{part}</kbd>` 的 `kbd`、`<img src={...} />` 的 `img`
   * 都因为落在前一个匹配的吞并区间里而被报成自由变量。
   * （这个缺陷长期被掩盖：旧版把属性区间的标识符 token 全收进白名单，
   *   连吞并区间里的 `</kbd>` 都顺手收了，于是"看起来没问题"。）
   * 收紧之后属性区只允许：空白、标签名/属性名字符、`=`、引号串、`{...}`、`/`。
   * 任何 `;` `(` `)` `,` 反引号都会当场中断，跨行吞并就无从发生。
   */
  /**
   * 扫标签名与属性名 —— **单趟扫描 + 花括号配平**，不用正则整条匹配。
   *
   * 为什么不能用正则把"整个标签"匹配下来：属性区里可以嵌任意深度的花括号
   * （`onLoadedMetadata={(e) => try {...} catch {...}}`），正则要么认不出
   * （`\{(?:[^{}]|\{[^{}]*\})*\}` 只允许一层嵌套 ⇒ 整条不匹配 ⇒ 标签名与属性名一起漏网
   *   ⇒ 误报，实测代价 `<Modal wide>` 的 `wide`、`<video muted playsInline>`），
   * 要么放宽成"什么字符都吃"（`[^<>{}]`）⇒ 一个匹配跨行吞掉后面好几个标签
   *   ⇒ 被吞的标签名漏网（实测代价 `<kbd>` 的 `kbd`、`<img>` 的 `img`）。
   * 两种失败方向都真实发生过，所以这里不再调正则，直接数花括号。
   *
   * 算法：先找标签起点（名字后面必须紧跟空白 / `/` / `>`，这样 `i < len &&` 这种
   * 比较运算不会被误认），再从起点走到深度为 0 的 `>`。深度为 0 时遇到的标识符
   * 只可能是**属性名**（属性值要么是已被 stripNoise 抹成 `""` 的字符串，要么在 `{}` 里）。
   *
   * ⚠️ 必须带**假设证伪**：深度为 0 时若出现标签属性区不可能有的字符
   * （`;` `(` `)` `,` 反引号 `&` 等），说明这里根本不是标签，立刻放弃本次扫描、
   * 不收取任何属性名。少了这一步，`for (let i = 0; i < len && ok; i++)`
   * 会从 `len` 一路扫到很远的 `>`，把沿途真实代码里的标识符全当成属性名收进白名单
   * —— 那是"只加不删"方向的漏报，比误报更难发现。
   */
  const TAG_ATTR_OK = /[\sA-Za-z0-9_$:.\-=/"]/
  for (const m of body.matchAll(/<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/g)) {
    tags.add(m[1])
    let i = m.index + m[0].length
    let depth = 0
    while (i < body.length) {
      const c = body[i]
      if (c === '{') {
        depth += 1
        i += 1
        continue
      }
      if (c === '}') {
        if (depth > 0) depth -= 1
        i += 1
        continue
      }
      if (depth === 0) {
        if (c === '>') break
        if (c === '<') break // 撞上下一个标签：本标签没有可识别的收尾 `>`，放弃
        if (!TAG_ATTR_OK.test(c)) break // 假设证伪：这里不是标签
        const token = body.slice(i).match(/^[A-Za-z_$][\w$:.-]*/)
        if (token) {
          attrs.add(token[0])
          i += token[0].length
          continue
        }
      }
      i += 1
    }
  }
  /** 闭合标签的名字：`</kbd>` 的 `kbd`（标签开头那条只认 `<名`，认不到 `</`） */
  for (const m of body.matchAll(/<\/([A-Za-z][A-Za-z0-9-]*)\s*>/g)) tags.add(m[1])
  /* 兜底：连字符名字的**每一段**也算属性名。
   * `data-wb-node` / `data-wb-tool` 这类属性在 JSX 里不带等号时，
   * 会被切成 `data` / `wb` / `node` 三个 token —— 只靠上面的扫描收不干净。
   * 这一段让白名单"自己长出来"，不依赖手写清单。 */
  for (const m of body.matchAll(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/g)) {
    for (const part of m[0].split('-')) attrs.add(part)
  }
  return { tags, attrs }
}

/**
 * 收集 JSX **文案**里的拉丁词，喂给同一张按文件的白名单。
 *
 * ⚠️ 2026-09-23 补这一条的原因（真实误报，实测 3 条）：
 * 上面的 `stripJsxText` 只能吃掉"一个代码标点都不含"的纯文案片段，而这个仓库里
 * 中文说明是写在 JSX 文案里的，Latin 词又常嵌在中文句子里，于是三种形状全部漏网：
 *
 *   · `{preset.size}px · 默认 {preset.duration}s` —— 文案与 `{}` 表达式交错；
 *   · `（src/shared/looks.json），改一处不需要改两处。` —— 文案里有 `.` 和 `/`；
 *   · `media 权限（现基线是「拒一切权限申请」）` —— 中文句子里夹一个英文词。
 * 三条分别报出 `px` / `shared` / `media` 三个假自由变量。
 *
 * 为什么这里**不去改进 `stripJsxText` 的删除逻辑**：删错方向的代价不对称。
 * `stripJsxText` 一旦多删，吃掉的是真实代码 ⇒ 区间里的缺陷全部静默漏报，
 * 而那正是本检查器存在的唯一理由（同一个坑 2026-09-21 已经踩过一次，
 * 见 stripNoise 的注释）。这里改成**只往白名单里加名字、永不删任何字符**。
 *
 * ⚠️ 但"只加不删"也不是随便加 —— 第一版写成 `/>[^<>]*(?=<)/`（与 stripJsxText
 * 早期被废弃的那个写法同形），实测把
 *     `useEffect(() => {` … `return <div …>` 之间的**整段真实代码**都收进白名单，
 * 于是 missing-prop 夹具里的 `initialCapability` 被自己洗白，第 5 条当场失灵。
 * 教训：白名单的作用是"让判据闭嘴"，所以它的**误放行**与删除逻辑的**误删**
 * 完全等价 —— 都必须靠"形状可证"来约束，不能靠"看起来像"。
 *
 * 所以这里用两条硬约束把区间卡死：
 *   1. 区间内**不允许出现任何 ASCII 代码标点**（`{ } ( ) [ ] = ; : , ! ? & | + * % ^ ~`
 *      引号与空白以外的符号）——`>` 只是"可能是标签收尾"，而 `=>` 后面的 `{`、
 *      比较式后面的 `)`/`?`/`:` 都会让区间当场中断，贪婪匹配无从发生；
 *   2. 区间内**至少要有一个 CJK 字符**。产品硬约束是"界面全简体中文"，
 *      所以真实文案必然带中文，而 `x => y.z < w` 这类纯代码片段一个中文都没有，
 *      直接被排除。若哪天文案改成英文，这条会退化成"英文文案可能误报"，
 *      届时把判据换成别的（例如白名单改为按注释块收集），不要把约束 1 放宽。
 *
 *   例外：**单位后缀**。`{Math.round(playhead * FRAME_RATE)}f` 与
 *   `{preset.duration}s` 里 `}` 后面那个 `f` / `s` 是单位不是标识符，
 *   但它一个中文都没有。所以补一条：区间是 `1~3 个纯字母`（可带 `%`）时也算散文。
 *   上限卡在 3 是有意的 —— 4 个字母就可能是真标识符（`{cond}flag`），
 *   宁可漏掉 `fps` 这种 3 字母单位以外的写法，也不要把标识符洗白。
 */
function proseWordsOf(text) {
  const words = new Set()
  const body = stripNoise(text)
  /** 允许出现在散文里的字符：字母数字、空白、CJK、以及散文里常见的 `- _ . / ·` */
  const RUN = '[^{}()\\[\\]=;:,!?&|+*%^~<>"\'\\\\]*?'
  const patterns = [
    // `>` 之后到下一个 `{`（表达式）或 `<`（下一个标签）之间
    new RegExp(`>(${RUN})(?=[{<])`, 'g'),
    // `}` 之后同理：`{preset.size}px · 默认 {` 里的 `px` 就落在这里
    new RegExp(`}(${RUN})(?=[{<])`, 'g')
  ]
  const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
  /** 单位后缀：`s` / `f` / `ms` / `px` / `kb` / `fps`… */
  const UNIT = /^\s*[A-Za-z]{1,3}%?\s*$/
  for (const re of patterns) {
    for (const m of body.matchAll(re)) {
      if (!CJK.test(m[1]) && !UNIT.test(m[1])) continue
      for (const token of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) words.add(token[0])
    }
  }
  return words
}

/**
 * 去掉 JSX 的**纯文案**节点：`<span>Import</span>` 里的 `Import` 是文案不是标识符。
 *
 * ⚠️ 这里刻意只吃"一个代码标点都没有"的片段（不含 `{ } ( ) [ ] = ; ' "` 等）。
 * 第一版写成 `/>[^<>]*(?=<)/`，实测会把**`=>` 到下一个 `<` 之间的整段代码**吃掉 ——
 * JSX 之前随便哪个箭头函数，都能把后面几百行逻辑连人带缺陷一起吞掉。
 * （`initialCapability` 之所以还能被抓到，只是因为 AiPanel 那段区间里恰好还有别的
 *   `>` 把长匹配打断了 —— 靠运气的东西不能留。）
 * 收窄之后：`Ready` / `or` / `16:9` 这类文案照样被吃掉，
 * 而 `{rows.length ? 'a' : 'b'}` 这种带标点的表达式原样保留，不再有吞代码的可能。
 *
 * ⚠️ 已知缺口（2026-09-23 实测）：中文文案里夹 Latin 词、或文案与 `{}` 交错时，
 * 本函数**吃不到**，会剩下 `px` / `shared` / `media` 这样的假自由变量。
 * 缺口由 `proseWordsOf()` 兜底（往白名单加名字，不删代码），不要反过来放宽这里。
 *
 * ⚠️ 替换必须**等长**（`>` + 等量空格），不能缩成单个 `>`。
 * 第 5 条要用 `propScopesOf(body)` 算出的**区间**去判"这个名字是不是在声明它的函数体内"，
 * 而区间是在 `body` 这套坐标里量出来的；这里一缩短，后面的下标全部错位，
 * 作用域判断会静默判错（往"以为在范围内"的方向错，也就是漏报）。等长替换零成本。
 */
function stripJsxText(body) {
  return body.replace(/>[^<>{}()\[\]=;:'"\\/,.]*?(?=<)/g, (hit) => `>${' '.repeat(hit.length - 1)}`)
}

/* ------------------------------------------------------------------ 主流程 */

const problems = []
let specCount = 0
let bindingCount = 0

/* ------------------------- 预扫：建全局表 -------------------------
 *
 * 第 5 条（自由变量）与前 4 条不同：它要判"这个名字在本文件里没有出生证明"，
 * 而 `localBindings()` 是正则取绑定、**天生不完整**（无括号的箭头函数参数、
 * 类/对象的方法参数都取不到）。
 *
 * ⚠️ 2026-09-23 修掉一个**方向相反**的缺陷：这里原来做的是"全库兜底"——
 * 某个名字只要在**任何**文件里被声明过就放过。当时是为了压误报，
 * 代价写在注释里（"跨文件裸用会漏报，可接受"）。但实测发现漏掉的不是罕见形态，
 * 而是**本检查器最主要的目标缺陷本身**：
 *
 *     SidePanels.jsx 的 `if (mode === 'record') return <RecordPanel onImport={onImport} />`
 *     里那个 `onImport` 从来没被 props 解构出来（App.jsx 一直在传它）。
 *     它会 ReferenceError，但没被报出来 —— 因为同文件里 `function RecordPanel({ onImport })`
 *     的参数把它"洗白"了。
 *
 *   根因是作用域搞错了：prop 名是全项目复用率最高的一类标识符
 *   （`onImport` / `onClick` / `clips` / `assets`…），只要有一个组件解构过它，
 *   这个名字就永久免疫。而"某个 prop 名在 A 组件解构了、B 组件没解构"恰恰是最常见的形状。
 *
 *   所以这里改成**按文件**：每个文件只用"本文件自己的出生证明"
 *   （本文件绑定 ∪ 本文件导入 ∪ 本文件 JSX 标签/属性/文案）。
 *   这本来就是自由变量的正确语义 —— 一个名字在某文件里被使用，它必须在该文件里
 *   被导入或声明，否则运行时就是 ReferenceError。
 *
 *   代价是 `localBindings()` 的取不全会转成误报。处理办法是**逐个把取不全的形状补上**
 *   （见 localBindings 的注释），而不是把作用域再放回去 —— 那等于取消这条判据。
 */
const files = []
for (const root of roots) {
  if (!fs.existsSync(root)) {
    console.error(`目录不存在：${root}`)
    problems.push(`${root} 不存在`)
    continue
  }
  files.push(...walk(root))
}

const texts = new Map()
/** 每个文件自己的 JSX 标签 / 属性 / 文案白名单 —— **必须按文件**，理由见 jsxTablesOf() */
const jsxTables = new Map()
/** 含「对象解构参数的函数」的文件 —— 第 5 条只在这些文件上跑 */
const filesWithDestructuredParams = new Set()

for (const file of files) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  texts.set(file, text)
  const table = jsxTablesOf(text)
  for (const word of proseWordsOf(text)) table.attrs.add(word)
  jsxTables.set(file, table)
  /**
   * ⚠️ 这里**只登记"这个文件要不要跑第 5 条"**，不把解构参数名并进白名单。
   * 并进去就等于把它们提升成文件级绑定 —— 那正是 2026-09-23 修掉的那个缺陷
   * （`Inner({ onImport })` 的参数洗白了 `Host` 里没解构的 `onImport`）。
   * 作用域与区间改由主循环里的 `propScopesOf(body)` 按文件正文算。
   */
  if (propNamesOf(text).size) filesWithDestructuredParams.add(file)
}

for (const file of files) {
  {
    const rel = path.relative(process.cwd(), file)
    const text = texts.get(file)
    if (text === undefined) continue
    const clauses = importClauses(text)
    const bindings = localBindings(text)
    // 这两项在第 3 条（使用了但未导入）和第 4 条（悬空 setter）里都要用，
    // 而第 4 条必须在「本文件没有相对导入」的提前 continue 之前跑，
    // 所以提到前面来算。
    const body = stripNoise(
      text.replace(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"][^'"]+['"]/g, '\n')
    )
    const imported = new Set()
    for (const { names } of clauses) for (const n of names) imported.add(n.local)

    for (const { spec, names } of clauses) {
      if (!spec.startsWith('.')) continue
      specCount += 1
      const target = resolveSpecifier(file, spec)
      if (!target) {
        problems.push(`路径无法解析  ${rel}  ->  ${spec}`)
        continue
      }
      // 2. 命名导入必须真实存在
      const exported = exportsOf(target)
      for (const { imported, local } of names) {
        if (imported === '*' || imported === 'default') continue
        bindingCount += 1
        if (!exported.has(imported)) {
          problems.push(`导出的名字不存在  ${rel}  ->  ${spec}  ::  ${imported}${local !== imported ? ` (as ${local})` : ''}`)
        }
      }
    }

    // 3. 用了但既没导入、也没本地声明的外部符号
    /* 4. 悬空的 setter（`setXxx` 用了、但全文件没有任何地方定义它）
     *
     * 为什么单开这一条、而不是让上面第 3 条顺手管掉：
     * 第 3 条刻意把搜索范围收窄成「本文件已经 import 过的那些模块的导出」，
     * 为的是压误报（范围越小越准）。但 2026-09-22 抓到的真实缺陷恰好落在范围**外**：
     * `App.jsx` 里 `setRail('media')` 的 `setRail` 在整个仓库里都不存在
     * （界面改版后左栏的 Rail 概念被删了，只剩这个调用点），没有任何模块导出它，
     * 于是第 3 条永远看不见它。后果不是"少个功能"，而是导入素材成功后**立刻
     * ReferenceError** —— 素材其实已经进库（上一行 setAssets 跑完了），
     * 但紧随其后的成功提示和自动选中全都不执行，用户只看到素材凭空变多。
     * 所以这里补一条独立判据，把"名字根本不存在"这种情形也盖住。
     *
     * 判定刻意收得很紧，宁可漏报也不误报：
     *   · 只认 React 状态 setter 的形状（`set` + 大写开头）；
     *   · 要求它没有被 import、没有被本文件以任何形式绑定（含 useState 解构、
     *     对象解构、参数、catch）；
     *   · 再拿原文做一次保守兜底 —— 只要正文任何地方出现过"像在声明它"的形状，
     *     就放过（避免 `const { setX } = ctx` 这类写法被误伤）。
     * 成员调用（`el.setPointerCapture`）天然被 `(?<![\w$.])` 排除。
     */
    const seenSetter = new Set()
    for (const m of body.matchAll(/(?<![\w$.])set[A-Z][\w$]*/g)) {
      const name = m[0]
      if (seenSetter.has(name)) continue
      if (WEB_GLOBALS.has(name)) continue
      // 对象字面量的键不是"使用"：`const api = { setHeight: (h) => ... }`
      // 是在声明一个属性名（同名函数可以根本不存在）。第 3 条用的是同一条排除。
      if (/^\s*\??\s*:/.test(body.slice(m.index + name.length))) continue
      if (imported.has(name) || bindings.has(name)) continue
      if (new RegExp(`(?:const|let|var|function|class|async\\s+function)\\s+${name}\\b`).test(text)) continue
      if (new RegExp(`[{,]\\s*${name}\\s*[,}\\]]`).test(text)) continue
      seenSetter.add(name)
      // ⚠️ 消息里**不能有空格**：本检查器的报告行格式是
      // `BAD  <消息>  <文件绝对路径>  [...]`，自证夹具靠"第三段 = 路径"来定位文件
      // （见 check-imports.selftest.mjs 里那段注释）。所以这里写成连着的 `悬空setter`。
      problems.push(
        `悬空setter  ${rel}  ::  ${name}  （全文件没有它的声明/导入/解构/参数，运行时必然 ReferenceError）`
      )
    }

    /* 5. 自由变量（用了、但全仓库都没有它的出生证明）
     *
     * 为什么还要第 5 条 —— 第 3、4 条都漏掉了 2026-09-22 抓到的第二个真实缺陷：
     *
     *   AiPanel.jsx 的 useEffect 里读了 `initialCapability`，而它的 props 解构**没有这一项**。
     *   App.jsx 一直在传 `initialCapability={aiCap}`，所以从调用点看"接得好好的"，
     *   实际上是渲染层里一个没有出处的标识符 ⇒ **面板一挂载就 ReferenceError**，
     *   整棵 React 树被卸载、界面白屏，而构建 0 报错 0 告警。
     *
     *   它同时躲过了前两条：第 3 条只查"本文件已导入模块的导出"（没有任何模块导出它）；
     *   第 4 条只认 `set` + 大写（它是 `initial` 开头）。**同一根因、第二次发作** ——
     *   所以这里补一条真正按"有没有出生证明"来判的通用判据。
     *
     * 判定范围刻意收在两处，为的是不制造误报（误报会让人开始无视这个检查器）：
     *   · 只扫**含对象解构参数的函数**的文件 —— 那正是"组件 prop"的形状，
     *     本次缺陷 100% 落在里面；纯工具文件不必冒险；
     *   · 只认**小写开头的纯字母标识符**（`initialCapability` 的形状），
     *     大写开头的一律放过（组件名/类型名本来就不该在这里判）。
     *
     * 排除项全部是"开放集合"，所以都从代码库自身反推（见 jsxTablesOf / proseWordsOf /
     * propNamesOf），而不是手写名单 —— 手写名单写漏一个就是一条误报。
     *
     * ⚠️ 这里的 `jsxAttrs` 是**按文件**的那张表，里面混了三样东西：JSX 属性名、
     *    本文件自己解构出来的 prop 名、以及 JSX 文案里出现过的拉丁词。
     *    三样都是"在本文件里不算引用"的名字，所以并到一张表里。别把它换成全局表
     *    （2026-09-22 已踩：`initialCapability` 因为出现在 App.jsx 的**属性名**位置
     *    而被全局洗白，于是 AiPanel.jsx 里那个真缺陷被放过）。
     */
    if (filesWithDestructuredParams.has(file)) {
      const scanBody = stripJsxText(body)
      const { tags: jsxTags, attrs: jsxAttrs } = jsxTables.get(file) || { tags: new Set(), attrs: new Set() }
      /**
       * 解构参数名 = **函数级**绑定，不是文件级。
       * `propNames` 里剔掉那些同时还有硬声明的（同名 `const` / `function`）。
       */
      const propInfo = propScopesOf(body)
      const hard = hardBindings(body)
      const plainParams = plainParamNames(body)
      /** 文件级出生证明 = 三张表的并集（各自的缺口互补，见下面注释） */
      const fileDeclared = new Set([...bindings, ...hard, ...plainParams])
      const propNames = new Set(
        [...propInfo.all].filter((name) => !hard.has(name) && !plainParams.has(name))
      )
      /** 用法是否落在"声明了它的那个函数"体内 */
      const declaredInEnclosingScope = (name, index) =>
        propInfo.scopes.some((scope) => scope.names.has(name) && index > scope.start && index < scope.end)
      /**
       * ⚠️ 这里必须分两层循环状态，不能像原来那样"按名字去重后只看第一次出现"。
       *
       * 2026-09-23 实测到的缺陷：`seenFree` 是按**名字**去重的，于是
       *   `function Inner({ onImport }) { … onClick={onImport} … }`   ← 第一次出现，合法
       *   `function Host(props)    { … setBusy(onImport) … }`          ← 第二次，自由变量
       * 第二次在 `seenFree.has(name)` 那一步就被 `continue` 掉了，**永远不会被检查**。
       * 换句话说：只要同一个名字在文件里先合法地出现过一次，后面所有非法出现全部隐身。
       * prop 名恰好是最容易重复出现的（一个文件里好几个组件都收同名 prop），
       * 所以这个洞正好吃掉最主要的场景。
       *
       * 现在拆成两套状态：
       *   · `filtered`  —— 位置无关的过滤（关键字 / JSX 标签属性 / 已导入 / 文件级绑定）
       *                     判定一次即可，判过就整名放过；
       *   · `reported`  —— 真正要报的时候才去重，避免同一个名字刷出一屏。
       * 中间那些**位置相关**的判据（作用域、紧邻语法）对**每一个出现位置**都要跑。
       */
      const filtered = new Set()
      const reported = new Set()
      /* ⚠️ 字符类里**必须带下划线**：漏了它，`story_script` 会被截成 `story`、
       * `per_second` 截成 `per`、`video_music` 截成 `video` —— 实测第一版就是这样
       * 报了 7 个"能力码的前半截"（`face`/`digital`/`music`/`remove`/`object`/`story`/`per`）。
       * 收尾的 `(?![A-Za-z0-9_$])` 同理，防止从长名字中间截一段。
       */
      for (const m of scanBody.matchAll(/(?<![\w$.])[a-z][A-Za-z0-9_]*(?![A-Za-z0-9_$])/g)) {
        const name = m[0]
        if (filtered.has(name)) continue
        if (JS_KEYWORDS.has(name) || RUNTIME_GLOBALS.has(name)) {
          filtered.add(name)
          continue
        }
        if (jsxTags.has(name) || jsxAttrs.has(name)) {
          filtered.add(name)
          continue
        }
        if (imported.has(name)) {
          filtered.add(name)
          continue
        }
        /**
         * "文件级出生证明"用**三张表的并集**，不能只看 `bindings`：
         *   · `bindings` = localBindings(text)，按**原文**算。解构项带默认值时
         *     （`catalog = { models: [] }`）会因含 `=` 被它丢掉；
         *   · `hard`     = hardBindings(body)，按**正文**算，能正确取出 `catalog`；
         *   · `plainParams` = 普通形参（`function f(rule, at = Date.now())`），
         *     `bindings` 因为函数头里嵌套括号而整条匹配失败。
         * 只看第一张会漏 ⇒ 误报。实测代价：SidePanels.jsx 的 `catalog`、pricing.js 的 `at`。
         *
         * 注意普通形参按文件级处理是**沿用的旧口径**（正则取不到形参作用域，
         * 宁可宽松）。真正收紧的只有"对象解构出来的 prop 名"那一类 ——
         * 那才是 prop 忘了解构这个主场景的形状。
         */
        if (!propNames.has(name) && fileDeclared.has(name)) {
          filtered.add(name)
          continue
        }
        // ↓ 以下都是位置相关判据，每个出现位置都要过
        if (propNames.has(name) && declaredInEnclosingScope(name, m.index)) continue
        const after = scanBody.slice(m.index + name.length)
        // 对象字面量的键不是"使用"（`{ setHeight: ... }` / `{ label: x }`）
        if (/^\s*\??\s*:/.test(after)) continue
        // `name = ...`：赋值目标或 JSX 属性（`ref={x}` / `value={y}` / `{...props}`）
        if (/^\s*=/.test(after)) continue
        // 方法定义名：`get baseUrl() {}` / `set baseUrl(v) {}` / `async foo() {}`
        const before = scanBody.slice(Math.max(0, m.index - 24), m.index)
        if (/^\s*\(/.test(after) && /(?:^|[^\w$])(?:get|set|async|static|\*)\s*$/.test(before)) continue
        if (reported.has(name)) continue
        if (process.env.YJAI_DEBUG_FREE) {
          console.error(
            `[debug] ${rel} :: ${name}  prop=${propNames.has(name)} hard=${hard.has(name)} ` +
              `plain=${plainParams.has(name)} bind=${bindings.has(name)} index=${m.index}`
          )
        }
        reported.add(name)
        problems.push(
          `自由变量  ${rel}  ::  ${name}  （全仓库找不到它的声明/导入；组件 prop 忘了解构时，挂载即 ReferenceError）`
        )
      }
    }

    const reachable = new Set()
    for (const { spec, names } of clauses) {
      if (!spec.startsWith('.')) continue
      const target = resolveSpecifier(file, spec)
      if (target) for (const n of exportsOf(target)) reachable.add(n)
    }
    if (!reachable.size) continue

    const sourceOf = new Map()
    for (const { spec, names } of clauses) {
      if (!spec.startsWith('.')) continue
      const target = resolveSpecifier(file, spec)
      if (target) for (const n of exportsOf(target)) if (!sourceOf.has(n)) sourceOf.set(n, spec)
    }

    for (const name of reachable) {
      // `default` / `*` 是关键字不是标识符，`export default {...}` 之类会把正文里
      // 的 `default` 关键字当成"使用"，纯属误报。
      if (name === 'default' || name === '*') continue
      if (imported.has(name) || bindings.has(name)) continue
      const useRe = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g')
      for (const m of body.matchAll(useRe)) {
        const after = body.slice(m.index + name.length)
        // 排除对象字面量的键 { NAME: ... }
        if (/^\s*\??\s*:/.test(after)) continue
        /**
         * ⚠️ 还必须排除「赋值目标 / JSX 属性名」（`NAME={...}`、`NAME = ...`）。
         *
         * JSX 属性名**不是标识符引用**，它只是恰好与某个导出同名。少了这条，条件就
         * 变成了"本文件只要从某模块 import 过一次，而那个模块恰好导出同名函数"，
         * 于是**合法的属性名**被报成"漏导入"。2026-09-24 实测：给 App.jsx 加了
         * `import { effectiveTransitions } from './looks.js'` 之后，同一行早就存在的
         * `<MediaPanel filterLabel={currentNode?.label} />` 突然变红 —— 属性名
         * `filterLabel` 与 looks.js 导出的 `filterLabel()` 同名。这不是代码写错，
         * 是判据把"同名"当成了"引用"。
         *
         * 上面第 3 条（自由变量）里已经用同一句话排除过这个位置，两条判据必须一致 ——
         * 否则同一个缺陷形状在第 3 条里被放过、在第 4 条里被误报，自相矛盾。
         *
         * ⚠️ 排的是**位置**，不是名字：同一个名字在正文里当值用
         * （`filterLabel('warm')`）照样会被报出来 —— 夹具 `attr-and-value.jsx`
         * 专门钉住这一点，防止有人把这里改成按名字整体跳过。
         */
        if (/^\s*=/.test(after)) continue
        problems.push(`使用了但未导入  ${rel}  ::  ${name}  （本文件已 import ${sourceOf.get(name)}，它导出这个名字，但 import 列表里漏了它）`)
        break
      }
    }
  }
}

if (!problems.length) {
  console.log(
    `IMPORTS_OK  已校验 ${specCount} 条相对导入 / ${bindingCount} 个命名绑定，全部可解析；未发现「用了但没导入」的外部符号，也没有未定义的状态 setter`
  )
  process.exitCode = 0
  return
}
for (const p of problems) console.error(`BAD  ${p}`)
console.error(`\nIMPORTS_FAILED  ${problems.length} 处导入/绑定问题`)
/**
 * 本脚本没有需要收尾的句柄，直接设 `exitCode` 让 Node 自然退出：
 * 这样连"结论行还没刷出去就退出"的机会都不存在。
 * （同仓库的 E2E 闸门用的是 `process.stdout.write('', cb)` + 兜底定时器，
 *   因为那边必须显式退出，见 home-assets-e2e.mjs 收尾处的说明。）
 */
process.exitCode = 1
}
