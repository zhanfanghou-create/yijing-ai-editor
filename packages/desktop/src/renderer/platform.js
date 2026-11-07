/**
 * 平台桥接。
 *
 * 桌面端走主进程（设置落盘到用户数据目录）；
 * 在纯浏览器里打开时自动退回 localStorage，方便直接预览界面。
 *
 * 开源版没有账号体系，所以这里**没有令牌**：不设账号、不存凭据、不联网。
 */

const bridge = typeof window !== 'undefined' && window.yjai ? window.yjai : null

export const isDesktop = Boolean(bridge)

const LS_SETTINGS = 'yjai_desktop_settings'

function readLocalSettings() {
  try {
    return JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')
  } catch {
    return {}
  }
}

export async function appInfo() {
  if (bridge?.info) {
    try {
      return await bridge.info()
    } catch {
      /* 落到默认值 */
    }
  }
  return {
    name: '艺镜AI剪辑',
    version: '1.0.0',
    platform: 'browser',
    electron: '',
    chrome: '',
    userData: '',
    packaged: false
  }
}

export async function getSetting(key, fallback = null) {
  if (bridge?.settings) {
    try {
      const settings = await bridge.settings.get()
      return settings && key in settings ? settings[key] : fallback
    } catch {
      return fallback
    }
  }
  const settings = readLocalSettings()
  return key in settings ? settings[key] : fallback
}

export async function setSetting(key, value) {
  if (bridge?.settings) {
    try {
      await bridge.settings.set(key, value)
      return
    } catch {
      /* ignore */
    }
  }
  try {
    const settings = readLocalSettings()
    settings[key] = value
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings))
  } catch {
    /* ignore */
  }
}

/** 外链一律交给系统浏览器；浏览器环境下用新标签页 */
export async function openExternal(url) {
  if (bridge?.shell) {
    try {
      await bridge.shell.openExternal(url)
      return
    } catch {
      /* ignore */
    }
  }
  // allow-window-open：这一处就是 openExternal 自身在**浏览器态**的兜底（没有 Electron bridge
  // 可走），不是"把用户甩到浏览器"的入口。桌面态永远走上面的 bridge.shell.openExternal。
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * 片段波形的音频峰值（主进程用 ffmpeg 抽 PCM 算）。
 * 浏览器环境没有主进程 ⇒ 返回 null，调用方静默退回"不画波形"。
 */
export async function mediaPeaks({ url, offset, duration, buckets }) {
  if (bridge?.media?.peaks) {
    try {
      const result = await bridge.media.peaks({ url, offset, duration, buckets })
      if (result && result.ok && Array.isArray(result.peaks)) return result.peaks
    } catch {
      return null
    }
  }
  return null
}

/** 在文件管理器里定位文件（桌面端才有） */
export async function showItem(filePath) {
  if (bridge?.shell) {
    try {
      return await bridge.shell.showItem(filePath)
    } catch {
      return false
    }
  }
  return false
}

/* ------------------------------ 本地草稿 ------------------------------ */

const LS_DRAFTS = 'yjai_desktop_drafts'

function readLocalDrafts() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_DRAFTS) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function localDraftSummary(record) {
  const clips = Array.isArray(record?.data?.clips) ? record.data.clips : []
  return {
    id: record.id,
    name: String(record.name || '未命名项目'),
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
    clipCount: clips.length,
    duration: clips.reduce((max, clip) => {
      const end = Number(clip.start || 0) + Number(clip.duration || 0)
      return Number.isFinite(end) && end > max ? end : max
    }, 0)
  }
}

/**
 * 草稿读写。桌面端走主进程落盘（userData/drafts），
 * 浏览器预览时退回 localStorage —— 保证在浏览器里点保存/打开也有真实效果。
 */
export async function listDrafts() {
  if (bridge?.draft?.list) {
    try {
      return (await bridge.draft.list()) || []
    } catch {
      return []
    }
  }
  return Object.values(readLocalDrafts())
    .filter((record) => record && record.id)
    .map(localDraftSummary)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export async function saveDraft({ id, name, data }) {
  if (bridge?.draft?.save) {
    try {
      return await bridge.draft.save({ id, name, data })
    } catch {
      return null
    }
  }
  const all = readLocalDrafts()
  const nextId = id || `d${Date.now().toString(36)}`
  const previous = all[nextId]
  const now = new Date().toISOString()
  const record = {
    id: nextId,
    name: String(name || previous?.name || '未命名项目'),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    data: data && typeof data === 'object' ? data : { clips: [] }
  }
  all[nextId] = record
  try {
    localStorage.setItem(LS_DRAFTS, JSON.stringify(all))
  } catch {
    return null
  }
  return localDraftSummary(record)
}

export async function loadDraft(id) {
  if (bridge?.draft?.load) {
    try {
      return await bridge.draft.load(id)
    } catch {
      return null
    }
  }
  return readLocalDrafts()[id] || null
}

export async function removeDraft(id) {
  if (bridge?.draft?.remove) {
    try {
      return Boolean(await bridge.draft.remove(id))
    } catch {
      return false
    }
  }
  const all = readLocalDrafts()
  if (!all[id]) return false
  delete all[id]
  try {
    localStorage.setItem(LS_DRAFTS, JSON.stringify(all))
  } catch {
    return false
  }
  return true
}

/* ------------------------------ 本地素材 ------------------------------ */

/** 浏览器环境没有主进程，用 <input type=file> + objectURL 顶上，保证界面能预览 */
function pickInBrowser() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = 'video/*,audio/*,image/*'
    input.onchange = () => {
      const rows = Array.from(input.files || []).map((file) => ({
        path: '',
        name: file.name,
        displayName: file.name.replace(/\.[^.]+$/, ''),
        ext: (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase(),
        size: file.size,
        mtime: file.lastModified,
        kind: file.type.startsWith('video') ? 'video'
          : file.type.startsWith('audio') ? 'audio'
            : file.type.startsWith('image') ? 'image' : 'other',
        url: URL.createObjectURL(file)
      }))
      resolve(rows.filter((row) => row.kind !== 'other'))
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}

/**
 * 打开系统文件选择框。
 * @returns {Promise<Array<{path:string,name:string,kind:string,size:number,url:string}>>}
 */
export async function pickMedia(options = {}) {
  if (bridge?.media?.pick) {
    try {
      return (await bridge.media.pick(options)) || []
    } catch {
      return []
    }
  }
  return pickInBrowser()
}

/**
 * 导入字体：桌面端走主进程对话框；浏览器环境（开发预览）返回空数组。
 * 返回项：`{ id, name, path, url }`，url 是 yjai-media 协议地址。
 */
export async function pickFonts() {
  if (bridge?.font?.pick) {
    try {
      return (await bridge.font.pick()) || []
    } catch {
      return []
    }
  }
  return []
}

/**
 * 把已导入字体的路径重新登记进主进程白名单（启动/恢复草稿时调用）。
 * ⚠️ 不登记的话：重启后白名单是空的，`fetch(url)` 得到 403，
 *    字体家族根本没注册上 —— 预览会**静默**退回系统字体，界面上没有任何提示。
 */
export async function allowFontPaths(paths) {
  if (!bridge?.font?.allow) return false
  try {
    return await bridge.font.allow(paths)
  } catch {
    return false
  }
}

/** 拖拽文件 → 本地绝对路径（桌面端）；浏览器环境返回空串 */
export function pathForFile(file) {
  if (bridge?.media?.pathForFile) {
    try {
      return bridge.media.pathForFile(file) || ''
    } catch {
      return ''
    }
  }
  return ''
}

/** 校验并登记一批本地路径（拖拽用）；返回可用的素材描述 */
export async function statMedia(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean)
  if (!list.length) return []
  if (bridge?.media?.stat) {
    try {
      return (await bridge.media.stat(list)) || []
    } catch {
      return []
    }
  }
  return []
}

/* ------------------------------- 本地 AI 模型 ------------------------------- */

/**
 * 模型表 + 本机占用。
 *
 * 浏览器预览下没有主进程，返回空表而不是伪造一份 —— 设置页据此显示"只在桌面端可用"，
 * 比在浏览器里摆一排按不动的下载按钮好。
 */
export async function listModels() {
  if (bridge?.models?.list) {
    try {
      const res = await bridge.models.list()
      if (res && res.ok) return res
    } catch {
      /* 落到空表 */
    }
  }
  return { ok: false, models: [], usage: { total: 0, root: '' } }
}

export async function downloadModel(id) {
  if (!bridge?.models?.download) return { ok: false, error: '只在桌面端可用' }
  try {
    return await bridge.models.download(id)
  } catch (err) {
    return { ok: false, error: (err && err.message) || '下载失败' }
  }
}

export async function importModel(id) {
  if (!bridge?.models?.import) return { ok: false, error: '只在桌面端可用' }
  try {
    return await bridge.models.import(id)
  } catch (err) {
    return { ok: false, error: (err && err.message) || '安装失败' }
  }
}

export async function removeModel(id) {
  if (!bridge?.models?.remove) return { ok: false, error: '只在桌面端可用' }
  try {
    return await bridge.models.remove(id)
  } catch (err) {
    return { ok: false, error: (err && err.message) || '删除失败' }
  }
}

export async function revealModel(id) {
  if (!bridge?.models?.reveal) return { ok: false, error: '只在桌面端可用' }
  try {
    return await bridge.models.reveal(id)
  } catch (err) {
    return { ok: false, error: (err && err.message) || '打不开目录' }
  }
}

/** 下载进度订阅，返回退订函数；浏览器下是空操作 */
export function onModelProgress(handler) {
  if (!bridge?.models?.onProgress) return () => {}
  return bridge.models.onProgress(handler)
}

/* ------------------------------- 语音识别 ------------------------------- */

/**
 * 识别链路状态（运行时 + 各模型）。
 *
 * 浏览器预览下恒返回 `{ ok:false, ready:false }` —— 调用方据此走"需要桌面端"分支，
 * 而不是把"没有桥"和"模型没装"混成同一句话（前者用户无能为力，后者他自己就能装）。
 */
export async function speechStatus() {
  if (!bridge?.speech?.status) return { ok: false, ready: false, runtime: { ok: false }, models: [] }
  try {
    const res = await bridge.speech.status()
    if (res && res.ok) return res
  } catch {
    /* 落到"不可用" */
  }
  return { ok: false, ready: false, runtime: { ok: false }, models: [] }
}

/**
 * 识别一组时间段，返回 `{ ok, segments:[{start,end,text}] }`。
 *
 * 失败时 `reason` 是**可判定的枚举**（`runtime-missing` / `model-missing` / …），
 * 界面据此决定"要不要把用户送去装模型"——只靠错误文案判断的话，
 * 改一句提示语就会静默丢掉这个跳转。
 */
export async function transcribeSpeech(payload) {
  if (!bridge?.speech?.transcribe) return { ok: false, reason: 'no-bridge', error: '语音识别需要桌面端' }
  try {
    return await bridge.speech.transcribe(payload)
  } catch (err) {
    return { ok: false, reason: 'crash', error: (err && err.message) || '识别失败' }
  }
}

export async function cancelSpeech(jobId) {
  if (!bridge?.speech?.cancel) return { ok: false }
  try {
    return await bridge.speech.cancel(jobId)
  } catch {
    return { ok: false }
  }
}

/**
 * 配音音色包的状态。
 *
 * 与 `speechStatus()` 分开：识别和配音共用运行时，但"装没装音色包"是两件事。
 * 合在一起会让"能认字但不能读出声"这种情况在界面上无法表达。
 */
export async function voiceStatus() {
  if (!bridge?.speech?.voiceStatus) return { ok: false, ready: false, runtime: { ok: false }, voices: [] }
  try {
    const res = await bridge.speech.voiceStatus()
    if (res && res.ok) return res
  } catch {
    /* 落到"不可用" */
  }
  return { ok: false, ready: false, runtime: { ok: false }, voices: [] }
}

/** 把文字读成人声（本机合成），返回 wav 的绝对路径 */
export async function speakText(payload) {
  if (!bridge?.speech?.speak) return { ok: false, reason: 'no-bridge', error: '配音需要桌面端（本机合成）' }
  try {
    return await bridge.speech.speak(payload)
  } catch (err) {
    return { ok: false, reason: 'crash', error: (err && err.message) || '合成失败' }
  }
}

/** 识别进度订阅，返回退订函数；浏览器下是空操作 */
export function onSpeechProgress(handler) {
  if (!bridge?.speech?.onProgress) return () => {}
  return bridge.speech.onProgress(handler)
}
