'use strict'
/**
 * 字幕预设 —— 运行时唯一真源。
 *
 * 清单在 `subtitlePresets.json`（由 tools/gen-subtitle-presets.mjs 生成，
 * 内含 857 款「参数」：样式 / 落点 / 对齐 / 字号 / 入场 / 循环 / 行数 / 条数）。
 * 本文件负责把参数翻译成**要落进时间线的片段**，以及给界面看的说明文字。
 *
 * ── 为什么翻译必须只有一份 ────────────────────────────────────────
 *
 * 界面点一张卡 = 调 `planPreset()`；MCP 的 catalog 也要透出"点它会得到哪几条片段"。
 * 两边各写一遍的话，迟早出现"界面插了 3 条、agent 只插了 1 条"这类偏差，
 * 而两边都不报错。所以 `planPreset` 是唯一入口，UI 与 catalog 都读它的输出。
 *
 * ── 预设到底"是"什么 ─────────────────────────────────────────────
 *
 * 素材包给的是**已经渲染好的 mp4**（效果烤在画面里），动画曲线与文字参数一个都拿不到。
 * 所以一款预设 = 一套确定性参数，按名字里的排版关键词解析出来
 * （见生成器头注释）。三条纪律：
 *   ① 名字说了就听名字（「三排」= 三行、「顶部」= 落顶部、「弹出」= 缩放进场）；
 *   ② 名字没说的那几格按组内序号从固定调色板取，保证一屏里不撞成一片；
 *   ③ 卡片上看到的就是真效果 —— 卡片的排版与这里产出的片段用的是同一套数值。
 *
 * CommonJS（与 shared/handFonts.js、shared/textOverrides.js 同一形制）。
 * ⚠️ 新增 shared 下的 CJS 模块必须同步加进 packages/desktop/vite.config.mjs 的
 *    `commonjsOptions.include`，否则渲染层 import 到的是空对象。
 */

const table = require('./subtitlePresets.json')
const { IN_TYPES, OUT_TYPES, LOOP_TYPES } = require('./textAnim.js')

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 预设的默认值 —— 清单里省掉的字段由这里补齐（省掉是为了让 JSON 只有 200KB 而不是 400KB） */
const DEFAULTS = {
  style: 'sub-plain',
  anchor: 'bottom',
  align: 'center',
  offset: 56,
  scale: 1,
  in: 'up',
  out: 'fade',
  loop: 'none',
  inDur: 0.36,
  outDur: 0.3,
  rows: 1,
  chain: 1,
  mode: 'stack'
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const ANCHORS = ['top', 'center', 'bottom']
const ALIGNS = ['left', 'center', 'right']
/** 与 shared/textOverrides.js 的范围一致：越界写进去会被夹，但预览与导出必须夹成同一个值 */
const OFFSET_MAX = 600
const SCALE_MIN = 0.4
const SCALE_MAX = 2.5

/** 单条片段时长的下限：短于这个值 ffmpeg 那边一帧都抽不到 */
const MIN_CLIP_SECONDS = 0.6

/** 清单 → 补齐默认值后的一款预设（不改原对象） */
function normalize(row) {
  const src = row || {}
  const anchor = ANCHORS.includes(src.anchor) ? src.anchor : DEFAULTS.anchor
  const pick = (list, key, fallback) => list.find((item) => item.key === key) || list.find((item) => item.key === fallback)
  return {
    key: String(src.key || ''),
    name: String(src.name || ''),
    src: String(src.src || src.name || ''),
    group: String(src.group || ''),
    style: String(src.style || DEFAULTS.style),
    anchor,
    align: ALIGNS.includes(src.align) ? src.align : DEFAULTS.align,
    /* 居中时 offset 没有意义，统一归零 —— 否则界面上会出现"居中了但离顶 200px"这种看不懂的状态 */
    offset: anchor === 'center' ? 0 : clamp(num(src.offset, DEFAULTS.offset), 0, OFFSET_MAX),
    scale: clamp(num(src.scale, DEFAULTS.scale), SCALE_MIN, SCALE_MAX),
    in: (pick(IN_TYPES, src.in, DEFAULTS.in) || IN_TYPES[0]).key,
    out: (pick(OUT_TYPES, src.out, DEFAULTS.out) || OUT_TYPES[0]).key,
    loop: (pick(LOOP_TYPES, src.loop, DEFAULTS.loop) || LOOP_TYPES[0]).key,
    inDur: clamp(num(src.inDur, DEFAULTS.inDur), 0.1, 2),
    outDur: clamp(num(src.outDur, DEFAULTS.outDur), 0.1, 2),
    rows: clamp(Math.round(num(src.rows, DEFAULTS.rows)), 1, 3),
    chain: clamp(Math.round(num(src.chain, DEFAULTS.chain)), 1, 4),
    mode: src.mode === 'seq' ? 'seq' : 'stack',
    numbered: src.numbered === true
  }
}

const PRESETS = table.presets.map(normalize)
const BY_KEY = new Map(PRESETS.map((item) => [item.key, item]))
const GROUPS = table.groups.map((g) => ({ key: g.key, label: g.label, note: g.note || '', count: g.count }))

/** 某一组（`''` / `'all'` = 全部）。组号越界返回空数组，不抛错。 */
function presetsOfGroup(groupKey) {
  const key = String(groupKey || '')
  if (!key || key === 'all') return PRESETS
  return PRESETS.filter((item) => item.group === key)
}

const presetByKey = (key) => BY_KEY.get(String(key || '')) || null

/**
 * 这一款要写进片段的文字（**按块**返回，一条片段一块）。
 *
 * ⚠️ 多行 ≠ 多块：「两排字幕 / 举例3点」是**一条片段里的换行**（一块，文字含 `\n`），
 *    「2句覆盖 / 三字叠加」才是**多条片段错峰**。
 *    这里曾经把多行也拆成多块 —— 于是「举例3点」在字幕轨上落了三条，
 *    每块各占一拍、时间越拖越长，而名字说的明明是"三点并列在一屏"。
 *    预览侧靠 `white-space: pre-wrap` 换行、导出侧靠 drawtext 的 `textfile` 支持多行，
 *    两边都认同一条带 `\n` 的字符串。
 */
function blockTexts(preset) {
  const p = preset || {}
  const chain = clamp(Math.round(num(p.chain, 1)), 1, 4)
  const rows = clamp(Math.round(num(p.rows, 1)), 1, 3)
  if (chain > 1) {
    if (p.mode === 'stack') {
      /* 叠加 / 逐字：一块一个字，逐字往外蹦 */
      const chars = Array.from('口播字幕')
      return Array.from({ length: chain }, (_, i) => chars[i % chars.length])
    }
    /* 覆盖 / 依次：一屏一句，后一句盖掉前一句 */
    return Array.from({ length: chain }, (_, i) => `第${CN[i] || i + 1}句`)
  }
  if (rows === 1) return [p.group === 'name' ? '你的名字' : '口播字幕']
  const lines = p.numbered
    ? Array.from({ length: rows }, (_, i) => `${i + 1}. 第${CN[i] || i + 1}点`)
    : Array.from({ length: rows }, (_, i) => `第${CN[i] || i + 1}句`)
  return [lines.join('\n')]
}

/**
 * 一屏多块时的节奏。
 *
 * `seq`（覆盖/依次）两块之间要留出"读完一句"的时间，但块数越多单块越短，
 * 否则「四宫格顺序出现」会拖到 9 秒，用户以为坏了。
 * `stack`（叠加/逐字）只隔一个字的工夫。
 */
function staggerOf(preset) {
  const chain = clamp(Math.round(num(preset && preset.chain, 1)), 1, 4)
  if (preset && preset.mode === 'seq') {
    if (chain <= 2) return 2.2
    if (chain === 3) return 1.6
    return 1.2
  }
  return 0.45
}

/** 单块时长：seq 每块 2.6 秒（够读一句话）；单块预设给 3 秒 */
const blockDuration = (preset) => (num(preset && preset.chain, 1) > 1 ? 2.6 : 3)

/**
 * 预设 → 要落进时间线的片段数组。
 *
 * @param {object} preset 一款预设（presetByKey 的结果）
 * @param {object} opts
 * @param {number} opts.start   起点（秒）
 * @param {Function} opts.idFor 生成片段 id
 * @param {object} [opts.texts] 覆盖采样文字（用户已经在面板里敲了正文时用）
 * @returns {{clips: object[], duration: number}}
 */
function planPreset(preset, opts = {}) {
  const p = preset || normalize({})
  const start = Math.max(0, num(opts.start, 0))
  const idFor = typeof opts.idFor === 'function' ? opts.idFor : ((i) => `sp-${Date.now()}-${i}`)
  const texts = Array.isArray(opts.texts) && opts.texts.length ? opts.texts : blockTexts(p)
  const gap = staggerOf(p)
  const one = blockDuration(p)
  const clips = texts.map((text, i) => {
    const at = start + gap * i
    const dur = Math.max(MIN_CLIP_SECONDS, one)
    return {
      id: idFor(i),
      track: 'text',
      assetId: '',
      /* 名字带序号才能区分「第 1 块 / 第 2 块」，否则时间线上三条一模一样的标签 */
      name: texts.length > 1 ? `${p.name} ${i + 1}` : p.name,
      url: '',
      path: '',
      kind: 'text',
      text: String(text == null ? '' : text),
      textSize: 32,
      textStyle: p.style,
      /* 落点 / 对齐 / 字号 / 动效：全是「片段级覆写」，预览与导出读同一套
         （renderer/textStyles.js 的 textStyleCss + main/subtitles.js 的 drawtext） */
      textAnchor: p.anchor,
      textOffset: p.offset,
      textAlign: p.align,
      textScale: p.scale,
      textIn: p.in,
      textOut: p.out,
      textLoop: p.loop,
      textInDur: p.inDur,
      textOutDur: p.outDur,
      start: Number(at.toFixed(3)),
      duration: dur,
      offset: 0,
      sourceDuration: 0
    }
  })
  const duration = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration - start : 0
  return { clips, duration: Number(duration.toFixed(3)) }
}

const anchorLabel = (key) => (key === 'top' ? '顶部' : key === 'center' ? '居中' : '底部')
const alignLabel = (key) => (key === 'left' ? '左对齐' : key === 'right' ? '右对齐' : '居中')
const labelOf = (list, key) => {
  const hit = list.find((item) => item.key === key)
  return hit ? hit.label : key
}

/**
 * 一行说明（卡片悬停提示与 MCP 清单共用）。
 * 例：`底部 · 两行 · 上浮 0.36s`
 */
function describePreset(preset) {
  const p = preset || normalize({})
  const bits = [anchorLabel(p.anchor)]
  if (p.align !== 'center') bits.push(alignLabel(p.align))
  if (p.chain > 1) bits.push(`${p.chain} 条${p.mode === 'seq' ? '依次' : '叠加'}`)
  else if (p.rows > 1) bits.push(`${p.rows} 行`)
  bits.push(`${labelOf(IN_TYPES, p.in)} ${Number(p.inDur).toFixed(2)}s`)
  if (p.loop !== 'none') bits.push(`循环·${labelOf(LOOP_TYPES, p.loop)}`)
  if (p.scale > 1.001) bits.push(`放大 ${Number(p.scale).toFixed(2)}×`)
  else if (p.scale < 0.999) bits.push(`缩小 ${Number(p.scale).toFixed(2)}×`)
  return bits.join(' · ')
}

module.exports = {
  PRESET_GROUPS: GROUPS,
  PRESETS,
  PRESET_COUNT: PRESETS.length,
  presetsOfGroup,
  presetByKey,
  blockTexts,
  staggerOf,
  planPreset,
  describePreset,
  normalizePreset: normalize
}
