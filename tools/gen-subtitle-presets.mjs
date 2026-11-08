#!/usr/bin/env node
/**
 * 字幕预设清单生成器 —— 把「口播字幕动态排版」素材包翻译成软件里能用的**排版配方**。
 *
 * 用法：
 *   node tools/gen-subtitle-presets.mjs [素材根目录]
 *   默认素材根目录 = 本机那份素材包（见下面的 ROOT_DEFAULT）
 *   --check  只校验现有 JSON 与素材是否一致，不写盘（不一致退出码 1）
 * // oss-clean-allow: 剪映
 *   ↑ 这一行是给 tools/check-oss-clean.mjs 的自豁免：默认素材目录名里带第三方产品名，
 *     而那是**用户自己硬盘上的文件夹名**，不是我们产品里的文案。生成出来的 JSON
 *     只保留目录里的**分类中文名**（"109个高级感字幕预设"这类），不含任何品牌字样。
 *
 * ── 为什么不能直接把素材包"导进来" ──────────────────────────────────
 *
 * 素材包里的每一款 = 一个**已经渲染好的 mp4**（5 秒，效果烤在画面里），
 * 配一张封面 jpeg + 一份只有一条 video 轨的 draft_content.json。
 * 也就是说：**动画曲线、文字参数一个都拿不到**，拿到的只有名字和一张截图。
 * （另外两组更糟：`51款草稿…` 的 draft_content.json 是加密的，
 *   `自用IP…` 是音效，跟字幕无关。）
 *
 * 所以这里做的是：**按名字里的排版关键词解析出一套确定性参数** ——
 * 名字说「三排字幕」就真的给三行、说「顶部」就真的落顶部、说「弹出」就真的缩放进场。
 * 名字里没说的（例如「预设16」这种纯编号）按稳定规则分配，卡片上能看到实际效果。
 *
 * ── 封面为什么一张都不用 ────────────────────────────────────────────
 *
 * 实测：封面是卖家做的**黑底占位图**，有的还带卖家水印（旋转的「河爸@同学」），
 * 有的是 1920×1080 横版、有的是 1080×1920 竖版，与本软件的画幅对不上。
 * 直接铺进界面既是别人的品牌痕迹，也看不出效果。按 Jason 的要求，
 * 卡片底图统一用软件自己的字幕底图（`.style-art` 的 plate.webp）。
 *
 * ── 输出 ───────────────────────────────────────────────────────────
 *
 * packages/desktop/src/shared/subtitlePresets.json —— UI 与 MCP 共读的唯一真源。
 * 片段怎么拼（几行、错峰多久、文字写什么）在 shared/subtitlePresets.js 里算，
 * 这里只落"参数"，两边不各写一遍。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
/* 样式表与动画表都是真源，生成时就要对着它们校验 —— 写一个不存在的 key
   不会报错，只会让那张卡"点了没反应"（样式退回 fallback、动画退回 none）。 */
const textStyles = require('../packages/desktop/src/shared/textStyles.json')
const { IN_TYPES, OUT_TYPES, LOOP_TYPES } = require('../packages/desktop/src/shared/textAnim.js')

const ROOT_DEFAULT = 'F:/剪映900款口播字幕动态排版/剪映900款口播字幕动态排版'
const OUT = path.resolve('packages/desktop/src/shared/subtitlePresets.json')

/**
 * 六个分组。
 *
 * `dir` 是素材包里的目录名（原名照抄，不猜），`label` 是界面上的中文分组名。
 * 目录名里的数量与真实子目录数**不一定相等**（147 那组实际只有 146 个），
 * 所以下面的 count 一律现场数，不写死 —— 写死就会出现"界面说 147、实际 146"。
 */
const GROUPS = [
  { key: 'hero', label: '高级排版', dir: '109个高级感字幕预设', note: '一人一句的高级感排版' },
  { key: 'picked', label: '精选十款', dir: '10个高级感字幕预设', note: '十款高频复用的排版' },
  { key: 'name', label: '名字动画', dir: '147个开场结尾名字场动画＋音效', note: '开场 / 结尾的名字出场' },
  { key: 'talk', label: '口播覆盖', dir: '318个高级感字幕预设', note: '口播逐句覆盖与并列' },
  { key: 'basic', label: '基础动效', dir: '83个基础文字动画音效搭配预设', note: '单一动效的干净做法' },
  { key: 'card', label: '主图介绍', dir: 'A191个主图介绍款', note: '主图旁的分点介绍' }
]

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
/* 「两」在中文里就是 2，但它不在数字序列里 —— 漏了它，「两排字幕」
   会被当成 1 行（实测踩过：整包 100 多款「两排/两句」全落成单行）。 */
const CN_EXTRA = { 两: 2, 俩: 2, 双: 2 }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 名字里的中文数字 / 阿拉伯数字 → 数字（认不出返回 0） */
function numOf(token) {
  if (!token) return 0
  if (/^\d+$/.test(token)) return Number(token)
  if (CN_EXTRA[token]) return CN_EXTRA[token]
  const i = CN.indexOf(token)
  return i >= 0 ? i + 1 : 0
}

/**
 * 行数：一条字幕里有几行。
 * 「两排 / 3 行 / 2 句 / 3 序号」直接给数；「四宫格」按 2 行近似
 * （drawtext 排不了真栅格，见 chainOf 里对宫格的补偿）；「多」类词给 3。
 * 上限 3 —— 再多在手机竖屏里字号会小到看不清。
 */
function rowsOf(name) {
  if (/宫格/.test(name)) return 2
  const m = name.match(/([一二两俩双三四五六七八九十]|\d+)\s*(排|行|句|点|条|序号|编号)/)
  if (m) return clamp(numOf(m[1]) || 1, 1, 3)
  if (/多字幕|多排|多行|多句|多字|多信息|多重复合/.test(name)) return 3
  return 1
}

/**
 * 条数：这一款要落几条片段。1 = 一条（多行靠换行），>1 = 多条错峰。
 *
 * 只有三类名字需要多条，其余一律一条：
 *   · 「覆盖」= 后一句盖掉前一句（口播最常见）→ 条数 = 行数
 *   · 「逐字 / 逐行 / 依次 / 分别出现 / 顺序出现」= 一条一条来 → 条数 = max(行数, 2)
 *   · 「N 字叠加」= 单字叠着出现 → 条数 = N
 */
function chainOf(name, rows) {
  /* 宫格：四格 = 四条单行依次出现。drawtext 排不了 2×2 的真栅格，
     但"四条依次"保留了这个预设真正能被感知的部分（顺序出现）。 */
  if (/宫格/.test(name)) return 4
  const stack = name.match(/([一二两俩双三四五六七八九]|\d+)\s*字\s*(叠加|叠)/)
  if (stack) return clamp(numOf(stack[1]) || 2, 2, 4)
  if (/覆盖/.test(name)) return clamp(rows, 1, 3)
  if (/逐字|逐行|逐句|依次|顺序出现|分别出现|接力|轮播/.test(name)) return clamp(rows > 1 ? rows : 3, 2, 4)
  const pts = name.match(/([一二两俩双三四五六七八九]|\d+)\s*(点|条|个)\s*(建议|要点|信息|理由)/)
  if (pts) return clamp(numOf(pts[1]) || 2, 2, 4)
  return 1
}

/** 多条之间的关系：叠加/逐字 = 同位置叠着来；覆盖/依次 = 接力（前一条到点结束） */
function modeOf(name) {
  if (/叠加|叠字|逐字/.test(name)) return 'stack'
  if (/覆盖|依次|分别出现|顺序出现|逐行|逐句|接力|轮播/.test(name)) return 'seq'
  return 'stack'
}

/**
 * ── 名字没说的事，怎么定 ────────────────────────────────────────────
 *
 * 857 款里有一大半名字是纯编号（「120.预设」「温9-2行字幕1」），
 * 关键词解析不出来任何东西。全给默认值的话会出现 **743/857 张一模一样的卡**
 * （实测过：全落 `sub-plain` + 底部居中 + 上浮），点开也没区别 —— 等于 857 个空壳。
 *
 * 所以每个维度分两段：
 *   ① 名字说了就听名字（`styleOf` 等返回具体值）；
 *   ② 名字没说（返回 null）就从一张**固定调色板**里按序号取。
 *
 * 调色板按序号取而不是随机：同一份素材重跑生成器结果必须逐字节相同，
 * 否则每次生成清单都在变，草稿里存的 key 指向的效果会跟着漂。
 * 相邻两张卡取到不同的一格（取模的下标就是组内序号），所以一屏里不会连成一片。
 *
 * ⚠️ 这是"生成侧"的取舍，不改名字。名字说「顶部」就一定在顶部 ——
 *    调色板只填名字**没说**的那几格。
 */
const STYLE_PAL = ['sub-plain', 'sub-bar', 'sub-plain', 'sub-accent', 'sub-plain', 'sub-tag', 'sub-hollow', 'sub-bar']
const IN_PAL = ['up', 'fade', 'zoom', 'up', 'left', 'right', 'up', 'down']
const ALIGN_PAL = ['center', 'center', 'center', 'left', 'center', 'right']
const SCALE_PAL = [1, 1, 1.15, 1, 0.9, 1]
/* 「名字动画」那一组默认落在画面中间（开场/结尾的名字就在中间），其余落底部 */
const ANCHOR_PAL = {
  name: ['center', 'center', 'center', 'center', 'bottom', 'center', 'top', 'center'],
  rest: ['bottom', 'bottom', 'bottom', 'bottom', 'bottom', 'center', 'bottom', 'top']
}
const pickPal = (pal, index) => pal[Math.abs(Number(index) || 0) % pal.length]

/** 落点：anchor 决定贴着哪一头，align 决定整块靠哪边。名字没说 → null */
function anchorOf(name) {
  if (/中间|居中|正中|屏幕中央/.test(name)) return 'center'
  if (/顶部|上方|顶端/.test(name)) return 'top'
  if (/屏幕下方|底部|下方|底栏|贴底/.test(name)) return 'bottom'
  return null
}

function alignOf(name) {
  if (/右侧|右边|靠右/.test(name)) return 'right'
  if (/左侧|左边|靠左/.test(name)) return 'left'
  /* 「并列 / 宫格 / 居中 / 居中排」说的是整块摆在画面中间，不是靠某一边 */
  if (/并列|宫格|居中|正中/.test(name)) return 'center'
  return null
}

/** 离锚点的距离（1280 基准 px）。「贴边」更近，「上方」更远，居中不用offset */
function offsetOf(name, anchor) {
  if (anchor === 'center') return 0
  if (/贴边|紧贴|贴底|贴顶/.test(name)) return 24
  if (/上方|上移|抬高/.test(name)) return anchor === 'top' ? 36 : 200
  return 56
}

/**
 * 入场动效。**顺序有意义**（先判具体词、再判泛词），
 * 否则「向上擦除」会被「向上」抢走，擦除的手感就没了。
 * 名字里没有任何方位/动作词 → 返回 null，交给调色板。
 */
function inOf(name) {
  /* 「弹出 / 弹跳」排在「毛刺」前面：像「毛刺弹出字体」这种名字里，
     毛刺说的是**字面质感**（走 loop 的 sway 去表达），弹出才是动作。
     顺序反过来的话，一切带毛刺的预设都会变成横滑入场。 */
  if (/弹出|弹入|弹跳|跳动|跳字/.test(name)) return { in: 'zoom', inDur: 0.28 }
  if (/毛刺|故障|乱码/.test(name)) return { in: 'left', inDur: 0.18 }
  if (/擦|露出|划出|切开|割|撕裂|裂开/.test(name)) return { in: 'left', inDur: 0.45 }
  if (/吸入|吸收|集合|聚拢/.test(name)) return { in: 'zoom', inDur: 0.34 }
  if (/飞入|冲屏|撞|顶出/.test(name)) return { in: 'zoom', inDur: 0.24 }
  if (/翻|旋转|转动/.test(name)) return { in: 'zoom', inDur: 0.4 }
  if (/缩放|放大|缩小/.test(name)) return { in: 'zoom', inDur: 0.36 }
  if (/打字/.test(name)) return { in: 'fade', inDur: 0.6 }
  if (/向上|上浮|上升|上移|飘起/.test(name)) return { in: 'up', inDur: 0.36 }
  if (/向下|下落|下沉|下降|砸/.test(name)) return { in: 'down', inDur: 0.36 }
  if (/向左|左移|左滑/.test(name)) return { in: 'left', inDur: 0.36 }
  if (/向右|右移|右滑/.test(name)) return { in: 'right', inDur: 0.36 }
  if (/滑动|滑入|上滑|下滑/.test(name)) return { in: 'up', inDur: 0.4 }
  if (/模糊|虚化|晕开/.test(name)) return { in: 'fade', inDur: 0.5 }
  if (/淡|渐显|显影|溶解/.test(name)) return { in: 'fade', inDur: 0.5 }
  return null
}

/** 出场：名字说了就换，没说一律淡出（出场比入场少，多给默认值不会显得单调） */
function outOf(name) {
  if (/散去|飘散|消失|缩小|收/.test(name)) return { out: 'zoom', outDur: 0.3 }
  if (/下沉|落下/.test(name)) return { out: 'down', outDur: 0.3 }
  if (/上飘|升起/.test(name)) return { out: 'up', outDur: 0.3 }
  return { out: 'fade', outDur: 0.3 }
}

/** 循环：只在名字真的说了才开 —— 没说的开着会一直在动，很吵 */
function loopOf(name) {
  if (/故障|乱码|毛刺|闪|抖|震|晃/.test(name)) return 'sway'
  if (/飘|浮动|呼吸|波|跳/.test(name)) return 'float'
  if (/发光|辉光|光效|霓虹/.test(name)) return 'breathe'
  return 'none'
}

/**
 * 视觉底子：从名字里的质感词挑一个现成样式。
 * 一律落在 `textStyles.json` 已有的 key 上 —— 不新造样式，
 * 因为预览（renderer/textStyles.js）与导出（main/subtitles.js）都只认这张表。
 * 名字没提质感 → null（走调色板）。
 */
function styleOf(name) {
  if (/打字/.test(name)) return 'sub-typing'
  if (/发光|辉光|光效|霓虹|雪光/.test(name)) return 'sub-neon'
  if (/描边|空心|轮廓/.test(name)) return 'sub-hollow'
  if (/标签|胶囊|圆角|注音/.test(name)) return 'sub-tag'
  if (/底栏|底色|背景|色块|字幕条/.test(name)) return 'sub-bar'
  if (/重点|强调|高亮|划重点/.test(name)) return 'sub-accent'
  if (/渐变/.test(name)) return 'title-gradient'
  if (/小标题/.test(name)) return 'sub-tag'
  if (/标题|大字|全屏/.test(name)) return 'title-hero'
  if (/黄/.test(name)) return 'art-yellow-glow'
  if (/蓝/.test(name)) return 'art-blue-glow'
  if (/红/.test(name)) return 'art-red-glow'
  if (/绿/.test(name)) return 'art-green-glow'
  return null
}

/** 字号倍数：名字说「大字/全屏」就放大，「小字/角标」就缩小；没说 → null */
function scaleOf(name) {
  if (/超大|特大|全屏|大字|放大/.test(name)) return 1.45
  if (/小字|小号|角标/.test(name)) return 0.8
  return null
}

/** 名字里的「序号 / 编号 / 列举 / 要点」—— 采样文字要写成「1. 第一点」 */
const numberedOf = (name) => /序号|编号|列举|要点|建议|举例|理由/.test(name)

/**
 * 显示名：只做**首尾空白**清理（318 那组有大量名字带前导空格，界面里会缩进一格）。
 *
 * ⚠️ 不能顺手把「117.」这种序号前缀去掉：`A191个主图介绍款` 那一组里有
 *    「120.预设」「121.预设8」这类名字，剥掉序号后全变成「预设」/「预设8」，
 *    同组内大量重名 —— 界面上会出现一片一模一样的卡，谁也分不清点的是哪个。
 *    序号是这一包自己的排序，保留它反而是最有辨识度的部分。
 */
function displayName(raw) {
  return String(raw || '').trim()
}

/** 名前缀里的数字（用于「1. xx … 191. xx」这种按序号排） */
function sortIndex(raw) {
  const m = String(raw || '').match(/^\s*(\d+)\./)
  return m ? Number(m[1]) : 0
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/**
 * 一款预设 → 一套参数。
 *
 * `index` 是它在本组里的序号，只用来在"名字没说"的那几格上从调色板取值。
 * 三处默认值在这里收口：anchor / align / style / in / scale。
 */
function recipeOf(raw, group, index) {
  const name = displayName(raw)
  const rows = rowsOf(name)
  const chain = chainOf(name, rows)
  /* 多行块（两排/三行/举例 3 点）：名字没说位置时**默认居中排**。
     三行字落在底部会顶到安全区外、落在顶边又像标题 —— 中间才是"一屏几句话"的样子。
     名字说了位置（如「屏幕下方」）仍听名字。 */
  const block = chain === 1 && rows > 1
  const anchor = anchorOf(name) || (block ? 'center' : pickPal(ANCHOR_PAL[group] || ANCHOR_PAL.rest, index))
  const align = alignOf(name) || (block ? 'center' : pickPal(ALIGN_PAL, index))
  const anim = inOf(name)
  return {
    name,
    src: String(raw).trim(),
    group,
    style: styleOf(name) || pickPal(STYLE_PAL, index),
    anchor,
    align,
    offset: offsetOf(name, anchor),
    scale: scaleOf(name) || pickPal(SCALE_PAL, index),
    in: anim ? anim.in : pickPal(IN_PAL, index),
    out: outOf(name).out,
    loop: loopOf(name),
    inDur: anim ? anim.inDur : 0.36,
    outDur: outOf(name).outDur,
    rows: chain > 1 ? 1 : rows,
    chain,
    mode: modeOf(name),
    ...(numberedOf(name) ? { numbered: true } : {})
  }
}

function build(root) {
  const groups = []
  const presets = []
  let seq = 0
  for (const g of GROUPS) {
    const dir = path.join(root, g.dir)
    if (!fs.existsSync(dir)) throw new Error(`素材目录不存在：${dir}`)
    const kids = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      /* 一个预设 = 一个目录，里面必有 preset_draft/draft_content.json。
         少了它的（例如缺素材的几个）直接跳过，不生成点开是空的卡。 */
      .filter((d) => fs.existsSync(path.join(dir, d.name, 'preset_draft', 'draft_content.json')))
      .map((d) => d.name)
      .sort((a, b) => sortIndex(a) - sortIndex(b) || collator.compare(a, b))
    kids.forEach((raw, i) => {
      seq += 1
      const r = recipeOf(raw, g.key, i)
      presets.push({
        key: `sp-${g.key}-${String(i + 1).padStart(3, '0')}`,
        ...r
      })
    })
    groups.push({ key: g.key, label: g.label, note: g.note, count: kids.length, source: g.dir })
  }
  return { version: 1, groups, presets, seq }
}

/* ------------------------------- 校验 ------------------------------- */

const STYLE_KEYS = new Set(textStyles.styles.map((s) => s.key))
const IN_KEYS = new Set(IN_TYPES.map((t) => t.key))
const OUT_KEYS = new Set(OUT_TYPES.map((t) => t.key))
const LOOP_KEYS = new Set(LOOP_TYPES.map((t) => t.key))

function validate(rows) {
  const bad = []
  const keys = new Set()
  const names = new Map()
  for (const p of rows.presets) {
    if (keys.has(p.key)) bad.push(`key 重复：${p.key}`)
    keys.add(p.key)
    if (!p.name) bad.push(`${p.key} 名字为空`)
    /* 同一个分组里同名不许出现两次：界面靠名字区分，重名等于一对一模一样的卡 */
    const tag = `${p.group}/${p.name}`
    if (names.has(tag)) bad.push(`同组重名：${tag}`)
    names.set(tag, true)
    if (!STYLE_KEYS.has(p.style)) bad.push(`${p.key} 样式不存在：${p.style}`)
    if (!IN_KEYS.has(p.in)) bad.push(`${p.key} 入场动画不存在：${p.in}`)
    if (!OUT_KEYS.has(p.out)) bad.push(`${p.key} 出场动画不存在：${p.out}`)
    if (!LOOP_KEYS.has(p.loop)) bad.push(`${p.key} 循环动画不存在：${p.loop}`)
    if (!['top', 'center', 'bottom'].includes(p.anchor)) bad.push(`${p.key} 锚点非法：${p.anchor}`)
    if (!['left', 'center', 'right'].includes(p.align)) bad.push(`${p.key} 对齐非法：${p.align}`)
    if (!(p.offset >= 0 && p.offset <= 600)) bad.push(`${p.key} offset 越界：${p.offset}`)
    if (!(p.rows >= 1 && p.rows <= 3)) bad.push(`${p.key} rows 越界：${p.rows}`)
    if (!(p.chain >= 1 && p.chain <= 4)) bad.push(`${p.key} chain 越界：${p.chain}`)
  }
  const counted = rows.groups.reduce((n, g) => n + g.count, 0)
  if (counted !== rows.presets.length) bad.push(`分组计数 ${counted} ≠ 预设数 ${rows.presets.length}`)
  return bad
}

/* ------------------------------- 主流程 ------------------------------- */

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const rootArg = args.find((a) => !a.startsWith('--'))
const root = path.resolve(rootArg || ROOT_DEFAULT)

const built = build(root)
const problems = validate(built)
if (problems.length) {
  console.error(`[gen-subtitle-presets] 生成结果不自洽（${problems.length} 条）：`)
  for (const p of problems.slice(0, 20)) console.error('  ·', p)
  process.exit(1)
}

/* 去掉校验用的 seq（不是数据） */
const payload = { version: built.version, groups: built.groups, presets: built.presets }
const next = `${JSON.stringify(payload, null, 1)}\n`

if (checkOnly) {
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (prev !== next) {
    console.error(`[gen-subtitle-presets] 清单与素材不一致，请重跑生成器：${OUT}`)
    process.exit(1)
  }
  console.log(`[gen-subtitle-presets] OK：${built.presets.length} 款预设与素材一致`)
  process.exit(0)
}

fs.writeFileSync(OUT, next, 'utf8')
const byGroup = built.groups.map((g) => `${g.label} ${g.count}`).join(' / ')
console.log(`[gen-subtitle-presets] 已写入 ${path.relative(process.cwd(), OUT)}`)
console.log(`  共 ${built.presets.length} 款：${byGroup}`)
