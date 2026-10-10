#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-stat.py — 对比两张图**同一矩形**的「墨水统计」，判断字重 / 图标填充度 / 亮度差异。

为什么需要它：
  位置全部对齐之后，剩下的差异是「同一个盒子里，里面的字更淡、图标更空」。
  png-compare 只给整页相似度，png-rows 只给「哪几行有内容」——都答不了
  「这一行文字比参考淡了多少」。本工具直接给三个数：

    覆盖率    非背景像素 / 矩形面积   —— 判断描边 vs 实心（实心会明显更大）
    墨水量    Σ max(0, lum − bg_lum) / 面积（归一化）—— 判据最灵敏：字形相同而
              字重更细时单调变小；图标由描边改实心时显著变大
    峰值/分位  亮度 p50 / p90 / p99 / max  —— 判断是不是「颜色写浅了」

--bg 可以给多个（逗号分隔），都会当成背景色（容差 --tol），用法与 png-rows 一致。

用法：
  # 同一块区域，参考 vs 我们
  python tools/png-stat.py 参考.png 我们.png --rect 16,385,40,32 --bg 1A1A20

  # 只量一张
  python tools/png-stat.py 参考.png --rect 16,385,40,32 --bg 1A1A20

  # 文字行：把行底色也算背景，只看白字
  python tools/png-stat.py 参考.png 我们.png --rect 48,390,80,24 --bg 1A1A20,26262B --tol 14
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


def lum(r: int, g: int, b: int) -> float:
    return 0.299 * r + 0.587 * g + 0.114 * b


def percentile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def measure(path: str, rect: tuple[int, int, int, int],
            bgs: list[tuple[int, int, int]], tol: int, ffmpeg: str) -> dict:
    w, h = png_size(path)
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    x0, y0, rw, rh = rect
    x_end, y_end = min(x0 + rw, w), min(y0 + rh, h)

    bg_lum = lum(*bgs[0])
    lums: list[float] = []
    ink = 0
    ink_sum = 0.0
    total = 0
    for y in range(y0, y_end):
        for x in range(x0, x_end):
            i = (y * w + x) * 3
            r, g, b = raw[i], raw[i + 1], raw[i + 2]
            total += 1
            is_bg = any(abs(r - br) <= tol and abs(g - bg_) <= tol and abs(b - bb) <= tol
                        for br, bg_, bb in bgs)
            if is_bg:
                continue
            ink += 1
            v = lum(r, g, b)
            ink_sum += max(0.0, v - bg_lum)
            lums.append(v)

    lums.sort()
    return {
        "name": os.path.basename(path),
        "rect": (x_end - x0, y_end - y0),
        "total": total,
        "ink": ink,
        "cover": ink / total if total else 0.0,
        "mass": ink_sum / total if total else 0.0,
        "p50": percentile(lums, 0.50),
        "p90": percentile(lums, 0.90),
        "p99": percentile(lums, 0.99),
        "max": lums[-1] if lums else 0.0,
        "mean": (sum(lums) / len(lums)) if lums else 0.0,
    }


def emit(r: dict, ref: dict | None) -> None:
    def d(key: str, fmt: str = "{:+.2f}") -> str:
        if ref is None:
            return ""
        return "   Δ " + fmt.format(r[key] - ref[key])

    print(f"  {r['name']:<34} 覆盖率 {r['cover']*100:6.2f}%   墨水量 {r['mass']:7.2f}"
          f"   p50 {r['p50']:6.1f}  p90 {r['p90']:6.1f}  p99 {r['p99']:6.1f}"
          f"  max {r['max']:6.1f}{d('mass')}")
    if ref is not None:
        print(f"      └ 覆盖率 Δ {(r['cover']-ref['cover'])*100:+.2f}pt"
              f"   p50 Δ {r['p50']-ref['p50']:+.1f}   p90 Δ {r['p90']-ref['p90']:+.1f}"
              f"   max Δ {r['max']-ref['max']:+.1f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("imgs", nargs="+", help="参考图 [我们图]")
    ap.add_argument("--rect", required=True, help="x,y,w,h（两张图用同一块）")
    ap.add_argument("--bg", required=True, help="背景色，可多个（逗号分隔）")
    ap.add_argument("--tol", type=int, default=10, help="与背景的通道差在此以内算背景")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("找不到 ffmpeg")
        return 2

    rect = tuple(int(v) for v in args.rect.split(","))  # type: ignore[assignment]
    bgs = [hexecolor(s) for s in args.bg.split(",")]

    print("=" * 108)
    print(f"矩形 x{rect[0]}..{rect[0]+rect[2]-1} y{rect[1]}..{rect[1]+rect[3]-1}"
          f"   背景 {args.bg}  容差 {args.tol}")
    print("-" * 108)
    ref = None
    for idx, p in enumerate(args.imgs):
        r = measure(p, rect, bgs, args.tol, ffmpeg)
        emit(r, ref)
        if idx == 0:
            ref = r
    print("=" * 108)
    return 0


if __name__ == "__main__":
    sys.exit(main())
