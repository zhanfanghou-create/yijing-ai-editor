/**
 * 上层素材（画中画）+ 分离音频 的 UI E2E（真启 Electron + 真指针拖动）。
 *
 * 为什么必须有这道：这一批全都是「看着有、其实没接」的高危区，而且失效时**不报错**：
 *   ① 上层素材只占画面一角 —— 默认 size=30 / 上限 60 / 锚点右下，用户怎么拖都铺不满；
 *   ② 拖角缩放绕**中心**缩 —— 被拖的那条边跟手了，对面那条边也在动，
 *      素材像被"吸"着走；正确的事是对角钉在原位；
 *   ③ 右栏对叠加轨开放的调色/调节/位置全都没进预览 —— 滑杆能动、脏点亮、数字在变，
 *      画面一像素不动（预览里不行、成片却正常，所以最容易被当成"预览卡了"）；
 *   ④ 分离音频要么根本没有入口，要么分出去了但原片段还在响（同一段声音播两遍）。
 *
 * 判据一律取**消费端**：
 *   · `getBoundingClientRect()`（盒子到底铺没铺满、被拖角的对角动没动）；
 *   · `.canvas-pip` 的 **computed filter / opacity**（面板推上去的值有没有真的落到那一层）；
 *   · 时间线片段 DOM 上的 `data-clip-gain` / `data-clip-detached`（草稿真被写成什么样）。
 * 不读 React state —— 读 state 等于自己证明自己。
 *
 * 断言总数恒为 22：缺 ffmpeg / electron 时逐条 SKIP，verify 里钉死的数字才有意义。
 *
 * 用法：node tools/pip-edit-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { spawnCapture } from './spawn-capture.mjs'
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
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.pip-edit-profile-${process.pid}`)

const TOTAL_ASSERTIONS = 22
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

const WATCHDOG_MS = Number(process.env.PIP_EDIT_TIMEOUT_MS || 6 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，判定失败`)
  failures.push('看门狗超时（进程被强杀）')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

/** 画框 / 画中画盒子 / 选框的像素矩形（一次取齐，省得三次往返之间有动画在跑） */
const rects = (page) =>
  page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    return {
      frame: pick('.canvas-frame'),
      box: pick('[data-pip-box]'),
      sel: pick('.canvas-sel'),
      pipInfo: (() => {
        const el = document.querySelector('[data-pip="1"]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          anchor: el.getAttribute('data-pip-anchor'),
          size: Number(el.getAttribute('data-pip-size')),
          offsetX: Number(el.getAttribute('data-pip-offset-x')),
          offsetY: Number(el.getAttribute('data-pip-offset-y')),
          /* 盒子宽度按 getBoundingClientRect 量（受 transform 影响 = 用户看到的大小） */
          w: r.width,
          h: r.height,
          x: r.x,
          y: r.y
        }
      })()
    }
  })

/** 某一层的 computed filter / opacity —— 直接读浏览器算出来的，不反解我们拼的串 */
const lookOf = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const cs = getComputedStyle(el)
    return { filter: cs.filter, opacity: Number(cs.opacity) }
  }, sel)

/** 右栏滑杆（标签文案匹配）：写值 + 派发 input/change，与手拖同一路径 */
async function setRange(page, labelText, value) {
  return page.evaluate(
    ({ labelText, value }) => {
      const row = Array.from(document.querySelectorAll('.wb-inspbody .slider-row')).find((item) =>
        String(item.querySelector('label')?.textContent || '').startsWith(labelText)
      )
      const input = row?.querySelector('input[type=range]')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    { labelText, value }
  )
}

/** 时间线：某个轨道上有几条片段、各自的声音状态 */
const laneClips = (page, lane) =>
  page.evaluate((key) => {
    const nodes = [...document.querySelectorAll(`.wb-tllane[data-lane="${key}"] .clip[data-clip]`)]
    return nodes.map((node) => ({
      id: node.getAttribute('data-clip'),
      gain: Number(node.getAttribute('data-clip-gain')),
      detached: node.getAttribute('data-clip-detached') || ''
    }))
  }, lane)

async function main() {
  console.log('=== 上层素材 / 右栏调整 / 分离音频 E2E ===\n')

  const found = render.findFfmpeg()
  if (!found || !found.ffmpeg) {
    check('能找到 ffmpeg', false, '未找到')
    backfillSkips('本机没有 ffmpeg')
    return
  }
  const ffmpeg = found.ffmpeg
  const probe = spawnCapture(ffmpeg, ['-version'], { tag: 'ver' })
  check('ffmpeg 可执行（-version 返回 0）', probe.status === 0, String(probe.stdout || '').split('\n')[0])

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-pip-'))
  const clipA = path.join(work, 'a-green.mp4')
  /* 320×240 够用：这道闸门判的是几何与样式，不是画质。
     带一条音轨 —— 分离音频那几条断言要有声音可拆（-an 的话连音轨都没有，
     "分离出来没有声"会变成"本来就无声"，判不出来）。 */
  spawnCapture(
    ffmpeg,
    [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipA
    ],
    { tag: 'mk' }
  )
  const made = fs.existsSync(clipA) && fs.statSync(clipA).size > 1024
  check('测试素材生成完毕（8 秒画面 + 音轨）', made, made ? clipA : '生成失败')
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

    const rows = await page.evaluate((p) => window.yjai.media.stat(p), [clipA])
    const list = Array.isArray(rows) ? rows : []
    if (list.length !== 1) throw new Error('素材没登记上：后面所有断言都依赖它')

    /* 夹具：主画面 + 上层素材（叠加轨）。
       ⚠️ 上层素材**故意不写 pip 字段** —— 要验的就是"没设过的时候默认铺满"。
          写一个 size 进去，测试就变成了"验我自己写的那个数字"。 */
    const saved = await page.evaluate((payload) => window.yjai.draft.save(payload), {
      name: 'E2E 上层素材与分离音频',
      data: {
        assets: list.map((item) => ({ ...item, id: 'pip_asset' })),
        clips: [
          {
            id: 'pip_main',
            track: 'video',
            assetId: 'pip_asset',
            kind: 'video',
            name: '主画面',
            url: list[0].url,
            path: clipA,
            start: 0,
            duration: 8,
            offset: 0,
            sourceDuration: 8,
            speed: 1,
            gain: 100
          },
          {
            id: 'pip_over',
            track: 'overlay',
            assetId: 'pip_asset',
            kind: 'video',
            name: '上层素材',
            url: list[0].url,
            path: clipA,
            start: 0,
            duration: 8,
            offset: 0,
            sourceDuration: 8,
            speed: 1
          }
        ],
        playhead: 3,
        volume: 80,
        zoom: 1
      }
    })
    check('夹具草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await sleep(900)

    /* -------------------- ① 默认铺满 -------------------- */

    const shot = await rects(page)
    check('上层素材的盒子已渲染（有可用矩形）', Boolean(shot.frame && shot.box), `${shot.frame ? Math.round(shot.frame.w) + '×' + Math.round(shot.frame.h) : 'null'}`)
    if (!shot.frame || !shot.box) throw new Error('画布或画中画盒子没出来，后面全部依赖它')

    check(
      '默认就是**铺满**：盒子宽度 = 画布宽度',
      Math.abs(shot.box.w - shot.frame.w) <= 2,
      `盒 ${shot.box.w.toFixed(1)} / 画布 ${shot.frame.w.toFixed(1)}`
    )
    check(
      '默认铺满：盒子左边缘贴着画布左边缘（不是偏在某一角）',
      Math.abs(shot.box.x - shot.frame.x) <= 2,
      `盒 ${shot.box.x.toFixed(1)} / 画布 ${shot.frame.x.toFixed(1)}`
    )
    check(
      '默认参数 = 尺寸 100% · 居中锚点（规格真源 shared/pip.json）',
      shot.pipInfo && shot.pipInfo.size === 100 && shot.pipInfo.anchor === 'center',
      `size=${shot.pipInfo?.size} anchor=${shot.pipInfo?.anchor}`
    )

    /* -------------------- ② 选框贴合素材四边 -------------------- */

    const cx = shot.box.x + shot.box.w / 2
    const cy = shot.box.y + shot.box.h / 2
    await page.keyboard.press('Escape')
    await sleep(200)
    await page.mouse.click(cx, cy)
    await sleep(350)

    const picked = await page.evaluate(() => {
      const el = document.querySelector('.canvas-sel')
      return el ? { kind: el.getAttribute('data-sel-kind'), id: el.getAttribute('data-sel-id') } : null
    })
    check(
      '点上层素材 ⇒ 选中它（选框 kind=pip 且 id 与片段一致）',
      Boolean(picked) && picked.kind === 'pip' && picked.id === 'pip_over',
      JSON.stringify(picked)
    )

    const fitted = await rects(page)
    /* 判据是"四条边贴合"：只比尺寸会被**位置错开**骗过去（宽度一样、整体偏到画布外），
       那正是"手柄看得见、却不在素材角上"的成因。所以尺寸与位置一起比。 */
    check(
      '选框高度与顶边都贴住素材（以前高度是 0，四个手柄全叠在顶边）',
      Boolean(fitted.sel) && Math.abs(fitted.sel.h - fitted.box.h) <= 2 && Math.abs(fitted.sel.y - fitted.box.y) <= 2,
      `选框 ${fitted.sel ? fitted.sel.h.toFixed(1) : '-'} @${fitted.sel ? fitted.sel.y.toFixed(1) : '-'} / 盒 ${fitted.box.h.toFixed(1)} @${fitted.box.y.toFixed(1)}`
    )
    check(
      '选框宽度与左边都贴住素材（手柄落在素材角上，不是画布角上）',
      Boolean(fitted.sel) && Math.abs(fitted.sel.w - fitted.box.w) <= 2 && Math.abs(fitted.sel.x - fitted.box.x) <= 2,
      `选框 ${fitted.sel ? fitted.sel.w.toFixed(1) : '-'} @${fitted.sel ? fitted.sel.x.toFixed(1) : '-'} / 盒 ${fitted.box.w.toFixed(1)} @${fitted.box.x.toFixed(1)}`
    )

    /* -------------------- ③ 拖角缩放：对角钉住 -------------------- */

    /* 先把盒子缩小到 60%，让右下角手柄稳稳落在画布内部 ——
       size=100 时手柄正好压在画布边界上（overflow:hidden 会切掉它的一半），
       那属于"手柄点不到"，跟"缩放没接"是两件事，混在一起会误判。 */
    await page.locator('[data-insp-tab="visual"]').click()
    await sleep(250)
    /* ⚠️ 必须限定在九宫格里：预览层的 `.canvas-pip-layer` 也带 `data-pip-anchor`
       （同一个名字，两个用途：一个是"当前锚点"、一个是"点它换成这个锚点"）。 */
    await page.locator('.wb-pipgrid [data-pip-anchor="right-bottom"]').click()
    await sleep(300)
    const slid = await setRange(page, '画中画大小', 60)
    await sleep(400)

    const small = await rects(page)
    check(
      '右栏「画中画大小」能改到 60%（上限不再是 60，可自由缩放）',
      slid && small.pipInfo && small.pipInfo.size === 60 && Math.abs(small.box.w - small.frame.w * 0.6) <= 3,
      `size=${small.pipInfo?.size} 盒 ${small.box.w.toFixed(1)} / 期望 ${(small.frame.w * 0.6).toFixed(1)}`
    )

    const handle = await page.locator('[data-sel-handle="se"]').boundingBox()
    if (handle) {
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 + 90, handle.y + handle.height / 2 + 60, { steps: 8 })
      await page.mouse.up()
      await sleep(400)
    }
    const grown = await rects(page)
    check(
      '拖右下角 ⇒ 左上角**一动不动**（对角钉住，不是绕中心缩）',
      Boolean(handle) && Math.abs(grown.box.x - small.box.x) <= 2 && Math.abs(grown.box.y - small.box.y) <= 2,
      `拖前 (${small.box.x.toFixed(1)}, ${small.box.y.toFixed(1)}) ${small.box.w.toFixed(1)}×${small.box.h.toFixed(1)} → 拖后 (${grown.box.x.toFixed(1)}, ${grown.box.y.toFixed(1)}) ${grown.box.w.toFixed(1)}×${grown.box.h.toFixed(1)} offset=(${grown.pipInfo?.offsetX}, ${grown.pipInfo?.offsetY})`
    )
    check(
      '拖右下角 ⇒ 盒子真的变大了（不是"手柄在动、尺寸没变"）',
      Boolean(handle) && grown.box.w > small.box.w + 40,
      `${small.box.w.toFixed(1)} → ${grown.box.w.toFixed(1)}`
    )

    /* -------------------- ④ 右栏调整对上层素材生效 -------------------- */

    if (process.env.PIP_EDIT_DEBUG) {
      const dbg = await page.evaluate(() => ({
        sel: document.querySelector('.canvas-sel')?.getAttribute('data-sel-id') || null,
        clipSel: document.querySelector('.clip.selected')?.getAttribute('data-clip') || null,
        tabs: [...document.querySelectorAll('[data-insp-tab]')].map((el) => el.getAttribute('data-insp-tab')),
        panelTabs: [...document.querySelectorAll('[data-panel-tab]')].map((el) => el.getAttribute('data-panel-tab'))
      }))
      console.log('  [debug] ' + JSON.stringify(dbg))
    }

    const pipBefore = await lookOf(page, '[data-pip-box]')
    const mainBefore = await lookOf(page, '.canvas-layer[data-selectable]')
    await page.locator('[data-insp-tab="adjust"]').click()
    await sleep(250)
    await setRange(page, '亮度', 40)
    await sleep(400)
    const pipAfter = await lookOf(page, '[data-pip-box]')
    const mainAfter = await lookOf(page, '.canvas-layer[data-selectable]')
    check(
      '拖「亮度」⇒ 上层素材那一层真的挂上了逐通道增益矩阵',
      Boolean(pipAfter) && (pipAfter.filter || '').includes('yjai-grade'),
      `${pipBefore?.filter || '(空)'} → ${pipAfter?.filter || '(空)'}`
    )
    check(
      '同一手势**没有**串到主画面（增益只挂在被选中的那一层上）',
      Boolean(mainAfter) === Boolean(mainBefore) && !(mainAfter?.filter || '').includes('yjai-grade'),
      `主画面 filter=${mainAfter?.filter || '(空)'}`
    )

    await page.locator('[data-insp-tab="visual"]').click()
    await sleep(250)
    await setRange(page, '不透明度', 50)
    await sleep(400)
    const pipOpacity = await lookOf(page, '[data-pip-box]')
    check(
      '拖「不透明度」⇒ 上层素材的 computed opacity ≈ 0.5',
      Boolean(pipOpacity) && Math.abs(pipOpacity.opacity - 0.5) <= 0.03,
      `opacity=${pipOpacity?.opacity}`
    )

    /* -------------------- ⑤ 分离音频 -------------------- */

    const mainClip = page.locator('.wb-tllane[data-lane="video"] .clip[data-clip]').first()
    await mainClip.click({ button: 'right' })
    await sleep(350)
    const hasMenu = await page.locator('[data-ctx="detach-audio"]').count()
    check('右键片段菜单里有「分离音频到音频轨」', hasMenu === 1, `${hasMenu} 项`)

    await page.locator('[data-ctx="detach-audio"]').click()
    await sleep(600)
    const audioAfter = await laneClips(page, 'audio')
    const videoAfter = await laneClips(page, 'video')
    check(
      '分离后音频轨上多出一条，且记着它是从哪一段拆出来的',
      audioAfter.length === 1 && audioAfter[0].detached === 'pip_main',
      JSON.stringify(audioAfter)
    )
    check(
      '原片段被静音（gain = 0，否则同一段声音会响两遍）',
      videoAfter.length === 1 && videoAfter[0].gain === 0,
      JSON.stringify(videoAfter)
    )

    /* 再点一次：不该长出第二条（同一条声音拆两次 = 叠着响两遍） */
    await mainClip.click({ button: 'right' })
    await sleep(300)
    await page.locator('[data-ctx="detach-audio"]').click()
    await sleep(500)
    const duplicate = await laneClips(page, 'audio')
    check('再分离一次不新增（判重生效）', duplicate.length === 1, `${duplicate.length} 条`)

    /* 删掉分离出来的音频片段 ⇒ 原片段的音量必须**还回去**。
       不还的话：画面在播、完全没声音，片段上一点提示都没有。
       ⚠️ 原来这里用「双击片段=删除」，2026-11-19 起双击改成「定位+打开属性」
       （主流剪辑器惯例，杜绝手抖误删）。删除走单击选中 + Delete 键。 */
    await page.locator('.wb-tllane[data-lane="audio"] .clip[data-clip]').first().click()
    await sleep(150)
    await page.keyboard.press('Delete')
    await sleep(600)
    const audioGone = await laneClips(page, 'audio')
    const videoBack = await laneClips(page, 'video')
    check(
      '删掉音频片段 ⇒ 原片段音量还原成 100（分离的另一半：还原）',
      audioGone.length === 0 && videoBack.length === 1 && videoBack[0].gain === 100,
      `音频轨 ${audioGone.length} 条 / 原片段 gain=${videoBack[0]?.gain}`
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
  }
}

function summary() {
  clearTimeout(watchdog)
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 / 跳过 ${skip} 项 ===`)
  console.log(`PIP_EDIT_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：' + failures.join(' | '))
    console.log('PIP_EDIT_FAILED')
  } else {
    console.log('PIP_EDIT_OK')
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
