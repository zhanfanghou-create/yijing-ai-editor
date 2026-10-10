#!/usr/bin/env node
/**
 * 闸门 · 轨道开关与停用片段：状态真的接进了预览，不是"灯亮了、成片照旧"。
 *
 * ---------------------------------------------------------------------------
 * 这道闸门要挡的是什么
 * ---------------------------------------------------------------------------
 * 轨道头上的「隐藏 / 静音 / 锁定」与右键的「停用片段」是本项目静默失效母题的
 * 重灾区：上一版这三个开关只活在时间线组件的本地 state 里 ——
 * 轨道灯亮了、lane 变灰了，但预览照播、导出照渲，一个像素都不会变。
 * 这类缺陷静态扫描全绿（元素在、类在、回调在），只有真机读**消费端**才知道：
 *
 *   · 静音音频轨 ⇒ 预览里 data-audio-track 的 <audio> 元素必须真的消失；
 *   · 隐藏视频轨 ⇒ 预览的主画面层必须真的换成下一优先级（composite 口径）；
 *   · 停用片段（V）⇒ 片段本体带 is-disabled 态、且预览层列表里没有它；
 *   · 锁定轨 ⇒ 右键菜单里的结构性操作（分割 / 删除）必须真的不可点；
 *   · 开关落盘 ⇒ 重启后轨道状态还在。
 *
 * ---------------------------------------------------------------------------
 * 真值（写死，不 import 被测代码）
 * ---------------------------------------------------------------------------
 *   · 轨道清单       video / overlay / audio / text 共 4 条
 *   · 轨道头按钮     每条轨 2 个：视频类=显隐+锁定，音频=静音+锁定
 *   · 停用快捷键     V（keymap.js ACTIONS）
 *
 * ---------------------------------------------------------------------------
 * 反空洞约定
 * ---------------------------------------------------------------------------
 * · 每一步先断言"前置真的成立"（夹具片段数、audio 元素数），否则后面的
 *   断言会在空集上"通过"；
 * · 静态接线契约抽成纯函数并配 --selftest（正控制组 + 逐条扰动）；
 * · 收尾 withTimeout(app.close) + taskkill（裸 close 在本机永不返回）；
 * · ⚠️ 跑的是 dist-renderer 构建产物，改完渲染层要先构建。
 *
 * 用法：
 *   node tools/check-track-controls.mjs              # 真起 Electron 验证
 *   node tools/check-track-controls.mjs --selftest   # 只跑判据自证（秒级）
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
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.track-profile-${process.pid}`)
const EDITOR_SIZE = [1920, 1032]

/* --------------------------------------------------------- 静态接线契约（纯函数） */

/**
 * 三份源码里的接线事实。每一项都是「少一根线就静默失效」的那种：
 *   · Timeline 挂 tracktoggle 钩子并把开关上抛（onTrackState）
 *   · App 用 effectiveClips 结算、把结算结果喂给预览与导出（renderClips）
 *   · 停用动作有快捷键处理（toggleDisableClip）且轨道状态落盘（trackState）
 */
function trackWiringContract({ timelineSrc, appSrc, sidePanelsSrc, keymapSrc }) {
  const strip = (text) => String(text || '').replace(/\/\*[\s\S]*?\*\//g, '')
  const tl = strip(timelineSrc)
  const app = strip(appSrc)
  const sp = strip(sidePanelsSrc)
  const km = strip(keymapSrc)

  const facts = {
    toggleHooks: {
      ok: /data-tracktoggle=\{`?\$?\{?track\.key\}?:hide/.test(tl) || (tl.includes('data-tracktoggle=') && tl.includes(":hide")),
      detail: 'Timeline 缺 data-tracktoggle 钩子（E2E 与用户都没有可点的轨道开关）'
    },
    lockHooks: {
      ok: /data-tracktoggle=\{`?\$\{track\.key\}?:lock(?![a-zA-Z])/.test(tl) || /:lock[`}]/.test(tl),
      detail: 'Timeline 缺锁定开关（data-tracktoggle :lock）'
    },
    trackStateProp: {
      ok: tl.includes('trackState =') && tl.includes('onTrackState'),
      detail: 'Timeline 缺 trackState / onTrackState —— 开关还留在本地 state（静默失效根因）'
    },
    lockedGuard: {
      ok: tl.includes('trackLocked') && (tl.match(/trackLocked\(/g) || []).length >= 3,
      detail: 'Timeline 的锁定守卫不足 3 处调用（拖动 / 修剪 / 菜单至少各一处）'
    },
    effectiveClips: {
      ok: app.includes('effectiveClips(') && app.includes('compositeAt(activeClips'),
      detail: 'App 没有用 effectiveClips 结算并把 activeClips 喂给 compositeAt'
    },
    renderClipsToExport: {
      ok: app.includes('renderClips={activeClips}') && sp.includes('renderClips || clips'),
      detail: '导出面板没接 renderClips（停用/静音只影响预览、不影响成片）'
    },
    disableAction: {
      ok: app.includes('toggleDisableClip:') && km.includes("id: 'toggleDisableClip'") && km.includes("'V'"),
      detail: 'V 键的停用动作缺处理函数或缺键位登记'
    },
    trackStatePersisted: {
      ok: app.includes("getSetting('trackState')") && app.includes("setSetting('trackState'"),
      detail: '轨道开关没落盘（重启回默认）'
    },
    soloHooks: {
      ok: /:solo[`}]/.test(tl) && tl.includes('AUDIO_CAPABLE'),
      detail: '缺独奏开关（data-tracktoggle :solo），或没用 AUDIO_CAPABLE 排除无音轨的字幕轨'
    },
    replaceWired: {
      ok: tl.includes('data-ctx="replace"') && tl.includes('onReplaceClip') && app.includes('onReplaceClip={replaceClipSource}'),
      detail: '「替换片段」要么菜单里没这一项，要么没接到 App 的 replaceClipSource'
    }
  }
  const failed = Object.entries(facts).filter(([, item]) => !item.ok)
  return { ok: failed.length === 0, detail: failed.map(([key, item]) => `${key}(${item.detail})`).join('; '), facts }
}

/* --------------------------------------------------------- 真机夹具（写死） */

/** 两个片段：一条视频轨（文字素材，纯 DOM 预览）、一条音频轨（坏地址，<audio> 元素照样挂载） */
const CLIPS = [
  {
    id: 'c_video1',
    track: 'video',
    assetId: 'a_text1',
    name: '视频片段甲',
    kind: 'text',
    start: 0,
    duration: 4,
    offset: 0,
    sourceDuration: 4
  },
  {
    id: 'c_audio1',
    track: 'audio',
    assetId: 'a_audio1',
    name: '音频片段乙',
    kind: 'audio',
    start: 0,
    duration: 4,
    offset: 0,
    sourceDuration: 4
  }
]

const ASSETS = [
  { id: 'a_text1', kind: 'text', name: '文字素材甲', text: '轨道闸门甲', url: '' },
  { id: 'a_audio1', kind: 'audio', name: '音频素材乙', url: 'm://track-gate-nonexistent.mp3' }
]

/** 固定断言数（改断言必须同步这里与 verify.mjs 的 expected） */
const TOTAL_ASSERTIONS = 21

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
  console.log(`TRACK_CONTROLS_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${failures}`)
  if (!failures && !aborted) console.log('TRACK_CONTROLS_OK')
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
  console.log('=== 轨道开关接线判据自检（正控制组 + 逐条扰动）===\n')

  const GOOD = {
    timelineSrc: [
      'export default function Timeline({',
      '  trackState = { hidden: [], muted: [], locked: [] },',
      '  onTrackState,',
      '}) {',
      '  const trackLocked = (clip) => lockedSet.has(clip.track)',
      '  const a = <button data-tracktoggle={`${track.key}:hide`} />',
      '  const b = <button data-tracktoggle={`${track.key}:lock`} />',
      '  const c = AUDIO_CAPABLE.has(track.key) ? <button data-tracktoggle={`${track.key}:solo`} /> : null',
      '  const d = <button data-ctx="replace" onClick={() => onReplaceClip(menu.clip.id)} />',
      '  if (trackLocked(clip)) return',
      '  if (trackLocked(clip)) return',
      '  if (trackLocked(clip)) return'
    ].join('\n'),
    appSrc: [
      "import { effectiveClips } from './composite.js'",
      'const activeClips = effectiveClips(clips, trackState)',
      'compositeAt(activeClips, assets, playhead, {})',
      "renderClips={activeClips}",
      'toggleDisableClip: () => {}',
      'onReplaceClip={replaceClipSource}',
      "getSetting('trackState')",
      "setSetting('trackState', trackState)"
    ].join('\n'),
    sidePanelsSrc: "if (mode === 'export') return <ExportPanel clips={renderClips || clips} />",
    keymapSrc: "{ id: 'toggleDisableClip', keys: ['V'] }"
  }

  const base = trackWiringContract(GOOD)
  check('自检 · 正控制组全绿', base.ok, base.detail)

  const cases = [
    ['toggleHooks', (g) => { g.timelineSrc = g.timelineSrc.replace(':hide', ':show') }],
    ['lockHooks', (g) => { g.timelineSrc = g.timelineSrc.replace(':lock', ':lockx') }],
    ['trackStateProp', (g) => { g.timelineSrc = g.timelineSrc.replace('onTrackState,', 'onTrackSt,') }],
    ['lockedGuard', (g) => { g.timelineSrc = g.timelineSrc.split('trackLocked(clip)').slice(0, 3).join('trackLocked(clip)') }],
    ['effectiveClips', (g) => { g.appSrc = g.appSrc.replace('compositeAt(activeClips', 'compositeAt(clipsX') }],
    ['renderClipsToExport', (g) => { g.appSrc = g.appSrc.replace('renderClips={activeClips}', 'renderClips={clips}') }],
    ['disableAction', (g) => { g.appSrc = g.appSrc.replace('toggleDisableClip:', 'disableClip:') }],
    ['trackStatePersisted', (g) => { g.appSrc = g.appSrc.replace("getSetting('trackState')", "getSetting('trackSt8')") }],
    ['soloHooks', (g) => { g.timelineSrc = g.timelineSrc.replace(':solo', ':soloX') }],
    ['replaceWired', (g) => { g.appSrc = g.appSrc.replace('onReplaceClip={replaceClipSource}', 'onReplaceClip={undefined}') }]
  ]

  for (const [key, breakIt] of cases) {
    const clone = {
      timelineSrc: GOOD.timelineSrc,
      appSrc: GOOD.appSrc,
      sidePanelsSrc: GOOD.sidePanelsSrc,
      keymapSrc: GOOD.keymapSrc
    }
    breakIt(clone)
    const result = trackWiringContract(clone)
    const hit = !result.ok && !result.facts[key].ok
    const others = Object.entries(result.facts).filter(([k, item]) => k !== key && !item.ok)
    check(`自检 · 扰动 ${key} 判红${others.length ? `（误伤：${others.map(([k]) => k).join('/')}）` : ''}`, hit, result.detail)
  }

  const pass = cases.length + 1
  console.log(`\nTRACK_CONTROLS_SELFTEST_STATS total=${pass} pass=${failures === 0 ? pass : pass - failures} fail=${failures}`)
  if (failures) {
    console.log('TRACK_CONTROLS_SELFTEST_FAILED')
    process.exitCode = 1
  } else {
    console.log('TRACK_CONTROLS_SELFTEST_OK')
    process.exitCode = 0
  }
}

/* --------------------------------------------------------- 真机主流程 */

async function main() {
  console.log('=== 轨道开关与停用片段闸门（真启 Electron + 真点击 + 真读渲染）===\n')

  if (!fs.existsSync(EXE)) {
    check('前置 · 找到 electron', false, `找不到 ${EXE}`)
    aborted = 'electron 不存在'
    return summary()
  }
  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    check('前置 · 构建产物存在', false, `${path.relative(ROOT, dist)} 缺失 —— 先构建渲染层`)
    aborted = 'dist-renderer/index.html 缺失'
    return summary()
  }

  /* ---- 静态接线契约（源码级，防止"钩子被改名后 E2E 全部空转"） ---- */
  const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const wiring = trackWiringContract({
    timelineSrc: readSrc('packages/desktop/src/renderer/components/Timeline.jsx'),
    appSrc: readSrc('packages/desktop/src/renderer/App.jsx'),
    sidePanelsSrc: readSrc('packages/desktop/src/renderer/components/SidePanels.jsx'),
    keymapSrc: readSrc('packages/desktop/src/renderer/keymap.js')
  })
  check('静态 · 轨道开关接线契约（Timeline/App/导出/键位四处都在）', wiring.ok, wiring.detail)

  try {
    fs.rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* 删不掉就带着旧设置启动 */
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
    await sleep(1800)
    await resize()
    await sleep(600)

    const saved = await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      { name: 'E2E 轨道开关', data: { clips: CLIPS, assets: ASSETS, playhead: 0, volume: 80, zoom: 1 } }
    )
    check('夹具 · 草稿已写入', Boolean(saved?.id), JSON.stringify(saved))

    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(500)
    await resize()
    await sleep(400)

    const clipCount = await page.locator('.clip[data-clip]').count()
    check('夹具 · 时间线出现 2 个片段', clipCount === 2, `${clipCount} 个`)

    /* 13 = video 4（锁/眼/喇叭/S）+ overlay 4 + audio 3（锁/喇叭/S，**没有眼** ——
       参考的音频轨没有隐藏键，音频没有画面，隐藏无意义）+ text 2（锁/眼，没有声音）。
       给没有音轨的字幕轨挂喇叭和独奏 = 点了画面一个像素都不会变，那是装饰。 */
    const headButtons = await page.locator('[data-tracktoggle]').count()
    check('轨道头 · 13 个开关（视频/叠加各 4，音频 3 无眼，字幕 2）', headButtons === 13, `实测 ${headButtons} 个`)

    const textAudibleButtons = await page.locator('[data-trackhead="text"] [data-tracktoggle$=":mute"], [data-trackhead="text"] [data-tracktoggle$=":solo"]').count()
    check('字幕轨 · 不挂喇叭与独奏（它没有音轨）', textAudibleButtons === 0, `实测 ${textAudibleButtons} 个`)

    /* ---- 静音音频轨 → 预览里 <audio> 真的消失 ---- */
    const audioCount = () => page.locator('audio[data-audio-track]').count()
    const before = await audioCount()
    check('前置 · 音频片段在预览里挂了 1 个 <audio>', before === 1, `实测 ${before} 个`)

    await page.locator('[data-tracktoggle="audio:mute"]').click()
    await sleep(400)
    const mutedCount = await audioCount()
    check('静音音频轨 · 预览的 <audio> 真的消失（接线进合成）', mutedCount === 0, `实测 ${mutedCount} 个`)

    await page.locator('[data-tracktoggle="audio:mute"]').click()
    await sleep(400)
    const unmutedCount = await audioCount()
    check('取消静音 · <audio> 回来', unmutedCount === 1, `实测 ${unmutedCount} 个`)

    /* ---- 独奏视频轨 → 音频轨没被独奏 ⇒ 预览的 <audio> 真的消失 ----
       判据挑的是**消费端**：独奏若只改了按钮的 on 样式、没进 composite 的结算，
       这一条立刻就红（与"隐藏/静音"那几条同源的静默失效）。 */
    await page.locator('[data-tracktoggle="video:solo"]').click()
    await sleep(400)
    const soloedAudio = await page.locator('audio[data-audio-track]').count()
    const soloOn = await page.locator('[data-tracktoggle="video:solo"].on').count()
    check(
      '独奏视频轨 · 没被独奏的音频轨真的静音（按钮同时亮起）',
      soloedAudio === 0 && soloOn === 1,
      `<audio> ${soloedAudio} 个，独奏按钮亮=${soloOn}`
    )

    await page.locator('[data-tracktoggle="video:solo"]').click()
    await sleep(400)
    const unsoloedAudio = await page.locator('audio[data-audio-track]').count()
    check('取消独奏 · 音频轨回来', unsoloedAudio === 1, `实测 ${unsoloedAudio} 个`)

    /* ---- 隐藏视频轨 → 预览主画面层换成下一优先级 ---- */
    const mainLayerId = () =>
      page.evaluate(() => {
        const main = document.querySelector('.canvas-layer[data-layer-role="main"], [data-layer-role="main"]')
        return main ? main.getAttribute('data-layer') : ''
      })
    const beforeHide = await mainLayerId()
    check('前置 · 主画面层是视频片段', beforeHide === 'c_video1', `实测 ${beforeHide || '（无主层）'}`)

    await page.locator('[data-tracktoggle="video:hide"]').click()
    await sleep(400)
    const afterHide = await mainLayerId()
    const laneDimmed = await page.locator('.wb-tllane.disabled[data-lane="video"]').count()
    check(
      '隐藏视频轨 · 预览主层不再是该轨片段（lane 同时变灰）',
      afterHide !== 'c_video1' && laneDimmed === 1,
      `主层=${afterHide || '（无）'}，lane 变灰=${laneDimmed}`
    )

    /* ---- 停用片段（V）：片段变灰 + 预览层里没有它 ---- */
    await page.locator('[data-tracktoggle="video:hide"]').click()
    await sleep(400)
    await page.locator('.clip[data-clip="c_video1"]').click()
    await sleep(200)
    await page.keyboard.press('v')
    await sleep(400)
    const disabledMark = await page.locator('.clip[data-clip="c_video1"][data-disabled="1"]').count()
    const mainAfterDisable = await mainLayerId()
    check(
      '停用片段 · 片段标记 data-disabled 且预览主层换人',
      disabledMark === 1 && mainAfterDisable !== 'c_video1',
      `标记=${disabledMark}，主层=${mainAfterDisable || '（无）'}`
    )
    await page.keyboard.press('v')
    await sleep(300)
    const enabledBack = await page.locator('.clip[data-clip="c_video1"][data-disabled="0"]').count()
    check('再按 V · 片段恢复启用', enabledBack === 1, `标记=${enabledBack}`)

    /* ---- 锁定轨：右键菜单的结构性操作真的不可点 ---- */
    await page.locator('[data-tracktoggle="video:lock"]').click()
    await sleep(300)
    await page.locator('.clip[data-clip="c_video1"]').click({ button: 'right' })
    await sleep(400)
    const menuUp = await page.locator('.wb-ctxmenu').count()
    const deleteDisabled = await page.locator('.wb-ctxmenu button:has-text("删除片段")').isDisabled()
    const splitDisabled = await page.locator('.wb-ctxmenu button:has-text("在播放头处分割")').isDisabled()
    /* 「替换片段」要在菜单里真有一项，且锁定时同样不可点（否则等于绕过锁） */
    const replaceUp = await page.locator('.wb-ctxmenu button[data-ctx="replace"]').count()
    const replaceDisabled = await page.locator('.wb-ctxmenu button[data-ctx="replace"]').isDisabled()
    check(
      '替换片段 · 菜单里真有这一项，且锁定时禁用',
      replaceUp === 1 && replaceDisabled === true,
      `存在=${replaceUp}，禁用=${replaceDisabled}`
    )

    check('锁定轨 · 右键菜单弹出且分割/删除被禁用', menuUp === 1 && deleteDisabled && splitDisabled, `菜单=${menuUp} 删除禁用=${deleteDisabled} 分割禁用=${splitDisabled}`)
    await page.keyboard.press('Escape')
    await sleep(300)
    await page.locator('[data-tracktoggle="video:lock"]').click()
    await sleep(300)

    /* ---- 落盘：隐藏后重开草稿，状态还在 ---- */
    await page.locator('[data-tracktoggle="video:hide"]').click()
    await sleep(700) /* settings 落盘是异步的，给足时间 */
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 20000 })
    await sleep(600)
    const persisted = await page.locator('.wb-tllane.disabled[data-lane="video"]').count()
    check('落盘 · 重启后隐藏状态还在', persisted === 1, `lane 变灰=${persisted}`)
    /* 收尾：把隐藏复位，别把闸门自己的偏好留在 profile 里影响下一次 */
    await page.locator('[data-tracktoggle="video:hide"]').click()
    await sleep(300)

    if (pageErrors.length) {
      check('全程无页面错误', false, pageErrors.slice(0, 3).join(' | '))
    } else {
      check('全程无页面错误', true)
    }
  } catch (error) {
    check('流程 · 未中途抛异常', false, error.message)
    aborted = error.message
  } finally {
    await closeApp(app)
  }

  summary()
  /* 强制退出：Electron 的句柄挂在本机上不自己退（见 check-layout-split 同款） */
  process.exit(failures === 0 && !aborted ? 0 : 1)
}

/* --------------------------------------------------------- 入口 */

if (process.argv.includes('--selftest')) {
  selftest()
} else {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
