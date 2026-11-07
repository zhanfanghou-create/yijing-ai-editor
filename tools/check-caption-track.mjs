#!/usr/bin/env node
/**
 * 客户端 E2E · 「字幕轨」是右栏的一枚**轨级**页签，且**只在字幕相关操作时出现**。
 *
 * 为什么要有这道闸：
 * 这块清单原来挂在**中栏**「文字」「字幕」两页的底部（同一个组件被调两遍）。
 * 2026-11-02 Jason：「字幕轨单独放到右侧窗口信息标签后面」，随后补一句
 * 「只有在添加编辑字幕时标签才显示，不是有字幕时」。三件事都不许静默退化：
 *   ① 挪了一份、原处还留一份 ⇒ 两处看同一份清单，且两边会越走越不一样；
 *   ② 页签在**任何**页面上都摆着 ⇒ 在「素材/滤镜」页点进去只能看一份与手上无关的清单；
 *   ③ 点一行不定位 ⇒ 清单退化成只读目录，"看清单 → 定位 → 改样式"断在半途。
 *
 * 显隐的判据是**此刻在不在做字幕的事**（中栏停在「文字」/「字幕」页，或选中的是字幕片段），
 * 不是"轨上有没有字幕" —— 空轨时在「字幕」页仍然要能点进去看那句"还没字幕"。
 *
 * 判据一律读**消费端**（DOM / 属性）：
 *   · 页签顺序读 `[data-insp-tab]` 的实际顺序（不是读常量表）；
 *   · 清单条数读渲染出来的 `.wb-caps-row` 行数（不是读 clips 数组）；
 *   · 定位读时间线 `[data-playhead]` 的秒数（不读 state）。
 *
 * 用法：node tools/check-caption-track.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.captrack-${process.pid}`)

/** 夹具：24 段字幕（够让面板真的出现滚动条）+ 一段视频（让"清空只删字幕"可判） */
const SEG = 24
const CLIPS = [
  {
    id: 'c_v', track: 'video', assetId: 'a_v', name: '主视频', kind: 'text',
    start: 0, duration: 16, offset: 0, sourceDuration: 16
  },
  ...Array.from({ length: SEG }, (_, i) => ({
    id: `ct_${String(i + 1).padStart(2, '0')}`,
    track: 'text',
    assetId: '',
    name: `字幕 ${i + 1}`,
    kind: 'text',
    start: Number((i * 0.6).toFixed(2)),
    duration: 4,
    offset: 0,
    sourceDuration: 4,
    text: `第 ${i + 1} 句字幕`,
    textStyle: i % 3 === 0 ? 'title-hero' : 'sub-plain'
  }))
]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 11
/** 看门狗：到点强退，不让它把 verify 挂死 */
const WATCHDOG_MS = 4 * 60 * 1000

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
     反算会把少跑的那几项算成绿的。 */
  let coverage = 0
  if (ran !== TOTAL_ASSERTIONS) {
    coverage = 1
    console.log(`  [FAIL] 断言覆盖 · 期望 ${TOTAL_ASSERTIONS} 项，实际只跑了 ${ran} 项`)
  }
  const fail = failures + coverage
  const pass = ran - failures
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  console.log(`CAPTION_TRACK_E2E_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail}`)
  if (!fail && !aborted) console.log('CAPTION_TRACK_E2E_OK')
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
    /* 已经退了 */
  }
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })

  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.YIJAI_USE_DEV_SERVER

  const app = await electron.launch({
    executablePath: EXE,
    args: [
      MAIN,
      '--no-sandbox',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      '--user-data-dir=' + PROFILE
    ],
    cwd: ROOT,
    env
  })

  try {
    const page = await app.firstWindow()
    const errs = []
    page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push('[console.error] ' + m.text())
    })

    await page.waitForSelector('.app', { timeout: 30000 })
    await sleep(1200)

    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: '字幕轨闸门', data: { clips: CLIPS, assets: [], playhead: 0, volume: 80, zoom: 40 } }
    )
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(900)

    async function resize(w, h) {
      await app.evaluate(
        async ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) return
          if (win.isMaximized()) win.unmaximize()
          win.setContentSize(size.w, size.h)
        },
        { w, h }
      )
      await sleep(600)
    }

    const tabsOf = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-insp-tab]')).map((el) => el.getAttribute('data-insp-tab'))
      )

    await resize(1600, 900)

    console.log('\n-- 一、什么时候出现 --\n')

    /* 初态：中栏停在「素材」页、什么都没选中 —— 轨上虽然有 24 段字幕，但此刻不是在字幕操作，
       所以这枚页签**不该出现**（Jason：「不是有字幕时」）。 */
    const idleTabs = await tabsOf()
    check(
      '1. 「素材」页、无选中 · 轨上有 24 段字幕，但「字幕轨」页签不出现',
      idleTabs.join(',') === 'info',
      idleTabs.join(',') || '(一个都没有)'
    )

    await page.locator('[data-wb-tab="subtitle"]').click()
    await sleep(600)
    const subTabs = await tabsOf()
    check(
      '2. 切到「字幕」页（添加/换样式）· 页签出现，且紧跟「信息」',
      subTabs.join(',') === 'info,captions',
      subTabs.join(',') || '(一个都没有)'
    )

    /* 编辑也不算例外：在「素材」页上选中一条**字幕片段**，仍然属于字幕操作 */
    await page.locator('[data-wb-tab="media"]').click()
    await sleep(600)
    await page.locator('.clip[data-clip="ct_05"]').click()
    await sleep(500)
    const editTabs = await tabsOf()
    check(
      '3. 「素材」页上选中一条字幕片段（正在编辑它）· 页签仍在，且排在「信息」后面',
      editTabs.join(',') === 'info,captions,text',
      editTabs.join(',') || '(一个都没有)'
    )

    /* 选中视频片段 = 不在做字幕的事 ⇒ 页签收起来 */
    await page.locator('.clip[data-clip="c_v"]').click()
    await sleep(500)
    const videoTabs = await tabsOf()
    check(
      '4. 「素材」页上选中视频片段（非字幕操作）· 页签收起',
      videoTabs.join(',') === 'info,visual,audio,speed,adjust',
      videoTabs.join(',') || '(一个都没有)'
    )

    console.log('\n-- 二、字幕轨页 = 整条轨 --\n')

    await page.locator('[data-wb-tab="subtitle"]').click()
    await sleep(600)
    await page.locator('[data-insp-tab="captions"]').click()
    await sleep(500)

    const caps = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.wb-caps-row'))
      const first = rows[0]
      return {
        rows: rows.length,
        declared: Number(document.querySelector('[data-caption-count]')?.dataset.captionCount || -1),
        firstText: first?.querySelector('.wb-caps-text')?.textContent || '',
        firstMeta: first?.querySelector('.wb-caps-meta')?.textContent || '',
        scrolls: (() => {
          const body = document.querySelector('.wb-info-body')
          return body ? body.scrollHeight > body.clientHeight + 2 : false
        })()
      }
    })
    check(
      '5. 点进「字幕轨」· 列出整条轨（24 段，不是空屏、也不是只列选中的那条）',
      caps.rows === SEG && caps.declared === SEG,
      `渲染 ${caps.rows} 行；角标声明 ${caps.declared}`
    )
    check(
      '6. 每行两段信息：正文在上、「起点 · 时长 · 样式」在下（格式与参考一致）',
      caps.firstText === '第 1 句字幕' && /^\d{2}:\d{2}:\d{2} 起 · \d+\.\ds · .+$/.test(caps.firstMeta),
      `正文=${JSON.stringify(caps.firstText)} meta=${JSON.stringify(caps.firstMeta)}`
    )
    check('7. 24 段超过可视高度 · 面板内滚动（而不是把页签条顶出去）', caps.scrolls === true, `需滚动=${caps.scrolls}`)

    console.log('\n-- 三、点一行 → 定位 --\n')

    await page.locator('.wb-caps-row').nth(4).click()
    await sleep(500)
    const pick = await page.evaluate(() => ({
      playhead: document.querySelector('[data-playhead]')?.dataset.playhead,
      onRows: Array.from(document.querySelectorAll('.wb-caps-row.on')).map((el) => el.dataset.captionRow),
      tab: Array.from(document.querySelectorAll('[data-insp-tab].on')).map((el) => el.dataset.inspTab)
    }))
    check(
      '8. 点第 5 行 · 播放头落到它起点 2.400s、该行高亮、页签不跳回「信息」',
      pick.playhead === '2.400' && pick.onRows.join(',') === 'ct_05' && pick.tab.join(',') === 'captions',
      `播放头=${pick.playhead} 高亮=${pick.onRows.join(',')} 页签=${pick.tab.join(',')}`
    )

    console.log('\n-- 四、中栏不再重复一份 --\n')

    await page.locator('[data-wb-tab="text"]').click()
    await sleep(700)
    const pane = await page.evaluate(() => {
      const el = document.querySelector('.pane')
      return {
        found: Boolean(el),
        mentions: el ? el.textContent.includes('字幕轨') : null,
        rows: el ? el.querySelectorAll('.wb-caps-row').length : -1,
        hasGrid: Boolean(el && el.querySelector('[data-style-grid="text"]'))
      }
    })
    check(
      '9. 中栏「文字」页里不再有字幕轨清单（同一份清单不许两处各挂一份）',
      pane.found && pane.mentions === false && pane.rows === 0 && pane.hasGrid === true,
      `中栏出现「字幕轨」=${pane.mentions} 清单行数=${pane.rows} 样式卡在场=${pane.hasGrid}`
    )

    console.log('\n-- 五、窄窗口 + 清空 --\n')

    /* 窄窗口：窗口最小宽 1180 时六枚页签必须都完整可见（`.wb-coltabs` 是 overflow:hidden，
       收不下就是最后一枚「调整」被裁掉且点不到）。六枚 = 信息 + 字幕轨 + 四枚片段页签，
       所以要同时满足"在字幕页"与"选中视频片段"。 */
    await page.locator('.clip[data-clip="c_v"]').click()
    await sleep(400)
    await resize(1180, 860)
    const narrow = await page.evaluate(() => {
      const row = document.querySelector('.wb-coltabs')
      return {
        clientW: row.clientWidth,
        scrollW: row.scrollWidth,
        labels: Array.from(document.querySelectorAll('[data-insp-tab]')).map((el) => el.textContent)
      }
    })
    check(
      '10. 窗口 1180（最小宽）· 六枚页签不溢出、不裁字',
      narrow.scrollW <= narrow.clientW + 1 && narrow.labels.length === 6,
      `条宽 ${narrow.clientW} / 内容 ${narrow.scrollW} / 页签 ${narrow.labels.join('·')}`
    )

    /* 页头那枚「清空」：只删字幕、视频留着。
       ⚠️ 判据不能只看"清单空了"：清单空也可能是整页没渲染（页签被收起来了）。
          所以同时要求"还在字幕页、页签仍在、清单区还在"。 */
    await resize(1600, 900)
    await page.locator('[data-wb-tab="subtitle"]').click()
    await sleep(500)
    await page.locator('[data-insp-tab="captions"]').click()
    await sleep(400)
    await page.locator('[data-caption-clear]').click()
    await sleep(800)
    const cleared = await page.evaluate(() => ({
      rows: document.querySelectorAll('.wb-caps-row').length,
      declared: document.querySelector('[data-caption-count]')?.dataset.captionCount,
      tabCount: document.querySelectorAll('[data-insp-tab="captions"]').length,
      video: document.querySelectorAll('.clip[data-clip="c_v"]').length,
      textClips: document.querySelectorAll('.clip[data-clip^="ct_"]').length
    }))
    check(
      '11. 页头「清空」只清字幕轨：清单归零、视频片段还在、所在页与页签都没跑掉',
      cleared.rows === 0 && cleared.declared === '0' && cleared.video === 1 && cleared.textClips === 0 && cleared.tabCount === 1,
      `清单 ${cleared.rows} 行 / 角标 ${cleared.declared} / 视频 ${cleared.video} / 字幕片段 ${cleared.textClips} / 页签 ${cleared.tabCount}`
    )

    const bad = errs.filter((line) => !/Autofill|DevTools|Electron Security/i.test(line))
    if (bad.length) console.log('\n运行期报错：\n  ' + bad.slice(0, 6).join('\n  '))
  } finally {
    await closeApp(app)
  }
}

let watchdog = null
watchdog = setTimeout(async () => {
  aborted = '看门狗超时'
  console.log(`\n[FAIL] ${aborted}（${WATCHDOG_MS}ms）`)
  summary()
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref?.()

try {
  await withTimeout(main(), WATCHDOG_MS + 10000, 'check-caption-track')
} catch (error) {
  aborted = String(error?.message || error).slice(0, 400)
  console.log(`\n[FAIL] 运行失败：${aborted}`)
}

clearTimeout(watchdog)
const ok = summary()
process.exit(ok ? 0 : 1)
