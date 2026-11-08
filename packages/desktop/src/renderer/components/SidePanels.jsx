import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconAddSquare, IconAlert, IconCheck, IconCoins, IconDownload, IconExternal, IconFolder, IconMic, IconPlugin, IconPlus, IconRefresh, IconSearch, IconSparkle, IconTrash, IconWand } from '../icons.jsx'
import { isDesktop } from '../platform.js'
/* 内置边框库：清单进程内缓存，预览层（Stage.jsx）用的是同一份 */
import { borderCatalog, ensureBorderCatalog, resetBorderCatalog } from '../borderCatalog.js'
/* 内置贴纸清单：贴纸面板与「模板」共用这一份索引（模板按 key 换 yjai-media 地址） */
import { loadStickerCatalog, resetStickerCatalog } from '../stickerIndex.js'
/* 模板：数据在 shared/templates.json，翻译成片段的纯函数在 shared/templates.js */
import { groupsOf as templateGroups, listTemplates, templatesOfGroup } from '../../shared/templates.js'
/* 智能包装：词库判定 + 成套方案都在 shared/packaging.js（纯逻辑，可脱机自测） */
import {
  PACK_LEVELS,
  PACK_STYLES,
  SCENE_COMBOS,
  analyzeScene,
  analyzeTrack
} from '../../shared/packaging.js'
/* 人物特效的效果表（与导出侧同一份：name/hint/kind 都在这里） */
import { FX_LIST } from '../../shared/facefx.js'
/* 抠像的阈值与采样帧率（与主进程同一份 —— 两边各写一个就会出现"界面说抠到了、工具说没有"） */
import { MATTE_FPS, MATTE_MIN_COVERAGE } from '../../shared/matte.js'
import { Slider, timecode, useToast } from '../ui.jsx'
import { ART_FAMILIES } from '../artSet.js'
import {
  CARD_BASE_WIDTH,
  animClassOf,
  sampleFor,
  subtitleStyles,
  textStyleCss,
  textStyleDef,
  textStylesOfGroup,
  titleStyles
} from '../textStyles.js'
import {
  FILTERS,
  TRANSITIONS,
  TRANSITION_LIMITS,
  isNoopFilter,
  isNoopTransition,
  resolveTotalDuration
} from '../looks.js'
/* 手写字幕的字体族清单（与 MCP catalog 共用同一份真源） */
import { handFontChoices } from '../../shared/handFonts.js'
/* 字幕预设：857 款口播动态排版。清单与"翻译成片段"的纯函数都在 shared 里，
   面板只负责画卡片 —— 不在这里算时长、不在这里拼文字，否则 MCP 侧会分叉。 */
import {
  PRESET_COUNT,
  PRESET_GROUPS,
  blockTexts,
  describePreset,
  presetsOfGroup
} from '../../shared/subtitlePresets.js'
import { FILTER_GROUPS, TRANSITION_GROUPS, EFFECT_GROUPS, ADJUST_GROUPS, materialThumb } from '../materials.js'
/* 调节的真源：面板里点一个预设写回的就是这五个键，右栏「调整」页的滑杆读同一份 */
import { ADJUST_PARAMS, readAdjust } from '../../shared/adjust.js'
/** 画面比例真源（与预览共用同一份表，成片按它裁） */
import { DEFAULT_ASPECT, aspectOf, outputSizeFor } from '../../shared/aspect.js'
/* 导出封面：夹取范围与帧对齐必须与主进程同一份（否则面板显示第 3 秒、抽到第 3.03 秒） */
import { coverTimeAt } from '../../shared/cover.js'
/** 导出规格：帧率七档 / 分辨率六档。主进程拼 ffmpeg 参数读的是同一份 —— 必须一致 */
import * as EXPORT_RATE from '../../shared/exportRate.js'
/* 导出编码格式（容器 / 色深 / Alpha）。与主进程同一份表：
   面板上选的东西与 ffmpeg 拼出来的参数必须一一对应，各写一份必然分叉。 */
import * as EXPORT_CODEC from '../../shared/exportCodec.js'
/** 响度统一预设（导出阶段，作用在混完的总线上） */
import { LOUDNESS_MODES } from '../../shared/audio.js'

/** 「我的预设」持久化键。与其它本地设置同前缀，便于一起清理。 */
const PRESET_KEY = 'yjai_desktop_looks_presets'

/**
 * 编码器的显示名。
 * ⚠️ 这里的键必须与主进程 render.js 的 ENCODER_KEYS 一一对应 ——
 *    渲染层多写一个、主进程不认识，那个选项选了就会被静默换回 libx264。
 */
const ENCODER_LABEL = {
  libx264: '软件编码（x264）',
  h264_nvenc: 'NVIDIA 硬件编码（NVENC）',
  h264_qsv: 'Intel 硬件编码（QSV）',
  h264_amf: 'AMD 硬件编码（AMF）',
  libx265: '软件编码（x265）',
  hevc_nvenc: 'NVIDIA 硬件编码（NVENC）',
  hevc_qsv: 'Intel 硬件编码（QSV）',
  hevc_amf: 'AMD 硬件编码（AMF）',
  prores_ks: 'ProRes 编码器（prores_ks）'
}

const readPresets = () => {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.key === 'string') : []
  } catch {
    return []
  }
}

const writePresets = (list) => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list.slice(0, 24)))
  } catch {
    /* 存储写不进去（配额/隐私模式）不该让界面崩，静默降级为仅本次会话可用 */
  }
}

export default function SidePanels(props) {
  const {
    mode,
    clips = [],
    projectName,
    assets = [],
    selectedClip = null,
    /* 播放头所在片段：参数类面板（滤镜/转场/特效）在"没有选中"时兜底到它，
       否则会退化成"点了只弹一句提示"，用户读作"没反应" */
    activeClip = null,
    onPatchClip,
    onAddTextClip,
    onAddToTimeline,
    onSplitEvenly,
    onCloseGaps,
    onClearTextTrack,
    /* 字幕文件的进出、语音分句与 AI 识别（只挂在「字幕 → 字幕模板」页） */
    onImportSubtitle,
    onExportSubtitle,
    onAutoSegment,
    /* AI 识别字幕 + 当前识别任务（`{ busy, done, total }`）。
       进度住在 App 里：切页签会让本面板卸载，进度条不该跟着消失。 */
    onRecognizeSubtitles,
    speechJob = null,
    /* 识别档位：`speechModels` 是主进程报上来的模型清单（含 ready），
       `speechModel` 是用户选的那一档。两样都从 App 透传，
       面板自己不查 —— 一查就会有"面板显示还有这个模型、点了却说没装"的错位。 */
    speechModels = null,
    speechModel = '',
    onPickSpeechModel,
    /* AI 配音：把文字读成人声落成音频片段（本机合成）。ttsJob = `{ busy, error }` */
    onSpeakText,
    ttsJob = null,
    onImport,
    /* 录制面板：录完的片子交给 App 落成片段（素材入库 + 视频轨插在播放头处） */
    onRecorded,
    /* 自定义文字 / 手写字幕共用的两样：
       · textTarget = 当前可写的字幕片段（选中的，或播放头所在的那条），没有则 null；
       · fonts / onImportFont = 已导入字体清单与导入动作（手写面板把它们也列进候选）。 */
    textTarget = null,
    fonts = [],
    onImportFont,
    /* 「字幕 → 字幕预设」：点一款把它的排版落成字幕片段（生成在 App 里，
       因为只有一个 commitClips 出口；面板只把 key 递出去） */
    onAddSubtitlePreset,
    onSetBackdrop,
    /* 当前预览底图（素材 → 背景选的那张）。导出面板要用它把背景也渲进成片。 */
    backdrop = null,
    /* 左栏树节点的 material 字段（"family:index"）——滤镜/转场/特效三页的分组选择 */
    materialGroup = null,
    enhanceGroup = null,
    refArtFamily = null,
    /* 左栏树节点上的「能力码 / 花字组号 / 贴纸组 / 模板组」—— 见 AssetTree.jsx */
    textStyleGroup = null,
    stickerGroup = null,
    templateGroup = null,
    /* 套用一套模板（App 那边生成片段并写进时间线） */
    onApplyTemplate,
    /* 「智能包装」的两套动作（都只改已有片段，不新增台词）：
       口播 = 文字轨批量包装 + 按主题配贴纸；画面 = 主轨统一边框与调色。 */
    packMode = null,
    onApplyPack,
    onClearPack,
    onApplyScene,
    onClearScene,
    /* 人物特效：识别当前片段里的人脸（检测在 App 里跑，面板只负责触发与展示进度） */
    onDetectFace,
    /* 提取音轨这类本地工具要把产物放回素材库 */
    onAddAsset,
    /* 参与导出的片段（App 已按轨道开关 / 停用状态结算过）。
       缺省回退 clips：这样旧的调用点不传也不会崩，只是拿全量。 */
    renderClips = null,
    /* 时间区域（秒）：非空时导出面板给出「只导出这一段」的开关 */
    range = null,
    /* 播放头（秒）。导出面板的「封面」取的就是这一帧 —— 用户把播放头停在想当封面的
       画面上再进导出，符合直觉；让他在导出面板里再挑一次时间才是多余的一步。 */
    playhead = 0,
    /* 「插件」左栏三项（我的插件 / 我的边框 / 我的贴纸）共用一个面板，靠它分 */
    pluginTab = 'mine',
    /* 插件装/删/启停之后 +1。贴纸与边框面板用它当 React key 强制重挂载 ——
       那两个面板都是"有缓存就不重拉"，不清掉就会"插件页说装好了、边框页还是 24 款"。 */
    packsVersion = 0,
    onPacksChanged
  } = props

  if (mode === 'export') {
    return (
      <ExportPanel
        clips={renderClips || clips}
        projectName={projectName}
        backdrop={backdrop}
        aspect={props.aspect || DEFAULT_ASPECT}
        /* 分辨率档与比例一样是草稿属性，必须**显式透传**：
           漏了这一行，面板会退回自己的本地 state —— 下拉能选 4K、画面也对，
           但草稿里存的还是 1080p，重启就丢（"我以为一直选着 4K"）。
           App.jsx 的 draft-params 闸门就是靠这条通路判"重启后还是 4K"。 */
        resolution={props.resolution}
        onResolution={props.onResolution}
        range={range}
        playhead={playhead}
      />
    )
  }
  if (mode === 'text') return <TextPanel onAddTextClip={onAddTextClip} />
  /* 「文字 → 自定义」：自己敲内容再上轨（与「创建文字」共用面板等于这个入口不存在） */
  if (mode === 'text-custom') {
    return <TextCustomPanel onAddTextClip={onAddTextClip} textTarget={textTarget} />
  }
  /* 「字幕 → 手写字幕」：手写字体 + 一键写字幕（预览与导出同一个字体文件） */
  if (mode === 'text-hand') {
    return (
      <HandTextPanel
        onAddTextClip={onAddTextClip}
        fonts={fonts}
        onImportFont={onImportFont}
        textTarget={textTarget}
      />
    )
  }
  /* 「字幕 → 字幕预设」：857 款口播动态排版的排版配方，点一下落 1~4 条字幕 */
  if (mode === 'text-preset') {
    return <SubtitlePresetPanel onAddPreset={onAddSubtitlePreset} />
  }
  /* 「文字 → 花字」与「字幕 → 字幕模板」共用样式页，靠 textStyleGroup 区分：
     null = 显示全部字幕样式（字幕模板），数字 = 花字的第 N 组。 */
  if (mode === 'text-style') {
    return (
      <StylePanel
        clips={clips}
        selectedClip={selectedClip}
        onAddTextClip={onAddTextClip}
        group={textStyleGroup}
        onImportSubtitle={onImportSubtitle}
        onExportSubtitle={onExportSubtitle}
        onAutoSegment={onAutoSegment}
        onRecognizeSubtitles={onRecognizeSubtitles}
        speechJob={speechJob}
        speechModels={speechModels}
        speechModel={speechModel}
        onPickSpeechModel={onPickSpeechModel}
        onSpeakText={onSpeakText}
        ttsJob={ttsJob}
      />
    )
  }
  if (mode === 'extract-audio') {
    return (
      <ExtractAudioPanel
        clips={clips}
        selectedClip={selectedClip}
        activeClip={activeClip}
        onAddAsset={onAddAsset}
      />
    )
  }
  if (mode === 'stock') return <StockPanel assets={assets} onAddToTimeline={onAddToTimeline} />
  /* 智能抠像：本机人像分割，产物是一条透明素材（图片 PNG / 视频 WebM-alpha） */
  if (mode === 'matte') {
    return (
      <MattePanel selectedClip={selectedClip} activeClip={activeClip} onAddAsset={onAddAsset} />
    )
  }
  /* 内置贴纸库（随包离线，140 枚 + 用户插件）：点一枚就加到叠加轨。
     key 跟着 packsVersion 走 —— 插件装完必须重挂载，否则读的还是旧清单。 */
  if (mode === 'sticker') {
    return <StickerPanel key={`sk-${packsVersion}`} group={stickerGroup} onAddToTimeline={onAddToTimeline} />
  }
  /* 「插件」：装的是**素材包**（自定义边框 / 贴纸），不是 .ofx 原生特效 */
  if (mode === 'plugin') {
    return <PluginPanel tab={pluginTab} version={packsVersion} onPacksChanged={onPacksChanged} />
  }
  /* 模板：点一款往时间线加一串片段（开场 / 结尾 / 字幕套，12 款内置） */
  if (mode === 'template') {
    return <TemplatePanel group={templateGroup} projectName={projectName} onApplyTemplate={onApplyTemplate} />
  }
  /* 智能包装：对**已有**字幕/画面批量套（不是往时间线投东西）。
     左栏两项（口播包装 / 画面包装）共用这一个面板，靠 packMode 分。 */
  if (mode === 'packaging') {
    return (
      <PackPanel
        mode={packMode || 'line'}
        clips={clips}
        onApplyPack={onApplyPack}
        onClearPack={onClearPack}
        onApplyScene={onApplyScene}
        onClearScene={onClearScene}
      />
    )
  }
  /* 人物特效：先识别片段里的人脸，再把效果跟着脸走（检测 + 预览 + 成片同一份 track） */
  if (mode === 'facefx') {
    return (
      <FaceFxPanel
        selectedClip={selectedClip}
        activeClip={activeClip}
        onPatchClip={onPatchClip}
        onDetectFace={onDetectFace}
      />
    )
  }
  /* 内置边框库（随包离线，24 款 + 用户插件）：点一款写给**当前片段**（不是投放新片段） */
  if (mode === 'border') {
    return (
      <BorderPanel
        key={`bd-${packsVersion}`}
        selectedClip={selectedClip}
        activeClip={activeClip}
        onPatchClip={onPatchClip}
      />
    )
  }
  if (mode === 'transition') {
    return (
      <TransitionPanel
        clips={clips}
        selectedClip={selectedClip}
        activeClip={activeClip}
        onPatchClip={onPatchClip}
        material={materialGroup}
      />
    )
  }
  if (mode === 'filter') {
    return <FilterPanel selectedClip={selectedClip} activeClip={activeClip} onPatchClip={onPatchClip} material={materialGroup} />
  }
  if (mode === 'adjust') {
    return <AdjustPanel selectedClip={selectedClip} activeClip={activeClip} onPatchClip={onPatchClip} material={materialGroup} />
  }
  if (mode === 'effect') {
    return (
      <EffectPanel
        selectedClip={selectedClip}
        activeClip={activeClip}
        onPatchClip={onPatchClip}
        material={materialGroup}
      />
    )
  }
  if (mode === 'smart') {
    return (
      <SmartPanel
        clips={clips}
        onSplitEvenly={onSplitEvenly}
        onCloseGaps={onCloseGaps}
        onClearTextTrack={onClearTextTrack}
      />
    )
  }
  if (mode === 'preset') return <PresetPanel selectedClip={selectedClip} onPatchClip={onPatchClip} />
  if (mode === 'record') return <RecordPanel onImport={onImport} onRecorded={onRecorded} />
  if (mode === 'ref-art')
    return (
      <RefArtPanel familyKey={refArtFamily} onSetBackdrop={onSetBackdrop} />
    )

  return (
    <Shell>
      <div className="empty">在左侧选一个功能开始</div>
    </Shell>
  )
}

/**
 * 从 `material` 字段里取分组下标（形如 `effects:3` → 3）。
 *
 * 为什么单独一个函数：滤镜 / 转场 / 特效三页都用它，而它有个**静默失效**的形态 ——
 * 写成 `Number(value)` 会得到 NaN，再进 `Math.min` 还是 NaN，
 * 于是 `EFFECT_GROUPS[NaN]` 是 undefined，中栏一片空白且不报错。
 */
function parseMaterialGroup(value) {
  const idx = Number(String(value || '').split(':')[1])
  return Number.isFinite(idx) && idx >= 0 ? idx : 0
}

function MaterialGrid({ items, groupLabel, picked, onPick, onReset, resetLabel, disabled, dataPrefix }) {
  const [query, setQuery] = useState('')
  const kw = query.trim().toLowerCase()
  const shown = kw ? items.filter((it) => (it.zh || '').toLowerCase().includes(kw)) : items
  return (
    <>
      <div className="mat-search">
        <IconSearch size={14} />
        <input
          value={query}
          placeholder="搜索"
          data-mat-search={dataPrefix}
          onChange={(event) => setQuery(event.target.value)}
        />
        {kw ? (
          <button className="mat-search-clear" type="button" aria-label="清空搜索" onClick={() => setQuery('')}>
            <IconPlus size={12} style={{ transform: 'rotate(45deg)' }} />
          </button>
        ) : null}
      </div>
      <div className="mat-group-row">
        <span className="mat-group-name">{groupLabel}</span>
        <span className="grow" />
        {onReset ? (
          <button className="btn small" type="button" data-mat-reset={dataPrefix} onClick={onReset}>
            {resetLabel}
          </button>
        ) : null}
      </div>
      <div className="look-grid">
        {shown.map((item) => {
          const thumb = materialThumb(item.thumb)
          return (
            <button
              key={`${item.zh}|${item.thumb}`}
              type="button"
              className={`look-card ${picked && item.css === picked ? 'active' : ''}`}
              data-material={`${dataPrefix}:${item.zh}`}
              disabled={disabled}
              title={item.zh}
              onClick={() => onPick(item)}
            >
              <span className="look-preview is-photo">
                {thumb ? <img src={thumb} alt="" draggable={false} /> : null}
              </span>
              <span className="look-name">{item.zh}</span>
            </button>
          )
        })}
        {!shown.length ? <div className="empty">没有匹配「{query}」的素材</div> : null}
      </div>
    </>
  )
}

/* ------------------------------- 特效 ------------------------------- */

/**
 * 「特效」页 —— 只有一块：**本机画面特效网格**（materials.js 的 EFFECT_GROUPS）。
 *
 * 开源版没有换脸 / 超分 / 插帧这类要外挂模型的能力，那一屏整块移除，不留入口。
 * 网格里每条都带一个 `css` 键（生成时按名字关键词映射到 frameEffects 的几种真特效）——
 * 点击后预览里**真的动起来**，不是只改个标记。
 */
function EffectPanel({ selectedClip, activeClip, onPatchClip, material }) {
  const toast = useToast()
  /* 与滤镜/转场同一条兜底规则：没选中就用播放头处那个片段 */
  const cut = selectedClip || activeClip || null
  const current = cut?.frameFx || 'none'
  const groupIndex = Math.min(parseMaterialGroup(material), EFFECT_GROUPS.length - 1)
  const matGroup = EFFECT_GROUPS[groupIndex] || EFFECT_GROUPS[0]

  const apply = (item) => {
    if (!cut) {
      toast.bad('时间线上还没有片段，画面特效没有作用对象')
      return
    }
    onPatchClip?.(cut.id, { frameFx: item.css })
    toast.good(`已加上「${item.zh}」，预览里正在实时演示`)
  }

  const reset = () => {
    if (!cut) return
    onPatchClip?.(cut.id, { frameFx: 'none' })
    toast.good('已去掉画面特效')
  }

  return (
    <Shell>
      <MaterialGrid
        items={matGroup.items}
        groupLabel={matGroup.name}
        picked={current === 'none' ? '' : current}
        onPick={apply}
        onReset={current !== 'none' ? reset : null}
        resetLabel="去掉特效"
        disabled={!cut}
        dataPrefix="effect"
      />

    </Shell>
  )
}

/* ------------------------------ 通用外壳 ------------------------------ */

/**
 * 中栏外壳。
 *
 * ⚠️ 参考（实拍九个标签）的中间栏**都没有标题栏**——没有 kicker、没有大标题、
 * 没有「N 种」pill，内容（搜索框 / 网格）直接从顶部开始。这里照参考删掉
 * `.pane-head`。调用方还在传 kicker/title/extra，那些参数继续收着但不再渲染
 * （大改十几个调用点不如收下不用），`extra` 里的功能性元素由各面板自己排进内容区。
 */
function Shell({ children }) {
  return (
    <div className="pane">
      <div className="pane-body">{children}</div>
    </div>
  )
}

/* --------------------------- 文字 / 字幕样式 --------------------------- */

/**
 * 样式选择网格 —— 「文字」与「字幕样式」两页共用。
 *
 * 每一张卡的预览**就是这条样式真的渲染出来的样子**（同一个 textStyleCss，
 * 只把虚拟画幅从 1280 换成 CARD_BASE_WIDTH），不是另画一版示意图 ——
 * 两套画法迟早会漂移，而"卡片上看着是这样、加到画面上却是另一样"是最难查的一类。
 *
 * 卡片上不写名字：参考的字幕样式卡与文字样式卡都是**样式缩略图**本身
 * （数据侧 itemWidth/itemHeight 就是 160×80 与 100×100，没有给名字留行），
 * 名字走悬停提示。这一条与「素材 → 背景」是同一个判据。
 */
function StyleGrid({ items, picked, onPick, sizeKey, testid }) {
  return (
    <div className={`style-grid is-${sizeKey}`} data-style-grid={testid}>
      {items.map((def) => {
        const { box, inner } = textStyleCss(def.key, CARD_BASE_WIDTH)
        return (
          <button
            key={def.key}
            type="button"
            className={`style-card ${picked === def.key ? 'active' : ''}`}
            data-style={def.key}
            title={`${def.label}：${def.hint}`}
            onClick={() => onPick(def)}
          >
            <span className="style-art">
              <span className={`style-art-box ${animClassOf(def)}`} style={box}>
                <span style={inner}>{sampleFor(def)}</span>
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * 「文字」页 —— 文字模板：点一下**新增**一段文字，并停在它上面。
 * 卡片 100×100、间距 16 取自参考 PropertyPanel_TextStyle.qml（itemWidth/itemHeight: 100）。
 */
function TextPanel({ onAddTextClip }) {
  const [picked, setPicked] = useState('')
  const items = titleStyles()
  const pick = (def) => {
    setPicked(def.key)
    onAddTextClip?.({
      label: def.label,
      sample: '在这里输入文字',
      duration: 4,
      size: def.size,
      style: def.key,
      apply: 'add'
    })
  }
  return (
    <Shell kicker="TEXT" title="文字" extra={<span className="pill">{items.length} 种样式</span>}>
      <StyleGrid items={items} picked={picked} onPick={pick} sizeKey="title" testid="text" />
      {/* ⚠️ 这一页**不再**挂「字幕轨」清单：2026-11-02 起它独立成右栏一枚页签
          （`Inspector.jsx` 的 CAPTION_TAB）。左栏只管"往轨上加东西"，
          轨上现有什么在右栏看 —— 同一份清单摆在两页底部，加完一条还得滚到底核对。 */}
    </Shell>
  )
}

/**
 * 「文字 → 自定义」页 —— 自己敲内容，再决定用什么样式、多长。
 *
 * 与「创建文字」的分工：
 *   · 创建文字 = 从样式模板里挑一个，文字内容固定是示例句；
 *   · 自定义   = **先有内容**，再挑样式。
 * 两者必须落在不同的面板上 —— 共用 `panel: 'text'` 时点「自定义」看到的是
 * 同一屏样式卡，等于这个入口不存在（2026-11-09 用户报的就是这个）。
 *
 * 预览用的是**同一条** `textStyleCss`（与预览叠加层、样式卡三处同一份），
 * 所以这里看到的长相就是画面里的长相，不是另画的示意图。
 */
function TextCustomPanel({ onAddTextClip, textTarget }) {
  const [draft, setDraft] = useState('')
  const [styleKey, setStyleKey] = useState('title-hero')
  const [duration, setDuration] = useState(4)
  const items = titleStyles()
  const text = draft.trim()
  /* 空输入时预览用占位句：空白预览框会让人以为"这一页没东西" */
  const previewText = text || '在这里输入文字'
  const { box, inner } = textStyleCss(styleKey)
  const target = textTarget || null

  const submit = (apply) =>
    onAddTextClip?.({
      apply,
      text,
      label: text.length > 10 ? `${text.slice(0, 10)}…` : text,
      style: styleKey,
      duration
    })

  return (
    <Shell>
      <div className="section-title">
        <span>文字内容</span>
        <span className="pill">{text.length} 字</span>
      </div>
      <textarea
        className="input"
        rows={3}
        data-text-custom-input
        value={draft}
        placeholder="在这里输入文字，换行会照原样保留"
        onChange={(event) => setDraft(event.target.value)}
        style={{ resize: 'vertical', lineHeight: 1.6 }}
      />

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <select
          className="input grow"
          data-text-custom-style
          value={styleKey}
          onChange={(event) => setStyleKey(event.target.value)}
          title="文字样式（与「创建文字」里那些样式卡是同一份表）"
        >
          {items.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label || item.key}
            </option>
          ))}
        </select>
        <select
          className="input"
          data-text-custom-duration
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value) || 4)}
          style={{ width: 84 }}
          title="停留时长（之后可以在时间线上拖长）"
        >
          {[2, 3, 4, 5, 8].map((sec) => (
            <option key={sec} value={sec}>
              {sec} 秒
            </option>
          ))}
        </select>
      </div>

      {/* 实况预览：16:9、容器查询单位，套的是同一份 textStyleCss */}
      <div className="wb-tc-stage" data-text-custom-preview aria-hidden="true">
        <div style={box}>
          <span style={inner}>{previewText}</span>
        </div>
      </div>

      <button
        className="btn block primary"
        type="button"
        data-text-custom-add
        disabled={!text}
        onClick={() => submit('add')}
        title={text ? '在播放头位置新增这段文字' : '先输入文字'}
      >
        <IconPlus size={14} />
        加到字幕轨
      </button>
      <button
        className="btn block"
        type="button"
        data-text-custom-apply
        disabled={!text || !target}
        onClick={() => submit('update')}
        title={
          target
            ? `把这段文字写进「${target.name || '当前字幕'}」`
            : '先在时间线上选中一条字幕，或把播放头停在字幕上'
        }
        style={{ marginTop: 8 }}
      >
        <IconCheck size={14} />
        {target ? '写进当前字幕' : '写进选中字幕'}
      </button>
      <div className="wb-muted-sm" style={{ marginTop: 8, lineHeight: 1.65 }}>
        字体、字号、颜色、位置在右侧检查器的「文字」页里调。
      </div>
    </Shell>
  )
}

/**
 * 「字幕 → 手写字幕」页 —— 用手写字体写一条字幕。
 *
 * 为什么是"字体"而不是"手写动画"：
 *   逐笔手写需要每个字的笔画矢量数据，本机没有这份资产；而"预览里逐笔、成片里淡入"
 *   正是我们自己列为红线的那类静默分叉。手写字体是**预览与导出同一条通路**
 *   （预览用家族名、导出用同一个字体文件的绝对路径），点了就真的有手写的样子。
 *
 * 卡片点一下即生效（与样式卡一致）：有可写的目标字幕就换字体，没有就新建一条。
 * 每张卡都带 `data-hand-font`，闸门据此断言"点下去字幕上真的出现了这个字体"。
 *
 * ⚠️ 卡上**不标**"本机装没装"：`document.fonts.check` 对任意名字都返回 true，
 *    canvas 量宽度对汉字又分不出（全角定宽），能确认存在却无法确认不存在 ——
 *    标错一次（四张卡全写"本机没有"）比不标更糟。见 handFonts.js 头注释。
 */
function HandTextPanel({ onAddTextClip, fonts, onImportFont, textTarget }) {
  const [picked, setPicked] = useState('')
  const choices = handFontChoices(fonts)
  const target = textTarget || null

  const use = (item) => {
    setPicked(item.key)
    onAddTextClip?.({
      apply: 'update',
      /* 有目标字幕就保留它原来的正文；没有就写一句能立刻看见效果的示范句 */
      text: target ? String(target.text || '手写文字') : '手写文字',
      label: '手写字幕',
      /* ⚠️ 样式只在**新建**时给：给已有字幕换字体时若也带上 `sub-plain`，
         用户那条居中的大标题会当场缩成底部小字幕 —— 看着像"点手写把样式弄坏了"。
         换字体就只换字体（实测踩过：第一次做时写死 sub-plain，点第二张卡标题就没了）。 */
      style: target ? '' : 'sub-plain',
      duration: 3,
      font: item.family,
      fontPath: item.path
    })
  }

  return (
    <Shell>
      <div className="wb-hand-grid" data-hand-grid>
        {choices.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`wb-hand-card ${picked === item.key ? 'active' : ''}`}
            data-hand-font={item.key}
            title={`${item.label}：${item.hint}`}
            onClick={() => use(item)}
          >
            <span className="wb-hand-art" style={{ fontFamily: `"${item.family}", inherit` }}>
              手写
            </span>
            <span className="wb-hand-name">{item.label}</span>
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button
          className="btn grow"
          type="button"
          data-hand-import
          onClick={() => onImportFont?.()}
          title="导入本机的手写字体文件（.ttf / .otf / .ttc，会复制进素材目录）"
        >
          <IconPlus size={14} />
          导入手写字体
        </button>
      </div>
      <div className="wb-muted-sm" style={{ marginTop: 8, lineHeight: 1.65 }}>
        {target
          ? `当前目标：「${target.name || '选中字幕'}」—— 点字体就换成手写体，正文不变。`
          : '现在没有选中字幕，点字体会新建一条；想改已有字幕就先在时间线上选中它。'}
      </div>
    </Shell>
  )
}

/**
 * 「字幕 → 字幕预设」页 —— 857 款口播动态排版的**排版配方**库。
 *
 * 一款预设 = 一套参数（样式 / 落点 / 对齐 / 字号 / 入场 / 循环 / 行数 / 条数），
 * 由 `shared/subtitlePresets.js` 从清单里取；点一下就把这套参数翻成 1~4 条字幕片段
 * （`planPreset`），落点、动效、文字全都是真的 —— 预览与导出读的是同一份字段。
 *
 * ── 三个必须说清楚的取舍 ────────────────────────────────────────────
 *
 * ① **卡片不用素材包里的封面图**。实测那些封面是黑底占位图，有的还带卖家水印
 *    （旋转的「河爸@同学」），有的横有的竖。按 Jason 的要求，卡面统一用软件自己的
 *    字幕底图（`.style-art` 的 plate.webp）—— 也就是「字幕模板」那页同一张底片，
 *    所以这里直接复用 `.style-art` / `.style-card` 那一套。
 *
 * ② **卡片里的字是这套参数真渲出来的**：同一份 `textStyleCss`（预览与样式卡共用）、
 *    同一套 `ta-in-*`（与预览的入场动画同一组 keyframes），数字来自预设本身。
 *    不是截图，也不是另写一套缩略图逻辑 ——「预览与成片不一致」这类缺陷的源头就是两套。
 *
 * ③ **857 张卡不能一次全渲**。默认 60 张，滚到底点一次加 120。
 *    一次挂 857 个带 `container-type` 的节点会让面板卡成 PPT，
 *    而"卡成 PPT"在用户那里读作"这个功能坏了"。
 */
function SubtitlePresetPanel({ onAddPreset }) {
  const [group, setGroup] = useState('all')
  const [limit, setLimit] = useState(60)
  /* 悬停的那一款才播入场动画：让 60 张卡同时动既费电又看不清 */
  const [hover, setHover] = useState('')

  const items = useMemo(() => presetsOfGroup(group), [group])
  const shown = items.slice(0, limit)

  const pickGroup = (key) => {
    setGroup(key)
    setLimit(60)
    setHover('')
  }

  return (
    <Shell>
      <div className="wb-sp-tabs" data-sp-tabs>
        <button
          type="button"
          className={`wb-sp-tab ${group === 'all' ? 'active' : ''}`}
          data-sp-group="all"
          onClick={() => pickGroup('all')}
        >
          全部 <i>{PRESET_COUNT}</i>
        </button>
        {PRESET_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            className={`wb-sp-tab ${group === g.key ? 'active' : ''}`}
            data-sp-group={g.key}
            title={g.note}
            onClick={() => pickGroup(g.key)}
          >
            {g.label} <i>{g.count}</i>
          </button>
        ))}
      </div>

      <div className="wb-sp-grid" data-sp-grid={group} onMouseLeave={() => setHover('')}>
        {shown.map((preset) => {
          const blocks = blockTexts(preset)
          /* 一条多行时卡片照原样换行（pre-wrap），多条错峰时只展示第一块 + 角标。
             两种都在告诉用户"点下去会得到什么"，不额外画一张示意图。 */
          const preview = blocks[0]
          const { box, inner } = textStyleCss(preset.style, CARD_BASE_WIDTH, {
            textAnchor: preset.anchor,
            textOffset: preset.offset,
            textAlign: preset.align,
            textScale: preset.scale
          })
          const playing = hover === preset.key
          return (
            <button
              key={preset.key}
              type="button"
              className="wb-sp-card"
              data-sp-preset={preset.key}
              data-sp-style={preset.style}
              data-sp-anchor={preset.anchor}
              data-sp-count={preset.chain}
              data-sp-play={playing ? '1' : '0'}
              title={`${preset.name}｜${describePreset(preset)}`}
              onMouseEnter={() => setHover(preset.key)}
              onFocus={() => setHover(preset.key)}
              onClick={() => onAddPreset?.(preset.key)}
            >
              <span className="style-art">
                <span className="wb-sp-box" style={box}>
                  <span
                    className={`wb-sp-line ${playing ? `ta-in-${preset.in}` : ''}`}
                    style={{ ...inner, '--ta-in-dur': `${preset.inDur}s` }}
                  >
                    {preview}
                  </span>
                </span>
                {blocks.length > 1 ? (
                  <span className="wb-sp-badge">{`${blocks.length} 条${preset.mode === 'seq' ? '依次' : '叠加'}`}</span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>

      {!items.length ? <div className="empty">这一组还没有预设。</div> : null}

      {items.length > shown.length ? (
        <button
          className="btn block"
          type="button"
          data-sp-more
          style={{ marginTop: 12 }}
          onClick={() => setLimit((n) => n + 120)}
        >
          再显示 120 款（还有 {items.length - shown.length} 款）
        </button>
      ) : null}
    </Shell>
  )
}

/**
 * 「字幕 → 字幕模板」页 —— 字幕样式（卡片 160×80、间距 16，
 * 取自参考 Subtitles_Materials.qml 与 PropertyPanel_SubtitleStyle.qml）。
 *
 * 行为上**与文字页刻意不同**：这里优先给「播放头处 / 选中的那条字幕」换样式，
 * 没有目标才新建。理由是参考里这一页对应的是 PropertyPanel_SubtitleStyle ——
 * 一个**属性面板**，作用对象是当前选中的字幕；素材页（Subtitles_Materials）才是"再放一条"。
 * 两件事混在一起会出现"我只想让这条字换个样子，结果又多出来一条字幕"。
 */
/**
 * 样式选择页 —— 「字幕 → 字幕模板」与「文字 → 花字」**共用这一个**。
 *
 * `group` 为 null 时是字幕模板（全部 subtitle 样式）；为数字时是花字的第 N 组
 * （参考那页的分组：热门 / 基础 / 纹理 / 发光 / 黄色 / 蓝色 / 红色 / 绿色）。
 */
function StylePanel({
  clips,
  selectedClip = null,
  onAddTextClip,
  group,
  onImportSubtitle,
  onExportSubtitle,
  onAutoSegment,
  onRecognizeSubtitles,
  speechJob = null,
  /* 识别档位（轻量 / 多语种）—— 与 App 里的偏好同一个值 */
  speechModels = null,
  speechModel = '',
  onPickSpeechModel,
  /* AI 配音：点「AI 配音」把文字读成人声落成音频片段（本机合成，文字不出本机） */
  onSpeakText,
  ttsJob = null
}) {
  const isArt = Number.isFinite(group)
  const [picked, setPicked] = useState('')
  const items = isArt ? textStylesOfGroup(group) : subtitleStyles()
  const pick = (def) => {
    setPicked(def.key)
    onAddTextClip?.({
      label: def.label,
      sample: isArt ? '花字标题' : '在这里输入字幕',
      duration: 3,
      size: def.size,
      style: def.key,
      apply: 'restyle'
    })
  }
  return (
    <Shell>
      {!items.length ? (
        <div className="empty">这一组还没有样式。</div>
      ) : (
        <StyleGrid items={items} picked={picked} onPick={pick} sizeKey="subtitle" testid={isArt ? 'text-art' : 'subtitle-style'} />
      )}

      {/* 字幕轨清单已挪到右栏「字幕轨」页（见 Inspector 的 CAPTION_TAB），
          这一页只留"选样式"与下面的字幕文件三件事。 */}

      {/* 字幕文件与语音分句只属于「字幕 → 字幕模板」这一页（`group === null`）。
          花字页共用同一个组件，摆在这里会让"给标题换样子"的人看到一堆导出按钮。 */}
      {isArt ? null : (
        <SubtitleTools
          clips={clips}
          selectedClip={selectedClip}
          onImportSubtitle={onImportSubtitle}
          onExportSubtitle={onExportSubtitle}
          onAutoSegment={onAutoSegment}
          onRecognizeSubtitles={onRecognizeSubtitles}
          speechJob={speechJob}
          speechModels={speechModels}
          speechModel={speechModel}
          onPickSpeechModel={onPickSpeechModel}
          onSpeakText={onSpeakText}
          ttsJob={ttsJob}
        />
      )}
    </Shell>
  )
}

/**
 * 字幕的来源与出口：AI 识别 / 按语音分句 / 导入 / 导出。
 *
 * 为什么这四件事放在一起：它们解决的是同一个问题的两个方向 ——
 * 字幕**从哪来**（本机识别、语音分句、外部 srt）、**到哪去**（导出 srt 带走）。
 * 少了最后一件，用户剪完想发到别的平台就没有出口。
 *
 * ⚠️ 「AI 识别字幕」与「按语音自动分句」**必须并排摆、各自写清差别**：
 *    一个会出文字（要下模型），一个只切时间轴（不用模型）。只留一个的话，
 *    要么用户以为"分句"能出字（点了得到一堆空白），要么在没有模型时以为整个功能坏了。
 *    这也是 2026-11-03 之前本项目一直没敢摆"智能字幕"按钮的原因。
 */
function SubtitleTools({ clips, selectedClip, onImportSubtitle, onExportSubtitle, onAutoSegment, onRecognizeSubtitles, speechJob, speechModels, speechModel, onPickSpeechModel, onSpeakText, ttsJob }) {
  const count = clips.filter((clip) => clip.track === 'text').length
  const busy = Boolean(speechJob && speechJob.busy)
  const percent = busy && speechJob.total ? Math.min(100, Math.round((speechJob.done / speechJob.total) * 100)) : 0

  /* 档位 = 已登记的两个识别模型（轻量中文 / 多语种）。
     没选过就取"第一个装好的那个" —— 与主进程 speech.status().defaultModel 同一套优先级，
     否则界面显示 A、实际跑 B，用户会以为选了不生效。 */
  const rows = Array.isArray(speechModels) ? speechModels : []
  const installed = rows.filter((row) => row && row.ready)
  const activeModel =
    (speechModel && rows.some((row) => row.id === speechModel) ? speechModel : '') ||
    (installed[0] && installed[0].id) ||
    (rows[0] && rows[0].id) ||
    ''

  /* 配音的输入与参数住在面板本地：切页签丢掉没关系（还没生成的东西不算数据），
     但**生成中的任务住在 App 里** —— 否则切走就看不到进度，回来还以为没生成。 */
  const [sayText, setSayText] = useState('')
  const [saySpeed, setSaySpeed] = useState(1)
  const ttsBusy = Boolean(ttsJob && ttsJob.busy)
  const selectedText = selectedClip && selectedClip.track === 'text' ? String(selectedClip.text || '') : ''
  const chars = sayText.trim().length
  return (
    <>
      <div className="section-title" style={{ marginTop: 16 }}>
        <span>AI 识别字幕</span>
        {busy ? <span data-sub-ai-counter>{`${speechJob.done} / ${speechJob.total}`}</span> : null}
      </div>
      <button
        className="btn block primary"
        type="button"
        data-sub-ai
        disabled={busy}
        onClick={() => onRecognizeSubtitles?.()}
        title="把选中片段里的说话内容转成字幕"
      >
        {busy ? <IconRefresh size={14} /> : <IconMic size={14} />}
        {busy ? `正在识别 ${percent}%` : 'AI 识别字幕'}
      </button>
      {busy ? (
        <div className="wb-speech-bar" data-sub-ai-progress={percent} aria-hidden="true">
          <i style={{ width: `${percent}%` }} />
        </div>
      ) : (
        <>
          <div className="wb-muted-sm" style={{ marginTop: 6, lineHeight: 1.6 }}>
            识别完可以直接在时间线上改文字。第一次用会引导你下载语音识别模型。
          </div>
          {/* 档位：轻量版出得快、多语种版更准（还能认粤语/日语/英语混说）。
              没装的档位照样列出来但不可选 —— 只列能用的，用户就永远不知道还有更好的那档。 */}
          {rows.length ? (
            <label className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
              <span className="wb-muted-sm" style={{ flex: '0 0 auto' }}>识别档位</span>
              <select
                className="input grow"
                data-sub-model
                value={activeModel}
                disabled={busy}
                onChange={(event) => onPickSpeechModel?.(event.target.value)}
                title="轻量版快，多语种版更准"
              >
                {rows.map((row) => (
                  <option key={row.id} value={row.id} disabled={!row.ready}>
                    {row.name}
                    {row.ready ? '' : '（未安装）'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>
        <span>AI 配音</span>
        {ttsBusy ? <span data-tts-counter>合成中</span> : null}
      </div>
      <textarea
        className="input"
        rows={3}
        data-tts-text
        value={sayText}
        placeholder="把文字读成人声，生成一条配音音轨"
        onChange={(event) => setSayText(event.target.value)}
        style={{ resize: 'vertical', lineHeight: 1.6 }}
      />
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button
          className="btn"
          type="button"
          data-tts-pick
          disabled={!selectedText}
          title={selectedText ? '把选中字幕的正文填进来' : '先在时间线上选中一条字幕'}
          onClick={() => setSayText(selectedText)}
        >
          用选中字幕
        </button>
        <select
          className="input"
          data-tts-speed
          value={saySpeed}
          onChange={(event) => setSaySpeed(Number(event.target.value) || 1)}
          style={{ width: 92 }}
          title="语速"
        >
          <option value={0.8}>0.8×</option>
          <option value={1}>1.0×</option>
          <option value={1.2}>1.2×</option>
          <option value={1.5}>1.5×</option>
        </select>
        <button
          className="btn grow primary"
          type="button"
          data-tts-run
          disabled={ttsBusy || !chars}
          onClick={() => onSpeakText?.({ text: sayText, speed: saySpeed })}
          title="把文字读成人声"
        >
          {ttsBusy ? <IconRefresh size={14} /> : <IconSparkle size={14} />}
          {ttsBusy ? '合成中' : '生成配音'}
        </button>
      </div>
      <div className="wb-muted-sm" style={{ marginTop: 6, lineHeight: 1.6 }} data-tts-hint>
        {ttsJob && ttsJob.error
          ? ttsJob.error
          : chars
            ? `${chars} 字 · 第一次用会引导你下载音色包。`
            : '第一次用会引导你下载音色包。'}
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>
        <span>字幕文件</span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn grow" type="button" data-sub-import onClick={() => onImportSubtitle?.()}>
          <IconFolder size={14} />
          导入字幕
        </button>
        <button
          className="btn grow"
          type="button"
          data-sub-export
          disabled={!count}
          title={count ? '把字幕轨导出成 SRT 文件' : '字幕轨是空的，没有可导出的内容'}
          onClick={() => onExportSubtitle?.()}
        >
          <IconDownload size={14} />
          导出 SRT
        </button>
      </div>
      <button
        className="btn block"
        type="button"
        style={{ marginTop: 8 }}
        data-sub-vad
        disabled={busy}
        onClick={() => onAutoSegment?.()}
      >
        <IconMic size={14} />
        按语音自动分句
      </button>
      <div className="wb-muted-sm" style={{ marginTop: 6, lineHeight: 1.6 }}>
        导入支持 SRT / VTT / LRC / ASS。按语音分句只切时间轴、不出文字。
      </div>
    </>
  )
}

/* ---------------------------- 本地工具面板 ---------------------------- */

/**
 * 「提取音频」面板：把选中片段的音轨剥出来，落成一条独立音频素材。
 *
 * 走的是本机 ffmpeg（`media.extractAudio`），不联网、不消耗任何额度 ——
 * 开源版所有面板都是这一类：能用本机算力做完的事就在本机做完。
 */
function ExtractAudioPanel({ selectedClip, activeClip, onAddAsset }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [dnBusy, setDnBusy] = useState(false)
  /* 降噪模型的安装状态：`{ ready, runtimeOk, model:{size} }`。
     面板一进来就查一次 —— 用户点按钮之前就该看到"还差一个 0.5MB 的模型"，
     而不是点了才被告知。 */
  const [dnState, setDnState] = useState(null)
  const cut = selectedClip || activeClip || null

  const refreshDn = useCallback(async () => {
    try {
      const st = await window.yjai?.speech?.denoiseStatus?.()
      setDnState(st && st.ok ? st : null)
    } catch {
      setDnState(null)
    }
  }, [])

  useEffect(() => {
    refreshDn()
  }, [refreshDn])

  const run = async () => {
    if (!cut) {
      toast.bad('先在时间线上选中一个片段')
      return
    }
    if (!isDesktop || !window.yjai?.media?.extractAudio) {
      toast.bad('提取音频需要桌面端（要调本机的 ffmpeg）')
      return
    }
    setBusy(true)
    try {
      const result = await window.yjai.media.extractAudio({ sourcePath: cut.path || cut.url || '' })
      if (!result?.ok) {
        toast.bad(result?.error || '提取失败')
        return
      }
      let url = ''
      try {
        url = (await window.yjai.media.url(result.outPath)) || ''
      } catch {
        /* 拿不到 URL 也先入库：播放会降级，但素材不会凭空消失 */
      }
      onAddAsset?.({
        id: `asset_audio_${Date.now().toString(36)}`,
        name: `${cut.name || '片段'} · 音轨`,
        kind: 'audio',
        url,
        path: result.outPath,
        source: 'local',
        duration: result.duration || cut.duration || 0,
        createdAt: new Date().toISOString()
      })
      toast.good('已提取音轨，可在「音频 → 音乐」里试听并拖到音频轨')
    } catch (error) {
      toast.bad(String(error?.message || error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * AI 降噪：把这一段的人声处理干净，落成一条新音轨（与「提取音轨」同一个心智：
   * 都是"从这段里提出能用的声音"，产物进素材库，由用户决定铺到哪）。
   *
   * 为什么不做成片段上的一个开关：降噪模型只吃 16kHz，成片要 48kHz，
   * 中间必然有一次重采样。做成开关的话**预览听到的是原声、成片却是处理过的**，
   * 而这正是本项目明令禁止的"预览与成片不一致"。落成音轨则听得到、看得见、可撤回。
   */
  const runDenoise = async () => {
    if (!cut) {
      toast.bad('先在时间线上选中一个片段')
      return
    }
    if (!isDesktop || !window.yjai?.speech?.denoise) {
      toast.bad('AI 降噪需要桌面端（本机推理）')
      return
    }
    setDnBusy(true)
    try {
      let st = dnState
      if (!st || !st.ready) {
        if (st && st.runtimeOk === false) {
          toast.bad('语音运行时还没装：到「设置 → AI 模型」里装上运行时再来')
          return
        }
        /* 只有 0.5MB，就地下载比"请去设置页点一下"少两步操作 */
        toast('正在下载降噪模型（0.5MB）…')
        const dl = await window.yjai.models.download('speech-denoiser')
        if (!dl || !dl.ok) {
          toast.bad(dl?.error || '降噪模型下载失败')
          return
        }
        st = await window.yjai.speech.denoiseStatus()
        setDnState(st && st.ok ? st : null)
      }

      toast('正在降噪…')
      const res = await window.yjai.speech.denoise({
        url: cut.url || '',
        path: cut.path || '',
        /* 只处理这一段在源文件里的区间：整文件处理会让"只用了 3 秒"也跑满 10 分钟 */
        offset: Number(cut.offset) || 0,
        duration: Number(cut.duration) || 0
      })
      if (!res?.ok) {
        const reason = res?.reason || 'crash'
        if (reason === 'model-missing' || reason === 'runtime-missing') {
          setDnState(null)
          toast.bad(res.error || '降噪模型还没装好')
          return
        }
        toast.bad(res?.error || '降噪失败')
        return
      }

      let url = ''
      try {
        url = (await window.yjai.media.url(res.path)) || ''
      } catch {
        /* 同提取音频：没有播放地址也要先把素材留下 */
      }
      onAddAsset?.({
        id: `asset_denoise_${Date.now().toString(36)}`,
        name: `${cut.name || '片段'} · 降噪`,
        kind: 'audio',
        url,
        path: res.path,
        source: 'local',
        duration: res.duration || cut.duration || 0,
        createdAt: new Date().toISOString()
      })
      /* 报出实测降噪量：这是"真的处理了"的唯一证据。只报"已完成"的话，
         用户听到变化不明显时无从判断是没生效还是素材本来就干净。 */
      toast.good(`已降噪（噪声压低约 ${Math.max(0, Number(res.reducedDb) || 0)} dB），已放进素材库`)
    } catch (error) {
      toast.bad(String(error?.message || error))
    } finally {
      setDnBusy(false)
    }
  }

  return (
    <Shell>
      <div className="section-title">
        <span>提取音频</span>
      </div>
      {cut ? (
        <div className="list">
          <div className="list-item">
            <div className="grow">
              <strong>{cut.name}</strong>
              <small>{timecode(cut.duration || 0, false)}</small>
            </div>
            <button className="btn" type="button" disabled={busy} onClick={run} data-extract-audio>
              {busy ? '提取中…' : '提取音轨'}
            </button>
          </div>
        </div>
      ) : (
        <div className="empty">先在时间线上选中一个片段（或把播放头放到它上面）再提取。</div>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>
        <span>AI 语音降噪</span>
      </div>
      <div className="list">
        <div className="list-item">
          <div className="grow">
            <strong>{cut ? cut.name : '未选中片段'}</strong>
            <small>
              {dnState && dnState.ready
                ? '降噪模型已就绪 · 会生成一条新音轨'
                : dnState && dnState.runtimeOk === false
                  ? '还缺语音运行时（设置 → AI 模型）'
                  : '第一次用会就地下载 0.5MB 降噪模型'}
            </small>
          </div>
          <button
            className="btn"
            type="button"
            disabled={dnBusy || !cut}
            onClick={runDenoise}
            data-ai-denoise
            title="把这一段的人声处理干净，生成一条新音轨放进素材库"
          >
            {dnBusy ? <IconRefresh size={14} /> : <IconSparkle size={14} />}
            {dnBusy ? '处理中…' : dnState && dnState.ready ? 'AI 降噪' : '降噪（含 0.5MB 模型）'}
          </button>
        </div>
      </div>
      <div className="wb-muted-sm" style={{ marginTop: 6, lineHeight: 1.6 }}>
        素材很干净时开了会显得发闷，它适合噪声大到听不清词的情况。
      </div>
    </Shell>
  )
}

/* ------------------------------- 智能抠像 ------------------------------- */

/**
 * 智能抠像：把主体从背景里分出来，产出**一条能叠的透明素材**。
 *
 * 为什么产物是"新素材"而不是片段上的开关（与 AI 降噪同一个判断）：
 *   抠像要逐帧跑推理，预览里逐帧做等于把播放拖成幻灯片。做成开关的话，
 *   要么预览卡、要么预览不抠而成片抠 —— 后者违反了本项目的"预览即成片"。
 *   落成素材则：预览播的就是抠好的那条，成片叠的也是它，两边天然一致。
 *
 * 为什么视频要逐帧写盘再编码，而不是在渲染层直接录：
 *   MediaRecorder 对 alpha 通道的支持随 Chromium 版本漂移（同一个 API 有时出
 *   alpha、有时出黑底），而黑底叠上去看起来"就是抠失败了"。走 PNG 序列 + ffmpeg
 *   的 VP9-alpha 是确定的：`-auto-alt-ref 0` 写死，产物能不能透明可以按字节验。
 *
 * ⚠️ 画面里没人时模型**不报错**，给一份全零遮罩 —— 直接乘上去就是整张透明。
 *    所以这里先看 `coverage`，抠不到主体就明说"这个画面里没找到人"，
 *    不往素材库里塞一张空图（用户会以为是软件坏了）。
 */
function MattePanel({ selectedClip, activeClip, onAddAsset }) {
  const toast = useToast()
  const cut = selectedClip || activeClip || null
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [softness, setSoftness] = useState(50)
  /* 视频抠像的背景：'blur' = 原画面虚化，其余是纯色。
     为什么视频必须选一个背景（不能留空）：ffmpeg 编不出 Chromium 能播的
     带 alpha 视频，所以产物是"已经合好背景的 mp4"——留空就等于产出黑底。 */
  const [bg, setBg] = useState('blur')
  const [modelReady, setModelReady] = useState(null)
  const [last, setLast] = useState(null)
  const cancelRef = useRef(false)

  /* 模型装没装：只影响按钮文案，不影响能不能点。
     不熟的用户看到"含 0.25MB 模型"就知道点下去会发生什么，比跳设置页少两步。 */
  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const st = await window.yjai?.matte?.model?.()
        if (alive) setModelReady(Boolean(st && st.ready))
      } catch {
        if (alive) setModelReady(false)
      }
    }
    read()
    return () => {
      alive = false
    }
  }, [])

  const isImage = Boolean(cut && (cut.kind === 'image' || /\.(png|jpe?g|webp|bmp|gif)$/i.test(cut.path || '')))

  /** 模型没装就地下载（0.25MB，比"请去设置页点一下"少两步） */
  const ensureModel = async () => {
    try {
      const st = await window.yjai.matte.model()
      if (st && st.ready) return true
      toast('正在下载抠像模型（0.25MB）…')
      const dl = await window.yjai.models.download('matte-person')
      if (!dl || !dl.ok) {
        toast.bad(dl?.error || '抠像模型下载失败')
        return false
      }
      setModelReady(true)
      return true
    } catch (error) {
      toast.bad(String(error?.message || error))
      return false
    }
  }

  const run = async () => {
    if (!cut) {
      toast.bad('先在时间线上选中一个图片或视频片段')
      return
    }
    if (!isDesktop || !window.yjai?.matte?.save) {
      toast.bad('智能抠像需要桌面端（本机推理）')
      return
    }
    if (!(await ensureModel())) return

    setBusy(true)
    setLast(null)
    cancelRef.current = false
    try {
      const srcUrl = cut.url || (cut.path ? await window.yjai.media.url(cut.path) : '')
      if (!srcUrl) {
        toast.bad('这个片段没有可读取的文件')
        return
      }
      const { matteOne, matteVideo } = await import('../matte.js')

      if (isImage) {
        const img = new Image()
        /* yjai-media:// 是跨源协议，不声明 crossOrigin 的话 canvas 会被污染，
           `toDataURL` 直接抛 SecurityError（而且是在 drawImage 之后才炸）。 */
        img.crossOrigin = 'anonymous'
        img.src = srcUrl
        await img.decode()
        const out = await matteOne(img, img.naturalWidth, img.naturalHeight, { softness })
        if (out.coverage < MATTE_MIN_COVERAGE) {
          toast.bad('这个画面里没找到人，抠不出主体（人像模型只认人）')
          return
        }
        const dataUrl = out.canvas.toDataURL('image/png')
        const saved = await window.yjai.matte.save({
          base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
          ext: 'png'
        })
        if (!saved || !saved.ok) {
          toast.bad(saved?.error || '保存失败')
          return
        }
        onAddAsset?.({
          id: `asset_matte_${Date.now().toString(36)}`,
          name: `${cut.name || '画面'} · 抠像`,
          kind: 'image',
          url: saved.url || '',
          path: saved.path,
          source: 'local',
          duration: 0,
          createdAt: new Date().toISOString()
        })
        setLast({ kind: 'image', coverage: out.coverage, ms: out.ms, bytes: saved.bytes })
        toast.good(`已抠像（主体占 ${Math.round(out.coverage * 100)}%），放进素材库了`)
        return
      }

      /* ---- 视频：逐帧抠 → 序列帧 → 编码成透明视频 ---- */
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      video.src = srcUrl
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('视频加载超时')), 30000)
        video.addEventListener(
          'loadedmetadata',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
        video.addEventListener(
          'error',
          () => {
            clearTimeout(timer)
            reject(new Error('视频打不开（格式可能不支持）'))
          },
          { once: true }
        )
      })

      /* 时长取片段自己的，不信 video.duration：MediaRecorder 产出的 webm
         头里没有 duration，读出来是 Infinity，会让循环算不出 total。 */
      const duration = Math.max(0.1, Number(cut.duration) || Number(video.duration) || 0)
      if (!Number.isFinite(duration) || duration <= 0.1) {
        toast.bad('这段视频的时长读不出来，先把它拖到时间线上再试')
        return
      }

      const seqId = Math.random().toString(36).slice(2, 10)
      setProgress({ done: 0, total: Math.max(1, Math.ceil(duration * MATTE_FPS)) })

      const res = await matteVideo(video, {
        fps: MATTE_FPS,
        start: 0,
        duration,
        softness,
        bg: bg === 'blur' ? { mode: 'blur' } : { mode: 'color', color: bg },
        onFrame: async ({ base64, index }) => {
          if (cancelRef.current) return
          await window.yjai.matte.seqFrame({ seqId, index, base64 })
        },
        onProgress: (p) => setProgress({ done: p.done, total: p.total })
      })

      if (cancelRef.current) {
        toast('已取消')
        return
      }
      if (!res.frames || res.truncated) {
        toast.bad('这段画面里没找到人，抠不出主体（人像模型只认人）')
        return
      }

      toast('正在合成透明视频…')
      const enc = await window.yjai.matte.encode({
        seqId,
        fps: MATTE_FPS,
        duration: res.frames / MATTE_FPS
      })
      if (!enc || !enc.ok) {
        toast.bad(enc?.error || '合成透明视频失败')
        return
      }
      onAddAsset?.({
        id: `asset_matte_${Date.now().toString(36)}`,
        name: `${cut.name || '片段'} · 抠像`,
        kind: 'video',
        url: enc.url || '',
        path: enc.path,
        source: 'local',
        duration: enc.duration || res.frames / MATTE_FPS,
        createdAt: new Date().toISOString()
      })
      setLast({ kind: 'video', frames: res.frames, coverage: res.coverage, ms: res.ms, bytes: enc.bytes })
      toast.good(`已抠出 ${res.frames} 帧，换好背景的视频在素材库里了`)
    } catch (error) {
      toast.bad(String(error?.message || error))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <Shell>
      <div className="section-title">
        <span>智能抠像</span>
      </div>

      {cut ? (
        <>
          <div className="list">
            <div className="list-item">
              <div className="grow">
                <strong>{cut.name}</strong>
                <small>
                  {isImage ? '图片 · 出一张透明 PNG' : `视频 · ${timecode(cut.duration || 0, false)}`}
                  {modelReady === false ? ' · 首次会下载 0.25MB 模型' : ''}
                </small>
              </div>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={run}
                data-matte-run
                title="把人抠出来，背景变透明"
              >
                {busy ? <IconRefresh size={14} /> : <IconSparkle size={14} />}
                {busy
                  ? progress
                    ? `${Math.min(100, Math.round((progress.done / Math.max(1, progress.total)) * 100))}%`
                    : '准备中…'
                  : modelReady === false
                    ? '抠像（含 0.25MB 模型）'
                    : '开始抠像'}
              </button>
            </div>
          </div>

          {busy && !isImage ? (
            <div style={{ marginTop: 10 }}>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  cancelRef.current = true
                }}
                data-matte-cancel
              >
                取消
              </button>
            </div>
          ) : null}

          <div className="pack-sect" style={{ marginTop: 14 }}>
            <span>边缘</span>
            <em>{Math.round(softness)}%</em>
          </div>
          <div className="pack-levels">
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={softness}
              data-matte-softness
              disabled={busy}
              onChange={(e) => setSoftness(Number(e.target.value))}
            />
          </div>
          <div className="wb-muted-sm" style={{ marginTop: 4, lineHeight: 1.6 }}>
            往左是羽化（头发丝更自然），往右是硬边（边缘更干脆）。
          </div>

          {/* 背景只对视频有意义：图片产出的是透明 PNG（能直接叠），
              而视频装不下透明通道，必须把背景烘进去 —— 这个差别要在界面上说清，
              否则用户会以为"图片能叠、视频却不能"是软件坏了。 */}
          {!isImage ? (
            <>
              <div className="pack-sect" style={{ marginTop: 14 }}>
                <span>换成什么背景</span>
              </div>
              <div className="wb-chiprow" data-matte-bg-group>
                {[
                  { key: 'blur', label: '原画面虚化' },
                  { key: '#000000', label: '黑' },
                  { key: '#ffffff', label: '白' },
                  { key: '#0f7b3f', label: '绿' },
                  { key: '#1414c8', label: '蓝' }
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`chip ${bg === item.key ? 'on' : ''}`}
                    data-matte-bg={item.key}
                    aria-pressed={bg === item.key}
                    disabled={busy}
                    onClick={() => setBg(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="wb-muted-sm" style={{ marginTop: 6, lineHeight: 1.6 }}>
                视频装不下透明通道，抠完会把背景换掉再交给你。想叠在别的画面上，用图片抠像拿透明 PNG。
              </div>
            </>
          ) : null}

          {last ? (
            <div className="wb-muted-sm" data-matte-last style={{ marginTop: 10, lineHeight: 1.6 }}>
              上次：{last.kind === 'image' ? '1 张图' : `${last.frames} 帧`} · 主体占{' '}
              {Math.round((last.coverage || 0) * 100)}% · 用时 {(last.ms / 1000).toFixed(1)} 秒
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty">先在时间线上选中一个图片或视频片段，再抠像。</div>
      )}
    </Shell>
  )
}

/* ------------------------------- 素材 ------------------------------- */

/** 素材库内的四个筛选页签：按 kind 筛本地导入件（本机素材，没有别的来源） */
const STOCK_TABS = [
  { key: 'all', label: '全部', kinds: null },
  { key: 'video', label: '视频', kinds: ['video'] },
  { key: 'audio', label: '音频', kinds: ['audio'] },
  { key: 'image', label: '图片', kinds: ['image'] }
]

function StockPanel({ assets, onAddToTimeline }) {
  const local = assets.filter((asset) => asset.source === 'local')
  const [tab, setTab] = useState('all')
  const active = STOCK_TABS.find((item) => item.key === tab) || STOCK_TABS[0]
  const list = active.kinds ? local.filter((asset) => active.kinds.includes(asset.kind)) : local

  return (
    <Shell
      kicker="STOCK"
      title="素材库"
      extra={<span className="pill">{local.length} 个本地素材</span>}
    >
      <div className="wb-subtabs" style={{ marginBottom: 12 }}>
        {STOCK_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={tab === item.key ? 'active' : ''}
            data-stock-tab={item.key}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {!list.length ? (
        <div className="empty">还没有{active.label}素材。用「媒体文件 → 导入」或把文件拖进窗口。</div>
      ) : (
        <div className="list">
          {list.map((asset) => (
            <div className="list-item" key={asset.id}>
              <div className="grow">
                <strong>{asset.name}</strong>
                <small>
                  {asset.kind === 'audio' ? '音频' : asset.kind === 'image' ? '图片' : asset.kind === 'text' ? '文本' : '视频'}
                  {asset.duration ? ` · ${asset.duration.toFixed(1)}s` : ''}
                </small>
              </div>
              <button className="btn small" type="button" onClick={() => onAddToTimeline?.(asset)}>
                <IconPlus size={14} />
                加入
              </button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  )
}

/* ------------------------------- 贴纸 ------------------------------- */

/**
 * 内置贴纸库面板。
 *
 * 清单由主进程给（`sticker:catalog`），素材走 `yjai-media://` —— 所以这里只需要
 * 一个 `<img src>`，预览、导出、胶片可视化全都复用现成链路，面板自己不碰文件系统。
 *
 * ⚠️ 跳过的两种"看起来能用"的实现：
 *   · 把 140 个 PNG 用 `import` 打进来：构建期会被 Vite 全部内联成 assets，
 *     打包产物体积和启动解包都会明显变差，而且**导出侧拿不到稳定路径**
 *     （hash 文件名每次构建都变），成片里就找不到贴纸。
 *   · 让渲染层自己拼 `file://`：打包进 asar 后 file:// 读不到，开发模式却一切正常 ——
 *     这是本项目反复踩的那一类（只在打包后才现形）。
 */
/**
 * 内置边框库（24 款，`tools/gen-borders.py` 程序生成）。
 *
 * ⚠️ 与贴纸面板**不是一类操作**，别照着贴纸那套写：
 *    贴纸是"往时间线投放一个新片段"，边框是"给**已有片段**写一个属性
 *    （`clip.border = 'br-basic-gold'`）"，跟着片段自己的画框走 ——
 *    画中画加了边框，边框也在画中画那个小框上，不是铺满整个画布。
 *    所以这里点一下是 `onPatchClip`，没有选中片段时**必须明说**，
 *    不能点了什么都不发生（那会被读作"面板坏了"）。
 */
/**
 * 「插件」面板 —— 装的是**素材包**（自定义边框 / 贴纸）。
 *
 * 2026-11-09 Jason：「不需要用户看到的提示内容都去除」⇒ 原先面板顶上那条
 * 「插件是本地素材包…本版本不支持 .ofx 原生插件（那需要实现 OpenFX 宿主接口）」
 * 整块删掉了。理由是它属于**开发视角的免责**：讲我们实现了什么、没实现什么、
 * 缺的接口叫什么名字 —— 剪片用户不需要读这些，而「导入插件文件夹」这个按钮名
 * 本身已经把动作说清了。
 * ⚠️ 删它**不会**造成静默失败：这里的导入入口是「选一个文件夹」，
 *    目录里没有 `manifest.json` 时主进程会回一条真实错误、面板照原样显示在
 *    `[data-plug-error]` 里。也就是说「拿 .ofx 来试」得到的是功能性反馈，不是沉默。
 *
 * 这里能做的是一件真事：选一个文件夹，读 `manifest.json`，把里面的 PNG 收进
 * `<userData>/plugins/<id>/`。装完立刻出现在「特效 → 边框」和「贴纸」里，
 * 拖进时间线、导出成片都直接生效（走的是既有的 yjai-media 链路，三处一行没改）。
 *
 * ⚠️ 三个动作（导入 / 启停 / 删除）之后**必须**做三件事，少一件就会"说装好了、看不到"：
 *    ① `resetBorderCatalog()` + `resetStickerCatalog()` —— 清渲染层缓存；
 *    ② `onPacksChanged()` —— 让 App 把 packsVersion +1，边框/贴纸面板靠 React key 重挂载；
 *    ③ 主进程那边（plugin:install 等）自己清 `packCaches` —— 已经在 IPC 里做了。
 */
function PluginPanel({ tab = 'mine', version = 0, onPacksChanged }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [skipped, setSkipped] = useState([])

  const api = () => {
    if (!isDesktop) return null
    const bridge = typeof window !== 'undefined' && window.yjai && window.yjai.plugins
    return bridge || null
  }

  useEffect(() => {
    let alive = true
    const bridge = api()
    if (!bridge) {
      setError('插件管理只在桌面端可用')
      setList([])
      return () => {
        alive = false
      }
    }
    bridge
      .list()
      .then((res) => {
        if (!alive) return
        if (!res || !res.ok) {
          setError((res && res.error) || '读插件列表失败')
          setList([])
          return
        }
        setError('')
        setList(res.plugins || [])
      })
      .catch((err) => {
        if (!alive) return
        setError((err && err.message) || '读插件列表失败')
        setList([])
      })
    return () => {
      alive = false
    }
  }, [version])

  /* 变更类动作的公共收尾：清两处渲染层缓存 → 通知 App 重挂载 → 刷新本面板 */
  const settle = (res, verb) => {
    setBusy('')
    if (!res) {
      setError(`${verb}没有响应`)
      return
    }
    if (res.canceled) return
    if (!res.ok) {
      setError(res.error || `${verb}失败`)
      return
    }
    setError('')
    setList(res.plugins || [])
    setSkipped(res.skipped || [])
    resetBorderCatalog()
    resetStickerCatalog()
    if (onPacksChanged) onPacksChanged()
  }

  const run = async (key, fn, verb) => {
    if (busy) return
    setBusy(key)
    setError('')
    if (key === 'install') setSkipped([])
    try {
      settle(await fn(), verb)
    } catch (err) {
      setBusy('')
      setError((err && err.message) || `${verb}失败`)
    }
  }

  const doInstall = () => {
    const bridge = api()
    if (!bridge) return
    run('install', () => bridge.install(), '导入')
  }
  const doToggle = (item) => {
    const bridge = api()
    if (!bridge) return
    run(`toggle:${item.id}`, () => bridge.toggle(item.id, !item.enabled), item.enabled ? '停用' : '启用')
  }
  const doRemove = (item) => {
    const bridge = api()
    if (!bridge) return
    run(`remove:${item.id}`, () => bridge.remove(item.id), '删除')
  }
  const doReveal = (item) => {
    const bridge = api()
    if (!bridge) return
    bridge.reveal(item.id).catch(() => {})
  }

  const all = list || []
  const shown = tab === 'border' || tab === 'sticker' ? all.filter((p) => p.kind === tab) : all
  const title = tab === 'border' ? '我的边框' : tab === 'sticker' ? '我的贴纸' : '我的插件'
  const count = shown.reduce((n, p) => n + (Number(p.imageCount) || 0), 0)

  return (
    <Shell>
      <div className="plug-head">
        <strong>{title}</strong>
        <span className="muted">
          {all.length} 个插件 · {count} 张素材
        </span>
      </div>

      <div className="plug-actions-bar">
        <button type="button" className="btn" data-plug-import="1" disabled={Boolean(busy)} onClick={doInstall}>
          <IconPlus size={14} />
          {busy === 'install' ? '正在导入…' : '导入插件文件夹'}
        </button>
        {list === null && <span className="muted">正在读取…</span>}
      </div>

      {error && (
        <div className="empty" data-plug-error="1">
          {error}
        </div>
      )}

      {skipped.length > 0 && (
        <div className="plug-skip" data-plug-skip="1">
          跳过了 {skipped.length} 张：{skipped.slice(0, 4).join('；')}
          {skipped.length > 4 ? ' …' : ''}
        </div>
      )}

      {list !== null && shown.length === 0 && !error && (
        <div className="empty" data-plug-empty="1">
          {tab === 'border'
            ? '还没有自定义边框。导入一个 kind=border 的插件，或者直接从「特效 → 边框」用内置的 24 款。'
            : tab === 'sticker'
              ? '还没有自定义贴纸。导入一个 kind=sticker 的插件，或者从「贴纸」用内置的 140 枚。'
              : '还没有装插件。点上面的「导入插件文件夹」，选一个含 manifest.json 的文件夹。'}
        </div>
      )}

      {shown.length > 0 && (
        <div className="plug-list" data-plug-list="1" data-plug-count={shown.length}>
          {shown.map((item) => (
            <article
              className={`plug-card${item.enabled ? '' : ' is-off'}`}
              key={item.id}
              data-plug-id={item.id}
              data-plug-kind={item.kind}
              data-plug-enabled={item.enabled ? '1' : '0'}
              data-plug-images={item.imageCount}
            >
              <div className="plug-art">
                {item.preview ? <img src={item.preview} alt="" draggable={false} /> : <IconPlugin size={20} />}
              </div>
              <div className="plug-meta">
                <strong title={item.name}>{item.name}</strong>
                <span className="muted">
                  {item.kindLabel} · {item.imageCount} 张 · v{item.version}
                  {item.author ? ` · ${item.author}` : ''}
                </span>
              </div>
              <div className="plug-card-actions">
                <button
                  type="button"
                  className="link"
                  data-plug-toggle={item.id}
                  disabled={Boolean(busy)}
                  onClick={() => doToggle(item)}
                >
                  {item.enabled ? '停用' : '启用'}
                </button>
                <button type="button" className="link" data-plug-reveal={item.id} onClick={() => doReveal(item)}>
                  文件夹
                </button>
                <button
                  type="button"
                  className="link is-danger"
                  data-plug-remove={item.id}
                  disabled={Boolean(busy)}
                  onClick={() => doRemove(item)}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </Shell>
  )
}

function BorderPanel({ selectedClip, activeClip, onPatchClip }) {
  const [catalog, setCatalog] = useState(() => borderCatalog())
  const [error, setError] = useState('')
  const [group, setGroup] = useState('all')

  useEffect(() => {
    if (catalog) return undefined
    let alive = true
    ensureBorderCatalog().then((res) => {
      if (!alive) return
      if (!res || !res.ok) {
        setError((res && res.error) || '边框库读不出来')
        return
      }
      setCatalog(res)
    })
    return () => {
      alive = false
    }
  }, [catalog])

  /* 选中的片段优先；没有选中就用播放头所在的那一段兜底（与滤镜/转场同一口径） */
  const target = selectedClip || activeClip || null
  const applied = (target && target.border) || ''

  if (error) {
    return (
      <Shell>
        <div className="empty" data-border-error="1">
          {error}
        </div>
      </Shell>
    )
  }
  if (!catalog) {
    return (
      <Shell>
        <div className="empty">正在读取内置边框…</div>
      </Shell>
    )
  }

  const groups = catalog.groups || []
  const current = group === 'all' ? null : groups.find((item) => item.key === group)
  const pool = current ? current.items : groups.flatMap((item) => item.items)
  const total = groups.reduce((n, item) => n + item.items.length, 0)

  const apply = (key) => {
    if (!target) return
    /* 再点一次同一个 = 取消（与「调整」里那些预设开关同一手感） */
    onPatchClip?.(target.id, { border: applied === key ? '' : key })
  }

  return (
    <Shell>
      <div className="border-head">
        <strong>边框</strong>
        <span className="muted">
          {target ? `${pool.length} / ${total}` : '先选一个片段'}
        </span>
      </div>
      <div className="border-groups" data-border-groups="1">
        <button
          type="button"
          className={`border-chip${group === 'all' ? ' on' : ''}`}
          onClick={() => setGroup('all')}
        >
          全部
        </button>
        {groups.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`border-chip${group === item.key ? ' on' : ''}`}
            onClick={() => setGroup(item.key)}
          >
            {item.name}
          </button>
        ))}
      </div>

      {!target ? (
        <div className="empty" data-border-hint="1">
          先在时间线上选一个片段，再点边框
        </div>
      ) : null}

      <div className="border-grid" data-border-grid={current ? current.key : 'all'}>
        {pool.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`border-cell${applied === item.key ? ' on' : ''}`}
            title={item.name}
            data-border={item.key}
            onClick={() => apply(item.key)}
          >
            <img src={item.url} alt="" draggable={false} />
            <span className="border-name">{item.name}</span>
          </button>
        ))}
      </div>
    </Shell>
  )
}

function StickerPanel({ group, onAddToTimeline }) {
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (catalog) return undefined
    let alive = true
    /* 缓存与并发合并都在 stickerIndex.js 里 —— 模板套用时也读同一份，
       两处各缓存一份会出现"先开贴纸页再套模板正常、直接套模板少一枚"这种顺序问题。 */
    if (!isDesktop) {
      setError('贴纸库只在桌面端可用')
      return undefined
    }
    loadStickerCatalog().then((res) => {
      if (!alive) return
      if (!res) {
        setError('贴纸库读不出来（内置素材可能没有随包安装）')
        return
      }
      setCatalog(res)
    })
    return () => {
      alive = false
    }
  }, [catalog])

  if (error) {
    return (
      <Shell>
        <div className="empty" data-sticker-error="1">
          {error}
        </div>
      </Shell>
    )
  }
  if (!catalog) {
    return (
      <Shell>
        <div className="empty">正在读取内置贴纸…</div>
      </Shell>
    )
  }

  const groups = catalog.groups || []
  const active = group ? groups.find((item) => item.key === group) : null
  const pool = active ? active.items : groups.flatMap((item) => item.items)
  const keyword = query.trim()
  const list = keyword ? pool.filter((item) => item.name.includes(keyword)) : pool
  const total = groups.reduce((n, item) => n + item.items.length, 0)

  return (
    <Shell>
      <div className="sticker-head">
        <strong>{active ? active.name : '全部贴纸'}</strong>
        <span className="muted">{list.length} / {total}</span>
      </div>
      <div className="sticker-search">
        <IconSearch size={14} />
        <input
          type="search"
          value={query}
          placeholder="搜贴纸名称"
          onChange={(event) => setQuery(event.target.value)}
          data-sticker-search="1"
        />
      </div>

      {!list.length ? (
        <div className="empty">{keyword ? `没有名字含「${keyword}」的贴纸` : '这一类还没有贴纸'}</div>
      ) : (
        <div className="sticker-grid" data-sticker-grid={active ? active.key : 'all'}>
          {list.map((item) => (
            <button
              key={item.key}
              type="button"
              className="sticker-cell"
              title={item.name}
              data-sticker={item.key}
              /* 点一下就直接落在叠加轨上。拖拽落轨是另一条路（要时间线配合），
                 这条先保住"点了就真有东西"—— 只做拖拽的话，误触就什么都没有。 */
              onClick={() =>
                onAddToTimeline?.(
                  {
                    id: `sticker-${item.key}`,
                    name: item.name,
                    url: item.url,
                    kind: 'image',
                    /* 静态图没有源时长：0 表示不设上限，片段可以随意拉长 */
                    duration: 0,
                    source: 'sticker'
                  },
                  'overlay'
                )
              }
            >
              <img src={item.url} alt={item.name} draggable={false} loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </Shell>
  )
}

/* ------------------------------- 模板 ------------------------------- */

/**
 * 缩略示意里的画中画锚点 → 小画框内的百分比位置。
 *
 * 与 shared/pip.json 的九个 anchor 同名 —— 模板卡上那枚小圆点出现在哪，
 * 套到时间线之后贴纸就在哪。对不上就是"卡上看着在右上、加进去跑到左下"。
 */
const TPL_PIP_POS = {
  'left-top': { left: '9%', top: '13%' },
  top: { left: '44%', top: '11%' },
  'right-top': { right: '9%', top: '13%' },
  left: { left: '9%', top: '44%' },
  center: { left: '44%', top: '42%' },
  right: { right: '9%', top: '44%' },
  'left-bottom': { left: '9%', bottom: '15%' },
  bottom: { left: '44%', bottom: '13%' },
  'right-bottom': { right: '9%', bottom: '15%' }
}

/**
 * 文字条在卡片上分几类画（看用户能不能一眼分出"这几款不一样"）。
 *
 * 第一版全部画成同一种白条，于是「字幕套」四张卡看起来一模一样 ——
 * 只有名字不同，等于缩略图没起作用。按样式族给四种观感：
 * 带底色的条（bottom bar / 顶部色条）画成实心块、胶囊标签画成深色块、
 * 强调款画成暖色块、大标题画得更粗。
 */
const tplBarKind = (style) => {
  const key = String(style || '')
  if (key === 'sub-bar' || key === 'title-band') return 'band'
  if (key === 'sub-tag') return 'tag'
  if (key === 'sub-accent') return 'accent'
  if (key.startsWith('title')) return 'title'
  return 'plain'
}

/**
 * 模板卡上的版式示意。
 *
 * 为什么不是"一张缩略图"：模板没有缩略图素材（也不该有 —— 那就要再随包带 12 张图）。
 * 这里按**数据本身**把每条元素摆到它在画面里的位置：文字是横条、贴纸是圆点，
 * 位置取自模板的 anchor。所以这张示意图不是装饰 —— 它真的能反映"套上去长什么样"，
 * 换一条模板、改一个 anchor，它就跟着变。
 */
function TemplateThumb({ tpl }) {
  const clips = Array.isArray(tpl && tpl.clips) ? tpl.clips : []
  const stack = { top: 0, center: 0, bottom: 0 }
  return (
    <span className="tpl-thumb" aria-hidden="true">
      {clips.map((clip, index) => {
        if (clip.type === 'sticker') {
          const pos = TPL_PIP_POS[clip.anchor || 'right-bottom'] || TPL_PIP_POS['right-bottom']
          return <i key={`s${index}`} className="tpl-dot" style={pos} />
        }
        const anchor = clip.anchor === 'top' || clip.anchor === 'bottom' ? clip.anchor : 'center'
        /* 同一锚点上的第二条往下错开：三条字幕套若都画在 18% 会叠成一条粗线 */
        const k = stack[anchor]++
        const pos =
          anchor === 'top'
            ? { top: `${18 + k * 16}%` }
            : anchor === 'bottom'
              ? { bottom: `${16 + k * 14}%` }
              : { top: `${44 + k * 14}%` }
        const kind = tplBarKind(clip.style)
        const size = Number(clip.scale) < 0.9 ? ' is-sub' : ''
        return <i key={`t${index}`} className={`tpl-bar is-${kind}${size}`} style={pos} />
      })}
    </span>
  )
}

/** 卡片副标题：「2 文字 · 1 贴纸」 */
function templateParts(tpl) {
  const clips = Array.isArray(tpl && tpl.clips) ? tpl.clips : []
  const text = clips.filter((c) => c.type === 'text').length
  const sticker = clips.filter((c) => c.type === 'sticker').length
  return [text ? `${text} 文字` : '', sticker ? `${sticker} 贴纸` : ''].filter(Boolean).join(' · ') || '空'
}

/**
 * 「模板」页 —— 成套预设。
 *
 * 点一下 = 往时间线（播放头位置）**加一串片段**，不是"预览一下"。
 * 加进去的就是普通文字 / 贴纸片段：可以改字、拖长、删掉、加动效，
 * 与手工做出来的没有区别（模板只在"生成"这一步存在）。
 */
function TemplatePanel({ group, projectName, onApplyTemplate }) {
  const [busy, setBusy] = useState('')
  const groups = templateGroups()
  const active = group ? groups.find((item) => item.key === group) : null
  const list = active ? templatesOfGroup(active.key) : listTemplates()

  const apply = async (tpl) => {
    if (busy) return
    setBusy(tpl.key)
    try {
      await onApplyTemplate?.(tpl.key)
    } finally {
      setBusy('')
    }
  }

  return (
    <Shell>
      <div className="sticker-head">
        <strong>{active ? active.name : '全部模板'}</strong>
        <span className="muted">{list.length} 款</span>
      </div>

      {!list.length ? (
        <div className="empty">这一组还没有模板</div>
      ) : (
        <div className="tpl-grid" data-tpl-grid={active ? active.key : 'all'}>
          {list.map((tpl) => (
            <button
              key={tpl.key}
              type="button"
              className={`tpl-card${busy === tpl.key ? ' is-busy' : ''}`}
              data-tpl={tpl.key}
              title={tpl.hint}
              onClick={() => apply(tpl)}
            >
              <TemplateThumb tpl={tpl} />
              <span className="tpl-name">{tpl.name}</span>
              <span className="tpl-sub">
                {Number(tpl.duration || 0).toFixed(1)}s · {templateParts(tpl)}
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="tpl-tip">
        点在播放头位置，整套一次加进来。主标题会先填成
        {projectName ? `「${projectName}」` : '当前工程名'}
        ，落地后就是普通片段，可以随便改。
      </p>
    </Shell>
  )
}

/* ------------------------------ 智能包装 ------------------------------ */

/**
 * 「智能包装」页 —— 对**已有内容**批量套包装，不新增一句台词。
 *
 * 两种模式（左栏两项）走的是同一套"改属性 + 记住原值"的路子，差别只在改哪一类片段：
 *   · 口播包装 —— 文字轨：统一样式、关键句放大并加循环、按主题配贴纸；
 *   · 画面包装 —— 主轨：统一边框 + 滤镜。
 *
 * ⚠️ 判定"哪句是关键句"用的是 `shared/packaging.js` 里那张词库，纯本地、可解释。
 *    面板把命中词也写出来（`data-pack-key`），判错了用户能看见理由，
 *    而不是面对一个说不清为什么变黄的字幕。
 */
function PackPanel({
  mode = 'line',
  clips,
  onApplyPack,
  onClearPack,
  onApplyScene,
  onClearScene
}) {
  const [style, setStyle] = useState('web-yellow')
  const [level, setLevel] = useState('normal')
  const [combo, setCombo] = useState('clean')
  const [busy, setBusy] = useState(false)

  const isScene = mode === 'scene'
  const lineStat = analyzeTrack(clips)
  const sceneStat = analyzeScene(clips)

  const run = async (action) => {
    if (busy) return
    setBusy(true)
    try {
      await action?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <div className="sticker-head">
        <strong>{isScene ? '画面包装' : '口播包装'}</strong>
        <span className="muted" data-pack-stat={isScene ? 'scene' : 'line'}>
          {isScene ? `${sceneStat.total} 段画面` : `${lineStat.total} 条字幕`}
        </span>
      </div>

      {isScene ? (
        <>
          <div className="pack-sect">
            <span>组合</span>
            <em>边框 + 调色一起套</em>
          </div>
          <div className="pack-grid" data-pack-grid="scene">
            {SCENE_COMBOS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`pack-card${combo === item.key ? ' is-on' : ''}`}
                data-pack-combo={item.key}
                title={item.hint}
                onClick={() => setCombo(item.key)}
              >
                <span className={`pack-frame is-${item.key}`} aria-hidden="true" />
                <span className="pack-name">{item.name}</span>
              </button>
            ))}
          </div>
          <div className="pack-actions">
            <button
              type="button"
              className="btn primary"
              data-pack-apply="scene"
              disabled={busy || sceneStat.total === 0}
              onClick={() => run(() => onApplyScene?.(combo))}
            >
              一键套用
            </button>
            <button
              type="button"
              className="btn"
              data-pack-clear="scene"
              disabled={busy || sceneStat.packed === 0}
              onClick={() => run(() => onClearScene?.())}
            >
              清除
            </button>
          </div>
          {sceneStat.total === 0 ? (
            <p className="tpl-tip" data-pack-empty="scene">
              主轨还没有画面片段 —— 先把视频拖到下面的时间线，再回来套包装。
            </p>
          ) : (
            <p className="tpl-tip">
              给主轨每一段统一加边框与调色，画中画与字幕不受影响。
              已套 {sceneStat.packed} 段，其中 {sceneStat.framed} 段有边框、
              {sceneStat.graded} 段在调色。
            </p>
          )}
        </>
      ) : (
        <>
          <div className="pack-sect">
            <span>风格</span>
            <em>改字幕样式与配色</em>
          </div>
          <div className="pack-grid" data-pack-grid="line">
            {PACK_STYLES.map((item) => {
              const def = textStyleDef(item.style)
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`pack-card${style === item.key ? ' is-on' : ''}`}
                  data-pack-style={item.key}
                  title={item.hint}
                  onClick={() => setStyle(item.key)}
                >
                  {/* 卡片上的字样用**真实样式表**的颜色与描边色，不另画一版示意图：
                      两套画法迟早会漂移，而"卡片上看着是黄的、套上去却是白的"最难查 */}
                  <span
                    className="pack-sample"
                    style={{
                      color: def.color,
                      fontWeight: def.weight || 700,
                      textShadow: `0 0 3px ${def.strokeColor || '#000'}`
                    }}
                  >
                    绝了
                  </span>
                  <span className="pack-name">{item.name}</span>
                </button>
              )
            })}
          </div>

          <div className="pack-sect">
            <span>强度</span>
            <em>关键句放大多少</em>
          </div>
          <div className="pack-levels" data-pack-levels="line">
            {PACK_LEVELS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`pack-lv${level === item.key ? ' is-on' : ''}`}
                data-pack-level={item.key}
                title={item.hint}
                onClick={() => setLevel(item.key)}
              >
                {item.name}
              </button>
            ))}
          </div>

          <div className="pack-actions">
            <button
              type="button"
              className="btn primary"
              data-pack-apply="line"
              disabled={busy || lineStat.total === 0}
              onClick={() => run(() => onApplyPack?.(style, level))}
            >
              一键包装
            </button>
            <button
              type="button"
              className="btn"
              data-pack-clear="line"
              disabled={busy || (lineStat.packed === 0 && lineStat.autoStickers === 0)}
              onClick={() => run(() => onClearPack?.())}
            >
              清除
            </button>
          </div>

          {lineStat.total === 0 ? (
            <p className="tpl-tip" data-pack-empty="line">
              字幕轨上还没有字幕 —— 先从「字幕」页加几句，或导入一份字幕文件，再回来包装。
            </p>
          ) : (
            <p className="tpl-tip">
              识别到 {lineStat.total} 条字幕，其中 <b>{lineStat.keys.length}</b> 条判为关键句
              （按内置词库匹配情绪 / 量化 / 方法词，纯本地，不联网）。
              {lineStat.packed
                ? ` 已包装 ${lineStat.packed} 条${lineStat.autoStickers ? `，配了 ${lineStat.autoStickers} 枚贴纸` : ''}。`
                : ''}
            </p>
          )}

          {lineStat.keys.length ? (
            <div className="pack-keys" data-pack-keys={lineStat.keys.length}>
              {lineStat.keys.slice(0, 6).map((item) => (
                <span className="pack-key" key={item.id} data-pack-key={item.id} title={item.hits.map((h) => h.word).join(' / ')}>
                  {(item.hits[0] && item.hits[0].word) || '关键句'}
                </span>
              ))}
              {lineStat.keys.length > 6 ? <span className="pack-key is-more">+{lineStat.keys.length - 6}</span> : null}
            </div>
          ) : null}
        </>
      )}
    </Shell>
  )
}

/* ----------------------------- 人物特效 ----------------------------- */

/**
 * 人物特效面板。
 *
 * 交互上是「两步」而不是一步，这是有意的：
 *   ① **识别**（几秒钟，会出进度）—— 产物是 `clip.faceTrack`，一串人脸框；
 *   ② **套效果**（瞬间）—— 写 `clip.face = { fx, strength }`。
 * 合成一步的话，用户每换一次效果就要重跑一遍识别，而"换效果"是最常做的动作。
 *
 * ⚠️ 识别结果只写一次、两个消费端共用：
 *   预览（Stage.jsx）与成片（main/render.js）都从 `clip.faceTrack` 取，
 *    各自调 `shared/facefx.js` 的 `trackAt`。任何一侧另存一份都会漂。
 */
function FaceFxPanel({ selectedClip, activeClip, onPatchClip, onDetectFace }) {
  const clip = selectedClip || activeClip
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')

  const isVisual = Boolean(clip) && clip.track !== 'audio' && clip.track !== 'text'
  const track = isVisual && Array.isArray(clip.faceTrack) ? clip.faceTrack : []
  const applied = isVisual && clip.face && clip.face.fx ? clip.face.fx : ''
  /* 强度跟着已存的值走：换片段时面板不能还停在上一段的值上，
     否则"看上去是 0.8、实际片段里是 0.3" */
  const strength = isVisual && clip.face && Number.isFinite(Number(clip.face.strength))
    ? Number(clip.face.strength)
    : 0.6
  /* 脸占画面宽度的比例：用来给用户一个"这段素材适不适合做人物特效"的判断依据 */
  const faceRatio = track.length ? Math.round(track[0][3] * 100) : 0

  const runDetect = async () => {
    if (!clip || busy || typeof onDetectFace !== 'function') return
    setBusy(true)
    setError('')
    setProgress({ done: 0, total: 1 })
    try {
      const res = await onDetectFace(clip.id, (p) => setProgress(p))
      if (!res || !res.found) {
        setError('这一段里没检测到人脸 —— 换一段正脸、脸不太小的素材再试')
      }
    } catch (err) {
      setError(String((err && err.message) || err || '识别失败'))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const apply = (key) => {
    if (!clip) return
    onPatchClip?.(clip.id, { face: { fx: key, strength: Number(strength.toFixed(2)) } })
  }

  const changeStrength = (next) => {
    if (!clip) return
    const v = Number(next)
    /* 没套效果时只调强度不该往片段上写东西 —— 否则"什么都没套"却留下一个 face 对象，
       导出侧会当真，然后叠一层没有效果的层 */
    if (!applied) return
    onPatchClip?.(clip.id, { face: { fx: applied, strength: Number(v.toFixed(2)) } })
  }

  return (
    <Shell>
      <div className="sticker-head">
        <strong>人物特效</strong>
        <span className="muted" data-face-stat={track.length ? 'ready' : 'idle'}>
          {!clip ? '未选片段' : track.length ? `${track.length} 个人脸位置` : '未识别人脸'}
        </span>
      </div>

      {!isVisual ? (
        <p className="tpl-tip" data-face-empty={clip ? 'wrong-track' : 'no-clip'}>
          {clip
            ? '人物特效只作用于画面片段 —— 先在时间线上选一段视频或图片。'
            : '先在时间线上点一个画面片段，再回这里识别里面的人脸。'}
        </p>
      ) : (
        <>
          <div className="pack-actions">
            <button
              type="button"
              className="btn primary"
              data-face-detect="1"
              disabled={busy}
              onClick={runDetect}
            >
              {busy ? '识别中…' : track.length ? '重新识别' : '识别人脸'}
            </button>
            <button
              type="button"
              className="btn"
              data-face-clear="1"
              disabled={!applied && !track.length}
              onClick={() => onPatchClip?.(clip.id, { face: null, faceTrack: null })}
            >
              清除
            </button>
          </div>

          {progress ? (
            <p className="tpl-tip" data-face-progress={progress.done}>
              正在逐帧识别人脸 {progress.done} / {progress.total}
              {progress.found ? `（已找到 ${progress.found} 帧）` : ''}
            </p>
          ) : null}

          {error ? (
            <p className="tpl-tip is-warn" data-face-error="1">
              {error}
            </p>
          ) : null}

          {track.length ? (
            <p className="tpl-tip">
              识别完成：人脸约占画面宽度 {faceRatio}%。下面选一款效果，它会跟着脸走。
            </p>
          ) : null}

          <div className="pack-sect">
            <span>效果</span>
            <em>跟着人脸走</em>
          </div>
          <div className="pack-grid" data-face-grid="1">
            {FX_LIST.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`pack-card ffx-card${applied === item.key ? ' is-on' : ''}`}
                data-face-fx={item.key}
                title={item.hint}
                disabled={!track.length}
                onClick={() => apply(item.key)}
              >
                <span className={`ffx-art is-${item.key}`} aria-hidden="true" />
                <span className="pack-name">{item.name}</span>
              </button>
            ))}
          </div>

          <div className="pack-sect">
            <span>强度</span>
            <em>{Math.round(strength * 100)}%</em>
          </div>
          <div className="pack-levels" data-face-levels="1">
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={strength}
              data-face-strength="1"
              disabled={!applied}
              onChange={(e) => changeStrength(e.target.value)}
            />
          </div>

          {!track.length ? (
            <p className="tpl-tip" data-face-hint="1">
              先点「识别人脸」—— 识别是一次性的，之后换效果、调强度都不用再等。
            </p>
          ) : null}
        </>
      )}
    </Shell>
  )
}

/* ------------------------------- 转场 ------------------------------- */

/**
 * 参考图卡片组 —— 与「视频增强」用的是**同一套卡片样式**（`.enh-card` / `.enh-art` / `.enh-name`，
 * 那套尺寸是照参考截图实测像素对齐过的：卡 200x122、间隙 15、名字在卡下方 11px），
 * 只是数据源换成 `artSet.js`。**不要另起一套样式**：同一个视觉语言两处实现，
 * 迟早一处改了另一处没改，看起来就是"两个软件的卡片"。
 *
 * `data-refart` / `data-refart-img` 是给 E2E 的钩子：
 *   `data-refart` 证明"这张卡接上了点击"，`data-refart-img` 证明"这张卡下面真有图"。
 * 两者必须同时存在 —— 只断言卡片存在的话，图挂了（img 404 / src 空）也照样全绿。
 */
function RefArtCards({ items, onPick, picked = '', testid = 'refart', size = '', showName = true }) {
  return (
    <div className={`enh-grid${size ? ` is-${size}` : ''}`} data-refart-grid={testid}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`enh-card${size ? ` is-${size}` : ''}${picked === item.key ? ' active' : ''}`}
          data-refart={item.key}
          title={item.hint ? `${item.label}（${item.en}）：${item.hint}` : `${item.label}（${item.en}）`}
          onClick={() => onPick?.(item)}
        >
          <span className="enh-art">
            <img src={item.art} alt="" draggable={false} data-refart-img={item.key} />
          </span>
          {/* ⚠️ 背景族不出名字行（参考 `titleTextVisible: false`），
              这一支必须**条件渲染**而不是 `display:none`：卡片高度是 75，
              藏起来但仍在流里的话 130x75 会被撑成 130x75+名字行高。 */}
          {showName ? <span className="enh-name">{item.label}</span> : null}
        </button>
      ))}
    </div>
  )
}

/**
 * 「一整个族」的参考图面板（图片增强 / 数字人）。
 *
 * 族的数据来自 `artSet.js`，包含 `{ key, label, art, backdrop }`。
 * 点卡片 = 打开对应能力并带上这张预设的名字，与「视频增强」的行为一致。
 */
function RefArtPanel({ familyKey, onSetBackdrop }) {
  const toast = useToast()
  const [picked, setPicked] = useState('')
  const family = ART_FAMILIES.find((item) => item.key === familyKey)

  if (!family) {
    return (
      <Shell kicker="参考配图" title="未找到配图">
        <div className="empty">这一类暂时没有配图。</div>
      </Shell>
    )
  }

  /**
   * 「背景」族与其它族的**落点不同**：它不是"打开某个能力"，而是把图铺到画面后面。
   * 判据看数据本身（`item.backdrop`），不看族名 —— 不写 `familyKey === 'background'`，
   * 否则以后再有第二族是这种语义又要改一处 if。
   */
  const isBackdrop = family.items.some((item) => item.backdrop)

  const pick = (item) => {
    setPicked(item.key)
    if (item.backdrop) {
      onSetBackdrop?.(item)
      toast.good(`已把「${item.label}」铺到预览画面后面`)
      return
    }
    toast.good(`已选择「${item.label}」`)
  }

  return (
    <Shell
      kicker="参考配图"
      title={family.title}
      extra={<span className="pill">{family.items.length} 张</span>}
    >
      <RefArtCards
        items={family.items}
        onPick={pick}
        picked={picked}
        testid={family.key}
        size={family.size || ''}
        showName={!isBackdrop}
      />
    </Shell>
  )
}


/* ------------------------------ 视频增强 ------------------------------ */

/**
 * 「视频增强」预设画廊。
 *
 * 造它的原因：参考客户端点开左栏「视频增强」后，中栏是一屏**带预览图的预设卡片**
 * （左栏 `02c` 截图里第一屏就是小标题 + 两列卡片）；而本项目以前这一项只带 `caps`，
 * 走的是"筛自己的素材"那条路 —— 点进去是一屏空网格，看着像没做完，
 * 正是"构建全绿、只有手指能发现"的另一面：**按钮接对了，但落点不是参考的落点**。
 * 图与名字全部来自参考自己的资源与语言包，两份来源见 enhancePresets.js 顶部注释。
 *
 * 版式逐像素量自 `_evidence/ref-ui/02c-剪辑工作台-1920x1032.png`：
 *   卡片 200x122、两列间隙 15px、行节距 162px、名字在卡片下方 11px 处；
 *   卡片正中间有一条 **1px 白色竖线** —— 实测两张卡最亮列都落在卡的 50%
 *   （亮度 138 / 126，而邻列只有 107 / 77），是参考的"前后对比"分隔线，
 *   不是图片自带的，所以要我们画。
 */
function TransitionPanel({ clips, selectedClip, activeClip, onPatchClip, material }) {
  const toast = useToast()
  /* 与滤镜同一条兜底规则：没有选中就用播放头处那个片段（否则"点了没反应"） */
  const cut = selectedClip || activeClip || null
  const current = cut ? cut.transition || 'none' : 'none'
  const currentDuration = cut?.transitionDuration ?? 0
  const groupIndex = Math.min(parseMaterialGroup(material), TRANSITION_GROUPS.length - 1)
  const matGroup = TRANSITION_GROUPS[groupIndex] || TRANSITION_GROUPS[0]

  const apply = (item) => {
    if (!cut) {
      toast.bad('时间线上还没有片段，转场没有作用对象')
      return
    }
    const def = TRANSITIONS.find((entry) => entry.key === item.css) || { key: 'none', defaultDuration: 0 }
    onPatchClip?.(cut.id, {
      transition: def.key,
      transitionDuration: def.key === 'none' ? 0 : Number(currentDuration) || def.defaultDuration
    })
    toast.good(`已应用「${item.zh}」`)
  }

  const reset = () => {
    if (!cut) return
    onPatchClip?.(cut.id, { transition: 'none', transitionDuration: 0 })
    toast.good('已清除转场')
  }

  const setDuration = (value) => {
    if (!cut) return
    onPatchClip?.(cut.id, { transitionDuration: value })
  }

  const total = resolveTotalDuration(clips)
  const rawTotal = clips.reduce((max, clip) => Math.max(max, Number(clip.start) + Number(clip.duration)), 0)

  return (
    <Shell>
      <MaterialGrid
        items={matGroup.items}
        groupLabel={matGroup.name}
        picked={current === 'none' ? '' : current}
        onPick={apply}
        onReset={current !== 'none' ? reset : null}
        resetLabel="清除转场"
        disabled={!cut}
        dataPrefix="transition"
      />

      {cut && !isNoopTransition(current) ? (
        <>
          <Slider
            label="转场时长"
            suffix=" 秒"
            min={TRANSITION_LIMITS.minDuration}
            max={TRANSITION_LIMITS.maxDuration}
            step={0.1}
            value={Number(currentDuration) || TRANSITIONS.find((item) => item.key === current)?.defaultDuration || 0.6}
            onChange={setDuration}
          />
          <div className="notice" style={{ marginTop: 8 }}>
            <IconWand size={14} />
            <span>
              转场会让成片<b>缩短</b>对应时长：结算后
              <b> {timecode(total, false)}</b>（原 {timecode(rawTotal, false)}）。
            </span>
          </div>
        </>
      ) : null}

      <div className="section-title" style={{ marginTop: 16 }}>
        <span>已设转场</span>
      </div>
      {clips.filter((clip) => !isNoopTransition(clip.transition)).length ? (
        <div className="list">
          {clips
            .filter((clip) => !isNoopTransition(clip.transition))
            .map((clip) => (
              <div className="list-item" key={clip.id}>
                <div className="grow">
                  <strong>
                    {clip.name} → {TRANSITIONS.find((item) => item.key === clip.transition)?.label}
                  </strong>
                  <small>时长 {Number(clip.transitionDuration || 0).toFixed(1)}s</small>
                </div>
                <button className="btn small" type="button" onClick={() => onPatchClip?.(clip.id, { transition: 'none', transitionDuration: 0 })}>
                  清除
                </button>
              </div>
            ))}
        </div>
      ) : (
        <div className="empty">还没有设置转场，两个片段之间默认是硬切。</div>
      )}
    </Shell>
  )
}

/* ------------------------------- 滤镜 ------------------------------- */

/**
 * 滤镜页 —— 参考素材网格（FILTER_GROUPS，14 组 311 条，真图 + 中文名）。
 * 参考素材是 LUT，本地没有 LUT 文件，每条带最接近的 CSS 调色键（css 字段），
 * 点击写进选中片段 —— 预览（cssFilterFor）与导出（main/looks.js）同源，真实生效。
 */
function FilterPanel({ selectedClip, activeClip, onPatchClip, material }) {
  const toast = useToast()
  /* ⚠️ 兜底到**播放头处的片段**，不是只用 selectedClip。
     没有兜底时"没先选中就去点滤镜"只会弹一句"先选中一个片段"，
     用户看到的就是"点了没反应"。参数类面板统一走这一条（与字幕样式同一个判据）。
     注意 activeClip 只在它真的带画面时才该起作用，否则会改到音频/字幕片段上。 */
  const cut = selectedClip || activeClip || null
  const current = cut ? cut.filter || 'none' : 'none'
  const intensity = cut?.filterIntensity ?? 1
  const groupIndex = Math.min(parseMaterialGroup(material), FILTER_GROUPS.length - 1)
  const matGroup = FILTER_GROUPS[groupIndex] || FILTER_GROUPS[0]

  const apply = (item) => {
    if (!cut) {
      toast.bad('时间线上还没有片段，滤镜没有作用对象')
      return
    }
    onPatchClip?.(cut.id, { filter: item.css, filterIntensity: Number(intensity) || 1 })
    toast.good(`已应用「${item.zh}」`)
  }

  const reset = () => {
    if (!cut) return
    onPatchClip?.(cut.id, { filter: 'none' })
    toast.good('已恢复原片')
  }

  return (
    <Shell>
      <MaterialGrid
        items={matGroup.items}
        groupLabel={matGroup.name}
        picked={current === 'none' ? '' : current}
        onPick={apply}
        onReset={current !== 'none' ? reset : null}
        resetLabel="恢复原片"
        disabled={!cut}
        dataPrefix="filter"
      />

      {cut && !isNoopFilter(current) ? (
        <Slider
          label="强度"
          suffix="%"
          min={10}
          max={100}
          step={5}
          value={Math.round(Number(intensity) * 100)}
          onChange={(value) => onPatchClip?.(cut.id, { filterIntensity: value / 100 })}
        />
      ) : null}
    </Shell>
  )
}

/* ------------------------------ 调节 ------------------------------ */

/**
 * 「调节」页 —— 亮度 / 对比度 / 饱和度 / 色温 / 色调 的预设网格。
 *
 * 与「滤镜」的区别必须让用户一眼看出来：滤镜套的是一层风格（looks.js 的调色键），
 * 调节改的是片段自己的五个数值（shared/adjust.js），右栏「调整」页的滑杆就是它们的镜像。
 * 所以这里点一个预设，右栏滑杆会**当场跟着动** —— 两处读的是同一个 `clip.adjust`。
 *
 * 缩略图是**真算出来的**：把这一条的五个参数按 shared/adjust.js 的同一组公式
 * （channelGains / contrastFactor / saturationFactor）作用在一张固定的取景底片上，
 * 与「滤镜」用的是同一张底片、同一套画法 —— 所以两张页签的卡看起来是同一部片子
 * 的不同调法，暖调卡片看着就暖、硬朗卡片看着就硬，点下去画面往同一个方向走。
 */
function AdjustPanel({ selectedClip, activeClip, onPatchClip, material }) {
  const toast = useToast()
  /* 与滤镜/转场/特效同一条兜底规则：没选中就用播放头处那个片段 */
  const cut = selectedClip || activeClip || null
  const current = cut ? readAdjust(cut.adjust) : null
  const groupIndex = Math.min(parseMaterialGroup(material), ADJUST_GROUPS.length - 1)
  const group = ADJUST_GROUPS[groupIndex] || ADJUST_GROUPS[0]

  /** 当前片段的五个参数是否正好等于这条预设（容差 0.5：都是整数档，不需要更细） */
  const isSame = (adjust) =>
    Boolean(current) && ADJUST_PARAMS.every((item) => Math.abs(current[item.key] - (adjust[item.key] || 0)) < 0.5)

  const apply = (item) => {
    if (!cut) {
      toast.bad('时间线上还没有片段，调节没有作用对象')
      return
    }
    onPatchClip?.(cut.id, { adjust: { ...readAdjust(item.adjust) } })
    toast.good(`已应用「${item.zh}」`)
  }

  const reset = () => {
    if (!cut) return
    onPatchClip?.(cut.id, { adjust: { bright: 0, contrast: 0, saturate: 0, temp: 0, tint: 0 } })
    toast.good('已恢复原画面')
  }

  /* 「恢复原画面」只在**真的改过**时出现：参数全 0 时它点了什么都不会变，
     那正是本项目一直在清的那类"看着有、实际没接"的按钮。 */
  const touched = Boolean(current) && ADJUST_PARAMS.some((item) => Math.abs(current[item.key]) > 0.01)

  return (
    <Shell>
      <div className="mat-group-row">
        <span className="mat-group-name">{group.name}</span>
        <span className="grow" />
        {cut && touched ? (
          <button className="btn small" type="button" data-mat-reset="adjust" onClick={reset}>
            恢复原画面
          </button>
        ) : null}
      </div>
      <div className="look-grid" data-adjust-grid="1">
        {group.items.map((item) => {
          const active = isSame(item.adjust)
          return (
            <button
              key={item.zh}
              type="button"
              className={`look-card ${active ? 'active' : ''}`}
              data-adjust-preset={item.zh}
              aria-pressed={active}
              disabled={!cut}
              title={
                cut
                  ? `应用「${item.zh}」：亮度 ${item.adjust.bright} / 对比度 ${item.adjust.contrast} / 饱和度 ${item.adjust.saturate}`
                  : '先在时间线上选一个片段'
              }
              onClick={() => apply(item)}
            >
              <span className="look-preview is-photo">
                {materialThumb(item.thumb) ? (
                  <img src={materialThumb(item.thumb)} alt="" draggable={false} />
                ) : null}
              </span>
              <span className="look-name">{item.zh}</span>
            </button>
          )
        })}
      </div>
      {cut && touched ? (
        <p className="wb-insphint" data-adjust-values="1">
          当前：亮度 {current.bright} · 对比度 {current.contrast} · 饱和度 {current.saturate} · 色温 {current.temp} · 色调{' '}
          {current.tint}
        </p>
      ) : null}
    </Shell>
  )
}

/* ------------------------------ 我的预设 ------------------------------ */

function PresetPanel({ selectedClip, onPatchClip }) {
  const toast = useToast()
  const [saved, setSaved] = useState(() => readPresets())
  const [name, setName] = useState('')

  // 存的是「滤镜 + 强度 + 转场 + 时长」这一组，而不是单个属性 ——
  // 调色和过渡通常是一套一起用的，分开存反而要多点几次
  const save = useCallback(() => {
    if (!selectedClip) {
      toast.bad('先选中一个片段，预设会记录它当前的滤镜与转场')
      return
    }
    const label = name.trim() || `预设 ${saved.length + 1}`
    const entry = {
      key: `preset_${Date.now().toString(36)}`,
      label,
      filter: selectedClip.filter || 'none',
      filterIntensity: Number(selectedClip.filterIntensity ?? 1),
      transition: selectedClip.transition || 'none',
      transitionDuration: Number(selectedClip.transitionDuration || 0)
    }
    const next = [entry, ...saved]
    setSaved(next)
    writePresets(next)
    setName('')
    toast.good(`已保存「${label}」`)
  }, [name, saved, selectedClip, toast])

  const apply = (entry) => {
    if (!selectedClip) {
      toast.bad('先选中一个片段')
      return
    }
    onPatchClip?.(selectedClip.id, {
      filter: entry.filter,
      filterIntensity: entry.filterIntensity,
      transition: entry.transition,
      transitionDuration: entry.transitionDuration
    })
    toast.good(`已套用「${entry.label}」`)
  }

  const remove = (key) => {
    const next = saved.filter((item) => item.key !== key)
    setSaved(next)
    writePresets(next)
  }

  return (
    <Shell kicker="PRESETS" title="我的预设" extra={<span className="pill">{saved.length} 套</span>}>
      <div className="row" style={{ gap: 8 }}>
        <input className="input" style={{ flex: 1 }} value={name} placeholder="预设名称（可留空）" onChange={(event) => setName(event.target.value)} />
        <button className="btn small primary" type="button" onClick={save} disabled={!selectedClip}>
          <IconAddSquare size={14} />
          保存
        </button>
      </div>

      {!saved.length ? (
        <div className="empty" style={{ marginTop: 12 }}>
          还没有预设。选中一个片段、调好滤镜或转场，再回到这里保存。
        </div>
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {saved.map((entry) => (
            <div className="list-item" key={entry.key}>
              <div className="grow">
                <strong>{entry.label}</strong>
                <small>
                  {FILTERS.find((item) => item.key === entry.filter)?.label || entry.filter} · 强度{' '}
                  {Math.round(entry.filterIntensity * 100)}% ·{' '}
                  {TRANSITIONS.find((item) => item.key === entry.transition)?.label || entry.transition}
                </small>
              </div>
              <button className="btn small" type="button" onClick={() => apply(entry)}>
                套用
              </button>
              <button className="btn small" type="button" onClick={() => remove(entry.key)} aria-label="删除预设">
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  )
}

/* ------------------------------ 智能剪辑 ------------------------------ */

function SmartPanel({ clips, onSplitEvenly, onCloseGaps, onClearTextTrack }) {
  const videoCount = clips.filter((clip) => clip.track === 'video').length
  const textCount = clips.filter((clip) => clip.track === 'text').length
  const audioCount = clips.filter((clip) => clip.track === 'audio').length

  return (
    <Shell kicker="SMART EDIT" title="智能剪辑" extra={<span className="pill">{clips.length} 个片段</span>}>
      <div className="kv-list" style={{ marginBottom: 14 }}>
        <div>
          <span>视频轨</span>
          <strong>{videoCount} 段</strong>
        </div>
        <div>
          <span>字幕轨</span>
          <strong>{textCount} 段</strong>
        </div>
        <div>
          <span>音频轨</span>
          <strong>{audioCount} 段</strong>
        </div>
      </div>

      <div className="section-title">
        <span>时间线整理</span>
      </div>
      <div className="list">
        <div className="list-item">
          <div className="grow">
            <strong>平均分段</strong>
            <small>把视频轨第一段按当前时长平均切成 4 段，用于快速铺节奏</small>
          </div>
          <button className="btn small" type="button" onClick={() => onSplitEvenly?.(4)} disabled={!videoCount}>
            执行
          </button>
        </div>
        <div className="list-item">
          <div className="grow">
            <strong>消除空档</strong>
            <small>把所有片段推到紧挨着，去掉片段之间的黑场</small>
          </div>
          <button className="btn small" type="button" onClick={onCloseGaps} disabled={clips.length < 2}>
            执行
          </button>
        </div>
        <div className="list-item">
          <div className="grow">
            <strong>清空字幕轨</strong>
            <small>只删字幕，保留视频与音频</small>
          </div>
          <button className="btn small" type="button" onClick={onClearTextTrack} disabled={!textCount}>
            执行
          </button>
        </div>
      </div>
    </Shell>
  )
}

/* ------------------------------- 录制 ------------------------------- */

/**
 * 「录制」面板 —— 屏幕 / 摄像头，真采、真落盘、真落片段。
 *
 * 权限这一关是本面板最要紧的设计：主进程的权限闸**只认一次性票据**
 * （见 main/index.js 的 recordGrant）。票据由本面板在用户点过下面的确认框之后，
 * 才通过 `recorder.grant` 换到。所以顺序不能倒 —— 先确认、再换票、最后建流。
 * 没有票据时 getUserMedia / getDisplayMedia 会被拒（与"全拒"一模一样），
 * 这也正是负对照要钉住的东西。
 *
 * 三处静默失效，各自都有对应处理：
 *   ① 录到了但没落盘 → 时间线上一个 0 秒片段；保存失败必须报出来，不能只关面板；
 *   ② 落了盘没进 `yjai-media://` 白名单 → 卡片画得好好的、播放全黑（主进程负责登记）；
 *   ③ 系统声音与麦克风各挂一条音轨 → MediaRecorder 只录第一条
 *      ⇒ 两条都要时必须在 AudioContext 里混成一条。
 */
const RECORD_MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']

function recordConfirmText(mode) {
  return mode === 'camera'
    ? {
        title: '允许使用摄像头？',
        body: '接下来会打开摄像头并开始录制。录到的画面只保存在本机，不会上传到任何地方。'
      }
    : {
        title: '允许录制屏幕？',
        body: '接下来会录下你选中的屏幕或窗口。录到的画面只保存在本机，不会上传到任何地方。'
      }
}
function RecordPanel({ onImport, onRecorded }) {
  const bridge = isDesktop && typeof window !== 'undefined' ? window.yjai : null
  /* 录什么 */
  const [mode, setMode] = useState('screen')
  /* idle → asking（应用内确认）→ starting → recording → saving → idle */
  const [phase, setPhase] = useState('idle')
  const [sources, setSources] = useState([])
  const [sourceId, setSourceId] = useState('')
  const [sourcesErr, setSourcesErr] = useState('')
  const [loadingSources, setLoadingSources] = useState(false)
  const [cams, setCams] = useState([])
  const [camId, setCamId] = useState('')
  const [withMic, setWithMic] = useState(true)
  const [withSysAudio, setWithSysAudio] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')

  const previewRef = useRef(null)
  const streamRef = useRef(null)
  const audioCtxRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(0)
  const startAtRef = useRef(0)
  /* 视频轨 ended（用户从系统层面点了"停止共享"）时要收尾，而 stop 定义在 effect 之后 —— 用 ref 接 */
  const stopRef = useRef(() => {})

  const recording = phase === 'recording'
  const locked = phase === 'starting' || phase === 'saving' || recording
  const confirm = phase === 'asking' ? recordConfirmText(mode) : null

  /** 放掉流 / 定时器 / 音频上下文。轨道不 stop 的话，摄像头指示灯会一直亮着 */
  const release = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = 0
    }
    const stream = streamRef.current
    streamRef.current = null
    if (previewRef.current) {
      try {
        previewRef.current.srcObject = null
      } catch {
        /* 已经卸载 */
      }
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          /* 已经停了 */
        }
      }
    }
    const ctx = audioCtxRef.current
    audioCtxRef.current = null
    if (ctx && typeof ctx.close === 'function') Promise.resolve(ctx.close()).catch(() => {})
    setElapsed(0)
  }, [])

  const loadSources = useCallback(async () => {
    if (!bridge?.recorder?.sources) {
      setSourcesErr('录制需要在桌面客户端里使用')
      return
    }
    setLoadingSources(true)
    setSourcesErr('')
    try {
      const result = await bridge.recorder.sources()
      if (!result || !result.ok) {
        setSourcesErr((result && result.error) || '列不出可录的画面')
        setSources([])
        return
      }
      const list = Array.isArray(result.sources) ? result.sources : []
      setSources(list)
      setSourceId((current) => (current && list.some((item) => item.id === current) ? current : list[0] ? list[0].id : ''))
    } catch (err) {
      setSourcesErr(`列不出可录的画面：${(err && err.message) || '未知原因'}`)
      setSources([])
    } finally {
      setLoadingSources(false)
    }
  }, [bridge])

  /* 切到屏幕模式就刷一次源（窗口列表随时在变，缓存下来会录到已经关掉的窗口） */
  useEffect(() => {
    if (mode !== 'screen') return
    loadSources()
  }, [mode, loadSources])

  /* 摄像头设备。未授权前 label 是空的 —— 给"摄像头 1/2…"，不给一串空白选项 */
  useEffect(() => {
    if (mode !== 'camera' || typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return undefined
    let alive = true
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        if (!alive) return
        const inputs = list
          .filter((item) => item.kind === 'videoinput')
          .map((item, index) => ({ id: item.deviceId, label: item.label || `摄像头 ${index + 1}` }))
        setCams(inputs)
        setCamId((current) => current || (inputs[0] ? inputs[0].id : ''))
      })
      .catch(() => {
        if (alive) setCams([])
      })
    return () => {
      alive = false
    }
  }, [mode])

  /* 卸载 / 切走页签：停录、放流、作废票据。切页签会卸载本面板，
     不清理就会留下一个还在录的 MediaRecorder（用户看不到任何界面） */
  useEffect(
    () => () => {
      const rec = recorderRef.current
      recorderRef.current = null
      if (rec) {
        rec.onstop = null
        rec.ondataavailable = null
        if (rec.state !== 'inactive') {
          try {
            rec.stop()
          } catch {
            /* 已经停了 */
          }
        }
      }
      release()
      if (bridge?.recorder?.cancelGrant) bridge.recorder.cancelGrant()
    },
    [bridge, release]
  )

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    /* 时长取墙钟：MediaRecorder 产的 webm 头里没有 duration，读 blob 拿到的是 Infinity */
    const duration = Math.max(0, (performance.now() - startAtRef.current) / 1000)
    setPhase('saving')
    recorder.onstop = async () => {
      const chunks = chunksRef.current
      chunksRef.current = []
      recorderRef.current = null
      release()
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
      if (!blob.size) {
        setError('没有录到内容：确认录制没有被系统中断')
        setPhase('idle')
        return
      }
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const result = await bridge.recorder.save({ bytes, mime: blob.type, duration, kind: 'video' })
        if (!result || !result.ok) {
          setError((result && result.error) || '保存失败')
          setPhase('idle')
          return
        }
        /* 交给 App：素材入库 + 视频轨在**播放头**处插一段（录屏是"配着这段画面录的"） */
        if (onRecorded) onRecorded(result.asset, duration)
        setPhase('idle')
      } catch (err) {
        setError(`保存失败：${(err && err.message) || '未知原因'}`)
        setPhase('idle')
      }
    }
    try {
      recorder.stop()
    } catch (err) {
      setError(`停止录制失败：${(err && err.message) || '未知原因'}`)
      release()
      setPhase('idle')
    }
  }, [bridge, onRecorded, release])
  stopRef.current = stop

  /* 用户从系统的「停止共享」结束屏幕共享时，视频轨会 ended ——
     界面必须跟着收尾，否则看着还在录、文件里其实只剩前一秒 */
  useEffect(() => {
    if (!recording) return undefined
    const track = streamRef.current && streamRef.current.getVideoTracks()[0]
    if (!track) return undefined
    const onEnded = () => stopRef.current()
    track.addEventListener('ended', onEnded)
    return () => track.removeEventListener('ended', onEnded)
  }, [recording])

  /** 把麦克风并进视频流。两条音轨都挂上去时 MediaRecorder 只录第一条，必须先混一条 */
  const attachAudio = useCallback(async (videoStream, micStream) => {
    const sysTracks = videoStream.getAudioTracks()
    const micTrack = micStream && micStream.getAudioTracks()[0]
    if (!sysTracks.length) {
      if (micTrack) videoStream.addTrack(micTrack)
      return
    }
    if (!micTrack) return
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    audioCtxRef.current = ctx
    const dest = ctx.createMediaStreamDestination()
    ctx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest)
    ctx.createMediaStreamSource(micStream).connect(dest)
    /* 先接上混音节点再从流里摘掉：直接 stop 原轨会把混音一起弄断 */
    for (const track of sysTracks) {
      try {
        videoStream.removeTrack(track)
      } catch {
        /* 已经不在流里 */
      }
    }
    const mixed = dest.stream.getAudioTracks()[0]
    if (mixed) videoStream.addTrack(mixed)
  }, [])

  /** 用户点过「允许并开始」之后才走这里：换票 → 建流 → 开录 */
  const beginRecording = useCallback(async () => {
    if (!bridge?.recorder?.grant) {
      setError('录制需要在桌面客户端里使用')
      setPhase('idle')
      return
    }
    setError('')
    setPhase('starting')
    try {
      let stream = null
      if (mode === 'screen') {
        if (!sourceId) throw new Error('先选一个要录的屏幕或窗口')
        const granted = await bridge.recorder.grant({ scope: 'screen', sourceId, withAudio: withSysAudio })
        if (!granted || !granted.ok) throw new Error((granted && granted.error) || '没有被授权录制屏幕')
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: withSysAudio })
        } catch (err) {
          if (!withSysAudio) throw err
          /* 系统声音不可用（驱动/平台不支持 loopback）会把整条请求一起失败：
             降级成"只录画面"重试一次，并把原因说出来，而不是整个录制不可用 */
          stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
          setError('这个环境拿不到系统声音，已改为只录画面')
        }
      } else {
        const granted = await bridge.recorder.grant({ scope: 'camera' })
        if (!granted || !granted.ok) throw new Error((granted && granted.error) || '没有被授权使用摄像头')
        stream = await navigator.mediaDevices.getUserMedia({
          video: camId ? { deviceId: { exact: camId } } : true,
          audio: withMic
        })
      }

      if (mode === 'screen' && withMic) {
        let mic = null
        try {
          mic = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch {
          mic = null
        }
        if (mic) {
          await attachAudio(stream, mic)
        } else {
          setError(withSysAudio ? '麦克风没拿到，只录了系统声音' : '麦克风没拿到，只录了画面')
        }
      }

      streamRef.current = stream
      if (previewRef.current) {
        previewRef.current.srcObject = stream
        try {
          previewRef.current.muted = true
        } catch {
          /* 有些内核对 muted 属性写入有限制，忽略即可 */
        }
      }

      const mimeType = RECORD_MIMES.find((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunksRef.current.push(event.data)
      }
      recorder.onerror = (event) => {
        setError(`录制出错：${(event && event.error && event.error.message) || '未知原因'}`)
        release()
        setPhase('idle')
      }
      recorderRef.current = recorder
      recorder.start(500)
      startAtRef.current = performance.now()
      setElapsed(0)
      setPhase('recording')
      timerRef.current = setInterval(() => {
        setElapsed(Math.max(0, (performance.now() - startAtRef.current) / 1000))
      }, 100)
    } catch (err) {
      release()
      setPhase('idle')
      if (bridge?.recorder?.cancelGrant) bridge.recorder.cancelGrant()
      const name = String((err && err.name) || '')
      setError(
        name === 'NotAllowedError'
          ? '没有拿到录制权限：请点「开始录制」，在确认框里选「允许并开始」再试一次'
          : name === 'NotFoundError'
            ? mode === 'screen'
              ? '没有可录的画面：换一个源再试'
              : '没有找到可用的摄像头'
            : `录制打不开：${(err && err.message) || name || '未知原因'}`
      )
    }
  }, [attachAudio, bridge, camId, mode, release, sourceId, withMic, withSysAudio])

  const cancelAsk = useCallback(() => {
    setPhase('idle')
    if (bridge?.recorder?.cancelGrant) bridge.recorder.cancelGrant()
  }, [bridge])

  return (
    <Shell kicker="RECORD" title="录制">
      <div className="wb-record-modes">
        <button
          type="button"
          className={`wb-record-mode${mode === 'screen' ? ' on' : ''}`}
          data-rec-mode="screen"
          disabled={locked}
          onClick={() => setMode('screen')}
        >
          录制屏幕
        </button>
        <button
          type="button"
          className={`wb-record-mode${mode === 'camera' ? ' on' : ''}`}
          data-rec-mode="camera"
          disabled={locked}
          onClick={() => setMode('camera')}
        >
          录制摄像头
        </button>
      </div>

      {mode === 'screen' ? (
        <div className="wb-record-sources" data-rec-source-list="1">
          {loadingSources ? <p className="wb-record-hint">正在列出可录的画面…</p> : null}
          {sourcesErr ? (
            <div className="notice warn" style={{ marginBottom: 8 }}>
              <IconAlert size={14} />
              <span>{sourcesErr}</span>
              <button type="button" className="btn small" onClick={loadSources} disabled={locked || loadingSources}>
                重试
              </button>
            </div>
          ) : null}
          <div className="wb-record-grid">
            {sources.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`wb-record-src${sourceId === item.id ? ' on' : ''}`}
                data-rec-source={item.id}
                data-rec-src-kind={item.kind}
                disabled={locked}
                onClick={() => setSourceId(item.id)}
              >
                <span className="wb-record-src-thumb">
                  {item.thumbnail ? <img src={item.thumbnail} alt="" /> : null}
                </span>
                <span className="wb-record-src-name" title={item.name}>
                  {item.name}
                </span>
              </button>
            ))}
          </div>
          {!loadingSources && !sourcesErr && !sources.length ? (
            <p className="wb-record-hint">没有列出可录的画面，点「重试」再试一次。</p>
          ) : null}
        </div>
      ) : (
        <div className="field" style={{ marginBottom: 10 }}>
          <span>摄像头</span>
          <select
            className="select"
            data-rec-cam="1"
            value={camId}
            disabled={locked}
            onChange={(event) => setCamId(event.target.value)}
          >
            {cams.length ? (
              cams.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))
            ) : (
              <option value="">默认摄像头</option>
            )}
          </select>
        </div>
      )}

      <div className="wb-record-toggles">
        <label className="wb-record-toggle">
          <input
            type="checkbox"
            data-rec-mic="1"
            checked={withMic}
            disabled={locked}
            onChange={(event) => setWithMic(event.target.checked)}
          />
          <span>录制麦克风</span>
        </label>
        {mode === 'screen' ? (
          <label className="wb-record-toggle">
            <input
              type="checkbox"
              data-rec-sysaudio="1"
              checked={withSysAudio}
              disabled={locked}
              onChange={(event) => setWithSysAudio(event.target.checked)}
            />
            <span>同时录系统声音</span>
          </label>
        ) : null}
      </div>

      {/* 预览与计时：录的时候必须看得见画面和"已经录了多久" */}
      <div className={`wb-record-monitor${locked ? ' live' : ''}`} data-rec-monitor={locked ? 'on' : 'off'}>
        <video ref={previewRef} className="wb-record-preview" data-rec-preview="1" muted playsInline autoPlay />
        {locked ? (
          <div className="wb-record-status">
            {recording ? (
              <span className="wb-record-live" data-rec-live="1">
                <i aria-hidden="true" />
                录制中
              </span>
            ) : null}
            <span className="wb-rec-time" data-rec-timer={Number(elapsed.toFixed(2))}>
              {timecode(elapsed, false)}
            </span>
          </div>
        ) : (
          <span className="wb-record-idle">预览会在这里出现</span>
        )}
      </div>

      {/* 应用内确认：系统的权限请求在 Electron 里只回 true/false，用户看不到"在问什么"。
          这一步就是那个"问"的地方 —— 只有点了「允许并开始」才会去换票据。 */}
      {confirm ? (
        <div className="wb-record-confirm" data-rec-confirm="1">
          <strong>{confirm.title}</strong>
          <p>{confirm.body}</p>
          <div className="wb-record-confirm-actions">
            <button type="button" className="btn small" data-rec-deny="1" onClick={cancelAsk}>
              暂不录制
            </button>
            <button type="button" className="btn small" data-rec-allow="1" onClick={beginRecording}>
              允许并开始
            </button>
          </div>
        </div>
      ) : (
        <div className="wb-rec-actions">
          {recording ? (
            <button type="button" className="btn" data-rec-btn="stop" onClick={stop}>
              停止录制
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              data-rec-btn="start"
              disabled={phase === 'saving' || phase === 'starting'}
              onClick={() => {
                setError('')
                setPhase('asking')
              }}
            >
              {phase === 'saving' ? '正在保存…' : phase === 'starting' ? '正在开始…' : '开始录制'}
            </button>
          )}
        </div>
      )}

      {error ? (
        <p className="wb-insphint" data-rec-error="1" style={{ color: 'var(--warn, #e8b04b)' }}>
          {error}
        </p>
      ) : (
        <p className="wb-insphint" data-rec-hint="1">
          录完会进素材库，并作为视频片段落在播放头处。录制期间请保持这个窗口打开。
        </p>
      )}

      <div className="list" style={{ marginTop: 10 }}>
        <div className="list-item">
          <div className="grow">
            <strong>导入已有的录像</strong>
            <small>用系统录屏或手机拍的素材，也可以直接拖进窗口</small>
          </div>
          <button className="btn small" type="button" disabled={locked} onClick={onImport}>
            <IconPlus size={14} />
            导入
          </button>
        </div>
      </div>
    </Shell>
  )
}

/* ------------------------------- 导出 ------------------------------- */

function ExportPanel({
  clips,
  projectName,
  backdrop = null,
  aspect = DEFAULT_ASPECT,
  /* 分辨率档是**草稿属性**（App 持有并落进草稿），面板只是它的编辑入口。
     只存在面板的 useState 里时：关掉面板再打开就回 1080p，用户以为一直选着 4K，
     而每次导出都在出 1080p —— 面板与成片都不报错，只能逐帧量像素才发现。 */
  resolution: resolutionProp,
  onResolution,
  range = null,
  playhead = 0
}) {
  const toast = useToast()
  /* 兜底副本：只在父层没传时用（单独渲染面板的测试夹具）。真机上永远是受控的 */
  const [resolutionLocal, setResolutionLocal] = useState(EXPORT_RATE.DEFAULT_RESOLUTION)
  const resolution = resolutionProp === undefined ? resolutionLocal : resolutionProp
  const setResolution = onResolution || setResolutionLocal
  /* 帧率存的是**数值**（29.97 就是 29.97，不是 30）：封面取帧按它算帧对齐 */
  const [fps, setFps] = useState(EXPORT_RATE.readRate(EXPORT_RATE.DEFAULT_RATE).fps)
  const [quality, setQuality] = useState(80)
  /* 编码与码率：默认软编 + 画质优先，与改动前逐字一致（不改变既有的导出证据） */
  const [encoder, setEncoder] = useState('libx264')
  /* 编码格式（容器 / 色深 / 是否带 Alpha）。默认 H.264 —— 与旧版导出行为逐字一致，
     不去猜用户要不要 10bit 或 ProRes。 */
  const [codec, setCodec] = useState(EXPORT_CODEC.DEFAULT_KEY)
  const [bitrateMode, setBitrateMode] = useState('quality')
  const [bitrate, setBitrate] = useState(8000)
  /* 响度统一：默认不处理 */
  const [loudness, setLoudness] = useState('off')
  const [ffmpeg, setFfmpeg] = useState(null)
  const [outPath, setOutPath] = useState('')
  const [ratio, setRatio] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  /* 封面图：默认**关**。多导出一张图是附加产物，默认生成会让人以为哪里冒出了多余文件 */
  const [coverOn, setCoverOn] = useState(false)
  /**
   * 面板分两屏。
   *
   * ⚠️ 2026-11-02 Jason：「导出弹窗显示内容太多太乱了优化一下」。
   *   改前是一列平铺 11 个控件 + 7 行键值表 + 3 段说明，首屏根本看不到「导出成片」——
   *   而那是这个面板唯一的目的。现在：
   *     · 顶部一行摘要（时长 / 尺寸 / 帧率 / 容器 / 段数 / 区间）替掉那两张键值表；
   *     · 「基本」只留每次都可能改的：分辨率 · 帧率 · 画质 · 输出范围；
   *     · 「高级」放定好就不动的：编码格式 · 视频编码 · 码率控制 · 响度 · 封面图。
   *   两屏是**同一份状态**（切来切去不会丢设置），不是两个表单。
   */
  const [seg, setSeg] = useState('basic')

  /** 成片时长必须走与渲染同一份结算：转场会让成片变短，直接累加 start+duration 会虚高 */
  const duration = resolveTotalDuration(clips)
  /**
   * 「只导出时间区域」。
   *
   * 默认**开着**：用户是从时间线的「只导出」按钮进来的，他要的就是这一段；
   * 但开关必须摆在明面上 —— 默认行为如果是"偷偷只导一部分"，
   * 用户下次从「导出」菜单进来会以为成片缺了一大截。
   *
   * ⚠️ 区间是**片段层**裁剪（主进程 region.trimToRegion），不是给 ffmpeg 加 -ss/-to：
   *    输出侧裁时间会让画中画 / 转场 / 音量包络的时间表达式全部错位，
   *    而它们都是按原时间线算的。
   */
  const [onlyRange, setOnlyRange] = useState(Boolean(range && Number(range.end) > Number(range.start)))
  const activeRange =
    onlyRange && range && Number(range.end) > Number(range.start)
      ? { start: Number(range.start), end: Number(range.end) }
      : null
  /** 只导出区间时的成片时长（区间可能比内容更长，按内容截断，不虚报） */
  const outDuration = activeRange
    ? Math.max(0, Math.min(activeRange.end, duration) - Math.min(activeRange.start, duration))
    : duration
  const rawDuration = clips.reduce((max, item) => Math.max(max, item.start + item.duration), 0)
  const savedByTransitions = Number((rawDuration - duration).toFixed(3))

  /**
   * 封面取帧位置（成片内秒数）。
   *
   * ⚠️ 必须减掉区间起点：播放头停在第 6 秒、而用户选的是「只导出 5–8 秒」，
   *    成片里第 6 秒对应的是第 1 秒 —— 不减的话封面会抽在成片第 6 秒（片尾附近），
   *    与用户盯着的那一帧对不上，而且成片本身完全正常。
   * ⚠️ 夹取与帧对齐都走 shared/cover.js（主进程用的是同一份），
   *    否则"面板写第 3 秒、抽到第 3.03 秒"，逐帧核对时像是错了一帧。
   */
  const coverAt = coverTimeAt(
    Math.max(0, Number(playhead) || 0) - (activeRange ? activeRange.start : 0),
    outDuration,
    fps
  )

  const bridge = isDesktop && typeof window !== 'undefined' ? window.yjai : null

  /** 成片尺寸（基准分辨率裁出当前比例）。面板上要显示，startRender 也要用，算一次。 */
  const resSpec = EXPORT_RATE.readResolution(resolution)
  const sizeOut = outputSizeFor(resSpec.width, resSpec.height, aspect)

  /**
   * 可选编码器 = 主进程 probe 出来的那几个。
   * 探测还没回来（ffmpeg === null）时只给 libx264 —— 软编永远可用，先摆一个能用的，
   * 不摆一个"待定"的空下拉。硬件编码回来了再自动多出选项。
   */
  const availableEncoders =
    ffmpeg && Array.isArray(ffmpeg.encoders) && ffmpeg.encoders.length ? ffmpeg.encoders : ['libx264']

  /**
   * 编码格式 → 本机可用的编码器。
   *
   * ⚠️ 候选必须按**编码族**过滤：H.265 的下拉里混进 h264_nvenc，
   *    选下去 ffmpeg 会以 "Unknown encoder" 失败；而如果主进程悄悄回落到同族软件编码，
   *    面板上写的与实际用的又不是同一个东西。
   */
  const codecInfo = EXPORT_CODEC.readCodec(codec)
  const codecEncoders = EXPORT_CODEC.encodersFor(codecInfo.key, availableEncoders)
  /** 面板显示与实际下发**必须是同一个值**：切了编码格式后旧编码器多半已不在候选里 */
  const activeEncoder = codecEncoders.includes(encoder) ? encoder : codecEncoders[0]

  // 打开面板就探一次 ffmpeg，让用户先知道本机能不能渲
  useEffect(() => {
    if (!bridge?.render) return undefined
    let alive = true
    bridge.render
      .probe()
      .then((info) => {
        if (alive) setFfmpeg(info)
      })
      .catch((error) => {
        if (alive) setFfmpeg({ available: false, reason: 'error', detail: error.message })
      })
    return () => {
      alive = false
    }
  }, [bridge])

  // 订阅主进程推回来的渲染进度
  useEffect(() => {
    if (!bridge?.render?.onProgress) return undefined
    return bridge.render.onProgress(({ ratio: value }) => setRatio(value || 0))
  }, [bridge])

  const pickOutput = useCallback(async () => {
    if (!bridge?.render) {
      toast.bad('导出需要在桌面客户端里运行')
      return ''
    }
    /**
     * 扩展名由编码格式决定：选 ProRes 4444 时对话框只能存 .mov。
     * 这里也把返回值再规范一次 —— 对话框的过滤器是建议性的，
     * 用户手打 `xxx.mp4` 照样能确定，那一步之后就只会在 ffmpeg 里失败。
     */
    const picked = await bridge.render.pickOutput(`${projectName || '艺镜AI'}-成片.mp4`, codecInfo.key)
    if (picked) setOutPath(EXPORT_CODEC.matchExtension(picked, codecInfo.key))
    return picked
  }, [bridge, codecInfo.key, projectName, toast])

  const startRender = useCallback(async () => {
    if (!clips.length) return
    setFailure('')
    const target = EXPORT_CODEC.matchExtension(outPath || (await pickOutput()), codecInfo.key)
    if (!target) return
    setBusy(true)
    setRatio(0)
    try {
      /**
       * 成片尺寸 `sizeOut` = 基准分辨率里**裁出**当前比例的最大内接矩形（已在上面算好）。
       *
       * ⚠️ 裁而不是"照基准输出 + 事后 crop"：ffmpeg 那条链里每一处 scale/pad
       *    都按 width/height 算，事后 crop 会让"片段缩放""画中画定位"全错一档。
       *    尺寸本身就是裁好的，链上所有环节自然跟着对。
       * ⚠️ 与预览同口径（预览是 object-fit: cover），否则"预览裁了、成片留黑边"。
       * ⚠️ `aspect` 也要一起发过去：主进程拿它做兜底（调用方只给基准分辨率时
       *    也能裁对），少发就会出现"预览切了比例、成片没跟上"。
       */
      const result = await bridge.render.start({
        outPath: target,
        /* range：只导出时间区域时给主进程（片段层裁剪）。null = 整条时间线。
           少带它 = 面板上选了"只导出区域"、成片还是整条 —— 而且时长与内容都不报错。 */
        options: { width: sizeOut.width, height: sizeOut.height, fps, quality, aspect,
          /* codec 决定容器 / 色深 / 是否留 Alpha；encoder 是它族内具体那一个。
             少发 codec = 面板上选了 ProRes 4444、成片还是 H.264 的 MP4。 */
          codec: codecInfo.key, encoder: activeEncoder, bitrateMode, bitrate, loudness, range: activeRange,
          /* 封面图。少带它 = 面板上开了「导出封面图」、成片旁边却什么都没有，
             而导出照旧报成功。`at` 是**成片内**秒数（已减区间起点、已按帧对齐）。 */
          cover: coverOn ? { enabled: true, at: coverAt } : null },
        /* 背景（素材 → 背景选的那张图）也要进成片，否则"选了背景"只影响预览。 */
        backdrop: backdrop || '',
        // 片段里带 path 的用磁盘路径，生成类素材是 http 链接，ffmpeg 都能直接吃。
        // filter / frameFx / transition 也必须带上 —— 渲染层算的是预览，
        // 导出要按同一组字段落地。
        //
        // ⚠️ frameFx 这一项以前**漏了**：render.js 的 buildPlan 早就读 clip.frameFx，
        //    但这里从来没发过去，于是画面特效在成片里一律退成 'none' ——
        //    界面上加了特效、预览里看得到、导出出来却没有，而导出流程一句错都不报。
        //    「导出载荷字段契约」这道闸（tools/check-export-contract.mjs）就是钉这一类的。
        clips: clips.map((clip) => ({
          id: clip.id,
          track: clip.track,
          kind: clip.kind,
          start: clip.start,
          duration: clip.duration,
          offset: clip.offset || 0,
          path: clip.path || '',
          url: clip.url || '',
          filter: clip.filter || 'none',
          filterIntensity: clip.filterIntensity ?? 1,
          frameFx: clip.frameFx || 'none',
          transition: clip.transition || 'none',
          transitionDuration: clip.transitionDuration || 0,
          /* 属性面板那三个滑杆的值：以前只活在面板里，导出一份也拿不到，
             于是"调了不透明度 / 缩放 / 音量，成片里完全没变"。
             画中画的 pip 同理 —— 少带它，成片里的画中画会跑到默认位置。 */
          opacity: clip.opacity ?? 100,
          scale: clip.scale ?? 100,
          gain: clip.gain ?? 100,
          /* 倍速。少了它，成片里所有片段都按原速渲染 ——
             "调了 2 倍速，成片一点没变"，而导出流程一句错都不报。 */
          speed: clip.speed ?? 1,
          /* 曲线变速（点列）+ 音高两项。⚠️ 少带 speedCurve 的后果特别隐蔽：
             预览按曲线播、成片按 clip.speed 那一个均值匀速播，两边都不报错，
             只有把两段视频摆在一起比才看得出"成片没变速"。 */
          speedCurve: clip.speedCurve || null,
          keepPitch: clip.keepPitch !== false,
          pitch: clip.pitch ?? 0,
          pip: clip.pip || null,
          /* 「画面 · 位置/旋转」（检查器）。少了这三项，成片里的画面永远居中不转 ——
             "预览里挪过、成片里没动"，而导出照旧不报错。 */
          posX: clip.posX ?? 0,
          posY: clip.posY ?? 0,
          rotate: clip.rotate ?? 0,
          /* 「调整 / 美颜」（检查器）。真源换算在 shared/adjust.js，两侧共用；
             载荷里少带就是"面板上调了、成片里没有"。 */
          adjust: clip.adjust || null,
          beauty: clip.beauty || null,
          /* 「曲线」（RGB 三通道）：导出侧拼 ffmpeg 的 curves，查找表与预览共用
             shared/curves.js。少带这一个字段 = 面板上画了 S 形、预览也变了、
             成片还是原样 —— 界面上完全看不出来（正是这道契约闸门要挡的那类）。 */
          /* 「一级色轮」：同上，导出侧拼 lutrgb，表达式与预览的查找表同一份换算 */
          wheels: clip.wheels || null,
          curves: clip.curves || null,
          /* 「分区 HSL」（八色带）：导出侧把参数烘成 `.cube` 交给 ffmpeg 的 lut3d，
             烘焙函数与预览的 WebGL 3D 纹理是 shared/hslBands.js 的同一份。
             ⚠️ 少带这一个字段时预览完全正常（它走的是自己的 WebGL 层），
                成片里八条色带一起失效 —— 正是这道契约闸门存在的原因。 */
          hsl: clip.hsl || null,
          /* 「效果」（圆角 / 蒙版 / 抠像 / 混合 / 变形 / 描边 / 阴影）。
             真源换算在 shared/effects.js，两侧共用；载荷里少带就是
             "面板上调了圆角、预览里圆了、成片还是方的"。 */
          effects: clip.effects || null,
          /* 「边框」（内置边框库的一个 key）。少带这一项 = 面板上点了、预览里也有，
             成片还是光板 —— 与 frameFx / hsl 那两条同一个成因，所以它也归这道契约闸管。 */
          border: clip.border || '',
          /* 自由裁剪框（框外裁掉、框内铺满）。换算在 shared/crop.js，与预览的 transform 同源；
             载荷里少带一项就是"面板上框好了、成片还是整幅"。 */
          crop: clip.crop || null,
          /* 音量包络（关键帧）。导出侧拼成 ffmpeg 的 volume 表达式；
             少带它 = 预览里听得到渐弱、成片里从头到尾一个音量。 */
          volumeKf: clip.volumeKf || null,
          /* 修复类三件（**导出阶段**生效，界面上标了「导出时应用」）：
             视频降噪 / 视频防抖 / 音频降噪。 */
          denoise: clip.denoise ?? 0,
          stabilize: clip.stabilize ?? 0,
          audioDenoise: clip.audioDenoise ?? 0,
          /* 人声增强 + 变声（同样是导出阶段）。这两个字段 2026-11-02 之前**根本没进载荷**：
             检查器里滑杆拖了、变声 chip 点了、预览照旧（预览本来就不做），
             成片也照旧 —— 三处都不报错，只有 export-contract 的"导出读了渲染层没发"
             那条静态契约能抓到。别删这两行。 */
          voiceBoost: clip.voiceBoost ?? 0,
          voiceFx: clip.voiceFx || 'none',
          /* 倒放：导出侧拼 ffmpeg 的 reverse / areverse（预览靠 sourceTimeAt 反向取帧）。
             载荷里少带这一个布尔 = 面板上开关亮了、成片照旧正放。 */
          reverse: clip.reverse === true,
          /* 立体声平衡（-100 左 / 0 居中 / +100 右）。导出侧拼 pan 滤镜；
             预览因为浏览器不能按声道分增益，只标注不生效（见 RightPanel 的提示）。 */
          pan: clip.pan ?? 0,
          /* 关键帧表（位置/缩放/旋转/不透明度的时间曲线）。导出侧用它拼
             ffmpeg 的表达式（`t` 为片段内时间），与预览同一个线性插值函数。 */
          keyframes: clip.keyframes || null,
          /* 片段级淡入 / 淡出（秒）—— afade 只吃这几个数 */
          fadeIn: clip.fadeIn ?? 0,
          fadeOut: clip.fadeOut ?? 0,
          /* 字幕：**正文 + 样式 key + 有没有 assetId** 三个都得带。
             · text / textStyle —— 导出要用它们拼 drawtext，少一个就"成片里没有字幕"；
             · assetId —— 用来分辨"字幕"与"从素材库拖进来的文字素材"，
               后者在预览里是一张占位卡，不该往画面上写字。 */
          text: clip.text || '',
          textStyle: clip.textStyle || '',
          /* 字幕的片段级覆写（右侧检查器调的字号/颜色/位置/偏移）。
             主进程 subtitles.js 走同一个 applyTextOverrides —— 少带一项就是
             "预览里字幕变红变大、成片里还是原样"。 */
          textScale: clip.textScale ?? 1,
          textColor: clip.textColor || '',
          textAnchor: clip.textAnchor || '',
          textOffset: clip.textOffset ?? null,
          /* 排版三项（行距 / 对齐 / 背景框）。导出侧读这些拼 line_spacing / text_align / box，
             少带一项 = 预览里排好了、成片里回到默认。 */
          textLineHeight: clip.textLineHeight ?? null,
          textAlign: clip.textAlign || '',
          textBgOn: clip.textBgOn ?? null,
          textBgColor: clip.textBgColor || '',
          textBgOpacity: clip.textBgOpacity ?? null,
          textBgPad: clip.textBgPad ?? null,
          /* 文字动画三项 + 两个时长。导出侧用它们生成 drawtext 的时间表达式
             （alpha / x / y / fontsize），与预览的 CSS 类同源。 */
          textIn: clip.textIn || '',
          textOut: clip.textOut || '',
          textLoop: clip.textLoop || '',
          textInDur: clip.textInDur ?? null,
          textOutDur: clip.textOutDur ?? null,
          /* 自定义字体：路径给导出（fontfile），家族名给预览（CSS） */
          textFont: clip.textFont || '',
          textFontPath: clip.textFontPath || '',
          assetId: clip.assetId || ''
        }))
      })
      if (result?.ok) {
        setRatio(1)
        /* 主进程可能纠正过扩展名（选了 ProRes 而输入框里还是 .mp4）。
           界面上不跟着改的话，用户会去那个 .mp4 路径找文件，找不到。 */
        if (result.outPath && result.outPath !== target) setOutPath(result.outPath)
        toast.good(`成片已导出：${result.outPath}`)
        /* 封面是附加产物：成片成功、封面失败时**不能**把整次导出说成失败（片已经在那儿了），
           但也绝不能一声不吭 —— 否则用户只会看到"开了封面却没有图"，原因一个字都看不到。 */
        if (result.coverPath) {
          toast.good(`封面已保存：${result.coverPath}`)
        } else if (coverOn) {
          toast.bad(`封面没生成：${result.coverError || '原因未知'}（成片本身已正常导出）`)
        }
        /* 事办了但没办全的（例如这台机器没有中文字体、字幕没写进去）要如实说一声 ——
           不说的话用户只会看到"成片里没有字幕"，而原因一个字都看不到。 */
        if (Array.isArray(result.warnings) && result.warnings.length) {
          for (const line of result.warnings) toast(line)
        }
      } else {
        setFailure(result?.error || '渲染失败')
        toast.bad('渲染失败，详见下方说明')
      }
    } catch (error) {
      setFailure(error.message)
      toast.bad('渲染失败，详见下方说明')
    } finally {
      setBusy(false)
    }
  }, [activeEncoder, activeRange, aspect, backdrop, bitrate, bitrateMode, bridge, clips, codecInfo.key, coverAt, coverOn, fps, loudness, outPath, pickOutput, quality, resolution, toast])

  const cancelRender = useCallback(() => {
    bridge?.render?.cancel()
  }, [bridge])

  const exportProject = useCallback(() => {
    const payload = {
      应用: '艺镜AI剪辑',
      项目名: projectName,
      导出时间: new Date().toISOString(),
      画布: { 分辨率: resolution, 画面比例: aspect, 输出尺寸: [sizeOut.width, sizeOut.height], 帧率: fps, 画质: quality },
      成片时长秒: Number(duration.toFixed(3)),
      片段: clips.map((clip) => ({
        名称: clip.name,
        轨道: clip.track,
        起点秒: Number(clip.start.toFixed(3)),
        时长秒: Number(clip.duration.toFixed(3)),
        入点秒: Number((clip.offset || 0).toFixed(3)),
        滤镜: clip.filter || 'none',
        滤镜强度: clip.filterIntensity ?? 1,
        转场: clip.transition || 'none',
        转场时长秒: Number(clip.transitionDuration || 0),
        来源: clip.path || clip.url || '（文本片段）'
      }))
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${projectName || '未命名项目'}.yjproj.json`
    link.click()
    URL.revokeObjectURL(url)
    toast.good('工程文件已导出')
  }, [aspect, clips, projectName, resolution, sizeOut.width, sizeOut.height, fps, quality, duration, toast])

  const ready = Boolean(ffmpeg && ffmpeg.available)

  return (
    <Shell kicker="EXPORT" title="导出">
      {/* 摘要条：一行说完"这条成片是什么"。
          ⚠️ 从前的两张键值表共 7 行（片段数 / 时长 / 区间 / 转场占用 / 渲染引擎 /
             画面比例 / 输出尺寸），把真正的操作项一路压到首屏之外 —— 而「导出成片」
             才是这个面板唯一的目的。
          ⚠️ `data-export-duration` / `data-export-range` 是 region-e2e 的判据锚点，
             换版式也必须留在**始终可见**的位置（它们原来在那张表里）。 */}
      <div className="export-summary" data-export-summary="1">
        <b data-export-duration={Number(outDuration.toFixed(3))} title={activeRange ? '成片时长（仅时间区域）' : '成片时长'}>
          {timecode(outDuration, false)}
        </b>
        <i aria-hidden="true">·</i>
        <span title="按当前画面比例从基准分辨率裁出的实际输出尺寸">
          <em data-export-aspect={aspect}>{aspectOf(aspect).label}</em> {sizeOut.width}×{sizeOut.height}
        </span>
        <i aria-hidden="true">·</i>
        <span>{EXPORT_RATE.readRate(fps).id} fps</span>
        <i aria-hidden="true">·</i>
        <span>{codecInfo.containerLabel}</span>
        <i aria-hidden="true">·</i>
        <span>{clips.length} 段</span>
        {activeRange ? (
          <>
            <i aria-hidden="true">·</i>
            <span className="mono" data-export-range={`${activeRange.start}-${activeRange.end}`} title="导出区间（成片内从 0 起算）">
              {timecode(activeRange.start, false)}–{timecode(activeRange.end, false)}
            </span>
          </>
        ) : null}
        {savedByTransitions > 0.01 ? (
          <>
            <i aria-hidden="true">·</i>
            <span title="转场重叠吃掉的时长 —— 成片比片段总长略短就是因为这个">转场 -{savedByTransitions.toFixed(2)}s</span>
          </>
        ) : null}
        <span
          className={`export-engine ${ready ? '' : 'bad'}`}
          title={
            ffmpeg === null
              ? '正在探测本机 ffmpeg…'
              : ready
                ? 'ffmpeg 已就绪，可以直接出片'
                : '未检测到 ffmpeg —— 现在只能导出工程文件'
          }
        >
          {ffmpeg === null ? '检测中…' : ready ? 'ffmpeg 就绪' : '无 ffmpeg'}
        </span>
      </div>

      {/* 两屏切换：只换"看得见什么"，不换状态 —— 切来切去设置都还在。 */}
      <div className="export-seg" role="tablist" aria-label="导出设置分组">
        {[
          ['basic', '基本', '每次导出都可能要改的：尺寸、帧率、画质、输出范围'],
          ['advanced', '高级', '定好就不动的：编码格式、视频编码、码率控制、响度统一、封面图']
        ].map(([key, label, tip]) => (
          <button
            key={key}
            type="button"
            role="tab"
            title={tip}
            aria-selected={seg === key}
            data-export-seg={key}
            className={seg === key ? 'on' : ''}
            onClick={() => setSeg(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="export-grid">
        <label className="field">
          <span>输出分辨率</span>
          <select
            className="select"
            value={resSpec.id}
            data-export-resolution="1"
            onChange={(event) => setResolution(event.target.value)}
          >
            {EXPORT_RATE.RESOLUTIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.width} × {item.height}
              </option>
            ))}
          </select>
        </label>

        {/* 4K 不是"点了就等一会儿"：同一段素材耗时约为 1080P 的 3~5 倍，
            而进度条只会显示"正在导出"—— 用户分不清是机器慢还是卡死了。
            在选中的那一刻先说清楚，比导到一半弹一句"请耐心等待"有用。 */}
        {resSpec.id === '4k' ? (
          <div className="notice" data-export-4k-hint="1" style={{ gridColumn: '1 / -1' }}>
            4K 导出较慢（约 1080P 的 3~5 倍）；素材本身不足 4K 时是放大插值，不会更清晰。
          </div>
        ) : null}

        {/*
          帧率：**档位**，不是滑杆。
          以前是 `min=24 max=60 step=6` 的滑杆，能落到的只有 24/30/36/42/48/54/60 ——
          25 与 50（PAL / 国内电视台 / 大量商用素材）和 29.97 / 59.94（NTSC 母版）
          一个都选不出来，而 36/42/48 又是不存在的交付规格。选错只能导出后重转一次，
          重转必掉帧。七档与参考客户端一致，理由与整数比换算见 shared/exportRate.js。
          ⚠️ 与分辨率并排两列：它们是同一类事（"出多大的片"），分成两行只是白占高度。
        */}
        <label className="field">
          <span>帧率</span>
          <select
            className="select"
            value={EXPORT_RATE.readRate(fps).id}
            data-export-fps="1"
            onChange={(event) => setFps(EXPORT_RATE.readRate(event.target.value).fps)}
          >
            {EXPORT_RATE.RATES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} fps
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 画质：基本页只留这一条滑杆 —— 「码率控制」那个二选一留在高级页，
          但当前模式对应的滑杆在这儿，因为它才是"这次导多大"的那一个数。 */}
      {codecInfo.variableQuality ? (
        bitrateMode === 'bitrate' ? (
          <Slider
            label="目标码率"
            suffix=" kbps"
            min={1000}
            max={60000}
            step={500}
            value={bitrate}
            onChange={setBitrate}
          />
        ) : (
          <Slider label="画质" suffix="%" min={30} max={100} step={5} value={quality} onChange={setQuality} />
        )
      ) : null}

      {/* 时间区域：只有当前真的框了区间才出现（没框的时候摆一个灰开关毫无意义） */}
      {range ? (
        <div className="field" data-export-range-field="1">
          <span>输出范围</span>
          <div className="wb-chiprow" data-export-range-mode="1">
            <button
              type="button"
              className={`chip ${!onlyRange ? 'on' : ''}`}
              data-export-range-btn="all"
              aria-pressed={!onlyRange}
              title="导出整条时间线"
              onClick={() => setOnlyRange(false)}
            >
              整条时间线
            </button>
            <button
              type="button"
              className={`chip ${onlyRange ? 'on' : ''}`}
              data-export-range-btn="range"
              aria-pressed={onlyRange}
              title={`只导出 ${timecode(Number(range.start), false)} – ${timecode(Number(range.end), false)} 这一段`}
              onClick={() => setOnlyRange(true)}
            >
              只导出时间区域
            </button>
          </div>
        </div>
      ) : null}

      {/* ================= 高级 =================
          下面这一整段（封面图 / 编码格式 / 视频编码 / 码率控制 / 响度统一）
          都是「定好一次就不动」的设置。摆在基本页只是把首屏占满、
          把「导出成片」挤到看不见的地方。 */}
      {seg === 'advanced' ? (
        <>
      {/*
        封面图：把成片里的某一帧另存一张图，用来当发布平台的缩略图。
        取帧位置就是**当前播放头**（用户在预览里盯着的那一帧），不用他再挑一次；
        时间按成片内秒数折算并在主进程再夹一次，两边判据同源（shared/cover.js）。
      */}
      <div className="field" data-export-cover-field="1">
        <span>封面图</span>
        <div className="wb-chiprow" data-export-cover-mode="1">
          <button
            type="button"
            className={`chip ${!coverOn ? 'on' : ''}`}
            data-export-cover-btn="off"
            aria-pressed={!coverOn}
            title="只导出成片"
            onClick={() => setCoverOn(false)}
          >
            不导出
          </button>
          <button
            type="button"
            className={`chip ${coverOn ? 'on' : ''}`}
            data-export-cover-btn="on"
            aria-pressed={coverOn}
            title="除成片外，再把播放头这一帧另存为一张 JPG"
            onClick={() => setCoverOn(true)}
          >
            导出封面图
          </button>
        </div>
        {coverOn ? (
          <div className="kv-list" style={{ marginTop: 8 }} data-export-cover-at={coverAt}>
            <div>
              <span>取帧位置</span>
              <strong className="mono" data-export-cover-time="1">
                {timecode(coverAt)}
              </strong>
            </div>
            <div>
              <span>保存为</span>
              <strong className="mono">成片同名 -cover.jpg</strong>
            </div>
          </div>
        ) : null}
      </div>

      {/*
        编码格式：决定**容器**（MP4 / MOV）、**色深**（8 / 10 位）与**是否留 Alpha**。
        它必须排在「视频编码」上面：编码器是格式族内的一档（H.265 的硬件编码与
        H.264 的硬件编码是两个不同的东西），先定格式再定实现才说得通。
      */}
      <label className="field">
        <span>
          编码格式
          <em data-export-codec-ext={codecInfo.ext}>{codecInfo.containerLabel}</em>
        </span>
        <select
          className="select"
          value={codecInfo.key}
          data-export-codec="1"
          onChange={(event) => {
            const next = EXPORT_CODEC.readCodec(event.target.value)
            setCodec(next.key)
            /* 换族时把编码器一起带过去：留着 h264_nvenc 去编 H.265，
               主进程会在族内回落到 x265 —— 面板写着一个、实际用另一个。 */
            setEncoder(EXPORT_CODEC.encodersFor(next.key, availableEncoders)[0])
            /* 输出路径的扩展名跟着改，别等到导出时才被纠正 */
            setOutPath((prev) => (prev ? EXPORT_CODEC.matchExtension(prev, next.key) : prev))
          }}
        >
          {EXPORT_CODEC.CODECS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint" style={{ marginTop: -4 }} data-export-codec-note={codecInfo.key}>
        {codecInfo.note}
      </p>

      {/*
        编码器：只列**本机 ffmpeg 真的支持**的那几个（probe 时逐个查过 `-encoders`），
        并且只在**当前编码格式这一族**里列。
        ⚠️ 摆一个选了就废掉的选项比不摆更糟：没有 N 卡却选 h264_nvenc 时，
        ffmpeg 不是回退软编，而是整个导出失败（"No capable devices found"）。
      */}
      <label className="field">
        <span>视频编码</span>
        <select
          className="select"
          value={activeEncoder}
          data-export-encoder="1"
          onChange={(event) => setEncoder(event.target.value)}
        >
          {codecEncoders.map((key) => (
            <option key={key} value={key}>
              {ENCODER_LABEL[key] || key}
            </option>
          ))}
        </select>
      </label>

      {/*
        码率模式：画质优先（crf/cq）或码率优先（准 CBR）。
        ProRes 没有 crf —— 质量由 profile 决定，这组控件对它**不生效**，
        所以直接收起来并说明，而不是留在那儿"能点、点了没用"。
      */}
      {codecInfo.variableQuality ? (
        <div className="field">
          <span>码率控制</span>
          <div className="wb-chiprow" data-export-bitrate-mode="1">
            {[
              ['quality', '画质优先'],
              ['bitrate', '码率优先']
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`chip ${bitrateMode === key ? 'on' : ''}`}
                data-export-bitrate-btn={key}
                aria-pressed={bitrateMode === key}
                onClick={() => setBitrateMode(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* 滑杆本身在「基本」页（画质是每次导出都要看一眼的数），
              这里只解释两种模式的区别 —— 换模式后回基本页，滑杆会跟着换成
              「画质 %」或「目标码率 kbps」，所以不能在这里再放一条滑杆。 */}
          <p className="hint" style={{ marginTop: 6 }}>
            {bitrateMode === 'bitrate'
              ? '按目标码率编码（准 CBR）：文件大小可预估，画面简单处会白白浪费码率。'
              : '按画质档编码（CRF / CQ）：同一档在不同画面上体积不同，复杂画面自动多给码率 —— 一般选这个。'}
          </p>
        </div>
      ) : (
        /* ProRes 的质量由 profile 决定，没有 crf/码率可调。留一组点了没反应的滑杆
           比不摆更糟 —— 用户会以为"调了画质"，实际什么都没变。 */
        <p className="hint" data-export-prores-note="1">
          ProRes 是固定质量编码（质量由 profile 决定），画质档与码率对它不生效。
        </p>
      )}

      {/* 响度统一（导出阶段，作用在混完的总线上） */}
      <label className="field">
        <span>响度统一</span>
        <select
          className="select"
          value={loudness}
          data-export-loudness="1"
          onChange={(event) => setLoudness(event.target.value)}
        >
          {LOUDNESS_MODES.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint" style={{ marginTop: -4 }}>
        响度统一在混音完成后统一整条音轨的响度（不同素材音量差很大时最有用），只影响导出。
      </p>
        </>
      ) : null}

      {/* 输出文件 + 导出/取消 + 工程文件：**始终可见**，不跟着分屏走 ——
          这是这个面板的目的，翻到哪一屏都得按得到。 */}
      <label className="field">
        <span>输出文件</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            value={outPath}
            onChange={(event) => setOutPath(event.target.value)}
            placeholder="点「另存为」选择位置"
          />
          <button className="btn small" type="button" onClick={pickOutput} disabled={busy}>
            另存为
          </button>
        </div>
      </label>

      {busy ? (
        <>
          <div className="notice" style={{ marginTop: 12 }}>
            <span>正在渲染 {Math.round(ratio * 100)}%</span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 3,
              background: '#26262b',
              overflow: 'hidden',
              marginTop: 8
            }}
          >
            <div
              style={{
                width: `${Math.round(ratio * 100)}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #8b6bf5, #d94be8)',
                transition: 'width .2s ease'
              }}
            />
          </div>
        </>
      ) : null}

      <button
        className="btn block primary"
        style={{ marginTop: 12 }}
        type="button"
        onClick={startRender}
        data-export-submit="1"
        disabled={!clips.length || !ready || busy}
      >
        <IconDownload size={14} />
        {/* 容器名必须跟着编码格式走：选了 ProRes 4444 还写「导出成片（MP4）」，
            就是面板自己跟自己矛盾 —— 而这行字是用户最后一眼看到的东西。 */}
        {busy ? '渲染中…' : `导出成片（${codecInfo.containerLabel}）`}
      </button>

      {busy ? (
        <button className="btn block" style={{ marginTop: 8 }} type="button" onClick={cancelRender}>
          取消渲染
        </button>
      ) : null}

      <button className="btn block" style={{ marginTop: 8 }} type="button" onClick={exportProject} disabled={busy}>
        另存工程文件（JSON，可二次编辑）
      </button>

      {failure ? (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <IconAlert size={14} />
          <span style={{ whiteSpace: 'pre-wrap' }}>{failure}</span>
        </div>
      ) : null}

      {ffmpeg && !ffmpeg.available ? (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <IconAlert size={14} />
          <span>
            {ffmpeg.reason === 'not-found'
              ? /* ⚠️ 必须给出**可照做**的三条路：ffmpeg 是 LGPL/GPL 的，本项目是 MIT，
                   安装包默认不带它（理由见 tools/fetch-ffmpeg.mjs）。
                   只写"没找到 ffmpeg"的话，用户既不知道为什么不带，也不知道下一步做什么。 */
                '本机没找到 ffmpeg，现在只能导出工程文件。三条路任选一条即可直接出片：① 把 ffmpeg.exe 放进安装目录下的 resources\\ffmpeg\\；② 装到系统里并加进 PATH；③ 用环境变量 YIJAI_FFMPEG 指向 ffmpeg.exe。'
              : `检测到 ffmpeg 但无法运行：${ffmpeg.detail || ffmpeg.reason}`}
          </span>
        </div>
      ) : null}
    </Shell>
  )
}

/* ------------------------------- 账号 ------------------------------- */
