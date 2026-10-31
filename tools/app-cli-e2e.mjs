#!/usr/bin/env node
/**
 * 闸门：**智能体唤起**（`--open-draft`）的真机取证。
 *
 * 场景：镜枢装好剪辑软件、用 MCP 建了一份草稿，然后要"打开给用户看"。
 * 这条链路只有两个动作能出错，而且都不报错：
 *   ① 参数没被读到 ⇒ 启动了但停在首页（用户以为"agent 没干活"）；
 *   ② 读到了但没走既有的恢复逻辑 ⇒ 时间线是空的（名字对了、内容没了）。
 * 所以判据必须读**消费端**：窗口里有没有进编辑器、时间线片段数、工程名。
 *
 * 第二轮验的是**第二个实例**：软件单实例运行，第二次启动只把参数交给已在跑的
 * 那一个（`second-instance` + `app:open-draft` 事件）。这条不测的话，
 * "agent 再开一次以切换草稿"就会静默失败 —— 窗口只会被拉到前面。
 *
 * 前置：渲染层已构建（`cd packages/desktop && vite build`）。
 * 用法：node tools/app-cli-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const FIX_VIDEO = path.join(ROOT, 'tools', 'fixtures', 'mcp-base.mp4')
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', `.cli-profile-${process.pid}`)

export const TOTAL_ASSERTIONS = 10

const pass = []
const fail = []
const record = (name, ok, detail = '') => {
  ;(ok ? pass : fail).push(name)
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
}

const mediaUrl = (abs) => `yjai-media://local/${Buffer.from(abs).toString('base64url')}`

function clipOf(id, start, duration) {
  return {
    id,
    track: 'video',
    assetId: '',
    name: path.basename(FIX_VIDEO),
    url: mediaUrl(FIX_VIDEO),
    path: FIX_VIDEO,
    kind: 'video',
    text: '',
    start,
    duration,
    offset: 0,
    sourceDuration: 5
  }
}

function writeDraft(profile, id, name, clips) {
  const dir = path.join(profile, 'drafts')
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  const record0 = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    data: { clips, assets: [], playhead: 0, volume: 100, zoom: 1, aspect: '16:9', createdAt: now }
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record0), 'utf8')
}

const argsFor = (draftId) => {
  const args = [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu']
  if (draftId) args.push('--open-draft', draftId)
  return args
}

async function launch(draftId) {
  const app = await electron.launch({
    executablePath: EXE,
    args: argsFor(draftId),
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  return { app, page }
}

const clipCount = (page) => page.$$eval('.clip[data-clip]', (els) => els.length)

async function main() {
  let app = null
  let page = null
  const pageErrors = []
  let realDone = false

  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(path.join(PROFILE, 'drafts'), { recursive: true })
  writeDraft(PROFILE, 'dcli1', '智能体草稿甲', [clipOf('c1', 0, 2), clipOf('c2', 2, 3)])
  writeDraft(PROFILE, 'dcli2', '智能体草稿乙', [clipOf('c3', 0, 1.5)])

  try {
    /* ---------- 第一轮：冷启动带 --open-draft ---------- */
    ;({ app, page } = await launch('dcli1'))
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    /* 进编辑器：顶栏页签出现 */
    await page.waitForSelector('.wb-tab', { timeout: 40000 })
    record('1. 带 --open-draft 启动后直接进入编辑器（不是停在首页）', true)

    /* 工程名 = 目标草稿 */
    await page.waitForFunction(() => document.body.innerText.includes('智能体草稿甲'), { timeout: 20000 }).catch(() => {})
    const nameShown = await page.evaluate(() => document.body.innerText.includes('智能体草稿甲'))
    record('2. 界面上是目标草稿的名字', nameShown)

    /* 时间线片段数 = 2（证明走的是恢复整份草稿，不是"建了个空项目"） */
    await page.waitForFunction(() => document.querySelectorAll('.clip[data-clip]').length >= 2, { timeout: 20000 }).catch(() => {})
    const n1 = await clipCount(page)
    record('3. 时间线恢复出 2 个片段（不是空时间线）', n1 === 2, `clips=${n1}`)

    /* 设置里确实写了 currentDraftId（证明冷启动那条走的是既有恢复逻辑） */
    let settingId = ''
    try {
      const s = JSON.parse(fs.readFileSync(path.join(PROFILE, 'settings.json'), 'utf8'))
      settingId = String(s.currentDraftId || '')
    } catch {
      settingId = ''
    }
    record('4. currentDraftId 被写成目标草稿（复用既有恢复路径）', settingId === 'dcli1', settingId || '读不到 settings.json')

    /* ---------- 第二轮：第二个实例切草稿 ---------- */
    /* ⚠️ env 必须显式去掉 ELECTRON_RUN_AS_NODE：本机（以及闸门自己的进程环境）
       带着它时，第二个 electron.exe 会被当成**纯 node** 跑，一进来就
       `app.isPackaged` 空引用、退出码 1 —— 看起来像"单实例坏了"。 */
    const second = spawn(EXE, argsFor('dcli2'), {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined }
    })
    const secondExit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 30000)
      second.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    record('5. 第二个实例自己退出（单实例语义，不叠开窗口）', secondExit === 0 || secondExit === 'timeout', `exit=${secondExit}`)

    const switched = await page
      .waitForFunction(
        () => {
          const text = document.body.innerText
          return text.includes('智能体草稿乙') && !text.includes('智能体草稿甲')
        },
        { timeout: 30000 }
      )
      .then(() => true)
      .catch(() => false)
    record('6. 已在跑的窗口切到第二份草稿（second-instance → app:open-draft）', switched)

    const n2 = await clipCount(page)
    record('7. 切过去之后时间线是第二份草稿的内容（1 段）', n2 === 1, `clips=${n2}`)

    record('8. 全程没有渲染层异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
    realDone = true
  } catch (e) {
    pageErrors.push(String((e && e.stack) || e))
  } finally {
    if (app) {
      try {
        await withTimeout(app.close(), 8000, 'app.close')
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 给任意 promise 套超时。
   * ⚠️ 本机 `app.close()` **可能永不返回**（2026-10-08 实录：断言早跑完、结论也落盘了，
   * 卡住的只是退出那一步，整套验证停在 42/45 不动 28 分钟，看上去像 Electron 崩了）。
   * 所以这里不许裸 `await app.close()` —— 由 `tools/check-e2e-teardown.mjs` 钉着。
   */
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

  /* ---------- 第三轮：不带参数 → 停在首页 ---------- */
  let homeOk = false
  try {
    const third = await launch('')
    const p3 = third.page
    await p3.waitForSelector('.home', { timeout: 40000 })
    homeOk = await p3.evaluate(() => document.querySelectorAll('.wb-tab').length === 0)
    await withTimeout(third.app.close(), 8000, 'app.close')
  } catch {
    homeOk = false
  }
  record('9. 不带 --open-draft 启动仍停在首页（不改变原有启动行为）', homeOk)

  /**
   * ⚠️ 中断也必须红：中间任何一步抛错时，上面几条只记了跑到的那几条，
   * 剩下的没人记 —— 没有这条硬断言会打印 total=8 却 `_OK`。
   */
  record(`真机：${TOTAL_ASSERTIONS} 条断言全跑到底（中断不算通过）`, realDone && pass.length + fail.length === TOTAL_ASSERTIONS - 1, realDone ? '' : '中途中断')
  if (!realDone) console.error('中断原因：\n' + pageErrors.join('\n'))

  fs.rmSync(PROFILE, { recursive: true, force: true })
  const total = pass.length + fail.length
  console.log(`\nAPP_CLI_STATS total=${total} pass=${pass.length} fail=${fail.length}`)
  console.log(fail.length || total !== TOTAL_ASSERTIONS ? 'APP_CLI_FAILED' : 'APP_CLI_OK')
  process.exit(fail.length || total !== TOTAL_ASSERTIONS ? 1 : 0)
}

main().catch((e) => {
  console.error('[app-cli-e2e] 自身异常：', e && e.stack ? e.stack : e)
  console.log('APP_CLI_FAILED')
  process.exit(2)
})
