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
export async function pickMedia() {
  if (bridge?.media?.pick) {
    try {
      return (await bridge.media.pick()) || []
    } catch {
      return []
    }
  }
  return pickInBrowser()
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
