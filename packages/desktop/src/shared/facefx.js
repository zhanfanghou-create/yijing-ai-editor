/**
 * 人物特效 —— 预览、导出共用的**唯一一份**几何与参数逻辑。
 *
 * 「跟随人脸」这件事拆开只有三步，三步都必须落在这一份文件里：
 *   ① 检测 → 归一化人脸框序列（track）；
 *   ② 任意时刻取框（`trackAt`，线性插值）；
 *   ③ 把框换成设备坐标（预览给 DOM，导出给 ffmpeg 的 sendcmd）。
 * 任何一步在渲染层与主进程各写一份，就会得到「预览跟着脸、成片不跟」——
 * 而两侧单独看都正常，只有对比成片才发现。
 *
 * 坐标一律**归一化到源画面**（0..1，左上原点）：
 *   · 预览侧乘画布显示尺寸；
 *   · 导出侧乘成片像素尺寸。
 * 存像素的话，换一次分辨率（或导出到 4K）就会整片偏掉。
 */

/**
 * 检测采样帧率。
 *
 * 12 是量出来的折中：1080p 素材每帧要 seek 一次（约 20~40ms），30fps 的 10 秒
 * 片段检测要 10 秒以上；而人脸在 1/12 秒内的位移通常远小于半个脸宽，
 * 中间帧由 `trackAt` 线性插值补，肉眼看不出顿。
 * 往下降（8 以下）在快速转头时会出现"描边慢半拍"，往上加只是线性变慢。
 */
const TRACK_FPS = 12

/**
 * 内置人物特效。
 *
 * 只有三款，是因为**这三款能用同一条链路真做到成片里**（局部 overlay 跟随）。
 * 瘦脸、大眼、换脸这些需要网格变形，ffmpeg 侧没有对应滤镜，
 * 硬做就只能做到预览里 —— 那种"只在预览里成立"的特效不该出现在成品页。
 *
 * `kind` 决定导出侧怎么搭滤镜：
 *   · local —— 局部处理：crop 出脸区 → 处理 → overlay 回原位
 *   · stamp —— 叠加图形：整张图形 overlay 到脸区
 */
const FX_LIST = [
  {
    key: 'blur',
    name: '面部打码',
    hint: '把脸糊掉，跟到人停为止',
    kind: 'local',
    filter: 'boxblur',
    /* 模糊半径按「脸宽的百分比」算，换分辨率不变粗 */
    radiusOf: (faceW, strength) => Math.max(2, Math.round(faceW * (0.04 + 0.1 * strength)))
  },
  {
    key: 'bright',
    name: '面部提亮',
    hint: '只把脸提亮，背景不动',
    kind: 'local',
    filter: 'eq',
    brightnessOf: (strength) => (0.04 + 0.16 * strength).toFixed(3)
  },
  {
    key: 'frame',
    name: '主角描边',
    hint: '脸周围一圈光，跟着人走',
    kind: 'stamp',
    color: '#7c5cff'
  }
]

const FX_KEYS = FX_LIST.map((f) => f.key)
const fxOf = (key) => FX_LIST.find((f) => f.key === key) || null

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 从 478 个关键点算出**脸的框**。
 *
 * 为什么不用关键点包围盒直接当框：那个盒子只到颧骨，盖不住下巴与额头，
 * 打码时会露出半张脸（典型症状是"眼睛糊了、嘴还在"）。所以按解剖点
 * 分别取上下界再各自外扩 —— 468 号附近是下巴尖，10 号是额头顶。
 *
 * @param {Array<{x:number,y:number}>} pts 归一化关键点
 * @param {object} [pad] 外扩比例（相对框宽/高）
 */
function boxOf(pts, pad = { x: 0.12, y: 0.1 }) {
  if (!Array.isArray(pts) || pts.length < 100) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (!p) continue
    const x = num(p.x, NaN)
    const y = num(p.y, NaN)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (!Number.isFinite(x0) || x1 <= x0) return null
  const w = x1 - x0
  const h = y1 - y0
  /* 外扩后夹在画面内：跑到画外的部分在成片里会被裁掉，但**预览不会**，
     两边差一点点，用户就会说"预览和导出的位置不一样"。 */
  const nx0 = clamp(x0 - w * pad.x, 0, 1)
  const ny0 = clamp(y0 - h * pad.y, 0, 1)
  const nx1 = clamp(x1 + w * pad.x, 0, 1)
  const ny1 = clamp(y1 + h * pad.y, 0, 1)
  return { x: nx0, y: ny0, w: Math.max(0.01, nx1 - nx0), h: Math.max(0.01, ny1 - ny0) }
}

/**
 * 把逐帧检测结果压成 track。
 *
 * 三件事必须一起做，否则导出侧会拿到一份"抖"的数据：
 *   ① **丢掉小于 0.5% 的框**（误检的脸通常极小，跟上去就是画面上一块乱跳的斑）；
 *   ② **跳变剔除**：相邻帧中心位移超过 35% 脸宽时，判为跳到了另一张脸或误检，
 *      用上一帧的值顶替（宁可"晚半拍跟上"，也不要"突然闪一下"）；
 *   ③ **丢帧就插值**：检测是抽帧跑的，中间帧靠 `trackAt` 插，不在这里补。
 *
 * @param {Array<{t:number, box:object|null}>} frames
 * @returns {number[][]} `[[t, x, y, w, h], ...]`，按 t 升序
 */
function sampleTrack(frames) {
  const list = Array.isArray(frames) ? frames : []
  const out = []
  let prev = null
  for (const frame of list) {
    if (!frame) continue
    const t = num(frame.t, NaN)
    if (!Number.isFinite(t) || t < 0) continue
    let box = frame.box
    if (!box || !(box.w > 0.005) || !(box.h > 0.005)) {
      /* 这一帧没检到：不写点，让 trackAt 两端插值 ——
         硬补一个"上一帧的位置"会让静止时看着没问题、一动就顿住 */
      continue
    }
    if (prev) {
      const dcx = Math.abs(box.x + box.w / 2 - (prev.x + prev.w / 2))
      if (dcx > prev.w * 0.35) box = prev
    }
    out.push([+t.toFixed(3), +box.x.toFixed(4), +box.y.toFixed(4), +box.w.toFixed(4), +box.h.toFixed(4)])
    prev = box
  }
  return out
}

/**
 * 任意时刻取框（线性插值）。
 *
 * ⚠️ 头尾之外**不外推**：第一帧之前用第一帧、最后一帧之后用最后一帧。
 *    外推的后果是片尾人已经出画了，框还在按最后的速度往画面外飞。
 *
 * @param {number[][]} track
 * @param {number} t 片段内秒数
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function trackAt(track, t) {
  const list = Array.isArray(track) ? track : []
  if (!list.length) return null
  const at = num(t, 0)
  if (at <= list[0][0]) return { x: list[0][1], y: list[0][2], w: list[0][3], h: list[0][4] }
  const last = list[list.length - 1]
  if (at >= last[0]) return { x: last[1], y: last[2], w: last[3], h: last[4] }
  /* 二分：10 秒 30fps 的 track 有 300 项，逐帧线性扫在导出时会被调 300 次 × 300 项 */
  let lo = 0
  let hi = list.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (list[mid][0] <= at) lo = mid
    else hi = mid
  }
  const a = list[lo]
  const b = list[hi]
  const span = b[0] - a[0]
  const k = span > 1e-6 ? (at - a[0]) / span : 0
  return {
    x: a[1] + (b[1] - a[1]) * k,
    y: a[2] + (b[2] - a[2]) * k,
    w: a[3] + (b[3] - a[3]) * k,
    h: a[4] + (b[4] - a[4]) * k
  }
}

/**
 * 生成 sendcmd 脚本（导出侧逐帧驱动 overlay 的位置）。
 *
 * 格式是实测出来的，与文档写法**不同**（这一点很坑）：
 *   `0.033 overlay@face x 512`
 *   · target **不加方括号**。写成 `[overlay@face]` 会报
 *     `Unknown flag 'overlay@face] x 0;...'` —— 文档里的方括号语法在本机
 *     ffmpeg 8.1 上不被接受；
 *   · target 必须是**滤镜实例名**（`overlay@face`），不是滤镜名；
 *   · 命令名就是滤镜的 option 名（`x` / `y`）。
 *
 * 只在位置变化 ≥1px 时写一行：10 秒 30fps 全写是 300 行 × 2 参数 = 600 行，
 * 而人手不动的时候一半是重复的。
 *
 * @param {number[][]} track 归一化 track
 * @param {object} opts
 * @param {number} opts.w 成片像素宽
 * @param {number} opts.h 成片像素高
 * @param {string} opts.target 滤镜实例名，如 'face'
 * @param {number} [opts.offsetX] 叠加物相对框的偏移（像素）
 * @param {number} [opts.offsetY]
 * @param {[number,number]} [opts.size] 叠加物尺寸；不给则用框尺寸
 * @returns {string} 可直接喂给 `sendcmd=f=<file>` 的内容
 */
function buildSendcmd(track, opts = {}) {
  const list = Array.isArray(track) ? track : []
  const W = num(opts.w, 1920)
  const H = num(opts.h, 1080)
  const target = String(opts.target || 'face')
  const ox = num(opts.offsetX, 0)
  const oy = num(opts.offsetY, 0)
  const fixedW = Array.isArray(opts.size) ? num(opts.size[0], 0) : 0
  const fixedH = Array.isArray(opts.size) ? num(opts.size[1], 0) : 0

  const lines = []
  let lastX = null
  let lastY = null
  for (const row of list) {
    const t = num(row[0], 0)
    const fw = fixedW > 0 ? fixedW : row[3] * W
    const fh = fixedH > 0 ? fixedH : row[4] * H
    /* 叠加物居中对齐到脸框中心 —— 直接拿左上角会把框的左边缘当中心，
       描边类效果会整体偏半个脸宽 */
    const px = Math.round(row[1] * W + row[3] * W / 2 - fw / 2 + ox)
    const py = Math.round(row[2] * H + row[4] * H / 2 - fh / 2 + oy)
    /* 夹在画面内：overlay 的坐标允许负数，但那只会在成片边缘漏出一条黑 */
    const cx = Math.round(clamp(px, 0, Math.max(0, W - fw)))
    const cy = Math.round(clamp(py, 0, Math.max(0, H - fh)))
    if (cx === lastX && cy === lastY) continue
    lines.push(`${t.toFixed(3)} ${target} x ${cx}`)
    lines.push(`${t.toFixed(3)} ${target} y ${cy}`)
    lastX = cx
    lastY = cy
  }
  return lines.join(';\n') + (lines.length ? ';' : '')
}

/**
 * 局部处理的取景尺寸（像素）。
 *
 * 固定成一个**不随帧变化**的尺寸是有意的：`crop` 的 w/h 是初始化参数，
 * sendcmd 改不了，`scale` 的 w/h 同样改不了。想让取景框跟着脸放大缩小，
 * 只能每帧拼一条不同的滤镜链 —— 那是另一个量级的工程。
 * 所以这里取"整段里最大的那个框"，保证任何一帧都盖得住脸。
 *
 * @param {number[][]} track
 * @param {number} w 成片宽
 * @param {number} h 成片高
 * @returns {{w:number,h:number}} 偶数（yuv420p 要求）
 */
function cropSizeOf(track, w, h) {
  const list = Array.isArray(track) ? track : []
  let mw = 0.25
  let mh = 0.25
  for (const row of list) {
    if (row[3] > mw) mw = row[3]
    if (row[4] > mh) mh = row[4]
  }
  const even = (n) => Math.max(16, Math.round(n / 2) * 2)
  return { w: even(mw * num(w, 1920)), h: even(mh * num(h, 1080)) }
}

module.exports = {
  TRACK_FPS,
  FX_LIST,
  FX_KEYS,
  fxOf,
  boxOf,
  sampleTrack,
  trackAt,
  buildSendcmd,
  cropSizeOf
}
