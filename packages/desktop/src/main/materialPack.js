/**
 * 随包素材包读取器 —— 贴纸 / 边框共用一套。
 *
 * 为什么抽出来：这两类素材的读取逻辑**一字不差**（找目录 → 读 catalog.json →
 * 逐条做路径穿越校验 → 剔掉盘上没有的），只是目录名和报错文案不同。
 * 各写一份的下场是「贴纸在打包后能找到、边框找不到」这种单边失效 ——
 * 而两边单独跑都正常，只有装出来的包才露出来。
 *
 * 目录要分三种情形找，顺序是 **打包 → 源码 → appPath**：
 *   1. `process.resourcesPath/<dirName>` —— 打包后 `extraResources` 落这里；
 *   2. `<main 目录>/../../resources/<dirName>` —— 开发模式。`src/main` 往上两级是包根；
 *      ⚠️ 这一处**不能省**：本仓库是 monorepo，`app.getAppPath()` 取的是"最近一个带
 *      package.json 的祖先"，实测在本机直接落到仓库根（`F:\yjai-edit`），
 *      于是 `<appPath>/resources/<dirName>` 是空的 ——
 *      面板写着"找不到内置素材库"，而素材明明在 `packages/desktop/resources/`。
 *   3. `appPath/resources/<dirName>` —— 给"单包布局"留的后路。
 *
 * ⚠️ 清单里的 `file` 必须做**路径穿越校验**。catalog.json 是仓库里的文件、正常不会坏，
 *    但一旦它被写坏（手工编辑 / 半截写入），`../../` 就能让面板读盘上任意 PNG ——
 *    这类洞不需要攻击者，一次手滑就够。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 单个素材包允许的最大条目数。防止清单被写坏时一次性铺出几万格 */
const MAX_ITEMS = 600

/**
 * 找素材包根目录（要求目录下真的有 catalog.json，光有目录不算）。
 *
 * @param {string} dirName resources 下的子目录名，如 'stickers' / 'borders'
 * @param {object} deps 注入口（自测时替换成假的，不碰真实磁盘）
 * @returns {string} 绝对路径；都没命中则空串
 */
function packRootOf(dirName, { resourcesPath, appPath, mainDir } = {}) {
  const name = String(dirName || '')
  if (!name) return ''
  const candidates = []
  if (resourcesPath) candidates.push(path.join(String(resourcesPath), name))
  if (mainDir) candidates.push(path.resolve(String(mainDir), '..', '..', 'resources', name))
  if (appPath) candidates.push(path.join(String(appPath), 'resources', name))
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'catalog.json'))) return dir
    } catch {
      /* 权限 / 路径非法：当作这处没有，继续试下一处 */
    }
  }
  return ''
}

/**
 * 规范化一条素材记录。缺名字 / 文件 / 尺寸的记录直接丢掉 ——
 * 面板上画一个没有图的格子比少一格更糟。
 */
function normalizeItem(raw, root, groupKey, fallbackSize) {
  if (!raw || typeof raw !== 'object') return null
  const file = String(raw.file || '')
  if (!file) return null
  const abs = path.resolve(root, file)
  /* 必须仍在根目录之内（`..` 逃逸会读到盘上任意文件） */
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (path.extname(abs).toLowerCase() !== '.png') return null
  const w = Number(raw.w)
  const h = Number(raw.h)
  return {
    key: String(raw.key || `${groupKey}-${path.basename(file, '.png')}`),
    name: String(raw.name || path.basename(file, '.png')),
    group: String(groupKey || ''),
    file: rel.split(path.sep).join('/'),
    abs,
    w: Number.isFinite(w) && w > 0 ? w : fallbackSize,
    h: Number.isFinite(h) && h > 0 ? h : fallbackSize
  }
}

/**
 * 读清单。
 *
 * @param {string} dirName resources 下的子目录名
 * @param {object} deps 同上，另加 label（报错文案用，如 '贴纸'）
 * @param {number} [deps.fallbackSize] 清单没写尺寸时的兜底边长
 * @returns {{ root:string, groups:object[], items:object[], error?:string, license?:string, source?:string }}
 */
function readPack(dirName, deps = {}) {
  const { resourcesPath, appPath, mainDir } = deps
  const label = String(deps.label || '素材')
  const fallbackSize = Number(deps.fallbackSize) > 0 ? Number(deps.fallbackSize) : 512
  const root = packRootOf(dirName, { resourcesPath, appPath, mainDir })
  if (!root) return { root: '', groups: [], items: [], error: `找不到内置${label}库` }

  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'))
  } catch (err) {
    return { root, groups: [], items: [], error: `${label}清单读不了：${(err && err.message) || '未知原因'}` }
  }

  const groups = []
  const items = []
  const rawGroups = Array.isArray(parsed && parsed.groups) ? parsed.groups : []
  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== 'object') continue
    const key = String(rawGroup.key || '')
    const list = Array.isArray(rawGroup.items) ? rawGroup.items : []
    const kept = []
    for (const rawItem of list) {
      if (items.length >= MAX_ITEMS) break
      const item = normalizeItem(rawItem, root, key, fallbackSize)
      if (!item) continue
      /* 盘上没有的文件不列 —— 面板上点了没反应比看不到它更迷惑 */
      try {
        if (!fs.statSync(item.abs).isFile()) continue
      } catch {
        continue
      }
      kept.push(item)
      items.push(item)
    }
    if (kept.length) groups.push({ key, name: String(rawGroup.name || key), items: kept })
  }

  /**
   * 再合并"用户插件"的条目（`main/plugins.js` 组装好的，已经是规范化形态）。
   *
   * 为什么插件项直接塞进来、不再走 normalizeItem：
   * 插件图不在 `packRoot` 底下（住在 `<userData>/plugins/<id>/`），
   * normalizeItem 会拿 `packRoot` 做相对路径校验，必然把它判成越界。
   * 那边的路径校验由 plugins.js 自己做（清单是用户可写的，同样要防 `..`）。
   *
   * 顺序：内置在前、插件在后 —— 面板上"我的"总在"官方"之后，符合预期。
   */
  const extra = Array.isArray(deps.extraGroups) ? deps.extraGroups : []
  for (const group of extra) {
    if (!group || !group.key || !Array.isArray(group.items) || !group.items.length) continue
    const kept = []
    for (const item of group.items) {
      if (items.length >= MAX_ITEMS) break
      if (!item || !item.key || !item.abs) continue
      kept.push(item)
      items.push(item)
    }
    if (kept.length) groups.push({ key: String(group.key), name: String(group.name || group.key), items: kept })
  }

  return {
    root,
    groups,
    items,
    license: String((parsed && parsed.license) || ''),
    source: String((parsed && parsed.source) || '')
  }
}

module.exports = { packRootOf, readPack, MAX_ITEMS }
