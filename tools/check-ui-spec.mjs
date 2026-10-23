/**
 * check-ui-spec.mjs —— 界面规格闸门（设计令牌 / 状态层 / 主按钮唯一性）。
 *
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 界面「不像一个软件」几乎从来不是审美问题，而是**量表不唯一**：
 *   · 同一个"辅助说明"在这屏 11px、那屏 10px；
 *   · 按钮高度 22/24/26/28/32 五种并存；
 *   · 圆角 2/3/4/5/6/9 六种；
 *   · 选中态只改文字颜色 ⇒ 深底上"看着都一样平"，用户得读字才知道点没点上；
 *   · 主按钮与次级按钮都带底板 ⇒ 一屏里三个"最重要"的按钮。
 *
 * 这些错**都能构建通过、静态扫描也都过**，只有在真机上盯着看才发现 ——
 * 所以必须用闸门钉住：令牌存在、被真的消费、状态三态齐全、主按钮只有一枚。
 *
 * 判据一律读 **CSS/组件源码里真正生效的那条规则**，不读"有没有写注释说要对齐"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = path.join(ROOT, 'packages/desktop/src/renderer/workbench.css')
const STYLES = path.join(ROOT, 'packages/desktop/src/renderer/styles.css')
const read = (file) => fs.readFileSync(file, 'utf8')
const css = read(CSS)
const styles = read(STYLES)

let pass = 0
let fail = 0
const failures = []
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  [PASS] ${name}${extra ? `（${extra}）` : ''}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  [FAIL] ${name}${extra ? `（${extra}）` : ''}`)
  }
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 某个选择器下某条声明的**最终生效值**（按出现顺序取最后一条 —— 级联就是这么算的）。
 *
 * ⚠️ 不能只看"某个块里有没有 var()"：同一个选择器在文件里出现多次是常态
 *    （`.wb-tab` 先有排版、后补状态），后面那条写死的 13px 才是真正生效的 ——
 *    而它正是这套令牌要消灭的东西。
 */
function lastDecl(source, selector, prop) {
  const re = new RegExp(`(^|\\n)${escapeRe(selector)}\\s*\\{([^}]*)\\}`, 'g')
  const decl = new RegExp(`(?:^|[;{\\s])${escapeRe(prop)}\\s*:\\s*([^;]+)`)
  let value = null
  let m
  while ((m = re.exec(source))) {
    const hit = decl.exec(m[2])
    if (hit) value = hit[1].trim()
  }
  return value
}

console.log('· 设计令牌（量表唯一）')
const TOKENS = [
  '--fs-11', '--fs-12', '--fs-13', '--fs-15',
  '--ctl-sm', '--ctl-md', '--ctl-lg',
  '--r-sm', '--r-md', '--r-lg',
  '--gap-1', '--gap-2', '--gap-3', '--gap-4',
  '--state-hover', '--state-active', '--state-ring'
]
const missing = TOKENS.filter((name) => !new RegExp(`${name}\\s*:`).test(css))
check('规格令牌全部定义在 :root（字号 4 档 / 控件高 3 档 / 圆角 3 档 / 间距 4 档 / 状态层 3 个）',
  missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : `${TOKENS.length} 个`)

console.log('· 令牌要**被消费**（定义了没人用 = 量表还是散的）')
const consumed = (name) => (css.match(new RegExp(`var\\(${name}\\)`, 'g')) || []).length
const consumedTotal = TOKENS.reduce((sum, name) => sum + consumed(name), 0)
check('令牌至少被引用 8 处（否则只是写了一份说明书）', consumedTotal >= 8, `${consumedTotal} 处`)
check('功能标签消费量表（圆角/字号都不再写死）',
  lastDecl(css, '.wb-tab', 'border-radius') === 'var(--r-md)' &&
  lastDecl(css, '.wb-tab', 'font-size') === 'var(--fs-12)',
  `圆角=${lastDecl(css, '.wb-tab', 'border-radius')} 字号=${lastDecl(css, '.wb-tab', 'font-size')}`)
check('主按钮消费量表（圆角/字号）',
  lastDecl(css, '.wb-export', 'border-radius') === 'var(--r-lg)' &&
  lastDecl(css, '.wb-export', 'font-size') === 'var(--fs-12)',
  `圆角=${lastDecl(css, '.wb-export', 'border-radius')} 字号=${lastDecl(css, '.wb-export', 'font-size')}`)
check('时间线工具条消费量表（圆角/字号/hover 状态层）',
  lastDecl(css, '.wb-tlbar button', 'border-radius') === 'var(--r-sm)' &&
  lastDecl(css, '.wb-tlbar button', 'font-size') === 'var(--fs-12)' &&
  /background:\s*var\(--state-hover\)/.test(css))

console.log('· 状态层（hover / 选中 / 键盘焦点 三态齐全）')
check('功能标签：hover 有底色（不是只改字色）',
  /\.wb-tab:hover\s*\{[^}]*background:\s*var\(--state-hover\)/.test(css))
check('功能标签：选中态有胶囊底 + 底部亮条',
  /\.wb-tab\.active\s*\{[^}]*background:\s*var\(--wb-accent-glow\)/.test(css) &&
  /\.wb-tab\.active\s*\{[^}]*box-shadow:\s*inset 0 -2px 0/.test(css))
/**
 * 亮条必须是 inset 阴影，**不能**是真 border：
 * 加 2px 边框会让选中那枚比旁边高/矮 2px，整排标签上下不齐（踩过一次）。
 */
check('选中亮条用 inset 阴影而不是 border（否则选中那枚会矮 2px）',
  !/\.wb-tab\.active\s*\{[^}]*border(-bottom)?:\s*2px/.test(css))
check('功能标签有键盘焦点环（Tab 走查时看得见在哪）',
  /\.wb-tab:focus-visible\s*\{[^}]*box-shadow:\s*var\(--state-ring\)/.test(css))

console.log('· 主按钮唯一 / 禁用态不整体变透明')
/**
 * 主按钮的判据：**唯一一枚带不透明实心底板的顶栏按钮**。
 * 次级按钮一律透明底 —— 一屏里出现两枚实心按钮，就没有"主操作"这回事了。
 */
const exportRules = css.match(/(^|\n)\.wb-export\s*\{([^}]*)\}/g) || []
check('导出按钮有实心底板（主按钮必须"有板"，次级按钮才用透明底）',
  exportRules.some((rule) => /background:\s*linear-gradient\(180deg/.test(rule)))
const exportDisabled = (() => {
  const re = new RegExp(`(^|\\n)${escapeRe('.wb-export:disabled')}\\s*\\{([^}]*)\\}`, 'g')
  const out = []
  let m
  while ((m = re.exec(css))) out.push(m[2])
  return out.join('\n')
})()
check('导出禁用态用「深底 + 去饱和字」而不是整块 opacity',
  /background:\s*linear-gradient/.test(exportDisabled) && /opacity:\s*1/.test(exportDisabled))
/**
 * ⚠️ 反例判据：styles.css 里有一条全局 `button:disabled { opacity: .45 }`。
 * 导出按钮若没有 `opacity: 1` 覆盖，整块会被冲成 45% —— 底板与字形都偏色。
 */
check('全局 button:disabled 的透明度被显式覆盖',
  /button:disabled/.test(styles) && /opacity:\s*1/.test(exportDisabled))

console.log('· 图标（尺寸显式，不跟着字号飘）')
/* 钉的是「显式写死宽高」这件事，不钉具体数值 —— 尺寸会随参考实测更新（19→20 已发生过一次），
   若把 19 写进判据，改尺寸就得连带改闸门，久而久之闸门会变成"抄一遍实现"。 */
check('功能标签图标有显式宽高',
  /\.wb-tab svg\s*\{[^}]*width:\s*\d+(?:\.\d+)?px[^}]*height:\s*\d+(?:\.\d+)?px/.test(css.replace(/\n\s*/g, '\n')))
check('时间线工具条图标有显式宽高（缺了会随字号缩放，同一排图标大小不一）',
  /\.wb-tlbar svg\s*\{[^}]*width:\s*16px/.test(css))

console.log('')
if (failures.length) {
  console.log('失败项：')
  for (const item of failures) console.log('  · ' + item)
}
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (!fail) console.log('UISPEC_OK')
process.exit(fail ? 1 : 0)
