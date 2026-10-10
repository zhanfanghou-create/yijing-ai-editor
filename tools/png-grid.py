#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-grid.py — 在图上按网格 / 指定点采样颜色，一次解码、多点输出。

做 1:1 还原时，png-probe 的 --at 一次只能取一个点（每次都要重新解码一张图），
要量「渐变的四个角 + 中心」「按钮的填充/文字/描边」这类成组颜色时太慢。
这个工具一次解码，把整组点一次性打出来，并支持多图并排对比。

用法：
  # 在矩形内取 3x3 网格
  python tools/png-grid.py 图.png --rect 260,56,540,180 --grid 3x3

  # 指定若干点（图坐标）
  python tools/png-grid.py 图.png --points 280,70 780,225 350,210

  # 多图并排（同一组点，方便左右对照）
  python tools/png-grid.py 参考.png 我们.png --rect 260,56,540,180 --grid 3x3

  # 输出成可直接贴进 CSS 的色值列表
  python tools/png-grid.py 图.png --rect 260,56,540,180 --grid 3x3 --css
"""
from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys
from collections import Counter

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

FFMPEG_CANDIDATES = (
    r"D:\ffmpeg-8.1.2-essentials_build\bin\ffmpeg.exe",
    r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
    r"C:\ffmpeg\bin\ffmpeg.exe",
)


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
    data = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
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


def modal(data: bytes, w: int, x0: int, y0: int, x1: int, y1: int) -> tuple[int, int, int]:
    """区域内出现最多的颜色（用来读「填充色」，避开文字/抗锯齿像素）。"""
    cnt: Counter[tuple[int, int, int]] = Counter()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            cnt[px(data, w, x, y)] += 1
    return cnt.most_common(1)[0][0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--rect", help="X,Y,W,H —— 配合 --grid")
    ap.add_argument("--grid", default="3x3", help="网格 列x行，默认 3x3")
    ap.add_argument("--points", nargs="*", default=[], help="指定的点 X,Y ...")
    ap.add_argument("--mode", choices=("point", "modal"), default="point",
                    help="point=单像素；modal=在点周围 --win 的方窗里取众数（更稳）")
    ap.add_argument("--win", type=int, default=4, help="mode=modal 时的半窗大小，默认 4")
    ap.add_argument("--css", action="store_true", help="输出成 CSS 色值列表")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("[!] 找不到 ffmpeg")
        return 2

    pts: list[tuple[int, int]] = []
    labels: list[str] = []
    if args.rect:
        x, y, rw, rh = (int(v) for v in args.rect.split(","))
        cols, rows = (int(v) for v in args.grid.lower().split("x"))
        for r in range(rows):
            for c in range(cols):
                gx = x + (rw - 1) * c // max(1, cols - 1)
                gy = y + (rh - 1) * r // max(1, rows - 1)
                pts.append((gx, gy))
                labels.append("r%dc%d" % (r + 1, c + 1))
    for p in args.points:
        a, b = (int(v) for v in p.split(","))
        pts.append((a, b))
        labels.append("(%d,%d)" % (a, b))

    if not pts:
        print("[!] 需要 --rect 或 --points")
        return 2

    for path in args.images:
        if not os.path.exists(path):
            print("[!] 不存在：%s" % path)
            continue
        w, h, data = load_rgb(ffmpeg, path)
        print("=" * 78)
        print("%s   %dx%d" % (os.path.basename(path), w, h))
        cols, rows = (int(v) for v in args.grid.lower().split("x"))
        line = []
        for i, (gx, gy) in enumerate(pts):
            gx = max(0, min(w - 1, gx))
            gy = max(0, min(h - 1, gy))
            if args.mode == "modal":
                c = modal(data, w,
                          max(0, gx - args.win), max(0, gy - args.win),
                          min(w - 1, gx + args.win), min(h - 1, gy + args.win))
            else:
                c = px(data, w, gx, gy)
            line.append("%-9s %-8s lum=%3d" % (labels[i], hexc(c), lum(c)))
            if len(line) == (cols if args.rect else 4):
                print("   " + " | ".join(line))
                line = []
        if line:
            print("   " + " | ".join(line))
        if args.css:
            vals = []
            for gx, gy in pts:
                gx = max(0, min(w - 1, gx))
                gy = max(0, min(h - 1, gy))
                vals.append(hexc(px(data, w, gx, gy)))
            print("   CSS: " + ", ".join(vals))
    return 0


if __name__ == "__main__":
    sys.exit(main())
