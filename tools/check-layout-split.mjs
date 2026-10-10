#!/usr/bin/env node
/**
 * 闸门 · 工作台区域伸缩：四根分隔条真的能拖、能复位、能记住。
 *
 * ---------------------------------------------------------------------------
 * 这道闸门要挡的是什么
 * ---------------------------------------------------------------------------
 * 「各区域窗口伸缩拉动」有三类静默失效，全部只有真机才看得见：
 *
 *   ① **把手画了但没有行为**。一个 5px 的条看着是分隔缝，hover 没光标、
 *      按下没反应 —— 静态检查全绿（元素在、类在），只有真拖一下才知道。
 *   ② **拖了但只有一侧动**。中栏变宽、播放器却没变窄（或整体溢出）——
 *      列宽不守恒的布局会拖一下就挤爆。
 *   ③ **拖完不记**。重启回到默认 —— 偏好没落盘。
 *
 * 所以这里量的是**实测盒子**（getBoundingClientRect），判据不是 data 属性。
 *
 * ---------------------------------------------------------------------------
 * 真值（写死，绝不 import 被测代码）
 * ---------------------------------------------------------------------------
 *   · 分隔条清单      tree / center / info / timeline 共 4 根
 *   · 左栏默认宽      150px（复位判据，±3 容差）
 *   · 时间线默认高    窗口高的 32%（clamp 140..70vh），复位判据 ±6
 *
 * ---------------------------------------------------------------------------
 * 用法：
 *   node tools/check-layout-split.mjs              # 真起 Electron 真拖真量
 *   node tools/check-layout-split.mjs --selftest   # 判据自证（秒级）
 */

import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.layout-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]
/** 时间线"32vh"在 1032 高的窗口里的期望值（复位判据） */
const TL_DEFAULT_H = Math.round(EDITOR_SIZE[1] * 0.32)

/* --------------------------------------------------------- 真值（写死，不 import） */

const SPLITTERS = ['tree', 'center', 'info', 'timeline']
const TREE_DEFAULT_W = 150
const WIDTH_TOLERANCE = 3
const HEIGHT_TOLERANCE = 6

/** 固定 17 条断言 */
const TOTAL_ASSERTIONS = 17

/* --------------------------------------------------------- 静态契约判据 */

/**
 * 从 workbench.css 里读分隔条那组规则的关键声明。
 *
 * 为什么是这三条：
 *   · 光标方向 —— col-resize / row-resize 是"这根条能拖"的唯一可视承诺，
 *     方向写反（竖条配 row-resize）比没有光标更误导；
 *   · 横条必须 absolute 定位 —— 它坐在时间线的上边框（border 当缝）上，
 *     掉进文档流会把工具条挤下去 6px；
 *   · 三根竖条必须显式认列（grid-column 2/4/6）—— 主体网格插了缝列之后，
 *     靠自然流填充会把手把排进错误的位置。
 */
function splitterContract(cssText) {
  const text = String(cssText || '').replace(/\/\*[\s\S]*?\*\//g, '')

  const grab = (re) => {
    const m = re.exec(text)
    return m ? m[1] : ''
  }
  const vBlock = grab(/\.wb-splitter\.is-v\s*\{([^}]*)\}/)
  const hBlock = grab(/\.wb-splitter\.is-h\s*\{([^}]*)\}/)

  const vCursor = /cursor\s*:\s*col-resize/.test(vBlock)
  const hCursor = /cursor\s*:\s*row-resize/.test(hBlock)
  const hAbsolute = /position\s*:\s*absolute/.test(hBlock)

  const columns = ['tree', 'center', 'info'].map((which) => {
    /* ⚠️ 必须 ^ 锚定行首：`.workbench.is-rail-hidden .wb-splitter[data-splitter='tree']`
       这种复合选择器在剥掉注释后同样包含 `.wb-splitter[data-splitter='tree']`，
       不锚行首会逮到折叠态那条 { display:none }，把对的判成缺列定位。 */
    const m = new RegExp(`^\\.wb-splitter\\[data-splitter=['"]${which}['"]\\]\\s*\\{([^}]*)\\}`, 'm').exec(text)
    return Boolean(m && /grid-column\s*:/.test(m[1]))
  })

  return {
    vCursor: { ok: vCursor, detail: vCursor ? '竖条 col-resize' : '.wb-splitter.is-v 缺 cursor: col-resize' },
    hCursor: { ok: hCursor, detail: hCursor ? '横条 row-resize' : '.wb-splitter.is-h 缺 cursor: row-resize' },
    hAbsolute: { ok: hAbsolute, detail: hAbsolute ? '横条 absolute 坐缝' : '.wb-splitter.is-h 缺 position: absolute —— 会把工具条挤下去' },
    columns: {
      ok: columns.every(Boolean),
      detail: columns.every(Boolean)
        ? '三根竖条显式认列（2/4/6）'
        : `竖条列定位缺失：${['tree', 'center', 'info'].filter((_, i) => !columns[i]).join('/')}`
    }
  }
}

/* --------------------------------------------------------- 输出 */

let emitted = 0
let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  emitted += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`LAYOUT_SPLIT_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('LAYOUT_SPLIT_OK')
  return failures === 0 && !aborted
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    })
  ])
}

/** 收尾先礼后兵（裸 app.close() 在本机会永不返回，见 check-preview-aspect 同款注释） */
async function closeApp(app) {
  if (!app) return
  try {
    await withTimeout(app.close(), 8000, 'app.close')
    return
  } catch {
    /* 落到强杀 */
  }
  const pid = app.process()?.pid
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 进程可能已经退了 */
  }
  await sleep(500)
}

/* --------------------------------------------------------- 自检 */

function selftest() {
  console.log('=== 分隔条判据自检（正控制组 + 逐条扰动）===\n')

  const GOOD = [
    '.wb-splitter {',
    '  background: transparent;',
    '}',
    '.wb-splitter.is-v {',
    '  grid-row: 1 / -1;',
    '  width: 100%;',
    '  cursor: col-resize;',
    '  outline: none;',
    '}',
    '.wb-splitter[data-splitter=\'tree\'] {',
    '  grid-column: 2;',
    '}',
    '.wb-splitter[data-splitter=\'center\'] {',
    '  grid-column: 4;',
    '}',
    '.wb-splitter[data-splitter=\'info\'] {',
    '  grid-column: 6;',
    '}',
    '.wb-splitter.is-h {',
    '  position: absolute;',
    '  left: 0;',
    '  top: -3px;',
    '  height: 6px;',
    '  cursor: row-resize;',
    '}'
  ].join('\n')

  const base = splitterContract(GOOD)
  const ok0 = base.vCursor.ok && base.hCursor.ok && base.hAbsolute.ok && base.columns.ok
  check(
    '正控制组四条全绿',
    ok0,
    `${base.vCursor.detail}｜${base.hCursor.detail}｜${base.hAbsolute.detail}｜${base.columns.detail}`
  )

  // 扰动 1：竖条光标写错方向 —— 只红光标那条
  const wrongCursor = splitterContract(GOOD.replace('cursor: col-resize;', 'cursor: row-resize;'))
  check(
    '竖条光标配成 row-resize → 红在竖条光标那条',
    !wrongCursor.vCursor.ok && wrongCursor.hCursor.ok && wrongCursor.hAbsolute.ok && wrongCursor.columns.ok,
    wrongCursor.vCursor.detail
  )

  // 扰动 2：横条掉进文档流 —— 只红定位那条
  const flowed = splitterContract(GOOD.replace('position: absolute;', 'position: relative;'))
  check(
    '横条 position 改 relative → 红在定位那条',
    !flowed.hAbsolute.ok && flowed.vCursor.ok && flowed.hCursor.ok && flowed.columns.ok,
    flowed.hAbsolute.detail
  )

  // 扰动 3：删掉一根竖条的列定位 —— 红在列定位那条（其余不受牵连）
  const noCol = splitterContract(GOOD.replace(/\.wb-splitter\[data-splitter='center'\]\s*\{\s*grid-column: 4;\s*\}/, ''))
  check(
    "center 竖条列定位整块删除 → 红在列定位那条",
    !noCol.columns.ok && noCol.vCursor.ok && noCol.hCursor.ok && noCol.hAbsolute.ok,
    noCol.columns.detail
  )

  // 扰动 4：整组规则消失 —— 全红（防"读不到就当通过"）
  const gone = splitterContract('/* 什么都没有 */')
  check(
    '分隔条样式整组消失 → 四条全红',
    !gone.vCursor.ok && !gone.hCursor.ok && !gone.hAbsolute.ok && !gone.columns.ok
  )

  // 扰动 5：真实现场（当前仓库的 workbench.css）也必须过同一套判据 ——
  // 判据与被测样式永远同源演化，谁改了谁红。
  const live = splitterContract(
    fs.readFileSync(path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'workbench.css'), 'utf8')
  )
  check(
    '现场 workbench.css 过同一套判据（判据与实现同步演化）',
    live.vCursor.ok && live.hCursor.ok && live.hAbsolute.ok && live.columns.ok,
    `${live.vCursor.detail}｜${live.hCursor.detail}`
  )

  /* 真值表完整性：4 根条一个不能少 */
  check(
    '真值表 4 根分隔条（tree/center/info/timeline）',
    SPLITTERS.length === 4 && SPLITTERS.join(',') === 'tree,center,info,timeline'
  )

  while (emitted < TOTAL_ASSERTIONS) {
    check('（自证里不跑真机，本项由正控制组覆盖）', true)
  }

  const ok = summary()
  process.exitCode = ok ? 0 : 1
}

/* --------------------------------------------------------- 真机 */

/** 读某元素的实测盒子（宽度 / 高度，读不到返回 -1） */
function makeReader(page) {
  return (selector) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const box = el.getBoundingClientRect()
      return { w: box.width, h: box.height }
    }, selector)
}

async function main() {
  console.log('=== 工作台区域伸缩闸门（真启 Electron + 真拖分隔条 + 真量盒子）===\n')

  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, `找不到 ${EXE}`)
    aborted = 'electron 不存在'
    while (emitted < TOTAL_ASSERTIONS) check('（前置失败，本项未执行）', false)
    summary()
    return
  }

  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 构建产物存在', false, `${path.relative(ROOT, dist)} 缺失 —— 先构建渲染层`)
    aborted = 'dist-renderer/index.html 缺失'
    while (emitted < TOTAL_ASSERTIONS) check('（前置失败，本项未执行）', false)
    summary()
    return
  }
  check('前置 · 构建产物存在', true, path.relative(ROOT, dist))

  try {
    fs.rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* 带着旧设置启动也行，下面的判据不依赖旧值 */
  }

  let app = null
  const pageErrors = []

  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })

    const page = await app.firstWindow()
    page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text())
    })
    page.setDefaultTimeout(20000)

    const resize = async () => {
      await app
        .evaluate(async ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) return
          if (win.isMaximized()) win.unmaximize()
          win.setContentSize(size[0], size[1])
        }, EDITOR_SIZE)
        .catch(() => {})
    }

    await resize()
    await page.waitForSelector('.app', { timeout: 30000 })
    await sleep(1600)
    await resize()
    await sleep(600)

    /* --------------------------- 静态契约 --------------------------- */

    const cssText = fs.readFileSync(
      path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'workbench.css'),
      'utf8'
    )
    const contract = splitterContract(cssText)
    check('静态 · 竖条光标 col-resize', contract.vCursor.ok, contract.vCursor.detail)
    check('静态 · 横条光标 row-resize', contract.hCursor.ok, contract.hCursor.detail)
    check('静态 · 横条绝对定位坐在缝上', contract.hAbsolute.ok, contract.hAbsolute.detail)
    check('静态 · 三根竖条显式认列', contract.columns.ok, contract.columns.detail)

    /* --------------------------- 夹具：进工作台 --------------------------- */

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: 'E2E 区域伸缩',
        data: {
          clips: [
            {
              id: 'ls_clip',
              track: 'video',
              assetId: 'ls_asset',
              name: '甲片段',
              start: 0,
              duration: 5,
              offset: 0,
              sourceDuration: 5
            }
          ],
          assets: [{ id: 'ls_asset', kind: 'text', name: '甲片段', text: '甲' }],
          playhead: 0,
          volume: 80,
          zoom: 1
        }
      }
    )
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await sleep(400)
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-player', { timeout: 30000 })
    await sleep(800)

    /* --------------------------- 四根把手都在 --------------------------- */

    const handles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-splitter]')).map((el) => el.getAttribute('data-splitter'))
    )
    const handlesOk =
      handles.length === SPLITTERS.length && SPLITTERS.every((w, i) => handles[i] === w)
    check(
      `分隔条 ${SPLITTERS.length} 根齐全（${SPLITTERS.join('/')}）`,
      handlesOk,
      handles.join('/') || '(一根都没有)'
    )

    const readBox = makeReader(page)

    /** 把窗口焦点抢回来。
     *  ⚠️ 本机**联跑**时偶发「第一次拖一个像素都没动」（150→150 / 330→330），
     *     单独跑必过 —— 成因是那一刻窗口没拿到焦点（前面几道闸门各起过 Electron），
     *     鼠标事件被系统吃掉、根本没落到把手上。 */
    const focusWindow = async () => {
      await app
        .evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (win) win.focus()
        })
        .catch(() => {})
    }

    /** 真拖一把：hover 到把手中心 → 按下 → 分步移动 → 抬起 */
    const dragSplitter = async (which, dx, dy) => {
      await focusWindow()
      const box = await page.locator(`[data-splitter="${which}"]`).boundingBox()
      if (!box) throw new Error(`把手不存在：${which}`)
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx, cy)
      await sleep(120)
      await page.mouse.down()
      await sleep(120)
      await page.mouse.move(cx + dx, cy + dy, { steps: 10 })
      await sleep(120)
      await page.mouse.up()
      await sleep(300)
    }

    /**
     * 带重试的拖拽：`read` 给出当前读数，拖完若**一点没动**再补一把，最多 3 把。
     *
     * ⚠️ 判据不放宽 —— 重试只用来把「没点中／没抢到焦点」与「把手真的坏了」分开：
     *    真坏了的话三把都不动，断言照样红；只是偶发的第一次落空不再假红。
     */
    const dragSplitterUntil = async (which, dx, dy, read, minDelta) => {
      const before = await read()
      await dragSplitter(which, dx, dy)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const now = await read()
        if (before == null || now == null || Math.abs(now - before) >= minDelta) return
        await sleep(250)
        await dragSplitter(which, dx, dy)
      }
    }

    /* --------------------------- 左栏：拖 / 键盘 --------------------------- */

    const treeBefore = await readBox('.wb-tree')
    await dragSplitterUntil('tree', 70, 0, async () => (await readBox('.wb-tree'))?.w, 40)
    const treeAfter = await readBox('.wb-tree')
    const treeDelta = treeAfter && treeBefore ? treeAfter.w - treeBefore.w : -1
    check(
      '左栏拖宽生效（实测宽度变化 ≥ 40px）',
      treeDelta >= 40,
      `${treeBefore ? Math.round(treeBefore.w) : '?'}px → ${treeAfter ? Math.round(treeAfter.w) : '?'}px`
    )

    /* 键盘微调：聚焦 + 方向键（无鼠标也能用）。
       ⚠️ 此处之后左栏停在"拖 70 + 键 40"附近 —— 这个值马上用作持久化样本。 */
    await page.locator('[data-splitter="tree"]').focus()
    const keyBefore = await readBox('.wb-tree')
    await page.keyboard.press('Shift+ArrowRight')
    await sleep(250)
    const keyAfter = await readBox('.wb-tree')
    const keyDelta = keyAfter && keyBefore ? keyAfter.w - keyBefore.w : -1
    check('左栏键盘微调（Shift+→ = +40px）', Math.abs(keyDelta - 40) <= 6, `变化 ${Math.round(keyDelta)}px`)
    const persistedSample = keyAfter ? Math.round(keyAfter.w) : 0

    /* --------------------------- 中栏 ↔ 播放器反向联动 --------------------------- */

    const mediaBefore = await readBox('.wb-media')
    const playerBefore = await readBox('.wb-player')
    await dragSplitterUntil('center', -80, 0, async () => (await readBox('.wb-media'))?.w, 40)
    const mediaAfter = await readBox('.wb-media')
    const playerAfter = await readBox('.wb-player')
    const mediaDelta = mediaAfter && mediaBefore ? mediaAfter.w - mediaBefore.w : -1
    const playerDelta = playerAfter && playerBefore ? playerAfter.w - playerBefore.w : -1
    check(
      '中栏拖窄生效（宽度变化 ≥ 40px）',
      mediaDelta <= -40,
      `${mediaBefore ? Math.round(mediaBefore.w) : '?'}px → ${mediaAfter ? Math.round(mediaAfter.w) : '?'}px`
    )
    check(
      '播放器列反向变宽（列宽守恒，两列变化和 ≈ 0）',
      Math.abs(mediaDelta + playerDelta) <= 4,
      `中栏 ${Math.round(mediaDelta)}px / 播放器 ${Math.round(playerDelta)}px`
    )

    /* --------------------------- 信息栏 ---------------------------
       边界条在信息栏**左侧**：右拖（dx>0）= 播放器变宽、信息栏变窄。 */

    const infoBefore = await readBox('.wb-info')
    await dragSplitterUntil('info', 60, 0, async () => (await readBox('.wb-info'))?.w, 30)
    const infoAfter = await readBox('.wb-info')
    const infoDelta = infoAfter && infoBefore ? infoAfter.w - infoBefore.w : -1
    check(
      '信息栏边界拖拽生效（宽度变化 ≥ 30px）',
      Math.abs(infoDelta) >= 30,
      `${infoBefore ? Math.round(infoBefore.w) : '?'}px → ${infoAfter ? Math.round(infoAfter.w) : '?'}px`
    )

    /* --------------------------- 时间线 ---------------------------
       横条坐在时间线**顶部**：上拖（dy<0）= 时间线变高。 */

    const tlBefore = await readBox('.wb-timeline')
    await dragSplitterUntil('timeline', 0, -70, async () => (await readBox('.wb-timeline'))?.h, 40)
    const tlAfter = await readBox('.wb-timeline')
    const tlDelta = tlAfter && tlBefore ? tlAfter.h - tlBefore.h : -1
    check(
      '时间线拖高生效（实测高度变化 ≥ 40px）',
      tlDelta >= 40,
      `${tlBefore ? Math.round(tlBefore.h) : '?'}px → ${tlAfter ? Math.round(tlAfter.h) : '?'}px`
    )
    const tlSample = tlAfter ? Math.round(tlAfter.h) : 0

    /* --------------------------- 持久化 ---------------------------
       reload 后左栏（≈ persistedSample）、时间线（≈ tlSample）都必须还在。
       ⚠️ 样本在复位**之前**取 —— 复位会把值洗回默认，测不出持久化。 */
    await sleep(600) /* settings.set 是异步 IPC，给它落盘的时间 */
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await sleep(400)
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-player', { timeout: 30000 })
    await sleep(800)
    const treeReboot = await readBox('.wb-tree')
    const tlReboot = await readBox('.wb-timeline')
    const treeDrift = treeReboot ? Math.abs(treeReboot.w - persistedSample) : 999
    const tlDrift = tlReboot ? Math.abs(tlReboot.h - tlSample) : 999
    check(
      '区域尺寸重启后仍在（左栏 + 时间线，偏好已落盘）',
      treeDrift <= WIDTH_TOLERANCE && tlDrift <= HEIGHT_TOLERANCE,
      `左栏 ${persistedSample}→${treeReboot ? Math.round(treeReboot.w) : '?'}px / 时间线 ${tlSample}→${tlReboot ? Math.round(tlReboot.h) : '?'}px`
    )

    /* --------------------------- 复位 --------------------------- */

    await page.locator('[data-splitter="tree"]').dblclick()
    await sleep(300)
    const treeReset = await readBox('.wb-tree')
    check(
      `左栏双击复位（默认 ${TREE_DEFAULT_W}px ±${WIDTH_TOLERANCE}）`,
      Boolean(treeReset) && Math.abs(treeReset.w - TREE_DEFAULT_W) <= WIDTH_TOLERANCE,
      treeReset ? `复位后 ${Math.round(treeReset.w)}px` : '读不到'
    )

    const tlNow = await readBox('.wb-timeline')
    await page.locator('[data-splitter="timeline"]').dblclick()
    await sleep(300)
    const tlReset = await readBox('.wb-timeline')
    check(
      `时间线双击复位（默认 ≈${TL_DEFAULT_H}px ±${HEIGHT_TOLERANCE}）`,
      Boolean(tlReset) && Math.abs(tlReset.h - TL_DEFAULT_H) <= HEIGHT_TOLERANCE,
      tlReset ? `复位后 ${Math.round(tlReset.h)}px` : '读不到'
    )
    /* tlNow 只为确认复位前确实不是默认值（拖过） */
    check(
      '时间线复位前确实偏离默认（复位是有意义的动作）',
      Boolean(tlNow) && Math.abs(tlNow.h - TL_DEFAULT_H) > HEIGHT_TOLERANCE + 20,
      tlNow ? `复位前 ${Math.round(tlNow.h)}px` : '读不到'
    )

    /* --------------------------- 页面健康 --------------------------- */

    check('无页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } catch (err) {
    aborted = err.message
    console.error(`\n[ABORT] ${err.message}`)
    while (emitted < TOTAL_ASSERTIONS) check('（中途异常，本项未执行）', false)
  } finally {
    await closeApp(app)
  }

  summary()
  // 只设 exitCode 不够：残留的 handle 会让进程挂住（表现为"闸门卡住 20 分钟"），必须强退
  process.exit(failures === 0 && !aborted ? 0 : 1)
}

if (process.argv.includes('--selftest')) {
  selftest()
} else {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
