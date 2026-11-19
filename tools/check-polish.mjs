#!/usr/bin/env node
'use strict'
/**
 * 闸门 ·「查缺补漏」10 项交互/视觉修复的防回归判据。
 *
 * 背景（2026-11-19）：对全部剪辑功能做了一轮扫描，逐条回到源码核实后修了 10 个
 * 确定性缺陷。这些缺陷的共同点是「构建绿、其它闸门绿、界面看着也有那个控件」，
 * 但真实行为是错的 —— 光靠人眼 review 抓不住，必须用判据钉死：
 *
 *   视觉：
 *     1. 调色角标 .canvas-badge 曾定义两次（top + bottom 同时生效 ⇒ 拉成竖条盖画面）
 *     2. 转场层 object-fit:contain 与主画面 cover 不一致 ⇒ 转场跳黑边
 *     3. 鱼眼三档 scale 写死 0.25 ⇒ 点不同档预览一样（导出却真变）
 *     4. 扫描线预览浅线提亮、成片黑线压暗 ⇒ 明暗方向相反
 *     5. 多个角标全 absolute 到同一角 ⇒ 只看得见最后一个
 *     6. 选中态预览紫框、时间线白框 ⇒ 同一语义两种反馈色
 *   交互：
 *     7. 双击片段直接删除（手抖误删，与主流"双击=打开"相反）
 *     8. 正向播到片尾不停（按钮一直显示"暂停"，画面不动，像卡死）
 *     9. 标记跳转按钮到头静默无反应（快捷键却会 toast）
 *    10. 帮助"去试试"只切标签不切左栏节点（落地页与选中态错位）
 *
 * 判据分两层：
 *   · 静态契约（本文件默认模式）：读源码/CSS **文本**，对每处修复的"接线形态"
 *     做断言。期望值写死在这里，不从被测文件推导。
 *   · 纯逻辑（--selftest）：fisheyeScale 的数值判据 + 每处文本判据的正/负控制组。
 *     负对照夹具只改一个变量，必须红在**那一条**上 —— 证明判据不是恒绿/自证。
 *
 * ⚠️ E2E（真机读 computed style / DOM）由 check-polish-e2e.mjs 负责，本文件不启 Electron。
 *
 * 用法：
 *   node tools/check-polish.mjs             # 对真实源码跑判据
 *   node tools/check-polish.mjs --selftest  # 只跑判据自证（秒级）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const CSS = () => R('packages/desktop/src/renderer/styles.css')
const STAGE = () => R('packages/desktop/src/renderer/components/Stage.jsx')
const TIMELINE = () => R('packages/desktop/src/renderer/components/Timeline.jsx')
const APP = () => R('packages/desktop/src/renderer/App.jsx')
const LOOKS = () => R('packages/desktop/src/main/looks.js')

/* ---------------------------------------------------------------- 纯判据函数 */

/** 去掉 CSS 注释，避免注释里的示例值污染判据 */
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
/** 去掉 JS 行注释与块注释（保守：只剥整行 // 与 /* *\/ 块） */
const stripJs = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 取某个选择器的规则体（第一个匹配）。
 *  选择器后面允许跟「, 其它选择器」再接 `{`（多选择器规则），所以只要求
 *  从这里往后找最近的 `{` —— 但不能跨过 `}`，否则会吃到下一条规则。 */
function ruleBody(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  /* (?![-\w]) 保证选择器是完整标识符：.clip-badge 不会误命中 .clip-badges */
  const re = new RegExp(esc + '(?![-\\w])[^{}]*\\{([^}]*)\\}')
  const m = re.exec(css)
  return m ? m[1] : null
}

/** 1. 调色角标不拉伸：只定义一次，且贴底不设 top */
function badgeNotStretched(css) {
  const body = stripCss(css)
  const defs = (body.match(/\.canvas-badge\s*\{/g) || []).length
  if (defs !== 1) return { ok: false, detail: `.canvas-badge 定义了 ${defs} 次（应恰好 1 次；两处 top+bottom 会把角标拉成竖条）` }
  const rule = ruleBody(body, '.canvas-badge')
  if (!rule) return { ok: false, detail: '找不到 .canvas-badge 规则体' }
  if (!/bottom\s*:\s*10px/.test(rule)) return { ok: false, detail: '角标没有贴底 bottom:10px' }
  if (/\btop\s*:/.test(rule)) return { ok: false, detail: '角标同时设了 top 与 bottom ⇒ 绝对定位元素被拉满高度' }
  return { ok: true, detail: '唯一定义、贴底、无 top（不会被拉成竖条）' }
}

/** 2. 转场层与主层同为 cover */
function xfadeCover(css) {
  const body = stripCss(css)
  const xf = ruleBody(body, '.canvas-xfade img,\n.canvas-xfade video') || ruleBody(body, '.canvas-xfade video')
  const frame = ruleBody(body, '.canvas-frame img,\n.canvas-frame video') || ruleBody(body, '.canvas-frame video')
  if (!xf || !frame) return { ok: false, detail: `转场层或主层规则缺失（xf=${!!xf} frame=${!!frame}）` }
  const fitOf = (r) => (/object-fit\s*:\s*(\w+)/.exec(r) || [])[1]
  const a = fitOf(xf)
  const b = fitOf(frame)
  if (a !== 'cover' || b !== 'cover') {
    return { ok: false, detail: `转场层 object-fit=${a}、主层=${b}，必须都为 cover（否则转场跳黑边）` }
  }
  return { ok: true, detail: '转场层与主画面层同为 cover' }
}

/** 3a. 鱼眼 scale 数值判据（对纯函数，不读文本） */
function fisheyeScaleContract(fn) {
  const a = fn('fx-fisheye') // t=-0.34
  const b = fn('fx-fisheye@1') // t=-0.45（默认基准档）
  const c = fn('fx-fisheye@2') // t=-0.56
  const want = [0.1889, 0.25, 0.3111]
  const got = [a, b, c]
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(got[i] - want[i]) > 0.0002) {
      return { ok: false, detail: `第 ${i} 档 scale=${got[i]}，期望 ${want[i]}` }
    }
  }
  if (!(a < b && b < c)) return { ok: false, detail: `三档没有随 |t| 递增：${got.join(' < ')}` }
  return { ok: true, detail: `三档 ${got.join(' / ')} 递增且基准档=0.25` }
}

/** 3b. Stage.jsx 用的是函数而非写死 scale */
function fisheyeWired(stage) {
  const js = stripJs(stage)
  if (!/scale=\{fisheyeScale\(frameFx\)\}/.test(js)) {
    return { ok: false, detail: 'feDisplacementMap 没有用 scale={fisheyeScale(frameFx)}（写死值会让三档一样）' }
  }
  if (/scale="0\.25"/.test(js)) return { ok: false, detail: '还残留写死的 scale="0.25"' }
  return { ok: true, detail: 'scale 由 fisheyeScale(frameFx) 逐档计算' }
}

/** 4. 扫描线为暗线（明度 < 50%，与成片 black@0.35 同向） */
function scanDark(css, looks) {
  const body = stripCss(css)
  const rule = ruleBody(body, '.canvas-fx.fx-scan')
  if (!rule) return { ok: false, detail: '找不到 fx-scan 的预览规则' }
  /* 只抓「明度% / alpha)」这一截 —— 真实规则里 hsl() 带嵌套的 var(--fx-h, 0)，
     用 [^)]*? 会在 var 的第一个 ) 处提前收尾。这里直接锚定 % / 数字 ) 的尾部形状。 */
  const hsl = /(\d+)%\s*\/\s*([\d.]+)\)/.exec(rule)
  if (!hsl) return { ok: false, detail: '扫描线背景不是带明度的 hsl()' }
  const lightness = Number(hsl[1])
  const alpha = Number(hsl[2])
  if (lightness >= 50) return { ok: false, detail: `扫描线明度 ${lightness}% ≥ 50%（浅线会提亮，与成片压暗相反）` }
  if (Math.abs(alpha - 0.35) > 0.001) return { ok: false, detail: `扫描线 alpha=${alpha}，期望 0.35（与成片 black@0.35 对齐）` }
  if (!/c=black@0\.35/.test(stripJs(looks))) return { ok: false, detail: '成片侧不再是 black@0.35（判据前提变了）' }
  return { ok: true, detail: `暗线明度 ${lightness}%、alpha ${alpha}，与成片同向` }
}

/** 5. 角标横向排布：flex 容器 + 角标本体不再 absolute */
function badgesInFlex(css, timeline) {
  const body = stripCss(css)
  const container = ruleBody(body, '.clip .clip-inner .clip-badges')
  if (!container) return { ok: false, detail: '没有 .clip-badges 容器规则' }
  if (!/display\s*:\s*flex/.test(container)) return { ok: false, detail: '.clip-badges 不是 flex 容器' }
  const badge = ruleBody(body, '.clip-badge')
  if (!badge) return { ok: false, detail: '找不到 .clip-badge 规则体' }
  if (/position\s*:\s*absolute/.test(badge)) return { ok: false, detail: '.clip-badge 仍是 absolute（会叠在同一角）' }
  const js = stripJs(timeline)
  const wraps = (js.match(/className="clip-badges"/g) || []).length
  if (wraps < 1) return { ok: false, detail: 'Timeline.jsx 没有渲染 .clip-badges 容器' }
  return { ok: true, detail: `flex 容器 + 角标非 absolute（${wraps} 处容器）` }
}

/** 6. 选中态同色：两处都用 --violet 令牌 */
function selectionColor(css) {
  const body = stripCss(css)
  const sel = ruleBody(body, '.canvas-sel')
  const clip = ruleBody(body, '.clip.selected')
  if (!sel || !clip) return { ok: false, detail: '.canvas-sel 或 .clip.selected 规则缺失' }
  if (!/var\(--violet\)/.test(sel)) return { ok: false, detail: '预览选框没有用 var(--violet)' }
  if (!/var\(--violet\)/.test(clip)) return { ok: false, detail: '时间线选中框没有用 var(--violet)（仍是异色）' }
  if (/#ffffff/.test(clip)) return { ok: false, detail: '时间线选中框还留着 #ffffff 白框' }
  return { ok: true, detail: '两处选中框都用 var(--violet)' }
}

/** 7. 双击片段 = 定位 + 选中，不是删除 */
function doubleClickOpens(timeline) {
  const js = stripJs(timeline)
  const m = /onDoubleClick=\{\(event\)\s*=>\s*\{([\s\S]*?)\}\s*\}/.exec(js)
  if (!m) return { ok: false, detail: '找不到片段的 onDoubleClick handler' }
  const body = m[1]
  if (/onRemove\s*\(/.test(body)) return { ok: false, detail: '双击仍调用 onRemove（直接删除）' }
  if (!/onSeek\s*\(/.test(body) || !/onSelect\s*\(/.test(body)) {
    return { ok: false, detail: '双击没有同时定位(onSeek)与选中(onSelect)' }
  }
  if (/双击删除/.test(stripJs(timeline))) return { ok: false, detail: 'title 文案仍写着「双击删除」' }
  return { ok: true, detail: '双击 = onSeek + onSelect，title 已改为「定位并打开属性」' }
}

/** 8. 播放到头双向都停 */
function playStopsBothWays(stage) {
  const js = stripJs(stage)
  const m = /if \(!playing\) return\s*const atEnd\s*=\s*direction === -1 \? playhead <= 0 : playhead >= totalDuration\s*if \(atEnd\) onTogglePlay\(\)/.exec(js)
  if (!m) return { ok: false, detail: '没有双向到头停止的 effect（正向播到片尾不会停）' }
  return { ok: true, detail: '正向/倒放到各自端点都 onTogglePlay' }
}

/** 9. 标记跳转按钮到头有 toast */
function markerToast(app) {
  const js = stripJs(app)
  const m = /onStepMarker=\{\(dir\)\s*=>\s*\{([\s\S]*?)\}\s*\}/.exec(js)
  if (!m) return { ok: false, detail: '找不到 onStepMarker handler' }
  const body = m[1]
  if (!/toast\s*\(/.test(body)) return { ok: false, detail: '到头分支没有 toast（按钮静默无反应）' }
  if (!/播放头之前没有标记/.test(body) || !/播放头之后没有标记/.test(body)) {
    return { ok: false, detail: 'toast 文案与快捷键口径不一致' }
  }
  return { ok: true, detail: '到头给 toast，与快捷键同文案' }
}

/** 10. 帮助跳转同步左栏节点 */
function guideJumpSetNode(app) {
  const js = stripJs(app)
  const m = /onJump=\{\(key\)\s*=>\s*\{([\s\S]*?)\}\s*\}\s*\n\s*\/>/ .exec(js) ||
    /onJump=\{\(key\)\s*=>\s*\{([\s\S]*?)\}\s*\}\s*\}/.exec(js)
  if (!m) return { ok: false, detail: '找不到 GuideDialog 的 onJump handler' }
  if (!/setWbTab\s*\(/.test(m[1])) return { ok: false, detail: '没有切标签' }
  if (!/setWbNode\s*\(defaultNodeOf\(tab\)\)/.test(m[1])) {
    return { ok: false, detail: '切标签时没有同步 setWbNode(defaultNodeOf(tab))' }
  }
  return { ok: true, detail: 'onJump 同时切标签与左栏节点' }
}

/* ---------------------------------------------------------------- 自检夹具 */

function selfTest() {
  let pass = 0
  let fail = 0
  const problems = []
  const rec = (name, ok, detail) => {
    if (ok) {
      pass += 1
      console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`)
    } else {
      fail += 1
      const d = detail || '（没有原因）'
      problems.push(`${name} :: ${d}`)
      console.log(`[FAIL] ${name} :: ${d}`)
    }
  }

  // 正控制组：按当前真实判据形状造的夹具，必须全过
  const goodCss = stripCss(`
    .canvas-badge { position:absolute; left:10px; bottom:10px; z-index:5; }
    .canvas-xfade img, .canvas-xfade video { width:100%; height:100%; object-fit:cover; }
    .canvas-frame img, .canvas-frame video { width:100%; height:100%; object-fit:cover; }
    .canvas-fx.fx-scan { background: repeating-linear-gradient(0deg, hsl(190 45% 12% / 0.35) 0 1px, transparent 1px 4px); }
    .clip .clip-inner .clip-badges { display:flex; gap:3px; }
    .clip-badge { flex:none; height:13px; }
    .canvas-sel { border:1.5px solid var(--violet); }
    .clip.selected { box-shadow: inset 0 0 0 2px var(--violet); }
  `)
  rec('自检·角标不拉伸 正控制组', badgeNotStretched(goodCss).ok)
  rec('自检·转场 cover 正控制组', xfadeCover(goodCss).ok)
  rec('自检·扫描线暗线 正控制组', scanDark(goodCss, 'drawgrid c=black@0.35').ok)
  rec('自检·角标 flex 正控制组（CSS 部分）', badgesInFlex(goodCss, '<span className="clip-badges">').ok)
  rec('自检·选中同色 正控制组', selectionColor(goodCss).ok)

  // 反控制组 1：角标加回 top ⇒ 必须红在 top 那条
  const doubled = stripCss(goodCss + '\n.canvas-badge { top:10px; }')
  const br = badgeNotStretched(doubled)
  rec('自检·角标两处定义判红', !br.ok && /2 次/.test(br.detail), br.ok ? '恒绿，漏报' : br.detail)

  // 反控制组 2：转场改 contain ⇒ 必须红
  const contain = goodCss.replace('.canvas-xfade img, .canvas-xfade video { width:100%; height:100%; object-fit:cover; }',
    '.canvas-xfade img, .canvas-xfade video { width:100%; height:100%; object-fit:contain; }')
  const xr = xfadeCover(contain)
  rec('自检·转场 contain 判红', !xr.ok && /object-fit/.test(xr.detail), xr.ok ? '恒绿' : xr.detail)

  // 反控制组 3：scan 提亮到 92% ⇒ 必须红在明度那条
  const bright = goodCss.replace('hsl(190 45% 12% / 0.35)', 'hsl(190 24% 92% / 0.2)')
  const sr = scanDark(bright, 'drawgrid c=black@0.35')
  rec('自检·扫描线浅线判红', !sr.ok && /明度/.test(sr.detail), sr.ok ? '恒绿' : sr.detail)

  // 反控制组 4：选中框改回白 ⇒ 必须红
  const whiteSel = goodCss.replace('.clip.selected { box-shadow: inset 0 0 0 2px var(--violet); }',
    '.clip.selected { box-shadow: inset 0 0 0 2px #ffffff; }')
  const cr = selectionColor(whiteSel)
  rec('自检·白框判红', !cr.ok && /#ffffff|var\(--violet\)/.test(cr.detail), cr.ok ? '恒绿' : cr.detail)

  // 鱼眼：正控制组 + 逐档扰动
  const goodFn = (k) => ({ 'fx-fisheye': 0.1889, 'fx-fisheye@1': 0.25, 'fx-fisheye@2': 0.3111 }[k])
  rec('自检·鱼眼 scale 正控制组', fisheyeScaleContract(goodFn).ok)
  const badFn = (k) => (k === 'fx-fisheye@2' ? 0.25 : goodFn(k))
  const fr = fisheyeScaleContract(badFn)
  rec('自检·鱼眼某档写死判红', !fr.ok && /第 2 档|递增/.test(fr.detail), fr.ok ? '恒绿' : fr.detail)

  // 交互：各一条反控制组
  const goodTl = `
    onDoubleClick={(event) => { event.stopPropagation(); if (onSeek) onSeek(clip.start); if (onSelect) onSelect(clip); }}
    <span className="clip-badges"></span>
  `
  rec('自检·双击定位 正控制组', doubleClickOpens(goodTl).ok)
  const badTl = goodTl.replace('if (onSeek) onSeek(clip.start); if (onSelect) onSelect(clip);', 'onRemove(clip.id);')
  const dr = doubleClickOpens(badTl)
  rec('自检·双击删除判红', !dr.ok && /onRemove/.test(dr.detail), dr.ok ? '恒绿' : dr.detail)

  const goodStage = `if (!playing) return\n const atEnd = direction === -1 ? playhead <= 0 : playhead >= totalDuration\n if (atEnd) onTogglePlay()`
  rec('自检·双向停 正控制组', playStopsBothWays(goodStage).ok)
  const badStage = `if (!playing || direction !== -1) return\n if (playhead <= 0) onTogglePlay()`
  rec('自检·只倒放停判红', !playStopsBothWays(badStage).ok)

  const goodApp = `
    onStepMarker={(dir) => { const next = stepMarker(markers, playhead, dir); if (next === null) return toast(dir < 0 ? '播放头之前没有标记' : '播放头之后没有标记'); setPlayhead(next); }}
    <GuideDialog onJump={(key) => { setWbTab(tab); setWbNode(defaultNodeOf(tab)); }}
    />
  `
  rec('自检·标记 toast 正控制组', markerToast(goodApp).ok)
  const badApp = goodApp.replace("return toast(dir < 0 ? '播放头之前没有标记' : '播放头之后没有标记')", 'return')
  rec('自检·标记静默判红', !markerToast(badApp).ok)
  rec('自检·帮助跳转 正控制组', guideJumpSetNode(goodApp).ok)
  const badJump = goodApp.replace('setWbNode(defaultNodeOf(tab));', '')
  rec('自检·帮助不切节点判红', !guideJumpSetNode(badJump).ok)

  const total = pass + fail
  console.log(`\nPOLISH_SELFTEST_STATS total=${total} pass=${pass} fail=${fail}`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  if (fail) {
    console.log('POLISH_SELFTEST_FAILED')
    return 1
  }
  console.log('POLISH_SELFTEST_OK')
  return 0
}

/* ---------------------------------------------------------------- 主流程 */

if (process.argv.includes('--selftest')) process.exit(selfTest())

let pass = 0
let fail = 0
const problems = []
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`)
  } else {
    fail += 1
    const d = detail || '（没有原因）'
    problems.push(`${name} :: ${d}`)
    console.log(`[FAIL] ${name} :: ${d}`)
  }
}

const css = CSS()
const stage = STAGE()
const timeline = TIMELINE()
const app = APP()
const looks = LOOKS()
const { fisheyeScale } = require('../packages/desktop/src/shared/fxParams.js')

const RESULTS = [
  ['视觉1 · 调色角标不拉伸（唯一定义/贴底/无 top）', badgeNotStretched(css)],
  ['视觉2 · 转场层与主层同为 cover', xfadeCover(css)],
  ['视觉3a · 鱼眼 scale 三档递增且基准=0.25', fisheyeScaleContract(fisheyeScale)],
  ['视觉3b · Stage.jsx 用 fisheyeScale 而非写死', fisheyeWired(stage)],
  ['视觉4 · 扫描线为暗线、与成片同向', scanDark(css, looks)],
  ['视觉5 · 角标 flex 横排（容器+本体非 absolute）', badgesInFlex(css, timeline)],
  ['视觉6 · 选中态两处同色（--violet）', selectionColor(css)],
  ['交互1 · 双击片段=定位+打开属性（非删除）', doubleClickOpens(timeline)],
  ['交互2 · 正反向播到头都停', playStopsBothWays(stage)],
  ['交互3 · 标记跳转按钮到头有 toast', markerToast(app)],
  ['交互4 · 帮助跳转同步左栏节点', guideJumpSetNode(app)]
]
for (const [name, r] of RESULTS) check(name, r.ok, r.detail)

const total = pass + fail
console.log(`\nPOLISH_STATS total=${total} pass=${pass} fail=${fail} skip=0`)
if (fail) {
  for (const p of problems) console.log(`  ✗ ${p}`)
  console.log('POLISH_FAILED')
  process.exit(1)
}
console.log('10 项交互/视觉修复的接线都在，判据可分辨。')
console.log('POLISH_OK')
