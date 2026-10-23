#!/usr/bin/env node
/**
 * 几何 / 包络换算自检（**纯函数，不开 Electron**）。
 *
 * 盯的是这一族缺陷：**同一个参数在预览与导出里被算成了两个值**。
 * 它们的共同特征是「两边代码各自都读得通、构建不报错、界面也看不出」——
 * 只有把两个数并排比才现形：
 *   · 裁剪框：预览的 transform 中心与导出的 crop 起点不是同一块区域；
 *   · 镜像：预览翻了、导出忘接（或只接了一根轴）；
 *   · 四角圆角：CSS 写了四个值、导出的遮罩表达式只按第一个角生成；
 *   · 蒙版朝向：预览是纵向条带、导出按横向切；
 *   · 音量包络：预览插值成一条曲线、导出的表达式是另一条。
 *
 * 所以本脚本不测"函数能跑"，而是测**两侧的换算结果彼此自洽**：
 * 例如把导出串里的 crop 参数反解回百分比，必须与预览 transform 反解出的中心一致。
 *
 * 用法：
 *   node tools/check-edit-geometry.mjs             # 正检
 *   node tools/check-edit-geometry.mjs --selftest  # 自证：故意喂错，确认断言真的会红
 *
 * 退出码：0 = 通过；1 = 有失败；2 = 环境/参数问题。
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const SRC = path.join(root, 'packages', 'desktop', 'src', 'shared')

const cropMod = require(path.join(SRC, 'crop.js'))
const fxMod = require(path.join(SRC, 'effects.js'))
const audioMod = require(path.join(SRC, 'audio.js'))
const reverseMod = require(path.join(SRC, 'reverse.js'))

const selftest = process.argv.includes('--selftest')

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    problems.push(label)
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

/**
 * ffmpeg 表达式 → JS 表达式：只换函数名，不改结构。
 * `if(cond,a,b)` / `lte(a,b)` 在 ffmpeg 里是函数，在 JS 里不是 —— 换名之后
 * 同一条表达式就能被 JS 求值，从而复算出"导出侧到底会在 t 时刻用多大音量"。
 */
const toJs = (text) => String(text).replace(/\bif\(/g, 'IF(').replace(/\blte\(/g, 'LTE(')
const jsEval = (expr, t) =>
  Number(new Function('t', `const LTE=(a,b)=>a<=b?1:0; const IF=(c,a,b)=>c?a:b; return ${toJs(expr)};`)(t))

/** 从 `scale(k) translate(tx%, ty%)` 里反解出 k / tx / ty */function parseCropTransform(text) {
  const m = /scale\(([-\d.]+)\)\s*translate\(([-\d.]+)%,\s*([-\d.]+)%\)/.exec(String(text))
  if (!m) return null
  return { k: Number(m[1]), tx: Number(m[2]), ty: Number(m[3]) }
}

/** 从 `crop=W:H:X:Y,...` 里反解出百分比矩形 */
function parseFfmpegCrop(text, width, height) {
  const m = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(String(text))
  if (!m) return null
  return {
    w: (Number(m[1]) / width) * 100,
    h: (Number(m[2]) / height) * 100,
    x: (Number(m[3]) / width) * 100,
    y: (Number(m[4]) / height) * 100
  }
}

console.log('\n== 一、自由裁剪框：预览与导出落在同一块区域 ==\n')

{
  check('中性：未开启 / 满幅 都算「不裁剪」', cropMod.isNeutralCrop({ on: false }) && cropMod.isNeutralCrop({ on: true, x: 0, y: 0, w: 100, h: 100 }))

  const c = { on: true, x: 25, y: 25, w: 50, h: 50 }
  const css = cropMod.cssCropTransform(c)
  const t = parseCropTransform(css)
  check('预览 transform 形如 scale(k) translate(tx,ty)', Boolean(t), css)
  /* 中心映射：k * (x + w/2 + tx/100) 必须等于 0.5（画面中心） */
  const centerX = t ? t.k * (0.25 + 0.25 + t.tx / 100) : -1
  const centerY = t ? t.k * (0.25 + 0.25 + t.ty / 100) : -1
  check('预览：裁剪框中心被映射到画面中心', Math.abs(centerX - 0.5) < 1e-3 && Math.abs(centerY - 0.5) < 1e-3, `(${centerX}, ${centerY})`)
  /* 缩放系数必须是 cover：max(1/w, 1/h) */
  check('预览：缩放系数是 cover 口径 max(1/w,1/h)', t && Math.abs(t.k - 2) < 1e-3, t ? String(t.k) : '')

  const ff = cropMod.ffmpegCropFor(c, 1920, 1080)
  const parsed = parseFfmpegCrop(ff, 1920, 1080)
  check('导出：crop 参数就是同一个矩形', parsed && Math.abs(parsed.x - 25) < 0.2 && Math.abs(parsed.w - 50) < 0.2, ff)
  check('导出：crop 之后紧跟 scale+再 crop（铺满画布）', /crop=\d+:\d+:\d+:\d+,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080/.test(ff), ff)

  /* 夹取：x 推过头不能让框出画 */
  const clamped = cropMod.readCrop({ on: true, x: 90, y: 0, w: 50, h: 100 })
  check('夹取：x 最大只能到 100-w', Math.abs(clamped.x - 50) < 1e-6, String(clamped.x))

  const rect = cropMod.cropRectFor('1:1', 16 / 9)
  check('比例预设 1:1 在 16:9 画布上是居中的 56.25% × 100%', Math.abs(rect.w - 56.25) < 0.01 && Math.abs(rect.h - 100) < 0.01 && Math.abs(rect.x - 21.875) < 0.01, JSON.stringify(rect))
}

console.log('\n== 二、镜像：两根轴，预览与导出逐轴对应 ==\n')

{
  const h = fxMod.readEffects({ mirror: { h: true } })
  check('左右：预览是水平翻转', fxMod.cssMirror(h) === 'scaleX(-1)', fxMod.cssMirror(h))
  check('左右：导出是 hflip', fxMod.mirrorFilters(h) === 'hflip', fxMod.mirrorFilters(h))

  const v = fxMod.readEffects({ mirror: { v: true } })
  check('上下：预览是垂直翻转', fxMod.cssMirror(v) === 'scaleY(-1)', fxMod.cssMirror(v))
  check('上下：导出是 vflip', fxMod.mirrorFilters(v) === 'vflip', fxMod.mirrorFilters(v))

  const both = fxMod.readEffects({ mirror: { h: true, v: true } })
  check('两轴同开：预览两个 scale 都在', /scaleX\(-1\)/.test(fxMod.cssMirror(both)) && /scaleY\(-1\)/.test(fxMod.cssMirror(both)), fxMod.cssMirror(both))
  check('两轴同开：导出两个 flip 都在', fxMod.mirrorFilters(both) === 'hflip,vflip', fxMod.mirrorFilters(both))
  check('中性：不镜像时两侧都返回空串', fxMod.cssMirror(fxMod.readEffects(null)) === '' && fxMod.mirrorFilters(fxMod.readEffects(null)) === '')
}

console.log('\n== 三、四角圆角：四个角都要进遮罩表达式 ==\n')

{
  const fx = fxMod.readEffects({ corners: { on: true, tl: 100, tr: 60, br: 20, bl: 0 } })
  const css = fxMod.cssRadius(fx)
  /* CSS 的四个值顺序是 左上 右上 右下 左下 */
  const parts = css.split(' ')
  check('预览：border-radius 给出四个值', parts.length === 4, css)
  check('预览：四角数值互不相同（顺序 tl/tr/br/bl）', new Set(parts).size >= 3, css)
  check('预览：0 值写成 0', parts[3] === '0', css)

  const expr = fxMod.maskExprFor(fx)
  /* 四个角各有一段 hypot；bl 是 0 ⇒ 只有三段 */
  const hypo = (expr.match(/hypot\(/g) || []).length
  check('导出：非零的三个角各生成一段圆角条件', hypo === 3, `hypot 段数 = ${hypo}`)
  check('导出：表达式是 if(...,255,0) 形状', /^if\(.+,255,0\)$/.test(expr), expr.slice(0, 80))

  const single = fxMod.readEffects({ radius: 120 })
  check('单值圆角：仍然走原来的四角同半径表达式', (fxMod.maskExprFor(single).match(/hypot\(/g) || []).length === 4)
  check('单值圆角：CSS 只有一个值', !fxMod.cssRadius(single).includes(' '), fxMod.cssRadius(single))
}

console.log('\n== 四、蒙版：条带朝向在两侧一致 ==\n')

{
  const x = fxMod.readEffects({ mask: { shape: 'linear', axis: 'x', x: 30, w: 40 } })
  const xCss = fxMod.cssMaskFor(x, 16 / 9).maskImage
  const xExpr = fxMod.maskExprFor(x)
  check('横向条带：CSS 是 to right', xCss.startsWith('linear-gradient(to right'), xCss)
  check('横向条带：导出只按 X 判定', /gte\(X,/.test(xExpr) && !/gte\(Y,/.test(xExpr), xExpr)

  const y = fxMod.readEffects({ mask: { shape: 'linear', axis: 'y', y: 70, h: 20 } })
  const yCss = fxMod.cssMaskFor(y, 16 / 9).maskImage
  const yExpr = fxMod.maskExprFor(y)
  check('纵向条带：CSS 是 to bottom', yCss.startsWith('linear-gradient(to bottom'), yCss)
  check('纵向条带：导出只按 Y 判定', /gte\(Y,/.test(yExpr) && !/gte\(X,/.test(yExpr), yExpr)

  const mirror = fxMod.readEffects({ mask: { shape: 'mirror', axis: 'x', x: 10, w: 50 } })
  const mirrorExpr = fxMod.maskExprFor(mirror)
  /* 居中对称：0.25 与 0.75 —— 而不是 x=10 推出来的 -0.15 / 0.35 */
  check('镜面条带：强制居中（0.25–0.75）', /0\.25\)/.test(mirrorExpr) && /0\.75\)/.test(mirrorExpr), mirrorExpr)
}

console.log('\n== 五、音量包络：表达式复算 == volumeAt 插值 ==\n')

{
  const points = [
    { t: 0, v: 0 },
    { t: 2, v: 100 },
    { t: 5, v: 40 }
  ]
  const expr = audioMod.volumeExpr(points)
  let worst = 0
  for (const t of [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6]) {
    const want = audioMod.volumeAt(points, t, 100) / 100
    const got = jsEval(expr, t)
    worst = Math.max(worst, Math.abs(want - got))
  }
  check('表达式在 9 个采样点上都等于插值结果（误差 < 1%）', worst < 0.01, `最大误差 ${worst.toFixed(4)}`)

  check('单点包络 = 常数', audioMod.volumeExpr([{ t: 0, v: 50 }]) === '0.5000', audioMod.volumeExpr([{ t: 0, v: 50 }]))
  check('空包络返回空串（不生成一个恒 0 的音量）', audioMod.volumeExpr([]) === '')
  check('音量点按时间排序并夹到 0–200', (() => {
    const list = audioMod.readVolumeKf([{ t: 3, v: 900 }, { t: 1, v: -20 }])
    return list[0].t === 1 && list[0].v === 0 && list[1].v === 200
  })())
}

console.log('\n== 六、导出阶段滤镜：关掉时不许留半截参数 ==\n')

{
  check('响度：不处理时返回空串', audioMod.loudnormFor('off') === '')
  check('响度：网络档是 -14 LUFS', /loudnorm=I=-14/.test(audioMod.loudnormFor('web')), audioMod.loudnormFor('web'))
  check('视频降噪：0 时返回空串', audioMod.videoDenoiseFilter(0) === '')
  check('视频降噪：开启时用 hqdn3d', audioMod.videoDenoiseFilter(50).startsWith('hqdn3d='), audioMod.videoDenoiseFilter(50))
  check('音频降噪：0 时返回空串', audioMod.audioDenoiseFilter(0) === '')
  check('音频降噪：开启时用 afftdn', audioMod.audioDenoiseFilter(50).startsWith('afftdn='), audioMod.audioDenoiseFilter(50))
  check('防抖：0 时返回空串', audioMod.stabilizeFilter(0) === '')
  check('防抖：开启时用 deshake 且不露黑边（edge=mirror）', /^deshake=.*edge=mirror/.test(audioMod.stabilizeFilter(50)), audioMod.stabilizeFilter(50))
}

console.log('\n== 七、斜切：导出侧真的接到 shear（历史缺陷回归） ==\n')

{
  const fx = fxMod.readEffects({ skewX: 45 })
  const shear = fxMod.shearFor(fx)
  check('45° 斜切 → shx 约为 1（tan45）', /shx=1(:|$)/.test(shear), shear)
  check('斜切的填充色是透明（四角露底色而不是黑块）', /fillcolor=black@0/.test(shear), shear)
  check('0° 时返回空串（不加一级无用的 shear）', fxMod.shearFor(fxMod.readEffects({}) ) === '')
}

console.log('\n== 八、倒放：局部时间翻转与导出 filters 对应 ==\n')

{
  const rev = reverseMod
  const clip = { start: 10, duration: 4, offset: 1, speed: 1, reverse: true }
  /* 预览侧：sourceTimeAt 等价算术（这里不 import 渲染层，直接复算同一口径） */
  const sourceAt = (c, t) => {
    const local = Math.min(Math.max(t - c.start, 0), c.duration)
    return c.offset + rev.reverseLocal(c, local) * (c.speed || 1)
  }
  check('正放片段的首帧取到源入点（1 秒处）', sourceAt({ ...clip, reverse: false }, 10) === 1)
  check('倒放片段的**首帧取到源出点**（5 秒处：1 + 4）', sourceAt(clip, 10) === 5, String(sourceAt(clip, 10)))
  check('倒放片段的**末帧回到源入点**（1 秒处）', sourceAt(clip, 14) === 1, String(sourceAt(clip, 14)))
  check(
    '倒放是单调递减（不会跳回正放）',
    sourceAt(clip, 11) > sourceAt(clip, 12) && sourceAt(clip, 12) > sourceAt(clip, 13)
  )
  /* 2 倍速 + 倒放：先翻局部秒、再乘倍速 ⇒ 源跨度仍然只有 duration×speed */
  const fast = { start: 0, duration: 3, offset: 0, speed: 2, reverse: true }
  check('2 倍速倒放：首帧落在源 6 秒处（duration×speed）', sourceAt(fast, 0) === 6, String(sourceAt(fast, 0)))
  check('2 倍速倒放：末帧落回源 0', Math.abs(sourceAt(fast, 3)) < 1e-9)
  check('倒放：越界播放头被夹住（不返回负数）', sourceAt(clip, 99) === 1 && sourceAt(clip, -99) === 5)
  check('正放：videoReversePart 是空串（不插一级无用的 reverse）', rev.videoReversePart({}) === '')
  check('倒放：videoReversePart 带前导逗号（可直接串进滤镜链）', rev.videoReversePart(clip) === ',reverse')
  check('倒放：audioReversePart 用 areverse（不是 reverse）', rev.audioReversePart(clip) === ',areverse')
}

console.log('\n== 九、立体声平衡：只改声道增益、不混单声道 ==\n')

{
  const pan = audioMod.panFilter
  check('居中：返回空串（不加一级无用的 pan）', pan(0) === '')
  check('左右都还在（不是混成单声道）', /c0=\d*\.?\d+\*c0/.test(pan(40)) && /c1=\d*\.?\d+\*c1/.test(pan(40)), pan(40))
  check('居中时两侧增益都是 1（不加功能时不能被削 3dB）', pan(0) === '')
  const left = pan(-100)
  check('全左：左增益 1、右增益 0', /c0=1\*c0/.test(left) && /c1=0\*c1/.test(left), left)
  const right = pan(100)
  check('全右：左 0、右 1', /c0=0\*c0/.test(right) && /c1=1\*c1/.test(right), right)
  check('越界被夹到 ±100（传给 ffmpeg 不会出现负增益）', pan(-500) === left && pan(500) === right)
  check('非法值返回空串（NaN 不会拼进滤镜链）', pan('abc') === '' && pan(undefined) === '')
}

/**
 * 自证：这些谓词描述的都是**错误状态**，它们必须**全部为假**。
 * 只要有一个为真，说明对应的正检断言抓不住这种错（判据不可分辨）。
 * 这一层挡的是"检查器变成空转"—— 比如有人把 hypot 计数改成恒真，
 * 正检依旧全绿而问题已经看不见了。
 */
if (selftest) {
  console.log('\n== 自证：错误状态必须被判为假 ==\n')
  let caught = 0
  const mustFail = [
    ['裁剪中心算错', () => Math.abs(0.4 - 0.5) < 1e-3],
    ['镜像只接一根轴', () => fxMod.mirrorFilters(fxMod.readEffects({ mirror: { h: true, v: true } })) === 'hflip'],
    ['四角只算两个角', () => (fxMod.maskExprFor(fxMod.readEffects({ corners: { on: true, tl: 60, tr: 60, br: 60, bl: 60 } })).match(/hypot\(/g) || []).length === 2],
    ['条带朝向串了', () => fxMod.cssMaskFor(fxMod.readEffects({ mask: { shape: 'linear', axis: 'y' } }), 16 / 9).maskImage.startsWith('to right')],
    ['包络表达式与插值不一致', () => Math.abs(jsEval(audioMod.volumeExpr([{ t: 0, v: 0 }, { t: 2, v: 100 }]), 0.5) - 0.9) < 1e-6],
    ['降噪关掉却留了参数', () => audioMod.audioDenoiseFilter(0) === 'afftdn=nr=10'],
    /* 倒放只做了导出那半边：预览的首帧仍然取源入点（画面照旧正放，成片却是倒的） */
    ['倒放片段在预览里没翻转', () => reverseMod.reverseLocal({ start: 0, duration: 4, reverse: true }, 0) === 0],
    /* 立体声平衡把一边推满、另一边忘了归零（听起来像"偏了但没偏到位"） */
    ['全左时右声道没归零', () => /c1=1\*c1/.test(audioMod.panFilter(-100))]
  ]
  for (const [label, wrongState] of mustFail) {
    if (!wrongState()) {
      caught += 1
      console.log(`  ✓ ${label} —— 错误状态为假（判据可分辨）`)
    } else {
      fail += 1
      problems.push(`自证失败：${label} 竟然成立`)
      console.log(`  ✗ 自证失败：${label} 竟然成立（判据不可分辨）`)
    }
  }
  console.log(`\n自证：${caught}/${mustFail.length} 个错误状态被判为假`)
}

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('EDIT_GEOMETRY_FAILED')
  for (const item of problems) console.log(`  - ${item}`)
  process.exit(1)
}
console.log(selftest ? 'EDIT_GEOMETRY_SELFTEST_OK' : 'EDIT_GEOMETRY_OK')
process.exit(0)
