/**
 * 草稿持久化 E2E：真启 Electron、真落盘、真重启恢复。
 *
 * 为什么必须这么测：草稿这条链路横跨三层（渲染层状态 → preload → 主进程写文件），
 * 任何一层断了都会表现成「界面显示已保存，重启后什么都没有」——
 * 而界面自己不会报错。所以断言全部钉在**磁盘上的文件**和**重启后的 DOM**上：
 *   1. 页面调用 bridge.draft.save 之后，userData/drafts/<id>.json 必须真的存在且是合法 JSON
 *   2. 关掉进程用同一个 profile 再启一次，时间线里的片段要自己回来
 *   3. 从 UI 改项目名必须把改动写进那个文件（证明 UI → 自动保存 → 磁盘是通的，不是只有 IPC 通）
 *   4. id 必须是白名单字符（否则渲染进程能拿 `../../` 写到任意位置）
 *
 * 断言总数恒为 19：找不到 electron 或被中断时，没跑到的断言逐条补成 SKIP（backfillSkips），
 * 而不是少跑 —— 少跑会让 verify.mjs 只报"断言数不符"，看不出真因。
 *
 * 看门狗（必须有）：verify.mjs 用 spawnSync 跑闸门且**没有传 timeout**，一旦这里卡住
 * （典型是 Windows 上 app.close() 等不到退出），整个验证套件会永久挂住 —— 比失败更糟，
 * 因为没有任何输出告诉你卡在哪。所以这里兜一个全局超时，到点自己判失败并强退。
 * 另外关进程统一走 shutdown()（超时后强杀），保证阶段 2 重启时前一个实例真的没了。
 *
 * 用法：node tools/draft-e2e.mjs
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', '.draft-profile')

/** Electron 退出后文件句柄不会立刻释放，删 profile 要重试（Windows 收尾竞态） */
function rmrf(target, { attempts = 8, waitMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      /* 按存在性判定，下面的重试兜底 */
    }
    if (!fs.existsSync(target)) return true
    if (i < attempts - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
    }
  }
  return !fs.existsSync(target)
}

let pass = 0
let fail = 0
let skip = 0
const failures = []

/** 合约：断言总数恒为这个数。中断时靠 backfillSkips 补齐，verify.mjs 里的 expected 才不会误报。 */
const TOTAL_ASSERTIONS = 20
let emitted = 0

function check(label, ok, detail = '') {
  emitted += 1
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

function skipped(label, why) {
  emitted += 1
  skip += 1
  console.log(`  - ${label}  [SKIP] ${why}`)
}

/**
 * 中途出错时把没跑到的那几条补成 SKIP。
 * 不补的话总数会从 19 掉到 17 —— 那正是 verify.mjs 设计要抓的"断言被悄悄少跑"，
 * 但它只报"断言数不符"，看不出真因；补成 SKIP 后总数守恒、真因由失败项说清楚。
 */
function backfillSkips(why) {
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, why)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 给任意 promise 套超时：Windows 上 app.close() 偶尔等不到退出，不能让它无限等 */
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

/**
 * 关掉一个 Electron 实例：先礼后兵。
 *
 * 无边框窗口下 app.close() 偶尔等不到退出 —— 这是本项目多个脚本都撞过的既有现象
 * （见 tools/desktop-shoot.mjs 与 tools/media-import-e2e.mjs，它们的选择是超时后直接不管）。
 * 但本脚本**不能不管**：阶段 2 要复用同一个 profile 再启一次，前一个进程不真退出就会
 * 卡在单实例锁上，profile 目录也删不掉。所以超时后按 pid 强杀进程树。
 *
 * 注意：这里**不把超时判成失败** —— 它是环境属性，不是被测逻辑的问题。
 */
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
    /* 进程可能已经退了，杀不到不算问题 */
  }
  await sleep(500)
}

/**
 * 全局看门狗。verify.mjs 用 spawnSync 跑闸门且没传 timeout，这里一挂整个套件就永久卡死，
 * 且不产出任何可读信息 —— 所以宁可由这里主动判失败并退出。
 */
const WATCHDOG_MS = Number(process.env.DRAFT_E2E_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

/** 造一段真实可用的时间线数据（字段与 App.jsx 里 addClipFromAsset 写入的一致） */
/**
 * 夹具片段。
 *
 * ⚠️ 中间那一段刻意用**字幕轨**（track: 'text'）而不是第二条视频：
 * 字幕轨的片段要能把正文直接铺在轨道上，而 `text` 字段是**跟着草稿落盘再恢复**的 ——
 * 中间任何一个环节把它丢掉，轨道上就只剩"夹具片段 2"这个名字（看着也正常，
 * 只是内容不对），所以这条链必须有一个真的文本片段压着。
 */
function makeClips(count = 3) {
  const tracks = ['video', 'text', 'audio']
  const TEXT_BODY = '第一句台词：别慌，我们还有 30 秒。'
  return Array.from({ length: count }, (_, i) => {
    const track = tracks[i % tracks.length]
    return {
      id: `clip_fixture_${i}`,
      track,
      assetId: `asset_fixture_${i}`,
      name: `夹具片段 ${i + 1}`,
      // 字幕轨带正文，其余轨没有（与真实数据一致）
      text: track === 'text' ? TEXT_BODY : '',
      start: i * 5,
      duration: 5
    }
  })
}

async function launch() {
  const app = await electron.launch({
    executablePath: EXE,
    args: [
      MAIN,
      `--user-data-dir=${PROFILE}`,
      '--no-sandbox',
      '--disable-gpu'
    ],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  const page = await app.firstWindow()
  // 逐条超时统一收紧：默认 30s 会让失败拖很久，这里 15s 足够（本地进程，不是网络）
  page.setDefaultTimeout(15000)
  await page.waitForSelector('.home', { timeout: 30000 })
  return { app, page }
}

async function main() {
  console.log('=== 草稿持久化 E2E（真实 Electron + 真实磁盘）===\n')

  if (!fs.existsSync(EXE)) {
    // 补满 20 条 SKIP 而不是只记 1 条：总数必须守恒，否则 verify.mjs 会报成
    // "断言被删了"，把"这台机器没装 electron"这个真因盖掉。
    backfillSkips(`找不到 electron：${EXE}`)
    return
  }

  // 尽力而为，不为结果负责 —— 真正保证"全新 profile"的是下面那段用产品 API 的清空。
  if (!rmrf(PROFILE)) {
    console.log(`  · 启动前没能删掉 profile（上一轮的进程句柄尚未放开，属已知现象）：${PROFILE}`)
  }
  let app = null
  let page = null
  const pageErrors = []

  try {
    ;({ app, page } = await launch())
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })

    /* ------------------------------ 阶段 1 ------------------------------ */

    console.log('-- 阶段 1：全新 profile，保存 / 列表 / 打开 --')

    const info = await page.evaluate(() => window.yjai.info())
    const userData = info.userData
    const draftsDir = path.join(userData, 'drafts')
    check('1. 拿到 userData 目录', Boolean(userData), userData)

    /**
     * 断言 2/3 的前提是"全新 profile"，但 profile 是**刻意不删**的
     * （收尾删它会把主线程卡死，见 finally 里那段注释），启动前那次 `rmrf` 只是尽力而为：
     * 上一轮如果是**直接跑本脚本**（而不是走 verify 的完整流程）且 Electron 尚未完全退出，
     * 目录就删不掉，残留草稿会让 2/3 变红 —— 而当时"全新 profile"这个前提**已经不成立**，
     * 报出来的却是"列表不为空"，方向完全指错。这类"时绿时红、红了还指错方向"的闸门
     * 比没有闸门更耗人，所以这里不再依赖文件系统，改用**产品自己的 API** 清空：
     * 既确定，又顺带把 draft.list / draft.remove 这条链路先走一遍。
     */
    const stale = await page.evaluate(() => window.yjai.draft.list())
    if (Array.isArray(stale) && stale.length) {
      for (const item of stale) await page.evaluate((id) => window.yjai.draft.remove(id), item.id)
      const left = await page.evaluate(() => window.yjai.draft.list())
      console.log(`  · 清掉 ${stale.length} 份残留草稿（profile 没删净），清后剩 ${Array.isArray(left) ? left.length : '?'} 份`)
      // 首页的「最近草稿」是首屏渲染的，清完必须重进一次才看得到空态（断言 3 依赖它）
      await page.reload()
      await page.waitForSelector('.home', { timeout: 30000 })
      await sleep(400)
    }

    const emptyList = await page.evaluate(() => window.yjai.draft.list())
    check('2. 全新 profile 的草稿列表为空', Array.isArray(emptyList) && emptyList.length === 0, JSON.stringify(emptyList))

    // 首页「最近草稿」应显示空态而不是假卡片
    const emptyText = await page.locator('.home-empty-text').first().textContent().catch(() => '')
    check('3. 首页最近草稿显示空态文案', /还没有草稿/.test(String(emptyText || '')), String(emptyText || '').trim())

    const fixtureClips = makeClips(3)
    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 草稿', data: { clips: fixtureClips, assets: [], playhead: 7, volume: 80, zoom: 1 } }
    )
    check('4. draft.save 返回摘要', Boolean(saved?.id), JSON.stringify(saved))

    const file = path.join(draftsDir, `${saved?.id}.json`)
    check('5. 磁盘上真的出现草稿文件', fs.existsSync(file), file)

    let onDisk = null
    try {
      onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      onDisk = null
    }
    check(
      '6. 文件是合法 JSON 且片段数与写入一致',
      Array.isArray(onDisk?.data?.clips) && onDisk.data.clips.length === 3,
      onDisk ? `clips=${onDisk.data.clips?.length}` : '解析失败'
    )
    check('7. 摘要里的时长按片段算出来', Number(saved?.duration) === 15, `duration=${saved?.duration}`)
    check('8. 保存过程不残留 .tmp 文件', !fs.existsSync(`${file}.tmp`))

    const listed = await page.evaluate(() => window.yjai.draft.list())
    check('9. 列表里能查到这份草稿', listed.some((item) => item.id === saved.id), `共 ${listed.length} 份`)

    // 非法 id 必须被拒（路径穿越）
    let rejected = false
    try {
      await page.evaluate(() => window.yjai.draft.load('../../evil'))
    } catch {
      rejected = true
    }
    check('10. 非法草稿 id（路径穿越）被拒绝', rejected)

    // UI：首页空态应被真实卡片取代（保存后刷新一次列表需要重进首页）
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await sleep(400)
    const cardCount = await page.locator('.home-draft-card').count()
    check('11. 首页「最近草稿」出现真实卡片', cardCount >= 1, `卡片 ${cardCount} 张`)

    // 进草稿页
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    const rowCount = await page.locator('.home-draft-row').count()
    check('12. 草稿页列出草稿行', rowCount >= 1, `${rowCount} 行`)

    // 打开草稿 → 进剪辑器且时间线恢复
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(300)
    const restoredClips = await page.locator('.clip[data-clip]').count()
    check('13. 打开草稿后时间线出现片段', restoredClips === 3, `${restoredClips} 个片段`)

    /**
     * 字幕轨要直接把正文铺在轨道上，而不是只显示"夹具片段 2"这种名字。
     *
     * 这条同时钉住两件事：
     *   · `clip.text` 从写入草稿、落盘、恢复到渲染一路没被丢掉；
     *   · 轨道上的文字不是拿 `name` 顶替的（name 是"夹具片段 2"，正文是台词）。
     * 只断言"轨道上有文字"是不够的 —— 名字也是文字，那是假绿。
     */
    const trackText = await page.evaluate(
      () => document.querySelector('.wb-tllane[data-lane="text"] .clip .clip-textbody')?.textContent || ''
    )
    check(
      '13b. 字幕轨片段在轨道上直接显示台词正文（不是用片段名顶替）',
      trackText.includes('别慌，我们还有 30 秒'),
      `读到 ${JSON.stringify(trackText)}`
    )

    // UI → 自动保存：改项目名，磁盘上的草稿文件要跟着变
    await page.fill('.wb-menu-title', '改名后的草稿')
    await sleep(1800)
    const afterRename = JSON.parse(fs.readFileSync(file, 'utf8'))
    check(
      '14. 界面改项目名会写回草稿文件',
      afterRename.name === '改名后的草稿',
      `name=${afterRename.name}`
    )

    // Ctrl+S 手动保存：updatedAt 前进
    const before = JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt
    await sleep(1100)
    await page.keyboard.press('Control+s')
    await sleep(600)
    const afterSave = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('15. Ctrl+S 会真的重新落盘', afterSave.updatedAt >= before, `${before} → ${afterSave.updatedAt}`)

    // 删除
    const extra = await page.evaluate(() => window.yjai.draft.save({ name: '待删除', data: { clips: [] } }))
    const extraFile = path.join(draftsDir, `${extra.id}.json`)
    const removed = await page.evaluate((id) => window.yjai.draft.remove(id), extra.id)
    check('16. draft.remove 真的删掉文件', removed === true && !fs.existsSync(extraFile), extraFile)

    await shutdown(app)
    app = null
    await sleep(500)

    /* ------------------------------ 阶段 2 ------------------------------ */

    console.log('\n-- 阶段 2：同一 profile 重启，验证启动自动恢复 --')

    const second = await launch()
    app = second.app
    page = second.page
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    // 启动恢复把片段灌进状态，但首屏是首页；进剪辑器即可看到
    await page.click('.home-hero-video')
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(400)
    const afterRestart = await page.locator('.clip[data-clip]').count()
    check('17. 重启后时间线自动恢复', afterRestart === 3, `${afterRestart} 个片段`)
    const nameAfterRestart = await page.inputValue('.wb-menu-title')
    check('18. 重启后项目名一并恢复', nameAfterRestart === '改名后的草稿', `name=${nameAfterRestart}`)

    const realErrors = pageErrors.filter((text) => !/Failed to load resource|net::ERR|403|401/i.test(text))
    check('19. 全程无页面错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    // 中断本身占**最后一条**断言：先补齐到 TOTAL-1，再用一条失败断言收尾。
    // 直接 fail += 1 不占位的话总数会变成 TOTAL+1，verify 里的 expected 就对不上了，
    // 而"断言数不符"这种报法会把真因（是这里中断了）盖掉。
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    // 先停看门狗：收尾只剩关进程 + 删目录，不该再被它打断
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
  console.log(`DRAFT_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('DRAFT_E2E_FAILED')
  } else {
    console.log('DRAFT_E2E_OK')
  }

  const code = fail ? 1 : 0
  process.exitCode = code
  // 必须显式退出：playwright 的连接、以及被强杀的子进程留下的管道，会让事件循环常驻。
  // 只设 exitCode 是不够的 —— 实测断言全绿、DRAFT_E2E_OK 也打出来了，进程却一直不退，
  // 于是 verify.mjs 的 spawnSync 照样永久等待（这正是"绿了但卡住"的隐蔽形态）。
  // 先等 stdout 排空再退，避免管道里丢掉 DRAFT_E2E_OK 这个通过标记。
  process.stdout.write('', () => process.exit(code))
  setTimeout(() => process.exit(code), 1000).unref()
}

main()
  .catch((error) => {
    console.error('[!] 未捕获异常：' + String(error?.stack || error))
    fail += 1
  })
  .finally(summary)
