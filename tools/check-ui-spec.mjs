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
const RENDERER = path.join(ROOT, 'packages/desktop/src/renderer')
const CSS = path.join(RENDERER, 'workbench.css')
const STYLES = path.join(RENDERER, 'styles.css')
/* 首页那份也必须扫：它是"字号散在档外"最集中的地方（9/15/18 一度都在这里），
   只扫工作台那一份就会留下一大片没人管的量表外字号。 */
const HOME = path.join(RENDERER, 'home.css')
const read = (file) => fs.readFileSync(file, 'utf8')
const css = read(CSS)
const styles = read(STYLES)
const home = read(HOME)

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
  '--fs-10', '--fs-11', '--fs-12', '--fs-13', '--fs-14', '--fs-16', '--fs-20',
  '--ctl-sm', '--ctl-md', '--ctl-lg',
  '--r-sm', '--r-lg',
  '--gap-1', '--gap-2', '--gap-3', '--gap-4',
  '--state-hover', '--state-active', '--state-ring'
]
const missing = TOKENS.filter((name) => !new RegExp(`${name}\\s*:`).test(css))
check('规格令牌全部定义在 :root（字号 7 档 / 控件高 3 档 / 圆角 2 档 / 间距 4 档 / 状态层 3 个）',
  missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : `${TOKENS.length} 个`)

/**
 * ⚠️ 已删除的令牌必须真的消失。
 *
 * 只查"新令牌在不在"是不够的：`--fs-15` / `--r-md` 留着不删，下次有人写
 * `var(--fs-15)` 一样能通过 —— 而 15px 恰好是参考量表里**不存在**的那一档
 * （它就是我们自己造出来、"看着不像一个软件"的元凶之一）。
 */
const STALE_TOKENS = ['--fs-15', '--r-md']
const stale = STALE_TOKENS.filter((name) => new RegExp(`${name}\\s*:`).test(css))
check('已废弃的令牌（15px 字号档 / 6px 圆角档）不许重新出现在 :root',
  stale.length === 0, stale.length ? `仍定义 ${stale.join(', ')}` : '两个都清掉了')

/**
 * 字号不许出现档外值。
 *
 * 这是这道闸门存在的**初衷**：口径不统一不是审美问题，是"看着不像一个软件"。
 * 上一轮普查里 9 / 15 / 18 三个档外值散在 17 处（首页卡片标题 18、弹窗标题 15、
 * 各类角标 9）—— 构建全绿、静态扫描全绿，只有人盯着看才发现整屏的字重节奏是乱的。
 *
 * 唯一白名单是首页主标语 28px：它是按**实测墨高**（单字宽 26 / 墨高 28 / 行距 32）
 * 定的展示性大字，不是控件文本；参考那边也不让它走 LVFont 量表。
 */
const SCALE = new Set(['10px', '11px', '12px', '13px', '14px', '16px', '20px'])
const SCALE_EXEMPT = new Set(['28px'])
/**
 * 扫之前必须**去掉注释**：注释里写着 `border-radius: inherit` 这种"讲道理用的示例"
 * （见 styles.css 里 innerShadow 那段），不去掉会被当成真声明收进错误列表 ——
 * 那是一条永远修不掉的假红，而假红会训练人无脑忽略整道闸门。
 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
const offScale = []
for (const [file, raw] of [
  ['workbench.css', css],
  ['styles.css', styles],
  ['home.css', home]
]) {
  const source = stripComments(raw)
  for (const m of source.matchAll(/font-size:\s*([^;}]+)/g)) {
    const value = m[1].trim()
    if (value.startsWith('var(')) continue
    if (value === 'inherit' || value === '0') continue
    if (SCALE.has(value) || SCALE_EXEMPT.has(value)) continue
    offScale.push(`${file}: ${value}`)
  }
}
check('三份 CSS 没有档外字号（10/11/12/13/14/16/20，唯一豁免首页主标语 28px）',
  offScale.length === 0, offScale.length ? offScale.join('、') : '全部在档上')

/**
 * 圆角同样只许两档（4 / 8），加三类**按定义**的例外：
 *   · 1px / 2px —— 分隔线与小标签，参考也是这么用的；
 *   · 50% —— 正圆（头像、色点），与圆角档位无关；
 *   · >= 99px —— 胶囊（= 高度的一半）。写成像素是为了不受高度变化影响。
 * 上一轮普查里 3/5/6/7/9/10/11/12/14/15/16/21/30 十三个值并存，
 * 同一个"卡片"在这屏圆 6、那屏圆 12 —— 这就是"看着不像一个软件"的第二个来源。
 */
const RADIUS_OK = new Set(['0', '1px', '2px', '4px', '8px', '50%', '50', 'inherit'])
const offRadius = []
for (const [file, raw] of [
  ['workbench.css', css],
  ['styles.css', styles],
  ['home.css', home]
]) {
  const source = stripComments(raw)
  for (const m of source.matchAll(/border-radius:\s*([^;}]+)/g)) {
    /* 四角简写（`8px 8px 0 0`）逐项校验；百分比与 calc 一律放行（形态由内容决定） */
    const parts = m[1].trim().split(/\s+/)
    for (const part of parts) {
      if (part.startsWith('var(') || part.startsWith('calc(') || part.endsWith('%')) continue
      if (RADIUS_OK.has(part)) continue
      const px = Number.parseFloat(part)
      if (Number.isFinite(px) && px >= 99) continue // 胶囊
      offRadius.push(`${file}: ${m[1].trim()}`)
      break
    }
  }
}
check('三份 CSS 圆角只有 4/8 两档（1px 分隔线 / 2px 小标签 / 胶囊除外）',
  offRadius.length === 0, offRadius.length ? offRadius.slice(0, 8).join('、') : '全部在档上')

console.log('· 令牌要**被消费**（定义了没人用 = 量表还是散的）')
const consumed = (name) => (css.match(new RegExp(`var\\(${name}\\)`, 'g')) || []).length
const consumedTotal = TOKENS.reduce((sum, name) => sum + consumed(name), 0)
check('令牌至少被引用 8 处（否则只是写了一份说明书）', consumedTotal >= 8, `${consumedTotal} 处`)
check('功能标签消费量表（圆角/字号都不再写死）',
  lastDecl(css, '.wb-tab', 'border-radius') === 'var(--r-lg)' &&
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
