/**
 * 取景底片 —— **Node 侧唯一入口**（从本地素材包读，不解压到磁盘）。
 *
 * 底片的真源是 `tools/thumb-bases/frames.yjpack`（一个本地素材包，清单 + 4 张真实画面）。
 * 以前是两张散图 `base-a.png` / `base-b.png`，闸门与生成脚本各自 `path.join(...)` 拼路径 ——
 * 一旦换底片，得同时改五六处，漏一处就是"某个闸门还在拿三年前的老图对比"，
 * 而且看不出任何异常（图还在、能读、能跑）。
 *
 * 现在所有消费方都从这里取：
 *   · `frames()`      → `{ a: Buffer, b: Buffer, ... }`
 *   · `writeBase()`   → 把某一张解到临时文件，给 ffmpeg / Electron 这种只吃路径的工具用
 *
 * Python 侧同源模块见 `tools/thumb_base.py`（生成器与特效素材包都用它）。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { readZip } = require(path.join(ROOT, 'packages/desktop/src/main/zip.js'))

export const PACK = path.join(ROOT, 'tools', 'thumb-bases', 'frames.yjpack')

let cache = null

/** 包里全部底片：`{ which: Buffer }` */
export function frames() {
  if (cache) return cache
  if (!fs.existsSync(PACK)) {
    throw new Error(`缺少取景素材包：${PACK}\n先跑 \`python tools/gen-thumb-pack.py\``)
  }
  const entries = readZip(PACK)
  const byName = new Map(entries.map((e) => [e.name, e.data]))
  const manifestRaw = byName.get('manifest.json')
  if (!manifestRaw) throw new Error(`素材包缺清单：${PACK}`)
  const manifest = JSON.parse(manifestRaw.toString('utf8'))
  if (manifest.role !== 'thumb-base') {
    throw new Error(`素材包用途不对：role=${JSON.stringify(manifest.role)}，应为 thumb-base`)
  }
  const table = {}
  for (const item of manifest.items || []) {
    const data = byName.get(item.file)
    if (!data) throw new Error(`素材包清单指向的文件不存在：${item.file}`)
    table[item.which] = data
  }
  for (const need of ['a', 'b']) {
    if (!table[need]) throw new Error(`素材包里缺少底片：${need}`)
  }
  cache = table
  return table
}

/** 解出一张底片到磁盘（缓存到 %TEMP%，同一个 which 只写一次），返回路径 */
export function writeBase(which = 'a', destDir = path.join(os.tmpdir(), 'yjai-thumb-base')) {
  const table = frames()
  const data = table[which]
  if (!data) throw new Error(`素材包里没有 which=${which} 的底片`)
  fs.mkdirSync(destDir, { recursive: true })
  const out = path.join(destDir, `${which}.png`)
  if (!fs.existsSync(out) || fs.statSync(out).size !== data.length) fs.writeFileSync(out, data)
  return out
}
