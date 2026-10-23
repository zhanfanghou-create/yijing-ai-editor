#!/usr/bin/env node
/**
 * 客户端 E2E · 预览画质 / 代理文件。
 *
 * 这一道验的是「设置档位 → 真生成代理 → 预览真的换文件」这条链，以及
 * **一个必须成立的反向不变式**：素材表/草稿里的 path 不许被代理替换（导出永远用原片）。
 *
 * 判据全部取消费端：
 *   · 磁盘：`<userData>/proxies` 下真的出现 `-540p.mp4`（且有像素/有音轨）；
 *   · 预览：`<video>` 的 src **解码后**指向那个代理文件（不是"设置里写着 540p"）；
 *   · 反向：切回「完整」后 src 回到原片；草稿 JSON 里的 path 从头到尾没变。
 *
 * 用法：node tools/proxy-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.proxy-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/* 条数就是下面 check() **实际被调用的次数**：早先写死 11 而实际有 13 处，
   于是 summary 用 `total - failures` 反算出来的"通过数"是假的 —— 少算两条、
   却照样印 11/11 全绿。要数条数请直接数 check( 出现了几次。 */
const TOTAL_ASSERTIONS = 13

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
  console.log(`PROXY_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${passed} fail=${failures}`)
  if (!failures && !aborted) console.log('PROXY_E2E_OK')
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
    /* 进程可能已经退了 */
  }
  await sleep(500)
}

async function waitFor(fn, timeout = 90000, gap = 400) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const hit = await fn()
    if (hit) return hit
    await sleep(gap)
  }
  return null
}

const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

/** `yjai-media://local/<base64url(path)>` → 真实路径（判据要比"它指向哪个文件"） */
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
  console.log('=== 预览画质 / 代理 E2E（设置档位 → 真生成 → 预览换文件，导出仍用原片）===\n')

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    console.log('PROXY_E2E_SKIPPED 本机没有 ffmpeg')
    console.log('PROXY_E2E_STATS total=0 pass=0 fail=0 skip=1')
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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-proxy-e2e-'))
  const source = path.join(work, 'source1080.mp4')
  spawnCapture(
    found.ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source],
    { tag: 'mk-source' }
  )
  check('夹具 · 1080p 源已生成', fs.existsSync(source))
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

    const described = await page.evaluate((filePath) => window.yjai.media.stat([filePath]), source)
    const sourceUrl = await page.evaluate((filePath) => window.yjai.media.url(filePath), source)
    check('夹具 · 素材已登记且拿到 url', Array.isArray(described) && sourceUrl.startsWith('yjai-media://local/'),
      String(sourceUrl).slice(0, 36))

    const clips = [
      { id: 'c_src', track: 'video', kind: 'video', name: '源', path: source, url: sourceUrl, start: 0, duration: 4, offset: 0, sourceDuration: 4 }
    ]
    const assets = [
      { id: 'a_src', kind: 'video', name: '源', path: source, url: sourceUrl, duration: 4 }
    ]
    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: 'E2E 预览画质',
      data: { clips, assets, playhead: 1, volume: 80, zoom: 1 }
    })
    check('夹具 · 草稿已写入', Boolean(saved?.id))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(900)
    await resize()
    await sleep(400)

    const userData = await app.evaluate(async ({ app: electronApp }) => electronApp.getPath('userData'))
    const proxyDir = path.join(userData, 'proxies')
    const proxyFiles = () =>
      fs.existsSync(proxyDir) ? fs.readdirSync(proxyDir).filter((name) => name.endsWith('.mp4')) : []

    check('切档之前 · 代理目录是空的（不做"打开草稿就批量转一遍"）', proxyFiles().length === 0, String(proxyFiles().length))

    const previewSrc = () => page.evaluate(() => {
      const video = document.querySelector('.canvas-content video')
      return video ? video.getAttribute('src') || '' : ''
    })
    const before = await previewSrc()
    check('预览当前用的是原片', pathFromUrl(before) === source, pathFromUrl(before) || before)

    /* 打开设置 → 切到「极速 540p」 */
    await page.locator('.wb-menu-items button', { hasText: '设置' }).first().click()
    await page.waitForSelector('[data-settings-preview-quality]', { timeout: 10000 })
    const chips = await page.locator('[data-settings-preview-quality] [data-pq]').count()
    check('设置里出现三档预览画质', chips === 3, String(chips))

    await page.locator('[data-pq="fast"]').click()
    const made = await waitFor(() => (proxyFiles().length ? proxyFiles()[0] : null), 120000)
    check('切到 540p · 代理文件真的生成了', Boolean(made), String(made))
    check('代理文件名带 540p 后缀', Boolean(made) && /-540p\.mp4$/.test(made), String(made))

    const switched = await waitFor(async () => {
      const src = await previewSrc()
      return pathFromUrl(src) && pathFromUrl(src).includes('proxies') ? src : null
    }, 60000)
    check('预览换了文件（src 指向 proxies 目录，不是"设置里写着 540p"）', Boolean(switched),
      switched ? path.basename(pathFromUrl(switched)) : '仍用原片')

    const proxyPath = made ? path.join(proxyDir, made) : ''
    check('代理确实是 540p（真跑 ffprobe 读尺寸）', Boolean(proxyPath) && (() => {
      const result = spawnCapture(found.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', proxyPath], { tag: 'probe-h' })
      return Number(String(result.stdout || '').trim()) === 540
    })(), proxyPath ? path.basename(proxyPath) : '')

    /* 反向不变式：模型里的 path 不许被代理替换（导出读的是它） */
    const draftPath = await page.evaluate(async (id) => {
      const full = await window.yjai.draft.load(id)
      return full?.data?.clips?.[0]?.path || ''
    }, saved.id)
    check('草稿里的 path 仍是原片（导出永远用原片，代理只服务预览）', draftPath === source, draftPath)

    /* 切回「完整」：预览要回到原片（不是"要重启才生效"） */
    await page.locator('[data-pq="full"]').click()
    const back = await waitFor(async () => {
      const src = await previewSrc()
      return pathFromUrl(src) === source ? src : null
    }, 30000)
    check('切回完整 · 预览回到原片', Boolean(back), back ? '已回到原片' : '仍是代理')

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
