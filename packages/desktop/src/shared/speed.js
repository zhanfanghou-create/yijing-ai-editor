'use strict'
/**
 * 片段倍速（真源唯一）。
 *
 * 为什么单独一个文件、还不许在渲染层与主进程各写一份：
 * 倍速是「时间线秒 ↔ 源素材秒」之间的**换算因子**，预览（渲染层算 currentTime）
 * 与导出（主进程拼 ffmpeg）用的是同一个因子。两边各写一份，迟早有一边漏掉 ——
 * 症状是"预览原速、成片 2 倍速"这种预览与成片对不上、而两边单独看都没错的缺陷，
 * 静态扫描和构建都拦不住，只有真播一遍才发现。
 *
 * 项目里已有的 `main/looks.js` ↔ `renderer/looks.js` 那对镜像是**被迫**的
 * （一边要产 CSS、一边要产 ffmpeg 滤镜串，确实无法共用）；
 * 而倍速是纯算术，没有任何理由分叉 —— 所以放在 shared/ 下，两边都从这里取。
 *
 * ⚠️ 这个文件是 **CommonJS**，因为主进程（`src/main/render.js`，Electron 33 / Node 20）
 * 是 CJS、且那个 Node 版本还不支持 `require()` 一个 ESM 文件；
 * 渲染层那边由 vite 的 commonjs 插件转（见 packages/desktop/vite.config.mjs 的
 * `commonjsOptions.include` —— 只放行这一个文件，别把整个 src 都转了）。
 * 改这里的模块语法前，先确认两边都还加载得到。
 */

/** 倍速的上下限。再慢没有实用价值；再快 atempo 要拆成多段链才做得到 */
const SPEED_MIN = 0.25
const SPEED_MAX = 4

/**
 * 片段倍速。**所有**读 `clip.speed` 的地方都必须走这个函数，不许直接 `clip.speed || 1`。
 *
 * 为什么非要一个函数：speed 缺省、写成 0、写成负数、写成 NaN 这四种情况
 * 在真实数据里都会出现（老草稿没有这个字段、面板传空值、JSON 里写成 null），
 * 而每一种的后果都不一样 —— 0 会让 ffmpeg 的 `setpts=PTS/0` 直接崩、
 * 负数会把画面倒过来放、NaN 会让整条滤镜链变成 `nan`，
 * 而 ffmpeg 报出来的错完全指不到这里。统一夹一次，四种情况都变成"原速"。
 *
 * @param {object} [clip] 片段
 * @returns {number} 夹进 [SPEED_MIN, SPEED_MAX] 的倍速；缺省 1
 */
function clipSpeed(clip) {
  const raw = Number(clip && clip.speed)
  if (!Number.isFinite(raw) || raw <= 0) return 1
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw))
}

/**
 * 这段片段在时间线上播完，要**吃掉源素材**多少秒。
 *
 * `duration` 是时间线上的占位，`sourceSpan` 是源里的消耗，换算因子就是倍速。
 * 修剪的不变式、导出时 trim 的长度、预览的源时间上限，全都用这一个口径。
 *
 * @param {object} clip 片段
 * @returns {number} 秒
 */
function sourceSpan(clip) {
  const duration = Number(clip && clip.duration) || 0
  return duration * clipSpeed(clip)
}

/**
 * 把倍速翻译成 ffmpeg 的 `atempo` 链。
 *
 * 为什么不是直接 `atempo=${speed}`：atempo 单级只接受 0.5–2.0，
 * 给它 4 会直接报 "Value out of range"（报错里完全看不出是倍速的问题）。
 * 超出就拆成多级相乘 —— 4 = 2×2，0.25 = 0.5×0.5。
 *
 * @param {number} speed 倍速
 * @param {(value:number, digits?:number)=>string} [round] 数字格式化（由调用方注入）
 * @returns {string} 形如 `,atempo=2,atempo=2`；原速返回空串
 */
function atempoChain(speed, round = (value) => String(value)) {
  const rate = clipSpeed({ speed })
  if (Math.abs(rate - 1) < 0.001) return ''
  const parts = []
  let rest = rate
  // 每级都保持在 atempo 的合法区间内，剩下的继续拆
  while (rest > 2.0001) {
    parts.push(2)
    rest /= 2
  }
  while (rest < 0.4999) {
    parts.push(0.5)
    rest /= 0.5
  }
  parts.push(rest)
  return `,${parts.map((value) => `atempo=${round(value, 4)}`).join(',')}`
}

/**
 * 视频侧的变速片段：`setpts=(PTS-STARTPTS)/speed`。
 *
 * 原速时返回 `setpts=PTS-STARTPTS`（与没做变速功能之前**逐字相同**）——
 * 这不是为了省字符，而是导出的滤镜串被 E2E 逐字断言过，
 * 无谓的改动会让一堆既有证据失效，掩盖真正的回归。
 *
 * @param {number} speed 倍速
 * @param {(value:number, digits?:number)=>string} [round] 数字格式化
 * @returns {string}
 */
function setptsExpr(speed, round = (value) => String(value)) {
  const rate = clipSpeed({ speed })
  if (Math.abs(rate - 1) < 0.001) return 'setpts=PTS-STARTPTS'
  return `setpts=(PTS-STARTPTS)/${round(rate, 4)}`
}

module.exports = {
  SPEED_MIN,
  SPEED_MAX,
  clipSpeed,
  sourceSpan,
  atempoChain,
  setptsExpr
}
