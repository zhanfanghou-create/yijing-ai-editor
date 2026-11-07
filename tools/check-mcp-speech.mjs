#!/usr/bin/env node
/**
 * 闸门：agent 通道的语音转字幕（`yijing_recognize_subtitles` / `yijing_models`）。
 *
 * ── 为什么还要单独一道 ──────────────────────────────────────────────
 * 界面那条路已由 `tools/check-speech-recognize.mjs` 端到端验过（点按钮 → 出字幕条）。
 * 但 agent 走的是**另一个入口**：`mcp-ops.js` 的 `ops.recognizeSubtitles`。
 * 两边的代码路径共享 `speech.js`，却各自负责「坐标换算」与「落盘」——
 * 界面认出两行、agent 认出零行（或时间全挤在 0 秒），**双方都返回成功**。
 * 这正是本项目最怕的静默失效，所以必须用真模型 + 真音频各跑一次。
 *
 * ── 判据都是「读消费端」 ──────────────────────────────────────────
 * 不读 ops 的返回值就下结论，而是 `readDraft` 把草稿读回来，看 subtitle 轨上真的有字、
 * 时间真的带上了片段起点、时长真的为正。返回值说成功、草稿里没东西 = 判红。
 *
 * ── 成本 ────────────────────────────────────────────────────────
 * 首次约 100MB（运行时 22MB + 中文模型 78MB），缓存在 `%TEMP%/yjai-e2e/` 下，
 * 重跑只做体积校验，几十秒。所以 `scripts/verify.mjs` 给 10 分钟看门狗。
 *
 * 用法：node tools/check-mcp-speech.mjs
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
const WAV = path.join(CACHE, 'speech-zh-0.wav')
const WAV_BYTES = 179646
/** 样例音频：5.61s 中文连续说话（paraformer 模型仓库自带 test_wavs，许可清晰） */
const WAV_URLS = [
  'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav',
  'https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/test_wavs/0.wav'
]
/** 固定断言数（改断言必须同步这里与 scripts/verify.mjs 的 expected） */
const EXPECTED = 7

let pass = 0
let fail = 0
const check = (name, ok, note = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${note ? `  —— ${note}` : ''}`)
  return ok
}

/* 模块都在主进程目录里，且刻意保持「零 electron 依赖」——所以能在这里直接 require */
const { createDraftStore } = require('../packages/desktop/src/main/drafts')
const models = require('../packages/desktop/src/main/models')
const speech = require('../packages/desktop/src/main/speech')
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

const deps = {
  userData: path.join(os.tmpdir(), 'yjai-e2e', 'agent-speech'),
  resourcesPath: path.join(ROOT, 'packages', 'desktop', 'resources')
}
fs.mkdirSync(deps.userData, { recursive: true })

console.log('· agent 通道语音转字幕')

/* ---------- 1. 工具表里有这两个工具，且参数声明完整 ---------- */
const named = ['yijing_models', 'yijing_recognize_subtitles']
const missing = named.filter((n) => !TOOLS[n])
check('1. 工具表里有 yijing_models / yijing_recognize_subtitles', missing.length === 0, missing.join(' / ') || '都在')

const rec = TOOLS.yijing_recognize_subtitles || { inputSchema: { properties: {} } }
const props = Object.keys(rec.inputSchema.properties || {})
check(
  '2. 识别工具声明了 draftId / clipId / apply（agent 猜不到参数名）',
  ['draftId', 'clipId', 'apply'].every((k) => props.includes(k)),
  props.join(',')
)

/* ---------- 2. 样例音频 ---------- */
const wav = await ensureWav()
if (!check('3. 样例音频就位（5.61s 中文）', wav.ok, wav.ok ? (wav.cached ? '缓存命中' : '刚下载') : wav.error)) {
  console.log(`MCP_SPEECH_STATS total=${EXPECTED} pass=${pass} fail=${fail + (EXPECTED - pass - fail)}`)
  console.log('MCP_SPEECH_FAILED')
  process.exit(1)
}

/* ---------- 3. 模型：缺什么装什么（走工具本身，不绕过它） ---------- */
const store = createDraftStore(() => deps.userData)
const ops = createOps({ store, userDataDir: deps.userData, resourcesPath: deps.resourcesPath })

let modelsOk = true
let modelsErr = ''
try {
  for (const id of ['speech-runtime', 'speech-paraformer']) {
    await ops.models({ action: 'download', id })
  }
} catch (e) {
  modelsOk = false
  modelsErr = String((e && e.message) || e)
}
check('4. yijing_models 能把运行时 + 中文模型装好', modelsOk, modelsOk ? '已就绪' : modelsErr)

const state = speech.status(deps)
check('5. speech.status 认为可用（运行时齐 + 至少一个模型）', state.ready === true, `defaultModel=${state.defaultModel}`)

if (fail > 0) {
  console.log(`MCP_SPEECH_STATS total=${EXPECTED} pass=${pass} fail=${EXPECTED - pass}`)
  console.log('MCP_SPEECH_FAILED')
  process.exit(1)
}

/* ---------- 4. 真识别：片段起点故意给 2 秒，验坐标换算 ---------- */
const draft = ops.createDraft({ name: 'mcp-speech-gate' })
const draftId = draft.draftId
const added = await ops.addClips({ draftId, clips: [{ path: WAV, start: 2 }] })
const clipId = (added.added || [])[0] && added.added[0].id

let dry = null
let dryErr = ''
try {
  dry = await ops.recognizeSubtitles({ draftId, clipId, apply: false })
} catch (e) {
  dryErr = String((e && e.message) || e)
}
const cues = (dry && dry.cues) || []
check(
  '6. apply=false 只返回文字与时间（认出了中文）',
  Boolean(dry && dry.ok) && cues.length >= 1 && cues.some((c) => /[\u4e00-\u9fa5]/.test(c.text)),
  dryErr || `${cues.length} 条：${cues.map((c) => c.text).join(' / ').slice(0, 40)}`
)

let applied = null
let applyErr = ''
try {
  applied = await ops.recognizeSubtitles({ draftId, clipId, apply: true })
} catch (e) {
  applyErr = String((e && e.message) || e)
}

/* 判据读**草稿本身**，不读返回值 */
const back = ops.readDraft({ draftId })
const textClips = back.data.clips.filter((c) => c.track === 'text')
check(
  '7. 落盘后在字幕轨上真的读得到（时间带上片段起点、时长为正）',
  textClips.length >= 1 &&
    textClips.length === (applied && applied.added) &&
    textClips.every((c) => Number(c.start) >= 1.999 && Number(c.duration) > 0) &&
    textClips.some((c) => /[\u4e00-\u9fa5]/.test(String(c.text || ''))),
  applyErr || `字幕 ${textClips.length} 条，首条 @${textClips[0] ? textClips[0].start : '-'}s`
)

console.log(`MCP_SPEECH_STATS total=${EXPECTED} pass=${pass} fail=${fail}`)
console.log(fail === 0 ? 'MCP_SPEECH_OK' : 'MCP_SPEECH_FAILED')
process.exit(fail === 0 ? 0 : 1)
