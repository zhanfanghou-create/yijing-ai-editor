/**
 * 导出封面 · 真源（主进程与渲染层**共用这一份**换算）。
 *
 * 参考客户端的「封面」是导出模块里的一项：把某一帧导成封面图，用来当发布平台的
 * 缩略图。它的语义看似简单（抽一帧），但有三处必须两边一致，否则就是
 * "预览里显示的第 3 秒、成片封面却是第 2.3 秒"这种没人会当场发现的问题：
 *
 *   1. **时间点归属**：面板上写的时间是"成片里的第几秒"，不是时间线绝对秒。
 *      只导出时间区域时两者差一个 `range.start` —— 渲染层必须减掉它，
 *      否则用户选中了 5–8 秒那一段、封面却抽在成片第 8 秒（已经到片尾）。
 *   2. **夹取范围**：`at = duration` 抽不到帧（ffmpeg 输出 0 字节、退出码却是 0），
 *      所以上限是**最后一帧**，不是时长本身。
 *   3. **帧对齐**：30fps 下"第 1.017 秒"不是一个存在的帧。不按帧对齐的话，
 *      面板显示 00:00:01:01、实际抽到 1.033 秒那一帧，用户按帧核对时会以为错了一帧。
 *
 * 这份模块是纯函数 + 一段 ffmpeg 参数拼接，主进程 `require`、渲染层 `import`，
 * 不碰 Electron 也不碰 DOM，所以能被 `tools/cover-selftest.mjs` 直接跑。
 */

/** 默认帧率：与时间码同一档（30fps）。缺 fps 时按它算，别让 NaN 传下去 */
const DEFAULT_FPS = 30
/** 封面图质量（1 最好 / 31 最差）。2 是视觉无损附近，封面就一张图，不值得省这点体积 */
const DEFAULT_QUALITY = 2
/** 封面文件后缀。用 ASCII：中文名在部分 ffmpeg 构建上会因编码问题写不出来 */
const COVER_SUFFIX = '-cover.jpg'

/** 读一个"可能是任何东西"的 cover 参数 —— 面板未改过时它是 undefined */
function readCover(value) {
  const src = value && typeof value === 'object' ? value : {}
  const at = Number(src.at)
  return {
    /* 只有显式 true 才算开：`{ at: 3 }` 这种"选了时间点但没开开关"的中间态不该偷偷导出 */
    enabled: src.enabled === true,
    at: Number.isFinite(at) && at > 0 ? at : 0
  }
}

/** 帧率规范化：0 / 负数 / NaN / 字符串全部退回默认，否则下面全是 NaN */
function readFps(fps) {
  const n = Number(fps)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FPS
}

/**
 * 封面时间点：夹到「0 ~ 最后一帧」并按帧对齐。
 *
 * @param {number} at 期望时间（成片内的秒）
 * @param {number} duration 成片时长（秒）
 * @param {number} fps 帧率
 * @returns {number} 可直接交给 ffmpeg `-ss` 的秒数（保留 3 位小数，够 30/60fps 用）
 */
function coverTimeAt(at, duration, fps) {
  const rate = readFps(fps)
  const total = Number(duration)
  const want = Number(at)
  if (!Number.isFinite(total) || total <= 0) return 0
  /* 最后一帧的起点：抽 at = duration 会得到空文件，而 ffmpeg 退出码仍是 0 */
  const last = Math.max(0, total - 1 / rate)
  const clamped = Math.min(Number.isFinite(want) && want > 0 ? want : 0, last)
  const snapped = Math.round(clamped * rate) / rate
  return Number(Math.min(snapped, last).toFixed(3))
}

/**
 * 封面文件路径：与成片同目录、同基名，后缀换成 `-cover.jpg`。
 * 不生成 `xxx.mp4.jpg` 这种双后缀 —— 上传平台按扩展名认类型，双后缀会被拒。
 */
function coverPathFor(outPath) {
  const src = String(outPath || '').trim()
  if (!src) return ''
  const slash = Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\'))
  const dot = src.lastIndexOf('.')
  const base = dot > slash + 1 ? src.slice(0, dot) : src
  return `${base}${COVER_SUFFIX}`
}

/**
 * 抽帧命令。
 *
 * ⚠️ `-ss` 必须放在 `-i` **之后**。放在前面是"输入侧快速跳转"，ffmpeg 会跳到最近的关键帧，
 *    30fps 素材的关键帧可能间隔好几秒 ⇒ 用户选第 8 秒、封面却是第 5 秒的画面，
 *    而命令退出码是 0、图片也生成得出来，只有人眼对着看才发现。封面就一张图，
 *    慢一点（解码到该帧）完全可以接受。
 */
function buildCoverArgs({ outPath, coverPath, at, quality = DEFAULT_QUALITY }) {
  const sec = Number(Number(at || 0).toFixed(3))
  return [
    '-hide_banner',
    '-y',
    '-loglevel',
    'error',
    '-i',
    String(outPath || ''),
    '-ss',
    String(sec),
    '-frames:v',
    '1',
    '-q:v',
    String(quality),
    String(coverPath || '')
  ]
}

module.exports = {
  DEFAULT_FPS,
  DEFAULT_QUALITY,
  COVER_SUFFIX,
  readCover,
  readFps,
  coverTimeAt,
  coverPathFor,
  buildCoverArgs
}
