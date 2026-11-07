'use strict'
/**
 * 音频的真源：**音量包络**（预览与导出必须同一份）+ **导出阶段的母带处理预设**。
 *
 * 两类东西放一个文件，但性质完全不同，注释里分得很清楚：
 *
 *   ① 音量包络（volumeKf）—— **预览与导出逐点同源**。
 *      预览每帧把插值结果乘到 `<video>.volume` 上，导出把它写成 ffmpeg 的
 *      `volume='<表达式>'`。两边的插值函数都是本文件的 `volumeAt` / `volumeExpr`，
 *      所以"时间线上一段声音渐弱"在预览里听得到、在成片里也听得到。
 *
 *   ② 母带 / 修复类（响度统一、降噪、防抖）—— 只在**导出**生效。
 *      它们不是"调一个参数、画面/声音当场变"的东西（响度统一要看整段统计），
 *      强行在预览里做只会得到一个不准的近似。所以界面上这几项都带
 *      「导出时应用」标记，不假装预览里已经生效 —— 这是本项目的硬约定。
 */

/** 音量包络的采样点上限：再多就不是"手调"了，而是在画一条曲线 */
const VOLUME_KF_MAX = 64

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const round4 = (value) => Number(Number(value).toFixed(4))

/**
 * 读音量包络：`[{t, v}]`（t = 片段内秒数，v = 音量百分比 0–200）。
 * 非法点一律丢弃；按 t 升序去重（同 t 保留后写的那一个）。
 */
function readVolumeKf(src) {
  if (!Array.isArray(src)) return []
  const out = []
  for (const point of src) {
    if (!point || typeof point !== 'object') continue
    const t = num(point.t, NaN)
    const v = num(point.v, NaN)
    if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0) continue
    out.push({ t: round4(t), v: round4(clamp(v, 0, 200)) })
  }
  out.sort((a, b) => a.t - b.t)
  const dedup = []
  for (const point of out) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1].t - point.t) < 1e-4) dedup[dedup.length - 1] = point
    else dedup.push(point)
  }
  return dedup.slice(0, VOLUME_KF_MAX)
}

const hasVolumeKf = (points) => Array.isArray(points) && points.length > 0

/**
 * 片段内 `t` 秒处的音量百分比（线性插值、两端夹取）。
 * 没有包络时返回 base（片段上那个音量滑杆的值）。
 */
function volumeAt(points, t, base = 100) {
  const list = Array.isArray(points) ? points : []
  if (!list.length) return num(base, 100)
  const time = Math.max(0, num(t))
  if (time <= list[0].t) return list[0].v
  const last = list[list.length - 1]
  if (time >= last.t) return last.v
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]
    const b = list[i]
    if (time <= b.t) {
      const span = b.t - a.t
      if (span <= 1e-6) return b.v
      const p = (time - a.t) / span
      return round4(a.v + (b.v - a.v) * p)
    }
  }
  return last.v
}

/**
 * 音量包络 → ffmpeg `volume` 的表达式（**不含** `volume=` 前缀）。
 *
 * ⚠️ 表达式里的 `t` 是**滤镜链当前时间**，而调用处已经 `asetpts=PTS-STARTPTS`
 *    把片段起点归零，所以包络的时间轴（片段内秒数）与它天然对齐。
 *    少了那次重置，2 秒处放置的片段会把包络整体推迟 2 秒生效。
 * ⚠️ 数值一律用 `0.5000` 这种定点写法：`0.30000000000000004` 会让对拍断言变脆，
 *    而 ffmpeg 的表达式求值器对超长浮点串也更慢。
 *
 * @returns {string} 形如 `if(lte(t,0),1.2000,...)`；无包络时返回 ''
 */
function volumeExpr(points) {
  const list = Array.isArray(points) ? points : []
  if (!list.length) return ''
  const v = (value) => round4(num(value) / 100)
  if (list.length === 1) return v(list[0].v).toFixed(4)
  let expr = v(list[list.length - 1].v).toFixed(4)
  for (let i = list.length - 2; i >= 0; i -= 1) {
    const a = list[i]
    const b = list[i + 1]
    const span = Number((b.t - a.t).toFixed(4))
    const va = v(a.v)
    const vb = v(b.v)
    if (span <= 1e-4) {
      expr = `if(lte(t,${a.t.toFixed(4)}),${va.toFixed(4)},${expr})`
      continue
    }
    const slope = round4((vb - va) / span)
    expr =
      `if(lte(t,${a.t.toFixed(4)}),${va.toFixed(4)},` +
      `if(lte(t,${b.t.toFixed(4)}),${va.toFixed(4)}+${slope.toFixed(4)}*(t-${a.t.toFixed(4)}),${expr}))`
  }
  return expr
}

/**
 * 响度统一（导出阶段）。
 *
 * 数值是行业里那几套常用目标：
 *   · 网络 / 短视频 —— -14 LUFS（与国际流媒体平台的响度目标同一量级）
 *   · 影视广播   —— -23 LUFS（EBU R128）
 *   · 播客       —— -16 LUFS
 *
 * ⚠️ 它作用在**混完的整条音轨**上（amix 之后），不是逐片段：
 *    逐片段各自拉到同一个响度，混起来反而更乱。
 */
const LOUDNESS_MODES = [
  { key: 'off', label: '不处理' },
  { key: 'web', label: '网络 -14 LUFS', I: -14 },
  { key: 'tv', label: '广播 -23 LUFS', I: -23 },
  { key: 'podcast', label: '播客 -16 LUFS', I: -16 }
]

function loudnormFor(modeKey, round = round4) {
  const item = LOUDNESS_MODES.find((entry) => entry.key === modeKey)
  if (!item || !Number.isFinite(item.I)) return ''
  return `loudnorm=I=${round(item.I, 1)}:TP=-1.5:LRA=11`
}

/**
 * 音频降噪（导出阶段）→ `afftdn`。
 * `afftdn` 是频域降噪：对底噪（空调声 / 电流声）有效，对人声本身也会轻微打磨，
 * 所以默认档位给得保守（nr=12dB），强度可调。
 */
function audioDenoiseFilter(level, round = round4) {
  const strength = clamp(num(level, 0), 0, 100)
  if (strength < 1) return ''
  const nr = round(6 + (strength / 100) * 18, 1)
  return `afftdn=nr=${nr}:nf=-25`
}

/**
 * 视频降噪（导出阶段）→ `hqdn3d`。
 * 空间项（luma/chroma spatial）把噪点抹掉，时间项（tmp）压住闪烁。
 * 强度 0–100 映射到 0–3 的空间半径：再大画面会像糊了一层。
 */
function videoDenoiseFilter(level, round = round4) {
  const strength = clamp(num(level, 0), 0, 100)
  if (strength < 1) return ''
  const spatial = round((strength / 100) * 3, 2)
  const tmp = round((strength / 100) * 2, 2)
  return `hqdn3d=${spatial}:${spatial}:${tmp}:${tmp}`
}

/**
 * 视频防抖（导出阶段）→ `deshake`。
 *
 * 为什么用 `deshake` 而不是 `vidstab`：`vidstab` 需要两遍处理（先 detect 写
 * transforms 文件、再 transform），而我们的命令构造是**一次成型**的同步函数。
 * 为了它单独加一遍预处理，导出耗时翻倍、还要管临时文件的生命周期。
 * `deshake` 是单遍的，对"手持轻微抖动"这个主场景效果足够，代价是边缘会有裁切
 * —— 用 `edge=mirror` 把露出来的边补上，避免一圈黑边。
 */
function stabilizeFilter(level, round = round4) {
  const strength = clamp(num(level, 0), 0, 100)
  if (strength < 1) return ''
  const range = Math.round(8 + (strength / 100) * 56)
  const contrast = Math.round(80 + (strength / 100) * 80)
  return `deshake=rx=${range}:ry=${range}:edge=mirror:blocksize=8:contrast=${contrast}`
}

/**
 * 立体声平衡（pan）→ `pan=stereo|c0=gl*c0|c1=gr*c1`。
 *
 * 语义选的是**平衡（balance）**而不是**声像（panning）**：左右两条声道各乘一个
 * 独立增益，不把两声道混成单声道再摆位。理由是配音/配乐本来就是立体声，
 * 混成单声道再摆位会把立体声场压扁（听感是"变窄"），而用户拖这个滑杆
 * 想达到的是"这一轨整体偏左一点"。
 *
 * 增益用**线性**（不是等功率）：中心必须恰好是 1/1，否则"没动过"的片段
 * 也会被削 3 dB —— 那是经典误用，症状是"加了功能以后所有片子都变小声"。
 *
 * ⚠️ 预览里不做：`<audio>`/`<video>` 的 `volume` 是单值，没法按声道分增益；
 *    要真做只能把每个媒体元素接进 WebAudio 图（MediaElementSource 只能建一次，
 *    建失败就是整条预览静音）。所以它和降噪/防抖同一档：面板标「导出时应用」。
 */
function panFilter(pan, round = round4) {
  const value = Number(pan)
  if (!Number.isFinite(value)) return ''
  const p = clamp(value, -100, 100) / 100
  if (Math.abs(p) < 0.005) return ''
  const left = round(Math.min(1, 1 - p), 3)
  const right = round(Math.min(1, 1 + p), 3)
  return `pan=stereo|c0=${left}*c0|c1=${right}*c1`
}

/**
 * 人声增强（导出阶段）→ 高通 + 中频提亮 + 压缩器。
 *
 * 和「降噪」是两件事，顺序不能反：降噪先削掉底噪（否则压缩器会把底噪一起抬起来），
 * 增强再动音色。三段的分工：
 *   · `highpass` 去 85Hz 以下的隆隆声（桌面震动、空调低频、手持摩擦）；
 *   · `equalizer` 在 280Hz 压一点（"闷"的来源）、2.8kHz 提一点（辅音的清晰度所在）；
 *   · `acompressor` 把忽大忽小压到同一个水平，`makeup` 补回被压掉的响度。
 * ⚠️ 预览里不做（`<audio>` 没有等价滤镜），面板上标「导出时应用」。
 */
function voiceEnhanceFilter(level, round = round4) {
  const strength = clamp(num(level, 0), 0, 100)
  if (strength < 1) return ''
  const k = strength / 100
  const mid = round(1.5 + k * 3.5, 1)
  const cut = round(-0.5 - k * 2.5, 1)
  const ratio = round(1.5 + k * 2.5, 1)
  return (
    'highpass=f=85,lowpass=f=12000,' +
    `equalizer=f=280:width_type=o:width=1.6:g=${cut},` +
    `equalizer=f=2800:width_type=o:width=1.2:g=${mid},` +
    `acompressor=threshold=${round(-12 - k * 10, 0)}dB:ratio=${ratio}:attack=6:release=160:makeup=2`
  )
}

/**
 * 变声预设（导出阶段）。
 *
 * ⚠️ 三个必须记住的约束：
 *  1. 改采样率的几个（花栗鼠 / 低沉）**必须**紧跟 `aresample` 回到 48kHz，
 *     再用 `atempo` 把时长拉回来 —— 只写 `asetrate` 的话是"变调 + 变速"，
 *     片段会短掉一截，和视频对不上，而且轨道上看着一切正常。
 *  2. `atempo` 单级只吃 0.5–2.0，这里几个预设的倍率都在范围内，不需要拆链。
 *  3. 机器人和电话是**近似**：ffmpeg 没有真正的环形调制，用 `acrusher`（位深压缩）
 *     加 `tremolo` / 频段限制来做出"机械""细窄"的听感。要更真得上模型，不在本机方案内。
 *
 *  ⚠️ 这里**故意不放回声类预设**（`aecho`）：它会把输出拖长一个尾巴（实测 3 秒的源
 *     变 3.08 秒），而片段时长是按视频定的 —— 尾巴会挤进下一段，音画对不上。
 *     要对齐就得在导出的音频链末尾再加一道按 dur 的 atrim，那是给一个"听着好玩"的
 *     效果付全局风险，不划算。
 */
const VOICE_CHANGES = [
  { key: 'none', label: '原声' },
  { key: 'chipmunk', label: '花栗鼠' },
  { key: 'deep', label: '低沉' },
  { key: 'phone', label: '电话' },
  { key: 'robot', label: '机器人' },
  { key: 'radio', label: '电台' }
]

function voiceChangeFilter(key) {
  switch (String(key || 'none')) {
    case 'chipmunk':
      /* 采样率 ×1.32 ⇒ 音高升高约 5 个半音；atempo 1/1.32 把时长拉回原样。
         ⚠️ 开头那句 `aformat` 不是装饰：`asetrate` 的数值是**绝对采样率**，
            上游如果不是 48kHz（44.1kHz 的素材很常见），倍率就不是 1.32，
            症状是"变调了、时长也短了一截"，而轨道和面板一切正常。
            自己声明一次，链内就不依赖调用方的顺序。 */
      return 'aformat=sample_rates=48000,asetrate=63360,aresample=48000,atempo=0.7576'
    case 'deep':
      /* ×0.78 ⇒ 降低约 4.5 个半音，同样拉回时长 */
      return 'aformat=sample_rates=48000,asetrate=37440,aresample=48000,atempo=1.2821'
    case 'phone':
      /* 300–3400Hz 是电话频段；再叠一点位深压缩做出"压缩感" */
      return 'highpass=f=300,lowpass=f=3400,acrusher=bits=10:mode=log:mix=0.25'
    case 'robot':
      /* 位深压缩 + 快速颤动 = 机械感。颤动频率取 32Hz（人声基频之上，听着像"金属"） */
      return 'acrusher=bits=6:mode=log:mix=0.4,tremolo=f=32:d=0.75'
    case 'radio':
      return 'highpass=f=180,lowpass=f=6200,acompressor=threshold=-16dB:ratio=5:attack=4:release=120'
    default:
      return ''
  }
}

module.exports = {
  VOLUME_KF_MAX,
  LOUDNESS_MODES,
  VOICE_CHANGES,
  readVolumeKf,
  hasVolumeKf,
  volumeAt,
  volumeExpr,
  loudnormFor,
  audioDenoiseFilter,
  videoDenoiseFilter,
  stabilizeFilter,
  panFilter,
  voiceEnhanceFilter,
  voiceChangeFilter
}
