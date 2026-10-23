#!/usr/bin/env node
/**
 * 闸门 · 画面效果（描边四样式 + 内阴影）。
 *
 * 这一族错误的共同点：**代码"接上了"，成片一个像素没变，而 ffmpeg 不报错**。
 * 本轮真踩到过的四种：
 *   ① 内阴影：把阴影图当 `overlay` 的**底图**、画面当上层 ⇒ 画面 alpha 全 255，
 *      阴影被整层盖掉（命令合法、结果与"没开"逐字节相同）；
 *   ② 内阴影：用"线性距离场 + σ≈13 的 gblur" ⇒ 20px 的带子被平均成 3/255，
 *      看上去像没生效（不是没算，是算得太淡）；
 *   ③ 双线描边：第二圈接着第一圈的**结果**算 alpha ⇒ 环从外沿再往外长，
 *      双线变成"外侧一道颜色对不上的粗边"；
 *   ④ 虚线框：`onH*inDashX` 少了括号 ⇒ `*` 只绑定 `onH` 的后半项，
 *      上边恒亮，虚线退化成实线。
 *
 * 判据分四层：纯规则 → 生成的遮罩图（逐像素读出图案）→ 真渲染像素 → 静态接线。
 *
 * 用法：node tools/check-fx-styles.mjs
 * 退出码：0 通过 / 1 有失败 / 2 本机没有 ffmpeg（如实跳过）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { effects, ffmpegOf, workDir, makeQuad, readPixel, readLumaRow, renderCase, near } from './fx-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) pass += 1
  else {
    fail += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
  }
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

const fxOf = (raw) => effects.readEffects(raw)

/* --------------------------- ① 纯规则：描边 --------------------------- */

console.log('· 描边 → 层次表')
const solid = fxOf({ stroke: { on: true, width: 40, color: '#ff00ff', style: 'solid' } })
const double = fxOf({ stroke: { on: true, width: 40, color: '#ff00ff', style: 'double', color2: '#00ffff' } })
const glow = fxOf({ stroke: { on: true, width: 40, color: '#ffffff', style: 'glow' } })
const dashed = fxOf({ stroke: { on: true, width: 20, color: '#ff0000', style: 'dashed', dash: 30, gap: 20 } })

check('缺省样式是实线（老草稿不受影响）',
  effects.strokeStyleOf(fxOf({ stroke: { on: true, width: 10, color: '#fff' } })) === 'solid')
check('四种样式都在 STROKE_STYLES 里（表项是 {key,label}，界面直接用 label）',
  ['solid', 'double', 'glow', 'dashed'].every((s) => effects.STROKE_STYLES.some((item) => item.key === s)))

const layersSolid = effects.strokeLayers(solid, 640)
const layersDouble = effects.strokeLayers(double, 640)
const layersGlow = effects.strokeLayers(glow, 640)
const layersDashed = effects.strokeLayers(dashed, 640)
check('实线 = 1 圈', layersSolid.length === 1 && layersSolid[0].dilations > 0, `dil=${layersSolid[0] && layersSolid[0].dilations}`)
check('双线 = 2 圈（底宽顶窄）',
  layersDouble.length === 2 && layersDouble[0].dilations > layersDouble[1].dilations,
  layersDouble.map((l) => l.dilations).join('>'))
check('双线的两圈颜色不同（否则"双线"看不出来）', layersDouble[0].color !== layersDouble[1].color)
check('发光 = 1 圈 + 模糊（sigma > 0）', layersGlow.length === 1 && layersGlow[0].blur > 0, `blur=${layersGlow[0] && layersGlow[0].blur}`)
check('虚线**不**走膨胀那条路（走独立的虚线框图）', layersDashed.length === 0)
check('取色按层号（color / color2）',
  effects.strokeLut(double, (v) => v, 'color').includes('255:g=0:b=255') &&
    effects.strokeLut(double, (v) => v, 'color2').includes('r=0:g=255:b=255'))

/* --------------------------- ① 纯规则：内阴影 --------------------------- */

console.log('· 外阴影 / 内阴影互斥')
const outerOnly = fxOf({ shadow: { on: true, x: 30, y: 30, blur: 20, color: '#000000', opacity: 80 } })
const innerOnly = fxOf({ shadow: { on: true, inner: true, spread: 60, blur: 40, x: 0, y: 0, color: '#000000', opacity: 90 } })
check('on 单独 → 只有外阴影', effects.hasOuterShadow(outerOnly) === true && effects.hasInnerShadow(outerOnly) === false)
check('on + inner → 只有内阴影（否则内阴影会顺带画出一道外阴影）',
  effects.hasOuterShadow(innerOnly) === false && effects.hasInnerShadow(innerOnly) === true)

console.log('· 内阴影 → 预览样式与导出参数同源')
const insetCss = effects.innerShadowStyle(innerOnly)
check('预览：一串 box-shadow: inset ...', /^inset /.test(insetCss), insetCss.slice(0, 48))
check('预览：长度单位是 cqw（窗口缩放自动等比，不写死 px）', /cqw/.test(insetCss))
const spec = effects.innerShadowSpec(innerOnly, 640, 360)
check('导出：参数是像素口径且尺寸取画框',
  spec && spec.width === 640 && spec.height === 360, spec && `${spec.width}x${spec.height}`)
check('导出：spread / blur 各换算成像素（不是把百分比直接当像素）',
  spec.spreadPx === 20 && spec.blurPx === 13, `spread=${spec.spreadPx} blur=${spec.blurPx}`)
const innerExpr = effects.innerShadowExpr(spec)
/**
 * 落差曲线必须是 smoothstep（`1 - t*t*(3-2*t)`），不是线性。
 * 线性 + 大 sigma 的模糊会把带子平均掉 —— 实测角上只剩 3/255，
 * 这也是"内阴影看起来没生效"的真正原因。这条断言就是防它回退。
 */
check('导出：落差用 smoothstep 曲线（不是线性，线性会被算得太淡）', /\(3-2\*/.test(innerExpr))
check('导出：表达式里没有除法后直接当 alpha 的线性写法', !/max\(0,min\(1,1-\$\{d\}\//.test(innerExpr))

/* ------------------------- ② 生成的遮罩图（逐像素） ------------------------- */

const ffmpeg = ffmpegOf()
const work = workDir('yjai-fxstyle-check-')
if (!ffmpeg) {
  console.log('FXSTYLE_SKIPPED 本机没有 ffmpeg（像素层无法取证）')
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  process.exit(fail ? 1 : 2)
}
const src = makeQuad(ffmpeg, work)

console.log('· 真实渲染（描边四样式；夹具缩到 60%，让环落在画框内）')
const outSolid = await renderCase({ ffmpeg, work, src, clipFx: { stroke: { on: true, width: 40, color: '#ff00ff', style: 'solid' } }, scale: 60, name: 's-solid' })
const outDouble = await renderCase({ ffmpeg, work, src, clipFx: { stroke: { on: true, width: 40, color: '#ff00ff', style: 'double', color2: '#00ffff' } }, scale: 60, name: 's-double' })
const outGlow = await renderCase({ ffmpeg, work, src, clipFx: { stroke: { on: true, width: 40, color: '#ffffff', style: 'glow' } }, scale: 60, name: 's-glow' })
const outDashed = await renderCase({ ffmpeg, work, src, clipFx: { stroke: { on: true, width: 20, color: '#ff0000', style: 'dashed', dash: 30, gap: 20 } }, scale: 60, name: 's-dashed' })
check('四个样式的片子都导出成功', Boolean(outSolid && outDouble && outGlow && outDashed))

/**
 * 几何：scale=60 ⇒ 画面 384×216 居中，左边缘在 x=128；
 * 描边宽度 40 → `ratio×画框宽` = 13px，环落在 x∈[115,128)。
 * 双线的内圈（6px）落在 x∈[122,128)。
 */
if (outSolid) {
  const ring = readPixel(ffmpeg, outSolid, 120, 180, work)
  check('实线：环上是描边色（品红）', near(ring, [255, 0, 255], 40), ring.join(','))
}
if (outDouble) {
  const outer = readPixel(ffmpeg, outDouble, 117, 180, work)
  const inner = readPixel(ffmpeg, outDouble, 125, 180, work)
  check('双线：外圈是 color（品红）', near(outer, [255, 0, 255], 40), outer.join(','))
  /**
   * 这一条专治"第二圈接着第一圈的结果算 alpha"那种错法：
   * 错的版本里内圈会被推到外圈的**外面**（x≈110 一带），x=125 反而是外圈颜色。
   */
  check('双线：内圈是 color2（青）且**在外圈内侧**', near(inner, [0, 255, 255], 40), inner.join(','))
}
if (outGlow) {
  const ring = readPixel(ffmpeg, outGlow, 120, 180, work)
  check('发光：环上是亮色（白，且被模糊散开）', ring[0] > 150 && ring[1] > 150 && ring[2] > 150, ring.join(','))
}
if (outDashed) {
  /* 画框上边（y=2）取一整行：虚线必须有"亮/暗"交替，否则退化成实线 */
  const row = readLumaRow(ffmpeg, outDashed, 2, 200, work)
  let on = 0
  let runs = 0
  for (let i = 0; i < row.length; i += 1) {
    const bright = row[i] > 120
    if (bright) on += 1
    if (bright && (i === 0 || row[i - 1] <= 120)) runs += 1
  }
  check('虚线：上边真的有断口（亮段数 ≥ 3，不是一整条实线）', runs >= 3, `亮段 ${runs} 段 / 亮像素 ${on}`)
  check('虚线：亮段与暗段都占相当比例（不是只有两端有）',
    on > row.length * 0.25 && on < row.length * 0.8, `${on}/${row.length}`)
}

console.log('· 真实渲染（内阴影）')
const outPlain = await renderCase({ ffmpeg, work, src, clipFx: {}, scale: 100, name: 'i-plain' })
const outInner = await renderCase({ ffmpeg, work, src, clipFx: { shadow: { on: true, inner: true, spread: 60, blur: 40, x: 0, y: 0, color: '#000000', opacity: 90 } }, scale: 100, name: 'i-inner' })
check('内阴影片子导出成功', Boolean(outPlain && outInner))
if (outPlain && outInner) {
  const cPlain = readPixel(ffmpeg, outPlain, 6, 6, work)
  const cInner = readPixel(ffmpeg, outInner, 6, 6, work)
  const mPlain = readPixel(ffmpeg, outPlain, 330, 190, work)
  const mInner = readPixel(ffmpeg, outInner, 330, 190, work)
  /* 角上离边 6px、spread 20px ⇒ 应当已经接近全浓（opacity 90%） */
  check('内阴影：角上显著变暗（不是"看起来没生效"）', cInner[0] < cPlain[0] * 0.35, `${cPlain[0]} → ${cInner[0]}`)
  check('内阴影：画面中部基本不受影响（它不是一层蒙版）',
    Math.abs(mInner[0] - mPlain[0]) <= 12 && Math.abs(mInner[2] - mPlain[2]) <= 12, `${mPlain.join(',')} vs ${mInner.join(',')}`)
}

/* ----------------------------- ③ 静态接线 ----------------------------- */

console.log('· 静态接线（防回退）')
const renderSrc = read('packages/desktop/src/main/render.js')
/* 用纯字符串包含来判：正则里塞 `${...}` 需要转义一层，写错就变成"永远不匹配"的假绿/假红 */
check('内阴影：`overlay` 的**底图是画面**（写成 [阴影][画面] 会被画面整层盖掉）',
  renderSrc.includes("[${cur}][${next('ism')}]overlay=0:0"))
check('内阴影：链上不再走 gblur（落差已烘进 PNG，再糊就淡到看不见）',
  !renderSrc.includes('ism\'}]format=gray'))
check('描边：所有环从**同一份原始 alpha** split 出来（不是接着上一圈的结果）',
  renderSrc.includes('alphaextract,format=gray,split=${strokeRings.length}'))
check('遮罩图缓存键带版本号（否则改了生成方式还在用 %TEMP% 里的旧图）',
  renderSrc.includes('MASK_VERSION') && renderSrc.includes('${MASK_VERSION}|dash|'))
const stageSrc = read('packages/desktop/src/renderer/components/Stage.jsx')
check('预览：内阴影是**叠在画面之上**的独立层（box-shadow:inset 会被不透明视频帧盖住）',
  stageSrc.includes('canvas-inset') && stageSrc.includes('data-fx-inset'))
check('预览：虚线框用显式 dash/gap 的渐变，不用浏览器自带的 dashed 边框',
  stageSrc.includes('dashCss.style'))
const effectsSrc = read('packages/desktop/src/shared/effects.js')
check('虚线表达式带括号（少了括号 `*` 只绑定后一项，上边会恒亮成实线）',
  effectsSrc.includes('(lt(Y,${lw})+gte(Y,${H - lw}))'))

console.log('')
if (failures.length) {
  console.log('失败项：')
  for (const item of failures) console.log('  · ' + item)
}
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (!fail) console.log('FXSTYLE_OK')
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch {
  /* 删不掉就留着 */
}
process.exit(fail ? 1 : 0)
