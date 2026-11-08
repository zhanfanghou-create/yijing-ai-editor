#!/usr/bin/env node
/**
 * 客户端 E2E · 左栏「字幕 → 字幕预设」（857 款口播动态排版）。
 *
 * 为什么必须单独立这一道：
 *   这一页的价值全在"点一张卡之后时间线上真的多出 N 条、而且位置/动效/多行都对"。
 *   静态闸门（check-workbench-tree / check-imports）只能证明入口接上了、
 *   自检（subtitle-preset-selftest）只能证明 planPreset 这个纯函数算得对 ——
 *   它们都证明不了下面四件**只在真机成立**的事：
 *
 *     ① 左栏那一项真的打开了这一页（而不是又一屏"点了没反应"）；
 *     ② 卡片的底图是**软件自己的字幕底片**，不是素材包里那些黑底占位图；
 *     ③ 点下去之后，片段上挂的是 `textStyle/textAnchor/textIn` 这些**消费端真读的键**
 *        （写成 `style/anchor/in` 也能存进草稿，界面不报错，只是落点还在底部）；
 *     ④ 多行预设产出的是**一条**带换行的字幕，而不是三条一字一拍的片段。
 *
 * 期望值一律在本脚本里独立写死（60 张 / 7 个分类 / 10 张 / 3 条 / 三行），
 * 不从 shared/subtitlePresets.js import —— 从被测代码取期望等于让它自己出考卷。
 *
 * 用法：node tools/subtitle-preset-e2e.mjs
 * 前置：`cd packages/desktop && vite build`（E2E 读的是 dist-renderer）
 * 退出码：0 = 通过；1 = 有失败
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.subtitle-preset-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/* ── 独立写死的期望值（不从被测代码取） ─────────────────────────── */
/** 面板首次渲染的卡片上限：857 张一次全挂会让面板卡成 PPT */
const FIRST_PAGE = 60
/** 点一次「再显示」追加的张数 */
const MORE_STEP = 120
/** 分类条 = 全部 + 六组 */
const GROUP_TABS = 7
/** 「精选十款」这一组按名字就是 10 款 */
const PICKED_GROUP = 10
/** 「举例3点」是**一屏三行**：一条片段、正文里两处换行 */
const THREE_POINT_LINES = 3
/** 「三字叠加」是**三条叠着出现**：三块、每块一个字 */
const STACK_CHUNKS = 3

const ASSETS = [{ id: 'a_v1', kind: 'video', name: '底片', url: '' }]
const CLIPS = [
  {
    id: 'c_video',
    track: 'video',
    assetId: 'a_v1',
    name: '底片',
    kind: 'video',
    start: 0,
    duration: 12,
    offset: 0,
    sourceDuration: 12
  }
]

/** 正常路径上的断言条数（前置两条只在缺 electron / 缺构建产物时才触发，那时会提前中断） */
const TOTAL_ASSERTIONS = 23

let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`SUBTITLE_PRESET_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('SUBTITLE_PRESET_E2E_OK')
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

async function main() {
  console.log('=== 字幕预设 E2E（真启窗口 + 真点击 + 真落片段）===\n')

  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, EXE)
    aborted = 'electron 不存在'
    return summary()
  }
  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 构建产物存在', false, 'dist-renderer/index.html 缺失 —— 先构建渲染层')
    aborted = '构建产物缺失'
    return summary()
  }
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* 删不掉就带着旧 profile 启动 */
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

    /* ---- 夹具：一条 12 秒视频、没有字幕 ---- */
    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 字幕预设', data: { clips: CLIPS, assets: ASSETS, playhead: 0, volume: 80, zoom: 1 } }
    )
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(600)
    await resize()
    await sleep(300)

    const textClips = () => page.locator('[data-lane="text"] .clip[data-clip]')
    check('夹具 · 字幕轨一开始是空的', (await textClips().count()) === 0, `实测 ${await textClips().count()}`)

    const cards = () => page.locator('[data-sp-preset]')

    /* ================= 进入「字幕 → 字幕预设」 ================= */
    await page.locator('.wb-tab[data-wb-tab="subtitle"]').click()
    await sleep(300)
    await page.locator('.wb-tree .wb-node[data-wb-node="sub-preset"]').click()
    await sleep(700)

    check('字幕预设 · 左栏点进去真的出现分类条（不是"点了没反应"）', (await page.locator('[data-sp-tabs]').count()) === 1)

    const tabs = await page.locator('[data-sp-group]').count()
    check(`字幕预设 · 分类条 = ${GROUP_TABS} 个（全部 + 六组）`, tabs === GROUP_TABS, `实测 ${tabs} 个`)

    const firstPage = await cards().count()
    check(
      `字幕预设 · 首屏渲染 ${FIRST_PAGE} 张（857 张一次全挂会让面板卡死）`,
      firstPage === FIRST_PAGE,
      `实测 ${firstPage} 张`
    )

    /* 反向断言：不能退化成「字幕模板」那一页（共用面板 = 这个入口不存在） */
    check(
      '字幕预设 · 没有退化成「字幕模板」的样式网格',
      (await page.locator('[data-style-grid="subtitle"]').count()) === 0
    )

    /* 卡面底图必须是软件自己的字幕底片（plate.webp，与「字幕模板」同一张）。
       读 computed 而不是读 class —— 换了底图但 class 没换，只有这里看得出来。 */
    const plateOf = async () =>
      page
        .locator('[data-sp-preset] .style-art')
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundImage)
        .catch(() => '')
    const plate = await plateOf()
    check('字幕预设 · 卡面用的是软件自己的字幕底片（plate.webp）', /plate[\w.-]*\.webp/.test(plate), String(plate).slice(0, 120))

    /* ================= 分类切换 ================= */
    await page.locator('[data-sp-group="picked"]').click()
    await sleep(400)
    const pickedCount = await cards().count()
    check(
      `字幕预设 · 「精选十款」这一组正好 ${PICKED_GROUP} 张`,
      pickedCount === PICKED_GROUP,
      `实测 ${pickedCount} 张`
    )

    await page.locator('[data-sp-group="all"]').click()
    await sleep(400)
    check('字幕预设 · 切回「全部」又回到首屏张数（limit 跟着重置）', (await cards().count()) === FIRST_PAGE)

    /* ================= 加载更多 ================= */
    await page.locator('[data-sp-more]').click()
    await sleep(400)
    const moreCount = await cards().count()
    check(
      `字幕预设 · 点「再显示」追加 ${MORE_STEP} 张`,
      moreCount === FIRST_PAGE + MORE_STEP,
      `实测 ${moreCount} 张`
    )

    /* ================= 悬停才播动画 ================= */
    const firstCard = cards().first()
    await firstCard.hover()
    await sleep(200)
    const playing = await firstCard.getAttribute('data-sp-play')
    const hasAnimClass = await firstCard
      .locator('.wb-sp-line')
      .first()
      .evaluate((node) => /ta-in-/.test(node.className))
      .catch(() => false)
    check('字幕预设 · 悬停那一次真的播入场动画（data-sp-play + ta-in-* 类）', playing === '1' && hasAnimClass, `play=${playing} class=${hasAnimClass}`)

    /* ================= 多行预设：举例3点 → 一条三行 ================= */
    const threePoint = page.locator('[data-sp-preset][title^="举例3点"]').first()
    const hasThreePoint = (await threePoint.count()) === 1
    check('字幕预设 · 找得到「举例3点」这张卡（名字就是清单里的名字）', hasThreePoint)

    await threePoint.click()
    await sleep(700)

    const afterRow = await textClips().count()
    check(
      `字幕预设 · 「举例3点」只加 ${1} 条字幕（三点是一屏里的三行，不是三条片段）`,
      afterRow === 1,
      `实测 ${afterRow} 条`
    )

    const rowClip = textClips().first()
    const rowText = await rowClip.getAttribute('data-clip-text')
    const rowStyle = await rowClip.getAttribute('data-clip-style')
    const rowAnchor = await rowClip.getAttribute('data-clip-anchor')
    check(
      `字幕预设 · 正文里是 ${THREE_POINT_LINES} 行（换行真的写进了片段）`,
      String(rowText).split('\n').length === THREE_POINT_LINES,
      JSON.stringify(rowText)
    )
    check('字幕预设 · 样式真的写到片段上（读 data-clip-style，不是读 state）', Boolean(rowStyle), String(rowStyle))
    check('字幕预设 · 落点真的写到片段上（「举例3点」应当居中）', rowAnchor === 'center', String(rowAnchor))

    /* 消费端：预览叠加层里那个文字元素真的带换行（用户看到的是它） */
    const overlayText = await page
      .locator('.canvas-overlays [data-overlay-text]')
      .first()
      .innerText()
      .catch(() => '')
    check(
      '字幕预设 · 预览叠加层里的字也是三行（消费端与片段一致）',
      String(overlayText).split('\n').filter((s) => s.trim()).length === THREE_POINT_LINES,
      JSON.stringify(String(overlayText).slice(0, 40))
    )

    /* ================= 多条叠加：三字叠加 → 三条 ================= */
    const stackCard = page.locator('[data-sp-preset][title^="三字叠加"]').first()
    check('字幕预设 · 找得到「三字叠加」这张卡', (await stackCard.count()) === 1)
    await stackCard.click()
    await sleep(700)

    const afterStack = await textClips().count()
    check(
      `字幕预设 · 「三字叠加」加 ${STACK_CHUNKS} 条（一屏一个字往外蹦）`,
      afterStack === 1 + STACK_CHUNKS,
      `实测 ${afterStack} 条`
    )

    const stackTexts = await page.locator('[data-lane="text"] .clip[data-clip]').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-clip-text') || '')
    )
    const chars = stackTexts.slice(1)
    check(
      '字幕预设 · 三条的正文互不相同（逐字，而不是同一句复制三遍）',
      chars.length === STACK_CHUNKS && new Set(chars).size === STACK_CHUNKS,
      JSON.stringify(chars)
    )

    const starts = await page.locator('[data-lane="text"] .clip[data-clip]').evaluateAll((nodes) =>
      nodes.map((n) => Number(n.getAttribute('data-clip-start') || 0))
    )
    const stackStarts = starts.slice(1)
    check(
      '字幕预设 · 三条的起点严格递增（错峰没生效 ⇒ 三条全叠在同一秒）',
      stackStarts.length === STACK_CHUNKS && stackStarts.every((s, i) => i === 0 || s > stackStarts[i - 1]),
      stackStarts.join(' / ')
    )
    check(
      '字幕预设 · 新加的三条接在已有字幕后面（没有把「举例3点」盖掉）',
      stackStarts.length === STACK_CHUNKS && stackStarts[0] >= starts[0],
      `首条 ${starts[0]} → 新条 ${stackStarts[0]}`
    )

    if (pageErrors.length) {
      check('全程无页面错误', false, pageErrors.slice(0, 3).join(' | '))
    } else {
      check('全程无页面错误', true)
    }
  } catch (error) {
    check('流程 · 未中途抛异常', false, error.message)
    aborted = error.message
  } finally {
    await closeApp(app)
  }

  summary()
  process.exit(failures === 0 && !aborted ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
