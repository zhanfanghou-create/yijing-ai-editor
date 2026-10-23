#!/usr/bin/env node
/**
 * 多机位（多角度同步 + 切换）闸门。
 *
 * 这一族的错法**全都不报错**，只能拿数字和像素测：
 *   · 同步 offset 算错 ⇒ 切过去的瞬间画面里的人"跳"了半秒，但照样在播；
 *   · 切换点用时间线秒而不是节目秒存 ⇒ 2 倍速下每个切换点都偏一半；
 *   · 展开时忘了给音轨 / 忘了把画面层静音 ⇒ 成片里两路声音叠在一起（听着"更响"）；
 *   · 末段没延伸到节目末尾 ⇒ 最后一个切换点之后整段黑掉；
 *   · 导出侧没展开 ⇒ 成片里多机位那段是黑的（它没有 url），而时间线上好好摆着。
 *
 * 所以判据全部取**消费端**：展开后的片段表（起点/时长/源入点/音量）+ 成片的
 * 时长、音轨与**中心像素颜色**。测"函数返回值"只能证明实现自己同意自己。
 *
 * 用法：node tools/check-multicam.mjs
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
const mc = require(path.join(SHARED, 'multicam.js'))
const compound = require(path.join(SHARED, 'compound.js'))
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    problems.push(label)
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const near = (a, b, tol = 0.002) => Math.abs(Number(a) - Number(b)) <= tol

/* ------------------------------ 夹具 ------------------------------ */

const mk = (id, start, duration, extra = {}) => ({
  id,
  track: 'video',
  kind: 'video',
  path: `${id}.mp4`,
  url: `yjai-media://local/${id}`,
  assetId: `as_${id}`,
  start,
  duration,
  offset: 0,
  sourceDuration: 10,
  name: id,
  ...extra
})

console.log('\n=== ① 新建：按时间线位置对齐，节目总长取各机位可用长度的最小值 ===')

/* 机位 A 从 5 秒开始、机位 B 从 6 秒开始（两路在 6–11 秒这段重叠） */
const A = mk('camA', 5, 6)
const B = mk('camB', 6, 6)
const list0 = [A, B, mk('keep', 20, 1)]
const built = mc.makeMulticam(list0, ['camA', 'camB'], { id: 'M1' })
check('两段画面合成一个多机位片段', Boolean(built && built.clip))
check(
  '多机位落在**最晚**的那一路起点（6）—— 早开的那一路在此之前没人跟它对齐',
  near(built.clip.start, 6),
  String(built.clip.start)
)
check('kind 标成 multicam（渲染侧与检查器都认它）', built.clip.kind === 'multicam' && mc.isMulticam(built.clip))
check('机位表按起点排序，共 2 路', mc.anglesOf(built.clip).length === 2)
check(
  '先开的机位在节目第 0 秒已经走过 1 秒 ⇒ 源入点 1（这一条就是"同步"，算错就切角跳画面）',
  near(mc.anglesOf(built.clip)[0].offset, 1),
  String(mc.anglesOf(built.clip)[0].offset)
)
check('后开的机位源入点是 0', near(mc.anglesOf(built.clip)[1].offset, 0), String(mc.anglesOf(built.clip)[1].offset))
check(
  '节目总长 = 公共重叠的那一段（11 - 6 = 5）',
  near(built.clip.duration, 5) && near(built.clip.sourceDuration, 5),
  String(built.clip.duration)
)
check('时间线上不再有被收进去的那两段', built.rest.length === 1 && built.rest[0].id === 'keep')
check('默认切换点只有一个（0 秒处，第 1 路）', mc.cutsOf(built.clip).length === 1 && mc.cutsOf(built.clip)[0].at === 0)
check('默认取声 = 第 1 路', mc.audioOf(built.clip).mode === 'angle' && mc.audioOf(built.clip).angle === 0)
check('只选一段建不出多机位（返回 null，不偷偷合成）', mc.makeMulticam(list0, ['camA'], { id: 'M0' }) === null)
check(
  '没有画面源的片段不能当机位（复合 / 字幕）',
  mc.makeMulticam([mk('x', 0, 2, { path: '', url: '' }), mk('y', 0, 2)], ['x', 'y'], { id: 'MX' }) === null
)
check(
  '两段完全错开（无重叠）⇒ 返回 null（宁可少一段，也不给一个"切过去就黑"的机位）',
  mc.makeMulticam([mk('p', 0, 2), mk('q', 5, 2)], ['p', 'q'], { id: 'MY' }) === null
)

console.log('\n=== ② 切换点：落在节目时间上，首尾相接 ===')

const M1 = built.clip
const cut1 = { ...M1, ...mc.setCut(M1, 2, 1) }
check('切到第 2 路后有两个切换点', mc.cutsOf(cut1).length === 2, JSON.stringify(mc.cutsOf(cut1)))
const segs1 = mc.segmentsOf(cut1)
check('展开成两个区间', segs1.length === 2, JSON.stringify(segs1))
check('第一段 [0,2) 用第 1 路', near(segs1[0].start, 0) && near(segs1[0].end, 2) && segs1[0].angle === 0)
check(
  '第二段一直延伸到节目末尾（5）—— 这一条能抓住"结尾黑掉"',
  near(segs1[1].start, 2) && near(segs1[1].end, 5) && segs1[1].angle === 1,
  JSON.stringify(segs1[1])
)
const cut2 = { ...cut1, ...mc.setCut(cut1, 2, 0) }
check('同一时刻再点一次 ⇒ 覆盖而不是插一个重复点', mc.cutsOf(cut2).length === 2 && mc.angleIndexAt(cut2, 2) === 0)
check('1 秒处仍生效第 1 路', mc.angleIndexAt(cut2, 1) === 0)
const cut3 = { ...cut1, ...mc.setCut(cut1, 4.5, 0) }
check('乱序插入（4.5 秒）后仍按时间升序', JSON.stringify(mc.cutsOf(cut3).map((c) => c.at)) === '[0,2,4.5]', JSON.stringify(mc.cutsOf(cut3)))
const overrun = { ...M1, ...mc.setCut(M1, 999, 1) }
check('切换点超过节目末尾 ⇒ 夹到末尾（不产生负长度区间）', near(mc.cutsOf(overrun).slice(-1)[0].at, 5))
check('负时间 ⇒ 夹到 0', near(mc.setCut(M1, -5, 1).multicam.cuts[0].at, 0))
check(
  '机位序号越界 ⇒ 夹到最后一路上（不指向不存在的机位）',
  mc.setCut(M1, 3, 99).multicam.cuts.slice(-1)[0].angle === 1
)
check('1 秒钟处（还没切）取第 1 路', mc.angleIndexAt(cut1, 1) === 0)
check('3 秒钟处（已切）取第 2 路', mc.angleIndexAt(cut1, 3) === 1)

console.log('\n=== ③ 展开：每个区间一段画面 + 一条取声，几何与源入点逐项对 ===')

const flat = mc.expandMulticams([cut1])
const videos = flat.filter((item) => item.track === 'video')
const audios = flat.filter((item) => item.track === 'audio')
check('展开后没有多机位片段', flat.every((item) => item.kind !== 'multicam'))
check('两段画面 + 一条音轨（默认取第 1 路的声音）', videos.length === 2 && audios.length === 1, `${videos.length}/${audios.length}`)
check('第一段画面从 6 秒开始，长 2 秒', near(videos[0].start, 6) && near(videos[0].duration, 2), JSON.stringify([videos[0].start, videos[0].duration]))
check('第二段画面从 8 秒开始，长 3 秒', near(videos[1].start, 8) && near(videos[1].duration, 3), JSON.stringify([videos[1].start, videos[1].duration]))
check(
  '第二段的源入点 = 机位源入点(0) + 区间起点(2) —— 少加这一项就是"切角后画面从头播"',
  near(videos[1].offset, 2),
  String(videos[1].offset)
)
check(
  '第一段的源入点 = 该机位在节目第 0 秒的位置（1）',
  near(videos[0].offset, 1),
  String(videos[0].offset)
)
check('画面层一律不带原声（声音由音轨提供，否则两路叠在一起）', videos.every((item) => item.gain === 0))
check(
  '音轨从 6 秒开始、长 5 秒、源入点 1（与画面第一段同一个源位置）',
  near(audios[0].start, 6) && near(audios[0].duration, 5) && near(audios[0].offset, 1),
  JSON.stringify([audios[0].start, audios[0].duration, audios[0].offset])
)
check('音轨用第 1 路的素材（默认主麦）', audios[0].path === 'camA.mp4')
check('展开层 id 确定且带归属（预览点选要落回外层）', videos[0].ownerId === 'M1' && videos[0].id.startsWith('M1~'))
check(
  '同一份输入展开两次得到同一批 id',
  JSON.stringify(mc.expandMulticams([cut1]).map((i) => i.id)) === JSON.stringify(flat.map((i) => i.id))
)
check(
  '展开出的片段覆盖整个节目长度、中间无缝（末段起点 + 时长 = 节目末尾）',
  near(videos[1].start + videos[1].duration, 6 + 5),
  String(videos.reduce((max, item) => Math.max(max, item.start + item.duration), 0))
)

const follow = { ...cut1, ...mc.setAudio(cut1, 'follow', 0) }
const followFlat = mc.expandMulticams([follow])
check('「跟随画面」模式不再单独出音轨', followFlat.filter((item) => item.track === 'audio').length === 0)
check(
  '「跟随画面」模式下画面层保留原声（gain 不写 = 100）',
  followFlat.filter((item) => item.track === 'video').every((item) => item.gain === undefined)
)
const none = { ...cut1, ...mc.setAudio(cut1, 'none', 0) }
const noneFlat = mc.expandMulticams([none])
check('「静音」模式没有音轨，画面层也全静音', noneFlat.every((item) => item.gain === 0) && noneFlat.every((item) => item.track === 'video'))
const sound2 = { ...cut1, ...mc.setAudio(cut1, 'angle', 1) }
const sound2Flat = mc.expandMulticams([sound2]).filter((item) => item.track === 'audio')
check('取第 2 路的声音 ⇒ 音轨换成 camB，源入点按它自己的同步位置（0）', sound2Flat[0].path === 'camB.mp4' && near(sound2Flat[0].offset, 0), JSON.stringify(sound2Flat[0]))
const loud = { ...cut1, gain: 50 }
const loudFlat = mc.expandMulticams([loud])
check(
  '外层音量 50% ⇒ 音轨 gain 50（画面层仍为 0）',
  loudFlat.filter((item) => item.track === 'audio')[0].gain === 50 &&
    loudFlat.filter((item) => item.track === 'video').every((item) => item.gain === 0)
)

console.log('\n=== ④ 外层裁剪 / 倍速 / 倒放 ===')

const trimmed = { ...cut1, start: 10, offset: 0.5, duration: 1 }
const trimFlat = mc.expandMulticams([trimmed]).filter((item) => item.track === 'video')
check('窗口 [0.5,1.5) 落在同一个切换区间里 ⇒ 只剩一段画面', trimFlat.length === 1, String(trimFlat.length))
check('它从 10 秒开始、长 1 秒', near(trimFlat[0].start, 10) && near(trimFlat[0].duration, 1))
check('源入点 = 机位源入点(1) + 窗口起点(0.5) = 1.5', near(trimFlat[0].offset, 1.5), String(trimFlat[0].offset))

const fast = { ...cut1, speed: 2, duration: 2.5 }
const fastFlat = mc.expandMulticams([fast]).filter((item) => item.track === 'video')
check('2 倍速：两段画面的时间线占位各减半（1 + 1.5）', near(fastFlat[0].duration, 1) && near(fastFlat[1].duration, 1.5), JSON.stringify(fastFlat.map((i) => i.duration)))
check('2 倍速：片段自身 speed 也写 2（源消耗 = 区间长度，不变式 ②）', fastFlat.every((item) => near(item.speed, 2)))
check('2 倍速：两段首尾仍然相接（7 秒处接缝）', near(fastFlat[1].start, 7), String(fastFlat[1].start))

const back = { ...cut1, reverse: true }
const backFlat = mc.expandMulticams([back])
check('倒放：画面段都带 reverse 标记', backFlat.filter((i) => i.track === 'video').every((i) => i.reverse === true))
check('倒放：音轨也倒放（否则声音与画面对不上）', backFlat.filter((i) => i.track === 'audio')[0].reverse === true)

console.log('\n=== ⑤ 轨道开关要"穿透"多机位 ===')

const hidden = mc.expandMulticams([cut1], { trackState: { hidden: ['video'] } })
check('视频轨隐藏 ⇒ 整块（含取声音轨）都不进合成', hidden.length === 0, String(hidden.length))
const mutedState = mc.expandMulticams([cut1], { trackState: { muted: ['video'] } })
check(
  '视频轨静音 ⇒ 画面还在，但音轨 gain = 0（不能只静画面层）',
  mutedState.filter((i) => i.track === 'video').length === 2 &&
    mutedState.filter((i) => i.track === 'audio')[0].gain === 0
)
const otherSolo = mc.expandMulticams([cut1], { trackState: { solo: ['overlay'] } })
check('别的轨独奏 ⇒ 多机位的取声音轨跟着静音', otherSolo.filter((i) => i.track === 'audio')[0].gain === 0)
check('停用的多机位片段完全不进合成', mc.expandMulticams([{ ...cut1, enabled: false }]).length === 0)

console.log('\n=== ⑥ 解除：按当前切换结果摊回时间线 ===')

let seq = 0
const kids = mc.ungroupMulticam(cut1, () => `new${(seq += 1)}`)
check('解除出 3 段（2 段画面 + 1 条取声）', kids.length === 3, String(kids.length))
check('id 全部重发（复制过多份也不会撞）', kids.every((item) => /^new\d+$/.test(item.id)), kids.map((i) => i.id).join(','))
check('解除后没有 ownerId 残留（它们已经是普通片段）', kids.every((item) => item.ownerId === undefined))
check('解除后的第二段仍在 8 秒处', near(kids[1].start, 8) && kids[1].track === 'video', JSON.stringify(kids[1].start))

console.log('\n=== ⑦ 与复合片段的互操作 ===')
/* 复合片段会被多机位展开出的片段包进去（先多机位后复合的顺序就是为这个） */
const comp = compound.makeCompound(kids.filter((i) => i.track === 'video'), kids.filter((i) => i.track === 'video').map((i) => i.id), { id: 'C9' })
check('多机位解除出的片段可以再合成复合片段', Boolean(comp && comp.clip))
const nested = compound.expandCompounds(mc.expandMulticams([comp.clip]))
check('先多机位后复合展开，结果是普通片段且没有黑段', nested.length === 2 && nested.every((i) => i.kind === 'video'), JSON.stringify(nested.map((i) => [i.id, i.start, i.duration])))

/* ------------------------- ⑧ 真导出 ------------------------- */

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('\nMULTICAM_EXPORT_SKIPPED 本机没有 ffmpeg（成片侧无法验证）')
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  process.exit(fail ? 1 : 2)
}
const ffmpeg = found.ffmpeg
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-multicam-'))
const red = path.join(work, 'red.mp4')
const blue = path.join(work, 'blue.mp4')

for (const [file, color, freq] of [['red', 'red', 440], ['blue', 'blue', 880]]) {
  spawnCapture(
    ffmpeg,
    [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=25`,
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000`,
      '-t', '4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      path.join(work, `${file}.mp4`)
    ],
    { tag: `mk-${file}` }
  )
}
check('两段夹具生成完毕（红 440Hz / 蓝 880Hz，各 4 秒）', fs.existsSync(red) && fs.existsSync(blue))

const camRed = { id: 'cr', track: 'video', kind: 'video', path: red, url: '', assetId: 'as_r', start: 0, duration: 4, offset: 0, sourceDuration: 4, name: 'A' }
const camBlue = { id: 'cb', track: 'video', kind: 'video', path: blue, url: '', assetId: 'as_b', start: 0, duration: 4, offset: 0, sourceDuration: 4, name: 'B' }
const live = mc.makeMulticam([camRed, camBlue], ['cr', 'cb'], { id: 'MCM' }).clip
const switched = { ...live, ...mc.setCut(live, 2, 1) }

function centerPixel(file, at) {
  const probe = path.join(work, `px-${at}.rgb`)
  spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', probe],
    { tag: `px-${at}` }
  )
  if (!fs.existsSync(probe)) return null
  const buf = fs.readFileSync(probe)
  const i = (4 * 8 + 4) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}

function probeOut(file) {
  const out = spawnCapture(ffmpeg, ['-hide_banner', '-i', file], { tag: 'probe' })
  const text = String(out.stderr || '') + String(out.stdout || '')
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(text)
  return {
    seconds: match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN,
    audio: /Stream #\d+:\d+.*: Audio:/.test(text)
  }
}

const outPath = path.join(work, 'out.mp4')
const result = await render.render({
  clips: [switched],
  outPath,
  options: { width: 320, height: 240, fps: 25 }
})
check('多机位片段导出成功', result.ok === true, String(result.error || '').slice(0, 300))
check('成片时长 = 节目总长（4 秒）', near(result.duration, 4, 0.02), String(result.duration))
const info = fs.existsSync(outPath) ? probeOut(outPath) : { seconds: NaN, audio: false }
check('成片文件时长 ≈ 4 秒', Math.abs(info.seconds - 4) < 0.15, String(info.seconds))
check('成片有音轨（取声机位的声音没被丢）', info.audio === true)

const px1 = centerPixel(outPath, 0.8)
const px2 = centerPixel(outPath, 3.0)
check(
  '0.8 秒处是**第 1 路**（红）',
  Boolean(px1) && px1[0] > 140 && px1[2] < 110,
  JSON.stringify(px1)
)
check(
  '3.0 秒处是**第 2 路**（蓝）—— 这一条能抓住"导出侧没展开 / 没用上切换点"',
  Boolean(px2) && px2[2] > 140 && px2[0] < 110,
  JSON.stringify(px2)
)

/* 反向对照：把切换点改成 3 秒，0.8 与 3.2 的颜色必须各自跟着变 ——
   证明像素颜色是**由切换点决定**的，不是"碰巧素材本身就是那样" */
const switched2 = { ...live, ...mc.setCut(live, 3, 1) }
const out2 = path.join(work, 'out2.mp4')
const result2 = await render.render({ clips: [switched2], outPath: out2, options: { width: 320, height: 240, fps: 25 } })
check('换个切换点后再导出成功', result2.ok === true, String(result2.error || '').slice(0, 200))
const px3 = centerPixel(out2, 2.0)
check(
  '切换点改到 3 秒 ⇒ 2.0 秒处仍是第 1 路（红）',
  Boolean(px3) && px3[0] > 140 && px3[2] < 110,
  JSON.stringify(px3)
)

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('MULTICAM_FAILED')
  for (const item of problems) console.log(`  - ${item}`)
  console.log(`夹具目录（保留证据）：${work}`)
  process.exit(1)
}
console.log('MULTICAM_OK')
process.exit(0)
