#!/usr/bin/env node
/**
 * 闸门 · 素材包（打包 / 解包）。
 *
 * 这一族错误的共同点：**包能打出来、也能解开，但里面是错的**。
 *   · 漏收复合片段里的孩子 / 多机位的机位文件 ⇒ 包"完整"，对面那几段黑屏；
 *   · 只改 path 不清 url ⇒ 对面还在读**我这台机器**的绝对路径（白名单里恰好登记过，时好时坏）；
 *   · CRC32 写错 / 中央目录偏移差 30 字节 ⇒ 我们自己读没问题，7-Zip 报"CRC 校验失败"；
 *   · 中文素材名不标 UTF-8 标志位 ⇒ 解出来是乱码目录；
 *   · 解包时不挡 `../` ⇒ 一个恶意包能往包外写文件（zip-slip）。
 *
 * 所以判据分三层：
 *   ① **纯算术**：collectSources 覆盖三种藏法、rewrite 双向、manifest 校验；
 *   ② **真 ZIP**：写一个真包再用自己的 reader 读回来逐字节比；
 *   ③ **外部独立解压器**：把包交给 Windows 自带的 `Expand-Archive`（完全另一套实现），
 *      解出来的文件数与内容必须一致 —— 这一层才真正证明"这是标准 ZIP"。
 *
 * 用法：node tools/check-pack.mjs
 * 退出码：0 通过 / 1 有失败
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'pack.js')
const MAIN_PACK = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'pack.js')
const ZIP = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'zip.js')

const pack = require(SHARED)
const mainPack = require(MAIN_PACK)
const zip = require(ZIP)

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-pack-check-'))
const fileOf = (name, bytes = 64) => {
  const filePath = path.join(work, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 7))
  return filePath
}

console.log('=== 素材包 · 规则与 ZIP 编解码 ===\n')

/* ---------------------------- ① 文件名与路径 ---------------------------- */
console.log('-- 文件名与路径 --')
check('安全名 · 保留中文与扩展名', pack.sanitizeBase('C:\\v\\我的 素材#1.MP4') === '我的_素材_1.mp4',
  pack.sanitizeBase('C:\\v\\我的 素材#1.MP4'))
check('安全名 · 空路径回落 media', pack.sanitizeBase('') === 'media', pack.sanitizeBase(''))
check('安全名 · 去掉尾部脏字符', pack.sanitizeBase('a b;.mov') === 'a_b.mov', pack.sanitizeBase('a b;.mov'))
check('包内路径 · 三位序号 + media 目录', pack.packPath(7, 'x/y.mp4') === 'media/007_y.mp4', pack.packPath(7, 'x/y.mp4'))
check('包内路径 · 同名不同目录不会撞', pack.packPath(1, 'a/x.mp4') !== pack.packPath(2, 'b/x.mp4'))

/* ------------------------- ② collectSources 的三种藏法 ------------------------- */
console.log('\n-- 收集引用（普通 / 复合 / 多机位 / 素材表）--')
const pMain = fileOf('main.mp4')
const pChild = fileOf('child.mp4')
const pArc = fileOf('arc.mp4')
const pAngle2 = fileOf('cam2.mp4')
const pOnlyAsset = fileOf('asset-only.wav')
const data = {
  clips: [
    { id: 'c1', track: 'video', path: pMain, url: 'u1', start: 0, duration: 2 },
    {
      id: 'c2',
      track: 'video',
      kind: 'compound',
      path: '',
      compound: { span: 3, children: [{ id: 'k1', track: 'video', path: pChild, start: 0, duration: 3 }] }
    },
    {
      id: 'c3',
      track: 'video',
      kind: 'multicam',
      path: '',
      multicam: { angles: [{ path: pArc, offset: 0 }, { path: pAngle2, offset: 0 }], cuts: [{ at: 0, angle: 0 }] }
    }
  ],
  assets: [
    { id: 'a1', path: pMain, kind: 'video' },
    { id: 'a2', path: pOnlyAsset, kind: 'audio' }
  ]
}
const collected = pack.collectSources(data.clips, data.assets)
check('收齐 5 个文件（含复合孩子与两路机位）', collected.sources.length === 5, String(collected.sources.length))
check('复合片段的孩子被收到', collected.sources.includes(pChild))
check('多机位每一路都被收到', collected.sources.includes(pArc) && collected.sources.includes(pAngle2))
check('只出现在素材表里的也被收到', collected.sources.includes(pOnlyAsset))
check('同一文件不重复入包', collected.sources.filter((item) => item === pMain).length === 1)
check('引用计数正确（主素材被片段+素材表各引一次）', collected.refs[pMain] === 2, String(collected.refs[pMain]))

/* ----------------------------- ③ 双向改写 ----------------------------- */
console.log('\n-- 路径改写（导出 → 导入）--')
const mapping = pack.buildMapping(collected.sources)
const exported = pack.rewriteForExport(data, mapping)
const packedRel = exported.clips[0].path
check('导出 · path 换成包内相对路径', /^media\/\d{3}_/.test(packedRel), packedRel)
check('导出 · url 被清空（否则对面读我这台机器的绝对路径）', exported.clips[0].url === '', String(exported.clips[0].url))
check('导出 · 复合孩子也被改写', /^media\/\d{3}_/.test(exported.clips[1].compound.children[0].path))
check('导出 · 机位也被改写', exported.clips[2].multicam.angles.every((item) => /^media\/\d{3}_/.test(item.path)))
check('导出 · 不改动原草稿（原 path 还是绝对路径）', data.clips[0].path === pMain, data.clips[0].path)

const imported = pack.rewriteForImport(exported, 'D:\\packs\\p1')
check('导入 · path 拼回解包目录', imported.clips[0].path === 'D:\\packs\\p1\\media\\' + path.basename(imported.clips[0].path.replace(/\//g, '\\')),
  imported.clips[0].path)
check('导入 · 绝对路径原样保留（缺的那几个不会变成假路径）',
  pack.rewriteForImport({ clips: [{ path: 'C:\\gone.mp4' }], assets: [] }, 'D:\\p').clips[0].path === 'C:\\gone.mp4')
const attached = pack.attachUrls(JSON.parse(JSON.stringify(imported)), { [imported.clips[2].multicam.angles[1].path]: 'yjai-media://local/AAA' })
check('贴 url · 机位也能贴上（否则切到机位 2 就黑）', attached.clips[2].multicam.angles[1].url === 'yjai-media://local/AAA')

/* ---------------------------- ④ manifest ---------------------------- */
console.log('\n-- 清单校验 --')
const manifest = pack.buildManifest({ name: '工程 A', files: [{ file: 'media/001_a.mp4', bytes: 100 }], createdAt: '2026-01-01T00:00:00.000Z' })
check('清单 · 带 kind 与版本', manifest.kind === 'yijing-pack' && manifest.version === pack.PACK_VERSION)
check('清单 · 字节数合计', manifest.totalBytes === 100, String(manifest.totalBytes))
check('清单 · 读回来合法', Boolean(pack.readManifest(manifest)))
check('清单 · 别的 zip 被拒（kind 不对）', pack.readManifest({ kind: 'other', version: 1 }) === null)
check('清单 · 未来版本被拒（别乱解新格式）', pack.readManifest({ kind: 'yijing-pack', version: 99 }) === null)
check('包名 · 带中文草稿名', pack.packFileName('我的工程') === '我的工程-素材包.yjpack', pack.packFileName('我的工程'))
check('说明文件 · 含解包提示', pack.readmeText('A').includes('导入素材包'))

/* ------------------------------- ⑤ 真 ZIP ------------------------------- */
console.log('\n-- 真 ZIP 写读 --')
const zipPath = path.join(work, 'roundtrip.yjpack')
const sample = Buffer.from('艺镜素材包 CRC 校验样本', 'utf8')
const written = zip.writeZip(zipPath, [
  { name: 'draft.json', data: Buffer.from('{"clips":[]}', 'utf8') },
  { name: 'media/001_画面.mp4', data: sample }
])
check('写 zip · 文件真的落盘', fs.existsSync(zipPath) && fs.statSync(zipPath).size === written.bytes,
  String(fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0))

const entries = zip.readZip(zipPath)
check('读 zip · 条目数 2', entries.length === 2, String(entries.length))
check('读 zip · 中文名按 UTF-8 解回', entries.some((item) => item.name === 'media/001_画面.mp4'),
  entries.map((item) => item.name).join(','))
check('读 zip · 内容逐字节一致', entries.find((item) => item.name === 'media/001_画面.mp4').data.equals(sample))
check('CRC32 · 空串是 0', zip.crc32(Buffer.alloc(0)) === 0)
/* 独立来源的已知值：'123456789' 的 IEEE CRC32 = 0xCBF43926 */
check('CRC32 · 与标准向量一致（0xCBF43926）', zip.crc32(Buffer.from('123456789')) === 0xcbf43926,
  '0x' + zip.crc32(Buffer.from('123456789')).toString(16))

/* --------------------- ⑥ 外部解压器（独立实现，真正的判据） --------------------- */
console.log('\n-- 外部解压器核对（Windows Expand-Archive / bsdtar）--')
const unzipDir = path.join(work, 'unzipped')
/* ⚠️ Expand-Archive **只按扩展名**判断（.yjpack 它会直接拒绝，报"只支持 .zip"），
   所以核对时复制成 .zip 再解 —— 内容完全相同，这一步只是为了过它的扩展名检查。 */
const zipAlias = path.join(work, 'roundtrip.zip')
fs.copyFileSync(zipPath, zipAlias)

/**
 * 找一台**真能跑**的外部解压器。
 *
 * 为什么不能直接 execFileSync('powershell')（2026-10-28 实测）：这条命令靠 PATH
 * 上的 `System32\WindowsPowerShell\v1.0` 才能解析；本机（不少 CI 也一样）PATH 里
 * 只有 `System32`，于是直接 ENOENT，三条外部解压判据一起变红 —— 报错长得像
 * "包不是标准 ZIP"，其实跟包一点关系都没有。闸门假红和闸门空转一样有害：
 * 假红会训练人无脑忽略它。
 *
 * 所以改成先按绝对路径找，再退回裸名；两个独立实现互为兜底
 * （Expand-Archive 和 bsdtar 是两套完全不同的代码，任一个能解开都足以证明标准 ZIP）。
 */
function externalUnzippers() {
  const roots = [process.env.SystemRoot, process.env.windir, 'C:\\Windows'].filter(Boolean)
  const list = []
  for (const root of roots) {
    const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (fs.existsSync(ps)) {
      list.push({
        name: 'powershell',
        bin: ps,
        args: ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${zipAlias}' -DestinationPath '${unzipDir}' -Force`]
      })
    }
    const tar = path.join(root, 'System32', 'tar.exe')
    if (fs.existsSync(tar)) {
      list.push({ name: 'bsdtar', bin: tar, args: ['-xf', zipAlias, '-C', unzipDir] })
    }
  }
  // 绝对路径都没找到时退回裸名（非 Windows 或非常规安装）
  if (!list.length) list.push({ name: 'powershell', bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipAlias}' -DestinationPath '${unzipDir}' -Force`] })
  return list
}

let externalOk = false
let externalDetail = ''
const unzippers = externalUnzippers()
for (const item of unzippers) {
  try {
    fs.mkdirSync(unzipDir, { recursive: true })
    execFileSync(item.bin, item.args, { stdio: 'pipe', windowsHide: true })
    externalOk = true
    externalDetail = `${item.name} 解开`
    break
  } catch (error) {
    externalDetail = `${item.name}: ` + String(error.stderr || error.message).slice(0, 140)
  }
}
check('系统解压器能解开这个包（说明它是标准 ZIP）', externalOk,
  externalDetail || `试过 ${unzippers.map((item) => item.name).join(' / ')}`)
if (externalOk) {
  const names = fs.existsSync(unzipDir) ? fs.readdirSync(path.join(unzipDir, 'media')) : []
  check('系统解压器看到的中文文件名一致', names.length === 1 && names[0] === '001_画面.mp4', names.join(','))
  const back = path.join(unzipDir, 'media', '001_画面.mp4')
  check('系统解压器解出的内容逐字节一致（CRC 与数据结构都对）',
    fs.existsSync(back) && fs.readFileSync(back).equals(sample))
} else {
  check('系统解压器看到的中文文件名一致', false, '上一步失败')
  check('系统解压器解出的内容逐字节一致（CRC 与数据结构都对）', false, '上一步失败')
}

/* ---------------------- ⑦ zip-slip：恶意包必须被拒 ---------------------- */
console.log('\n-- zip-slip 防护 --')
const evilPath = path.join(work, 'evil.yjpack')
zip.writeZip(evilPath, [{ name: '../escaped.txt', data: Buffer.from('x') }])
let slipped = false
try {
  zip.extractZip(evilPath, path.join(work, 'evil-out'))
  slipped = true
} catch {
  slipped = false
}
check('带 ../ 的条目被拒绝解压', slipped === false)

/* --------------------- ⑧ 主进程 export / import 全链路 --------------------- */
console.log('\n-- exportPack / importPack 真跑 --')
const inspect = mainPack.inspectPackData(data)
check('体检 · 5 个素材全部找到', inspect.total === 5 && inspect.missing.length === 0,
  `total=${inspect.total} missing=${inspect.missing.length}`)
check('体检 · 算出总字节数', inspect.totalBytes > 0, String(inspect.totalBytes))
const broken = mainPack.inspectPackData({ clips: [{ path: path.join(work, 'nope.mp4') }], assets: [] })
check('体检 · 缺失素材被点名（不是静默跳过）', broken.missing.length === 1 && broken.missingNames.length === 1,
  broken.missingNames.join(','))

const outPack = path.join(work, 'out-工程.yjpack')
const exportedResult = mainPack.exportPack({ data, name: '工程 A', outPath: outPack })
check('导出 · 成功且素材数 5', exportedResult.ok && exportedResult.packed === 5, JSON.stringify({ ok: exportedResult.ok, packed: exportedResult.packed, err: exportedResult.error }))
check('导出 · 没有 missing', Array.isArray(exportedResult.missing) && exportedResult.missing.length === 0)
const packEntries = exportedResult.ok ? zip.readZip(outPack) : []
check('包内 · 有 draft.json / manifest.json / README.txt',
  ['draft.json', 'manifest.json', 'README.txt'].every((name) => packEntries.some((item) => item.name === name)),
  packEntries.map((item) => item.name).join(','))
check('包内 · media 下 5 个文件', packEntries.filter((item) => item.name.startsWith('media/')).length === 5,
  String(packEntries.filter((item) => item.name.startsWith('media/')).length))
check('包里没有 .tmp 残留', !fs.existsSync(`${outPack}.tmp`))

const destDir = path.join(work, 'imported')
const importedResult = mainPack.importPack({
  packPath: outPack,
  destDir,
  registerUrl: (filePath) => `yjai-media://local/${Buffer.from(filePath, 'utf8').toString('base64url')}`
})
check('导入 · 成功', importedResult.ok, importedResult.error)
check('导入 · 素材全部落地', importedResult.ok && importedResult.mediaCount === 5, String(importedResult.mediaCount))
check('导入 · 没有 missing', importedResult.ok && importedResult.missing.length === 0)
const back0 = importedResult.ok ? importedResult.data.clips[0] : {}
check('导入 · path 指回解包目录', importedResult.ok && back0.path.startsWith(destDir), String(back0.path))
check('导入 · url 按新路径重新生成', importedResult.ok && String(back0.url).startsWith('yjai-media://local/'), String(back0.url))
check('导入 · 机位也拿到 url', importedResult.ok && importedResult.data.clips[2].multicam.angles.every((item) => item.url),
  JSON.stringify(importedResult.ok ? importedResult.data.clips[2].multicam.angles.map((item) => item.url ? 'ok' : '') : []))
check('导入 · 文件真的在磁盘上', importedResult.ok && fs.existsSync(back0.path))
check('导入 · 时间线结构不变（3 段）', importedResult.ok && importedResult.data.clips.length === 3)

/* 不是我们的包 ⇒ 拒收，且**不要在磁盘上留下一堆垃圾** */
const foreignPath = path.join(work, 'foreign.zip')
zip.writeZip(foreignPath, [{ name: 'a.txt', data: Buffer.from('hi') }])
const foreignDest = path.join(work, 'foreign-out')
const foreign = mainPack.importPack({ packPath: foreignPath, destDir: foreignDest, registerUrl: () => 'u' })
check('导入 · 非本应用的包被拒', foreign.ok === false && /不是艺镜素材包/.test(String(foreign.error)), String(foreign.error))
check('导入 · 拒收时不往磁盘写文件', !fs.existsSync(path.join(foreignDest, 'a.txt')))

console.log('')
if (failures.length) {
  console.log('失败项：')
  for (const item of failures) console.log('  · ' + item)
}
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (!fail) console.log('PACK_OK')
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch {
  /* 删不掉就留着 */
}
process.exit(fail ? 1 : 0)
