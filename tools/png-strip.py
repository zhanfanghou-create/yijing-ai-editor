#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-strip.py — 把「参考」与「我们」的同一块区域裁出来、放大、上下拼成一张对照图。

为什么需要它：做 1:1 还原时，整图相似度只告诉你「差了多少」，不告诉你「差在哪」。
整屏缩到对话里看，1-2px 的偏移和几个色阶的色差根本看不出来；
必须把可疑区域裁出来放大，才能判断是「我们错了」还是「文字反锯齿必然有差」。

用法：
  python tools/png-strip.py 参考.png 我们.png --rect 0,0,1920,80 --zoom 2 --out _evidence/compare/top.png
  python tools/png-strip.py 参考.png 我们.png --rect 0,695,1920,60 --zoom 3 --out _evidence/compare/tl.png
  # 逐块自动出图（把整屏切成 N 行 M 列，每块一张）：
  python tools/png-strip.py 参考.png 我们.png --tiles 4x3 --zoom 2 --outdir _evidence/compare/tiles

上下顺序固定为：上=参考，下=我们。中间夹一条 2px 品红分隔线，避免把两张图看混。
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


def crop_scale(ffmpeg: str, src: str, x: int, y: int, w: int, h: int, zoom: int, out: str) -> None:
    vf = f"crop={w}:{h}:{x}:{y},scale=iw*{zoom}:ih*{zoom}:flags=neighbor"
    subprocess.run(
        [ffmpeg, "-v", "error", "-y", "-i", src, "-vf", vf, "-frames:v", "1", out],
        check=True,
    )


def stack(ffmpeg: str, top: str, bottom: str, out: str) -> None:
    """上下拼接，中间加 2px 品红分隔线（用 lavfi 造一条纯色条再 vstack）。"""
    w = png_size(top)[0]
    subprocess.run(
        [
            ffmpeg, "-v", "error", "-y",
            "-i", top, "-i", bottom,
            "-f", "lavfi", "-i", f"color=c=magenta:s={w}x2",
            "-filter_complex", "[0:v][2:v][1:v]vstack=inputs=3",
            "-frames:v", "1", out,
        ],
        check=True,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ref")
    ap.add_argument("ours")
    ap.add_argument("--rect", help="x,y,w,h")
    ap.add_argument("--tiles", help="NxM：把整屏切成 N 行 M 列，逐块出图")
    ap.add_argument("--zoom", type=int, default=2)
    ap.add_argument("--out")
    ap.add_argument("--outdir")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("找不到 ffmpeg")
        return 2

    rw, rh = png_size(args.ref)
    ow, oh = png_size(args.ours)
    if (rw, rh) != (ow, oh):
        print(f"⚠️ 尺寸不一致：参考 {rw}x{rh}，我们 {ow}x{oh}（先统一再加尺寸再比）")
        return 2

    tmp = os.path.join("_evidence", "compare", ".tmp")
    os.makedirs(tmp, exist_ok=True)

    rects: list[tuple[int, int, int, int, str]] = []
    if args.rect:
        x, y, w, h = (int(v) for v in args.rect.split(","))
        rects.append((x, y, w, h, "rect"))
    if args.tiles:
        rows, cols = (int(v) for v in args.tiles.lower().split("x"))
        cw, ch = rw // cols, rh // rows
        for r in range(rows):
            for c in range(cols):
                rects.append((c * cw, r * ch, cw, ch, f"r{r}c{c}"))
    if not rects:
        print("要么给 --rect，要么给 --tiles")
        return 2

    made = []
    for i, (x, y, w, h, name) in enumerate(rects):
        a = os.path.join(tmp, f"a{i}.png")
        b = os.path.join(tmp, f"b{i}.png")
        crop_scale(ffmpeg, args.ref, x, y, w, h, args.zoom, a)
        crop_scale(ffmpeg, args.ours, x, y, w, h, args.zoom, b)
        if args.outdir:
            os.makedirs(args.outdir, exist_ok=True)
            out = os.path.join(args.outdir, f"{name}_{x}_{y}_{w}x{h}.png")
        else:
            out = args.out or os.path.join("_evidence", "compare", f"strip-{name}.png")
        stack(ffmpeg, a, b, out)
        made.append(out)

    for f in os.listdir(tmp):
        os.remove(os.path.join(tmp, f))
    os.rmdir(tmp)

    print(f"共 {len(made)} 张对照图（上=参考，下=我们，品红线分隔）：")
    for p in made:
        print("  " + os.path.abspath(p))
    return 0


if __name__ == "__main__":
    sys.exit(main())
