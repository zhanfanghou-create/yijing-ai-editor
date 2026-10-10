import { useState } from 'react'
import { KIND_LABEL } from '../assets.js'
import {
  IconAddSquare,
  IconCreateVideo,
  IconDownload,
  IconEnhance,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconTalkingPhoto,
  IconTrash,
  IconUpload
} from '../icons.jsx'
import { showItem } from '../platform.js'
import { useToast, timecode } from '../ui.jsx'

const KIND_TONE = { image: 'violet', video: 'good', audio: 'warn', text: '', other: '' }

/** 字节数 → 人类可读；0 视为未知，不显示 */
function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 素材的副标题：类型 · 来源 · 分辨率 · 时长 · 体积，有哪项显示哪项 */
function assetSummary(asset) {
  const parts = [KIND_LABEL[asset.kind] || '文件']
  if (asset.capability) parts.push(asset.capability)
  if (asset.source === 'local') parts.push('本地')
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`)
  if (asset.duration) parts.push(timecode(asset.duration, false))
  const size = formatSize(asset.size)
  if (size) parts.push(size)
  return parts.join(' · ')
}

/**
 * 视频缩略图。
 *
 * 两个真实的坑，都在这一小块里：
 *
 *  1. **`preload="metadata"` 只会给你第一帧**，而大量片子第一帧是黑场 ——
 *     素材一导入就是一格全黑，"缩略图不对"就是这么来的。所以元数据一到就把
 *     进度条拖到一个有内容的位置（默认 1 秒，短片按 10% 取），浏览器会画出那一帧。
 *  2. **`<video>` 没有 `object-fit` 的默认行为是"按自身像素尺寸排布"**，
 *     1920×1080 的片子会撑破缩略图格并把下面的文字压掉（外面 `overflow:hidden`
 *     只是把它裁掉，看不出是布局错了）。填充交给 CSS 的 `.media-thumb video`。
 */
function VideoThumb({ asset }) {
  return (
    <div className="media-thumb">
      <video
        src={asset.url}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(event) => {
          const el = event.currentTarget
          const total = Number(el.duration)
          // duration 可能是 Infinity（无索引的流式容器），那种情况别乱 seek
          if (!Number.isFinite(total) || total <= 0) return
          const at = total < 10 ? total * 0.1 : 1
          try {
            el.currentTime = Math.min(at, Math.max(0, total - 0.05))
          } catch {
            /* seek 失败就保持第一帧，不影响其它功能 */
          }
        }}
      />
    </div>
  )
}

/** 缩略图格的比例：有真实像素尺寸就用素材自己的比例，读不到才退回 16:10 */
function thumbStyle(asset) {
  const width = Number(asset.width)
  const height = Number(asset.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { aspectRatio: `${width} / ${height}` }
}

/** 缩略图：图片直接显示；视频取一帧；音频和文本用文字块 */
function Thumb({ asset }) {
  if (asset.kind === 'image' && asset.url) {
    return (
      <div className="media-thumb" style={thumbStyle(asset)}>
        <img src={asset.url} alt={asset.name} loading="lazy" />
      </div>
    )
  }
  if (asset.kind === 'video' && asset.url) return <VideoThumb asset={asset} />
  return (
    <div className="media-thumb" style={thumbStyle(asset)}>
      <span>{KIND_LABEL[asset.kind] || '文件'}</span>
    </div>
  )
}

/** 中栏底部的创作入口：全部是本机就能跑的动作（录屏 / 提取音频走本地 ffmpeg） */
const TOOLS = [
  { key: 'record', label: '录制', Icon: IconCreateVideo },
  { key: 'extract-audio', label: '提取音频', Icon: IconEnhance },
  { key: 'text', label: '加文字', Icon: IconTalkingPhoto }
]

export default function MediaPanel({
  assets,
  filterLabel,
  dragging,
  onAddToTimeline,
  onAddAsset,
  onRemoveAsset,
  onSelect,
  selection,
  onImport,
  onTool
}) {
  const toast = useToast()

  /* ------------------------------- 素材 ------------------------------- */

  return (
    <section className="wb-media">
      {/* 空态时中栏顶部不放任何东西（与参考一致）；已有素材才补一条导入入口 */}
      {assets.length ? (
        <div className="wb-mediabar">
          <span>{filterLabel || '素材'}</span>
          <span>{assets.length} 个</span>
          <span className="wb-grow" />
          <button
            className="btn small primary"
            type="button"
            onClick={onImport}
            data-import-btn="1"
            title="从电脑导入视频 / 音频 / 图片"
          >
            <IconUpload size={13} />
            导入素材
          </button>
        </div>
      ) : null}

      <div className="wb-media-body">
        {!assets.length ? (
          <div className={`wb-dropzone ${dragging ? 'drag' : ''}`} data-dropzone="1">
            <button className="wb-import" type="button" onClick={onImport} data-import-btn="1">
              <IconAddSquare size={16} />
              导入
            </button>
            <small>拖放或单击此处添加视频、音频、照片和字幕。</small>
          </div>
        ) : (
          <div className="wb-grid">
            {assets.map((asset) => (
              <div
                key={asset.id}
                className={`media-card ${selection?.assetId === asset.id ? 'selected' : ''}`}
                onClick={() => onSelect && onSelect(asset)}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(event) => {
                  // 自定义 MIME 带上素材 id；text/plain 是兜底，某些环境只认它
                  event.dataTransfer.setData('application/x-yjai-asset', asset.id)
                  event.dataTransfer.setData('text/plain', asset.name)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                title="拖到下方时间线即可加入片段"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSelect && onSelect(asset)
                }}
              >
                <Thumb asset={asset} />
                <div className="media-meta">
                  <strong title={asset.name}>{asset.name}</strong>
                  <small>{assetSummary(asset)}</small>
                </div>
                <div className="media-actions">
                  <button
                    type="button"
                    title="加入时间线"
                    onClick={(event) => {
                      event.stopPropagation()
                      onAddToTimeline(asset)
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                  {asset.path ? (
                    <button
                      type="button"
                      title="在文件夹中显示"
                      onClick={(event) => {
                        event.stopPropagation()
                        void showItem(asset.path)
                      }}
                    >
                      <IconFolder size={12} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title="删除素材"
                    onClick={(event) => {
                      event.stopPropagation()
                      onRemoveAsset(asset.id)
                    }}
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="wb-tools">
        <div className="wb-tools-split">没有媒体文件？使用这些工具进行创作</div>
        <div className="wb-tools-row">
          {TOOLS.map((tool) => (
            <button
              key={tool.key}
              className="wb-tool"
              type="button"
              onClick={() => onTool && onTool(tool)}
              data-wb-tool={tool.key}
            >
              <tool.Icon size={22} />
              {tool.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
