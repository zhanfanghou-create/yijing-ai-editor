#!/usr/bin/env node
/**
 * 「按钮有没有去处」的看门狗 —— 渲染层里每个 `<button>` 都必须接上处理函数。
 *
 * 为什么需要它：一个**画好了但没接**的按钮，是本项目最难发现的一类缺陷。
 *   · 构建通过、类型检查通过、位置/配色/尺寸逐像素对得上参考；
 *   · hover、focus、禁用态全对（那些都是 CSS）；
 *   · 现有的每一道 E2E 都在点**自己关心的那几个**按钮，没人点它；
 *   · 用户看到的症状只有一句：「点下去没反应」。
 * 2026-09-23 实测：渲染层有 7 个这种按钮 —— 时间线工具栏右侧那一簇里
 * 「时间线音量 / 字幕 / 时间线设置 / 全屏时间线」四个连 onClick 都没有，
 * 「素材库」「AI 工具」两个**接错成了导入**（点了弹出选文件的框），
 * 预览区和首页各有一个。它们全都通过了当时 37 道闸门。
 *
 * 判据（保守，宁可漏报不误报）：
 *   · 打开标签里有 onClick / onPointerDown / onPointerUp / onChange / onSubmit 之类 → 有去处；
 *   · `type="submit"` → 交给表单，不算死（Dialogs.jsx 里的表单提交按钮就是这种）；
 *   · 含 `{...spread}` → 处理函数可能是展开进来的，判不了，放行；
 *   · 恒 `disabled` → 禁用按钮本来就不该有行为，放行。
 * 反过来说不清的是「接错了」（onClick 指向另一个动作）—— 那要靠 E2E 点完读效果，
 * 静态看是看不出来的（本文件头里那两个反例就是这么被抓出来的）。
 *
 * 断言总数恒为 5（见 TOTAL_ASSERTIONS）。
 * 用法：
 *   node tools/check-dead-buttons.mjs            # 校验（闸门用）
 *   node tools/check-dead-buttons.mjs --selftest # 只跑检测器自证
 */
import fs from 'node:fs'
import path from 'node:path'
import { lineOf, skipString, stripComments, walk } from './lib/source-scan.mjs'

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
)
const RENDERER = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer')

/** 算作「有去处」的事件属性 */
const HANDLERS = /on(Click|PointerDown|PointerUp|PointerMove|Change|Input|Submit|MouseDown|KeyDown|KeyUp|Focus|Blur)\s*[=:]/

/* ------------------------------------------------------------- 检测器本体 */

/**
 * 从 `<button` 的下标处读出整个开标签（到配对的 `>` 为止）。
 *
 * 必须做括号与字符串感知：`onClick={() => setOpen({ a: 1 })}` 里的 `}` 会让
 * 朴素的「找第一个 > 」提前收尾，于是同标签后面的 onClick 落在窗口外 ⇒ **漏报**。
 */
function openTagRange(text, lt) {
  let i = lt
  let depth = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i)
      continue
    }
    if (ch === '{') {
      depth += 1
      i += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      i += 1
      continue
    }
    if (ch === '>' && depth === 0) return [lt, i + 1]
    i += 1
  }
  return null
}

/**
 * 扫一段 JSX 源码，返回 `{ total, dead[] }`。
 * 纯函数（不碰磁盘），所以自证可以直接喂合成夹具进来。
 */
export function scanSource(raw) {
  const text = stripComments(raw)
  let total = 0
  const dead = []

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '<') continue
    if (!/^<button\b/.test(text.slice(i, i + 8))) continue
    const range = openTagRange(text, i)
    if (!range) continue
    const tag = text.slice(range[0], range[1])
    i = range[1] - 1
    total += 1

    if (HANDLERS.test(tag)) continue
    if (/type="submit"/.test(tag)) continue
    if (tag.includes('{...')) continue
    if (/disabled(?!\s*=)/.test(tag) || /disabled=\{true\}/.test(tag)) continue

    const title =
      (tag.match(/title="([^"]*)"/) || tag.match(/aria-label="([^"]*)"/) || [, ''])[1]
    const cls = (tag.match(/className="([^"]*)"/) || [, ''])[1]
    dead.push({ line: lineOf(text, range[0]), title, cls, tag: tag.replace(/\s+/g, ' ') })
  }

  return { total, dead }
}

/* --------------------------------------------------------------- 自证夹具 */

/**
 * 合成夹具：**必须**包含一个真死按钮、一个接错也没法静态发现的正常按钮，
 * 以及三条各自该被放行的形式（submit / spread / 恒禁用）。
 *
 * 关键点：夹具本身必须是仓库常驻文件里的字符串常量（不是临时文件），
 * 否则"检测器自证"会依赖一个跑完就没了的东西。
 * 另外这里**故意**让「死按钮」在带 `{ a: 1 }` 的花括号 onClick **之后** ——
 * 若 openTagRange 不做括号感知，第二个按钮会被当成有 onClick 而漏报，
 * 自证就会红。这是对检测器本身的检查（承本项目「检查器也要被检查」的约定）。
 */
export const FIXTURE = `
const a = (
  <>
    <button type="button" onClick={() => setOpen({ a: 1 })} title="正常">
      <IconA />
    </button>
    <button type="button" title="这个没有去处">
      <IconB />
    </button>
    <button type="submit" form="f">提交</button>
    <button {...rest}>展开进来的</button>
    <button type="button" disabled>恒禁用</button>
  </>
)
`

/* --------------------------------------------------------------- 断言账 */

const TOTAL_ASSERTIONS = 5
let pass = 0
let fail = 0
const failures = []
let emitted = 0

function check(label, ok, detail = '') {
  emitted += 1
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

function main() {
  const selftestOnly = process.argv.includes('--selftest')
  console.log('=== 按钮去处检查（渲染层每个 <button> 都要有处理函数）===\n')

  const files = walk(RENDERER, /\.jsx$/)
  let total = 0
  const dead = []
  let filesWithButtons = 0

  for (const file of files) {
    const result = scanSource(fs.readFileSync(file, 'utf8'))
    if (result.total > 0) filesWithButtons += 1
    total += result.total
    for (const row of result.dead) {
      dead.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), ...row })
    }
  }

  if (!selftestOnly) {
    /* 1) 防空转：扫到 0 个按钮时，下面那条「0 个死按钮」就恒真 —— 必须单独钉住。
       2026-09-23 实测 108 个，给一个下界即可（数量会随功能增减，钉死总数会天天红）。 */
    check('1. 扫到了 <button>（扫描器没空转）', total >= 60, `共 ${total} 个`)
    check('2. 每个含按钮的文件都被扫到', filesWithButtons >= 8, `${filesWithButtons} 个文件`)

    /* 2) 主断言：0 个死按钮 */
    if (dead.length) {
      console.log('\n  以下按钮没有处理函数：')
      for (const row of dead) {
        console.log(`    ${row.file}:${row.line}  「${row.title || '(无 title)'}」  ${row.cls}`)
        console.log(`      ${row.tag.slice(0, 140)}`)
      }
      console.log('')
    }
    check('3. 渲染层没有「画好了但没接」的按钮', dead.length === 0, `${dead.length} 个`)
  }

  /* 4/5) 检测器自证：拿合成夹具证明它**能说是** */
  const fixture = scanSource(FIXTURE)
  check(
    '4. 自证：合成夹具里恰好报出 1 个死按钮（多报=误报，少报=漏报）',
    fixture.dead.length === 1 && fixture.dead[0].title === '这个没有去处',
    `报了 ${fixture.dead.length} 个：${fixture.dead.map((d) => d.title || '(无)').join(' / ') || '无'}`
  )
  check(
    '5. 自证：夹具里 5 个按钮全被数到（submit / spread / 禁用 / 正常都不算死）',
    fixture.total === 5 && fixture.dead.length === 1,
    `数到 ${fixture.total} 个`
  )

  console.log(`\nDEAD_BUTTON_CHECK_STATS ok=${pass} total=${pass + fail} fail=${fail}`)
  console.log(fail ? 'DEAD_BUTTON_CHECK_FAILED' : 'DEAD_BUTTON_CHECK_OK')
  process.exitCode = fail ? 1 : 0
}

main()

export { TOTAL_ASSERTIONS }
