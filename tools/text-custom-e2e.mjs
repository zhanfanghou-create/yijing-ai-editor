#!/usr/bin/env node
/**
 * 客户端 E2E · 左栏「文字 → 自定义」与「字幕 → 手写字幕」。
 *
 * 为什么必须单独立这一道：
 *   这两项此前都映射到 `panel: 'text'`（与「创建文字」「新建字幕」同一个面板），
 *   点下去中栏一字未变 —— 用户的原话是"点击没有效果"。
 *   这类缺陷**任何静态闸门都看不见**：panel 名合法、面板有内容、页面不报错，
 *   tools/check-workbench-tree.mjs 只验数据表结构，workbench-tabs-e2e 只验
 *   "点进去不是空壳"。两个入口共用同一个面板恰好能满足全部这些条件。
 *
 * 所以判据必须读到**动作的结果**：
 *   · 自定义：输入框里敲的字，真的变成时间线上一条文本片段（`data-clip-text`）；
 *   · 手写字幕：点一款字体，真的写到片段的 `data-clip-font` 上，且**不新增**片段
 *     （播放头处已有字幕时应当改它，而不是又堆一条）。
 *
 * 期望值全部在本脚本里独立写死，不从被测代码 import —— 从被测代码取期望
 * 等于让被测代码自己出考卷（删掉这个入口它也会跟着"通过"）。
 *
 * 用法：node tools/text-custom-e2e.mjs
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
/** 一轮一份独有 profile（固定目录名在异常退出后删不掉，会带着上一轮状态启动） */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.text-custom-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/** 手写面板应该给出的**系统**字体族数（楷体 / 华文楷体 / 华文行楷 / 仿宋） */
const HAND_SYSTEM_FONTS = 4
/** 第一张卡是楷体，家族名写死：读了被测代码就从"验证"变成了"复述" */
const FIRST_HAND_FONT = 'KaiTi'

const ASSETS = [{ id: 'a_v1', kind: 'video', name: '底片', url: '' }]
const CLIPS = [
  {
    id: 'c_video',
    track: 'video',
    assetId: 'a_v1',
    name: '底片',
    kind: 'video',
    start: 0,
    duration: 8,
    offset: 0,
    sourceDuration: 8
  }
]

const TOTAL_ASSERTIONS = 18

let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`TEXT_CUSTOM_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('TEXT_CUSTOM_E2E_OK')
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
  console.log('=== 文字自定义 / 手写字幕 E2E（真点击 + 真落片段）===\n')

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

    /* ---- 夹具：一条 8 秒视频、没有字幕 ---- */
    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 自定义文字', data: { clips: CLIPS, assets: ASSETS, playhead: 0, volume: 80, zoom: 1 } }
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

    /* ================= 文字 → 自定义 ================= */
    await page.locator('.wb-tab[data-wb-tab="text"]').click()
    await sleep(300)
    await page.locator('.wb-tree .wb-node[data-wb-node="text-custom"]').click()
    await sleep(400)

    check(
      '文字/自定义 · 面板里有输入框（不是样式卡那页）',
      (await page.locator('[data-text-custom-input]').count()) === 1
    )
    /* 关键反向断言：不能退化成「创建文字」那一页。两者共用面板时，
       输入框根本不存在 —— 这一条会当场红，而且不给"有内容就算过"留缝。 */
    check(
      '文字/自定义 · 没有退化成「创建文字」的样式网格',
      (await page.locator('[data-style-grid="text"]').count()) === 0
    )

    const placeholder = await page.locator('[data-text-custom-preview]').innerText()
    check('文字/自定义 · 预览框不是空的（空框会让人以为这一页没东西）', placeholder.trim().length > 0, placeholder.trim())

    const MY_TEXT = '自定义文字测试'
    await page.locator('[data-text-custom-input]').fill(MY_TEXT)
    await sleep(250)
    const previewText = await page.locator('[data-text-custom-preview]').innerText()
    check('文字/自定义 · 敲进去的字立刻出现在预览里', previewText.includes(MY_TEXT), previewText.trim())

    await page.locator('[data-text-custom-add]').click()
    await sleep(700)

    const afterAdd = await textClips().count()
    check('文字/自定义 · 点「加到字幕轨」后字幕轨多了一段', afterAdd === 1, `实测 ${afterAdd}`)
    const clipText = afterAdd ? await textClips().first().getAttribute('data-clip-text') : ''
    check('文字/自定义 · 片段正文就是敲进去的那句', clipText === MY_TEXT, String(clipText))

    /* ================= 字幕 → 手写字幕 ================= */
    await page.locator('.wb-tab[data-wb-tab="subtitle"]').click()
    await sleep(300)
    await page.locator('.wb-tree .wb-node[data-wb-node="sub-hand"]').click()
    await sleep(400)

    const cards = await page.locator('[data-hand-font]').count()
    check(
      `字幕/手写字幕 · 列出 ${HAND_SYSTEM_FONTS} 款系统手写体（不是「新建字幕」那页）`,
      cards >= HAND_SYSTEM_FONTS,
      `实测 ${cards} 张`
    )
    check(
      '字幕/手写字幕 · 没有退化成「新建字幕」的样式网格',
      (await page.locator('[data-style-grid="text"]').count()) === 0
    )

    const beforeFont = await textClips().count()
    await page.locator('[data-hand-font="kai"]').click()
    await sleep(700)

    const afterFont = await textClips().count()
    check(
      '字幕/手写字幕 · 点字体不新增片段（该改的是播放头处那条）',
      afterFont === beforeFont,
      `点击前 ${beforeFont} 条 / 点击后 ${afterFont} 条`
    )

    const fontOfClip = afterFont ? await textClips().first().getAttribute('data-clip-font') : ''
    check('字幕/手写字幕 · 字体真的写到片段上（预览与导出都读它）', fontOfClip === FIRST_HAND_FONT, String(fontOfClip))

    /* 判据读到**消费端**：预览里那个文字元素是不是真的换成了这个家族。
       只验 data-clip-font 等于"读 state"，而用户看到的是叠加层里的字。 */
    const previewFont = await page
      .locator('.canvas-overlays [data-overlay-text]')
      .first()
      .evaluate((node) => getComputedStyle(node).fontFamily)
      .catch(() => '')
    check(
      '字幕/手写字幕 · 预览里那个字真的换成了手写体（computed font-family）',
      previewFont.includes(FIRST_HAND_FONT),
      String(previewFont)
    )

    const textAfter = afterFont ? await textClips().first().getAttribute('data-clip-text') : ''
    check('字幕/手写字幕 · 只换字体，没把正文改掉', textAfter === MY_TEXT, String(textAfter))

    /* 再点第二款：证明"换字体"这条通路是反复可用的，不是只第一次生效 */
    const secondKey = await page.locator('[data-hand-font]').nth(1).getAttribute('data-hand-font')
    await page.locator(`[data-hand-font="${secondKey}"]`).click()
    await sleep(600)
    const font2 = await textClips().first().getAttribute('data-clip-font')
    check('字幕/手写字幕 · 换第二款字体也生效', Boolean(font2) && font2 !== fontOfClip, `${fontOfClip} → ${font2}`)

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
