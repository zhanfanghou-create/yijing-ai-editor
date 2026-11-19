/**
 * 预置音乐 / 音效的本地缓存（主进程）。
 *
 * 三件事，别的都不做：
 *   ① 读清单（`shared/musicCatalog.json`，随包发布）—— 浏览用的是渲染层直接 import，
 *      这里只负责"按 id 找到那条、拿到直链"。
 *   ② 用户点某一条时把那一首抓下来，落到 `userData/music-cache/<id>.<ext>`，**永久留着**。
 *   ③ 把落好的文件登记进媒体白名单，回一个能直接播的 `yjai-media://` 地址。
 *
 * 为什么"永久"写成不清理：这是用户原话里的要求（点击后永久缓存），也是一个承诺 ——
 * 一个会自己偷偷删本地文件的剪辑软件，用户第二次就不敢用了。不做过期、不做 LRU、
 * 不做"超过 N MB 自动删最旧的"。清单条目被我们下架了也不删已缓存的文件（删了就找不回来）。
 *
 * ⚠️ 下载**只能**走 `models.fetchFile`（那就是全项目唯一那份下载器：续传 / 换源 /
 *    代理 / 分段并发 / 停滞看门狗都在里面）。这里自己写 req/res 拼文件，
 *    等于给"下载"再造第二套语义，代理不通时表现还不一样。
 */
const path = require('node:path')
const catalog = require('../shared/musicCatalog.json')
const cache = require('../shared/musicCache.js')
const { fetchFile } = require('./models')

/** 同一首被连点两次时共用一次下载（否则两个请求写同一个 `.part`） */
const inflight = new Map()

function items() {
  return Array.isArray(catalog.items) ? catalog.items : []
}

function findById(id) {
  const want = String(id || '')
  return items().find((item) => item.id === want) || null
}

function statusOf(deps = {}) {
  const root = cache.musicRootOf(deps.userData)
  /* 顺手把索引里"文件已经没了"的条目清掉：不清的话面板显示「已缓存」，
     点下去却没声音（用户会以为缓存坏了，其实是文件被外部删了）。 */
  cache.pruneIndex(root, items())
  return { root, usage: cache.usageOf(root, items()), map: cache.statusOf(root, items()) }
}

/**
 * 确保某一条已经在本机；没有就下。
 *
 * @param {string} id 清单里的 id（`sfx-1489` / `mus-127`）
 * @param {{userData:string, onProgress?:(received:number,total:number)=>void, proxy?:any}} deps
 * @returns {Promise<{ok:boolean, item?:object, cached?:boolean, path?:string, error?:string}>}
 */
async function ensure(id, deps = {}) {
  const item = findById(id)
  if (!item) return { ok: false, error: '没有这一条音乐或音效（清单里找不到这个编号）' }
  if (!deps.userData) return { ok: false, error: '拿不到本机缓存目录' }

  const root = cache.musicRootOf(deps.userData)
  const dest = cache.fileOf(root, item)
  if (!dest) return { ok: false, error: '这条素材的编号不合法' }

  /* 已经在盘上：直接回，连一次网络请求都不发 —— "点击试听"在第二次之后必须是瞬时的 */
  const have = cache.stateOf(root, item, cache.readIndex(root))
  if (have.cached) return { ok: true, item, cached: true, path: have.path, seconds: have.seconds }

  if (inflight.has(item.id)) {
    const shared = await inflight.get(item.id)
    return shared
  }

  const job = (async () => {
    try {
      await fetchFile([item.url], dest, deps.onProgress, { proxy: deps.proxy })
    } catch (error) {
      /* 报错要带"是哪个地址、什么原因"：只回"下载失败"等于让用户去猜网络 */
      return { ok: false, item, error: `${(error && error.message) || '下载失败'}` }
    }
    const st = cache.stateOf(root, item, cache.readIndex(root))
    if (!st.cached) return { ok: false, item, error: '文件下完了但读不出来（可能被占用）' }
    cache.remember(root, item, { seconds: st.seconds, bytes: st.bytes })
    return { ok: true, item, cached: true, path: st.path, seconds: st.seconds, fresh: true }
  })()

  inflight.set(item.id, job)
  try {
    return await job
  } finally {
    inflight.delete(item.id)
  }
}

module.exports = {
  CATALOG: catalog,
  items,
  findById,
  statusOf,
  ensure,
  /* 给闸门用：不联网也能验证"缓存路径与状态判定"这一层 */
  cache,
  rootOf: (userData) => cache.musicRootOf(userData),
  fileOf: (userData, item) => path.join(cache.musicRootOf(userData), cache.fileNameOf(item) || '')
}
