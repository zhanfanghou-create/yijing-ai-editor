import { useEffect, useMemo, useState } from 'react'
import { ASPECTS, aspectRatioOf, normalizeAspect, outputSizeFor } from '../../shared/aspect.js'
import {
  ADJUST_PARAMS,
  BEAUTY_PARAMS,
  POS_LIMIT,
  ROTATE_LIMIT,
  readAdjust,
  readBeauty
} from '../../shared/adjust.js'
import {
  ALIGNS,
  ANCHORS,
  BG_PAD_MAX,
  LINE_MAX,
  LINE_MIN,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  isHexColor,
  hasTextOverrides,
  resetTextOverrides
} from '../../shared/textOverrides.js'
/* 文字动画真源：入场 / 出场 / 循环。预览走 CSS 类、导出走 drawtext 时间表达式，
   两边都从这一份参数推导（见 shared/textAnim.js 的说明）。 */
import {
  DUR_MAX,
  DUR_MIN,
  IN_TYPES,
  LOOP_TYPES,
  OUT_TYPES,
  hasTextAnim,
  readTextAnim,
  resetTextAnim
} from '../../shared/textAnim.js'
/* 效果参数（圆角/蒙版/抠像/混合/变形/描边/阴影）—— 真源在 shared/effects.js，
   导出侧 render.js 与预览侧 Stage.jsx 读的是同一份换算。 */
import {
  BLEND_MODES,
  DASH_MAX,
  KEY_PRESETS,
  MASK_AXES,
  MASK_SHAPES,
  MIRROR_AXES,
  RADIUS_MAX,
  SHADOW_MAX_BLUR,
  SHADOW_MAX_OFFSET,
  SHADOW_MAX_SPREAD,
  SKEW_LIMIT,
  STROKE_MAX,
  STROKE_STYLES,
  hasCorners,
  hasWarp,
  readEffects,
  strokeStyleOf,
  warpTable
} from '../../shared/effects.js'
/* 自由裁剪框：换算全在 shared/crop.js，导出侧读的是同一个字段 */
import { CROP_RATIOS, cropRectFor, readCrop } from '../../shared/crop.js'
/* 音量包络与导出阶段的降噪（真源 shared/audio.js） */
import { readVolumeKf } from '../../shared/audio.js'
/* 多机位：右栏要读机位表/切换点/取声方式（纯函数，与展开时同一份真源） */
import { angleIndexAt, anglesOf, audioOf, cutsOf, multicamSpan } from '../../shared/multicam.js'
import { KIND_LABEL } from '../assets.js'
import {
  IconChevronDown,
  IconExternal,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconTrash
} from '../icons.jsx'
import { FILTERS } from '../looks.js'
import { mediaPeaks, openExternal } from '../platform.js'
import {
  PIP_ANCHORS,
  PIP_DEFAULT_ANCHOR,
  PIP_DEFAULT_SIZE,
  PIP_MAX_SIZE,
  PIP_MIN_SIZE,
  pipAnchor
} from '../pip.js'
import { fontFamilyOf } from '../fonts.js'
import { TEXT_STYLES, textStyleDef } from '../textStyles.js'
import { SPEED_MAX, SPEED_MIN, clipSpeed } from '../trim.js'
/* 曲线变速与音高的真源在 shared/speed.js —— 预览、导出、曲线编辑器读的是同一份 */
import { CURVE_PRESETS, curveFromBeats, curveMean, curvePatch, readCurve } from '../../shared/speed.js'
/* 节拍检测（纯函数）：输入是主进程抽出来的振幅包络 */
import { detectBeats } from '../../shared/beat.js'
import { Slider, timecode, timecodeFrames } from '../ui.jsx'
import CurveEditor from './CurveEditor.jsx'

const TRACK_LABEL = { video: '视频轨', overlay: '叠加轨', audio: '音频轨', text: '字幕轨' }

/**
 * 右栏顶部那一排页签的**分类部分**（不含开头那枚「信息」）。
 *
 * ⚠️ 真源唯一：**App 画页签、检查器画内容**，两边读同一个函数。
 *    从前这排页签画在检查器内部（`wb-insptabs`），于是它落在片段信息**下面**，
 *    看着像"信息里的一块内容"而不是一排同级页签；而「信息 / 字幕」又是 App 另画的
 *    一排 —— 同一栏里两排页签各管一半。现在合成一排：`信息` + `inspectorTabsFor(clip)`，
 *    页面由 App 画，内容由这里按 `inspTab` 分发。
 *
 * 给哪些页签**跟着轨道类型走**（不是所有片段都给四枚）：音频轨没有画面，
 * 字幕轨没有音频/变速；多给一枚就是"点进去空空如也"的假入口。
 */
export function inspectorTabsFor(clip) {
  if (!clip) return []
  /**
   * 复合片段：**只给「音频 / 变速」两枚**。
   *
   * 为什么不能照视频轨给四枚：画面（位置 / 缩放 / 旋转）、调整（调色 / 美颜）、
   * 效果（圆角 / 蒙版 / 描边）在渲染侧是**逐片段**挂在片段自己的图层上的，
   * 而复合片段在渲染时会被摊平成内部片段 —— 它自己的那套字段没有任何地方读。
   * 给了控件就是"拖了、预览没变、成片也没变"，属于最恶劣的那种假入口。
   * 内部各段的画面/调色请解除复合（或在内部片段上）调。
   *
   * 音量与变速是真的：音量乘到子片段上，变速是整体的常数倍速（见 shared/compound.js）。
   */
  if (clip.kind === 'compound') {
    return [
      { key: 'audio', label: '音频' },
      { key: 'speed', label: '变速' }
    ]
  }
  /**
   * 多机位：给「多机位 / 音频 / 变速」三枚。
   * 「多机位」是这类片段**唯一**有用的画面入口（切角、取声、解除）；
   * 画面/调整给不了 —— 它被展开成一串普通片段，逐片段的几何字段展开后没人读。
   */
  if (clip.kind === 'multicam') {
    return [
      { key: 'multicam', label: '多机位' },
      { key: 'audio', label: '音频' },
      { key: 'speed', label: '变速' }
    ]
  }
  const track = clip.track || 'video'
  if (track === 'text') {
    /* ⚠️ 只有**字幕片段**（没有 assetId）才给「字幕」页签。
       从素材库拖进来的"文字素材"也在字幕轨上，但它不是字幕 ——
       它的样式由素材自己决定，给一枚点进去只能改 TEXT_STYLES 的页签等于假入口
       （与 App 的 isSubtitleClip 同一口径）。 */
    return clip.assetId ? [] : [{ key: 'text', label: '字幕' }]
  }
  if (track === 'audio') {
    return [
      { key: 'audio', label: '音频' },
      { key: 'speed', label: '变速' }
    ]
  }
  return [
    { key: 'visual', label: '画面' },
    { key: 'audio', label: '音频' },
    { key: 'speed', label: '变速' },
    { key: 'adjust', label: '调整' }
  ]
}

/** 常用倍速：剪辑里最常用的就是"慢一半 / 原速 / 快一倍" */
const SPEED_PRESETS = [0.5, 1, 2]

/** 淡入 / 淡出的上限（秒）。再长基本都是"整段都在渐变"，没有实用价值 */
const FADE_MAX = 10

/* 位置与旋转的可调范围来自 shared/adjust.js —— ⚠️ 不许在这里另写一份：
   它与导出侧 render.js 的 poseFilter 夹取范围**必须一致**（位置上限 50 是因为
   成片那边靠"垫 2 倍画布再裁回来"做平移，余量正好是半张画布）。
   改这里而没改导出，就是"预览挪得动、成片挪不动"。 */

/** 颜色快捷色板（参考的字幕调色板同样是这几个固定色 + 取色器） */
const TEXT_SWATCHES = ['#FFFFFF', '#000000', '#00C1CD', '#FFD400', '#FF4D4F', '#4DA3FF']

/** 参考的「创建时间」格式是 2026-09-23_01 —— 本地时间的日期 + 两位小时 */
function formatCreatedAt(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}`
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0))
const numOf = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
/** 保留 1 位小数：数值框里显示 12.300000000000001 会让人以为参数坏了 */
const round1 = (value) => Number(numOf(value, 0).toFixed(1))

/**
 * 草稿参数里那些「开关」是**当前实现的真实描述**，不是可点的假旋钮：
 * 本版本不做 HDR、不做浮点链路、不做代理剪辑，所以那三行恒为「关闭」；
 * 多轨自由摆放与图文混排是本版本的既有能力，所以那两行恒为「开启」。
 * 写"关闭"是陈述事实，把它做成能切的开关才是假的 —— 切了画面一个像素都不会变。
 */
const DRAFT_FLAGS = [
  ['色彩空间', '标准（SDR）'],
  ['浮点链路', '关闭'],
  ['导入方式', '保留在原有位置'],
  ['自由层级', '开启'],
  ['素材混排', '开启'],
  ['代理模式', '关闭']
]

/* ------------------------------- 小组件 ------------------------------- */

/**
 * 一节：可折叠的标题行 + 正文。
 *
 * 形制照参考右栏：`[小方块] 标题 ▾ …… [重置]`。
 *   · 小方块表达**这一节的效果此刻是否生效**（`on`）—— 填实 = 生效。
 *     它不是第二个开关：点它不会改参数，避免"节头一个开关、节里一个开关"两处状态分叉。
 *   · 整行可点 = 折叠/展开。默认**展开**：参考那边默认折叠是因为它一屏挂十几节，
 *     我们每种片段只有 2~6 节，全展开才有"一眼看全"的效果。
 *   · 重置按钮只在有改动时出现（`dirty`）—— 常驻一个点了没反应的按钮，
 *     正是本项目里"看着有、实际没接"那一类。
 *
 * ⚠️ 标题行不能整体做成 `<button>`：里面还要放重置按钮，button 嵌套 button 是非法结构，
 *    Chromium 会把内层那个踢出去（点重置反而折叠了整节）。所以是 div 里套一个 toggle 按钮。
 */
function Section({ title, dirty, onReset, resetHint, children, hook, on }) {
  const [open, setOpen] = useState(true)
  return (
    <section
      className={`wb-inspsect ${open ? 'is-open' : 'is-closed'}`}
      data-inspsect={hook}
      data-inspsect-open={open ? '1' : '0'}
    >
      <div className="wb-inspsect-head">
        <button
          type="button"
          className="wb-inspsect-toggle"
          aria-expanded={open}
          data-inspsect-toggle={hook}
          title={open ? `收起「${title}」` : `展开「${title}」`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={`wb-inspsect-dot ${on ? 'on' : ''}`} data-inspsect-on={on ? '1' : '0'} />
          <b>{title}</b>
          <IconChevronDown size={12} className="wb-inspsect-caret" />
        </button>
        {dirty && onReset ? (
          <button
            type="button"
            className="wb-inspsect-reset"
            title={resetHint || `把「${title}」恢复默认`}
            data-reset={hook}
            onClick={onReset}
          >
            <IconRefresh size={14} />
          </button>
        ) : null}
      </div>
      {open ? <div className="wb-inspsect-body">{children}</div> : null}
    </section>
  )
}

/**
 * 开关（抠像 / 描边 / 阴影的启用位）。
 * ⚠️ 带 `data-fx-toggle`：闸门按它定位并点开关 —— 读按钮的 `aria-pressed` 判断状态，
 *    而不是去猜内联样式（猜样式会在"底色变了但没接上"时给出假绿）。
 */
function Toggle({ label, on, hook, onChange }) {
  return (
    <div className="wb-switchrow">
      <span>{label}</span>
      <button
        type="button"
        className={`wb-switch ${on ? 'on' : ''}`}
        data-fx-toggle={hook}
        aria-pressed={on}
        onClick={() => onChange(!on)}
      >
        <i />
      </button>
    </div>
  )
}

/** 取色：原生取色器 + 两个预设（绿幕 / 蓝幕）。写回的是 `#RRGGBB`。 */
function ColorField({ label, value, hook, onChange }) {
  return (
    <label className="wb-colorfield">
      <span>{label}</span>
      <input
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ffffff'}
        data-insp-color={hook}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
      />
      <em>{value || '—'}</em>
    </label>
  )
}

/**
 * 数值输入（参考的 spinner 形制）。
 * ⚠️ 空字符串 / 非法值**不写回**：一边删一边打字时中间态是空的，
 *    直接写回会把参数打成 0（用户只是想改成 35，删到一半就被掰成 0 了）。
 */
function NumField({ label, value, min, max, step = 1, suffix, hook, onChange }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      setText(String(value))
      return
    }
    const next = clamp(n, min, max)
    setText(String(next))
    onChange(next)
  }
  return (
    <label className="wb-num">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        data-insp-num={hook}
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value)
        }}
      />
      {suffix ? <em>{suffix}</em> : null}
    </label>
  )
}

/* ------------------------------ 片段检查器 ------------------------------ */

/**
 * 片段检查器（参考的右栏形制）。
 *
 * 页签按**轨道**给：画面/音频/变速/调整 是画面类片段才有的；字幕轨只给「字幕」。
 * 不给用不上的页签，也不把不适用的控件灰在那儿 —— 参考客户端里灰着的东西点下去
 * 是"没反应"，而没反应的控件与坏掉的控件在界面上长得一模一样。
 */
function ClipInspector({
  clip,
  totalDuration,
  onPatchClip,
  onRemoveClip,
  inspTab = 'info',
  onInspTab,
  /* 播放头：音量包络要"在播放头处打一个点"，没有它就只能盲打 */
  playhead = 0,
  /* 画布比例：裁剪比例预设要按它算"居中最大框" */
  aspect = '16:9',
  /* 已导入的自定义字体（settings.fonts）；空数组 = 只有系统默认 */
  fonts = [],
  onImportFont,
  /* 时间线标记（秒）。「按标记卡点」用：标记落在片段内的位置就是减速点 */
  markers = [],
  /* 多机位三件事：切角（落在播放头）/ 取声方式 / 解除。全部由 App 落地 */
  onSwitchMulticamAngle,
  onMulticamAudio,
  onUngroupMulticam
}) {
  const track = clip.track || 'video'
  /* 分类页签（画面 / 音频 / 变速 / 调整 …）。与 App 画的那一排读同一个真源 */
  const tabs = useMemo(() => inspectorTabsFor(clip), [track, clip.assetId])
  /* 「信息」是这一排里的**第一枚**，选中它时右栏只给片段头。
     换选中目标时回到「信息」由 App 统一管（见 App 的 selectedClip?.id 副作用）——
     这里不再自己存一份 tab 状态，否则"页签在 App、选中值在检查器"两处会分叉。 */
  const infoMode = inspTab === 'info'
  /* 越界的 inspTab（例如从视频片段切到字幕片段，而上一枚选的是「调整」）一律落回第一枚；
     文字素材那种"分类页签为空"的片段落成空串 ⇒ 下面每个分支都不命中，正文自然为空。 */
  const active = tabs.some((item) => item.key === inspTab) ? inspTab : tabs[0]?.key || ''

  const patch = (data) => onPatchClip(clip.id, data)

  /* ---------------- 画面 ---------------- */
  const scale = numOf(clip.scale, 100)
  const opacity = numOf(clip.opacity, 100)
  const posX = numOf(clip.posX, 0)
  const posY = numOf(clip.posY, 0)
  const rotate = numOf(clip.rotate, 0)
  const beauty = readBeauty(clip.beauty)
  const [visualSub, setVisualSub] = useState('base')

  /* ---------------- 效果（圆角 / 蒙版 / 抠像 / 混合 / 变形 / 描边 / 阴影） ----------------
     `fx` 是**规范化**后的一份（缺字段补默认、越界夹取），所有控件都往这一份上写 ——
     直接读 clip.effects 的原始对象会让"缺字段"变成 undefined 落到滤镜串里变 NaN。 */
  const fx = readEffects(clip.effects)
  /** 改效果里的某一项：整体写回 clip.effects（渲染层与导出读的是同一个字段） */
  const patchFx = (data) => patch({ effects: { ...fx, ...data } })
  const fxDirty =
    fx.radius > 0.01 ||
    Math.abs(fx.skewX) > 0.01 ||
    Math.abs(fx.skewY) > 0.01 ||
    fx.blend !== 'normal' ||
    fx.key.on ||
    fx.mask.shape !== 'none' ||
    fx.stroke.on ||
    fx.shadow.on ||
    fx.mirror.h ||
    fx.mirror.v ||
    hasCorners(fx) ||
    /* 自由变形也是"画面被改过"，漏了它右栏的"已修改"点不会亮，
       用户会以为点了没反应（又一个"接对了看不见"）。 */
    hasWarp(fx)

  /* ---------------- 裁剪 ---------------- */
  const crop = readCrop(clip.crop)
  /* 画布宽高比：裁剪比例预设按它算"居中的最大框"（框的百分比是相对画布的，
     同一组百分比在 16:9 与 9:16 上代表的像素形状不同）。 */
  const frameAr = aspectRatioOf(normalizeAspect(aspect)) || 16 / 9
  const cropDirty = crop.on && (crop.x > 0.01 || crop.y > 0.01 || crop.w < 99.99 || crop.h < 99.99)
  /** 写裁剪：任何一次改动都隐含"打开裁剪"（用户既然动了框，就是想要裁） */
  const patchCrop = (data) => patch({ crop: { ...crop, on: true, ...data } })

  /* ---------------- 音频 ---------------- */
  const gain = numOf(clip.gain, 100)
  const fadeIn = numOf(clip.fadeIn, 0)
  const fadeOut = numOf(clip.fadeOut, 0)
  /* 音量包络：采样点是**片段内秒数**（与导出侧 volumeExpr 的时间轴一致） */
  const volumeKf = readVolumeKf(clip.volumeKf)
  const localPlayhead = Math.max(0, Math.min(numOf(clip.duration, 0), numOf(playhead, clip.start) - numOf(clip.start, 0)))

  /* ---------------- 变速 ---------------- */
  /* `speed` 在有曲线时是**曲线下的面积**（= 平均速率），见 shared/speed.js。
     所以下面所有"源素材消耗 / 时间线占位"的算式对匀速与曲线同时成立。 */
  const speed = clipSpeed(clip)
  /**
   * 复合片段：整体只能**匀速**变速。
   *
   * 为什么曲线在这类片段上必须收起来：曲线变速在导出侧要按速率切段再 concat，
   * 而复合片段是"展开成内部片段"来渲染的 —— 展开只能按一个**常数**速率等比缩放
   * 内部各段（见 shared/compound.js 的 rate 一节）。给一个曲线编辑器，
   * 拖完之后系统只按平均值执行：控件在、数字变、画面不变。
   * 所以这里不提供它，并明写"曲线请在内部片段上设"—— 内层曲线的换算与时长
   * 在展开时是精确保留的。
   */
  const compoundClip = clip.kind === 'compound'
  /**
   * 多机位：与复合片段同属"容器"（渲染时被展开成一串普通片段）。
   * 它自己的画面/调色/效果字段一样没有人读，所以那些页签与复合片段同样不给；
   * 变速只能整体匀速（展开时按常数速率缩放每个区间）；音量是真的（乘到展开出的片段上）。
   */
  const multicamClip = clip.kind === 'multicam'
  const containerClip = compoundClip || multicamClip
  const curvePoints = containerClip ? null : readCurve(clip)

  /* ---------------- 多机位 ----------------
     这里只做**读取**：机位表、切换点、取声方式全部来自 shared/multicam.js，
     与展开时（预览/导出）读的是同一份数据 —— 面板上写"现在用的是 2 号机"，
     画面就必须真的是 2 号机的画面，判断口径不能各写一遍。 */
  const mcAngles = multicamClip ? anglesOf(clip) : []
  const mcSpan = multicamClip ? multicamSpan(clip) : 0
  const mcCuts = multicamClip ? cutsOf(clip) : []
  const mcSound = multicamClip ? audioOf(clip) : { mode: 'angle', angle: 0 }
  /**
   * 播放头换算到**节目时间**（内部秒）。
   * ⚠️ 必须乘倍速：`cuts[].at` 是内部坐标，2 倍速下时间线过 1 秒 = 节目里 2 秒。
   *    不乘的话面板高亮的机位与画面上正在播的机位会差一截（越到后面差越多）。
   */
  const mcProg = multicamClip
    ? Math.max(
        0,
        Math.min(mcSpan, (numOf(playhead, clip.start) - numOf(clip.start, 0)) * speed + numOf(clip.offset, 0))
      )
    : 0
  const mcAngle = multicamClip ? angleIndexAt(clip, mcProg) : 0
  const curveOn = Boolean(curvePoints)
  /** 卡点的生成参数（只影响"生成出来的那条曲线"，所以不写进片段 ——
      它们是操作参数，不是片段属性；存进片段反而会让"同一个片段两种卡点参数"打架） */
  const [beatFast, setBeatFast] = useState(2)
  const [beatSlow, setBeatSlow] = useState(0.35)
  const [beatHold, setBeatHold] = useState(0.3)
  const [beatSensitivity, setBeatSensitivity] = useState(50)
  const [beatBusy, setBeatBusy] = useState(false)
  const [beatNote, setBeatNote] = useState('')
  /** 应用一条曲线。走 curvePatch 拿到"新总倍速 + 点列"，时长由 App 的 speedPatch 按源跨度守恒算 */
  const applyCurve = (points) => {
    const next = curvePatch(clip, points)
    if (next) patch(next)
  }
  /**
   * 当前曲线是不是"就是某个预设"（用来点亮预设 chip）。
   * 逐点比而不是比 key：用户拖过一个点之后仍然是那条预设的**形状家族**，
   * 但已经不是预设本身了 —— 这时候不该继续显示为选中（会让人以为拖拽没生效）。
   */
  const presetOn = (preset) => {
    if (!curveOn || !preset.points) return false
    if (curvePoints.length !== preset.points.length) return false
    return preset.points.every(
      (pair, index) =>
        Math.abs(curvePoints[index].p - pair[0]) < 0.01 && Math.abs(curvePoints[index].v - pair[1]) < 0.02
    )
  }
  /** 片段内的标记（秒，相对片段起点）。两端各让 0.02 秒，理由同 beat.js 的 beatsInRange */
  const markerHits = markers
    .map((value) => Number(value) - Number(clip.start || 0))
    .filter((value) => Number.isFinite(value) && value > 0.02 && value < Number(clip.duration || 0) - 0.02)

  /**
   * 按**音频能量**自动检测节拍，再生成卡点曲线。
   *
   * 为什么要绕主进程：渲染层拿不到 ffmpeg，而 `decodeAudioData` 对 mp4 里的 AAC
   * 经常直接抛 EncodingError（见 clipVisuals 里那段说明）。所以这里复用波形那条
   * `media:peaks` 通路，只把桶数调密（~60 个/秒）—— 桶太粗时相邻鼓点会挤进一个桶，
   * 检测出来就"少了一半"，且不会报错。
   */
  const beatFromAudio = async () => {
    const url = clip.url
    if (!url || clip.kind === 'image') {
      setBeatNote('这个片段没有可分析的音频')
      return
    }
    setBeatBusy(true)
    setBeatNote('正在分析音频…')
    try {
      const span = Math.max(0.2, Number(clip.duration || 0) * speed)
      const buckets = Math.min(6000, Math.max(120, Math.round(span * 60)))
      const peaks = await mediaPeaks({ url, offset: Math.max(0, Number(clip.offset) || 0), duration: span, buckets })
      if (!peaks || !peaks.length) {
        setBeatNote('没读到音频包络（片段可能没有声音）')
        return
      }
      const hits = detectBeats(peaks, span / peaks.length, { sensitivity: beatSensitivity })
      if (!hits.length) {
        setBeatNote('没检测到明显节拍，把灵敏度调高再试')
        return
      }
      /* 包络是**源时间**，换算成片段内秒数要除掉倍速（匀速片段才成立；
         已经画了曲线时按平均速率换算 —— 差一点点，用户可以再拖曲线微调） */
      const local = hits.map((value) => value / (speed || 1)).filter((value) => value > 0.02 && value < Number(clip.duration || 0) - 0.02)
      const built = curveFromBeats(Number(clip.duration || 0), local, { fast: beatFast, slow: beatSlow, hold: beatHold })
      if (!built) {
        setBeatNote('节拍都落在片段两端，生成不了曲线')
        return
      }
      applyCurve(built.points)
      setBeatNote(`已按 ${built.hits} 个节拍生成曲线`)
    } finally {
      setBeatBusy(false)
    }
  }
  /** 按**时间线标记**卡点：标记就是用户眼里的"重音"，不需要检测 */
  const beatFromMarkers = () => {
    const built = curveFromBeats(Number(clip.duration || 0), markerHits, { fast: beatFast, slow: beatSlow, hold: beatHold })
    if (!built) {
      setBeatNote('片段范围内没有标记')
      return
    }
    applyCurve(built.points)
    setBeatNote(`已按 ${built.hits} 个标记生成曲线`)
  }

  /* ---------------- 调整 ---------------- */
  const adjustValues = readAdjust(clip.adjust)
  const adjustDirty = ADJUST_PARAMS.some((item) => Math.abs(adjustValues[item.key]) > 0.01)
  const lookDirty = Boolean(clip.filter && clip.filter !== 'none')

  /* ---------------- 字幕 ---------------- */
  const textScale = numOf(clip.textScale, 1)
  const textColor = isHexColor(clip.textColor) ? clip.textColor : ''
  const textAnchor = ANCHORS.includes(clip.textAnchor) ? clip.textAnchor : ''
  const styleDef = textStyleDef(clip.textStyle)
  /* 文字动画的当前值（含"样式表 anim 作为入场默认"这一层，见 readTextAnim） */
  const textAnim = readTextAnim(clip, styleDef.anim)
  const textDirty = hasTextOverrides(clip)

  const visualDirty =
    Math.abs(scale - 100) > 0.01 ||
    Math.abs(opacity - 100) > 0.01 ||
    Math.abs(posX) > 0.01 ||
    Math.abs(posY) > 0.01 ||
    Math.abs(rotate) > 0.01
  const beautyDirty = BEAUTY_PARAMS.some((item) => beauty[item.key] > 0.01)
  const audioDirty = Math.abs(gain - 100) > 0.01 || fadeIn > 0.01 || fadeOut > 0.01

  /**
   * 右栏那一排页签（App 画的：`信息` + `inspectorTabsFor(clip)`）决定这一栏出哪一屏：
   *   选「信息」→ 只给片段头（名称 / 轨道 / 起点时长 / 删除片段）；
   *   选「画面 / 音频 / 变速 / 调整」→ 只给该类的控件；
   *   字幕片段的第二枚是「字幕」→ 字幕样式。
   * 从前这些分类页签画在片段头**下面**（`.wb-insptabs`），看着像"信息里的一块内容"，
   * 而「信息 / 字幕」又是 App 另画的一排 —— 同一栏两排页签各管一半。
   * 现在合成一排、同级，页面由 App 统一画（真源 `inspectorTabsFor`）。
   */
  return (
    <>
      {infoMode ? (
        <>
          {/* 片段头：名称 / 轨道 / 时间位置 + 删除。参考把"删除"放在检查器里，
              而不是只在时间线的右键菜单里 —— 右键菜单是"知道的人才知道有"的入口。 */}
          <div className="wb-field">
            <span>名称</span>
            <strong title={clip.name}>{clip.name}</strong>
          </div>
          <div className="wb-field">
            <span>轨道</span>
            <strong>{TRACK_LABEL[track] || track}</strong>
          </div>
          <div className="wb-field">
            <span>起点 / 时长</span>
            <strong>
              {timecodeFrames(clip.start)} / {timecodeFrames(clip.duration)}
            </strong>
          </div>
          <div className="wb-insp-actions">
            <button className="btn small ghost" type="button" data-remove-clip="1" onClick={() => onRemoveClip(clip.id)}>
              <IconTrash size={12} />
              删除片段
            </button>
          </div>
        </>
      ) : null}

      {/* 选「信息」时这一栏只出上面的片段头，不再叠一层分类正文 ——
          两者是同级页签，不是"信息 + 它的内容"。 */}
      {infoMode ? null : (
        <div className="wb-inspbody" data-inspector="1" data-insp-active={active}>
        {active === 'multicam' ? (
          <>
            <Section title="机位切换" hook="multicam" dirty={false}>
              <div className="wb-field">
                <span>播放头位置</span>
                <strong data-mc-prog={Number(mcProg.toFixed(3))}>{mcProg.toFixed(2)} 秒</strong>
              </div>
              <div className="wb-field">
                <span>切换段</span>
                <strong data-mc-cuts={mcCuts.length}>{mcCuts.length} 段 / {mcAngles.length} 路</strong>
              </div>
              {/* 机位一排：点一下就在**播放头**处落一个切换点。
                  `data-mc-angle` 是闸门的定位钩子，`aria-pressed` 是它判"谁在生效"的判据
                  （判 aria 而不是判类名：类名会在换样式时静默失配）。 */}
              <div className="wb-chiprow" data-mc-anglerow="1">
                {mcAngles.map((angle, index) => (
                  <button
                    key={angle.id || index}
                    type="button"
                    className={`chip ${index === mcAngle ? 'on' : ''}`}
                    data-mc-angle={index}
                    aria-pressed={index === mcAngle}
                    title={`切到「${angle.name || `机位 ${index + 1}`}」：切换点落在播放头 ${mcProg.toFixed(2)} 秒处`}
                    onClick={() => onSwitchMulticamAngle && onSwitchMulticamAngle(clip.id, index, playhead)}
                  >
                    {index + 1} · {angle.name || `机位 ${index + 1}`}
                  </button>
                ))}
              </div>
              <p className="wb-insphint" data-mc-hint="1">
                按 <b>1–9</b> 直接切到对应机位。切换落在播放头，之后一直用这一路，
                直到下一个切换点 —— 想改已经切过的地方，把播放头移回去再点一次。
                <br />
                预览里可以<b>点选</b>它，但不能直接拖：渲染时它是一串区间，
                逐片段的画面参数没有落点。要挪位置 / 调画面，先解除多机位。
              </p>
            </Section>

            <Section
              title="取声"
              hook="multicam-audio"
              dirty={mcSound.mode !== 'angle' || mcSound.angle !== 0}
              resetHint="恢复默认（取第 1 路的声音）"
              onReset={() => onMulticamAudio && onMulticamAudio(clip.id, 'angle', 0)}
            >
              <div className="wb-chiprow" data-mc-audiomode="1">
                {[
                  ['angle', '指定机位'],
                  ['follow', '跟随画面'],
                  ['none', '静音']
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`chip ${mcSound.mode === mode ? 'on' : ''}`}
                    data-mc-audiomode-opt={mode}
                    aria-pressed={mcSound.mode === mode}
                    onClick={() => onMulticamAudio && onMulticamAudio(clip.id, mode, mcSound.angle)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {mcSound.mode === 'angle' ? (
                <div className="wb-chiprow" data-mc-audiopick="1">
                  {mcAngles.map((angle, index) => (
                    <button
                      key={angle.id || index}
                      type="button"
                      className={`chip ${index === mcSound.angle ? 'on' : ''}`}
                      data-mc-audio-angle={index}
                      aria-pressed={index === mcSound.angle}
                      title={`整段用「${angle.name || `机位 ${index + 1}`}」的声音`}
                      onClick={() => onMulticamAudio && onMulticamAudio(clip.id, 'angle', index)}
                    >
                      {index + 1} 号
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="wb-insphint" data-mc-audiohint="1">
                {mcSound.mode === 'angle'
                  ? '整段都用这一路的声音，画面怎么切都不变 —— 多机位最常用的做法（声音跟主麦走）。'
                  : mcSound.mode === 'follow'
                    ? '声音跟着画面一起切（每个切换段用自己那一路的原声）。'
                    : '整段静音（只留画面）。别忘了你可能还想加一条背景音乐。'}
              </p>
            </Section>

            <div className="wb-insp-actions">
              <button
                className="btn small ghost"
                type="button"
                data-mc-ungroup="1"
                title="按当前切换结果摊回时间线：每段画面一个片段 + 一条取声片段"
                onClick={() => onUngroupMulticam && onUngroupMulticam(clip.id)}
              >
                <IconLayers size={12} />
                解除多机位
              </button>
            </div>
          </>
        ) : null}

        {active === 'visual' ? (
          <>
            <div className="wb-subpills" role="group" aria-label="画面分类">
              {[
                ['base', '基础'],
                ['crop', '裁剪'],
                ['key', '抠像'],
                ['mask', '蒙版'],
                ['heal', '修复'],
                ['beauty', '美颜']
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`wb-subpill ${visualSub === key ? 'on' : ''}`}
                  data-insp-subpill={key}
                  aria-pressed={visualSub === key}
                  onClick={() => setVisualSub(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {visualSub === 'base' ? (
              <Section
                title="位置大小"
                hook="visual"
                dirty={visualDirty}
                resetHint="恢复默认（缩放 100%、位置居中、不旋转、不透明度 100%）"
                onReset={() => patch({ scale: 100, opacity: 100, posX: 0, posY: 0, rotate: 0 })}
              >
                <Slider
                  label="缩放"
                  suffix="%"
                  hook="scale"
                  min={10}
                  max={300}
                  value={scale}
                  onChange={(value) => patch({ scale: value })}
                />
                <div className="wb-numrow">
                  <NumField
                    label="位置 X"
                    hook="posx"
                    value={posX}
                    min={-POS_LIMIT}
                    max={POS_LIMIT}
                    suffix="%"
                    onChange={(value) => patch({ posX: value })}
                  />
                  <NumField
                    label="位置 Y"
                    hook="posy"
                    value={posY}
                    min={-POS_LIMIT}
                    max={POS_LIMIT}
                    suffix="%"
                    onChange={(value) => patch({ posY: value })}
                  />
                </div>
                <div className="wb-numrow">
                  <NumField
                    label="旋转"
                    hook="rotate"
                    value={rotate}
                    min={-ROTATE_LIMIT}
                    max={ROTATE_LIMIT}
                    step={0.5}
                    suffix="°"
                    onChange={(value) => patch({ rotate: value })}
                  />
                </div>
                <Slider
                  label="不透明度"
                  suffix="%"
                  value={opacity}
                  onChange={(value) => patch({ opacity: value })}
                />
              </Section>
            ) : null}

            {/* ---------- 基础：镜像 ---------- */}
            {visualSub === 'base' ? (
              <Section
                title="镜像"
                hook="mirror"
                on={fx.mirror.h || fx.mirror.v}
                dirty={fx.mirror.h || fx.mirror.v}
                resetHint="取消镜像（恢复未翻转的画面）"
                onReset={() => patchFx({ mirror: { h: false, v: false } })}
              >
                <div className="wb-chiprow" data-fx-mirror="1">
                  {MIRROR_AXES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`chip ${fx.mirror[item.key] ? 'on' : ''}`}
                      data-fx-mirror-axis={item.key}
                      aria-pressed={fx.mirror[item.key]}
                      title={`${item.label}翻转`}
                      onClick={() => patchFx({ mirror: { ...fx.mirror, [item.key]: !fx.mirror[item.key] } })}
                    >
                      {item.label}镜像
                    </button>
                  ))}
                </div>
                <p className="wb-insphint">
                  导出与预览用的是同一种中心轴翻转；两个方向都开等于旋转 180°。
                </p>
              </Section>
            ) : null}

            {/* ---------- 基础：圆角与变形 ---------- */}
            {visualSub === 'base' ? (
              <Section
                title="圆角与变形"
                hook="shape"
                on={fx.radius > 0.01 || hasCorners(fx) || Math.abs(fx.skewX) > 0.01 || Math.abs(fx.skewY) > 0.01}
                dirty={fx.radius > 0.01 || hasCorners(fx) || Math.abs(fx.skewX) > 0.01 || Math.abs(fx.skewY) > 0.01}
                resetHint="恢复默认（不圆角、不斜切）"
                onReset={() => patchFx({ radius: 0, skewX: 0, skewY: 0, corners: { ...fx.corners, on: false } })}
              >
                <Toggle
                  label="四角独立"
                  on={fx.corners.on}
                  hook="corners"
                  onChange={(on) => patchFx({ corners: { ...fx.corners, on } })}
                />
                {fx.corners.on ? (
                  <>
                    {[
                      ['tl', '左上'],
                      ['tr', '右上'],
                      ['br', '右下'],
                      ['bl', '左下']
                    ].map(([key, label]) => (
                      <Slider
                        key={key}
                        label={label}
                        suffix="px"
                        min={0}
                        max={RADIUS_MAX}
                        value={Math.round(fx.corners[key])}
                        onChange={(value) => patchFx({ corners: { ...fx.corners, [key]: value } })}
                      />
                    ))}
                  </>
                ) : (
                  <Slider
                    label="圆角"
                    suffix="px"
                    min={0}
                    max={RADIUS_MAX}
                    value={Math.round(fx.radius)}
                    onChange={(value) => patchFx({ radius: value })}
                  />
                )}
                <div className="wb-numrow">
                  <NumField
                    label="斜切 X"
                    hook="fx-skewx"
                    value={round1(fx.skewX)}
                    min={-SKEW_LIMIT}
                    max={SKEW_LIMIT}
                    step={0.5}
                    suffix="°"
                    onChange={(value) => patchFx({ skewX: value })}
                  />
                  <NumField
                    label="斜切 Y"
                    hook="fx-skewy"
                    value={round1(fx.skewY)}
                    min={-SKEW_LIMIT}
                    max={SKEW_LIMIT}
                    step={0.5}
                    suffix="°"
                    onChange={(value) => patchFx({ skewY: value })}
                  />
                </div>
                <p className="wb-insphint">
                  圆角与斜切都会写进导出：圆角是生成一张圆角遮罩合并到画面上，斜切走 ffmpeg 的 shear。
                  四角独立时按每个角各自的半径生成遮罩。
                </p>
              </Section>
            ) : null}

            {/* ---------- 基础：自由变形（四角透视） ---------- */}
            {visualSub === 'base' ? (
              <Section
                title="自由变形"
                hook="warp"
                on={hasWarp(fx)}
                dirty={hasWarp(fx)}
                resetHint="四角归零（恢复不变形）"
                onReset={() =>
                  patchFx({
                    warp: {
                      on: false,
                      tl: { x: 0, y: 0 },
                      tr: { x: 0, y: 0 },
                      br: { x: 0, y: 0 },
                      bl: { x: 0, y: 0 }
                    }
                  })
                }
              >
                <Toggle
                  label="开启自由变形"
                  on={fx.warp.on}
                  hook="warp"
                  onChange={(on) => patchFx({ warp: { ...fx.warp, on } })}
                />
                {fx.warp.on ? (
                  <>
                    {[
                      ['tl', '左上角'],
                      ['tr', '右上角'],
                      ['br', '右下角'],
                      ['bl', '左下角']
                    ].map(([key, label]) => (
                      <div className="wb-numrow" key={key}>
                        <NumField
                          label={`${label} X`}
                          hook={`fx-warp-${key}-x`}
                          value={round1(fx.warp[key].x)}
                          min={-warpTable.WARP_LIMIT}
                          max={warpTable.WARP_LIMIT}
                          step={0.5}
                          suffix="%"
                          onChange={(value) =>
                            patchFx({ warp: { ...fx.warp, [key]: { ...fx.warp[key], x: value } } })
                          }
                        />
                        <NumField
                          label={`${label} Y`}
                          hook={`fx-warp-${key}-y`}
                          value={round1(fx.warp[key].y)}
                          min={-warpTable.WARP_LIMIT}
                          max={warpTable.WARP_LIMIT}
                          step={0.5}
                          suffix="%"
                          onChange={(value) =>
                            patchFx({ warp: { ...fx.warp, [key]: { ...fx.warp[key], y: value } } })
                          }
                        />
                      </div>
                    ))}
                    <p className="wb-insphint">
                      数值是画面宽高的百分比（不是像素），换比例/换分辨率都不会跑偏。
                      预览用 CSS matrix3d、导出用 ffmpeg perspective，两者由
                      shared/warp.js 的同一个单应矩阵算出来。四角被拖开后，框外区域是透明的
                      （预览与导出一致），会露出下层画面或背景。
                      四角自交（蝴蝶结）会被判为无效并退回不变形 —— 那种情形画面会反折撕裂。
                    </p>
                  </>
                ) : null}
              </Section>
            ) : null}

            {/* ---------- 裁剪：自由裁剪框 ---------- */}
            {visualSub === 'crop' ? (
              <Section
                title="自由裁剪"
                hook="crop"
                on={crop.on}
                dirty={cropDirty}
                resetHint="取消裁剪（恢复整幅画面）"
                onReset={() => patch({ crop: { on: false, x: 0, y: 0, w: 100, h: 100 } })}
              >
                <div className="wb-lookgrid" data-crop-ratios="1">
                  {CROP_RATIOS.map((item) => {
                    /* 当前框是否正好等于这个比例（用来点亮按钮） */
                    const target = cropRectFor(item.key, frameAr)
                    const on =
                      Math.abs(target.x - crop.x) < 0.4 &&
                      Math.abs(target.y - crop.y) < 0.4 &&
                      Math.abs(target.w - crop.w) < 0.4 &&
                      Math.abs(target.h - crop.h) < 0.4
                    return (
                      <button
                        key={item.key}
                        type="button"
                        className={`wb-lookchip ${on ? 'on' : ''}`}
                        data-crop-ratio={item.key}
                        aria-pressed={on}
                        onClick={() => {
                          if (item.key === 'free') {
                            patch({ crop: { ...crop, on: true } })
                            return
                          }
                          patch({ crop: { ...cropRectFor(item.key, frameAr), on: true } })
                        }}
                      >
                        {item.label}
                      </button>
                    )
                  })}
                </div>
                <Slider
                  label="左边界"
                  suffix="%"
                  min={0}
                  max={96}
                  value={Math.round(crop.x)}
                  onChange={(value) => patchCrop({ x: Math.min(value, 100 - crop.w) })}
                />
                <Slider
                  label="上边界"
                  suffix="%"
                  min={0}
                  max={96}
                  value={Math.round(crop.y)}
                  onChange={(value) => patchCrop({ y: Math.min(value, 100 - crop.h) })}
                />
                <Slider
                  label="宽度"
                  suffix="%"
                  min={4}
                  max={100}
                  value={Math.round(crop.w)}
                  onChange={(value) => patchCrop({ w: Math.min(value, 100 - crop.x) })}
                />
                <Slider
                  label="高度"
                  suffix="%"
                  min={4}
                  max={100}
                  value={Math.round(crop.h)}
                  onChange={(value) => patchCrop({ h: Math.min(value, 100 - crop.y) })}
                />
                <div className="wb-field">
                  <span>当前框</span>
                  <strong>
                    {Math.round(crop.w)}% × {Math.round(crop.h)}% @ ({Math.round(crop.x)}, {Math.round(crop.y)})
                  </strong>
                </div>
                <p className="wb-insphint">
                  框外的画面会被裁掉，框内的画面**等比放大铺满**画布（cover 口径）。
                  导出先 crop 再 scale，与预览的 transform 是同一套换算。
                </p>
              </Section>
            ) : null}

            {/* ---------- 修复：视频降噪 / 防抖（导出阶段） ---------- */}
            {visualSub === 'heal' ? (
              <>
                <Section
                  title="视频降噪"
                  hook="denoise"
                  dirty={numOf(clip.denoise, 0) > 0}
                  resetHint="关闭降噪"
                  onReset={() => patch({ denoise: 0 })}
                >
                  <Slider
                    label="强度"
                    suffix="%"
                    min={0}
                    max={100}
                    value={Math.round(numOf(clip.denoise, 0))}
                    onChange={(value) => patch({ denoise: value })}
                  />
                  <p className="wb-insphint">
                    降低画面噪点（暗部尤其明显）。<b>导出时应用</b> —— 预览为了实时性不做降噪，
                    成片会比你在这里看到的更干净。
                  </p>
                </Section>

                <Section
                  title="视频防抖"
                  hook="stabilize"
                  dirty={numOf(clip.stabilize, 0) > 0}
                  resetHint="关闭防抖"
                  onReset={() => patch({ stabilize: 0 })}
                >
                  <Slider
                    label="强度"
                    suffix="%"
                    min={0}
                    max={100}
                    value={Math.round(numOf(clip.stabilize, 0))}
                    onChange={(value) => patch({ stabilize: value })}
                  />
                  <p className="wb-insphint">
                    抵消手持拍摄的抖动（走 ffmpeg 的 deshake，边缘用镜像补，不会露黑边）。
                    <b>导出时应用</b>。画面被稳定后会略微放大，构图边角会有一点点变化。
                  </p>
                </Section>
              </>
            ) : null}

            {/* ---------- 基础：混合模式（叠在别的画面上才有意义） ---------- */}
            {visualSub === 'base' && track === 'overlay' ? (
              <Section
                title="混合模式"
                hook="blend"
                on={fx.blend !== 'normal'}
                dirty={fx.blend !== 'normal'}
                resetHint="恢复默认（正常）"
                onReset={() => patchFx({ blend: 'normal' })}
              >
                <div className="wb-lookgrid">
                  {BLEND_MODES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`wb-lookchip ${fx.blend === item.key ? 'on' : ''}`}
                      data-fx-blend-btn={item.key}
                      aria-pressed={fx.blend === item.key}
                      onClick={() => patchFx({ blend: item.key })}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <p className="wb-insphint">
                  混合模式决定画中画怎么和底下的画面叠在一起（导出走 ffmpeg 的 blend，
                  在 sRGB 空间混合，与预览同一口径）。
                </p>
              </Section>
            ) : null}

            {/* ---------- 基础：描边 ---------- */}
            {visualSub === 'base' ? (
              <Section
                title="描边"
                hook="stroke"
                on={fx.stroke.on}
                dirty={fx.stroke.on}
                resetHint="关闭描边"
                onReset={() => patchFx({ stroke: { ...fx.stroke, on: false } })}
              >
                <Toggle
                  label="开启描边"
                  on={fx.stroke.on}
                  hook="stroke"
                  onChange={(on) => patchFx({ stroke: { ...fx.stroke, on } })}
                />
                <Slider
                  label="粗细"
                  suffix="px"
                  min={0}
                  max={STROKE_MAX}
                  value={Math.round(fx.stroke.width)}
                  onChange={(value) => patchFx({ stroke: { ...fx.stroke, width: value } })}
                />
                {/* 四种样式：实线 / 双线 / 发光 / 虚线框 —— 标签直接取真源的表，不在界面里另抄一份 */}
                <div className="wb-lookgrid" data-fx-stroke-styles="1">
                  {STROKE_STYLES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`wb-lookchip ${strokeStyleOf(fx) === item.key ? 'on' : ''}`}
                      data-fx-stroke-style={item.key}
                      aria-pressed={strokeStyleOf(fx) === item.key}
                      onClick={() => patchFx({ stroke: { ...fx.stroke, style: item.key, on: true } })}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <ColorField
                  label={fx.stroke.style === 'double' ? '外圈颜色' : '颜色'}
                  hook="stroke-color"
                  value={fx.stroke.color}
                  onChange={(value) => patchFx({ stroke: { ...fx.stroke, color: value } })}
                />
                {fx.stroke.style === 'double' ? (
                  <ColorField
                    label="内圈颜色"
                    hook="stroke-color2"
                    value={fx.stroke.color2}
                    onChange={(value) => patchFx({ stroke: { ...fx.stroke, color2: value } })}
                  />
                ) : null}
                {fx.stroke.style === 'dashed' ? (
                  <>
                    <Slider
                      label="线段长"
                      suffix="px"
                      min={2}
                      max={DASH_MAX}
                      value={Math.round(fx.stroke.dash)}
                      onChange={(value) => patchFx({ stroke: { ...fx.stroke, dash: value } })}
                    />
                    <Slider
                      label="间隔"
                      suffix="px"
                      min={2}
                      max={DASH_MAX}
                      value={Math.round(fx.stroke.gap)}
                      onChange={(value) => patchFx({ stroke: { ...fx.stroke, gap: value } })}
                    />
                    <p className="wb-insphint">
                      虚线框沿画框四边画，不沿画面轮廓 —— 视频没有可描的轮廓路径，
                      只有逐像素的透明度，硬说「沿轮廓描边」是假的。预览与导出用同一组
                      线段长 / 间隔。
                    </p>
                  </>
                ) : null}
              </Section>
            ) : null}

            {/* ---------- 基础：阴影 ---------- */}
            {visualSub === 'base' ? (
              <Section
                title="阴影"
                hook="shadow"
                on={fx.shadow.on}
                dirty={fx.shadow.on}
                resetHint="关闭阴影"
                onReset={() => patchFx({ shadow: { ...fx.shadow, on: false } })}
              >
                <Toggle
                  label="开启阴影"
                  on={fx.shadow.on}
                  hook="shadow"
                  onChange={(on) => patchFx({ shadow: { ...fx.shadow, on } })}
                />
                {/*
                  内阴影是**互斥的模式**，不是"再叠一层"：
                  `on + inner` = 内阴影，`on` 单独 = 外阴影。
                  导出侧按 `hasOuterShadow` / `hasInnerShadow` 分开判，
                  否则勾了内阴影还会顺带画出一道外阴影。
                */}
                <Toggle
                  label="内阴影（贴边向内）"
                  on={fx.shadow.inner}
                  hook="shadow-inner"
                  onChange={(inner) => patchFx({ shadow: { ...fx.shadow, inner } })}
                />
                <div className="wb-numrow">
                  <NumField
                    label="偏移 X"
                    hook="fx-shx"
                    value={Math.round(fx.shadow.x)}
                    min={-SHADOW_MAX_OFFSET}
                    max={SHADOW_MAX_OFFSET}
                    suffix="px"
                    onChange={(value) => patchFx({ shadow: { ...fx.shadow, x: value } })}
                  />
                  <NumField
                    label="偏移 Y"
                    hook="fx-shy"
                    value={Math.round(fx.shadow.y)}
                    min={-SHADOW_MAX_OFFSET}
                    max={SHADOW_MAX_OFFSET}
                    suffix="px"
                    onChange={(value) => patchFx({ shadow: { ...fx.shadow, y: value } })}
                  />
                </div>
                <Slider
                  label="模糊"
                  suffix="px"
                  min={0}
                  max={SHADOW_MAX_BLUR}
                  value={Math.round(fx.shadow.blur)}
                  onChange={(value) => patchFx({ shadow: { ...fx.shadow, blur: value } })}
                />
                {fx.shadow.inner ? (
                  <>
                    <Slider
                      label="扩展（贴边厚度）"
                      suffix="px"
                      min={0}
                      max={SHADOW_MAX_SPREAD}
                      value={Math.round(fx.shadow.spread)}
                      onChange={(value) => patchFx({ shadow: { ...fx.shadow, spread: value } })}
                    />
                    <p className="wb-insphint">
                      内阴影沿画框矩形向内铺开，不跟随蒙版形状（圆角会跟）。
                      预览是叠在画面上方的一层透明阴影，导出是一张按画框尺寸预生成的
                      距离场图 —— 两端是同一个几何。
                    </p>
                  </>
                ) : null}
                <Slider
                  label="不透明度"
                  suffix="%"
                  min={0}
                  max={100}
                  value={Math.round(fx.shadow.opacity)}
                  onChange={(value) => patchFx({ shadow: { ...fx.shadow, opacity: value } })}
                />
                <ColorField
                  label="颜色"
                  hook="shadow-color"
                  value={fx.shadow.color}
                  onChange={(value) => patchFx({ shadow: { ...fx.shadow, color: value } })}
                />
              </Section>
            ) : null}

            {/* ---------- 抠像 ---------- */}
            {visualSub === 'key' ? (
              <Section
                title="抠像"
                hook="key"
                on={fx.key.on}
                dirty={fx.key.on}
                resetHint="关闭抠像"
                onReset={() => patchFx({ key: { ...fx.key, on: false } })}
              >
                <Toggle
                  label="开启抠像"
                  on={fx.key.on}
                  hook="key"
                  onChange={(on) => patchFx({ key: { ...fx.key, on } })}
                />
                <div className="wb-colorrow">
                  {KEY_PRESETS.map((preset) => (
                    <button
                      key={preset.key}
                      type="button"
                      className={`wb-swatch ${fx.key.color.toUpperCase() === preset.color.toUpperCase() ? 'on' : ''}`}
                      style={{ background: preset.color }}
                      title={`取色：${preset.label} ${preset.color}`}
                      data-fx-key-preset={preset.key}
                      aria-pressed={fx.key.color.toUpperCase() === preset.color.toUpperCase()}
                      onClick={() => patchFx({ key: { ...fx.key, color: preset.color } })}
                    />
                  ))}
                </div>
                <ColorField
                  label="键色"
                  hook="key-color"
                  value={fx.key.color}
                  onChange={(value) => patchFx({ key: { ...fx.key, color: value } })}
                />
                <Slider
                  label="强度"
                  suffix="%"
                  min={0}
                  max={100}
                  value={Math.round(fx.key.similarity)}
                  onChange={(value) => patchFx({ key: { ...fx.key, similarity: value } })}
                />
                <p className="wb-insphint">
                  把键色（绿幕 / 蓝幕）变成透明。导出走 ffmpeg 的 RGB 抠像；
                  预览是同一个通道判定的近似，边缘过渡会略有差异。
                </p>
              </Section>
            ) : null}

            {/* ---------- 蒙版 ---------- */}
            {visualSub === 'mask' ? (
              <Section
                title="蒙版"
                hook="mask"
                on={fx.mask.shape !== 'none'}
                dirty={fx.mask.shape !== 'none'}
                resetHint="去掉蒙版"
                onReset={() =>
                  patchFx({ mask: { ...fx.mask, shape: 'none', x: 50, y: 50, w: 60, h: 60, feather: 0 } })
                }
              >
                <div className="wb-lookgrid">
                  {MASK_SHAPES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`wb-lookchip ${fx.mask.shape === item.key ? 'on' : ''}`}
                      data-fx-mask-shape={item.key}
                      aria-pressed={fx.mask.shape === item.key}
                      onClick={() => patchFx({ mask: { ...fx.mask, shape: item.key } })}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {fx.mask.shape !== 'none' ? (
                  <>
                    {fx.mask.shape === 'linear' || fx.mask.shape === 'mirror' ? (
                      <div className="wb-chiprow" data-mask-axis="1">
                        {MASK_AXES.map((item) => (
                          <button
                            key={item.key}
                            type="button"
                            className={`chip ${fx.mask.axis === item.key ? 'on' : ''}`}
                            data-mask-axis-btn={item.key}
                            aria-pressed={fx.mask.axis === item.key}
                            onClick={() => patchFx({ mask: { ...fx.mask, axis: item.key } })}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    {/* 线性：位置可调；镜面：强制居中（对称），不给位置滑杆 */}
                    {fx.mask.shape !== 'mirror' ? (
                      <Slider
                        label={fx.mask.axis === 'y' && fx.mask.shape === 'linear' ? '中心 Y' : '中心 X'}
                        suffix="%"
                        min={0}
                        max={100}
                        value={Math.round(fx.mask.shape === 'linear' && fx.mask.axis === 'y' ? fx.mask.y : fx.mask.x)}
                        onChange={(value) =>
                          patchFx({
                            mask:
                              fx.mask.shape === 'linear' && fx.mask.axis === 'y'
                                ? { ...fx.mask, y: value }
                                : { ...fx.mask, x: value }
                          })
                        }
                      />
                    ) : null}

                    {fx.mask.shape !== 'linear' && fx.mask.shape !== 'mirror' ? (
                      <Slider
                        label="中心 Y"
                        suffix="%"
                        min={0}
                        max={100}
                        value={Math.round(fx.mask.y)}
                        onChange={(value) => patchFx({ mask: { ...fx.mask, y: value } })}
                      />
                    ) : null}

                    <Slider
                      label={
                        (fx.mask.shape === 'linear' || fx.mask.shape === 'mirror') && fx.mask.axis === 'y'
                          ? '高度'
                          : '宽度'
                      }
                      suffix="%"
                      min={2}
                      max={200}
                      value={Math.round(
                        (fx.mask.shape === 'linear' || fx.mask.shape === 'mirror') && fx.mask.axis === 'y'
                          ? fx.mask.h
                          : fx.mask.w
                      )}
                      onChange={(value) =>
                        patchFx({
                          mask:
                            (fx.mask.shape === 'linear' || fx.mask.shape === 'mirror') && fx.mask.axis === 'y'
                              ? { ...fx.mask, h: value }
                              : { ...fx.mask, w: value }
                        })
                      }
                    />

                    {/* 矩形/椭圆才有独立的「高度」（圆是正圆，条带只有一个尺寸） */}
                    {fx.mask.shape === 'rect' || fx.mask.shape === 'ellipse' ? (
                      <Slider
                        label="高度"
                        suffix="%"
                        min={2}
                        max={200}
                        value={Math.round(fx.mask.h)}
                        onChange={(value) => patchFx({ mask: { ...fx.mask, h: value } })}
                      />
                    ) : null}

                    <Slider
                      label="羽化"
                      suffix="px"
                      min={0}
                      max={120}
                      value={Math.round(fx.mask.feather)}
                      onChange={(value) => patchFx({ mask: { ...fx.mask, feather: value } })}
                    />
                  </>
                ) : null}
                <p className="wb-insphint">
                  蒙版只保留形状内的画面。导出按同一个形状生成遮罩、并按羽化半径做高斯模糊，
                  所以"羽化"在成片里同样是软边。
                </p>
              </Section>
            ) : null}

            {visualSub === 'beauty' ? (
              <Section
                title="美颜"
                hook="beauty"
                dirty={beautyDirty}
                resetHint="恢复默认（不做美颜）"
                onReset={() => patch({ beauty: { smooth: 0, whiten: 0 } })}
              >
                {BEAUTY_PARAMS.map((item) => (
                  <Slider
                    key={item.key}
                    label={item.label}
                    suffix="%"
                    min={item.min}
                    max={item.max}
                    value={beauty[item.key]}
                    onChange={(value) => patch({ beauty: { ...beauty, [item.key]: value } })}
                  />
                ))}
                <p className="wb-insphint">
                  磨皮是把画面做柔化处理（边缘会被轻微放大以避免露边）；美白是整体提亮。
                  两者都会写进导出的滤镜链，预览与成片同一口径。
                </p>
              </Section>
            ) : null}

            {/* 画中画：只有叠加轨上的片段才有意义。
                位置与尺寸写回片段上的 pip，预览与导出读的是同一份。 */}
            {visualSub === 'base' && track === 'overlay' ? (
              <Section title="画中画" hook="pip" dirty={false} resetHint="">
                <div className="wb-pipgrid" data-pipgrid="1">
                  {PIP_ANCHORS.map((anchor) => (
                    <button
                      key={anchor.key}
                      type="button"
                      className={`wb-pipcell ${(clip.pip?.anchor || PIP_DEFAULT_ANCHOR) === anchor.key ? 'on' : ''}`}
                      title={`画中画放在${anchor.label}`}
                      aria-pressed={(clip.pip?.anchor || PIP_DEFAULT_ANCHOR) === anchor.key}
                      data-pip-anchor={anchor.key}
                      onClick={() => patch({ pip: { ...clip.pip, anchor: anchor.key } })}
                    >
                      <i />
                    </button>
                  ))}
                </div>
                <Slider
                  label="画中画大小"
                  suffix="%"
                  min={PIP_MIN_SIZE}
                  max={PIP_MAX_SIZE}
                  value={Math.round(numOf(clip.pip?.size, PIP_DEFAULT_SIZE))}
                  onChange={(value) => patch({ pip: { ...clip.pip, size: value } })}
                />
                <div className="wb-field">
                  <span>当前位置</span>
                  <strong>
                    {pipAnchor(clip.pip?.anchor).label} · {Math.round(numOf(clip.pip?.size, PIP_DEFAULT_SIZE))}%
                  </strong>
                </div>
              </Section>
            ) : null}
          </>
        ) : null}

        {active === 'audio' ? (
          <Section
            title="音频"
            hook="audio"
            dirty={audioDirty}
            resetHint={containerClip ? '恢复默认（音量 100%）' : '恢复默认（音量 100%、无淡入淡出）'}
            onReset={() => patch(containerClip ? { gain: 100 } : { gain: 100, fadeIn: 0, fadeOut: 0 })}
          >
            <Slider
              label="音量"
              suffix="%"
              min={0}
              max={200}
              value={gain}
              onChange={(value) => patch({ gain: value })}
            />
            <div className="wb-field">
              <span>增益</span>
              <strong data-insp-db="1">{gainToDb(gain)}</strong>
            </div>
            {/* 复合片段没有自己的音轨边界（声音来自内部各段），淡入淡出无处可挂 */}
            {containerClip ? null : (
              <>
                <Slider
                  label="淡入时长"
                  suffix="s"
                  min={0}
                  max={FADE_MAX}
                  step={0.1}
                  value={fadeIn}
                  onChange={(value) => patch({ fadeIn: value })}
                />
                <Slider
                  label="淡出时长"
                  suffix="s"
                  min={0}
                  max={FADE_MAX}
                  step={0.1}
                  value={fadeOut}
                  onChange={(value) => patch({ fadeOut: value })}
                />
              </>
            )}
            {containerClip ? (
              <p className="wb-insphint" data-compound-gain="1">
                这里是<b>整块</b>的音量：它乘到展开出来的每一段上（预览与成片同时生效）。
                {compoundClip ? '逐段的音量、淡入淡出请解除复合后调。' : '取哪一路的声音，见「多机位」页。'}
              </p>
            ) : null}
          </Section>
        ) : null}

        {/* ---------------- 音量包络（关键帧） ----------------
            预览每帧按同一个插值把音量乘进 <video>.volume，导出写成 ffmpeg 的
            volume 表达式 —— 所以"这条渐弱曲线"在预览里听得到、成片里也一样。 */}
        {active === 'audio' && !containerClip ? (
          <Section
            title="音量包络"
            hook="volumekf"
            dirty={volumeKf.length > 0}
            resetHint="清除全部包络点（音量回到整段同一个值）"
            onReset={() => patch({ volumeKf: [] })}
          >
            <div className="wb-chiprow" data-volkf="1">
              <button
                type="button"
                className="btn small"
                data-volkf-add="1"
                title={`在播放头（片段内 ${localPlayhead.toFixed(2)}s）打一个点`}
                onClick={() => {
                  const at = Number(localPlayhead.toFixed(3))
                  /* 同一个时刻只留一个点：重复点会得到"同 t 两个值"，插值处取哪个都不对 */
                  const next = [...volumeKf.filter((point) => Math.abs(point.t - at) > 0.05), { t: at, v: gain }]
                    .sort((a, b) => a.t - b.t)
                  patch({ volumeKf: next })
                }}
              >
                在播放头加点
              </button>
              <button
                type="button"
                className="btn small ghost"
                data-volkf-preset="fadeout"
                title="从开头到结尾线性降到静音"
                onClick={() =>
                  patch({
                    volumeKf: [
                      { t: 0, v: gain },
                      { t: Number(numOf(clip.duration, 1).toFixed(3)), v: 0 }
                    ]
                  })
                }
              >
                渐弱
              </button>
              <button
                type="button"
                className="btn small ghost"
                data-volkf-preset="fadein"
                title="从静音线性升到当前音量"
                onClick={() =>
                  patch({
                    volumeKf: [
                      { t: 0, v: 0 },
                      { t: Number(numOf(clip.duration, 1).toFixed(3)), v: gain }
                    ]
                  })
                }
              >
                渐强
              </button>
            </div>

            {volumeKf.length ? (
              <div className="wb-volkf-list" data-volkf-points={volumeKf.length}>
                {volumeKf.map((point, index) => (
                  <div className="wb-numrow" key={`${point.t}-${index}`} data-volkf-point={point.t}>
                    <NumField
                      label={`${point.t.toFixed(2)}s`}
                      hook={`volkf-${index}`}
                      value={point.v}
                      min={0}
                      max={200}
                      suffix="%"
                      onChange={(value) =>
                        patch({ volumeKf: volumeKf.map((item, i) => (i === index ? { ...item, v: value } : item)) })
                      }
                    />
                    <button
                      type="button"
                      className="btn small ghost"
                      title="删除这个点"
                      onClick={() => patch({ volumeKf: volumeKf.filter((_, i) => i !== index) })}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="wb-insphint">
                还没有包络点。把播放头移到需要的位置再点「在播放头加点」，两个点之间会线性过渡；
                每个点的音量是**绝对音量**（会把上面的音量滑杆一起算进去）。
              </p>
            )}
          </Section>
        ) : null}

        {/* ---------------- 音频降噪（导出阶段） ---------------- */}
        {active === 'audio' && !containerClip ? (
          <Section
            title="音频降噪"
            hook="audiodenoise"
            dirty={numOf(clip.audioDenoise, 0) > 0}
            resetHint="关闭降噪"
            onReset={() => patch({ audioDenoise: 0 })}
          >
            <Slider
              label="强度"
              suffix="%"
              min={0}
              max={100}
              value={Math.round(numOf(clip.audioDenoise, 0))}
              onChange={(value) => patch({ audioDenoise: value })}
            />
            <p className="wb-insphint">
              压制底噪（空调声 / 电流声 / 环境嗡声）。<b>导出时应用</b> —— 预览为了实时性不做频域降噪。
              强度过高会让人声发闷，建议 30–60。
            </p>
          </Section>
        ) : null}

        {/* ---------------- 立体声平衡（导出阶段） ----------------
            ⚠️ 预览里做不了：`<audio>` 只有一个 volume，没法按声道分增益。
               真要做只能把每个媒体元素接进 WebAudio（MediaElementSource 每个元素
               只能建一次，建失败就是整条预览静音）—— 代价远大于收益，所以
               和降噪/防抖同一档：面板上明写「导出时应用」。 */}
        {active === 'audio' && !containerClip ? (
          <Section
            title="立体声平衡"
            hook="pan"
            dirty={Math.abs(numOf(clip.pan, 0)) > 0.5}
            resetHint="回到居中（左右相等）"
            onReset={() => patch({ pan: 0 })}
          >
            <Slider
              label="左右"
              min={-100}
              max={100}
              value={Math.round(numOf(clip.pan, 0))}
              onChange={(value) => patch({ pan: value })}
              format={(value) => {
                const n = Math.round(Number(value))
                if (n === 0) return '居中'
                return n < 0 ? `左 ${Math.abs(n)}` : `右 ${n}`
              }}
            />
            <p className="wb-insphint">
              把这一轨整体往左/右偏。<b>导出时应用</b> —— 预览的播放器只有一个总音量，没法按声道分。
              这里改的是左右两个声道的增益，不会把立体声混成单声道。
            </p>
          </Section>
        ) : null}

        {active === 'speed' ? (
          /* 倒放与倍速同页：两者都是"这一段怎么在时间上走"，放一页才不用来回跳。
             ⚠️ 音频轨只给「音频 / 变速」两枚页签，所以倒放必须住在变速页，
                否则音频片段根本没有入口（放到「画面」页就只有视频能倒放）。 */
          <>
          <Section
            title="方向"
            hook="reverse"
            dirty={clip.reverse === true}
            resetHint="恢复正放"
            onReset={() => patch({ reverse: false })}
          >
            {curveOn ? (
              /* 有曲线时**不给开关**，而不是给一个点了没反应的开关：
                 两者对"时间往哪边走"的定义冲突（曲线按进度 v(p) 往前走、倒放是整段反着走）。 */
              <p className="wb-insphint" data-reverse-blocked="1">
                已启用<b>曲线变速</b>，倒放暂不可用 —— 两者对时间方向的语义冲突。
                先清除曲线（下面「变速」里）再倒放。
              </p>
            ) : (
              <Toggle
                label="倒放"
                on={clip.reverse === true}
                hook="reverse"
                onChange={(on) => patch({ reverse: on })}
              />
            )}
            <p className="wb-insphint">
              {clip.kind === 'image'
                ? '图片片段没有时间轴，倒放不会改变任何画面。'
                : clip.reverse === true
                  ? '这一段按倒序播放：预览靠反向取帧实现，导出用 reverse / areverse。声音在预览里静音（浏览器不能反放音频），成片里是完整倒放的。'
                  : '把这一段的画面与声音按倒序播放，时间线占位不变。'}
            </p>
          </Section>
          <Section
            title="变速"
            hook="speed"
            dirty={Math.abs(speed - 1) > 0.001}
            resetHint="恢复原速（1.00x 匀速，时间线占位随之还原）"
            onReset={() => patch({ speed: 1, speedCurve: null })}
          >
            {/* ⚠️ 图片片段不给这一项：图片没有"源素材时间"这个概念（它是按时间线时长
                铺满的一段静止画面），给它一个倍速滑杆，拖了之后画面完全不变。 */}
            {clip.kind === 'image' ? (
              <p className="wb-insphint">图片片段没有源素材时间，不支持变速。</p>
            ) : (
              <>
                {/* 一排预设：常速 + 四条曲线。点一下就把曲线套上，源跨度守恒
                    （吃哪一段源素材不变，变的是它在时间线上占多长）。
                    ⚠️ 复合片段不给这一排（见上面 compoundClip 的说明）。 */}
                {containerClip ? null : (
                <div className="wb-chiprow" data-curve-presets="1">
                  <button
                    key="steady"
                    type="button"
                    className={`chip ${!curveOn && Math.abs(speed - 1) < 0.01 ? 'on' : ''}`}
                    data-curve-preset="none"
                    title="放弃曲线，回到匀速 1.00x"
                    onClick={() => patch({ speed: 1, speedCurve: null })}
                  >
                    常速
                  </button>
                  {CURVE_PRESETS.filter((item) => item.points).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`chip ${presetOn(item) ? 'on' : ''}`}
                      data-curve-preset={item.key}
                      title={item.hint}
                      onClick={() => applyCurve(item.points)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                )}
                {curveOn ? (
                  <>
                    <CurveEditor
                      points={curvePoints}
                      onChange={applyCurve}
                      hook="speed"
                      disabled={clip.reverse === true}
                    />
                    {/* 平均倍速只写一处：编辑器底部那行已经显示了（`data-curve-mean`
                        挂在它上面），这里再列一遍只会让人以为是两个不同的数。 */}
                    <div className="wb-field">
                      <span>时间线占位</span>
                      <strong>{timecodeFrames(Number(clip.duration))}</strong>
                    </div>
                    <div className="wb-field">
                      <span>源素材消耗</span>
                      <strong>{timecode(Number(clip.duration) * speed, false)}</strong>
                    </div>
                    <button
                      className="btn small ghost"
                      type="button"
                      data-curve-clear="1"
                      title="保留当前平均速度，改成匀速"
                      onClick={() => patch({ speed: speed, speedCurve: null })}
                    >
                      清除曲线（保持平均 {speed.toFixed(2)}x）
                    </button>
                  </>
                ) : (
                  <>
                    <Slider
                      label="倍数"
                      suffix="x"
                      min={SPEED_MIN}
                      max={SPEED_MAX}
                      step={0.05}
                      value={speed}
                      onChange={(value) => patch({ speed: value })}
                      format={(value) => `${Number(value).toFixed(2)}x`}
                    />
                    <div className="wb-speedpresets" data-speedpresets="1">
                      {SPEED_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={`chip ${Math.abs(speed - preset) < 0.01 ? 'on' : ''}`}
                          data-speed-preset={preset}
                          title={`把这一段设为 ${preset}x（时间线占位随之变成 ${((Number(clip.duration) * speed) / preset).toFixed(2)} 秒）`}
                          onClick={() => patch({ speed: preset })}
                        >
                          {preset}x
                        </button>
                      ))}
                    </div>
                    <div className="wb-field">
                      <span>源素材消耗</span>
                      <strong>
                        {timecode(Number(clip.duration) * speed, false)}（时间线{' '}
                        {timecodeFrames(Number(clip.duration))}）
                      </strong>
                    </div>
                    {containerClip ? (
                      /* 明写"为什么这里没有曲线"。不写的话用户会以为曲线编辑器和卡点
                         是被砍掉的功能 —— 而不是"这一类片段上它落不了地"。 */
                      <p className="wb-insphint" data-compound-speed="1">
                        {compoundClip ? (
                          <>
                            复合片段按<b>整体匀速</b>变速（内部各段按同一比例一起变）。
                            <b>曲线变速 / 卡点请在内部片段上设</b>：展开时内层的曲线、源入点与
                            时长都是精确保留的。
                          </>
                        ) : (
                          <>
                            多机位按<b>整体匀速</b>变速（每个切换区间按同一比例缩放）。
                            <b>曲线变速 / 卡点请解除多机位后在单个片段上设</b>。
                          </>
                        )}
                      </p>
                    ) : null}
                  </>
                )}
              </>
            )}
          </Section>
          {/* 变速卡点：把"重音"变成"慢动作点"。两个来源 —— 用户自己打的标记，
              或本机 ffmpeg 抽包络后做的能量检测（纯函数在 shared/beat.js）。 */}
          {clip.kind === 'image' || containerClip ? null : (
            <Section title="变速卡点" hook="beat" dirty={false}>
              <div className="wb-beatrow">
                <Slider
                  label="快档"
                  min={1}
                  max={SPEED_MAX}
                  step={0.05}
                  value={beatFast}
                  onChange={setBeatFast}
                  format={(value) => `${Number(value).toFixed(2)}x`}
                />
                <Slider
                  label="慢档"
                  min={SPEED_MIN}
                  max={1}
                  step={0.05}
                  value={beatSlow}
                  onChange={setBeatSlow}
                  format={(value) => `${Number(value).toFixed(2)}x`}
                />
                <Slider
                  label="保持"
                  suffix="s"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={beatHold}
                  onChange={setBeatHold}
                />
                <Slider
                  label="灵敏度"
                  suffix="%"
                  min={0}
                  max={100}
                  step={5}
                  value={beatSensitivity}
                  onChange={setBeatSensitivity}
                />
              </div>
              <div className="wb-chiprow">
                <button
                  className="btn small"
                  type="button"
                  data-beat-marker="1"
                  disabled={!markerHits.length}
                  title={markerHits.length ? '用时间线标记作为重音' : '这段片段范围内没有标记（在时间线上按 M 打一个）'}
                  onClick={beatFromMarkers}
                >
                  按标记（{markerHits.length}）
                </button>
                <button
                  className="btn small"
                  type="button"
                  data-beat-audio="1"
                  disabled={beatBusy}
                  title="用本机 ffmpeg 抽这段音频的振幅包络，再找重音"
                  onClick={beatFromAudio}
                >
                  {beatBusy ? '分析中…' : '按音频检测'}
                </button>
              </div>
              <p className="wb-insphint" data-beat-note={beatNote ? '1' : '0'}>
                {beatNote ||
                  '每个重音处压一段慢动作、重音之间加速。标记用 M 键打；音频检测走本机 ffmpeg，不联网。'}
              </p>
            </Section>
          )}
          {/* 音高：变速要不要保音高（预览与导出都生效）+ 主动变调（只在导出生效，如实标注）。 */}
          {clip.kind === 'image' ? null : (
            <Section
              title="音高"
              hook="pitch"
              dirty={clip.keepPitch === false || Math.abs(numOf(clip.pitch, 0)) > 0.01}
              resetHint="恢复原声（保音高、不变调）"
              onReset={() => patch({ keepPitch: true, pitch: 0 })}
            >
              <Toggle
                label="变速保留音高"
                on={clip.keepPitch !== false}
                hook="keep-pitch"
                onChange={(on) => patch({ keepPitch: on })}
              />
              <p className="wb-insphint">
                关掉之后变速会连音高一起变（磁带快放/慢放那种效果）。预览与导出都按这个开关走。
              </p>
              <Slider
                label="变调"
                min={-6}
                max={6}
                step={1}
                value={numOf(clip.pitch, 0)}
                onChange={(value) => patch({ pitch: value })}
                format={(value) => (Number(value) === 0 ? '不变调' : `${value > 0 ? '+' : ''}${value} 半音`)}
              />
              <p className="wb-insphint">
                <b>导出时应用</b> —— 浏览器没有"指定音高播放"，预览听不到；成片里是准确的
                （改采样率把音高抬上去，再用变速滤镜把时长拉回来，所以变调不改变片段长度）。
              </p>
            </Section>
          )}
          </>
        ) : null}

        {active === 'adjust' ? (
          <>
            <Section
              title="滤镜"
              hook="look"
              dirty={lookDirty}
              resetHint="恢复原片（不使用滤镜）"
              onReset={() => patch({ filter: 'none', filterIntensity: 1 })}
            >
              <div className="wb-lookgrid" data-lookgrid="1">
                {FILTERS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`wb-lookchip ${clip.filter === item.key || (!lookDirty && item.key === 'none') ? 'on' : ''}`}
                    data-look={item.key}
                    title={item.label}
                    onClick={() => patch({ filter: item.key })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {lookDirty ? (
                <Slider
                  label="强度"
                  suffix="%"
                  min={0}
                  max={100}
                  value={Math.round(numOf(clip.filterIntensity, 1) * 100)}
                  onChange={(value) => patch({ filterIntensity: value / 100 })}
                />
              ) : null}
            </Section>

            <Section
              title="调节"
              hook="adjust"
              dirty={adjustDirty}
              resetHint="恢复默认（亮度 / 对比度 / 饱和度 / 色温 / 色调 全部归零）"
              onReset={() => patch({ adjust: { bright: 0, contrast: 0, saturate: 0, temp: 0, tint: 0 } })}
            >
              {ADJUST_PARAMS.map((item) => (
                <Slider
                  key={item.key}
                  label={item.label}
                  min={item.min}
                  max={item.max}
                  value={Math.round(adjustValues[item.key])}
                  onChange={(value) => patch({ adjust: { ...adjustValues, [item.key]: value } })}
                />
              ))}
            </Section>
          </>
        ) : null}

        {active === 'text' ? (
          <>
            <Section
              title="样式"
              hook="textstyle"
              dirty={false}
              resetHint=""
            >
              <label className="wb-num wide">
                <span>样式</span>
                <select
                  className="wb-input"
                  value={styleDef.key}
                  data-insp-textstyle="1"
                  onChange={(event) => patch({ textStyle: event.target.value })}
                >
                  {TEXT_STYLES.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label || item.key}
                    </option>
                  ))}
                </select>
              </label>
              <p className="wb-insphint">左侧「字幕」页里的样式卡与这里是同一个值，改哪边都生效。</p>
            </Section>

            <Section
              title="字体"
              hook="text"
              dirty={textDirty}
              resetHint="恢复样式自带的字号 / 颜色 / 位置"
              onReset={() => patch(resetTextOverrides())}
            >
              {/* 字体：系统默认 / 已导入的自定义字体。
                  ⚠️ 选中后要**同时**写两个字段：textFont 给预览（CSS 家族名）、
                     textFontPath 给导出（drawtext 的 fontfile）——只写一个是
                     "预览换了字体、成片还是老字体"这类最典型的预览/导出分叉。 */}
              <div className="wb-field">
                <span>字体</span>
                <div className="wb-fontrow">
                  <select
                    className="wb-input"
                    value={clip.textFont || ''}
                    data-text-font="1"
                    onChange={(event) => {
                      const id = event.target.value
                      if (!id) return patch({ textFont: '', textFontPath: '' })
                      const font = fonts.find((item) => item.id === id)
                      if (!font) return
                      return patch({ textFont: fontFamilyOf(font.id), textFontPath: font.path })
                    }}
                  >
                    <option value="">系统默认</option>
                    {fonts.map((font) => (
                      <option key={font.id} value={font.id}>
                        {font.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn small ghost"
                    data-text-font-import="1"
                    title="导入 .ttf / .otf / .ttc 字体文件（会复制进本机素材目录，原文件删了也不影响）"
                    onClick={() => onImportFont && onImportFont()}
                  >
                    导入
                  </button>
                </div>
                {!fonts.length ? (
                  <p className="wb-insphint">还没有导入字体。点「导入」选择本机的字体文件。</p>
                ) : null}
              </div>

              <Slider
                label="字号"
                suffix="×"
                min={TEXT_SCALE_MIN}
                max={TEXT_SCALE_MAX}
                step={0.05}
                value={Number(textScale.toFixed(2))}
                format={(value) => `${Number(value).toFixed(2)}×`}
                onChange={(value) => patch({ textScale: value })}
              />

              <div className="wb-field">
                <span>颜色</span>
                <span className="wb-colorrow">
                  <input
                    type="color"
                    value={textColor || styleDef.color || '#ffffff'}
                    data-insp-textcolor="1"
                    onChange={(event) => patch({ textColor: event.target.value.toUpperCase() })}
                  />
                  {TEXT_SWATCHES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`wb-swatch ${textColor === color ? 'on' : ''}`}
                      style={{ background: color }}
                      data-swatch={color}
                      title={`设为 ${color}`}
                      onClick={() => patch({ textColor: color })}
                    />
                  ))}
                  {textColor ? (
                    <button
                      type="button"
                      className="btn small ghost"
                      data-textcolor-clear="1"
                      title="用回样式自带的颜色"
                      onClick={() => patch({ textColor: '' })}
                    >
                      还原
                    </button>
                  ) : null}
                </span>
              </div>

              <div className="wb-subpills tight" role="group" aria-label="字幕位置">
                {[
                  ['top', '顶部'],
                  ['center', '居中'],
                  ['bottom', '底部']
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`wb-subpill ${(textAnchor || styleDef.anchor) === key ? 'on' : ''}`}
                    data-insp-anchor={key}
                    aria-pressed={(textAnchor || styleDef.anchor) === key}
                    onClick={() => patch({ textAnchor: key })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Slider
                label="位置偏移"
                suffix="px"
                min={0}
                max={600}
                value={Math.round(numOf(clip.textOffset, numOf(styleDef.offset, 0)))}
                onChange={(value) => patch({ textOffset: value })}
              />
            </Section>

            {/* ------------------------------ 排版 ------------------------------ */}
            <Section
              title="排版"
              hook="typeset"
              dirty={
                Math.abs(numOf(clip.textLineHeight, 1.22) - 1.22) > 0.001 ||
                ALIGNS.includes(clip.textAlign) ||
                clip.textBgOn === true ||
                clip.textBgOn === false
              }
              resetHint="行距 / 对齐 / 背景框恢复样式自带"
              onReset={() =>
                patch({ textLineHeight: 1.22, textAlign: '', textBgOn: null, textBgColor: '', textBgPad: null })
              }
            >
              <Slider
                label="行距"
                suffix="×"
                min={LINE_MIN}
                max={LINE_MAX}
                step={0.02}
                value={Number(numOf(clip.textLineHeight, 1.22).toFixed(2))}
                format={(value) => `${Number(value).toFixed(2)}×`}
                onChange={(value) => patch({ textLineHeight: value })}
              />

              <div className="wb-subpills tight" role="group" aria-label="水平对齐">
                {[
                  ['left', '左对齐'],
                  ['center', '居中'],
                  ['right', '右对齐']
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`wb-subpill ${(clip.textAlign || 'center') === key ? 'on' : ''}`}
                    data-text-align={key}
                    aria-pressed={(clip.textAlign || 'center') === key}
                    onClick={() => patch({ textAlign: key })}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* 背景框：三态（跟随样式 / 开 / 关）。开关打开时若样式本来没有底色，
                  会自动给一个半透明黑底（见 textOverrides.js），否则"点开但看不见" */}
              <Toggle
                label="背景框"
                hook="textbg"
                on={clip.textBgOn === true}
                onChange={(value) => patch({ textBgOn: value })}
              />

              {clip.textBgOn === true ? (
                <>
                  <div className="wb-field">
                    <span>底色</span>
                    <span className="wb-colorrow">
                      <input
                        type="color"
                        value={clip.textBgColor || '#000000'}
                        data-text-bgcolor="1"
                        onChange={(event) => patch({ textBgColor: event.target.value.toUpperCase() })}
                      />
                      <span className="wb-insphint inline">不透明度只在底色上生效</span>
                    </span>
                  </div>
                  <Slider
                    label="底色不透明"
                    suffix="%"
                    min={0}
                    max={100}
                    value={Math.round(numOf(clip.textBgOpacity, 55))}
                    onChange={(value) => patch({ textBgOpacity: value })}
                  />
                  <Slider
                    label="内边距"
                    suffix="px"
                    min={0}
                    max={BG_PAD_MAX}
                    value={Math.round(numOf(clip.textBgPad, 18))}
                    onChange={(value) => patch({ textBgPad: value })}
                  />
                </>
              ) : null}
            </Section>

            {/* ------------------------------ 文字动画 ------------------------------ */}
            <Section
              title="动画"
              hook="textanim"
              dirty={hasTextAnim(clip)}
              resetHint="入场 / 出场 / 循环恢复默认"
              onReset={() => patch(resetTextAnim())}
            >
              <div className="wb-field">
                <span>入场</span>
                <div className="wb-chiprow">
                  {IN_TYPES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`chip ${textAnim.in === item.key ? 'on' : ''}`}
                      data-text-in={item.key}
                      title={item.key === 'none' ? '不加入场动画' : `入场：${item.label}`}
                      onClick={() => patch({ textIn: item.key })}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="wb-field">
                <span>出场</span>
                <div className="wb-chiprow">
                  {OUT_TYPES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`chip ${textAnim.out === item.key ? 'on' : ''}`}
                      data-text-out={item.key}
                      onClick={() => patch({ textOut: item.key })}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="wb-field">
                <span>持续</span>
                <div className="wb-chiprow">
                  {LOOP_TYPES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`chip ${textAnim.loop === item.key ? 'on' : ''}`}
                      data-text-loop={item.key}
                      title={item.key === 'none' ? '不循环' : `整段循环：${item.label}`}
                      onClick={() => patch({ textLoop: item.key })}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <Slider
                label="入场时长"
                suffix="s"
                min={DUR_MIN}
                max={DUR_MAX}
                step={0.05}
                value={Number(textAnim.inDur.toFixed(2))}
                format={(value) => `${Number(value).toFixed(2)}s`}
                onChange={(value) => patch({ textInDur: value })}
              />
              <Slider
                label="出场时长"
                suffix="s"
                min={DUR_MIN}
                max={DUR_MAX}
                step={0.05}
                value={Number(textAnim.outDur.toFixed(2))}
                format={(value) => `${Number(value).toFixed(2)}s`}
                onChange={(value) => patch({ textOutDur: value })}
              />
              <p className="wb-insphint">
                预览与导出用的是同一组参数：入场（位移 + 淡入）、出场（位移 + 淡出）、
                持续（低幅循环）。幅度按画幅百分比算，所以 1080p 与 4K 导出看起来一样。
              </p>
            </Section>
          </>
        ) : null}
        </div>
      )}

      <p className="wb-insphint total">
        时间线共 {timecode(totalDuration, false)}。
      </p>
    </>
  )
}

/** 百分比音量 → dB（参考显示的是 dB）。0 时给 -∞ 的写法，不写 NaN */
function gainToDb(gain) {
  const g = Number(gain) / 100
  if (!(g > 0)) return '-∞ dB'
  const db = 20 * Math.log10(g)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

/* ------------------------------ 面板本体 ------------------------------ */

/**
 * 工作台右侧面板。
 *
 * 三种态：
 *   1. 什么都没选 → 草稿参数（参考的这一屏给的是**草稿本身**的参数）
 *   2. 选中片段   → 检查器（按轨道给页签：画面 / 音频 / 变速 / 调整 / 字幕）
 *   3. 选中素材   → 素材属性 + 加入时间线
 *
 * ⚠️ 草稿参数那一屏的四个 `data-*` 钩子（`data-draft-panel="1"` /
 *    `data-draft-resolution` / `data-draft-field` / `[data-draft-edit]`）被
 *    tools/check-draft-params.mjs 钉着，改结构时不能顺手删。
 */
export default function Inspector({
  asset,
  clip,
  clips,
  projectName,
  createdAt,
  onProjectNameChange,
  onRemoveClip,
  onAddToTimeline,
  onPatchClip,
  /* 草稿参数（无选中时那一屏）需要的真值：
     saveLocation=草稿实际落盘目录、aspect=当前比例（可改）、
     timelineName=当前时间线名（可改）。三者都来自 App，不在这里现编。 */
  saveLocation = '',
  aspect = '16:9',
  onAspect,
  timelineName = '时间线01',
  onTimelineNameChange,
  /**
   * 右栏那一排页签的当前值（`信息` / `画面` / `音频` / `变速` / `调整` / `字幕`）。
   * 由 App 持有 —— 页签本身画在 App 的列标题里，与这里的内容读同一个真源
   * （`inspectorTabsFor`），避免"页签在 App、选中值在检查器"两处分叉。
   */
  inspTab = 'info',
  /** 页签切换的回调；页签在 App 那边，这里只负责"选中值变了内容跟着走" */
  onInspTab,
  /* 时间线标记（秒）。「按标记卡点」要用，所以从 App 一路传下来 */
  markers = [],
  /** 播放头（音量包络「在播放头加点」要用它；缺省 0 不会崩，只是点在片段头） */
  playhead = 0,
  /* 自定义字体：列表 + 导入动作（都在 App，这里只读不算） */
  fonts = [],
  onImportFont,
  /* 多机位：透传给 ClipInspector（这里不消费，只负责转发） */
  onSwitchMulticamAngle,
  onMulticamAudio,
  onUngroupMulticam,
  /* HDR 体检结果查询（`(path) => { hdr, label, hint } | null`）。
     数据在主进程 ffprobe 里探出来，这里只负责显示 —— 界面上不能自己猜"是不是 HDR"。 */
  hdrOf
}) {
  /** 「草稿参数」的编辑态。只管这一屏的展开/收起，值本身实时写回 App（不留临时副本） */
  const [draftEditing, setDraftEditing] = useState(false)

  const totalDuration = clips.reduce((max, item) => Math.max(max, item.start + item.duration), 0)

  /** 分辨率由比例**算出来**（与导出的 ffmpeg 尺寸同一套 outputSizeFor），不是写死的 1920×1080 */
  const output = outputSizeFor(1920, 1080, aspect)
  const editing = draftEditing
  /** 参考的「修改」是切换编辑态，不是另开一个弹窗；再点一次收起 */
  const editLabel = editing ? '完成' : '修改'

  return (
    <aside className="wb-info">
      <div
        className="wb-info-body"
        title={
          !asset && !clip
            ? '选中时间线上的片段或媒体库里的素材，这里会显示它的属性。生成的素材点“加入时间线”即可参与剪辑。'
            : undefined
        }
      >
        {/* 参考的「信息」面板（空项目、什么都没选中时的一屏）：名字 / 创建时间 / 帧率 / 导入方式。
           ⚠️ 参考里这三种状态是**互斥**的（实测 2026-09-23 空项目 vs 草稿已开的两张截图）：
             空项目 → 信息；草稿已开、无选中 → 草稿参数；选中片段 → 检查器。
           早先这里无条件渲染，导致「选中片段时顶部冒出『名字:』再跟一行『名称:』」、
           「无选中时『导入方式』上下各出现一次」——同一件事说两遍，就是排版乱。
           「名字」虽然可改，但参考里看起来就是一行白字，所以这里不给输入框描边。
           ⚠️ 参考的标签带**半角冒号**（「名字:」「帧率:」「导入方式:」），逐字对齐。 */}
        {!clip && !asset && clips.length === 0 ? (
          <>
            <div className="wb-field">
              <span>名字:</span>
              <input
                className="wb-input plain"
                value={projectName || ''}
                onChange={(event) => onProjectNameChange && onProjectNameChange(event.target.value)}
                placeholder="未命名项目"
                aria-label="项目名称"
              />
            </div>

            <div className="wb-field">
              <span>创建时间:</span>
              <strong>{formatCreatedAt(createdAt)}</strong>
            </div>

            <div className="wb-field">
              <span>帧率:</span>
              <strong>30</strong>
            </div>

            <div className="wb-field">
              <span>导入方式:</span>
              <strong>保留在原有位置</strong>
            </div>
          </>
        ) : null}

        {/* 无选中时的「草稿参数」：参考客户端这一屏给的是**草稿本身**的参数，
            不是某个素材的属性。分成「草稿」与「时间线」两组，右下角一个「修改」。
            ⚠️ 只有真的能改的那三项进编辑态（草稿名 / 时间线名 / 比例），
            其余是**当前实现的事实描述**（见 DRAFT_FLAGS 的注释），不做成可点的假开关。 */}
        {/* ⚠️ 只有「草稿已开、什么都没选中」才给草稿参数：空项目走上面的「信息」，
            否则两屏会同时出现（名字/草稿名称、导入方式各两遍）。 */}
        {!clip && !asset && clips.length > 0 ? (
          <section className="wb-draft" data-draft-panel="1">
            <div className="wb-draft-head">
              <b>草稿参数</b>
              <button
                type="button"
                className={editing ? 'on' : ''}
                onClick={() => setDraftEditing(!editing)}
                aria-pressed={editing}
                data-draft-edit="1"
                title={editing ? '收起编辑（改动已即时生效）' : '修改草稿名称 / 时间线名称 / 比例'}
              >
                {editLabel}
              </button>
            </div>

            <div className="wb-draft-group" data-draft-group="draft">
              <span className="wb-draft-title">草稿</span>

              <div className="wb-field">
                <span>草稿名称:</span>
                {editing ? (
                  <input
                    className="wb-input"
                    value={projectName || ''}
                    onChange={(event) => onProjectNameChange && onProjectNameChange(event.target.value)}
                    aria-label="草稿名称"
                    data-draft-field="name"
                  />
                ) : (
                  <strong>{projectName || '未命名项目'}</strong>
                )}
              </div>

              {/* 真实落盘目录（主进程 userData/drafts），不是装饰文案 */}
              <div className="wb-field">
                <span>保存位置:</span>
                <strong className="wb-path" title={saveLocation}>
                  {saveLocation || '（未落盘）'}
                </strong>
              </div>

              {DRAFT_FLAGS.map(([label, value]) => (
                <div className="wb-field" key={label}>
                  <span>{label}:</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>

            <div className="wb-draft-group" data-draft-group="timeline">
              <span className="wb-draft-title">时间线</span>

              <div className="wb-field">
                <span>时间线名称:</span>
                {editing ? (
                  <input
                    className="wb-input"
                    value={timelineName || ''}
                    onChange={(event) => onTimelineNameChange && onTimelineNameChange(event.target.value)}
                    aria-label="时间线名称"
                    data-draft-field="timelineName"
                  />
                ) : (
                  <strong>{timelineName || '时间线01'}</strong>
                )}
              </div>

              <div className="wb-field">
                <span>比例:</span>
                {editing ? (
                  <select
                    className="wb-input"
                    value={aspect}
                    onChange={(event) => onAspect && onAspect(event.target.value)}
                    aria-label="画面比例"
                    data-draft-field="aspect"
                  >
                    {ASPECTS.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <strong>{aspect}</strong>
                )}
              </div>

              <div className="wb-field">
                <span>分辨率:</span>
                <strong data-draft-resolution={`${output.width}×${output.height}`}>
                  {output.width} × {output.height}
                </strong>
              </div>

              <div className="wb-field">
                <span>草稿帧率:</span>
                <strong>30</strong>
              </div>
            </div>
          </section>
        ) : null}

        {/* 选中片段 → 检查器 */}
        {clip ? (
          <ClipInspector
            clip={clip}
            totalDuration={totalDuration}
            onPatchClip={onPatchClip}
            onRemoveClip={onRemoveClip}
            inspTab={inspTab}
            onInspTab={onInspTab}
            playhead={playhead}
            aspect={aspect}
            fonts={fonts}
            onImportFont={onImportFont}
            markers={markers}
            onSwitchMulticamAngle={onSwitchMulticamAngle}
            onMulticamAudio={onMulticamAudio}
            onUngroupMulticam={onUngroupMulticam}
          />
        ) : null}

        {/*
          HDR 素材必须**说出来**：预览由浏览器直出（HLG 尚可、PQ 常发灰），
          而成片会自动做 SDR 色调映射。不说明的话，用户会以为"这软件把我的片子弄灰了"。
          判据来自主进程 ffprobe 的 color_transfer，不是位深（10-bit ≠ HDR）。

          ⚠️ 这一块**不能放进「选中素材」那一屏**（`asset && !clip`）：剪辑时选中的是
             **片段**，那一屏正是 null。塞在里面的话，用户正在剪一段 HDR 素材时右栏
             一个字都不提"成片会转 SDR" —— hdr-e2e 的界面两条断言就是这么红的。
             它与"素材有哪些属性"无关，是**画面事实**，所以跟着 asset 单独渲染。
        */}
        {asset && hdrOf && asset.path && hdrOf(asset.path)?.hdr ? (
          <div className="wb-field" data-asset-hdr="1">
            <span>色彩</span>
            <strong>{hdrOf(asset.path).label}</strong>
          </div>
        ) : null}
        {asset && hdrOf && asset.path && hdrOf(asset.path)?.hint ? (
          <div className="notice" data-asset-hdr-hint="1" style={{ marginTop: 8 }}>
            {hdrOf(asset.path).hint}
          </div>
        ) : null}

        {/* 选中素材 → 素材属性（参考的空态里没有，选中了目标才有意义）
            ⚠️ 必须 `!clip`：选中时间线上的片段时，App 会把该片段的**源素材**
               一并传进来，两屏叠在一起的后果是「名称」出现两次、上面一套是片段的、
               下面一套是素材的 —— 同一件事说两遍，正是参考里明确避免的乱。 */}
        {asset && !clip ? (
          <>
            <div className="wb-field">
              <span>画布</span>
              <strong>1920 × 1080</strong>
            </div>

            <div className="wb-field">
              <span>时间线</span>
              <strong>
                {clips.length} 个片段 · {timecode(totalDuration, false)}
              </strong>
            </div>

            <div className="section-title" style={{ marginTop: 18 }}>
              <span>选中素材</span>
              <span className="wb-info-actions">
                <button className="btn small" type="button" onClick={() => onAddToTimeline(asset)}>
                  <IconPlus size={12} />
                  加入时间线
                </button>
                {/* 画中画的入口：素材 → 叠加轨。少了它，叠加轨只能靠"往那条轨上拖"才能用，
                    而拖拽这一个入口在界面上没有任何提示，等于功能不存在。 */}
                <button
                  className="btn small ghost"
                  type="button"
                  data-add-overlay="1"
                  onClick={() => onAddToTimeline(asset, 'overlay')}
                >
                  <IconLayers size={12} />
                  加入叠加轨
                </button>
              </span>
            </div>
            <div className="wb-field">
              <span>名称</span>
              <strong title={asset.name}>{asset.name}</strong>
            </div>
            <div className="wb-field">
              <span>类型</span>
              <strong>{KIND_LABEL[asset.kind] || '文件'}</strong>
            </div>
            {asset.capability ? (
              <div className="wb-field">
                <span>生成能力</span>
                <strong>{asset.capability}</strong>
              </div>
            ) : null}
            {asset.modelCode ? (
              <div className="wb-field">
                <span>使用模型</span>
                <strong title={asset.modelCode}>{asset.modelCode}</strong>
              </div>
            ) : null}
            {asset.taskNo ? (
              <div className="wb-field">
                <span>任务号</span>
                <strong className="mono">{asset.taskNo}</strong>
              </div>
            ) : null}
            {asset.width && asset.height ? (
              <div className="wb-field">
                <span>分辨率</span>
                <strong>
                  {asset.width} × {asset.height}
                </strong>
              </div>
            ) : null}
            {asset.duration ? (
              <div className="wb-field">
                <span>时长</span>
                <strong>{timecode(asset.duration, false)}</strong>
              </div>
            ) : null}

            {asset.prompt ? (
              <>
                <div className="section-title" style={{ marginTop: 16 }}>
                  <span>提示词</span>
                </div>
                <div className="notice" style={{ maxHeight: 130, overflowY: 'auto' }}>
                  {asset.prompt}
                </div>
              </>
            ) : null}

            {asset.url ? (
              <button
                className="btn block"
                type="button"
                style={{ marginTop: 11 }}
                /* ⚠️ 不用 window.open：Electron 里它会被主进程拦下交给系统浏览器，
                   「新窗口」是个假象（按钮文案与实际行为不一致，点了像没反应）。
                   走 openExternal 才是名副其实。 */
                onClick={() => openExternal(asset.url).catch(() => {})}
              >
                <IconExternal size={14} />
                在系统浏览器打开原文件
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  )
}
