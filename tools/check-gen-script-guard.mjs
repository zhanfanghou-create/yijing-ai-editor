#!/usr/bin/env node
/**
 * check-gen-script-guard.mjs — 「生成脚本再交给 Electron 执行」这条链路的看门狗。
 *
 * 治的缺陷（2026-09-24，Jason 发来一张 Electron 弹窗截图）：
 *
 *   `tools/shoot-ref-images.mjs` 把主进程入口脚本**当成一段模板字符串**生成到
 *   `_recon/.ref-img-main.cjs`，再让 electron.exe 去执行。模板里那段 `try {` 曾漏写 `catch`
 *   ⇒ 生成物本身就是语法错。于是：
 *     · 父进程 side：Electron 加载失败后不打退出码也不退出，spawnSync 又没超时 ⇒
 *       **整条命令静默吊死**（实测 4 分钟），现场症状是"跑导出没有任何输出、目录是空的"，
 *       看着像素材有问题，其实一行代码都没跑。
 *     · 用户 side：Electron 主进程 load 失败会弹一个系统模态框
 *       （`A JavaScript error occurred in the main process` + 生成物路径 + SyntaxError）——
 *       **这个框是弹给用户看的**，而用户既不知道那是个构建期临时文件，也无从修起。
 *
 * 为什么这条链必须有闸门，而不是"修好就算了"：
 *   触发它的是**模板被编辑坏**，最典型的是往模板里写注释时混进一个反引号，把模板字面量
 *   提前截断 —— 同一个坑在本仓库已经踩过两次。这类坏法**构建全绿、类型全绿、
 *   界面上什么都不显示**，唯一的症状就是某天弹一个框出来。它属于"只有跑起来才知道"那一类，
 *   而它本该被**生成侧**当场拦住。
 *
 * 判据刻意验的是**真实生成物**（`--gen-only` 真跑一遍两个生成器），不是在闸门里复制一份
 * 模板来验 —— 复制品必然各自演化，然后其中一份静默失守（这个教训写在
 * `tools/lib/source-scan.mjs` 的文件头，这里照做）。
 *
 * 用法：node tools/check-gen-script-guard.mjs [--selftest]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { spawnCapture } from './spawn-capture.mjs'
import { fileURLToPath } from 'node:url'
import { syntaxErrorOf } from './lib/gen-script-guard.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const NODE = process.execPath
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

/**
 * 每个「生成脚本交给 Electron」的工具一条。
 *
 * `genOnly` 是它自己的 `--gen-only` 参数组合：只生成脚本、**不启动 Electron**。
 * 没有这个开关，闸门就没法验真实产物 —— 起 Electron 一条要几十秒，还不能保证退出。
 *
 * `input` 是跑 `--gen-only` 需要的前置（缺了就记 SKIP，**断言总数不变**，
 * 这是本项目表达"环境差异"的固定做法：SKIP 而不是少跑，否则"这台机器缺输入"
 * 和"有人把断言删了"分不出来）。
 */
/* ⚠️ 原先这里有两个生成器，其中 `shoot-ref-images.mjs`（取参考位图出联络表）
   随第三方素材一起删掉了 —— 仓库里不再有任何"处理他人素材"的取景脚本。
   表只剩一个生成器，下面的"两个"字样已同步改成按表长说话。 */
const GENERATORS = [
  {
    id: 'shoot-svg-sheet',
    file: 'tools/shoot-svg-sheet.mjs',
    argv: ['--gen-only', '--canvas', '22x22', '--cols', '13', '--tag', 'gen-guard'],
    artifact: '_recon/.svg-sheet-main.cjs',
    input: '_recon/ref-svgs/index.json',
    note: '铺 SVG 图标联络表（输入是 _recon 下的可重建产物）'
  }
]

let pass = 0
let total = 0
let fail = 0
const claim = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  else fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      —— ${detail}`}`)
}
/** 环境不足：记 SKIP，但**照样计入 total** */
const skip = (label, why) => {
  total += 1
  pass += 1
  console.log(`  - ${label}（SKIP：${why}）`)
}

/**
 * 子进程环境：**必须清掉 ELECTRON_RUN_AS_NODE**。
 * 带着它时 Electron 退化成纯 Node（`require('electron')` 解析到 npm 包那个路径字符串，
 * `app` 是 undefined）—— 与 desktop-shoot.mjs / shoot-svg-sheet.mjs 里同一个坑。
 * 这里跑的是 --gen-only（本来就不该起 Electron），但生成器返回前会读它，
 * 不清掉会让本闸门在"有人误把 --gen-only 实现成会起进程"时给出误导性的报错。
 */
function childEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

// ------------------------------------------------------------------ 实仓检查

function runRepo() {
  console.log('\n【实仓】生成物必须在生成侧就被验过语法')

  // 先读源码。这一步同时是"防空转"的一半：文件读不到，后面所有结论都不成立。
  const srcs = GENERATORS.map((g) => {
    const abs = path.join(ROOT, g.file)
    return { ...g, text: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null }
  })

  // ① 防空转：表里每个生成器都真读到，且**各自都在做那两件事**
  //    —— 构造一段交给 Electron 的脚本（`const mainSrc = `），并真的把它喂给 Electron
  //    （`spawnSync(ELECTRON`）。少了任何一件，下面两条断言都是在验空气。
  const hollow = srcs.filter(
    (s) => !s.text || !/const mainSrc = /.test(s.text) || !/spawnSync\(ELECTRON/.test(s.text)
  )
  claim(
    hollow.length === 0,
    `表里每个生成器都真读到了、且各自都在「生成脚本 + 交给 Electron」（${srcs.length} 个）`,
    hollow.length
      ? '这些文件没有同时满足"有 mainSrc 模板"与"把它 spawn 给 ELECTRON"：' +
        hollow.map((s) => `${s.file}${s.text ? '' : '（文件不存在）'}`).join(' / ') +
        ' ⇒ 下面的断言会退化成验空气，必须先修这个'
      : ''
  )

  // ② 接线：表里每个生成器都调了守卫本身。
  //    这条只判"有没有接"。守卫**判得对不对**由 --selftest 负责 —— 两道互补，缺一漏一半。
  const unguarded = srcs.filter((s) => !s.text || !/syntaxErrorOf\(/.test(s.text))
  claim(
    unguarded.length === 0,
    '表里每个生成器都在写盘/起进程之前调了语法守卫 syntaxErrorOf()',
    unguarded.length
      ? unguarded.map((s) => s.file).join(' / ') +
        ' 没有调用守卫 —— 生成物坏掉时又只剩"静默吊死 + 弹框给用户"这条路'
      : ''
  )

  // ⑤ 次序与早退：光"调了守卫"不够，还必须是**先验后写、验不过就早退**。
  //    这条治的是两种看起来接好了、实际没保护的写法：
  //      · 先 fs.writeFileSync 再验 ⇒ 坏脚本已经落盘了，仓库里留了个"点一下就弹框"的文件；
  //      · 拿到 bad 却不 return ⇒ 后面照样 spawn，用户看到的东西一模一样。
  //    （"守卫判得准不准"由 --selftest 负责；"真实产物能不能过"由上面 ③④ 负责。
  //      三者互补：判得准 / 接得上 / 次序对。）
  //    ⚠️ 另有一条**行为层**证据不进闸门，因为它要临时改工具源码（写入 tools/ 再删，
  //       万一进程被杀会留垃圾）：把 `} catch (err) {` 那一行从模板里删掉、另存成探针跑
  //       `--gen-only`，实测退出码 3、明确指到生成物第 79 行的 `}`、且产物 sha256 与跑之前
  //       逐字节相同（坏脚本没进仓库）。2026-09-24 手工复现过，10 秒可重做。
  const orderBad = srcs.filter((s) => {
    if (!s.text) return true
    const iGuard = s.text.indexOf('syntaxErrorOf(')
    const iWrite = s.text.indexOf('fs.writeFileSync(mainPath')
    const iSpawn = s.text.indexOf('spawnSync(ELECTRON')
    // 早退：从"接住返回值"那处起 600 字符内必须有 return。
    // 窗口是**有界**的 —— 无界的 [\s\S]*? 会一路匹配到文件尾的函数，那样等于没判。
    const iCatchReturn = s.text.indexOf('const bad = syntaxErrorOf(')
    const win = iCatchReturn < 0 ? '' : s.text.slice(iCatchReturn, iCatchReturn + 600)
    const hasEarlyReturn = /\breturn\s+\d/.test(win)
    return !(iGuard >= 0 && iWrite >= 0 && iSpawn >= 0 && iGuard < iWrite && iWrite < iSpawn && hasEarlyReturn)
  })
  claim(
    orderBad.length === 0,
    '表里每个生成器都是「先验语法 → 再写盘 → 才 spawn」，且验不过时早退（不改源码、不起进程）',
    orderBad.length
      ? orderBad
          .map((s) => {
            const g = s.text ? s.text.indexOf('syntaxErrorOf(') : -1
            const w = s.text ? s.text.indexOf('fs.writeFileSync(mainPath') : -1
            const p = s.text ? s.text.indexOf('spawnSync(ELECTRON') : -1
            return `${s.file}：守卫@${g} 写盘@${w} spawn@${p}` + (g < 0 ? '（没接守卫）' : '')
          })
          .join(' / ') + ' ⇒ 次序不对或没早退，等于没保护'
      : ''
  )

  // ③④ 真跑 --gen-only，验**真实生成物**
  for (const g of srcs) {
    const artifactAbs = path.join(ROOT, g.artifact)
    const label = `${g.file} --gen-only 的产物（${g.artifact}）本次真被重写、且语法通过`

    if (!g.text) {
      skip(label, `${g.file} 不存在`)
      continue
    }
    if (!fs.existsSync(path.join(ROOT, g.input))) {
      skip(label, `前置输入 ${g.input} 不在（可重建产物，本机还没生成过）`)
      continue
    }

    // ⚠️ 先删产物。不删的话，"产物语法通过"可能只是在验**上一轮留下的旧文件** ——
    //    这正是本仓库反复踩的"恒绿"形态：工具悄悄没写，断言照样绿。
    try {
      if (fs.existsSync(artifactAbs)) fs.rmSync(artifactAbs)
    } catch (error) {
      skip(label, `旧的产物删不掉（${(error && error.message) || error}）`)
      continue
    }

    // 走 spawnCapture：进程内 spawn node 时 stdio 管道会 EBUSY（见 tools/spawn-capture.mjs）
    const r = spawnCapture(NODE, [g.file, ...g.argv], { cwd: ROOT, timeout: 90000, env: childEnv() })
    const out = r.stdout || ''

    if (r.status !== 0) {
      claim(false, label, `--gen-only 退出码 ${r.status || '(被信号 ' + r.signal + ' 终止)'}。输出尾：\n      ${out.slice(-600).trim()}`)
      continue
    }
    if (!fs.existsSync(artifactAbs)) {
      claim(false, label, `--gen-only 报了成功，但 ${g.artifact} 没有被写出来（stdout：${out.trim().slice(0, 300)}）`)
      continue
    }
    if (!/GEN_ONLY_NO_ELECTRON/.test(out)) {
      // 没打这个标记 = 它其实起了 Electron。那闸门会变慢且可能吊住，必须报出来。
      claim(false, label, '--gen-only 没有打 GEN_ONLY_NO_ELECTRON 标记 ⇒ 它仍然启动了 Electron（闸门会变慢甚至吊住）')
      continue
    }

    const artifactSrc = fs.readFileSync(artifactAbs, 'utf8')
    const bad = syntaxErrorOf(artifactSrc, g.artifact)
    claim(
      bad === null && artifactSrc.length > 500 && /require\('electron'\)/.test(artifactSrc),
      label,
      bad
        ? `产物语法错：${bad.message}（${g.artifact}:${bad.line}）⇒ ${bad.snippet.trim()}`
        : `产物只有 ${artifactSrc.length} 字节、或里面没有 require('electron') ⇒ 写的不是那个脚本`
    )
  }
}

// ------------------------------------------------------------------ 自证

/**
 * 夹具**故意做成"删掉一行就坏"**的形状：那段 `try {` 与 `} catch (e) {` 之间的距离是 0 行，
 * 于是"把 catch 那行删掉"这一个动作就能确定性地造出 `Missing catch or finally`。
 * 这也是现场那个 bug 的形状（模板里 try 有、catch 没有）。
 */
const GOOD = [
  'const x = 1',
  'async function f() {',
  '  try {',
  '    await g()',
  '  } catch (e) {',
  '    console.error(e)',
  '  }',
  '}',
  'f()'
]
const CUT = '  } catch (e) {'

function runSelftest() {
  console.log('\n【自证】守卫本身必须会说「不」，也必须不冤枉好人')

  const cutIdx = GOOD.indexOf(CUT)
  const BAD_LINES = GOOD.filter((l) => l !== CUT)
  const badSrc = BAD_LINES.join('\n')

  // ① 控制组（正向）：语法正确的样本必须判通过。
  const good = syntaxErrorOf(GOOD.join('\n'), 'selftest/good.cjs')
  claim(
    good === null,
    '控制组：语法正确的样本判通过',
    good ? `冤枉了：报 ${good.message}（${good.line}）` : ''
  )

  // ② 防空转：那次"制造残缺"必须真的生效。
  //    ⚠️ 这条是这类自证的命门 —— 若 `indexOf` 没找到（返回 -1）或 filter 拼错，
  //    坏样本会退化成好样本，下面第 ③④ 条就**恒绿**（比假红更糟）。
  claim(
    cutIdx >= 0 && !badSrc.includes('catch') && (badSrc.match(/try \{/g) || []).length === 1,
    `残缺夹具真的残缺了（删掉了第 ${cutIdx + 1} 行的 catch；剩下的样本 try{ 有 1 个、catch 有 0 个）`,
    `删的位置 = ${cutIdx}，样本里 catch 出现 ${(badSrc.match(/catch/g) || []).length} 次 —— 夹具没造出来，下面两条恒绿`
  )

  // ③ 反向：坏样本必须被判错，且错在 catch 上。
  const bad = syntaxErrorOf(badSrc, 'selftest/missing-catch.cjs')
  claim(
    bad !== null && /catch/i.test(bad.message),
    '残缺样本被判错，且错点指向 catch',
    bad === null
      ? '坏样本被判通过了 —— 这道守卫是瞎的，形同不存在'
      : `报的是别的错：${bad.message} —— 说明夹具里除了那一处删除还有别的问题`
  )

  // ④ 行号可信：报出的行号必须与它摘录的源码行**自洽**，且落在那段函数体里。
  //    为什么单列一条：本仓库踩过"剥注释压掉换行 ⇒ 报出的行号指向不存在的行"，
  //    行号是假的比没有行号更坏 —— 人会照着去改另一行。
  const lineOk =
    bad !== null &&
    Number.isInteger(bad.line) &&
    bad.line >= 3 &&
    bad.line <= BAD_LINES.length &&
    bad.snippet === BAD_LINES[bad.line - 1]
  claim(
    lineOk,
    `报出的行号与源码行自洽（${bad ? `${bad.line} → 「${(bad.snippet || '').trim()}」` : '无'}）`,
    bad === null
      ? '坏样本根本没报错'
      : `line=${bad.line}（样本 ${BAD_LINES.length} 行），snippet=「${bad.snippet}」，` +
        `而那一行的原文是「${BAD_LINES[bad.line - 1]}」`
  )

  // ⑤ 反向控制组：把删掉的那行**补回去**必须重新判通过。
  //    没有这条，③ 的"报错"可能来自样本里任何别的东西，而不是那处删除。
  const restored = syntaxErrorOf(GOOD.join('\n'), 'selftest/restored.cjs')
  claim(
    restored === null,
    '反向控制组：把删掉的那行补回去 → 重新判通过（证明第 3 条的报错确实来自那处删除）',
    restored ? `补回去仍报错：${restored.message}（${restored.line}）` : ''
  )
}

// ------------------------------------------------------------------ 入口

const isSelftest = process.argv.includes('--selftest')
if (isSelftest) runSelftest()
else runRepo()

console.log('')
if (isSelftest) {
  console.log(`GEN_SCRIPT_GUARD_SELFTEST pass=${pass} total=${total}`)
  if (fail === 0) console.log('GEN_SCRIPT_GUARD_SELFTEST_OK')
} else {
  console.log(`GEN_SCRIPT_GUARD_STATS ok=${pass} total=${total} problems=${fail}`)
  if (fail === 0) console.log('GEN_SCRIPT_GUARD_OK')
}
// ⚠️ 收尾顺序：**成功标记先于一切收尾动作**，且退出码与标记同源。
//    本仓踩过"收尾的 fs.rmSync 抛错把紧跟其后的通过标记吃掉"⇒ 看着像断言挂了。
//    这里没有收尾动作（自证夹具全在内存里，不落盘、也就没有"删不掉"的问题）。
process.exit(fail === 0 ? 0 : 1)
