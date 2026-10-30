/**
 * 导出封面 · 纯逻辑自测（秒级，不需要 ffmpeg）。
 *
 * 这道自测盯的是「算得对」那一层，而 E2E（render-e2e 里的三条）盯「真的抽出图」。
 * 两边都必要：抽帧命令本身错（`-ss` 放在 `-i` 前面）时，图照样生成得出来、退出码照样 0，
 * 只有"抽到的内容不对"—— 那种缺陷只能靠算 + 真的对像素，各管一半。
 *
 * 这里钉的六件事：
 *   ① 开关语义：只有 `enabled === true` 才算开，`{ at: 3 }` 这种中间态不许偷偷导出；
 *   ② 入参缺字段 / 非数字 / 负数一律规范化（NaN 传进 -ss 会让 ffmpeg 从 0 开始抽）；
 *   ③ 时间点夹到**最后一帧**而不是时长 —— `-ss duration` 会得到 0 字节文件、退出码 0；
 *   ④ 按帧对齐：30fps 下 1.017 秒不是存在的帧，必须落到 1.033；
 *   ⑤ 封面路径 = 同目录同基名 + `-cover.jpg`（不是 `x.mp4.jpg`，双后缀上传会被拒）；
 *   ⑥ `-ss` 必须在 `-i` **之后**（放前面是快速跳转，会落到关键帧上）。
 *
 * 用法：node tools/cover-selftest.mjs
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cover = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'cover.js'))

let total = 0
let pass = 0

function check(label, ok, detail = '') {
  total += 1
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
  } else {
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`)
  }
}

const near = (a, b, eps = 1e-3) => Math.abs(Number(a) - Number(b)) <= eps

console.log('\nA. 开关语义（只有 enabled === true 才算开）')
check('没传参 ⇒ 关、时间 0', cover.readCover(undefined).enabled === false && cover.readCover(undefined).at === 0)
check('null ⇒ 关', cover.readCover(null).enabled === false)
check('`{ at: 3 }`（选了时间但没开开关）⇒ 仍然关', cover.readCover({ at: 3 }).enabled === false)
check('`{ enabled: true }` ⇒ 开', cover.readCover({ enabled: true }).enabled === true)
check('`enabled: "true"` 字符串不算开（只认布尔 true）', cover.readCover({ enabled: 'true' }).enabled === false)

console.log('\nB. 入参规范化（NaN 传进 -ss 会从 0 秒抽，而且不报错）')
check('字符串数字 3.5 ⇒ 3.5', cover.readCover({ enabled: true, at: '3.5' }).at === 3.5)
check('"abc" ⇒ 0', cover.readCover({ enabled: true, at: 'abc' }).at === 0)
check('负数 ⇒ 0', cover.readCover({ enabled: true, at: -5 }).at === 0)
check('NaN ⇒ 0', cover.readCover({ enabled: true, at: NaN }).at === 0)

console.log('\nC. 时间点夹取与帧对齐')
check('正常值原样通过（3 秒 / 10 秒 / 30fps）', cover.coverTimeAt(3, 10, 30) === 3)
check(
  'at = duration 夹到最后一帧，不是时长本身',
  cover.coverTimeAt(10, 10, 30) < 10 && near(cover.coverTimeAt(10, 10, 30), 10 - 1 / 30, 0.002),
  `实测 ${cover.coverTimeAt(10, 10, 30)}`
)
check('超出时长很远也夹住（120 秒 / 10 秒片）', near(cover.coverTimeAt(120, 10, 30), 10 - 1 / 30, 0.002))
check('负数 ⇒ 0', cover.coverTimeAt(-1, 10, 30) === 0)
check('时长 0 ⇒ 0（不抛、不产出负数）', cover.coverTimeAt(3, 0, 30) === 0)
check('时长非数字 ⇒ 0', cover.coverTimeAt(3, 'abc', 30) === 0)
check(
  '按帧对齐：30fps 下 1.017 落到 1.033（不是一个存在的帧）',
  near(cover.coverTimeAt(1.017, 10, 30), 1.033, 0.001),
  `实测 ${cover.coverTimeAt(1.017, 10, 30)}`
)
check('fps 缺失退回 30（不产出 NaN）', cover.coverTimeAt(2, 10, 0) === 2)
check('fps 为 60 时同样夹到最后一帧', near(cover.coverTimeAt(10, 10, 60), 10 - 1 / 60, 0.002))

console.log('\nD. 封面路径（同目录同基名 + -cover.jpg）')
check('Windows 反斜杠路径', cover.coverPathFor('C:\\out\\成片.mp4') === 'C:\\out\\成片-cover.jpg', cover.coverPathFor('C:\\out\\成片.mp4'))
check('POSIX 路径', cover.coverPathFor('/tmp/x.mov') === '/tmp/x-cover.jpg')
check('没有扩展名 ⇒ 直接后缀', cover.coverPathFor('out') === 'out-cover.jpg')
check('空串 ⇒ 空串（调用方据此判失败）', cover.coverPathFor('') === '')
check(
  '目录名带点不会被当成扩展名（C:\\a.b\\c ⇒ c-cover.jpg）',
  cover.coverPathFor('C:\\a.b\\c') === 'C:\\a.b\\c-cover.jpg',
  cover.coverPathFor('C:\\a.b\\c')
)
check('不产出双后缀（xxx.mp4.jpg）', !cover.coverPathFor('/a/b.mp4').endsWith('.mp4.jpg'))

console.log('\nE. 抽帧命令（-ss 必须在 -i 之后）')
const args = cover.buildCoverArgs({ outPath: '/a/b.mp4', coverPath: '/a/b-cover.jpg', at: 3.5 })
const iIdx = args.indexOf('-i')
const ssIdx = args.indexOf('-ss')
check('-ss 在 -i 之后（放前面会落到关键帧，抽到的画面不是那一帧）', iIdx >= 0 && ssIdx > iIdx, `-i@${iIdx} -ss@${ssIdx}`)
check('只抽一帧（-frames:v 1）', args.includes('-frames:v') && args[args.indexOf('-frames:v') + 1] === '1')
check('时间值是秒数字符串', args[ssIdx + 1] === '3.5', args[ssIdx + 1])
check('输出路径在最后一位', args[args.length - 1] === '/a/b-cover.jpg')
check('覆盖旧文件（-y），否则第二次导出会卡在询问上', args.includes('-y'))

console.log('\nF. 模块导出齐全（漏一个渲染层就是 undefined ⇒ 面板白屏）')
for (const key of ['readCover', 'coverTimeAt', 'coverPathFor', 'buildCoverArgs', 'readFps']) {
  check(`导出 ${key}`, typeof cover[key] === 'function')
}

console.log(`\n=== 结果：通过 ${pass} / ${total} ===`)
console.log(`COVER_SELFTEST_STATS total=${total} pass=${pass} fail=${total - pass}`)
if (pass === total) console.log('COVER_SELFTEST_PASSED')
else {
  console.log('COVER_SELFTEST_FAILED')
  process.exitCode = 1
}
