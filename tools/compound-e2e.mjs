#!/usr/bin/env node
/**
 * 客户端 E2E · 复合片段（Ctrl 多选 → 右键合成 → 预览/时间线/解除）。
 *
 * 为什么纯函数闸门（check-compound）不够：那一套证明的是"算术对、成片对"，
 * 而**界面到算术之间**还有三根线，断任何一根都表现为"点下去了，什么都没发生"：
 *   ① Ctrl + 点选没有真的进多选集合（右键菜单只合成一段）；
 *   ② 合成之后预览没展开（时间线上变成一个片段，画面直接黑掉 —— 最像"功能坏了"）；
 *   ③ 预览里点画面选中的是**内部子片段**，而模型里没有那个 id（右栏空、选框不出现）。
 *
 * 判据一律取消费端：时间线的片段数与角标、预览主画面层的 `data-layer` 是不是
 * `父id~子id`（展开真的接进了合成）、选中态落在哪个片段上。
 *
 * 用法：node tools/compound-e2e.mjs
 * 前置：`cd packages/desktop && vite build`（跑的是 dist-renderer 构建产物）
 * 退出码：0 = 通过；1 = 有失败
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.compound-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/**
 * 夹具：视频轨上两段（用文字素材 → 不依赖真实媒体也能画出画面层），
 * 外加音频轨一段（用来证明复合只吃选中的那几段，别的片段原地不动）。
 */
const ASSETS = [
  { id: 'a_t1', kind: 'text', name: '文字甲', text: '复合片段甲', url: '' },
  { id: 'a_t2', kind: 'text', name: '文字乙', text: '复合片段乙', url: '' },
  { id: 'a_au', kind: 'audio', name: '音频丙', url: 'm://compound-gate-nonexistent.mp3' }
]

const CLIPS = [
  { id: 'c_one', track: 'video', assetId: 'a_t1', name: '片段甲', kind: 'text', start: 0, duration: 2, offset: 0, sourceDuration: 2 },
  { id: 'c_two', track: 'video', assetId: 'a_t2', name: '片段乙', kind: 'text', start: 2, duration: 2, offset: 0, sourceDuration: 2 },
  { id: 'c_audio', track: 'audio', assetId: 'a_au', name: '片段丙', kind: 'audio', start: 0, duration: 4, offset: 0, sourceDuration: 4 }
]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 15

let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`COMPOUND_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('COMPOUND_E2E_OK')
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
  console.log('=== 复合片段 E2E（真启 Electron + 真 Ctrl 点选 + 真右键合成）===\n')

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

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 复合片段', data: { clips: CLIPS, assets: ASSETS, playhead: 1, volume: 80, zoom: 1 } }
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
    await sleep(400)

    const clipCount = () => page.locator('.clip[data-clip]').count()
    check('夹具 · 时间线上有 3 个片段', (await clipCount()) === 3, `实测 ${await clipCount()}`)

    /* ---- Ctrl + 点选：多选集真的进了 App 的 selection ---- */
    await page.locator('.clip[data-clip="c_one"]').click()
    await sleep(200)
    await page.locator('.clip[data-clip="c_two"]').click({ modifiers: ['Control'] })
    await sleep(300)
    const multiCount = await page.locator('.clip.multi').count()
    const selectedCount = await page.locator('.clip.selected').count()
    check(
      'Ctrl + 点选 · 第二段进多选（主选中仍在第一段）',
      multiCount === 1 && selectedCount === 1,
      `multi=${multiCount} selected=${selectedCount}`
    )
    const ctrlDragSafe = await page.evaluate(() => {
      const el = document.querySelector('.clip[data-clip="c_two"]')
      return el ? el.style.left : ''
    })
    check('Ctrl + 点选不起拖动（第二段仍在 2 秒处）', /^([\d.]+)px$/.test(ctrlDragSafe) && Number(parseFloat(ctrlDragSafe)) > 30, ctrlDragSafe)

    /* ---- 右键菜单：真的按"选中的两段"来合成 ---- */
    await page.locator('.clip[data-clip="c_two"]').click({ button: 'right' })
    await sleep(400)
    const compoundItem = page.locator('.wb-ctxmenu button[data-ctx="compound"]')
    const itemText = (await compoundItem.textContent()) || ''
    check('右键菜单 · 「新建复合片段（2 段）」按多选集算段数', itemText.includes('2 段'), itemText.trim())
    await compoundItem.click()
    await sleep(700)

    check('合成后 · 时间线只剩 2 个片段（复合 + 音频）', (await clipCount()) === 2, `实测 ${await clipCount()}`)
    const compoundClip = page.locator('.clip.is-compound')
    check('合成后 · 那个片段被标成复合片段', (await compoundClip.count()) === 1)
    const badge = await page.locator('.clip-badge[data-clip-compound]').first().getAttribute('data-clip-compound')
    check('合成后 · 角标写着内部 2 段', badge === '2', String(badge))
    check('合成后 · 复合片段是当前选中', (await page.locator('.clip.is-compound.selected').count()) === 1)

    /* ---- 预览：复合片段被展开成内部片段（这条最能抓住"合成之后黑屏"） ---- */
    const mainLayer = await page.evaluate(() => {
      const node = document.querySelector('.canvas-layer[data-layer-role="main"]')
      return node ? node.getAttribute('data-layer') : ''
    })
    check(
      '预览 · 主画面层是内部子片段（id 形如 父~子）',
      mainLayer.includes('~'),
      mainLayer || '（无主层）'
    )
    const sourceTime = await page.locator('.wb-player').getAttribute('data-source-time')
    check('预览 · 主层有源时间（不是空占位卡）', Number(sourceTime) >= 0 && sourceTime !== null, String(sourceTime))

    /* ---- 预览里点画面：选中的必须是**外层**复合片段 ---- */
    await page.mouse.click(960, 380)
    await sleep(400)
    const stillSelected = await page.locator('.clip.is-compound.selected').count()
    check('预览点选 · 选中的仍是外层复合片段（不是模型里不存在的子 id）', stillSelected === 1, `selected=${stillSelected}`)

    /* ---- 解除：按当前几何还原成两段 ---- */
    await compoundClip.click({ button: 'right' })
    await sleep(400)
    const ungroupItem = page.locator('.wb-ctxmenu button[data-ctx="ungroup"]')
    check('右键菜单 · 复合片段上有「解除复合片段」', (await ungroupItem.count()) === 1)
    await ungroupItem.click()
    await sleep(700)
    check('解除后 · 时间线回到 3 个片段', (await clipCount()) === 3, `实测 ${await clipCount()}`)
    check('解除后 · 没有复合片段了', (await page.locator('.clip.is-compound').count()) === 0)
    const positions = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.clip[data-clip]'))
        .map((node) => Math.round(parseFloat(node.style.left) || 0))
        .sort((a, b) => a - b)
    )
    /* 0 / 0 / 92：第一段与音频都在 0，第二段在 2 秒（46px/s × 2 = 92px）。
       少还原一段时这里只剩两个数；位置被写成 0 时 92 会消失 —— 都会立刻红。 */
    check(
      '解除后 · 两段回到 0 与 2 秒处（几何按当前裁剪换算）',
      positions.length === 3 && positions.filter((value) => value < 6).length === 2 && Math.abs(positions[2] - 92) < 8,
      JSON.stringify(positions)
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
