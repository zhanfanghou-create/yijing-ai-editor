#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
画面特效「素材包」生成器 —— 程序化绘制一组**带动画的透明叠加素材**。

--------------------------------------------------------------------------
它解决什么问题
--------------------------------------------------------------------------
特效页里有 19 张卡是"真素材型"（泡泡 / 满屏问号 / 繁花花环 / 法阵 / 雨丝…）。
它们**不是调色、不是光效**，靠 CSS 渐变和 ffmpeg 滤镜画不出来 —— 上一版把它们
全都退化成同一个暖光扫过，用户点 20 张不同的卡看到的是同一个东西。

现在它们走**素材包**（`.yjpack`，kind = yijing-fxpack）：包内每个效果是一段
透明 PNG 序列（给导出用）+ 一张横向雪碧图（给预览用），预览与成片叠的是同一批像素。

--------------------------------------------------------------------------
为什么是 PNG 序列 + 雪碧图，而不是带 alpha 的视频
--------------------------------------------------------------------------
Chromium 能**播** VP9 alpha 的 webm，但 ffmpeg 编不出来（只能编 ProRes/qtrle，
而 Chromium 又播不了 MOV）—— 详见 PITFALLS 25.1。所以预览与成片若要**同一份像素**，
只能落在 PNG 序列上：
  · 预览 → 雪碧图 + CSS steps() 步进，一条规则播所有帧，不需要 JS 播放器；
  · 导出 → ffmpeg `-framerate N -i f%03d.png` + overlay。
两者由**同一次绘制**产出，不存在"预览好看、成片不是那个东西"。

--------------------------------------------------------------------------
循环必须无缝
--------------------------------------------------------------------------
所有元素都按 `t = i/N ∈ [0,1)` 用周期函数算位置；线性运动的元素（上浮/下落）
用取模 + 两端淡入淡出，保证第 N-1 帧接回第 0 帧时看不出跳变。
`check-fx-packs` 会量首尾帧的差异来钉这一条。

用法：
    python tools/gen-fx-packs.py            # 生成并打包
    python tools/gen-fx-packs.py --preview  # 只出几张联系图看效果
"""
import json
import math
import os
import random
import shutil
import subprocess
import sys
import zipfile

from PIL import Image, ImageDraw, ImageFilter

# 底片统一从 tools/thumb_base.py 取（真源是本地素材包 frames.yjpack）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import thumb_base

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BUILD = os.path.join(ROOT, 'tools', 'fxpacks-src')
OUT_PACK = os.path.join(ROOT, 'packages', 'desktop', 'resources', 'fxpacks', 'overlay-fx.yjpack')

# 序列尺寸：叠加素材不需要跟画布同分辨率，overlay 时会拉伸。
# 480×270 在 1080p 上放大 4 倍仍够用（这些元素本身是软边光斑/文字，不是硬边图表）。
W, H = 480, 270
SS = 2                      # 超采样倍数（先画 960×540 再 LANCZOS 缩下来当抗锯齿）
N = 30                      # 帧数
FPS = 10                    # 播放帧率 → 一个循环 3 秒
SHEET_W, SHEET_H = 192, 108  # 雪碧图单帧尺寸（预览用，和缩略图同一档）


def hsl(h, s, l, a=255):
    """HSL → RGBA（s/l 是 0~1，h 是 0~1）。与 gen-material-thumbs.py 同一套公式。"""
    if s == 0:
        v = int(round(l * 255))
        return (v, v, v, a)
    def hue(p, q, t):
        t = t % 1.0
        if t < 1 / 6: return p + (q - p) * 6 * t
        if t < 0.5: return q
        if t < 2 / 3: return p + (q - p) * (2 / 3 - t) * 6
        return p
    q = l * (1 + s) if l < 0.5 else l + s - l * s
    p = 2 * l - q
    return (int(round(hue(p, q, h + 1 / 3) * 255)),
            int(round(hue(p, q, h) * 255)),
            int(round(hue(p, q, h - 1 / 3) * 255)), a)


def fade_edges(v, low=0.0, high=1.0, soft=0.18):
    """把"进入/离开画面"的那一小段做淡入淡出，避免元素在边上啪地出现。"""
    if v < low or v > high:
        return 0.0
    return min(1.0, (v - low) / soft, (high - v) / soft)


def canvas():
    im = Image.new('RGBA', (W * SS, H * SS), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im, 'RGBA')


# ------------------------------------------------------------------ 绘制器
# 约定：每个 draw(t) 返回一张 (W*SS, H*SS) 的 RGBA 图，外层负责缩到 W×H。
# t ∈ [0, 1) 是一个完整循环的位置。

def fx_bubble(t):
    """泡泡：一串大小不一的肥皂泡从下往上浮，边缘高光 + 内部极淡折射。

    泡泡的"像"全在两处：边缘那圈断续的高光，和顶部一个亮斑。画满一个圆环
    反而像塑料球，所以环的透明度做成径向衰减、并让每帧有轻微形变。
    """
    im, d = canvas()
    rnd = random.Random(11)
    for i in range(13):
        bx = rnd.uniform(0.04, 0.96)
        r0 = rnd.uniform(0.018, 0.062)
        speed = rnd.uniform(0.55, 1.25)
        phase = rnd.uniform(0, 1)
        wob = rnd.uniform(4.0, 8.0)
        u = (t * speed + phase) % 1.0
        y = H * SS * (1.18 - u * 1.42)
        r = r0 * W * SS
        x = bx * W * SS + math.sin((t * speed * wob) + phase * 6.28) * r * 0.55
        alpha = 0.72 * fade_edges(u, 0.02, 0.94, 0.16)
        if alpha <= 0.01:
            continue
        a = int(210 * alpha)
        # 内部极淡的填充，让泡泡有体积
        d.ellipse([x - r, y - r, x + r, y + r], fill=(210, 235, 255, int(a * 0.10)))
        # 圆环：由外到内三层递减，模拟膜的厚度
        for k, (rr, aa) in enumerate(((1.0, 0.55), (0.90, 0.30), (0.80, 0.12))):
            d.ellipse([x - r * rr, y - r * rr, x + r * rr, y + r * rr],
                      outline=(235, 248, 255, int(a * aa)), width=max(1, int(r * 0.055)))
        # 左上高光弧
        d.arc([x - r * 0.82, y - r * 0.82, x + r * 0.82, y + r * 0.82],
              start=195, end=300, fill=(255, 255, 255, int(a * 0.95)),
              width=max(1, int(r * 0.14)))
        # 右下反光点
        d.ellipse([x + r * 0.30, y + r * 0.34, x + r * 0.56, y + r * 0.60],
                  fill=(255, 255, 255, int(a * 0.42)))
    return im


def _question(d, cx, cy, r, color, w):
    """几何问号：上半圆弧 → 拐进中线 → 竖直落下 → 一点。

    ⚠️ 引线不能一笔从弧端斜拉到点：那样看着是「钩子」不是问号。
       真实字形的尾巴是**先内收再竖直**，所以这里用两段折线 + `joint='curve'`。
    """
    d.arc([cx - r, cy - r, cx + r, cy + r], start=168, end=392, fill=color, width=w)
    ex = cx + r * math.cos(math.radians(32))
    ey = cy + r * math.sin(math.radians(32))
    mid = (cx + r * 0.06, cy + r * 0.70)
    d.line([(ex, ey), (mid[0] + r * 0.12, mid[1] - r * 0.18)], fill=color, width=w, joint='curve')
    d.line([(mid[0] + r * 0.12, mid[1] - r * 0.18), mid], fill=color, width=w, joint='curve')
    # 尾巴末端往前再走一小段（贴合真实字形）
    d.line([mid, (mid[0], mid[1] + r * 0.12)], fill=color, width=w, joint='curve')
    d.ellipse([cx - w * 0.80, cy + r * 1.24, cx + w * 0.80, cy + r * 1.24 + w * 1.6], fill=color)


def fx_question(t):
    """满屏问号：问号在画面里慢慢上浮 + 自转，透明度呼吸。"""
    im, d = canvas()
    rnd = random.Random(23)
    for i in range(8):
        bx = rnd.uniform(0.10, 0.90)
        r0 = rnd.uniform(0.032, 0.082)
        speed = rnd.uniform(0.35, 0.8)
        phase = rnd.uniform(0, 1)
        u = (t * speed + phase) % 1.0
        y = H * SS * (1.10 - u * 1.25)
        r = r0 * W * SS
        x = bx * W * SS + math.sin((t + phase) * 6.28) * r * 0.45
        alpha = 0.55 * fade_edges(u, 0.04, 0.95, 0.20)
        if alpha <= 0.01:
            continue
        a = int(255 * alpha)
        _question(d, x, y, r, (255, 255, 255, a), max(2, int(r * 0.20)))
    return im


def _heart_points(cx, cy, s):
    pts = []
    for k in range(72):
        ang = k / 72 * 2 * math.pi
        hx = 16 * math.sin(ang) ** 3
        hy = -(13 * math.cos(ang) - 5 * math.cos(2 * ang) - 2 * math.cos(3 * ang) - math.cos(4 * ang))
        pts.append((cx + hx * s / 16.0, cy + hy * s / 16.0))
    return pts


def fx_heart(t):
    """爱心漂浮：粉红爱心上浮 + 轻微摆动，边缘带一点柔光。"""
    im, d = canvas()
    rnd = random.Random(37)
    for i in range(9):
        bx = rnd.uniform(0.10, 0.90)
        r0 = rnd.uniform(0.030, 0.070)
        speed = rnd.uniform(0.45, 0.95)
        phase = rnd.uniform(0, 1)
        u = (t * speed + phase) % 1.0
        y = H * SS * (1.12 - u * 1.30)
        r = r0 * W * SS
        x = bx * W * SS + math.sin((t + phase) * 6.28) * r * 0.7
        alpha = 0.80 * fade_edges(u, 0.03, 0.95, 0.16)
        if alpha <= 0.01:
            continue
        a = int(255 * alpha)
        d.polygon(_heart_points(x, y, r), fill=(255, 150, 190, a))
        # 下半部压亮一点，做出体积（不是简单地再画一个更小的）
        d.polygon(_heart_points(x, y + r * 0.10, r * 0.80), fill=(255, 186, 214, int(a * 0.45)))
    # 柔光整层做一次（同 fx_flower 的理由：逐元素全画布模糊太贵）
    glow = im.filter(ImageFilter.GaussianBlur(W * SS * 0.012))
    glow.putalpha(glow.getchannel('A').point(lambda v: int(v * 0.55)))
    return Image.alpha_composite(im, glow)


def _petal(d, cx, cy, r, ang, color):
    """一片花瓣：以 (cx,cy) 为根的旋转椭圆。"""
    ca, sa = math.cos(ang), math.sin(ang)
    pts = []
    for k in range(28):
        th = k / 28 * 2 * math.pi
        px, py = r * math.cos(th), r * 0.42 * math.sin(th)
        pts.append((cx + px * ca - py * sa + r * ca * 0.9, cy + px * sa + py * ca + r * sa * 0.9))
    d.polygon(pts, fill=color)


def fx_flower(t):
    """繁花环绕：沿画面边缘一圈花朵，整组缓慢旋转，中心留空不挡主体。

    ⚠️ 花要"看得见"：第一版半径只取 0.030W、颜色还压到 l=0.80，缩到 192 的雪碧图里
       只剩一个个灰点。现在放大到 0.045W、饱和度提到 0.78，并给每朵加一层柔光，
       于是它既是"花"，也还带着这一组的粉色氛围。
    """
    im = canvas()[0]
    d = ImageDraw.Draw(im, 'RGBA')
    rot = t * 2 * math.pi
    n = 10
    for i in range(n):
        ang = i / n * 2 * math.pi + rot
        # 椭圆环：横向拉长、纵向压扁 → 落在画面四边，中心是空的
        # ⚠️ 半径要贴边（0.50 / 0.47）：0.45 时最靠里那几朵会压到人物脸上。
        x = W * SS * 0.5 + math.cos(ang) * W * SS * 0.50
        y = H * SS * 0.5 + math.sin(ang) * H * SS * 0.47
        depth = 0.68 + 0.32 * abs(math.sin(ang))
        r = W * SS * 0.034 * depth
        breathe = 0.85 + 0.15 * math.sin(ang * 2 + rot * 2)
        a = int(222 * breathe)
        huev = 0.93 if i % 2 == 0 else 0.87
        for k in range(5):
            _petal(d, x, y, r, ang + k / 5 * 2 * math.pi, hsl(huev, 0.72, 0.86, int(a * 0.92)))
        d.ellipse([x - r * 0.34, y - r * 0.34, x + r * 0.34, y + r * 0.34],
                  fill=hsl(0.13, 0.90, 0.74, a))
    # 辉光：整层模糊一次再压回去。**不能每朵花各模糊一张全画布图**——
    # 12 朵 × 30 帧 × 960×540 的高斯模糊，既慢又让每帧多出 100KB 不可压缩的软边。
    glow = im.filter(ImageFilter.GaussianBlur(W * SS * 0.018))
    glow.putalpha(glow.getchannel('A').point(lambda v: int(v * 0.42)))
    return Image.alpha_composite(im, glow)


def fx_particle(t):
    """微粒效应：细小的亮点闪烁 + 缓慢漂移，像空气里的尘埃被光照到。"""
    im, d = canvas()
    rnd = random.Random(53)
    for i in range(90):
        bx = rnd.uniform(0, 1)
        by = rnd.uniform(0, 1)
        speed = rnd.uniform(0.12, 0.45)
        phase = rnd.uniform(0, 1)
        size = rnd.uniform(0.8, 2.4) * SS
        u = (t * speed + phase) % 1.0
        y = by * H * SS - u * H * SS * 0.35
        x = bx * W * SS + math.sin((t + phase) * 6.28) * 6 * SS
        tw = 0.35 + 0.65 * (0.5 + 0.5 * math.sin((t * 3.0 + phase) * 6.28))
        a = int(235 * tw * fade_edges(u, 0.0, 1.0, 0.12))
        if a <= 4:
            continue
        d.ellipse([x - size, y - size, x + size, y + size], fill=(255, 252, 235, a))
    # 再叠一层大一点的柔光点，做出景深
    for i in range(16):
        rnd2 = random.Random(900 + i)
        bx, by = rnd2.uniform(0, 1), rnd2.uniform(0, 1)
        phase = rnd2.uniform(0, 1)
        u = (t * 0.2 + phase) % 1.0
        y = by * H * SS - u * H * SS * 0.25
        tw = 0.5 + 0.5 * math.sin((t + phase) * 6.28)
        a = int(120 * tw)
        if a <= 4:
            continue
        r = 3.2 * SS
        d.ellipse([bx * W * SS - r, y - r, bx * W * SS + r, y + r], fill=(255, 240, 210, a))
    return im.filter(ImageFilter.GaussianBlur(0.6 * SS))


def fx_mandala(t):
    """法阵：同心圆 + 放射线 + 内接多边形，整体匀速旋转，中心半透明。

    ⚠️ 透明度不能压太低：这些线只有 1~2px 宽，alpha 100 叠在亮画面上几乎看不见
       （第一版就是这样，缩略图里像一张空白图）。现在主线 alpha 到 190，
       并且整层再过一次大半径模糊做辉光 —— 它要"发光"，不是"铅笔线"。
    """
    im = canvas()[0]
    d = ImageDraw.Draw(im, 'RGBA')
    cx, cy = W * SS / 2, H * SS / 2
    rot = t * 2 * math.pi
    R = H * SS * 0.46
    gold = hsl(0.11, 0.78, 0.66)
    for ring, (rr, wdt, al) in enumerate(((1.00, 0.014, 190), (0.86, 0.010, 150), (0.52, 0.012, 170))):
        d.ellipse([cx - R * rr, cy - R * rr, cx + R * rr, cy + R * rr],
                  outline=gold[:3] + (al,), width=max(1, int(R * wdt)))
    # 24 条放射短线
    for i in range(24):
        ang = i / 24 * 2 * math.pi + rot
        r1, r2 = R * 0.86, R * (1.0 if i % 2 == 0 else 0.93)
        d.line([(cx + math.cos(ang) * r1, cy + math.sin(ang) * r1),
                (cx + math.cos(ang) * r2, cy + math.sin(ang) * r2)],
               fill=gold[:3] + (205,), width=max(1, int(R * 0.014)))
    # 两个反向旋转的多边形 + 一个沿圆周跑的光点
    # ⚠️ 不能全是**对称**图形：六边形每 60° 重合、24 条放射线每 15° 重合，
    #    于是"在转"和"没转"逐帧完全一样（三帧联系图一模一样）。五边形 + 一个
    #    单点标记才看得出运动，否则用户以为特效是张静态图。
    for sign, rr, sides, al in ((1, 0.72, 5, 175), (-1, 0.44, 3, 150)):
        pts = [(cx + math.cos(rot * sign + k / sides * 2 * math.pi + math.pi / 6) * R * rr,
                cy + math.sin(rot * sign + k / sides * 2 * math.pi + math.pi / 6) * R * rr)
               for k in range(sides)]
        d.polygon(pts, outline=gold[:3] + (al,), width=max(1, int(R * 0.010)))
    ang = rot * 2
    bx, by = cx + math.cos(ang) * R * 0.93, cy + math.sin(ang) * R * 0.93
    d.ellipse([bx - R * 0.05, by - R * 0.05, bx + R * 0.05, by + R * 0.05], fill=gold[:3] + (255,))
    glow = im.filter(ImageFilter.GaussianBlur(R * 0.035))
    glow.putalpha(glow.getchannel('A').point(lambda v: int(v * 0.85)))
    return Image.alpha_composite(im, glow)


def fx_moon(t):
    """关月亮：右上角一弯月牙 + 几颗星，月色从亮到暗再亮起（一个循环 = 关掉又亮起）。

    ⚠️ 只有月亮"变亮变暗"是不够的：帧间差实测只有 0.25，用户看上去就是一张静止图。
       月亮本身还在缓慢上下浮动，另加 5 颗**不同相位**闪烁的星 —— 只要有东西在动，
       眼睛就会认为这一层是活的，而不是"加了个贴纸"。
    """
    im, d = canvas()
    u = t * 2 * math.pi
    cx = W * SS * 0.80
    cy = H * SS * 0.22 + math.sin(u) * H * SS * 0.012
    R = H * SS * 0.16
    level = 0.45 + 0.55 * (0.5 + 0.5 * math.cos(u))       # 亮度呼吸
    mask = Image.new('L', im.size, 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([cx - R, cy - R, cx + R, cy + R], fill=255)
    md.ellipse([cx - R * 0.55, cy - R * 1.12, cx + R * 1.05, cy + R * 0.88], fill=0)
    halo = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse([cx - R * 1.6, cy - R * 1.6, cx + R * 1.6, cy + R * 1.6],
                                 fill=(255, 246, 210, int(46 * level)))
    im.alpha_composite(halo.filter(ImageFilter.GaussianBlur(R * 0.45)))
    moon = Image.new('RGBA', im.size, (255, 248, 214, int(238 * level)))
    im.paste(moon, (0, 0), mask)
    # 五颗星，相位错开；位置固定，只有亮度在变
    rnd = random.Random(131)
    for i in range(5):
        sx = rnd.uniform(0.06, 0.46) * W * SS
        sy = rnd.uniform(0.08, 0.55) * H * SS
        sr = rnd.uniform(0.8, 1.8) * SS
        phase = rnd.uniform(0, 1)
        tw = 0.35 + 0.65 * (0.5 + 0.5 * math.sin((t * 2 + phase) * 2 * math.pi))
        a = int(235 * tw * level)
        if a <= 4:
            continue
        d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=(255, 252, 236, a))
        # 十字星芒（大一点的那两颗）
        if sr > 1.3 * SS:
            d.line([(sx - sr * 2.6, sy), (sx + sr * 2.6, sy)], fill=(255, 252, 236, int(a * 0.55)), width=1)
            d.line([(sx, sy - sr * 2.6), (sx, sy + sr * 2.6)], fill=(255, 252, 236, int(a * 0.55)), width=1)
    return im


def _capsule(d, p1, p2, wd, fill):
    """两端带半圆的粗线（拇指、手指都用它）。PIL 的 line 端点切平，直接画会像根火柴。"""
    d.line([p1, p2], fill=fill, width=int(wd))
    r = wd / 2
    for px, py in (p1, p2):
        d.ellipse([px - r, py - r, px + r, py + r], fill=fill)


def fx_thumbsup(t):
    """点赞：金色拇指图标往上飘，边飘边缩小淡出。

    ⚠️ 造型不是"方块 + 竖条"：第一版就是这么拼的，看着像根香肠。
       真实的 `thumb_up` 是「右下方一块手掌 + 从手掌左上斜出去的拇指」，
       拇指是**斜的**（约 -120°），这是它一眼能被认出来的关键。
    """
    im, d = canvas()
    rnd = random.Random(71)
    for i in range(7):
        bx = rnd.uniform(0.14, 0.86)
        speed = rnd.uniform(0.5, 1.0)
        phase = rnd.uniform(0, 1)
        u = (t * speed + phase) % 1.0
        y = H * SS * (1.10 - u * 1.28)
        x = bx * W * SS + math.sin((t + phase) * 6.28) * 9 * SS
        alpha = 0.88 * fade_edges(u, 0.02, 0.92, 0.14)
        if alpha <= 0.01:
            continue
        a = int(255 * alpha)
        s = W * SS * 0.062 * (1.0 - 0.22 * u)
        gold = (255, 190, 62, a)
        deep = (226, 142, 22, a)
        # 袖口（左下那一小条）
        d.rounded_rectangle([x - s * 0.72, y + s * 0.10, x - s * 0.48, y + s * 0.92],
                            radius=s * 0.07, fill=deep)
        # 手掌
        d.rounded_rectangle([x - s * 0.50, y + s * 0.22, x + s * 0.62, y + s * 0.92],
                            radius=s * 0.16, fill=gold)
        # 拇指：从手掌左上角斜出去
        _capsule(d, (x - s * 0.10, y + s * 0.18), (x - s * 0.58, y - s * 0.72), s * 0.34, gold)
        # 指缝（两根短横，让手掌不是一块实心板）
        for k in range(2):
            yy = y + s * (0.44 + k * 0.22)
            d.line([(x + s * 0.02, yy), (x + s * 0.58, yy)], fill=deep, width=max(1, int(s * 0.045)))
        # 高光
        d.line([(x - s * 0.42, y - s * 0.56), (x - s * 0.22, y - s * 0.24)],
               fill=(255, 244, 206, int(a * 0.70)), width=max(1, int(s * 0.075)))
    return im


def fx_rain(t):
    """凄凉：斜向雨丝下落 + 底部一层湿冷的雾。"""
    im, d = canvas()
    rnd = random.Random(97)
    for i in range(120):
        bx = rnd.uniform(0, 1.15)
        by = rnd.uniform(0, 1)
        ln = rnd.uniform(0.045, 0.11) * H * SS
        speed = rnd.uniform(0.9, 1.6)
        u = (t * speed + by) % 1.0
        y = u * (H * SS + ln) - ln
        x = bx * W * SS - u * W * SS * 0.18
        a = int(120 * rnd.uniform(0.5, 1.0))
        d.line([(x, y), (x + ln * 0.22, y + ln)], fill=(214, 232, 255, a), width=max(1, int(1.1 * SS)))
    mist = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ImageDraw.Draw(mist).rectangle([0, H * SS * 0.62, W * SS, H * SS], fill=(150, 176, 200, 40))
    im.alpha_composite(mist.filter(ImageFilter.GaussianBlur(H * SS * 0.06)))
    return im


def fx_focus(t):
    """焦点框：四角虚线括号 + 呼吸的取景框 + 一条扫描线，像相机在对焦。

    「箭头聚焦 / 虚线焦点 / 焦点控制 / 焦点掌控」这四张卡共用它 ——
    它们本来就是同一种东西（取景框），给四个不同的框反而更假。
    """
    im = canvas()[0]
    d = ImageDraw.Draw(im, 'RGBA')
    u = t * 2 * math.pi
    # 呼吸：框在 4% 范围内缩放，像自动对焦在找
    k = 1.0 + 0.04 * math.sin(u)
    bw, bh = W * SS * 0.30 * k, H * SS * 0.34 * k
    cx, cy = W * SS * 0.5, H * SS * 0.5
    x0, x1 = cx - bw, cx + bw
    y0, y1 = cy - bh, cy + bh
    col = (255, 255, 255, 225)
    arm = min(bw, bh) * 0.34
    wd = max(1, int(W * SS * 0.0035))
    for (px, py, sx, sy) in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        d.line([(px, py), (px + sx * arm, py)], fill=col, width=wd)
        d.line([(px, py), (px, py + sy * arm)], fill=col, width=wd)
    # 中心十字
    cc = max(1, int(W * SS * 0.003))
    d.line([(cx - arm * 0.42, cy), (cx + arm * 0.42, cy)], fill=(255, 255, 255, 180), width=cc)
    d.line([(cx, cy - arm * 0.42), (cx, cy + arm * 0.42)], fill=(255, 255, 255, 180), width=cc)
    # 扫描线：自上而下走一趟，走到头淡出
    sy = y0 + (y1 - y0) * t
    sa = int(200 * fade_edges(t, 0.0, 1.0, 0.12))
    if sa > 4:
        line = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(line, 'RGBA').line([(x0, sy), (x1, sy)],
                                          fill=(190, 240, 255, sa), width=max(1, int(W * SS * 0.004)))
        im.alpha_composite(line.filter(ImageFilter.GaussianBlur(W * SS * 0.004)))
    # 角标外发光，让白线在任何底色上都不丢
    glow = im.filter(ImageFilter.GaussianBlur(W * SS * 0.006))
    glow.putalpha(glow.getchannel('A').point(lambda v: int(v * 0.45)))
    return Image.alpha_composite(im, glow)


EFFECTS = [
    ('fm-bubble', '泡泡', fx_bubble),
    ('fm-question', '满屏问号', fx_question),
    ('fm-heart', '爱心漂浮', fx_heart),
    ('fm-flower', '繁花环绕', fx_flower),
    ('fm-particle', '微粒效应', fx_particle),
    ('fm-mandala', '法阵', fx_mandala),
    ('fm-moon', '关月亮', fx_moon),
    ('fm-thumbsup', '点赞', fx_thumbsup),
    ('fm-rain', '雨丝', fx_rain),
    ('fm-focus', '焦点框', fx_focus),
]


def build_one(key, fn):
    """出一套帧 + 一张雪碧图。返回 (帧目录, 雪碧图路径, 单帧字节合计)。"""
    fdir = os.path.join(BUILD, 'frames', key)
    if os.path.isdir(fdir):
        shutil.rmtree(fdir)
    os.makedirs(fdir)
    sheet = Image.new('RGBA', (SHEET_W * N, SHEET_H), (0, 0, 0, 0))
    total = 0
    for i in range(N):
        big = fn(i / N)
        small = big.resize((W, H), Image.LANCZOS)
        path = os.path.join(fdir, 'f%03d.png' % i)
        small.save(path, 'PNG', optimize=True)
        total += os.path.getsize(path)
        sheet.paste(small.resize((SHEET_W, SHEET_H), Image.LANCZOS), (SHEET_W * i, 0))
    sdir = os.path.join(BUILD, 'sheets')
    os.makedirs(sdir, exist_ok=True)
    spath = os.path.join(sdir, key + '.webp')
    sheet.save(spath, 'WEBP', quality=82, method=6)
    return fdir, spath, total, os.path.getsize(spath)


def write_contact_sheets():
    """把每个效果的第 0/10/20 帧**叠到真实画面**上拼成联系图（不参与打包）。

    ⚠️ 一定要用真实底片、不能用纯色底：这批素材是半透明白/浅色，
       在黑底上"看着很清楚"，叠到正常画面上很可能直接消失。
       底片取自本地素材包（`tools/thumb_base.py`，与缩略图同一张）。
    """
    os.makedirs(os.path.join(BUILD, 'contact'), exist_ok=True)
    base = thumb_base.base('a', size=(W, H)).convert('RGBA')
    for key, label, fn in EFFECTS:
        out = Image.new('RGBA', (W * 3, H))
        for i, idx in enumerate((0, N // 3, 2 * N // 3)):
            tile = base.copy()
            tile.alpha_composite(fn(idx / N).resize((W, H), Image.LANCZOS))
            out.paste(tile, (W * i, 0))
        out.convert('RGB').save(os.path.join(BUILD, 'contact', key + '.png'))


def pack(entries):
    """打成 .yjpack：kind 是 yijing-fxpack，和工程包共存于同一个扩展名但不同 kind。"""
    os.makedirs(os.path.dirname(OUT_PACK), exist_ok=True)
    manifest = {
        'kind': 'yijing-fxpack',
        'version': 1,
        'name': '叠加特效素材包',
        'fps': FPS,
        'frames': N,
        'sheet': {'width': SHEET_W, 'height': SHEET_H},
        'effects': [
            {
                'key': key,
                'label': label,
                'frames': N,
                'fps': FPS,
                'dir': 'frames/' + key,
                'sheet': 'sheets/' + key + '.webp',
                'bytes': frames_bytes
            }
            for (key, label, frames_bytes) in entries
        ]
    }
    with zipfile.ZipFile(OUT_PACK, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        for key, _label, _b in entries:
            fdir = os.path.join(BUILD, 'frames', key)
            for name in sorted(os.listdir(fdir)):
                zf.write(os.path.join(fdir, name), 'frames/%s/%s' % (key, name))
            zf.write(os.path.join(BUILD, 'sheets', key + '.webp'), 'sheets/%s.webp' % key)
    return manifest


def main():
    if '--preview' in sys.argv:
        write_contact_sheets()
        print('联系图：', os.path.join(BUILD, 'contact'))
        return
    entries = []
    for key, label, fn in EFFECTS:
        _fdir, spath, fb, sb = build_one(key, fn)
        entries.append((key, label, fb))
        print('%-14s 帧 %5.1f KB  雪碧图 %5.1f KB' % (key, fb / 1024, sb / 1024))
    manifest = pack(entries)
    size = os.path.getsize(OUT_PACK)
    print('打包：%s（%d 个效果，%.2f MB）' % (OUT_PACK, len(manifest['effects']), size / 1024 / 1024))
    write_contact_sheets()


if __name__ == '__main__':
    main()
