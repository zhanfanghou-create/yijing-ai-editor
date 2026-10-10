/**
 * 静态 · 每个真启 Electron 的 E2E 脚本都必须「关得掉」。
 *
 * 为什么单独一道闸门（这是"工具自己坏了"那一类，比"被测代码坏了"更贵）：
 *
 *   2026-10-08 实测：新写的 `check-preview-aspect.mjs` 收尾是裸 `await app.close()`，
 *   而这个环境里 app.close() **永不返回**（实测挂住 28 分钟）。断言其实早就跑完、
 *   结论也落盘了（16/16 + OK 标记），卡住的只是退出那一步 ——
 *   于是整套一键验证停在 42/45 不动，看上去像"Electron 崩了 / 功能坏了"，
 *   真因只是没人去关它。项目里 draft-e2e / timeline-play / preview-effects 早有
 *   同一套 `withTimeout(app.close()) + taskkill` 兜底，新脚本照抄就漏了。
 *
 *   同类还有第二个：脚本里用 `spawnSync(cmd, args, { encoding: 'utf8' })` 跑 ffmpeg。
 *   本机 spawnSync 只要 stdio 走管道就 EBUSY（连 cmd.exe 都一样），status 恒为 null
 *   ⇒ 探测函数恒返回"没找到" ⇒ 整组断言**静默变成 SKIP**，闸门照样绿、一条没验。
 *   （2026-10-08 同一轮修掉：media 18P/17S → 26P/9S，real-film 33P/3S → 36P/0S。）
 *
 * 两者的共性：脚本自己坏得无声无息，且报出来的方向与被验的东西无关。
 * 静态扫一遍就能钉住，不必等到它拖死一整轮。
 *
 * 用法：
 *   node tools/check-e2e-teardown.mjs              # 真查
 *   node tools/check-e2e-teardown.mjs --selftest   # 判据自证（合成夹具正反两面）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = path.join(ROOT, 'tools')

const TOTAL_ASSERTIONS = 6

/** 把「一段源码有没有问题」抽成纯函数，--selftest 才能拿同一份判据去造夹具 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

/**
 * 收尾体检。
 *
 * @returns {{bare:boolean, guarded:boolean, exits:boolean, pipeSpawn:boolean}}
 *   bare      —— 出现裸 `await app.close()`（永不返回的那个写法）
 *   guarded   —— app.close() 被超时兜底包着（withTimeout / Promise.race）
 *   exits     —— 结尾有 process.exit（有挂住的句柄也退得掉）
 *   pipeSpawn —— 用 spawnSync 走管道跑外部命令（本机 EBUSY ⇒ 静默全 SKIP）
 */
function teardownContract(src) {
  const code = stripComments(src)
  const launches = /\.launch\s*\(/.test(code)
  /**
   * 逐**处**判断，不是判断"文件里有没有出现过 withTimeout"。
   *
   * ⚠️ 窗口必须取 app.close 前后各 300 字符：项目里既有写法是
   *    `Promise.race([ app.close().catch(()=>{}), new Promise(r=>setTimeout(r,4000)) ])`
   *    —— `app.close()` 自己那一行上既没有 withTimeout 也没有 Promise.race
   *    （它们在上面一行）。按行判会把这四个已经修好的脚本全判成"缺兜底"，
   *    于是这道闸门一上线就是一片假红，而假红会训练人无脑忽略它。
   */
  const spots = [...code.matchAll(/app\.close\s*\(/g)].map((m) => {
    const i = m.index
    const window = code.slice(Math.max(0, i - 300), i + 300)
    const prefix = code.slice(Math.max(0, i - 60), i)
    return { guarded: /withTimeout|Promise\.race/.test(window), awaited: /await/.test(prefix) }
  })
  const closes = spots.length > 0
  const bare = spots.some((s) => s.awaited && !s.guarded)
  const guarded = spots.every((s) => s.guarded)
  const exits = /process\.exit\s*\(/.test(code)
  const pipeSpawn = /spawnSync\s*\(/.test(code) && /encoding\s*:\s*['"]utf8['"]/.test(code)
  return { launches, closes, bare, guarded, exits, pipeSpawn }
}

/**
 * 找出 tools/ 下真启 Electron 的脚本（既 import _electron 又真 .launch）
 *
 * ⚠️ 本文件自己必须排除：它为了造夹具，正文里就写着 `await app.close()` 与
 *    `spawnSync(..., { encoding: 'utf8' })` 这些**反例**。不排除的话这道闸门
 *    第一条就红在自己身上，而且红得莫名其妙（看着像自己写错了）。
 */
const SELF = 'check-e2e-teardown.mjs'

function findLaunchers(files) {
  return files.filter((file) => {
    if (file === SELF) return false
    const src = fs.readFileSync(path.join(TOOLS, file), 'utf8')
    const code = stripComments(src)
    return /_electron/.test(code) && /\.launch\s*\(/.test(code)
  })
}

/* --------------------------------------------------------- 输出 */

let emitted = 0
let failures = 0

function check(name, ok, detail = '') {
  emitted += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary(tag) {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`E2E_TEARDOWN_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures) console.log(tag)
  return failures === 0
}

/* --------------------------------------------------------- 自检 */

function selftest() {
  console.log('=== E2E 收尾判据自检（正控制组 + 逐条扰动）===\n')

  const GOOD = [
    "const app = await electron.launch({ executablePath: EXE })",
    "await withTimeout(app.close(), 8000, 'app.close')",
    "execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'])",
    'process.exit(code)'
  ].join('\n')

  const base = teardownContract(GOOD)
  const ok0 = !base.bare && base.guarded && base.exits && !base.pipeSpawn
  check(
    '正控制组（withTimeout + taskkill + process.exit）全绿',
    ok0,
    `bare=${base.bare} guarded=${base.guarded} exits=${base.exits} pipe=${base.pipeSpawn}`
  )

  // 扰动 1：改成裸 await —— 只能红在"裸等"那条
  const bareCase = teardownContract(GOOD.replace("await withTimeout(app.close(), 8000, 'app.close')", 'await app.close().catch(() => {})'))
  check(
    '裸 `await app.close()` → 红在"不许裸等"那条（且超时兜底那条也跟着红）',
    bareCase.bare && !bareCase.guarded && bareCase.exits,
    `bare=${bareCase.bare} guarded=${bareCase.guarded}`
  )

  // 扰动 2：去掉 process.exit —— 只能红在"必须强制退出"那条
  const noExit = teardownContract(GOOD.replace('process.exit(code)', ''))
  check(
    '去掉 process.exit → 红在"必须强制退出"那条',
    !noExit.exits && !noExit.bare && noExit.guarded,
    `exits=${noExit.exits}`
  )

  // 扰动 3：引入管道式 spawnSync —— 只能红在"不许管道 spawn"那条
  const piped = teardownContract(GOOD + "\nconst r = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' })")
  check(
    'spawnSync 走管道 → 红在「不许管道 spawn」那条（前三条不受牵连）',
    piped.pipeSpawn && !piped.bare && piped.guarded && piped.exits,
    `pipe=${piped.pipeSpawn}`
  )

  // 扰动 4：注释里写了坏样例 —— 不许被当成真的（注释要剥掉）
  const commented = teardownContract(
    GOOD + '\n// 反例：await app.close()  // 这样写会挂死，别学\n/* spawnSync(x, [], { encoding: \'utf8\' }) */'
  )
  check(
    '注释里的反例不算数（判据剥注释后再判）',
    !commented.bare && !commented.pipeSpawn,
    `bare=${commented.bare} pipe=${commented.pipeSpawn}`
  )

  // 扰动 5：没有 app.close 的脚本不该被误判（只查"有 close 的那些"）
  const noClose = teardownContract("const app = await electron.launch({})\nprocess.exit(0)")
  check(
    '根本没调 app.close() 的脚本不误判（不算"缺少兜底"）',
    !noClose.bare && noClose.guarded && noClose.exits,
    `closes=${noClose.closes} guarded=${noClose.guarded}`
  )

  while (emitted < TOTAL_ASSERTIONS) check('（补齐到固定条数）', true)
  const ok = summary('E2E_TEARDOWN_SELFTEST_OK')
  process.exitCode = ok ? 0 : 1
}

/* --------------------------------------------------------- 真查 */

function main() {
  console.log('=== E2E 脚本收尾体检（不许裸等 app.close / 不许管道 spawnSync）===\n')

  const files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs')).sort()
  const launchers = findLaunchers(files)

  check(
    `覆盖面非空：扫到 ${launchers.length} 个真启 Electron 的脚本（扫不到 = 检查器瞎了）`,
    launchers.length >= 3,
    launchers.join(' ') || '(一个都没扫到)'
  )

  const reports = launchers.map((file) => ({
    file,
    ...teardownContract(fs.readFileSync(path.join(TOOLS, file), 'utf8'))
  }))

  const bareOnes = reports.filter((r) => r.bare).map((r) => r.file)
  check(
    '没有脚本裸等 app.close()（挂死 28 分钟那个写法）',
    bareOnes.length === 0,
    bareOnes.length ? `裸等：${bareOnes.join(' ')}` : `${reports.length} 个脚本逐个查过`
  )

  const unguarded = reports.filter((r) => !r.guarded).map((r) => r.file)
  check(
    '每个 app.close() 都有超时兜底（withTimeout / Promise.race）',
    unguarded.length === 0,
    unguarded.length ? `缺兜底：${unguarded.join(' ')}` : '逐个查过'
  )

  const noExit = reports.filter((r) => !r.exits).map((r) => r.file)
  check(
    '每个脚本结尾都强制 process.exit（有挂住的句柄也退得掉）',
    noExit.length === 0,
    noExit.length ? `没强制退出：${noExit.join(' ')}` : '逐个查过'
  )

  /* 管道式 spawnSync：这条不只查"启 Electron 的脚本"，它坑的是所有用 spawnSync
     探测外部命令的检查器，所以全 tools/ 一起扫。 */
  const piped = files
    .filter((f) => f !== SELF)
    .filter((f) => teardownContract(fs.readFileSync(path.join(TOOLS, f), 'utf8')).pipeSpawn)
  check(
    '没有脚本用 spawnSync 走管道跑外部命令（本机 EBUSY ⇒ 整组断言静默 SKIP）',
    piped.length === 0,
    piped.length ? `管道式：${piped.join(' ')}` : `${files.length} 个脚本逐个查过`
  )

  while (emitted < TOTAL_ASSERTIONS) check('（补齐到固定条数）', true)
  const ok = summary('E2E_TEARDOWN_OK')
  process.exitCode = ok ? 0 : 1
}

if (process.argv.includes('--selftest')) selftest()
else main()
