/**
 * 生成人物特效闸门用的夹具：`tools/fixtures/facefx-move.mp4`。
 *
 * 为什么不能"手边有什么就用什么"：这份夹具的**唯一职责**是验证
 * 「人脸框跟着人走」这条链路（识别 → 预览跟随 → 成片跟随）。而检测器
 * 对脸的**像素尺寸**有下限 —— 上一版把 820×1024 的整张人像塞进 1280×720
 * 画面，脸只剩 60px 宽，缩到检测用的 640 边后约 36px，MediaPipe 一帧都
 * 检不出来，于是三条断言全红，而真正的代码是对的。
 *
 * 所以这里做两件确定性的事：
 *   ① 裁掉下半身（crop 820×560），把脸放大到约占画面宽度 22%；
 *   ② 既左→右平移（overlay 的 x 带 t），让"两个时刻位置不同"可断言。
 *
 * 源图 `tools/fixtures/portrait.jpg` 随仓库入库；本脚本保证产物可重建：
 *   node tools/gen-facefx-fixture.mjs
 *
 * ⚠️ 夹具只在 `tools/fixtures/` 下，不进安装包（`extraResources` 不含它）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(HERE, 'fixtures', 'portrait.jpg')
const OUT = path.join(HERE, 'fixtures', 'facefx-move.mp4')

/** ffmpeg 定位：先看 FFMPEG_PATH，再退到 PATH 上那个（本机 PATH 通常没有） */
function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH
  const r = spawnCapture(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'])
  const first = String(r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && fs.existsSync(s))
  return first || ''
}

const FFMPEG = findFfmpeg()
if (!FFMPEG) {
  console.error('找不到 ffmpeg —— 设 FFMPEG_PATH 或把 ffmpeg 放进 PATH')
  process.exit(2)
}
if (!fs.existsSync(SRC)) {
  console.error(`缺源图：${path.relative(ROOT, SRC)}`)
  process.exit(2)
}

/* 3 秒 / 25fps / 1280×720。人像裁到 820×560 后缩到 1045 宽（高 714，几乎满帧），
   x 从 40 匀速移到 40+160×3 = 520 —— 位移 480px，远超"两个时刻差 60px"的门槛。 */
const args = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x111111:s=1280x720:r=25:d=3',
  '-i',
  SRC,
  '-filter_complex',
  "[1:v]crop=820:560:0:0,scale=1045:-1[p];[0:v][p]overlay=x='40+160*t':y=(H-h)/2",
  '-t',
  '3',
  '-c:v',
  'libx264',
  '-preset',
  'medium',
  '-pix_fmt',
  'yuv420p',
  '-y',
  OUT
]

const r = spawnCapture(FFMPEG, args, { cwd: ROOT, timeout: 180000, tag: 'ffx' })
if (r.status !== 0) {
  console.error(`ffmpeg 失败（退出码 ${r.status}）：\n${String(r.stdout || '').slice(0, 800)}`)
  process.exit(1)
}

/* 自证：产物必须真的有 75 帧。上一版就是"生成了但只有 1 帧"
   （overlay 的 shortest=1 让输出跟着静态图那一帧结束），
   而 E2E 里表现为"识别跑完但一帧都没有"，看着像检测器坏了。 */
const probe = spawnCapture(
  FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, 'ffprobe')),
  ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=nb_frames,width,height', '-of', 'csv=p=0', OUT],
  { cwd: ROOT, timeout: 60000, tag: 'probe' }
)
const kb = Math.round(fs.statSync(OUT).size / 1024)
console.log(`产出 ${path.relative(ROOT, OUT)}（${kb} kB）`)
console.log(`  流信息：${String(probe.stdout || '').trim() || '(ffprobe 读不到)'}`)
if (!/75/.test(String(probe.stdout || ''))) {
  console.error('帧数不是 75 —— 时长或 fps 不对，夹具不可用')
  process.exit(1)
}
