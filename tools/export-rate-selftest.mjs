/**
 * 导出规格自测（`shared/exportRate.js`）。
 *
 * 为什么值得单独立一道：帧率这一层错了**画面看起来完全正常**。
 *   · 29.97 被 `Math.round` 成 30 ⇒ NTSC 母版错档，成片还是能播；
 *   · 29.97 原样拼进 `fps=` 滤镜 ⇒ ffmpeg 存下 2997/100 这个非标准 timebase，
 *     容器里的 `avg_frame_rate` 不是 30000/1001，广播 QC 与 NLE 二次导入会要求重转；
 *   · 分辨率档少一档/多一档 ⇒ 用户点了没反应，或得到一个没人要的尺寸。
 * 这三类都不抛异常、不进日志，所以判据必须落在**换算结果**上，而不是"界面画出来了"。
 *
 * 用法：node tools/export-rate-selftest.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const rate = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'exportRate.js'))

let total = 0
let failed = 0

function check(name, ok, detail = '') {
  total += 1
  if (!ok) failed += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

console.log('\n=== A. 档位齐全（参考客户端七档）===')
{
  const ids = rate.RATES.map((item) => item.id)
  check('七档：24 / 25 / 29.97 / 30 / 50 / 59.94 / 60', ids.join(',') === '24,25,29.97,30,50,59.94,60', ids.join(','))
  check('PAL 两档（25 / 50）在表内 —— 以前的滑杆落不到这两个点', ids.includes('25') && ids.includes('50'))
  check('NTSC 两档（29.97 / 59.94）在表内', ids.includes('29.97') && ids.includes('59.94'))
  check('不存在 36 / 42 / 48（不是交付规格，选它只会逼人重转一次）',
    !ids.includes('36') && !ids.includes('42') && !ids.includes('48'))
}

console.log('\n=== B. NTSC 必须换成整数比 ===')
{
  check('29.97 → 30000/1001（不是 "29.97"）', rate.rateArg(29.97) === '30000/1001', rate.rateArg(29.97))
  check('59.94 → 60000/1001', rate.rateArg(59.94) === '60000/1001', rate.rateArg(59.94))
  /* 真实值 29.97002997：面板/草稿里存的可能是这个精度，容差必须兜住 */
  check('29.97002997（真实值）也认成 NTSC', rate.rateArg(29.97002997) === '30000/1001', rate.rateArg(29.97002997))
  check('整数帧率原样输出（30 → "30"，不带小数点）', rate.rateArg(30) === '30', rate.rateArg(30))
  check('25 → "25"', rate.rateArg(25) === '25', rate.rateArg(25))
}

console.log('\n=== C. 非法输入不许把 NaN/0 传给 ffmpeg ===')
{
  check('0 → 退回默认 30', rate.rateArg(0) === '30', rate.rateArg(0))
  check('负数 → 退回默认', rate.rateArg(-1) === '30', rate.rateArg(-1))
  check('NaN → 退回默认', rate.rateArg(NaN) === '30', rate.rateArg(NaN))
  check('undefined → 退回默认', rate.rateArg(undefined) === '30', rate.rateArg(undefined))
  check('9999（超上限）→ 退回默认', rate.rateArg(9999) === '30', rate.rateArg(9999))
}

console.log('\n=== D. readRate 三形态并联（id / 数字 / 旧草稿里的 30）===')
{
  const byId = rate.readRate('29.97')
  check("'29.97' → fps 29.97 且 arg 是整数比", byId.fps === 29.97 && byId.arg === '30000/1001', JSON.stringify(byId))
  const byNum = rate.readRate(29.97)
  check('数字 29.97 → 同一结果（面板存的是数值）', byNum.id === '29.97' && byNum.arg === '30000/1001', JSON.stringify(byNum))
  const legacy = rate.readRate(30)
  check('旧草稿的 30 → 命中 30 档', legacy.id === '30' && legacy.fps === 30, JSON.stringify(legacy))
  const junk = rate.readRate('不是帧率')
  check('垃圾输入 → 默认 30（不抛）', junk.id === '30' && junk.fps === 30, JSON.stringify(junk))
  const off = rate.readRate(48)
  /* 表外但数值合法的值照样认 —— 但 id 用它自己的值，界面上一眼能看出"这不是标准档" */
  check('表外合法值 48 → 认，但 id 保持 48', off.id === '48' && off.fps === 48, JSON.stringify(off))
}

console.log('\n=== E. 分辨率五档（上限 4K）===')
{
  const ids = rate.RESOLUTIONS.map((item) => item.id)
  check('五档：480p / 720p / 1080p / 2k / 4k', ids.join(',') === '480p,720p,1080p,2k,4k', ids.join(','))
  const u4 = rate.readResolution('4k')
  check('4K = 3840 × 2160', u4.width === 3840 && u4.height === 2160, `${u4.width}×${u4.height}`)
  check('表里没有 8k（本产品上限 4K，不给一个按下去多半失败的档）', !ids.includes('8k'))
  const legacy8 = rate.readResolution('8k')
  check('旧草稿的 8k → 落到 4k（不许静默掉到 1080P：那是连降两档）',
    legacy8.id === '4k' && legacy8.width === 3840, JSON.stringify(legacy8))
  const u480 = rate.readResolution('480p')
  check('480P = 854 × 480（不是 640×480：那个是 4:3）', u480.width === 854 && u480.height === 480, `${u480.width}×${u480.height}`)
  const unknown = rate.readResolution('不存在的档')
  check('未知档 → 1080P（不许把 undefined 塞给渲染）', unknown.id === '1080p' && unknown.width === 1920, JSON.stringify(unknown))
  const empty = rate.readResolution(null)
  check('null → 1080P', empty.id === '1080p', JSON.stringify(empty))
  /* 每一档都必须是偶数宽高：H.264 的 yuv420p 要求偶数，奇数会让 ffmpeg 直接报错 */
  check('每档宽高都是偶数（yuv420p 硬要求）', rate.RESOLUTIONS.every((item) => item.width % 2 === 0 && item.height % 2 === 0))
}

console.log('\n=== E2. 4K 上限夹取（绕开下拉框的入口也要挡住）===')
{
  check('短边上限是 2160', rate.MAX_SHORT_SIDE === 2160, String(rate.MAX_SHORT_SIDE))
  const big = rate.clampSize(7680, 4320)
  check('8K 基准 → 3840×2160 且标记 clamped', big.width === 3840 && big.height === 2160 && big.clamped === true, JSON.stringify(big))
  const square = rate.clampSize(3000, 3000)
  check('3000×3000 → 2160×2160（保持方形）', square.width === 2160 && square.height === 2160, JSON.stringify(square))
  const tall = rate.clampSize(2160, 3840)
  check('2160×3840（4K 竖屏）→ 原样不动（短边已经是 2160）',
    tall.width === 2160 && tall.height === 3840 && tall.clamped === false, JSON.stringify(tall))
  const wide = rate.clampSize(4320, 2160)
  check('4320×2160（4K + 2:1）→ 原样不动（按短边算，不按总像素）',
    wide.width === 4320 && wide.height === 2160 && wide.clamped === false, JSON.stringify(wide))
  const odd = rate.clampSize(1921, 1081)
  check('奇数尺寸 → 都取偶数', odd.width % 2 === 0 && odd.height % 2 === 0, JSON.stringify(odd))
}

console.log('\n=== F. 默认值 ===')
{
  check('默认帧率 30 且存在于表内', rate.DEFAULT_RATE === '30' && rate.RATES.some((item) => item.id === '30'))
  check('默认分辨率 1080p 且存在于表内',
    rate.DEFAULT_RESOLUTION === '1080p' && rate.RESOLUTIONS.some((item) => item.id === '1080p'))
}

/* ------------------------------------------------------------------ 汇总 */
console.log(`\n=== 结果：${total} 项 / 失败 ${failed} 项 ===`)
console.log(`EXPORT_RATE_SELFTEST_STATS total=${total} pass=${total - failed} fail=${failed}`)
if (!failed) console.log('EXPORT_RATE_SELFTEST_PASSED')
process.exit(failed ? 1 : 0)
