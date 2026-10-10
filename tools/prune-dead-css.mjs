#!/usr/bin/env node
/**
 * 死 CSS 清理 —— 删掉「定义了但源码里用不到」的类。
 *
 * 为什么要有它（2026-10-02 PM 审查 P1-4）：界面从旧骨架（`.timeline` / `.transport` /
 * `.track-*` / `.project-name` …）换成 `wb-*` 系列之后，旧类的规则**一直留在 CSS 里**。
 * 它们不报错、不影响构建、不影响任何断言，只是让 styles.css 越长越厚，
 * 并让"这个样式到底还生效吗"变成一个没人敢回答的问题。
 *
 * 安全边界（**只删整块，绝不改选择器内部**）：
 *   一条规则被删，当且仅当**它的选择器里每一个类都是死类**，且选择器不含
 *   元素选择器 / ID / 属性选择器 / 伪元素 —— 避免动到 `.timeline .clip` 这种
 *   （虽然 .timeline 是死类，但规则其实还可能被别的结构命中）。
 *   拿不准的一律保留。
 *
 * 动态拼接的类**不算死类**（白名单）：`style-anim-${x}`、`is-${sizeKey}`（title/subtitle）、
 * `enh-grid is-${size}` —— 它们在源码里从没以完整字符串出现过，靠扫描必定误判。
 *
 * 用法：
 *   node tools/prune-dead-css.mjs --dry   # 只报将删哪些（不落盘）
 *   node tools/prune-dead-css.mjs         # 真删
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const RENDERER = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer')
const dry = process.argv.includes('--dry')

/**
 * 动态拼接豁免：这些类在源码里永远找不到完整字符串，是拼出来的。
 * ⚠️ 加白名单必须写明拼接点在哪个文件哪一行 —— 不然白名单会自己变成一处死代码。
 */
const DYNAMIC = [
  { prefix: 'style-anim-', where: 'renderer/textStyles.js:157 animClassOf() = `style-anim-${def.anim}`' },
  { name: 'is-title', where: 'renderer/components/SidePanels.jsx:586 sizeKey="title"' },
  { name: 'is-subtitle', where: 'renderer/components/SidePanels.jsx:628 sizeKey="subtitle"' }
]
const isDynamic = (cls) => DYNAMIC.some((d) => (d.prefix ? cls.startsWith(d.prefix) : cls === d.name))

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const f = path.join(dir, e.name)
    if (e.isDirectory()) walk(f, exts, out)
    else if (exts.test(e.name)) out.push(f)
  }
  return out
}

const srcFiles = walk(RENDERER, /\.(jsx?|mjs)$/).concat(walk(path.join(ROOT, 'packages', 'installer', 'src'), /\.jsx?$/))
const srcText = srcFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const used = new Set()
for (const m of srcText.matchAll(/[A-Za-z][\w-]*/g)) used.add(m[0])

/**
 * 切出顶层规则（带 @media 的一律跳过 —— 嵌套结构改起来容易出错，收益也小）。
 * 单趟扫描：字符串感知，注释保留换行（行号不能失真）。
 */
function rulesOf(text) {
  const rules = []
  let i = 0
  let selStart = 0
  let brace = -1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (ch === '{') {
      if (brace === -1) {
        brace = i
      }
      i += 1
      continue
    }
    if (ch === '}') {
      if (brace !== -1) {
        rules.push({ sel: text.slice(selStart, brace), bodyStart: brace, bodyEnd: i + 1 })
        brace = -1
      }
      selStart = i + 1
      i += 1
      continue
    }
    if (brace === -1 && (ch === ',' || ch === '\n')) {
      // 选择器可能跨行（格式化后的 CSS 很常见），继续吃
      i += 1
      continue
    }
    i += 1
  }
  return rules
}

/** 选择器是否「只由死类构成」 */
function onlyDeadClasses(selector) {
  const sel = selector.trim()
  if (!sel) return false
  if (sel.startsWith('@')) return false // @media / @keyframes 的壳
  if (/^[a-zA-Z]/.test(sel)) return false // 元素选择器开头（div.foo / a:hover 之类）
  if (sel.includes('#') || sel.includes('[') || sel.includes('::')) return false
  if (sel.includes('*')) return false

  const classes = [...sel.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1])
  if (!classes.length) return false
  // 去掉类名后剩下的必须只有 空白 / 逗号 / 伪类 / 组合符
  const rest = sel.replace(/\.(-?[A-Za-z_][\w-]*)/g, '').replace(/[\s,>+~]/g, '')
  const pseudoOk = rest === '' || /^(:{1,2}[\w-]+(\([^)]*\))?)+$/.test(rest)
  if (!pseudoOk) return false

  return classes.every((cls) => !used.has(cls) && !isDynamic(cls))
}

function main() {
  const cssFiles = walk(RENDERER, /\.css$/)
  let totalRules = 0
  let pruned = 0
  const removed = []

  for (const file of cssFiles) {
    const text = fs.readFileSync(file, 'utf8')
    const rules = rulesOf(text)
    totalRules += rules.length
    const hits = rules.filter((r) => onlyDeadClasses(r.sel))

    if (!hits.length) continue
    pruned += hits.length
    for (const r of hits) removed.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}  ${r.sel.trim().slice(0, 80)}`)

    if (dry) continue

    // 从后往前删，前面的下标才不会失效
    let next = text
    for (const r of hits.slice().reverse()) {
      const before = next.slice(0, r.sel.length ? next.indexOf(r.sel) : 0)
      // 用块体位置切，避免选择器含换行时 indexOf 对不上
      const start = next.lastIndexOf(r.sel, r.bodyStart)
      const from = start === -1 ? r.bodyStart : start
      next = next.slice(0, from) + next.slice(r.bodyEnd)
    }
    // 连续三个以上空行压成一个，别留下一条条空带
    next = next.replace(/\n{3,}/g, '\n\n')
    fs.writeFileSync(file, next)
  }

  console.log(`CSS 规则 ${totalRules} 条，判定为死类规则 ${pruned} 条${dry ? '（--dry，未落盘）' : '（已删除）'}`)
  for (const row of removed) console.log(`  - ${row}`)
  console.log(`DEAD_CSS_PRUNE_STATS rules=${totalRules} pruned=${pruned}`)
  console.log('DEAD_CSS_PRUNE_OK')
}

main()
