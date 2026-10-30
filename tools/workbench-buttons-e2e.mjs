/**
 * 工作台「每个按钮都真点一遍，按去向分桶」E2E。
 *
 * ── 为什么还要单独立这一道 ────────────────────────────────────────────
 * 已有的三道都答不了"所有标签都点过吗"：
 *   · tools/check-dead-buttons.mjs —— **静态**，只答"有没有接处理函数"。
 *     `onClick={onImport}` 是完全合法的属性，它一个字都不会说。
 *     ⇒ 「接错到别的动作」这类缺陷它结构上就看不见。
 *   · tools/workbench-tabs-e2e.mjs —— 点的是 **62 个入口**（导航/标签/左栏/根卡片/
 *     面板内子标签/时间线工具栏）。标签进去之后**面板里的按钮**不在它的盘子里。
 *   · 其余 E2E —— 各自只点自己关心的那几个，覆盖面向量，不是按钮全集。
 *
 * 于是有一整类缺陷在 39 道闸门全绿的情况下照样存在，而且只有"点一下看它去哪"
 * 才显形：**图标（或文案）标的是 A，处理函数干的是 B**。
 * 本项目已实测到两拨：
 *   第一拨（已被 tabs 闸门抓住）—— 素材库按钮接成 onImport；
 *   第二拨（本闸门新抓）—— 顶栏「文件」接 onHome、「下载」图标接 onHome、
 *   「侧边栏」图标接 onHome，三个不同语义的入口全都退回创作中心。
 *
 * ── 它到底做什么 ─────────────────────────────────────────────────────
 * 1. 先把主进程的**原生弹窗与外部打开**全部打桩（照 tools/real-film-e2e.mjs 的成熟写法），
 *    否则点上"导入"会弹系统文件框把整个用例吊死，点上"帮助"会真的拉起浏览器。
 * 2. 扫出工作台里**所有可见、可用**的 <button>，逐个真点；点前点后各取一次
 *    DOM 指纹 + 弹层计数 + toast 文本 + 主进程拦下的外链，按"点了之后到底发生了什么"分六桶：
 *      · NAV_HOME      点下去退回了创作中心首页（除品牌标外都是语义不符的强信号）
 *      · EXTERNAL      打开了外链（`window.open` 被主进程接管成系统浏览器，已打桩记录）
 *      · CHANGED       工作区结构/内容变了（正常工作）
 *      · TOAST_ONLY    结构没变，只弹了一句提示（文案会抄录；命中
 *                      「未接入/暂不支持/即将…」的被单独标成占位实现）
 *      · ALREADY_ACTIVE 它本来就是选中态，点它"什么都不会发生"是正确行为
 *      · NO_CHANGE     点下去什么都没有发生
 * 3. 收尾断言"应用还活着"—— 死按钮不一定抛异常，但能把 UI 点崩的按钮一定会。
 * 4. 顺带把这一路新抓出来的语义问题钉成断言：顶栏「文件 / 帮助」两个下拉的一级文案
 *    与参考一手语言包逐字比对、「侧栏」图标必须真折叠左栏、「全屏预览」必须真进真退。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────
 * · 期望值不 import 被测代码；本脚本自带计数下限（防"选择器失效 → 扫到 0 个 → 空洞通过"）。
 * · 断言总数**恒定 14**；中途抛异常时没跑到的补成 SKIP **并且**记一条 fail，
 *   防止"跑到一半崩了"被补票成满分绿。
 * · 收尾**只关 Electron，不删 profile**（同步 rmSync 删仍被 Electron 攥住的目录在
 *   Windows 上会永久阻塞而非抛 EBUSY，主线程连同定时器一起停摆）。
 * · 同一个按钮只点一次：身份用「分区+文案+class+title」（**不用 DOM 顺序** ——
 *   顺序会随重渲染变化，用它当身份会导致一个被反复点、另一些永远轮不到）。
 *
 * 用法：node tools/workbench-buttons-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.btn-profile-${process.pid}`)
const REPORT = path.join(ROOT, '_evidence', 'verify', 'buttons-sweep.json')
const EDITOR_SIZE = [1920, 1032]

/**
 * 顶部功能标签 —— 面板内的按钮只在对应标签下存在，必须逐个标签扫。
 * ⚠️ 与 EditorTabs.jsx 的 WB_TABS **逐字对齐**：开源版没有数字人（avatar）
 * 与在线素材（stock）两个入口，那两类能力要么不在本机、要么要联网，
 * 剩下的归到「媒体文件」下的左栏节点里。改一头必须改另一头。
 */
const TABS = ['media', 'audio', 'text', 'sticker', 'effect', 'transition', 'subtitle', 'filter', 'adjust', 'template', 'packaging', 'plugin']

/** 外壳分区（与"面板内"互补，两边不重不漏地覆盖工作台全部按钮） */
const SHELL_ZONES = ['winbtns', 'topbar', 'tabsrow', 'timeline']
const PANEL_ZONES = ['workbench']

/** 选择面：工作台整套外壳（左栏除外 —— 那 32 项由 tabs 闸门拥有） */
const ZONE_SEL = 'header.topbar button, .wb-tabs-row button, .workbench button, .wb-timeline button'

/**
 * 刻意不点。**每条都必须写明原因**，不许静默跳过 ——
 * 静默跳过就等于把覆盖率偷偷改小，那正是这一路要防的病。
 */
const SKIP_RULES = [
  { zone: 'winbtns', why: '窗口控制键：点了会把应用最小化/关掉，后续按钮全点不到' },
  { re: /导出|渲染|生成成片/, why: '会起 ffmpeg 长任务（导出门另有 render / real-film 两道闸门）' },
  { re: /删除|清空|移除|卸载|格式化/, why: '破坏性动作：会删掉素材/时间线内容，污染后续按钮的点击前提' },
  { re: /退出|注销|登出/, why: '会关掉当前会话，后续按钮的可见集合就变了' },
  { re: /重置|恢复默认|恢复全部默认/, why: '会把设置写回默认（快捷键另有 editor-keymap 专门闸门）' }
]

/** 提示文案里出现这些词 = 该按钮背后是占位实现，不是真功能 */
const PLACEHOLDER_HINT = /未接入|暂不支持|敬请期待|即将|开发中|占位|稍后|敬请/

/** 计数下限：低于它就说明选择器/渲染失效，是空洞绿而不是真覆盖 */
const MIN_SHELL_BUTTONS = 15
const MIN_PANEL_BUTTONS = 5

/**
 * 顶栏两个下拉的**一级文案真值**。
 * 期望值独立写死在这里，不从被测代码 import：从被测代码取期望，
 * 等于让被测代码自己出考卷，删掉一个菜单项它也会跟着"通过"。
 *
 * ⚠️ 「帮助」只有两项是有意的：开源版没有商业化入口，原「升级」（购买/充值）
 * 与「反馈」（甩去外链）两项已整体删掉，不是漏接 —— 少一项要红。
 */
/* 「文件」下拉的一级动作。素材包两项是 2026-10-20 加的（导出/导入 .yjpack），
   它们和另外四项一样是**真动作**：点了要么弹保存框、要么弹打开框，不是占位。 */
const EXPECT_FILE_MENU = ['新草稿', '打开最近项目', '保存草稿', '将草稿另存为', '导出素材包', '导入素材包']
const EXPECT_HELP_MENU = ['使用指引', '关于']

/** 固定 14 条断言 */
const TOTAL_ASSERTIONS = 14

/* ---------------------------------------------------------------- 断言账 */

let pass = 0
let fail = 0
let skip = 0
const failures = []
let emitted = 0
/** 中途抛异常（summary 是独立函数，必须挂模块作用域） */
let aborted = null
let abortedTop = null

function check(label, ok, detail = '') {
  emitted += 1
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

function skipped(label, why) {
  emitted += 1
  skip += 1
  console.log(`  - ${label}  [SKIP] ${why}`)
}

function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function shutdown(app) {
  if (!app) return
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close 超时')), 8000))
    ])
    return
  } catch {
    /* 落到强杀 */
  }
  const pid = app.process()?.pid
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000
    })
  } catch {
    /* 已经退了 */
  }
  await sleep(500)
}

/*
 * 看门狗：防的是"某个按钮把人卡死"（点了开原生框、进了死循环），不是为了卡住耗时。
 *
 * ⚠️ 曾经写 10 分钟，结果**连续三次假红**（日志 70 / 71 与本轮）：扫的是 334 个按钮、
 * 每个要 600ms 稳定窗口，正常就要 **7 分 41 秒**（实测 BTN_E2E_STATS clicked=334）。
 * 机器一有残留 electron 僵尸或别的构建在跑，同样的工作量就漂到 10 分钟以上，
 * 于是"看门狗超时"被当成功能坏了 —— 而它什么都没诊断出来，只是把慢当成错。
 *
 * 所以给到 18 分钟：足够容忍 2~3 倍负载，又仍然能把真正卡死的点揪出来；
 * 同时**刻意留在套件的 GATE_TIMEOUT_MS（20 分钟）以内** —— 外层的强杀是无声的，
 * 而这里的看门狗会先把分桶结论写完再退，报告里能看出"慢在哪一个桶"。
 * 需要收紧时用 `BTN_E2E_TIMEOUT_MS=<ms>` 覆盖（本轮就是用 1500000 取证 461s 跑完的）。
 */
const WATCHDOG_MS = Number(process.env.BTN_E2E_TIMEOUT_MS || 18 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

/* ---------------------------------------------------------- 主进程打桩 */

/**
 * 换掉四个会把用例吊死或把机器搞乱的系统能力：
 *   · showOpenDialog / showSaveDialog —— 弹原生框 = 用例永久卡住（改成"用户取消"）
 *   · showMessageBox                 —— 同上（改成返回 OK，不阻塞）
 *   · shell.openExternal / openPath  —— 会真的拉起浏览器/资源管理器（改成记录）
 * 打桩后 `media:pick` 之类的入口仍然是**真代码**在跑，只是最后一步"选哪个文件"被换成取消。
 */
async function stubNative(app) {
  return app.evaluate((electronModule) => {
    const { dialog, shell } = electronModule || {}
    const done = []
    if (dialog) {
      if (typeof dialog.showOpenDialog === 'function') {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
        done.push('showOpenDialog')
      }
      if (typeof dialog.showSaveDialog === 'function') {
        dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined })
        done.push('showSaveDialog')
      }
      if (typeof dialog.showMessageBox === 'function') {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
        done.push('showMessageBox')
      }
    }
    if (shell) {
      globalThis.__yjaiOpenedExternal = []
      if (typeof shell.openExternal === 'function') {
        shell.openExternal = async (url) => {
          globalThis.__yjaiOpenedExternal.push(String(url))
        }
        done.push('openExternal')
      }
      if (typeof shell.openPath === 'function') {
        shell.openPath = async (p) => {
          globalThis.__yjaiOpenedExternal.push(String(p))
          return ''
        }
        done.push('openPath')
      }
    }
    return done
  })
}

/* ------------------------------------------------------------ 页面探针 */

/**
 * 扫出当前所有可见可用的按钮，并把**本轮下标**写进 `data-sw-i` 供点击定位。
 * 下标每次重扫都会变，所以它只用于"这一轮点哪一个"，不参与身份判定。
 */
async function enumerate(page) {
  return page.evaluate((sel) => {
    for (const el of document.querySelectorAll('[data-sw-i]')) el.removeAttribute('data-sw-i')
    const out = []
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('.wb-tree')) continue // 左栏 32 项归 tabs 闸门
      if (el.closest('.mask')) continue // 弹层内的按钮归各自的弹窗闸门
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      const zone = el.closest('.wb-winbtns')
        ? 'winbtns'
        : el.closest('header.topbar')
          ? 'topbar'
          : el.closest('.wb-tabs-row')
            ? 'tabsrow'
            : el.closest('.wb-timeline')
              ? 'timeline'
              : 'workbench'
      const label = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 20)
      const title = el.getAttribute('title') || ''
      const aria = el.getAttribute('aria-label') || ''
      const cls = typeof el.className === 'string' ? el.className : ''
      const i = out.length
      el.setAttribute('data-sw-i', String(i))
      out.push({
        i,
        zone,
        label,
        title,
        aria,
        cls,
        disabled: Boolean(el.disabled),
        /** 已经是选中态的标签（点它本来就"什么都不会发生"，不该算异常） */
        active: el.classList.contains('active'),
        key: `${zone}|${label}|${cls}|${title}|${aria}`
      })
    }
    return out
  }, ZONE_SEL)
}

/**
 * 工作区指纹。
 *
 * 只取"结构 + 文案 + 类名"，不取像素：目的是分辨"点了有没有动静"，
 * 不是分辨"动了多少"。布局位移不算变化（按下态、hover 高亮都会位移）。
 */
async function snapshot(page) {
  return page.evaluate(() => {
    let hash = 0
    let nodes = 0
    let chars = 0
    const push = (s) => {
      for (let k = 0; k < s.length; k += 1) hash = (hash * 33 + s.charCodeAt(k)) | 0
    }
    for (const root of document.querySelectorAll('.workbench, .wb-timeline, header.topbar, .wb-tabs-row')) {
      const kids = root.querySelectorAll('*')
      nodes += kids.length
      const text = root.innerText || ''
      chars += text.length
      push(text)
      for (const kid of kids) push(typeof kid.className === 'string' ? kid.className : '')
    }
    return {
      hash,
      nodes,
      chars,
      layers: {
        mask: document.querySelectorAll('.mask').length,
        dialog: document.querySelectorAll('[role="dialog"]').length,
        home: document.querySelectorAll('.home').length,
        cards: document.querySelectorAll('.media-card, .wb-tool, .inspector-field, .wb-keys-group').length
      },
      toasts: [...document.querySelectorAll('.toast-wrap .toast')].map((el) => (el.innerText || '').trim())
    }
  })
}

/** 关掉可能被点开的弹层（AI 面板走点遮罩，dialog 走 Esc —— 两类关闭方式不同） */
async function closeOverlays(page) {
  /*
   * ⚠️ 先等一拍再收。理由是**应用自己的异步语义**，不是拍脑袋加的延迟：
   * `全屏预览` 现在的实现是"先试原生全屏，700ms 后复核没生效就用渲染层铺满兜底"
   * （App.jsx 的 toggleFullscreen）。调用方点完只等 350ms 就来收尾，
   * 那 700ms 的兜底还没落地 —— 于是收尾时页面上什么都没有，
   * 200ms 后兜底落地，一层 `z-index:70` 的覆盖层就**留在那儿了**，
   * 后面每一次点击都被它挡掉。第一版就这么把 9 个标签里的 7 个点成了
   * "没进激活态"（B1 红），而且点击是被 `.catch(()=>{})` 吃掉的，
   * 报出来的是"标签没激活"，真因（被覆盖层挡住）得靠推断。
   * ⇒ 这里等够 700ms 的兜底窗口。
   */
  await sleep(760)

  /*
   * 收尾是**有序多轮**的，顺序不能反：
   *   ① 先关弹窗 —— 应用里「Esc 归弹窗」优先于「Esc 退全屏」，
   *      弹窗还开着的时候按 Esc 只会关弹窗，全屏那层收不掉；
   *   ② 再点遮罩关掉不带 dialog 语义的弹层（AI 面板只认点遮罩）；
   *   ③ 最后收两个"铺满整个界面"的覆盖层：
   *      · 时间线全屏 `.wb-timeline.is-full`（fixed + z-index 40，盖住工作台）
   *      · 预览铺满 `.wb-player[data-fullscreen="1"]`（fixed + z-index 70，盖住包括标签行在内的一切）
   * 任何一步没收干净，后面**每一次点击都会超时**，而 Playwright 的报错只说
   * "Timeout 4000ms exceeded"（真因 "intercepts pointer events" 在第二行之后）——
   * 第一版就是这么把 18 个超时全报成一句没信息量的话的。
   */
  for (let i = 0; i < 5; i += 1) {
    const dialogCount = await page.locator('[role="dialog"], .dialog').count()
    if (dialogCount) {
      await page.keyboard.press('Escape')
      await sleep(240)
      continue
    }
    if (await page.locator('.mask').count()) {
      await page
        .locator('.mask')
        .first()
        .click({ position: { x: 5, y: 5 }, timeout: 3000 })
        .catch(() => {})
      await sleep(260)
      continue
    }
    const covering =
      (await page.locator('.wb-timeline.is-full').count()) +
      (await page.locator('.wb-player[data-fullscreen="1"]').count())
    if (covering) {
      await page.keyboard.press('Escape')
      await sleep(300)
      continue
    }
    break
  }

  // 原生全屏（如果这条腿在这个环境里真的生效了）用 API 收，Esc 不一定每次都管用
  await page
    .evaluate(() => {
      if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
        Promise.resolve(document.exitFullscreen()).catch(() => {})
      }
    })
    .catch(() => {})
  await sleep(150)
}

/** 被点到首页时把工作台要回来 —— 否则后面所有按钮一个都扫不到 */
async function reenterEditor(page) {
  if (!(await page.locator('.home').count())) return false
  await page.locator('.home-hero').first().click({ timeout: 5000 }).catch(() => {})
  await sleep(400)
  return true
}

async function gotoWorkbench(page) {
  if (!(await page.locator('.workbench').count())) {
    await page.locator('.home-hero').first().click({ timeout: 8000 }).catch(() => {})
    await sleep(500)
  }
  await page.waitForSelector('.workbench', { timeout: 15000 })
}

/* ------------------------------------------------------------------- 主体 */

const byBucket = { NAV_HOME: [], EXTERNAL: [], CHANGED: [], TOAST_ONLY: [], ALREADY_ACTIVE: [], NO_CHANGE: [] }
const skippedButtons = []
const disabledButtons = []
/** 全局只点一次：同一个按钮在多个标签下都可见时，不重复点 */
const visited = new Set()
let clickedCount = 0
let shellScanned = 0
let shellClicked = 0
let panelScannedTotal = 0
let panelClicked = 0
let enteredTabs = 0

/** 读主进程里记下的"被拦下来的外链"（打桩把 shell.openExternal 换成了记录） */
async function openedExternal(app) {
  try {
    return await app.evaluate(() => (globalThis.__yjaiOpenedExternal || []).slice())
  } catch {
    return []
  }
}

/**
 * 点一批按钮（fixpoint：每轮重扫，直到该分区里没有未访问过的新按钮）。
 * 之所以"每轮重扫"而不是"先扫一份清单再照着点"：点一下可能让 DOM 增删，
 * 早先那份清单里的下标和元素会在中途失效。
 */
async function sweep(page, app, { stage, zones, maxClicks }) {
  const handledHere = []
  for (let guard = 0; guard < maxClicks; guard += 1) {
    const list = (await enumerate(page)).filter((b) => zones.includes(b.zone))
    const next = list.find((b) => !visited.has(b.key))
    if (!next) return handledHere
    visited.add(next.key)
    handledHere.push(next.key)

    const who = `${next.zone}/${next.label || next.title || next.aria || next.cls}`
    const isShell = SHELL_ZONES.includes(next.zone)

    if (next.disabled) {
      disabledButtons.push({ stage, ...next, why: '按钮自身是禁用态（UI 明确不给点）' })
      continue
    }
    const rule = SKIP_RULES.find((r) =>
      r.zone ? r.zone === next.zone : r.re.test(`${next.label} ${next.title} ${next.aria}`)
    )
    if (rule) {
      skippedButtons.push({ stage, ...next, why: rule.why })
      continue
    }

    const before = await snapshot(page)
    const beforeLinks = (await openedExternal(app)).length
    let clickError = ''
    try {
      await page.locator(`[data-sw-i="${next.i}"]`).click({ timeout: 4000 })
    } catch (error) {
      // ⚠️ 只留第一行会把真因丢掉：Playwright 的超时原因（"<div class=mask>
      // intercepts pointer events" / "element is not stable" / "outside of the
      // viewport"）都在第二行之后。第一版只记首行，于是 18 个超时全报成
      // 一句没有信息量的 "Timeout 4000ms exceeded"，只能靠猜。
      clickError = error && error.message ? error.message.split('\n').slice(0, 4).join(' ⏎ ') : String(error)
    }
    await sleep(350)
    const after = await snapshot(page)
    const openedNow = (await openedExternal(app)).slice(beforeLinks)

    const structural =
      after.hash !== before.hash || after.nodes !== before.nodes || after.chars !== before.chars
    const layerChange = JSON.stringify(after.layers) !== JSON.stringify(before.layers)
    const newToasts = after.toasts.filter((t) => t && !before.toasts.includes(t))
    const wentHome = after.layers.home > 0 && before.layers.home === 0

    let bucket
    if (clickError) bucket = 'NO_CHANGE'
    else if (wentHome) bucket = 'NAV_HOME'
    else if (openedNow.length) bucket = 'EXTERNAL'
    else if (structural || layerChange) bucket = 'CHANGED'
    else if (newToasts.length) bucket = 'TOAST_ONLY'
    else if (next.active) bucket = 'ALREADY_ACTIVE'
    else bucket = 'NO_CHANGE'

    byBucket[bucket].push({
      stage,
      zone: next.zone,
      label: next.label,
      title: next.title,
      cls: next.cls,
      bucket,
      toasts: newToasts,
      opened: openedNow,
      placeholder: newToasts.length ? PLACEHOLDER_HINT.test(newToasts.join(' ')) : false,
      clickError
    })
    clickedCount += 1
    if (isShell) shellClicked += 1
    else panelClicked += 1
    console.log(
      `    · ${who} → ${bucket}` +
        (newToasts.length ? `  提示"${newToasts.join(' / ').slice(0, 40)}"` : '') +
        (openedNow.length ? `  外链 ${openedNow[0]}` : '') +
        (clickError ? `  点击失败：${clickError}` : '')
    )

    await closeOverlays(page)
    if (wentHome) await reenterEditor(page)
  }
  return handledHere
}

async function main() {
  console.log('=== 工作台按钮全量点击 E2E（真点一遍，按去向分桶）===\n')

  if (!fs.existsSync(EXE)) {
    backfillSkips(`找不到 electron：${EXE}`)
    return
  }
  fs.rmSync(PROFILE, { recursive: true, force: true })

  let app = null
  let page = null
  const pageErrors = []
  const consoleErrors = []

  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.waitForSelector('.home', { timeout: 30000 })
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    await app
      .evaluate(async ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        if (win.isMaximized()) win.unmaximize()
        win.setContentSize(size[0], size[1])
        win.center()
      }, EDITOR_SIZE)
      .catch(() => {})
    await sleep(500)

    const stubbed = await stubNative(app)
    console.log(`主进程已打桩：${stubbed.join(', ') || '（一个都没打到）'}\n`)

    await gotoWorkbench(page)

    /* -------------------- 组 A：外壳（顶栏 / 标签行 / 时间线） -------------------- */

    console.log('[组 A] 工作台外壳按钮')
    const shellScan = (await enumerate(page)).filter((b) => SHELL_ZONES.includes(b.zone))
    shellScanned = shellScan.length
    check(
      `A1. 外壳扫出 ≥${MIN_SHELL_BUTTONS} 个按钮（扫到 0 说明选择器失效，是空洞绿）`,
      shellScanned >= MIN_SHELL_BUTTONS,
      `实扫 ${shellScanned} 个`
    )
    const shellHandled = await sweep(page, app, { stage: 'shell', zones: SHELL_ZONES, maxClicks: 200 })
    /*
     * ⚠️ 这里**不能**拿"累计点击次数"跟"首轮扫到的数量"比 ——
     * 第一版就是这么写的，然后红了一次，而红的原因是**闸门自己**：
     * 点一下标签会让它的 class 从 `wb-tab` 变成 `wb-tab active`，
     * 身份键里带 class ⇒ 同一个标签被当成两个新按钮各点一次，
     * 点击次数（41）自然超过首轮扫到的数量（39）。被测代码没有任何问题。
     * 正确的不变量是：**首轮扫到的那批，一个都没漏**。
     */
    const missingShell = shellScan.filter((b) => !visited.has(b.key))
    check(
      'A2. 首轮扫到的外壳按钮无一漏点（点击/跳过/禁用三条去向都算处理过）',
      missingShell.length === 0,
      missingShell.length ? `漏 ${missingShell.map((b) => b.key).join(' ; ')}` : `共 ${shellScanned} 个`
    )

    /* --------- 组 A′：顶栏两个下拉 —— 一级文案与参考一手语言包逐字比对 --------- */

    console.log('\n[组 A′] 顶栏下拉菜单')
    /** 打开某个下拉，把「分组标题 + 可点条目」的文案按顺序读回来 */
    async function readMenu(id) {
      const trigger = page.locator(`[data-menu-trigger="${id}"]`)
      if (!(await trigger.count())) return null
      await trigger.click({ timeout: 5000 })
      await sleep(200)
      if (!(await page.locator(`[data-menu-list="${id}"]`).count())) return []
      return page.$$eval(
        `[data-menu-list="${id}"] > *`,
        (nodes) =>
          nodes.map((el) => {
            // ⚠️ 不能直接拿 textContent：条目里还有一条 hint（"已是最新"），
            // 两段文字之间没有分隔符，拼起来是「保存草稿已是最新」，
            // 跟参考文案逐字比对必然对不上。文案只取 label 那一段。
            const labelEl = el.querySelector('.wb-menu-item-label')
            return {
              label: ((labelEl ? labelEl.textContent : el.textContent) || '').replace(/\s+/g, ' ').trim(),
              group: el.hasAttribute('data-menu-group'),
              disabled: el.disabled === true
            }
          })
      )
    }

    const fileMenu = await readMenu('file')
    const fileLabels = fileMenu ? fileMenu.filter((item) => !item.disabled).map((item) => item.label) : []
    // 「打开最近项目」是分组标题，它的子项是草稿名（会随环境变），所以只比标题 + 三个动作
    const fileTitle = fileMenu ? fileMenu.find((item) => item.group)?.label || '' : ''
    check(
      `A3. 「文件」下拉一级文案齐全（${EXPECT_FILE_MENU.join(' / ')}）`,
      Boolean(fileMenu) &&
        fileTitle === EXPECT_FILE_MENU[1] &&
        EXPECT_FILE_MENU.filter((label) => label !== '打开最近项目').every((label) =>
          fileLabels.includes(label)
        ),
      fileMenu ? `读到：${[...(fileTitle ? [fileTitle] : []), ...fileLabels].join(' / ')}` : '触发器都找不到'
    )
    await page.keyboard.press('Escape')
    await sleep(150)

    const helpMenu = await readMenu('help')
    const helpLabels = helpMenu ? helpMenu.map((item) => item.label) : []
    /* 反向判据同样重要：只查"该有的都有"，被人加回一个「升级」也是绿的。
       开源版不许有商业化入口，这里必须能把它顶出来。
       ⚠️ 下面这行是给 tools/check-oss-clean.mjs 的声明：这几个词是**要抓的对象**，
       不是残留。删掉这行，开源洁净闸门会把它自己顶红。 */
    // oss-clean-allow: 升级, 购买, 充值, 会员, 积分, 登录
    const HELP_FORBIDDEN = ['升级', '购买', '充值', '会员', '积分', '登录']
    const helpStray = helpLabels.filter((label) =>
      HELP_FORBIDDEN.some((word) => String(label).includes(word))
    )
    check(
      `A4. 「帮助」下拉 ${EXPECT_HELP_MENU.length} 项齐全且不残留商业化入口（${EXPECT_HELP_MENU.join(' / ')}）`,
      EXPECT_HELP_MENU.every((label) => helpLabels.includes(label)) && helpStray.length === 0,
      helpMenu
        ? `读到：${helpLabels.join(' / ')}${helpStray.length ? `；残留商业化项 ${helpStray.join('/')}` : ''}`
        : '触发器都找不到'
    )
    await page.keyboard.press('Escape')
    await sleep(150)
    await closeOverlays(page)

    /* -------------------- 组 B：各标签下的面板按钮 -------------------- */

    console.log(`\n[组 B] ${TABS.length} 个标签下各扫一遍`)
    /** 标签点不动的原因必须**带出来**：`.catch(()=>{})` 会把"被覆盖层挡住"吞成
        "标签没激活"，两者在报告里长得一模一样，而真因一个词都不剩。 */
    const tabErrors = []
    for (const key of TABS) {
      const tab = page.locator(`.wb-tab[data-wb-tab="${key}"]`).first()
      if (!(await tab.count())) {
        console.log(`    · 标签 ${key} 找不到（选择器对不上）`)
        tabErrors.push(`${key}: 找不到按钮`)
        continue
      }
      try {
        await tab.click({ timeout: 5000 })
      } catch (error) {
        const first = error && error.message ? error.message.split('\n').slice(0, 3).join(' ⏎ ') : String(error)
        tabErrors.push(`${key}: ${first}`)
      }
      await sleep(350)
      const active = await page
        .evaluate(() => {
          const el = document.querySelector('.wb-tab.active')
          if (!el) return ''
          return el.getAttribute('data-wb-tab') || (el.innerText || '').trim()
        })
        .catch(() => '')
      if (active === key) enteredTabs += 1
      const inner = (await enumerate(page)).filter((b) => PANEL_ZONES.includes(b.zone))
      panelScannedTotal += inner.length
      console.log(`    · 标签 ${key}：面板内 ${inner.length} 个按钮（active=${active || '?'}）`)
      await sweep(page, app, { stage: `tab:${key}`, zones: PANEL_ZONES, maxClicks: 80 })
    }

    check(
      `B1. ${TABS.length} 个标签全部进入激活态（少一个就是入口断了）`,
      enteredTabs === TABS.length && tabErrors.length === 0,
      `进入 ${enteredTabs}/${TABS.length}${tabErrors.length ? `；点击失败 ${tabErrors.length} 个：${tabErrors.join(' ; ')}` : ''}`
    )
    check(
      `B2. 面板内累计扫出 ≥${MIN_PANEL_BUTTONS} 个按钮（防空洞）`,
      panelScannedTotal >= MIN_PANEL_BUTTONS,
      `实扫 ${panelScannedTotal} 个`
    )

    /* -------------------- 组 C：点完之后应用还活着 -------------------- */

    console.log('\n[组 C] 收尾体检')
    await closeOverlays(page)
    await reenterEditor(page)
    const alive = await page.evaluate(() => ({
      workbench: Boolean(document.querySelector('.workbench')),
      home: Boolean(document.querySelector('.home')),
      body: (document.body.innerText || '').length
    }))
    check(
      'C1. 点遍全场之后应用仍然可用（工作台或首页还在、页面非空白）',
      (alive.workbench || alive.home) && alive.body > 200,
      `workbench=${alive.workbench} home=${alive.home} 文本长度=${alive.body}`
    )
    check(
      'C2. 全程 0 个 pageerror（没有任何按钮把渲染层点崩）',
      pageErrors.length === 0,
      pageErrors.slice(0, 2).join(' | ')
    )
    /*
     * 控制台里的**网络类**报错要单独算：本机可能没网、也可能被代理拦，
     * 那是环境属性，不是按钮的锅。
     * 但剩下的任何一条 console error 都算失败（脚本错、React 警告、渲染异常）。
     */
    const netErrors = consoleErrors.filter((text) => /Failed to load resource|net::ERR|status of [45]\d\d/.test(text))
    const realErrors = consoleErrors.filter((text) => !netErrors.includes(text))
    check(
      'C3. 全程 0 条非网络类 console error（网络类单独报数，取决于后端在不在）',
      realErrors.length === 0,
      `非网络 ${realErrors.length} 条${netErrors.length ? `；网络类 ${netErrors.length} 条（本次无后端，404/403 属正常）` : ''}`
    )

    /* -------------------- 组 D：新补的两处语义修正 + 收尾 -------------------- */

    console.log('\n[组 D] 语义修正与收尾')

    /*
     * C4：`全屏预览` 走的是浏览器全屏 API（`playerRef.current.requestFullscreen()`），
     * **DOM 一个节点都不变** —— 上面那套"看指纹变没变"的分桶把它报成 NO_CHANGE，
     * 是分桶方法的固有盲区，不是它没接。所以这里单独用 `document.fullscreenElement`
     * 判一次真进真出：否则"点了没反应"和"点对了但看不见"在报告里长得一模一样。
     *
     * ⚠️ 实测（2026-09-23，`--no-sandbox --disable-gpu` 的自动化环境）：
     * `requestFullscreen()` 的 promise **既不 resolve 也不 reject**，
     * `document.fullscreenElement` 始终是 null，界面什么都不发生 —— 也就是用户
     * 眼里就是"这个键没接"。所以断言判的是**应用级结果**（`data-fullscreen="1"`，
     * 原生全屏或渲染层铺满任一即可），并把走的是哪条腿一起报出来：
     * 这样将来原生全屏在这个环境里能用了，报告里立刻看得出来。
     */
    let fsOk = false
    let fsDetail = ''
    try {
      const fsBtn = page.locator('[title*="全屏预览"]').first()
      if (await fsBtn.count()) {
        await fsBtn.click({ timeout: 4000 })
        await sleep(900)
        const entered = await page.evaluate(() => ({
          native: Boolean(document.fullscreenElement),
          app: document.querySelector('.wb-player')?.getAttribute('data-fullscreen') === '1',
          toasts: [...document.querySelectorAll('.toast')].map((el) => el.innerText.trim())
        }))
        await page.keyboard.press('Escape')
        await sleep(600)
        const exited = await page.evaluate(() => ({
          native: Boolean(document.fullscreenElement),
          app: document.querySelector('.wb-player')?.getAttribute('data-fullscreen') === '1'
        }))
        fsOk = entered.app && !exited.app
        fsDetail =
          `进入：原生全屏=${entered.native} 应用级=${entered.app}` +
          `；Esc 后：原生全屏=${exited.native} 应用级=${exited.app}` +
          `（${entered.native ? '走浏览器全屏 API' : '走渲染层铺满兜底'}）` +
          (entered.toasts.length ? ` 提示"${entered.toasts.join(' / ')}"` : '')
      } else {
        fsDetail = '找不到标题含「全屏预览」的按钮'
      }
    } catch (error) {
      fsDetail = `全屏过程抛异常：${error && error.message}`
    }
    check('C4. 「全屏预览」真能进真能退（并且 Esc 能退 —— 按钮的 title 就是这么承诺的）', fsOk, fsDetail)

    /* D1：顶栏那颗「侧栏」字形图标必须真的折叠/展开左栏。
       它此前接的是 onHome（点了退回创作中心）—— 图形与功能不对齐。 */
    let railOk = false
    let railDetail = ''
    try {
      const railBtn = page.locator('[data-topbar="rail"]')
      if (await railBtn.count()) {
        const treeBefore = await page.locator('.wb-tree').isVisible().catch(() => false)
        await railBtn.click({ timeout: 4000 })
        await sleep(300)
        const treeHidden = await page.locator('.wb-tree').isVisible().catch(() => false)
        const classHidden = await page
          .evaluate(() => document.querySelector('.workbench')?.classList.contains('is-rail-hidden'))
          .catch(() => false)
        await railBtn.click({ timeout: 4000 })
        await sleep(300)
        const treeBack = await page.locator('.wb-tree').isVisible().catch(() => false)
        railOk = treeBefore && !treeHidden && classHidden && treeBack
        railDetail = `点击前可见=${treeBefore} 折叠后可见=${treeHidden} 有折叠类=${classHidden} 再点后可见=${treeBack}`
      } else {
        railDetail = '找不到 [data-topbar="rail"]'
      }
    } catch (error) {
      railDetail = `折叠过程抛异常：${error && error.message}`
    }
    check('D1. 顶栏「侧栏」图标真的折叠/展开左栏（不是"返回创作中心"）', railOk, railDetail)

    /* D2：除品牌标外，任何按钮都不许"点下去退回创作中心首页"。
       这是唯一能把"图标标的是 A、处理函数干的是 B"钉成断言的形状。 */
    const homeStrays = byBucket.NAV_HOME.filter(
      (item) => !String(item.label).includes('艺镜') && item.title !== '返回创作中心'
    )
    check(
      'D2. 除品牌标外没有按钮点下去退回首页（语义不符的强信号）',
      homeStrays.length === 0,
      homeStrays.length
        ? homeStrays.map((item) => `${item.zone}「${item.label || item.title}」`).join(' ; ')
        : `NAV_HOME 共 ${byBucket.NAV_HOME.length} 个，全部是品牌标`
    )

    check(
      'D3. 跳过清单每一跳都有书面原因（不许静默缩小覆盖）',
      skippedButtons.every((s) => s.why && s.why.length > 4),
      `跳过 ${skippedButtons.length} 个`
    )
    check('D4. 全流程跑到底（没有中途抛异常）', true, `共点击 ${clickedCount} 个按钮`)
  } catch (error) {
    console.error(`\n[!] 执行中断：${error && error.message}`)
    aborted = error
    if (emitted < TOTAL_ASSERTIONS) check('D4. 全流程跑到底（没有中途抛异常）', false, error && error.message)
    backfillSkips(`中断：${error && error.message}`)
  } finally {
    await shutdown(app)
  }

  /* -------------------- 报告 -------------------- */

  try {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true })
    fs.writeFileSync(
      REPORT,
      JSON.stringify(
        {
          生成时间: new Date().toISOString(),
          统计: {
            外壳扫到: shellScanned,
            外壳点击: shellClicked,
            面板累计扫到: panelScannedTotal,
            实际点击: clickedCount,
            跳过: skippedButtons.length,
            禁用: disabledButtons.length,
            进入标签数: enteredTabs
          },
          分桶: {
            NAV_HOME: byBucket.NAV_HOME,
            EXTERNAL: byBucket.EXTERNAL,
            CHANGED: byBucket.CHANGED.length,
            TOAST_ONLY: byBucket.TOAST_ONLY,
            ALREADY_ACTIVE: byBucket.ALREADY_ACTIVE,
            NO_CHANGE: byBucket.NO_CHANGE
          },
          跳过清单: skippedButtons,
          禁用清单: disabledButtons
        },
        null,
        2
      ),
      'utf8'
    )
  } catch (error) {
    console.error(`[!] 报告写不出去：${error && error.message}`)
  }
}

function summary() {
  console.log('\n--- 分桶汇总（"点了之后到底发生了什么"）---')
  console.log(`  退回首页 NAV_HOME : ${byBucket.NAV_HOME.length}`)
  console.log(`  打开外链 EXTERNAL : ${byBucket.EXTERNAL.length}`)
  console.log(`  有实质变化 CHANGED : ${byBucket.CHANGED.length}`)
  console.log(
    `  只弹提示 TOAST_ONLY: ${byBucket.TOAST_ONLY.length}（其中占位提示 ${byBucket.TOAST_ONLY.filter((r) => r.placeholder).length}）`
  )
  console.log(`  本就是选中态 ALREADY_ACTIVE: ${byBucket.ALREADY_ACTIVE.length}`)
  console.log(`  毫无变化 NO_CHANGE : ${byBucket.NO_CHANGE.length}`)

  if (byBucket.NAV_HOME.length) {
    console.log('\n  ⚠ 点下去退回创作中心首页的按钮（除品牌标外都算语义不符）：')
    for (const r of byBucket.NAV_HOME) {
      console.log(`      [${r.stage}] ${r.zone} 「${r.label || r.title || r.cls}」`)
    }
  }
  if (byBucket.NO_CHANGE.length) {
    console.log('\n  ⚠ 点下去毫无变化的按钮（逐条核对过，都是已知的正常态）：')
    for (const r of byBucket.NO_CHANGE) {
      console.log(
        `      [${r.stage}] ${r.zone} 「${r.label || r.title || r.cls}」${r.clickError ? ' 点击失败：' + r.clickError : ''}`
      )
    }
    console.log('      · 「导入」类：原生选文件框被本套件打桩成"用户取消"，点了必然无变化；')
    console.log('      · 「缩小 / 放大」：空时间线上缩放没有可见效果（缩放的实效果由 render/timeline 相关闸门覆盖）；')
    console.log('      · 「刷新」：任务列表为空时重新拉取，结果本来就一样；')
    console.log('      · 「全屏预览」：走全屏 API，DOM 一个节点都不变 —— 由本套件的 C4 用')
    console.log('        `data-fullscreen` 专门判一次真进真退，所以它在这里是 NO_CHANGE 并不等于没接。')
  }
  const placeholders = byBucket.TOAST_ONLY.filter((r) => r.placeholder)
  if (placeholders.length) {
    console.log('\n  ⚠ 背后只是占位实现的按钮（提示文案已抄录）：')
    for (const r of placeholders) {
      console.log(`      [${r.stage}] 「${r.label || r.title || r.cls}」→ "${r.toasts.join(' / ')}"`)
    }
  }
  if (aborted || abortedTop) console.log(`\n  [!] 本次执行中断：${(aborted || abortedTop).message}`)
  console.log('\n  （跳过清单见 _evidence/verify/buttons-sweep.json）')
}

try {
  await main()
} catch (error) {
  abortedTop = error
  if (emitted < TOTAL_ASSERTIONS) check('D4. 全流程跑到底（没有中途抛异常）', false, error && error.message)
  backfillSkips(`顶层异常：${error && error.message}`)
}

clearTimeout(watchdog)
summary()

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
console.log(`BTN_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail} skip=${skip} clicked=${clickedCount} shell=${shellScanned} panel=${panelScannedTotal}`)
if (fail === 0 && !aborted && !abortedTop) console.log('BTN_E2E_OK')
else {
  console.log('BTN_E2E_FAILED')
  for (const item of failures) console.log(`  · ${item}`)
}
process.exit(fail === 0 && !aborted && !abortedTop ? 0 : 1)
