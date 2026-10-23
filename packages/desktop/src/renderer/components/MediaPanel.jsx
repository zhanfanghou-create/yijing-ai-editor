import { useMemo, useState } from 'react'
import { KIND_LABEL } from '../assets.js'
import {
  IconAddSquare,
  IconClose,
  IconCreateVideo,
  IconEnhance,
  IconFilter,
  IconFolder,
  IconGridView,
  IconListView,
  IconPlus,
  IconSearch,
  IconStar,
  IconTalkingPhoto,
  IconTrash
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

/**
 * 素材栏的排序 / 筛选口径。
 *
 * ⚠️ 这两组是**视图状态**，刻意不落设置：与「只看收藏」同理 ——
 *    下次启动时素材库应该按"最近导入在前"复位，而不是停在上一轮筛出来的半空列表里
 *    （用户会以为素材丢了）。
 *
 * ⚠️ 排序必须是**稳定的、可解释的**：`recent` 用素材进库时间（没有就按数组原序倒排），
 *    `name` 用 `localeCompare('zh')`（默认的字典序会把中文全部排到英文后面，
 *    那是按码位排，不是按读音）。三条都不可能返回 NaN，否则 sort 会静默乱序。
 */
const SORTS = [
  { key: 'recent', label: '最近' },
  { key: 'name', label: '名称' },
  { key: 'duration', label: '时长' }
]

const KIND_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'video', label: '视频' },
  { key: 'image', label: '图片' },
  { key: 'audio', label: '音频' }
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
  onToggleFavorite,
  onTool
}) {
  const toast = useToast()
  /**
   * 「只看收藏」。
   *
   * 刻意做成**本地状态**而不是设置项：它是一个"临时视图"，
   * 关掉应用再打开时应该回到全部素材 —— 谁会希望下次启动时素材库是空的、
   * 还以为素材丢了。
   *
   * ⚠️ 过滤放在**渲染前**（visible）而不是在 map 里 if 掉：
   *    空态要能显示一句"还没有收藏"，把 if 塞进 map 只会得到一片空白。
   */
  const [favOnly, setFavOnly] = useState(false)
  /* 搜索 / 视图 / 排序 / 类型筛选 —— 四个都是真实生效的视图状态（无一项是装饰） */
  const [query, setQuery] = useState('')
  const [view, setView] = useState('grid')
  const [sort, setSort] = useState('recent')
  const [kindFilter, setKindFilter] = useState('all')

  /* 类型筛选的显示名：与下拉选项同一份表，避免"下拉里叫图片、空态里叫图像" */
  const kindText = (key) => KIND_FILTERS.find((item) => item.key === key)?.label || '全部'

  /**
   * 素材管道：收藏筛选 → 类型筛选 → 文件名搜索 → 排序。
   *
   * ⚠️ 全部在**渲染前**算完（不是 map 里 if 掉），因为空态要能说清"为什么空"：
   *    是没素材、还是没收藏、还是搜索没命中 —— 三者给同一片空白，用户只会以为素材丢了。
   */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = assets.filter((asset) => {
      if (favOnly && !asset.favorite) return false
      if (kindFilter !== 'all' && asset.kind !== kindFilter) return false
      /* 文件名搜索：名称 + 类型名一起搜（"视频" 能搜出全部视频），不搜路径 */
      if (!q) return true
      const hay = `${asset.name || ''} ${KIND_LABEL[asset.kind] || ''}`.toLowerCase()
      return hay.includes(q)
    })
    const out = [...pool]
    if (sort === 'name') {
      out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'))
    } else if (sort === 'duration') {
      out.sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0))
    } else {
      /* 最近导入：有 addedAt 按它倒排，没有就把原数组倒过来（导入是 append，尾部最新） */
      out.sort((a, b) => {
        const ta = Number(a.addedAt) || 0
        const tb = Number(b.addedAt) || 0
        if (ta && tb && ta !== tb) return tb - ta
        return 0
      })
      if (!out.some((asset) => Number(asset.addedAt))) out.reverse()
    }
    return out
  }, [assets, favOnly, kindFilter, query, sort])

  /** 空列表时的解释：三种"空"的原因不一样，说明也必须不一样 */
  const emptyReason = query.trim()
    ? `没有文件名包含「${query.trim()}」的素材。`
    : kindFilter !== 'all'
      ? `没有${kindText(kindFilter)}类素材。换成「全部」看看。`
      : favOnly
        ? '还没有收藏的素材。把鼠标移到素材卡上，点卡片右下角的星标即可收藏。'
        : ''

  /* ------------------------------- 素材 ------------------------------- */

  return (
    <section className="wb-media">
      {/*
        素材栏横条（参考实测形制）：左侧青色「导入」主按钮 + 搜索框 + 右端视图/排序/筛选。
        ⚠️ 这一条**常驻**（空态也画）：参考里它就是素材区的第一行，
           空态隐藏它会让"导入"入口只剩画面正中那一个 —— 用户刚删空素材库时，
           会发现顶部的导入按钮凭空消失了。
      */}
      <div className="wb-mediabar">
        <button
          className="wb-mb-import"
          type="button"
          onClick={onImport}
          data-import-btn="1"
          title="从电脑导入视频 / 音频 / 图片"
        >
          <IconPlus size={12} />
          导入
        </button>
        <button
          className="wb-mb-viewbtn"
          type="button"
          onClick={() => setView((value) => (value === 'grid' ? 'list' : 'grid'))}
          title={view === 'grid' ? '切换到列表视图' : '切换到网格视图'}
          data-media-view-toggle="1"
        >
          {view === 'grid' ? <IconGridView size={14} /> : <IconListView size={14} />}
        </button>

        <label className="wb-mb-search">
          <IconSearch size={13} />
          <input
            type="search"
            value={query}
            placeholder="搜索文件名"
            data-media-search="1"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
          />
          {query ? (
            <button type="button" title="清空搜索" data-media-search-clear="1" onClick={() => setQuery('')}>
              <IconClose size={11} />
            </button>
          ) : null}
        </label>

        <div className="wb-mb-right">
          <button
            type="button"
            className={`wb-mb-ico${favOnly ? ' on' : ''}`}
            onClick={() => setFavOnly((value) => !value)}
            data-media-fav-filter="1"
            aria-pressed={favOnly}
            title={favOnly ? '显示全部素材' : '只看收藏的素材'}
          >
            <IconStar size={13} />
          </button>
          <button
            type="button"
            className={`wb-mb-ico${view === 'grid' ? ' on' : ''}`}
            onClick={() => setView('grid')}
            aria-pressed={view === 'grid'}
            data-media-view="grid"
            title="网格视图"
          >
            <IconGridView size={14} />
          </button>
          <button
            type="button"
            className={`wb-mb-ico${view === 'list' ? ' on' : ''}`}
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
            data-media-view="list"
            title="列表视图"
          >
            <IconListView size={14} />
          </button>
          <label className="wb-mb-select" title="排序方式">
            <select value={sort} data-media-sort="1" onChange={(event) => setSort(event.target.value)}>
              {SORTS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wb-mb-select is-icon" title="按类型筛选">
            <IconFilter size={13} />
            <select value={kindFilter} data-media-kind="1" onChange={(event) => setKindFilter(event.target.value)}>
              {KIND_FILTERS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

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
          <>
            {/* 分组标题（参考的「全部」那一行）：随左栏选中项与类型筛选变化 */}
            <div className="wb-media-group" data-media-group="1">
              <span>{kindFilter === 'all' ? filterLabel || '全部' : kindText(kindFilter)}</span>
              <em>{visible.length}</em>
              {query.trim() ? <b>搜索「{query.trim()}」</b> : null}
            </div>
            {emptyReason ? (
              <div className="empty" data-media-empty="1">
                {emptyReason}
              </div>
            ) : (
              <div className={`wb-grid${view === 'list' ? ' is-list' : ''}`} data-media-layout={view}>
                {visible.map((asset) => (
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
                        className={asset.favorite ? 'is-on' : ''}
                        title={asset.favorite ? '取消收藏' : '收藏这个素材'}
                        data-fav-toggle={asset.id}
                        aria-pressed={!!asset.favorite}
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleFavorite && onToggleFavorite(asset.id)
                        }}
                      >
                        <IconStar size={12} />
                      </button>
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
          </>
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
