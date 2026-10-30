/**
 * 成片渲染 E2E：不 mock 任何东西，真的用 ffmpeg 造素材、组时间线、渲染、再验产物。
 *
 * 为什么必须这么测：渲染这条链路最容易「看起来跑通了」——
 * 命令拼错、滤镜标签写漏、concat 段参数不一致，都会让 ffmpeg 退出码非 0，
 * 但只要没人看 stderr，界面照旧弹「导出成功」。这里把断言钉在产物上：
 * 时长、分辨率、有没有音轨、文件多大。
 *
 * 断言总数恒为 40：没装 ffprobe 时，依赖它的 9 条逐条记 SKIP（而不是少跑 9 条），
 * 这样 verify.mjs 里钉死的数字才有意义 —— 掉下来只可能是有人删了断言。
 *
 * 用法：node tools/render-e2e.mjs
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

let pass = 0
let fail = 0
let skip = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

function skipped(label, why) {
  skip += 1
  console.log(`  - ${label}  [SKIP] ${why}`)
}

/** 汇总：既给人看，也给 verify.mjs 解析（total 恒为 15） */
function summary() {
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`RENDER_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('RENDER_E2E_FAILED')
    process.exitCode = 1
  } else {
    console.log('RENDER_E2E_OK')
    process.exitCode = 0
  }
}

function run(bin, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    // spawn 失败（ENOENT）只走 'error' 不走 'close'，不接这个事件会让整个脚本崩栈
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e && e.message) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** ffprobe 拿 JSON；任何失败（没装 / 超时 / 输出不是 JSON）都返回 null */
async function ffprobeJson(ffprobe, args) {
  if (!ffprobe) return null
  const r = await run(ffprobe, ['-v', 'error', ...args])
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

/**
 * 取成片某一帧某一个小块的平均颜色（rgb24）。
 *
 * ⚠️ 块取 8×8 而不是 1×1：本机 ffmpeg 对 `crop=1:1:…` 报
 *    "Invalid too big or non positive size for width '0'"，取大一点就正常（实测 4×4 起可用）。
 *    这条坑本身也提醒一件事 —— 判据失败时要能分辨"取不到像素"和"取到黑"，
 *    所以调用处 SKIP（取不到）与 FAIL（取到但不该是这个色）是分开的。
 *
 * ⚠️ 阈值按 **yuv 有限范围** 给：纯绿 #00FF00 经 yuv420p 往返后实测是 rgb(0,126,0)，
 *    不是 255。按 255 去判会得到一条永远红的闸门，而它红的原因与被测代码无关。
 *
 * @param seek 取第几秒的画面（画中画有时间窗，必须能按时刻取样）
 */
async function blockColor(ffmpeg, file, x, y, work, seek = 0) {
  const raw = path.join(work, `px-${x}-${y}-${String(seek).replace('.', '_')}.raw`)
  const args = ['-v', 'error', '-y']
  if (seek > 0) args.push('-ss', String(seek))
  args.push('-i', file)
  args.push('-vf', `crop=8:8:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw)
  const r = await run(ffmpeg, args)
  if (r.code !== 0) return null
  try {
    const buf = fs.readFileSync(raw)
    const n = Math.floor(buf.length / 3)
    if (n < 1) return null
    let rr = 0
    let gg = 0
    let bb = 0
    for (let i = 0; i < n; i += 1) {
      rr += buf[i * 3]
      gg += buf[i * 3 + 1]
      bb += buf[i * 3 + 2]
    }
    return [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)]
  } catch {
    return null
  }
}

/**
 * 数一块区域里"接近白色"的像素个数。
 *
 * 为什么数个数而不取平均色：白字落在纯红画面上，8×8 的平均色会被底色稀释成
 * "有点红"，判据就说不清"字到底在不在"。改成数近白像素，字在就是几十上百个，
 * 不在就是 0 —— 两者的差别是数量级级别的，不会被编码误差吃掉。
 *
 * @returns {number|null} null = 取不到（调用方记 SKIP，不能当成"没有字"）
 */
async function countWhite(ffmpeg, file, x, y, w, h, work, seek = 0) {
  const raw = path.join(work, `w-${x}-${y}-${String(seek).replace('.', '_')}.raw`)
  const args = ['-v', 'error', '-y']
  if (seek > 0) args.push('-ss', String(seek))
  args.push('-i', file)
  args.push('-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw)
  const r = await run(ffmpeg, args)
  if (r.code !== 0) return null
  try {
    const buf = fs.readFileSync(raw)
    const n = Math.floor(buf.length / 3)
    if (n < 1) return null
    let c = 0
    for (let i = 0; i < n; i += 1) {
      if (buf[i * 3] > 150 && buf[i * 3 + 1] > 150 && buf[i * 3 + 2] > 150) c += 1
    }
    return c
  } catch {
    return null
  }
}

const readDuration = async (ffprobe, file) => {
  const j = await ffprobeJson(ffprobe, ['-show_entries', 'format=duration', '-of', 'json', file])
  const d = j && j.format ? Number(j.format.duration) : NaN
  return Number.isFinite(d) ? d : NaN
}

/**
 * 「能找到 ffmpeg」之后**全部**断言的名字，按执行顺序一条不落。
 *
 * 为什么要单独抽一份：下面有两个提前 return 的分支（没装 ffmpeg / 装了跑不起来），
 * 都必须把剩下的断言逐条 SKIP —— 少了任何一条，总数就对不上 verify.mjs 钉的 35，
 * 于是"闸门红了"看上去像被测代码坏了，其实是**清单漏抄**。
 * 抄两份必然有一天不同步（以前就是两份），所以只留这一份真源。
 */
const REST_LABELS = [
  'ffmpeg 可执行（-version 返回 0）',
  '测试素材生成完毕',
  'ffprobe 认出蓝色片段没有音轨',
  '渲染返回成功',
  '渲染过程有进度回调',
  '产出文件存在且非空',
  '产物时长约 8 秒',
  '产物有视频轨',
  '产物分辨率是 640x360（小片段被放大、超尺寸被压回）',
  '产物有音轨（视频原声 + 独立音频混流）',
  '文件体积合理（>60KB 说明真有画面内容）',
  '空时间线被拒绝',
  '带入点(offset)的单段渲染成功',
  '入点生效：切 1 秒得到约 1 秒',
  '画面特效（fx-pulse + fx-flash）随导出真实生效',
  '特效产物时长 4 秒（2+2，特效不改变时长）',
  '背景（素材 → 背景）随导出真实生效',
  '4:3 素材进 16:9 画布按裁切铺满（边角是画面本身，不是黑边）',
  '成片中心像素仍是画面本身（背景在画面之下）',
  '片段缩到 50% 后四周露出的是背景（不是黑边）',
  '画中画（叠加轨）随导出真实生效',
  '画中画压在主画面之上（右下角是画中画、上方仍是主画面）',
  '画中画锚点改到左上后，画中画出现在左上',
  '画中画只在自己的时间窗里出现（窗外的帧没有它）',
  '字幕（字幕轨）随导出真实写进成片',
  '成片字幕区域真的有白字（不是只有画面）',
  '字幕只在自己的时间窗里出现（窗外没有字）',
  '从素材库拖进来的文字素材不会被画成字幕',
  '倍速：2 倍速片段能渲染',
  '倍速：成片时长按时间线占位（3 秒源 2 倍速 ⇒ 1.5 秒）',
  '倍速：成片第 0.75 秒取的是源第 1.5 秒的画面（画面真的在快进）',
  '倍速：成片末尾取到的是源最末一段（整段源素材都被走完）',
  '倍速：原速片段不受影响（回归）',
  '倍速：带音轨的片段走 atempo 链路不报错',
  /* 封面三条：位置放第 5 秒（蓝）而不是第 0 秒（红）——若抽帧根本没读时间点、
     或 -ss 放错位置落到首个关键帧，抽到的都会是红的那一帧，一眼分辨。 */
  '封面图随导出生成（开了开关就真的多一张图）',
  '封面尺寸与成片一致（640x360）',
  '封面取的是指定那一帧（第 5 秒 ⇒ 蓝色，不是第 0 秒的红色）',
  /* NTSC 两条：容器里写下的 avg_frame_rate 必须是 30000/1001。
     这条只能靠 ffprobe 读回来，看参数拼得对不对是证不了自己的。 */
  '29.97fps 的成片能渲染出来',
  '29.97fps 落到容器里是 30000/1001（不是 2997/100，也不是被四舍五入成 30）'
]

async function main() {
  console.log('=== 成片渲染 E2E ===')

  const found = render.findFfmpeg()
  check('能找到 ffmpeg', Boolean(found), found ? found.ffmpeg : '未找到')
  if (!found) {
    for (const l of REST_LABELS) skipped(l, '本机没有 ffmpeg')
    summary()
    return
  }

  const ffmpeg = found.ffmpeg
  const ffprobe = found.ffprobe || ''

  const info = await render.probe()
  check('ffmpeg 可执行（-version 返回 0）', info.available, info.version || info.detail || '')
  if (!info.available) {
    // 上面已经把「ffmpeg 可执行」记成 FAIL 了，所以从第二条开始 SKIP
    for (const l of REST_LABELS.slice(1)) skipped(l, 'ffmpeg 装了但跑不起来')
    summary()
    return
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-render-'))
  const clipA = path.join(work, 'a.mp4')
  const clipB = path.join(work, 'b.mp4')
  const clipC = path.join(work, 'c.mp3')
  const still = path.join(work, 'still.png')
  const out = path.join(work, 'out.mp4')

  // 造素材：红 3 秒（带 440Hz 正弦）、蓝 2 秒（无音轨）、一张静图、一段 2 秒音频
  const mk = async (args) => {
    const r = await run(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', ...args])
    if (r.code !== 0) throw new Error(r.stderr)
  }
  try {
    await mk(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipA])
    await mk(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', clipB])
    await mk(['-f', 'lavfi', '-i', 'color=c=green:s=200x200', '-frames:v', '1', still])
    await mk(['-f', 'lavfi', '-i', 'sine=frequency=880', '-t', '2', '-c:a', 'libmp3lame', clipC])
  } catch (e) {
    check('测试素材生成完毕', false, String(e.message).slice(0, 200))
    // 上面已经把「ffmpeg 可执行」与「测试素材生成完毕」记过了，所以从第三条开始 SKIP
    for (const l of REST_LABELS.slice(2)) skipped(l, '素材生成失败')
    summary()
    return
  }
  check('测试素材生成完毕', fs.existsSync(clipA) && fs.existsSync(clipB) && fs.existsSync(clipC) && fs.existsSync(still))

  /* ---------------------- 无音轨识别（依赖 ffprobe） ---------------------- */
  if (!ffprobe) {
    skipped('ffprobe 认出蓝色片段没有音轨', '未找到 ffprobe（渲染会退化成"假设有音轨 + 失败重试"）')
  } else {
    const probed = await render.probeStreams(clipB)
    check('ffprobe 认出蓝色片段没有音轨', Boolean(probed) && probed.hasAudio === false, probed ? JSON.stringify(probed) : '探测失败')
  }

  /* -------------------------- 时间线 -------------------------- */
  const clips = [
    { id: 'v1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 3, offset: 0 },
    { id: 'v2', track: 'video', kind: 'video', path: clipB, url: '', start: 4, duration: 2, offset: 0 },
    { id: 'v3', track: 'video', kind: 'image', path: still, url: '', start: 6, duration: 2, offset: 0 },
    { id: 'a1', track: 'audio', kind: 'audio', path: clipC, url: '', start: 1, duration: 2, offset: 0 }
  ]

  let lastRatio = 0
  let progressCalls = 0
  const result = await render.render({
    clips,
    outPath: out,
    /* 封面也挂在这一轮上（不另起一次渲染）：成片是本例现成的 8 秒片，
       第 5 秒落在蓝色片段里，与第 0 秒的红色天然可分。 */
    options: { width: 640, height: 360, fps: 25, quality: 80, cover: { enabled: true, at: 5 } },
    onProgress: (r) => {
      progressCalls += 1
      lastRatio = r
    }
  })

  check('渲染返回成功', result.ok === true, result.ok ? '' : String(result.error).slice(0, 300))
  check('渲染过程有进度回调', progressCalls > 0, `${progressCalls} 次，末值 ${lastRatio.toFixed(3)}`)
  check('产出文件存在且非空', fs.existsSync(out) && fs.statSync(out).size > 1000, fs.existsSync(out) ? `${fs.statSync(out).size} 字节` : '不存在')

  if (!result.ok) {
    for (const l of ['产物时长约 8 秒', '产物有视频轨', '产物分辨率是 640x360（小片段被放大、超尺寸被压回）', '产物有音轨（视频原声 + 独立音频混流）', '文件体积合理（>60KB 说明真有画面内容）']) {
      skipped(l, '渲染没成功，产物断言无意义')
    }
  } else {
    const size = fs.statSync(out).size
    // 用 ffprobe 验产物：时长应为 0..8（视频 3s + 空档 1s + 2s + 2s = 8s）
    const probeOut = await ffprobeJson(ffprobe, [
      '-show_entries', 'format=duration',
      '-show_entries', 'stream=codec_type,width,height',
      '-of', 'json',
      out
    ])
    const streams = (probeOut && probeOut.streams) || []
    const duration = Number(probeOut && probeOut.format && probeOut.format.duration)
    const video = streams.find((s) => s.codec_type === 'video')
    const audio = streams.find((s) => s.codec_type === 'audio')

    if (!probeOut) {
      for (const l of ['产物时长约 8 秒', '产物有视频轨', '产物分辨率是 640x360（小片段被放大、超尺寸被压回）', '产物有音轨（视频原声 + 独立音频混流）']) {
        skipped(l, '未找到可用的 ffprobe，无法解析产物容器')
      }
    } else {
      check('产物时长约 8 秒', Math.abs(duration - 8) < 0.35, `实测 ${duration.toFixed(3)}s`)
      check('产物有视频轨', Boolean(video))
      check('产物分辨率是 640x360（小片段被放大、超尺寸被压回）', video && video.width === 640 && video.height === 360, video ? `${video.width}x${video.height}` : '')
      check('产物有音轨（视频原声 + 独立音频混流）', Boolean(audio))
    }
    check('文件体积合理（>60KB 说明真有画面内容）', size > 60000, `${(size / 1024).toFixed(1)} KB`)

    /* ------------------------------ 封面图 ------------------------------ */
    const coverPath = result.coverPath || ''
    const coverExists = Boolean(coverPath) && fs.existsSync(coverPath)
    const coverOk = coverExists && fs.statSync(coverPath).size > 1024
    check(
      '封面图随导出生成（开了开关就真的多一张图）',
      coverOk,
      coverExists ? `${fs.statSync(coverPath).size} 字节` : String(result.coverError || '没回传路径')
    )
    if (!coverOk) {
      skipped('封面尺寸与成片一致（640x360）', '封面没生成')
      skipped('封面取的是指定那一帧（第 5 秒 ⇒ 蓝色，不是第 0 秒的红色）', '封面没生成')
    } else {
      if (!ffprobe) {
        skipped('封面尺寸与成片一致（640x360）', '未找到 ffprobe')
      } else {
        const coverProbe = await ffprobeJson(ffprobe, ['-show_entries', 'stream=width,height', '-of', 'json', coverPath])
        const cv = ((coverProbe && coverProbe.streams) || [])[0]
        check('封面尺寸与成片一致（640x360）', Boolean(cv) && cv.width === 640 && cv.height === 360, cv ? `${cv.width}x${cv.height}` : '解析不出')
      }
      /* 取封面正中那一块的颜色：第 5 秒是蓝色片段。判据不写死具体通道值，
         只要求"明显偏蓝、不偏红" —— yuv 往返后的蓝实测约 rgb(0,0,254)，
         而第 0 秒的红约 rgb(254,0,0)，两者在 b/r 上完全分离。 */
      const cc = await blockColor(ffmpeg, coverPath, 300, 160, work)
      check(
        '封面取的是指定那一帧（第 5 秒 ⇒ 蓝色，不是第 0 秒的红色）',
        Array.isArray(cc) && cc[2] > 120 && cc[0] < 100,
        cc ? `rgb(${cc.join(',')}) · at=${result.coverAt}` : '取不到像素'
      )
    }
  }

  // 空时间线必须被挡住，而不是产出一个 0 秒的坏文件
  const blank = await render.render({ clips: [], outPath: path.join(work, 'blank.mp4'), options: {} })
  check('空时间线被拒绝', blank.ok === false && blank.reason === 'empty', JSON.stringify(blank).slice(0, 120))

  /* ------------------------ NTSC 帧率：真渲一遍再读回来 ------------------------
   * 为什么只能这样验：帧率这一层错了画面**完全正常**。
   *   · 面板写 29.97、主进程 `Math.round` 成 30 ⇒ 成片是 30fps，看不出任何异常；
   *   · 29.97 原样拼进 `fps=` 滤镜 ⇒ 容器里存 2997/100，能播、能剪，
   *     但广播 QC 与 NLE 二次导入会判"帧率不规范"要求重转。
   * 唯一能分辨的是 ffprobe 读回来的 `avg_frame_rate`，所以判据落在它上面。 */
  const ntscOut = path.join(work, 'ntsc.mp4')
  const ntsc = await render.render({
    clips: [{ id: 'n1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 2, offset: 0 }],
    outPath: ntscOut,
    options: { width: 320, height: 240, fps: 29.97, quality: 80 }
  })
  check('29.97fps 的成片能渲染出来', ntsc.ok === true, ntsc.ok ? '' : String(ntsc.error).slice(0, 200))
  if (!ntsc.ok) {
    skipped('29.97fps 落到容器里是 30000/1001（不是 2997/100，也不是被四舍五入成 30）', '渲染没成功')
  } else if (!ffprobe) {
    skipped('29.97fps 落到容器里是 30000/1001（不是 2997/100，也不是被四舍五入成 30）', '未找到 ffprobe')
  } else {
    const ntscProbe = await ffprobeJson(ffprobe, ['-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', ntscOut])
    const v = ((ntscProbe && ntscProbe.streams) || []).find((item) => item.avg_frame_rate)
    const avg = String((v && v.avg_frame_rate) || '')
    check(
      '29.97fps 落到容器里是 30000/1001（不是 2997/100，也不是被四舍五入成 30）',
      avg === '30000/1001',
      avg ? `avg_frame_rate=${avg}` : '解析不出帧率'
    )
  }

  // 片段无入点时 offset=2 必须真的从第 2 秒开切（切 1 秒）
  const cutOut = path.join(work, 'cut.mp4')
  const cut = await render.render({
    clips: [{ id: 'c1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1, offset: 2 }],
    outPath: cutOut,
    options: { width: 320, height: 240, fps: 25, quality: 80 }
  })
  check('带入点(offset)的单段渲染成功', cut.ok === true, cut.ok ? '' : String(cut.error).slice(0, 200))
  if (!cut.ok) {
    skipped('入点生效：切 1 秒得到约 1 秒', '单段渲染没成功')
  } else {
    const d = await readDuration(ffprobe, cutOut)
    if (Number.isNaN(d)) skipped('入点生效：切 1 秒得到约 1 秒', '未找到可用的 ffprobe')
    else check('入点生效：切 1 秒得到约 1 秒', Math.abs(d - 1) < 0.3, `实测 ${d.toFixed(3)}s`)
  }

  /* -------------------- 画面特效进导出（frameFx） -------------------- */
  // 预览里 7 种特效走 CSS 动画；导出必须由 main/looks.js 的 frameFxFilterFor 翻译成
  // ffmpeg 滤镜。这里挑两个最有代表性的真渲一遍：
  //   · fx-pulse —— 最复杂（scale 放大 + crop 原点带 t 表达式），语法错或表达式
  //     不被 ffmpeg 接受，渲染直接失败，一测一个准；
  //   · fx-flash —— hue 亮度参数带 t 表达式（周期闪光），覆盖另一类参数。
  // 两个都过 ⇒ 滤镜串的"单引号包裹表达式"写法是通的，其余 5 种同构，不必逐个渲。
  const fxOut = path.join(work, 'fx.mp4')
  const fx = await render.render({
    clips: [
      { id: 'fx1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 2, offset: 0, frameFx: 'fx-pulse' },
      { id: 'fx2', track: 'video', kind: 'video', path: clipB, url: '', start: 2, duration: 2, offset: 0, frameFx: 'fx-flash' }
    ],
    outPath: fxOut,
    options: { width: 320, height: 240, fps: 25, quality: 80 }
  })
  check('画面特效（fx-pulse + fx-flash）随导出真实生效', fx.ok === true, fx.ok ? '' : String(fx.error).slice(0, 300))
  if (!fx.ok) {
    skipped('特效产物时长 4 秒', '带特效渲染没成功')
  } else {
    const d = await readDuration(ffprobe, fxOut)
    if (Number.isNaN(d)) skipped('特效产物时长 4 秒', '未找到可用的 ffprobe')
    else check('特效产物时长 4 秒（2+2，特效不改变时长）', Math.abs(d - 4) < 0.35, `实测 ${d.toFixed(3)}s`)
  }

  /* ---------------------------- 曲线进成片 ---------------------------- */
  /**
   * 曲线必须真的作用到成片上。
   *
   * 判据取**像素**：同一段纯红素材渲两遍，一遍不带曲线、一遍带"压高光"曲线
   * （0.5 → 0.02、1 → 0.4），然后比同一小块区域的红通道。
   * ⚠️ 端点必须动：只压中间调的话，纯红素材的红通道本来就是 255，1→1 原样保留，
   *    成片一点不变（第一次写这条就踩了：实测 255 → 255，报出来像"曲线没生效"，
   *    其实是判据选错了素材位置）。所以曲线要连高光一起压。
   * 为什么不用"命令串里有没有 curves=" —— 拼接上了但坐标写错（比如把 0..255
   * 当成 0..1 传给 ffmpeg），命令照样"有 curves="，画面却完全不变或整段发灰。
   * 预览侧有没有生效由 inspector 闸门读 feFuncR 的 tableValues 证，两条合起来才闭环。
   */
  const curvesPlainOut = path.join(work, 'curve-plain.mp4')
  const curvesCrushOut = path.join(work, 'curve-crush.mp4')
  const curvesClip = { id: 'cv1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1, offset: 0 }
  const plainRender = await render.render({
    clips: [curvesClip],
    outPath: curvesPlainOut,
    options: { width: 320, height: 240, fps: 25, quality: 80 }
  })
  const crushRender = await render.render({
    clips: [{ ...curvesClip, curves: { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.02 }, { x: 1, y: 0.4 }] } }],
    outPath: curvesCrushOut,
    options: { width: 320, height: 240, fps: 25, quality: 80 }
  })
  if (!plainRender.ok || !crushRender.ok) {
    check('曲线随导出真实生效（压高光曲线的成片红通道明显变低）', false,
      `渲染失败：${String((plainRender.ok ? crushRender : plainRender).error).slice(0, 200)}`)
  } else {
    const plainPx = await blockColor(ffmpeg, curvesPlainOut, 160, 120, work, 0)
    const crushPx = await blockColor(ffmpeg, curvesCrushOut, 160, 120, work, 0)
    if (!plainPx || !crushPx) skipped('曲线随导出真实生效（压高光曲线的成片红通道明显变低）', '取像素失败')
    else {
      check(
        '曲线随导出真实生效（压高光曲线的成片红通道明显变低）',
        plainPx[0] - crushPx[0] >= 30,
        `红通道 ${plainPx[0]} → ${crushPx[0]}（rgb ${plainPx.join(',')} → ${crushPx.join(',')}）`
      )
    }
  }

  /* ---------------------------- 一级色轮进成片 ---------------------------- */
  /**
   * 色轮必须真的作用到成片上，而且**方向要对**。
   *
   * 判据取像素：同一段纯红素材渲两遍，一遍不带色轮、一遍把阴影轮推到左下（蓝紫）。
   * 纯红的 B 通道原本是 0，只有真的挂上了那张表才会被抬起；
   * 同时 G 通道必须**不动**（推蓝时绿分量是负的，钳在 0）—— 只看"B 变大了"是不够的：
   * 整体提亮一档也会让 B 变大，但那样 G 也会跟着变大，方向就接反了。
   *
   * 为什么不去查命令串里有没有 `lutrgb=`：拼上去了但 `val/255` 写成 `val`
   * （或三路表达式串了同一个通道）时，命令照旧"有 lutrgb="，画面却整片死白或发青。
   * 预览侧由 inspector 闸门读 feFuncB/feFuncR 的 tableValues 证，两条合起来才闭环。
   */
  const wheelsPlainOut = path.join(work, 'wheel-plain.mp4')
  const wheelsBlueOut = path.join(work, 'wheel-blue.mp4')
  const wheelsClip = { id: 'wh1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1, offset: 0 }
  const wheelPlainRender = await render.render({
    clips: [wheelsClip],
    outPath: wheelsPlainOut,
    options: { width: 320, height: 240, fps: 25, quality: 80 }
  })
  const wheelBlueRender = await render.render({
    clips: [{ ...wheelsClip, wheels: { shadow: { x: -0.5, y: -0.52 } } }],
    outPath: wheelsBlueOut,
    options: { width: 320, height: 240, fps: 25, quality: 80 }
  })
  const wheelsName = '色轮随导出真实生效（阴影推蓝：成片 B 抬起来、G 不动，方向没接反）'
  if (!wheelPlainRender.ok || !wheelBlueRender.ok) {
    check(wheelsName, false,
      `渲染失败：${String((wheelPlainRender.ok ? wheelBlueRender : wheelPlainRender).error).slice(0, 200)}`)
  } else {
    const basePx = await blockColor(ffmpeg, wheelsPlainOut, 160, 120, work, 0)
    const bluePx = await blockColor(ffmpeg, wheelsBlueOut, 160, 120, work, 0)
    if (!basePx || !bluePx) skipped(wheelsName, '取像素失败')
    else {
      check(
        wheelsName,
        bluePx[2] - basePx[2] >= 20 && bluePx[1] - basePx[1] <= 12,
        `rgb ${basePx.join(',')} → ${bluePx.join(',')}（B +${bluePx[2] - basePx[2]}、G +${bluePx[1] - basePx[1]}）`
      )
    }
  }

  /* ------------------------ 分区 HSL 进成片 ------------------------ */
  /**
   * 分区 HSL 走 **3D LUT**：预览是 WebGL 的 3D 纹理，导出是 ffmpeg 的 `lut3d` + `.cube`，
   * 两侧共用 shared/hslBands.js 的同一份烘焙。这里验导出那半边**真的改了像素**。
   *
   * 判据一（纯红素材，只把红带的色相推 +30°）：G 必须明显抬起，而 B 基本不动。
   *   ⚠️ 只判"像素变了"不够 —— 整体提亮会让 R/G/B 一起涨，那也能让 G 变大。
   *   色相旋转的特征是 **G 涨、B 不涨**（纯红转 30° 落在橙区）。
   * 判据二（纯灰素材，同一组参数）：三个通道**一律不动**。这一条才是"分区"二字的证据：
   *   权重是色相的函数，灰色饱和度≈0 必须被门控掉。少了它，一个"全局加绿"的实现
   *   在判据一上照样绿。
   *
   * ⚠️ 不查命令串里有没有 `lut3d=`：`.cube` 的行序写反时命令一字不差，
   *   红色会被当成蓝色读（实测 red → (0,0,253)）。行序由 hsl-selftest 单独钉住。
   */
  const grayFile = path.join(work, 'gray.mp4')
  const grayMade = await run(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=#808080:s=320x240:r=25', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', grayFile])
  const hslBands = { red: { h: 1, s: 0, l: 0 } }
  const hslRedOut = path.join(work, 'hsl-red.mp4')
  const hslRedBaseOut = path.join(work, 'hsl-red-base.mp4')
  const hslBaseClip = { id: 'hs1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1, offset: 0 }
  const hslBaseRender = await render.render({
    clips: [hslBaseClip],
    outPath: hslRedBaseOut,
    options: { width: 320, height: 240, fps: 25, quality: 80 }
  })
  const hslRedRender = await render.render({
    clips: [{ ...hslBaseClip, hsl: hslBands }],
    outPath: hslRedOut,
    options: { width: 320, height: 240, fps: 25, quality: 80 }
  })
  const hslName = '分区 HSL 随导出真实生效（红带色相 +30°：成片 G 明显抬起、B 不动）'
  if (!hslBaseRender.ok || !hslRedRender.ok) {
    check(hslName, false,
      `渲染失败：${String((hslBaseRender.ok ? hslRedRender : hslBaseRender).error).slice(0, 300)}`)
  } else {
    const baseRedPx = await blockColor(ffmpeg, hslRedBaseOut, 160, 120, work, 0)
    const hslRedPx = await blockColor(ffmpeg, hslRedOut, 160, 120, work, 0)
    if (!baseRedPx || !hslRedPx) skipped(hslName, '取像素失败')
    else {
      check(
        hslName,
        hslRedPx[1] - baseRedPx[1] >= 40 && hslRedPx[2] - baseRedPx[2] <= 20,
        `rgb ${baseRedPx.join(',')} → ${hslRedPx.join(',')}（G +${hslRedPx[1] - baseRedPx[1]}、B +${hslRedPx[2] - baseRedPx[2]}）`
      )
    }
  }

  const hslGrayName = '分区 HSL 只动该动的颜色（纯灰素材套同一组参数，三通道一律不变）'
  if (grayMade.code !== 0) skipped(hslGrayName, '灰色素材没造出来')
  else {
    const hslGrayBaseOut = path.join(work, 'hsl-gray-base.mp4')
    const hslGrayOut = path.join(work, 'hsl-gray.mp4')
    const grayClip = { id: 'hs2', track: 'video', kind: 'video', path: grayFile, url: '', start: 0, duration: 1, offset: 0 }
    const grayBase = await render.render({
      clips: [grayClip],
      outPath: hslGrayBaseOut,
      options: { width: 320, height: 240, fps: 25, quality: 80 }
    })
    const grayHsl = await render.render({
      clips: [{ ...grayClip, hsl: hslBands }],
      outPath: hslGrayOut,
      options: { width: 320, height: 240, fps: 25, quality: 80 }
    })
    if (!grayBase.ok || !grayHsl.ok) {
      check(hslGrayName, false, `渲染失败：${String((grayBase.ok ? grayHsl : grayBase).error).slice(0, 200)}`)
    } else {
      const gBase = await blockColor(ffmpeg, hslGrayBaseOut, 160, 120, work, 0)
      const gHsl = await blockColor(ffmpeg, hslGrayOut, 160, 120, work, 0)
      if (!gBase || !gHsl) skipped(hslGrayName, '取像素失败')
      else {
        const delta = Math.max(...[0, 1, 2].map((i) => Math.abs(gHsl[i] - gBase[i])))
        check(hslGrayName, delta <= 6, `rgb ${gBase.join(',')} → ${gHsl.join(',')}（最大偏移 ${delta}）`)
      }
    }
  }

  /* ------------------------ 边框（片段属性 PNG）进成片 ------------------------ */
  /**
   * 判据必须**两条一起**判，缺一条都会放过真缺陷：
   *   · 四边变成白框 → 证明边框真的叠上去了（这条只判"多了一层"，不够）；
   *   · 中心仍是原画面 → 证明边框图的**窗口是透明的**。
   * 第二条是这条链上最容易死的地方：链里一旦落到 `format=yuv420p`，
   * PNG 的 alpha 被整体丢弃、透明窗口填黑 —— 于是"加了白框"变成"画面中间一块黑板"，
   * 退出码 0、不报任何错。另一种死法是窗口没透明（画糊了 / 忘了挖洞），
   * 表现是整幅变白。两种都由第二条挡住。
   *
   * 坐标（640×360、`br-basic-white`：inset 34、厚 46，1080 空间）：
   *   竖直方向 34/1080×360 ≈ 11px 起、46/1080×360 ≈ 15px 宽 → x≈11..26 是白框；
   *   取 (12,180) 落在白框上，取 (320,180) 落在窗口中心。
   */
  const borderFile = path.join(ROOT, 'packages', 'desktop', 'resources', 'borders', 'basic', 'br-basic-white.png')
  const borderAssertEdge = '边框进成片：白框压在画面四边（不是只有预览有）'
  const borderAssertWindow = '边框窗口透明：中心仍是原画面（alpha 没被 format 吃掉）'
  if (!fs.existsSync(borderFile)) {
    skipped(borderAssertEdge, '内置边框文件不存在（先跑 py tools/gen-borders.py）')
    skipped(borderAssertWindow, '内置边框文件不存在（先跑 py tools/gen-borders.py）')
  } else {
    const bdOut = path.join(work, 'border.mp4')
    const bdRender = await render.render({
      clips: [
        { id: 'bd0', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1, offset: 0, border: 'br-basic-white' }
      ],
      outPath: bdOut,
      options: { width: 640, height: 360, fps: 25, quality: 80 }
    })
    if (!bdRender.ok) {
      check(borderAssertEdge, false, `渲染失败：${String(bdRender.error).slice(0, 300)}`)
      check(borderAssertWindow, false, `渲染失败：${String(bdRender.error).slice(0, 300)}`)
    } else {
      const bdEdge = await blockColor(ffmpeg, bdOut, 12, 180, work, 0.3)
      const bdMid = await blockColor(ffmpeg, bdOut, 320, 180, work, 0.3)
      if (!bdEdge || !bdMid) {
        skipped(borderAssertEdge, '取像素失败')
        skipped(borderAssertWindow, '取像素失败')
      } else {
        check(
          borderAssertEdge,
          bdEdge[0] > 200 && bdEdge[1] > 200 && bdEdge[2] > 200,
          `左边框处 rgb(${bdEdge.join(',')})（应为白 255,255,255）`
        )
        /* 源片是纯红：中心必须还是红的。变白 = 边框整幅盖死；变黑 = alpha 被丢、填了黑 */
        check(
          borderAssertWindow,
          bdMid[0] > 150 && bdMid[1] < 90 && bdMid[2] < 90,
          `窗口中心 rgb(${bdMid.join(',')})（应仍为红，不能变白或变黑）`
        )
      }
    }
  }

  /* ------------------------ 贴纸（叠加轨 PNG）进成片 ------------------------ */
  /**
   * 判据必须落在**透明区**上，只判"画面上多了个东西"是不够的。
   *
   * ffmpeg 链里一旦是 `format=yuv420p`，alpha 会被整体丢弃、透明区填黑 ——
   * 退出码 0、一行错都不报。此时：
   *   · 贴纸中心是黄色（笑脸）—— 一个"白底/黑底方块"也能满足；
   *   · **贴纸方框的角上必须还是红色**（背景透出来）—— 这条才证明 alpha 活着。
   * 所以两条一起判，缺一条都会放过"贴纸变成不透明方块"这个缺陷。
   *
   * 坐标按 shared/pip.json 推（640×360、右下角、宽 30%）：
   *   w = 640×0.30 = 192；m = 640×0.03 = 19.2
   *   x = 19.2 + 1×(640−38.4) − 192 = 428；y 同理 = 148
   * 于是方框是 [428,620]×[148,340]，中心 (524,244)，左上角内侧 (434,154)。
   */
  const stickerFile = path.join(ROOT, 'packages', 'desktop', 'resources', 'stickers', 'face', '1f600.png')
  const stickerAssert = '贴纸进成片：叠上去了、且透明区透出背景（不是白底/黑底方块）'
  if (!fs.existsSync(stickerFile)) {
    skipped(stickerAssert, '内置贴纸文件不存在（先跑 node tools/fetch-stickers.mjs）')
  } else {
    const stOut = path.join(work, 'sticker.mp4')
    const stRender = await render.render({
      clips: [
        { id: 'sk0', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1, offset: 0 },
        {
          id: 'sk1',
          track: 'overlay',
          kind: 'image',
          path: stickerFile,
          url: '',
          start: 0,
          duration: 1,
          offset: 0,
          pip: { anchor: 'right-bottom', size: 30 },
          opacity: 100
        }
      ],
      outPath: stOut,
      options: { width: 640, height: 360, fps: 25, quality: 80 }
    })
    if (!stRender.ok) {
      check(stickerAssert, false, `渲染失败：${String(stRender.error).slice(0, 300)}`)
    } else {
      const stCenter = await blockColor(ffmpeg, stOut, 524, 244, work, 0.2)
      const stCorner = await blockColor(ffmpeg, stOut, 434, 154, work, 0.2)
      const stOutside = await blockColor(ffmpeg, stOut, 60, 60, work, 0.2)
      if (!stCenter || !stCorner || !stOutside) {
        skipped(stickerAssert, '取像素失败')
      } else {
        /* 笑脸是黄的：R/G 都高；透明角仍是背景红：R 高而 G/B 低 */
        const pasted = stCenter[0] > 140 && stCenter[1] > 140
        const seeThrough = stCorner[0] > 150 && stCorner[1] < 90 && stCorner[2] < 90
        check(
          stickerAssert,
          pasted && seeThrough,
          `贴纸中心 ${stCenter.join(',')}（应偏黄）/ 方框角上 ${stCorner.join(',')}（应仍为红）/ 画外 ${stOutside.join(',')}`
        )
      }
    }
  }

  /* ------------------------ 导出编码格式进成片 ------------------------ */
  /**
   * 编码格式（10bit / ProRes 4444）必须真的落进产物的**流参数**里。
   *
   * 这类错的特征是「成片照旧生成、时长画面全对，只是不是选的那个规格」：
   *   · 面板选了 10bit，encodeArgs 仍 `-pix_fmt yuv420p` ⇒ 8 位文件，一句错都不报；
   *   · 选了 ProRes 4444，容器却是 mp4（或编码器回落成 h264）⇒
   *     要么封装失败、要么生成一个"无损、没有 alpha"的普通成片。
   * 所以判据只认 ffprobe 读回来的 `codec_name / profile / pix_fmt` ——
   * 参数拼得对不对是**证不了自己**的（拼错了命令串里一样有那一项）。
   * 纯逻辑那层（表自洽、回落不跨族）由 export-codec-selftest 证。
   */
  const tenBitOut = path.join(work, 'codec-10bit.mp4')
  const tenBit = await render.render({
    clips: [{ id: 'cb1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1, offset: 0 }],
    outPath: tenBitOut,
    options: { width: 320, height: 240, fps: 25, quality: 80, codec: 'h265-10', encoder: 'libx265' }
  })
  check('H.265 10bit 能真编出来', tenBit.ok === true, tenBit.ok ? '' : String(tenBit.error).slice(0, 300))
  const tenBitInfo = tenBit.ok
    ? await ffprobeJson(ffprobe, ['-show_entries', 'stream=codec_name,profile,pix_fmt', '-select_streams', 'v:0', '-of', 'json', tenBitOut])
    : null
  const tenBitStream = tenBitInfo && Array.isArray(tenBitInfo.streams) ? tenBitInfo.streams[0] || {} : null
  const tenBitName = '10bit 成片的编码是 hevc_main10（不是静默回落的 8 位 h264）'
  if (!tenBit.ok) skipped(tenBitName, '10bit 导出没成功')
  else if (!tenBitStream) skipped(tenBitName, '未找到可用的 ffprobe')
  else {
    check(tenBitName,
      /hevc/i.test(String(tenBitStream.codec_name)) && /10/.test(String(tenBitStream.profile || '')),
      `${tenBitStream.codec_name} / ${tenBitStream.profile} / ${tenBitStream.pix_fmt}`)
  }
  const tenBitPixName = '10bit 成片的像素格式是 yuv420p10le（真的 10 位，不是 8 位）'
  if (!tenBit.ok) skipped(tenBitPixName, '10bit 导出没成功')
  else if (!tenBitStream) skipped(tenBitPixName, '未找到可用的 ffprobe')
  else check(tenBitPixName, String(tenBitStream.pix_fmt) === 'yuv420p10le', String(tenBitStream.pix_fmt))

  /**
   * ProRes 4444：容器必须是 MOV、编码必须是 prores 4444、像素格式必须带 alpha。
   * 顺带验 alpha **真的保留了**：片段不透明度 50% ⇒ 整幅 alpha≈128。
   * 这一步是整条功能的意义所在 —— 没有了它，"导出带透明通道的素材给后期"是假的。
   */
  const proresOut = path.join(work, 'codec-prores.mov')
  const prores = await render.render({
    clips: [{ id: 'cb2', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1, offset: 0, opacity: 50 }],
    outPath: proresOut,
    options: { width: 320, height: 240, fps: 25, quality: 80, codec: 'prores-4444', encoder: 'prores_ks' }
  })
  check('ProRes 4444 能真编进 MOV（容器与编码器配套）', prores.ok === true,
    prores.ok ? '' : String(prores.error).slice(0, 300))
  const proresInfo = prores.ok
    ? await ffprobeJson(ffprobe, ['-show_entries', 'stream=codec_name,profile,pix_fmt', '-select_streams', 'v:0', '-of', 'json', proresOut])
    : null
  const proresStream = proresInfo && Array.isArray(proresInfo.streams) ? proresInfo.streams[0] || {} : null
  /* 4444 的像素格式是 **12 位**：ffmpeg 的 prores_ks 对 4444 一律写 12 位，
     显式传 10le 也照样得 12le（本机实测）。判据照产物写，不照我们的期望写。 */
  const proresName = 'ProRes 成片是 4444 profile + yuva444p12le（带 alpha 的那一档）'
  if (!prores.ok) skipped(proresName, 'ProRes 导出没成功')
  else if (!proresStream) skipped(proresName, '未找到可用的 ffprobe')
  else {
    check(proresName,
      /prores/i.test(String(proresStream.codec_name)) &&
        /4444/.test(String(proresStream.profile || '')) &&
        String(proresStream.pix_fmt) === 'yuva444p12le',
      `${proresStream.codec_name} / ${proresStream.profile} / ${proresStream.pix_fmt}`)
  }

  const proresAlphaName = 'ProRes 4444 的 alpha 真的留下来了（半透明片段的成片 alpha≈128，不是被压黑）'
  if (!prores.ok) skipped(proresAlphaName, 'ProRes 导出没成功')
  else {
    /* 直接读 rgba 的第四个字节：压黑那一步会把 alpha 写成 255（不透明），
       而我们要的正是"不压黑"。读 rgb 是看不出区别的（两者画面都偏暗）。 */
    const alphaFile = path.join(work, 'alpha.raw')
    const alphaRun = await run(ffmpeg, [
      '-v', 'error', '-y', '-i', proresOut,
      '-vf', 'crop=8:8:160:120', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', alphaFile
    ])
    let alpha = null
    if (alphaRun.code === 0) {
      try {
        const buf = fs.readFileSync(alphaFile)
        if (buf.length >= 4) alpha = buf[3]
      } catch {
        alpha = null
      }
    }
    if (alpha === null) skipped(proresAlphaName, '读 alpha 失败')
    /* 容差 40：ProRes 的 alpha 也是 10 位压出来的，且着色/缩放会带一点舍入 */
    else check(proresAlphaName, Math.abs(alpha - 128) <= 40, `alpha=${alpha}（50% 不透明度期望 ≈128）`)
  }

  /* -------------------------- 背景进成片 -------------------------- */
  /**
   * 「素材 → 背景」选的那张图必须真的出现在成片里。
   *
   * 判据取**像素**而不是取命令串：这条链路最容易出现的失效是"背景参数接了、
   * 素材四周也挖成了透明、但最后没有 overlay" —— 那时候透明被输出成黑色，
   * 命令里能找到 -i 背景图、退出码也是 0，唯独画面角落是黑的。
   * 所以直接量角落那一点的颜色：640×360 画布放 320×240 的红片段（4:3），
   * 左右各有 80px 边条，x=2 处**只可能是背景**，不可能是画面。
   */
  const bgOut = path.join(work, 'bg.mp4')
  const bg = await render.render({
    clips: [{ id: 'bg1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 2, offset: 0 }],
    outPath: bgOut,
    options: { width: 640, height: 360, fps: 25, quality: 80 },
    // 走 file:// URL：打包后渲染层给的就是这种形式（且可能指向 app.asar 内），
    // 顺带把 backdropToLocal 的剥协议 + 落地逻辑一起验了
    backdrop: `file:///${still.replace(/\\/g, '/')}`
  })
  check('背景（素材 → 背景）随导出真实生效', bg.ok === true, bg.ok ? '' : String(bg.error).slice(0, 300))
  if (!bg.ok) {
    skipped('4:3 素材进 16:9 画布按裁切铺满（边角是画面本身，不是黑边）', '带背景渲染没成功')
    skipped('成片中心像素仍是画面本身（背景在画面之下）', '带背景渲染没成功')
    skipped('片段缩到 50% 后四周露出的是背景（不是黑边）', '带背景渲染没成功')
  } else {
    /**
     * 取成片某一帧某一个小块的平均颜色（rgb24）。
     *
     * ⚠️ 块取 8×8 而不是 1×1：本机 ffmpeg 对 `crop=1:1:…` 报
     *    "Invalid too big or non positive size for width '0'"，取大一点就正常（实测 4×4 起可用）。
     *    这条坑本身也提醒一件事 —— 判据失败时要能分辨"取不到像素"和"取到黑"，
     *    所以下面每条都是 SKIP（取不到）与 FAIL（取到但不该是这个色）分开的。
     *
     * ⚠️ 阈值按 **yuv 有限范围** 给：纯绿 #00FF00 经 yuv420p 往返后实测是 rgb(0,126,0)，
     *    不是 255。按 255 去判会得到一条永远红的闸门，而它红的原因与被测代码无关。
     */
    const pixel = (x, y, seek) => blockColor(ffmpeg, bgOut, x, y, work, seek)

    /**
     * 第一条：4:3 的红片段进 16:9 画布，**边角必须是画面本身（红）**。
     *
     * 这是"预览窗是取景框、窗外不显示"（裁切）这条产品语义在成片上的对应物：
     * 素材按 force_original_aspect_ratio=increase + crop 铺满，多余的部分被裁掉，
     * 四周**不留边**、也不补黑边。以前是 decrease + pad（留黑边），
     * 那时边角是背景色 —— 判据必须跟着语义一起改，否则就是在钉一个已被推翻的前提。
     */
    const corner = await pixel(2, 176)
    if (!corner) skipped('4:3 素材进 16:9 画布按裁切铺满（边角是画面本身，不是黑边）', '取像素失败')
    else {
      check(
        '4:3 素材进 16:9 画布按裁切铺满（边角是画面本身，不是黑边）',
        corner[0] > 60 && corner[1] < 40 && corner[2] < 40,
        `实测 rgb(${corner.join(',')})，期望偏红（片段是纯红片，且已裁切铺满整块画布）`
      )
    }

    const center = await pixel(316, 176)
    if (!center) skipped('成片中心像素仍是画面本身（背景在画面之下）', '取像素失败')
    else {
      check(
        '成片中心像素仍是画面本身（背景在画面之下）',
        center[0] > 60 && center[1] < 40 && center[2] < 40,
        `实测 rgb(${center.join(',')})，期望偏红（片段是纯红片）`
      )
    }

    /**
     * 第三条：把同一个片段缩到 50%，四周**必须**露出背景（不是黑边）。
     *
     * 它是第一条的反面，两条合起来才钉得住完整语义 ——
     *   · 素材默认铺满（比例不匹配就裁，不留边）；
     *   · 但用户主动缩小后，露出来的地方是**背景图**，不是黑边。
     * 只验第一条会漏掉"pad 用了黑色补边"这种静默失效，只验第三条会退回旧的留边语义。
     */
    const bgSmallOut = path.join(work, 'bg-small.mp4')
    const bgSmall = await render.render({
      clips: [{ id: 'bg2', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 2, offset: 0, scale: 50 }],
      outPath: bgSmallOut,
      options: { width: 640, height: 360, fps: 25, quality: 80 },
      backdrop: `file:///${still.replace(/\\/g, '/')}`
    })
    if (!bgSmall.ok) {
      skipped('片段缩到 50% 后四周露出的是背景（不是黑边）', '缩小的那段渲染没成功')
    } else {
      // 缩到 50% ⇒ 画面 320×180 居中，占据 x=160..480；x=2 处只可能是背景
      const smallCorner = await blockColor(ffmpeg, bgSmallOut, 2, 176, work)
      if (!smallCorner) skipped('片段缩到 50% 后四周露出的是背景（不是黑边）', '取像素失败')
      else {
        check(
          '片段缩到 50% 后四周露出的是背景（不是黑边）',
          smallCorner[1] > 60 && smallCorner[0] < 40 && smallCorner[2] < 40,
          `实测 rgb(${smallCorner.join(',')})，期望偏绿（背景是纯绿图；yuv 往返后约 0,126,0）`
        )
      }
    }
  }

  /* -------------------- 画中画（叠加轨）进成片 -------------------- */
  /**
   * 「叠加轨上的片段」必须真的出现在成片里，而且位置与界面上选的一致。
   *
   * 判据同样取**像素**：这条链路最容易出现的失效有两种，命令串都看不出来 ——
   *   · 导出把叠加轨当普通片段 concat 进主链（成片变长、画中画成了独立一段）；
   *   · 压根没渲染它（时间线上有一段，成片里完全没有）。
   * 只有量"右下角那一块是不是画中画的颜色"才分辨得出。
   *
   * 640×360 画布：主画面是红片 4:3，按**裁切**铺满整块（不再有黑边，见上面背景那组），
   * 画中画是绿图 40%（256×256），右下锚点时占据 x≈365..621、y≈85..341。
   */
  const pipOut = path.join(work, 'pip.mp4')
  const pip = await render.render({
    clips: [
      { id: 'p0', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 3, offset: 0 },
      {
        id: 'p1',
        track: 'overlay',
        kind: 'image',
        path: still,
        url: '',
        start: 0,
        duration: 2,
        offset: 0,
        pip: { anchor: 'right-bottom', size: 40 }
      }
    ],
    outPath: pipOut,
    options: { width: 640, height: 360, fps: 25, quality: 80 }
  })
  check('画中画（叠加轨）随导出真实生效', pip.ok === true, pip.ok ? '' : String(pip.error).slice(0, 300))
  if (!pip.ok) {
    skipped('画中画压在主画面之上（右下角是画中画、上方仍是主画面）', '带画中画渲染没成功')
    skipped('画中画锚点改到左上后，画中画出现在左上', '带画中画渲染没成功')
    skipped('画中画只在自己的时间窗里出现（窗外的帧没有它）', '带画中画渲染没成功')
  } else {
    const inPip = await blockColor(ffmpeg, pipOut, 500, 200, work, 1)
    const mainArea = await blockColor(ffmpeg, pipOut, 200, 40, work, 1)
    if (!inPip || !mainArea) {
      skipped('画中画压在主画面之上（右下角是画中画、上方仍是主画面）', '取像素失败')
    } else {
      check(
        '画中画压在主画面之上（右下角是画中画、上方仍是主画面）',
        inPip[1] > 60 && inPip[0] < 40 && mainArea[0] > 60 && mainArea[1] < 40,
        `右下 rgb(${inPip.join(',')}) 期望偏绿；上方 rgb(${mainArea.join(',')}) 期望偏红`
      )
    }

    // 换锚点：同一份素材、同一条时间线，只改 pip.anchor —— 位置必须跟着走，
    // 否则"界面上点了左上角、成片里还在右下角"
    const pip2Out = path.join(work, 'pip2.mp4')
    const pip2 = await render.render({
      clips: [
        { id: 'p0', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 3, offset: 0 },
        {
          id: 'p1',
          track: 'overlay',
          kind: 'image',
          path: still,
          url: '',
          start: 0,
          duration: 2,
          offset: 0,
          pip: { anchor: 'left-top', size: 40 }
        }
      ],
      outPath: pip2Out,
      options: { width: 640, height: 360, fps: 25, quality: 80 }
    })
    if (!pip2.ok) {
      skipped('画中画锚点改到左上后，画中画出现在左上', '第二次渲染没成功：' + String(pip2.error).slice(0, 120))
    } else {
      const topLeft = await blockColor(ffmpeg, pip2Out, 100, 100, work, 1)
      if (!topLeft) skipped('画中画锚点改到左上后，画中画出现在左上', '取像素失败')
      else {
        check(
          '画中画锚点改到左上后，画中画出现在左上',
          topLeft[1] > 60 && topLeft[0] < 40,
          `左上 rgb(${topLeft.join(',')})，期望偏绿（画中画已挪到左上）`
        )
      }
    }

    // 时间窗：画中画只在前 2 秒，第 2.5 秒的同一块必须回到主画面
    const after = await blockColor(ffmpeg, pipOut, 500, 200, work, 2.5)
    if (!after) skipped('画中画只在自己的时间窗里出现（窗外的帧没有它）', '取像素失败')
    else {
      check(
        '画中画只在自己的时间窗里出现（窗外的帧没有它）',
        after[1] < 40,
        `第 2.5 秒 rgb(${after.join(',')})，期望不再偏绿`
      )
    }
  }

  /* -------------------- 字幕进成片 -------------------- */
  /**
   * 「字幕」必须真的写进成片，而且只在自己的时间窗里。
   *
   * 这一条与"背景进成片"是同一类缺陷的另一面：预览里字幕是 CSS 画的，
   * 导出必须翻译成 drawtext。少了翻译，"加了字幕"就只在预览里成立 ——
   * 成片照出、退出码照旧是 0、界面上一点提示都没有。
   *
   * 判据还是取**像素**，但这次数"接近白色的像素个数"而不是取平均色：
   * 白字落在红画面上，8×8 的平均色会被底色稀释成"有点红"，
   * 判据就说不清"字在不在"。改成数近白像素，字在就是几十上百个，不在就是 0。
   */
  const subOut = path.join(work, 'sub.mp4')
  const sub = await render.render({
    clips: [
      { id: 's0', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 3, offset: 0 },
      {
        id: 's1',
        track: 'text',
        kind: 'text',
        text: '测试字幕',
        textStyle: 'sub-plain',
        start: 1,
        duration: 2,
        offset: 0
      }
    ],
    outPath: subOut,
    options: { width: 640, height: 360, fps: 25, quality: 80 }
  })
  check('字幕（字幕轨）随导出真实写进成片', sub.ok === true, sub.ok ? '' : String(sub.error).slice(0, 300))
  if (!sub.ok) {
    skipped('成片字幕区域真的有白字（不是只有画面）', '带字幕渲染没成功')
    skipped('字幕只在自己的时间窗里出现（窗外没有字）', '带字幕渲染没成功')
    skipped('从素材库拖进来的文字素材不会被画成字幕', '带字幕渲染没成功')
  } else {
    if (Number(sub.subtitleCount || 0) < 1) {
      // 渲染成功但一条字幕都没画 —— 最常见的原因是找不到中文字体
      skipped('成片字幕区域真的有白字（不是只有画面）', '字幕数 0（多半是本机没有可用中文字体）')
    } else {
      const onWords = await countWhite(ffmpeg, subOut, 120, 300, 400, 50, work, 1.5)
      if (onWords === null) skipped('成片字幕区域真的有白字（不是只有画面）', '取像素失败')
      else {
        check(
          '成片字幕区域真的有白字（不是只有画面）',
          onWords > 30,
          `字幕区近白像素 ${onWords} 个（画面本身是纯红，白字只可能来自 drawtext）`
        )
      }
    }

    if (Number(sub.subtitleCount || 0) < 1) {
      skipped('字幕只在自己的时间窗里出现（窗外没有字）', '字幕数 0')
    } else {
      // 字幕只覆盖 1..3 秒，第 0.4 秒的同一块必须没有字
      const before = await countWhite(ffmpeg, subOut, 120, 300, 400, 50, work, 0.4)
      if (before === null) skipped('字幕只在自己的时间窗里出现（窗外没有字）', '取像素失败')
      else {
        check(
          '字幕只在自己的时间窗里出现（窗外没有字）',
          before < 10,
          `第 0.4 秒近白像素 ${before} 个，期望接近 0`
        )
      }
    }

    /**
     * 文字素材（字幕轨上**带 assetId** 的那一种）不该被画成字幕。
     * 它在预览里是一张显示正文的占位卡，导出往画面上写字就是两边不一致。
     */
    const assetTextOut = path.join(work, 'assettext.mp4')
    const assetText = await render.render({
      clips: [
        { id: 't0', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 2, offset: 0 },
        {
          id: 't1',
          track: 'text',
          kind: 'text',
          assetId: 'some-asset',
          text: '这是素材不是字幕',
          textStyle: 'sub-plain',
          start: 0,
          duration: 2,
          offset: 0
        }
      ],
      outPath: assetTextOut,
      options: { width: 640, height: 360, fps: 25, quality: 80 }
    })
    if (!assetText.ok) {
      skipped('从素材库拖进来的文字素材不会被画成字幕', '渲染没成功：' + String(assetText.error).slice(0, 120))
    } else {
      check(
        '从素材库拖进来的文字素材不会被画成字幕',
        Number(assetText.subtitleCount || 0) === 0,
        `subtitleCount=${Number(assetText.subtitleCount || 0)}，期望 0`
      )
    }
  }

  /* -------------------------- 倍速进成片 -------------------------- */
  /**
   * 倍速（speed）必须真的改变成片，而且是**按"时间线占位 / 源素材消耗"的口径**变。
   *
   * 判据为什么取像素而不是取时长：只验时长分辨不出两种错法 ——
   *   · 根本没做变速（成片时长也对，因为 duration 本来就是 1.5 秒）；
   *   · 变速方向做反了（trim 取了 1.5 秒源、再压成 3 秒）。
   * 所以造一条**逐秒换色**的素材（0–1s 红 / 1–2s 绿 / 2–3s 蓝），
   * 2 倍速播 1.5 秒 ⇒ 成片第 0.75 秒必须取到**源第 1.5 秒**的绿。
   * 若没做变速，那一帧会是红（源 0.75 秒）⇒ 一眼分辨。
   */
  const band = path.join(work, 'band.mp4')
  let bandOk = false
  try {
    const seg = []
    for (const [i, color] of ['red', 'green', 'blue'].entries()) {
      const png = path.join(work, `band-${i}.png`)
      await mk(['-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1', png])
      seg.push(png)
    }
    await mk([
      ...seg.flatMap((p) => ['-loop', '1', '-t', '1', '-i', p]),
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25',
      band
    ])
    bandOk = fs.existsSync(band)
  } catch (e) {
    bandOk = false
    console.log(`  [提示] 逐秒换色素材生成失败：${String(e.message).slice(0, 120)}`)
  }

  if (!bandOk) {
    for (const l of [
      '倍速：成片时长按时间线占位（3 秒源 2 倍速 ⇒ 1.5 秒）',
      '倍速：成片第 0.75 秒取的是源第 1.5 秒的画面（画面真的在快进）',
      '倍速：成片末尾取到的是源最末一段（整段源素材都被走完）',
      '倍速：带音轨的片段走 atempo 链路不报错（原速回归也不受影响）'
    ]) {
      skipped(l, '逐秒换色素材生成失败')
    }
  } else {
    const fastOut = path.join(work, 'fast.mp4')
    const fast = await render.render({
      clips: [
        { id: 'f1', track: 'video', kind: 'video', path: band, url: '', start: 0, duration: 1.5, offset: 0, speed: 2 }
      ],
      outPath: fastOut,
      options: { width: 320, height: 240, fps: 25, quality: 80 }
    })
    check('倍速：2 倍速片段能渲染', fast.ok === true, fast.ok ? '' : String(fast.error).slice(0, 300))

    if (!fast.ok) {
      for (const l of [
        '倍速：成片时长按时间线占位（3 秒源 2 倍速 ⇒ 1.5 秒）',
        '倍速：成片第 0.75 秒取的是源第 1.5 秒的画面（画面真的在快进）',
        '倍速：成片末尾取到的是源最末一段（整段源素材都被走完）'
      ]) {
        skipped(l, '2 倍速渲染没成功')
      }
    } else {
      const d = await readDuration(ffprobe, fastOut)
      if (Number.isNaN(d)) skipped('倍速：成片时长按时间线占位（3 秒源 2 倍速 ⇒ 1.5 秒）', '未找到可用的 ffprobe')
      else {
        check(
          '倍速：成片时长按时间线占位（3 秒源 2 倍速 ⇒ 1.5 秒）',
          Math.abs(d - 1.5) < 0.3,
          `实测 ${d.toFixed(3)}s，期望约 1.5s（不是 3s —— 那说明时间线占位没跟着变短）`
        )
      }
      const mid = await blockColor(ffmpeg, fastOut, 156, 116, work, 0.75)
      if (!mid) skipped('倍速：成片第 0.75 秒取的是源第 1.5 秒的画面（画面真的在快进）', '取像素失败')
      else {
        check(
          '倍速：成片第 0.75 秒取的是源第 1.5 秒的画面（画面真的在快进）',
          mid[1] > 50 && mid[0] < 40 && mid[2] < 40,
          `第 0.75 秒 rgb(${mid.join(',')})，期望偏绿（= 源第 1.5 秒）；若是红说明根本没变速`
        )
      }
      const tail = await blockColor(ffmpeg, fastOut, 156, 116, work, 1.4)
      if (!tail) skipped('倍速：成片末尾取到的是源最末一段（整段源素材都被走完）', '取像素失败')
      else {
        check(
          '倍速：成片末尾取到的是源最末一段（整段源素材都被走完）',
          tail[2] > 50 && tail[0] < 40 && tail[1] < 40,
          `第 1.4 秒 rgb(${tail.join(',')})，期望偏蓝（= 源第 2.8 秒）`
        )
      }
    }

    // 原速回归：同一条素材按 1 倍速渲 3 秒，第 0.5 秒必须还是红（源 0.5 秒）
    const normalOut = path.join(work, 'normal.mp4')
    const normal = await render.render({
      clips: [
        { id: 'n1', track: 'video', kind: 'video', path: band, url: '', start: 0, duration: 3, offset: 0, speed: 1 }
      ],
      outPath: normalOut,
      options: { width: 320, height: 240, fps: 25, quality: 80 }
    })
    if (!normal.ok) {
      skipped('倍速：原速片段不受影响（回归）', '原速渲染没成功：' + String(normal.error).slice(0, 120))
    } else {
      const head = await blockColor(ffmpeg, normalOut, 156, 116, work, 0.5)
      if (!head) skipped('倍速：原速片段不受影响（回归）', '取像素失败')
      else {
        check(
          '倍速：原速片段不受影响（回归）',
          head[0] > 50 && head[1] < 40 && head[2] < 40,
          `第 0.5 秒 rgb(${head.join(',')})，期望偏红（= 源第 0.5 秒）`
        )
      }
    }

    // 音轨那条链路：atempo 单级只吃 0.5–2.0，2 倍速要能正常过（不报 Value out of range）
    const fastAudioOut = path.join(work, 'fastaudio.mp4')
    const fastAudio = await render.render({
      clips: [
        { id: 'fa1', track: 'video', kind: 'video', path: clipA, url: '', start: 0, duration: 1.5, offset: 0, speed: 2 }
      ],
      outPath: fastAudioOut,
      options: { width: 320, height: 240, fps: 25, quality: 80 }
    })
    check(
      '倍速：带音轨的片段走 atempo 链路不报错',
      fastAudio.ok === true,
      fastAudio.ok ? '' : String(fastAudio.error).slice(0, 300)
    )
  }

  console.log(`\n产物目录：${work}`)
  summary()
}

main().catch((e) => {
  // 别让异常冒成崩栈：闸门要的是"失败 + 总数对上"，不是一段看不懂的 Node 报错
  console.error('\n[渲染 E2E 自身异常]', e && e.stack ? e.stack : e)
  console.log(`\nRENDER_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail + 1} skip=${skip}`)
  console.log('RENDER_E2E_FAILED')
  process.exit(1)
})
