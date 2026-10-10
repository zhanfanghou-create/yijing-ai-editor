/**
 * 安装器界面取景脚本（开发自检用，不参与打包）。
 *
 * 分两个阶段，目的都是「拿到与参考截图可逐像素比对的画面」，且**绝不真的安装到磁盘**：
 *   A. Electron 阶段  —— 真实外壳 + 真实 preload，取 收起 / 展开 / 协议浮层 / 未勾选 四种状态
 *   B. Chromium 阶段  —— 直接加载已构建的渲染层并用桩替换 window.installer，
 *                        取 安装中 / 完成 / 失败 三种状态（这些状态在真机上都带副作用）
 *
 * 用法：node tools/installer-shoot.mjs
 */

import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '_recon', 'ours')
// 用测试外壳而不是 electron/main.js：真机 getMeta 会调用 reg.exe，
// 在本机被安全策略拦截且会终止整个进程（详见 tools/installer-shell-harness.cjs 顶部说明）。
const MAIN = path.join(ROOT, 'tools', 'installer-shell-harness.cjs')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

fs.mkdirSync(OUT, { recursive: true })

const rows = []
const log = (...a) => console.log(...a)

async function geom(page) {
  const map = {
    brandLogo: '.brand-logo',
    brandName: '.brand-name',
    winMin: '.win-btn.min',
    winClose: '.win-btn.close',
    appIcon: '.app-icon',
    appTitle: '.app-title',
    btn: '.btn-primary',
    checkbox: '.checkbox',
    agreeText: '.agree-text',
    settingsBtn: '.agree-right button',
    settings: '.settings',
    langLabel: '.settings-label.lang',
    select: '.field-wrap.select select',
    pathLabel: '.settings-label.path',
    input: '.field-wrap.path input',
    browse: '.browse-btn',
    progress: '.progress',
    stageText: '.stage-text',
    appSub: '.app-sub'
  }
  const out = {}
  for (const [k, s] of Object.entries(map)) {
    // eslint-disable-next-line no-await-in-loop
    out[k] = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        x: +r.x.toFixed(1),
        y: +r.y.toFixed(1),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        bg: cs.backgroundColor,
        color: cs.color,
        border: cs.borderTopColor,
        font: cs.fontSize,
        text: (el.textContent || '').trim().slice(0, 40)
      }
    }, s)
  }
  return out
}

function printGeom(title, g) {
  log(`  ${title}`)
  for (const [k, v] of Object.entries(g)) {
    if (!v) continue
    log(
      `    ${k.padEnd(12)} x=${String(v.x).padStart(5)} y=${String(v.y).padStart(5)} ` +
        `${String(v.w).padStart(5)}x${String(v.h).padStart(4)} bg=${v.bg.padEnd(22)} fg=${v.color.padEnd(20)} ` +
        `bd=${v.border.padEnd(22)} fs=${v.font}${v.text ? '  «' + v.text + '»' : ''}`
    )
  }
}

/**
 * 收尾：先礼后兵。
 *
 * ⚠️ 裸 `await app.close()` 在这个环境会**永不返回**（实测把一整套一键验证拖死
 *    28 分钟，而结论其实早就打印完了）。8 秒内正常关，超时就 taskkill 强杀。
 *    同一套兜底见 draft-e2e / timeline-play / check-preview-aspect。
 */
async function closeApp(app) {
  if (!app) return
  let timer = null
  try {
    await Promise.race([
      app.close().catch(() => {}).finally(() => timer && clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('app.close 超时')), 8000)
      })
    ])
    return
  } catch {
    /* 落到强杀 */
  }
  const pid = app.process()?.pid
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 已经退了就算了 */
  }
}

async function shoot(page, name, expectedH) {
  const p = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: p })
  const vp = await page.evaluate(() => [window.innerWidth, window.innerHeight])
  const flag = expectedH && vp[1] !== expectedH ? `  <<< 期望高度 ${expectedH}，实际 ${vp[1]}` : ''
  log(`  [shot] ${name}.png  viewport=${vp[0]}x${vp[1]}${flag}`)
  rows.push({ name, vp })
}

// ===================================================================== A. Electron
async function phaseA() {
  log('')
  log('=========== A. Electron 真机外壳 ===========')
  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({
    executablePath: EXE,
    args: [
      MAIN,
      `--user-data-dir=${path.join(os.tmpdir(), 'yjai-e2e', '.electron-profile')}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ],
    cwd: ROOT,
    env
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('[console.error] ' + m.text())
  })

  await page.waitForSelector('.btn-primary', { timeout: 20000 })
  await page.waitForTimeout(700)

  // 1. 收起态
  log('-- 1. 收起态（期望 650x360）--')
  await shoot(page, '01-collapsed', 360)
  printGeom('收起态几何', await geom(page))

  // 2. 展开「安装设置」
  log('-- 2. 展开安装设置（期望 650x560）--')
  await page.click('.agree-right button')
  await page.waitForTimeout(800)
  await shoot(page, '02-expanded', 560)
  printGeom('展开态几何', await geom(page))

  // 3. 收起
  log('-- 3. 再次点击回到收起态 --')
  await page.click('.agree-right button')
  await page.waitForTimeout(800)
  await shoot(page, '03-collapsed-again', 360)

  // 4. 协议浮层
  log('-- 4. 协议全文浮层 --')
  await page.click('.agree-text button.link')
  await page.waitForTimeout(500)
  await shoot(page, '04-license')
  await page.click('.dialog-foot .dialog-btn')
  await page.waitForTimeout(300)

  // 5. 未勾选协议直接点安装
  log('-- 5. 未勾选协议点「安装」--')
  await page.click('.checkbox')
  await page.waitForTimeout(150)
  await page.click('.btn-primary')
  await page.waitForTimeout(400)
  const idle = await page.evaluate(() => !!document.querySelector('.checkbox'))
  log(`  仍在首屏（未触发安装）=${idle}`)
  await shoot(page, '05-need-agree')

  // 6. 真机外壳里跑一遍（外壳的安装是桩实现，只发进度、不落盘）
  log('-- 6. 勾选后开始安装（真机外壳 + 桩进度）--')
  await page.click('.checkbox')
  await page.waitForTimeout(150)
  await page.click('.btn-primary')
  await page.waitForTimeout(900)
  await shoot(page, '06-live-installing')
  printGeom('安装中几何', await geom(page))

  log('-- 7. 等待安装完成 --')
  await page.waitForSelector('.app-sub', { timeout: 15000 })
  await page.waitForTimeout(400)
  await shoot(page, '07-live-done')
  printGeom('完成态几何', await geom(page))

  log(`  页面错误数 = ${errors.length}`)
  errors.forEach((e) => log('    ' + e))

  await closeApp(app)
  return errors.length
}

// ===================================================================== B. 状态取景
/**
 * 只补一个「安装失败」状态：安装中 / 完成已在阶段 A 的真机外壳里跑到过，
 * 失败态需要 HARNESS_MODE 才能触发，所以单独起一次。
 */
async function phaseB() {
  log('')
  log('=========== B. 安装失败状态 ===========')
  const errors = []
  const mode = 'error'
  const env = { ...process.env, NODE_ENV: 'production', HARNESS_MODE: mode }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: EXE,
    args: [
      MAIN,
      `--user-data-dir=${path.join(os.tmpdir(), 'yjai-e2e', '.electron-profile-' + mode)}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ],
    cwd: ROOT,
    env
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(`[${mode}][pageerror] ` + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${mode}][console.error] ` + m.text())
  })
  await page.waitForSelector('.btn-primary', { timeout: 20000 })
  await page.waitForTimeout(500)
  await page.click('.btn-primary')
  await page.waitForTimeout(900)
  await shoot(page, '08-error')
  printGeom('失败态几何', await geom(page))
  await closeApp(app)
  return errors.length
}

// ===================================================================== 主流程
let bad = 0
const errA = await phaseA()
const errB = await phaseB()
bad = errA + errB

log('')
log('=========== 汇总 ===========')
for (const r of rows) log(`  ${r.name.padEnd(20)} ${r.vp[0]}x${r.vp[1]}`)
log(`  页面/控制台错误总数 = ${bad}`)
log('SHOOT_DONE 输出：' + OUT)
process.exit(0)
