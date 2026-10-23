#!/usr/bin/env node
/**
 * 真实影片走完整链路 · 真机 E2E
 *
 * 为什么已有 media-import-e2e 还要再做一遍：
 * 那道闸门的"视频"是 ffmpeg 用 `testsrc` 现造的 2 秒 320×240 合成片 —— 它证明的是
 * 「协议能取流、Range 头齐不齐」，但**证明不了真实影片能过**。真实影片和合成片在
 * 这条链路上有四处本质差别，每一处都能让功能静默错位：
 *
 *   1. **体积**：138MB vs 几十 KB。Range 的偏移算术在大文件上才真正被压到
 *      （byte 偏移、`bytes=-N` 的尾段、越界判定），小文件可能整个塞进一次读就蒙对了。
 *   2. **B 帧 / 稀疏关键帧**：合成片是纯 I 帧。真实 h264 有 B 帧，seek 到非关键帧
 *      要靠解码器回退到前一个 I 帧再往前解 —— 这一步失败的表现是"进度条能拖但画面不动"，
 *      元数据断言全绿也看不出来。
 *   3. **真音轨**：合成片没有音频。有音轨才会走到"音轨时长与视频时长不一致"这种真实容器的
 *      常见形态（本片视频 72.933s / 音频 72.911s，本来就差 22ms）。
 *   4. **真实片长**：合成片 2 秒。而时间线片段在素材时长缺失时兜底 5 秒
 *      （DEFAULT_CLIP_SECONDS）。2 秒素材被替换成 5 秒兜底值时两条路算出同一个数，
 *      **缺陷隐身**；72.93 秒才会让"片段时长 = 素材真实片长"这条不变式暴露出来。
 *
 * 判据不靠"看起来对"：
 *   · 时长 / 分辨率 / 音轨 —— 以 **ffprobe 的输出为地面真值** 去对；
 *   · Range —— 以 **磁盘上那 1024 个字节** 逐字节去对（不是只对长度）；
 *   · 真解码 —— 用 requestVideoFrameCallback 的**已呈现帧数**来证，
 *     这个数与画布是否被污染无关（合成片/坏容器上它不涨）。
 *
 * 关于"导入"这一步怎么打桩：
 *   渲染层的 `window.yjai` 是 contextBridge 冻结对象，赋值会被静默忽略
 *   （media-import-e2e 的 6 条 UI 断言正是因为这一点而 SKIP）；而在 Electron 里点
 *   「导入」弹的是**主进程**的系统文件框，Playwright 拦不到。所以在**主进程边界**把
 *   `dialog.showOpenDialog` 换成返回本片路径：这样 `media:pick` → `describeMedia`
 *   → 白名单 → `probeMedia` → `importLocalMedia` → 媒体库卡片 → 时间线 全是真代码，
 *   被替换掉的只有最外层那个"选哪个文件"的系统对话框。
 *
 * 影片从本机已知位置找（可用 YJAI_REAL_FILM 覆盖）。找不到就整组记 SKIP ——
 * 不是 FAIL，也不是少跑几条：**断言名固定、总数恒定**，闸门才能钉住总数，
 * 否则"有人删了断言"和"这台机器没片源"看起来一模一样。
 *
 * 用法：
 *   node tools/real-film-e2e.mjs
 *   YJAI_REAL_FILM="D:\x\y.mp4" node tools/real-film-e2e.mjs
 *   YJAI_E2E_DISABLE_GPU=1 node tools/real-film-e2e.mjs   # 复现"没显卡也能用"
 *   YJAI_E2E_FORCE_CRASH=1 node tools/real-film-e2e.mjs   # 自证：异常路径必须报 FAILED
 */
import { _electron as electron } from 'playwright-core'
import { spawnCapture } from './spawn-capture.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/* --------------------------- 断言框架（总数恒定） --------------------------- */

const checks = []
const skippedNames = []
let failures = 0
let skips = 0

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`)
}

function skip(name, why) {
  skips += 1
  skippedNames.push(name)
  console.log(`  [SKIP] ${name}  — ${why}`)
}

function skipAll(names, why) {
  for (const name of names) skip(name, why)
}

/* ------------------------------ 片源与 ffprobe ------------------------------ */

/**
 * 候选真实影片。都是本机上真实拍/剪出来的片子，不是合成的。
 * 第一个刻意选 h264 + 含 B 帧 + 1080p 横屏：最"正常"的一种真实影片，主要断言跑在它上面。
 */
const FILM_CANDIDATES = [
  process.env.YJAI_REAL_FILM,
  'E:\\所有商家物料\\MOK KTV\\001\\微信视频2026-05-13_211027_785.mp4',
  'F:\\BaiduNetdiskDownload\\视频\\6月20日 (1).mp4',
  'E:\\所有商家物料\\papaya\\抖音\\王雨乐.mp4'
].filter(Boolean)

function findFilm() {
  for (const candidate of FILM_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && stat.size > 1024) return { path: candidate, size: stat.size }
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/**
 * ffprobe 只用来当**地面真值**，不是被测对象；找不到就只跳过"与真值一致"那一组
 *
 * ⚠️ 与 media-import-e2e 同一个坑：spawnSync 走管道在本机 EBUSY，这个函数以前恒返回 ''，
 *    "与真值一致"那组断言一直在 SKIP。改用 spawnCapture（输出重定向到文件）才真跑得起来。
 * ⚠️ 候选里补 'ffprobe.exe'：Windows 上没有扩展名的裸名解析不到 PATH 上的可执行文件。
 */
function findFfprobe() {
  const candidates = [
    process.env.FFPROBE_PATH,
    path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffprobe.exe'),
    'ffprobe.exe',
    'ffprobe'
  ].filter(Boolean)
  for (const candidate of candidates) {
    const result = spawnCapture(candidate, ['-hide_banner', '-version'], { tag: 'ver' })
    if (result.status === 0) return candidate
  }
  return ''
}

function ffprobeJson(bin, filmPath) {
  const result = spawnCapture(
    bin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filmPath],
    { tag: 'probe' }
  )
  if (result.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

/* ----------------------------- 断言清单与总数 ----------------------------- */

const TRUTH_CHECKS = [
  '时长与 ffprobe 一致（±0.5s）',
  '分辨率与 ffprobe 一致',
  '音轨经协议读出时长且与 ffprobe 一致（±0.5s）'
]
const PIXEL_CHECKS = [
  '开头附近解出的是真实画面（不是纯色底）',
  'seek 到片长 60% 处画面与开头不同'
]
/** 全部可跑时的断言总数。SKIP 不改变它，闸门靠这个数抓"断言被删"。 */
// A(3) + B(4) + C(真值 3) + D(4) + E(6) + F(10) + G(6)
// G 是 2026-09-22 新增的"轨道可视化与点击定位"：抽帧 2 条（≥2 张真解码的帧 +
// 帧内容互不相同）+ 波形 2 条（画布存在 + 画布上确有柱状像素）+
// 单击片段定位播放头 1 条 + 拖动片段不甩播放头 1 条。
// 加组时总数必须同步改，否则 verify 只会报"断言数不符"，
// 把"这组还没跑"盖成"输出格式坏了"。
const TOTAL = 3 + 4 + TRUTH_CHECKS.length + 4 + 6 + 10 + 6

const film = findFilm()
const ffprobe = findFfprobe()

console.log('真实影片 E2E')
console.log('  影片：   ' + (film ? `${film.path}  (${(film.size / 1024 / 1024).toFixed(1)} MB)` : '(未找到)'))
console.log('  ffprobe：' + (ffprobe || '(未找到)'))

if (!film) {
  console.log(`\n本机找不到候选真实影片：整组 SKIP（断言清单 ${TOTAL} 项）。`)
  console.log(`\nREAL_FILM_STATS total=${TOTAL} pass=0 fail=0 skip=${TOTAL}`)
  console.log('REAL_FILM_SKIPPED')
  // 与文末收尾同理：向管道写是异步的，直接 exit 可能把 REAL_FILM_SKIPPED 丢掉，
  // 而 verify.mjs 的 marker 就认这个串 —— 丢了就是"未出现通过标记"的假红。
  process.stdout.write('', () => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

let truth = null
if (ffprobe) {
  const json = ffprobeJson(ffprobe, film.path)
  if (json) {
    const video = (json.streams || []).find((s) => s.codec_type === 'video')
    const audio = (json.streams || []).find((s) => s.codec_type === 'audio')
    truth = {
      duration: Number(json.format?.duration) || Number(video?.duration) || 0,
      width: Number(video?.width) || 0,
      height: Number(video?.height) || 0,
      videoCodec: video?.codec_name || '',
      pixFmt: video?.pix_fmt || '',
      hasBFrames: Number(video?.has_b_frames) > 0,
      audioDuration: Number(audio?.duration) || 0,
      audioChannels: Number(audio?.channels) || 0
    }
    console.log(
      `  真值：   ${truth.width}×${truth.height} ${truth.videoCodec}/${truth.pixFmt} ` +
      `${truth.duration.toFixed(3)}s B帧=${truth.hasBFrames ? 'Y' : 'n'} ` +
      `音频 ${truth.audioDuration.toFixed(3)}s ${truth.audioChannels}ch`
    )
  }
}
if (!truth) console.log('  （读不到地面真值，"与 ffprobe 一致" 那组记 SKIP）')

/* --------------------------------- 启动 --------------------------------- */

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
delete env.YJAI_USE_DEV_SERVER

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-real-film-'))
const pageErrors = []
let app = null
let exitCode = 1
let tainted = false

try {
  /* 自证钩子（`YJAI_E2E_FORCE_CRASH=1`）：证明"中途抛异常"时收尾**不会**谎报通过。
   * 刻意放在 launch 之前 —— 自证"异常路径"不需要真起 Electron，秒级跑完，
   * 所以它才有可能被随手执行，而不是躺在文档里没人验。
   * 期望：异常栈 + `REAL_FILM_STATS total=30 pass=0 fail=30 skip=0` + `REAL_FILM_FAILED` + 退出码 1。 */
  if (process.env.YJAI_E2E_FORCE_CRASH === '1') throw new Error('自证：强制中断（YJAI_E2E_FORCE_CRASH=1）')

  app = await electron.launch({
    executablePath: EXE,
    args: [
      MAIN,
      `--user-data-dir=${profileDir}`,
      '--no-sandbox',
      // ⚠️ 这里**故意不禁 GPU**：真实影片要真解码。--disable-gpu 会退回软解，
      // 1080p30 的片子可能解不出来 —— 那失败的是测试环境而不是应用。
      // 需要复现"没显卡也能用"时再设 YJAI_E2E_DISABLE_GPU=1。
      ...(process.env.YJAI_E2E_DISABLE_GPU === '1' ? ['--disable-gpu'] : []),
      '--disable-dev-shm-usage'
    ],
    cwd: ROOT,
    env
  })

  const page = await app.firstWindow()
  page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
  await page.waitForSelector('.app', { timeout: 30000 })
  await page.waitForTimeout(1200)

  // 客户端默认落在「创作中心」，媒体库在剪辑工作台里。有入口就点，没有就当已在工作台。
  const heroEntry = await page.$('.home-hero-video')
  if (heroEntry) {
    await heroEntry.click()
    await page.waitForTimeout(1400)
  }

  /* ----------------------- 组 A：真实影片登记 ----------------------- */

  console.log('\n[组 A] 导入登记')

  const rows = await page.evaluate((p) => window.yjai.media.stat([p]), film.path)
  const asset = Array.isArray(rows) ? rows[0] : null
  check('真实影片登记为视频素材', Boolean(asset) && asset.kind === 'video',
    asset ? `name=${asset.name} kind=${asset.kind}` : '返回空')
  check('素材 URL 走自定义协议且不含明文路径',
    Boolean(asset) && String(asset.url).startsWith('yjai-media://local/') && !/[\s\u4e00-\u9fa5]/.test(String(asset.url)),
    asset ? String(asset.url).slice(0, 42) + '…' : '')
  check('素材体积与磁盘一致', Boolean(asset) && asset.size === film.size,
    asset ? `${asset.size} vs ${film.size}` : '')
  if (!asset) throw new Error('影片没能登记：后面所有断言都依赖它，中止')

  /* -------------------- 组 B：浏览器真解码（元数据） -------------------- */

  console.log('\n[组 B] 浏览器真解码（元数据）')

  const midAt = truth ? truth.duration * 0.6 : 30
  // 取"开头附近"而不是死钉 1.0s：真实影片常有从黑场淡入的开头，
  // 钉死 1s 会把"源片本身就是这样"误判成"取帧画到黑帧"。
  const headAt = truth ? Math.max(1, truth.duration * 0.05) : 1

  const decode = await page.evaluate(
    async ({ url, midSeconds, headSeconds }) => {
      const out = {
        loaded: false, readyState: 0, duration: 0, w: 0, h: 0, seekableEnd: 0,
        errorCode: 0, frames: {}, presented: 0, hasFrameCallback: false
      }
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      /**
       * ⚠️ 必须带 `crossOrigin="anonymous"`，否则 组 D 的像素断言永远只能 SKIP。
       *
       * 这是"读视频像素"的**契约**：画布污不污染看的不是响应头，而是
       * 元素是不是以 CORS 方式取回的。带了这个属性 + 主进程把 yjai-media
       * 声明成 `corsEnabled`（两处缺一不可），drawImage 之后才允许 getImageData。
       * 不带就是 no-cors 取回 → 必然污染 → 组 D 恒 SKIP。
       */
      video.crossOrigin = 'anonymous'
      video.src = url
      // 刻意**留在视口内**（2×2 像素、不吃指针事件）：
      // 放到 left:-10000px 这类视口外位置，Chromium 会大幅节流甚至不呈现视频帧，
      // 结果就是 requestVideoFrameCallback 几乎不触发、"已呈现帧数"恒定不动 ——
      // 那是测试自己造出来的假红。
      video.style.cssText =
        'position:fixed;left:0;top:0;width:2px;height:2px;pointer-events:none;z-index:2147483647'
      document.body.appendChild(video)

      const waitMeta = () =>
        new Promise((resolve) => {
          if (video.readyState >= 1) return resolve(true)
          const timer = setTimeout(() => resolve(false), 30000)
          video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(true) }, { once: true })
          video.addEventListener('error', () => { clearTimeout(timer); resolve(false) }, { once: true })
        })

      out.loaded = await waitMeta()
      out.errorCode = video.error ? video.error.code : 0
      if (!out.loaded) { video.remove(); return out }

      out.readyState = video.readyState
      out.duration = Number.isFinite(video.duration) ? video.duration : 0
      out.w = video.videoWidth
      out.h = video.videoHeight
      // seekable 覆盖到片尾，才说明协议 + 容器索引支持拖到任意位置
      out.seekableEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0

      const seekTo = (seconds) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 30000)
          video.addEventListener('seeked', () => { clearTimeout(timer); resolve(true) }, { once: true })
          video.currentTime = seconds
        })

      /**
       * 等**一帧真的被呈现出来**。
       *
       * 这一步不能省：`seeked` 只说明"定位完成了"，此时画面的合成还没跟上。
       * 立刻 drawImage 会画到一片黑（实测首次跑就是这样：t=1s 的均值与方差都是 0，
       * 而 ffmpeg 解出来的同一帧均值 84.1、方差 2009.2 —— 源片根本不是黑帧）。
       * requestVideoFrameCallback 的回调语义才是"这一帧呈现了"；没有这个 API 时
       * 退化成两帧 rAF。
       */
      const nextPresentedFrame = (timeoutMs = 4000) =>
        new Promise((resolve) => {
          if (typeof video.requestVideoFrameCallback !== 'function') {
            return requestAnimationFrame(() => requestAnimationFrame(() => resolve(false)))
          }
          let settled = false
          const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false) } }, timeoutMs)
          video.requestVideoFrameCallback(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(true) } })
          return undefined
        })

      /** 取一帧的亮度统计与稀疏指纹；画布被污染时如实上报，不伪装成通过 */
      const grabFrame = async (seconds) => {
        const seeked = await seekTo(seconds)
        if (!seeked) return { ok: false, why: 'seek 超时' }
        // 关键：等呈现，再画。少了这一步会稳定地画到黑帧
        const presented = await nextPresentedFrame()
        if (video.readyState < 2) return { ok: false, why: `等待呈现后仍无可解码数据（readyState=${video.readyState}）` }
        const canvas = document.createElement('canvas')
        canvas.width = 160
        canvas.height = 90
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        } catch (error) {
          return { ok: false, why: 'drawImage 失败：' + error.message }
        }
        let data
        try {
          data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        } catch (error) {
          return { ok: true, tainted: true, at: video.currentTime, why: error.name }
        }
        const pixels = data.length / 4
        let sum = 0
        let sumSq = 0
        for (let i = 0; i < data.length; i += 4) {
          const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          sum += luma
          sumSq += luma * luma
        }
        // 96 个稀疏采样的亮度（/16 量化）拼成指纹，用来判"两帧是不是同一画面"
        const fingerprint = []
        for (let i = 0; i < 96; i++) {
          const index = Math.floor((i * 7919) % pixels) * 4
          fingerprint.push(Math.round((0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) / 16))
        }
        const mean = sum / pixels
        return {
          ok: true, tainted: false, at: video.currentTime, presented,
          mean, variance: sumSq / pixels - mean * mean, fingerprint
        }
      }

      out.frames.head = await grabFrame(headSeconds)
      out.frames.mid = await grabFrame(midSeconds)

      // 独立于画布的"真的在解码"证据：requestVideoFrameCallback 报的是**已呈现的帧数**，
      // 画布被污染也照样有效。坏容器/只有索引没有数据的文件上这个数不会涨。
      //
      // ⚠️ 这个回调是**一次性**的：注册一次只回调一次。要连续计数就必须在回调里再注册。
      // 第一版只注册了两次，于是读到的永远是"开头第 2 帧"的计数（实测恒为 3），
      // 看起来像"解码不动"，其实是测试自己把计数冻住了。
      out.hasFrameCallback = typeof video.requestVideoFrameCallback === 'function'
      if (out.hasFrameCallback) {
        let first = -1
        let count = 0
        const tick = (_now, meta) => {
          if (first < 0) first = meta.presentedFrames
          count = meta.presentedFrames - first + 1
          video.requestVideoFrameCallback(tick)
        }
        video.requestVideoFrameCallback(tick)
        try { await video.play() } catch { /* 自动播放被拦，按计数判定 */ }
        await new Promise((resolve) => setTimeout(resolve, 1600))
        video.pause()
        out.presented = count
      }

      video.removeAttribute('src')
      video.load()
      video.remove()
      return out
    },
    { url: asset.url, midSeconds: midAt, headSeconds: headAt }
  )

  check('video 元素拿到元数据（readyState ≥ 1）', decode.loaded && decode.readyState >= 1,
    decode.loaded ? `readyState=${decode.readyState}` : `失败，error.code=${decode.errorCode}`)
  check('解出画面尺寸（非 0×0）', decode.w > 0 && decode.h > 0, `${decode.w}×${decode.h}`)
  check('解出时长（有限且 > 1s）', Number.isFinite(decode.duration) && decode.duration > 1,
    `${decode.duration.toFixed(3)}s`)
  check('seekable 覆盖整片（不是只前几秒）',
    decode.duration > 0 && decode.seekableEnd >= decode.duration - 1,
    `seekable 到 ${decode.seekableEnd.toFixed(3)}s / 片长 ${decode.duration.toFixed(3)}s`)

  /* ------------------ 组 C：与 ffprobe 地面真值一致 ------------------ */

  console.log('\n[组 C] 与 ffprobe 地面真值一致')

  if (!truth) {
    skipAll(TRUTH_CHECKS, '本机没有可用的 ffprobe，拿不到地面真值')
  } else {
    check('时长与 ffprobe 一致（±0.5s）',
      Math.abs(decode.duration - truth.duration) <= 0.5,
      `应用 ${decode.duration.toFixed(3)}s vs ffprobe ${truth.duration.toFixed(3)}s`)
    check('分辨率与 ffprobe 一致',
      decode.w === truth.width && decode.h === truth.height,
      `应用 ${decode.w}×${decode.h} vs ffprobe ${truth.width}×${truth.height}`)

    // 音轨单独用 <audio> 读：验证"只有画面能播、音轨读不出来"这种半坏状态
    const audioMeta = await page.evaluate((url) => new Promise((resolve) => {
      const el = document.createElement('audio')
      el.preload = 'metadata'
      const done = (payload) => { el.removeAttribute('src'); el.load(); resolve(payload) }
      const timer = setTimeout(() => done({ ok: false, why: '超时' }), 20000)
      el.addEventListener('loadedmetadata', () => {
        clearTimeout(timer)
        done({ ok: true, duration: Number.isFinite(el.duration) ? el.duration : 0 })
      }, { once: true })
      el.addEventListener('error', () => { clearTimeout(timer); done({ ok: false, why: 'error' }) }, { once: true })
      el.src = url
    }), asset.url)

    check('音轨经协议读出时长且与 ffprobe 一致（±0.5s）',
      audioMeta.ok && Math.abs(audioMeta.duration - truth.audioDuration) <= 0.5,
      audioMeta.ok
        ? `应用 ${audioMeta.duration.toFixed(3)}s vs ffprobe ${truth.audioDuration.toFixed(3)}s`
        : `读不到音轨（${audioMeta.why}）`)
  }

  /* ------------------ 组 D：真解码取帧（像素级） ------------------ */

  console.log('\n[组 D] 真解码取帧')

  const head = decode.frames.head || { ok: false }
  const mid = decode.frames.mid || { ok: false }
  tainted = Boolean(head.tainted || mid.tainted)

  if (!head.ok || !mid.ok) {
    skipAll(PIXEL_CHECKS, `取帧失败：${head.why || mid.why || '未知'}`)
  } else if (tainted) {
    // 画布污染是**协议未声明 CORS 语义**导致的能力缺口，不是影片的问题。
    // 如实记 SKIP 并在文末给结论，不伪装成通过，也别让它变成 FAIL 误导人。
    skipAll(PIXEL_CHECKS, 'yjai-media:// 取自 <video> 后画布被污染，像素读不出来（见文末提示）')
  } else {
    // 纯色底（黑屏/绿屏）的特征：方差接近 0；真实画面哪怕很暗也有噪声与纹理。
    // 独立判据见 _recon/frame-stats.mjs：本片 t=1s 用 ffmpeg 解出来是 均值 84.1 / 方差 2009.2。
    check('开头附近解出的是真实画面（不是纯色底）', head.variance > 4,
      `t=${head.at.toFixed(2)}s｜亮度均值 ${head.mean.toFixed(1)} 方差 ${head.variance.toFixed(1)}`)
    let diff = 0
    for (let i = 0; i < head.fingerprint.length; i++) {
      if (head.fingerprint[i] !== mid.fingerprint[i]) diff += 1
    }
    // 用比例而不是绝对数：指纹长度以后调整时阈值不会跟着失准
    check('seek 到片长 60% 处画面与开头不同', diff >= head.fingerprint.length * 0.1,
      `${diff}/${head.fingerprint.length} 个采样点不同（t=${mid.at.toFixed(2)}s）`)
  }

  check('seek 后 currentTime 落位准确（±0.5s）',
    mid.ok && Math.abs(mid.at - midAt) <= 0.5,
    mid.ok ? `要求 ${midAt.toFixed(3)}s 实际 ${mid.at.toFixed(3)}s` : '没有取到帧')
  // 真正"解出了画面"的硬证据。有 B 帧的真实影片尤其需要它：seek 到非关键帧要回退解码，
  // 这一步失败时元数据一切正常、currentTime 也会动，只有已呈现帧数暴露真相。
  check('播放时真的有帧被呈现（presentedFrames 递增）',
    decode.hasFrameCallback && decode.presented > 3,
    decode.hasFrameCallback ? `presentedFrames=${decode.presented}` : '该 Electron 没有 requestVideoFrameCallback')

  /* --------------- 组 E：协议对真实大文件的 Range 逐字节正确 --------------- */

  console.log('\n[组 E] 协议 Range（逐字节比对磁盘）')

  const readSlice = (start, length) => {
    const fd = fs.openSync(film.path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const read = fs.readSync(fd, buffer, 0, length, start)
      return buffer.subarray(0, read).toString('hex')
    } finally {
      fs.closeSync(fd)
    }
  }
  const midOffset = Math.floor(film.size / 2)
  const expected = {
    head: readSlice(0, 1024),
    mid: readSlice(midOffset, 1024),
    tail: readSlice(film.size - 1024, 1024)
  }

  const rangeProbe = await page.evaluate(async ({ url, midOffset }) => {
    const read = async (rangeHeader) => {
      try {
        const response = await fetch(url, rangeHeader ? { headers: { Range: rangeHeader } } : undefined)
        const bytes = new Uint8Array(await response.arrayBuffer())
        let hex = ''
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
        return {
          status: response.status,
          bytes: bytes.length,
          hex,
          headers: Object.fromEntries(response.headers.entries())
        }
      } catch (error) {
        return { status: 0, bytes: 0, hex: '', headers: {}, error: String(error.message) }
      }
    }
    return {
      zero: await read('bytes=0-0'),
      head: await read('bytes=0-1023'),
      mid: await read(`bytes=${midOffset}-${midOffset + 1023}`),
      tail: await read('bytes=-1024'),
      impossible: await read(`bytes=${midOffset + 99999999}-`)
    }
  }, { url: asset.url, midOffset })

  check('声明 Accept-Ranges（否则长视频不会走 seek）',
    rangeProbe.zero.headers['accept-ranges'] === 'bytes',
    `accept-ranges=${rangeProbe.zero.headers['accept-ranges'] || '-'}`)
  // 不从"无 Range 的整文件响应"读总长 —— 那要把 138MB 整个搬进渲染进程。
  // Content-Range 的尾部就是真实总长，取 1 个字节即得。
  const reportedTotal = Number(String(rangeProbe.zero.headers['content-range'] || '').split('/')[1])
  check('Content-Range 报告的总长等于真实体积',
    reportedTotal === film.size,
    `content-range=${rangeProbe.zero.headers['content-range'] || '-'}（文件 ${film.size}B）`)
  check('bytes=0-1023 与磁盘前 1024 字节逐字节相同',
    rangeProbe.head.status === 206 && rangeProbe.head.hex === expected.head,
    `HTTP ${rangeProbe.head.status} 长度 ${rangeProbe.head.bytes} 一致=${rangeProbe.head.hex === expected.head}`)
  check('中段区间与磁盘对应偏移逐字节相同',
    rangeProbe.mid.status === 206 && rangeProbe.mid.hex === expected.mid,
    `从 ${midOffset} 起 1024B，一致=${rangeProbe.mid.hex === expected.mid}`)
  check('bytes=-1024 与磁盘末 1024 字节逐字节相同',
    rangeProbe.tail.status === 206 && rangeProbe.tail.hex === expected.tail,
    `HTTP ${rangeProbe.tail.status} 长度 ${rangeProbe.tail.bytes} 一致=${rangeProbe.tail.hex === expected.tail}`)
  check('越界 Range → 416',
    rangeProbe.impossible.status === 416,
    `HTTP ${rangeProbe.impossible.status}`)

  /* ------------------ 组 F：编辑栏功能（用真实片长驱动） ------------------ */

  console.log('\n[组 F] 编辑栏功能')

  // 只换掉"选哪个文件"这一个系统对话框；media:pick 之后的每一步都是真代码
  const patched = await app.evaluate((electronModule, filmPath) => {
    const dialog = electronModule && electronModule.dialog
    if (!dialog || typeof dialog.showOpenDialog !== 'function') return false
    // 保留原函数引用，万一需要还原
    dialog.__yjaiOriginalShowOpenDialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filmPath] })
    return true
  }, film.path)
  if (!patched) throw new Error('主进程没拿到 dialog.showOpenDialog，无法打桩导入入口')

  await page.click('[data-import-btn]')
  // 真实影片要走 describeMedia + probeMedia（浏览器真读 moov），给足时间
  await page.waitForTimeout(6000)

  // 失败时只报"没有卡片"是没用的 —— 这条曾经在某个夜里报出过一次，
  // 光看那句话根本分不清是"没导入"、"导入报错"、"中间栏落在别的面板"
  // 还是"筛掉了"。所以把当时页面上的关键状态一并取回来。
  const { card, dom } = await page.evaluate(() => {
    const el = document.querySelector('.media-card')
    const active = document.querySelector('.wb-tree .wb-node.active')
    const mid = document.querySelector('.wb-media')
    return {
      card: el
        ? { name: el.querySelector('strong')?.textContent || '', meta: el.querySelector('small')?.textContent || '' }
        : null,
      dom: {
        激活树节点: active?.getAttribute('data-wb-node') || '(无)',
        卡片数: document.querySelectorAll('.media-card').length,
        中间栏: mid ? mid.className : '(没有中间栏)',
        中间栏文本: String(mid?.textContent || '').replace(/\s+/g, ' ').slice(0, 100),
        应用态: document.querySelector('.app')?.className || '(无)'
      }
    }
  })

  const secondsText = (seconds) => {
    const total = Math.max(0, Number(seconds) || 0)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(Math.floor(total % 60))}`
  }
  // 2026-10-08 起片段头改用帧号时码 HH:MM:SS:FF（ui.jsx 的 timecodeFrames，30 帧/秒），
  // 与逐帧修剪的读数对齐。期望值照旧从 ffprobe 真值推出来，不写死字符串。
  const clipDurText = (seconds) => {
    const total = Math.max(0, Number(seconds) || 0)
    return `${secondsText(total)}:${String(Math.floor((total % 1) * 30)).padStart(2, '0')}`
  }
  // 拿 ffprobe 的真值当期望，避免"用同一个浏览器的解码结果去验证它自己"
  const trueDuration = truth ? truth.duration : decode.duration

  const why = `${JSON.stringify(dom)}${pageErrors.length ? ` ｜ 页面异常：${pageErrors.slice(0, 2).join(' / ')}` : ''}`

  check('导入媒体库后卡片显示真实分辨率',
    Boolean(card) && card.meta.includes(`${decode.w}×${decode.h}`),
    card ? card.meta : `没有卡片 —— ${why}`)
  // 整道闸门最值钱的一条：真实片长 72.9s，绝不是兜底的 00:00:05。
  // 合成片（2s）上"用真实时长"和"用 5s 兜底"会算出两个很接近的数，
  // 只有真实影片能把「片段时长 = 素材真实片长」这条不变式压出来。
  check('卡片显示真实片长（不是 00:00:05 兜底值）',
    Boolean(card) && card.meta.includes(secondsText(trueDuration)),
    card ? `期望含 ${secondsText(trueDuration)}｜实际 ${card.meta}` : `没有卡片 —— ${why}`)

  if (!card) throw new Error(`媒体库里没有素材卡片，编辑栏断言无法继续 —— ${why}`)

  // 加入时间线。
  //
  // ⚠️ 这里不能直接 `page.click('.media-card button[title="加入时间线"]')`：
  // `.media-card .media-actions` 平时是 `display:none`，只有 `.media-card:hover`
  // 才 `display:flex`（刻意的还原行为，和参考客户端一致 —— 操作按钮不占版面）。
  // 而 Playwright 的可见性检查发生在**移动鼠标之前**：元素还不可见 → 它就一直等，
  // hover 永远不会发生 → 互锁超时。所以必须自己先把鼠标挪到卡片上，
  // 再读按钮坐标点下去。
  const cardBox = await page.locator('.media-card').first().boundingBox()
  // ⚠️ 抖动的来源（2026-10-02 实测，全量跑时红、隔离复跑同一份产物稳定 36/36）：
  //   Electron + Playwright 下**第一次** mouse.move 常常不产生 CSS :hover ——
  //   窗口刚就绪、或目标坐标与鼠标当前位置相同 ⇒ 合成事件被吃掉，:hover 不生效。
  //   于是下面读到 display:none，而按钮拿不到坐标又会抛异常，
  //   真正失败的 1 条把后面 13 条一起拖成失败（报告显示「14 条失败」，极度失真）。
  //   兜底办法是**再微移一格**：换一个坐标才会真的派发一次 mousemove。
  //   ⚠️ 判据本身一点没放宽 —— 仍然必须是 hover 之后 display 变成 flex。
  //
  // ⚠️ 2026-10-08 又红一次（本机实测）：只做「移入 + 微移一格」仍不够。
  //   鼠标**本来就已经在卡片上**时（上一步刚点过卡片），两次 move 的坐标差
  //   不足以让 Chromium 认为发生了 hover 迁移 ⇒ :hover 仍未生效。
  //   所以每次尝试都先**移出卡片**（卡片上方 40px，落在媒体库标题区），
  //   再移回卡片中心 —— 保证是一次真实的 enter。
  //   ⚠️ 判据一点没放宽：仍然是「hover 之后 display 必须变成 flex」，
  //   只是把"让 hover 真的发生"这件事做得可靠，重试上限内不成才算失败。
  const readActionsDisplay = () =>
    page.evaluate(() => {
      const el = document.querySelector('.media-card .media-actions')
      return el ? getComputedStyle(el).display : 'missing'
    })
  let actionsVisible = 'missing'
  for (let attempt = 0; attempt < 6 && actionsVisible !== 'flex'; attempt += 1) {
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y - 40)
    await page.waitForTimeout(120)
    await page.mouse.move(cardBox.x + cardBox.width / 2 + (attempt % 2 ? 2 : 0), cardBox.y + cardBox.height / 2 + (attempt % 2 ? 2 : 0))
    await page.waitForTimeout(240)
    actionsVisible = await readActionsDisplay()
  }
  // 这条既证明"悬停才露出"这条交互真的生效，也是下面能点到按钮的前提
  check('悬停媒体卡才露出操作按钮（平时不占位）', actionsVisible === 'flex',
    `.media-actions display=${actionsVisible}`)

  const addBtnBox = await page.locator('.media-card button[title="加入时间线"]').first().boundingBox()
  // 拿不到坐标时**先说清原因再抛**：直接抛会让后面 13 条全记成失败，
  // 报告看着像"编辑栏整个坏了"，其实只是这一下悬停没生效。
  if (!addBtnBox) throw new Error('悬停后仍拿不到「加入时间线」按钮坐标 —— 编辑栏断言无法继续')
  await page.mouse.click(addBtnBox.x + addBtnBox.width / 2, addBtnBox.y + addBtnBox.height / 2)
  await page.waitForTimeout(900)

  const clip0 = await page.evaluate(() => {
    const el = document.querySelector('.wb-tllane[data-lane="video"] .clip')
    if (!el) return null
    return {
      durText: el.querySelector('.clip-dur')?.textContent || '',
      width: el.getBoundingClientRect().width
    }
  })

  check('加入时间线后片段时长等于真实片长',
    Boolean(clip0) && clip0.durText === clipDurText(trueDuration),
    clip0 ? `${clip0.durText}（期望 ${clipDurText(trueDuration)}）` : '时间线上没有片段')

  /* -- 播放头真的在推进 -- */

  const readSourceTime = () =>
    page.evaluate(() => Number(document.querySelector('.wb-player')?.dataset.sourceTime || 0))
  const beforePlay = await readSourceTime()
  await page.click('.wb-transport-btns button.play')
  await page.waitForTimeout(1500)
  const duringPlay = await readSourceTime()
  await page.click('.wb-transport-btns button.play')
  await page.waitForTimeout(300)
  check('播放头真的在推进（播放不是空转）', duringPlay > beforePlay + 0.3,
    `${beforePlay.toFixed(3)}s → ${duringPlay.toFixed(3)}s`)

  /* -- 在播放头处分割 -- */

  /**
   * 每秒占多少像素（dps）。**必须先正确解析时间码**，这是第一版踩的坑：
   * tick 的文本是 `HH:MM:SS`，旧写法 `textContent.split(':').pop()` 取的是**秒位**，
   * 于是 `00:01:20`（80 秒）被读成 20 秒，dps 直接放大 4 倍。
   * 后果不是"报错"，而是**静默算错位置**：播放头被送到 82.93s（片尾，已在片段之外），
   * 分割因此失败，报出来的却是"分割没生效"—— 看起来像应用缺陷，其实是量错了尺子。
   *
   * 用**相邻两个 tick 的差**反推而不是单个 tick 的比值：差值天然消掉
   * "文本秒位 vs 真实秒数"的歧义，也不依赖任一 tick 的绝对数值。
   */
  const tickGeom = await page.evaluate(() => {
    const toSeconds = (text) => {
      const parts = String(text).trim().split(':').map((n) => Number(n) || 0)
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
      if (parts.length === 2) return parts[0] * 60 + parts[1]
      return parts[0] || 0
    }
    const ticks = Array.from(document.querySelectorAll('.wb-tlruler .tick')).map((el) => ({
      seconds: toSeconds(el.textContent),
      left: parseFloat(el.style.left)
    }))
    let dps = 0
    for (let i = ticks.length - 1; i >= 1; i--) {
      const deltaSeconds = ticks[i].seconds - ticks[i - 1].seconds
      const deltaPx = ticks[i].left - ticks[i - 1].left
      if (deltaSeconds > 0 && deltaPx > 0) { dps = deltaPx / deltaSeconds; break }
    }
    return { dps, tickCount: ticks.length }
  })
  if (!tickGeom.dps) throw new Error('读不到时间线刻度：无法把秒数换算成像素')

  /**
   * 把播放头定位到 `target` 秒。
   *
   * 刻意不点片段本身：片段自己的 pointerdown 会把事件吃掉（只做选中），
   * 点在上面播放头不会动，后面的分割就会因为"播放头不在片段内"而失败。
   * 所以点**刻度尺** —— 它在 .wb-tltracks 里、在所有轨道之上，且自身没有 handler。
   *
   * 也不靠"猜鼠标坐标"：按 `dps` 算出目标像素位置，按需横向滚动让它落进可视区，
   * 再用换算出的 clientX 派发 pointerdown —— seekFromEvent 反解回去必然得到同一个秒数，
   * 不受缩放/滚动影响。
   */
  const seekToSeconds = (target) =>
    page.evaluate(({ seconds, dps }) => {
      const lane = document.querySelector('.wb-tltracks')
      const laneRect = lane.getBoundingClientRect()
      const wantX = seconds * dps
      if (wantX < lane.scrollLeft + 40 || wantX > lane.scrollLeft + laneRect.width - 80) {
        lane.scrollLeft = Math.max(0, wantX - laneRect.width / 2)
      }
      const rulerRect = document.querySelector('.wb-tlruler').getBoundingClientRect()
      const clientX = laneRect.left + (wantX - lane.scrollLeft)
      const clientY = rulerRect.top + Math.min(8, rulerRect.height / 2)
      document.querySelector('.wb-tlruler').dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX, clientY,
          button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true
        })
      )
      return { clientX, clientY, scrollLeft: lane.scrollLeft }
    }, { seconds: target, dps: tickGeom.dps })

  const readPlayhead = () =>
    page.evaluate((dps) => {
      const el = document.querySelector('.playhead')
      return el ? parseFloat(el.style.left) / dps : -1
    }, tickGeom.dps)

  const CUT_FRACTION = 0.4
  const cutAt = trueDuration * CUT_FRACTION
  await seekToSeconds(cutAt)
  await page.waitForTimeout(400)
  const playheadNow = await readPlayhead()

  await page.click('button[title^="在播放头处分割"]')
  await page.waitForTimeout(800)

  const afterSplit = await page.evaluate(() => {
    const clips = Array.from(document.querySelectorAll('.wb-tllane[data-lane="video"] .clip'))
    return clips.map((el) => ({
      durText: el.querySelector('.clip-dur')?.textContent || '',
      left: el.getBoundingClientRect().left,
      width: el.getBoundingClientRect().width
    }))
  })

  const totalBefore = clip0 ? clip0.width : 0
  const totalAfter = afterSplit.reduce((sum, c) => sum + c.width, 0)
  check('在播放头处分割成两段且总时长不变',
    afterSplit.length === 2 && Math.abs(totalAfter - totalBefore) <= 3 && Math.abs(playheadNow - cutAt) < 0.5,
    `${afterSplit.length} 段｜宽度 ${totalBefore.toFixed(0)} → ${totalAfter.toFixed(0)}｜播放头 ${playheadNow.toFixed(2)}s`)

  /* -- 右段入点等于切点：把播放头放到切点之后，源时间应≈时间线时间，而不是从头开始 -- */

  const right = afterSplit[1]
  let rightSource = -1
  let expectedSource = -1
  if (right) {
    await seekToSeconds(cutAt + (trueDuration - cutAt) * 0.25)
    await page.waitForTimeout(500)
    rightSource = await readSourceTime()
    // 播放头在右段内 25% 处 ⇒ 时间线 ≈ cutAt + 0.25×(片长−cutAt)；
    // 右段 offset 应等于 cutAt，所以源时间也等于这个数。
    // 若入点丢失（offset 仍为 0），源时间会退到 0.25×(片长−cutAt) ≈ 11s，一眼可辨。
    expectedSource = cutAt + (trueDuration - cutAt) * 0.25
  }
  check('右段入点等于切点（分割后不从头重播）',
    rightSource >= 0 && Math.abs(rightSource - expectedSource) <= 1.2,
    rightSource < 0
      ? '没有右段'
      : `源时间 ${rightSource.toFixed(3)}s｜入点若丢失会退到 ${((trueDuration - cutAt) * 0.25).toFixed(3)}s｜期望约 ${expectedSource.toFixed(3)}s`)

  /* -- 修剪左端：起点右移与时长缩短必须严格互补 -- */

  // 先把轨道区滚回最左：左段起点在 0，滚到别处时它的修剪手柄会跑到可视区外，
  // page.mouse 不做自动滚动，点不到就会静默失败。
  /* ⚠️ 别叫 clipBox：文件后面（组 G）已经有一个同名的 */
  const readClipBox = () =>
    page.evaluate(() => {
      const el = document.querySelector('.wb-tllane[data-lane="video"] .clip')
      const box = el.getBoundingClientRect()
      return { left: box.left, width: box.width }
    })

  /* ⚠️ 原来只拖一次 + 固定等 300ms：手柄盒子是在布局**可能还没落定**时量出来的，
     量偏一点就按在片段本体上而不是手柄上 —— 结果是"起点右移 0.0px"，
     报出来像修剪功能坏了，实际是这一下没按中。
     ⇒ 每次都重新量手柄再拖，最多 3 次；三次都 0px 才判失败
     （真坏了的话三次都是 0px，不会被重试掩盖）。 */
  let movedRight = 0
  let shrunk = 0
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.evaluate(() => { document.querySelector('.wb-tltracks').scrollLeft = 0 })
    await page.waitForTimeout(400)

    const beforeTrim = await readClipBox()
    const handleBox = await page
      .locator('.wb-tllane[data-lane="video"] .clip .clip-trim.start')
      .first()
      .boundingBox()
    if (!handleBox) {
      console.log(`    · 第 ${attempt} 次：左端修剪手柄量不到，重试`)
      continue
    }
    const trimPx = Math.min(60, beforeTrim.width * 0.2)
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox.x + handleBox.width / 2 + trimPx, handleBox.y + handleBox.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(500)

    const afterTrim = await readClipBox()
    movedRight = afterTrim.left - beforeTrim.left
    shrunk = beforeTrim.width - afterTrim.width
    if (movedRight > 4) break
    console.log(`    · 第 ${attempt} 次修剪没生效（右移 ${movedRight.toFixed(1)}px），重试`)
  }
  check('修剪左端时起点右移与时长缩短互补（源坐标对齐）',
    movedRight > 4 && Math.abs(movedRight - shrunk) <= 2,
    `起点右移 ${movedRight.toFixed(1)}px，时长缩短 ${shrunk.toFixed(1)}px（两者应相等）`)

  /* -- 清空 + 撤销 -- */

  const countClips = () =>
    page.evaluate(() => document.querySelectorAll('.wb-tllane[data-lane="video"] .clip').length)
  const beforeDelete = await countClips()
  await page.click('.wb-tlbar button[title^="清空时间线"]')
  await page.waitForTimeout(600)
  const afterClear = await countClips()
  await page.click('.wb-tlbar button[title^="撤销"]')
  await page.waitForTimeout(600)
  const afterUndo = await countClips()
  check('清空后撤销能恢复片段',
    beforeDelete > 0 && afterClear === 0 && afterUndo === beforeDelete,
    `${beforeDelete} → 清空 ${afterClear} → 撤销 ${afterUndo}`)

  /* ------------------ 组 G：轨道可视化（抽帧 / 波形）与点击定位 ------------------ */

  console.log('\n[组 G] 轨道可视化与点击定位')

  /**
   * 视频轨要贴一排**真的抽出来的帧**。
   *
   * 这条断言治的是"显示了但显示的不是内容"：抽帧失败时组件静默退回"只有底色"，
   * 页面照样无异常、构建照样绿。所以这里同时钉两件事 ——
   *   · 帧图确实解码出来了（naturalWidth > 0，不是 data: 空图）；
   *   · 相邻帧的画面**不一样**（同一张图重复 N 遍也能满足"数量对"，
   *     但那根本不是抽帧，只是把一帧铺满）。
   * 跨源画布污染是这条最可能的失败原因，所以失败时把提示写进 detail。
   */
  /* 同样**等条件**而不是固定等：抽帧要走 ffmpeg/解码，慢机器上 3s 不够，
     报出来却是"一张都没有"，真因（还没画完）一个字都不剩。上限 30s。 */
  const readStrip = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.wb-tllane[data-lane="video"] .clip .clip-strip img')).map((el) => ({
        natural: el.naturalWidth,
        src: el.getAttribute('src') || ''
      }))
    )
  let strip = await readStrip()
  const frameDeadline = Date.now() + 30000
  while (Date.now() < frameDeadline && strip.length < 2) {
    await page.waitForTimeout(400)
    strip = await readStrip()
  }
  check('视频轨片段贴出抽帧预览（≥2 张、且都是真解码出来的图）',
    strip.length >= 2 && strip.every((item) => item.natural > 0),
    `${strip.length} 张，解码成功 ${strip.filter((i) => i.natural > 0).length} 张` +
      (strip.length ? '' : '（一张都没有：抽帧失败会静默退回底色，多为画布被跨源污染）'))
  const distinctFrames = new Set(strip.map((item) => item.src)).size
  check('抽帧内容互不相同（不是把同一帧铺满整条片段）',
    strip.length >= 2 && distinctFrames >= 2,
    `${distinctFrames} 种 / ${strip.length} 张`)

  /**
   * 音频轨要画**真波形**。
   *
   * 素材来源：把同一个影片拖到音频轨（片段显式落在 audio 轨，解的是它的音轨）。
   * 走 `page.dragAndDrop` 而不是直接调数据层：MediaPanel 的 dragstart 才会把
   * asset id 写进 DataTransfer，绕过去就成了"测自己构造的数据"。
   *
   * 这条覆盖的是 **mp4 里的音轨**（AAC）这条真实路径；media-import 那边另有一条
   * 自造 wav 的波形断言 —— 两条不是重复：wav 验"链路通不通"，
   * mp4 验"真实容器的音轨取不取得到"（取不到时波形会静默缺失）。
   */
  let audioVisual = { clips: 0, wave: 0, ink: 0, why: '' }
  const probeWave = () =>
    page.evaluate(() => {
      const lane = document.querySelector('.wb-tllane[data-lane="audio"]')
      if (!lane) return { clips: 0, wave: 0, ink: 0, why: '没有音频轨' }
      const canvas = lane.querySelector('.clip .clip-wave')
      const clips = lane.querySelectorAll('.clip').length
      if (!canvas) return { clips, wave: 0, ink: 0, why: '片段上没有波形画布' }
      let ink = 0
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      // 统计非透明像素：画不出来时整块透明，ink 恒为 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) ink += 1
      return { clips, wave: 1, ink, why: '' }
    })
  try {
    await page.dragAndDrop('.media-card', '.wb-tllane[data-lane="audio"]')
    /* ⚠️ 原来是**固定等 3.5s**：波形要把整段源（实测 132MB）fetch 下来再走
       WebAudio 解码，机器忙的时候 3.5s 不够 ⇒ 这条**时绿时红**，而且失败信息是
       "片段上没有波形画布"，看着像功能坏了，实际是没等到。
       改成**等条件**：一直探到画布出现且画布上真有柱子为止（上限 30s），
       探不到才判失败 —— 那时才是真的画不出来。 */
    audioVisual = await probeWave()
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !(audioVisual.wave === 1 && audioVisual.ink > 50)) {
      await page.waitForTimeout(400)
      audioVisual = await probeWave()
    }
  } catch (error) {
    audioVisual = { clips: 0, wave: 0, ink: 0, why: String(error?.message || error).split('\n')[0] }
  }
  check('音频轨片段画出了波形画布', audioVisual.wave === 1,
    audioVisual.why || `音频轨 ${audioVisual.clips} 个片段`)
  check('波形不是空画布（画布上确有柱状像素）', audioVisual.wave === 1 && audioVisual.ink > 50,
    audioVisual.wave ? `非透明像素 ${audioVisual.ink} 个` : '没有波形画布')

  /**
   * 视频片段**底部**那条内嵌音频波形（参考的形制：画面缩略图下面压一条矮波形）。
   *
   * 判据比音频轨那条更硬：除了"画出来了"，还要求**列高不唯一**。
   * 因为"每列一样高"是一条等高直条 —— 拿一份假数据（或全 1 的数组）画也能满足
   * "有像素"，只有"各列高度不同"才证明它喝的是真实 PCM 的起伏。
   *
   * ⚠️ 抽 PCM 走主进程 ffmpeg（不走 decodeAudioData —— 后者对 mp4 这类
   * 容器经常解不出来，解不出来时波形会**静默缺失**：不报错、只是没有）。
   * 所以这里同样**等条件**而不是固定 sleep。
   */
  let inlineVisual = { wave: 0, ink: 0, distinct: 0, why: '' }
  const probeInline = () =>
    page.evaluate(() => {
      const lane = document.querySelector('.wb-tllane[data-lane="video"]')
      if (!lane) return { wave: 0, ink: 0, distinct: 0, why: '没有视频轨' }
      const canvas = lane.querySelector('.clip .clip-wave-inline')
      if (!canvas) return { wave: 0, ink: 0, distinct: 0, why: '视频片段上没有内嵌波形画布' }
      const ctx = canvas.getContext('2d')
      const { width, height } = canvas
      const data = ctx.getImageData(0, 0, width, height).data
      let ink = 0
      // 逐列数非透明像素个数 = 该列柱高；不同柱高的种类数 = distinct
      const heights = new Set()
      for (let x = 0; x < width; x += 1) {
        let h = 0
        for (let y = 0; y < height; y += 1) {
          if (data[(y * width + x) * 4 + 3] > 8) h += 1
        }
        if (h > 0) {
          ink += h
          heights.add(h)
        }
      }
      return { wave: 1, ink, distinct: heights.size, why: '' }
    })
  try {
    inlineVisual = await probeInline()
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !(inlineVisual.wave === 1 && inlineVisual.ink > 50 && inlineVisual.distinct >= 4)) {
      await page.waitForTimeout(400)
      inlineVisual = await probeInline()
    }
  } catch (error) {
    inlineVisual = { wave: 0, ink: 0, distinct: 0, why: String(error?.message || error).split('\n')[0] }
  }
  check('视频片段底部画出了内嵌音频波形（ffmpeg 抽真 PCM）', inlineVisual.wave === 1 && inlineVisual.ink > 50,
    inlineVisual.why || `非透明像素 ${inlineVisual.ink} 个`)
  check('内嵌波形不是等高直条（列高种类 ≥ 4，证明喝的是真 PCM）', inlineVisual.wave === 1 && inlineVisual.distinct >= 4,
    inlineVisual.wave ? `柱高种类 ${inlineVisual.distinct} 种` : '没有内嵌波形画布')

  /**
   * 点击定位：**单击片段**要把播放头挪到点击处。
   * 这是用户口径的"时间线点击移动播放头"——点刻度尺一直是可以的，
   * 只有在片段上点没反应，而那恰恰是最常用的动作。
   *
   * ⚠️ 判据用**像素**，不要拿"点击比例 × 片长"去算期望。
   * 第一版就是这么写的，结果稳定报红：跑到这里时时间线上已经是**两段**
   * （组 F 分割过），第一段的 55% 约 16s，而期望算的是整片 72.9s 的 55% ≈ 40s。
   * 应用行为完全正确，是尺子量错了对象 —— 跟组 F 里"时间码取秒位"是同一类错误。
   * 改成：点哪儿，播放头的像素位置就该在哪儿（与有没有分割、缩放多少都无关）。
   */
  /**
   * ⚠️ 等横向滚动**停稳**再量、再点。
   *
   * 选中片段会触发「滚到能看见」（Timeline 里 `scrollTo({ behavior: 'smooth' })`），
   * 那是动画：上一组（清空 → 撤销）之后它可能还在滑。量坐标时 scrollLeft=0、
   * 真正 pointerup 时已经滑到 55px —— 于是应用按 822px 定位（**它对**），
   * 尺子却拿着 767px 来比，报"差 55px"。这类假红测得越准越像功能坏了。
   * 判据是「点哪儿到哪儿」，前提是"哪儿"在点下去那一刻是确定的 —— 所以先等它停。
   */
  const settleScroll = async () => {
    let prev = Number.NaN
    for (let i = 0; i < 25; i += 1) {
      const cur = await page.evaluate(() => document.querySelector('.wb-tltracks').scrollLeft)
      if (Number.isFinite(prev) && Math.abs(cur - prev) < 0.5) return cur
      prev = cur
      await page.waitForTimeout(80)
    }
    return prev
  }
  /**
   * ⚠️ 光"等它停稳"还不够：**滚动可能在取完坐标之后才启动**。
   *
   * 实测踩过（第二轮）：settleScroll 返回时确实静止，`boundingBox()` 也拿到了 x，
   * 但在 `mouse.click` 落地前的几毫秒里，上一组操作触发的 smooth 滚动开始滑了 55px
   * —— 应用按"滑过之后的 822px"定位（**它是对的**），尺子却拿着 767px 去比。
   * 所以这里再补一道：点完复查 scrollLeft 有没有变，变了就整轮重来（最多 4 次）。
   * 判据「点哪儿到哪儿」只有在"哪儿"于点下去那一刻是确定的时候才有意义。
   */
  let clickHit = null
  let afterHit = -1
  let clickX = 0
  let clickY = 0
  let clipBox = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await settleScroll()
    clipBox = await page.locator('.wb-tllane[data-lane="video"] .clip').first().boundingBox()
    // 点靠下的本体区域：上方 20px 是头栏，两端 7px 是修剪把手（把手会吃掉 pointerdown）
    clickX = clipBox.x + clipBox.width * 0.55
    clickY = clipBox.y + clipBox.height - 6
    clickHit = await page.evaluate(({ x }) => {
      const lane = document.querySelector('.wb-tltracks')
      const laneRect = lane.getBoundingClientRect()
      const head = document.querySelector('.playhead')
      return {
        scroll: lane.scrollLeft,
        wantPx: x - laneRect.left + lane.scrollLeft,
        beforePx: head ? parseFloat(head.style.left) : -1
      }
    }, { x: clickX })
    await page.mouse.click(clickX, clickY)
    await page.waitForTimeout(400)
    const settled = await page.evaluate(() => {
      const lane = document.querySelector('.wb-tltracks')
      const head = document.querySelector('.playhead')
      return { scroll: lane.scrollLeft, playhead: head ? parseFloat(head.style.left) : -1 }
    })
    afterHit = settled.playhead
    if (Math.abs(settled.scroll - clickHit.scroll) < 0.5) break
    /* 滚动在这几毫秒里动了 ⇒ 这一轮的"点哪儿"不可信，重来 */
    await page.waitForTimeout(250)
  }
  const movedPx = Math.abs(afterHit - clickHit.beforePx)
  check('单击片段会把播放头挪到点击处（点哪儿到哪儿，且确实动了）',
    movedPx >= 3 && Math.abs(afterHit - clickHit.wantPx) <= 3,
    `点在第 ${clickHit.wantPx.toFixed(0)}px → 播放头 ${afterHit.toFixed(0)}px（移动 ${movedPx.toFixed(0)}px）`)

  /**
   * 反向：**拖动**片段时播放头不许跟着跑 —— 否则一拖片段播放头就乱跳，
   * 预览区会跟着一起跳。这正是当初把 seek 从 pointerdown 挪走的那个理由，
   * 分组后（单击才 seek）两条意图各自保住，所以两个方向都要钉。
   */
  const dragFrom = { x: clipBox.x + clipBox.width * 0.7, y: clipBox.y + clipBox.height - 6 }
  const playheadBeforeDrag = await readPlayhead()
  await page.mouse.move(dragFrom.x, dragFrom.y)
  await page.mouse.down()
  await page.mouse.move(dragFrom.x + 60, dragFrom.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const playheadAfterDrag = await readPlayhead()
  check('拖动片段时播放头不跟着跑（单击与拖动已分开）',
    Math.abs(playheadAfterDrag - playheadBeforeDrag) <= 1.0,
    `${playheadBeforeDrag.toFixed(2)}s → ${playheadAfterDrag.toFixed(2)}s`)

  check('全程无渲染进程异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0 条')

  /* --------------------------------- 收尾 --------------------------------- */

  console.log(`\n=== 结果：通过 ${checks.length - failures} 项 / 失败 ${failures} 项 / 跳过 ${skips} 项 ===`)
  if (failures) {
    console.log('失败项：')
    for (const c of checks.filter((x) => !x.ok)) {
      console.log(`  - ${c.name}${c.detail ? ' :: ' + c.detail : ''}`)
    }
  }
  if (skippedNames.length) {
    console.log('跳过项（环境能力不足，不是失败）：')
    for (const name of skippedNames) console.log(`  - ${name}`)
  }
  if (tainted) {
    console.log(
      '\n提示：drawImage 后画布被污染 ⇒ 像素级断言退化为 SKIP。\n' +
      '  原因是 yjai-media:// 在 registerSchemesAsPrivileged 里没有声明 corsEnabled，\n' +
      '  虽然响应带了 Access-Control-Allow-Origin，<video> 仍按 no-cors 取，跨源即污染。\n' +
      '  这不影响播放 / 预览 / 导出（都不读像素），但任何"在渲染层读视频像素"的功能\n' +
      '  （缩略图抽帧、滤镜预览、封面图）会直接报 SecurityError —— 要么补该声明，\n' +
      '  要么抽帧走主进程 ffmpeg。'
    )
  }

  console.log(
    `\nREAL_FILM_STATS total=${checks.length + skips} pass=${checks.length - failures} fail=${failures} skip=${skips}`
  )
  exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error('E2E 异常：', error?.stack || error)
  exitCode = 1
  /* 崩在半路也必须给出统计行。
   * verify.mjs 靠这行判「断言数不符」；不打的话它只会报「解析不到断言数」，
   * 那看起来像脚本输出格式坏了，而不是「这次根本没跑完」—— 排查方向会被带偏。
   * 没跑到的断言按**失败**计（用合约总数 TOTAL 收尾），这样"没跑完"永远是红的。 */
  const missed = Math.max(0, TOTAL - checks.length - skips)
  console.log(
    `\nREAL_FILM_STATS total=${TOTAL} pass=${checks.length - failures} fail=${failures + missed} skip=${skips}`
  )
} finally {
  if (app) await Promise.race([app.close(), new Promise((r) => setTimeout(r, 6000))]).catch(() => {})
  fs.rmSync(profileDir, { recursive: true, force: true })
  /* ⚠️ 通过标记必须与退出码同源。
   * 原来这里只看 `failures === 0`，于是"中途抛异常"（一条断言都没记到、
   * failures 仍是 0）也会打印 REAL_FILM_OK，而进程退出码是 1 ——
   * 读日志的第一眼就被这行骗了（实录见 _recon/out-realfilm.txt：异常栈下面紧跟着 REAL_FILM_OK）。 */
  const ok = exitCode === 0 && failures === 0
  console.log(ok ? 'REAL_FILM_OK' : 'REAL_FILM_FAILED')
  /* 必须等 stdout 排空再退：verify.mjs 是用管道抓 stdout 的，向管道写是异步的，
   * 直接 process.exit() 有可能把 STATS 行与通过标记一起丢掉，表现为
   * 「内容全对却报『未出现通过标记』」的假红（draft-e2e.mjs 踩过同一个坑）。 */
  process.stdout.write('', () => process.exit(exitCode))
  setTimeout(() => process.exit(exitCode), 1000).unref()
}
