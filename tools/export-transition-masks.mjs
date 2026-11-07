/**
 * 把每个 geo 转场的**外观矩阵**导出成二进制，给缩略图生成器（Python）用。
 *
 * 为什么要导出而不是让 Python 也算一遍：遮罩的数学只能有一份。
 * 预览（CSS）与导出（ffmpeg expr）已经在 `shared/transitionMask.js` 里同源，
 * 缩略图是第三个消费方 —— 如果 Python 里再抄一遍 `fieldAt`，就是三份实现，
 * 改参数时必然漏掉一份，而漏掉的那份画出来的缩略图**看着很正常**。
 *
 * 导的是 `appearanceAt()` 的两路权重（不是单张遮罩）：
 *   平面 0 = b（后一段的权重）
 *   平面 1 = t（中间色的权重，只有闪黑/闪白那一族非零）
 *   前一段的权重 = 1 - b - t，不用存。
 * 单张遮罩表达不了"闪白"：它中点要经过一个纯色，而纯色是第三段权重。
 *
 * 输出（stdout，二进制）：
 *   magic  'TXM2'
 *   uint32 条目数 N
 *   每条：uint8 键名长度 + 键名(utf8) + uint16 边长 + uint8 中间色(tint×255)
 *         + 边长² 字节 b + 边长² 字节 t
 *
 * 中间色单独一个字节而不是并进矩阵：光带族的 tint 在整幅是常数，只有权重在变。
 *
 * 进度取 0.38 而不是 0.5：0.5 时"线性进度"和"加速/减速"两种曲线**遮罩完全一样**
 * （只有时间曲线不同），缩略图就分不出「向右」和「快速向右」——
 * 实测这两张在 p=0.5 时逐像素相同。取 0.38 之后覆盖率分别是 38% / 58%，一眼可辨。
 * 同样地，光带（扫光/光束）在 0.5 时正好压在画面正中，取 0.38 才看得出它偏着。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { appearanceAt } = require(path.join(ROOT, 'packages/desktop/src/shared/transitionMask.js'))

const SIZE = 64
const PROGRESS = 0.38
const CELLS = SIZE * SIZE

const looks = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/desktop/src/shared/looks.json'), 'utf8'))
const items = (looks.transitions || []).filter((t) => t.geo)

const parts = [Buffer.from('TXM2', 'ascii')]
const count = Buffer.alloc(4)
count.writeUInt32LE(items.length, 0)
parts.push(count)

const q8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)

for (const item of items) {
  const key = Buffer.from(item.key, 'utf8')
  parts.push(Buffer.from([key.length]))
  parts.push(key)
  const dim = Buffer.alloc(2)
  dim.writeUInt16LE(SIZE, 0)
  parts.push(dim)
  parts.push(Buffer.from([q8(item.geo.tint || 0)]))
  const wb = Buffer.alloc(CELLS)
  const wt = Buffer.alloc(CELLS)
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const w = appearanceAt(item.geo, (x + 0.5) / SIZE, (y + 0.5) / SIZE, PROGRESS)
      wb[y * SIZE + x] = q8(w.b)
      wt[y * SIZE + x] = q8(w.t)
    }
  }
  parts.push(wb)
  parts.push(wt)
}

process.stdout.write(Buffer.concat(parts))
