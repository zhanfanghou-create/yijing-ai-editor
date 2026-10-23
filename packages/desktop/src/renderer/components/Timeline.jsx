import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconAddSquare,
  IconFlag,
  IconLink,
  IconCaption,
  IconSkipBack,
  IconSkipForward,
  IconChevronDown,
  IconEye,
  IconEyeOff,
  IconFullscreen,
  IconLayers,
  IconLock,
  IconMagnet,
  IconMedia,
  IconMic,
  IconMusic,
  IconRedo,
  IconScissors,
  IconSettings,
  IconSplit,
  IconTrash,
  IconUndo,
  IconUpload,
  IconVolume,
  IconVolumeOff,
  IconZoomIn,
  IconZoomOut
} from '../icons.jsx'
import { timecode, timecodeFrames } from '../ui.jsx'
import { AUDIO_CAPABLE } from '../composite.js'
import { clipSpeed, readCurve, trimPatch } from '../trim.js'
import { pipAnchor } from '../pip.js'
import { effectiveTransitions, filterDef, isNoopFilter } from '../looks.js'
import { ClipAudioWave, ClipFilmstrip, ClipStill, ClipText, ClipWaveform, stripCount } from '../clipVisuals.jsx'
import Splitter from './Splitter.jsx'
/* 画面层级（自由层级）：菜单项可不可点与"上移/下移"的算术都在 shared/layers.js，
   与预览的排序、导出的 overlay 链是同一份 —— 这里不许再写一遍判断。 */
import * as layersTable from '../../shared/layers.js'

const TRACKS = [
  { key: 'video', label: '视频轨', tone: '', icon: 'video' },
  { key: 'overlay', label: '叠加轨', tone: 'overlay', icon: 'video' },
  { key: 'audio', label: '音频轨', tone: 'audio', icon: 'audio' },
  { key: 'text', label: '字幕轨', tone: 'text', icon: 'text' }
]

/** 每秒占多少像素 */
const BASE_DPS = 46

export default function Timeline({
  clips,
  playhead,
  zoom,
  duration,
  selection,
  snap,
  canUndo,
  canRedo,
  onZoom,
  onSnap,
  onSeek,
  onSelect,
  onRemove,
  onClear,
  onSplit,
  onSplitClipAt,
  onUndo,
  onRedo,
  onImport,
  onDragClip,
  /* Alt + 拖动复制：返回复制件的 id（同步写入，见 App 的 duplicateClip） */
  onDuplicateClip,
  onSnapshot,
  onDropAsset,
  /* 下面这几个是「工具栏右侧那一簇」的去处。
     它们**必须**由 App 传进来，不能让工具栏自己编一个"看起来在工作"的行为 ——
     这里原来有 6 个按钮是死的（4 个连 onClick 都没有，2 个点了去开导入对话框），
     逐像素比对和全绿闸门都发现不了：按钮画得对、位置对、hover 也对。
     见 tools/check-dead-buttons.mjs。 */
  /* 剪辑联动：开启时拖动一条片段，同源素材的其它片段一起平移（逻辑在 trim.js） */
  linkEnabled = true,
  onToggleLink,
  /* 用户标记：真源在 App 的 settings 里（不进成片），这里只负责画和点 */
  markers = [],
  onToggleMarker,
  onClearMarkers,
  onStepMarker,
  volume,
  onVolume,
  onOpenStock,
  onOpenSubtitle,
  onOpenSettings,
  /* 时间线全屏态（工具栏最右那个键）。
     ⚠️ 这个状态**住在 App 里**，不在这里 —— 因为「全屏态下 Esc 退出」必须由
     App.jsx 那个**唯一**的全局 keydown 统一处理。本项目约定「全工程只挂一个
     keydown，各组件不许另写」；这里原先自己挂了一个条件监听器给自己开脱，
     结果是同一颗 Esc 在两条互不知情的路径上派发（弹窗开着时时间线的监听器
     也照样在跑），彻底违背了"唯一真源"的初衷。 */
  tlFull = false,
  onTlFull,
  /* 顶缝的水平分隔条：上拖把时间线拉高、下拖压低；双击复位。
     增量语义与 Splitter 相同，钳制在 App（resizePane('timeline')）。 */
  onResizeHeight,
  onResetHeight,
  /* 轨道开关（隐藏/静音/锁定）的真源在 App：
     预览合成与导出都要按它结算（composite.effectiveClips），不能留在本地 ——
     上一版就吃过这个亏：开关只把 lane 变灰，预览照播、成片照渲。 */
  trackState = { hidden: [], muted: [], locked: [], solo: [] },
  onTrackState,
  /* 停用/启用片段（右键菜单 + V 键）与「打开文件所在位置」都由 App 落地：
     前者要进预览与导出的统一结算，后者要跨 preload 通道调 shell。 */
  onToggleClipEnabled,
  onRevealClip,
  /* 多机位：新建（吃多选集）/ 解除（摊回普通片段） */
  onCreateMulticam,
  onUngroupMulticam,
  /* 替换片段的素材：要弹系统文件选择框 + 探测新素材时长，只能由 App 落地 */
  onReplaceClip,
  /* 复合片段：新建（吃多选集合）与解除。语义与坐标换算都在 shared/compound.js */
  onCreateCompound,
  onUngroupClip,
  /* 时间区域：`{ start, end }`（end 可为 null = 只标了入点）。真源在 App，
     这里只负责画、以及把手势换算成秒（算术全在 shared/region.js）。 */
  region = null,
  /* 复制/剪切下来的区间内容：有内容才让「粘贴」可点（空剪贴板点了没反应最恼人） */
  regionClip = null,
  onRegionRange,
  onRegionMark,
  onRegionClear,
  onRegionDelete,
  onRegionCopy,
  onRegionCut,
  onRegionPaste,
  onRegionExport,
  /* 录音配音：面板本身住在 App（它要读播放头、要落片段），这里只要一个入口 */
  onOpenRecorder,
  /* 画面层级（自由层级）：上移 / 下移一层。落地在 App（要写片段表、要进历史） */
  onMoveLayer,
  /* 场景切换检测：探测在主进程（ffmpeg），切点在 App 里换算后落到片段表 */
  onSplitByScenes
}) {
  const laneRef = useRef(null)
  /* 片段表的最新一份（给"选中后滚动到视野"那条 effect 用，理由见那里） */
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const hiddenSet = useMemo(() => new Set(trackState.hidden || []), [trackState])
  const mutedSet = useMemo(() => new Set(trackState.muted || []), [trackState])
  const lockedSet = useMemo(() => new Set(trackState.locked || []), [trackState])
  const soloSet = useMemo(() => new Set(trackState.solo || []), [trackState])
  /** 右键菜单：`{ x, y, clip }`，坐标是客户区坐标，直接喂给 fixed 层 */
  const [menu, setMenu] = useState(null)
  const dragRef = useRef(null)
  /** 静音前的音量，供喇叭键「取消静音」时还原。0 = 当前没有音量可还原 */
  const unmuteRef = useRef(0)
  /** 全屏态是 App 的（见 props 注释），这里只负责渲染与派发切换 */
  const setTlFull = (value) => onTlFull && onTlFull(value)

  /** 轨道开关统一从这里走：只改对应的那一项，别的一律不动 */
  const toggleTrack = (key, field) => {
    if (!onTrackState) return
    const list = Array.isArray(trackState[field]) ? trackState[field] : []
    const next = list.includes(key) ? list.filter((item) => item !== key) : [...list, key]
    onTrackState({ ...trackState, [field]: next })
  }

  /** 锁定的轨道只拦「结构性编辑」（拖动/修剪/删除/分割），拦播放 */
  const trackLocked = (clip) => lockedSet.has(clip.track)

  /**
   * 喇叭键：静音 / 取消静音。
   *
   * 为什么用「记住静音前的值」而不是「切到 0 再切回 100」：用户的音量可能是 37，
   * 取消静音时跳回 100 是丢数据的。参考客户端也是这个行为。
   */
  const toggleMute = () => {
    const current = Number.isFinite(Number(volume)) ? Number(volume) : 100
    if (current > 0) {
      unmuteRef.current = current
      onVolume && onVolume(0)
    } else {
      onVolume && onVolume(unmuteRef.current > 0 ? unmuteRef.current : 100)
    }
  }
  const muted = !(Number.isFinite(Number(volume)) ? Number(volume) : 100)

  const dps = BASE_DPS * zoom
  const width = Math.max(1200, duration * dps)
  /**
   * 吸附辅助线：吸中的那个时间点的秒数（没吸上为 null）。
   *
   * 为什么要有它：吸附是个**看不见**的动作 —— 用户只知道"拖到这儿了"，
   * 不知道"为什么它自己跳了一下"。参考客户端拖到接缝附近会出一条竖线，
   * 那一下就是"吸住了"的反馈。没有这条线，吸附会被当成"拖动有bug、会跳"。
   */
  const [snapLine, setSnapLine] = useState(null)
  // 空态：参考在这里不画标尺、不画轨道条纹、也不放播放头，
  // 左栏只留一个悬浮小卡片，轨道区是一整块虚线圆角矩形。
  const empty = !clips.length

  const ticks = useMemo(() => {
    // 刻度间隔随缩放变化：放大到一定程度才显示每秒刻度，否则太密看不清
    const step = zoom >= 2.4 ? 1 : zoom >= 1.2 ? 2 : zoom >= 0.6 ? 5 : 10
    const list = []
    for (let second = 0; second <= duration; second += step) list.push(second)
    return list
  }, [duration, zoom])

  /** 视频轨上的转场角标（只含真的会生效的，位置用原始坐标贴着用户看到的接缝） */
  const laneMarkers = useMemo(() => effectiveTransitions(clips), [clips])

  /**
   * 在轨道区（刻度尺 + 各条轨道）按下时定位播放头。
   *
   * 为什么绑 **pointerdown 而不是 click** —— 这里踩过一次真实的坑：
   * 原来绑的是 `onClick`。而 `click` 是**独立的事件类型**，谁都没法用
   * `pointerdown` 上的 `stopPropagation()` 把它拦住。于是"点片段只选中"这个意图
   * 完全失效：`.clip` 里那句 `event.stopPropagation()` 白写了，点一下片段
   * 会顺着冒泡走到这里，把播放头**跳到鼠标点的那一秒**。表现很隐蔽 ——
   * 选中看着是对的，只有"选中后播放头自己跑了"才会露馅；修剪片段后点一下同样会跳。
   *
   * 换成 pointerdown 之后，凡是自己处理了 pointerdown 的子元素（片段、两端修剪手柄）
   * 天然把事件吃掉，不需要每个子元素都记得拦一次 click —— 这才是防住同类缺陷的关键：
   * 靠"每个子元素自觉"的设计，迟早会漏掉一个新加的子元素。
   *
   * 顺带排除非左键：右键是要弹菜单的，不该顺手把播放头挪走。
   */
  /** 把客户区横坐标换算成秒并夹到 [0, duration]，然后定位播放头 */
  const seekToSecondsFromClientX = (clientX) => {
    const lane = laneRef.current
    if (!lane) return
    const rect = lane.getBoundingClientRect()
    const x = clientX - rect.left + lane.scrollLeft
    onSeek(Math.max(0, Math.min(duration, x / dps)))
  }

  /* --------------------------- 时间区域 --------------------------- */

  /**
   * 框选中正在拖的那一段：拖动过程中只改这份 draft，松手才写回 App。
   *
   * 为什么不直接每次 pointermove 都 setRegion：区域是 App 级状态，
   * 每移动一像素就写一次会让整棵工作台重渲染（时间线几百个片段跟着重排），
   * 而拖动本身又依赖重排后的 DOM —— 手感立刻变粘。
   */
  const [regionDraft, setRegionDraft] = useState(null)

  /** 画出来的那段（拖动中优先用 draft，否则用 App 里那份）。半开状态不算区域 */
  const shownRegion = useMemo(() => {
    if (regionDraft) return regionDraft
    if (!region || region.end === null || region.end === undefined) return null
    const start = Number(region.start) || 0
    const end = Number(region.end) || 0
    return end > start ? { start, end } : null
  }, [region, regionDraft])

  /**
   * 起一次区域拖动。
   *
   * @param {Event} event 指针按下事件
   * @param {number|null} fixed 固定不动的那一端（拖手柄时给另一端）；null = 以按下点为锚
   *
   * 两个入口共用：标尺上 **Shift + 拖动**（从锚点长出一段）、以及拖区域两端的把手。
   * 松手统一走 `onRegionRange`（App 那边做规范化；太短就当作取消区域）。
   */
  const startRegionDrag = (event, fixed) => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const anchor = pointerToSeconds(event.clientX)
    const other = fixed === null || fixed === undefined ? anchor : Number(fixed)
    setRegionDraft({ start: Math.min(anchor, other), end: Math.max(anchor, other) })
    const move = (moveEvent) => {
      const at = pointerToSeconds(moveEvent.clientX)
      setRegionDraft({ start: Math.min(other, at), end: Math.max(other, at) })
    }
    const up = (upEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const at = pointerToSeconds(upEvent.clientX)
      setRegionDraft(null)
      if (onRegionRange) onRegionRange(Math.min(other, at), Math.max(other, at))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** 标尺按下：**带 Shift 才是框选**，否则照旧挪播放头（见下面那句注释） */
  const rulerPointerDown = (event) => {
    if (event.shiftKey) {
      startRegionDrag(event, null)
      return
    }
    /* 不带 Shift：交给原来的 seek。这里必须自己调一次并 stopPropagation ——
       标尺是 .wb-tltracks 的子元素，让事件继续冒泡会被外层的 seekFromEvent 再处理一次
       （两次 seek 结果一样，但 `onSelect(null)` 会连带把片段选中也清掉，
       而"点标尺只是想挪播放头"不该取消选中）。 */
    event.stopPropagation()
    seekFromEvent(event)
  }

  const seekFromEvent = (event) => {
    if (event.button !== undefined && event.button !== 0) return
    seekToSecondsFromClientX(event.clientX)
    /* 点轨道空白 = 挪播放头 **并且** 取消选中（与预览里点画面外同一口径）。
       片段自己会 stopPropagation，所以"点片段"永远走不到这里 ——
       不会出现"点一下片段，选中又被取消"的自相矛盾。 */
    if (onSelect) onSelect(null)
  }

  /* --------------------------- 片段拖动 --------------------------- */

  const pointerToSeconds = (clientX) => {
    const lane = laneRef.current
    if (!lane) return 0
    const rect = lane.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left + lane.scrollLeft) / dps)
  }
  /**
   * 吸附阈值按**像素**算，不按秒。
   *
   * 按秒算的通病：缩放到 0.5x 时 0.25 秒只有 6 像素（几乎吸不住），
   * 放大到 4x 时 0.25 秒变成 46 像素（离得老远就被吸走，手根本放不准）。
   * 像素阈值让"吸住的手感"在任意缩放下一致 —— 参考客户端就是这个口径。
   *
   * 8px 是手指/鼠标的容差经验值：再小要靠微调，再大就开始"抢"用户的意图。
   */
  const SNAP_PX = 8

  const snapTolerance = () => SNAP_PX / Math.max(1, dps)

  /** 所有可以吸的点：0 点、播放头、用户标记、其它片段的两端 */
  const snapPoints = (excludeId) => {
    const edges = [0, playhead]
    ;(markers || []).forEach((at) => {
      const value = Number(at)
      if (Number.isFinite(value)) edges.push(value)
    })
    clips.forEach((item) => {
      if (item.id === excludeId) return
      edges.push(item.start, item.start + item.duration)
    })
    return edges
  }

  /**
   * 吸附：把秒数对齐到附近的可吸点。
   * `opts.alt` 为真时**临时不吸**（按住 Alt 拖动是剪辑软件里的通用约定，
   * 用户要放到"两段中间差一点点"的位置时不必先去关吸附开关）。
   */
  const snapSeconds = (raw, excludeId, opts) => {
    if (!snap || (opts && opts.alt)) return raw
    const tol = snapTolerance()
    let best = raw
    let bestGap = tol
    snapPoints(excludeId).forEach((edge) => {
      const gap = Math.abs(edge - raw)
      if (gap < bestGap) {
        bestGap = gap
        best = edge
      }
    })
    return Math.max(0, best)
  }

  /**
   * 拖动**整段**时的吸附：前后两端都参与。
   *
   * 只按前缘吸的后果：想把自己的片段尾巴接到下一段开头时，永远差半个像素，
   * 得先缩放到很大再拖 —— 而"接缝对不齐"会一路留到成片里（黑一帧或叠一帧）。
   *
   * 返回 `{ start, line }`：`line` 是吸中的那个点的秒数，用来画对齐辅助线；
   * 没吸上时为 null（辅助线不该在"自由拖动"时乱闪）。
   */
  const snapMove = (rawStart, duration, excludeId, opts) => {
    if (!snap || (opts && opts.alt)) return { start: Math.max(0, rawStart), line: null }
    const tol = snapTolerance()
    const points = snapPoints(excludeId)
    let best = { start: Math.max(0, rawStart), gap: tol, line: null }
    points.forEach((edge) => {
      const gap = Math.abs(edge - rawStart)
      if (gap < best.gap) best = { start: edge, gap, line: edge }
    })
    points.forEach((edge) => {
      const gap = Math.abs(edge - (rawStart + duration))
      if (gap < best.gap) best = { start: Math.max(0, edge - duration), gap, line: edge }
    })
    return { start: Math.max(0, best.start), line: best.line }
  }

  const beginDrag = (event, clip) => {
    event.stopPropagation()
    /* ⚠️ 只有左键才起拖动 / 改选中：右键也会派发 pointerdown，
       放过去的话「Ctrl 选好三段 → 右键 → 新建复合片段」会先被这次按下重置成单选，
       菜单里就变成"新建复合片段（1 段）"—— 而三段的高亮看上去还在。 */
    if (event.button !== undefined && event.button !== 0) return
    /* Ctrl / Cmd + 点 = **多选**（切换这一段的选中态），并且**不起拖动**：
       多选是为了"挑几段一起做事"，按下就平移会让用户挑不成
       （每点一次，被点的那一段先被拖走半像素）。 */
    if ((event.ctrlKey || event.metaKey) && !trackLocked(clip)) {
      onSelect(clip, { additive: true })
      return
    }
    // 锁定轨只拦编辑不拦选中：点一下还能看属性，但不能拖走
    if (trackLocked(clip)) {
      onSelect(clip)
      return
    }
    /* Alt + 拖动 = **复制一份再拖**（剪辑软件的通用手势，PR / 参考客户端都是它）。
       复制件的 id 由 App 同步给出，所以接下来拖的是新的那一份，原件留在原地。
       ⚠️ 复制已经通过 commitClips 记了一次历史，这里就不再补快照 ——
          否则一次拖动要按两次撤销才回得去。 */
    const copyId = event.altKey && onDuplicateClip ? onDuplicateClip(clip.id) : null
    if (!copyId && onSnapshot) onSnapshot()
    dragRef.current = {
      /* 真正被拖的那个 id（复制时是复制件）与"事件来源"的 id 分开存：
         鼠标事件始终来自原来那个 DOM 节点，两者在复制时不是同一个。 */
      id: copyId || clip.id,
      sourceId: clip.id,
      duration: Number(clip.duration) || 0,
      grabOffset: pointerToSeconds(event.clientX) - clip.start,
      moved: false
    }
    onSelect(copyId ? { ...clip, id: copyId } : clip)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveDrag = (event, clip) => {
    const drag = dragRef.current
    if (!drag || drag.sourceId !== clip.id || !onDragClip) return
    const raw = pointerToSeconds(event.clientX) - drag.grabOffset
    /* 两端都参与吸附（前缘贴下一段、后缘接下一段都要能吸住） */
    const result = snapMove(raw, drag.duration, drag.id, { alt: event.altKey })
    setSnapLine(result.line)
    if (drag.lastStart !== undefined && Math.abs(result.start - drag.lastStart) < 0.001) return
    drag.lastStart = result.start
    drag.moved = true
    onDragClip(drag.id, { start: result.start })
  }

  /**
   * 松开指针：**没有拖动过**就当成一次"点击"，把播放头挪到点击处。
   *
   * 为什么要在这里补一次 seek：片段的 `pointerdown` 为了"只做选中"会把事件吃掉
   * （不这样的话，拖片段会顺带把播放头甩到抓取点），于是点片段本身永远不会
   * 触发轨道区的 seekFromEvent。结果是"点一下片段想把播放头放那儿"完全没反应 ——
   * 而**点击定位到片段所在位置**正是剪辑时最常用的动作。
   *
   * 区分靠 `drag.moved`：真拖动过就是在移动片段，播放头不该跟着跑。
   * 这样两个意图各自保住，比"干脆不拦事件"要稳 —— 后者会让拖动一路甩播放头。
   *
   * 修剪手柄自己的 pointerdown 也 stopPropagation，所以它们松手时 dragRef 是空的，
   * 这里直接返回，不会把"修剪"当成"点击"。
   */
  const endDrag = (event, clip) => {
    const drag = dragRef.current
    dragRef.current = null
    /* 辅助线跟着手势走：松手就撤。留着一条线会让人以为"它还吸在那儿" */
    setSnapLine(null)
    if (!drag || drag.sourceId !== clip.id || drag.moved) return
    // pointercancel 传的是 null（那时指针已经没了，没有坐标可算）
    if (event && event.button !== undefined && event.button !== 0) return
    if (event) seekToSecondsFromClientX(event.clientX)
  }

  /* --------------------------- 片段两端修剪 --------------------------- */

  /**
   * 拖动左右两端把手改时长。
   *
   * 算术全部在 `../trim.js` 里（纯函数，另有一道自证闸门钉住它）。
   * 这里只负责三件事：把指针位置换算成绝对秒数、吸附、把增量写回去。
   *
   * 位置一律**按指针的绝对秒数**算，不累加增量：剪辑时鼠标常被拖到轨道外面，
   * 累加增量一旦丢事件就会永久跑偏，绝对定位最多是这一帧没跟上。
   */
  const trimRef = useRef(null)

  const beginTrim = (event, clip, edge) => {
    // 不 stopPropagation 的话会同时触发 beginDrag，变成"一边剪一边整段拖走"
    event.stopPropagation()
    event.preventDefault()
    // 锁定轨不让修剪：把手显形可以（hover 态由 CSS 管），按下不动
    if (trackLocked(clip)) return
    if (onSnapshot) onSnapshot()
    trimRef.current = { id: clip.id, edge }
    onSelect(clip)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveTrim = (event, clip) => {
    const trim = trimRef.current
    if (!trim || trim.id !== clip.id || !onDragClip) return
    const at = pointerToSeconds(event.clientX)
    // 吸附范围按哪一端在动：剪左端要吸左边界，剪右端要吸右边界
    const snapped = snapSeconds(at, clip.id, { alt: event.altKey })
    const patch = trimPatch(clip, trim.edge, snapped)
    if (patch) onDragClip(clip.id, patch)
  }

  const endTrim = () => {
    trimRef.current = null
  }

  /**
   * 选中片段之后，把它滚到可见范围里。
   *
   * 为什么要有：在**预览里点一下画面**也能选中片段（见 Stage 的 pickAt），
   * 但时间线可能正滚在别处 —— 于是"我点了一下，界面上什么都没变"，
   * 只有右栏内容悄悄换了。选中这件事必须在**两个视图上同时看得见**。
   *
   * 只在真的看不见时才滚：已经可见时滚动会让用户失去"我刚滚到哪儿"的位置感
   * （每点一次片段画面就动一下，很难受）。
   */
  const selectedId = selection?.clipId || ''
  /**
   * 多选集合（Ctrl / Cmd + 点选）里**除主选中之外**的那几段 —— 主选中自己已经有
   * `.selected` 了，再叠一层 `.multi` 会两套描边打架（视觉上像"选中了两次"）。
   */
  const multiSet = useMemo(() => {
    const ids = Array.isArray(selection?.clipIds) ? selection.clipIds : []
    return new Set(ids.filter((id) => id && id !== selection?.clipId))
  }, [selection])

  /**
   * 右键菜单「新建复合片段」到底吃哪几段。
   *
   * 右键点的是多选集里的一员 ⇒ 吃**整个集合**（用户在界面上看到的就是这几段高亮着，
   * 只合成一段会与看到的完全不符）；否则只吃右键的这一段。
   * 这条与 `openMenu` 里"保留集合"的判断是同一个口径 —— 两处写不一样会出现
   * "右键之后高亮还在、合成出来却只有一段"。
   */
  const compoundIds = (() => {    if (!menu || !menu.clip) return []
    const picked = Array.isArray(selection?.clipIds) ? selection.clipIds.filter(Boolean) : []
    if (picked.length > 1 && picked.includes(menu.clip.id)) return picked
    return [menu.clip.id]
  })()
  const multiCount = compoundIds.length
  /* 层级上下移动能不能点：与 App 落地时的判断同一份（shared/layers.js） */
  const canMoveUp = Boolean(menu && menu.clip && layersTable.canMoveLayer(clips, menu.clip.id, 1))
  const canMoveDown = Boolean(menu && menu.clip && layersTable.canMoveLayer(clips, menu.clip.id, -1))
  useEffect(() => {
    if (!selectedId) return
    const lane = laneRef.current
    if (!lane) return
    /* 用 ref 读最新片段表：把 `clips` 放进依赖里会让**拖动每一帧都滚一次**
       （拖动时选中不变、但 clips 一直在变），画面会自己抖。 */
    const item = (clipsRef.current || []).find((clip) => clip.id === selectedId)
    if (!item) return
    const left = Number(item.start) * dps
    const right = left + Math.max(18, Number(item.duration) * dps)
    const viewLeft = lane.scrollLeft
    const viewRight = viewLeft + lane.clientWidth
    const pad = 48
    if (left < viewLeft + pad) {
      lane.scrollTo({ left: Math.max(0, left - pad), behavior: 'smooth' })
    } else if (right > viewRight - pad) {
      lane.scrollTo({ left: Math.max(0, right - lane.clientWidth + pad), behavior: 'smooth' })
    }
  }, [selectedId, dps])

  /* ------------------------- Ctrl + 滚轮缩放 ------------------------- */

  /**
   * 为什么用原生监听器而不是 React 的 `onWheel`：
   * React 把 wheel 当被动监听挂到根节点上，里面 `preventDefault()` 是无效的
   * （控制台会报 "Unable to preventDefault inside passive event listener"），
   * 结果就是按住 Ctrl 滚轮会把**整个界面**当成网页缩放掉，而不是只缩放时间线。
   * 所以这里自己挂一个 `{ passive: false }` 的原生监听器。
   */
  useEffect(() => {
    const lane = laneRef.current
    if (!lane || !onZoom) return undefined
    const onWheelZoom = (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      // 步长随当前缩放变：已经放得很大时一小格也要走得远一点，否则手感黏
      const step = zoom >= 2 ? 0.4 : zoom >= 1 ? 0.2 : 0.1
      onZoom(zoom + (event.deltaY < 0 ? step : -step))
    }
    lane.addEventListener('wheel', onWheelZoom, { passive: false })
    return () => lane.removeEventListener('wheel', onWheelZoom)
  }, [onZoom, zoom])

  /* ---------------------------- 右键菜单 ---------------------------- */

  /**
   * 关闭右键菜单。用 `closest('[data-ctxmenu]')` 判断而不是靠事件冒泡被阻断 ——
   * React 的 stopPropagation 能不能拦到 window 上的监听器依赖挂载点，
   * 直接查 DOM 有没有命中菜单更稳。
   */
  useEffect(() => {
    if (!menu) return undefined
    const close = (event) => {
      const target = event && event.target
      if (target && typeof target.closest === 'function' && target.closest('[data-ctxmenu]')) return
      setMenu(null)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const openMenu = (event, clip) => {
    event.preventDefault()
    event.stopPropagation()
    /* 右键点的是多选集里的一员 ⇒ **保留**集合：否则"选了三段 → 右键 → 新建复合片段"
       会退化成只合成一段，而用户看到的三段高亮还在，结果与看到的不符。 */
    const picked = Array.isArray(selection?.clipIds) ? selection.clipIds : []
    if (!(picked.length > 1 && picked.includes(clip.id))) onSelect(clip)
    setMenu({ x: event.clientX, y: event.clientY, clip })
  }

  /**
   * 菜单贴边收进视口。
   *
   * 菜单按"点哪儿弹哪儿"定位，但在时间线靠下/靠右的片段上右键时，
   * 菜单会有一部分**跑到窗口外面**：用户看到的是一个被截断的菜单，
   * 下半截（删除 / 取消）根本点不到 —— Playwright 的报错是
   * `element is outside of the viewport`，真人用户的表现则是"点了没反应"。
   * 菜单越加越长之后这条必然发作，所以在测量之后往上/往左翻一下。
   *
   * 用 `clamped` 标记防止来回抖：只修正一次，之后不再进这个分支。
   */
  const menuRef = useRef(null)
  useEffect(() => {
    if (!menu || menu.clamped) return
    const node = menuRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const overflowX = rect.right > window.innerWidth - 6
    const overflowY = rect.bottom > window.innerHeight - 6
    if (!overflowX && !overflowY) return
    setMenu((current) => {
      if (!current || current.clamped) return current
      return {
        ...current,
        x: overflowX ? Math.max(6, window.innerWidth - rect.width - 8) : current.x,
        y: overflowY ? Math.max(6, window.innerHeight - rect.height - 8) : current.y,
        clamped: true
      }
    })
  }, [menu])

  return (
    <section className={`wb-timeline ${empty ? 'is-empty' : ''} ${tlFull ? 'is-full' : ''}`} data-tl-full={tlFull ? '1' : '0'}>
      {/* 顶缝把手：坐在时间线 6px 上边框上（border 当缝用），不在全屏态出现 */}
      {!tlFull && onResizeHeight && (
        <Splitter
          dir="h"
          which="timeline"
          title="时间线高度"
          onDelta={onResizeHeight}
          onReset={onResetHeight}
          onNudge={onResizeHeight}
        />
      )}
      <div className="wb-tlbar">
        <button type="button" className="btn-undo" onClick={onUndo} disabled={!canUndo} title="撤销（Ctrl+Z）">
          <IconUndo size={16} />
        </button>
        <button type="button" onClick={onRedo} disabled={!canRedo} title="重做（Ctrl+Shift+Z）">
          <IconRedo size={16} />
        </button>
        <button type="button" onClick={() => clips.length && onClear()} disabled={!clips.length} title="清空时间线（Ctrl+Shift+Delete）">
          <IconTrash size={16} />
        </button>
        <button
          type="button"
          onClick={onSplit}
          disabled={!clips.length}
          title="在播放头处分割选中的片段（Ctrl+B）"
        >
          <IconSplit size={16} />
          分割
        </button>

        <span className="wb-sep" />

        {/* 时间区域：有区域时把「对这段能做什么」全部摆出来（不做隐藏菜单）。
            ⚠️ 这一簇**只在有区域时出现** —— 平时挂一排灰着的按钮，
               等于把"还没学会怎么用"的成本提前摊给所有人。 */}
        {shownRegion ? (
          <span className="wb-regionbar" data-regionbar="1">
            <span className="wb-regionbar-label" data-region-label="1">
              {timecode(shownRegion.start, false)} – {timecode(shownRegion.end, false)}
            </span>
            <button
              type="button"
              data-region-op="delete"
              title="删除这段区间，后面的内容整体前移（Shift+Delete）"
              onClick={() => onRegionDelete && onRegionDelete()}
            >
              删除
            </button>
            <button type="button" data-region-op="copy" title="把这段区间里的内容复制下来" onClick={() => onRegionCopy && onRegionCopy()}>
              复制
            </button>
            <button type="button" data-region-op="cut" title="剪切这段区间（复制 + 删除，后面内容前移）" onClick={() => onRegionCut && onRegionCut()}>
              剪切
            </button>
            <button
              type="button"
              data-region-op="paste"
              disabled={!regionClip || !Array.isArray(regionClip.items) || !regionClip.items.length}
              title={
                regionClip && regionClip.items.length
                  ? `粘贴到播放头（${regionClip.items.length} 段 / ${Number(regionClip.span).toFixed(2)} 秒）`
                  : '复制过区间内容之后才能粘贴'
              }
              onClick={() => onRegionPaste && onRegionPaste()}
            >
              粘贴
            </button>
            <button type="button" data-region-op="export" title="只导出这一段区间（打开导出面板）" onClick={() => onRegionExport && onRegionExport()}>
              只导出
            </button>
            <button type="button" data-region-op="clear" title="取消时间区域（片段不受影响）" onClick={() => onRegionClear && onRegionClear()}>
              ×
            </button>
          </span>
        ) : regionClip && Array.isArray(regionClip.items) && regionClip.items.length ? (
          /* 没有区域但剪贴板里有东西：给一个粘度入口，否则"复制完了区域清掉"就没法再粘 */
          <button
            type="button"
            data-region-op="paste"
            title={`粘贴到播放头（${regionClip.items.length} 段 / ${Number(regionClip.span).toFixed(2)} 秒）`}
            onClick={() => onRegionPaste && onRegionPaste()}
          >
            粘贴区域
          </button>
        ) : null}

        <button type="button" onClick={onImport} title="导入素材到媒体库">
          <IconUpload size={16} />
          <IconChevronDown size={12} />
        </button>
        {/* 素材库：切到「素材」标签下 `我的素材` 那一项。
            之前这里接的是 `onImport`（打开导入对话框）—— 名实不符，
            用户想「打开素材库看看」却弹出一个选文件的框。 */}
        <button type="button" title="素材库" onClick={onOpenStock} data-tl="stock">
          <IconLayers size={16} />
        </button>

        <span className="wb-sep" />

        <button
          type="button"
          className={snap ? 'on' : ''}
          onClick={() => onSnap && onSnap(!snap)}
          title={snap ? '已开启吸附（片段两端 / 播放头 / 标记，8px 内自动对齐；按住 Alt 临时关闭）· N' : '已关闭吸附 · N'}
        >
          <IconMagnet size={16} />
        </button>

        <button
          type="button"
          className={linkEnabled ? 'on' : ''}
          onClick={() => onToggleLink && onToggleLink()}
          title={
            linkEnabled
              ? '剪辑联动已开：拖动片段时，同一素材的画面与声音一起移动'
              : '剪辑联动已关：每条片段各走各的（做音画错位时用）'
          }
          aria-pressed={linkEnabled}
          data-tl="link"
        >
          <IconLink size={16} />
        </button>
        <button
          type="button"
          className={markers.length ? 'on' : ''}
          onClick={() => onToggleMarker && onToggleMarker(playhead)}
          title={
            markers.length
              ? `在播放头处打标记（M）· 已有 ${markers.length} 个，右键标记点可删`
              : '在播放头处打标记（M）'
          }
          aria-pressed={markers.length > 0}
          data-tl="marker"
        >
          <IconFlag size={16} />
        </button>
        <button
          type="button"
          onClick={() => onStepMarker && onStepMarker(-1)}
          disabled={!markers.length}
          title="跳到上一个标记（Ctrl+←）"
          data-tl="marker-prev"
        >
          <IconSkipBack size={14} />
        </button>
        <button
          type="button"
          onClick={() => onStepMarker && onStepMarker(1)}
          disabled={!markers.length}
          title="跳到下一个标记（Ctrl+→）"
          data-tl="marker-next"
        >
          <IconSkipForward size={14} />
        </button>

        <span className="wb-sep" />

        {/* 录音配音：录完落在**播放头**处的音频轨上（"对着画面说"） */}
        <button
          type="button"
          onClick={() => onOpenRecorder && onOpenRecorder()}
          title="录音配音：用麦克风录一段，落在播放头处的音频轨上"
          data-tl="record"
        >
          <IconMic size={16} />
        </button>

        <span className="wb-grow" />

        {/* 这一簇原来是「画着好看」的：四个按钮里三个连 onClick 都没有、
            一个接错成了导入。现在逐个接上真实去处，并且加上 data-tl 便于 E2E 点名。 */}
        <button
          type="button"
          className={muted ? 'on' : ''}
          onClick={toggleMute}
          title={muted ? `已静音（原音量 ${unmuteRef.current}%）· 点击恢复` : `静音时间线（当前 ${volume ?? 100}%）`}
          aria-pressed={muted}
          data-tl="mute"
        >
          {muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
        </button>
        {/* 音量滑杆（参考在时间线工具栏右端：白杆白块）。它和静音键共用同一份
            App 级 volume 状态 —— 静音打 0、滑杆归 0，两边看到的是同一个数。 */}
        <input
          className="wb-vol"
          type="range"
          min={0}
          max={100}
          step={1}
          value={Number.isFinite(Number(volume)) ? Number(volume) : 100}
          onChange={(event) => onVolume && onVolume(Number(event.target.value))}
          aria-label="时间线音量"
          title={`时间线音量 ${Number.isFinite(Number(volume)) ? Number(volume) : 100}%`}
        />
        <button type="button" className="on" title="字幕" onClick={onOpenSubtitle} data-tl="subtitle">
          <IconCaption size={16} />
        </button>
        <button type="button" title="时间线设置" onClick={onOpenSettings} data-tl="settings">
          <IconSettings size={16} />
        </button>

        <span className="wb-sep" />

        <button type="button" onClick={() => onZoom(Math.max(0.3, Number((zoom - 0.1).toFixed(2))))} title="缩小（Ctrl+-）">
          <IconZoomOut size={14} />
        </button>
        <input
          type="range"
          min={0.3}
          max={4}
          step={0.1}
          value={zoom}
          onChange={(event) => onZoom(Number(event.target.value))}
          aria-label="时间线缩放"
        />
        <button type="button" onClick={() => onZoom(Math.min(4, Number((zoom + 0.1).toFixed(2))))} title="放大（Ctrl+=，或按住 Ctrl 滚轮）">
          <IconZoomIn size={14} />
        </button>
        <button
          type="button"
          className={tlFull ? 'on' : ''}
          onClick={() => setTlFull(!tlFull)}
          title={tlFull ? '退出全屏时间线（Esc）' : '全屏时间线（把工作台让给时间线）'}
          aria-pressed={tlFull}
          data-tl="full"
        >
          <IconFullscreen size={14} />
        </button>
      </div>

      <div className="wb-tlbody">
        <div className="wb-tllabels">
          {empty ? (
            <div className="wb-tlcard" title="时间线工具">
              <IconSplit size={14} />
              <IconCaption size={14} />
              <IconVolumeOff size={14} />
            </div>
          ) : (
            TRACKS.map((track) => {
            const isMuted = mutedSet.has(track.key)
            const isHidden = hiddenSet.has(track.key)
            const isLocked = lockedSet.has(track.key)
            const isSolo = soloSet.has(track.key)
            /* 只有能出声的轨才给「喇叭 / 独奏」：字幕轨给了也是装饰（点了没反应） */
            const audible = AUDIO_CAPABLE.has(track.key)
            /* 轨类型图标（参考形制：视频▭ / 音频♪ / 字幕 Tt）。
               ⚠️ 音频轨不给「眼」—— 参考的音频轨没有隐藏键（音频没有画面，隐藏无意义），
               只有 视频轨/叠加轨/字幕轨 有。 */
            const TypeIcon = track.icon === 'audio' ? IconMusic : track.icon === 'text' ? IconCaption : IconMedia
            return (
              <div className="wb-tllabel" key={track.key} data-trackhead={track.key}>
                <span className="wb-tltype" title={track.label}>
                  <TypeIcon size={14} />
                </span>
                {/* 顺序照参考客户端的轨道头：锁 → 眼 → 喇叭 → 独奏 */}
                <span className="wb-tllabel-tools">
                  {/* 锁定：拦拖动/修剪/删除/分割这些结构性编辑，不拦播放 */}
                  <button
                    type="button"
                    className={isLocked ? 'off' : ''}
                    title={isLocked ? '解除锁定（允许编辑该轨片段）' : '锁定该轨（片段不可拖动 / 修剪 / 删除）'}
                    aria-pressed={isLocked}
                    data-tracktoggle={`${track.key}:lock`}
                    onClick={() => toggleTrack(track.key, 'locked')}
                  >
                    <IconLock size={12} />
                  </button>
                  {track.key !== 'audio' ? (
                    <button
                      type="button"
                      className={isHidden ? 'off' : ''}
                      title={isHidden ? '显示该轨（预览与导出同时生效）' : '隐藏该轨（预览与导出同时生效）'}
                      aria-pressed={isHidden}
                      data-tracktoggle={`${track.key}:hide`}
                      onClick={() => toggleTrack(track.key, 'hidden')}
                    >
                      {isHidden ? <IconEyeOff size={12} /> : <IconEye size={12} />}
                    </button>
                  ) : null}
                  {audible ? (
                    <button
                      type="button"
                      className={isMuted ? 'off' : ''}
                      title={isMuted ? '取消静音该轨（预览与导出同时生效）' : '静音该轨（预览与导出同时生效）'}
                      aria-pressed={isMuted}
                      data-tracktoggle={`${track.key}:mute`}
                      onClick={() => toggleTrack(track.key, 'muted')}
                    >
                      {isMuted ? <IconVolumeOff size={12} /> : <IconVolume size={12} />}
                    </button>
                  ) : null}
                  {audible ? (
                    /* 独奏：只让这一条轨出声，其余能出声的轨全部静音（预览与导出同口径） */
                    <button
                      type="button"
                      className={`solo${isSolo ? ' on' : ''}`}
                      title={isSolo ? '取消独奏（恢复其它轨的声音）' : '独奏该轨（只让这一轨出声）'}
                      aria-pressed={isSolo}
                      data-tracktoggle={`${track.key}:solo`}
                      onClick={() => toggleTrack(track.key, 'solo')}
                    >
                      S
                    </button>
                  ) : null}
                </span>
              </div>
            )
            })
          )}
        </div>

        <div
          className="wb-tltracks"
          ref={laneRef}
          /* pointerdown 而不是 click：见 seekFromEvent 上方的说明 —— click 拦不住，
             会让"点片段"顺带把播放头挪到鼠标位置 */
          onPointerDown={seekFromEvent}
          data-tracks="1"
          onDragOver={(event) => {
            if (!onDropAsset) return
            // 不 preventDefault 浏览器就认为这里不接受拖放，drop 事件根本不会来
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(event) => {
            if (!onDropAsset) return
            event.preventDefault()
            const assetId = event.dataTransfer.getData('application/x-yjai-asset')
            if (!assetId) return
            const lane = laneRef.current
            if (!lane) return
            const rect = lane.getBoundingClientRect()
            const raw = Math.max(0, (event.clientX - rect.left + lane.scrollLeft) / dps)
            // 落在哪条轨就进哪条轨；空态没有轨道行，默认进视频轨
            const hit = event.target.closest && event.target.closest('[data-lane]')
            const track = (hit && hit.dataset.lane) || 'video'
            onDropAsset(assetId, track, snapSeconds(raw, null))
          }}
        >
          <div className="wb-tlruler" style={{ width }} onPointerDown={rulerPointerDown} data-ruler="1">
            {ticks.map((second) => (
              <span className="tick" key={second} style={{ left: second * dps }}>
                {timecode(second, false)}
              </span>
            ))}
            {/* 标记点画在刻度尺上（不是轨道上）：它属于"时间"而不是"某条轨"。
                点一下 → 播放头过来；右键 → 删掉。两种操作都必须有，
                否则打了标记只能靠"再点一次同一个位置"取消，位置稍偏就删不掉。 */}
            {/* 时间区域：在标尺上铺一条半透明带子，两端各一个把手。
                把手必须**整只在带子里**（不能用负 margin 套到外面）——
                和预览框手柄踩过的是同一个坑：跨界的那一半被父容器裁掉，
                浏览器不给被裁的像素派事件，于是"拖了半天，区域纹丝不动"。 */}
            {shownRegion ? (
              <div
                className="wb-region"
                data-region="1"
                data-region-start={shownRegion.start.toFixed(3)}
                data-region-end={shownRegion.end.toFixed(3)}
                style={{ left: shownRegion.start * dps, width: Math.max(3, (shownRegion.end - shownRegion.start) * dps) }}
                title={`时间区域 ${timecode(shownRegion.start, false)} – ${timecode(shownRegion.end, false)}（拖两端调整）`}
              >
                <button
                  type="button"
                  className="wb-region-edge is-start"
                  data-region-edge="start"
                  title="拖我调整区域起点"
                  onPointerDown={(event) => startRegionDrag(event, shownRegion.end)}
                />
                <button
                  type="button"
                  className="wb-region-edge is-end"
                  data-region-edge="end"
                  title="拖我调整区域终点"
                  onPointerDown={(event) => startRegionDrag(event, shownRegion.start)}
                />
              </div>
            ) : null}
            {/* 只标了入点（按了 I 还没按 O）：画一根竖线，并明说下一步按什么 */}
            {region && (region.end === null || region.end === undefined) ? (
              <div
                className="wb-region-mark"
                data-region-open="1"
                style={{ left: Number(region.start) * dps }}
                title={`入点 ${timecode(Number(region.start), false)} · 把播放头移到结束处按 O 标出点`}
              />
            ) : null}
            {markers.map((at, index) => (
              <button
                type="button"
                key={`mark-${index}-${at}`}
                className="wb-mark"
                data-mark={index}
                style={{ left: at * dps }}
                title={`标记 ${index + 1} · ${timecode(at, false)}（点：跳到这里 / 右键：删除）`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onSeek(at)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onToggleMarker && onToggleMarker(at)
                }}
              >
                <i />
              </button>
            ))}
          </div>

          {TRACKS.map((track) => {
            const laneClips = clips.filter((item) => item.track === track.key)
            return (
              <div
                className={`wb-tllane ${hiddenSet.has(track.key) ? 'disabled' : ''} ${lockedSet.has(track.key) ? 'is-locked' : ''}`}
                data-lane={track.key}
                key={track.key}
                style={{ width, '--beat': `${dps}px` }}
              >
                {laneClips.map((clip) => (
                  <button
                    type="button"
                    key={clip.id}
                    className={`clip ${track.tone || ''} ${selection?.clipId === clip.id ? 'selected' : ''} ${
                      multiSet.has(clip.id) ? 'multi' : ''
                    } ${clip.enabled === false ? 'is-disabled' : ''} ${
                      clip.kind === 'compound' ? 'is-compound' : ''
                    } ${clip.kind === 'multicam' ? 'is-multicam' : ''} ${
                      lockedSet.has(track.key) ? 'in-locked' : ''}`}
                    style={{ left: clip.start * dps, width: Math.max(18, clip.duration * dps) }}
                    onPointerDown={(event) => beginDrag(event, clip)}
                    onPointerMove={(event) => moveDrag(event, clip)}
                    onPointerUp={(event) => endDrag(event, clip)}
                    onPointerCancel={() => endDrag(null, clip)}
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      // 锁定轨不让双击删除：删除是结构性编辑
                      if (trackLocked(clip) || clip.enabled === false) return
                      onRemove(clip.id)
                    }}
                    onContextMenu={(event) => openMenu(event, clip)}
                    title={`${clip.name}｜拖动改起点 · 拖两端修剪 · 单击定位播放头 · 右键更多 · 双击删除`}
                    data-clip={clip.id}
                    data-disabled={clip.enabled === false ? '1' : '0'}
                    /* 画面层级（自由层级）：叠加轨上才有多层可言，把层号挂出来，
                       闸门才能断言"菜单点了之后层号真的变了"（而不是只看画面） */
                    data-clip-z={track.key === 'overlay' ? String(layersTable.readZ(clip)) : undefined}
                    /* 有可视化素材时才打这个标记：CSS 用它决定要不要退回原来的装饰条 */
                    data-visual={
                      track.key === 'text'
                        ? clip.text || clip.name
                          ? '1'
                          : '0'
                        : clip.url
                          ? '1'
                          : '0'
                    }
                  >
                    <span
                      className="clip-trim start"
                      role="separator"
                      aria-label="修剪起点"
                      title="拖动修剪起点（同时移动源入点）"
                      onPointerDown={(event) => beginTrim(event, clip, 'start')}
                      onPointerMove={(event) => moveTrim(event, clip)}
                      onPointerUp={endTrim}
                      onPointerCancel={endTrim}
                    />
                    <span
                      className="clip-trim end"
                      role="separator"
                      aria-label="修剪终点"
                      title="拖动修剪终点"
                      onPointerDown={(event) => beginTrim(event, clip, 'end')}
                      onPointerMove={(event) => moveTrim(event, clip)}
                      onPointerUp={endTrim}
                      onPointerCancel={endTrim}
                    />
                    {/* 片段本体：视频轨抽帧 / 音频轨波形 / 字幕轨文字。
                        整块 pointer-events:none，否则会盖住拖动与两端修剪。 */}
                    <span className="clip-body" aria-hidden="true">
                      {clip.kind === 'multicam' ? (
                        /* 多机位同样没有单一 src：展开后它是一串片段，本体不参与解码。
                           这里把"几路机位、切了几刀"直接写在轨道上 —— 否则一段
                           和普通视频长得一模一样的方块，用户没法从轨道上看出它是什么。 */
                        <span className="clip-chain" data-multicam-body="1">
                          {(clip.multicam?.angles || []).length} 路 ·{' '}
                          {Array.isArray(clip.multicam?.cuts) ? clip.multicam.cuts.length : 1} 段
                        </span>
                      ) : clip.kind === 'compound' ? (
                        /* 复合片段没有单一 src 可抽帧/画波形，这里写清"它是个容器"——
                           留空会让人以为素材丢了（见下面 clip-compound 的样式） */
                        <span className="clip-compound" data-compound-body="1">
                          内部时间线
                        </span>
                      ) : track.key === 'video' || track.key === 'overlay' ? (
                        <>
                          {clip.kind === 'image' ? (
                            <ClipStill url={clip.url} />
                          ) : (
                            <ClipFilmstrip
                              url={clip.url}
                              offset={clip.offset || 0}
                              duration={clip.duration}
                              count={stripCount(clip.duration * dps)}
                            />
                          )}
                          {/* 片段自带的声音：贴底一条橙色波形（参考客户端形制）。
                              只画片段用掉的那一截 —— 入点与时长直接喂给 ffmpeg 的 -ss/-t。
                              图片片段没有音轨，画不出来就自动不画。 */}
                          <ClipAudioWave
                            url={clip.url}
                            offset={clip.offset || 0}
                            duration={clip.duration}
                          />
                        </>
                      ) : track.key === 'audio' ? (
                        <>
                          <ClipWaveform url={clip.url} />
                          {/* 音量包络线：高度直接映射片段音量（0% 贴底、200% 顶格、
                              默认 100% 居中）。它是真实字段的显示，不是装饰 ——
                              在属性面板拖音量，这根线当场动。 */}
                          <span
                            className="clip-env"
                            style={{ top: `${100 - (Number.isFinite(Number(clip.gain)) ? Number(clip.gain) : 100) / 2}%` }}
                            data-env={Number.isFinite(Number(clip.gain)) ? Number(clip.gain) : 100}
                          />
                        </>
                      ) : (
                        <ClipText text={clip.text || clip.name} />
                      )}
                    </span>
                    <span className="clip-inner">
                      {/* 头部形制照参考：名称在前、竖线分隔、帧号时长在后。
                          原先的「图标 + 时长 + 名称」顺序信息密度低，
                          名称永远被时长挤到最右，长名字直接看不见。 */}
                      <span className="clip-name">{clip.name}</span>
                      <span className="clip-hsep" aria-hidden="true" />
                      <span className="clip-dur mono">{timecodeFrames(clip.duration)}</span>
                      {/* 多机位角标：路数必须读得出来（1 路的多机位根本建不出来，见 App） */}
                      {clip.kind === 'multicam' ? (
                        <span
                          className="clip-badge"
                          data-clip-multicam={(clip.multicam?.angles || []).length}
                          title={`多机位：${(clip.multicam?.angles || []).length} 路机位，${Array.isArray(clip.multicam?.cuts) ? clip.multicam.cuts.length : 1} 个切换段（右键可解除）`}
                        >
                          多机位 · {(clip.multicam?.angles || []).length} 路
                        </span>
                      ) : null}
                      {/* 复合片段角标：内部有几段、它是"一个片段"这件事必须在轨道上读得出来，
                          否则用户会以为选中的那几段凭空消失了（其实是收进去了） */}
                      {clip.kind === 'compound' ? (
                        <span
                          className="clip-badge"
                          data-clip-compound={Array.isArray(clip.compound?.children) ? clip.compound.children.length : 0}
                          title={`复合片段：内部 ${Array.isArray(clip.compound?.children) ? clip.compound.children.length : 0} 段（右键可解除）`}
                        >
                          复合 · {Array.isArray(clip.compound?.children) ? clip.compound.children.length : 0} 段
                        </span>
                      ) : null}
                      {/* 停用片段的角标：光变灰不够显式，模板里要能读出"这段为什么不出片" */}
                      {clip.enabled === false ? (
                        <span className="clip-badge" data-clip-disabled="1">
                          已停用
                        </span>
                      ) : null}
                      {/* 调色角标：不带滤镜的片段不显示，避免每段都挂个"原片"噪声 */}
                      {!isNoopFilter(clip.filter) ? (
                        <span className="clip-badge" data-clip-filter={clip.filter} title={`调色：${filterDef(clip.filter).label}`}>
                          {filterDef(clip.filter).label}
                        </span>
                      ) : null}
                      {/* 画中画角标：位置 + 尺寸直接写在轨道上。
                          少了它，改完锚点回到时间线看不出变没变（只有预览里能看出，
                          而预览还得正好停在这一段上）。 */}
                      {track.key === 'overlay' ? (
                        <span className="clip-badge" data-clip-pip={clip.pip?.anchor || 'right-bottom'}>
                          {pipAnchor(clip.pip?.anchor).label} {Math.round(clip.pip?.size ?? 30)}%
                        </span>
                      ) : null}
                      {/* 倍速角标：原速不显示（每段都挂个"1x"只会变成噪声）。
                          少了它，改完倍速回到时间线看不出变没变 ——
                          而"时间线占位变短了"这件事光看长度也分不清是修剪还是变速。 */}
                      {readCurve(clip) ? (
                        /* 曲线变速的角标写「曲线 + 平均值」而不是一个裸数字：
                           曲线片段在时间线上只占一个方框，用户看不出它中段慢到什么程度，
                           而一个 0.80x 的数字会让人以为"整段都是 0.80x"（不是）。 */
                        <span
                          className="clip-badge"
                          data-clip-speed="curve"
                          title={`曲线变速：平均 ${clipSpeed(clip)}x，时间线占 ${Number(clip.duration).toFixed(2)}s，吃掉源素材 ${(Number(clip.duration) * clipSpeed(clip)).toFixed(2)}s`}
                        >
                          曲线 {clipSpeed(clip)}x
                        </span>
                      ) : Math.abs(clipSpeed(clip) - 1) > 0.001 ? (
                        <span
                          className="clip-badge"
                          data-clip-speed={clipSpeed(clip)}
                          title={`倍速 ${clipSpeed(clip)}x：时间线占 ${Number(clip.duration).toFixed(2)}s，吃掉源素材 ${(Number(clip.duration) * clipSpeed(clip)).toFixed(2)}s`}
                        >
                          {clipSpeed(clip)}x
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}

                {/* 转场角标：画在**用户看到的那个接缝**上（原始坐标，不随结算移动）。
                    只画真的会生效的（同轨、首尾相接），否则会出现"看着有转场、成片里没有"。 */}
                {track.key === 'video'
                  ? laneMarkers.map((marker) => (
                      <span
                        key={marker.id}
                        className="clip-transition"
                        data-transition-marker={marker.key}
                        style={{ left: marker.at * dps }}
                        title={`转场「${marker.label}」· ${marker.duration.toFixed(1)}s（会占用成片时长）`}
                      >
                        {/* 形制照参考：接缝上方一枚带文字的小圆角 chip，
                            光一个图标读不出是哪种转场、多长 */}
                        {marker.label} {marker.duration.toFixed(1)}s
                      </span>
                    ))
                  : null}
              </div>
            )
          })}

          {/* 吸附辅助线：拖动片段时吸中了某个时间点就在这里竖一条。
              与播放头同处一层（都在滚动内容里），所以跟着缩放与滚动走。 */}
          {snapLine !== null ? (
            <div
              className="wb-snapline"
              data-snap-line={Number(snapLine).toFixed(3)}
              style={{ left: snapLine * dps }}
            />
          ) : null}

          <div className="playhead" style={{ left: playhead * dps }} />

          {!clips.length ? (
            <div className="wb-tlempty">
              {/* 虚线框用 SVG 描边画（节距 9 实 / 6.5 空），不用 border-style:dashed。
                  Chromium 在 1px 边框上只能画 3 实 / 2 空的密点线，与参考的"长虚线"不是一回事。
                  rx 取 15.5 是为了和外层 border-radius:16px 同心（描边以路径为中心，路径内缩 0.5px）。 */}
              <svg className="wb-tlempty-dash" aria-hidden="true">
                <rect x="0" y="0" width="100%" height="100%" rx="15.5" ry="15.5" />
              </svg>
              <button className="wb-import" type="button" onClick={onImport}>
                <IconAddSquare size={16} />
                导入
              </button>
              <span>拖拽图片、视频到这里，开始剪辑吧~</span>
            </div>
          ) : null}
        </div>
      </div>

      {/* 右键菜单挂在时间线根节点上：用 fixed 定位，不受轨道区滚动影响 */}
      {menu ? (
        <div
          className="wb-ctxmenu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          data-ctxmenu="1"
          role="menu"
        >
          <div className="wb-ctxmenu-title" title={menu.clip.name}>
            {menu.clip.name}
          </div>
          {/* 停用：片段留在原地（时长/位置都不动），只是不参与预览与导出。
              与删除的区别：停用可逆、可随时回来，是排片时的"先关掉这一段"。 */}
          <button
            type="button"
            onClick={() => {
              if (onToggleClipEnabled) onToggleClipEnabled(menu.clip.id)
              setMenu(null)
            }}
          >
            {menu.clip.enabled === false ? '启用片段' : '停用片段'}
            <kbd>V</kbd>
          </button>
          <button
            type="button"
            disabled={trackLocked(menu.clip)}
            onClick={() => {
              // 分割失败时 splitClipAt 自己会 toast 说明原因（播放头不在片段内等），
              // 这里不用再判断返回值，菜单一律收起
              if (onSplitClipAt) onSplitClipAt(menu.clip.id)
              setMenu(null)
            }}
          >
            在播放头处分割
            <kbd>Ctrl+B</kbd>
          </button>
          <button
            type="button"
            disabled={trackLocked(menu.clip)}
            onClick={() => {
              // 先记快照再改，撤销时才回得到移动之前
              if (onSnapshot) onSnapshot()
              if (onDragClip) onDragClip(menu.clip.id, { start: Math.max(0, playhead) })
              setMenu(null)
            }}
          >
            起点移到播放头
          </button>
          {/* 复合片段：把选中的几段收进一个片段（内部时间线），或者把复合片段拆回来。
              位置放在「替换片段」之前：它改的是"时间线上有几段"，与替换（改源）不是一类。 */}
          <button
            type="button"
            disabled={trackLocked(menu.clip)}
            data-ctx="compound"
            title={
              multiCount > 1
                ? `把选中的 ${multiCount} 段收进一个复合片段`
                : '把这一段收进复合片段（Ctrl + 点选可先多选几段）'
            }
            onClick={() => {
              if (onCreateCompound) onCreateCompound(compoundIds)
              setMenu(null)
            }}
          >
            {multiCount > 1 ? `新建复合片段（${multiCount} 段）` : '新建复合片段'}
          </button>
          {menu.clip.kind === 'compound' ? (
            <button
              type="button"
              disabled={trackLocked(menu.clip)}
              data-ctx="ungroup"
              title="把复合片段内部的片段还原到时间线上（按当前裁剪与倍速换算）"
              onClick={() => {
                if (onUngroupClip) onUngroupClip(menu.clip.id)
                setMenu(null)
              }}
            >
              解除复合片段
            </button>
          ) : null}
          {/* 多机位：把选中的几段**画面**摆成同一时刻的多路角度。
              与复合片段的区别写在菜单文案里：复合是"收起来"，多机位是"同一时刻挑一路"。 */}
          <button
            type="button"
            disabled={trackLocked(menu.clip) || multiCount < 2}
            data-ctx="multicam"
            title={
              multiCount > 1
                ? `把选中的 ${multiCount} 段当作同一时刻的 ${multiCount} 路机位（按当前时间线位置对齐）`
                : '多机位至少要选两段画面素材（Ctrl + 点选可多选）'
            }
            onClick={() => {
              if (onCreateMulticam) onCreateMulticam(compoundIds)
              setMenu(null)
            }}
          >
            {multiCount > 1 ? `新建多机位（${multiCount} 路）` : '新建多机位（先多选两段）'}
          </button>
          {menu.clip.kind === 'multicam' ? (
            <button
              type="button"
              disabled={trackLocked(menu.clip)}
              data-ctx="ungroup-multicam"
              title="按当前切换结果摊回时间线：每段画面一个片段 + 一条取声片段"
              onClick={() => {
                if (onUngroupMulticam) onUngroupMulticam(menu.clip.id)
                setMenu(null)
              }}
            >
              解除多机位
            </button>
          ) : null}
          {/* 场景切换检测：把这一段按画面变化自动切成多段。
              只有"真的有画面"的素材才给（文字/图片没有场景可言），
              倒放与曲线变速由 App 侧拒绝并说明原因（换算口径对不齐）。 */}
          <button
            type="button"
            data-ctx="scenes"
            disabled={
              trackLocked(menu.clip) ||
              menu.clip.kind === 'text' ||
              menu.clip.kind === 'image' ||
              !menu.clip.url ||
              menu.clip.reverse === true
            }
            title={
              menu.clip.reverse === true
                ? '倒放片段不做自动切点'
                : menu.clip.kind === 'text' || menu.clip.kind === 'image' || !menu.clip.url
                  ? '只有视频素材才有场景切换'
                  : '用画面变化检测切点，自动把这一段切成多段'
            }
            onClick={() => {
              if (onSplitByScenes) onSplitByScenes(menu.clip.id)
              setMenu(null)
            }}
          >
            按场景分割
          </button>
          <span className="wb-ctxmenu-sep" />
          {/* 画面层级（自由层级）：只对**叠加轨**有意义 —— 主轨是一条顺序链
              （后一段接在前一段后面播放），"谁压住谁"在那里不是一个可选项。
              两段画中画完全重叠时，这条就是唯一能决定上下关系的入口。 */}
          <span className="wb-ctxmenu-sep" />
          <button
            type="button"
            data-ctx="layer-up"
            disabled={menu.clip.track !== 'overlay' || !canMoveUp}
            title={
              menu.clip.track !== 'overlay'
                ? '只有叠加轨（画中画）才有上下层之分'
                : canMoveUp
                  ? '把这一层压到上面那一层之上'
                  : '已经在最上层了'
            }
            onClick={() => {
              if (onMoveLayer) onMoveLayer(menu.clip.id, 1)
              setMenu(null)
            }}
          >
            上移一层
          </button>
          <button
            type="button"
            data-ctx="layer-down"
            disabled={menu.clip.track !== 'overlay' || !canMoveDown}
            title={
              menu.clip.track !== 'overlay'
                ? '只有叠加轨（画中画）才有上下层之分'
                : canMoveDown
                  ? '把这一层压到下面那一层之下'
                  : '已经在最下层了'
            }
            onClick={() => {
              if (onMoveLayer) onMoveLayer(menu.clip.id, -1)
              setMenu(null)
            }}
          >
            下移一层
          </button>
          {/* 替换片段：换**源**、不动位置 —— 会弹系统文件选择框，
              锁定的轨道不能换（换了等于绕过了锁）。 */}
          <button
            type="button"
            disabled={trackLocked(menu.clip)}
            data-ctx="replace"
            onClick={() => {
              if (onReplaceClip) onReplaceClip(menu.clip.id)
              setMenu(null)
            }}
          >
            替换片段
          </button>
          <span className="wb-ctxmenu-sep" />
          {/* 本地文件才谈得上"所在位置"：生成类素材是 http 链接，没有文件夹可去 */}
          {menu.clip.path ? (
            <button
              type="button"
              onClick={() => {
                if (onRevealClip) onRevealClip(menu.clip)
                setMenu(null)
              }}
            >
              打开文件所在位置
            </button>
          ) : null}
          <span className="wb-ctxmenu-sep" />
          <button
            type="button"
            className="danger"
            disabled={trackLocked(menu.clip)}
            onClick={() => {
              onRemove(menu.clip.id)
              setMenu(null)
            }}
          >
            删除片段
            <kbd>Delete</kbd>
          </button>
          <button type="button" onClick={() => setMenu(null)}>
            取消
            <kbd>Esc</kbd>
          </button>
        </div>
      ) : null}
    </section>
  )
}
