#!/usr/bin/env node
/**
 * 「改像素」三件套的**真渲染**闸门：柔化 / 黑白 / 复古。
 *
 * 为什么必需：这三条都是覆盖层 `backdrop-filter`，它们最常见的坏法是
 *   "CSS 命中、computedStyle 也对、画面一像素没变"（层被别的东西挡住 / 没有可模糊的背面）。
 * 静态扫描与 `fx-wiring` 都判不出来 —— 那种错只有量像素才能抓到。
 *
 * 做法（判据全部读**消费端**）：
 *   1. 在真实 Electron 渲染器里注入一块高对比条纹测试图（不用草稿、不用素材）；
 *   2. 把应用**自己的** `.canvas-fx.<key>` 类挂上去（用应用加载的那份 styles.css，不复制样式）；
 *   3. 截图后量三个数：边缘能量（模糊）/ 饱和度（黑白、复古）/ 冷暖（复古）。
 *
 * 实测基准（1920×1032 窗口、240×240 取样、Chromium 内嵌）：
 *   无覆盖层 edge=58.21 sat=0.598 warm=-0.5
 *   fx-blur  edge= 1.70 sat=0.108   ← 边缘掉 97%
 *   fx-mono  edge=57.66 sat=0.000   ← 饱和度归零
 *   fx-vintage edge=58.42 sat=0.286 warm=+6.1
 *
 * 阈值都留了大余量（按实测的一半取），不会因为显卡/缩放差异偶发红。
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const TAG = process.env.YJAI_FX_PROFILE_TAG || String(process.pid)
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.fx-pixel-profile-${TAG}`)
const OUT = path.join(os.tmpdir(), 'yjai-e2e', 'fx-pixel', TAG)
fs.mkdirSync(OUT, { recursive: true })

/**
 * app.close() 的超时兜底。
 * ⚠️ 必须包：这个环境里 `app.close()` 有可能**永不返回**（实测挂死 28 分钟，
 *    断言早就跑完、结论也落盘了，卡住的只是退出那一步）。`check-e2e-teardown`
 *    会扫每个 `app.close()`，裸等直接判红。
 */
function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    })
  ])
}

const PATTERN = `
  background-image:
    repeating-linear-gradient(90deg, #ff2a2a 0 8px, #1b3bff 8px 16px),
    repeating-linear-gradient(0deg, rgba(255,255,255,0.9) 0 3px, rgba(0,0,0,0.9) 3px 9px);
  background-blend-mode: overlay;
`

const METRICS_PY = `
import json, os, sys
from PIL import Image, ImageFilter
d = sys.argv[1]
def m(name):
    im = Image.open(os.path.join(d, name + '.png')).convert('RGB')
    g = im.convert('L').filter(ImageFilter.FIND_EDGES)
    px = list(g.getdata())
    edge = sum(px) / len(px)
    tot = 0.0; warm = 0.0; n = 0
    for r, gg, b in im.getdata():
        mx = max(r, gg, b); mn = min(r, gg, b)
        tot += (mx - mn) / (mx if mx else 1)
        warm += r - b
        n += 1
    return {'edge': round(edge, 2), 'sat': round(tot / n, 3), 'warm': round(warm / n, 2)}
print(json.dumps({k: m(k) for k in ['none', 'fx-blur', 'fx-mono', 'fx-vintage']}))
`

const results = []
const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail })

const env = { ...process.env, YJAI_NO_WINDOW: '1', YJAI_PROFILE: PROFILE }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ executablePath: EXE, args: [MAIN], env })
let failed = 0
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)

  const shot = async (cls) => {
    await page.evaluate(
      ({ cls, pattern }) => {
        document.getElementById('fxprobe')?.remove()
        const box = document.createElement('div')
        box.id = 'fxprobe'
        box.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:240px;z-index:2147483000;' + pattern
        if (cls) {
          const fx = document.createElement('div')
          fx.className = `canvas-fx ${cls}`
          box.appendChild(fx)
        }
        document.body.appendChild(box)
      },
      { cls, pattern: PATTERN }
    )
    await page.waitForTimeout(260)
    await page.screenshot({ path: path.join(OUT, `${cls || 'none'}.png`), clip: { x: 0, y: 0, width: 240, height: 240 } })
    return page.evaluate(() => {
      const el = document.querySelector('#fxprobe .canvas-fx')
      /* 动画类特效会把 backdrop-filter 之外的属性也带上，这里只关心 backdrop-filter */
      return el ? getComputedStyle(el).backdropFilter : '(none)'
    })
  }

  const css = {}
  css.none = await shot('')
  css.blur = await shot('fx-blur')
  css.mono = await shot('fx-mono')
  css.vintage = await shot('fx-vintage')

  let m
  try {
    m = JSON.parse(
      execFileSync('python', ['-W', 'ignore', '-c', METRICS_PY, OUT], { encoding: 'utf8', timeout: 120000 })
    )
  } catch (err) {
    console.log(`[FAIL] 前置 :: 量不出像素（python + Pillow 不可用？）${String(err.message).slice(0, 120)}`)
    console.log('FX_PIXELS_FAILED')
    await withTimeout(app.close(), 8000, 'app.close').catch(() => {})
    process.exit(1)
  }

  const base = m.none
  add('基准图本身有对比（否则后面全是假绿）', base.edge > 20 && base.sat > 0.3, `edge=${base.edge} sat=${base.sat}`)

  add('fx-blur 的 backdrop-filter 命中', /blur\(/.test(css.blur || ''), css.blur)
  add(
    'fx-blur 真的把边缘糊掉（≤ 基准 40%）',
    m['fx-blur'].edge <= base.edge * 0.4,
    `edge ${base.edge} → ${m['fx-blur'].edge}`
  )

  add('fx-mono 的 backdrop-filter 命中', /grayscale\(/.test(css.mono || ''), css.mono)
  add('fx-mono 真的把饱和度压到 0（≤ 0.05）', m['fx-mono'].sat <= 0.05, `sat ${base.sat} → ${m['fx-mono'].sat}`)

  add('fx-vintage 的 backdrop-filter 命中', /sepia\(/.test(css.vintage || ''), css.vintage)
  add(
    'fx-vintage 真的褪色（饱和度 ≤ 基准 70%）',
    m['fx-vintage'].sat <= base.sat * 0.7,
    `sat ${base.sat} → ${m['fx-vintage'].sat}`
  )
  add(
    'fx-vintage 真的偏暖（R−B 比基准高 3 以上）',
    m['fx-vintage'].warm >= base.warm + 3,
    `warm ${base.warm} → ${m['fx-vintage'].warm}`
  )

  let pass = 0
  for (const r of results) {
    if (r.ok) pass++
    else failed++
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
  }
  console.log(`\nFX_PIXELS_STATS total=${results.length} pass=${pass} fail=${failed}`)
  if (failed === 0) {
    console.log('柔化 / 黑白 / 复古三条特效在真实渲染器里都真的改了像素。')
    console.log('FX_PIXELS_OK')
  } else {
    console.log('FX_PIXELS_FAILED')
  }
} finally {
  await withTimeout(app.close(), 8000, 'app.close').catch(() => {})
}

process.exit(failed === 0 ? 0 : 1)
