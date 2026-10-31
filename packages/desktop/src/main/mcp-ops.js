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
const subtitle = require('../shared/subtitle.js')
const templates = require('../shared/templates.js')
const packaging = require('../shared/packaging.js')
const compound = require('../shared/compound.js')
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
const pipJson = require('../shared/pip.json')

const media = require('./media')
const stickersMod = require('./stickers')
const bordersMod = require('./borders')
const pluginsMod = require('./plugins')
const renderMod = require('./render')

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
  'textAnim', 'keyframes', 'pip', 'border', 'face', 'faceTrack', 'pack', 'group', 'url', 'path'
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
      case 'textAnim':
        out.textAnim = textAnim.readTextAnim(raw)
        break
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
      ready: Boolean(found && found.ffmpeg)
    }
  }

  /* ---- 草稿 ---- */

  ops.listDrafts = () => ({ drafts: store.list() })

  ops.readDraft = ({ draftId }) => readDraft(draftId)

  ops.createDraft = ({ name, aspect: aspectKey, playhead }) => {
    const summary = store.save({
      name: name || '未命名项目',
      data: {
        clips: [],
        assets: [],
        playhead: Math.max(0, finite(playhead, 0)),
        volume: 100,
        zoom: 1,
        aspect: aspect.normalizeAspect(aspectKey),
        createdAt: new Date().toISOString()
      }
    })
    return { draftId: summary.id, summary }
  }

  ops.updateDraft = ({ draftId, name, aspect: aspectKey, playhead, volume, zoom }) => {
    const draft = readDraft(draftId)
    if (aspectKey !== undefined) draft.data.aspect = aspect.normalizeAspect(aspectKey)
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
  ops.addSubtitles = ({ draftId, subtitles = [], file, content, filename, offset, style, name }) => {
    const draft = readDraft(draftId)
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
    const shift = finite(offset, 0)
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
    const res = exportRate.readResolution(args.resolution)
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
