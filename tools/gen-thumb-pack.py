#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把取景底片打成一个**本地素材包**（`.yjpack`）—— 缩略图生成器只认这个包。

## 为什么底片要装进包里，而不是散在 tools/thumb-bases/

底片以前是两张散图（base-a.png / base-b.png）。散图的问题是**没有出处**：
图是谁、什么时候、按什么要求生成/挑选的，全靠一句注释。换人接手时无从判断，
于是下一次"顺手换张好看的图"就会把缩略图的可辨识度悄悄弄没（这个坑踩过一次：
逆光黄昏人像缩到 100px 之后六种调色看着一样，等于整页缩略图白做）。

打成 `.yjpack` 之后：
  · 底片和产品里"导入素材包"是**同一个格式**，有清单、有名字、有来源说明；
  · 生成器从包里取图（`zipfile` 直读，不用解压到磁盘），包里没有就报错，
    不会静默退回某个"还在的老文件"；
  · 想换底片 = 换包，不碰代码。

## 底片的选型要求（不是随便找张好看的图）

必须在**缩到 192px 之后**仍然一眼能读出「色相偏移 / 光晕 / 颗粒 / 模糊 / 边缘」这五件事。
实测有效的共同点是：**硬光、高饱和、有明确的大色块彼此相邻**（红墙 / 蓝衣 / 黄条纹 / 蓝天）。
低反差、灰调、逆光的画面在卡片尺寸上各种调色看着一个样 —— 这正是参考项目踩过并写进提交说明的坑。

⚠️ 底片是**生成用素材，不进安装包**（本目录不在 packages/ 下，不被打包）。
   重新打包：`python tools/gen-thumb-pack.py`
   素材来源：`tools/thumb-bases/raw/*.png`（本项目用 AI 生成，无水印区域经中心裁切剔除）
"""
import json
import os
import sys
import zipfile

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BASE_DIR = os.path.join(ROOT, 'tools', 'thumb-bases')
RAW_DIR = os.path.join(BASE_DIR, 'raw')
PACK = os.path.join(BASE_DIR, 'frames.yjpack')

# 输出边长。生成器最终只用 192px，但底片要留够余量：
# 转场缩略图会把 A/B 两张各自缩放，留 640 才能在缩放后仍然锐利。
SIZE = 640

# which 是生成器里 `base(which)` 的键。顺序即清单顺序。
#   硬光人像 = 主力底片（调色/特效/转场都在它上面判读）
#   风景     = 转场 B 画面（A 人像 → B 风景，接缝最清楚）
#   美食     = 暖调类效果的补充底片
#   夜色     = 冷调/霓虹/光效类效果的补充底片
ITEMS = [
    ('a', 'portrait', '人像·硬光', 'Editorial_photo_shot_in_hard_d'),
    ('b', 'scene', '风景·丹霞', 'Landscape_photo_in_hard_midday'),
    ('c', 'food', '美食·红油', 'Close_up_food_photo__extremely'),
    ('d', 'night', '夜色·霓虹', 'Night_city_street_after_rain'),
]


def pick_raw(prefix):
    """按前缀找源图。找不到就报错 —— 不猜、不退回别的图。"""
    if not os.path.isdir(RAW_DIR):
        raise SystemExit('缺少源素材目录：%s' % RAW_DIR)
    hits = sorted(
        f for f in os.listdir(RAW_DIR)
        if f.startswith(prefix) and f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))
    )
    if not hits:
        raise SystemExit('缺少源素材：%s*（在 %s 里）' % (prefix, RAW_DIR))
    return os.path.join(RAW_DIR, hits[-1])


def center_crop(im, size):
    """
    裁出 1:1 底片，**刻意避开右下角**。

    AI 生成图右下角固定带「AI生成 / WORKBUDDY」水印（实测在原图 x≈894-1008、
    y≈959-1008，即最外 15%）。底片会出现在每一张缩略图上，水印必须一点不留 ——
    先切掉右侧与底部各 15% 再在剩下的 85% 里取中心方形，
    这样无论水印具体几像素宽，都落在画外。
    （一开始按"中心 1:1 裁切就能裁掉"处理过，结果水印原样留在了缩略图右下角。）
    """
    w, h = im.size
    keep_w = int(w * 0.85)
    keep_h = int(h * 0.85)
    im = im.crop((0, 0, keep_w, keep_h))
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    im = im.crop((left, top, left + side, top + side))
    return im.resize((size, size), Image.LANCZOS)


def main():
    tmp = os.path.join(BASE_DIR, '_pack_tmp')
    os.makedirs(tmp, exist_ok=True)

    items = []
    for which, slug, label, prefix in ITEMS:
        src = pick_raw(prefix)
        im = Image.open(src).convert('RGB')
        im = center_crop(im, SIZE)
        out = os.path.join(tmp, '%s.png' % slug)
        im.save(out, 'PNG', optimize=True)
        items.append({
            'file': 'images/%s.png' % slug,
            'which': which,
            'label': label,
            'source': os.path.basename(src),
        })
        print('  %-10s %-12s %6.1f KB  <- %s' % (slug, label, os.path.getsize(out) / 1024.0, os.path.basename(src)))

    manifest = {
        'schema': 1,
        'id': 'thumb-base',
        'name': '缩略图取景底片',
        'version': '1.0.0',
        'author': '艺镜AI剪辑',
        # kind 取 sticker 是为了"这个包也能被产品导入"时落在有画面的库里；
        # 真正标识用途的是下面的 role —— 生成器只认 role。
        'kind': 'sticker',
        'role': 'thumb-base',
        'note': '构建期取景素材，不进安装包。换底片请改 tools/gen-thumb-pack.py 的 ITEMS。',
        'items': items,
    }

    tmp_manifest = os.path.join(tmp, 'manifest.json')
    with open(tmp_manifest, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    with zipfile.ZipFile(PACK, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(tmp_manifest, 'manifest.json')
        for it in items:
            z.write(os.path.join(tmp, os.path.basename(it['file'])), it['file'])

    print('\n写好 %s（%.1f KB，%d 张底片）' % (PACK, os.path.getsize(PACK) / 1024.0, len(items)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
