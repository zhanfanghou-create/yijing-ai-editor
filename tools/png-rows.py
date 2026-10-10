#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-rows.py — 在一个矩形区域里找出「哪几行有内容」，并把每一段的中心 + 高度打出来。

用途：复刻列表/工具栏这类**等距重复**的界面时，最需要知道的不是「某一行什么颜色」，
而是「第 1、2、3…项的基线分别落在哪一行、行距多少」。png-probe 的 --col 只能看到
某一列的切面（字形不同列切出来的上下沿不一样，会误判）；这个工具按整行统计
「非背景像素数」，一行只要有几个像素不是背景就算有内容，因此对字形不敏感。

用法：
  # 左栏树：x20..150、y79..694 区域里有内容的行
  python tools/png-rows.py 图.png --rect 20,79,130,615 --bg 1A1A20,27272D,0E0E13

  # 只看前 8 段，并输出每段中心
  python tools/png-rows.py 图.png --rect 20,79,130,615 --bg 1A1A20 --max 8

  # 两图并排比行距（直接看出整体偏移）
  python tools/png-rows.py 参考.png --rect 20,79,130,615 --bg 1A1A20,0E0E13
  python tools/png-rows.py 我们.png --rect 20,79,130,615 --bg 1A1A20,0E0E13

  # 换成按列投影：找「标签行里每个标签的左右边界」（--axis col）
  python tools/png-rows.py 参考.png --rect 8,35,790,44 --bg 303033 --axis col --min-px 2

--bg 可以给多个（逗号分隔），都会当成背景色（容差 --tol）。
--axis row（默认）按行统计 → 看纵向节距；--axis col 按列统计 → 看横向排列。
每段会打印：起始坐标、结束坐标、中心、跨度（内容像素的上下/左右沿跨度）。
"""
from __future__ import annotations

import argparse
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


def hexecolor(s: str) -> tuple[int, int, int]:
    s = s.strip().lstrip("#")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--rect", required=True, help="x,y,w,h")
    ap.add_argument("--bg", required=True, help="背景色，可多个（逗号分隔），如 1A1A20,0E0E13")
    ap.add_argument("--tol", type=int, default=10, help="与背景的通道差在此以内算背景")
    ap.add_argument("--min-px", type=int, default=3, help="一条至少几个非背景像素才算有内容")
    ap.add_argument("--max", type=int, default=40, help="最多打印几段")
    ap.add_argument("--axis", choices=("row", "col"), default="row",
                    help="row=按行投影（默认，看纵向节距）；col=按列投影（看横向排列）")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("找不到 ffmpeg")
        return 2

    w, h = png_size(args.img)
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", args.img, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout

    x0, y0, rw, rh = (int(v) for v in args.rect.split(","))
    bgs = [hexecolor(s) for s in args.bg.split(",")]

    def is_bg(i: int) -> bool:
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        for br, bg_, bb in bgs:
            if abs(r - br) <= args.tol and abs(g - bg_) <= args.tol and abs(b - bb) <= args.tol:
                return True
        return False

    x_end = min(x0 + rw, w)
    y_end = min(y0 + rh, h)

    counts: list[int] = []
    if args.axis == "row":
        # 每一行里有多少个非背景像素
        for y in range(y0, y_end):
            n = 0
            base = (y * w + x0) * 3
            for x in range(rw):
                if not is_bg(base + x * 3):
                    n += 1
            counts.append(n)
        origin, limit = y0, y_end
    else:
        # 每一列里有多少个非背景像素
        for x in range(x0, x_end):
            n = 0
            for y in range(y0, y_end):
                if not is_bg((y * w + x) * 3):
                    n += 1
            counts.append(n)
        origin, limit = x0, x_end

    segs = []
    start = None
    for k, n in enumerate(counts):
        if n >= args.min_px:
            if start is None:
                start = k
        else:
            if start is not None:
                segs.append((origin + start, origin + k - 1))
                start = None
    if start is not None:
        segs.append((origin + start, origin + len(counts) - 1))

    unit = "行" if args.axis == "row" else "列"
    print("=" * 66)
    print(f"{os.path.basename(args.img)}  rect x{x0}..{x_end-1} y{y0}..{y_end-1}  轴={args.axis}")
    print(f"背景色 {args.bg}  容差 {args.tol}  每{unit}最少 {args.min_px} 像素")
    print("-" * 66)
    print(f"共 {len(segs)} 段有内容：")
    prev = None
    for i, (s, e) in enumerate(segs[: args.max]):
        center = (s + e) / 2.0
        gap = "" if prev is None else f"  距上一段中心 {center - prev:+.1f}"
        print(f"  #{i+1:<3} {unit[-1]} {s:>4}..{e:<4} (跨度 {e - s + 1:>3}px)  中心 {center:>7.1f}{gap}")
        prev = center
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
