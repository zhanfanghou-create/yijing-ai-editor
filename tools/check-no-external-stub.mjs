#!/usr/bin/env node
/**
 * 「入口不许是空的」检查 —— 专门盯三种"界面上有入口、功能上等于没有"的写法。
 *
 * 这三种写法**都能通过编译、都能通过静态导入检查、都能通过逐像素比对**，
 * 只有真点一遍（或读代码时特意留意）才看得出来，所以必须机械钉住：
 *
 *   ① `window.open(...)` —— 在 Electron 里会被主进程拦下、交给系统浏览器。
 *      更糟的是它常配一句「在新窗口打开」的文案：按钮说新窗口、实际弹浏览器，
 *      用户读作"点了没反应"。一律改走 `platform.openExternal`（并如实改文案）。
 *   ② `openExternal('https://example.com')` 这类**裸官网首页** ——
 *      把某个入口做成跳官网，等于这个入口没有功能。
 *   ③ `toast('...还没接上')` 这类占位提示 —— 点下去只弹一句话，事情一件没办。
 *
 * 2026-09-26 现状：三类在渲染层各被清掉若干处（TopBar 礼盒/消息、Home 反馈/客服、
 * Inspector 的 window.open）。这道闸就是为了让它们**回不来**。
 *
 * 用法：node tools/check-no-external-stub.mjs [仓库根]
 *
 * 退出码：0 = 干净；1 = 发现占位入口；2 = 参数/文件不对；3 = 检查器自身异常
 */

import fs from 'node:fs'
import path from 'node:path'

const exit = { ok: 0, bad: 1, usage: 2, crash: 3 }

const problems = []
const notes = []

function walk(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'assets' || e.name.startsWith('.')) continue
      walk(p, out)
    } else if (/\.(jsx?|mjs|tsx?)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

/**
 * 在同一份源码上做两次判定：先抹注释，再判。
 * 注释里引用 `window.open('https://example.com')` 说明"以前是这样的"（本文件自己就有），
 * 不抹会把**解释为什么不该这么写**的注释本身判成违规 —— 那会逼人删注释，适得其反。
 */
function stripComments(text) {
  let out = ''
  let s = null
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (s) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === s) s = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      s = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function main() {
  const root = path.resolve(process.argv[2] || '.')
  const rendererDir = path.join(root, 'packages', 'desktop', 'src', 'renderer')
  if (!fs.existsSync(rendererDir)) {
    console.error('找不到渲染层目录，检查没跑成：' + rendererDir)
    return exit.usage
  }

  const files = walk(rendererDir).filter((f) => !f.includes(`${path.sep}assets${path.sep}`))
  notes.push(`扫描渲染层 ${files.length} 个源文件`)

  let windowOpens = 0
  let bareSite = 0
  let stubs = 0

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8')
    const src = stripComments(raw)
    const rel = path.relative(root, file).replace(/\\/g, '/')

    /* ① window.open —— 在 Electron 里是"甩给系统浏览器"，且文案常写成"新窗口"。
          唯一豁免：`platform.openExternal` 自身在浏览器态（没有 bridge）只能用 window.open，
          那一行必须带 `allow-window-open` 注释说明理由 —— 不标就红，防止"随便豁免"。 */
    for (const m of src.matchAll(/\bwindow\.open\s*\(/g)) {
      // ⚠️ 标记要按 **raw** 查，不能按 src 查：src 已经把注释抹成空格了，
      //    而 `allow-window-open` 本身就是写在注释里的 —— 在 src 上查永远查不到。
      const lineStart = raw.lastIndexOf('\n', m.index) + 1
      const lineEnd = raw.indexOf('\n', m.index)
      const line = raw.slice(lineStart, lineEnd < 0 ? raw.length : lineEnd)
      // 标记可以写在这一行，也可以写在紧挨着的上几行（多行注释说明原因更好读）。
      // 取"往前 320 字符"这个窗口而不是固定行数：注释行数会变，按行数取迟早对不上。
      const prev = raw.slice(Math.max(0, lineStart - 320), lineStart)
      if (/allow-window-open/.test(line) || /allow-window-open/.test(prev)) continue
      windowOpens += 1
      problems.push(`${rel}:${lineOf(src, m.index)} 用了 window.open —— Electron 会把它交给系统浏览器，「新窗口」是假象；改用 platform.openExternal（确需保留就在该行加 allow-window-open 注释说明理由）`)
    }

    /* ② openExternal 到裸官网首页 —— 有入口没功能的典型形态。
          只看**字面量 URL**：变量里装什么（`openExternal(url)`）无从静态判断，
          判了就是假红，宁可放过。 */
    for (const m of src.matchAll(/openExternal\s*\(\s*(['"`])(https?:\/\/[^'"`]*)\1/g)) {
      const url = m[2]
      // 只拦"站点的根路径"：带具体路径（如 /docs）通常是有意的内容页
      const pathOnly = url.replace(/^https?:\/\/[^/]+/i, '')
      if (pathOnly && pathOnly !== '/') continue
      bareSite += 1
      problems.push(`${rel}:${lineOf(src, m.index)} openExternal 指向官网首页 ${url} —— 这等于该入口没有功能（跳网页不算实现）；要做成应用内真功能`)
    }

    /* ③ 占位式提示：点下去只弹一句话。
          ⚠️ 关键词必须收窄到「这个功能还没做」这一语义 —— 用"还没有"会把
             「时间线上还没有片段，滤镜没有作用对象」这类**合法的状态提示**一起判红；
             假红会训练人无脑忽略这道闸门，代价远大于它带来的那点保护。 */
    const STUB = /(?:还没接上|还不支持|暂不支持|暂未开放|暂未实现|敬请期待|即将上线|待实现|开发中|未接入)/
    for (const m of src.matchAll(/toast(?:\.(?:bad|good))?\s*\(\s*(['"`])([^'"`]*)\1/g)) {
      if (!STUB.test(m[2])) continue
      stubs += 1
      problems.push(`${rel}:${lineOf(src, m.index)} 占位式提示「${m[2]}」—— 点下去只弹一句话，事情一件没办`)
    }
  }

  notes.push(`window.open ${windowOpens} 处 · 裸官网外链 ${bareSite} 处 · 占位提示 ${stubs} 处`)

  for (const n of notes) console.log(`  · ${n}`)
  if (problems.length) {
    console.error('')
    console.error(`入口不许是空的：发现 ${problems.length} 处`)
    for (const p of problems) console.error(`  ✗ ${p}`)
    return exit.bad
  }
  console.log('NO_EXTERNAL_STUB_STATS total=3 pass=3 fail=0')
  console.log('NO_EXTERNAL_STUB_OK')
  return exit.ok
}

try {
  process.exitCode = main()
} catch (error) {
  console.error('检查器自身异常（这是检查器崩了，不是被测代码有问题）：')
  console.error(String((error && error.stack) || error))
  process.exitCode = exit.crash
}
