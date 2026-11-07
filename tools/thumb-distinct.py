#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
闸门 · 947 张素材缩略图「两两看得出差别」。

判据在 Python 里（要解码 webp，Node 侧没有零依赖解码器），入口是
`tools/check-thumb-distinct.mjs`（只负责找解释器并转发退出码）。

---------------------------------------------------------------------------
这道闸门防的是什么
---------------------------------------------------------------------------
结构层的判据全都是绿的，而用户眼前是"两张一模一样的卡"：

  · check-material-thumbs —— 每张卡都有图、键与图一一对应、不是空壳 ✓
  · check-transition-distinct —— 204 条转场的**空间场**两两差 ≥ 0.02 ✓

2026-11-03 fine 实测：`水平线`(stripe n=8 顺次) 与 `下移`(lin 90°) 的场差 0.036，
在闸门里算"安全区"，可缩略图上只有 **1.92 ΔE** —— 48×27 的卡片上肉眼分不出。
同一天还有 `马赛克`(grid order 0) 与它俩三张几乎相同：order 0 是**整行推进**，
场值只按行递增，任何进度都是"上面若干整行已翻" —— 那不是网格，是横带擦除。

也就是说：**场差 ≠ 观感差**。32×32 的单通道亮度场把"A 画面还是 B 画面"糊成两个
标量，局部差异被整幅平均掉；用户看的是彩色小图。

所以这道闸门不看参数、不看场，只把**缩略图本身**两张两张地比
（缩到 48×27 后在 Lab 空间求平均色差 ≈ 卡片上的观感）。

判据：任意两张的 ΔE ≥ 3.5（阈值的来历见下面 THRESHOLD）。

---------------------------------------------------------------------------
为什么必须防"空集恒真"
---------------------------------------------------------------------------
如果目录里一张图都没有，"两两没有撞脸"是恒真的 —— 那闸门会绿得毫无意义。
所以第一条断言是**张数下限**；数量不足直接判失败，而不是"没什么可比，通过"。

用法：
  python tools/thumb-distinct.py             # 校验真实仓库
  python tools/thumb-distinct.py --selftest  # 判据自证（人造图，秒级）
"""

import io
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'assets', 'materials')

# 卡片上的观感尺寸：工作台素材面板的卡片缩略图约 96×54，取一半（48×27）留余量。
# 不取更小是因为再小就只剩大色块，会把"色相相近但布局不同"的两张判成一样。
CARD_W, CARD_H = 48, 27
# 粗筛用的低分辨率：先把不可能接近的对扔掉，只对候选精算。
COARSE_W, COARSE_H = 12, 7
# 粗筛保留门槛。粗差会把局部差异平均掉（实测粗差 ≤ 细差），所以这里留足余量：
# 宁可多精算几千对，也不能把真正接近的那一对筛掉。
COARSE_KEEP = 40.0

# 判据阈值（与 gen-look-params.py 的 MIN_DE 同口径：Lab 三通道绝对差之和 / 像素数）。
# 这一天的实测分布（947 张 / 447931 对）：最小 3.85 · 低于 5 的 21 对 · 中位 52.7。
# 取 3.5 是**硬底线**：比当下最小值留 0.35 余量（不脆），把"肉眼基本难分"挡在外面。
# ⚠️ 滤镜分配器 gen-look-params.py 的目标是 5.5（更严），当下还有 21 对在 3.85~5 之间
#    （冷白餐盘↔清透、特效焦点框那一组、曼谷霓虹↔浓郁…）—— 那些是待办，不是本闸门的红线。
#    红线定在 3.5 而不是 5.5，是为了让闸门能先立起来：定在 5.5 会让它长期红着，
#    红久了的闸门等于没有闸门。
THRESHOLD = 3.5

# 参考目标（**不判红**，只写进结论）：`gen-look-params.py` 的 MIN_DE —— 分配滤镜参数时
# 保证"任意两个键的缩略图平均色差 ≥ 5.5"。低于它的对说明实际效果比分配时更挤。
TARGET = 5.5

# 张数下限：947 张（2026-11-03）。留一成余量防止正常的卡片增减误伤，
# 但目录被读错、被清空、glob 失配时必须红。
MIN_FILES = 850


def lab_vector(path, w, h):
    with Image.open(path) as im:
        small = im.convert('RGB').resize((w, h), Image.LANCZOS)
        return [tuple(p) for p in small.convert('LAB').get_flattened_data()]


def delta_e(a, b):
    """两张卡片的平均色差。

    口径：Lab 三通道**绝对差之和**再除以像素数（0..765 量级），与
    `tools/gen-look-params.py` 的 `dist()`、`gen-material-thumbs.py` 的 `dist()`
    完全同式 —— 三处必须是同一把尺子，否则"分配器觉得够远、闸门觉得撞脸"。
    （不是 CIELAB 的 sqrt(ΔL²+Δa²+Δb²) 那个 ΔE；名字沿用项目里的叫法。）
    """
    total = 0
    for p, q in zip(a, b):
        total += abs(p[0] - q[0]) + abs(p[1] - q[1]) + abs(p[2] - q[2])
    return total / float(len(a))


def judge(files, min_files=None):
    """纯函数：输入 [(名字, 粗向量, 细向量)]，输出 (通过?, 说明, 最像的若干对)。

    `min_files` 只给 selftest 用（人造图不必造满 850 张）；真实校验一律用 MIN_FILES。
    """
    if min_files is None:
        min_files = MIN_FILES
    if len(files) < min_files:
        return False, '张数只有 %d（下限 %d）—— 多半是目录读错或图没生成，不是"没有撞脸"' % (
            len(files), min_files), []

    pairs = []
    n = len(files)
    for i in range(n):
        name_i, coarse_i, fine_i = files[i]
        for j in range(i + 1, n):
            d_coarse = delta_e(coarse_i, files[j][1])
            if d_coarse > COARSE_KEEP:
                continue
            pairs.append((delta_e(fine_i, files[j][2]), name_i, files[j][0]))

    pairs.sort()
    worst = pairs[:8]
    if not pairs:
        return True, '%d 张两两相距都超过粗筛门槛，无需精算' % n, []
    # 分布带出来（不判红）：调阈值、定待办时需要"有多少对落在 5.5 以下"这种事实，
    # 而不是只有"最小的一对是多少"。
    below = sum(1 for p in pairs if p[0] < TARGET)
    extra = '；低于分配器目标 %.1f 的 %d 对' % (TARGET, below)
    if worst[0][0] < THRESHOLD:
        return False, '最像的一对 %s ↔ %s 只有 %.2f（阈值 %.1f）%s' % (
            worst[0][1], worst[0][2], worst[0][0], THRESHOLD, extra), worst
    return True, '最像的一对 %s ↔ %s 差 %.2f（阈值 %.1f）%s' % (
        worst[0][1], worst[0][2], worst[0][0], THRESHOLD, extra), worst


def load():
    names = sorted(f for f in os.listdir(DIR) if f.endswith('.webp'))
    out = []
    for name in names:
        path = os.path.join(DIR, name)
        out.append((name, lab_vector(path, COARSE_W, COARSE_H), lab_vector(path, CARD_W, CARD_H)))
    return out


# ---------------------------------------------------------------- selftest
def selftest():
    """判据自证：人造图分别证明"该红的时候红在对的那一条上"。"""
    import tempfile

    tmp = tempfile.mkdtemp(prefix='thumb-distinct-')
    results = []

    def vec(name, color):
        path = os.path.join(tmp, name)
        if not os.path.exists(path):
            Image.new('RGB', (192, 108), color).save(path, 'PNG')
        return lab_vector(path, CARD_W, CARD_H)

    # 与 a/b 都拉开距离的陪衬（够 selftest 的下限即可，不必造满 850 张）
    PAD_N = 20
    pad = []
    for i in range(PAD_N):
        color = ((i * 37 + 11) % 256, (i * 91 + 23) % 256, (i * 151 + 7) % 256)
        v = vec('pad%d.png' % i, color)
        pad.append(('pad%d' % i, v, v))

    # ① 两张同色 → 必须拦下（同色对是陪衬里唯一接近的一对）
    va = vec('same-a.png', (30, 60, 200))
    vb = vec('same-b.png', (30, 60, 200))
    ok1, msg1, _ = judge([('same-a', va, va), ('same-b', vb, vb)] + pad, min_files=PAD_N + 2)
    results.append(('同色两张必须判失败（%s）' % msg1, ok1 is False))

    # ② 张数够且颜色各异 → 必须通过
    ok2, msg2, _ = judge(pad, min_files=PAD_N)
    results.append(('张数够且颜色各异必须通过（%s）' % msg2, ok2 is True))

    # ③ 张数不足 → 必须判失败（防空集恒真：目录空了"没有撞脸"恒真）
    ok3, msg3, _ = judge(pad[:10], min_files=PAD_N)
    results.append(('张数不足必须判失败（%s）' % msg3, ok3 is False))

    # ④ 只差一点点（肉眼难分的量级）→ 必须判失败：证明阈值不是摆设，
    #    否则"粗差 ≤ 细差"这套筛法只要写错一个符号就会静默放行。
    na = vec('near-a.png', (100, 100, 100))
    nb = vec('near-b.png', (102, 100, 100))
    ok4, msg4, _ = judge([('near-a', na, na), ('near-b', nb, nb)] + pad, min_files=PAD_N + 2)
    results.append(('差一点点也必须拦下（%s）' % msg4, ok4 is False))

    bad = [r for r in results if not r[1]]
    for name, passed in results:
        print('  %s %s' % ('✓' if passed else '✗', name))
    print('THUMB_DISTINCT_SELFTEST total=%d pass=%d fail=%d' % (len(results), len(results) - len(bad), len(bad)))
    if not bad:
        print('THUMB_DISTINCT_SELFTEST_OK')
    return 1 if bad else 0


def main():
    if '--selftest' in sys.argv:
        sys.exit(selftest())

    files = load()
    ok, detail, worst = judge(files)
    print('缩略图 %d 张 · 判据：任意两张的 Lab 平均色差 ≥ %.1f（48×27，卡片观感尺寸）'
          % (len(files), THRESHOLD))
    for d, a, b in worst:
        print('    ΔE %6.2f  %s ↔ %s' % (d, a, b))
    print('  %s %s' % ('✓' if ok else '✗', detail))
    print('THUMB_DISTINCT_STATS total=2 pass=%d fail=%d skip=0' % (1 if ok else 0, 0 if ok else 1))
    if ok:
        print('THUMB_DISTINCT_OK')
        sys.exit(0)
    print('THUMB_DISTINCT_FAIL')
    sys.exit(1)


if __name__ == '__main__':
    main()
