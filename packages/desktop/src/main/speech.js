'use strict'
/**
 * 本机语音识别（字幕 / 文字转写）—— sherpa-onnx 推理。
 *
 * 为什么是一个独立文件：
 *   · 它要做的事是"把一段音视频里的说话内容变成带时间点的文字"，和导出渲染
 *     （render.js）没有交集，但两边都要用 ffmpeg 与"模型装在哪"的判定；
 *   · 它依赖一个**原生插件**（sherpa-onnx.node），加载失败的原因有五六种，
 *     每一种都要能用一句话说清"还缺什么"，不能笼统地报"识别失败"。
 *
 * ⚠️ 三条只能靠真跑一次才发现的坑（都写在这里，别再踩）：
 *   ① 插件必须用**绝对路径** require。放进 asar 里不行（原生模块要从磁盘 dlopen），
 *      所以要落在 `resources/speech` 或 `<userData>/models/speech-runtime`；
 *      同目录的 onnxruntime.dll 由 Node 的 LOAD_WITH_ALTERED_SEARCH_PATH 自己找到，
 *      不需要改环境变量 —— 但**换个目录单独放 .node 就会报"找不到模块"**，
 *      而错误信息里只会提到 .node，不会提 dll。
 *   ② 识别是**同步阻塞**的。一段 5 秒音频约 60ms，但 3 分钟素材累计能到 2 秒，
 *      期间主进程不响应任何 IPC（窗口看起来"卡住"）。所以按句切段、每段之间
 *      让出一个事件循环，并推一条进度 —— 用户看到的是"正在识别 12/40"。
 *   ③ 采样率必须 16000。直接喂 44.1k 的原始数据不会报错，只会得到一串乱码，
 *      因为模型按 16k 的帧长切窗。所以音频一律先过 ffmpeg 重采样，不信源文件。
 *
 * 本文件是**纯 Node**（fs / path / child_process / os），不 require electron：
 * 这样它能脱机自测，也能被 MCP 侧复用。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const models = require('./models')

/** 模型本体需要的采样率 —— 与注册表里两个模型一致，写死而不是从模型里读 */
const SAMPLE_RATE = 16000

/** 单个识别窗口的上限。超过这个长度，模型会截断（它的训练窗口就这么长） */
const MAX_WINDOW = 30

/** 已加载的插件，按目录缓存（重建一次要 0.9 秒，不能每次都建） */
let addonCache = null

/**
 * 已建好的降噪器（只可能有一个 —— 降噪模型是单体，不像识别模型那样有多个可换）。
 *
 * 声明放在这里而不是降噪那一节：resetCache() 在前面，虽然函数体引用是运行期解析、
 * 写在后面也能跑，但"清理函数引用了文件末尾的变量"是下次改动最容易踩断的那种写法。
 */
let denoiserCache = null

/** 已建好的识别器，按 `模型目录 + 模型 id` 缓存 */
const recognizerCache = new Map()

/* ------------------------------ 定位 ------------------------------ */

/**
 * 运行时目录。
 *
 * 与 models.js 的 stateOf 同一套判定：本机装的那份优先，没有就回落到随包那份。
 * ⚠️ 不能用 `installDirOf` 直接拼 —— 那会得到一个"本机目录"，即使它是空的，
 *    require 会报一个指向空目录的 MODULE_NOT_FOUND，看起来像代码 bug。
 */
function runtimeOf(deps = {}) {
  const entry = models.byId('speech-runtime')
  if (!entry) return { ok: false, dir: '', missing: [], error: '注册表里没有语音识别运行时' }
  const state = models.stateOf(entry, deps)
  if (state.source === 'missing') {
    return {
      ok: false,
      dir: state.dir,
      missing: state.missing,
      source: 'missing',
      error: `语音识别运行时缺少 ${state.missing.length} 个文件`
    }
  }
  return { ok: true, dir: state.dir, missing: [], source: state.source }
}

/** 可用的识别模型（`kind === 'model'` 且 `group === 'speech'`），附各自的就绪状态 */
function modelRows(deps = {}) {
  return models
    .list(deps)
    .filter((row) => row.group === 'speech' && row.kind === 'model')
    .map((row) => ({ ...row, ready: row.source !== 'missing' }))
}

/**
 * 整条链路的状态：运行时 + 每个模型。
 *
 * 渲染层据此决定「点识别时是直接开跑，还是先把用户送去装模型」。
 * 返回里 `ready` 只表示"运行时 + 至少一个模型可用"——没有模型可选的运行时是死配置。
 */
function status(deps = {}) {
  const runtime = runtimeOf(deps)
  const list = modelRows(deps)
  return {
    ok: true,
    runtime,
    models: list,
    ready: runtime.ok && list.some((row) => row.ready),
    /* 默认用哪个：优先轻量中文模型（78MB，装上就能用），没有再退到多语种 */
    defaultModel: (list.find((row) => row.ready && row.id === 'speech-paraformer') || list.find((row) => row.ready) || {}).id || ''
  }
}

/* ------------------------------ 插件加载 ------------------------------ */

/**
 * 加载（并缓存）原生插件。
 *
 * ⚠️ 这里用 `require(绝对路径)` 而不是 `require('sherpa-onnx-node')`：
 *    后者会去 node_modules 里找，而安装版里根本没有 node_modules ——
 *    开发模式一切正常、装出来就崩，正是本项目反复吃过的那类亏。
 */
function addonAt(dir) {
  const plugin = path.join(dir, 'sherpa-onnx.node')
  if (!fs.existsSync(plugin)) {
    const err = new Error(`插件文件不存在：${plugin}`)
    err.code = 'runtime-missing'
    throw err
  }
  if (addonCache && addonCache.dir === dir) return addonCache.addon
  let addon = null
  try {
    addon = require(plugin)
  } catch (cause) {
    /* 把"缺 dll / ABI 不符 / 依赖缺失"三种都收成一条可读的错误：
       原始信息里通常只有一句 "The specified module could not be found"，
       没有任何线索指向是哪个 dll —— 那就把同目录的文件列出来给用户看。 */
    let present = []
    try {
      present = fs.readdirSync(dir).filter((name) => /\.(node|dll)$/i.test(name))
    } catch {
      present = []
    }
    const err = new Error(
      `插件加载失败（${String((cause && cause.message) || cause).slice(0, 120)}）。` +
        `该目录现有 ${present.join('、') || '（空）'}`
    )
    err.code = 'runtime-broken'
    throw err
  }
  addonCache = { dir, addon }
  return addon
}

/** 按模型 id 建一个识别器；同一份模型重复调用直接复用 */
function recognizerFor(addon, modelEntry, modelDir) {
  const key = `${modelDir}::${modelEntry.id}`
  const hit = recognizerCache.get(key)
  if (hit) return hit

  const modelFile = path.join(modelDir, 'model.int8.onnx')
  const tokens = path.join(modelDir, 'tokens.txt')

  /* 两个模型族的配置形状不同 —— 这是 sherpa 的约定，不是我们的口味：
     paraformer 认 `paraformer` 键，SenseVoice 认 `senseVoice` 键（大小写都不一样）。
     写错键名不会报错，会得到一个"模型加载成功但什么都不认"的识别器。 */
  const modelConfig = {
    tokens,
    numThreads: Math.max(1, Math.min(4, (os.cpus() || []).length - 1 || 1)),
    provider: 'cpu',
    debug: 0
  }
  if (modelEntry.id === 'speech-sensevoice') {
    modelConfig.senseVoice = { model: modelFile, useInverseTextNormalization: 1, language: 'auto' }
  } else {
    modelConfig.paraformer = { model: modelFile }
  }

  const recognizer = addon.createOfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig,
    decodingMethod: 'greedy_search'
  })
  recognizerCache.set(key, recognizer)
  return recognizer
}

/** 换模型 / 删模型之后要把缓存清掉，否则会继续用已经不在磁盘上的那份 */
function resetCache() {
  addonCache = null
  recognizerCache.clear()
  /* 音色包也要跟着清：换了/删了配音模型之后还留着旧的合成器，
     用户会"删了模型点生成还能出声"，或"换了音色还是原来的声音"。 */
  ttsCache.clear()
  /* 降噪模型同理：删掉 0.5MB 的 gtcrn 之后不该还能"点一下照样降噪" */
  denoiserCache = null
}

/* ------------------------------ 音频 ------------------------------ */

/** 找一个可用的 ffmpeg —— 复用 render.js 的探测（含随包 / 环境变量 / 常见目录） */
function ffmpegBin() {
  try {
    const found = require('./render').findFfmpeg()
    return (found && found.ffmpeg) || ''
  } catch {
    return ''
  }
}

/**
 * 把 `[offset, offset+duration)` 抽成 16k 单声道 wav。
 *
 * ⚠️ `-ss` 放在 `-i` **之后**：放在前面是输入定位（快，但按关键帧对齐），
 *    音频上会偏几十毫秒，而这个偏移会原样进入字幕时间点 ——
 *    字幕整体早/晚半拍，是那种"看着不对但说不出哪里不对"的问题。
 */
function extractWav({ sourcePath, offset, duration, outPath, bin }) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-y',
      '-loglevel', 'error',
      '-i', sourcePath,
      '-ss', String(Math.max(0, offset)),
      '-t', String(Math.max(0.05, duration)),
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-acodec', 'pcm_s16le',
      outPath
    ]
    const child = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-2000)
    })
    child.on('error', (err) => resolve({ ok: false, error: `调不起 ffmpeg：${err.message}` }))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: (stderr.trim().split('\n').pop() || `ffmpeg 退出码 ${code}`).slice(0, 200) })
        return
      }
      let size = 0
      try {
        size = fs.statSync(outPath).size
      } catch {
        size = 0
      }
      /* wav 头 44 字节；小于它说明这一段根本没有音频（纯图片片段、静音素材被裁掉等） */
      if (size <= 64) {
        resolve({ ok: false, reason: 'no-audio', error: '这一段没有音轨' })
        return
      }
      resolve({ ok: true })
    })
  })
}

/* ------------------------------ 识别 ------------------------------ */

/** 去掉识别结果里的装饰：sherpa 的 SenseVoice 会带 `<|zh|><|NEUTRAL|>` 这类标签 */
function cleanText(raw) {
  return String(raw || '')
    .replace(/<\|[^|]*\|>/g, '')
    /* 语言/情绪标签之间常有空格残留，收尾统一压缩 */
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 识别一组时间区间。
 *
 * @param {object} payload
 *   sourcePath  源文件绝对路径（主进程自己反解出来的，不信渲染层传的任意路径）
 *   offset      源文件里的起点（片段 offset + 片内偏移）
 *   duration    要分析的时长
 *   segments    [{ start, end }] —— **相对 offset** 的秒数
 *   modelId     选择哪个识别模型
 * @param {object} deps   { userData, resourcesPath, appPath, mainDir, tempDir }
 * @param {(p:object)=>void} onProgress
 * @param {()=>boolean} shouldCancel
 */
async function transcribe(payload = {}, deps = {}, onProgress, shouldCancel) {
  const segments = (Array.isArray(payload.segments) ? payload.segments : [])
    .map((item) => ({
      start: Math.max(0, Number(item && item.start) || 0),
      end: Math.max(0, Number(item && item.end) || 0)
    }))
    .filter((item) => item.end > item.start + 0.05)

  if (!segments.length) {
    return { ok: false, reason: 'no-segments', error: '没有可识别的时间段' }
  }

  const runtime = runtimeOf(deps)
  if (!runtime.ok) {
    return { ok: false, reason: 'runtime-missing', error: runtime.error, missing: runtime.missing }
  }

  const modelId = String(payload.modelId || '') || status(deps).defaultModel
  const entry = models.byId(modelId)
  if (!entry || entry.group !== 'speech' || entry.kind !== 'model') {
    return { ok: false, reason: 'model-missing', error: '没有这个识别模型', modelId }
  }
  const modelState = models.stateOf(entry, deps)
  if (modelState.source === 'missing') {
    return {
      ok: false,
      reason: 'model-missing',
      error: `${entry.name} 还没装好`,
      modelId,
      missing: modelState.missing
    }
  }

  const bin = ffmpegBin()
  if (!bin) {
    return { ok: false, reason: 'no-ffmpeg', error: '没有找到 ffmpeg，无法读取音频' }
  }

  const sourcePath = String(payload.sourcePath || '')
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, reason: 'bad-input', error: '源文件不存在' }
  }

  const tempDir = deps.tempDir || os.tmpdir()
  const stamp = `${process.pid}-${Date.now().toString(36)}`
  const wavPath = path.join(tempDir, `yjai-speech-${stamp}.wav`)

  let addon = null
  try {
    addon = addonAt(runtime.dir)
  } catch (err) {
    return { ok: false, reason: err.code || 'runtime-broken', error: String(err.message || err) }
  }

  const extracted = await extractWav({
    sourcePath,
    offset: Number(payload.offset) || 0,
    duration: Number(payload.duration) || (segments[segments.length - 1].end + 0.5),
    outPath: wavPath,
    bin
  })
  if (!extracted.ok) {
    try {
      fs.unlinkSync(wavPath)
    } catch {
      /* 没生成就算了 */
    }
    return { ok: false, reason: extracted.reason || 'ffmpeg', error: extracted.error }
  }

  let recognizer = null
  try {
    recognizer = recognizerFor(addon, entry, modelState.dir)
  } catch (err) {
    try {
      fs.unlinkSync(wavPath)
    } catch {
      /* 同上 */
    }
    return { ok: false, reason: 'model-broken', error: `模型加载失败：${String((err && err.message) || err).slice(0, 160)}` }
  }

  let wave = null
  try {
    /* ⚠️ 第二个参数必须是 `false`（不允许外部缓冲）。
       sherpa 的 readWave 默认走 `napi_create_external_arraybuffer`，把 samples 直接映射到
       文件内容上 —— 在 Electron 主进程里这一步会抛 **"External buffers are not allowed"**，
       而错误信息里没有任何线索指向"采样缓冲的实现方式"，看着像文件坏了。
       传 false 让它拷一份普通 ArrayBuffer：多一次内存拷贝（5 分钟音频约 19MB），
       换来的是"在哪都能跑"。这个坑只在真机里跑一次才看得见，纯 Node 自测发现不了。 */
    wave = addon.readWave(wavPath, false)
  } catch (err) {
    return { ok: false, reason: 'bad-wav', error: `读不出音频：${String((err && err.message) || err).slice(0, 120)}` }
  } finally {
    /* wav 只是中间产物：读进内存后立刻删，否则一次识别就在临时目录留一个几十 MB 的文件 */
    try {
      fs.unlinkSync(wavPath)
    } catch {
      /* 删不掉留给系统清理 */
    }
  }

  const samples = wave.samples
  const rate = Number(wave.sampleRate) || SAMPLE_RATE
  const total = segments.length
  const out = []
  const startedAt = Date.now()

  for (let i = 0; i < total; i += 1) {
    if (shouldCancel && shouldCancel()) {
      return { ok: false, reason: 'canceled', error: '已取消', segments: out }
    }
    const seg = segments[i]
    /* 窗口比模型上限长就压到上限：压出来的结果会少字，但比整段被丢好，
       而且上层切句本来就不会切这么长（maxDur 是 8 秒）。 */
    const end = Math.min(seg.end, seg.start + MAX_WINDOW)
    const from = Math.max(0, Math.floor(seg.start * rate))
    const to = Math.min(samples.length, Math.floor(end * rate))
    let text = ''
    if (to - from > rate * 0.05) {
      try {
        const stream = addon.createOfflineStream(recognizer)
        addon.acceptWaveformOffline(stream, { samples: samples.subarray(from, to), sampleRate: rate })
        addon.decodeOfflineStream(recognizer, stream)
        const result = JSON.parse(addon.getOfflineStreamResultAsJson(stream))
        text = cleanText(result && result.text)
      } catch (err) {
        /* 单段失败不该让整条识别归零：把它当"这段没听清"跳过，其余照常 */
        text = ''
      }
    }
    if (text) out.push({ start: Number(seg.start.toFixed(3)), end: Number(end.toFixed(3)), text })
    if (onProgress) {
      onProgress({ done: i + 1, total, text, id: entry.id })
    }
    /* 让出一个事件循环：否则 40 段连着解码，主进程 2 秒不响应 IPC，
       窗口的进度条也就一直停在 0 —— 看起来像卡死。 */
    await new Promise((resolve) => setImmediate(resolve))
  }

  return {
    ok: true,
    model: { id: entry.id, name: entry.name },
    segments: out,
    /* 空白段（没人说话 / 纯音乐）单独报数：否则用户看到"识别成功 0 条"会以为坏了 */
    empty: total - out.length,
    elapsed: Date.now() - startedAt
  }
}

/* ------------------------------ 配音（文字 → 人声） ------------------------------ */

/**
 * 一次合成的字数上限。
 *
 * 不设上限的话，用户粘一整篇文章进来，主进程会**同步阻塞**好几分钟（合成不像识别
 * 那样能按句切开让出事件循环 —— 一句话内部的音节是连续的）。500 字约 3 分钟音频、
 * 1 秒左右合成完，是个既能读完一段口播又不至于卡住界面的量。
 */
const TTS_MAX_CHARS = 500

/** 已建好的合成器，按 `模型目录 + 模型 id` 缓存（131MB 的模型加载一次要几秒） */
const ttsCache = new Map()

/**
 * 把用户输入的文字清成"能读的那一句"。
 *
 * 换行/制表符/连续空格一律压成一个空格：合成器会把换行当成一次长停顿，
 * 而用户从文档里粘过来的段落几乎每个换行后面都还带缩进，
 * 不清的话生成出来的音频开头会有一大段静音（听起来像"没生成"）。
 */
function cleanSpeechText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 校验 + 清洗，合成前唯一的一道闸。
 *
 * 单独抽成纯函数是为了能**脱机自测**：空文本、超长文本这两种拒绝理由
 * 必须和界面上看到的一致，而它们本来夹在 `synthesize` 里，一测就要加载 131MB 模型。
 */
function prepareSpeechText(raw, max = TTS_MAX_CHARS) {
  const text = cleanSpeechText(raw)
  if (!text) return { ok: false, reason: 'empty-text', error: '没有要读的文字', text: '' }
  if (text.length > max) {
    return {
      ok: false,
      reason: 'too-long',
      error: `一次最多读 ${max} 字，这段有 ${text.length} 字：拆成几句分批生成（也正好与字幕一句一句对齐）`,
      text
    }
  }
  return { ok: true, text, chars: text.length }
}

/**
 * 音色包清单（`kind === 'voice'`）。
 *
 * 与识别模型（`kind === 'model'`）分两个查询：界面上"听得见字"和"读得出声"
 * 是两个动作，混在一张表里会让"装了模型为什么还是不能配音"变成一个谜。
 */
function voiceRows(deps = {}) {
  return models
    .list(deps)
    .filter((row) => row.group === 'speech' && row.kind === 'voice')
    .map((row) => ({ ...row, ready: row.source !== 'missing' }))
}

/** 配音 + 识别的整条状态：两者共用运行时，但音色包是另一份文件 */
function voiceStatus(deps = {}) {
  const runtime = runtimeOf(deps)
  const list = voiceRows(deps)
  return {
    ok: true,
    runtime,
    voices: list,
    ready: runtime.ok && list.some((row) => row.ready),
    defaultVoice: (list.find((row) => row.ready) || {}).id || ''
  }
}

/**
 * 建合成器。**同一个模型目录只建一次** —— 131MB 的 onnx 每次重建要 2~3 秒，
 * 用户点三次"生成"就要多等 6 秒。
 */
function ttsFor(addon, entry, dir) {
  const key = `${dir}::${entry.id}`
  const hit = ttsCache.get(key)
  if (hit) return hit

  const onnx = entry.files.find((file) => /\.onnx$/i.test(file.name))
  if (!onnx) {
    const err = new Error('这个音色包里没有 .onnx 模型文件')
    err.code = 'model-broken'
    throw err
  }
  const tokens = path.join(dir, 'tokens.txt')
  const lexicon = path.join(dir, 'lexicon.txt')
  /* 词典目录**有就必须给**：缺了不会报错，只会把多音字全读成默认读音 ——
     表现是"能出声，但听着不对"，用户很难归因到"少了一个词典文件夹"。 */
  const dictDir = entry.files.some((file) => file.name.startsWith('dict/')) ? path.join(dir, 'dict') : ''

  const tts = addon.createOfflineTts({
    model: {
      vits: {
        model: path.join(dir, onnx.name),
        tokens,
        lexicon: fs.existsSync(lexicon) ? lexicon : '',
        dictDir,
        dataDir: ''
      },
      numThreads: Math.max(1, Math.min(4, (os.cpus() || []).length - 1 || 1)),
      provider: 'cpu',
      debug: 0
    },
    ruleFsts: '',
    ruleFars: '',
    maxNumSentences: 1,
    silenceScale: 0.2
  })
  ttsCache.set(key, tts)
  return tts
}

/** 16-bit PCM 单声道 wav（sherpa 给的是 -1..1 的 float 数组） */
function writeWav(file, samples, sampleRate) {
  const rate = Number(sampleRate) || 16000
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, Number(samples[i]) || 0))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  return buf.length
}

/**
 * 合成一段配音，落成 wav 文件。
 *
 * ⚠️ 归一化到 0.89 峰值必须做：实测这个音色包裸输出峰值只有 0.29（约 -10dB），
 *   直接铺在时间线上要用户手动拉两次音量才听得清。统一归一化之后，
 *   "生成出来就能用"—— 也不至于像自动增益那样把底噪一起抬起来（这里没有人声以外的噪声）。
 *
 * @returns {{ok:boolean, path?:string, duration?:number, sampleRate?:number, speakers?:number, peak?:number, elapsed?:number, reason?:string, error?:string}}
 */
function synthesize(payload = {}, deps = {}) {
  const prepared = prepareSpeechText(payload.text)
  if (!prepared.ok) return { ok: false, reason: prepared.reason, error: prepared.error }
  const text = prepared.text

  const runtime = runtimeOf(deps)
  if (!runtime.ok) {
    return { ok: false, reason: 'runtime-missing', error: runtime.error, missing: runtime.missing }
  }

  const wanted = String(payload.voiceId || '') || voiceStatus(deps).defaultVoice
  const entry = models.byId(wanted)
  if (!entry || entry.kind !== 'voice') {
    return { ok: false, reason: 'voice-missing', error: '没有这个音色包', voiceId: wanted }
  }
  const state = models.stateOf(entry, deps)
  if (state.source === 'missing') {
    return { ok: false, reason: 'voice-missing', error: `${entry.name} 还没装好`, voiceId: wanted, missing: state.missing }
  }

  let addon = null
  try {
    addon = addonAt(runtime.dir)
  } catch (err) {
    return { ok: false, reason: err.code || 'runtime-broken', error: String(err.message || err) }
  }

  const startedAt = Date.now()
  let tts = null
  try {
    tts = ttsFor(addon, entry, state.dir)
  } catch (err) {
    return { ok: false, reason: 'model-broken', error: `音色包加载失败：${String((err && err.message) || err).slice(0, 160)}` }
  }

  const speed = Math.min(2, Math.max(0.5, Number(payload.speed) || 1))
  let audio = null
  try {
    /* ⚠️ 只接受 2 个参数：`(tts, { text, sid, speed })`。
       写成 `(tts, text, sid, speed)` 会抛 "Expect only 2 arguments. Given: 4" ——
       这个错至少指得清，比"合成了没声音"好查。 */
    audio = addon.offlineTtsGenerate(tts, { text, sid: Number(payload.sid) || 0, speed })
  } catch (err) {
    return { ok: false, reason: 'tts', error: `合成失败：${String((err && err.message) || err).slice(0, 160)}` }
  }

  const samples = audio && audio.samples
  if (!samples || !samples.length) return { ok: false, reason: 'silent', error: '合成结果是空的' }

  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i])
    if (v > peak) peak = v
  }
  if (peak > 0.02) {
    const gain = 0.89 / peak
    for (let i = 0; i < samples.length; i += 1) samples[i] = samples[i] * gain
  }

  const sampleRate = Number(audio.sampleRate) || addon.getOfflineTtsSampleRate(tts)
  const root = deps.userData ? path.join(String(deps.userData), 'voice') : path.join(os.tmpdir(), 'yjai-voice')
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const outPath = path.join(root, `voice-${stamp}.wav`)
  try {
    writeWav(outPath, samples, sampleRate)
  } catch (err) {
    return { ok: false, reason: 'io', error: `写不出配音文件：${String((err && err.message) || err).slice(0, 160)}` }
  }

  return {
    ok: true,
    path: outPath,
    duration: Number((samples.length / sampleRate).toFixed(3)),
    sampleRate,
    speakers: addon.getOfflineTtsNumSpeakers(tts),
    chars: text.length,
    peak: Number((peak * (peak > 0.02 ? 0.89 / peak : 1)).toFixed(3)),
    elapsed: Date.now() - startedAt,
    voice: { id: entry.id, name: entry.name }
  }
}

/* ------------------------------ AI 降噪（语音增强） ------------------------------ */

/** 降噪模型的安装状态（界面上"点了会不会自动下载"就看它） */
function denoiseStatus(deps = {}) {
  const entry = models.byId('speech-denoiser')
  if (!entry) return { ok: false, ready: false, error: '注册表里没有降噪模型' }
  const state = models.stateOf(entry, deps)
  const runtime = runtimeOf(deps)
  return {
    ok: true,
    /* 运行时和模型缺一不可：只装模型跑不起来，只装运行时没东西可跑 */
    ready: state.source !== 'missing' && runtime.ok,
    runtimeOk: runtime.ok,
    source: state.source,
    missing: state.missing,
    runtimeMissing: runtime.missing || [],
    model: { id: entry.id, name: entry.name, size: entry.files.reduce((n, f) => n + Number(f.bytes || 0), 0) }
  }
}

function denoiserAt(addon, entry, dir) {
  if (denoiserCache && denoiserCache.dir === dir) return denoiserCache.denoiser
  const onnx = entry.files.find((file) => /\.onnx$/i.test(file.name))
  if (!onnx) {
    const err = new Error('这个降噪模型包里没有 .onnx 文件')
    err.code = 'model-broken'
    throw err
  }
  const denoiser = addon.createOfflineSpeechDenoiser({
    model: {
      gtcrn: { model: path.join(dir, onnx.name) },
      numThreads: Math.max(1, Math.min(4, (os.cpus() || []).length - 1 || 1)),
      provider: 'cpu',
      debug: 0
    }
  })
  denoiserCache = { dir, denoiser }
  return denoiser
}

/** 跑 ffmpeg 只做格式转换（降噪后 16k → 成片要的 48k 立体声） */
function transcode({ from, to, bin }) {
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ['-hide_banner', '-y', '-loglevel', 'error', '-i', from, '-ar', '48000', '-ac', '2', '-acodec', 'pcm_s16le', to],
      { windowsHide: true }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-2000)
    })
    child.on('error', (err) => resolve({ ok: false, error: `调不起 ffmpeg：${err.message}` }))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: (stderr.trim().split('\n').pop() || `ffmpeg 退出码 ${code}`).slice(0, 200) })
        return
      }
      resolve({ ok: true })
    })
  })
}

/**
 * 把一段音视频里的人声降噪，落成一个 wav。
 *
 * 为什么输出 48kHz 立体声而不是直接给 16k：
 *   · 16k 是**模型的**工作采样率，不是成片的；时间线上其余素材是 44.1/48k，
 *     混进一条 16k 会让 ffmpeg 在混音时对每个片段的采样率各做一次转换，
 *     而其中一段的转换参数不同就会让**整条音轨的时长**跟着变。
 *   · 单声道转立体声是为了不让它在耳机里只从左边出来（时间线默认按立体声混）。
 *
 * @returns {{ok:boolean, path?:string, duration?:number, elapsed?:number, reducedDb?:number, reason?:string, error?:string}}
 */
async function denoise(payload = {}, deps = {}, onProgress) {
  const state = denoiseStatus(deps)
  if (!state.ready) {
    const entry = models.byId('speech-denoiser')
    const modelState = entry ? models.stateOf(entry, deps) : { source: 'missing', missing: [] }
    if (!state.runtimeOk) {
      return { ok: false, reason: 'runtime-missing', error: state.error || '语音运行时没装', missing: state.runtimeMissing }
    }
    return {
      ok: false,
      reason: 'model-missing',
      error: 'AI 降噪模型还没装（0.5MB）',
      modelId: 'speech-denoiser',
      missing: modelState.missing
    }
  }

  const entry = models.byId('speech-denoiser')
  const modelState = models.stateOf(entry, deps)

  const bin = ffmpegBin()
  if (!bin) return { ok: false, reason: 'no-ffmpeg', error: '没有找到 ffmpeg，无法读取音频' }

  const sourcePath = String(payload.sourcePath || '')
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, reason: 'bad-input', error: '源文件不存在' }
  }

  const tempDir = deps.tempDir || os.tmpdir()
  const stamp = `${process.pid}-${Date.now().toString(36)}`
  const rawPath = path.join(tempDir, `yjai-dn-in-${stamp}.wav`)
  const cleanPath = path.join(tempDir, `yjai-dn-out-${stamp}.wav`)

  let addon = null
  try {
    addon = addonAt(runtimeOf(deps).dir)
  } catch (err) {
    return { ok: false, reason: err.code || 'runtime-broken', error: String(err.message || err) }
  }

  /* 只处理**这一段**：时间线上的片段是"源文件的 [offset, offset+duration)"，
     整文件降噪会让一个 10 分钟的源在只用了 3 秒时也处理 10 分钟。 */
  const offset = Math.max(0, Number(payload.offset) || 0)
  const duration = Math.max(0, Number(payload.duration) || 0)
  const extracted = await extractWav({
    sourcePath,
    offset,
    duration: duration || 1e6,
    outPath: rawPath,
    bin
  })
  if (!extracted.ok) {
    try {
      fs.unlinkSync(rawPath)
    } catch {
      /* 没生成就算了 */
    }
    return { ok: false, reason: extracted.reason || 'ffmpeg', error: extracted.error }
  }

  let denoiser = null
  try {
    denoiser = denoiserAt(addon, entry, modelState.dir)
  } catch (err) {
    try {
      fs.unlinkSync(rawPath)
    } catch {
      /* 同上 */
    }
    return { ok: false, reason: 'model-broken', error: `降噪模型加载失败：${String((err && err.message) || err).slice(0, 160)}` }
  }

  let wave = null
  try {
    /* 第二个参数 false 的原因见 transcribe()：Electron 主进程不允许外部 ArrayBuffer */
    wave = addon.readWave(rawPath, false)
  } catch (err) {
    return { ok: false, reason: 'bad-wav', error: `读不出音频：${String((err && err.message) || err).slice(0, 120)}` }
  } finally {
    try {
      fs.unlinkSync(rawPath)
    } catch {
      /* 留给系统清理 */
    }
  }

  const input = wave.samples
  if (!input || !input.length) return { ok: false, reason: 'silent', error: '这一段没有可处理的声音' }

  const startedAt = Date.now()
  let out = null
  try {
    out = addon.offlineSpeechDenoiserRunWrapper(denoiser, {
      samples: input,
      sampleRate: Number(wave.sampleRate) || SAMPLE_RATE,
      /* ⚠️ 与 readWave 的第二个参数是**同一个坑的两道门**：sherpa 默认把 samples 用
         `napi_create_external_arraybuffer` 直接映射过去，而 Electron 主进程不允许外部
         ArrayBuffer —— 报的是 "External buffers are not allowed"，一个字都不提采样率。
         纯 Node 下跑（比如 POC 脚本）不会触发，只有真机 E2E 才看得见。 */
      enableExternalBuffer: false
    })
  } catch (err) {
    return { ok: false, reason: 'denoise', error: `降噪失败：${String((err && err.message) || err).slice(0, 160)}` }
  }
  if (!out || !out.samples || !out.samples.length) return { ok: false, reason: 'silent', error: '降噪结果是空的' }

  /* ⚠️ 按输入长度补齐：模型收尾时按帧截断，实测 3 秒会少 128 个采样（8ms）。
     不补的话每段成片都短一点点，连续几段之后音画就对不上了。 */
  const n = input.length
  const samples = new Float32Array(n)
  samples.set(out.samples.subarray(0, Math.min(n, out.samples.length)))

  let sumIn = 0
  let sumOut = 0
  for (let i = 0; i < n; i += 1) {
    sumIn += input[i] * input[i]
    sumOut += samples[i] * samples[i]
  }
  const rms = (sum) => Math.sqrt(sum / Math.max(1, n))
  const reducedDb = sumIn > 0 && sumOut > 0 ? Number((20 * Math.log10(rms(sumIn) / rms(sumOut))).toFixed(1)) : 0

  if (onProgress) onProgress({ stage: 'denoise', done: 1, total: 1 })

  const root = deps.userData ? path.join(String(deps.userData), 'denoise') : path.join(os.tmpdir(), 'yjai-denoise')
  const outPath = path.join(root, `denoise-${stamp}.wav`)
  try {
    /* 先落 16k 单声道，再交给 ffmpeg 升采样 —— 让 writeWav 保持"只写它拿到的采样率"这一件事，
       重采样的参数全在一处（transcode 的 -ar/-ac）。 */
    fs.mkdirSync(path.dirname(cleanPath), { recursive: true })
    writeWav(cleanPath, samples, Number(out.sampleRate) || SAMPLE_RATE)
    fs.mkdirSync(root, { recursive: true })
  } catch (err) {
    return { ok: false, reason: 'io', error: `写不出降噪文件：${String((err && err.message) || err).slice(0, 160)}` }
  }

  const converted = await transcode({ from: cleanPath, to: outPath, bin })
  try {
    fs.unlinkSync(cleanPath)
  } catch {
    /* 中间产物删不掉不影响结果 */
  }
  if (!converted.ok) return { ok: false, reason: 'ffmpeg', error: converted.error }

  return {
    ok: true,
    path: outPath,
    duration: Number((n / (Number(out.sampleRate) || SAMPLE_RATE)).toFixed(3)),
    sampleRate: 48000,
    reducedDb,
    elapsed: Date.now() - startedAt
  }
}

module.exports = {
  SAMPLE_RATE,
  TTS_MAX_CHARS,
  runtimeOf,
  modelRows,
  status,
  transcribe,
  voiceRows,
  voiceStatus,
  synthesize,
  denoise,
  denoiseStatus,
  cleanSpeechText,
  prepareSpeechText,
  resetCache,
  cleanText
}
