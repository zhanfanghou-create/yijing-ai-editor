/**
 * 本地 AI 模型管理（下载 / 导入 / 校验 / 删除）。
 *
 * 为什么要有这一层：
 *   本机推理（人物特效的人脸关键点）依赖三个文件 —— 加载器 .js、运行时 .wasm、
 *   模型 .task。现在它们跟着安装包走（`resources/mediapipe`），这带来两个死结：
 *     ① 安装包被这三个文件撑大 18 MB，而多数人一次都用不到人物特效；
 *     ② 模型是"可以在包外更新的"，随包就等于**永远锁在发版那一天**。
 *   所以改成「随包优先、可在本机覆盖」：
 *     `<userData>/models/<id>/` 里有完整的一套就用它，否则回落到随包目录。
 *   这样一条路是"没随包也能装上"，另一条是"随包了也能换新"。
 *
 * ⚠️ 三个文件缺一不可，且**报错长得一模一样**（见 facefx.js 顶部注释）。
 *    所以这里的 state 一次把缺的列全（`missing`），面板据此说"缺哪几个"，
 *    而不是笼统的"加载失败"。
 *
 * ⚠️ 下载写盘必须**先写 `.part` 再改名**：直接写目标文件的话，中途断网会留下一个
 *    尺寸不对却"看起来存在"的文件 —— 之后每次都判定为已安装，推理时才炸。
 *    这是这一类"下载器"最典型的静默失效。
 *
 * ⚠️ 断网之后**必须能接着下**（`.part` + Range），否则 228MB 的多语种模型在慢网下
 *    等于永远装不上：每次抖一下都从 0 开始，用户看到的是"下载条来回跳"。
 *
 * ⚠️ 走 `node:https` 就**必须自己处理代理**（见 proxyTunnel.js）：Node 不读
 *    `https_proxy`、也不看 Windows 系统代理。原样直连的表现是
 *    "curl 能下、应用下不动"，用户根本无从判断是网还是软件。
 *
 * 本文件是**纯 Node**（只用 fs / path / http / https），不 require electron：
 * 这样它能脱机自测（tools/models-selftest.mjs），也能被 MCP 侧复用。
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const proxyTunnel = require('./proxyTunnel')

/**
 * 模型注册表。
 *
 * 每条 = 一个**运行时组件**（可能是多个文件），字段：
 *   id       稳定标识，也是本机安装目录名
 *   name     界面上显示的名字
 *   purpose  一句话说明它给哪个功能用（不写套话，写"能做什么"）
 *   license  许可证（界面上要显示 —— 用户有权知道装进来的是什么）
 *   bundle   随包目录名（`resources/<bundle>`）；没有随包版本的写空串
 *   group    设置页里的分组：`facefx`（人物特效）/ `speech`（语音识别）
 *   kind     `runtime` 是跑推理的本体，`model` 是权重；界面上要分开摆，
 *            因为"没装运行时"和"没装模型"是两种完全不同的补救动作
 *   files    文件清单，每个 { name, bytes, url, alt }
 *
 * ⚠️ 只登记**真的在被代码使用**的组件。登记一个没有功能消费它的模型，
 *    界面上就会多一个"下载了也没用"的按钮 —— 那比不登记更糟。
 *
 * ⚠️ `bytes` 是**硬校验**（promote() 体积不符直接删掉报错）。填之前必须量过真文件，
 *    不能按 MB 数拍脑袋 —— 差一个字节就会被判成"下载被截断"，而这个错
 *    只在用户点下载时才出现。
 */
/**
 * HuggingFace 上的同一个文件有三个入口，按「国内可达性」排序。
 *
 * 三个而不是一个，是 2026-11-06 同一个上午量出来的：
 *   · `hf-mirror.com` 是 HF 的全量镜像，但会整段抽风 —— 同一小时里
 *     一次 8 秒超时、一次正常回 206；
 *   · `hf-mirror.net` 在 .com 抽风那一轮 **5.7 秒**内正常返回 206，是真正的备用；
 *   · `huggingface.co` 在国内多数家用网络下被 DNS 污染成 108.160.x.x（直连 ETIMEDOUT），
 *     只对挂了代理或人在境外的用户有意义，所以排最后。
 *
 * 顺序不能反：下载器对每个地址重试 2 次、每次超时 30 秒，官方源排第一 =
 * 让国内用户先白等 60 秒才轮到镜像。
 *
 * ⚠️ 三个地址必须指向**同一个仓库路径**。否则会下到不同版本的文件，
 *    而体积校验只发现得了「字节数不同」，发现不了「字节数刚好一样」——
 *    那会装出一个能加载、但识别结果是乱码的模型。
 */
function hf(pathname) {
  return {
    url: `https://hf-mirror.com/${pathname}`,
    alt: [`https://hf-mirror.net/${pathname}`, `https://huggingface.co/${pathname}`]
  }
}

const REGISTRY = [
  {
    id: 'face-runtime',
    name: '人物特效 · 人脸关键点',
    purpose: '识别人脸关键点，让打码、提亮、描边跟着脸走',
    license: 'Apache-2.0',
    group: 'facefx',
    kind: 'runtime',
    bundle: 'mediapipe',
    files: [
      {
        name: 'vision_wasm_internal.js',
        bytes: 334128,
        /* wasm 运行时**没有**独立下载地址：它随 npm 包 `@mediapipe/tasks-vision` 发行，
           本地那份就是 tools/fetch-mediapipe.mjs 从 node_modules 里拷出来的。
           所以这里指向这个包的 CDN —— 版本号必须与 package.json 里的一致，
           否则拿到的 wasm 与加载器 ABI 不匹配，症状是 WebAssembly 编译失败。 */
        url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm/vision_wasm_internal.js'
      },
      {
        name: 'vision_wasm_internal.wasm',
        bytes: 14466654,
        url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm/vision_wasm_internal.wasm'
      },
      {
        name: 'face_landmarker.task',
        bytes: 3758596,
        url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
      }
    ]
  },

  /* ============================ 语音识别（本机推理） ============================
   *
   * 2026-11-03 Jason：「字幕识别等 AI 相关功能…打通支持本地模型下载配置」。
   *
   * 推理本体是 sherpa-onnx（Apache-2.0，k2-fsa/sherpa-onnx）的 Node N-API 插件。
   * 选它而不是 whisper.cpp 的三条硬理由：
   *   ① 官方发布的 Windows 包是 **x64**；whisper.cpp 近几版只发 32 位（Win32）包，
   *      32 位进程地址空间装不下 1.5GB 的 medium 模型 —— 那是"能装不能跑"；
   *   ② 它是 N-API 插件，不依赖 Electron 的 ABI，主进程直接 require 就能用，
   *      不需要 electron-rebuild，也不需要把 node_modules 塞进安装包；
   *   ③ 中文效果出自 FunASR 系（Paraformer / SenseVoice），比 whisper 小模型强得多，
   *      而体积只有 78MB / 228MB。
   *
   * ⚠️ 运行时走 **CDN 单文件**（jsDelivr 直出 npm 包里的文件），不打包 .tgz：
   *    这样它就能和模型共用同一套"逐文件下载 + 体积校验"，不需要额外实现 tar 解包
   *    （本项目没有打包阶段的解压依赖，自己写 tar 解析等于多一份只能靠外部验证的代码）。
   *    jsDelivr 单文件上限 20MB，这里最大的 onnxruntime.dll 是 16.97MB —— 贴着上限，
   *    所以换版本号之前**必须**先 HEAD 一次确认还发得出来，别再往大里换。
   */
  {
    id: 'speech-runtime',
    name: '语音识别运行时',
    purpose: '跑本机语音识别所需的核心库；不装它，识别功能点了没反应',
    license: 'Apache-2.0',
    group: 'speech',
    kind: 'runtime',
    /* 随包目录：与 mediapipe 同一套机制。打包机上 `node tools/fetch-speech.mjs`
       抓一份放进 resources/speech，装完即用；没抓也能下载。 */
    bundle: 'speech',
    files: [
      {
        name: 'onnxruntime.dll',
        bytes: 17799168,
        url: 'https://cdn.jsdelivr.net/npm/sherpa-onnx-win-x64@2.0.1/onnxruntime.dll'
      },
      {
        name: 'onnxruntime_providers_shared.dll',
        bytes: 104960,
        url: 'https://cdn.jsdelivr.net/npm/sherpa-onnx-win-x64@2.0.1/onnxruntime_providers_shared.dll'
      },
      {
        name: 'sherpa-onnx-c-api.dll',
        bytes: 4294656,
        url: 'https://cdn.jsdelivr.net/npm/sherpa-onnx-win-x64@2.0.1/sherpa-onnx-c-api.dll'
      },
      {
        name: 'sherpa-onnx-cxx-api.dll',
        bytes: 264192,
        url: 'https://cdn.jsdelivr.net/npm/sherpa-onnx-win-x64@2.0.1/sherpa-onnx-cxx-api.dll'
      },
      {
        /* 插件本体放**最后**：它一旦在位，stateOf() 就只剩前四个决定"能不能用"，
           而按序下载时最后落的正是它 —— 用户中途取消也不会留下一个"看起来装好了"的目录。 */
        name: 'sherpa-onnx.node',
        bytes: 697344,
        url: 'https://cdn.jsdelivr.net/npm/sherpa-onnx-win-x64@2.0.1/sherpa-onnx.node'
      }
    ]
  },
  {
    id: 'speech-paraformer',
    name: '中文语音识别 · 轻量',
    purpose: '78MB 就能把中文说话内容转成字幕文字，识别一段 1 分钟素材约 1 秒',
    license: 'Apache-2.0',
    group: 'speech',
    kind: 'model',
    bundle: '',
    files: [
      {
        name: 'model.int8.onnx',
        bytes: 81828675,
        ...hf('csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/model.int8.onnx')
      },
      {
        name: 'tokens.txt',
        bytes: 75352,
        ...hf('csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/tokens.txt')
      }
    ]
  },
  {
    id: 'speech-sensevoice',
    name: '多语种语音识别',
    purpose: '中英日韩粤混说也能转写，带断句与语气；体积 228MB，质量比轻量版更好',
    license: 'Apache-2.0',
    group: 'speech',
    kind: 'model',
    bundle: '',
    files: [
      {
        name: 'model.int8.onnx',
        bytes: 239233841,
        ...hf('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx')
      },
      {
        name: 'tokens.txt',
        bytes: 315894,
        ...hf('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt')
      }
    ]
  },
  {
    /* 配音音色包：把文字读成人声（本机合成，不出本机）。
       ⚠️ 与识别模型是**两种不同的东西**：识别是「声音 → 文字」，配音是「文字 → 声音」。
          共用同一个运行时（sherpa-onnx.node），所以装了运行时就不用再装别的东西。

       ⚠️ 许可必须如实写：这个音色包的模型页**没有声明许可**。我们不把它打进安装包，
          只在用户点「下载」时从原仓库取，界面上把来源仓库一并显示出来 ——
          用户可以自己判断要不要装。标成 Apache-2.0 是错的（那会误导用户以为可商用）。 */
    id: 'speech-voice-zh',
    name: '中文配音 · 女声（16kHz）',
    purpose: '把字幕或任意文字读成人声，直接生成一条配音音轨；合成在本机完成',
    license: '模型页未声明（从原仓库下载，仅在本机使用）',
    group: 'speech',
    kind: 'voice',
    bundle: '',
    files: [
      {
        name: 'vits-zh-hf-fanchen-C.onnx',
        bytes: 121266652,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/vits-zh-hf-fanchen-C.onnx')
      },
      {
        name: 'tokens.txt',
        bytes: 331,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/tokens.txt')
      },
      {
        name: 'lexicon.txt',
        bytes: 2457843,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/lexicon.txt')
      },
      /* 下面 8 个是分词用的 jieba 词典。缺了它不会报错，只会把多音字全读成默认读音 ——
         典型的"能出声但听着不对"，所以我方一律按完整清单校验。 */
      {
        name: 'dict/jieba.dict.utf8',
        bytes: 5071204,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/jieba.dict.utf8')
      },
      {
        name: 'dict/hmm_model.utf8',
        bytes: 519739,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/hmm_model.utf8')
      },
      {
        name: 'dict/user.dict.utf8',
        bytes: 49,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/user.dict.utf8')
      },
      {
        name: 'dict/idf.utf8',
        bytes: 5998717,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/idf.utf8')
      },
      {
        name: 'dict/stop_words.utf8',
        bytes: 8974,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/stop_words.utf8')
      },
      {
        name: 'dict/pos_dict/char_state_tab.utf8',
        bytes: 327139,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/pos_dict/char_state_tab.utf8')
      },
      {
        name: 'dict/pos_dict/prob_emit.utf8',
        bytes: 1687686,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/pos_dict/prob_emit.utf8')
      },
      {
        name: 'dict/pos_dict/prob_start.utf8',
        bytes: 4347,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/pos_dict/prob_start.utf8')
      },
      {
        name: 'dict/pos_dict/prob_trans.utf8',
        bytes: 124159,
        ...hf('csukuangfj/vits-zh-hf-fanchen-C/resolve/main/dict/pos_dict/prob_trans.utf8')
      }
    ]
  },

  /* ============================ 音频增强（本机推理） ============================
   *
   * 2026-11-02 Jason：「我们没有的你在后台补」。这一条是白捡的 —— 语音识别的运行时
   * （sherpa-onnx）本来就导出了 `createOfflineSpeechDenoiser`，我们只用了它的识别与合成。
   * 补上模型就能用，不需要任何新依赖。
   *
   * gtcrn 是 0.5MB 的轻量降噪网（Apache-2.0），实测 3 秒 16k 音频耗 109ms（约 27× 实时），
   * 加工 1 分钟素材不到 3 秒。代价是它工作在 **16kHz 单声道**：8kHz 以上的人声谐波会丢，
   * 听感接近"电话音质"。所以它只适合"噪声太大、先求听清"的素材，
   * 干净素材开了反而变闷 —— 界面上要写明，不能当成默认开的开关。
   *
   * ⚠️ 输出比输入少 128 个采样（8ms）：模型按帧收尾时截掉了不足一帧的尾巴。
   *    拼回时间线时必须按输入长度补齐，否则片段末尾会短 8ms，
   *    多段拼起来后音画逐段错位（这是"每段只差一点点"那类最难查的问题）。
   */
  {
    id: 'speech-denoiser',
    name: 'AI 语音降噪',
    purpose: '压掉环境噪声、风噪、键盘声，让人声更清楚；0.5MB，1 分钟音频约 3 秒',
    license: 'Apache-2.0',
    group: 'audio',
    kind: 'denoiser',
    bundle: '',
    files: [
      {
        name: 'gtcrn_simple.onnx',
        /* 535638 是实测值（HEAD 跟完重定向取到的 content-length，下载后按字节核过）。
           注册表的体积是**硬校验**：写错一个字节，用户点下载就会得到"文件被截断"。 */
        bytes: 535638,
        /* 镜像在前、官方源在后（2026-11-03 实测，与"官方优先"的直觉相反）：
           本机连 github.com **恒不可达** —— 直连 3 次全 000/12s 超时，连走代理也 exit 7，
           而下载器用的是 node:https（不认 https_proxy）⇒ 只留官方源等于国内用户装不上。
           两个镜像各下一次的 sha256 完全一致（e77603ac0c23dac3227dd2d7135b3a58），
           字节数与上面的 bytes 相同 ⇒ 拿到的是原文件，不是错误页。
           顺序也不能反：fetchTo 超时 30s × 重试 2 次，先试官方源会让用户干等 60 秒
           才轮到镜像 —— 0.5MB 的文件这样"半天不动"，人就直接以为坏了。 */
        url: 'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx',
        alt: [
          'https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx',
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx'
        ]
      }
    ]
  },

  /* ============================ 智能抠像（人像分割） ============================
   *
   * 与人物特效**共用同一份 wasm 运行时**（`resources/mediapipe` 的
   * vision_wasm_internal.js/.wasm）—— MediaPipe 的 `ImageSegmenter` 与
   * `FaceLandmarker` 是同一个 wasm 里的两个 task，模块本身 14.4MB，
   * 所以这里只登记**模型**一个文件，不再重复占一份运行时。
   *
   * 模型选型：`selfie_segmenter` 249537 字节（实测），二分类（人 / 背景），
   * 264×264 内部输入，实测 640×640 底图推理 209ms（纯 CPU、`--disable-gpu`）。
   * 为什么不用 16MB 的 multiclass：它能分头发/皮肤/衣服，但代价是 60 倍体积与
   * 明显更慢的逐帧速度，而"把人抠出来"这个动作本身不需要分那么细。
   * 为什么不用 deeplab_v3（2.7MB，21 类通用物体）：官方 float32 版本在当前
   * tasks-vision 1.2.0 下直接被判 `not a valid Flatbuffer buffer`，跑不起来 ——
   * 登记一个装了也跑不了的模型比不登记更糟。
   */
  {
    id: 'matte-person',
    name: '智能抠像 · 人像',
    purpose: '把人和背景分开，抠出来的主体能叠到任何画面上；0.25MB，一张 640×640 约 0.2 秒',
    license: 'Apache-2.0',
    group: 'matte',
    kind: 'model',
    bundle: '',
    files: [
      {
        name: 'selfie_segmenter.tflite',
        bytes: 249537,
        url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'
      }
    ]
  }
]

const byId = (id) => REGISTRY.find((entry) => entry.id === String(id || '')) || null

/** 本机安装根目录（`<userData>/models`） */
function modelsRootOf({ userData } = {}) {
  return userData ? path.join(String(userData), 'models') : ''
}

/** 某个组件的本机安装目录 */
function installDirOf(entry, deps = {}) {
  const root = modelsRootOf(deps)
  return root && entry ? path.join(root, entry.id) : ''
}

/**
 * 随包根目录。与 facefx.js 的 faceRootOf 同一套候选顺序，
 * 但判据可以**只要求目录存在**：这里的清单来自注册表，不需要探测。
 */
function bundleRootOf(entry, { resourcesPath, appPath, mainDir } = {}) {
  if (!entry || !entry.bundle) return ''
  const candidates = []
  if (resourcesPath) candidates.push(path.join(String(resourcesPath), entry.bundle))
  if (mainDir) candidates.push(path.resolve(String(mainDir), '..', '..', 'resources', entry.bundle))
  if (appPath) candidates.push(path.join(String(appPath), 'resources', entry.bundle))
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir
    } catch {
      /* 权限 / 路径非法：当作这处没有 */
    }
  }
  return ''
}

/** 文件大小；不存在返回 -1（用来区分"没有"和"有但是空的"） */
function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return -1
  }
}

/** 目录里这套文件齐不齐，返回缺失的文件名数组 */
function missingIn(dir, entry) {
  if (!dir) return entry.files.map((item) => item.name)
  return entry.files
    .filter((item) => sizeOf(path.join(dir, item.name)) <= 0)
    .map((item) => item.name)
}

/**
 * 一个组件的状态。
 *
 * source 三档：
 *   'local'   本机目录里完整 —— 生效的就是它
 *   'bundled' 随包里完整 —— 生效的是随包那份
 *   'missing' 两处都不完整 —— 功能不可用
 */
function stateOf(entry, deps = {}) {
  const installDir = installDirOf(entry, deps)
  const bundleDir = bundleRootOf(entry, deps)

  const localMissing = missingIn(installDir, entry)
  if (installDir && localMissing.length === 0) {
    return {
      source: 'local',
      dir: installDir,
      missing: [],
      bytes: entry.files.reduce((n, item) => n + sizeOf(path.join(installDir, item.name)), 0)
    }
  }

  const bundleMissing = missingIn(bundleDir, entry)
  if (bundleDir && bundleMissing.length === 0) {
    return {
      source: 'bundled',
      dir: bundleDir,
      missing: [],
      bytes: entry.files.reduce((n, item) => n + sizeOf(path.join(bundleDir, item.name)), 0)
    }
  }

  return {
    source: 'missing',
    dir: installDir || bundleDir,
    /* 报"还缺什么"用**本机目录**的缺口：用户点了下载，补齐的就是这里 */
    missing: localMissing,
    bytes: 0
  }
}

/** 界面上要的一整张表 */
function list(deps = {}) {
  return REGISTRY.map((entry) => {
    const state = stateOf(entry, deps)
    const installDir = installDirOf(entry, deps)
    return {
      id: entry.id,
      name: entry.name,
      purpose: entry.purpose,
      license: entry.license,
      group: entry.group || 'other',
      kind: entry.kind || 'model',
      /* 期望体积 = 注册表里的标称值；实际体积 = 磁盘上那份 */
      size: entry.files.reduce((n, item) => n + Number(item.bytes || 0), 0),
      bytes: state.bytes,
      source: state.source,
      dir: state.dir,
      missing: state.missing,
      files: entry.files.map((item) => ({
        name: item.name,
        bytes: Number(item.bytes || 0),
        /* "这一份在本机目录里" —— 随包那份不算，因为删除操作动不到它 */
        installed: Boolean(installDir) && sizeOf(path.join(installDir, item.name)) > 0
      })),
      /* 能不能下：注册表里有 url 才算能下 */
      downloadable: entry.files.every((item) => Boolean(item.url))
    }
  })
}

/**
 * 一个文件的一次传输尝试：跟随重定向 → 挂代理 → 按 Range 续写/重写 → 落盘。
 *
 * 四件事挤在一个函数里，是因为它们互相牵制：
 *   ① 重定向 —— HF 镜像会 302 到 CDN，必须跟着走（每一跳的 scheme 还可能不同）；
 *   ② 续传 —— 有 `.part` 就带 Range：206 追加、200 重写、416 从头来；
 *   ③ 代理 —— 是否走隧道由 proxyTunnel 决定，这里只负责挂 agent；
 *   ④ 落盘 —— 写 tmp，等 'close' 而不是 'finish'（Windows 上 'finish' 时 fd 还没关，
 *      此时 rename 会 EBUSY，症状是"下载完成但文件不见了"）。
 *
 * @returns {Promise<{written:number,total:number,etag:string,resumedFrom:number}>}
 */
function transfer(url, opts = {}) {
  /* rangeEnd >= 0 表示"只要这一段"（分段并发用）。不传就是"从 startAt 到文件末尾"，
     单流下载与分段下载共用同一份重定向/续传/落盘逻辑 —— 两份实现早晚会走偏。 */
  const {
    proxy,
    tmp,
    startAt = 0,
    rangeEnd = -1,
    etag = '',
    onProgress,
    onHeaders,
    /* 停滞看门狗：**看的是字节数，不是"有没有数据"**。
       30 秒的 socket 空闲超时只能抓"完全没动静"，抓不到"每秒挤几个字节"——
       本机实测 4 路并发里有一路十分钟只收到 123KB（其余三路各下了十几 MB），
       而它一直"有数据"，超时永不触发，整次下载被这一路拖着。
       判据：连续 stallMs 内新增不足 stallBytes ⇒ 判停滞，掐断，交给上层续传。 */
    stallMs = 45000,
    stallBytes = 64 * 1024
  } = opts
  return new Promise((resolve, reject) => {
    let hops = 0

    const go = (currentUrl) => {
      let target
      try {
        target = new URL(currentUrl)
      } catch {
        reject(new Error(`地址不合法：${currentUrl}`))
        return
      }
      const secure = target.protocol === 'https:'
      const lib = secure ? https : http
      const headers = {
        'User-Agent': 'YJAI-ModelManager',
        /* 必须显式要 identity：一旦服务器压 gzip，content-length 是**压缩后**的长度，
           拿它当总字节数会让进度条永远走不满，续传偏移也会错位（解压后字节数不同）。 */
        'Accept-Encoding': 'identity'
      }
      if (startAt > 0 || rangeEnd >= 0) {
        headers.Range = rangeEnd >= 0 ? `bytes=${startAt}-${rangeEnd}` : `bytes=${startAt}-`
        // If-Range：文件在两次尝试之间换了版本时，服务器该回 200（整份重发）而不是 206（拼接）
        if (etag) headers['If-Range'] = etag
      }

      const req = lib.get(currentUrl, { headers, timeout: 30000, agent: proxyTunnel.agentFor(proxy, secure) }, (res) => {
        const code = res.statusCode || 0

        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          hops += 1
          if (hops > 5) {
            reject(new Error('重定向次数过多'))
            return
          }
          go(new URL(res.headers.location, currentUrl).toString())
          return
        }

        if (code === 416) {
          // 手里的字节比服务器上的文件还长（或文件换了）：只能从头来
          res.resume()
          const err = new Error('服务器不接受断点续传（416）')
          err.code = 'RANGE_REJECTED'
          reject(err)
          return
        }

        if (code !== 200 && code !== 206) {
          res.resume()
          reject(new Error(`服务器返回 ${code}`))
          return
        }

        let base = 0
        let total = 0
        if (rangeEnd >= 0 && code !== 206) {
          /* 分段请求拿回 200 = 服务器把**整份**发过来了。写进这一段的文件里，
             拼装时就变成"每一段都是整个文件"——长度对、内容全错。
             这种情形必须当场判死，交给上面退回单流。 */
          res.resume()
          const err = new Error('服务器没有按分段返回（不是 206）')
          err.code = 'RANGE_REJECTED'
          reject(err)
          return
        }
        if (code === 206) {
          const range = String(res.headers['content-range'] || '')
          const m = range.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i)
          if (!m || Number(m[1]) !== startAt) {
            /* 服务器给的分段不是我们要的那一段（中间层改写、或文件变了）。
               拼下去就是错位 —— 这种文件能通过体积校验，但推理时输出乱码。 */
            res.resume()
            const err = new Error(`服务器返回的分段不符（要 ${startAt}-，给 ${range || '空'}）`)
            err.code = 'RANGE_REJECTED'
            reject(err)
            return
          }
          base = startAt
          total = m[3] === '*' ? 0 : Number(m[3])
        } else {
          /* 200 = 服务器忽略了 Range（或 If-Range 判定文件已变）⇒ **必须整个重写**。
             这里若按追加写，旧字节会留在开头，得到一份"长度刚好对、内容前后两半"的文件。 */
          base = 0
          total = Number(res.headers['content-length'] || 0)
        }

        if (onHeaders) {
          try {
            onHeaders({ etag: String(res.headers.etag || ''), total, from: base })
          } catch {
            /* 记元信息失败不该中断下载 */
          }
        }

        let received = 0
        let settled = false
        const ok = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        const bad = (err) => {
          if (settled) return
          settled = true
          reject(err)
        }

        const out = fs.createWriteStream(tmp, { flags: base > 0 ? 'a' : 'w' })

        /* 停滞看门狗（判据是"这段时间新增了多少字节"，不是"有没有收到数据"） */
        let lastBytes = 0
        let lastAt = Date.now()
        const watchdog =
          stallMs > 0
            ? setInterval(() => {
                const now = Date.now()
                if (received - lastBytes >= stallBytes) {
                  lastBytes = received
                  lastAt = now
                  return
                }
                if (now - lastAt < stallMs) return
                clearInterval(watchdog)
                const err = new Error(
                  `传输停滞：${Math.round((now - lastAt) / 1000)} 秒只多收了 ${received - lastBytes} 字节`
                )
                err.code = 'STALLED'
                try {
                  out.destroy()
                } catch {
                  /* 已经关了 */
                }
                bad(err)
                res.destroy()
              }, 1000)
            : null
        const stopWatchdog = () => {
          if (watchdog) clearInterval(watchdog)
        }

        res.on('data', (chunk) => {
          received += chunk.length
          if (onProgress) {
            try {
              onProgress(base + received, total)
            } catch {
              /* 进度回调自身抛错不该中断下载 */
            }
          }
        })
        res.on('error', (err) => {
          stopWatchdog()
          out.destroy()
          bad(err)
        })
        /* 对端中途断开：'aborted' 比 'error' 先到，两个都兜住 —— 只兜 error 时
           某些代理的断开方式是"干净关闭"，pipe 会把 out 正常 end 掉，于是被当成下载完成。 */
        res.on('aborted', () => {
          stopWatchdog()
          out.destroy()
          bad(new Error('传输中途被断开'))
        })
        out.on('error', (err) => {
          stopWatchdog()
          bad(err)
        })
        out.on('close', () => {
          stopWatchdog()
          /* want = 这一次"应该"写到多少字节的绝对位置。
             单流是文件总长；分段是段末 +1（total 在 206 里是**整份**长度，
             直接拿它比会永远"被截断"）。 */
          const want = rangeEnd >= 0 ? rangeEnd + 1 : total
          if (want > 0 && base + received < want) {
            bad(new Error(`下载被截断：只到 ${base + received}/${want} 字节`))
            return
          }
          ok({ written: received, total: total || base + received, etag: String(res.headers.etag || ''), resumedFrom: base })
        })
        res.pipe(out)
      })

      req.on('timeout', () => req.destroy(new Error('连接超时')))
      req.on('error', reject)
    }

    go(url)
  })
}

/* 元信息随 `.part` 一起存：只有"同一个 URL + 同一个 ETag"才敢接着旧字节往下写 */
function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
}

function writeMeta(metaPath, meta) {
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta))
  } catch {
    /* 元信息只影响"下次能少下点"，写不进去不该让下载失败 */
  }
}

/** 同一个 `.part` 派生出来的分段文件（`x.part.seg0`、`x.part.seg1` …） */
function segFilesOf(tmp) {
  const dir = path.dirname(tmp)
  const base = path.basename(tmp)
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.seg`))
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** 丢掉半截文件、它的元信息、以及所有分段文件（换源 / 416 / 分段不符时才调） */
function dropPart(tmp, metaPath) {
  for (const file of [tmp, metaPath, ...segFilesOf(tmp)]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch {
      /* 删不掉时下一次是覆盖写（flags 'w'），不会读到旧内容 */
    }
  }
}

/* ── 多连接并行下载 ────────────────────────────────────────────────────
 * 单个连接在镜像站上常被限速（本机实测 hf-mirror 单流约 300KB/s~3MB/s 波动），
 * 而 78MB / 228MB 的模型是用户必装项。分段并发能把这段等待砍掉一大半。
 *
 * 三条不肯让步的规矩：
 *   ① **只在确认服务器支持 Range 时才分段**。探一次 `bytes=0-0`，
 *      回 206 且拿得到总长才算数；否则老老实实单流。
 *   ② **每段各自续传**。中断之后能接上的只有"已经下到的那些段"，
 *      重试时只补缺的那一段，不把完整段重下一遍。
 *   ③ **段长必须精确**。少一字节拼出来的文件长度就不对；多一字节是错位 ——
 *      而体积校验对"长度对、内容错"完全失明，所以这里逐段核对长度。
 */
const PARALLEL = {
  /** 低于这个体积不值得并发：4 条连接的握手与重定向开销比省下的时间还多 */
  minBytes: 8 * 1024 * 1024,
  /** 每段至少这么大，否则把连接数降下来（小文件 4 段各 3KB 毫无意义） */
  minPartBytes: 1 * 1024 * 1024,
  parts: 4
}

/** 把 [0, total) 切成 n 段；最后一段吃余数，保证首尾相接不留缝 */
function planRanges(total, parts) {
  const count = Math.max(1, Math.min(16, Number(parts) || 1))
  const size = Math.floor(total / count)
  const out = []
  for (let i = 0; i < count; i += 1) {
    const start = i * size
    const end = i === count - 1 ? total - 1 : (i + 1) * size - 1
    if (end >= start) out.push({ start, end })
  }
  return out
}

/**
 * 探一次"能不能分段"：要 1 个字节，看回的是不是 206、以及 Content-Range 里的总长。
 * 失败（超时、代理没起来、服务器不认）一律 resolve(null)，交给单流路径去报真错。
 */
function probeRange(url, proxy, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let hops = 0
    const go = (currentUrl) => {
      let target
      try {
        target = new URL(currentUrl)
      } catch {
        resolve(null)
        return
      }
      const secure = target.protocol === 'https:'
      const lib = secure ? https : http
      const req = lib.get(
        currentUrl,
        {
          headers: {
            'User-Agent': 'YJAI-ModelManager',
            'Accept-Encoding': 'identity',
            Range: 'bytes=0-0'
          },
          timeout,
          agent: proxyTunnel.agentFor(proxy, secure)
        },
        (res) => {
          const code = res.statusCode || 0
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume()
            hops += 1
            if (hops > 5) {
              resolve(null)
              return
            }
            go(new URL(res.headers.location, currentUrl).toString())
            return
          }
          if (code !== 206) {
            /* 200 = 服务器把整份发过来了。这里必须 **destroy 而不是 resume**：
               resume 会把它继续往内存里吸（78MB 白下载一遍，还占着连接）。 */
            res.destroy()
            resolve(null)
            return
          }
          const m = String(res.headers['content-range'] || '').match(/bytes\s+(\d+)-(\d+)\/(\d+)/i)
          res.resume()
          if (!m || Number(m[3]) <= 0) {
            resolve(null)
            return
          }
          resolve({ total: Number(m[3]), etag: String(res.headers.etag || '') })
        }
      )
      req.on('timeout', () => req.destroy(new Error('连接超时')))
      // 代理隧道建不起来这类错要往上抛：调用方据此决定"退回直连"，不能悄悄降级成单流
      req.on('error', reject)
    }
    go(url)
  })
}

/** 把若干段按顺序拼成目标文件（异步，不阻塞主进程；228MB 也不能一口气读进内存） */
function assemble(target, segPaths) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target, { flags: 'w' })
    let index = 0
    const next = () => {
      if (index >= segPaths.length) {
        out.end()
        return
      }
      const seg = segPaths[index]
      index += 1
      const rs = fs.createReadStream(seg, { highWaterMark: 1 << 20 })
      rs.on('error', (err) => {
        out.destroy()
        reject(err)
      })
      rs.on('end', next)
      rs.on('data', (chunk) => {
        if (!out.write(chunk)) {
          rs.pause()
          out.once('drain', () => rs.resume())
        }
      })
    }
    out.on('error', reject)
    out.on('close', resolve)
    next()
  })
}

/**
 * 分段并发下载到 `dest.part`（结束后由调用方 promote 改名）。
 *
 * @param {{total:number, parts:number, etag:string}} plan
 * @returns {Promise<{bytes:number, resumedFrom:number}>}
 */
async function fetchSegmented(url, dest, onProgress, proxy, plan, metaPath, stall = {}) {
  const tmp = `${dest}.part`
  const ranges = planRanges(plan.total, plan.parts)
  const marks = ranges.map(() => 0)
  const segAt = (i) => `${tmp}.seg${i}`
  const lenOf = (row) => row.end - row.start + 1

  /* 上次留下的段能直接用：只有"段长没变、字节没超"才敢接 */
  const resumedFrom = ranges.reduce((sum, row, i) => sum + Math.max(0, Math.min(sizeOf(segAt(i)), lenOf(row))), 0)

  const report = () => {
    if (!onProgress) return
    try {
      onProgress(marks.reduce((a, b) => a + b, 0), plan.total)
    } catch {
      /* 进度回调自身抛错不该中断下载 */
    }
  }

  const jobs = ranges.map(async (row, i) => {
    const len = lenOf(row)
    let have = Math.max(0, sizeOf(segAt(i)))
    if (have > len) {
      // 段变短了 = 服务器上的文件换过版本，这段作废重下（接着写会得到错位内容）
      try {
        fs.unlinkSync(segAt(i))
      } catch {
        /* 删不掉就靠下面的 flags 'w' 覆盖 */
      }
      have = 0
    }
    marks[i] = have
    if (have >= len) {
      report()
      return
    }
    await transfer(url, {
      proxy,
      tmp: segAt(i),
      startAt: row.start + have,
      rangeEnd: row.end,
      etag: plan.etag,
      stallMs: stall.stallMs,
      stallBytes: stall.stallBytes,
      onProgress: (absolute) => {
        marks[i] = Math.max(marks[i], absolute - row.start)
        report()
      }
    })
    marks[i] = len
    report()
  })

  /* 用 allSettled 而不是 all：某一段挂了，别的段**已经下到的字节仍然有效**，
     等它们下完再报错，下一次重试就能少下一大截。 */
  const settled = await Promise.allSettled(jobs)
  const failed = settled.find((row) => row.status === 'rejected')
  if (failed) throw failed.reason

  for (let i = 0; i < ranges.length; i += 1) {
    const got = Math.max(0, sizeOf(segAt(i)))
    if (got !== lenOf(ranges[i])) {
      const err = new Error(`第 ${i + 1} 段长度不对（${got}/${lenOf(ranges[i])} 字节）`)
      throw err
    }
  }

  await assemble(
    tmp,
    ranges.map((_, i) => segAt(i))
  )
  for (let i = 0; i < ranges.length; i += 1) {
    try {
      fs.unlinkSync(segAt(i))
    } catch {
      /* 残渣不影响结果，下次会按"段长已满"直接跳过 */
    }
  }
  /* 留 mode：下次进来据此继续按分段续（否则会拿一个"拼好的整文件"当单流半截去追加），
     同时也留下"这个文件当初是几路下的"的现场证据 */
  writeMeta(metaPath, { url, etag: plan.etag || '', total: plan.total, mode: 'segmented', parts: ranges.length })
  return { bytes: sizeOf(tmp), resumedFrom }
}

/**
 * 下载单个文件到 `.part` 再改名；**中断之后再调一次会接着下**。
 *
 * 续传判据放在这里而不是调用方：调用方只关心"给我这个文件"，
 * 而"能不能接着上次的字节"取决于三件事 —— 同一个 URL、同一个 ETag、`.part` 还在。
 *
 * 这里还负责**选路**：能分段就分段并发，不能就单流。选路规则见 PARALLEL 段注释。
 *
 * @param {string} url
 * @param {string} dest 目标路径（已存在的同名文件会被覆盖）
 * @param {(received:number, total:number)=>void} onProgress
 * @param {{proxy?:object|null, proxyOpts?:object, parallel?:{parts?:number,minBytes?:number,minPartBytes?:number}}} [opts]
 *        proxy 传 undefined 表示"自己探一次"；parallel 只给闸门用来在几百 KB 的样本上验分段
 * @returns {Promise<{bytes:number,resumedFrom:number}>}
 */
async function fetchTo(url, dest, onProgress, opts = {}) {
  const tmp = `${dest}.part`
  const metaPath = `${tmp}.json`
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  const proxy = opts.proxy === undefined ? await proxyTunnel.detectProxy(opts.proxyOpts) : opts.proxy
  const cfg = { ...PARALLEL, ...(opts.parallel || {}) }
  const meta = readMeta(metaPath)
  const sameSource = Boolean(meta && meta.url === url)

  if (meta && meta.url && meta.url !== url) {
    /* 换源必须从 0 开始：不同镜像/不同版本的文件拼在一起，promote() 只比字节数，
       拼出一个"体积刚好对、内容前后两半"的模型它照样放行。分段文件同理，一起清。 */
    dropPart(tmp, metaPath)
  }

  let useProxy = proxy

  /* sizeOf 对"不存在"返回 -1（它要区分"空文件"和"没有这个文件"）。
     这里必须夹到 0：-1 会让 `startAt > 0` 判假（看起来没事），但 resumedFrom 会变成 -1，
     闸门与日志里就是"从 -1 字节处续传"这种看不懂的数字。 */
  let startAt = Math.max(0, sizeOf(tmp))
  let etag = sameSource ? String(meta.etag || '') : ''

  /* 上一次其实已经下完、只是改名那一步没成功（Windows 上文件被占用时 rename 会 EBUSY）：
     `.part` 长度正好等于登记的字节数 ⇒ 直接复用，不要为了"模式不明"再下一遍 228MB。 */
  if (sameSource && Number(meta.total) > 0 && startAt === Number(meta.total)) {
    return { bytes: startAt, resumedFrom: startAt }
  }

  const run = (from) =>
    transfer(url, {
      proxy: useProxy,
      tmp,
      startAt: from,
      etag,
      stallMs: opts.stallMs,
      stallBytes: opts.stallBytes,
      onProgress,
      onHeaders: (head) => {
        // 头一到就落盘：跨会话续传时才有 If-Range 可发
        writeMeta(metaPath, { url, etag: head.etag || etag, total: head.total, from: head.from })
      }
    })

  /* ── 选路 ──────────────────────────────────────────────────────────
   * 规则很短：上一次是分段就继续分段（别中途换模式，两种模式的半截文件不通用）；
   * 上次是单流、或已经有 `.part`，就继续单流；**只有全新下载**才去探一次。 */
  let plan = null
  const expect = Number(opts.expectBytes) || 0
  /* 注册表已经写了大小的、且小于阈值 ⇒ 连探测都省掉（0.5MB 的降噪模型不该多跑一个来回）。
     注册表数字对不上也没关系：只是少并发一次，下载本身照旧。 */
  const knownSmall = expect > 0 && expect < cfg.minBytes
  if (sameSource && meta && meta.mode === 'segmented' && Number(meta.total) > 0) {
    plan = { total: Number(meta.total), parts: Number(meta.parts) || cfg.parts, etag: String(meta.etag || '') }
  } else if (!knownSmall && startAt === 0 && segFilesOf(tmp).length === 0) {
    let probe = null
    try {
      probe = await probeRange(url, useProxy)
    } catch (err) {
      if (err && err.proxyTunnel && useProxy) {
        // 探测就走不通代理 ⇒ 直接退回直连再探，免得整段下载都白等一次
        useProxy = null
        try {
          probe = await probeRange(url, null)
        } catch {
          probe = null
        }
      } else {
        probe = null
      }
    }
    const parts = Math.max(1, Math.min(cfg.parts, Math.floor(probe ? probe.total / cfg.minPartBytes : 0) || 1))
    if (probe && probe.total >= cfg.minBytes && parts > 1) {
      plan = { total: probe.total, parts, etag: probe.etag }
    }
  }

  if (plan) {
    const attemptSegmented = async () => {
      writeMeta(metaPath, { url, etag: plan.etag, total: plan.total, mode: 'segmented', parts: plan.parts })
      return fetchSegmented(url, dest, onProgress, useProxy, plan, metaPath, opts)
    }
    try {
      return await attemptSegmented()
    } catch (err) {
      if (err && err.code === 'RANGE_REJECTED') {
        // 服务器其实不支持分段（探测过了、真要时又不给）⇒ 清干净，按单流来
        dropPart(tmp, metaPath)
        startAt = 0
        etag = ''
        plan = null
      } else if (err && err.proxyTunnel && useProxy) {
        useProxy = null
        return await attemptSegmented()
      } else {
        throw err
      }
    }
  }

  let result
  try {
    result = await run(startAt)
  } catch (err) {
    if (err && err.code === 'RANGE_REJECTED') {
      dropPart(tmp, metaPath)
      startAt = 0
      etag = ''
      result = await run(0)
    } else if (err && err.proxyTunnel && useProxy) {
      /* 代理这条路根本建不起来（代理程序没开 / 端口是上次留下的死值 / 认证不对）
         ⇒ 退回直连再试一次。
         不做这一步的后果：一条陈旧系统代理配置就能让「下载模型」永久失败，
         而用户看到的只是"服务器无响应"——他永远猜不到是代理。 */
      useProxy = null
      result = await run(startAt)
    } else {
      throw err
    }
  }

  writeMeta(metaPath, { url, etag: result.etag || etag, total: result.total, mode: 'single' })
  return { bytes: result.total || sizeOf(tmp), resumedFrom: startAt }
}

/**
 * 按候选地址依次尝试下载，第一个成功的算数。
 *
 * 为什么要多个地址：语音识别模型只在 huggingface 上，而它在家用网络下**直连不通**，
 * 镜像站偶尔也会抽风。只写一个地址的话，失败时用户看到的是一句"服务器返回 0"，
 * 而他完全无从判断"是我的网，还是这个软件坏了"。
 *
 * ⚠️ 换下一个地址之前必须把 `.part` 清掉：上一次失败可能已经写了半截，
 *    续着写会拼出一个**体积对但内容错**的文件 —— promote() 的体积校验拦不住它，
 *    症状是"模型装好了，一识别就崩"。fetchTo 每次进 begin() 都会先删 .part，这里再删一次
 *    是为了"第一个地址连 DNS 都没解析出来"这种根本没进 begin() 的情形。
 */
async function downloadOne(urlOrList, dest, onProgress, opts = {}) {
  const urls = (Array.isArray(urlOrList) ? urlOrList : [urlOrList]).map((item) => String(item || '')).filter(Boolean)
  if (!urls.length) throw new Error('没有下载地址')

  /* 4xx 是确定性错误（路径写错、仓库改名），重试只是白等；其余（超时、连接被掐、
     体积截断）都值得再试一次 —— 78MB / 228MB 这类大文件在家庭网络上，
     一次瞬时抖动不该让整次安装从头来过，而"换下一个地址"并不是等价的重试：
     本机实测 `huggingface.co` 被 DNS 污染成 108.160.165.48（ETIMEDOUT），
     兜底地址在这类网络下**恒不可用**，镜像站那一次才是唯一机会。 */
  const fatal = (err) => /服务器返回 4\d\d/.test(String((err && err.message) || ''))
  const ATTEMPTS = 2

  const errors = []
  for (let i = 0; i < urls.length; i += 1) {
    const host = (() => {
      try {
        return new URL(urls[i]).host
      } catch {
        return urls[i]
      }
    })()
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        /* ⚠️ 失败后**不许删 .part**：续传的全部价值就在这里 ——
           228MB 的模型在 3MB/s 的家庭宽带下要一分多钟，中途抖一次就从 0 开始，
           表现是"进度条反复弹回 0，永远装不完"。
           换源那一步由 fetchTo 自己按 meta.url 判断并从 0 重来，不需要这里插手。 */
        return await fetchTo(urls[i], dest, onProgress, opts)
      } catch (err) {
        errors.push(`${host}: ${(err && err.message) || '失败'}`)
        if (fatal(err)) break
      }
    }
  }
  /* 报**全部**失败原因，不只最后一个：只报最后一个会让人以为是"兜底地址挂了"，
     而实际常常是"镜像挂了、兜底地址本来就不通" —— 处置完全不同。 */
  const uniq = [...new Set(errors)]
  const err = new Error(uniq.length ? uniq.join('；') : '下载失败')
  err.attempts = errors
  throw err
}

/** 把 .part 改名成正式文件；尺寸与标称不符就删掉并报错 */
function promote(tmp, dest, expectBytes) {
  const actual = sizeOf(tmp)
  if (expectBytes && actual > 0 && actual !== expectBytes) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 删不掉也要报错，不能装作成功 */
    }
    throw new Error(`体积不符：应为 ${expectBytes} 字节，实际 ${actual} 字节（文件可能被中途截断）`)
  }
  fs.renameSync(tmp, dest)
  // 元信息是"半截文件"的伴生物，文件转正之后它就没有意义了（留着会让下次的续传判断更乱）
  try {
    fs.unlinkSync(`${tmp}.json`)
  } catch {
    /* 没有就对了 */
  }
  return actual
}

/**
 * 下载一个组件的全部文件。
 *
 * 逐个文件下，全部成功才算成功；任一失败会**保留已完成的部分**（它们在正式文件名下，
 * 下次进来会显示"缺 2/3"，比从零重来体验好）。
 *
 * ⚠️ 已经**完整**的文件直接跳过（尺寸与标称值一致才算完整）：
 *    语音识别模型是 78MB / 228MB，一次失败之后重试如果从零开始，
 *    在慢网下就是"永远下不完"。跳过判据只认尺寸 —— 与 stateOf() 同一把尺子，
 *    两处判据不同的话会出现"面板说已就绪、下载器又重下一遍"。
 */
async function download(entryOrId, deps = {}, onProgress) {
  const entry = typeof entryOrId === 'string' ? byId(entryOrId) : entryOrId
  if (!entry) throw new Error('没有这个模型')
  const dir = installDirOf(entry, deps)
  if (!dir) throw new Error('拿不到本机模型目录（缺少 userData）')

  const totalBytes = entry.files.reduce((n, item) => n + Number(item.bytes || 0), 0)

  /* 代理只探一次：detectProxy 在 Windows 上要 spawn 一次 reg 查询。
     按文件探会变成"一个音色包 13 个文件 = 13 次 reg"，慢且没必要 ——
     同一次安装里用户不可能中途换代理。 */
  const proxy = await proxyTunnel.detectProxy(deps.proxyOpts)
  let doneBytes = 0

  for (const item of entry.files) {
    const dest = path.join(dir, item.name)
    /* 有的组件带子目录（配音音色包的 `dict/pos_dict/*`）：
       不先建目录，createWriteStream 会 ENOENT，而报错信息里只有一串路径，
       看起来像"下载失败"，其实是没建文件夹。 */
    const parent = path.dirname(dest)
    if (parent !== dir) {
      try {
        fs.mkdirSync(parent, { recursive: true })
      } catch {
        /* 建不出来就让下面的写盘抛真实错误 */
      }
    }
    const already = sizeOf(dest)
    /* 尺寸对得上 = 这一份已经下好了。标称值为 0 的条目不敢这么判（无从校验） */
    if (item.bytes > 0 && already === item.bytes) {
      doneBytes += already
      if (onProgress) {
        onProgress({
          id: entry.id,
          file: item.name,
          received: doneBytes,
          total: totalBytes,
          percent: totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0,
          skipped: true
        })
      }
      continue
    }
    if (!item.url) throw new Error(`${item.name} 没有下载地址`)
    const tmp = `${dest}.part`
    let got
    try {
      got = await downloadOne(
        [item.url, ...(Array.isArray(item.alt) ? item.alt : [])],
        dest,
        (received) => {
          if (!onProgress) return
          /* 总进度用注册表标称值：拿不到 content-length 时才不会出现"总长变来变去"。
             断点续传时 received 已经从"上次下到的位置"算起，进度条不会跳回 0。 */
          const base = doneBytes
          onProgress({
            id: entry.id,
            file: item.name,
            received: base + received,
            total: totalBytes,
            percent: totalBytes > 0 ? Math.min(100, Math.round(((base + received) / totalBytes) * 100)) : 0
          })
        },
        { proxy, expectBytes: Number(item.bytes) || 0 }
      )
    } catch (err) {
      /* 把「这次走的哪条路」写进错因：用户报"下载失败"时，第一个要问的就是
         "开代理了吗" —— 写在这里就不用问了，也省得把网络问题误判成功能坏了。 */
      err.message = `${err.message}（网络：${proxyTunnel.describe(proxy)}）`
      throw err
    }
    promote(tmp, dest, item.bytes)
    doneBytes += got.bytes
    if (onProgress) {
      onProgress({
        id: entry.id,
        file: item.name,
        received: doneBytes,
        total: totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0
      })
    }
  }

  return list(deps).find((row) => row.id === entry.id)
}

/**
 * 从本地文件安装。
 *
 * 为什么必须留这条路：下载地址在部分网络下不可达，而"模型"是用户完全可以在别处
 * 拿到的东西。只给一个下不动的按钮，等于这个功能在那些机器上不存在。
 *
 * `srcPath` 可以是任意一个清单里同名文件的路径；按 basename 归位。
 */
function importFrom(entryOrId, srcPath, deps = {}) {
  const entry = typeof entryOrId === 'string' ? byId(entryOrId) : entryOrId
  if (!entry) throw new Error('没有这个模型')
  const dir = installDirOf(entry, deps)
  if (!dir) throw new Error('拿不到本机模型目录（缺少 userData）')

  const name = path.basename(String(srcPath || ''))
  const spec = entry.files.find((item) => item.name === name)
  if (!spec) {
    throw new Error(
      `文件名不符：需要 ${entry.files.map((item) => item.name).join(' / ')} 之一，拿到的是 ${name || '（空）'}`
    )
  }
  const size = sizeOf(String(srcPath))
  if (size <= 0) throw new Error('这个文件读不出来（可能不是普通文件）')
  if (spec.bytes && size !== spec.bytes) {
    throw new Error(`体积不符：${name} 应为 ${spec.bytes} 字节，实际 ${size} 字节`)
  }

  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(String(srcPath), path.join(dir, name))
  return list(deps).find((row) => row.id === entry.id)
}

/**
 * 删除本机那份，回落到随包版本。
 *
 * ⚠️ 只删 `<userData>/models/<id>`，**绝不碰 resources 下的随包文件** ——
 *    删掉随包文件会让功能永久坏掉，而且是"下次发版前都没救"的那种。
 */
function remove(entryOrId, deps = {}) {
  const entry = typeof entryOrId === 'string' ? byId(entryOrId) : entryOrId
  if (!entry) throw new Error('没有这个模型')
  const dir = installDirOf(entry, deps)
  if (!dir) throw new Error('拿不到本机模型目录（缺少 userData）')

  /* 逐个文件删 + 清 .part（连同 .part.json 与并发的分段文件），不用 rm -rf：
     路径来自注册表，仍然只做"删已知文件" */
  for (const item of entry.files) {
    const tmp = path.join(dir, `${item.name}.part`)
    for (const file of [path.join(dir, item.name), tmp, `${tmp}.json`, ...segFilesOf(tmp)]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } catch {
        /* 单个删不掉不该中断后面的 */
      }
    }
  }
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* 目录非空 / 被占用：留着不影响判定 */
  }

  return list(deps).find((row) => row.id === entry.id)
}

/** 本机模型总共占多少字节（设置页脚那行"已占用 xx MB"） */
function totalBytes(deps = {}) {
  const root = modelsRootOf(deps)
  let sum = 0
  for (const entry of REGISTRY) {
    const dir = installDirOf(entry, deps)
    if (!dir) continue
    for (const item of entry.files) {
      const size = sizeOf(path.join(dir, item.name))
      if (size > 0) sum += size
    }
  }
  return { total: sum, root }
}

module.exports = {
  REGISTRY,
  byId,
  modelsRootOf,
  installDirOf,
  bundleRootOf,
  stateOf,
  list,
  download,
  importFrom,
  remove,
  totalBytes,
  /* 下面两个是给闸门（tools/check-download-resume.mjs）用的：
     本地起 HTTP 服务就能验证续传 / 换源 / 416 / 代理四条路径，不需要真联网。
     端口不能从外面塞进来 —— 只有把它们导出，闸门才能驱动真实实现而不是抄一份。 */
  fetchTo,
  downloadOne,
  detectProxy: proxyTunnel.detectProxy
}
