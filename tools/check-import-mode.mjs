#!/usr/bin/env node
/**
 * 闸门 · 素材导入方式（保留原位 / 复制进草稿）的接线。
 *
 * 这类"设置项"最容易变成一根**装饰开关**：按钮画出来了、点了也变蓝，
 * 但主进程压根没读它 —— 用户以为复制进去了，实际还是引用原路径，
 * 清理原始目录后整份草稿变离线。构建不报错、界面也看不出。
 *
 * 所以这里顺着**一条链**逐环点名，缺任何一环都算失败：
 *   设置项(读) → App 传入 → platform 透传 → preload 转发 → 主进程读 mode
 *   → 复制函数存在 → **先复制再 describeMedia**（顺序错了白名单登记的是原路径）
 *   → 复制失败退回原路径（不是返回空）
 *
 * 用法：node tools/check-import-mode.mjs
 * 退出码：0 = 通过；1 = 有失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

let pass = 0
let fail = 0
const problems = []
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    problems.push(label)
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  —— ${detail}`}`)
  }
}

const main = read('packages/desktop/src/main/index.js')
const preload = read('packages/desktop/src/preload/index.js')
const platform = read('packages/desktop/src/renderer/platform.js')
const app = read('packages/desktop/src/renderer/App.jsx')
const dialogs = read('packages/desktop/src/renderer/components/Dialogs.jsx')

console.log('\n== 一、链路逐环 ==\n')

check('主进程：media:pick 读得到 options.mode', /media:pick',\s*async\s*\(event,\s*options\)/.test(main))
check('主进程：mode === copy 时才复制（默认必须是 link）', /options\.mode === 'copy' \? 'copy' : 'link'/.test(main))
check('主进程：复制函数存在', /function copyIntoMaterials\(/.test(main))
check(
  '主进程：**先复制、再 describeMedia**（顺序反了白名单登记的是原路径）',
  /describeMedia\(mode === 'copy' \? copyIntoMaterials\(filePath\) : filePath\)/.test(main)
)
check(
  '主进程：复制失败退回原路径（catch 里 return sourcePath，而不是空串）',
  /function copyIntoMaterials\([\s\S]{0,1400}?catch\s*\{\s*return sourcePath\s*\}/.test(main)
)
check(
  '主进程：副本文件名带短哈希（同名文件不能互相覆盖）',
  /createHash\('sha1'\)[\s\S]{0,200}?path\.join\(dir,/.test(main)
)

check('preload：pick 把 options 转发给主进程', /pick:\s*\(options\)\s*=>\s*ipcRenderer\.invoke\('media:pick', options \|\| \{\}\)/.test(preload))
check('platform：pickMedia 透传 options', /export async function pickMedia\(options = \{\}\)[\s\S]{0,200}?bridge\.media\.pick\(options\)/.test(platform))
check('App：选文件时把 importMode 传下去', /pickMedia\(\{ mode: importMode \}\)/.test(app))
check('App：importMode 有初值与持久化读写', /setSetting\('importMode'/.test(app) && /getSetting\('importMode'\)/.test(app))
check('设置页：两个模式按钮都在（保留原位 / 复制进草稿）', /data-import-mode="link"/.test(dialogs) && /data-import-mode="copy"/.test(dialogs))
check('设置页：两个按钮都接了回调（不是死按钮）', (dialogs.match(/onImportModeChange && onImportModeChange\(/g) || []).length === 2)

console.log('\n== 二、自证：判据不可分辨的坏样本必须被判为假 ==\n')

{
  /* 这些是"错误实现"的文本形状，本闸门的正则必须**不**匹配它们 */
  const wrongOrder = `describeMedia(filePath); const x = copyIntoMaterials(filePath)`
  const noMode = `ipcMain.handle('media:pick', async (event) => {`
  const deadButton = `<button type="button" className="active">保留原位</button>`
  const wrongs = [
    ['顺序反了（先描述再复制）', /describeMedia\(mode === 'copy' \? copyIntoMaterials\(filePath\) : filePath\)/.test(wrongOrder)],
    ['主进程不读 mode', /media:pick',\s*async\s*\(event,\s*options\)/.test(noMode)],
    ['设置按钮没接回调', /data-import-mode="link"/.test(deadButton) && /onImportModeChange && onImportModeChange\(/.test(deadButton)]
  ]
  let caught = 0
  for (const [label, isWrong] of wrongs) {
    if (!isWrong) {
      caught += 1
      console.log(`  ✓ ${label} —— 错误状态为假（判据可分辨）`)
    } else {
      fail += 1
      problems.push(`自证失败：${label}`)
      console.log(`  ✗ 自证失败：${label} 竟然成立（判据不可分辨）`)
    }
  }
  console.log(`\n自证：${caught}/${wrongs.length} 个错误状态被判为假`)
}

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('IMPORT_MODE_FAILED')
  for (const item of problems) console.log(`  - ${item}`)
  process.exit(1)
}
console.log('IMPORT_MODE_OK')
process.exit(0)
