#!/usr/bin/env node
/**
 * check-no-external-stub.mjs 的非空洞自证。
 *
 * 这道闸盯的是"界面上有入口、功能上等于没有"这类写法，它最大的风险同样不是漏报，
 * 而是**判据太宽或太窄**：
 *   · 太窄 —— 占位写法溜过去；
 *   · 太宽 —— 把「时间线上还没有片段，滤镜没有作用对象」这种**合法的状态提示**也判红，
 *     假红会训练人无脑忽略这道闸门，代价比漏报还大。
 * 所以夹具必须同时有"必须红"和"绝不能红"两面。
 *
 * 夹具（临时目录里现造现删，不碰仓库真源码）：
 *   clean            干净的渲染层                                    → 绿
 *   win-open         一个裸 window.open                              → 红在 window.open
 *   win-open-marked  带 allow-window-open 标记的 window.open（浏览器态兜底）→ 绿
 *   bare-site        openExternal('https://example.com')              → 红在官网首页
 *   var-link         openExternal(someUrl)（变量，静态无从判断）       → 绿（不假红）
 *   deep-link        openExternal('https://example.com/docs/...')     → 绿（不是根路径）
 *   stub-toast       toast('反馈还没接上')                            → 红在占位提示
 *   state-toast      toast('时间线上还没有片段…')（合法状态提示）       → 绿（防假红）
 *
 * 用法：node tools/check-no-external-stub.selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHECKER = path.join(here, 'check-no-external-stub.mjs')

let failures = 0
const record = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
}

/** 造一个只含 renderer 目录的最小仓库，body 写进 App.jsx */
const mkRoot = (body) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-nes-'))
  const dir = path.join(root, 'packages', 'desktop', 'src', 'renderer')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'App.jsx'), body)
  return root
}

const run = (root) => {
  const r = spawnCapture(process.execPath, [CHECKER, root], { cwd: root, timeout: 60000 })
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

const T = (s) => `export default function App() {\n${s}\n  return null\n}\n`

try {
  {
    const r = run(mkRoot(T("  const go = () => setDialog('notice')")))
    record('clean：退出码 0', r.status === 0, `实得 ${r.status}`)
    record('clean：打印 NO_EXTERNAL_STUB_OK', /NO_EXTERNAL_STUB_OK/.test(r.out))
  }
  {
    const r = run(mkRoot(T("  const go = () => window.open('https://a.test', '_blank')")))
    record('win-open：退出码 1', r.status === 1, `实得 ${r.status}`)
    record('win-open：报错点名 window.open', /window\.open/.test(r.out))
  }
  {
    const body = T(
      "  /* allow-window-open：浏览器态没有 bridge，只能这样 */\n  const go = () => window.open(url, '_blank')"
    )
    const r = run(mkRoot(body))
    record('win-open-marked：退出码 0（带豁免标记）', r.status === 0, `实得 ${r.status}｜${r.err.slice(0, 160)}`)
  }
  {
    const r = run(mkRoot(T("  const go = () => openExternal('https://example.com')")))
    record('bare-site：退出码 1', r.status === 1, `实得 ${r.status}`)
    record('bare-site：报错点名官网首页', /example\.com/.test(r.out))
  }
  {
    const r = run(mkRoot(T('  const go = () => openExternal(someUrl)')))
    record('var-link：退出码 0（变量外链静态无从判断，不能假红）', r.status === 0, `实得 ${r.status}｜${r.err.slice(0, 160)}`)
  }
  {
    const r = run(mkRoot(T("  const go = () => openExternal('https://example.com/docs/guide')")))
    record('deep-link：退出码 0（带具体路径的内容页不算占位）', r.status === 0, `实得 ${r.status}｜${r.err.slice(0, 160)}`)
  }
  {
    const r = run(mkRoot(T("  const go = () => toast('反馈问卷还没接上')")))
    record('stub-toast：退出码 1', r.status === 1, `实得 ${r.status}`)
    record('stub-toast：报错点名占位提示', /还没接上/.test(r.out))
  }
  {
    const r = run(mkRoot(T("  const go = () => toast('时间线上还没有片段，滤镜没有作用对象')")))
    record('state-toast：退出码 0（合法状态提示不能被误判）', r.status === 0, `实得 ${r.status}｜${r.err.slice(0, 160)}`)
  }

  const total = 13
  const passed = total - failures
  console.log('')
  console.log(`=== 结果：通过 ${passed} 项 / 失败 ${failures} 项 ===`)
  console.log(`NO_EXTERNAL_STUB_SELFTEST_STATS total=${total} pass=${passed} fail=${failures}`)
  if (failures === 0) console.log('NO_EXTERNAL_STUB_SELFTEST_OK')
  process.exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error('自证脚本自身异常：')
  console.error(String((error && error.stack) || error))
  process.exitCode = 1
}
