#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
特效「一卡一键」分配器 —— 把 267 个去重名字落到 267 个**参数组合**上。

背景：特效页 343 张卡 / 267 个去重名字，此前只落在 24 个效果键上
（fx-glow 一个键就占了 83 张卡）。点 20 张名字完全不同的卡出来是同一个效果，
而所有静态判据（每键有样式、有导出分支、有缩略图）都是绿的 —— 因为"键少、名字多"
这件事本身没有被任何判据盯着。

做法与滤镜页（tools/gen-look-params.py）同一套：
  ① 每个族有一个参数空间（shared/fxParams.json，JS/Python 共用）；
  ② 候选按"温和优先"排序（离默认档越近越靠前）；
  ③ 贪心挑：每挑一个，要求它与此前已挑的**每一个**缩略图差都 ≥ 阈值；
  ④ 挑够该族名字数就停；
  ⑤ 名字按出现顺序领档位（同名卡共用同一个键 —— 那本来就是同一个效果）。

⚠️ 用**缩略图**判差异，不是用参数差：参数上差一档、画面上看不出来，
   就是滤镜页踩过的坑（soft 差 0.021 ≈ 5/255，肉眼完全无感）。

用法：
  python tools/gen-fx-params.py            # 干跑，只打印分配结果
  python tools/gen-fx-params.py --write    # 回写 materials.js 的 css 字段
"""
import io
import os
import re
import sys
import math
import itertools
import hashlib
import importlib.util

from PIL import Image, ImageChops, ImageStat


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MAT = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'materials.js')

# 差异阈值（**组合判据**，见 score()）。
# 只看"全图平均差"会严重低估局部效果：素材类元素只盖住画面一小块，平均下来
# 连 2/255 都不到，而取景框的角落其实一个在天上一个在地下 —— 实测 fm-focus 的
# 八种档位两两平均差最大只有 2.4。所以判据取「平均差」与「局部峰值折算」的较大者。
THRESH = 3.4
# 最远点优先的候选上限：容量大的族（glow 320、vignette 324）全枚举会跑到几分钟，
# 截到前 120 个"最温和"的仍然是在合理空间里挑最散的。
CAND_LIMIT = 120
SAMPLE = 96

# ---------------- 复用缩略图生成器的绘制函数（同一份实现，不另写一套） ----------------
spec = importlib.util.spec_from_file_location('gmt', os.path.join(ROOT, 'tools', 'gen-material-thumbs.py'))
gmt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gmt)

AXES = gmt.FX_AXES
B36 = gmt.B36


def family_of(key):
    return str(key).split('@', 1)[0]


def combo_key(fam, idxs):
    axes = AXES[fam]['axes']
    code = ''.join(B36[min(n, len(a['values']) - 1)] for n, a in zip(idxs, axes))
    return fam if set(code) == {'0'} else fam + '@' + code


def all_combos(fam):
    axes = AXES[fam]['axes']
    for idxs in itertools.product(*[range(len(a['values'])) for a in axes]):
        yield idxs


def mildness(idxs):
    """离默认档（全 0）有多远 —— 归一化到 0..1 再平方，越小越"温和"。"""
    axes = AXES[fam_ref]['axes']
    total = 0.0
    for n, a in zip(idxs, axes):
        span = max(1, len(a['values']) - 1)
        total += (n / float(span)) ** 2
    return total / max(1, len(axes))


def thumb_of(key):
    # 用生成器的 `render()` 而不是 `fx_thumb()`：素材类（fm-*）的像素来自包里，
    # 由 render 分派到 pack 分支；直接调 fx_thumb 会让它们全部落到兜底光斑上，
    # 于是"每个 pack 族只挤得出 1 个档位"——而那不是参数空间的问题，是量错了东西。
    im = gmt.render(key).convert('RGB')
    return im.resize((SAMPLE, SAMPLE), Image.LANCZOS)


def dist(a, b):
    """两个缩略图的差异分 —— **平均差**与**局部峰值折算**取大者。

    为什么不是单纯的平均差：特效大多是**局部**的（一团光、一个取景框、一条光带），
    平均下来会被大片没变的背景稀释到 1~2/255，于是"参数明明差很多"也被判成一样。
    局部峰值取 95 分位（最明显的那 5% 区域差多少），乘 0.35 折算到与平均差同一量纲：
    p95=30 ⇒ 10.5 分，相当于"有一块地方差了 30/255"，那种差别人眼一定看得见。
    """
    d = ImageChops.difference(a, b).convert('L')
    hist = d.histogram()
    total = SAMPLE * SAMPLE
    mean = sum(i * hist[i] for i in range(256)) / float(total)
    acc = 0
    p95 = 0
    for v in range(255, -1, -1):
        acc += hist[v]
        if acc >= total * 0.05:
            p95 = v
            break
    return max(mean, p95 * 0.35)


def pick(fam, need):
    """给一个族挑 need 个**彼此尽量远**的键；返回 (keys, 实际最小差)。

    算法：最远点优先（farthest-first）。
      · 第一个从**默认档**开始 —— 保持"族键 = 最温和的那一档"这条语义，
        老草稿里的 `fx-glow` 因此仍然是最克制的外观；
      · 之后每一步选"与已选集合最小差**最大**"的候选。
    为什么不是"按温和顺序遍历、够阈值就收"：那样选出来的都是**挤在默认档附近**
    的前 N 个，每个都刚好过线。实测暗角族选出的 6 个在 192px 卡片上肉眼几乎一样，
    而分数是 3.98（过线）—— 判据过了、人看不出，等于没做。

    ⚠️ 候选按温和度截断（最多 CAND_LIMIT 个）：最远点优先是 O(候选×已选)，
       320 个候选×68 个名字会跑到几分钟；截断后仍是"温和的一半空间里挑最散的"。
    """
    global fam_ref
    fam_ref = fam
    floor = 1.2 if fam.startswith('fm-') else THRESH
    cands = sorted(all_combos(fam), key=lambda idxs: (mildness(idxs), idxs))
    # 候选上限随需求量走：截太少会让"要 68 个"的族挤不满（截断后空间不够散）。
    # need×8 是实测出来的：vignette 要 27 个，截到 108 个候选时只挤得出 19 个。
    cands = cands[:max(CAND_LIMIT, need * 8)]
    cache = {}
    for idxs in cands:
        key = combo_key(fam, idxs)
        cache[key] = thumb_of(key)
    order = [combo_key(fam, i) for i in cands]

    chosen = [order[0]]
    mind = {k: dist(cache[k], cache[chosen[0]]) for k in order if k != chosen[0]}
    while len(chosen) < need:
        rest = [k for k in order if k not in chosen]
        if not rest:
            break
        best = max(rest, key=lambda k: mind.get(k, 0.0))
        if mind.get(best, 0.0) < floor:
            break
        chosen.append(best)
        for k in rest:
            d = dist(cache[k], cache[best])
            if d < mind.get(k, 1e9):
                mind[k] = d
    # 实际最小差直接两两重算：用增量维护的 mind 会混进"与某个未入选候选的距离"，
    # 报出来的数会比真实值小（曾经打出 0.0）。
    final = min((dist(cache[a], cache[b]) for a, b in itertools.combinations(chosen, 2)), default=0.0)
    return chosen, final


def parse_cards(src):
    """EFFECT_GROUPS 段里的卡片：[(族键, 名字, 完整键)]，保持文件顺序。"""
    i = src.index('export const EFFECT_GROUPS')
    j = src.index('export const ADJUST_GROUPS')
    body = src[i:j]
    cards = []
    for m in re.finditer(r'zh:\s*"([^"]+)",\s*thumb:\s*"[^"]*",\s*css:\s*"([a-z0-9@-]+)"', body):
        cards.append((family_of(m.group(2)), m.group(1), m.group(2)))
    return cards, i, j


def main():
    write = '--write' in sys.argv
    src = io.open(MAT, encoding='utf-8').read()
    cards, start, end = parse_cards(src)
    if not cards:
        print('没解析到特效卡片，正则要更新')
        return 1
    print('特效卡片 %d 张 · 族 %d 个' % (len(cards), len(set(c[0] for c in cards))))

    # 每族：去重名字（按出现顺序）
    names = {}
    for fam, name, _k in cards:
        names.setdefault(fam, [])
        if name not in names[fam]:
            names[fam].append(name)

    assigned = {}   # (fam, name) -> 新键
    report = []
    for fam, list_names in names.items():
        if fam not in AXES:
            # 素材类（fm-*）没有参数轴：像素来自包里，一个键就是一个效果
            for name in list_names:
                assigned[(fam, name)] = fam
            report.append((fam, len(list_names), 1, 0.0, True))
            continue
        need = len(list_names)
        keys, thresh = pick(fam, need)
        for name, key in zip(list_names, keys):
            assigned[(fam, name)] = key
        report.append((fam, need, len(keys), thresh, False))

    print('\n族                名字  选中  阈值')
    bad = []
    for fam, need, got, thresh, is_pack in report:
        flag = ''
        if got < need:
            flag = '  ← 挤不下（缺 %d）' % (need - got)
            bad.append(fam)
        print('  %-14s %4d  %4d  最小差 %4.1f%s' % (fam, need, got, thresh, flag))

    total_keys = len(set(assigned.values()))
    print('\n去重效果键 %d 个（目标 = 去重名字 %d 个）' % (total_keys, len(set((c[1]) for c in cards))))

    if not write:
        print('\n（干跑）加 --write 回写 materials.js 的 css 字段')
        return 0

    # 回写：只动 EFFECT_GROUPS 段内的 css 字段；thumb 由生成器按新键重算
    body = src[start:end]
    changed = 0

    def repl(m):
        nonlocal changed
        name, old = m.group(1), m.group(2)
        fam = family_of(old)
        new = assigned.get((fam, name), old)
        if new != old:
            changed += 1
        return m.group(0).replace('css: "%s"' % old, 'css: "%s"' % new)

    new_body = re.sub(r'zh:\s*"([^"]+)",\s*thumb:\s*"[^"]*",\s*css:\s*"([a-z0-9@-]+)"', repl, body)
    io.open(MAT, 'w', encoding='utf-8', newline='').write(src[:start] + new_body + src[end:])
    print('回写完成：%d 张卡的键发生变化' % changed)
    print('下一步：python tools/gen-material-thumbs.py（按新键重画缩略图并刷新 thumb 字段）')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
