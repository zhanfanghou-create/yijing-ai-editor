import { useCallback, useEffect, useState } from 'react'
import { IconAddSquare, IconAlert, IconCheck, IconCoins, IconDownload, IconExternal, IconFolder, IconInfo, IconMic, IconPlugin, IconPlus, IconSearch, IconSparkle, IconTrash, IconWand } from '../icons.jsx'
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
    /* 字幕文件的进出与语音分句（只挂在「字幕 → 字幕模板」页） */
    onImportSubtitle,
    onExportSubtitle,
    onAutoSegment,
    onImport,
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
        range={range}
        playhead={playhead}
      />
    )
  }
  if (mode === 'text') return <TextPanel onAddTextClip={onAddTextClip} clips={clips} onClearTextTrack={onClearTextTrack} />
  /* 「文字 → 花字」与「字幕 → 字幕模板」共用样式页，靠 textStyleGroup 区分：
     null = 显示全部字幕样式（字幕模板），数字 = 花字的第 N 组。 */
  if (mode === 'text-style') {
    return (
      <StylePanel
        clips={clips}
        onAddTextClip={onAddTextClip}
        onClearTextTrack={onClearTextTrack}
        group={textStyleGroup}
        onImportSubtitle={onImportSubtitle}
        onExportSubtitle={onExportSubtitle}
        onAutoSegment={onAutoSegment}
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
  if (mode === 'record') return <RecordPanel onImport={onImport} />
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

/** 字幕轨现状 —— 文字页与字幕页都要看，抽出来免得两处各写一份 */
function TextTrackSummary({ clips, onClearTextTrack }) {
  const textClips = clips.filter((clip) => clip.track === 'text')
  return (
    <>
      <div className="section-title" style={{ marginTop: 16 }}>
        <span>字幕轨</span>
        <span>{textClips.length} 段</span>
      </div>
      {textClips.length ? (
        <>
          <div className="list">
            {textClips.map((clip) => (
              <div className="list-item" key={clip.id}>
                <div className="grow">
                  <strong>{clip.text || clip.name}</strong>
                  <small>
                    {timecode(clip.start, false)} 起 · {Number(clip.duration).toFixed(1)}s ·{' '}
                    {textStyleDef(clip.textStyle).label}
                  </small>
                </div>
              </div>
            ))}
          </div>
          <button className="btn block" type="button" style={{ marginTop: 10 }} onClick={onClearTextTrack}>
            <IconTrash size={14} />
            清空字幕轨
          </button>
        </>
      ) : (
        <div className="empty">字幕轨还是空的。点上面的样式就能加第一段。</div>
      )}
    </>
  )
}

/**
 * 「文字」页 —— 文字模板：点一下**新增**一段文字，并停在它上面。
 * 卡片 100×100、间距 16 取自参考 PropertyPanel_TextStyle.qml（itemWidth/itemHeight: 100）。
 */
function TextPanel({ clips, onAddTextClip, onClearTextTrack }) {
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
      <div className="notice" style={{ marginBottom: 12 }}>
        <IconInfo size={14} />
        <span>
          点一个样式就会在<b>播放头位置</b>新增一段文字，并把播放头停在它的起点 ——
          所以在预览画面里立刻能看到效果。之后可以在时间线上拖动、修剪，也可以按 Ctrl+B 分割。
        </span>
      </div>

      <StyleGrid items={items} picked={picked} onPick={pick} sizeKey="title" testid="text" />

      <TextTrackSummary clips={clips} onClearTextTrack={onClearTextTrack} />
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
function StylePanel({ clips, onAddTextClip, onClearTextTrack, group, onImportSubtitle, onExportSubtitle, onAutoSegment }) {
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

      <TextTrackSummary clips={clips} onClearTextTrack={onClearTextTrack} />

      {/* 字幕文件与语音分句只属于「字幕 → 字幕模板」这一页（`group === null`）。
          花字页共用同一个组件，摆在这里会让"给标题换样子"的人看到一堆导出按钮。 */}
      {isArt ? null : (
        <SubtitleTools
          clips={clips}
          onImportSubtitle={onImportSubtitle}
          onExportSubtitle={onExportSubtitle}
          onAutoSegment={onAutoSegment}
        />
      )}
    </Shell>
  )
}

/**
 * 字幕文件三件：导入 / 导出 / 按语音分句。
 *
 * 为什么这三件事要放在一起：它们解决的是同一个问题的三个方向 ——
 * 字幕**从哪来**（外部 srt / 语音分句）、**到哪去**（导出 srt 带走）。
 * 少了第三件，用户剪完想发到别的平台就没有出口。
 *
 * ⚠️ 这三颗按钮**必须写清"做了什么、没做什么"**：开源版不带语音识别模型，
 *    「按语音分句」切的是**时间轴**，文字要用户自己填。按钮上写"智能字幕"、
 *    点完却只得到一堆空白段，比没有这个按钮更糟。
 */
function SubtitleTools({ clips, onImportSubtitle, onExportSubtitle, onAutoSegment }) {
  const count = clips.filter((clip) => clip.track === 'text').length
  return (
    <>
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
        onClick={() => onAutoSegment?.()}
      >
        <IconMic size={14} />
        按语音自动分句
      </button>
      <div className="wb-muted-sm" style={{ marginTop: 6, lineHeight: 1.6 }}>
        导入支持 SRT / VTT / LRC / ASS。「按语音分句」在选中的视频片段上分析音量，
        按“有人说话的区间”切出空白字幕段（文字需要你自己填 —— 本机版不带语音识别模型）。
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
  const cut = selectedClip || activeClip || null

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

  return (
    <Shell>
      <div className="section-title">
        <span>提取音频</span>
      </div>
      <div className="notice">
        <IconInfo size={14} />
        <span>把片段里的音轨单独抽成一条音频素材，抽出来可以放到音频轨上复用。全程用本机 ffmpeg，不依赖任何服务。</span>
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
 * 「插件」面板 —— 装的是**素材包**（自定义边框 / 贴纸），不是 .ofx 原生特效插件。
 *
 * 参考客户端的插件是 OpenFX（`.ofx` 原生动态库）：宿主得实现一整套 C++ 特效宿主 API
 * 才能加载、还得把参数暴露成它自己的属性面板。本工程不做这件事，**也不摆假入口** ——
 * 面板顶上一句话把边界说明白，用户不会点进来期待能装 DaVinci 的插件。
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

      {/* 把边界写在最上面：不支持 .ofx 是要让用户在点"导入"之前就知道的事 */}
      <div className="plug-note" data-plug-note="1">
        {/* ⚠️ 文件名必须包成 {'...'}：JSX 文本里的裸 `manifest.json` 会被
            check-imports 的自由变量扫描当成成员表达式，报 `manifest` 未定义。
            字符串字面量会被它剥掉，裸文本不会。 */}
        插件是<strong>本地素材包</strong>：一个文件夹，里面放 <code>{'manifest.json'}</code> 和几张 PNG。
        装好后立刻出现在「特效 → 边框」与「贴纸」里，预览和导出都直接生效。
        本版本<strong>不支持 .ofx 原生插件</strong>（那需要实现 OpenFX 宿主接口）。
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

      <p className="plug-tip">
        插件素材会复制到本机用户目录（<code>plugins</code> 下），<strong>不上传任何地方</strong>。
        删除时进系统回收站，误点还能捞回来。
      </p>
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
      <Shell kicker="参考配图" title="未找到配图族">
        <div className="empty">
          左栏这一项指向的配图族「{String(familyKey)}」在 artSet.js 里不存在。
          <br />
          这是配置错误，不是数据为空 —— 请在 artSet.js 的 ART_FAMILIES 里补上。
        </div>
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
              转场会让成片<b>缩短</b>对应时长（交叠部分不重复计时）：当前结算后
              <b> {timecode(total, false)}</b>（原 {timecode(rawTotal, false)}）。
              时间线上的角标与这里读的是同一份结算。
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
 * 缩略图是**真算出来的**：用同一组参数换算成 CSS `brightness/contrast/saturate`
 * 加一层按色温取色的内阴影，张张不同、且与点下去的画面方向一致
 * （暖调卡片看着就暖）。不是随便找张图凑数。
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

  /* 预览渲染：把 ±100 的参数折成 CSS 的倍率。分母取 120~200 —— 一档就顶到纯白/全灰
     会让十六张卡长得一样，而分母太大（250+）又看不出差别（实测 1.02 的 brightness
     在缩略图上完全分辨不出）。方向与 shared/adjust.js 的增益一致：
     亮度↑=更亮、对比↑=更硬、饱和↑=更艳、色温↑=更暖（正）更冷（负）。 */
  const previewStyle = (adjust) => {
    const bright = 1 + (adjust.bright || 0) / 150
    const contrast = 1 + (adjust.contrast || 0) / 110
    const saturate = 1 + (adjust.saturate || 0) / 90
    const temp = adjust.temp || 0
    return {
      /* 一块"假风景"：天空 → 地面 + 左上高光。有明暗层次才看得出对比度与亮度差，
         纯色渐变上这些参数变化几乎不可见（对比度对纯色毫无作用）。 */
      backgroundImage:
        'radial-gradient(circle at 30% 26%, rgba(255, 246, 220, 0.85) 0%, rgba(255, 246, 220, 0) 44%), linear-gradient(168deg, #93aec6 0%, #cbd6d9 40%, #8d9a72 68%, #3d4738 100%)',
      filter: `brightness(${bright.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)})`,
      boxShadow:
        temp > 0
          ? `inset 0 0 0 999px rgba(255, 150, 40, ${(temp / 260).toFixed(3)})`
          : temp < 0
            ? `inset 0 0 0 999px rgba(40, 140, 255, ${(-temp / 260).toFixed(3)})`
            : 'none'
    }
  }

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
                <span className="look-adjust-art" style={previewStyle(item.adjust)} />
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
      <div className="notice" style={{ marginBottom: 12 }}>
        <IconInfo size={14} />
        <span>把选中片段当前的<b>滤镜 + 转场</b>存成一套，之后一键套到别的片段上。预设存在本机。</span>
      </div>

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

      <div className="notice" style={{ marginTop: 12 }}>
        <IconSparkle size={14} />
        <span>
          以上每一项都是当场执行的真实操作，并会写进撤销历史（Ctrl+Z 可回退）。
        </span>
      </div>
    </Shell>
  )
}

/* ------------------------------- 录制 ------------------------------- */

/**
 * 「录制」面板 —— 这个标签在参考客户端里对应屏幕/摄像头录制。
 *
 * 本项目**没有**实现应用内录制，原因不是没想到，而是它需要动安全基线：
 * Electron 里做录制必须放开渲染进程的 media 权限（或由主进程接管 desktopCapturer），
 * 而现有基线明确写着「拒一切权限申请」。这个取舍不该由实现方单方面改掉。
 *
 * 所以这里不摆一个点了没反应的假按钮，而是把「现在能做什么」和「还缺什么决定」讲清楚，
 * 并给一个确实可用的入口：导入系统录屏得到的文件。
 */
function RecordPanel({ onImport }) {
  return (
    <Shell kicker="RECORD" title="录制">
      <div className="notice warn" style={{ marginBottom: 12 }}>
        <IconAlert size={14} />
        <span>
          <b>应用内录制尚未接入。</b>
          参考客户端在这一项下做的是屏幕/摄像头录制，本项目要支持它必须放开渲染进程的
          media 权限（现基线是「拒一切权限申请」），这个取舍需要单独确认后才会动。
        </span>
      </div>

      <div className="section-title">
        <span>现在可以走的路</span>
      </div>
      <div className="list">
        <div className="list-item">
          <div className="grow">
            <strong>用系统自带录屏，再导入</strong>
            <small>Windows 按 Win+G 录屏，macOS 按 Cmd+Shift+5，存好后从这里导入</small>
          </div>
          <button className="btn small" type="button" onClick={onImport}>
            <IconPlus size={14} />
            导入
          </button>
        </div>
        <div className="list-item">
          <div className="grow">
            <strong>把录像拖进窗口</strong>
            <small>资源管理器里直接把文件拖到软件窗口任意位置</small>
          </div>
          <span className="chip">可用</span>
        </div>
      </div>

      <div className="notice" style={{ marginTop: 12 }}>
        <IconInfo size={14} />
        <span>
          接入应用内录制需要新增主进程 desktopCapturer 通道并将 media 权限收敛到本应用源，
          属于安全基线变更，已列入待确认清单。
        </span>
      </div>
    </Shell>
  )
}

/* ------------------------------- 导出 ------------------------------- */

function ExportPanel({ clips, projectName, backdrop = null, aspect = DEFAULT_ASPECT, range = null, playhead = 0 }) {
  const toast = useToast()
  const [resolution, setResolution] = useState(EXPORT_RATE.DEFAULT_RESOLUTION)
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
      <div className="kv-list" style={{ marginBottom: 14 }}>
        <div>
          <span>片段数</span>
          <strong>{clips.length}</strong>
        </div>
        <div>
          <span>{activeRange ? '成片时长（仅区域）' : '成片时长'}</span>
          <strong data-export-duration={Number(outDuration.toFixed(3))}>{timecode(outDuration, false)}</strong>
        </div>
        {activeRange ? (
          <div>
            <span>导出区间</span>
            <strong className="mono" data-export-range={`${activeRange.start}-${activeRange.end}`}>
              {timecode(activeRange.start, false)} – {timecode(activeRange.end, false)}
            </strong>
          </div>
        ) : null}
        {savedByTransitions > 0.01 ? (
          <div>
            <span>转场占用</span>
            <strong style={{ color: 'var(--warn, #e8b04b)' }}>-{savedByTransitions.toFixed(2)}s</strong>
          </div>
        ) : null}
        <div>
          <span>渲染引擎</span>
          <strong style={{ color: ready ? undefined : 'var(--warn, #e8b04b)' }}>
            {ffmpeg === null ? '检测中…' : ready ? 'ffmpeg 已就绪' : '未检测到 ffmpeg'}
          </strong>
        </div>
      </div>

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

      {/*
        成片形状：与预览里选的那个比例**同一个值**，在这里**只读**地摆出来。
        ⚠️ 必须显示出来：比例决定成片是横是竖，用户在这里看不到，
        只能导出完打开才发现"我明明切了竖屏"—— 那时已经渲完了。
      */}
      <div className="kv-list" style={{ marginTop: 10, marginBottom: 2 }}>
        <div>
          <span>画面比例</span>
          <strong data-export-aspect={aspect}>{aspectOf(aspect).label}</strong>
        </div>
        <div>
          <span>输出尺寸</span>
          <strong className="mono">
            {sizeOut.width} × {sizeOut.height}
          </strong>
        </div>
      </div>

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
        帧率：**档位**，不是滑杆。
        以前是 `min=24 max=60 step=6` 的滑杆，能落到的只有 24/30/36/42/48/54/60 ——
        25 与 50（PAL / 国内电视台 / 大量商用素材）和 29.97 / 59.94（NTSC 母版）
        一个都选不出来，而 36/42/48 又是不存在的交付规格。选错只能导出后重转一次，
        重转必掉帧。七档与参考客户端一致，理由与整数比换算见 shared/exportRate.js。
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
        <>
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
      </div>

      {bitrateMode === 'bitrate' ? (
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
      )}
        </>
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
