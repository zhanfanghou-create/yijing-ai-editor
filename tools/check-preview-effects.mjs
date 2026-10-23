#!/usr/bin/env node
/**
 * 闸门 · 预览区的"真实效果"：添加型操作到底有没有在画面上发生。
 *
 * ---------------------------------------------------------------------------
 * 这道闸门要挡的是什么
 * ---------------------------------------------------------------------------
 * 本项目里有一类反复出现的缺陷：**操作成功了，但画面上什么都没变**。
 * 它不是"没接线"（那种静态就能测），而是接了线、也改了状态，可是那个状态
 * 从来没被画出来。历史上真实发生过：
 *
 *   · 字幕：加一条字幕后，预览只在"底下没有画面片段"时才把它当主体显示成一张
 *     占位卡；一旦底下有视频，那条字幕**在预览里完全不出现**。
 *     于是"给视频加字幕"这件事在界面上毫无反馈 —— 点了、时间线也多了片段、
 *     toast 也弹了，就是画面上没有字。（2026-09-24 修：改成叠加层）
 *   · 转场：设置了转场之后，**只有时间线上的角标**变了，预览里两个片段还是硬切。
 *     "预览看不到"与"成片里没有"在观感上无法区分。
 *   · 特效 / 滤镜：参数进了片段，但预览没跟着变。
 *
 * 这几类的共同点是**只有把变量真的渲染出来才能验**，读代码、看 toast、
 * 甚至看静态截图都可能漏（字幕只加一行 22px 的字，在整屏截图里几乎看不出来）。
 * 所以这里断言的是 `getComputedStyle` 上的**真实渲染结果**：
 * 到底有没有那个元素、字号换算对不对、不透明度是不是真的在半途、
 * 动画名是不是那条动画。
 *
 * ---------------------------------------------------------------------------
 * 为什么用 kind:'text' 的素材当画布内容
 * ---------------------------------------------------------------------------
 * 与 preview-follow-e2e 同一个理由：文本素材的预览是**纯 DOM**，不依赖编解码、
 * 不依赖文件、不依赖媒体加载时序。本闸门验的是"效果有没有画出来"，
 * 不是"视频解码对不对"，用真视频只会引入 flaky。
 * （转场层因此渲染的是两个占位块 —— 但"有没有第二层、透明度在不在半途、
 *   裁剪路径是不是随进度变"这三件事与素材类型无关，照样测得准。）
 *
 * ---------------------------------------------------------------------------
 * 真值来源（不 import 被测代码）
 * ---------------------------------------------------------------------------
 * 期望值全部写死在本脚本里，出处逐条标注：
 *   · 字幕样式参数   src/shared/textStyles.json（本项目自建；这份表与渲染共用，
 *                    卡片预览与画面叠加用的是同一个函数）
 *   · 画幅基准宽     1280 —— 表里所有长度都是"1280 宽画幅下的 px"，
 *                    渲染时换算成 cqw（容器宽度百分比），见 renderer/textStyles.js
 *   · 滤镜参数       src/shared/looks.json 的 vivid
 *   · 转场           src/shared/looks.json 的 fade
 *   · 画面特效       src/shared/frameEffects.json
 *
 * ---------------------------------------------------------------------------
 * 反空洞约定
 * ---------------------------------------------------------------------------
 * · 每一步都先断言"元素真的存在"再断言它的样式，否则样式断言会在 null 上
 *   走 catch 分支，报成"取值失败"而不是"根本没画出来"；
 * · 静态契约判据抽成纯函数并配 `--selftest`（正控制组 + 逐条扰动），
 *   要求"红在对的那条断言上"；
 * · 中途抛异常时记一条 fail 并立 aborted 旗标，**不**把没跑到的补成 SKIP；
 * · ⚠️ 跑的是 dist-renderer 的**构建产物**，改完渲染层要先构建。
 *
 * 用法：
 *   node tools/check-preview-effects.mjs              # 真起 Electron 验渲染
 *   node tools/check-preview-effects.mjs --selftest   # 只跑判据自证（秒级）
 */

import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.preview-fx-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/* --------------------------------------------------------- 真值（写死，不 import） */

/** 样式表基准画幅宽 —— textStyles.json 的 baseWidth */
const STYLE_BASE_WIDTH = 1280

/**
 * 夹具用到的字幕样式（参数抄自 shared/textStyles.json 的 sub-bar / sub-accent / sub-neon）。
 * 这里只抄"要用它断言的那几个数"，不是把整张表搬过来。
 */
const STYLE_TRUTH = {
  /* anim 是**样式表的 anim 名 → 统一入场类名**的映射结果（shared/textAnim.js 的 STYLE_ANIM_MAP）：
     slideup → ta-in-up、pop → ta-in-zoom、glow → ta-in-fade。
     以前样式动画是单独一套 `.style-anim-*`，会把循环动画整个盖住（fill: both 停在终态），
     所以并进了统一的入场动画。 */
  'sub-bar': { size: 36, bg: 'rgba(0, 0, 0, 0.55)', anim: 'ta-up-in' },
  'sub-accent': { size: 34, bg: 'rgb(131, 114, 254)', anim: 'ta-in-zoom' },
  'sub-neon': { size: 38, bg: 'rgba(0, 0, 0, 0)', anim: 'ta-in-fade' }
}

/** vivid 的 CSS filter（looks.json 的 brightness 1.02 / contrast 1.16 / saturate 1.34） */
const VIVID_FILTER = 'brightness(1.02) contrast(1.16) saturate(1.34)'

/**
 * 夹具时间线（秒）。
 *
 *   lane  名称      区间        挂的东西                                 用途
 *   视频  甲片段    [0, 5)      filter=vivid, frameFx=fx-shake, 转场 fade  滤镜 / transform 特效 / 转场前半
 *   视频  乙片段    [5, 10)     frameFx=fx-scan                            覆盖层特效用例
 *   字幕  示例字幕  [1, 5)      textStyle=sub-bar                          必须"叠在画面之上"
 *
 * 转场 fade 时长 1s ⇒ 交叠窗口 = [4, 5)。选 4.5s 那一刻，滤镜/字幕/转场三件事
 * **同时**成立 —— 这正是"三者必须能共存"的现场（以前的实现只能显示其中一个）。
 */
const ASSETS = [
  { id: 'fx_asset_a', kind: 'text', name: '甲片段', text: '甲' },
  { id: 'fx_asset_b', kind: 'text', name: '乙片段', text: '乙' }
]

const CLIPS = [
  {
    id: 'fx_clip_a',
    track: 'video',
    assetId: 'fx_asset_a',
    name: '甲片段',
    start: 0,
    duration: 5,
    offset: 30,
    sourceDuration: 60,
    filter: 'vivid',
    filterIntensity: 1,
    frameFx: 'fx-shake',
    transition: 'fade',
    transitionDuration: 1
  },
  {
    id: 'fx_clip_b',
    track: 'video',
    assetId: 'fx_asset_b',
    name: '乙片段',
    start: 5,
    duration: 5,
    offset: 50,
    sourceDuration: 60,
    frameFx: 'fx-scan'
  },
  {
    id: 'fx_clip_t',
    track: 'text',
    assetId: '',
    name: '示例字幕',
    kind: 'text',
    text: '示例字幕',
    textStyle: 'sub-bar',
    start: 1,
    duration: 4,
    offset: 0,
    sourceDuration: 0
  }
]

/* ------------------------------------------------------------------ 纯判据 */

/**
 * 从 CSS 里取出"体"：`@keyframes x { ... }` 与 `选择器 { ... }` 两类块。
 * 用括号配平扫描而不是正则 —— 正则处理嵌套花括号必然出错（`{...{...}...}`），
 * 而"判错块边界"这类错法是静默的（多切或少切一块，结论就反了）。
 *
 * @returns {{head: string, body: string}[]} head = `@keyframes x` 或选择器文本
 */
function blocksOf(cssText) {
  const out = []
  let i = 0
  while (i < cssText.length) {
    const open = cssText.indexOf('{', i)
    if (open < 0) break
    /* 注释里的花括号不参与配平 */
    const head = cssText.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, ' ').trim()
    let depth = 1
    let j = open + 1
    while (j < cssText.length && depth > 0) {
      if (cssText[j] === '{') depth += 1
      else if (cssText[j] === '}') depth -= 1
      j += 1
    }
    if (depth !== 0) break
    out.push({ head, body: cssText.slice(open + 1, j - 1) })
    i = j
  }
  return out
}

/** 取某个块里出现的所有 animation(-name) 值里的动画名 */
function animationNamesIn(body) {
  const names = []
  const re = /animation(?:-name)?\s*:\s*([^;}]+)/g
  let m = re.exec(body)
  while (m) {
    for (const token of m[1].split(',')) {
      /* `animation: fx-shake 420ms linear infinite` —— 取第一个不是时长/缓动/次数的标识符 */
      const word = token
        .trim()
        .split(/\s+/)
        .find((w) => /^[A-Za-z_][\w-]*$/.test(w) && !/^(none|linear|ease|ease-in|ease-out|ease-in-out|infinite|alternate|both|forwards|backwards|normal|reverse|steps|linear\(|cubic-bezier|running|paused)$/.test(w))
      if (word) names.push(word)
    }
    m = re.exec(body)
  }
  return names
}

/**
 * 静态契约：**不许有任何 @keyframes 去动 `.canvas-frame` / `.canvas-layer` 的 `filter`**。
 *
 * 为什么这条必须钉住（这是本文件的中心判据）：
 *   预览的调色写在**内联 style** 上（2026-09-27 起挂在画面层 `.canvas-layer` 上，
 *   不再挂画布 —— 转场交叠时两段各有各的调色），
 *   而 CSS 动画的优先级**高于内联样式**。所以只要有一个动画碰了它的 filter，
 *   调色就会被整个顶掉 —— 而且是静默的：不报错、构建全绿、E2E 全绿，
 *   用户看到的是"我加了滤镜又加了特效，结果滤镜没了"。
 *
 * 判法（不是"出现 filter 就算违规"）：
 *   1. 找出所有**在体内写了 `filter:`** 的 @keyframes 名（记为"危险动画"）；
 *   2. 找出所有**选择器里含 `.canvas-frame` 或 `.canvas-layer`** 的规则用到的动画名；
 *   3. 两者有交集 ⇒ 违规。
 *   第 1 步只筛"危险集"，第 2 步才判归属 —— 否则 `.style-anim-glow`
 *   （真的在动 filter）会被误判成违规，而它挂在文字上、与调色无关。
 *
 *   3. **反向判据**（2026-10-20 起）：动画**不许**挂在 `.canvas-frame` 上 ——
 *      挂画框时圆角/描边/外阴影会一起抖，而**成片里没有画框**，预览与成片对不上。
 *      同时要求 `.canvas-content` 上**必须有**动画：一个都没有说明画面特效
 *      （fx-shake / fx-pulse）整族丢了 —— 卡片点得开、状态也存了，就是画面不动。
 *
 * @returns {{ok: boolean, detail: string, dangerous: string[], onFrame: string[], onLayer: string[]}}
 */
export function frameFilterContract(cssText) {
  const blocks = blocksOf(cssText)
  const dangerous = []
  for (const block of blocks) {
    const m = /^@keyframes\s+([\w-]+)/.exec(block.head)
    if (!m) continue
    if (/(^|[\s;{])filter\s*:/.test(block.body)) dangerous.push(m[1])
  }

  const onFrame = []
  const onLayer = []
  const onContent = []
  for (const block of blocks) {
    if (block.head.startsWith('@')) continue
    const names = animationNamesIn(block.body)
    if (!names.length) continue
    if (/\.canvas-frame(\b|[\s.:,[>+~])/.test(block.head)) onFrame.push(...names)
    if (/\.canvas-layer(\b|[\s.:,[>+~])/.test(block.head)) onLayer.push(...names)
    if (/\.canvas-content(\b|[\s.:,[>+~])/.test(block.head)) onContent.push(...names)
  }

  const clash = [...onFrame, ...onLayer, ...onContent].filter((name) => dangerous.includes(name))
  if (clash.length) {
    return {
      ok: false,
      detail: `动画 ${clash.join('、')} 同时"动了 filter"且"挂在画布/内容层"上 —— 它会把预览调色整个顶掉（CSS 动画优先级高于内联样式），且不报错`,
      dangerous,
      onFrame,
      onLayer,
      onContent
    }
  }
  /* ⚠️ 反向判据（2026-10-20 起）：动画**不许**挂在 `.canvas-frame` 上。
     挂画框时会连圆角、描边、外阴影、画框边界一起抖 —— 用户看到"整个播放器在动"，
     而**成片里根本没有画框**（导出只有画面本身在抖）。于是预览与成片对不上，
     且两边单独看都合理。这一条是最容易在"改着改着就挂回去"的地方。 */
  if (onFrame.length) {
    return {
      ok: false,
      detail: `有动画挂在 .canvas-frame 上（${onFrame.join('、')}）—— 画框会跟着一起动：圆角/描边/外阴影在抖，而成片里没有画框，预览与成片对不上。应改挂 .canvas-content（只动画面内容）`,
      dangerous,
      onFrame,
      onLayer,
      onContent
    }
  }
  if (!onContent.length) {
    return {
      ok: false,
      detail: `没有任何动画挂在 .canvas-content 上 —— 画面特效（fx-shake / fx-pulse）丢了：卡片能点、状态也存了，但画面不动`,
      dangerous,
      onFrame,
      onLayer,
      onContent
    }
  }
  return {
    ok: true,
    detail: `内容层上有 ${onContent.length} 个动画（${onContent.join('、')}）、画框上 0 个（框不跟着抖），${onLayer.length} 个挂在画面层上，其中没有一个去动 filter；危险动画 ${dangerous.length} 个（挂在别处，与调色无冲突）`,
    dangerous,
    onFrame,
    onLayer,
    onContent
  }
}

/* ------------------------------------------------------------------ 自检 */

function selfTest() {
  let pass = 0
  let fail = 0
  const problems = []
  const rec = (name, ok, detail) => {
    if (ok) {
      pass++
      console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`)
    } else {
      fail++
      const d = detail || '（没有给出原因）'
      problems.push(`${name} :: ${d}`)
      console.log(`[FAIL] ${name} :: ${d}`)
    }
  }

  /* ---- 正控制组：与真实 styles.css 同形状的一份 CSS，必须判通过 ---- */
  const good = `
@keyframes style-glow { from { filter: brightness(1); } to { filter: brightness(1.4); } }
@keyframes fx-shake { 0%,100% { transform: translate3d(0,0,0); } 20% { transform: translate3d(-1%,0,0); } }
.canvas-content.fx-shake { animation: fx-shake 420ms linear infinite; }
.style-anim-glow { animation: style-glow 1.6s ease-in-out infinite alternate; }
`
  const g = frameFilterContract(good)
  rec('自检 · 正控制组（glow 动 filter 但挂在文字上）判通过', g.ok, g.detail)

  /* ---- 反控制组 1：给 .canvas-frame 挂一个动 filter 的动画 ⇒ 必须红 ---- */
  const bad = `
@keyframes fx-flicker { 0% { filter: brightness(1); } 50% { filter: brightness(1.6); } }
.canvas-frame.fx-flicker { animation: fx-flicker 900ms linear infinite; }
`
  const b = frameFilterContract(bad)
  rec(
    '自检 · 反控制组 1（动画给 .canvas-frame 动 filter）判不通过',
    !b.ok && /fx-flicker/.test(b.detail),
    b.ok ? '判成了通过 —— 调色被静默顶掉这类事故从此无人拦' : b.detail
  )

  /* ---- 反控制组 1b：动画挂在 .canvas-frame 上但不碰 filter ⇒ 也必须红（画框跟着抖） ---- */
  const onFrameOnly = `
@keyframes fx-shake { 20% { transform: translate3d(-1%,0,0); } }
.canvas-frame.fx-shake { animation: fx-shake 420ms linear infinite; }
`
  const fo = frameFilterContract(onFrameOnly)
  rec(
    '自检 · 反控制组 1b（transform 特效挂在画框上）判不通过',
    !fo.ok && /canvas-frame/.test(fo.detail),
    fo.ok ? '判成了通过 —— 整块画框跟着抖，成片里却没有画框' : fo.detail
  )

  /* ---- 反控制组 2：一个动画都不挂 ⇒ 也必须红（画面特效整个丢了） ---- */
  const none = `@keyframes fx-shake { from { transform: none; } }\n.look-card { color: #fff; }`
  const n = frameFilterContract(none)
  rec(
    '自检 · 反控制组 2（.canvas-frame 上一个动画都没有）判不通过',
    !n.ok && /特效/.test(n.detail),
    n.ok ? '判成了通过 —— fx-shake/fx-pulse 被删掉也没人管' : n.detail
  )

  /* ---- 反控制组 3：混写（既有安全的、又有危险的）⇒ 必须红，且只点出危险的那个 ---- */
  const mixed = `${good}\n@keyframes fx-pulse { 50% { filter: contrast(1.4); } }\n.canvas-content.fx-pulse { animation: fx-pulse 1100ms infinite; }`
  const m = frameFilterContract(mixed)
  rec(
    '自检 · 反控制组 3（安全与危险混写）判不通过且只点出危险的',
    !m.ok && /fx-pulse/.test(m.detail) && !/fx-shake/.test(m.detail),
    m.ok ? '判成了通过' : m.detail
  )

  /* ---- 判据自身的正/反：多选择器与多值写法不许漏 ---- */
  const multi = `
@keyframes boom { 50% { filter: blur(3px); } }
.canvas-content.fx-a, .canvas-content.fx-b { animation: boom 1s infinite; }
`
  const mm = frameFilterContract(multi)
  rec('自检 · 逗号多选择器写法也能命中', !mm.ok && /boom/.test(mm.detail), mm.ok ? '漏了：逗号分隔的选择器没被识别' : mm.detail)

  /* ---- 花括号配平：@keyframes 体内有嵌套块时不能把边界切错 ---- */
  const nested = `
@keyframes nested { 0% { filter: none; } 100% { filter: blur(1px); } }
.canvas-content.fx-n { animation: nested 1s infinite; }
.canvas-content.fx-ok { animation: none; }
`
  const nn = frameFilterContract(nested)
  rec('自检 · 嵌套花括号的块边界切得准', !nn.ok && /nested/.test(nn.detail), nn.ok ? `切成 ${JSON.stringify(nn.onContent)}` : nn.detail)

  const total = pass + fail
  console.log(`\nPREVIEW_FX_SELFTEST_STATS total=${total} pass=${pass} fail=${fail}`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  if (fail) {
    console.log('PREVIEW_FX_SELFTEST_FAILED')
    return 1
  }
  console.log('自检通过：静态契约判据正反两面都能分辨，且只红在对的断言上。')
  console.log('PREVIEW_FX_SELFTEST_OK')
  return 0
}

/* ---------------------------------------------------------------- 结果收集 */

let pass = 0
let fail = 0
let skip = 0
const problems = []
let aborted = null

/** 合约：断言总数恒为这个数。中断时靠 backfillSkips 补齐，verify.mjs 里的 expected 才不会误报。
 *  数法：静态契约 1 + 夹具 2 + 2.0s 段 10 + 4.5s 段 5 + 7.0s 段 5 + 面板端到端 8
 *       + 空时间线 2 + 页面错误 1 = 34。 */
const TOTAL_ASSERTIONS = 34
let emitted = 0

function check(name, ok, detail) {
  emitted += 1
  if (ok) {
    pass++
    console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`)
  } else {
    fail++
    problems.push(`${name} :: ${detail || '（没有给出原因）'}`)
    console.log(`[FAIL] ${name} :: ${detail || '（没有给出原因）'}`)
  }
}

function skipped(label, why) {
  emitted += 1
  skip += 1
  console.log(`  - ${label}  [SKIP] ${why}`)
}

/** 中断时把没跑到的那几条补成 SKIP，保证总数守恒 */
function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
}

function summarize() {
  const total = pass + fail
  console.log(`\nPREVIEW_FX_STATS total=${total} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail || aborted) {
    if (aborted) console.log(`PREVIEW_FX_ABORTED ${aborted}`)
    for (const p of problems) console.log(`  ✗ ${p}`)
    console.log('PREVIEW_FX_FAILED')
    return 1
  }
  console.log('预览区的字幕叠加 / 转场 / 滤镜 / 画面特效都真的画出来了。')
  console.log('PREVIEW_FX_OK')
  return 0
}

/* ------------------------------------------------------------------ 主流程 */

if (process.argv.includes('--selftest')) {
  process.exit(selfTest())
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
delete env.YIJAI_USE_DEV_SERVER

let app = null
const pageErrors = []

/** 读画布与叠加层的真实渲染结果 */
function readPreview(page) {
  return page.evaluate(() => {
    const px = (el, prop) => {
      if (!el) return null
      return getComputedStyle(el).getPropertyValue(prop)
    }
    const frame = document.querySelector('.canvas-frame')
    const overlays = Array.from(document.querySelectorAll('.canvas-overlay'))
    const first = overlays[0] || null
    const inner = first ? first.querySelector('[data-overlay-text]') : null
    const xfade = document.querySelector('.canvas-xfade')
    const fx = document.querySelector('.canvas-fx')
    const fcs = frame ? getComputedStyle(frame) : null
    /* 内容层：画面特效（transform 类）现在挂这里，不挂画框 —— 见 styles.css 的说明 */
    const contentEl = document.querySelector('.canvas-content')
    const ccs = contentEl ? getComputedStyle(contentEl) : null
    /**
     * 调色读**主层**的 computed filter，不读画布的。
     *
     * 2026-09-27 起调色挂在画面层上（.canvas-layer），不再挂 .canvas-frame：
     * 转场交叠时前后两段是**同时**在画面上的，挂在画布上会让后一段莫名套上前一段的
     * 滤镜（成片里两段各转各的）。画布自己仍然带画面特效的动画与底图。
     */
    const mainLayer = frame ? frame.querySelector('[data-layer-role="main"]') : null
    const mcs = mainLayer ? getComputedStyle(mainLayer) : null
    return {
      frameFound: Boolean(frame),
      frameWidth: frame ? Math.round(frame.getBoundingClientRect().width * 100) / 100 : null,
      /* 画布上同时存在几个"层"：底层内容 / 转场层 / 特效覆盖层 / 字幕层 */
      layers: {
        base: frame ? frame.querySelectorAll('.canvas-placeholder, img, video').length : 0,
        xfade: Boolean(xfade),
        fx: Boolean(fx),
        overlay: overlays.length
      },
      overlayKeys: overlays.map((el) => el.dataset.overlay),
      overlayTexts: overlays.map((el) => (el.innerText || '').trim()),
      overlayFontSize: px(inner, 'font-size'),
      overlayBg: px(inner, 'background-color'),
      /* ⚠️ 入场动画挂在文字的**外层包裹**（`.ta-move`）上，不在 `.canvas-overlay` 上：
         同一个元素要同时承载入场/出场/循环三条动画时，后一条的 fill 会把前一条盖住，
         所以 Stage 用三层元素各挂一条。读 overlay 自己只会拿到 none。 */
      overlayAnim: px(first ? first.querySelector('.ta-move') : null, 'animation-name'),
      filter: mcs ? mcs.filter : null,
      /* 画面特效（transform 类）挂在**内容层**上，读内容层的 animation-name；
         另外单独读画框的 —— 它必须是 none（画框不许跟着抖）。 */
      frameAnim: fcs ? fcs.animationName : null,
      contentAnim: ccs ? ccs.animationName : null,
      frameFx: frame ? frame.dataset.frameFx : null,
      xfadeKey: xfade ? xfade.dataset.xfade : null,
      xfadeP: xfade ? xfade.dataset.xfadeP : null,
      xfadeOpacity: xfade ? getComputedStyle(xfade).opacity : null,
      xfadeLayers: xfade ? xfade.querySelectorAll('.canvas-placeholder, img, video').length : 0,
      fxKey: fx ? fx.dataset.fx : null,
      fxAnim: fx ? getComputedStyle(fx).animationName : null,
      badge: Boolean(document.querySelector('.canvas-badge'))
    }
  })
}

/** 逐帧步进（真按键），用于把播放头挪到精确的一帧上 */
async function stepFrames(page, times) {
  for (let i = 0; i < times; i += 1) await page.keyboard.press('ArrowRight')
}

/** 前进 n 秒（Shift+→），不走帧网格吸附 */
async function stepSeconds(page, times) {
  for (let i = 0; i < times; i += 1) await page.keyboard.press('Shift+ArrowRight')
}

/** 回到 0 秒：Home 由 keymap 定义为回到开头（见 keymap.js） */
async function rewind(page) {
  await page.keyboard.press('Home')
  await sleep(120)
}

async function main() {
  console.log('=== 预览区真实效果闸门（真启 Electron + 真按键 + 真读渲染）===\n')

  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, `找不到 ${EXE}`)
    aborted = 'electron 不存在'
    return
  }

  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 构建产物存在', false, `${path.relative(ROOT, dist)} 缺失 —— 先构建渲染层`)
    aborted = 'dist-renderer/index.html 缺失'
    return
  }

  try {
    fs.rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* 删不掉就带着旧设置启动，下面会把关键断言做成"不依赖默认设置"的 */
  }

  app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    cwd: ROOT,
    env
  })

  const page = await app.firstWindow()
  page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
  page.setDefaultTimeout(20000)

  const resize = async () => {
    await app
      .evaluate(async ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        if (win.isMaximized()) win.unmaximize()
        win.setContentSize(size[0], size[1])
      }, EDITOR_SIZE)
      .catch(() => {})
  }

  await resize()
  await page.waitForSelector('.app', { timeout: 30000 })
  await sleep(1800)
  await resize()
  await sleep(600)

  /* --------------------------- 静态契约（不需要 Electron） --------------------------- */

  const cssText = fs.readFileSync(path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'styles.css'), 'utf8')
  const contract = frameFilterContract(cssText)
  check('静态 · 画面特效的动画没去动 .canvas-frame 的 filter（否则静默顶掉调色）', contract.ok, contract.detail)

  /* --------------------------- 夹具 --------------------------- */

  const saved = await page.evaluate(
    (payload) => window.yjai.draft.save(payload),
    { name: 'E2E 预览真实效果', data: { clips: CLIPS, assets: ASSETS, playhead: 0, volume: 80, zoom: 1 } }
  )
  check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

  await page.reload()
  await page.waitForSelector('.home', { timeout: 30000 })
  await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
  await page.waitForSelector('.home-draft-row', { timeout: 10000 })
  await page.locator('.home-draft-open').first().click()
  await page.waitForSelector('.wb-timeline', { timeout: 20000 })
  await sleep(500)
  await resize()
  await sleep(400)

  const clipCount = await page.locator('.clip[data-clip]').count()
  check('夹具 · 时间线出现 3 个片段', clipCount === 3, `${clipCount} 个`)

  /* ------------------------- 1) 播放头 2.0s：滤镜 + 字幕叠加 + transform 特效 ------------------------- */

  await rewind(page)
  await stepSeconds(page, 2)
  await sleep(600)

  let s = await readPreview(page)

  // 防空转：没有画布，后面所有断言都会在 null 上失败，报出来却是"取值失败"
  check(
    '2.0s · 画布真的渲染出来了',
    s.frameFound,
    s.frameFound ? `宽 ${s.frameWidth}px` : '找不到 .canvas-frame（有素材却没画布 = 后面全部断言无意义）'
  )

  /* 滤镜：读的是**最终生效**的 computed filter，不是我们写进 style 的字符串。
     这一条同时验了"滤镜没被画面特效的动画顶掉"—— CSS 动画优先级高于内联样式，
     动画一旦碰 filter，这里的值就会变成动画那一份。 */
  const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim()
  check(
    '2.0s · 滤镜真的作用在画布上（vivid = 提亮+对比+饱和）',
    norm(s.filter) === VIVID_FILTER,
    `computed filter = 「${s.filter}」，期望「${VIVID_FILTER}」（looks.json 的 vivid：brightness 1.02 / contrast 1.16 / saturate 1.34）`
  )

  /* 字幕：必须是**叠加上去的第三层**，不是把底层内容换掉。
     以前这里失败的表现是"画面上完全没有字"，而不是"字的位置不对"。 */
  check(
    '2.0s · 字幕叠加层出现（1 条）',
    s.layers.overlay === 1,
    `实测叠加层 ${s.layers.overlay} 条，keys=${JSON.stringify(s.overlayKeys)}`
  )
  check(
    '2.0s · 字幕是"叠"在画面之上的：底层内容与字幕层同时存在',
    s.layers.base > 0 && s.layers.overlay === 1,
    `底层内容 ${s.layers.base} 个 + 字幕层 ${s.layers.overlay} 个（只有其一说明字幕被当成主体替换掉了画面）`
  )
  check(
    '2.0s · 字幕文字真的渲染出来了',
    s.overlayTexts.includes('示例字幕'),
    `实测文字 ${JSON.stringify(s.overlayTexts)}`
  )

  /* 字号换算：样式表写的是"1280 宽画幅下的 36px"，渲染要换算成 cqw（容器宽百分比）。
     所以 字号 / 画布宽 必须恒等于 36/1280 —— 这一条同时证明 cqw 参照的是画布、
     而不是视口或面板（参照错了会得到一个与画布无关的比例，但肉眼只看得出"字大/字小"）。 */
  const wantRatio = STYLE_TRUTH['sub-bar'].size / STYLE_BASE_WIDTH
  const gotRatio = s.overlayFontSize && s.frameWidth ? parseFloat(s.overlayFontSize) / s.frameWidth : NaN
  check(
    `2.0s · 字幕字号按画幅等比换算（${STYLE_TRUTH['sub-bar'].size}/${STYLE_BASE_WIDTH} = ${wantRatio.toFixed(5)}）`,
    Number.isFinite(gotRatio) && Math.abs(gotRatio - wantRatio) / wantRatio < 0.02,
    `字号 ${s.overlayFontSize} / 画布宽 ${s.frameWidth} = ${Number.isFinite(gotRatio) ? gotRatio.toFixed(5) : 'NaN'}（相对误差需 < 2%）`
  )
  check(
    '2.0s · 字幕样式参数真的生效（sub-bar 的半透明黑底）',
    norm(s.overlayBg) === STYLE_TRUTH['sub-bar'].bg,
    `实测背景色 ${s.overlayBg}，期望 ${STYLE_TRUTH['sub-bar'].bg}`
  )
  check(
    '2.0s · 字幕有入场动画（这是"加完有效果"里最容易漏的一半）',
    String(s.overlayAnim).includes(STYLE_TRUTH['sub-bar'].anim),
    `animation-name = ${s.overlayAnim}，期望含 ${STYLE_TRUTH['sub-bar'].anim}`
  )

  /* transform 类画面特效：挂在**内容层**上 —— 画面在动、画框不动。
     为什么必须分开判：挂在画框上时圆角/描边/外阴影会一起抖，而**成片里没有画框**，
     于是预览与成片对不上，且两边单独看都合理。 */
  check(
    '2.0s · 画面特效（transform 类 fx-shake）挂在内容层上并在播',
    String(s.contentAnim).includes('fx-shake') && s.frameFx === 'fx-shake',
    `content animation-name = ${s.contentAnim}；data-frame-fx = ${s.frameFx}`
  )
  check(
    '2.0s · 画框自身没有动画（圆角/描边/外阴影不跟着抖，与成片一致）',
    s.frameAnim === 'none' || s.frameAnim === null || s.frameAnim === '',
    `frame animation-name = ${s.frameAnim}`
  )

  /* ------------------------- 2) 播放头 4.5s：转场交叠窗口内 ------------------------- */

  await rewind(page)
  await stepSeconds(page, 4)
  await stepFrames(page, 15)
  await sleep(700)

  s = await readPreview(page)
  check(
    '4.5s · 转场层出现，且就是 fade',
    s.xfadeKey === 'fade',
    `data-xfade = ${s.xfadeKey}（期望 fade；交叠窗口 = [接缝−时长, 接缝) = [4.0, 5.0)）`
  )
  check(
    '4.5s · 转场进度在窗口正中（0.5±0.06）',
    Number.isFinite(parseFloat(s.xfadeP)) && Math.abs(parseFloat(s.xfadeP) - 0.5) <= 0.06,
    `data-xfade-p = ${s.xfadeP}（4.5s 距窗口起点 4.0s 正好半个时长 1s）`
  )
  check(
    '4.5s · 转场真的在混（不透明度 ≈ 0.5，不是只挂了个属性）',
    Number.isFinite(parseFloat(s.xfadeOpacity)) && Math.abs(parseFloat(s.xfadeOpacity) - 0.5) <= 0.06,
    `computed opacity = ${s.xfadeOpacity}`
  )
  check(
    '4.5s · 转场层里真的有"后一段"在渲染',
    s.xfadeLayers > 0,
    `转场层内的媒体元素 ${s.xfadeLayers} 个（0 = 只画了一个空壳）`
  )
  check(
    '4.5s · 三件事同时成立：滤镜仍在、字幕仍在、转场也在',
    norm(s.filter) === VIVID_FILTER && s.layers.overlay === 1 && s.xfadeKey === 'fade',
    `filter=「${s.filter}」叠加层=${s.layers.overlay} 转场=${s.xfadeKey}`
  )

  /* ------------------------- 3) 播放头 7.0s：字幕离开区间、覆盖层特效 + 换样式 ------------------------- */

  await rewind(page)
  await stepSeconds(page, 7)
  await sleep(700)

  s = await readPreview(page)
  check(
    '7.0s · 字幕区间外不再有叠加层（不是一直挂着不放）',
    s.layers.overlay === 0,
    `叠加层 ${s.layers.overlay} 条（字幕夹具是 [1,5)，7.0s 已离开）`
  )
  check('7.0s · 转场窗口外没有转场层', !s.layers.xfade, `转场层存在=${s.layers.xfade}`)
  check(
    '7.0s · 画面特效换成乙片段的 fx-scan（特效跟着播放头所在片段走）',
    s.fxKey === 'fx-scan',
    `data-fx = ${s.fxKey}（期望 fx-scan；甲片段的 fx-shake 是 transform 类、不产生覆盖层）`
  )
  check(
    '7.0s · 覆盖层特效在播（animation-name 含 fx-scan）',
    String(s.fxAnim).includes('fx-scan'),
    `animation-name = ${s.fxAnim}`
  )
  check(
    '7.0s · 覆盖层特效没有把调色顶掉（乙片段无滤镜 ⇒ filter 应为 none）',
    norm(s.filter) === 'none',
    `computed filter = 「${s.filter}」`
  )

  /* ---------------- 4) 端到端：在面板上点一张字幕样式卡，画面上要真的多出来 ---------------- */

  await page.locator('.wb-tab[data-wb-tab="subtitle"]').click()
  await sleep(600)
  /*
   * 2026-09-26：字幕页左栏按参考重排后，「AI字幕 → 自动字幕」落的是 ASR 能力面板
   * （模型列表），**不是**样式网格 —— 上一版点它导致这条红。样式网格的正主是
   * 一级节点「自定义」（`subtitle-custom` → panel 'text-style'，group 缺省 null =
   * 全部字幕样式；对应参考 PropertyPanel_SubtitleStyle 的语义，AssetTree.jsx 有注）。
   * 端到端要验的是"点样式卡 → 画面上真的多出字幕"，换哪个入口不影响这条断言在挡什么。
   * 「自定义」是一级节点，不需要先展开父项。
   */
  const customNode = await page.$('[data-wb-node="subtitle-custom"]')
  check('面板 · 左栏「字幕 → 自定义」节点存在', Boolean(customNode), customNode ? 'data-wb-node="subtitle-custom"' : '找不到节点')
  await page.locator('[data-wb-node="subtitle-custom"]').click()
  await sleep(500)
  const firstCard = await page.$('[data-style="sub-accent"]')
  check(
    '面板 · 字幕样式卡渲染出来了',
    Boolean(firstCard),
    firstCard ? '找到 [data-style="sub-accent"]' : '找不到样式卡（网格没渲染或 data-style 钩子丢了）'
  )

    const beforeClips = await page.locator('.wb-tllane[data-lane="text"] .clip[data-clip]').count()

    if (firstCard) {
      await firstCard.click()
      await sleep(700)
      s = await readPreview(page)
      const want = STYLE_TRUTH['sub-accent']
      const ratio = s.overlayFontSize && s.frameWidth ? parseFloat(s.overlayFontSize) / s.frameWidth : NaN
      check(
        '点样式卡后 · 播放头上真的多出一条字幕（这是用户诉求的端到端）',
        s.layers.overlay === 1 && s.overlayKeys[0] === 'sub-accent',
        `叠加层 ${s.layers.overlay} 条 keys=${JSON.stringify(s.overlayKeys)}（期望 1 条 sub-accent）`
      )
      check(
        '点样式卡后 · 新字幕用的是这张卡的参数（底色）',
        norm(s.overlayBg) === want.bg,
        `实测背景色 ${s.overlayBg}，期望 ${want.bg}`
      )
      check(
        '点样式卡后 · 新字幕的字号按这张卡的表换算',
        Number.isFinite(ratio) && Math.abs(ratio - want.size / STYLE_BASE_WIDTH) / (want.size / STYLE_BASE_WIDTH) < 0.02,
        `字号 ${s.overlayFontSize} / 画布宽 ${s.frameWidth} = ${Number.isFinite(ratio) ? ratio.toFixed(5) : 'NaN'}，期望 ${(want.size / STYLE_BASE_WIDTH).toFixed(5)}`
      )

      const afterAdd = await page.locator('.wb-tllane[data-lane="text"] .clip[data-clip]').count()
      check(
        '点样式卡后 · 字幕轨多了一段（新增而不是什么都不做）',
        afterAdd === beforeClips + 1,
        `点之前 ${beforeClips} 段 → 点之后 ${afterAdd} 段`
      )

      /* 再点另一张：这一页的语义是"给已有字幕换样式"，**不许**再堆一条。
         参考里这一页对应的是属性面板（PropertyPanel_SubtitleStyle），
         堆新字幕是素材页（Subtitles_Materials）的行为，两件事混了就会出现
         "我只想让这条换个样子，结果又多出来一条"。 */
      const secondCard = await page.$('[data-style="sub-neon"]')
      if (secondCard) {
        await secondCard.click()
        await sleep(700)
        s = await readPreview(page)
        const afterRestyle = await page.locator('.wb-tllane[data-lane="text"] .clip[data-clip]').count()
        check(
          '再点另一张样式 · 是"换样式"而不是又堆一条（段数不变）',
          afterRestyle === afterAdd,
          `段数 ${afterAdd} → ${afterRestyle}（应保持不变）`
        )
        check(
          '再点另一张样式 · 画面上的字幕换成了新样式',
          s.overlayKeys[0] === 'sub-neon',
          `data-overlay = ${JSON.stringify(s.overlayKeys)}（期望 sub-neon）`
        )
      } else {
        check('再点另一张样式 · 卡片存在', false, '找不到 [data-style="sub-neon"]')
      }
    }

  /* ------------- 5) 空时间线上的字幕：这条路径以前**一句话都不画** -------------
     现场是最常见的那一次：第一次用这个功能的人，时间线是空的，
     直接点「字幕 → 字幕模板」。当时的实现拿"底下有没有画面片段"决定要不要叠字幕，
     空时间线当然没有画面 ⇒ 一个字都不画 ⇒ 用户看到的是"点了没反应"。
     取景工具第一次跑到这条路径就抓到了它（本闸门当时的夹具里一直有视频片段，
     所以没覆盖到）—— 这条断言就是补上的那个盲点。 */
  for (const id of ['fx_clip_a', 'fx_clip_b']) {
    const el = await page.$(`.clip[data-clip="${id}"]`)
    if (el) {
      await el.click()
      await sleep(200)
      await page.keyboard.press('Delete')
      await sleep(300)
    }
  }
  const leftover = await page.locator('.wb-tllane[data-lane="video"] .clip[data-clip]').count()
  check(
    '空时间线 · 视频片段已删光（把"第一次用"的现场造出来）',
    leftover === 0,
    `视频轨还剩 ${leftover} 段（删不干净的话下一条断言就不是在验空时间线了）`
  )

  await rewind(page)
  await stepSeconds(page, 2)
  await sleep(600)
  s = await readPreview(page)

  check(
    '空时间线 · 画布为字幕开出来，且字幕真的画上去了',
    s.frameFound && s.layers.base === 0 && s.layers.overlay === 1 && s.overlayKeys[0] === 'sub-bar',
    `画布=${s.frameFound} 底层内容=${s.layers.base} 字幕层=${s.layers.overlay} keys=${JSON.stringify(s.overlayKeys)}` +
      `（空时间线上应该是"没有素材、但有一条带样式的字幕"；以前这里是全无）`
  )

  /* 页面错误：只记不判为"通过"条件 —— 离线时后端请求会 403。
     但真出 pageerror 说明渲染层崩了，前面量到的东西不可信。 */
  const realErrors = pageErrors.filter((t) => !/Failed to load resource|net::ERR|403|401/i.test(t))
  check('全程 0 个页面错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
}

/* ------------------------------------------------------------------ 执行 */

try {
  await main()
} catch (e) {
  /* 中途炸了：记一条 fail + 立 aborted 旗标，**不**把没跑到的补成 SKIP ——
     那会把"跑到一半炸了"变成"断言的种类少了"，比红还难查。 */
  aborted = e && e.stack ? String(e.stack).split('\n')[0] : String(e)
  fail++
  problems.push(`闸门自身异常 :: ${aborted}`)
  console.log(`[FAIL] 闸门自身异常 :: ${aborted}`)
}

/* 没跑到的补成 SKIP：**总数守恒**比"少跑几条"重要 —— 少跑时 verify.mjs 只报
   "断言数不符"，看的人会去查数目，而真因（提前返回 / 平台差异）就沉在水下了。 */
backfillSkips('本次运行没有跑到这一项')

/* 收尾：裸 await app.close() 在这个环境会一直不返回（实测挂过 7 分钟），
   所以 race 一个 4 秒上限，到点直接按 pid 强杀。
   ⚠️ 强杀前必须 try/catch 包住 `app.process()`：close 之后 playwright 的
      连接已经拆了，再问它要 process 会抛
       `Cannot read properties of undefined (reading '_object')` ——
       本闸门第一次跑就撞上了，表现是**全部断言都过了、退出码却是 1**，
       而且报错栈指向 playwright 内部，看着完全不像收尾代码的问题。 */
if (app) {
  try {
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 4000))])
  } catch {
    /* 落到强杀 */
  }
  let pid = null
  try {
    pid = app.process()?.pid || null
  } catch {
    pid = null
  }
  if (pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 已经退了 */
    }
  }
}

process.exit(summarize())
