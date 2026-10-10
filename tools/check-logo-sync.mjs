#!/usr/bin/env node
/**
 * 闸门：渲染层用的 logo 必须与仓库根 `ico/` 里的源图一致。
 *
 * 背景：界面里的 logo 不是直接引用 `ico/`，而是由 tools/extract-ico-frame.mjs
 * 解出来的 `packages/desktop/src/renderer/assets/logo-256.png`。
 * 这就埋了一个必然会踩的坑 ——
 *
 *   **换了 ico/ 里的 logo、也重新打包了，界面却还是旧 logo。**
 *
 * 因为它不报错、不影响构建、尺寸也对，只是"图是上一版"。跟"配了图没生效"
 * 长得一模一样，光看产物根本分辨不出来。所以这里把两者逐字节对上。
 *
 * 校验方式：**真的把 extract-ico-frame.mjs 跑一遍**（而不是自己再实现一次解码），
 * 这样测的是同一条实际管线；解码逻辑将来改了也自动跟着生效。
 *
 * 用法：
 *   node tools/check-logo-sync.mjs                       # 默认校验
 *   node tools/check-logo-sync.mjs <ico> <png> <size>    # 自证夹具用
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const ICO = process.argv[2] || path.join(ROOT, 'ico', '256X256.ico')
const PNG = process.argv[3] || path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'logo-256.png')
const SIZE = Number(process.argv[4] || 256)

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')

/** 读 PNG 的 IHDR 拿尺寸，用于把"尺寸对不上"和"像素对不上"分开说清楚 */
const dims = (p) => {
  const b = fs.readFileSync(p)
  return b.readUInt32BE(0) === 0x89504e47 ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : '非 PNG'
}

if (!fs.existsSync(ICO)) {
  console.error(`LOGO_SYNC_FAILED  源图不存在：${rel(ICO)}`)
  process.exit(1)
}
if (!fs.existsSync(PNG)) {
  console.error(
    `LOGO_SYNC_FAILED  渲染层 logo 不存在：${rel(PNG)}\n` +
      `  生成：node tools/extract-ico-frame.mjs ${rel(ICO)} ${rel(PNG)} ${SIZE}`
  )
  process.exit(1)
}

// 跑真正的提取器到临时文件。临时文件只作中间产物，不是"夹具"，
// 夹具是仓库里的常驻文件（见 tools/check-logo-sync.selftest.mjs）。
const tmp = path.join(os.tmpdir(), `yjai-logo-check-${process.pid}.png`)
let extractorOk = true
let extractorErr = ''
try {
  // ⚠️ 必须走 spawnCapture（输出重定向到文件），不能 stdio:'pipe'：
  // 本机在进程内部 spawn node 时管道会 EBUSY，这道闸门会假红成一整片。
  // 见 tools/spawn-capture.mjs 的说明。
  const run = spawnCapture(process.execPath, [
    path.join(__dirname, 'extract-ico-frame.mjs'),
    ICO,
    tmp,
    String(SIZE)
  ])
  if (run.status !== 0 || run.error) {
    throw Object.assign(new Error(run.stdout || run.error?.message || '提取器退出码非 0'), {
      stderr: Buffer.from(run.stdout || ''),
      stdout: Buffer.from('')
    })
  }
} catch (e) {
  extractorOk = false
  extractorErr = String(e.stderr || e.stdout || e.message).trim()
}

if (!extractorOk) {
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
  console.error(
    `LOGO_SYNC_FAILED  提取器跑不出 ${SIZE}x${SIZE} 的帧（源：${rel(ICO)}）\n  ${extractorErr}`
  )
  process.exit(1)
}

const want = sha(tmp)
const got = sha(PNG)
const tmpStat = fs.statSync(tmp)
const tmpSize = tmpStat.size
// 临时文件一删就拿不到尺寸了，所以先取好再删
const wantDims = dims(tmp)
const gotDims = dims(PNG)
fs.rmSync(tmp, { force: true })

if (want !== got) {
  console.error(
    `LOGO_SYNC_FAILED  渲染层 logo 与 ico/ 源图不一致（界面会显示上一版 logo）\n` +
      `  源图      ${rel(ICO)}  ${fs.statSync(ICO).size}B\n` +
      `  应为      ${tmpSize}B  ${wantDims}  sha ${want.slice(0, 16)}\n` +
      `  实际      ${fs.statSync(PNG).size}B  ${gotDims}  sha ${got.slice(0, 16)}\n` +
      `  修复：node tools/extract-ico-frame.mjs ${rel(ICO)} ${rel(PNG)} ${SIZE}`
  )
  process.exit(1)
}

console.log(
  `LOGO_SYNC_OK  ${rel(PNG)} 与 ${rel(ICO)} 一致（${tmpSize}B  ${SIZE}x${SIZE}  sha ${got.slice(0, 16)}）`
)
// 给闸门套件一行可解析的汇总。它不是装饰：verify.mjs 靠这个数断言总数，
// 少一行就会报"解析不到断言数"，闸门变假红。
console.log('LOGO_SYNC_STATS total=1 pass=1 fail=0')
process.exitCode = 0
