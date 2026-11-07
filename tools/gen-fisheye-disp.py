#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成鱼眼（桶形畸变）的**位移贴图** —— 预览侧 SVG `feDisplacementMap` 用。

--------------------------------------------------------------------------
为什么需要它
--------------------------------------------------------------------------
鱼眼是"整幅画面逐像素重映射"，CSS 的 `transform` / `filter: blur()` 这类函数做不到。
能做的只有两处：
  · 导出 → ffmpeg 的 `lenscorrection=k1=-0.45`（真镜头模型，已验证可用）；
  · 预览 → SVG `feDisplacementMap` + 一张存着「每个像素该往哪偏」的贴图。

--------------------------------------------------------------------------
贴图的编码约定（与 Stage.jsx 里的 filter 严格配对，改一边必须改另一边）
--------------------------------------------------------------------------
* 尺寸 256×256，与画面同比例关系只按"到中心的相对距离"算，所以不必随画布尺寸变；
* R 通道 = 横向位移，G 通道 = 纵向位移，**0.5 表示不位移**；
* 实际位移 = `scale × (通道值 − 0.5)`，`scale` 写在 SVG filter 上（当前 0.25）；
* 因此这里把归一化位移 `d ∈ [−0.1, 0.1]` 编成 `0.5 + d / 0.25`，即 `0.5 + 4d`。

⚠️ 不能把位移直接存成像素值：贴图是静态的，而画布大小会随比例变（16:9 / 1:1 / 9:16）。
   存"相对 bbox 的比例"才能一次生成、所有比例通用。

⚠️ 这张图必须**很小**（Vite 会把 < 4KB 的图内联成 base64）—— 于是它跟着主包走、
   不额外发请求，也不会出现"filter 引用的外部图还在加载、画面先抖一下"。

用法：python tools/gen-fisheye-disp.py
"""
import os

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'fx', 'fisheye-disp.png')

N = 256
# 与 SVG filter 上的 scale 严格配对：0.25 表示「通道差 0.5 时位移半个 bbox 宽」
SVG_SCALE = 0.25
# 角落处的归一化位移（10% 画布宽）—— 再大边缘就开始明显拉伸
MAX_SHIFT = 0.10
# 桶形系数：位移量正比于 (距离²)。0.05 让角落刚好等于 MAX_SHIFT（角落 r² = 2）
K = MAX_SHIFT / 2.0


def main():
    im = Image.new('RGB', (N, N), (128, 128, 0))
    px = im.load()
    for y in range(N):
        # 像素中心归一化到 [-1, 1]，y 轴向上为正
        ny = (N - 1 - y * 2) / float(N - 1)
        for x in range(N):
            nx = (x * 2 - (N - 1)) / float(N - 1)
            r2 = nx * nx + ny * ny
            # 负号 = 向中心采样 = 画面向外鼓（桶形 / 鱼眼）。
            # 正号会变成枕形（画面向内吸），那是"望远镜"不是鱼眼。
            dx = -K * nx * r2
            dy = -K * ny * r2
            r = int(round(255 * min(1.0, max(0.0, 0.5 + dx / SVG_SCALE))))
            g = int(round(255 * min(1.0, max(0.0, 0.5 + dy / SVG_SCALE))))
            px[x, y] = (r, g, 0)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    im.save(OUT, 'PNG', optimize=True)
    print('位移贴图：%s（%d 字节）' % (OUT, os.path.getsize(OUT)))


if __name__ == '__main__':
    main()
