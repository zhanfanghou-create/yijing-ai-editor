#!/usr/bin/env node
/**
 * 画面特效的**四路接线**闸门（纯静态，不起 Electron）。
 *
 * 为什么单独一道：加一个特效要同时改四处 ——
 *   ① `shared/frameEffects.json`（真源：键、kind、时长、文案）
 *   ② `renderer/styles.css`（预览：`.canvas-content.<key>` 或 `.canvas-fx.<key>`，外加卡片示意 `.fx-demo-art.<key>`）
 *   ③ `main/looks.js` 的 `frameFxFilterFor`（导出：ffmpeg 滤镜链）
 *   ④ `assets/materials/<sha1("css|"+key)>.webp`（素材卡缩略图，由 tools/gen-material-thumbs.py 生成）
 *
 * 漏任何一处都**不报错、不影响构建**，只表现为：
 *   漏 ② → 卡片点了、预览一像素不动（"状态变了像素没变"）
 *   漏 ③ → 预览在动、成片原样（导出侧那条最贵）
 *   漏 ④ → 卡片是个空框
 *   漏 ① → 时间线上标不出名字，且 Inspector 的下拉里没有这一项
 * 所以四处必须由闸门对上，不能靠"我记得改了"。
 *
 * ## 五类 kind 各自的"四处"长得不一样（2026-11-02 扩写）
 *   transform → CSS `.canvas-content.<key>`（带 animation）
 *   overlay   → CSS `.canvas-fx.<key>`
 *   pack      → 像素来自素材包的雪碧图，CSS 只有一条通用 `.canvas-fx.fx-pack`；
 *               **导出侧必须返回空串**（它的像素不在滤镜链里，走的是 overlay 输入）。
 *               这一条的"接线"由 `check-fx-packs` 负责（表 ↔ 包双向匹配、帧真在动）。
 *   warp      → 没有独立 CSS 规则（挂在 `.canvas-content` 的 `filter: url(#yjai-fisheye)`），
 *               导出走 `lenscorrection`
 *   卡片示意 `.fx-demo-art.<key>` 只对 transform / overlay 有意义 ——
 *   pack / warp 的卡片是**真实缩略图**（一张叠了素材帧的照片 / 一张真畸变过的照片），
 *   再画一层 CSS 示意反而会盖住它。
 *
 * 判据全部读**消费端的源码/产物**，不读我们自己的解释：
 *   · styles.css 用括号配平切块，不用正则（正则处理嵌套花括号必然出错）
 *   · looks.js 只认 `case '<key>':` 字面量，不认注释里提到的键
 *   · 缩略图直接看磁盘文件名（生成器的命名规则是 sha1('css|'+key)[:12] + '.webp'）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EFFECTS = path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'frameEffects.json')
const PARAMS = path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'fxParams.json')
const CSS = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'styles.css')
const LOOKS = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'looks.js')
const MAT = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'materials.js')
const STAGE = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'components', 'Stage.jsx')
const THUMBS = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'materials')

const out = []
const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail })

/* Stage.jsx 的源码（warp 类的接线不在 CSS 里，在 JSX 上） */
const STAGE_SRC = fs.existsSync(STAGE) ? fs.readFileSync(STAGE, 'utf8') : ''

/** 去注释，否则注释里提到的键会被当成"已接线" */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/**
 * 用括号配平切出样式块，返回 Map<选择器原文, 块体>。
 * 一个选择器列表（`a, b {`）拆成多条，便于按 `.canvas-fx.fx-x` 精确查。
 */
function cssBlocks(text) {
  const map = new Map()
  const src = stripComments(text)
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const head = src.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
      j++
    }
    const body = src.slice(open + 1, j - 1)
    if (head && !head.startsWith('@')) {
      for (const sel of head.split(',')) map.set(sel.trim().replace(/\s+/g, ' '), body)
    }
    i = j
  }
  return map
}

const thumbName = (key) => crypto.createHash('sha1').update(`css|${key}`).digest('hex').slice(0, 12) + '.webp'

function main() {
  for (const f of [EFFECTS, PARAMS, CSS, LOOKS, MAT]) {
    if (!fs.existsSync(f)) {
      console.log(`[FAIL] 前置 :: 找不到 ${path.relative(ROOT, f)}`)
      console.log('FX_WIRING_FAILED')
      return 1
    }
  }

  const table = JSON.parse(fs.readFileSync(EFFECTS, 'utf8'))
  const effects = table.effects || []
  const paramsFamilies = JSON.parse(fs.readFileSync(PARAMS, 'utf8')).families || {}
  const real = effects.filter((e) => e.kind && e.kind !== 'none')
  const blocks = cssBlocks(fs.readFileSync(CSS, 'utf8'))
  const looksSrc = stripComments(fs.readFileSync(LOOKS, 'utf8'))
  const matSrc = fs.readFileSync(MAT, 'utf8')
  const thumbs = new Set(fs.existsSync(THUMBS) ? fs.readdirSync(THUMBS) : [])
  /* 卡片实际引用了哪些键 —— 缩略图只对这些键有要求（见 ⑤ 的说明）。
     ⚠️ 键现在可以带参数后缀（`fx-glow@2140`），字符类必须包含 `@`，
        否则 267 个参数化键会被整片漏掉，缩略图与注册两项判据变成空集恒真。 */
  const fxSection = matSrc.slice(matSrc.indexOf('export const EFFECT_GROUPS'), matSrc.indexOf('export const ADJUST_GROUPS'))
  const used = [...new Set([...fxSection.matchAll(/css:\s*"([a-z0-9@-]+)"/g)].map((m) => m[1]))]
  const familyOf = (key) => String(key).split('@')[0]

  add('特效表里至少 10 个真效果（含 none 之外）', real.length >= 10, `${real.length} 个：${real.map((e) => e.key).join(' ')}`)

  /* ① kind 只能是五档 —— 出现 filter 类会把调色顶掉（见 frameEffects.json 的 $comment） */
  const kinds = [...new Set(effects.map((e) => e.kind))]
  const badKind = kinds.filter((k) => !['none', 'transform', 'overlay', 'pack', 'warp'].includes(k))
  add(
    'kind 只有 none / transform / overlay / pack / warp',
    badKind.length === 0,
    badKind.length ? `多出 ${badKind.join(' ')}` : kinds.join(' / ')
  )

  /* ② 预览：每个键都要有一条作用在正确元素上的规则 */
  const cssMiss = []
  for (const e of real) {
    if (e.kind === 'pack') {
      /* 全部素材类共用一条播放规则（雪碧图步进），不再一 key 一条 */
      if (!blocks.has('.canvas-fx.fx-pack')) cssMiss.push(`${e.key}（缺通用 .canvas-fx.fx-pack）`)
      continue
    }
    if (e.kind === 'warp') {
      /* warp 没有 CSS 块，改看"Stage 里真的挂了这个 filter" */
      if (!/url\(#yjai-fisheye\)/.test(STAGE_SRC)) cssMiss.push(`${e.key}（Stage.jsx 里没挂 url(#yjai-fisheye)）`)
      continue
    }
    const want = e.kind === 'transform' ? `.canvas-content.${e.key}` : `.canvas-fx.${e.key}`
    if (!blocks.has(want)) cssMiss.push(`${e.key}（缺 ${want}）`)
  }
  add('每个特效键在 styles.css 里都有作用在正确元素上的规则', cssMiss.length === 0, cssMiss.length ? cssMiss.join('；') : `${real.length} 个键全命中`)

  /* ③ 卡片示意：`.fx-demo-art.<key>` —— 漏了就是"卡片上不动，画面上动" */
  const demoMiss = real
    .filter((e) => e.kind === 'transform' || e.kind === 'overlay')
    .filter((e) => !blocks.has(`.fx-demo-art.${e.key}`))
    .map((e) => e.key)
  add(
    '每个 CSS 类特效都有卡片示意样式（.fx-demo-art.<key>）',
    demoMiss.length === 0,
    demoMiss.length ? `缺 ${demoMiss.join(' ')}` : '全部有（素材类/鱼眼用真实缩略图，不需要）'
  )

  /* ④ 导出：`case '<key>':` 且该 case 之后要有 return（防"写了 case 忘了给滤镜"） */
  const lookMiss = []
  for (const e of real) {
    const at = looksSrc.indexOf(`case '${e.key}':`)
    if (at < 0) {
      /* patch 类**必须没有 case**：它的像素走 overlay 输入，给个近似滤镜等于
         "成片里多一层假效果叠在真素材上"。所以"没有 case"在这里是**正确**的。 */
      if (e.kind !== 'pack') lookMiss.push(`${e.key}（无 case）`)
      continue
    }
    const seg = looksSrc.slice(at, at + 500)
    /* `return (` 也算 —— 多行拼串的 case 习惯用括号包起来（fx-pulse 就是），
       只认引号会把这种写法误判成"忘了给滤镜"。 */
    if (!/return\s*[('"`[]/.test(seg)) lookMiss.push(`${e.key}（case 里没有 return）`)
  }
  add('每个特效键在 frameFxFilterFor 里都有 case 且返回了滤镜', lookMiss.length === 0, lookMiss.length ? lookMiss.join('；') : `${real.length} 个键全命中`)

  /* ④b 素材类反过来：**一个 case 都不许有**（有就是"滤镜链里偷偷叠了近似效果"） */
  const packHasCase = real.filter((e) => e.kind === 'pack').filter((e) => looksSrc.includes(`case '${e.key}':`)).map((e) => e.key)
  add(
    '素材类特效没有混进滤镜链（否则成片会叠两层）',
    packHasCase.length === 0,
    packHasCase.length ? `混进去了 ${packHasCase.join(' ')}` : '全部只走 overlay 输入'
  )

  /* ⑤ 缩略图：只要求**被卡片引用**的键有图。
     以前要求"所有键都有"—— 于是当一个效果没有任何卡片在用时（比如 fp-lightleak
     的卡片全被分到别处），闸门会要求一张没人看的图，属于把"内容现状"当成了"接线契约"。 */
  const referenced = new Set(used)
  const thumbMiss = real.filter((e) => referenced.has(e.key)).filter((e) => !thumbs.has(thumbName(e.key))).map((e) => `${e.key}→${thumbName(e.key)}`)
  add('每个被卡片引用的特效键都有缩略图文件', thumbMiss.length === 0, thumbMiss.length ? `缺 ${thumbMiss.join(' ')}` : `${referenced.size} 个键全有`)

  /* ⑥ 素材卡引用的键必须在表里注册（否则点下去 frameFx 是个表外值，时间线标不出名字）。
     ⚠️ 按**族键**判：`fx-glow@2140` 的注册项是 `fx-glow`，直接比完整键会把 267 条
        全部判成「表外键」；反过来只比族键而不看参数串，又会让 `fx-glow@zzzz`
        （越界档）这种手改坏的键混过去 —— 所以参数串单独校一次档位范围。 */
  const registered = new Set(effects.map((e) => e.key))
  const unregistered = [...new Set(used.filter((k) => !registered.has(familyOf(k))))]
  add('素材卡引用的特效键都在 frameEffects.json 里注册过', unregistered.length === 0, unregistered.length ? `表外键：${unregistered.join(' ')}` : `${used.length} 个键全注册（去重后 ${new Set(used.map(familyOf)).size} 个族）`)

  /* ⑥b 参数串的每一位都必须是该轴存在的档位（`fx-glow@99999` 会被解码夹到最大档，
      静默变成另一张卡的外观 —— 属于"改坏一个字符、画面换个样还不报错"） */
  const badCode = []
  for (const k of used) {
    const at = k.indexOf('@')
    if (at < 0) continue
    const fam = k.slice(0, at)
    const code = k.slice(at + 1)
    const axes = (paramsFamilies[fam] || {}).axes || []
    if (!axes.length) {
      badCode.push(`${k}（族无参数轴）`)
      continue
    }
    if (code.length > axes.length) {
      badCode.push(`${k}（多出 ${code.length - axes.length} 位）`)
      continue
    }
    for (let i = 0; i < code.length; i += 1) {
      const idx = '0123456789abcdefghijklmnopqrstuvwxyz'.indexOf(code[i])
      if (idx < 0 || idx >= axes[i].values.length) {
        badCode.push(`${k}（第 ${i + 1} 位 ${code[i]} 超出 ${axes[i].values.length} 档）`)
        break
      }
    }
  }
  add('卡片键里的参数串每一位都在该族的档位范围内', badCode.length === 0, badCode.length ? badCode.slice(0, 4).join('；') : `${used.filter((k) => k.includes('@')).length} 个参数化键全部合法`)

  /* ⑦ 反向：styles.css 里不许出现表外的 fx 键（删了效果却留下样式，等于给下一个人埋雷）。
     `fx-pack` 是**通用播放类**（所有素材类共用），不是效果键，按白名单放过。 */
  const GENERIC_CLASSES = new Set(['fx-pack'])
  const cssOrphan = [...blocks.keys()]
    .map((sel) => (sel.match(/^\.(?:canvas-fx|canvas-content)\.(fx-[a-z0-9-]+)$/) || [])[1])
    .filter(Boolean)
    .filter((k) => !GENERIC_CLASSES.has(k))
    .filter((k) => !registered.has(k))
  add('styles.css 里没有表外的 fx-* 规则', cssOrphan.length === 0, cssOrphan.length ? `孤儿键：${[...new Set(cssOrphan)].join(' ')}` : '无孤儿')

  /* ⑧ 每个 transform 特效必须真的挂了动画（挂错元素/忘了 animation 都是"静默不动"） */
  const noAnim = real
    .filter((e) => e.kind === 'transform')
    .filter((e) => !/animation\s*:/.test(blocks.get(`.canvas-content.${e.key}`) || ''))
    .map((e) => e.key)
  add('transform 类特效的规则里带 animation', noAnim.length === 0, noAnim.length ? `缺 ${noAnim.join(' ')}` : '全部带 animation')

  let pass = 0
  for (const r of out) {
    if (r.ok) pass++
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
  }
  console.log(`\nFX_WIRING_STATS total=${out.length} pass=${pass} fail=${out.length - pass}`)
  if (pass !== out.length) {
    console.log('FX_WIRING_FAILED')
    return 1
  }
  console.log('画面特效四处接线齐全：真源 / 预览 / 卡片示意 / 导出 / 缩略图。')
  console.log('FX_WIRING_OK')
  return 0
}

process.exit(main())
