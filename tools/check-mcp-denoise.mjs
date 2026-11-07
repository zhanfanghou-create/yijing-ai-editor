#!/usr/bin/env node
/**
 * 闸门：agent 通道的 AI 语音降噪（`yijing_denoise_audio`）。
 *
 * ── 为什么要独立一道 ─────────────────────────────────────────────
 * 降噪这条链比识别多两个环节：模型的**工作采样率是 16k**、成片要 **48k 立体声**。
 * 中间的「重采样 + 补长度」任何一步错了，现象都是"文件生成了、也能播"：
 *   · 不补长度 → 每段短 8ms，多段拼起来音画逐段偏移（看着像"字幕越往后越晚"）；
 *   · 不重采样 → 混音时采样率与其它素材不一致，整条音轨时长跟着变；
 *   · 不变双声道 → 耳机里只有左声道有声音。
 * 三种都不会报错，所以判据必须读**产物本体**（wav 头 + 时长 + 草稿），不读返回值。
 *
 * ── 成本 ────────────────────────────────────────────────────────
 * 运行时 22MB（若本机还没装）+ 降噪模型 0.5MB + 样例音频 176KB，
 * 全部缓存在 `%TEMP%/yjai-e2e/` 下，重跑只做体积校验。
 *
 * 用法：node tools/check-mcp-denoise.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CACHE = path.join(os.tmpdir(), 'yjai-e2e', 'cache')
/** 与 check-mcp-speech.mjs 共用同一份样例（5.61s 中文），省一次下载 */
const WAV = path.join(CACHE, 'speech-zh-0.wav')
const WAV_BYTES = 179646
const WAV_URLS = [
  'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav',
  'https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav'
]
/** 固定断言数（改断言必须同步这里与 scripts/verify.mjs 的 expected） */
const EXPECTED = 10

let pass = 0
let fail = 0
const check = (name, ok, note = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${note ? `  —— ${note}` : ''}`)
  return ok
}

const models = require('../packages/desktop/src/main/models')
const speech = require('../packages/desktop/src/main/speech')
const { createDraftStore } = require('../packages/desktop/src/main/drafts')
const { createOps } = require('../packages/desktop/src/main/mcp-ops')
const { TOOLS } = require('../packages/desktop/src/main/mcp-server')

function fetchTo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        try {
          fs.unlinkSync(dest)
        } catch {
          /* 没生成就算了 */
        }
        fetchTo(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        file.close()
        reject(new Error(`HTTP ${res.statusCode}：${url}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
    })
    req.on('timeout', () => req.destroy(new Error('连接超时')))
    req.on('error', reject)
  })
}

async function ensureWav() {
  const size = fs.existsSync(WAV) ? fs.statSync(WAV).size : 0
  if (size === WAV_BYTES) return { ok: true, cached: true }
  fs.mkdirSync(CACHE, { recursive: true })
  let last = null
  for (const url of WAV_URLS) {
    try {
      await fetchTo(url, WAV)
      if (fs.statSync(WAV).size === WAV_BYTES) return { ok: true, cached: false }
      last = new Error(`体积不对：${fs.statSync(WAV).size} / 期望 ${WAV_BYTES}`)
    } catch (e) {
      last = e
      try {
        fs.unlinkSync(WAV)
      } catch {
        /* 同上 */
      }
    }
  }
  return { ok: false, error: String((last && last.message) || last) }
}

/**
 * 读 wav 头算真实时长 —— 判据读产物，不看我们自己的返回值。
 *
 * ⚠️ 必须**遍历 chunk**，不能按固定偏移读 44 字节头：ffmpeg 写出来的 wav 常带
 *    `LIST`（元数据）块，此时 `data` 的起点不在 40，硬编码偏移会把时长算成 0.001 秒。
 *    更麻烦的是"两边都读错 → 误差为 0 → 判定通过"，是个典型的假绿。
 */
function wavInfo(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  let channels = 0
  let rate = 0
  let bits = 0
  let dataSize = -1
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      rate = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') {
      dataSize = size
      break
    }
    /* chunk 按偶数对齐：奇数长度后面补一个填充字节 */
    pos += 8 + size + (size % 2 === 1 ? 1 : 0)
  }
  if (dataSize < 0 || !rate || !channels || !bits) return null
  return {
    channels,
    rate,
    bits,
    seconds: dataSize / (rate * channels * (bits / 8)),
    size: buf.length
  }
}

const deps = {
  userData: path.join(os.tmpdir(), 'yjai-e2e', 'agent-denoise'),
  resourcesPath: path.join(ROOT, 'packages', 'desktop', 'resources')
}
fs.mkdirSync(deps.userData, { recursive: true })

console.log('· agent 通道 AI 语音降噪')

/* ---------- 1. 工具面 ---------- */
const tool = TOOLS.yijing_denoise_audio
const props = Object.keys((tool && tool.inputSchema && tool.inputSchema.properties) || {})
check(
  '1. 工具表里有 yijing_denoise_audio，且声明 draftId / clipId / apply / replace',
  Boolean(tool) && ['draftId', 'clipId', 'apply', 'replace'].every((k) => props.includes(k)),
  props.join(',')
)

/* ---------- 2. 注册表：降噪模型真的登记了，且体积是实测值 ---------- */
const entry = models.byId('speech-denoiser')
check(
  '2. 注册表里有降噪模型（group=audio / kind=denoiser / 体积硬校验）',
  Boolean(entry) && entry.group === 'audio' && entry.kind === 'denoiser' && Number(entry.files[0].bytes) === 535638,
  entry ? `${entry.files[0].name} ${entry.files[0].bytes}B` : '没有'
)

/* ---------- 3. 样例音频 ---------- */
const wav = await ensureWav()
if (!check('3. 样例音频就位（5.61s 中文）', wav.ok, wav.ok ? (wav.cached ? '缓存命中' : '刚下载') : wav.error)) {
  console.log(`MCP_DENOISE_STATS total=${EXPECTED} pass=${pass} fail=${EXPECTED - pass}`)
  console.log('MCP_DENOISE_FAILED')
  process.exit(1)
}

/* ---------- 4. 装模型（走工具本身，不绕过它） ---------- */
const store = createDraftStore(() => deps.userData)
const ops = createOps({ store, userDataDir: deps.userData, resourcesPath: deps.resourcesPath })

let modelsOk = true
let modelsErr = ''
try {
  for (const id of ['speech-runtime', 'speech-denoiser']) {
    await ops.models({ action: 'download', id })
  }
} catch (e) {
  modelsOk = false
  modelsErr = String((e && e.message) || e)
}
check('4. yijing_models 能装上运行时 + 降噪模型', modelsOk, modelsOk ? '已就绪' : modelsErr)

const st = speech.denoiseStatus(deps)
check('5. denoiseStatus 认为可用（运行时齐 + 模型在）', st.ready === true, `source=${st.source}`)

if (fail > 0) {
  console.log(`MCP_DENOISE_STATS total=${EXPECTED} pass=${pass} fail=${EXPECTED - pass}`)
  console.log('MCP_DENOISE_FAILED')
  process.exit(1)
}

/* ---------- 5. 真降噪 ---------- */
const draft = ops.createDraft({ name: 'mcp-denoise-gate' })
const draftId = draft.draftId
const added = await ops.addClips({ draftId, clips: [{ path: WAV, start: 1 }] })
const clipId = (added.added || [])[0] && added.added[0].id
const srcLen = wavInfo(WAV).seconds

let dry = null
let dryErr = ''
try {
  dry = await ops.denoise({ draftId, clipId, apply: false })
} catch (e) {
  dryErr = String((e && e.message) || e)
}
check('6. apply=false 只返回 wav 路径与降噪量', Boolean(dry && dry.ok && dry.path && fs.existsSync(dry.path)), dryErr || String(dry && dry.path))

const info = dry && dry.path ? wavInfo(dry.path) : null
check(
  '7. 产物是 48kHz 立体声（成片混音的前提，16k 单声道会让整条音轨时长漂移）',
  Boolean(info) && info.rate === 48000 && info.channels === 2 && info.bits === 16,
  info ? `${info.rate}Hz ${info.channels}ch ${info.bits}bit` : '读不出 wav 头'
)
check(
  '8. 时长与源一致（模型收尾按帧截断，实测少 128 采样，必须补齐）',
  Boolean(info) && Math.abs(info.seconds - srcLen) <= 0.05,
  info ? `${info.seconds.toFixed(3)}s / 源 ${srcLen.toFixed(3)}s` : '-'
)
check(
  '9. 真的压了能量（reducedDb > 0），不是原样复制一份',
  Boolean(dry && Number(dry.reducedDb) > 0),
  dry ? `${dry.reducedDb} dB` : '-'
)

/* ---------- 6. 落盘：判据读草稿本体 + replace 静音原片段 ---------- */
let applied = null
let applyErr = ''
try {
  applied = await ops.denoise({ draftId, clipId, apply: true, replace: true })
} catch (e) {
  applyErr = String((e && e.message) || e)
}
const back = ops.readDraft({ draftId })
const audioClips = back.data.clips.filter((c) => c.track === 'audio')
/* 源片段本身就是音频（样例只有声音），所以"多了一条"不是"audioClips.length===1"，
   而是"按新片段 id 找得到它，且它和源片段不是同一条"。 */
const newClip = audioClips.find((c) => c.id === (applied && applied.clip && applied.clip.id))
const source = back.data.clips.find((c) => c.id === clipId)
check(
  '10. 草稿音频轨真的多了一条降噪片段，且原片段被静音',
  Boolean(applied && applied.ok) &&
    Boolean(newClip) &&
    newClip.id !== clipId &&
    Number(newClip.start) === 1 &&
    Number(newClip.duration) > 0 &&
    source &&
    source.muted === true,
  applyErr || `新增 ${newClip ? newClip.id : '无'} · audio 轨共 ${audioClips.length} 条 · muted=${source ? source.muted : '-'}`
)

console.log(`MCP_DENOISE_STATS total=${EXPECTED} pass=${pass} fail=${fail}`)
console.log(fail === 0 ? 'MCP_DENOISE_OK' : 'MCP_DENOISE_FAILED')
process.exit(fail === 0 ? 0 : 1)
