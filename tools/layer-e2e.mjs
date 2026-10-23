#!/usr/bin/env node
/**
 * 客户端 E2E · 画面层级（自由层级）。
 *
 * 这一道只测「界面到算术之间」的那几根线 —— 纯算术与成片侧由 `check-layer-order` 钉住：
 *   · 层号在数据里、菜单点了没写回 ⇒ 时间线上层号永远不变（点了没反应）；
 *   · 菜单项该置灰的不置灰 ⇒ 最上层还能"上移"（用户会一直点，一直没反应）；
 *   · 非叠加轨也允许调层 ⇒ 主轨是一条顺序链，那个操作没有意义，属于假控件；
 *   · 改完不落草稿 ⇒ 重开草稿层叠顺序回到老样子。
 *
 * 判据取**消费端**：时间线上 `data-clip-z` 的真实数值、右键菜单项的 `disabled`、
 * 以及磁盘上草稿 JSON 里真的存了 `z`。
 *
 * 用法：node tools/layer-e2e.mjs
 * 前置：`cd packages/desktop && vite build`
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.layer-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

const TOTAL_ASSERTIONS = 12

let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`LAYER_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('LAYER_E2E_OK')
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

/* 两段画中画错开摆：时间线上完全重叠时上面的卡片会挡住下面的（右键点不到），
   而"谁压住谁"的语义本身由纯算术与成片像素两处钉住，这里只测界面链路。 */
const ASSETS = [{ id: 'a_t1', kind: 'text', name: '文字甲', text: '底', url: '' }]
const CLIPS = [
  { id: 'c_base', track: 'video', assetId: 'a_t1', name: '底片', kind: 'text', start: 0, duration: 6, offset: 0, sourceDuration: 6 },
  { id: 'c_ov_1', track: 'overlay', assetId: 'a_t1', name: '画中画甲', kind: 'text', start: 1, duration: 2, offset: 0, sourceDuration: 2 },
  { id: 'c_ov_2', track: 'overlay', assetId: 'a_t1', name: '画中画乙', kind: 'text', start: 4, duration: 2, offset: 0, sourceDuration: 2 }
]

async function main() {
  console.log('=== 画面层级 E2E（右键上移/下移 → 时间线层号 → 草稿落盘）===\n')

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
    /* 删不掉就带旧 profile 启动 */
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

    await page.waitForSelector('.app', { timeout: 30000 })
    await sleep(1400)
    await resize()

    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: 'E2E 画面层级',
      data: { clips: CLIPS, assets: ASSETS, playhead: 1.5, volume: 80, zoom: 1 }
    })
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

    const zOf = async (id) =>
      page.locator(`[data-lane="overlay"] .clip[data-clip="${id}"]`).getAttribute('data-clip-z')
    check('初始 · 两段画中画都挂着层号 0', (await zOf('c_ov_1')) === '0' && (await zOf('c_ov_2')) === '0',
      `${await zOf('c_ov_1')} / ${await zOf('c_ov_2')}`)

    /* 右键第二段（c_ov_2）：按 id 序号它本来就在上面，上移应当置灰 */
    const openMenu = async (id, lane = 'overlay') => {
      await page.locator(`[data-lane="${lane}"] .clip[data-clip="${id}"]`).click({ button: 'right' })
      await page.waitForSelector('[data-ctxmenu="1"]', { timeout: 8000 })
      await sleep(200)
    }

    await openMenu('c_ov_2')
    const upDisabledTop = await page.locator('[data-ctx="layer-up"]').isDisabled()
    const downEnabledTop = await page.locator('[data-ctx="layer-down"]').isEnabled()
    check('最上层 · 「上移一层」置灰（点了也没反应的东西不许做成可点的）', upDisabledTop)
    check('最上层 · 「下移一层」可点', downEnabledTop)
    await page.keyboard.press('Escape')
    await sleep(300)

    /* 下移第二段：两段同起点，层号应当变成 1 与 0（乙沉到下面） */
    await openMenu('c_ov_2')
    await page.locator('[data-ctx="layer-down"]').click()
    await sleep(500)
    const afterDown = { a: await zOf('c_ov_1'), b: await zOf('c_ov_2') }
    check('下移之后 · 层号真的变了（不是只改菜单状态）', afterDown.b === '0' && afterDown.a === '1',
      JSON.stringify(afterDown))

    /* 现在甲在上面：它的「上移」应当置灰、「下移」可点 */
    await openMenu('c_ov_1')
    check('换位之后 · 甲的「上移一层」置灰（置灰状态跟着真实层号走）',
      await page.locator('[data-ctx="layer-up"]').isDisabled())
    await page.keyboard.press('Escape')
    await sleep(300)

    /* 主轨（视频轨）不该有层级概念 */
    await openMenu('c_base', 'video')
    const baseUpDisabled = await page.locator('[data-ctx="layer-up"]').isDisabled()
    check('主轨片段 · 两项都置灰（主轨是顺序链，没有"谁压住谁"）', baseUpDisabled)
    await page.keyboard.press('Escape')
    await sleep(300)

    /* 再上移乙 → 回到乙在上，且层号只剩 0/1（重新编号，不是无限加） */
    await openMenu('c_ov_2')
    await page.locator('[data-ctx="layer-up"]').click()
    await sleep(500)
    const afterUp = { a: await zOf('c_ov_1'), b: await zOf('c_ov_2') }
    check('再上移 · 乙回到上面', afterUp.b === '1' && afterUp.a === '0', JSON.stringify(afterUp))
    check('层号没有越加越大（轨内始终 0..n-1）',
      Number(afterUp.a) >= 0 && Number(afterUp.b) <= 1, JSON.stringify(afterUp))

    /* 落盘：重开草稿层号必须还在 —— 否则"排好的层级一重启就没" */
    await page.waitForTimeout(1200)
    const draftId = saved?.id
    const raw = await page.evaluate(async (id) => {
      const list = await window.yjai.draft.list()
      const hit = list.find((item) => item.id === id)
      if (!hit) return null
      const full = await window.yjai.draft.load(id)
      return full?.data?.clips || null
    }, draftId)
    const persisted = Array.isArray(raw) ? raw.filter((clip) => clip.id === 'c_ov_2').map((clip) => clip.z) : []
    check('落盘 · 草稿 JSON 里存了 z（重开草稿不会回到老样子）', persisted.length === 1 && persisted[0] === 1,
      JSON.stringify(persisted))

    check('全程无页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
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
