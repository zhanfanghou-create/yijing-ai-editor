# 艺镜剪辑 · YiJing AI Editor

> 一个**完全在本机运行**的开源视频剪辑客户端。Electron + React + 本机 ffmpeg。
> 没有账号、没有联网服务、没有付费功能 —— 导入素材、剪辑、调色、加字幕与特效、导出成片，
> 全在你自己的机器上完成。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-1f6feb.svg)](#下载与安装)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520.11-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-6E56CF.svg)](#智能剪辑内置-mcp-服务)

![工作台](docs/screenshots/02-editor-visual.png)

---

## 目录

- [这是什么](#这是什么)
- [功能特性](#功能特性)
- [截图](#截图)
- [下载与安装](#下载与安装)
- [从源码构建](#从源码构建)
- [使用说明](#使用说明)
- [快捷键](#快捷键)
- [智能剪辑：内置 MCP 服务](#智能剪辑内置-mcp-服务)
- [关于 ffmpeg](#关于-ffmpeg)
- [目录结构](#目录结构)
- [验证与闸门](#验证与闸门)
- [素材与版权](#素材与版权)
- [第三方组件](#第三方组件)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 这是什么

**艺镜剪辑**是一款纯本地的桌面视频剪辑工具。它把「导入 → 剪辑 → 调色 → 加字幕 → 加特效 → 导出」
这条完整的创作链路都放在一台电脑上完成，不依赖任何后端服务：

- **不联网**：软件没有任何联网请求，也没有遥测、埋点或账号体系。
- **不上传**：素材始终留在你自己的磁盘上，成片也直接写到你指定的目录。
- **不收费**：没有任何收费入口，也没有解锁墙。

它同时内置了一个 **MCP（Model Context Protocol）服务端**，可以被支持 MCP 的 AI 智能体
直接驱动 —— 智能体给出剪辑方案，软件自动落地成草稿并导出成片（见
[智能剪辑：内置 MCP 服务](#智能剪辑内置-mcp-服务)）。

### 它能做什么

| 能力 | 说明 |
| --- | --- |
| 素材管理 | 导入本机视频 / 音频 / 图片，素材库按类型筛选；支持拖拽入轨 |
| 多轨剪辑 | 视频轨、叠加轨（画中画）、音频轨、文字轨；拖动 / 两端修剪 / 播放头分割 / 吸附 |
| 轨道状态 | 每条轨道可**隐藏 / 静音 / 锁定 / 独奏**，预览与导出走同一套判定 |
| 片段操作 | 停用（可逆、不进成片）、替换素材（换源不换起点）、右键菜单 |
| 转场 | 叠化、模糊、故障、运镜、扭曲、3D、光效… 分组素材，预览与导出一致 |
| 滤镜 | 电影风格、复古、黑白、风景… 直接作用在预览与成片上 |
| 画面特效 | 闪光、故障、扫描线、漏光、暗角等帧特效，叠加在画面上 |
| 调节 / 美颜 | 亮度、对比度、饱和度、色温、色调、锐化、美颜档位；预览与导出同一条公式 |
| 位置 / 缩放 / 旋转 | 逐片段的位移、缩放、旋转，画中画同样支持 |
| 文字与字幕 | 文字、字幕轨、花字模板；样式可覆写（字号 / 颜色 / 描边 / 底色 / 位置） |
| 音频 | 从视频提取音轨（本机 ffmpeg）、背景音乐、音量与淡入淡出 |
| 真波形 | 音频轨与视频片段底部按真实 PCM 绘制波形，不是装饰 |
| 倍速 | 0.25×–4×，预览与成片速度一致（导出按倍速拆分 atempo 级） |
| 画面比例 | 1:1 / 1:2 / 3:4 / 9:16 / 16:9 / 4:3 / 2:1 共 7 档，裁切铺满、不留黑边 |
| 导出 | 调用本机 ffmpeg 合成成片：滤镜 / 转场 / 帧特效 / 字幕 / 画中画 / 音量 / 倍速全部进成片 |
| 草稿 | 自动落盘，重启后自动恢复；可自定义分辨率、比例与保存位置 |
| 界面 | 四区工作台可拖拽伸缩、双击复位、方向键微调；22 个可自定义快捷键 |

### 它不做什么

- 不联网、不设账号、不采集任何数据；
- 没有模型推理、没有在线素材 / 模板下载（这一类依赖外部服务，本版不含）；
- 没有任何计费体系。

---

## 功能特性

### 剪辑与时间线

- **四类轨道**：视频 / 叠加（画中画）/ 音频 / 文字，可自由增删与排序。
- **精确到帧**：时间码是 `HH:MM:SS:FF`（30fps）的帧号格式，播放条同时显示当前与总长。
- **吸附与缩放**：默认开启吸附；`Ctrl + 滚轮` 缩放时间线，也有快捷键与滑块。
- **分割与删除**：按钮、`Ctrl+B`、右键菜单三处走**同一条**分割路径，行为一致。

### 轨道状态（真源统一）

隐藏 / 静音 / 锁定 / 独奏四个状态由同一个真源决定，预览与导出**共用同一个出口**
（`effectiveClips`）。所以不会出现「界面显示已静音、导出却还有声音」这类不一致。

- **锁定**：禁止拖动 / 修剪 / 分割 / 删除 / 替换，但**不禁止播放**；
- **独奏**：其余能出声的轨道被静音（字幕轨不挂喇叭，因此不参与独奏）。

### 预览即所得

预览合成器对热点窗口预挂载解码器，跨片段接缝不换 `src`，因此播放不会闪。
调色、美颜、位置旋转、字幕样式都是**同一份纯函数**同时驱动预览与导出 ——
不存在「预览好看、成片不对」的分叉。

### 导出

导出由本机 `ffmpeg` 完成，滤镜串、转场、帧特效、字幕、画中画、音量、倍速全部进成片；
画面比例决定输出尺寸与裁切方式。导出与界面预览走**同一条渲染管线**。

---

## 截图

<table>
  <tr>
    <td align="center"><b>创作中心 / 首页</b><br/><img src="docs/screenshots/01-home.png" width="560"/></td>
    <td align="center"><b>工作台 · 画面检查器</b><br/><img src="docs/screenshots/02-editor-visual.png" width="560"/></td>
  </tr>
  <tr>
    <td align="center"><b>字幕样式与检查器</b><br/><img src="docs/screenshots/03-editor-subtitle.png" width="560"/></td>
    <td align="center"><b>调节 / 美颜</b><br/><img src="docs/screenshots/04-editor-adjust.png" width="560"/></td>
  </tr>
  <tr>
    <td align="center"><b>画面比例（7 档）</b><br/><img src="docs/screenshots/05-editor-aspect.png" width="560"/></td>
    <td align="center"><b>画面特效库</b><br/><img src="docs/screenshots/06-editor-effects.png" width="560"/></td>
  </tr>
</table>

> 截图取自本仓库构建出的真实客户端（Windows）。

---

## 下载与安装

### 方式一：下载安装包（推荐）

到 [**Releases**](https://github.com/zhanfanghou-create/yijing-ai-editor/releases) 下载最新的
Windows 安装包并运行：

```
YiJingAIEditor-Setup-Windows-x64.exe
```

- 免安装（portable）：双击即用，不写注册表、不留残留；
- 首次运行会在 `%APPDATA%\<产品名>` 下建立数据目录（草稿、设置）；
- 支持 Windows 10 / 11（x64）。

### 方式二：从源码构建

见下一节。

---

## 从源码构建

### 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | ≥ 20.11 |
| npm | 随 Node 附带 |
| ffmpeg | 可选（导出成片时需要，见 [关于 ffmpeg](#关于-ffmpeg)） |

### 安装依赖

```bash
npm install
```

### 开发模式（热更新）

```bash
npm run dev
```

### 构建并打包

```bash
npm run desktop:build     # 只构建渲染层
npm run desktop:dist      # 出免安装目录（packages/desktop/dist-win/win-unpacked）
npm run installer:build   # 一键：构建渲染层 + 打包客户端 + 生成安装包 exe
```

`installer:build` 完成后的交付物：

```
packages/installer/dist-installer/YiJingAIEditor-Setup-Windows-x64.exe
```

> **提示**：`electron-builder` 在打包第一步会清空输出目录。如果你的编辑器 / IDE 正在扫描
> 上一次构建出的 `app.asar`，会占住句柄导致清空失败。构建脚本已内置探测：检测到占用时会
> 自动把中间产物落到系统临时目录，并在结束时告诉你位置 —— 最终交付物仍落回仓库。

---

## 使用说明

1. **新建 / 打开草稿**：首页点「视频剪辑器」进入工作台，草稿会自动保存。
2. **导入素材**：点中栏「导入」，或把文件从资源管理器**拖进**窗口（视频 / 音频 / 图片）。
3. **剪辑**：把素材拖到时间线；拖动移动、拖两端修剪、`Ctrl+B` 在播放头处分割。
4. **调色 / 特效**：选中片段后，在右栏**检查器**切换「画面 / 音频 / 变速 / 调整」页签。
5. **字幕**：文字轨上添加字幕后，可在检查器改样式（字号 / 颜色 / 描边 / 底色 / 位置）。
6. **画面比例**：预览控制条右端的比例 chip，7 档任选，裁切铺满。
7. **导出**：`Ctrl+E` 或点右上「导出」，选择保存位置，调用本机 ffmpeg 出片。

---

## 快捷键

共 **22 个可自定义动作**，分为「编辑 / 播放 / 跳转 / 视图 / 项目」五组：

| 分组 | 动作 | 默认键位 |
| --- | --- | --- |
| 编辑 | 撤销 | `Ctrl+Z` |
| 编辑 | 重做 | `Ctrl+Shift+Z` / `Ctrl+Y` |
| 编辑 | 在播放头处分割 | `Ctrl+B` |
| 编辑 | 删除选中的片段 | `Delete` |
| 编辑 | 停用 / 启用选中的片段 | `V` |
| 编辑 | 清空时间线 | `Ctrl+Shift+Delete` |
| 编辑 | 吸附开关 | `N` |
| 播放 | 播放 / 暂停 | `Space` |
| 播放 | 回到开头 | `Home` |
| 播放 | 跳到结尾 | `End` |
| 跳转 | 前一帧 / 后一帧 | `←` / `→` |
| 跳转 | 后退 / 前进 1 秒 | `Shift+←` / `Shift+→` |
| 视图 | 时间线放大 / 缩小 / 重置 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| 视图 | 全屏预览 | `F11` |
| 项目 | 保存草稿 | `Ctrl+S` |
| 项目 | 打开设置 | `Ctrl+,` |
| 项目 | 导入素材 | `Ctrl+I` |
| 项目 | 导出视频 | `Ctrl+E` |

固定键位：`Esc` 关闭弹窗 / 退出全屏。

---

## 智能剪辑：内置 MCP 服务

本软件内置了一个 **MCP（Model Context Protocol）stdio 服务端**，任何支持 MCP 的 AI 智能体
都可以把它当作工具来调用，从而**自动完成剪辑**：建草稿 → 加片段 → 加字幕与特效 → 导出成片。

### 提供的工具

| 工具 | 作用 |
| --- | --- |
| `yijing_list_drafts` | 列出本机草稿 |
| `yijing_read_draft` | 读取某个草稿的完整内容 |
| `yijing_create_draft` | 新建草稿 |
| `yijing_probe_media` | 探测素材真实时长 / 尺寸 / 类型 |
| `yijing_add_clips` | 向草稿添加片段（视频 / 音频 / 图片 / 文字） |
| `yijing_add_subtitles` | 批量添加字幕 |
| `yijing_update_clip` | 修改片段属性（起止 / 调色 / 特效 / 倍速…） |
| `yijing_delete_clip` | 删除片段 |
| `yijing_export_video` | 调用本机 ffmpeg 导出成片 |

### 自动对接

- 软件首次运行会检测本机是否安装了兼容的 MCP 宿主（智能体客户端）；若已安装，会**自动**
  把自己注册进该宿主的 MCP 配置，**无需任何额外安装步骤**。
- 服务端与界面共用同一份草稿格式、素材描述与导出管线 —— 智能体产出的草稿在界面里可以直接
  打开继续编辑，界面里做好的草稿也能被智能体读取。
- `stdout` 只用于 JSON-RPC 报文，所有日志走 `stderr`。

> 隔离运行（例如测试时传 `--user-data-dir`）**不会**写入宿主的全局配置，避免污染开发机。

---

## 关于 ffmpeg

**默认不随包分发。** ffmpeg 是 LGPL/GPL 许可的，而本项目是 MIT ——
把 GPL/LGPL 的二进制默认打进 MIT 的发行物，会让整份发行物的许可证说不清。
所以仓库不带、默认构建也不下载它。

需要「装完就能导出」时，由**打包者**显式决定：

```bash
npm run ffmpeg:fetch     # 下载 ffmpeg.exe / ffprobe.exe 到 packages/desktop/resources/ffmpeg/
npm run installer:build  # 该目录里有 ffmpeg.exe 就随包带走，没有就跳过（不报错）
```

客户端按以下顺序查找 ffmpeg：

1. 环境变量 `YIJAI_FFMPEG` / `FFMPEG_PATH`；
2. 安装目录下的 `resources\ffmpeg\`（**可选随包**）；
3. 系统 `PATH` 上的 `ffmpeg`；
4. 常见安装位置（`C:\ffmpeg\bin` 等）。

找不到时，导出面板会给出可照做的安装提示，不会静默失败。

---

## 目录结构

```
packages/desktop          客户端（Electron 主进程 + React 渲染层）
  src/main                主进程：窗口、协议、ffmpeg 导出、草稿落盘、MCP 服务端
  src/preload             渲染层唯一能用的 IPC 白名单
  src/renderer            界面：首页 / 工作台 / 时间线 / 预览 / 检查器
  src/shared              主进程与渲染层共用的纯函数（比例 / 倍速 / 调色 / 字幕样式…）
packages/installer        Windows 安装包（portable 生成器）
scripts/verify.mjs        一键验证入口
tools/                    闸门脚本、素材生成器、取景与度量工具
docs/screenshots          界面截图
```

设计上，凡是**同时**影响预览与导出的东西（画面比例、倍速、调色、字幕样式、画中画），
真源都只有一份、放在 `src/shared/`，两边都从这里取 —— 避免「预览与成片不一致」这类
静态扫描发现不了的缺陷。

---

## 验证与闸门

```bash
npm run verify                       # 全套闸门
node scripts/verify.mjs --list       # 查看全部闸门
node scripts/verify.mjs --only icons # 只跑某一道
```

闸门分两类：

- **静态检查**：导入完整性、图标同步、界面文案、左栏功能树、开源洁净（不许出现第三方品牌名、
  生产域名、密钥字段、账号 / 支付残留）等；
- **真机 E2E**：真实启动 Electron 并真实点击（标签、按钮、导入、导出、快捷键、预览效果…）。

每一道都会挂进 `npm run verify`，并且每道都带 `--selftest`：用合成夹具证明「该红的确实会红」，
避免闸门退化成永远绿的摆设。

---

## 素材与版权

仓库内**所有图形资产均为本项目自建、可程序化复现**：

- 应用图标：`tools/build-own-icons.mjs`（自绘 SVG 导出）；
- 配图：`tools/gen-own-art.py`（PIL，固定随机种子，可逐字节复现）；
- 素材缩略图：`tools/gen-material-thumbs.py`（按效果键程序化生成）。

仓库中不含任何第三方图标、图片或音视频素材。

---

## 第三方组件

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 桌面运行时 | MIT |
| [React](https://react.dev/) | 界面库 | MIT |
| [Vite](https://vitejs.dev/) | 构建工具 | MIT |
| [Node.js](https://nodejs.org/) | 构建 / 运行环境 | MIT |
| [7-Zip](https://www.7-zip.org/) | 便携安装器解压随包负载 | LGPL |
| [FFmpeg](https://ffmpeg.org/)（可选） | 成片导出 | LGPL / GPL |

各组件遵循其自身的开源许可证。FFmpeg 默认不随包分发，是否随包由打包者决定。
7-Zip 的 `7za` 命令行工具（21.07 x64）随仓库提交，供便携安装器在安装阶段解压随包负载。

---

## 常见问题

**Q：导出时提示找不到 ffmpeg？**
安装 ffmpeg 并加入系统 `PATH`，或设置环境变量 `YJAI_FFMPEG` 指向 `ffmpeg.exe`；
若你在自行打包，可先 `npm run ffmpeg:fetch` 再构建，让它随包带上。

**Q：软件会联网吗？**
不会。整个应用没有任何对外网络请求，也没有账号、遥测与更新检查。

**Q：草稿存在哪里？**
用户数据目录下（Windows 为 `%APPDATA%\<产品名>\drafts`）。可在草稿参数面板中修改保存位置。

**Q：为什么预览里的波形 / 缩略图偶尔不显示？**
波形由本机 ffmpeg 抽取真实 PCM 绘制，若素材编码特殊或 ffmpeg 不可用，该片段的波形会缺失，
但不影响其它功能。

---

## 许可证

本项目基于 [MIT 许可证](./LICENSE) 开源。

Copyright © 2026 艺镜 AI 团队
