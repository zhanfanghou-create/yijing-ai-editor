#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-shrink.py — 用本机 ffmpeg 把 PNG 等比缩小，便于在对话里查看（大图会被压缩到不可读）。

用法：
  python tools/png-shrink.py in.png [out.png] --width 900
  python tools/png-shrink.py dir/*.png --width 640        # 批量（输出 *-s.png）
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

FFMPEG_CANDIDATES = (
    r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
    r"C:\ffmpeg\bin\ffmpeg.exe",
)


def find_ffmpeg() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return found
    for p in FFMPEG_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def shrink(ffmpeg: str, src: str, dst: str, width: int) -> bool:
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", src,
           "-vf", f"scale={width}:-1:flags=area", dst]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        print("  [!] %s -> %s" % (os.path.basename(src), e.stderr.decode("utf-8", "replace")[:200]))
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--width", type=int, default=900)
    ap.add_argument("--suffix", default="-s")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("[!] 找不到 ffmpeg")
        return 2

    targets: list[str] = []
    for pat in args.inputs:
        hits = glob.glob(pat)
        targets.extend(hits or [pat])

    ok = 0
    for src in targets:
        if not os.path.exists(src):
            print("  [!] 不存在：%s" % src)
            continue
        if args.out:
            dst = args.out
        else:
            root, ext = os.path.splitext(src)
            dst = root + args.suffix + ext
        if shrink(ffmpeg, src, dst, args.width):
            print("  [ok] %s -> %s  (%d bytes)" % (os.path.basename(src), os.path.basename(dst),
                                                   os.path.getsize(dst)))
            ok += 1
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
