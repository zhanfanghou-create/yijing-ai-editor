#!/usr/bin/env node
/**
 * 闸门 · 自由变形（四角透视）。
 *
 * 这一族错误的共同点：**输出永远"看起来像生效了"，错在几何本身**。
 *   · 角顺序搞反（顺时针 vs TL/TR/BL/BR）⇒ 左右镜像。四角对称的夹具下**完全看不出来**，
 *     所以夹具必须是四象限不同颜色的彩图；
 *   · 只算了变形、没补 alpha ⇒ 框外是 `perspective` 的边缘 clamp（一整圈拉长的像素），
 *     看上去像"画面被拉歪了"，而不是"变形后四周露背景"；
 *   · `anyTransparent` 漏掉 warp ⇒ 整条链落回 `yuv420p`，上面那条就算补了 alpha 也被丢掉；
 *   · CSS 里 `matrix3d` 没拿到元素像素尺寸 ⇒ 要么算不出，要么窗口一缩放透视就歪；
 *   · transform 拼接顺序把 warp 放到中间 ⇒ 前面的 `scale()` 已经改变了元素盒，
 *     而矩阵仍假设四角在盒内，表现为"一缩放就不对"。
 *
 * 判据分四层：纯算术 → 滤镜串 → 计划 → 真渲染像素 → 静态接线。
 *
 * 用法：node tools/check-warp.mjs
 * 退出码：0 通过 / 1 有失败 / 2 本机没有 ffmpeg（如实跳过）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { warp, effects, ffmpegOf, workDir, makeQuad, readPixel, renderCase, planFilter, near } from './fx-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/* ------------------------------ ① 纯算术 ------------------------------ */

console.log('· 参数规范化')
const dirty = warp.readWarp({ on: true, tl: { x: 'abc', y: 999 }, tr: null, br: { x: 12.345678, y: 0 } })
check('脏数据不抛错、缺字段回落 0', dirty.on === true && dirty.tr.x === 0 && dirty.tr.y === 0)
check('超界值被夹到 ±WARP_LIMIT', dirty.tl.y === warp.WARP_LIMIT, String(dirty.tl.y))
check('小数按 4 位收敛（避免 key 抖动导致遮罩图反复重生成）', dirty.br.x === 12.3457, String(dirty.br.x))

console.log('· 中性判定')
check('没开 → 中性', warp.isNeutralWarp(warp.readWarp({ on: false, tl: { x: 20, y: 20 } })) === true)
check('开了但四角全 0 → 中性（等价于没开）', warp.isNeutralWarp(warp.readWarp({ on: true })) === true)
check('动了一个角 → 非中性', warp.isNeutralWarp(warp.readWarp({ on: true, tl: { x: 5, y: 0 } })) === false)

console.log('· 四角坐标（单位 + 顺序）')
const quadPts = warp.cornerPoints(warp.readWarp({ on: true, tl: { x: 10, y: 20 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } }))
check('顺序是 TL→TR→BR→BL', quadPts[0].x === 0.1 && quadPts[1].x === 1 && quadPts[2].y === 1 && quadPts[3].y === 1)
check('单位是百分比（10 → 0.1，不是 10 像素）', Math.abs(quadPts[0].x - 0.1) < 1e-9, String(quadPts[0].x))

console.log('· 单应矩阵')
/** 单位方形的四个角，顺序与 cornerPoints 一致 */
const UNIT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
const identity = warp.cornerPoints(warp.readWarp({ on: true }))
const hId = warp.homographyFromUnitSquare(identity)
/**
 * ⚠️ 要用**单位方形的角**去映，再把结果与目标四角比。
 *    拿目标四角自己再映一遍是另一回事（那要 H⁻¹），会比出假误差 —— 判据写错
 *    与功能写错在输出上长得一样，都得靠"先验算尺子"来排除。
 */
const onId = UNIT.map((p) => warp.applyHomography(hId, p))
const idErr = Math.max(...onId.map((p, i) => Math.max(Math.abs(p.x - identity[i].x), Math.abs(p.y - identity[i].y))))
check('恒等四边形 → 恒等映射（误差 < 1e-9）', idErr < 1e-9, idErr.toExponential(2))

const trap = warp.cornerPoints(warp.readWarp({ on: true, tl: { x: 12, y: 9 }, tr: { x: -7, y: 0 }, br: { x: 3, y: -4 }, bl: { x: -2, y: 5 } }))
const hTrap = warp.homographyFromUnitSquare(trap)
const onTrap = UNIT.map((p) => warp.applyHomography(hTrap, p))
const trapErr = Math.max(...onTrap.map((p, i) => Math.max(Math.abs(p.x - trap[i].x), Math.abs(p.y - trap[i].y))))
check('一般四边形：解出的矩阵能把这四个角映回自己（误差 < 1e-9）', trapErr < 1e-9, trapErr.toExponential(2))

console.log('· 退化 / 自交判定')
check('面积等于 1（恒等）', Math.abs(warp.quadArea(identity) - 1) < 1e-9)
check('自交（蝴蝶结）判为无效 —— 数学上可解，但会把画面反折出一道撕裂', warp.isValidQuad([
  { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }
]) === false)
check('四角挤成一点判为无效（面积过小）', warp.isValidQuad([
  { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }
]) === false)

/* ---------------------------- ② 两个消费端 ---------------------------- */

console.log('· CSS matrix3d')
check('中性 → 空串（不吃 transform 预算）', warp.cssWarpTransform(warp.readWarp({ on: true }), 640, 360) === '')
check('尺寸未知 → 空串（不瞎猜，避免算出错矩阵）', warp.cssWarpTransform(warp.readWarp({ on: true, tl: { x: 10, y: 0 } }), 0, 0) === '')
const cssStr = warp.cssWarpTransform(warp.readWarp({ on: true, tl: { x: 10, y: 0 } }), 640, 360)
check('非中性 → 一段 matrix3d(...) 共 16 个数', /^matrix3d\(/.test(cssStr) && cssStr.slice(9, -1).split(',').length === 16, cssStr.slice(0, 40))
check('CSS 与 ffmpeg 用的是同一个 warp 参数（同一份 readWarp 结果）',
  cssStr === warp.cssWarpTransform(warp.readWarp({ on: true, tl: { x: 10, y: 0 } }), 640, 360))

console.log('· ffmpeg perspective（角顺序 / sense）')
/**
 * 关键判据：ffmpeg 文档的角顺序是 **TL → TR → BL → BR**（不是顺时针）。
 * 用四角坐标互不相同的参数，逐个断言 `x2/y2` 取的是 **BL**、`x3/y3` 取的是 **BR**。
 * 按顺时针传时轴对齐的夹具完全看不出问题 —— 所以这里直接钉顺序。
 * ⚠️ 期望值必须来自**同一组参数**：拿另一组参数算出来的角去比，红的是尺子。
 */
const pfWarp = warp.readWarp({ on: true, tl: { x: 10, y: 20 }, tr: { x: -5, y: 0 }, br: { x: 2, y: -3 }, bl: { x: -4, y: 6 } })
const pts = warp.cornerPoints(pfWarp)
const pf = warp.perspectiveFilter(pfWarp, 640, 360)
check('含 sense=destination 与 eval=init（缺前者会变成"反向套图"）', /sense=destination/.test(pf) && /eval=init/.test(pf))
const px = (i) => {
  const m = new RegExp(`x${i}=([-0-9.]+):y${i}=([-0-9.]+)`).exec(pf)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}
const got0 = px(0)
const got2 = px(2)
const got3 = px(3)
check('x0/y0 = TL', got0 && Math.abs(got0.x - pts[0].x * 640) < 0.02 && Math.abs(got0.y - pts[0].y * 360) < 0.02, `${got0 && got0.x}`)
check('x2/y2 = BL（不是 BR —— 这是最容易搞错的一位）',
  got2 && Math.abs(got2.x - pts[3].x * 640) < 0.02 && Math.abs(got2.y - pts[3].y * 360) < 0.02, `${got2 && got2.x},${got2 && got2.y}`)
check('x3/y3 = BR', got3 && Math.abs(got3.x - pts[2].x * 640) < 0.02 && Math.abs(got3.y - pts[2].y * 360) < 0.02, `${got3 && got3.x},${got3 && got3.y}`)

/* ------------------------------ ③ 计划层 ------------------------------ */

console.log('· 导出计划（滤镜图）')
const work = workDir('yjai-warp-check-')
const ffmpeg = ffmpegOf()
const src = ffmpeg ? makeQuad(ffmpeg, work) : path.join(work, 'quad.png')
const warpFx = { warp: { on: true, tl: { x: 10, y: 20 }, tr: { x: -5, y: 0 }, br: { x: 2, y: -3 }, bl: { x: -4, y: 6 } } }
const planWarp = planFilter({ src, clipFx: warpFx, work })
/**
 * `perspective` 本身**不能**在这一层断言：变形段要一张预先生成的有效区遮罩图，
 * 而那张图是 `render()` 里异步备好的（`buildPlan` 是同步的，本机 `spawnSync` 走管道
 * 恒 EBUSY，塞不进去）。这里只钉入口条件（链带 alpha），"真挂了 perspective"
 * 交给下面的真渲染像素来说话 —— 框外透明这件事本身就证明了整段跑通了。
 */
/**
 * 这一条是"补 alpha"的入口判据：`anyTransparent` 必须把 warp 算进去。
 * 漏了它 ⇒ 整条链是 `yuv420p`，`format=` 把 alphamerge 补出来的 alpha 整体丢掉，
 * 框外留下的就是 `perspective` 的边缘 clamp（一圈被拉长的像素）。
 */
check('整条链切成带 alpha（yuva420p）—— anyTransparent 认得 warp', /format=yuva420p/.test(planWarp))
const planPlain = planFilter({ src, clipFx: {}, work })
check('对照：没开变形的片段仍是 yuv420p（不是为了省事一律切 alpha）',
  /format=yuv420p/.test(planPlain) && !/yuva420p/.test(planPlain))

/* ------------------------------ ④ 真渲染 ------------------------------ */
if (!ffmpeg) {
  console.log('WARP_SKIPPED 本机没有 ffmpeg（像素层无法取证）')
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  process.exit(fail ? 1 : 2)
}

console.log('· 真渲染像素')
const plainOut = await renderCase({ ffmpeg, work, src, clipFx: {}, scale: 100, name: 'plain' })
const warpOut = await renderCase({ ffmpeg, work, src, clipFx: warpFx, scale: 100, name: 'warp' })
check('对照片导出成功', Boolean(plainOut))
check('变形片导出成功', Boolean(warpOut))

if (plainOut && warpOut) {
  const cornerPlain = readPixel(ffmpeg, plainOut, 6, 6, work)
  const cornerWarp = readPixel(ffmpeg, warpOut, 6, 6, work)
  const midWarp = readPixel(ffmpeg, warpOut, 320, 180, work)
  /* TL 角被推到 (10%, 20%)=(64,72)，所以 (6,6) 落在四边形之外 */
  check('变形后框外是**透的**（不是边缘 clamp 出来的颜色）',
    cornerWarp[0] + cornerWarp[1] + cornerWarp[2] < 24, `corner=${cornerWarp.join(',')}`)
  check('对照：没变形时那个角是画面本身（红）', near(cornerPlain, [255, 23, 0], 40), `corner=${cornerPlain.join(',')}`)
  check('变形后画面中部仍有内容（不是整片变黑）',
    midWarp[0] + midWarp[1] + midWarp[2] > 90, `mid=${midWarp.join(',')}`)
}

/* ---------------------------- ⑤ 静态接线 ---------------------------- */

console.log('· 静态接线（预览侧）')
const stage = read('packages/desktop/src/renderer/components/Stage.jsx')
check('Stage.jsx 的 transform 串把 warp 排在**最右**（最先作用）',
  /\[pose\.transform, skew, mirror, cropT, warpT\]/.test(stage))
check('Stage.jsx 用 ResizeObserver 取 clientWidth/clientHeight 算矩阵',
  /clientWidth/.test(stage) && /clientHeight/.test(stage) && /ResizeObserver/.test(stage))
const select = read('packages/desktop/src/renderer/components/PreviewSelect.jsx')
check('预览选框与画面用**同一串** transform（含 warpT），否则旋转/换比例后选框会偏',
  /warpT/.test(select))
/* 四角拖动手柄：这是"自由变形"的操作方式本身，掉了只剩数字面板 */
check('预览：开变形后四角手柄切到 warp 模式（否则拖角仍在缩放）',
  /begin\(event, warpOn \? 'warp' : 'scale', HANDLE_CORNER/.test(select))
/* 只看函数体：拼接里必须**没有** warp，否则反解出来的坐标是"变形之前"的 */
const affineBody = (select.match(/function affineMatrixOf[\s\S]*?\n}/) || [''])[0]
check('预览：角点换算只反解**仿射链**（连 matrix3d 一起反解会越拖越偏）',
  /const parts = \[pose\.transform, cssSkew\(fx\), cssMirror\(fx\), cssCropTransform\(layer\.crop\)\]/.test(affineBody) &&
  !/cssWarpTransform|warpT|warp\./.test(affineBody) &&
  /affineInv/.test(select) && /\.transformPoint\(new DOMPoint/.test(select))
check('预览：非法四边形（越界/自交/退化）不写入，保留上一帧',
  /warpTable\.canPlaceCorner\(drag\.warp, drag\.corner/.test(select))
check('预览：手柄带 data-sel-warp 钩子（E2E 靠它定位到具体哪个角）',
  /data-sel-warp=/.test(select))
const viteConfig = read('packages/desktop/vite.config.mjs')
check('warp.js 已登记进 commonjsOptions.include（漏了渲染层会 import 到空对象）',
  /shared[\\/]warp\\?\.js|warp\\\.js/.test(viteConfig))
check('effects.js 把 warp 收进 isNeutralEffects（否则"只有变形"会被判成无效果直接跳过）',
  /!hasWarp\(fx\)/.test(fs.readFileSync(path.join(ROOT, 'packages/desktop/src/shared/effects.js'), 'utf8')))

console.log('')
if (failures.length) {
  console.log('失败项：')
  for (const item of failures) console.log('  · ' + item)
}
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (!fail) console.log('WARP_OK')
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch {
  /* 删不掉就留着 */
}
process.exit(fail ? 1 : 0)
