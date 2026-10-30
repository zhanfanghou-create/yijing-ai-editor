/**
 * 本地插件包 —— 纯逻辑（不碰磁盘、不碰 IPC），渲染层与主进程共用一份。
 *
 * ## 这里的「插件」是什么，不是什么
 *
 * 参考客户端的插件是 **OFX 格式**（`.ofx` 原生动态库，OpenFX 标准），
 * 宿主得实现一整套 C++ 特效宿主 API 才能加载。那是数月级工程，
 * 开源版（MIT / 纯单机 / 无服务端）不做，也**不做假的**——页面上直接写明。
 *
 * 本工程支持的插件 = **本地素材包**：一个文件夹里放清单 + 若干 PNG，
 * 导入后边框库 / 贴纸库当场多出这几组，预览与导出立刻能用。
 * 它确实改变产品能力（用户自己的边框能进时间线、能压进成片），不是占位。
 *
 * ## 为什么 key 必须可复现
 *
 * 插件条目会写进草稿：`clip.border = 'pv-<pluginId>-3'`。
 * 卸载重装同一个插件之后，草稿里的片段**还带着那个 key** —— 如果 key 是随机数，
 * 重装后草稿里所有边框都变成"找不到的素材"，画面直接掉边框。
 * 所以 id 一律由「清单里的 id」或「文件夹名」派生（稳定哈希），不用随机数。
 */

/** 清单格式版本。以后字段语义变了就 +1，老版本按老规则读 */
const SCHEMA = 1

/** 支持的插件类型 → 落到哪个素材库 */
const KINDS = [
  { key: 'border', label: '边框' },
  { key: 'sticker', label: '贴纸' }
]

/** id 只允许小写字母数字与连字符：它同时是目录名、也是 yjai-media 路径的一段 */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/

/** 用户插件分组 key 前缀。与内置分组的 `ef-gN` / `stk-g-*` 不会撞 */
const GROUP_PREFIX = 'pv-'

/** 一个插件最多几张图。超过就截断（不是报错：用户可能是整包拖进来） */
const MAX_IMAGES = 200

/** 单张图上限 20 MB。PNG 是很能吹的格式，一张 8K 的能到几十 MB */
const MAX_BYTES = 20 * 1024 * 1024

/** 稳定哈希（djb2 → base36）。同一个字符串永远同一个结果，跨平台一致 */
function hashOf(text) {
  let h = 5381
  const s = String(text || '')
  for (let i = 0; i < s.length; i += 1) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

/**
 * 从「文件夹名 / 清单里的 name」派生 id。
 *
 * 纯中文名 → 一个字都不剩，此时退回 `p-<hash>`，仍然是稳定的。
 * 已有合法 id 就原样用，不做二次改写 —— 否则「清单写 a、目录叫 b」会漂。
 */
function slugOf(text) {
  const raw = String(text || '').trim().toLowerCase()
  const ascii = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii.length >= 2 && ascii.length <= 32) return ascii
  return `p-${hashOf(raw || 'plugin')}`
}

function kindLabel(kind) {
  const hit = KINDS.find((k) => k.key === String(kind || ''))
  return hit ? hit.label : ''
}

/**
 * 校验并规范化清单。
 *
 * 宽容原则：缺字段就补（name 用目录名、version 用 1.0.0），
 * 只有**类型不认识**才是硬错误 —— 因为不知道该把图放进哪个库，
 * 装进去也会是"导入成功但哪都找不到"。
 *
 * @param {object} raw 清单原文（可能是 null / 字符串 / 缺字段的对象）
 * @param {string} [fallbackName] 目录名，缺 name / id 时用
 */
function normalizeManifest(raw, fallbackName) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const folder = String(fallbackName || '').trim()

  const kind = String(src.kind || src.type || '').toLowerCase()
  if (!KINDS.some((k) => k.key === kind)) {
    return { ok: false, error: `清单里的类型不认识（kind=${src.kind || '空'}），只能是 border 或 sticker` }
  }

  const name = String(src.name || folder || '').trim() || '未命名插件'
  const idRaw = String(src.id || '').trim().toLowerCase()
  /* 清单里写了合法 id 就用它；写了但不合法（比如带空格/中文）就忽略，
     改从 name 派生 —— 直接把非法 id 塞进目录名会造出奇怪的路径 */
  const id = ID_RE.test(idRaw) ? idRaw : slugOf(name || folder)

  return {
    ok: true,
    manifest: {
      schema: SCHEMA,
      id,
      name: name.slice(0, 40),
      version: String(src.version || '1.0.0').slice(0, 20),
      author: String(src.author || '').slice(0, 40),
      kind,
      kindLabel: kindLabel(kind)
    }
  }
}

/** 插件图片在素材库里归属的分组 key（每个插件一组） */
function groupKeyOf(pluginId) {
  const id = String(pluginId || '')
  return id ? `${GROUP_PREFIX}${id}` : ''
}

/**
 * 条目 key：`pv-<pluginId>-<序号>`。
 *
 * **不带文件名**：文件名里可能有空格、括号、中文，而 key 会写进草稿、
 * 会进 yjai-media 查询、会被当 React key 用。用序号最省事，
 * 而且同一个插件重装后顺序不变（按文件名排序）⇒ key 也不变。
 */
function itemKeyOf(pluginId, index) {
  const id = String(pluginId || '')
  if (!id) return ''
  return `${GROUP_PREFIX}${id}-${index}`
}

/** 排序：中文按拼音，同名的按 id —— 保证每次刷新顺序一致（面板不会跳） */
function sortPlugins(list) {
  const arr = Array.isArray(list) ? list.slice() : []
  return arr.sort((a, b) => {
    const x = String((a && a.name) || '')
    const y = String((b && b.name) || '')
    const byName = x.localeCompare(y, 'zh-Hans-CN')
    if (byName !== 0) return byName
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''))
  })
}

/** 面板顶部的计数文案要用的数字 */
function summaryOf(list) {
  const arr = Array.isArray(list) ? list : []
  const enabled = arr.filter((p) => p && p.enabled)
  return {
    total: arr.length,
    enabled: enabled.length,
    images: enabled.reduce((sum, p) => sum + (Number(p.imageCount) || 0), 0)
  }
}

/**
 * 读 PNG 的 IHDR，拿到真实宽高。
 *
 * 为什么要自己读：面板要按宽高比画格子，而**不能信清单**（用户手写的）
 * 也不能等 `<img>` 慢慢加载完（一屏几十张会闪）。PNG 头是固定位置，
 * 读 24 字节就够，比解码整张图快几个数量级。
 *
 * @returns {{ ok:boolean, w:number, h:number, error?:string }}
 */
function pngInfo(buf) {
  const b = buf
  if (!b || typeof b.length !== 'number' || b.length < 24) return { ok: false, w: 0, h: 0, error: '不是 PNG（太短）' }
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i += 1) {
    if (b[i] !== SIG[i]) return { ok: false, w: 0, h: 0, error: '不是 PNG（文件头不对）' }
  }
  /* 8..12 = 长度，12..16 = 'IHDR'，16..20 = 宽，20..24 = 高（大端） */
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15])
  if (tag !== 'IHDR') return { ok: false, w: 0, h: 0, error: 'PNG 结构异常（缺 IHDR）' }
  const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0
  const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0
  if (!w || !h) return { ok: false, w: 0, h: 0, error: 'PNG 尺寸为 0' }
  /* 上限挡住"解压炸弹"式的巨图：再大的图进画布也只剩像素噪点 */
  if (w > 8192 || h > 8192) return { ok: false, w, h, error: `图片太大（${w}×${h}，上限 8192）` }
  return { ok: true, w, h }
}

module.exports = {
  SCHEMA,
  KINDS,
  ID_RE,
  GROUP_PREFIX,
  MAX_IMAGES,
  MAX_BYTES,
  hashOf,
  slugOf,
  kindLabel,
  normalizeManifest,
  groupKeyOf,
  itemKeyOf,
  sortPlugins,
  summaryOf,
  pngInfo
}
