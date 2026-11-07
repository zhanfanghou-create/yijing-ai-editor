#!/usr/bin/env node
/**
 * 特效素材包闸门（静态契约 + 安装解析 + 逐帧像素）。
 *
 * ## 它为什么必须存在
 * 上一轮的教训写在这里：343 张特效卡只有 6 个真效果时，`check-material-thumbs`
 * 的 13 条断言**全绿** —— 因为"每张卡都有图、同键同图、一图一键"全部成立。
 * 它判的是「图与键的关系」，不是「键背后到底有没有东西」。
 *
 * 素材型特效（kind: `pack`）把这个问题放大了一档：卡片的 `css` 键指向
 * `resources/fxpacks/*.yjpack` 里的帧序列。少一个帧文件、帧序列全透明、
 * 雪碧图只拼了一半 —— **界面完全看不出异常**，点下去"没反应"或"动一下就不动了"。
 *
 * 所以这里逐帧量三件事，而不是看文件在不在：
 *   ① 覆盖率（每帧真的有内容，不是一张空图）；
 *   ② 相邻帧差（真的在动，不是 30 张一模一样的图）；
 *   ③ 首尾差（循环无缝，不会每 3 秒"啪"地跳一下）。
 *
 * ⚠️ 判据全部读**消费端**（解压后的真实文件、真实像素），不读生成器源码。
 *    `gen-fx-packs.py` 写错了但产物没问题 → 闸门绿，这是对的；
 *    产物有问题而生成器"看起来对" → 闸门必须红。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'x.js'))
const fxpack = require('./fxpack')
const table = require('../shared/fxpack')
const frameEffects = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'frameEffects.json'), 'utf8')
)
const MAT = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'materials.js')

const results = []
const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail })

const userData = path.join(os.tmpdir(), 'yjai-e2e', 'fxpack-gate')
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })

const deps = {
  resourcesPath: path.join(ROOT, 'packages', 'desktop', 'resources'),
  appPath: path.join(ROOT, 'packages', 'desktop'),
  mainDir: path.join(ROOT, 'packages', 'desktop', 'src', 'main'),
  userData,
  mediaUrlOf: (p) => `yjai-media://local/${p}`
}

/* ------------------------------ 1. 包本身 ------------------------------ */

const zipPath = path.join(deps.resourcesPath, 'fxpacks', `${table.BUILTIN_PACK}.yjpack`)
const zipBytes = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0
add('内置素材包存在且不是空壳（> 1MB）', zipBytes > 1024 * 1024, `${(zipBytes / 1024 / 1024).toFixed(2)} MB`)

const install = fxpack.installBuiltin(deps)
add('能装到 userData（解包不报错）', install.ok, install.error || `skipped=${install.skipped}`)

const again = fxpack.installBuiltin(deps)
add('重复安装会跳过（幂等，不重复解 10MB）', again.ok && again.skipped === true, `skipped=${again.skipped}`)

const rootDir = path.join(userData, 'fxpacks', table.BUILTIN_PACK)
const manifest = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
})()
add(
  'manifest 是特效素材包（kind 与版本都对）',
  Boolean(manifest) && manifest.kind === table.FXPACK_KIND && manifest.version === table.FXPACK_VERSION,
  manifest ? `${manifest.kind} v${manifest.version}` : '读不出来'
)

/* --------------------------- 2. 表 ↔ 包 双向一致 --------------------------- */

const packKeysInTable = frameEffects.effects.filter((e) => e.kind === 'pack').map((e) => e.key)
const packIdsInTable = frameEffects.effects.filter((e) => e.kind === 'pack').map((e) => e.pack)
const keysInPack = manifest ? manifest.effects.map((e) => e.key) : []

const missingInPack = packIdsInTable.filter((id) => !keysInPack.includes(id))
add(
  '表里的素材特效在包里都有（缺了就是"选了没反应"）',
  packIdsInTable.length > 0 && missingInPack.length === 0,
  missingInPack.length ? `缺 ${missingInPack.join(',')}` : `${packIdsInTable.length} 个全部命中`
)

const orphanInPack = keysInPack.filter((k) => !packIdsInTable.includes(k))
add(
  '包里没有表外的孤儿效果（多出来的没人用）',
  orphanInPack.length === 0,
  orphanInPack.length ? `孤儿 ${orphanInPack.join(',')}` : '无孤儿'
)

const badField = frameEffects.effects.filter((e) => e.kind === 'pack' && e.pack !== e.key).map((e) => e.key)
add('表里每个素材特效的 pack 字段与自己的 key 一致', badField.length === 0, badField.join(',') || '一致')

/* ------------------------- 3. 帧序列的真实像素 ------------------------- */

const METRICS_PY = `
import json, os, sys
from PIL import Image, ImageChops
root = sys.argv[1]
manifest = json.load(open(os.path.join(root, 'manifest.json'), encoding='utf-8'))

def premul(im):
    """RGBA → 预乘 RGB。

    ⚠️ 直接用 RGBA 相减或先 convert('RGB') 都不行：
       · convert('RGB') 丢掉 alpha ⇒ 月亮那种"亮度在呼吸"（alpha 0.45→1.0）
         算出来帧间差只有 0.77，看着像一张静态图，判据却该红不红；
       · RGBA 直接减 ⇒ 全透明区域里 RGB 随便怎么变都算"变化"，
         而用户根本看不见（生成器把颜色清成 0 时会被判成"动得很厉害"）。
    预乘之后：透明处恒等于 0（看不见 = 不变化），半透明处按可见度加权。
    """
    r, g, b, a = im.split()
    return Image.merge('RGB', (
        ImageChops.multiply(r, a),
        ImageChops.multiply(g, a),
        ImageChops.multiply(b, a)
    ))

out = {}
for e in manifest['effects']:
    d = os.path.join(root, e['dir'].replace('/', os.sep))
    files = sorted(f for f in os.listdir(d) if f.lower().endswith('.png'))
    covs, diffs, names = [], [], []
    prev = None
    first = None
    prev_alpha = 0.0
    first_alpha = 0.0
    for f in files:
        im = Image.open(os.path.join(d, f)).convert('RGBA')
        names.append(f)
        hist = im.getchannel('A').histogram()
        covs.append(round(sum(hist[9:]) / float(im.width * im.height), 4))
        cur = premul(im)
        alpha = sum(im.getchannel('A').getdata()) / 255.0
        if prev is not None:
            d2 = ImageChops.difference(cur, prev).convert('L')
            px = list(d2.getdata())
            # 除以"两帧里更小的那块内容面积" ⇒ 得到内容区上的平均变化，
            # 不会被大面积透明稀释（雨丝/微粒这种本来就只占几个百分点）
            diffs.append(round(sum(px) / max(1.0, min(alpha, prev_alpha)), 3))
        if first is None:
            first = cur
            first_alpha = alpha
        prev = cur
        prev_alpha = alpha
    loop = ImageChops.difference(prev, first).convert('L')
    lpx = list(loop.getdata())
    loopd = round(sum(lpx) / max(1.0, min(prev_alpha, first_alpha)), 3)
    sheet = Image.open(os.path.join(root, e['sheet'].replace('/', os.sep)))
    out[e['key']] = {
        'files': len(files),
        'names': names,
        'coverage': covs,
        'diffs': diffs,
        'loopDiff': loopd,
        'sheet': [sheet.width, sheet.height],
        'frames': e['frames'],
        'fps': e['fps']
    }
print(json.dumps(out))
`

let metrics = null
try {
  metrics = JSON.parse(execFileSync('python', ['-W', 'ignore', '-c', METRICS_PY, rootDir], {
    encoding: 'utf8',
    timeout: 300000
  }))
} catch (err) {
  console.log(`[FAIL] 前置 :: 量不出帧像素（python + Pillow 不可用？）${String(err.message).slice(0, 160)}`)
  console.log('FX_PACKS_FAILED')
  process.exit(1)
}

const blankFrames = []
const stillSeries = []
const brokenLoop = []
const sheetBad = []
const countBad = []

for (const [key, m] of Object.entries(metrics)) {
  if (m.files !== m.frames) countBad.push(`${key}:${m.files}/${m.frames}`)
  /* 缺号检查：文件名必须是 f000..f0(N-1)，中间断一个 ffmpeg 会静静截断成短片 */
  for (let i = 0; i < m.frames; i += 1) {
    const want = table.frameName(i)
    if (m.names[i] !== want) {
      countBad.push(`${key}:第 ${i} 帧叫 ${m.names[i] || '空'}，应为 ${want}`)
      break
    }
  }
  const minCov = Math.min(...m.coverage)
  if (minCov < 0.01) blankFrames.push(`${key}:最低覆盖 ${(minCov * 100).toFixed(2)}%`)
  const maxDiff = Math.max(...m.diffs, 0)
  const avgDiff = m.diffs.reduce((a, b) => a + b, 0) / Math.max(1, m.diffs.length)
  if (avgDiff < 5) stillSeries.push(`${key}:相邻帧平均差 ${avgDiff.toFixed(3)}`)
  /* 循环无缝：首尾差不能明显大于"相邻帧之间最大的一次变化"，
     否则循环回到第一帧时画面会跳一下（30 帧 3 秒，跳一下非常显眼）。 */
  if (m.loopDiff > Math.max(2, maxDiff * 3)) {
    brokenLoop.push(`${key}:首尾差 ${m.loopDiff} > 相邻最大差 ${maxDiff} × 3`)
  }
  const wantW = m.frames * 192
  if (m.sheet[0] !== wantW || m.sheet[1] !== 108) {
    sheetBad.push(`${key}:${m.sheet[0]}×${m.sheet[1]}，应为 ${wantW}×108`)
  }
}

add('每个效果的帧数与清单一致、文件名无缺号', countBad.length === 0, countBad.join(' | ') || '全部齐全')
add(
  '没有全透明的空帧（每帧覆盖率 ≥ 1%）',
  blankFrames.length === 0,
  blankFrames.length ? blankFrames.join(' | ') : '每帧都有内容'
)
add(
  '帧序列真的在动（相邻帧平均差 ≥ 5，按内容区归一化）',
  stillSeries.length === 0,
  stillSeries.length ? stillSeries.join(' | ') : '全部在动'
)
add(
  '循环无缝（首尾差 ≤ 相邻最大差的 3 倍）',
  brokenLoop.length === 0,
  brokenLoop.length ? brokenLoop.join(' | ') : '全部接得上'
)
add(
  '雪碧图宽度 = 帧数 × 192（说明真的拼了全部帧）',
  sheetBad.length === 0,
  sheetBad.length ? sheetBad.join(' | ') : '尺寸全对'
)

/* ----------------------- 4. 卡片键没有孤儿 ----------------------- */

/* ⚠️ 键里可以带「@参数串」（2026-11-03 参数化后 343 张卡里 313 张带参数）。
 * 老正则 `[a-z0-9-]+` 匹配不到带 `@` 的卡 —— 于是只捞到 30 张，
 * `cards.length > 200` 这条"覆盖面非空"前置判据直接红，而孤儿数是 0，
 * 报出来是「✗ … :: 30 张卡全部有归属」这种自相矛盾的一行。
 * 这条前置判据本身是对的（捞不到卡就说明正则瞎了），所以修的是正则，不是放宽门槛。 */
const EFFECT_ITEM_RE = /\{\s*zh:\s*"([^"]*)",\s*thumb:\s*"[^"]*",\s*css:\s*"([a-z0-9@-]+)"\s*\}/g
const src = fs.readFileSync(MAT, 'utf8')
const start = src.indexOf('export const EFFECT_GROUPS')
const end = src.indexOf('export const ADJUST_GROUPS')
const seg = src.slice(start, end)
const cards = [...seg.matchAll(EFFECT_ITEM_RE)].map((m) => ({ zh: m[1], css: m[2] }))
const familyOf = (k) => String(k).split('@')[0]
const knownKeys = new Set(frameEffects.effects.map((e) => e.key))
const knownFam = new Set([...knownKeys].map(familyOf))
/* 卡片键按**族键**归属：`fx-glow@2140` 属于 `fx-glow`。
 * 参数串本身合不合法由 `fx-wiring` 第 ⑥b 条管（逐位比档位范围），这里只管"族在不在表里"。 */
const resolve = (k) => knownKeys.has(k) || knownFam.has(familyOf(k))
const orphanCards = cards.filter((c) => !resolve(c.css))
add(
  '特效卡片的 css 键全部在特效表里（没有指向不存在效果的卡）',
  cards.length > 200 && orphanCards.length === 0,
  orphanCards.length ? `${orphanCards.length} 张孤儿：${orphanCards.slice(0, 5).map((c) => c.zh).join(',')}` : `${cards.length} 张卡全部有归属`
)

const packCards = cards.filter((c) => c.css.startsWith('fm-'))
const misuse = packCards.filter((c) => !packIdsInTable.includes(familyOf(c.css)))
add(
  '素材型卡片指向的都是包内真实存在的效果',
  packCards.length > 0 && misuse.length === 0,
  misuse.length ? misuse.map((c) => `${c.zh}→${c.css}`).join(',') : `${packCards.length} 张素材卡全部命中`
)

/* ------------------------------ 汇总 ------------------------------ */

let pass = 0
let failed = 0
for (const r of results) {
  if (r.ok) pass += 1
  else failed += 1
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
}
console.log('')
for (const [key, m] of Object.entries(metrics)) {
  const cov = ((m.coverage.reduce((a, b) => a + b, 0) / m.coverage.length) * 100).toFixed(1)
  const avg = (m.diffs.reduce((a, b) => a + b, 0) / Math.max(1, m.diffs.length)).toFixed(2)
  console.log(`  ${key.padEnd(13)} ${String(m.frames).padStart(2)}帧@${m.fps}fps  覆盖 ${cov.padStart(5)}%  帧间差 ${avg.padStart(6)}  首尾差 ${String(m.loopDiff).padStart(6)}  雪碧图 ${m.sheet[0]}×${m.sheet[1]}`)
}
console.log(`\nFX_PACKS_STATS total=${results.length} pass=${pass} fail=${failed}`)
if (failed === 0) {
  console.log('素材包的帧序列真的在动、循环接得上、雪碧图拼全了，卡片也全部指得到。')
  console.log('FX_PACKS_OK')
} else {
  console.log('FX_PACKS_FAILED')
}
process.exit(failed === 0 ? 0 : 1)
