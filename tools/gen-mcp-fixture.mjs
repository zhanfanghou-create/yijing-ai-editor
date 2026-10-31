#!/usr/bin/env node
/**
 * 生成 MCP 全流程 E2E 用的夹具（可重复生成，不许手工替换）。
 *
 * 为什么用**纯色 + 正弦音**：
 *   · `mcp-base.mp4` 是硬边纯红 —— 套上 `mono` 滤镜之后整帧必须变成灰，
 *     只要还剩一点红就说明滤镜没进成片。"画面看着变了"不能当证据，
 *     `max|r-g|` 才是。
 *   · 带音轨，才能验"导出里真的有声音"（不是一条静音视频）。
 *
 * 产物：
 *   tools/fixtures/mcp-base.mp4   5s / 640x360 / 30fps / h264 + aac 440Hz
 *   tools/fixtures/mcp-subs.srt   3 条字幕，盖住 0.2s–3.8s
 *
 * 用法：node tools/gen-mcp-fixture.mjs [--ffmpeg <path>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(__dirname, 'fixtures')
const OUT = path.join(FIX, 'mcp-base.mp4')
const SRT = path.join(FIX, 'mcp-subs.srt')

const DURATION = 5
const WIDTH = 640
const HEIGHT = 360
const FPS = 30

function ffmpegOf() {
  const fromArg = process.argv.indexOf('--ffmpeg')
  if (fromArg > 0 && process.argv[fromArg + 1]) return process.argv[fromArg + 1]
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH
  return 'ffmpeg'
}

function main() {
  fs.mkdirSync(FIX, { recursive: true })
  const bin = ffmpegOf()
  const args = [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0xC81E1E:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${DURATION}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-shortest',
    '-movflags',
    '+faststart',
    OUT
  ]
  const res = spawnCapture(bin, args, { timeout: 120000 })
  if (res.status !== 0 || !fs.existsSync(OUT)) {
    console.error('生成夹具失败：', (res.error && res.error.message) || res.stdout || res.status)
    process.exit(1)
  }

  const cues = [
    { start: '00:00:00,200', end: '00:00:01,500', text: '第一句字幕' },
    { start: '00:00:01,600', end: '00:00:02,800', text: '第二句字幕' },
    { start: '00:00:02,900', end: '00:00:03,800', text: '第三句字幕' }
  ]
  const srt = cues.map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text}\n`).join('\n')
  fs.writeFileSync(SRT, srt, 'utf8')

  const size = fs.statSync(OUT).size
  console.log(`mcp-base.mp4 ${WIDTH}x${HEIGHT} ${DURATION}s ${(size / 1024).toFixed(0)} KB`)
  console.log(`mcp-subs.srt ${cues.length} 条`)
  if (size < 5000) {
    console.error('产物太小，可疑')
    process.exit(1)
  }
}

main()
