'use strict'
/**
 * 字幕文件读写（纯逻辑，唯一真源）。
 *
 * 为什么要单独一个模块：字幕的**四种交换格式**（SRT / VTT / LRC / ASS）都是"看起来
 * 都能解析、实际上每种都有一堆脏变体"的东西。写进 App.jsx 的话，
 * 每个变体都要在界面上点一遍才能验，而这里可以用几十条夹具一次跑完
 * （见 tools/subtitle-selftest.mjs）。
 *
 * 这一族最典型的失效形状是**静默错位**，不是报错：
 *   · SRT 的毫秒位可能是 2 位（`,50` 而不是 `,500`）—— 按 3 位硬切会得到 5 毫秒，
 *     整条字幕往前挪半秒，人眼几乎看不出来，但"字幕比声音早半拍"会一直让人别扭；
 *   · ASS 的字段顺序由 `Format:` 行**自己声明**，不总是
 *     `Layer,Start,End,Style,...` —— 把下标写死，遇到另一种文件就整体错位读成空白；
 *   · LRC 只有开始时间，结束时间必须由**下一行**推 —— 最后一行没有下一行，
 *     一律给 4 秒（够看完，又不至于糊住整段）。
 *
 * 本文件是 **CommonJS**（主进程 CJS，渲染层由 vite 的 commonjs 插件转）：
 * 新增模块必须在 packages/desktop/vite.config.mjs 的 `commonjsOptions.include`
 * 里加一条白名单，否则渲染层 import 到的是空对象 —— 面板上点了没反应，
 * 构建与静态扫描都不报。
 */

/* ------------------------------------------------------------------ *
 * 时间码
 * ------------------------------------------------------------------ */

/**
 * `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` / `H:MM:SS.cc` → 秒。
 *
 * 小数位按**实际位数**缩放：`,5` 是 5/10 秒、`,50` 是 5/100、`,500` 是 5/1000。
 * 这不是讲究 —— SRT 规范是 3 位，但真实文件里 2 位、1 位的都有（手写/别的工具导出）。
 */
function parseTime(raw) {
  const text = String(raw || '').trim().replace(',', '.')
  if (!text) return NaN
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/.exec(text)
  if (!m) return NaN
  const h = m[3] === undefined ? 0 : Number(m[1])
  const mm = m[3] === undefined ? Number(m[1]) : Number(m[2])
  const ss = m[3] === undefined ? Number(m[2]) : Number(m[3])
  const frac = m[4] === undefined ? 0 : Number(`0.${m[4]}`)
  if (![h, mm, ss].every(Number.isFinite)) return NaN
  return h * 3600 + mm * 60 + ss + frac
}

/** 秒 → `HH:MM:SS,mmm`（SRT 口径：逗号 + 固定 3 位） */
function srtTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000))
  const ms = total % 1000
  const totalSec = (total - ms) / 1000
  const ss = totalSec % 60
  const totalMin = (totalSec - ss) / 60
  const mm = totalMin % 60
  const hh = (totalMin - mm) / 60
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`
}

/** 秒 → `HH:MM:SS.mmm`（VTT 口径：点号） */
function vttTime(seconds) {
  return srtTime(seconds).replace(',', '.')
}

/* ------------------------------------------------------------------ *
 * 解析：SRT / VTT
 * ------------------------------------------------------------------ */

/**
 * SRT 与 VTT 的骨架几乎一样（块 + 时间行 + 文本），差异只有三处：
 *   ① 时间码用点还是逗号（两种都认，反正 `parseTime` 都吃）；
 *   ② VTT 允许省略小时（`00:03.500`）—— `parseTime` 已处理；
 *   ③ VTT 有 `WEBVTT` 头、`NOTE` / `STYLE` / `REGION` 块，且时间行后面能跟
 *      `align:start position:10%` 这类设置 —— 都要跳过，否则会被当成字幕正文。
 * 所以合成一个解析器，靠 `header` 参数决定要不要吃掉第一行。
 */
function parseSrtLike(input, { vtt = false } = {}) {
  const text = String(input || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const lines = text.split('\n')
  const cues = []
  let buffer = []

  const flush = () => {
    if (!buffer.length) return
    const block = buffer
    buffer = []
    /* 跳过 VTT 的元块：它们整块都不是字幕 */
    const head = (block[0] || '').trim().toUpperCase()
    if (vtt && (head === 'WEBVTT' || head === 'NOTE' || head === 'STYLE' || head === 'REGION')) return
    if (!vtt && head === 'WEBVTT') return

    const timeIndex = block.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) return
    const timeLine = block[timeIndex]
    /* `-->` 右边可能带 VTT 的 cue settings（`align:start`），先按空白切走 */
    const [left, right] = timeLine.split('-->')
    const endRaw = String(right || '').trim().split(/\s+/)[0]
    const start = parseTime(left)
    const end = parseTime(endRaw)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return
    const body = block
      .slice(timeIndex + 1)
      .join('\n')
      .trim()
    if (!body) return
    cues.push({ start, end, text: body })
  }

  for (const line of lines) {
    if (!line.trim()) {
      flush()
      continue
    }
    /* ⚠️ 块与块之间**不一定有空行**：手写 / 拼接 / 从网页复制下来的字幕经常是
       `正文` 紧接下一块的 `00:00:04,000 --> 00:00:06,000`。只按空行分块时，
       后一块的时间行会被当成前一行的正文吃进去 —— 结果是"导入 1 条，
       正文里带着一段时间码"，界面上看不出是解析错了。
       所以遇到第二个时间行就当场断块。 */
    if (line.includes('-->') && buffer.some((item) => item.includes('-->'))) flush()
    buffer.push(line)
  }
  flush()
  return normalizeCues(cues)
}

/* ------------------------------------------------------------------ *
 * 解析：LRC
 * ------------------------------------------------------------------ */

/**
 * LRC 是"只有开始时间"的格式：`[00:12.34]歌词`。
 *
 * 三个必须处理的实际写法：
 *   ① 一行可以挂**多个**时间标签（`[00:10.00][00:40.00]副歌`）—— 拆成多条；
 *   ② 元信息 `[ar:歌手]` `[ti:标题]` `[offset:+200]` 不是歌词，要跳过；
 *   ③ 结束时间取**下一行**的开始；最后一行给 +4 秒（没有任何依据，但 4 秒够读完
 *      一行中文，且不会糊住后面 —— 这一条是取舍，不是规范）。
 */
function parseLrc(input) {
  const text = String(input || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const raw = []
  let offset = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^\[(ar|ti|al|by|re|ve|length):/i.test(trimmed)) continue
    const offsetHit = /^\[offset:\s*([+-]?\d+)\]/i.exec(trimmed)
    if (offsetHit) {
      offset = Number(offsetHit[1]) / 1000
      continue
    }
    const tags = []
    const tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
    let hit = tagRe.exec(trimmed)
    while (hit) {
      const frac = hit[3] === undefined ? 0 : Number(`0.${hit[3]}`)
      tags.push(Number(hit[1]) * 60 + Number(hit[2]) + frac)
      hit = tagRe.exec(trimmed)
    }
    if (!tags.length) continue
    const body = trimmed.replace(tagRe, '').trim()
    if (!body) continue
    for (const at of tags) raw.push({ start: at + offset, body })
  }
  raw.sort((a, b) => a.start - b.start)
  const cues = raw.map((item, index) => {
    const next = raw[index + 1]
    const end = next && next.start > item.start ? next.start : item.start + 4
    return { start: item.start, end, text: item.body }
  })
  return normalizeCues(cues)
}

/* ------------------------------------------------------------------ *
 * 解析：ASS / SSA
 * ------------------------------------------------------------------ */

/** 去掉 ASS 的覆盖标签 `{\pos(10,20)}` `{\i1}`，并把 `\N` / `\n` 还原成换行 */
function stripAssTags(text) {
  return String(text || '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim()
}

/**
 * ASS / SSA 的字段顺序**由文件自己声明**。
 *
 * `[Events]` 段里有一行 `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`，
 * 后面每个 `Dialogue:` 的逗号分段就按它**逐位对应**。很多文件（尤其老 SSA）的
 * Format 只有 9 项、没有 `Layer`；也有把 `Marked` 放在第一位的。
 *
 * ⚠️ 把下标写死成「第 1 个是开始、第 2 个是结束」是最常见的错法：遇到另一种
 *    Format 就整体错位 —— 读出来的开始时间其实是 Style 名（NaN），于是**整份字幕消失**，
 *    而界面只会显示"导入 0 条"，看起来像文件坏了。所以这里必须按 Format 解析。
 * ⚠️ 正文里可以有逗号（`你好，世界`），所以只能按 `split(',', n)` **限次**切，
 *    最后一个字段吃掉剩余的全部。
 */
function parseAss(input) {
  const text = String(input || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const lines = text.split('\n')
  let inEvents = false
  let format = null
  const cues = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[/.test(trimmed)) {
      inEvents = /^\[events\]$/i.test(trimmed)
      format = null
      continue
    }
    if (!inEvents) continue
    const fmtHit = /^format\s*:\s*(.+)$/i.exec(trimmed)
    if (fmtHit) {
      format = fmtHit[1].split(',').map((piece) => piece.trim().toLowerCase())
      continue
    }
    const dlgHit = /^dialogue\s*:\s*(.+)$/i.exec(trimmed)
    if (!dlgHit) continue
    if (!format) {
      /* 没有 Format 行时按最通用的 10 字段顺序兜底（这是 SSA/ASS 的事实默认） */
      format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
    }
    const cells = dlgHit[1].split(',')
    if (cells.length < format.length) {
      /* 字段不足时补空串 —— 正文为空就跳过，不硬塞半条 */
      while (cells.length < format.length) cells.push('')
    }
    /* 多出来的逗号全部归最后一个字段（正文） */
    const head = cells.slice(0, format.length - 1)
    const tail = cells.slice(format.length - 1).join(',')
    const row = {}
    format.forEach((name, index) => {
      row[name] = index < format.length - 1 ? head[index] : tail
    })
    const start = parseTime(row.start)
    const end = parseTime(row.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const body = stripAssTags(row.text)
    if (!body) continue
    cues.push({ start, end, text: body })
  }
  return normalizeCues(cues)
}

/* ------------------------------------------------------------------ *
 * 编码嗅探
 * ------------------------------------------------------------------ */

/**
 * 字节 → 文本。
 *
 * ⚠️ 中文字幕文件**大量是 GBK/GB18030**（老工具导出、从歌词站下载的 lrc）。
 *    按 UTF-8 硬读不会报错，只会得到一串 `锟斤拷` —— 然后解析器说"没有可用条目"，
 *    用户看到的提示是"这份 SR 里没有字幕"，完全指不到真实原因。
 *
 * 做法：先按 UTF-8 解，出现替换符 `U+FFFD` 说明不是合法 UTF-8，再按 GB18030 解一次。
 * 两个解码器都不可用（极老的 Node）时退回 UTF-8 的原始结果 —— 至少不会抛。
 */
function decodeTextBuffer(bytes) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gb = new TextDecoder('gb18030').decode(buffer)
    /* 只有 GB18030 解出来更"干净"才采用它：反过来也可能是 UTF-8 里本来就有一个字
       恰好是替换符（极少见），这时用 GBK 解反而会全乱。 */
    return gb.includes('\uFFFD') ? utf8 : gb
  } catch {
    return utf8
  }
}

/* ------------------------------------------------------------------ *
 * 归一化与导出
 * ------------------------------------------------------------------ */

/**
 * 所有解析器都过这一道。四条规则：
 *   1. 丢弃时间非法 / 正文为空 / 时长 ≤ 0 的条目；
 *   2. 负数起点钳到 0（LRC 的 `[offset:-500]` 会造出负时间）；
 *   3. 按开始时间**稳定排序**（很多文件是乱的，时间线上按顺序才摆得对）；
 *   4. 结束时间早于开始时间 ⇒ 拉成 0.8 秒，**不丢弃** —— 正文是有价值的，
 *      丢掉等于"导入了 100 条，字幕轨上只有 87 条"，用户数不出来为什么。
 */
function normalizeCues(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item) continue
    const text = String(item.text || '').replace(/\r\n?/g, '\n').trim()
    if (!text) continue
    let start = Number(item.start)
    let end = Number(item.end)
    if (!Number.isFinite(start)) continue
    if (!Number.isFinite(end)) end = start + 0.8
    if (start < 0) start = 0
    if (end <= start) end = start + 0.8
    out.push({ start, end, text })
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  return out
}

/**
 * 按扩展名 + 内容嗅探格式。扩展名优先（`.lrc` 里的 `[00:01.00]` 也能被 SRT 解析器
 * 读成 0 条，所以不能只靠嗅探）。
 */
function detectFormat(filename, text) {
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
  if (ext === 'srt') return 'srt'
  if (ext === 'vtt') return 'vtt'
  if (ext === 'lrc') return 'lrc'
  if (ext === 'ass' || ext === 'ssa') return 'ass'
  const body = String(text || '')
  if (/^\s*WEBVTT/i.test(body)) return 'vtt'
  if (/\[Events\]/i.test(body) && /Dialogue\s*:/i.test(body)) return 'ass'
  if (/^\s*\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/m.test(body)) return 'lrc'
  if (/-->/.test(body)) return 'srt'
  return ''
}

const FORMAT_LABEL = {
  srt: 'SRT 字幕',
  vtt: 'WebVTT 字幕',
  lrc: 'LRC 歌词',
  ass: 'ASS / SSA 字幕'
}

/**
 * 读一份字幕文件的内容。返回 `{ ok, format, cues, error }`。
 *
 * 不抛异常：调用方是 IPC handler 与界面，抛出去只会变成一句
 * "导入失败：Cannot read properties of undefined" —— 用户看不懂、我们也查不到。
 */
function readSubtitles(text, filename) {
  const body = String(text || '')
  if (!body.trim()) return { ok: false, format: '', cues: [], error: '文件是空的' }
  const format = detectFormat(filename, body)
  if (!format) {
    return { ok: false, format: '', cues: [], error: '认不出字幕格式（支持 SRT / VTT / LRC / ASS）' }
  }
  let cues = []
  try {
    if (format === 'srt') cues = parseSrtLike(body)
    else if (format === 'vtt') cues = parseSrtLike(body, { vtt: true })
    else if (format === 'lrc') cues = parseLrc(body)
    else cues = parseAss(body)
  } catch (error) {
    return { ok: false, format, cues: [], error: `解析出错：${(error && error.message) || '未知原因'}` }
  }
  if (!cues.length) {
    return { ok: false, format, cues: [], error: `这是一份 ${FORMAT_LABEL[format] || format}，但里面没有可用的字幕条目` }
  }
  return { ok: true, format, cues, error: '' }
}

/** cue 列表 → SRT 文本。CRLF：Windows 播放器 / 剪辑软件的兼容性最好。 */
function toSrt(cues) {
  const list = normalizeCues(cues)
  return (
    list
      .map((cue, index) => `${index + 1}\r\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\r\n${cue.text}\r\n`)
      .join('\r\n') || ''
  )
}

/** cue 列表 → VTT 文本（点号时间码 + WEBVTT 头） */
function toVtt(cues) {
  const list = normalizeCues(cues)
  return (
    'WEBVTT\r\n\r\n' +
    list
      .map((cue, index) => `${index + 1}\r\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\r\n${cue.text}\r\n`)
      .join('\r\n')
  )
}

/**
 * 时间线上的文字片段 → cue 列表（导出字幕用）。
 *
 * ⚠️ 只取 `track === 'text'`：叠加轨（overlay）与画中画里也可能有 `text` 字段，
 *    但它们不是"字幕"，导出成 srt 会把画面上的贴字混进来。
 */
function cuesOfClips(clips) {
  const list = []
  for (const clip of Array.isArray(clips) ? clips : []) {
    if (!clip || clip.track !== 'text') continue
    const start = Number(clip.start)
    const duration = Number(clip.duration)
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) continue
    const text = String(clip.text || clip.name || '').trim()
    if (!text) continue
    list.push({ start: Math.max(0, start), end: Math.max(0, start) + duration, text })
  }
  return normalizeCues(list)
}

/* ------------------------------------------------------------------ *
 * 语音分句（VAD）
 * ------------------------------------------------------------------ */

/**
 * 从振幅包络里找出"有人在说话"的区间。
 *
 * 输入是主进程 `media:peaks` 抽出来的包络（每桶一个 0–1 的数），
 * 与"变速卡点"（shared/beat.js）吃同一份数据 —— 区别只在于：
 *   · 卡点找的是**上升沿**（变响的那一刻）；
 *   · 分句找的是**持续的响**（一整句话说多久）。
 *
 * 算法五步，每一步都对应一种"看起来很智能、其实不能用"的错法：
 *   ① 三点平滑：包络有毛刺，不平滑会让一句话被切成十几个碎片；
 *   ② **自适应**阈值：噪声底取 20 分位、峰值取 90 分位，阈值 = 底 + (峰 − 底) × 0.28。
 *      写死阈值（比如 0.1）时，安静的录音全是"静音"、嘈杂的录音全是"人声"；
 *   ③ 短静音合并（≤ durGap）：人说话本来就有停顿，不合并会把"今天天气，嗯，不错"
 *      切成三段，字幕变成三个碎片；
 *   ④ 过短丢弃（< minDur）：咳一声、碰一下麦克风不该成为一条字幕；
 *   ⑤ 过长拆分（> maxDur）：一条字幕挂 20 秒，用户根本读不完，
 *      在段内**能量最低处**切（不是均分 —— 均分会把词切成两半）。
 */
function vadSegments(peaks, options = {}) {
  const list = Array.isArray(peaks) ? peaks : []
  const per = Number(options.secondsPerBucket) > 0 ? Number(options.secondsPerBucket) : 0
  if (!list.length || !per) return []
  const minDur = Number(options.minDur) > 0 ? Number(options.minDur) : 0.32
  const maxDur = Number(options.maxDur) > 0 ? Number(options.maxDur) : 9
  const gapTol = Number(options.gapTol) > 0 ? Number(options.gapTol) : 0.28

  const values = list.map((value) => Math.max(0, Math.min(1, Number(value) || 0)))
  const smooth = values.map((value, index) => {
    const prev = index > 0 ? values[index - 1] : value
    const next = index < values.length - 1 ? values[index + 1] : value
    return (prev + value + next) / 3
  })
  const sorted = [...smooth].sort((a, b) => a - b)
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  const floor = pick(0.2)
  const ceiling = pick(0.9)
  /* 整段几乎没声音（底噪 + 静音）⇒ 没有"说话"可言，直接返回空，
     不要硬按阈值切出一堆碎片。
     ⚠️ 判据用**绝对电平**，不用"峰谷差"。之前写成 `ceiling - floor < 0.02` 时，
        一段经过压限、电平被抬得很平的正常人声会被判成"没动态 ⇒ 没人说话"，
        用户按下按钮得到 0 条，看起来像功能坏了。恒定电平只说明"没有起伏"，
        不代表"没有声音"。 */
  if (ceiling < 0.15) return []
  /* 电平完全平（录音经过压限 / 整段噪声）时按"整段持续有声"处理：阈值压到 ceiling 之下，
     所有桶都过线 —— 于是它会按 maxDur 被切成等长的几段。
     这是**取舍**：噪声也会被切成字幕段，但比"整段有声音却返回 0 条"好，
     用户在预览里一听就知道要删。 */
  const flat = ceiling - floor < 0.02
  const threshold = flat ? ceiling - 0.001 : floor + (ceiling - floor) * 0.28

  const runs = []
  let opened = -1
  for (let i = 0; i < smooth.length; i += 1) {
    const loud = smooth[i] >= threshold
    if (loud && opened < 0) opened = i
    if (!loud && opened >= 0) {
      runs.push([opened, i - 1])
      opened = -1
    }
  }
  if (opened >= 0) runs.push([opened, smooth.length - 1])

  const gapBuckets = Math.max(1, Math.round(gapTol / per))
  const merged = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last && run[0] - last[1] - 1 <= gapBuckets) last[1] = run[1]
    else merged.push([...run])
  }

  const out = []
  for (const [from, to] of merged) {
    const start = from * per
    const end = (to + 1) * per
    if (end - start < minDur) continue
    if (end - start <= maxDur) {
      out.push({ start, end })
      continue
    }
    /* 过长：在段内找能量最低点，左右各留 30% 以上的长度，避免切出碎片 */
    let cursor = from
    while ((to + 1) * per - cursor * per > maxDur) {
      const limit = Math.min(to, cursor + Math.round(maxDur / per))
      const lowest = Math.max(cursor + 1, Math.round((maxDur / per) * 0.4))
      let cut = limit
      let best = Infinity
      for (let i = cursor + lowest; i <= limit; i += 1) {
        if (smooth[i] <= best) {
          best = smooth[i]
          cut = i
        }
      }
      out.push({ start: cursor * per, end: cut * per })
      cursor = cut
    }
    if ((to + 1) * per - cursor * per >= minDur) out.push({ start: cursor * per, end: (to + 1) * per })
  }
  return out
}

/**
 * 语音区间 → 空字幕（只切时间轴，文字留空待填）。
 *
 * 首尾各留 60ms 的呼吸位：切得紧贴语音时，字幕会"声音刚起就浮现、刚停就消失"，
 * 观感上像闪。这是纯审美取舍，但很显眼。
 */
function cuesFromSpeech(segments, options = {}) {
  const pad = Number(options.pad) >= 0 ? Number(options.pad) : 0.06
  const minDur = Number(options.minDur) > 0 ? Number(options.minDur) : 0.6
  const cues = []
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg) continue
    const start = Math.max(0, Number(seg.start) - pad)
    const end = Math.max(start + minDur, Number(seg.end) + pad)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    cues.push({ start, end, text: '' })
  }
  return cues
}

module.exports = {
  parseTime,
  srtTime,
  vttTime,
  decodeTextBuffer,
  parseSrtLike,
  parseLrc,
  parseAss,
  stripAssTags,
  normalizeCues,
  detectFormat,
  readSubtitles,
  toSrt,
  toVtt,
  cuesOfClips,
  vadSegments,
  cuesFromSpeech,
  FORMAT_LABEL
}
