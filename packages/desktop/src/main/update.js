'use strict'

/**
 * 自动更新：检测 → 下载 → 交接给安装器。
 *
 * 三段的分工刻意分开，因为它们的失败方式完全不同：
 *   ① 检测只读一份 JSON，失败一律按「这次没查到」处理（**绝不打扰用户**）；
 *   ② 下载复用 `models.fetchFile`（全项目唯一那份下载器：续传 / 换源 / 代理 /
 *      分段并发 / 停滞看门狗都在里面）。这里自己写 req/res 拼文件，就等于给
 *      "下载"再造第二套语义，代理不通时表现还不一样；
 *   ③ 交接是整个流程里唯一真正危险的一步 —— 拉起安装器、然后把自己关掉。
 *      见 `handoff()` 里那三条硬规矩。
 *
 * 为什么不用 electron-updater：它要求打包成 NSIS 并自带一套 feed 约定，
 * 而本项目的安装器是**自己写的 Electron 应用**（带图形安装界面 + 静默安装参数），
 * 覆盖安装的路径已经存在，直接用即可。引一个几百 KB 的依赖只为了"比较版本号 + 下载"，
 * 换不来任何东西。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const { fetchFile } = require('./models')
const rules = require('../shared/updateRules.js')

/**
 * 发布源。`YJAI_UPDATE_API` / `YJAI_UPDATE_REPO` 只给闸门用：
 * `tools/update-e2e.mjs` 会起一个本地 HTTP 服务返回伪造的 release，
 * 这样"检测到新版本 → 弹窗 → 下载 → 交接"整条链路都能离线跑，
 * 不受 GitHub 可达性影响（依赖外网的闸门只会时红时绿，最后谁都不看）。
 */
const API_BASE = String(process.env.YJAI_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '')
const REPO = String(process.env.YJAI_UPDATE_REPO || 'zhanfanghou-create/yijing-ai-editor')

/** GitHub 强制要求 User-Agent（不带直接 403），而且它明确建议带版本号 */
const UA = 'YiJingAIEditor-Updater'

/** 这一轮真正下载完成、允许交给安装器的那个文件（其余路径一律拒绝） */
let lastDownloaded = ''

/** 更新包放在 userData 下：留在本机，用户自己也能找到 */
function updatesRoot(userData) {
  return path.join(String(userData || os.tmpdir()), 'updates')
}

/**
 * 取一个 JSON。超时与网络错都收敛成 `{ ok:false }` —— 检测失败是**正常情况**
 * （断网、公司代理、GitHub 被拦），不能让它变成一句报错弹窗。
 */
async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** 纯文本（SHASUMS256.txt） */
async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } })
    if (!res.ok) return ''
    return await res.text()
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查最新版本。
 *
 * 返回结构固定带 `ok`，界面据此决定要不要弹窗：
 *   `{ok:false, reason}` → 什么都不做；
 *   `{ok:true, newer:false}` → 已是最新；
 *   `{ok:true, newer:true, version, notes, asset}` → 弹窗。
 */
async function check({ currentVersion }) {
  const res = await fetchJson(`${API_BASE}/repos/${REPO}/releases/latest`)
  if (!res.ok) return { ok: false, reason: res.reason, current: String(currentVersion || '') }
  const info = rules.describeRelease(res.data, currentVersion)
  if (!info.ok) return { ok: false, reason: info.reason, current: String(currentVersion || '') }
  return {
    ok: true,
    current: String(currentVersion || ''),
    newer: info.newer,
    version: info.version,
    tag: info.tag,
    notes: info.notes,
    publishedAt: info.publishedAt,
    asset: info.asset,
    shasumUrl: info.shasumUrl
  }
}

/** 流式算 sha256（180MB 不能整块进内存） */
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 下载安装包并校验。
 *
 * 校验口径：优先用 Release 附带的 `SHASUMS256.txt`（人可核对、也覆盖"多个资产"），
 * 没有就用 asset 自带的 `digest`；两者都没有时**不阻断**（GFW 下的镜像常把这两个
 * 字段抹掉），但会在返回值里明写 `verified:false`，界面照实提示。
 *
 * @returns {Promise<{ok:boolean, path?:string, verified?:boolean, error?:string}>}
 */
async function download({ asset, shasumUrl, version, userData, onProgress, proxy }) {
  if (!asset || !asset.url) return { ok: false, error: '没有可用的安装包地址' }
  const dir = path.join(updatesRoot(userData), String(version || 'unknown'))
  const dest = path.join(dir, rules.SETUP_ASSET)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `无法创建更新目录：${e.message}` }
  }

  /* 期望的 sha256：先算出来，再决定"已下载的这份能不能直接复用" */
  let expected = String(asset.sha256 || '')
  if (!expected && shasumUrl) {
    const text = await fetchText(shasumUrl)
    expected = rules.readShasum(text, rules.SETUP_ASSET)
  }

  /* 幂等：上次下到一半就退出了，或用户点了两次。文件在且 sha 对得上就不再下 */
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    if (expected) {
      const got = await sha256Of(dest).catch(() => '')
      if (got && got === expected) {
        lastDownloaded = dest
        return { ok: true, path: dest, verified: true, reused: true }
      }
    } else if (Number(asset.size) > 0 && fs.statSync(dest).size === Number(asset.size)) {
      lastDownloaded = dest
      return { ok: true, path: dest, verified: false, reused: true }
    }
  }

  try {
    await fetchFile([asset.url], dest, onProgress, { proxy, expectBytes: Number(asset.size) || 0 })
  } catch (e) {
    return { ok: false, error: String((e && e.message) || '下载失败') }
  }

  if (expected) {
    const got = await sha256Of(dest).catch(() => '')
    if (!got || got !== expected) {
      /* 校验不过必须删掉：留着的话下次会走"复用"分支把坏包装上去 */
      try {
        fs.rmSync(dest, { force: true })
      } catch {
        /* 删不掉也只能报错，别再往下走 */
      }
      return { ok: false, error: '安装包校验不通过（可能下载被中断或缓存被改过）' }
    }
  }
  lastDownloaded = dest
  return { ok: true, path: dest, verified: Boolean(expected) }
}

/** 规范化路径比较（8.3 短路径 vs 长路径是真实存在的差异，别用字符串硬比） */
function canon(target) {
  try {
    return fs.realpathSync.native(target).toLowerCase()
  } catch {
    return path.resolve(String(target || '')).toLowerCase()
  }
}

/**
 * 把安装包交给安装器，然后退出自己。
 *
 * 三条硬规矩（每条都对应一次真实的翻车）：
 *  ① **只允许本次下载的那个文件**：否则这个 IPC 就等于"渲染层可以启动任意 exe"；
 *  ② spawn 失败只走 `error` 事件 —— 不等它确认就退应用，用户看到的是
 *     "软件自己关了、什么都没发生"，和"安装器没弹窗"一模一样，无法区分；
 *  ③ 子进程环境必须**剔掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`**：
 *     本机实测过一次 —— 带着 `ELECTRON_RUN_AS_NODE=1` 启动安装器时，
 *     安装器退化成纯 Node，`require('electron')` 变成字符串，主进程一行都跑不到，
 *     现象是"带任何参数都退出码 9"。真实用户机器上不会有，但开发机与
 *     从其它 Electron 宿主里拉起时会有，代价只有两行过滤。
 *
 * @param {object} opts
 * @param {string} opts.installerPath 下载好的安装器 exe
 * @param {string} opts.installDir 当前 exe 所在目录（覆盖安装的目标）
 * @param {(reason:string)=>void} [opts.onQuit] 确认起得来之后调用（主进程在这里退出）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function handoff({ installerPath, installDir, onQuit }) {
  const resolved = String(installerPath || '')
  if (!resolved || !fs.existsSync(resolved)) return { ok: false, error: '更新包不存在' }
  if (!lastDownloaded || canon(resolved) !== canon(lastDownloaded)) {
    return { ok: false, error: '更新包路径不合法（只允许启动本次下载的那个文件）' }
  }

  const resultFile = path.join(os.tmpdir(), 'yijing-update-result.json')
  try {
    fs.rmSync(resultFile, { force: true })
  } catch {
    /* 删不掉不影响（安装器会覆盖写） */
  }
  const plan = rules.installerHandoff({ installDir, resultFile })

  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'NODE_OPTIONS') continue
    env[k] = v
  }
  Object.assign(env, plan.env)

  let proc
  try {
    proc = spawn(resolved, plan.args, { detached: true, stdio: 'ignore', windowsHide: false, env })
  } catch (e) {
    return { ok: false, error: `无法启动安装程序：${e.message}` }
  }

  const launched = await new Promise((resolve) => {
    let settled = false
    const finish = (value, why) => {
      if (settled) return
      settled = true
      resolve({ value, why })
    }
    proc.once('spawn', () => finish(true))
    proc.once('error', (e) => finish(false, String((e && e.message) || e)))
    /* 'spawn' 正常几十毫秒就到；超时按成功算（进程已创建，只是事件晚了） */
    setTimeout(() => finish(true), 5000)
  })

  if (!launched.value) return { ok: false, error: `无法启动安装程序：${launched.why || '未知原因'}` }
  proc.unref()
  if (typeof onQuit === 'function') setTimeout(() => onQuit(resultFile), 600)
  return { ok: true, resultFile }
}

/** 这一轮之后不再允许启动别的 exe（供退出前清理） */
function forgetDownloaded() {
  lastDownloaded = ''
}

module.exports = {
  updatesRoot,
  check,
  download,
  handoff,
  forgetDownloaded,
  /* 闸门用：直接拿到"当前允许的路径"，断言交接白名单真的生效 */
  _lastDownloaded: () => lastDownloaded
}
