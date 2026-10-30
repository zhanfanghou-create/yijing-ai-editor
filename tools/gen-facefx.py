#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成人物特效要用的两枚贴图（程序生成，无外部素材）。

    py tools/gen-facefx.py

产出 packages/desktop/resources/facefx/：
  mask-ellipse.png   512x512  白色椭圆，外部全透明 —— 当「局部处理的作用范围」
  frame-ellipse.png  512x512  紫色椭圆描边 + 外发光 —— 当「主角描边」

为什么是椭圆而不是矩形：
  人脸不是方的。矩形打码会在四个角露出方角，看起来像贴了一张纸；
  参考客户端的人脸框也是圆角很重的形状。椭圆在视觉上最接近"只处理脸"。

为什么尺寸固定 512 而不是按脸缩放：
  ffmpeg 的 `scale` 宽高是初始化参数，sendcmd 改不了（与 crop 同一个限制）。
  所以整段用一个尺寸（取整段里最大的脸），靠 overlay 的位置跟随。
  代价是"人走近镜头时描边不会跟着变粗"——这件事写在 PITFALLS 里，不假装做到了。
"""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "packages", "desktop", "resources", "facefx")
SIZE = 512


def ellipse_mask(size=SIZE, inset=0.04, blur=0):
    """白色椭圆、外部透明。inset 是四周留白比例。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * inset
    d.ellipse([pad, pad, size - pad, size - pad], fill=(255, 255, 255, 255))
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    return img


def ellipse_frame(size=SIZE, inset=0.04, width=7, color=(124, 92, 255), glow=True):
    """椭圆描边 + 外发光。"""
    pad = size * inset
    box = [pad, pad, size - pad, size - pad]

    if glow:
        # 发光单独一层再模糊：直接在描边上模糊会把线条本身糊掉
        glow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow_layer)
        gd.ellipse(box, outline=color + (255,), width=width * 2)
        glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(width * 2.2))

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if glow:
        img = Image.alpha_composite(img, glow_layer)
    d = ImageDraw.Draw(img)
    d.ellipse(box, outline=color + (255,), width=width)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)

    mask = ellipse_mask(blur=0)
    mask.save(os.path.join(OUT, "mask-ellipse.png"))
    print("  ✓ mask-ellipse.png  %d bytes" % os.path.getsize(os.path.join(OUT, "mask-ellipse.png")))

    frame = ellipse_frame()
    frame.save(os.path.join(OUT, "frame-ellipse.png"))
    print("  ✓ frame-ellipse.png %d bytes" % os.path.getsize(os.path.join(OUT, "frame-ellipse.png")))

    # 判据：两枚都必须是「有透明区」的 RGBA，否则叠上去就是一块不透明的纸
    for name in ("mask-ellipse.png", "frame-ellipse.png"):
        im = Image.open(os.path.join(OUT, name))
        if im.mode != "RGBA":
            raise SystemExit("%s 不是 RGBA（%s）" % (name, im.mode))
        alpha = im.split()[-1]
        lo, hi = alpha.getextrema()
        if lo != 0:
            raise SystemExit("%s 没有全透明像素（alpha min=%d），叠上去会挡死画面" % (name, lo))
        if hi < 200:
            raise SystemExit("%s 不透明区太弱（alpha max=%d）" % (name, hi))
        print("  · %s alpha %d..%d  %dx%d" % (name, lo, hi, im.width, im.height))


if __name__ == "__main__":
    main()
