#!/usr/bin/env node
'use strict'
/**
 * 闸门 ·「首页草稿视图切换」防回归判据。
 *
 * 背景（2026-11-19）：首页「最近草稿」标题旁的网格/列表两个图标是**纯装饰** ——
 * CSS 早已备好 cursor:pointer 与 [data-on='true'] 高亮，但 JSX 里没接 onClick、
 * data-on 写死 "true"，点了没反应（静默失效五类之「没接」）。用户以为能切视图，
 * 实际什么都不会发生。已修：接 draftView state，两个真按钮切换，列表模式换 DOM 布局。
 *
 * 判据读**消费端源码文本**，期望值写死在本文件里，不从被测文件推导：
 *   1. Home.jsx 有 draftView state，初值 'grid'（默认网格，保住 check-preview-aspect 的依赖）
 *   2. 两个图标是<button>，各自 data-view=grid/list + onClick setDraftView（不再是装饰 svg）
 *   3. 容器 className 按 draftView 拼出 ' is-list'，且带 data-view（E2E/人眼可读当前态）
 *   4. CSS 有 .home-draft-cards.is-list 规则，网格→单列（真会变布局，不是摆设 class）
 *   5. 卡片本体 .home-draft-card 与 onOpenDraft 仍在（没破坏既有进剪辑的 E2E）
 *
 * 纯逻辑自检（--selftest）：每条判据的正/负控制组，负组只改一个变量，必须红在**那条**上。
 *
 * 用法：
 *   node tools/check-draft-view.mjs             # 对真实源码跑判据
 *   node tools/check-draft-view.mjs --selftest  # 判据自证（秒级）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const stripJs = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/* ---------------------------------------------------------------- 判据函数 */

/** 1. draftView state 存在，默认网格（默认网格是硬约束：check-preview-aspect 点 .home-draft-card） */
function draftViewState(home) {
  const js = stripJs(home)
  if (!/useState\('grid'\)/.test(js)) return { ok: false, detail: '找不到 useState(\'grid\')' }
  if (!/\[\s*draftView\s*,\s*setDraftView\s*\]\s*=\s*useState\('grid'\)/.test(js)) {
    return { ok: false, detail: 'draftView state 未以 grid 为初值' }
  }
  return { ok: true, detail: 'draftView state 存在，默认 grid' }
}

/** 2. 两个图标是真按钮：each 有 data-view + onClick setDraftView（不是装饰 svg） */
function viewButtonsWired(home) {
  const js = stripJs(home)
  // 抓 home-viewswitch 这段（到 </span>），在里面判两个 button
  const seg = /<span className="home-viewswitch"[^>]*>([\s\S]*?)<\/span>/.exec(js)
  if (!seg) return { ok: false, detail: '找不到 .home-viewswitch 容器' }
  const body = seg[1]
  const btns = (body.match(/<button\b/g) || []).length
  if (btns !== 2) return { ok: false, detail: `视图切换里有 ${btns} 个 button（期望 2，装饰版是 0）` }
  for (const view of ['grid', 'list']) {
    if (!new RegExp(`data-view="${view}"`).test(body)) {
      return { ok: false, detail: `缺 data-view="${view}" 标识` }
    }
    if (!new RegExp(`onClick=\\{\\(\\)\\s*=>\\s*setDraftView\\('${view}'\\)\\}`).test(body)) {
      return { ok: false, detail: `${view} 按钮没接 onClick setDraftView（点了没反应）` }
    }
    if (!new RegExp(`aria-pressed=\\{draftView === '${view}'\\}`).test(body)) {
      return { ok: false, detail: `${view} 按钮缺 aria-pressed 状态` }
    }
  }
  if (/data-on="true"/.test(body)) return { ok: false, detail: '还残留写死的 data-on="true"（装饰版特征）' }
  return { ok: true, detail: '两个真按钮，各自 data-view + onClick + aria-pressed' }
}

/** 3. 容器按 draftView 拼 is-list，并带 data-view */
function containerToggles(home) {
  const js = stripJs(home)
  if (!/home-draft-cards\$\{draftView === 'list' \? ' is-list' : ''\}/.test(js)) {
    return { ok: false, detail: '卡片容器没有按 draftView 拼 is-list class' }
  }
  if (!/className=\{`home-draft-cards[^`]*`\}\s+data-view=\{draftView\}/.test(js)) {
    return { ok: false, detail: '卡片容器没有 data-view={draftView}（当前态不可读）' }
  }
  return { ok: true, detail: '容器 className 拼 is-list + data-view 暴露当前态' }
}

/** 4. CSS 有 is-list 规则，且真的把网格改成单列（不是摆设 class） */
function listLayoutReal(css) {
  const body = stripCss(css)
  function ruleBody(sel) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(esc + '(?![-\\w])[^{}]*\\{([^}]*)\\}').exec(body)
    return m ? m[1] : null
  }
  const grid = ruleBody('.home-draft-cards')
  if (!grid || !/grid-template-columns\s*:\s*repeat\(4/.test(grid)) {
    return { ok: false, detail: '默认网格规则缺失或不再是 4 列' }
  }
  const list = ruleBody('.home-draft-cards.is-list')
  if (!list) return { ok: false, detail: '没有 .home-draft-cards.is-list 规则' }
  if (!/grid-template-columns\s*:\s*1fr/.test(list)) {
    return { ok: false, detail: 'is-list 没有改成单列（class 是摆设，点了不变布局）' }
  }
  const hi = ruleBody(".home-view-btn[data-on='true']")
  if (!hi || !/var\(--h-text\)/.test(hi)) {
    return { ok: false, detail: '视图按钮选中态高亮规则缺失' }
  }
  return { ok: true, detail: 'is-list 真把网格改成单列，选中态高亮在' }
}

/** 5. 既有进剪辑契约未被破坏：卡片本体类名 + onOpenDraft 仍在 */
function cardContractKept(home) {
  const js = stripJs(home)
  const count = (js.match(/className="home-draft-card"/g) || []).length
  if (count < 1) return { ok: false, detail: '.home-draft-card 类名没了（check-preview-aspect 会失效）' }
  if (!/onClick=\{\(\)\s*=>\s*onOpenDraft\?\.\(draft\)\}/.test(js)) {
    return { ok: false, detail: '卡片点击打开草稿的 onClick 没了' }
  }
  return { ok: true, detail: `.home-draft-card（${count} 处）与 onOpenDraft 保留` }
}

const JUDGES = [
  ['1 · draftView state 默认 grid', draftViewState],
  ['2 · 视图切换是真按钮（非装饰图标）', viewButtonsWired],
  ['3 · 容器按状态切 is-list', containerToggles],
  ['4 · is-list 真改布局（非摆设 class）', listLayoutReal],
  ['5 · 卡片进剪辑契约未破坏', cardContractKept]
]

/* ---------------------------------------------------------------- 自证夹具 */

function selfTest() {
  let pass = 0
  let fail = 0
  const rec = (name, ok, detail) => {
    if (ok) {
      pass += 1
      console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`)
    } else {
      fail += 1
      console.log(`[FAIL] ${name} :: ${detail || '（无原因）'}`)
    }
  }

  const goodHome = `
    const [draftView, setDraftView] = useState('grid')
    <span className="home-viewswitch" role="group" aria-label="最近草稿视图切换">
      <button className="home-view-btn" data-view="grid" data-on={draftView === 'grid' ? 'true' : 'false'} aria-pressed={draftView === 'grid'} title="网格视图" onClick={() => setDraftView('grid')}>
        <IconGridView size={16} />
      </button>
      <button className="home-view-btn" data-view="list" data-on={draftView === 'list' ? 'true' : 'false'} aria-pressed={draftView === 'list'} title="列表视图" onClick={() => setDraftView('list')}>
        <IconListView size={16} />
      </button>
    </span>
    <div className={\`home-draft-cards\${draftView === 'list' ? ' is-list' : ''}\`} data-view={draftView}>
      <button className="home-draft-card" onClick={() => onOpenDraft?.(draft)} />
    </div>
  `
  const goodCss = `
    .home-draft-cards { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; }
    .home-draft-cards.is-list { grid-template-columns: 1fr; gap:6px; }
    .home-view-btn[data-on='true'] { color: var(--h-text); }
  `
  // 正控制组：全过
  for (const [name, judge] of JUDGES) {
    const r = name.includes('布局') ? judge(goodCss) : judge(goodHome)
    rec(`自证·${name} 正控制组`, r.ok, r.detail)
  }
  // 负控制组 1：state 初值改 list ⇒ 红在 state 条
  const r1 = draftViewState(goodHome.replace("useState('grid')", "useState('list')"))
  rec('自证·state 初值改坏判红', !r1.ok && /grid/.test(r1.detail), r1.ok ? '恒绿' : r1.detail)
  // 负控制组 2：按钮去掉 onClick ⇒ 红在按钮条
  const r2 = viewButtonsWired(goodHome.replace(/onClick=\{\(\) => setDraftView\('list'\)\}/, ''))
  rec('自证·按钮没接 onClick 判红', !r2.ok && /onClick/.test(r2.detail), r2.ok ? '恒绿' : r2.detail)
  // 负控制组 3：装饰版（button 全换成 svg、data-on 写死）⇒ 红在按钮条
  const deco = goodHome.replace(/<button className="home-view-btn"[\s\S]*?<\/button>/g, '<IconGridView size={16} data-on="true" />')
  const r3 = viewButtonsWired(deco)
  rec('自证·纯装饰图标判红', !r3.ok && /button/.test(r3.detail), r3.ok ? '恒绿' : r3.detail)
  // 负控制组 4：容器不拼 is-list ⇒ 红在容器条
  const r4 = containerToggles(goodHome.replace("${draftView === 'list' ? ' is-list' : ''}", ''))
  rec('自证·容器不切 class 判红', !r4.ok && /is-list/.test(r4.detail), r4.ok ? '恒绿' : r4.detail)
  // 负控制组 5：CSS is-list 不改单列 ⇒ 红在布局条
  const r5 = listLayoutReal(goodCss.replace('.home-draft-cards.is-list { grid-template-columns: 1fr; gap:6px; }', '.home-draft-cards.is-list { gap:6px; }'))
  rec('自证·is-list 摆设 class 判红', !r5.ok && /单列|1fr/.test(r5.detail), r5.ok ? '恒绿' : r5.detail)
  // 负控制组 6：卡片 onClick 没了 ⇒ 红在契约条
  const r6 = cardContractKept(goodHome.replace(' onClick={() => onOpenDraft?.(draft)}', ''))
  rec('自证·卡片点击没了判红', !r6.ok && /onClick/.test(r6.detail), r6.ok ? '恒绿' : r6.detail)

  const total = pass + fail
  console.log(`\nDRAFT_VIEW_SELFTEST_STATS total=${total} pass=${pass} fail=${fail}`)
  if (fail) {
    console.log('DRAFT_VIEW_SELFTEST_FAILED')
    return 1
  }
  console.log('DRAFT_VIEW_SELFTEST_OK')
  return 0
}

if (process.argv.includes('--selftest')) process.exit(selfTest())

/* ---------------------------------------------------------------- 主流程 */

let pass = 0
let fail = 0
const problems = []
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`)
  } else {
    fail += 1
    const d = detail || '（无原因）'
    problems.push(`${name} :: ${d}`)
    console.log(`[FAIL] ${name} :: ${d}`)
  }
}

const home = R('packages/desktop/src/renderer/components/Home.jsx')
const css = R('packages/desktop/src/renderer/home.css')
for (const [name, judge] of JUDGES) {
  const r = name.includes('布局') ? judge(css) : judge(home)
  check(name, r.ok, r.detail)
}

const total = pass + fail
console.log(`\nDRAFT_VIEW_STATS total=${total} pass=${pass} fail=${fail} skip=0`)
if (fail) {
  for (const p of problems) console.log(`  ✗ ${p}`)
  console.log('DRAFT_VIEW_FAILED')
  process.exit(1)
}
console.log('首页草稿视图切换接线完整、判据可分辨。')
console.log('DRAFT_VIEW_OK')
