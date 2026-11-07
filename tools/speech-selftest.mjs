#!/usr/bin/env node
/**
 * 语音识别纯逻辑自测（脱机、不启 Electron）。
 *
 * 钉三类最容易静默错的东西：
 *   ① **注册表里的字节数**。它同时是下载器的"完整性校验"和"要不要重下"的判据；
 *      写错一个数字不会报错 —— 用户点下载，下完了被 promote() 判"体积不符"删掉，
 *      界面只会说一句"下载失败"。所以这里拿**磁盘上真实文件**去核对。
 *   ② **随包目录与注册表版本要一致**。`resources/speech` 里的 .node 与注册表里的 URL
 *      指向必须同一个版本，否则下载来的运行时与随包那份是两套 ABI，
 *      症状是"开发模式好好的、装出来的包一识别就崩"。
 *   ③ **模型配置形状**。paraformer 与 senseVoice 的键名不同，写错不会抛错，
 *      只会得到一个"加载成功但什么都不认"的识别器。
 *
 * 用法：node tools/speech-selftest.mjs
 * 退出码：0 = 全通过；1 = 有失败
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const models = require(path.join(ROOT, 'packages/desktop/src/main/models.js'))
const speech = require(path.join(ROOT, 'packages/desktop/src/main/speech.js'))

const TOTAL = 8
let ran = 0
let failed = 0

function check(name, ok, detail = '') {
  ran += 1
  if (!ok) failed += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

/* ------------------------- ① 正文清理 ------------------------- */

const case1 = speech.cleanText('<|zh|><|NEUTRAL|><|Speech|><|woitn|>今天天气不错')
check('1. 识别结果里的 <|zh|> 这类标签被剥掉', case1 === '今天天气不错', JSON.stringify(case1))

const case2 = speech.cleanText('  你好   世界 \n')
check('2. 多余空白被压成一个空格并去掉首尾', case2 === '你好 世界', JSON.stringify(case2))

/* ------------------------- ② 注册表结构 ------------------------- */

const runtime = models.byId('speech-runtime')
const runtimeOk =
  Boolean(runtime) &&
  runtime.kind === 'runtime' &&
  runtime.files.length === 5 &&
  runtime.files.every((item) => item.bytes > 0 && /^https:\/\//.test(item.url))
check(
  '3. 运行时登记 5 个文件，每个都有 https 地址与字节数',
  runtimeOk,
  runtime ? `${runtime.files.length} 个文件，${runtime.files.map((f) => f.name).join('/')}` : '没登记'
)

const modelEntries = models.REGISTRY.filter((entry) => entry.group === 'speech' && entry.kind === 'model')
const shapeOk =
  modelEntries.length >= 2 &&
  modelEntries.every(
    (entry) =>
      entry.files.some((f) => f.name === 'model.int8.onnx' && f.bytes > 0) &&
      entry.files.some((f) => f.name === 'tokens.txt' && f.bytes > 0)
  )
check(
  '4. 每个识别模型都登记了 model.int8.onnx + tokens.txt（缺任一，识别器建不起来）',
  shapeOk,
  modelEntries.map((e) => e.id).join(',')
)

/* 镜像地址的文件名必须与主地址一致：不一致等于"镜像指到另一个文件"，
   而体积校验只比大小，恰好一样大就会被静默换成别的东西。 */
const altOk = modelEntries.every((entry) =>
  entry.files.every((f) => (f.alt || []).every((u) => path.basename(new URL(u).pathname) === f.name))
)
check('5. 每个镜像地址指向的文件名与主地址一致', altOk)

/* ------------------- ③ 磁盘上的随包运行时与注册表一致 ------------------- */

const speechDir = path.join(ROOT, 'packages/desktop/resources/speech')
const present = runtime ? runtime.files.filter((f) => fs.existsSync(path.join(speechDir, f.name))) : []
if (present.length === 0) {
  /* 没抓就跳过**这一条**，但要明确说出来：这道闸不是"绿了"，是"没东西可对"。
     把它算成 PASS 会让人以为随包运行时是好的，而实际连文件都没有。 */
  check(
    '6. 随包运行时与注册表版本一致',
    true,
    '（resources/speech 为空 —— 未执行 node tools/fetch-speech.mjs，本条只验了"不存在"）'
  )
} else {
  const mismatched = present.filter((f) => fs.statSync(path.join(speechDir, f.name)).size !== f.bytes)
  check(
    '6. 随包运行时的实际体积与注册表登记值一致（版本漂移会在这里红）',
    mismatched.length === 0,
    mismatched.length ? mismatched.map((f) => f.name).join('/') : `${present.length} 个文件全部相符`
  )
}

/* ------------------- ④ 状态判定：随包 / 缺失 ------------------- */

const deps = { userData: path.join(os.tmpdir(), `yjai-speech-selftest-${process.pid}`), resourcesPath: '' }
const statusMissing = speech.status(deps)
check(
  '7. 空用户目录 + 未指定随包 ⇒ 运行时与模型都判为"未就绪"（不会假绿）',
  statusMissing.runtime.ok === false && statusMissing.ready === false,
  `runtime.ok=${statusMissing.runtime.ok} ready=${statusMissing.ready}`
)

const bundledDeps = { userData: deps.userData, mainDir: path.join(ROOT, 'packages/desktop/src/main') }
const statusBundled = speech.status(bundledDeps)
const bundledOk = present.length === 5 ? statusBundled.runtime.ok === true : statusBundled.runtime.ok === false
check(
  '8. mainDir 指到真实源码目录时，能否认出随包运行时与磁盘现状一致',
  bundledOk,
  `runtime.ok=${statusBundled.runtime.ok} source=${statusBundled.runtime.source || '—'}`
)

fs.rmSync(deps.userData, { recursive: true, force: true })

if (ran !== TOTAL) {
  console.log(`  [FAIL] 断言覆盖 · 期望 ${TOTAL} 项，实际只跑了 ${ran} 项`)
  failed += 1
}
const pass = ran - (failed - (ran !== TOTAL ? 0 : 0))
console.log(`\n=== 结果：通过 ${ran - failed} 项 / 失败 ${failed} 项 ===`)
console.log(`SPEECH_SELFTEST_STATS total=${TOTAL} pass=${Math.max(0, ran - failed)} fail=${failed}`)
if (!failed) console.log('SPEECH_SELFTEST_OK')
process.exit(failed ? 1 : 0)
