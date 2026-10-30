#!/usr/bin/env node
/**
 * 客户端 E2E · 导出面板的「编码格式」真的驱动下游。
 *
 * 为什么纯逻辑闸门不够（已经有 export-codec-selftest 48 条 + 契约闸门的静态判据）：
 * 那两道证明的是"表对、接线在"，而**控件按下去到表之间**还有三根线，断任何一根都表现为
 * "下拉能选、选完什么都没发生"，且构建、静态扫描、纯逻辑夹具全绿：
 *   ① `onChange` 没写（下拉是受控的，选了会弹回去，字面上"根本没变"）；
 *   ② 写了 `setCodec` 但没重算编码器候选 ⇒ H.265 的下拉里还是 h264_nvenc，
 *      真按下去 ffmpeg 报 "Unknown encoder"，而面板上看不出任何不对；
 *   ③ 换了格式但输出路径没跟着改扩展名 ⇒ 选 ProRes 时仍是 .mp4，
 *      直到封装那一步才失败（`Could not find tag for codec prores`）。
 *
 * 所以判据一律取**消费端**（DOM 里读回来的值）：
 *   · 编码格式下拉的 value 与「扩展名」提示文字；
 *   · 视频编码下拉里**实际有哪些 option**（不是"应该有哪些"）；
 *   · ProRes 时码率控制那组控件是否真的收起来了（留着能点、点了没用 = 骗人）。
 *
 * 用法：node tools/export-panel-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.export-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/** 夹具：一段文字素材就够 —— 导出面板只要有内容就会显示完整设置 */
const ASSETS = [{ id: 'a_x', kind: 'text', name: '文字甲', text: '导出面板', url: '' }]
const CLIPS = [
  { id: 'c_x', track: 'video', assetId: 'a_x', name: '片段甲', kind: 'text', start: 0, duration: 2, offset: 0, sourceDuration: 2 }
]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 16
/** 看门狗：到点强退，不让它把 verify 挂死 */
const WATCHDOG_MS = 5 * 60 * 1000

let failures = 0
let ran = 0
let aborted = ''

function check(name, ok, detail = '') {
  ran += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  /* ⚠️ 不许用「总数 − 失败数」反算通过数：某项被注掉 / 提前 return 时，
     反算会把少跑的那几项算成绿的。实际跑了几项单独计数并核对。 */
  let coverage = 0
  if (ran !== TOTAL_ASSERTIONS) {
    coverage = 1
    console.log(`  [FAIL] 断言覆盖 · 期望 ${TOTAL_ASSERTIONS} 项，实际只跑了 ${ran} 项`)
  }
  const fail = failures + coverage
  const pass = ran - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  console.log(`EXPORT_PANEL_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail}`)
  if (!fail && !aborted) console.log('EXPORT_PANEL_E2E_OK')
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

/** 读一个 select 的全部 option 值 */
const optionValues = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    return Array.from(el.options).map((option) => option.value)
  }, selector)

/** 选中某一项并等界面稳定（受控 select 要等重渲染） */
async function choose(page, selector, value) {
  await page.selectOption(selector, value)
  await sleep(280)
}

async function main() {
  console.log('=== 导出面板「编码格式」E2E（真启 Electron + 真操作下拉）===\n')

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
    await sleep(1500)
    await resize()

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 导出编码', data: { clips: CLIPS, assets: ASSETS, playhead: 0.5, volume: 80, zoom: 1 } }
    )
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(700)
    await resize()
    await sleep(300)

    /* ---------------------------- 打开导出面板 ---------------------------- */
    await page.locator('.wb-export').first().click()
    const opened = await page
      .waitForSelector('[data-export-codec]', { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    check('点导出按钮后编码格式下拉出现', opened)
    if (!opened) {
      aborted = '导出面板没打开'
      return summary()
    }
    await sleep(400)

    /* ------------------ 1. 默认是 H.264，五档格式都在 ------------------ */
    const defCodec = await page.locator('[data-export-codec]').inputValue()
    check('默认编码格式是 h264（与旧版导出行为一致，不擅自变格式）', defCodec === 'h264', defCodec)

    const codecOpts = await optionValues(page, '[data-export-codec]')
    check(
      '编码格式下拉有五档（H.264 / H.265 / H.265 10bit / ProRes 422 / ProRes 4444）',
      Array.isArray(codecOpts) && codecOpts.length === 5,
      (codecOpts || []).join(',')
    )

    const h264Encoders = await optionValues(page, '[data-export-encoder]')
    check(
      'H.264 时视频编码候选里没有 hevc / prores（候选必须按族过滤）',
      Array.isArray(h264Encoders) &&
        h264Encoders.length > 0 &&
        h264Encoders.every((key) => /^libx264$|^h264_/.test(key)),
      (h264Encoders || []).join(',')
    )

    /* ------------------ 2. 切到 H.265 10bit ------------------ */
    await choose(page, '[data-export-codec]', 'h265-10')
    const after265 = await page.locator('[data-export-codec]').inputValue()
    check('选 H.265 10bit 后下拉停在 h265-10（受控 select 没弹回去）', after265 === 'h265-10', after265)

    const hevcEncoders = await optionValues(page, '[data-export-encoder]')
    check(
      '切到 H.265 后视频编码候选全换成 hevc 族（h264_* 一个都不许留）',
      Array.isArray(hevcEncoders) &&
        hevcEncoders.length > 0 &&
        hevcEncoders.every((key) => /^libx265$|^hevc_/.test(key)),
      (hevcEncoders || []).join(',')
    )

    const ext265 = await page.locator('[data-export-codec-ext]').getAttribute('data-export-codec-ext')
    check('H.265 的容器提示是 mp4', ext265 === 'mp4', String(ext265))

    /* ------------------ 3. 切到 ProRes 4444 ------------------ */
    await choose(page, '[data-export-codec]', 'prores-4444')
    const proresEncoder = await page.locator('[data-export-encoder]').inputValue()
    check('选 ProRes 4444 后视频编码自动落到 prores_ks（不跨族回落）', proresEncoder === 'prores_ks', proresEncoder)

    const extProres = await page.locator('[data-export-codec-ext]').getAttribute('data-export-codec-ext')
    check('ProRes 4444 的容器提示变成 mov（扩展名跟着格式走）', extProres === 'mov', String(extProres))

    /* 码率控制那组控件对 ProRes 不生效：必须收起来，并给出说明。
       留着"能点、点了没用"比不摆更糟 —— 用户会以为调过了。 */
    const bitrateChips = await page.locator('[data-export-bitrate-mode]').count()
    const proresNote = await page.locator('[data-export-prores-note]').count()
    check('ProRes 时码率控制控件收起来了（没有「点了没反应」的控件）', bitrateChips === 0, `实测 ${bitrateChips} 个`)
    check('ProRes 时给出「固定质量编码」的说明文字', proresNote === 1, `实测 ${proresNote} 个`)

    /* 按钮上的容器名：这是用户最后一眼看到的东西。⚠️ 必须在 ProRes 时断言 ——
       写死「导出成片（MP4）」的话，在 H.264 状态下断言 MP4 照样通过，等于没验。 */
    const btnLabel = await page.locator('[data-export-submit]').textContent().catch(() => null)
    check('导出按钮上的容器名跟着编码格式走（ProRes 时写 MOV）',
      typeof btnLabel === 'string' && /MOV/.test(btnLabel), String(btnLabel))

    /* ------------------ 4. 切回 H.264 ------------------ */
    await choose(page, '[data-export-codec]', 'h264')
    const backChips = await page.locator('[data-export-bitrate-mode]').count()
    const backEncoder = await page.locator('[data-export-encoder]').inputValue()
    check('切回 H.264 后码率控制控件回来了', backChips === 1, `实测 ${backChips} 个`)
    check('切回 H.264 后编码器回到 libx264', backEncoder === 'libx264', backEncoder)

    check('全程没有前端异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

    return summary()
  } catch (error) {
    console.error('\n[异常] ' + String((error && error.stack) || error))
    check('未中途抛异常', false, String((error && error.message) || error).slice(0, 200))
    aborted = '异常'
    return summary()
  } finally {
    await closeApp(app)
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true })
    } catch {
      /* 删不掉不影响结论 */
    }
  }
}

const watchdog = setTimeout(() => {
  console.log('\n[看门狗] 超时，强退')
  aborted = 'watchdog'
  summary()
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref?.()

main()
  .then((ok) => {
    process.exit(ok ? 0 : 1)
  })
  .catch((error) => {
    console.error('[致命] ' + String((error && error.stack) || error))
    process.exit(1)
  })
