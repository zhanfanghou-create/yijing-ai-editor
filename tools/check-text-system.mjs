/**
 * 文字系统闸门：动画（入场/出场/循环）· 排版（行距/对齐/背景框）· 自定义字体。
 *
 * 这三块有一个共同点：**参数在一边生效、在另一边静默失效**。
 *   · 动画：预览是 CSS @keyframes、导出是 drawtext 的时间表达式，两套实现；
 *   · 排版：预览是 CSS（line-height / text-align / padding），导出是 drawtext
 *     的（line_spacing / text_align / box）；
 *   · 字体：预览要 FontFace 注册 + CSS 家族名，导出要磁盘路径。
 *
 * 所以这里分三层判据：
 *   1. 纯函数自检（readTextAnim / animExpr / applyTextOverrides）——秒级、不开窗口；
 *   2. **把 ffmpeg 表达式用 JS 复算**（与 check-edit-geometry 同一手法）：
 *      断言"入场第 0 帧位移最大、结束时归零"这类只有逐帧看片子才发现的问题；
 *   3. 静态链路：设置/检查器/载荷/主进程四段是否都真的接线（少一段就是假开关）。
 *
 * 用法：node tools/check-text-system.mjs [--selftest]
 * 自证模式：用一组"错误状态"谓词验证上面的判据真的能分辨对错。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SRC = path.join(root, 'packages/desktop/src')

const anim = require(path.join(SRC, 'shared/textAnim.js'))
const overrides = require(path.join(SRC, 'shared/textOverrides.js'))

let pass = 0
let fail = 0
const notes = []
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
  } else {
    fail += 1
    notes.push(`✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/* ---------------- ffmpeg 表达式 → JS 求值 ----------------
 * drawtext 的表达式与 JS 语法几乎一样，只差几个函数名与 0/1 布尔。
 * 这里做一次文本替换后用 new Function 求值 —— 与导出侧跑的是**同一串字符**。
 */
const toJs = (text) =>
  String(text)
    /* ffmpeg 里表达式内的逗号必须转义成 `\,`（否则被当成选项分隔符），
       JS 求值前先还原 —— 否则 new Function 直接 SyntaxError */
    .replace(/\\,/g, ',')
    .replace(/\bmin\(/g, 'MIN(')
    .replace(/\bmax\(/g, 'MAX(')
    .replace(/\bsin\(/g, 'SIN(')
const jsEval = (expr, t) =>
  Number(
    new Function(
      't',
      `const MIN=(a,b)=>Math.min(a,b); const MAX=(a,b)=>Math.max(a,b);
       const PI=Math.PI; const SIN=(x)=>Math.sin(x);
       return ${toJs(expr)};`
    )(t)
  )

const BOX = { start: 2, duration: 4, width: 1920, height: 1080 }

/* ============================ 1. 动画参数 ============================ */
check('没设动画时三个槽位都是 none', (() => {
  const a = anim.readTextAnim({})
  return a.in === 'none' && a.out === 'none' && a.loop === 'none'
})(), JSON.stringify(anim.readTextAnim({})))

check('时长非法（0 / 负数 / NaN）被夹到下限 0.1，不会除零', (() => {
  const a = anim.readTextAnim({ textInDur: 0, textOutDur: -3 })
  return a.inDur === anim.DUR_MIN && a.outDur === anim.DUR_MIN
})(), JSON.stringify(anim.readTextAnim({ textInDur: 0, textOutDur: -3 })))

check('时长超过上限被夹到 2 秒（入场比片段还长会中段黑）', anim.readTextAnim({ textInDur: 99 }).inDur === anim.DUR_MAX)

check('样式表的 anim 成为入场默认：slideup → up', anim.readTextAnim({}, 'slideup').in === 'up')
check('片段显式设了 none 就不跟样式表走', anim.readTextAnim({ textIn: 'none' }, 'slideup').in === 'none')
check('未知的入场 key 退回 none（不抛错、不留空类名）', anim.readTextAnim({ textIn: '不存在' }).in === 'none')

/* ============================ 2. 表达式语义 ============================ */
const inUp = anim.animExpr(anim.readTextAnim({ textIn: 'up', textInDur: 0.5 }), BOX)
check('入场「上浮」：起点位移为 +6% 画幅高（从下方来）', Math.abs(jsEval(inUp.dy, BOX.start) - 1080 * 0.06) < 0.5,
  `dy(0)=${jsEval(inUp.dy, BOX.start)}`)
check('入场「上浮」：入场结束位移归零', Math.abs(jsEval(inUp.dy, BOX.start + 0.5)) < 0.5,
  `dy(0.5)=${jsEval(inUp.dy, BOX.start + 0.5)}`)
check('入场「上浮」：结束之后一直是 0（不会继续往下漂）', Math.abs(jsEval(inUp.dy, BOX.start + 3)) < 0.01)
check('入场「上浮」：透明度 0 → 1', jsEval(inUp.alpha, BOX.start) < 0.02 && Math.abs(jsEval(inUp.alpha, BOX.start + 0.5) - 1) < 0.02)

const outDown = anim.animExpr(anim.readTextAnim({ textOut: 'down', textOutDur: 0.5 }), BOX)
check('出场「下沉」：出场前位移为 0（不能提前跳走）', Math.abs(jsEval(outDown.dy, BOX.start + 1)) < 0.01,
  `dy(1)=${jsEval(outDown.dy, BOX.start + 1)}`)
check('出场「下沉」：片尾位移为 +6% 画幅高（真的往下走）',
  Math.abs(jsEval(outDown.dy, BOX.start + BOX.duration) - 1080 * 0.06) < 1)
check('出场「下沉」：片尾透明度归零', jsEval(outDown.alpha, BOX.start + BOX.duration) < 0.02)

const outUp = anim.animExpr(anim.readTextAnim({ textOut: 'up', textOutDur: 0.5 }), BOX)
check('出场「上飘」的方向与「下沉」相反（符号表不能两边共用）', jsEval(outUp.dy, BOX.start + BOX.duration) < -1,
  `dy(end)=${jsEval(outUp.dy, BOX.start + BOX.duration)}`)

const zoomIn = anim.animExpr(anim.readTextAnim({ textIn: 'zoom', textInDur: 0.5 }), BOX)
check('入场「放大」：字号从 0.86 倍长到 1 倍', Math.abs(jsEval(zoomIn.fontScale, BOX.start) - 0.86) < 0.01,
  `fs(0)=${jsEval(zoomIn.fontScale, BOX.start)}`)
check('入场「放大」：结束时正好 1 倍（不是 1.0001 之类）', Math.abs(jsEval(zoomIn.fontScale, BOX.start + 0.5) - 1) < 0.005)

const breathe = anim.animExpr(anim.readTextAnim({ textLoop: 'breathe' }), BOX)
const samples = [0, 0.65, 1.3, 1.95, 2.6].map((dt) => jsEval(breathe.alpha, BOX.start + dt))
check('循环「呼吸」：透明度始终在 [0.82, 1] 内', samples.every((v) => v >= 0.81 && v <= 1.001), samples.join(','))
check('循环「呼吸」：确实在动（最高与最低相差 > 0.1）', Math.max(...samples) - Math.min(...samples) > 0.1,
  samples.join(','))

const floatLoop = anim.animExpr(anim.readTextAnim({ textLoop: 'float' }), BOX)
check('循环「浮动」：位移幅度不超过画幅高的 2%（幅度一大就晃得看不下去）', (() => {
  const vals = []
  for (let t = BOX.start; t < BOX.start + 3.2; t += 0.2) vals.push(Math.abs(jsEval(floatLoop.dy, t)))
  return Math.max(...vals) <= 1080 * 0.016
})())

check('没开任何动画时不产生任何表达式（不往滤镜串里塞空括号）', (() => {
  const e = anim.animExpr(anim.readTextAnim({}), BOX)
  return e.alpha === '' && e.dx === '' && e.dy === '' && e.fontScale === ''
})())

check('同时开入场淡入 + 出场淡出：alpha 是两个因子的乘积（不是取其一）', (() => {
  const e = anim.animExpr(anim.readTextAnim({ textIn: 'fade', textOut: 'fade', textInDur: 0.5, textOutDur: 0.5 }), BOX)
  // 片头 0.25 秒：入场 0.5、出场 1
  return Math.abs(jsEval(e.alpha, BOX.start + 0.25) - 0.5) < 0.02
})())

/* ============================ 3. 排版覆写 ============================ */
const def = overrides.STYLES.styles[0]

check('排版默认值不改变样式表（行距 1.22 / 居中 / 无背景覆写）', (() => {
  const out = overrides.applyTextOverrides(def, {})
  return Math.abs(out.lineHeight - 1.22) < 0.001 && out.align === def.align && out.fontFamily === undefined
})(), JSON.stringify({
  lineHeight: overrides.applyTextOverrides(def, {}).lineHeight,
  align: overrides.applyTextOverrides(def, {}).align
}))

check('行距越界被夹到 [1, 2.4]', (() => {
  const hi = overrides.applyTextOverrides(def, { textLineHeight: 9 })
  const lo = overrides.applyTextOverrides(def, { textLineHeight: -2 })
  return hi.lineHeight === overrides.LINE_MAX && lo.lineHeight === overrides.LINE_MIN
})())

check('对齐只认 left/center/right，脏值不写入', (() => {
  const ok = overrides.applyTextOverrides(def, { textAlign: 'right' }).align === 'right'
  const bad = overrides.applyTextOverrides(def, { textAlign: 'center;color:red' }).align === def.align
  return ok && bad
})())

check('背景框关掉时把底色与内边距一起清空（只清 bg 会留下透明 padding）', (() => {
  const out = overrides.applyTextOverrides({ ...def, bg: 'rgba(0,0,0,0.5)', padX: 20, padY: 8 }, { textBgOn: false })
  return !out.bg && !out.padX && !out.padY
})())

check('背景框打开但样式本来没底色：给一个看得见的默认黑底（否则"点开没反应"）', (() => {
  const out = overrides.applyTextOverrides({ ...def, bg: '' }, { textBgOn: true })
  return /rgba\(0, 0, 0, 0\.55\)/.test(out.bg)
})())

check('背景框颜色 + 不透明度同时给：落成 rgba', (() => {
  const out = overrides.applyTextOverrides(def, { textBgOn: true, textBgColor: '#FF0000', textBgOpacity: 40 })
  return out.bg === 'rgba(255, 0, 0, 0.4)'
})(), overrides.applyTextOverrides(def, { textBgOn: true, textBgColor: '#FF0000', textBgOpacity: 40 }).bg)

check('背景框打开但没调内边距：默认 18（不是 0 —— boxborderw=0 会让底色贴着笔画）', (() => {
  const out = overrides.applyTextOverrides({ ...def, bg: '' }, { textBgOn: true })
  return out.padX === 18
})(), String(overrides.applyTextOverrides({ ...def, bg: '' }, { textBgOn: true }).padX))

check('字体家族名只接受 ASCII 标识符（带引号/分号的一律忽略）', (() => {
  const ok = overrides.applyTextOverrides(def, { textFont: 'YJF_abc123' }).fontFamily === 'YJF_abc123'
  const bad = overrides.applyTextOverrides(def, { textFont: 'x"; color: red' }).fontFamily === undefined
  return ok && bad
})())

check('「恢复默认」把字体家族名与路径一起清掉', (() => {
  const r = overrides.resetTextOverrides()
  return r.textFont === '' && r.textFontPath === ''
})())

check('有任一排版覆写时 hasTextOverrides 为真（面板据此显示角标）', (() => {
  return (
    overrides.hasTextOverrides({ textAlign: 'left' }) &&
    overrides.hasTextOverrides({ textLineHeight: 1.6 }) &&
    overrides.hasTextOverrides({ textBgOn: false }) &&
    !overrides.hasTextOverrides({})
  )
})())

/* ============================ 4. 导出侧 drawtext ============================ */
const subs = require(path.join(SRC, 'main/subtitles.js'))
const os = require('node:os')
const draw = (clip) => subs.drawtextFor(clip, { width: 1920, height: 1080, tmpDir: os.tmpdir(), seq: 7 })

const plain = draw({ id: 'g1', text: '测试', textStyle: 'sub-plain', start: 0, duration: 3 })
check('基础字幕串里有 fontfile / textfile / fontsize / x / y', (() => {
  return /fontfile='/.test(plain) && /textfile='/.test(plain) && /fontsize=/.test(plain) && /x='/.test(plain) && /y='/.test(plain)
})(), String(plain).slice(0, 120))

check('样式自带淡入时导出也有 alpha 表达式（否则预览淡入、成片硬切）', /alpha='/.test(plain), String(plain).slice(-90))

const leftClip = draw({ id: 'g2', text: '测试', textStyle: 'sub-plain', start: 0, duration: 3, textAlign: 'left' })
check('左对齐 → x 落成 6% 边距（与预览的 padding 6% 同一个数）', /x='w\*0\.06'/.test(leftClip), leftClip.slice(0, 160))

const rightClip = draw({ id: 'g3', text: '测试', textStyle: 'sub-plain', start: 0, duration: 3, textAlign: 'right' })
check('右对齐 → x 用 w-text_w-6%', /x='\(?w-text_w-w\*0\.06\)?'/.test(rightClip), rightClip.slice(0, 160))

const lines = draw({ id: 'g4', text: '测试', textStyle: 'sub-plain', start: 0, duration: 3, textLineHeight: 1.9 })
check('行距 1.9 → 出现 line_spacing（默认 1.22 时不出）', /line_spacing=\d+/.test(lines) && !/line_spacing/.test(plain),
  `lines=${/line_spacing/.test(lines)} plain=${/line_spacing/.test(plain)}`)

const bgClip = draw({ id: 'g5', text: '测试', textStyle: 'sub-plain', start: 0, duration: 3, textBgOn: true, textBgColor: '#000000', textBgOpacity: 70 })
check('背景框打开 → box=1 + boxcolor + boxborderw>0', /box=1/.test(bgClip) && /boxborderw=\d+/.test(bgClip) && /boxcolor='0x000000/.test(bgClip), bgClip.slice(-160))

const animClip = draw({ id: 'g6', text: '测试', textStyle: 'sub-plain', start: 1, duration: 3, textIn: 'up', textInDur: 0.5, textOutDur: 0.5 })
check('入场「上浮」的 y 里出现 64.8 像素级偏移（1080×6%）', /64\.8/.test(animClip), animClip.slice(-200))
check('表达式里的逗号全部转义（少一个整条滤镜就解析失败）', !/(?<!\\),/.test(animClip.replace(/^[^:]*?:/, '')), animClip.slice(-160))

/* ⚠️ 这一条是 2026-10-19 真机抓出来的：`shared/textAnim.js` 与 `main/subtitles.js`
   都把逗号转义了一次 ⇒ `\\,`（两层反斜杠）。ffmpeg 只吃一层，第二层原样喂给
   表达式求值器，报 `Missing ')' or too many args`，**整条导出失败**。
   而"有没有逗号没转义"那条断言完全测不出来（它只查漏转，不查多转）。 */
check('转义只有一层（不许出现双反斜杠 + 逗号）', !animClip.includes(String.raw`\\,`), animClip.slice(-160))
check('退到普通样式的串也只有一层转义', !plain.includes(String.raw`\\,`), plain.slice(-120))

const fontClip = draw({ id: 'g7', text: '测试', textStyle: 'sub-plain', start: 0, duration: 3, textFontPath: 'C:/Windows/Fonts/simhei.ttf' })
check('片段带字体路径 → fontfile 用它', /fontfile='C\\:\/Windows\/Fonts\/simhei\.ttf'/.test(fontClip), fontClip.slice(0, 90))

const ghostFont = draw({ id: 'g8', text: '测试', textStyle: 'sub-plain', start: 0, duration: 3, textFontPath: 'C:/不存在/no.ttf' })
check('字体路径失效 → 退回系统字体（不是整条字幕消失）', /fontfile='C\\:\/Windows\/Fonts\//.test(ghostFont), String(ghostFont).slice(0, 90))

/* ============================ 5. 静态链路 ============================ */
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const preload = read('preload/index.js')
const mainIndex = read('main/index.js')
const appSrc = read('renderer/App.jsx')
const inspector = read('renderer/components/Inspector.jsx')
const sidePanels = read('renderer/components/SidePanels.jsx')
const stage = read('renderer/components/Stage.jsx')
const fontsSrc = read('renderer/fonts.js')

check('preload 暴露 font.pick 与 font.allow', /font:\s*\{[\s\S]{0,200}pick:/.test(preload) && /allow:/.test(preload))
check('主进程实现了 font:pick（复制入库 + 进白名单）', /ipcMain\.handle\('font:pick'/.test(mainIndex) && /allowedMedia\.add\(target\)/.test(mainIndex))
check('主进程实现了 font:allow（重启后重新登记白名单）', /ipcMain\.handle\('font:allow'/.test(mainIndex))
check('App 启动时既登记白名单也注册 FontFace', /allowFontPaths/.test(appSrc) && /registerFonts/.test(appSrc))
check('检查器有字体下拉与导入按钮', /data-text-font="1"/.test(inspector) && /data-text-font-import="1"/.test(inspector))
check('检查器有排版与动画的钩子', /data-text-align=/.test(inspector) && /data-text-in=/.test(inspector) && /data-text-loop=/.test(inspector))
check('导出载荷带上排版与动画字段', /textLineHeight:/.test(sidePanels) && /textIn:/.test(sidePanels) && /textFontPath:/.test(sidePanels))
check('预览侧真的用了 ta-in / ta-out / ta-loop 三层', /ta-in-\$\{ta\.in\}/.test(stage) && /ta-out-\$\{ta\.out\}/.test(stage) && /ta-loop-\$\{ta\.loop\}/.test(stage))
check('字体注册用 fetch + FontFace（失败会返回 false，不静默）', /new FontFace/.test(fontsSrc) && /return false/.test(fontsSrc))

/* ============================ 输出 ============================ */
const TOTAL = 52

if (process.argv.includes('--selftest')) {
  /* 自证：这些"错误状态"必须全部被判为假 —— 判据若分不出对错，等于没测 */
  const wrong = [
    ['出场方向与入场共用符号表', () => jsEval(outDown.dy, BOX.start + BOX.duration) < 0],
    ['入场结束时位移没归零', () => Math.abs(jsEval(inUp.dy, BOX.start + 0.5)) > 1],
    ['呼吸循环不动', () => Math.max(...samples) - Math.min(...samples) < 0.02],
    ['行距越界没夹住', () => overrides.applyTextOverrides(def, { textLineHeight: 9 }).lineHeight === 9],
    ['关闭背景框仍留着内边距', () => {
      const out = overrides.applyTextOverrides({ ...def, bg: '#000', padX: 20 }, { textBgOn: false })
      return out.padX === 20
    }],
    ['左对齐却用居中 x', () => /x='\(w-text_w\)\/2'/.test(leftClip)],
    ['无效字体路径没有退回系统字体', () => ghostFont === null]
  ]
  let caught = 0
  for (const [name, fn] of wrong) {
    let hit = false
    try {
      hit = fn() === true
    } catch {
      hit = false
    }
    if (!hit) caught += 1
    else notes.push(`✗ 自证失败：${name}（判据分不出这个错误）`)
  }
  console.log(`自证：${caught}/${wrong.length} 个错误状态被判为假`)
  if (caught !== wrong.length) fail += 1
}

console.log(`TEXT_SYSTEM 通过 ${pass} 项 / 失败 ${fail} 项（期望 ${TOTAL}）`)
for (const line of notes) console.log(line)
if (fail || pass !== TOTAL) {
  console.log('TEXT_SYSTEM_FAIL')
  process.exit(1)
}
console.log('TEXT_SYSTEM_OK')
process.exit(0)
