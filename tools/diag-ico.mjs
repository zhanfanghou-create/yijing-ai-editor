/**
 * 诊断：把 ico 里 DIB 帧的头字段与若干原始像素打出来，
 * 便于判断 stride / 位深 / 行序到底哪个假设错了。
 * 只读，不改任何东西。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

for (const name of ['16X16.ico', '32X32.ico', '256X256.ico']) {
  const p = path.join(ROOT, 'ico', name)
  const buf = fs.readFileSync(p)
  const count = buf.readUInt16LE(4)
  console.log(`\n=== ${name}  文件 ${buf.length}B  ${count} 帧 ===`)
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16
    const w = buf[o] === 0 ? 256 : buf[o]
    const h = buf[o + 1] === 0 ? 256 : buf[o + 1]
    const bytes = buf.readUInt32LE(o + 8)
    const off = buf.readUInt32LE(o + 12)
    const d = buf.subarray(off, off + bytes)
    const isPng = d.length > 8 && d.readUInt32BE(0) === 0x89504e47
    console.log(`  帧#${i}  目录项 ${w}x${h}  ${bytes}B  @${off}  ${isPng ? 'PNG' : 'DIB'}`)
    if (!isPng) {
      const hs = d.readUInt32LE(0)
      const bw = d.readInt32LE(4)
      const bh = d.readInt32LE(8)
      const planes = d.readUInt16LE(12)
      const bpp = d.readUInt16LE(14)
      const comp = d.readUInt32LE(16)
      const sizeImg = d.readUInt32LE(20)
      console.log(
        `    biSize=${hs} biWidth=${bw} biHeight=${bh} planes=${planes} bpp=${bpp} comp=${comp} biSizeImage=${sizeImg}`
      )
      // 按 bpp=32 推 stride，看和字节数对不对得上
      const stride32 = Math.ceil((bw * 32) / 32) * 4
      console.log(
        `    假设 32bpp：stride=${stride32} 需要 ${hs + stride32 * Math.abs(bh)}B，实际 ${bytes}B`
      )
      const stride24 = Math.floor(((bw * 24 + 31) / 32) * 4)
      console.log(
        `    假设 24bpp：stride=${stride24} 需要 ${hs + stride24 * Math.abs(bh) * 1.5}B（含掩码约 ${hs + stride24 * Math.abs(bh) + stride24 * (Math.abs(bh) / 2)}B）`
      )
      // 抽几行原始字节，看 alpha 通道是否规律
      const px = d.subarray(hs)
      const stride = stride32
      for (const y of [0, 1, 2, Math.floor(Math.abs(bh) / 2)]) {
        const row = px.subarray(y * stride, y * stride + 16)
        console.log(`    行${y}: ` + [...row].join(','))
      }
    }
  }
}
