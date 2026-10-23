#!/usr/bin/env node
/**
 * 预览画质 / 代理文件 闸门。
 *
 * 这块管的是**预览与成片的分叉点**，错法全都"两边单独看都对"：
 *   ① 代理生成失败/没登记白名单 ⇒ 界面显示"已切到 540p"，预览还卡在原片上；
 *   ② 代理把源**放大**（源本来 480p，"540p 代理"插值成 540）⇒ 更糊更慢；
 *   ③ 源被替换过但代理没重做 ⇒ 预览里放的是上一版素材（看着像"替换没生效"）；
 *   ④ 导出侧误用代理 ⇒ 成片比预览还糊，而预览与导出**都"正常"**。
 *
 * 所以判据分四层：档位表 / 文件名与缩放滤镜 / 真跑 ffmpeg 生成代理（尺寸·时长·缓存·失效重做）/
 * **真导出读像素**（成片必须来自原片，不是代理）。
 *
 * 用法：node tools/check-proxy.mjs
 * 退出码：0 = 通过；1 = 有失败；2 = 本机没有 ffmpeg（如实报，不假绿）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = path.join(ROOT, 'packages', 'desktop', 'src', 'shared')
const proxy = require(path.join(SHARED, 'proxy.js'))
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? `  —— ${detail}` : ''}`)
  } else {
    fail += 1
    problems.push(label)
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const near = (a, b, tol = 0.002) => Math.abs(Number(a) - Number(b)) <= tol

/* ---------------------- ① 档位表 ---------------------- */

console.log('\n=== ① 档位表：未知值必须回落"完整"，不能神秘变糊 ===')

check('完整档 = 不做代理（高度 0）', proxy.heightFor('full') === 0)
check('流畅档 = 720p', proxy.heightFor('smooth') === 720)
check('极速档 = 540p', proxy.heightFor('fast') === 540)
check('未知档位回落完整（不会因为存了个脏值就默默降质）', proxy.normalizeQuality('ultra') === 'full')
check('null / undefined 回落完整', proxy.normalizeQuality(null) === 'full' && proxy.normalizeQuality(undefined) === 'full')
check('needsProxy 与高度一致', proxy.needsProxy('fast') === true && proxy.needsProxy('full') === false)
check('界面顺序与档位表一一对应（少一个就是"面板上有、实现里没有"）',
  proxy.QUALITY_ORDER.every((key) => proxy.QUALITY_HEIGHTS[key] !== undefined) && proxy.QUALITY_ORDER.length === 3,
  proxy.QUALITY_ORDER.join('/'))
check('每一档都有中文名（提示文案与界面共用一份）',
  proxy.QUALITY_ORDER.every((key) => Boolean(proxy.QUALITY_LABELS[key])))

/* ---------------------- ② 文件名与缩放 ---------------------- */

console.log('\n=== ② 文件名与缩放滤镜 ===')

const nameA = proxy.proxyName('C:\\Users\\x\\素材\\影片 A.mp4', 540)
check('文件名里带分辨率后缀（多档共存不互相覆盖）', nameA.endsWith('-540p.mp4'), nameA)
check('文件名稳定（同一输入两次一样）', proxy.proxyName('C:\\Users\\x\\素材\\影片 A.mp4', 540) === nameA)
check('不同路径得到不同文件名', proxy.proxyName('D:\\b.mp4', 540) !== proxy.proxyName('D:\\c.mp4', 540))
check('路径很长时文件名也不长（防 MAX_PATH：生成失败会报 Invalid argument，指不到"名字太长"）',
  proxy.proxyName('C:\\' + '很长的目录\\'.repeat(30) + 'a.mp4', 720).length < 80,
  String(proxy.proxyName('C:\\' + '很长的目录\\'.repeat(30) + 'a.mp4', 720).length))
check('缩放滤镜写的是 min(ih,H) —— 源比目标矮时不放大', /min\(ih,540\)/.test(proxy.scaleFilter(540)), proxy.scaleFilter(540))
check('宽度取偶数（-2），奇数宽会让 libx264 直接报错', /^scale=-2:/.test(proxy.scaleFilter(720)), proxy.scaleFilter(720))

/* ---------------------- ③ 真跑 ffmpeg 生成代理 ---------------------- */

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('\nPROXY_FFMPEG_SKIPPED 本机没有 ffmpeg（生成与导出那两段没法验）')
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  process.exit(fail ? 1 : 2)
}
const ffmpeg = found.ffmpeg
const ffprobe = found.ffprobe
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-proxy-'))
const outDir = path.join(work, 'proxies')

function probeSize(file) {
  const result = spawnCapture(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { tag: 'ffprobe-size' })
  const text = String(result.stdout || '').trim().split('\n')[0] || ''
  const [w, h] = text.split(',').map((value) => Number(value))
  return { width: w, height: h }
}
function probeDuration(file) {
  const result = spawnCapture(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { tag: 'ffprobe-dur' })
  return Number(String(result.stdout || '').trim())
}

/* 1080p 源：代理必须降到 540；再准备一段 480p 源，验证"不放大" */
const big = path.join(work, 'big.mp4')
spawnCapture(
  ffmpeg,
  ['-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:r=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', big],
  { tag: 'mk-big' }
)
const small = path.join(work, 'small.mp4')
spawnCapture(
  ffmpeg,
  ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=854x480:r=25',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', small],
  { tag: 'mk-small' }
)
check('两段夹具生成完毕（1080p / 480p）', fs.existsSync(big) && fs.existsSync(small))

const made = await render.makeProxy({ sourcePath: big, height: 540, outDir })
check('代理生成成功', made.ok === true, String(made.error || ''))
const size = made.ok ? probeSize(made.outPath) : { width: 0, height: 0 }
check('代理高度 = 540（真的降了，不是原样拷一份）', size.height === 540, `${size.width}×${size.height}`)
check('代理宽度按比例且是偶数', size.width === 960 && size.width % 2 === 0, String(size.width))

const srcDuration = probeDuration(big)
const proxyDuration = made.ok ? probeDuration(made.outPath) : 0
check('代理时长与源一致（±0.2 秒）', Math.abs(proxyDuration - srcDuration) <= 0.2, `${proxyDuration} vs ${srcDuration}`)

/* ⚠️ 这里**不比文件体积**：纯色夹具在 1080p 下本来就能压到几十 KB，
   而代理要带音轨、还换了编码参数，体积反而可能更大。比"像素数"才是这件事的实质 ——
   代理的意义是"解码与渲染的像素少 4 倍"，不是"文件小"。 */
const srcSize = probeSize(big)
check('代理的像素数只有源的 1/4 以下（这才是"降画质"的实质）',
  size.width * size.height * 4 <= srcSize.width * srcSize.height,
  `${size.width}×${size.height} vs ${srcSize.width}×${srcSize.height}`)

const proxyStreams = made.ok ? await render.probeStreams(made.outPath) : null
check('代理里保留了音轨（没声音会被误判成"素材坏了"）', Boolean(proxyStreams && proxyStreams.hasAudio),
  JSON.stringify(proxyStreams))

const again = await render.makeProxy({ sourcePath: big, height: 540, outDir })
check('第二次调用直接复用（cached=true，不重复跑 ffmpeg）', again.ok === true && again.cached === true)

/* 源被替换（mtime 变新）之后必须重做：否则预览里放的是上一版素材 */
const later = new Date(Date.now() + 5000)
fs.utimesSync(big, later, later)
const regenerated = await render.makeProxy({ sourcePath: big, height: 540, outDir })
check('源文件更新后代理会重做（cached=false）', regenerated.ok === true && regenerated.cached === false)

/* 480p 源要 540p 代理：不许放大 */
const smallProxy = await render.makeProxy({ sourcePath: small, height: 540, outDir })
const smallSize = smallProxy.ok ? probeSize(smallProxy.outPath) : { width: 0, height: 0 }
check('源比目标矮时不放大（480 → 仍是 480）', smallSize.height === 480, `${smallSize.width}×${smallSize.height}`)

const badInput = await render.makeProxy({ sourcePath: path.join(work, 'nope.mp4'), height: 540, outDir })
check('源文件不存在时明确失败（不是悄悄给个空路径）', badInput.ok === false && /不在了/.test(String(badInput.error)), String(badInput.error))

/* ---------------------- ④ 导出必须用原片（读像素） ---------------------- */

console.log('\n=== ④ 真导出：成片来自原片，不是代理 ===')

function centerPixel(file, at) {
  const out = path.join(work, `px-${Math.random().toString(36).slice(2, 8)}.rgb`)
  spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', out],
    { tag: 'px' }
  )
  if (!fs.existsSync(out)) return null
  const buf = fs.readFileSync(out)
  const i = (4 * 8 + 4) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}

/* 原片是红、代理是蓝：如果导出侧误用了代理，成片中心会是蓝 —— 一眼分辨 */
const blueProxy = small
const outFile = path.join(work, 'out.mp4')
const clip = {
  id: 'c1',
  track: 'video',
  kind: 'video',
  path: big,
  proxyUrl: 'yjai-media://proxy-should-never-be-used',
  proxyPath: blueProxy,
  start: 0,
  duration: 1,
  offset: 0,
  sourceDuration: 3,
  name: 'red'
}
const result = await render.render({ clips: [clip], outPath: outFile, options: { width: 320, height: 240, fps: 25 } })
check('导出成功', result.ok === true && fs.existsSync(outFile), String(result.error || '').slice(0, 200))
const px = result.ok ? centerPixel(outFile, 0.5) : null
check('成片中心是红（原片），不是代理那条路径', Boolean(px) && px[0] > 120 && px[2] < 90, px ? `rgb(${px.join(',')})` : '读不到像素')

/* 结构上的保证：导出侧压根没有"读代理"的入口。
   （上面那条像素判据已经证明"这一次"没用代理；这条钉的是"以后也不会有人顺手加上"） */
const renderSource = fs.readFileSync(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'), 'utf8')
check('导出代码里没有任何地方读 clip.proxyUrl / clip.proxyPath（结构上就没有代理入口）',
  !/\bclip\.proxy(Url|Path)\b/.test(renderSource) && !/\bproxyUrl\b/.test(renderSource),
  (renderSource.match(/\bclip\.proxy(Url|Path)\b/g) || []).join(','))

console.log('')
if (!fail) console.log('PROXY_OK')
console.log(`=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('失败项：')
  for (const item of problems) console.log(`  - ${item}`)
}
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch {
  /* 删不掉就留着 */
}
process.exit(fail ? 1 : 0)
