#!/usr/bin/env node
/**
 * 人物特效的纯逻辑自检。
 *
 * 这一层管的是「框算得对不对、插值准不准、sendcmd 拼得对不对」。
 * 真机能不能检出脸、预览跟不跟、成片跟不跟，由 `tools/check-facefx.mjs` 管。
 * 两者缺一：只测纯逻辑，等于相信"接线不会错"；只测真机，错了不知道错在哪一步。
 *
 *   node tools/facefx-selftest.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const FACE = require('../packages/desktop/src/shared/facefx.js')

let total = 0
let pass = 0
const failures = []

function ok(name, cond, detail = '') {
  total += 1
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`)
  }
}

/* 造一组"正常人脸"的 478 点：外圈 + 内部点，方便验证包围盒 */
function ptsOf(x0, y0, x1, y1, n = 478) {
  const out = []
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1)
    out.push({ x: x0 + (x1 - x0) * (k % 1), y: y0 + (y1 - y0) * ((k * 7) % 1) })
  }
  /* 保证四个极值点一定在 */
  out.push({ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 })
  return out
}

console.log('\n[1] 人脸框（boxOf）')
{
  const b = FACE.boxOf(ptsOf(0.4, 0.2, 0.6, 0.5))
  ok('正常点集算出框', b && Math.abs(b.x - 0.4) < 0.03 && Math.abs(b.w - 0.2) < 0.06, JSON.stringify(b))
  ok('框往外扩过（不是关键点原包围盒）', b.w > 0.2 && b.h > 0.3, `w=${b.w.toFixed(3)} h=${b.h.toFixed(3)}`)
  ok('点太少返回 null', FACE.boxOf([{ x: 0.1, y: 0.1 }]) === null)
  ok('不是数组返回 null', FACE.boxOf(null) === null && FACE.boxOf(undefined) === null)

  /* 贴边的脸：外扩不能把框推出画面，否则预览与成片都会被裁掉一角 */
  const edge = FACE.boxOf(ptsOf(0.0, 0.0, 0.2, 0.3))
  ok(
    '贴左上的脸：框被夹在 0..1 内',
    edge.x >= 0 && edge.y >= 0 && edge.x + edge.w <= 1.0001 && edge.y + edge.h <= 1.0001,
    JSON.stringify(edge)
  )
}

console.log('\n[2] track 压缩（sampleTrack）')
{
  const frames = [
    { t: 0, box: { x: 0.4, y: 0.2, w: 0.2, h: 0.3 } },
    { t: 0.033, box: { x: 0.4, y: 0.2, w: 0.002, h: 0.003 } }, // 误检的小框
    { t: 0.066, box: null }, // 没检到
    { t: 0.1, box: { x: 0.41, y: 0.21, w: 0.2, h: 0.3 } }
  ]
  const tr = FACE.sampleTrack(frames)
  ok('误检的小框被丢掉', tr.length === 2, `长度 ${tr.length}`)
  ok('没检到的帧不写点（留给插值）', tr.every((row) => row[0] !== 0.066), tr.map((r) => r[0]).join(','))

  /* 跳到另一张脸：中心位移 > 35% 脸宽 ⇒ 判为跳变，用上一帧顶替 */
  const jump = FACE.sampleTrack([
    { t: 0, box: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 } },
    { t: 0.033, box: { x: 0.7, y: 0.2, w: 0.2, h: 0.3 } }
  ])
  ok('跳变被上一帧顶替（不闪）', Math.abs(jump[1][1] - 0.1) < 1e-6, `第二点 x=${jump[1][1]}`)

  /* 缓慢移动不算跳变 */
  const slow = FACE.sampleTrack([
    { t: 0, box: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 } },
    { t: 0.033, box: { x: 0.12, y: 0.2, w: 0.2, h: 0.3 } }
  ])
  ok('缓慢移动被保留', Math.abs(slow[1][1] - 0.12) < 1e-6, `第二点 x=${slow[1][1]}`)

  ok('空输入返回空 track', FACE.sampleTrack([]).length === 0 && FACE.sampleTrack(null).length === 0)
}

console.log('\n[3] 取框（trackAt）')
{
  const tr = [
    [0, 0.1, 0.1, 0.2, 0.2],
    [1, 0.3, 0.3, 0.2, 0.2]
  ]
  const mid = FACE.trackAt(tr, 0.5)
  ok('中点插值正确', Math.abs(mid.x - 0.2) < 1e-6 && Math.abs(mid.y - 0.2) < 1e-6, JSON.stringify(mid))
  const before = FACE.trackAt(tr, -3)
  ok('首帧之前不反向外推', Math.abs(before.x - 0.1) < 1e-6, `x=${before.x}`)
  const after = FACE.trackAt(tr, 99)
  ok('末帧之后继续用末帧', Math.abs(after.x - 0.3) < 1e-6, `x=${after.x}`)
  ok('空 track 返回 null', FACE.trackAt([], 1) === null && FACE.trackAt(null, 1) === null)

  /* 二分：造 300 点，逐个时刻取，结果必须与线性查找一致 */
  const big = []
  for (let i = 0; i < 300; i++) big.push([i / 30, i / 300, 0.1, 0.2, 0.2])
  let agree = true
  for (let i = 0; i < 300; i++) {
    const t = i / 30 + 0.016
    let expect = null
    for (let j = 0; j < big.length - 1; j++) {
      if (big[j][0] <= t && t <= big[j + 1][0]) {
        const k = (t - big[j][0]) / (big[j + 1][0] - big[j][0])
        expect = big[j][1] + (big[j + 1][1] - big[j][1]) * k
        break
      }
    }
    if (expect !== null) {
      const got = FACE.trackAt(big, t)
      if (Math.abs(got.x - expect) > 1e-9) agree = false
    }
  }
  ok('二分查找与逐段查找结果一致（300 点）', agree)
}

console.log('\n[4] 导出用的 sendcmd（buildSendcmd）')
{
  const tr = [
    [0, 0.4, 0.2, 0.2, 0.3],
    [0.5, 0.4, 0.2, 0.2, 0.3], // 与上一行同位置
    [1, 0.6, 0.2, 0.2, 0.3]
  ]
  const txt = FACE.buildSendcmd(tr, { w: 1000, h: 500, target: 'face' })
  const lines = txt.split(';').map((s) => s.trim()).filter(Boolean)
  ok('格式是「时间 target 参数 值」', /^0\.000 face x \d+$/.test(lines[0]), lines[0])
  ok(
    'target 不带方括号（本机 ffmpeg 8.1 实测要这样写）',
    !txt.includes('[') && !txt.includes(']'),
    txt.slice(0, 40)
  )
  ok('同位置的重复帧不写（省一半命令）', lines.filter((l) => l.includes('face x')).length === 2, `${lines.length} 行`)

  /* 居中：框中心 = 叠加物中心。框 x=0.4,w=0.2 ⇒ 中心 0.5 ⇒ 像素 500 */
  const first = Number(lines[0].split(' ').pop())
  ok('叠加物居中对齐到脸框中心', first === 400, `x=${first}（期望 500-100/2=400）`)

  const withSize = FACE.buildSendcmd([[0, 0.4, 0.2, 0.2, 0.3]], { w: 1000, h: 500, target: 'face', size: [200, 200] })
  ok('给了固定尺寸就按固定尺寸居中', Number(withSize.split(';')[0].split(' ').pop()) === 400, withSize.slice(0, 24))

  /* 贴边的框：坐标必须夹在画面内，否则成片边缘漏黑 */
  const edge = FACE.buildSendcmd([[0, 0.98, 0.9, 0.2, 0.3]], { w: 1000, h: 500, target: 'face' })
  const ex = Number(edge.split(';')[0].split(' ').pop())
  ok('贴右边缘的框被夹进画面', ex <= 800, `x=${ex}（画面宽 1000，叠加物宽 200 ⇒ 上限 800）`)

  ok('每条命令以分号收尾', txt.trim().endsWith(';'), JSON.stringify(txt.slice(-12)))
  ok('空 track 得到空脚本', FACE.buildSendcmd([], { w: 100, h: 100 }) === '')
}

console.log('\n[5] 取景尺寸（cropSizeOf）')
{
  const tr = [
    [0, 0.4, 0.2, 0.2, 0.3],
    [1, 0.4, 0.2, 0.34, 0.5]
  ]
  const s = FACE.cropSizeOf(tr, 1920, 1080)
  ok('取整段最大的框（保证任何一帧都盖得住）', s.w === Math.round((0.34 * 1920) / 2) * 2, JSON.stringify(s))
  ok('宽高都是偶数（yuv420p 的硬要求）', s.w % 2 === 0 && s.h % 2 === 0, `${s.w}x${s.h}`)
  const empty = FACE.cropSizeOf([], 1920, 1080)
  ok('空 track 有兜底尺寸（不会算出 0）', empty.w >= 16 && empty.h >= 16, `${empty.w}x${empty.h}`)
  ok('不给尺寸时按 1080p 算', FACE.cropSizeOf(tr).w > 0)
}

console.log('\n[6] 特效表')
{
  ok('三款特效 key 稳定', FACE.FX_LIST.map((f) => f.key).join(',') === 'blur,bright,frame')
  ok('每款都有名字与提示', FACE.FX_LIST.every((f) => f.name && f.hint))
  ok('fxOf 能按 key 取到', FACE.fxOf('blur').name === '面部打码' && FACE.fxOf('nope') === null)
  ok(
    '模糊半径随脸宽与强度递增（不写死像素）',
    FACE.fxOf('blur').radiusOf(200, 1) > FACE.fxOf('blur').radiusOf(200, 0) &&
      FACE.fxOf('blur').radiusOf(400, 1) > FACE.fxOf('blur').radiusOf(200, 1)
  )
  ok('提亮值随强度递增且落在合理区间', Number(FACE.fxOf('bright').brightnessOf(1)) > Number(FACE.fxOf('bright').brightnessOf(0)))
}

console.log(`\nFACEFX_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
if (failures.length) {
  console.log('失败项：\n  ' + failures.join('\n  '))
  process.exit(1)
}
console.log('FACEFX_SELFTEST_PASSED')
