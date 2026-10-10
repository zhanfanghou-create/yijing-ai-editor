import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconAddSquare,
  IconCaption,
  IconChevronDown,
  IconEye,
  IconEyeOff,
  IconFullscreen,
  IconLayers,
  IconLock,
  IconMagnet,
  IconMedia,
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
import { clipSpeed, trimPatch } from '../trim.js'
import { pipAnchor } from '../pip.js'
import { effectiveTransitions, filterDef, isNoopFilter } from '../looks.js'
import { ClipAudioWave, ClipFilmstrip, ClipStill, ClipText, ClipWaveform, stripCount } from '../clipVisuals.jsx'
import Splitter from './Splitter.jsx'

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
  onSnapshot,
  onDropAsset,
  /* 下面这几个是「工具栏右侧那一簇」的去处。
     它们**必须**由 App 传进来，不能让工具栏自己编一个"看起来在工作"的行为 ——
     这里原来有 6 个按钮是死的（4 个连 onClick 都没有，2 个点了去开导入对话框），
     逐像素比对和全绿闸门都发现不了：按钮画得对、位置对、hover 也对。
     见 tools/check-dead-buttons.mjs。 */
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
  /* 替换片段的素材：要弹系统文件选择框 + 探测新素材时长，只能由 App 落地 */
  onReplaceClip
}) {
  const laneRef = useRef(null)
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

  const seekFromEvent = (event) => {
    if (event.button !== undefined && event.button !== 0) return
    seekToSecondsFromClientX(event.clientX)
  }

  /* --------------------------- 片段拖动 --------------------------- */

  const SNAP_SECONDS = 0.25

  const pointerToSeconds = (clientX) => {
    const lane = laneRef.current
    if (!lane) return 0
    const rect = lane.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left + lane.scrollLeft) / dps)
  }

  /** 吸附：把秒数对齐到 0.25 秒网格，或对齐到其它片段的边缘 */
  const snapSeconds = (raw, excludeId) => {
    const edges = [0, playhead]
    clips.forEach((item) => {
      if (item.id === excludeId) return
      edges.push(item.start, item.start + item.duration)
    })
    if (!snap) return raw
    let best = raw
    let bestGap = SNAP_SECONDS
    edges.forEach((edge) => {
      const gap = Math.abs(edge - raw)
      if (gap < bestGap) {
        bestGap = gap
        best = edge
      }
    })
    return Math.max(0, best)
  }

  const beginDrag = (event, clip) => {
    event.stopPropagation()
    // 锁定轨只拦编辑不拦选中：点一下还能看属性，但不能拖走
    if (trackLocked(clip)) {
      onSelect(clip)
      return
    }
    // 拖动是一串高频改动，只在按下时记一次快照，撤销时才不会一步一停
    if (onSnapshot) onSnapshot()
    dragRef.current = {
      id: clip.id,
      grabOffset: pointerToSeconds(event.clientX) - clip.start,
      moved: false
    }
    onSelect(clip)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveDrag = (event, clip) => {
    const drag = dragRef.current
    if (!drag || drag.id !== clip.id || !onDragClip) return
    const raw = pointerToSeconds(event.clientX) - drag.grabOffset
    const next = snapSeconds(raw, clip.id)
    if (Math.abs(next - clip.start) < 0.001) return
    drag.moved = true
    onDragClip(clip.id, { start: next })
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
    if (!drag || drag.id !== clip.id || drag.moved) return
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
    const snapped = snapSeconds(at, clip.id)
    const patch = trimPatch(clip, trim.edge, snapped)
    if (patch) onDragClip(clip.id, patch)
  }

  const endTrim = () => {
    trimRef.current = null
  }

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
    onSelect(clip)
    setMenu({ x: event.clientX, y: event.clientY, clip })
  }

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
          title={snap ? '已开启吸附（0.25 秒 / 片段边缘）· N' : '已关闭吸附 · N'}
        >
          <IconMagnet size={16} />
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
          <IconZoomOut size={15} />
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
          <IconZoomIn size={15} />
        </button>
        <button
          type="button"
          className={tlFull ? 'on' : ''}
          onClick={() => setTlFull(!tlFull)}
          title={tlFull ? '退出全屏时间线（Esc）' : '全屏时间线（把工作台让给时间线）'}
          aria-pressed={tlFull}
          data-tl="full"
        >
          <IconFullscreen size={15} />
        </button>
      </div>

      <div className="wb-tlbody">
        <div className="wb-tllabels">
          {empty ? (
            <div className="wb-tlcard" title="时间线工具">
              <IconSplit size={15} />
              <IconCaption size={15} />
              <IconVolumeOff size={15} />
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
                  <TypeIcon size={15} />
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
          <div className="wb-tlruler" style={{ width }}>
            {ticks.map((second) => (
              <span className="tick" key={second} style={{ left: second * dps }}>
                {timecode(second, false)}
              </span>
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
                      clip.enabled === false ? 'is-disabled' : ''
                    } ${lockedSet.has(track.key) ? 'in-locked' : ''}`}
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
                      {track.key === 'video' || track.key === 'overlay' ? (
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
                      {Math.abs(clipSpeed(clip) - 1) > 0.001 ? (
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
