/**
 * 艺镜AI剪辑 · 应用外壳
 *
 * 这个文件负责三件事：
 *   1. 工作区状态（媒体库、时间线片段、预览选择、播放头）
 *   2. 草稿持久化与撤销 / 重做
 *   3. 把各面板拼起来
 *
 * 纯本地单机：素材来自用户导入，成片由本机 ffmpeg 导出。
 * 不联网、无账号、无后端服务 —— 所有数据只落在本机。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  appInfo, getSetting, setSetting,
  pickMedia, statMedia, pathForFile,
  pickFonts, allowFontPaths,
  listDrafts, saveDraft, loadDraft, removeDraft
} from './platform.js'
/* 自定义字体：注册进 document.fonts（预览靠家族名，导出靠片段上的字体路径） */
import { registerFonts } from './fonts.js'
import { localAssetsFrom, probeMedia } from './assets.js'
import { compositeAt, effectiveClips } from './composite.js'
import { PIP_DEFAULT_ANCHOR, PIP_DEFAULT_SIZE, pipAnchor } from './pip.js'
import { textStyleDef } from './textStyles.js'
import {
  EPSILON,
  MIN_CLIP_SECONDS,
  clipSpeed,
  curveSourceTime,
  linkMovePatches,
  readCurve,
  replacePatch,
  speedPatch
} from './trim.js'
/* 时间线标记（纯逻辑，见 markers.js 的说明：它不进成片，所以只在渲染层闭环） */
import { markerIndexAt, normalizeMarkers, stepMarker } from './markers.js'
/* 时间区域：删除 / 复制 / 剪切 / 粘贴 / 只导出区间。
   纯逻辑在 shared/region.js —— 导出侧（主进程）用的是**同一份**，
   否则"预览里删掉的区间范围"与"成片里删掉的范围"会差一点点，而且谁都不报错。 */
import {
  copyRegion as copyRegionOf,
  normalizeRegion,
  pasteRegion as pasteRegionAt,
  regionSpan,
  removeRegion
} from '../shared/region.js'
import { timecode, useToast } from './ui.jsx'
/* 画面层级（自由层级）：比较与"上移/下移"的算术，导出侧用的是同一份 */
import * as layersTable from '../shared/layers.js'
/* 场景切换检测：解析与"源秒 → 时间线秒"的换算，与主进程同一份 */
import * as scenesTable from '../shared/scenes.js'
/* 预览画质 / 代理：档位表与代理文件名，主进程用的是同一份（导出永远用原片） */
import * as proxyTable from '../shared/proxy.js'
/* 录音配音：麦克风在渲染层采，落盘在主进程（recording:save） */
import Recorder from './components/Recorder.jsx'
/** 画面比例真源（与导出共用同一份表） */
import { DEFAULT_ASPECT, normalizeAspect } from '../shared/aspect.js'
/** 复合片段：新建 / 展开 / 解除。展开这一支是预览与导出**同一个出口** */
import { expandCompounds, isCompound, makeCompound, ungroupCompound } from '../shared/compound.js'
/* 多机位：与复合片段同一套"展开"思路，但内部时间线是**由切换点算出来**的 */
import {
  angleIndexAt,
  audioOf,
  expandMulticams,
  isMulticam,
  makeMulticam,
  multicamSpan,
  segmentsOf,
  setAudio as setMulticamAudio,
  setCut as setMulticamCut,
  ungroupMulticam
} from '../shared/multicam.js'
import {
  ACTIONS,
  clampZoom,
  clearKeymap,
  comboOf,
  isTypingTarget,
  loadKeymap,
  mergeKeymap,
  resolveAction,
  saveKeymap,
  stepFrame
} from './keymap.js'
import Home from './components/Home.jsx'
import TopBar from './components/TopBar.jsx'
import EditorTabs from './components/EditorTabs.jsx'
import AssetTree, { defaultNodeOf, nodeOf, treeOf } from './components/AssetTree.jsx'
import MediaPanel from './components/MediaPanel.jsx'
import SidePanels from './components/SidePanels.jsx'
import Stage from './components/Stage.jsx'
import Inspector, { inspectorTabsFor } from './components/Inspector.jsx'
import Timeline from './components/Timeline.jsx'
import { AboutDialog, GuideDialog, SettingsDialog } from './components/Dialogs.jsx'
import Splitter from './components/Splitter.jsx'
import { IconClose, IconMenu } from './icons.jsx'
import './workbench.css'

/** 首屏默认片段时长（秒），新加入时间线的素材都按这个长度摆放 */
const DEFAULT_CLIP_SECONDS = 5

/* ------------------------ 区域尺寸默认与值域 ------------------------ */
/* 默认三列比例 = 布局基线（616/676/439 那组实测值的延续）；时间线默认高
   跟窗口走（约 32%），一旦拖过就固定成 px。值域钳制放在两处：
   JS 里钳"存进 settings 的值"，CSS clamp 兜底"运行时的任意值"。 */
const LAYOUT_DEFAULTS = { treeW: 150, centerFr: 504, playerFr: 740, infoFr: 494, tlH: null }
const LAYOUT_TL_DEFAULT = 'clamp(140px, 32vh, 70vh)'
const CENTER_FR_MIN = 220
const PLAYER_FR_MIN = 300
const INFO_FR_MIN = 260

const clampLayout = (value, min, max) => Math.max(min, Math.min(max, value))
/** 时间线默认高的像素换算（拖拽增量的基准，只用于"从默认开始拖"的第一下） */
const tlDefaultH = () => Math.max(140, Math.min(window.innerHeight * 0.32, window.innerHeight * 0.7))


let idSeq = 0
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++idSeq}`

/** 本地素材一律是本机路径或 yjai-media:// 地址，直接原样使用 */
export function absoluteUrl(baseUrl, pathOrUrl) {
  if (!pathOrUrl) return ''
  const text = String(pathOrUrl)
  if (/^(https?:|data:|blob:)/i.test(text)) return text
  return `${String(baseUrl).replace(/\/+$/, '')}${text.startsWith('/') ? '' : '/'}${text}`
}

export default function App() {
  const toast = useToast()

  /* ---------------------------- 会话与配置 ---------------------------- */

  const [info, setInfo] = useState(null)
  const [booted, setBooted] = useState(false)

  /* ---------------------------- 工作区状态 ---------------------------- */

  /* 'home' = 创作中心首页（打开软件第一屏），'editor' = 剪辑工作台 */
  const [page, setPage] = useState('home')
  /* 工作台的两个导航维度：顶部功能标签 + 左栏二级项 */
  const [wbTab, setWbTab] = useState('media')
  /* 初值必须走 defaultNodeOf，**不能**写 'material'。
     `material` 正好是「素材」标签的 root.key —— 首屏进工作台时，左栏会把
     **根卡片**点亮（根卡片是"该标签的全部素材"，不是用户会主动选的那个），
     而参考客户端首屏点亮的是「本地」。实测两条证据：
       · 参考根卡片行底色 #27272D（未选中）、「本地」是紫字；
       · 我们改前是根卡片底色 #34343C（选中态）+ 本地白字。
     走 defaultNodeOf 后 media 标签落到 `landing: true` 的 `local`，与参考一致。 */
  const [wbNode, setWbNode] = useState(() => defaultNodeOf('media'))
  const [assets, setAssets] = useState([])
  const [clips, setClips] = useState([])
  const [selection, setSelection] = useState(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(100)
  const [zoom, setZoom] = useState(1)
  const [projectName, setProjectName] = useState('未命名项目')
  const [exportOpen, setExportOpen] = useState(false)

  /* ---------------------------- 时间区域 ---------------------------- */
  /**
   * 时间区域：`{ start, end }`（秒），`end` 可以是 **null** —— 那表示"只标了入点"。
   *
   * 为什么允许半开状态：按 I 时用户还没决定出点，这时强行编一个 `start + 3 秒`
   * 等于替他做了决定，而他接着按 O 时又会覆盖掉 —— 界面上会闪一下再变，像 bug。
   * 半开时只在标尺上画一条入点线并提示"按 O 标出点"，不存在"猜"这件事。
   *
   * 区域**不进草稿**：它是一次性的选区，和"选中哪个片段"同类；
   * 存进草稿反而会让下次打开时莫名其妙出现一段高亮。
   */
  const [region, setRegion] = useState(null)
  const regionRef = useRef(null)
  regionRef.current = region
  /** 复制的区间内容：`{items, span}`，粘贴到播放头时用（只在本次会话有效） */
  const [regionClip, setRegionClip] = useState(null)
  /** 录音配音面板开着没有（麦克风只在面板里被打开，见 components/Recorder.jsx） */
  const [recorderOpen, setRecorderOpen] = useState(false)
  /** 录音中 / 保存中：这期间不许用 Esc 关面板（关掉会连麦克风一起放掉，条目全丢） */
  const [recorderBusy, setRecorderBusy] = useState(false)

  /* ---------------------------- 快捷键 ---------------------------- */

  /**
   * 吸附开关。原先它是 Timeline 内部的 useState，快捷键要能切换它，
   * 所以提升到这里受控 —— 否则按 N 只能改 App 的状态、轨道那边毫无反应。
   */
  const [snap, setSnap] = useState(true)
  /** 用户自定义键位表；启动时读本地，读不到就用默认表（见 keymap.js） */
  const [keymap, setKeymap] = useState(() => loadKeymap())
  /**
   * 动作处理表放 ref：keydown 监听器只挂一次，而这些处理函数每轮渲染都会变。
   * 直接闭进监听器的话，依赖一变就要重挂，重挂之间那一下按键会丢。
   */
  const actionHandlersRef = useRef({})
  /** 全屏预览作用在预览区元素上，ref 由 Stage 挂到 .wb-player */
  const playerRef = useRef(null)
  const [fullscreen, setFullscreen] = useState(false)
  /**
   * 预览画面的底图（参考「素材 → 背景」页选中的那张）。
   *
   * 语义与参考一致：背景是**铺在视频后面**的底图，视频保持原比例居中，
   * 露出来的四周由这张图填满 —— 竖屏素材放进 16:9 画布时最明显。
   *
   * ⚠️ 目前**只作用于预览**，还没进导出。落地范围如实写在界面的提示里：
   *    `RefArtPanel` 那句 notice 说的是"铺到预览画面后面"，没有说"导出也会带上"。
   *    要进导出得让主进程的 ffmpeg 也能读到这张图，而它是**打进包里的资源**
   *    （开发时在 `dist-renderer/assets/**`，打包后在 `app.asar` 内），
   *    ffmpeg 读不了 asar —— 得先有一条"把内置资源落到项目素材目录"的通道。
   *    在那之前不说它已经支持导出。
   */
  const [backdrop, setBackdrop] = useState(null)
  /** 全屏切换的序号：用来作废「到点复核原生全屏有没有生效」的在途定时器 */
  const fsSeqRef = useRef(0)
  /** 硬件加速开关（设置值）。实际生效值在 info.hardwareAcceleration 上，两者可能不同 */
  const [hardwareAcceleration, setHardwareAcceleration] = useState(true)

  /**
   * 画面比例（画布形状）。
   *
   * ⚠️ 它**必须进草稿**：比例是项目属性，不是界面偏好 ——
   * 存成 setting 的话，打开另一个草稿会沿用上一个的比例，
   * 表现为"我的竖屏项目打开就变成横屏了"，而且没有任何提示。
   * ⚠️ 值一律过 `normalizeAspect`：旧草稿里没有这个字段时是 undefined，
   *    不过一遍就会把 `undefined` 写进 DOM 属性、也让画布算出 NaN 尺寸。
   */
  const [aspect, setAspect] = useState(DEFAULT_ASPECT)

  /**
   * 时间线名称（信息面板「草稿参数 · 时间线名称」）。
   * 与项目名分开设：一个草稿里可以有若干条时间线，参考客户端的播放条标题
   * 也写成「播放器 · 时间线01」这种组合。它是真字段（写进设置并落草稿），
   * 不是面板里的一行装饰文字。
   */
  const [timelineName, setTimelineName] = useState('时间线01')

  /* ---------------------------- 草稿持久化 ---------------------------- */

  /** 当前草稿 id（空 = 还没落过盘，第一次自动保存时才生成） */
  const [draftId, setDraftId] = useState('')
  const [drafts, setDrafts] = useState([])
  const [draftSavedAt, setDraftSavedAt] = useState('')
  /** 项目创建时间 —— 参考的信息面板在「名字」下面就有这一行（格式 YYYY-MM-DD_HH） */
  const [createdAt, setCreatedAt] = useState('')
  const [draftDirty, setDraftDirty] = useState(false)
  /** 启动恢复期间不要触发自动保存，否则空时间线会把刚恢复的草稿覆盖掉 */
  const restoreDoneRef = useRef(false)
  /** 自动保存基线：内容序列化后与它相同就不再写盘 */
  const draftPayloadRef = useRef('')
  /** 启动恢复/打开草稿后的第一次比对只记基线、不落盘 */
  const skipAutoSaveRef = useRef(true)

  /* ---------------------------- 撤销 / 重做 ---------------------------- */

  const clipsRef = useRef([])
  clipsRef.current = clips
  const pastRef = useRef([])
  const futureRef = useRef([])
  const [, bumpHistory] = useState(0)

  /** 所有会进撤销栈的时间线改动都走这里，避免有操作忘了记快照 */
  const commitClips = useCallback((updater) => {
    const prev = clipsRef.current
    const next = typeof updater === 'function' ? updater(prev) : updater
    if (next === prev) return
    pastRef.current = [...pastRef.current.slice(-49), prev]
    futureRef.current = []
    clipsRef.current = next
    setClips(next)
    bumpHistory((value) => value + 1)
  }, [])

  /* 「给单个片段打补丁」的入口在下面「参数类操作」那一节（滤镜 / 转场 / 文字用的
     就是同一个 patchClip），属性面板的三个滑杆复用它 —— 不另起一个，
     免得两处行为慢慢长成两套。 */

  /** 拖动这类高频操作：只在按下时记一次快照，避免每一步都进栈 */
  const snapshotClips = useCallback(() => {
    pastRef.current = [...pastRef.current.slice(-49), clipsRef.current]
    futureRef.current = []
    bumpHistory((value) => value + 1)
  }, [])

  const undo = useCallback(() => {
    if (!pastRef.current.length) return
    const target = pastRef.current[pastRef.current.length - 1]
    pastRef.current = pastRef.current.slice(0, -1)
    futureRef.current = [clipsRef.current, ...futureRef.current]
    clipsRef.current = target
    setClips(target)
    bumpHistory((value) => value + 1)
  }, [])

  const redo = useCallback(() => {
    if (!futureRef.current.length) return
    const target = futureRef.current[0]
    futureRef.current = futureRef.current.slice(1)
    pastRef.current = [...pastRef.current, clipsRef.current]
    clipsRef.current = target
    setClips(target)
    bumpHistory((value) => value + 1)
  }, [])

  /* ------------------------------ 弹窗 ------------------------------ */

  const [dialog, setDialog] = useState(null) // 'settings' | 'about' | 'guide'
  /** 左栏（素材二级列表）折叠态 —— 顶栏那枚「侧栏」字形图标切的就是它 */
  const [railHidden, setRailHidden] = useState(false)
  /** 时间线全屏态。住在这里而不是 Timeline 里，见 Timeline.jsx 的 props 注释 */
  const [tlFull, setTlFull] = useState(false)

  /* ------------------------ 区域尺寸（可拖拽） ------------------------ */

  /**
   * 工作台四块区域的尺寸，全部可拖：
   *   treeW    左栏宽（px）
   *   centerFr / playerFr / infoFr   中栏·播放器·信息三列的弹性比例
   *   tlH      时间线高（px）；null = 未拖过，按窗口高度的比例自适应
   * 持久化走 settings（Electron 落 profile，浏览器落 localStorage）。
   */
  const [layout, setLayout] = useState(null)
  const appRef = useRef(null)

  /**
   * 轨道开关（隐藏 / 静音 / 锁定），真源在这里而不是时间线组件里。
   *
   * 上一版它住在 Timeline 的本地 state —— 结果轨道灯亮了、lane 变灰了，
   * 预览照播、导出照渲：状态变了，成片一个像素没变（静默失效第⑤类）。
   * 现在提升到这里，统一由 `effectiveClips()` 结算出「真正参与预览与导出的片段」，
   * 三条消费路（预览合成 / 导出载荷 / 时间线显示）读同一份。
   * 持久化与 layout 同一套 settings 通道，重启后轨道开关还在。
   */
  /**
   * ⚠️ 四个字段**一个都不能漏**，而且归一化的活只能有一个地方干：
   * 早先 `changeTrackState` 与"从设置恢复"各自手写一遍字段列表，加 `solo` 时
   * 只改了前者 —— 于是独奏按钮点下去、state 里确实写进去了，但下一次更新
   * （点别的开关）又把它洗掉，表现为"点了亮一下、再点别处就没了"。
   * 这类缺陷不报错、不崩，只有真点才知道，所以归一化收敛到这一个函数。
   */
  const normalizeTrackState = (raw) => ({
    hidden: Array.isArray(raw?.hidden) ? raw.hidden : [],
    muted: Array.isArray(raw?.muted) ? raw.muted : [],
    locked: Array.isArray(raw?.locked) ? raw.locked : [],
    solo: Array.isArray(raw?.solo) ? raw.solo : []
  })

  const TRACK_STATE_DEFAULTS = { hidden: [], muted: [], locked: [], solo: [] }
  const [trackState, setTrackState] = useState(TRACK_STATE_DEFAULTS)
  /** 回调深处读最新值用的镜像（回调依赖表里不放 trackState，避免整表重建） */
  const trackStateRef = useRef(trackState)
  trackStateRef.current = trackState

  useEffect(() => {
    let alive = true
    getSetting('trackState').then((saved) => {
      if (!alive || !saved || typeof saved !== 'object') return
      setTrackState(normalizeTrackState(saved))
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    setSetting('trackState', trackState).catch(() => {})
  }, [trackState])

  /**
   * 时间线标记（用户标记）。
   *
   * 每项是**时刻（秒）**，不是一个对象：标记没有名字、没有颜色、没有轨道，
   * 它唯一的信息就是"这一秒"。存成对象只会让人以为以后要加字段，实际永远用不到。
   * 排序 + 去重在这一层做，画的时候不用再管（乱序的标记点会让"跳到上一个标记"跳反）。
   *
   * ⚠️ 它进 settings 而不是只看草稿：标记是"打点"，跨草稿也该留着（同一套素材反复用），
   *    和轨道四态一样属于编辑器偏好。真源唯一，预览/导出都不读它（标记不进成片）。
   */
  const [markers, setMarkers] = useState([])
  useEffect(() => {
    let alive = true
    getSetting('markers').then((saved) => {
      if (!alive || !Array.isArray(saved)) return
      setMarkers(normalizeMarkers(saved))
    })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    setSetting('markers', markers).catch(() => {})
  }, [markers])

  /** 加/删标记：同一帧上再点一次就取消（剪辑软件里都是这个手感） */
  const toggleMarkerAt = useCallback((at) => {
    const t = Math.max(0, Number(at) || 0)
    setMarkers((list) => {
      /* 阈值只在 markers.js 里定义一次：这里自己写 0.12，将来改阈值就会出现
         "点下去没删掉/删错一个"这种只有手快才复现的怪事 */
      const hit = markerIndexAt(list, t)
      if (hit >= 0) return list.filter((_, i) => i !== hit)
      return normalizeMarkers([...list, t])
    })
  }, [])

  /**
   * 自定义字体列表（settings.fonts）。
   *
   * 每项 `{ id, name, path, url }`：id 是源路径的短哈希（重复导入不会变成两条），
   * path 给导出（drawtext 的 fontfile），url 给预览（fetch → FontFace）。
   *
   * ⚠️ 启动时必须做两件事，缺一件都会静默失效：
   *   1. allowFontPaths —— 白名单是进程内存态，重启后是空的，不重新登记就 403；
   *   2. registerFonts  —— 不注册进 document.fonts，CSS 里的家族名等于不存在，
   *      预览会**安静地**退回系统字体（界面上完全看不出来）。
   */
  const [fonts, setFonts] = useState([])
  useEffect(() => {
    let alive = true
    getSetting('fonts').then(async (saved) => {
      if (!alive || !Array.isArray(saved) || !saved.length) return
      const list = saved.filter((item) => item && item.id && item.path)
      setFonts(list)
      await allowFontPaths(list.map((item) => item.path))
      if (!alive) return
      await registerFonts(list)
    })
    return () => {
      alive = false
    }
  }, [])

  /** 导入字体：选文件 → 复制入库 → 注册 → 写进 settings */
  const importFonts = useCallback(async () => {
    const picked = await pickFonts()
    if (!picked.length) return []
    await registerFonts(picked)
    setFonts((prev) => {
      const merged = [...prev]
      for (const font of picked) {
        const hit = merged.findIndex((item) => item.id === font.id)
        if (hit >= 0) merged[hit] = font
        else merged.push(font)
      }
      setSetting('fonts', merged).catch(() => {})
      return merged
    })
    toast.good(`已导入 ${picked.length} 个字体`)
    return picked
  }, [toast])

  /**
   * 导入方式：'link' 引用原位（默认，省空间）/ 'copy' 复制进草稿（原文件移走也不断）。
   *
   * ⚠️ 它只影响**导入这一刻**，不改变已有素材的路径 ——
   *    所以不做"改设置时把所有素材搬一遍"这种危险动作（素材可能正在被预览占用）。
   */
  const [importMode, setImportMode] = useState('link')
  useEffect(() => {
    let alive = true
    getSetting('importMode').then((saved) => {
      if (!alive) return
      if (saved === 'copy' || saved === 'link') setImportMode(saved)
    })
    return () => {
      alive = false
    }
  }, [])
  const changeImportMode = useCallback((next) => {
    const value = next === 'copy' ? 'copy' : 'link'
    setImportMode(value)
    setSetting('importMode', value).catch(() => {})
  }, [])

  /**
   * 预览画质：'full' 原片 / 'smooth' 720p 代理 / 'fast' 540p 代理。
   *
   * ⚠️ 只影响**预览取哪个文件**。素材表里的 url、片段上的 path 一律不动 ——
   *    导出读的是 `clip.path`，结构上就碰不到代理（见 shared/proxy.js 的说明）。
   *
   * 代理是**按需生成**的：切到 720p 之后才为"真的在时间线上用到的素材"各跑一次 ffmpeg，
   * 生成完缓存进 `userData/proxies`，下次直接复用（比源文件新才算有效）。
   * 不在打开草稿时全量生成 —— 那会让打开一个 20 段素材的草稿变成"等 10 分钟"。
   */
  const [previewQuality, setPreviewQuality] = useState('full')
  /**
   * `{ [原片 url]: { url, height, state } }`：state = 'pending' | 'ready' | 'failed'
   *
   * ⚠️ 键是**原片的 url**，不是 assetId。早先按 assetId 建表，结果"没有 assetId 的片段"
   *    （旧草稿、程序构造的片段）永远拿不到代理 —— 切了档位、什么都没发生，
   *    而控制台一片安静。url 是"这一路画面到底读哪个文件"的唯一入口，按它建表就不会漏。
   */
  const [proxyMap, setProxyMap] = useState({})
  const proxyAskedRef = useRef(new Set())
  /* "这一帧的合成结果"存一份 ref 给下面的代理 effect 读：
     effect 的依赖里放不进整个 composite（每帧都变），会在播放时引爆重渲染 */
  const previewCompositeRef = useRef(null)

  useEffect(() => {
    let alive = true
    getSetting('previewQuality').then((saved) => {
      if (!alive) return
      const value = proxyTable.normalizeQuality(saved)
      if (value !== 'full') setPreviewQuality(value)
    })
    return () => {
      alive = false
    }
  }, [])

  const changePreviewQuality = useCallback((next) => {
    const value = proxyTable.normalizeQuality(next)
    setPreviewQuality(value)
    setSetting('previewQuality', value).catch(() => {})
    if (value === 'full') {
      /* 切回原片就清空映射：留着会让"下一次切到代理"以为已经生成好了 */
      proxyAskedRef.current.clear()
      setProxyMap({})
      toast('预览画质：完整（原片）')
      return
    }
    toast(`预览画质：${proxyTable.QUALITY_LABELS[value]}（导出仍用原片）`)
  }, [toast])

  /* 按需生成代理的那条 effect 挪到下面了（它依赖 activeClips / composite，
     而两者都在本组件靠后位置才声明 —— 依赖数组在**渲染期**求值，
     写在这里会踩 `Cannot access 'activeClips' before initialization`，
     整棵树白屏、页面只留一行 TDZ 报错）。见 previewCompositeRef 赋值处。 */

  /**
   * 预览专用的素材表：把"已经在代理里就绪"的视频素材换成代理 url。
   * ⚠️ 只在预览里用它；导出与草稿存储仍然用 `assets`（原片）。
   */
  const previewAssets = useMemo(() => {
    if (!proxyTable.needsProxy(previewQuality)) return assets
    const hits = Object.entries(proxyMap).filter(([, value]) => value && value.state === 'ready' && value.url)
    if (!hits.length) return assets
    const byUrl = new Map(hits)
    return assets.map((asset) => {
      const hit = byUrl.get(asset.url)
      return hit ? { ...asset, url: hit.url, proxyUrl: hit.url } : asset
    })
  }, [assets, previewQuality, proxyMap])

  /**
   * 预览专用的片段表：片段自己记了 url（没有 assetId）时，素材表那一路替换不到它，
   * 于是再按 `clip.url` 替换一次。两处都做 == "不管片段怎么来的，预览都读代理"。
   *
   * ⚠️ 这份只喂 `compositeAt`（预览合成），**不写回 clips**：
   *    写回去就会连带改动草稿与导出（`render.js` 读的是 clips 上的 path/url）。
   * ⚠️ 它住在 `activeClips` **后面**（见下方合成器一段）：useMemo 的回调在渲染期就执行，
   *    写在这里等于在 activeClips 解构完之前读它 ⇒ TDZ，白屏。
   */
  const makePreviewClips = (list) => {
    if (!proxyTable.needsProxy(previewQuality)) return list
    const hits = Object.entries(proxyMap).filter(([, value]) => value && value.state === 'ready' && value.url)
    if (!hits.length) return list
    const byUrl = new Map(hits)
    return list.map((clip) => {
      const hit = byUrl.get(clip.url)
      return hit ? { ...clip, url: hit.url } : clip
    })
  }

  /**
   * HDR 体检结果：`{ [path]: { hdr, label, hint } }`。
   *
   * 为什么不在渲染层自己判断：HDR 的唯一可靠信号是**容器/码流的 color_transfer**
   * （smpte2084 / arib-std-b67），位深骗人（10-bit 也可能是 SDR）。那只有 ffprobe 知道。
   * 探到的结果只用于**两件事**：右栏如实标一行「色彩」，以及导入时提示一次。
   * 导出侧的色调映射**不依赖**这个状态 —— 主进程自己会再探一次（谁也不能靠界面状态
   * 决定成片对不对）。
   */
  const [hdrMap, setHdrMap] = useState({})
  const hdrAskedRef = useRef(new Set())

  useEffect(() => {
    if (!window.yjai?.media?.hdr) return undefined
    const paths = assets
      .filter((asset) => asset && asset.path && asset.kind === 'video')
      .map((asset) => asset.path)
      .filter((item) => !hdrAskedRef.current.has(item))
    if (!paths.length) return undefined
    paths.forEach((item) => hdrAskedRef.current.add(item))
    let alive = true
    Promise.resolve(window.yjai.media.hdr(paths))
      .then((list) => {
        if (!alive || !Array.isArray(list) || !list.length) return
        setHdrMap((prev) => {
          const next = { ...prev }
          for (const item of list) next[item.path] = item
          return next
        })
        const found = list.filter((item) => item && item.hdr)
        /* 只说一次：素材一多会刷屏，而且这话本来就只需要知道一次 */
        if (found.length) {
          toast(`检测到 ${found.length} 个 HDR 素材（${found[0].label}）：导出会自动转成 SDR，预览可能略灰`)
        }
      })
      .catch(() => {
        /* 探不出来就不标 —— 不能靠猜 */
      })
    return () => {
      alive = false
    }
  }, [assets, toast])

  /**
   * 剪辑联动：拖动片段时，同一源素材的画面与声音一起动。
   *
   * 默认**开**（这是剪辑软件里的常态），关掉之后每个片段各走各的 ——
   * 做"音画错位"这类效果时用户会主动关掉它。
   *
   * ⚠️ 用 ref 保存一份给 dragClip 读：dragClip 是 useCallback([])，
   *    闭包里读 state 会永远读到第一次渲染时的值 ⇒ 开关点了没反应。
   */
  const [linkEnabled, setLinkEnabled] = useState(true)
  const linkRef = useRef(true)
  useEffect(() => {
    let alive = true
    getSetting('linkEnabled').then((saved) => {
      if (!alive || typeof saved !== 'boolean') return
      setLinkEnabled(saved)
      linkRef.current = saved
    })
    return () => {
      alive = false
    }
  }, [])
  const changeLinkEnabled = useCallback((next) => {
    const value = Boolean(next)
    setLinkEnabled(value)
    linkRef.current = value
    setSetting('linkEnabled', value).catch(() => {})
  }, [])

  /** 轨道开关：整体替换式更新（Timeline 只传自己关心的那一份补丁） */
  const changeTrackState = useCallback((next) => {
    setTrackState(normalizeTrackState(next))
  }, [])

  useEffect(() => {
    let alive = true
    getSetting('layout').then((saved) => {
      if (alive) setLayout({ ...LAYOUT_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) })
    })
    return () => {
      alive = false
    }
  }, [])

  /* 尺寸一变就同步到 CSS 变量并落盘。CSS 侧只认变量，clamp 兜底写在样式里，
     JS 侧的钳制保证存进 settings 的值本身就在值域内（下次启动不跳变）。 */
  useEffect(() => {
    if (!layout) return
    const el = appRef.current
    if (el) {
      el.style.setProperty('--wb-tree-w', `${Math.round(layout.treeW)}px`)
      el.style.setProperty('--wb-center-col', `minmax(0, ${Math.round(layout.centerFr)}fr)`)
      el.style.setProperty('--wb-player-col', `minmax(0, ${Math.round(layout.playerFr)}fr)`)
      el.style.setProperty('--wb-info-col', `minmax(0, ${Math.round(layout.infoFr)}fr)`)
      el.style.setProperty('--wb-tl-h', layout.tlH ? `${Math.round(layout.tlH)}px` : LAYOUT_TL_DEFAULT)
    }
    setSetting('layout', layout).catch(() => {})
  }, [layout])

  /** 拖拽增量 → 新尺寸。`which` 对应 Splitter 的 data-splitter。 */
  const resizePane = useCallback((which, delta) => {
    setLayout((cur) => {
      if (!cur) return cur
      const next = { ...cur }
      if (which === 'tree') {
        next.treeW = clampLayout(cur.treeW + delta, 110, 340)
      } else if (which === 'center') {
        /* 中栏与播放器此消彼长：总量守恒，整体宽度不跳 */
        const d = Math.max(-cur.playerFr + PLAYER_FR_MIN, Math.min(cur.centerFr - CENTER_FR_MIN, delta))
        next.centerFr = cur.centerFr + d
        next.playerFr = cur.playerFr - d
      } else if (which === 'info') {
        const d = Math.max(-cur.playerFr + PLAYER_FR_MIN, Math.min(cur.infoFr - INFO_FR_MIN, delta))
        next.playerFr = cur.playerFr + d
        next.infoFr = cur.infoFr - d
      } else if (which === 'timeline') {
        /* 横条坐在时间线**顶部**：上拖（dy<0）= 顶缝上移 = 时间线变高 ⇒ 取反 */
        next.tlH = clampLayout((cur.tlH || tlDefaultH()) - delta, 140, 720)
      }
      return next
    })
  }, [])

  /** 双击 / Home 复位：只动这条分隔条管的字段。
   *  ⚠️ 不能整个覆盖 LAYOUT_DEFAULTS —— 那会把别的区域拖好的尺寸一起洗掉
   *  （实测：复位左栏，时间线高度跟着回了默认）。center/info 两条分隔条
   *  都在动三列比例，这两个一起回默认是合理口径。 */
  const resetPane = useCallback((which) => {
    setLayout((cur) => {
      if (!cur) return cur
      if (which === 'timeline') return { ...cur, tlH: null }
      if (which === 'tree') return { ...cur, treeW: LAYOUT_DEFAULTS.treeW }
      return {
        ...cur,
        centerFr: LAYOUT_DEFAULTS.centerFr,
        playerFr: LAYOUT_DEFAULTS.playerFr,
        infoFr: LAYOUT_DEFAULTS.infoFr
      }
    })
  }, [])

  /* --------------------------- 启动引导 --------------------------- */

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [
        appMeta,
        savedProject,
        savedDraftId,
        savedTimelineName,
        savedKeymap,
        savedHwAccel,
        draftList
      ] = await Promise.all([
        appInfo(),
        getSetting('projectName', '未命名项目'),
        getSetting('currentDraftId', ''),
        getSetting('timelineName', '时间线01'),
        getSetting('keymap', null),
        getSetting('hardwareAcceleration', true),
        listDrafts()
      ])

      if (!alive) return
      setInfo(appMeta)
      setProjectName(savedProject || '未命名项目')
      setTimelineName(String(savedTimelineName || '时间线01'))
      setHardwareAcceleration(savedHwAccel !== false)

      /**
       * 自定义键位以**主进程 settings 为准**，localStorage 只是首屏的即时缓存。
       *
       * 为什么不只用 localStorage：应用里其它所有用户设置（接口地址、项目名、
       * 当前草稿）都走主进程落盘，键位没理由例外 —— 清一次浏览器数据不该把
       * 用户攒出来的键位一起清掉。useState 的初值仍然是同步读 localStorage，
       * 这样首帧就有键位可用，不会出现"先按默认跑一下再切到自定义"的闪动。
       */
      if (savedKeymap && typeof savedKeymap === 'object') {
        const merged = mergeKeymap(savedKeymap)
        setKeymap(merged)
        saveKeymap(merged)
      }
      setDrafts(draftList)

      // 恢复上次打开的草稿：时间线 + 媒体库 + 播放头
      let restoredCreatedAt = ''
      if (savedDraftId) {
        const record = await loadDraft(savedDraftId)
        if (!alive) return
        if (record?.data && Array.isArray(record.data.clips)) {
          setDraftId(record.id)
          if (record.name) setProjectName(record.name)
          clipsRef.current = record.data.clips
          setClips(record.data.clips)
          if (Number.isFinite(Number(record.data.playhead))) setPlayhead(Number(record.data.playhead))
          if (Number.isFinite(Number(record.data.volume))) setVolume(Number(record.data.volume))
          if (Number.isFinite(Number(record.data.zoom))) setZoom(Number(record.data.zoom))
          /* 画面比例：旧草稿没有这个字段 ⇒ normalizeAspect 回落 16:9，
             不能把 undefined 直接喂给 setAspect（画布会算出 NaN 尺寸）。 */
          setAspect(normalizeAspect(record.data.aspect))
          // 本地素材的协议白名单在主进程里是内存态，重启后要重新登记一次
          const localPaths = (record.data.assets || []).map((asset) => asset.path).filter(Boolean)
          if (localPaths.length) {
            const checked = await statMedia(localPaths)
            if (!alive) return
            const byPath = new Map(checked.map((item) => [item.path, item]))
            const restored = (record.data.assets || [])
              .map((asset) => (asset.path && byPath.has(asset.path) ? { ...asset, ...byPath.get(asset.path) } : (asset.path ? null : asset)))
              .filter(Boolean)
            setAssets(restored)
          } else if (Array.isArray(record.data.assets)) {
            setAssets(record.data.assets)
          }
          setDraftSavedAt(record.updatedAt || '')
          // 旧草稿没有 createdAt 字段：退回草稿的更新时间，显示上仍然有值
          restoredCreatedAt = record.data.createdAt || record.updatedAt || ''
        }
      }
      setCreatedAt(restoredCreatedAt || new Date().toISOString())
      setBooted(true)
      restoreDoneRef.current = true
    })()
    return () => {
      alive = false
    }
  }, [])

  /* ---------------------- 草稿：保存 / 打开 / 自动保存 ---------------------- */

  /**
   * 当前工作区的草稿数据（**落盘与打包共用的唯一一份**）。
   *
   * 早先这段对象字面量只写在 persistDraft 里，打包素材包时又抄了一遍 ——
   * 抄漏一个字段（比如 `aspect`）的后果是"包导到对面比例变回 16:9"，
   * 而两边单独看都"保存成功"。所以只留这一个出口。
   */
  const draftDataOf = useCallback(
    () => ({
      clips: clipsRef.current,
      assets,
      playhead,
      volume,
      zoom,
      /* 画面比例跟着**项目**走，不跟着应用走（理由见 aspect 的声明处） */
      aspect,
      createdAt: createdAt || new Date().toISOString()
    }),
    [aspect, assets, createdAt, playhead, volume, zoom]
  )

  /** 把当前工作区写进当前草稿（没有就新建）；返回草稿摘要，失败返回 null */
  const persistDraft = useCallback(
    async ({ silent = true, name } = {}) => {
      // createdAt 只在第一次保存时定死，之后原样带回 —— 草稿反复保存不改变创建时间
      const createdAtValue = createdAt || new Date().toISOString()
      const summary = await saveDraft({
        id: draftId || undefined,
        name: name || projectName,
        data: draftDataOf()
      })
      if (!summary) {
        if (!silent) toast('草稿保存失败：本地目录不可写')
        return null
      }
      if (!createdAt) setCreatedAt(createdAtValue)
      setDraftId(summary.id)
      setDraftSavedAt(summary.updatedAt)
      setDraftDirty(false)
      setDrafts((list) =>
        [summary, ...list.filter((item) => item.id !== summary.id)].sort((a, b) =>
          String(b.updatedAt).localeCompare(String(a.updatedAt))
        )
      )
      setSetting('currentDraftId', summary.id)
      if (!silent) toast(`已保存「${summary.name}」`)
      return summary
    },
    [createdAt, draftDataOf, draftId, projectName, toast]
  )

  /**
   * 导出素材包：草稿 + 它引用的每一个素材 → 一个 `.yjpack`。
   *
   * 顺序刻意是「先落盘、再打包」：包里的 draft.json 必须是**用户眼前这一版**，
   * 否则会出现"包打好了，但里面少我刚拖进去的那一段"（而且完全看不出来）。
   * 素材缺失不阻断导出，但必须说出来 —— 静默打出半个包，到对面就是黑帧。
   */
  const handleExportPack = useCallback(async () => {
    if (!clipsRef.current.length) {
      toast.bad('时间线是空的，没有可打包的内容')
      return
    }
    if (!window.yjai?.pack?.export) {
      toast.bad('当前环境不支持导出素材包')
      return
    }
    const saved = await persistDraft({ silent: true })
    if (!saved) {
      /* 落盘失败仍然允许打包（用户可以只要素材），但要说清"包里的草稿可能不是最新" */
      toast.bad('草稿保存失败：包里的草稿可能不是最新一版')
    }
    const inspected = await window.yjai.pack.inspect(draftDataOf()).catch(() => null)
    /* 体检结果只用来把"素材到底缺几个"提前算清楚（也便于界面/闸门核对）；
       真正阻断与否由下面的导出结果决定 —— 缺文件不该阻断，但必须说出来。 */
    if (inspected && inspected.missing && inspected.missing.length) {
      toast.bad(`有 ${inspected.missing.length} 个素材找不到，将按离线导出`)
    }
    const result = await window.yjai.pack.export({
      name: saved?.name || projectName || '工程',
      data: draftDataOf()
    })
    if (!result || result.canceled) return
    if (!result.ok) {
      toast.bad(result.error || '导出素材包失败')
      return
    }
    const sizeText = `${(Number(result.bytes || 0) / (1024 * 1024)).toFixed(1)} MB`
    if (result.missing && result.missing.length) {
      /* 缺素材要**说清是哪几个**（前三个名字），只说数字等于没说 */
      const names = result.missing.slice(0, 3).map((item) => String(item.path).split(/[\\/]/).pop()).join('、')
      toast.bad(
        `素材包已导出（${result.packed} 个素材 / ${sizeText}），但有 ${result.missing.length} 个素材找不到：${names}${
          result.missing.length > 3 ? ' 等' : ''
        }`
      )
      return
    }
    toast(`素材包已导出：${result.packed} 个素材 / ${sizeText}`)
  }, [draftDataOf, persistDraft, projectName, toast])

  /**
   * 自动保存：内容变了 1.2 秒后落盘。
   * 空时间线且还没有草稿时不建文件 —— 否则每开一次软件就多一份空草稿。
   */
  useEffect(() => {
    if (!booted || !restoreDoneRef.current) return
    const payload = JSON.stringify({ clips, projectName, assets, playhead, volume, zoom, aspect })
    if (skipAutoSaveRef.current) {
      // 启动恢复本身不算「改动」，只记基线，不触发保存
      skipAutoSaveRef.current = false
      draftPayloadRef.current = payload
      return
    }
    if (payload === draftPayloadRef.current) return
    draftPayloadRef.current = payload
    if (!draftId && !clips.length) return
    setDraftDirty(true)
    const timer = setTimeout(() => {
      persistDraft({ silent: true })
    }, 1200)
    return () => clearTimeout(timer)
  }, [booted, clips, projectName, assets, playhead, volume, zoom, aspect, draftId, persistDraft])

  /** 新建草稿：清空时间线与媒体库，并断开与当前草稿的绑定 */
  const handleNewDraft = useCallback(() => {
    commitClips([])
    setAssets([])
    setPlayhead(0)
    setDraftId('')
    setDraftSavedAt('')
    setCreatedAt(new Date().toISOString())
    setDraftDirty(false)
    draftPayloadRef.current = ''
    setSetting('currentDraftId', '')
    setProjectName('未命名项目')
    /* 新项目回到默认比例：比例是项目属性，不该被上一个项目带着走 */
    setAspect(DEFAULT_ASPECT)
    setPage('editor')
    toast('已新建空白草稿')
  }, [commitClips, toast])

  /**
   * 另存为：**不带 id** 写一份新草稿，然后把工作区绑到新草稿上。
   *
   * 与 persistDraft 的区别只有一条 —— 后者带 `draftId` 会覆盖当前那份，
   * 而"另存为"必须落成新文件，否则用户以为留了副本、实际把原件改掉了。
   * 命名沿用参考的措辞：`<原名> 副本`。
   */
  const handleSaveDraftAs = useCallback(async () => {
    const baseName = (projectName || '未命名项目').trim() || '未命名项目'
    const summary = await saveDraft({
      name: `${baseName} 副本`,
      data: { clips: clipsRef.current, assets, playhead, volume, zoom, aspect }
    })
    if (!summary) {
      toast.bad('草稿保存失败：本地目录不可写')
      return
    }
    setDraftId(summary.id)
    setDraftSavedAt(summary.updatedAt)
    setDraftDirty(false)
    setProjectName(summary.name)
    setDrafts((list) =>
      [summary, ...list.filter((item) => item.id !== summary.id)].sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt))
      )
    )
    setSetting('currentDraftId', summary.id)
    toast.good(`已另存为「${summary.name}」`)
  }, [assets, aspect, playhead, projectName, setSetting, toast, volume, zoom])

  /** 打开草稿：读盘并灌进工作区，然后切到剪辑器 */
  const handleOpenDraft = useCallback(
    async (draft) => {
      const record = await loadDraft(draft.id)
      if (!record?.data) {
        toast('草稿读取失败')
        return
      }
      const nextClips = Array.isArray(record.data.clips) ? record.data.clips : []
      clipsRef.current = nextClips
      setClips(nextClips)
      setProjectName(record.name || '未命名项目')
      setPlayhead(Number(record.data.playhead) || 0)
      setVolume(Number.isFinite(Number(record.data.volume)) ? Number(record.data.volume) : 100)
      setZoom(Number.isFinite(Number(record.data.zoom)) ? Number(record.data.zoom) : 1)
      /* 打开草稿时把那份的比例带回来（旧草稿没有 → 回落 16:9） */
      setAspect(normalizeAspect(record.data.aspect))
      const localPaths = (record.data.assets || []).map((asset) => asset.path).filter(Boolean)
      if (localPaths.length) {
        const checked = await statMedia(localPaths)
        const byPath = new Map(checked.map((item) => [item.path, item]))
        setAssets(
          (record.data.assets || [])
            .map((asset) => (asset.path && byPath.has(asset.path) ? { ...asset, ...byPath.get(asset.path) } : (asset.path ? null : asset)))
            .filter(Boolean)
        )
      } else {
        setAssets(Array.isArray(record.data.assets) ? record.data.assets : [])
      }
      setDraftId(record.id)
      setDraftSavedAt(record.updatedAt || '')
      setCreatedAt(record.data.createdAt || record.updatedAt || '')
      setDraftDirty(false)
      draftPayloadRef.current = ''
      skipAutoSaveRef.current = true
      setSetting('currentDraftId', record.id)
      setPage('editor')
      toast(`已打开「${record.name}」`)
    },
    [toast]
  )

  /**
   * 导入素材包：主进程解开并落成**新草稿**，这里再把它打开。
   *
   * 不覆盖同名草稿是刻意的 —— 包里是别人机器上的工程，
   * 覆盖会不可逆地冲掉用户自己的东西。
   */
  const handleImportPack = useCallback(async () => {
    if (!window.yjai?.pack?.import) {
      toast.bad('当前环境不支持导入素材包')
      return
    }
    const result = await window.yjai.pack.import()
    if (!result || result.canceled) return
    if (!result.ok) {
      toast.bad(result.error || '导入素材包失败')
      return
    }
    const list = await listDrafts()
    setDrafts(list)
    await handleOpenDraft({ id: result.id })
    const missingCount = Array.isArray(result.missing) ? result.missing.length : 0
    if (missingCount) toast.bad(`已导入「${result.name}」，但 ${missingCount} 个素材找不到（包本身就不完整）`)
    else toast(`已导入「${result.name}」：${result.mediaCount} 个素材`)
  }, [handleOpenDraft, toast])

  const handleDeleteDraft = useCallback(
    async (draft) => {
      const ok = await removeDraft(draft.id)
      if (!ok) {
        toast('删除失败')
        return
      }
      setDrafts((list) => list.filter((item) => item.id !== draft.id))
      if (draft.id === draftId) {
        setDraftId('')
        setDraftSavedAt('')
        setSetting('currentDraftId', '')
      }
      toast(`已删除「${draft.name}」`)
    },
    [draftId, toast]
  )

  /* ---------------------- 首页入口 → 真实能力 ---------------------- */

  /** 首页所有入口的总出口：进剪辑器 / 本地页面，没有一个是空响应 */
  const handleHomeNav = useCallback(
    (item) => {
      if (!item) return
      if (item.enterEditor) {
        if (item.tab) setWbTab(item.tab)
        if (item.node) setWbNode(item.node)
        setPage('editor')
        return
      }
      // drafts / template / toolbox 三个页面由首页自己切，到这里就是未知入口
      if (['drafts', 'template', 'toolbox'].includes(item.page)) return
      toast(`「${item.label}」还没有可用的入口`)
    },
    [toast]
  )

  /* ------------------------ 素材与时间线操作 ------------------------ */

  /** 把生成产物收进媒体库 */
  const addAsset = useCallback((asset) => {
    setAssets((list) => [asset, ...list.filter((item) => item.url !== asset.url)])
  }, [])

  const addClipFromAsset = useCallback(
    (asset, trackOverride) => {
      /* trackOverride：属性面板的「加入叠加轨」走这里。其余按素材类型落轨。 */
      const track =
        trackOverride && (trackOverride !== 'overlay' || asset.kind !== 'audio')
          ? trackOverride
          : asset.kind === 'audio'
            ? 'audio'
            : asset.kind === 'text'
              ? 'text'
              : 'video'
      commitClips((list) => {
        const lane = list.filter((item) => item.track === track)
        const start = lane.length ? Math.max(...lane.map((item) => item.start + item.duration)) : 0
        return [
          ...list,
          {
            id: nextId('clip'),
            track,
            assetId: asset.id,
            name: asset.name,
            url: asset.url,
            // 本地素材带上磁盘路径：导出时 ffmpeg 直接读盘，不用再解 URL
            path: asset.path || '',
            kind: asset.kind,
            /**
             * 文本素材的正文。字幕轨要把内容直接铺在轨道上（`clipVisuals.jsx` 的
             * ClipText），只靠 `name`（那是提示词截断出来的 24 字 + 省略号）看不出
             * 这段字幕到底写了什么。图片/视频/音频没有这个字段，留空串。
             */
            text: asset.text || '',
            start,
            duration: asset.duration || DEFAULT_CLIP_SECONDS,
            // 入点：从源文件第几秒开始取。分割后会累加，否则第二段会从头再播一遍
            offset: 0,
            /**
             * 源片总长（秒）。两个用处，都跟"拖到素材外面"有关：
             *   · 右端修剪的上限（不然尾部是黑帧）；
             *   · 左端往回拖时能放出多少（offset 的下界其实是 0，这里只作记录）。
             * 静帧（图片）没有时长 → 记 0，表示**不设上限**：静态图本来就可以任意拉长。
             * 旧草稿里没这个字段，同样是 0/不设上限，与改动前行为一致。
             */
            sourceDuration: Number(asset.duration) || 0,
            /* 画中画的默认位置：右下角、占画布宽度 30%。
               给默认值是必要的 —— 否则用户第一次加画中画时 pip 是 undefined，
               预览与导出各按各的兜底，两边位置可能不一样。 */
            ...(track === 'overlay'
              ? { pip: { anchor: PIP_DEFAULT_ANCHOR, size: PIP_DEFAULT_SIZE } }
              : null)
          }
        ]
      })
      setSelection({ type: 'clip', assetId: asset.id })
      toast.good(
        `已把「${asset.name}」加入${track === 'audio' ? '音频' : track === 'text' ? '字幕' : track === 'overlay' ? '叠加' : '视频'}轨`
      )
    },
    [commitClips, toast]
  )

  /**
   * 把媒体库里的素材拖到时间线上：落在哪条轨就进哪条轨，落点即起点。
   * 起点由 Timeline 那边按像素换算好（含吸附），这里只负责入库。
   */
  const dropAssetOnTimeline = useCallback(
    (assetId, track, start) => {
      const asset = assets.find((item) => item.id === assetId)
      if (!asset) return
      let targetTrack =
        track === 'audio' || track === 'text' || track === 'overlay'
          ? track
          : asset.kind === 'audio'
            ? 'audio'
            : asset.kind === 'text'
              ? 'text'
              : 'video'
      /* 音频素材落进叠加轨是没意义的（画中画要有画面），静悄悄回落到音频轨，
         否则会出现"轨道上有一段、预览里什么都没有"。 */
      if (targetTrack === 'overlay' && asset.kind === 'audio') targetTrack = 'audio'
      commitClips((list) => [
        ...list,
        {
          id: nextId('clip'),
          track: targetTrack,
          assetId: asset.id,
          name: asset.name,
          url: asset.url,
          path: asset.path || '',
          kind: asset.kind,
          // 同 addClipFromAsset：字幕轨要显示正文，不能只有截断过的 name
          text: asset.text || '',
          start: Math.max(0, Number(start) || 0),
          duration: asset.duration || DEFAULT_CLIP_SECONDS,
          offset: 0,
          // 源片总长：右端修剪的上限。缺了它就能把片段拖得比素材还长，导出时尾部是黑帧
          sourceDuration: Number(asset.duration) || 0,
          ...(targetTrack === 'overlay'
            ? { pip: { anchor: PIP_DEFAULT_ANCHOR, size: PIP_DEFAULT_SIZE } }
            : null)
        }
      ])
      setSelection({ type: 'clip', assetId: asset.id })
      toast.good(`「${asset.name}」已放到时间线 ${timecode(Math.max(0, Number(start) || 0), false)}`)
    },
    [assets, commitClips, toast]
  )

  /**
   * 选中片段（支持 Ctrl + 点选的多选）。
   *
   * 多选的**唯一消费者**目前是「新建复合片段」：选中集合记在 `selection.clipIds`，
   * 而 `selection.clipId` 仍然是"主选中"——检查器、播放头跟随、角标全都只认它。
   * 这样多选是**加法**，不是改掉原来的单选语义：任何只读 clipId 的地方行为不变，
   * 不会出现"多选之后右栏空了"这种连带问题。
   *
   * @param {object|null} clip 片段（null = 取消选中）
   * @param {{additive?: boolean}} [options] additive：Ctrl / Cmd 点选，切换这一段的选中态
   */
  const selectClip = useCallback((clip, options = {}) => {
    if (!clip) {
      setSelection(null)
      return
    }
    setSelection((prev) => {
      const base = Array.isArray(prev?.clipIds) && prev.clipIds.length
        ? prev.clipIds
        : prev?.clipId
          ? [prev.clipId]
          : []
      if (!options.additive) {
        return { ...(prev || {}), type: 'clip', clipId: clip.id, assetId: clip.assetId || '', clipIds: [clip.id] }
      }
      const has = base.includes(clip.id)
      const nextIds = has ? base.filter((id) => id !== clip.id) : [...base, clip.id]
      if (!nextIds.length) return null
      /* 取消勾选的是主选中时，主选中顺位给集合里的最后一个 —— 右栏不能突然变空 */
      const primary = has ? nextIds[nextIds.length - 1] : clip.id
      return { ...(prev || {}), type: 'clip', clipId: primary, assetId: clip.assetId || '', clipIds: nextIds }
    })
  }, [])

  /**
   * 删除片段。锁定轨上的片段拒删 —— 与参考一致，锁定拦的是结构性编辑；
   * 拒绝时明确说一句，不能"点了没反应"。
   */
  const removeClip = useCallback(
    (clipId) => {
      const target = clipsRef.current.find((item) => item.id === clipId)
      if (target && trackStateRef.current.locked.includes(target.track)) {
        toast.bad(`「${target.track}」轨道已锁定，解除锁定后才能删除片段`)
        return
      }
      commitClips((list) => list.filter((item) => item.id !== clipId))
      setSelection((current) => {
        if (!current) return current
        /* 多选集里也有它 ⇒ 从集合里摘掉，而不是只判断"主选中是不是它" */
        const ids = (Array.isArray(current.clipIds) && current.clipIds.length
          ? current.clipIds
          : current.clipId
            ? [current.clipId]
            : []
        ).filter((id) => id !== clipId)
        if (!ids.length) return null
        return { ...current, clipId: current.clipId === clipId ? ids[ids.length - 1] : current.clipId, clipIds: ids }
      })
    },
    [commitClips, toast]
  )

  /** 停用 / 启用片段：位置时长都不动，只是退出预览与导出（可逆） */
  const toggleClipEnabled = useCallback(
    (clipId) => {
      const target = clipsRef.current.find((item) => item.id === clipId)
      if (!target) return
      if (target.enabled === false) {
        commitClips((list) => list.map((item) => (item.id === clipId ? { ...item, enabled: true } : item)))
        toast.good(`「${target.name}」已启用`)
      } else {
        commitClips((list) => list.map((item) => (item.id === clipId ? { ...item, enabled: false } : item)))
        toast(`「${target.name}」已停用（预览与导出都会跳过这一段）`)
      }
    },
    [commitClips, toast]
  )

  /** 在系统文件管理器里显示片段的源文件（走 preload 白名单通道 shell:showItem） */
  const revealClip = useCallback(
    (clip) => {
      const target = clip?.path || clip?.url || ''
      if (!target) return
      const bridge = typeof window !== 'undefined' ? window.yjai : null
      if (!bridge?.showItem) {
        toast.bad('当前环境不支持打开文件位置')
        return
      }
      Promise.resolve(bridge.showItem(target)).catch(() => toast.bad('打开文件位置失败'))
    },
    [toast]
  )

  /**
   * 替换片段的素材（右键菜单「替换片段」）。
   *
   * 换的是**源**，不是位置：片段在时间线上的 start 一动不动，
   * 时间线占位也尽量保持原样 —— 参考客户端就是这个语义（换素材不该把剪辑结果打乱）。
   *
   * ⚠️ 两件必须算对的事：
   *   ① 倍速：时间线占位 = 源时长 / 倍速（见 shared/speed.js 的守恒口径）。
   *      换源后要按 `源时长 / 倍速` 重算上限，2 倍速的片段换了素材却按 1 倍速
   *      取时长，成片就会凭空多出一截。
   *   ② 源入点归零：新素材从头开始吃，沿用旧 offset 会指向一个不存在的位置。
   *
   * ⚠️ 换完必须把新素材也收进媒体库：否则它只在时间线上存在，
   *    用户想再拿它去做别的（配音、画中画）时在媒体库里找不到。
   */
  const replaceClipSource = useCallback(
    async (clipId) => {
      const target = clipsRef.current.find((item) => item.id === clipId)
      if (!target) return
      if ((trackStateRef.current.locked || []).includes(target.track)) {
        toast.bad('该轨已锁定，替换前请先解锁')
        return
      }
      const rows = await pickMedia()
      if (!rows.length) return
      const row = rows[0]
      if (row.kind === 'text') {
        toast.bad('不能用文本素材替换片段')
        return
      }
      const meta = await probeMedia(row.url, row.kind)
      const [asset] = localAssetsFrom([row], [meta])
      setAssets((prev) => [asset, ...prev.filter((item) => item.url !== asset.url)])

      /* 换源不换位置 + 倍速守恒 + 源入点归零 + 时长上限，四件事全在 replacePatch 里。
         这里不再自己算一遍 —— 两处算法分开写迟早会算出两个数。 */
      const patch = replacePatch(
        target,
        { url: row.url, path: row.path || '', name: row.displayName || row.name, kind: row.kind, assetId: asset.id },
        Number(meta.duration) || 0
      )
      if (!patch) return

      commitClips((list) => list.map((item) => (item.id === clipId ? { ...item, ...patch } : item)))
      toast.good(
        `已把「${target.name}」替换成「${row.displayName || row.name}」` +
          (patch.duration < Number(target.duration) - 0.01 ? '（新素材更短，片段已随之收短）' : '')
      )
    },
    [commitClips, toast]
  )

  /**
   * 收藏 / 取消收藏一个素材。
   *
   * 存在 asset 上（而不是另开一张 id 列表）：素材本身就是草稿的一部分，
   * `favorite` 跟着 assets 一起落盘，不需要"启动时按 id 回填"这一步 ——
   * 那种做法在素材被删除/重导入后会留下永远对不上的幽灵 id。
   *
   * ⚠️ 用 setAssets 的函数式更新而不是读闭包里的 assets：
   *    连点两下星标时，第二下读到的可能是旧列表，收藏会"闪一下又没了"。
   */
  const toggleAssetFavorite = useCallback((assetId) => {
    setAssets((list) => list.map((item) => (item.id === assetId ? { ...item, favorite: !item.favorite } : item)))
  }, [])

  const removeAsset = useCallback(
    (assetId) => {
      setAssets((list) => list.filter((item) => item.id !== assetId))
      commitClips((list) => list.filter((item) => item.assetId !== assetId))
      setSelection((current) => (current?.assetId === assetId ? null : current))
    },
    [commitClips]
  )

  /* ---------------------------- 时间线编辑 ---------------------------- */

  /** 拖动片段改起点（拖动过程中高频调用，不进撤销栈 —— 快照由 pointerdown 记） */
  const dragClip = useCallback((clipId, patch) => {
    setClips((list) => {
      /* 只有"平移起点"才联动；修剪 / 倍速 / 其它属性补丁一律只作用于目标片段。
         ⚠️ 修剪也联动的话，拖一下右端会让整组一起变长 —— 那不是剪辑软件的行为，
            而且会让"音画同步"这个前提在用户完全没预期的情况下被破坏。 */
      if (patch && typeof patch.start === 'number' && !('duration' in patch) && !('offset' in patch)) {
        const group = linkMovePatches(list, clipId, patch.start, linkRef.current)
        const byId = new Map(group.map((item) => [item.id, item.start]))
        const next = list.map((item) =>
          byId.has(item.id) ? { ...item, start: byId.get(item.id), ...(item.id === clipId ? patch : {}) } : item
        )
        clipsRef.current = next
        return next
      }
      const next = list.map((item) => (item.id === clipId ? { ...item, ...patch } : item))
      clipsRef.current = next
      return next
    })
  }, [])

  /**
   * 画面层级：上移 / 下移一层（右键菜单）。
   *
   * 算术全在 `shared/layers.js`（`moveLayer` 返回的是**补丁数组**），
   * 这里只负责把补丁打回片段表 —— 顺序的判定不能在这里再写一遍，
   * 导出侧（主进程）排 overlay 链用的是同一个比较函数。
   *
   * 为什么要"重新编号"而不是 z±1：两段画中画同 z 时 z±1 反而可能不动，
   * 用户点了没反应，而面板上什么提示都没有。重新编号后"点一次动一格"永远成立。
   */
  const moveLayerOf = useCallback(
    (clipId, dir) => {
      const patches = layersTable.moveLayer(clipsRef.current, clipId, dir)
      if (!patches.length) {
        toast(dir > 0 ? '已经在最上层了' : '已经在最下层了')
        return
      }
      const byId = new Map(patches.map((item) => [item.id, item.z]))
      commitClips((list) => list.map((item) => (byId.has(item.id) ? { ...item, z: byId.get(item.id) } : item)))
      toast(dir > 0 ? '上移一层' : '下移一层')
    },
    [commitClips]
  )

  /**
   * 复制一个片段（Alt + 拖动时用）。
   *
   * 为什么必须**同步返回新 id**：拖动是"按下那一刻决定拖谁、之后每帧改它"的模型，
   * 而 React 的 state 要等到下一帧才把新片段交给 Timeline —— 返回 Promise 或
   * 让调用方下一帧再找"最新的那个"都会在快速拖动时抓错片段。
   * 这里在 commitClips 里同步写入 clipsRef，所以返回的 id 立刻可被 onDragClip 修改。
   *
   * 复制件的起点先与原片段重合，随后由拖动接管 —— 用户看到的是"拖出来的那一份"，
   * 不是"凭空多出来一份、我拖的是原来的"。
   */
  const duplicateClip = useCallback(
    (clipId) => {
      const src = clipsRef.current.find((item) => item.id === clipId)
      if (!src) return null
      const id = nextId('clip')
      commitClips((list) => [...list, { ...src, id }])
      return id
    },
    [commitClips]
  )

  /**
   * 新建复合片段（右键菜单「新建复合片段」）。
   *
   * 时间线上选中的这几段被**收进去**，位置上换成**一个**片段。
   * 内部布局、坐标换算、展开规则全在 `shared/compound.js`（纯函数，另有闸门钉住），
   * 这里只负责发号、落历史、给提示 —— 三处各算一遍是会算出三个数的。
   *
   * 允许只选一段：参考客户端也是这个行为（等于把这一段"封"起来，
   * 之后要么整体搬、要么当嵌套的起点），而且它让"先复合再加东西"这条路径走得通。
   */
  const createCompound = useCallback(
    (ids) => {
      const wanted = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
      if (!wanted.length) {
        toast.bad('先在时间线上选中要合成的片段（Ctrl + 点选可多选）')
        return
      }
      const chosen = clipsRef.current.filter((item) => wanted.includes(item.id))
      const locked = chosen.find((item) => (trackStateRef.current.locked || []).includes(item.track))
      if (locked) {
        toast.bad(`「${locked.name}」所在轨道已锁定，先解锁再合成`)
        return
      }
      const built = makeCompound(clipsRef.current, wanted, { id: nextId('clip') })
      if (!built) {
        toast.bad('选中的片段太短，没法合成复合片段')
        return
      }
      commitClips(() => [...built.rest, built.clip])
      setSelection({ type: 'clip', clipId: built.clip.id, clipIds: [built.clip.id], assetId: '' })
      toast.good(`已合成复合片段（内部 ${built.clip.compound.children.length} 段，${built.clip.duration.toFixed(2)} 秒）`)
    },
    [commitClips, toast]
  )

  /**
   * 解除复合片段：内部片段按**当前裁剪与倍速**还原到时间线上。
   *
   * ⚠️ 子片段 id 一律重发（见 shared/compound.js 里 ungroupCompound 的说明）：
   *    同一个复合片段可能被复制过，各自解除时撞 id 会让"删一个动两个"跟着草稿走。
   */
  const ungroupClip = useCallback(
    (clipId) => {
      const target = clipsRef.current.find((item) => item.id === clipId)
      if (!target || !isCompound(target)) {
        toast.bad('这个片段不是复合片段')
        return
      }
      if ((trackStateRef.current.locked || []).includes(target.track)) {
        toast.bad('该轨已锁定，先解锁再解除复合')
        return
      }
      const kids = ungroupCompound(target, () => nextId('clip'))
      if (!kids.length) {
        toast.bad('复合片段内部是空的，没法解除')
        return
      }
      commitClips((list) => [...list.filter((item) => item.id !== clipId), ...kids])
      setSelection({ type: 'clip', clipId: kids[0].id, clipIds: [kids[0].id], assetId: kids[0].assetId || '' })
      toast.good(`已解除复合片段，还原 ${kids.length} 段`)
    },
    [commitClips, toast]
  )

  /* ------------------------- 时间区域（区间操作） -------------------------
     「时间区域」= 时间线上框出来的一段 [start, end)，对它做整体操作：
     删除（后面内容前移）/ 复制 / 剪切 / 粘贴到播放头 / 只导出这一段。
     算术全在 shared/region.js（导出侧读的是同一份），这里只负责状态与提示。 */

  /** 当前**生效**的区域：两端都标了、且够长。半开（只标了入点）时返回 null */
  const liveRegion = useCallback(() => {
    const raw = regionRef.current
    if (!raw || raw.end === null || raw.end === undefined) return null
    return normalizeRegion(raw.start, raw.end)
  }, [])

  /**
   * 标入点 / 出点（标尺 Shift+拖动、I / O 键、拖两端手柄，全部走这一个入口）。
   *
   * 语义三条，都是为了"不替用户做决定"：
   *   · 标入点：只保留终点（若终点在入点之后），否则终点清空 —— **不编一个长度**；
   *   · 标出点：没有区域时入点默认 0（"从头到播放头"），有区域时保留入点；
   *   · 出点比入点短 ⇒ 报一句，不改状态。静默忽略会让人以为按键没接上。
   */
  const setRegionRange = useCallback(
    (a, b) => {
      const start = Math.max(0, Number(a) || 0)
      const end = Math.max(0, Number(b) || 0)
      const merged = normalizeRegion(start, end)
      if (!merged) {
        /* 拖得太短 / 点了一下：当作"取消区域"，不弹提示（Shift+点错一下不该被教育） */
        setRegion(null)
        return false
      }
      setRegion(merged)
      return true
    },
    []
  )

  const markRegion = useCallback(
    (which, at) => {
      const t = Math.max(0, Number(at) || 0)
      const cur = regionRef.current
      if (which === 'in') {
        const keepEnd = cur && cur.end !== null && cur.end !== undefined && cur.end > t + 0.05 ? cur.end : null
        setRegion({ start: Number(t.toFixed(4)), end: keepEnd })
        toast(keepEnd ? '已标入点' : '已标入点：把播放头移到结束处，按 O 标出点')
        return
      }
      const start = cur && cur.start !== null && cur.start !== undefined ? Number(cur.start) : 0
      if (!(t - start >= 0.05)) {
        toast.bad('出点必须在入点之后（至少 0.05 秒）')
        return
      }
      setRegion({ start: Number(start.toFixed(4)), end: Number(t.toFixed(4)) })
      toast.good(`已标出点（区间 ${(t - start).toFixed(2)} 秒）`)
    },
    [toast]
  )

  /**
   * 录音落成片段：素材入库 + 音频轨在**播放头**处插一段。
   *
   * 为什么不信 asset.duration 就够：MediaRecorder 产的 webm 没有时长，
   * 主进程拿的是渲染层测出来的墙钟时间（见 recording:save 的注释）；
   * 这里再兜一层（asset.duration 优先，缺了用调用方给的 duration），
   * 免得某一边将来改了字段，落成 0 秒 —— 0 秒片段在时间线上是一根看不见的细线。
   */
  const addRecordingClip = useCallback(
    (row, measured) => {
      if (!row || !row.url) {
        toast.bad('录音已保存，但拿不到可播放的地址')
        return
      }
      const seconds = Number(row.duration) > 0 ? Number(row.duration) : Number(measured) > 0 ? Number(measured) : 0
      if (!(seconds > 0.05)) {
        toast.bad('录音太短，没有插入到时间线')
        return
      }
      const asset = {
        id: nextId('asset'),
        name: row.name || '配音',
        kind: 'audio',
        url: row.url,
        path: row.path || '',
        size: row.size || 0,
        source: 'local',
        duration: seconds,
        createdAt: new Date().toISOString()
      }
      setAssets((prev) => [asset, ...prev.filter((item) => item.url !== asset.url)])
      const id = nextId('clip')
      const start = Math.max(0, Number(playhead) || 0)
      commitClips((list) => [
        ...list,
        {
          id,
          track: 'audio',
          assetId: asset.id,
          name: asset.name,
          url: asset.url,
          path: asset.path,
          kind: 'audio',
          text: '',
          start,
          duration: Number(seconds.toFixed(3)),
          offset: 0,
          /* 源就是这一段本身：往后拖没有更多内容（拖出去会是静音，长度上限靠它兜） */
          sourceDuration: Number(seconds.toFixed(3))
        }
      ])
      setSelection({ type: 'clip', clipId: id, clipIds: [id], assetId: asset.id })
      toast.good(`已插入配音片段（${seconds.toFixed(2)} 秒）到 ${timecode(start, false)}`)
    },
    [commitClips, playhead, toast]
  )

  /** 删除区域：区间内容消失，后面的内容整体前移（ripple） */
  const deleteRegion = useCallback(() => {
    const target = liveRegion()
    if (!target) {
      toast('先在标尺上 Shift + 拖动框出一段区间（或按 I / O 标入点与出点）')
      return
    }
    if (!clipsRef.current.length) {
      toast('时间线还是空的，没有可删的内容')
      return
    }
    const span = regionSpan(target)
    commitClips((list) => removeRegion(list, target))
    /* 标记也要跟着结算：区间内的删掉、区间之后的左移 span。
       只挪片段不挪标记，标记就会"指到别的画面上"——踩点标记从此错开 span 秒。 */
    setMarkers((list) =>
      (Array.isArray(list) ? list : [])
        .filter((at) => at < target.start - 1e-4 || at > target.end + 1e-4)
        .map((at) => (at > target.end ? Math.max(0, Number((at - span).toFixed(4))) : at))
    )
    setRegion(null)
    toast.good(`已删除 ${timecode(target.start, false)} – ${timecode(target.end, false)} 的区间：后面内容前移 ${span.toFixed(2)} 秒`)
  }, [commitClips, liveRegion, toast])

  /** 复制区域内容（进会话内剪贴板）。返回取到的内容，剪切复用它避免算两遍 */
  const copyRegionContent = useCallback(() => {
    const target = liveRegion()
    if (!target) {
      toast('先在标尺上 Shift + 拖动框出一段区间（或按 I / O 标入点与出点）')
      return null
    }
    const picked = copyRegionOf(clipsRef.current, target)
    if (!picked.items.length) {
      toast('这段区间里没有片段')
      return null
    }
    setRegionClip(picked)
    toast.good(`已复制 ${picked.items.length} 段（${picked.span.toFixed(2)} 秒）`)
    return picked
  }, [liveRegion, toast])

  /** 剪切区域：复制 + 删除。中途失败（区间里没内容）就什么都不做，不删空 */
  const cutRegionContent = useCallback(() => {
    const picked = copyRegionContent()
    if (!picked) return
    const target = liveRegion()
    if (!target) return
    const span = regionSpan(target)
    commitClips((list) => removeRegion(list, target))
    setMarkers((list) =>
      (Array.isArray(list) ? list : [])
        .filter((at) => at < target.start - 1e-4 || at > target.end + 1e-4)
        .map((at) => (at > target.end ? Math.max(0, Number((at - span).toFixed(4))) : at))
    )
    setRegion(null)
  }, [commitClips, copyRegionContent, liveRegion])

  /** 粘贴到播放头。落点由播放头决定，方向键移一下再粘 = 常用的"盖到某处" */
  const pasteRegionContent = useCallback(() => {
    if (!regionClip || !regionClip.items.length) {
      toast('还没有复制过区间内容：先框一段区间，点「复制」')
      return
    }
    const at = Math.max(0, Number(playhead) || 0)
    const fresh = pasteRegionAt(regionClip.items, at, () => nextId('clip'))
    commitClips((list) => [...list, ...fresh])
    setSelection({ type: 'clip', clipId: fresh[0].id, clipIds: fresh.map((item) => item.id), assetId: fresh[0].assetId || '' })
    toast.good(`已粘贴 ${fresh.length} 段到播放头（${timecode(at, false)}）`)
  }, [commitClips, playhead, regionClip, toast])

  /** 「只导出区域」：打开导出面板，面板会带上这个区间（载荷 options.range） */
  const exportRegion = useCallback(() => {
    if (!liveRegion()) {
      toast('先在标尺上框出一段区间')
      return
    }
    setExportOpen(true)
  }, [liveRegion, toast])

  /**
   * 新建多机位片段（右键菜单「新建多机位」）。
   *
   * 与复合片段不同，这里**必须至少两路**：一路的"多机位"在画面上与普通片段完全等价，
   * 却多出机位面板与切换键这两个没有意义的入口（点了只会切到同一路，什么都没发生）。
   * 所以不足两路时明确报错，不偷偷合成。
   *
   * 机位之间的"同步"取各片段在时间线上的相对起点（见 shared/multicam.js 的说明）——
   * 这要求用户先把两路摆到画面对得上，界面上也是这么提示的。
   */
  const createMulticamClip = useCallback(
    (ids) => {
      const wanted = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
      if (wanted.length < 2) {
        toast.bad('多机位至少要选两段画面素材（Ctrl + 点选可多选）')
        return
      }
      const chosen = clipsRef.current.filter((item) => wanted.includes(item.id))
      const locked = chosen.find((item) => (trackStateRef.current.locked || []).includes(item.track))
      if (locked) {
        toast.bad(`「${locked.name}」所在轨道已锁定，先解锁再建多机位`)
        return
      }
      const noSource = chosen.filter((item) => !(item.path || item.url))
      if (noSource.length) {
        toast.bad('选中的片段里有不能当机位的（复合片段 / 字幕没有可解码的画面源）')
        return
      }
      const built = makeMulticam(clipsRef.current, wanted, { id: nextId('clip') })
      if (!built) {
        toast.bad('这些片段对不上：没有公共的重叠区间（或时长太短），没法建成多机位')
        return
      }
      commitClips(() => [...built.rest, built.clip])
      setSelection({ type: 'clip', clipId: built.clip.id, clipIds: [built.clip.id], assetId: '' })
      toast.good(`已建立多机位片段（${built.clip.multicam.angles.length} 路，${built.clip.duration.toFixed(2)} 秒）`)
    },
    [commitClips, toast]
  )

  /**
   * 切换机位：在播放头所在处落一个切换点（之后一直用这一路，直到下一个切换点）。
   *
   * ⚠️ 播放头 → **节目时间**的换算必须乘倍速：`cuts[].at` 是内部秒，播 2 倍速时
   *    时间线上过 1 秒、节目里已经走了 2 秒。少乘这一下，切换点会落在"比按下的地方早一半"，
   *    而成片与预览**同错**（同错最难查：画面上看是"切早了"，但怎么对数都对不上）。
   */
  const switchMulticamAngle = useCallback(
    (clipId, angleIndex, at = playhead) => {
      const target = clipsRef.current.find((item) => item.id === clipId)
      if (!target || !isMulticam(target)) {
        toast.bad('这个片段不是多机位片段')
        return
      }
      if ((trackStateRef.current.locked || []).includes(target.track)) {
        toast.bad('该轨已锁定，先解锁再切换机位')
        return
      }
      const span = multicamSpan(target)
      const rate = clipSpeed(target) || 1
      /* 播放头在多机位片段之外时夹到两端：落在片段上就是"从这一刻起用这一路"，
         夹到边界等于"从片段开头 / 把最后一个切换点改掉"，都是用户能预期的结果。 */
      const local = (Number(at) - Number(target.start)) * rate + Number(target.offset || 0)
      const p = Math.min(span, Math.max(0, local))
      const patch = setMulticamCut(target, p, angleIndex)
      if (!patch) return
      commitClips((list) => list.map((item) => (item.id === clipId ? { ...item, ...patch } : item)))
      const angle = target.multicam.angles[angleIndex]
      toast.good(`已切到「${angle?.name || `机位 ${angleIndex + 1}`}」（节目 ${p.toFixed(2)} 秒处）`)
    },
    [commitClips, playhead, toast]
  )

  /** 取声方式：单一机位 / 跟着画面切 / 静音（三种在展开时走三条不同的路） */
  const changeMulticamAudio = useCallback(
    (clipId, mode, angleIndex) => {
      const target = clipsRef.current.find((item) => item.id === clipId)
      if (!target || !isMulticam(target)) return
      const patch = setMulticamAudio(target, mode, angleIndex)
      if (!patch) return
      commitClips((list) => list.map((item) => (item.id === clipId ? { ...item, ...patch } : item)))
    },
    [commitClips]
  )

  /**
   * 解除多机位：把**当前切换结果**摊回时间线（每个区间一段画面 + 一条取声音轨）。
   * id 一律重发，理由与解除复合完全相同（同一个多机位可能被复制过多份）。
   */
  const ungroupMulticamClip = useCallback(
    (clipId) => {
      const target = clipsRef.current.find((item) => item.id === clipId)
      if (!target || !isMulticam(target)) {
        toast.bad('这个片段不是多机位片段')
        return
      }
      if ((trackStateRef.current.locked || []).includes(target.track)) {
        toast.bad('该轨已锁定，先解锁再解除多机位')
        return
      }
      const kids = ungroupMulticam(target, () => nextId('clip'))
      if (!kids.length) {
        toast.bad('多机位片段是空的，没法解除')
        return
      }
      commitClips((list) => [...list.filter((item) => item.id !== clipId), ...kids])
      setSelection({ type: 'clip', clipId: kids[0].id, clipIds: [kids[0].id], assetId: kids[0].assetId || '' })
      toast.good(`已解除多机位，还原 ${kids.length} 段`)
    },
    [commitClips, toast]
  )

  /**
   * 在 `at` 秒处把某个片段切成两段。
   *
   * 分割按钮、快捷键 Ctrl+B、时间线右键菜单三处都走这一条路径 ——
   * 分成两份实现迟早会出现「按钮切出来的右半段 offset 对、右键切出来的不对」这种鬼问题。
   * `clipId` 为空时退化成「播放头下的那个片段」。
   */
  const splitClipAt = useCallback(
    (clipId, at) => {
      const current = clipsRef.current
      const target = clipId
        ? current.find((item) => item.id === clipId)
        : current.find((item) => item.start < at && at < item.start + item.duration)
      if (!target) {
        toast('把播放头移到片段中间，或先选中一个片段再分割')
        return false
      }
      // 锁定轨拒分割：与拖动/修剪/删除同一套口径，拒绝时说明原因
      if (trackStateRef.current.locked.includes(target.track)) {
        toast.bad(`「${target.track}」轨道已锁定，解除锁定后才能分割`)
        return false
      }
      if (at <= target.start + 0.05 || at >= target.start + target.duration - 0.05) {
        toast.bad('播放头不在这个片段内部，无法分割')
        return false
      }
      /**
       * 右半段的入点要跟着往右挪，否则导出时它会把源文件从头再播一遍。
       *
       * ⚠️ 挪多少要**乘倍速**：offset 是源素材里的秒数，而 `at - start` 是时间线上的秒数。
       *    2 倍速片段上往右切 1 秒，源里已经过去了 2 秒 —— 少乘这一下，
       *    切出来的右半段会从"比正确位置早一半"的地方开始播（画面回头跳一下，且不报错）。
       *    有曲线时按曲线累计面积算（`curveSourceTime`），与单段的源消耗同一个口径。
       */
      const base = Number(target.offset) || 0
      const cutOffset = readCurve(target)
        ? curveSourceTime(target, at)
        : base + (at - target.start) * clipSpeed(target)
      const left = { ...target, duration: at - target.start }
      const right = {
        ...target,
        id: nextId('clip'),
        start: at,
        duration: target.start + target.duration - at,
        offset: Number(Number(cutOffset).toFixed(4))
      }
      commitClips((list) => list.flatMap((item) => (item.id === target.id ? [left, right] : [item])))
      // 选中右半段：用户接着多半就是想修剪它
      setSelection({ type: 'clip', clipId: right.id, clipIds: [right.id], assetId: right.assetId })
      toast.good('已在播放头处分割')
      return true
    },
    [commitClips, toast]
  )

  /** 工具栏按钮 / Ctrl+B 用：优先切当前选中的片段，否则切播放头下的那个 */
  const splitClip = useCallback(() => {
    splitClipAt(selection?.clipId || '', playhead)
  }, [playhead, selection, splitClipAt])

  /**
   * 按场景分割（右键菜单）。
   *
   * 三步：主进程 ffmpeg 检测 → 渲染层把源秒换算成时间线秒（shared/scenes.js）
   * → 在片段表上切成若干段。每一步都要"说不出来原因就不动手"：
   *   · 倒放 / 曲线变速片段不支持（换算口径对不齐，见 shared/scenes.js 的说明）；
   *   · 图片、文字素材没有"场景"可言；
   *   · 一个切点都没检出来是**合法结果**，要如实说"整段就是一个镜头"，
   *     不能静默什么都不做 —— 那样用户会以为按钮坏了。
   */
  const splitByScenes = useCallback(
    async (clipId) => {
      const target = clipsRef.current.find((item) => item.id === clipId)
      if (!target) return
      const support = scenesTable.sceneSupport(target)
      if (!support.ok) {
        toast.bad(support.reason)
        return
      }
      if (target.kind === 'image' || target.kind === 'text' || !target.url) {
        toast.bad('这一段没有可分析的画面（图片 / 文字素材没有场景切换）')
        return
      }
      if (trackStateRef.current.locked.includes(target.track)) {
        toast.bad('轨道已锁定，解除锁定后才能分割')
        return
      }
      toast('正在分析场景…')
      let result = null
      try {
        result = await window.yjai.media.scenes({
          url: target.url,
          threshold: scenesTable.DEFAULT_THRESHOLD,
          duration: Number(target.sourceDuration) || 0
        })
      } catch (error) {
        toast.bad(`场景检测失败：${(error && error.message) || '未知原因'}`)
        return
      }
      if (!result || !result.ok) {
        toast.bad((result && result.error) || '场景检测失败')
        return
      }
      const cuts = scenesTable.timelineCuts(target, result.scenes)
      if (!cuts.length) {
        toast('这一段没有检测到场景切换（整段就是一个镜头）')
        return
      }
      commitClips((list) =>
        list.flatMap((item) => (item.id === target.id ? scenesTable.splitByScenes(target, cuts, () => nextId('clip')) : [item]))
      )
      toast.good(`已按场景分割为 ${cuts.length + 1} 段`)
    },
    [commitClips, toast]
  )

  /* ------------------------------ 本地导入 ------------------------------ */

  /**
   * 把一批本地文件收进媒体库。
   * 元数据（时长/分辨率）逐个探测，任一失败都只影响那一个素材，不影响整批导入。
   */
  const importLocalMedia = useCallback(
    async (rows) => {
      const list = (rows || []).filter(Boolean)
      if (!list.length) return []
      const metas = await Promise.all(list.map((row) => probeMedia(row.url, row.kind)))
      const assets = localAssetsFrom(list, metas)
      // 同一个文件拖两次不重复入队
      setAssets((prev) => [
        ...assets,
        ...prev.filter((item) => !assets.some((added) => added.url === item.url))
      ])
      // 导入完把界面切回「素材」区 —— 刚导进来的东西必须立刻看得见。
      //
      // ⚠️ 这里原来是 `setRail('media')`，那是一次界面改版之前的残留：当年左栏是
      // 图标 Rail，改版后中栏内容改由 wbTab / wbNode 决定，`setRail` 这个名字
      // **全文件从未定义**。后果是导入成功后立刻抛 ReferenceError ——
      // 素材其实已经进库了（上一行 setAssets 已经跑完），但紧随其后的 toast
      // 和调用方的 setSelection 全都不执行：用户只看到素材凭空变多、没有任何反馈，
      // 自动选中也失效，属性面板一直是空的。
      //
      // 这个缺陷能活下来，是因为唯一会真跑这条路径的断言一直没跑：
      // media-import-e2e 里「导入 → 媒体库 → 自动选中」那 6 条因为 contextBridge
      // 冻结而恒为 SKIP，而静态检查器又漏掉了这个名字（详见 tools/check-imports.mjs
      // 里 set 前缀那条注释）。是真实影片 E2E 第一次真的按下了「导入」才逼出来的。
      setWbTab('media')
      setWbNode(defaultNodeOf('media'))
      const skipped = (rows || []).length - list.length
      toast.good(
        skipped > 0
          ? `已导入 ${assets.length} 个素材，跳过 ${skipped} 个不支持的文件`
          : `已导入 ${assets.length} 个素材`
      )
      return assets
    },
    [toast]
  )

  const handlePickMedia = useCallback(async () => {
    /* mode 必须在**选文件之前**就定：主进程拿到对话框结果后立刻要决定
       "引用原路径"还是"复制一份到素材目录"（见 media:pick 的注释）。 */
    const rows = await pickMedia({ mode: importMode })
    if (!rows.length) return
    const created = await importLocalMedia(rows)
    // 导入后自动选中第一个，属性面板能立刻显示它
    if (created[0]) setSelection({ type: 'asset', assetId: created[0].id })
  }, [importLocalMedia, importMode])

  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  /**
   * 这次拖拽带的是文件吗？
   * 常规来源（资源管理器、浏览器另存）都会给 types 里塞 'Files'，但程序构造的
   * DataTransfer 往往只填 items，types 是空的。两个信号都认，避免漏判。
   * 判掉非文件拖拽是必要的：否则在输入框里拖动选中文字也会弹出导入遮罩。
   */
  const dragHasFiles = (event) => {
    const dt = event.dataTransfer
    if (!dt) return false
    if (Array.from(dt.types || []).includes('Files')) return true
    return Array.from(dt.items || []).some((item) => item.kind === 'file')
  }

  const handleDragEnter = useCallback((event) => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }, [])

  const handleDragOver = useCallback((event) => {
    if (!dragHasFiles(event)) return
    // 不 preventDefault 的话浏览器会拒收，drop 事件根本不会触发
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }, [])

  const handleDrop = useCallback(
    async (event) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files || [])
      if (!files.length) return
      const paths = files.map((file) => pathForFile(file)).filter(Boolean)
      if (!paths.length) {
        toast.bad('没能读到文件路径，请改用「导入素材」按钮')
        return
      }
      await importLocalMedia(await statMedia(paths))
    },
    [importLocalMedia, toast]
  )

  /* ---------------------- 参数类操作（滤镜 / 转场 / 文字） ---------------------- */

  /**
   * 给单个片段打补丁。
   *
   * 滤镜、转场、强度这些参数原先没有写入口 —— 面板里就算列出来也落不到时间线上，
   * 属于"看着有、点了没用"。统一走这里，并且**经过 commitClips**，
   * 所以每一次应用都能 Ctrl+Z 回退（参数改动同样是时间线改动）。
   */
  /**
   * 改片段上的一个或几个字段。
   *
   * ⚠️ `speed` 是**唯一需要连带改别的字段**的一项，所以在这里统一处理：
   *    倍速换了，片段在时间线上的占位也要跟着变（源消耗守恒，见 trim.js 的 speedPatch）。
   *    放到调用处去做，迟早有一个入口只写了 `speed` 忘了改 `duration` ——
   *    那种片段预览会照 2 倍速播、时间线上却还占着原长，
   *    于是后面的片段被它压住一截，而界面上没有任何提示。
   *
   * ⚠️ 还有第二件事：**后面的片段要跟着平移**（ripple）。
   *    以前只改自己的 duration —— 变速把片段拉长（曲线让整段变慢、或设成 0.5x）之后，
   *    它会**盖住后面那一段**：同一条轨上两个剪片叠在一起，时间线上一眼看去像坏了，
   *    而播放时又是"上面那个赢"，用户根本不知道为什么后半段没播。
   *    现在按 delta 把**同轨、原本在它之后**的片段整体平移，间隙与重叠都不会凭空出现。
   *    只动同轨：跨轨（配乐、字幕、画中画）本来就按绝对时间摆放，不该被连带推走。
   */
  const patchClip = useCallback(
    (clipId, patch) => {
      if (!clipId) return
      commitClips((list) => {
        const target = list.find((item) => item.id === clipId)
        if (!target) return list
        const withSpeed = Object.prototype.hasOwnProperty.call(patch || {}, 'speed')
        const extra = withSpeed ? speedPatch(target, patch.speed) : null
        if (!extra) {
          return list.map((item) => (item.id === clipId ? { ...item, ...patch } : item))
        }
        const oldEnd = Number(target.start || 0) + Number(target.duration || 0)
        const delta = Number(extra.duration) - Number(target.duration)
        return list.map((item) => {
          if (item.id === clipId) return { ...item, ...patch, ...extra }
          if (Math.abs(delta) > 1e-6 && item.track === target.track && Number(item.start) >= oldEnd - EPSILON) {
            return { ...item, start: Number((Number(item.start) + delta).toFixed(3)) }
          }
          return item
        })
      })
    },
    [commitClips]
  )

  /**
   * 从 `from` 往后找第一个"没被字幕占住"的时刻。
   *
   * 为什么不是直接放末尾（原来就是末端追加）：字幕要立刻看得见，
   * 而预览显示的是**播放头**那一刻的字幕。放在末尾等于"加完什么都没发生"。
   * 所以新片段落在播放头上；只有当播放头已经被别的字幕占住时才往后让 ——
   * 让的时候要**跳过整条重叠链**（逐项前进），否则第二条会落在第一条的中间、互相盖住。
   */
  const freeTextStart = (list, from) => {
    let cursor = Math.max(0, Number(from) || 0)
    const lane = list
      .filter((item) => item.track === 'text')
      .sort((a, b) => Number(a.start) - Number(b.start))
    for (const item of lane) {
      const end = Number(item.start) + Number(item.duration)
      if (Number(item.start) <= cursor + EPSILON && cursor < end - EPSILON) cursor = end
    }
    return Number(cursor.toFixed(3))
  }

  /** 播放头正下方那条字幕（没有就是 null）——「换样式」优先作用在它身上 */
  const textClipAt = useCallback(
    (list, at) =>
      (list || []).find(
        (item) =>
          item.track === 'text' &&
          at >= Number(item.start) - EPSILON &&
          at < Number(item.start) + Number(item.duration) - EPSILON
      ) || null,
    []
  )

  /**
   * 「文字」与「字幕」面板：把一条文字/字幕加到字幕轨，或给已有的那条换样式。
   *
   * 两种行为由 preset.apply 决定，**这是刻意的**，对应参考里两个不同的页面：
   *   · apply: 'add'     —— 文字模板 / 字幕模板：**新增**一段（参考 Subtitles_Materials 是素材页）
   *   · apply: 'restyle' —— 字幕样式：作用在**选中/播放头处那一条**上
   *                         （参考 PropertyPanel_SubtitleStyle 就是个属性面板）
   * 少了后者会出现"点样式只会不断堆新字幕"，而不是"这条字幕变了个样子"。
   */
  const addTextClip = useCallback(
    (preset) => {
      if (!preset) return
      const styleKey = textStyleDef(preset.style).key
      const restyle = preset.apply === 'restyle'
      const wantText = preset.sample || '文字'

      if (restyle) {
        /* ⚠️ 这里**不能用 `selectedClip`**：它声明在本函数之后的那一段"派生数据"里，
           一旦写进 useCallback 的依赖数组，就在 render 阶段命中暂时性死区直接抛错
           （不是在点击时才炸，是每次渲染都炸）。用 selection 里的 id 现查一遍。 */
        const selId = selection?.clipId
        const selectedText = selId
          ? clipsRef.current.find((item) => item.id === selId && item.track === 'text') || null
          : null
        const target = textClipAt(clipsRef.current, playhead) || selectedText
        if (target) {
          commitClips((list) => list.map((item) => (item.id === target.id ? { ...item, textStyle: styleKey } : item)))
          setSelection({ type: 'clip', clipId: target.id })
          toast.good(`「${target.name}」已换成「${textStyleDef(styleKey).label}」样式`)
          return
        }
        /* 没有可换的目标就退回新增 —— 但要说清楚，不能让用户以为"没生效" */
        toast(`字幕轨上还没有字幕，已新建一条并套用「${textStyleDef(styleKey).label}」`)
      }

      const duration = Math.max(0.5, Number(preset.duration) || 3)
      let created = null
      commitClips((list) => {
        const start = freeTextStart(list, playhead)
        created = {
          id: nextId('clip'),
          track: 'text',
          assetId: '',
          name: preset.label || wantText,
          url: '',
          path: '',
          kind: 'text',
          text: wantText,
          textSize: Number(preset.size) || 32,
          /* 样式 key 落在片段上，预览叠加层按它渲染（见 Stage 的 overlays） */
          textStyle: styleKey,
          start,
          duration,
          offset: 0,
          sourceDuration: 0
        }
        return [...list, created]
      })
      if (created) {
        setSelection({ type: 'clip', clipId: created.id })
        /* 把播放头挪到新片段起点：否则"加了一条字幕"会停在别处，
           预览里什么都不显示 —— 用户会认为这个按钮坏了。 */
        setPlayhead(created.start)
      }
      if (!restyle) toast.good(`已把「${preset.label || '文字'}」加到字幕轨`)
    },
    [commitClips, playhead, selection, textClipAt, toast]
  )

  /**
   * 「智能剪辑 → 平均分段」：把视频轨第一段按当前时长平均切成 n 段。
   * 每段的 offset 必须跟着往后走 —— 否则切完每一段都从源文件头开始播，
   * 画面会在接缝处跳回去（这正是 trim.js 里那条「剪左端时 offset 必须跟着走」的不变量）。
   */
  const splitEvenly = useCallback(
    (count) => {
      const n = Math.max(2, Math.min(12, Math.round(Number(count) || 4)))
      let applied = 0
      commitClips((list) => {
        const video = list.filter((item) => item.track === 'video').sort((a, b) => a.start - b.start)
        const target = video[0]
        if (!target) return list
        const piece = Number((target.duration / n).toFixed(3))
        if (piece < MIN_CLIP_SECONDS) return list
        const rest = list.filter((item) => item.id !== target.id)
        const parts = []
        for (let i = 0; i < n; i += 1) {
          parts.push({
            ...target,
            id: i === 0 ? target.id : nextId('clip'),
            start: Number((target.start + i * piece).toFixed(3)),
            duration: piece,
            offset: Number((Number(target.offset || 0) + i * piece).toFixed(3))
          })
        }
        applied = n
        return [...rest, ...parts].sort((a, b) => a.start - b.start)
      })
      if (applied) toast.good(`已把第一段平均切成 ${applied} 段`)
      else toast.bad(`切不了：单段会短于最短片段时长（${MIN_CLIP_SECONDS}s）`)
    },
    [commitClips, toast]
  )

  /** 「智能剪辑 → 消除空档」：每条轨各自向前贴紧 */
  const closeGaps = useCallback(() => {
    commitClips((list) => {
      /* ⚠️ 叠加轨是**独立的一条轨**：混进视频轨一起贴紧的话，
         画中画会被主画面的片段推着走，时间轴上看着没动、成片里位置全错。 */
      const lanes = [
        list.filter((item) => item.track === 'video'),
        list.filter((item) => item.track === 'overlay'),
        list.filter((item) => item.track === 'text'),
        list.filter((item) => item.track === 'audio')
      ]
      const out = []
      for (const lane of lanes) {
        let cursor = 0
        for (const clip of lane.sort((a, b) => a.start - b.start)) {
          out.push({ ...clip, start: Number(cursor.toFixed(3)) })
          cursor += clip.duration
        }
      }
      if (!out.length) return list
      return out.sort((a, b) => a.start - b.start)
    })
    toast.good('已消除片段之间的空档')
  }, [commitClips, toast])

  /** 「智能剪辑 → 清空字幕轨」：只删字幕，视频与音频留着 */
  const clearTextTrack = useCallback(() => {
    const selectedId = selection?.clipId
    const wasText = clipsRef.current.some((item) => item.id === selectedId && item.track === 'text')
    commitClips((list) => list.filter((item) => item.track !== 'text'))
    if (wasText) setSelection(null)
    toast('已清空字幕轨')
  }, [commitClips, selection, toast])

  /* ---------------------------- 派生数据 ---------------------------- */

  const tree = treeOf(wbTab)
  /* ⚠️ 必须走 nodeOf，不能只查 tree.items —— 左栏改成可折叠的树之后，
     「本地」「降噪」「视频超分」这类**子项**不在 items 里，查不到就会静默退回 root，
     中间栏于是显示"全部素材"，看着像点错了。 */
  const currentNode = nodeOf(wbTab, wbNode) || tree.root

  /**
   * 左栏选中项 → 中栏素材筛选。
   * 「素材」根项和未接入筛选的分类显示全部素材（不让用户以为素材丢了），
   * 「本地」只看本地导入，其余按该分类绑定的能力白名单过滤。
   */
  const filteredAssets = useMemo(() => {
    if (!currentNode) return assets
    if (currentNode.key === 'local') return assets.filter((item) => item.source === 'local')
    if (currentNode.caps?.length) return assets.filter((item) => currentNode.caps.includes(item.capability))
    /* 「素材库 → 视频库 / 图片库 / 动画库」按素材自身的产出类型筛（参考实拍的三个子项） */
    if (currentNode.kinds?.length) return assets.filter((item) => currentNode.kinds.includes(item.kind))
    return assets
  }, [assets, currentNode])

  const selectedClip = selection?.clipId ? clips.find((item) => item.id === selection.clipId) : null
  const selectedAsset = selection?.assetId ? assets.find((item) => item.id === selection.assetId) : null

  /**
   * 右栏那一排页签的选中值（`信息` / `画面` / `音频` / `变速` / `调整` / `字幕`）。
   *
   * 参考客户端里右栏那枚「信息」本来就是**页签形状**（深色块 + 紫色下划线），
   * 所以「画面 / 音频 / 变速 / 调整」也做成**同级页签排在它后面** —— 而不是画在
   * 片段信息块下面另起一行（那看着像"信息里的一块内容"，不是一排同级页签）。
   *
   * ⚠️ 页签清单的真源是 `inspectorTabsFor(clip)`（Inspector.jsx 导出）：
   *    这里只负责**画**，检查器负责**按同一个清单出内容**。各写一份迟早分叉 ——
   *    要么页签画了没内容，要么有内容没入口。
   * 换选中目标时回「信息」，否则"上一条点过调整、下一条打开还停在调整"，
   * 而新目标可能根本没有那一枚（字幕轨只有「字幕」）。
   */
  const [inspTab, setInspTab] = useState('info')
  useEffect(() => {
    setInspTab('info')
  }, [selectedClip?.id])

  /**
   * 播放头所在的片段（按轨道挑一个"该显示什么"的）。
   *
   * 预览区原来取的是 `selection.clipId`（选中的片段），于是：选中 A 按下播放，播放头走到 B 上，
   * 画面还是 A —— 而 Stage 里又在按播放头去 scrub A 的 currentTime，结果"A 的某一帧"被越拉越远。
   * 剪辑软件的预览必须跟随播放头，这也是播放器占位文案本来就承诺的行为（"跟随播放头显示画面"）。
   *
   * 优先级：视频/图片轨 → 字幕轨 → 音频轨。音频没有画面，只在完全没有画面时用来显示文件名。
   * 区间判定用**左闭右开**，否则两个首尾相接的片段会在接缝那一帧同时命中（同一帧画两个素材）。
   * EPSILON 是给浮点误差留的：拖到接缝上时 `start` 与 `start+duration` 可能差 1e-13。
   */
  /**
   * 「字幕片段」= 字幕轨上**由样式面板建出来的**那一种。
   *
   * 判据是 `assetId` 为空：从素材库/文字产物拖进来的文字片段一定带着 assetId，
   * 而样式面板建的字幕没有素材、只有一段文本 + 一个样式。
   * 这两类必须分开对待，否则会出现下面这个真实的坑：
   *   · 文字素材（有 assetId）—— 它的预览是"一张显示正文的占位卡"，历来如此
   *     （preview-follow-e2e 就是按这个断言的）；
   *   · 字幕（无 assetId）—— 它的预览**必须是一句话压在画面上**，
   *     不能退化成占位卡：那样用户点了"字幕样式"，看到的是一张写着文字的卡片，
   *     而不是一条带样式的字幕。
   */
  const isSubtitleClip = (clip) => Boolean(clip) && clip.track === 'text' && !clip.assetId

  const clipAtPlayhead = useMemo(() => {
    const hit = (lane) =>
      clips.find(
        (item) =>
          item.track === lane &&
          playhead >= item.start - EPSILON &&
          playhead < item.start + item.duration - EPSILON
      )
    /* ⚠️ 找"文字素材"时要**排除字幕片段**（见 isSubtitleClip）：
       字幕是要叠在画面上的一层，不该被当成"底下在播什么"。 */
    const textAsset = clips.find(
      (item) =>
        item.track === 'text' &&
        item.assetId &&
        playhead >= item.start - EPSILON &&
        playhead < item.start + item.duration - EPSILON
    )
    return hit('video') || textAsset || hit('audio') || null
  }, [clips, playhead])

  /**
   * 预览区要显示的素材：**播放头优先，选中兜底**。
   * 兜底是刻意的 —— 时间线有空白处（片段之间的间隙）时，选中某个片段仍然应该能看它一眼，
   * 否则点一下片段却什么都不显示，会让人以为选中失效了。
   *
   * 但**选中一条字幕时不能兜底**：字幕的画面表达是"叠在画布上"，不是"自己当素材"。
   * 兜底了就会出现"点一下字幕，画面上出现一张打字条的卡片"这种四不像。
   */
  /** 空白处的兜底片段（= 选中的那一段）由 composite 的 fallbackClip 用同一条口径取，见下 */

  /**
   * 属性面板必须跟**选中的片段**，不能跟播放头 —— 否则会出现"上面显示 A 的元数据、
   * 下面的滑杆在改 B"这种自相矛盾的状态。改预览区时别顺手把它也改成 previewAsset。
   */
  const selectedClipAsset = selectedClip
    ? assets.find((item) => item.id === selectedClip.assetId) || selectedClip
    : selectedAsset
  /**
   * 下面这一坨（字幕叠加 / 转场交叠 / 音频轨 / 叠加轨）现在统一由 `composite` 算，
   * 细节与理由写在 composite.js 里。三条**不能丢**的口径先记在这里，免得以后被改回去：
   *
   *   · **字幕分层**：从素材库拖进来的**文字素材**（有 assetId）是一张占位卡，
   *     样式面板建出来的**字幕**（无 assetId）**一律叠在画面上**。判据必须是片段本身的
   *     性质，不能是"底下有没有画面" —— 后者在**空时间线**上会一个字都不画，
   *     而空时间线恰恰是第一次用这个功能的默认状态（E2E 钉住了这条）。
   *   · **转场**：窗口 = [接缝 − 时长, 接缝)，判定复用 effectiveTransitions，
   *     与时间线角标、导出结算同一份规则 ⇒ 不会出现"角标画了但预览里没转"。
   *   · **音频轨 / 叠加轨**取此刻在场的**全部**片段（不是只取一条），
   *     重叠区间里每一条都要发声 / 都要画出来 —— 成片是这么混的，预览不能少。
   */
  /**
   * 这一帧的**合成结果**：画面上有哪几层、还要提前挂载哪几层、
   * 音频轨 / 叠加轨 / 字幕轨分别有哪些片段在场。
   *
   * 为什么这一大坨要搬进 composite.js 而不是继续写在这里：
   *   · 它是**纯算术**，错了一样不报错（少画一层、接缝黑一帧），
   *     抽出去才能被 `tools/composite-selftest.mjs` 在 node 里直接断言；
   *   · 以前"取播放头所在的那**一个**片段"的写法有个绕不过去的硬伤：
   *     整块预览只有一个 <video>，跨片段时是**换它的 src** ⇒ 每过一个接缝都要
   *     重新加载 + 重新解码 ⇒ 接缝处必黑一帧（转场尤其明显，因为后一段是在
   *     交叠窗口开始的那一刻才被新建出来的）。
   *     合成器按"热点窗口"提前把后一段挂进 DOM，切换只是换显示哪一层。
   *
   * 兜底片段（fallbackClip）：这一刻没有任何片段覆盖时退回**选中的那一段**，
   * 免得播放头扫过空白处画面就整片黑掉。字幕片段不能当兜底（它是一层叠加，
   * 不是"底下在播什么"），这条与改动前的口径一致，且被 E2E 钉住。
   */
  /**
   * 真正参与预览与导出的片段：停用的、隐藏轨上的、静音轨上的音频一律退出。
   * 时间线显示仍用全量 clips（停用的片段要留在原地变灰，不能凭空消失）。
   *
   * ⚠️ 顺序不能反：**先展开复合片段，再结算轨道开关**。
   *    反过来的话，复合片段内部放在音频轨上的那几段会绕过「外层视频轨被静音」
   *    这件事 —— 画面静了、声音还在响，而成片里也一样（两处同错，对不上账更难查）。
   */
  const activeClips = useMemo(
    () =>
      effectiveClips(
        /* 先摊平多机位（它内部不会包住复合片段），再摊平复合片段 —— 两道都跑，
           单独任一道都会让另一类容器原样漏进合成器（而成片里它们是"没有 url 的片段"）。 */
        expandCompounds(expandMulticams(clips, { trackState }), { trackState }),
        trackState
      ),
    [clips, trackState]
  )

  const composite = useMemo(
    () =>
      compositeAt(makePreviewClips(activeClips), previewAssets, playhead, {
        fallbackClip: isSubtitleClip(selectedClip) ? null : selectedClip
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeClips, previewAssets, previewQuality, proxyMap, playhead, selectedClip]
  )
  /* 给"按需生成代理"那条 effect 读：它按合成结果判断今天要用哪些素材，
     但不能把 composite 放进依赖（每帧都变，会让播放时不断重跑）。 */
  previewCompositeRef.current = composite

  /**
   * 按需为"这一刻真的用到的视频素材"准备代理。
   *
   * 判据是素材在**预览合成结果里出现过**（主层 / 叠加层 / 字幕素材），
   * 不是"素材库里有"。理由是后者会把整库素材都转一遍 —— 用户切个档位要等好几分钟。
   *
   * ⚠️ 这条 effect 必须住在 `activeClips` / `composite` **之后**：
   *    依赖数组在渲染期求值，写在前面会 TDZ（白屏 + 一行 ReferenceError）。
   */
  useEffect(() => {
    const height = proxyTable.heightFor(previewQuality)
    if (!height) return undefined
    if (!window.yjai?.media?.proxy) return undefined
    const wanted = new Set()
    /* 只给**视频**做代理：图片/字幕素材本来就是"一张图躺在那儿"，转成 mp4 只会更慢更糊；
       音频轨没有视频流，`scale` 滤镜会直接报错。 */
    for (const layer of previewCompositeRef.current?.layers || []) {
      if (layer.url && layer.kind === 'video') wanted.add(layer.url)
    }
    for (const layer of previewCompositeRef.current?.pip || []) {
      if (layer.url && layer.kind === 'video') wanted.add(layer.url)
    }
    let alive = true
    for (const sourceUrl of wanted) {
      /* 只给视频做代理：图片/字幕素材本来就是"一张图躺在那儿"，转成 mp4 只会更慢更糊 */
      const key = `${sourceUrl}|${height}`
      if (proxyAskedRef.current.has(key)) continue
      proxyAskedRef.current.add(key)
      setProxyMap((prev) => ({ ...prev, [sourceUrl]: { url: '', height, state: 'pending' } }))
      Promise.resolve(window.yjai.media.proxy({ url: sourceUrl, height }))
        .then((result) => {
          if (!alive) return
          if (!result || !result.ok || !result.url) {
            setProxyMap((prev) => ({ ...prev, [sourceUrl]: { url: '', height, state: 'failed' } }))
            /* 失败要**说出来**：静默回落原片会让人以为"这个档位没用" */
            toast.bad((result && result.error) || '生成预览代理失败，仍用原片')
            return
          }
          setProxyMap((prev) => ({ ...prev, [sourceUrl]: { url: result.url, height, state: 'ready' } }))
        })
        .catch(() => {
          if (!alive) return
          setProxyMap((prev) => ({ ...prev, [sourceUrl]: { url: '', height, state: 'failed' } }))
        })
    }
    return () => {
      alive = false
    }
    // 依赖 activeClips：换了片段、加了素材之后，"这一刻用到的素材"集合会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewQuality, activeClips, toast])

  /**
   * 主层对应的片段：角标（调色）与画面特效跟它走，口径与预览画面同一个来源。
   *
   * ⚠️ 复合片段的内部片段 id 是 `父id~子id`，在 clips 里**查不到** ——
   *    查不到时退回它归属的那个复合片段（ownerId）：用户选中的是外层那一个，
   *    角标与检查器本来就该跟着外层走。
   */
  const mainClip = useMemo(() => {
    if (!composite.main) return null
    const direct = clips.find((item) => item.id === composite.main.id)
    if (direct) return direct
    return composite.main.ownerId ? clips.find((item) => item.id === composite.main.ownerId) || null : null
  }, [clips, composite.main])

  const timelineDuration = useMemo(
    () => Math.max(30, ...clips.map((item) => item.start + item.duration)) + 10,
    [clips]
  )

  /* ------------------------- 设置项持久化 ------------------------- */

  /**
   * 保存自定义键位：内存 → localStorage（首屏缓存）→ 主进程 settings（权威）。
   *
   * 三处都要写，缺一个都会出问题：
   *   · 不写内存 → 界面改了但按下去还是老键位；
   *   · 不写 localStorage → 下次启动首帧拿不到，闪一下默认键位；
   *   · 不写主进程 → 清了浏览器数据（或者换 profile）键位就没了。
   *
   * `options.reset`：界面上的「恢复全部默认」走这条 —— 它是**清掉**两处存储、
   * 而不是把一份等于默认值的表写进去。两者功能上等价，但"清掉"能让
   * "用户到底有没有自定义过"这件事在磁盘上看得出来，排查时少一层猜测。
   */
  const changeKeymap = useCallback((next, options = {}) => {
    setKeymap(next)
    if (options.reset) {
      clearKeymap()
      Promise.resolve(setSetting('keymap', null)).catch(() => {})
      return
    }
    saveKeymap(next)
    Promise.resolve(setSetting('keymap', next)).catch(() => {})
  }, [])

  /**
   * 硬件加速开关。
   *
   * 只落盘，**不当场生效** —— `app.disableHardwareAcceleration()` 是启动期 API，
   * 运行中调它没有任何效果（而且不报错）。界面上会用 info.hardwareAcceleration
   * （实际生效值）与这个设置值做差，提示"重启后生效"并给一个重启按钮。
   * 谎称"已切换"比不做更糟：用户会以为开关坏了。
   */
  const changeHardwareAcceleration = useCallback(
    (next) => {
      const wanted = Boolean(next)
      setHardwareAcceleration(wanted)
      Promise.resolve(setSetting('hardwareAcceleration', wanted)).catch(() => {})
      toast(wanted ? '已设为开启硬件加速，重启后生效' : '已设为关闭硬件加速，重启后生效')
    },
    [toast]
  )

  /** 重启应用（硬件加速改完只能重启生效） */
  const restartApp = useCallback(() => {
    const bridge = typeof window !== 'undefined' ? window.yjai : null
    if (!bridge?.restart) {
      toast.bad('当前环境不支持自动重启，请手动退出后重新打开')
      return
    }
    Promise.resolve(bridge.restart()).catch(() => toast.bad('重启失败，请手动退出后重新打开'))
  }, [toast])

  /** 重命名项目：同时写进草稿（有草稿时立刻落盘，否则等自动保存） */
  const changeProjectName = useCallback(
    async (next) => {
      setProjectName(next)
      await setSetting('projectName', next)
      if (draftId) persistDraft({ silent: true, name: next })
    },
    [draftId, persistDraft]
  )

  /** 时间线名：与项目名同级，落主进程设置（草稿参数的「时间线名称」就改它） */
  const changeTimelineName = useCallback(async (next) => {
    setTimelineName(next)
    await setSetting('timelineName', next)
  }, [])

  /* ------------------------------ 渲染 ------------------------------ */

  const goHome = useCallback(() => setPage('home'), [])

  /** 全屏预览：作用于预览区元素本身（参考客户端也有独立的「全屏预览」模块） */
  /**
   * 全屏预览。
   *
   * ⚠️ 这里原来是**纯浏览器全屏**（`requestFullscreen()`），实测在自动化环境里
   * 它的 promise **既不 resolve 也不 reject**、`document.fullscreenElement` 始终是
   * null、界面什么都不发生（按钮点下去「毫无变化」，而 DOM 指纹法看不见这种失败）。
   * 对用户来说这和"没接"没区别。
   *
   * 所以改成两条腿：先走标准 API，**到点复核它到底生效了没有**（不能只挂 .then/.catch ——
   * 悬着的 promise 两样都不会走），没生效就退到渲染层自带的「预览铺满」模式
   * （`.wb-player` 变 fixed 覆盖层，见 workbench.css）。
   */
  const toggleFullscreen = useCallback(() => {
    if (typeof document === 'undefined') return

    if (fullscreen) {
      // 作废在途的兜底定时器，否则刚退出又被它翻回来
      fsSeqRef.current += 1
      if (document.fullscreenElement) Promise.resolve(document.exitFullscreen?.()).catch(() => {})
      setFullscreen(false)
      return
    }

    const seq = (fsSeqRef.current += 1)
    const el = playerRef.current
    if (!el || typeof el.requestFullscreen !== 'function') {
      setFullscreen(true)
      toast('已切换到铺满预览（当前环境不支持系统全屏）')
      return
    }

    Promise.resolve(el.requestFullscreen()).catch(() => {})
    setTimeout(() => {
      if (seq !== fsSeqRef.current) return // 期间用户又切了一次，别乱改状态
      if (document.fullscreenElement) return // 原生全屏真的生效了，不动
      setFullscreen(true)
    }, 700)
  }, [fullscreen, toast])

  /** 时间线内容的真实末尾（不含 timelineDuration 里给刻度留的余量） */
  const contentEnd = useCallback(
    () => clipsRef.current.reduce((max, item) => Math.max(max, item.start + item.duration), 0),
    []
  )

  /**
   * 动作 id → 处理函数。
   * 每次渲染整体重建：处理函数闭包里的 clips/selection 必须是最新的，
   * 否则「删除选中片段」会按上一帧的选中项动手。
   */
  actionHandlersRef.current = {
    undo,
    redo,
    split: splitClip,
    deleteClip: () => {
      const id = selection?.clipId
      if (!id) {
        toast('先在时间线上点一个片段，再按删除')
        return
      }
      removeClip(id)
    },
    toggleDisableClip: () => {
      const id = selection?.clipId
      if (!id) {
        toast('先在时间线上点一个片段，再按 V 停用 / 启用')
        return
      }
      toggleClipEnabled(id)
    },
    clearTimeline: () => {
      if (!clipsRef.current.length) {
        toast('时间线已经是空的')
        return
      }
      commitClips([])
      setSelection(null)
      toast('已清空时间线')
    },
    toggleSnap: () => setSnap((value) => !value),
    /* 时间区域的三条键：入点 / 出点落在**播放头**，删除按当前区间结算 */
    regionIn: () => markRegion('in', playhead),
    regionOut: () => markRegion('out', playhead),
    regionDelete: () => deleteRegion(),
    /* 处理函数每次渲染整体重建，所以这里读 playhead 拿到的就是当前值
       （不需要 ref 镜像 —— 那是在依赖表里不能放状态时才用的手段） */
    toggleMarker: () => toggleMarkerAt(playhead),
    prevMarker: () => {
      const next = stepMarker(markers, playhead, -1)
      if (next === null) return toast('播放头之前没有标记')
      setPlayhead(next)
    },
    nextMarker: () => {
      const next = stepMarker(markers, playhead, 1)
      if (next === null) return toast('播放头之后没有标记')
      setPlayhead(next)
    },
    playPause: () => setPlaying((value) => !value),
    toStart: () => setPlayhead(0),
    toEnd: () => setPlayhead(contentEnd()),
    prevFrame: () => setPlayhead((value) => stepFrame(value, -1)),
    nextFrame: () => setPlayhead((value) => stepFrame(value, 1)),
    prevSecond: () => setPlayhead((value) => Math.max(0, value - 1)),
    nextSecond: () => setPlayhead((value) => Math.min(timelineDuration, value + 1)),
    zoomIn: () => setZoom((value) => clampZoom(Number((value + 0.2).toFixed(2)))),
    zoomOut: () => setZoom((value) => clampZoom(Number((value - 0.2).toFixed(2)))),
    zoomReset: () => setZoom(1),
    fullscreen: toggleFullscreen,
    save: () => persistDraft({ silent: false }),
    openSettings: () => setDialog('settings'),
    importMedia: () => handlePickMedia(),
    exportVideo: () => setExportOpen(true)
  }

  /** 浏览器全屏是可被 Esc / F11 从外部退出的，状态要跟着真实值走 */
  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  /**
   * 全局快捷键派发。全工程**只挂这一个 keydown**，所有键位都由 keymap.js 决定。
   *
   * 三道闸，缺一不可：
   *   1. 弹窗开着时不派发（保存/设置除外）—— 否则在导出对话框里按空格会开始播放
   *   2. 焦点在输入框里时不派发 —— 否则素材重命名打不了空格
   *   3. editor 作用域的动作在首页不派发 —— 否则首页按空格也会开播
   */
  useEffect(() => {
    const onKey = (event) => {
      /**
       * 第 0 道闸：**两个"铺满整个界面"的视图态先用 Esc 退掉**。
       *
       * 放在所有闸门之前有两个原因：
       *   · 它们不是弹窗，下面那三个变量看不见它们；
       *   · 它们盖住了绝大部分界面，此时"焦点在输入框里"这类豁免没有意义。
       *
       * ⚠️ 但必须**让位给弹窗**：弹窗开着时 Esc 归 Modal 自己（见下面那道闸的注释），
       * 否则会从"关弹窗"变成"关全屏"，用户在导出对话框里按 Esc 会一脸问号。
       *
       * 这两个态的 Esc 原先散在组件里（Timeline 自己挂了一个 window 监听器），
       * 而按钮的 title 又都写着「Esc」—— 两颗 Esc 各自派发、互不知情，
       * 且弹窗开着时组件那个监听器照样在跑，正是本项目「全工程只挂一个 keydown」
       * 这条约定要防的事。现在统一在这里。
       */
      /**
       * 导出面板的 Esc：它是一层自定义 `.mask`（不是 Modal 组件），没有自己的键盘处理。
       * 不加这一条，从时间线「只导出」进来的用户按 Esc 会觉得界面卡住了 ——
       * 而这层遮罩盖住整个工作台，点错地方只会关掉面板、什么都不会发生。
       */
      /* 录音面板同理：它是自定义 mask，Esc 要能关；但**录音中不许关** ——
         关掉会把麦克风一起放掉，用户以为录好了，其实什么都没有。 */
      if (event.key === 'Escape' && recorderOpen && !dialog) {
        event.preventDefault()
        if (recorderBusy) {
          toast('正在录音，先按「停止录音」再关闭')
          return
        }
        setRecorderOpen(false)
        return
      }

      if (event.key === 'Escape' && exportOpen && !dialog) {
        event.preventDefault()
        setExportOpen(false)
        return
      }

      if (event.key === 'Escape' && !dialog && !exportOpen) {
        if (tlFull) {
          event.preventDefault()
          setTlFull(false)
          return
        }
        if (fullscreen) {
          event.preventDefault()
          toggleFullscreen()
          return
        }
        /* 两个"退出"都不适用时：**取消选中**。
           为什么要有：在预览里拖歪了、在时间线上点错了，参考客户端都是按 Esc 退出选中态；
           没有它，用户只能去点一下空白处 —— 而预览里几乎不存在"空白"（画面铺满画布）。
           ⚠️ 必须排在全屏之后：全屏时 Esc 的语义是"退出全屏"，不是"取消选中"。 */
        if (selection) {
          setSelection(null)
          return
        }
      }

      /**
       * 多机位切角：**1–9** 直接切到第 N 路（参考客户端也是这么按的，剪辑台上最顺手）。
       *
       * 三个前提，缺一个都会误伤：
       *   · 选中的片段确实是多机位（否则按 1 什么都不该发生，更不该去吃这个键）；
       *   · 不带修饰键（Ctrl+1 之类留给以后的一倍速等动作）；
       *   · 焦点不在输入框（重命名素材时敲数字必须是数字）。
       * ⚠️ 这条不算 keymap 里的动作：机位序号是**数据**（有几路随素材变），
       *    不是可重绑的键位；塞进 ACTIONS 会让「快捷键」页出现 9 条一样的条目。
       */
      if (
        !dialog &&
        !exportOpen &&
        page === 'editor' &&
        selectedClip &&
        isMulticam(selectedClip) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        /^[1-9]$/.test(event.key) &&
        !isTypingTarget(event.target)
      ) {
        const index = Number(event.key) - 1
        if (index >= selectedClip.multicam.angles.length) {
          event.preventDefault()
          toast.bad(`这个多机位只有 ${selectedClip.multicam.angles.length} 路`)
          return
        }
        event.preventDefault()
        switchMulticamAngle(selectedClip.id, index, playhead)
        return
      }

      const combo = comboOf(event)
      if (!combo) return
      const id = resolveAction(combo, keymap)
      if (!id) return
      const action = ACTIONS.find((item) => item.id === id)
      const handler = actionHandlersRef.current[id]
      if (!action || !handler) return

      const overlayOpen = Boolean(dialog || exportOpen)
      if (overlayOpen) {
        // 弹窗里只放行「全局」动作，且不吃 Esc（Esc 由 Modal 自己关）
        if (action.scope !== 'global' || isTypingTarget(event.target)) return
      } else if (isTypingTarget(event.target)) {
        return
      }
      if (action.scope === 'editor' && page !== 'editor') return

      /**
       * preventDefault 是必须的，而且**包括焦点在按钮上的情况**：
       * 空格在按钮上默认会触发该按钮的 click，如果我们不拦，
       * 用户点过播放键之后再按空格就会「我们自己切一次 + 按钮再切一次」= 看起来没反应。
       * 播放/暂停在剪辑软件里优先级高于「空格激活按钮」，这里按前者处理。
       */
      event.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    /* selectedClip / playhead / switchMulticamAngle 必须进依赖：它们变了而监听器不重挂，
       按数字键就会切到"上一次渲染时选中的那一段"和旧播放头上。 */
  }, [
    dialog,
    exportOpen,
    keymap,
    page,
    tlFull,
    fullscreen,
    toggleFullscreen,
    selection,
    selectedClip,
    playhead,
    switchMulticamAngle,
    toast,
    recorderOpen,
    recorderBusy
  ])

  /** 中栏内容：面板型分类走 SidePanels，其余走素材网格 */
  const renderCenterPane = () => {
    if (currentNode?.panel) {
      return (
        <section className="wb-media">
          <SidePanels
            mode={currentNode.panel}
            enhanceGroup={currentNode.enhance || null}
            refArtFamily={currentNode.refArt || null}
            materialGroup={currentNode.material || null}
            capabilityCode={currentNode.capability || null}
            textStyleGroup={currentNode.textStyle ?? null}
            stickerGroup={currentNode.sticker ?? null}
            clips={clips}
            projectName={projectName}
            assets={assets}
            selectedClip={selectedClip || null}
            onPatchClip={patchClip}
            activeClip={clipAtPlayhead}
            onAddTextClip={addTextClip}
            onAddToTimeline={addClipFromAsset}
            /* 本地工具（如「提取音频」）要把产物放回素材库 */
            onAddAsset={addAsset}
            onSplitEvenly={splitEvenly}
            onCloseGaps={closeGaps}
            onClearTextTrack={clearTextTrack}
            onImport={handlePickMedia}
            onSetBackdrop={(item) => setBackdrop(item.art)}
            /* 导出用结算后的片段表：停用的、隐藏/静音轨上的不进成片，
               与预览同一份口径（effectiveClips）—— 少这一步就是
               "预览里关掉了、成片里还在"。 */
            renderClips={activeClips}
          />
        </section>
      )
    }
    return (
      <MediaPanel
        mode="library"
        assets={filteredAssets}
        filterLabel={currentNode?.label}
        dragging={dragging}
        onAddToTimeline={addClipFromAsset}
        onAddAsset={addAsset}
        onRemoveAsset={removeAsset}
        onSelect={(asset) => setSelection({ type: 'asset', assetId: asset.id })}
        selection={selection}
        onImport={handlePickMedia}
        onToggleFavorite={toggleAssetFavorite}
      />
    )
  }

  return (
    <div
      ref={appRef}
      className={`app ${page === 'home' ? 'is-home' : 'is-editor'} ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {page === 'home' ? (
        <Home
          info={info}
          onOpenSettings={() => setDialog('settings')}
          onEnterEditor={() => setPage('editor')}
          onNavigate={handleHomeNav}
          drafts={drafts}
          onOpenDraft={handleOpenDraft}
          onDeleteDraft={handleDeleteDraft}
          onNewDraft={handleNewDraft}
        />
      ) : (
        <>
          <TopBar
            info={info}
            projectName={projectName}
            projectDirty={draftDirty}
            drafts={drafts}
            onProjectNameChange={changeProjectName}
            onOpenSettings={() => setDialog('settings')}
            onHome={goHome}
            onExport={() => setExportOpen(true)}
            canExport={clips.length > 0}
            /* 「文件」下拉的四项 —— 全部接到已有的草稿原语上，不是新造一套 */
            onNewDraft={handleNewDraft}
            onOpenDraft={handleOpenDraft}
            onSaveDraft={() => persistDraft({ silent: false })}
            onSaveDraftAs={handleSaveDraftAs}
            /* 素材包：导出 = 草稿 + 全部素材收成一个 .yjpack；导入 = 解成一份新草稿 */
            onExportPack={handleExportPack}
            onImportPack={handleImportPack}
            /* 「帮助」下拉：使用指引是 8 步引导并能跳到对应页，关于是本机构建信息 */
            onOpenGuide={() => setDialog('guide')}
            onAbout={() => setDialog('about')}
            railHidden={railHidden}
            onToggleRail={() => setRailHidden((value) => !value)}
          />

          <div className="wb-tabs-row">
            <EditorTabs
              active={wbTab}
              onChange={(key) => {
                setWbTab(key)
                // 落在第一个带面板的二级项上，不是 root —— 否则「转场」「滤镜」这类
                // 整个标签的意义都在面板里的标签，点进去看着像空的（root 无 panel、
                // 无 caps，中间栏会退化成"显示全部素材"）。
                setWbNode(defaultNodeOf(key))
              }}
            />
            {/* 「播放器」「信息」两个列标题与功能标签同处 44px 行内（参考实测） */}
            <div className="wb-colhead player">
              <span>播放器</span>
              <span className="wb-grow" />
              <button type="button" title="画面设置" onClick={() => setDialog('settings')}>
                <IconMenu size={14} />
              </button>
            </div>
            <div className="wb-colhead info">
              {/* 一排同级页签：首枚固定是「信息」，后面跟 `inspectorTabsFor(片段)`
                  （画面 / 音频 / 变速 / 调整；字幕片段则是一枚「字幕」）。
                  两处钩子都挂上：data-insp-tab 是"这一排"的正名，
                  data-info-tab 留给"信息/字幕"那两条专门断言。 */}
              <div className="wb-coltabs" role="tablist" aria-label="属性栏">
                {[{ key: 'info', label: '信息' }, ...inspectorTabsFor(selectedClip)].map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    className={`wb-coltab ${inspTab === key ? 'on' : ''}`}
                    data-insp-tab={key}
                    data-info-tab={key}
                    aria-pressed={inspTab === key}
                    onClick={() => setInspTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={`workbench ${railHidden ? 'is-rail-hidden' : ''}`} data-rail={railHidden ? 'hidden' : 'shown'}>
            <AssetTree              tab={wbTab}
              active={wbNode}
              onChange={setWbNode}
              countOf={(item) => {
                if (!item.caps?.length) return null
                return assets.filter((asset) => item.caps.includes(asset.capability)).length || null
              }}
            />

            {renderCenterPane()}

            <Stage
              /* 整条时间线在这一帧的合成结果（含提前挂载的层） */
              layers={composite.layers}
              main={composite.main}
              backdrop={backdrop}
              /* 字幕 / 文字叠加层：与画面层**并列**，不是二选一（见 composite 的口径） */
              overlays={composite.text}
              /* 画面特效跟主层走，与调色同一个来源 */
              frameFx={mainClip?.frameFx || 'none'}
              /* 音频轨（BGM/配音）与画面同时发声 —— 此刻在场的**全部**片段 */
              audio={composite.audio}
              /* 叠加轨（画中画）压在主画面之上 —— 此刻在场的**全部**片段 */
              pip={composite.pip}
              playing={playing}
              playhead={playhead}
              totalDuration={timelineDuration}
              volume={volume}
              onTogglePlay={() => setPlaying((value) => !value)}
              onSeek={setPlayhead}
              onSkip={(delta) => setPlayhead((value) => Math.max(0, Math.min(timelineDuration, value + delta)))}
              onFrame={(direction) => setPlayhead((value) => stepFrame(value, direction))}
              playerRef={playerRef}
              fullscreen={fullscreen}
              onToggleFullscreen={toggleFullscreen}
              /* 画面比例：预览这里切，导出按同一个值裁（真源共用一份表） */
              aspect={aspect}
              onAspect={setAspect}
              /* 预览里的直接操作：选中与时间线、右栏共用同一个 selection */
              selectedClipId={selection?.clipId || null}
              onSelectClip={(id) => setSelection(id ? { type: 'clip', clipId: id } : null)}
              onPatchClip={patchClip}
              onSnapshot={snapshotClips}
            />

            <Inspector
              asset={selectedClipAsset}
              clip={selectedClip}
              clips={clips}
              /* HDR 标注：主进程 ffprobe 的结论，按 path 查 */
              hdrOf={(filePath) => (filePath ? hdrMap[filePath] || null : null)}
              projectName={projectName}
              createdAt={createdAt}
              onProjectNameChange={changeProjectName}
              onRemoveClip={removeClip}
              onAddToTimeline={addClipFromAsset}
              onPatchClip={patchClip}
              /* 草稿参数：保存位置是真的落盘目录，比例与时间线名是可改的真字段 */
              saveLocation={info?.userData ? `${info.userData}\\drafts` : ''}
              aspect={aspect}
              onAspect={(next) => setAspect(normalizeAspect(next))}
              timelineName={timelineName}
              onTimelineNameChange={changeTimelineName}
              inspTab={inspTab}
              onInspTab={setInspTab}
              playhead={playhead}
              /* 标记要进检查器：「按标记卡点」用它当重音点（曲线变速那一组） */
              markers={markers}
              /* 多机位：切角 / 取声方式 / 解除。播放头也一起给 —— 切角落在"这一刻" */
              onSwitchMulticamAngle={switchMulticamAngle}
              onMulticamAudio={changeMulticamAudio}
              onUngroupMulticam={ungroupMulticamClip}
            />

            {/* 三根列宽分隔条，各占一条缝列（grid 列 2/4/6） */}
            {layout && (
              <>
                <Splitter
                  which="tree"
                  title="左栏宽度"
                  onDelta={(d) => resizePane('tree', d)}
                  onReset={() => resetPane('tree')}
                  onNudge={(d) => resizePane('tree', d)}
                />
                <Splitter
                  which="center"
                  title="素材面板宽度"
                  onDelta={(d) => resizePane('center', d)}
                  onReset={() => resetPane('center')}
                  onNudge={(d) => resizePane('center', d)}
                />
                <Splitter
                  which="info"
                  title="信息栏宽度"
                  onDelta={(d) => resizePane('info', d)}
                  onReset={() => resetPane('info')}
                  onNudge={(d) => resizePane('info', d)}
                />
              </>
            )}
          </div>

          <Timeline
            clips={clips}
            playhead={playhead}
            zoom={zoom}
            duration={timelineDuration}
            /* 全屏态住在这里的理由见 Timeline.jsx 的 props 注释：
               「全屏态下 Esc 退出」要由下面那个唯一的全局 keydown 统一处理 */
            tlFull={tlFull}
            onTlFull={setTlFull}
            onResizeHeight={layout ? (d) => resizePane('timeline', d) : undefined}
            onResetHeight={() => resetPane('timeline')}
            /* 轨道开关的真源在这里：预览/导出按 effectiveClips 结算（见上） */
            trackState={trackState}
            onTrackState={changeTrackState}
            /* 用户标记：打点/跳转/清除。它不进成片，所以只给时间线用 */
            /* 剪辑联动开关（默认开）：拖动片段时同源画面与声音一起动 */
            linkEnabled={linkEnabled}
            onToggleLink={() => changeLinkEnabled(!linkEnabled)}
            markers={markers}
            onToggleMarker={toggleMarkerAt}
            onClearMarkers={() => setMarkers([])}
            onStepMarker={(dir) => {
              const next = stepMarker(markers, playhead, dir)
              if (next === null) return
              setPlayhead(next)
            }}
            onToggleClipEnabled={toggleClipEnabled}
            onRevealClip={revealClip}
            onReplaceClip={replaceClipSource}
            /* 复合片段：新建吃多选集合，解除吃当前那一个 */
            onCreateCompound={createCompound}
            onUngroupClip={ungroupClip}
            onCreateMulticam={createMulticamClip}
            onUngroupMulticam={ungroupMulticamClip}
            /* 时间区域：状态在这里（导出面板也要读），时间线只负责画与手势 */
            region={region}
            regionClip={regionClip}
            onRegionRange={setRegionRange}
            onRegionMark={markRegion}
            onRegionClear={() => setRegion(null)}
            onRegionDelete={deleteRegion}
            onRegionCopy={copyRegionContent}
            onRegionCut={cutRegionContent}
            onRegionPaste={pasteRegionContent}
            onRegionExport={exportRegion}
            /* 录音配音：入口在工具栏，面板挂在下面（它要读播放头、要落片段） */
            onOpenRecorder={() => setRecorderOpen(true)}
            selection={selection}
            canUndo={pastRef.current.length > 0}
            canRedo={futureRef.current.length > 0}
            onZoom={(value) => setZoom(clampZoom(value))}
            snap={snap}
            onSnap={setSnap}
            onSeek={setPlayhead}
            /* `null` = 点空白处取消选中（与预览里点画面外同一口径）。 */
            /* ⚠️ 第二个参数（`{additive}`）必须透传：Ctrl + 点选的多选态全靠它，
               漏掉就变成"按了 Ctrl 也只是一次普通选中"（多选彻底失效，而界面看不出来）。 */
            onSelect={(clip, options) => selectClip(clip, options)}
            onRemove={removeClip}
            onClear={() => {
              commitClips([])
              setSelection(null)
              toast('已清空时间线')
            }}
            onSplit={splitClip}
            onSplitClipAt={(clipId) => splitClipAt(clipId, playhead)}
            onUndo={undo}
            onRedo={redo}
            onImport={handlePickMedia}
            onDragClip={dragClip}
            onMoveLayer={moveLayerOf}
            onSplitByScenes={splitByScenes}
            onDuplicateClip={duplicateClip}
            onSnapshot={snapshotClips}
            onDropAsset={dropAssetOnTimeline}
            volume={volume}
            onVolume={setVolume}
            onOpenStock={() => {
              /*
               * ⚠️ `stock` 是**节点**不是标签 —— 素材库挂在「媒体文件」标签下。
               * 写成 setWbTab('stock') 会切到一个不存在的标签：左栏整列变空，
               * 用户看到的是"按钮点了没反应"。
               */
              setWbTab('media')
              setWbNode('stock')
            }}
            onOpenSubtitle={() => {
              setWbTab('subtitle')
              setWbNode('subtitle-root')
            }}
            onOpenSettings={() => setDialog('settings')}
          />
        </>
      )}

      {/* 录音配音面板：只在工作台里出现的东西，但仍然挂在最外层 ——
          它是一层遮罩，放进任何一块布局里都会跟着那块布局的 overflow 被裁。 */}
      <Recorder
        open={recorderOpen}
        onClose={() => setRecorderOpen(false)}
        onRecorded={addRecordingClip}
        onBusyChange={setRecorderBusy}
      />

      {exportOpen ? (
        <div className="mask" onClick={(event) => event.target === event.currentTarget && setExportOpen(false)}>
          <div className="modal wide" style={{ maxWidth: 560 }}>
            <header>
              <div>
                <h3>导出成片</h3>
                <p>按时间线把所有片段合成一个视频文件。</p>
              </div>
              <button type="button" onClick={() => setExportOpen(false)} aria-label="关闭">
                <IconClose size={14} />
              </button>
            </header>
            <div className="modal-body" style={{ padding: 0, height: '62vh' }}>
              <SidePanels
                mode="export"
                clips={clips}
                /* ⚠️ 必须给**结算过**的片段表（停用的 / 隐藏轨 / 静音轨不清）：
                   导出面板原来只拿到全量 clips，于是"预览里关掉的轨、成片里还在"——
                   与预览同一份口径（effectiveClips）才对得上。
                   顺带它已经展开过复合片段与多机位，渲染侧再展开一次是幂等的。 */
                renderClips={activeClips}
                projectName={projectName}
                backdrop={backdrop}
                /* 成片按预览里选的那个比例裁：少传它，导出就一律 16:9 ——
                   "预览切了 1:1、导出来还是横的"，且两边单独看都没错。 */
                aspect={aspect}
                /* 时间区域：「只导出这一段」用。传的是**当前生效**的区间
                   （半开状态传 null ⇒ 面板不会出现那个开关）。 */
                range={liveRegion()}
              />
            </div>
          </div>
        </div>
      ) : null}

      {dialog === 'guide' ? (
        <GuideDialog
          onClose={() => setDialog(null)}
          /* 「去试试」按步骤键跳到对应页面：导入/修剪在剪辑台，其余进工作台对应标签 */
          onJump={(key) => {
            setPage('workbench')
            const tab =
              key === 'subtitle'
                ? 'subtitle'
                : key === 'transition'
                  ? 'transition'
                  : key === 'look'
                    ? 'filter'
                    : key === 'audio'
                      ? 'audio'
                      : 'media'
            setWbTab(tab)
          }}
        />
      ) : null}

      {dialog === 'settings' ? (
        <SettingsDialog
          info={info}
          onClose={() => setDialog(null)}
          keymap={keymap}
          onKeymapChange={changeKeymap}
          /* 自定义字体：字幕检查器的字体下拉与「导入字体」按钮 */
          fonts={fonts}
          onImportFont={importFonts}
          hardwareAcceleration={hardwareAcceleration}
          /* 导入方式：设置页的「保留原位 / 复制进草稿」，只影响之后导入的素材 */
          importMode={importMode}
          onImportModeChange={changeImportMode}
          previewQuality={previewQuality}
          onPreviewQualityChange={changePreviewQuality}
          onHardwareAccelerationChange={changeHardwareAcceleration}
          onRestart={restartApp}
        />
      ) : null}

      {dialog === 'about' ? <AboutDialog info={info} onClose={() => setDialog(null)} /> : null}

      {dragging ? (
        <div className="drop-veil" aria-hidden="true">
          <div className="drop-card">
            <strong>松手即导入</strong>
            <small>支持视频 / 音频 / 图片，可一次拖多个</small>
          </div>
        </div>
      ) : null}
    </div>
  )
}
