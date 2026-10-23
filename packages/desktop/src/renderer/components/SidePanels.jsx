import { useCallback, useEffect, useState } from 'react'
import { IconAddSquare, IconAlert, IconCheck, IconCoins, IconDownload, IconExternal, IconInfo, IconPlus, IconSearch, IconSparkle, IconTrash, IconWand } from '../icons.jsx'
import { isDesktop } from '../platform.js'
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
  h264_amf: 'AMD 硬件编码（AMF）'
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
    onImport,
    onSetBackdrop,
    /* 当前预览底图（素材 → 背景选的那张）。导出面板要用它把背景也渲进成片。 */
    backdrop = null,
    /* 左栏树节点的 material 字段（"family:index"）——滤镜/转场/特效三页的分组选择 */
    materialGroup = null,
    enhanceGroup = null,
    refArtFamily = null,
    /* 左栏树节点上的「能力码 / 花字组号 / 贴纸组」—— 见 AssetTree.jsx */
    textStyleGroup = null,
    /* 提取音轨这类本地工具要把产物放回素材库 */
    onAddAsset,
    /* 参与导出的片段（App 已按轨道开关 / 停用状态结算过）。
       缺省回退 clips：这样旧的调用点不传也不会崩，只是拿全量。 */
    renderClips = null,
    /* 时间区域（秒）：非空时导出面板给出「只导出这一段」的开关 */
    range = null
  } = props

  if (mode === 'export') {
    return <ExportPanel clips={renderClips || clips} projectName={projectName} backdrop={backdrop} aspect={props.aspect || DEFAULT_ASPECT} range={range} />
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
function StylePanel({ clips, onAddTextClip, onClearTextTrack, group }) {
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
    </Shell>
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

/* ------------------------------- 转场 ------------------------------- */

/* ---------------------------- 参考配图画廊（通用） ---------------------------- */

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

function ExportPanel({ clips, projectName, backdrop = null, aspect = DEFAULT_ASPECT, range = null }) {
  const toast = useToast()
  const [resolution, setResolution] = useState('1080p')
  const [fps, setFps] = useState(30)
  const [quality, setQuality] = useState(80)
  /* 编码与码率：默认软编 + 画质优先，与改动前逐字一致（不改变既有的导出证据） */
  const [encoder, setEncoder] = useState('libx264')
  const [bitrateMode, setBitrateMode] = useState('quality')
  const [bitrate, setBitrate] = useState(8000)
  /* 响度统一：默认不处理 */
  const [loudness, setLoudness] = useState('off')
  const [ffmpeg, setFfmpeg] = useState(null)
  const [outPath, setOutPath] = useState('')
  const [ratio, setRatio] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

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

  const bridge = isDesktop && typeof window !== 'undefined' ? window.yjai : null
  const SIZES = {
    '720p': [1280, 720],
    '1080p': [1920, 1080],
    '2k': [2560, 1440],
    '4k': [3840, 2160]
  }

  /** 成片尺寸（基准分辨率裁出当前比例）。面板上要显示，startRender 也要用，算一次。 */
  const sizeOut = outputSizeFor(
    (SIZES[resolution] || SIZES['1080p'])[0],
    (SIZES[resolution] || SIZES['1080p'])[1],
    aspect
  )

  /**
   * 可选编码器 = 主进程 probe 出来的那几个。
   * 探测还没回来（ffmpeg === null）时只给 libx264 —— 软编永远可用，先摆一个能用的，
   * 不摆一个"待定"的空下拉。硬件编码回来了再自动多出选项。
   */
  const availableEncoders =
    ffmpeg && Array.isArray(ffmpeg.encoders) && ffmpeg.encoders.length ? ffmpeg.encoders : ['libx264']

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
    const picked = await bridge.render.pickOutput(`${projectName || '艺镜AI'}-成片.mp4`)
    if (picked) setOutPath(picked)
    return picked
  }, [bridge, projectName, toast])

  const startRender = useCallback(async () => {
    if (!clips.length) return
    setFailure('')
    const target = outPath || (await pickOutput())
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
        options: { width: sizeOut.width, height: sizeOut.height, fps, quality, aspect, encoder, bitrateMode, bitrate, loudness, range: activeRange },
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
          /* 「效果」（圆角 / 蒙版 / 抠像 / 混合 / 变形 / 描边 / 阴影）。
             真源换算在 shared/effects.js，两侧共用；载荷里少带就是
             "面板上调了圆角、预览里圆了、成片还是方的"。 */
          effects: clip.effects || null,
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
        toast.good(`成片已导出：${result.outPath}`)
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
  }, [activeRange, aspect, backdrop, bitrate, bitrateMode, bridge, clips, encoder, fps, loudness, outPath, pickOutput, quality, resolution, toast])

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
        <select className="select" value={resolution} onChange={(event) => setResolution(event.target.value)}>
          <option value="720p">1280 × 720</option>
          <option value="1080p">1920 × 1080</option>
          <option value="2k">2560 × 1440</option>
          <option value="4k">3840 × 2160</option>
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

      <Slider label="帧率" suffix=" fps" min={24} max={60} step={6} value={fps} onChange={setFps} />

      {/*
        编码器：只列**本机 ffmpeg 真的支持**的那几个（probe 时逐个查过 `-encoders`）。
        ⚠️ 摆一个选了就废掉的选项比不摆更糟：没有 N 卡却选 h264_nvenc 时，
        ffmpeg 不是回退软编，而是整个导出失败（"No capable devices found"）。
      */}
      <label className="field">
        <span>视频编码</span>
        <select
          className="select"
          value={availableEncoders.includes(encoder) ? encoder : 'libx264'}
          data-export-encoder="1"
          onChange={(event) => setEncoder(event.target.value)}
        >
          {availableEncoders.map((key) => (
            <option key={key} value={key}>
              {ENCODER_LABEL[key] || key}
            </option>
          ))}
        </select>
      </label>

      {/* 码率模式：画质优先（crf/cq）或码率优先（准 CBR） */}
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
        disabled={!clips.length || !ready || busy}
      >
        <IconDownload size={14} />
        {busy ? '渲染中…' : '导出成片（MP4）'}
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
