#!/usr/bin/env node
/**
 * 客户端 E2E · 素材包（菜单接线 → 真打包 → 真解包 → 打开新草稿并能播）。
 *
 * 纯逻辑那道闸门（check-pack）证明"算术对"；这一道证明「界面上点得到、点下去真发生」。
 * 两者分不开：`onExportPack` 没接到 TopBar 上，纯逻辑照样 54/54 全绿。
 *
 * 判据取消费端：
 *   · 磁盘：真的出现 `.yjpack`，包内 media/ 下文件数与素材数相等；
 *   · 包里的 draft.json：path 是 `media/...` 相对路径、url 已清空（否则对面读我这台机器）；
 *   · 导入后：草稿列表 +1、时间线渲染出片段、**预览 `<video>` 的 src 解码后落在
 *     `<userData>/packs/...`**（不是"设置里写着导入成功"）；
 *   · 反向：本机原草稿的 path 从头到尾没被改过（打包不该动源工程）。
 *
 * ⚠️ 原生对话框一律打桩（真弹框 = 用例永久卡住），并且**必须在页面加载后**打桩。
 *
 * 用法：node tools/pack-e2e.mjs
 * 前置：`cd packages/desktop && vite build`，且本机有 ffmpeg
 * 退出码：0 = 通过；1 = 有失败；2 = 本机没有 ffmpeg（如实跳过）
 */
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.pack-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

const zip = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'zip.js'))
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

/* 条数 = 下面 check() 的调用处数（happy path 15 条；"前置 · 找到 electron / 构建产物"
   只在异常时才会走到，所以不计入总数）。别再用 total - failures 反算通过数 —— 那是假的。 */
const TOTAL_ASSERTIONS = 15

let failures = 0
let passed = 0
let aborted = ''

function check(name, ok, detail = '') {
  if (ok) passed += 1
  else failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  console.log(`\n=== 结果：通过 ${passed} 项 / 失败 ${failures} 项 ===`)
  console.log(`PACK_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${passed} fail=${failures}`)
  if (!failures && !aborted) console.log('PACK_E2E_OK')
  return failures === 0 && !aborted && passed === TOTAL_ASSERTIONS
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
    /* 可能已经退了 */
  }
  await sleep(500)
}

async function waitFor(fn, timeout = 60000, gap = 300) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const hit = await fn()
    if (hit) return hit
    await sleep(gap)
  }
  return null
}

/** `yjai-media://local/<base64url(path)>` → 真实路径 */
function pathFromUrl(url) {
  const match = /^yjai-media:\/\/local\/([A-Za-z0-9_-]+)$/.exec(String(url || ''))
  if (!match) return ''
  try {
    return Buffer.from(match[1], 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

async function main() {
  console.log('=== 素材包 E2E（菜单 → 真打包 → 真解包 → 打开 → 预览指向解出来的文件）===\n')

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    console.log('PACK_E2E_SKIPPED 本机没有 ffmpeg')
    console.log('PACK_E2E_STATS total=0 pass=0 fail=0 skip=1')
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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-pack-e2e-'))
  const source = path.join(work, '画面-素材.mp4')
  const music = path.join(work, '配乐.wav')
  spawnCapture(
    found.ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25',
      '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source],
    { tag: 'mk-video' }
  )
  spawnCapture(
    found.ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '3', '-c:a', 'pcm_s16le', music],
    { tag: 'mk-audio' }
  )
  check('夹具 · 视频与音频都生成了', fs.existsSync(source) && fs.existsSync(music))

  const packPath = path.join(work, '导出测试.yjpack')
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

    /* 先把素材登记进白名单，再写一份引用它们的草稿 */
    const videoUrl = await page.evaluate((filePath) => window.yjai.media.url(filePath), source)
    const audioUrl = await page.evaluate((filePath) => window.yjai.media.url(filePath), music)
    await page.evaluate((list) => window.yjai.media.stat(list), [source, music])
    const clips = [
      { id: 'c_v', track: 'video', kind: 'video', name: '画面', path: source, url: videoUrl, start: 0, duration: 3, offset: 0, sourceDuration: 3 },
      { id: 'c_a', track: 'audio', kind: 'audio', name: '配乐', path: music, url: audioUrl, start: 0, duration: 3, offset: 0, sourceDuration: 3 }
    ]
    const assets = [
      { id: 'a_v', kind: 'video', name: '画面', path: source, url: videoUrl, duration: 3 },
      { id: 'a_a', kind: 'audio', name: '配乐', path: music, url: audioUrl, duration: 3 }
    ]
    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: '打包测试工程',
      data: { clips, assets, playhead: 0.5, volume: 80, zoom: 1, aspect: '16:9' }
    })
    check('夹具 · 草稿已写入（2 段素材）', Boolean(saved?.id))

    /* 打桩：保存对话框 → 固定包路径；打开对话框 → 那个包 */
    const patched = await app.evaluate(async ({ dialog }, payload) => {
      const done = []
      if (typeof dialog.showSaveDialog === 'function') {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: payload.out })
        done.push('save')
      }
      if (typeof dialog.showOpenDialog === 'function') {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [payload.out] })
        done.push('open')
      }
      return done
    }, { out: packPath })
    check('打桩 · 两个原生对话框都替换成功', Array.isArray(patched) && patched.length === 2, JSON.stringify(patched))

    /* 打开草稿并确认菜单里有那两项 */
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 15000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(900)
    await resize()
    await sleep(400)

    await page.locator('[data-menu-trigger="file"]').click()
    const itemCount = await page.locator('[data-menu-item^="pack-"]').count()
    check('「文件」菜单里出现导出/导入素材包两项', itemCount === 2, String(itemCount))

    /* 导出 */
    await page.locator('[data-menu-item="pack-export"]').click()
    const made = await waitFor(() => (fs.existsSync(packPath) ? fs.statSync(packPath).size : 0), 60000)
    check('导出 · 磁盘上真的出现了 .yjpack', Boolean(made) && made > 100, `${made} bytes`)

    const entries = made ? zip.readZip(packPath) : []
    const mediaEntries = entries.filter((item) => item.name.startsWith('media/'))
    check('包内 · media 下 2 个素材（与草稿引用数相等）', mediaEntries.length === 2, String(mediaEntries.length))
    check('包内 · 中文素材名完好', mediaEntries.some((item) => /画面|配乐/.test(item.name)),
      mediaEntries.map((item) => item.name).join(','))

    const packedDraft = entries.find((item) => item.name === 'draft.json')
    const packedJson = packedDraft ? JSON.parse(packedDraft.data.toString('utf8')) : null
    check('包里的草稿 · path 改成相对路径且 url 清空',
      Boolean(packedJson) &&
        packedJson.clips.every((clip) => /^media\//.test(clip.path) && !clip.url),
      packedJson ? packedJson.clips.map((clip) => `${clip.path}|${clip.url ? 'url还在' : 'no-url'}`).join(' , ') : 'no draft.json')
    check('包里的草稿 · 比例跟着包走（aspect=16:9 没丢）', packedJson?.aspect === '16:9', String(packedJson?.aspect))

    /* 反向不变式：本机原草稿没被打包改过 */
    const originalPath = await page.evaluate(async (id) => {
      const full = await window.yjai.draft.load(id)
      return full?.data?.clips?.[0]?.path || ''
    }, saved.id)
    check('本机原草稿的 path 没被改动（打包不该动源工程）', originalPath === source, originalPath)

    /* 导入：把刚打的包当成别人的包打开 */
    const before = await page.evaluate(() => window.yjai.draft.list())
    await page.locator('[data-menu-trigger="file"]').click()
    await page.locator('[data-menu-item="pack-import"]').click()
    const grown = await waitFor(async () => {
      const list = await page.evaluate(() => window.yjai.draft.list())
      return list.length > before.length ? list : null
    }, 60000)
    check('导入 · 草稿列表多了一份（不覆盖同名工程）', Boolean(grown), grown ? String(grown.length) : '没变')

    /* 导入成功后界面会自动打开那份草稿：看时间线与预览是不是真指向解出来的文件 */
    const opened = await waitFor(async () => {
      const name = await page.locator('.wb-menu-title').inputValue().catch(() => '')
      return /打包测试工程/.test(String(name)) ? name : null
    }, 30000)
    check('导入 · 界面自动打开了新草稿', Boolean(opened), String(opened))

    await page.waitForSelector('.wb-timeline .clip', { timeout: 15000 })
    const clipCount = await page.locator('.wb-timeline .clip').count()
    check('导入 · 时间线渲染出 2 段片段', clipCount === 2, String(clipCount))

    const video = await waitFor(async () => {
      const src = await page.evaluate(() => {
        const node = document.querySelector('.canvas-content video')
        return node ? node.getAttribute('src') || '' : ''
      })
      const decoded = pathFromUrl(src)
      return decoded && decoded.includes(`${path.sep}packs${path.sep}`) ? decoded : null
    }, 30000)
    check('导入 · 预览读的是解出来的文件（不是原机器的绝对路径）', Boolean(video),
      video ? path.basename(video) : '未换到 packs 目录')

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
