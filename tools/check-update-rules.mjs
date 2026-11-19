#!/usr/bin/env node
/**
 * 自证：自动更新的**规则层**（`shared/updateRules.js`）。
 *
 * 为什么这些规则值得单独钉死：
 *   · 版本比较最容易悄悄错 —— `'1.10.0' < '1.9.0'` 在字符串比较下成立，
 *     而它不会让构建变红，只会让"新版本永远不提示"或者"每次都提示"；
 *   · 挑安装包更容易错 —— Release 里同时有 `.exe`、`.exe.blockmap`、`-arm64.exe`
 *     时，`includes('.exe')` 会稳定挑到错的那个，后果是装上一个架构不对的包；
 *   · 交接参数错了则是**静默失败**的典型：安装器起来了但当成图形安装，
 *     用户看到的是"软件关了、什么都没发生"。
 *
 * 用法：node tools/check-update-rules.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)
const rules = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'updateRules.js'))

export const TOTAL_ASSERTIONS = 21

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
}

/* ---------------------------- 版本号解析与比较 ---------------------------- */

const v1 = rules.parseVersion('v1.2.3')
check('1. 解析 `v1.2.3`（前缀 v 可以带）', v1 && v1.major === 1 && v1.minor === 2 && v1.patch === 3)

check(
  '2. 后缀不影响主三段（`1.2.3-beta.1` → 1.2.3）',
  rules.parseVersion('1.2.3-beta.1')?.patch === 3
)

check('3. 两段式版本号解析不出来（返回 null，不猜）', rules.parseVersion('1.2') === null)

/* ⚠️ 这一条是本文件的**核心**：数值比较与字符串比较在这里结论相反 */
check(
  '4. `1.10.0` 比 `1.9.0` 新（字符串比较会说"更旧"）',
  rules.compareVersions('1.10.0', '1.9.0') === 1 && '1.10.0' < '1.9.0' === true
)

check('5. 同版本返回 0', rules.compareVersions('1.1.3', 'v1.1.3') === 0)

check('6. 补丁位比较：`1.1.10` > `1.1.9`', rules.compareVersions('1.1.10', '1.1.9') === 1)

check('7. 同版本**不算**新版本（否则每次启动都弹窗）', rules.isNewer('1.1.3', '1.1.3') === false)

check('8. 旧版本不算新（`1.1.2` 对 `1.1.3` 是 old）', rules.isNewer('1.1.2', '1.1.3') === false)

check('9. 解析不出来的远端版本一律不提示', rules.isNewer('latest', '1.1.3') === false)

/* -------------------------------- 校验和 -------------------------------- */

const SHA = 'a'.repeat(64)
check('10. `sha256:…` 前缀被剥掉', rules.readDigest(`sha256:${SHA}`) === SHA)
check('11. 非 sha256 的 digest 返回空串（不硬塞进去当校验值）', rules.readDigest('md5:deadbeef') === '')

const shasums = [`${'b'.repeat(64)}  other.exe`, `${SHA} *./dist/YiJingAIEditor-Setup-Windows-x64.exe`].join('\n')
check(
  '12. SHASUMS256 按文件名取（容忍 `*` 与 `./dist/` 前缀）',
  rules.readShasum(shasums, 'YiJingAIEditor-Setup-Windows-x64.exe') === SHA
)
check('13. 文件不在校验表里返回空串', rules.readShasum(shasums, 'nope.exe') === '')

/* -------------------------------- 资产挑选 -------------------------------- */

const release = {
  tag_name: 'v1.2.0',
  body: '- 修了一堆东西',
  published_at: '2026-11-15T10:00:00Z',
  assets: [
    { name: 'YiJingAIEditor-Setup-Windows-x64.exe.blockmap', size: 100, browser_download_url: 'https://x/blockmap' },
    { name: 'YiJingAIEditor-Setup-Windows-arm64.exe', size: 200, browser_download_url: 'https://x/arm64' },
    { name: 'YiJingAIEditor-Setup-Windows-x64.exe', size: 189000000, browser_download_url: 'https://x/x64', digest: `sha256:${SHA}` },
    { name: 'SHASUMS256.txt', size: 300, browser_download_url: 'https://x/shasums' }
  ]
}

const picked = rules.pickAsset(release)
check(
  '14. 资产**只认完全同名**（不选 arm64、不选 .blockmap）',
  picked && picked.name === 'YiJingAIEditor-Setup-Windows-x64.exe' && picked.url === 'https://x/x64',
  picked ? picked.name : 'null'
)
check('15. 资产自带 digest 被翻译成 sha256', picked && picked.sha256 === SHA)
check('16. 找到 SHASUMS256.txt 的地址', rules.findShasumAsset(release) === 'https://x/shasums')

const info = rules.describeRelease(release, '1.1.3')
check(
  '17. 摘要里带新版号 + newer=true + 正文原样带出',
  info.ok && info.version === '1.2.0' && info.newer === true && info.notes.includes('修了一堆')
)

check(
  '18. 没有正式安装包的 release 判为 no-asset（不假装能更新）',
  rules.describeRelease({ tag_name: 'v9.9.9', assets: [{ name: 'foo.zip' }] }, '1.1.3').reason === 'no-asset'
)

/* ------------------------------ 安装器交接 ------------------------------ */

const plan = rules.installerHandoff({ installDir: 'D:\\Soft\\YiJingAIEditor', resultFile: 'C:\\Temp\\r.json' })
check(
  '19. 参数里有 --silent / --launch / --install-dir / --result（安装器只认这几个）',
  plan.args.includes('--silent') &&
    plan.args.includes('--launch') &&
    plan.args.join(' ').includes('--install-dir D:\\Soft\\YiJingAIEditor') &&
    plan.args.join(' ').includes('--result C:\\Temp\\r.json'),
  plan.args.join(' ')
)
check(
  '20. 同一份信息也走环境变量（命令行透传是 NSIS 插件行为，环境变量一定继承）',
  plan.env.YJAI_SETUP_SILENT === '1' &&
    plan.env.YJAI_SETUP_INSTALL_DIR === 'D:\\Soft\\YiJingAIEditor' &&
    plan.env.YJAI_SETUP_RESULT === 'C:\\Temp\\r.json'
)

/* -------------------------------- 体积格式化 -------------------------------- */

check(
  '21. 体积按 1024 进制一位小数（与设置页同一口径）',
  rules.formatSize(189000000) === '180.2 MB' && rules.formatSize(0) === '—' && rules.formatSize(2048) === '2 KB'
)

// 汇总行格式与其它闸门对齐（具名捕获 p/f/s/t），verify.mjs 只认这一行
console.log(`\nUPDATE_RULES_STATS total=${pass + fail} pass=${pass} fail=${fail} skip=0`)
console.log(fail ? 'UPDATE_RULES_FAILED' : 'UPDATE_RULES_OK')
process.exitCode = fail ? 1 : 0
