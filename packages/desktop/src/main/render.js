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

/** 探测可用性 + 版本，供界面显示「本机已就绪 / 未安装」 */
async function probe() {
  const found = findFfmpeg()
  if (!found) return { available: false, reason: 'not-found', ffmpeg: '', ffprobe: '', version: '' }
  const result = await run(found.ffmpeg, ['-hide_banner', '-version'])
  if (!result.ok) {
    return { available: false, reason: 'broken', ffmpeg: found.ffmpeg, ffprobe: found.ffprobe, version: '', detail: result.stderr.slice(0, 400) }
  }
  const first = result.stdout.split('\n')[0] || ''
  return { available: true, reason: 'ok', ffmpeg: found.ffmpeg, ffprobe: found.ffprobe, version: first.trim() }
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
    '-show_entries', 'stream=codec_type',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file
  ], { timeout: 20000 })
  if (!result.ok) return null
  try {
    const parsed = JSON.parse(result.stdout)
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const duration = Number(parsed.format && parsed.format.duration)
    return {
      hasVideo: streams.some((s) => s.codec_type === 'video'),
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      duration: Number.isFinite(duration) ? duration : 0
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

/* ------------------------- 效果（圆角/蒙版/抠像/变形/描边/阴影） ------------------------- */

/**
 * 圆角 / 蒙版遮罩 PNG 的磁盘缓存目录。
 *
 * 遮罩是**不依赖素材内容**的（表达式只用 X/Y/W/H），所以同一种遮罩在一次导出里
 * 只需要生成一次，之后每帧只是一次 `alphamerge`（几乎不花钱）。
 * 直接用 `geq` 逐帧算的话，1080p 每帧两百万次表达式求值，导出会慢到没法用。
 */
const MASK_DIR = () => path.join(os.tmpdir(), 'yjai-masks')

/** 遮罩 PNG 的缓存键 = 尺寸 + 表达式 + 羽化（内容相同即复用） */
function maskKey(width, height, expr, feather) {
  return `${width}x${height}|${Math.round(feather)}|${expr}`
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
    if (!expr) continue
    const key = maskKey(width, height, expr, fx.mask.feather)
    if (seen.has(key)) continue
    seen.add(key)
    const file = await writeMaskPng(bin, key, expr, width, height, fx.mask.feather)
    if (file) map.set(key, file)
  }
  return map
}

/**
 * 把「效果」落到一条**已经成帧**的流上。
 *
 * 顺序（与预览侧 Stage.jsx 的 effectFilterParts 同一口径）：
 *   抠像 → 圆角/蒙版 → 描边 → 阴影
 *
 * ⚠️ 圆角/蒙版与描边/阴影的顺序不能反：描边是从**最终 alpha** 推出来的，
 *    先描边再裁形状的话，被裁掉的那部分描边就"描了个寂寞"。
 * ⚠️ 抠像与蒙版都是 alpha 的乘法关系，先后不影响结果。
 *
 * @param {string} label    输入流标签（不含方括号）
 * @param {string} maskFile 主画面的遮罩 PNG 路径（画中画传空串 → 走运行时 geq）
 * @param {function} addMaskInput 把遮罩图加成一个 ffmpeg 输入、返回它的序号
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
  const dilations = effects.strokeDilations(fx, width)
  if (dilations > 0) {
    const dil = 'dilation,'.repeat(dilations).slice(0, -1)
    lines.push(`[${cur}]split=2[${next('csb')}][${next('css')}]`)
    lines.push(`[${next('css')}]alphaextract,format=gray,split=2[${next('csd')}][${next('csa')}]`)
    lines.push(`[${next('csd')}]${dil}[${next('cse')}]`)
    lines.push(`[${next('cse')}][${next('csa')}]blend=all_mode=subtract[${next('csr')}]`)
    lines.push(`[${next('csr')}]format=rgba,split=2[${next('csc')}][${next('csm')}]`)
    lines.push(`[${next('csc')}]lutrgb=${effects.strokeLut(fx, round)}[${next('csq')}]`)
    lines.push(`[${next('csq')}][${next('csm')}]alphamerge[${next('css2')}]`)
    lines.push(`[${next('css2')}][${next('csb')}]overlay=0:0[${next('csf')}]`)
    cur = next('csf')
  }

  /* --- 阴影：黑色剪影 → 高斯模糊 → 按偏移垫出去 → 压在原画面下面 --- */
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
   */
  const overlayClips = list
    .filter((clip) => clip.track === 'overlay')
    .sort((a, b) => num(a.start) - num(b.start))
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
  const anyTransparent = [...videoClips, ...overlayClips].some((clip) => {
    if (num(clip.opacity, 100) < 99.5) return true
    const fx = effects.readEffects(clip.effects)
    if (!fx) return false
    return effects.hasClip(fx) || Boolean(fx.key.on) || Boolean(fx.stroke.on) || Boolean(fx.shadow.on)
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
    const crop = `crop=${width}:${height}`
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
    const seek = isImage
      ? ''
      : `trim=start=${round(offset)}:duration=${round(dur * rate)},${speed.setptsExpr(rate, round)},`
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
    const tag = segments.length
    filters.push(
      `[${idx}:v]${seek}${scale},${crop}${zoomPart}${posePart},${pad}${coverPart}${adjustPart}${gradePart}${fxPart},setsar=1,fps=${fps},format=${pixFmt}${alphaPart}[svb${tag}]`
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

    const known = info[clip.id]
    const hasAudio = isImage ? false : known ? Boolean(known.hasAudio) : assumeVideoAudio
    /** 片段级音量（属性面板那个滑块，100 = 原音量）。静音片段走不到这里，见下面 */
    const gain = Math.min(2, Math.max(0, num(clip.gain, 100) / 100))
    const gainPart = Math.abs(gain - 1) > 0.001 ? `,volume=${round(gain, 4)}` : ''
    if (hasAudio) {
      filters.push(
        `[${idx}:a]atrim=start=${round(offset)}:duration=${round(dur * rate)},asetpts=PTS-STARTPTS` +
          /* 音频变速：atempo 单级只吃 0.5–2.0，超出由 atempoChain 拆成多级相乘 */
          speed.atempoChain(rate, round) +
          ',aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo' +
          gainPart +
          fadePartFor(clip, dur) +
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
    const seek = isImage
      ? ''
      : `trim=start=${round(offset)}:duration=${round(dur * pipRate)},${speed.setptsExpr(pipRate, round)},`

    filters.push(`[${idx}:v]${seek}scale=${w}:-2,setsar=1,fps=${fps},format=${pixFmt}${alphaPart}[pipin${i}]`)
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
    filters.push(
      `[${idx}:a]atrim=start=${round(offset)}:duration=${round(dur * bedRate)},asetpts=PTS-STARTPTS` +
        speed.atempoChain(bedRate, round) +
        `,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `volume=${round(gain, 4)}` +
        /* 音频轨（BGM/配音）与画中画原声同样吃淡入/淡出：面板上那条滑杆对
           「音频轨上的片段」也开放，少了这一段就是"能调、成片不变" */
        fadePartFor(clip, dur) +
        `,adelay=${delay}:all=1[mx${i}]`
    )
    extra.push(`[mx${i}]`)
  })

  if (extra.length) {
    filters.push(`${audioLabel}${extra.join('')}amix=inputs=${extra.length + 1}:duration=longest:normalize=0[aout]`)
    audioLabel = '[aout]'
  }

  args.push('-filter_complex', filters.join(';'))
  args.push('-map', videoLabel, '-map', audioLabel)
  args.push('-t', round(finalDuration))
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p')
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
  const targets = (clips || []).filter((clip) => clip.track !== 'audio' && clip.track !== 'text' && clip.kind !== 'image')
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
  const effectMasks = await prepareEffectMasks(bin, clips, options)

  let lastError = ''
  for (let i = 0; i < attempts.length; i += 1) {
    const assumeVideoAudio = attempts[i]
    const plan = buildPlan({
      clips,
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

module.exports = {
  findFfmpeg,
  resetFfmpegCache,
  probe,
  probeStreams,
  buildPlan,
  render,
  extractAudio,
  audioPeaks,
  pathFromMediaUrl,
  sourceOf
}
