#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""边框素材生成器 —— 全部程序生成。

为什么自己画，而不是像贴纸那样抓现成的：
  边框素材（画框/相框）几乎没有现成的、许可允许再分发的高质量图库；
  而边框的几何本身就是「一圈有厚度的带子 + 透明窗口」，用 Pillow 画比找图更准。
  顺带的好处是没有许可问题、没有体积问题（每张 20–60 KB）、随包离线。

为什么画成 **正方形 1080×1080**：
  成片画框可能是 16:9 / 9:16 / 1:1 / 4:3。如果按 16:9 画，竖屏项目一拉就变形。
  画成正方形、边带宽度按**边长百分比**给，拉伸到任意比例时左右与上下的
  边带各占自己那一维的同一个百分比 —— 观感与 CSS 的百分比边框一致，不塌。
  唯一的代价是圆角会被拉成椭圆，这在拉远的观感上反而是自然的。

立体感（胶片齿孔、木纹、金属）全部在 1080 空间里按比例画，不写死像素坐标，
所以改画布尺寸不会出现「边带突然变细」。

用法：
    py tools/gen-borders.py                # 生成全部 + 刷新 catalog.json
    py tools/gen-borders.py --only basic   # 只重画一组
    py tools/gen-borders.py --montage      # 生成后再拼一张目检图（棋盘底，验透明）
"""

import argparse
import json
import math
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'packages', 'desktop', 'resources', 'borders')

S = 1080          # 输出边长
SS = 2            # 超采样倍数（先画 2 倍再缩，边缘才不是锯齿）
K = S * SS        # 画布实际边长

TRANSPARENT = (0, 0, 0, 0)


# --------------------------------------------------------------------------- #
# 基础工具（所有坐标都在 1080 空间里给，内部乘 K/1080 放大）
# --------------------------------------------------------------------------- #

def px(v):
    """1080 空间的长度 → 画布像素"""
    return v * K / S


def new_canvas():
    return Image.new('RGBA', (K, K), TRANSPARENT)


def mask_canvas():
    return Image.new('L', (K, K), 0)


# 全局带子倍率。1.0 时按各款自己写的厚度画，实测在 1080p 成片上只有 3~4% 的画幅，
# 看着"像一条细线"而不是"一个相框"；面板 104px 的格子里更是几乎看不见（黑框贴在
# 深色底上等于隐形）。统一放大一档，各款之间的粗细关系保持不变。
BAND_SCALE = 1.35


def band_mask(inset, thick, radius=0, size=None):
    """一圈带子的蒙版（左=255）。inset / thick / radius 都是 1080 空间的量。"""
    w = size or K
    m = Image.new('L', (w, w), 0)
    d = ImageDraw.Draw(m)
    i = px(inset)
    t = max(1, int(round(px(thick) * BAND_SCALE)))
    d.rounded_rectangle([i, i, w - 1 - i, w - 1 - i], radius=px(radius), outline=255, width=t)
    return m


def paint(img, mask, fill):
    """把 fill（颜色元组或同尺寸 RGBA 图）按蒙版**叠**到 img 上。

    ⚠️ 只需要 `layer` 自己跟 img 做一次 alpha_composite —— 早先那版把
       「已含 img 的 merged」再叠回 img，同一个像素被混了两次，
       半透明的层（噪点/光晕/织物纹理）会越叠越实，糊成一块。
       也不要图省事用 `paste(layer, mask)`：那是**替换**，
       半透明的装饰层会把底下的带子整个抠掉，露出视频。
    """
    layer = Image.new('RGBA', img.size, fill) if isinstance(fill, tuple) else fill.convert('RGBA')
    layer.putalpha(ImageChops.multiply(layer.split()[3], mask))
    out = Image.alpha_composite(img, layer)
    img.paste(out)


def lin_grad(size, stops, vertical=True):
    """线性渐变。stops = [(位置0~1, (r,g,b,a)), ...]

    ⚠️ 竖渐变要建 **1 宽 n 高** 的条；反过来建（n 宽 1 高）再按 `[0, i]` 写像素
       会一路写越界 —— 报的是 `IndexError: image index out of range`，
       位置在金边那款里，看着像金边写错了，其实是渐变工具的问题。
    """
    w, h = size
    n = h if vertical else w
    stops = sorted(stops, key=lambda s: s[0])
    rows = []
    for i in range(n):
        t = i / max(1, n - 1)
        a, b = stops[0], stops[-1]
        for j in range(len(stops) - 1):
            if stops[j][0] <= t <= stops[j + 1][0]:
                a, b = stops[j], stops[j + 1]
                break
        span = max(1e-6, b[0] - a[0])
        f = min(1.0, max(0.0, (t - a[0]) / span))
        rows.append(tuple(int(round(a[1][c] + (b[1][c] - a[1][c]) * f)) for c in range(4)))
    strip = Image.new('RGBA', (1, n) if vertical else (n, 1))
    strip.putdata(rows)
    return strip.resize((w, h), Image.BILINEAR)


def soften_border(img, alpha=90):
    """把**内沿**（透明窗口那一侧）柔化一两个像素。

    ⚠️ 只许向内柔化，不许向外扩：先模糊 alpha，再用「原 alpha 二值化后的形状」取小
       （`darker`）。直接对整幅 alpha 做高斯模糊会让**外沿**也变成半透明，
       贴到画面上就是一圈发虚的灰边 —— 而且是那种"看着脏但说不清哪脏"的脏。
    """
    a = img.split()[3]
    blurred = ImageChops.darker(a.filter(ImageFilter.GaussianBlur(px(0.9))), a.point(lambda v: 255 if v > 8 else 0))
    # 核心区（原本就接近不透明）一律用**原值**：只靠模糊值会让 7px 的细线掉到 235，
    # 白线贴到画面上就发灰了 —— 而这在缩略图上完全看不出来。
    core = a.point(lambda v: 255 if v >= 240 else 0)
    out_a = Image.composite(a, blurred, core)
    r, g, b, _ = img.split()
    return Image.merge('RGBA', (r, g, b, out_a))


# --------------------------------------------------------------------------- #
# 各款边框
# --------------------------------------------------------------------------- #

def flush_outer(img, min_cover=0.82):
    """把边框**外侧**那圈透明留白填掉，让边框真正贴到画框边缘。

    为什么必须做：素材是画在一张正方形画布里的，边缘留了几个百分点的空白。
    贴到成片里，观众会看到画面从边框外面漏出来一圈 —— 看着像"边框没铺满"的 bug，
    而缩略图上因为底下垫的是棋盘格，完全看不出来。真实机测才暴露。

    ⚠️ 只对**轮廓是实心的**款式做（覆盖率 ≥ min_cover）。角标 / 圆点 / 星光这些
       本来就是"点缀"，把最外圈一抹平会把点拉成条，反而毁了设计。
       判据用第 n 圈不透明像素的占比，不是用固定名单 —— 以后加新款自动适用。
    """
    a = img.split()[3]
    width, height = img.size
    # 找最外圈：从上往下扫，第一个"有一点不透明"的行
    px_a = a.load()
    top = 0
    for y in range(height):
        hit = 0
        for x in range(0, width, 4):
            if px_a[x, y] > 8:
                hit += 1
        if hit:
            top = y
            break
    if top <= 0:
        return img
    # 覆盖率：这一圈里有多少比例的采样点是不透明的
    total = len(range(0, width, 4))
    cover = sum(1 for x in range(0, width, 4) if px_a[x, top] > 8) / max(1, total)
    if cover < min_cover:
        return img
    out = img.copy()
    k = top
    out.paste(img.crop((0, k, width, k + 1)).resize((width, k), Image.NEAREST), (0, 0))
    out.paste(img.crop((0, height - k - 1, width, height - k)).resize((width, k), Image.NEAREST), (0, height - k))
    # 左右用**已经补好的** out 取值，否则四个角会补不上
    out.paste(out.crop((k, 0, k + 1, height)).resize((k, height), Image.NEAREST), (0, 0))
    out.paste(out.crop((width - k - 1, 0, width - k, height)).resize((k, height), Image.NEAREST), (width - k, 0))
    return out


def b_basic_white():
    img = new_canvas()
    paint(img, band_mask(34, 46, radius=26), (255, 255, 255, 255))
    return soften_border(img)


def b_basic_black():
    img = new_canvas()
    paint(img, band_mask(0, 62), (16, 16, 18, 255))
    return soften_border(img)


def b_basic_gold():
    img = new_canvas()
    outer = band_mask(30, 40, radius=18)
    inner = band_mask(30 + 40 + 14, 10, radius=8)
    grad = lin_grad((K, K), [
        (0.0, (150, 108, 34, 255)),
        (0.18, (236, 197, 106, 255)),
        (0.34, (255, 240, 190, 255)),
        (0.52, (206, 160, 62, 255)),
        (0.72, (246, 214, 132, 255)),
        (1.0, (128, 88, 26, 255)),
    ])
    paint(img, outer, grad)
    grad2 = lin_grad((K, K), [
        (0.0, (240, 206, 128, 255)),
        (0.5, (255, 246, 214, 255)),
        (1.0, (214, 172, 74, 255)),
    ], vertical=False)
    paint(img, inner, grad2)
    return soften_border(img, 110)


def b_basic_round():
    img = new_canvas()
    paint(img, band_mask(24, 92, radius=140), (255, 255, 255, 255))
    return soften_border(img)


def b_retro_film():
    img = new_canvas()
    # 上下两条黑带 + 左右细线
    top = Image.new('L', (K, K), 0)
    d = ImageDraw.Draw(top)
    d.rectangle([0, 0, K - 1, px(150)], fill=255)
    d.rectangle([0, K - 1 - px(150), K - 1, K - 1], fill=255)
    paint(img, top, (12, 11, 10, 255))
    side = mask_canvas()
    sd = ImageDraw.Draw(side)
    sd.rectangle([0, 0, px(26), K - 1], fill=255)
    sd.rectangle([K - 1 - px(26), 0, K - 1, K - 1], fill=255)
    paint(img, side, (12, 11, 10, 255))
    # 齿孔
    hole = mask_canvas()
    hd = ImageDraw.Draw(hole)
    step = px(104)
    hw, hh = px(34), px(46)
    x = step * 0.62
    while x + hw < K:
        cy = px(75)
        hd.rounded_rectangle([x, cy - hh / 2, x + hw, cy + hh / 2], radius=px(8), fill=255)
        cy2 = K - px(75)
        hd.rounded_rectangle([x, cy2 - hh / 2, x + hw, cy2 + hh / 2], radius=px(8), fill=255)
        x += step
    paint(img, hole, (246, 244, 238, 255))
    return soften_border(img)


def b_retro_polaroid():
    img = new_canvas()
    m = mask_canvas()
    d = ImageDraw.Draw(m)
    d.rectangle([0, 0, K - 1, K - 1], fill=255)
    # 挖掉窗口（偏上，下方留宽边）
    win = [px(74), px(74), K - 1 - px(74), K - 1 - px(300)]
    d.rectangle(win, fill=0)
    paint(img, m, (250, 249, 245, 255))
    # 窗口内侧一道极淡的灰影，让白框有厚度
    inner = mask_canvas()
    idr = ImageDraw.Draw(inner)
    idr.rectangle([win[0] - px(3), win[1] - px(3), win[2] + px(3), win[3] + px(3)], outline=255, width=max(1, int(px(3))))
    paint(img, inner, (206, 202, 194, 255))
    return soften_border(img, 70)


def b_retro_old():
    img = new_canvas()
    base = band_mask(22, 86)
    grad = lin_grad((K, K), [
        (0.0, (226, 208, 172, 255)),
        (0.5, (240, 228, 200, 255)),
        (1.0, (208, 186, 148, 255)),
    ])
    paint(img, base, grad)
    # 斑驳：随机的浅色污点在带子上
    rnd = random.Random(20261030)
    spots = mask_canvas()
    sd = ImageDraw.Draw(spots)
    for _ in range(260):
        x, y = rnd.uniform(0, K), rnd.uniform(0, K)
        r = rnd.uniform(px(2), px(11))
        sd.ellipse([x - r, y - r, x + r, y + r], fill=255)
    spots = Image.composite(spots, mask_canvas(), base)
    blur = spots.filter(ImageFilter.GaussianBlur(px(1.6)))
    paint(img, blur, (156, 132, 96, 150))
    return soften_border(img, 120)


def b_retro_scratch():
    img = new_canvas()
    paint(img, band_mask(18, 70), (38, 30, 24, 255))
    rnd = random.Random(77)
    sc = mask_canvas()
    sd = ImageDraw.Draw(sc)
    for _ in range(90):
        x = rnd.uniform(0, K)
        y0 = rnd.uniform(0, K)
        ln = rnd.uniform(px(20), px(190))
        wdt = max(1, int(px(rnd.uniform(0.6, 2.2))))
        ang = rnd.uniform(-0.5, 0.5)
        sd.line([x, y0, x + math.sin(ang) * ln, y0 + math.cos(ang) * ln], fill=255, width=wdt)
    band = band_mask(18, 70)
    sc = Image.composite(sc, mask_canvas(), band)
    paint(img, sc, (120, 104, 86, 150))
    # 内沿一道亮线
    paint(img, band_mask(88, 4), (96, 80, 62, 210))
    return soften_border(img, 120)


def b_min_line():
    img = new_canvas()
    paint(img, band_mask(52, 7), (255, 255, 255, 235))
    return soften_border(img, 100)


def b_min_double():
    img = new_canvas()
    paint(img, band_mask(38, 5), (255, 255, 255, 240))
    paint(img, band_mask(58, 5), (255, 255, 255, 240))
    return soften_border(img, 100)


def b_min_corner():
    img = new_canvas()
    m = mask_canvas()
    d = ImageDraw.Draw(m)
    L = px(150)
    t = max(1, int(px(9)))
    o = px(44)
    for ox, oy, sx, sy in ((0, 0, 1, 1), (1, 0, -1, 1), (0, 1, 1, -1), (1, 1, -1, -1)):
        x0 = o if ox == 0 else K - 1 - o
        y0 = o if oy == 0 else K - 1 - o
        d.line([x0, y0, x0 + sx * L, y0], fill=255, width=t)
        d.line([x0, y0, x0, y0 + sy * L], fill=255, width=t)
    paint(img, m, (255, 255, 255, 250))
    return soften_border(img, 90)


def b_min_dots():
    img = new_canvas()
    m = mask_canvas()
    d = ImageDraw.Draw(m)
    inset = px(56)
    r = px(5)
    step = px(40)
    x = inset
    while x <= K - 1 - inset:
        for y in (inset, K - 1 - inset):
            d.ellipse([x - r, y - r, x + r, y + r], fill=255)
        x += step
    y = inset + step
    while y <= K - 1 - inset - step:
        for x in (inset, K - 1 - inset):
            d.ellipse([x - r, y - r, x + r, y + r], fill=255)
        y += step
    paint(img, m, (255, 255, 255, 245))
    return soften_border(img, 90)


def b_fest_xmas():
    img = new_canvas()
    paint(img, band_mask(20, 88), (176, 26, 34, 255))
    # 绿白斜纹压在红带上
    stripe = mask_canvas()
    d = ImageDraw.Draw(stripe)
    w = int(px(46))
    for i in range(-K, K * 2, w * 2):
        d.polygon([(i, K), (i + w, K), (i + w + K, 0), (i + K, 0)], fill=255)
    band = band_mask(20, 88)
    stripe = Image.composite(stripe, mask_canvas(), band)
    paint(img, stripe, (18, 96, 52, 210))
    # 白点
    dots = mask_canvas()
    dd = ImageDraw.Draw(dots)
    rnd = random.Random(9)
    for _ in range(150):
        x, y = rnd.uniform(0, K), rnd.uniform(0, K)
        r = rnd.uniform(px(3), px(7))
        dd.ellipse([x - r, y - r, x + r, y + r], fill=255)
    dots = Image.composite(dots, mask_canvas(), band)
    paint(img, dots, (250, 250, 250, 230))
    return soften_border(img)


def b_fest_cny():
    img = new_canvas()
    paint(img, band_mask(22, 84), (198, 24, 30, 255))
    paint(img, band_mask(22 + 84 + 10, 8), (232, 196, 104, 255))
    # 金色云纹：沿带子的小圆弧
    m = mask_canvas()
    d = ImageDraw.Draw(m)
    r = px(20)
    step = px(64)
    x = px(40)
    while x < K - px(40):
        for y in (px(64), K - 1 - px(64)):
            d.arc([x - r, y - r, x + r, y + r], 200, 340, fill=255, width=max(1, int(px(8))))
        x += step
    paint(img, m, (255, 232, 166, 255))
    return soften_border(img)


def b_fest_confetti():
    img = new_canvas()
    paint(img, band_mask(16, 92), (252, 250, 246, 255))
    rnd = random.Random(4242)
    colors = [(230, 74, 74), (246, 176, 52), (66, 176, 122), (72, 132, 226), (168, 96, 214)]
    band = band_mask(16, 92)
    # 彩屑要做到"缩略图里一眼能看出是彩屑"，点必须够大够密；
    # 早先 220 个 r=3~9 的点在成品尺寸上几乎看不见，等于白画。
    dot_seed = mask_canvas()
    dd = ImageDraw.Draw(dot_seed)
    pos = []
    for _ in range(520):
        x, y = rnd.uniform(0, K), rnd.uniform(0, K)
        r = rnd.uniform(px(4), px(13))
        pos.append((x, y, r))
        dd.ellipse([x - r, y - r, x + r, y + r], fill=255)
    dot_seed = Image.composite(dot_seed, mask_canvas(), band)
    # 按竖向 5 段换色（不是 5 个矩形色块，是"每段的点用同一个颜色"）
    for i, c in enumerate(colors):
        seg = mask_canvas()
        sd = ImageDraw.Draw(seg)
        sd.rectangle([0, i * K / 5, K - 1, (i + 1) * K / 5], fill=255)
        paint(img, ImageChops.multiply(dot_seed, seg), c + (240,))
    return soften_border(img)


def b_fest_ice():
    img = new_canvas()
    paint(img, band_mask(20, 84), (212, 236, 250, 255))
    paint(img, band_mask(20, 12), (128, 182, 220, 235))
    # 雪花：六向短线。对比度要给足 —— 浅蓝底 + 浅蓝线在缩略图上等于没有。
    m = mask_canvas()
    d = ImageDraw.Draw(m)
    pts = [(px(120), px(120)), (K - px(120), px(120)), (px(120), K - px(120)), (K - px(120), K - px(120))]
    for cx, cy in pts:
        L = px(46)
        for a in range(0, 360, 60):
            rad = math.radians(a)
            d.line([cx, cy, cx + math.cos(rad) * L, cy + math.sin(rad) * L], fill=255, width=max(1, int(px(8))))
    paint(img, m, (58, 118, 176, 250))
    return soften_border(img)


def b_tex_wood():
    img = new_canvas()
    base = band_mask(14, 92)
    grad = lin_grad((K, K), [
        (0.0, (128, 82, 44, 255)),
        (0.35, (156, 104, 58, 255)),
        (0.62, (120, 76, 40, 255)),
        (1.0, (146, 96, 52, 255)),
    ])
    paint(img, base, grad)
    rnd = random.Random(5)
    grain = mask_canvas()
    gd = ImageDraw.Draw(grain)
    for _ in range(120):
        y = rnd.uniform(0, K)
        amp = rnd.uniform(px(2), px(9))
        wdt = max(1, int(px(rnd.uniform(0.8, 2.4))))
        pts = [(x, y + math.sin(x / px(160) + rnd.random() * 6) * amp) for x in range(0, K + 1, int(px(12)))]
        gd.line(pts, fill=255, width=wdt)
    grain = Image.composite(grain, mask_canvas(), base)
    grain = grain.filter(ImageFilter.GaussianBlur(px(0.6)))
    paint(img, grain, (86, 52, 26, 120))
    return soften_border(img, 110)


def b_tex_marble():
    img = new_canvas()
    base = band_mask(18, 96)
    grad = lin_grad((K, K), [
        (0.0, (242, 242, 244, 255)),
        (0.5, (226, 228, 232, 255)),
        (1.0, (238, 238, 242, 255)),
    ])
    paint(img, base, grad)
    rnd = random.Random(88)
    vein = mask_canvas()
    vd = ImageDraw.Draw(vein)
    for _ in range(34):
        x, y = rnd.uniform(0, K), rnd.uniform(0, K)
        pts = [(x, y)]
        for _ in range(rnd.randint(6, 16)):
            x += rnd.uniform(-px(70), px(70))
            y += rnd.uniform(-px(70), px(70))
            pts.append((x, y))
        vd.line(pts, fill=255, width=max(2, int(px(rnd.uniform(1.6, 4.6)))), joint='curve')
    vein = Image.composite(vein, mask_canvas(), base).filter(ImageFilter.GaussianBlur(px(1.0)))
    # 灰白大理石要是纹路太淡，成品上就是一整块白板 —— 所以给到接近不透明的灰。
    paint(img, vein, (108, 110, 120, 235))
    return soften_border(img)


def b_tex_metal():
    img = new_canvas()
    base = band_mask(16, 88, radius=10)
    grad = lin_grad((K, K), [
        (0.0, (168, 172, 178, 255)),
        (0.22, (226, 230, 236, 255)),
        (0.46, (150, 155, 162, 255)),
        (0.68, (216, 220, 228, 255)),
        (1.0, (140, 145, 152, 255)),
    ])
    paint(img, base, grad)
    # 拉丝：竖向细线
    rnd = random.Random(31)
    brush = mask_canvas()
    bd = ImageDraw.Draw(brush)
    for _ in range(420):
        x = rnd.uniform(0, K)
        bd.line([x, 0, x + rnd.uniform(-px(3), px(3)), K], fill=255, width=max(1, int(px(0.7))))
    brush = Image.composite(brush, mask_canvas(), base)
    brush = brush.filter(ImageFilter.GaussianBlur(px(0.4)))
    paint(img, brush, (255, 255, 255, 40))
    return soften_border(img, 100)


def b_tex_fabric():
    img = new_canvas()
    base = band_mask(16, 90)
    grad = lin_grad((K, K), [
        (0.0, (74, 92, 120, 255)),
        (0.5, (94, 114, 144, 255)),
        (1.0, (66, 82, 108, 255)),
    ])
    paint(img, base, grad)
    weave = mask_canvas()
    wd = ImageDraw.Draw(weave)
    step = px(7)
    for i in range(int(K / step) + 1):
        wd.line([i * step, 0, i * step, K], fill=255, width=max(1, int(px(1.6))))
        wd.line([0, i * step, K, i * step], fill=255, width=max(1, int(px(1.6))))
    weave = Image.composite(weave, mask_canvas(), base)
    paint(img, weave, (18, 26, 40, 86))
    return soften_border(img, 100)


def b_crea_neon():
    img = new_canvas()
    band = band_mask(40, 22, radius=60)
    # 光晕：把带子糊开再叠，最后画实心细带
    glow = band.filter(ImageFilter.GaussianBlur(px(26)))
    paint(img, glow, (46, 226, 244, 190))
    glow2 = band.filter(ImageFilter.GaussianBlur(px(9)))
    paint(img, glow2, (86, 240, 250, 210))
    paint(img, band, (226, 252, 255, 255))
    inner_glow = band_mask(40 + 22 + 10, 8, radius=52).filter(ImageFilter.GaussianBlur(px(14)))
    paint(img, inner_glow, (232, 92, 246, 170))
    return soften_border(img, 120)


def b_crea_torn():
    img = new_canvas()
    m = mask_canvas()
    d = ImageDraw.Draw(m)
    d.rectangle([0, 0, K - 1, K - 1], fill=255)
    # 撕边：沿**矩形四边**各取一串采样点，每点沿法线随机内缩。
    # ⚠️ 不能按圆周采样 —— 画出来是个圆洞，看着像"挖了个球"，不像撕开的相纸。
    rnd = random.Random(1234)
    inset = px(88)
    lo, hi = inset, K - 1 - inset
    amp_in, amp_out = px(6), px(15)   # 允许一点点向外毛刺，撕口才有纸纤维感
    pts = []
    n_side = 150

    def jitter():
        return rnd.uniform(-amp_in, amp_out)

    for i in range(n_side):          # 上边 → 右
        x = lo + (hi - lo) * i / n_side
        pts.append((x, lo + jitter()))
    for i in range(n_side):          # 右边 ↓
        y = lo + (hi - lo) * i / n_side
        pts.append((hi + jitter(), y))
    for i in range(n_side):          # 下边 ←
        x = hi - (hi - lo) * i / n_side
        pts.append((x, hi + jitter()))
    for i in range(n_side):          # 左边 ↑
        y = hi - (hi - lo) * i / n_side
        pts.append((lo + jitter(), y))
    d.polygon(pts, fill=0)
    paint(img, m, (252, 251, 248, 255))
    # 撕口投在画面上的那一圈阴影：只落在**窗口那一侧**（m 的反面），
    # 否则窗口中间会被整片压暗。
    blur = m.filter(ImageFilter.GaussianBlur(px(7)))
    shadow = ImageChops.multiply(blur, ImageChops.invert(m))
    paint(img, shadow, (146, 138, 124, 120))
    return soften_border(img, 60)


def b_crea_water():
    img = new_canvas()
    band = band_mask(26, 104)
    rnd = random.Random(606)
    wash = Image.new('RGBA', (K, K), TRANSPARENT)
    for _ in range(90):
        x, y = rnd.uniform(0, K), rnd.uniform(0, K)
        r = rnd.uniform(px(40), px(150))
        col = rnd.choice([(240, 132, 128), (246, 196, 120), (128, 198, 176), (146, 172, 236), (212, 150, 216)])
        blob = Image.new('RGBA', (K, K), TRANSPARENT)
        bd = ImageDraw.Draw(blob)
        bd.ellipse([x - r, y - r * 0.7, x + r, y + r * 0.7], fill=col + (110,))
        blob = blob.filter(ImageFilter.GaussianBlur(px(28)))
        wash = Image.alpha_composite(wash, blob)
    wash.putalpha(Image.composite(wash.split()[3], mask_canvas(), band))
    img = Image.alpha_composite(img, wash)
    paint(img, band_mask(26, 6), (255, 255, 255, 170))
    return soften_border(img, 130)


def b_crea_star():
    img = new_canvas()
    paint(img, band_mask(0, 96), (22, 20, 34, 250))
    paint(img, band_mask(96, 5), (206, 176, 96, 230))
    m = mask_canvas()
    d = ImageDraw.Draw(m)
    rnd = random.Random(2026)
    for _ in range(70):
        cx, cy = rnd.uniform(0, K), rnd.uniform(0, K)
        R = rnd.uniform(px(6), px(20))
        pts = []
        for i in range(10):
            a = math.pi / 2 + i * math.pi / 5
            rr = R if i % 2 == 0 else R * 0.42
            pts.append((cx + math.cos(a) * rr, cy + math.sin(a) * rr))
        d.polygon(pts, fill=255)
    band = band_mask(0, 96)
    m = Image.composite(m, mask_canvas(), band)
    paint(img, m, (246, 226, 158, 240))
    return soften_border(img, 120)


GROUPS = [
    ('basic', '基础', [
        ('br-basic-white', '白框', b_basic_white),
        ('br-basic-black', '黑框', b_basic_black),
        ('br-basic-gold', '金边', b_basic_gold),
        ('br-basic-round', '粗圆角', b_basic_round),
    ]),
    ('retro', '复古', [
        ('br-retro-film', '胶片', b_retro_film),
        ('br-retro-polaroid', '拍立得', b_retro_polaroid),
        ('br-retro-old', '旧照片', b_retro_old),
        ('br-retro-scratch', '划痕', b_retro_scratch),
    ]),
    ('minimal', '简约', [
        ('br-min-line', '细线', b_min_line),
        ('br-min-double', '双线', b_min_double),
        ('br-min-corner', '角标', b_min_corner),
        ('br-min-dots', '圆点', b_min_dots),
    ]),
    ('festival', '节日', [
        ('br-fest-xmas', '圣诞', b_fest_xmas),
        ('br-fest-cny', '新春', b_fest_cny),
        ('br-fest-confetti', '彩屑', b_fest_confetti),
        ('br-fest-ice', '冰雪', b_fest_ice),
    ]),
    ('texture', '纹理', [
        ('br-tex-wood', '木纹', b_tex_wood),
        ('br-tex-marble', '大理石', b_tex_marble),
        ('br-tex-metal', '金属', b_tex_metal),
        ('br-tex-fabric', '布纹', b_tex_fabric),
    ]),
    ('creative', '创意', [
        ('br-crea-neon', '霓虹', b_crea_neon),
        ('br-crea-torn', '撕纸', b_crea_torn),
        ('br-crea-water', '水彩', b_crea_water),
        ('br-crea-star', '星光', b_crea_star),
    ]),
]


def build(only=None):
    os.makedirs(OUT_DIR, exist_ok=True)
    catalog = {
        'source': 'self',
        'license': 'own',
        'origin': '程序生成（tools/gen-borders.py），无第三方素材',
        'size': S,
        'groups': [],
    }
    total = 0
    for gkey, gname, items in GROUPS:
        if only and only != gkey:
            continue
        gi = {'key': gkey, 'name': gname, 'items': []}
        gdir = os.path.join(OUT_DIR, gkey)
        os.makedirs(gdir, exist_ok=True)
        for key, name, fn in items:
            img = flush_outer(fn())
            out = img.resize((S, S), Image.LANCZOS)
            path = os.path.join(gdir, key + '.png')
            out.save(path, 'PNG', optimize=True)
            alpha = out.split()[3]
            lo, hi = alpha.getextrema()
            # 窗口中心必须真的透明（边框素材最容易犯的错：整幅不透明，把画面盖死）
            center = alpha.getpixel((S // 2, S // 2))
            bytes_ = os.path.getsize(path)
            gi['items'].append({
                'key': key, 'name': name,
                'file': f'{gkey}/{key}.png',
                'w': S, 'h': S, 'bytes': bytes_,
                'alpha': [lo, hi, center],
            })
            total += 1
            print(f'  {key:18s} {name:6s} {bytes_ // 1024:4d} KB  alpha={lo}-{hi} center={center}')
            if center > 8:
                print(f'    ⚠️ 中心不透明（{center}）—— 会把画面盖住', file=sys.stderr)
        catalog['groups'].append(gi)
    # 合并已有分组（--only 时不要抹掉别的组）
    cpath = os.path.join(OUT_DIR, 'catalog.json')
    if only and os.path.exists(cpath):
        try:
            old = json.load(open(cpath, encoding='utf-8'))
            by_key = {g['key']: g for g in old.get('groups', [])}
            for g in catalog['groups']:
                by_key[g['key']] = g
            catalog['groups'] = [by_key[g[0]] for g in GROUPS if g[0] in by_key]
        except Exception:
            pass
    json.dump(catalog, open(cpath, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'\n合计 {total} 张 → {os.path.relpath(OUT_DIR, ROOT)}')


def montage():
    tiles = []
    for gkey, gname, items in GROUPS:
        for key, name, _ in items:
            p = os.path.join(OUT_DIR, gkey, key + '.png')
            if os.path.exists(p):
                tiles.append((gkey, Image.open(p).convert('RGBA')))
    cell = 250
    cols = 6
    rows = (len(tiles) + cols - 1) // cols
    canvas = Image.new('RGB', (cols * cell, rows * cell), (40, 40, 40))
    # 棋盘底（验透明）
    d = ImageDraw.Draw(canvas)
    sq = 16
    for y in range(0, canvas.height, sq):
        for x in range(0, canvas.width, sq):
            if (x // sq + y // sq) % 2 == 0:
                d.rectangle([x, y, x + sq - 1, y + sq - 1], fill=(58, 58, 58))
    for i, (gkey, im) in enumerate(tiles):
        im = im.resize((cell, cell), Image.LANCZOS)
        cx = (i % cols) * cell
        cy = (i // cols) * cell
        # 格子里垫一块"画面"色，模拟边框压在视频上
        d.rectangle([cx + 4, cy + 4, cx + cell - 5, cy + cell - 5], fill=(96, 128, 168))
        canvas.paste(im, (cx, cy), im)
    outp = os.path.join(ROOT, '_evidence', 'borders-montage.png')
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    canvas.save(outp)
    print('目检图 →', os.path.relpath(outp, ROOT))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default=None)
    ap.add_argument('--montage', action='store_true')
    a = ap.parse_args()
    build(a.only)
    if a.montage:
        montage()
