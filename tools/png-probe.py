#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-probe.py — 从 PNG 里读像素，用来量参考界面的精确规格（零第三方依赖，走 ffmpeg 解码）。

做 1:1 还原时，"目测"不够用：侧栏到底多宽、卡片的圆角半径、分隔线颜色，
都必须从参考图上量出来。这个工具就是那把尺子。

用法：
  python tools/png-probe.py a.png --size
  python tools/png-probe.py a.png --at 600,400                 # 单点颜色
  python tools/png-probe.py a.png --row 400                    # 扫描整行 -> 颜色分段
  python tools/png-probe.py a.png --col 600                    # 扫描整列 -> 颜色分段
  python tools/png-probe.py a.png --rect 20,60,200,120 --palette
  python tools/png-probe.py a.png --row 400 --tol 6 --min-run 3
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import struct
import subprocess
import sys
from collections import Counter

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

FFMPEG_CANDIDATES = (r"C:\Program Files\ffmpeg\bin\ffmpeg.exe", r"C:\ffmpeg\bin\ffmpeg.exe")


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


def hexc(r: int, g: int, b: int) -> str:
    return "#%02X%02X%02X" % (r, g, b)


def px(data: bytes, w: int, x: int, y: int) -> tuple[int, int, int]:
    off = (y * w + x) * 3
    return data[off], data[off + 1], data[off + 2]


def runs(seq: list[tuple[int, int, int]], tol: int, min_run: int) -> list[tuple[int, int, tuple[int, int, int]]]:
    """把一维颜色序列压成「同色区间」。tol 是相邻像素允许的通道差。"""
    out: list[tuple[int, int, tuple[int, int, int]]] = []
    start = 0
    base = seq[0]
    for i in range(1, len(seq)):
        c = seq[i]
        if max(abs(c[0] - base[0]), abs(c[1] - base[1]), abs(c[2] - base[2])) > tol:
            out.append((start, i - 1, base))
            start = i
            base = c
    out.append((start, len(seq) - 1, base))
    # 合并掉过短的碎段到前一段
    merged: list[tuple[int, int, tuple[int, int, int]]] = []
    for a, b, c in out:
        if merged and (b - a + 1) < min_run:
            pa, _, _ = merged[-1]
            merged[-1] = (pa, b, merged[-1][2])
        else:
            merged.append((a, b, c))
    return merged


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--at", help="X,Y 单点颜色")
    ap.add_argument("--row", type=int, help="扫描该行")
    ap.add_argument("--col", type=int, help="扫描该列")
    ap.add_argument("--rect", help="X,Y,W,H 区域统计")
    ap.add_argument("--palette", action="store_true", help="配合 --rect 输出主要颜色")
    ap.add_argument("--tol", type=int, default=8)
    ap.add_argument("--min-run", type=int, default=4)
    ap.add_argument("--max-seg", type=int, default=60)
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("[!] 找不到 ffmpeg")
        return 2

    targets: list[str] = []
    for pat in [args.image]:
        targets.extend(glob.glob(pat) or [pat])

    for path in targets:
        if not os.path.exists(path):
            print("[!] 不存在：%s" % path)
            continue
        w, h, data = load_rgb(ffmpeg, path)
        print("=" * 74)
        print("%s  %dx%d" % (os.path.basename(path), w, h))

        if args.at:
            x, y = (int(v) for v in args.at.split(","))
            r, g, b = px(data, w, x, y)
            print("  (%d,%d) = %s  rgb(%d,%d,%d)" % (x, y, hexc(r, g, b), r, g, b))

        if args.row is not None:
            y = args.row
            seq = [px(data, w, x, y) for x in range(w)]
            print("  --- 行 y=%d 颜色分段（tol=%d, min-run=%d）---" % (y, args.tol, args.min_run))
            for a, b, c in runs(seq, args.tol, args.min_run)[:args.max_seg]:
                print("     x %4d..%-4d  (%3d px)  %s" % (a, b, b - a + 1, hexc(*c)))

        if args.col is not None:
            x = args.col
            seq = [px(data, w, x, y) for y in range(h)]
            print("  --- 列 x=%d 颜色分段 ---" % x)
            for a, b, c in runs(seq, args.tol, args.min_run)[:args.max_seg]:
                print("     y %4d..%-4d  (%3d px)  %s" % (a, b, b - a + 1, hexc(*c)))

        if args.rect:
            x, y, rw, rh = (int(v) for v in args.rect.split(","))
            x = max(0, x); y = max(0, y)
            rw = min(rw, w - x); rh = min(rh, h - y)
            cnt = Counter()
            for yy in range(y, y + rh):
                for xx in range(x, x + rw):
                    cnt[px(data, w, xx, yy)] += 1
            total = rw * rh
            print("  --- 区域 (%d,%d,%d,%d) 共 %d px，主要颜色 ---" % (x, y, rw, rh, total))
            for c, n in cnt.most_common(12):
                print("     %-9s %7d  %5.2f%%" % (hexc(*c), n, 100.0 * n / total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
