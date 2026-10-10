/**
 * 从 .ico 里取出一帧，解码 DIB / PNG 两种编码，导出成标准 PNG。
 *
 * 为什么需要它：仓库根 `ico/` 是唯一权威 logo 来源，但里面的帧是
 * **DIB（BITMAPINFOHEADER + 32bpp BGRA，行自下而上）**，不是 PNG。
 * 直接把 .ico 丢给 `<img>` 能否渲染取决于浏览器版本；这里确定性地解出一张 PNG，
 * 让渲染层、文档、设计稿都能直接引用同一份像素。
 *
 * 只读源文件，只往 out 写。
 *
 * 用法：
 *   node tools/extract-ico-frame.mjs <src.ico> <out.png> [size]
 *   node tools/extract-ico-frame.mjs          # 默认 ico/256X256.ico → 渲染层 assets/logo-256.png
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = process.argv[2] || path.join(ROOT, 'ico', '256X256.ico')
const DST =
  process.argv[3] || path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'logo-256.png')
const WANT = Number(process.argv[4] || 256)

/* ------------------------------ ICO 容器 ------------------------------ */

function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error('不是合法的 .ico（ICONDIR 头不匹配）')
  }
  const count = buf.readUInt16LE(4)
  const frames = []
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16
    // 目录项里宽高各 1 字节，0 表示 256
    const w = buf[o] === 0 ? 256 : buf[o]
    const h = buf[o + 1] === 0 ? 256 : buf[o + 1]
    const bytes = buf.readUInt32LE(o + 8)
    const offset = buf.readUInt32LE(o + 12)
    const data = buf.subarray(offset, offset + bytes)
    const isPng = data.length > 8 && data.readUInt32BE(0) === 0x89504e47
    const isDib = !isPng && data.length >= 40 && data.readUInt32LE(0) === 40
    frames.push({ index: i, w, h, bytes, isPng, isDib, data })
  }
  return frames
}

/* --------------------------- DIB → RGBA --------------------------- */

/**
 * 解码 BITMAPINFOHEADER 位图。
 * 只处理 ico 里实际会出现的情况：32bpp（带 alpha）与 24bpp（配 AND 掩码）。
 * 返回 { w, h, rgba: Uint8Array }，rgba 为**自上而下**的 RGBA 顺序。
 */
function decodeDib(d) {
  const headerSize = d.readUInt32LE(0)
  const w = d.readInt32LE(4)
  // biHeight 为负表示自上而下；ico 里通常是正的（行自下而上）
  const rawH = d.readInt32LE(8)
  const bottomUp = rawH > 0
  const h = Math.abs(rawH) >> 1 // ico 的 DIB 把高度记成 2 倍（图 + AND 掩码）
  const planes = d.readUInt16LE(12)
  const bpp = d.readUInt16LE(14)
  const compression = d.readUInt32LE(16)
  if (planes !== 1) throw new Error(`非法 biPlanes=${planes}`)
  if (compression !== 0) throw new Error(`只支持未压缩位图，实际 biCompression=${compression}`)
  if (bpp !== 32 && bpp !== 24) throw new Error(`只支持 32/24bpp，实际 ${bpp}bpp`)

  const pixels = d.subarray(headerSize)
  // 每行按 4 字节对齐：stride = ceil(w * bpp / 32) * 4
  // ⚠️ 曾经写成 Math.floor(((w * bpp + 31) / 32) * 4) —— 那是**1bpp**的公式，
  // 对 32bpp 会算出 1028 而非 1024（每行多 4 字节），256 行累积成横向条纹。
  // 表现是"能解码、尺寸也对、但图是花的"，光看尺寸断言抓不到，必须看图。
  const srcStride = Math.ceil((w * bpp) / 32) * 4
  const rgba = new Uint8Array(w * h * 4)

  for (let y = 0; y < h; y++) {
    const srcY = bottomUp ? h - 1 - y : y
    const rowStart = srcY * srcStride
    for (let x = 0; x < w; x++) {
      const s = rowStart + x * (bpp / 8)
      const t = (y * w + x) * 4
      rgba[t] = pixels[s + 2] // R
      rgba[t + 1] = pixels[s + 1] // G
      rgba[t + 2] = pixels[s] // B
      rgba[t + 3] = bpp === 32 ? pixels[s + 3] : 255
    }
  }

  // 24bpp 没有 alpha 通道，靠 AND 掩码给透明位
  if (bpp === 24) {
    const maskStride = Math.floor(((w * 1 + 31) / 32) * 4)
    const maskStart = headerSize + srcStride * h
    for (let y = 0; y < h; y++) {
      const srcY = bottomUp ? h - 1 - y : y
      for (let x = 0; x < w; x++) {
        const byte = pixels[maskStart + srcY * maskStride + (x >> 3)]
        if (byte === undefined) continue
        if (byte & (0x80 >> (x & 7))) rgba[(y * w + x) * 4 + 3] = 0
      }
    }
  }
  return { w, h, rgba }
}

/* ------------------------------ PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 8bit RGBA（colorType=6）真彩 PNG，逐行 filter=0 */
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* -------------------------------- 主流程 -------------------------------- */

const buf = fs.readFileSync(SRC)
const frames = parseIco(buf)
console.log(`解析 ${path.relative(ROOT, SRC)}  共 ${frames.length} 帧`)
for (const f of frames) {
  console.log(
    `  #${String(f.index).padStart(2)}  ${String(f.w).padStart(4)}x${String(f.h).padEnd(4)}` +
      `  ${String(f.bytes).padStart(8)}B  ${f.isPng ? 'PNG' : f.isDib ? 'DIB' : '未知'}`
  )
}

const hit = frames.find((f) => f.w === WANT && f.h === WANT)
if (!hit) {
  console.error(`\n没有 ${WANT}x${WANT} 的帧，可用：${frames.map((f) => `${f.w}x${f.h}`).join(', ')}`)
  process.exitCode = 1
} else {
  let png
  if (hit.isDib) {
    const { w, h, rgba } = decodeDib(hit.data)
    png = encodePng(w, h, rgba)
    // 自证：解出来的尺寸必须和目录项一致，否则说明 stride/高度算错了
    if (w !== WANT || h !== WANT) {
      console.error(`\n解码尺寸 ${w}x${h} 与目录项 ${WANT}x${WANT} 不符，拒绝写出`)
      process.exitCode = 1
      png = null
    }
  } else if (hit.isPng) {
    png = hit.data
  } else {
    console.error('\n该帧既不是 DIB 也不是 PNG，无法解码')
    process.exitCode = 1
  }

  if (png) {
    fs.mkdirSync(path.dirname(DST), { recursive: true })
    fs.writeFileSync(DST, png)
    const back = fs.readFileSync(DST)
    const ok =
      back.readUInt32BE(0) === 0x89504e47 &&
      back.readUInt32BE(16) === WANT &&
      back.readUInt32BE(20) === WANT &&
      back[24] === 8 &&
      back[25] === 6
    if (!ok) {
      console.error('\n落盘后回读校验失败：不是预期的 8bit RGBA PNG 或尺寸不符')
      process.exitCode = 1
    } else {
      console.log(
        `\nICON_FRAME_OK  写出 ${path.relative(ROOT, DST)}  ${back.length}B  ${WANT}x${WANT} 8bit-RGBA`
      )
    }
  }
}
