#!/usr/bin/env node
/**
 * 「界面文案体检」的看门狗 —— 客户端渲染层不许出现 emoji / 装饰符号 / 开发痕迹词。
 *
 * 为什么需要它：2026-10-02 全量复查时实测，左栏分组树里有 12 处标签是
 *   `label: '万圣节 🎃'` / `'最新 🔥'` / `'秋天 🍂'` / `'梗图贴纸 😺'` / `'SFX 贴纸 🎭'`
 *   —— emoji 是**我们自己加的装饰**，不是参考真源（参考语言包里连「万圣节」「秋天」
 *   这两个词都不存在：素材分组名是服务端下发的纯文本）。它造成的后果很典型：
 *     · 功能、断言、闸门全绿（那只是个字符串，没人断言它长什么样）；
 *     · 但一眼看上去就是"个人作品 / 演示 demo"，不是商业软件 ——
 *       专业剪辑软件的分组树不会用彩色表情当分类标识；
 *     · 而且 emoji 在字宽上行高不一致，会把逐像素对齐过的行高顶歪。
 *   这类缺陷**只能靠机器盯**：人眼会习惯，代码审查看不见"多了一个表情"。
 *
 * 判据（保守，宁可漏报不误报）：
 *   · 只查**界面文案**：字符串字面量与 JSX 文本节点。注释不算（本项目注释里
 *     大量使用 ⚠️ 与 →，剥掉注释就是为了让它们不被算进来 —— 否则一开门就几百条假红）；
 *   · 只禁**彩色 emoji 与装饰符号**（U+1F000–1FAFF / U+2600–27BF / U+2B00–2BFF / U+FE0F）。
 *     ← → ↑ ↓ 这类排版箭头**不禁**：专业软件的快捷键提示里本来就该有；
 *   · 开发痕迹词（TODO / FIXME / XXX / Lorem / 占位 / 待补）同样按界面文案查，
 *     它们一旦出现在用户能看见的地方就是"没做完就发出去了"；
 *   · CSS 的 `content: '…'` 也在射程内（伪元素塞表情是同一类问题）。
 *
 * 断言总数恒为 5（见 TOTAL_ASSERTIONS）。
 * 用法：
 *   node tools/check-ui-copy.mjs            # 校验（闸门用）
 *   node tools/check-ui-copy.mjs --selftest # 只跑检测器自证
 */
import fs from 'node:fs'
import path from 'node:path'
import { lineOf, skipString, stripComments, walk } from './lib/source-scan.mjs'

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
)
const RENDERER = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer')

/** 断言总数：闸门用它钉死"断言有没有被悄悄删掉" */
export const TOTAL_ASSERTIONS = 5

/**
 * 彩色 emoji 与装饰符号。
 * ⚠️ 别把 ← → ↑ ↓（U+2190–U+21FF）加进来 —— 快捷键提示（「前一帧（←）」）要用，
 *    一并禁掉会把正确的界面也判错，然后这道闸门就会被人无脑忽略。
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u

/** 开发痕迹词：出现在界面文案里就是"没做完" */
const DEVEL_MARKS = [
  { re: /\bTODO\b/, what: 'TODO' },
  { re: /\bFIXME\b/, what: 'FIXME' },
  { re: /\bXXX\b/, what: 'XXX' },
  { re: /\bLorem\b/i, what: 'Lorem' },
  /* ⚠️ 只查"占位图/占位素材/占位文案/占位内容"这种**承认没做完**的说法。
     裸「占位」不算 —— 「时间线占位随之变成 3.2 秒」里的"占位"指的是片段在时间线上
     占的长度，是剪辑软件的正经术语，判它就是在制造假红。 */
  { re: /占位(图|素材|文案|内容)/, what: '「占位」' },
  { re: /待补/, what: '「待补」' },
  { re: /待定/, what: '「待定」' },
  { re: /示例(文本|文案)/, what: '「示例文本」' }
]

/* ------------------------------------------------------------- 检测器本体 */

/**
 * 扫一份源码，返回界面文案里的违禁品。
 *
 * 为什么**再剥一次注释**：`stripComments` 只剥注释、保留字符串，正好就是我们要的
 * "界面文案"视图 —— 注释里的 ⚠️ 被换成空白（行号不变），字符串原样留下。
 * JSX 文本节点（`>文字<` 之间的内容）不在任何引号里，同样原样留下，一并查到。
 */
function scanCopy(file, text) {
  const found = []
  const body = stripComments(text)
  let i = 0
  const n = body.length
  while (i < n) {
    const ch = body[i]
    // 字符串字面量：原样扫（skipString 保证不会把串里的 // 当注释）
    if (ch === "'" || ch === '"' || ch === '`') {
      const stop = skipString(body, i)
      const raw = body.slice(i, stop)
      pushHits(found, file, body, i, raw, true)
      i = stop
      continue
    }
    i += 1
  }
  // JSX 文本节点：剥掉所有字符串后剩下的裸文本就是它（含标签属性之外的中文）
  const noStrings = body.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, (m) => ' '.repeat(m.length))
  pushHits(found, file, noStrings, 0, noStrings, false)
  return found
}

/** 在一段文本里找违禁品，命中就记一条（带行号与原文片段） */
function pushHits(found, file, lineBase, offset, text, inString) {
  const lines = text.split('\n')
  let cursor = offset
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k]
    const lineNo = lineOf(lineBase, cursor)
    const m = EMOJI.exec(line)
    if (m) {
      found.push({
        file,
        line: lineNo,
        kind: 'emoji',
        what: m[0],
        snippet: line.trim().slice(0, 120),
        inString
      })
    }
    for (const mark of DEVEL_MARKS) {
      if (mark.re.test(line)) {
        found.push({
          file,
          line: lineNo,
          kind: 'devel',
          what: mark.what,
          snippet: line.trim().slice(0, 120),
          inString
        })
      }
    }
    cursor += line.length + 1
  }
}

/** CSS：只查 `content: '…'` —— 其余位置的表情不参与渲染 */
function scanCss(file, text) {
  const found = []
  const body = stripComments(text)
  for (const m of body.matchAll(/content\s*:\s*(?:'([^']*)'|"([^"]*)")/g)) {
    const value = m[1] ?? m[2] ?? ''
    const hit = EMOJI.exec(value)
    if (hit) {
      found.push({
        file,
        line: lineOf(body, m.index),
        kind: 'emoji',
        what: hit[0],
        snippet: `content: '${value}'`,
        inString: true
      })
    }
  }
  return found
}

function scanAll() {
  const found = []
  for (const file of walk(RENDERER, /\.(jsx?|mjs)$/)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    found.push(...scanCopy(rel, fs.readFileSync(file, 'utf8')))
  }
  for (const file of walk(RENDERER, /\.css$/)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    found.push(...scanCss(rel, fs.readFileSync(file, 'utf8')))
  }
  return found
}

/* ------------------------------------------------------------------ 夹具 */

/**
 * 合成夹具：证明检测器**能说是**。
 *
 * 三处 emoji 分别在：带引号的 label 字符串、JSX 文本节点、CSS 的 content。
 * 另外**注释里也放了一个** emoji 与一个 TODO —— 那两处必须**不**被报出来，
 * 否则就是"注释也算界面文案"的误报，这道闸会天天红。
 */
const FIXTURE_JSX = `import './x.css'
/** 注释里的 ⚠️ 与 TODO 是给开发看的，不算界面文案 */
const ITEMS = [
  { key: 'a', label: '万圣节 🎃' },
  { key: 'b', label: '最新' }
]
export function P() {
  return (
    <div>
      梗图贴纸 😺
      <span>秋天</span>
    </div>
  )
}
`
const FIXTURE_CSS = `.x::after {
  content: '🔥';
}
`

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const selftest = process.argv.includes('--selftest')
  let pass = 0
  let fail = 0
  const check = (name, ok, detail = '') => {
    if (ok) pass += 1
    else fail += 1
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
  }

  if (selftest) {
    const jsHits = scanCopy('fixture.jsx', FIXTURE_JSX)
    const cssHits = scanCss('fixture.css', FIXTURE_CSS)
    const all = [...jsHits, ...cssHits]
    check(
      '4. 自证：夹具里恰好报出 3 处 emoji（label 串 / JSX 文本 / CSS content 各一）',
      all.length === 3,
      `报了 ${all.length} 处：${all.map((h) => `${h.line}:${h.what}`).join(' ') || '无'}`
    )
    check(
      '5. 自证：注释里的 ⚠️ 与 TODO 不算界面文案（不误报）',
      !all.some((h) => h.snippet.includes('注释里的')),
      all.map((h) => h.snippet.slice(0, 40)).join(' | ') || '无命中'
    )
    console.log(`\nUI_COPY_CHECK_STATS ok=${pass} total=${pass + fail} fail=${fail}`)
    console.log(fail ? 'UI_COPY_CHECK_FAILED' : 'UI_COPY_CHECK_OK')
    process.exitCode = fail ? 1 : 0
    return
  }

  const found = scanAll()
  const emojiHits = found.filter((h) => h.kind === 'emoji')
  const develHits = found.filter((h) => h.kind === 'devel')

  console.log('界面文案体检（客户端渲染层：字符串 / JSX 文本 / CSS content）\n')

  if (emojiHits.length) {
    console.log(`  ✗ 界面文案里的 emoji / 装饰符号（${emojiHits.length} 处）：`)
    for (const h of emojiHits) console.log(`    ${h.file}:${h.line}  ${h.what}  ← ${h.snippet}`)
    console.log('')
  }
  check('1. 界面文案里没有 emoji / 装饰符号（商业软件不用彩色表情当 UI 元素）', emojiHits.length === 0, `${emojiHits.length} 处`)

  if (develHits.length) {
    console.log(`  ✗ 界面文案里的开发痕迹（${develHits.length} 处）：`)
    for (const h of develHits) console.log(`    ${h.file}:${h.line}  ${h.what}  ← ${h.snippet}`)
    console.log('')
  }
  check('2. 界面文案里没有开发痕迹词（TODO / 占位 / 待补 / Lorem …）', develHits.length === 0, `${develHits.length} 处`)

  check(
    '3. 扫描覆盖面非空（渲染层确实被扫到了，不是空转）',
    walk(RENDERER, /\.(jsx?|mjs)$/).length > 10 && walk(RENDERER, /\.css$/).length >= 3,
    `js ${walk(RENDERER, /\.(jsx?|mjs)$/).length} 个 / css ${walk(RENDERER, /\.css$/).length} 个`
  )

  const jsHits = scanCopy('fixture.jsx', FIXTURE_JSX)
  const cssHits = scanCss('fixture.css', FIXTURE_CSS)
  const fixtureAll = [...jsHits, ...cssHits]
  check(
    '4. 自证：夹具里恰好报出 3 处 emoji（label 串 / JSX 文本 / CSS content 各一）',
    fixtureAll.length === 3,
    `报了 ${fixtureAll.length} 处：${fixtureAll.map((h) => `${h.line}:${h.what}`).join(' ') || '无'}`
  )
  check(
    '5. 自证：注释里的 ⚠️ 与 TODO 不算界面文案（不误报）',
    !fixtureAll.some((h) => h.snippet.includes('注释里的')),
    fixtureAll.map((h) => h.snippet.slice(0, 40)).join(' | ') || '无命中'
  )

  console.log(`\nUI_COPY_CHECK_STATS ok=${pass} total=${pass + fail} fail=${fail}`)
  console.log(fail ? 'UI_COPY_CHECK_FAILED' : 'UI_COPY_CHECK_OK')
  process.exitCode = fail ? 1 : 0
}

main()
