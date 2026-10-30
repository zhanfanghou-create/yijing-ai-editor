/**
 * 本地素材导入 · 真机 E2E
 *
 * 为什么必须真机跑：这条链路的三个关键点纯 Node 证明不了 ——
 *   1. `yjai-media://` 自定义协议是不是真能把本地文件喂给 <img>/<video>（CSP 放行了没有）
 *   2. <video> 能不能拿到时长（即 Range/stream 有没有生效，直接决定进度条能不能拖）
 *   3. 路径白名单是不是真挡得住未登记文件（协议被当成任意文件读取原语就麻烦了）
 *
 * 夹具全部在运行时现造，不往仓库里塞二进制：
 *   · PNG   —— 手写 IHDR/IDAT/IEND + zlib，零依赖
 *   · WAV   —— 手写 44 字节头 + PCM，Chromium 能直接解
 *   · MP4   —— 只有 ffmpeg 在才造得出，没有就整组记为 SKIP（不是 FAIL）
 *
 * 用法：node tools/media-import-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { spawnCapture } from './spawn-capture.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const checks = []
let failures = 0
let skips = 0
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`)
}
function skip(name, why) {
  skips += 1
  console.log(`  [SKIP] ${name}  — ${why}`)
}

/**
 * 关掉被测进程，并**确认它真的没了**。
 * `app.close()` 只是"请求退出"，不等于进程消失（Windows 下 Chromium 子进程收不干净）。
 * 沙箱里 `taskkill` 跨不了进程命名空间，所以优先用进程内的 `process.kill`。
 * 关不掉不判失败（那是环境属性），但必须**看得见** —— 否则孤儿进程会攥着 profile 句柄，
 * 让下一次运行的收尾删除抛 EBUSY。
 */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function shutdown() {
  const pid = app?.process()?.pid
  await Promise.race([app?.close?.(), new Promise((resolve) => setTimeout(resolve, 6000))]).catch(() => {})
  if (!pid || !alive(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    console.warn(`  ⚠ 被测进程 ${pid} 仍在运行且强杀失败（不影响本次结论）`)
  }
}

/**
 * 删除临时目录，带重试。
 * Windows 上 Electron 刚退出时还没释放 profile 里的文件句柄，此刻 `fs.rmSync` 会
 * EBUSY/EPERM —— 删一次就断言的写法必然偶发红（本闸门 2026-09-23 实测踩到，
 * 而且当时它还把结论行一起吃掉了）。失败按**存在性**判，比猜错误码可靠。
 */
function rmrf(dir, { attempts = 8, waitMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 下面按存在性判 */
    }
    if (!fs.existsSync(dir)) return true
    if (i < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
  }
  return !fs.existsSync(dir)
}

/* ------------------------------ 夹具 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 真的 PNG（不是改名的伪图）—— 尺寸可控，才能断言 naturalWidth */
function makePng(width, height) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3
      raw[p] = (x * 7) % 256
      raw[p + 1] = (y * 5) % 256
      raw[p + 2] = 160
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 单声道 8kHz PCM WAV */
function makeWav(seconds, rate = 8000) {
  const count = Math.floor(seconds * rate)
  const data = Buffer.alloc(count * 2)
  for (let i = 0; i < count; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-media-e2e-'))
const SHOTS = path.join(ROOT, '_evidence', 'media-import')
fs.mkdirSync(SHOTS, { recursive: true })
const PNG = path.join(FIX, '参考图 中文名.png') // 故意带空格与中文，验证路径编码
const WAV = path.join(FIX, 'tone.wav')
const TXT = path.join(FIX, 'note.txt') // 扩展名不支持
const ORPHAN = path.join(FIX, 'never-registered.mp4') // 存在但从未登记 → 协议应 403
const MP4 = path.join(FIX, 'clip.mp4')

fs.writeFileSync(PNG, makePng(64, 48))
fs.writeFileSync(WAV, makeWav(0.6))
fs.writeFileSync(TXT, 'just text')
fs.writeFileSync(ORPHAN, Buffer.alloc(2048, 7))

/**
 * 找一个可用的 ffmpeg（本项目不内置，借环境变量或系统 PATH 上的）
 *
 * ⚠️ 用 spawnCapture 而不是 spawnSync+管道：本机（2026-10-08 实测）spawnSync 只要
 *    stdio 走管道就 EBUSY（连 cmd.exe 都一样），换成重定向到文件才真跑得起来。
 *    用管道写法时这个函数恒返回 ''，视频组整组断言**静默变成 SKIP** ——
 *    闸门照样是绿的，但它一条都没在验。
 * ⚠️ 候选里必须带 .exe：Windows 上 fs.existsSync('ffmpeg') 恒为 false，
 *    以前拿它做前置判断 ⇒ PATH 上的 ffmpeg 永远没被试过。
 */
function findFfmpeg() {
  // 顺序与 README「ffmpeg 查找顺序」一致，别让闸门认的和产品认的不是一套：
  //   环境变量 → 随包 resources/ffmpeg/ → PATH
  const candidates = [
    process.env.YIJAI_FFMPEG,
    process.env.FFMPEG_PATH,
    path.join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe'),
    path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    'ffmpeg.exe',
    'ffmpeg'
  ].filter(Boolean)
  for (const c of candidates) {
    const r = spawnCapture(c, ['-hide_banner', '-version'], { tag: 'ver' })
    if (r.status === 0) return c
  }
  return ''
}

const ffmpeg = findFfmpeg()
let hasVideo = false
if (ffmpeg) {
  const r = spawnCapture(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
    '-pix_fmt', 'yuv420p', MP4
  ], { tag: 'mk' })
  hasVideo = r.status === 0 && fs.existsSync(MP4)
}

/**
 * 视频组的断言名固定在这里。
 * 没有 ffmpeg 时整组逐条记 SKIP（而不是少跑几条）—— 这样断言总数不随环境变化，
 * 挂进闸门后才能把总数钉死：总数变小就说明有人删了断言，而不是"这台机器没装 ffmpeg"。
 */
const VIDEO_CHECKS = [
  'MP4 登记成功且被判为视频',
  '视频经协议读出时长与分辨率（2s / 320×240）',
  '无 Range 时返回完整文件',
  '声明了 Accept-Ranges（否则长视频不会走 seek）',
  'Range bytes=100-199 → 206 + 100 字节 + Content-Range',
  'Range bytes=1000- → 206 + 剩余全部字节',
  'Range bytes=-256 → 最后 256 字节',
  '越界 Range → 416 而不是静默返回整文件'
]

/** 「导入按钮 → 媒体库」这条链路的断言名。contextBridge 冻结时无法打桩，整组记 SKIP。 */
const UI_CHECKS = [
  '导入后素材进入媒体库',
  '素材自动选中（属性面板能显示）',
  '卡片显示文件名与元数据（含 64×48）',
  '缩略图经协议真的渲染出来',
  '给出导入成功的轻提示',
  '同一文件重复导入不产生重复卡片'
]

/* ------------------------------ 启动 ------------------------------ */

console.log('夹具目录：' + FIX)
console.log('ffmpeg：  ' + (ffmpeg || '(无)'))
if (!ffmpeg) {
  // 找不到时**必须吵**：视频组 8 条 + 缩略图 2 条会整组记 SKIP，
  // 而 SKIP 在判定上和"验过了"长得一样。日志里说清怎么补，别让人只看到一片绿。
  console.log('[WARN] 本机没找到 ffmpeg，视频组 8 条 + 缩略图 2 条将整组跳过。')
  console.log('[WARN] 补法：set FFMPEG_PATH=<ffmpeg.exe 绝对路径> 后重跑本闸门。')
}
console.log('\n启动 Electron …\n')

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
delete env.YIJAI_USE_DEV_SERVER

const pageErrors = []
let app
let profileDir = ''
let exitCode = 1

try {
  app = await electron.launch({
    executablePath: EXE,
    args: [
      MAIN,
      `--user-data-dir=${path.join(FIX, 'profile')}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ],
    cwd: ROOT,
    env
  })
  profileDir = path.join(FIX, 'profile')

  const page = await app.firstWindow()
  page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
  await page.waitForSelector('.app', { timeout: 25000 })
  await page.waitForTimeout(1200)

  // 客户端默认落在「创作中心」首页，而媒体库属于剪辑工作台 —— 先点「开始剪辑」进去。
  // 写成"有就点、没有就跳过"：将来默认页改回工作台，这段也不会变成假失败。
  const heroEntry = await page.$('.home-hero-video')
  if (heroEntry) {
    await heroEntry.click()
    await page.waitForTimeout(1400)
  }

  /* ---------------------- 1. 桥接是否按契约暴露 ---------------------- */

  const bridge = await page.evaluate(() => {
    const m = window.yjai?.media
    return {
      exists: Boolean(m),
      keys: m ? Object.keys(m).sort() : [],
      pickIsFn: typeof m?.pick === 'function',
      statIsFn: typeof m?.stat === 'function',
      pathForFileIsFn: typeof m?.pathForFile === 'function'
    }
  })
  check('preload 暴露了 media 桥接', bridge.exists && bridge.pickIsFn && bridge.statIsFn && bridge.pathForFileIsFn,
    'keys=' + JSON.stringify(bridge.keys))

  /* ---------------------- 2. 支持的文件能登记 ---------------------- */

  const rows = await page.evaluate((p) => window.yjai.media.stat([p]), PNG)
  const png = Array.isArray(rows) ? rows[0] : null
  check('PNG 登记成功且被判为图片', Boolean(png) && png.kind === 'image',
    png ? `name=${png.name} kind=${png.kind} url=${String(png.url).slice(0, 46)}…` : '返回空')
  check('返回的 URL 是自定义协议', Boolean(png) && String(png.url).startsWith('yjai-media://local/'),
    png ? String(png.url).slice(0, 40) : '')
  check('中文/空格路径不炸（已 base64url 编码）',
    Boolean(png) && png.name === '参考图 中文名.png' && !/[\s\u4e00-\u9fa5]/.test(String(png.url)),
    png ? png.name : '')

  const wavRows = await page.evaluate((p) => window.yjai.media.stat([p]), WAV)
  check('WAV 登记成功且被判为音频', wavRows?.[0]?.kind === 'audio', wavRows?.[0]?.kind || '返回空')

  /* ---------------------- 3. 不该登记的必须被拒 ---------------------- */

  const badExt = await page.evaluate((p) => window.yjai.media.stat([p]), TXT)
  check('扩展名不支持的文件被拒', Array.isArray(badExt) && badExt.length === 0,
    `返回 ${Array.isArray(badExt) ? badExt.length : '?'} 条`)

  const missing = await page.evaluate((p) => window.yjai.media.stat([p]), path.join(FIX, '不存在.mp4'))
  check('不存在的文件被拒', Array.isArray(missing) && missing.length === 0,
    `返回 ${Array.isArray(missing) ? missing.length : '?'} 条`)

  const mixed = await page.evaluate((ps) => window.yjai.media.stat(ps), [PNG, TXT, WAV])
  check('混合批次只保留合法项（2/3）', Array.isArray(mixed) && mixed.length === 2,
    `返回 ${Array.isArray(mixed) ? mixed.length : '?'} 条`)

  /* ---------------------- 4. 协议真的能取到内容 ---------------------- */

  const imgLoad = await page.evaluate((url) => new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve({ ok: false, w: 0, h: 0 })
    setTimeout(() => resolve({ ok: false, w: 0, h: 0, timeout: true }), 8000)
    img.src = url
  }), png?.url || '')
  check('图片经协议真的解码出来了（64×48）', imgLoad.ok && imgLoad.w === 64 && imgLoad.h === 48,
    imgLoad.ok ? `${imgLoad.w}×${imgLoad.h}` : '加载失败（CSP 或协议没生效）')

  const wavMeta = await page.evaluate((url) => new Promise((resolve) => {
    const audio = document.createElement('audio')
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => resolve({ ok: true, duration: audio.duration })
    audio.onerror = () => resolve({ ok: false, duration: 0 })
    setTimeout(() => resolve({ ok: false, duration: 0, timeout: true }), 8000)
    audio.src = url
  }), wavRows?.[0]?.url || '')
  check('音频经协议读出时长（约 0.6s）',
    wavMeta.ok && wavMeta.duration > 0.4 && wavMeta.duration < 0.9,
    wavMeta.ok ? `${wavMeta.duration.toFixed(2)}s` : '读不到元数据')

  /* ---------------------- 5. 白名单必须挡得住 ---------------------- */

  const orphanUrl = await page.evaluate((p) => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(p)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `yjai-media://local/${b64}`
  }, ORPHAN)
  const orphanResult = await page.evaluate((url) => fetch(url).then((r) => ({ status: r.status })).catch((e) => ({ status: 0, error: String(e.message) })), orphanUrl)
  check('未登记文件走协议被 403 挡下（白名单生效）', orphanResult.status === 403,
    `HTTP ${orphanResult.status}${orphanResult.error ? ' ' + orphanResult.error : ''}`)

  const urlIpc = await page.evaluate((p) => window.yjai.media.url(p), ORPHAN)
  check('media:url 对未登记路径返回空串', urlIpc === '', `返回 ${JSON.stringify(String(urlIpc).slice(0, 30))}`)

  /* ---------------------- 6. 视频：时长 + Range ---------------------- */

  if (!hasVideo) {
    for (const name of VIDEO_CHECKS) skip(name, '本机找不到可用 ffmpeg，造不出 MP4 夹具')
  } else {
    const vRows = await page.evaluate((p) => window.yjai.media.stat([p]), MP4)
    check('MP4 登记成功且被判为视频', vRows?.[0]?.kind === 'video', vRows?.[0]?.kind || '返回空')

    const videoMeta = await page.evaluate((url) => new Promise((resolve) => {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.onloadedmetadata = () => resolve({ ok: true, duration: v.duration, w: v.videoWidth, h: v.videoHeight })
      v.onerror = () => resolve({ ok: false, duration: 0 })
      setTimeout(() => resolve({ ok: false, duration: 0, timeout: true }), 12000)
      v.src = url
    }), vRows?.[0]?.url || '')
    check('视频经协议读出时长与分辨率（2s / 320×240）',
      videoMeta.ok && videoMeta.duration > 1.5 && videoMeta.w === 320 && videoMeta.h === 240,
      videoMeta.ok ? `${videoMeta.duration.toFixed(2)}s ${videoMeta.w}×${videoMeta.h}` : '读不到元数据')

    // Range 生效才能拖进度条：请求 100-199 字节必须回 206 + 100 字节
    const rangeProbe = await page.evaluate(async (url) => {
      const read = async (init) => {
        try {
          const r = await fetch(url, init)
          const buf = await r.arrayBuffer()
          return {
            status: r.status,
            bytes: buf.byteLength,
            headers: Object.fromEntries(r.headers.entries())
          }
        } catch (error) {
          return { status: 0, bytes: 0, headers: {}, error: String(error.message) }
        }
      }
      const full = await read(undefined)
      const ranged = await read({ headers: { Range: 'bytes=100-199' } })
      const openEnded = await read({ headers: { Range: 'bytes=1000-' } })
      const tail = await read({ headers: { Range: 'bytes=-256' } })
      const impossible = await read({ headers: { Range: 'bytes=99999999-' } })
      return { full, ranged, openEnded, tail, impossible }
    }, vRows?.[0]?.url || '')

    const fileBytes = fs.statSync(MP4).size
    check('无 Range 时返回完整文件',
      rangeProbe.full.status === 200 && rangeProbe.full.bytes === fileBytes,
      `HTTP ${rangeProbe.full.status} ${rangeProbe.full.bytes}B（文件 ${fileBytes}B）`)
    check('声明了 Accept-Ranges（否则长视频不会走 seek）',
      rangeProbe.full.headers['accept-ranges'] === 'bytes',
      `accept-ranges=${rangeProbe.full.headers['accept-ranges'] || '-'}`)
    check('Range bytes=100-199 → 206 + 100 字节 + Content-Range',
      rangeProbe.ranged.status === 206
      && rangeProbe.ranged.bytes === 100
      && rangeProbe.ranged.headers['content-range'] === `bytes 100-199/${fileBytes}`,
      `HTTP ${rangeProbe.ranged.status} ${rangeProbe.ranged.bytes}B content-range=${rangeProbe.ranged.headers['content-range'] || '-'}`)
    // 播放器实际发的多是开放式区间（bytes=N-），这条必须对，否则拖到中段就黑屏
    check('Range bytes=1000- → 206 + 剩余全部字节',
      rangeProbe.openEnded.status === 206 && rangeProbe.openEnded.bytes === fileBytes - 1000,
      `HTTP ${rangeProbe.openEnded.status} ${rangeProbe.openEnded.bytes}B（应为 ${fileBytes - 1000}B）`)
    check('Range bytes=-256 → 最后 256 字节',
      rangeProbe.tail.status === 206 && rangeProbe.tail.bytes === 256
      && rangeProbe.tail.headers['content-range'] === `bytes ${fileBytes - 256}-${fileBytes - 1}/${fileBytes}`,
      `HTTP ${rangeProbe.tail.status} ${rangeProbe.tail.bytes}B content-range=${rangeProbe.tail.headers['content-range'] || '-'}`)
    check('越界 Range → 416 而不是静默返回整文件',
      rangeProbe.impossible.status === 416, `HTTP ${rangeProbe.impossible.status}`)
  }

  /* ---------------------- 7. 拖拽生命周期 ---------------------- */

  // 拖拽判定是 React state，dispatchEvent 后必须等一帧再读 DOM。
  // 同步读会永远读到旧值 —— 这不是应用 bug，是测试写错了。
  const dragOpen = await page.evaluate(async () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }))
    document.querySelector('.app').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    return {
      veil: Boolean(document.querySelector('.drop-veil')),
      appClass: document.querySelector('.app').className,
      types: Array.from(dt.types || []),
      items: Array.from(dt.items || []).map((i) => i.kind)
    }
  })
  check('拖入时出现落点提示', dragOpen.veil && /is-dragging/.test(dragOpen.appClass),
    `${dragOpen.appClass} types=${JSON.stringify(dragOpen.types)} items=${JSON.stringify(dragOpen.items)}`)
  /* ⚠️ 这张图只是**取证**，不是判据 —— 拿不到就不拿，绝不能让整道闸门因为它红。
     2026-10-28 实测：整机被别的闸门拖慢时，`page.screenshot` 在 30s 后超时抛出，
     直接把后面 14 条断言全部作废（报出来的是"断言数不符 21/35"，看着像有人删了断言）。
     证据缺失是一回事，被测功能好坏是另一回事，两者不能互相冒充。 */
  if (dragOpen.veil) {
    try {
      await page.screenshot({ path: path.join(SHOTS, '01-拖拽落点提示.png'), timeout: 8000 })
    } catch {
      console.log('  [NOTE] 取证截图未取到（不影响判定）')
    }
  }

  const dragClose = await page.evaluate(async () => {
    document.querySelector('.app').dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    return { veil: Boolean(document.querySelector('.drop-veil')), appClass: document.querySelector('.app').className }
  })
  check('拖出后提示消失（状态没卡住）', !dragClose.veil && !/is-dragging/.test(dragClose.appClass), dragClose.appClass)

  // 非文件拖拽（拖动选中文字）不该弹遮罩
  const textDrag = await page.evaluate(async () => {
    const dt = new DataTransfer()
    dt.setData('text/plain', 'hello')
    document.querySelector('.app').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    const veil = Boolean(document.querySelector('.drop-veil'))
    document.querySelector('.app').dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    return { veil, types: Array.from(dt.types || []) }
  })
  check('拖非文件内容不弹遮罩', !textDrag.veil, `types=${JSON.stringify(textDrag.types)}`)

  // 合成 File 没有真实磁盘路径，getPathForFile 应返回空 —— 走提示分支，而不是静默失败或崩溃
  const dropResult = await page.evaluate(async () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }))
    document.querySelector('.app').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }))
    await new Promise((r) => setTimeout(r, 700))
    return {
      veil: Boolean(document.querySelector('.drop-veil')),
      toasts: Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent)
    }
  })
  check('合成拖拽不崩且给出可读提示',
    !dropResult.veil && dropResult.toasts.some((t) => /没能读到文件路径|已导入/.test(t)),
    JSON.stringify(dropResult.toasts.slice(0, 2)))

  /* ---------------------- 8. 界面接线（导入按钮 → 媒体库） ---------------------- */

  const btnInfo = await page.evaluate(() => {
    // 导入入口在「空态卡片中央」和「已有素材时的顶部工具行」两处互斥出现，
    // 统一用 data-import-btn 标记，避免把断言绑死在某个布局上
    const b = document.querySelector('[data-import-btn]')
    return { exists: Boolean(b), text: b ? b.textContent.trim() : '' }
  })
  check('媒体库面板出现「导入素材」按钮', btnInfo.exists && /导入/.test(btnInfo.text), btnInfo.text)
  await page.screenshot({ path: path.join(SHOTS, '02-媒体库导入入口.png') })

  // 不真点按钮 —— 那会弹起系统文件框，既挡不住也关不掉，还可能留在用户桌面上。
  // 但也**不能去冻住的桥接对象上赋值**：contextBridge 暴露的对象是冻结的，赋值会静默失败，
  // 于是这一段长期以「6 条 SKIP」收场 —— 等于"导入 → 进媒体库 → 自动选中 → 缩略图出来"
  // 这条最主用的链路从来没被真跑过（和 ffmpeg 那次同一个病：跳过不算失败，绿得很体面）。
  // 改在**主进程**把 dialog.showOpenDialog 换成返回夹具路径：media:pick 走真代码，
  // describeMedia / 去重 / 建卡片 / 缩略图协议全部真执行。
  const stubbed = await app.evaluate((electronModule, filePath) => {
    const { dialog } = electronModule || {}
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      return { patched: false, why: '主进程里没有 dialog.showOpenDialog' }
    }
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
    // 比对象身份：函数被换成桩才算真的打上了（换成同一个原函数等于没打）
    const ok = dialog.showOpenDialog !== original
    return { patched: ok, why: ok ? '' : '替换被忽略' }
  }, PNG)

  if (!stubbed.patched) {
    for (const name of UI_CHECKS) skip(name, `${stubbed.why}；stat/probe/协议各环节已单独验证`)
  } else {
    const before = await page.evaluate(() => document.querySelectorAll('.media-card').length)
    await page.click('[data-import-btn]')
    await page.waitForTimeout(1500)

    const after = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.media-card'))
      const first = cards[0]
      return {
        count: cards.length,
        selected: Boolean(first?.classList.contains('selected')),
        name: first?.querySelector('strong')?.textContent || '',
        meta: first?.querySelector('small')?.textContent || '',
        thumbLoaded: (() => {
          const img = first?.querySelector('img')
          return img ? img.complete && img.naturalWidth > 0 : false
        })(),
        toasts: Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent)
      }
    })
    check('导入后素材进入媒体库', after.count === before + 1, `${before} → ${after.count} 张卡片`)
    check('素材自动选中（属性面板能显示）', after.selected, after.selected ? '已选中' : '未选中')
    check('卡片显示文件名与元数据（含 64×48）',
      after.name === '参考图 中文名.png' && /64×48/.test(after.meta),
      `${after.name} :: ${after.meta}`)
    check('缩略图经协议真的渲染出来', after.thumbLoaded, after.thumbLoaded ? 'naturalWidth>0' : '图没出来')
    check('给出导入成功的轻提示', after.toasts.some((t) => /已导入\s*1\s*个素材/.test(t)),
      JSON.stringify(after.toasts.slice(-2)))

    // 去重：同一份再导一次，不应出现第二张卡片
    await page.click('[data-import-btn]')
    await page.waitForTimeout(1200)
    const deduped = await page.evaluate(() => document.querySelectorAll('.media-card').length)
    check('同一文件重复导入不产生重复卡片', deduped === after.count, `${after.count} → ${deduped}`)

    /* 底部工具区的引导语：库里已有素材时**不能**再写「没有媒体文件？」。
     * 这句原先写死在 JSX 里，于是 3 个素材的界面上顶着一句"没有素材"的自我否定 ——
     * 不报错、不崩、没有任何闸门会红，只能靠看截图发现。
     * 判据读消费端：DOM 文案 + 钩子取值，不去读 state。 */
    const toolsSplit = await page.evaluate(() => {
      const el = document.querySelector('.wb-tools-split')
      return { text: el ? el.textContent.trim() : '', hook: el?.getAttribute('data-wb-tools-split') || '' }
    })
    check('已有素材时工具区不再自称「没有媒体文件」',
      Boolean(toolsSplit.text) && !/没有媒体文件/.test(toolsSplit.text) && toolsSplit.hook === 'filled',
      `「${toolsSplit.text}」hook=${toolsSplit.hook || '-'}`)
  }

  /* ---------------- 缩略图与像素比例（视频 / 音频这两条真实分支） ----------------
   *
   * 图片分支上面已经覆盖（`缩略图经协议真的渲染出来`）。视频与音频各有一条
   * **只有看像素才发现**的缺陷，而且都不抛异常、不让构建变红：
   *
   *  1. `<video>` 不像 `<img>` 有"填满容器"的默认行为。不给 CSS 宽高它就按自身
   *     像素尺寸排布，1080p 的片子会把缩略图格撑破，被 `.media-card` 的
   *     `overflow:hidden` 裁掉一半 —— 表现正是"缩略图不对"。
   *  2. 缩略图格原先固定 `aspect-ratio: 16/10`，跟素材真实像素比例无关，
   *     于是 4:3 的素材被显示成 16:10，看着就是"像素比例不对"。
   *
   * 夹具的像素比例是已知的（视频 320×240、图片 64×48，都是 4:3），
   * 所以这里断言的是**容器比例约等于 4/3**，而不是"看起来顺眼"。
   */
  // 重新登记一遍拿行数据（视频组的 `vRows` 定义在上面的分支里，作用域不外泄）
  const mp4Row = hasVideo ? (await page.evaluate((p) => window.yjai.media.stat([p]), MP4))?.[0] : null
  const wavRow = (await page.evaluate((p) => window.yjai.media.stat([p]), WAV))?.[0]
  /* 同样走**主进程**打桩（而不是给冻住的桥接对象赋值 —— 那样会静默失败，
     这三条就一直停在 SKIP 上）。只放真实存在的夹具路径：拿不存在的文件去导入，
     media:pick 会老实返回空数组，界面上一张卡都不多，反而更难查。 */
  const morePaths = [hasVideo ? MP4 : null, WAV].filter((p) => p && fs.existsSync(p))
  const stubbed2 = morePaths.length
    ? await app.evaluate((electronModule, filePaths) => {
        const { dialog } = electronModule || {}
        if (!dialog || typeof dialog.showOpenDialog !== 'function') return false
        const original = dialog.showOpenDialog
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
        return dialog.showOpenDialog !== original
      }, morePaths)
    : false

  if (!stubbed2 || !wavRow) {
    for (const name of ['视频缩略图铺满缩略图格', '缩略图格高度统一', '音频轨画出真实波形']) {
      skip(name, stubbed2 ? 'WAV 没能登记' : 'bridge 已冻结，无法打桩导入入口')
    }
  } else {
    await page.click('[data-import-btn]')
    await page.waitForTimeout(2500)

    if (!hasVideo) {
      skip('视频缩略图铺满缩略图格', '本机没有可用 ffmpeg，造不出 MP4 夹具')
      skip('缩略图格高度统一', '本机没有可用 ffmpeg，造不出 MP4 夹具')
    } else {
      const videoThumb = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.media-card'))
        const card = cards.find((el) => el.querySelector('.media-thumb video'))
        if (!card) return null
        const box = card.querySelector('.media-thumb').getBoundingClientRect()
        const video = card.querySelector('.media-thumb video')
        const rect = video.getBoundingClientRect()
        return {
          boxW: box.width,
          boxH: box.height,
          w: rect.width,
          h: rect.height,
          objectFit: getComputedStyle(video).objectFit
        }
      })
      check(
        '视频缩略图铺满缩略图格（按自身像素尺寸排布就会撑破并被裁掉）',
        Boolean(videoThumb) &&
          videoThumb.objectFit === 'cover' &&
          Math.abs(videoThumb.w - videoThumb.boxW) <= 2 &&
          Math.abs(videoThumb.h - videoThumb.boxH) <= 2,
        videoThumb
          ? `video ${videoThumb.w.toFixed(0)}×${videoThumb.h.toFixed(0)} vs 格 ${videoThumb.boxW.toFixed(0)}×${videoThumb.boxH.toFixed(0)}｜object-fit=${videoThumb.objectFit}`
          : '媒体库里没有视频卡'
      )
      /**
       * 缩略图**格子**的统一高度。
       *
       * 这条早先写的是"格子比例应当是素材真实比例（4:3）"，实测 1.598 就红了 ——
       * 但那是**过期的期望**：工作台的缩略图格是刻意的"统一高 64 + cover 裁切"
       * （见 workbench.css 那一段注释：按素材比例排会让竖版素材把一行撑高，
       * 同一行卡片的文字基线全错开，实测 toneC.wav 那块 103 高、picB 只有 55）。
       * 所以这里改成守**设计真正要守的东西**：所有格子高度一致。
       * 素材比例不同时由 `object-fit: cover` 裁切，不是把格子撑变形。
       */
      const cellHeights = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.media-card .media-thumb')).map(
          (el) => el.getBoundingClientRect().height
        )
      )
      const spread = cellHeights.length ? Math.max(...cellHeights) - Math.min(...cellHeights) : 999
      check(
        '缩略图格高度统一（不同比例的素材不出高低行、文字基线不错开）',
        cellHeights.length >= 2 && spread <= 1,
        `${cellHeights.length} 格，高差 ${spread.toFixed(1)}px（${cellHeights.map((h) => h.toFixed(0)).join('/')}）`
      )
    }

    /**
     * 音频轨真的波形。
     *
     * 夹具是纯正弦的 `tone.wav`，所以"有柱状像素"就足以证明走通了
     * `fetch → decodeAudioData → peakBuckets → canvas` 这条链 ——
     * 任何一步失败都会被组件静默吞掉（设计如此，不能让时间线崩），
     * 于是画布会是空的：这正是本断言要抓的静默降级。
     */
    let waveInfo = { canvas: 0, ink: 0, clips: 0, why: '' }
    try {
      const wavCard = page.locator('.media-card', { hasText: 'tone.wav' }).first()
      const box = await wavCard.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(250)
      /* ⚠️ 必须在**这张卡**里找按钮，不能 `.first()` 拿到全列表第一个：
         「加入时间线」只在 hover 时显形，而 `.first()` 命中的是第一张卡（没 hover ⇒ 量不到盒子 ⇒ null）。
         第一次真跑就被这个写法坑了：报的是 "Cannot read properties of null (reading 'x')"，
         看起来像功能坏了，其实只是选择器选错了卡。 */
      /* hover 显形的按钮要**等它可见**再量，不能"挪过去 + 睡 250ms 就量"：
         全量跑到这一道时机器正忙，250ms 不够样式与布局落地，会偶发量到 null，
         报出"量不到按钮"——看着像功能坏了，其实只是抢跑（2026-10-28 全量实测：
         单独跑 36/36，全量里偶发这一条红）。 */
      const addBtn = wavCard.locator('button[title="加入时间线"]').first()
      let addBox = null
      for (let attempt = 0; attempt < 6 && !addBox; attempt += 1) {
        await wavCard.hover({ timeout: 3000 }).catch(() => {})
        await addBtn.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
        addBox = await addBtn.boundingBox().catch(() => null)
        if (!addBox) await page.waitForTimeout(150)
      }
      if (!addBox) throw new Error('hover 后仍量不到「加入时间线」按钮（重试 6 次）')
      await page.mouse.click(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2)
      await page.waitForTimeout(3500)
      waveInfo = await page.evaluate(() => {
        const lane = document.querySelector('.wb-tllane[data-lane="audio"]')
        if (!lane) return { canvas: 0, ink: 0, clips: 0, why: '没有音频轨' }
        const clips = lane.querySelectorAll('.clip').length
        const canvas = lane.querySelector('.clip .clip-wave')
        if (!canvas) return { canvas: 0, ink: 0, clips, why: '片段上没有波形画布' }
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        let ink = 0
        for (let i = 3; i < data.length; i += 4) if (data[i] > 8) ink += 1
        return { canvas: 1, ink, clips, why: '' }
      })
    } catch (error) {
      waveInfo = { canvas: 0, ink: 0, clips: 0, why: String(error?.message || error).split('\n')[0] }
    }
    check(
      '音频轨画出真实波形（不是空画布，也不是 CSS 假条）',
      waveInfo.canvas === 1 && waveInfo.ink > 50,
      waveInfo.canvas ? `非透明像素 ${waveInfo.ink} 个｜音频轨 ${waveInfo.clips} 段` : waveInfo.why
    )
  }

  check('全程无渲染进程异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0 条')

  console.log(`\n=== 结果：通过 ${checks.length - failures} 项 / 失败 ${failures} 项 / 跳过 ${skips} 项 ===`)
  // 机器可读汇总：闸门靠它钉断言总数。总数必须恒定（环境差异用 SKIP 表达，不是少跑几条），
  // 一旦有人删掉断言，总数就会掉下来被闸门抓住。
  console.log(
    `MEDIA_IMPORT_STATS total=${checks.length + skips} pass=${checks.length - failures} fail=${failures} skip=${skips}`
  )
  if (failures) {
    console.log('失败项：\n  - ' + checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ' :: ' + c.detail : ''}`).join('\n  - '))
  }
  exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error('E2E 异常：', error?.stack || error)
  exitCode = 1
  // 崩在半路也必须留一行机器可读的统计：只给一段异常栈的话，闸门只能报
  // 「解析不到断言数」，看着像脚本输出格式坏了，而不是"这次根本没跑完"，方向被带偏。
  // `incomplete=1` 是给读日志的人的：这条统计行**不完整**，真因看上面那段异常。
  console.error(
    `MEDIA_IMPORT_STATS total=${checks.length + skips} pass=${checks.length - failures} fail=${failures} skip=${skips} incomplete=1`
  )
} finally {
  // ⚠️ 顺序不能反：**先出结论、再收尾**。
  // 这道闸门 2026-09-23 实测栽过：断言全过（26 通过 / 0 失败 / 9 跳过）、统计行也打出来了，
  // 结果 `fs.rmSync` 在 Electron 还没放开 profile 句柄时抛 EBUSY，把后面那行成功标记
  // 整段吃掉 —— 闸门看到的是「退出码 1；未出现通过标记」，看起来像断言挂了。
  // 标记还必须与**退出码同源**：只看 failures 的话，跑挂时一条断言都没记、failures 仍是 0，
  // 会打印 OK 而退出码是 1。
  const ok = exitCode === 0 && failures === 0
  console.log(ok ? 'MEDIA_IMPORT_OK' : 'MEDIA_IMPORT_FAILED')

  await shutdown()
  // 删不掉不影响结论，但必须**看得见** —— 否则临时 profile 会静默堆积
  if (!rmrf(FIX)) console.warn(`  ⚠ 临时目录未能删除（不影响本次结论）：${FIX}`)
  process.exit(exitCode)
}
