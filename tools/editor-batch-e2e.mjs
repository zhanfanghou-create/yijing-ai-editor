#!/usr/bin/env node
/**
 * 客户端 E2E · 组合 / 属性剪贴板 / 批量分割 / 主轨联动（四组新键位）。
 *
 * 为什么纯逻辑闸门不够（已经有 clip-props-selftest / groups-selftest / trim-selftest）：
 * 那三道证明的是"算术对"，而**按键到算术之间**还有三根线，断任何一根都表现为
 * "按下去什么都没发生"，且构建、静态扫描、纯逻辑夹具全绿：
 *   ① 键位登记了但 `actionHandlersRef` 里没有处理函数（派发器取不到 handler 就直接 return）；
 *   ② 处理函数在，但作用对象取错（多选集合没传进去 / 取的是旧闭包里的选中）；
 *   ③ 改对了但界面没反应（组合没有视觉标记 —— 唯一证据是"点一段，整组高亮"）。
 *
 * 所以判据一律取**消费端**：
 *   · 组合 → 时间线上 `.clip.multi` 落在哪一段（选中集合真的扩到整组）；
 *   · 属性粘贴 → 右栏滑杆/数值框里**读出来的值**（不是片段对象上的字段）；
 *   · 批量分割 → 时间线片段条数与原有 id 是否还在（左半段沿用原 id）；
 *   · 主轨联动 → 工具条那个按钮的 `aria-pressed`。
 *
 * 用法：node tools/editor-batch-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.batch-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/**
 * 夹具：视频轨两段（文字素材，不依赖真实媒体也能画出画面层）+ 音频轨一段。
 *
 * 第一段**带着外观属性**（缩放 140% / 位置 40），第二段什么都不带 ——
 * 这样"复制第一段 → 粘到第二段"才有可观测的差值：贴成功后第二段的滑杆要变成 140。
 */
const ASSETS = [
  { id: 'a_t1', kind: 'text', name: '文字甲', text: '批量甲', url: '' },
  { id: 'a_t2', kind: 'text', name: '文字乙', text: '批量乙', url: '' },
  { id: 'a_au', kind: 'audio', name: '音频丙', url: 'm://batch-gate-nonexistent.mp3' }
]

const CLIPS = [
  {
    id: 'c_one',
    track: 'video',
    assetId: 'a_t1',
    name: '片段甲',
    kind: 'text',
    start: 0,
    duration: 2,
    offset: 0,
    sourceDuration: 2,
    scale: 140,
    posX: 40
  },
  { id: 'c_two', track: 'video', assetId: 'a_t2', name: '片段乙', kind: 'text', start: 2, duration: 2, offset: 0, sourceDuration: 2 },
  { id: 'c_audio', track: 'audio', assetId: 'a_au', name: '片段丙', kind: 'audio', start: 0, duration: 4, offset: 0, sourceDuration: 4 }
]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected）。
    ！= 17 是**正常路径**的 check 数；catch 里那条「未中途抛异常」只在真出事时才跑，
    所以它不计入 —— 出事时 ran 会小于 17，summary 会自己报「断言覆盖」不达标。 */
const TOTAL_ASSERTIONS = 17
/** 看门狗：整个套件最多跑这么久。到点强退，不让它把 verify 挂死 */
const WATCHDOG_MS = 6 * 60 * 1000

let failures = 0
let ran = 0
let aborted = ''

function check(name, ok, detail = '') {
  ran += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  /* ⚠️ 不许用 `总数 - 失败数` 反算通过数：某个 check 被注掉 / 被提前 return 跳过时，
     反算出来的"通过"会把少跑的那几项算成绿的。所以**实际跑了几项**单独计数并核对。 */
  let coverage = 0
  if (ran !== TOTAL_ASSERTIONS) {
    coverage = 1
    console.log(`  [FAIL] 断言覆盖 · 期望 ${TOTAL_ASSERTIONS} 项，实际只跑了 ${ran} 项（有 check 被跳过或被注掉）`)
  }
  const fail = failures + coverage
  const pass = ran - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  console.log(`EDITOR_BATCH_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail}`)
  if (!fail && !aborted) console.log('EDITOR_BATCH_E2E_OK')
  return fail === 0 && !aborted
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
  console.log('=== 组合 / 属性剪贴板 / 批量分割 / 联动 E2E（真启 Electron + 真按键）===\n')

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
      { name: 'E2E 组合与属性', data: { clips: CLIPS, assets: ASSETS, playhead: 1, volume: 80, zoom: 1 } }
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
    const clipAt = (id) => page.locator(`.clip[data-clip="${id}"]`)
    check('夹具 · 时间线上有 3 个片段', (await clipCount()) === 3, `实测 ${await clipCount()}`)

    /** 点一下空白处把选中清掉（点标尺上沿，避免误点到片段） */
    const clearSelection = async () => {
      await page.keyboard.press('Escape')
      await sleep(200)
    }

    /* ---------------- 组合：Alt+G 之后点一段要整组高亮 ---------------- */
    await clipAt('c_one').click()
    await sleep(250)
    check(
      '基线 · 单击只选中一段（没有 .multi）',
      (await page.locator('.clip.selected').count()) === 1 && (await page.locator('.clip.multi').count()) === 0,
      `selected=${await page.locator('.clip.selected').count()} multi=${await page.locator('.clip.multi').count()}`
    )

    await clipAt('c_two').click({ modifiers: ['Control'] })
    await sleep(250)
    await page.keyboard.press('Alt+G')
    await sleep(500)

    await clearSelection()
    await clipAt('c_one').click()
    await sleep(300)
    /* 消费端：点的是 c_one，但 c_two 必须一起高亮（.multi = 除主选中之外的组员） */
    const groupMarked = await page.locator('.clip.multi[data-clip="c_two"]').count()
    check('组合（Alt+G）· 点组内一段，另一段一起高亮', groupMarked === 1, `c_two.multi=${groupMarked}`)
    check(
      '组合 · 主选中仍是被点的那一段（右栏不会跟着跳）',
      (await page.locator('.clip.selected[data-clip="c_one"]').count()) === 1
    )

    await page.keyboard.press('Alt+Shift+G')
    await sleep(500)
    await clearSelection()
    await clipAt('c_one').click()
    await sleep(300)
    check(
      '取消组合（Alt+Shift+G）· 再点一段只选中它自己',
      (await page.locator('.clip.multi').count()) === 0 && (await page.locator('.clip.selected').count()) === 1,
      `multi=${await page.locator('.clip.multi').count()}`
    )

    /* ---------------- 属性剪贴板：读右栏的滑杆值 ---------------- */
    /**
     * ⚠️ 右栏默认落在「信息」页，画面控件（缩放 / 位置）在「画面」页。
     * 不先点一下这枚页签，`input[data-slider="scale"]` 一个都取不到 ——
     * 断言会以"实测 null"的形式失败，看着像功能没接上，其实只是没翻页。
     */
    const openVisualTab = async () => {
      const tab = page.locator('[data-insp-tab="visual"]').first()
      if (await tab.count()) {
        await tab.click()
        await sleep(300)
      }
    }
    const sliderValue = async (hook) => {
      const node = page.locator(`input[data-slider="${hook}"]`).first()
      if (!(await node.count())) return null
      return Number(await node.inputValue())
    }
    const numValue = async (hook) => {
      const node = page.locator(`input[data-insp-num="${hook}"]`).first()
      if (!(await node.count())) return null
      return Number(await node.inputValue())
    }

    await clipAt('c_two').click()
    await sleep(400)
    await openVisualTab()
    const beforeScale = await sliderValue('scale')
    check('粘贴前 · 目标片段的缩放是默认 100', beforeScale === 100, `实测 ${beforeScale}`)

    await clipAt('c_one').click()
    await sleep(300)
    await page.keyboard.press('Control+Alt+C')
    await sleep(300)
    await clipAt('c_two').click()
    await sleep(300)
    await page.keyboard.press('Control+Alt+V')
    await sleep(500)
    await openVisualTab()

    const afterScale = await sliderValue('scale')
    check('粘贴属性（Ctrl+Alt+C → Ctrl+Alt+V）· 缩放真的变成 140', afterScale === 140, `实测 ${afterScale}`)
    const afterPos = await numValue('posx')
    check('粘贴属性 · 位置也跟着搬过来了（40）', afterPos === 40, `实测 ${afterPos}`)

    /* ---------------- 右键菜单：与键盘是**两条路**，第二条最容易接错 ----------------
       菜单项若接到隔壁的动作上（「粘贴属性」接成复制、「新建组合」接成新建复合片段），
       上面那些按键断言照样全绿 —— 只有真点一遍菜单才照得出来。
       两个判据都读消费端：禁用态读按钮自身，组合结果读 `.multi` 类名。 */
    const ctxAt = async (id) => {
      await clipAt(id).click({ button: 'right' })
      await sleep(350)
    }
    await ctxAt('c_two')
    const pasteDisabled = await page.locator('.wb-ctxmenu button[data-ctx="paste-attrs"]').isDisabled()
    check('右键菜单 · 复制过属性后「粘贴属性」可用（说明复制真的写进了共享剪贴板）', pasteDisabled === false, `disabled=${pasteDisabled}`)

    await page.locator('.wb-ctxmenu button:has-text("取消")').click()
    await sleep(200)
    await clipAt('c_one').click()
    await clipAt('c_two').click({ modifiers: ['Control'] })
    await sleep(250)
    await ctxAt('c_one')
    const combLabel = await page.locator('.wb-ctxmenu button[data-ctx="combination"]').innerText()
    check('右键菜单 · 多选两段时「新建组合」显示段数', combLabel.includes('2'), combLabel.replace(/\s+/g, ' ').slice(0, 24))
    await page.locator('.wb-ctxmenu button[data-ctx="combination"]').click()
    await sleep(400)
    await clipAt('c_one').click()
    await sleep(350)
    check('右键菜单 · 走菜单建组后点一段，另一段一起高亮', (await clipAt('c_two').evaluate((el) => el.classList.contains('multi'))) === true)

    /* ---------------- 批量分割：播放头 1 秒处切穿所有轨道 ---------------- */
    await page.keyboard.press('Control+Shift+K')
    await sleep(700)
    check('批量分割（Ctrl+Shift+K）· 3 段变 5 段（两段跨过播放头）', (await clipCount()) === 5, `实测 ${await clipCount()}`)
    check('批量分割 · 左半段沿用原 id（选中与历史不会指向空气）', (await clipAt('c_one').count()) === 1)

    /* ---------------- 主轨联动：Ctrl+L 与工具条按钮同一状态 ---------------- */
    const linkBtn = page.locator('[data-tl="link"]')
    const pressedBefore = await linkBtn.getAttribute('aria-pressed')
    await page.keyboard.press('Control+L')
    await sleep(350)
    const pressedAfter = await linkBtn.getAttribute('aria-pressed')
    check('主轨联动（Ctrl+L）· 按下后开关翻转', pressedBefore === 'true' && pressedAfter === 'false', `${pressedBefore} → ${pressedAfter}`)
    await page.keyboard.press('Control+L')
    await sleep(350)
    const pressedBack = await linkBtn.getAttribute('aria-pressed')
    check('主轨联动 · 再按一次回到开（是开关，不是单向动作）', pressedBack === 'true', String(pressedBack))

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

const watchdog = setTimeout(() => {
  console.error(`WATCHDOG：套件超过 ${WATCHDOG_MS}ms 未结束，强制退出`)
  console.log('EDITOR_BATCH_E2E_STATS total=' + TOTAL_ASSERTIONS + ' pass=0 fail=' + TOTAL_ASSERTIONS)
  console.log('EDITOR_BATCH_E2E_FAILED')
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
