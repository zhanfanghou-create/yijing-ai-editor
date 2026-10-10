#!/usr/bin/env node
/**
 * check-node-modules.mjs 的非空洞自证。
 *
 * 为什么要有它：一个「检查器」最大的风险不是漏报，而是**它其实什么都没查**却报 OK。
 * 本项目已经吃过一次这种亏（verify 的闸门统计把 FAIL 当通过）。所以每个新增检查
 * 都必须配一组夹具，用「该报的必须报、不该报的绝不能报」把它钉死。
 *
 * 夹具（全在临时目录里现造现删，不污染仓库）：
 *   good-pkg         main 指向存在的文件                        → 不该报
 *   bad-pkg          main 指向缺失的 dist/unpacker/index.js      → 必须报
 *   types-only       types 指向不存在的 .d.ts，main 存在         → 不该报（刻意跳过 .d.ts）
 *   exports-good     exports 是字符串 "./lib/main.js"，文件在     → 不该报
 *   exports-bad      exports 是条件对象，require 入口文件缺失     → 必须报
 *   @scope/good-scoped  scope 包，入口存在                       → 不该报
 *   @scope/bad-scoped   scope 包，入口缺失                       → 必须报  ← 之前漏检的就是它
 *   corrupt-pkg      package.json 内容不是合法 JSON              → 必须报（且不能让脚本崩）
 *   no-manifest      目录里没有 package.json                     → 不该报（不是包）
 *   .bin/  .cache/   npm 自己的目录                              → 必须被跳过
 *
 * 用法：node tools/check-node-modules.selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { spawnCapture } from './spawn-capture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHECKER = path.join(here, 'check-node-modules.mjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-cnm-selftest-'))
const nm = path.join(root, 'node_modules')

/** 写一个包目录。files 里给的是相对路径 → 内容；值 null 表示建目录不建文件 */
function mk(rel, files) {
  const dir = path.join(nm, rel)
  fs.mkdirSync(dir, { recursive: true })
  for (const [p, content] of Object.entries(files)) {
    const target = path.join(dir, p)
    if (content === null) {
      fs.mkdirSync(target, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
  }
}

const j = (o) => JSON.stringify(o, null, 2)

try {
  mk('good-pkg', {
    'package.json': j({ name: 'good-pkg', version: '1.0.0', main: 'index.js' }),
    'index.js': 'module.exports = 1\n',
  })

  mk('bad-pkg', {
    'package.json': j({ name: 'bad-pkg', version: '1.0.0', main: 'dist/unpacker/index.js' }),
    // 刻意只建目录不建文件 —— 复刻 caniuse-lite 的真实故障形态
    'dist/unpacker': null,
  })

  mk('types-only', {
    'package.json': j({ name: 'types-only', version: '1.0.0', main: 'lib/index.js', types: 'lib/index.d.ts' }),
    'lib/index.js': 'module.exports = 1\n',
  })

  mk('exports-good', {
    'package.json': j({ name: 'exports-good', version: '1.0.0', exports: './lib/main.js' }),
    'lib/main.js': 'export default 1\n',
  })

  mk('exports-bad', {
    'package.json': j({
      name: 'exports-bad',
      version: '1.0.0',
      exports: { '.': { require: './dist/index.cjs', import: './dist/index.mjs' } },
    }),
    'dist': null,
  })

  mk('@scope/good-scoped', {
    'package.json': j({ name: '@scope/good-scoped', version: '1.0.0', main: 'index.js' }),
    'index.js': 'module.exports = 1\n',
  })

  mk('@scope/bad-scoped', {
    'package.json': j({ name: '@scope/bad-scoped', version: '2.0.0', main: 'dist/index.js' }),
    'dist': null,
  })

  mk('corrupt-pkg', {
    'package.json': '{ "name": "corrupt-pkg", oops }',
  })

  // 不是包，只是目录
  mk('no-manifest', { 'README.md': 'nothing\n' })

  // npm 自有目录，必须跳过
  mk('.bin', { 'vite': '#!/bin/sh\n' })
  mk('.cache', { 'junk.txt': 'x\n' })

  // 走 spawnCapture：进程内 spawn node 时 stdio 管道会 EBUSY（见 tools/spawn-capture.mjs）
  const run = spawnCapture(process.execPath, [CHECKER, nm])
  const out = run.stdout || ''

  const MUST_REPORT = ['bad-pkg', 'exports-bad', '@scope/bad-scoped', 'corrupt-pkg']
  const MUST_NOT_REPORT = ['good-pkg', 'types-only', 'exports-good', '@scope/good-scoped', 'no-manifest']

  const checks = []
  for (const n of MUST_REPORT) checks.push([true, n, out.includes(n)])
  for (const n of MUST_NOT_REPORT) checks.push([false, n, out.includes(n)])

  console.log('--- 检查器输出 ---')
  console.log(out.trim())
  console.log('--- 自证判定 ---')

  let failed = 0
  for (const [shouldReport, name, seen] of checks) {
    const ok = shouldReport ? seen : !seen
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} ${shouldReport ? '报出' : '不误报'} ${name}`)
  }

  // 退出码约定：有问题 → 1
  const codeOk = run.status === 1
  if (!codeOk) failed += 1
  console.log(`${codeOk ? 'PASS' : 'FAIL'} 退出码为 1（实际 ${run.status}）`)

  // .bin/.cache 不该被当成包统计：checked 数应等于真实包数 8
  const m = out.match(/已检查\s*(\d+)\s*个包/)
  const pkgCount = m ? Number(m[1]) : -1
  const countOk = pkgCount === 8
  if (!countOk) failed += 1
  console.log(`${countOk ? 'PASS' : 'FAIL'} 统计到 8 个包（实际 ${pkgCount}，说明 .bin/.cache/no-manifest 已被正确排除）`)

  // 直接盯那个已经修掉的回归：损坏的 package.json 必须被"报出来"，
  // 而不是让检查器自己崩掉（崩掉时输出里会出现 CRASHED 标记）。
  const noCrash = !out.includes('NODE_MODULES_CHECKER_CRASHED')
  if (!noCrash) failed += 1
  console.log(`${noCrash ? 'PASS' : 'FAIL'} 检查器自身未崩溃（损坏的 package.json 只报告、不中断）`)

  console.log(`自证：通过 ${checks.length + 3 - failed} 项 / 失败 ${failed} 项`)
  console.log(failed === 0 ? 'SELFTEST_PASSED' : 'SELFTEST_FAILED')
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
