#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-dump.py — 把一小块区域的原始像素按亮度打成字符图 / 或直接打印 RGB。

png-probe.py 用的是「颜色分段（runs）」，短段会被并入相邻段，
所以 1~2 px 的细线（分隔线、滚动条、播放头）会被吃掉，容易误判。
要对齐 1:1，需要一把不会丢像素的尺子 —— 就是这个。

用法：
  python tools/png-dump.py a.png --rect 95,750,30,20 --map          # 亮度字符图
  python tools/png-dump.py a.png --rect 95,750,30,20 --rgb          # 逐像素 RGB
  python tools/png-dump.py a.png --at 105,800 --span x=95:120       # 单行原始值
  python tools/png-dump.py a.png --at 105,800 --span y=770:830      # 单列原始值
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import struct
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

FFMPEG_CANDIDATES = (
    r"D:\ffmpeg-8.1.2-essentials_build\bin\ffmpeg.exe",
    r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
    r"C:\ffmpeg\bin\ffmpeg.exe",
)

RAMP = " .:-=+*#%@"


def find_ffmpeg() -> str | None:
    got = shutil.which("ffmpeg")
    if got:
        return got
    for p in FFMPEG_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def png_size(path: str) -> tuple[int, int]:
    with open(path, "rb") as fh:
        head = fh.read(33)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是合法 PNG：%s" % path)
    return struct.unpack(">II", head[16:24])


def load_rgb(ffmpeg: str, path: str) -> tuple[int, int, bytes]:
    w, h = png_size(path)
    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True)
    data = proc.stdout
    if len(data) != w * h * 3:
        raise ValueError("解码长度不符：%d != %d" % (len(data), w * h * 3))
    return w, h, data


def px(data: bytes, w: int, x: int, y: int) -> tuple[int, int, int]:
    off = (y * w + x) * 3
    return data[off], data[off + 1], data[off + 2]


def lum(c: tuple[int, int, int]) -> int:
    return (c[0] * 299 + c[1] * 587 + c[2] * 114) // 1000


def hexc(c: tuple[int, int, int]) -> str:
    return "#%02X%02X%02X" % c


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--rect", help="X,Y,W,H")
    ap.add_argument("--at", help="X,Y 基准点")
    ap.add_argument("--span", help="配合 --at：x=A:B 或 y=A:B")
    ap.add_argument("--map", action="store_true", help="亮度字符图（相对区域内 min/max 归一化）")
    ap.add_argument("--rgb", action="store_true", help="逐像素打印 RGB")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("[!] 找不到 ffmpeg")
        return 2

    for path in (glob.glob(args.image) or [args.image]):
        if not os.path.exists(path):
            print("[!] 不存在：%s" % path)
            continue
        w, h, data = load_rgb(ffmpeg, path)
        print("=" * 74)
        print("%s  %dx%d" % (os.path.basename(path), w, h))

        if args.at and args.span:
            bx, by = (int(v) for v in args.at.split(","))
            axis, rng = args.span.split("=")
            a, b = (int(v) for v in rng.split(":"))
            print("  --- %s=%d..%d，%s=%d ---" % (axis, a, b, "y" if axis == "x" else "x", by if axis == "x" else bx))
            for i in range(a, b + 1):
                x, y = (i, by) if axis == "x" else (bx, i)
                if not (0 <= x < w and 0 <= y < h):
                    continue
                c = px(data, w, x, y)
                print("     %s=%4d  %s  rgb%-16s lum=%3d" % (axis, i, hexc(c), str(c), lum(c)))

        if args.rect:
            x, y, rw, rh = (int(v) for v in args.rect.split(","))
            x = max(0, x); y = max(0, y)
            rw = min(rw, w - x); rh = min(rh, h - y)
            print("  --- 区域 (%d,%d,%d,%d) ---" % (x, y, rw, rh))
            if args.rgb:
                for yy in range(y, y + rh):
                    row = "  ".join("%02X%02X%02X" % px(data, w, xx, yy) for xx in range(x, x + rw))
                    print("     y=%-4d %s" % (yy, row))
            if args.map or not args.rgb:
                grid = [[lum(px(data, w, xx, yy)) for xx in range(x, x + rw)] for yy in range(y, y + rh)]
                lo = min(min(r) for r in grid)
                hi = max(max(r) for r in grid)
                span = max(1, hi - lo)
                print("     亮度范围 %d..%d   刻度 '%s'(暗->亮)" % (lo, hi, RAMP))
                hdr = "        " + "".join(str((xx // 10) % 10) for xx in range(x, x + rw))
                print(hdr)
                print("        " + "".join(str(xx % 10) for xx in range(x, x + rw)))
                for i, row in enumerate(grid):
                    line = "".join(RAMP[min(len(RAMP) - 1, (v - lo) * len(RAMP) // span)] for v in row)
                    print("     %4d %s" % (y + i, line))
    return 0


if __name__ == "__main__":
    sys.exit(main())
