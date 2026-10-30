#!/usr/bin/env node
/**
 * 闸门：exe / 任务栏 / 托盘 三处的图标接线必须成链，且 AppID 三方一致。
 *
 * 治的是一类**只在打包后才出现、开发模式永远看不到**的缺陷：
 *
 *   · exe 与快捷方式的图标由 electron-builder 写进 exe 资源（`build/icon.ico`），
 *     快捷方式那边更是 `icon: exe, iconIndex: 0` —— 即桌面图标完全跟随 exe，
 *     这条链上没有任何代码可改，只能靠"两边是同一份文件"来保证。
 *   · 任务栏与通知区则要 Windows 的 AppUserModelID。**不设它不报错**：开发模式
 *     跑的是 electron.exe，任务栏永远是 Electron 默认图标；打包后没有 AppID 时
 *     通知区会显示空白方块 +「electron.app.Electron」。
 *   · 托盘（右下角通知区）要读真文件。`build/` 不在 electron-builder 的 files
 *     白名单里时，开发模式一切正常、装出来托盘是空白 —— 这个差别在开发模式
 *     里**永远测不到**，所以只能静态钉住。
 *
 * 校验方式：读三份真源做交叉比对（不是查"写了没写"），任一处对不上就红。
 *
 * 用法：node tools/check-app-icon-wiring.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const BUILDER = path.join(ROOT, 'packages', 'desktop', 'electron-builder.yml')
const PRODUCT = path.join(ROOT, 'packages', 'installer', 'electron', 'product.js')
const ICON = path.join(ROOT, 'packages', 'desktop', 'build', 'icon.ico')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail) console.log(`      ${detail}`)
}

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)

const mainSrc = read(MAIN)
const builderSrc = read(BUILDER)
const productSrc = read(PRODUCT)

if (!mainSrc || !builderSrc || !productSrc) {
  console.error('APP_ICON_WIRING_FAILED  关键文件缺失，无法校验')
  process.exitCode = 1
  process.exit()
}

/* 1. 主进程必须真的调用 setAppUserModelId */
const appel = mainSrc.match(/app\.setAppUserModelId\(\s*'([^']+)'\s*\)/)
record(
  '主进程设置了 AppUserModelID',
  Boolean(appel),
  '缺 `app.setAppUserModelId(...)`：任务栏/通知区不会认这个图标（开发模式必现，打包后概率出现）'
)
const appIdInCode = appel ? appel[1] : ''

/* 2. 与 electron-builder 的 appId 一字不差 */
const ymlMatch = builderSrc.match(/^appId:\s*(\S+)\s*$/m)
const appIdInYml = ymlMatch ? ymlMatch[1] : ''
record(
  'AppUserModelID 与 electron-builder.yml 的 appId 一致',
  Boolean(appIdInCode) && appIdInCode === appIdInYml,
  `主进程「${appIdInCode || '缺失'}」 vs 打包配置「${appIdInYml || '缺失'}」——不一致时任务栏会把本程序归到别的组`
)

/* 3. 与安装器 product.js 的 APP_ID 一致（安装器写进快捷方式的 appUserModelId 用的是它） */
const prodMatch = productSrc.match(/const APP_ID = '([^']+)'/)
const appIdInProduct = prodMatch ? prodMatch[1] : ''
record(
  'AppUserModelID 与安装器 APP_ID 一致',
  Boolean(appIdInCode) && appIdInCode === appIdInProduct,
  `主进程「${appIdInCode || '缺失'}」 vs 安装器「${appIdInProduct || '缺失'}」——不一致时快捷方式与运行中的窗口会被 Windows 当成两个程序`
)

/* 4. 必须在 whenReady 之前调用（Electron 官方要求；放到 ready 之后可能不生效） */
// ⚠️ 必须匹配**真实调用** `app.whenReady().then(` —— 本文件里 "app.whenReady()"
// 在注释中反复出现（"必须在 app.whenReady() 之前调用"），用 indexOf 会取到注释那一处，
// 于是位置比较恒为假红。
const readyAt = mainSrc.indexOf('app.whenReady().then(')
const setIdAt = appel ? mainSrc.indexOf(appel[0]) : -1
record(
  'AppUserModelID 在 app.whenReady() 之前设置',
  setIdAt > 0 && readyAt > 0 && setIdAt < readyAt,
  `setAppUserModelId 位置 ${setIdAt} / whenReady 位置 ${readyAt}`
)

/* 5. 托盘必须真的建了，且用与窗口同一个图标文件 */
const trayAt = mainSrc.indexOf('new Tray(')
const trayBlock = trayAt > 0 ? mainSrc.slice(Math.max(0, trayAt - 1200), trayAt + 400) : ''
record('主进程创建了通知区托盘', trayAt > 0, '缺 `new Tray(...)`：右下角通知区没有本程序的位置')
record(
  '托盘与窗口图标引用同一个文件',
  trayBlock.includes("'build'") && trayBlock.includes("'icon.ico'"),
  '托盘图标路径必须与 BrowserWindow 的 icon 同为 ../../build/icon.ico，否则两处各改一套'
)

/* 6. 该图标文件真实存在（打包前就得在，构建时才拷得进去） */
record(
  'build/icon.ico 存在',
  fs.existsSync(ICON),
  `缺失：${path.relative(ROOT, ICON)} —— 跑 python tools/gen-app-icon.py`
)

/* 7. 必须随包：files 白名单漏了它 = 装完托盘空白（且开发模式测不出来） */
const filesBlock = builderSrc.slice(builderSrc.indexOf('files:'), builderSrc.indexOf('extraResources:'))
record(
  'electron-builder.yml 的 files 已包含 build/icon.ico',
  /^\s*-\s*build\/icon\.ico\s*$/m.test(filesBlock),
  'files 是白名单，漏了它则 asar 内没有图标 —— 开发模式完全正常，装出来托盘空白'
)

/* -------------------------------- 汇总 -------------------------------- */

const failed = results.filter((r) => !r.ok).length
if (failed) {
  console.error(`\nAPP_ICON_WIRING_FAILED  ${failed} / ${results.length} 项不成立`)
} else {
  console.error(`\nAPP_ICON_WIRING_OK  exe/任务栏/托盘 图标成链，AppID ${appIdInCode} 三方一致`)
}
// verify.mjs 靠这一行解析断言总数，少一行会报"解析不到断言数"
console.log(`APP_ICON_WIRING_STATS total=${results.length} pass=${results.length - failed} fail=${failed}`)
process.exitCode = failed ? 1 : 0
