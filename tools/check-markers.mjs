#!/usr/bin/env node
/**
 * 闸门 · 时间线标记（用户标记）的纯逻辑。
 *
 * 标记是那种"看着最简单、错了最难发现"的功能：
 *   · 不排序 → 「上一个 / 下一个标记」会跳反，用户以为按钮接错了；
 *   · 不去重 → 同一处叠两个点，视觉上是一个，跳的时候要按两次（像卡住）；
 *   · 阈值各写一份 → 在标记上再点一次删不掉（面板 0.12、App 0.2，两边不一致）；
 *   · 跳转用"最近的一个" → 播放头正压在标记上时，按一下原地不动。
 *
 * 四种坏法都**不报错**、界面也照样画得出来，所以只能拿数字测。
 *
 * 用法：node tools/check-markers.mjs
 * 退出码：0 = 通过；1 = 有失败。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
const problems = []
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    problems.push(label)
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  —— ${detail}`}`)
  }
}

/* markers.js 是 ESM（渲染层模块）。⚠️ Windows 下 `import()` 不接受裸盘符路径
   （会报 ERR_UNSUPPORTED_ESM_URL_SCHEME），必须转成 file:// URL 再导入。 */
const markers = await import(pathToFileURL(path.join(root, 'packages/desktop/src/renderer/markers.js')).href)
const { MARKER_MERGE_SECONDS, markerIndexAt, normalizeMarkers, stepMarker } = markers

console.log('\n== 一、规范化：排序 / 去重 / 过滤脏值 ==\n')

{
  check('乱序输入被排成升序', JSON.stringify(normalizeMarkers([12, 3, 7])) === JSON.stringify([3, 7, 12]))
  check(
    '过近的两个点被合并（0.05 秒 < 阈值）',
    normalizeMarkers([5, 5 + MARKER_MERGE_SECONDS / 2]).length === 1,
    JSON.stringify(normalizeMarkers([5, 5 + MARKER_MERGE_SECONDS / 2]))
  )
  check(
    '刚好超过阈值的两个点都留着',
    normalizeMarkers([5, 5 + MARKER_MERGE_SECONDS * 2]).length === 2
  )
  check('负数被丢掉（不然会得到一个永远到不了的标记）', normalizeMarkers([-1, 2]).length === 1)
  check('非数字被丢掉（settings 里什么脏数据都可能）', normalizeMarkers(['abc', null, undefined, 4]).length === 1)
  check('不是数组时返回空数组（不抛异常）', normalizeMarkers(null).length === 0 && normalizeMarkers({}).length === 0)
  check('已经是规范的不变长（幂等）', JSON.stringify(normalizeMarkers([1, 2, 3])) === JSON.stringify([1, 2, 3]))
}

console.log('\n== 二、命中判定：在标记上再点一次要能取消 ==\n')

{
  const list = normalizeMarkers([3, 8])
  check('正压在上面 → 命中', markerIndexAt(list, 8) === 1)
  check('差半帧 → 仍然命中（手抖也能删）', markerIndexAt(list, 8 + MARKER_MERGE_SECONDS * 0.5) === 1)
  check('差一个阈值以上 → 不命中（会在旁边打新点）', markerIndexAt(list, 8 + MARKER_MERGE_SECONDS * 3) === -1)
  check('空列表 → 不命中', markerIndexAt([], 8) === -1)
  check('非法输入 → 不命中（不是抛异常）', markerIndexAt(list, NaN) === -1)
}

console.log('\n== 三、跳转：严格大于/小于，不是"最近的一个" ==\n')

{
  const list = normalizeMarkers([3, 8, 20])
  check('播放头 0 → 下一个是 3', stepMarker(list, 0, 1) === 3)
  check('播放头 5 → 下一个是 8（跳过已经过去的）', stepMarker(list, 5, 1) === 8)
  /* 这一条是重点：压在标记上时必须往后走，否则连按两下原地不动 */
  check('播放头正压在 8 上 → 下一个是 20（不是它自己）', stepMarker(list, 8, 1) === 20)
  check('播放头正压在 8 上 → 上一个是 3', stepMarker(list, 8, -1) === 3)
  check('末尾之后没有下一个 → null（调用方保持原位）', stepMarker(list, 99, 1) === null)
  check('开头之前没有上一个 → null', stepMarker(list, 0, -1) === null)
  check('空列表 → null', stepMarker([], 5, 1) === null)
}

console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
if (fail) {
  console.log('MARKERS_FAILED')
  for (const item of problems) console.log(`  - ${item}`)
  process.exit(1)
}
console.log('MARKERS_OK')
process.exit(0)
