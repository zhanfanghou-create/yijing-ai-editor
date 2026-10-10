#!/usr/bin/env node
/**
 * 闸门 · 检查器（右栏）的效果真的生效。
 *
 * ---------------------------------------------------------------------------
 * 这道闸门要挡的是什么
 * ---------------------------------------------------------------------------
 * 右栏那些滑杆最容易被做成会动的装饰：位置、图标、数值全都对，
 * 拖下去**预览一个像素都不变**，导出成片也不变 —— 而构建不报错、静态扫描全绿、
 * 逐像素比对也看不出来（参考图里本来就是一排滑杆）。
 *
 * 它有三层，缺一层就有一种漏法：
 *   1. **换算同源**：同一组参数，预览（CSS）与导出（ffmpeg）必须给出同一个方向。
 *      两边各写一份迟早分叉，症状是"预览里变暖、成片里没变"。
 *   2. **判据可分辨**：上面每一条判据都要能被打脸（逐条扰动，各红在对的断言上）。
 *   3. **真机生效**：面板上拖一下，预览的 computed style 真的变、片段真的写回草稿。
 *      ⚠️ 判据读的是**消费端**（computed filter / SVG 矩阵 / 覆盖层字号 / 草稿落盘值），
 *      不读 data 属性本身 —— 属性改了画面没变，是另一种静默失效。
 *
 * ---------------------------------------------------------------------------
 * 真值（写死，不 import 被测代码）
 * ---------------------------------------------------------------------------
 *   · 亮度 50 → 通道增益 1.30（1 + 0.5 × 0.6）
 *   · 色温 +50 → 红 ×1.15、蓝 ×0.85；色温 -50 反向
 *   · 饱和度 +40 → 1.40
 *   · 磨皮 60 → CSS blur / ffmpeg smartblur，且画面按 1.02 保边放大
 *   · 位置 ±50% / 旋转 ±180°（越界必须夹取）
 *   · 字幕字号倍数 1.5 → 基号 40 → 60
 *
 * 用法：
 *   node tools/check-inspector-effects.mjs              # 真起 Electron 验证
 *   node tools/check-inspector-effects.mjs --selftest   # 只跑判据自证（秒级）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'

import adjustModule from '../packages/desktop/src/shared/adjust.js'
import textModule from '../packages/desktop/src/shared/textOverrides.js'
import fxModule from '../packages/desktop/src/shared/effects.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.insp-fx-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

const r4 = (value) => Number(Number(value).toFixed(4))

/* --------------------------------------------------------- 夹具 */

/** 1×1 透明 PNG —— 画中画那层只需要"有 url、能挂上去"，不关心像素内容 */
const PX_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const CLIPS = [
  {
    id: 'ifx_v',
    track: 'video',
    assetId: 'ifx_a1',
    name: '画面片段',
    kind: 'text',
    text: '画面',
    start: 0,
    duration: 6,
    offset: 0,
    sourceDuration: 6
  },
  {
    id: 'ifx_t',
    track: 'text',
    assetId: '',
    name: '字幕一',
    kind: 'text',
    text: '检查器字幕',
    textStyle: 'sub-plain',
    start: 0,
    duration: 4,
    offset: 0
  },
  {
    id: 'ifx_a',
    track: 'audio',
    assetId: 'ifx_a2',
    name: '配音甲',
    kind: 'text',
    text: '音频',
    start: 0,
    duration: 4,
    offset: 0
  },
  /**
   * 叠加轨（画中画）——**混合模式那节只在 overlay 轨上出现**（主画面底下没有东西可混），
   * 所以没有这一段就根本点不到混合按钮，那道断言会退化成"永远找不到元素"。
   * ⚠️ 必须带上真实 url：composite.js 对没有 url 的叠加片段会直接丢掉（`if (!url) return null`），
   *    层不会出现在画面上、混合自然无从谈起。
   */
  {
    id: 'ifx_o',
    track: 'overlay',
    assetId: 'ifx_a3',
    name: '画中画',
    kind: 'image',
    url: PX_PNG,
    start: 0,
    duration: 5,
    offset: 0,
    pip: { anchor: 'right-bottom', size: 30 }
  }
]

const ASSETS = [
  { id: 'ifx_a1', kind: 'text', name: '画面片段', text: '画面', url: '' },
  { id: 'ifx_a2', kind: 'text', name: '配音甲', text: '音频', url: '' },
  { id: 'ifx_a3', kind: 'image', name: '画中画', url: PX_PNG }
]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected）
 *  = 换算同源 8 条（调节/美颜/字幕）
 *  + 效果换算同源 10 条（effects.js：圆角/斜切/抠像/蒙版/混合/描边/阴影/关键帧/中性/xor 一致性）
 *  + 真机 22 条（原 11 中「四页签」已改成"整排页签 = 信息 + 画面/音频/变速/调整" 1
 *    + 效果面板 8
 *    + 右栏排版 3：「信息」横排且与「画面」同行 / 字幕片段[信息][字幕] / 点「字幕」真的换屏） */
const TOTAL_ASSERTIONS = 40

/* --------------------------------------------------------- 输出与收尾 */

let emitted = 0
let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  emitted += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`INSPECTOR_FX_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('INSPECTOR_FX_OK')
  return failures === 0 && !aborted
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    })
  ])
}

/** 收尾先礼后兵（裸 app.close() 在本机会永不返回） */
async function closeApp(app) {
  if (!app) return
  try {
    await withTimeout(app.close(), 8000, 'app.close')
    return
  } catch {
    /* 落到强杀 */
  }
  const pid = app.process()?.pid
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 进程可能已经退了 */
  }
  await sleep(500)
}

/* --------------------------------------------------------- 判据（纯函数） */

/**
 * 一组「换算同源」判据。**入参是可以被替换的模块**，所以自证时能把某一条
 * 换成坏实现，确认它真的会红 —— 判据本身不能被"永远通过"。
 */
function runMath(adj, txt) {
  const out = []
  const add = (name, ok, detail = '') => out.push({ name, ok, detail })
  const ff = (v) => adj.ffmpegFilterFor(v, null, r4, 1920)

  /* 1. 中性：三处都不许给画面添东西（添了就是"没调也变了色"） */
  add(
    '中性参数 · CSS / ffmpeg / 矩阵三处都是空',
    adj.cssFilterOps(null, null) === '' && ff(null) === '' && adj.gradeMatrix(null, null) === '',
    `css=${JSON.stringify(adj.cssFilterOps(null, null))} ff=${JSON.stringify(ff(null))}`
  )

  /* 2. 亮度 +50：预览的通道增益与导出的 colorchannelmixer 同向且都 >1 */
  const gBright = adj.channelGains({ bright: 50 }, null)
  const fBright = ff({ bright: 50 })
  add(
    '亮度 +50 · 预览(通道增益)与导出(colorchannelmixer)同向且都 >1',
    gBright.r > 1 && gBright.g > 1 && gBright.b > 1 && /colorchannelmixer=rr=1\.3/.test(fBright),
    `${JSON.stringify(gBright)} | ${fBright}`
  )

  /* 3. 色温 +50：红升蓝降；-50 反向 */
  const matrixWarm = adj.gradeMatrix({ temp: 50 }, null).split(' ')
  const fWarm = ff({ temp: 50 })
  const fCool = ff({ temp: -50 })
  add(
    '色温 · +50 红升蓝降、-50 反向，且与导出 colorchannelmixer 同一组数',
    Number(matrixWarm[0]) > 1 &&
      Number(matrixWarm[12]) < 1 &&
      /rr=1\.15/.test(fWarm) &&
      /bb=0\.85/.test(fWarm) &&
      /rr=0\.85/.test(fCool) &&
      /bb=1\.15/.test(fCool),
    `矩阵 r=${matrixWarm[0]} b=${matrixWarm[12]} | warm=${fWarm} cool=${fCool}`
  )

  /* 4. 饱和度 +40 → 两侧都 1.40 */
  add(
    '饱和度 +40 · 预览 saturate(1.4) 与导出 eq=saturation=1.4 一致',
    adj.cssFilterOps({ saturate: 40 }, null).includes('saturate(1.4)') && /saturation=1\.4/.test(ff({ saturate: 40 })),
    `${adj.cssFilterOps({ saturate: 40 }, null)} | ${ff({ saturate: 40 })}`
  )

  /* 5. 磨皮 60 → 两侧都有柔化，且保边放大系数一致（预览与成片同一帧） */
  const smoothPose = adj.poseStyle({ beauty: { smooth: 60 } })
  add(
    '磨皮 60 · 预览 blur + 导出 smartblur，且两侧都按 1.02 保边放大',
    adj.cssFilterOps(null, { smooth: 60 }).includes('blur(') &&
      /smartblur=luma_radius=/.test(adj.ffmpegFilterFor(null, { smooth: 60 }, r4, 1920)) &&
      adj.coverScale({ smooth: 60 }) === 1.02 &&
      String(smoothPose?.transform || '').includes('scale(1.02)'),
    `${adj.cssFilterOps(null, { smooth: 60 })} | ${String(smoothPose?.transform || '')}`
  )

  /* 6. 位置 / 旋转：整数的百分比与角度必须原样出现在 transform 里 */
  const pose = adj.poseStyle({ posX: 25, posY: -10, rotate: 30, scale: 100 })
  add(
    '位置 25 / -10、旋转 30° · 原样进 transform',
    String(pose?.transform || '').includes('translateX(25%)') &&
      String(pose?.transform || '').includes('translateY(-10%)') &&
      String(pose?.transform || '').includes('rotate(30deg)'),
    String(pose?.transform || '(无)')
  )

  /* 7. 越界必须夹取（夹不住就会"预览挪到画布外、成片只挪半张"） */
  const clamped = adj.poseStyle({ posX: 999, posY: -999, rotate: 999 })
  add(
    '越界夹取 · 位置夹到 ±50%、旋转夹到 ±180°',
    adj.POS_LIMIT === 50 &&
      adj.ROTATE_LIMIT === 180 &&
      String(clamped?.transform || '').includes('translateX(50%)') &&
      String(clamped?.transform || '').includes('translateY(-50%)') &&
      String(clamped?.transform || '').includes('rotate(180deg)'),
    String(clamped?.transform || '(无)')
  )

  /* 8. 字幕覆写：倍数 / 颜色 / 锚点 / 偏移，且**不许污染样式表那一项** */
  const base = { key: 'sub-plain', size: 40, color: '#FFFFFF', anchor: 'bottom', offset: 60 }
  const overridden = txt.applyTextOverrides(base, {
    textScale: 1.5,
    textColor: '#FF0000',
    textAnchor: 'top',
    textOffset: 120
  })
  add(
    '字幕覆写 · 字号 ×1.5 → 60、颜色 / 锚点 / 偏移生效，且原表不被就地改',
    overridden.size === 60 &&
      overridden.color === '#FF0000' &&
      overridden.anchor === 'top' &&
      overridden.offset === 120 &&
      base.size === 40 &&
      base.color === '#FFFFFF' &&
      base.anchor === 'bottom',
    JSON.stringify(overridden)
  )

  return out
}

/**
 * 一组「效果换算同源」判据（`shared/effects.js`：预览 CSS ↔ 导出 ffmpeg）。
 *
 * 与 runMath 同一形制：入参是**可替换的模块**，自证时能把某一条换成坏实现，
 * 确认它真的会红 —— 判据本身绝不允许"永远通过"。
 *
 * 真值全部**写死在这里**（不 import 被测代码的常量），否则代码一改判据跟着改，
 * 这道闸门就退化成复印机。
 */
function runMathFx(fx) {
  const out = []
  const add = (name, ok, detail = '') => out.push({ name, ok, detail })

  /* 1. 中性：八项换算必须全部为空（没调的时候一个像素都不许动） */
  const neutral = fx.readEffects(null)
  add(
    '效果中性 · 圆角/斜切/抠像/蒙版/混合/描边/阴影 七项换算全部为空',
    fx.isNeutralEffects(neutral) &&
      fx.cssRadius(neutral) === '' &&
      fx.cssSkew(neutral) === '' &&
      fx.colorkeyFor(neutral) === '' &&
      fx.maskExprFor(neutral) === '' &&
      fx.blendCss(neutral) === '' &&
      fx.blendFfmpeg(neutral) === '' &&
      fx.strokeShadows(neutral) === '' &&
      fx.shadowFilter(neutral) === '',
    `css radius=${JSON.stringify(fx.cssRadius(neutral))} key=${JSON.stringify(fx.colorkeyFor(neutral))}`
  )

  /* 2. 圆角 96：预览 5cqw（96/1920）与导出像素按**同一个比例**各自乘自己的宽度 */
  const rounded = fx.readEffects({ radius: 96 })
  add(
    '圆角 96 · 预览 5cqw（96/1920）与导出 radiusPx 等比（1920→96、960→48）',
    fx.cssRadius(rounded) === '5.0000cqw' && fx.radiusPx(rounded, 1920) === 96 && fx.radiusPx(rounded, 960) === 48,
    `${fx.cssRadius(rounded)} | 1920→${fx.radiusPx(rounded, 1920)} 960→${fx.radiusPx(rounded, 960)}`
  )

  /* 3. 斜切 45°：CSS 的角度与 ffmpeg 的 shear 是同一个线性变换（k = tan a） */
  const skewed = fx.readEffects({ skewX: 45 })
  add(
    '斜切 45° · 预览 skew(45deg) 与导出 shear=shx=tan45=1 同源（方向不许写反）',
    fx.cssSkew(skewed) === 'skew(45deg, 0deg)' && fx.shearFor(skewed) === 'shear=shx=1:shy=0:fillcolor=black@0',
    `${fx.cssSkew(skewed)} | ${fx.shearFor(skewed)}`
  )

  /* 4. 抠像：导出用 RGB 的 colorkey（与预览同空间）；预览的 alpha 行把键色通道压到负 */
  const keyed = fx.readEffects({ key: { on: true, color: '#00B140', similarity: 50 } })
  const row = fx.keyAlphaRow(keyed).split(' ').map(Number)
  add(
    '抠像 · 导出 colorkey=0x00b140:0.3:0.1；预览 alpha 行把绿系数压到 <0（键色才透明）',
    fx.colorkeyFor(keyed) === 'colorkey=0x00b140:0.3:0.1' &&
      row.length === 5 &&
      row[1] < 0 &&
      row[0] > 0 &&
      row[3] === 0 &&
      row[4] === 1,
    `${fx.colorkeyFor(keyed)} | row=${row.join(' ')}`
  )

  /* 5. 蒙版矩形：导出表达式只许用 geq 的 X/Y/W/H（写死像素数 ⇒ 画中画按错尺寸算） */
  const masked = fx.readEffects({ mask: { shape: 'rect', x: 50, y: 50, w: 40, h: 60, feather: 0 } })
  const expr = fx.maskExprFor(masked)
  add(
    '蒙版矩形 · 导出表达式只用 X/Y/W/H、以 if(...,255,0) 收口，且不含多余转义 `\\,`',
    /^if\(/.test(expr) && /gte\(X,W\*\(/.test(expr) && /H\*\(/.test(expr) && !expr.includes('\\,') && !/\d+px/.test(expr),
    expr.slice(0, 90)
  )

  /* 6. 圆角也会进**导出遮罩表达式**（与蒙版在同一个表达式里取交集，不能分两步 alphamerge） */
  const roundOnly = fx.readEffects({ radius: 96 })
  add(
    '圆角 96 · 导出遮罩表达式里出现半径项（hypot 到四角的距离 ≤ W*0.05）',
    /hypot\(/.test(fx.maskExprFor(roundOnly)) && /W\*\(0\.05\)/.test(fx.maskExprFor(roundOnly)),
    fx.maskExprFor(roundOnly).slice(0, 90)
  )

  /* 7. 混合：CSS 用连字符、ffmpeg 用下划线，映射表必须逐条对得上（写错 = 导出直接报错） */
  add(
    '混合映射 · 12 种模式 css/ffmpeg 名逐条对得上（hard-light ↔ hardlight）',
    fx.blendCss(fx.readEffects({ blend: 'hard-light' })) === 'hard-light' &&
      fx.blendFfmpeg(fx.readEffects({ blend: 'hard-light' })) === 'hardlight' &&
      fx.blendCss(fx.readEffects({ blend: 'color-dodge' })) === 'color-dodge' &&
      fx.blendFfmpeg(fx.readEffects({ blend: 'color-dodge' })) === 'color_dodge' &&
      fx.blendFfmpeg(fx.readEffects({ blend: 'normal' })) === '',
    `${fx.blendFfmpeg(fx.readEffects({ blend: 'hard-light' }))} / ${fx.blendFfmpeg(fx.readEffects({ blend: 'color-dodge' }))}`
  )

  /* 8. 描边：导出按"基准 1920 的比例"折成膨胀级数；预览是 8 向 drop-shadow */
  const stroked = fx.readEffects({ stroke: { on: true, width: 24, color: '#ff0000' } })
  const shadows = fx.strokeShadows(stroked).match(/drop-shadow\(/g) || []
  add(
    '描边 24 · 导出膨胀 24 级（1920 基宽）、960 时减半；预览是 8 向 drop-shadow 且带描边色',
    fx.strokeDilations(stroked, 1920) === 24 &&
      fx.strokeDilations(stroked, 960) === 12 &&
      shadows.length === 8 &&
      fx.strokeShadows(stroked).includes('#ff0000') &&
      fx.strokeLut(stroked) === 'r=255:g=0:b=0',
    `1920→${fx.strokeDilations(stroked, 1920)} 960→${fx.strokeDilations(stroked, 960)} 阴影 ${shadows.length} 向`
  )

  /* 9. 阴影：预览 blur 半径与导出 gblur 的 sigma 是 2:1（不是同一个量纲） */
  const shadowed = fx.readEffects({ shadow: { on: true, x: 16, y: 16, blur: 24, color: '#000000', opacity: 60 } })
  add(
    '阴影 24 · 预览 drop-shadow 的 blur=1.25cqw；导出 sigma = 半径的一半（24px/2=12）',
    fx.shadowFilter(shadowed).includes('drop-shadow(') &&
      fx.shadowFilter(shadowed).includes('1.2500cqw') &&
      fx.shadowSigma(shadowed, 1920) === 12 &&
      fx.shadowOffset(shadowed, 1920).x === 16,
    `${fx.shadowFilter(shadowed)} | σ=${fx.shadowSigma(shadowed, 1920)}`
  )

  /* 10. 关键帧：预览与导出共用同一个插值（线性 + 两端夹取）；没有关键帧时回落到静态值 */
  const kf = fx.readKeyframes({ posX: [{ t: 2, v: 40 }, { t: 0, v: 0 }], scale: [{ t: 0, v: 100 }] })
  add(
    '关键帧 · 线性插值 t=1→20、两端夹取（t=-1→0 / t=9→40）、没打的属性回落静态值',
    fx.keyframeValue(kf, 'posX', 1, 0) === 20 &&
      fx.keyframeValue(kf, 'posX', -1, 0) === 0 &&
      fx.keyframeValue(kf, 'posX', 9, 0) === 40 &&
      fx.keyframeValue(kf, 'opacity', 1, 100) === 100 &&
      fx.hasKeyframes(kf) === true,
    `t1=${fx.keyframeValue(kf, 'posX', 1, 0)} t9=${fx.keyframeValue(kf, 'posX', 9, 0)}`
  )

  return out
}

/* --------------------------------------------------------- 自证 */

function selftest() {
  console.log('=== 检查器效果判据自证（正控制组 + 逐条扰动）===\n')
  emitted = 0
  failures = 0

  const baseAdjust = { ...adjustModule }
  const baseText = { ...textModule }
  const baseFx = { ...fxModule }
  const green = runMath(baseAdjust, baseText)
  check(
    '正控制组 · 全部判据通过（判据不是恒红）',
    green.every((item) => item.ok),
    green.filter((item) => !item.ok).map((item) => item.name).join(' / ') || '全绿'
  )
  const greenFx = runMathFx(baseFx)
  check(
    '正控制组 · 效果换算判据全部通过（判据不是恒红）',
    greenFx.every((item) => item.ok),
    greenFx.filter((item) => !item.ok).map((item) => item.name).join(' / ') || '全绿'
  )

  const pick = (list, keyword) => list.find((item) => item.name.includes(keyword))
  const perturb = (label, mods, keyword) => {
    const list = runMath({ ...baseAdjust, ...mods.adj }, { ...baseText, ...mods.txt })
    const target = pick(list, keyword)
    check(`扰动 · ${label} → 红在「${keyword}」那条（且不只它红）`, Boolean(target) && !target.ok, target ? `ok=${target.ok}` : '找不到那条断言')
  }
  const perturbFx = (label, mod, keyword) => {
    const list = runMathFx({ ...baseFx, ...mod })
    const target = pick(list, keyword)
    check(`扰动 · ${label} → 红在「${keyword}」那条（且不只它红）`, Boolean(target) && !target.ok, target ? `ok=${target.ok}` : '找不到那条断言')
  }

  perturb('预览侧的 CSS 恒为空（滑杆拖了画面不变）', { adj: { cssFilterOps: () => '' } }, '饱和度')
  perturb('导出侧的滤镜串恒为空（预览变了、成片不变）', { adj: { ffmpegFilterFor: () => '' } }, '亮度')
  perturb('位置丢掉 translateX（位置滑杆变装饰）', { adj: { poseStyle: () => ({ transform: 'scale(1)' }) } }, '位置 25')
  perturb('中性参数也硬塞一个矩阵（没调也变色）', { adj: { gradeMatrix: () => '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0' } }, '中性参数')
  perturb('字幕覆写不乘字号倍数', { txt: { applyTextOverrides: (def) => ({ ...def }) } }, '字幕覆写')
  perturbFx('中性参数也硬塞一个圆角（没调画面也变了）', { cssRadius: () => '5.0000cqw' }, '效果中性')
  perturbFx('圆角两侧用了不同的比例（预览 5cqw、导出却是别的数）', { radiusPx: (f) => Math.round((f?.radius ?? 0) * 2) }, '圆角 96')
  perturbFx('斜切方向写反（预览往左上、成片往右下）', { shearFor: () => 'shear=shx=-1:shy=0:fillcolor=black@0' }, '斜切 45')
  perturbFx('抠像导出用 YUV 的 chromakey 口径（与预览不同空间）', { colorkeyFor: () => 'chromakey=0x00b140:0.3:0.1' }, '抠像 ·')
  perturbFx('蒙版表达式退回逐像素 geq（画中画尺寸算不出来）', { maskExprFor: () => "if(gte(X,60),255,0)" }, '蒙版矩形')
  perturbFx('混合模式映射表只留 css 名（ffmpeg 直接报 Invalid blend mode）', { blendFfmpeg: () => 'hard-light' }, '混合映射')
  perturbFx('描边不按基准宽度折算（换分辨率描边就粗细失控）', { strokeDilations: () => 8 }, '描边 24')
  perturbFx('阴影的 sigma 与 blur 用同一量纲（成片阴影比预览大一倍）', { shadowSigma: (f) => f?.shadow?.blur ?? 0 }, '阴影 24')
  perturbFx('关键帧不做两端夹取（片段尾部取值跳到别处）', { keyframeValue: (k, p, t, fb) => (k?.[p]?.length ? k[p][k[p].length - 1].v : fb) }, '关键帧')

  console.log(`\n=== 结果：通过 ${emitted - failures} 项 / 失败 ${failures} 项 ===`)
  console.log(`INSPECTOR_FX_SELFTEST_STATS total=${emitted} pass=${emitted - failures} fail=${failures}`)
  if (!failures) console.log('INSPECTOR_FX_SELFTEST_OK')
}

/* --------------------------------------------------------- 真机 */

/** 面板上的滑杆：按 label 找那一行，再用**原生 setter + input 事件**改值
 *  （React 的 value tracker 只认这种方式，直接改 .value 它看不到） */
async function setRange(page, labelText, value) {
  return page.evaluate(
    ({ labelText, value }) => {
      const row = Array.from(document.querySelectorAll('.wb-inspbody .slider-row')).find((item) =>
        String(item.querySelector('label')?.textContent || '').startsWith(labelText)
      )
      const input = row?.querySelector('input[type=range]')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    { labelText, value }
  )
}

const readLayerFilter = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.canvas-layer')
    return el ? getComputedStyle(el).filter : ''
  })

const readGradeMatrix = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.canvas-grade-defs feColorMatrix')
    return el ? el.getAttribute('values') || '' : ''
  })

/** 数字输入框（斜切那类）：填值后按 Enter 提交（NumField 走 onKeyDown/blur 提交） */
async function setNum(page, hook, value) {
  const input = page.locator(`[data-insp-num="${hook}"]`)
  await input.fill(String(value))
  await input.press('Enter')
  return true
}

async function main() {
  console.log('=== 检查器效果闸门（真启 Electron + 真拖滑杆 + 真读渲染）===\n')

  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, `找不到 ${EXE}`)
    aborted = 'electron 不存在'
    return summary()
  }
  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 已构建 dist-renderer', false, '先跑 vite build')
    aborted = '没有构建产物'
    return summary()
  }

  /* 先跑换算判据：它们不依赖机器，先红先知道 */
  console.log('-- 一、换算同源（预览 CSS ↔ 导出 ffmpeg）--\n')
  for (const item of runMath(adjustModule, textModule)) check(item.name, item.ok, item.detail)
  for (const item of runMathFx(fxModule)) check(item.name, item.ok, item.detail)

  const pageErrors = []
  let app = null

  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })
    const page = await app.firstWindow()
    page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
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

    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: 'E2E 检查器效果',
      data: { clips: CLIPS, assets: ASSETS, playhead: 1.5, volume: 80, zoom: 1 }
    })
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(800)
    await resize()

    console.log('\n-- 二、检查器结构 --\n')

    await page.locator('.clip[data-clip="ifx_v"]').click()
    await page.waitForSelector('.wb-info-body', { timeout: 10000 })
    await sleep(400)

    const tabs = await page.locator('[data-insp-tab]').evaluateAll((list) =>
      list.map((el) => el.getAttribute('data-insp-tab'))
    )
    check(
      '选中画面片段 · 右栏一排页签 = 信息 + 画面/音频/变速/调整（信息在首位，分类紧随其后）',
      tabs.join(',') === 'info,visual,audio,speed,adjust',
      tabs.join(',') || '(一个都没有)'
    )

    /* 排版判据：「信息」必须**横排**、且与「画面」同处一行。
       ⚠️ 从前它被 `.wb-colhead button`（后代选择器，特异性压过 .wb-coltab）
          压成 24×24 ⇒「信息」两个字换行成竖排；而「画面/音频/…」画在片段信息
          **下面**另起一行。两处都是"看着不像页签"，这里用矩形量出来。 */
    const tabRow = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { w: r.width, h: r.height, top: r.top, wrapped: el.scrollWidth > el.clientWidth + 1 }
      }
      const info = box('[data-insp-tab="info"]')
      const visual = box('[data-insp-tab="visual"]')
      return {
        infoW: info ? info.w : 0,
        infoH: info ? info.h : 0,
        wrapped: info ? info.wrapped : true,
        sameTop: Boolean(info && visual) && Math.abs(info.top - visual.top) < 1.5
      }
    })
    check(
      '右栏一排页签：「信息」横排（不是被压成竖排）且与「画面」同一行',
      tabRow.infoW >= 44 && tabRow.infoH >= 30 && !tabRow.wrapped && tabRow.sameTop,
      `信息 ${tabRow.infoW.toFixed(1)}×${tabRow.infoH.toFixed(1)} 换行=${tabRow.wrapped} 与画面同行=${tabRow.sameTop}`
    )

    console.log('\n-- 三、调节真的改预览 --\n')

    await page.locator('[data-insp-tab="adjust"]').click()
    await sleep(300)

    const filterBefore = await readLayerFilter(page)
    const matrixBefore = await readGradeMatrix(page)

    await setRange(page, '亮度', 40)
    await sleep(400)
    const filterAfter = await readLayerFilter(page)
    const matrixAfter = await readGradeMatrix(page)

    check(
      '拖「亮度」· 画面层的 computed filter 从空变为挂着逐通道增益矩阵',
      !filterBefore.includes('yjai-grade') && filterAfter.includes('yjai-grade'),
      `${filterBefore || '(空)'} → ${filterAfter || '(空)'}`
    )
    check(
      '拖「亮度」· 矩阵的红通道增益真的 >1（不是只挂了个壳）',
      Number(matrixAfter.split(' ')[0]) > 1,
      `values[0]=${matrixAfter.split(' ')[0] ?? '(无矩阵)'}`
    )

    await setRange(page, '色温', 60)
    await sleep(400)
    const matrixWarm = await readGradeMatrix(page)
    check(
      '拖「色温」· 红增益继续变大（色温滑杆真的接到矩阵上）',
      Number(matrixWarm.split(' ')[0]) > Number(matrixAfter.split(' ')[0]),
      `${matrixAfter.split(' ')[0]} → ${matrixWarm.split(' ')[0]}`
    )
    check(
      '拖「色温」· 蓝增益 < 红增益（暖色是红升蓝降，不是整体提亮）',
      Number(matrixWarm.split(' ')[12]) < Number(matrixWarm.split(' ')[0]),
      `r=${matrixWarm.split(' ')[0]} b=${matrixWarm.split(' ')[12]}`
    )

    console.log('\n-- 四、美颜真的改预览 --\n')

    await page.locator('[data-insp-tab="visual"]').click()
    await sleep(250)
    await page.locator('[data-insp-subpill="beauty"]').click()
    await sleep(250)
    await setRange(page, '磨皮', 60)
    await sleep(400)
    /* 判据不能只看"有没有 blur(" —— 挂一个 0.01px 的 blur 也算有。
       要量**半径占画面宽度的比例**：导出侧按同一个比例换算成像素，
       比例对不上就是"预览里磨皮等于没开、成片里磨得挺明显"。 */
    const blurInfo = await page.evaluate(() => {
      const layer = document.querySelector('.canvas-layer')
      const frame = document.querySelector('.canvas-frame')
      if (!layer || !frame) return null
      const filter = getComputedStyle(layer).filter || ''
      const hit = /blur\(([\d.]+)px\)/.exec(filter)
      return { filter, blur: hit ? Number(hit[1]) : 0, width: frame.getBoundingClientRect().width }
    })
    check(
      '拖「磨皮」· 画面层的 filter 里出现 blur（柔化真的挂上去了）',
      Boolean(blurInfo) && blurInfo.filter.includes('blur('),
      blurInfo?.filter || '(空)'
    )
    const blurRatio = blurInfo && blurInfo.width > 0 ? blurInfo.blur / blurInfo.width : 0
    check(
      '磨皮 60 · 模糊半径 ≈ 画面宽度的 0.3%（与导出同一个比例，不是 0.01px 的装饰）',
      Math.abs(blurRatio - 0.003) < 0.0008,
      `${blurInfo?.blur?.toFixed(3) ?? '?'}px / ${blurInfo?.width?.toFixed(0) ?? '?'}px = ${(blurRatio * 100).toFixed(3)}%`
    )

    console.log('\n-- 五、面板改的东西真的写回片段 --\n')

    await page.locator('[data-insp-tab="audio"]').click()
    await sleep(250)
    await setRange(page, '淡入时长', 2)
    /* 自动保存有 1.2s 防抖 —— 等够再读，否则读到的是旧值（会误判成"没写回"） */
    await sleep(2200)
    const fadeIn = await page.evaluate(
      (id) => window.yjai.draft.load(id).then((r) => Number((r?.data?.clips || []).find((c) => c.track === 'video')?.fadeIn || 0)),
      saved?.id || ''
    )
    check('拖「淡入时长」· 片段落到草稿里 fadeIn=2（导出载荷就是从片段来的）', Math.abs(fadeIn - 2) < 0.01, `fadeIn=${fadeIn}`)

    console.log('\n-- 六、字幕覆写真的改预览 --\n')

    await page.locator('.clip[data-clip]', { hasText: '字幕一' }).first().click()
    await sleep(500)

    /* 字幕片段：右栏顶部 = [信息][字幕] 两枚同级页签 */
    const infoTabsText = await page.locator('[data-info-tab]').evaluateAll((list) =>
      list.map((el) => el.getAttribute('data-info-tab'))
    )
    check(
      '选中字幕片段 · 右栏顶部是 [信息][字幕] 两枚同级页签（字幕紧跟信息后面）',
      infoTabsText.join(',') === 'info,text',
      infoTabsText.join(',') || '(没有页签)'
    )

    /* 先确认默认停在「信息」（片段头在场、样式控件不在），再点「字幕」换屏。
       判据用「删除片段」按钮的有无，而不是数 `.wb-field` 的个数 ——
       后者会把别处同名的行也算进来（实测 8→6，根本分不清是哪一屏的数）。 */
    const beforeSwitch = await page.evaluate(() => ({
      head: Boolean(document.querySelector('[data-remove-clip]')),
      style: Boolean(document.querySelector('[data-insp-textstyle]'))
    }))
    await page.locator('[data-info-tab="text"]').click()
    await sleep(400)
    const afterSwitch = await page.evaluate(() => ({
      head: Boolean(document.querySelector('[data-remove-clip]')),
      style: Boolean(document.querySelector('[data-insp-textstyle]'))
    }))
    check(
      '点「字幕」· 面板从片段头切到字幕样式（片段头收起、样式控件出现）',
      beforeSwitch.head === true &&
        beforeSwitch.style === false &&
        afterSwitch.head === false &&
        afterSwitch.style === true,
      `片段头 ${beforeSwitch.head}→${afterSwitch.head}；样式控件 ${beforeSwitch.style}→${afterSwitch.style}`
    )

    const fontBefore = await page.evaluate(() => {
      const el = document.querySelector('.canvas-overlay span')
      return el ? Number.parseFloat(getComputedStyle(el).fontSize) : 0
    })
    await setRange(page, '字号', 2)
    await sleep(450)
    const fontAfter = await page.evaluate(() => {
      const el = document.querySelector('.canvas-overlay span')
      return el ? Number.parseFloat(getComputedStyle(el).fontSize) : 0
    })
    check(
      '拖「字号」· 预览里这条字幕的 computed font-size 真的变大',
      fontBefore > 0 && fontAfter > fontBefore * 1.5,
      `${fontBefore.toFixed(2)}px → ${fontAfter.toFixed(2)}px`
    )

    console.log('\n-- 七、效果面板（圆角 / 斜切 / 抠像 / 蒙版 / 描边 / 阴影）真的改预览 --\n')

    await page.locator('.clip[data-clip="ifx_v"]').click()
    await page.waitForSelector('.wb-info-body', { timeout: 10000 })
    await page.locator('[data-insp-tab="visual"]').click()
    await sleep(350)
    await page.locator('[data-insp-subpill="base"]').click()
    await sleep(250)

    const subs = await page.locator('[data-insp-subpill]').evaluateAll((list) =>
      list.map((el) => el.getAttribute('data-insp-subpill'))
    )
    check(
      '画面页四个子页签（基础 / 抠像 / 蒙版 / 美颜美体）',
      subs.join(',') === 'base,key,mask,beauty',
      subs.join(',') || '(一个都没有)'
    )

    /* 画面层与剪裁盒的读数 —— 一律**限定在这一个片段**的层上：
       夹具里还有画中画那一层，`document.querySelector('.canvas-layer')` 会拿到谁是不确定的。 */
    const readFx = (id) =>
      page.evaluate((layerId) => {
        const layer = document.querySelector(`.canvas-layer[data-layer="${layerId}"]`)
        if (!layer) return null
        const box = layer.querySelector('.canvas-clipbox')
        const frame = document.querySelector('.canvas-frame')
        const cs = getComputedStyle(layer)
        const bcs = box ? getComputedStyle(box) : null
        /* 位置 / 缩放 / 旋转 / 斜切挂在**媒体元素**上（层上只有 filter 与混合模式），
           文字类片段的那一层是 `.canvas-placeholder`。 */
        const media = layer.querySelector('img, video, .canvas-placeholder')
        return {
          filter: cs.filter || '',
          transform: media ? getComputedStyle(media).transform : '',
          boxRadius: bcs ? parseFloat(bcs.borderTopLeftRadius) || 0 : 0,
          boxMask: bcs ? bcs.maskImage || bcs.webkitMaskImage || '' : '',
          boxMaskComposite: bcs ? bcs.maskComposite || bcs.webkitMaskComposite || '' : '',
          frameWidth: frame ? frame.getBoundingClientRect().width : 0,
          hasBox: Boolean(box),
          keyMatrix: Boolean(document.querySelector(`#yjai-key-${layerId} feColorMatrix`)),
          keyValues: document.querySelector(`#yjai-key-${layerId} feColorMatrix`)?.getAttribute('values') || ''
        }
      }, id)

    /* 1) 圆角 → 里层剪裁盒 + border-radius（按画面宽度的比例，不是随手一个 px） */
    await setRange(page, '圆角', 120)
    await sleep(420)
    const afterRadius = await readFx('ifx_v')
    const radiusRatio = afterRadius && afterRadius.frameWidth > 0 ? afterRadius.boxRadius / afterRadius.frameWidth : 0
    check(
      '拖「圆角」· 画面层里出现剪裁盒，且圆角半径 ≈ 画面宽度的 6.25%（120/1920）',
      Boolean(afterRadius) && afterRadius.hasBox && Math.abs(radiusRatio - 0.0625) < 0.005,
      `${afterRadius?.boxRadius?.toFixed(1) ?? '?'}px / ${afterRadius?.frameWidth?.toFixed(0) ?? '?'}px = ${(radiusRatio * 100).toFixed(2)}%`
    )

    /* 2) 斜切 → 层上的 transform 真的带 skew */
    await setNum(page, 'fx-skewx', 20)
    await sleep(420)
    const afterSkew = await readFx('ifx_v')
    check(
      '填「斜切 X = 20°」· 画面层的 computed transform 里出现 skew（矩阵不是单位阵）',
      Boolean(afterSkew) && afterSkew.transform !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(afterSkew.transform),
      afterSkew?.transform || '(none)'
    )

    /* 3) 抠像 → 生成 `#yjai-key-<id>` 的 feColorMatrix，且绿通道系数 < 0 */
    await page.locator('[data-insp-subpill="key"]').click()
    await sleep(250)
    await page.locator('[data-fx-toggle="key"]').click()
    await sleep(420)
    const afterKey = await readFx('ifx_v')
    const keyRow = (afterKey?.keyValues || '').trim().split(/\s+/).map(Number)
    check(
      '开「抠像·绿幕」· 预览生成 yjai-key 矩阵，且 alpha 行的绿系数 < 0（键色才被抠掉）',
      Boolean(afterKey) && afterKey.keyMatrix && keyRow.length === 20 && Number(keyRow[16]) < 0,
      `values[16]=${keyRow[16] ?? '(无矩阵)'}`
    )

    /* 4) 蒙版 → 剪裁盒上真的挂了 mask-image 渐变 */
    await page.locator('[data-insp-subpill="mask"]').click()
    await sleep(250)
    await page.locator('[data-fx-mask-shape="rect"]').click()
    await sleep(420)
    const afterMask = await readFx('ifx_v')
    check(
      '点「蒙版·矩形」· 剪裁盒的 computed mask-image 变成两条线性渐变，且 mask-composite 是 intersect',
      Boolean(afterMask) &&
        afterMask.boxMask.includes('linear-gradient') &&
        /intersect/.test(afterMask.boxMaskComposite),
      `${(afterMask?.boxMask || '(空)').slice(0, 60)} | composite=${afterMask?.boxMaskComposite || '(空)'}`
    )

    /* 5) 描边 → 层的 filter 里出现 8 向 drop-shadow */
    await page.locator('[data-insp-subpill="base"]').click()
    await sleep(250)
    await page.locator('[data-fx-toggle="stroke"]').click()
    await sleep(420)
    const afterStroke = await readFx('ifx_v')
    const strokeCount = (afterStroke?.filter.match(/drop-shadow\(/g) || []).length
    check(
      '开「描边」· 画面层的 computed filter 里出现 8 向 drop-shadow（不是只挂了个开关）',
      strokeCount === 8,
      `drop-shadow × ${strokeCount}`
    )

    /* 6) 阴影 → 再叠一层 drop-shadow（数量从 8 变 9） */
    await page.locator('[data-fx-toggle="shadow"]').click()
    await sleep(420)
    const afterShadow = await readFx('ifx_v')
    const shadowCount = (afterShadow?.filter.match(/drop-shadow\(/g) || []).length
    check(
      '再开「阴影」· filter 里的 drop-shadow 从 8 条变 9 条（阴影真的叠上去了）',
      shadowCount === 9,
      `drop-shadow × ${shadowCount}`
    )

    /* 7) 混合模式：只在**叠加轨**上出现，点了之后那层的 mix-blend-mode 真的变 */
    await page.locator('.clip[data-clip="ifx_o"]').click()
    await sleep(500)
    await page.locator('[data-insp-tab="visual"]').click()
    await sleep(300)
    await page.locator('[data-insp-subpill="base"]').click()
    await sleep(300)
    const blendBefore = await page.evaluate(() => {
      const el = document.querySelector('[data-pip-id="ifx_o"] .canvas-pip')
      return el ? getComputedStyle(el).mixBlendMode : '(没有这一层)'
    })
    await page.locator('[data-fx-blend-btn="multiply"]').click()
    await sleep(420)
    const blendAfter = await page.evaluate(() => {
      const el = document.querySelector('[data-pip-id="ifx_o"] .canvas-pip')
      return el ? getComputedStyle(el).mixBlendMode : '(没有这一层)'
    })
    check(
      '叠加轨点「混合·正片叠底」· 那一层的 computed mix-blend-mode 从 normal 变成 multiply',
      blendBefore === 'normal' && blendAfter === 'multiply',
      `${blendBefore} → ${blendAfter}`
    )

    /* 8) 面板改的东西必须**写回片段**（导出载荷就是从片段来的） */
    await sleep(2200)
    const savedFx = await page.evaluate(
      (id) =>
        window.yjai.draft.load(id).then((r) => {
          const clip = (r?.data?.clips || []).find((c) => c.id === 'ifx_v')
          return clip?.effects || null
        }),
      saved?.id || ''
    )
    check(
      '效果落到草稿片段里（圆角 120 / 斜切 20 / 抠像 / 蒙版 / 描边 / 阴影 全在 effects 上）',
      Number(savedFx?.radius) === 120 &&
        Number(savedFx?.skewX) === 20 &&
        savedFx?.key?.on === true &&
        savedFx?.mask?.shape === 'rect' &&
        savedFx?.stroke?.on === true &&
        savedFx?.shadow?.on === true,
      JSON.stringify(savedFx)
    )

    const realErrors = pageErrors.filter((text) => !/Failed to load resource|net::ERR|403|401/i.test(text))
    check('全程无页面错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    while (emitted < TOTAL_ASSERTIONS - 1) {
      emitted += 1
      failures += 1
      console.log(`  [FAIL] 第 ${emitted} 项 — 前面出错，本项未执行`)
    }
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    await closeApp(app)
    app = null
  }

  return summary()
}

if (process.argv.includes('--selftest')) {
  selftest()
  process.exit(failures ? 1 : 0)
} else {
  main()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
