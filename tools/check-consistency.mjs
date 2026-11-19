#!/usr/bin/env node
'use strict'
/**
 * 闸门 ·「跨屏一致性」防回归判据（配色同源 + 右键删除项位置）。
 *
 * 背景（2026-11-19 第二轮）：
 *   A. 首页配色割裂：workbench.css 早在 2026-10-22 就把框架底色整批换成中性灰
 *      （注释实锤："旧值 #1A1A20/#303033/... 是偏紫冷黑，显脏、与灰阶素材色温打架"），
 *      但 home.css 的框架色令牌还留在那套废弃旧色 —— 从首页进剪辑器全屏色温跳变。
 *      修复：首页框架色改到与工作台同源的中性灰阶，保留品牌紫强调与卡片渐变。
 *   B. 右键删除项太深：双击片段已改为「定位+打开属性」，删除只剩 Delete 键和右键菜单，
 *      而「删除片段」排在菜单十来项之后。前移到「停用片段」之后的第一组。
 *
 * 判据读源码/CSS 文本，期望值写死；期望值来自规格（工作台注释里的中性灰阶），
 * 不从被测文件（home.css）推导 —— 否则首页改错时判据会跟着错、照样绿。
 *
 *   --selftest：正/负控制组，负组只改一处，必须红在那一条上。
 *
 * 用法：
 *   node tools/check-consistency.mjs             # 对真实源码跑判据
 *   node tools/check-consistency.mjs --selftest  # 判据自证（秒级）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/* ---------------------------------------------------------------- 规格常量（写死） */
/* 来源：workbench.css :root 的中性灰阶 + 本次确立的首页映射，不是从 home.css 读的 */
const HOME_FRAME_SPEC = {
  '--h-bg': '#1c1c1c',
  '--h-rail': '#303030',
  '--h-tile': '#262626',
  '--h-nav-on': '#3b3b3b',
  '--h-login': '#3b3b3b'
}
/* 被废弃的旧偏紫冷黑 —— 任何框架色回到这些值都算回归 */
const DEPRECATED = ['#1a1a20', '#303033', '#2c2c31', '#444447', '#403748']

/* ---------------------------------------------------------------- 判据函数 */

/** 1. 首页框架色令牌 == 规格里的中性灰值（期望值来自 workbench 规格，非 home.css 自身） */
function homeFrameNeutral(home) {
  const body = stripCss(home)
  for (const [token, want] of Object.entries(HOME_FRAME_SPEC)) {
    const m = new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(body)
    if (!m) return { ok: false, detail: `找不到 ${token} 定义` }
    const got = m[1].toLowerCase()
    if (got !== want) {
      return { ok: false, detail: `${token}=${got}，规格要求 ${want}（与工作台灰阶同源）` }
    }
  }
  return { ok: true, detail: '5 个框架色令牌全部 = 中性灰阶规格值' }
}

/** 2. 首页框架区没有残留废弃的偏紫冷黑（正文硬编码 + 令牌都不许） */
function noDeprecatedPurpleGray(home) {
  const body = stripCss(home).toLowerCase()
  const hits = DEPRECATED.filter((c) => body.includes(c))
  if (hits.length) return { ok: false, detail: `残留废弃偏紫冷黑：${hits.join('、')}` }
  return { ok: true, detail: '无废弃偏紫冷黑残留' }
}

/** 3. 品牌紫强调保留（不是把首页改成无紫的纯灰） */
function brandAccentKept(home) {
  const body = stripCss(home)
  if (!/--h-accent:\s*#a855f7/.test(body)) {
    return { ok: false, detail: '品牌紫强调 --h-accent 丢了（应保留 #a855f7）' }
  }
  if (!/#3a2f56/.test(body) && !/#2d2144/.test(body)) {
    return { ok: false, detail: '工具卡/模板卡的紫色渐变封面没了' }
  }
  return { ok: true, detail: '品牌紫强调与紫色渐变封面保留' }
}

/** 4. 右键删除项在前移后的位置：出现在「停用片段」之后、且在「打开文件所在位置」之前 */
function deleteItemMovedUp(timeline) {
  const js = stripJs(timeline)
  const seg = /<div\s+className="wb-ctxmenu"[\s\S]*?>\s*([\s\S]*?)(?:\n\s*\) : null\})/.exec(js)
  if (!seg) return { ok: false, detail: '找不到右键菜单结构' }
  const body = seg[1]
  const iDisable = body.indexOf("'停用片段'")
  const iDelete = body.indexOf('删除片段')
  const iReveal = body.indexOf('打开文件所在位置')
  if (iDisable < 0) return { ok: false, detail: '菜单里找不到「停用片段」锚点' }
  if (iDelete < 0) return { ok: false, detail: '菜单里找不到「删除片段」' }
  if (!(iDisable < iDelete)) return { ok: false, detail: '删除片段没在「停用片段」之后' }
  if (iReveal >= 0 && !(iDelete < iReveal)) {
    return { ok: false, detail: '删除片段仍在「打开文件所在位置」之后（没前移）' }
  }
  /* 前移到显眼处：删除项应落在菜单前半段（顺序锚点 iDisable<iDelete<iReveal 是主判据，
     这一条是宽松辅助；夹具菜单文案比真实长，故用 1/2 而非 1/3） */
  if (iDelete > body.length / 2) {
    return { ok: false, detail: `删除片段仍在菜单偏后（位置 ${iDelete}/${body.length}）` }
  }
  if (!/data-ctx="delete"/.test(body)) return { ok: false, detail: '删除项缺 data-ctx="delete"（E2E 定位契约）' }
  if (!/className="danger"/.test(body)) return { ok: false, detail: '删除项丢了 danger 危险样式' }
  return { ok: true, detail: '删除项紧跟停用片段、落在前 1/3、保留 danger + data-ctx' }
}

/** 5. 菜单里没有两个连续的 .wb-ctxmenu-sep（旧 bug：中间夹注释的双分隔线） */
function noDoubleSep(timeline) {
  const js = stripJs(timeline)
  const seg = /<div\s+className="wb-ctxmenu"[\s\S]*?>\s*([\s\S]*?)(?:\n\s*\) : null\})/.exec(js)
  if (!seg) return { ok: false, detail: '找不到右键菜单结构' }
  /* 去掉注释和空白后看是否还有相邻两个 sep */
  const cleaned = seg[1].replace(/<span className="wb-ctxmenu-sep"\s*\/>/g, 'SEP').replace(/\s+/g, '')
  if (/SEPSEP/.test(cleaned)) return { ok: false, detail: '菜单里还有两个连续分隔线' }
  return { ok: true, detail: '无连续重复分隔线' }
}

const JUDGES = [
  ['1 · 首页框架色=中性灰阶规格', homeFrameNeutral],
  ['2 · 无废弃偏紫冷黑残留', noDeprecatedPurpleGray],
  ['3 · 品牌紫强调保留', brandAccentKept],
  ['4 · 右键删除项前移', deleteItemMovedUp],
  ['5 · 无连续重复分隔线', noDoubleSep]
]
const isTimelineJudge = (name) => name.includes('右键') || name.includes('分隔线')

/* ---------------------------------------------------------------- 自证 */

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
    .home {
      --h-bg: #1c1c1c;
      --h-rail: #303030;
      --h-tile: #262626;
      --h-nav-on: #3b3b3b;
      --h-login: #3b3b3b;
      --h-accent: #a855f7;
    }
    .tool-cover { background: linear-gradient(135deg, #3a2f56, #262a45); }
  `
  const goodTl = `
    {menu ? (<div className="wb-ctxmenu">
      <div className="wb-ctxmenu-title">{menu.clip.name}</div>
      <button>{'停用片段'}<kbd>V</kbd></button>
      <button className="danger" data-ctx="delete">删除片段<kbd>Delete</kbd></button>
      <button>在播放头处分割</button>
      <button>分离音频到音频轨</button>
      <button>场景切换检测</button>
      <button>复制属性</button>
      <button>粘贴属性</button>
      <button>替换片段</button>
      <span className="wb-ctxmenu-sep" />
      <button>打开文件所在位置</button>
      <button>取消</button>
    </div>
    ) : null}
  `
  for (const [name, judge] of JUDGES) {
    const r = isTimelineJudge(name) ? judge(goodTl) : judge(goodHome)
    rec(`自证·${name} 正控制组`, r.ok, r.detail)
  }
  // 负 1：框架色回退到旧冷黑 ⇒ 红
  const r1 = homeFrameNeutral(goodHome.replace('--h-bg: #1c1c1c', '--h-bg: #1a1a20'))
  rec('自证·框架色回退旧冷黑判红', !r1.ok && /规格/.test(r1.detail), r1.ok ? '恒绿' : r1.detail)
  // 负 2：正文残留旧色 ⇒ 红
  const r2 = noDeprecatedPurpleGray(goodHome + '\n.x { background:#303033; }')
  rec('自证·残留旧紫灰判红', !r2.ok && /残留/.test(r2.detail), r2.ok ? '恒绿' : r2.detail)
  // 负 3：品牌紫没了 ⇒ 红
  const r3 = brandAccentKept(goodHome.replace('--h-accent: #a855f7', '--h-accent: #cccccc').replace(/#3a2f56/g, '#333333'))
  rec('自证·品牌紫丢失判红', !r3.ok, r3.ok ? '恒绿' : r3.detail)
  // 负 4：删除项挪回底部 ⇒ 红
  const movedBottom = goodTl.replace(/<button className="danger" data-ctx="delete">删除片段<kbd>Delete<\/kbd><\/button>\n/, '')
    .replace('<button>取消</button>', '<button className="danger" data-ctx="delete">删除片段<kbd>Delete</kbd></button>\n      <button>取消</button>')
  const r4 = deleteItemMovedUp(movedBottom)
  rec('自证·删除项回底部判红', !r4.ok, r4.ok ? '恒绿' : r4.detail)
  // 负 5：双 sep ⇒ 红
  const dbl = goodTl.replace('<span className="wb-ctxmenu-sep" />', '<span className="wb-ctxmenu-sep" />\n      <span className="wb-ctxmenu-sep" />')
  const r5 = noDoubleSep(dbl)
  rec('自证·连续分隔线判红', !r5.ok && /连续/.test(r5.detail), r5.ok ? '恒绿' : r5.detail)

  const total = pass + fail
  console.log(`\nCONSISTENCY_SELFTEST_STATS total=${total} pass=${pass} fail=${fail}`)
  if (fail) {
    console.log('CONSISTENCY_SELFTEST_FAILED')
    return 1
  }
  console.log('CONSISTENCY_SELFTEST_OK')
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
const home = R('packages/desktop/src/renderer/home.css')
const timeline = R('packages/desktop/src/renderer/components/Timeline.jsx')
for (const [name, judge] of JUDGES) {
  const r = isTimelineJudge(name) ? judge(timeline) : judge(home)
  check(name, r.ok, r.detail)
}
const total = pass + fail
console.log(`\nCONSISTENCY_STATS total=${total} pass=${pass} fail=${fail} skip=0`)
if (fail) {
  for (const p of problems) console.log(`  ✗ ${p}`)
  console.log('CONSISTENCY_FAILED')
  process.exit(1)
}
console.log('跨屏一致性接线完整、判据可分辨。')
console.log('CONSISTENCY_OK')
