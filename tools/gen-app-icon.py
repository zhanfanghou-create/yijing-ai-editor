#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从 `ico/source-1024.png` 生成全部客户端图标产物。

为什么要有这个脚本：图标散落在 7 个位置（仓库根 ico/ 的 9 个尺寸、desktop 打包用
build/icon.ico、installer 打包与窗口用 2 个 icon.ico、安装器界面的 app256/logo48），
手改必然漏，而漏掉的表现是"exe 图标变了、任务栏没变"或"界面还是旧 logo"——
都不报错。这里一条命令全部重出，尺寸与编码统一。

产物：
  ico/{16,32,48,64,96,128,256,512,1024}X.ico   单帧（ico/ 是权威源，命名即尺寸）
  packages/desktop/build/icon.ico              多帧 16→256（exe / 任务栏 / 窗口）
  packages/installer/build/icon.ico            多帧
  packages/installer/resources/icon.ico        多帧（安装器窗口图标）
  packages/installer/src/assets/app256.png     安装器界面大图标
  packages/installer/src/assets/logo48.png     安装器界面标题栏 logo

⚠️ 界面里的 logo（renderer/assets/logo-256.png）**不在这里出** —— 它由
   tools/extract-ico-frame.mjs 从 ico/256X256.ico 解出，并被 check-logo-sync 闸门
   逐字节盯着。生完本脚本后必须再跑一次那个脚本。

用法：
  python tools/gen-app-icon.py            # 默认 ico/source-1024.png
  python tools/gen-app-icon.py <src.png>
"""
import os
import struct
import sys
import zlib

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'ico', 'source-1024.png')

# ico/ 里的单帧文件名 → 尺寸
SINGLE = [16, 32, 48, 64, 96, 128, 256, 512, 1024]
# Windows 会用到的帧：小尺寸给任务栏/标题栏，大尺寸给资源管理器/属性页
MULTI = [16, 24, 32, 48, 64, 128, 256]


def load_master(path):
    im = Image.open(path)
    if im.mode != 'RGBA':
        im = im.convert('RGBA')
    if im.size != (1024, 1024):
        # 不做拉伸：源图不是 1024 就明确报错，免得悄悄生成一堆模糊图
        raise SystemExit(f'源图必须是 1024x1024，实际 {im.size[0]}x{im.size[1]}')
    return im


def resize(im, size):
    """LANCZOS 缩小；32~48 补一点锐度。

    实测（放大 6~10 倍对比过）：16/24 加锐反而更糊 —— 笔画本身已不足 1px，
    UnsharpMask 只是在把边缘的灰阶压成硬块；32/48 加锐明显更清楚。
    更大尺寸插值已经足够，过度锐化会在 "Y" 的斜边上留白边
    （浅色笔画压深色底，过冲非常显眼）。
    """
    out = im.resize((size, size), Image.LANCZOS)
    if 32 <= size <= 48:
        try:
            from PIL import ImageFilter

            out = out.filter(ImageFilter.UnsharpMask(radius=0.6, percent=45, threshold=2))
        except Exception:
            pass
    return out


def png_bytes(im):
    buf = __import__('io').BytesIO()
    im.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def write_single_ico(path, im, size):
    """单帧 .ico。

    size <= 256 时直接交给 Pillow（它会为 256 写 PNG 压缩帧、小尺寸写 DIB）；
    512/1024 超出 ICO 目录项的表示范围（宽高各 1 字节，0 表示 256），
    但历史上 ico/ 里就有这两个尺寸的文件，为了不改变既有约定，
    这里按"PNG 载荷 + 目录项写 0"的方式落盘 —— 与之前那两份的行为一致。
    """
    if size <= 256:
        im.save(path, format='ICO', sizes=[(size, size)])
        return os.path.getsize(path)

    data = png_bytes(im)
    header = struct.pack('<HHH', 0, 1, 1)
    # bWidth/bHeight 只有 1 字节；>256 只能写 0（解析方按 PNG 实际尺寸读）
    w = 0 if size >= 256 else size
    entry = struct.pack('<BBBBHHII', w, w, 0, 0, 1, 32, len(data), 6 + 16)
    with open(path, 'wb') as f:
        f.write(header + entry + data)
    return os.path.getsize(path)


def write_multi_ico(path, im, sizes):
    """多帧 .ico：Windows 按 DPI 自己挑，任务栏 16/24/32 不会再拿 256 硬缩。"""
    frames = [resize(im, s) for s in sizes]
    # base 用最大帧，sizes 决定写入哪些；Pillow 的 ICO 插件对 256 用 PNG 压缩
    frames[-1].save(path, format='ICO', sizes=[(s, s) for s in sizes])
    return os.path.getsize(path)


def main():
    if not os.path.exists(SRC):
        raise SystemExit(f'源图不存在：{SRC}')
    im = load_master(SRC)
    # 自证：四个角必须有透明像素（圆角），否则说明源图被扁平化过，
    # 打出来的 exe 图标会带白色方块角
    for xy in [(0, 0), (1023, 0), (0, 1023), (1023, 1023)]:
        if im.getpixel(xy)[3] != 0:
            raise SystemExit(f'源图角落 {xy} 不透明（应为透明圆角），请检查源图')

    ico_dir = os.path.join(ROOT, 'ico')
    for s in SINGLE:
        p = os.path.join(ico_dir, f'{s}X{s}.ico')
        n = write_single_ico(p, resize(im, s), s)
        print(f'  {os.path.relpath(p, ROOT):48s} {s:>4}x{s:<4} {n:>8}B')

    outs = [
        ('packages/desktop/build/icon.ico', 'multi'),
        ('packages/installer/build/icon.ico', 'multi'),
        ('packages/installer/resources/icon.ico', 'multi'),
    ]
    for rel, _ in outs:
        p = os.path.join(ROOT, *rel.split('/'))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        n = write_multi_ico(p, im, MULTI)
        print(f'  {rel:48s} 多帧 {MULTI[0]}→{MULTI[-1]}   {n:>8}B')

    p = os.path.join(ROOT, 'packages', 'installer', 'src', 'assets', 'app256.png')
    resize(im, 256).save(p, format='PNG', optimize=True)
    print(f'  {"packages/installer/src/assets/app256.png":48s} 256x256   {os.path.getsize(p):>8}B')

    p = os.path.join(ROOT, 'packages', 'installer', 'src', 'assets', 'logo48.png')
    resize(im, 48).save(p, format='PNG', optimize=True)
    print(f'  {"packages/installer/src/assets/logo48.png":48s}   48x48   {os.path.getsize(p):>8}B')

    print('\nAPP_ICON_OK')
    print('下一步必跑：node tools/extract-ico-frame.mjs   # 界面 logo 与 ico/ 对齐，check-logo-sync 会盯这个')


if __name__ == '__main__':
    main()
