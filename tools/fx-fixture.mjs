/**
 * 画面效果闸门的共用取证工具（不是闸门本身，不注册进 verify.mjs）。
 *
 * 为什么单独抽出来：描边 / 内阴影 / 自由变形三道闸门都要"渲一段真片子、
 * 取几个真像素"。这段取像素的代码在本机有两个坑，抄三遍就等于踩三遍：
 *   · `spawnCapture` 走管道拿不到二进制输出 ⇒ 必须先写临时文件再读；
 *   · `crop=1:1:x:y` 对 yuv 出不来稳定值 ⇒ 前面必须先 `format=rgb24`。
 *
 * 另外这里有**夹具约定**，改的时候注意：
 *   描边是往画面**外侧**长的一圈。夹具必须是"画面不铺满画布"（`scale: 60`），
 *   否则那一圈整个落在画框外被裁掉 —— 测出来会与"完全没效果"一模一样。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))
export const effects = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'effects.js'))
export const warp = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'warp.js'))

/** 本机 ffmpeg（走主进程同一个探测函数，不各写一份） */
export function ffmpegOf() {
  const found = render.findFfmpeg()
  return found && found.ffmpeg ? found.ffmpeg : ''
}

/** 临时工作目录（收尾由调用方删） */
export function workDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * 四象限彩图夹具（640×360）：TL 红 / TR 绿 / BL 蓝 / BR 黄。
 * 四个角颜色都不同，任何"上下颠倒 / 左右镜像"的几何错误都会立刻在像素上现形。
 */
export function makeQuad(ffmpeg, work) {
  const file = path.join(work, 'quad.png')
  spawnCapture(ffmpeg, [
    '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1',
    '-vf',
    'drawbox=x=0:y=0:w=320:h=180:c=red:t=fill,drawbox=x=320:y=0:w=320:h=180:c=lime:t=fill,' +
      'drawbox=x=0:y=180:w=320:h=180:c=blue:t=fill,drawbox=x=320:y=180:w=320:h=180:c=yellow:t=fill',
    '-frames:v', '1', file
  ], { tag: 'quad' })
  return file
}

/** 取一个像素 `[r,g,b]`（拿不到时返回空数组，调用方按 NaN 处理） */
export function readPixel(ffmpeg, file, x, y, work) {
  const tmp = path.join(work, `px_${x}_${y}_${Math.random().toString(36).slice(2)}.raw`)
  spawnCapture(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', tmp
  ], { tag: 'px' })
  if (!fs.existsSync(tmp)) return []
  const buf = fs.readFileSync(tmp)
  return [buf[0], buf[1], buf[2]]
}

/** 取一整行的亮度（用来判"虚线是不是真的有断口"） */
export function readLumaRow(ffmpeg, file, y, width, work) {
  const tmp = path.join(work, `row_${y}_${Math.random().toString(36).slice(2)}.raw`)
  spawnCapture(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `format=rgb24,crop=${width}:1:0:${y}`, '-frames:v', '1', '-f', 'rawvideo', tmp
  ], { tag: 'row' })
  if (!fs.existsSync(tmp)) return []
  const buf = fs.readFileSync(tmp)
  const out = []
  for (let x = 0; x < width; x++) out.push(buf[x * 3])
  return out
}

/**
 * 渲一段只含一个片段的成片。
 *
 * @param {object} opts
 * @param {string} opts.ffmpeg      ffmpeg 路径
 * @param {string} opts.work        工作目录
 * @param {string} opts.src         素材路径
 * @param {object} opts.clipFx      片段 effects
 * @param {number} [opts.scale]     片段缩放（100 = 铺满画布）
 * @param {string} opts.name        输出文件名
 * @returns {Promise<string>} 成片路径（失败时返回空串）
 */
export async function renderCase({ ffmpeg, work, src, clipFx = {}, scale = 100, name }) {
  const out = path.join(work, `${name}.mp4`)
  const result = await render.render({
    clips: [{
      id: 'c1', track: 'video', kind: 'image', path: src, url: '',
      start: 0, duration: 1, offset: 0, sourceDuration: 1, scale, effects: clipFx
    }],
    options: { width: 640, height: 360, fps: 10, aspect: '16:9', quality: 95 },
    outPath: out
  })
  return result && result.ok ? out : ''
}

/** 主流程（纯算术）：buildPlan 的滤镜图里有没有某一段 */
export function planFilter({ src, clipFx, scale = 100, work }) {
  const plan = render.buildPlan({
    clips: [{
      id: 'c1', track: 'video', kind: 'image', path: src, url: '',
      start: 0, duration: 1, offset: 0, sourceDuration: 1, scale, effects: clipFx
    }],
    streamInfo: {},
    outPath: path.join(work, 'plan.mp4'),
    options: { width: 640, height: 360, fps: 10, aspect: '16:9', quality: 95 },
    assumeVideoAudio: false,
    backdrop: '',
    ffmpegPath: ''
  })
  const args = plan && plan.args ? plan.args : []
  const at = args.indexOf('-filter_complex')
  return at >= 0 ? String(args[at + 1] || '') : ''
}

/** 颜色接近判定（编码 + 4:2:0 取整都有误差，别用等号） */
export function near(rgb, target, tol = 26) {
  if (!rgb || rgb.length < 3) return false
  return Math.abs(rgb[0] - target[0]) <= tol && Math.abs(rgb[1] - target[1]) <= tol && Math.abs(rgb[2] - target[2]) <= tol
}
