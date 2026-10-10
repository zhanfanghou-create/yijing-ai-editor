#!/usr/bin/env node
/**
 * shoot-svg-sheet.mjs — 把参考客户端提取出来的 SVG 图标铺成一张「联络表」并截图。
 *
 * 为什么需要它：
 *   `tools/extract-ref-svgs.mjs` 能从参考主程序里取出 1200+ 个原版 SVG，但**取出来的是
 *   一堆没有语义的文件名**（viewBox + path 数据里没有「这是 AI更换」这种信息）。
 *   要挑出该用哪一个，只能把它们渲染出来用眼睛认。
 *
 * 为什么用 Electron 渲染而不是引第三方光栅化库：
 *   项目里已有 electron（PNG 取景脚本在用），Chromium 原生支持 SVG；
 *   引 resvg/sharp 会多一份几百 MB 的原生依赖，而这条链路只在开发期用。
 *
 * 用法：
 *   # 铺出画布 22x22 的图标（顶栏标签图标多半是这个规格）
 *   node tools/shoot-svg-sheet.mjs --canvas 22x22 --cols 13 --tag c22
 *   # 铺出画布 <= 20 的全部
 *   node tools/shoot-svg-sheet.mjs --max 20 --cols 14 --tag small
 *   # 只铺实心填充风格的（fill 不是 none）
 *   node tools/shoot-svg-sheet.mjs --canvas 24x24 --filled --cols 14 --tag c24f
 *   # 只写生成脚本、不起 Electron（调试生成物 / 闸门用）
 *   node tools/shoot-svg-sheet.mjs --canvas 22x22 --cols 13 --tag gen-guard --gen-only
 *
 * 输出：_recon/sheets/svg-<tag>.svg / .png
 *
 * ⚠️ 与 shoot-ref-images.mjs 同一条约定：它生成的 Electron 入口脚本出门前必须先过
 *    「tools/lib/gen-script-guard.mjs」的语法守卫。理由见那个文件头（静默吊死 + 弹框给用户）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { syntaxErrorOf, formatScriptGuardFailure } from './lib/gen-script-guard.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const INDEX = path.join(ROOT, '_recon', 'ref-svgs', 'index.json')
const SHEET_DIR = path.join(ROOT, '_recon', 'sheets')
const SVGS_DIR = path.join(ROOT, '_recon', 'ref-svgs')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const has = (n) => process.argv.includes(`--${n}`)

const canvasFilter = arg('canvas', null)
const maxSide = arg('max', null) ? Number(arg('max', null)) : null
const minSide = arg('min', null) ? Number(arg('min', null)) : null
const cols = Number(arg('cols', 13))
const pad = Number(arg('pad', 6))
const onlyFilled = has('filled')
const tag = String(arg('tag', 'sheet'))
const cell = Number(arg('cell', 44))
/**
 * --gen-only —— 只生成 Electron 入口脚本，**不启动 Electron**。
 * 给 `tools/check-gen-script-guard.mjs` 用：它要拿**真实的生成物**去验语法，
 * 而不是在闸门里复制一份模板来验（复制品会各自演化，然后其中一份静默失守）。
 */
const genOnly = has('gen-only')

/** 把一段 SVG 里的 id / url(#id) / href="#id" 全部加前缀，避免几张图合成一张时互相抢引用 */
function prefixIds(svg, pfx) {
  return svg
    .replace(/\bid\s*=\s*"([^"]+)"/g, (_, id) => `id="${pfx}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${pfx}${id})`)
    .replace(/(xlink:href|href)\s*=\s*"#([^"]+)"/g, (_, a, id) => `${a}="#${pfx}${id}"`)
}

function main() {
  if (!fs.existsSync(INDEX)) {
    console.error(`找不到 ${path.relative(ROOT, INDEX)}，先跑 node tools/extract-ref-svgs.mjs`)
    return 2
  }
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'))
  let items = index.items.map((it, i) => ({ ...it, idx: i }))

  if (canvasFilter) {
    const [cw, ch] = canvasFilter.split('x').map(Number)
    items = items.filter((it) => it.canvasW === cw && it.canvasH === ch)
  }
  if (maxSide) items = items.filter((it) => Math.max(it.canvasW, it.canvasH) <= maxSide)
  if (minSide) items = items.filter((it) => Math.max(it.canvasW, it.canvasH) >= minSide)
  if (onlyFilled) items = items.filter((it) => it.fills.some((f) => f !== 'none'))
  const setFilter = arg('set', null)
  if (setFilter) items = items.filter((it) => it.from === String(setFilter))
  const fillFilter = arg('fill', null)
  if (fillFilter) items = items.filter((it) => it.fills.includes(String(fillFilter)))
  // --no-stroke —— 只要「完全不带 stroke 属性」的，也就是**纯填充**风格。
  // 参考的功能图标就是这一路（实心块 + 挖空），描边版是另一种画法；
  // 两路混在一起看容易挑错，所以给一个开关。
  if (has('no-stroke')) items = items.filter((it) => !it.strokes.length)
  // --only 795,796,862 —— 只铺这几号并放大细看（认字形时用，编号就是 index.json 里的下标）
  const only = arg('only', null)
  if (only) {
    const want = new Set(String(only).split(',').map((s) => Number(s.trim())))
    items = items.filter((it) => want.has(it.idx))
  }
  // --range 0,76 —— 按筛选后的序号切片（配合 --cols 分页看大图）
  const range = arg('range', null)
  if (range) {
    const [a, b] = String(range).split(',').map(Number)
    items = items.slice(a, Number.isFinite(b) ? b : items.length)
  }

  if (!items.length) {
    console.error('筛选后没有图标')
    return 2
  }

  const labelH = Math.max(15, Math.round(cell / 4))
  const labelSize = Math.max(10, Math.round(cell / 5))
  const stepX = cell + pad
  const stepY = cell + pad + labelH
  const rows = Math.ceil(items.length / cols)
  const W = cols * stepX + pad
  const H = rows * stepY + pad

  const cells = items.map((it, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = pad + col * stepX
    const y = pad + row * stepY
    let svg = fs.readFileSync(path.join(SVGS_DIR, it.file), 'utf8')
    svg = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    svg = prefixIds(svg, `s${i}_`)
    const lw = it.canvasW || 24
    const lh = it.canvasH || 24
    const s = Math.min(cell / lw, cell / lh)
    const ox = (cell - lw * s) / 2
    const oy = (cell - lh * s) / 2
    return (
      `<g transform="translate(${x},${y})">` +
      `<rect x="0" y="0" width="${cell}" height="${cell}" rx="6" fill="#27272D"/>` +
      `<g transform="translate(${ox},${oy}) scale(${s.toFixed(4)})">${svg}</g>` +
      `<text x="${cell / 2}" y="${cell + labelSize + 1}" font-size="${labelSize}" fill="#a0a0ad" ` +
      `text-anchor="middle" font-family="Consolas,monospace">${it.idx}</text>` +
      `</g>`
    )
  })

  fs.mkdirSync(SHEET_DIR, { recursive: true })
  const svgPath = path.join(SHEET_DIR, `svg-${tag}.svg`)
  const pngPath = path.join(SHEET_DIR, `svg-${tag}.png`)
  fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="#141418"/>${cells.join('')}</svg>`, 'utf8')

  console.log(`图标 ${items.length} 个 → ${cols} 列 × ${rows} 行，画布 ${W}x${H}`)
  console.log(`  ${path.relative(ROOT, svgPath)}`)

  // Electron 入口：加载 SVG → capturePage → 存 PNG → 退出
  const mainPath = path.join(ROOT, '_recon', '.svg-sheet-main.cjs')
  // ⚠️ 模板里的注释不许出现反引号：混进一个就把模板字面量截断在那一行，
  //    生成物变成语法错，交出去会让父进程静默吊死 + 给用户弹一个看不懂的框。
  //    与 shoot-ref-images.mjs 同一坑、同一道守卫（见 tools/lib/gen-script-guard.mjs）。
  const mainSrc = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: Number(process.env.SHEET_W), height: Number(process.env.SHEET_H),
    show: false, frame: false, backgroundColor: '#141418',
    webPreferences: { offscreen: false }
  })
  await win.loadFile(process.env.SHEET_SRC)
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage()
  fs.writeFileSync(process.env.SHEET_OUT, img.toPNG())
  app.exit(0)
})
`
  const mainRel = path.relative(ROOT, mainPath).split(path.sep).join('/')
  // 先验语法、后写盘：坏脚本连落盘的机会都没有，仓库里不会留定时炸弹。
  const bad = syntaxErrorOf(mainSrc, mainRel)
  if (bad) {
    console.error(formatScriptGuardFailure(bad, mainRel, 'tools/shoot-svg-sheet.mjs 的 mainSrc 模板'))
    return 3
  }
  fs.writeFileSync(mainPath, mainSrc, 'utf8')

  if (genOnly) {
    console.log('GEN_ONLY_SCRIPT ' + mainRel)
    console.log('GEN_ONLY_NO_ELECTRON')
    return 0
  }

  const logPath = path.join(SHEET_DIR, `svg-${tag}.log`)
  const fd = fs.openSync(logPath, 'w')
  // ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：带着它启动时 Electron 退化成纯 Node，
  //    `require('electron')` 会解析到 node_modules 里那个 npm 包（导出 exe 路径字符串），
  //    于是 `app` 是 undefined，报 "Cannot read properties of undefined"。
  //    desktop-shoot.mjs 里同一行为是同一个坑。
  const childEnv = {
    ...process.env,
    SHEET_SRC: svgPath,
    SHEET_OUT: pngPath,
    SHEET_W: String(W),
    SHEET_H: String(H)
  }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const r = spawnSync(ELECTRON, [mainPath], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    env: childEnv,
    // ⚠️ 必须给 timeout。Electron 侧一旦因任何原因不退出（脚本语法错、解码卡住、
    //    窗口没建起来），没有超时的 spawnSync 会**永久阻塞** —— 父进程连自己的定时器
    //    都停摆，没法自救。给个上限，把"吊死"变成一条明确的失败。
    //    与 shoot-ref-images.mjs / desktop-shoot.mjs 同一条约定。
    timeout: 180000
  })
  fs.closeSync(fd)
  if (r.error) {
    console.error('启动 Electron 失败：', r.error.message)
    return 1
  }
  if (r.signal) {
    console.error(`Electron 被信号 ${r.signal} 终止（多半是超时 180s）。日志尾：`)
    console.error(fs.readFileSync(logPath, 'utf8').slice(-1500))
    return 1
  }
  if (!fs.existsSync(pngPath)) {
    console.error(`没生成 PNG（退出码 ${r.status}）。日志：${path.relative(ROOT, logPath)}`)
    console.error(fs.readFileSync(logPath, 'utf8').slice(-800))
    return 1
  }
  console.log(`  ${path.relative(ROOT, pngPath)}`)
  return 0
}

process.exit(main())
