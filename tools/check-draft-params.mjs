#!/usr/bin/env node
/**
 * 闸门 · 草稿参数面板（无选中时右栏那一屏）+ 视频片段底部真波形。
 *
 * ---------------------------------------------------------------------------
 * 这道闸门要挡的是什么
 * ---------------------------------------------------------------------------
 * 参考客户端在**没选中任何东西**时，右栏显示的是「草稿参数」而不是一片空白。
 * 这一屏最容易被做成装饰：把 12 行字段写死成字符串，看着一模一样，
 * 但「比例」改了分辨率不动、「保存位置」是编的、「修改」点了没反应 ——
 * 全是**静态扫描全绿、构建全绿**的静默失效。所以判据一律读**消费端**：
 *
 *   · 分辨率必须由比例**算出来**（改 16:9 → 1:1，数字要跟着变）；
 *   · 保存位置必须是主进程真实落盘目录（不是写死的示例路径）；
 *   · 「修改」必须真的切出可编辑控件，且改完立刻反映到同一屏的只读行上。
 *
 * 同屏顺带钉住视频片段底部那条波形：它由主进程 ffmpeg 抽**真 PCM** 算出，
 * 判据是画布上的像素 —— 要求**有绘制**且**列高不唯一**（一条等高的假直条
 * 也会被"画出来了"骗过去，所以两条一起判）。
 *
 * ---------------------------------------------------------------------------
 * 真值（写死，不 import 被测代码）
 * ---------------------------------------------------------------------------
 *   · 比例表       1:1 / 1:2 / 3:4 / 9:16 / 16:9 / 4:3 / 2:1（shared/aspect.js）
 *   · 基准分辨率   1920 × 1080（16:9 时输出就是它；1:1 时裁成 1080 × 1080）
 *   · 波形条       .clip-wave-inline，贴在视频 / 叠加片段底部
 *
 * ---------------------------------------------------------------------------
 * 反空洞约定
 * ---------------------------------------------------------------------------
 * · 每步先断言前置（面板在、字段在），否则后面会在空集上"通过"；
 * · 真波形不在这里判（这一屏夹具是文字素材，没有 PCM 可抽）——
 *   由 real-film 那道闸按画布像素钉住；宁可挪走也不留恒跳过的 SKIP；
 * · 收尾 withTimeout(app.close) + taskkill + 强制 exit（裸 close 本机永不返回）；
 * · ⚠️ 跑的是 dist-renderer 构建产物，改完渲染层要先构建。
 *
 * 用法：
 *   node tools/check-draft-params.mjs              # 真起 Electron 验证
 *   node tools/check-draft-params.mjs --selftest   # 只跑判据自证（秒级）
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.draft-params-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/* --------------------------------------------------------- 静态接线契约（纯函数） */

/**
 * 草稿参数面板的接线事实。每条都是「少一根线就变装饰」的那种：
 *   · Inspector 无选中时渲染 data-draft-panel，且分辨率是**算出来的**
 *   · App 把真实的落盘目录与比例/时间线名传进来
 */
function draftPanelContract({ inspectorSrc, appSrc }) {
  const strip = (text) => String(text || '').replace(/\/\*[\s\S]*?\*\//g, '')
  const ins = strip(inspectorSrc)
  const app = strip(appSrc)

  const facts = {
    panelHook: {
      // ⚠️ 必须带 ="1"：只查 `data-draft-panel` 会被 `data-draft-panelx` 蒙过去（子串假绿）
      ok: ins.includes('data-draft-panel="1"') && ins.includes('DRAFT_FLAGS'),
      detail: 'Inspector 缺 data-draft-panel（无选中时的草稿参数没有落点）'
    },
    resolutionComputed: {
      ok: ins.includes('outputSizeFor(') && ins.includes('data-draft-resolution'),
      detail: '分辨率不是由比例算出来的（写死 1920×1080 ⇒ 改比例时它不动，是装饰）'
    },
    saveLocationReal: {
      ok: app.includes('saveLocation={') && app.includes('userData'),
      detail: '保存位置不是主进程真实目录（编一个示例路径就是装饰）'
    },
    editableFields: {
      ok: ins.includes('data-draft-field="name"') && ins.includes('data-draft-field="aspect"') && ins.includes('data-draft-field="timelineName"'),
      detail: '「修改」没切出可编辑控件（按钮点了没反应）'
    },
    writeBack: {
      ok: app.includes('onTimelineNameChange={changeTimelineName}') && app.includes('onAspect={(next) => setAspect('),
      detail: '时间线名 / 比例没写回 App（编辑了等于没改）'
    }
  }
  const failed = Object.entries(facts).filter(([, item]) => !item.ok)
  return { ok: failed.length === 0, detail: failed.map(([key, item]) => `${key}(${item.detail})`).join('; '), facts }
}

/* --------------------------------------------------------- 真机夹具（写死） */

const CLIPS = [
  {
    id: 'c_video1',
    track: 'video',
    assetId: 'a_text1',
    name: '草稿参数闸门甲',
    kind: 'text',
    start: 0,
    duration: 4,
    offset: 0,
    sourceDuration: 4
  }
]

const ASSETS = [{ id: 'a_text1', kind: 'text', name: '文字素材甲', text: '草稿参数闸门', url: '' }]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 9

/* --------------------------------------------------------- 输出与收尾 */

let emitted = 0
let failures = 0
let aborted = ''

function check(name, ok, detail = '') {
  emitted += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function summary() {
  const pass = TOTAL_ASSERTIONS - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${failures} 项 ===`)
  console.log(`DRAFT_PARAMS_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('DRAFT_PARAMS_OK')
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

/** 收尾先礼后兵（裸 app.close() 在本机会永不返回） */
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

/* --------------------------------------------------------- 自检 */

function selftest() {
  console.log('=== 草稿参数接线判据自检（正控制组 + 逐条扰动）===\n')

  const GOOD = {
    inspectorSrc: [
      'export default function Inspector({ saveLocation = "", aspect = "16:9" }) {',
      '  const output = outputSizeFor(1920, 1080, aspect)',
      '  const DRAFT_FLAGS = [["色彩空间", "标准（SDR）"]]',
      '  return (',
      '    <section className="wb-draft" data-draft-panel="1">',
      '      <strong data-draft-resolution={`${output.width}×${output.height}`}>',
      '      <input data-draft-field="name" />',
      '      <input data-draft-field="timelineName" />',
      '      <select data-draft-field="aspect" />',
      '    </section>',
      '  )',
      '}'
    ].join('\n'),
    appSrc: [
      'saveLocation={info?.userData ? `${info.userData}\\drafts` : ""}',
      'onTimelineNameChange={changeTimelineName}',
      'onAspect={(next) => setAspect(normalizeAspect(next))}'
    ].join('\n')
  }

  const base = draftPanelContract(GOOD)
  check('自检 · 正控制组全绿', base.ok, base.detail)

  const cases = [
    ['panelHook', (g) => { g.inspectorSrc = g.inspectorSrc.replace('data-draft-panel="1"', 'data-draft-panel="0"') }],
    ['resolutionComputed', (g) => { g.inspectorSrc = g.inspectorSrc.replace('outputSizeFor(', 'outputSizeForX(') }],
    ['saveLocationReal', (g) => { g.appSrc = g.appSrc.replace('saveLocation={info?.userData ? `${info.userData}\\drafts` : ""}', 'saveLocation="C:\\示例"') }],
    ['editableFields', (g) => { g.inspectorSrc = g.inspectorSrc.replace('data-draft-field="aspect"', 'data-draft-field="aspectX"') }],
    ['writeBack', (g) => { g.appSrc = g.appSrc.replace('onTimelineNameChange={changeTimelineName}', 'onTimelineNameChange={undefined}') }]
  ]

  for (const [key, breakIt] of cases) {
    const clone = { inspectorSrc: GOOD.inspectorSrc, appSrc: GOOD.appSrc }
    breakIt(clone)
    const result = draftPanelContract(clone)
    const hit = !result.ok && !result.facts[key].ok
    const others = Object.entries(result.facts).filter(([k, item]) => k !== key && !item.ok)
    check(`自检 · 扰动 ${key} 判红${others.length ? `（误伤：${others.map(([k]) => k).join('/')}）` : ''}`, hit, result.detail)
  }

  const total = cases.length + 1
  console.log(`\nDRAFT_PARAMS_SELFTEST_STATS total=${total} pass=${failures === 0 ? total : total - failures} fail=${failures}`)
  if (failures) {
    console.log('DRAFT_PARAMS_SELFTEST_FAILED')
    process.exitCode = 1
  } else {
    console.log('DRAFT_PARAMS_SELFTEST_OK')
    process.exitCode = 0
  }
}

/* --------------------------------------------------------- 真机主流程 */

async function main() {
  console.log('=== 草稿参数与片段波形闸门（真启 Electron + 真点击 + 真读渲染）===\n')

  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, `找不到 ${EXE}`)
    aborted = 'electron 不存在'
    return summary()
  }
  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 已构建 dist-renderer', false, '先跑 vite build')
    aborted = '没有构建产物'
    return summary()
  }

  const pageErrors = []
  let app = null

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
    await sleep(1800)
    await resize()
    await sleep(600)

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 草稿参数', data: { clips: CLIPS, assets: ASSETS, playhead: 0, volume: 80, zoom: 1 } }
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

    /* ---------- 草稿参数：无选中时右栏那一屏 ---------- */

    const panelCount = await page.locator('[data-draft-panel]').count()
    check('无选中 · 右栏出现「草稿参数」面板', panelCount === 1, `实测 ${panelCount} 个`)

    const location = await page.evaluate(() => {
      const el = document.querySelector('[data-draft-group="draft"] .wb-path')
      return el ? { text: el.textContent.trim(), title: el.getAttribute('title') || '' } : null
    })
    check(
      '保存位置 · 是主进程真实落盘目录（不是编的示例路径）',
      Boolean(location) && /drafts$/i.test(location.text) && /[\\/]/.test(location.text),
      location ? location.text : '（没有这一行）'
    )

    const resBefore = await page.evaluate(() => {
      const el = document.querySelector('[data-draft-resolution]')
      return el ? el.getAttribute('data-draft-resolution') : ''
    })
    check('分辨率 · 16:9 时是 1920×1080', resBefore === '1920×1080', `实测 ${resBefore || '（无）'}`)

    /* ---------- 「修改」真的切出可编辑控件 ---------- */

    const editBtn = page.locator('[data-draft-edit]')
    const beforeInputs = await page.locator('[data-draft-field]').count()
    await editBtn.click()
    await sleep(300)
    const afterInputs = await page.locator('[data-draft-field]').count()
    check(
      '修改 · 切出三个可编辑控件（草稿名 / 时间线名 / 比例）',
      beforeInputs === 0 && afterInputs === 3,
      `修改前 ${beforeInputs} → 修改后 ${afterInputs}`
    )

    /* 改比例：分辨率必须跟着算（这条是"分辨率不是写死的"的硬判据） */
    await page.locator('[data-draft-field="aspect"]').selectOption('1:1')
    await sleep(400)
    const resAfter = await page.evaluate(() => {
      const el = document.querySelector('[data-draft-resolution]')
      return el ? el.getAttribute('data-draft-resolution') : ''
    })
    check('改比例 · 分辨率跟着重算（16:9→1:1 得 1080×1080）', resAfter === '1080×1080', `实测 ${resAfter || '（无）'}`)

    /* 改时间线名：收起后同一行的只读文本要变成新值（证明改的是真字段） */
    await page.locator('[data-draft-field="timelineName"]').fill('主线时间线')
    await sleep(300)
    await editBtn.click()
    await sleep(300)
    const shownName = await page.evaluate(() => {
      const el = document.querySelector('[data-draft-group="timeline"]')
      if (!el) return ''
      const row = Array.from(el.querySelectorAll('.wb-field')).find((item) => item.textContent.includes('时间线名称'))
      const strong = row && row.querySelector('strong')
      return strong ? strong.textContent.trim() : ''
    })
    check('改时间线名 · 收起后同一行显示新值（写的是真字段）', shownName === '主线时间线', `实测「${shownName}」`)

    /* 落盘：重开后还在。
       ⚠️ 自动保存有 1.2 秒防抖，改完就 reload 会抢在落盘之前 ——
       那时读到的还是旧值，闸门会红得莫名其妙。等够再走。 */
    await sleep(1800)
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(600)
    const persistedRes = await page.evaluate(() => {
      const el = document.querySelector('[data-draft-resolution]')
      return el ? el.getAttribute('data-draft-resolution') : ''
    })
    check('落盘 · 重启后比例与分辨率还在（1:1）', persistedRes === '1080×1080', `实测 ${persistedRes || '（无）'}`)

    /* 波形不在这里判：这一屏的夹具是文字素材（没有真实媒体文件，
       画不出 PCM）。真波形由 real-film 那道闸（真影片）按画布像素钉住 ——
       恒跳过等于该闸在这两条上完全失效，所以宁可挪走也不留 SKIP。 */

    if (pageErrors.length) {
      check('全程无页面错误', false, pageErrors.slice(0, 3).join(' | '))
    } else {
      check('全程无页面错误', true)
    }
  } catch (error) {
    console.error(error)
    check('流程 · 未中途抛异常', false, error.message)
    aborted = error.message
  } finally {
    await closeApp(app)
  }

  while (emitted < TOTAL_ASSERTIONS) check('（中途异常，本项未执行）', false)
  summary()
  /* 强制退出：Electron 的句柄挂在本机上不自己退（见 check-layout-split 同款） */
  process.exit(failures === 0 && !aborted ? 0 : 1)
}

if (process.argv.includes('--selftest')) {
  selftest()
} else {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
