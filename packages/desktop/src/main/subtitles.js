/**
 * 字幕 / 文字 → ffmpeg drawtext 滤镜串。
 *
 * 为什么单独一个文件：字幕在**预览**里走 CSS（renderer/textStyles.js），
 * 在**导出**里必须翻译成 ffmpeg 滤镜 —— 这是两个渲染面，
 * 但参数只能有一份真源（shared/textStyles.json），所以两侧都从它推导。
 * 少了这一侧，"加了字幕"就只在预览里成立，成片里一个字都没有，
 * 而且全流程不报错、界面上完全看不出（这正是本项目最忌的那类静默失效）。
 *
 * 用法见 buildSubtitleFilters()。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const STYLES = require('../shared/textStyles.json')
const { applyTextOverrides } = require('../shared/textOverrides.js')

/** 样式 key → 定义。写错 / 缺省一律退回 fallback，不让字幕以"没样式"的姿态消失 */
function styleDef(key) {
  const hit = STYLES.styles.find((item) => item.key === key)
  if (hit) return hit
  const fb = STYLES.styles.find((item) => item.key === STYLES.fallback)
  return fb || STYLES.styles[0] || {}
}

/**
 * 找一个能渲染中文的字体文件。
 *
 * ⚠️ drawtext 不给 fontfile 时会用 ffmpeg 自带的默认字体，而那个字体**没有中文字形** ——
 *    中文会被画成空白或方框，ffmpeg 退出码照样是 0。所以"有没有找到字体"必须当成
 *    一个可以失败的前置条件，而不是默默用默认字体。
 *
 * 只列系统自带的几处，不打包字体（体积与授权都不划算）；
 * 一个都找不到就返回 ''，调用方据此决定跳过并如实告知。
 */
function findFontFile() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Windows/Fonts/msyh.ttc',
          'C:/Windows/Fonts/msyhbd.ttc',
          'C:/Windows/Fonts/simhei.ttf',
          'C:/Windows/Fonts/simsun.ttc'
        ]
      : process.platform === 'darwin'
        ? ['/System/Library/Fonts/PingFang.ttc', '/Library/Fonts/Arial Unicode.ttf']
        : [
            '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
            '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
            '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
          ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* 路径不可读就当没有 */
    }
  }
  return ''
}

/**
 * drawtext 的值里这几个字符是有含义的分隔符，必须转义。
 *
 * ⚠️ 用的是 spawn 数组传参（不经 shell），所以这里的转义是**给 ffmpeg 自己看的**，
 *    不是给命令行看的 —— 少转义 `:` 会让路径被当成好几个参数，
 *    表现是"No such filter: 'C'"，看不出跟字幕有关。
 */
function esc(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
}

/**
 * CSS 颜色 → ffmpeg 颜色。
 *
 * ⚠️ 样式表里的背景色写的是 CSS 那套（`rgba(0, 0, 0, 0.55)`），而 ffmpeg 的
 *    `boxcolor` / `fontcolor` **不认 `rgba()` 语法** —— 实测本机 ffmpeg 8.1.2：
 *    `#RRGGBB` / `0xRRGGBB` / `0xRRGGBBAA` / `name@alpha` 都过，
 *    `rgba(...)` 直接 `Cannot find color 'rgba(0, 0, 0, 0.55)'` **让整条导出失败**。
 *    后果极不对称：`sub-plain`（无底色）导出好好的，`sub-bar`（半透明底栏）
 *    却一条都导不出来 —— 而这两个是同一张样式表里并列的项。
 *    所以这里做一次换算，只动导出侧，预览侧仍然用 CSS 原样。
 *
 * 返回值：`rgba/rgb` → `0xRRGGBB[AA]`；其余（hex / 颜色名）原样放行。
 */
function cssColorToFfmpeg(value, fallback = '#000000') {
  const raw = String(value || '').trim()
  const m = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(raw)
  if (!m) return raw || fallback
  const byte = (v) => {
    const n = Math.round(Number(v))
    return Math.max(0, Math.min(255, Number.isFinite(n) ? n : 0))
  }
  const a = m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4])))
  const rrggbb = [byte(m[1]), byte(m[2]), byte(m[3])].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `0x${rrggbb}${byte(a * 255).toString(16).padStart(2, '0')}`
}

/**
 * 一条字幕 → 一条 drawtext。
 *
 * 文本走 **textfile** 而不是 text=：
 *   · 免掉一整套转义（冒号、单引号、反斜杠、百分号在文案里都很常见）；
 *   · drawtext 的 textfile 支持多行，用户敲的换行能照原样画出来；
 *   · 中文 UTF-8 直写直读，不用管编码。
 *
 * @returns {string|null} 滤镜串；拿不到字体或没有正文时返回 null（调用方跳过这一条）
 */
function drawtextFor(clip, { width, height, tmpDir, seq }) {
  const text = String(clip && clip.text ? clip.text : '').trim()
  if (!text) return null
  const font = findFontFile()
  if (!font) return null

  /* 基线样式（样式表那一项）+ 片段覆写（右侧检查器调的字号/颜色/位置）。
     ⚠️ 与预览用的是同一个 applyTextOverrides —— 两边各做一遍的话，
        迟早出现"预览里字幕变红了、成片里还是白的"这种只有导出成片才发现的缺陷。 */
  const def = applyTextOverrides(styleDef(clip.textStyle), clip)
  const scale = width / STYLES.baseWidth
  const size = Math.max(8, Math.round(Number(def.size || 40) * scale))
  const stroke = Math.max(0, Number(def.stroke || 0)) * scale

  const file = path.join(tmpDir, `yjai-sub-${seq}-${String(clip.id || seq).replace(/[^\w-]/g, '_')}.txt`)
  try {
    fs.writeFileSync(file, text, 'utf8')
  } catch {
    return null
  }

  /**
   * ⚠️ 字符串值一律用**单引号包裹 + 冒号转义**（实测出来的，不是猜的）：
   *    本机跑过五种写法，只有 `fontfile='C\:/Windows/Fonts/msyh.ttc'` 这一种能过 ——
   *    裸路径会把盘符的冒号当成 option 分隔符（报 No option name near '/Windows/...'，
   *    看着跟字幕一点关系都没有）；只转义不加引号同样断在冒号处。
   *    另外 `rgba(0, 0, 0, 0.55)` 这种带逗号的值不加引号会被当成两个 option。
   */
  const parts = [
    `fontfile='${esc(font)}'`,
    `textfile='${esc(file)}'`,
    `fontsize=${size}`,
    `fontcolor='${esc(cssColorToFfmpeg(def.color, '#FFFFFF'))}'`,
    `x=(w-text_w)/2`
  ]
  if (stroke > 0.01) {
    parts.push(`borderw=${stroke.toFixed(2)}`)
    parts.push(`bordercolor='${esc(cssColorToFfmpeg(def.strokeColor, '#000000'))}'`)
  }
  if (def.bg) {
    parts.push('box=1')
    parts.push(`boxcolor='${esc(cssColorToFfmpeg(def.bg))}'`)
    parts.push(`boxborderw=${Math.max(0, Math.round(Number(def.padX || 0) * scale))}`)
  }

  /* 竖向位置：anchor 决定落在画面的哪一头，offset 是离那一头的距离。
     单位与预览一致（都按 1280 基准换算），所以预览里贴着下边、成片里也贴着下边。 */
  const offset = Number(def.offset || 0) * scale
  const anchor = def.anchor || 'bottom'
  if (anchor === 'top') parts.push(`y=${Math.round(offset)}`)
  else if (anchor === 'center' || anchor === 'middle') parts.push('y=(h-text_h)/2')
  else parts.push(`y=h-text_h-${Math.round(offset)}`)

  /* 淡入：预览里的 anim=fade 在这里用 alpha 表达式表达，
     否则会出现"预览里字幕是淡进来的、成片里硬生生跳出来"。 */
  if (def.anim === 'fade') {
    parts.push(`alpha='if(lt(t-${Number(clip.start || 0).toFixed(3)}\\,0.3)\\,(t-${Number(clip.start || 0).toFixed(3)})/0.3\\,1)'`)
  }

  return `drawtext=${parts.join(':')}`
}

/**
 * 把时间线上的字幕片段翻译成一串 drawtext（串在视频流末尾）。
 *
 * 判据与预览一致：只认**字幕**（字幕轨上、无 assetId、有正文）。
 * 从素材库拖进来的「文字素材」在预览里是一张占位卡，导出也不该往画面上写字。
 *
 * @returns {{ filters: string[], count: number, missingFont: boolean }}
 */
function buildSubtitleFilters({ clips, width, height, tmpDir }) {
  const out = []
  let missingFont = false
  let seq = 0
  const list = (Array.isArray(clips) ? clips : []).filter(
    (clip) =>
      clip.track === 'text' &&
      !clip.assetId &&
      String(clip.text || '').trim() &&
      Number(clip.duration) > 0.01
  )
  if (!list.length) return { filters: out, count: 0, missingFont: false }

  for (const clip of list) {
    const start = Math.max(0, Number(clip.start))
    const end = start + Number(clip.duration)
    const body = drawtextFor(clip, { width, height, tmpDir, seq })
    seq += 1
    if (!body) {
      // 有正文却画不出来，只可能是没有可用字体 —— 如实记下来，由调用方告诉用户
      if (!findFontFile()) missingFont = true
      continue
    }
    out.push(`${body}:enable='between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})'`)
  }
  return { filters: out, count: out.length, missingFont }
}

module.exports = {
  STYLES,
  styleDef,
  findFontFile,
  drawtextFor,
  buildSubtitleFilters
}
