#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
素材缩略图生成器（开源版）—— 滤镜 / 转场 / 特效 / 调节 四组。

--------------------------------------------------------------------------
为什么用「真实取景底片」而不是画色块
--------------------------------------------------------------------------
第一版是纯程序化画的：天一条渐变、地一条色块、中间一个方框当主体。
它诚实地反映了调色参数（同一组参数画出来就是那个颜色），但**看起来像占位块**：
用户在一屏 35 张卡里看到的是 35 个色块，读不出"这条滤镜会把我的片子变成什么样"。

现在改成：底片取自**本地素材包** `tools/thumb-bases/frames.yjpack`
（4 张真实画面：硬光人像 / 丹霞风景 / 红油火锅 / 霓虹夜色，见 tools/gen-thumb-pack.py），
每条缩略图 = 把该条的真实参数作用上去：

  滤镜 → 按 shared/looks.json 的调色参数逐通道算（顺序与 CSS/ffmpeg 一致）
  调节 → 按 shared/adjust.js 的 channelGains / contrastFactor / saturationFactor 算
  转场 → A 画面 → B 画面的几何遮罩合成（遮罩由原来那套族+方向的几何代码画出来）
  特效 → 在 A 画面上加一层光效（加色合成，与预览层的光斑同源）

所以"图与效果对不上"在结构上不可能发生：图和效果是**同一组参数**算出来的。

⚠️ 底片是**生成用素材，不进安装包**（不在 packages/ 下，不被打包）。
   重画全部缩略图：`python tools/gen-material-thumbs.py`
"""
import hashlib
import io
import json
import math
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import time
import zipfile

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps

# 允许从任意工作目录运行（`python F:/.../tools/gen-material-thumbs.py`）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MAT = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'materials.js')
OUT = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'materials')
BASE_DIR = os.path.join(ROOT, 'tools', 'thumb-bases')
# 底片真源：**本地素材包**（不是散图）。打包脚本见 tools/gen-thumb-pack.py，
# 读取逻辑统一在 tools/thumb_base.py —— 本文件不自己拼图片路径。
import thumb_base

# 几何先画在 128 的画布上（这套几何代码的全部尺寸都按 128 写死），
# 再上采样到输出尺寸 —— 好处有两个：几何代码一行不用改；边缘反倒比硬像素更自然。
GEOM = 128
SIZE = 192
QUALITY = 76

ITEM_RE = re.compile(r'\{\s*zh:\s*"([^"]*)"\s*,\s*thumb:\s*"[^"]*"\s*,\s*css:\s*"([^"]*)"\s*\}')
ADJ_SECTION_RE = re.compile(r'(export const ADJUST_GROUPS = \[)([\s\S]*?)(\n\])')
# 调节条目用的是**单引号**（`{ zh: '自然通透', adjust: {…} }`），与上面的双引号不同 ——
# 两种都要认，写回时沿用原来那种引号。thumb 段可选：写过一次之后再跑要能重新匹配上
# （不能要求"必须没有 thumb"，否则第二次执行就解析不到条目、整个脚本空转退出）。
ADJ_ITEM_RE = re.compile(
    r'\{\s*zh:\s*([\'"])([^\'"]*)\1\s*,\s*(?:thumb:\s*[\'"][^\'"]*[\'"]\s*,\s*)?adjust:\s*(\{[^}]*\})\s*\}')


# ---------------------------------------------------------------- 参数与键表

def hsl(h, s, l):
    import colorsys
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return (int(r * 255), int(g * 255), int(b * 255))


LOOKS_FILE = os.path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'looks.json')
LOOKS = json.loads(io.open(LOOKS_FILE, encoding='utf-8').read())
TRANSITION_KEYS = [item['key'] for item in LOOKS['transitions'] if item['key'] != 'none']
TRANSITIONS = set(TRANSITION_KEYS)
FILTER_PARAMS = {item['key']: item.get('params', {}) for item in LOOKS['filters']}

# 画面特效的键从 shared/frameEffects.json 读，**不再手抄一份**。
# 手抄的后果是真实的：加一个特效忘了改这里，render() 会把它当滤镜处理，
# 于是"卡片上是调色照片、画面里是光效"，而且闸门仍然全绿（一图一键的判据还在）。
FRAME_FX_FILE = os.path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'frameEffects.json')
FRAME_FX = json.loads(io.open(FRAME_FX_FILE, encoding='utf-8').read())
FX = {item['key'] for item in FRAME_FX['effects'] if item.get('kind') not in (None, 'none')}
# 素材型特效（kind: pack）单独拎出来：它们的缩略图**不是画的**，
# 而是从素材包里取真实的一帧叠到底片上 —— 这样"卡片上看到的"与
# "画面上看到的"是同一批像素，不存在"卡片挺好看、加上去不是那样"。
FX_PACK = {item['key']: item.get('pack') or item['key']
           for item in FRAME_FX['effects'] if item.get('kind') == 'pack'}
PACK_ZIP = os.path.join(ROOT, 'packages', 'desktop', 'resources', 'fxpacks', 'overlay-fx.yjpack')
# 取第 10 帧（1 秒处）：动画中段元素的分布最均匀，不会正好取到"刚进场几乎空"的那一帧
PACK_FRAME_INDEX = 10

DIRS = ('left', 'right', 'up', 'down', 'tl', 'tr', 'bl', 'br')


def split_key(key):
    """'smoothleft' → ('smooth', 'left')；没有方向后缀的返回 (key, '')"""
    for d in DIRS:
        if key.endswith(d):
            return key[:-len(d)], d
    return key, ''


# ---------------------------------------------------------------- 取景底片

_BASE = {}


def base(which='a', size=SIZE):
    """
    取景底片（缓存）。取自**本地素材包**：a = 硬光高饱和人像，b = 高饱和风景，
    c = 红油美食，d = 霓虹夜色。包与读取逻辑见 `tools/thumb_base.py`。

    ⚠️ 底片选型是这套缩略图**最关键的一步**，不是随便找张图。
      早先用的是一张逆光黄昏外景：反差偏低，缩到卡片上的 100px 之后一片发闷，
      六种调色上去看着都差不多 —— 等于缩略图白做。
      换成硬光、高饱和、花花绿绿的一张之后，色相偏移、光晕、颗粒、模糊、
      边缘这五件事才都能在 100px 上一眼读出来（同一个判断在参考项目里也成立：
      它的提交原话是「the cards were 16:9, drawn from a muted office portrait,
      and most looks changed it too little to tell apart」，后来换成
      「a photo in hard daylight - orange hair, yellow and navy bars, a red roof,
      blue sky - so colour, glow, grain, blur and edges all read at a glance」）。

    ⚠️ 归一化只做一次极轻的对比（cutoff 0.5、不提色），且只作用在**底片**上、
      不作用在每条滤镜的输出上 —— 后者会把要展示的差别一起抹平。
    """
    key = (which, size)
    if key not in _BASE:
        image = thumb_base.base(which, size=size, normalize=True)
        _BASE[key] = image
    return _BASE[key].copy()


# ---------------------------------------------------------------- 滤镜

def _css_rows(rows):
    """3×3 + 偏移（0~255）→ PIL convert 的 12 元组"""
    return tuple(v for row in rows for v in row)


def css_brightness(k):
    return ((k, 0, 0, 0), (0, k, 0, 0), (0, 0, k, 0))


# CSS sepia() 的规范矩阵
SEPIA_M = ((0.393, 0.769, 0.189), (0.349, 0.686, 0.168), (0.272, 0.534, 0.131))


def css_sepia(t):
    """sepia(t) = 单位阵与 SEPIA_M 的线性插值（与 main/looks.js 的写法一致）"""
    return tuple(
        tuple((1 if r == c else 0) + (SEPIA_M[r][c] - (1 if r == c else 0)) * t for c in range(3)) + (0,)
        for r in range(3)
    )


def css_contrast(k):
    """CSS contrast() 的轴心是固定的 0.5（不是图像均值 —— PIL 的 ImageEnhance 用均值，这是两回事）"""
    o = 0.5 * (1 - k) * 255.0
    return ((k, 0, 0, o), (0, k, 0, o), (0, 0, k, o))


def css_saturate(s):
    return (
        (0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0),
        (0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0),
        (0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0),
    )


def css_hue(deg):
    """CSS hue-rotate 的矩阵（SVG feColorMatrix type="hueRotate" 规范式）。

    ⚠️ 不能再用"HSV 里把 H 平移一格"那种做法：HSV 平移与 CSS 的线性矩阵
       在 18° 时已差 12.6 ΔE、40° 时差 25 ΔE（实测）。
       缩略图是给用户看"这个效果长什么样"的，它必须和画布用同一条式子，
       否则卡片上是一个色、点下去是另一个色 —— 而且没有任何报错。
       主进程那侧同式，见 src/main/looks.js 的 hueMatrix。
    """
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return (
        (0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0),
        (0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0),
        (0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0),
    )


def apply_look_photo(im, p):
    """
    把 shared/looks.json 的一组调色参数作用到整张画面上。

    顺序与 cssFilterFor / ffmpegFilterFor **逐字一致**：
        brightness → sepia → contrast → saturate(含去色) → hue-rotate
    顺序错了两条路径就会各算各的（同一个 key，预览与成片颜色不同）。

    ⚠️ 五步全部走 CSS 的**规范矩阵**，不用 PIL 的高层增强函数：
       ImageEnhance.Contrast 以图像均值为轴心（CSS 固定 0.5）、
       ImageEnhance.Color 走 HSV（CSS 走亮度加权的 sRGB 矩阵）、
       ImageOps.colorize 的棕调与 CSS sepia() 是两套系数。
       三者都只会让"卡片上的样子"偏离"点下去的样子"，且不报错。
       实测：改前 sepia 段偏差可达 12 ΔE（同一组参数、不同公式）。
    """
    b = p.get('brightness', 1)
    sp = p.get('sepia', 0)
    ct = p.get('contrast', 1)
    sat = p.get('saturate', 1) * (1 - p.get('grayscale', 0))
    hue = p.get('hue', 0)

    out = im.convert('RGB')
    if abs(b - 1) > 1e-4:
        out = out.convert('RGB', _css_rows(css_brightness(b)))
    if sp > 1e-4:
        out = out.convert('RGB', _css_rows(css_sepia(min(1.0, sp))))
    if abs(ct - 1) > 1e-4:
        out = out.convert('RGB', _css_rows(css_contrast(ct)))
    if abs(sat - 1) > 1e-4:
        out = out.convert('RGB', _css_rows(css_saturate(max(0.0, sat))))
    if abs(hue) > 1e-4:
        out = out.convert('RGB', _css_rows(css_hue(hue)))
    return out


# ---------------------------------------------------------------- 调节

BRIGHT_GAIN = 0.6
TEMP_GAIN = 0.3
TINT_GAIN = 0.25
CONTRAST_GAIN = 0.6


def channel_gains(adj):
    """与 shared/adjust.js 的 channelGains 同一个公式（亮度折进三通道，色温红蓝、色调绿）。"""
    gain = 1 + (adj.get('bright', 0) / 100.0) * BRIGHT_GAIN
    temp = (adj.get('temp', 0) / 100.0) * TEMP_GAIN
    tint = (adj.get('tint', 0) / 100.0) * TINT_GAIN
    r = min(4.0, max(0.0, gain * (1 + temp) * (1 + tint * 0.35)))
    g = min(4.0, max(0.0, gain * (1 - tint)))
    b = min(4.0, max(0.0, gain * (1 - temp) * (1 + tint * 0.35)))
    return r, g, b


def adjust_photo(im, adj):
    r, g, b = channel_gains(adj)
    ct = min(4.0, max(0.0, 1 + (adj.get('contrast', 0) / 100.0) * CONTRAST_GAIN))
    st = min(3.0, max(0.0, 1 + adj.get('saturate', 0) / 100.0))

    out = im
    if abs(r - 1) > 1e-4 or abs(g - 1) > 1e-4 or abs(b - 1) > 1e-4:
        ch = out.split()
        ch = [ch[i].point(lambda x, k=k: min(255, int(x * k))) for i, k in enumerate((r, g, b))]
        out = Image.merge('RGB', ch)
    if abs(ct - 1) > 1e-4:
        out = ImageEnhance.Contrast(out).enhance(ct)
    if abs(st - 1) > 1e-4:
        out = ImageEnhance.Color(out).enhance(st)
    return out


# ---------------------------------------------------------------- 转场

def _soft_edge(d, axis, edge, span, a, b):
    """在 edge 附近铺一条 a→b 的过渡带，用来画"柔推"这类不是硬切的转场。"""
    steps = max(2, span)
    for i in range(steps):
        t = i / float(steps - 1)
        col = tuple(int(a[k] + (b[k] - a[k]) * t) for k in range(3))
        if axis == 'x':
            x0 = edge - span // 2 + i
            d.line([(x0, 0), (x0, GEOM)], fill=col)
        else:
            y0 = edge - span // 2 + i
            d.line([(0, y0), (GEOM, y0)], fill=col)


def draw_transition(d, css, seed, mask=False):
    """
    把转场的几何画成一张**遮罩**（mask=True）或两张色卡（mask=False）。

    遮罩口径：黑 = 还是 A 画面，白 = 已经换成 B 画面，灰 = 两者叠着。
    所以同一段几何代码既能画旧色卡，也能拿来合成两张真实画面 ——
    不必为 331 条转场各写一遍"这张图长什么样"。
    """
    S = GEOM
    mid = S // 2
    if mask:
        a, b = (0, 0, 0), (255, 255, 255)
        h = 0.0
    else:
        h = (int(hashlib.sha1(css.encode('utf-8')).hexdigest()[:6], 16) % 1000) / 1000.0
        s, l = 0.46, 0.50
        a, b = hsl(h, s, l), hsl((h + 0.33) % 1.0, s, l)

    fam, dr = split_key(css)

    # ── 位移族：擦除 / 滑动 / 柔推 / 覆盖 / 揭示 ──
    if fam in ('wipe', 'slide', 'smooth', 'cover', 'reveal'):
        hard = fam in ('wipe', 'cover', 'reveal')
        if dr in ('left', 'right', 'up', 'down'):
            vertical = dr in ('left', 'right')
            if dr == 'left':
                d.rectangle([0, 0, mid, S], fill=b)
            elif dr == 'right':
                d.rectangle([mid, 0, S, S], fill=b)
            elif dr == 'up':
                d.rectangle([0, 0, S, mid], fill=b)
            else:
                d.rectangle([0, mid, S, S], fill=b)
            if hard:
                if vertical:
                    d.line([(mid, 0), (mid, S)], fill=(255, 255, 255), width=2)
                else:
                    d.line([(0, mid), (S, mid)], fill=(255, 255, 255), width=2)
            else:
                _soft_edge(d, 'x' if vertical else 'y', mid, 18, a, b)
        else:
            if dr == 'tl':
                d.polygon([(0, 0), (S, 0), (0, S)], fill=b)
            elif dr == 'tr':
                d.polygon([(0, 0), (S, 0), (S, S)], fill=b)
            elif dr == 'bl':
                d.polygon([(0, 0), (0, S), (S, S)], fill=b)
            else:
                d.polygon([(S, 0), (S, S), (0, S)], fill=b)
        return

    # ── 形状族 ──
    if css.startswith('circle'):
        r = int(S * 0.34)
        if css == 'circleclose':
            d.rectangle([0, 0, S, S], fill=b)
            d.ellipse([mid - r, mid - r, mid + r, mid + r], fill=a, outline=(255, 255, 255), width=2)
        elif css == 'circlecrop':
            d.rectangle([0, 0, S, S], fill=a)
            d.ellipse([mid - r, mid - r, mid + r, mid + r], fill=b, outline=(255, 255, 255), width=2)
        else:
            d.ellipse([mid - r, mid - r, mid + r, mid + r], fill=b, outline=(255, 255, 255), width=2)
        return
    if css.startswith('rect'):
        inset = S // 4
        d.rectangle([inset, inset, S - inset, S - inset], fill=b, outline=(255, 255, 255), width=2)
        return
    if css.startswith('vert'):
        if css == 'vertclose':
            band = S // 5
            d.rectangle([0, 0, S, band], fill=b)
            d.rectangle([0, S - band, S, S], fill=b)
        elif css == 'vertopen':
            d.rectangle([0, S // 3, S, S - S // 3], fill=b)
        else:
            d.rectangle([0, 0, S, mid], fill=b)
        return
    if css.startswith('horz'):
        if css == 'horzclose':
            band = S // 5
            d.rectangle([0, 0, band, S], fill=b)
            d.rectangle([S - band, 0, S, S], fill=b)
        elif css == 'horzopen':
            d.rectangle([S // 3, 0, S - S // 3, S], fill=b)
        else:
            d.rectangle([0, 0, mid, S], fill=b)
        return
    if css.startswith('diag'):
        if dr == 'tl':
            d.polygon([(0, 0), (S, 0), (0, S)], fill=b)
        elif dr == 'tr':
            d.polygon([(0, 0), (S, 0), (S, S)], fill=b)
        elif dr == 'bl':
            d.polygon([(0, 0), (0, S), (S, S)], fill=b)
        else:
            d.polygon([(S, 0), (S, S), (0, S)], fill=b)
        return
    if css.startswith('squeeze'):
        inset = S // 5
        if css == 'squeezeh':
            d.rectangle([inset, 0, S - inset, S], fill=b, outline=(255, 255, 255), width=1)
        else:
            d.rectangle([0, inset, S, S - inset], fill=b, outline=(255, 255, 255), width=1)
        return
    if css.startswith(('hl', 'hr', 'vu', 'vd')) and 'blur' not in css:
        vertical = css.startswith(('vu', 'vd'))
        step = 10
        for i in range(0, S, step):
            if (i // step) % 2 == 0:
                if vertical:
                    d.rectangle([i, 0, i + step - 1, S], fill=b)
                else:
                    d.rectangle([0, i, S, i + step - 1], fill=b)
        d.rectangle([0, 0, S, S], outline=hsl(h, 0.2, 0.75), width=1)
        return

    # ── 整幅叠合族（transition_thumb 会单独按图算，这里只做遮罩兜底）──
    if css == 'dissolve':
        step = 8
        for gy in range(0, S, step):
            for gx in range(0, S, step):
                if ((gx * 7 + gy * 13 + seed) % 23) < 11:
                    d.rectangle([gx, gy, gx + step - 1, gy + step - 1], fill=b)
        return
    if css in ('fadeblack', 'fadewhite', 'fadegrays'):
        for y in range(S):
            t = y / float(S - 1)
            d.line([(0, y), (S, y)], fill=a if t < 0.5 else b)
        return
    if css == 'pixelize':
        step = 12
        for gy in range(0, S, step):
            for gx in range(0, S, step):
                t = ((gx + gy) / float(S * 2)) * 3
                level = int(t) / 3.0
                col = tuple(int(a[i] + (b[i] - a[i]) * level) for i in range(3))
                d.rectangle([gx, gy, gx + step - 2, gy + step - 2], fill=col)
        return
    if css in ('hblur', 'radial'):
        if css == 'hblur':
            for y in range(0, S, 3):
                t = abs(y - mid) / float(mid)
                col = tuple(int(a[i] + (b[i] - a[i]) * (1 - t)) for i in range(3))
                d.line([(0, y), (S, y)], fill=col)
        else:
            for i in range(18):
                t = i / 17.0
                r = int(S * 0.5 * t)
                v = int(255 * (1 - t) * 0.6)
                d.ellipse([mid - r, mid - r, mid + r, mid + r], outline=(v, v, v), width=2)
        return
    if css == 'distance':
        for i in range(4):
            inset = int(S * (0.10 + 0.09 * i))
            col = tuple(int(a[k] + (b[k] - a[k]) * (0.25 + 0.25 * i)) for k in range(3))
            d.rectangle([inset, inset, S - inset, S - inset], outline=col, width=3)
        return
    if css == 'zoomin':
        for i in range(5):
            inset = int(S * (0.42 - 0.08 * i))
            col = tuple(int(a[k] + (b[k] - a[k]) * (i / 4.0)) for k in range(3))
            d.rectangle([inset, inset, S - inset, S - inset], outline=col, width=3)
        return

    # ── 剩下的（fade / fadefast / fadeslow）走最简单的竖向渐变 ──
    for y in range(S):
        t = y / float(S - 1)
        d.line([(0, y), (S, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)))


# ------------------------------------------------------ 转场遮罩（geo 真源）

MASK_SIZE = 64
_MASKS = None


def transition_masks():
    """
    读 204 个 geo 转场的**外观矩阵**，**由 node 从 shared/transitionMask.js 现算**。

    为什么不在 Python 里再实现一遍 fieldAt：遮罩数学只能有一份。
    预览（CSS）与导出（ffmpeg expr）已经同源，缩略图是第三个消费方；
    在这里抄一份的后果是"改参数时漏掉缩略图那份"，而那张图画出来**看着很正常**
    —— 只是和点下去的效果不是一回事，且没有任何报错。

    每条给的是两路权重：b（后一段）+ t（中间色），前一段 = 1-b-t。
    单张遮罩表达不了"闪白" —— 它中点要经过一个纯色，纯色是第三段权重。

    导出脚本见 tools/export-transition-masks.mjs（进度取 0.38，见那边的说明）。
    返回 {key: (dim, tint, b_bytes, t_bytes)}
    """
    global _MASKS
    if _MASKS is None:
        script = os.path.join(ROOT, 'tools', 'export-transition-masks.mjs')
        node = os.environ.get('NODE') or 'node'
        try:
            raw = subprocess.run([node, script], check=True, stdout=subprocess.PIPE).stdout
        except FileNotFoundError:
            raise SystemExit('找不到 node（用于导出转场遮罩）。用 NODE 环境变量指定路径。')
        if raw[:4] != b'TXM2':
            raise SystemExit('转场遮罩导出格式不对（magic 不是 TXM2）')
        n = struct.unpack('<I', raw[4:8])[0]
        off = 8
        table = {}
        for _ in range(n):
            ln = raw[off]
            off += 1
            key = raw[off:off + ln].decode('utf-8')
            off += ln
            dim = struct.unpack('<H', raw[off:off + 2])[0]
            off += 2
            tint = raw[off] / 255.0
            off += 1
            cells = dim * dim
            wb = raw[off:off + cells]
            off += cells
            wt = raw[off:off + cells]
            off += cells
            table[key] = (dim, tint, wb, wt)
        _MASKS = table
    return _MASKS


def _share(fraction, total):
    """
    把 0..255 的 `fraction`（= b）换算成"在剩下的 1-t 里占多少"。
    纯粹为了能用两次 Image.composite 拼出 A*(1-b-t)+B*b+T*t，
    避免 4096 个像素的纯 Python 三层浮点循环（704 张缩略图会跑很久）。
    """
    out = bytearray(len(fraction))
    for i, v in enumerate(fraction):
        keep = 255 - total[i]
        out[i] = 0 if keep <= 1 else min(255, (v * 255 + keep // 2) // keep)
    return bytes(out)


def geo_transition_thumb(css):
    """
    geo 转场的缩略图：三段权重合成，权重取自真源。

    进度固定在 0.38（不是 0.5）：0.5 时"线性"与"加速/减速"两种时间曲线的遮罩
    **逐像素相同**，「向右」和「快速向右」会画出同一张图；光带族在 0.5 时又正好
    压在画面正中，看不出它偏着。0.38 时覆盖率差 20 个点，一眼可辨。
    """
    A = base('a', SIZE)
    B = base('b', SIZE)
    table = transition_masks()
    hit = table.get(css)
    if hit is None:
        raise SystemExit('转场遮罩里没有 %s —— 跑 node tools/gen-transition-params.mjs --write 之后重试' % css)
    dim, tint, wb, wt = hit
    size = (dim, dim)
    mb = Image.frombytes('L', size, wb).resize((SIZE, SIZE), Image.LANCZOS)
    mt = Image.frombytes('L', size, wt).resize((SIZE, SIZE), Image.LANCZOS)
    if mt.getbbox() is None:
        return Image.composite(B, A, mb)
    # 有中间色：out = (1-t) * [A、B 按 b/(1-t) 混合] + t * 中间色
    share = _share(mb.tobytes(), mt.tobytes())
    m2 = Image.frombytes('L', (SIZE, SIZE), share)
    layer = Image.composite(B, A, m2)
    tint = int(round(tint * 255))
    mid = Image.new('RGB', (SIZE, SIZE), (tint, tint, tint))
    return Image.composite(mid, layer, mt)


def transition_thumb(css, seed):
    """
    A 画面 → B 画面的真实过渡缩略图。

    `tx-` 开头的（204 个名字一卡一键那批）走 geo 遮罩，见 geo_transition_thumb。
    其余是老键（58 个原生 xfade 名），保留原来的几何画法 —— 老草稿里存的还是它们。

    整幅叠合族（fade 系列 / dissolve / pixelize / hblur / radial）不能靠"一块遮罩
    盖上去"表达 —— 它们中间要经过纯黑/纯白/像素化，所以这几族按图直接算，
    其余族一律用几何遮罩合成。
    """
    if css.startswith('tx-'):
        return geo_transition_thumb(css)

    A = base('a', SIZE)
    B = base('b', SIZE)

    if css in ('fadeblack', 'fadewhite', 'fadegrays'):
        midcol = {'fadeblack': (0, 0, 0), 'fadewhite': (255, 255, 255), 'fadegrays': (118, 118, 118)}[css]
        out = A.copy()
        px = out.load()
        bx = B.load()
        for y in range(SIZE):
            t = y / float(SIZE - 1)
            if t < 0.5:
                k = t * 2
                for x in range(SIZE):
                    c = px[x, y]
                    px[x, y] = tuple(int(c[i] + (midcol[i] - c[i]) * k) for i in range(3))
            else:
                k = (t - 0.5) * 2
                for x in range(SIZE):
                    c = bx[x, y]
                    px[x, y] = tuple(int(midcol[i] + (c[i] - midcol[i]) * k) for i in range(3))
        return out

    if css == 'dissolve':
        out = A.copy()
        px, bx = out.load(), B.load()
        step = 12
        for gy in range(0, SIZE, step):
            for gx in range(0, SIZE, step):
                if ((gx * 7 + gy * 13 + seed) % 23) < 11:
                    for y in range(gy, min(SIZE, gy + step)):
                        for x in range(gx, min(SIZE, gx + step)):
                            px[x, y] = bx[x, y]
        return out

    if css == 'pixelize':
        step = 16
        src = Image.blend(A, B, 0.5)
        small = src.resize((max(1, SIZE // step), max(1, SIZE // step)), Image.BOX)
        return small.resize((SIZE, SIZE), Image.NEAREST)

    if css in ('hblur', 'radial'):
        # 「轴向模糊 / 径向模糊」是**糊着换过去**：既要有两个画面，也要有模糊感。
        # 早先只做了"两图各半再糊"，结果两格都糊成一团、认不出是转场。
        # 现在先按方向合成（轴向=上下渐变，径向=同心圆），再糊一层。
        if css == 'hblur':
            mask = Image.linear_gradient('L').resize((SIZE, SIZE))
        else:
            m = Image.new('L', (SIZE, SIZE), 0)
            dm = ImageDraw.Draw(m)
            for i in range(36):
                r = int(SIZE * 0.52 * (i / 35.0))
                dm.ellipse([SIZE / 2 - r, SIZE / 2 - r, SIZE / 2 + r, SIZE / 2 + r], fill=int(255 * i / 35.0))
            mask = m
        out = Image.composite(B, A, mask).filter(ImageFilter.GaussianBlur(radius=SIZE * 0.02))
        return out

    if css in ('zoomin', 'distance'):
        # 「放大 / 距离」是按**层次**推进的转场，遮罩表达不了"一层套一层"。
        # 原来画的是空心线框，上采样后像一张技术图纸 —— 这里改成由外到内
        # 交替贴 A / B 的实心方块，读起来就是"一级一级放大过去"。
        out = A.copy()
        steps = 10
        for i in range(0, steps + 1):
            inset = int(SIZE * 0.5 * (i / float(steps)) * 0.94)
            src = A if i % 2 == 0 else B
            out.paste(src.crop((inset, inset, SIZE - inset, SIZE - inset)),
                      (inset, inset, SIZE - inset, SIZE - inset))
        return out

    # ── 时长型（fade / fadefast / fadeslow）──
    # 这三个的**画面**完全一样，差别只有 defaultDuration。原来一律画成"整幅竖向渐变"，
    # 于是 fade(0.6s) 与 fadeslow(1.2s) 的缩略图几乎同一张（实测 ΔE 1.48）。
    # 现在过渡带宽度按真实时长算：0.3s 窄、0.6s 中、1.2s 宽 ——
    # 读起来就是"化开得多不多"，与它们在时间线上的实际表现一致。
    if css in ('fade', 'fadefast', 'fadeslow'):
        w = band_width(TRANSITION_DUR.get(css, 0.6))
        mask = Image.new('L', (SIZE, SIZE), 0)
        dm = ImageDraw.Draw(mask)
        y0 = (SIZE - w) // 2
        for i in range(w):
            dm.line([(0, y0 + i), (SIZE, y0 + i)], fill=int(255 * i / max(1, w - 1)))
        return Image.composite(B, A, mask)

    m = Image.new('RGB', (GEOM, GEOM), (0, 0, 0))
    draw_transition(ImageDraw.Draw(m), css, seed, mask=True)
    mask = m.convert('L').resize((SIZE, SIZE), Image.LANCZOS)
    # 风的遮罩与切片**是同一批横竖条**（都在 draw_transition 里按 hl/vu 前缀画），
    # 区别只有软硬：把风的遮罩糊一下，读出来是"风扫过"而不是"切条替换"。
    if css.endswith('wind'):
        mask = mask.filter(ImageFilter.GaussianBlur(radius=SIZE * 0.016))
    return _with_mark(Image.composite(B, A, mask), css)


# ------------------------------------------------- 「怎么动」的记号层
#
# 为什么必须有这一层：转场缩略图原来是"A 图 / B 图按几何遮罩各露一半"，
# 于是**同一件事的两种做法**在静止画面上完全一样 —— 实测 ΔE 1.26 的那对是
# 「向右(slideright) ↔ 快速平移相机(smoothright)」，它们的差别只有边缘柔不柔。
# 还有 fade(0.6s) ↔ fadeslow(1.2s)：整幅渐变一模一样，差别只有**时长**。
# 换底片救不了这两类 —— 差异在"动起来的样子"，不在颜色。
#
# 所以缩略图要多携带三个维度，且三者都由**已有的真数据**算出来，不另编一套：
#   ① 方向  ← key 的方位后缀（split_key），导出的 ffmpeg 转场名用的是同一个后缀
#   ② 手法  ← key 的词干（wipe / slide / smooth / cover / reveal …）
#   ③ 节奏  ← looks.json 的 defaultDuration，过渡带的**宽度与它成正比**
#            （0.3s 的快闪是窄带、1.2s 的慢融是宽带 —— 读起来就是"化开得多不多"）

TRANSITION_DUR = {item['key']: float(item.get('defaultDuration') or 0.6) for item in LOOKS['transitions']}

# 词干 → 箭头样式。五种样式两两可辨，配上四个方向就是 20 种不同组合。
ARROW_STYLE = {
    'wipe': 'solid',     # 硬边擦除 —— 实心
    'slide': 'ghost',    # 整块平移 —— 带拖影（后面跟三截渐隐）
    'smooth': 'fade',    # 柔推 —— 箭身由实到虚
    'cover': 'block',    # 覆盖 —— 尾巴坠一块实心（"压过来"）
    'reveal': 'outline', # 揭示 —— 空心
    'diag': 'solid'
}
# 切片 / 风的键里**没有方位后缀**（hlslice、vuwind），方向藏在两个字母的前缀里：
# hl/hv 横向、vu/vd 纵向，第二个字母表示"反方向"。ffmpeg 的转场名就是这套前缀，
# 所以这里按同一套解码，不另立一套映射表。
AXIS_DIR = {'hl': 'right', 'hr': 'left', 'vu': 'down', 'vd': 'up'}

# 方位 → 单位向量（y 轴向下）。斜向用 ±0.7071，不写 0.7：
# 箭头是旋转画出来的，向量差 0.003 在 84px 的箭身上就是 0.25px 的位置差，
# 看不出来但会让"同一张图两次生成字节不同"，破坏"同键同图"的可复现性。
_DIAG = 0.7071067811865476
DIR_VEC = {
    'left': (-1.0, 0.0), 'right': (1.0, 0.0), 'up': (0.0, -1.0), 'down': (0.0, 1.0),
    'tl': (-_DIAG, -_DIAG), 'tr': (_DIAG, -_DIAG), 'bl': (-_DIAG, _DIAG), 'br': (_DIAG, _DIAG)
}


def band_width(dur):
    """过渡带宽度（像素）：0.3s → 26，1.2s → 118。线性映射，超出范围夹住。"""
    t = (max(0.25, min(1.3, dur)) - 0.3) / (1.2 - 0.3)
    return int(26 + t * (118 - 26))


def _arrow_polygon(cx, cy, vx, vy, length, shaft, head):
    """沿 (vx,vy) 的箭头多边形：尾在中点之前，尖在中点之后。"""
    tx, ty = cx - vx * length * 0.5, cy - vy * length * 0.5
    hx, hy = cx + vx * length * 0.5, cy + vy * length * 0.5
    nx, ny = -vy, vx  # 法向
    body_end_x, body_end_y = hx - vx * head, hy - vy * head
    pts = [
        (tx + nx * shaft / 2, ty + ny * shaft / 2),
        (body_end_x + nx * shaft / 2, body_end_y + ny * shaft / 2),
        (body_end_x + nx * head / 2, body_end_y + ny * head / 2),
        (hx, hy),
        (body_end_x - nx * head / 2, body_end_y - ny * head / 2),
        (body_end_x - nx * shaft / 2, body_end_y - ny * shaft / 2),
        (tx - nx * shaft / 2, ty - ny * shaft / 2),
    ]
    return [(int(round(x)), int(round(y))) for x, y in pts]


def draw_arrow(img, direction, style):
    """
    在合成好的转场图上叠一个方向箭头。

    尺寸与位置是调过的：第一版把箭头画在正中间、长度占 46%，结果**正好压住人脸**
    （底片 a 是人物特写）——缩略图读起来先看到一支白箭头，看不出转场。
    现在放在下三分之一、长度收到 30%，作用是"标注方向"而不是"抢主体"。

    描边先画：底片里既有白云（亮）也有夜景（暗），只画白色的话在亮区会消失。
    """
    vx, vy = DIR_VEC[direction]
    S = SIZE
    cx, cy = S / 2.0, S * 0.62
    length, shaft, head = S * 0.30, S * 0.052, S * 0.135

    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    outline = _arrow_polygon(cx, cy, vx, vy, length + 5, shaft + 5, head + 5)
    d.polygon(outline, fill=(0, 0, 0, 95))

    poly = _arrow_polygon(cx, cy, vx, vy, length, shaft, head)

    if style == 'outline':
        d.polygon(poly, outline=(255, 255, 255, 235), width=3)
    elif style == 'fade':
        # 箭身分 10 段，透明度从 50 递到 225：读起来是"柔着推过去"
        for i in range(10):
            a = 50 + int(175 * (i / 9.0))
            seg = _arrow_polygon(
                cx - vx * length * 0.5 + vx * length * (i + 0.5) / 10.0,
                cy - vy * length * 0.5 + vy * length * (i + 0.5) / 10.0,
                vx, vy, length / 10.0 + 1, shaft, min(head, length / 10.0 + 1)
            )
            d.polygon(seg, fill=(255, 255, 255, a))
    elif style == 'ghost':
        d.polygon(poly, fill=(255, 255, 255, 175))
        # 尾巴后面三截渐隐方块 = "整块平移"的拖影
        for i in range(3):
            k = (i + 1) * 0.09
            px, py = cx - vx * length * (0.5 + k), cy - vy * length * (0.5 + k)
            w = shaft * 0.40
            d.rectangle([px - w, py - w, px + w, py + w], fill=(255, 255, 255, 115 - i * 30))
    elif style == 'block':
        d.polygon(poly, fill=(255, 255, 255, 230))
        # 尾端坠一块实心：覆盖是"整块压过来"，不是"擦过去"
        bx, by = cx - vx * length * 0.60, cy - vy * length * 0.60
        w = shaft * 1.25
        d.rectangle([bx - w, by - w, bx + w, by + w], fill=(255, 255, 255, 195))
    else:  # solid
        d.polygon(poly, fill=(255, 255, 255, 230))

    out = img.convert('RGBA')
    out.alpha_composite(layer)
    return out.convert('RGB')


def transition_mark(css):
    """
    给一个转场键叠上记号（方向箭头）。没有方向的族不动 —— 它们的区分靠几何本身
    （圆展开 / 方裁切 / 同心圆 / 点阵 / 中间色），再叠箭头只是添乱。
    """
    fam, dr = split_key(css)
    if dr and dr in DIR_VEC:
        style = ARROW_STYLE.get(fam)
        return (dr, style) if style else None
    for pre, d in AXIS_DIR.items():
        if css.startswith(pre) and css[len(pre):] in ('slice', 'wind'):
            # 风用虚箭头：它和切片**遮罩形状一样**，区别只有"糊不糊"
            return d, ('fade' if css.endswith('wind') else 'solid')
    return None


def _with_mark(img, css):
    info = transition_mark(css)
    if not info:
        return img
    dr, style = info
    return draw_arrow(img, dr, style)


# ---------------------------------------------------------------- 特效

# 参数轴的唯一真源（与预览 CSS 变量、导出 ffmpeg 参数同一份 json）。
# ⚠️ 这里必须**自己解一遍 base36**，不能调 JS：生成器是离线脚本，没有 Node 上下文。
#    两边解码规则（每轴第一档为默认、越界夹到最大档）必须同式，
#    否则同一个键在缩略图与预览里会是两个外观，而两边单独看都"合理"。
FX_PARAMS_FILE = os.path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'fxParams.json')
FX_TABLE = json.loads(io.open(FX_PARAMS_FILE, encoding='utf-8').read())
FX_AXES = FX_TABLE.get('families') or {}
FX_DEFAULTS = FX_TABLE.get('defaults') or {}
B36 = '0123456789abcdefghijklmnopqrstuvwxyz'


def fx_family(key):
    return str(key).split('@', 1)[0]


def fx_params(key):
    """键 → 参数（与 shared/fxParams.js 的 fxParamsOf 同式）。"""
    fam = fx_family(key)
    out = dict(FX_DEFAULTS)
    axes = (FX_AXES.get(fam) or {}).get('axes') or []
    code = key.split('@', 1)[1] if '@' in str(key) else ''
    for i, axis in enumerate(axes):
        ch = (code[i] if i < len(code) else '0').lower()
        idx = B36.find(ch)
        if idx < 0:
            idx = 0
        idx = min(idx, len(axis['values']) - 1)
        out[axis['k']] = axis['values'][idx]
    return out


def _lerp_rgb(a, b, k):
    return (int(a[0] + (b[0] - a[0]) * k),
            int(a[1] + (b[1] - a[1]) * k),
            int(a[2] + (b[2] - a[2]) * k))


def _radial(A, cx, cy, R, hue, amt, sat=0.55, core=0.96, falloff=2.0):
    """径向光斑：往 `hue` 方向的近白色插值，越靠中心越浓。

    与预览的 `radial-gradient(... / var(--fx-a))` 同向：中心最亮、到 R 处收敛、
    R 之后完全透明。`falloff` 越大边缘越"紧"（预览里就是 stop 的位置）。
    """
    W, H = A.size
    px = A.load()
    out = A.copy()
    dst = out.load()
    col = hsl(hue % 1.0, sat, core)
    reach = R * 1.45
    for y in range(H):
        dy = y - cy
        for x in range(W):
            d = math.hypot(x - cx, dy)
            if d >= reach:
                continue
            k = max(0.0, 1.0 - d / reach) ** falloff * amt
            if k <= 0.003:
                continue
            dst[x, y] = _lerp_rgb(px[x, y], col, min(1.0, k))
    return out


def _vignette(A, amt, inner, hue, cy_frac=0.5, bars=0.0):
    """按到**暗心**的距离压暗（加色层表达不了压暗，必须乘性）。

    `cy_frac` 是暗心在纵向的位置；`bars` 额外压上下两条边 —— 这两项都是**结构差别**，
    比"深浅差一档"容易一眼看出，也是这一族能凑出 27 个互不相同档位的真正原因。
    """
    W, H = A.size
    px = A.load()
    out = A.copy()
    dst = out.load()
    cx = W / 2.0
    cy = H * max(0.05, min(0.95, cy_frac))
    maxd = max(math.hypot(cx, cy), math.hypot(cx, H - cy)) or 1.0
    edge = hsl((hue or 0) % 1.0, 0.34, 0.05)
    lo = max(0.02, min(0.95, inner))
    bar = max(0.0, min(1.0, bars)) * amt
    for y in range(H):
        # 上下压边：靠近上下边缘时额外加一层（30% 处收敛到 0）
        tv = 1.0 - min(1.0, min(y, H - 1 - y) / (H * 0.3))
        kb = bar * (tv ** 1.4)
        for x in range(W):
            t = math.hypot(x - cx, y - cy) / maxd
            kr = 0.0
            if t > lo:
                kr = ((t - lo) / (1.0 - lo)) ** 1.7 * amt
            k = min(1.0, kr + kb * (1.0 - kr))
            if k > 0.003:
                dst[x, y] = _lerp_rgb(px[x, y], edge, k)
    return out


def _add_layer(A, layer, gain=1.0):
    layer = layer.point(lambda v: int(v * gain))
    return ImageChops.add(A, layer)


def _band_layer(size, hue, amt, angle_deg=78):
    """斜向光带（漏光）。预览是 `linear-gradient(78deg, transparent 30% …)`。"""
    W, H = size
    layer = Image.new('RGB', size, (0, 0, 0))
    d = ImageDraw.Draw(layer)
    col = hsl((hue or 32) / 360.0, 0.92, 0.72)
    for i in range(60):
        t = i / 59.0
        x = int(-W * 0.3 + (W * 1.6) * t)
        k = math.sin(math.pi * t) ** 1.6
        c = tuple(int(v * k * amt) for v in col)
        d.line([(x, 0), (x + int(H * 0.45), H)], fill=c, width=max(2, int(W * 0.05)))
    return layer.filter(ImageFilter.GaussianBlur(W * 0.02))


def fx_thumb(key, seed):
    """按**效果键**出图，键里的参数决定外观。

    参数化之前这里只按族名分支 —— 于是 fx-glow 的 83 张卡是同一张图，
    卡片列表看起来"有 83 个光效"、点开全是同一个。现在 68 个去重名字各占一档参数，
    `tools/gen-fx-params.py` 用**这张函数**算缩略图来挑档位，所以挑出来的档位
    就是"肉眼能分辨"的档位，不是按公式拍脑袋定的。
    """
    A = base('a', SIZE)
    fam = fx_family(key)
    p = fx_params(key)
    hue = p['h'] / 360.0
    W = SIZE

    # ---- 「改像素」的四种：不是叠光，而是**把底片本身变掉**（与预览的 backdrop-filter 同向）----
    if fam == 'fx-blur':
        im = A.filter(ImageFilter.GaussianBlur(radius=max(0.8, p['b'] * SIZE / 192.0)))
        im = ImageEnhance.Brightness(im).enhance(1.0 + p['t'])
        return ImageEnhance.Color(im).enhance(p['s'])

    if fam == 'fx-mono':
        gray = A.convert('L')
        return ImageEnhance.Contrast(gray).enhance(p['t']).convert('RGB')

    if fam == 'fx-vintage':
        sep = ImageOps.colorize(A.convert('L'), black=(36, 22, 12), white=(255, 233, 198))
        faded = Image.blend(A, sep, max(0.12, min(0.92, p['t'])))
        faded = ImageEnhance.Color(faded).enhance(p['s'])
        return faded.point(lambda v: max(0, min(255, int(128 + (v - 128) * 0.92))))

    if fam == 'fx-noise':
        rnd = random.Random(seed)
        amp = int(8 + p['a'] * 62)
        px = A.load()
        for y in range(W):
            for x in range(W):
                dd = rnd.randint(-amp, amp)
                r, g, b = px[x, y]
                px[x, y] = (max(0, min(255, r + dd)), max(0, min(255, g + dd)), max(0, min(255, b + dd)))
        return A

    if fam == 'fx-fisheye':
        k1 = float(p['t'])
        px = A.load()
        out = Image.new('RGB', (W, W), (0, 0, 0))
        dst = out.load()
        cx = cy = (W - 1) / 2.0
        for y in range(W):
            ny = (y - cy) / cy
            for x in range(W):
                nx = (x - cx) / cx
                s = 1.0 - abs(k1) * (nx * nx + ny * ny)
                sx = int(round(cx + (x - cx) * s))
                sy = int(round(cy + (y - cy) * s))
                if 0 <= sx < W and 0 <= sy < W:
                    dst[x, y] = px[sx, sy]
                else:
                    dst[x, y] = (10, 12, 16)
        return out

    if fam == 'fx-vignette':
        return _vignette(A, p['a'], p['r'], hue, p['y'] / 100.0, p['t'])

    if fam == 'fx-glow':
        # 两层：内核（小、浓）+ 外晕（大、淡）。只有一层会像"贴了一个圆斑"，
        # 两层才有"光在画面里漫开"的观感 —— 与预览那条 4 段 radial-gradient 同向。
        cx = int(W * p['x'] / 100.0)
        cy = int(W * p['y'] / 100.0)
        R = W * (0.2 + p['r'] * 0.55)
        im = _radial(A, cx, cy, R, hue, min(0.95, p['a'] * 1.4), sat=0.5, core=0.96, falloff=2.6)
        return _radial(im, cx, cy, R * 1.55, hue, min(0.8, p['a'] * 0.72), sat=0.64, core=0.9, falloff=1.5)

    if fam == 'fx-flash':
        cx = int(W * p['x'] / 100.0)
        cy = int(W * p['y'] / 100.0)
        R = p['r'] * W * 0.62
        # core 压到 0.9、饱和提到 0.5：纯白中心会让四个色相看起来一模一样，
        # 而这一族要凑 27 个互不相同的档位，色相必须真的看得见
        im = _radial(A, cx, cy, R, hue, min(1.0, p['a'] * 1.05), sat=0.5, core=0.9, falloff=2.3)
        return ImageEnhance.Brightness(im).enhance(1.0 + p['a'] * 0.12)

    if fam == 'fx-glitch':
        n = max(3, int(round(float(p['n']))))
        shift = p['t']
        im = A.copy()
        rnd = random.Random(seed)
        for i in range(n):
            y0 = int(W * i / float(n))
            hgt = max(3, int(W / float(n) * 0.72))
            off = int(((i * 7 % 5) - 2) * shift * 7)
            strip = A.crop((0, y0, W, min(W, y0 + hgt)))
            im.paste(strip, (off, y0))
            band = Image.new('RGB', strip.size, hsl(hue % 1.0, 0.85, 0.55))
            im.paste(Image.blend(im.crop((0, y0, W, min(W, y0 + hgt))), band, 0.34), (0, y0))
            if off:
                im.crop((0, y0, W, min(W, y0 + hgt)))
        # 红青错位：整体错开一点，故障感主要来自横条与色带
        _ = rnd
        return im

    if fam == 'fx-shake':
        amp = int(W * float(p['t']) / 100.0 * 6)
        ghost = Image.blend(A, ImageChops.offset(A, amp, -amp // 2), 0.5)
        return ghost

    if fam == 'fx-scan':
        gap = max(3, int(round(float(p['n']))))
        layer = Image.new('RGB', (W, W), (0, 0, 0))
        d = ImageDraw.Draw(layer)
        col = hsl(hue % 1.0, 0.22, 0.9)
        for y in range(0, W, gap):
            d.line([(0, y), (W, y)], fill=col, width=1)
        return _add_layer(A, layer, 0.34)

    if fam == 'fx-lightleak':
        return _add_layer(A, _band_layer((W, W), p['h'], p['a'] * 1.5))

    if fam == 'fx-cold':
        # 雾的**方向**（--fx-deg）是这一族少数能一眼看出的差别，纯靠浓淡挤不出 27 个档位。
        # 逐像素算投影坐标 u：180deg 时 u=y（水平铺开），132deg 时 y 与 x 各占一半（斜铺）。
        y0 = p['y'] / 100.0
        deg = float(p['t'])
        kx = 0.0 if deg >= 170 else 0.62
        col = hsl(hue % 1.0, 0.52, 0.76)
        px = A.load()
        out = A.copy()
        dst = out.load()
        for y in range(W):
            for x in range(W):
                u = (1.0 - kx) * (y / float(W - 1)) + kx * (x / float(W - 1))
                k = 1.0 - min(1.0, abs(u - y0) / 0.78)
                if k <= 0.01:
                    continue
                dst[x, y] = _lerp_rgb(px[x, y], col, min(1.0, k * p['a'] * 1.6))
        return out.filter(ImageFilter.GaussianBlur(W * 0.006))

    if fam == 'fx-fire':
        layer = Image.new('RGB', (W, W), (0, 0, 0))
        d = ImageDraw.Draw(layer)
        for i in range(24):
            x = int(W * (0.04 + 0.92 * (((i * 37 + seed) % 100) / 100.0)))
            top = int(W * (0.96 - p['r'] * (0.55 + 0.4 * ((i * 29 + seed) % 97) / 97.0)))
            col = hsl((hue + 0.03 * (i / 23.0)) % 1.0, 0.95, 0.56)
            d.line([(x, W), (x, top)], fill=col, width=6)
        layer = layer.filter(ImageFilter.GaussianBlur(W * 0.013))
        return _add_layer(A, layer, p['a'] * 1.35)

    if fam == 'fx-pulse':
        # 同心环荡开：幅度 t 决定环走多远、节奏 d 决定环的疏密、h 决定光色
        amp = float(p['t'])
        gapish = 0.15 + (2200.0 - min(2200.0, float(p['d']))) / 2200.0 * 0.16
        layer = Image.new('RGB', (W, W), (0, 0, 0))
        d = ImageDraw.Draw(layer)
        centre = W / 2.0
        r_in = W * (0.06 + (amp - 1.0) * 1.2)
        for i in range(4):
            rr = int(r_in + W * gapish * i)
            if rr <= 2 or rr > W:
                continue
            col = hsl(hue % 1.0, 0.85, 0.68 - 0.09 * i)
            d.ellipse([centre - rr, centre - rr, centre + rr, centre + rr],
                      outline=col, width=max(2, int(W * 0.016)))
        layer = layer.filter(ImageFilter.GaussianBlur(W * 0.012))
        return _add_layer(A, layer, 0.85)

    # 兜底：未知族给"一圈柔光"，至少不是"和底片完全一样"
    return _radial(A, W // 2, int(W * 0.46), W * 0.4, 0.11, 0.4)


# ---------------------------------------------------------------- 主流程

def _grain(im, seed):
    """统一压一层极细噪点：真实画面本来就有颗粒，干净的底片放大后偏"塑料"。"""
    rnd = random.Random(seed)
    px = im.load()
    for _ in range(260):
        x = rnd.randrange(im.size[0])
        y = rnd.randrange(im.size[1])
        r, g, b = px[x, y]
        k = rnd.choice((-6, -3, 3, 6))
        px[x, y] = (max(0, min(255, r + k)), max(0, min(255, g + k)), max(0, min(255, b + k)))
    return im


def pack_frame(pack_id):
    """从 `.yjpack` 里取一张真实的帧（RGBA，480×270）。

    ⚠️ 直接从**发行用的那个包**里读，而不是读 `tools/fxpacks-src/`：
       后者是生成中间产物、不入库，CI 上没有；而包里那份是唯一真源。
    ⚠️ 包里没有这个效果时返回 None，调用方退回纯底片 —— 让"缺素材"表现为
       "卡片上没有特效"，而不是脚本崩掉、整套缩略图生成不出来。
    """
    if not os.path.isfile(PACK_ZIP):
        return None
    name = 'frames/%s/f%03d.png' % (pack_id, PACK_FRAME_INDEX)
    try:
        with zipfile.ZipFile(PACK_ZIP) as zf:
            with zf.open(name) as fh:
                return Image.open(io.BytesIO(fh.read())).convert('RGBA')
    except (KeyError, zipfile.BadZipFile, OSError):
        return None


def render(css):
    """
    按**效果键**出图，不是按名字出图。

    名字多、键少（499 个滤镜名落在 67 个键上）。早先是"一个名字一张图"，
    同一按键的 12 个名字就得到 12 张只差一点点噪点的图 —— 白占体积，还让人以为
    这 12 条互不相同。按键出图的含义很直接：**同一个键就是同一个效果，图也该同一张**。
    """
    seed = int(hashlib.sha1(css.encode('utf-8')).hexdigest()[:12], 16)
    if css in TRANSITIONS:
        im = transition_thumb(css, seed)
    elif fx_family(css) in FX_PACK:
        im = base('a', SIZE).convert('RGBA')
        fr = pack_frame(FX_PACK[fx_family(css)])
        if fr is not None:
            # 素材是 16:9，卡片是 1:1 —— 直接铺满（横向压 25%），
            # 这些元素本身是软边光斑/文字，压一点都不违和；
            # 留黑边反而让卡片看起来像"效果只作用在中间一条"。
            sc = float(fx_params(css).get('t') or 1)
            amt = float(fx_params(css).get('a') or 1)
            if amt < 0.999:
                # 叠加强度：乘在素材自己的 alpha 上（预览是 opacity，导出是同义）
                fr.putalpha(fr.split()[3].point(lambda v: int(v * amt)))
            tw = max(2, int(round(SIZE * sc)))
            fr = fr.resize((tw, tw), Image.LANCZOS)
            if sc >= 1:
                # 放大：中心裁回卡片大小（与导出侧的 crop 同向）
                off = (tw - SIZE) // 2
                fr = fr.crop((off, off, off + SIZE, off + SIZE))
                im.alpha_composite(fr)
            else:
                # 缩小：居中贴到透明画布 —— 让"元素变小"，不是"整张图变小"
                off = (SIZE - tw) // 2
                im.alpha_composite(fr, (off, off))
        im = im.convert('RGB')
    elif fx_family(css) in FX:
        im = fx_thumb(css, seed)
    else:
        im = apply_look_photo(base('a', SIZE), FILTER_PARAMS.get(css, {}))
    return _grain(im, seed)


def render_adjust(adj):
    """调节同理：按**参数组合**出图（参数完全相同就是同一个效果）。"""
    key = json.dumps(adj, sort_keys=True, separators=(',', ':'))
    seed = int(hashlib.sha1(('adj|' + key).encode('utf-8')).hexdigest()[:12], 16)
    return _grain(adjust_photo(base('a', SIZE), adj), seed)


def main():
    src = io.open(MAT, encoding='utf-8').read()
    pairs = ITEM_RE.findall(src)
    if not pairs:
        print('没解析到条目，正则要更新')
        return 1

    adj_section = ADJ_SECTION_RE.search(src)
    adj_items = ADJ_ITEM_RE.findall(adj_section.group(2)) if adj_section else []
    if not adj_items:
        print('没解析到调节条目，正则要更新')
        return 1
    print('条目数：滤镜/转场/特效 %d 条 · 调节 %d 条' % (len(pairs), len(adj_items)))

    # 不整目录抹掉：只写本次需要的图，跑完再把"没人引用的旧图"**挪**到
    # `_probe/stale-thumbs/`（可回滚），而不是删。
    #
    # 为什么改掉 `shutil.rmtree(OUT)`：
    #   ① 一次删 170+ 个文件会触发工作区的批量删除保护（SAFE_DELETE_BULK_CONFIRM_REQUIRED），
    #      生成器直接中断，而**中断发生在写图之前**，界面上看到的是"图还是旧的、一条没报错"；
    #   ② 这个目录里混着别人的产物可能性永远存在 —— 一个"只该管自己的图"的生成器
    #      不该有权限抹掉整个目录。挪走比删掉更安全：真出问题还能捞回来。
    os.makedirs(OUT, exist_ok=True)

    def thumb_name(kind, key):
        return hashlib.sha1((kind + '|' + key).encode('utf-8')).hexdigest()[:12] + '.webp'

    keep = set()

    # 滤镜/转场/特效：一个效果键一张图
    css_set = {css for _name, css in pairs}
    for css in sorted(css_set):
        name = thumb_name('css', css)
        keep.add(name)
        render(css).save(os.path.join(OUT, name), 'WEBP', quality=QUALITY, method=4)

    # 调节：一组参数一张图
    adj_by_name = {}
    adj_set = {}
    for q, name, body in adj_items:
        # adjust 体是 JS 对象字面量（键是裸的），转成 JSON 读参数
        adj = json.loads(re.sub(r'([{,\s])(\w+):', r'\1"\2":', body))
        adj_by_name[name] = adj
        adj_set[json.dumps(adj, sort_keys=True, separators=(',', ':'))] = adj
    for key, adj in adj_set.items():
        name = thumb_name('adj', key)
        keep.add(name)
        render_adjust(adj).save(os.path.join(OUT, name), 'WEBP', quality=QUALITY, method=4)

    # 挪走没人引用的旧图（不删）：换键名、删效果之后必然留下一批孤儿，
    # 而"孤儿图"是闸门 ⑦ 要判的 —— 留在目录里会让闸门红，删掉又违反批量删除保护。
    stale_dir = os.path.join(ROOT, '_probe', 'stale-thumbs', time.strftime('%Y%m%d-%H%M%S'))
    moved = 0
    for f in sorted(os.listdir(OUT)):
        if f in keep:
            continue
        os.makedirs(stale_dir, exist_ok=True)
        shutil.move(os.path.join(OUT, f), os.path.join(stale_dir, f))
        moved += 1
    if moved:
        print('旧的无人引用图 %d 张 → %s' % (moved, os.path.relpath(stale_dir, ROOT)))

    def repl(m):
        name, css = m.group(1), m.group(2)
        return '{ zh: "%s", thumb: "%s", css: "%s" }' % (name, thumb_name('css', css), css)

    out = ITEM_RE.sub(repl, src)

    def adj_repl(m):
        q, name, body = m.group(1), m.group(2), m.group(3)
        key = json.dumps(adj_by_name[name], sort_keys=True, separators=(',', ':'))
        return '{ zh: %s%s%s, thumb: "%s", adjust: %s }' % (q, name, q, thumb_name('adj', key), body)

    adj_section = ADJ_SECTION_RE.search(out)
    head, body, tail = adj_section.group(1), ADJ_ITEM_RE.sub(adj_repl, adj_section.group(2)), adj_section.group(3)
    out = out[:adj_section.start()] + head + body + tail + out[adj_section.end():]

    # 缩略图统一是 webp（真实画面用 PNG 会大 4~5 倍）
    out = out.replace("'./assets/materials/*.png'", "'./assets/materials/*.webp'")
    io.open(MAT, 'w', encoding='utf-8', newline='').write(out)

    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    files = len(os.listdir(OUT))
    print('生成缩略图：%d 张（效果键 %d + 调节参数组 %d）/ %.2f MB'
          % (files, len(css_set), len(adj_set), total / 1024.0 / 1024.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
