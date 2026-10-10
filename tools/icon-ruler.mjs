#!/usr/bin/env node
/**
 * 带坐标标尺的裁剪器 —— 用来「量」参考截图里某个元素到底在哪。
 *
 * 为什么要它：做像素级对齐时，凭截图目测估坐标会一路估偏，而且偏了之后表现为
 * "图没对上"，很容易被当成排版差异去追（这坑已经踩过）。这里直接把绝对坐标
 * 画在图上，看一眼就能读出来。
 *
 * 用法：
 *   node tools/icon-ruler.mjs <png> <x> <y> <w> <h> [scale=2] [out.png]
 *   node tools/icon-ruler.mjs                 # 默认量参考首页 y=320..500 那条
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.env.YIJAI_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const SRC = process.argv[2] || path.join(ROOT, '_evidence', 'ref-ui', '01-首页-1220x720.png')
const X = Number(process.argv[3] ?? 220)
const Y = Number(process.argv[4] ?? 320)
const W = Number(process.argv[5] ?? 900)
const H = Number(process.argv[6] ?? 180)
const SCALE = Number(process.argv[7] ?? 2)
const OUT =
  process.argv[8] || path.join(ROOT, '_evidence', 'icon-compare', `标尺-${X}x${Y}-${W}x${H}.png`)

fs.mkdirSync(path.dirname(OUT), { recursive: true })

// 从 PNG 的 IHDR 读真尺寸，别把 1220x720 写死在 CSS 里 ——
// 写死过一次：坐标按 2 倍算、background-size 却还是 1 倍，整块裁到画布外，出图全黑。
const png = fs.readFileSync(SRC)
if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${SRC} 不是 PNG`)
const IW = png.readUInt32BE(16)
const IH = png.readUInt32BE(20)
if (X + W > IW || Y + H > IH) {
  console.warn(`⚠️ 裁剪区 ${X},${Y} ${W}x${H} 超出源图 ${IW}x${IH}，超出部分会是空的`)
}

const b64 = `data:image/png;base64,${png.toString('base64')}`

/** 每 10px 一条细线、每 50px 一条粗线并标数值 */
const lines = []
for (let gx = Math.ceil(X / 10) * 10; gx <= X + W; gx += 10) {
  const major = gx % 50 === 0
  const left = (gx - X) * SCALE
  lines.push(
    `<div class="v${major ? ' major' : ''}" style="left:${left}px">${
      major ? `<span>${gx}</span>` : ''
    }</div>`
  )
}
for (let gy = Math.ceil(Y / 10) * 10; gy <= Y + H; gy += 10) {
  const major = gy % 50 === 0
  const top = (gy - Y) * SCALE
  lines.push(
    `<div class="h${major ? ' major' : ''}" style="top:${top}px">${
      major ? `<span>${gy}</span>` : ''
    }</div>`
  )
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; background:#0d0f18; }
  .wrap { position:relative; width:${W * SCALE}px; height:${H * SCALE}px;
          background-image:url('${b64}');
          background-size:${IW * SCALE}px ${IH * SCALE}px;
          background-position:${-X * SCALE}px ${-Y * SCALE}px;
          background-repeat:no-repeat; }
  .v { position:absolute; top:0; bottom:0; width:1px; background:rgba(0,255,200,.28); }
  .h { position:absolute; left:0; right:0; height:1px; background:rgba(0,255,200,.28); }
  .v.major { background:rgba(255,60,160,.75); width:2px; }
  .h.major { background:rgba(255,60,160,.75); height:2px; }
  .v span { position:absolute; top:2px; left:3px; font:11px monospace; color:#ff3ca0;
            background:rgba(0,0,0,.65); padding:0 3px; }
  .h span { position:absolute; left:2px; top:2px; font:11px monospace; color:#ff3ca0;
            background:rgba(0,0,0,.65); padding:0 3px; }
</style></head><body><div class="wrap">${lines.join('')}</div></body></html>`

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: W * SCALE, height: H * SCALE } })
  await page.setContent(html, { waitUntil: 'load' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: OUT })
  console.log(`标尺裁剪 ${path.relative(ROOT, OUT)}  (源 ${path.basename(SRC)} 区域 ${X},${Y} ${W}x${H} @${SCALE}x)`)
  console.log('ICON_RULER_OK')
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 6000))]).catch(() => {})
  try {
    browser.process()?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}
process.exitCode = 0
process.stdout.write('', () => process.exit(0))
setTimeout(() => process.exit(0), 800).unref()
