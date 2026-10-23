/**
 * 艺镜AI剪辑 · 主进程
 *
 * 安全基线（桌面端要读用户选的媒体文件、要调本机 ffmpeg，这几条不能省）：
 *   - contextIsolation 开、nodeIntegration 关、sandbox 开
 *   - 渲染进程只能用 preload 明确暴露的那几个方法
 *   - 禁止渲染进程自行导航与开新窗口；外链一律交给系统浏览器
 *   - 拒绝一切权限申请（摄像头/麦克风/通知等按需再单独开）
 *   - 令牌用 safeStorage 加密后落盘，不散落在 localStorage
 */
const { app, BrowserWindow, shell, ipcMain, safeStorage, nativeTheme, dialog, protocol } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
/* 素材入库要用它给副本文件名加短哈希（不同目录下的同名文件不能互相覆盖） */
const { createHash } = require('node:crypto')
const { Readable } = require('node:stream')
const {
  probe: probeFfmpeg,
  render: renderTimeline,
  extractAudio: extractAudioTrack,
  audioPeaks: audioPeaksOf,
  detectScenes: detectScenesOf,
  makeProxy: makeProxyOf,
  probeStreams: probeStreamsOf,
  pathFromMediaUrl
} = require('./render')
/**
 * 素材描述与草稿存储都抽到了**纯 Node 的共享模块**里：MCP server（镜枢对接时
 * 以同一份代码跑起来）要用同一条规则读写同一批文件。各写一份的代价不是"多几行"，
 * 而是规则迟早分叉 —— 分叉的表现是"agent 建的草稿软件里看不到"，还不报错。
 */
const media = require('./media')
const { createDraftStore } = require('./drafts')
const packOf = require('./pack')
const packTable = require('../shared/pack')
const hdrTable = require('../shared/hdr')
const { registerMcpServer } = require('./mcp-register')

const isDev = !app.isPackaged
const DEV_URL = process.env.YIJAI_DEV_URL || 'http://127.0.0.1:5173'
const RENDERER_ENTRY = path.join(__dirname, '..', '..', 'dist-renderer', 'index.html')

/*
 * 叠加式滚动条（滚动时才浮出来，**不占布局宽度**）。
 *
 * Windows 上 Chromium 默认是「经典滚动条」：只要容器出现滚动，就实打实地吃掉
 * 十几像素宽度。首页那块内容区因此右沿从 1196 缩到 1187，再因为三张功能卡是
 * flex 均分，卡宽 301→298、每张卡都往左挪一点点 —— 在差异图里表现成整个右侧
 * 三格一起偏色，很容易误判成"卡片没对齐"。参考客户端是叠加式（静置时看不到），
 * 所以这里对齐它的行为。
 *
 * 必须在 app ready 之前设置，之后设置无效。
 */
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar')

/** 允许外链打开的协议白名单 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

let mainWindow = null
/** 同一时刻只允许一个渲染任务；渲染进程点「取消」时靠它 abort */
let activeRender = null

/* ------------------------------ 本地素材 ------------------------------ */

/**
 * 本地素材协议。
 *
 * 渲染层要显示用户电脑上的视频/图片，但 sandbox + contextIsolation 下它读不到盘。
 * 直接把绝对路径塞进 <video src="file:///..."> 也不可靠：file:// 页面加载 file:// 子资源
 * 在收紧 webSecurity 后会被拦，而且非 ASCII 路径、空格都要自己转义。
 * 所以统一走这个自定义协议，由主进程读盘回流体。
 *
 * 声明成 standard + stream 是为了让 <video> 能发 Range 请求、拖进度条；
 * secure 是为了在 https 语义下被当成可信来源。注意必须在 app ready 之前注册。
 *
 * `corsEnabled: true` 是**为了时间线的抽帧预览**加的（2026-09-22）：
 * 时间线要在视频轨上贴一排抽帧，而抽帧必须把 <video> 画进 canvas 再取 dataURL。
 * canvas 的跨源污染看的是"元素是否以 CORS 方式取回"——`file://` 页面去读
 * `yjai-media://` 天然跨源，不声明 corsEnabled 就恒被污染，`toDataURL` 直接抛
 * SecurityError（而且是在 drawImage 之后才炸，看起来像"抽帧代码写错了"）。
 * 声明之后，配合渲染层的 `crossOrigin="anonymous"` 才能真的读出画面。
 * 代价：这个协议从此要过 CORS 检查，所以 protocol.handle 的每个分支
 * （含 400 / 403）都必须带回 ACAO —— 已经带了，别删。
 */
const MEDIA_SCHEME = media.MEDIA_SCHEME

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }
])

/** dialog 用的扩展名分组（不带点） */
const EXT_GROUPS = {
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'wma'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']
}

/**
 * 允许经 MEDIA_SCHEME 读取的文件白名单。
 *
 * 只有用户主动选过或拖进来的路径才会进这个集合。没有它，渲染层一旦被注入脚本，
 * 就能拿协议当任意文件读取原语（读 .env、读浏览器 Cookies）。只增不减、不落盘，
 * 进程退出即失效 —— 代价是重启后旧素材要重新导入，但这里选安全。
 *
 * ⚠️ 白名单是**主进程独有的内存态**：共享的 media.js 只做无副作用的形状换算，
 *    访问控制必须留在这一层，别一起下沉过去。
 */
const allowedMedia = new Set()

/** 路径归一 + 扩展名白名单校验；不合法返回空串（调用方一律先过这一关） */
const normalizeMediaPath = media.normalizeMediaPath

/** 绝对路径 → 渲染层可直接用的 URL（base64url 编码，彻底避开中文/空格/# 的转义问题） */
const mediaUrlOf = media.mediaUrlOf

/**
 * 描述一个本地文件，**并把它放进白名单**。
 * 文件不存在、不是普通文件、扩展名不支持，一律返回 null（由调用方过滤掉）。
 */
/**
 * 把用户选中的文件复制进应用的素材目录（`userData/materials/`），返回副本路径。
 *
 * 为什么需要它：默认的"引用原位"在真实使用里很容易断 —— 用户从下载文件夹导入、
 * 剪完清空了下载文件夹，草稿里的素材就全成了离线素材（画面黑、导出失败）。
 * "复制进草稿"把素材收进应用自己的目录，代价是占空间。
 *
 * ⚠️ 文件名必须带**短哈希**：不同目录下的同名文件（`VID_0001.mp4` 很常见）
 *    直接按原名落地会互相覆盖，表现为"导入了两个素材，第二个把第一个覆盖了"。
 * ⚠️ 复制失败（磁盘满 / 无权限）必须退回原路径，而不是返回空 ——
 *    返回空等于"用户选了 5 个文件，导入了 0 个"，且没有任何提示。
 */
function copyIntoMaterials(sourcePath) {
  try {
    const dir = path.join(app.getPath('userData'), 'materials')
    fs.mkdirSync(dir, { recursive: true })
    const ext = path.extname(sourcePath).toLowerCase()
    const base = path.basename(sourcePath, path.extname(sourcePath))
    const stamp = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8)
    let target = path.join(dir, `${base}-${stamp}${ext}`)
    /* 同一个源文件重复导入：已经复制过就不再复制一次（省磁盘、也避免素材列表里出现两份） */
    if (!fs.existsSync(target)) fs.copyFileSync(sourcePath, target)
    return target
  } catch {
    return sourcePath
  }
}

/**
 * 字体入库：把用户选中的字体文件复制进 `userData/fonts/`，返回给渲染层的描述。
 *
 * 为什么要复制而不是直接用原路径：字体常常来自"下载"目录，清理一遍就没了；
 * 草稿里那行字幕会在下次打开时静默退回系统字体（甚至直接消失）。
 *
 * ⚠️ 文件名带短哈希，理由同素材：`SourceHanSans.ttf` 这种名字极容易重名，
 *    按原名落地会互相覆盖 —— 用户导了两种字体，实际只剩后一种。
 * ⚠️ 字体**必须进 allowedMedia**，否则渲染层 fetch 那个 URL 会 403，
 *    `document.fonts` 里就永远没有这个家族，预览静默退回默认字体。
 */
function importFont(sourcePath) {
  const absolute = path.resolve(String(sourcePath || ''))
  const ext = path.extname(absolute).toLowerCase()
  if (!['.ttf', '.otf', '.ttc'].includes(ext)) return null
  try {
    const dir = path.join(app.getPath('userData'), 'fonts')
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(absolute, path.extname(absolute)).replace(/[^\w\u4e00-\u9fa5-]/g, '_')
    const stamp = createHash('sha1').update(absolute).digest('hex').slice(0, 8)
    const target = path.join(dir, `${base}-${stamp}${ext}`)
    if (!fs.existsSync(target)) fs.copyFileSync(absolute, target)
    allowedMedia.add(target)
    return {
      /* id 用哈希：同一个字体重复导入得到同一个 id，设置里不会出现两条一样的 */
      id: stamp,
      name: base,
      path: target,
      url: mediaUrlOf(target)
    }
  } catch {
    return null
  }
}

function describeMedia(raw) {
  const described = media.describeMedia(raw)
  if (!described) return null
  allowedMedia.add(described.path)
  return described
}

/** 扩展名 → MIME。自己回流体就得自己给 Content-Type，给错了 <video> 直接不认。 */
const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif'
}

/**
 * 直接把文件回给渲染层，自己处理 Range。
 *
 * 为什么不用 net.fetch(file://)：实测它对 `Range: bytes=100-199` 会返回
 * **HTTP 200 + 100 字节且没有 Content-Range** —— 状态码和头都不对。播放器是靠
 * 206 + Content-Range 判断总时长和当前读取位置的，头不对就会出现「长视频拖不动进度条」，
 * 而且不长到一定体积根本发现不了。这里按 RFC 7233 自己算，顺带补上 Accept-Ranges，
 * 浏览器才知道这个源支持按需读取、从而开启 seek。
 */
function serveLocalFile(target, request, cors) {
  let stat
  try {
    stat = fs.statSync(target)
  } catch (error) {
    return new Response(`stat failed: ${error.message}`, { status: 404, headers: cors })
  }
  const total = stat.size
  const base = {
    ...cors,
    'content-type': MIME_BY_EXT[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  }

  const raw = String(request.headers.get('range') || '').trim()
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw)

  let start = 0
  let end = total - 1
  if (match) {
    const hasStart = match[1] !== ''
    const hasEnd = match[2] !== ''
    if (hasStart) {
      start = Number(match[1])
      end = hasEnd ? Math.min(Number(match[2]), total - 1) : total - 1
    } else if (hasEnd) {
      // bytes=-N 表示「最后 N 字节」，播放器读 moov 时会这么发
      start = Math.max(0, total - Number(match[2]))
      end = total - 1
    } else {
      return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${total}` } })
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${total}` } })
    }
    const stream = fs.createReadStream(target, { start, end })
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        ...base,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${total}`
      }
    })
  }

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...base, 'content-length': String(total) } })
  }
  return new Response(Readable.toWeb(fs.createReadStream(target)), {
    status: 200,
    headers: { ...base, 'content-length': String(total) }
  })
}

/** 注册协议处理器：白名单命中才回流体，其余一律 403 */
function registerMediaProtocol() {
  // <img>/<video> 不吃 CORS，所以少了这个头它们照样能显示；
  // 但渲染层一旦改用 fetch（读 Range、取二进制、算校验），file:// 页面去 fetch 自定义协议
  // 就变成跨源请求，缺 ACAO 会直接 "Failed to fetch"。这个坑很隐蔽，加上。
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range, content-type',
    'access-control-expose-headers': 'content-range, content-length, accept-ranges'
  }

  protocol.handle(MEDIA_SCHEME, async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    let target = ''
    try {
      const url = new URL(request.url)
      target = path.resolve(Buffer.from(url.pathname.replace(/^\/+/, ''), 'base64url').toString('utf8'))
    } catch {
      return new Response('bad request', { status: 400, headers: CORS })
    }
    if (!allowedMedia.has(target)) {
      return new Response('forbidden', {
        status: 403,
        headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' }
      })
    }
    return serveLocalFile(target, request, CORS)
  })
}

/* ------------------------------- 本地配置 ------------------------------- */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(next) {
  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
}

/**
 * 草稿存储。
 *
 * 规则（id 字符集、临时文件 + 改名、摘要字段）全部住在共享的 `./drafts.js` ——
 * **MCP server 用的是同一份**。这里只负责注入草稿根目录：它依赖 electron 的
 * userData，必须**延迟求值**（`app.whenReady()` 之前 `app.getPath` 拿不到）。
 *
 * 从前这套逻辑写在本文件里；与 MCP server 各写一份的话，两边迟早分叉 ——
 * 而分叉的症状是"agent 建的草稿在软件里打不开"，两边单独跑却都是好的。
 */
const drafts = createDraftStore(() => app.getPath('userData'))

const listDrafts = () => drafts.list()
const saveDraft = (payload) => drafts.save(payload)
const loadDraft = (id) => drafts.load(id)
const removeDraft = (id) => drafts.remove(id)

/**
 * HDR 探测结果缓存（键 = 绝对路径 + mtime）。
 * 不带 mtime 的话，用户用同名文件替换素材后仍会拿到旧结论 ——
 * 表现是"换了片子还是按 HDR 转"，而且只有重启才恢复。
 */
const hdrCache = new Map()

/* -------------------------------- 主窗口 -------------------------------- */

function createWindow() {
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    // 无系统标题栏：客户端自己画顶栏（首页 .home-top / 工作台 .wb-menu），
    // 也只有这样客户区才能占满整窗 —— 有边框时系统标题栏 + 任务栏会吃掉近 40px，
    // 参考客户端那种最大化 1920×1032 的布局就复刻不出来。
    // 拖动靠 CSS 的 -webkit-app-region: drag，缩放仍走 Windows 的 thickFrame。
    frame: false,
    backgroundColor: '#080a18',
    title: '艺镜AI剪辑',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  if (isDev && process.env.YIJAI_USE_DEV_SERVER === '1') {
    mainWindow.loadURL(DEV_URL)
  } else if (fs.existsSync(RENDERER_ENTRY)) {
    mainWindow.loadFile(RENDERER_ENTRY)
  } else {
    mainWindow.loadURL(DEV_URL)
  }

  // 渲染进程不允许自己跳走，也不允许开新窗口
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url)
    const current = new URL(mainWindow.webContents.getURL())
    if (target.origin !== current.origin) {
      event.preventDefault()
      if (EXTERNAL_PROTOCOLS.has(target.protocol)) shell.openExternal(url)
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) shell.openExternal(url)
    } catch {
      /* 非法地址直接忽略 */
    }
    return { action: 'deny' }
  })

  /**
   * 系统权限：**只放行「本窗口 + 只要麦克风 + 只要音频」这一种**。
   *
   * 原来是 `callback(false)` 通吃 —— 那条规则写在"这个应用没有任何需要系统权限的功能"
   * 的年代。现在有了「录音配音」，麦克风是**功能的一部分**：一律拒绝的话，
   * getUserMedia 直接抛 NotAllowedError，用户看到的是"录音按钮点了没反应"，
   * 而系统连"要不要允许"都不会问（因为应用先自己拒了）。
   *
   * 放开的最小面：
   *   · 只有**主窗口**能申请（别的 webContents / 将来开的子页一律拒）；
   *   · 只有 `media` 这一种权限，其他（摄像头、通知、地理位置、剪贴板、MIDI…）照旧全拒；
   *   · media 的 mediaTypes 必须**全部是 audio** —— 请求里只要带了 video
   *     （摄像头），整条请求就拒，不给"顺手把摄像头也开了"留缝。
   *
   * 另外要设 check 处理器：Chromium 除了"申请"还会"复查"（同一 origin 第二次调用、
   * 设备切换时会走 check），只设 request 时表现为"第一次能录、第二次报 NotAllowedError"。
   */
  const audioOnlyMedia = (details) => {
    const types = Array.isArray(details && details.mediaTypes) ? details.mediaTypes : []
    if (!types.length) return false
    return types.every((type) => String(type).toLowerCase() === 'audio')
  }
  /* ⚠️ 四个形参都要写全：`details` 是第 4 个参数，`arguments[3]` 在箭头函数里根本不存在
     （箭头函数没有自己的 arguments），写成那样等于恒 undefined ⇒ 权限永远被拒，
     而"全拒"看起来跟"还没放开"一模一样，极难定位。 */
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media') return callback(false)
    if (!mainWindow || wc !== mainWindow.webContents) return callback(false)
    return callback(audioOnlyMedia(details))
  })
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (permission !== 'media') return false
    if (!mainWindow || (wc && wc !== mainWindow.webContents)) return false
    return Boolean(details && String(details.mediaType || '').toLowerCase() === 'audio')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  /* 最大化状态变化推给渲染层（顶栏中间那颗窗口键要换字形）。
     必须监听窗口事件而不是在 IPC 里返回一次了事 —— 双击标题栏、Win+↑ 这类
     系统途径不会经过我们的 IPC。 */
  const pushMaximizeState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximizeChanged', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', pushMaximizeState)
  mainWindow.on('unmaximize', pushMaximizeState)
}

/* --------------------------------- IPC --------------------------------- */

/**
 * 应用自身版本号。
 *
 * ⚠️ 不能直接 `app.getVersion()`：开发模式是用 `electron src/main/index.js` 起的，
 * 此时 app 路径上没有能认领的 package.json，`app.getVersion()` 会**退化成 Electron
 * 自己的版本**（实测开发模式显示 "33.4.11"，而项目是 1.0.0）。
 * 这个值会出现在「关于我们」里，是用户可见字段，不能随启动方式变。
 * 打包后 `app.getVersion()` 才是权威值（它读的是打进包里的 package.json），
 * 所以只在未打包时才回退去读源文件。
 */
function appVersion() {
  if (app.isPackaged) return app.getVersion()
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))
    if (pkg && pkg.version) return String(pkg.version)
  } catch {
    /* 读不到就还是用 Electron 报的那个值 */
  }
  return app.getVersion()
}

/**
 * 「硬件加速」当前是否生效。
 *
 * 单独存一个模块级真值而不是每次读设置：一是 `app:info` 要报**实际生效值**
 * （用户改了但没重启时，设置里是"已关闭"、实际仍是开着 —— 这两个数必须分得开），
 * 二是设置文件读失败时不能把状态说反。
 */
let hardwareAccelerationOn = true

/** 读设置并在 whenReady 之前落实硬件加速开关（必须是启动期调用，见调处注释） */
function applyHardwareAccelerationSetting() {
  let wanted = true
  try {
    const settings = readSettings()
    // 缺省 = 开（与 Electron 默认一致）；只有显式 false 才关
    wanted = settings.hardwareAcceleration !== false
  } catch {
    /* 设置读不到就按默认（开）走，不能因为读盘失败把用户的画质降级 */
  }
  hardwareAccelerationOn = wanted
  if (!wanted) app.disableHardwareAcceleration()
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: '艺镜AI剪辑',
    version: appVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userData: app.getPath('userData'),
    packaged: app.isPackaged,
    /* 硬件加速的**实际生效值**（不是设置里写的值）：
       用户改了开关但没重启时两者会不一样，界面要靠这个差值提示"重启后生效" */
    hardwareAcceleration: hardwareAccelerationOn
  }))

  /* 重启应用。硬件加速这类启动期开关改完只能重启，界面上直接给按钮，
     比让用户自己去找窗口右上角的叉更省事，也避免"改了没生效以为是坏的"。 */
  ipcMain.handle('app:restart', () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('settings:get', (_event, key) => {
    const settings = readSettings()
    return key ? settings[key] : settings
  })

  ipcMain.handle('settings:set', (_event, key, value) => {
    const settings = readSettings()
    settings[key] = value
    writeSettings(settings)
    return true
  })


  ipcMain.handle('draft:list', () => listDrafts())
  ipcMain.handle('draft:save', (_event, payload) => saveDraft(payload))
  ipcMain.handle('draft:load', (_event, id) => loadDraft(id))
  ipcMain.handle('draft:remove', (_event, id) => removeDraft(id))

  /* ------------------------------ 素材包 ------------------------------ */

  /**
   * 体检：这一份草稿引用的素材找得到几个。
   * 渲染层在弹「导出素材包」之前调它，好把"N 个素材找不到"写在确认框里 ——
   * 而不是等包打完、对面黑屏才发现。
   */
  ipcMain.handle('pack:inspect', (_event, data) => packOf.inspectPackData(data))

  /**
   * 导出素材包：对话框 → 写 `.yjpack`（标准 zip，双击能打开核对）。
   * 返回里带 missing，界面据此提示"已按离线导出"。
   */
  ipcMain.handle('pack:export', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const suggested = packTable.packFileName((payload && payload.name) || '工程')
    const options = {
      title: '导出素材包',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: [{ name: '艺镜素材包', extensions: ['yjpack'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    /* 用户可能把扩展名删掉了（Windows 有时不会自动补），这里补回来 */
    const outPath = /\.yjpack$/i.test(result.filePath) ? result.filePath : `${result.filePath}.yjpack`
    return packOf.exportPack({
      data: payload && payload.data,
      name: (payload && payload.name) || '工程',
      outPath
    })
  })

  /**
   * 导入素材包：对话框 → 解到 `userData/packs/<时间戳>/` → 存成**新草稿**并返回它的摘要。
   *
   * 刻意存成新草稿而不是覆盖同名的：包里带的是别人机器上的工程，
   * 覆盖本机同 id 的草稿会把用户自己的东西冲掉（而且不可逆）。
   */
  ipcMain.handle('pack:import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '导入素材包',
      properties: ['openFile'],
      filters: [
        { name: '艺镜素材包', extensions: ['yjpack'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }

    const stamp = `pack-${Date.now().toString(36)}`
    const destDir = path.join(app.getPath('userData'), 'packs', stamp)
    const imported = packOf.importPack({
      packPath: result.filePaths[0],
      destDir,
      registerUrl: (filePath) => {
        try {
          if (!fs.statSync(filePath).isFile()) return ''
        } catch {
          return ''
        }
        const absolute = path.resolve(filePath)
        allowedMedia.add(absolute)
        return mediaUrlOf(absolute)
      }
    })
    if (!imported.ok) return imported

    const summary = saveDraft({ name: imported.name || '素材包工程', data: imported.data })
    return {
      ok: true,
      id: summary.id,
      name: summary.name,
      mediaCount: imported.mediaCount,
      missing: imported.missing,
      dir: destDir
    }
  })

  ipcMain.handle('shell:openExternal', (_event, url) => {
    const parsed = new URL(String(url))
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) throw new Error('只允许打开 http/https 链接')
    return shell.openExternal(parsed.toString())
  })

  ipcMain.handle('shell:showItem', (_event, filePath) => {
    if (!filePath || !fs.existsSync(String(filePath))) throw new Error('文件不存在')
    shell.showItemInFolder(String(filePath))
    return true
  })

  /* ------------------------------ 本地素材 ------------------------------ */

  /**
   * 打开系统文件选择框，返回已入库（进白名单）的素材描述。
   * 用户取消时返回空数组，不抛错 —— 取消是正常操作，不该让界面进错误态。
   */
  ipcMain.handle('media:pick', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions = {
      title: '导入素材',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '全部支持的素材', extensions: [...EXT_GROUPS.video, ...EXT_GROUPS.audio, ...EXT_GROUPS.image] },
        { name: '视频', extensions: EXT_GROUPS.video },
        { name: '音频', extensions: EXT_GROUPS.audio },
        { name: '图片', extensions: EXT_GROUPS.image }
      ]
    }
    // 窗口可能已经关了，这时不传父窗口，否则 showOpenDialog 会抛
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled) return []
    /* 导入方式：'copy' = 复制一份进应用的素材目录，之后再移动/删除原文件也不影响草稿；
       'link' = 只引用原路径（省空间，但原文件被移走就变成离线素材）。
       ⚠️ 必须在 describeMedia **之前**换掉路径，否则白名单里登记的还是原路径，
          复制出来的那份播不了（表现为"导入成功了，素材是黑的"）。 */
    const mode = options && options.mode === 'copy' ? 'copy' : 'link'
    return result.filePaths
      .map((filePath) => describeMedia(mode === 'copy' ? copyIntoMaterials(filePath) : filePath))
      .filter(Boolean)
  })

  /**
   * 导入字体：只开一个单选/多选对话框，回来的路径逐个复制进 userData/fonts。
   * 与 media:pick 分开是因为**过滤器不同**（字体不是素材，混进素材对话框会让
   * 用户在"导入素材"里看到一堆 .ttf）。
   */
  ipcMain.handle('font:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions = {
      title: '导入字体',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'ttc'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled) return []
    return result.filePaths.map(importFont).filter(Boolean)
  })

  /** 恢复草稿时要把已经导入过的字体重新登记进白名单（进程重启后白名单是空的） */
  ipcMain.handle('font:allow', (_event, paths) => {
    const list = Array.isArray(paths) ? paths : []
    for (const item of list) {
      const absolute = path.resolve(String(item || ''))
      if (!absolute) continue
      try {
        if (fs.statSync(absolute).isFile()) allowedMedia.add(absolute)
      } catch {
        /* 文件不在了就算了 —— 预览会退回系统字体，导出侧也会自己判断 */
      }
    }
    return true
  })

  /** 拖拽进来的文件只有路径，这里做存在性 + 类型校验，顺便入库 */
  ipcMain.handle('media:stat', (_event, paths) => {
    const list = Array.isArray(paths) ? paths : [paths]
    return list.map(describeMedia).filter(Boolean)
  })

  /** 把本地绝对路径转成可播放 URL（仅对已在白名单里的路径有效） */
  ipcMain.handle('media:url', (_event, filePath) => {
    const absolute = normalizeMediaPath(filePath)
    return absolute && allowedMedia.has(absolute) ? mediaUrlOf(absolute) : ''
  })

  ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.handle('window:toggleMaximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  /* 最大化状态是**主进程的事实**，不能让渲染层自己翻布尔值：
     双击标题栏、Win+↑、拖到屏幕上沿等系统途径也会改变它。 */
  ipcMain.handle('window:isMaximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)

  /* ------------------------------ 成片渲染 ------------------------------ */

  ipcMain.handle('render:probe', () => probeFfmpeg())

  ipcMain.handle('render:pickOutput', async (event, suggested) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '导出成片',
      defaultPath: suggested ? sanitizeOutName(suggested) : '艺镜AI-成片.mp4',
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? '' : result.filePath
  })

  ipcMain.handle('render:start', async (event, payload) => {
    if (activeRender) throw new Error('已有一个导出任务在进行中，请等它结束或先取消')
    const outPath = sanitizeOutName(payload && payload.outPath)
    if (!outPath) throw new Error('输出路径不合法')
    const sender = event.sender
    const controller = new AbortController()
    activeRender = controller
    try {
      return await renderTimeline({
        clips: (payload && payload.clips) || [],
        outPath,
        options: (payload && payload.options) || {},
        /* 背景（素材 → 背景选的那张图）。渲染层给的是 import 出来的 URL，
           打包后指向 app.asar 内 —— 转换与 asar 落地由 render.js 内部处理。 */
        backdrop: (payload && payload.backdrop) || '',
        signal: controller.signal,
        onProgress: (ratio) => {
          if (!sender.isDestroyed()) sender.send('render:progress', { ratio })
        }
      })
    } finally {
      activeRender = null
    }
  })

  ipcMain.handle('render:cancel', () => {
    if (activeRender) activeRender.abort()
    return true
  })

  /* ------------------------------ 提取音频 ------------------------------ */

  /**
   * 「音频 → 提取音频」：把片段的音轨单独抽成一个音频文件。
   *
   * ⚠️ 输出路径由**主进程**决定（userData/audio 下、按片段名 + 时间戳命名），
   * 不让渲染层传路径进来 —— 否则渲染层就能让主进程往任意位置写文件，
   * 与 `sanitizeOutName` 那条规则（只接受绝对路径 + .mp4）是同一道防线。
   * 先 probeStreams 判有没有音轨，避免"提取成功却拿到 0 秒空文件"。
   */
  ipcMain.handle('media:extractAudio', async (_event, payload) => {
    const sourcePath = pathFromMediaUrl(String(payload && payload.sourcePath))
    if (!sourcePath) return { ok: false, error: '源文件路径不合法' }
    const dir = path.join(app.getPath('userData'), 'audio')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = path.join(dir, `extract-${stamp}.m4a`)
    return extractAudioTrack({ sourcePath, outPath })
  })

  /* ------------------------------ 录音配音 ------------------------------ */

  /**
   * 保存一段录音（配音）。
   *
   * 分工：**浏览器侧只负责录**（MediaRecorder 产 blobs），**路径与落盘全在主进程** ——
   * 与 `media:extractAudio` 同一道防线：渲染层能传字节，但传不进"往任意路径写文件"这个能力。
   *
   * ⚠️ 时长由渲染层**测量**后带过来，不在主进程 probe：
   *    MediaRecorder 产出的 webm 头里没有 duration（Chromium 一直是这个行为），
   *    `<audio>` 的 loadedmetadata 拿到的是 Infinity，ffprobe 也要啃完整条流才算得出。
   *    以"用户按开始到按停止的墙钟时间"为准，误差在几十毫秒内，而那正是用户期望的长度。
   *    （这也意味着录音片段**不允许被拉长**：sourceDuration 就是它自己，超出即黑/静音。）
   */
  ipcMain.handle('recording:save', async (_event, payload) => {
    const bytes = payload && payload.bytes
    const byteLength = bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : 0
    if (!byteLength) return { ok: false, error: '没有收到录音数据' }
    /* 上限 200MB：一小时的高质量 opus 也远小于这个数，超过基本是调用方传错了缓冲区 */
    if (byteLength > 200 * 1024 * 1024) return { ok: false, error: '录音数据异常（超过 200MB）' }
    const buffer = Buffer.from(bytes.buffer ? bytes : new Uint8Array(bytes))
    /* 太短的（< 1KB）基本是"按下就停"：写进去之后在时间线上是一个几乎看不见的片段，
       用户以为记录成功、实际什么都没录到。这里明确拒掉，让界面说一句真话。 */
    if (buffer.length < 1024) return { ok: false, error: '这段录音太短了（几乎没有声音）' }
    const dir = path.join(app.getPath('userData'), 'recordings')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const ext = /mp4|m4a|aac/i.test(String(payload.mime || '')) ? '.m4a' : '.webm'
    const outPath = path.join(dir, `配音-${stamp}${ext}`)
    try {
      fs.writeFileSync(outPath, buffer)
    } catch (error) {
      return { ok: false, error: `录音保存失败：${error.message}` }
    }
    const described = describeMedia(outPath)
    if (!described) return { ok: false, error: '录音已落盘但读不出来（文件可能被占用）' }
    /* 进白名单：不进的话 `yjai-media://` 会被协议层 403，预览是一片空白 + 无声，
       而时间线上那个片段卡片画得好好的（"录完了、放不出来"）。 */
    allowedMedia.add(described.path)
    return {
      ok: true,
      asset: {
        ...described,
        /* .webm 在扩展名表里默认算 **video**（普通 webm 多半是视频），
           而录音录制出来的一定是音频 —— 这里显式改掉，否则它会落到视频轨，
           预览去建 <video> 元素（能出声但没有画面层，用户以为录坏了）。 */
        kind: 'audio',
        name: `配音 ${stamp.slice(11, 19).replace(/-/g, ':')}`,
        duration: Number(payload.duration) > 0 ? Number(Number(payload.duration).toFixed(3)) : 0
      }
    }
  })

  /* ------------------------------ 波形峰值 ------------------------------ */

  /**
   * 片段波形用的音频峰值。
   *
   * 入参是 `yjai-media://` 的 URL：渲染层手上只有 URL（片段可视化本来就吃 URL），
   * 让它再自己拼一次路径只会多一处口径。路径还原与合法性判定全部在主进程，
   * 渲染层拿不到"任意路径"这个能力（与 media:extractAudio 同一道防线）。
   */
  ipcMain.handle('media:peaks', async (_event, payload) => {
    const sourcePath = pathFromMediaUrl(String((payload && payload.url) || ''))
    if (!sourcePath) return { ok: false, reason: 'bad-input', error: '源文件路径不合法' }
    return audioPeaksOf({
      sourcePath,
      offset: payload && payload.offset,
      duration: payload && payload.duration,
      buckets: payload && payload.buckets
    })
  })

  /**
   * 场景切换检测（「按场景分割」的探测）。
   *
   * 只吃 `yjai-media://` 的 url，由主进程自己反解成路径 —— 渲染层拿不到、也不该拿
   * 任意路径去喂 ffmpeg（那等于给了一个"读任意文件"的入口）。
   */
  ipcMain.handle('media:scenes', async (_event, payload) => {
    const sourcePath = pathFromMediaUrl(String((payload && payload.url) || ''))
    if (!sourcePath) return { ok: false, reason: 'bad-input', error: '源文件路径不合法' }
    return detectScenesOf({
      sourcePath,
      threshold: payload && payload.threshold,
      duration: payload && payload.duration
    })
  })

  /**
   * 生成预览代理（预览画质档位用它）。
   *
   * 落盘位置固定在 `userData/proxies`：用户可以在资源管理器里找到、也能整目录删掉，
   * 不像"藏在某个缓存目录里"那种清理不掉又占空间的做法。
   * 生成完**必须**登记进白名单，否则 `yjai-media://` 403 —— 预览一直卡在原片上，
   * 而界面上显示"已切到 540p 代理"（第③类静默失效）。
   */
  ipcMain.handle('media:proxy', async (_event, payload) => {
    const sourcePath = pathFromMediaUrl(String((payload && payload.url) || ''))
    if (!sourcePath) return { ok: false, reason: 'bad-input', error: '源文件路径不合法' }
    const outDir = path.join(app.getPath('userData'), 'proxies')
    const result = await makeProxyOf({
      sourcePath,
      height: payload && payload.height,
      outDir
    })
    if (!result.ok) return result
    allowedMedia.add(result.outPath)
    return {
      ok: true,
      url: mediaUrlOf(result.outPath),
      path: result.outPath,
      height: result.height,
      cached: result.cached
    }
  })

  /**
   * HDR 体检：这个素材是不是 HLG / PQ，导出时会做色调映射。
   *
   * 为什么单独一个 IPC 而不是塞进 media:stat：`describeMedia` 是**同步**的纯文件描述
   * （MCP server 也在用），ffprobe 是异步子进程；混进去会让"导入素材"变成一段
   * 会卡的同步等待。界面按需（素材表变化后）问一次即可。
   *
   * 缓存键带 mtime：素材被替换成同名不同内容时不会拿到旧结论。
   */
  ipcMain.handle('media:hdr', async (_event, paths) => {
    const list = Array.isArray(paths) ? paths.slice(0, 64) : []
    const out = []
    for (const raw of list) {
      const absolute = media.normalizeMediaPath(raw)
      if (!absolute) continue
      let mtime = 0
      try {
        mtime = fs.statSync(absolute).mtimeMs
      } catch {
        continue
      }
      const key = `${absolute}|${mtime}`
      if (!hdrCache.has(key)) {
        const streams = await probeStreamsOf(absolute).catch(() => null)
        hdrCache.set(key, {
          hdr: hdrTable.isHdr(streams),
          label: hdrTable.hdrLabel(streams),
          hint: hdrTable.previewHint(streams),
          transfer: (streams && streams.transfer) || '',
          primaries: (streams && streams.primaries) || ''
        })
      }
      out.push({ path: absolute, ...hdrCache.get(key) })
    }
    return out
  })
}

/** 导出路径只接受绝对路径 + .mp4，杜绝渲染进程随手写别的文件 */
function sanitizeOutName(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const absolute = path.resolve(text)
  if (!path.isAbsolute(absolute)) return ''
  return path.extname(absolute).toLowerCase() === '.mp4' ? absolute : ''
}

/* -------------------------------- 启动 -------------------------------- */

// 单实例：第二次启动直接把已有窗口拉到前面，不再开一个
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  /**
   * 硬件加速开关。
   *
   * ⚠️ 必须在 `app.whenReady()` **之前**调用 —— `app.disableHardwareAcceleration()`
   * 是启动期 API，ready 之后再调是无效的（不报错，就是没效果）。
   * 所以保存这个开关**必须重启**才生效，界面里也要这么写。
   *
   * 参考客户端是有这一项的（一手语言包里 `首选项` 紧跟 `语言` / `硬件加速`），
   * 而且配了一句很具体的提示：「导出的视频异常请试图关闭硬件加速」——
   * 说明它是给导出异常兜底用的真设置，不是装饰。
   */
  applyHardwareAccelerationSetting()

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerMediaProtocol()
    registerIpc()
    createWindow()

    /**
     * 把自己注册进「艺镜·镜枢」的 MCP 配置 —— 让镜枢里的 agent 能直接驱动本软件
     * （建草稿 / 加片段字幕特效 / 导出成片）。只有检测到镜枢装过才写；写失败绝不
     * 影响本软件启动。详见 mcp-register.js 顶部的说明。
     *
     * ⚠️ **隔离运行不写**：`--user-data-dir=` 是「给我一个干净/临时 profile」的信号
     *   （E2E、截图取证、调试都在用）。这类运行**绝不能**改用户**全局**的镜枢配置 ——
     *   否则一次测试就会把 `%APPDATA%\yegin\mcp.json` 指向临时目录/dev 路径，
     *   把用户真实的对接配置冲掉（实测踩过一次）。要强制写用 `YIJAI_MCP_REGISTER=1`。
     */
    const isolatedProfile = app.commandLine.hasSwitch('user-data-dir')
    if (!isolatedProfile || process.env.YIJAI_MCP_REGISTER === '1') {
      try {
        const registered = registerMcpServer({
          appDataDir: app.getPath('appData'),
          localAppDataDir: process.env.LOCALAPPDATA || '',
          execPath: process.execPath,
          serverScript: path.join(__dirname, 'mcp-server.js'),
          userDataDir: app.getPath('userData')
        })
        if (registered.written) console.log('[MCP] 已对接镜枢：', registered.reason, registered.file)
      } catch (e) {
        console.warn('[MCP] 对接失败（不影响软件本身）：', e && e.message)
      }
    } else {
      console.log('[MCP] 隔离 profile 运行，跳过对接注册（不动用户全局配置）')
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
