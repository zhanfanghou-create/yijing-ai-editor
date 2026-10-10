#!/usr/bin/env node
/** 一次性扫描：CSS 里定义了但源码里没用到的类。人工判断后再动手删，不直接删。 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const RENDERER = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer')

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const f = path.join(dir, e.name)
    if (e.isDirectory()) walk(f, exts, out)
    else if (exts.test(e.name)) out.push(f)
  }
  return out
}

const cssFiles = walk(RENDERER, /\.css$/)
const srcFiles = walk(RENDERER, /\.(jsx?|mjs)$/)
  .concat(walk(path.join(ROOT, 'packages', 'installer', 'src'), /\.(jsx?)$/))
const srcText = srcFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

// 收集所有被引用的类名（字符串里出现的都算，保守）
const used = new Set()
for (const m of srcText.matchAll(/[A-Za-z][\w-]*/g)) used.add(m[0])

const defined = new Map() // class -> [file:line]
for (const file of cssFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const body = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const lines = body.split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
      const cls = m[1]
      if (!defined.has(cls)) defined.set(cls, [])
      defined.get(cls).push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`)
    }
  })
}

const dead = []
for (const [cls, locs] of defined) {
  if (used.has(cls)) continue
  dead.push({ cls, locs })
}
dead.sort((a, b) => a.cls.localeCompare(b.cls))
console.log(`CSS 类定义 ${defined.size} 个，源码里找不到引用 ${dead.length} 个：\n`)
for (const d of dead) console.log(`  ${d.cls}   ← ${d.locs.slice(0, 3).join(' , ')}`)
