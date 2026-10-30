#!/usr/bin/env node
/**
 * 把「人物特效」要用的 face landmarker 运行时抓进随包目录。
 *
 *   node tools/fetch-mediapipe.mjs
 *
 * 为什么不像贴纸那样直接把素材提交进仓库：
 *   · `vision_wasm_internal.wasm` 单文件 14.5MB，模型 3.6MB —— 这是**二进制**，
 *     不是本工程的源代码，塞进 MIT 仓库只会让 clone 变重；
 *   · 许可证也不同：MediaPipe 是 Apache-2.0，模型是同族许可。二进制该不该随
 *     **安装包**分发由打包者决定，仓库里只留「怎么拿到它」的脚本 + 许可证说明
 *     —— 与 ffmpeg 那一套完全一致（见 tools/fetch-ffmpeg.mjs 与 .gitignore 注释）。
 *
 * ⚠️ 只带 SIMD 版（`vision_wasm_internal.*`），不带 `nosimd`：
 *    两份一起放会让随包体积翻倍（+14.5MB），而 Electron 自带的 Chromium
 *    远高于 SIMD 基线（91+）。真遇到不支持 SIMD 的机器会加载失败，
 *    那时再补 nosimd —— 这属于「为了一个几乎不存在的环境，让所有人多下 14MB」。
 *
 * ⚠️ 抓完必须能被打进安装包：`electron-builder.yml` 的 extraResources 里有
 *    `resources/mediapipe` 这一条。漏了它，开发模式一切正常、装出来的包
 *    点人物特效直接报 "Failed to fetch"（而且只在装出来的包里出现）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'packages/desktop/resources/mediapipe')
const PKG = path.join(ROOT, 'node_modules/@mediapipe/tasks-vision')

/** 必须随包的三个文件：加载器 JS + wasm + 模型 */
const FROM_PKG = ['wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm']
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const MODEL_NAME = 'face_landmarker.task'

const LICENSE = `MediaPipe Face Landmarker —— 随包运行时与模型
==================================================

本目录下的文件来自 Google MediaPipe，许可证 Apache License 2.0：
  https://github.com/google-ai-edge/mediapipe
  https://www.apache.org/licenses/LICENSE-2.0

文件来源
--------
vision_wasm_internal.js / vision_wasm_internal.wasm
  @mediapipe/tasks-vision（npm 包）的 wasm/ 目录，版本见 package.json。
face_landmarker.task
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

重新获取
--------
  npm install
  node tools/fetch-mediapipe.mjs

这些文件不入 git 仓库（体积 + 许可），只随**安装包**分发。
若二次分发本软件，请随附本文件与 Apache-2.0 全文。
`

const README = `人物特效的随包运行时（二进制，不入库）

  node tools/fetch-mediapipe.mjs      # 从 node_modules + 官方地址抓

缺文件的症状：安装后点「人物特效 → 开始识别」报 Failed to fetch，
但开发模式下一切正常（开发模式从 node_modules 直接读）。
`

function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  /* 先写临时文件再改名：中途断网留下的半截文件会被下次运行当成"已存在"，
     而半截 wasm 的表现是 `WebAssembly.CompileError: expected magic word`，
     看起来像代码 bug。 */
  const tmp = `${dest}.part`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, dest)
  return buf.length
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  if (!fs.existsSync(PKG)) {
    console.error(`找不到 ${PKG}\n先跑 npm install（@mediapipe/tasks-vision 在 dependencies 里）。`)
    process.exit(1)
  }

  let total = 0
  for (const rel of FROM_PKG) {
    const src = path.join(PKG, rel)
    const dst = path.join(OUT, path.basename(rel))
    if (!fs.existsSync(src)) {
      console.error(`包里没有 ${rel} —— 版本变了？看一眼 node_modules/@mediapipe/tasks-vision/wasm/`)
      process.exit(1)
    }
    fs.copyFileSync(src, dst)
    const n = sizeOf(dst)
    total += n
    console.log(`  ✓ ${path.basename(rel).padEnd(30)} ${mb(n)}`)
  }

  const modelDest = path.join(OUT, MODEL_NAME)
  const have = sizeOf(modelDest)
  /* 3.5MB 的模型每跑一次都重下没必要；但"存在"不等于"完整"，
     所以用一个下限判断（实测 3758596，留 95% 余量）。 */
  if (have > 3500000) {
    console.log(`  · ${MODEL_NAME.padEnd(30)} ${mb(have)}（已存在，跳过下载）`)
    total += have
  } else {
    const n = await download(MODEL_URL, modelDest)
    total += n
    console.log(`  ✓ ${MODEL_NAME.padEnd(30)} ${mb(n)}`)
  }

  fs.writeFileSync(path.join(OUT, 'LICENSE.txt'), LICENSE)
  fs.writeFileSync(path.join(OUT, 'README.txt'), README)

  console.log(`\n共 ${mb(total)} → ${path.relative(ROOT, OUT)}`)
  console.log('提醒：electron-builder.yml 的 extraResources 必须有 resources/mediapipe，否则装出来的包缺文件。')
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
