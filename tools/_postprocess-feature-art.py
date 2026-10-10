# -*- coding: utf-8 -*-
"""
P0-1 占位素材替换 · 后处理（一次性脚本）

输入：_recon/gen-feature-art/ 下 ImageGen 生成的 3 张功能卡插画（1024×1024，透明底）
输出：assets/home-feat/{ai-ads,avatar,ai-video}.png（精确目标尺寸，裁掉水印区）
另：程序化重画 assets/promo/feedback_art.png（112×90，左沿精确落在 #62DAE4）
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN = os.path.join(ROOT, "_recon", "gen-feature-art")
OUT = os.path.join(ROOT, "packages", "desktop", "src", "renderer", "assets")

JOBS = [
    ("A_flat_vector_illustration_ins_2026-10-01T19-26-20.png", "home-feat/ai-ads.png", 421, 345),
    ("A_flat_vector_illustration_ins_2026-10-01T19-26-33.png", "home-feat/avatar.png", 437, 341),
    ("A_flat_vector_illustration_ins_2026-10-01T19-27-31.png", "home-feat/ai-video.png", 336, 327),
]

for src_name, dst_rel, tw, th in JOBS:
    src = os.path.join(GEN, src_name)
    dst = os.path.join(OUT, dst_rel.replace("/", os.sep))
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    # 1) 先裁掉底部 8%：ImageGen 的水印落在这一带，且都在圆角卡外的透明区
    im = im.crop((0, 0, w, int(h * 0.92)))
    # 2) 按非透明像素收紧
    im = im.crop(im.getbbox())
    # 3) 中心裁到目标比例
    target = tw / th
    w2, h2 = im.size
    if w2 / h2 > target:
        nw = int(h2 * target)
        x = (w2 - nw) // 2
        im = im.crop((x, 0, x + nw, h2))
    else:
        nh = int(w2 / target)
        y = (h2 - nh) // 2
        im = im.crop((0, y, w2, y + nh))
    # 4) 精确尺寸
    im = im.resize((tw, th), Image.LANCZOS)
    im.save(dst)
    print(dst_rel, im.size)

# ---------------- feedback_art：程序化重画（112×90） ----------------
W, H = 112, 90
im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
# 横向渐变：左沿必须精确落在 #62DAE4（home.css 里 .home-promo 渐变起点），
# 否则插画与卡片渐变的接缝处会留一条 ~18 级色阶。
c0 = (0x62, 0xDA, 0xE4)
c1 = (0x7D, 0xDF, 0xE7)
for x in range(W):
    t = x / (W - 1)
    col = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3)) + (255,)
    d.line([(x, 0), (x, H)], fill=col)

# 云朵（右下）
cloud = (255, 255, 255, 235)
d.ellipse((58, 54, 92, 78), fill=cloud)
d.ellipse((46, 62, 74, 82), fill=cloud)
d.ellipse((74, 62, 100, 82), fill=cloud)

# 胶片斜带（深色带 + 白色齿孔，旋转 -18°）
band = Image.new("RGBA", (200, 34), (0, 0, 0, 0))
bd = ImageDraw.Draw(band)
bd.rectangle((0, 0, 199, 33), fill=(38, 41, 66, 210))
for i in range(10):
    bd.rectangle((6 + i * 20, 4, 16 + i * 20, 12), fill=(255, 255, 255, 200))
    bd.rectangle((6 + i * 20, 21, 16 + i * 20, 29), fill=(255, 255, 255, 200))
band = band.rotate(-18, expand=True)
im.alpha_composite(band, (-30, 4))


# ✦ 闪光（白，四角星）
def spark(cx, cy, r, color=(255, 255, 255, 240)):
    pts = []
    for i in range(8):
        ang = math.pi / 4 * i - math.pi / 2
        rr = r if i % 2 == 0 else r * 0.32
        pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
    d.polygon(pts, fill=color)


spark(24, 46, 9)
spark(100, 22, 6)

# 表情（黄圆 + 眯眼笑）
face = (255, 214, 90, 255)
d.ellipse((12, 8, 34, 30), fill=face)
d.arc((17, 16, 29, 26), 20, 160, fill=(120, 72, 20, 255), width=2)
d.ellipse((18, 14, 21, 17), fill=(120, 72, 20, 255))
d.ellipse((25, 14, 28, 17), fill=(120, 72, 20, 255))

# 带白色播放三角的蓝色圆角方块（右中）
bx, by, bs = 84, 30, 22
d.rounded_rectangle((bx, by, bx + bs, by + bs), radius=6, fill=(64, 120, 244, 255))
d.polygon([(bx + 8, by + 6), (bx + 8, by + bs - 6), (bx + bs - 5, by + bs // 2)], fill=(255, 255, 255, 255))

# 最后一步：左缘 2px 强制重绘为渐变色 —— 斜带等元素不允许盖到 x<2，
# 否则插画与卡片渐变的接缝处会出现色阶（PM 验收的硬性要求）。
for x in range(2):
    t = x / (W - 1)
    col = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3)) + (255,)
    d.line([(x, 0), (x, H)], fill=col)

dst = os.path.join(OUT, "promo", "feedback_art.png")
im.save(dst)
print("feedback_art.png", im.size)
px = im.getpixel((0, 45))
print("left-edge rgb =", px[:3], "expect (98,218,228)")
print("POSTPROCESS_DONE")
