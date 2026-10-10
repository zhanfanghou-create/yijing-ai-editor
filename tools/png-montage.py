#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-montage.py — 把一堆 PNG 拼成一张「带网格 + 编号」的联络表（contact sheet）。

为什么需要它：参考客户端里挖出来的位图是**几千张没有名字的裸资源**（见
tools/extract-ref-assets.mjs）。要判断"哪个资源对应界面上哪个图标"，
唯一的办法是先**看一眼**。逐张 Read 会烧掉大量上下文且看不全，拼成一张
联络表后一次 Read 就能覆盖上百个候选。

零第三方依赖：解码走 ffmpeg（PNG→rawvideo rgba），编码用 zlib 手写 PNG。
所以本机没有 PIL / numpy 也能跑。

用法：
  # 把某个目录下所有 48x48 的图拼成一张（每行 16 个，格子 56px）
  python tools/png-montage.py _recon/ref-assets/FsAIShorts --filter 48x48 -o _recon/sheets/shorts48.png

  # 任意文件清单
  python tools/png-montage.py --files a.png b.png c.png -o out.png --cell 64 --cols 12

  # 放大看细节（格子放大 4 倍，最近邻，不做插值）
  python tools/png-montage.py dir --filter 24x24 --zoom 4 -o out.png

  # 黑色画布（参考图标多为白色/浅色，深底更容易看清）
  python tools/png-montage.py dir --bg 101014 -o out.png

格子里是等比例缩放（contain）居中，并叠一个 3x3 深色棋盘当透明底衬。
每个格子右下角画一条**深色底 + 浅色块**的「色阶条」代表序号？
—— 不画数字：字号不可控且会盖住小图标。序号靠"从左到右、从上到下"的位置推断，
配合 --start 指定起始序号，脚本同时把「序号 → 文件名」映射写到 out.png.list.txt。
"""
from __future__ import annotations

import argparse
import glob
import os
import struct
import subprocess
import sys
import zlib

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def decode(path: str) -> tuple[int, int, bytearray]:
    """用 ffmpeg 解成 RGBA 裸流。返回 (w, h, pixels)。"""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
        capture_output=True, text=True)
    if probe.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {path}: {probe.stderr.strip()}")
    w, h = (int(v) for v in probe.stdout.strip().split(",")[:2])
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        capture_output=True)
    if raw.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败: {path}: {raw.stderr.decode('utf-8', 'replace')[:200]}")
    return w, h, bytearray(raw.stdout)


def png_encode(w: int, h: int, px: bytearray) -> bytes:
    """把 RGBA 像素写成 PNG（filter type 0，不做线间预测）。"""
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def parse_color(s: str) -> tuple[int, int, int, int]:
    s = s.lstrip("#")
    if len(s) == 6:
        s += "ff"
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4, 6))  # type: ignore[return-value]


def parse_size(s: str) -> tuple[int, int]:
    a, b = s.lower().split("x")
    return int(a), int(b)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", nargs="?", help="素材目录（递归）")
    ap.add_argument("--files", nargs="*", help="直接给文件清单，和 dir 二选一")
    ap.add_argument("--filter", help="只收这个尺寸，如 48x48")
    ap.add_argument("--cell", type=int, default=56, help="格子边长（像素），默认 56")
    ap.add_argument("--cols", type=int, default=16, help="每行列数，默认 16")
    ap.add_argument("--pad", type=int, default=4, help="格子内留白，默认 4")
    ap.add_argument("--zoom", type=int, default=1, help="整体放大倍数（最近邻）")
    ap.add_argument("--bg", default="2a2a32", help="画布底色，默认 2a2a32")
    ap.add_argument("--grid", default="14141a", help="格子分隔线颜色")
    ap.add_argument("--limit", type=int, default=0, help="最多收多少张")
    ap.add_argument("--start", type=int, default=0, help="序号起始（配合分页）")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args()

    if not a.files and not a.dir:
        print("必须给 dir 或 --files", file=sys.stderr)
        return 2

    if a.files:
        files = [os.path.abspath(f) for f in a.files]
    else:
        files = sorted(glob.glob(os.path.join(a.dir, "**", "*.png"), recursive=True))
        if a.filter:
            want = parse_size(a.filter)
            keep = []
            for f in files:
                base = os.path.basename(f)
                # 文件名形如 0012_48x48_1c92d387.png
                parts = base.split("_")
                if len(parts) >= 2 and "x" in parts[1]:
                    try:
                        if parse_size(parts[1]) == want:
                            keep.append(f)
                            continue
                    except ValueError:
                        pass
            files = keep

    if a.limit:
        files = files[:a.limit]
    if not files:
        print("没有匹配的图", file=sys.stderr)
        return 1

    cell, pad, zoom = a.cell, a.pad, a.zoom
    cols = max(1, min(a.cols, len(files)))
    rows = (len(files) + cols - 1) // cols
    W, H = cols * cell, rows * cell

    bg = parse_color(a.bg)
    grid = parse_color(a.grid)

    # 先在 1x 画布上画，最后统一 zoom 放大（最近邻）
    canvas = bytearray()
    for y in range(H):
        for x in range(W):
            if x % cell == 0 or y % cell == 0:
                canvas += bytes(grid)
            else:
                canvas += bytes(bg)

    checker_light = (255, 255, 255, 22)   # 透明底衬
    placed = []
    for idx, f in enumerate(files):
        try:
            w, h, px = decode(f)
        except Exception as e:  # noqa: BLE001
            print(f"  跳过 {os.path.basename(f)}: {e}")
            continue
        r, c = divmod(idx, cols)
        # contain 缩放（整数比，最近邻，避免调色板图糊掉）
        box = cell - pad * 2
        scale = min(box / w, box / h)
        dw, dh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        ox = c * cell + (cell - dw) // 2
        oy = r * cell + (cell - dh) // 2
        for dy in range(dh):
            sy = min(h - 1, int(dy / scale))
            for dx in range(dw):
                sx = min(w - 1, int(dx / scale))
                si = (sy * w + sx) * 4
                sr, sg, sb, sa = px[si], px[si + 1], px[si + 2], px[si + 3]
                if sa == 0:
                    continue
                # 透明底衬棋盘（8px 一格），让半透明图标也看得见
                bx, by = ox + dx, oy + dy
                if ((bx >> 3) ^ (by >> 3)) & 1:
                    br, bgc, bb = bg[0] + 12, bg[1] + 12, bg[2] + 14
                else:
                    br, bgc, bb = bg[0] + 4, bg[1] + 4, bg[2] + 6
                af = sa / 255.0
                rr = int(sr * af + br * (1 - af))
                gg = int(sg * af + bgc * (1 - af))
                bl = int(sb * af + bb * (1 - af))
                di = (by * W + bx) * 4
                canvas[di:di + 4] = bytes((rr, gg, bl, 255))
        placed.append((idx, f))

    if zoom > 1:
        zw, zh = W * zoom, H * zoom
        big = bytearray(zw * zh * 4)
        for y in range(zh):
            sy = y // zoom
            for x in range(zw):
                si = (sy * W + x // zoom) * 4
                di = (y * zw + x) * 4
                big[di:di + 4] = canvas[si:si + 4]
        canvas, W, H = big, zw, zh

    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    with open(a.out, "wb") as fh:
        fh.write(png_encode(W, H, canvas))

    lst = a.out + ".list.txt"
    with open(lst, "w", encoding="utf-8") as fh:
        fh.write(f"# 联络表 {os.path.basename(a.out)}  {W}x{H}  {cols} 列 x {rows} 行\n")
        fh.write(f"# 格边长 {cell}  留白 {pad}  zoom {zoom}  底色 #{a.bg}\n")
        fh.write("# 序号从 0 起，按行优先（左→右，上→下）\n")
        for idx, f in placed:
            fh.write(f"{idx}\t{os.path.relpath(f, os.getcwd()).replace(os.sep, '/')}\n")
    print(f"写出 {a.out}  {W}x{H}  共 {len(placed)} 张  {cols} 列")
    print(f"映射 {lst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
