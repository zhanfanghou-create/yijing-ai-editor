#!/usr/bin/env node
/**
 * 客户端 E2E · 多机位（Ctrl 多选 → 右键建多机位 → 切角 → 预览换画面 → 解除）。
 *
 * 纯函数闸门（check-multicam）证明的是"算术对、成片对"；界面到算术之间还有几根线，
 * 断任何一根都表现为"点下去了，什么都没发生"：
 *   ① Ctrl 多选没进集合 ⇒ 菜单项一直是"先多选两段"（禁用）；
 *   ② 建出来的多机位在预览里没展开 ⇒ 时间线上一个方块、画面直接黑掉；
 *   ③ 点机位按钮只改面板状态、没写回片段 ⇒ 高亮变了、画面不变（本项目的第⑤类静默失效）；
 *   ④ 播放头换算漏乘倍速 ⇒ 切角落在"比按下的地方早一截"（这里用 1 倍速跑，靠 ③ 兜住）；
 *   ⑤ 解除之后时间线上片段数不对（少还原一段 / 多留一条音轨）。
 *
 * 判据全部取消费端：时间线片段数与角标、预览主画面层的 `data-layer`（展开后是
 * `父id~m<机位>_<起点>`）、检查器按钮的 `aria-pressed`。
 *
 * 用法：node tools/multicam-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.multicam-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/** 夹具：两路"机位"（同一时刻起始，方便对齐）+ 一条音频（证明别的轨不受影响） */
const ASSETS = [
  { id: 'a_cam1', kind: 'video', name: '机位一', url: 'yjai-media://local/e2e-cam-one.mp4' },
  { id: 'a_cam2', kind: 'video', name: '机位二', url: 'yjai-media://local/e2e-cam-two.mp4' },
  { id: 'a_au', kind: 'audio', name: '音频底', url: 'm://multicam-gate-nonexistent.mp3' }
]

const CLIPS = [
  { id: 'c_cam1', track: 'video', assetId: 'a_cam1', name: '机位一', kind: 'video', url: ASSETS[0].url, start: 0, duration: 2, offset: 0, sourceDuration: 4 },
  /* ⚠️ 第二路放在**叠加轨**：两路机位本来就要在同一时刻重叠，同一条轨上它们会
     叠成一张卡片 —— 界面里点不到下面那一路（E2E 会报 "intercepts pointer events"），
     真实用户也一样点不到。多机位的正常用法就是"多轨对齐后合成"。 */
  { id: 'c_cam2', track: 'overlay', assetId: 'a_cam2', name: '机位二', kind: 'video', url: ASSETS[1].url, start: 0, duration: 2, offset: 0, sourceDuration: 4 },
  { id: 'c_audio', track: 'audio', assetId: 'a_au', name: '音频底', kind: 'audio', url: ASSETS[2].url, start: 0, duration: 2, offset: 0, sourceDuration: 2 }
]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected） */
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
  console.log(`MULTICAM_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('MULTICAM_E2E_OK')
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
  console.log('=== 多机位 E2E（真启 Electron + 真 Ctrl 点选 + 真右键建多机位 + 真按键切角）===\n')

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
      { name: 'E2E 多机位', data: { clips: CLIPS, assets: ASSETS, playhead: 1, volume: 80, zoom: 1 } }
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

    /* ---- Ctrl + 点选 ---- */
    await page.locator('.clip[data-clip="c_cam1"]').click()
    await sleep(200)
    await page.locator('.clip[data-clip="c_cam2"]').click({ modifiers: ['Control'] })
    await sleep(300)
    const multiCount = await page.locator('.clip.multi').count()
    check('Ctrl + 点选 · 第二路进多选集合', multiCount === 1, `multi=${multiCount}`)
    const leftOfSecond = await page.evaluate(() => document.querySelector('.clip[data-clip="c_cam2"]')?.style.left || '')
    check('Ctrl + 点选不起拖动（第二路仍在原地）', /^[\d.]+px$/.test(leftOfSecond) && parseFloat(leftOfSecond) < 6, leftOfSecond)

    /* ---- 右键建多机位 ---- */
    await page.locator('.clip[data-clip="c_cam2"]').click({ button: 'right' })
    await sleep(400)
    const mcItem = page.locator('.wb-ctxmenu button[data-ctx="multicam"]')
    const itemText = ((await mcItem.textContent()) || '').trim()
    check('右键菜单 · 「新建多机位（2 路）」按多选集算路数', itemText.includes('2 路'), itemText)
    await mcItem.click()
    await sleep(700)

    check('建好后 · 时间线只剩 2 个片段（多机位 + 音频）', (await clipCount()) === 2, `实测 ${await clipCount()}`)
    check('建好后 · 那个片段被标成多机位', (await page.locator('.clip.is-multicam').count()) === 1)
    const badge = await page.locator('.clip-badge[data-clip-multicam]').first().getAttribute('data-clip-multicam')
    check('建好后 · 角标写着 2 路', badge === '2', String(badge))
    const bodyText = ((await page.locator('.clip-chain[data-multicam-body]').first().textContent()) || '').replace(/\s+/g, '')
    check('建好后 · 本体写着「2 路 · 1 段」', bodyText.includes('2路') && bodyText.includes('1段'), bodyText)

    /* ---- 预览：多机位被展开，主层是内部区间 ---- */
    const mainLayerId = () =>
      page.evaluate(() => {
        const node = document.querySelector('.canvas-layer[data-layer-role="main"]')
        return node ? node.getAttribute('data-layer') : ''
      })
    const selectableOfMain = () =>
      page.evaluate(() => {
        const node = document.querySelector('.canvas-layer[data-layer-role="main"]')
        return node ? node.getAttribute('data-selectable') : ''
      })

    const layer0 = await mainLayerId()
    check('预览 · 主画面层是多机位展开出的区间（id 形如 父~m0_*）', /~m0_/.test(layer0), layer0 || '（无主层）')
    check('预览 · 可点选目标是**外层**多机位片段（不是模型里不存在的区间 id）', /^c\d|^clip/.test(await selectableOfMain()) && !(await selectableOfMain()).includes('~'), String(await selectableOfMain()))

    /* ---- 检查器：切到第 2 路，预览必须**当场**换画面 ---- */
    await page.locator('[data-insp-tab="multicam"]').click()
    await sleep(300)
    const angleButtons = await page.locator('[data-mc-angle]').count()
    check('检查器 · 「多机位」页列出 2 路机位', angleButtons === 2, `实测 ${angleButtons}`)
    await page.locator('[data-mc-angle="1"]').click()
    await sleep(600)
    const cutsText = ((await page.locator('[data-mc-cuts]').first().textContent()) || '').replace(/\s+/g, '')
    check('切角后 · 切换段变成 2 段', cutsText.includes('2段'), cutsText)
    const layer1 = await mainLayerId()
    check('切角后 · 预览主层换成第 2 路（这一条能抓住"面板变了、画面没变"）', /~m1_/.test(layer1), layer1)

    /* ---- 播放头回到开头：应该是第 1 路 ---- */
    await page.keyboard.press('Home')
    await sleep(600)
    const layerBack = await mainLayerId()
    check('播放头回 0 · 主层回到第 1 路', /~m0_/.test(layerBack), layerBack)

    /* ---- 数字键 2：在播放头处再切一刀 ----
       ⚠️ 先往右走一帧：播放头停在 0 时按 2 是**覆盖 0 秒处那个切换点**
       （同一时刻只会有一个切换点，后点的生效），段数不会变 —— 那是正确行为，
       我们的断言得对着"另一个时刻"按，否则测的是覆盖而不是新增。 */
    await page.keyboard.press('ArrowRight')
    await sleep(300)
    await page.keyboard.press('2')
    await sleep(600)
    const cutsText2 = ((await page.locator('[data-mc-cuts]').first().textContent()) || '').replace(/\s+/g, '')
    check('数字键 2 · 又落一个切换点（3 段）', cutsText2.includes('3段'), cutsText2)
    const layerKey = await mainLayerId()
    check('数字键 2 · 预览主层当即换成第 2 路', /~m1_/.test(layerKey), layerKey)

    /* ---- 取声：静音 ---- */
    await page.locator('[data-mc-audiomode-opt="none"]').click()
    await sleep(300)
    const nonePressed = await page.locator('[data-mc-audiomode-opt="none"]').getAttribute('aria-pressed')
    check('取声 · 点「静音」后按钮按下', nonePressed === 'true', String(nonePressed))

    /* ---- 解除：3 段画面（静音模式下没有取声音轨）+ 原来的音频 = 4 ---- */
    await page.locator('[data-mc-ungroup="1"]').click()
    await sleep(700)
    check('解除后 · 时间线 4 个片段（3 段画面 + 原音频）', (await clipCount()) === 4, `实测 ${await clipCount()}`)
    check('解除后 · 没有多机位片段了', (await page.locator('.clip.is-multicam').count()) === 0)

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
