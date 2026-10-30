#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
插件闸门的夹具：一个能直接被「导入插件文件夹」吃下的最小素材包。

    python tools/gen-plugin-fixture.py

产出 tools/fixtures/plugin-border/：
    manifest.json      kind=border（插件类型）
    frame-red.png      512×512，四周一圈红带、中间全透明
    frame-blue.png     同上，蓝色

为什么是「中间全透明」：边框图的用法就是叠在画面上，中间不透明会把画面盖死。
闸门 `check-plugins.mjs` 会断言这一点 —— 但断言的是**装出来之后预览里能看见画面**，
这里只是保证夹具本身符合物理事实（与 gen-borders.py 同一条约定）。

零依赖：只用 zlib + struct 手写 PNG，不要求 Pillow（本机 py 3.14 有、python 3.13 没有，
两个解释器都能跑才不会出现"换台机器就重建不了夹具"）。
"""
import os
import struct
import zlib

W = 512
H = 512
BAND = 56  # 四周带的宽度


def pixel(x, y, color):
    """边框：距边缘 BAND 以内是实色，其余全透明。"""
    inner = BAND
    if x < inner or y < inner or x >= W - inner or y >= H - inner:
        return color
    return (0, 0, 0, 0)


def write_png(path, rows):
    raw = b''.join(b'\x00' + bytes(row) for row in rows)

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as fh:
        fh.write(png)


def build(name, color):
    rows = []
    for y in range(H):
        row = []
        for x in range(W):
            row.extend(pixel(x, y, color))
        rows.append(row)
    return rows


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, 'fixtures', 'plugin-border')
    if not os.path.isdir(out):
        os.makedirs(out)

    red = build('frame-red', (226, 62, 62, 255))
    blue = build('frame-blue', (62, 122, 226, 255))
    write_png(os.path.join(out, 'frame-red.png'), red)
    write_png(os.path.join(out, 'frame-blue.png'), blue)

    # 清单：不写 id，让主进程从 name 派生（顺带验证"纯中文名也能装"）
    manifest = (
        '{\n'
        '  "name": "\u6d4b\u8bd5\u8fb9\u6846",\n'
        '  "kind": "border",\n'
        '  "version": "1.0.0",\n'
        '  "author": "\u95f8\u95e8\u5939\u5177"\n'
        '}\n'
    )
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as fh:
        fh.write(manifest)

    # 自证形状：夹具错了会让闸门报"导入 0 张"，那看着像代码坏了
    total = 0
    for fn in ('frame-red.png', 'frame-blue.png'):
        p = os.path.join(out, fn)
        size = os.path.getsize(p)
        total += size
        with open(p, 'rb') as fh:
            head = fh.read(24)
        assert head[:8] == b'\x89PNG\r\n\x1a\n', fn + ' 不是 PNG'
        w = int.from_bytes(head[16:20], 'big')
        h = int.from_bytes(head[20:24], 'big')
        assert (w, h) == (W, H), (fn, w, h)
        assert size > 400, (fn, size)
        print('  %-16s %d\xd7%d  %d bytes' % (fn, w, h, size))

    # 中心必须透明、边缘必须不透明（否则"边框盖死画面"这类问题会被夹具掩盖）
    # ⚠️ 这里断言的是行数据（list of list），不是磁盘上的字节 —— 磁盘那份已压缩，读不出像素
    center = red[H // 2][(W // 2) * 4 + 3]
    edge = red[0][3]
    assert center == 0, '中心 alpha 应为 0，实际 %d' % center
    assert edge == 255, '边缘 alpha 应为 255，实际 %d' % edge
    print('  中心 alpha=0 / 边缘 alpha=255  合计 %d bytes' % total)
    print('OK -> %s' % out)


if __name__ == '__main__':
    main()
