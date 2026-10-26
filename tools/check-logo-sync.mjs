#!/usr/bin/env node
/**
 * 闸门：凡是"由 ico/ 派生出来的图标产物"，都必须与 ico/ 里的源图一致。
 *
 * 背景：界面与安装器的图标不是直接引用 `ico/`，而是由几条生成链派生的 ——
 *
 *   ico/256X256.ico ──tools/extract-ico-frame.mjs──▶ renderer/assets/logo-256.png
 *   ico/source-1024.png ──tools/gen-app-icon.py──▶ ico/*X*.ico、
 *        desktop|installer 的 build/icon.ico、installer/resources/icon.ico、
 *        installer/src/assets/{app256,logo48}.png
 *
 * 这就埋了一个必然会踩的坑 ——
 *
 *   **换了 ico/ 里的 logo、也重新打包了，界面/安装器却还是旧 logo。**
 *
 * 因为它不报错、不影响构建、尺寸也对，只是"图是上一版"。跟"配了图没生效"
 * 长得一模一样，光看产物根本分辨不出来。
 *
 * 实测踩过两次：① 渲染层 logo-256.png 没重出；② 安装器已经换成新图标了，
 * 但 installer 的 dist-renderer 没重建（这一条已在构建侧修掉，见 README）。
 *
 * 校验策略有两条，按产物的编码形态选：
 *   - **逐字节**：extract-ico-frame 出的 PNG 是我们自己编码的，可以直接对 sha。
 *   - **逐像素**：安装器的 app256/logo48 是 Pillow 另一条编码链出的 PNG，
 *     同一个图在不同编码器下字节必然不同（IDAT 分块、过滤器选择都会变）。
 *     对字节会假红；只对像素才是"同一张图"的正确判据。
 *     （实测这两张图与 ico 帧像素完全一致 —— 见 tools/lib/png-decode.mjs）
 *
 * 校验方式：**真的把生成器跑一遍**（而不是自己再实现一次解码），
 * 这样测的是同一条实际管线；生成逻辑将来改了也自动跟着生效。
 *
 * 用法：
 *   node tools/check-logo-sync.mjs                       # 默认：全部 5 项
 *   node tools/check-logo-sync.mjs <ico> <png> <size>    # 自证夹具用：只比第 1 项
 *   YJAI_INSTALLER_DIR=<dir> node tools/check-logo-sync.mjs   # 夹具用：换安装器根
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'
import { decodePngFile, comparePixels } from './lib/png-decode.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// 有位置参数 = 夹具模式，只跑第 1 项（自证要能精确地"只让一项红"）
const FIXTURE_MODE = process.argv.length > 2

const ICO = process.argv[2] || path.join(ROOT, 'ico', '256X256.ico')
const PNG = process.argv[3] || path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'logo-256.png')
const SIZE = Number(process.argv[4] || 256)

// 安装器根目录可覆盖，供自证夹具造"过期产物"
const INSTALLER = process.env.YJAI_INSTALLER_DIR || path.join(ROOT, 'packages', 'installer')
const DESKTOP_ICO = path.join(ROOT, 'packages', 'desktop', 'build', 'icon.ico')

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')

/** 读 PNG 的 IHDR 拿尺寸，用于把"尺寸对不上"和"像素对不上"分开说清楚 */
const dims = (p) => {
  const b = fs.readFileSync(p)
  return b.readUInt32BE(0) === 0x89504e47 ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : '非 PNG'
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail) console.log(`      ${detail.split('\n').join('\n      ')}`)
}

/**
 * 跑真正的提取器，把某尺寸的帧解到临时目录。
 *
 * ⚠️ 必须走 spawnCapture（输出重定向到文件），不能 stdio:'pipe'：
 * 本机在进程内部 spawn node 时管道会 EBUSY，这道闸门会假红成一整片。
 * 见 tools/spawn-capture.mjs 的说明。
 *
 * 临时文件只作中间产物，不是"夹具"——夹具是仓库里的常驻文件
 * （见 tools/check-logo-sync.selftest.mjs）。
 */
function extractFrame(ico, size) {
  const tmp = path.join(os.tmpdir(), `yjai-logo-check-${process.pid}-${size}.png`)
  const run = spawnCapture(process.execPath, [
    path.join(__dirname, 'extract-ico-frame.mjs'),
    ico,
    tmp,
    String(size)
  ])
  if (run.status !== 0 || run.error) {
    return { ok: false, err: String(run.stdout || run.error?.message || '提取器退出码非 0').trim() }
  }
  return { ok: true, path: tmp }
}

/* --------------------------- 1. 渲染层 logo --------------------------- */

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

const ext = extractFrame(ICO, SIZE)
if (!ext.ok) {
  console.error(`LOGO_SYNC_FAILED  提取器跑不出 ${SIZE}x${SIZE} 的帧（源：${rel(ICO)}）\n  ${ext.err}`)
  process.exit(1)
}
const wantSize = fs.statSync(ext.path).size
const wantDims = dims(ext.path)
const wantSha = sha(ext.path)
fs.rmSync(ext.path, { force: true })

record(
  `渲染层 logo 与 ${rel(ICO)} 逐字节一致`,
  wantSha === sha(PNG),
  `渲染层 logo 与 ico/ 源图不一致（界面会显示上一版 logo）\n` +
    `  源图      ${rel(ICO)}  ${fs.statSync(ICO).size}B\n` +
    `  应为      ${wantSize}B  ${wantDims}  sha ${wantSha.slice(0, 16)}\n` +
    `  实际      ${fs.statSync(PNG).size}B  ${dims(PNG)}  sha ${sha(PNG).slice(0, 16)}\n` +
    `  修复：node tools/extract-ico-frame.mjs ${rel(ICO)} ${rel(PNG)} ${SIZE}`
)

/* ------------------ 2~5. 安装器派生产物（夹具模式跳过） ------------------ */

if (!FIXTURE_MODE) {
  /** 像素比：把 ico 的某尺寸帧解出来，和安装器里的 PNG 逐像素对 */
  const pixelTargets = [
    {
      asset: path.join(INSTALLER, 'src', 'assets', 'app256.png'),
      ico: path.join(ROOT, 'ico', '256X256.ico'),
      size: 256,
      why: '安装引导界面的主图标'
    },
    {
      asset: path.join(INSTALLER, 'src', 'assets', 'logo48.png'),
      ico: path.join(ROOT, 'ico', '48X48.ico'),
      size: 48,
      why: '安装引导界面标题栏的 logo'
    }
  ]

  for (const t of pixelTargets) {
    const name = `安装器 ${rel(t.asset)} 与 ${rel(t.ico)} 像素一致（${t.why}）`
    if (!fs.existsSync(t.asset)) {
      record(name, false, `文件不存在：${rel(t.asset)}\n  生成：python tools/gen-app-icon.py`)
      continue
    }
    const frame = extractFrame(t.ico, t.size)
    if (!frame.ok) {
      record(name, false, `解不出 ${t.size}x${t.size} 的帧（源：${rel(t.ico)}）\n  ${frame.err}`)
      continue
    }
    let cmp
    let errText = ''
    try {
      cmp = comparePixels(decodePngFile(frame.path), decodePngFile(t.asset), '源图', '实际')
    } catch (e) {
      errText = String(e.message || e)
    }
    fs.rmSync(frame.path, { force: true })
    if (errText) {
      record(name, false, `解码失败（不是 8bit 真彩 PNG？）：${errText}`)
      continue
    }
    record(
      name,
      cmp.same,
      cmp.same
        ? ''
        : `${cmp.reason}` +
            (cmp.first ? `\n  首个差异像素 (${cmp.first.x},${cmp.first.y}) 源图 RGBA=${cmp.first['源图']} 实际=${cmp.first['实际']}` : '') +
            `\n  修复：python tools/gen-app-icon.py && 重建 installer 的 dist-renderer`
    )
  }

  // 三份多帧 icon.ico 由同一个函数生成，字节必须完全相同
  const icoTwins = [
    path.join(INSTALLER, 'build', 'icon.ico'),
    path.join(INSTALLER, 'resources', 'icon.ico')
  ]
  for (const twin of icoTwins) {
    const name = `${rel(twin)} 与 ${rel(DESKTOP_ICO)} 逐字节一致`
    if (!fs.existsSync(twin)) {
      record(name, false, `文件不存在：${rel(twin)}\n  生成：python tools/gen-app-icon.py`)
      continue
    }
    const same = fs.existsSync(DESKTOP_ICO) && sha(twin) === sha(DESKTOP_ICO)
    record(
      name,
      same,
      `打包用图标与桌面端不一致（exe 图标会跟安装器对不上）\n` +
        `  桌面端  ${fs.existsSync(DESKTOP_ICO) ? `${fs.statSync(DESKTOP_ICO).size}B  sha ${sha(DESKTOP_ICO).slice(0, 16)}` : '缺失'}\n` +
        `  实际    ${fs.statSync(twin).size}B  sha ${sha(twin).slice(0, 16)}\n` +
        `  修复：python tools/gen-app-icon.py`
    )
  }
}

/* -------------------------------- 汇总 -------------------------------- */

const failed = results.filter((r) => !r.ok).length
if (failed) {
  console.error(`\nLOGO_SYNC_FAILED  ${failed} / ${results.length} 项不一致`)
} else {
  console.error(`\nLOGO_SYNC_OK  渲染层 logo 与 ${rel(ICO)} 一致（${wantSize}B  ${SIZE}x${SIZE}  sha ${wantSha.slice(0, 16)}）`)
}
// 给闸门套件一行可解析的汇总。它不是装饰：verify.mjs 靠这个数断言总数，
// 少一行就会报"解析不到断言数"，闸门变假红。
console.log(`LOGO_SYNC_STATS total=${results.length} pass=${results.length - failed} fail=${failed}`)
process.exitCode = failed ? 1 : 0
