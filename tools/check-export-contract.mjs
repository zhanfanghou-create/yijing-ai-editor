#!/usr/bin/env node
/**
 * 「导出载荷字段契约」检查。
 *
 * 盯的是一类极难发现的缺陷：**导出引擎读某个字段，但渲染层从来没把它发出去**。
 *
 * 这种缺陷的三个特征决定了它躲得过几乎所有检查：
 *   1. 两边代码都是对的 —— render.js 写 `clip.frameFx`，SidePanels 写了
 *      `clips.map(...)`，各自读起来毫无破绽；
 *   2. 不报错 —— 缺失字段在 JS 里就是 `undefined`，`clip.frameFx` 拿到 undefined，
 *      `frameFxFilterFor(undefined)` 直接走 'none' 分支；
 *   3. 界面上完全看不出来 —— 预览走渲染层自己的状态（特效看得见），只有导出成片里
 *      那一项静悄悄消失。用户是"导完片去别处看"才知道的。
 *
 * 2026-09-26 实测就是这个：`frameFx`（画面特效）早在 render.js 里实现了，
 * 但渲染层发过去的片段里根本没有这一项 ⇒ 加了特效、预览看得到、成片里没有。
 * 同一天还发现 `backdrop`（背景）也是同样形态：buildPlan 收 backdrop 参数，
 * render() 却没往下传，IPC 也没带。
 *
 * 所以这道闸做的是**跨进程字段对账**：
 *   · 从 SidePanels.jsx 里解析出 `bridge.render.start({...})` 那段片段映射的**键集**；
 *   · 从 main/render.js 的 buildPlan 里解析出所有 `clip.<字段>` 的**用集**；
 *   · 用集必须是键集的子集，多一个就红。
 *   · 另外钉住 backdrop：渲染层要发、IPC 要转发、render() 要收。
 *
 * 用法：node tools/check-export-contract.mjs [仓库根]
 *
 * 退出码：0 = 契约成立；1 = 发现漏发/漏收；2 = 参数或文件不对；3 = 检查器自身异常
 */

import fs from 'node:fs'
import path from 'node:path'

const exit = { ok: 0, bad: 1, usage: 2, crash: 3 }

const problems = []
const notes = []

function fail(label, detail = '') {
  problems.push(detail ? `${label} — ${detail}` : label)
}

/**
 * 从 `text` 的 `from` 位置开始，读出紧跟着的那个对象字面量的**顶层键**。
 *
 * 用括号深度扫而不是数行数：键里可能带嵌套对象/模板串，按行取会在第一个嵌套处截断，
 * 而截断的结果（少几个键）正好是"看着像通过了"的那种假绿。
 */
/**
 * 把注释按等长空格抹掉（保留换行），下标与原文一一对应。
 *
 * 必须先做这一步：注释里出现 `key:` 形状的文字（例如「backdrop: 背景也要进成片」）
 * 会被键提取当成真键、反之夹在注释里的 `"…"` 或半个括号会把括号深度带偏，
 * 两种偏差都指向"看着像通过了"的假绿。
 */
function stripComments(text) {
  let out = ''
  let s = null
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (s) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === s) s = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      s = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function objectKeysAt(text, from) {
  const start = text.indexOf('{', from)
  if (start < 0) return null
  let depth = 0
  let i = start
  let inStr = null
  const keys = []
  let keyStart = -1
  for (; i < text.length; i += 1) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1
      if (ch === '{' && depth === 1) keyStart = i + 1
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (depth === 1 && ch === ',') keyStart = i + 1
  }
  if (depth !== 0) return null
  const body = text.slice(start + 1, i)
  // 顶层键：逐个落在深度 0 上的 `name:`
  let d = 0
  let s = null
  let buf = ''
  for (let k = 0; k < body.length; k += 1) {
    const ch = body[k]
    if (s) {
      if (ch === '\\') {
        k += 1
        continue
      }
      if (ch === s) s = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      s = ch
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') d += 1
    else if (ch === '}' || ch === ')' || ch === ']') d -= 1
    if (d === 0 && (ch === ',' || k === body.length - 1)) {
      const piece = buf + (ch === ',' ? '' : ch)
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(piece)
      if (m) keys.push(m[1])
      buf = ''
    } else {
      buf += ch
    }
  }
  return { keys, start, end: i }
}

/**
 * 从 `from` 往后找到第一个 `{`，取出与之配平的整个花括号块（含括号）。
 *
 * 用来把 `if (withBackdrop) { … }` 这一段**单独抠出来**做判据 ——
 * 直接在整份函数体里找某个符号会被"别处的同款符号"喂饱（判据比缺陷宽 = 假绿）。
 */
function ifBlockAt(text, from) {
  const open = text.indexOf('{', from)
  if (open < 0) return ''
  let depth = 0
  let s = null
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (s) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === s) s = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      s = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`读不到 ${path.basename(file)}`, String(error && error.message))
    return ''
  }
}

/** buildPlan 函数体：跳过形参列表（`buildPlan({ clips, … })` 那个 `{` 是形参，不是函数体） */
function buildPlanBody(src) {
  const sig = /function\s+buildPlan\s*\(/.exec(src)
  if (!sig) return ''
  // 先跨过形参列表：括号配对闭合后的第一个 `{` 才是函数体
  let i = sig.index + sig[0].length
  let paren = 1
  let s = null
  while (i < src.length && paren > 0) {
    const ch = src[i]
    if (s) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === s) s = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      s = ch
      i += 1
      continue
    }
    if (ch === '(') paren += 1
    else if (ch === ')') paren -= 1
    i += 1
  }
  const braceStart = src.indexOf('{', i)
  if (braceStart < 0) return ''
  let depth = 0
  let str = null
  for (let k = braceStart; k < src.length; k += 1) {
    const ch = src[k]
    if (str) {
      if (ch === '\\') {
        k += 1
        continue
      }
      if (ch === str) str = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      str = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceStart, k + 1)
    }
  }
  return src.slice(braceStart)
}

function main() {
  const root = path.resolve(process.argv[2] || '.')
  const panelsPath = path.join(root, 'packages', 'desktop', 'src', 'renderer', 'components', 'SidePanels.jsx')
  const renderPath = path.join(root, 'packages', 'desktop', 'src', 'main', 'render.js')
  const mainPath = path.join(root, 'packages', 'desktop', 'src', 'main', 'index.js')

  for (const p of [panelsPath, renderPath, mainPath]) {
    if (!fs.existsSync(p)) {
      fail('缺少源文件', p)
    }
  }
  if (problems.length) {
    console.error('参数/文件错误，没能开始检查：')
    for (const p of problems) console.error(`  ✗ ${p}`)
    return exit.usage
  }

  /* 三个源都先抹掉注释再解析：注释里的 `key:` 与半截括号会把解析带偏，
     而带偏的结果恰好是"看着像通过"的假绿 —— 见 stripComments 的说明。 */
  const panelsSrc = stripComments(read(panelsPath))
  const renderSrc = stripComments(read(renderPath))
  const mainSrc = stripComments(read(mainPath))

  /* ---------- 1. 渲染层发出去的片段字段 ---------- */
  const startAt = panelsSrc.indexOf('bridge.render.start(')
  if (startAt < 0) {
    fail('SidePanels 里找不到 bridge.render.start(…) ——导出入口被改名/挪走了，这道闸就失效了')
  } else {
    const payloadObj = objectKeysAt(panelsSrc, panelsSrc.indexOf('{', startAt))
    if (!payloadObj) {
      fail('bridge.render.start 的参数读不出来（括号没配平）')
    } else {
      const payloadText = panelsSrc.slice(payloadObj.start, payloadObj.end + 1)
      const clipsAt = payloadText.indexOf('clips:')
      if (clipsAt < 0) {
        fail('导出载荷里没有 clips —— 时间线根本没发过去')
      } else {
        const mapAt = payloadText.indexOf('({', clipsAt)
        const mapped = objectKeysAt(payloadText, mapAt >= 0 ? mapAt : clipsAt)
        if (!mapped || !mapped.keys.length) {
          fail('clips.map 的片段对象读不出来')
        } else {
          notes.push(`渲染层发出的片段字段（${mapped.keys.length}）：${mapped.keys.join(', ')}`)
          if (!mapped.keys.includes('id')) fail('片段没带 id —— 主进程按 id 查探测结果，缺了会一律当"有音轨"')

          /**
           * 字幕的三个字段**不在 buildPlan 里读**（字幕走 subtitles.js 的 drawtext），
           * 所以上面的"用集 ⊆ 键集"对账根本扫不到它们 —— 必须单独钉：
           *   · text / textStyle —— 少了就拼不出 drawtext；
           *   · assetId —— 少了就分不出"字幕"与"从素材库拖进来的文字素材"，
           *     后者不该被画到画面上。
           */
          for (const field of ['text', 'textStyle', 'assetId']) {
            if (!mapped.keys.includes(field)) {
              fail(`渲染层没发片段的 ${field} —— 字幕写不进成片（导出侧靠它拼 drawtext / 分辨字幕与文字素材）`)
            }
          }

          /**
           * 倍速**不能**只靠上面的"用集 ⊆ 键集"自动对账。
           *
           * buildPlan 里读倍速的写法是 `speed.clipSpeed(clip)`（走共享真源），
           * 不是 `clip.speed`，于是扫 `clip.<字段>` 的正则根本扫不到它 ——
           * 自动对账会**静默放行**"渲染层压根没发 speed"。
           * 这类"因为写法不同而躲过检查"的洞必须显式补一条：
           * 漏发 speed 的症状是成片里所有片段都按原速渲染，不报错、界面无提示。
           */
          if (!mapped.keys.includes('speed')) {
            fail('渲染层没发片段的 speed —— 成片里所有片段都按原速渲染（界面上调了倍速也没用）')
          }

          /* ---------- 2. 主进程用到了哪些字段 ---------- */
          const body = buildPlanBody(renderSrc)
          if (!body) {
            fail('main/render.js 里找不到 buildPlan —— 导出引擎被改名/挪走了')
          } else {
            const used = new Set()
            for (const m of body.matchAll(/\bclip\.([A-Za-z_$][\w$]*)/g)) used.add(m[1])
            for (const m of body.matchAll(/\bseg\.clip\.([A-Za-z_$][\w$]*)/g)) used.add(m[1])
            const usedList = [...used].sort()
            notes.push(`buildPlan 读到的片段字段（${usedList.length}）：${usedList.join(', ')}`)

            if (!usedList.length) fail('buildPlan 里一个 clip.* 都没读到 —— 解析失效，等于没查')

            for (const field of usedList) {
              if (!mapped.keys.includes(field)) {
                fail(
                  `buildPlan 读 clip.${field}，但渲染层没发这个字段`,
                  '导出出来的成片里这一项会静默退成默认值（不报错、界面看不出）'
                )
              }
            }
          }
        }

        /* ---------- 3. backdrop 三段接力 ---------- */
        if (!payloadObj.keys.includes('backdrop')) {
          fail('导出载荷里没有 backdrop —— 选了背景也只影响预览，成片里没有')
        }
      }
    }
  }

  /* ---------- 4. backdrop 在 IPC 与 render() 里有没有被转下去 ---------- */
  const ipcAt = mainSrc.indexOf("ipcMain.handle('render:start'")
  if (ipcAt < 0) {
    fail('main/index.js 里找不到 render:start 处理器')
  } else {
    const chunk = mainSrc.slice(ipcAt, ipcAt + 1600)
    if (!/backdrop/.test(chunk)) {
      fail('render:start 没有把 payload.backdrop 转给 renderTimeline —— 背景在 IPC 这一层就断了')
    }
  }
  if (!/async function render\(\{[^}]*backdrop/.test(renderSrc)) {
    fail('main/render.js 的 render() 不收 backdrop —— buildPlan 拿到的永远是空串')
  }
  if (!/buildPlan\(\{[^}]*backdrop/.test(renderSrc)) {
    fail('main/render.js 的 render() 没把 backdrop 传给 buildPlan')
  }

  /* ---------- 4b. 倍速：主进程必须**从共享真源**取，不许自己抄一份 ---------- */
  /**
   * 三条一起钉住"倍速在导出侧真的生效、且与渲染层同源"：
   *   · 没读倍速 ⇒ 成片不变速（界面上调了也没用，且不报错）；
   *   · 不从 shared/speed.js 取 ⇒ 迟早与渲染层分叉，一边漏掉倍速；
   *   · 自己再定义一份 ⇒ 同上（而且比"没用"更隐蔽：两份都在，只是值不同）。
   */
  if (!/\bclipSpeed\s*\(/.test(renderSrc)) {
    fail('main/render.js 里没有读倍速 —— 成片不会变速（界面上调倍速也不报错、就是没效果）')
  }
  if (!/shared[\\/]speed\.js/.test(renderSrc)) {
    fail(
      'main/render.js 没有引用 shared/speed.js —— 倍速换算因子与渲染层会各写一份',
      '各写一份的后果是"预览一个速度、成片另一个速度"，两边单独看都没错'
    )
  }
  if (/function\s+clipSpeed\s*\(/.test(renderSrc)) {
    fail(
      'main/render.js 自己又定义了一份 clipSpeed —— 与 shared/speed.js 分叉了',
      '两份都"能跑"，错的是它们不一致；这种缺陷不会报错'
    )
  }

  /* ---------- 5. 背景真的被叠进画面（不是只把四周挖透明） ---------- */
  /**
   * ⚠️ 判据只认 **withBackdrop 那一段分支里**的 overlay，不能在整份 buildPlan 里找
   *    `overlay=`：后来加进去的"带 alpha 时压到黑底"也是 `overlay=`，它会把这条件喂饱，
   *    于是"背景那一段被挖空了"这种缺陷照样绿（判据比缺陷宽 = 假绿）。
   */
  const planBody = buildPlanBody(renderSrc)
  if (planBody && /withBackdrop/.test(planBody)) {
    const wbAt = /if\s*\(\s*withBackdrop\b/.exec(planBody)
    const wbBlock = wbAt ? ifBlockAt(planBody, wbAt.index) : ''
    if (!/overlay\s*=/.test(wbBlock)) {
      fail(
        'buildPlan 的 withBackdrop 分支里没有 overlay —— 背景不会出现在成片里',
        '透明留边最后会被输出成黑色，效果等于没接'
      )
    }
  }

  /* ---------- 6. 叠加轨（画中画）是独立的一层，不是主链的一段 ---------- */
  /**
   * 三个条件缺一不可，而且缺哪个症状都不一样：
   *   · 主链不排除它 ⇒ 画中画被 concat 进主链，成片凭空多出一段（时长与内容都错）；
   *   · 不单独收集它 ⇒ 成片里根本没有画中画（轨道上有、画面里没有）；
   *   · 收集了却不 forEach 渲染 ⇒ 参数接了、画面上依然没有。
   * 三者都成立才算"叠加轨真的接上了"。
   */
  if (planBody) {
    if (!/clip\.track !== 'overlay'/.test(planBody)) {
      fail(
        'buildPlan 的主链没有排除叠加轨 —— 画中画会被 concat 成独立一段',
        '成片时长与内容都会错，而界面上只表现为"画中画的位置不对"'
      )
    }
    if (!/clip\.track === 'overlay'/.test(planBody)) {
      fail('buildPlan 没有单独收集叠加轨片段 —— 画中画进不了成片')
    }
    if (!/overlayClips\.forEach/.test(planBody)) {
      fail('buildPlan 收集了叠加轨却没有渲染它 —— 参数接了、画面上什么都没有')
    }
  }

  /* ---------- 7. 叠加轨有入口、预览也接了（不能只有导出侧） ---------- */
  const appPath = path.join(root, 'packages', 'desktop', 'src', 'renderer', 'App.jsx')
  const stagePath = path.join(root, 'packages', 'desktop', 'src', 'renderer', 'components', 'Stage.jsx')
  if (fs.existsSync(appPath)) {
    const appSrc = stripComments(read(appPath))
    if (appSrc && !/track === 'overlay'/.test(appSrc)) {
      fail(
        'App.jsx 里没有把片段放进叠加轨的通路 —— 轨道存在但没有入口',
        '用户只能靠"往那条轨上拖"才用得到，而界面上没有任何提示'
      )
    }
  }
  if (fs.existsSync(stagePath)) {
    const stageSrc = stripComments(read(stagePath))
    /**
     * 2026-09-27：画中画从"一条"变成"当前时刻在场的**全部**"，
     * 所以默认值也从 `null` 变成 `[]`。两种写法都算接了，但必须**有默认值**
     * （没有默认值 ⇒ 一个画中画都没有时 Stage 收到 undefined，`.map` 直接抛）。
     */
    if (stageSrc && !/[ \n]pip = (null|\[\])[,]/.test(stageSrc)) {
      fail(
        'Stage 不接收 pip —— 画中画只在成片里有、预览里看不见',
        '预览与成片不一致是最难查的一类：两边单独看都对'
      )
    }
  }

  /* ---------- 8. 字幕被翻译成 drawtext，且叠在最上层 ---------- */
  /**
   * 字幕字段不在 buildPlan 里读，所以"用集 ⊆ 键集"那种对账抓不到它 ——
   * 这里钉的是另一头：**导出侧到底有没有翻译**。少了这一头，
   * "加了字幕"就只在预览里成立（预览是 CSS 画的），成片里一个字都没有。
   */
  if (!/buildSubtitleFilters/.test(renderSrc)) {
    fail('render.js 没有把字幕翻译成 drawtext —— 预览里有字幕、成片里一个字都没有')
  }
  const subAt = renderSrc.indexOf('buildSubtitleFilters')
  const pipAt = renderSrc.indexOf('overlayClips.forEach')
  if (subAt > 0 && pipAt > 0 && subAt < pipAt) {
    fail('字幕滤镜串在画中画之前 —— 字幕会被画中画盖住（字幕必须是最上面的一层）')
  }

  /* ---------- 9. 效果（圆角 / 蒙版 / 抠像 / 描边 / 阴影 / 混合）真的进导出链 ---------- */
  /**
   * 这一组全是「两半都写对了、就是没接上」的形状：
   *   · effects.js 写了换算、Inspector 写了控件、预览也画了 —— 只有导出链没调用它；
   *   · 或者调用了，但 `anyTransparent` 没把效果算进去 ⇒ 整条链的 pixFmt 落回 yuv420p，
   *     alpha 被编码器整体丢掉（预览里抠了像、成片里绿底照旧，ffmpeg 不报错）；
   *   · 或者 alpha 保住了，但没有"压到黑底"的一步 ⇒ 透明只存在于滤镜图里，
   *     导出后照样变回原色（只能靠读像素发现）。
   * 三条缺任何一条，症状都是"面板上拖了、预览也变了、成片里一个像素没变"。
   */
  if (!/shared[\\/]effects\.js/.test(renderSrc)) {
    fail(
      'main/render.js 没有引用 shared/effects.js —— 效果换算会与渲染层各写一份',
      '各写一份的后果是"预览圆了、成片还是方的"，两边单独看都没错'
    )
  }
  if (!/effectsStages\s*\(/.test(renderSrc)) {
    fail('main/render.js 里没有 effectsStages —— 效果根本没进导出滤镜链')
  }
  if (planBody) {
    if (!/effectsStages\s*\(/.test(planBody)) {
      fail('buildPlan 没有调用 effectsStages —— 效果只在预览里成立，成片里一个像素都不变')
    }
    /* 效果会产生 alpha（抠像 / 圆角 / 蒙版 / 描边 / 阴影）⇒ 必须参与 "这条链要不要带 alpha" */
    const alphaAt = planBody.indexOf('anyTransparent')
    const alphaSlice = alphaAt >= 0 ? planBody.slice(alphaAt, alphaAt + 800) : ''
    if (!/readEffects/.test(alphaSlice) || !/hasClip/.test(alphaSlice) || !/fx\.key\.on/.test(alphaSlice)) {
      fail(
        'buildPlan 的 anyTransparent 没把效果算进去 —— 抠像/圆角产生的 alpha 会被整体丢掉',
        'pixFmt 落回 yuv420p ⇒ 成片里绿底照旧、圆角照旧是方的，而 ffmpeg 一行错都不报'
      )
    }
    if (!/needAlpha\s*&&\s*!withBackdrop/.test(planBody) || !/blkbg/.test(planBody)) {
      fail(
        'buildPlan 缺少"带 alpha 时压到黑底"的一步 —— 编码器会直接丢掉 alpha',
        '症状是"预览里抠了像、成片里绿底还在"，只能靠读导出像素发现'
      )
    }
  }
  {
    const prepAt = renderSrc.indexOf('await prepareEffectMasks(')
    /* ⚠️ 要定位**调用点**（`= buildPlan({`），不是 `function buildPlan({` 那个定义 ——
       定义一定在文件更前面，用它当基准会让这条判据永远"通过"。 */
    const planAt = renderSrc.indexOf('= buildPlan({')
    if (prepAt < 0) {
      fail('render() 没有在 buildPlan 之前备好遮罩 PNG —— 圆角 / 蒙版在成片里不会生效')
    } else if (planAt > 0 && prepAt > planAt) {
      fail(
        '遮罩 PNG 是在 buildPlan 之后才备的 —— 构建命令时拿不到遮罩文件',
        'buildPlan 是同步的，而生成遮罩要等 ffmpeg 跑完（本机 spawnSync 走管道恒 EBUSY）'
      )
    }
  }
  if (/Math\.tan\s*\(/.test(renderSrc)) {
    fail(
      'main/render.js 自己算了三角函数（斜切）—— 换算必须在 shared/effects.js 里',
      '两侧各算一份 tan，角度定义一旦分叉就是"预览往左上、成片往右下"'
    )
  }

  for (const n of notes) console.log(`  · ${n}`)
  if (problems.length) {
    console.error('')
    console.error(`导出载荷字段契约：发现 ${problems.length} 处问题`)
    for (const p of problems) console.error(`  ✗ ${p}`)
    return exit.bad
  }
  // 契约只有「成立 / 不成立」两态：成立 = 1 条通过，不成立时上面已逐条打印并走 exit 1。
  // total/pass/fail 三个都要给：verify.mjs 靠 pass+fail(+skip) 反推总数，少给 fail 会
  // 让它判成"解析不到断言数"（那是闸门在喊自己瞎了，不是被测代码有问题）。
  console.log('EXPORT_CONTRACT_STATS total=1 pass=1 fail=0')
  console.log('EXPORT_CONTRACT_OK')
  return exit.ok
}

try {
  process.exitCode = main()
} catch (error) {
  console.error('检查器自身异常（这不是被测代码的问题，是检查器崩了）：')
  console.error(String((error && error.stack) || error))
  process.exitCode = exit.crash
}
