'use strict'
/**
 * MCP 桥的**能力层**：把「剪辑软件的每一项功能」翻成 agent 能调用的操作。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────
 * `mcp-server.js` 只该管 JSON-RPC 与工具清单；真正的活儿全在这里。分开之后
 * 这一层可以脱离 stdio 单测（`tools/mcp-ops-selftest.mjs` 直接 require 它）。
 *
 * ── 铁律：一切写入都过 shared/*.js 的归一化函数 ──────────────────
 * 界面改一个片段走的是 `readAdjust` / `readCurves` / `readWheels` / `readBands` /
 * `readEffects` / `readCrop` / `readWarp` / `readTextAnim` 这些函数。agent 写同一个
 * 字段也必须过**同一批函数**，否则会出现「agent 写的调色在预览里不生效、成片里生效」
 * 这种只在对比时才发现的分叉。
 *
 * `normalizePatch()` 就是那道唯一入口：认识的键逐个过归一化，不认识的键直接拒绝
 * （静默丢弃是最坏的结果 —— agent 以为改了，画面上什么都没有）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const aspect = require('../shared/aspect.js')
const adjustMod = require('../shared/adjust.js')
const beautyMod = require('../shared/adjust.js')
const curves = require('../shared/curves.js')
const wheels = require('../shared/wheels.js')
const hslBands = require('../shared/hslBands.js')
const warp = require('../shared/warp.js')
const cropMod = require('../shared/crop.js')
const effects = require('../shared/effects.js')
const textAnim = require('../shared/textAnim.js')
const textOverrides = require('../shared/textOverrides.js')
const speedMod = require('../shared/speed.js')
/* 节拍检测（纯函数）：包络由 ffmpeg 抽，找重音就在这一个函数里 —— 界面与 MCP 共用 */
const beatMod = require('../shared/beat.js')
const subtitle = require('../shared/subtitle.js')
const templates = require('../shared/templates.js')
const packaging = require('../shared/packaging.js')
const compound = require('../shared/compound.js')
const layerMod = require('../shared/layers.js')
const multicam = require('../shared/multicam.js')
const region = require('../shared/region.js')
const facefx = require('../shared/facefx.js')
const scenesMod = require('../shared/scenes.js')
const exportCodec = require('../shared/exportCodec.js')
const exportRate = require('../shared/exportRate.js')
const coverMod = require('../shared/cover.js')
const audioMod = require('../shared/audio.js')
const looks = require('../shared/looks.json')
const frameEffects = require('../shared/frameEffects.json')
const textStyles = require('../shared/textStyles.json')
/* 手写字幕的字体族清单：catalog 要把它给 agent（界面「字幕 → 手写字幕」读的是同一份） */
const handFonts = require('../shared/handFonts.js')
/* 字幕预设：与界面共用同一份清单与同一个 planPreset（`add_subtitles` 的 `preset` 参数走它） */
const subtitlePresets = require('../shared/subtitlePresets.js')
const pipJson = require('../shared/pip.json')

const media = require('./media')
const stickersMod = require('./stickers')
const bordersMod = require('./borders')
const pluginsMod = require('./plugins')
/* 字体入库：与界面 `font:pick` 共用同一份复制/命名规则（`main/fonts.js`） */
const fontsMod = require('./fonts')
const renderMod = require('./render')
/* 语音识别与本地模型管理和界面**共用同一份实现**：models 是纯 Node（下载/校验/安装目录），
   speech 也只依赖 models + render 的 ffmpeg 探测。MCP 侧不另写一份，
   否则会出现「agent 认出两行、界面认出五行」这种谁也不报错的偏差。 */
const modelsMod = require('./models')
const speechMod = require('./speech')

const FILTER_KEYS = looks.filters.map((f) => f.key)
const TRANSITION_KEYS = looks.transitions.map((t) => t.key)
const FRAME_FX_KEYS = frameEffects.effects.map((f) => f.key)
const TEXT_STYLE_KEYS = textStyles.styles.map((s) => s.key)
const PIP_ANCHORS = pipJson.anchors.map((a) => a.key || a.id)
const KEYFRAME_KEYS = effects.KEYFRAME_PROPS.map((p) => p.key)
const BLEND_KEYS = effects.BLEND_MODES.map((b) => b.key)
const MASK_KEYS = effects.MASK_SHAPES.map((m) => m.key)
const CODEC_KEYS = exportCodec.CODECS.map((c) => c.key)
const RESOLUTION_KEYS = exportRate.RESOLUTIONS.map((r) => r.id)

const DEFAULT_CLIP_SECONDS = 5
const TRACKS = ['video', 'overlay', 'audio', 'text']

/** 允许 agent 直接覆盖的片段字段（每个都在 normalizePatch 里有对应归一化） */
const PATCHABLE = [
  'name', 'text', 'start', 'duration', 'offset', 'speed', 'volume', 'gain',
  'filter', 'filterIntensity', 'frameFx', 'transition', 'transitionDuration',
  'opacity', 'scale', 'posX', 'posY', 'rotate', 'fadeIn', 'fadeOut',
  'adjust', 'beauty', 'curves', 'wheels', 'hslBands', 'warp', 'crop', 'effects',
  'textStyle', 'textSize', 'textScale', 'textColor', 'textAnchor', 'textOffset',
  /* 字体：`textFont` 是预览的 CSS 家族名、`textFontPath` 是导出 drawtext 的 fontfile。
     两个必须一起写 —— 只写前者是"预览换了字体、成片还是老字体"（同理反过来）。
     界面早就能选字体（检查器 + 「字幕 → 手写字幕」），agent 此前写不了，属双通道缺口。 */
  'textFont', 'textFontPath',
  'textAnim', 'keyframes', 'pip', 'border', 'face', 'faceTrack', 'pack', 'group', 'url', 'path',
  'enabled',
  /* 导出阶段的音频 / 画面修复参数（界面上是滑杆与按钮，agent 也要能调） */
  'audioDenoise', 'voiceBoost', 'voiceFx', 'pan', 'denoise', 'stabilize'
]

function fail(msg) {
  throw new Error(msg)
}

function pickEnum(value, list, label) {
  const key = String(value == null ? '' : value).trim()
  if (!list.includes(key)) fail(`${label} 不认识「${key}」，可选：${list.join(' / ')}`)
  return key
}

function finite(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

/* ============================== 片段归一化 ============================== */

/**
 * 把 agent 给的 patch 逐键过归一化。**不认识的键直接报错**，不静默丢弃。
 * @param {object} patch
 * @param {{draft?:object}} [ctx]
 * @returns {object} 可直接合并进片段的补丁
 */
function normalizePatch(patch, ctx = {}) {
  if (!patch || typeof patch !== 'object') fail('patch 必须是对象')
  const out = {}
  const unknown = []
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue
    switch (key) {
      case 'name':
      case 'text':
        out[key] = String(raw)
        break
      case 'start':
        out.start = Math.max(0, finite(raw, 0))
        break
      case 'duration':
        out.duration = Math.max(0.05, finite(raw, DEFAULT_CLIP_SECONDS))
        break
      case 'offset':
        out.offset = Math.max(0, finite(raw, 0))
        break
      case 'speed':
        out.speed = clamp(finite(raw, 1), speedMod.SPEED_MIN, speedMod.SPEED_MAX)
        break
      case 'volume':
      case 'gain':
        out.gain = clamp(finite(raw, 100), 0, 400)
        break
      case 'opacity':
        out.opacity = clamp(finite(raw, 100), 0, 100)
        break
      case 'scale':
        out.scale = clamp(finite(raw, 100), 5, 800)
        break
      case 'posX':
        out.posX = clamp(finite(raw, 0), -adjustMod.POS_LIMIT, adjustMod.POS_LIMIT)
        break
      case 'posY':
        out.posY = clamp(finite(raw, 0), -adjustMod.POS_LIMIT, adjustMod.POS_LIMIT)
        break
      case 'rotate':
        out.rotate = clamp(finite(raw, 0), -adjustMod.ROTATE_LIMIT, adjustMod.ROTATE_LIMIT)
        break
      case 'fadeIn':
      case 'fadeOut':
        out[key] = clamp(finite(raw, 0), 0, 10)
        break
      case 'filter':
        out.filter = pickEnum(raw, FILTER_KEYS, '滤镜')
        break
      case 'filterIntensity':
        out.filterIntensity = clamp(finite(raw, 1), 0, 1)
        break
      case 'frameFx':
        out.frameFx = raw === null || raw === '' ? '' : pickEnum(raw, FRAME_FX_KEYS, '画面特效')
        break
      case 'transition':
        out.transition = pickEnum(raw, TRANSITION_KEYS, '转场')
        break
      case 'transitionDuration':
        out.transitionDuration = clamp(finite(raw, 0.5), 0.1, 5)
        break
      case 'adjust':
        out.adjust = adjustMod.readAdjust(raw)
        break
      case 'beauty':
        out.beauty = beautyMod.readBeauty(raw)
        break
      case 'curves':
        out.curves = curves.readCurves(raw)
        break
      case 'wheels':
        out.wheels = wheels.readWheels(raw)
        break
      case 'hslBands':
        out.hslBands = hslBands.readBands(raw)
        break
      case 'warp':
        out.warp = warp.readWarp(raw)
        break
      case 'crop':
        out.crop = cropMod.readCrop(raw)
        break
      case 'effects':
        out.effects = effects.readEffects(raw)
        break
      case 'textAnim': {
        /* ⚠️ 这里曾经写成 `out.textAnim = readTextAnim(raw)` —— 一个**没人读的字段**。
           消费端（Stage.jsx / subtitles.js）读的是片段上的 `textIn/textOut/textLoop/
           textInDur/textOutDur`（见 shared/textAnim.js 的 readTextAnim），
           而 `clip.textAnim` 全项目只有这一行写、没有一处读。
           于是 agent 调 `update_clip {textAnim:{in:'up'}}` 时接口返回成功、
           草稿里也多了一个对象，但预览与成片一点变化都没有 —— 典型的"接错动作"，
           两端都不报错。现在摊平成真正生效的五个键。
         ⚠️ 而且**只摊调用方真给了的键**：整体覆盖会把"只改入场"变成"顺便把循环清掉"，
           用户/agent 都看不出是哪一步动的手。 */
        const src = raw && typeof raw === 'object' ? raw : {}
        const keysOf = (list) => list.map((t) => t.key)
        if (src.in !== undefined) out.textIn = pickEnum(src.in, keysOf(textAnim.IN_TYPES), '入场动画')
        if (src.out !== undefined) out.textOut = pickEnum(src.out, keysOf(textAnim.OUT_TYPES), '出场动画')
        if (src.loop !== undefined) out.textLoop = pickEnum(src.loop, keysOf(textAnim.LOOP_TYPES), '循环动画')
        if (src.inDur !== undefined) {
          out.textInDur = clamp(finite(src.inDur, textAnim.DUR_DEFAULT), textAnim.DUR_MIN, textAnim.DUR_MAX)
        }
        if (src.outDur !== undefined) {
          out.textOutDur = clamp(finite(src.outDur, textAnim.DUR_DEFAULT), textAnim.DUR_MIN, textAnim.DUR_MAX)
        }
        break
      }
      case 'textStyle':
        out.textStyle = pickEnum(raw, TEXT_STYLE_KEYS, '文字/字幕样式')
        break
      case 'textSize':
        out.textSize = clamp(finite(raw, 32), 8, 300)
        break
      case 'textScale':
        out.textScale = clamp(finite(raw, 1), textOverrides.TEXT_SCALE_MIN, textOverrides.TEXT_SCALE_MAX)
        break
      case 'textColor': {
        if (raw !== null && raw !== '' && !textOverrides.isHexColor(raw)) fail('textColor 必须是 #RRGGBB')
        out.textColor = raw === null ? '' : String(raw)
        break
      }
      case 'textAnchor':
        out.textAnchor = pickEnum(raw, textOverrides.ANCHORS.map((a) => a.key), '文字锚点')
        break
      case 'textOffset':
        out.textOffset = clamp(finite(raw, 0), -textOverrides.TEXT_OFFSET_MAX, textOverrides.TEXT_OFFSET_MAX)
        break
      /* 字体族名：与 `shared/textOverrides.js` 的白名单同一条件。
         ⚠️ 不合规要**报错**，不能静默丢掉 —— 渲染层会忽略非法家族名，
            于是 agent 看到 ok、画面上却没换字体（最坏的那种"成功"）。 */
      case 'textFont': {
        const family = String(raw == null ? '' : raw).trim()
        if (family && !/^[\w-]{1,64}$/.test(family)) {
          fail(`textFont 只能是 ASCII 家族名（如 KaiTi / STXingkai / YJF_1a2b3c4d），收到「${family}」`)
        }
        out.textFont = family
        break
      }
      /* 字体文件：导出侧 drawtext 的 fontfile。空串 = 回到系统默认字体。
         校验扩展名 + 文件必须真实存在 —— 写一个不存在的路径不会报错，
         `subtitles.js` 会**悄悄退回系统字体**，成片里字体就变了。 */
      case 'textFontPath': {
        const file = String(raw == null ? '' : raw).trim()
        if (file) {
          if (!/\.(ttf|otf|ttc)$/i.test(file)) fail(`textFontPath 必须是 .ttf / .otf / .ttc 字体文件，收到「${file}」`)
          if (!fs.existsSync(file)) fail(`字体文件不存在：${file}（先 yijing_import_font 或换成 catalog.handFonts 里的 path）`)
        }
        out.textFontPath = file
        break
      }
      case 'keyframes': {
        const list = Array.isArray(raw) ? raw : []
        out.keyframes = list
          .filter((k) => k && KEYFRAME_KEYS.includes(String(k.prop)))
          .map((k) => ({ prop: String(k.prop), at: Math.max(0, finite(k.at, 0)), value: finite(k.value, 0) }))
        break
      }
      case 'pip': {
        const src = raw && typeof raw === 'object' ? raw : {}
        const anchor = PIP_ANCHORS.includes(String(src.anchor)) ? String(src.anchor) : pipJson.defaultAnchor
        out.pip = { anchor, size: clamp(finite(src.size, pipJson.defaultSize), pipJson.minSize, pipJson.maxSize) }
        break
      }
      case 'border':
        if (raw === null || raw === '' || raw === 'none') out.border = ''
        else out.border = String(raw)
        break
      case 'face': {
        if (raw === null) {
          out.face = null
          out.faceTrack = null
          break
        }
        const src = raw && typeof raw === 'object' ? raw : {}
        const def = facefx.fxOf(String(src.fx))
        if (!def) fail(`人物特效只有：${facefx.FX_KEYS.join(' / ')}`)
        out.face = { fx: def.key, strength: clamp(finite(src.strength, 0.6), 0, 1) }
        break
      }
      case 'faceTrack': {
        if (raw === null) {
          out.faceTrack = null
          break
        }
        const boxes = Array.isArray(raw) ? raw : []
        out.faceTrack = facefx.sampleTrack(
          boxes.map((b) => ({
            t: finite(b && (b.t ?? b.time), 0),
            box: b && b.box ? b.box : { x: finite(b && b.x, 0), y: finite(b && b.y, 0), w: finite(b && b.w, 0), h: finite(b && b.h, 0) }
          }))
        )
        if (!out.faceTrack.length) fail('faceTrack 里没有有效人脸框（宽高需 > 0.005，坐标是 0..1 的归一化值）')
        break
      }
      case 'group':
        out.group = raw === null ? '' : String(raw)
        break
      /* 「停用片段」（时间线右键 V）：字段早就存在于草稿里（片子上会显示「已停用」角标、
         导出时不出片），但之前 MCP 写不进去 —— 界面上有、agent 做不到。
         注意别和 `delete` 混：停用是可逆的，片段还在时间线上占位。 */
      case 'enabled':
        out.enabled = Boolean(raw)
        break
      /* 「导出阶段」的那批效果参数：界面上早就有滑杆与按钮，但 agent 写不进来 ——
         界面能做到、agent 做不到，就是双通道对等上的一个缺口。
         它们都只是**数字/枚举**，真正的换算在 shared/audio.js 里（与导出同一份真源），
         这里只做范围校验，不重复实现一遍。 */
      case 'audioDenoise':
      case 'voiceBoost':
        out[key] = clamp(finite(raw, 0), 0, 100)
        break
      case 'pan':
        out.pan = clamp(finite(raw, 0), -100, 100)
        break
      case 'denoise':
      case 'stabilize':
        out[key] = clamp(finite(raw, 0), 0, 100)
        break
      case 'voiceFx':
        out.voiceFx = pickEnum(raw, audioMod.VOICE_CHANGES.map((v) => v.key), '变声预设')
        break
      case 'pack':
      case 'url':
      case 'path':
        out[key] = raw
        break
      default:
        unknown.push(key)
    }
  }
  if (unknown.length) {
    fail(`这些字段不能直接改：${unknown.join(', ')}。可改：${PATCHABLE.join(', ')}`)
  }
  return out
}

/* ============================== 片段构造 ============================== */

function buildClip(input = {}, nextId) {
  const track = TRACKS.includes(input.track) ? input.track : 'video'
  const kind = input.kind || (track === 'text' ? 'text' : 'video')
  const duration = Number(input.duration)
  const clip = {
    id: input.id || nextId('clip'),
    track,
    assetId: input.assetId || '',
    name: input.name || (kind === 'text' ? '文字' : '素材'),
    url: input.url || '',
    path: input.path || '',
    kind,
    text: input.text || '',
    start: Math.max(0, Number(input.start) || 0),
    duration: Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_CLIP_SECONDS,
    offset: Math.max(0, Number(input.offset) || 0),
    sourceDuration: Number(input.sourceDuration) || 0
  }
  if (kind === 'text') {
    clip.textStyle = input.textStyle || 'sub-plain'
    clip.textSize = Number(input.textSize) || 32
  }
  if (track === 'overlay') {
    clip.pip = input.pip || { anchor: pipJson.defaultAnchor, size: pipJson.defaultSize }
  }
  return clip
}

/* ============================== 主工厂 ============================== */

/**
 * @param {{store:object, userDataDir:string, resourcesPath?:string, mainDir?:string}} deps
 */
function createOps({ store, userDataDir = '', resourcesPath = process.resourcesPath, mainDir = __dirname }) {
  let idSeq = 0
  const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++idSeq}`
  const packDeps = { resourcesPath, mainDir }
  /** 本地模型管理 / 语音识别的依赖：只认「本机安装目录」与「随包目录」两个位置 */
  const modelDeps = () => ({ userData: userDataDir, resourcesPath })

  /* ---------------------------- 草稿读写 ---------------------------- */

  function readDraft(id) {
    const record = store.load(id)
    if (!record) fail(`草稿不存在：${id}`)
    const data = record.data && typeof record.data === 'object' ? record.data : {}
    return {
      id: record.id,
      name: record.name,
      updatedAt: record.updatedAt || '',
      data: {
        ...data,
        clips: Array.isArray(data.clips) ? data.clips : [],
        assets: Array.isArray(data.assets) ? data.assets : [],
        playhead: Number(data.playhead) || 0,
        volume: Number.isFinite(Number(data.volume)) ? Number(data.volume) : 100,
        zoom: Number.isFinite(Number(data.zoom)) ? Number(data.zoom) : 1,
        aspect: aspect.normalizeAspect(data.aspect),
        createdAt: data.createdAt || record.createdAt || new Date().toISOString()
      }
    }
  }

  /**
   * 写回草稿。**保留不认识的键**（旧版本/界面写进去的 markers、range 等），
   * 只规范化 clips/assets 的容器形状 —— 白名单过滤会把界面存的东西一次性清掉。
   */
  function saveDraft(id, name, data) {
    const clean = { ...data }
    clean.clips = Array.isArray(clean.clips) ? clean.clips : []
    clean.assets = Array.isArray(clean.assets) ? clean.assets : []
    clean.aspect = aspect.normalizeAspect(clean.aspect)
    return store.save({ id, name, data: clean })
  }

  function clipIndex(draft, clipId) {
    const i = draft.data.clips.findIndex((c) => c.id === clipId)
    if (i < 0) fail(`草稿里没有这个片段：${clipId}`)
    return i
  }

  /* ---------------------------- 设置读写 ---------------------------- */

  /**
   * `userData/settings.json` —— 与界面 `settings:get/set` 同一个文件。
   *
   * ⚠️ 两个进程都会写它（界面开着时用户改设置、MCP 这边导字体）。所以**每次读最新、
   * 只改自己那一键、立刻写回**，绝不缓存整份对象 —— 缓存会让"界面刚改的硬件加速"
   * 在 agent 导一次字体之后被旧值顶掉，而且用户完全看不出是谁改的。
   */
  const settingsPath = () => path.join(userDataDir, 'settings.json')

  function readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeSettings(next) {
    const file = settingsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  }

  /* ---------------------------- 素材目录 ---------------------------- */

  function stickerCatalog() {
    const extraGroups = pluginsMod.groupsOf('sticker', { userData: userDataDir })
    return stickersMod.readCatalog({ ...packDeps, extraGroups })
  }

  function borderCatalog() {
    const extraGroups = pluginsMod.groupsOf('border', { userData: userDataDir })
    return bordersMod.readCatalog({ ...packDeps, extraGroups })
  }

  function stickerIndex() {
    const read = stickerCatalog()
    const map = new Map()
    for (const item of read.items || []) map.set(item.key, item)
    return { map, read }
  }

  function borderKeys() {
    return (borderCatalog().items || []).map((item) => item.key)
  }

  function catalog() {
    const stickerRead = stickerCatalog()
    const borderRead = borderCatalog()
    const pluginList = pluginsMod.listPlugins({ userData: userDataDir })
    return {
      tracks: TRACKS,
      aspects: aspect.ASPECT_KEYS,
      filters: looks.filters.map((f) => ({ key: f.key, label: f.label })),
      transitions: looks.transitions.map((t) => ({ key: t.key, label: t.label })),
      frameEffects: frameEffects.effects.map((f) => ({ key: f.key, label: f.label || f.name || f.key })),
      textStyles: textStyles.styles.map((s) => ({ key: s.key, label: s.label || s.name || s.key, group: s.group || '' })),
      /* 手写字体族（界面「字幕 → 手写字幕」用的同一份清单）：
         agent 拿到 family + path 就能写出一条手写字幕 —— 先 add_subtitles，
         再 update_clip 打 `textFont`/`textFontPath`（两个字段必须一起写）。 */
      handFonts: handFonts.HAND_FONTS.map((f) => ({ key: f.key, label: f.label, family: f.family, path: f.path, hint: f.hint })),
      /* 字幕预设（界面「字幕 → 字幕预设」那 857 款的同一份清单）。
         agent 不需要自己拼参数：把 key 交给 `add_subtitles` 的 `preset` 参数即可，
         落片段走的是界面同一个 planPreset。这里只给分组与 key+名字，不给整套参数 ——
         857 条全量塞进 catalog 会把上下文顶爆，而参数反正由软件自己取。 */
      subtitlePresetGroups: subtitlePresets.PRESET_GROUPS.map((g) => ({
        key: g.key,
        label: g.label,
        note: g.note,
        count: g.count
      })),
      subtitlePresets: subtitlePresets.PRESET_GROUPS.reduce((acc, g) => {
        acc[g.key] = subtitlePresets.presetsOfGroup(g.key).map((p) => ({ key: p.key, name: p.name }))
        return acc
      }, {}),
      adjustParams: adjustMod.ADJUST_PARAMS.map((p) => ({ key: p.key, label: p.label, min: p.min, max: p.max })),
      beautyParams: adjustMod.BEAUTY_PARAMS.map((p) => ({ key: p.key, label: p.label, min: p.min, max: p.max })),
      curveChannels: curves.CURVE_CHANNELS.map((c) => (typeof c === 'string' ? c : c.key)),
      hslBands: hslBands.BANDS.map((b) => (typeof b === 'string' ? b : b.key)),
      wheelStages: ['shadow', 'mid', 'high', 'global'],
      blendModes: BLEND_KEYS,
      maskShapes: MASK_KEYS,
      keyframeProps: KEYFRAME_KEYS,
      pipAnchors: PIP_ANCHORS,
      textAnchors: textOverrides.ANCHORS.map((a) => a.key),
      cropRatios: cropMod.CROP_RATIOS.map((r) => r.key),
      faceFx: facefx.FX_LIST.map((f) => ({ key: f.key, name: f.name, hint: f.hint, kind: f.kind })),
      templates: templates.TEMPLATES.map((t) => templates.templateSummary(t)),
      packagingStyles: packaging.PACK_STYLES.map((s) => ({ key: s.key, label: s.label || s.key })),
      packagingLevels: packaging.PACK_LEVELS.map((l) => ({ key: l.key, label: l.label || l.key })),
      sceneCombos: packaging.SCENE_COMBOS.map((s) => ({ key: s.key, label: s.label || s.key })),
      codecs: exportCodec.CODECS.map((c) => ({ key: c.key, label: c.label, family: c.family, ext: c.ext, alpha: c.alpha })),
      rates: exportRate.RATES.map((r) => r.id),
      resolutions: exportRate.RESOLUTIONS.map((r) => ({ id: r.id, width: r.width, height: r.height })),
      loudnessModes: audioMod.LOUDNESS_MODES.map((m) => (typeof m === 'string' ? m : m.key)),
      stickers: (stickerRead.items || []).map((i) => ({ key: i.key, name: i.name, group: i.group })),
      borders: (borderRead.items || []).map((i) => ({ key: i.key, name: i.name, group: i.group })),
      plugins: pluginList.map((p) => ({ id: p.id, name: p.name, kind: p.kind, enabled: p.enabled, images: p.images.length })),
      stickerError: stickerRead.error || '',
      borderError: borderRead.error || ''
    }
  }

  /* ---------------------------- 素材探测 ---------------------------- */

  async function probeOne(absPath) {
    const described = media.describeMedia(absPath)
    if (!described) fail(`不是可用的素材（不存在/类型不支持）：${absPath}`)
    const streams = await renderMod.probeStreams(described.path)
    return {
      ...described,
      duration: streams && Number.isFinite(streams.duration) ? streams.duration : 0,
      hasVideo: Boolean(streams && streams.hasVideo),
      hasAudio: Boolean(streams && streams.hasAudio),
      width: (streams && streams.width) || 0,
      height: (streams && streams.height) || 0,
      hdr: (streams && streams.hdr) || null
    }
  }

  function assetRecordOf(clip, asset) {
    return {
      id: clip.assetId,
      path: asset.path,
      name: asset.name,
      displayName: asset.displayName,
      ext: asset.ext,
      size: asset.size,
      mtime: asset.mtime,
      kind: asset.kind,
      url: asset.url,
      duration: asset.duration
    }
  }

  /* ============================== 操作 ============================== */

  const ops = {}

  /* ---- 目录 ---- */

  ops.catalog = () => catalog()

  /* ---- 环境 ---- */

  ops.status = () => {
    const found = renderMod.findFfmpeg()
    const stickerCount = (stickerCatalog().items || []).length
    const borderCount = (borderCatalog().items || []).length
    /* 语音识别是否可用，要在「开始干活前调一次」的那个工具里就说清楚：
       agent 不会预判"点了识别却没反应"，只有这里报了，它才会先去装模型。 */
    const speechState = speechMod.status(modelDeps())
    return {
      server: 'yijing-editor',
      version: require('../../package.json').version,
      platform: process.platform,
      userDataDir,
      draftCount: store.list().length,
      ffmpeg: found && found.ffmpeg ? found.ffmpeg : '',
      ffprobe: found && found.ffprobe ? found.ffprobe : '',
      resourcesPath,
      stickerCount,
      borderCount,
      templateCount: templates.TEMPLATES.length,
      pluginCount: pluginsMod.listPlugins({ userData: userDataDir }).length,
      codecs: CODEC_KEYS,
      speech: {
        ready: speechState.ready,
        runtime: speechState.runtime.ok ? 'ok' : speechState.runtime.error,
        defaultModel: speechState.defaultModel,
        installed: speechState.models.filter((m) => m.ready).map((m) => m.id)
      },
      ready: Boolean(found && found.ffmpeg)
    }
  }

  /* ---- 草稿 ---- */

  ops.listDrafts = () => ({ drafts: store.list() })

  ops.readDraft = ({ draftId }) => readDraft(draftId)

  ops.createDraft = ({ name, aspect: aspectKey, resolution, playhead }) => {
    const summary = store.save({
      name: name || '未命名项目',
      data: {
        clips: [],
        assets: [],
        playhead: Math.max(0, finite(playhead, 0)),
        volume: 100,
        zoom: 1,
        aspect: aspect.normalizeAspect(aspectKey),
        /* 分辨率档与比例同为草稿属性（界面上也能改）：agent 建 4K 草稿要走同一个字段，
           否则"界面能选 4K、MCP 只能建 1080P"—— 双通道不对等。 */
        resolution: exportRate.readResolution(resolution).id,
        createdAt: new Date().toISOString()
      }
    })
    return { draftId: summary.id, summary }
  }

  ops.updateDraft = ({ draftId, name, aspect: aspectKey, resolution, playhead, volume, zoom }) => {
    const draft = readDraft(draftId)
    if (aspectKey !== undefined) draft.data.aspect = aspect.normalizeAspect(aspectKey)
    if (resolution !== undefined) draft.data.resolution = exportRate.readResolution(resolution).id
    if (playhead !== undefined) draft.data.playhead = Math.max(0, finite(playhead, 0))
    if (volume !== undefined) draft.data.volume = clamp(finite(volume, 100), 0, 200)
    if (zoom !== undefined) draft.data.zoom = clamp(finite(zoom, 1), 0.1, 20)
    const summary = saveDraft(draft.id, name || draft.name, draft.data)
    return { summary }
  }

  ops.deleteDraft = ({ draftId }) => {
    const before = store.list().length
    store.remove(draftId)
    const after = store.list().length
    return { removed: draftId, count: after, changed: after < before }
  }

  ops.duplicateDraft = ({ draftId, name }) => {
    const draft = readDraft(draftId)
    const summary = store.save({
      name: name || `${draft.name} 副本`,
      data: { ...draft.data, createdAt: new Date().toISOString() }
    })
    return { draftId: summary.id, summary }
  }

  /* ---- 素材 ---- */

  ops.probeMedia = async ({ paths }) => {
    const list = Array.isArray(paths) ? paths : [paths]
    const out = []
    for (const p of list) {
      try {
        out.push(await probeOne(p))
      } catch (e) {
        out.push({ path: p, error: String((e && e.message) || e) })
      }
    }
    return { media: out }
  }

  /**
   * 只把素材放进素材库，不落轨（界面上「导入素材」那一步）。
   * 落轨是另一个动作 —— 两件事混在一起，agent 想先看素材信息就必须先污染时间线。
   */
  ops.importMedia = async ({ draftId, paths = [] }) => {
    const draft = readDraft(draftId)
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean)
    const probed = []
    for (const p of list) probed.push(await probeOne(p))
    const added = []
    for (const asset of probed) {
      const exists = draft.data.assets.find((a) => a.path === asset.path)
      if (exists) {
        added.push({ assetId: exists.id, name: exists.displayName, kind: exists.kind, duration: exists.duration, path: exists.path, existed: true })
        continue
      }
      const assetId = `a_${Buffer.from(asset.path).toString('base64url').slice(0, 12)}`
      draft.data.assets.push({
        id: assetId,
        path: asset.path,
        name: asset.name,
        displayName: asset.displayName,
        ext: asset.ext,
        size: asset.size,
        mtime: asset.mtime,
        kind: asset.kind,
        url: asset.url,
        duration: asset.duration
      })
      added.push({ assetId, name: asset.displayName, kind: asset.kind, duration: asset.duration, path: asset.path, existed: false })
    }
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return { summary, added, total: draft.data.assets.length }
  }

  /**
   * 删除素材（界面上是左栏每条素材右侧的垃圾桶）。
   *
   * 语义与界面 `App.removeAsset` **一致**：摘掉素材，并**连带删掉所有引用它的片段**。
   * 只删素材不删片段，草稿里就留下"片段还在、源文件没了"的行 —— 预览黑屏、
   * 导出时那一整条链才报错，而且错误信息指向 ffmpeg 而不是"你删过素材"。
   *
   * 不删磁盘上的原文件：素材是用户自己的文件，界面上也从不删它。
   */
  ops.removeMedia = ({ draftId, assetId, assetIds = [] }) => {
    const draft = readDraft(draftId)
    const want = new Set(
      [assetId, ...(Array.isArray(assetIds) ? assetIds : [assetIds])]
        .filter(Boolean)
        .map((item) => String(item))
    )
    if (!want.size) fail('要删哪个素材？给 assetId（取自 yijing_read_draft 的 assets）')

    const known = new Set(draft.data.assets.map((item) => String(item.id)))
    const notFound = [...want].filter((id) => !known.has(id))
    if (notFound.length === want.size) fail(`草稿里没有这些素材：${notFound.join(', ')}`)

    const beforeAssets = draft.data.assets.length
    const beforeClips = draft.data.clips.length
    draft.data.assets = draft.data.assets.filter((item) => !want.has(String(item.id)))
    /* 片段靠 assetId 指回素材；比的是字符串，别拿对象引用 */
    draft.data.clips = draft.data.clips.filter((clip) => !want.has(String(clip.assetId || '')))
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return {
      summary,
      removedAssets: beforeAssets - draft.data.assets.length,
      removedClips: beforeClips - draft.data.clips.length,
      notFound,
      assets: draft.data.assets.length,
      clips: draft.data.clips.length
    }
  }

  /**
   * 导入字体（界面上是文字面板的「导入字体」按钮）。
   *
   * 两件事必须一起做，否则"导进去了但用不上"：
   *   ① 文件复制进 `userData/fonts/`（`main/fonts.js`，与界面同一份实现）；
   *   ② 记进 `settings.json` 的 `fonts` —— 界面启动时就是照这份列表注册 @font-face 的。
   * 只做 ① 的话，agent 导的字体在界面上永远不出现；只做 ② 的话，重启就坏。
   */
  ops.importFont = ({ paths = [] }) => {
    const list = (Array.isArray(paths) ? paths : [paths]).map((item) => String(item || '')).filter(Boolean)
    if (!list.length) fail('要导入哪个字体？给 paths（.ttf / .otf / .ttc 的绝对路径）')

    const imported = []
    const rejected = []
    for (const source of list) {
      const font = fontsMod.importFontFile({ sourcePath: source, userDataDir })
      if (font) imported.push({ id: font.id, name: font.name, path: font.path, bytes: font.bytes })
      else rejected.push(source)
    }
    if (!imported.length) fail(`一个都没导进来（扩展名只认 .ttf / .otf / .ttc）：${rejected.join(', ')}`)

    /* 与界面 `importFonts` 同一套合并规则：按 id 去重，后来的覆盖同 id 的旧条目 */
    const settings = readSettings()
    const merged = Array.isArray(settings.fonts) ? [...settings.fonts] : []
    for (const font of imported) {
      const hit = merged.findIndex((item) => item && item.id === font.id)
      if (hit >= 0) merged[hit] = font
      else merged.push(font)
    }
    writeSettings({ ...settings, fonts: merged })

    return { imported, rejected, total: merged.length, dir: fontsMod.fontsDirOf(userDataDir) }
  }

  /** 已入库字体（磁盘为准，不回读设置 —— 设置里可能留着已被删掉的条目） */
  ops.listFonts = () => {
    const fonts = fontsMod.listFonts({ userDataDir })
    return { fonts, total: fonts.length, dir: fontsMod.fontsDirOf(userDataDir) }
  }

  /* ---- 片段 ---- */

  ops.addClips = async ({ draftId, clips = [], name }) => {
    const draft = readDraft(draftId)
    const created = []
    for (const spec of Array.isArray(clips) ? clips : []) {
      let asset = null
      if (spec.path) asset = await probeOne(spec.path)
      const track = TRACKS.includes(spec.track)
        ? spec.track
        : asset
          ? asset.kind === 'audio'
            ? 'audio'
            : 'video'
          : 'video'
      const clip = buildClip(
        {
          ...spec,
          track,
          kind: spec.kind || (asset ? asset.kind : 'video'),
          name: spec.name || (asset ? asset.displayName : '素材'),
          url: spec.url || (asset ? asset.url : ''),
          path: asset ? asset.path : spec.path || '',
          assetId: spec.assetId || (asset ? `a_${Buffer.from(asset.path).toString('base64url').slice(0, 12)}` : ''),
          duration: spec.duration != null ? spec.duration : asset ? asset.duration : undefined,
          sourceDuration: spec.sourceDuration != null ? spec.sourceDuration : asset ? asset.duration : 0
        },
        nextId
      )
      if (spec.patch) Object.assign(clip, normalizePatch(spec.patch))
      created.push(clip)
      draft.data.clips.push(clip)
      if (asset && !draft.data.assets.some((a) => a.path === asset.path)) {
        draft.data.assets.push(assetRecordOf(clip, asset))
      }
    }
    const summary = saveDraft(draft.id, name || draft.name, draft.data)
    return {
      summary,
      added: created.map((c) => ({ id: c.id, name: c.name, track: c.track, start: c.start, duration: c.duration, kind: c.kind }))
    }
  }

  /**
   * 加字幕。`subtitles` 可以直接给条目，也可以给 `file`（SRT/VTT/LRC/ASS）
   * 或 `text` 内容 —— 走的是界面导入字幕同一份解析器（shared/subtitle.js）。
   */
  ops.addSubtitles = ({ draftId, subtitles = [], file, content, filename, offset, style, name, preset }) => {
    const draft = readDraft(draftId)
    const shift = finite(offset, 0)

    /* 走「字幕预设」这一支：与界面点一张卡**同一条路径**（都调 planPreset），
       所以 agent 落下的片段和用户手点出来的逐字段相同 —— 落点、动效、多行、
       多条错峰全都在 planPreset 里，不在这里重写一遍。
       起点 = 字幕轨末尾 + offset：界面是"从播放头往后找空位"，MCP 没有播放头，
       往后追加是唯一不会盖住已有字幕的选择。 */
    if (preset) {
      const presetKey = String(preset).trim()
      const def = subtitlePresets.presetByKey(presetKey)
      if (!def) fail(`字幕预设不存在：${presetKey}（yijing_catalog 的 subtitlePresets 里有全部 key）`)
      const laneEnd = draft.data.clips
        .filter((c) => c && c.track === 'text')
        .reduce((m, c) => Math.max(m, (Number(c.start) || 0) + (Number(c.duration) || 0)), 0)
      const planned = subtitlePresets.planPreset(def, {
        start: Math.max(0, laneEnd + shift),
        idFor: () => nextId('clip')
      })
      if (!planned.clips.length) fail(`字幕预设「${def.name}」没有生成任何片段`)
      for (const clip of planned.clips) draft.data.clips.push(clip)
      const summary = saveDraft(draft.id, name || draft.name, draft.data)
      return {
        summary,
        preset: { key: def.key, name: def.name, hint: subtitlePresets.describePreset(def) },
        added: planned.clips.length,
        first: planned.clips.slice(0, 3).map((c) => ({ id: c.id, text: c.text, start: c.start, duration: c.duration }))
      }
    }

    let cues = []
    if (file || content) {
      const raw = file ? fs.readFileSync(file) : Buffer.from(String(content || ''), 'utf8')
      const text = subtitle.decodeTextBuffer(raw)
      const parsed = subtitle.readSubtitles(text, filename || file || 'a.srt')
      if (!parsed.ok) fail(`字幕解析失败：${parsed.error || '未知原因'}`)
      cues = parsed.cues
    } else {
      cues = (Array.isArray(subtitles) ? subtitles : []).map((s) => ({
        start: finite(s.start, 0),
        end: finite(s.start, 0) + (s.duration != null ? finite(s.duration, 3) : 3),
        text: String(s.text || '')
      }))
    }
    const created = []
    for (const cue of cues) {
      if (!cue.text) continue
      const clip = buildClip(
        {
          track: 'text',
          kind: 'text',
          text: cue.text,
          textStyle: style || 'sub-plain',
          textSize: 32,
          start: Math.max(0, cue.start + shift),
          duration: Math.max(0.1, cue.end - cue.start),
          name: cue.text.slice(0, 12)
        },
        nextId
      )
      created.push(clip)
      draft.data.clips.push(clip)
    }
    const summary = saveDraft(draft.id, name || draft.name, draft.data)
    return { summary, added: created.length, first: created.slice(0, 3).map((c) => ({ id: c.id, text: c.text, start: c.start })) }
  }

  ops.updateClip = ({ draftId, clipId, patch = {}, name }) => {
    const draft = readDraft(draftId)
    const i = clipIndex(draft, clipId)
    const clean = normalizePatch(patch)
    if (clean.border) {
      const keys = borderKeys()
      if (keys.length && !keys.includes(clean.border)) {
        fail(`边框 key 不认识「${clean.border}」，用 yijing_catalog 看 borders 列表`)
      }
    }
    draft.data.clips[i] = { ...draft.data.clips[i], ...clean }
    const summary = saveDraft(draft.id, name || draft.name, draft.data)
    return { summary, clip: draft.data.clips[i] }
  }

  ops.deleteClips = ({ draftId, clipIds = [] }) => {
    const draft = readDraft(draftId)
    const want = new Set((Array.isArray(clipIds) ? clipIds : [clipIds]).filter(Boolean))
    const before = draft.data.clips.length
    draft.data.clips = draft.data.clips.filter((c) => !want.has(c.id))
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return { summary, removed: before - draft.data.clips.length }
  }

  /**
   * 时间线操作。一个入口多种 op —— 它们都在同一份片段表上做几何/结构变换，
   * 分开成十个工具只会让 agent 多记十个名字，能力并没有变多。
   */
  ops.timelineOp = ({ draftId, op, clipId, clipIds = [], to, at, from, name, mode }) => {
    const draft = readDraft(draftId)
    const clips = draft.data.clips
    const opKey = String(op || '')

    if (opKey === 'move') {
      const i = clipIndex(draft, clipId)
      const clip = { ...clips[i] }
      if (to && typeof to === 'object') {
        if (to.track) clip.track = pickEnum(to.track, TRACKS, '轨道')
        if (to.start !== undefined) clip.start = Math.max(0, finite(to.start, clip.start))
      }
      if (at !== undefined) clip.start = Math.max(0, finite(at, clip.start))
      clips[i] = clip
      return { summary: saveDraft(draft.id, draft.name, draft.data), clip }
    }

    if (opKey === 'split') {
      const i = clipIndex(draft, clipId)
      const clip = clips[i]
      const cut = finite(at, NaN)
      if (!Number.isFinite(cut)) fail('split 需要 at（时间线秒数）')
      const start = Number(clip.start) || 0
      const end = start + (Number(clip.duration) || 0)
      if (!(cut > start + 1e-3 && cut < end - 1e-3)) fail(`切点 ${cut} 不在片段 ${start}~${end} 之内`)
      /* sliceClip 不负责发号：左半沿用原 id，右半必须换新 id ——
         同 id 的两段在选中/删除时会一起命中 */
      const left = { ...region.sliceClip(clip, start, cut), id: clip.id }
      const right = { ...region.sliceClip(clip, cut, end), id: nextId('clip') }
      clips.splice(i, 1, left, right)
      return { summary: saveDraft(draft.id, draft.name, draft.data), left: left.id, right: right.id }
    }

    if (opKey === 'trim') {
      const i = clipIndex(draft, clipId)
      const clip = { ...clips[i] }
      if (from !== undefined) {
        /* 掐头：起点后移、源入点后移、时长缩短 —— 三者必须一起动 */
        const delta = Math.max(0, finite(from, 0) - (Number(clip.start) || 0))
        clip.start = (Number(clip.start) || 0) + delta
        clip.offset = (Number(clip.offset) || 0) + delta
        clip.duration = Math.max(0.05, (Number(clip.duration) || 0) - delta)
      }
      if (to !== undefined) {
        const stop = finite(to, NaN)
        if (Number.isFinite(stop)) clip.duration = Math.max(0.05, stop - (Number(clip.start) || 0))
      }
      clips[i] = clip
      return { summary: saveDraft(draft.id, draft.name, draft.data), clip }
    }

    if (opKey === 'duplicate') {
      const ids = (Array.isArray(clipIds) && clipIds.length ? clipIds : [clipId]).filter(Boolean)
      const copies = []
      for (const id of ids) {
        const i = clipIndex(draft, id)
        const copy = { ...clips[i], id: nextId('clip') }
        delete copy.group
        copy.start = (Number(clip.start) || 0) + (Number(clips[i].duration) || 0)
        copies.push(copy)
        clips.push(copy)
      }
      return { summary: saveDraft(draft.id, draft.name, draft.data), copies: copies.map((c) => c.id) }
    }

    if (opKey === 'group' || opKey === 'ungroup') {
      const ids = (Array.isArray(clipIds) && clipIds.length ? clipIds : [clipId]).filter(Boolean)
      if (opKey === 'group') {
        if (ids.length < 2) fail('组合至少要两个片段')
        const tag = name || `g_${Date.now().toString(36)}`
        draft.data.clips = clips.map((c) => (ids.includes(c.id) ? { ...c, group: tag } : c))
        return { summary: saveDraft(draft.id, draft.name, draft.data), group: tag, count: ids.length }
      }
      let count = 0
      draft.data.clips = clips.map((c) => {
        if (!ids.includes(c.id) || !c.group) return c
        const copy = { ...c }
        delete copy.group
        count += 1
        return copy
      })
      return { summary: saveDraft(draft.id, draft.name, draft.data), count }
    }

    if (opKey === 'compound') {
      const ids = (Array.isArray(clipIds) && clipIds.length ? clipIds : [clipId]).filter(Boolean)
      const made = compound.makeCompound(clips, ids, { id: nextId('clip'), name })
      if (!made) fail('这些片段拼不成复合片段（空片段或时长无效）')
      draft.data.clips = [...made.rest, made.clip]
      return { summary: saveDraft(draft.id, draft.name, draft.data), clip: { id: made.clip.id, start: made.clip.start, duration: made.clip.duration }, children: ids.length }
    }

    if (opKey === 'expand') {
      const i = clipIndex(draft, clipId)
      const clip = clips[i]
      if (!compound.isCompound(clip)) fail('这不是复合片段')
      const kids = compound.ungroupCompound(clip, () => nextId('clip'))
      clips.splice(i, 1, ...kids)
      return { summary: saveDraft(draft.id, draft.name, draft.data), expanded: kids.length }
    }

    if (opKey === 'multicam') {
      const ids = (Array.isArray(clipIds) && clipIds.length ? clipIds : [clipId]).filter(Boolean)
      const made = multicam.makeMulticam(clips, ids, { id: nextId('clip'), name })
      if (!made) fail('这些片段做不成多机位（需要至少两段有画面的片段且时间有重叠）')
      draft.data.clips = [...made.rest, made.clip]
      return { summary: saveDraft(draft.id, draft.name, draft.data), clip: { id: made.clip.id, angles: made.clip.multicam.angles.length, duration: made.clip.duration } }
    }

    if (opKey === 'cut') {
      const i = clipIndex(draft, clipId)
      const clip = clips[i]
      if (!multicam.isMulticam(clip)) fail('这不是多机位片段')
      const patch = multicam.setCut(clip, finite(at, 0), finite(from, 0))
      if (!patch) fail('切机位失败')
      clips[i] = { ...clip, ...patch }
      return { summary: saveDraft(draft.id, draft.name, draft.data), cuts: clips[i].multicam.cuts.length }
    }

    if (opKey === 'region-copy') {
      const span = { start: finite(from, 0), end: finite(to, finite(from, 0) + 1) }
      const copied = region.copyRegion(clips, span)
      return { picked: copied.items.length, span: copied.span, items: copied.items.map((c) => ({ track: c.track, start: c.start, duration: c.duration })) }
    }

    if (opKey === 'region-paste') {
      const span = { start: finite(from, 0), end: finite(to, finite(from, 0) + 1) }
      const copied = region.copyRegion(clips, span)
      if (!copied.items.length) fail('这个区间里没有内容')
      const pasted = region.pasteRegion(copied.items, finite(at, 0), () => nextId('clip'))
      draft.data.clips.push(...pasted)
      return { summary: saveDraft(draft.id, draft.name, draft.data), pasted: pasted.length }
    }

    if (opKey === 'region-delete') {
      const span = { start: finite(from, 0), end: finite(to, finite(from, 0) + 1) }
      const left = region.removeRegion(clips, span, { ripple: mode !== 'gap' })
      draft.data.clips = left
      return { summary: saveDraft(draft.id, draft.name, draft.data), remaining: left.length }
    }

    if (opKey === 'region-trim') {
      const span = { start: finite(from, 0), end: finite(to, finite(from, 0) + 1) }
      const left = region.trimToRegion(clips, span)
      draft.data.clips = left
      return { summary: saveDraft(draft.id, draft.name, draft.data), remaining: left.length, span }
    }

    if (opKey === 'reorder') {
      const i = clipIndex(draft, clipId)
      const clip = clips[i]
      const target = finite(at, 0)
      clip.start = Math.max(0, target)
      return { summary: saveDraft(draft.id, draft.name, draft.data), clip }
    }

    /* 「上移一层 / 下移一层」（叠加轨的画中画层叠顺序）。
       ⚠️ 走界面同一个 `shared/layers.js:moveLayer` —— 它返回的是**整轨重排后的补丁数组**，
       不是"把这一段的 z 加一"。自己改单个 z 会造成两段 z 相同，
       预览按 DOM、导出按 overlay 链，两边排序不一致就出现「预览谁在上面、成片反过来」。 */
    if (opKey === 'layer') {
      const dir = name === 'down' || to === -1 || to === 'down' ? -1 : 1
      const patches = layerMod.moveLayer(clips, clipId, dir)
      if (!patches.length) fail(`片段 ${clipId} 已经在${dir > 0 ? '最上' : '最下'}层，或不在叠加轨上`)
      for (const p of patches) {
        const i = clips.findIndex((c) => c && c.id === p.id)
        if (i >= 0) clips[i] = { ...clips[i], z: p.z }
      }
      return { summary: saveDraft(draft.id, draft.name, draft.data), moved: dir > 0 ? 'up' : 'down', changed: patches.length }
    }

    fail(`不支持的 op：${opKey}（move/split/trim/duplicate/group/ungroup/compound/expand/multicam/cut/region-copy/region-delete/region-trim/reorder）`)
  }

  /* ---- 素材库能力 ---- */

  ops.listMaterials = ({ kind }) => {
    const want = String(kind || 'all')
    if (want === 'sticker' || want === 'all') {
      const read = stickerCatalog()
      return { kind: want, stickers: read.items || [], borders: want === 'all' ? undefined : [], error: read.error || '' }
    }
    const read = borderCatalog()
    return { kind: want, borders: read.items || [], error: read.error || '' }
  }

  ops.addSticker = ({ draftId, stickerKeys = [], start, duration = 4, anchor, size, name }) => {
    const draft = readDraft(draftId)
    const index = stickerIndex()
    if (index.read.error) fail(`贴纸库读不了：${index.read.error}`)
    const added = []
    let seq = 0
    for (const key of Array.isArray(stickerKeys) ? stickerKeys : [stickerKeys]) {
      const hit = index.map.get(String(key))
      if (!hit) fail(`没有这枚贴纸：${key}`)
      const clip = buildClip(
        {
          track: 'overlay',
          kind: 'image',
          name: hit.name || '贴纸',
          url: hit.url,
          path: hit.abs || '',
          start: finite(start, 0) + seq * 0.1,
          duration,
          pip: { anchor: anchor || pipJson.defaultAnchor, size: size || pipJson.defaultSize }
        },
        nextId
      )
      seq += 1
      added.push(clip)
      draft.data.clips.push(clip)
    }
    const summary = saveDraft(draft.id, name || draft.name, draft.data)
    return { summary, added: added.map((c) => ({ id: c.id, name: c.name, start: c.start, duration: c.duration })) }
  }

  ops.setBorder = ({ draftId, clipId, border, clipIds }) => {
    const draft = readDraft(draftId)
    const ids = (Array.isArray(clipIds) && clipIds.length ? clipIds : [clipId]).filter(Boolean)
    if (!ids.length) fail('要给 clipId 或 clipIds')
    const value = border === null || border === '' || border === 'none' ? '' : String(border)
    if (value) {
      const keys = borderKeys()
      if (!keys.length) fail('边框库读不了（安装目录里缺 resources/borders）')
      if (!keys.includes(value)) fail(`没有这款边框：${value}`)
    }
    let count = 0
    draft.data.clips = draft.data.clips.map((c) => {
      if (!ids.includes(c.id)) return c
      count += 1
      const next = { ...c }
      if (value) next.border = value
      else delete next.border
      return next
    })
    if (!count) fail('这些片段都不在草稿里')
    return { summary: saveDraft(draft.id, draft.name, draft.data), border: value, count }
  }

  ops.applyTemplate = ({ draftId, templateKey, start, titleText }) => {
    const tpl = templates.templateOf(String(templateKey))
    if (!tpl) fail(`没有这套模板：${templateKey}`)
    const draft = readDraft(draftId)
    const index = stickerIndex()
    const planned = templates.planTemplate(tpl, {
      start: Math.max(0, finite(start, 0)),
      idFor: () => nextId('clip'),
      resolveSticker: (key) => {
        const hit = index.map.get(key)
        return hit ? { name: hit.name, url: hit.url } : null
      },
      titleText: String(titleText || draft.name || '')
    })
    if (!planned.clips.length) fail('这套模板一条片段都没落地（内置素材缺失？）')
    for (const clip of planned.clips) {
      if (clip.track === 'overlay' || clip.kind === 'image') {
        const hit = clip.stickerKey ? index.map.get(clip.stickerKey) : null
        if (hit && hit.abs && !clip.path) clip.path = hit.abs
      }
      draft.data.clips.push(clip)
    }
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return { summary, added: planned.clips.length, ids: planned.clips.map((c) => c.id), summaryText: planned.summary || '' }
  }

  ops.applyPackaging = ({ draftId, style = 'web-yellow', level = 'normal', mode = 'line', combo }) => {
    const draft = readDraft(draftId)
    if (String(mode) === 'scene') {
      const plan = packaging.planScene(draft.data.clips, { combo: combo || style })
      if (!plan.patches.length) fail('主轨还没有画面片段')
      const byId = new Map(plan.patches.map((p) => [p.id, p.patch]))
      draft.data.clips = draft.data.clips.map((c) => (byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c))
      const summary = saveDraft(draft.id, draft.name, draft.data)
      return { summary, patched: plan.patches.length, stickers: 0 }
    }
    if (String(mode) === 'strip') {
      const plan = packaging.planStrip(draft.data.clips, level)
      const byId = new Map(plan.patches.map((p) => [p.id, p]))
      const drop = new Set(plan.remove || [])
      draft.data.clips = draft.data.clips
        .filter((c) => !drop.has(c.id))
        .map((c) => (byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c))
      const summary = saveDraft(draft.id, draft.name, draft.data)
      return { summary, patched: plan.patches.length, removed: drop.size }
    }
    const plan = packaging.planPackaging(draft.data.clips, {
      style: pickEnum(style, packaging.PACK_STYLES.map((s) => s.key), '包装风格'),
      level: pickEnum(level, packaging.PACK_LEVELS.map((l) => l.key), '包装档位')
    })
    if (!plan.patches.length) fail('字幕轨上还没有字幕，先加字幕再套包装')
    const byId = new Map(plan.patches.map((p) => [p.id, p.patch]))
    draft.data.clips = draft.data.clips.map((c) => (byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c))
    const index = stickerIndex()
    let stickerCount = 0
    for (const spec of plan.stickers || []) {
      const hit = index.map.get(spec.key)
      if (!hit) continue
      draft.data.clips.push({
        id: nextId('clip'),
        track: 'overlay',
        assetId: '',
        name: hit.name || '贴纸',
        url: hit.url,
        path: hit.abs || '',
        kind: 'image',
        text: '',
        start: spec.at,
        duration: spec.duration,
        offset: 0,
        sourceDuration: 0,
        pip: { anchor: spec.anchor, size: spec.size },
        pack: { auto: true, mode: 'line', forClip: spec.forClip }
      })
      stickerCount += 1
    }
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return { summary, patched: plan.patches.length, stickers: stickerCount, summaryText: plan.summary || '' }
  }

  /**
   * 人物特效：几何轨（faceTrack）与被套的效果（face）分开写 ——
   * 这样 agent 换一款特效不用重新检测，检测一次可以复用。
   * 检测本身要 MediaPipe + 逐帧 seek，只能在渲染层跑；这里接受 agent 自己
   * 给的人脸框（它的视觉模型完全能给），或者复用片段上已有的 track。
   */
  ops.applyFaceFx = ({ draftId, clipId, fx, strength, track, boxes }) => {
    const draft = readDraft(draftId)
    const i = clipIndex(draft, clipId)
    const clip = { ...draft.data.clips[i] }
    if (fx === null || fx === 'none' || fx === '') {
      delete clip.face
      delete clip.faceTrack
      draft.data.clips[i] = clip
      return { summary: saveDraft(draft.id, draft.name, draft.data), cleared: true }
    }
    const def = facefx.fxOf(String(fx))
    if (!def) fail(`人物特效只有：${facefx.FX_KEYS.join(' / ')}`)
    let nextTrack = null
    if (Array.isArray(track) && track.length) {
      nextTrack = facefx.sampleTrack(track.map((b) => ({ t: finite(b && (b.t ?? b[0]), 0), box: b && b.box ? b.box : { x: finite(b && b.x, 0), y: finite(b && b.y, 0), w: finite(b && b.w, 0), h: finite(b && b.h, 0) } })))
    } else if (Array.isArray(boxes) && boxes.length) {
      nextTrack = facefx.sampleTrack(boxes.map((b) => ({ t: finite(b && (b.t ?? b.time), 0), box: { x: finite(b && b.x, 0), y: finite(b && b.y, 0), w: finite(b && b.w, 0), h: finite(b && b.h, 0) } })))
    } else if (Array.isArray(clip.faceTrack) && clip.faceTrack.length) {
      nextTrack = clip.faceTrack
    }
    if (!nextTrack || !nextTrack.length) {
      fail('缺少人脸轨：要么给 boxes（[{t,x,y,w,h}] 归一化坐标），要么片段上已经有 faceTrack（先在界面里识别一次）')
    }
    clip.face = { fx: def.key, strength: clamp(finite(strength, 0.6), 0, 1) }
    clip.faceTrack = nextTrack
    draft.data.clips[i] = clip
    return { summary: saveDraft(draft.id, draft.name, draft.data), fx: clip.face.fx, points: nextTrack.length }
  }

  ops.plugins = (args = {}) => {
    const deps = { userData: userDataDir }
    const act = String(args.action || 'list')
    if (act === 'list') return { plugins: pluginsMod.listPlugins(deps) }
    if (act === 'install') {
      if (!args.dir) fail('install 需要 dir（素材包目录的绝对路径）')
      const res = pluginsMod.install(args.dir, deps)
      if (!res || res.ok === false) fail((res && res.error) || '安装失败')
      return { installed: (res && (res.id || res.plugin)) || '', plugins: pluginsMod.listPlugins(deps) }
    }
    if (act === 'enable' || act === 'disable') {
      const res = pluginsMod.setEnabled(args.id, act === 'enable', deps)
      if (!res || res.ok === false) fail((res && res.error) || '设置失败')
      return { plugins: pluginsMod.listPlugins(deps) }
    }
    if (act === 'remove') {
      /* 删除走回收站（主进程侧注入）；MCP 跑在纯 node 里，没有 shell.trashItem 时明确拒绝，
         而不是直接 rm —— 素材包是用户自己放进来的东西，不该被不可逆地删掉 */
      fail('删除插件需要在界面里操作（走回收站）；MCP 端只支持 list/install/enable/disable')
    }
    fail(`不支持的插件动作：${act}（list/install/enable/disable）`)
  }

  /* ---- 场景切分 ---- */

  ops.splitByScenes = async ({ draftId, clipId, threshold = 0.35 }) => {
    const draft = readDraft(draftId)
    const i = clipIndex(draft, clipId)
    const clip = draft.data.clips[i]
    const source = clip.path || media.normalizeMediaPath(clip.url)
    if (!source) fail('这个片段没有可解码的源文件')
    const hits = await detectScenesOf(source, clip, threshold)
    const points = scenesMod.timelineCuts(clip, hits)
    const pieces = scenesMod.splitByScenes(clip, points, () => nextId('clip'))
    draft.data.clips.splice(i, 1, ...pieces)
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return { summary, cuts: points.length, pieces: pieces.length, ids: pieces.map((p) => p.id) }
  }

  /** 用 ffmpeg 的 scene 分数找切点（源秒数，不含片段起点） */
  async function detectScenesOf(source, clip, threshold) {
    const found = renderMod.findFfmpeg()
    if (!found || !found.ffmpeg) fail('找不到 ffmpeg，无法检测场景')
    const start = Number(clip.offset) || 0
    const dur = Number(clip.duration) || 0
    const args = ['-hide_banner', '-nostats']
    if (start > 0) args.push('-ss', String(start))
    if (dur > 0) args.push('-t', String(dur))
    args.push('-i', source, '-filter:v', `select='gt(scene,${clamp(finite(threshold, 0.35), 0.05, 0.95)})'`, '-f', 'null', '-')
    const text = await new Promise((resolve) => {
      let buf = ''
      let err = ''
      const proc = spawn(found.ffmpeg, args, { windowsHide: true })
      proc.stderr.on('data', (c) => {
        err += c.toString('utf8')
      })
      proc.stdout.on('data', (c) => {
        buf += c.toString('utf8')
      })
      proc.on('error', () => resolve(''))
      proc.on('close', () => resolve(err || buf))
    })
    const out = []
    const re = /pts_time:([0-9.]+)/g
    let m = re.exec(text)
    while (m) {
      out.push({ at: Number(m[1]) })
      m = re.exec(text)
    }
    return out
  }

  /* ---- 本地模型（语音识别 / 人物特效的运行时与权重） ---- */

  /** 模型表：**和设置页同一张**（group / kind / 缺哪些文件 都照原样给） */
  function modelRows() {
    return modelsMod.list(modelDeps()).map((row) => ({
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      license: row.license,
      group: row.group,
      kind: row.kind,
      source: row.source,
      ready: row.source !== 'missing',
      missing: row.missing,
      size: row.size,
      downloadable: row.downloadable
    }))
  }

  /**
   * 本地模型管理：查 / 装。
   *
   * ⚠️ 只做 list 与 download，**不做 remove**：删模型走界面（和插件同一个理由），
   *    agent 没有"用户想把这块空间要回来"这个上下文，一删就是几十上百 MB 重下。
   *
   * ⚠️ 下载是**同步等待**的（78MB 约 1 分钟、239MB 约 3 分钟）：调用期间别重试，
   *    重进会撞上 `.part` 半成品 —— 虽然体积校验能兜住，但白白多下一遍。
   */
  ops.models = async ({ action = 'list', id } = {}) => {
    const act = String(action || 'list')
    if (act === 'list') {
      const rows = modelRows()
      return {
        models: rows,
        ready: rows.filter((r) => r.ready).map((r) => r.id),
        /* 直接给出"要装哪两个才能用语音转字幕"，省得 agent 自己推 */
        speechPlan: ['speech-runtime', 'speech-paraformer']
      }
    }
    if (act === 'download') {
      const wanted = String(id || '').trim()
      if (!wanted) fail('download 需要 id：先 action=list 看能装哪些')
      const entry = modelsMod.byId(wanted)
      if (!entry) fail(`没有这个模型：${wanted}`)
      if (!entry.files.every((item) => Boolean(item.url))) fail(`${entry.name} 没有下载地址，只能从本机文件导入`)
      const before = modelsMod.stateOf(entry, modelDeps())
      if (before.source === 'local') return { id: wanted, installed: true, source: 'local', skipped: true }
      const stamp = Date.now()
      await modelsMod.download(entry, modelDeps(), () => {})
      /* 下载完必须清一次识别器缓存：否则同一个进程里换了权重还在用老的（界面上是同一个坑） */
      speechMod.resetCache()
      const after = modelsMod.stateOf(entry, modelDeps())
      if (after.source === 'missing') fail(`${entry.name} 装完仍然不完整，缺：${(after.missing || []).join(' / ')}`)
      return { id: wanted, installed: true, source: after.source, elapsed: Date.now() - stamp, models: modelRows() }
    }
    fail(`不支持的模型动作：${act}（list / download）`)
  }

  /* ---- 配音（文字 → 人声，本机合成） ---- */

  /**
   * 把一段文字读成人声，落成音频片段。
   *
   * ⚠️ 与 `recognizeSubtitles` 是**反方向**的两件事：那边声音→文字，这边文字→声音。
   *    共用同一个运行时，但用不同的模型文件（`kind` 分别是 model / voice）。
   *
   * ⚠️ 合成是同步阻塞的（一句话内部的音节是连续的，切不开）。500 字约 1~2 秒，
   *    所以这里不加进度，直接把结果一次性返回。
   */
  ops.tts = async ({ draftId, text, voiceId, speed, sid, start, apply = true, name } = {}) => {
    const body = String(text || '').trim()
    if (!body) fail('text 是空的：要读什么？')
    const deps = modelDeps()
    const state = speechMod.voiceStatus(deps)
    if (!state.runtime.ok) fail(`语音运行时还没装：${state.runtime.error}。先调 yijing_models（action=download, id=speech-runtime）`)
    const voice = String(voiceId || '').trim() || state.defaultVoice
    const row = state.voices.find((v) => v.id === voice)
    if (!row) fail(`没有这个音色包：${voice}（可选：${state.voices.map((v) => v.id).join(' / ') || '无'}）`)
    if (!row.ready) fail(`${row.name} 还没装好，先调 yijing_models（action=download, id=${voice}）`)

    const res = speechMod.synthesize({ text: body, voiceId: voice, speed, sid }, deps)
    if (!res.ok) fail(`合成失败：${res.error || res.reason || '未知原因'}`)

    /* 不 apply 就只回文件路径：agent 可能只想先听听/自己决定放哪 */
    if (!apply) {
      return { ok: true, path: res.path, duration: res.duration, sampleRate: res.sampleRate, voice: res.voice, chars: res.chars }
    }

    const draft = readDraft(draftId)
    /* 与界面同一条路：probeOne 会把文件登记成可预览的素材（拿到 yjai-media 地址与真实时长），
       直接塞绝对路径的话，草稿里这一段在预览里是"加载不出来"的黑洞。 */
    const asset = await probeOne(res.path)
    const clip = buildClip(
      {
        track: 'audio',
        kind: 'audio',
        name: name || `配音 ${body.slice(0, 10)}`,
        url: asset.url,
        path: asset.path,
        assetId: `a_${Buffer.from(asset.path).toString('base64url').slice(0, 12)}`,
        start: Math.max(0, finite(start, 0)),
        duration: Number(asset.duration) || res.duration,
        sourceDuration: Number(asset.duration) || res.duration
      },
      nextId
    )
    draft.data.clips.push(clip)
    if (!draft.data.assets.some((a) => a.path === asset.path)) {
      draft.data.assets.push({ id: clip.assetId, path: asset.path, displayName: asset.displayName, kind: asset.kind, duration: asset.duration, url: asset.url })
    }
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return {
      summary,
      ok: true,
      clip: { id: clip.id, start: clip.start, duration: clip.duration, name: clip.name },
      voice: res.voice,
      chars: res.chars,
      elapsed: res.elapsed,
      path: res.path
    }
  }

  /* ---- AI 语音降噪（本机推理，素材不出本机） ---- */

  /**
   * 把一个片段里的人声降噪，落成一条音频片段。
   *
   * 与 `tts` 的产物位置一致（音频轨），但输入是**素材**而不是文字。
   * 与 `recognizeSubtitles` 共用 `clip.offset/duration` 的取段语义 ——
   * 三处都只处理"这一段在源文件里的区间"，整文件处理会让"只用了 3 秒"也跑满全片。
   *
   * `replace=true` 时顺手把原片段静音：这是"换成降噪版"最省事的形态，
   * 否则用户得到两条音轨叠在一起，听起来是原声 + 降噪版混响。
   */
  ops.denoise = async ({ draftId, clipId, apply = true, replace = false, start, name } = {}) => {
    const draft = readDraft(draftId)
    const clip = draft.data.clips[clipIndex(draft, clipId)]
    const source = clip.path || media.normalizeMediaPath(clip.url)
    if (!source) fail('这个片段没有可解码的源文件（文字/形状片段没有声音可处理）')

    const deps = modelDeps()
    const st = speechMod.denoiseStatus(deps)
    if (!st.ready) {
      if (!st.runtimeOk) {
        fail('语音运行时还没装：先调 yijing_models（action=download, id=speech-runtime），约 22MB')
      }
      fail('AI 降噪模型还没装（0.5MB）：先调 yijing_models（action=download, id=speech-denoiser）')
    }

    const res = await speechMod.denoise(
      { sourcePath: source, offset: Number(clip.offset) || 0, duration: Number(clip.duration) || 0 },
      deps
    )
    if (!res.ok) fail(`降噪失败：${res.error || res.reason || '未知原因'}`)

    if (!apply) {
      return { ok: true, path: res.path, duration: res.duration, reducedDb: res.reducedDb, elapsed: res.elapsed }
    }

    const asset = await probeOne(res.path)
    const newClip = buildClip(
      {
        track: 'audio',
        kind: 'audio',
        name: name || `${clip.name || '片段'} · 降噪`,
        url: asset.url,
        path: asset.path,
        assetId: `a_${Buffer.from(asset.path).toString('base64url').slice(0, 12)}`,
        start: finite(start, clip.start),
        duration: Number(asset.duration) || res.duration,
        sourceDuration: Number(asset.duration) || res.duration
      },
      nextId
    )
    draft.data.clips.push(newClip)
    if (!draft.data.assets.some((a) => a.path === asset.path)) {
      draft.data.assets.push({
        id: newClip.assetId,
        path: asset.path,
        displayName: asset.displayName,
        kind: asset.kind,
        duration: asset.duration,
        url: asset.url
      })
    }
    if (replace) {
      /* 静音而不是删除：原片段还带着画面，删掉就把人切没了 */
      const idx = clipIndex(draft, clipId)
      draft.data.clips[idx] = { ...draft.data.clips[idx], muted: true }
    }
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return {
      summary,
      ok: true,
      clip: { id: newClip.id, start: newClip.start, duration: newClip.duration, name: newClip.name },
      reducedDb: res.reducedDb,
      elapsed: res.elapsed,
      path: res.path
    }
  }

  /* ---- 语音转字幕（本机模型，素材不出本机） ---- */

  /** 取音分析参数：与界面 `collectSpeechPeaks` 完全一致，否则分句位置会对不上 */
  const SPEECH_PER = 0.1
  const SPEECH_CHUNK = 30

  /**
   * 把某个片段里的说话内容认成字幕。
   *
   * ⚠️ 三个坐标系不能混：
   *     clip.offset → **源文件**里的入点      （只用于取音）
   *     clip.start  → 片段在**时间线**上的起点（写字幕时加它）
   *     识别结果    → 相对**片段头**          （因为 peaks 与 wav 都从片段头开始取）
   *   最终字幕时间 = clip.start + 识别结果.start。少加一次 clip.start 的表现是
   *   "字幕全挤在 0 秒"，多加一次是"字幕往后串一整段"。
   *
   * ⚠️ 变速片段直接拒绝：识别出来的时间是源文件时间，时间线上是变速后的时间，
   *   差一个倍率 —— 换算错就是整体偏移、越往后偏得越多，看起来像"识别不准"。
   */
  ops.recognizeSubtitles = async ({ draftId, clipId, style, apply = true, modelId } = {}) => {
    const draft = readDraft(draftId)
    const clip = draft.data.clips[clipIndex(draft, clipId)]
    const source = clip.path || media.normalizeMediaPath(clip.url)
    if (!source) fail('这个片段没有可解码的源文件（文字/形状片段没有声音可认）')
    const speed = speedMod.clipSpeed(clip)
    const hasCurve = Boolean(speedMod.readCurve(clip))
    if (Math.abs(speed - 1) > 1e-6 || hasCurve) {
      fail('变速片段不能直接识别字幕：先把速度改回 1×，认完再变速（否则字幕会整体偏移，越往后偏得越多）')
    }
    const offset = Math.max(0, Number(clip.offset) || 0)
    const dur = Number(clip.duration) || 0
    if (dur < 0.5) fail(`这一段只有 ${dur.toFixed(2)} 秒，太短了，没有可识别的内容`)
    if (dur > 600) fail('一次最多识别 10 分钟：先用 yijing_timeline_op 把它切成几段')

    const deps = modelDeps()
    const state = speechMod.status(deps)
    if (!state.runtime.ok) {
      fail(
        `语音识别运行时还没装：${state.runtime.error}。` +
          '先调 yijing_models（action=download, id=speech-runtime），约 22MB'
      )
    }
    const wanted = String(modelId || '').trim() || state.defaultModel
    const model = state.models.find((row) => row.id === wanted)
    if (!model) fail(`没有这个识别模型：${wanted}（可选：${state.models.map((m) => m.id).join(' / ')}）`)
    if (!model.ready) fail(`${model.name} 还没装好，先调 yijing_models（action=download, id=${model.id}）`)

    /* 1) 逐段取峰值 → 分句。与界面的 30 秒一批 / 0.1 秒一桶完全一致 */
    const peaks = []
    for (let at = 0; at < dur - 0.05; at += SPEECH_CHUNK) {
      const span = Math.min(SPEECH_CHUNK, dur - at)
      const buckets = Math.max(8, Math.round(span / SPEECH_PER))
      const part = await renderMod.audioPeaks({ sourcePath: source, offset: offset + at, duration: span, buckets })
      if (!part.ok) fail(`读音频失败：${part.error || part.reason || '未知原因'}`)
      for (const value of part.peaks) peaks.push(value)
    }
    const segments = subtitle.vadSegments(peaks, { secondsPerBucket: SPEECH_PER, minDur: 0.35, maxDur: 8 })
    if (!segments.length) {
      return { ok: true, cues: [], added: 0, note: '这一段里没检测到说话声（可能没有人声，或全程音量一样平）' }
    }

    /* 2) 识别 */
    const result = await speechMod.transcribe(
      { sourcePath: source, offset, duration: dur, segments, modelId: model.id },
      deps
    )
    if (!result.ok) fail(`识别失败：${result.error || result.reason || '未知原因'}`)

    /* 3) 换回时间线坐标（识别结果相对片段头） */
    const cues = result.segments.map((seg) => ({
      start: Number((clip.start + seg.start).toFixed(3)),
      end: Number((clip.start + Math.min(seg.end, dur)).toFixed(3)),
      text: seg.text
    }))

    if (!apply) {
      return { ok: true, model: result.model, cues, count: cues.length, empty: result.empty, elapsed: result.elapsed }
    }

    /* 4) 落成文字片段：和界面「AI 识别字幕」写出来的东西完全一样（sub-plain / 32 号） */
    const created = []
    for (const cue of cues) {
      if (!cue.text) continue
      const textClip = buildClip(
        {
          track: 'text',
          kind: 'text',
          text: cue.text,
          textStyle: style || 'sub-plain',
          textSize: 32,
          start: Math.max(0, cue.start),
          duration: Math.max(0.1, cue.end - cue.start),
          name: cue.text.slice(0, 12)
        },
        nextId
      )
      created.push(textClip)
      draft.data.clips.push(textClip)
    }
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return {
      summary,
      ok: true,
      model: result.model,
      added: created.length,
      empty: result.empty,
      elapsed: result.elapsed,
      first: created.slice(0, 3).map((c) => ({ id: c.id, text: c.text, start: c.start, duration: c.duration }))
    }
  }

  /* ---- 卡点（节拍检测） ---- */

  /**
   * 抽振幅包络找重音（界面上是速度面板的「按音频找节拍」按钮）。
   *
   * 三段与界面**逐步同源**，一处都不能自己写：
   *   ① 包络来自 `render.audioPeaks`（和波形图是同一条 ffmpeg 抽 PCM 的链路）；
   *   ② 找重音交给 `shared/beat.js` 的 `detectBeats`；
   *   ③ 生成曲线用 `shared/speed.js` 的 `curveFromBeats` + `curvePatch`。
   * 自己另写一套的后果是"agent 卡的点和界面卡的点不一样"，而两边都不会报错。
   *
   * ⚠️ 包络是**源时间**：带倍速的片段要除回倍速才是"片段内秒数"（界面同一句注释）。
   */
  ops.detectBeats = async ({ draftId, clipId, sensitivity, apply = false, fast, slow, hold } = {}) => {
    const draft = readDraft(draftId)
    const index = clipIndex(draft, clipId)
    const clip = draft.data.clips[index]
    const asset = draft.data.assets.find((item) => String(item.id) === String(clip.assetId || ''))
    const sourcePath = asset && asset.path ? asset.path : ''
    if (!sourcePath) fail(`这个片段没有可分析的音频（${clipId} 没有关联素材文件，比如文字/字幕片段）`)
    if (clip.kind === 'image') fail('这是图片片段，没有音轨可分析')

    const speed = Math.max(0.01, Number(clip.speed) || 1)
    const span = Math.max(0.2, (Number(clip.duration) || 0) * speed)
    const buckets = Math.min(6000, Math.max(120, Math.round(span * 60)))
    const peaks = await renderMod.audioPeaks({
      sourcePath,
      offset: Math.max(0, Number(clip.offset) || 0),
      duration: span,
      buckets
    })
    if (!peaks || peaks.ok === false) fail((peaks && peaks.error) || '读不到音频包络（片段可能没有声音）')
    const list = Array.isArray(peaks.peaks) ? peaks.peaks : []
    if (!list.length) fail('没读到音频包络（片段可能没有声音）')

    const step = span / list.length
    const raw = beatMod.detectBeats(list, step, sensitivity == null ? {} : { sensitivity })
    const duration = Number(clip.duration) || 0
    const local = raw
      .map((value) => value / (speed || 1))
      .filter((value) => value > 0.02 && value < duration - 0.02)

    let applied = null
    if (apply) {
      const built = speedMod.curveFromBeats(duration, local, { fast, slow, hold })
      if (!built) fail('节拍都落在片段两端，生成不了曲线（把 apply 关掉只取点，或先 trim 片段）')
      const patch = speedMod.curvePatch(clip, built.points)
      if (!patch) fail('曲线生成失败')
      draft.data.clips[index] = { ...clip, ...patch }
      applied = { hits: built.hits, points: patch.speedCurve.points.length, speed: patch.speed }
    }
    const summary = saveDraft(draft.id, draft.name, draft.data)
    return {
      summary,
      clipId,
      beats: local,
      count: local.length,
      sourceBeats: raw,
      step,
      buckets: list.length,
      applied
    }
  }

  /* ---- 导出 ---- */

  async function exportVideo(args) {
    const { draftId, outPath } = args
    const draft = readDraft(draftId)
    if (!draft.data.clips.length) fail('草稿里没有任何片段，无可导出内容')
    const target = String(outPath || '').trim()
    if (!target) fail('outPath 必须是绝对路径')
    const codec = exportCodec.readCodec(args.codec)
    const ext = path.extname(target).toLowerCase()
    if (!exportCodec.VIDEO_EXTS.includes(ext)) fail(`导出扩展名必须是：${exportCodec.VIDEO_EXTS.join(' / ')}`)
    if (ext !== `.${codec.ext}`) fail(`编码 ${codec.key} 的容器是 .${codec.ext}，但路径是 ${ext}`)
    const abs = path.resolve(target)
    fs.mkdirSync(path.dirname(abs), { recursive: true })

    const key = aspect.normalizeAspect(args.aspect || draft.data.aspect)
    /* 没传分辨率就沿用草稿的档位（与界面同源）：agent 建 4K 草稿后直接导，
       不该因为少写一个参数就把成片降成 1080P —— 而这一步没有任何报错。 */
    const res = exportRate.readResolution(args.resolution || draft.data.resolution)
    const width = Number(args.width) || res.width
    const height = Number(args.height) || res.height
    const size = aspect.outputSizeFor(width, height, key)
    const rate = exportRate.readRate(args.fps)
    const cover = coverMod.readCover(args.cover)
    const range = args.range && typeof args.range === 'object' ? { start: finite(args.range.start, 0), end: finite(args.range.end, 0) } : null

    const result = await renderMod.render({
      clips: draft.data.clips,
      outPath: abs,
      options: {
        width: size.width,
        height: size.height,
        fps: rate.fps,
        quality: clamp(finite(args.quality, 80), 10, 100),
        aspect: key,
        codec: codec.key,
        cover: cover.enabled ? cover : undefined,
        range: range && range.end > range.start ? range : undefined,
        loudness: args.loudness
      },
      backdrop: args.backdrop || ''
    })
    if (!result.ok) fail(`导出失败：${result.error || '未知原因'}`)

    let bytes = 0
    try {
      bytes = fs.statSync(abs).size
    } catch {
      /* 文件系统慢时可能还没刷新到，不致命 */
    }
    const coverPath = cover.enabled ? coverMod.coverPathFor(abs) : ''
    return {
      outPath: abs,
      name: draft.name,
      width: size.width,
      height: size.height,
      fps: rate.id,
      codec: codec.key,
      duration: result.duration,
      subtitleCount: result.subtitleCount || 0,
      bytes,
      coverPath: coverPath && fs.existsSync(coverPath) ? coverPath : '',
      warnings: result.warnings || []
    }
  }

  ops.exportVideo = exportVideo

  /* ---- 工程打包 ---- */

  ops.packDraft = ({ draftId, outPath }) => {
    const draft = readDraft(draftId)
    const packMod = require('./pack')
    const target = path.resolve(String(outPath || path.join(userDataDir, `${draft.name || '未命名项目'}.yjpack`)))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    /* 走界面导出素材包**同一个**函数（打包时会把绝对路径改写成包内相对路径），
       自己拼 zip 的话「包在别人机器上打不开」这种问题只会在交付后才暴露 */
    const result = packMod.exportPack({ data: draft.data, outPath: target })
    if (!result || result.ok === false) fail((result && result.error) || '打包失败')
    return { outPath: target, bytes: (() => { try { return fs.statSync(target).size } catch { return 0 } })(), ...result }
  }

  /**
   * 导入素材包（界面上是顶栏「导入素材包」）。
   *
   * 与 `packDraft` 对偶，但**落成新草稿而不是覆盖同名**：包里带的是别人机器上的工程，
   * 覆盖本机同 id 的草稿会把用户自己的东西冲掉，而且不可逆。
   *
   * `registerUrl` 传的是 `mediaUrlOf`：`importPack` 会按解包后的**新绝对路径**重算
   * `yjai-media://` 地址。不传的话所有素材的 url 为空串 —— 草稿能打开，画面全黑，
   * 而且 `missing` 里也不会提（它只查文件在不在）。
   */
  ops.unpackDraft = ({ packPath, name }) => {
    const packMod = require('./pack')
    const file = path.resolve(String(packPath || ''))
    if (!file || !fs.existsSync(file)) fail(`包文件不存在：${packPath}`)

    const stamp = `pack-${Date.now().toString(36)}`
    const destDir = path.join(userDataDir, 'packs', stamp)
    const imported = packMod.importPack({
      packPath: file,
      destDir,
      registerUrl: (mediaPath) => {
        try {
          if (!fs.statSync(mediaPath).isFile()) return ''
        } catch {
          return ''
        }
        return media.mediaUrlOf(mediaPath)
      }
    })
    if (!imported.ok) fail(imported.error || '解包失败')

    const summary = store.save({ name: name || imported.name || '素材包工程', data: imported.data })
    return {
      draftId: summary.id,
      summary,
      name: summary.name,
      mediaCount: imported.mediaCount,
      missing: imported.missing,
      dir: destDir
    }
  }

  /* ---- 应用本体：装 / 起 / 打开草稿 ---- */

  /**
   * 给子进程用的环境：**必须**剥掉 `ELECTRON_RUN_AS_NODE`。
   *
   * 镜枢（以及任何 Electron/Node 宿主）自己就是以 `ELECTRON_RUN_AS_NODE=1` 起的进程，
   * 这个变量会被子进程继承。而被拉起的安装包 / 主程序**本身就是一个 Electron 应用**：
   * 一拿到这个变量就退化成纯 node，把 `--silent` 当成 node 的非法参数。
   *
   * 实测症状（2026-10-31，真机）：安装包直接退出码 9、stderr 打 `bad option: --silent`、
   * **不写结果文件** —— 于是 ops.install 一直轮询到 300s 超时，报"安装超时"，
   * 真正的死因（环境变量）完全看不见。主程序同理：静默变成 node 跑一下就没了，
   * 而 openInApp 只会照样返回 launched:true。
   *
   * 所以这里不是"顺手清理环境"，是这条链路能不能用的问题。
   */
  function childEnv(extra) {
    const env = { ...process.env, ...(extra || {}) }
    delete env.ELECTRON_RUN_AS_NODE
    /* 同族的另一个坑：它会让 Electron 不 attach 控制台，静默模式下更难排查，一并剥掉 */
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    return env
  }

  /**
   * 主程序 exe 在哪。
   *
   * 优先 `YIJAI_APP_PATH`（E2E 与便携版用），其次从**本进程所在目录**反推 ——
   * 镜枢拉起 MCP server 时用的就是这个 exe，`resourcesPath/..` 就是安装目录，
   * 所以"软件自己知道自己在哪"，不需要猜用户装到哪个盘。
   */
  function appExePath() {
    const APP_EXE = 'YiJingAIEditor.exe'
    const candidates = []
    if (process.env.YIJAI_APP_PATH) candidates.push(process.env.YIJAI_APP_PATH)
    try {
      if (process.resourcesPath) candidates.push(path.resolve(process.resourcesPath, '..', APP_EXE))
    } catch {
      /* resourcesPath 在某些 node 版本下不存在 */
    }
    if (process.execPath && /YiJingAIEditor\.exe$/i.test(process.execPath)) candidates.push(process.execPath)
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', '艺镜AI剪辑', APP_EXE))
    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c)) return c
      } catch {
        /* 路径非法：试下一个 */
      }
    }
    return ''
  }

  ops.appStatus = () => {
    const exe = appExePath()
    let version = ''
    if (exe) {
      try {
        const pkg = path.resolve(path.dirname(exe), 'resources', 'app.asar')
        version = fs.existsSync(pkg) ? 'installed' : 'installed'
      } catch {
        version = 'installed'
      }
    }
    return { installed: Boolean(exe), exe, userDataDir, ffmpegReady: Boolean(renderMod.findFfmpeg() && renderMod.findFfmpeg().ffmpeg) }
  }

  /**
   * 无人值守安装：跑安装包的 `--silent`，等结果文件。
   *
   * 为什么等文件而不是等退出码：Windows 上 Electron 是 GUI 子系统，父进程拿不到它的
   * stdout；安装器把结果写成 JSON，这里轮询它 —— 这是唯一可靠的"装完了没有"。
   */
  ops.install = async ({ installerPath, installDir, launch = false, shortcuts = true, noRegister = false, timeoutMs = 300000 }) => {
    const exe = String(installerPath || process.env.YIJAI_INSTALLER || '').trim()
    if (!exe) fail('需要 installerPath（安装包 exe 的绝对路径），或设置环境变量 YIJAI_INSTALLER')
    if (!fs.existsSync(exe)) fail(`安装包不存在：${exe}`)
    const resultFile = path.join(os.tmpdir(), `yijing-install-${Date.now()}.json`)
    const args = ['--silent', '--result', resultFile]
    if (installDir) args.push('--install-dir', String(installDir))
    if (!shortcuts) args.push('--no-shortcuts')
    if (noRegister) args.push('--no-register')
    if (launch) args.push('--launch')
    let exited = null
    try {
      const proc = spawn(exe, args, { windowsHide: true, stdio: 'ignore', detached: false, env: childEnv() })
      proc.on('error', () => {})
      /* 记下退出码：安装包"起步就死"（例如被 ELECTRON_RUN_AS_NODE 带偏、或包损坏）
         时它**不会**写结果文件，只靠轮询会一路等到超时，把死因埋掉。 */
      proc.on('exit', (code, signal) => {
        exited = { code, signal }
      })
    } catch (e) {
      fail(`无法启动安装包：${(e && e.message) || e}`)
    }
    const deadline = Date.now() + clamp(finite(timeoutMs, 300000), 10000, 900000)
    /* 进程已退出但结果文件还没出现 —— 给它 2s 落盘余量（安装器是先写文件再 exit） */
    let exitedAt = 0
    while (Date.now() < deadline) {
      if (fs.existsSync(resultFile)) {
        try {
          const text = fs.readFileSync(resultFile, 'utf8').trim()
          if (text) {
            const parsed = JSON.parse(text)
            try {
              fs.unlinkSync(resultFile)
            } catch {
              /* 结果文件删不掉不影响结论 */
            }
            if (!parsed.ok) fail(`安装失败（code=${parsed.code}）：${parsed.reason || '未知原因'}`)
            return { ...parsed, exe: parsed.exe || appExePath() }
          }
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e
          /* 文件写了一半：下一轮再读 */
        }
      }
      if (exited && !exitedAt) exitedAt = Date.now()
      if (exited && Date.now() - exitedAt > 2000) {
        fail(
          `安装器提前退出（code=${exited.code}${exited.signal ? ` signal=${exited.signal}` : ''}），` +
            `且没有产出结果文件：${resultFile}\n` +
            '  常见原因：安装包损坏 / 被安全软件拦下 / 安装包不是本项目的静默安装器。'
        )
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    fail(`安装超时（${Math.round(clamp(finite(timeoutMs, 300000), 10000, 900000) / 1000)}s），结果文件：${resultFile}`)
  }

  /** 打开主程序（可带草稿）：装完之后"能用"的那一步 */
  ops.openInApp = async ({ draftId, installDir }) => {
    /* 显式给了 installDir 就以它为准 —— 机器上可能**装过多个**（旧版在
       %LOCALAPPDATA%，agent 刚装的新版在别处），按顺序猜会打开旧的那个，
       表现是"agent 装完让你看，你看到的是上一版界面"。 */
    let exe = ''
    if (installDir) {
      const guess = path.join(String(installDir), 'YiJingAIEditor.exe')
      if (fs.existsSync(guess)) exe = guess
    }
    if (!exe) exe = appExePath()
    if (!exe) fail('找不到主程序 exe：请先 yijing_install，或用 YIJAI_APP_PATH 指定路径')
    const args = draftId ? ['--open-draft', String(draftId)] : []
    const proc = spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe), env: childEnv() })
    let died = null
    proc.on('exit', (code, signal) => {
      died = { code, signal }
    })
    proc.on('error', (e) => {
      died = { code: null, signal: null, error: (e && e.message) || String(e) }
    })
    proc.unref()
    /* 「起得来」必须实测：Electron 应用被 ELECTRON_RUN_AS_NODE 带偏时会在几十毫秒内
       以退出码 9 结束，而 spawn 本身是成功的 —— 不等这一下就会报 launched:true，
       agent 以为窗口开了，人看屏幕什么都没有。 */
    for (let i = 0; i < 6 && !died; i++) await new Promise((r) => setTimeout(r, 150))
    if (died) {
      fail(
        `主程序启动后立即退出（code=${died.code}${died.signal ? ` signal=${died.signal}` : ''}` +
          `${died.error ? ` ${died.error}` : ''}）：${exe}`
      )
    }
    return { launched: true, exe, draftId: draftId || '', pid: proc.pid || 0 }
  }

  return ops
}

module.exports = { createOps, normalizePatch, PATCHABLE, TRACKS, FILTER_KEYS, TRANSITION_KEYS, FRAME_FX_KEYS, TEXT_STYLE_KEYS }
