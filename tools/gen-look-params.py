#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成「滤镜」页的参数表：**一个名字一个真效果**。

--------------------------------------------------------------------------------
为什么要有这个脚本
--------------------------------------------------------------------------------
2026-11-03 量出来：滤镜页 499 个名字只落在 67 个键上（7.4 : 1）。
用户点 6 张不同名字的卡，画面一模一样 —— 卡片名在撒谎。
Jason 的决定：**保留卡片数量，把效果补到与名字一样多**。

--------------------------------------------------------------------------------
怎么保证"真的不一样"
--------------------------------------------------------------------------------
① **族约束**：名字里有语义线索的（黑白/复古/冷/暖/鲜艳/柔和）只能在族范围内取值；
   无语义的名字整片空间都能用。
② **格子化**：每族参数取自离散格子（每轴 3~5 档），任意两点至少在某个轴上差一档。
③ **全局互斥**：接受新点前与**已接受的全部点**比 ΔE，低于阈值直接丢。
   先用 4 数摘要（均值 L/a/b + L 标准差）粗筛，避免 O(n²) 次逐像素比较。

⚠️ 渲染**复用** `gen-material-thumbs.py` 的 `apply_look_photo`，不复制一份：
   两份调色公式迟早漂移，症状是"卡片上是一个色调、画面上是另一个"。

用途：
  python tools/gen-look-params.py            # 只算不写盘，打印可行性与各轴步长
  python tools/gen-look-params.py --write    # 写入 looks.json + materials.js

--------------------------------------------------------------------------------
写盘时动什么、不动什么
--------------------------------------------------------------------------------
动的：
  · looks.json 的 filters 追加 454 条新键（一条一个参数组合）；
  · materials.js 的 FILTER_GROUPS 里每张卡的 css 换成自己的新键。
不动的：
  · **旧键一条不删**。老草稿里存的是 `warm-3` / `mono` 这类键，删掉就变成
    "打开旧工程，滤镜全丢"。新卡一律走新键，旧键只服务老草稿。
  · 旧键标 `featured: true` —— 检查器（Inspector）的快捷选择区只列 featured，
    否则那里会一次渲染 500 多个小按钮。
"""

import importlib.util
import io
import itertools
import json
import os
import random
import re
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根（本文件在 tools/ 下）
MAT = os.path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'materials.js')
LOOKS_FILE = os.path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'looks.json')

MIN_DE = 5.5     # 两个不同键的缩略图平均色差下限（Lab，48×27 口径）
COARSE = 11.0    # 粗筛门槛：摘要差小于它才做逐像素比较

# 分配结果缓存（`_probe/` 不入库）：全量求解要 10 分钟，复核与重跑不该再等一遍
ASSIGN_CACHE = os.path.join(ROOT, '_probe', 'look-assign.json')

# FILTER_GROUPS 里的单条卡片：{ zh: "名字", thumb: "xx.webp", css: "键" }
# 分组：1 前缀 / 2 引号 / 3 名字 / 4 ,thumb: / 5 引号 / 6 thumb / 7 ,css: / 8 引号 / 9 键 / 10 收尾
FILTER_ITEM_RE = re.compile(
    r'(\{\s*zh:\s*)(["\'])([^"\']*)\2(\s*,\s*thumb:\s*)(["\'])([^"\']*)\5(\s*,\s*css:\s*)(["\'])([^"\']*)\8(\s*\})'
)


def load_thumbs_module():
    """把 gen-material-thumbs.py 当模块加载，复用它的调色与底片。"""
    spec = importlib.util.spec_from_file_location('gmt', os.path.join(ROOT, 'tools', 'gen-material-thumbs.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


GMT = load_thumbs_module()

# 名字里的语义线索 → 族。顺序即优先级（"冷黑白"要判成黑白，不是冷）。
FAMILY_WORDS = [
    ('mono', ['黑白', '银盐', '灰阶', '素描', '硬黑', '柔灰', '冷黑白', '暖黑白', '单色']),
    ('retro', ['复古', '胶片', '旧相纸', '怀旧', '港风', '柯达', '暗房', '铜版', '棕褐', '褪色']),
    ('cool', ['冷', '蓝调', '青灰', '冰', '钢', '深海', '雾', '极夜', '薄荷', '月影', '阴天', '冷杉']),
    ('warm', ['暖', '日落', '焦糖', '奶咖', '琥珀', '蜜桃', '烛光', '肉桂', '晚霞', '暖阳', '黄昏']),
    ('vivid', ['鲜艳', '饱和', '霓虹', '荧光', '电光', '宝石', '糖果', '热浪', '盛夏', '汽水', '爆彩']),
    ('soft', ['柔和', '奶油', '晨雾', '棉白', '薄纱', '柔光', '粉雾', '素净', '淡雅', '微光', '奶白']),
]

# 每族的参数格子（轴名与 looks.json 的 params 键一致）。
#
# ⚠️ 格子设计的两条硬约束（2026-11-03 第二轮改）：
#   ① **每轴跳一档必须 ≥ MIN_DE**。满足它，整张格点集就天然两两互斥，容量 = 格点总数，
#      不用赌"能不能装下 356 个名字"。（第一版 any 族 hue 用到 ±40、sepia 到 0.9，
#      结果肤色成片发绿/发洋红 —— 名字叫「冰岛雪景」出来是霓虹青，那是"不一样"但不再是那个名字。）
#   ② **范围要像真的调色**：hue 只到 ±14（再大就开始换肤色相）、sepia 只到 0.42、
#      saturate 上限 1.4（vivid 族例外，它本来就该艳）。
#   两条一起意味着格子只能靠"档数"变多来扩容，不能靠"每档跨更大"。
GRIDS = {
    'cool': dict(sepia=[0.0], hue=[-30, -22, -14, -6], saturate=[0.72, 0.9, 1.08, 1.28],
                 brightness=[0.9, 1.0, 1.1], contrast=[0.9, 1.0, 1.12]),
    'warm': dict(sepia=[0.3, 0.45, 0.6, 0.75], hue=[0, -6, -12], saturate=[0.9, 1.05, 1.2],
                 brightness=[0.94, 1.02, 1.1], contrast=[0.92, 1.0, 1.1]),
    'retro': dict(sepia=[0.45, 0.65, 0.85, 1.0], saturate=[0.5, 0.72, 0.94], hue=[-14, -6, 2],
                  brightness=[0.9, 1.0, 1.1], contrast=[0.92, 1.05, 1.2]),
    'mono': dict(sepia=[0.0, 0.14, 0.28], hue=[0], saturate=[1.0],
                 brightness=[0.84, 0.96, 1.08, 1.2], contrast=[0.8, 0.95, 1.1, 1.24, 1.38]),
    'vivid': dict(sepia=[0.0], hue=[-8, 0, 8], saturate=[1.35, 1.55, 1.75],
                  brightness=[1.0, 1.06], contrast=[1.1, 1.2, 1.3]),
    'soft': dict(sepia=[0.0, 0.1, 0.2], hue=[0, -4], saturate=[0.78, 0.92, 1.06],
                 brightness=[1.08, 1.18, 1.28], contrast=[0.7, 0.8, 0.9]),
    'any': dict(sepia=[0.0, 0.11, 0.22, 0.33, 0.44], hue=[-14, -7, 0, 7, 14],
                saturate=[0.66, 0.82, 0.98, 1.14, 1.3, 1.44],
                brightness=[0.86, 0.93, 1.0, 1.07, 1.14],
                contrast=[0.82, 0.91, 1.0, 1.09, 1.18, 1.28]),
}
GRAY = {'mono': 1.0}
ORDER = ['mono', 'retro', 'cool', 'warm', 'vivid', 'soft', 'any']


def parse_cards():
    src = io.open(MAT, encoding='utf-8').read()
    m = re.search(r'export const FILTER_GROUPS = \[([\s\S]*?)\n\]', src)
    if not m:
        raise SystemExit('没解析到 FILTER_GROUPS')
    rows = []
    for gm in re.finditer(r'\{\s*name:\s*["\']([^"\']*)["\'],\s*items:\s*\[([\s\S]*?)\]\s*\}', m.group(1)):
        for im in re.finditer(
            r'\{\s*zh:\s*(["\'])([^"\']*)\1\s*,\s*thumb:\s*(["\'][^"\']*["\'])\s*,\s*css:\s*(["\'])([^"\']*)\5',
            gm.group(2)
        ):
            rows.append((gm.group(1), im.group(2), im.group(5)))
    if not rows:
        raise SystemExit('滤镜条目一条都没解析到，正则要更新')
    return rows


def family_of(name):
    for fam, words in FAMILY_WORDS:
        if any(w in name for w in words):
            return fam
    return 'any'


def summary(lab_px):
    n = float(len(lab_px))
    sl = sum(p[0] for p in lab_px) / n
    sa = sum(p[1] for p in lab_px) / n
    sb = sum(p[2] for p in lab_px) / n
    var = sum((p[0] - sl) ** 2 for p in lab_px) / n
    return (sl, sa, sb, var ** 0.5)


def dist(a, b):
    return sum(abs(p[0] - q[0]) + abs(p[1] - q[1]) + abs(p[2] - q[2]) for p, q in zip(a, b)) / len(a)


def px_of(probe, p):
    return list(GMT.apply_look_photo(probe, p).convert('LAB').getdata())


def calibrate(probe):
    """量每族每轴"跳一档"实际值多少 ΔE。不够 MIN_DE 的轴要加宽（打印出来人工调 GRIDS）。"""
    report = []
    for fam, grid in GRIDS.items():
        mid = {k: v[len(v) // 2] for k, v in grid.items()}
        for axis, values in grid.items():
            if len(values) < 2:
                continue
            steps = []
            for i in range(len(values) - 1):
                d = dist(px_of(probe, dict(mid, **{axis: values[i]})),
                         px_of(probe, dict(mid, **{axis: values[i + 1]})))
                steps.append(d)
            report.append((fam, axis, min(steps)))
    return report


def strength(p, fam):
    """"浓烈程度"：越接近原片越小。用来**先温和、后浓烈**地消费格子。

    ⚠️ 族的**特征轴不参与**排序（CHARACTERISTIC）：冷调族的特征就是色相偏冷，
       如果让色相也参与"越温和越先用"，35 张冷调卡会全落在最弱的那一档色相上
       —— 实测第一版 `|hue|` 最大只有 7°，「冰岛雪景」看着还是暖的。
       把特征轴排除后，同族的卡会在特征轴上自然摊开（各取不同档），
       而"温和"只体现在其余轴上。
    """
    skip = CHARACTERISTIC.get(fam)
    total = 0.0
    if skip != 'brightness':
        total += abs(p['brightness'] - 1) * 1.2
    if skip != 'contrast':
        total += abs(p['contrast'] - 1)
    if skip != 'saturate':
        total += abs(p['saturate'] - 1)
    if skip != 'sepia':
        total += p['sepia']
    if skip != 'hue':
        total += abs(p['hue']) / 14.0
    if skip != 'grayscale':
        total += p['grayscale']
    return total


# 每族的"特征轴"：这一轴决定这族像不像它自己，不能被"温和优先"吃掉
CHARACTERISTIC = {
    'cool': 'hue',      # 冷 = 色相偏冷
    'warm': 'sepia',    # 暖 = 棕调
    'retro': 'sepia',   # 复古 = 棕调/褪色
    'vivid': 'saturate',  # 鲜艳 = 饱和
    'soft': 'brightness',  # 柔和 = 提亮压对比
    'mono': None,
    'any': None,
}


def main():
    write = '--write' in sys.argv
    cards = parse_cards()
    fam_names = {}
    for _g, name, _k in cards:
        fam_names.setdefault(family_of(name), []).append(name)
    print('滤镜卡 %d 张，按族：%s' % (len(cards), {k: len(v) for k, v in sorted(fam_names.items())}), flush=True)

    probe = GMT.base('a', 32)
    print('\n各轴跳一档的实测 ΔE（低于 %.1f 的轴会挤，需要加宽）：' % MIN_DE, flush=True)
    report = calibrate(probe)
    for fam, axis, d in sorted(report, key=lambda r: r[2])[:14]:
        print('  %-6s %-11s %5.2f %s' % (fam, axis, d, '← 太窄' if d < MIN_DE else ''), flush=True)
    if '--calibrate' in sys.argv:
        # 格子的容量取决于"每轴一跳够不够远"：全够远 ⇒ 任何两个格点至少差一档 ⇒ 两两互斥。
        # 所以先单独跑这一步（约 1 分钟），比"跑十分钟再发现装不下"便宜得多。
        narrow = [(f, a, d) for f, a, d in report if d < MIN_DE]
        print('\n共 %d 条轴，其中 %d 条一跳不足 %.1f ΔE' % (len(report), len(narrow), MIN_DE), flush=True)
        return 0 if not narrow else 1

    accepted, sums, assigned = [], [], {}
    for fam in ORDER:
        names = fam_names.get(fam, [])
        if not names:
            continue
        grid = GRIDS[fam]
        keys = list(grid)
        combos = list(itertools.product(*[grid[k] for k in keys]))
        # 温和的格子先被消费：不排序的话随机撒点会让一半的卡变成"浓到看不出名字"的调子。
        pool = sorted(
            ({**{k: c[i] for i, k in enumerate(keys)}, 'grayscale': GRAY.get(fam, 0.0)} for c in combos),
            key=lambda p: strength(p, fam)
        )
        # 惰性算像素（带缓存）：格点可能上千个，全预计算要多花十几倍时间，
        # 而真正被接受的只有"名字数"这么多个。
        cache = {}

        def px_summary(p):
            sig = json.dumps(p, sort_keys=True)
            if sig not in cache:
                px = px_of(probe, p)
                cache[sig] = (px, summary(px))
            return cache[sig]

        fail = 0
        # 被淘汰的候选**永久出局**：accepted 只增不减，所以"离某个已接受点太近"这个判断
        # 对同一候选永远成立，不必再测第二次。
        # 不加这一条会退化成 O(名字数 × 候选数 × 已接受数) —— 2026-11-03 实测跑了 22 分钟
        # 还没跑完一个 any 族（每个名字都从最温和那一端重新扫一遍）。
        dead = set()
        for k, name in enumerate(names):
            picked = None
            for idx, p in enumerate(pool):
                if idx in dead:
                    continue
                px, s = px_summary(p)
                ok = True
                for ps, ppx in zip(sums, accepted):
                    # 下界剔除：均值差 ≥ MIN_DE ⇒ 逐像素差必然 ≥ MIN_DE
                    # （每个通道的 |均值差| ≤ 该通道的 mean|差| ≤ 总和）。
                    if max(abs(s[0] - ps[0]), abs(s[1] - ps[1]), abs(s[2] - ps[2])) >= MIN_DE:
                        continue
                    if dist(px, ppx) < MIN_DE:
                        ok = False
                        break
                if not ok:
                    dead.add(idx)
                    continue
                picked = (p, px, s)
                break
            if not picked:
                fail += 1
                continue
            accepted.append(picked[1])
            sums.append(picked[2])
            if len(names) > 100 and (k + 1) % 50 == 0:
                print('    …%d/%d（已淘汰候选 %d）' % (k + 1, len(names), len(dead)), flush=True)
            assigned[name] = picked[0]
        print('  [%s] %d 个名字，候选点 %d，成功 %d，失败 %d'
              % (fam, len(names), len(pool), len([n for n in names if n in assigned]), fail), flush=True)

    print('\n分配成功 %d / %d 张卡' % (len(assigned), len(cards)), flush=True)
    names = {name for _g, name, _k in cards}
    uniq = len({json.dumps(v, sort_keys=True) for v in assigned.values()})
    print('去重名字 %d 个（%d 张卡里有 %d 张是同名重复）· 互不相同的参数组合：%d'
          % (len(names), len(cards), len(cards) - len(names), uniq), flush=True)
    # ⚠️ 判据是**去重名字数**，不是卡片数：同名卡片本来就该共用同一个效果
    #    （"同名同效果、不同名不同效果"）。拿卡片数比，会永远差 45 条而拒绝写盘 ——
    #    这正是 2026-11-03 第一次 --write 被自己拦下来的原因。
    if len(assigned) < len(names) or uniq != len(names):
        missing = sorted(names - set(assigned))
        print('⇒ 还差 %d 个名字没落位（%s），先加宽 GRIDS 再谈写盘。'
              % (len(missing), ' / '.join(missing[:6])), flush=True)
        return 1
    # 存一份分配结果：这一次算了 10 分钟，重跑/复核不必再等
    io.open(ASSIGN_CACHE, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(assigned, ensure_ascii=False, indent=1, sort_keys=True) + '\n')
    if not write:
        print('\n（未写盘。确认上面数字后可加 --write；分配已缓存到 %s）'
              % os.path.relpath(ASSIGN_CACHE, ROOT), flush=True)
        return 0

    # ---- 键名 ----
    # 族前缀 + 续号（旧键 warm-1..10 已占位，新键从 11 起），无语义族用 mix-。
    # 为什么不用 hash 或纯序号：键名会出现在 MCP 工具参数、导出日志、老草稿里，
    # `mix-137` 至少能看出"无语义族第 137 条"，`lk-9f3a` 什么都看不出。
    look = json.loads(io.open(LOOKS_FILE, encoding='utf-8').read())
    # 上一次生成出来的键（没有 featured 的那些）先全部剔掉再重排 ——
    # 否则第二次跑会留下一批"上一版的 mix-3xx"没人引用（它们还是真实键，但没卡指向，
    # 缩略图也跟着变孤儿）。旧键一律 featured，永远不会被这段碰到。
    kept = [item for item in look['filters'] if item.get('featured')]
    used = {item['key'] for item in kept}
    serial = {}
    for fam in ORDER:
        serial[fam] = 1
        prefix = 'mix' if fam == 'any' else fam
        n = 1
        while '%s-%d' % (prefix, n) in used:
            n += 1
        serial[fam] = n

    name_key = {}
    for fam in ORDER:
        for name in fam_names.get(fam, []):
            if name not in assigned:
                continue
            prefix = 'mix' if fam == 'any' else fam
            while True:
                key = '%s-%d' % (prefix, serial[fam])
                serial[fam] += 1
                if key not in used:
                    break
            used.add(key)
            name_key[name] = key

    # ---- 写 looks.json ----
    for item in look['filters']:
        item.setdefault('featured', True)   # 旧键 = 检查器里的快捷选择，只服务老草稿
    added = []
    for name, key in name_key.items():
        p = assigned[name]
        added.append({
            'key': key,
            'label': name,
            'hint': '「%s」的专属参数（与其余滤镜两两可分）' % name,
            'params': {
                'brightness': p['brightness'],
                'contrast': p['contrast'],
                'saturate': p['saturate'],
                'grayscale': p['grayscale'],
                'sepia': p['sepia'],
                'hue': p['hue'],
            },
        })
    # 旧的生成键已在上面剔掉，这里直接拼（重复执行必须幂等：跑两次不能多出影子键）
    look['filters'] = kept + added
    io.open(LOOKS_FILE, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(look, ensure_ascii=False, indent=2) + '\n')
    print('looks.json：%d → %d 条滤镜键（新增 %d）' % (len(kept), len(look['filters']), len(added)), flush=True)

    # ---- 写 materials.js（只动 FILTER_GROUPS 里的 css 字段）----
    src = io.open(MAT, encoding='utf-8').read()
    m = re.search(r'(export const FILTER_GROUPS = \[)([\s\S]*?)(\n\])', src)
    if not m:
        print('没定位到 FILTER_GROUPS，未改动 materials.js', flush=True)
        return 1

    changed = {'n': 0}

    def fix(mm):
        name = mm.group(3)
        key = name_key.get(name)
        if not key:
            return mm.group(0)
        if mm.group(9) != key:
            changed['n'] += 1
        return (mm.group(1) + mm.group(2) + name + mm.group(2) + mm.group(4)
                + mm.group(5) + mm.group(6) + mm.group(5) + mm.group(7)
                + mm.group(8) + key + mm.group(8) + mm.group(10))

    body = FILTER_ITEM_RE.sub(fix, m.group(2))
    out = src[:m.start(2)] + body + src[m.end(2):]
    io.open(MAT, 'w', encoding='utf-8', newline='').write(out)
    print('materials.js：改写 %d 张卡的 css 键' % changed['n'], flush=True)
    print('\n下一步：python tools/gen-material-thumbs.py（重算缩略图，thumb 名由 css 键派生）', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
