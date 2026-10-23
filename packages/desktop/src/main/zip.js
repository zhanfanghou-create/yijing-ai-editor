'use strict'
/**
 * 最小 ZIP 编解码（store 模式，不压缩）—— 只为「素材包」服务，零依赖。
 *
 * 为什么自己写而不装一个库：
 *   · 包里装的是 mp4/jpg —— 本来就是压缩过的，再用 deflate 只是白花 CPU；
 *   · store 模式的 ZIP 结构极简（本地头 + 数据 + 中央目录 + EOCD），
 *     反而比"引一个包里带原生依赖、跨版本还要重新编译"更稳；
 *   · 产出的文件是**标准 ZIP**，资源管理器/7-Zip 双击就能打开核对（这点对排障很重要）。
 *
 * ⚠️ 两个只能靠外部验证的细节（本文件写错也照样"能读"）：
 *   ① CRC32 必须是 **IEEE 多项式 0xEDB88320** 的标准算法，写错了 7-Zip 会报「CRC 校验失败」，
 *      而我们的和解压因为不校验 CRC 完全看不出来；
 *   ② 中央目录里的 `localHeaderOffset` 必须指向**本地头起点**（不是数据起点），
 *      差 30 字节的话，我们读自己能对，别人读是乱码。
 *   所以 `tools/check-pack.mjs` 除了自读，还会用 **PowerShell 的 Expand-Archive** 真解一遍。
 */

const fs = require('node:fs')
const path = require('node:path')

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
/** 通用标志位 11：文件名用 UTF-8（中文素材名不这么标会被解成乱码） */
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0

let crcTable = null

/** 标准 IEEE CRC32 表（惰性建一次） */
function table() {
  if (crcTable) return crcTable
  const out = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    out[i] = c
  }
  crcTable = out
  return out
}

function crc32(buffer) {
  const t = table()
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = t[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** DOS 时间/日期（ZIP 只认这个两字节格式；精度 2 秒，无所谓） */
function dosTime(date) {
  const d = date instanceof Date ? date : new Date()
  const year = Math.max(1980, d.getFullYear())
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  }
}

/**
 * 写一个 ZIP。
 *
 * entries: `[{ name, data }]`（data 是 Buffer）或 `[{ name, file }]`（从磁盘读，省内存）
 * 返回 `{ bytes, entries: [name...] }` —— 顺便把真写进去的名字回出去，
 * 便于调用方核对"实际增量"，而不是拿传入的列表假装成功。
 */
function writeZip(outPath, entries, options) {
  const list = Array.isArray(entries) ? entries : []
  const stamp = dosTime(options && options.mtime)
  const chunks = []
  const central = []
  let offset = 0

  const push = (buffer) => {
    chunks.push(buffer)
    offset += buffer.length
  }

  for (const entry of list) {
    const name = String((entry && entry.name) || '').replace(/\\/g, '/')
    if (!name) continue
    const data = entry.data ? entry.data : fs.readFileSync(String(entry.file || ''))
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(METHOD_STORE, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const headerOffset = offset
    push(local)
    push(nameBuf)
    push(data)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(SIG_CENTRAL, 0)
    dir.writeUInt16LE(20, 4) // version made by
    dir.writeUInt16LE(20, 6) // version needed
    dir.writeUInt16LE(FLAG_UTF8, 8)
    dir.writeUInt16LE(METHOD_STORE, 10)
    dir.writeUInt16LE(stamp.time, 12)
    dir.writeUInt16LE(stamp.date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30) // extra len
    dir.writeUInt16LE(0, 32) // comment len
    dir.writeUInt16LE(0, 34) // disk number
    dir.writeUInt16LE(0, 36) // internal attrs
    dir.writeUInt32LE(0, 38) // external attrs
    dir.writeUInt32LE(headerOffset, 42)
    central.push(Buffer.concat([dir, nameBuf]))
  }

  const centralBuf = Buffer.concat(central)
  const centralOffset = offset
  const count = central.length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(0, 20)

  const body = Buffer.concat([...chunks, centralBuf, eocd])
  fs.writeFileSync(outPath, body)
  return { bytes: body.length, entries: list.map((item) => String(item.name || '').replace(/\\/g, '/')) }
}

/** 从尾部往前找 EOCD（注释长度未知，只能扫） */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 读一个 ZIP。返回 `[{ name, data, size }]`。
 *
 * 只用中央目录（本地头里的长度字段在"带数据描述符"的文件里可能是 0，
 * 而中央目录里的值一定是对的）。
 */
function readZip(filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.length < 22) throw new Error('不是有效的 zip（文件太小）')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录结尾）')
  const count = buf.readUInt16LE(eocd + 10)
  const dirOffset = buf.readUInt32LE(eocd + 16)

  const out = []
  let cursor = dirOffset
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL) throw new Error('中央目录损坏')
    const method = buf.readUInt16LE(cursor + 10)
    const compSize = buf.readUInt32LE(cursor + 20)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    cursor += 46 + nameLen + extraLen + commentLen

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`本地头损坏：${name}`)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    /* 不收 deflate：我们自己只写 store。外人手工改过的包直接如实报错，
       而不是"解出一段看起来像 JSON 的乱码"（更难查）。 */
    if (method !== METHOD_STORE) throw new Error(`不支持的压缩方式 ${method}：${name}`)
    out.push({ name, data: Buffer.from(raw), size: raw.length })
  }
  return out
}

/** 把 zip 解到目录（只写普通文件；带 `..` 的条目一律拒绝 —— zip-slip） */
function extractZip(filePath, outDir) {
  const root = path.resolve(outDir)
  const written = []
  for (const entry of readZip(filePath)) {
    const target = path.resolve(root, entry.name)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`包内路径越界（拒绝解压）：${entry.name}`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
    written.push(entry.name)
  }
  return written
}

module.exports = { crc32, writeZip, readZip, extractZip }
