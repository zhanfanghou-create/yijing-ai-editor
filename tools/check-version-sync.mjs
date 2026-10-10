#!/usr/bin/env node
/**
 * 「版本号口径」的看门狗 —— 权威版本只有一处，该同号的必须同号。
 *
 * 为什么需要它（2026-10-02 PM 审查 P1-5）：仓库里有 4 个 package.json 各自写 `1.0.0`，
 * 谁也不消费谁。于是发布时会出现「安装包叫 1.1.0、客户端关于页显示 1.0.0」这种
 * 自相矛盾的产物 —— 而**没有任何一道闸门会说不**：每个文件各自看都是合法的版本号。
 *
 * 判据（口径写在 tools/version.mjs 的头注释里，这里只负责机械执行）：
 *   · 权威版本 = packages/desktop/package.json 的 version；
 *   · 根 package.json 与 installer 必须与它**同号**；
 *   · 客户端「版本」行与安装包文件名都必须**取自权威**，不许各自硬编码；
 *   · server / admin-panel **独立演进**，不同号不算错（服务端按自己的部署节奏发版）。
 *
 * 断言总数恒为 7（见 TOTAL_ASSERTIONS）：
 *   1 权威版本合法 / 2·2b 两处必须同号 / 3 安装包文件名用变量 / 4 显示版本取自包内 /
 *   5·6 自证（写死版本号的能分辨出来）。
 * 用法：
 *   node tools/check-version-sync.mjs            # 校验（闸门用）
 *   node tools/check-version-sync.mjs --selftest # 只跑检测器自证
 */
import fs from 'node:fs'
import path from 'node:path'
import { readVersion } from './version.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

/** 断言总数：闸门用它钉死"断言有没有被悄悄删掉" */
export const TOTAL_ASSERTIONS = 7

const AUTHORITY = 'packages/desktop/package.json'
const SYNCED = ['package.json', 'packages/installer/package.json']

/* ------------------------------------------------------------- 检测器本体 */

/**
 * 安装包文件名里必须带 `${version}`（electron-builder 的变量），
 * 不能写死 1.0.0 —— 写死的那天，文件名与包内版本就开始各走各的。
 */
function artifactUsesVersion() {
  const yml = path.join(ROOT, 'packages', 'desktop', 'electron-builder.yml')
  if (!fs.existsSync(yml)) return { ok: false, why: 'desktop/electron-builder.yml 不存在' }
  const text = fs.readFileSync(yml, 'utf8')
  const line = text.split('\n').find((row) => row.includes('artifactName'))
  if (!line) return { ok: false, why: '没有 artifactName 行' }
  if (/\d+\.\d+\.\d+/.test(line)) return { ok: false, why: `artifactName 里写死了版本号：${line.trim()}` }
  return { ok: line.includes('${version}'), why: line.trim() }
}

/**
 * 客户端显示版本必须来自 package.json（app.getVersion() / 读源文件），
 * 不能是界面里写死的字面量。
 */
function displayUsesPackage() {
  const file = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
  if (!fs.existsSync(file)) return { ok: false, why: 'main/index.js 不存在' }
  const text = fs.readFileSync(file, 'utf8')
  const hasAppGet = text.includes('app.getVersion()')
  const readsPkg = /package\.json/.test(text) && /appVersion/.test(text)
  return { ok: hasAppGet && readsPkg, why: `app.getVersion=${hasAppGet} 读 package.json=${readsPkg}` }
}

/* ------------------------------------------------------------------ 夹具 */

/** 自证：把"写死版本号"与"用变量"两种情况喂进去，判据必须能分辨 */
const FIXTURE_HARDCODED = '  artifactName: YiJingAIEditor-1.0.0-Windows-${arch}.${ext}'
const FIXTURE_VARIABLE = '  artifactName: YiJingAIEditor-${version}-Windows-${arch}.${ext}'

function artifactLineOk(line) {
  if (/\d+\.\d+\.\d+/.test(line)) return false
  return line.includes('${version}')
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const selftest = process.argv.includes('--selftest')
  let pass = 0
  let fail = 0
  const check = (name, ok, detail = '') => {
    if (ok) pass += 1
    else fail += 1
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
  }

  if (!selftest) {
    const current = readVersion(AUTHORITY)
    console.log(`版本号口径（权威 = ${AUTHORITY} → ${current}）\n`)

    check('1. 权威版本号是合法的三段式 x.y.z', /^\d+\.\d+\.\d+$/.test(current), current || '(空)')

    for (const rel of SYNCED) {
      const value = readVersion(rel)
      check(
        `2${rel === SYNCED[0] ? '' : 'b'}. 与权威同号：${rel}`,
        value === current,
        `${value || '(空)'} vs ${current}`
      )
    }

    const artifact = artifactUsesVersion()
    check('3. 安装包文件名用 ${version} 变量（不许写死版本号）', artifact.ok, artifact.why)

    const display = displayUsesPackage()
    check('4. 客户端显示版本取自包内 package.json（不是界面写死的字面量）', display.ok, display.why)
  }

  check(
    `${selftest ? '1' : '5'}. 自证：写死版本号的 artifactName 会被判红`,
    artifactLineOk(FIXTURE_HARDCODED) === false,
    '夹具（硬编码 1.0.0）'
  )
  check(
    `${selftest ? '2' : '6'}. 自证：用 \${version} 变量的 artifactName 会被判绿`,
    artifactLineOk(FIXTURE_VARIABLE) === true,
    '夹具（变量）'
  )

  console.log(`\nVERSION_SYNC_STATS ok=${pass} total=${pass + fail} fail=${fail}`)
  console.log(fail ? 'VERSION_SYNC_FAILED' : 'VERSION_SYNC_OK')
  process.exitCode = fail ? 1 : 0
}

main()
