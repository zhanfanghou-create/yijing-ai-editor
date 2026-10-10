#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
滤镜 / 转场 / 特效缩略图生成器（开源版）

为什么要另起一套图：仓库里原来的 944 张缩略图与 1174 条 `internal` 名
（`VE_Filter_02CinemaWeddingFilter02` 之类）**全部提取自参考客户端的素材缓存**，
不是本项目的东西，不能随开源版一起发布。

这里改成：
  · 缩略图 = 按「条目名 + 效果键」哈希**程序化绘制**的示意图（零第三方素材）；
  · 条目只保留中文名与效果键，删掉全部 `internal`（那是厂商内部标识）。

示意图不是装饰色块 —— 每张画的是这条目**实际会触发的效果类型**：
  滤镜（soft/warm/cool/retro/mono/vivid/bright）→ 对应色调的取景卡；
  转场（fade/dissolve/wipeleft/slideup/circleopen …）→ 两格画面按该方向过渡；
  特效（fx-lightleak/pulse/flash/vignette/glitch/scan）→ 对应的光斑 / 脉冲 / 扫描线。
所以"图与名字对不上"这类错在这里不会发生：图和名字是**同一个效果键**画出来的。

用法：python tools/gen-material-thumbs.py
"""
import hashlib
import io
import math
import os
import re
import shutil
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MAT = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'materials.js')
OUT = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'materials')
SIZE = 128

ITEM_RE = re.compile(r'\{\s*zh:\s*"([^"]*)"\s*,\s*internal:\s*"[^"]*"\s*,\s*thumb:\s*"[^"]*"\s*,\s*css:\s*"([^"]*)"\s*\}')


def seed_of(name, css):
    return int(hashlib.sha1((name + '|' + css).encode('utf-8')).hexdigest()[:12], 16)


def hsl(h, s, l):
    """h,s,l ∈ [0,1] → (r,g,b) 0..255"""
    import colorsys
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return (int(r * 255), int(g * 255), int(b * 255))


# 各效果键的色相与饱和度区间 —— 决定"这张卡看起来是什么调子"
TONE = {
    'soft':    (0.08, 0.35, 0.72),
    'warm':    (0.07, 0.62, 0.58),
    'cool':    (0.55, 0.48, 0.52),
    'retro':   (0.09, 0.42, 0.46),
    'mono':    (0.00, 0.00, 0.55),
    'vivid':   (0.85, 0.78, 0.52),
    'bright':  (0.14, 0.30, 0.80),
    # 转场：两格画面的基色
    'fade':      (0.60, 0.45, 0.48),
    'dissolve':  (0.75, 0.40, 0.50),
    'wipeleft':  (0.52, 0.50, 0.46),
    'wiperight': (0.52, 0.50, 0.46),
    'slideup':   (0.30, 0.45, 0.48),
    'slidedown': (0.30, 0.45, 0.48),
    'slideleft': (0.95, 0.45, 0.48),
    'slideright': (0.95, 0.45, 0.48),
    'circleopen': (0.12, 0.50, 0.48),
    # 特效
    'fx-lightleak': (0.10, 0.75, 0.55),
    'fx-pulse':     (0.72, 0.60, 0.50),
    'fx-flash':     (0.16, 0.25, 0.72),
    'fx-vignette':  (0.62, 0.35, 0.42),
    'fx-glitch':    (0.88, 0.55, 0.48),
    'fx-scan':      (0.45, 0.40, 0.50),
}

TRANSITIONS = {'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideup', 'slidedown',
               'slideleft', 'slideright', 'circleopen'}
FX = {k for k in TONE if k.startswith('fx-')}


def draw_filter(d, css, seed):
    h, s, l = TONE.get(css, (0.6, 0.4, 0.5))
    h = (h + ((seed % 100) / 1000.0)) % 1.0
    top = hsl(h, s, min(0.92, l + 0.18))
    bottom = hsl((h + 0.06) % 1.0, s, max(0.10, l - 0.16))
    for y in range(SIZE):
        t = y / float(SIZE - 1)
        d.line([(0, y), (SIZE, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    # 取景卡里的一条地平线 + 一个"主体"方块，让缩略图像画面而不是纯渐变
    horizon = int(SIZE * (0.55 + ((seed >> 8) % 12) / 100.0))
    land = hsl((h + 0.5) % 1.0, max(0.05, s - 0.15), max(0.08, l - 0.30))
    d.rectangle([0, horizon, SIZE, SIZE], fill=land)
    bw = int(SIZE * 0.26)
    bx = int(SIZE * (0.18 + ((seed >> 4) % 40) / 100.0))
    d.rectangle([bx, horizon - bw, bx + bw, horizon], fill=hsl((h + 0.02) % 1.0, s, min(0.95, l + 0.28)))
    if css == 'mono':
        pass
    if css == 'retro':
        d.rectangle([0, 0, SIZE, SIZE], outline=hsl(0.09, 0.35, 0.30), width=3)


def draw_transition(d, css, seed):
    h, s, l = TONE.get(css, (0.6, 0.4, 0.5))
    a = hsl(h, s, l)
    b = hsl((h + 0.35) % 1.0, s, l)
    d.rectangle([0, 0, SIZE, SIZE], fill=a)
    if css == 'fade':
        d.rectangle([0, 0, SIZE, SIZE], fill=b)
        for y in range(SIZE):
            t = y / float(SIZE - 1)
            d.line([(0, y), (SIZE, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    elif css == 'dissolve':
        step = 8
        for gy in range(0, SIZE, step):
            for gx in range(0, SIZE, step):
                if ((gx * 7 + gy * 13 + seed) % 23) < 11:
                    d.rectangle([gx, gy, gx + step - 1, gy + step - 1], fill=b)
    elif css in ('wipeleft', 'wiperight'):
        edge = int(SIZE * 0.5)
        if css == 'wipeleft':
            d.rectangle([0, 0, edge, SIZE], fill=b)
        else:
            d.rectangle([edge, 0, SIZE, SIZE], fill=b)
        d.line([(edge, 0), (edge, SIZE)], fill=(255, 255, 255), width=2)
    elif css in ('slideup', 'slidedown'):
        edge = int(SIZE * 0.5)
        if css == 'slideup':
            d.rectangle([0, 0, SIZE, edge], fill=b)
        else:
            d.rectangle([0, edge, SIZE, SIZE], fill=b)
        d.line([(0, edge), (SIZE, edge)], fill=(255, 255, 255), width=2)
    elif css in ('slideleft', 'slideright'):
        edge = int(SIZE * 0.62)
        if css == 'slideleft':
            d.rectangle([0, 0, edge, SIZE], fill=b)
        else:
            d.rectangle([SIZE - edge, 0, SIZE, SIZE], fill=b)
    elif css == 'circleopen':
        r = int(SIZE * 0.34)
        d.ellipse([SIZE // 2 - r, SIZE // 2 - r, SIZE // 2 + r, SIZE // 2 + r], fill=b)
        d.ellipse([SIZE // 2 - r, SIZE // 2 - r, SIZE // 2 + r, SIZE // 2 + r],
                  outline=(255, 255, 255), width=2)


def draw_fx(im, d, css, seed):
    h, s, l = TONE.get(css, (0.6, 0.4, 0.5))
    base = hsl(h, s, max(0.14, l - 0.26))
    d.rectangle([0, 0, SIZE, SIZE], fill=base)
    if css == 'fx-lightleak':
        for i in range(26):
            t = i / 25.0
            x = int(SIZE * (0.72 + 0.28 * t))
            col = hsl((h + 0.05 * t) % 1.0, 0.9, 0.45 + 0.35 * t)
            d.line([(x, 0), (x + int(SIZE * 0.22 * t), SIZE)], fill=col, width=3)
    elif css == 'fx-pulse':
        for i in range(4):
            r = int(SIZE * (0.12 + 0.20 * i))
            col = hsl(h, 0.85, 0.62 - 0.10 * i)
            d.ellipse([SIZE // 2 - r, SIZE // 2 - r, SIZE // 2 + r, SIZE // 2 + r],
                      outline=col, width=3)
    elif css == 'fx-flash':
        for i in range(30):
            t = i / 29.0
            r = int(SIZE * (0.08 + 0.5 * t))
            v = int(255 * (1 - t))
            d.ellipse([SIZE // 2 - r, SIZE // 2 - r, SIZE // 2 + r, SIZE // 2 + r],
                      outline=(v, v, v), width=1)
    elif css == 'fx-vignette':
        for i in range(24):
            t = i / 23.0
            v = int(255 * (1 - t) ** 2)
            inset = int(SIZE * 0.5 * t)
            d.rectangle([inset, inset, SIZE - inset, SIZE - inset], outline=(v, v, v), width=2)
    elif css == 'fx-glitch':
        for i in range(7):
            y = int(SIZE * (i / 7.0)) + (seed % 5)
            off = ((seed >> i) % 9) - 4
            col = hsl((h + 0.08 * i) % 1.0, 0.8, 0.55)
            d.rectangle([off, y, SIZE + off, y + int(SIZE / 9.0)], fill=col)
    elif css == 'fx-scan':
        for y in range(0, SIZE, 4):
            d.line([(0, y), (SIZE, y)], fill=hsl(h, 0.35, 0.68), width=1)
        d.rectangle([0, int(SIZE * 0.42), SIZE, int(SIZE * 0.48)], fill=(255, 255, 255))


def render(css, name):
    seed = seed_of(name, css)
    im = Image.new('RGB', (SIZE, SIZE), (24, 24, 30))
    d = ImageDraw.Draw(im)
    if css in TRANSITIONS:
        draw_transition(d, css, seed)
    elif css in FX:
        draw_fx(im, d, css, seed)
    else:
        draw_filter(d, css, seed)
    # 统一压一层细噪点：避免大面积纯色在网格里显得像占位块
    import random
    rnd = random.Random(seed)
    px = im.load()
    for _ in range(220):
        x = rnd.randrange(SIZE)
        y = rnd.randrange(SIZE)
        r, g, b = px[x, y]
        k = rnd.choice((-9, -5, 5, 9))
        px[x, y] = (max(0, min(255, r + k)), max(0, min(255, g + k)), max(0, min(255, b + k)))
    return im


def main():
    src = io.open(MAT, encoding='utf-8').read()
    pairs = ITEM_RE.findall(src)
    if not pairs:
        print('没解析到条目，正则要更新')
        return 1
    print('条目数：%d' % len(pairs))

    # 旧资产（第三方）整目录清掉，换成程序生成的图
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)

    mapping = {}
    for name, css in pairs:
        key = (name, css)
        if key in mapping:
            continue
        fn = hashlib.sha1((name + '|' + css).encode('utf-8')).hexdigest()[:12] + '.png'
        mapping[key] = fn
        render(css, name).save(os.path.join(OUT, fn), 'PNG', optimize=True)

    def repl(m):
        name, css = m.group(1), m.group(2)
        return '{ zh: "%s", thumb: "%s", css: "%s" }' % (name, mapping[(name, css)], css)

    out = ITEM_RE.sub(repl, src)
    out = out.replace(
        "const IMAGES = import.meta.glob('./assets/materials/*.{webp,gif,png,jpg}', {",
        "const IMAGES = import.meta.glob('./assets/materials/*.png', {")
    io.open(MAT, 'w', encoding='utf-8', newline='').write(out)

    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print('生成缩略图：%d 张 / %.1f MB' % (len(mapping), total / 1024.0 / 1024.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
