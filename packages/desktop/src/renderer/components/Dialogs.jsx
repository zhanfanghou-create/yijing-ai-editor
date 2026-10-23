import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconAlert, IconCheck, IconClose, IconExternal, IconInfo, IconLock, IconRefresh } from '../icons.jsx'
import {
  ACTIONS,
  FIXED_KEYS,
  GROUPS,
  comboOf,
  comboParts,
  conflictCombos,
  defaultKeymap,
  findConflicts,
  mergeKeymap,
  normalizeCombo
} from '../keymap.js'
import { Field, Modal, useToast } from '../ui.jsx'
import { openExternal } from '../platform.js'
// 参考风格弹窗壳的标题栏小 logo —— 与顶栏 / 首页同一来源，不许两处各画一个
import logoUrl from '../assets/logo-256.png'

/**
 * 快捷键的一串键位（如 `Ctrl+Shift+K`）拆成一格一格的 `<kbd>`。
 *
 * 单独抽成组件是因为两处都要用（键位格 + 冲突提示那一行），
 * 而"少抽一个组件"的写法会让两处各自演化 —— 一边的键位突然不显示加号了，
 * 这种差异不会报错，只有眼尖才看得见。
 */
function KeyChips({ combo }) {
  return comboParts(combo).map((part) => <kbd key={part}>{part}</kbd>)
}

export function SettingsDialog({
  info,
  onClose,
  keymap,
  onKeymapChange,
  hardwareAcceleration = true,
  /* 导入方式：link = 只在素材里记下原路径；copy = 复制一份进应用的素材目录 */
  importMode = 'link',
  onImportModeChange,
  onHardwareAccelerationChange,
  onRestart,
  /* 预览画质：full 原片 / smooth 720p 代理 / fast 540p 代理。
     只影响预览取哪个文件，导出永远用原片（见 shared/proxy.js 的说明）。 */
  previewQuality = 'full',
  onPreviewQualityChange
}) {
  const [tab, setTab] = useState('general')
  /** 正在等待录入的动作：`{ id, index }`；index 为 null 表示新增一格 */
  const [capturing, setCapturing] = useState(null)
  const toast = useToast()

  const current = useMemo(() => mergeKeymap(keymap), [keymap])
  const defaults = useMemo(() => defaultKeymap(), [])
  const conflicts = useMemo(() => conflictCombos(current), [current])
  const conflictList = useMemo(() => findConflicts(current), [current])
  const customized = useMemo(
    () =>
      ACTIONS.filter(
        (action) => JSON.stringify(current[action.id] || []) !== JSON.stringify(defaults[action.id] || [])
      ),
    [current, defaults]
  )

  /**
   * 归一化后上抛给 App。
   *
   * 这里**不落盘**：持久化统一由 App.jsx 的 changeKeymap 负责（它要同时写
   * localStorage 与主进程 settings 两处）。弹窗里再写一遍 localStorage
   * 会出现"谁才是真源"的歧义，将来加一种存储就会漏掉一处。
   */
  const apply = (next) => {
    onKeymapChange(mergeKeymap(next))
  }

  /** 把某个动作的第 index 格改成 combo；index 为 null 表示追加一格 */
  const bind = (actionId, index, combo) => {
    const list = [...(current[actionId] || [])]
    if (index === null) list.push(combo)
    else list[index] = combo
    // 同一动作内去重：改成的键位若已经绑在本动作另一格上，只保留一份
    const seen = new Set()
    const next = []
    for (const item of list) {
      const norm = normalizeCombo(item)
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      next.push(norm)
    }
    apply({ ...current, [actionId]: next })
  }

  /** 取消某一格绑定（清空是合法状态，不是错误） */
  const removeSlot = (actionId, index) => {
    const list = [...(current[actionId] || [])]
    list.splice(index, 1)
    apply({ ...current, [actionId]: list })
  }

  useEffect(() => {
    if (!capturing) return undefined
    const onKey = (event) => {
      // 捕获阶段就截住，理由见上方注释 1
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        return
      }
      const combo = comboOf(event)
      // 只按了 Ctrl / Shift 这类修饰键时返回空串，继续等主键
      if (!combo) return
      bind(capturing.id, capturing.index, combo)
      setCapturing(null)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, current])

  const shortcutPanel = (
    <>
      <div className="notice" style={{ marginBottom: 12 }}>
        <IconInfo size={14} />
        <span>
          点击键位格后直接按新键位即可改绑，Esc 取消。改动立即生效并保存在本机；
          「恢复默认」就是撤销。同一键位绑给两个动作时会标红提示冲突。
        </span>
      </div>

      {conflictList.length ? (
        <div className="notice bad" style={{ marginBottom: 12 }} data-keymap-conflict>
          <IconAlert size={14} />
          <span>
            检测到 {conflictList.length} 处键位冲突：
            {conflictList
              .map((item) => `${item.combo}（${item.actions.map((action) => action.label).join(' / ')}）`)
              .join('；')}
            。冲突时只有排在前面的动作会响应。
          </span>
        </div>
      ) : null}

      <div className="wb-keys">
        {GROUPS.map((group) => {
          const rows = ACTIONS.filter((action) => action.group === group)
          if (!rows.length) return null
          return (
            <div className="wb-keys-group" key={group}>
              <div className="wb-keys-group-title">{group}</div>
              {rows.map((action) => {
                const combos = current[action.id] || []
                const dirty =
                  JSON.stringify(combos) !== JSON.stringify(defaults[action.id] || [])
                const isCapturing = capturing && capturing.id === action.id
                return (
                  <div
                    className={`wb-keys-row ${isCapturing ? 'capturing' : ''}`}
                    key={action.id}
                    data-action={action.id}
                    data-keys={combos.join(',')}
                  >
                    <span
                      className="wb-keys-label"
                      title={action.scope === 'global' ? '首页与工作台都可用' : '仅在剪辑工作台生效'}
                    >
                      {action.label}
                      {action.scope === 'global' ? <em>全局</em> : null}
                    </span>
                    <span className="wb-keys-value">
                      {isCapturing ? (
                        <span className="wb-keys-hint">按下新键位…（Esc 取消）</span>
                      ) : combos.length ? (
                        combos.map((combo, index) => (
                          <span className="wb-key-slot" key={`${combo}-${index}`}>
                            <button
                              type="button"
                              className={`wb-key-chip ${conflicts.has(combo) ? 'conflict' : ''}`}
                              onClick={() => setCapturing({ id: action.id, index })}
                              title={
                                conflicts.has(combo)
                                  ? '与其它动作冲突，点一下改掉'
                                  : '点击后按下新键位'
                              }
                            >
                              <KeyChips combo={combo} />
                            </button>
                            <button
                              type="button"
                              className="wb-key-drop"
                              onClick={() => removeSlot(action.id, index)}
                              data-unbind={`${action.id}:${index}`}
                              title="取消这一格绑定"
                            >
                              <IconClose size={12} />
                            </button>
                          </span>
                        ))
                      ) : (
                        <button
                          type="button"
                          className="wb-key-chip empty"
                          onClick={() => setCapturing({ id: action.id, index: null })}
                        >
                          未绑定
                        </button>
                      )}

                      {!isCapturing ? (
                        <button
                          type="button"
                          className="wb-key-add"
                          onClick={() => setCapturing({ id: action.id, index: null })}
                          title="为这个动作再加一个键位"
                        >
                          ＋
                        </button>
                      ) : null}

                      {dirty && !isCapturing ? (
                        <button
                          type="button"
                          className="wb-key-reset"
                          onClick={() => apply({ ...current, [action.id]: [...(defaults[action.id] || [])] })}
                          title={`恢复默认：${(defaults[action.id] || []).join(' / ') || '无'}`}
                        >
                          恢复默认
                        </button>
                      ) : null}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        })}

        <div className="wb-keys-group">
          <div className="wb-keys-group-title">固定键位</div>
          {FIXED_KEYS.map((item) => (
            <div className="wb-keys-row readonly" key={item.label}>
              <span className="wb-keys-label">
                {item.label}
                <em>{item.note}</em>
              </span>
              <span className="wb-keys-value">
                {item.keys.map((combo) => (
                  <span className="wb-key-chip static" key={combo}>
                    <KeyChips combo={combo} />
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  )

  const generalPanel = (
    <>
      {/* 预览画质：这是"卡不卡"的那一档，与导出画质**无关** ——
          档位越低，预览用的是一份现生成的低分辨率代理；导出永远用原片。
          文案必须把这件事写出来，否则用户会以为"调到极速，成片也变糊了"。 */}
      <Field label="预览画质" hint="只影响预览是否流畅，导出始终使用原片">
        <div className="seg" data-settings-preview-quality>
          {['full', 'smooth', 'fast'].map((key) => (
            <button
              key={key}
              type="button"
              data-pq={key}
              aria-pressed={previewQuality === key}
              className={previewQuality === key ? 'active' : ''}
              onClick={() => onPreviewQualityChange && onPreviewQualityChange(key)}
            >
              {key === 'full' ? '完整' : key === 'smooth' ? '流畅 720p' : '极速 540p'}
            </button>
          ))}
        </div>
      </Field>
      {/* 硬件加速：参考客户端「首选项」里的一项，配的提示是
          「导出的视频异常请试图关闭硬件加速」——
          也就是说它是**导出异常时的兜底开关**，不是可有可无的装饰。
          ⚠️ 它是启动期 API（app.disableHardwareAcceleration 必须早于 whenReady），
          所以改了必须重启；这里同时显示"设置值"和"实际生效值"，
          不相等就明确提示重启，避免用户以为开关坏了。 */}
      <Field label="硬件加速" hint="导出视频异常时，可尝试关闭它（需要重启应用）">
        <div className="hw-row">
          <div className="seg" data-settings-hw>
            <button
              type="button"
              className={hardwareAcceleration ? 'active' : ''}
              onClick={() => onHardwareAccelerationChange(true)}
            >
              开启
            </button>
            <button
              type="button"
              className={!hardwareAcceleration ? 'active' : ''}
              onClick={() => onHardwareAccelerationChange(false)}
            >
              关闭
            </button>
          </div>
          {info && Boolean(info.hardwareAcceleration) !== Boolean(hardwareAcceleration) ? (
            <div className="notice warn" style={{ flex: 1, margin: 0 }} data-settings-hw-dirty>
              <IconAlert size={14} />
              <span>已保存，重启后生效</span>
              <button className="btn ghost small" type="button" onClick={onRestart} data-settings-restart>
                立即重启
              </button>
            </div>
          ) : (
            <span className="wb-muted-sm">当前实际：{info?.hardwareAcceleration === false ? '已关闭' : '已开启'}</span>
          )}
        </div>
      </Field>

      {/* 导入方式：参考客户端「首选项」里没有这一项（它是导入对话框里的一个勾），
          但本项目没有"导入对话框"，导入就是直接开系统文件框 —— 所以只能落到设置里。
          文案必须把**代价**写清楚：复制会占磁盘，引用会因为原文件被移走而断。 */}
      <Field label="素材导入方式" hint="只影响之后导入的素材，已经导入的不会变动">
        <div className="seg" data-settings-import>
          <button
            type="button"
            className={importMode !== 'copy' ? 'active' : ''}
            onClick={() => onImportModeChange && onImportModeChange('link')}
            data-import-mode="link"
            title="只记下文件在原处的位置。省空间，但原文件被移走或删除后，草稿里这一段会变成离线素材。"
          >
            保留原位
          </button>
          <button
            type="button"
            className={importMode === 'copy' ? 'active' : ''}
            onClick={() => onImportModeChange && onImportModeChange('copy')}
            data-import-mode="copy"
            title="导入时复制一份到应用的素材目录。占用磁盘，但原文件移走、删除都不影响草稿。"
          >
            复制进草稿
          </button>
        </div>
      </Field>

      <div className="section-title">
        <span>运行环境</span>
      </div>
      <div className="kv-list">
        <div>
          <span>应用</span>
          <strong>
            {info?.name} v{info?.version}
          </strong>
        </div>
        <div>
          <span>运行方式</span>
          <strong>{info?.packaged ? '已安装版本' : '开发 / 预览'}</strong>
        </div>
        <div>
          <span>平台</span>
          <strong>{info?.platform}</strong>
        </div>
        <div>
          <span>Electron</span>
          <strong>{info?.electron || '—'}</strong>
        </div>
        <div>
          <span>Chromium</span>
          <strong>{info?.chrome || '—'}</strong>
        </div>
      </div>

      <div className="notice" style={{ marginTop: 12 }}>
        <IconInfo size={14} />
        <span>全部处理都在本机完成：素材来自导入，成片由本机 ffmpeg 导出，不会向任何服务器发送数据。</span>
      </div>
    </>
  )

  return (
    <Modal
      wide
      title="设置"
      desc={
        tab === 'general'
          ? '本机单机运行，只改本机生效的偏好设置。'
          : '全部可改键位一览；点击键位格即可重新录入。'
      }
      onClose={onClose}
      footer={
        tab === 'general' ? (
          <>
            <button className="btn ghost" type="button" onClick={onClose}>
              关闭
            </button>
          </>
        ) : (
          <>
            <span className="wb-keys-count">
              {customized.length ? `已自定义 ${customized.length} 个动作` : '当前全部为默认键位'}
            </span>
            <button
              className="btn ghost"
              type="button"
              disabled={!customized.length}
              onClick={() => {
                // reset 让存储被真正清空，而不是写入一份"恰好等于默认"的表
                onKeymapChange(defaultKeymap(), { reset: true })
                toast.good('已恢复全部默认键位')
              }}
            >
              恢复全部默认
            </button>
            <button className="btn primary" type="button" onClick={onClose}>
              完成
            </button>
          </>
        )
      }
    >
      <div className="seg" style={{ marginBottom: 14 }}>
        <button type="button" className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')} data-settings-tab="general">
          通用
        </button>
        <button
          type="button"
          className={tab === 'shortcut' ? 'active' : ''}
          onClick={() => {
            setCapturing(null)
            setTab('shortcut')
          }}
          data-settings-tab="shortcut"
        >
          快捷键
        </button>
      </div>

      {tab === 'general' ? generalPanel : shortcutPanel}
    </Modal>
  )
}

/* ================================ 关于我们 ================================ */

/**
 * 关于弹窗（顶栏「帮助 → 关于我们」）。
 *
 * 这一项以前不存在，顶栏「帮助」是一个直接 `window.open(官网)` 的按钮 ——
 * 现在「帮助」是真下拉（使用指引 / 关于），「关于」补成真实现：
 * 版本、运行环境、数据目录都取自主进程 `app:info`，不是写死的字符串。
 */
export function AboutDialog({ info, onClose }) {
  const rows = [
    ['版本', info?.version ? `v${info.version}` : '—'],
    ['运行环境', info?.packaged ? '正式安装版' : '开发模式'],
    ['Electron', info?.electron || '—'],
    ['Chromium', info?.chrome || '—'],
    ['平台', info?.platform || '—'],
    ['数据目录', info?.userData || '—']
  ]
  return (
    <Modal
      title="关于我们"
      desc="艺镜AI剪辑 · AI 短剧与视频创作工具"
      onClose={onClose}
      footer={
        <button className="btn primary" type="button" onClick={onClose} data-about="close">
          知道了
        </button>
      }
    >
      <div className="about-rows" data-about="rows">
        {rows.map(([key, value]) => (
          <div className="about-row" key={key}>
            <span className="about-key">{key}</span>
            <span className="about-value" title={value}>
              {value}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* ============================== 使用指引 ============================== */

/**
 * 每一步的示意都是**自绘 SVG**（不引任何位图）。
 *
 * 理由：参考那 8 张 guideStepImages 是从它自己的安装目录里取出来的他人作品，
 * 我们一个都没拿（与"仓库内图形资产必须全部自有"同一口径）。与其再放一批占位图，
 * 不如用矢量直接画出"这一步在界面的哪个位置"——既能说清，也不引入版权问题。
 */
const GUIDE_STEPS = [
  {
    key: 'import',
    title: '导入素材',
    text: '在「素材」页把本地视频、图片、音频拖进来，或直接拖到下方时间线的视频轨。',
    art: 'import'
  },
  {
    key: 'trim',
    title: '修剪片段',
    text: '拖动片段两端改时长，把播放头放到要切的位置按 Ctrl+B 一刀两段。',
    art: 'trim'
  },
  {
    key: 'subtitle',
    title: '加字幕',
    text: '「字幕」页选 AI 字幕自动识别人声，或选一种样式直接套到画面上。',
    art: 'subtitle'
  },
  {
    key: 'transition',
    title: '加转场',
    text: '「转场」页挑一个效果拖到两个片段的接缝上，预览区会当场演示。',
    art: 'transition'
  },
  {
    key: 'look',
    title: '调色与特效',
    text: '「滤镜」给片段套风格、强度可调；「特效」加抖动 / 闪光 / 扫描线等画面动效。',
    art: 'look'
  },
  {
    key: 'audio',
    title: '配乐与配音',
    text: '音频轨放 BGM，预览时与画面同时播放；音量在播放器右下角调。',
    art: 'audio'
  },
  {
    key: 'ai',
    title: 'AI 生成',
    text: '首页或「AI」页用文生图 / 文生视频 / 剧本等能力，产物直接进素材库。',
    art: 'ai'
  },
  {
    key: 'export',
    title: '导出成片',
    text: '右上角「导出」选分辨率与帧率，按时间线合成一个 MP4。',
    art: 'export'
  }
]

/** 步骤示意：纯几何 + currentColor，随主题走，不需要额外素材 */
function GuideArt({ kind }) {
  const box = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.9 }
  const soft = { fill: 'currentColor', opacity: 0.16 }
  return (
    <svg className="guide-art" viewBox="0 0 132 76" aria-hidden="true">
      <rect x="0.7" y="0.7" width="130.6" height="74.6" rx="6" {...box} opacity={0.35} />
      {kind === 'import' ? (
        <>
          <rect x="10" y="14" width="42" height="48" rx="4" {...soft} />
          <rect x="10" y="14" width="42" height="48" rx="4" {...box} />
          <path d="M22 30h18M22 38h12M22 46h18" {...box} opacity={0.5} />
          <path d="M58 38h20m0 0-5-5m5 5-5 5" {...box} />
          <rect x="84" y="20" width="38" height="36" rx="4" {...soft} />
          <rect x="84" y="20" width="38" height="36" rx="4" {...box} />
          <path d="M92 44l10-12 8 9 5-5 7 8z" {...box} />
        </>
      ) : null}
      {kind === 'trim' ? (
        <>
          <rect x="12" y="26" width="108" height="24" rx="3" {...soft} />
          <rect x="12" y="26" width="108" height="24" rx="3" {...box} />
          <path d="M12 26v24M120 26v24" {...box} strokeWidth={2.4} />
          <path d="M66 14v48" {...box} strokeDasharray="3 3" opacity={0.75} />
          <path d="M60 20l6-6 6 6M60 56l6 6 6-6" {...box} opacity={0.6} />
        </>
      ) : null}
      {kind === 'subtitle' ? (
        <>
          <rect x="12" y="12" width="108" height="46" rx="4" {...soft} />
          <rect x="12" y="12" width="108" height="46" rx="4" {...box} />
          <rect x="30" y="52" width="72" height="14" rx="7" {...box} opacity={0.7} />
          <path d="M44 59h44" {...box} opacity={0.8} />
          <circle cx="66" cy="34" r="10" {...box} opacity={0.5} />
        </>
      ) : null}
      {kind === 'transition' ? (
        <>
          <rect x="8" y="18" width="52" height="40" rx="3" {...soft} />
          <rect x="8" y="18" width="52" height="40" rx="3" {...box} />
          <rect x="72" y="18" width="52" height="40" rx="3" {...soft} />
          <rect x="72" y="18" width="52" height="40" rx="3" {...box} />
          <path d="M66 30l-10 8 10 8" {...box} />
          <circle cx="66" cy="38" r="14" {...box} opacity={0.35} strokeDasharray="2 3" />
        </>
      ) : null}
      {kind === 'look' ? (
        <>
          <rect x="14" y="16" width="46" height="44" rx="3" {...soft} />
          <rect x="14" y="16" width="46" height="44" rx="3" {...box} />
          <path d="M20 52l10-16 8 10 6-8 10 14z" {...box} />
          <rect x="72" y="16" width="46" height="44" rx="3" {...soft} />
          <rect x="72" y="16" width="46" height="44" rx="3" {...box} />
          <path d="M72 44c8-14 16 8 24-4s10 8 22-6" {...box} strokeWidth={2} />
        </>
      ) : null}
      {kind === 'audio' ? (
        <>
          <rect x="12" y="16" width="108" height="20" rx="3" {...soft} />
          <rect x="12" y="16" width="108" height="20" rx="3" {...box} />
          <rect x="12" y="44" width="108" height="16" rx="3" {...soft} />
          <rect x="12" y="44" width="108" height="16" rx="3" {...box} />
          <path d="M20 52v0M26 48v8M32 45v14M38 49v6M44 46v12M50 50v4M56 44v16M62 48v8M68 46v12M74 50v4" {...box} />
          <path d="M88 47v6M96 44v12M104 48v8M112 46v12" {...box} opacity={0.7} />
        </>
      ) : null}
      {kind === 'ai' ? (
        <>
          <rect x="16" y="14" width="44" height="48" rx="4" {...soft} />
          <rect x="16" y="14" width="44" height="48" rx="4" {...box} />
          <path d="M26 46l8-12 7 9 5-5 8 8" {...box} />
          <circle cx="38" cy="26" r="4" {...box} />
          <path d="M70 38h16m0 0-6-5m6 5-6 5" {...box} />
          <rect x="92" y="20" width="28" height="36" rx="4" {...soft} />
          <rect x="92" y="20" width="28" height="36" rx="4" {...box} />
          <path d="M100 32h12M100 40h8" {...box} opacity={0.6} />
        </>
      ) : null}
      {kind === 'export' ? (
        <>
          <rect x="30" y="14" width="72" height="40" rx="4" {...soft} />
          <rect x="30" y="14" width="72" height="40" rx="4" {...box} />
          <path d="M56 30l14 8-14 8z" {...box} />
          <path d="M66 62V46m0 0-5 5m5-5 5 5" {...box} />
          <path d="M44 62h44" {...box} opacity={0.5} />
        </>
      ) : null}
    </svg>
  )
}

/**
 * 使用指引：应用内分步引导。
 *
 * 以前「帮助 → 使用指引」是 openExternal(官网首页) —— 界面上有入口，点下去只是
 * 开个浏览器，跟"没有这个功能"没区别。这里做成真的引导：8 步覆盖从导入到导出
 * 的完整链路，每步都能直接跳到对应页面。
 */
export function GuideDialog({ onClose, onJump }) {
  const [step, setStep] = useState(0)
  const item = GUIDE_STEPS[step]
  const last = step === GUIDE_STEPS.length - 1

  return (
    <Modal wide title="使用指引" desc="八步走完从导入到导出的完整链路，每步都能直接跳到对应页面。" onClose={onClose}>
      <div className="guide" data-guide-step={item.key}>
        <GuideArt kind={item.art} />
        <h4 className="guide-title">{item.title}</h4>
        <p className="guide-text">{item.text}</p>

        <div className="guide-dots" role="tablist" aria-label="引导步骤">
          {GUIDE_STEPS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              className={`guide-dot ${i === step ? 'on' : ''}`}
              onClick={() => setStep(i)}
              aria-label={`第 ${i + 1} 步：${s.title}`}
              aria-current={i === step ? 'step' : undefined}
              data-guide-dot={s.key}
            />
          ))}
        </div>

        <div className="guide-actions">
          <span className="guide-count">
            {step + 1} / {GUIDE_STEPS.length}
          </span>
          <span className="grow" />
          {onJump && item.key !== 'import' ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                onJump(item.key)
                onClose()
              }}
              data-guide-jump
            >
              去试试
            </button>
          ) : null}
          {step > 0 ? (
            <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : null}
          <button
            type="button"
            className="btn primary"
            onClick={() => (last ? onClose() : setStep(step + 1))}
            data-guide-next
          >
            {last ? '开始创作' : '下一步'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
