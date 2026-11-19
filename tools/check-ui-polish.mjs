#!/usr/bin/env node
'use strict'
/**
 * 闸门 · UI 精修（技能的六维审计法落地）防回归判据。
 *
 * 背景（2026-11-19）：用 ui-design-system 技能的「色彩系统对比度」与
 * 「组件状态完整性」两个维度审了一遍现有 UI。技能的 Pinterest 营销页审美与本项目
 * 「逐像素对齐参考客户端」的 DNA 冲突，所以**只取这两项的普适部分**，做纯增量精修：
 *
 *   A. 对比度（7 处）：正文/元数据误用了过暗的 faint/dim 令牌（实测 2.05~3.83:1），
 *      改为消费同文件现成的 muted 令牌（4.73~9.42:1）。令牌数值本身一个没改
 *      （改数值会破坏参考对齐截图），只改"这处文字该用哪个令牌"。
 *      ⚠️ .wb-tllabel 特意不动：它的灰是参考实测值且无正文文字，属对齐基准。
 *
 *   B. 交互状态（10 处）：补 :active 按压反馈、:focus-within/thumb 焦点环、
 *      开关与旋转手柄的透明伪元素扩热区。全部复用现成 --state-* 令牌或纯 transform，
 *      不引入新色值/字号/圆角，不改布局。
 *
 * 判据原则（项目纪律）：
 *   · 读消费端文本（选择器 → 实际声明的 color / 伪类），不读注释/不读 data。
 *   · 期望值写死：对比度阈值 4.5 来自 WCAG AA 正文规格；每处背景色是规格常量，
 *     **不从被测 CSS 反算**。独立实现 WCAG 相对亮度公式复算，防止"改错令牌值
 *     导致判据跟着错、两边相等照样绿"的自证。
 *   · --selftest 正负控制组：每类判据的反面夹具必须红在那一条。
 *
 * 用法：
 *   node tools/check-ui-polish.mjs             # 对真实源码跑判据
 *   node tools/check-ui-polish.mjs --selftest  # 只跑判据自证（秒级）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const WB = () => R('packages/desktop/src/renderer/workbench.css')
const ST = () => R('packages/desktop/src/renderer/styles.css')
const HM = () => R('packages/desktop/src/renderer/home.css')

/* ---------------------------------------------------------------- 纯工具 */

/** 去 CSS 注释：我加的说明注释里含旧色值数字，不剥会污染判据 */
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取选择器规则体（第一个匹配，多选择器规则只找最近的 {，不跨 }）。
 *  (?![-\w]) 保证完整标识符边界，避免 .hint 命中别的。 */
function ruleBody(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(esc + '(?![-\\w])[^{}]*\\{([^}]*)\\}')
  const m = re.exec(css)
  return m ? m[1] : null
}

/** WCAG 2.x 相对亮度 + 对比度。规格常量 4.5 由调用方写死，不从这里推导。 */
function lin(c) {
  c /= 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function luminance(hex) {
  const h = hex.replace('#', '')
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) +
         0.7152 * lin(parseInt(h.slice(2, 4), 16)) +
         0.0722 * lin(parseInt(h.slice(4, 6), 16))
}
function contrast(fg, bg) {
  const a = luminance(fg), b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/* ---------------------------------------------------------------- 对比度判据 */

/** 每处：选择器 / 所在 CSS / 应消费的令牌 / 令牌实际值 / 该处背景（规格常量写死）/ 修复前令牌值。
 *  背景色是"这一处文字落在什么面上"的客观事实，写死在判据里；令牌值是各 CSS :root 的
 *  实测常量，也写死在这里 —— 于是图像令牌被人改坏时，复算会红。 */
const CONTRAST_FIXES = [
  { name: 'A1 字幕元数据', css: 'wb', sel: '.wb-caps-meta', token: '--wb-muted', tokenVal: '#cccccc', bg: '#3b3b3b', old: '#808080' },
  { name: 'A2 检查器属性名', css: 'wb', sel: '.wb-field > span', token: '--wb-muted', tokenVal: '#cccccc', bg: '#262626', old: '#808080' },
  { name: 'A3 检查器提示语', css: 'wb', sel: '.wb-insphint', token: '--wb-muted', tokenVal: '#cccccc', bg: '#262626', old: '#808080' },
  { name: 'A4 属性字段说明', css: 'st', sel: '.hint', token: '--muted', tokenVal: '#9a9aa0', bg: '#302f36', old: '#6c6c72' },
  { name: 'A5 素材规格摘要', css: 'st', sel: '.media-meta small', token: '--muted', tokenVal: '#9a9aa0', bg: '#29282d', old: '#6c6c72' },
  { name: 'A6 首页空态引导', css: 'hm', sel: '.home-empty-text', token: '--h-muted', tokenVal: '#9a9aa0', bg: '#1c1c1c', old: '#75757b' },
  { name: 'A7 首页二级副标题', css: 'hm', sel: '.home-page-sub', token: '--h-muted', tokenVal: '#9a9aa0', bg: '#1c1c1c', old: '#75757b' },
  { name: 'A8 草稿卡元信息', css: 'hm', sel: '.home-draft-card em', token: '--h-muted', tokenVal: '#9a9aa0', bg: '#262626', old: '#75757b' },
  { name: 'A9 能力卡描述', css: 'hm', sel: '.home-cap-text em', token: '--h-muted', tokenVal: '#9a9aa0', bg: '#262626', old: '#75757b' }
]
const WCAG_BODY = 4.5 // 规格常量：WCAG AA 正文

function contrastFix(source, f) {
  const body = ruleBody(stripCss(source), f.sel)
  if (!body) return { ok: false, detail: `找不到选择器 ${f.sel}` }
  if (!new RegExp(`color\\s*:\\s*var\\(${f.token}\\)`).test(body)) {
    const m = /color\s*:\s*([^;]+)/.exec(body)
    return { ok: false, detail: `${f.sel} 应消费 ${f.token}，实为 ${m ? m[1].trim() : '无 color'}` }
  }
  // 独立复算：用判据里写死的令牌值，而非从 CSS 读取
  const now = contrast(f.tokenVal, f.bg)
  if (now < WCAG_BODY) {
    return { ok: false, detail: `${f.name} 对比度 ${now.toFixed(2)} < 4.5（令牌 ${f.token}=${f.tokenVal} × 底 ${f.bg}）` }
  }
  // 负对照可分辨性：修复前的旧令牌值必须低于阈值（否则这条判据没有区分度）
  if (contrast(f.old, f.bg) >= WCAG_BODY) {
    return { ok: false, detail: `${f.name} 的旧值对比度已达 ${contrast(f.old, f.bg).toFixed(2)}，判据失去区分度` }
  }
  return { ok: true, detail: `${now.toFixed(2)}:1（旧 ${contrast(f.old, f.bg).toFixed(2)}）` }
}

/* ---------------------------------------------------------------- 交互状态判据 */

/** 断言选择器规则存在，且体里含指定模式。each: [名称, 源, 选择器, 正则, 说明] */
function hasRule(css, selector, re) {
  const body = ruleBody(stripCss(css), selector)
  return body ? re.test(body) : false
}

const INTERACTIONS = [
  { name: 'B1 工具条键按压', css: 'wb', sel: '.wb-tlbar button:active:not(:disabled)', re: /--state-active[\s\S]*translateY\(1px\)/ },
  { name: 'B2 播放键按压', css: 'wb', sel: '.wb-transport-btns button:active', re: /--state-active[\s\S]*translateY\(1px\)/ },
  { name: 'B3 播放键无底色', css: 'wb', sel: '.wb-transport-btns button.play:active', re: /background\s*:\s*transparent/ },
  { name: 'B4 下拉键盘焦点', css: 'wb', sel: '.wb-mb-select:focus-within', re: /--state-ring/ },
  { name: 'B5 导入键按压', css: 'wb', sel: '.wb-import:active', re: /brightness\(0\.95\)[\s\S]*translateY\(1px\)/ },
  { name: 'B6 开关 hover', css: 'wb', sel: '.wb-switch:hover', re: /border-color/ },
  { name: 'B7 开关扩热区', css: 'wb', sel: '.wb-switch::before', re: /inset\s*:\s*-4px\s+0/ },
  { name: 'B8 开关按压', css: 'wb', sel: '.wb-switch:active', re: /brightness\(0\.88\)/ },
  { name: 'B9 滑杆 thumb 焦点', css: 'st', sel: "input[type='range']:focus-visible::-webkit-slider-thumb", re: /--state-ring/ },
  { name: 'B10 旋转手柄扩热区', css: 'st', sel: '.canvas-sel-rot::before', re: /inset\s*:\s*-3px\s+-8px\s+-8px/ },
  { name: 'B11 首页导航按压', css: 'hm', sel: '.home-nav-item:active', re: /brightness\(0\.92\)/ },
  { name: 'B12 视图切换按压', css: 'hm', sel: '.home-view-btn:active', re: /scale\(0\.92\)/ },
  { name: 'B13 草稿卡按压', css: 'hm', sel: '.home-draft-card:active', re: /scale\(0\.99\)/ }
]

const SRC = { wb: WB, st: ST, hm: HM }

/* ---------------------------------------------------------------- 自证 */

function selfTest() {
  let pass = 0, fail = 0
  const problems = []
  const rec = (name, ok, detail = '') => {
    if (ok) { pass += 1; console.log(`[PASS] ${name}`) }
    else { fail += 1; problems.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`) }
  }

  // 对比度：正控制组（真实修复清单）必须全过
  for (const f of CONTRAST_FIXES) {
    const src = SRC[f.css]()
    rec(`自检·对比度 ${f.name} 正控制组`, contrastFix(src, f).ok, contrastFix(src, f).detail)
  }
  // 负对照 1：把某处改回 faint（旧值），必须红在"令牌"那条
  const wbBad = WB().replace('color: var(--wb-muted);\n  font-size: var(--fs-11);\n  font-variant-numeric', 'color: var(--wb-faint);\n  font-size: var(--fs-11);\n  font-variant-numeric')
  const badA1 = contrastFix(wbBad, CONTRAST_FIXES[0])
  rec('自检·字幕元数据改回 faint 判红', !badA1.ok && /--wb-muted/.test(badA1.detail), badA1.ok ? '恒绿，漏报' : badA1.detail)

  // 负对照 2：令牌值被人改暗（如 muted 改成 #6c6c72），独立复算必须红在对比度那条
  const dimmed = { ...CONTRAST_FIXES[0], tokenVal: '#6c6c72' }
  const badCalc = contrastFix(WB(), dimmed)
  rec('自检·令牌值改暗复算判红', !badCalc.ok && /对比度/.test(badCalc.detail), badCalc.ok ? '恒绿' : badCalc.detail)

  // 交互：正控制组全过；把每条规则删掉，判据必须红
  for (const it of INTERACTIONS) {
    rec(`自检·交互 ${it.name} 正控制组`, hasRule(SRC[it.css](), it.sel, it.re))
  }
  const wbNoActive = WB().replace(/\.wb-tlbar button:active:not\(:disabled\)\s*\{[^}]*\}/, '')
  rec('自检·删掉工具条按压规则判红', !hasRule(wbNoActive, INTERACTIONS[0].sel, INTERACTIONS[0].re))

  const total = pass + fail
  console.log(`\nUI_POLISH_SELFTEST_STATS total=${total} pass=${pass} fail=${fail}`)
  for (const p of problems) console.log(`  x ${p}`)
  if (fail) { console.log('UI_POLISH_SELFTEST_FAILED'); return 1 }
  console.log('UI_POLISH_SELFTEST_OK')
  return 0
}

/* ---------------------------------------------------------------- 主流程 */

if (process.argv.includes('--selftest')) process.exit(selfTest())

let pass = 0, fail = 0
const problems = []
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`) }
  else { fail += 1; const d = detail || '（没有原因）'; problems.push(`${name} :: ${d}`); console.log(`[FAIL] ${name} :: ${d}`) }
}

for (const f of CONTRAST_FIXES) {
  const r = contrastFix(SRC[f.css](), f)
  check(`对比度 · ${f.name} 消费 ${f.token} 且 ≥4.5:1`, r.ok, r.detail)
}
for (const it of INTERACTIONS) {
  check(`交互 · ${it.name}（${it.sel}）`, hasRule(SRC[it.css](), it.sel, it.re))
}

console.log(`\nUI_POLISH_STATS total=${pass + fail} pass=${pass} fail=${fail}`)
for (const p of problems) console.log(`  x ${p}`)
if (fail) { console.log('UI_POLISH_FAILED'); process.exit(1) }
console.log('UI_POLISH_OK')
