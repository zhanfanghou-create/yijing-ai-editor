#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
probe-sandbox-policy.py — 从 WorkBuddy 的 app.asar 里直接读出沙箱策略的真实语义。

用途：确认「某个程序为什么被拦 / 怎么改才能放行」时，不要去猜 UI 或试错，
      直接读 bundle 里的内联源码。Electron 应用把 TS 源码（含原始变量名、
      未 minify 的常量表）打进了 asar，mmap 分块搜索即可命中。

只读。默认输出到 stdout，建议重定向到文件再读（输出可达数十 KB）。

用法：
  python tools/probe-sandbox-policy.py                       # 默认关键字集
  python tools/probe-sandbox-policy.py --needle foo --pad 800
  python tools/probe-sandbox-policy.py --out _evidence/sandbox-policy.txt
"""
from __future__ import annotations

import argparse
import mmap
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ASAR = r"D:\Program Files\WorkBuddy\resources\app.asar"

# 默认关键字集：程序黑名单 / 系统工具策略 的全部关键符号
DEFAULT_NEEDLES = [
    "DEFAULT_WINDOWS_PROGRAM_BLACKLIST",
    "VALID_SYSTEM_TOOL_POLICIES",
    "DEFAULT_SYSTEM_TOOL_POLICY",
    "pickProgramBlacklist",
    "systemToolPolicy",
    "programBlacklist",
    "saveProgramBlacklist",
    "PROGRAM BLOCKED BY SECURITY POLICY",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--asar", default=ASAR)
    ap.add_argument("--needle", action="append", default=None,
                    help="自定义关键字，可重复；不给则用默认关键字集")
    ap.add_argument("--hits", type=int, default=3, help="每个关键字最多打印几处命中")
    ap.add_argument("--pad", type=int, default=900, help="命中点左右各取多少字符")
    ap.add_argument("--out", default=None, help="输出文件；不给则打 stdout")
    args = ap.parse_args()

    needles = args.needle or DEFAULT_NEEDLES
    if not os.path.exists(args.asar):
        print(f"[!] 找不到 {args.asar}", file=sys.stderr)
        return 2

    buf: list[str] = []

    def emit(line: str = "") -> None:
        buf.append(line)

    size = os.path.getsize(args.asar)
    emit(f"asar      : {args.asar}")
    emit(f"asar size : {size/1048576:.1f} MB")
    emit(f"needles   : {len(needles)}")

    found_any = False
    with open(args.asar, "rb") as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            for needle in needles:
                nb = needle.encode("utf-8")
                emit(f"\n{'='*72}\n### {needle}")
                start, hits = 0, 0
                while hits < args.hits:
                    i = mm.find(nb, start)
                    if i < 0:
                        break
                    hits += 1
                    found_any = True
                    lo, hi = max(0, i - args.pad), min(size, i + args.pad)
                    text = mm[lo:hi].decode("utf-8", errors="replace")
                    # 不可打印字符替换掉，保留换行/tab 便于读代码
                    text = re.sub(r"[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff]", "·", text)
                    emit(f"\n--- hit #{hits} @ 0x{i:x} ---\n{text}")
                    start = i + len(nb)
                if hits == 0:
                    emit("  (no hit)")
        finally:
            mm.close()

    out_text = "\n".join(buf) + "\n"
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out_text)
        print(f"[ok] 写入 {args.out}（{len(out_text)} 字符）")
    else:
        sys.stdout.write(out_text)

    return 0 if found_any else 1


if __name__ == "__main__":
    sys.exit(main())
