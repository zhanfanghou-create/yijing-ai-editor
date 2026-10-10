/**
 * README 取景脚本（开发自检用，不参与打包）。
 *
 * 与 tools/desktop-shoot.mjs 的分工：
 *   desktop-shoot.mjs  对齐参考 QML 尺寸规格，拍的是**空工作台**（量布局用）
 *   本脚本             拍的是**有内容的成品工作台**（README 用），
 *                      所以先用 ffmpeg 现造素材、灌一份多轨草稿，再逐屏取景
 *
 * 为什么不用空工作台放 README：空时间线看不出"这是个能用的剪辑器" ——
 * 没有片段、没有波形、没有转场、预览是黑的。读者第一眼要看到"成品的样子"。
 *
 * 产物落 _recon/readme-shots/（_recon 在 .gitignore 内、且被洁净闸门跳过），
 * 挑选之后再手工复制进 docs/screenshots/。
 *
 * 用法：node tools/readme-shots.mjs
 */
import { _electron as electron } from 'playwright-core'
import { spawnCapture } from './spawn-capture.mjs'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '_recon', 'readme-shots')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

/** profile 必须落 tmpdir（放仓库里句柄放不掉，下一轮必假红） */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.readme-shots-${process.pid}`)
const WORK = path.join(os.tmpdir(), 'yjai-e2e', `.readme-media-${process.pid}`)

const HOME_SIZE = [1220, 720]
const WB_SIZE = [1920, 1080]

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(WORK, { recursive: true })

const step = (m) => console.log(`\n== ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------ 1. ffmpeg 造素材 */

step('生成测试素材（ffmpeg 现造）')
const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.error('[失败] 本机找不到 ffmpeg —— 取景需要它先造素材')
  process.exit(1)
}
const ffmpeg = found.ffmpeg
const mk = (args, tag) => spawnCapture(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', ...args], { tag })

const V = (name) => path.join(WORK, name)
const a = V('scene-a.mp4')
const b = V('scene-b.mp4')
const c = V('scene-c.mp4')
const music = V('music.m4a')
const cover = V('cover.png')

/* 三张画面：三种色调的流动渐变 —— 用彩条/测试图会让人一眼看出"这是夹具"，
   渐变则像抽象 B-roll，README 里的预览才像"成片"。三段色调刻意拉开：
   暖橙 / 蓝青 / 青绿，时间线上相邻片段在缩略图里也不会糊成一条。 */
mk(['-f', 'lavfi', '-i', 'gradients=s=1280x720:r=30:d=6:c0=0xff6b6b:c1=0xffd93d:n=2:speed=0.08:seed=11', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', a], 'a')
mk(['-f', 'lavfi', '-i', 'gradients=s=1280x720:r=30:d=6:c0=0x4facfe:c1=0x00f2fe:n=2:speed=0.12:seed=23', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', b], 'b')
mk(['-f', 'lavfi', '-i', 'gradients=s=1280x720:r=30:d=6:c0=0x43e97b:c1=0x38f9d7:n=2:speed=0.16:seed=37', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', c], 'c')
/* 音乐：用振幅起伏的合成音（纯正弦画出来是一条等高直条，波形看不出"真 PCM"） */
mk(
  ['-f', 'lavfi', '-i', "aevalsrc='0.35*sin(2*PI*220*t)*(0.55+0.45*sin(2*PI*0.45*t))+0.18*sin(2*PI*660*t)':s=44100:d=15", '-c:a', 'aac', '-b:a', '128k', music],
  'music'
)
/* 封面（画中画）：高对比的粉黄渐变 —— 压在彩色背景上才看得见 */
mk(['-f', 'lavfi', '-i', 'gradients=s=1280x720:d=1:c0=0xfa709a:c1=0xfee140:n=2:speed=0.3:seed=5', '-frames:v', '1', cover], 'cover')

const made = [a, b, c, music, cover].filter((p) => fs.existsSync(p) && fs.statSync(p).size > 1024)
console.log(`  造出 ${made.length}/5 个素材`)
if (made.length < 5) {
  console.error('[失败] 素材没造齐，取景中止')
  process.exit(1)
}

/* ------------------------------------------------------------ 2. 启动客户端 */

step('启动真实客户端')
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
delete env.YIJAI_USE_DEV_SERVER

const pageErrors = []
const app = await electron.launch({
  executablePath: EXE,
  args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  cwd: ROOT,
  env
})
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('[console.error] ' + m.text())
})

/**
 * 统一收尾。⚠️ 本机 `app.close()` 有实测永不返回的情况（见 tools/check-e2e-teardown.mjs）：
 * 所以**全脚本只在这一处**碰 `app.close()`，并且必须带超时兜底 ——
 * 散着写就会出现"某个分支裸等 → 整个脚本挂死"。
 */
async function shutdown() {
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 4000))])
}

async function resize([w, h]) {
  await app
    .evaluate(async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(size[0], size[1])
      win.center()
    }, [w, h])
    .catch(() => {})
  await sleep(600)
}

async function shoot(name) {
  await sleep(400)
  const p = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: p })
  const kb = Math.round(fs.statSync(p).size / 1024)
  console.log(`  [shot] ${name}.png  ${kb} KB`)
}

/** 点一个可能被遮挡 / 需要滚动才可见的元素；失败不致命 */
async function tap(sel, label) {
  try {
    const el = await page.$(sel)
    if (!el) {
      console.log(`  [warn] 找不到 ${label || sel}`)
      return false
    }
    await el.click({ timeout: 4000 })
    await sleep(450)
    return true
  } catch (e) {
    console.log(`  [warn] 点不动 ${label || sel}：${String(e.message).slice(0, 80)}`)
    return false
  }
}

await resize(HOME_SIZE)
await page.waitForSelector('.home', { timeout: 30000 })
await sleep(2200)

/* 首页单拍一张（干净态：还没写草稿）。结尾回首页会再拍一张带"最近草稿"的，两张挑一张。 */
await shoot('01-home')

/* ------------------------------------------------------------ 3. 登记素材 → 写草稿 */

step('登记素材并写入多轨草稿')
const rows = await page.evaluate((paths) => window.yjai.media.stat(paths), [a, b, c, music, cover])
const list = Array.isArray(rows) ? rows : []
console.log('  登记结果：' + list.map((r) => `${r.name}=${r.kind}`).join(' | '))
const byName = (n) => list.find((r) => String(r.name).includes(n))
const A = byName('scene-a')
const B = byName('scene-b')
const C = byName('scene-c')
const M = byName('music')
const CV = byName('cover')
if (!A || !B || !C || !M || !CV) {
  console.error('[失败] 有素材没登记上，取景中止')
  await shutdown()
  process.exit(1)
}
const AID = (x, id) => ({ ...x, id })

await page.evaluate(
  (payload) => window.yjai.draft.save(payload),
  {
    name: '产品演示',
    data: {
      assets: [AID(A, 'ra'), AID(B, 'rb'), AID(C, 'rc'), AID(M, 'rm'), AID(CV, 'rv')],
      clips: [
        /* 主轨三段 + 两处叠化 */
        { id: 'r_v1', track: 'video', assetId: 'ra', kind: 'video', name: A.name, url: A.url, path: a, start: 0, duration: 6, offset: 0, sourceDuration: 6, transition: 'fade', transitionDuration: 1 },
        { id: 'r_v2', track: 'video', assetId: 'rb', kind: 'video', name: B.name, url: B.url, path: b, start: 6, duration: 6, offset: 0, sourceDuration: 6, transition: 'fade', transitionDuration: 1 },
        { id: 'r_v3', track: 'video', assetId: 'rc', kind: 'video', name: C.name, url: C.url, path: c, start: 12, duration: 6, offset: 0, sourceDuration: 6 },
        /* 画中画 */
        { id: 'r_pip', track: 'overlay', assetId: 'rv', kind: 'image', name: CV.name, url: CV.url, path: cover, start: 2, duration: 5, offset: 0, sourceDuration: 5, pip: { anchor: 'right-bottom', size: 30 } },
        /* 配乐 + 波形 */
        { id: 'r_au', track: 'audio', assetId: 'rm', kind: 'audio', name: M.name, url: M.url, path: music, start: 0, duration: 15, offset: 0, sourceDuration: 15, gain: 70 },
        /* 字幕 */
        { id: 'r_tx', track: 'text', assetId: '', kind: 'text', name: '字幕一', text: '艺镜剪辑 · 把剪辑做成说话一样简单', textStyle: 'sub-bar', start: 1.5, duration: 4, offset: 0, sourceDuration: 0 }
      ],
      playhead: 2,
      volume: 80,
      zoom: 1
    }
  }
)

/* ------------------------------------------------------------ 4. 打开草稿进工作台 */

step('打开草稿进工作台')
await page.reload()
await page.waitForSelector('.home', { timeout: 30000 })
await sleep(1200)
await page.locator('.home-nav-item', { hasText: '最近草稿' }).click().catch(() => {})
await page.waitForSelector('.home-draft-row', { timeout: 12000 }).catch(() => {})
await page.locator('.home-draft-open').first().click().catch(() => {})
await page.waitForSelector('.wb-timeline', { timeout: 20000 })
await resize(WB_SIZE)
await sleep(1500)

const clipCount = await page.locator('.clip[data-clip]').count()
console.log(`  时间线片段数 = ${clipCount}`)

/* ------------------------------------------------------------ 5. 逐屏取景 */

step('逐屏取景')

/* 1) 首页只需要开头那一张，这里不再重复 */

const T = (wb) => tap(`.wb-tab[data-wb-tab="${wb}"]`, `功能标签 ${wb}`)
const I = (insp) => tap(`.wb-coltab[data-insp-tab="${insp}"]`, `检查器页签 ${insp}`)
const pick = (id) => tap(`.clip[data-clip="${id}"]`, `片段 ${id}`)

/* 2) 工作台总览 */
await shoot('02-workbench')

/* 3) 画面检查器（选中主轨第一段） */
await pick('r_v1')
await I('visual')
await shoot('03-inspector-visual')

/* 4) 调节 / 美颜 */
await I('adjust')
await shoot('04-inspector-adjust')

/* 5) 变速 */
await I('speed')
await shoot('05-inspector-speed')

/* 6) 音频片段 + 音频检查器 */
await pick('r_au')
await I('audio')
await shoot('06-inspector-audio')

/* 7) 字幕（功能标签 + 字幕页签） */
await pick('r_tx')
await T('subtitle')
await I('text')
await shoot('07-subtitle')

/* 8) 特效 */
await T('effect')
await shoot('08-effect')

/* 9) 转场 */
await T('transition')
await shoot('09-transition')

/* 10) 滤镜 */
await T('filter')
await shoot('10-filter')

/* 11) 画面比例 chip（回到媒体文件标签并选中片段） */
await T('media')
await pick('r_v1')
await tap('[data-aspect-chip="1"]', '比例 chip')
await shoot('11-aspect')

/* 12) 音频库 */
await T('audio')
await shoot('12-audio-lib')

/* 13) 时间线特写（把播放头拉到第一处转场） */
await T('media')
await pick('r_v1')
await page.keyboard.press('Home').catch(() => {})
await sleep(200)
for (let i = 0; i < 75; i += 1) {
  await page.keyboard.press('ArrowRight').catch(() => {})
}
await sleep(700)
await shoot('13-timeline-transition')

/* 14) 导出面板 */
await T('media')
await pick('r_v1')
if (await tap('.wb-export', '导出按钮')) {
  await shoot('14-export')
  await tap('.modal header button[aria-label="关闭"]', '关闭导出弹窗')
  await sleep(500)
}

/* 15) 回首页 —— 这次列表里已有"产品演示"草稿，比干净的首页更说明问题 */
await tap('.wb-menu-brand', '回首页')
await resize(HOME_SIZE)
await sleep(1200)
await shoot('15-home-with-draft')

console.log(`\n  页面错误数 = ${pageErrors.length}`)
pageErrors.slice(0, 12).forEach((e) => console.log('    ' + e))

console.log('\nREADME_SHOTS_DONE -> ' + OUT)

await shutdown()
process.exit(0)
