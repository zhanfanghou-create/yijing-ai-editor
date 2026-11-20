#!/usr/bin/env node
/**
 * 画中画卡死闸门：钉住「画中画视频流的 PTS 必须平移到显示窗口起点 t0」。
 *
 * ── 本轮修掉的真实缺陷 ─────────────────────────────────────────────
 * 画中画流以前用 `setpts=PTS-STARTPTS` 归零到 0，但 enable 窗口是 [t0,t1]
 * （t0 = clip.start - 转场位移）。t0>0 时画中画流在成片 t=dur 就 EOF，
 * 窗口要到 t1=t0+dur 才结束 ⇒ overlay 的 eof_action=repeat 把最后一帧反复叠加 t0 秒。
 * 画中画默认铺满画布，看起来就是"成片中间整幅画面卡死不动"。
 * 音频画中画一直用 adelay=t0 平移是对的，视频侧漏了这一步。
 * 修法：画中画链在 fps 之后补 `setpts=PTS-STARTPTS+${t0}/TB`，与窗口同起同止。
 *
 * ── 判据分两层 ────────────────────────────────────────────────────
 * ① 静态：buildPlan 生成的画中画链必须带 +t0/TB、且偏移值 == 窗口起点；
 *    音频画中画 adelay 对称性；plACEHOLDER 负对照证明判据可分辨。
 * ② 真机：主链静止 + 画中画运动，导出后在窗口尾部抽两帧比对 ——
 *    修复前画中画已 EOF 定格（两帧相同），修复后画中画仍在播（两帧不同）。
 *    判据读**成片像素**，不是读参数字符串。
 *
 * 用法：node tools/check-pip-freeze.mjs [--selftest]
 *   --selftest 只跑纯逻辑正/负对照，不起 ffmpeg、不导片。
 * 退出码：0 通过；1 有失败；2 本机无 ffmpeg（如实报，不假绿）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))
const aspect = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'aspect.js'))
const SELFTEST = process.argv.includes('--selftest')

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

/* ============ 纯逻辑：从 buildPlan 的 filter_complex 提取画中画信息 ============ */

/** 造一对主链+画中画片段；t0 = pip.start（无转场时 shiftAt=0） */
function makeClips(pipStart = 3, pipDur = 10) {
  return [
    { id: 'main', track: 'video', kind: 'video', path: 'MAIN', start: 0, duration: 16, offset: 0, sourceDuration: 16 },
    { id: 'pip', track: 'overlay', kind: 'video', path: 'PIP', start: pipStart, duration: pipDur, offset: 0, sourceDuration: pipDur }
  ]
}

/** 把 filter_complex 找出来（临时真实文件，绕过 sourceOf 的 existsSync） */
function planOf(clips, dir) {
  const clipsReal = clips.map((c) => ({ ...c, path: path.join(dir, `${c.id}.mp4`) }))
  for (const c of clipsReal) if (!fs.existsSync(c.path)) fs.writeFileSync(c.path, Buffer.from('x'))
  const plan = render.buildPlan({
    clips: clipsReal,
    streamInfo: new Map(),
    outPath: path.join(dir, 'out.mp4'),
    options: { width: 640, height: 360, aspect: '16:9', fps: 30, quality: 80 }
  })
  const i = plan.args.indexOf('-filter_complex')
  return { fc: String(plan.args[i + 1] || ''), plan }
}

/** 从画中画滤镜行提取 setpts 平移值（秒）；没有就返回 null */
function pipShiftSeconds(fc) {
  const line = fc.split(';').find((seg) => /\[pipin\d+\]/.test(seg) && /setpts=PTS-STARTPTS\+/.test(seg))
  if (!line) return null
  const m = /setpts=PTS-STARTPTS\+([\d.]+)\/TB/.exec(line)
  return m ? Number(m[1]) : null
}

/** 从 enable 提取窗口起点（秒） */
function windowStart(fc) {
  const line = fc.split(';').find((seg) => /\[pipin\d+\]/.test(seg) && /enable=/.test(seg))
  if (!line) return null
  const m = /enable='between\(t,([\d.]+),/.exec(line)
  return m ? Number(m[1]) : null
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-pip-freeze-'))
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录 */ }
})

/* ============================ ① 静态判据 ============================ */

const { fc, plan } = planOf(makeClips(3, 10), tmp)
check('buildPlan 成功产出画中画链（无 error）', !plan.error && /pipin0/.test(fc), plan.error || '')
const shift = pipShiftSeconds(fc)
const winStart = windowStart(fc)
check('画中画视频链带 setpts=PTS-STARTPTS+{t0}/TB（不是裸归零）', shift !== null, `shift=${shift}`)
check('画中画 PTS 平移值 == 显示窗口起点 t0（3s）', shift === 3 && winStart === 3, `shift=${shift} window=${winStart}`)

/* 不同 start 都要对齐：换一个 7s 起点 */
const { fc: fc7 } = planOf(makeClips(7, 4), tmp)
check('画中画起点改成 7s，平移值跟着变 7、窗口也 7（判据非写死）',
  pipShiftSeconds(fc7) === 7 && windowStart(fc7) === 7,
  `shift=${pipShiftSeconds(fc7)} window=${windowStart(fc7)}`)

/* 负对照：没有平移的旧链，判据必须认出来（模拟回归） */
const oldLine = '[0:v]trim=start=0:duration=10,setpts=PTS-STARTPTS,scale=640:-2,setsar=1,fps=30,format=yuv420p[pipin0]'
check('负对照：旧链（setpts 只归零、无 +t0）被判为缺平移', pipShiftSeconds(oldLine) === null)
check('负对照：旧链的窗口起点仍能读出来（证明判据不是恒 null）', windowStart(`[a][pipin0]overlay=enable='between(t,3,13)'[v]`) === 3)

/* 音频画中画对称性：adelay 用的是 t0*1000 */
const withAudio = makeClips(3, 10)
withAudio[1].hasAudio = true
const { fc: fcA } = planOf(withAudio, tmp)
check('音频画中画用 adelay=3000 平移到同一窗口起点（音视频对称）',
  /adelay=3000:all=1/.test(fcA), (fcA.match(/adelay=\d+:all=1/g) || []).join(','))

/* ============================ selftest 到此为止 ============================ */
if (SELFTEST) {
  console.log(`\nPIP_FREEZE_SELFTEST_STATS total=${pass + fail} pass=${pass} fail=${fail}`)
  if (fail) {
    for (const p of problems) console.log(`  · ${p}`)
    console.log('PIP_FREEZE_SELFTEST_FAIL')
    process.exit(1)
  }
  console.log('PIP_FREEZE_SELFTEST_OK')
  process.exit(0)
}

/* ============================ ② 真机抽帧 ============================ */

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('PIP_FREEZE_SKIPPED 本机没有 ffmpeg（画中画成片无法验证）')
  process.exit(2)
}
const ffmpeg = found.ffmpeg
function ff(args, tag) {
  return spawnCapture(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', ...args], { tag })
}

/* 主链：16s 静止纯红；画中画：10s testsrc2（持续运动），start=3 铺满。
   修复前：画中画流 PTS [0,10]，窗口 [3,13] ⇒ t=11/12 都 EOF → repeat 同一帧 → 两帧相同。
   修复后：画中画流 PTS [3,13] ⇒ t=11/12 都在播运动画面 → 两帧不同。 */
const mainFile = path.join(tmp, 'main.mp4')
const pipFile = path.join(tmp, 'pip.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '16', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mainFile], 'mk-main')
ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-pix_fmt', 'yuv420p', pipFile], 'mk-pip')

const outFile = path.join(tmp, 'out.mp4')
const clips = [
  { id: 'main', track: 'video', kind: 'video', path: mainFile, start: 0, duration: 16, offset: 0, sourceDuration: 16 },
  { id: 'pip', track: 'overlay', kind: 'video', path: pipFile, start: 3, duration: 10, offset: 0, sourceDuration: 10 }
]
const result = await render.render({
  clips, outPath: outFile,
  options: { width: 640, height: 360, aspect: '16:9', fps: 30, quality: 80 },
  ffmpegPath: ffmpeg
})
check('真机导出成功（画中画 start=3s 铺满）', result.ok === true && fs.existsSync(outFile), result.error || '')

/** 抽某一时刻的一帧原始 RGB（rawvideo），返回 Buffer；字节确定，可比 */
function frameAt(sec) {
  /* 让 ffmpeg 把帧**写成文件**再 fs 读 Buffer。绝不能走 spawnCapture 的 stdout ——
     它按 utf8 读文本，rawvideo 二进制会被解码/重编码破坏，比出来的"差异"全是乱码噪声。
     -ss 放 -i 之后（output seek）：input seek 在关键帧稀疏时可能落到错误帧。 */
  const f = path.join(tmp, `frame-${String(sec).replace('.', '_')}.rgb`)
  ff(['-i', outFile, '-ss', String(sec), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', f], `frame-${sec}`)
  return fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0)
}

if (result.ok === true && fs.existsSync(outFile)) {
  /* 判据不是抽两个点 —— 旧版定格是间歇性的（overlay 的 framesync 在 EOF 边界
     偶尔重复帧、偶尔又抓到边界帧），两点可能恰好都动、误判成没卡。
     改成在窗口 [4,12.5] 内每 0.5s 抽一帧，数"相邻帧几乎完全相同"的对数（静止帧对）：
       修复后画中画持续播 ⇒ 静止帧对很少；
       修复前画中画流先 EOF、窗口还没结束 ⇒ 出现多段静止帧对。 */
  const frameSize = 640 * 360 * 3
  const times = []
  for (let t = 4; t <= 12.5; t += 0.5) times.push(Number(t.toFixed(1)))
  const frames = times.map((t) => frameAt(t))
  check('抽帧拿到完整 RGB 帧', frames.every((b) => b.length >= frameSize),
    `最短 ${Math.min(...frames.map((b) => b.length))}`)

  const diffRatio = (a, b) => {
    if (a.length !== b.length || !a.length) return 1
    let d = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
    return d / a.length
  }
  let frozenPairs = 0
  const pairDetail = []
  for (let i = 1; i < frames.length; i++) {
    const r = diffRatio(frames[i - 1], frames[i])
    if (r < 0.005) { frozenPairs++; pairDetail.push(`${times[i - 1]}~${times[i]}`) }
  }
  console.log(`      [诊断] 窗口内静止帧对 ${frozenPairs}/${frames.length - 1}：${pairDetail.join(' ')}`)
  /* 修复后画中画素材全程在动，相邻 0.5s 的帧差异巨大（实测 0 对静止）。
     阈值 1：留一对给编码巧合；旧版实测 3 对连续静止（10.5~11 / 11.5~12 / 12~12.5），
     真实源码负对照（去掉 pipShift）已验红在这一条。 */
  check(
    '画中画窗口内几乎没有静止帧对（未定格卡死）—— 修复前有多段连续静止',
    frozenPairs <= 1,
    `静止帧对 ${frozenPairs}: ${pairDetail.join(' ')}`
  )

  /* 对照：主链纯红静止，窗口外 t=1 与 t=2 必须逐字节相同 —— 证明判据测的是画中画在动，
     不是整片都在变（否则上面的"差异"可能来自别的东西）。 */
  const outside = diffRatio(frameAt(1), frameAt(2))
  check('窗口外两帧完全相同（主链静止，差异确来自画中画）', outside === 0, `差异 ${(outside * 100).toFixed(2)}%`)
}

console.log(`\n=== 画中画卡死：通过 ${pass} / 失败 ${fail} ===`)
console.log(`PIP_FREEZE_STATS total=${pass + fail} pass=${pass} fail=${fail} skip=0`)
if (fail) {
  console.log('失败项：')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}
console.log('PIP_FREEZE_OK')
process.exit(0)
