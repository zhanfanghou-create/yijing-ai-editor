import { useEffect, useMemo, useState } from 'react'
import { ASPECTS, outputSizeFor } from '../../shared/aspect.js'
import {
  ADJUST_PARAMS,
  BEAUTY_PARAMS,
  POS_LIMIT,
  ROTATE_LIMIT,
  readAdjust,
  readBeauty
} from '../../shared/adjust.js'
import {
  ANCHORS,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  isHexColor,
  hasTextOverrides,
  resetTextOverrides
} from '../../shared/textOverrides.js'
/* 效果参数（圆角/蒙版/抠像/混合/变形/描边/阴影）—— 真源在 shared/effects.js，
   导出侧 render.js 与预览侧 Stage.jsx 读的是同一份换算。 */
import {
  BLEND_MODES,
  KEY_PRESETS,
  MASK_SHAPES,
  RADIUS_MAX,
  SHADOW_MAX_BLUR,
  SHADOW_MAX_OFFSET,
  SKEW_LIMIT,
  STROKE_MAX,
  readEffects
} from '../../shared/effects.js'
import { KIND_LABEL } from '../assets.js'
import {
  IconExternal,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconTrash
} from '../icons.jsx'
import { FILTERS } from '../looks.js'
import { openExternal } from '../platform.js'
import {
  PIP_ANCHORS,
  PIP_DEFAULT_ANCHOR,
  PIP_DEFAULT_SIZE,
  PIP_MAX_SIZE,
  PIP_MIN_SIZE,
  pipAnchor
} from '../pip.js'
import { TEXT_STYLES, textStyleDef } from '../textStyles.js'
import { SPEED_MAX, SPEED_MIN, clipSpeed } from '../trim.js'
import { Slider, timecode, timecodeFrames } from '../ui.jsx'

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
 * 一节：标题 + 右端「重置」。
 *
 * ⚠️ 重置按钮**只在有改动时出现**（`dirty`）—— 参考也是这么做的。
 *    常驻一个点了没反应的按钮，正是本项目里"看着有、实际没接"那一类。
 */
function Section({ title, dirty, onReset, resetHint, children, hook }) {
  return (
    <section className="wb-inspsect" data-inspsect={hook}>
      <div className="wb-inspsect-head">
        <span className="wb-inspsect-dot" />
        <b>{title}</b>
        <span className="wb-grow" />
        {dirty && onReset ? (
          <button
            type="button"
            className="wb-inspsect-reset"
            title={resetHint || `把「${title}」恢复默认`}
            data-reset={hook}
            onClick={onReset}
          >
            <IconRefresh size={13} />
          </button>
        ) : null}
      </div>
      {children}
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
function ClipInspector({ clip, totalDuration, onPatchClip, onRemoveClip, inspTab = 'info', onInspTab }) {
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
    fx.shadow.on

  /* ---------------- 音频 ---------------- */
  const gain = numOf(clip.gain, 100)
  const fadeIn = numOf(clip.fadeIn, 0)
  const fadeOut = numOf(clip.fadeOut, 0)

  /* ---------------- 变速 ---------------- */
  const speed = clipSpeed(clip)

  /* ---------------- 调整 ---------------- */
  const adjustValues = readAdjust(clip.adjust)
  const adjustDirty = ADJUST_PARAMS.some((item) => Math.abs(adjustValues[item.key]) > 0.01)
  const lookDirty = Boolean(clip.filter && clip.filter !== 'none')

  /* ---------------- 字幕 ---------------- */
  const textScale = numOf(clip.textScale, 1)
  const textColor = isHexColor(clip.textColor) ? clip.textColor : ''
  const textAnchor = ANCHORS.includes(clip.textAnchor) ? clip.textAnchor : ''
  const styleDef = textStyleDef(clip.textStyle)
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
        {active === 'visual' ? (
          <>
            <div className="wb-subpills" role="group" aria-label="画面分类">
              {[
                ['base', '基础'],
                ['key', '抠像'],
                ['mask', '蒙版'],
                ['beauty', '美颜美体']
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

            {/* ---------- 基础：圆角与变形 ---------- */}
            {visualSub === 'base' ? (
              <Section
                title="圆角与变形"
                hook="shape"
                dirty={fx.radius > 0.01 || Math.abs(fx.skewX) > 0.01 || Math.abs(fx.skewY) > 0.01}
                resetHint="恢复默认（不圆角、不斜切）"
                onReset={() => patchFx({ radius: 0, skewX: 0, skewY: 0 })}
              >
                <Slider
                  label="圆角"
                  suffix="px"
                  min={0}
                  max={RADIUS_MAX}
                  value={Math.round(fx.radius)}
                  onChange={(value) => patchFx({ radius: value })}
                />
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
                </p>
              </Section>
            ) : null}

            {/* ---------- 基础：混合模式（叠在别的画面上才有意义） ---------- */}
            {visualSub === 'base' && track === 'overlay' ? (
              <Section
                title="混合模式"
                hook="blend"
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
                <ColorField
                  label="颜色"
                  hook="stroke-color"
                  value={fx.stroke.color}
                  onChange={(value) => patchFx({ stroke: { ...fx.stroke, color: value } })}
                />
              </Section>
            ) : null}

            {/* ---------- 基础：阴影 ---------- */}
            {visualSub === 'base' ? (
              <Section
                title="阴影"
                hook="shadow"
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
                    <Slider
                      label="中心 X"
                      suffix="%"
                      min={0}
                      max={100}
                      value={Math.round(fx.mask.x)}
                      onChange={(value) => patchFx({ mask: { ...fx.mask, x: value } })}
                    />
                    <Slider
                      label="中心 Y"
                      suffix="%"
                      min={0}
                      max={100}
                      value={Math.round(fx.mask.y)}
                      onChange={(value) => patchFx({ mask: { ...fx.mask, y: value } })}
                    />
                    <Slider
                      label="宽度"
                      suffix="%"
                      min={2}
                      max={200}
                      value={Math.round(fx.mask.w)}
                      onChange={(value) => patchFx({ mask: { ...fx.mask, w: value } })}
                    />
                    {fx.mask.shape !== 'circle' ? (
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
            resetHint="恢复默认（音量 100%、无淡入淡出）"
            onReset={() => patch({ gain: 100, fadeIn: 0, fadeOut: 0 })}
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
          </Section>
        ) : null}

        {active === 'speed' ? (
          <Section
            title="变速"
            hook="speed"
            dirty={Math.abs(speed - 1) > 0.001}
            resetHint="恢复原速（1.00x，时间线占位随之还原）"
            onReset={() => patch({ speed: 1 })}
          >
            {/* ⚠️ 图片片段不给这一项：图片没有"源素材时间"这个概念（它是按时间线时长
                铺满的一段静止画面），给它一个倍速滑杆，拖了之后画面完全不变。 */}
            {clip.kind === 'image' ? (
              <p className="wb-insphint">图片片段没有源素材时间，不支持变速。</p>
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
              </>
            )}
          </Section>
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
  onInspTab
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
          />
        ) : null}

        {/* 选中素材 → 素材属性（参考的空态里没有，选中了目标才有意义） */}
        {asset ? (
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
                <IconExternal size={13} />
                在系统浏览器打开原文件
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  )
}
