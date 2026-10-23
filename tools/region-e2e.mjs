#!/usr/bin/env node
/**
 * 客户端 E2E · 时间区域（Shift+拖动框选 → 复制 / 只导出 / 删除 → I O 键）。
 *
 * 纯函数闸门（check-region）已经证明"算术对、成片对"，这里补的是**界面到算术之间**那几根线：
 *   ① Shift+拖动标尺没接上（拖完没有任何反应，而标尺照常挪播放头）；
 *   ② 区域画出来了但工具栏那一簇没出现（"框住了，然后呢？"）；
 *   ③ 复制了却不让粘贴 / 粘贴到播放头位置不对；
 *   ④ 「只导出」打开了面板但面板不知道有区间（成片还是整条）；
 *   ⑤ 删除区域只删了内容没前移（后半段留在原地，中间一个空洞）。
 *
 * 判据一律取消费端：`.wb-region` 上真实写出的 data-region-start/end（秒）、
 * 时间线片段卡片的 DOM 数与几何（px / 46 = 秒）、导出面板的 aria-pressed。
 *
 * 用法：node tools/region-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.region-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]
const DPS = 46

/**
 * 夹具：视频轨两段（文字素材，不依赖真实媒体也能画出画面），音频轨一段。
 * 区间 [1,3) 正好横跨两段画面的接缝 —— 这样"删除后正确切成 4 段"与
 * "删除后没有前移"两种结果在 DOM 数与几何上完全不同。
 */
const ASSETS = [
  { id: 'a_t1', kind: 'text', name: '文字甲', text: '区间甲', url: '' },
  { id: 'a_t2', kind: 'text', name: '文字乙', text: '区间乙', url: '' },
  { id: 'a_au', kind: 'audio', name: '音频丙', url: 'm://region-gate-nonexistent.mp3' }
]

const CLIPS = [
  { id: 'c_one', track: 'video', assetId: 'a_t1', name: '片段甲', kind: 'text', start: 0, duration: 2, offset: 0, sourceDuration: 2 },
  { id: 'c_two', track: 'video', assetId: 'a_t2', name: '片段乙', kind: 'text', start: 2, duration: 2, offset: 0, sourceDuration: 2 },
  { id: 'c_audio', track: 'audio', assetId: 'a_au', name: '片段丙', kind: 'audio', start: 0, duration: 4, offset: 0, sourceDuration: 4 }
]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 25

let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`REGION_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('REGION_E2E_OK')
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
  console.log('=== 时间区域 E2E（真启 Electron + 真 Shift 拖动 + 真删除/粘贴）===\n')

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
      { name: 'E2E 时间区域', data: { clips: CLIPS, assets: ASSETS, playhead: 0.5, volume: 80, zoom: 1 } }
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

    /* 标尺上的秒 → 屏幕 x。dps 固定 46（zoom 1），但标尺左边距随布局变，所以现取一次 */
    const secondToX = async (seconds) => {
      const box = await page.locator('.wb-tlruler').boundingBox()
      if (!box) throw new Error('标尺不可见')
      return { x: box.x + seconds * DPS, y: box.y + box.height / 2 }
    }

    /* ---- ① Shift + 拖动标尺：框出 [1,3) ---- */
    const from = await secondToX(1)
    const to = await secondToX(3)
    await page.keyboard.down('Shift')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await sleep(400)

    const regionBox = page.locator('.wb-region')
    check('Shift + 拖动 · 标尺上出现区间带', (await regionBox.count()) === 1, `实测 ${await regionBox.count()}`)
    const span = await regionBox.first().evaluate((node) => ({
      start: Number(node.dataset.regionStart),
      end: Number(node.dataset.regionEnd)
    }))
    check(
      'Shift + 拖动 · 区域是 [1,3)（误差 < 0.15 秒）',
      Math.abs(span.start - 1) < 0.15 && Math.abs(span.end - 3) < 0.15,
      JSON.stringify(span)
    )

    check('区域建立 · 工具栏出现区间操作条', (await page.locator('.wb-regionbar').count()) === 1)
    const label = (await page.locator('[data-region-label]').first().textContent()) || ''
    /* 时间码是 `HH:MM:SS`（`timecode(x, false)` 不带帧号）；写四段会永远匹配不上 */
    check('区间条 · 显示起止时间码（不是空的）', /\d\d:\d\d:\d\d/.test(label), label.trim())

    /* 播放头没有被拖动带跑（拖动区域不该顺手 seek） */
    const playheadAfterDrag = await page.evaluate(() => {
      const node = document.querySelector('.playhead')
      return node ? parseFloat(node.style.left) : -1
    })
    check(
      'Shift + 拖动 · 播放头没被拖跑（拖动 ≠ 定位）',
      Math.abs(playheadAfterDrag - 0.5 * DPS) < 4,
      String(playheadAfterDrag)
    )

    /* ---- ② 复制：剪贴板有内容才允许粘贴 ---- */
    const pasteBtn = page.locator('[data-region-op="paste"]').first()
    check('复制之前 · 粘贴按钮是禁用的', await pasteBtn.isDisabled(), String(await pasteBtn.isDisabled()))
    await page.locator('[data-region-op="copy"]').first().click()
    await sleep(400)
    check('复制之后 · 粘贴按钮可点', !(await pasteBtn.isDisabled()))

    /* ---- ③ 只导出：导出面板必须知道有区间 ---- */
    await page.locator('[data-region-op="export"]').first().click()
    await sleep(600)
    const rangeChip = page.locator('[data-export-range-btn="range"]')
    check('只导出 · 打开了导出面板并出现「只导出时间区域」开关', (await rangeChip.count()) === 1)
    check('只导出 · 该开关默认按下（用户点的就是"只导出这一段"）', (await rangeChip.getAttribute('aria-pressed')) === 'true')
    const rangeText = (await page.locator('[data-export-range]').first().textContent()) || ''
    check('只导出 · 面板上写出了区间（不是空的）', /\d\d:\d\d:\d\d/.test(rangeText), rangeText.trim())
    const rangeDur = Number(await page.locator('[data-export-duration]').first().getAttribute('data-export-duration'))
    check('只导出 · 成片时长按区间算（2 秒，不是整条 4 秒）', Math.abs(rangeDur - 2) < 0.15, String(rangeDur))
    await page.locator('[data-export-range-btn="all"]').click()
    await sleep(300)
    const allDur = Number(await page.locator('[data-export-duration]').first().getAttribute('data-export-duration'))
    check('切回「整条时间线」· 时长回到 4 秒', Math.abs(allDur - 4) < 0.2, String(allDur))
    await page.keyboard.press('Escape')
    await sleep(500)

    /* ---- ④ 删除区域：区间内容消失，后面内容前移 ---- */
    await page.locator('[data-region-op="delete"]').first().click()
    await sleep(700)
    const afterDelete = await clipCount()
    /* 删 [1,3) 之后的正确结果：a→[0,1)、a→[1,2)（原 [3,4) 前移）、音频同样两段。共 4 段 */
    check('删除区域 · 片段从 3 段变成 4 段（跨接缝的两段各被切成两半）', afterDelete === 4, `实测 ${afterDelete}`)
    const endPx = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.clip[data-clip]')).reduce((max, node) => {
        const left = parseFloat(node.style.left) || 0
        const width = parseFloat(node.style.width) || 0
        return Math.max(max, left + width)
      }, 0)
    )
    check(
      '删除区域 · 时间线总长从 4 秒缩到 2 秒（后面内容真的前移了，不是留下空洞）',
      Math.abs(endPx - 2 * DPS) < 8,
      `${endPx}px（期望 ≈ ${2 * DPS}px）`
    )
    check('删除区域 · 区间带自己消失了（区域是一次性选区）', (await page.locator('.wb-region').count()) === 0)

    /* ---- ⑤ I / O 键：入点 / 出点落在播放头 ---- */
    const at = await secondToX(0.5)
    await page.mouse.click(at.x, at.y)
    await sleep(300)
    await page.keyboard.press('i')
    await sleep(300)
    check('按 I · 只标了入点（画一根竖线，不凭空生成区域）', (await page.locator('[data-region-open="1"]').count()) === 1)
    check('按 I · 此时没有区间带（还没标出点）', (await page.locator('.wb-region').count()) === 0)
    const at2 = await secondToX(1.5)
    await page.mouse.click(at2.x, at2.y)
    await sleep(300)
    await page.keyboard.press('o')
    await sleep(400)
    const io = await page
      .locator('.wb-region')
      .first()
      .evaluate((node) => ({ start: Number(node.dataset.regionStart), end: Number(node.dataset.regionEnd) }))
      .catch(() => null)
    check(
      '按 O · 区间是 [0.5,1.5)（入点没被出点覆盖）',
      Boolean(io) && Math.abs(io.start - 0.5) < 0.2 && Math.abs(io.end - 1.5) < 0.2,
      JSON.stringify(io)
    )

    /* ---- ⑥ Shift+Delete：删除区间 ---- */
    await page.keyboard.press('Shift+Delete')
    await sleep(700)
    check('Shift + Delete · 区间被删掉（区间带消失）', (await page.locator('.wb-region').count()) === 0)
    /* 这一刀切在两条片段的中段：左右各留半截 ⇒ 段数**不变**（4 → 4），
       所以判据只能取"总长"：删掉 1 秒后时间线必须从 2 秒缩到 1 秒。
       ⚠️ 拿段数当判据会假红（真删除也是 4 段），这是这次踩到的第一个坑。 */
    const afterKeyDeleteEnd = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.clip[data-clip]')).reduce((max, node) => {
        const left = parseFloat(node.style.left) || 0
        const width = parseFloat(node.style.width) || 0
        return Math.max(max, left + width)
      }, 0)
    )
    check(
      'Shift + Delete · 时间线又缩短 1 秒（2 秒 → 1 秒，删除真的发生了）',
      Math.abs(afterKeyDeleteEnd - 1 * DPS) < 8,
      `${afterKeyDeleteEnd}px（期望 ≈ ${1 * DPS}px）`
    )

    /* ---- ⑦ 粘贴：剪贴板来自步骤 ②，落点必须是播放头 ---- */
    const beforePaste = await clipCount()
    await page.locator('[data-region-op="paste"]').first().click()
    await sleep(700)
    const afterPaste = await clipCount()
    check('粘贴 · 剪贴板里的 3 段都落到了时间线上', afterPaste === beforePaste + 3, `${beforePaste} → ${afterPaste}`)
    const pastedLeft = await page.evaluate(() => {
      const node = document.querySelector('.clip.selected')
      return node ? parseFloat(node.style.left) || 0 : -1
    })
    check(
      '粘贴 · 落点在播放头（1.5 秒 ≈ 69px），不是 0',
      Math.abs(pastedLeft - 1.5 * DPS) < 10,
      `${pastedLeft}px`
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
