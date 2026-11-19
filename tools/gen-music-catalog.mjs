/**
 * 音乐 / 音效清单生成器。
 *
 * 产物：`packages/desktop/src/shared/musicCatalog.json`（随包发布，**离线可浏览**）。
 *
 * 为什么是"生成"而不是"运行时搜索"：
 *   ① 清单要能在**没有网**的时候也看得见（卡片、分类、时长全在本地），
 *      否则一断网整个「音乐」页就是空白 —— 那正是"接对了但看不见"。
 *   ② 运行时只做一件事：用户点某一条时，把那一首的音频文件抓下来缓存。
 *      搜索接口是外站的、随时会改版/限流，不能让它成为"打开面板"的前置条件。
 *   ③ 清单进仓库 ⇒ 闸门能钉住它（条数、去重、分类、直链格式、许可字段），
 *      而钉一个会变的远端接口只会天天假红。
 *
 * 用法：
 *   node tools/gen-music-catalog.mjs            # 抓取并写盘
 *   node tools/gen-music-catalog.mjs --report   # 只报告（不写盘），看词表覆盖率与未译词
 *
 * ⚠️ 中文名是**受控词表**拼出来的（不是整句机翻）：
 *    英文标题多是"电影感/快速/转场"这种词的组合，逐词映射再拼比机翻更可控，
 *    而且拼错了能一眼看出来是词表的问题。词表外的词**直接丢掉**而不是保留原文，
 *    免得出现"中文里夹一个 whoosh"这种半成品。
 *    丢完一个词都不剩时退回「分类名 + 序号」，保证任何一条都有可读名字。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'packages/desktop/src/shared/musicCatalog.json')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/* ------------------------------------------------------------------ 分类表 */

/**
 * 每类取前 N 条。为什么封顶：清单是给人**挑**的，不是给人刷的；
 * 一个分类塞 30 条只会让"下一页"变成新的空白。分类宁多、每类宁少。
 */
const PER_CAT = 12

const SFX_CATS = [
  { slug: 'whoosh', zh: '嗖声' },
  { slug: 'swoosh', zh: '呼啸' },
  { slug: 'transition', zh: '转场' },
  { slug: 'impact', zh: '冲击' },
  { slug: 'cinematic', zh: '影视' },
  { slug: 'glitch', zh: '故障' },
  { slug: 'zoom', zh: '变焦' },
  { slug: 'stomp', zh: '脚步' },
  { slug: 'sweep', zh: '扫频' },
  { slug: 'nature', zh: '自然' },
  { slug: 'city', zh: '城市' },
  { slug: 'ambience', zh: '环境' }
]

const MUSIC_CATS = [
  { slug: 'ambient', zh: '舒缓' },
  { slug: 'chillout', zh: '轻电音' },
  { slug: 'pop', zh: '流行' },
  { slug: 'rock', zh: '摇滚' },
  { slug: 'hip-hop', zh: '嘻哈' },
  { slug: 'jazz', zh: '爵士' },
  { slug: 'classical', zh: '古典' },
  { slug: 'corporate-music', zh: '商务' },
  { slug: 'children', zh: '童趣' },
  { slug: 'funk', zh: '放克' }
]

/* -------------------------------------------------------------- 受控词表 */

/** 纯语法词：直接丢，不参与命名（留着会拼出"的·一个·在"这种） */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'by', 'with', 'to', 'for', 'from', 'into',
  'this', 'that', 'it', 'is', 'are', 'be', 'as', 's', 't', 'fi', 'lo', 'up', 'out', 'off',
  'i', 'you', 'my', 'me', 'we', 'our', 'your', 'he', 'she', 'they', 'no', 'not', 'do', 'de',
  'vol', 'part', 'pt', 'version', 'mix'
])

const DICT = {
  /* —— 音效题材 —— */
  whoosh: '嗖声', woosh: '嗖声', swoosh: '呼啸', swish: '挥舞', whip: '抽击',
  transition: '转场', impact: '冲击', hit: '撞击', slam: '猛摔', punch: '重拳',
  cinematic: '电影感', movie: '影视', trailer: '预告片', epic: '史诗',
  glitch: '故障', glitchy: '故障', digital: '数码', electric: '电流', electronic: '电子',
  zoom: '变焦', slide: '滑入', spin: '旋转', sweep: '扫频', sweeping: '扫频', riser: '上升',
  stomp: '重踏', thud: '闷响', footstep: '脚步', footsteps: '脚步', step: '脚步',
  boom: '轰鸣', explosion: '爆炸', blast: '爆裂', gun: '枪声', shot: '射击',
  rumble: '低鸣', drone: '长鸣', hum: '嗡鸣', buzz: '蜂鸣', beep: '提示音',
  bell: '铃声', chime: '碰铃', horn: '号角', whistle: '口哨', alarm: '警报',
  click: '点击', tap: '轻叩', pop: '弹出', interface: '界面', ui: '界面',
  notification: '通知', message: '消息', success: '成功', error: '错误', warning: '警告',
  whooshes: '嗖声', swipe: '滑动', scroll: '滚动', typing: '打字', keyboard: '键盘',
  /* —— 自然 —— */
  rain: '雨', thunder: '雷', thunderstorm: '雷雨', storm: '风暴', wind: '风',
  water: '水', waves: '浪', river: '河流', ocean: '海洋', sea: '海', beach: '海滩',
  forest: '森林', jungle: '丛林', tree: '树', bird: '鸟', birds: '鸟鸣', dog: '狗',
  fire: '火', campfire: '篝火', night: '夜晚', morning: '清晨', dawn: '黎明',
  mountain: '山', desert: '沙漠', snow: '雪', cave: '洞穴', insect: '虫鸣',
  /* —— 城市 —— */
  city: '城市', urban: '都市', traffic: '车流', car: '汽车', subway: '地铁',
  station: '站台', crowd: '人群', people: '人声', street: '街道', market: '集市',
  office: '办公', school: '校园', airport: '机场', factory: '工厂', construction: '工地',
  /* —— 情绪 / 风格 —— */
  fast: '快速', quick: '快速', slow: '缓慢', short: '短促', long: '绵长', deep: '低沉',
  heavy: '厚重', light: '轻快', soft: '柔和', hard: '硬朗', big: '宏大', small: '细碎',
  happy: '欢快', joyful: '欢快', sad: '伤感', sad1: '伤感', romantic: '浪漫', love: '爱意',
  mystery: '悬疑', suspense: '悬念', horror: '惊悚', scary: '恐怖', dark: '暗黑',
  funny: '诙谐', comedy: '喜剧', cartoon: '卡通', cute: '可爱', cute1: '可爱',
  calm: '平静', relaxing: '放松', relaxation: '放松', meditation: '冥想', yoga: '瑜伽',
  energy: '动感', energetic: '动感', power: '力量', powerful: '强劲', driving: '推进',
  dreamy: '梦幻', dream: '梦', magic: '魔法', fairy: '童话', sparkle: '闪光',
  futuristic: '未来感', sci: '科幻', space: '太空', spacey: '太空', space1: '太空',
  game: '游戏', retro: '复古', vintage: '怀旧', old: '旧时光', classic: '经典',
  corporate: '商务', business: '商务', presentation: '演示', advertising: '广告',
  technology: '科技', tech: '科技', modern: '现代', minimal: '极简', clean: '干净',
  loop: '循环', loopable: '循环', intro: '开场', outro: '收尾', ending: '收尾',
  background: '背景', bgm: '配乐', theme: '主题', ambient: '氛围', ambience: '环境',
  atmosphere: '氛围', atmosphere1: '氛围', sound: '音效', sound1: '音效', effect: '音效',
  stinger: '标板', transition1: '转场', accent: '点缀', texture: '质感',
  /* —— 乐器 / 编制（音乐的识别度主要来自这几个词） —— */
  guitar: '吉他', acoustic: '木吉他', electric1: '电吉他', piano: '钢琴', drum: '鼓',
  drums: '鼓组', bass: '贝斯', synth: '合成器', string: '弦乐', strings: '弦乐',
  violin: '小提琴', cello: '大提琴', flute: '长笛', sax: '萨克斯', trumpet: '小号',
  organ: '风琴', choir: '人声合唱', vocal: '人声', vocals: '人声', beat: '节拍',
  /* —— 音乐风格 —— */
  hip: '嘻哈', hop: '嘻哈', jazz: '爵士', blues: '布鲁斯', funk: '放克', soul: '灵魂',
  rock: '摇滚', pop: '流行', trap: '陷阱说唱', reggae: '雷鬼', latin: '拉丁',
  country: '乡村', folk: '民谣', classical: '古典', orchestral: '管弦', opera: '歌剧',
  waltz: '圆舞曲', bossa: '波萨诺瓦', nova: '波萨诺瓦', swing: '摇摆', lofi: '低传真',
  house: '浩室', techno: '科技舞曲', dance: '舞曲', edm: '电子舞曲', dnb: '鼓打贝斯',
  /* —— 画面感名词（音乐标题里很多） —— */
  valley: '山谷', sunset: '日落', sunrise: '日出', sky: '天空', star: '星辰', stars: '星辰',
  moon: '月亮', sun: '阳光', cloud: '云', wind1: '风', road: '公路', journey: '旅程',
  travel: '旅行', home: '家', heart: '心', hope: '希望', life: '生活', time: '时光',
  summer: '夏日', winter: '冬日', spring: '春天', autumn: '秋天', christmas: '圣诞',
  holiday: '假日', party: '派对', wedding: '婚礼', children1: '童趣', kids: '童趣',
  toy: '玩具', playground: '游乐场', circus: '马戏', adventure: '冒险', quest: '探寻',
  hero: '英雄', battle: '战斗', war: '战争', victory: '胜利', kingdom: '王国',
  /* —— 零碎 —— */
  mix1: '混音', remix: '混音', original: '原创', main: '主段', full: '完整',
  flow: '流动', flowing: '流动', flying: '飞行', passing: '掠过', echo: '回声',
  reverb: '混响', tunnel: '隧道', air: '空气', metal: '金属', glass: '玻璃',
  wave1: '波', signal: '信号', frequency: '频率', radio: '电台', noise: '噪声',
  vinyl: '黑胶', tape: '磁带', clock: '时钟', heartbeat: '心跳', breath: '呼吸',
  arrow: '箭矢', rocket: '火箭', sword: '刀剑', dagger: '短刃', slash: '挥砍',
  laser: '激光', engine: '引擎', helicopter: '直升机', bus: '巴士', walking: '行走',
  insects: '虫鸣', crickets: '蟋蟀', dreams: '梦境', smooth: '顺滑', fun: '玩趣',
  funky: '放克', sports: '运动', stutter: '卡顿', rewind: '倒带', terror: '惊骇',
  ghostly: '幽森', darkness: '幽暗', windy: '风起', vacuum: '真空', user: '界面',
  near: '近景', sounds: '声响', video: '影像', explainer: '解说', orchestra: '管弦',
  warfare: '战场', pop1: '弹出', pops: '弹出', transition2: '转场', cool: '酷感'
}

/* ------------------------------------------------------------------ 抓取 */

function cardsOf(html) {
  const out = []
  const blocks = html.split('<div class="item-grid__item">').slice(1)
  for (const b of blocks) {
    const id = (b.match(/data-audio-player-item-id-value="(\d+)"/) || [])[1]
    const type = (b.match(/data-audio-player-item-type-value="([a-z]+)"/) || [])[1]
    const url = (b.match(/data-audio-player-preview-url-value="([^"]+)"/) || [])[1]
    const wave = (b.match(/data-audio-player-waveform-url-value="([^"]+)"/) || [])[1]
    const rawTitle = (b.match(/class="item-grid-card__title"[^>]*>([\s\S]*?)<\//) || [])[1]
    const dur = (b.match(/(\d+):(\d{2})/) || [])
    if (!id || !url) continue
    const seconds = dur.length ? Number(dur[1]) * 60 + Number(dur[2]) : 0
    out.push({
      id,
      type,
      url,
      wave: wave || '',
      en: rawTitle ? rawTitle.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() : '',
      seconds
    })
  }
  return out
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/* -------------------------------------------------------------- 中文命名 */

const unmapped = new Map()

function tokensOf(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
}

/**
 * 英文标题 → 中文短语。
 * 最多取 3 个词：再多就是"电影感·快速·转场·嗖声"这种，卡片一行放不下也不好看。
 */
function zhOf(title, fallback) {
  const words = tokensOf(title)
  const picked = []
  for (const w of words) {
    if (STOP.has(w) || /^\d+$/.test(w)) continue
    const zh = DICT[w]
    if (!zh) {
      if (!unmapped.has(w)) unmapped.set(w, 0)
      unmapped.set(w, unmapped.get(w) + 1)
      continue
    }
    if (!picked.includes(zh)) picked.push(zh)
    if (picked.length >= 3) break
  }
  return picked.length ? picked.join('·') : fallback
}

/* ------------------------------------------------------------------ 主流程 */

const report = process.argv.includes('--report')

const items = []
const seen = new Set()

async function collect(kind, cats, base) {
  for (const cat of cats) {
    let html
    try {
      html = await fetchHtml(`${base}${cat.slug}/`)
    } catch (error) {
      console.warn(`跳过 ${cat.slug}：${error.message}`)
      continue
    }
    const want = kind === 'sfx' ? '/sfx/' : '/music/'
    const cards = cardsOf(html).filter((c) => c.url.includes(want) && (!c.type || c.type === kind))
    let taken = 0
    /* 同名去重：同一分类里"嗖声""重踏""爵士"这种短名撞车很常见，
       两条卡片名字一模一样时用户根本分不出点哪个 —— 撞了就加序号，
       没撞的保持干净（不要给所有条目都挂一个 01 02 03）。 */
    const used = new Set()
    for (const card of cards) {
      if (taken >= PER_CAT) break
      const id = `${kind === 'sfx' ? 'sfx' : 'mus'}-${card.id}`
      if (seen.has(id)) continue
      seen.add(id)
      taken += 1
      const fallback = `${cat.zh}${String(taken).padStart(2, '0')}`
      let name = zhOf(card.en, fallback)
      if (used.has(name)) {
        let n = 2
        while (used.has(`${name} ${n}`)) n += 1
        name = `${name} ${n}`
      }
      used.add(name)
      items.push({
        id,
        kind,
        cat: cat.slug,
        catZh: cat.zh,
        name,
        en: card.en,
        seconds: card.seconds,
        url: card.url,
        ext: 'mp3'
      })
    }
    console.log(`${kind}/${cat.slug} 取 ${taken} 条`)
  }
}

await collect('sfx', SFX_CATS, 'https://mixkit.co/free-sound-effects/')
await collect('music', MUSIC_CATS, 'https://mixkit.co/free-stock-music/')

console.log(`\n合计 ${items.length} 条（音效 ${items.filter((i) => i.kind === 'sfx').length} / 音乐 ${items.filter((i) => i.kind === 'music').length}）`)
console.log(`未译词 ${unmapped.size} 个，出现 ${[...unmapped.values()].reduce((a, b) => a + b, 0)} 次`)
if (unmapped.size) {
  const top = [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
  console.log('Top 未译：', top.map(([w, n]) => `${w}:${n}`).join('  '))
}

if (report) {
  console.log('\n--report：不写盘')
  for (const cat of SFX_CATS) {
    const list = items.filter((i) => i.kind === 'sfx' && i.cat === cat.slug)
    console.log(`  [${cat.zh}] ${list.slice(0, 4).map((i) => i.name).join(' / ')}`)
  }
  for (const cat of MUSIC_CATS) {
    const list = items.filter((i) => i.kind === 'music' && i.cat === cat.slug)
    console.log(`  [${cat.zh}] ${list.slice(0, 4).map((i) => i.name).join(' / ')}`)
  }
  process.exit(0)
}

/** 写盘。`generatedAt` 不写时间戳：每次重跑都变会让闸门报"清单与上次不同" */
const payload = {
  version: 1,
  /* 清单来源与许可：只用于说明与署名，运行时**只**按 url 取文件 */
  source: 'https://mixkit.co',
  license: 'Mixkit License（可商用、无需署名；不得把音频本体单独转售或再分发）',
  licenseUrl: 'https://mixkit.co/license/',
  note: '清单随包发布，离线可浏览；音频本体在用户首次点击试听时才下载并永久缓存到本机。',
  cats: [
    ...SFX_CATS.map((c) => ({ kind: 'sfx', key: c.slug, zh: c.zh })),
    ...MUSIC_CATS.map((c) => ({ kind: 'music', key: c.slug, zh: c.zh }))
  ],
  items
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf8')
console.log(`\n已写入 ${path.relative(ROOT, OUT)}（${(fs.statSync(OUT).size / 1024).toFixed(1)} KB）`)
