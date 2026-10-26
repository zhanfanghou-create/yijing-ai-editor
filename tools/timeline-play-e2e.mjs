/**
 * 整条时间线连续播放 E2E：真启 Electron + ffmpeg 现造两段影片 + 真按键走播放头。
 *
 * 为什么必须单独一道闸门（这是"按时间线合成预览"唯一的**行为级**证据）：
 *
 *   预览以前是「取播放头所在的**一个**片段，塞进**一个** <video>」。
 *   于是每过一个接缝就要**换那个元素的 src** ⇒ 重新加载 + 重新解码 ⇒
 *   接缝处必黑一帧。转场尤其明显：后一段是在交叠窗口**开始的那一刻**
 *   才被新建出来的元素，所以每个转场的第一帧都是黑的。
 *
 *   这种缺陷在下面三种检查里**全绿**：
 *     · 静态扫描（代码完全合法）
 *     · 构建（不报错）
 *     · 逐像素截图（截图永远拍在稳定态，拍不到切换那一帧）
 *   只有"从头播一遍"才知道 —— 而手播没人会回归，所以必须由夹具钉住。
 *
 * 这里断言的是**元素身份**（不是 src 字符串）：给每个 <video> 打一个只增不减的标记，
 * 跨接缝之后标记不变 ⇒ 元素从未被重建 ⇒ 没有换 src ⇒ 不会黑帧。
 * 只用 src 字符串证明不了这件事：同一个 src 也可能挂在新建的元素上。
 *
 * 断言总数恒为 15：找不到 ffmpeg / electron 时逐条 SKIP（不是少跑），
 * verify.mjs 里钉死的数字才有意义。
 *
 * 用法：node tools/timeline-play-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { spawnCapture } from './spawn-capture.mjs'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))
/** profile 目录按 pid 唯一：固定目录名在前一轮异常退出时删不掉，会带着上一轮的设置启动 */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.timeline-play-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 17
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

/** 关掉 Electron：先礼后兵。超时按 pid 强杀进程树 —— 超时是环境属性，不判失败 */
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
  await sleep(500)
}

const WATCHDOG_MS = Number(process.env.TIMELINE_PLAY_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

/** 逐帧步进（真按键，走帧网格）；Shift+→ = 前进 1 秒 */
async function stepFrames(page, times) {
  for (let i = 0; i < times; i += 1) await page.keyboard.press('ArrowRight')
}
async function stepSeconds(page, times) {
  for (let i = 0; i < times; i += 1) await page.keyboard.press('Shift+ArrowRight')
}

/**
 * 给画面上的每个媒体元素打一个**只增不减**的标记，并把它的身份读回来。
 *
 * 标记是挂在 DOM 元素上的（`dataset.yjTag`）：元素被 React 重建时属性随之消失，
 * 于是会拿到一个新号 —— 这正是"换了 src（其实是换了元素）"的判据。
 */
function readLayers(page) {
  return page.evaluate(() => {
    window.__yjTagSeq = window.__yjTagSeq || 0
    const nodes = Array.from(document.querySelectorAll('.canvas-frame [data-layer]'))
    const out = []
    for (const host of nodes) {
      const media = host.querySelector('video, img')
      if (media && !media.dataset.yjTag) media.dataset.yjTag = 'T' + ++window.__yjTagSeq
      out.push({
        layer: host.getAttribute('data-layer'),
        role: host.getAttribute('data-layer-role'),
        xfade: host.getAttribute('data-xfade'),
        visible: getComputedStyle(host).display !== 'none',
        tag: media ? media.dataset.yjTag : null,
        src: media ? media.getAttribute('src') || '' : null
      })
    }
    return out
  })
}

const sourceTimeOf = (page) =>
  page.evaluate(() => document.querySelector('.wb-player')?.getAttribute('data-source-time') || '')

async function main() {
  console.log('=== 整条时间线连续播放 E2E（真影片 + 真按键 + 元素身份）===\n')

  /* ------------------------------ 素材：ffmpeg 现造 ------------------------------ */

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    check('能找到 ffmpeg', false, '未找到')
    backfillSkips('本机没有 ffmpeg')
    return
  }
  const ffmpeg = found.ffmpeg
  const probe = spawnCapture(ffmpeg, ['-version'], { tag: 'ver' })
  check('ffmpeg 可执行（-version 返回 0）', probe.status === 0, String(probe.stdout || '').split('\n')[0])

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-tlplay-'))
  const clipA = path.join(work, 'a-red.mp4')
  const clipB = path.join(work, 'b-blue.mp4')
  const mk = (args) => spawnCapture(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', ...args], { tag: 'mk' })
  const r1 = mk(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', clipA])
  const r2 = mk(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', clipB])
  const made = fs.existsSync(clipA) && fs.existsSync(clipB) && fs.statSync(clipA).size > 1024 && fs.statSync(clipB).size > 1024
  check('测试素材生成完毕（两段 3 秒影片）', made, r1.status === 0 && r2.status === 0 ? `${clipA} / ${clipB}` : String(r2.stdout || r1.stdout || '').slice(0, 120))
  if (!made) {
    backfillSkips('素材没造出来，后面依赖它')
    return
  }

  if (!fs.existsSync(EXE)) {
    check('找到 electron', false, EXE)
    backfillSkips('找不到 electron')
    return
  }

  let app = null
  const pageErrors = []

  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text())
    })
    await page.waitForSelector('.home', { timeout: 30000 })

    /* ---------------------- 登记素材 → 写草稿 → 打开 ---------------------- */

    const rows = await page.evaluate((paths) => window.yjai.media.stat(paths), [clipA, clipB])
    const list = Array.isArray(rows) ? rows : []
    check(
      '两段影片都登记为视频素材（URL 走自定义协议）',
      list.length === 2 && list.every((item) => item.kind === 'video' && String(item.url).startsWith('yjai-media://')),
      list.map((item) => item.name + ':' + item.kind).join(' | ')
    )
    if (list.length !== 2) throw new Error('素材没登记上：后面所有断言都依赖它')

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: 'E2E 连续播放',
        data: {
          /* ⚠️ media.stat 返回的素材**不带 id**（实测），这里必须显式给一个：
             片段的 assetId 为空时，合成器一律退回片段自己记的 url（见 composite.js 的
             assetOf）—— 那是防御路径，不是本用例要验的东西，夹具要走在正常路径上。 */
          assets: list.map((item, index) => ({ ...item, id: `tp_asset_${index === 0 ? 'a' : 'b'}` })),
          clips: [
            {
              id: 'tp_a',
              track: 'video',
              assetId: list[0].id,
              kind: 'video',
              name: list[0].name,
              url: list[0].url,
              path: clipA,
              start: 0,
              duration: 3,
              offset: 0,
              sourceDuration: 3,
              /* 转场 fade 1s ⇒ 交叠窗口 = [2, 3) */
              transition: 'fade',
              transitionDuration: 1
            },
            {
              id: 'tp_b',
              track: 'video',
              assetId: list[1].id,
              kind: 'video',
              name: list[1].name,
              url: list[1].url,
              path: clipB,
              start: 3,
              duration: 3,
              offset: 0,
              sourceDuration: 3
            }
          ],
          playhead: 0,
          volume: 80,
          zoom: 1
        }
      }
    )
    check('夹具草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(600)

    const clipCount = await page.locator('.clip[data-clip]').count()
    check('打开草稿后时间线出现 2 个片段', clipCount === 2, `${clipCount} 个`)

    /* ------------------------- 1.0s：两段应该都已在场 ------------------------- */

    await page.keyboard.press('Home')
    await sleep(200)
    await stepSeconds(page, 1)
    await sleep(300)

    const at1 = await readLayers(page)
    check(
      '播放头 1.0s → 画面层有 2 个（后一段已**提前挂载**）',
      at1.length === 2,
      at1.map((l) => `${l.layer}:${l.role}`).join(' ')
    )
    const visibleAt1 = at1.filter((l) => l.visible)
    check(
      '播放头 1.0s → 只有一段是可见的，且它是主层（甲）',
      visibleAt1.length === 1 && visibleAt1[0].role === 'main' && visibleAt1[0].layer === 'tp_a',
      visibleAt1.map((l) => `${l.layer}:${l.role}`).join(' ') || '无可见层'
    )
    check(
      '播放头 1.0s → 两层各自持有一个媒体元素，src 分别对应两段影片',
      at1.every((l) => l.tag && l.src) && new Set(at1.map((l) => l.src)).size === 2,
      at1.map((l) => l.layer + '=' + l.tag + '|' + String(l.src).slice(-18)).join('  ')
    )
    const pairAt1 = at1.reduce((acc, item) => ({ ...acc, [item.layer]: item }), {})

    /* ---------------- 2.5s：转场交叠窗口，后一段必须已就位 ---------------- */

    await stepSeconds(page, 1)
    await stepFrames(page, 15)
    await sleep(300)

    const at25 = await readLayers(page)
    const xf = at25.find((l) => l.xfade)
    check(
      '播放头 2.5s → 转场层出现（交叠窗口 [2,3) 内）',
      Boolean(xf) && xf.xfade === 'fade',
      xf ? `data-xfade=${xf.xfade}` : at25.map((l) => `${l.layer}:${l.role}`).join(' ')
    )
    check(
      '转场里的后一段用的是**提前挂载的那个元素**（不是临到窗口才新建 ⇒ 转场第一帧不黑）',
      Boolean(xf) && xf.tag === pairAt1.tp_b?.tag,
      xf ? `转场元素 ${xf.tag}，1.0s 时乙是 ${pairAt1.tp_b?.tag}` : '没有转场层'
    )
    const mainAt25 = at25.find((l) => l.role === 'main')
    check(
      '转场中主层仍是前一段（播放头还压在前一段那一格上）',
      mainAt25?.layer === 'tp_a',
      String(mainAt25?.layer)
    )

    /* -------------------- 4.0s：跨过接缝，元素身份必须不变 -------------------- */

    await stepSeconds(page, 1)
    await stepFrames(page, 15)
    await sleep(300)

    const at4 = await readLayers(page)
    check(
      '播放头 4.0s → 主层变成后一段（乙）',
      at4.find((l) => l.role === 'main')?.layer === 'tp_b',
      at4.map((l) => `${l.layer}:${l.role}`).join(' ')
    )
    check(
      '跨过接缝后两层的**元素身份完全没变**（⇒ 全程没有换 src，接缝不会黑一帧）',
      at4.length === 2 && at4.every((l) => pairAt1[l.layer] && pairAt1[l.layer].tag === l.tag),
      at4.map((l) => `${l.layer}=${l.tag}(1.0s 时 ${pairAt1[l.layer]?.tag})`).join(' ')
    )
    check(
      '跨过接缝后两层的 src 也没变',
      at4.every((l) => pairAt1[l.layer] && pairAt1[l.layer].src === l.src)
    )
    check(
      '播放头 4.0s → 源时间按后一段自己算（0 + (4−3) = 1.000）',
      (await sourceTimeOf(page)) === '1.000',
      await sourceTimeOf(page)
    )

    /* ------------------------ 真按播放键：时间真的在走 ------------------------ */

    /*
     * ⚠️ 这里**先退回 1.0s 再起播**，不从 4.0s 起播。
     *
     * 2026-10-24 真实踩到一次假红：`1.000 → 0.000`。原因不是功能坏了 ——
     * 4.0s 起播只剩 2s 余量，而 `sleep(1500)` 在机器被别的构建拖慢时会被拉长，
     * 播放越过 6.0s 结尾**回绕到 0**，于是"源时间"从 1.000 变成 0.000，
     * 断言"没推进"就这么红了。功能是对的，判据假设了"1.5 秒内到不了结尾"。
     *
     * 改成：① 退到 1.0s（留 5s 余量，回绕不可能发生）；
     *      ② 播到中途**再采样一次** —— 这样证明的是"连续在走"，
     *         比原来只看首尾两个点更强（原来"跳一下就停"也能过）。
     */
    await page.keyboard.press('Home')
    await sleep(150)
    await stepSeconds(page, 1)
    await sleep(250)

    const before = Number(await sourceTimeOf(page))
    await page.locator('.wb-transport-btns button.play').click()
    await sleep(500)
    const mid = Number(await sourceTimeOf(page))
    await sleep(700)
    await page.locator('.wb-transport-btns button.play').click()
    await sleep(200)
    const after = Number(await sourceTimeOf(page))
    check(
      '真按播放键 ~1.2s → 预览的源时间连续推进（不是只画一帧，也不是跳一下就停）',
      mid > before + 0.2 && after > mid,
      `${before.toFixed(3)} → ${mid.toFixed(3)} → ${after.toFixed(3)}`
    )

    const realErrors = pageErrors.filter((text) => !/Failed to load resource|net::ERR|403|401/i.test(text))
    check('全程无页面错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
  } catch (error) {
    console.error(`\n[!] E2E 中断：${String(error?.stack || error)}`)
    while (emitted < TOTAL_ASSERTIONS - 1) skipped(`第 ${emitted + 1} 项`, '前面出错，本项未执行')
    check('E2E 未中断地跑完', false, String(error?.message || error).split('\n')[0])
  } finally {
    clearTimeout(watchdog)
    await shutdown(app)
    app = null
    /* 收尾不删 profile（Electron 关掉后目录仍被占用，删它会卡死主线程）；
       目录名带 pid、每轮独占，残留不影响下一轮。 */
  }
}

function summary() {
  clearTimeout(watchdog)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`TIMELINE_PLAY_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('TIMELINE_PLAY_FAILED')
  } else {
    console.log('TIMELINE_PLAY_OK')
  }
  const code = fail ? 1 : 0
  process.exitCode = code
  process.stdout.write('', () => process.exit(code))
  setTimeout(() => process.exit(code), 1000).unref()
}

main().catch((error) => {
  console.error('[!] 未捕获异常：' + String(error?.stack || error))
  fail += 1
}).finally(summary)
