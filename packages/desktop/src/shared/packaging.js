'use strict'
/**
 * 智能包装的**纯逻辑**：读一遍字幕轨，判断哪几句是"高能句"，给出成套包装方案。
 *
 * 与模板的分工：
 *   · 模板 —— 往空时间线**造**内容（开场 / 结尾 / 字幕套）；
 *   · 智能包装 —— 对**已有**字幕批量改（统一风格、关键句加重、按主题配贴纸）。
 *     它不新增一句台词，只改已有片段的属性 + 追加若干贴纸片段。
 *
 * ⚠️ 这里**没有模型、没有联网**：判断靠内置词库（情绪词 / 量化词 / 方法词）+ 标点 +
 *    长度这几种可解释的规则。所以同一个输入永远得到同一个结果，可以脱机自测，
 *    也可以在面板上把"为什么这句被判成关键句"说清楚（`analyzeLine().hits`）。
 *    做成黑盒打分的话，判错了没人能改，也没法给出对应的自检。
 *
 * ⚠️ 本文件是 CommonJS，渲染层 import 之前**必须**加进
 *    packages/desktop/vite.config.mjs 的 commonjsOptions.include，
 *    否则渲染层拿到空对象（`planPackaging is not a function`），构建不报错。
 *
 * ⚠️ 包装结果落在**普通字段**上（字幕：textStyle / textScale / textIn… ；
 *    画面：border / filter），不新增一种片段类型。唯一多出来的是片段上的 `pack` 标记 ——
 *    它只用来支持"清除包装 / 重新包装"（记住改之前的原值），
 *    其它任何功能都不需要认识它；丢了它也只是"清不回去"，画面照常。
 */

const TEXT_TABLE = require('./textStyles.json')

/** 画幅百分比单位：贴纸尺寸与 shared/pip.json 的 minSize/maxSize 同一范围 */
const MIN_PIP_SIZE = 10
const MAX_PIP_SIZE = 60
/** 短于 0.6s 的贴纸在时间线上只有 20 来像素，点都点不到 */
const MIN_STICKER = 0.6
/** 一条字幕上贴纸的最长时长：再长就盖住下一句了 */
const MAX_STICKER = 1.8
/** 关键句判定阈值（分值口径见 SCORE） */
const KEY_SCORE = 3
/** 一次包装最多处理多少条字幕（防止手滑把上千条一起套） */
const MAX_LINES = 200

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 四种包装风格 —— 值直接是 textStyles.json 里的 key（不另造一套样式）。
 *
 * `sticker`：这一类句子优先配哪一组贴纸（组 key 见 resources/stickers/catalog.json）。
 * 空串 = 这一套不配贴纸（极简白刻意什么都不加）。
 */
const PACK_STYLES = [
  { key: 'web-yellow', name: '网感黄', hint: '口播字幕高频款，最抓眼', style: 'art-yellow-solid', sticker: 'spark' },
  { key: 'show-red', name: '综艺红', hint: '强节奏，适合带货口播', style: 'art-red-solid', sticker: 'party' },
  { key: 'tech-blue', name: '冷调蓝', hint: '知识 / 数码区，克制有科技感', style: 'art-blue-glow', sticker: 'mark' },
  { key: 'plain-white', name: '极简白', hint: '不抢画面，只做关键句加重', style: 'sub-plain', sticker: '' }
]

/**
 * 三种档强度。差别只有三件事：关键句放大多少、几条字幕配一枚贴纸、开哪种入场。
 * ⚠️ 不做"贴纸随机出现"这种不可复现的东西 —— 同一个句子、同一档强度，
 *    配到的贴纸必须是同一个，否则闸门没法断言，用户也没法预期。
 */
const PACK_LEVELS = [
  { key: 'light', name: '轻', hint: '只给关键句加重', emphScale: 1.1, every: 3, in: 'fade' },
  { key: 'normal', name: '标准', hint: '关键句放大并呼吸', emphScale: 1.18, every: 2, in: 'up' },
  { key: 'heavy', name: '重', hint: '每条都配素材', emphScale: 1.26, every: 1, in: 'up' }
]

/**
 * 「画面包装」四种组合 —— 只动**主轨**片段上两个已有属性：`border`（边框 key）与
 * `filter`（滤镜 key）。这两个属性预览与成片两条链都早已接通，所以这里不新增渲染能力，
 * 只是"一次改一批"。
 *
 * ⚠️ `border` 用空串表示"不要边框"，`filter` 用 `none` 表示"不调色" ——
 *    两个字段的空值写法不一样（前者是 `''`、后者是字符串 `'none'`），
 *    照抄对方会得到"点了清空，边框还在"或者"滤镜没了但边框还在"。
 */
const SCENE_COMBOS = [
  { key: 'clean', name: '白框净透', hint: '白边 + 提亮，适合日常 vlog', border: 'br-basic-white', filter: 'bright' },
  { key: 'film', name: '胶片复古', hint: '胶片边 + 复古调，适合回忆向', border: 'br-retro-film', filter: 'retro' },
  { key: 'cool', name: '冷调质感', hint: '细线框 + 冷色，适合数码测评', border: 'br-min-line', filter: 'cool' },
  { key: 'warm', name: '暖光柔化', hint: '简约双线 + 暖色柔化，适合人像', border: 'br-min-double', filter: 'warm' }
]

/**
 * 词库：三类，权重不同。
 *   hype  情绪 / 强度词 —— 口播里最该被看到的词，权重最高；
 *   value 量化词（数字、折扣、时间）—— 信息密度高，权重中等；
 *   howto 方法 / 步骤词 —— 承诺了"教你什么"，权重中等。
 */
const BANK = {
  hype: [
    '绝了', '太香', '真香', '必看', '必买', '震惊', '离谱', '炸裂', '逆天', '封神',
    '神器', '爆款', '爆改', '闭眼入', '无脑冲', '强推', '巨好用', '超值', '上头', '破防',
    '救命', '谁懂', '竟然', '居然', '千万别', '后悔', '错过', '秘密', '内幕', '揭秘',
    '真相', '独家', '首发', '重磅', '顶配', '天花板', '神仙', '王炸', '惊喜', '惊艳',
    '牛', '赚到', '血赚', '翻车', '避雷', '冲就完事'
  ],
  value: [
    '第一', '前三', '零成本', '免费', '白嫖', '包邮', '五折', '半价', '秒杀', '限时',
    '立省', '省下', '翻倍', '十倍', '一倍', '两倍', '三倍', '一天', '三天',
    '一周', '半小时', '十分钟', '一分钟', '三十秒', '今年', '明年', '最新'
  ],
  howto: [
    '教你', '三招', '三步', '秘诀', '公式', '教程', '避坑', '别再', '一定要', '记住',
    '关键是', '重点', '核心', '方法', '技巧', '套路', '流程', '步骤', '实操', '手把手',
    '保姆级', '干货', '为什么', '怎么', '如何', '是不是', '别急'
  ]
}

/** 量化词里还要认"数字 + 单位"，纯词库认不到任意数字 */
const NUMBER_PATTERNS = [
  { re: /\d+(?:\.\d+)?\s*%/, kind: 'value', label: '百分比' },
  { re: /\d+(?:\.\d+)?\s*万/, kind: 'value', label: '万级数字' },
  { re: /\d+(?:\.\d+)?\s*(?:元|块)/, kind: 'value', label: '价格' },
  { re: /\d+(?:\.\d+)?\s*(?:倍|天|小时|分钟|秒)/, kind: 'value', label: '数量' }
]

const WEIGHT = { hype: 3, value: 2, howto: 2 }
const KIND_LABEL = { hype: '情绪', value: '量化', howto: '方法' }

/** 一条字幕片段（与渲染侧的判定同一口径：文字轨、纯文字、没有素材文件） */
const isSubtitleClip = (clip) =>
  Boolean(clip) &&
  clip.track === 'text' &&
  clip.kind === 'text' &&
  !clip.assetId &&
  String(clip.text || '').trim().length > 0

/**
 * 这句话是不是"高能句"，以及凭什么。
 *
 * @param {string} text
 * @returns {{ score:number, hits:{word:string,kind:string,label:string}[], reasons:string[] }}
 */
function analyzeLine(text) {
  const body = String(text || '')
  const raw = []

  for (const kind of Object.keys(BANK)) {
    for (const word of BANK[kind]) {
      if (word && body.includes(word)) raw.push({ word, kind, label: KIND_LABEL[kind] })
    }
  }
  for (const item of NUMBER_PATTERNS) {
    const m = body.match(item.re)
    if (m) raw.push({ word: m[0], kind: item.kind, label: item.label })
  }

  /* 去重两遍，顺序都不能反：
     ① 同名词只算一次 —— BANK 里"一倍"写了两遍，不去重会重复计分；
     ② 被长词吃掉的短词丢掉 —— 命中"千万别"之后不必再说"别"。 */
  const uniq = []
  for (const hit of raw) {
    if (uniq.some((u) => u.word === hit.word)) continue
    uniq.push(hit)
  }
  const picked = uniq.filter(
    (hit) => !uniq.some((other) => other.word !== hit.word && other.word.includes(hit.word))
  )

  const reasons = []
  let score = 0
  for (const hit of picked) score += WEIGHT[hit.kind] || 1
  if (/[!！]/.test(body)) {
    score += 1
    reasons.push('有感叹号')
  }
  if (/[?？]/.test(body)) {
    score += 1
    reasons.push('有疑问语气')
  }
  if (body.replace(/\s/g, '').length >= 12) {
    score += 1
    reasons.push('句子较长（信息密度高）')
  }
  for (const hit of picked.slice(0, 4)) reasons.push(`${hit.label}词「${hit.word}」`)

  return { score: Math.min(9, score), hits: picked, reasons, words: picked.length }
}

/**
 * 整条字幕轨的体检（面板统计与闸门都用它，不各自数一遍）。
 *
 * @param {object[]} clips
 * @returns {{ total:number, keys:object[], packed:number, autoStickers:number }}
 */
function analyzeTrack(clips) {
  const list = Array.isArray(clips) ? clips : []
  const subs = list.filter(isSubtitleClip)
  const keys = []
  for (const clip of subs) {
    const info = analyzeLine(clip.text)
    if (info.score >= KEY_SCORE) keys.push({ id: clip.id, text: clip.text, score: info.score, hits: info.hits })
  }
  return {
    total: subs.length,
    keys,
    packed: subs.filter((c) => c && c.pack && c.pack.mode === 'line').length,
    autoStickers: list.filter((c) => c && c.pack && c.pack.auto && c.pack.mode === 'line').length
  }
}

/**
 * 画面包装的体检：主轨上有几段、几段已经被套过。
 *
 * @param {object[]} clips
 */
function analyzeScene(clips) {
  const list = Array.isArray(clips) ? clips : []
  const main = list.filter((c) => c && c.track === 'video')
  return {
    total: main.length,
    packed: main.filter((c) => c && c.pack && c.pack.mode === 'scene').length,
    framed: main.filter((c) => c && c.border).length,
    graded: main.filter((c) => c && c.filter && c.filter !== 'none').length
  }
}

/** 包装前的原值：重新包装时以它为基准，否则第二次包装会在第一次的结果上再放大一遍 */
const baseOf = (clip) => (clip && clip.pack && clip.pack.prev ? { ...clip, ...clip.pack.prev } : clip)

/** 样式表里那条样式的默认字号（统一字号的基准） */
function styleSize(styleKey) {
  const def = (TEXT_TABLE.styles || []).find((s) => s.key === styleKey)
  return num(def && def.size, 40)
}

const styleOf = (key) => PACK_STYLES.find((item) => item.key === key) || PACK_STYLES[0]
const levelOf = (key) => PACK_LEVELS.find((item) => item.key === key) || PACK_LEVELS[1]

/** 区间相交（含端点相切不算重叠：前后两句首尾相接是正常的字幕排布） */
const overlaps = (aStart, aDur, bStart, bDur) => aStart < bStart + bDur && bStart < aStart + aDur

/**
 * 成套包装方案。
 *
 * @param {object[]} clips 完整片段表（只挑文字轨用，但要读叠加轨的空档）
 * @param {object} opts
 * @param {string} [opts.style]    PACK_STYLES 的 key
 * @param {string} [opts.level]    PACK_LEVELS 的 key
 * @param {object} [opts.stickerKeys] 组 key → 贴纸 key 数组（来自内置贴纸清单）；
 *        不传 = 只做文字包装，不配贴纸
 * @param {number} [opts.start]    只处理这段区间内的字幕（秒）；不传 = 全轨
 * @param {number} [opts.end]
 * @returns {{ patches:object[], stickers:object[], summary:object }}
 *   patches  —— `{ id, patch }`，直接合并进对应片段；
 *   stickers —— 待新建的叠加片段描述（url 由调用方按 key 换成 yjai-media 地址）。
 */
function planPackaging(clips, opts = {}) {
  const list = Array.isArray(clips) ? clips : []
  const style = styleOf(opts.style)
  const level = levelOf(opts.level)
  const keys = opts.stickerKeys && typeof opts.stickerKeys === 'object' ? opts.stickerKeys : null
  const from = Number.isFinite(Number(opts.start)) ? Number(opts.start) : -Infinity
  const to = Number.isFinite(Number(opts.end)) ? Number(opts.end) : Infinity

  const subs = list
    .filter(isSubtitleClip)
    .filter((clip) => {
      const s = num(clip.start, 0)
      const e = s + num(clip.duration, 0)
      return e > from && s < to
    })
    .sort((a, b) => num(a.start, 0) - num(b.start, 0))
    .slice(0, MAX_LINES)

  const patches = []
  const stickers = []
  /* ⚠️ 只把**叠加轨**算作"已被占用"：主轨当然一直有画面 —— 贴纸本来就是压在画面上的，
     把它算进去会让每一枚贴纸都"撞车"，然后被推到句尾之外，最后一枚都配不出来
     （实测就是这样：时间线上一段正常视频，包装完一枚贴纸都没有）。
     文字轨同理不算：贴纸压在字幕旁边是常态，不是冲突。 */
  const busy = list
    .filter((clip) => clip && clip.track === 'overlay')
    .map((clip) => ({ start: num(clip.start, 0), duration: num(clip.duration, 0) }))

  let keyCount = 0
  let packedCount = 0

  subs.forEach((clip, index) => {
    const base = baseOf(clip)
    const info = analyzeLine(base.text)
    const isKey = info.score >= KEY_SCORE
    if (isKey) keyCount += 1

    const patch = {
      textStyle: style.style,
      /* ⚠️ 字号只能用 `textScale`，**不能用 `textSize`**：
         textSize 虽然在 App / templates / MCP 里都写了，但渲染与导出两侧都**没人读**
         （真正生效的是 applyTextOverrides 里 `def.size × textScale`）。
         写 textSize 会得到"面板说放大了、画面一点没变"，而且静态扫描、构建都不报。 */
      textScale: isKey ? Number(level.emphScale.toFixed(3)) : 1,
      textIn: level.in,
      textInDur: 0.32,
      textOut: 'fade',
      textOutDur: 0.28,
      /* 关键句才挂循环：整条字幕一直呼吸会很吵，只有该被记住的那几句值得动 */
      textLoop: isKey ? 'breathe' : 'none'
    }

    patches.push({
      id: clip.id,
      patch: {
        ...patch,
        /* 记住"改之前"的四个字段：清除时原样写回去。
           ⚠️ 只记被改过的字段 —— 全量快照会在用户中途改过别的东西后，
           一次性回滚把那些改动也吃掉。 */
        pack: {
          mode: 'line',
          style: style.key,
          level: level.key,
          prev: {
            textStyle: base.textStyle,
            textScale: base.textScale,
            textIn: base.textIn,
            textInDur: base.textInDur,
            textOut: base.textOut,
            textOutDur: base.textOutDur,
            textLoop: base.textLoop
          }
        }
      }
    })
    packedCount += 1

    /* 配贴纸：极简白不配；按强度隔几条配一枚；只配关键句 */
    if (!keys || !style.sticker || !isKey) return
    if (level.every > 1 && index % level.every !== 0) return
    const pool = keys[style.sticker]
    if (!Array.isArray(pool) || !pool.length) return

    const lineStart = num(base.start, 0)
    const lineDur = num(base.duration, 0)
    const want = clamp(Math.min(MAX_STICKER, lineDur * 0.6), MIN_STICKER, MAX_STICKER)
    let at = lineStart + Math.min(0.15, lineDur * 0.1)
    /* 找空档：贴纸压在同一位置会叠成一坨，而且看不出是哪一句的 */
    for (let guard = 0; guard < 6; guard += 1) {
      const hit = busy.find((slot) => overlaps(at, want, slot.start, slot.duration))
      if (!hit) break
      at = hit.start + hit.duration + 0.08
    }
    if (at + MIN_STICKER > lineStart + lineDur) return

    const key = pool[stickers.length % pool.length]
    const anchorList = ['right-top', 'left-top', 'right-bottom', 'left-bottom']
    stickers.push({
      forClip: clip.id,
      key,
      /* 关键句才配，尺寸比常规画中画小一档：它是点缀，不是第二主角 */
      at: Number(at.toFixed(3)),
      duration: Number(want.toFixed(3)),
      anchor: anchorList[stickers.length % anchorList.length],
      size: 16
    })
    busy.push({ start: at, duration: want })
  })

  return {
    patches,
    stickers,
    summary: {
      style: style.key,
      level: level.key,
      lines: subs.length,
      keys: keyCount,
      packed: packedCount,
      stickers: stickers.length,
      /* 有字幕但一句都没被判成关键句：多半是词库覆盖不到，界面要能说出来 */
      misses: subs.length - keyCount
    }
  }
}

/**
 * 画面包装：给主轨每一段统一套一个边框 + 一个滤镜。
 *
 * 与口播包装一样，改的都是**已有属性**（`clip.border` / `clip.filter`），
 * 预览与成片两条链早就接通了，这里只负责"一次改一批 + 记住原值能清回去"。
 *
 * @param {object[]} clips
 * @param {object} opts
 * @param {string} [opts.combo]   SCENE_COMBOS 的 key
 * @param {number} [opts.start]   只处理区间内的片段（秒）
 * @param {number} [opts.end]
 * @returns {{ patches:{id:string,patch:object}[], summary:object }}
 */
function planScene(clips, opts = {}) {
  const list = Array.isArray(clips) ? clips : []
  const combo = SCENE_COMBOS.find((item) => item.key === opts.combo) || SCENE_COMBOS[0]
  const from = Number.isFinite(Number(opts.start)) ? Number(opts.start) : -Infinity
  const to = Number.isFinite(Number(opts.end)) ? Number(opts.end) : Infinity

  const main = list
    .filter((clip) => clip && clip.track === 'video')
    .filter((clip) => {
      const s = num(clip.start, 0)
      const e = s + num(clip.duration, 0)
      return e > from && s < to
    })

  const patches = main.map((clip) => {
    /* 已经是画面包装过的片段：以最初的原值为基准，否则"换一种组合"会把
       上一次的边框记成原值，于是清除时回到的是上一次的包装，不是用户的原始状态 */
    const base = clip.pack && clip.pack.mode === 'scene' && clip.pack.prev ? { ...clip, ...clip.pack.prev } : clip
    return {
      id: clip.id,
      patch: {
        border: combo.border,
        filter: combo.filter,
        pack: {
          mode: 'scene',
          combo: combo.key,
          prev: { border: base.border, filter: base.filter }
        }
      }
    }
  })

  return {
    patches,
    summary: { combo: combo.key, lines: main.length, packed: patches.length }
  }
}

/**
 * 清除包装：把包装改过的字段写回原值，并列出要删掉的自动贴纸。
 *
 * 为什么分 `set` / `drop` 两张单子：清回原值时，**原本就没有这个键**（比如用户从没设过
 * 循环动画，`textLoop` 在片段上压根不存在）和**原本是某个值**是两回事。
 * 只写 `set` 的话，"包装时新增的键"会留在片段上（`textLoop: 'breathe'` 永远清不掉，
 * 表现为"点了清除，字幕还在呼吸"）。所以 `drop` 里列出必须**删键**的字段。
 *
 * @param {object[]} clips
 * @param {string} [mode] 'line'（默认，口播）/ 'scene'（画面）—— 两个面板各清各的，
 *        混着清会把"我只想退掉字幕包装"变成"边框也一起没了"。
 * @returns {{ patches:{id:string,set:object,drop:string[]}[], remove:string[], restored:number }}
 */
function planStrip(clips, mode = 'line') {
  const list = Array.isArray(clips) ? clips : []
  const patches = []
  const remove = []

  for (const clip of list) {
    if (!clip) continue
    if (!clip.pack) continue
    if (clip.pack.auto) {
      if (clip.pack.mode === mode) remove.push(clip.id)
      continue
    }
    if (clip.pack.mode !== mode || !clip.pack.prev) continue

    const prev = clip.pack.prev
    const set = {}
    const drop = []
    for (const key of Object.keys(prev)) {
      const val = prev[key]
      if (val === undefined || val === null) drop.push(key)
      else set[key] = val
    }
    /* `pack` 本身要**删键**（不是置 null）：留着 `pack: null` 会让"已包装条数"
       在重新统计时仍然把它算成一条被包装过的字幕，而且第二次包装时 baseOf 会拿到 null */
    drop.push('pack')
    patches.push({ id: clip.id, set, drop })
  }

  return { patches, remove, restored: patches.length }
}

module.exports = {
  PACK_STYLES,
  PACK_LEVELS,
  SCENE_COMBOS,
  BANK,
  KEY_SCORE,
  isSubtitleClip,
  analyzeLine,
  analyzeTrack,
  analyzeScene,
  planPackaging,
  planScene,
  planStrip,
  styleSize,
  baseOf
}
