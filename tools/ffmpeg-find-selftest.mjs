/**
 * ffmpeg 查找逻辑自测（`render.chooseFfmpeg`）。
 *
 * 为什么要单独立这一道：这一层的错法**不会抛异常、不进日志**，
 * 而且在开发机上恰好都能跑通 —— 因为开发机的 ffmpeg 通常就在 PATH 里
 * 或装在 `C:\ffmpeg\bin`。真正出问题的机器是"装在
 * `D:\ffmpeg-8.1.2-essentials_build\bin`、PATH 里没有"（官方 essentials 包
 * 解压出来的默认形态），而那时用户看到的是导出面板上一句「本机未安装 ffmpeg」。
 *
 * 实测到的那次：候选表里裸命令 `ffmpeg.exe` 排在扫盘结果**之前**，
 * 第一轮循环 `path.isAbsolute('ffmpeg.exe')` 为假却照样 `return`，
 * 于是扫到的真实路径永远轮不到 —— 全量验证里 36 条真实渲染断言被静默跳过
 * （SKIP 不算失败），闸门报绿。所以这里用**注入的假 exists/PATH** 把它钉死，
 * 不依赖本机装没装 ffmpeg。
 *
 * 用法：node tools/ffmpeg-find-selftest.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

let total = 0
let failed = 0

function check(name, ok, detail = '') {
  total += 1
  if (!ok) failed += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 造一个假磁盘：只有 files 里的路径"存在"；PATH 只认 pathMap 里的裸命令 */
const fakeFs = (files = [], pathMap = {}) => ({
  existsFile: (p) => files.includes(p),
  resolvePath: (name) => pathMap[name] || ''
})

const D_BIN = 'D:\\ffmpeg-8.1.2-essentials_build\\bin\\ffmpeg.exe'
const C_BIN = 'C:\\ffmpeg\\bin\\ffmpeg.exe'
const BARE = 'ffmpeg.exe'

console.log('\n=== A. 磁盘绝对路径优先 ===')
{
  const picked = render.chooseFfmpeg([D_BIN, BARE], fakeFs([D_BIN]))
  check('只有绝对路径存在 ⇒ 选它', picked && picked.bin === D_BIN, picked && picked.bin)
  check('这条不算走 PATH', picked && picked.viaPath === false, String(picked && picked.viaPath))
}

console.log('\n=== B. 裸命令不许插队（本次实测到的缺陷）===')
{
  /* 裸命令排在前面、PATH 里也有它 —— 旧逻辑会直接返回裸名，永远不看后面的真路径。
     正确行为：磁盘上的绝对路径赢，因为它是确定能 spawn 的。 */
  const picked = render.chooseFfmpeg([BARE, D_BIN], fakeFs([D_BIN], { [BARE]: 'C:\\Windows\\ffmpeg.exe' }))
  check('裸命令在前也不许抢走（绝对路径仍胜出）', picked && picked.bin === D_BIN, picked && picked.bin)
}
{
  /* 更贴近现场的一种：PATH 里根本没有 ffmpeg（ENOENT 的由来），
     而扫盘扫到了真路径。旧逻辑返回裸名 ⇒ probe() 报 broken ⇒ 界面说"未安装"。 */
  const picked = render.chooseFfmpeg([BARE, D_BIN], fakeFs([D_BIN], {}))
  check('PATH 里没有时，仍要用扫到的绝对路径', picked && picked.bin === D_BIN, picked && picked.bin)
}

console.log('\n=== C. 不存在的候选一律跳过 ===')
{
  const picked = render.chooseFfmpeg(['C:\\不存在的\\ffmpeg.exe', D_BIN], fakeFs([D_BIN]))
  check('缺文件的候选被跳过，落到下一个', picked && picked.bin === D_BIN, picked && picked.bin)
}
{
  const picked = render.chooseFfmpeg([BARE], fakeFs([], { [BARE]: D_BIN }))
  check('磁盘上都没有 ⇒ 才退到 PATH', picked && picked.bin === D_BIN, picked && picked.bin)
  check('走 PATH 时标记来源', picked && picked.viaPath === true, String(picked && picked.viaPath))
}

console.log('\n=== D. 都没有就老实说没有（不许返回裸名）===')
{
  const picked = render.chooseFfmpeg([BARE, D_BIN], fakeFs([], {}))
  check('一个都不存在 ⇒ null（而不是把裸命令当成找到）', picked === null, JSON.stringify(picked))
}
{
  /* PATH 解析出一个相对路径 / 空串时也不能认：spawn 它照样 ENOENT */
  const picked = render.chooseFfmpeg([BARE], fakeFs([], { [BARE]: 'ffmpeg.exe' }))
  check('PATH 解析结果不是绝对路径 ⇒ 不认', picked === null, JSON.stringify(picked))
}

console.log('\n=== E. 脏输入 ===')
{
  const picked = render.chooseFfmpeg([`"${D_BIN}"`, '  ', '', null, D_BIN], fakeFs([D_BIN]))
  check('带引号/空白/空值不碍事（去引号后仍能命中）', picked && picked.bin === D_BIN, picked && picked.bin)
}
{
  const picked = render.chooseFfmpeg(null, fakeFs())
  check('候选表不是数组 ⇒ null，不抛', picked === null, JSON.stringify(picked))
}

console.log('\n=== F. 顺序优先级（env > 随包 > 常见目录 > 扫盘）===')
{
  const BUNDLED = 'C:\\App\\resources\\ffmpeg\\ffmpeg.exe'
  const picked = render.chooseFfmpeg([D_BIN, C_BIN, BUNDLED], fakeFs([D_BIN, C_BIN, BUNDLED]))
  check('候选表靠前者胜出（env 在调用处排最前）', picked && picked.bin === D_BIN, picked && picked.bin)
}

/* ------------------------------------------------------------------ 汇总 */
console.log(`\n=== 结果：${total} 项 / 失败 ${failed} 项 ===`)
console.log(`FFMPEG_FIND_SELFTEST_STATS total=${total} pass=${total - failed} fail=${failed}`)
if (!failed) console.log('FFMPEG_FIND_SELFTEST_PASSED')
process.exit(failed ? 1 : 0)
