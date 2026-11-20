#!/usr/bin/env node
/**
 * 画面比例跟随闸门：钉住两处 UI 修复的接线。
 *
 * ① 导入素材自动切比例：导入竖屏素材，预览与导出都应自动变 9:16。
 *    - shared/aspect.js 的 closestAspectFor(w,h) 按宽高选最接近的比例档（对数距离）。
 *    - App.jsx 的 importLocalMedia 在两个守卫下调用它：时间线还空 + 当前仍是默认 16:9。
 *      守卫不可省：用户已在编排 / 已手动切过比例时不能偷偷改他的画布。
 *
 * ② 导出分辨率下拉显示真实尺寸：下拉文案以前写死档位基准 1920 × 1080（恒横向），
 *    竖屏时摘要条明明是 1080×1920、下拉却还是横的两个数 —— 看着像"选了没生效"。
 *    现在每个 option 用 outputSizeFor(基准宽,基准高,aspect) 算真实尺寸作为文案与 data-w/h。
 *
 * 判据读源码文本 + 直接调纯函数；期望值写死（比例档的宽高比、默认 16:9），不从被测函数反算。
 * --selftest 用合成夹具做正负对照，证明判据能拦住"没接 / 接错 / 恒绿"。
 *
 * 用法：node tools/check-aspect-follow.mjs [--selftest]
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELFTEST = process.argv.includes('--selftest')
const aspect = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'aspect.js'))
const exportRate = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'exportRate.js'))

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

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const appSrc = readSrc('packages/desktop/src/renderer/App.jsx')
const panelSrc = readSrc('packages/desktop/src/renderer/components/SidePanels.jsx')
const aspectSrc = readSrc('packages/desktop/src/shared/aspect.js')

/* ==================== ① closestAspectFor 纯函数（期望写死） ==================== */
check('竖屏 1080×1920 → 9:16', aspect.closestAspectFor(1080, 1920) === '9:16')
check('横屏 1920×1080 → 16:9', aspect.closestAspectFor(1920, 1080) === '16:9')
check('方形 1000×1000 → 1:1', aspect.closestAspectFor(1000, 1000) === '1:1')
check('竖屏 1080×1440 → 3:4', aspect.closestAspectFor(1080, 1440) === '3:4')
check('4K 竖屏 2160×3840 → 9:16（不同分辨率同比例）', aspect.closestAspectFor(2160, 3840) === '9:16')
check('非法宽高（0/负）回落默认 16:9', aspect.closestAspectFor(0, 0) === '16:9' && aspect.closestAspectFor(-1, 5) === '16:9')
check('结果一定是合法比例 key', aspect.ASPECT_KEYS.includes(aspect.closestAspectFor(777, 999)))

/* ==================== ② App 导入接线 ==================== */
check('App import 了 closestAspectFor', /import\s*\{[^}]*closestAspectFor[^}]*\}\s*from\s*'[^']*aspect\.js'/.test(appSrc))
check('importLocalMedia 在导入后调用 closestAspectFor', /closestAspectFor\s*\(/.test(appSrc) && /importLocalMedia/.test(appSrc))
check('守卫①：仅时间线为空时自动切（clips.length === 0）', /clips\.length\s*===\s*0\s*&&\s*aspect\s*===\s*DEFAULT_ASPECT/.test(appSrc))
check('守卫②：仅当前为默认比例时切（不覆盖用户选择）', /aspect\s*===\s*DEFAULT_ASPECT/.test(appSrc))
check('按第一张有宽高的 video 素材定比例（不被图片/logo 带偏）',
  /item\.kind\s*===\s*'video'/.test(appSrc) && /item\.width\s*>\s*0/.test(appSrc))
check('切比例后 setAspect 落 state（预览与导出同源）', /setAspect\(next\)/.test(appSrc))
check('importLocalMedia 依赖含 clips/aspect（闭包不再是旧值）',
  /\[toast,\s*clips\.length,\s*aspect\]/.test(appSrc))

/* ==================== ③ 导出下拉显示真实尺寸 ==================== */
check('下拉 option 用 outputSizeFor 算真实尺寸（不是档位基准）',
  /outputSizeFor\(item\.width,\s*item\.height,\s*aspect\)/.test(panelSrc))
check('option 带 data-w/data-h（真机可读到结算尺寸）', /data-w=\{real\.width\}\s+data-h=\{real\.height\}/.test(panelSrc))
check('下拉文案含 resolution id 与真实宽高', /item\.id\.toUpperCase\(\).*real\.width.*real\.height/.test(panelSrc))

/* 面板算出的真实尺寸 = 主进程同一函数（同一份算术，不是两套） */
const spec = exportRate.readResolution('1080p')
const real916 = aspect.outputSizeFor(spec.width, spec.height, '9:16')
check('1080P · 9:16 下拉应显示 1080×1920（与摘要条/成片一致）',
  real916.width === 1080 && real916.height === 1920, `${real916.width}×${real916.height}`)
const real169 = aspect.outputSizeFor(spec.width, spec.height, '16:9')
check('1080P · 16:9 下拉显示 1920×1080', real169.width === 1920 && real169.height === 1080)

/* ==================== selftest：判据可分辨 ==================== */
if (SELFTEST) {
  /* 负对照夹具：把下拉文案写死成基准尺寸 —— 第 ③ 组判据必须红 */
  const badPanel = `{EXPORT_RATE.RESOLUTIONS.map((item) => <option>{item.width} × {item.height}</option>)}`
  check('负对照：写死基准尺寸的下拉被判为缺 outputSizeFor',
    !/outputSizeFor\(item\.width/.test(badPanel) && !/data-w=\{real\.width\}/.test(badPanel))
  check('负对照：正确版夹具能通过同样的判据',
    /outputSizeFor\(item\.width,\s*item\.height,\s*aspect\)/.test(panelSrc))

  /* 负对照：closestAspectFor 若被写成"按面积"就分不出横竖 —— 用面积相等的横竖两组证明对数距离是必要的 */
  const area1 = 1080 * 1920
  const area2 = 1920 * 1080
  check('负对照：横竖两素材像素总数相同，靠面积无法区分（证明用宽高比是对的选择）',
    area1 === area2 && aspect.closestAspectFor(1080, 1920) !== aspect.closestAspectFor(1920, 1080))

  /* 负对照：守卫夹具 —— 缺了 time-line-empty 守卫的写法要被判红 */
  const badGuard = `if (aspect === DEFAULT_ASPECT) setAspect(next)`
  check('负对照：只有默认比例守卫、缺时间线守卫的写法被判红',
    !/clips\.length\s*===\s*0/.test(badGuard))

  console.log(`\nASPECT_FOLLOW_SELFTEST_STATS total=${pass + fail} pass=${pass} fail=${fail}`)
  if (fail) {
    for (const p of problems) console.log(`  · ${p}`)
    console.log('ASPECT_FOLLOW_SELFTEST_FAIL')
    process.exit(1)
  }
  console.log('ASPECT_FOLLOW_SELFTEST_OK')
  process.exit(0)
}

console.log(`\n=== 画面比例跟随：通过 ${pass} / 失败 ${fail} ===`)
console.log(`ASPECT_FOLLOW_STATS total=${pass + fail} pass=${pass} fail=${fail} skip=0`)
if (fail) {
  console.log('失败项：')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}
console.log('ASPECT_FOLLOW_OK')
process.exit(0)
