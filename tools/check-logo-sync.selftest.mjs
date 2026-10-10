#!/usr/bin/env node
/**
 * check-logo-sync.mjs 的自证夹具 —— 证明这道闸门**真的会比、且比不过时会红**。
 *
 * 一个检查器如果永远输出 OK，它跟没有是一样的。这里刻意造出四种"应该失败"的
 * 场景，逐一确认它会以非 0 退出并给出可操作的修复命令。
 *
 * 夹具用的是仓库里的**常驻文件**（tools/fixtures/logo-from-64.png），
 * 不是临时目录里的东西 —— 临时夹具下次跑可能就没了，自证会退化成空转。
 *
 * 用法：node tools/check-logo-sync.selftest.mjs
 */
import { spawnCapture } from './spawn-capture.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
function run(args) {
  const r = spawnCapture(process.execPath, [path.join(__dirname, 'check-logo-sync.mjs'), ...args])
  return { code: r.status ?? 1, out: r.stdout || '' }
}

const ICO = path.join(ROOT, 'ico', '256X256.ico')
const PNG = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'logo-256.png')
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'logo-from-64.png')

// 夹具必须真在仓库里，否则下面那条"应该失败"的断言会变成因为文件不存在才失败
check('夹具文件存在于仓库内', fs.existsSync(FIXTURE), FIXTURE)
check('源图 ico/256X256.ico 存在', fs.existsSync(ICO), ICO)
check('渲染层 logo-256.png 存在', fs.existsSync(PNG), PNG)

// 1. 正常情况必须过
{
  const r = run([])
  check('当前仓库状态 → PASS', r.code === 0 && /LOGO_SYNC_OK/.test(r.out), r.out.trim())
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
