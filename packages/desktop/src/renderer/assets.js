/**
 * 素材类型判定：按扩展名识别，识别不出来就是「文件」。
 */

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)(\?|$)/i
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)(\?|$)/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)(\?|$)/i

/**
 * 产物 URL 没有扩展名时的兜底：按能力的**产出类型**（`CAPABILITY_META[code].kind`）判。
 *
 * ⚠️ 这两个分支**曾经是三张手写的代码表**（这里的 AUDIO/TEXT、AiPanel 的 VIDEO），
 * 于是 `asr` 在这张表里是音频、在 `CAPABILITY_META` 里是 `text` —— 转写结果没有扩展名时
 * 被当成音频素材，素材库里给一段字幕配了个播放器。手写表的通病是**漏一个不报错**：
 * 新能力加进来、表里没写它，就静默落到 `other`，显示成「文件」。
 */
export function guessKind(url) {
  const text = String(url || '')
  if (VIDEO_EXT.test(text)) return 'video'
  if (AUDIO_EXT.test(text)) return 'audio'
  if (IMAGE_EXT.test(text)) return 'image'
  return 'other'
}

export const KIND_LABEL = { image: '图片', video: '视频', audio: '音频', text: '文本', other: '文件' }

let seq = 0

/**
 * 读媒体时长与分辨率。
 *
 * 刻意不用 ffprobe：素材一进来就要显示时长和分辨率，为这个去外挂一个 ffmpeg
 * 既慢又要处理路径/编码问题；浏览器自带解码器读元数据只要几十毫秒，还零依赖。
 * 读不到就返回空对象 —— 元数据是锦上添花，不该让导入失败。
 */
export function probeMedia(url, kind) {
  return new Promise((resolve) => {
    if (!url) return resolve({})
    if (kind === 'image') {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => resolve({})
      img.src = url
      return
    }
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video')
    el.preload = 'metadata'
    const done = (payload) => {
      el.removeAttribute('src')
      el.load()
      resolve(payload)
    }
    el.onloadedmetadata = () => {
      const duration = Number.isFinite(el.duration) ? el.duration : 0
      done({ duration, width: el.videoWidth || 0, height: el.videoHeight || 0 })
    }
    el.onerror = () => done({})
    // 个别容器（如无索引的 mkv）元数据永远读不出来，不能一直挂着
    setTimeout(() => done({}), 8000)
    el.src = url
  })
}

/**
 * 本地文件 → 媒体库素材。
 * 与 assetsFromTask 产出的素材同构，界面和后续导出都按同一套字段消费。
 */
export function localAssetsFrom(rows, metas = []) {
  return rows.map((row, index) => {
    const meta = metas[index] || {}
    return {
      id: `asset_local_${Date.now().toString(36)}_${++seq}_${index}`,
      name: row.name,
      kind: row.kind,
      url: row.url,
      path: row.path || '',
      size: row.size || 0,
      source: 'local',
      duration: meta.duration || undefined,
      width: meta.width || undefined,
      height: meta.height || undefined,
      createdAt: new Date().toISOString()
    }
  })
}
