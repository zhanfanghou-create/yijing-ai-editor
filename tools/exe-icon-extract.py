#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从 .exe 里把图标资源挖出来（零依赖，只用标准库）。

为什么需要它：
  「换了 ico/ 里的图、也重新打包了，装出来的 exe 还是旧图标」这类问题，
  只看仓库里的文件永远发现不了 —— `build/icon.ico` 是对的、logo-sync 也绿，
  但 exe 里嵌的是哪一版没人知道。所以判据必须落在**产物本身**：
  把 RT_ICON 抠出来和 ico/ 源帧逐像素比。

它怎么工作（PE 结构最小子集）：
  DOS 头 → e_lfanew → PE 头 → 可选头里的 DataDirectory[2] = 资源表
  → 资源目录树第三层（type → name → language）里 type=3(RT_ICON) 的那一支
  → 每个叶子是 IMAGE_RESOURCE_DATA_ENTRY，指向一段原始字节
  → 这段字节要么是整张 PNG（256 帧），要么是 DIB（BITMAPINFOHEADER + BGRA）

用法：
  python tools/exe-icon-extract.py <exe>              # 列出所有图标帧
  python tools/exe-icon-extract.py <exe> --dump <dir> # 把最大帧导出成 png
  python tools/exe-icon-extract.py <exe> --sha        # 只打印最大帧的像素 sha（给闸门用）
"""
import hashlib
import os
import struct
import sys
import zlib


def u16(b, o):
    return struct.unpack_from('<H', b, o)[0]


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def read_sections(data):
    """返回 [(VirtualAddress, VirtualSize, PointerToRawData)]，用于 RVA→文件偏移。"""
    e_lfanew = u32(data, 0x3C)
    if data[e_lfanew:e_lfanew + 4] != b'PE\0\0':
        raise SystemExit('不是 PE 文件（PE 签名不对）')
    coff = e_lfanew + 4
    nsec = u16(data, coff + 2)
    opt_size = u16(data, coff + 16)
    opt = coff + 20
    magic = u16(data, opt)
    # PE32 的 DataDirectory 从可选头 +96 开始，PE32+ 从 +112
    dd = opt + (96 if magic == 0x10B else 112)
    res_rva, res_size = u32(data, dd + 2 * 8), u32(data, dd + 2 * 8 + 4)
    secs = []
    sec0 = opt + opt_size
    for i in range(nsec):
        o = sec0 + i * 40
        vsize = u32(data, o + 8)
        vaddr = u32(data, o + 12)
        raw = u32(data, o + 20)
        secs.append((vaddr, vsize, raw))
    return res_rva, res_size, secs


def rva2off(rva, secs):
    for vaddr, vsize, raw in secs:
        if vaddr <= rva < vaddr + max(vsize, 1):
            return rva - vaddr + raw
    raise SystemExit('RVA 0x%X 不在任何节里' % rva)


def walk_dir(data, base, off, depth, want_type, out):
    """递归走资源目录树。base=资源段文件偏移，off=相对资源段起点的偏移。"""
    p = base + off
    named = u16(data, p + 12)
    ids = u16(data, p + 14)
    total = named + ids
    for i in range(total):
        e = p + 16 + i * 8
        name_id = u32(data, e)
        child = u32(data, e + 4)
        ident = name_id & 0x7FFFFFFF
        if depth == 0:
            # 只关心 RT_ICON = 3 / RT_GROUP_ICON = 14
            if name_id & 0x80000000 or ident not in (3, 14):
                continue
            walk_dir(data, base, child & 0x7FFFFFFF, 1, ident, out)
        elif depth == 1:
            walk_dir(data, base, child & 0x7FFFFFFF, 2, want_type, out)
        else:
            if child & 0x80000000:
                continue
            de = base + child
            data_rva = u32(data, de)
            size = u32(data, de + 4)
            out.append((want_type, data_rva, size))


def frame_info(blob):
    """返回 (width, height, kind)。kind: 'png' 或 'dib'"""
    if blob[:8] == b'\x89PNG\r\n\x1a\n':
        w, h = struct.unpack('>II', blob[16:24])
        return w, h, 'png'
    # DIB：BITMAPINFOHEADER，biHeight 是"双倍高度"（含 AND 掩码）
    if len(blob) >= 40:
        w, h = struct.unpack_from('<ii', blob, 4)
        return w, abs(h) // 2, 'dib'
    return 0, 0, '?'


def dib_to_rgba(blob):
    """DIB → RGBA 原始像素（行自下而上，32bpp BGRA）。"""
    w, h, _ = frame_info(blob)
    if w <= 0 or h <= 0:
        raise SystemExit('DIB 尺寸不合法')
    pix = blob[40:40 + w * h * 4]
    if len(pix) < w * h * 4:
        raise SystemExit('DIB 像素数据不足')
    rows = []
    for y in range(h - 1, -1, -1):  # 自下而上
        row = bytearray()
        base = y * w * 4
        for x in range(w):
            b, g, r, a = pix[base + x * 4: base + x * 4 + 4]
            row += bytes((r, g, b, a))
        rows.append(bytes(row))
    return w, h, b''.join(rows)


def png_to_rgba(blob):
    """解 PNG（仅 8bit RGBA/RGB，过滤型 0~4）。够读 electron-builder 产出的帧。"""
    off = 8
    w = h = bd = ct = None
    idat = b''
    while off < len(blob):
        ln = struct.unpack_from('>I', blob, off)[0]
        typ = blob[off + 4:off + 8]
        body = blob[off + 8: off + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        off += 12 + ln
    if bd != 8 or ct not in (6, 2, 3):
        raise SystemExit('只支持 8bit RGB/RGBA/调色板 PNG（实际 bd=%s ct=%s）' % (bd, ct))
    raw = zlib.decompress(idat)
    ch = {6: 4, 2: 3, 3: 1}[ct]
    stride = w * ch
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(h):
        ft = raw[pos]
        pos += 1
        line = bytearray(raw[pos: pos + stride])
        pos += stride
        if ft == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        if ch == 3:
            for i in range(len(line) - 1, -1, -1):
                v = line[i]
                j = i * ch
                pass
            rgba = bytearray()
            for x in range(w):
                r, g, b = line[x * 3: x * 3 + 3]
                rgba += bytes((r, g, b, 255))
            line = rgba
        elif ch == 1:
            rgba = bytearray()
            for x in range(w):
                v = line[x]
                rgba += bytes((v, v, v, 255))
            line = rgba
        out += line
        prev = line
    return w, h, bytes(out)


def rgba_of(blob):
    kind = frame_info(blob)[2]
    return png_to_rgba(blob) if kind == 'png' else dib_to_rgba(blob)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    exe = sys.argv[1]
    dump = None
    want_sha = '--sha' in sys.argv
    if '--dump' in sys.argv:
        dump = sys.argv[sys.argv.index('--dump') + 1]

    data = open(exe, 'rb').read()
    res_rva, res_size, secs = read_sections(data)
    base = rva2off(res_rva, secs)
    out = []
    walk_dir(data, base, 0, 0, 3, out)

    frames = []
    for typ, rva, size in out:
        if typ != 3:
            continue
        off = rva2off(rva, secs)
        blob = data[off: off + size]
        w, h, kind = frame_info(blob)
        frames.append((w, h, kind, blob))

    if not frames:
        raise SystemExit('这个 exe 里没有 RT_ICON 资源')

    if not want_sha:
        print('%s  共 %d 帧图标' % (os.path.basename(exe), len(frames)))
        for w, h, kind, blob in sorted(frames):
            print('  %4dx%-4d  %-4s  %8dB' % (w, h, kind, len(blob)))

    # 最大帧（像素数最多）作为判据：小尺寸 16/32 在 DIB↔PNG 之间来回转，
    # 容易因为四舍五入产生可见差；256 帧是原样存进去的，最干净。
    big = max(frames, key=lambda f: f[0] * f[1])
    w, h, rgba = rgba_of(big[3])
    sha = hashlib.sha256(rgba).hexdigest()

    if want_sha:
        print('%dx%d %s' % (w, h, sha))
    if dump:
        os.makedirs(dump, exist_ok=True)
        # 直接写 PNG（RGB + alpha 用最小过滤器 0）
        raw = b''.join(b'\x00' + rgba[i * w * 4:(i + 1) * w * 4] for i in range(h))

        def chunk(t, d):
            c = struct.pack('>I', len(d)) + t + d
            return c + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)

        ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
        png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
               + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
        p = os.path.join(dump, 'exe-icon-%dx%d.png' % (w, h))
        open(p, 'wb').write(png)
        print('导出 %s  (%dx%d)  sha %s' % (p, w, h, sha[:16]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
