/**
 * 边框清单 —— 渲染层侧的进程内缓存。
 *
 * 两处都要用同一份：
 *   · 边框面板（`SidePanels.jsx` 的 BorderPanel）—— 画格子、点一下写回片段；
 *   · 预览层（`Stage.jsx`）—— 把 `clip.border` 这个 key 换成 `yjai-media://` 地址，
 *     否则"面板上点了、片段上也有值、画面就是不出现"（静默失效第 ① 类：压根没接）。
 *
 * 为什么不能只让面板拉一份：打开一份已有草稿时用户可能一次都没点开边框页，
 * 但片段上早就带着 `border` 了 —— 那时候清单还是空的，预览就会当"没有边框"。
 * 所以预览层自己也会 `ensure()` 一次（同一份缓存，不会多问主进程第二遍）。
 */

let cache = null
let pending = null
let failed = ''

function normalize(raw) {
  const groups = []
  const byKey = new Map()
  const src = raw && Array.isArray(raw.groups) ? raw.groups : []
  for (const group of src) {
    const items = (Array.isArray(group.items) ? group.items : []).filter((item) => item && item.key && item.url)
    if (!items.length) continue
    groups.push({ key: group.key, name: group.name || group.key, items })
    for (const item of items) byKey.set(item.key, item)
  }
  return { groups, byKey, ok: Boolean(raw && raw.ok), error: (raw && raw.error) || '', source: (raw && raw.source) || '' }
}

/** 已加载的清单（可能为 null：还没问过主进程）。同步用，给渲染期直接读。 */
export function borderCatalog() {
  return cache
}

export function borderUrlOf(key) {
  if (!key || !cache) return ''
  const item = cache.byKey.get(String(key))
  return item ? item.url : ''
}

export function borderNameOf(key) {
  if (!key || !cache) return ''
  const item = cache.byKey.get(String(key))
  return item ? item.name : ''
}

/** 加载（并发调用只打一次 IPC）。失败也缓存，避免每次渲染都重试。 */
export function ensureBorderCatalog() {
  if (cache) return Promise.resolve(cache)
  if (pending) return pending
  const bridge = typeof window !== 'undefined' && window.yjai && window.yjai.borders
  if (!bridge || !bridge.catalog) {
    cache = normalize({ ok: false, error: '非桌面环境，读不到边框库' })
    return Promise.resolve(cache)
  }
  pending = bridge
    .catalog()
    .then((raw) => {
      cache = normalize(raw)
      failed = cache.error
      return cache
    })
    .catch((err) => {
      failed = (err && err.message) || '边框清单读取失败'
      cache = normalize({ ok: false, error: failed })
      return cache
    })
    .finally(() => {
      pending = null
    })
  return pending
}

export function borderCatalogError() {
  return failed
}

/**
 * 丢掉缓存 —— **导入 / 启停 / 卸载插件之后必须调**。
 *
 * 主进程那边清的是它自己的 `packCaches`，这是渲染层这一份。
 * 只清一边的下场：插件面板显示"导入成功"，回到边框页还是原来那 24 款
 * （面板读的是这份进程内缓存，`ensure()` 直接命中旧值）。
 */
export function resetBorderCatalog() {
  cache = null
  pending = null
  failed = ''
}
