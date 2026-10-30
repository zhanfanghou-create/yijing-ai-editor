/**
 * 字幕文件 E2E：真启 Electron，验「导入 / 导出 / 按语音分句」这一族在真机上成立。
 *
 * 为什么纯逻辑自测（tools/subtitle-selftest.mjs 82 条）之外还要这一道：
 * 自测能证明 SRT/ASS/LRC 解析得对、VAD 切得对，证明不了下面四件只在真机成立的事 ——
 *   1. **按钮真的在字幕页上**：SubtitleTools 是挂在 StylePanel 里的，
 *      而 StylePanel 被「字幕模板」与「花字」两页共用 —— 少一个 `group === null` 判断，
 *      按钮会跑到花字页去，字幕页反而是空的；
 *   2. **导出按钮的 enabled 跟着字幕轨走**：字幕轨空着时点导出应当无路可走
 *      （`disabled`）。判据读 DOM 的 `disabled` 属性，不读组件 state；
 *   3. **IPC 双向真的通**：`subtitle:read` 把文件读成文本、`subtitle:write` 把文本写出去。
 *      这一段绕过了原生对话框（传 path），因为**原生对话框在 E2E 里必须打桩，
 *      真弹框 = 永久卡住**；对话框本身由主进程的 openFile 分支覆盖，不在这里测。
 *   4. **白名单真的挡住了非字幕文件**：`subtitle:read` 带一个 .exe 路径必须被拒 ——
 *      这个 IPC 若没有扩展名校验，就等于给渲染层开了一个"读任意文件"的口子。
 *
 * 断言总数恒为 8：找不到 electron 时逐条补 SKIP。
 * 用法：node tools/subtitle-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.subtitle-profile-${process.pid}`)
/** 字幕夹具放在同一个临时目录下（Windows 用户目录带空格，别放进 profile 里绕） */
const FIXTURE_DIR = path.join(os.tmpdir(), 'yjai-e2e', `sub-${process.pid}`)
const SRT_PATH = path.join(FIXTURE_DIR, 'fixture.srt')
const OUT_PATH = path.join(FIXTURE_DIR, 'out.srt')

const TOTAL_ASSERTIONS = 8
let emitted = 0
let pass = 0
let fail = 0
let skip = 0
const failures = []

function check(label, ok, detail = '') {
  emitted += 1
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`)
  }
}

function skipped(label, why) {
  emitted += 1
  skip += 1
  console.log(`  ⚠ ${label} — 跳过：${why}`)
}

function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    /* 本轮 profile 被占用时删不掉，下一轮用新目录名，不影响结论 */
  }
}

/** 三段式夹具：含中文、多行正文、2 位毫秒（真实脏数据） */
const SRT_FIXTURE = ['1', '00:00:01,000 --> 00:00:03,500', '第一句字幕', '', '2', '00:00:04,50 --> 00:00:06,000', '第二句', '换行', ''].join('\r\n')

function makeClips() {
  return [
    { id: 'c1', track: 'video', name: '片段一', url: '', path: '', kind: 'video', start: 0, duration: 5, offset: 0, sourceDuration: 5 },
    { id: 'c2', track: 'video', name: '片段二', url: '', path: '', kind: 'video', start: 5, duration: 5, offset: 0, sourceDuration: 5 },
    { id: 'c3', track: 'video', name: '片段三', url: '', path: '', kind: 'video', start: 10, duration: 4, offset: 0, sourceDuration: 4 }
  ]
}

async function launch() {
  const app = await electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForSelector('.home', { timeout: 30000 })
  return { app, page }
}

async function shutdown(app) {
  if (!app) return
  try {
    await Promise.race([app.close(), sleep(8000)])
  } catch {
    /* 落到强杀 */
  }
}

let watchdog = null

async function main() {
  console.log('=== 字幕文件 E2E（真实 Electron）===\n')

  if (!fs.existsSync(EXE)) {
    backfillSkips(`找不到 electron：${EXE}`)
    return
  }

  rmrf(PROFILE)
  rmrf(FIXTURE_DIR)
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  fs.writeFileSync(SRT_PATH, SRT_FIXTURE, 'utf8')

  let app = null
  let page = null
  const pageErrors = []

  try {
    ;({ app, page } = await launch())
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })

    /* ---------------------- 进工作台（带一段三段片段） ---------------------- */
    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: '字幕 E2E', data: { clips: makeClips(), assets: [], playhead: 0, volume: 100, zoom: 1 } }
    )
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await sleep(400)
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(400)

    /* ---------------------- A. 字幕页上真的有三颗按钮 ---------------------- */
    await page.locator('[data-wb-tab="subtitle"]').click()
    await sleep(400)
    /* 「自定义」落在字幕样式面板（panel='text-style'，group 缺省 null），
       也就是 SubtitleTools 唯一该出现的地方。 */
    await page.locator('[data-wb-node="subtitle-custom"]').click()
    await sleep(400)

    const importVisible = await page.locator('[data-sub-import]').isVisible().catch(() => false)
    const exportVisible = await page.locator('[data-sub-export]').isVisible().catch(() => false)
    const vadVisible = await page.locator('[data-sub-vad]').isVisible().catch(() => false)
    check(
      '1. 字幕页出现「导入字幕 / 导出 SRT / 按语音自动分句」三颗按钮',
      importVisible && exportVisible && vadVisible,
      `import=${importVisible} export=${exportVisible} vad=${vadVisible}`
    )

    const importText = (await page.locator('[data-sub-import]').innerText().catch(() => '')).trim()
    check('2. 导入按钮的文案说的是"导入字幕"（不是"智能字幕"这种做不到的话）', /导入字幕/.test(importText), importText)

    /* ---------- B. 字幕轨空着时导出按钮 disabled（消费端状态） ---------- */
    const disabledWhenEmpty = await page.locator('[data-sub-export]').isDisabled()
    check('3. 字幕轨空着时「导出 SRT」是 disabled（点了也不会弹保存框）', disabledWhenEmpty)

    /* ------------------ C. IPC：读真实 SRT（含中文与 2 位毫秒） ------------------ */
    const readBack = await page.evaluate((target) => window.yjai.subtitle.read({ path: target }), SRT_PATH)
    check(
      '4. subtitle:read 能读到真实 SRT 文件（中文不乱码）',
      Boolean(readBack && readBack.ok && readBack.text.includes('第一句字幕') && readBack.text.includes('00:00:04,50')),
      `ok=${readBack?.ok} name=${readBack?.name}`
    )

    /* ---- D. 白名单：非字幕扩展名必须被拒（否则这就是读任意文件的口子） ---- */
    const denied = await page.evaluate(() => window.yjai.subtitle.read({ path: 'C:\\Windows\\System32\\notepad.exe' }))
    check(
      '5. subtitle:read 拒绝非字幕扩展名（.exe 读不出来）',
      Boolean(denied && denied.ok === false && /只支持/.test(denied.error || '')),
      denied?.error || ''
    )

    /* ------------------ E. IPC：写出去再读回来（真往返） ------------------ */
    const content = '1\r\n00:00:02,000 --> 00:00:04,000\r\n写出去的这条\r\n'
    const wrote = await page.evaluate(
      (payload) => window.yjai.subtitle.write(payload),
      { content, format: 'srt', path: OUT_PATH }
    )
    const written = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : ''
    check(
      '6. subtitle:write 落盘成功，磁盘上的内容与传入一致',
      Boolean(wrote && wrote.ok) && written === content,
      `ok=${wrote?.ok} size=${written.length}`
    )

    /* -------- F. 加一条字幕后导出按钮变可用（状态真的跟着轨走） -------- */
    await page.locator('[data-style-grid="subtitle-style"] .style-card').first().click()
    await sleep(500)
    const textClipCount = await page.locator('.clip[data-clip]', { hasText: '字幕' }).count().catch(() => 0)
    const enabledAfter = !(await page.locator('[data-sub-export]').isDisabled())
    check(
      '7. 加一条字幕后「导出 SRT」变可用（按钮状态跟着字幕轨走）',
      enabledAfter,
      `字幕片段=${textClipCount} enabled=${enabledAfter}`
    )

    check('8. 全程无页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error && error.stack ? error.stack : error)}`)
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    clearTimeout(watchdog)
    await shutdown(app)
    console.log(`\n测试用 Electron profile 保留不删（此刻文件仍被占用，删它会卡死主线程）：${PROFILE}`)
  }
}

function summary() {
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`SUBTITLE_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('SUBTITLE_E2E_FAILED')
    process.exitCode = 1
  } else {
    console.log('SUBTITLE_E2E_OK')
    process.exitCode = 0
  }
}

watchdog = setTimeout(async () => {
  console.error('\n[!] 超时：强行收尾')
  backfillSkips('超时未跑到')
  summary()
  process.exit(1)
}, Number(process.env.SUBTITLE_E2E_TIMEOUT_MS || 4 * 60 * 1000))

main()
  .then(() => {
    summary()
    process.exit(process.exitCode || 0)
  })
  .catch((error) => {
    console.error(`[!] 未捕获：${String(error?.stack || error)}`)
    backfillSkips('未捕获异常')
    summary()
    process.exit(1)
  })
