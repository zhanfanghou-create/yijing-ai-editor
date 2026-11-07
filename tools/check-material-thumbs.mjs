#!/usr/bin/env node
/**
 * 闸门 · 素材效果图：滤镜 / 转场 / 特效 / 调节 四组的每一条是否都有**真实的预览图**。
 *
 * ---------------------------------------------------------------------------
 * 这道闸门防的是什么（都是这个项目真实踩过的）
 * ---------------------------------------------------------------------------
 * ① **缺图**：卡片位置空着。`materialThumb()` 查不到就返回空串，界面静默画一个
 *    深色圆角方块 —— 构建不报错、E2E 不报错，只有人眼看出来。2026-11-02 的
 *    「调节」页就是这么一路摆着 6 个灰底卡片，参数是一个不差的。
 * ② **同一张图挂两个效果**：两条不同效果却长得一样，用户读作"这两条没区别"
 *    （更糟的是他点了之后画面确实变了，只是封面没变 —— 于是他不信封面）。
 * ③ **同一个效果挂两张图**：同一个效果键被画成两张不一样的封面 —— 封面在撒谎，
 *    而这正是 2026-10 那次"499 个滤镜名 268 个都落到 vivid"的同类问题。
 * ④ **glob 覆盖不到**：图在磁盘上、`import.meta.glob` 还盯着 `*.png`，
 *    于是每张卡都是空框。这条只能静态读源码才看得出来。
 * ⑤ **孤儿文件**：目录里躺着一批没人引用的图，安装包白重几十兆。
 * ⑥ **底片丢了**：生成器依赖本地素材包 `tools/thumb-bases/frames.yjpack`，删掉之后重跑会直接退出，
 *    但已经生成的图还在，于是"图是对的"和"重跑不出图"可以同时成立。
 * ⑦ **预设幅度退化成看不出来**：22 条「调节」预设最初单值最大只有 ±22、平均 7.4，
 *    等于只用掉滑杆 22% 的行程 —— 点「自然通透」是 +4 亮度 / +6 对比 / +8 饱和，
 *    画面几乎没变，用户读作"这卡坏了"。**上面 ①~⑥ 一条都不会红**：
 *    图是有的、键是一一的、也不空壳。「有图」和「有区别」是两件事。
 *
 * ⚠️ 这里判的是**结构不变量**（是否存在 / 是否一一对应 / 是否互相引用得到），
 *    不判"好不好看" —— 好不好看靠看截图，闸门替不了。
 *
 * 用法：
 *   node tools/check-material-thumbs.mjs             # 校验真实仓库
 *   node tools/check-material-thumbs.mjs --selftest  # 判据正反自证（秒级）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAT = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'materials.js')
const DIR = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'materials')
const BASES = path.join(ROOT, 'tools', 'thumb-bases')
/* 底片真源是一个本地素材包（不是散图）：`frames.yjpack` 里 4 张真实画面 */
const BASE_PACK = path.join(BASES, 'frames.yjpack')
const LOOKS = path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'looks.json')
const FRAME_FX = path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'frameEffects.json')

const GROUP_NAMES = ['FILTER_GROUPS', 'TRANSITION_GROUPS', 'EFFECT_GROUPS', 'ADJUST_GROUPS']

/* ------------------------------------------------------------------ 判据 */

/**
 * 纯函数：把"解析出来的数据"判一遍。
 * @param {{sections: Object<string, Array<{name:string, items:Array}>>, files: Set<string>,
 *          sizes: Object<string, number>, globLine: string, bases: string[]}} data
 * @returns {{name: string, ok: boolean, detail: string}[]}
 *
 * 之所以做成纯函数：真实仓库只是一组输入，`--selftest` 可以拿人造的输入
 * 分别证明"该绿的时候绿"和"该红的时候红在对的那一条上"。
 */
function judge(data) {
  const out = []
  const add = (name, ok, detail = '') => out.push({ name, ok, detail })

  // ① 四组都解析得到条目（防空集恒真：解析失败时后面每条都会"通过"）
  let total = 0
  for (const key of GROUP_NAMES) {
    const groups = data.sections[key] || []
    const n = groups.reduce((s, g) => s + g.items.length, 0)
    total += n
    add(`${key} 解析到条目`, n > 0, n > 0 ? `${groups.length} 组 / ${n} 条` : '一条都没解析到，正则或数据结构变了')
  }
  add('四组合计条目数 ≥ 1000', total >= 1000, `实测 ${total}`)

  const items = []
  for (const key of GROUP_NAMES) for (const g of data.sections[key] || []) for (const it of g.items) items.push({ ...it, section: key })

  // ② 每条都有 thumb 字段
  const noThumb = items.filter((it) => !it.thumb)
  add('每条都有 thumb 字段', noThumb.length === 0, noThumb.length ? `缺 ${noThumb.length} 条，如「${noThumb[0].zh}」` : `${items.length} 条全带`)

  // ③ 每个 thumb 文件真的在磁盘上、且不是空壳
  const missing = items.filter((it) => it.thumb && !data.files.has(it.thumb))
  add('每个 thumb 文件都存在', missing.length === 0, missing.length ? `缺 ${missing.length} 个，如 ${missing[0].thumb}（「${missing[0].zh}」）` : '全部命中')

  const used = [...new Set(items.map((it) => it.thumb).filter(Boolean))]
  const tiny = used.filter((f) => data.files.has(f) && (data.sizes[f] || 0) < 300)
  const smallest = used.length ? Math.min(...used.map((f) => data.sizes[f] || 0)) : 0
  add('没有空壳图（< 300 字节）', tiny.length === 0, tiny.length ? `${tiny.length} 个可疑：${tiny.slice(0, 3).join(' ')}` : `最小 ${smallest} 字节`)

  // ④ 同一效果键 → 同一张图
  const byKey = new Map()
  for (const it of items) {
    if (!it.key) continue
    if (!byKey.has(it.key)) byKey.set(it.key, new Set())
    byKey.get(it.key).add(it.thumb)
  }
  const keySplit = [...byKey.entries()].filter(([, s]) => s.size > 1)
  add('同一效果键只有一张图', keySplit.length === 0, keySplit.length ? `${keySplit.length} 个键被画成了多张，如 ${keySplit[0][0]}（${keySplit[0][1].size} 张）` : `${byKey.size} 个键一一对应`)

  // ⑤ 不同效果键 → 不同图
  const byThumb = new Map()
  for (const it of items) {
    if (!it.key) continue
    if (!byThumb.has(it.thumb)) byThumb.set(it.thumb, new Set())
    byThumb.get(it.thumb).add(it.key)
  }
  const thumbShared = [...byThumb.entries()].filter(([, s]) => s.size > 1)
  add('一张图不挂多个不同键', thumbShared.length === 0, thumbShared.length ? `${thumbShared.length} 张图被多个键共用，如 ${thumbShared[0][0]}` : `${byThumb.size} 张图各管一个键`)

  // ⑥ 目录里没有孤儿图（没人引用的文件白占安装包）
  const orphans = [...data.files].filter((f) => !used.includes(f))
  add('没有无人引用的孤儿图', orphans.length === 0, orphans.length ? `${orphans.length} 个孤儿，如 ${orphans[0]}` : `目录 ${data.files.size} 个文件全部被引用`)

  // ⑦ glob 覆盖得到（否则界面全是空框）
  add('glob 覆盖 *.webp', /materials\/\*\.webp/.test(data.globLine), data.globLine.trim().slice(0, 90))

  // ⑧ 生成器底片还在（删了之后"图是对的"与"重跑不出图"能同时成立）
  const need = ['frames.yjpack']
  const lack = need.filter((f) => !data.bases.includes(f))
  add('生成器底片齐全', lack.length === 0, lack.length ? `缺 ${lack.join(' / ')}` : need.join(' / '))

  // ⑨ 特效页的卡片不许全压在一两个键上
  //
  // 为什么这条必须机械钉住：⑧ 之前的每一条判据（一图一键、无孤儿、无空壳）在
  // 「344 张卡只有 6 个键、其中 235 张全指向 fx-lightleak」时**全部是绿的**——
  // 图与键确实一一对应，可用户点 20 张不同的卡，画面出来是同一个暖光扫过。
  // 这是"看起来功能很多、其实只有一个"的占位，比少几张卡糟得多，而它不违反任何旧判据。
  const fxItems = items.filter((it) => it.section === 'EFFECT_GROUPS' && it.key)
  const share = new Map()
  for (const it of fxItems) share.set(it.key, (share.get(it.key) || 0) + 1)
  const worst = [...share.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0]
  const worstShare = fxItems.length ? worst[1] / fxItems.length : 0
  add(
    '特效页：≥ 8 个真实效果键，且单一键占比 ≤ 30%',
    fxItems.length === 0 || (share.size >= 8 && worstShare <= 0.3),
    `${fxItems.length} 张卡 / ${share.size} 个键；最大 ${worst[0] || '-'} 占 ${(worstShare * 100).toFixed(1)}%`
  )

  // ⑩ 调节页的预设必须有力度（"有图"不等于"有区别"）
  //
  // 判的是**数值口径**，不是好不好看：最强的那一档参数必须 ≥ FLOOR。
  // 上限 CEIL 是为了拦住另一个方向 —— 顶到滑杆尽头（±100）会让预设开始出现
  // 偏色与暗部死黑，而那种"过头"和"没反应"一样是坏卡。
  //
  // 阈值的来历（2026-11-02 定）：换算关系是线性的，±100 才对应 ×1.6 对比 / ×2.0 饱和，
  // 所以 10 这个下限只是"约 1.06 倍对比"，并不激进；实测 22 条里最弱也到 14。
  const FLOOR = 10
  const CEIL = 45
  const adjItems = items.filter((it) => it.section === 'ADJUST_GROUPS' && it.key)
  const adjWeak = []
  let adjMin = null
  let adjMax = 0
  for (const it of adjItems) {
    let adj
    try {
      // 调节条目的 key 就是参数对象（parseSections 里压掉了空白），
      // 但它是 **JS 对象字面量**（`{bright:7,...}`，键是裸的）而不是 JSON ——
      // 直接 JSON.parse 会抛，那是"解析写错"而不是"预设没力度"，必须先补引号。
      // （已有引号的输入不受影响：正则要求 `{` 或 `,` 之后紧跟裸标识符。）
      adj = JSON.parse(it.key.replace(/([{,])([A-Za-z_]\w*):/g, '$1"$2":'))
    } catch {
      adjWeak.push(`${it.zh} 的键不是参数对象`)
      continue
    }
    const top = Math.max(...Object.values(adj).map((v) => Math.abs(Number(v) || 0)))
    if (!adjMin || top < adjMin.top) adjMin = { zh: it.zh, top }
    if (top > adjMax) adjMax = top
    if (top < FLOOR) adjWeak.push(`${it.zh} 最强一档只有 ${top}`)
    else if (top > CEIL) adjWeak.push(`${it.zh} 最强一档 ${top} 超过 ${CEIL}`)
  }
  add(
    `调节预设每条都够明显（最强一档 ${FLOOR}~${CEIL}）`,
    adjItems.length === 0 || adjWeak.length === 0,
    adjItems.length === 0
      ? '一条调节条目都没解析到'
      : adjWeak.length
        ? adjWeak.slice(0, 3).join('；')
        : `${adjItems.length} 条；最弱「${adjMin.zh}」${adjMin.top}，最强 ${adjMax}`
  )

  // ⑪ 每张卡的 css 键都必须在真源里查得到
  //
  // 为什么这条非有不可：三处取键的地方**都是"查不到就退回默认"**——
  //   预览 filterDef() 退回 none（点了画面不动）、导出 filterDef() 同样退回、
  //   缩略图 FILTER_PARAMS.get(css, {}) 退回空参数（画出来是没调色的原片）。
  //   于是拼错/漏改一个键**不会报任何错**：卡片还在、封面还在、点下去没反应。
  // 2026-11-03 把滤镜改成"一卡一键"时，499 张卡的 css 全部要换成本次生成的新键，
  // 手工对表必然漏 —— 正是这条要挡的。
  const frameKeys = new Set(data.frameKeys)
  /**
   * 特效键可以带参数后缀（`fx-glow@00100`，见 shared/fxParams.json）。
   * 真源里注册的是**族键**，所以要按族比对；参数串的合法性由
   * tools/check-fx-wiring.mjs 的 ⑥b 逐位校（那里有轴表，能判档位范围）。
   *
   * ⚠️ 不能图省事写成 `pool.has(it.key.split('@')[0])`：滤镜/转场没有参数概念，
   *    那样写会让 `smoothleft@xx` 这种拼错的键混过去。
   */
  const familyOf = (k) => (typeof k === 'string' ? k.split('@')[0] : k)
  const resolved = (it, pool) =>
    pool.has(it.key) || (it.section === 'EFFECT_GROUPS' && pool.has(familyOf(it.key)))
  const unresolved = []
  for (const it of items) {
    if (!it.key) continue
    const pool = it.section === 'FILTER_GROUPS'
      ? data.filterKeys
      : it.section === 'TRANSITION_GROUPS'
        ? data.transitionKeys
        : it.section === 'EFFECT_GROUPS'
          ? frameKeys
          : null
    if (!pool) continue // 调节的 key 是参数对象，不是效果键
    if (!resolved(it, pool)) unresolved.push(`「${it.zh}」→ ${it.key}`)
  }
  add(
    '每张卡的 css 键都能在真源里查到（查不到会静默退化成"点了没反应"）',
    unresolved.length === 0,
    unresolved.length
      ? `${unresolved.length} 张查不到，如 ${unresolved.slice(0, 3).join(' / ')}`
      : `${items.filter((it) => it.key).length} 张全部命中（滤镜 ${data.filterKeys.size} / 转场 ${data.transitionKeys.size} / 特效 ${frameKeys.size}）`
  )

  return out
}

/* ------------------------------------------------------------------ 解析 */

function parseSections(src) {
  const sections = {}
  for (const key of GROUP_NAMES) {
    const m = src.match(new RegExp(`export const ${key} = \\[([\\s\\S]*?)\\n\\]`))
    if (!m) {
      sections[key] = []
      continue
    }
    const groups = []
    const gre = /\{\s*name:\s*["']([^"']*)["'],\s*items:\s*\[([\s\S]*?)\]\s*\}/g
    let g
    while ((g = gre.exec(m[1]))) {
      const items = []
      // 三种条目形态都要认：{zh,thumb,css}（滤镜/转场/特效）、{zh,thumb,adjust}（调节）
      const ire = /\{\s*zh:\s*(["'])([^"']*)\1\s*,\s*(?:thumb:\s*(["'])([^"']*)\3\s*,\s*)?(?:css:\s*(["'])([^"']*)\5|adjust:\s*(\{[^}]*\}))/g
      let i
      while ((i = ire.exec(g[2]))) {
        items.push({ zh: i[2], thumb: i[4] || '', key: i[6] || (i[7] ? i[7].replace(/\s+/g, '') : '') })
      }
      groups.push({ name: g[1], items })
    }
    sections[key] = groups
  }
  return sections
}

function readRepo() {
  const src = fs.readFileSync(MAT, 'utf8')
  const files = new Set(fs.existsSync(DIR) ? fs.readdirSync(DIR) : [])
  const sizes = {}
  for (const f of files) sizes[f] = fs.statSync(path.join(DIR, f)).size
  const globLine = (src.match(/const IMAGES = import\.meta\.glob\([^)]*\)/) || [''])[0]
  /* 底片只认素材包这一个文件：散图时代的 base-a/base-b 已并入 frames.yjpack */
  const bases = fs.existsSync(BASE_PACK) ? [path.basename(BASE_PACK)] : []
  /* 效果键的真源：滤镜/转场在 looks.json，特效在 frameEffects.json。
     判据⑪ 要把卡上的键回查一遍 —— 三处消费端都是"查不到就静默退回默认"。 */
  const looks = JSON.parse(fs.readFileSync(LOOKS, 'utf8'))
  const fx = JSON.parse(fs.readFileSync(FRAME_FX, 'utf8'))
  const filterKeys = new Set(looks.filters.map((x) => x.key))
  const transitionKeys = new Set(looks.transitions.map((x) => x.key))
  const frameKeys = new Set((fx.effects || []).map((x) => x.key))
  return { sections: parseSections(src), files, sizes, globLine, bases, filterKeys, transitionKeys, frameKeys }
}

/* ------------------------------------------------------------------ 自证 */

function selfTest() {
  const base = () => {
    const sections = {}
    for (const k of GROUP_NAMES) {
      // 键与图都按组加前缀：不同组之间本来就不会共用同一个效果键，
      // 自证的"正控制组"必须先是一个真正自洽的输入，否则一开始就是红的。
      sections[k] = [
        {
          name: '示例组',
          items: [
            { zh: k + '-甲', thumb: k + '-a.webp', key: k + '-k1' },
            { zh: k + '-乙', thumb: k + '-b.webp', key: k + '-k2' }
          ]
        }
      ]
    }
    // 凑够 1000 条，避免"合计条目数 ≥ 1000"这条在自证里永远红
    sections.FILTER_GROUPS[0].items = Array.from({ length: 1000 }, (_, n) => ({
      zh: 'f' + n,
      thumb: 'f' + n + '.webp',
      key: 'fk' + n
    }))
    /* 调节条目的 key 是**参数 JSON**（判据⑩要解析它），不能沿用上面的 `-k1` 形式，
       否则正控制组从第一条起就是红的。给两条真正"有力度"且互不相同的参数
       （互不相同是必须的：一样就会同时触发"一图一键"那条的反判）。 */
    sections.ADJUST_GROUPS[0].items = [
      { zh: 'ADJUST_GROUPS-甲', thumb: 'ADJUST_GROUPS-a.webp', key: '{"bright":20,"saturate":-30}' },
      { zh: 'ADJUST_GROUPS-乙', thumb: 'ADJUST_GROUPS-b.webp', key: '{"temp":25}' }
    ]
    /* 特效页给 10 个**互不相同**的键：第 14 条判据要求"≥ 8 个真键且单键占比 ≤ 30%"，
       正控制组必须满足它，否则自证从第一条起就是红的。
       （这条正是被闸门自己抓出来的 —— 加判据时忘了改夹具，正控制组当场报红。） */
    const KEYS = 'abcdefghij'.split('')
    sections.EFFECT_GROUPS[0].items = KEYS.map((ch, n) => ({
      zh: 'e' + n,
      thumb: 'EFFECT_GROUPS-' + ch + '.webp',
      key: 'EFFECT_GROUPS-k' + (n + 1)
    }))
    const files = new Set()
    const sizes = {}
    const add = (f) => {
      files.add(f)
      sizes[f] = 4096
    }
    for (const k of GROUP_NAMES) for (const g of sections[k]) for (const it of g.items) add(it.thumb)
    /* 真源键池：正控制组里每张卡的键都必须能在池里查到（判据⑪）。
       这里直接从夹具自己的键生成池 —— 夹具是"一份正确的输入"，
       而判据要验的是"卡上的键是否出现在真源里"，两者必须一致才算正控制组。 */
    const pool = (k) => new Set(sections[k].flatMap((g) => g.items.map((it) => it.key)))
    return {
      sections, files, sizes,
      globLine: "const IMAGES = import.meta.glob('./assets/materials/*.webp')",
      bases: ['frames.yjpack'],
      filterKeys: pool('FILTER_GROUPS'),
      transitionKeys: pool('TRANSITION_GROUPS'),
      frameKeys: pool('EFFECT_GROUPS')
    }
  }

  const cases = []
  const failNames = (d) => judge(d).filter((r) => !r.ok).map((r) => r.name)

  // 正控制组：完全正确的输入必须全绿
  cases.push(['正控制组全绿', failNames(base()).length === 0, failNames(base()).join(' / ')])

  // 反控制组：逐条扰动，必须红在**对应的那一条**上
  const perturb = [
    ['缺 thumb 字段', (d) => delete d.sections.ADJUST_GROUPS[0].items[0].thumb, '每条都有 thumb 字段'],
    ['图不在磁盘', (d) => d.files.delete('TRANSITION_GROUPS-a.webp'), '每个 thumb 文件都存在'],
    ['空壳图', (d) => (d.sizes['EFFECT_GROUPS-a.webp'] = 12), '没有空壳图（< 300 字节）'],
    [
      '同键多图',
      (d) => {
        // 同一个键挂两条、图不同的条目 —— 这才叫"一个效果两张封面"
        d.sections.TRANSITION_GROUPS[0].items.push({ zh: '同键另一条', thumb: 'EFFECT_GROUPS-a.webp', key: 'TRANSITION_GROUPS-k1' })
      },
      '同一效果键只有一张图'
    ],
    ['glob 只认 png', (d) => (d.globLine = "const IMAGES = import.meta.glob('./assets/materials/*.png')"), 'glob 覆盖 *.webp'],
    ['底片缺失', (d) => (d.bases = []), '生成器底片齐全'],
    [
      '孤儿图',
      (d) => {
        // ⚠️ 不能写成 `(d.sizes[k]=1) || d.files.add(k)`：赋值返回 4096 是真值，
        //    `||` 直接短路，add 根本不会执行 —— 那条反控会静默变成"全绿"。
        d.files.add('nobody.webp')
        d.sizes['nobody.webp'] = 4096
      },
      '没有无人引用的孤儿图'
    ],
    ['组空掉', (d) => (d.sections.EFFECT_GROUPS = []), 'EFFECT_GROUPS 解析到条目'],
    // 预设幅度退化成"看不出来"：值改了、图也有，画面就是没变 —— 上面每一条都绿
    [
      '预设退化成看不出来',
      (d) => (d.sections.ADJUST_GROUPS[0].items[0].key = '{"bright":3,"saturate":-2}'),
      '调节预设每条都够明显（最强一档 10~45）'
    ],
    // 反方向：顶到滑杆尽头（±100）会让预设开始偏色、暗部死黑，同样是坏卡
    [
      '预设过头到滑杆尽头',
      (d) => (d.sections.ADJUST_GROUPS[0].items[0].key = '{"bright":100}'),
      '调节预设每条都够明显（最强一档 10~45）'
    ],
    // 卡的键在真源里查不到：界面仍在、封面仍在、点下去静默退回原片
    [
      '卡的键查不到',
      (d) => (d.sections.FILTER_GROUPS[0].items[0].key = 'no-such-look-key'),
      '每张卡的 css 键都能在真源里查到（查不到会静默退化成"点了没反应"）'
    ]
  ]
  for (const [label, mutate, expect] of perturb) {
    const d = base()
    mutate(d)
    const failed = failNames(d)
    cases.push([`反控制 · ${label} → 红在「${expect}」`, failed.includes(expect), `实际红：${failed.join(' / ') || '（全绿，判据失效）'}`])
  }

  // 一图两键：调节的一条改用转场那张图（键仍是自己的）→ 那张图挂了两个不同键
  {
    const d = base()
    d.sections.ADJUST_GROUPS[0].items[0].thumb = 'TRANSITION_GROUPS-a.webp'
    const failed = failNames(d)
    cases.push([
      '反控制 · 一图两键 → 红在「一张图不挂多个不同键」',
      failed.includes('一张图不挂多个不同键'),
      `实际红：${failed.join(' / ') || '（全绿，判据失效）'}`
    ])
  }

  let pass = 0
  for (const [name, ok, detail] of cases) {
    if (ok) pass++
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` :: ${detail}` : ''}`)
  }
  console.log(`\nMATERIAL_THUMBS_SELFTEST_STATS total=${cases.length} pass=${pass} fail=${cases.length - pass}`)
  console.log(`MATERIAL_THUMBS_SELFTEST ${pass === cases.length ? 'OK' : 'FAILED'} ${pass}/${cases.length}`)
  return pass === cases.length ? 0 : 1
}

/* ------------------------------------------------------------------ 主流程 */

if (process.argv.includes('--selftest')) process.exit(selfTest())

if (!fs.existsSync(MAT)) {
  console.log(`[FAIL] 前置 :: 找不到 ${path.relative(ROOT, MAT)}`)
  console.log('MATERIAL_THUMBS_FAILED')
  process.exit(1)
}

const results = judge(readRepo())
let pass = 0
let fail = 0
for (const r of results) {
  if (r.ok) pass++
  else fail++
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
}

// 覆盖面如实报数（不设阈值：这是内容侧的现状，不是判据）
const data = readRepo()
const fx = data.sections.EFFECT_GROUPS || []
const fxKeys = new Set()
for (const g of fx) for (const it of g.items) if (it.key) fxKeys.add(it.key)
console.log(`\n  · 特效页现状：${fx.reduce((n, g) => n + g.items.length, 0)} 个名字落在 ${fxKeys.size} 个真实效果键上`)

console.log(`\nMATERIAL_THUMBS_STATS total=${pass + fail} pass=${pass} fail=${fail}`)
if (fail) {
  console.log('MATERIAL_THUMBS_FAILED')
  process.exit(1)
}
console.log('四组素材的每一条都有真实效果图，且图与效果键一一对应。')
console.log('MATERIAL_THUMBS_OK')
