#!/usr/bin/env node
/**
 * 画面层级（自由层级）闸门。
 *
 * 这一块的错**全都不报错**，而且两头都可能错：
 *   ① 层号只落在数据里、预览不按它排 —— 点「上移一层」，时间线上层号变了、画面没变；
 *   ② 预览按层号排、导出不按 —— 预览里 A 压住 B，成片里 B 压住 A（两边单独看都合理）；
 *   ③ 「上移一层」实现成 `z += 1` —— 两段本来就同 z 时点了毫无反应，
 *      用户看到的是"这个按钮是坏的"，而代码路径完全跑通了；
 *   ④ 老草稿没有 z：缺省值处理错会让**所有历史项目的层叠顺序整体变掉**
 *      （原来是"起点靠后的在上"，改完之后全按 id 排）。
 *
 * 所以判据分三层：纯算术（shared/layers.js）+ 预览排序（composite.layerOrder）+
 * **真跑 ffmpeg 读中心像素**（成片里到底谁压住谁）。
 *
 * 用法：node tools/check-layer-order.mjs
 * 退出码：0 = 通过；1 = 有失败；2 = 本机没有 ffmpeg（如实报，不假绿）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'
import { compositeAt, layerOrder } from '../packages/desktop/src/renderer/composite.js'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = path.join(ROOT, 'packages', 'desktop', 'src', 'shared')
const layers = require(path.join(SHARED, 'layers.js'))
const render = require(path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js'))

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? `  —— ${detail}` : ''}`)
  } else {
    fail += 1
    problems.push(label)
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const order = (list) => list.map((clip) => clip.id).join(',')

/* ------------------------------ 夹具 ------------------------------ */

const mk = (id, extra = {}) => ({
  id,
  track: 'overlay',
  kind: 'video',
  path: `${id}.mp4`,
  url: `yjai-media://${id}`,
  start: 0,
  duration: 2,
  offset: 0,
  sourceDuration: 4,
  name: id,
  ...extra
})

/* ---------------------- ① 层号规格 ---------------------- */

console.log('\n=== ① 层号规格：缺省 / 夹取 / 脏数据 ===')

check('没写层号 ⇒ 0（老草稿不动一个字段）', layers.readZ(mk('a')) === 0)
check('null 片段 ⇒ 0 且不抛', layers.readZ(null) === 0)
check('NaN ⇒ 0（否则比较器结果变成随机，顺序偶尔不一样）', layers.readZ({ z: Number.NaN }) === 0)
check('Infinity ⇒ 夹到上限', layers.readZ({ z: Number.POSITIVE_INFINITY }) === layers.Z_LIMIT)
check('-Infinity ⇒ 夹到下限', layers.readZ({ z: Number.NEGATIVE_INFINITY }) === -layers.Z_LIMIT)
check('小数取整（1.6 → 2）', layers.readZ({ z: 1.6 }) === 2)
check('超大值夹进上限（999 → 20）', layers.readZ({ z: 999 }) === layers.Z_LIMIT)
check('负层号合法（-3 原样）', layers.readZ({ z: -3 }) === -3)

/* ---------------------- ② 比较器：新规则 + 老规则都要在 ---------------------- */

console.log('\n=== ② 比较器：z 优先，缺省时退回旧规则（起点 → 创建序号） ===')

const A = mk('clip_a_1', { z: 5, start: 0 })
const B = mk('clip_b_2', { z: 0, start: 3 })
check('z 大的在上：即使它起点更早', layers.compareLayers(A, B) > 0)
check('反过来比较是负数（比较器对称）', layers.compareLayers(B, A) < 0)
check('同 z ⇒ 起点靠后的在上（旧规则原样保留）', layers.compareLayers(mk('x_1', { start: 2 }), mk('y_2', { start: 1 })) > 0)
check(
  '同 z 同起点 ⇒ 按创建序号（_2 不能排到 _10 前面）',
  layers.compareLayers(mk('c_10'), mk('c_2')) > 0,
  `${order([mk('c_10'), mk('c_2')].sort(layers.compareLayers))}`
)
check(
  '两个完全重叠的片段：缺省 z 时的顺序与改动前逐帧一致',
  order([mk('p_9', { start: 1.5 }), mk('p_3', { start: 1.5 })].sort(layers.compareLayers)) === 'p_3,p_9'
)
check('layerStack 只取该轨（叠加轨与视频轨互不干扰）',
  layers.layerStack([mk('o1', { z: 1 }), { ...mk('v1'), track: 'video' }, mk('o2', { z: 0 })], 'overlay').join(',') === 'o2,o1')

/* ---------------------- ③ 上移 / 下移 ---------------------- */

console.log('\n=== ③ 上移 / 下移：重新编号（不是 z += 1） ===')

const three = [mk('l1'), mk('l2'), mk('l3')]
const up = layers.moveLayer(three, 'l1', 1)
check('上移一层：只给"层号真的变了"的片段打补丁（l2 本来就在 0 不用写；l3 必须抬到 2，否则它会沉到 l2 下面去）',
  JSON.stringify(up) === JSON.stringify([{ id: 'l1', z: 1 }, { id: 'l3', z: 2 }]), JSON.stringify(up))
check('返回的是补丁而不是整份片段表（每项只有 id 与 z 两个字段）',
  up.every((item) => Object.keys(item).length === 2 && 'id' in item && 'z' in item))
const applied = three.map((clip) => {
  const hit = up.find((item) => item.id === clip.id)
  return hit ? { ...clip, z: hit.z } : clip
})
check('打上补丁后顺序变成 l2,l1,l3', layers.layerStack(applied, 'overlay').join(',') === 'l2,l1,l3')

check('最上层再上移 ⇒ 空补丁（菜单项应当置灰）', layers.moveLayer(three, 'l3', 1).length === 0)
check('最下层再下移 ⇒ 空补丁', layers.moveLayer(three, 'l1', -1).length === 0)
check('只有一层时上下都动不了', layers.moveLayer([mk('solo')], 'solo', 1).length === 0 && layers.moveLayer([mk('solo')], 'solo', -1).length === 0)
check('片段不存在 ⇒ 空补丁且不抛', layers.moveLayer(three, 'nope', 1).length === 0)

const clamped = [mk('c1', { z: 20 }), mk('c2', { z: 20 })]
check(
  '两段同 z 时点一次也真的动（`z += 1` 那种实现在这里是静默无操作）',
  layers.layerStack(
    clamped.map((clip) => {
      const hit = layers.moveLayer(clamped, 'c1', 1).find((item) => item.id === clip.id)
      return hit ? { ...clip, z: hit.z } : clip
    }),
    'overlay'
  ).join(',') === 'c2,c1'
)
const sameZ = [mk('a', { z: 3 }), mk('b', { z: 3 }), mk('c', { z: 9 })]
const sameZPatches = layers.moveLayer(sameZ, 'a', 1)
const sameZApplied = sameZ.map((clip) => {
  const hit = sameZPatches.find((item) => item.id === clip.id)
  return hit ? { ...clip, z: hit.z } : clip
})
check('搬动后层号在轨内唯一（0..n-1，顺序从此稳定）', layers.layerStack(sameZApplied, 'overlay').join(',') === 'b,a,c',
  layers.layerStack(sameZApplied, 'overlay').join(','))
check('重新编号把原本差很远的 z 也压平（c 的 9 变成 2）', sameZApplied.find((clip) => clip.id === 'c').z === 2,
  String(sameZApplied.find((clip) => clip.id === 'c').z))

check('canMoveLayer 与 moveLayer 口径一致（最上层 false）', layers.canMoveLayer(three, 'l3', 1) === false)
check('canMoveLayer：中层上移可以', layers.canMoveLayer(three, 'l2', 1) === true)
check('canMoveLayer：别的轨互不影响', layers.canMoveLayer([mk('o1'), { ...mk('v1'), track: 'video' }], 'o1', 1) === false)

/* ---------------------- ④ 预览排序 ---------------------- */

console.log('\n=== ④ 预览排序：composite 用的是同一份比较器 ===')

const previewList = [
  { ...mk('low', { z: 0 }), start: 2 },
  { ...mk('high', { z: 4 }), start: 0 }
]
check('layerOrder 按层号排（高 z 在后 = 更靠上）', order(layerOrder(previewList)) === 'low,high')
const composed = compositeAt([{ ...mk('low'), track: 'overlay' }, { ...mk('high', { z: 4 }), track: 'overlay' }], [], 1)
check('compositeAt 的 pip 顺序同样是 low → high', composed.pip.map((item) => item.id).join(',') === 'low,high',
  composed.pip.map((item) => item.id).join(','))
check('层数据里带 z（预览组件按它画 data-layer-z）',
  composed.pip.length === 2 && composed.pip[1].z === 4 && composed.pip[0].z === 0,
  JSON.stringify(composed.pip.map((item) => item.z)))

/* ---------------------- ⑤ 真导出：成片里谁压住谁 ---------------------- */

const found = render.findFfmpeg()
if (!found || !found.ffmpeg) {
  console.log('\nLAYER_EXPORT_SKIPPED 本机没有 ffmpeg（成片侧无法验证）')
  console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
  process.exit(fail ? 1 : 2)
}
const ffmpeg = found.ffmpeg
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-layers-'))

for (const color of ['red', 'blue']) {
  spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=25`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(work, `${color}.mp4`)],
    { tag: `mk-${color}` }
  )
}
const redFile = path.join(work, 'red.mp4')
const blueFile = path.join(work, 'blue.mp4')
check('夹具生成完毕（红 / 蓝，各 2 秒）', fs.existsSync(redFile) && fs.existsSync(blueFile))

/* 底层一块灰：这样"两段画中画都没画上"时中心像素是灰的，不会与红蓝混淆 */
spawnCapture(
  ffmpeg,
  ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(work, 'base.mp4')],
  { tag: 'mk-base' }
)
const baseFile = path.join(work, 'base.mp4')

function centerPixel(file, at) {
  const out = path.join(work, `px-${path.basename(file, '.mp4')}-${at}.rgb`)
  spawnCapture(
    ffmpeg,
    ['-hide_banner', '-y', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', out],
    { tag: 'px' }
  )
  if (!fs.existsSync(out)) return null
  const buf = fs.readFileSync(out)
  const i = (4 * 8 + 4) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}

/* 画中画铺满中央 60%（锚点正中），于是"中心像素"一定同时落在两层里 */
const pipBig = { anchor: 'center', size: 60 }
const overlayRed = (z) => ({ id: 'ov_1', track: 'overlay', kind: 'video', path: redFile, start: 0, duration: 2, offset: 0, sourceDuration: 2, name: 'red', pip: pipBig, z })
const overlayBlue = (z) => ({ id: 'ov_2', track: 'overlay', kind: 'video', path: blueFile, start: 0, duration: 2, offset: 0, sourceDuration: 2, name: 'blue', pip: pipBig, z })
const baseClip = { id: 'base', track: 'video', kind: 'video', path: baseFile, start: 0, duration: 2, offset: 0, sourceDuration: 2, name: 'base' }

async function exportWith(clips, name) {
  const out = path.join(work, `${name}.mp4`)
  const result = await render.render({
    clips,
    outPath: out,
    options: { width: 320, height: 240, fps: 25 }
  })
  return { ok: result.ok === true && fs.existsSync(out), out, error: result.error }
}

const redTop = await exportWith([baseClip, overlayRed(9), overlayBlue(0)], 'red-top')
check('蓝层在下面、红层在上面：导出成功', redTop.ok, String(redTop.error || '').slice(0, 200))
const pxRed = redTop.ok ? centerPixel(redTop.out, 1) : null
check(
  '成片中心像素是红（红层 z=9 压住蓝层 z=0）',
  Boolean(pxRed) && pxRed[0] > 120 && pxRed[2] < 90 && pxRed[1] < 90,
  pxRed ? `rgb(${pxRed.join(',')})` : '读不到像素'
)

const blueTop = await exportWith([baseClip, overlayRed(0), overlayBlue(9)], 'blue-top')
check('交换层号后导出成功', blueTop.ok, String(blueTop.error || '').slice(0, 200))
const pxBlue = blueTop.ok ? centerPixel(blueTop.out, 1) : null
check(
  '成片中心像素变成蓝（同一个时间线，只改了 z）',
  Boolean(pxBlue) && pxBlue[2] > 120 && pxBlue[0] < 90 && pxBlue[1] < 90,
  pxBlue ? `rgb(${pxBlue.join(',')})` : '读不到像素'
)
check(
  '两次结果确实不同（证明颜色由层号决定，不是素材碰巧那样）',
  Boolean(pxRed && pxBlue) && (pxRed[0] !== pxBlue[0] || pxRed[2] !== pxBlue[2])
)

/* 缺省 z 的老草稿：顺序必须还是"起点靠后的在上" */
const legacyFront = await exportWith([baseClip, overlayRed(undefined), overlayBlue(undefined)], 'legacy')
const pxLegacy = legacyFront.ok ? centerPixel(legacyFront.out, 1) : null
check(
  '老草稿（没有 z 字段）仍按旧规则出片：同起点按 id 序号，ov_2 在后 ⇒ 蓝在上',
  Boolean(pxLegacy) && pxLegacy[2] > 120,
  pxLegacy ? `rgb(${pxLegacy.join(',')})` : '读不到像素'
)

/* ------------------------------ 收尾 ------------------------------ */

console.log('')
if (!fail) console.log('LAYER_ORDER_OK')
console.log(`=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('失败项：')
  for (const item of problems) console.log(`  - ${item}`)
}
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch {
  /* 删不掉就留着 */
}
process.exit(fail ? 1 : 0)
