/**
 * 预置音乐 / 音效的 UI E2E（真启 Electron，真点卡片，真出声）。
 *
 * 这道闸门回答四个"静态检查答不了"的问题：
 *   ① 面板**真的**把清单渲染成了卡片（不是空列表、不是"选了分类没内容"）；
 *   ② 打开面板**不发请求**（"不点击不下载"）—— 断言每张卡都是 `remote`、没有一个在下载；
 *   ③ 点一下 → 真的下到本机（卡片变成"已缓存"）→ **真的在播**（`<audio>` 的 `currentTime` 在走）。
 *      只断言"状态变成 playing"是自欺：`setPlaying` 写完就为真，声音可以一点没有；
 *   ④ 「音效」页与「音乐」页是**两份不同的清单**（分组字段真被用上了）；
 *   ⑤ 「加入」把这一条落到**音频轨**（消费端：时间线上真多一个片段）。
 *
 * 断网时（音频源不可达）第 ③ 段整段记 SKIP —— 按仓里的约定：
 * **依赖外网的闸门，源不可达记 SKIP，可达但下不下来才红**。
 *
 * 断言总数恒为 14：缺 electron / 断网时逐条 SKIP，verify 里钉死的数字才有意义。
 *
 * 用法：node tools/music-library-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { reachable } from './net-probe.mjs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CATALOG = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'musicCatalog.json'))
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.music-lib-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 14
let emitted = 0
let pass = 0
let fail = 0
let skip = 0
const failures = []

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
  try {
    const pid = app.process()?.pid
    if (pid) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 进程可能已经退了 */
  }
  await sleep(400)
}

const WATCHDOG_MS = Number(process.env.MUSIC_LIB_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

/** 面板此刻的样子：卡片数量、每张的状态、播放器的 src 与播放进度 */
const panelState = (page, kind) =>
  page.evaluate((want) => {
    const grid = document.querySelector(`[data-music-grid]`)
    const cards = [...document.querySelectorAll('[data-music-card]')]
    const audio = document.querySelector('[data-music-audio]')
    return {
      panel: document.querySelector('[data-music-panel]')?.getAttribute('data-music-panel') || '',
      groups: document.querySelectorAll('[data-music-cat]').length,
      cards: cards.map((node) => ({
        id: node.getAttribute('data-music-card'),
        kind: node.getAttribute('data-music-kind'),
        cached: node.getAttribute('data-music-cached'),
        playing: node.getAttribute('data-music-playing'),
        progress: node.getAttribute('data-music-progress') || '',
        name: String(node.querySelector('strong')?.textContent || '')
      })),
      gridCat: grid ? grid.getAttribute('data-music-grid') : '',
      audio: audio
        ? { src: String(audio.getAttribute('src') || audio.src || ''), time: Number(audio.currentTime) || 0, paused: Boolean(audio.paused) }
        : null,
      want
    }
  }, kind)

async function main() {
  console.log('=== 预置音乐 / 音效 E2E ===\n')

  /* 夹具草稿：空时间线即可 —— 这道闸门判的是面板与缓存，不依赖画面 */
  const musicFirst = CATALOG.items.find((it) => it.kind === 'music')
  const sfxFirst = CATALOG.items.find((it) => it.kind === 'sfx')
  check('清单里同时有音乐与音效', Boolean(musicFirst && sfxFirst), `${CATALOG.items.length} 条`)

  if (!fs.existsSync(EXE)) {
    check('找到 electron', false, EXE)
    backfillSkips('找不到 electron')
    return
  }

  const online = await reachable(musicFirst.url, 20000)
  console.log(`  · 音频源可达：${online ? '是' : '否（下载相关断言将记 SKIP）'}`)

  let app = null
  const pageErrors = []

  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text())
    })
    await page.waitForSelector('.home', { timeout: 30000 })

    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: 'E2E 预置曲库',
      data: { assets: [], clips: [], playhead: 0, volume: 80, zoom: 1 }
    })
    check('夹具草稿已写入', Boolean(saved?.id), JSON.stringify(saved))
    if (!saved?.id) throw new Error('草稿没存上，后面全部依赖它')

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(800)

    /* ---------- ① 面板真的把清单渲染出来了 ---------- */
    await page.locator('[data-wb-tab="audio"]').click()
    await sleep(400)
    await page.locator('[data-wb-node="audio-music"]').click()
    await page.waitForSelector('[data-music-panel="music"]', { timeout: 15000 })
    await sleep(600)

    const first = await panelState(page, 'music')
    check('「音频 → 音乐」打开的是曲库面板', first.panel === 'music', `panel=${first.panel}`)
    check('卡片渲染出来了（不是空列表）', first.cards.length >= 10, `${first.cards.length} 张`)
    check('分类子页签也在（能按题材翻）', first.groups >= 5, `${first.groups} 个分类`)
    check(
      '卡片名是中文（不是 mus-127 这种机器串）',
      first.cards.length > 0 && /[\u4e00-\u9fa5]/.test(first.cards[0].name),
      first.cards[0] ? first.cards[0].name : '无卡片'
    )

    /* ---------- ② 不点不下载 ---------- */
    check(
      '刚打开时一张都没缓存、也没有在下载（"不点击不下载"）',
      first.cards.every((c) => c.cached === '0' && !c.progress),
      `已缓存 ${first.cards.filter((c) => c.cached === '1').length} / 在下载 ${first.cards.filter((c) => c.progress).length}`
    )

    /* ---------- ③ 点一下 → 下到本机 → 真的在播 ---------- */
    const target = first.cards[0]
    if (!online) {
      skipped('点试听后卡片变成"已缓存"', '音频源不可达')
      skipped('播放器拿到本地地址（yjai-media://）', '音频源不可达')
      skipped('声音真的在走（currentTime 增长）', '音频源不可达')
      skipped('卡片进入播放态', '音频源不可达')
    } else {
      await page.locator(`[data-music-audition="${target.id}"]`).click()
      /* 最多等 90 秒：第一首要真下 4MB 左右，慢网下别用 5 秒卡死 */
      let after = null
      for (let i = 0; i < 90; i += 1) {
        after = await panelState(page, 'music')
        const row = after.cards.find((c) => c.id === target.id)
        if (row && row.cached === '1') break
        await sleep(1000)
      }
      const row = after ? after.cards.find((c) => c.id === target.id) : null
      check('点试听后卡片变成"已缓存"（主进程真落盘了）', Boolean(row && row.cached === '1'), `cached=${row ? row.cached : '-'}`)
      check(
        '播放器拿到的是本地地址（yjai-media://，不是远端直链）',
        Boolean(after && after.audio && /^yjai-media:\/\//.test(after.audio.src)),
        after && after.audio ? after.audio.src.slice(0, 46) : '没有 <audio>'
      )
      await sleep(1200)
      const played = await panelState(page, 'music')
      check(
        '声音真的在走（<audio> 的 currentTime 在增长，不是只标了个状态）',
        Boolean(played.audio && played.audio.time > 0.3 && !played.audio.paused),
        played.audio ? `time=${played.audio.time.toFixed(2)} paused=${played.audio.paused}` : '没有 <audio>'
      )
      const row2 = played.cards.find((c) => c.id === target.id)
      check('卡片进入播放态（与声音同一时刻）', Boolean(row2 && row2.playing === '1'), `playing=${row2 ? row2.playing : '-'}`)
    }

    /* ---------- ④ 音效是另一份清单 ---------- */
    await page.locator('[data-wb-node="audio-sfx"]').click()
    await page.waitForSelector('[data-music-panel="sfx"]', { timeout: 15000 })
    await sleep(600)
    const sfx = await panelState(page, 'sfx')
    check(
      '「音效」打开的是音效库（分组字段真的用上了，不是同一屏）',
      sfx.panel === 'sfx' && sfx.cards.every((c) => c.kind === 'sfx'),
      `panel=${sfx.panel} 首张=${sfx.cards[0] ? sfx.cards[0].name : '-'}`
    )

    /* ---------- ⑤ 加入音频轨 ---------- */
    const sfxTarget = sfx.cards[0]
    if (!sfxTarget) {
      skipped('「加入」把这一条落到音频轨', '音效库没有卡片')
    } else {
      if (!online) {
        skipped('「加入」把这一条落到音频轨', '音频源不可达（要先把文件取下来）')
      } else {
        await page.locator(`[data-music-add="${sfxTarget.id}"]`).click()
        let lane = []
        for (let i = 0; i < 40; i += 1) {
          lane = await page.evaluate(() =>
            [...document.querySelectorAll('.wb-tllane[data-lane="audio"] .clip[data-clip]')].map((n) => ({
              id: n.getAttribute('data-clip'),
              text: String(n.textContent || '')
            }))
          )
          if (lane.length) break
          await sleep(500)
        }
        check('「加入」真的在音频轨上落了一个片段', lane.length >= 1, `${lane.length} 条：${lane[0] ? lane[0].text.slice(0, 24) : '-'}`)
      }
    }

    check('全程没有页面级报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '干净')
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    clearTimeout(watchdog)
    await shutdown(app)
    app = null
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true })
    } catch {
      /* 配置目录删不掉不影响结论 */
    }
  }
}

function summary() {
  clearTimeout(watchdog)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`MUSIC_LIB_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('MUSIC_LIB_E2E_FAILED')
  } else {
    console.log('MUSIC_LIB_E2E_OK')
  }
  const code = fail ? 1 : 0
  process.exitCode = code
  process.stdout.write('', () => process.exit(code))
  setTimeout(() => process.exit(code), 1000).unref()
}

main()
  .then(() => summary())
  .catch((error) => {
    console.error(String(error?.stack || error))
    backfillSkips('脚本异常')
    summary()
  })
