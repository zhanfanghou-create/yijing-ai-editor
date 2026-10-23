/**
 * 时间线 → 成片渲染（真实调用 ffmpeg，不是导出 JSON 占位）。
 *
 * 设计要点：
 *   · 不把 ffmpeg 打进安装包（体积 + 授权都麻烦），改为运行时探测：
 *     先看 YIJAI_FFMPEG，再看 PATH，最后扫几个常见安装目录。找不到就明确告诉用户怎么办。
 *   · 视频轨按 start 排序，片段之间的空档补黑场，最后 concat 成一个连续视频；
 *     音频轨的片段用 adelay 挪到各自起点，再和视频自带的声音 amix 混在一起。
 *   · concat 滤镜要求各段参数一致，所以每段都先 aformat/setsar/fps 归一化，否则会直接报错。
 *   · 单段时不做 concat（n=1 的 concat 在某些版本上会丢帧）。
 *
 * 这个模块只负责「构造命令 + 跑进程 + 汇报进度」，不碰 Electron API，方便单测。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const looks = require('./looks')
const subtitles = require('./subtitles')
const PIP = require('../shared/pip.json')
/* 倍速的真源：与渲染层**同一份**（各写一份就会有一边漏掉倍速，
   症状是"预览与成片速度不一致"，两边单独看都没错）。 */
const speed = require('../shared/speed.js')
/* 调节 / 美颜：与渲染层共用同一份（预览的 CSS 与这里的 ffmpeg 串从同一个数推出来） */
const adjust = require('../shared/adjust.js')
/**
 * 「效果」真源（圆角 / 蒙版 / 抠像 / 混合 / 变形 / 描边 / 阴影）。
 * ⚠️ 与渲染层 Stage.jsx 读的是**同一份**换算 —— 这里绝不允许再写一遍三角函数或颜色解析，
 *    否则就是"面板上调了、预览里变了、成片里还是原样"。
 */
const effects = require('../shared/effects.js')
/* 画面比例的真源：与渲染层**同一份**（各写一份就会有一边漏掉比例，
   症状是"预览 1:1、成片还是 16:9"，两边单独看都没错）。 */
const aspect = require('../shared/aspect.js')
/* 自由裁剪框：裁剪 + 铺满。与预览的 transform 同一套换算 */
const crop = require('../shared/crop.js')
/* 自由变形（四角透视）：ffmpeg 的 `perspective` 参数由这一份算出来，
   与预览侧的 CSS `matrix3d` 是同一个单应矩阵（见 shared/warp.js 的说明）。 */
const warpTable = require('../shared/warp.js')
/* 音量包络 + 导出阶段的母带处理（响度 / 降噪 / 防抖） */
const audiofx = require('../shared/audio.js')
/* 倒放：导出是 ffmpeg 的 reverse/areverse，预览是 sourceTimeAt 把局部秒翻过来 ——
   两侧实现完全不同，所以"局部时间怎么翻"只能有一份（在 shared/reverse.js 里）。 */
const reverse = require('../shared/reverse.js')
/* 复合片段：**在 render() 入口处展开**，之后整条链（探测 / 遮罩 / 拼图）都只看见普通片段。
   放在这里而不是放在调用方：导出面板、MCP 工具、草稿重渲都是调用方，
   各写一份展开逻辑 = 迟早有一处漏掉，症状是"成片里复合片段整段不见"。 */
const compound = require('../shared/compound.js')
/* 多机位：与复合片段一样在 render() 入口展开。**两道的顺序必须是先多机位后复合**：
   多机位不包住复合片段（建的时候已经排除），反过来则可能（复合里能放多机位展开出的片段）。
   顺序反了会留下"复合片段里还套着一个多机位"的情况 —— 它没有 url，成片里那段是黑的。 */
const multicam = require('../shared/multicam.js')
/* HDR：HLG/PQ 素材必须映射到 SDR 再进调色链，否则超出 100% 的亮部被裁成死白
   （尺寸/时长/帧率全都正常，只有颜色是错的 —— 见 shared/hdr.js 的说明） */
const hdr = require('../shared/hdr.js')
/* 时间区域：只导出区间时在**片段层**把时间线裁到 [start, end) 并归零。
   与渲染层用的是同一份（shared/region.js）—— 各写一份的话，成片里切的位置
   会和预览差一点点，而且谁都不报错。 */
const region = require('../shared/region.js')
/* 画面层级（自由层级）：叠加层的**叠放顺序**。与预览用的是同一份比较函数
   （shared/layers.js）—— 各写一份的话，"预览里 A 压住 B、成片里 B 压住 A"，
   而两边单独看都没错。ffmpeg 的 overlay 链是**后叠的盖住先叠的**，
   所以这里按"底 → 顶"排好、顺序追加即可。 */
const layers = require('../shared/layers.js')
/* 场景检测：ffmpeg 输出的解析与"源秒 → 时间线秒"的换算在渲染层也要用同一份
   （右键菜单点完立刻算切点，不用为一次换算再跑一趟 IPC）。 */
const scenesTable = require('../shared/scenes.js')
/* 预览画质 / 代理：档位表、文件名与缩放滤镜都在 shared/proxy.js（渲染层读同一份档位表）。
   ⚠️ 代理**只服务预览**：本文件里除了这个函数，没有任何导出路径会碰它。 */
const proxyTable = require('../shared/proxy.js')

/** 常见安装位置（Windows 上用户手工解压 ffmpeg 基本就放这几个地方） */
const COMMON_DIRS = [
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
  'C:\\Program Files (x86)\\ffmpeg\\bin',
  'D:\\ffmpeg\\bin',
  'D:\\Program Files\\ffmpeg\\bin',
  'E:\\ffmpeg\\bin'
]

/** 扫盘范围限制在根的下一层，避免全盘遍历把启动卡死 */
const SCAN_ROOTS = ['C:\\', 'D:\\', 'E:\\', 'F:\\']

let cached = null

function exists(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function exeName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base
}

/**
 * 在 PATH 里找一个可执行文件，返回绝对路径；找不到返回 ''。
 *
 * 为什么非要自己查一遍：ffprobe 是「ffmpeg 同目录」推断出来的，
 * 而裸命令 `ffmpeg` 交给 spawn 由 PATH 解析时，我们手里没有它的真实目录
 * （曾用 process.execPath 的目录去猜 —— 那是 node 的目录，永远没有 ffprobe）。
 * 不查这一步的后果：ffprobe 恒为空 → 无法判断片段有没有音轨 →
 * 给无音轨的视频硬接 `[n:a]`，渲染直接报错。
 */
function onPath(base) {
  const dirs = String(process.env.PATH || '').split(path.delimiter)
  const exts = process.platform === 'win32' ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  // 传进来的名字可能已经带扩展名（'ffmpeg.exe'）。那种情况不能再拼一遍 PATHEXT，
  // 否则会去找 ffmpeg.exe.EXE —— 明明在 PATH 里却报「找不到」，静默得很。
  const lower = base.toLowerCase()
  const suffixes = exts.some((ext) => lower.endsWith(ext.toLowerCase())) ? [''] : exts
  for (const raw of dirs) {
    // PATH 条目可能带引号（注册表里读出来的常见形态），不去掉的话拼出来的路径必定不存在
    const dir = raw.replace(/^"|"$/g, '')
    if (!dir || !path.isAbsolute(dir)) continue
    for (const suffix of suffixes) {
      const candidate = path.join(dir, base + suffix)
      if (exists(candidate)) return candidate
    }
  }
  return ''
}

/** ffprobe 优先取 ffmpeg 同目录（版本一致），其次退回 PATH */
function findProbe(binPath) {
  if (binPath) {
    const sameDir = path.join(path.dirname(binPath), exeName('ffprobe'))
    if (exists(sameDir)) return sameDir
  }
  return onPath(exeName('ffprobe'))
}

/**
 * 找 ffmpeg。返回 { ffmpeg, ffprobe, source } 或 null。
 * 结果会缓存 —— 每次导出都扫盘没有意义。
 */
/**
 * 随包目录（可选）。
 *
 * 打包方式定成「**可选随包**」：ffmpeg 是 LGPL/GPL 的，把它**默认**打进我们 MIT 的
 * 发行物会让整份发行物的许可证说不清，所以仓库与默认构建都不带它；
 * 需要"装完就能导出"时，打包者跑一次 `npm run ffmpeg:fetch` 把它下载到这里，
 * 构建时目录里有东西就随包带走、没有就跳过（见 build-installer.mjs）。
 *
 * ⚠️ 用 `process.resourcesPath` 而不是 `app.isPackaged()` 判：开发模式下它指向
 *    Electron 自己的 resources 目录，那里没有 ffmpeg.exe，`exists()` 自然落空，
 *    不需要额外分支；而 if 分支写错就会变成"开发能用、打包后找不到"。
 */
function bundledDir() {
  const root = process.resourcesPath
  return root ? path.join(root, 'ffmpeg') : ''
}

function findFfmpeg() {
  if (cached) return cached
  const candidates = []
  if (process.env.YIJAI_FFMPEG) candidates.push(process.env.YIJAI_FFMPEG)
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  const bundled = bundledDir()
  if (bundled) candidates.push(path.join(bundled, exeName('ffmpeg')))
  candidates.push(exeName('ffmpeg'))
  for (const dir of COMMON_DIRS) candidates.push(path.join(dir, exeName('ffmpeg')))
  // 根目录下一层的 ffmpeg-* 目录（官方 essentials 包解压出来长这样）
  for (const root of SCAN_ROOTS) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^ffmpeg/i.test(entry.name)) continue
      candidates.push(path.join(root, entry.name, 'bin', exeName('ffmpeg')))
      candidates.push(path.join(root, entry.name, exeName('ffmpeg')))
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    // 'ffmpeg' 这种裸命令不存在于磁盘，交给 spawn 走 PATH；但为了拿到它的目录
    // 好去找同目录的 ffprobe，这里先在 PATH 里解析一次（解析不到也照样放行）。
    const absolute = path.isAbsolute(candidate)
    if (absolute && !exists(candidate)) continue
    const resolved = absolute ? candidate : onPath(candidate)
    const fromEnv =
      candidate === process.env.YIJAI_FFMPEG || candidate === process.env.FFMPEG_PATH
    cached = {
      ffmpeg: candidate,
      ffprobe: findProbe(resolved),
      source: fromEnv ? 'env' : absolute ? (bundled && candidate.startsWith(bundled) ? 'bundled' : 'disk') : 'path'
    }
    return cached
  }
  return null
}

function resetFfmpegCache() {
  cached = null
  encoderCache = null
}

/** 跑一个短命令并收集输出；用于 -version / ffprobe */
function run(bin, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error && error.message) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try {
          child.kill()
        } catch {
          /* 已经退出了 */
        }
        resolve({ ok: false, code: -2, stdout, stderr: stderr + '\n(超时)' })
      }
    }, timeout)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: String(error && error.message) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** 硬件编码器的可用性缓存（一次探测、整个会话复用；ffmpeg 路径变了会重置） */
let encoderCache = null

/**
 * 本机 ffmpeg 支持哪些 H.264 编码器。
 *
 * ⚠️ 为什么必须真查一遍：`-c:v h264_nvenc` 在一台没有 NVIDIA 卡的机器上不是"回退到
 *    软编"，而是**整个导出失败**（"Cannot load nvcuda.dll" / "No capable devices found"）。
 *    界面上摆一个选了就废掉的选项，比不摆更糟。
 * ⚠️ `-encoders` 的输出里包含"仅解码"的条目？不会 —— 解码器在 `-decoders` 里，
 *    这里只认 `-encoders` 段落中的 V..... 行。
 */
async function probeEncoders(bin) {
  if (encoderCache) return encoderCache
  const list = []
  const result = await run(bin, ['-hide_banner', '-encoders'], { timeout: 15000 })
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  for (const key of ENCODER_KEYS) {
    /* 行形如 ` V....D h264_nvenc   NVIDIA NVENC H.264 encoder`，
       直接找"空格 + 名字 + 空白"比解析列宽稳。 */
    if (new RegExp(`(^|\\s)${key}(\\s|$)`, 'm').test(text)) list.push(key)
  }
  encoderCache = list
  return list
}

/** 探测可用性 + 版本，供界面显示「本机已就绪 / 未安装」 */
async function probe() {
  const found = findFfmpeg()
  if (!found) return { available: false, reason: 'not-found', ffmpeg: '', ffprobe: '', version: '', encoders: ['libx264'] }
  const result = await run(found.ffmpeg, ['-hide_banner', '-version'])
  if (!result.ok) {
    return { available: false, reason: 'broken', ffmpeg: found.ffmpeg, ffprobe: found.ffprobe, version: '', encoders: ['libx264'], detail: result.stderr.slice(0, 400) }
  }
  const first = result.stdout.split('\n')[0] || ''
  /* 编码器清单：导出面板据此只列出**本机真能用**的那几个 */
  let encoders = ['libx264']
  try {
    encoders = await probeEncoders(found.ffmpeg)
    if (!encoders.includes('libx264')) encoders.unshift('libx264')
  } catch {
    /* 探测失败就只给软编 —— 软编永远能用 */
  }
  return { available: true, reason: 'ok', ffmpeg: found.ffmpeg, ffprobe: found.ffprobe, version: first.trim(), encoders }
}

/* ------------------------------ 媒体探测 ------------------------------ */

/**
 * 用 ffprobe 拿「有没有画面 / 有没有声音 / 多长」。
 * 没有 ffprobe 时返回 null，调用方退化成「视频默认有声音」，并在失败后自动重试。
 */
async function probeStreams(file) {
  const found = findFfmpeg()
  if (!found || !found.ffprobe) return null
  const result = await run(found.ffprobe, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,color_transfer,color_primaries,color_space,pix_fmt',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file
  ], { timeout: 20000 })
  if (!result.ok) return null
  try {
    const parsed = JSON.parse(result.stdout)
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const duration = Number(parsed.format && parsed.format.duration)
    /* 色彩标签挂在该文件的**第一个视频流**上：HDR 判定只认它（见 shared/hdr.js） */
    const video = streams.find((s) => s.codec_type === 'video') || {}
    return {
      hasVideo: streams.some((s) => s.codec_type === 'video'),
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      duration: Number.isFinite(duration) ? duration : 0,
      transfer: video.color_transfer || '',
      primaries: video.color_primaries || '',
      matrix: video.color_space || '',
      pixFmt: video.pix_fmt || ''
    }
  } catch {
    return null
  }
}

/* ------------------------------ 命令构造 ------------------------------ */

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function round(value, digits = 3) {
  return Number(num(value).toFixed(digits))
}

const clampNum = (value, min, max) => Math.min(max, Math.max(min, num(value)))

/** 允许的编码器白名单。渲染层只从这几个里选，未知值一律回落 libx264（不报错，但会在 warnings 里说） */
const ENCODER_KEYS = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf']

/**
 * 编码参数。
 *
 * @param {object} options { encoder, bitrateMode:'quality'|'bitrate', bitrate, preset }
 * @param {number} crf     由画质档推算出来的质量值（16–34）
 * @returns {string[]} 直接拼进 ffmpeg 的参数片段
 */
function encodeArgs(options, crf) {
  const wanted = String((options && options.encoder) || 'libx264')
  const encoder = ENCODER_KEYS.includes(wanted) ? wanted : 'libx264'
  const bitrateMode = options && options.bitrateMode === 'bitrate' ? 'bitrate' : 'quality'
  const kbps = Math.min(200000, Math.max(200, Math.round(num(options && options.bitrate, 8000))))

  if (bitrateMode === 'bitrate') {
    /* 准 CBR：目标码率 + maxrate = 目标 + bufsize = 2×目标。
       只给 -b:v 而不给 maxrate/bufsize 的话，编码器仍会在简单画面上大幅降码率，
       用户看到的"码率"与设置值差一倍以上。 */
    const extra = ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`]
    if (encoder === 'libx264') return ['-c:v', encoder, '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...extra]
    if (encoder === 'h264_nvenc') return ['-c:v', encoder, '-preset', 'p4', '-rc', 'cbr', '-pix_fmt', 'yuv420p', ...extra]
    if (encoder === 'h264_qsv') return ['-c:v', encoder, '-pix_fmt', 'nv12', ...extra]
    return ['-c:v', encoder, '-rc', 'cbr', '-pix_fmt', 'yuv420p', ...extra]
  }

  if (encoder === 'libx264') {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p']
  }
  if (encoder === 'h264_nvenc') {
    /* nvenc 的画质档是 -cq（constant quality），必须显式 -rc vbr，否则 -cq 不生效 */
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(crf), '-pix_fmt', 'yuv420p']
  }
  if (encoder === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-global_quality', String(crf), '-pix_fmt', 'nv12']
  }
  return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-pix_fmt', 'yuv420p']
}

/**
 * 片段的位置与旋转（属性面板「画面 · 位置/旋转」）。
 *
 * **位置**：把已经铺满画布的帧先垫到 2 倍画布上（居中），再按偏移量把
 * `width × height` 的窗口裁回来 —— 这样画面保持原大小、而是**在画布里平移**，
 * 四周露出底色，与预览的 `translate()`（叠在 `overflow:hidden` 的画布上）同一口径。
 * 直接改 `crop` 的起点是做不到的：`force_original_aspect_ratio=increase` 之后
 * 输入常常刚好等于画布宽，`iw-ow = 0`，往哪个方向推都是 0 像素 —— 表现为
 * "位置滑杆拖了、成片一点没动"。
 *
 * 取值范围 ±50%：垫 2 倍画布时可用于平移的余量正好是 ±半张画布。
 *
 * **旋转**：`ow/oh` 固定成画布尺寸（不放大画布），转角用底色填 ——
 * 与预览那层 `overflow:hidden` 的观感一致。
 *
 * @returns {string} 拼进滤镜链的片段（无位移无旋转时返回 ''）
 */
function poseFilter(clip, width, height, padColor) {
  const parts = []
  const px = clampNum(clip.posX, -adjust.POS_LIMIT, adjust.POS_LIMIT)
  const py = clampNum(clip.posY, -adjust.POS_LIMIT, adjust.POS_LIMIT)
  if (Math.abs(px) > 0.01 || Math.abs(py) > 0.01) {
    const dx = (px / 100) * width
    const dy = (py / 100) * height
    parts.push(`pad=${width * 2}:${height * 2}:${width / 2}:${height / 2}:color=${padColor}`)
    parts.push(`crop=${width}:${height}:${round(width / 2 - dx, 1)}:${round(height / 2 - dy, 1)}`)
  }
  const rot = clampNum(clip.rotate, -adjust.ROTATE_LIMIT, adjust.ROTATE_LIMIT)
  if (Math.abs(rot) > 0.01) {
    parts.push(`rotate=a=${round((rot * Math.PI) / 180, 5)}:ow=${width}:oh=${height}:c=${padColor}`)
  }
  return parts.join(',')
}

/**
 * 片段级淡入 / 淡出（秒）。
 *
 * ⚠️ `st` 是**相对裁剪后**的时间轴（前面已经有 asetpts=PTS-STARTPTS），
 *    所以淡出要落在 `dur - fadeOut` 而不是源素材的时间上。
 *    写错的话淡出会跑到片段之外，表现是"设了淡出、成片里没有淡出"。
 *
 * @returns {string} 前导逗号的滤镜片段（无淡入淡出时返回 ''）
 */
function fadePartFor(clip, dur) {
  const parts = []
  const fin = clampNum(clip.fadeIn, 0, Math.max(0, dur))
  const fout = clampNum(clip.fadeOut, 0, Math.max(0, dur))
  if (fin > 0.01) parts.push(`afade=t=in:st=0:d=${round(fin, 3)}`)
  if (fout > 0.01) parts.push(`afade=t=out:st=${round(Math.max(0, dur - fout), 3)}:d=${round(fout, 3)}`)
  return parts.length ? ',' + parts.join(',') : ''
}

/* ------------------------------- 曲线变速（导出侧分段） ------------------------------- */

/**
 * 曲线变速在 ffmpeg 里只能"切成若干常速段再拼回来"。
 *
 * 为什么不能像常速那样一句 `setpts` 解决：`setpts` 能吃时间表达式，但音频侧的
 * `atempo` 只接受常量速率（它没有"逐帧变速率"的用法）。画面按表达式变速、
 * 音频按平均速率变速 ⇒ 声音会**越播越对不上画面**，而这种错在静音检查时完全看不见。
 * 切成段之后，每段一个 setpts + 一个 atempo，两边逐段对齐，误差只剩段内曲线形状的量化。
 *
 * 段数由 `speed.curveSegments` 合并到 ≤12 段，且**总面积与总时长仍然精确**
 * （合并只把同向的多段并成常数速率），所以片段总长不会漂。
 *
 * @returns {string|null} 可以当作视频流标签用的 `[cvokN]`；不需要分段时返回 null
 */
function curveVideoChain({ filters, idx, tag, clip, offset, dur, pre = '' }) {
  if (clip && clip.reverse === true) return null
  const points = speed.readCurve(clip)
  if (!points) return null
  const segs = speed.curveSegments(points, dur, 12)
  if (segs.length < 2) return null
  const labels = []
  segs.forEach((seg, k) => {
    if (!(seg.srcLen > 0.001) || !(seg.dur > 0.001)) return
    const label = `cvs${tag}_${k}`
    /* ⚠️ `(PTS-STARTPTS)/speed` 是**一条**表达式：先归零再除。
       拆成两句 `setpts=PTS-STARTPTS,setpts=PTS/x` 也等价，但多一次滤镜遍历；
       而写成 `setpts=PTS/x`（忘了减 STARTPTS）会让第二段起的时间戳
       从上一段的末尾接着走，concat 之后整条时间线越拼越长。 */
    filters.push(
      `[${idx}:v]${pre}trim=start=${round(offset + seg.srcStart)}:duration=${round(seg.srcLen)},` +
        `${speed.setptsExpr(seg.speed, round)}[${label}]`
    )
    labels.push(`[${label}]`)
  })
  if (labels.length < 2) return null
  const out = `cvok${tag}`
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[${out}]`)
  return `[${out}]`
}

/**
 * 曲线变速的音频侧：同样分段，每段 `atrim → asetpts → atempo`（或 asetrate），然后 concat。
 *
 * ⚠️ 每段都要带 `aformat`：concat 要求各路采样格式/采样率/声道布局**完全一致**，
 *    少一路就会以"Input link parameters do not match"失败 ——
 *    报错里既没有段号也没有时间，很难看出是分段拼出来的。
 *
 * @returns {string|null} 可以当作音频流标签用的 `[caokN]`；不需要分段时返回 null
 */
function curveAudioChain({ filters, idx, tag, clip, offset, dur, keepPitch }) {
  if (clip && clip.reverse === true) return null
  const points = speed.readCurve(clip)
  if (!points) return null
  const segs = speed.curveSegments(points, dur, 12)
  if (segs.length < 2) return null
  const labels = []
  segs.forEach((seg, k) => {
    if (!(seg.srcLen > 0.001) || !(seg.dur > 0.001)) return
    const label = `cas${tag}_${k}`
    filters.push(
      `[${idx}:a]atrim=start=${round(offset + seg.srcStart)}:duration=${round(seg.srcLen)},asetpts=PTS-STARTPTS` +
        speed.pitchChain(seg.speed, keepPitch, round) +
        `,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`
    )
    labels.push(`[${label}]`)
  })
  if (labels.length < 2) return null
  const out = `caok${tag}`
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[${out}]`)
  return `[${out}]`
}



/**
 * 圆角 / 蒙版遮罩 PNG 的磁盘缓存目录。
 *
 * 遮罩是**不依赖素材内容**的（表达式只用 X/Y/W/H），所以同一种遮罩在一次导出里
 * 只需要生成一次，之后每帧只是一次 `alphamerge`（几乎不花钱）。
 * 直接用 `geq` 逐帧算的话，1080p 每帧两百万次表达式求值，导出会慢到没法用。
 */
const MASK_DIR = () => path.join(os.tmpdir(), 'yjai-masks')

/**
 * 遮罩 PNG 的**缓存格式版本**。改了这些图的生成方式就把它 +1。
 *
 * ⚠️ 缓存落在 `%TEMP%`、跨版本存活。没有版本号时，"表达式改了、代码也重装了，
 *    但临时目录里那张旧图还在" ⇒ 修复看起来完全没生效（本次调试就被骗过一次：
 *    虚线的优先级 bug 已改好，成片仍是旧的全亮框）。
 *    版本进键就再也没有这个问题：新键 = 新文件。
 */
const MASK_VERSION = 'v2'

/** 遮罩 PNG 的缓存键 = 尺寸 + 表达式 + 羽化（内容相同即复用） */
function maskKey(width, height, expr, feather) {
  return `${MASK_VERSION}|mask|${width}x${height}|${Math.round(feather)}|${expr}`
}

/**
 * 生成一张遮罩 PNG（白 = 保留、黑 = 抠掉），已存在则直接复用。
 *
 * ⚠️ 失败时返回 ''（调用方退回"不做遮罩"并给一条 warning）——
 *    这里绝不能让导出整体失败：遮罩只是画面效果，不该把整片拖没。
 */
async function writeMaskPng(bin, key, expr, width, height, feather) {
  const dir = MASK_DIR()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return ''
  }
  const file = path.join(dir, `${Buffer.from(key).toString('base64url').slice(0, 48)}.png`)
  if (fs.existsSync(file)) return file
  const vf =
    `format=gray,geq=lum='${expr}'` + (feather > 0.01 ? `,gblur=sigma=${round(feather, 3)}` : '')
  const result = await run(
    bin,
    ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}`, '-vf', vf, '-frames:v', '1', file],
    { timeout: 30000 }
  )
  return result.ok && fs.existsSync(file) ? file : ''
}

/**
 * 一次导出开始前，把所有**主画面**要用的遮罩 PNG 先备好（异步）。
 *
 * ⚠️ 必须在 buildPlan **之前**做：buildPlan 是同步的，而生成图要等 ffmpeg 跑完。
 *    把它塞进 buildPlan 只能靠 spawnSync —— 本机那条路走不通（管道恒 EBUSY）。
 *
 * 画中画**不走这里**：它的高度由素材比例决定，构建命令时算不出来，
 * 所以画中画的遮罩在链上直接按运行时尺寸 `geq` 求值（见 effectsStages 的说明）。
 */
/** 自由变形有效区遮罩的缓存键（尺寸 + 透视参数） */
const warpMaskKey = (width, height, perspective) => `${MASK_VERSION}|warp|${width}x${height}|${perspective}`
/** 虚线框图的缓存键（颜色也进键：同一几何不同颜色是两张图） */
const dashKey = (width, height, expr, color) => `${MASK_VERSION}|dash|${width}x${height}|${color}|${expr}`
/**
 * 内阴影距离场的缓存键（尺寸 + 全部像素级参数 + 颜色）。
 * ⚠️ 颜色必须进键：颜色已经烘进 PNG 了，同一个几何换颜色就是另一张图，
 *    不换键会拿到上一次的旧颜色（改了色号、成片不变 —— 又是一次静默失效）。
 */
const innerShadowKey = (width, height, spec, color) =>
  `${MASK_VERSION}|inner|${width}x${height}|${spec.spreadPx}|${spec.blurPx}|${spec.dx}|${spec.dy}|${spec.opacity}|${color}`

/** 统一的 PNG 落盘路径（键 → 文件名，同一份键复用同一张图） */
function pngPathOf(key) {
  const dir = MASK_DIR()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return ''
  }
  return path.join(dir, `${Buffer.from(key).toString('base64url').slice(0, 48)}.png`)
}

/**
 * 生成「自由变形的有效区遮罩」PNG：白底 + 几像素黑边 → **同一个 perspective** → 灰度图。
 *
 * ⚠️ 为什么不是纯白：`perspective` 对目标框外的像素用**边缘 clamp**（把边缘那一列
 *    拉伸出去），纯白图变换后连框外也是白 —— 补出来的 alpha 还是 255，等于没补。
 *    给一圈黑边，clamp 取到的就是黑，框外才是 0。
 * ⚠️ 这张图与画面**必须用同一个 perspective 串**（含同一组像素坐标），
 *    否则遮罩与画面对不齐，边缘会露出一条细缝或者啃掉一圈画面。
 */
async function writeWarpMaskPng(bin, key, perspective, width, height) {
  const file = pngPathOf(key)
  if (!file) return ''
  if (fs.existsSync(file)) return file
  const border = warpTable.WARP_MASK_BORDER
  const vf = `drawbox=x=0:y=0:w=${width}:h=${height}:c=black:t=${border},${perspective},format=gray`
  const result = await run(
    bin,
    ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=white:s=${width}x${height}`,
      '-vf', vf, '-frames:v', '1', file],
    { timeout: 30000 }
  )
  return result.ok && fs.existsSync(file) ? file : ''
}

/**
 * 生成「虚线框」PNG（RGBA，颜色已染好）。
 *
 * geq 直接写 `a=` 通道：一张图就同时带几何与颜色，链上只剩一次 `overlay`。
 * 先灰度再在链上染色是行不通的 —— 那样每次导出都要多 split 一次，
 * 而这张图本来就是与画面内容无关的常量。
 */
async function writeDashPng(bin, key, expr, color, width, height) {
  const file = pngPathOf(key)
  if (!file) return ''
  if (fs.existsSync(file)) return file
  const c = effects.readHexColor(color, '#ffffff')
  const vf = `format=rgba,geq=r=${c.r}:g=${c.g}:b=${c.b}:a='${expr}'`
  const result = await run(
    bin,
    ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}`,
      '-vf', vf, '-frames:v', '1', file],
    { timeout: 30000 }
  )
  return result.ok && fs.existsSync(file) ? file : ''
}

/**
 * 生成「内阴影距离场」PNG（**RGBA：颜色与 alpha 都已烘好**）。
 *
 * 为什么是"距离场"而不是从画面的 alpha 推：见 effectsStages 里内阴影那一段的说明
 * —— 形态学在"画面铺满画布"时完全失效，而铺满恰恰是最常见的情况。
 *
 * 为什么把颜色烘进 PNG（而不是链上 `lutrgb` + `alphamerge`）：
 * 实测本机这套 ffmpeg 里 `alphamerge` 接在 `format=rgba,lutrgb` 之后**不出效果**
 * （补出来的 alpha 恒 0，叠上去整层透明）—— 而虚线框那条"geq 直接写 a 通道 +
 * overlay"的路是验证可用的。同一件事只用一种写法，少一个会静默失效的环节。
 */
async function writeInnerShadowPng(bin, key, spec, color) {
  const file = pngPathOf(key)
  if (!file) return ''
  if (fs.existsSync(file)) return file
  const expr = effects.innerShadowExpr(spec)
  if (!expr) return ''
  const c = effects.readHexColor(color, '#000000')
  const result = await run(
    bin,
    ['-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=black:s=${spec.width}x${spec.height}`,
      '-vf', `format=rgba,geq=r=${c.r}:g=${c.g}:b=${c.b}:a='${expr}'`, '-frames:v', '1', file],
    { timeout: 30000 }
  )
  return result.ok && fs.existsSync(file) ? file : ''
}

/**
 * 一次导出开始前，把所有**主画面**要用的 PNG 先备好（异步）。
 *
 * 三类图共用一张表（键带前缀区分）：
 *   · `maskKey`     圆角 / 蒙版的遮罩；
 *   · `warpMaskKey` 自由变形的有效区（白底黑边走同一个 perspective）；
 *   · `dashKey`     虚线框（几何 + 颜色都已烘进图里）。
 *
 * ⚠️ 必须在 buildPlan **之前**做：buildPlan 是同步的，而生成图要等 ffmpeg 跑完。
 *    把它塞进 buildPlan 只能靠 spawnSync —— 本机那条路走不通（管道恒 EBUSY）。
 *
 * 画中画**不走这里**：它的高度由素材比例决定，构建命令时算不出来。
 * 所以画中画的圆角/蒙版在链上按运行时尺寸 `geq` 求值；
 * 而画中画的**自由变形与虚线框**这一轮不做（右栏也不给画中画开这两个入口）——
 * 宁可"没有这个控件"，也不要"控件在、成片里没有"。
 */
async function prepareEffectMasks(bin, clips, options) {
  const map = new Map()
  if (!bin) return map
  const baseW = Math.max(2, Math.round(num(options && options.width, 1920) / 2) * 2)
  const baseH = Math.max(2, Math.round(num(options && options.height, 1080) / 2) * 2)
  const { width, height } = aspect.outputSizeFor(baseW, baseH, options && options.aspect)
  const seen = new Set()
  for (const clip of Array.isArray(clips) ? clips : []) {
    if (clip.track === 'overlay') continue
    const fx = effects.readEffects(clip.effects)
    const expr = effects.maskExprFor(fx)
    if (expr) {
      const key = maskKey(width, height, expr, fx.mask.feather)
      if (!seen.has(key)) {
        seen.add(key)
        const file = await writeMaskPng(bin, key, expr, width, height, fx.mask.feather)
        if (file) map.set(key, file)
      }
    }
    if (effects.hasWarp(fx)) {
      const perspective = warpTable.perspectiveFilter(fx.warp, width, height, round)
      if (perspective) {
        const key = warpMaskKey(width, height, perspective)
        if (!seen.has(key)) {
          seen.add(key)
          const file = await writeWarpMaskPng(bin, key, perspective, width, height)
          if (file) map.set(key, file)
        }
      }
    }
    const dashExpr = effects.dashedBoxExpr(fx, width, height, round)
    if (dashExpr) {
      const key = dashKey(width, height, dashExpr, fx.stroke.color)
      if (!seen.has(key)) {
        seen.add(key)
        const file = await writeDashPng(bin, key, dashExpr, fx.stroke.color, width, height)
        if (file) map.set(key, file)
      }
    }
    const innerSpec = effects.innerShadowSpec(fx, width, height)
    if (innerSpec) {
      const innerColor = fx.shadow.color
      const key = innerShadowKey(width, height, innerSpec, innerColor)
      if (!seen.has(key)) {
        seen.add(key)
        const file = await writeInnerShadowPng(bin, key, innerSpec, innerColor)
        if (file) map.set(key, file)
      }
    }
  }
  return map
}

/**
 * 把「效果」落到一条**已经成帧**的流上。
 *
 * 顺序（与预览侧 Stage.jsx 的 effectFilterParts 同一口径）：
 *   自由变形 → 抠像 → 圆角/蒙版 → 描边 → 内阴影 → 外阴影 → 虚线框
 *
 * ⚠️ 自由变形必须**最先**：它改变的是"画面落在哪儿"，后面所有按像素算的效果
 *    （描边宽度、蒙版几何、阴影偏移）都应该以变形后的画面为准。
 *    排在后面会得到"描边跟着原矩形走、画面已经变成梯形"。
 * ⚠️ 圆角/蒙版与描边/阴影的顺序不能反：描边是从**最终 alpha** 推出来的，
 *    先描边再裁形状的话，被裁掉的那部分描边就"描了个寂寞"。
 * ⚠️ 抠像与蒙版都是 alpha 的乘法关系，先后不影响结果。
 * ⚠️ 内阴影必须在描边**之后**：它要从"含描边的最终 alpha"往里收，
 *    否则描边内侧会多出一圈内阴影的暗边。
 *
 * @param {string} label    输入流标签（不含方括号）
 * @param {string} maskFile 主画面的遮罩 PNG 路径（画中画传空串 → 走运行时 geq）
 * @param {function} addMaskInput 把一张 PNG 加成一个 ffmpeg 输入、返回它的序号
 * @param {Map} maskMap     预生成的 PNG 表（键见 maskKey / warpKey / dashKey）
 * @param {string} pixFmt   这一段的统一像素格式（末尾要把链路归一回去）
 * @returns {{lines: string[], label: string}} 追加的滤镜行 + 新标签
 */
function effectsStages({
  tag,
  label,
  clip,
  width,
  height,
  maskFile,
  maskMap,
  addMaskInput,
  pixFmt = 'yuv420p'
}) {
  const fx = effects.readEffects(clip.effects)
  const lines = []
  if (effects.isNeutralEffects(fx)) return { lines, label }
  let cur = label
  const next = (suffix) => `${suffix}${tag}`

  /* --- 自由变形（四角透视） --- */
  /**
   * ⚠️ 这一段是"必须两张图"的活：
   *    `perspective` 变换后**alpha 全丢**（源四角内缩出来的框外是不透明黑），
   *    所以还要一张「白底黑边」的图走同一个 perspective 得到有效区遮罩，
   *    再用 `alphamerge` 把 alpha 灌回去。少这一步，成片里变形后的画面外
   *    会是一整片黑，把下层画面/背景整个盖住 —— 而预览里是透的。
   */
  const warpFilter = effects.hasWarp(fx)
    ? warpTable.perspectiveFilter(fx.warp, width || 1920, height || 1080, round)
    : ''
  if (warpFilter) {
    const wKey = warpMaskKey(width || 1920, height || 1080, warpFilter)
    const wFile = maskMap && maskMap.get(wKey)
    if (wFile && addMaskInput) {
      const wIdx = addMaskInput(wFile)
      lines.push(`[${cur}]${warpFilter},format=rgba[${next('wpp')}]`)
      lines.push(`[${wIdx}:v]format=gray[${next('wpm')}]`)
      lines.push(`[${next('wpp')}][${next('wpm')}]alphamerge[${next('wpa')}]`)
      cur = next('wpa')
    }
    /* 图没备好（生成失败 / 画中画）时**不做变形**：宁可退回原矩形，
       也不要给出一张框外全黑的画面 —— 前者是"没生效"，后者是"坏了"。 */
  }

  /* --- 抠像：在 RGB 空间判定（与预览的 feColorMatrix 同一空间） --- */
  const key = effects.colorkeyFor(fx)
  if (key) {
    lines.push(`[${cur}]${key}[${next('fxk')}]`)
    cur = next('fxk')
  }

  /* --- 圆角 / 蒙版：生成一张遮罩，把它的亮度灌进 alpha --- */
  const expr = effects.maskExprFor(fx)
  if (expr) {
    const key2 = maskKey(width || 1920, height || 1080, expr, fx.mask.feather)
    const file = maskFile || (maskMap && maskMap.get(key2))
    if (file && addMaskInput) {
      // 主画面：遮罩图当输入（尺寸已知、每帧只做一次 alphamerge）
      const idx = addMaskInput(file)
      lines.push(`[${idx}:v]format=gray[${next('fxm')}]`)
      lines.push(`[${cur}][${next('fxm')}]alphamerge[${next('fxam')}]`)
    } else {
      // 画中画（或遮罩图生成失败）：按**运行时尺寸**求值 —— geq 的 W/H 就是这一帧的真实尺寸
      lines.push(`[${cur}]split=2[${next('fxb')}][${next('fxc')}]`)
      lines.push(`[${next('fxc')}]format=gray,geq=lum='${expr}',format=gray[${next('fxm')}]`)
      lines.push(`[${next('fxb')}][${next('fxm')}]alphamerge[${next('fxam')}]`)
    }
    cur = next('fxam')
  }

  /* --- 描边：把 alpha 膨胀 N 像素、减去原 alpha 得到一圈环，再染色叠回去 --- */
  /**
   * 每一层环各走一遍「膨胀 → 减原 alpha → 染色」，最后按底→顶顺序叠回画面。
   *
   * ⚠️ **所有环都必须从同一份原始 alpha 推出来**，不能"环 2 接在环 1 的结果上"。
   *    实测过的错误版本：环 2 的输入是 `[csf0]`（已经含环 1 的画面），
   *    于是环 2 的膨胀是从"环 1 的外沿"往外长的 —— 双线描边会在外侧多出一道
   *    颜色不对的边（本该在内侧），而 ffmpeg 一行错都不报。正确做法是先
   *    `alphaextract` 一次、`split` 成 N 份，各层独立膨胀：环 2 天然是环 1 的子集，
   *    叠上去正好是内侧那道细线。
   * ⚠️ 中间标签必须带层号：两层用同一套标签的话，后面的 `overlay` 会连到
   *    前一层残留的流上 —— ffmpeg 通常直接报"找不到标签"，但也可能静默接错。
   */
  const strokeRings = effects.strokeLayers(fx, width)
  if (strokeRings.length) {
    const alphaTags = strokeRings.map((_, i) => next(`csa${i}`))
    lines.push(
      `[${cur}]alphaextract,format=gray,split=${strokeRings.length}${alphaTags.map((t) => `[${t}]`).join('')}`
    )
    strokeRings.forEach((ring, index) => {
      const t = String(index)
      const dil = 'dilation,'.repeat(ring.dilations).slice(0, -1)
      const blurPart = ring.blur > 0 ? `,gblur=sigma=${round(ring.blur, 3)}` : ''
      lines.push(`[${alphaTags[index]}]split=2[${next(`csd${t}`)}][${next(`cso${t}`)}]`)
      lines.push(`[${next(`csd${t}`)}]${dil}${blurPart}[${next(`cse${t}`)}]`)
      lines.push(
        `[${next(`cse${t}`)}][${next(`cso${t}`)}]blend=all_mode=subtract[${next(`csx${t}`)}]`
      )
      lines.push(`[${next(`csx${t}`)}]format=rgba,split=2[${next(`csc${t}`)}][${next(`csm${t}`)}]`)
      lines.push(`[${next(`csc${t}`)}]lutrgb=${effects.strokeLut(fx, round, ring.color)}[${next(`csq${t}`)}]`)
      lines.push(`[${next(`csq${t}`)}][${next(`csm${t}`)}]alphamerge[${next(`csr${t}`)}]`)
    })
    strokeRings.forEach((_, index) => {
      const t = String(index)
      lines.push(`[${cur}][${next(`csr${t}`)}]overlay=0:0[${next(`csf${t}`)}]`)
      cur = next(`csf${t}`)
    })
  }

  /* --- 外阴影：黑色剪影 → 高斯模糊 → 按偏移垫出去 → 压在原画面下面 --- */
  const sigma = effects.shadowSigma(fx, width)
  if (sigma > 0) {
    const off = effects.shadowOffset(fx, width)
    /* 垫出去的余量：偏移量 + 模糊半径的两倍 + 保险值。用 pad 的表达式形式
       （`iw+2P`）而不是写死像素 —— 画中画的高度是运行时才知道的。 */
    const margin = Math.max(4, Math.ceil(Math.abs(off.x)), Math.ceil(Math.abs(off.y)), Math.ceil(sigma * 2)) + 4
    lines.push(`[${cur}]split=2[${next('shb')}][${next('shs')}]`)
    lines.push(
      `[${next('shs')}]lutrgb=r=0:g=0:b=0,gblur=sigma=${round(sigma, 3)},` +
        `pad=iw+${2 * margin}:ih+${2 * margin}:${margin + off.x}:${margin + off.y}:color=black@0,` +
        `crop=iw-${2 * margin}:ih-${2 * margin}:${margin}:${margin}[${next('shc')}]`
    )
    lines.push(`[${next('shc')}][${next('shb')}]overlay=0:0:format=auto[${next('shf')}]`)
    cur = next('shf')
  }

  /* --- 内阴影：沿画框四边往里散开的暗边，压在画面上面 --- */
  /**
   * 为什么走「预生成距离场 PNG」而不是 alpha 形态学：
   *   试过 `erosion` 与「取反 → dilation → 取反」两条路，都在**铺满画布**的素材上
   *   失效 —— 形态学滤镜在画面边界按"沿用边缘像素"处理，alpha 全 255 时
   *   腐蚀不出任何东西（实测 20 级腐蚀后仍全 255，内环整片 0）。
   *   而"画面铺满画布"恰恰是最常见的情况，所以那条路只能放弃。
   *
   * 现在这条路：一张按尺寸/参数预生成的 **RGBA** 图（`geq` 距离场 + 落差曲线 +
   * 已烘好的颜色，见 writeInnerShadowPng），链上只需一次 `overlay`。
   * 完全确定、可缓存、可单测，而且与预览的 `box-shadow: inset` 是同一个几何。
   *
   * ⚠️ 链上**不做** `gblur`：落差曲线已经算进 PNG 了。实测再叠一层 σ≈13 的模糊，
   *    会把 20px 的带子平均到几乎看不见（角上只剩 3/255）—— 这正是上一版
   *    "内阴影像是没生效"的真正原因。
   * ⚠️ 链上**也不做** `lutrgb` 染色 + `alphamerge`：颜色与 alpha 都在 PNG 里了。
   *    实测本机这套 ffmpeg 上 `alphamerge` 接在 `format=rgba,lutrgb` 之后不出效果
   *    （补出来的 alpha 恒 0），多这一步只会多一个静默失效点。
   *
   * ⚠️ 与预览一致的边界：内阴影沿**画框矩形**，不跟随蒙版形状，也不跟随圆角
   *    （预览那一层是直角的）。这条如实写在界面上，不假装"沿轮廓"。
   */
  if (effects.hasInnerShadow(fx)) {
    const s = effects.innerShadowSpec(fx, width, height || 1080)
    if (s) {
      const iKey = innerShadowKey(s.width, s.height, s, fx.shadow.color)
      const iFile = maskMap && maskMap.get(iKey)
      if (iFile && addMaskInput) {
        const iIdx = addMaskInput(iFile)
        /* ⚠️ 顺序：**画面在下、阴影在上**。写成 `[阴影][画面]overlay` 时，
           画面（alpha 全 255）会把阴影整层盖掉 —— 命令不报错、成片里一点变化都没有。
           这是"效果接对了但看不见"最典型的一种。 */
        lines.push(`[${iIdx}:v]format=rgba[${next('ism')}]`)
        lines.push(`[${cur}][${next('ism')}]overlay=0:0[${next('isf')}]`)
        cur = next('isf')
      }
    }
  }

  /* --- 虚线框：一张按画框尺寸预生成的虚线 PNG，直接叠上去 --- */
  const dashExpr = effects.dashedBoxExpr(fx, width, height || 1080, round)
  if (dashExpr) {
    const dKey = dashKey(width || 1920, height || 1080, dashExpr, fx.stroke.color)
    const dFile = maskMap && maskMap.get(dKey)
    if (dFile && addMaskInput) {
      const dIdx = addMaskInput(dFile)
      lines.push(`[${cur}][${dIdx}:v]overlay=0:0[${next('dsh')}]`)
      cur = next('dsh')
    }
  }

  /**
   * 链路归一：上面的每个环节都可能中途换过像素格式（`alphamerge` 出 yuva、
   * 描边段出 rgba、`overlay` 出 auto），而下面要和其它片段 `concat`/`xfade` ——
   * 混着格式的输入会被 ffmpeg 直接判为"输入参数不一致"。
   * 这一步把所有分支重新钉回 `pixFmt`，也让"带不带 alpha"这件事只有一个出口。
   */
  const out = next('fxo')
  lines.push(`[${cur}]format=${pixFmt},setsar=1[${out}]`)
  return { lines, label: out }
}

/** `yjai-media://local/<base64url>` 还原成磁盘路径；主进程里也这么解 */
function pathFromMediaUrl(url) {  const match = /^yjai-media:\/\/local\/([A-Za-z0-9_-]+)$/.exec(String(url || ''))
  if (!match) return ''
  try {
    return Buffer.from(match[1], 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/** 片段 → ffmpeg 能吃的输入源。本地文件优先，其次是 http(s) 直连 */
function sourceOf(clip) {
  if (clip.path && fs.existsSync(clip.path)) return { kind: 'file', value: clip.path }
  const fromUrl = pathFromMediaUrl(clip.url)
  if (fromUrl && fs.existsSync(fromUrl)) return { kind: 'file', value: fromUrl }
  if (/^https?:\/\//i.test(String(clip.url || ''))) return { kind: 'url', value: clip.url }
  return null
}

/**
 * 构造一次渲染要用的 ffmpeg 参数与总时长。
 *
 * @param {object} input
 * @param {Array}  input.clips        时间线片段（含 track/start/duration，可选 offset/path/url）
 * @param {Array}  input.probes       与 clips 中的视频片段一一对应的 { hasAudio }（可为空）
 * @param {string} input.outPath      输出 mp4 路径
 * @param {object} input.options      { width, height, fps, quality }
 * @param {boolean} input.assumeVideoAudio  拿不到 ffprobe 时的假设
 * @returns {{ args: string[], duration: number, segmentCount: number }}
 */
/**
 * 把渲染层给的背景地址换成 ffmpeg 能吃的东西。
 *
 * 背景是渲染层 import 进来的一张内置图：
 *  - 开发态是 `http://localhost:5173/assets/xxx.png`，ffmpeg 直接能拉；
 *  - 打包后是 `file:///…/app.asar/packages/desktop/dist-renderer/assets/xxx.png`。
 *
 * ⚠️ asar 那一种是**读不了的**：asar 在磁盘上是一个整包文件，Electron 的 fs 能进包里读条目，
 *   但 ffmpeg 是个独立进程、只认真实路径，给它包内路径会直接 `No such file or directory`。
 *   所以这里要把包内的图**先落到临时目录**再交给 ffmpeg —— 少了这一步，
 *   "选了背景"就只在预览里有效、导出成片里完全不存在（不报错，成片照出）。
 *
 * @returns 可直接喂给 ffmpeg 的路径或 URL；拿不到就返回 ''（调用方按"无背景"处理）
 */
function backdropToLocal(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw

  let diskPath = raw
  if (/^file:\/\//i.test(raw)) {
    diskPath = raw.replace(/^file:\/\/\/?/i, '')
    try {
      diskPath = decodeURIComponent(diskPath)
    } catch {
      /* 不是合法百分号编码就按原样用 */
    }
    diskPath = diskPath.replace(/^([a-zA-Z]):\//, '$1:/')
  }
  if (!diskPath) return ''

  if (!/\.asar[\\/]/i.test(diskPath)) return diskPath

  // 包内条目 → 先由主进程读出来（fs 能进 asar）、再写一份到临时目录
  try {
    const buf = fs.readFileSync(diskPath)
    if (!buf || !buf.length) return ''
    const ext = path.extname(diskPath) || '.png'
    const staged = path.join(os.tmpdir(), `yjai-backdrop-${process.pid}${ext}`)
    fs.writeFileSync(staged, buf)
    return staged
  } catch {
    return ''
  }
}

function buildPlan({
  clips,
  streamInfo,
  outPath,
  options,
  assumeVideoAudio = true,
  backdrop = '',
  ffmpegPath = '',
  effectMasks = null
}) {
  /* 成片尺寸 = 基准分辨率里裁出「当前画面比例」的最大内接矩形。
     ⚠️ 裁而不是"照基准输出"：素材链上每一处 scale/pad 都按这两个数算，
        尺寸本身就是裁好的，链上所有环节自然跟着对。
     ⚠️ 与预览同一口径（预览是 object-fit: cover），否则"预览裁了、成片留黑边"，
        而两边单独看都没错 —— 比例表与裁切算法都在 shared/aspect.js，不许各写一份。 */
  const baseW = Math.max(2, Math.round(num(options.width, 1920) / 2) * 2)
  const baseH = Math.max(2, Math.round(num(options.height, 1080) / 2) * 2)
  const { width, height } = aspect.outputSizeFor(baseW, baseH, options.aspect)
  const fps = Math.min(60, Math.max(12, Math.round(num(options.fps, 30))))
  const quality = Math.min(100, Math.max(10, Math.round(num(options.quality, 80))))
  const crf = Math.min(34, Math.max(16, Math.round(34 - (quality - 30) * 0.2)))

  const info = streamInfo || {}
  const list = (Array.isArray(clips) ? clips : []).filter((clip) => num(clip.duration) > 0.01)

  const videoClips = list
    .filter((clip) => clip.track !== 'audio' && clip.track !== 'text' && clip.track !== 'overlay')
    .sort((a, b) => num(a.start) - num(b.start))
  /**
   * 叠加轨（画中画）：不进主链，而是整段 overlay 在主画面之上。
   * 它**参与**成片时长：画中画比主画面长时，成片要跟着延长，
   * 否则"画中画的后半截被硬切掉"，而界面上一点提示都没有。
   *
   * ⚠️ 排序按 `shared/layers.js`（先 z 再起点再序号），不是纯按起点：
   *    两段画中画完全重叠时，唯一能决定谁压住谁的就是 z。按起点排会让
   *    "上移一层"在成片里完全没效果 —— 而预览里动了（预览走同一个比较函数），
   *    于是出现"预览与成片互相矛盾"。
   */
  const overlayClips = list
    .filter((clip) => clip.track === 'overlay')
    .sort(layers.compareLayers)
  const audioClips = list
    .filter((clip) => clip.track === 'audio')
    .sort((a, b) => num(a.start) - num(b.start))

  /**
   * 叠加轨结算后的终点（画中画可能比主画面长，成片要跟着延长）。
   * ⚠️ 声明必须在这里：`finalDuration` 在下面要用它，而赋值发生在更后面的
   *    overlay 循环里 —— `let` 有 TDZ，写在赋值处会抛
   *    "Cannot access 'overlayRenderedEnd' before initialization"。
   */
  let overlayRenderedEnd = 0

  /**
   * 片段级不透明度：只要有一段是半透明的，整条链就必须带 alpha，否则透不出背景。
   *
   * ⚠️ 会产生 alpha 的**不只是不透明度**：抠像 / 圆角 / 蒙版 / 描边 / 阴影 都会往
   *    alpha 通道里写值。少了这几类的判定 ⇒ pixFmt 落回 `yuv420p`、alpha 被整体丢掉，
   *    表现是"预览里抠了像、成片里绿底还在"——而 ffmpeg 一行错都不报。
   */
  /**
   * 片段级不透明度：只要有一段是半透明的，整条链就必须带 alpha，否则透不出背景。
   *
   * ⚠️ 会产生 alpha 的**不只是不透明度**：抠像 / 圆角 / 蒙版 / 描边 / 阴影 / 自由变形
   *    都会往 alpha 通道里写值。少了这几类的判定 ⇒ pixFmt 落回 `yuv420p`、alpha 被整体丢掉，
   *    表现是"预览里抠了像、成片里绿底还在"，"预览里变形后四周是透的、成片里是一圈拉长的边缘像素"
   *    —— 而 ffmpeg 一行错都不报。
   * ⚠️ 自由变形尤其容易漏：它的 alpha 由 `alphamerge` **补出来**，如果链路是
   *    `yuv420p`，`perspective` 框外那些"边缘 clamp"像素会被原样留下、还变成不透明，
   *    看上去就像"变形没生效，只是画面被拉歪了"。
   */
  const anyTransparent = [...videoClips, ...overlayClips].some((clip) => {
    if (num(clip.opacity, 100) < 99.5) return true
    const fx = effects.readEffects(clip.effects)
    if (!fx) return false
    return (
      effects.hasClip(fx) ||
      Boolean(fx.key.on) ||
      Boolean(fx.stroke.on) ||
      Boolean(fx.shadow.on) ||
      effects.hasWarp(fx)
    )
  })

  const videoEnd = videoClips.reduce((max, clip) => Math.max(max, num(clip.start) + num(clip.duration)), 0)
  const audioEnd = audioClips.reduce((max, clip) => Math.max(max, num(clip.start) + num(clip.duration)), 0)
  const overlayEnd = overlayClips.reduce((max, clip) => Math.max(max, num(clip.start) + num(clip.duration)), 0)
  const duration = Math.max(videoEnd, audioEnd, overlayEnd, 0)
  if (duration <= 0.05) {
    return { error: '时间线上还没有可渲染的片段', args: [], duration: 0, segmentCount: 0 }
  }

  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1']
  const filters = []
  const segments = []
  let inputIndex = 0

  /**
   * 把一张遮罩 PNG 追加成一个 ffmpeg 输入、返回它的**输入序号**。
   *
   * ⚠️ 序号必须与 `-i` 的 push 顺序严格一致 —— 这里和片段/背景/音轨共用同一个
   *    `inputIndex`，谁先 push 谁拿号，天然对得上；单独开一个计数器就会错位。
   * ⚠️ 只能在这里 push（`-filter_complex` 之前），事后补 `-i` 不会生效。
   */
  const addMaskInput = (file) => {
    args.push('-i', file)
    return inputIndex++
  }

  /**
   * 背景（素材 → 背景选的那张图）。
   *
   * 有背景时整条视频链要切成**带 alpha**：素材按原始比例居中、四周用
   * `black@0.0`（透明）补齐，最后 overlay 到铺满画布的背景上 ——
   * 这才是预览里看到的"素材小的时候四周露出背景"。
   * 用不透明的 black 去 pad，画面会把背景整个盖住，等于白接。
   */
  const backdropSource = backdropToLocal(backdrop)
  const withBackdrop = Boolean(backdropSource)
  /** 需要 alpha 的两种情形：有背景（素材四周要透出背景）、或任一片段半透明 */
  const needAlpha = withBackdrop || anyTransparent
  const padColor = needAlpha ? 'black@0.0' : 'black'
  const pixFmt = needAlpha ? 'yuva420p' : 'yuv420p'

  /** 空档：用 lavfi 现造一段黑场 + 静音（有背景时黑场也透明，让背景透出来） */
  const pushGap = (gap, tag) => {
    if (gap <= 0.02) return
    args.push('-f', 'lavfi', '-t', round(gap), '-i', `color=c=${padColor}:s=${width}x${height}:r=${fps}`)
    const vIdx = inputIndex++
    args.push('-f', 'lavfi', '-t', round(gap), '-i', 'anullsrc=r=48000:cl=stereo')
    const aIdx = inputIndex++
    filters.push(`[${vIdx}:v]format=${pixFmt},setsar=1,fps=${fps}[gv${tag}]`)
    filters.push(`[${aIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ga${tag}]`)
    segments.push({ v: `[gv${tag}]`, a: `[ga${tag}]`, len: num(gap), transitionOut: null })
  }

  /**
   * 片段顺序与起点走 looks.resolveTrack：它把转场造成的时长收缩（ripple）算进去，
   * 于是这里拼出来的时间轴与导出面板显示的成片时长是同一个数。
   * （原先是本地 for 循环按 clip.start 排；加了转场后必须共用同一份结算，
   *   否则"面板显示 18.4 秒、导出出来 17.2 秒"这种对不上账的问题没人能解释。）
   */
  const plan = looks.resolveTrack(videoClips)
  for (const seg of plan.segments) {
    if (seg.gap > 0.02) pushGap(seg.gap, segments.length)
    const clip = seg.clip
    const source = sourceOf(clip)
    if (!source) continue
    const dur = seg.duration
    const offset = Math.max(0, num(clip.offset))
    const isImage = clip.kind === 'image'

    if (isImage) {
      args.push('-loop', '1', '-t', round(dur), '-i', source.value)
    } else {
      args.push('-i', source.value)
    }
    const idx = inputIndex++
    /* tag 提前取：曲线分段要在**成帧之前**先拼出一条流（见 curveVideoChain），
       那时就必须知道"这是时间线上的第几段"来给滤镜起名字。
       这里取是安全的：Gap 的 push 在上面，之后到 push 之前不会再动 segments。 */
    const tag = segments.length
    /**
     * 素材按**裁切**填满画布（increase + crop），与预览的 `object-fit: cover` 同一口径。
     *
     * 以前是 `decrease` + `pad`（留黑边）：比例是"画布形状"，切到 1:1 时 16:9 的素材
     * 却缩成中间一条、上下两条黑边 —— 看着就像"比例没生效"，而且与预览不一致。
     *
     * ⚠️ 顺序：先铺满裁到画布，再走片段级缩放。
     *    · zoom > 1 —— 放大后再 crop 回画布（超出部分被裁，与预览的 overflow:hidden 一致）；
     *    · zoom < 1 —— 缩小后靠后面的 `pad` 居中补边（用户主动缩小，四周露出背景是对的）。
     *    pad 因此**不能删**：它不是在补比例不匹配的边，而是在补缩小后的边。
     */
    const scale = `scale=${width}:${height}:force_original_aspect_ratio=increase`
    /* ⚠️ 这里原名就叫 `crop`，与本文件顶部 require 进来的 shared/crop.js 撞名 ——
       一旦撞上，下面 `crop.ffmpegCropFor` 就会变成"调用一个字符串"，直接 TypeError。
       改名成 cropBase，语义也更准确：它只是"铺满画布"的那一刀。 */
    const cropBase = `crop=${width}:${height}`
    const pad = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`
    /**
     * 倍速：先按**源跨度**截取（`duration × speed` 秒的源素材），再用 setpts 压回
     * 时间线上的 `dur` 秒。
     *
     * ⚠️ 顺序不能反：先 setpts 再 trim，trim 量到的是压缩后的时间，
     *    2 倍速就会只取到源里一半的内容（成片后半段是黑帧），而命令不报错。
     * ⚠️ 用 `speed.setptsExpr` 而不是自己拼：原速时它返回与以前**逐字相同**的串，
     *    既有的导出证据不会因为这些改动失效。
     */
    const rate = speed.clipSpeed(clip)
    /* 「变速保留音高」—— 关掉就是磁带快放/慢放的效果（见 shared/speed.js 的 pitchChain）。
       缺省视为开：绝大多数人调倍速是为了"看快一点"，不是要变声。 */
    const keepPitch = clip.keepPitch !== false
    /* 探测结果（有没有音轨 / 色彩标签）在这里就要用到：HDR 判定决定画面链的**第一段**，
       而它在曲线变速分支里就要拼进去了，所以查询必须提到 curveVideoChain 之前。 */
    const known = info[clip.id]
    /**
     * HDR → SDR 的色调映射。放在**这条流的最前面**（trim 之前）：
     *   · 放在调色/特效之后 ⇒ 调色是按 HDR 的超标亮度算的，映射完颜色全偏；
     *   · 放在 trim 之前与之后在结果上等价（zscale 逐帧、无状态），但提前做能保证
     *     后面每个分支（常速 / 曲线分段）拿到的都是同一份 SDR 流。
     * 非 HDR 输入返回空串 ⇒ 本段滤镜串与改动前**逐字相同**，老工程的成片不受影响。
     */
    const hdrPre = isImage ? '' : (() => {
      const chain = hdr.tonemapChain(known)
      return chain ? `${chain},` : ''
    })()
    /**
     * 曲线变速：把这一段换成"分段常速 + concat"，返回一个新的流标签。
     * 拿不到分段（没有曲线 / 开了倒放 / 段数不足两段）时返回 null，
     * 下面照旧走单条常速路径 —— 两条路径的**总时长与源消耗完全相同**，
     * 所以切换曲线与否不会让片段在时间线上变长变短。
     */
    const curveRef = isImage
      ? null
      : curveVideoChain({ filters, idx, tag: `v${tag}`, clip, offset, dur, pre: hdrPre })
    const seek = isImage || curveRef
      ? ''
      : `trim=start=${round(offset)}:duration=${round(dur * rate)},${speed.setptsExpr(rate, round)}${reverse.videoReversePart(clip)},`
    // 调色滤镜夹在 pad 与归一化之间：先成帧、再调色、最后统一时基。
    // 放在 trim 之前会连没被用到的帧一起算，白耗时间。
    const grade = looks.ffmpegFilterFor(clip.filter, clip.filterIntensity ?? 1)
    const gradePart = grade ? `,${grade}` : ''
    // 画面特效紧跟调色之后（先调色、再叠特效），与预览的叠放次序一致。
    // fx-pulse 要放大再裁回，需要知道输出尺寸 —— 这里把 width/height 传下去。
    const fx = looks.frameFxFilterFor(clip.frameFx, { width, height })
    const fxPart = fx ? `,${fx}` : ''
    /**
     * 片段级缩放（属性面板那个滑块，100 = 原始大小）。
     *
     * ⚠️ 必须夹完再乘、放大后还要 crop 回画布：先 `force_original_aspect_ratio=decrease`
     *    把素材收进画布，再整体乘系数；大于 1 时画面会超出画布，不 crop 的话
     *    pad 不会裁（pad 只补边不裁剪），输出尺寸就与画布不一致，后面的 concat/xfade
     *    会以"输入尺寸不匹配"告终，而报错信息完全指不到这里。
     */
    const zoom = Math.min(3, Math.max(0.1, num(clip.scale, 100) / 100))
    const zoomPart =
      Math.abs(zoom - 1) > 0.001
        ? `,scale=iw*${round(zoom, 4)}:ih*${round(zoom, 4)}` + (zoom > 1 ? `,crop=${width}:${height}` : '')
        : ''
    /**
     * 片段级不透明度。
     *
     * 用的是 colorchannelmixer 的 `aa`（alpha 通道乘数），必须排在 format 之后 ——
     * format=yuva420p 才给这条流造出 alpha 通道，之前乘是无效的。
     * 半透明要真的"透出下面的背景"，前提是整条链带 alpha（见 needAlpha）。
     */
    const opacity = Math.min(1, Math.max(0, num(clip.opacity, 100) / 100))
    const alphaPart = opacity < 0.995 ? `,colorchannelmixer=aa=${round(opacity, 4)}` : ''
    /**
     * 位置 / 旋转（属性面板「画面」页）。必须排在 `pad` **之前** ——
     * poseFilter 自己会把画布垫大再按偏移裁回来，顺序反了偏移就落在画布外。
     */
    const pose = poseFilter(clip, width, height, padColor)
    const posePart = pose ? `,${pose}` : ''
    /**
     * 调节 / 美颜。
     * ⚠️「磨皮」会把画面边缘糊出半透明，先按 cover 系数放大一点点把毛边推出画布外 ——
     *    预览那侧的 transform 用的是同一个 1.02（见 shared/adjust.js 的 SMOOTH_COVER_SCALE），
     *    两边必须一致，否则"预览看不出边、成片一圈底色"。
     */
    const cover = adjust.coverScale(adjust.readBeauty(clip.beauty))
    const coverPart = cover > 1 ? `,scale=iw*${cover}:ih*${cover},crop=${width}:${height}` : ''
    const adjustStr = adjust.ffmpegFilterFor(clip.adjust, clip.beauty, round, width)
    const adjustPart = adjustStr ? `,${adjustStr}` : ''
    /**
     * 自由裁剪框：框外裁掉、框内铺满。
     * 排在「铺满画布」之后、缩放/位置之前 —— 语义就是"先成帧，再在帧里框一块，
     * 再放大回原尺寸"。换算全在 shared/crop.js，与预览的 transform 同一份。
     */
    const cropStr = crop.ffmpegCropFor(clip.crop, width, height, round)
    const cropPart = cropStr ? `,${cropStr}` : ''
    /**
     * 视频降噪 / 防抖（**导出阶段**，界面上标了「导出时应用」）。
     * 放在几何变换之前：先裁再降噪会把裁切边界的噪点抹成一条亮边；
     * 防抖更要先做，否则后面的 crop/pad 会把抖动的位移一起算进构图。
     */
    const denoiseStr = audiofx.videoDenoiseFilter(clip.denoise, round)
    const denoisePart = denoiseStr ? `,${denoiseStr}` : ''
    const stabilizeStr = audiofx.stabilizeFilter(clip.stabilize, round)
    const stabilizePart = stabilizeStr ? `,${stabilizeStr}` : ''
    /**
     * 镜像与斜切。
     *
     * ⚠️ 斜切原来**只活在预览里**：shared/effects.js 写了 shearFor，Stage.jsx 也真的
     *    把 `skew()` 挂到了 transform 上，但 buildPlan 从来没调用过它 ——
     *    于是"面板上斜了、预览里斜了、成片里是正的"。这类缺陷不报错、不崩，
     *    只有把两段视频摆在一起比才看得见，正是本项目最怕的那一类。
     *    镜像同理，加它的时候就一起接上，不留"预览有、成片没有"的窗口期。
     */
    const fxObj = effects.readEffects(clip.effects)
    const shearStr = effects.shearFor(fxObj, round, 'black@0')
    const mirrorStr = effects.mirrorFilters(fxObj)
    /* 顺序与预览的 transform 列表逐字对应（CSS 从右往左作用）：
       裁剪 → 镜像 → 斜切 → 缩放/位置/旋转。 */
    const shapePart = [mirrorStr, shearStr].filter(Boolean).map((item) => `,${item}`).join('')
    filters.push(
      `${curveRef || `[${idx}:v]`}${curveRef ? '' : hdrPre}${seek}${scale},${cropBase}${stabilizePart}${denoisePart}${cropPart}${shapePart}${zoomPart}${posePart},${pad}${coverPart}${adjustPart}${gradePart}${fxPart},setsar=1,fps=${fps},format=${pixFmt}${alphaPart}[svb${tag}]`
    )
    /**
     * 效果链（抠像 → 圆角/蒙版 → 描边 → 阴影）接在"已经成帧"的 `[svb${tag}]` 之后。
     * 顺序与预览侧 Stage.jsx 的 effectFilterParts 同一口径 —— 两边各写一份顺序，
     * 迟早会出现"预览里描边在圆角外、成片里被圆角切掉一截"。
     */
    const eff = effectsStages({
      tag: `s${tag}`,
      label: `svb${tag}`,
      clip,
      width,
      height,
      maskFile: '',
      maskMap: effectMasks,
      addMaskInput,
      pixFmt
    })
    eff.lines.forEach((line) => filters.push(line))
    const svRef = `[${eff.label}]`

    const hasAudio = isImage ? false : known ? Boolean(known.hasAudio) : assumeVideoAudio
    /** 片段级音量（属性面板那个滑块，100 = 原音量）。静音片段走不到这里，见下面 */
    const gain = Math.min(2, Math.max(0, num(clip.gain, 100) / 100))
    /**
     * 音量包络（关键帧）：有包络时**优先于**静态音量，且把静态音量乘进每个采样点。
     * ⚠️ 表达式里的 `t` 是滤镜链当前时间，前面已经 asetpts=PTS-STARTPTS 把片段
     *    起点归零，所以包络的时间轴（片段内秒数）与它天然对齐。
     */
    const volPoints = audiofx
      .readVolumeKf(clip.volumeKf)
      .map((point) => ({ t: point.t, v: point.v * gain }))
    const volExpr = audiofx.hasVolumeKf(volPoints) ? audiofx.volumeExpr(volPoints) : ''
    const gainPart = volExpr
      ? `,volume='${volExpr}'`
      : Math.abs(gain - 1) > 0.001
        ? `,volume=${round(gain, 4)}`
        : ''
    /** 音频降噪（导出阶段）—— 逐片段挂，作用在**这一段的原声**上 */
    const adn = audiofx.audioDenoiseFilter(clip.audioDenoise, round)
    const adnPart = adn ? `,${adn}` : ''
    /** 立体声平衡（导出阶段）—— 只改左右声道增益，不混单声道 */
    const panPart = (() => {
      const pan = audiofx.panFilter(clip.pan, round)
      return pan ? `,${pan}` : ''
    })()
    if (hasAudio) {
      /* 变调（半音）：作用在**整段**上、排在变速之后。
         放在分段之前的话每段都会各自变一次调，听起来像"一格一格地抖"。 */
      const pitchPart = speed.semitoneChain(clip.pitch, round)
      const aCurve = curveAudioChain({ filters, idx, tag: `a${tag}`, clip, offset, dur, keepPitch })
      /* 尾段（降噪 / 平衡 / 音量 / 淡入淡出）两条路共用，都以逗号开头 ——
         接在曲线那条后面时要**去掉第一个逗号**：concat 的输出标签后面紧跟的是
         第一个滤镜名，写成 `[caok1],asetrate=…` 会被 ffmpeg 当成语法错。 */
      const aTail = pitchPart + adnPart + panPart + gainPart + fadePartFor(clip, dur)
      /* ⚠️ 尾段可能**整段为空**（没变调、没降噪、没平衡、音量 100、没淡入淡出）——
         那时 `[caok1][sa1]` 里夹着零个滤镜，ffmpeg 报 "No such filter: ''"。
         补一个 `anull` 兜底：它什么都不做，但让这条链始终是"输入 → 至少一个滤镜 → 输出"。 */
      const aTailSafe = aTail || ',anull'
      filters.push(
        (aCurve
          ? aCurve + aTailSafe.replace(/^,/, '')
          : `[${idx}:a]atrim=start=${round(offset)}:duration=${round(dur * rate)},asetpts=PTS-STARTPTS` +
            /* 倒放：整段音轨反着吐。必须紧跟 asetpts（areverse 要求干净时间戳），
               且要排在 atempo 之前 —— 反的是"内容"，变的是"速率"，顺序换了就只反了一半 */
            reverse.audioReversePart(clip) +
            /* 音频变速：atempo 单级只吃 0.5–2.0，超出由 atempoChain 拆成多级相乘；
               关掉「保留音高」时走 asetrate（见 pitchChain） */
            speed.pitchChain(rate, keepPitch, round) +
            ',aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo' +
            aTail) +
          '[sa' + tag + ']'
      )
      segments.push({ v: svRef, a: `[sa${tag}]`, len: dur, transitionOut: seg.transitionOut })
    } else {
      args.push('-f', 'lavfi', '-t', round(dur), '-i', 'anullsrc=r=48000:cl=stereo')
      const silIdx = inputIndex++
      filters.push(`[${silIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[sa${tag}]`)
      segments.push({ v: svRef, a: `[sa${tag}]`, len: dur, transitionOut: seg.transitionOut })
    }
  }

  // 视频轨完全为空时给整条音轨垫一段黑场，否则 concat 没有输入
  if (!segments.length) pushGap(duration, 0)

  /**
   * 逐段折叠成一条流。
   * 有转场的接缝走 xfade / acrossfade（两段真实交叠），没有的走 concat。
   * 注意 concat 的输入顺序必须是 v0,a0,v1,a1 —— 写成 v0,v1,a0,a1 会被当成
   * "两路视频 + 两路音频"直接报参数错，而错误信息只会说 concat 输入数量不符。
   */
  const fmtSec = (value) => String(Number(Number(value).toFixed(3)))
  let videoLabel = ''
  let audioLabel = ''
  /** 折叠后的视频流总长（已扣掉转场占用的时长） */
  let videoTotal = 0
  if (segments.length === 1) {
    videoLabel = segments[0].v
    audioLabel = segments[0].a
    videoTotal = segments[0].len
  } else {
    let cur = segments[0]
    for (let i = 1; i < segments.length; i += 1) {
      const seg = segments[i]
      const link = segments[i - 1].transitionOut
      // xfade 要求 d 严格小于两侧长度，留 0.05 秒余量；夹完不足一帧就退回硬切
      const d = link
        ? Math.min(link.duration, Math.max(0, cur.len - 0.05), Math.max(0, seg.len - 0.05))
        : 0
      if (link && d > 0.05) {
        const offset = Math.max(0, cur.len - d)
        filters.push(
          `${cur.v}${seg.v}xfade=transition=${link.ffmpeg}:duration=${fmtSec(d)}:offset=${fmtSec(offset)}[vx${i}]`
        )
        filters.push(`${cur.a}${seg.a}acrossfade=d=${fmtSec(d)}:c1=tri:c2=tri[ax${i}]`)
        cur = { v: `[vx${i}]`, a: `[ax${i}]`, len: Number((cur.len + seg.len - d).toFixed(3)) }
      } else {
        filters.push(`${cur.v}${cur.a}${seg.v}${seg.a}concat=n=2:v=1:a=1[vx${i}][ax${i}]`)
        cur = { v: `[vx${i}]`, a: `[ax${i}]`, len: Number((cur.len + seg.len).toFixed(3)) }
      }
    }
    videoLabel = cur.v
    audioLabel = cur.a
    videoTotal = cur.len
  }

  /**
   * 成片时长 = max(视频流总长, 音轨绝对终点)。
   * 转场只作用于视频轨，音轨片段仍是绝对起点，所以两者要取大者 ——
   * 只按视频轨算会让"配乐比画面长"的片子被 -t 提前砍掉尾巴。
   */
  const finalDuration = Number(Math.max(videoTotal, audioEnd, overlayRenderedEnd).toFixed(3))

  /**
   * 背景真正落进成片的一步：把折叠好的视频流 overlay 到铺满画布的背景图上。
   *
   * ⚠️ 少了这一段，"选了背景"就只在预览里成立 —— 上面那些 `padColor=black@0.0` 只是把
   *    素材四周挖成透明，透明最后会被输出成黑色，成片里根本看不到背景。
   *    这是「功能接了一半」最典型的形态：前面的代码写得像那么回事、还留了注释说要叠，
   *    真正 overlay 的那两行却从来没写。
   *
   * 背景按 force_original_aspect_ratio=increase + crop 铺满画布（与预览的 cover 口径一致），
   * 素材层带 alpha 压在上面，四周自然透出背景。
   */
  if (withBackdrop && finalDuration > 0.05) {
    args.push('-loop', '1', '-t', round(finalDuration), '-i', backdropSource)
    const bgIdx = inputIndex++
    filters.push(
      `[${bgIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[bgv]`
    )
    filters.push(`[bgv]${videoLabel}overlay=0:0:format=auto,setsar=1,fps=${fps}[vfin]`)
    videoLabel = '[vfin]'
  }

  /**
   * 叠加轨（画中画）：一段一段压在主画面之上，只在自己的时间窗里出现。
   *
   * ⚠️ 起点必须走**结算后的时间轴**：主链上每处转场都会吃掉 d 秒（见 resolveTrack 的
   *    ripple），画中画若仍按 `clip.start` 对齐，接缝之后就会整体提前 ——
   *    单独看每一处都对，只有"前面加了转场，画中画就错位"才暴露。
   *
   * 坐标用 overlay 的表达式（main_w / overlay_w …）而不是先算好的像素：
   * 画中画的高度由素材比例决定，这里拿不到；表达式能在 ffmpeg 内部拿到真实尺寸，
   * 于是与预览那侧（CSS 用 translate 回退自身尺寸）**逐字对应**。
   */
  const pipAnchorOf = (key) =>
    PIP.anchors.find((item) => item.key === key) ||
    PIP.anchors.find((item) => item.key === PIP.defaultAnchor)
  const pipSizeOf = (value) =>
    Math.round(Math.min(PIP.maxSize, Math.max(PIP.minSize, num(value, PIP.defaultSize))))

  /** 到 raw 时刻为止，主链被转场吃掉的总时长 */
  const shiftAt = (raw) => {
    let saved = 0
    for (const seg of plan.segments) {
      if (!seg.transitionOut) continue
      const seam = num(seg.clip.start) + num(seg.duration)
      if (raw >= seam - 0.001) saved += num(seg.transitionOut.duration)
    }
    return saved
  }

  overlayClips.forEach((clip, i) => {
    const source = sourceOf(clip)
    if (!source) return
    const dur = num(clip.duration)
    if (dur <= 0.02) return
    const t0 = Math.max(0, num(clip.start) - shiftAt(num(clip.start)))
    const t1 = t0 + dur
    overlayRenderedEnd = Math.max(overlayRenderedEnd, t1)
    if (t1 <= 0.02) return

    const isImage = clip.kind === 'image'
    const offset = Math.max(0, num(clip.offset))
    if (isImage) args.push('-loop', '1', '-t', round(dur), '-i', source.value)
    else args.push('-i', source.value)
    const idx = inputIndex++

    const anchor = pipAnchorOf(clip.pip && clip.pip.anchor)
    const w = Math.max(2, Math.round((width * pipSizeOf(clip.pip && clip.pip.size)) / 100 / 2) * 2)
    const m = PIP.margin
    const opacity = Math.min(1, Math.max(0, num(clip.opacity, 100) / 100))
    const alphaPart = opacity < 0.995 ? `,colorchannelmixer=aa=${round(opacity, 4)}` : ''
    /* 画中画也吃倍速（与主链同一口径，否则"画中画快、主画面慢"） */
    const pipRate = speed.clipSpeed(clip)
    /* 曲线变速同样要进画中画：只给主画面接曲线的话，画中画里那层还是匀速的，
       两个画面一起放时快慢对不上 —— 而这种"不同步"在单独看任何一层时都看不出来。 */
    const pipCurve = isImage ? null : curveVideoChain({ filters, idx, tag: `pv${i}`, clip, offset, dur })
    const seek = isImage || pipCurve
      ? ''
      : `trim=start=${round(offset)}:duration=${round(dur * pipRate)},${speed.setptsExpr(pipRate, round)}${reverse.videoReversePart(clip)},`

    filters.push(`${pipCurve || `[${idx}:v]`}${seek}scale=${w}:-2,setsar=1,fps=${fps},format=${pixFmt}${alphaPart}[pipin${i}]`)
    /**
     * 画中画同样吃效果链（圆角/蒙版/抠像/描边/阴影）。
     * ⚠️ 遮罩走**运行时 geq**（不预生成 PNG）：画中画的高度由素材比例决定，
     *    构建命令时算不出来；`geq` 的 W/H 就是这一帧的真实尺寸，天然自适应。
     * ⚠️ 宽度传 `w`（画中画在主画布里的像素宽），因为描边/阴影的粗细是相对
     *    **元素自身宽度**的比例 —— 传主画布宽度会让画中画的描边粗一倍。
     */
    const pipFx = effectsStages({
      tag: `p${i}`,
      label: `pipin${i}`,
      clip,
      width: w,
      height,
      maskFile: '',
      maskMap: null,
      addMaskInput: null,
      pixFmt
    })
    pipFx.lines.forEach((line) => filters.push(line))
    const pipRef = `[${pipFx.label}]`

    const fxObj = effects.readEffects(clip.effects)
    const blendMode = effects.blendFfmpeg(fxObj)
    const nextLabel = `[vov${i}]`
    if (blendMode) {
      /**
       * 混合模式：CSS 的 `mix-blend-mode` 是"图层与背景逐像素混色"。
       *
       * ⚠️ 不能直接 `blend` 原画中画流：`blend` 两个输入必须同尺寸，而画中画是
       *    小图；用 `overlay` 定位又拿不到混合。这里的做法是
       *    ① 用 `pad` 把小图按锚点公式**放到整幅画布的对应位置**（四周填 `black@0`）；
       *    ② `blend` 与主画面混色；
       *    ③ **用原图自己的 alpha 把混色结果掩回去** —— 否则"黑@0"的填充区也会参与
       *       混色（`blend` 只算 RGB、不看 alpha），剪影之外的地方会被一起乘暗。
       *        （真机验过：不做第③步，角点从 128 变成 0。）
       * ⚠️ 必须在 **gbrp/gbrap** 空间做：CSS 是按 sRGB 混的，YUV 空间乘出来的颜色
       *    是错的（灰×蓝在 YUV 下得到 rgb(0,66,0)，正确是 rgb(0,0,127)）。
       */
      const padX = `${m}*${width}+${anchor.fx}*(${width}-${2 * m}*${width}-iw)`
      const padY = `${m}*${width}+${anchor.fy}*(${height}-${2 * m}*${width}-ih)`
      filters.push(`${videoLabel}format=gbrap,split=2[pipM${i}a][pipM${i}b]`)
      filters.push(
        `${pipRef}format=gbrap,pad=${width}:${height}:x='${padX}':y='${padY}':color=black@0,` +
          `split=2[pipP${i}a][pipP${i}b]`
      )
      filters.push(`[pipM${i}a][pipP${i}a]blend=all_mode=${blendMode}:all_opacity=1[pipBl${i}]`)
      filters.push(`[pipP${i}b]alphaextract,format=gray[pipAl${i}]`)
      filters.push(`[pipBl${i}][pipAl${i}]alphamerge[pipBm${i}]`)
      filters.push(
        `[pipM${i}b][pipBm${i}]overlay=0:0:enable='between(t,${round(t0)},${round(t1)})'` +
          `,format=${pixFmt},setsar=1${nextLabel}`
      )
    } else {
      filters.push(
        `${videoLabel}${pipRef}overlay=x='${m}*main_w+${anchor.fx}*(main_w-${2 * m}*main_w-overlay_w)'` +
          `:y='${m}*main_w+${anchor.fy}*(main_h-${2 * m}*main_w-overlay_h)'` +
          `:enable='between(t,${round(t0)},${round(t1)})'${nextLabel}`
      )
    }
    videoLabel = nextLabel
  })

  /**
   * 字幕（字幕轨上、无 assetId、有正文的那一种）→ drawtext，串在最上层。
   *
   * ⚠️ 必须排在画中画**之后**：字幕是最上面的一层，先画它会被画中画盖住。
   *    判据与预览一致（见 subtitles.js），所以不会出现"预览里有字幕、成片里没有"。
   */
  const subs = subtitles.buildSubtitleFilters({ clips: list, width, height, tmpDir: os.tmpdir() })
  subs.filters.forEach((filterText, i) => {
    const nextLabel = `[vsb${i}]`
    filters.push(`${videoLabel}${filterText}${nextLabel}`)
    videoLabel = nextLabel
  })

  /**
   * 透明真正落进成片的一步：把带 alpha 的画面**压到黑底**上。
   *
   * ⚠️ 少了这一步，"透明"只存在于滤镜图里：编码器最后统一 `-pix_fmt yuv420p`，
   *    alpha 被整体丢掉、RGB 原封不动留下来 —— 抠像抠掉的绿底、圆角切掉的角、
   *    蒙版裁掉的部分，在成片里会**一模一样地回来**。真机复现过：抠完像的角点仍是
   *    `rgb(0,175,63)` 的绿。而 ffmpeg 不报任何错，只有读像素才看得见。
   *    预览那侧画布底下就是黑色，所以"压黑"才是与预览一致的口径。
   * ⚠️ 有背景时不压：背景图本身已经提供了不透明的底，再压黑会把背景整个盖掉。
   */
  if (needAlpha && !withBackdrop && finalDuration > 0.05) {
    filters.push(`color=c=black:s=${width}x${height}:r=${fps},format=yuv420p[blkbg]`)
    /* ⚠️ 黑底必须是 overlay 的**第一个**输入（底图），画面是第二个（盖上去的那层）。
       写反了就是把黑幕盖在画面上 —— 成片整幅全黑，而命令一行错都不报。 */
    filters.push(`[blkbg]${videoLabel}overlay=0:0:format=auto,setsar=1,fps=${fps}[vflat]`)
    videoLabel = '[vflat]'
  }

  /**
   * 铺在主画面原声之上的音频：音频轨片段 + **画中画自己的原声**。
   *
   * 画中画带声音是默认预期（贴一段采访 / 反应画面进去就是要它的声音），
   * 少了它会出现"画中画有画面没声音"，而界面上不会有任何提示。
   */
  const extra = []
  const bed = [
    ...audioClips.map((clip) => ({ clip, at: num(clip.start) })),
    ...overlayClips
      .filter((clip) => clip.kind !== 'image')
      /**
       * ⚠️ 确认没有音轨的画中画**不能**再给它接音频输入：`[N:a]` 匹配不到任何流时，
       *    整条 filtergraph 直接 `Error binding filtergraph inputs/outputs`，
       *    表现为"加了段无声素材进去就导不出来"，而错误信息完全指不到这里。
       *    未知时按 assumeVideoAudio 猜（与主链同一口径）。
       */
      .filter((clip) => {
        const known = info[clip.id]
        return known ? Boolean(known.hasAudio) : assumeVideoAudio
      })
      .map((clip) => ({ clip, at: Math.max(0, num(clip.start) - shiftAt(num(clip.start))) }))
  ]
  bed.forEach((entry, i) => {
    const clip = entry.clip
    const source = sourceOf(clip)
    if (!source) return
    args.push('-i', source.value)
    const idx = inputIndex++
    const dur = num(clip.duration)
    const offset = Math.max(0, num(clip.offset))
    const delay = Math.max(0, Math.round(entry.at * 1000))
    const gain = Math.min(2, Math.max(0, num(clip.gain, 100) / 100))
    /* 音频轨 / 画中画原声同样吃倍速（与画面同一口径） */
    const bedRate = speed.clipSpeed(clip)
    /* 音量包络与主链同一份换算（audiofx.volumeAt 是预览侧用的同一个插值） */
    const bedVol = audiofx
      .readVolumeKf(clip.volumeKf)
      .map((point) => ({ t: point.t, v: point.v * gain }))
    const bedExpr = audiofx.hasVolumeKf(bedVol) ? audiofx.volumeExpr(bedVol) : ''
    const bedGain = bedExpr ? `volume='${bedExpr}'` : `volume=${round(gain, 4)}`
    const bedDenoise = audiofx.audioDenoiseFilter(clip.audioDenoise, round)
    const bedPan = audiofx.panFilter(clip.pan, round)
    /* 音频轨上的片段同样可能有曲线变速（配乐踩点就落在这条轨上）。
       有曲线时走分段拼接，否则走原来那条单段链 —— 两条路的尾段完全一致。 */
    const bedCurve = curveAudioChain({
      filters,
      idx,
      tag: `ba${i}`,
      clip,
      offset,
      dur,
      keepPitch: clip.keepPitch !== false
    })
    const bedTail =
      speed.semitoneChain(clip.pitch, round) +
      (bedDenoise ? `,${bedDenoise}` : '') +
      (bedPan ? `,${bedPan}` : '') +
      `,${bedGain}` +
      /* 音频轨（BGM/配音）与画中画原声同样吃淡入/淡出：面板上那条滑杆对
         「音频轨上的片段」也开放，少了这一段就是"能调、成片不变" */
      fadePartFor(clip, dur) +
      `,adelay=${delay}:all=1[mx${i}]`
    filters.push(
      bedCurve
        ? bedCurve + bedTail.replace(/^,/, '')
        : `[${idx}:a]atrim=start=${round(offset)}:duration=${round(dur * bedRate)},asetpts=PTS-STARTPTS` +
          reverse.audioReversePart(clip) +
          speed.pitchChain(bedRate, clip.keepPitch !== false, round) +
          `,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo` +
          bedTail
    )
    extra.push(`[mx${i}]`)
  })

  if (extra.length) {
    filters.push(`${audioLabel}${extra.join('')}amix=inputs=${extra.length + 1}:duration=longest:normalize=0[aout]`)
    audioLabel = '[aout]'
  }

  /**
   * 响度统一（**导出阶段**）：作用在混完的整条音轨上，排在 amix **之后**。
   *
   * ⚠️ 不能逐片段拉响度：每段各自拉到同一个 LUFS 再混起来，音量关系反而更乱
   *    （一段轻声旁白会被拉成和配乐一样响）。母带处理的对象永远是"总线"。
   */
  const loudnorm = audiofx.loudnormFor(options.loudness, round)
  if (loudnorm) {
    filters.push(`${audioLabel}${loudnorm}[aloud]`)
    audioLabel = '[aloud]'
  }

  /**
   * 收尾统一**打色彩标签**：`setparams` 挂在成片的视频出口上。
   *
   * 为什么非要在滤镜里打一遍（明明下面还给了 `-color_trc bt709` 这些输出参数）：
   * ffmpeg 在滤镜图存在时，**帧自带的色彩属性优先于输出参数**。
   * HDR 源因为 zscale 显式写过 bt709，帧属性是对的；而 SDR 源（尤其是 lavfi / 手机截屏
   * 这类"标签本来就是 unknown"的）帧属性是 unknown，输出参数被它盖掉，成片就标成 unknown。
   * 表现是"我们这儿看着正常，某些播放器当它是未标定的片子，颜色随便解释一遍"。
   * 这一句把出口帧属性钉死，两种源走同一条口径。
   */
  if (filters.length && videoLabel) {
    const tagged = 'vtagged'
    filters.push(`${videoLabel}setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709[${tagged}]`)
    videoLabel = `[${tagged}]`
  }

  args.push('-filter_complex', filters.join(';'))
  args.push('-map', videoLabel, '-map', audioLabel)
  args.push('-t', round(finalDuration))
  /**
   * 编码参数。
   *
   * 三档来源：
   *   · 编码器 —— `options.encoder`（渲染层只列本机真正有的那几个，见 probe 的 encoders）；
   *   · 码率模式 —— 画质优先（crf/cq）或码率优先（-b:v + maxrate/bufsize 组成准 CBR）；
   *   · 音频码率 —— 固定 192k（人声/配乐够用，且与所有容器的兼容性最好）。
   *
   * ⚠️ 硬件编码器的"画质档"参数各不相同：x264 用 `-crf`、nvenc 用 `-cq`（配 `-rc vbr`）、
   *    qsv 用 `-global_quality`、amf 用 `-qp_i/-qp_p`。写错的那个不会报错 ——
   *    ffmpeg 会**忽略不认识的私有参数**（有的版本只给一条 warning），
   *    结果就是"选了硬件编码、画质完全不是设定的那一档"。
   */
  const encode = encodeArgs(options, crf)
  args.push(...encode)
  /**
   * 色彩标签：成片一律标 BT.709 / SDR。
   *
   * 像素在链内已经是 SDR 了（HDR 源走过 tonemap，见 shared/hdr.js），但如果**不给标签**，
   * 播放器会沿用输入文件的 HDR 标记去解释这些像素 —— 于是"我们自己看正常、别人那儿发灰"，
   * 而且在本机永远复现不出来（本机的播放器恰好忽略了标签）。
   */
  args.push(...hdr.encoderTagArgs())
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  args.push('-movflags', '+faststart')
  args.push(outPath)

  /**
   * warnings：事办了但**没办全**的（目前只有"找不到中文字体 ⇒ 字幕没写进成片"）。
   * 它不进 ok/失败判定 —— 成片是好的；但也不能不吭声，否则用户看到"没有字幕"
   * 只能自己猜原因。
   */
  const warnings = []
  if (subs.missingFont) {
    warnings.push('这台机器上没找到可用的中文字体，字幕没能写进成片（画面与音频不受影响）')
  }
  return {
    args,
    duration: finalDuration,
    segmentCount: segments.length,
    subtitleCount: subs.count,
    warnings
  }
}

/* -------------------------------- 执行 -------------------------------- */

/**
 * 提取音轨 —— 参考「音频 → 提取音频」那一项的本地实现。
 *
 * ⚠️ 它**不走模型**：只要本机有 ffmpeg 就能用，与接不接任何服务无关。
 * 这也是把它放在主进程而不是远端服务里的原因 —— 用户选一段视频、点一下就该出结果，
 * 不该先排队再等回传。
 *
 * 先 `probeStreams` 确认真的有音轨：没有音轨时 ffmpeg 也会"成功"产出一个 0 秒的空文件，
 * 界面上就变成"提取成功但素材是坏的"，而这正是最难查的那一类（不报错、流程全走完）。
 *
 * 编码用 aac 而不是 `-acodec copy`：源音轨可能是 pcm/eac3 这类素材库放不了的格式，
 * copy 出来的文件浏览器解不了；统一转 aac 才能直接进素材列表试听。
 *
 * @returns {{ok:boolean, outPath?:string, duration?:number, error?:string, reason?:string}}
 */
async function extractAudio({ sourcePath, outPath, ffmpegPath, signal }) {
  if (!sourcePath) return { ok: false, error: '没有指定源文件', reason: 'bad-input' }
  if (!outPath) return { ok: false, error: '没有指定输出路径', reason: 'bad-input' }

  const found = findFfmpeg()
  const bin = ffmpegPath || (found && found.ffmpeg)
  if (!bin) return { ok: false, error: '找不到 ffmpeg，无法提取音频', reason: 'not-found' }

  const info = await probeStreams(sourcePath)
  if (info && info.hasAudio === false) {
    return { ok: false, error: '这个片段没有音轨，提取不出音频', reason: 'no-audio' }
  }

  const result = await run(
    bin,
    ['-y', '-i', sourcePath, '-vn', '-acodec', 'aac', '-b:a', '192k', outPath],
    { timeout: 120000, signal }
  )
  if (!result.ok) {
    return { ok: false, error: result.error || '提取失败', reason: 'ffmpeg' }
  }
  return { ok: true, outPath, duration: (info && info.duration) || 0 }
}

/* ------------------------------ 波形峰值 ------------------------------ */

/** 抽 PCM 的目标采样率：波形只要"包络形状"，8kHz 绰绰有余，临时文件也小 */
const PEAKS_RATE = 8000
/** 峰值缓存上限。波形会被反复问（缩放时间线、来回切草稿），不缓存就是反复起 ffmpeg */
const PEAKS_CACHE_MAX = 240
const peaksCache = new Map()

/**
 * PCM(s16le 单声道) → N 个归一化振幅（0..1），每桶取绝对值最大。
 *
 * 归一化到**本片段自己的峰值**：同一条轨里一段很轻的旁白也要画出形状，
 * 不能因为别处有爆音就被压成一条直线（那样和"没画出来"长得一样）。
 * 与渲染层 `clipVisuals.peakBuckets` 是同一个口径 —— 两边各写一份就会出现
 * "预览波形和轨道波形高度对不上"。
 */
function bucketsFromPcm(buffer, buckets) {
  const n = Math.max(1, Math.floor(Number(buckets) || 1))
  const out = new Array(n).fill(0)
  const samples = Math.floor(buffer.length / 2)
  if (samples < 1) return out
  const per = samples / n
  let max = 0
  for (let b = 0; b < n; b += 1) {
    const from = Math.floor(b * per)
    const to = Math.min(samples, Math.max(from + 1, Math.floor((b + 1) * per)))
    let peak = 0
    for (let i = from; i < to; i += 1) {
      const raw = buffer.readInt16LE(i * 2)
      const value = raw < 0 ? -raw : raw
      if (value > peak) peak = value
    }
    out[b] = peak
    if (peak > max) max = peak
  }
  if (max > 0) for (let b = 0; b < n; b += 1) out[b] = out[b] / max
  return out
}

/**
 * 片段的音频峰值（画波形用）。
 *
 * ⚠️ 为什么走 ffmpeg 而不是渲染层的 `decodeAudioData`：
 *   后者对**视频容器**不可靠（mp4/mov 里的 AAC 经常直接抛 EncodingError），
 *   而视频片段底部的波形恰恰是最需要的那一个。ffmpeg 对任何容器都稳，
 *   而且是主进程里跑，不占渲染层的主线程。
 *
 * @returns {{ok:boolean, peaks?:number[], cached?:boolean, reason?:string, error?:string}}
 */
async function audioPeaks({ sourcePath, offset = 0, duration = 0, buckets = 160 }) {
  if (!sourcePath) return { ok: false, reason: 'bad-input', error: '没有指定源文件' }
  const n = Math.max(8, Math.min(512, Math.floor(Number(buckets) || 160)))
  const from = Math.max(0, Number(offset) || 0)
  const span = Math.max(0, Number(duration) || 0)
  const key = `${sourcePath}|${from.toFixed(3)}|${span.toFixed(3)}|${n}`
  const hit = peaksCache.get(key)
  if (hit) return { ok: true, peaks: hit, cached: true }

  const found = findFfmpeg()
  const bin = found && found.ffmpeg
  if (!bin) return { ok: false, reason: 'not-found', error: '找不到 ffmpeg，画不出波形' }

  const dir = path.join(os.tmpdir(), 'yjai-peaks')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return { ok: false, reason: 'io', error: '临时目录建不出来' }
  }
  const tmp = path.join(dir, `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.pcm`)
  try {
    const args = ['-v', 'error', '-y']
    /* 输入侧 seek（-ss 在 -i 之前）：先定位再解码，比"整段解码完再裁"快一个数量级。
       波形只关心片段**用掉的那一截**，所以 -ss/-t 直接用片段的入点与时长。 */
    if (from > 0) args.push('-ss', String(from))
    args.push('-i', sourcePath)
    if (span > 0) args.push('-t', String(span))
    args.push('-vn', '-ac', '1', '-ar', String(PEAKS_RATE), '-f', 's16le', tmp)
    const result = await run(bin, args, { timeout: 60000 })
    if (!result.ok) {
      return { ok: false, reason: 'ffmpeg', error: (result.stderr || '').trim().slice(-200) || '抽音频失败' }
    }
    const buffer = fs.readFileSync(tmp)
    if (!buffer.length) return { ok: false, reason: 'empty', error: '这一段没有声音，画不出波形' }
    const peaks = bucketsFromPcm(buffer, n)
    if (peaksCache.size >= PEAKS_CACHE_MAX) peaksCache.delete(peaksCache.keys().next().value)
    peaksCache.set(key, peaks)
    return { ok: true, peaks }
  } catch (error) {
    return { ok: false, reason: 'io', error: String(error && error.message) }
  } finally {
    // 删不掉不影响结果：它在系统临时目录里，系统自己会清
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 跑一次渲染。onProgress 会收到 0..1 的进度。
 * 返回 { ok, outPath, duration, attempts } 或 { ok:false, error }。
 */
async function render({ clips, outPath, options, onProgress, ffmpegPath, signal, backdrop = '' }) {
  /**
   * 复合片段先摊平成普通片段（纯函数，预览侧用的是同一份）。
   * 之后这个函数里所有 `clips` 的用法都改成 `list` —— 探测流信息、备遮罩、拼滤镜图
   * 三处必须看见**同一份**片段表，只改其中一处就会出现"探到的是父片段、渲的是子片段"。
   */
  const expanded = compound.expandCompounds(multicam.expandMulticams(Array.isArray(clips) ? clips : []))
  /**
   * 只导出时间区域（`options.range`）。
   *
   * 在**片段层**裁剪而不是给 ffmpeg 加 `-ss/-to`：输出侧裁时间会让画中画定位、
   * 转场、音量包络、关键帧这些"按绝对时间算"的东西整体错位（它们的时间表达式
   * 都是相对原时间线的）。裁片段表之后，整条链看到的就是"从 0 开始的一段"，
   * 与用户把这段拖到时间线开头再导出**逐字等价**。
   *
   * ⚠️ 展开必须在裁剪**之前**：复合片段 / 多机位的容器本身没有 url，
   *    先裁后展开会把容器按区间切成半截，展开时算原点就错了。
   */
  const rangeStart = Number(options && options.range && options.range.start)
  const rangeEnd = Number(options && options.range && options.range.end)
  const list =
    Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd > rangeStart
      ? region.trimToRegion(expanded, { start: rangeStart, end: rangeEnd })
      : expanded
  const found = findFfmpeg()
  const bin = ffmpegPath || (found && found.ffmpeg)
  if (!bin) return { ok: false, error: '找不到 ffmpeg', reason: 'not-found' }

  /**
   * 背景先在这里落一次地（asar 包内的图要复制到临时目录，见 backdropToLocal）。
   * 放在循环外是因为它不依赖 assumeVideoAudio 的那两次重试。
   */
  const stageBackdrop = backdropToLocal(backdrop)

  // 先各自探测一遍流信息，决定要不要给视频片段接音轨
  const streamInfo = {}
  const targets = list.filter((clip) => clip.track !== 'audio' && clip.track !== 'text' && clip.kind !== 'image')
  for (const clip of targets) {
    const source = sourceOf(clip)
    if (!source) continue
    const probed = await probeStreams(source.value)
    if (probed) streamInfo[clip.id] = probed
  }
  const hasProbe = Object.keys(streamInfo).length > 0

  const attempts = hasProbe ? [false] : [true, false]

  /**
   * 遮罩 PNG 必须在 `buildPlan` **之前**备好：buildPlan 是同步的，而生成遮罩要等
   * ffmpeg 跑完（本机不能走 spawnSync —— 管道写法恒 EBUSY）。
   * 放在重试循环外：它只跟分辨率/表达式有关，与 assumeVideoAudio 无关，不必重做。
   */
  const effectMasks = await prepareEffectMasks(bin, list, options)

  let lastError = ''
  for (let i = 0; i < attempts.length; i += 1) {
    const assumeVideoAudio = attempts[i]
    const plan = buildPlan({
      clips: list,
      streamInfo,
      outPath,
      options,
      assumeVideoAudio,
      backdrop: stageBackdrop,
      ffmpegPath: bin,
      effectMasks
    })
    if (plan.error) return { ok: false, error: plan.error, reason: 'empty' }
    const result = await runRender(bin, plan.args, plan.duration, onProgress, signal)
    /* warnings / subtitleCount 一并透出：成片本身是好的，但"字幕没写进去"这种
       没办全的事必须让调用方知道（否则界面上只会看到"没有字幕"，原因全靠猜）。 */
    if (result.ok) {
      return {
        ok: true,
        outPath,
        duration: plan.duration,
        segmentCount: plan.segmentCount,
        subtitleCount: plan.subtitleCount || 0,
        warnings: plan.warnings || [],
        attempts: i + 1
      }
    }
    lastError = result.error
    // 只有「这条流没有音频」这类错误才值得重试，其它错误重试也是白搭
    const retriable = /matches no streams|does not contain any stream|Invalid stream specifier/i.test(result.error)
    if (!retriable) break
  }
  return { ok: false, error: lastError || '渲染失败' }
}

function runRender(bin, args, totalDuration, onProgress, signal) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message) })
      return
    }
    let stderrTail = ''
    let stdoutBuf = ''
    let settled = false

    const done = (payload) => {
      if (settled) return
      settled = true
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      resolve(payload)
    }

    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      done({ ok: false, error: '已取消', reason: 'cancelled' })
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort)
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() || ''
      for (const line of lines) {
        const [key, value] = line.split('=')
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue
        const seconds = Number(value) / 1e6
        if (!Number.isFinite(seconds) || totalDuration <= 0) continue
        if (onProgress) onProgress(Math.max(0, Math.min(1, seconds / totalDuration)))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000)
    })
    child.on('error', (error) => done({ ok: false, error: String(error && error.message) }))
    child.on('close', (code) => {
      if (code === 0) done({ ok: true })
      else done({ ok: false, error: (stderrTail.trim() || `ffmpeg 退出码 ${code}`).slice(-1200) })
    })
  })
}

/**
 * 场景切换检测（「按场景分割」的探测步骤）。
 *
 * 用 ffmpeg 的 `select='gt(scene,T)'` 做**画面差异**检测（纯时间域，不解码成图片），
 * 命中帧的 `pts_time` 就是切点在源文件里的绝对秒数；再由 shared/scenes.js 换算到时间线。
 *
 * ⚠️ `metadata=mode=print:file=-` 把元数据写到 **stdout**，而 ffmpeg 自己的日志在 stderr。
 *    只读一路会拿到"有帧号没分数"或空字符串 —— 表现是"检测成功但一个切点都没有"。
 *    所以两路都读、拼在一起交给解析器。退出码 1 也不是错误：这条路本来就是 `-f null -`
 *    把整段解码一遍，末尾的 `Conversion failed` 之类不影响已经打出来的 pts。
 *
 * @returns {{ok:boolean, scenes?:Array<{at:number,score:number}>, reason?:string, error?:string}}
 */
async function detectScenes({ sourcePath, threshold = 0.3, duration = 0 } = {}) {
  if (!sourcePath) return { ok: false, reason: 'bad-input', error: '没有指定源文件' }
  const t = Math.min(0.9, Math.max(0.05, Number(threshold) || 0.3))
  const found = findFfmpeg()
  const bin = found && found.ffmpeg
  if (!bin) return { ok: false, reason: 'not-found', error: '找不到 ffmpeg，做不了场景检测' }

  const args = ['-hide_banner', '-nostdin']
  const span = Number(duration) || 0
  if (span > 0) args.push('-t', String(span))
  args.push(
    '-i', sourcePath,
    '-filter:v', `select='gt(scene,${t})',metadata=mode=print:file=-`,
    '-an', '-f', 'null', '-'
  )
  const result = await run(bin, args, { timeout: 120000 })
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  const scenes = scenesTable.parseScenes(text)
  /* 一帧都没命中是**合法结果**（整段就是一个镜头），不能当失败上报 ——
     但要把"为什么没有"说清楚，否则用户以为功能坏了。 */
  return { ok: true, scenes, empty: scenes.length === 0, threshold: t }
}

/**
 * 生成（或复用）预览代理。
 *
 * 代理是"预览用低分辨率、导出用原片"这件事的落点：
 *   · 只降分辨率（`scale=-2:'min(ih,H)'`，不放大），编码参数故意给得很轻（veryfast / crf 26）
 *     —— 代理的用途是拖动跟手，不是好看；
 *   · 音频保留 AAC 96k：代理里没声音的话，"预览有画面没声音"会被误判成素材坏了；
 *   · 已存在的代理**比源文件新**就直接复用（源被替换过就必须重做，
 *     否则预览里放的是上一版素材 —— 那种错看着像"替换没生效"）。
 *
 * @returns {{ok:boolean, outPath?:string, height?:number, cached?:boolean, error?:string, reason?:string}}
 */
async function makeProxy({ sourcePath, height = 540, outDir }) {
  if (!sourcePath) return { ok: false, reason: 'bad-input', error: '没有指定源文件' }
  if (!outDir) return { ok: false, reason: 'bad-input', error: '没有指定代理目录' }
  const target = Math.max(2, Math.round(Number(height) || 0))
  if (!target) return { ok: false, reason: 'off', error: '当前画质档位不用代理' }
  if (!fs.existsSync(sourcePath)) return { ok: false, reason: 'missing', error: '源文件不在了' }

  const outPath = path.join(outDir, proxyTable.proxyName(sourcePath, target))
  try {
    const srcStat = fs.statSync(sourcePath)
    if (fs.existsSync(outPath)) {
      const proxyStat = fs.statSync(outPath)
      if (proxyStat.size > 1024 && proxyStat.mtimeMs >= srcStat.mtimeMs) {
        return { ok: true, outPath, height: target, cached: true }
      }
    }
  } catch {
    /* 读不到就重做 */
  }

  const found = findFfmpeg()
  const bin = found && found.ffmpeg
  if (!bin) return { ok: false, reason: 'not-found', error: '找不到 ffmpeg，生成不了预览代理' }

  try {
    fs.mkdirSync(outDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: 'io', error: `代理目录建不出来：${String(error && error.message)}` }
  }

  const args = [
    '-hide_banner', '-y', '-loglevel', 'error',
    '-i', sourcePath,
    '-vf', proxyTable.scaleFilter(target),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p',
    /* `+faststart` 把索引挪到文件头：代理要边下边播，索引在尾部时第一帧要等整段读完 */
    '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '96k',
    outPath
  ]
  const result = await run(bin, args, { timeout: 10 * 60 * 1000 })
  if (!result.ok || !fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
    return { ok: false, reason: 'ffmpeg', error: (result.stderr || '').trim().slice(-300) || '生成代理失败' }
  }
  return { ok: true, outPath, height: target, cached: false }
}

module.exports = {
  findFfmpeg,
  resetFfmpegCache,
  probe,
  probeStreams,
  buildPlan,
  render,
  extractAudio,
  audioPeaks,
  detectScenes,
  makeProxy,
  pathFromMediaUrl,
  sourceOf
}
