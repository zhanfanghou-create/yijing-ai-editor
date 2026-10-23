#!/usr/bin/env node
/**
 * 客户端 E2E · HDR 素材标注。
 *
 * check-hdr 证明"导出真的做了色调映射"；这一道证明「界面**真的把这件事说出来了**」——
 * 主进程探到了 HLG、IPC 通了、右栏出现了那一行，三处缺一处，用户就还是"看着发灰不知道为啥"。
 * 这类缺陷是本项目的老对手：数据都对、界面一个字没有（第③类"接对了看不见"）。
 *
 * 判据取消费端：
 *   · IPC 返回的 `hdr/label`（不是界面上写着"HDR"这几个字）；
 *   · 右栏是否**真的渲染**出 `[data-asset-hdr]` 这一行，且文案里有 HLG；
 *   · 反向：普通 SDR 素材不许冒出这一行（假标注比不标注更坏）。
 *
 * 用法：node tools/hdr-e2e.mjs
 * 前置：`cd packages/desktop && vite build`，且本机有 ffmpeg
 * 退出码：0 通过 / 1 有失败 / 2 本机没有 ffmpeg（如实跳过）
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.hdr-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

/* 条数 = 下面 check() 的调用处（happy path 12 条；"前置"两条只在异常时走到） */
const TOTAL_ASSERTIONS = 12

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
  console.log(`HDR_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${passed} fail=${failures}`)
  if (!failures && !aborted) console.log('HDR_E2E_OK')
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
    /* 已经退了 */
  }
  await sleep(500)
}

async function waitFor(fn, timeout = 30000, gap = 300) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const hit = await fn()
    if (hit) return hit
    await sleep(gap)
  }
  return null
}

async function main() {
  console.log('=== HDR 标注 E2E（真 HLG 文件 → IPC → 右栏那一行）===\n')

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    console.log('HDR_E2E_SKIPPED 本机没有 ffmpeg')
    console.log('HDR_E2E_STATS total=0 pass=0 fail=0 skip=1')
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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-hdr-e2e-'))
  const hlgFile = path.join(work, '手机 HDR.mp4')
  const sdrFile = path.join(work, '普通.mp4')
  const base = ['-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']
  spawnCapture(found.ffmpeg, [
    ...base,
    '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
    '-color_trc', 'arib-std-b67', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc',
    hlgFile
  ], { tag: 'mk-hlg' })
  spawnCapture(found.ffmpeg, [...base, sdrFile], { tag: 'mk-sdr' })
  check('夹具 · HLG 与 SDR 两份片子都生成了', fs.existsSync(hlgFile) && fs.existsSync(sdrFile))

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

    /* ① IPC 层：探到的结论要对（错的结论会让界面标错，比不标更坏） */
    const probed = await page.evaluate((list) => window.yjai.media.hdr(list), [hlgFile, sdrFile])
    const hlg = (probed || []).find((item) => item.path === path.resolve(hlgFile)) || {}
    const sdr = (probed || []).find((item) => item.path === path.resolve(sdrFile)) || {}
    check('IPC · HLG 文件被判为 HDR', hlg.hdr === true, String(hlg.hdr))
    check('IPC · 标签说明是 HLG（不是笼统的"HDR"）', /HLG/.test(String(hlg.label)), String(hlg.label))
    check('IPC · 提示语说清导出会转 SDR', /导出/.test(String(hlg.hint)), String(hlg.hint))
    check('IPC · 普通文件不被误判成 HDR', sdr.hdr === false, String(sdr.hdr))
    check('IPC · 普通文件没有标注文案（界面不该冒出一行空的色彩）', sdr.label === '', String(sdr.label))

    /* ② 界面层：打开一份含 HDR 素材的草稿，点中片段，右栏要真的出现那一行 */
    const urls = await page.evaluate((list) => list.map((item) => window.yjai.media.url(item)), [hlgFile])
    await page.evaluate((list) => window.yjai.media.stat(list), [hlgFile])
    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: 'HDR 标注测试',
      data: {
        clips: [
          {
            id: 'c_hdr',
            track: 'video',
            kind: 'video',
            name: '手机 HDR',
            path: hlgFile,
            url: urls[0] || '',
            start: 0,
            duration: 2,
            offset: 0,
            sourceDuration: 2
          }
        ],
        assets: [{ id: 'a_hdr', kind: 'video', name: '手机 HDR', path: hlgFile, url: urls[0] || '', duration: 2 }],
        playhead: 0,
        volume: 80,
        zoom: 1
      }
    })
    check('夹具 · 草稿已写入', Boolean(saved?.id))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 15000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(900)
    await resize()
    await sleep(400)

    /* 点中片段 → 右栏「信息」页会显示它对应素材的属性 */
    await page.locator('.wb-tllane[data-lane="video"] .clip').first().click()
    const row = await waitFor(async () => {
      const count = await page.locator('[data-asset-hdr="1"]').count()
      if (!count) return null
      const text = await page.locator('[data-asset-hdr="1"]').first().innerText().catch(() => '')
      return /HLG/.test(text) ? text : null
    }, 20000)
    check('界面 · 右栏出现「色彩」一行且写着 HLG', Boolean(row), row ? String(row).replace(/\s+/g, ' ') : '没有这一行')

    const hint = await page.locator('[data-asset-hdr-hint="1"]').count()
    check('界面 · 同时给出"预览略灰、导出会转"的说明', hint >= 1, String(hint))

    /* 反向：换成 SDR 素材后这一行必须消失（否则等于给所有素材都贴了假标签） */
    const sdrUrl = await page.evaluate((filePath) => window.yjai.media.url(filePath), sdrFile)
    await page.evaluate((list) => window.yjai.media.stat(list), [sdrFile])
    const replaced = await page.evaluate(
      ({ draftId, filePath, url }) => {
        return window.yjai.draft.load(draftId).then((record) => {
          const data = record.data
          data.clips = data.clips.map((clip) => ({ ...clip, path: filePath, url, name: '普通' }))
          data.assets = data.assets.map((asset) => ({ ...asset, path: filePath, url, name: '普通' }))
          return window.yjai.draft.save({ id: draftId, name: record.name, data })
        })
      },
      { draftId: saved.id, filePath: sdrFile, url: sdrUrl }
    )
    check('夹具 · 已把草稿换成 SDR 素材', Boolean(replaced?.id))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 15000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(900)
    await page.locator('.wb-tllane[data-lane="video"] .clip').first().click()
    await sleep(1200)
    const sdrRows = await page.locator('[data-asset-hdr="1"]').count()
    check('反向 · SDR 素材不出现「色彩」行（不做假标注）', sdrRows === 0, String(sdrRows))

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
