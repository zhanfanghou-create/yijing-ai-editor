#!/usr/bin/env node
/**
 * 预置音乐 / 音效的看门狗。
 *
 * 治的是这一类缺陷：**清单和面板都"看着有"、点了却没有声音**。
 *   · 清单条目 id 重复 ⇒ 两条卡片抢同一份缓存文件，点第二首播的是第一首；
 *   · url 写错（少个斜杠、http 而非 https）⇒ 卡片全都在，点下去全部失败；
 *   · 中文名漏了 ⇒ 卡片显示 `mus-127` 这种机器串，用户没法挑；
 *   · 缓存判定去读索引而不读磁盘 ⇒ 索引过期后面板显示"已缓存"，点下去没声；
 *   · `allowedMedia.add` 排在 `describeMedia` 之后 ⇒ 缓存好了但 `yjai-media://` 403，
 *     表现是"下载完成、点了没反应"（第 ④ 类静默失效：被协议层挡住）；
 *   · 面板在 `useEffect` 里就把整库预下载了 ⇒ 打开「音乐」那一页就偷偷跑掉几百 MB。
 *
 * 判据分三层：
 *   ① 清单本身（完整性 / 唯一性 / 分类覆盖 / 中文名 / 直链形态）；
 *   ② 缓存纯逻辑（`shared/musicCache.js`，用临时目录实测"文件在不在才算缓存"）；
 *   ③ 接线（AssetsTree 节点 → App 透传 → SidePanels 分支 → 主进程 IPC → preload），
 *      任何一环漏了都会让上面两层"全部通过但功能不存在"。
 *
 * 断言总数写死在 verify.mjs 的 expected 里，增减条目要同步改。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

const P = {
  catalog: path.join(ROOT, 'packages/desktop/src/shared/musicCatalog.json'),
  cache: path.join(ROOT, 'packages/desktop/src/shared/musicCache.js'),
  main: path.join(ROOT, 'packages/desktop/src/main/music.js'),
  ipc: path.join(ROOT, 'packages/desktop/src/main/index.js'),
  preload: path.join(ROOT, 'packages/desktop/src/preload/index.js'),
  tree: path.join(ROOT, 'packages/desktop/src/renderer/components/AssetTree.jsx'),
  side: path.join(ROOT, 'packages/desktop/src/renderer/components/SidePanels.jsx'),
  app: path.join(ROOT, 'packages/desktop/src/renderer/App.jsx')
}

let total = 0
let failures = 0
const rows = []

function check(name, ok, detail = '') {
  total += 1
  if (!ok) failures += 1
  rows.push(`${ok ? '✓' : '✗'} ${String(total).padStart(2, '0')} ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 剥注释：静态断言读源码时，注释里写一句 `music:ensure` 会被当成真接线 */
function source(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const HAN = /[\u4e00-\u9fa5]/

/* ------------------------------- ① 清单 ------------------------------- */

const catalog = JSON.parse(fs.readFileSync(P.catalog, 'utf8'))
const items = Array.isArray(catalog.items) ? catalog.items : []
const cats = Array.isArray(catalog.cats) ? catalog.cats : []

check('清单能解析出条目', items.length > 0, `${items.length} 条`)
check('条目数不少于 200（清单一被清空，"每条都合法"会恒真）', items.length >= 200, `${items.length}`)
check(
  '清单带来源与许可（换源时才知道该改哪几处）',
  Boolean(catalog.source && catalog.license && catalog.licenseUrl),
  `${catalog.source || '-'} / ${catalog.license ? '有许可说明' : '缺许可'}`
)

const ids = items.map((it) => it.id)
const urls = items.map((it) => it.url)
check('id 唯一（重复会让两首共用同一份缓存文件）', new Set(ids).size === ids.length, `${ids.length} → ${new Set(ids).size}`)
check('url 唯一（重复说明分类页抓重了）', new Set(urls).size === urls.length, `${urls.length} → ${new Set(urls).size}`)

const badId = items.find((it) => !/^(sfx|mus)-\d+$/.test(String(it.id)) || !String(it.id).startsWith(it.kind === 'sfx' ? 'sfx-' : 'mus-'))
check('id 形态与 kind 一致（缓存文件名直接用 id，错了就落到别的文件上）', !badId, badId ? badId.id : '全部合法')

const badUrl = items.find((it) => !/^https:\/\/assets\.mixkit\.co\/\S+\.mp3$/.test(String(it.url)))
check('直链都是 https + 单一音频域名 + .mp3', !badUrl, badUrl ? badUrl.url : '全部合法')

const badDur = items.find((it) => !(Number(it.seconds) > 0))
check('每条都有时长（挑曲时第一眼要看的数字）', !badDur, badDur ? badDur.id : '全部有时长')

const badName = items.find((it) => !it.name || !HAN.test(String(it.name)))
check('每条都有中文名（不然卡片上是一串 mus-127）', !badName, badName ? badName.id : '全部有中文名')

const declared = new Set(cats.map((c) => `${c.kind}/${c.key}`))
const used = new Set(items.map((it) => `${it.kind}/${it.cat}`))
const orphanCat = [...used].filter((key) => !declared.has(key))
const emptyCat = [...declared].filter((key) => !used.has(key))
check('每个用到的分类都在分类表里（分类表是左栏子页签的唯一来源）', orphanCat.length === 0, orphanCat.join(',') || '无孤儿分类')
check('分类表里每个分类都有条目（否则那一页点开是空的）', emptyCat.length === 0, emptyCat.join(',') || '无空分类')

const dupName = (() => {
  const seen = new Map()
  for (const it of items) {
    const key = `${it.kind}/${it.cat}/${it.name}`
    if (seen.has(key)) return `${key}（${seen.get(key)} 与 ${it.id}）`
    seen.set(key, it.id)
  }
  return ''
})()
check('同一分类内没有重名卡片（两张一样的卡片，用户分不出点哪个）', !dupName, dupName || '无重名')

/* ------------------------------ ② 缓存逻辑 ------------------------------ */

const cache = require(P.cache)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-music-'))
const sample = items[0]
const sample2 = items.find((it) => it.id !== sample.id)

check('缓存目录建在 userData 下（不污染安装目录）', cache.musicRootOf('/u').endsWith(cache.CACHE_DIR), cache.musicRootOf('/u'))
check('文件名只用 id（中文名会随词表改，改了就是一堆孤儿文件）', cache.fileNameOf(sample) === `${sample.id}.${sample.ext}`, cache.fileNameOf(sample))
check(
  '文件名拒绝带路径分隔/穿越的 id（否则可以写到缓存目录外）',
  cache.fileNameOf({ id: '../../evil' }) === '' && cache.fileNameOf({ id: 'a/b' }) === '',
  JSON.stringify([cache.fileNameOf({ id: '../../evil' }), cache.fileNameOf({ id: 'a/b' })])
)

check('还没下过：cached=false', cache.stateOf(tmp, sample, {}).cached === false)
fs.writeFileSync(cache.fileOf(tmp, sample), Buffer.alloc(2048))
const afterWrite = cache.stateOf(tmp, sample, {})
check('磁盘上有了文件才算缓存（判据读文件，不读索引）', afterWrite.cached === true && afterWrite.bytes === 2048, `cached=${afterWrite.cached} bytes=${afterWrite.bytes}`)

cache.remember(tmp, sample, { seconds: 3.5, bytes: 2048 })
check('实测时长写进索引并优先于清单标称值', cache.readIndex(tmp)[sample.id].seconds === 3.5, JSON.stringify(cache.readIndex(tmp)[sample.id]))

const status = cache.statusOf(tmp, items)
check('整表状态只标出真正在盘上的那一条', Object.keys(status).filter((id) => status[id].cached).length === 1, `${Object.keys(status).filter((id) => status[id].cached).length} 条`)

check(
  '占用统计只算已缓存的那几条',
  cache.usageOf(tmp, items).count === 1 && cache.usageOf(tmp, items).bytes === 2048,
  JSON.stringify(cache.usageOf(tmp, items))
)

/* 索引里挂着、文件被外部删掉 ⇒ 必须清掉，否则面板显示"已缓存"却点不出声 */
fs.unlinkSync(cache.fileOf(tmp, sample))
const pruned = cache.pruneIndex(tmp, items)
check('文件被删后索引会被清理（否则界面说已缓存、点下去没声）', pruned === 1 && !cache.readIndex(tmp)[sample.id], `清理 ${pruned} 条`)

/* 存在的那条不能被误清 */
fs.writeFileSync(cache.fileOf(tmp, sample2), Buffer.alloc(1024))
cache.remember(tmp, sample2, { seconds: 10, bytes: 1024 })
const pruned2 = cache.pruneIndex(tmp, items)
check('存在的文件不受清理影响', pruned2 === 0 && Boolean(cache.readIndex(tmp)[sample2.id]), `清理 ${pruned2} 条`)
fs.rmSync(tmp, { recursive: true, force: true })

/* ------------------------------- ③ 接线 ------------------------------- */

const treeSrc = source(P.tree)
const sideSrc = source(P.side)
const appSrc = source(P.app)
const ipcSrc = source(P.ipc)
const preloadSrc = source(P.preload)
const mainSrc = source(P.main)

const audioBlock = (() => {
  const at = treeSrc.indexOf('audio: {')
  if (at < 0) return ''
  const end = treeSrc.indexOf('\n  },', at)
  return end > at ? treeSrc.slice(at, end) : treeSrc.slice(at, at + 2000)
})()

check(
  '左栏「音频」有音乐与音效两个节点，且都指向曲库面板',
  /key: 'audio-music'[\s\S]*?panel: 'music-library'/.test(audioBlock) && /key: 'audio-sfx'[\s\S]*?panel: 'music-library'/.test(audioBlock),
  audioBlock ? '两个节点都在' : '找不到 audio 树块'
)
check(
  '两个节点各自带分组键（漏了 → 点「音效」出来的是音乐）',
  /key: 'audio-music'[^}]*music: 'music'/.test(audioBlock) && /key: 'audio-sfx'[^}]*music: 'sfx'/.test(audioBlock)
)
check('「音乐」不再是"按类型筛本地素材"（那会让曲库面板根本不挂载）', !/key: 'audio-music'[^}]*kinds:/.test(audioBlock))

check('App 把分组键透传给中栏面板（漏了 → 两页都是音乐）', /musicGroup=\{currentNode\.music/.test(appSrc))
check('中栏有 music-library 分支', /mode === 'music-library'/.test(sideSrc))
check('面板读的是随包的同一份清单（不是自己抄一份数据）', /from '\.\.\/\.\.\/shared\/musicCatalog\.json'/.test(sideSrc))

const panelSrc = (() => {
  const at = sideSrc.indexOf('function MusicPanel(')
  if (at < 0) return ''
  const end = sideSrc.indexOf('\n/* ------------------------------- 智能抠像', at)
  return end > at ? sideSrc.slice(at, end) : sideSrc.slice(at, at + 12000)
})()
check('面板组件存在', Boolean(panelSrc))
check('面板把每一条都挂上了可断言的钩子（data-music-card / cached / playing）', /data-music-card=/.test(panelSrc) && /data-music-cached=/.test(panelSrc) && /data-music-playing=/.test(panelSrc))

/* "不点击不下载"：ensure 只能出现在点击回调里，不能出现在挂载/副作用里。
   ⚠️ 这里必须**按括号配对**取 useEffect 的真实范围。第一版图省事，用
      "切到下一条 useEffect 为止"当边界，于是切片一路跨过了后面 ensureOne 的定义，
      报出"副作用里出现了 ensure" —— 断言是真的，切法却是错的。
      静态检查的假红比漏报更坏：它会逼人改本来没错的代码。 */
function callRange(src, from) {
  const open = src.indexOf('(', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return { start: from, end: i + 1, body: src.slice(from, i + 1) }
    }
  }
  return null
}

const effectHits = (() => {
  const hits = []
  let idx = panelSrc.indexOf('useEffect(')
  while (idx >= 0) {
    const range = callRange(panelSrc, idx)
    if (range && /music\.ensure|ensureOne\(/.test(range.body)) hits.push(range.body.slice(0, 100))
    idx = panelSrc.indexOf('useEffect(', idx + 10)
  }
  return hits
})()
check('打开面板不会自动下载（"不点击不下载"就钉在这里）', effectHits.length === 0, effectHits.length ? effectHits[0] : '副作用干净')
check('点试听才会调主进程取音频', /window\.yjai\.music\.ensure\(/.test(panelSrc))

check('主进程用同一个下载器（续传/换源/代理/看门狗都在里面）', /fetchFile\s*\]?\s*=|fetchFile\(/.test(mainSrc) && /require\('\.\/models'\)/.test(mainSrc))
check(
  '同一首并发点击共用一次下载（否则两路写同一个 .part）',
  /inflight\.has\(item\.id\)/.test(mainSrc) && /inflight\.set\(item\.id/.test(mainSrc)
)

const ipcAt = ipcSrc.indexOf("ipcMain.handle('music:ensure'")
const describeAt = ipcSrc.indexOf('describeMedia(res.path)', ipcAt)
check(
  'IPC 存在 music:ensure / music:status',
  ipcAt > 0 && ipcSrc.includes("ipcMain.handle('music:status'")
)
/* 判据是"有没有走本文件的 describeMedia"（它内部 allowedMedia.add），
   而不是"有没有显式写一行 allowedMedia.add"。
   第一版断言的是后者，负对照当场证明它是**假判据**：删掉那行，播放照样成功 ——
   真正登记白名单的是 describeMedia，那行是重复登记。
   现在的写法能真的挡住事故：换成 `media.describeMedia`（不登记）就会 403。 */
check(
  '回地址时走本进程的 describeMedia（它才是白名单登记点；换成 media.describeMedia 会 403）',
  ipcAt > 0 && describeAt > ipcAt && !/media\.describeMedia\(res\.path\)/.test(ipcSrc.slice(ipcAt, describeAt + 400)),
  ipcAt > 0 ? `describeMedia@${describeAt}` : '找不到 handler'
)
check(
  '进度推送带节流（不节流会让下载时界面一顿一顿）',
  /pct === lastPct/.test(ipcSrc) && /now - lastAt < 200/.test(ipcSrc)
)
check('preload 暴露 status / ensure / onProgress 三个口子', /music: \{[\s\S]{0,400}?status:/.test(preloadSrc) && /ensure: \(id\) =>/.test(preloadSrc) && /onProgress: \(handler\)/.test(preloadSrc))

/* ------------------------------- 输出 ------------------------------- */

for (const row of rows) console.log(`  ${row}`)
const pass = total - failures
console.log(`MUSIC_LIBRARY_STATS total=${total} pass=${pass} fail=${failures} skip=0`)
if (failures) {
  console.log(`\nMUSIC_LIBRARY_FAILED  ${failures} 条不成立`)
  process.exitCode = 1
} else {
  console.log(`\nMUSIC_LIBRARY_OK  ${items.length} 条预置素材 · ${cats.length} 个分类 · 缓存只认磁盘文件`)
}
