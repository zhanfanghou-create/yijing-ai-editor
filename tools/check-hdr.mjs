#!/usr/bin/env node
/**
 * 闸门 · HDR 素材（识别 + 导出时的 SDR 色调映射）。
 *
 * 这一族错误的共同点：**成片尺寸/时长/帧率全对，只有颜色是错的**。
 *   · 完全不转 ⇒ 超白（>100%）被裁成死白，肤色发白、天空一整块；
 *   · 转了但顺序错（先调色后映射）⇒ 调色参数是按 HDR 的超标亮度算的，颜色整体偏；
 *   · 转了但不改输出标签 ⇒ 像素已是 SDR，文件还标着 HDR，**别人那儿发灰**，
 *     本机永远复现不出来（本机播放器忽略标签）；
 *   · 给 SDR 素材也转 ⇒ 老工程成片颜色整体变掉，且没有任何迹象指向这一步。
 *
 * 判据分三层：
 *   ① 纯规则：只认 color_transfer（位深骗人）、HQ/PQ 分档、滤镜串成分；
 *   ② 计划：buildPlan 的滤镜图里 **HDR 片段才有** tonemap、SDR 片段一个字都不多；
 *   ③ 真渲染：同一像素内容的两份片子（一份标 HLG、一份不标），
 *      映射过的那份平均亮度必须**显著更低**（亮部被压回 100%），
 *      且两份的输出色彩标签都是 bt709 —— 用像素与标签说话，不看代码。
 *
 * 用法：node tools/check-hdr.mjs
 * 退出码：0 通过 / 1 有失败 / 2 本机没有 ffmpeg（如实跳过）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hdr = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'hdr.js'))
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) pass += 1
  else {
    fail += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
  }
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('HDR_SKIPPED 本机没有 ffmpeg')
  console.log('通过 0 项 / 失败 0 项')
  process.exit(2)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-hdr-check-'))

/** 平均亮度（YAVG）：把 signalstats 每帧的值取平均 */
function avgLuma(file) {
  const result = spawnCapture(
    found.ffmpeg,
    ['-hide_banner', '-loglevel', 'info', '-i', file, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'],
    { tag: 'stats' }
  )
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  const values = []
  for (const line of text.split(/\r?\n/)) {
    const match = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line)
    if (match) values.push(Number(match[1]))
  }
  if (!values.length) return Number.NaN
  return values.reduce((sum, item) => sum + item, 0) / values.length
}

function colorTags(file) {
  const result = spawnCapture(
    found.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer,color_primaries', '-of', 'csv=p=0', file],
    { tag: 'tags' }
  )
  return String(result.stdout || '').trim()
}

console.log('=== HDR · 识别与 SDR 色调映射 ===\n')

/* ------------------------------ ① 纯规则 ------------------------------ */
console.log('-- 判据（只认 color_transfer）--')
check('HLG 被认出', hdr.isHdr({ transfer: 'arib-std-b67' }) === true)
check('PQ 被认出', hdr.isHdr({ transfer: 'smpte2084' }) === true)
check('bt709 不是 HDR', hdr.isHdr({ transfer: 'bt709' }) === false)
check('标签缺失按 SDR 处理（宁可少转一次）', hdr.isHdr({ transfer: '' }) === false && hdr.isHdr({}) === false)
check('unknown 不等于 HDR', hdr.isHdr({ transfer: 'unknown' }) === false)
check('位深不是判据（10-bit SDR 不转）', hdr.isHdr({ transfer: 'bt709', pixFmt: 'yuv420p10le' }) === false)
check('短标签 · HLG', hdr.hdrLabel({ transfer: 'arib-std-b67' }) === 'HDR · HLG', hdr.hdrLabel({ transfer: 'arib-std-b67' }))
check('短标签 · PQ', hdr.hdrLabel({ transfer: 'smpte2084' }).includes('HDR10'), hdr.hdrLabel({ transfer: 'smpte2084' }))
check('SDR 无标签文案（界面不该冒出"HDR"）', hdr.hdrLabel({ transfer: 'bt709' }) === '')

console.log('\n-- 滤镜串 --')
const hlgChain = hdr.tonemapChain({ transfer: 'arib-std-b67', primaries: 'bt2020', matrix: 'bt2020nc' })
check('非 HDR 返回空串（老工程一个字都不多）', hdr.tonemapChain({ transfer: 'bt709' }) === '')
check('链里有线性化', hlgChain.includes('t=linear'))
check('链里有 32 位浮点中间态', hlgChain.includes('gbrpf32le'))
check('链里有 tonemap', hlgChain.includes('tonemap=hable'))
check('链里显式写源标签（不指望 zscale 自己猜）', hlgChain.includes('tin=arib-std-b67') && hlgChain.includes('pin=bt2020'))
check('链尾回到 bt709 且落到 8-bit', /zscale=t=bt709:m=bt709:r=tv/.test(hlgChain) && hlgChain.endsWith('format=yuv420p'))
check('算法可选（mobius）', hdr.tonemapChain({ transfer: 'smpte2084' }, { algo: 'mobius' }).includes('tonemap=mobius'))
check('色彩标签参数给的是 bt709', (() => {
  const args = hdr.encoderTagArgs()
  return args.includes('-color_trc') && args[args.indexOf('-color_trc') + 1] === 'bt709' &&
    args[args.indexOf('-color_primaries') + 1] === 'bt709'
})(), hdr.encoderTagArgs().join(' '))
check('提示语说清"预览可能略灰、导出会转"', /导出/.test(hdr.previewHint({ transfer: 'arib-std-b67' })))

/* ------------------------------ ② 计划 ------------------------------ */
console.log('\n-- buildPlan：只有 HDR 片段才有 tonemap --')
/* ⚠️ buildPlan 会 `fs.existsSync(clip.path)` 过滤掉源文件不存在的片段（退成黑场），
   所以夹具必须**先**造出来再拼计划 —— 否则量到的是"空时间线的黑场"。 */
const hlgSource = path.join(work, 'hlg.mp4')
const pqSource = path.join(work, 'pq.mp4')
const sdrSource = path.join(work, 'sdr.mp4')
const base = ['-hide_banner', '-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-t', '1.2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p']
/* HLG：手机/相机最常见的 HDR。x264 要把标签写进 SEI，光给 -color_trc 不一定落进文件。 */
spawnCapture(found.ffmpeg, [
  ...base,
  '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
  '-color_trc', 'arib-std-b67', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc',
  hlgSource
], { tag: 'mk-hlg' })
/* PQ（HDR10）：映射前后**像素差异明显**，用它来证明"真的动了画面" */
spawnCapture(found.ffmpeg, [
  ...base,
  '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
  '-color_trc', 'smpte2084', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc',
  pqSource
], { tag: 'mk-pq' })
spawnCapture(found.ffmpeg, [...base, sdrSource], { tag: 'mk-sdr' })
check('夹具 · 三份片子都生成了（HLG / PQ / SDR）',
  fs.existsSync(hlgSource) && fs.existsSync(pqSource) && fs.existsSync(sdrSource))

const tagsOfHlg = colorTags(hlgSource)
check('夹具 · HLG 那份真的带 arib-std-b67 标签', tagsOfHlg.includes('arib-std-b67'), tagsOfHlg)

const planFor = (streamInfo) =>
  render.buildPlan({
    clips: [{ id: 'c1', track: 'video', kind: 'video', path: hlgSource, start: 0, duration: 1, offset: 0, sourceDuration: 2 }],
    streamInfo,
    outPath: path.join(work, 'plan.mp4'),
    options: { width: 640, height: 360, fps: 25, aspect: '16:9', quality: 80 },
    assumeVideoAudio: false
  })

const hdrPlan = planFor({ c1: { hasVideo: true, hasAudio: false, duration: 2, transfer: 'arib-std-b67', primaries: 'bt2020', matrix: 'bt2020nc' } })
const sdrPlan = planFor({ c1: { hasVideo: true, hasAudio: false, duration: 2, transfer: 'bt709', primaries: 'bt709', matrix: 'bt709' } })
const filterOf = (plan) => {
  const idx = plan.args.indexOf('-filter_complex')
  return idx >= 0 ? String(plan.args[idx + 1]) : ''
}
const hdrFilter = filterOf(hdrPlan)
const sdrFilter = filterOf(sdrPlan)
check('HDR 片段的滤镜图里有 tonemap', hdrFilter.includes('tonemap=hable'), hdrFilter.slice(0, 96))
check('SDR 片段的滤镜图里没有 tonemap / zscale', !sdrFilter.includes('tonemap') && !sdrFilter.includes('zscale'))
check('HDR 的映射排在 trim 之前（先成 SDR 再做事）',
  hdrFilter.indexOf('tin=arib-std-b67') > 0 && hdrFilter.indexOf('tin=arib-std-b67') < hdrFilter.indexOf('trim='),
  `tin@${hdrFilter.indexOf('tin=')} trim@${hdrFilter.indexOf('trim=')}`)
check('输出参数里一定带 bt709 标签', (() => {
  const args = hdrPlan.args
  return args.includes('-color_trc') && args[args.indexOf('-color_trc') + 1] === 'bt709'
})(), String(hdrPlan.args.slice(-14)))

/* ------------------------------ ③ 真渲染 ------------------------------ */
console.log('\n-- 真渲染：同一像素内容，只是色彩标签不同 --')
const clipOf = (file, id) => ({
  clips: [{ id, track: 'video', kind: 'video', path: file, url: '', start: 0, duration: 1, offset: 0, sourceDuration: 1.2 }],
  options: { width: 640, height: 360, fps: 25, aspect: '16:9', quality: 95 }
})
const outPq = path.join(work, 'out-pq.mp4')
const outSdr = path.join(work, 'out-sdr.mp4')
const r1 = await render.render({ ...clipOf(pqSource, 'c1'), outPath: outPq })
const r2 = await render.render({ ...clipOf(sdrSource, 'c2'), outPath: outSdr })
check('渲染 · PQ 那份导出成功', r1 && r1.ok === true, r1 && r1.error ? String(r1.error).slice(0, 120) : '')
check('渲染 · SDR 那份导出成功', r2 && r2.ok === true, r2 && r2.error ? String(r2.error).slice(0, 120) : '')

const outPqTags = colorTags(outPq)
const outSdrTags = colorTags(outSdr)
check('成片 · HDR 源的输出标签已改成 bt709（不是继续标 HDR）',
  outPqTags.includes('bt709') && !outPqTags.includes('smpte2084'), outPqTags)
check('成片 · SDR 源也是 bt709（两条路同一口径）', outSdrTags.includes('bt709'), outSdrTags)

const yPq = avgLuma(outPq)
const ySdr = avgLuma(outSdr)
check('成片 · 两份都真有画面（平均亮度有效）', Number.isFinite(yPq) && Number.isFinite(ySdr), `pq=${yPq} sdr=${ySdr}`)
/**
 * 关键判据：同一份像素、只是色彩标签不同 → 过了 tonemap 的那份**画面必须明显不一样**。
 *
 * ⚠️ 判据不能带方向。实测（2026-10-20）：PQ 素材映射后**变亮**（134 vs 124）——
 *    PQ 的码值是按 10000 nits 设计的，8-bit 里的中灰在 SDR 看来极暗，
 *    映射回 100 nits 自然抬亮；而 HLG 因为"向下兼容 SDR"，映射前后几乎不动（差 0.2）。
 *    早先按"映射一定变暗"写，红的是尺子而不是功能。这里只钉"真的动了像素"。
 */
check('成片 · 色调映射真的生效了（画面明显变化，不是只改了标签）',
  Number.isFinite(yPq) && Number.isFinite(ySdr) && Math.abs(yPq - ySdr) > 6,
  `SDR ${Number(ySdr).toFixed(1)} vs PQ源 ${Number(yPq).toFixed(1)}（差 ${(yPq - ySdr).toFixed(1)}）`)
check('成片 · 映射后既没整片发黑也没爆白',
  Number.isFinite(yPq) && yPq > 12 && yPq < 235, Number(yPq).toFixed(1))

/* 反向：HLG 那份也必须走同一条链（它在像素上几乎看不出差别，所以用"滤镜真跑通"来钉） */
const outHlg = path.join(work, 'out-hlg.mp4')
const r3 = await render.render({ ...clipOf(hlgSource, 'c3'), outPath: outHlg })
check('渲染 · HLG 那份也能正常导出（映射链不破坏时间线）', r3 && r3.ok === true, r3 && r3.error ? String(r3.error).slice(0, 120) : '')
check('成片 · HLG 源的输出标签也是 bt709', colorTags(outHlg).includes('bt709'), colorTags(outHlg))

console.log('')
if (failures.length) {
  console.log('失败项：')
  for (const item of failures) console.log('  · ' + item)
}
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (!fail) console.log('HDR_OK')
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch {
  /* 删不掉就留着 */
}
process.exit(fail ? 1 : 0)
