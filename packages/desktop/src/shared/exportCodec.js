/**
 * 导出编码格式（容器 / 编码器 / 色深 / 是否带 Alpha）。
 *
 * 面板、导出与闸门**只认这一份表**：主进程按它拼 ffmpeg 参数，渲染层按它列可选项、
 * 按它决定保存对话框的扩展名。两侧各写一份的话，最容易出现的错是
 * 「面板上选了 ProRes 4444，主进程仍 `-pix_fmt yuv420p`」——
 * 成片照旧生成、时长与画面都对，只是没有 alpha，一句错都不报。
 *
 * 几条与 ffmpeg 相关的硬事实（写在这里，免得下次重新踩）：
 *   · **10bit 的像素格式随编码器不同**：软编 libx265 收 `yuv420p10le`，
 *     而 hevc_nvenc / hevc_qsv / hevc_amf 这类硬件编码器只收 `p010le`
 *     （10 位塞在 16 位里）。给错了 ffmpeg 会直接拒绝该 pix_fmt。
 *   · **ProRes 4444 是 12 位**：ffmpeg 的 prores_ks 对 4444 一律写 12 位，
 *     传 `-pix_fmt yuva444p10le` 也照样得 `yuva444p12le`（实测），所以表里写 12。
 *   · **ProRes 没有 crf**：质量由 profile 决定（422 是 HQ，4444 才是带 alpha 的那档）。
 *     拿码率/画质档去调它不会有任何效果，所以面板上要如实禁用这些控件。
 *   · **容器与编码器必须配套**：ProRes 进 mp4 会被 ffmpeg 拒绝
 *     （`codec not currently supported in container`），所以扩展名要跟着编码格式走。
 *   · HEVC 进 mp4 要显式 `-tag:v hvc1`：默认的 `hev1` 标签 QuickTime / Safari 拒播，
 *     表现是「本机 PotPlayer 能放、发给客户说打不开」。
 */

/** 每个「编码族」里可用的具体编码器，第一个永远是软件编码（兜底） */
const FAMILIES = {
  h264: ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'],
  hevc: ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf'],
  prores: ['prores_ks']
}

const CODECS = [
  {
    key: 'h264',
    label: 'H.264 / AVC',
    family: 'h264',
    container: 'mp4',
    ext: 'mp4',
    containerLabel: 'MP4',
    pixFmt: 'yuv420p',
    bitDepth: 8,
    alpha: false,
    /* ProRes 之外的编码器都用 crf/cq 控质量，所以码率控制那组控件对它们才有意义 */
    variableQuality: true,
    note: '兼容性最好，任何平台都能播'
  },
  {
    key: 'h265',
    label: 'H.265 / HEVC',
    family: 'hevc',
    container: 'mp4',
    ext: 'mp4',
    containerLabel: 'MP4',
    pixFmt: 'yuv420p',
    bitDepth: 8,
    alpha: false,
    variableQuality: true,
    note: '同画质体积约省一半，老设备可能播不了'
  },
  {
    key: 'h265-10',
    label: 'H.265 10bit',
    family: 'hevc',
    container: 'mp4',
    ext: 'mp4',
    containerLabel: 'MP4',
    pixFmt: 'yuv420p10le',
    bitDepth: 10,
    alpha: false,
    variableQuality: true,
    note: '10 位色深，暗部渐变不容易出色带；播放端要支持 Main10'
  },
  {
    key: 'prores-422',
    label: 'ProRes 422',
    family: 'prores',
    container: 'mov',
    ext: 'mov',
    containerLabel: 'MOV',
    pixFmt: 'yuv422p10le',
    bitDepth: 10,
    alpha: false,
    profile: 3,
    variableQuality: false,
    note: '后期剪辑用的中间格式，文件大、几乎无损'
  },
  {
    key: 'prores-4444',
    label: 'ProRes 4444（Alpha）',
    family: 'prores',
    container: 'mov',
    ext: 'mov',
    containerLabel: 'MOV',
    /* ⚠️ 12 位，不是 10 位 —— 这是**实测**出来的，不是笔误：
       ffmpeg 的 prores_ks 对 profile 4444 一律写 12 位，即使显式传
       `-pix_fmt yuva444p10le` 也照样产出 `yuva444p12le`（本机 8.1.2 实测）。
       写 10le 的话参数看着对、ffprobe 读回来是 12le，闸门与注释会长期对不上，
       而"到底几位"只有产物说了算。ProRes 4444 本身就是 12 位 4:4:4 的规格。 */
    pixFmt: 'yuva444p12le',
    bitDepth: 12,
    alpha: true,
    profile: 4,
    variableQuality: false,
    note: '保留透明通道：抠像 / 字幕素材交给后期叠加用'
  }
]

const DEFAULT_KEY = 'h264'
const VIDEO_EXTS = ['.mp4', '.mov']

const byKey = new Map(CODECS.map((item) => [item.key, item]))

/** 规范化：未知值一律回落默认（不抛错，但调用方拿到的永远是表里存在的那一项） */
function readCodec(value) {
  const key = String(value || '').trim().toLowerCase()
  return byKey.get(key) || byKey.get(DEFAULT_KEY)
}

function keyOf(value) {
  return readCodec(value).key
}

function containerOf(value) {
  return readCodec(value).container
}

function extensionOf(value) {
  return readCodec(value).ext
}

function acceptsAlpha(value) {
  return readCodec(value).alpha === true
}

/**
 * 实际交给 ffmpeg 的像素格式。
 *
 * 10bit + 硬件编码器要用 `p010le`（10 位放在 16 位容器的高位），
 * 只有软件编码 libx265 才收 `yuv420p10le`。写死 yuv420p10le 的话，
 * 选了硬件加速 10bit 的导出会直接失败在 "Incompatible pixel format"。
 */
function pixelFormatFor(codecValue, encoderKey) {
  const codec = readCodec(codecValue)
  const enc = String(encoderKey || '')
  if (codec.bitDepth === 10 && codec.family === 'hevc' && /^(hevc)_(nvenc|qsv|amf)$/.test(enc)) {
    return 'p010le'
  }
  return codec.pixFmt
}

/**
 * 在**同一编码族内**挑一个可用编码器。
 *
 * ⚠️ 绝不能回落跨族编码器（比如选了 ProRes 却回落 libx264）：容器是 mov、
 *    编码器是 h264 的成片能生成出来，但面板上写的是 ProRes 4444 —— 
 *    用户拿到的既不是无损、也没有 alpha，而流程报成功。
 */
function pickEncoder(codecValue, wanted) {
  const codec = readCodec(codecValue)
  const list = FAMILIES[codec.family] || FAMILIES.h264
  const key = String(wanted || '')
  if (list.includes(key)) return key
  /* 只在「编码器与格式明显对不上」时才回落：h264_nvenc 选着 h265 这类 */
  return list[0]
}

/**
 * 面板下拉里要列哪些编码器。
 *
 * `available` 是主进程 probe 出来的真实清单（ffmpeg -encoders）。探测还没回来时
 * 调用方会给 `['libx264']`，这时 hevc 族会一个都匹配不上 —— 仍然返回该族的软件编码，
 * 因为「摆一个待定的空下拉」比「摆一个软件编码」更糟；软件编码在正常 ffmpeg 里都有。
 */
function encodersFor(codecValue, available) {
  const codec = readCodec(codecValue)
  const list = FAMILIES[codec.family] || FAMILIES.h264
  const have = Array.isArray(available) ? available.map((item) => String(item)) : []
  const hit = list.filter((key) => have.includes(key))
  return hit.length ? hit : [list[0]]
}

/** 这个编码格式本机能不能编（面板据此把选不了的格式标灰） */
function supported(codecValue, available) {
  const codec = readCodec(codecValue)
  const list = FAMILIES[codec.family] || FAMILIES.h264
  const have = Array.isArray(available) ? available : []
  return list.some((key) => have.includes(key))
}

/**
 * 把输出路径的扩展名换成该编码格式要求的那个。
 *
 * 不换的后果不是「多一个怪文件名」，而是 ffmpeg 直接失败：
 * `Could not find tag for codec prores in stream #0`。
 */
function matchExtension(outPath, codecValue) {
  const text = String(outPath || '')
  if (!text) return text
  const codec = readCodec(codecValue)
  const dot = text.lastIndexOf('.')
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  const stem = dot > slash ? text.slice(0, dot) : text
  return `${stem}.${codec.ext}`
}

/** 音频参数：MOV（ProRes）走 PCM，MP4 走 AAC —— NLE 读 ProRes 时最不挑的组合 */
function audioArgs(codecValue) {
  if (readCodec(codecValue).container === 'mov') {
    return ['-c:a', 'pcm_s16le', '-ar', '48000']
  }
  return ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
}

/** 保存对话框的文件过滤器 */
function dialogFilters(codecValue) {
  const codec = readCodec(codecValue)
  return [{ name: `${codec.containerLabel} 视频`, extensions: [codec.ext] }]
}

module.exports = {
  CODECS,
  FAMILIES,
  DEFAULT_KEY,
  VIDEO_EXTS,
  readCodec,
  keyOf,
  containerOf,
  extensionOf,
  acceptsAlpha,
  pixelFormatFor,
  pickEncoder,
  encodersFor,
  supported,
  matchExtension,
  audioArgs,
  dialogFilters
}
