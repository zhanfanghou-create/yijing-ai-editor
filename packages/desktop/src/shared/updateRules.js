/**
 * 自动更新的**规则层**：版本比较、安装包挑选、安装器交接参数。
 *
 * 纯函数，不碰 electron / 不碰网络 / 不碰磁盘 —— 这样界面、主进程、闸门三方
 * 可以各自引用同一份判断，不会出现「窗口说 1.1.3 是最新、主进程算出来不是」。
 *
 * 为什么不在主进程里直接写：版本比较与"挑哪个资产"是最容易悄悄出错的两件事
 * （`1.10.0` 用字符串比会小于 `1.9.0`；资产名多一个 `-arm64` 就挑错了包），
 * 抽出来后 `tools/check-update-rules.mjs` 能把每条规则单独钉死。
 */

/** 正式安装包在 Release 里的文件名（与 packages/installer 的 artifactName 对应） */
const SETUP_ASSET = 'YiJingAIEditor-Setup-Windows-x64.exe'

/**
 * 解析版本号。容忍前缀 `v`、前后空白、以及 `1.2.3-beta.1` 这类后缀（只取主三段）。
 * 解析不出来返回 null —— 调用方一律按"没有新版本"处理，绝不猜。
 */
function parseVersion(text) {
  const m = String(text == null ? '' : text)
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: String(text).trim() }
}

/**
 * 比较两个版本号：a 比 b 新返回 1，相同返回 0，更旧返回 -1。
 * 任一边解析不出来时返回 0（不可比 = 当作相同，不提示更新）。
 */
function compareVersions(a, b) {
  const left = typeof a === 'object' && a ? a : parseVersion(a)
  const right = typeof b === 'object' && b ? b : parseVersion(b)
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] > right[key]) return 1
    if (left[key] < right[key]) return -1
  }
  return 0
}

/** 远端版本是否比当前版本新（**严格大于**：同版本不提示，避免反复骚扰） */
function isNewer(latest, current) {
  /* ⚠️ `latest` 允许已经是解析结果：`describeRelease()` 手里就是对象，
     再喂给 parseVersion 会被 `String(obj)` 变成 `[object Object]` ⇒ 返回 null
     ⇒ 永远判成"不是新版本"，表现是**新版本永远不提示**（2026-11-15 由本文件的
     自证抓到：那一条断言写的是"摘要里 newer=true"）。 */
  const l = typeof latest === 'object' && latest ? latest : parseVersion(latest)
  if (!l) return false
  return compareVersions(l, parseVersion(current)) > 0
}

/** `sha256:abcdef…` → `abcdef…`；不是 sha256 的返回空串 */
function readDigest(digest) {
  const m = String(digest == null ? '' : digest).trim().match(/^sha256:([a-f0-9]{64})$/i)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 从 SHASUMS256.txt 里取指定文件名的 sha256（`<sha>  <name>` 每行一条）。
 * 找不到返回空串。
 */
function readShasum(text, name) {
  const want = String(name || '').trim().toLowerCase()
  if (!want) return ''
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (!m) continue
    /* 有的工具会写成 `./dist/xxx.exe`，只比文件名 */
    const file = m[2].trim().split(/[\\/]/).pop().toLowerCase()
    if (file === want) return m[1].toLowerCase()
  }
  return ''
}

/**
 * 从 Release 里挑出本机该装的那个包。
 *
 * 只认**完全同名**的资产：名字里多出 `-arm64` / `-ia32` / `.blockmap` 的一律不选 ——
 * 模糊匹配（`includes('.exe')`）在提交了多个架构时会稳定挑错，而挑错的后果是
 * "下载完装上了另一个架构的包"，用户看到的是软件打不开。
 *
 * @param {object} release GitHub `releases/latest` 的 JSON
 * @returns {{name:string, url:string, size:number, sha256:string}|null}
 */
function pickAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : []
  const hit = assets.find((a) => a && a.name === SETUP_ASSET)
  if (!hit || !hit.browser_download_url) return null
  return {
    name: hit.name,
    url: String(hit.browser_download_url),
    size: Number(hit.size) || 0,
    /* 新版 GitHub API 会带 digest；老接口没有就是空串，由 SHASUMS256.txt 兜底 */
    sha256: readDigest(hit.digest)
  }
}

/** Release 里附带的校验文件（有就用它，比单个 asset 的 digest 更可信） */
function findShasumAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : []
  const hit = assets.find((a) => a && /^shasums256\.txt$/i.test(String(a.name || '')))
  return hit && hit.browser_download_url ? String(hit.browser_download_url) : ''
}

/**
 * 把版本与资产整理成界面能直接用的形状。
 * `notes` 只取正文，长度由界面自己截（这里不做截断 —— 截断规则属于展示层）。
 */
function describeRelease(release, currentVersion) {
  if (!release || typeof release !== 'object') return { ok: false, reason: 'no-release' }
  const tag = release.tag_name || release.name || ''
  const version = parseVersion(tag)
  if (!version) return { ok: false, reason: 'bad-version' }
  const asset = pickAsset(release)
  if (!asset) return { ok: false, reason: 'no-asset', version: version.raw }
  return {
    ok: true,
    version: `${version.major}.${version.minor}.${version.patch}`,
    tag: String(tag),
    newer: isNewer(version, currentVersion),
    notes: String(release.body || ''),
    publishedAt: String(release.published_at || ''),
    asset,
    shasumUrl: findShasumAsset(release)
  }
}

/**
 * 交给安装器的**两条通道**（同时给，谁通走谁）。
 *
 * 为什么两条都给：
 *   · 命令行：portable 启动器用 `${StdUtils.GetAllParameters}` + `ExecWait` 透传，
 *     实测可行（2026-11-15 装到临时目录 11.9 秒、结果 ok=true）；
 *   · 环境变量：`ExecWait` 必然继承环境，不依赖 NSIS 插件行为，是更稳的兜底。
 *     安装器 `silent.js` 的 `applyEnv()` 认这套名字，命令行优先。
 *
 * ⚠️ 不传 `--install-dir` 之外的任何目录参数（`/D=` 是 NSIS 的、`--install-dir`
 *   才是本安装器认的）。目录必须是**当前 exe 所在目录**，否则会装成第二份。
 */
function installerHandoff({ installDir, resultFile }) {
  const dir = String(installDir || '').trim()
  const result = String(resultFile || '').trim()
  const args = ['--silent', '--no-shortcuts', '--launch']
  if (dir) args.push('--install-dir', dir)
  if (result) args.push('--result', result)
  const env = { YJAI_SETUP_SILENT: '1', YJAI_SETUP_LAUNCH: '1', YJAI_SETUP_NO_SHORTCUTS: '1' }
  if (dir) env.YJAI_SETUP_INSTALL_DIR = dir
  if (result) env.YJAI_SETUP_RESULT = result
  return { args, env }
}

/** 体积显示（与设置页脚同一口径：1024 进制、一位小数） */
function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

module.exports = {
  SETUP_ASSET,
  parseVersion,
  compareVersions,
  isNewer,
  readDigest,
  readShasum,
  pickAsset,
  findShasumAsset,
  describeRelease,
  installerHandoff,
  formatSize
}
