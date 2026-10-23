'use strict'
/**
 * 素材包（打包 / 解包）—— 规则真源。
 *
 * 「导出素材包」= 把草稿以及它**真正引用到的每一个素材文件**收成一个 `.yjpack`：
 * 换一台机器、换一个盘符、把工程发给同事，打开还能播。没有这一步，"草稿"只是一堆
 * 指向 `C:\Users\xxx\Videos\...` 的绝对路径，换个环境就是满屏黑框。
 *
 * ## 为什么路径要改写成相对路径
 *   导出时把 `path` 改写成 `media/<序号>_<文件名>`、并**删掉 url**；
 *   导入时把 `media/...` 拼回解出来的绝对目录、再由主进程重新生成 url。
 *   两个方向都必须做，且**只做一半的后果完全对称**：
 *     · 只改 path 不删 url ⇒ 导入后画面还在读原机器的 `yjai-media://local/<旧路径>`
 *       （白名单登记过就能播，于是"在新机器上莫名其妙能播、但用的是不存在的老文件"）；
 *     · 只拼回 path 不重生 url ⇒ 文件就在隔壁，画面却是黑的（url 空）。
 *
 * ## 为什么把"收哪些文件"放在这里而不是主进程
 *   渲染层要在**点导出之前**告诉用户「这一段素材找不到了，包不完整」，
 *   主进程只在真正写包时才有机会说话。同一份 walk 逻辑写两遍必然分叉：
 *   一边算了 `clip.path`、另一边只算了 `asset.path` ⇒ 复合片段里的孩子被漏掉，
 *   包"导出成功"，到对面却是黑帧 —— 这种错两边单独看都没问题。
 *
 * ⚠️ 本文件是 **CommonJS**（主进程 require，渲染层由 vite 的 commonjs 插件转）。
 *    新增模块必须同步 `packages/desktop/vite.config.mjs` 的 `commonjsOptions.include`。
 */

const PACK_VERSION = 1
/** 包内目录名（与草稿里改写后的路径前缀一致） */
const MEDIA_DIR = 'media'
const DRAFT_FILE = 'draft.json'
const MANIFEST_FILE = 'manifest.json'
/** 包根目录下的说明文件（给人看的，程序不读） */
const README_FILE = 'README.txt'
/** 单个文件名上限：留足余量给包内路径（Windows MAX_PATH 260 是硬墙） */
const MAX_BASE = 48

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)

/** 文件名里只留"安全字符"，其余折成下划线（保留中文：素材名大多是中文） */
function sanitizeBase(filePath) {
  const text = String(filePath || '')
  const base = text.split(/[\\/]/).pop() || 'media'
  const ext = /\.[^.]+$/.exec(base)
  const stemRaw = ext ? base.slice(0, -ext[0].length) : base
  const stem = stemRaw.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_BASE) || 'media'
  /* 扩展名同样要过一遍：`a.mp4;` 这种从别处粘来的脏名字会把 ffmpeg 与播放器都搞糊涂 */
  const suffix = ext ? '.' + ext[0].slice(1).replace(/[^A-Za-z0-9]+/g, '').toLowerCase() : ''
  return stem + suffix
}

/** 包内相对路径：`media/007_画面.mp4`（序号保证同名不同目录的两份素材不会撞车） */
function packPath(index, filePath) {
  const seq = String(Math.max(0, Math.floor(num(index)))).padStart(3, '0')
  return `${MEDIA_DIR}/${seq}_${sanitizeBase(filePath)}`
}

/**
 * 走一遍草稿，收集**所有**被引用的素材路径。
 *
 * 必须覆盖三种"藏在里面"的引用（漏任何一种都不报错，只是对面黑屏）：
 *   · 普通片段：`clip.path`
 *   · 复合片段：`clip.compound.children[].path`（可以嵌套，要递归）
 *   · 多机位：`clip.multicam.angles[].path`（外层 path 是空的）
 * 外加素材表 `assets[].path`（有的素材还没上时间线，但用户在库里看得见）。
 *
 * 返回：
 *   sources —— 去重后的绝对路径数组（保序：先片段、后素材表）
 *   refs    —— `{ [path]: 引用次数 }`，给"这个素材被 5 段共用"这类提示用
 */
function collectSources(clips, assets) {
  const sources = []
  const refs = {}
  const seen = new Set()

  const add = (filePath) => {
    const text = String(filePath || '').trim()
    if (!text) return
    refs[text] = (refs[text] || 0) + 1
    if (seen.has(text)) return
    seen.add(text)
    sources.push(text)
  }

  const walk = (clip) => {
    if (!clip || typeof clip !== 'object') return
    add(clip.path)
    /* 多机位：取每一路的 path（外层 clip.path 通常为空） */
    const angles = clip.multicam && Array.isArray(clip.multicam.angles) ? clip.multicam.angles : []
    for (const angle of angles) add(angle && angle.path)
    /* 复合片段：孩子还是片段，可以再套一层 */
    const children = clip.compound && Array.isArray(clip.compound.children) ? clip.compound.children : []
    for (const child of children) walk(child)
  }

  for (const clip of Array.isArray(clips) ? clips : []) walk(clip)
  for (const asset of Array.isArray(assets) ? assets : []) add(asset && asset.path)

  return { sources, refs }
}

/** 深拷贝（只处理草稿里会出现的纯数据；不碰函数/Date） */
function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = cloneData(value[key])
    return out
  }
  return value
}

/**
 * 导出方向：把绝对路径换成包内相对路径，并**清空 url**。
 *
 * `mapping` 是 `{ [绝对路径]: 'media/007_x.mp4' }`（由 packPath 生成）。
 * 找不到映射的路径（素材缺失）**原样保留** —— 让它在对面明确地"找不到"，
 * 而不是被悄悄改成一个必然不存在的 `media/undefined`。
 */
function rewriteForExport(data, mapping) {
  const table = mapping || {}
  const apply = (target) => {
    if (!target || typeof target !== 'object') return target
    const original = String(target.path || '')
    if (original && table[original]) {
      target.path = table[original]
      /* ⚠️ url 必须清掉：它是按**绝对路径**编码的，留着等于把老机器的路径带进包里，
         导入后画面读一个不存在的文件，而白名单里恰好还可能登记着它 —— 时好时坏。 */
      target.url = ''
    }
    return target
  }
  const walk = (clip) => {
    if (!clip || typeof clip !== 'object') return
    apply(clip)
    const angles = clip.multicam && Array.isArray(clip.multicam.angles) ? clip.multicam.angles : []
    for (const angle of angles) apply(angle)
    const children = clip.compound && Array.isArray(clip.compound.children) ? clip.compound.children : []
    for (const child of children) walk(child)
  }
  const next = cloneData(data || {})
  for (const clip of Array.isArray(next.clips) ? next.clips : []) walk(clip)
  for (const asset of Array.isArray(next.assets) ? next.assets : []) apply(asset)
  return next
}

/**
 * 导入方向：把 `media/...` 拼回绝对路径，并清空 url（由主进程按新路径重新生成）。
 *
 * 只认包内相对路径：已经是绝对路径的（导出时素材就缺、没进包）保持原样，
 * 于是"缺的那几个"在导入后仍然是缺的 —— 这是如实，不是 bug。
 */
function rewriteForImport(data, rootDir) {
  const root = String(rootDir || '').replace(/[\\/]+$/, '')
  const apply = (target) => {
    if (!target || typeof target !== 'object') return target
    const original = String(target.path || '').replace(/\\/g, '/')
    if (original.startsWith(MEDIA_DIR + '/')) {
      target.path = `${root}\\${original.split('/').join('\\')}`
      target.url = ''
    }
    return target
  }
  const walk = (clip) => {
    if (!clip || typeof clip !== 'object') return
    apply(clip)
    const angles = clip.multicam && Array.isArray(clip.multicam.angles) ? clip.multicam.angles : []
    for (const angle of angles) apply(angle)
    const children = clip.compound && Array.isArray(clip.compound.children) ? clip.compound.children : []
    for (const child of children) walk(child)
  }
  const next = cloneData(data || {})
  for (const clip of Array.isArray(next.clips) ? next.clips : []) walk(clip)
  for (const asset of Array.isArray(next.assets) ? next.assets : []) apply(asset)
  return next
}

/**
 * 路径 → 包内相对路径的整表。
 * 序号按**收集顺序**给，同一份草稿每次导出得到的名字完全一样（可比对、可复现）。
 */
function buildMapping(sources) {
  const mapping = {}
  ;(Array.isArray(sources) ? sources : []).forEach((filePath, index) => {
    mapping[filePath] = packPath(index, filePath)
  })
  return mapping
}

/** 包内的 manifest：只记"哪个文件、多大、什么时候打的"，不记原机器的绝对路径 */
function buildManifest(options) {
  const opts = options || {}
  const files = Array.isArray(opts.files) ? opts.files : []
  return {
    kind: 'yijing-pack',
    version: PACK_VERSION,
    name: String(opts.name || '未命名工程'),
    createdAt: String(opts.createdAt || new Date().toISOString()),
    mediaCount: files.length,
    totalBytes: files.reduce((sum, item) => sum + num(item && item.bytes), 0),
    files: files.map((item) => ({ file: String(item.file || ''), bytes: num(item.bytes) }))
  }
}

/** manifest 读数（导入时校验"这真的是我们的包"，别把随便一个 zip 当草稿解） */
function readManifest(json) {
  if (!json || typeof json !== 'object') return null
  if (json.kind !== 'yijing-pack') return null
  const version = Math.floor(num(json.version))
  if (version < 1 || version > PACK_VERSION) return null
  return {
    version,
    name: String(json.name || '未命名工程'),
    createdAt: String(json.createdAt || ''),
    mediaCount: Math.floor(num(json.mediaCount)),
    totalBytes: num(json.totalBytes)
  }
}

/**
 * 把 `{ 绝对路径: url }` 贴回草稿（导入时用）。
 *
 * 为什么要单独一步：解包之后路径才变成绝对路径，url 只能拿**新路径**去主进程换，
 * 而"哪个对象该贴哪个 url"的走位（普通 / 多机位机位 / 复合嵌套 / 素材表）
 * 与上面两个 rewrite 必须完全一致 —— 三处各写一遍的话，
 * 迟早有一处漏了多机位机位，表现是"主画面能播、切到机位 2 就黑"。
 */
function attachUrls(data, urlTable) {
  const table = urlTable || {}
  const apply = (target) => {
    if (!target || typeof target !== 'object') return target
    const filePath = String(target.path || '')
    if (filePath && table[filePath]) target.url = table[filePath]
    return target
  }
  const walk = (clip) => {
    if (!clip || typeof clip !== 'object') return
    apply(clip)
    const angles = clip.multicam && Array.isArray(clip.multicam.angles) ? clip.multicam.angles : []
    for (const angle of angles) apply(angle)
    const children = clip.compound && Array.isArray(clip.compound.children) ? clip.compound.children : []
    for (const child of children) walk(child)
  }
  for (const clip of Array.isArray(data && data.clips) ? data.clips : []) walk(clip)
  for (const asset of Array.isArray(data && data.assets) ? data.assets : []) apply(asset)
  return data
}

/**
 * 包文件名：`<草稿名>-素材包.yjpack`（草稿名先过一遍安全字符）
 */
function packFileName(name) {
  const safe = sanitizeBase(String(name || '工程') + '.yjpack').replace(/\.yjpack$/i, '')
  return `${safe || '工程'}-素材包.yjpack`
}

/** 人看的说明文件（解包后第一眼就知道这是什么、怎么打开） */
function readmeText(name) {
  return [
    `艺镜AI剪辑 · 素材包`,
    ``,
    `工程：${String(name || '未命名工程')}`,
    `内容：${DRAFT_FILE}（草稿）+ ${MANIFEST_FILE}（清单）+ ${MEDIA_DIR}/（素材原件）`,
    ``,
    `怎么用：在「艺镜AI剪辑」里用「文件 → 导入素材包」打开这个 .yjpack 即可，`,
    `不要手工移动或改名 ${MEDIA_DIR}/ 里的文件 —— 草稿按文件名引用它们。`,
    ``,
    `素材均为原片，未经转码。`
  ].join('\r\n')
}

module.exports = {
  PACK_VERSION,
  MEDIA_DIR,
  DRAFT_FILE,
  MANIFEST_FILE,
  README_FILE,
  MAX_BASE,
  sanitizeBase,
  packPath,
  collectSources,
  buildMapping,
  rewriteForExport,
  rewriteForImport,
  attachUrls,
  buildManifest,
  readManifest,
  packFileName,
  readmeText
}
