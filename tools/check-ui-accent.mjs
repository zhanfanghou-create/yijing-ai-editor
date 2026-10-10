#!/usr/bin/env node
/**
 * 「界面强调色只许一套」检查。
 *
 * 盯的是**视觉一致性**这类缺陷：它不报错、不影响功能、任何功能测试都不会红，
 * 只有把界面截出来看才发现"同一栏里两套颜色"。
 *
 * 2026-10-10 Jason 实测指出：「ui 配色要统一，好多标签用了蓝色」。
 * 当时工作台里并行着两套强调色：
 *   · 品牌紫 #c36bf5 / #b86be4 / #c473f2 / #ce76ff —— 功能标签、右栏页签、比例 chip；
 *   · 青色 #00C1CD —— 子页签选中、分节圆点、开关、取色环、输入聚焦框、播放条时码。
 * 于是「子页签选中是青、它上级的页签选中是紫」，同一栏里像两个产品。
 *
 * 现在只留紫系，并且**收敛成一个令牌**：`styles.css` 的 `--violet`，
 * 工作台的 `--wb-accent / --wb-accent-hi / --wb-accent-deep` 全部指向它。
 *
 * 这道闸钉三件事：
 *   ① 青色 UI 强调**不许回来**（去注释后按声明值扫）；
 *   ② 工作台里**不许再出现裸的品牌紫字面量** —— 必须走令牌，否则"改一处漏三处"；
 *   ③ 令牌本身存在且同源（`--wb-accent: var(--violet)`）。
 * 外加一条覆盖面判据：扫到的强调色引用数不为 0 —— 解析失效时不许"等于没查"。
 *
 * ⚠️ 例外（有意保留，不算违规）：
 *   · `--clip-overlay`（#1f7f8c）是**轨道身份色**，必须与视频蓝 / 音频绿 / 字幕紫拉得开；
 *   · 首页模板封面、反馈卡插画里的蓝青绿渐变是**内容色**，不是 UI 强调色。
 *   所以判据只扫 `#00C1CD` / `rgba(0,193,205)` 这一支具体的青，不扫"所有偏蓝的颜色"。
 *
 * 用法：node tools/check-ui-accent.mjs [仓库根]
 * 退出码：0 = 一致；1 = 发现第二套强调色；2 = 参数/文件不对；3 = 检查器自身异常
 */

import fs from 'node:fs'
import path from 'node:path'

const exit = { ok: 0, bad: 1, usage: 2, crash: 3 }

const problems = []
const notes = []

const fail = (label, detail = '') => problems.push(detail ? `${label} — ${detail}` : label)

/**
 * 把 CSS 注释按等长空格抹掉（保留换行），下标与原文一一对应。
 *
 * 必须先做这一步：这些文件里的注释**大量记录着实测色值**（「参考实测 #c473f2」之类），
 * 不抹掉就会把"证据笔记"当成"还在用这套色"判红 —— 假红比漏报更贵。
 */
function stripCssComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
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

const strip = (src) => stripCssComments(String(src))

/** 青色 UI 强调：#00C1CD 与它的 rgba 写法 */
const CYAN_ACCENT = /#00c1cd|rgba\(\s*0\s*,\s*193\s*,\s*205\s*,/i

/** 裸的品牌紫字面量（工作台里必须走令牌） */
const BARE_BRAND_PURPLE = /#(?:c36bf5|b86be4|c473f2|ce76ff|8372fe|9a8cff)\b/i

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`读不到 ${path.basename(file)}`, String(error && error.message))
    return ''
  }
}

function main() {
  const root = path.resolve(process.argv[2] || '.')
  const dir = path.join(root, 'packages', 'desktop', 'src', 'renderer')
  if (!fs.existsSync(dir)) {
    console.error(`参数/文件错误：找不到渲染层样式目录 ${dir}`)
    return exit.usage
  }

  const cssFiles = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => path.join(dir, name))
  if (!cssFiles.length) {
    console.error('参数/文件错误：渲染层一个 .css 都没有')
    return exit.usage
  }

  const wbPath = path.join(dir, 'workbench.css')
  const basePath = path.join(dir, 'styles.css')
  for (const p of [basePath, wbPath]) {
    if (!fs.existsSync(p)) fail('缺少样式文件', p)
  }
  if (problems.length) {
    console.error('参数/文件错误，没能开始检查：')
    for (const p of problems) console.error(`  ✗ ${p}`)
    return exit.usage
  }

  /* ---------- ① 青色 UI 强调不许回来 ---------- */
  const cyanHits = []
  for (const file of cssFiles) {
    const body = strip(read(file))
    body.split('\n').forEach((line, idx) => {
      if (CYAN_ACCENT.test(line)) cyanHits.push(`${path.basename(file)}:${idx + 1}  ${line.trim()}`)
    })
  }
  if (cyanHits.length) {
    fail(
      `渲染层 CSS 里又有青色 UI 强调（${cyanHits.length} 处）—— 界面强调色必须是唯一一套`,
      cyanHits.slice(0, 4).join(' | ')
    )
  }
  notes.push(`青色强调扫描：${cssFiles.length} 个 CSS 文件，命中 ${cyanHits.length} 处`)

  /* ---------- ② 工作台的强调色一律走令牌 ---------- */
  const wbBody = strip(read(wbPath))
  const bareHits = []
  wbBody.split('\n').forEach((line, idx) => {
    if (BARE_BRAND_PURPLE.test(line)) bareHits.push(`${idx + 1}  ${line.trim()}`)
  })
  if (bareHits.length) {
    fail(
      `workbench.css 里有裸的品牌紫字面量（${bareHits.length} 处）—— 必须走 --wb-accent 令牌`,
      bareHits.slice(0, 4).join(' | ')
    )
  }

  /* ---------- ③ 令牌存在且同源 ---------- */
  const baseBody = strip(read(basePath))
  const violetDef = /--violet\s*:\s*(#[0-9a-f]{6})\s*;/i.exec(baseBody)
  if (!violetDef) {
    fail('styles.css 里没有 --violet 的定义 —— 强调色的唯一真源丢了')
  } else if (/--cyan\s*:/.test(baseBody)) {
    /* 已废弃的 --cyan 令牌：留着只会让人以为"还有一套青色可用" */
    fail('styles.css 里又出现了 --cyan 令牌 —— 那是一支没人引用、且与"只有一套强调色"矛盾的旧色')
  }

  const accentAlias = /--wb-accent\s*:\s*var\(--violet\)\s*;/i.test(wbBody)
  if (!accentAlias) {
    fail('workbench.css 的 --wb-accent 没有指向 styles.css 的 --violet —— 两处各写一份值，改一处就会分叉')
  }

  /* ---------- ④ 覆盖面：解析失效不许"等于没查" ----------
     ⚠️ 阈值故意定在 5 而不是 0：令牌定义自身（`--wb-accent: var(--violet)`）也算一次
        引用，如果只判">0"，一个只剩定义、正文全被清空的文件也会被判绿。
        真实界面里"选中态 / 开关 / 聚焦环"加起来远不止 5 处。 */
  const accentUses =
    (wbBody.match(/var\(--wb-accent/g) || []).length + (baseBody.match(/var\(--violet/g) || []).length
  if (accentUses < 5) {
    fail(
      `强调色令牌的引用只有 ${accentUses} 处（至少要 5）—— 要么解析失效、要么界面上的选中态绕过了令牌`,
      '这条是防"看门狗空转却报绿"，不是审美要求'
    )
  }
  notes.push(`强调色令牌引用：workbench + styles 共 ${accentUses} 处；令牌真源 ${violetDef ? violetDef[1] : '(无)'}`)

  for (const n of notes) console.log(`  · ${n}`)
  if (problems.length) {
    console.error('')
    console.error(`界面强调色一致性：发现 ${problems.length} 处问题`)
    for (const p of problems) console.error(`  ✗ ${p}`)
    return exit.bad
  }
  console.log('UI_ACCENT_STATS total=4 pass=4 fail=0')
  console.log('UI_ACCENT_OK')
  return exit.ok
}

try {
  process.exitCode = main()
} catch (error) {
  console.error('检查器自身异常（这不是被测代码的问题，是检查器崩了）：')
  console.error(String((error && error.stack) || error))
  process.exitCode = exit.crash
}
