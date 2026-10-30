/**
 * 导出编码格式（`shared/exportCodec.js`）的纯逻辑自测。
 *
 * 这里不跑 ffmpeg —— 它证的是「表本身自洽、回落不跨族、像素格式随编码器变」。
 * 真 ffmpeg 能不能按这些参数编出来，由 render 闸门用 ffprobe 读成片去证。
 * 两层缺一不可：这里绿了只说明参数对，参数对不等于成片真的是 10bit。
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const codec = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'exportCodec.js'))

let pass = 0
let fail = 0
let skip = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) pass += 1
  else {
    fail += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
  }
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

const C = codec.CODECS
const keys = C.map((item) => item.key)

console.log('\n-- 一、表的自洽 --\n')

check('编码格式表非空且不少于五种', C.length >= 5, `${C.length} 种`)
check('key 无重复', new Set(keys).size === keys.length, keys.join('/'))
check('label 无重复', new Set(C.map((i) => i.label)).size === C.length)
check(
  '每种格式的容器与扩展名一致（mp4 容器配 .mp4、mov 配 .mov）',
  C.every((item) => (item.container === 'mp4' && item.ext === 'mp4') || (item.container === 'mov' && item.ext === 'mov')),
  C.map((i) => `${i.key}:${i.container}/${i.ext}`).join(' ')
)
check(
  '每种格式都写了 note（面板要显示给用户看，不能只有名字）',
  C.every((item) => typeof item.note === 'string' && item.note.length >= 6)
)
check(
  '每种格式的 family 都在 FAMILIES 里（否则 encodersFor 会静默退到 h264 族）',
  C.every((item) => Object.prototype.hasOwnProperty.call(codec.FAMILIES, item.family)),
  C.map((i) => i.family).join('/')
)

console.log('\n-- 二、色深与 Alpha --\n')

const deep = C.filter((item) => item.bitDepth >= 10)
check('高位深（≥10 位）格式至少三档（H.265 10bit / ProRes 422 / ProRes 4444）', deep.length >= 3, `${deep.length} 档`)
check(
  '凡高位深格式的像素格式后缀是 10le 或 12le（不是悄悄还是 8 位）',
  deep.every((item) => /(10|12)le$/.test(item.pixFmt)),
  deep.map((i) => `${i.key}:${i.pixFmt}`).join(' ')
)
check(
  '8bit 的像素格式都不带位深后缀',
  C.filter((i) => i.bitDepth === 8).every((i) => !/(10|12)le$/.test(i.pixFmt)),
  C.filter((i) => i.bitDepth === 8).map((i) => `${i.key}:${i.pixFmt}`).join(' ')
)
check(
  'bitDepth 字段与像素格式后缀一致（写 10 却给 12le 的格式会在这里红）',
  C.every((item) => {
    const hit = /(\d+)le$/.exec(item.pixFmt)
    return hit ? Number(hit[1]) === item.bitDepth : item.bitDepth === 8
  }),
  C.map((i) => `${i.key}:${i.bitDepth}/${i.pixFmt}`).join(' ')
)
check(
  'ProRes 4444 写的是 12 位（prores_ks 对 4444 一律写 12 位，传 10le 也得到 12le）',
  C.find((i) => i.key === 'prores-4444').pixFmt === 'yuva444p12le',
  C.find((i) => i.key === 'prores-4444').pixFmt
)

const alphaOnes = C.filter((item) => item.alpha)
check('只有 ProRes 4444 带 Alpha（就一种）', alphaOnes.length === 1, alphaOnes.map((i) => i.key).join('/'))
check(
  '带 Alpha 的那一档像素格式含 a（yuva…），否则编码器会把透明通道整体丢掉',
  alphaOnes.length === 1 && /yuva/.test(alphaOnes[0].pixFmt),
  alphaOnes[0] ? alphaOnes[0].pixFmt : '(无)'
)
check(
  '带 Alpha 的格式在 mov 容器里（mp4 装不了 ProRes 4444）',
  alphaOnes.length === 1 && alphaOnes[0].container === 'mov'
)

console.log('\n-- 三、规范化与回落 --\n')

for (const [raw, expect] of [
  [undefined, 'h264'],
  ['', 'h264'],
  ['H264', 'h264'],
  ['  h264  ', 'h264'],
  ['av1', 'h264'],
  [null, 'h264'],
  ['prores-4444', 'prores-4444']
]) {
  check(
    `读「${raw === null ? 'null' : raw === undefined ? 'undefined' : `"${raw}"`}」→ ${expect}`,
    codec.readCodec(raw).key === expect,
    codec.readCodec(raw).key
  )
}

console.log('\n-- 四、像素格式随编码器变 --\n')

check('h265-10 + 软编 libx265 → yuv420p10le',
  codec.pixelFormatFor('h265-10', 'libx265') === 'yuv420p10le', codec.pixelFormatFor('h265-10', 'libx265'))
check('h265-10 + hevc_nvenc → p010le',
  codec.pixelFormatFor('h265-10', 'hevc_nvenc') === 'p010le', codec.pixelFormatFor('h265-10', 'hevc_nvenc'))
check('h265-10 + hevc_qsv → p010le',
  codec.pixelFormatFor('h265-10', 'hevc_qsv') === 'p010le', codec.pixelFormatFor('h265-10', 'hevc_qsv'))
check('h265-10 + hevc_amf → p010le',
  codec.pixelFormatFor('h265-10', 'hevc_amf') === 'p010le', codec.pixelFormatFor('h265-10', 'hevc_amf'))
check('h265（8bit）+ hevc_nvenc → yuv420p（不能因为硬件编码就变 p010le）',
  codec.pixelFormatFor('h265', 'hevc_nvenc') === 'yuv420p', codec.pixelFormatFor('h265', 'hevc_nvenc'))
check('h264 + libx264 → yuv420p', codec.pixelFormatFor('h264', 'libx264') === 'yuv420p')
check('prores-4444 → yuva444p12le（与编码器无关；4444 一律 12 位）',
  codec.pixelFormatFor('prores-4444', 'prores_ks') === 'yuva444p12le',
  codec.pixelFormatFor('prores-4444', 'prores_ks'))

console.log('\n-- 五、编码器只在族内挑（跨族回落 = 面板骗人） --\n')

check('h264 选 h264_nvenc → 放行', codec.pickEncoder('h264', 'h264_nvenc') === 'h264_nvenc')
check('h265 选 hevc_qsv → 放行', codec.pickEncoder('h265', 'hevc_qsv') === 'hevc_qsv')
check(
  'h265 选 h264_nvenc（跨族错配）→ 回落 libx265，而不是硬用 h264_nvenc',
  codec.pickEncoder('h265', 'h264_nvenc') === 'libx265',
  codec.pickEncoder('h265', 'h264_nvenc')
)
check(
  'prores-4444 选 libx264（跨族错配）→ 回落 prores_ks',
  codec.pickEncoder('prores-4444', 'libx264') === 'prores_ks',
  codec.pickEncoder('prores-4444', 'libx264')
)
check('未知编码器名 → 该族软件编码', codec.pickEncoder('h264', 'whatever') === 'libx264')

console.log('\n-- 六、面板下拉的候选 --\n')

const e1 = codec.encodersFor('h264', ['libx264', 'h264_nvenc', 'hevc_nvenc'])
check('h264 只列 h264 族（hevc_nvenc 不能混进来）',
  e1.join(',') === 'libx264,h264_nvenc', e1.join(','))
const e2 = codec.encodersFor('h265', ['libx264'])
check('探测还没回来（只有 libx264）时，h265 仍给出软件编码而不是空下拉',
  e2.length === 1 && e2[0] === 'libx265', e2.join(','))
const e3 = codec.encodersFor('prores-422', [])
check('prores 的候选恒非空（空下拉 = 选了就废）', e3.length === 1 && e3[0] === 'prores_ks', e3.join(','))
check('supported(h265, 只有 libx264) → false（本机编不了要标出来）',
  codec.supported('h265', ['libx264']) === false)
check('supported(h265, 含 libx265) → true', codec.supported('h265', ['libx264', 'libx265']) === true)
check('supported(prores-4444, 含 prores_ks) → true',
  codec.supported('prores-4444', ['prores_ks']) === true)

console.log('\n-- 七、扩展名跟着格式走 --\n')

check('mp4 路径 + ProRes 4444 → .mov',
  codec.matchExtension('/tmp/成片.mp4', 'prores-4444') === '/tmp/成片.mov',
  codec.matchExtension('/tmp/成片.mp4', 'prores-4444'))
check('大写扩展名也会被规范成小写',
  codec.matchExtension('C:\\片\\成片.MP4', 'h265') === 'C:\\片\\成片.mp4',
  codec.matchExtension('C:\\片\\成片.MP4', 'h265'))
check('.mov 路径 + h264 → .mp4',
  codec.matchExtension('/tmp/a.mov', 'h264') === '/tmp/a.mp4',
  codec.matchExtension('/tmp/a.mov', 'h264'))
check('没有扩展名时补一个',
  codec.matchExtension('/tmp/无后缀', 'prores-422') === '/tmp/无后缀.mov',
  codec.matchExtension('/tmp/无后缀', 'prores-422'))
check(
  '目录名里带点不会被当成扩展名（a.b/c → a.b/c.mp4）',
  codec.matchExtension('/tmp/a.b/c', 'h264') === '/tmp/a.b/c.mp4',
  codec.matchExtension('/tmp/a.b/c', 'h264')
)
check('空路径原样返回（不造出一个 ".mp4" 来）', codec.matchExtension('', 'h264') === '')

console.log('\n-- 八、音频与对话框 --\n')

check('MOV（ProRes）音频走 PCM', codec.audioArgs('prores-4444').join(' ').includes('pcm_s16le'),
  codec.audioArgs('prores-4444').join(' '))
check('MP4 音频走 AAC 192k', codec.audioArgs('h264').join(' ').includes('aac'),
  codec.audioArgs('h264').join(' '))
check(
  '保存对话框的扩展名与该格式一致',
  C.every((item) => codec.dialogFilters(item.key)[0].extensions.join() === item.ext),
  C.map((item) => `${item.key}:${codec.dialogFilters(item.key)[0].extensions.join()}`).join(' ')
)

console.log('')
if (failures.length) {
  console.log('失败项：')
  for (const item of failures) console.log('  · ' + item)
}
const total = pass + fail + skip
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
console.log(`EXPORT_CODEC_SELFTEST_STATS total=${total} pass=${pass} fail=${fail} skip=${skip}`)
if (!fail) console.log('EXPORT_CODEC_SELFTEST_OK')
process.exit(fail ? 1 : 0)
