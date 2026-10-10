#!/usr/bin/env node
/**
 * 配图「有没有真的被用上」校验器。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 为了 1:1 对齐，仓库里导了很多配图（`assets/art/**`，卡片族 + 弹窗族）。
 * 导图这一步是脚本批量做的，**批量做的事最容易只做一半**，而且两种半个都静默：
 *
 *   ① **孤儿素材** —— 文件导进仓库了，但没有任何模块 import 它。
 *      症状：磁盘上多了一张图，界面上永远看不到。占位清单只认文件在不在、
 *      指纹对不对，**它不管有没有人用**；`check-imports` 只管"导入的路径能不能解析"，
 *      对"没人导入"这件事无话可说。
 *
 *   ② **导了不用** —— import 写了，正文里一次都没出现。
 *      Rollup 会把它 tree-shake 掉：**构建成功、产物里没有这张图、界面上一片空白**，
 *      构建日志 0 warning。这与 `check-imports` 治的那类"少写了一个 import"
 *      正好互为镜像，两个都得有人管。
 *
 * 判据（刻意简单、可解释）：
 *   · 素材文件是否出现在某条 import 的路径里 → 否则算孤儿；
 *   · 某个导入标识符在本文件里出现次数 ≥ 2（声明 1 次 + 至少使用 1 次）→ 否则算导了不用。
 *
 * ⚠️ 第二条是**启发式**，不是数据流分析：`import a from '...'` 之后
 *    `export default a` 会被算作"用了"，但它只是转手再导出、未必渲染。
 *    挡不住"转手导出"这种更深的形态（那需要真解析 AST）。这条界线是清楚的：
 *    它治的是**根本没写使用点**，不假装能治"用了但用错了"。
 *    "用了但用错了"归 workbench-tabs / workbench-buttons 那两道真点一遍的闸门管。
 *
 * 用法：
 *   node tools/check-art-consumed.mjs              # 校验仓库
 *   node tools/check-art-consumed.mjs --selftest   # 自证（合成夹具正反两面）
 *   node tools/check-art-consumed.mjs --list       # 列出每张图被谁导入
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 素材根目录（相对仓库根） */
const ART_DIR = 'packages/desktop/src/renderer/assets/art'
/** 扫描导入的源码根目录（相对仓库根） */
const SRC_DIR = 'packages/desktop/src/renderer'

const ART_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']
const SRC_EXTS = ['.js', '.jsx', '.mjs']

/** 逐层列出某个目录下的全部文件（相对 dir 的正斜杠路径） */
function walk(dir, exts, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(abs, exts, base, out)
    } else if (exts.includes(path.extname(entry.name).toLowerCase())) {
      out.push(path.relative(base, abs).split(path.sep).join('/'))
    }
  }
  return out.sort()
}

/**
 * 单趟从左到右把源码里的 import 语句读出来。
 *
 * ⚠️ 为什么强调"单趟"：这类脚本最常见的坏法是多步正则替换互不知情
 *    （本项目 `check-imports` 就因为多步替换吃掉过一个 `export`，是**漏报**）。
 *    这里不做替换，只做一条 `import ... from '...'` 的匹配，逐条收集。
 *
 * 返回 [{ idents: string[], spec: string, line: number }]
 */
export function readImports(text) {
  const out = []
  const lines = text.split('\n')
  // 只认行首的 import（本项目所有导入都在文件头，逐行读足够且不会误伤字符串里的 "import"）
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const m = /^\s*import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/.exec(line)
    if (!m) continue
    const idents = []
    const head = m[1].trim()
    if (head.startsWith('{')) {
      // 命名导入：`{ a as b, c }`
      for (const piece of head.replace(/[{}]/g, '').split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop()
        if (name) idents.push(name.trim())
      }
    } else if (head.startsWith('*')) {
      const name = head.split(/\s+as\s+/).pop()
      if (name) idents.push(name.trim())
    } else {
      // 默认导入（可带命名导入尾巴：`a, { b }`）
      const [first, ...rest] = head.split(',')
      if (first.trim()) idents.push(first.trim())
      for (const piece of rest.join(',').replace(/[{}]/g, '').split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop()
        if (name) idents.push(name.trim())
      }
    }
    out.push({ idents, spec: m[2], line: i + 1 })
  }
  return out
}

/** 标识符在正文里的出现次数（按词边界数，避免 `artLimit` 命中 `artLimitMore`） */
function usesOf(text, ident) {
  const re = new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  return (text.match(re) || []).length
}

/** 判断一行是不是 import 语句（与 readImports 用同一条正则，避免两处判据漂移） */
function isImportLine(line) {
  return /^\s*import\s+[^'"]+?\s+from\s+['"][^'"]+['"]/.test(line)
}

/**
 * 去掉 import 语句后的文件正文。
 *
 * ⚠️ 必须去掉再数使用次数 —— 这是自证夹具抓出来的真 bug（2026-09-23）：
 *    夹具里 `import b from '.../good/b.png'` 只导入、正文一次没用，
 *    但按词边界数 `b` 会命中**导入路径里那个 `b`**（`/good/b.png` 前后都是非单词字符），
 *    于是"声明 1 次 + 路径里 1 次"= 2，判成"用过了" ⇒ 这条检测**恒绿**。
 *    真仓里因为标识符都起得比较长（`artLimitAudio`）恰好没暴露 —— 这类"夹具一写就露馅、
 *    真仓反而全绿"的写法最危险，所以自证夹具必须用**短名**（a / b）构造。
 */
function bodyOf(text) {
  return text
    .split('\n')
    .map((line) => (isImportLine(line) ? '' : line))
    .join('\n')
}

/**
 * 主校验。root / artDir / srcDir 可注入，便于 selftest 用合成夹具。
 * @returns {{total:number, ok:number, problems:string[], orphans:string[], unused:object[], imports:object[]}}
 */
export function runCheck({ root = ROOT, artDir = ART_DIR, srcDir = SRC_DIR } = {}) {
  const problems = []
  let ok = 0
  let asserted = 0
  const claim = (pass, label, detail = '') => {
    asserted += 1
    if (pass) ok += 1
    else if (detail) problems.push(detail)
    console.log(`  ${pass ? '✓' : '✗'} ${label}${pass || !detail ? '' : ` —— ${detail}`}`)
    return pass
  }

  const artRoot = path.join(root, artDir)
  const srcRoot = path.join(root, srcDir)
  const artFiles = walk(artRoot, ART_EXTS)

  /** 导入记录：{ file, spec, abs, idents, module } */
  const records = []
  for (const rel of walk(srcRoot, SRC_EXTS)) {
    const abs = path.join(srcRoot, rel)
    const text = fs.readFileSync(abs, 'utf8')
    const body = bodyOf(text)
    for (const item of readImports(text)) {
      if (!item.spec.startsWith('.')) continue
      const target = path.resolve(path.dirname(abs), item.spec)
      records.push({ module: rel, spec: item.spec, target, idents: item.idents, body })
    }
  }

  // 素材 → 谁导入了它
  const importedTargets = new Set(records.map((r) => path.resolve(r.target)))
  const refersToArt = records.filter((r) => {
    const rel = path.relative(artRoot, path.resolve(r.target)).split(path.sep).join('/')
    return !rel.startsWith('..')
  })

  // ---------------- 全局断言 1/3：防空转（两边都真的扫到东西） ----------------
  const scanOk = artFiles.length > 0 && refersToArt.length > 0
  claim(
    scanOk,
    `扫到素材 ${artFiles.length} 张 · 指向素材的导入 ${refersToArt.length} 条`,
    `扫描结果为空（素材 ${artFiles.length} 张 / 导入 ${refersToArt.length} 条）—— ` +
      '多半是目录改名或扫描根写错。**"扫不到"不等于"没问题"**，所以这里直接判失败。'
  )

  // ---------------- 全局断言 2/3：没有孤儿素材 ----------------
  const orphans = artFiles.filter((rel) => !importedTargets.has(path.resolve(path.join(artRoot, rel))))
  claim(
    orphans.length === 0,
    `没有「磁盘上有、没人导入」的孤儿素材（共 ${artFiles.length} 张）`,
    `以下素材导进了仓库却没有任何模块 import 它（界面上永远看不到）：${orphans.slice(0, 6).join(' / ')}` +
      (orphans.length > 6 ? ` … 共 ${orphans.length} 张` : '')
  )

  // ---------------- 全局断言 3/3：没有「导了不用」 ----------------
  const unused = []
  for (const r of refersToArt) {
    for (const ident of r.idents) {
      // 正文里至少出现 1 次才算"有使用点"（import 行已被 bodyOf 剥掉）
      if (usesOf(r.body, ident) < 1) unused.push({ module: r.module, ident, spec: r.spec })
    }
  }
  claim(
    unused.length === 0,
    `没有「import 了却一次没用」的图（共 ${refersToArt.reduce((n, r) => n + r.idents.length, 0)} 个导入标识符）`,
    `以下导入在正文里一次都没出现（只有声明、没有使用点），Rollup 会把它们 tree-shake 掉 —— ` +
      '构建成功、产物里没有这张图、界面上一片空白：' +
      unused.slice(0, 6).map((u) => `${u.module} → ${u.ident}`).join(' / ') +
      (unused.length > 6 ? ` … 共 ${unused.length} 个` : '')
  )

  return { total: 3, ok, problems, orphans, unused, imports: refersToArt, artFiles }
}

/* ------------------------------------------------------------------ 自证 */

const FIXTURE_ART = 'assets/art'
const FIXTURE_SRC = 'mods'

/**
 * 合成夹具。**必须同时含正向与反向**：
 *   good.jsx 里 a.png 正常用、b.png 导了不用；
 *   lonely/c.png 在磁盘上但没人导入；
 *   quiet.jsx 什么都不导入。
 * 只放反向（都坏）会让"恒红"的检查器也通过；只放正向则会放过恒绿。
 */
function writeFixture(dir, { healthy = false } = {}) {
  // ⚠️ 目录由 mkdtempSync 造，**每次都是新的**，所以这里不需要先清空 ——
  //    而"先清空"正是会踩宿主批量删除守卫的那一步（见文件末尾 selftest 的注释）。
  const mk = (rel, content) => {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  mk(`${FIXTURE_ART}/good/a.png`, png)
  mk(`${FIXTURE_ART}/good/b.png`, png)
  if (!healthy) mk(`${FIXTURE_ART}/lonely/c.png`, png)

  if (healthy) {
    // 控制组：两张图都用上，没有孤儿
    mk(
      `${FIXTURE_SRC}/good.jsx`,
      "import a from '../assets/art/good/a.png'\n" +
        "import b from '../assets/art/good/b.png'\n" +
        'export const Pair = () => <>\n' +
        '  <img src={a} alt="" />\n' +
        '  <img src={b} alt="" />\n' +
        '</>\n'
    )
  } else {
    mk(
      `${FIXTURE_SRC}/good.jsx`,
      "import a from '../assets/art/good/a.png'\n" +
        "import b from '../assets/art/good/b.png'\n" +
        'export const One = () => <img src={a} alt="" />\n'
    )
  }
  mk(`${FIXTURE_SRC}/quiet.jsx`, 'export const Nothing = () => null\n')
  return dir
}

function selftest() {
  // 两套夹具各用一个独立目录：控制组如果与反向夹具共用同一个目录，
  // 上一轮留下的 `lonely/c.png` 会**污染控制组**（它会莫名其妙地变成红的）——
  // 控制组必须是干净的，否则它证明不了任何事。
  const shotA = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-refart-a-'))
  const shotB = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-refart-b-'))
  let ok = 0
  let total = 0
  const claim = (pass, label, detail = '') => {
    total += 1
    if (pass) ok += 1
    console.log(`  ${pass ? '✓' : '✗'} ${label}${pass || !detail ? '' : ` —— ${detail}`}`)
  }

  console.log('— 夹具 A：同时含「孤儿素材」与「导了不用」（两条失败分支都要被报出）')
  writeFixture(shotA, { healthy: false })
  const bad = runCheck({ root: shotA, artDir: FIXTURE_ART, srcDir: FIXTURE_SRC })
  claim(
    bad.orphans.includes('lonely/c.png'),
    '夹具里的孤儿素材 lonely/c.png 被报出',
    `没报出来（实际 orphans=${JSON.stringify(bad.orphans)}）—— 说明这条检测恒绿`
  )
  claim(
    bad.unused.some((u) => u.ident === 'b'),
    '夹具里「导了不用」的 b 被报出',
    `没报出来（实际 unused=${JSON.stringify(bad.unused)}）—— 说明这条检测恒绿`
  )
  // 防空转：确认扫描器真的数到了夹具里的东西，而不是"扫不到所以没问题"
  claim(
    bad.artFiles.length === 3 && bad.imports.length === 2,
    '扫描器数到夹具的 3 张素材 / 2 条导入（防空转）',
    `数到素材 ${bad.artFiles.length} 张 / 导入 ${bad.imports.length} 条，与夹具不符`
  )

  console.log('— 夹具 B：控制组（全部正常），必须判通过')
  writeFixture(shotB, { healthy: true })
  const good = runCheck({ root: shotB, artDir: FIXTURE_ART, srcDir: FIXTURE_SRC })
  claim(
    good.total === 3 && good.ok === 3,
    '控制组 3/3 通过（一个恒红的检查器骗不过这一条）',
    `控制组只有 ${good.ok}/${good.total} 通过：${good.problems.join('；')}`
  )

  // ⚠️ 收尾顺序：**成功标记先打印，清理放最后，而且不许抛**
  //    （2026-09-23 实测踩到，与 MEMORY.md 里那条"成功标记先于清理打印"同源）：
  //    跑整套闸门时这道自证报的是「退出码 1；未出现通过标记；解析不到断言数」，
  //    单跑却是绿的 —— 真因是宿主给 `fs.rmSync` 套了一层 node shim，
  //    它的**批量删除守卫**在本回合累计删除数超阈值后直接抛
  //    `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，把紧跟其后的 `..._SELFTEST_OK` 一起吃掉了。
  //    断言其实全过了，报出来却像"检查器挂了"。⇒ 清理一律 try/catch + 放在标记之后。
  console.log(`\nREF_ART_CONSUMED_SELFTEST pass=${ok} total=${total}`)
  if (ok === total) console.log('REF_ART_CONSUMED_SELFTEST_OK')

  try {
    fs.rmSync(shotA, { recursive: true, force: true })
    fs.rmSync(shotB, { recursive: true, force: true })
  } catch (error) {
    // 删不掉不影响结论：夹具在 os.tmpdir() 下，系统重启会清；留下来说明是哪条路被拦住了
    console.log(`  （夹具清理被拦，不影响结论：${(error && error.message) || error}）`)
  }
  return { total, ok }
}

/* ------------------------------------------------------------------ CLI */

const argv = process.argv.slice(2)
if (argv.includes('--selftest')) {
  const r = selftest()
  process.exitCode = r.ok === r.total ? 0 : 1
} else {
  console.log('配图消费点校验（导了没人用 / 有人用没导入，两种半个都查）')
  console.log(`  素材根 ${ART_DIR}`)
  console.log(`  源码根 ${SRC_DIR}`)
  const r = runCheck()
  if (argv.includes('--list')) {
    console.log('\n每张图被谁导入：')
    const byTarget = new Map()
    for (const item of r.imports) {
      const key = path.relative(path.join(ROOT, ART_DIR), item.target).split(path.sep).join('/')
      if (!byTarget.has(key)) byTarget.set(key, [])
      byTarget.get(key).push(item.module)
    }
    for (const rel of r.artFiles) {
      console.log(`  ${rel} ← ${(byTarget.get(rel) || ['（没人导入）']).join(', ')}`)
    }
  }
  console.log(`\nREF_ART_CONSUMED_STATS ok=${r.ok} total=${r.total} problems=${r.problems.length}`)
  if (r.ok === r.total) console.log('REF_ART_CONSUMED_OK')
  process.exitCode = r.ok === r.total ? 0 : 1
}
