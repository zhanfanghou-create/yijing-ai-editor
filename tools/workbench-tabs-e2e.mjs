/**
 * 工作台「所有标签都点一遍」E2E —— 真启 Electron、逐个点击、逐个读 DOM。
 *
 * 为什么必须单独立这道：本项目的闸门里，左栏是**静态**检查的
 * （tools/check-workbench-tree.mjs 只验那张数据表写得对不对），
 * 顶部九个功能标签更是完全没人点过 —— tools/desktop-shoot.mjs 只是
 * `page.$$('.wb-tab')` 数了个数。于是有一整类缺陷闸门全绿也照样存在：
 *   · 点下去中栏显示「左侧选一个功能开始」的空壳（panel 名字对不上）；
 *   · 点下去中栏是空的（过滤条件筛不出任何东西，且连"没有素材"都不提示）；
 *   · 点下去什么都没变（onClick 接错成别的动作 / 压根没接）；
 *   · 点下去抛异常（面板里有没跑通的分支）。
 * 这些**都不报错、不让构建变红**，只有真点一遍才显形。
 *
 * 期望值全部**在本脚本里独立写死**，不从被测代码 import —— 从被测代码取期望，
 * 等于让被测代码自己出考卷，删掉一个标签它也会跟着"通过"。写死的另一面是：
 * 源码里少一个/多一个标签或左栏项，这道闸门会当场红。
 *
 * 断言总数恒为 180：找不到 electron 或被中断时，没跑到的逐条补成 SKIP。
 * （数字随下面 TABS 表变：表是唯一真源，改表就要改这个数。）
 *
 * 前置：不需要后端（开源版没有服务端）。断言只涉及结构（有没有东西、是不是空壳）。
 * 用法：node tools/workbench-tabs-e2e.mjs
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
/** 一轮一份独有 profile（承 K4：固定目录名在异常退出后删不掉，会带着上一轮状态启动） */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.tabs-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/* ------------------------------------------------------------------ 夹具 */

/** 首页左侧导航：开源版只有这两项（创作视频 / 最近草稿） */
const HOME_NAV = [
  { key: 'create', label: '创作视频' },
  { key: 'drafts', label: '最近草稿' }
]

/**
 * 顶部七个功能标签 → 各自的左栏根标签 + 二级项 key。
 *
 * ⚠️ 这张表是**独立写死**的（不从 AssetTree.jsx import）—— 从被测代码取期望
 * 等于让被测代码自己出考卷，删掉一个入口它也会跟着"通过"。
 * 代价是：AssetTree 里加减节点，这里要同步改，否则当场红。
 */
const TABS = [
  {
    key: 'media',
    label: '媒体文件',
    root: '素材',
    nodes: [
      'local', 'record', 'preset',
      /* ⚠️ 子项必须排在**父卡片之后**：左栏是手风琴，子项只在父卡片展开时才渲染，
         先点子项会 `locator` 超时（等不到一个还不存在的节点）。 */
      'stock', 'stock-bg', 'stock-video', 'stock-image', 'stock-anim', 'smart'
    ]
  },
  {
    key: 'text',
    label: '文字',
    root: '文字',
    nodes: [
      'text-create', 'text-custom', 'text-art',
      'art-g0', 'art-g1', 'art-g2', 'art-g3', 'art-g4', 'art-g5', 'art-g6', 'art-g7'
    ]
  },
  {
    key: 'subtitle',
    label: '字幕',
    root: '字幕',
    nodes: ['subtitle-custom', 'sub-new', 'sub-hand']
  },
  {
    key: 'audio',
    label: '音频',
    root: '音频',
    nodes: ['audio-extract', 'audio-music']
  },
  {
    key: 'transition',
    label: '转场',
    root: '转场',
    /* 2026-09-24：左栏换成参考分组树（materials.js 的 11 组），2 → 11 项 */
    nodes: [
      'tr-g0', 'tr-g1', 'tr-g2', 'tr-g3', 'tr-g4',
      'tr-g5', 'tr-g6', 'tr-g7', 'tr-g8', 'tr-g9', 'tr-g10'
    ]
  },
  {
    key: 'filter',
    label: '滤镜',
    root: '滤镜',
    /* 左栏就是滤镜分组树的 14 组（materials.js 的 FILTER_GROUPS 顺序一一对应） */
    nodes: [
      'fl-g0', 'fl-g1', 'fl-g2', 'fl-g3', 'fl-g4', 'fl-g5', 'fl-g6',
      'fl-g7', 'fl-g8', 'fl-g9', 'fl-g10', 'fl-g11', 'fl-g12', 'fl-g13'
    ]
  },
  {
    key: 'effect',
    label: '特效',
    root: '视频特效',
    /* 左栏就是特效分组树的 10 组（materials.js 的 EFFECT_GROUPS 顺序一一对应） */
    nodes: [
      'ef-g0', 'ef-g1', 'ef-g2', 'ef-g3', 'ef-g4',
      'ef-g5', 'ef-g6', 'ef-g7', 'ef-g8', 'ef-g9'
    ]
  }
]

/** 中栏退化成空壳时的那句文案 —— 点到了就是"这个入口没接" */
const SHELL_TEXT = '左侧选一个功能开始'
/** 刻意占位面板的文案（只有 `record` 有） */
const NOTICE_TEXT = '尚未接入'

/* ---------------------------------------------------------------- 断言账 */

let pass = 0
let fail = 0
let skip = 0
const failures = []
let emitted = 0
/** 非空 = 中途抛异常。summary 靠它兜底判失败，防"断言槽位满了挤不进 fail"的空洞绿。
    必须在模块作用域：summary() 是独立函数，main() 里的局部量它看不见
    （第一版就栽在这 —— summary 打印时 ReferenceError，把一份真实的失败报告打成了崩溃）。 */
let aborted = null
/** main() 之外抛出的异常（连 main 的 try 都没进）。 */
let abortedTop = null

/** 时间线工具栏那一簇：6 个按钮存在性 → 现在 5 个（AI 工具随 AI 生成一起移除） */
const E_PROBES = 5
/** 1(stock 落点) + 1(静音) + 1(还原) + 1(全屏) + 1(退出全屏) + 1(字幕) + 1(设置) + 1(设置关干净) */
const E_EFFECTS = 8
const E_ASSERTIONS = E_PROBES + E_EFFECTS
/** 面板内子标签：1(数量) + 4(逐个点) + 1(内容互不相同) */
const D2_ASSERTIONS = 1 + 4 + 1
const TOTAL_ASSERTIONS =
  1 +
  HOME_NAV.length +
  TABS.length * 3 +
  TABS.reduce((n, t) => n + t.nodes.length, 0) * 2 +
  TABS.length * 2 +
  D2_ASSERTIONS +
  1 +
  E_ASSERTIONS +
  2

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

function rmrf(target, { attempts = 8, waitMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      /* 按存在性判定，下面重试兜底 */
    }
    if (!fs.existsSync(target)) return true
    if (i < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
  }
  return !fs.existsSync(target)
}

/** 先礼后兵：app.close() 超时不算失败（Windows 上无边框窗口关不干净的已知属性） */
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
      // 必须给上界：execFileSync 是同步的，taskkill 万一卡住就把整个进程吊死
      timeout: 5000
    })
  } catch {
    /* 已经退了 */
  }
  await sleep(500)
}

/**
 * 看门狗。verify.mjs 用 spawnSync 跑闸门且不传 timeout，一挂就整个套件永久卡死，
 * 且不产出任何可读信息 —— 宁可由这里主动判失败。
 */
const WATCHDOG_MS = Number(process.env.TABS_E2E_TIMEOUT_MS || 8 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

async function launch() {
  const app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForSelector('.home', { timeout: 30000 })
  return { app, page }
}

async function resize(app, page, [w, h]) {
  await app
    .evaluate(async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(size[0], size[1])
      win.center()
    }, [w, h])
    .catch(() => {})
  await sleep(500)
}

/** 中栏当前是不是"有东西"：有 .wb-media 容器、而且里面不是空壳文案 */
async function centerState(page) {
  return page.evaluate((shellText) => {
    const pane = document.querySelector('.wb-media')
    if (!pane) return { exists: false, text: '', shell: false, notice: false }
    const text = (pane.innerText || '').trim()
    /* 「背景」这类参考页是**纯图无文字**的（titleTextVisible:false，页面上一行字都没有），
       不能拿"text 为空"当空壳判据 —— 还要看有没有真的卡片/图片在渲染。 */
    const visuals = pane.querySelectorAll('img, .enh-card, .look-card, .style-card').length
    return {
      exists: true,
      text,
      shell: (text.includes(shellText) || (text.length === 0 && visuals === 0)),
      notice: text.includes('尚未接入')
    }
  }, SHELL_TEXT)
}

/**
 * 关闭可能被点开的弹层（AI 面板 / 设置弹窗）。
 *
 * ⚠️ 两类弹层的关闭方式**不一样**，第一版只按 Esc，于是 AI 面板没关掉：
 *   · 纯遮罩型弹层（`.mask`）—— `App.jsx` 的 onClick 判 `e.target === e.currentTarget`，
 *     也就是**点遮罩空白处**才关，Esc 对它无效；
 *   · 设置等 `[role=dialog]` —— 走 Esc。
 * 遮罩没关掉时，下一次点击会被 `.mask` 拦下，报出来的是
 * 「locator.click: Timeout ... <div class="mask"> intercepts pointer events」——
 * 完全看不出真因。所以这里点遮罩时**故意点左上角**（面板在右侧），
 * 并且把结果返回给调用方断言。
 */
async function closeOverlays(page) {
  for (let i = 0; i < 4; i += 1) {
    const maskCount = await page.locator('.mask').count()
    const dialogCount = await page.locator('[role="dialog"], .dialog').count()
    if (!maskCount && !dialogCount) break

    if (dialogCount) {
      await page.keyboard.press('Escape')
      await sleep(200)
    }
    if (await page.locator('.mask').count()) {
      await page
        .locator('.mask')
        .first()
        .click({ position: { x: 5, y: 5 }, timeout: 3000 })
        .catch(() => {})
      await sleep(250)
    }
  }
  return {
    mask: await page.locator('.mask').count(),
    dialog: await page.locator('[role="dialog"], .dialog').count()
  }
}

/* ------------------------------------------------------------------- 主体 */

async function main() {
  console.log('=== 工作台全量标签点击 E2E（真实 Electron + 真实点击）===\n')

  if (!fs.existsSync(EXE)) {
    backfillSkips(`找不到 electron：${EXE}`)
    return
  }

  rmrf(PROFILE)
  let app = null
  let page = null
  const pageErrors = []
  const consoleErrors = []

  try {
    ;({ app, page } = await launch())
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    /* ----------------------- A. 首页四个导航项 ----------------------- */

    const navCount = await page.locator('.home-nav-item').count()
    check(
      `A1. 首页导航项共 ${HOME_NAV.length} 项（少一项就是功能被删了）`,
      navCount === HOME_NAV.length,
      `实际 ${navCount}`
    )

    /* 基线：「创作视频」是默认视图。其余三项切过去后主区**必须**和它不一样，
       否则就是"点了没反应"。这样断言不依赖具体内容，只依赖"换了没换"。 */
    const baseline = await page.locator('.home-main').innerHTML().catch(() => '')

    /** 当前哪一项是选中态（互斥性是自绘导航最常见的静默缺陷：多个同时亮） */
    const activeNav = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.home-nav-item')]
          .filter((el) => el.getAttribute('data-active') === 'true')
          .map((el) => (el.textContent || '').replace('New', '').trim())
      )

    for (const item of HOME_NAV) {
      if (item.key === 'create') continue
      await page.locator(`.home-nav-item:has-text("${item.label}")`).first().click()
      await sleep(350)
      const actives = await activeNav()
      const after = await page.locator('.home-main').innerHTML().catch(() => '')
      check(
        `A. 首页导航「${item.label}」真的换了主区内容，且选中态互斥`,
        actives.length === 1 && actives[0].includes(item.label) && after !== baseline,
        `选中=${JSON.stringify(actives)} 内容变了=${after !== baseline}`
      )
    }

    // 切回「创作视频」，既验回程，也让后面进工作台前处在已知视图上
    await page.locator('.home-nav-item:has-text("创作视频")').first().click()
    await sleep(350)
    const backActives = await activeNav()
    const backHtml = await page.locator('.home-main').innerHTML().catch(() => '')
    check(
      'A. 切回「创作视频」能回到初始视图',
      backActives.length === 1 && backActives[0].includes('创作视频') && backHtml === baseline,
      `选中=${JSON.stringify(backActives)}`
    )

    /* -------------------------- 进工作台 -------------------------- */

    await page.locator('.home-hero-video').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await resize(app, page, EDITOR_SIZE)

    /* ------------------------ B. 七个功能标签 ------------------------ */

    const tabCount = await page.locator('.wb-tab').count()
    if (tabCount !== TABS.length) {
      console.log(`  [!] 顶部功能标签实际 ${tabCount} 个，夹具写了 ${TABS.length} 个 —— 后续断言会逐条失败`)
    }

    for (const tab of TABS) {
      await page.locator(`.wb-tab[data-wb-tab="${tab.key}"]`).click()
      await sleep(300)

      const isActive = await page.evaluate(
        (key) =>
          document
            .querySelector(`.wb-tab[data-wb-tab="${key}"]`)
            ?.classList.contains('active') || false,
        tab.key
      )
      check(`B. 标签「${tab.label}」进入选中态`, isActive)

      const rootLabel = await page
        .locator('.wb-tree .wb-node.root span')
        .first()
        .textContent()
        .catch(() => '')
      check(
        `B. 标签「${tab.label}」左栏根标签 = ${tab.root}`,
        String(rootLabel || '').trim() === tab.root,
        `实际「${String(rootLabel || '').trim()}」`
      )

      /* 用 `:not(.root)` 排掉根卡片，**不要**拿夹具里的 root 文案去比 ——
         根卡片的 `data-wb-node` 是 root.key（`material` / `avatar-root` …），
         而夹具里写的是给人看的 label（`素材` / `数字人` …）。第一版就是拿 label
         去 filter，九次全红，而报出来的"多余项"其实是根卡片自己。 */
      const nodeKeys = await page.$$eval(
        '.wb-tree .wb-node[data-wb-node]:not(.root)',
        (els) => els.map((el) => el.getAttribute('data-wb-node'))
      )
      /*
       * ⚠️ 判据是「**没有表外的野节点**」，不是「表里每一项此刻都在 DOM 里」。
       *
       * 左栏是**手风琴**：同一时刻只展开一组，展开「素材库」时「素材」根的子项就收起来了。
       * 所以"表里的 N 项同时在 DOM 里"这个断言从 2026-09-25 起**永远不成立**
       * （表里现在收的是"展开不同组后可能出现的全部项"：16 项里有 5 项与 4 项是互斥的）。
       * 存在性由 C 段逐个点保证 —— 点不到的项会 `locator` 超时并记失败，
       * 比"数量对不上"更能指出问题在哪一项。
       */
      const stray = nodeKeys.filter((k) => !tab.nodes.includes(k))
      const same = nodeKeys.length > 0 && stray.length === 0
      check(
        `B. 标签「${tab.label}」左栏没有表外节点（${tab.nodes.length} 项在 C 段逐个点过）`,
        same,
        same ? '' : `实际 [${nodeKeys.join(', ')}]`
      )
    }

    /* ------------------------ C. 左栏每一项都点一遍 ------------------------ */

    for (const tab of TABS) {
      await page.locator(`.wb-tab[data-wb-tab="${tab.key}"]`).click()
      await sleep(250)

      for (const nodeKey of tab.nodes) {
        await page.locator(`.wb-tree .wb-node[data-wb-node="${nodeKey}"]`).click()
        await sleep(220)

        const isActive = await page.evaluate(
          (key) =>
            document
              .querySelector(`.wb-tree .wb-node[data-wb-node="${key}"]`)
              ?.classList.contains('active') || false,
          nodeKey
        )
        check(`C. ${tab.key}/${nodeKey} 进入选中态`, isActive)

        const state = await centerState(page)
        if (nodeKey === 'record') {
          /* 「录制」是**已知且刻意**的占位（应用内录制要放开 media 权限，需单独确认）。
             这里不放行「有字就算过」—— 要求它确实讲清楚了、而不是空白或者空壳。 */
          check(
            `C. ${tab.key}/record 是刻意的占位面板（说明了原因）`,
            state.exists && state.notice && !state.text.includes(SHELL_TEXT),
            state.notice ? '' : '没有说明文案，可能变成了空壳'
          )
        } else {
          check(
            `C. ${tab.key}/${nodeKey} 中栏有真实内容（非空壳）`,
            state.exists && !state.shell,
            state.exists ? (state.shell ? `空壳：「${state.text.slice(0, 40)}」` : `${state.text.length} 字`) : '找不到 .wb-media'
          )
        }
      }
    }

    /* ------------------ C2. 七个标签的**根卡片**也点一遍 ------------------
       根卡片（`wb-node.root`）不是装饰：点它会回落到 tree.root，中栏改成显示
       该标签下的全部素材。第一版漏了它 —— 只在 `:not(.root)` 里点叶子项。
       根卡片曾经**永远没有 active 类**（className 是写死的 `"wb-node root"`），
       于是点完左栏一处高亮都没有，用户看不出自己在哪一层。这里两条都钉住。 */
    for (const tab of TABS) {
      await page.locator(`.wb-tab[data-wb-tab="${tab.key}"]`).click()
      await sleep(250)
      await page.locator('.wb-tree .wb-node.root').click()
      await sleep(220)

      const rootActive = await page.evaluate(() =>
        document.querySelector('.wb-tree .wb-node.root')?.classList.contains('active')
      )
      check(`C2. ${tab.key} 根卡片点下去进入选中态（左栏不能一处高亮都没有）`, Boolean(rootActive))

      const state = await centerState(page)
      check(
        `C2. ${tab.key} 根卡片下中栏有真实内容（非空壳）`,
        state.exists && !state.shell,
        state.exists ? `${state.text.length} 字` : '找不到 .wb-media'
      )
    }

    /* ---------- D2. 面板**内部**的子标签也要点（素材库的四个筛选页签） ----------
       `.wb-subtabs` 全仓库只有「素材库」面板在用（全部 / 视频 / 音频 / 图片），
       而在此之前**没有任何 E2E 提过它**（全 tools 目录 grep 命中 0）。
       面板内层是最容易漏的一层：外层七个标签点了，进去之后的页签没人点。 */
    await page.locator('.wb-tab[data-wb-tab="media"]').click()
    await sleep(250)
    await page.locator('.wb-tree .wb-node[data-wb-node="stock"]').click()
    await sleep(300)

    const subtabCount = await page.locator('.wb-subtabs button').count()
    check('D2. 素材库面板里有四个筛选子标签', subtabCount === 4, `实际 ${subtabCount} 个`)

    const subtabTexts = []
    for (let i = 0; i < subtabCount; i += 1) {
      const btn = page.locator('.wb-subtabs button').nth(i)
      const label = String((await btn.textContent()) || '').trim()
      await btn.click()
      await sleep(250)
      const state = await page.evaluate(() => {
        const wrap = document.querySelector('.wb-subtabs')
        const buttons = wrap ? [...wrap.querySelectorAll('button')] : []
        const pane = document.querySelector('.wb-media')
        return {
          activeIndex: buttons.findIndex((b) => b.classList.contains('active')),
          body: (pane?.innerText || '').trim()
        }
      })
      subtabTexts.push(state.body)
      check(
        `D2. 子标签「${label}」点击后进入选中态且面板内容跟着换`,
        state.activeIndex === i,
        `选中第 ${state.activeIndex + 1} 个`
      )
    }
    check(
      'D2. 四个子标签的面板内容互不相同（不是四个按钮改同一个状态）',
      subtabTexts.length === subtabCount && new Set(subtabTexts).size === subtabTexts.length,
      subtabTexts.length === subtabCount ? `${new Set(subtabTexts).size} 种内容 / ${subtabTexts.length} 个页签` : ''
    )

    /* --------------- D. 刻意占位面板必须给出可用出路 --------------- */

    await page.locator('.wb-tab[data-wb-tab="media"]').click()
    await sleep(250)
    await page.locator('.wb-tree .wb-node[data-wb-node="record"]').click()
    await sleep(300)
    const recordHasImport = await page.evaluate(() => {
      const pane = document.querySelector('.wb-media')
      if (!pane) return false
      const buttons = [...pane.querySelectorAll('button')]
      return buttons.some((b) => {
        const label = (b.textContent || '').trim()
        return label.includes('导入') || (b.getAttribute('title') || '').includes('导入')
      })
    })
    check('D. 「录制」占位面板里有一个真能用的导入入口（不是干说"没做"）', recordHasImport)

    /* -------------------- E. 时间线工具栏那一簇 -------------------- */

    // 这几个按钮改前是死的/接错的，逐个验它们**真的产生了对应效果**
    const tlProbe = [
      { sel: '[data-tl="stock"]', label: '素材库' },
      { sel: '[data-tl="mute"]', label: '静音' },
      { sel: '[data-tl="subtitle"]', label: '字幕' },
      { sel: '[data-tl="settings"]', label: '时间线设置' },
      { sel: '[data-tl="full"]', label: '全屏时间线' }
    ]
    for (const probe of tlProbe) {
      const exists = await page.locator(probe.sel).count()
      check(`E. 时间线工具栏「${probe.label}」存在且带 data 钩子`, exists === 1, `命中 ${exists} 个`)
    }

    // 逐个验效果（顺序：先做会开弹层的，再关掉）
    await page.locator('[data-tl="stock"]').click()
    await sleep(300)
    /* 断言只盯「切到了 媒体文件 标签、左栏选中的是 素材库」——
       `stock` 是**节点**不是标签（素材库挂在「媒体文件」下），写成切标签会在
       左栏留下一个不存在的标签名，表现为"点了没反应"。
       真正要挡的是"它打开了一个导入框"（历史上这条就是这么来的）。 */
    const stockLanded = await page.evaluate(
      () =>
        Boolean(document.querySelector('.wb-tab[data-wb-tab="media"]')?.classList.contains('active')) &&
        document.querySelector('.wb-tree .wb-node.active')?.getAttribute('data-wb-node') === 'stock'
    )
    check('E. 「素材库」切到 媒体文件 标签并选中素材库节点（不是打开导入框）', Boolean(stockLanded))

    await page.locator('[data-tl="mute"]').click()
    await sleep(300)
    const mutedNow = await page.evaluate(() => {
      const vol = document.querySelector('.wb-vol')
      const btn = document.querySelector('[data-tl="mute"]')
      return { value: vol ? Number(vol.value) : null, pressed: btn?.getAttribute('aria-pressed') === 'true' }
    })
    check('E.「静音」把音量打到 0 且按钮进入按下态', mutedNow.value === 0 && mutedNow.pressed, JSON.stringify(mutedNow))
    await page.locator('[data-tl="mute"]').click()
    await sleep(300)
    const unmuted = await page.evaluate(() => {
      const vol = document.querySelector('.wb-vol')
      return vol ? Number(vol.value) : null
    })
    check('E. 再点一次能还原到静音前的音量（不是跳到 100 或卡在 0）', unmuted === 100, `还原到 ${unmuted}`)

    await page.locator('[data-tl="full"]').click()
    await sleep(300)
    const fullState = await page.evaluate(() => {
      const el = document.querySelector('.wb-timeline')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { flag: el.getAttribute('data-tl-full'), pos: cs.position, w: Math.round(el.getBoundingClientRect().width) }
    })
    check(
      'E.「全屏时间线」真的铺开（fixed 覆盖层）',
      Boolean(fullState && fullState.flag === '1' && fullState.pos === 'fixed'),
      JSON.stringify(fullState)
    )

    await page.locator('[data-tl="full"]').click()
    await sleep(300)
    const backToNormal = await page.evaluate(
      () => document.querySelector('.wb-timeline')?.getAttribute('data-tl-full')
    )
    check('E. 全屏时间线可以退回来', backToNormal === '0', `flag=${backToNormal}`)

    await page.locator('[data-tl="subtitle"]').click()
    await sleep(300)
    const subLanded = await page.evaluate(() =>
      document.querySelector('.wb-tab[data-wb-tab="subtitle"]')?.classList.contains('active')
    )
    check('E.「字幕」切到字幕标签', Boolean(subLanded))

    await page.locator('[data-tl="settings"]').click()
    await sleep(400)
    const settingsOpened = await page.evaluate(
      () => Boolean(document.querySelector('[role="dialog"], .dialog, .mask'))
    )
    check('E.「时间线设置」真的打开了设置', settingsOpened)

    const afterSettings = await closeOverlays(page)
    check(
      'E. 设置弹窗能关干净（Esc / 遮罩两条路都试过）',
      afterSettings.mask === 0 && afterSettings.dialog === 0,
      `mask=${afterSettings.mask} dialog=${afterSettings.dialog}`
    )

    /* --------------------------- F. 无异常 --------------------------- */

    check(
      'F. 全流程 0 个未捕获 JS 异常',
      pageErrors.length === 0,
      pageErrors.length ? pageErrors.slice(0, 2).join(' | ') : ''
    )
    if (consoleErrors.length) {
      console.log(`  [i] 控制台 error ${consoleErrors.length} 条（不计入断言，仅提示）：`)
      for (const line of consoleErrors.slice(0, 3)) console.log(`      ${line.slice(0, 160)}`)
    }

    check(`F2. 全流程跑到底（${TABS.length} 个标签 + 左栏全部项全部点过）`, true)
  } catch (error) {
    /* ⚠️ 不能只补 SKIP。只补 SKIP 的话，"跑到一半炸了"会变成「失败 0 / 跳过 105」→ 判通过，
       也就是**空洞绿**：脚本本身坏了、被点坏了、选择器写错了，全都表现为绿。
       （「找不到 electron」那种前置缺失才是合法的纯 SKIP，见 main 开头。）
       这里用两重保险：补一条 fail，并且立 `aborted` 旗标 —— 就算断言槽位已经用满、
       连这条 fail 都挤不进去，summary 也照样判失败。 */
    console.error(`\n[!] 执行中断：${error && error.message}`)
    aborted = error
    if (emitted < TOTAL_ASSERTIONS) {
      check('F2. 全流程跑到底（没有中途抛异常）', false, error && error.message)
    }
    backfillSkips(`中断：${error && error.message}`)
  } finally {
    /* ⚠️ 收尾**只关 Electron，不删 profile**。
       Windows 上对「刚被 Electron 攥过」的目录做同步 `fs.rmSync(recursive)` 会
       **永久阻塞而不是抛 EBUSY** —— 主线程连同定时器一起停摆，
       verify.mjs 的 spawnSync 于是永久等待（本文件第一版就这么卡了 4 分钟，
       三次运行留下三个 `.tabs-profile-*` 目录，而当时其实已经没有任何 electron 进程）。
       残留目录在 `_recon/` 下、已被 .gitignore 忽略，可以重建；
       profile 目录名带 pid，一轮一份，残留也不会污染下一轮。
       （起手处那次 `rmrf(PROFILE)` 是安全的：那时还没有任何进程打开它。） */
    await shutdown(app)
  }
  summary()
}

function summary() {
  clearTimeout(watchdog)
  const bad = fail > 0 || Boolean(aborted) || Boolean(abortedTop)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`TABS_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (aborted || abortedTop) console.log(`执行中断：${(aborted || abortedTop).message}`)
  if (bad) {
    console.log('失败项：' + failures.join(' | '))
    console.log('TABS_E2E_FAILED')
  } else {
    console.log('TABS_E2E_OK')
  }
  const code = bad ? 1 : 0
  process.exitCode = code
  // 必须显式退出：playwright 连接与被强杀子进程留下的管道会让事件循环常驻，
  // 只设 exitCode 会让 verify.mjs 的 spawnSync 永久等待（"绿了但卡住"）。
  process.stdout.write('', () => process.exit(code))
  setTimeout(() => process.exit(code), 1000).unref()
}

main().catch((error) => {
  console.error(error)
  abortedTop = error
  backfillSkips(`顶层异常：${error && error.message}`)
  summary()
  process.exit(1)
})
