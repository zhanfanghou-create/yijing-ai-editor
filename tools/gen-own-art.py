"""
gen-own-art.py —— 生成**自有版权**的配图（现 12 张，只有「背景」一族）。

⚠️ 只生成界面**真的挂载**的族：artSet.js 的 ART_FAMILIES 里有什么，这里才画什么。
   数字人 / 图片增强 / 文生图 / 智能剪辑 / 视频模型那些族以前也在这里，
   但开源版没有对应的 AI 功能（入口已整体移除），界面不挂载、盘上也没有那些图，
   于是 2026-10-07 把它们的画函数与生成计划一并删了 —— 留着就是死代码，
   而且每一族都在注释里写着"这是某某 AI 功能的卡片"。

---------------------------------------------------------------------------
为什么是"程序画"而不是"找图"或"AI 生成"
---------------------------------------------------------------------------
`assets/art/**` 原来是从参考客户端资源目录里导出的**他人作品**
（当时记在根目录 PLACEHOLDERS.json 的 ref-art-set，那份清单已随去标识一起删除）。
换掉它们有两条路：买授权图库，或自己画。这里选自己画，且用**脚本画**，理由：

1. **成套**：一排卡片要"看起来是一族的"。AI 逐张生成会各画各的（风格、配色、
   构图全飘），脚本能保证同一族的几何语言与调色板逐张一致。
2. **可复查**：每张图都是一段确定性代码（seeded），换一台机器重跑逐字节一致，
   改一处参数全族一起变。这是"素材也是代码"的同一个纪律。
3. **零侵权面**：不使用任何人脸照片、影视剧照、品牌标识，也不使用第三方图标字体。

⚠️ 硬约束：
   · **不使用任何人脸照片、影视剧照、品牌标识**，也不用第三方图标字体；
     要人物就用几何色块，不画五官特写。
   · **第三方品牌名必须去标识** —— 文件名与界面文案里出现的第三方模型 / 厂商商标
     一律换成中性名（原名清单不再写进本文件，免得仓库里长期留着一份别人的商标列表
     —— 需要时查历史提交）。

用法：
   python tools/gen-own-art.py            # 生成并落盘（会先删旧的同族图）
   python tools/gen-own-art.py --dry      # 只列将要写的文件，不落盘
"""

import os
import math
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageEnhance, ImageChops

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ASSETS = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets')
# ⚠️ 目录名是 `art`（去标识时从 ref-art 改过来的），改回来会让 art-consumed 那道闸读不到图
ART = os.path.join(ASSETS, 'art')
DRY = '--dry' in sys.argv

# ────────────────────────────── 基础画笔 ──────────────────────────────

def new(size, color):
    return Image.new('RGB', size, color)


def mix(c1, c2, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))


def vgrad(size, top, bottom):
    """竖直渐变。"""
    w, h = size
    strip = Image.new('RGB', (1, h))
    px = strip.load()
    for y in range(h):
        px[0, y] = mix(top, bottom, y / max(1, h - 1))
    return strip.resize(size, Image.BILINEAR)


def dgrad(size, c1, c2, c3=None):
    """左上→右下 斜向渐变（c3 给三段渐变用）。"""
    w, h = size
    im = Image.new('RGB', size)
    px = im.load()
    denom = max(1, (w - 1) + (h - 1))
    for y in range(h):
        for x in range(w):
            t = (x + y) / denom
            if c3 is None:
                px[x, y] = mix(c1, c2, t)
            elif t < 0.5:
                px[x, y] = mix(c1, c3, t * 2)
            else:
                px[x, y] = mix(c3, c2, (t - 0.5) * 2)
    return im


def rrect(im, box, r, fill=None, outline=None, width=1):
    ImageDraw.Draw(im).rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def circ(im, cx, cy, r, fill=None, outline=None, width=1):
    ImageDraw.Draw(im).ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill, outline=outline, width=width)


def poly(im, pts, fill=None, outline=None, width=1):
    ImageDraw.Draw(im).polygon(pts, fill=fill, outline=outline, width=width)


def pline(im, pts, color, width, joint=None):
    kw = {'fill': color, 'width': width}
    if joint:
        kw['joint'] = joint
    ImageDraw.Draw(im).line(pts, **kw)


def arc(im, box, start, end, color, width):
    ImageDraw.Draw(im).arc(box, start, end, fill=color, width=width)


def clipped(im, box, r, fn):
    """在圆角矩形区域里画：内容画到子图上，再按圆角蒙版贴回（超出部分被裁掉）。"""
    x0, y0, x1, y1 = box
    sub = im.crop(box).copy()
    fn(sub)
    mask = Image.new('L', sub.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sub.size[0] - 1, sub.size[1] - 1), radius=r, fill=255)
    im.paste(sub, (x0, y0), mask)


def soft_shadow(im, box, r, color=(0, 0, 0), blur=10, alpha=90, dy=4):
    """卡片底下的柔和投影（商业软件里给平面构图加纵深的标准手法）。"""
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    m = Image.new('L', im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((box[0], box[1] + dy, box[2], box[3] + dy), radius=r, fill=alpha)
    layer.paste(color + (alpha,), (0, 0), m)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    im.paste(Image.alpha_composite(im.convert('RGBA'), layer).convert('RGB'), (0, 0))


def star(im, cx, cy, r, color, k=0.3):
    """四角星（"AI / 增强"的统一记号）。"""
    pts = []
    seq = [(0, -1), (k, -k), (1, 0), (k, k), (0, 1), (-k, k), (-1, 0), (-k, -k)]
    for dx, dy in seq:
        pts.append((cx + dx * r, cy + dy * r))
    poly(im, pts, fill=color)


def sparkles(im, pts, color, r=7):
    for (x, y) in pts:
        star(im, x, y, r, color)


def noise(im, amount=26, seed=7):
    rnd = random.Random(seed)
    w, h = im.size
    out = im.copy()
    px = out.load()
    for y in range(h):
        for x in range(w):
            n = rnd.randint(-amount, amount)
            px[x, y] = tuple(max(0, min(255, c + n)) for c in px[x, y])
    return out


def blocks(im, size):
    """马赛克/像素化：缩到 1/size 再用最近邻放大回去。"""
    w, h = im.size
    small = im.resize((max(1, w // size), max(1, h // size)), Image.BILINEAR)
    return small.resize((w, h), Image.NEAREST)


def scratches(im, seed=3, count=14, color=(235, 238, 245)):
    rnd = random.Random(seed)
    w, h = im.size
    d = ImageDraw.Draw(im)
    for _ in range(count):
        x = rnd.randint(0, w)
        y0 = rnd.randint(0, h // 3)
        y1 = y0 + rnd.randint(h // 4, h // 2)
        d.line((x, y0, x + rnd.randint(-3, 3), y1), fill=color, width=1)
    return im


# ────────────────────────────── 场景积木 ──────────────────────────────
# 下面这些"积木"是各族共用的。卡片族与预设族都靠它们拼出来，
# 所以一族的观感天然成套 —— 这也是用脚本画而不是逐张生成的最大收益。

SKY_PRESETS = [
    ((126, 200, 245), (236, 246, 255)),   # 晴天
    ((255, 176, 122), (255, 226, 190)),   # 黄昏
    ((86, 132, 214), (196, 220, 250)),    # 清晨
    ((52, 74, 130), (128, 158, 214)),     # 夜景
]


def landscape(size, sky=0, seed=1):
    """扁平矢量风景：天空渐变 + 太阳 + 远近两层山 + 地面 + 水面反光 + 飞鸟。

    它是"一张照片"的替身：预设族要做前后对比，得有一张**内容足够丰富**的底图，
    否则降噪/锐化/超分在图上根本看不出区别（空渐变图放大后还是空渐变）。
    """
    w, h = size
    top, bottom = SKY_PRESETS[sky % len(SKY_PRESETS)]
    im = vgrad(size, top, bottom)
    d = ImageDraw.Draw(im)
    rnd = random.Random(seed)

    # 太阳
    sun = (255, 248, 214) if sky in (0, 2) else (255, 214, 150)
    circ(im, int(w * 0.74), int(h * 0.24), max(8, int(h * 0.09)), fill=sun)
    circ(im, int(w * 0.74), int(h * 0.24), max(12, int(h * 0.14)), outline=sun, width=3)

    horizon = int(h * 0.62)

    # 远山（两层，颜色分层拉纵深）
    far = mix(bottom, (60, 78, 104), 0.55)
    near = mix(far, (26, 34, 52), 0.6)
    pts_far = [(0, horizon)]
    x = 0
    while x < w:
        step = rnd.randint(int(w * 0.12), int(w * 0.22))
        peak = horizon - rnd.randint(int(h * 0.14), int(h * 0.26))
        pts_far.append((x + step // 2, peak))
        x += step
    pts_far.append((w, horizon))
    poly(im, pts_far + [(w, h), (0, h)], fill=far)

    pts_near = [(0, horizon + int(h * 0.05))]
    x = 0
    while x < w:
        step = rnd.randint(int(w * 0.16), int(w * 0.3))
        peak = horizon - rnd.randint(int(h * 0.05), int(h * 0.14))
        pts_near.append((x + step // 2, peak))
        x += step
    pts_near.append((w, horizon + int(h * 0.05)))
    poly(im, pts_near + [(w, h), (0, h)], fill=near)

    # 地面 / 水面：横向反光条
    ground = mix(near, (18, 24, 40), 0.4)
    d.rectangle((0, int(h * 0.78), w, h), fill=ground)
    for i in range(9):
        y = int(h * 0.79) + i * max(2, int(h * 0.022))
        if y >= h:
            break
        wide = rnd.randint(int(w * 0.1), int(w * 0.45))
        x0 = rnd.randint(0, max(1, w - wide))
        d.rectangle((x0, y, x0 + wide, y + max(1, int(h * 0.008))), fill=mix(ground, sun, 0.22))

    # 一棵树（打破天际线的单调）
    tx = int(w * 0.18)
    ty = int(h * 0.78)
    d.rectangle((tx - 2, ty - int(h * 0.12), tx + 2, ty), fill=(38, 48, 40))
    circ(im, tx, ty - int(h * 0.16), int(h * 0.09), fill=(46, 92, 66))
    circ(im, tx - int(h * 0.05), ty - int(h * 0.11), int(h * 0.06), fill=(56, 104, 72))

    # 飞鸟（三笔）
    for i, (bx, by) in enumerate([(int(w * 0.42), int(h * 0.2)), (int(w * 0.5), int(h * 0.15)), (int(w * 0.57), int(h * 0.23))]):
        s = max(3, int(h * 0.02))
        pline(im, [(bx - s, by), (bx, by - s // 2), (bx + s, by)], mix(near, (0, 0, 0), 0.2), 2)
    return im


def avatar_bust(size, skin=(240, 208, 190), hair=(58, 52, 72), cloth=(86, 116, 220), bg=None, accent=None, animal=False):
    """插画化半身像：色块 + 发型轮廓，**不画五官**（避免真人面孔与恐怖谷）。

    数字人一族要"让人看出是个人物"，又不能用真人脸 —— 解法是只保留
    头/肩/头发这三个最不具识别性的剪影层，靠配色区分不同模型。
    """
    w, h = size
    im = new(size, bg or (30, 32, 44))
    if bg is None:
        im = dgrad(size, (44, 48, 66), (24, 26, 38))
    cx = w * 0.5
    head_r = min(w, h) * 0.22
    head_cy = h * 0.42

    # 肩（半圆）
    poly(im, [(cx - head_r * 2.4, h), (cx - head_r * 1.7, h * 0.72),
              (cx + head_r * 1.7, h * 0.72), (cx + head_r * 2.4, h)], fill=cloth)
    # 脖子
    rrect(im, (cx - head_r * 0.42, head_cy + head_r * 0.6, cx + head_r * 0.42, h * 0.78), 6, fill=mix(skin, (0, 0, 0), 0.12))
    # 头
    circ(im, cx, head_cy, head_r, fill=skin)
    if animal:
        # 动物：耳朵两个三角 + 吻部
        poly(im, [(cx - head_r * 0.95, head_cy - head_r * 0.75), (cx - head_r * 0.6, head_cy - head_r * 1.7),
                  (cx - head_r * 0.15, head_cy - head_r * 0.95)], fill=hair)
        poly(im, [(cx + head_r * 0.95, head_cy - head_r * 0.75), (cx + head_r * 0.6, head_cy - head_r * 1.7),
                  (cx + head_r * 0.15, head_cy - head_r * 0.95)], fill=hair)
        circ(im, cx, head_cy + head_r * 0.42, head_r * 0.34, fill=mix(skin, (255, 255, 255), 0.35))
        circ(im, cx, head_cy + head_r * 0.3, head_r * 0.08, fill=mix(hair, (0, 0, 0), 0.3))
    else:
        # 头发：一个盖住上半头的弧形块 + 两侧鬓角
        poly(im, [(cx - head_r * 1.02, head_cy - head_r * 0.1),
                  (cx - head_r * 0.98, head_cy - head_r * 0.8),
                  (cx - head_r * 0.4, head_cy - head_r * 1.18),
                  (cx + head_r * 0.42, head_cy - head_r * 1.18),
                  (cx + head_r * 0.98, head_cy - head_r * 0.78),
                  (cx + head_r * 1.02, head_cy - head_r * 0.05),
                  (cx + head_r * 0.72, head_cy - head_r * 0.42),
                  (cx - head_r * 0.7, head_cy - head_r * 0.42)], fill=hair)
    if accent:
        rrect(im, (w * 0.06, h * 0.06, w * 0.06 + w * 0.13, h * 0.06 + h * 0.09), 6, fill=accent)
    return im


def waveform(im, box, color, seed=5, bars=26, gap=2, skip=()):
    """音频波形（口播/配乐一族的统一语言）。skip 里的柱子画成暗色 = 被剪掉的部分。"""
    x0, y0, x1, y1 = box
    w = x1 - x0
    h = y1 - y0
    rnd = random.Random(seed)
    bw = max(2, (w - gap * (bars - 1)) // bars)
    for i in range(bars):
        amp = rnd.uniform(0.25, 1.0) * h
        col = color if i not in skip else mix(color, (0, 0, 0), 0.68)
        x = x0 + i * (bw + gap)
        rrect(im, (x, y0 + (h - amp) / 2, x + bw, y0 + (h + amp) / 2), bw // 2, fill=col)


def film_frame(im, box, r, fill=(24, 26, 36), holes=True):
    """胶片框：卡片族里"这是视频"的记号。"""
    x0, y0, x1, y1 = box
    rrect(im, box, r, fill=fill)
    if holes:
        w = x1 - x0
        for i in range(4):
            hx = x0 + w * (0.12 + i * 0.25)
            rrect(im, (hx, y0 + 5, hx + 10, y0 + 13), 2, fill=(52, 56, 72))
            rrect(im, (hx, y1 - 13, hx + 10, y1 - 5), 2, fill=(52, 56, 72))


def play_button(im, cx, cy, r, color=(255, 255, 255), plate=(126, 92, 240)):
    circ(im, cx, cy, r, fill=plate)
    poly(im, [(cx - r * 0.28, cy - r * 0.44), (cx + r * 0.42, cy), (cx - r * 0.28, cy + r * 0.44)], fill=color)


def text_lines(im, box, color, rows=3, seed=2, widths=(0.9, 0.75, 0.55)):
    """文字行的替身（不依赖字体，避免跨平台字形漂移）。"""
    x0, y0, x1, y1 = box
    w = x1 - x0
    rh = max(3, (y1 - y0) // (rows * 2))
    for i in range(rows):
        y = y0 + i * rh * 2
        ww = w * (widths[i % len(widths)])
        rrect(im, (x0, y, x0 + ww, y + rh), rh // 2, fill=color)


def chip(im, box, fill, r=6):
    rrect(im, box, r, fill=fill)


def motion_blur(im, dx=6, n=7):
    """横向运动模糊：把 n 张等距位移副本逐张叠加平均（PIL 没有方向模糊）。"""
    acc = im.convert('RGB')
    for i in range(1, n):
        shifted = ImageChops.offset(im.convert('RGB'), int(dx * i / n), 0)
        acc = Image.blend(acc, shifted, 1.0 / (i + 1))
    return acc


def paste_circle(dst, src, box):
    sub = src.resize((box[2] - box[0], box[3] - box[1]))
    mask = Image.new('L', sub.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, sub.size[0] - 1, sub.size[1] - 1), fill=255)
    dst.paste(sub, box[:2], mask)


def note(im, cx, cy, s, color):
    """八分音符（配乐一族的统一记号）。"""
    rrect(im, (cx - s * 0.34, cy + s * 0.3, cx + s * 0.34, cy + s * 0.72), s * 0.22, fill=color)
    rrect(im, (cx + s * 0.16, cy - s * 0.7, cx + s * 0.34, cy + s * 0.34), s * 0.08, fill=color)
    poly(im, [(cx + s * 0.32, cy - s * 0.7), (cx + s * 1.0, cy - s * 0.42),
              (cx + s * 1.0, cy - s * 0.16), (cx + s * 0.34, cy - s * 0.3)], fill=color)


def mic(im, cx, cy, s, color):
    rrect(im, (cx - s * 0.28, cy - s * 0.6, cx + s * 0.28, cy + s * 0.28), s * 0.28, fill=color)
    arc(im, (cx - s * 0.55, cy - s * 0.1, cx + s * 0.55, cy + s * 0.75), 20, 160, color, max(2, int(s * 0.12)))
    pline(im, [(cx, cy + s * 0.75), (cx, cy + s * 1.0)], color, max(2, int(s * 0.12)))


def check(im, cx, cy, s, color, width=4):
    pline(im, [(cx - s * 0.5, cy), (cx - s * 0.1, cy + s * 0.4), (cx + s * 0.55, cy - s * 0.45)], color, width, joint='curve')


def grid_cells(im, box, cols, rows, color, gap=6, r=3):
    x0, y0, x1, y1 = box
    cw = ((x1 - x0) - gap * (cols - 1)) // cols
    ch = ((y1 - y0) - gap * (rows - 1)) // rows
    for r_ in range(rows):
        for c in range(cols):
            x = x0 + c * (cw + gap)
            y = y0 + r_ * (ch + gap)
            rrect(im, (x, y, x + cw, y + ch), r, fill=color)


# ────────────────────────────── 前后对比（增强族） ──────────────────────────────
# 注意：**正中间那条 1px 白竖线由 CSS 的 .enh-art::after 画**，这里绝不能自己画一条，
# 否则界面上会出现两条线。左右两半在 w//2 处拼接，正好被那条线盖住接缝。

def split_frame(im, box, r, before, after):
    x0, y0, x1, y1 = box
    w = x1 - x0
    h = y1 - y0
    half = w // 2
    left = before.resize((half, h))
    right = after.resize((w - half, h))
    clipped(im, box, r, lambda sub: (
        sub.paste(left, (0, 0)),
        sub.paste(right, (half, 0))
    ))


def col(im, f):
    """饱和度（ImageEnhance.Color 是类，factor 要走 .enhance()）。"""
    return ImageEnhance.Color(im).enhance(f)


def con(im, f):
    return ImageEnhance.Contrast(im).enhance(f)


def bri(im, f):
    return ImageEnhance.Brightness(im).enhance(f)


def degrade(base, kind):
    """把"修好"的画面按功能退化成"原始素材"。"""
    if kind == 'noise':
        return noise(base, 30, seed=11)
    if kind == 'blur':
        return base.filter(ImageFilter.GaussianBlur(2.0))
    if kind == 'motion':
        return motion_blur(base, 9, 8)
    if kind == 'dull':
        return con(col(base, 0.45), 0.72)
    if kind == 'desat':
        return col(base, 0.35)
    if kind == 'gray':
        g = base.convert('L').convert('RGB')
        return con(g, 0.9)
    if kind.startswith('blocks'):
        n = int(kind[6:])
        out = blocks(base, n)
        return out.filter(ImageFilter.GaussianBlur(0.6)) if n <= 8 else out
    if kind == 'faded':
        faded = col(bri(base, 1.12), 0.5)
        return scratches(faded, seed=5, count=16)
    if kind == 'poster':
        q = base.quantize(colors=12).convert('RGB')
        return col(q, 0.7)
    return base


def enhance(base, kind):
    """与 degrade 配对：右侧"修好"的那一半。"""
    if kind == 'portrait':
        return base
    if kind in ('noise', 'faded', 'blur', 'motion', 'desat') or kind.startswith('blocks'):
        return base.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=3))
    if kind in ('dull', 'gray', 'poster'):
        return con(col(base, 1.3), 1.12)
    return base


BADGES = ['spark', 'color', 'text', 'motion', 'noise', 'quality', 'portrait', 'colorize', 'mosaic', 'anime']


# ────────────────────────────── 背景图库（12） ──────────────────────────────
# 界面唯一还在用的一族：左栏「素材 → 背景」，artSet.js 的 ART_FAMILIES。

def backdrop(i):
    w, h = 260, 150
    if i == 0:
        return vgrad((w, h), (255, 176, 122), (86, 86, 168))
    if i == 1:
        im = vgrad((w, h), (126, 200, 245), (232, 246, 255))
        for k in range(3):
            circ(im, 60 + k * 70, 40 + (k % 2) * 30, 26 - k * 4, fill=(255, 255, 255))
        return im
    if i == 2:
        im = dgrad((w, h), (30, 40, 74), (96, 62, 140), (200, 120, 150))
        rnd = random.Random(2)
        for _ in range(60):
            x, y = rnd.randint(0, w), rnd.randint(0, h)
            circ(im, x, y, rnd.randint(1, 4), fill=(255, 255, 255))
        return im
    if i == 3:
        im = vgrad((w, h), (24, 28, 46), (58, 74, 116))
        for k in range(-6, 14):
            pline(im, [(k * 30, h), (k * 30 + h, 0)], mix((96, 116, 170), (24, 28, 46), (k % 4) / 4), 10)
        return im
    if i == 4:
        im = vgrad((w, h), (16, 46, 66), (36, 120, 130))
        for y in range(0, h, 6):
            pline(im, [(0, y), (w, y)], mix((36, 120, 130), (120, 220, 220), (y % 30) / 30), 2)
        return im
    if i == 5:
        im = vgrad((w, h), (250, 226, 210), (206, 186, 176))
        for k in range(5):
            poly(im, [(0, 110 + k * 8), (260, 92 + k * 8), (260, 150), (0, 150)],
                 fill=mix((206, 186, 176), (140, 120, 116), k / 5))
        return im
    if i == 6:
        im = dgrad((w, h), (140, 92, 220), (86, 200, 220))
        for k in range(4):
            arc(im, (-40 + k * 40, 20, 180 + k * 40, 160), 200, 340, mix((255, 255, 255), (140, 92, 220), k / 4), 6)
        return im
    if i == 7:
        im = vgrad((w, h), (18, 20, 32), (52, 56, 84))
        for k in range(9):
            x = 14 + k * 28
            rrect(im, (x, 26 + (k % 3) * 14, x + 16, 120 + (k % 3) * 14), 4, fill=mix((70, 76, 110), (120, 130, 180), k / 9))
        return im
    if i == 8:
        im = vgrad((w, h), (236, 240, 250), (176, 190, 220))
        for k in range(6):
            pline(im, [(0, 30 + k * 22), (w, 18 + k * 22)], mix((120, 140, 190), (236, 240, 250), k / 6), 3)
        return im
    if i == 9:
        im = vgrad((w, h), (10, 14, 26), (40, 52, 92))
        rnd = random.Random(9)
        for _ in range(18):
            x, y = rnd.randint(0, w), rnd.randint(40, h)
            r = rnd.randint(6, 16)
            layer = Image.new('RGB', (w, h), (255, 214, 140))
            m = Image.new('L', (w, h), 0)
            ImageDraw.Draw(m).ellipse((x - r, y - r, x + r, y + r), fill=120)
            im.paste(Image.blend(im, layer, 1.0), (0, 0), m.filter(ImageFilter.GaussianBlur(6)))
        return im
    if i == 10:
        im = vgrad((w, h), (250, 244, 236), (222, 208, 194))
        for k in range(3):
            circ(im, 70 + k * 60, 60 + (k % 2) * 26, 30, outline=mix((200, 180, 160), (120, 100, 90), k / 3), width=4)
        return im
    im = dgrad((w, h), (26, 92, 96), (120, 200, 180), (246, 240, 214))
    for k in range(5):
        pline(im, [(0, 30 + k * 26), (w, 10 + k * 26)], mix((246, 240, 214), (26, 92, 96), k / 5), 5)
    return im


# ────────────────────────────── 落盘计划 ──────────────────────────────
#
# ⚠️ 去标识：下面这些文件名**刻意不带第三方品牌名** —— 旧文件名（以及界面文案里的
#    对应 label）里含一批第三方模型 / 厂商商标，那是别人的商标，不能进开源仓库。
#    原名清单不在这里抄一遍（抄了等于仓库里存一份商标列表），需要时查历史提交。
#    改文件名就要同步改 artSet.js 的 import 与 label（本脚本只管图，不管代码）。

PLAN = []


def add(family, name, fn):
    if not family:
        raise ValueError('配图必须挂在某个族下面：%s' % name)
    PLAN.append((os.path.join(ART, family), name, fn))


for _i in range(12):
    add('background', '%02d.png' % (_i + 1), (lambda i=_i: backdrop(i)))


def main():
    targets = {}
    for d, name, fn in PLAN:
        targets.setdefault(d, []).append((name, fn))

    if DRY:
        for d, rows in targets.items():
            print('%s  → %d 张' % (os.path.relpath(d, ROOT), len(rows)))
        print('合计 %d 张' % len(PLAN))
        return

    removed = 0
    for d, rows in targets.items():
        os.makedirs(d, exist_ok=True)
        # 先清掉这一族的全部旧图（改名后的旧文件不能留在仓库里，否则"文件还在、
        # 只是没人引用"会变成孤儿素材，art-consumed 那道闸会红）
        for name in os.listdir(d):
            if name.lower().endswith('.png'):
                os.remove(os.path.join(d, name))
                removed += 1
        for name, fn in rows:
            img = fn()
            img.save(os.path.join(d, name), 'PNG', optimize=True)
    print('自有配图：写入 %d 张，清掉参考原图 %d 张' % (len(PLAN), removed))
    print('OWN_ART_WROTE total=%d removed=%d' % (len(PLAN), removed))


if __name__ == '__main__':
    main()
