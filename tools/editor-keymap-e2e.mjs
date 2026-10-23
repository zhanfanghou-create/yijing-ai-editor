/**
 * 快捷键系统 E2E：真启 Electron，真开设置里的「快捷键」页，真按键，真重启。
 *
 * 为什么必须单开一道闸门（而不是只靠 keymap-selftest 那种纯逻辑自证）：
 * 纯逻辑能证明"归一化对了、冲突算得出来"，但证明不了下面这四件只在真机才有的事 ——
 *   1. 设置页**真的画出来了**，行数、分组、固定键位与 ACTIONS 一致（少一行没人会发现）；
 *   2. 点键位格之后的**录入态真的截得住按键** —— 录入时按 Ctrl+E 不能顺手弹出导出框
 *      （App 的全局派发挂在 window 冒泡阶段，不在捕获阶段截就会先执行一遍）；
 *   3. 派发器用的是**用户改过的键位表**，而不是写死的默认表。这条只能这么证：
 *      把播放/暂停从 Space 改绑 F9，再证明按 F9 会播放、按 Space 不再响应 ——
 *      一正一反两条都要，只验 F9 是可能被"两个键位都留着"蒙过去的；
 *   4. 改完的键位**活过重启** —— 存在主进程 settings 里，不是只躺在内存。
 *
 * 断言总数恒为 31：找不到 electron 或中途出错时，没跑到的逐条补成 SKIP（backfillSkips），
 * 而不是少跑 —— 少跑会让 verify.mjs 只报"断言数不符"，看不出真因。
 *
 * 看门狗与 shutdown 的理由同 draft-e2e.mjs：verify.mjs 用 spawnSync 跑闸门且没传 timeout，
 * 这里一卡整 个套件永久挂住，且没有任何可读输出。到点自己判失败并强退。
 *
 * 用法：node tools/editor-keymap-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
/**
 * 测试用 profile **每轮唯一**（带 pid）。
 *
 * 不能用固定目录名：上一轮结束时 Electron 的句柄常常还没回收，目录删不掉，
 * 于是下一轮开头"以为清空了、其实带着上一轮存的自定义键位"——
 * 而本脚本一开头就断言"当前全部为默认键位"，那会变成一条莫名其妙的假红。
 * 唯一目录让"是否干净"不再依赖删除是否成功；重启那一阶段复用同一个目录即可。
 */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.keymap-profile-${process.pid}`)
const PROFILE_PREFIX = '.keymap-profile'

/** 期望值全部**独立写死**在这里，不从源码 import —— 从被测算的代码里取期望值等于没测。
 *  21 → 22（2026-10-08）：编辑组新增「停用 / 启用选中的片段」（V，参照参考客户端的
 *  「停用片段」），参考客户端同款功能同名键位。
 *  22 → 25（2026-10-19）：新增用户标记三项（M 打点 / Ctrl+← → 在标记间跳）。
 *  25 → 28（2026-10-20）：新增时间区域三项（I 入点 / O 出点 / Shift+Delete 删除区间）。
 *  固定键位行不算在动作行里（它是单独的一块说明），所以恒比动作行多 1。 */
const EXPECTED_GROUPS = ['编辑', '播放', '跳转', '视图', '项目', '固定键位']
const EXPECTED_ACTION_ROWS = 28
const EXPECTED_TOTAL_ROWS = 29

function rmrf(target, { attempts = 24, waitMs = 300 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      /* 按存在性判定，下面的重试兜底 */
    }
    if (!fs.existsSync(target)) return true
    if (i < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
  }
  return !fs.existsSync(target)
}

let pass = 0
let fail = 0
let skip = 0
const failures = []
const TOTAL_ASSERTIONS = 31
let emitted = 0

function check(label, ok, detail = '') {
  emitted += 1
  if (ok) {
    pass += 1
    console.log(`  \u2713 ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  \u2717 ${label}${detail ? '  ' + detail : ''}`)
  }
}

function skipped(label, why) {
  emitted += 1
  skip += 1
  console.log(`  - ${label}  [SKIP] ${why}`)
}

function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
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

async function shutdown(app) {
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
    /* 已经退了就杀不到 */
  }
  await sleep(500)
}

const WATCHDOG_MS = Number(process.env.KEYMAP_E2E_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

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

/* ------------------------------------------------------------------ 便捷操作 */

/** 进剪辑器（首页 hero 按钮就是「进入剪辑」） */
async function enterEditor(page) {
  await page.click('.home-hero-video')
  await page.waitForSelector('.wb-timeline', { timeout: 15000 })
  await sleep(250)
}

async function openSettings(page, tab = 'shortcut') {
  await page.locator('.wb-menu-items button', { hasText: '设置' }).click()
  await page.waitForSelector('.modal', { timeout: 10000 })
  if (tab === 'shortcut') {
    await page.locator('[data-settings-tab="shortcut"]').click()
    await page.waitForSelector('.wb-keys', { timeout: 10000 })
  }
  await sleep(150)
}

/** footer 主按钮：通用页是「保存」，快捷键页是「完成」 */
async function closeSettings(page) {
  await page.locator('.modal-foot button', { hasText: '完成' }).click()
  await page.waitForSelector('.wb-keys', { state: 'detached', timeout: 10000 })
  await sleep(200)
}

/**
 * 读某一行当前绑定的键位（把 kbd 文本拼成 'Ctrl+J' 这样，便于断言）。
 * 必须同时排除 `.empty`（"未绑定"占位格）—— 它也是 `.wb-key-chip`，
 * 不排除的话"取消绑定后应当为空"永远为假。
 */
async function keysOf(page, actionId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-action="${id}"]`)
    if (!row) return null
    const chips = [...row.querySelectorAll('.wb-key-chip:not(.static):not(.empty)')]
    return chips.map((chip) =>
      [...chip.querySelectorAll('kbd')].map((k) => k.textContent.trim()).join('+')
    )
  }, actionId)
}

/** 点某一行第 index 个键位格，进入录入态 */
async function clickChip(page, actionId, index = 0) {
  const chip = page.locator(`[data-action="${actionId}"] .wb-key-chip:not(.static):not(.empty)`).nth(index)
  await chip.scrollIntoViewIfNeeded()
  await chip.click()
  await page.waitForSelector(`[data-action="${actionId}"].capturing`, { timeout: 5000 })
}

async function modalTitles(page) {
  return page.evaluate(() => [...document.querySelectorAll('.modal > header h3')].map((n) => n.textContent.trim()))
}

/** 主进程设置（权威存储） */
async function settingsOf(page) {
  return page.evaluate(() => window.yjai.settings.get())
}

/** 让焦点离开按钮：否则空格会去"激活当前按钮"，掩盖真实行为 */
async function blurAll(page) {
  await page.evaluate(() => {
    const el = document.activeElement
    if (el && typeof el.blur === 'function') el.blur()
  })
  await sleep(80)
}

async function playTitle(page) {
  return String((await page.locator('.wb-transport-btns button.play').getAttribute('title')) || '')
}

/* ---------------------------------------------------------------------- 主体 */

async function main() {
  console.log('=== 快捷键系统 E2E（真实 Electron + 真实设置页 + 真实按键）===\n')

  if (!fs.existsSync(EXE)) {
    backfillSkips(`找不到 electron：${EXE}`)
    return
  }

  rmrf(PROFILE)
  let app = null
  let page = null
  const pageErrors = []

  try {
    ;({ app, page } = await launch())
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })

    /* ------------------------- A. 设置页结构与内容 ------------------------- */

    console.log('-- A. 「快捷键」页真的画出来了 --')

    check('1. 首屏是创作中心', Boolean(await page.$('.home')))

    await enterEditor(page)
    check('2. 能从首页进入剪辑工作台', Boolean(await page.$('.wb-timeline')))

    await openSettings(page, 'general')
    const titles = await modalTitles(page)
    check('3. 顶栏「设置」打开的是设置弹窗', titles.includes('设置'), titles.join('/'))
    const generalActive = await page
      .locator('[data-settings-tab="general"]')
      .evaluate((el) => el.classList.contains('active'))
    const keysAbsent = (await page.locator('.wb-keys').count()) === 0
    check('4. 默认停在「通用」页且不渲染快捷键面板', generalActive && keysAbsent, `active=${generalActive} keysAbsent=${keysAbsent}`)

    await page.locator('[data-settings-tab="shortcut"]').click()
    await page.waitForSelector('.wb-keys', { timeout: 10000 })
    check('5. 切到「快捷键」页后面板出现', (await page.locator('.wb-keys').count()) === 1)

    const groups = await page.evaluate(() =>
      [...document.querySelectorAll('.wb-keys-group-title')].map((n) => n.textContent.trim())
    )
    check('6. 分组名称与顺序完全一致', JSON.stringify(groups) === JSON.stringify(EXPECTED_GROUPS), groups.join('/'))

    const actionRows = await page.locator('.wb-keys-row[data-action]').count()
    const totalRows = await page.locator('.wb-keys-row').count()
    check(
      `7. 动作行数 ${EXPECTED_ACTION_ROWS}、含固定键位共 ${EXPECTED_TOTAL_ROWS} 行`,
      actionRows === EXPECTED_ACTION_ROWS && totalRows === EXPECTED_TOTAL_ROWS,
      `actionRows=${actionRows} totalRows=${totalRows}`
    )

    const rowsWithoutChip = await page.evaluate(() =>
      [...document.querySelectorAll('.wb-keys-row')].filter((row) => row.querySelectorAll('.wb-key-chip').length === 0)
        .length
    )
    check('8. 每一行都至少有一个键位格（没有整行空白）', rowsWithoutChip === 0, `空白行 ${rowsWithoutChip}`)

    const fixedKeys = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.wb-keys-row.readonly')][0]
      if (!row) return null
      return {
        label: row.querySelector('.wb-keys-label').textContent.trim(),
        keys: [...row.querySelectorAll('kbd')].map((k) => k.textContent.trim())
      }
    })
    check('9. 固定键位行显示 Esc 且标注不可改', Boolean(fixedKeys) && fixedKeys.keys.join('+') === 'Esc' && /不可修改/.test(fixedKeys.label), JSON.stringify(fixedKeys))

    check('10. 默认键位表没有冲突（冲突格数量为 0）', (await page.locator('.wb-key-chip.conflict').count()) === 0)

    const footDefault = await page.locator('.wb-keys-count').textContent()
    check('11. 页脚显示「当前全部为默认键位」', /全部为默认/.test(String(footDefault)), String(footDefault).trim())

    /* --------------------- B. 改绑 + 真派发器（一正一反） --------------------- */

    console.log('\n-- B. 改绑播放/暂停到 F9，并证明派发器用的是用户键位表 --')

    await clickChip(page, 'playPause', 0)
    check('12. 点键位格后进入录入态（出现"按下新键位"提示）', (await page.locator('[data-action="playPause"].capturing .wb-keys-hint').count()) === 1)

    await page.keyboard.press('F9')
    await sleep(250)
    const boundTo = await keysOf(page, 'playPause')
    check('13. 按 F9 后该行键位变成 F9', Array.isArray(boundTo) && boundTo.join(',') === 'F9', JSON.stringify(boundTo))

    const savedMap = (await settingsOf(page)).keymap
    check(
      '14. 键位已写进主进程设置（权威存储）',
      Boolean(savedMap) && Array.isArray(savedMap.playPause) && savedMap.playPause.join(',') === 'F9',
      JSON.stringify(savedMap && savedMap.playPause)
    )

    const footCustom = await page.locator('.wb-keys-count').textContent()
    check('15. 页脚计数变成「已自定义 1 个动作」', /已自定义\s*1\s*个动作/.test(String(footCustom)), String(footCustom).trim())

    await closeSettings(page)
    check('16. 关闭设置后弹窗消失', (await page.locator('.modal').count()) === 0)

    await blurAll(page)
    const titleBefore = await playTitle(page)
    await page.keyboard.press('F9')
    await sleep(250)
    const titleAfterOn = await playTitle(page)
    check(
      '17. 按新键位 F9 真的开始播放',
      /播放/.test(titleBefore) && /暂停/.test(titleAfterOn),
      `${titleBefore.trim()} → ${titleAfterOn.trim()}`
    )

    await page.keyboard.press('F9')
    await sleep(250)
    const titleAfterOff = await playTitle(page)
    check('18. 再按 F9 回到暂停态（可逆，不是单向触发）', /播放/.test(titleAfterOff), titleAfterOff.trim())

    await blurAll(page)
    const beforeSpace = await playTitle(page)
    await page.keyboard.press('Space')
    await sleep(250)
    const afterSpace = await playTitle(page)
    check(
      '19. 旧键位 Space 已不再触发播放（控制组：证明是"改绑"不是"加绑"）',
      beforeSpace.trim() === afterSpace.trim() && /播放/.test(afterSpace),
      `${beforeSpace.trim()} → ${afterSpace.trim()}`
    )

    /* ------------------------------ C. 冲突检测 ------------------------------ */

    console.log('\n-- C. 冲突提示与录入时的按键拦截 --')

    await openSettings(page, 'shortcut')
    await clickChip(page, 'zoomReset', 0)
    const masksDuringCapture = await page.locator('.mask').count()
    await page.keyboard.press('Control+e')
    await sleep(300)
    const masksAfterCtrlE = await page.locator('.mask').count()
    const titlesAfterCtrlE = await modalTitles(page)
    check(
      '20. 录入态下按 Ctrl+E 不会弹出导出框（捕获阶段真的截住了）',
      masksDuringCapture === 1 && masksAfterCtrlE === 1 && titlesAfterCtrlE.join('/') === '设置',
      `mask ${masksDuringCapture}→${masksAfterCtrlE} 标题 ${titlesAfterCtrlE.join('/')}`
    )
    const zoomKeys = await keysOf(page, 'zoomReset')
    check('21. Ctrl+E 被当成键位录入而不是执行动作', Array.isArray(zoomKeys) && zoomKeys.join(',') === 'Ctrl+E', JSON.stringify(zoomKeys))

    await clickChip(page, 'redo', 0)
    await page.keyboard.press('Control+z')
    await sleep(250)
    check('22. 把「重做」改成 Ctrl+Z 后出现冲突提示', (await page.locator('[data-keymap-conflict]').count()) === 1)

    const undoConflicts = await page.locator('[data-action="undo"] .wb-key-chip.conflict').count()
    const redoConflicts = await page.locator('[data-action="redo"] .wb-key-chip.conflict').count()
    check('23. 冲突双方（撤销 / 重做）的键位格都被标红', undoConflicts === 1 && redoConflicts === 1, `undo=${undoConflicts} redo=${redoConflicts}`)

    const conflictText = String(await page.locator('[data-keymap-conflict]').textContent())
    check('24. 冲突提示里点名了两个动作', /撤销/.test(conflictText) && /重做/.test(conflictText), conflictText.replace(/\s+/g, ' ').trim().slice(0, 120))

    /* ------------------------ D. 取消绑定与恢复默认 ------------------------ */

    console.log('\n-- D. 取消绑定 / 恢复全部默认 --')

    const dropBtn = page.locator('[data-action="clearTimeline"] .wb-key-drop').first()
    await dropBtn.scrollIntoViewIfNeeded()
    await page.locator('[data-action="clearTimeline"] .wb-key-slot').first().hover()
    await dropBtn.click({ force: true })
    await sleep(250)
    const clearKeys = await keysOf(page, 'clearTimeline')
    const hasEmptyChip = (await page.locator('[data-action="clearTimeline"] .wb-key-chip.empty').count()) === 1
    check('25. 取消绑定后该行显示「未绑定」', Array.isArray(clearKeys) && clearKeys.length === 0 && hasEmptyChip, JSON.stringify(clearKeys))

    await page.locator('.modal-foot button', { hasText: '恢复全部默认' }).click()
    await sleep(350)
    const afterResetConflicts = await page.locator('[data-keymap-conflict]').count()
    const afterResetFoot = String(await page.locator('.wb-keys-count').textContent())
    const afterResetStore = (await settingsOf(page)).keymap
    check(
      '26. 恢复全部默认后冲突消失',
      afterResetConflicts === 0,
      `冲突提示 ${afterResetConflicts} 处`
    )
    check('27. 恢复后页脚回到默认文案', /全部为默认/.test(afterResetFoot), afterResetFoot.trim())
    check('28. 恢复后主进程设置里的 keymap 被清空（不是写回一份等于默认的表）', afterResetStore == null, JSON.stringify(afterResetStore))

    /* ----------------------------- E. 活过重启 ----------------------------- */

    console.log('\n-- E. 改绑后重启，验证键位真的持久化 --')

    await clickChip(page, 'playPause', 0)
    await page.keyboard.press('F9')
    await sleep(300)
    const rebound = (await settingsOf(page)).keymap
    check(
      '29. 清空后能再次保存（重启前的准备）',
      Boolean(rebound) && rebound.playPause.join(',') === 'F9',
      JSON.stringify(rebound && rebound.playPause)
    )

    await shutdown(app)
    app = null
    await sleep(500)

    const second = await launch()
    app = second.app
    page = second.page
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })

    await enterEditor(page)
    await blurAll(page)
    const beforeRestart = await playTitle(page)
    await page.keyboard.press('F9')
    await sleep(300)
    const afterRestart = await playTitle(page)
    check(
      '30. 重启后按 F9 仍然播放（自定义键位活过了重启）',
      /播放/.test(beforeRestart) && /暂停/.test(afterRestart),
      `${beforeRestart.trim()} → ${afterRestart.trim()}`
    )

    const realErrors = pageErrors.filter((text) => !/Failed to load resource|net::ERR|403|401/i.test(text))
    check('31. 全程无页面错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    // 中断本身占最后一条断言：先补齐到 TOTAL-1，再用一条失败断言收尾。
    // 直接 fail += 1 不占位的话总数会变成 TOTAL+1，verify 里的 expected 就对不上了。
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    clearTimeout(watchdog)
    await shutdown(app)
    app = null
    /* ⚠️ 收尾**不再**删 profile 目录，这是刻意的取舍 —— 完整实录（同步版堵死主线程、
     * 异步版 8 秒也删不净）见 `tools/home-entries-e2e.mjs` 收尾处的注释，同一根因：
     * Electron 关掉之后目录里仍有它攥着的文件，删除会**一直不返回**；
     * 那一步既危险又没用（目录名带 pid、每轮独占，残留它不影响下一轮）。
     * 启动阶段那次 `rmrf(PROFILE)` 保留：那时还没有任何进程持句柄。 */
    console.log(`\n测试用 Electron profile 保留不删（此刻文件仍被占用，删它会卡死主线程）：${PROFILE}`)
  }
}

function summary() {
  clearTimeout(watchdog)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`EDITOR_KEYMAP_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('EDITOR_KEYMAP_E2E_FAILED')
  } else {
    console.log('EDITOR_KEYMAP_E2E_OK')
  }

  const code = fail ? 1 : 0
  process.exitCode = code
  // 必须显式退出：playwright 的连接与被强杀的子进程管道会让事件循环常驻。
  // 先等 stdout 排空再退，避免管道里丢掉 EDITOR_KEYMAP_E2E_OK 这个通过标记。
  process.stdout.write('', () => process.exit(code))
  setTimeout(() => process.exit(code), 1000).unref()
}

main()
  .catch((error) => {
    console.error('[!] 未捕获异常：' + String(error?.stack || error))
    fail += 1
  })
  .finally(summary)
