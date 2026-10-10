#!/usr/bin/env node
/**
 * node_modules 安装完整性检查。
 *
 * 为什么需要它：本机反复出现「包目录在、但内容缺一半」的情况 —— npm 中断 / 被安全门
 * 挂起 / 被并发操作抢 node_modules 都会留下这种状态。典型症状是**运行时报一个和
 * 业务毫无关系的模块找不到**，例如：
 *
 *   [vite] Pre-transform error: Cannot find module 'caniuse-lite/dist/unpacker/agents'
 *
 * 而 `node_modules/caniuse-lite/` 目录明明存在、package.json 也在，只是少了整个 dist/。
 * 这种问题不会让 `npm ls` 报错，也不会让 `vite build` 失败（打包走 esbuild/rollup，
 * 不经过 browserslist），只在开发服务器的 Babel 转换路径上炸 —— 排查成本极高。
 *
 * 做法：遍历每个包，读它的 package.json，把声明的入口字段（main / module / browser /
 * exports）逐个落地成文件路径，存在性检查。缺了就报出来。
 *
 * 用法：node tools/check-node-modules.mjs [node_modules 目录]
 *
 * 退出码（刻意分开，"检查器崩了"和"查出问题"不能共用 1）：
 *   0 = 扫描完成，全部完整
 *   1 = 扫描完成，发现不完整的包        ← 正常结论
 *   2 = 参数/目录错误，没能开始扫描
 *   3 = 检查器自身异常                ← 这一条曾经不存在，代价见下
 *
 * 为什么要单独给 3：Node 未捕获异常会以退出码 1 退出，和"查出问题"完全撞车。
 * 曾经的写法在遇到损坏的 package.json 时崩在打印之前，于是表现为
 * 「退出码 1 + 一个字都没输出」—— 单跑检查器时这看起来像"没查出问题"，
 * 实际是"根本没查完"。所以崩了必须喊出来，且喊得和正常结论不一样。
 */

import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] || 'node_modules'

const problems = []
let checked = 0
let entrypoints = 0

/** 把一个声明路径解析成「它到底指哪个文件」，容忍目录式 main（lib → lib/index.js） */
function resolves(baseDir, rel) {
  const p = path.join(baseDir, rel)
  const candidates = [p, `${p}.js`, `${p}.cjs`, `${p}.mjs`, `${p}.json`, path.join(p, 'index.js'), path.join(p, 'index.cjs'), path.join(p, 'index.mjs'), path.join(p, 'index.json')]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

/**
 * 从 exports 字段里抽出**运行时**入口文件路径。
 *
 * 两个刻意的取舍（都是实测踩出来的，别当成"漏了"）：
 *   1. 跳过 TypeScript 声明（.d.ts / .d.mts / .d.cts）。不少包（如 @babel/helper-*）
 *      package.json 里写了 types → ./lib/index.d.ts，但实际不发 d.ts 文件。
 *      那不是安装不完整，只是没带类型；当成缺失会立刻出现 4~5 个误报。
 *   2. 只看 "." 这个入口。子路径映射（"./lib/xxx"）里有很多可选/条件导出，
 *      逐个校验的通配与条件分支太多，误报率会淹掉真问题。
 */
function entryOfExports(exp) {
  const out = []
  const walk = (node) => {
    if (typeof node === 'string') {
      if (node.startsWith('./') && !node.includes('*') && !/\.d\.(ts|mts|cts)$/.test(node)) out.push(node)
      return
    }
    if (node && typeof node === 'object') {
      for (const v of Object.values(node)) walk(v)
    }
  }
  if (typeof exp === 'string') walk(exp)
  else if (exp && typeof exp === 'object') walk(exp['.'] !== undefined ? exp['.'] : exp)
  return out
}

function checkPackage(dir, label) {
  const pkgFile = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgFile)) return
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  } catch {
    // 这里曾写成 pkg.name —— JSON.parse 抛异常时 pkg 还是 undefined，
    // 于是「报告一个包损坏」变成「检查器自己崩溃」，且崩在打印之前，
    // 整个扫描结果被吞掉，看起来像「什么都没查出来」。用 label（含 scope）。
    checked += 1
    problems.push({ name: label, why: 'package.json 无法解析（已损坏）' })
    return
  }
  checked += 1

  const declared = []
  for (const k of ['main', 'module']) {
    if (typeof pkg[k] === 'string') declared.push([k, pkg[k]])
  }
  if (typeof pkg.browser === 'string') declared.push(['browser', pkg.browser])
  if (pkg.exports !== undefined) {
    for (const rel of entryOfExports(pkg.exports)) declared.push(['exports', rel])
  }

  const missing = []
  for (const [field, rel] of declared) {
    entrypoints += 1
    if (!resolves(dir, rel)) missing.push(`${field} → ${rel}`)
  }
  if (missing.length) {
    problems.push({ name: pkg.name || label, version: pkg.version, why: `入口文件缺失：${missing.join('，')}` })
  }
}

function scan(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === '.bin') continue
    if (e.name.startsWith('@')) {
      // scope 目录：再下一层才是包
      const scopeDir = path.join(dir, e.name)
      for (const s of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (s.isDirectory()) checkPackage(path.join(scopeDir, s.name), `${e.name}/${s.name}`)
      }
    } else if (e.name.startsWith('.')) {
      continue
    } else {
      checkPackage(path.join(dir, e.name), e.name)
    }
  }
}

if (!fs.existsSync(root)) {
  console.error(`[失败] 目录不存在：${root}`)
  process.exit(2)
}

// 兜底：任何未预期异常都要留下明确痕迹，绝不能退化成"没输出 + 退出码 1"。
// 注：这条路径无法用夹具稳定触发（上面两个真实崩溃点已各自修掉），属于纯防御性代码 ——
// 它没被测过，别当成"已验证"。它的价值在于把将来新引入的崩溃变得可识别。
try {
  scan(root)
} catch (e) {
  console.error('NODE_MODULES_CHECKER_CRASHED')
  console.error('检查器自身异常，本次结果不完整、不可信（不是"没查出问题"）：')
  console.error(e && e.stack ? e.stack : e)
  process.exit(3)
}

console.log(`NODE_MODULES_OK  已检查 ${checked} 个包、${entrypoints} 个入口声明`)
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个包的安装不完整：`)
  for (const p of problems.slice(0, 30)) {
    console.log(`  - ${p.name}${p.version ? '@' + p.version : ''} :: ${p.why}`)
  }
  if (problems.length > 30) console.log(`  …另有 ${problems.length - 30} 个`)
  console.log('\nNODE_MODULES_INCOMPLETE')
  process.exit(1)
}
