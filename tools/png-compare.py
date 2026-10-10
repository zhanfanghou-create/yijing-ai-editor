#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-compare.py — 把「我们的实现」与「参考客户端」的截图逐像素比对，量化还原度。

做 1:1 还原最怕"自我感觉良好"，所以每次改完都应该跑一遍：
  - 相似度：1 - 平均通道差/255
  - 网格差异表：把画面切成 NxM 块，指出差得最狠的区域（改哪里最有收益）
  - 并排图：肉眼对照
  - 差异图：把差异放大到可见（原图差异往往只有几个色阶，肉眼看不出来）

用法：
  python tools/png-compare.py 参考.png 我们的.png --tag home --grid 12x8
"""
from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys
import tempfile

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
    out = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    if len(out) != w * h * 3:
        raise ValueError("解码长度不符：%s" % path)
    return w, h, out


def load_rgb_scaled(ffmpeg: str, path: str, w: int, h: int, tmpdir: str) -> bytes:
    """把图片缩放到指定尺寸后取像素（对比双方尺寸不一致时用）。"""
    dst = os.path.join(tmpdir, "scaled.png")
    subprocess.run([ffmpeg, "-y", "-v", "error", "-i", path, "-vf",
                    "scale=%d:%d:flags=bilinear" % (w, h), dst], check=True)
    return load_rgb(ffmpeg, dst)[2]


def save_rgb(ffmpeg: str, path: str, w: int, h: int, data: bytes) -> None:
    subprocess.run([ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                    "-s", "%dx%d" % (w, h), "-i", "-", "-frames:v", "1", path],
                   input=data, check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("reference")
    ap.add_argument("ours")
    ap.add_argument("--tag", default="compare")
    ap.add_argument("--out-dir", default=r"F:\yjai-edit\_evidence\compare")
    ap.add_argument("--grid", default="12x8", help="网格，如 12x8")
    ap.add_argument("--gain", type=float, default=6.0, help="差异图放大倍数")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("[!] 找不到 ffmpeg")
        return 2
    for p in (args.reference, args.ours):
        if not os.path.exists(p):
            print("[!] 不存在：%s" % p)
            return 2

    rw, rh, ref = load_rgb(ffmpeg, args.reference)
    print("参考：%s  %dx%d" % (os.path.basename(args.reference), rw, rh))
    with tempfile.TemporaryDirectory() as tmp:
        our = load_rgb_scaled(ffmpeg, args.ours, rw, rh, tmp)
    ow, oh = png_size(args.ours)
    print("我们：%s  %dx%d%s" % (os.path.basename(args.ours), ow, oh,
                                "" if (ow, oh) == (rw, rh) else "  -> 已缩放到 %dx%d" % (rw, rh)))

    n = rw * rh
    total = 0
    big = 0
    diff = bytearray(n * 3)
    for i in range(n * 3):
        d = ref[i] - our[i]
        if d < 0:
            d = -d
        total += d
        if d > 24:
            big += 1

    # 差异图：按像素聚合。一致处淡灰、差异处越红越差 ——
    # 原图差异常常只有几个色阶，不放大根本看不出来。
    for pix in range(n):
        o = pix * 3
        d = (abs(ref[o] - our[o]) + abs(ref[o + 1] - our[o + 1]) + abs(ref[o + 2] - our[o + 2])) // 3
        if d < 4:
            diff[o] = diff[o + 1] = diff[o + 2] = 235
        else:
            v = min(255, int(d * args.gain))
            diff[o] = 255
            diff[o + 1] = 255 - v
            diff[o + 2] = 255 - v

    similarity = 100.0 * (1.0 - total / (n * 3) / 255.0)
    print()
    print("相似度            : %.2f%%" % similarity)
    print("平均通道差        : %.2f / 255" % (total / (n * 3)))
    print("差异>24 的通道占比: %.2f%%" % (100.0 * big / (n * 3)))

    # ---- 网格差异：直接指出"改哪里最有收益" ----
    gw, gh = (int(v) for v in args.grid.lower().split("x"))
    cw, chh = rw // gw, rh // gh
    cells = []
    for gy in range(gh):
        for gx in range(gw):
            s = 0
            cnt = 0
            for y in range(gy * chh, min((gy + 1) * chh, rh), 2):
                row = y * rw
                for x in range(gx * cw, min((gx + 1) * cw, rw), 2):
                    o = (row + x) * 3
                    s += abs(ref[o] - our[o]) + abs(ref[o + 1] - our[o + 1]) + abs(ref[o + 2] - our[o + 2])
                    cnt += 3
            cells.append((s / max(1, cnt), gx, gy))
    cells.sort(reverse=True)
    print()
    print("--- 差异最大的 12 个网格（行=从上到下，列=从左到右；块 %dx%d）---" % (cw, chh))
    for avg, gx, gy in cells[:12]:
        print("     行%2d 列%2d  平均差 %6.2f   (x %4d..%-4d, y %4d..%-4d)"
              % (gy, gx, avg, gx * cw, (gx + 1) * cw, gy * chh, (gy + 1) * chh))

    os.makedirs(args.out_dir, exist_ok=True)
    side = bytearray()
    for y in range(rh):
        row = y * rw * 3
        side += ref[row:row + rw * 3]
        side += our[row:row + rw * 3]
    p_side = os.path.join(args.out_dir, args.tag + "-side.png")
    save_rgb(ffmpeg, p_side, rw * 2, rh, bytes(side))

    p_diff = os.path.join(args.out_dir, args.tag + "-diff.png")
    save_rgb(ffmpeg, p_diff, rw, rh, bytes(diff))

    print()
    print("并排图（左=参考，右=我们）: %s" % p_side)
    print("差异图（红色=我们偏暗 / 青色=我们偏亮，已放大 %.0f 倍）: %s" % (args.gain, p_diff))
    return 0


if __name__ == "__main__":
    sys.exit(main())
