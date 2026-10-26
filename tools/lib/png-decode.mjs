/**
 * 极简 PNG 解码器：只做「把文件读成 8bit RGBA 像素」这一件事。
 *
 * 为什么不用现成的：本仓库的闸门一律零依赖（不能假设装了 sharp/pngjs），
 * 而 python 那套 `tools/png-*.py` 要 Pillow、且每次起进程。
 *
 * 只支持**真实产物里会出现**的形态，遇到别的就明确抛错，绝不静默给空图：
 *   - 位深 8（Pillow / 浏览器截图都是 8bit）
 *   - 颜色类型 0 灰度 / 2 真彩 / 4 灰度+alpha / 6 真彩+alpha
 *   - 全部五种行过滤器（0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth）
 *   - 非隔行
 * 不支持（直接抛）：16bit、调色板、隔行、APNG 附加块。
 *
 * ⚠️ 调色板（colorType=3）故意不实现：如果哪天产物变成调色板 PNG，
 * 这里会抛错并让闸门红 —— 比"猜着解码、颜色全错、却宣布一致"安全得多。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** 读 PNG → { w, h, colorType, bitDepth, rgba: Uint8Array } */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG（签名不匹配）')
  }
  let off = 8
  let ihdr = null
  const idat = []
  for (;;) {
    if (off + 8 > buf.length) throw new Error('PNG 结构被截断（缺 IEND）')
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      ihdr = {
        w: body.readUInt32BE(0),
        h: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12]
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (!ihdr) throw new Error('PNG 缺 IHDR')
  if (ihdr.bitDepth !== 8) throw new Error(`只支持 8bit PNG，实际 ${ihdr.bitDepth}bit`)
  if (ihdr.interlace !== 0) throw new Error('不支持隔行 PNG')
  const ch = CHANNELS[ihdr.colorType]
  if (!ch) throw new Error(`不支持的颜色类型 ${ihdr.colorType}（调色板 PNG 需先转真彩）`)
  if (!idat.length) throw new Error('PNG 没有 IDAT 数据')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const { w, h } = ihdr
  const stride = w * ch
  const expectLen = (stride + 1) * h
  if (raw.length !== expectLen) {
    throw new Error(`解压后字节数不符：期望 ${expectLen}，实际 ${raw.length}`)
  }

  const px = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]
      // a = 左邻，b = 上邻，c = 左上邻；越界一律当 0（PNG 规范如此）
      const a = x >= ch ? px[dst + x - ch] : 0
      const b = y > 0 ? px[up + x] : 0
      const c = y > 0 && x >= ch ? px[up + x - ch] : 0
      let out
      switch (filter) {
        case 0:
          out = v
          break
        case 1:
          out = v + a
          break
        case 2:
          out = v + b
          break
        case 3:
          out = v + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`未知行过滤器 ${filter}（第 ${y} 行）`)
      }
      px[dst + x] = out & 0xff
    }
  }

  // 统一摊成 RGBA，比较时就不用为每种颜色类型各写一套
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * ch
    const t = i * 4
    if (ch === 1) {
      rgba[t] = rgba[t + 1] = rgba[t + 2] = px[s]
      rgba[t + 3] = 255
    } else if (ch === 2) {
      rgba[t] = rgba[t + 1] = rgba[t + 2] = px[s]
      rgba[t + 3] = px[s + 1]
    } else if (ch === 3) {
      rgba[t] = px[s]
      rgba[t + 1] = px[s + 1]
      rgba[t + 2] = px[s + 2]
      rgba[t + 3] = 255
    } else {
      rgba[t] = px[s]
      rgba[t + 1] = px[s + 1]
      rgba[t + 2] = px[s + 2]
      rgba[t + 3] = px[s + 3]
    }
  }
  return { w, h, colorType: ihdr.colorType, bitDepth: ihdr.bitDepth, rgba }
}

export function decodePngFile(p) {
  return decodePng(fs.readFileSync(p))
}

/**
 * 逐像素比两张图。返回 { same, reason, diff, first }。
 * `reason` 是给人看的一句话，直接可以进闸门报错文本。
 */
export function comparePixels(a, b, labelA = 'A', labelB = 'B') {
  if (a.w !== b.w || a.h !== b.h) {
    return {
      same: false,
      reason: `尺寸不同：${labelA} ${a.w}x${a.h}，${labelB} ${b.w}x${b.h}`,
      diff: -1
    }
  }
  let diff = 0
  let first = null
  for (let i = 0, n = a.w * a.h; i < n; i++) {
    const t = i * 4
    if (
      a.rgba[t] !== b.rgba[t] ||
      a.rgba[t + 1] !== b.rgba[t + 1] ||
      a.rgba[t + 2] !== b.rgba[t + 2] ||
      a.rgba[t + 3] !== b.rgba[t + 3]
    ) {
      diff++
      if (!first) {
        first = {
          x: i % a.w,
          y: Math.floor(i / a.w),
          [labelA]: [a.rgba[t], a.rgba[t + 1], a.rgba[t + 2], a.rgba[t + 3]].join(','),
          [labelB]: [b.rgba[t], b.rgba[t + 1], b.rgba[t + 2], b.rgba[t + 3]].join(',')
        }
      }
    }
  }
  return {
    same: diff === 0,
    reason: diff === 0 ? '' : `${diff} / ${a.w * a.h} 个像素不同`,
    diff,
    first
  }
}
