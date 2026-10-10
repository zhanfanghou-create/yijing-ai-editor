/**
 * 首页（创作中心）—— 打开软件的第一屏。
 *
 * 开源版只有本地能力：从本机导入素材、在剪辑器里编辑、用本机 ffmpeg 导出成片。
 * 没有账号、没有在线素材、没有联网生成 —— 所以首页也只放本地真能做的事，
 * 每一个入口点下去都通向一个真实页面，没有「敬请期待」。
 */
import { useState } from 'react'
import {
  IconCreateVideo, IconDraft,
  IconRingDot, IconMinimize, IconMaximize, IconClose,
  IconChevronRight,
  IconEraser,
  IconCameraEmpty, IconGridView, IconListView,
  IconArrowRight,
  IconTransition, IconFilter, IconWand, IconText, IconCaption, IconMusic, IconLayers
} from '../icons.jsx'
import { isDesktop } from '../platform.js'
// 真 logo：由 tools/extract-ico-frame.mjs 从仓库根 ico/256X256.ico 解出。
import logoUrl from '../assets/logo-256.png'
import '../home.css'

/** 侧栏导航 */
const NAV = [
  { key: 'create', label: '创作视频', Icon: IconCreateVideo, page: 'home' },
  { key: 'drafts', label: '最近草稿', Icon: IconDraft, page: 'drafts' }
]

/**
 * 首页工具行：全部是本机就能跑的剪辑动作。
 * `tab` / `node` 直接落到工作台左栏的真实节点上（见 AssetTree.jsx 的 WB_TREE），
 * 不写"以后会有"的项 —— 点不动的入口比没有入口更糟。
 */
const TOOLS = [
  { key: 'media', label: '素材库', Icon: IconLayers, tab: 'media', node: 'local' },
  { key: 'transition', label: '转场', Icon: IconTransition, tab: 'transition', node: 'transition-root' },
  { key: 'filter', label: '滤镜', Icon: IconFilter, tab: 'filter', node: 'filter-root' },
  { key: 'effect', label: '特效', Icon: IconWand, tab: 'effect', node: 'effect-root' },
  { key: 'text', label: '文字', Icon: IconText, tab: 'text', node: 'text-create' },
  { key: 'subtitle', label: '字幕', Icon: IconCaption, tab: 'subtitle', node: 'sub-new' },
  { key: 'audio', label: '音频', Icon: IconMusic, tab: 'audio', node: 'audio-root' }
]

/** 「最近草稿」页：真实读本地草稿目录，可打开 / 删除 / 新建 */
function DraftsPage({ drafts, onOpenDraft, onDeleteDraft, onNewDraft, fmtTime, fmtDuration }) {
  return (
    <section className="home-page">
      <div className="home-page-head">
        <h2>最近草稿</h2>
        <div className="home-page-actions">
          <button type="button" className="home-page-btn" onClick={onNewDraft}>
            新建草稿
          </button>
        </div>
      </div>

      {drafts.length ? (
        <div className="home-draft-list">
          {drafts.map((draft) => (
            <div key={draft.id} className="home-draft-row">
              <button type="button" className="home-draft-open" onClick={() => onOpenDraft?.(draft)}>
                <span className="home-draft-thumb">
                  <IconDraft size={20} />
                </span>
                <span className="home-draft-meta">
                  <b>{draft.name}</b>
                  <em>
                    {fmtTime(draft.updatedAt)} · {draft.clipCount} 个片段 · {fmtDuration(draft.duration)}
                  </em>
                </span>
              </button>
              <button
                type="button"
                className="home-draft-del"
                title="删除这份草稿"
                onClick={() => onDeleteDraft?.(draft)}
              >
                <IconEraser size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="home-empty">
          <div className="home-empty-wrap">
            <IconCameraEmpty size={150} strokeWidth={1.1} strokeDasharray="7 6" />
          </div>
          <p className="home-empty-text">还没有草稿。进剪辑器加一段素材就会自动保存。</p>
        </div>
      )}
    </section>
  )
}

export default function Home({
  info,
  onOpenSettings,
  onEnterEditor,
  onNavigate,
  drafts = [],
  onOpenDraft,
  onDeleteDraft,
  onNewDraft
}) {
  const [nav, setNav] = useState('create')
  const bridge = isDesktop && typeof window !== 'undefined' ? window.yjai : null

  const pickNav = (item) => {
    setNav(item.key)
    if (item.page === 'home') return
    onNavigate?.(item)
  }

  const fmtTime = (iso) => {
    if (!iso) return '—'
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return '—'
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const fmtDuration = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds) || 0))
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }

  return (
    <div className="home">
      <aside className="home-rail">
        <div className="home-brand">
          <span className="home-brand-mark">
            <img src={logoUrl} alt="" />
          </span>
          <div className="home-brand-text">
            <span>YIJING</span>
            <b>艺镜剪辑</b>
          </div>
        </div>

        <nav className="home-nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              className="home-nav-item"
              data-active={nav === item.key ? 'true' : 'false'}
              type="button"
              onClick={() => pickNav(item)}
            >
              <item.Icon size={24} />
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="home-main">
        <header className="home-top">
          <button
            className="home-round"
            type="button"
            title="设置"
            aria-label="设置"
            onClick={onOpenSettings}
            data-home-round="settings"
          >
            <IconRingDot size={19} />
          </button>
          {bridge ? (
            <div className="home-wins">
              <button type="button" onClick={() => bridge.window.minimize()} aria-label="最小化">
                <IconMinimize size={25} />
              </button>
              <button type="button" onClick={() => bridge.window.toggleMaximize()} aria-label="最大化">
                <IconMaximize size={21} />
              </button>
              <button className="danger" type="button" onClick={() => bridge.window.close()} aria-label="关闭">
                <IconClose size={23} />
              </button>
            </div>
          ) : null}
        </header>

        <div className="home-body">
          {nav === 'drafts' ? (
            <DraftsPage
              drafts={drafts}
              onOpenDraft={onOpenDraft}
              onDeleteDraft={onDeleteDraft}
              onNewDraft={onNewDraft}
              fmtTime={fmtTime}
              fmtDuration={fmtDuration}
            />
          ) : (
            <>
              <div className="home-hero-row">
                <button className="home-hero home-hero-video" type="button" onClick={onEnterEditor}>
                  <h2>视频剪辑器</h2>
                  <p>导入本机素材并开始剪辑</p>
                  <span className="home-hero-btn">
                    开始剪辑
                    <IconArrowRight size={16} />
                  </span>
                </button>

                <button
                  className="home-hero home-hero-ai"
                  type="button"
                  /* `stock` = 左栏「素材库」卡片（带 全部/视频/音频/图片 四个筛选页签），
                     `local` 是它上面的「本地」—— 这张卡写的是"素材库"，就落在素材库。 */
                  onClick={() => onNavigate?.({ key: 'stock', label: '素材库', enterEditor: true, tab: 'media', node: 'stock' })}
                >
                  <h2>素材库</h2>
                  <p>管理本机导入的视频、音频与图片</p>
                  <span className="home-hero-btn">
                    查看素材
                    <IconArrowRight size={16} />
                  </span>
                </button>
              </div>

              <section className="home-tools-sec">
                <div className="home-sec-head">
                  <h3>剪辑工具</h3>
                </div>
                <div className="home-tools">
                  {TOOLS.map((tool) => (
                    <button
                      key={tool.key}
                      className="home-tool"
                      type="button"
                      data-home-tool={tool.key}
                      onClick={() =>
                        onNavigate?.({
                          key: tool.key,
                          label: tool.label,
                          enterEditor: true,
                          tab: tool.tab,
                          node: tool.node
                        })
                      }
                    >
                      <span className="home-tool-ico">
                        <tool.Icon size={22} />
                      </span>
                      <span className="home-tool-label">{tool.label}</span>
                    </button>
                  ))}
                </div>
                <button
                  className="home-tools-more"
                  type="button"
                  aria-label="查看更多工具"
                  onClick={() => onNavigate?.({ key: 'media', label: '素材库', enterEditor: true, tab: 'media', node: 'local' })}
                >
                  <IconChevronRight size={17} />
                </button>
              </section>

              <section className="home-drafts-sec">
                <div className="home-sec-head is-draft">
                  <h3>最近草稿</h3>
                  <span className="home-viewswitch">
                    <IconGridView size={17} data-on="true" />
                    <IconListView size={17} />
                  </span>
                </div>
                {drafts.length ? (
                  <div className="home-draft-cards">
                    {drafts.slice(0, 4).map((draft) => (
                      <button
                        key={draft.id}
                        type="button"
                        className="home-draft-card"
                        onClick={() => onOpenDraft?.(draft)}
                      >
                        <span className="home-draft-card-art">
                          <IconDraft size={22} />
                        </span>
                        <b>{draft.name}</b>
                        <em>
                          {fmtTime(draft.updatedAt)} · {draft.clipCount} 段 · {fmtDuration(draft.duration)}
                        </em>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="home-empty">
                    <div className="home-empty-wrap">
                      <IconCameraEmpty size={150} strokeWidth={1.1} strokeDasharray="7 6" />
                    </div>
                    <p className="home-empty-text">还没有草稿。进剪辑器加一段素材就会自动保存。</p>
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <span hidden>{info?.version || ''}</span>
      </main>
    </div>
  )
}
