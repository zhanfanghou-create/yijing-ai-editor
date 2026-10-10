#!/usr/bin/env node
/**
 * 参考软件 vs 艺镜AI剪辑 —— 界面/图标对比图。
 *
 * 产出（_evidence/icon-compare/）：
 *   我们-首页-1220x720.png   我们的首页，**按参考同样的 1220x720 渲染**，才能 1:1 比对
 *   00-整屏并排.png          整屏缩略并排（看布局）
 *   区域-①…⑤-*.png          每个区域单独出图：**参考在上、我们在下、横向对齐**
 *
 * 为什么这么出图：
 *   1. 差异全在 20px 级的图标上。整屏并排看不出"图标形状不同"还是"只是缩了"，
 *      所以每个区域单独放大出图。
 *   2. 上下叠放而不是左右并排 —— 左右并排时两张都变窄，还要来回扫；
 *      上下叠放后同一列就是同一个图标，一眼能看出"这个多了个点/那个是实心"。
 *   3. 坐标是量出来的（tools/icon-ruler.mjs），不是估的。
 *
 * 跑真实构建产物（dist-renderer）+ 路由桩，不碰生产数据。
 * 用法：node tools/icon-compare-shoot.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'packages', 'desktop', 'dist-renderer')
const REF_UI = path.join(ROOT, '_evidence', 'ref-ui', '01-首页-1220x720.png')
const OUT = path.join(ROOT, '_evidence', 'icon-compare')
const CHROME = process.env.YIJAI_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

process.on('unhandledRejection', (e) => {
  console.error(`\nICON_COMPARE_FAILED  ${e?.message || e}`)
  process.exit(1)
})

// 与参考截图同尺寸，两边同尺寸才能直接叠着看
const W = 1220
const H = 720

/**
 * 要放大的区域（坐标以 1220x720 为基准，两边共用同一套坐标 —— 所以坐标本身
 * 也顺便验证了"两块排版是否对得上"）。
 * ⚠️ 这些是**量**出来的，不是估的：AI 工具行图标块在 y 400..448，标签在 460..475，
 *    图标中心 x 从 287 起、间距 110。改这里之前先用 tools/icon-ruler.mjs 重新量。
 */
const CROPS = [
  { label: '① 左上品牌区（logo 来源）', x: 14, y: 22, w: 224, h: 84, scale: 3 },
  { label: '② 左栏导航图标', x: 14, y: 180, w: 212, h: 216, scale: 2.6 },
  { label: '③ AI 工具行 · 左半', x: 250, y: 394, w: 460, h: 88, scale: 2.8 },
  { label: '④ AI 工具行 · 右半', x: 694, y: 394, w: 460, h: 88, scale: 2.8 },
  { label: '⑤ 右上入口簇 + 窗口三键', x: 776, y: 4, w: 436, h: 42, scale: 3 }
]

fs.mkdirSync(OUT, { recursive: true })

function pngSize(p) {
  const b = fs.readFileSync(p)
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${p} 不是 PNG`)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

// 所有裁剪坐标都以「参考截图 = 1220x720」为前提。参考图一旦换尺寸，坐标整体错位，
// 而那看起来只是"图没对上"，很容易被当成排版差异去追，所以这里硬断言。
{
  const r = pngSize(REF_UI)
  if (r.w !== W || r.h !== H) {
    throw new Error(`参考截图 ${r.w}x${r.h}，与脚本假设的 ${W}x${H} 不符，裁剪坐标会整体错位`)
  }
  console.log(`参考截图  ${r.w}x${r.h}  OK`)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = decodeURIComponent(url.pathname)
  const file = path.join(DIST, p === '/' ? 'index.html' : p.replace(/^\/+/, ''))
  if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return void res.writeHead(404).end('nf')
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const BASE = `http://127.0.0.1:${port}`

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
await context.route('**/*', async (route) => {
  const url = route.request().url()
  if (url.startsWith(BASE)) return route.continue()
  if (/\/api\/home-assets/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ promo: [], featureArt: {} })
    })
  }
  if (/\/v1\/ai\/catalog/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ capabilities: [], models: [], plans: [], channels: [], notice: '' })
    })
  }
  return route.fulfill({ status: 204, body: '' })
})

/* ------------------------- 1. 拍我们自己的首页 ------------------------- */

const shot = path.join(OUT, '我们-首页-1220x720.png')
{
  const page = await context.newPage()
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.home-rail')
  await page.waitForTimeout(1400)
  // 断言 logo 真加载出来了（naturalWidth>0）。否则会拍到一个空方块还浑然不觉 ——
  // 这块本来就是"图挂了"和"没配图"看起来一样的重灾区。
  const logoOk = await page.evaluate(() => {
    const img = document.querySelector('.home-brand-mark img')
    return img ? { nw: img.naturalWidth, nh: img.naturalHeight, sw: img.clientWidth } : null
  })
  await page.screenshot({ path: shot })
  await page.close()
  if (!logoOk || !logoOk.nw) throw new Error(`首页品牌 logo 没加载出来：${JSON.stringify(logoOk)}`)
  console.log(`我们的首页  ${path.relative(ROOT, shot)}  logo ${logoOk.nw}x${logoOk.nh} 显示 ${logoOk.sw}px 宽`)
}

/* ------------------------- 2. 出对比图 ------------------------- */

const b64 = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
const refUrl = b64(REF_UI)
const ourUrl = b64(shot)

const baseCss = (c) => `
  .crop { width:${c.w * c.scale}px; height:${c.h * c.scale}px; background-repeat:no-repeat;
          background-size:${W * c.scale}px ${H * c.scale}px;
          background-position:${-c.x * c.scale}px ${-c.y * c.scale}px;
          border:1px solid #2b2f45; border-radius:6px; image-rendering:pixelated; }`

const page_ = await context.newPage()

// (a) 整屏并排
{
  const cmp = path.join(OUT, '00-整屏并排.png')
  await page_.setViewportSize({ width: 1280, height: 420 })
  await page_.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:16px;background:#0d0f18;color:#e8e9f2;
           font-family:'Microsoft YaHei','Segoe UI',sans-serif}
      h1{font-size:15px;margin:0 0 10px}
      .row{display:flex;gap:14px}
      figure{margin:0}
      figcaption{margin-top:5px;font-size:12px;color:#9aa0bb;text-align:center}
      .full{width:${W * 0.5}px;height:${H * 0.5}px;background-size:${W * 0.5}px ${H * 0.5}px;
            background-repeat:no-repeat;border:1px solid #2b2f45;border-radius:6px}
     </style></head><body>
     <h1>整屏并排（均以 1220×720 渲染，缩到 50% 显示）</h1>
     <div class="row">
       <figure><div class="full" style="background-image:url('${refUrl}')"></div><figcaption>参考</figcaption></figure>
       <figure><div class="full" style="background-image:url('${ourUrl}')"></div><figcaption>我们</figcaption></figure>
     </div></body></html>`,
    { waitUntil: 'load' }
  )
  await page_.waitForTimeout(400)
  await page_.screenshot({ path: cmp })
  console.log(`整屏并排    ${path.relative(ROOT, cmp)}  ${fs.statSync(cmp).size}B`)
}

// (b) 每个区域一张：参考在上、我们在下、横向严格对齐
for (const c of CROPS) {
  const name = `区域-${c.label.replace(/[／/]/g, '-')}.png`
  const file = path.join(OUT, name)
  // setViewportSize 只吃整数（小数会直接抛），而 scale 常常是 2.6 / 2.8 这种
  await page_.setViewportSize({
    width: Math.round(c.w * c.scale + 32),
    height: Math.round(c.h * c.scale * 2 + 130)
  })
  await page_.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:16px;background:#0d0f18;color:#e8e9f2;
           font-family:'Microsoft YaHei','Segoe UI',sans-serif}
      h1{font-size:14px;margin:0 0 3px}
      .sub{font-size:11.5px;color:#7c8098;margin-bottom:11px}
      .cap{font-size:12px;color:#9aa0bb;margin:0 0 5px}
      ${baseCss(c)}
      .gap{height:22px}
     </style></head><body>
      <h1>${c.label}</h1>
      <div class="sub">源区域 x=${c.x} y=${c.y} ${c.w}×${c.h} @${c.scale}× ｜ 上下同一列 = 同一坐标</div>
      <div class="cap">参考</div>
      <div class="crop" style="background-image:url('${refUrl}')"></div>
      <div class="gap"></div>
      <div class="cap">我们</div>
      <div class="crop" style="background-image:url('${ourUrl}')"></div>
     </body></html>`,
    { waitUntil: 'load' }
  )
  await page_.waitForTimeout(350)
  await page_.screenshot({ path: file, fullPage: true })
  console.log(`区域图      ${path.relative(ROOT, file)}  ${fs.statSync(file).size}B`)
}
await page_.close()

await Promise.race([context.close(), new Promise((r) => setTimeout(r, 6000))]).catch(() => {})
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 6000))]).catch(() => {})
try {
  browser.process()?.kill('SIGKILL')
} catch {
  /* 已经退了就算了 */
}
server.closeAllConnections?.()
server.close()
console.log('ICON_COMPARE_OK')
process.exitCode = 0
process.stdout.write('', () => process.exit(0))
setTimeout(() => process.exit(0), 1000).unref()
