#!/usr/bin/env node
/**
 * 客户端 E2E · 按场景分割（真 ffmpeg 检测 + 真切开时间线）。
 *
 * 这一道验的是「界面到 ffmpeg 之间」那条链，纯算术由 `check-scenes` 钉住：
 *   · 菜单项点了没接上 ⇒ 什么都不发生（界面上毫无异常）；
 *   · 检测走了、切点没换算 ⇒ 切在错的位置（时间线上看是"切歪了"，但不会报错）；
 *   · 只改时间线不落草稿 ⇒ 重开就回到一整段；
 *   · 切完总时长变了 ⇒ 后面所有内容整体错位。
 *
 * 夹具是现场造的「红 1 秒 / 蓝 1 秒 / 绿 1 秒」三段视频：两次硬切位置确定，
 * 切完之后时间线上应当正好是三段等宽（≈46px/秒）。
 *
 * 用法：node tools/scenes-e2e.mjs
 * 前置：`cd packages/desktop && vite build`，且本机有 ffmpeg
 * 退出码：0 = 通过；1 = 有失败；2 = 本机没有 ffmpeg（如实跳过）
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.scenes-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]
const DPS = 46

const TOTAL_ASSERTIONS = 11

let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`SCENES_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('SCENES_E2E_OK')
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

/* 找 ffmpeg：用主进程同一份探测，找不到就如实跳过（不假绿） */
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

async function main() {
  console.log('=== 按场景分割 E2E（真 ffmpeg 检测 → 时间线真的切成三段）===\n')

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    console.log('SCENES_E2E_SKIPPED 本机没有 ffmpeg')
    console.log('SCENES_E2E_STATS total=0 pass=0 fail=0 skip=1')
    process.exit(2)
  }
  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, EXE)
    aborted = 'electron 不存在'
    return summary()
  }
  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 构建产物存在', false, 'dist-renderer/index.html 缺失')
    aborted = '构建产物缺失'
    return summary()
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-scenes-e2e-'))
  const fixture = path.join(work, 'three.mp4')
  spawnCapture(
    found.ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=1',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture],
    { tag: 'mk-three' }
  )
  check('夹具 · 三段视频已生成（红/蓝/绿 各 1 秒）', fs.existsSync(fixture), fixture)
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
    page.setDefaultTimeout(30000)

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

    /* 先 stat 一次把文件登记进 allowedMedia 白名单，再取 url。
       ⚠️ `media.url` 对**没登记过**的路径返回空串（白名单是防止渲染层随便把任意路径
       交给协议处理器）—— 跳过 stat 直接取 url 会拿到 ""，然后表现为"菜单项一直置灰"，
       看上去像功能没接，其实是夹具搭错。 */
    const described = await page.evaluate((filePath) => window.yjai.media.stat([filePath]), fixture)
    const url = await page.evaluate((filePath) => window.yjai.media.url(filePath), fixture)
    check('夹具 · 素材已登记且拿到自定义协议 url',
      Array.isArray(described) && described.length === 1 && typeof url === 'string' && url.startsWith('yjai-media://local/'),
      String(url).slice(0, 40) || '（空串：白名单没登记）')

    const clips = [
      { id: 'c_scene', track: 'video', kind: 'video', name: '三段', path: fixture, url, start: 0, duration: 3, offset: 0, sourceDuration: 3 }
    ]
    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: 'E2E 场景分割',
      data: { clips, assets: [], playhead: 0, volume: 80, zoom: 1 }
    })
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(700)
    await resize()
    await sleep(400)

    const clipCount = () => page.locator('[data-lane="video"] .clip[data-clip]').count()
    check('分割前 · 时间线上是 1 段', (await clipCount()) === 1, String(await clipCount()))

    await page.locator('[data-lane="video"] .clip[data-clip]').first().click({ button: 'right' })
    await page.waitForSelector('[data-ctxmenu="1"]', { timeout: 8000 })
    const scenesEnabled = await page.locator('[data-ctx="scenes"]').isEnabled()
    check('右键菜单 · 「按场景分割」可点（视频素材）', scenesEnabled)

    await page.locator('[data-ctx="scenes"]').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-lane="video"] .clip[data-clip]').length >= 3, null, {
      timeout: 60000
    })
    await sleep(600)

    const count = await clipCount()
    check('分割后 · 变成 3 段（两次硬切）', count === 3, String(count))

    const geo = await page.locator('[data-lane="video"] .clip[data-clip]').evaluateAll((nodes) =>
      nodes.map((node) => ({ left: parseFloat(node.style.left) || 0, width: parseFloat(node.style.width) || 0 }))
    )
    const total = geo.reduce((max, item) => Math.max(max, item.left + item.width), 0)
    check('总长不变（≈3 秒 = 138px）', Math.abs(total / DPS - 3) < 0.15, `${(total / DPS).toFixed(2)} 秒`)
    check(
      '三段各≈1 秒（切点在 1s / 2s，不是切歪了）',
      geo.length === 3 && geo.every((item) => Math.abs(item.width / DPS - 1) < 0.15),
      geo.map((item) => (item.width / DPS).toFixed(2)).join(' / ')
    )
    check(
      '三段首尾相接（没有空洞也没有重叠）',
      geo.length === 3 && Math.abs(geo[1].left - (geo[0].left + geo[0].width)) < 1 &&
        Math.abs(geo[2].left - (geo[1].left + geo[1].width)) < 1,
      geo.map((item) => item.left.toFixed(0)).join(',')
    )

    /* 落盘：重开草稿还是三段 */
    await page.waitForTimeout(1400)
    const persisted = await page.evaluate(async (id) => {
      const full = await window.yjai.draft.load(id)
      return (full?.data?.clips || []).length
    }, saved.id)
    check('落盘 · 草稿里也是 3 段（重开不会回到一整段）', persisted === 3, String(persisted))

    check('全程无页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } catch (error) {
    check('流程 · 未中途抛异常', false, error.message)
    aborted = error.message
  } finally {
    await closeApp(app)
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch {
      /* 删不掉就留着 */
    }
  }

  summary()
  process.exit(failures === 0 && !aborted ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
