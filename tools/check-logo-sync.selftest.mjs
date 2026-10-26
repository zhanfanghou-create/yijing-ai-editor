#!/usr/bin/env node
/**
 * check-logo-sync.mjs 的自证夹具 —— 证明这道闸门**真的会比、且比不过时会红**。
 *
 * 一个检查器如果永远输出 OK，它跟没有是一样的。这里刻意造出九种"应该失败"的
 * 场景（源图/产物缺失、比错方向、帧缺失、安装器三处产物过期、同尺寸像素不同），
 * 逐一确认它会以非 0 退出并给出可操作的修复命令。
 *
 * 夹具用的是仓库里的**常驻文件**（tools/fixtures/logo-from-64.png），
 * 不是临时目录里的东西 —— 临时夹具下次跑可能就没了，自证会退化成空转。
 * 安装器那几项例外：它们现搭一棵临时树，但"对的基准"永远取仓库里的真产物，
 * 只在临时树里改坏一处，所以不会随图标换代而腐烂。
 *
 * 用法：node tools/check-logo-sync.selftest.mjs
 */
import { spawnCapture } from './spawn-capture.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

/**
 * 跑一次检查器，拿 { code, out } —— 不抛异常，退出码自己判。
 *
 * ⚠️ 走 spawnCapture 而不是 execFileSync：本机在进程内部 spawn node 时
 * stdio 管道会 EBUSY（见 tools/spawn-capture.mjs），自证会整片假红。
 */
function run(args, extraEnv) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : undefined
  const r = spawnCapture(process.execPath, [path.join(__dirname, 'check-logo-sync.mjs'), ...args], { env })
  return { code: r.status ?? 1, out: r.stdout || '' }
}

/**
 * 生成一张**纯色** PNG，用来造"尺寸一样、像素不一样"的坏图。
 *
 * 为什么要手写编码：安装器的 app256 是拿 64px 的旧图冒充时，尺寸就不对，
 * 只能测到"尺寸不同"这条分支；而真实漂移最常见的样子是**尺寸一模一样、
 * 只是画的是上一版 logo**。不造一张同尺寸的坏图，逐像素比较那段代码
 * 就等于没被验过（自证只会在绿色上路过它）。
 *
 * 只写 filter=0 的 8bit RGBA，十几行够用。
 */
function solidPng(size, [r, g, b, a]) {
  const crcTable = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, tail])
  }
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1) + 1
    for (let x = 0; x < size; x++) {
      const t = rowStart + x * 4
      raw[t] = r
      raw[t + 1] = g
      raw[t + 2] = b
      raw[t + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const ICO = path.join(ROOT, 'ico', '256X256.ico')
const PNG = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'logo-256.png')
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'logo-from-64.png')

/* --------- 安装器夹具：整棵树在临时目录里现搭，只借用仓库里的真产物当"对的" --------- */

const INST_ASSETS = path.join(ROOT, 'packages', 'installer', 'src', 'assets')
const DESKTOP_ICO = path.join(ROOT, 'packages', 'desktop', 'build', 'icon.ico')
const tmpDirs = []

/**
 * 搭一份**当前仓库状态的拷贝**，再按 `mutate` 改坏指定的一处。
 *
 * 为什么现搭而不是在仓库里存一份"过期的图标"：存了就会有人以为是真产物，
 * 而且下次重出图标时它不会跟着变（夹具自己先腐烂掉，比没有夹具更糟）。
 * 这里"对的基准"永远是仓库里的真文件，坏掉的那一处才是夹具。
 */
function makeInstallerDir(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-inst-'))
  tmpDirs.push(dir)
  for (const sub of ['src/assets', 'build', 'resources']) {
    fs.mkdirSync(path.join(dir, ...sub.split('/')), { recursive: true })
  }
  fs.copyFileSync(path.join(INST_ASSETS, 'app256.png'), path.join(dir, 'src', 'assets', 'app256.png'))
  fs.copyFileSync(path.join(INST_ASSETS, 'logo48.png'), path.join(dir, 'src', 'assets', 'logo48.png'))
  fs.copyFileSync(DESKTOP_ICO, path.join(dir, 'build', 'icon.ico'))
  fs.copyFileSync(DESKTOP_ICO, path.join(dir, 'resources', 'icon.ico'))
  if (mutate) mutate(dir)
  return dir
}

// 夹具必须真在仓库里，否则下面那条"应该失败"的断言会变成因为文件不存在才失败
check('夹具文件存在于仓库内', fs.existsSync(FIXTURE), FIXTURE)
check('源图 ico/256X256.ico 存在', fs.existsSync(ICO), ICO)
check('渲染层 logo-256.png 存在', fs.existsSync(PNG), PNG)

// 1. 正常情况必须过 —— 且必须**五项都在真跑**（少了项数就是有检查被悄悄跳过）
{
  const r = run([])
  check('当前仓库状态 → PASS', r.code === 0 && /LOGO_SYNC_OK/.test(r.out), r.out.trim())
  check(
    '默认模式跑满 5 项（渲染层 + 安装器 2 图 + 2 个 icon.ico）',
    /LOGO_SYNC_STATS total=5 pass=5 fail=0/.test(r.out),
    r.out.trim()
  )
}

// 2. 核心：给一个**对不上的** logo，必须红。这条要是过了，说明这个检查是空转的。
{
  const r = run([ICO, FIXTURE, '256'])
  check('logo 与源图不一致 → FAIL', r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out), r.out.trim())
  check(
    '失败信息里带可执行的修复命令',
    /node tools\/extract-ico-frame\.mjs/.test(r.out),
    r.out.trim()
  )
}

// 3. 源图不存在
{
  const r = run([path.join(ROOT, 'ico', '不存在的尺寸.ico'), PNG, '256'])
  check('源图不存在 → FAIL', r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out), r.out.trim())
}

// 4. 渲染层 logo 不存在
{
  const r = run([ICO, path.join(ROOT, 'tools', 'fixtures', '根本没有这个文件.png'), '256'])
  check('渲染层 logo 缺失 → FAIL', r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out), r.out.trim())
}

// 5. 该尺寸的帧不存在（32X32.ico 里没有 256 的帧）→ 必须红，而不是静默通过
{
  const r = run([path.join(ROOT, 'ico', '32X32.ico'), PNG, '256'])
  check('源图里没有该尺寸的帧 → FAIL', r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out), r.out.trim())
}

// 6. 反过来：用夹具当"期望"、用真实文件当"实际"，也必须红（防止比较方向写反）
{
  const r = run([path.join(ROOT, 'ico', '64X64.ico'), PNG, '64'])
  check(
    '比较方向没写反（拿 64 的源图去对 256 的产物也要红）',
    r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out),
    r.out.trim()
  )
}

// 7~9. 安装器派生产物：三处都必须真比。这几条治的正是本次踩到的坑 ——
// 桌面端图标换了、安装器里那张还是旧的，界面看着"没换"，构建和打包都不报错。
{
  const dir = makeInstallerDir((d) => {
    // 安装界面主图标换成一张旧图（尺寸照样 256，所以只靠尺寸查不出来）
    const p = path.join(d, 'src', 'assets', 'app256.png')
    fs.rmSync(p, { force: true })
    fs.copyFileSync(FIXTURE, p)
  })
  const r = run([], { YJAI_INSTALLER_DIR: dir })
  check(
    '安装器 app256.png 与源图不一致 → FAIL',
    r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out) && /app256\.png/.test(r.out),
    r.out.trim()
  )
}
{
  const dir = makeInstallerDir((d) => {
    const p = path.join(d, 'src', 'assets', 'logo48.png')
    fs.rmSync(p, { force: true })
    fs.copyFileSync(FIXTURE, p)
  })
  const r = run([], { YJAI_INSTALLER_DIR: dir })
  check(
    '安装器 logo48.png 与源图不一致 → FAIL',
    r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out) && /logo48\.png/.test(r.out),
    r.out.trim()
  )
}
{
  const dir = makeInstallerDir((d) => {
    // 打包用 icon.ico 换成别尺寸的源图：字节不同但仍是合法 ico，只看"能不能打开"查不出来
    fs.copyFileSync(path.join(ROOT, 'ico', '64X64.ico'), path.join(d, 'resources', 'icon.ico'))
  })
  const r = run([], { YJAI_INSTALLER_DIR: dir })
  check(
    '安装器 resources/icon.ico 与桌面端不一致 → FAIL',
    r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out) && /resources\/icon\.ico/.test(r.out),
    r.out.trim()
  )
}

// 10. 尺寸一样、像素不一样 —— 逐像素比较的核心分支。这条不红，那段比较就是白写的。
{
  const dir = makeInstallerDir((d) => {
    fs.writeFileSync(path.join(d, 'src', 'assets', 'app256.png'), solidPng(256, [12, 34, 56, 255]))
  })
  const r = run([], { YJAI_INSTALLER_DIR: dir })
  check(
    '同尺寸但像素不同 → FAIL（逐像素比较真的在比内容，不是只比大小）',
    r.code !== 0 && /LOGO_SYNC_FAILED/.test(r.out) && /个像素不同/.test(r.out),
    r.out.trim()
  )
}

// 收尾：临时夹具树要清掉，不然每次自证都在 %TEMP% 里堆一份图标
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })

let failed = 0
for (const r of results) {
  if (r.ok) {
    console.log(`PASS  ${r.name}`)
  } else {
    failed++
    console.log(`FAIL  ${r.name}`)
    if (r.detail) console.log(`      ${r.detail.split('\n').join('\n      ')}`)
  }
}
const passed = results.length - failed
console.log(`\n自证：通过 ${passed} 项 / 失败 ${failed} 项`)
if (failed) {
  console.log('LOGO_SYNC_SELFTEST_FAILED')
  process.exitCode = 1
} else {
  console.log('LOGO_SYNC_SELFTEST_PASSED')
  process.exitCode = 0
}
