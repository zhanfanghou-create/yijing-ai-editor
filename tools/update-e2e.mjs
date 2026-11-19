/**
 * 自动更新的真机 E2E：检测 → 弹窗 → 下载 → 校验 → 交接安装。
 *
 * 为什么不用真 GitHub：依赖外网的闸门只会"时红时绿"，最后谁都不看它。
 * 这里起一个**本地 HTTP 服务**当发布源（`YJAI_UPDATE_API` 指过去），
 * 于是整条链路都能离线跑、可重复。
 *
 * 三个场景：
 *   A. 正常更新：查到 9.9.9 → 弹窗 → 下载（真实字节落盘）→ 点安装 → **应用真的退出**
 *   B. 校验不过：换个版本号再走一遍，但 SHASUMS 给错值 ⇒ 必须报错、必须不留坏文件、
 *      而且**应用不能退出**（退出了用户就没法继续用了）
 *   C. 发布源没给校验值（镜像常把 digest 抹掉）：**不阻断**更新，但界面必须照实说
 *      "没有校验值" —— 这一条防的是"界面没提 = 用户以为校验过了"。
 *
 * 判据一律取消费端：
 *   · 弹窗 DOM 上的 `data-update-version / progress / error / unverified`；
 *   · 磁盘上那个文件的**真实字节与 sha256**（不读"下载成功"这个返回值）；
 *   · 应用进程是否还活着（`electronApp.evaluate` 能不能往返）。
 *
 * 断言总数恒为 16。
 *
 * 用法：node tools/update-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const TOTAL_ASSERTIONS = 16
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    await withTimeout(app.close(), 6000, 'app.close')
    return
  } catch {
    /* 落到强杀 */
  }
  try {
    const pid = app.process()?.pid
    if (pid) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 可能已经退了 */
  }
  await sleep(300)
}

/* ------------------------------ 假发布源 ------------------------------ */

/** 用一个真 PE 当"安装包"：spawn 能成功、但它不是安装器，跑完就自己退 */
const FAKE_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe')
const PKG = fs.readFileSync(FAKE_EXE)
const PKG_SHA = crypto.createHash('sha256').update(PKG).digest('hex')
const ASSET_NAME = 'YiJingAIEditor-Setup-Windows-x64.exe'

/** 场景切换：bad=true 时 SHASUMS 给一个错的值；noSha=true 时**根本没有校验值** */
let badMode = false
let noShaMode = false
const versionOf = () => (noShaMode ? '9.9.11' : badMode ? '9.9.10' : '9.9.9')

const server = http.createServer((req, res) => {
  const url = String(req.url || '')
  if (url.includes('/releases/latest')) {
    const body = JSON.stringify({
      tag_name: `v${versionOf()}`,
      name: `艺镜剪辑 v${versionOf()}`,
      body: '- 修复了三个问题\n- 预览更跟手',
      published_at: '2026-11-15T10:00:00Z',
      assets: noShaMode
        ? [{ name: ASSET_NAME, size: PKG.length, browser_download_url: `${base}/pkg.exe` }]
        : [
            { name: `${ASSET_NAME}.blockmap`, size: 12, browser_download_url: `${base}/blockmap` },
            { name: ASSET_NAME, size: PKG.length, browser_download_url: `${base}/pkg.exe` },
            { name: 'SHASUMS256.txt', size: 80, browser_download_url: `${base}/SHASUMS256.txt` }
          ]
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)
    return
  }
  if (url.includes('/SHASUMS256.txt')) {
    if (noShaMode) {
      res.writeHead(404)
      res.end('no')
      return
    }
    /* 坏模式下给的是**别的文件**的 sha：长度合法、内容不对 */
    const sha = badMode ? crypto.createHash('sha256').update('not-the-package').digest('hex') : PKG_SHA
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`${sha}  ${ASSET_NAME}\n`)
    return
  }
  if (url.includes('/pkg.exe')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(PKG.length) })
    res.end(PKG)
    return
  }
  res.writeHead(404)
  res.end('no')
})

let base = ''
const listen = () =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      console.log(`假发布源：${base}`)
      resolve()
    })
  })

/* ------------------------------ 应用启动 ------------------------------ */

function launch(profile) {
  return electron.launch({
    executablePath: EXE,
    args: [MAIN, `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: undefined,
      /* 让检测打到本地假服务；repo 名字随便，服务端不看 */
      YJAI_UPDATE_API: base,
      YJAI_UPDATE_REPO: 'e2e/fake'
    }
  })
}

/** 点「帮助 → 关于 → 检查更新」，返回是否走到了弹窗 */
async function openCheck(page) {
  /* 首页没有顶栏菜单 —— 「帮助」在工作台里。先点首页的「创作视频」进去。 */
  if (await page.locator('.home-hero-video').count()) {
    await page.locator('.home-hero-video').click()
    await page.waitForSelector('[data-menu-trigger="help"]', { timeout: 20000 })
  }
  await page.locator('[data-menu-trigger="help"]').click()
  await sleep(200)
  await page.locator('[data-top-menu="help"]').getByText('关于', { exact: true }).click()
  await page.waitForSelector('[data-about="check-update"]', { timeout: 8000 })
  await page.locator('[data-about="check-update"]').click()
}

const WATCHDOG_MS = Number(process.env.UPDATE_E2E_TIMEOUT_MS || 5 * 60 * 1000)
const watchdog = setTimeout(() => {
  console.error(`\n[!] 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完`)
  failures.push('看门狗超时')
  fail += 1
  summary()
  process.exit(1)
}, WATCHDOG_MS)

function summary() {
  console.log(`\n自动更新 E2E：${pass}/${TOTAL_ASSERTIONS} 通过，${fail} 失败，${skip} 跳过`)
  // verify.mjs 只认这一行（具名捕获 p/f/s/t），上面的中文汇总是给人看的
  console.log(`UPDATE_E2E_STATS total=${pass + fail + skip} pass=${pass} fail=${fail} skip=${skip}`)
  if (fail) {
    console.log('失败项：')
    for (const item of failures) console.log(`  - ${item}`)
    console.log('UPDATE_E2E_FAILED')
  } else {
    console.log('UPDATE_E2E_PASSED')
  }
  return { pass, fail, skip }
}

let app = null
let profileA = ''
let profileB = ''
let profileC = ''

try {
  await listen()
  if (!fs.existsSync(FAKE_EXE)) throw new Error(`缺少夹具可执行文件：${FAKE_EXE}`)

  /* ==================== 场景 A：正常更新到 9.9.9 ==================== */

  profileA = path.join(os.tmpdir(), 'yjai-e2e', `.update-a-${process.pid}`)
  fs.mkdirSync(profileA, { recursive: true })
  app = await launch(profileA)
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await page.waitForSelector('.home', { timeout: 30000 })

  await openCheck(page)
  const dialogUp = await page.waitForSelector('[data-update-body]', { timeout: 15000 }).then(() => true).catch(() => false)
  check('1. 点「检查更新」之后弹出了新版本窗口', dialogUp, '')

  const versionText = dialogUp ? await page.locator('[data-update-version]').getAttribute('data-update-version') : ''
  check('2. 窗口里写的是「当前版本 → 9.9.9」', String(versionText).endsWith('->9.9.9'), String(versionText))

  const sizeText = dialogUp ? await page.locator('[data-update-size]').innerText() : ''
  check('3. 显示了更新包体积（不是空白）', /MB|KB/.test(sizeText), sizeText.slice(0, 40))

  await page.locator('[data-update-action="download"]').click()
  await sleep(400)
  const progressAppeared = await page
    .waitForSelector('[data-update-progress]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  check('4. 点「立即更新」之后进度条出现（不是静默下载）', progressAppeared, '')
  if (!progressAppeared) {
    /* 失败时把弹窗里的原文打出来：不然只知道"没出现进度条"，
       分不清是"下载报错了"还是"阶段没切过去" */
    const dump = await page.locator('[data-update-body]').innerText().catch(() => '')
    const err = await page
      .locator('[data-update-error]')
      .getAttribute('data-update-error')
      .catch(() => '')
    console.log(`    [诊断] err=${JSON.stringify(err)} body=${JSON.stringify(String(dump)).slice(0, 240)}`)
  }

  /* 等下载完成：按钮变成「立即重启并安装」 */
  const installReady = await page
    .waitForSelector('[data-update-action="install"]', { timeout: 60000 })
    .then(() => true)
    .catch(() => false)
  check('5. 下载完成后出现「立即重启并安装」', installReady, '')
  const pct = installReady ? await page.locator('[data-update-progress]').getAttribute('data-update-progress') : ''
  check('6. 进度走到 100（末帧一定发，否则会停在 97%）', String(pct) === '100', `pct=${pct}`)

  const pkgPath = path.join(profileA, 'updates', versionOf(), ASSET_NAME)
  await sleep(300)
  const exists = fs.existsSync(pkgPath)
  check('7. 安装包落在 userData/updates/<版本>/ 下（名字是正式的那个）', exists, pkgPath.replace(profileA, '<profile>'))
  const bytes = exists ? fs.readFileSync(pkgPath) : Buffer.alloc(0)
  check('8. 落盘字节数与发布源给出的完全一致', exists && bytes.length === PKG.length, `${bytes.length} vs ${PKG.length}`)
  const gotSha = exists ? crypto.createHash('sha256').update(bytes).digest('hex') : ''
  check('9. 落盘内容的 sha256 与发布源一致（真的把字节搬过来了）', gotSha === PKG_SHA, gotSha.slice(0, 12))

  /* 点安装：主进程 spawn 那个文件，然后退出自己 */
  await page.locator('[data-update-action="install"]').click()
  await sleep(2500)
  const aliveAfterInstall = await app
    .evaluate(({ app: a }) => Boolean(a))
    .then(() => true)
    .catch(() => false)
  check('10. 点「立即重启并安装」之后应用退出（安装器要覆盖的文件不能还被占着）', aliveAfterInstall === false, `alive=${aliveAfterInstall}`)

  await shutdown(app)
  app = null

  /* ==================== 场景 B：校验不过必须拦住 ==================== */

  badMode = true
  profileB = path.join(os.tmpdir(), 'yjai-e2e', `.update-b-${process.pid}`)
  fs.mkdirSync(profileB, { recursive: true })
  app = await launch(profileB)
  const page2 = await app.firstWindow()
  page2.setDefaultTimeout(20000)
  await page2.waitForSelector('.home', { timeout: 30000 })

  await openCheck(page2)
  const up2 = await page2.waitForSelector('[data-update-body]', { timeout: 15000 }).then(() => true).catch(() => false)
  check('11. 坏校验场景也能走到弹窗（版本 9.9.10）', up2, '')

  await page2.locator('[data-update-action="download"]').click()
  const errShown = await page2
    .waitForSelector('[data-update-error]', { timeout: 60000 })
    .then(() => true)
    .catch(() => false)
  const errText = errShown ? await page2.locator('[data-update-error]').getAttribute('data-update-error') : ''
  check('12. 校验不通过时弹窗里明写原因（不是静默失败）', errShown && /校验/.test(String(errText)), String(errText).slice(0, 40))

  const badPath = path.join(profileB, 'updates', versionOf(), ASSET_NAME)
  check('13. 校验不过的包**没有留在磁盘上**（留着下次会被当"已下载"复用）', !fs.existsSync(badPath), badPath.replace(profileB, '<profile>'))

  const aliveAfterFail = await app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    .then((n) => n > 0)
    .catch(() => false)
  check('14. 校验失败时应用**没有**退出（用户还能继续用）', aliveAfterFail, `alive=${aliveAfterFail}`)

  await shutdown(app)
  app = null

  /* ============ 场景 C：发布源没给校验值 —— 照实说，不许冒充"已校验" ============ */

  badMode = false
  noShaMode = true
  profileC = path.join(os.tmpdir(), 'yjai-e2e', `.update-c-${process.pid}`)
  fs.mkdirSync(profileC, { recursive: true })
  app = await launch(profileC)
  const page3 = await app.firstWindow()
  page3.setDefaultTimeout(20000)
  await page3.waitForSelector('.home', { timeout: 30000 })

  await openCheck(page3)
  await page3.waitForSelector('[data-update-body]', { timeout: 15000 })
  await page3.locator('[data-update-action="download"]').click()
  const ready3 = await page3
    .waitForSelector('[data-update-action="install"]', { timeout: 60000 })
    .then(() => true)
    .catch(() => false)
  check('15. 没有校验值时**不阻断**更新（镜像常把 digest 抹掉，硬拦等于没法更新）', ready3, '')
  const unverified = await page3
    .waitForSelector('[data-update-unverified]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  /* 这一条防的是"界面没提" = 用户在不知情的情况下装了未核对过的包。
     写它之前界面确实什么都没说（`download()` 的注释却写着"界面照实提示"）。 */
  check('16. 但界面必须照实说"没有提供校验值"（不冒充已校验）', unverified && ready3, `shown=${unverified}`)
} catch (e) {
  console.error(`\n[异常] ${(e && e.stack) || e}`)
  /* ⚠️ 这里必须走 check(false) 而不是只 push 一句话：只 push 的话 `fail` 仍是 0，
     后面的 backfill 全记成 SKIP，summary 就会打印 `UPDATE_E2E_PASSED` ——
     明明一条都没测，闸门却报绿灯（假绿，比红灯危险得多）。 */
  check('运行中出现异常，后续断言无法执行', false, String((e && e.message) || e).slice(0, 120))
} finally {
  clearTimeout(watchdog)
  await shutdown(app)
  server.close()
  while (emitted < TOTAL_ASSERTIONS) skipped(`第 ${emitted + 1} 项`, '前面有环节提前退出')
  const stats = summary()
  process.exitCode = stats.fail ? 1 : 0
}
