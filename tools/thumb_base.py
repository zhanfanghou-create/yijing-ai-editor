#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
取景底片 —— **Python 侧唯一入口**（从本地素材包 `frames.yjpack` 读，不解压到磁盘）。

底片真源：`tools/thumb-bases/frames.yjpack`（清单 + 4 张真实画面）。
以前是两张散图 base-a.png / base-b.png，生成器与特效素材包各自拼路径 ——
换底片要同时改多处，漏一处就是"某条链路还在拿老图"，而且不报错。
现在两处都 import 本模块，改底片 = 换包。

对应 Node 侧模块：`tools/thumb-base.mjs`。
"""
import io
import json
import os
import zipfile

from PIL import Image, ImageOps

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PACK = os.path.join(ROOT, 'tools', 'thumb-bases', 'frames.yjpack')

_PACK = None


def frames():
    """包里全部底片：`{which: Image}`（RGB，未做任何归一）"""
    global _PACK
    if _PACK is None:
        if not os.path.exists(PACK):
            raise SystemExit('缺少取景素材包：%s\n先跑 `python tools/gen-thumb-pack.py`' % PACK)
        with zipfile.ZipFile(PACK) as z:
            manifest = json.loads(z.read('manifest.json').decode('utf-8'))
            if manifest.get('role') != 'thumb-base':
                raise SystemExit('素材包用途不对：role=%r，应为 thumb-base' % manifest.get('role'))
            table = {}
            for item in manifest.get('items') or []:
                raw = z.read(item['file'])
                table[item['which']] = Image.open(io.BytesIO(raw)).convert('RGB')
        for need in ('a', 'b'):
            if need not in table:
                raise SystemExit('素材包里缺少底片：%s' % need)
        _PACK = table
    return _PACK


def base(which='a', size=None, normalize=True):
    """
    取一张底片。

    normalize=True 时做一次极轻的对比归一（`autocontrast(cutoff=0.5)`，不提色）：
    底片本身就是处理好的成品，再叠色彩增强会把红墙和白云推到过曝，
    反而让「亮部压不住」成了所有滤镜的共同特征。规范化只作用在**底片**上，
    不作用在每条滤镜的输出上 —— 后者会把要展示的差别一起抹平。
    """
    img = frames()[which].copy()
    if normalize:
        img = ImageOps.autocontrast(img, cutoff=0.5)
    if size:
        # size 传数字 = 正方形边长；传 (w, h) = 直接给目标尺寸
        target = tuple(size) if isinstance(size, (tuple, list)) else (size, size)
        img = img.resize(target, Image.LANCZOS)
    return img
