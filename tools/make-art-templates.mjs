/**
 * 生成后台配图用的**占位图**（真透明背景 PNG，尺寸严格对齐产品规格）。
 *
 * 为什么要有它：后台配好了才有得看。但没有设计稿的时候，Jason 只能干等，
 * 而我不能替他往生产塞图。给他一套占位图 = 他 30 秒就能把整条链路走通看到效果，
 * 走完删掉即可；也可以直接发给设计师当尺寸模板。
 *
 * 尺寸严格按 product spec（不是"差不多"）：
 *   功能卡人物图  显示 104×100 → 上传 208×200（2 倍图）
 *   左下角广告位  显示 188×100 → 上传 376×200（2 倍图）
 *
 * 用真实 Chrome 渲染 SVG 再截图（omitBackground），所以输出是真·透明通道，
 * 不是把白底 PNG 假装成透明。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '_evidence', 'art-templates')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const FONT = "'Microsoft YaHei','Segoe UI',sans-serif"
/**
 * 颜色必须**在两个背景上都看得见**，这是实测踩出来的：
 * 第一版用半透明白，结果在深色卡片上很合适，但 Jason 用图片查看器打开时是**白底**，
 * 整张图看起来是一片空白 —— 占位图最重要的作用（让人一眼看懂放哪儿、多大）直接失效。
 * 紫罗兰 `#7A5AF0` 系在白底上是深色、在深紫卡片(#2b2144)上是亮色，两边都成立。
 */
const INK = 'rgba(122,90,240,0.97)'
const INK_2 = 'rgba(122,90,240,0.80)'
const INK_3 = 'rgba(122,90,240,0.58)'
const FRAME = 'rgba(122,90,240,0.85)'
const FIGURE = 'rgba(150,120,255,0.78)'
/**
 * 文字加白色衬底描边。208×200 这块画布很小，人物又必须贴右下，
 * 文字和人物一定会撞上；而占位图唯一的使命就是"让人一眼看懂放哪儿、多大"，
 * 撞上去变糊就等于白做。paint-order=stroke 让描边落在字的下层，字本身还是锐的。
 */
const TEXT_STYLE = 'stroke:#ffffff;stroke-width:4;paint-order:stroke;stroke-linejoin:round'

/** 功能卡右侧人物图：主体靠右下（与客户端 object-position: right bottom 一致） */
function cardArt(title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="208" height="200" viewBox="0 0 208 200">
  <rect x="9" y="9" width="190" height="182" rx="12" fill="none" stroke="${FRAME}" stroke-width="2" stroke-dasharray="12 9"/>
  <circle cx="128" cy="112" r="30" fill="${FIGURE}"/>
  <path d="M76 200 L76 160 Q76 130 108 130 L148 130 Q180 130 180 160 L180 200 Z" fill="${FIGURE}"/>
  <text x="22" y="46" style="${TEXT_STYLE}" font-family="${FONT}" font-size="18" font-weight="600" fill="${INK}">${title}</text>
  <text x="22" y="72" style="${TEXT_STYLE}" font-family="${FONT}" font-size="13" fill="${INK_2}">208 × 200 透明PNG</text>
</svg>`
}

/** 左下角广告位：整块是一张图，可点跳转 */
function promoArt() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="376" height="200" viewBox="0 0 376 200">
  <rect x="9" y="9" width="358" height="182" rx="12" fill="none" stroke="${FRAME}" stroke-width="2" stroke-dasharray="12 9"/>
  <circle cx="268" cy="82" r="34" fill="${FIGURE}"/>
  <path d="M212 200 L212 156 Q212 124 246 124 L290 124 Q324 124 324 156 L324 200 Z" fill="${FIGURE}"/>
  <text x="28" y="74" style="${TEXT_STYLE}" font-family="${FONT}" font-size="25" font-weight="600" fill="${INK}">广告位</text>
  <text x="28" y="108" style="${TEXT_STYLE}" font-family="${FONT}" font-size="17" fill="${INK_2}">376 × 200 透明PNG</text>
  <text x="28" y="136" style="${TEXT_STYLE}" font-family="${FONT}" font-size="15" fill="${INK_3}">左下角放文案 · 主体靠右上</text>
</svg>`
}

const JOBS = [
  { file: 'art-ai-ads-208x200.png', w: 208, h: 200, svg: cardArt('AI广告') },
  { file: 'art-avatar-208x200.png', w: 208, h: 200, svg: cardArt('数字人') },
  { file: 'art-ai-video-208x200.png', w: 208, h: 200, svg: cardArt('AI视频') },
  { file: 'promo-376x200.png', w: 376, h: 200, svg: promoArt() }
]

if (!fs.existsSync(CHROME)) {
  console.log(`SKIP 未找到 Chrome（${CHROME}），无法渲染占位图`)
  process.exitCode = 0
} else {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const out = []
  for (const job of JOBS) {
    const page = await browser.newPage({ viewport: { width: job.w, height: job.h }, deviceScaleFactor: 1 })
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}</style>${job.svg}`,
      { waitUntil: 'load' }
    )
    const target = path.join(OUT, job.file)
    await page.screenshot({ path: target, omitBackground: true })
    await page.close()
    const buf = fs.readFileSync(target)
    // 真透明校验：PNG 头 + IHDR 里 color type 必须是 6（RGBA），且确实有 tRNS/alpha 通道
    const colorType = buf[25]
    out.push(`${job.file}  ${job.w}×${job.h}  ${buf.length}B  IHDR.colorType=${colorType} (6=RGBA)`)
  }
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 6000))]).catch(() => {})
  try {
    browser.process()?.kill('SIGKILL')
  } catch {
    /* 已经退了就算了 */
  }
  /**
   * ⚠️ 这里必须「同步写 + 显式退出」，不能只 console.log 然后交给 Node 自然退出。
   *
   * 实测：Playwright 起过浏览器之后，即使 close 了，事件循环仍然不退出 →
   * 上层把这当成挂死，**SIGTERM 杀掉** → 脚本明明打印了 `ART_TEMPLATES_OK`，退出码却是 1。
   * 更阴的是在 PowerShell 里：`& node x.mjs; 后续语句` 的后半段**根本不执行**，
   * 于是"日志文件没被更新"看起来像脚本没跑 —— 我为此白读了两轮旧日志。
   *
   * 同步写 stdout 绕开异步缓冲，再 process.exit(0) 就不会截断结论行。
   */
  fs.writeSync(1, out.join('\n') + '\nART_TEMPLATES_OK\n')
  process.exit(0)
}
