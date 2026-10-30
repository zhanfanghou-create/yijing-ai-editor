'use strict'
/**
 * 模板（成套预设）的**纯逻辑**：把 shared/templates.json 的一条模板翻译成片段数组。
 *
 * 为什么单独成模块（而不是写在面板里）：
 *   1. 它是纯函数，可以脱机自测 —— `tools/templates-selftest.mjs` 直接 require 它，
 *      不需要起 Electron。模板的时间轴算错（片段重叠、起点为负、时长不封顶）
 *      在界面上只表现成"叠得乱七八糟"，很难对着截图看出是哪一条错了；
 *   2. 闸门要用它的 `validateTemplates()` 逐条核对数据（样式 key、贴纸 key、字段范围）。
 *
 * ⚠️ 本文件是 CommonJS，渲染层 import 之前**必须**加进
 *    packages/desktop/vite.config.mjs 的 commonjsOptions.include，
 *    否则渲染层拿到的是空对象（`planTemplate is not a function`），
 *    构建不报错、静态扫描也看不见。同 speed.js / textOverrides.js 那一条。
 *
 * ⚠️ 生成出来的片段**必须是普通片段**，不能带任何"模板专用"标记。
 *    否则一旦模板页出问题，用户的时间线里就留着一批别的面板不敢碰的片段
 *    （剪切、变速、导出都要额外认它）。模板只在"生成"这一步存在，
 *    落地之后它就是一条普通文字/贴纸片段 —— 这是这套设计最重要的性质。
 */

const TABLE = require('./templates.json')
const TEXT_TABLE = require('./textStyles.json')

const TEMPLATES = Array.isArray(TABLE.templates) ? TABLE.templates : []
const GROUPS = Array.isArray(TABLE.groups) ? TABLE.groups : []
const BY_KEY = Object.fromEntries(TEMPLATES.map((item) => [item.key, item]))

/** 贴纸尺寸与画中画参数表同一范围（shared/pip.json 的 minSize/maxSize） */
const MIN_PIP_SIZE = 10
const MAX_PIP_SIZE = 60
/** 一条模板片段的最短时长：低于 0.2s 在时间线上只有 3 像素宽，点都点不到 */
const MIN_CLIP = 0.2
/** 单条模板最多生成多少个片段（防止数据写错时把时间线灌爆） */
const MAX_CLIPS = 24

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 列表 / 分组查询（面板与闸门都从这里取，不各自 filter） */
const listTemplates = () => TEMPLATES.slice()
const templateOf = (key) => BY_KEY[key] || null
const groupsOf = () => GROUPS.slice()
const templatesOfGroup = (groupKey) => TEMPLATES.filter((item) => item.group === groupKey)

/** 面板卡片要显示的信息：不把整个 clips 抛给界面 */
function templateSummary(tpl) {
  if (!tpl) return null
  const clips = Array.isArray(tpl.clips) ? tpl.clips : []
  return {
    key: tpl.key,
    name: String(tpl.name || ''),
    group: String(tpl.group || ''),
    hint: String(tpl.hint || ''),
    duration: num(tpl.duration, 0),
    textCount: clips.filter((c) => c.type === 'text').length,
    stickerCount: clips.filter((c) => c.type === 'sticker').length
  }
}

/**
 * 一条模板 → 片段数组。
 *
 * @param {object} tpl shared/templates.json 里的一项
 * @param {object} opts
 * @param {number} [opts.start]     模板起点（秒）—— 整套平移到这里
 * @param {Function} [opts.idFor]   id 生成器，`(n) => string`；不传就 t0/t1…
 * @param {Function} [opts.resolveSticker] `(key) => { name, url } | null`；
 *        返回 null 的那一条会被跳过并记进 `skipped`（贴纸清单里没有这个 key）
 * @param {string} [opts.titleText] 覆盖**第一条文字**的正文（一键套用时填工程名）
 * @returns {{ clips: object[], skipped: string[], duration: number }}
 */
function planTemplate(tpl, opts = {}) {
  const start = Math.max(0, num(opts.start, 0))
  const idFor = typeof opts.idFor === 'function' ? opts.idFor : (n) => `tpl-${n}`
  const resolveSticker = typeof opts.resolveSticker === 'function' ? opts.resolveSticker : null
  const titleText = typeof opts.titleText === 'string' ? opts.titleText.trim() : ''

  const clips = []
  const skipped = []
  let end = 0
  let firstTextDone = false

  const rows = (Array.isArray(tpl && tpl.clips) ? tpl.clips : []).slice(0, MAX_CLIPS)
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const at = Math.max(0, num(raw.at, 0))
    const dur = Math.max(MIN_CLIP, num(raw.dur, 1))
    const begin = start + at
    end = Math.max(end, begin + dur - start)

    if (raw.type === 'sticker') {
      const hit = resolveSticker ? resolveSticker(String(raw.sticker || '')) : null
      /* 查不到就跳过：把 url 写成空串会得到一个加载失败的空 <img>，
         画面上什么都没有、时间线上却多一条 —— 比直接不加更让人困惑。 */
      if (!hit || !hit.url) {
        skipped.push(String(raw.sticker || ''))
        continue
      }
      clips.push({
        id: idFor(clips.length),
        track: 'overlay',
        assetId: '',
        name: hit.name || String(raw.sticker || '贴纸'),
        url: hit.url,
        path: '',
        kind: 'image',
        text: '',
        start: begin,
        duration: dur,
        offset: 0,
        sourceDuration: 0,
        pip: {
          anchor: String(raw.anchor || 'right-bottom'),
          size: clamp(num(raw.size, 16), MIN_PIP_SIZE, MAX_PIP_SIZE)
        }
      })
      continue
    }

    /* 文字。样式 key 允许多层回落：模板里写错一个 key 不该让整条模板失败，
       但要能在 validateTemplates 里被查出来（那一层是数据自检，不是运行时）。 */
    const styleKey = String(raw.style || TEXT_TABLE.fallback || 'sub-plain')
    const def = (TEXT_TABLE.styles || []).find((s) => s.key === styleKey) || null
    const body = !firstTextDone && titleText ? titleText : String(raw.text || '')
    firstTextDone = true

    const clip = {
      id: idFor(clips.length),
      track: 'text',
      assetId: '',
      name: body.slice(0, 24) || '文字',
      url: '',
      path: '',
      kind: 'text',
      text: body,
      textSize: num(def && def.size, 40),
      textStyle: styleKey,
      start: begin,
      duration: dur,
      offset: 0,
      sourceDuration: 0
    }

    const scale = num(raw.scale, 1)
    if (Math.abs(scale - 1) > 0.001) clip.textScale = clamp(scale, 0.4, 2.5)

    const anchor = String(raw.anchor || '')
    if (anchor === 'top' || anchor === 'center' || anchor === 'bottom') {
      clip.textAnchor = anchor
      /* center 时不写 offset：applyTextOverrides 会把 null 当成 0 写进去，
         于是 hasTextOverrides 说"这条被改过"，右栏一直挂着"恢复默认"角标。 */
      if (anchor !== 'center') {
        const offset = num(raw.offset, NaN)
        if (Number.isFinite(offset)) clip.textOffset = clamp(offset, 0, 600)
      }
    }
    if (raw.align === 'left' || raw.align === 'center' || raw.align === 'right') {
      clip.textAlign = raw.align
    }
    if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)) {
      clip.textColor = raw.color
    }

    clips.push(clip)
  }

  return { clips, skipped, duration: end }
}

/**
 * 数据自检（闸门用，不参与运行时）。
 *
 * @param {object} deps
 * @param {Set<string>|string[]} [deps.styleKeys]   textStyles.json 里真实存在的 key
 * @param {Set<string>|string[]} [deps.stickerKeys] 贴纸清单里真实存在的 key
 * @param {Set<string>|string[]} [deps.borderKeys]  边框清单里真实存在的 key（本表暂未用）
 * @returns {string[]} 问题列表，空数组 = 数据合格
 */
function validateTemplates(deps = {}) {
  const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []))
  const styleKeys = toSet(deps.styleKeys)
  const stickerKeys = toSet(deps.stickerKeys)
  const borderKeys = toSet(deps.borderKeys)

  const problems = []
  const seen = new Set()
  const groupKeys = new Set(GROUPS.map((g) => g.key))

  if (!TEMPLATES.length) problems.push('模板表是空的')
  if (!GROUPS.length) problems.push('模板分组是空的')

  for (const g of GROUPS) {
    if (!g || !g.key || !g.name) problems.push(`分组字段不全：${JSON.stringify(g)}`)
    if (!TEMPLATES.some((t) => t.group === g.key)) problems.push(`分组「${g.name}」下一个模板都没有`)
  }

  for (const tpl of TEMPLATES) {
    const tag = tpl.key || '(无 key)'
    if (!tpl.key || !/^[a-z0-9][a-z0-9-]{2,48}$/.test(tpl.key)) problems.push(`${tag}：key 不合规`)
    if (seen.has(tpl.key)) problems.push(`${tag}：key 重复`)
    seen.add(tpl.key)
    if (!tpl.name) problems.push(`${tag}：缺 name`)
    if (!tpl.hint) problems.push(`${tag}：缺 hint（面板卡片上是空的）`)
    if (!groupKeys.has(tpl.group)) problems.push(`${tag}：group「${tpl.group}」不在分组表里`)

    const rows = Array.isArray(tpl.clips) ? tpl.clips : []
    if (!rows.length) problems.push(`${tag}：一条片段都没有`)
    if (rows.length > MAX_CLIPS) problems.push(`${tag}：片段数 ${rows.length} 超过上限 ${MAX_CLIPS}`)

    let span = 0
    for (const raw of rows) {
      const at = num(raw && raw.at, NaN)
      const dur = num(raw && raw.dur, NaN)
      if (!Number.isFinite(at) || at < 0) problems.push(`${tag}：at 不是非负数字（${raw && raw.at}）`)
      if (!Number.isFinite(dur) || dur < MIN_CLIP) problems.push(`${tag}：dur 小于 ${MIN_CLIP}s（${raw && raw.dur}）`)
      if (Number.isFinite(at) && Number.isFinite(dur)) span = Math.max(span, at + dur)

      if (!raw || (raw.type !== 'text' && raw.type !== 'sticker')) {
        problems.push(`${tag}：type 只能是 text / sticker（${raw && raw.type}）`)
        continue
      }

      if (raw.type === 'text') {
        if (!raw.text) problems.push(`${tag}：文字条目缺 text`)
        if (styleKeys.size && !styleKeys.has(raw.style)) {
          problems.push(`${tag}：文字样式「${raw.style}」在 textStyles.json 里不存在`)
        }
        if (raw.anchor && !['top', 'center', 'bottom'].includes(raw.anchor)) {
          problems.push(`${tag}：anchor 只能是 top/center/bottom（${raw.anchor}）`)
        }
        if (raw.anchor !== 'center' && raw.offset != null) {
          const off = num(raw.offset, NaN)
          if (!Number.isFinite(off) || off < 0 || off > 600) problems.push(`${tag}：offset 越界（${raw.offset}）`)
        }
        if (raw.scale != null) {
          const sc = num(raw.scale, NaN)
          if (!Number.isFinite(sc) || sc < 0.4 || sc > 2.5) problems.push(`${tag}：scale 越界（${raw.scale}）`)
        }
      } else {
        if (!raw.sticker) problems.push(`${tag}：贴纸条目缺 sticker key`)
        else if (stickerKeys.size && !stickerKeys.has(raw.sticker)) {
          problems.push(`${tag}：贴纸「${raw.sticker}」不在内置贴纸清单里`)
        }
        if (raw.size != null) {
          const sz = num(raw.size, NaN)
          if (!Number.isFinite(sz) || sz < MIN_PIP_SIZE || sz > MAX_PIP_SIZE) {
            problems.push(`${tag}：size 越界（${raw.size}，${MIN_PIP_SIZE}~${MAX_PIP_SIZE}）`)
          }
        }
      }
    }

    /* 同一条 text 轨上的两条文字**不能时间重叠**：
       时间线只有一条字幕轨，重叠会让胶片上的名字互相压成一团（实测 0s/0.5s 两条
       标题叠在一起，谁也读不出来），而库里别处（clipAtPlayhead、字幕文件导入）
       都假定同轨片段不重叠。贴纸在 overlay 轨，允许多层同时出现，不在此列。 */
    const textRows = rows
      .filter((r) => r && r.type === 'text')
      .map((r) => ({ at: num(r.at, 0), dur: num(r.dur, 0) }))
      .sort((a, b) => a.at - b.at)
    for (let i = 1; i < textRows.length; i += 1) {
      const prev = textRows[i - 1]
      if (prev.at + prev.dur > textRows[i].at + 0.001) {
        problems.push(
          `${tag}：两条文字时间重叠（${prev.at}s + ${prev.dur}s 撞上 ${textRows[i].at}s）—— 同一条字幕轨上胶片会互相压住`
        )
      }
    }

    /* duration 是卡片上写的"共 N 秒"，也是"套上去要占多长"的预期。
       与片段实际跨度差太多就说明数据写错了（改了一条 dur 忘了改总长）。 */
    const declared = num(tpl.duration, 0)
    if (declared <= 0) problems.push(`${tag}：缺 duration`)
    else if (Math.abs(declared - span) > 0.05) {
      problems.push(`${tag}：duration 写的是 ${declared}s，片段实际跨度 ${span.toFixed(2)}s`)
    }
  }

  return problems
}

module.exports = {
  TABLE,
  TEMPLATES,
  GROUPS,
  MIN_CLIP,
  MAX_CLIPS,
  MIN_PIP_SIZE,
  MAX_PIP_SIZE,
  listTemplates,
  templateOf,
  groupsOf,
  templatesOfGroup,
  templateSummary,
  planTemplate,
  validateTemplates
}
