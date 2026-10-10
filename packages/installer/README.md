# 艺镜AI剪辑 · 安装引导程序

一个独立于主程序的**自定义安装向导**（Electron + React），负责把打包好的客户端释放到用户机器上，
并完成快捷方式、卸载登记等系统集成。产品名统一为 **艺镜AI剪辑 / YiJing AI Editor**。

---

## 1. 目录结构

```
packages/installer/
├── electron/                 主进程（CommonJS）
│   ├── product.js            产品常量单一来源（显示名 / exe 名 / 注册表键 / 发行方）
│   ├── payload.js            定位 app.7z 与 7za.exe，提供安装前自检
│   ├── win-integration.js    快捷方式 / 注册表 / 开机自启 / 卸载器
│   ├── install.js            安装主流程（6 阶段，带百分比与日志回调）
│   ├── main.js               Electron 主进程 + IPC
│   └── preload.js            contextBridge 白名单（sandbox: true）
├── src/                      渲染层（React，无 Tailwind / 无图标库，纯 CSS + 内联 SVG）
│   ├── App.jsx               单页式界面：收起/展开、协议浮层、安装中/完成/失败状态复用
│   ├── brand.js              品牌常量（与 electron/product.js 同源）
│   ├── styles.css            品牌深色主题（与客户端/运营后台同一套设计令牌）
│   ├── icons.jsx             内联 SVG 图标
│   ├── components/Shell.jsx  标题栏 / 复选框 / 下拉框 等通用组件
│   └── assets/               logo48.png · app256.png
│
│   ⚠️ **没有 `steps.js`，也没有 `pages/` 目录** —— 界面是单页式的，不是 6 步向导。
│      2026-10-02 PM 审查（P1-6）发现本文件曾按「6 步向导」描述 src/pages/* 六页，
│      而那些文件从来不存在。文档错、实现没错：**实现就是单页式**（Jason 确认）。
├── payload/
│   ├── app.7z                主程序数据包（由 pack-payload.mjs 生成，不入库）
│   └── bin/7za.exe           解压器（随包提交，602 KB）
├── resources/
│   ├── license.txt           最终用户许可协议（中文，向导内嵌展示）
│   ├── icon.ico              安装器窗口图标
│   └── 7za.exe               打包期用的解压器副本
├── build/icon.ico            electron-builder 使用的应用图标
├── scripts/
│   ├── pack-payload.mjs      客户端产物 → payload/app.7z
│   └── build-installer.mjs   一键跑完整条出包流水线
└── electron-builder.yml      portable 单文件 exe 打包配置
```

---

## 2. 界面形态：单页式（不是 6 步向导）

窗口**只有一页**，靠两个维度的状态切换内容，没有「上一步 / 下一步」的翻页流程：

**维度一 · 窗口高度（收起 / 展开）**

| 形态 | 尺寸 | 触发 | 内容 |
|------|------|------|------|
| 收起态 | 650×360 | 默认 | 品牌区 + 版本 + 安装路径一行 + 「同意用户许可协议」勾选 + 主按钮「立即安装」 |
| 展开态 | 650×560 | 点「安装设置」 | 收起态的全部内容 + 底部展开**设置区**（语言选择 + 安装路径输入 + 浏览…） |

展开/收起通过 IPC 改窗口高度（`H_COLLAPSED=360` / `H_EXPANDED=560`，与 `styles.css`
的 `--win-h` / `--win-h-expanded` 必须一致 —— 改一边不改另一边会露白边）。

**维度二 · 安装阶段（同一版式复用三种结果）**

`App.jsx` 的 `phase` 只有四个值：`idle`（可配置）→ `installing`（进度）→
`done` / `error`。**done 与 error 复用同一块版式**：只是把中间的进度条换成
绿色对勾或红色原因，底栏按钮从「取消」变成「立即运行 / 打开目录 / 重试」。

**协议浮层**：点协议链接弹出 560×330 的浮层（滚动正文 + 关闭 / 同意按钮），
**不是独立的一步** —— 关掉浮层仍回到同一页。

**门控**（不靠翻页，靠禁用主按钮）：

| 条件 | 行为 |
|------|------|
| 未勾选「同意用户许可协议」 | 点「立即安装」时置 `agreeHint`，协议行高亮提示，不开始安装 |
| 安装路径为空 | 主按钮禁用 |
| 目标磁盘可用空间不足 2 GB | 告警并拦截 |

---

## 3. 安装阶段与进度映射

> ⚠️ 这里的「6 个阶段」是**主进程 `electron/install.js` 的安装阶段**（进度条与日志用），
> **不是界面的 6 个步骤** —— 界面是单页的（见第 2 节）。
> 这两件事曾被本文件混写成一件事，于是出现了「src/pages/* 六页」这种从来不存在的描述。

`install.js` 把安装拆成可观察的 6 个阶段，渲染层据此推进进度条与阶段文案：

| 阶段 | 进度区间 | 动作 |
|------|----------|------|
| `verify` | 0 → 6 | 校验 `app.7z` 与 `7za.exe` 是否存在、体积是否合理、`7za.exe` 是否为 MZ 可执行文件 |
| `prepare` | 6 → 10 | 磁盘空间校验 → 创建目录 → **目录可写性预检** → 结束正在运行的旧版主程序 |
| `extract` | 10 → 85 | `7za x app.7z -o<目标> -y -bsp1`，解析 stdout 百分比线性映射到 10~85 |
| `shortcut` | 85 → 93 | 创建桌面 / 开始菜单快捷方式 |
| `register` | 93 → 98 | 生成 `Uninstall.exe`、写卸载登记、写开机自启 |
| `done` | → 100 | 收尾 |

失败时抛出可读原因（空间不足 / 目录不可写 / 解压器缺失 / 解压退出码 + stderr 末 3 行），
渲染层原样展示并允许回退重试。

---

## 4. 系统集成的实现取舍

**刻意不使用 PowerShell。** 原因是 PowerShell `-Command` 拼接中文路径时会受控制台代码页影响而乱码，
这类问题在中文用户名机器上难以复现、难定位。替代方案：

| 需求 | 实现 | 为什么 |
|------|------|--------|
| 创建快捷方式 | Electron 原生 `shell.writeShortcutLink()` | 原生 Unicode 支持，无需外部进程 |
| 读取快捷方式目标 | Electron 原生 `shell.readShortcutLink()` | 用于反查历史安装目录 |
| 注册表读写 | `execFile('reg.exe', [args...])` | 参数经 `CreateProcessW` 以 UTF-16 传递，中文值不乱码 |
| 结束旧进程 | `execFile('taskkill', ['/IM', exe, '/F', '/T'])` | 无匹配进程时返回 128，已按正常情况处理 |
| 卸载器 | 生成 `Uninstall.cmd`（UTF-8 无 BOM + `chcp 65001`） | 避免中文回显乱码；延迟自删整个安装目录 |

**命名约定**（`electron/product.js`）：

- `APP_NAME = '艺镜AI剪辑'` —— 窗口标题、快捷方式名、开始菜单分组、控制面板显示名
- `APP_EXE = 'YiJingAIEditor.exe'` —— **纯 ASCII**，避开第三方工具链对中文文件名的兼容问题
- `REG_KEY = 'YiJingAIEditor'` —— 注册表键名，纯 ASCII

### 安装范围

写入 `HKCU`（当前用户），**不需要管理员权限**（`requestedExecutionLevel: asInvoker`）：
- 卸载登记：`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\YiJingAIEditor`
- 开机自启：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\YiJingAIEditor`

默认安装位置：`%LOCALAPPDATA%\Programs\艺镜AI剪辑`。

### 升级安装

`findExistingInstallDir()` 依次从以下来源反查历史目录，命中则预填路径并标记为「升级安装」：

1. 命令行参数 `--install-dir=<path>` / `--install-dir <path>`
2. 注册表 `InstallLocation`
3. 桌面 → 开始菜单快捷方式的目标路径
4. 常见安装目录白名单

---

## 5. 出包

### 5.1 一键出包（推荐）

```bash
node packages/installer/scripts/build-installer.mjs
```

依次执行：

1. 客户端渲染层 `vite build` → `packages/desktop/dist-renderer`
2. 客户端免安装目录 `electron-builder --dir` → `packages/desktop/dist-win/win-unpacked`
3. 压缩 → `packages/installer/payload/app.7z`
4. 安装器渲染层 `vite build` → `packages/installer/dist-renderer`
5. 安装器单文件 exe → `packages/installer/dist-installer/YiJingAIEditor-Setup-Windows-x64.exe`

参数：

- `--skip-app` —— 跳过 1~3 步，复用已有 `payload/app.7z`，只重出安装器（改向导 UI 时最常用）
- `--skip-installer` —— 只做 1~3 步，只更新主程序数据包

### 5.2 分步执行

```bash
# 只重打主程序数据包
node packages/installer/scripts/pack-payload.mjs packages/desktop/dist-win/win-unpacked

# 只重出安装器
node packages/installer/scripts/build-installer.mjs --skip-app
```

### 5.3 国内网络

`build-installer.mjs` 已内置镜像默认值，如需覆盖：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

---

## 6. 自测

```bash
# 安装器端到端（真实 Electron + 真实 7za 解压 + 真实注册表/快捷方式）
node tools/installer-e2e.mjs

# 保留临时安装目录，便于排查
node tools/installer-e2e.mjs --keep
```

测试覆盖：启动自检与元信息 → 单页门控（未勾选协议时拦截、路径为空时主按钮禁用、
展开/收起窗口高度 650×560 / 650×360、协议浮层 560×330）→ 真实解压出主程序 exe →
快捷方式与注册表落盘 → 完成态与退出 → 控制台零错误 →
**全程清理**（删除临时安装目录、快捷方式、注册表项）。末尾输出 `INSTALLER_E2E_PASSED` / `FAILED`。
真机截图基线见 `_recon/ours/`（01-collapsed / 02-expanded / 03-collapsed-again /
04-license / 05-need-agree / 06-live-installing / 07-live-done）。

> 注意：测试会在当前用户桌面/开始菜单临时创建快捷方式，并在结束后删除。

---

## 7. 已知边界

- **未做代码签名**：exe 未签名，Windows SmartScreen 首次运行会提示「未知发布者」。
  如需消除，需自备代码签名证书并在 `electron-builder.yml` 配置 `win.certificateFile` / `certificatePassword`。
- **仅 Windows 出包**：`electron-builder.yml` 保留了 macOS 段，但本机流水线只跑 `--win`。
- **安装器自身不写磁盘缓存**：portable exe 运行时自解压到 `%TEMP%`，退出后由系统回收。
- **7za 版本**：随包为 7-Zip 21.07 (x64) 独立版，只用到 `a` / `x` 两个子命令。
