'use strict'
/**
 * 艺镜AI剪辑 · MCP server（stdio）
 *
 * 让「艺镜·镜枢」的 agent 直接驱动剪辑软件：给一份剪辑方案 → 落成草稿 → 导出成片。
 *
 * ── 为什么是一个独立脚本、而不是「应用内加个 --mcp 开关」 ──────────────
 * 实测（2026-10-10）：Windows 上 Electron 是 **GUI 子系统**，主进程被父进程以管道
 * 拉起时 **stdin 立刻 EOF** —— 父进程写进来的第一行就收不到，"应用自己当 stdio server"
 * 这条路根本走不通。必须让 exe 以 **`ELECTRON_RUN_AS_NODE=1`** 当纯 Node 跑，
 * 这时 stdio 才是标准 Node 行为（同一份实测：`echo` 来回 + 优雅关闭都成立）。
 * 所以镜枢的 mcp.json 里 command 是 exe、args 是本文件、env 带 `ELECTRON_RUN_AS_NODE=1`。
 *
 * ── 为什么能直接复用主进程的 render.js ──────────────────────────────
 * render.js / looks.js / subtitles.js **零 electron 依赖**（只有 index.js require electron），
 * 而且 `process.resourcesPath` 在 RUN_AS_NODE 下仍指向安装目录的 `resources`，
 * 于是随包 ffmpeg 的查找逻辑原样可用。导出与界面导出**走同一条管线**，
 * 不存在"agent 导出来和界面导出来不一样"。
 *
 * ── 铁律 ───────────────────────────────────────────────────────────
 * stdout **只许**出现 JSON-RPC 报文。任何日志/进度/警告一律走 stderr ——
 * 往 stdout 写一个字符就会让对面解析失败、整条链路静默断掉。
 * 进度因此不在这里输出（render 的 onProgress 也不传）。
 */
const path = require('node:path')
const fs = require('node:fs')

const { createDraftStore } = require('./drafts')
const media = require('./media')
const aspect = require('../shared/aspect.js')
const effects = require('../shared/effects.js')
const renderMod = require('./render')

const SERVER_NAME = 'yijing-editor'
const SERVER_VERSION = '1.0.0'
const PROTOCOL_VERSION = '2024-11-05'

/* ------------------------------ 基础环境 ------------------------------ */

/**
 * 草稿根目录。镜枢拉起本进程时由主进程在 env 里带**权威值**（`YIJAI_USER_DATA`），
 * 避免在 MCP server 里猜 Electron 的 userData 命名规则（`@yijing/desktop` 这种
 * 带作用域的怪名，猜错就是"agent 建的草稿软件里看不到"，还不报错）。
 * 兜底值只用于手工调试。
 */
function userDataDir() {
  const fromEnv = process.env.YIJAI_USER_DATA
  if (fromEnv) return fromEnv
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, '@yijing', 'desktop')
  }
  return path.join(process.env.HOME || '.', '.yijing-editor')
}

const store = createDraftStore(userDataDir)

/** 片段 id：与渲染层同形（前缀 + 时间戳 + 递增），保证肉眼可辨、不撞 */
let idSeq = 0
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++idSeq}`

/* ------------------------------ 片段构造 ------------------------------ */

const DEFAULT_CLIP_SECONDS = 5

/**
 * 把一个素材（或一句字幕 / 一个纯色背景）变成**时间线片段**。
 * 字段与渲染层「素材落到轨道」时构造的对象**逐字对齐** ——
 * 少一个 `sourceDuration` 就能把片段拖得比素材还长、尾部变黑帧。
 */
function buildClip(input = {}) {
  const track = input.track || 'video'
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
    clip.pip = input.pip || { anchor: 'top-left', size: 30 }
  }
  return clip
}

/** 允许 agent 直接覆盖的片段字段（与导出载荷同名，改这里等于同时改导出） */
const PATCHABLE = [
  'name', 'text', 'textStyle', 'textSize', 'start', 'duration', 'offset',
  'filter', 'filterIntensity', 'frameFx', 'transition', 'transitionDuration',
  'opacity', 'scale', 'gain', 'speed', 'posX', 'posY', 'rotate',
  'adjust', 'beauty', 'effects', 'keyframes', 'fadeIn', 'fadeOut',
  'textScale', 'textColor', 'textAnchor', 'textOffset', 'pip', 'url', 'path'
]

function applyPatch(clip, patch = {}) {
  const next = { ...clip }
  for (const key of PATCHABLE) {
    if (patch[key] !== undefined) next[key] = patch[key]
  }
  // 数字字段夹到合法区间：agent 传个字符串/负数不该让导出整条坏掉
  const nums = ['start', 'duration', 'offset', 'opacity', 'scale', 'gain', 'speed']
  for (const key of nums) {
    if (next[key] !== undefined && !Number.isFinite(Number(next[key]))) delete next[key]
  }
  return next
}

/* ------------------------------ 草稿读写 ------------------------------ */

const DRAFT_DATA_KEYS = ['clips', 'assets', 'playhead', 'volume', 'zoom', 'aspect', 'createdAt']

function readDraftData(id) {
  const record = store.load(id)
  if (!record) throw new Error(`草稿不存在：${id}`)
  const data = record.data && typeof record.data === 'object' ? record.data : {}
  return {
    id: record.id,
    name: record.name,
    data: {
      clips: Array.isArray(data.clips) ? data.clips : [],
      assets: Array.isArray(data.assets) ? data.assets : [],
      playhead: Number(data.playhead) || 0,
      volume: Number(data.volume) || 100,
      zoom: Number(data.zoom) || 1,
      aspect: aspect.normalizeAspect(data.aspect),
      createdAt: data.createdAt || record.createdAt || new Date().toISOString()
    }
  }
}

function writeDraftData(id, name, data) {
  const clean = {}
  for (const key of DRAFT_DATA_KEYS) {
    if (data[key] !== undefined) clean[key] = data[key]
  }
  clean.aspect = aspect.normalizeAspect(clean.aspect)
  return store.save({ id, name, data: clean })
}

/* ------------------------------ 素材探测 ------------------------------ */

async function probeMedia(absPath) {
  const described = media.describeMedia(absPath)
  if (!described) throw new Error(`不是可用的素材（不存在/类型不支持）：${absPath}`)
  const streams = await renderMod.probeStreams(described.path)
  return {
    ...described,
    duration: streams && Number.isFinite(streams.duration) ? streams.duration : 0,
    hasVideo: Boolean(streams && streams.hasVideo),
    hasAudio: Boolean(streams && streams.hasAudio)
  }
}

/* ------------------------------ 工具实现 ------------------------------ */

/** 把一组素材路径变成片段并追加到草稿，返回新片段摘要 */
async function addClips({ draftId, clips = [], name }) {
  const { data, name: draftName } = readDraftData(draftId)
  const created = []
  for (const spec of clips) {
    let asset = null
    if (spec.path) {
      asset = await probeMedia(spec.path)
    }
    const track = spec.track || (asset ? (asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'video' : 'video') : 'video')
    const clip = buildClip({
      ...spec,
      track,
      kind: spec.kind || (asset ? asset.kind : 'video'),
      name: spec.name || (asset ? asset.displayName : '素材'),
      url: spec.url || (asset ? asset.url : ''),
      path: asset ? asset.path : spec.path || '',
      assetId: spec.assetId || (asset ? `a_${Buffer.from(asset.path).toString('base64url').slice(0, 12)}` : ''),
      // 没给时长就用素材真实时长（这正是"agent 不用自己算时长"的那一步）
      duration: spec.duration != null ? spec.duration : asset ? asset.duration : undefined,
      sourceDuration: spec.sourceDuration != null ? spec.sourceDuration : asset ? asset.duration : 0
    })
    created.push(clip)
    data.clips.push(clip)
    if (asset) {
      const exists = data.assets.some((a) => a.path === asset.path)
      if (!exists) {
        data.assets.push({
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
        })
      }
    }
  }
  const summary = writeDraftData(draftId, name || draftName, data)
  return { summary, added: created.map((c) => ({ id: c.id, name: c.name, track: c.track, start: c.start, duration: c.duration })) }
}

/** 追加字幕到字幕轨 */
function addSubtitles({ draftId, subtitles = [], name }) {
  const { data, name: draftName } = readDraftData(draftId)
  const created = []
  for (const spec of subtitles) {
    if (!spec.text) continue
    const clip = buildClip({
      track: 'text',
      kind: 'text',
      text: String(spec.text),
      textStyle: spec.style || spec.textStyle || 'sub-plain',
      textSize: spec.size || spec.textSize || 32,
      start: Number(spec.start) || 0,
      duration: spec.duration != null ? Number(spec.duration) : 3,
      name: spec.name || String(spec.text).slice(0, 12)
    })
    created.push(clip)
    data.clips.push(clip)
  }
  const summary = writeDraftData(draftId, name || draftName, data)
  return { summary, added: created.map((c) => ({ id: c.id, text: c.text, start: c.start, duration: c.duration })) }
}

/** 更新某个片段（特效 / 动画 / 位置 / 速度 …） */
function updateClip({ draftId, clipId, patch = {}, name }) {
  const { data, name: draftName } = readDraftData(draftId)
  const index = data.clips.findIndex((c) => c.id === clipId)
  if (index < 0) throw new Error(`草稿里没有这个片段：${clipId}`)
  data.clips[index] = applyPatch(data.clips[index], patch)
  const summary = writeDraftData(draftId, name || draftName, data)
  return { summary, clip: data.clips[index] }
}

/** 导出成片 */
async function exportVideo({ draftId, outPath, width, height, fps, quality, aspect: aspectKey, backdrop }) {
  const { data, name } = readDraftData(draftId)
  if (!data.clips.length) throw new Error('草稿里没有任何片段，无可导出内容')
  const target = String(outPath || '').trim()
  if (!target || path.extname(target).toLowerCase() !== '.mp4') {
    throw new Error('导出路径必须是绝对路径且以 .mp4 结尾')
  }
  const abs = path.resolve(target)
  fs.mkdirSync(path.dirname(abs), { recursive: true })

  const key = aspect.normalizeAspect(aspectKey || data.aspect)
  const baseW = Number(width) || 1920
  const baseH = Number(height) || 1080
  const size = aspect.outputSizeFor(baseW, baseH, key)

  const result = await renderMod.render({
    clips: data.clips,
    outPath: abs,
    options: {
      width: size.width,
      height: size.height,
      fps: Number(fps) || 30,
      quality: Number(quality) || 80,
      aspect: key
    },
    backdrop: backdrop || ''
  })
  if (!result.ok) {
    throw new Error(`导出失败：${result.error || '未知原因'}`)
  }
  let bytes = 0
  try {
    bytes = fs.statSync(abs).size
  } catch {
    /* 文件系统慢时可能还没刷新到，不致命 */
  }
  return {
    outPath: abs,
    name,
    width: size.width,
    height: size.height,
    duration: result.duration,
    subtitleCount: result.subtitleCount || 0,
    bytes,
    warnings: result.warnings || []
  }
}

/* ------------------------------ 工具表 ------------------------------ */
// description 是给 agent 看的**唯一的**说明书：写清"什么时候用、参数怎么给"，
// 而不是重复参数名。agent 看不见我们的界面，全靠这几句话决定怎么调。

const TOOLS = {
  yijing_list_drafts: {
    description: '列出剪辑软件里已有的草稿（项目）。每个草稿是时间线上的一组成片素材。开始编辑前先用它找到目标草稿，或确认还没有草稿。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({ drafts: store.list() })
  },

  yijing_read_draft: {
    description: '读取一个草稿的完整内容：时间线上的所有片段（视频/叠加/音频/字幕四类轨道）、素材库、画面比例等。改动草稿前先用它看清现状。',
    inputSchema: {
      type: 'object',
      properties: { draftId: { type: 'string', description: '草稿 id（来自 yijing_list_drafts）' } },
      required: ['draftId'],
      additionalProperties: false
    },
    handler: ({ draftId }) => readDraftData(draftId)
  },

  yijing_create_draft: {
    description: '新建一个空白草稿。返回新草稿的 id，后续用它在时间线上添加素材。可选传 clips 一次性把片段写进去。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '草稿名（省略则叫「未命名项目」）' },
        aspect: { type: 'string', description: '画面比例，取值：1:1 / 1:2 / 3:4 / 9:16 / 16:9 / 4:3 / 2:1（默认 16:9）' }
      },
      additionalProperties: false
    },
    handler: ({ name, aspect: aspectKey }) => {
      const summary = store.save({
        name: name || '未命名项目',
        data: { clips: [], assets: [], playhead: 0, volume: 100, zoom: 1, aspect: aspect.normalizeAspect(aspectKey), createdAt: new Date().toISOString() }
      })
      return { draftId: summary.id, summary }
    }
  },

  yijing_probe_media: {
    description: '探测一个本地音视频/图片文件：类型、时长、是否含音轨/视频轨，并返回可直接写进草稿的素材信息。编辑前先探测可以把真实时长填进片段。',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, description: '本地文件的绝对路径列表' } },
      required: ['paths'],
      additionalProperties: false
    },
    handler: async ({ paths }) => {
      const list = Array.isArray(paths) ? paths : [paths]
      const out = []
      for (const p of list) {
        try {
          out.push(await probeMedia(p))
        } catch (e) {
          out.push({ path: p, error: String(e && e.message) })
        }
      }
      return { media: out }
    }
  },

  yijing_add_clips: {
    description: '把音视频/图片素材追加到草稿的时间线上。track 决定落在哪条轨：video=主视频轨、overlay=叠加轨（画中画）、audio=音频轨。不传 duration 时自动用素材真实时长。',
    inputSchema: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: '目标草稿 id' },
        clips: {
          type: 'array',
          description: '要添加的片段列表',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '素材文件绝对路径' },
              track: { type: 'string', description: 'video / overlay / audio' },
              start: { type: 'number', description: '在时间线上的起点（秒），默认 0' },
              duration: { type: 'number', description: '片段时长（秒），省略则用素材真实时长' },
              offset: { type: 'number', description: '从素材第几秒开始取，默认 0' },
              name: { type: 'string', description: '片段显示名' }
            }
          }
        }
      },
      required: ['draftId', 'clips'],
      additionalProperties: false
    },
    handler: (args) => addClips(args)
  },

  yijing_add_subtitles: {
    description: '往字幕轨批量添加字幕。每条的 style 从内置样式中选（sub-plain 白字描边最通用；还有 sub-bar/sub-neon/title-hero 等）。start 是出现时间（秒），duration 是持续时长。',
    inputSchema: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: '目标草稿 id' },
        subtitles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '字幕正文' },
              start: { type: 'number', description: '出现时间（秒）' },
              duration: { type: 'number', description: '持续时长（秒），默认 3' },
              style: { type: 'string', description: '样式 key，默认 sub-plain' },
              size: { type: 'number', description: '字号，默认 32' }
            },
            required: ['text', 'start']
          }
        }
      },
      required: ['draftId', 'subtitles'],
      additionalProperties: false
    },
    handler: (args) => addSubtitles(args)
  },

  yijing_update_clip: {
    description: '修改指定片段的属性：调色(filter)、画面特效(frameFx)、转场(transition)、位置旋转(posX/posY/rotate)、缩放(scale)、不透明度(opacity)、速度(speed)、音量(gain)、淡入淡出(fadeIn/fadeOut)，以及高级效果 effects（圆角/蒙版/抠像/描边/阴影/混合模式）与关键帧动画 keyframes。只传要改的字段。',
    inputSchema: {
      type: 'object',
      properties: {
        draftId: { type: 'string' },
        clipId: { type: 'string', description: '片段 id（来自 yijing_read_draft）' },
        patch: { type: 'object', description: '要覆盖的字段（与草稿片段字段同名）' }
      },
      required: ['draftId', 'clipId', 'patch'],
      additionalProperties: false
    },
    handler: (args) => updateClip(args)
  },

  yijing_delete_clip: {
    description: '从草稿的时间线上删除一个片段。',
    inputSchema: {
      type: 'object',
      properties: { draftId: { type: 'string' }, clipId: { type: 'string' } },
      required: ['draftId', 'clipId'],
      additionalProperties: false
    },
    handler: ({ draftId, clipId }) => {
      const { data, name } = readDraftData(draftId)
      const before = data.clips.length
      data.clips = data.clips.filter((c) => c.id !== clipId)
      if (data.clips.length === before) throw new Error(`草稿里没有这个片段：${clipId}`)
      const summary = writeDraftData(draftId, name, data)
      return { summary, removed: clipId }
    }
  },

  yijing_export_video: {
    description: '把草稿导出成 MP4 成片。会真实调用 ffmpeg 渲染（含字幕、特效、转场、画中画、调色）。导出前请确保草稿里已有片段。返回成片路径与时长。',
    inputSchema: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: '要导出的草稿 id' },
        outPath: { type: 'string', description: '成片输出路径（绝对路径，.mp4 结尾）' },
        width: { type: 'number', description: '基准宽度，默认 1920' },
        height: { type: 'number', description: '基准高度，默认 1080' },
        fps: { type: 'number', description: '帧率，默认 30' },
        quality: { type: 'number', description: '画质 10–100，默认 80（越大越清晰、文件越大）' },
        aspect: { type: 'string', description: '覆盖画面比例（默认沿用草稿的）' }
      },
      required: ['draftId', 'outPath'],
      additionalProperties: false
    },
    handler: (args) => exportVideo(args)
  }
}

/* ------------------------------ JSON-RPC ------------------------------ */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function log(...args) {
  process.stderr.write('[yijing-mcp] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n')
}

/** 工具名 → 结果。text 里放人类可读的 JSON，agent 直接读得懂 */
async function callTool(name, args) {
  const tool = TOOLS[name]
  if (!tool) throw new Error(`未知工具：${name}`)
  const result = await tool.handler(args || {})
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  }
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } } }
  }
  if (method === 'notifications/initialized') {
    /**
     * 标准 MCP 里通知不带 id、也不该有响应 —— 但镜枢的 client 用同一个 `_rpc()`
     * 发它，**同样分配了 id 并等回包**（30s 没回就判整条连接失败）。所以这里
     * 按通用规则处理：**只要来包带 id 就回一个空 result**；不带 id 则静默。
     * 对标准 client 无副作用，对镜枢则是"能连上"的前提。
     */
    return id == null ? null : { jsonrpc: '2.0', id, result: {} }
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: Object.entries(TOOLS).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.inputSchema }))
      }
    }
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    try {
      const out = await callTool(String(name), args)
      return { jsonrpc: '2.0', id, result: out }
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e && e.message) }], isError: true } }
    }
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${method}` } }
}

/* ------------------------------ 启动 ------------------------------ */

let buffer = ''
let queue = Promise.resolve()

function drain(line) {
  const text = line.trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    log('忽略无法解析的一行')
    return
  }
  // 串行处理：两个 tools/call 并发写同一份草稿会互相覆盖（后写赢）
  queue = queue.then(async () => {
    const reply = await handle(msg)
    if (reply) send(reply)
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''
  for (const line of lines) drain(line)
})
process.stdin.on('end', () => {
  if (buffer.trim()) drain(buffer)
  queue.then(() => process.exit(0))
})

process.on('uncaughtException', (e) => log('未捕获异常：' + String(e && e.stack)))
process.on('unhandledRejection', (e) => log('未处理的拒绝：' + String(e)))

log(`启动 server=${SERVER_NAME} pid=${process.pid} userData=${userDataDir()}`)
