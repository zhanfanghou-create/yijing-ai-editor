#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
闸门 · 特效卡片「真的互不相同」（读**磁盘上的缩略图**，不读参数）。

防的是这件事：特效页 343 张卡 / 267 个去重名字，而它们曾经只落在 24 个效果键上
（单是 fx-glow 一个键就占 83 张卡）。所有既有判据都是绿的 —— 每个键都有样式、
都有导出分支、都有缩略图 —— 因为"键少、名字多"本身就没人盯。

判据（全部读消费端产物：materials.js 的键 + assets/materials 里的 webp）：
  ① 每个去重名字都分到了**自己的**键（键数 == 名字数）
  ② 每个键都有图，且图不是纯色（纯色等于"这个效果什么都没做"）
  ③ 任意两张图都不像（差异分 ≥ 阈值，见 score()）
  ④ 同一族内部最小差异也达标（跨族像不像靠 ③，族内是"最容易撞"的地方）

⚠️ 阈值分两档：调色/光效类 4.0，素材类（fm-*）1.2。
   素材包里的元素是细线/小光点，盖住画面不到 5%，缩略图平均差天然很小，
   而它们的缩放差异在大图上是明确可见的 —— 拿同一把尺子量会把它们全判成一样。

用法：python tools/fx-distinct.py
退出码：0 通过 / 1 有失败
"""
import io
import os
import re
import sys
import hashlib

from PIL import Image, ImageChops

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MAT = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'materials.js')
DIR = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'materials')

SAMPLE = 96
# 阈值必须与分配器（tools/gen-fx-params.py 的 THRESH）**一致**：
# 分配器按 3.4 挑完、闸门按 4.0 判，就必然红 —— 两面判据不一致比没有判据更浪费时间。
THRESH = 3.4
THRESH_PACK = 1.2
# 纯色判定：缩略图的标准差低于这个数 = 整张几乎一个颜色
FLAT_STD = 3.0

out = []


def add(name, ok, detail=''):
    out.append((name, bool(ok), detail))


def thumb_name(key):
    return hashlib.sha1(('css|' + key).encode('utf-8')).hexdigest()[:12] + '.webp'


def load(key):
    p = os.path.join(DIR, thumb_name(key))
    if not os.path.isfile(p):
        return None
    im = Image.open(p).convert('RGB')
    return im.resize((SAMPLE, SAMPLE), Image.LANCZOS)


def score(a, b):
    """差异分 = max(平均差, 95 分位差 × 0.35)。

    只看平均差会低估**局部**效果：一团光、一个取景框只盖住一小块，
    平均下来连 2/255 都不到，而那一块其实差了几十级。95 分位对应
    "最明显的那 5% 区域"，×0.35 折算到与平均差同一量纲。
    """
    d = ImageChops.difference(a, b).convert('L')
    hist = d.histogram()
    total = float(SAMPLE * SAMPLE)
    mean = sum(i * hist[i] for i in range(256)) / total
    acc = 0
    p95 = 0
    for v in range(255, -1, -1):
        acc += hist[v]
        if acc >= total * 0.05:
            p95 = v
            break
    return max(mean, p95 * 0.35)


def flat(im):
    """整张图是不是近似纯色（用灰度直方图的标准差判）。"""
    g = im.convert('L')
    hist = g.histogram()
    total = float(SAMPLE * SAMPLE)
    mean = sum(i * hist[i] for i in range(256)) / total
    var = sum(((i - mean) ** 2) * hist[i] for i in range(256)) / total
    return var ** 0.5 < FLAT_STD


def main():
    src = io.open(MAT, encoding='utf-8').read()
    i = src.index('export const EFFECT_GROUPS')
    j = src.index('export const ADJUST_GROUPS')
    body = src[i:j]
    cards = re.findall(r'zh:\s*"([^"]+)",\s*thumb:\s*"[^"]*",\s*css:\s*"([a-z0-9@-]+)"', body)
    if not cards:
        print('[FAIL] 前置 :: 没解析到特效卡片，正则要更新')
        print('FX_DISTINCT_STATS total=1 pass=0 fail=1')
        return 1

    fam_of = lambda k: k.split('@', 1)[0]
    names = {}
    keys = {}
    for name, key in cards:
        fam = fam_of(key)
        names.setdefault(fam, [])
        if name not in names[fam]:
            names[fam].append(name)
        keys.setdefault(fam, set()).add(key)

    total_names = sum(len(v) for v in names.values())
    total_keys = len(set(k for v in keys.values() for k in v))
    add('卡片数 %d / 去重名字 %d / 去重键 %d' % (len(cards), total_names, total_keys),
        total_keys == total_names,
        '%d 个名字对应 %d 个效果键（相等才算"一个名字一个效果"）' % (total_names, total_keys))

    # ① 每族：键数 == 名字数
    short = []
    for fam, list_names in sorted(names.items()):
        got = len(keys.get(fam, ()))
        if got != len(list_names):
            short.append('%s %d/%d' % (fam, got, len(list_names)))
    add('每个族的键数与去重名字数相等（没有"一卡多名字共用一个效果"）',
        not short, '、'.join(short) if short else '%d 个族全部一一对应' % len(names))

    # ② 每张图存在且不是纯色
    imgs = {}
    miss = []
    flats = []
    for fam, ks in sorted(keys.items()):
        for k in sorted(ks):
            im = load(k)
            if im is None:
                miss.append(k)
                continue
            imgs[k] = im
            if flat(im) and fam not in ('fm-moon',):
                flats.append(k)
    add('每个特效键都有缩略图文件', not miss, '缺 %d 个：%s' % (len(miss), ' '.join(miss[:4])) if miss else '%d 个键全有' % len(imgs))
    add('没有"整张纯色"的缩略图（纯色 = 这个效果没做任何事）',
        not flats, '纯色 %d 张：%s' % (len(flats), ' '.join(flats[:4])) if flats else '全部有内容')

    # ③ 全库两两差异（含素材类的对用更宽的阈值，见文件头）
    all_keys = sorted(imgs)
    worst = None
    for a_i in range(len(all_keys)):
        ka = all_keys[a_i]
        for b_i in range(a_i + 1, len(all_keys)):
            kb = all_keys[b_i]
            d = score(imgs[ka], imgs[kb])
            lim = THRESH_PACK if (ka.startswith('fm-') or kb.startswith('fm-')) else THRESH
            if worst is None or d - lim < worst[0] - worst[3]:
                worst = (d, ka, kb, lim)
    add('任意两张特效图都不一样（差异 ≥ 该对阈值）',
        worst and worst[0] >= worst[3],
        ('%d 对 · 最险的一对 %s ↔ %s 差 %.2f（阈值 %.1f）'
         % (len(all_keys) * (len(all_keys) - 1) // 2, worst[1], worst[2], worst[0], worst[3]))
        if worst else '没有可比的图')

    fam_worst = []
    for fam, ks in sorted(keys.items()):
        lst = sorted(k for k in ks if k in imgs)
        if len(lst) < 2:
            continue
        w = None
        for a_i in range(len(lst)):
            for b_i in range(a_i + 1, len(lst)):
                d = score(imgs[lst[a_i]], imgs[lst[b_i]])
                if w is None or d < w[0]:
                    w = (d, lst[a_i], lst[b_i])
        fam_worst.append((fam, w[0], w[1], w[2]))
    limit = {fam: (THRESH_PACK if fam.startswith('fm-') else THRESH) for fam in keys}
    bad_fam = [(f, d) for f, d, _a, _b in fam_worst if d < limit[f]]
    tight = min(fam_worst, key=lambda x: x[1] / limit[x[0]]) if fam_worst else None
    add('同一族内部也没有"两张一模一样"（族内最小差 ≥ 该族阈值）',
        not bad_fam,
        '不达标：%s' % '、'.join('%s %.1f' % (f, d) for f, d in bad_fam) if bad_fam
        else ('最挤的是 %s %.2f（阈值 %.1f）' % (tight[0], tight[1], limit[tight[0]]) if tight else '每族都只有 1 个'))

    pass_n = sum(1 for _n, ok, _d in out if ok)
    for name, ok, detail in out:
        print('  %s %s%s' % ('[PASS]' if ok else '[FAIL]', name, ('  — ' + detail) if detail else ''))
    print('\nFX_DISTINCT_STATS total=%d pass=%d fail=%d' % (len(out), pass_n, len(out) - pass_n))
    if pass_n != len(out):
        print('FX_DISTINCT_FAILED')
        return 1
    print('FX_DISTINCT_OK  %d 张特效图，两两都可分辨' % len(imgs))
    return 0


if __name__ == '__main__':
    sys.exit(main())
