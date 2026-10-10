#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-diffscan.py — 把两图的差异投影到坐标轴上，直接列出「哪几段 x / 哪几段 y 在差」。

png-compare.py 给的是「N 行 M 列的粗网格」，块内差异被平均掉了：
一个 8px 宽的按钮位置错 3px，在 160px 的格子里只表现为「这一格平均差 18」，
你仍然不知道是哪个元素。这个工具把差异**投影成一维**：

  --axis col：沿 x 方向统计每列的平均差 → 得到「哪几段横向区间在差」
  --axis row：沿 y 方向统计每行的平均差 → 得到「哪几段纵向区间在差」

再配合 --band 限定范围（比如只看标签栏那 44px 高），就能精确到「x 439..796 这一段差，
其余全好」。定位到段之后再用 png-strip.py 裁剪放大看具体是什么。

用法：
  # 整图横向投影：哪些 x 区间在差
  python tools/png-diffscan.py 参考.png 我们.png --axis col

  # 只看标签栏那一条（y 35..79）的横向投影
  python tools/png-diffscan.py 参考.png 我们.png --axis col --band 0,35,1920,79

  # 只看左栏那一条的纵向投影
  python tools/png-diffscan.py 参考.png 我们.png --axis row --band 0,79,158,695

  # 调阈值 / 最小段长
  python tools/png-diffscan.py 参考.png 我们.png --axis col --thr 12 --min-run 2
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


def load_rgb(ffmpeg: str, path: str, w: int, h: int) -> bytes:
    out = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    if len(out) != w * h * 3:
        raise ValueError("解码长度不符：%s（%d != %d）" % (path, len(out), w * h * 3))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ref")
    ap.add_argument("ours")
    ap.add_argument("--axis", choices=("col", "row"), default="col")
    ap.add_argument("--band", help="限定范围 x0,y0,x1,y1（含 x1,y1）")
    ap.add_argument("--thr", type=float, default=16.0, help="判定「这一段在差」的平均通道差阈值")
    ap.add_argument("--min-run", type=int, default=2, help="连续多少像素才算一段")
    ap.add_argument("--top", type=int, default=8, help="额外列出最差的 N 个单点")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("找不到 ffmpeg")
        return 2

    rw, rh = png_size(args.ref)
    ow, oh = png_size(args.ours)
    if (rw, rh) != (ow, oh):
        print(f"⚠️ 尺寸不一致：参考 {rw}x{rh}，我们 {ow}x{oh}")
        return 2

    x0, y0, x1, y1 = 0, 0, rw - 1, rh - 1
    if args.band:
        x0, y0, x1, y1 = (int(v) for v in args.band.split(","))
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(rw - 1, x1), min(rh - 1, y1)

    a = load_rgb(ffmpeg, args.ref, rw, rh)
    b = load_rgb(ffmpeg, args.ours, rw, rh)

    band_w = x1 - x0 + 1
    band_h = y1 - y0 + 1

    # 逐点绝对差（只取一个通道的均值即可反映量级，但用三通道均值更准）
    def diff_at(x: int, y: int) -> int:
        i = (y * rw + x) * 3
        return abs(a[i] - b[i]) + abs(a[i + 1] - b[i + 1]) + abs(a[i + 2] - b[i + 2])

    if args.axis == "col":
        span = band_w
        prof = []
        for k in range(span):
            x = x0 + k
            s = 0
            for y in range(y0, y1 + 1):
                s += diff_at(x, y)
            prof.append(s / (3.0 * band_h))
        label, lo, hi = "列", x0, x1
    else:
        span = band_h
        prof = []
        for k in range(span):
            y = y0 + k
            s = 0
            for x in range(x0, x1 + 1):
                s += diff_at(x, y)
            prof.append(s / (3.0 * band_w))
        label, lo, hi = "行", y0, y1

    print("=" * 74)
    print(f"{os.path.basename(args.ref)}  vs  {os.path.basename(args.ours)}")
    print(f"范围 x{x0}..{x1} y{y0}..{y1}   轴={args.axis}  阈值={args.thr}  最小段长={args.min_run}")
    print("-" * 74)

    # 连续超阈值段
    runs = []
    start = None
    for k, v in enumerate(prof):
        if v > args.thr:
            if start is None:
                start = k
        else:
            if start is not None:
                if k - start >= args.min_run:
                    runs.append((start, k - 1))
                start = None
    if start is not None and len(prof) - start >= args.min_run:
        runs.append((start, len(prof) - 1))

    if not runs:
        print(f"没有超过阈值的{label}段 —— 这一条范围已经 1:1。")
    else:
        print(f"有差异的{label}段（{len(runs)} 段）：")
        for s, e in runs:
            seg = prof[s:e + 1]
            peak = max(seg)
            print(
                f"  {label} {lo + s:>5}..{lo + e:<5} (宽 {e - s + 1:>4} px)  "
                f"平均差 {sum(seg) / len(seg):6.2f}  峰值 {peak:6.2f}"
            )

    worst = sorted(range(span), key=lambda k: -prof[k])[: args.top]
    print(f"\n最差的 {args.top} 个{label}：")
    for k in worst:
        print(f"  {label} {lo + k:>5}  平均差 {prof[k]:6.2f}")

    print("=" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
