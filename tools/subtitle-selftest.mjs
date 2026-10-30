/**
 * 字幕文件读写 + 语音分句的自证（纯逻辑，不启 Electron）。
 *
 * 为什么必须有这一道：字幕这一族的失效**全是错位、不是报错** ——
 * 毫秒位按 3 位硬切、ASS 字段顺序写死、LRC 最后一行没有结束时间，
 * 三种情况都会"导入成功、字幕轨上多了一堆条目"，只是位置全差一点。
 * 只有在夹具里把毫秒级的时间戳逐条对出来，才知道对不对。
 *
 * 数字统计：SUBTTITLE_SELFTEST_STATS（由 verify.mjs 的 expected 核对）
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SUB = require('../packages/desktop/src/shared/subtitle.js')

let pass = 0
const failures = []
function ok(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol

/* ------------------------------------------------------------------ *
 * A. 时间码
 * ------------------------------------------------------------------ */

console.log('\nA. 时间码（这一族的错法全是"差一点点"）===\n')

ok('HH:MM:SS,mmm 解析', near(SUB.parseTime('00:00:01,500'), 1.5), String(SUB.parseTime('00:00:01,500')))
ok('点号分隔也认', near(SUB.parseTime('00:00:01.500'), 1.5))
/* 2 位小数是真实存在的脏数据（别的工具导出）。按 3 位硬切会读成 0.05 秒。 */
ok('2 位小数按百分秒算（,50 = 0.5 秒，不是 0.05）', near(SUB.parseTime('00:00:01,50'), 1.5), String(SUB.parseTime('00:00:01,50')))
ok('1 位小数按十分秒算（,5 = 0.5 秒）', near(SUB.parseTime('00:00:01,5'), 1.5))
ok('省略小时（VTT 口径 01:30.000）', near(SUB.parseTime('01:30.000'), 90), String(SUB.parseTime('01:30.000')))
ok('ASS 厘秒（0:00:01.50 = 1.5 秒）', near(SUB.parseTime('0:00:01.50'), 1.5))
ok('超过一小时', near(SUB.parseTime('01:02:03,004'), 3723.004))
ok('空串 → NaN', Number.isNaN(SUB.parseTime('')))
ok('乱写 → NaN', Number.isNaN(SUB.parseTime('abc')))
ok('只有数字没有冒号 → NaN', Number.isNaN(SUB.parseTime('1234')))

ok('srtTime(1.5) = 00:00:01,500', SUB.srtTime(1.5) === '00:00:01,500', SUB.srtTime(1.5))
/* 进位：1.9996 秒必须变成 00:00:02,000，不能是 00:00:01,1000 */
ok('毫秒进位（1.9996 → 00:00:02,000）', SUB.srtTime(1.9996) === '00:00:02,000', SUB.srtTime(1.9996))
ok('负秒钳到 0', SUB.srtTime(-3) === '00:00:00,000')
ok('vttTime 用点号', SUB.vttTime(1.5) === '00:00:01.500', SUB.vttTime(1.5))
ok(
  '解析 → 格式化 → 解析 往返不变（毫秒级）',
  [0, 0.5, 1.234, 59.999, 3600.001].every((value) => near(SUB.parseTime(SUB.srtTime(value)), value, 0.001))
)

/* ------------------------------------------------------------------ *
 * B. SRT
 * ------------------------------------------------------------------ */

console.log('\nB. SRT（含脏变体）===\n')

const SRT_BASIC = `1
00:00:01,000 --> 00:00:03,500
第一句

2
00:00:04,000 --> 00:00:06,000
第二句
换行也保留
`
const b1 = SUB.readSubtitles(SRT_BASIC, 'a.srt')
ok('基础 SRT 解析成功', b1.ok && b1.cues.length === 2, `${b1.cues.length} 条`)
ok('第一条起止正确', near(b1.cues[0].start, 1) && near(b1.cues[0].end, 3.5))
ok('多行正文保留换行', b1.cues[1].text === '第二句\n换行也保留', JSON.stringify(b1.cues[1].text))
ok('格式识别为 srt', b1.format === 'srt')

const srtCrlf = SRT_BASIC.replace(/\n/g, '\r\n')
ok('CRLF 与 LF 得到同一结果', SUB.toSrt(SUB.readSubtitles(srtCrlf, 'a.srt').cues) === SUB.toSrt(b1.cues))
ok('BOM 开头不影响（首条正文不带 \\uFEFF）', SUB.readSubtitles(`\uFEFF${SRT_BASIC}`, 'a.srt').cues[0].text === '第一句')

/* 没有序号、块之间没有空行的写法很常见（手写 / 拼接字幕） */
const srtNoIndex = `00:00:01,000 --> 00:00:02,000
甲
00:00:03,000 --> 00:00:04,000
乙`
/* ⚠️ 这条一开始写成"读成 1 块" —— 那是把**缺陷**当规范写进断言的典型。
   实现当时只按空行分块，于是第二块的时间行被吃进第一块的正文，
   界面上表现为"正文里带着一段时间码"。修的是实现：遇到第二个时间行就断块。 */
ok('没有序号、块之间无空行也能分开（2 块，正文里不许带时间码）', (() => {
  const got = SUB.readSubtitles(srtNoIndex, 'a.srt')
  return got.ok && got.cues.length === 2 && !got.cues.some((cue) => cue.text.includes('-->'))
})(), `${SUB.readSubtitles(srtNoIndex, 'a.srt').cues.length} 条`)
ok(
  '时间行前多一个序号行也不影响（序号被当作块首、不是正文）',
  SUB.readSubtitles(`7\n00:00:01,000 --> 00:00:02,000\n正文`, 'a.srt').cues[0].text === '正文'
)

/* 结束早于开始：不丢弃正文，拉成 0.8 秒 */
const srtBad = `1
00:00:05,000 --> 00:00:04,000
倒着的
2
00:00:06,000 --> 00:00:07,000
正常`
const badCues = SUB.readSubtitles(srtBad, 'a.srt').cues
ok('结束早于开始 ⇒ 拉成 0.8 秒而不是丢弃', badCues.length === 2 && near(badCues[0].end - badCues[0].start, 0.8), JSON.stringify(badCues[0]))
ok('乱序文件按开始时间排序', badCues.every((cue, index) => index === 0 || cue.start >= badCues[index - 1].start))
ok('正文为空 / 只有空白的条目被丢弃', SUB.readSubtitles(`1\n00:00:01,000 --> 00:00:02,000\n   \n`, 'a.srt').ok === false)

/* ------------------------------------------------------------------ *
 * C. VTT
 * ------------------------------------------------------------------ */

console.log('\nC. VTT ===\n')

const VTT = `WEBVTT

NOTE 这是一段注释
不该成为字幕

STYLE
::cue { color: red }

1
00:01.000 --> 00:03.500 align:start position:10%
第一条

00:00:04.000 --> 00:00:06.000
第二条`
const v = SUB.readSubtitles(VTT, 'a.vtt')
ok('VTT 解析出 2 条（NOTE / STYLE 块不算）', v.ok && v.cues.length === 2, `${v.cues.length} 条`)
ok('省略小时的时间码正确（00:01.000 = 1 秒）', near(v.cues[0].start, 1), String(v.cues[0]?.start))
ok('cue settings（align:start）被切掉，不影响结束时间', near(v.cues[0].end, 3.5), String(v.cues[0]?.end))
ok('没有扩展名时按 WEBVTT 头嗅探出 vtt', SUB.detectFormat('', VTT) === 'vtt')

/* ------------------------------------------------------------------ *
 * D. LRC
 * ------------------------------------------------------------------ */

console.log('\nD. LRC ===\n')

const LRC = `[ar:某歌手]
[ti:某首歌]
[offset:+200]
[00:01.00]第一句
[00:03.50][00:10.00]副歌（两处）
[00:06.00]第三句`
const l = SUB.readSubtitles(LRC, 'a.lrc')
ok('LRC 解析出 4 条（一行双时间标签拆成两条）', l.ok && l.cues.length === 4, `${l.cues.length} 条`)
ok('元信息 [ar] [ti] 被跳过', l.cues.every((cue) => !/某歌手|某首歌/.test(cue.text)))
ok('offset +200ms 生效（1.00 → 1.2 秒）', near(l.cues[0].start, 1.2), String(l.cues[0]?.start))
ok('结束时间取下一行开始', near(l.cues[0].end, 3.7), String(l.cues[0]?.end))
ok('最后一行给 +4 秒', near(l.cues[l.cues.length - 1].end - l.cues[l.cues.length - 1].start, 4), String(l.cues[l.cues.length - 1]))
ok('负 offset 造出的负时间被钳到 0', SUB.readSubtitles('[offset:-5000]\n[00:01.00]早\n[00:09.00]晚', 'a.lrc').cues[0].start === 0)

/* ------------------------------------------------------------------ *
 * E. ASS / SSA（字段顺序由 Format 行声明 —— 最容易被写死的地方）
 * ------------------------------------------------------------------ */

console.log('\nE. ASS / SSA ===\n')

const ASS_STD = `[Script Info]
Title: 测试

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,第一句
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,你好，世界（正文里有逗号）
Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\pos(10,20)}带标签\\N第二行`
const a = SUB.readSubtitles(ASS_STD, 'a.ass')
ok('标准 ASS 解析出 3 条', a.ok && a.cues.length === 3, `${a.cues.length} 条`)
ok('正文里的逗号不把字段切碎', a.cues[1]?.text === '你好，世界（正文里有逗号）', JSON.stringify(a.cues[1]?.text))
ok('覆盖标签 {\\pos} 被剥掉', a.cues[2]?.text === '带标签\n第二行', JSON.stringify(a.cues[2]?.text))
ok('ASS 时间（厘秒）正确', near(a.cues[0].end, 3.5), String(a.cues[0]?.end))

/* ⚠️ 这条是本轮最关键的一条：Format 顺序被打乱。
   把下标写死（第 1 个=开始、第 2 个=结束）的实现在这里会**整份读空**，
   而报错信息只会是"导入 0 条"。 */
const ASS_REORDER = `[Events]
Format: Start, End, Marked, Style, Text
Dialogue: 0:00:02.00,0:00:04.00,0,Default,打乱顺序的
Dialogue: 0:00:05.00,0:00:06.00,0,Default,第二条`
const ar = SUB.readSubtitles(ASS_REORDER, 'a.ass')
ok('Format 顺序被打乱也能正确读（不许把下标写死）', ar.ok && ar.cues.length === 2, `${ar.cues.length} 条`)
ok('打乱顺序后时间仍然对', near(ar.cues[0]?.start, 2) && near(ar.cues[0]?.end, 4), `${ar.cues[0]?.start}→${ar.cues[0]?.end}`)
ok('打乱顺序后正文仍然对', ar.cues[0]?.text === '打乱顺序的', JSON.stringify(ar.cues[0]?.text))

/* ------------------------------------------------------------------ *
 * F. 格式嗅探与失败要说清原因
 * ------------------------------------------------------------------ */

console.log('\nF. 格式识别与失败原因 ===\n')

ok('扩展名 srt / vtt / lrc / ass / ssa 都认', ['srt', 'vtt', 'lrc', 'ass', 'ssa'].every((ext) => SUB.detectFormat(`x.${ext}`, '') === (ext === 'ssa' ? 'ass' : ext)))
ok('无扩展名时按 --> 嗅探出 srt', SUB.detectFormat('', '1\n00:00:01,000 --> 00:00:02,000\n甲') === 'srt')
ok('无扩展名时按 [Events] 嗅探出 ass', SUB.detectFormat('', '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00') === 'ass')
ok('认不出的内容 → 明确说"认不出"（不是静默 0 条）', (() => {
  const bad = SUB.readSubtitles('随便一段话，没有任何时间码', 'a.txt')
  return !bad.ok && /认不出/.test(bad.error)
})(), SUB.readSubtitles('随便一段话', 'a.txt').error)
ok('空文件 → 明确说"文件是空的"', (() => {
  const empty = SUB.readSubtitles('   \n\n', 'a.srt')
  return !empty.ok && /空/.test(empty.error)
})())
ok('格式对但 0 条 → 说清是哪种格式里没有条目', (() => {
  const none = SUB.readSubtitles('WEBVTT\n\nNOTE 只有注释\n', 'a.vtt')
  return !none.ok && /WebVTT/.test(none.error)
})(), SUB.readSubtitles('WEBVTT\n\nNOTE 只有注释\n', 'a.vtt').error)

/* ------------------------------------------------------------------ *
 * G. 导出
 * ------------------------------------------------------------------ */

console.log('\nG. 导出 ===\n')

ok('toSrt 序号从 1 连续', SUB.toSrt([{ start: 0, end: 1, text: '甲' }, { start: 2, end: 3, text: '乙' }]).startsWith('1\r\n'))
ok('toSrt 用 CRLF（Windows 播放器兼容）', SUB.toSrt([{ start: 0, end: 1, text: '甲' }]).includes('\r\n'))
ok('toSrt 空列表 → 空串', SUB.toSrt([]) === '')
ok('toVtt 带 WEBVTT 头', SUB.toVtt([{ start: 0, end: 1, text: '甲' }]).startsWith('WEBVTT'))
ok('toVtt 时间码用点号', /00:00:00\.000 --> 00:00:01\.000/.test(SUB.toVtt([{ start: 0, end: 1, text: '甲' }])))
ok(
  '导出再导入，条数与时间都不变（真往返）',
  (() => {
    const src = [{ start: 1.25, end: 2.5, text: '甲' }, { start: 3, end: 4.75, text: '乙\n换行' }]
    const back = SUB.readSubtitles(SUB.toSrt(src), 'x.srt')
    return back.ok && back.cues.length === 2 && near(back.cues[0].start, 1.25) && back.cues[1].text === '乙\n换行'
  })()
)

/* ------------------------------------------------------------------ *
 * H. 时间线片段 → cue
 * ------------------------------------------------------------------ */

console.log('\nH. 时间线片段 → cue ===\n')

const clips = [
  { id: 'a', track: 'text', start: 2, duration: 1.5, text: '字幕一' },
  { id: 'b', track: 'text', start: 0.5, duration: 2, text: '字幕二' },
  { id: 'c', track: 'video', start: 0, duration: 9, text: '不该进来' },
  { id: 'd', track: 'text', start: 5, duration: 0, text: '零长' },
  { id: 'e', track: 'text', start: 6, duration: 1, text: '   ' }
]
const cueList = SUB.cuesOfClips(clips)
ok('只取 text 轨（视频轨的 text 字段不算字幕）', cueList.length === 2 && !cueList.some((cue) => cue.text === '不该进来'), `${cueList.length} 条`)
ok('零长与空白正文被丢弃', cueList.every((cue) => cue.end > cue.start && cue.text.trim()))
ok('按开始时间排序', near(cueList[0].start, 0.5) && near(cueList[1].start, 2))
ok('end = start + duration', near(cueList[0].end, 2.5))

/* ------------------------------------------------------------------ *
 * H2. 编码嗅探（GBK 字幕文件不是"坏文件"）
 * ------------------------------------------------------------------ */

console.log('\nH2. 编码嗅探 ===\n')

/* 「你好」的 GBK 字节是 C4 E3 BA C3，UTF-8 是 E4 BD A0 E5 A5 BD */
const GBK_BYTES = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])
const UTF8_BYTES = new Uint8Array([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd])
ok('UTF-8 字节按 UTF-8 解（中文正确）', SUB.decodeTextBuffer(UTF8_BYTES) === '你好', SUB.decodeTextBuffer(UTF8_BYTES))
ok(
  'GBK 字节也能解出中文（不是"锟斤拷"，也不是替换符）',
  SUB.decodeTextBuffer(GBK_BYTES) === '你好',
  JSON.stringify(SUB.decodeTextBuffer(GBK_BYTES))
)
ok('纯 ASCII 两种解码一致', SUB.decodeTextBuffer(new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nhi')) .includes('hi'))
ok('空字节 → 空串', SUB.decodeTextBuffer(new Uint8Array([])) === '')

/* ------------------------------------------------------------------ *
 * I. 语音分句（VAD）
 * ------------------------------------------------------------------ */

console.log('\nI. 语音分句（自适应阈值 / 合并 / 丢弃 / 拆分）===\n')

const PER = 0.1
/** 造包络：`spans` 是"有声"的桶区间，其余是底噪 */
function envelope(length, spans, loud = 0.8, quiet = 0.04) {
  const out = new Array(length).fill(quiet)
  for (const [from, to] of spans) {
    for (let i = from; i <= to && i < length; i += 1) out[i] = loud
  }
  return out
}

const one = SUB.vadSegments(envelope(40, [[6, 14]]), { secondsPerBucket: PER })
ok('一段语音 → 一段', one.length === 1, `${one.length} 段`)
ok('起点落在语音开始附近（平滑会外扩半桶）', one[0].start >= 0.4 && one[0].start <= 0.8, String(one[0]?.start))
ok('终点落在语音结束附近', one[0].end >= 1.3 && one[0].end <= 1.7, String(one[0]?.end))

const twoClose = SUB.vadSegments(envelope(60, [[6, 14], [16, 24]]), { secondsPerBucket: PER })
ok('两段之间只隔 0.2 秒 ⇒ 合并成一段（人说话本来就有停顿）', twoClose.length === 1, `${twoClose.length} 段`)

const twoFar = SUB.vadSegments(envelope(80, [[6, 14], [40, 48]]), { secondsPerBucket: PER })
ok('两段之间隔 2.6 秒 ⇒ 分成两段', twoFar.length === 2, `${twoFar.length} 段`)
ok('第二段起点正确', twoFar[1].start >= 3.7 && twoFar[1].start <= 4.2, String(twoFar[1]?.start))

const shortBlip = SUB.vadSegments(envelope(40, [[10, 11]]), { secondsPerBucket: PER })
ok('0.2 秒的"咳一声"被丢弃（< minDur 0.32）', shortBlip.length === 0, `${shortBlip.length} 段`)

const longRun = SUB.vadSegments(envelope(200, [[0, 199]]), { secondsPerBucket: PER, maxDur: 9 })
ok('20 秒连续有声 ⇒ 按 maxDur 拆成多段', longRun.length >= 3, `${longRun.length} 段`)
ok('每段都不超过 maxDur（+1 桶容差）', longRun.every((seg) => seg.end - seg.start <= 9 + PER), JSON.stringify(longRun.map((s) => Number((s.end - s.start).toFixed(2)))))
ok('拆开后首尾相接、不重叠也不丢时间', longRun.every((seg, i) => i === 0 || near(seg.start, longRun[i - 1].end, 0.001)))
ok('总时长守恒（≈ 20 秒）', near(longRun.reduce((sum, seg) => sum + (seg.end - seg.start), 0), 20, 0.2))

ok('全静音（电平恒定几乎为 0）⇒ 0 段，不硬切碎片', SUB.vadSegments(new Array(100).fill(0), { secondsPerBucket: PER }).length === 0)
/* ⚠️ 恒定 0.5 的包络：原先断言"0 段"，那是错的。
   恒定电平只说明没有起伏，不代表没有声音 —— 一段经过压限的人声就是这样。
   现在的口径是"整段持续有声"，按 maxDur 均匀切开；宁可让用户删两段，
   也不要"整段有声音却返回 0 条"（那看起来就是按了没反应）。 */
ok('恒定中等电平（压限后的人声）⇒ 按 maxDur 切开而不是返回 0 条', (() => {
  const flat = SUB.vadSegments(new Array(100).fill(0.5), { secondsPerBucket: PER, maxDur: 9 })
  return flat.length >= 1 && flat.every((seg) => seg.end - seg.start <= 9 + PER)
})(), `${SUB.vadSegments(new Array(100).fill(0.5), { secondsPerBucket: PER, maxDur: 9 }).length} 段`)
ok('空包络 ⇒ 0 段', SUB.vadSegments([], { secondsPerBucket: PER }).length === 0)
ok('secondsPerBucket 缺失 / 为 0 ⇒ 0 段（不是 NaN 时间）', SUB.vadSegments([0.1, 0.9, 0.1], {}).length === 0)

/* 自适应：同一段"相对形状"的包络，整体电平抬高一倍，结论必须一样 */
const lowEnv = envelope(60, [[6, 14], [30, 38]], 0.4, 0.02)
const highEnv = lowEnv.map((value) => Math.min(1, value * 2))
ok(
  '自适应阈值：整体电平抬一倍，分段数不变（写死阈值会在这一条红）',
  SUB.vadSegments(lowEnv, { secondsPerBucket: PER }).length === SUB.vadSegments(highEnv, { secondsPerBucket: PER }).length,
  `${SUB.vadSegments(lowEnv, { secondsPerBucket: PER }).length} vs ${SUB.vadSegments(highEnv, { secondsPerBucket: PER }).length}`
)

const speech = SUB.cuesFromSpeech(one, { pad: 0.06 })
ok('语音段 → 字幕：首尾各留 padding', near(speech[0].start, one[0].start - 0.06, 0.001) && near(speech[0].end, one[0].end + 0.06, 0.001))
ok('语音段 → 字幕：文字留空（待填，不编造内容）', speech[0].text === '')
ok('极短语音段也会被撑到 minDur（否则字幕一闪而过）', (() => {
  const tiny = SUB.cuesFromSpeech([{ start: 1, end: 1.02 }], { minDur: 0.6 })
  return tiny.length === 1 && tiny[0].end - tiny[0].start >= 0.6
})())

const total = pass + failures.length
console.log(`\nSUBTITLE_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
console.log(failures.length ? 'SUBTITLE_SELFTEST_FAILED' : 'SUBTITLE_SELFTEST_PASSED')
process.exitCode = failures.length ? 1 : 0
