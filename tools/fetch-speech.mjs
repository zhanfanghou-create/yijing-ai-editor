#!/usr/bin/env node
/**
 * 把「语音识别」要用的运行时抓进随包目录。
 *
 *   node tools/fetch-speech.mjs
 *
 * 抓的是 sherpa-onnx 的 Node N-API 插件（k2-fsa/sherpa-onnx，Apache-2.0）
 * 加它依赖的 onnxruntime 动态库，一共 5 个文件、约 23MB。
 *
 * 为什么不像贴纸那样把文件提交进仓库：
 *   · 全是二进制（1 个 .node + 4 个 .dll），塞进 MIT 仓库只会让 clone 变重；
 *   · 许可证是 Apache-2.0（onnxruntime 是 MIT），该不该随**安装包**分发由打包者决定，
 *     仓库里只留「怎么拿到它」的脚本 + 许可证说明 —— 与 ffmpeg / mediapipe 完全一致。
 *
 * 为什么不从 GitHub Release 抓：
 *   sherpa-onnx 的 Windows 预编译包只有 `.tar.bz2`，解它要么引一个 bz2 实现、
 *   要么调系统的 `tar`。而 npm 包里**就是同一批文件**，jsDelivr 又能按单文件直出，
 *   于是"抓取"退化成 5 次普通下载 —— 和用户点「下载」走的是同一条代码路径。
 *   少一条路径 = 少一处只在发版时才会暴露的差异。
 *
 * ⚠️ 抓完必须能被打进安装包：`electron-builder.yml` 的 extraResources 里有
 *    `resources/speech` 这一条。漏了它开发模式一切正常、装出来的包里
 *    点「AI 识别字幕」永远提示"运行时没装"（而随包那份明明就在仓库里）。
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'packages/desktop/resources/speech')

/* 版本钉死：与 main/models.js 注册表里 speech-runtime 的 URL 必须一致。
   两处版本不同的话，下载来的运行时与随包那份是两套 ABI，
   症状是"开发模式好好的、装出来的包一识别就崩"。 */
const VERSION = '2.0.1'
const BASE = `https://cdn.jsdelivr.net/npm/sherpa-onnx-win-x64@${VERSION}`

/** 必须随包的五个文件：插件本体 + 它依赖的四个动态库 */
const FILES = [
  'sherpa-onnx.node',
  'onnxruntime.dll',
  'onnxruntime_providers_shared.dll',
  'sherpa-onnx-c-api.dll',
  'sherpa-onnx-cxx-api.dll'
]

const LICENSE = `sherpa-onnx 运行时（随包二进制）
==================================

本目录下的文件来自 k2-fsa/sherpa-onnx（v${VERSION} 的 Windows x64 N-API 构建）：
  sherpa-onnx.node                  推理插件本体
  sherpa-onnx-c-api.dll             C 接口
  sherpa-onnx-cxx-api.dll           C++ 接口
  onnxruntime.dll                   ONNX Runtime（微软，MIT）
  onnxruntime_providers_shared.dll  ONNX Runtime 的 provider 共享库

sherpa-onnx 许可证：Apache License 2.0
  https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE

onnxruntime 许可证：MIT
  https://github.com/microsoft/onnxruntime/blob/main/LICENSE

下载地址（按单文件直出，与 tools/fetch-speech.mjs 一致）：
  ${BASE}/<文件名>

⚠️ 语音识别**模型**（.onnx 权重）不在本目录：
   它们由用户在「设置 → AI 模型」里下载，落到 <用户数据>/models/speech-*，
   或者由打包者放进去。模型体积 78MB 起，不适合默认随包。
`

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'YJAI-FetchSpeech' }, timeout: 60000 }, (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location && hops < 5) {
          res.resume()
          get(new URL(res.headers.location, url).toString(), hops + 1).then(resolve, reject)
          return
        }
        if (code !== 200) {
          res.resume()
          reject(new Error(`HTTP ${code}`))
          return
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

/** 注册表里登记的字节数 —— 拿它校验，避免"下到一页错误页"当成文件写下去 */
function expectedBytes(name) {
  try {
    const require_ = createRequire(import.meta.url)
    const models = require_(path.join(ROOT, 'packages/desktop/src/main/models.js'))
    const entry = models.byId('speech-runtime')
    const spec = entry && entry.files.find((item) => item.name === name)
    return spec ? Number(spec.bytes) || 0 : 0
  } catch {
    return 0
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  for (const name of FILES) {
    const dest = path.join(OUT, name)
    const want = expectedBytes(name)
    if (want > 0 && fs.existsSync(dest) && fs.statSync(dest).size === want) {
      console.log(`[fetch-speech] 跳过（已就绪）：${name}`)
      continue
    }
    process.stdout.write(`[fetch-speech] 下载 ${name} … `)
    const buf = await get(`${BASE}/${name}`)
    if (want > 0 && buf.length !== want) {
      throw new Error(`${name} 体积不符：应为 ${want} 字节，实际 ${buf.length} 字节`)
    }
    fs.writeFileSync(dest, buf)
    console.log(`${(buf.length / 1024 / 1024).toFixed(2)} MB`)
  }
  fs.writeFileSync(path.join(OUT, 'LICENSE.txt'), LICENSE)
  console.log(`[fetch-speech] 完成 → ${OUT}`)
  console.log('[fetch-speech] 提醒：模型不随包，用户在「设置 → AI 模型」里下载。')
}

main().catch((err) => {
  console.error(`[fetch-speech] 失败：${err.message}`)
  process.exit(1)
})
