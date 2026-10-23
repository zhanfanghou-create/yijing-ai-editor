#!/usr/bin/env node
/**
 * 一键验证：把该跑的检查串起来，输出统一的三档结论（通过 / 失败 / 跳过）。
 *
 * 用法：
 *   npm run verify                    # 跑全部
 *   npm run verify -- --only static   # 只跑指定闸门（可重复）
 *   npm run verify -- --keep-server   # 自己拉起的后端不关（调试用）
 *   npm run verify -- --list          # 列出闸门
 *
 * 设计约束（都是踩过坑才这么写的，别简化掉）：
 *
 *  1. 每个闸门带**预期断言数**。某个 case 被注掉 / 被提前 return 跳过时，脚本依旧
 *     全绿、只是总数变小 —— 没有任何一行输出会告诉你。对不上就报错。
 *  2. 依赖后端的闸门**自己把后端拉起来**，不靠"人记得先开"。跑之前先探活
 *     （注意健康检查路径是 /health，不是 /api/health），探不到就 spawn，收尾再关。
 *  3. 子进程输出**一律落盘**（_evidence/verify/*.log）。只看"没就绪"是查不出
 *     端口冲突 / 依赖缺失这类原因的。
 *  4. 解码先按 UTF-8；输出里出现 U+FFFD 直接判该闸门失败 —— 编码判错会让关键词
 *     匹配全部落空，那才是真正的静默失败。
 *  5. 退出码 = 有失败则为 1，且**显式 process.exit**（playwright/Electron 的连接会让
 *     事件循环常驻，不显式退出在 CI 里表现为卡死）。
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const NODE = process.execPath
const EVIDENCE = path.join(root, '_evidence', 'verify')

const argv = process.argv.slice(2)
const only = []
for (let i = 0; i < argv.length; i++) if (argv[i] === '--only' && argv[i + 1]) only.push(argv[i + 1])
const keepServer = argv.includes('--keep-server')
const listOnly = argv.includes('--list')

const SERVER_URL = 'http://127.0.0.1:8787'
/** 健康检查路径：服务端自报的是 /health（不是 /api/health，别照 REST 直觉写） */
const HEALTH_PATH = '/health'

/**
 * 闸门表。
 *
 * expected = 该闸门应有的断言总数（含跳过项）。
 * 改动断言后必须同步改这里 —— 这个数字就是"断言有没有被悄悄删掉"的唯一信号。
 *
 * minExpected = 该闸门输出里的数字是**事实数**（而不是断言数）时用的**下界**。
 * 判据很简单：**这个数字会不会因为一次完全正常的改动而合法地变大？**
 *   · 会（如"扫到 210 条相对导入"）⇒ 只留 minExpected。钉死它必然假红，
 *     而假红会训练人无脑忽略这道闸门；但**跌**下来是危险方向
 *     （扫描器漏看了东西、闸门在悄悄变瞎），所以下界必须留。
 *   · 不会（如"夹具固定 12 项断言"）⇒ 用 expected 精确钉死。
 *
 * count 用**具名捕获**统一语义，别用位置下标：各脚本的汇总格式不一样，
 * 例如安装器写的是「67/71 通过，0 失败，4 跳过」，位置下标会把"失败"当成"通过"。
 * 支持的名字：p=通过、f=失败、s=跳过、t=总数（t 缺省时按 p+f+s 推算）。
 */
const GATES = [
  {
    id: 'modules',
    name: '依赖·node_modules 安装完整性',
    argv: [NODE, 'tools/check-node-modules.mjs', 'node_modules'],
    // 刻意不钉断言数：这里的数字是**扫描到的包数**（当前 423），是随依赖变化的
    // 事实数据，不是断言数。钉死它会在每次 npm install 后产生假红，反而训练人忽略闸门。
    // 「护栏是否还在工作」由下面那道自证闸门用稳定数字负责。
    expected: null,
    marker: /NODE_MODULES_OK/,
    count: /已检查\s*(?<t>\d+)\s*个包/
  },
  {
    id: 'modules-selftest',
    name: '自证·依赖完整性检查器本身有效（夹具）',
    argv: [NODE, 'tools/check-node-modules.selftest.mjs'],
    // 这道是稳定数字：夹具固定 12 项断言。删掉扫描分支 / 让它变成空转 / 恢复那个
    // 崩溃写法，都会立刻在这里露出来。上一轮「检查器其实什么都没查却报 OK」就是
    // 靠这类夹具才发现的。
    expected: 12,
    marker: /SELFTEST_PASSED/,
    count: /自证：通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'imports',
    name: '静态·相对导入与命名绑定（含"用了但没导入"的自由变量）',
    argv: [NODE, 'tools/check-imports.mjs', 'packages/desktop/src', 'packages/installer/electron'],
    // 145 → 151：新增 payments/* 与 orders/credits 这批模块带来的 6 条相对导入。
    // 151 → 173：**计数口径变了**，不是代码涨了 —— 旧版按"每文件去重后的 specifier"
    //   计数（用一个 Set 顺手去重），新版改成"每条 import 子句"计数。同一个 import
    //   写两遍现在会算 2 条。这类口径变更必须在这里写清楚，否则下次有人看到数字变了
    //   只会以为是噪声，而"数字变小 = 断言被删"这个信号也跟着失效。
    // 口径：只在**确实新增了源文件**时允许上调；数字凭空变小一律是删断言的信号。
    // 173 → 175（2026-09-21）：**不是新增源文件**，是给 Home.jsx / TopBar.jsx 各加了
    //   1 条 `import logoUrl from '../assets/logo-256.png'`（界面 logo 改用 ico/ 解出的真图）。
    //   本闸门按"每条 import 子句"计数，所以给已有文件加导入同样会 +1 —— 两种上调原因
    //   要分开写清楚，否则下次看到数字变了会分不清是"新增文件"还是"新增导入"。
    // 175 → 178（2026-09-21）：同样是**新增导入而非新增源文件**，三个文件各 +1：
    //   App.jsx / Stage.jsx 引入 keymap.js（快捷键派发与帧率），Dialogs.jsx 引入
    //   keymap.js 的动作表与冲突检测（设置里的「快捷键」页）。
    //   ⚠️ 同一天还修掉了本检查器自身的一个**漏报缺陷**（见其 stripNoise 注释），
    //   修完后本闸门的数字没变（仍是 178）—— 它改的是"能不能看见"，不是"数多少条"。
    // 178 → 179（同日）：Timeline.jsx 引入新建的 trim.js（片段两端修剪的纯算术）。
    // 179 → 180（同日）：App.jsx 引入 trim.js 的 EPSILON / sourceTimeAt，让预览区
    //   按播放头选素材、并把"源文件时间"算好交给 Stage。同样是**新增导入而非新增文件**。
    // 180 → 182（2026-09-21）：图标层改造。图标原来全部内联在 icons.jsx（该文件本来
    //   **一条相对导入都没有**），现在拆成三层：
    //     ownIcons.jsx   —— 由 build-own-icons.mjs 自绘的图标（原名 refIcons，
    //                       开源版换掉第三方字形后改名，内容也是重画过的）
    //     iconsLocal.jsx —— 仍需手绘的 33 个角色
    //     icons.jsx      —— 汇总层，两条 `export {…} from './…'`
    //   ⚠️ 这是**计数口径的第 3 种上调原因**：既不是新增源文件、也不是新增 import 子句，
    //   而是把"内联"改成了"再导出"。它同样会让这个数字 +2，必须写清楚，
    //   否则下次看到数字变化会误判成断言被动过。
    // 182 → 185（2026-09-19）：首页三张功能卡的配图改成仓库内的真实 PNG
    //   （assets/home-feat/*.png，从参考客户端资源段提取），Home.jsx 因此多三条
    //   相对导入（featArtAiAds / featArtAvatar / featArtAiVideo）。这是**第 1 种上调
    //   原因：新增 import 子句**，不是新增源文件（Home.jsx 早就存在）。
    //   之所以能确定 +3 就是这三条：本次改动只动了 Home.jsx 的 import 区与
    //   assets/home-feat/ 目录，而 assets 目录本身不计入"相对导入"。
    //   ⚠️ 这三条断言值钱的地方在于它**连着构建产物**：若把 PNG 改成从别处 require
    //   或动态拼路径，这里会掉回 182，从而暴露出"图片不再是构建期可追踪的静态资源"。
    // 185 → 186（2026-09-22）：**第 1 种上调原因（新增源文件）**。新增
    //   src/renderer/clipVisuals.jsx（时间线的抽帧/波形/文字可视化），
    //   Timeline.jsx 因此多一条 `import {...} from '../clipVisuals.jsx'`。
    //   只 +1 而不是 +2：新文件自己只 import react（非相对路径，不计数），
    //   所以新增文件带来的增量恰好是"引用它的那一条"。
    // 186 → 208（2026-09-23）：**第 1 种 + 第 2 种叠加**，共 +22。逐类列清：
    //   · 新增源文件 6 个（第 1 种）：
    //       renderer/capabilityMeta.js（能力元数据唯一真源）
    //       renderer/looks.js + main/looks.js（滤镜/转场，两侧镜像）
    //       shared/looks.json（两者的共同数据真源，用 JSON 是因为渲染层 ESM
    //         与主进程 CommonJS 都能读，避免同一张表抄两份）
    //   · 给已有文件新增 import 子句（第 2 种）：Home/AssetTree/EditorTabs/
    //     SidePanels/App 引 capabilityMeta；Stage/Timeline/SidePanels/App 引 looks；
    //     main/render 引 main/looks；server 的 providers/index 与 routes/admin 引
    //     三个 ark 模块。
    //   ⚠️ 这一轮同时**修掉了本检查器三个真实缺陷**（见 tools/check-imports.mjs 里
    //   2026-09-23 的三段注释：库作用域被提升到文件级 / JSX 属性值被当成属性名 /
    //   模板串嵌套导致串内容漏成"代码"）。修完数字没变（仍是 208）——
    //   它们改的是"能不能看见"，不是"数多少条"。
    //
    // 208 = **下界**，不是合约数：这个数字统计的是仓库里有多少条相对导入，是**事实数**。
    // 2026-09-23 加了两条 import（assets.js / AiPanel.jsx 引 capabilityMeta）后涨到 210，
    // 闸门立刻假红 —— 而"新增一条 import"是完全正常的改动。事实数钉死必然假红，
    // 假红会训练人无脑忽略这道闸门（代价远大于那点保护）。
    // 所以改成下界：**涨**是正常的，**跌**才是危险方向（说明扫描器漏看了东西、闸门在悄悄变瞎）。
    // 208 是**下界**，不是合约数 —— 见上面那段"事实数钉死必然假红"的说明。
    // 208 → 300（2026-09-24）：下界**长期不动就等于没有下界**。208 是当年定的，
    //   而实测当前已是 **303** 条；也就是说从 209 跌到 303 这中间任何一次扫描器
    //   变瞎都不会惊动任何人 —— "跌下来是危险方向"这句约定其实已经失效了。
    //   这次复核把它收到 300（离实测 303 只留 3 条余量）。
    //   ⚠️ 以后每次大改（尤其动扫描逻辑）后都要顺手复核这个数，别再让它烂在那儿。
    // 300 → 88（开源版）：服务端整包删除（`packages/server` 不再参与扫描），
    //   实测跌到 88 条。这里的下界跟着收到 88（离实测只留 8 条余量）——
    //   下界的意义是"跌下来要响"，不是"守住某个历史数字"。
    expected: null,
    minExpected: 80,
    marker: /IMPORTS_OK/,
    count: /已校验\s*(?<t>\d+)\s*条相对导入/
  },
  {
    id: 'imports-selftest',
    name: '自证·导入/绑定校验器本身有效（夹具）',
    argv: [NODE, 'tools/check-imports.selftest.mjs'],
    // 稳定数字：夹具固定 20 项。五类"必须报错"（路径不可解析 / 导入名不存在 /
    // 用了但没导入 / 该缺陷落在"被串扰吃掉"的区间里 / 悬空的状态 setter）
    // + 五类"必须不报错"（默认与具名混写 / 参数解构 / export function /
    // 串里同时含反引号与另一种引号 / 合法的 setter 写法）。
    // 2026-09-21 的缺陷正是第二版检查器抓不到的那类：App.jsx 里调用了
    // fetchHomeAssets 却忘了写进 import，构建全程 0 报错 0 告警、产物里它退化成一个
    // 未定义的自由变量，只有真跑起来才 ReferenceError。这道夹具把那个形状钉住了。
    // 15 → 17（2026-09-21）：修 stripNoise 时补的两条 —— 旧实现分五步正则替换，
    //   会把"引号串内部的反引号"当模板串定界符，与后面真模板串配对，
    //   把中间约 1500 字符真实代码整段吃掉。方向是**漏报**（区间里的缺陷全看不见），
    //   比误报更危险，所以正反两个方向各钉一条。
    // 17 → 20（2026-09-22）：补第五类。真实影片 E2E 第一次真的按下「导入」，
    //   炸出 App.jsx 里的 `setRail('media')` —— 这个名字**全仓库都不存在**
    //   （界面改版后左栏的 Rail 被删了，只剩调用点）。原检查器第 3 条只在
    //   「本文件已 import 的模块的导出」里找自由变量，范围刻意收窄；而"名字
    //   根本不存在"恰好落在范围外，结构上永远看不到。于是加了悬空 setter 判据。
    //   三条新增：①报出悬空 setter ②脏夹具从 4 处变 5 处（数量与文件名各一条）
    //   ③合法 setter 写法必须不误报（这条是被自己咬出来的：第一版判据会把
    //   installer/preload.js 里 `setHeight: (h) => ...` 这种**对象字面量的键**
    //   误报成悬空标识符，所以补了对象键排除并钉住）。
    // 20 → 23（2026-09-22 同日）：补第六类。AI 面板一打开就白屏，根因是
    //   AiPanel.jsx 用了没解构出来的 `initialCapability` —— 它同时躲过前五条：
    //   没有任何模块导出这个名字（第 3 条够不着），也不是 `set`+大写（第 4 条够不着）。
    //   新判据「全仓库找不到出生证明 = 自由变量」，跑在"首参有对象解构"的文件上。
    //   三条新增：①报出 missing-prop.jsx 的 initialCapability ②脏夹具从 5 处变 6 处
    //   （数量与文件名各一条）③**开放集合必须不误报** —— 这条同样是被自己咬出来的：
    //   JSX 标签名、JSX 属性名（含无值布尔属性 `muted`）、JSX 纯文案、正则字面量
    //   内容都是无穷集合，手写白名单必漏；第一版还漏掉了正则的**修饰符**
    //   （`/&quot;/g` 留下一个 `g`），是这条夹具先报出来的。
    // 23 → 25（2026-09-23）：两条新增。
    //   起因是**同一类缺陷在同一份代码里第二次发作**：SidePanels.jsx 里
    //   `<RecordPanel onImport={onImport} />` 的 `onImport` 从来没被 props 解构出来
    //   （App.jsx 一直在传它），点开「录制」面板就 ReferenceError。
    //   第 5 条没抓住它的原因有两层，都不是"判据没写"，而是"判据被绕过"：
    //     ① 出生证明用的是**全库并集** ⇒ 同文件里 `function RecordPanel({ onImport })`
    //        的参数把它洗白了。而 prop 名是全项目复用率最高的一类标识符，
    //        所以"某个 prop 名 A 组件解构了、B 组件没解构"是最常见的形状 ——
    //        全库并集等于把第 5 条对这个主场景整体关掉。现改为**按文件 + 按函数**：
    //        解构出来的 prop 名只在"声明它的那个函数体内"才算绑定。
    //     ② 白名单把 JSX **属性值**里的词也当成了属性名（`onClick={onImport}`）
    //        ⇒ 自由变量最常见的出现位置被自己洗白。现改为只收属性名位置。
    //   两条新增断言：①`prop-used-elsewhere.jsx` 必须被报出（作用域不许提升）；
    //   ②文案夹具必须确实含对抗形状（`media 权限` / `}px · 默认 {x}s` /
    //   `src/shared/looks.json` / `}f<`）—— 否则把夹具换成空文件，上面那条
    //   "不许误报"的断言照样全绿，就成了空洞自证。
    // 25 → 27（2026-09-23，第二次）：假报方向的一条。此前取 props 解构内容的
    //   写法是 `\{([^}]*)\}`，遇到**嵌套的 `}`** 就提前收尾 ——
    //   SidePanels.jsx 的解构里有一项 `catalog = { models: [] }`，于是它**后面**
    //   的十来个名字（projectName…enhanceGroup）集体失去出生证明，被报成假自由变量。
    //   改成括号配平（balancedInner），并按老规矩把缺陷形状钉进夹具：
    //   ①`props-destructure.jsx` 必须不被误报（名字刻意放在嵌套项的**后面**，
    //     另含一层嵌套数组，只修一半过不了）；②夹具必须确实含嵌套形状，
    //     否则上一条同样会退化成空洞自证。
    // 27 → 31（2026-09-24）：**修掉一条真实假红**并配套加 4 条夹具断言。
    //   起因：给 App.jsx 加了 `import { effectiveTransitions } from './looks.js'`
    //   之后，同文件里早就存在的 `<MediaPanel filterLabel={currentNode?.label} />`
    //   突然被报成"使用了但未导入" —— 属性名 `filterLabel` 与 looks.js 导出的
    //   `filterLabel()` **同名**，而第 3 条判据只排除了对象字面量的键、没排除
    //   「赋值目标 / JSX 属性名」（第 3 类自由变量的判据里早就排除了这个位置，
    //   两条自相矛盾）。JSX 属性名不是标识符引用，这是**判据的错，不是代码的错**。
    //   新增 4 条：①新的干净夹具 `REACHABLE_CLEAN` 退出码 0 ②与导出同名的属性名未被误报
    //   ③该夹具确实含对抗形状（同名导出 + 具名导入 + 属性名在前，否则前两条是空洞自证）
    //   ④**反向控制组** `attr-and-value.jsx`：同名标识符在属性名位置放过、在当值调用
    //     位置照报 —— 证明收窄的是**位置**不是**名字**（修过头会让真缺陷一起静音，
    //     而验收时看起来一模一样）。脏夹具随之从 7 处 / 7 个文件变成 8 处 / 8 个文件。
    // 31 → 35（2026-10-10）：**又一条真实假红**（这次是新增的 MCP server 咬出来的）。
    //   `src/main/mcp-server.js` 的工具表写成 `handler: ({ draftId }) => readDraftData(draftId)`，
    //   而 `draftId` 同时又是 `function addClips({ draftId })` 的解构参数 ⇒ 它进了
    //   "解构参数名单"（按函数级判），但 `propScopesOf()` 只认 `function Name(` 与
    //   `const Name = (`、**不认对象属性里的箭头** ⇒ 该箭头里的 draftId 落在"声明它的
    //   函数体"之外 ⇒ 被第 5 条报成自由变量（实测 3 条：draftId/aspectKey/clipId）。
    //   这是**回调**不是 React 组件，属判据盲区，不是代码缺陷。
    //   修法：①`propScopesOf()` 增加第 ② 条，把 `key: ({a}) => …` 认作作用域，且区间在
    //   **箭头体**上算（表达式体要扫到深度 0 的分隔符；只写 `key: (...)` 不要求 `=>`
    //   会把 `{ w: (a+b) }` 也当函数头 ⇒ 区间吞代码 = 漏报方向，故必须要求 `=>`）；
    //   ②`propNamesOf()` 同步补同一形状 —— 否则"只"用这种写法的文件会被判成
    //   "没有解构参数"，第 5 条**整个不跑**（漏报方向）。
    //   新增 4 条：①干净夹具 `handler-arrows.js` 未被误报 ②该夹具确实含对抗形状
    //   （同一名字既在函数解构、又在对象箭头解构并使用，只补一处过不了）
    //   ③**反向控制组** `prop-arrow-freevar.js`：同一支箭头里解构参数放过、真自由变量
    //   `missingThing` 照报（证明没把该箭头里的真缺陷一起静音）④该脏夹具确实含对抗形状。
    //   脏夹具随之从 8 处 / 8 个文件变成 9 处 / 9 个文件。
    expected: 35,
    marker: /IMPORTS_SELFTEST_PASSED/,
    count: /自证：通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'icons',
    name: '产物·界面图标（自绘源与生成的组件一致）',
    argv: [NODE, '--no-warnings', 'tools/build-icons.mjs', '--check'],
    // 稳定数字 43。图标层的产物是**生成**出来的，所以必须有一道闸门回答
    // 「磁盘上的 ownIcons.jsx 还是不是当前自绘源与映射表推出来的那个」。
    // 没有这道闸门的话，改了 MAPPING.json 或者换了原始 SVG 却忘了重跑生成器，
    // 构建照样通过、界面照样渲染，只是图标悄悄用着上一版 —— 静默不一致。
    // 输入全部在仓库里（assets/icons/MAPPING.json + raw/*.svg），不依赖 _evidence。
    // 断言的是**幂等**：重跑生成器得到的报告必须与归档报告逐字一致；
    // 计数 = 生成的参考图标组件数（手绘角色数一并打进统计行，便于核对不丢角色）。
    // 39 → 43（2026-09-23）：首页侧栏 4 个导航图标（创作视频/最近草稿/AI 模板/AI 工具箱）
    //   原先用的是**手绘描边款**，与参考的"实心填充 + 挖空细节"形状不符。
    //   用「归一化二值掩膜逐像素比对」在 1564 个候选中找回真字形（2 个 100% 吻合、
    //   另 2 个 93.0% / 95.5%，均远超次名），补进 MAPPING.json 后由生成器产出。
    //   这属于**真新增素材**，数字必须跟着走，不是断言被动过。
    // 43 → 49（2026-09-23）：工作台左栏的 6 个功能图标（AI视频 / AI图片 / 视频增强 /
    //   图片增强 / 素材库 / 智能剪辑）原先是**描边**手绘款，而参考用的是"实心块 + 挖空"
    //   那一套。量化证据：左栏图标列覆盖率 10.37% vs 参考 19.88%、墨水量 11.4 vs 28.7 ——
    //   盒子/位置/颜色全对，只有"看着不像"。改用 tools/extract-ref-svgs.mjs 从参考
    //   可执行体里逐字节取出的原版 SVG（另有 1 个「AI更换」池里没有对应字形，
    //   按参考截图手绘实心版，见 iconsLocal.jsx 的 IconAiSwap）。
    expected: 49,
    marker: /ICONS_CHECK_OK/,
    count: /ICONS_CHECK_STATS\s+total=(?<t>\d+)\s+local=(?<local>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'keymap-selftest',
    name: '自证·快捷键系统本身有效（归一化 / 冲突 / 持久化夹具）',
    argv: [NODE, '--no-warnings', 'tools/keymap-selftest.mjs'],
    // 稳定数字 55。这一层是 keymap.js 的**纯逻辑**自证（不依赖 DOM / React）：
    //   A 组合串归一化（含"只按修饰键不构成组合"）、B 大小写与顺序无关、
    //   C 默认键位表自身干净、D 冲突检测**非空转**（注入脏表必须恰好报 1 处）、
    //   E 用户配置合并（未知 id / 重复 / 空数组=解绑 / 坏输入）、F 派发与输入框豁免、
    //   G 逐帧步进与缩放夹取、H 动作表完整性、I 无 localStorage 环境不抛。
    // 为什么值得单开一道闸门：快捷键是**没有界面就验证不了**的那类功能 ——
    // 派发错了、归一化漏了修饰键顺序、冲突检测永远返回空数组，界面上全看不出来
    // （按下去没反应 / 两个动作同时触发），只有夹具能把它们钉住。
    //　D 组是这里的关键：它**故意注入一张冲突表**再断言恰好报 1 处，
    // 否则"findConflicts 恒返回 []"这种退化也能全绿。
    // --no-warnings：这个 .js 在没写 "type":"module" 的包下会被 Node 重新按 ESM 解析，
    // 从而打一条 MODULE_TYPELESS_PACKAGE_JSON 告警。它不影响结论，但会混进日志尾部。
    expected: 55,
    marker: /KEYMAP_SELFTEST_PASSED/,
    count: /KEYMAP_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'text-system',
    name: '自检·文字系统（动画 CSS↔ffmpeg 逐帧一致 / 排版三件 / 字体链路）',
    argv: [NODE, 'tools/check-text-system.mjs'],
    // 稳定数字 50 = 动画参数 6 + 表达式语义 9 + 排版覆写 8 + 导出 drawtext 9 + 静态链路 9
    //   + 其余为各段内的细分判据。
    // 钉的是「同一个设置，预览和成片表现不一样」：
    //   · 入场位移的方向与幅度（±6% 画幅）、出场符号不能与入场共用；
    //   · 呼吸循环的幅度按**全幅**给，写成 0.82+0.18*sin 会掉到 0.64；
    //   · 行距 / 对齐 / 背景框在两边落成不同参数（line_spacing / text_align / box）；
    //   · 字体：预览要 FontFace + 家族名，导出要磁盘路径，路径失效要退回系统字体。
    // 表达式用 JS 复算（同一串字符），所以"能被 ffmpeg 接受"与"数值对"是分开验的。
    // 50 → 52：新增「转义只有一层」两条（只在真机导出时才炸，静态看不出）。
    expected: 52,
    marker: /TEXT_SYSTEM_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'text-system-selftest',
    name: '自证·文字系统（7 个错误状态必须被判为假）',
    argv: [NODE, 'tools/check-text-system.mjs', '--selftest'],
    // 50 → 52：新增「转义只有一层」两条（只在真机导出时才炸，静态看不出）。
    expected: 52,
    marker: /TEXT_SYSTEM_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'import-mode',
    name: '静态·素材导入方式（保留原位 / 复制进草稿：设置 → 主进程整条链都真的接线）',
    argv: [NODE, 'tools/check-import-mode.mjs'],
    // 稳定数字 12 = 链路 11 + 自证 3（自证不计入 pass，只计 caught，故为 12）。
    // 挡的是"设置项是根装饰开关"：按钮画出来了、点了也变蓝，主进程根本没读它。
    // 最容易错的一环是**复制与 describeMedia 的先后**：先描述再复制，白名单里登记的
    // 还是原路径，复制出的那份素材播不了（表现为"导入成功了，画面是黑的"）。
    expected: 12,
    marker: /IMPORT_MODE_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'markers',
    name: '自检·时间线标记（排序 / 合并 / 命中 / 跳转不原地打转）',
    argv: [NODE, 'tools/check-markers.mjs'],
    // 稳定数字 19 = 规范化 7 + 命中 5 + 跳转 7。
    // 标记的四种坏法都不报错、界面也照样画得出来：
    //   不排序 → 上一个/下一个跳反；不去重 → 同一处叠两个点，按两次才动；
    //   阈值各写一份 → 在标记上再点一次删不掉；跳转取"最近的一个" → 压在上面时原地不动。
    // 尤其 `normalizeMarkers` 里 `Number(null) === 0`：一个 null 会静默变成
    // "打在 0 秒的标记"，看着就像播放头那根线，永远删不掉 —— 已由断言钉住。
    expected: 19,
    marker: /MARKERS_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'trim-selftest',
    name: '自证·片段修剪算术本身正确（源入点同步 / 不变量夹具）',
    argv: [NODE, '--no-warnings', 'tools/trim-selftest.mjs'],
    // 稳定数字 47。trim.js 是时间线片段两端修剪的纯算术，抽出来就是为了能在这里断言。
    // 它治的是一种**只在导出时才暴露**的缺陷：拖左端只改了 start/duration、忘了同步
    // offset（源文件入点），于是片段在界面上看着正常变短，导出成片后右半段画面
    // 却从源文件开头重播了一遍。手拖没人会回归，所以必须有夹具。
    // 关键的两条是**代数不变量**，而不是逐例比对数值：
    //   · 剪左端时 start+duration 恒定（结束点不该被移动）
    //   · 剪左端时 offset-start 恒定（同一帧不会被播两遍 / 不会凭空跳帧）
    // 再用固定种子的 400 组随机输入扫一遍 duration ≥ min / offset ≥ 0 / start ≥ 0。
    // 固定种子是刻意的：夹具必须可复现，真随机会在某天以 1/20 的概率产生假红。
    // 2026-09-21 从 28 → 35：补上「源片长度上限」（右端拉不过源片，否则导出尾部是黑帧）。
    // 这一轮随机扫描**抓出两个真问题**，都是把「前提」当「结论」写断言造成的：
    //   ① 老草稿里可能存在 offset+duration 已超源片的片段 —— 左端修剪只移动左边界，
    //      按定义修不了尾部，所以它保证的是「不放大超出量」而非「结果一定合法」；
    //   ② 上限与最短时长会打架（源片只剩 < min）—— 取舍是 **min 优先**，
    //      代价是允许继续略微超上限，所以右端也只能保证单调不放大。
    // 于是上限相关断言统一改成**单调性**：超出量只减不增。对合法输入它退化成
    // 「结果必须合法」（强约束），对非法输入它保证「越修越糟」不会发生。
    // 另外新增两个具名用例把「精确收敛」和「min 优先」两个取舍方向写死。
    // 2026-09-21 从 35 → 47：补上 `sourceTimeAt`（时间线时刻 → 源文件时间）的 F 段。
    //   它治的是**预览**里的同一族缺陷：预览原来把 `playhead` 直接当 `<video>.currentTime`，
    //   这个等式只在 start=0 且 offset=0 时成立；片段被拖到别处或被剪过左端以后，
    //   预览就会取到源文件里另一处的画面（剪得越多偏得越多），而界面上看不出任何异常。
    // 2026-09-27 从 47 → 69：补上**倍速**这一段（clipSpeed / sourceSpan / 带倍速的
    //   修剪上限 / speedPatch）。倍速是「时间线秒 ↔ 源素材秒」的换算因子，
    //   漏掉它的症状是"预览一个速度、成片另一个速度" —— 两边单独看都没错，
    //   只有算术层这里能钉住。
    // 69 → 75（2026-10-19）：新增 6 条「剪辑联动」判据（trim.js 的 linkMovePatches）——
    //   同源片段一起平移 / 无 assetId 的不参与 / 关掉只动自己 / 往左拖过头整组夹到 0 /
    //   间距守恒 / 目标不存在返回空。前三条挡的是"开关是装饰"，后三条挡的是
    //   "整组夹取只夹了被拖那一条"（画面到 0、声音还留在原地 ⇒ 音画错位，播放才发现）。
    expected: 75,
    marker: /TRIM_SELFTEST_PASSED/,
    count: /TRIM_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'composite-selftest',
    name: '自证·预览合成器本身正确（整条时间线连续播放 / 转场提前挂载 / 多条音轨）',
    argv: [NODE, '--no-warnings', 'tools/composite-selftest.mjs'],
    // 稳定数字 58。composite.js 是「这一帧画面上有哪几层」的纯算术，
    // 抽出来就是为了能在 node 里直接断言 —— 挂在组件里的这层逻辑**错了不报错**：
    //   · 预览以前只有一个 <video>，跨片段时换它的 src ⇒ 每过一个接缝都要重新加载
    //     + 重新解码 ⇒ 接缝处必黑一帧；转场尤其明显，因为后一段是在交叠窗口开始的
    //     那一刻才被新建出来的。合成器按"热点窗口"提前挂载，切换只是换显示哪一层。
    //   · 音频轨 / 叠加轨以前只取一条（重叠区间里另一条凭空消失），而成片是两条都混的。
    //   · 片段音量（属性面板的音量滑杆）以前**只进导出**，改了 gain 成片真的变小声、
    //     预览一点没变 —— 典型的"状态变了画面没变"。
    // 关键断言是**结构性**的而不是逐例比对数值：
    //   · 接缝前后两层的 id 必须**都**在场（证明没换 src）；
    //   · 后一段的挂载时刻必须**早于**出场时刻（证明是预加载、不是临时挂载）；
    //   · 逐点扫描：主层源时间恒等于 sourceTimeAt（预览与导出同一套算术）。
    // 64 → 71：+7 条独奏（solo）。独奏最容易做成"删掉别的轨"，那就和隐藏没区别了；
    // 真口径是「音频轨整段退出合成、视频轨留画面而 gain 归 0」。
    // 71 → 77：+6 条替换片段（trim.js 的 replacePatch，本轮从 App 里抽出来的纯函数）。
    // 这四条不变式错法**都不报错**：换源不换起点 / 源入点归零 / 倍速守恒（2 倍速 + 新素材
    // 10s ⇒ 占位上限 5s）/ 新素材更长时不撑大占位 / 探测失败不动时长 / 无 url 不给补丁。
    // 界面上看不出问题，只有拿数字对才抓得到 —— 所以必须抽成纯函数才能测。
    expected: 77,
    marker: /COMPOSITE_SELFTEST_PASSED/,
    count: /COMPOSITE_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'logo-sync',
    name: '静态·界面 logo 与 ico/ 源图逐字节一致',
    argv: [NODE, 'tools/check-logo-sync.mjs'],
    // 这道闸门治的是「换了 ico/ 里的 logo、也重新打包了，界面还是旧 logo」——
    // 界面里的 logo 是由 tools/extract-ico-frame.mjs 从 ico/256X256.ico 解出的
    // assets/logo-256.png，中间隔了一层生成步骤，所以这两者必然会漂移。
    // 它不报错、不影响构建、尺寸也对，只是"图是上一版"，跟"配了图没生效"长得一样。
    expected: 1,
    marker: /LOGO_SYNC_OK/,
    count: /LOGO_SYNC_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'logo-sync-selftest',
    name: '自证·logo 同步校验器本身有效（夹具）',
    argv: [NODE, 'tools/check-logo-sync.selftest.mjs'],
    // 稳定数字：夹具固定 10 项。其中 5 项是"必须红"（logo 对不上 / 源图缺失 /
    // 产物缺失 / 源图没有该尺寸帧 / 比较方向写反），4 项前置存在性，
    // 1 项是"当前仓库必须绿"。夹具文件 tools/fixtures/logo-from-64.png 是常驻文件。
    expected: 10,
    marker: /LOGO_SYNC_SELFTEST_PASSED/,
    count: /自证：通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'installer',
    name: '安装器 E2E（真实解压 + 快捷方式 + 卸载器）',
    argv: [NODE, 'tools/installer-e2e.mjs'],
    expected: 71,
    marker: /INSTALLER_E2E_PASSED/,
    count: /：(?<p>\d+)\/(?<t>\d+)\s*通过，(?<f>\d+)\s*失败，(?<s>\d+)\s*跳过/
  },
  {
    id: 'media',
    name: '客户端 E2E（本地素材导入 / 协议取流 / Range）',
    argv: [NODE, 'tools/media-import-e2e.mjs'],
    // 这道也是稳定数字。脚本被特意写成「环境差异用 SKIP 表达」：
    // 没有 ffmpeg 时视频那 8 条逐条记 SKIP，而不是少跑 8 条；contextBridge 打不了桩时
    // UI 那 6 条同办。所以总数恒定，掉下来只可能是有人删了断言。
    // 32 → 35（2026-09-22）：新增 3 条「缩略图与像素比例」，都挂在这道闸门里：
    //   ① 视频缩略图铺满缩略图格（`<video>` 不给宽高会按自身像素尺寸排布，
    //      1080p 的片子撑破格子后被 overflow:hidden 裁掉一半）
    //   ② 缩略图格用素材**真实像素比例**（原先是写死的 16:10，4:3 素材被显示成 16:10）
    //   ③ 音频轨画出真实波形（自造 tone.wav → fetch → decodeAudioData → 画布，
    //      任一步失败都会被组件静默吞掉，画布会是空的）
    //   为什么放这里而不是 real-film：这三条都需要**像素比例可控的夹具**，
    //   而这里有自造的 64×48 PNG / 320×240 MP4 / 纯正弦 wav，期望值是算出来的。
    //   三条都按"环境不足记 SKIP"处理，总数不变。
    expected: 35,
    marker: /MEDIA_IMPORT_OK/,
    count: /MEDIA_IMPORT_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'render',
    name: '客户端 E2E（ffmpeg 组时间线 → 真出片并验产物）',
    argv: [NODE, 'tools/render-e2e.mjs'],
    // 稳定数字 28。
    // · 17（2026-09-26 +2：画面特效进导出的用例——fx-pulse（scale+crop 带 t 表达式）
    //   与 fx-flash（hue 亮度带 t 表达式）各真渲一遍，钉住 main/looks.js 的 frameFxFilterFor
    //   语法真的被 ffmpeg 接受；其余 5 种特效与这两个同构）。
    // · 20（2026-09-26 +3：背景进成片。判据取**像素**不取命令串 —— 这条链路最典型的
    //   失效是"背景参数接了、四周也挖成透明了、但最后没有 overlay"，那时透明被输出成黑色，
    //   命令里能看到 -i 背景图、退出码也是 0，唯独画面角落是黑的。所以直接量角落与中心的
    //   颜色：640×360 画布放 320×240 红片段，左右各 80px 边条，x=2 处只可能是背景。）
    // 没有 ffmpeg（整条链路跳过）或没有 ffprobe（产物容器解析跳过）时，相关断言逐条记 SKIP
    // 而不是少跑，所以总数恒定 —— 掉下来只可能是有人删了断言。
    // · 28（2026-09-27 +4：字幕进成片。预览里字幕是 CSS 画的，导出必须翻译成
    //   drawtext —— 少了翻译，"加了字幕"就只在预览里成立，成片照出、退出码照旧是 0。
    //   判据数"近白像素个数"而不是取平均色：白字落在红画面上会被底色稀释成"有点红"，
    //   说不清字在不在；数个数的话，字在是几十上百、不在是 0。另外钉住文字素材
    //   （字幕轨上带 assetId 的那种）不该被画成字幕 —— 它的预览是占位卡，两边要一致。）
    // · 28（2026-09-27 +4：字幕进成片。预览里字幕是 CSS 画的，导出必须翻译成
    //   drawtext —— 少了翻译，"加了字幕"就只在预览里成立，成片照出、退出码照旧是 0。
    //   判据数"近白像素个数"而不是取平均色：白字落在红画面上会被底色稀释成"有点红"，
    //   说不清字在不在；数个数的话，字在是几十上百、不在是 0。另外钉住文字素材
    //   （字幕轨上带 assetId 的那种）不该被画成字幕 —— 它的预览是占位卡，两边要一致。）
    // · 24（2026-09-27 +4：画中画/叠加轨进成片。同样取像素：右下锚点时量右下角那一块
    //   是不是画中画的颜色、上方是不是仍是主画面；再把锚点换成左上，量左上角变绿 ——
    //   只渲一遍而不换锚点，是分不出"位置参数生效"与"位置永远在右下"的。
    //   第四条按时刻取样（第 2.5 秒），钉住 enable 时间窗：画中画不能一路铺到片尾。）
    // 注意这道闸门是**真的在跑 ffmpeg**：命令拼错、滤镜标签写漏、concat 段参数不一致，
    // 都会以「产物时长/分辨率/音轨不对」的形式暴露，而不是被 mock 掉。
    // · 34（2026-09-27 +6：倍速进成片。只验时长分辨不出"根本没做变速"与"方向做反"，
    //   所以造一条**逐秒换色**的素材（0–1s 红 / 1–2s 绿 / 2–3s 蓝），2 倍速播 1.5 秒
    //   ⇒ 成片第 0.75 秒必须取到**源第 1.5 秒**的绿。没变速那一帧会是红（源 0.75 秒），
    //   一眼分辨。另有一条原速回归、一条带音轨（atempo 链路，单级只吃 0.5–2.0）。
    // · 35（2026-10-08 +1：预览窗改成**取景框**语义 —— 素材按裁切铺满，窗外不显示。
    //   于是"4:3 素材进 16:9 画布"不再留边，旧断言「边角是背景色」钉的是一个已被推翻的
    //   前提，必须换成「边角是画面本身」。同时补一条反面：把片段缩到 50%，露出来的
    //   必须是背景图而不是黑边 —— 两条合起来才钉得住"默认铺满 + 缩小露背景"的完整语义。
    //   顺带把三处提前 return 的 SKIP 清单合并成 render-e2e.mjs 里的一份 REST_LABELS：
    //   以前抄了三份且漏了画面特效那两条，缺 ffmpeg 时总数会对不上，红得莫名其妙。）
    expected: 35,
    marker: /RENDER_E2E_OK/,
    count: /RENDER_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'export-contract',
    name: '契约·导出载荷字段（渲染层发的 ⊇ 主进程读的 · 背景三段接力 · 真 overlay）',
    argv: [NODE, 'tools/check-export-contract.mjs', '.'],
    // 稳定数字 1（契约成立 = 1 条；不成立时退出码非 0，由闸门按 marker 缺席判红）。
    //
    // 为什么要有这道闸（2026-09-26 实测踩出来的两类同形缺陷）：
    //   ① `frameFx`（画面特效）：main/render.js 的 buildPlan 早就读 clip.frameFx，
    //      但渲染层 startRender 的片段映射里**从来没这一项** ⇒ 加了特效、预览看得到、
    //      导出成片里静默退成 'none'，全流程一句错都不报。
    //   ② `backdrop`（背景）：buildPlan 收 backdrop 参数，render() 没往下传、IPC 也没带，
    //      而"只把四周挖透明"的分支写得很像那么回事，实际成片里根本没有背景。
    // 这类缺陷的共同点是**两边代码单看都对**，只有跨进程对账才抓得到。
    expected: 1,
    marker: /EXPORT_CONTRACT_OK/,
    count: /EXPORT_CONTRACT_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'export-contract-selftest',
    name: '自证·导出载荷契约看门狗本身会说「不」（合成夹具正反两面）',
    argv: [NODE, 'tools/check-export-contract.selftest.mjs'],
    // 稳定数字 32。夹具覆盖 17 个场景：完整契约绿 / 漏 frameFx / 漏 backdrop /
    // IPC 不转 / render() 不收 / 只有"挖透明"没有 overlay / buildPlan 多读字段 /
    // 叠加轨没从主链排除（成片会凭空多出一段）/ App 没有叠加轨入口（轨道存在但用不到）/
    // Stage 不接收 pip（画中画只在成片里有、预览里看不见）/ 片段漏发 text（字幕写不进成片）/
    // 导出不把字幕翻译成 drawtext（预览有字幕、成片里没有）/ 字幕串在画中画之前（会被盖住）/ 缺文件
    // （最后一条必须退出码 2 —— "没查成"不能混进"查出问题"）。
    // 2026-09-27 +6（26 → 32）：倍速三条 —— 渲染层漏发 speed / 主进程不从 shared 取 /
    // 主进程自己又抄一份。倍速是「时间线秒 ↔ 源素材秒」的换算因子，
    // 两边各写一份就会有一边漏掉，症状是"预览一个速度、成片另一个速度"。
    // 每条例外都要求**红在对的那条断言上**，防止"检查器空转却报绿"。
    expected: 32,
    marker: /EXPORT_CONTRACT_SELFTEST_OK/,
    count: /EXPORT_CONTRACT_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'edit-geometry',
    name: '自检·几何换算同源（裁剪 / 镜像 / 四角圆角 / 蒙版朝向 / 音量包络 / 导出滤镜）',
    argv: [NODE, 'tools/check-edit-geometry.mjs'],
    // 稳定数字 59 = 裁剪 9 + 镜像 7 + 四角 7 + 蒙版 5 + 音量包络 4 + 导出滤镜 8 + 斜切 3
    //   + 倒放 10 + 立体声平衡 7（后两组是 2026-10-19 新加的两项能力）。
    // 这道闸钉的是「同一个参数在预览与导出里被算成两个值」那一族：
    // 裁剪把导出串反解回百分比与预览 transform 反解出的中心比、镜像逐轴对名字、
    // 四角数 hypot 段数、包络用 JS 复算 ffmpeg 表达式。纯函数、不开 Electron，秒级。
    //
    // ⚠️ 倒放那组是**跨实现**的一致性判据：导出侧 ffmpeg 直接反吐帧序，
    //   预览侧 `<video>` 不能负速播放、只能把局部秒翻过来 —— 两侧实现完全不同，
    //   所以断言写成"用预览的换算复算出源时间，首帧必须落在出点、末帧必须回到入点"。
    expected: 59,
    marker: /EDIT_GEOMETRY_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'edit-geometry-selftest',
    name: '自证·几何换算判据可分辨（错误状态必须被判为假）',
    argv: [NODE, 'tools/check-edit-geometry.mjs', '--selftest'],
    // 8 个"错误状态"谓词（裁剪中心偏 / 只接一根镜像轴 / 四角只算两角 /
    // 条带朝向串 / 包络表达式不一致 / 降噪关掉仍留参数 / 倒放预览没翻转 / 全左时右声道没归零）。
    // 它们全部为假才算通过。
    expected: 59,
    marker: /EDIT_GEOMETRY_SELFTEST_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'speed-curve',
    name: '自检·曲线变速 / 卡点 / 音高（面积=平均速率、分段三不变式、变调时长守恒）',
    argv: [NODE, 'tools/check-speed-curve.mjs'],
    // 稳定数字 84 = 规范化 10 + 面积与映射 15 + 片段换算 13 + 分段不变式 9
    //   + 应用补丁 5 + 卡点 10 + 音高 12 + 节拍检测 10。
    // 这道闸钉的是「变速这件事在预览与导出里被算成两个东西」那一族：
    // 曲线下的面积是平均速率（决定片段占多长）、p 时刻的累计面积决定取源的哪一秒
    // （决定画面内容）、导出分段的三条不变式决定成片长度对不对。
    // 三者任意一个算错，成片都不会报错 —— 只是"短了一截 / 画面提前跑掉 / 每段跳一下"。
    //
    // ⚠️ 另外两条是**反向**判据：分段速率必须等于该段自己的 srcLen/dur（不是平均值），
    //   变调必须同时有 asetrate 与抵消用的 atempo（少了 atempo 片段会变短，
    //   于是音画从这一秒开始整体错位）。
    expected: 84,
    marker: /SPEED_CURVE_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'speed-curve-selftest',
    name: '自证·曲线变速判据可分辨（面积近似 / 线性累计 / 漏段 / 平均速率 / 变调不抵消 / 慢窗叠平）',
    argv: [NODE, 'tools/check-speed-curve.mjs', '--selftest'],
    // 8 个"错误状态"谓词，全部为假才算通过（见脚本里的 mustFail 列表）。
    expected: 84,
    marker: /SPEED_CURVE_SELFTEST_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'ui-accent',
    name: '静态·界面强调色只许一套（青色 UI 强调不许回来 · 裸色必须走令牌 · 令牌同源）',
    argv: [NODE, 'tools/check-ui-accent.mjs', '.'],
    // 稳定数字 4 = 青色强调扫描 1 + 工作台裸品牌紫字面量 1 + 令牌存在且同源 1 + 覆盖面 1。
    //
    // 为什么要有这道闸（2026-10-10 Jason 实测）：界面里并行着两套强调色 ——
    //   品牌紫（功能标签 / 右栏页签 / 比例 chip / 导出按钮）与青色 #00C1CD
    //   （子页签选中 / 分节圆点 / 开关 / 取色环 / 输入聚焦框 / 播放条时码）。
    //   症状是「子页签选中是青、它上级的页签选中是紫」，同一栏里像两个产品：
    //   不报错、不影响功能、任何功能测试都不红，只有把界面截出来看才发现。
    //   已全部收进品牌紫，并把 `--wb-accent*` 指向 styles.css 的 `--violet`（唯一真源）。
    //
    // ⚠️ 判据只扫**去注释后的声明值**，且只扫 `#00C1CD` / `rgba(0,193,205)` 这一支具体的青：
    //   · 这些文件里的注释大量记录着实测色值（「参考实测 #c473f2」），不抹注释会把
    //     "证据笔记"当成"还在用这套色"判红 —— 假红比漏报更贵；
    //   · 「所有偏蓝的颜色」会把首页模板封面 / 反馈卡插画的**内容色**一起判红。
    expected: 4,
    marker: /UI_ACCENT_OK/,
    count: /UI_ACCENT_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'ui-accent-selftest',
    name: '自证·强调色判据可分辨（青色长回来 / 裸色 / 令牌分叉 / 只有注释 各红在对的断言上）',
    argv: [NODE, 'tools/check-ui-accent.selftest.mjs'],
    // 稳定数字 14 = good 2 + cyan-back 2 + bare-purple 3（含"夹具确实被改动过"）
    //   + no-alias 1 + dead-cyan 2 + comment-only 2 + hollow 2。
    // 其中 **comment-only 那两条是假红防线**：注释里写满实测色值时必须照样绿。
    expected: 14,
    marker: /UI_ACCENT_SELFTEST_OK/,
    count: /UI_ACCENT_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'no-external-stub',
    name: '契约·入口不许是空的（不甩用户去浏览器 · 不跳官网首页 · 不弹占位提示）',
    argv: [NODE, 'tools/check-no-external-stub.mjs', '.'],
    // 稳定数字 3（window.open / 裸官网外链 / 占位提示 三条判据各 1）。
    //
    // 为什么要有这道闸：这三种写法**都能通过编译、都能通过静态导入检查、
    // 也都能通过逐像素比对**，唯独"功能上等于没有"：
    //   ① window.open —— Electron 里会被主进程拦下交给系统浏览器，
    //      配一句"在新窗口打开"的文案时，用户读作"点了没反应"；
    //   ② openExternal('https://example.com') —— 把某个入口做成跳官网，
    //      这个入口就等于不存在；
    //   ③ toast('还没接上') —— 点下去只弹一句话，事情一件没办。
    // 2026-09-26 三类各清掉若干处（TopBar 礼盒/消息 → 真弹窗；Home 反馈/客服 →
    // 应用内反馈表单；Inspector → openExternal）。这道闸让它们回不来。
    // ⚠️ 开源版没有支付与广告位，所以**没有任何"有意的外链"白名单**。
    expected: 3,
    marker: /NO_EXTERNAL_STUB_OK/,
    count: /NO_EXTERNAL_STUB_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'no-external-stub-selftest',
    name: '自证·入口检查看门狗本身可分辨（该红的红 · 合法状态提示绝不误判）',
    argv: [NODE, 'tools/check-no-external-stub.selftest.mjs'],
    // 稳定数字 13。**两面都要有**：
    //   必须红 —— 裸 window.open / 官网首页外链 / 「还没接上」占位提示；
    //   绝不能红 —— 带 allow-window-open 标记的浏览器态兜底、支付外链、
    //     带具体路径的内容页、「时间线上还没有片段」这类**合法状态提示**。
    // 最后一条最重要：判据一旦放宽到"还没有"，合法提示会被一起判红，
    // 假红会训练人无脑忽略这道闸门，代价比漏报更大。
    expected: 13,
    marker: /NO_EXTERNAL_STUB_SELFTEST_OK/,
    count: /NO_EXTERNAL_STUB_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'draft',
    name: '客户端 E2E（草稿持久化：真落盘 + 重启自动恢复）',
    argv: [NODE, 'tools/draft-e2e.mjs'],
    // 稳定数字 19。找不到 electron 时整段记 SKIP 而不是少跑。
    // 这道闸门断言的是**磁盘上的文件和重启后的 DOM**，不是 IPC 返回值 ——
    // 「界面说已保存、重启后什么都没有」是这条链路上最典型的静默失败，
    // 只有真的关进程再启一次才照得出来。
    // 脚本自带看门狗（默认 6 分钟）自判失败强退，配合上面的 GATE_TIMEOUT_MS 双保险。
    // 19 → 20（2026-09-22）：夹具中间那段从"第二条视频"改成**字幕轨**，
    //   并新增 13b「字幕轨片段在轨道上直接显示台词正文」。挂在草稿闸门是因为
    //   这里唯一能造出文本片段的路径就是草稿夹具（真实文本素材来自服务端
    //   story_script/字幕翻译任务，离线造不出来）；顺带也就钉住了
    //   `clip.text` 从写入 → 落盘 → 恢复到渲染这一路没被丢掉。
    expected: 20,
    marker: /DRAFT_E2E_OK/,
    count: /DRAFT_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'keymap-e2e',
    name: '客户端 E2E（设置里的快捷键页：改绑 → 真按键 → 冲突 → 重启仍生效）',
    argv: [NODE, 'tools/editor-keymap-e2e.mjs'],
    // 稳定数字 31。为什么在 keymap-selftest（纯逻辑）之外还要这道：
    // 纯逻辑证不了"设置页真的画出来了"，更证不了下面三件只在真机才成立的事 ——
    //   1. **录入态截得住按键**：录入时按 Ctrl+E 不能顺手弹出导出框。
    //      App 的全局派发挂在 window 冒泡阶段，不在捕获阶段截就会先执行一遍，
    //      这条只有真按一次键盘才照得出来。
    //   2. **派发器用的是用户键位表**：把播放/暂停从 Space 改绑 F9，再断言
    //      按 F9 会播放、按 Space **不再**响应。一正一反都要 —— 只验 F9
    //      会被"两个键位都留着"蒙过去。
    //   3. **活过重启**：自定义键位落的是主进程 settings，不是内存。
    //      这一条只能真的关进程再启一次。
    // 各组行数/分组名/固定键位都写成**独立期望值**（21 / 6 组 / Esc），
    // 不从 keymap.js import —— 从被测算的代码里取期望值等于没测。
    // profile 目录带 pid（每轮唯一），否则上一轮残留的自定义键位会让
    // "开头应当全部为默认"变成一条莫名其妙的假红。
    expected: 31,
    marker: /EDITOR_KEYMAP_E2E_OK/,
    count: /EDITOR_KEYMAP_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'preview-follow',
    name: '客户端 E2E（预览区跟随播放头：换片段取对素材 + 映射到源文件时间）',
    argv: [NODE, 'tools/preview-follow-e2e.mjs'],
    // 稳定数字 18。为什么在 trim-selftest 的 sourceTimeAt 段（纯算术）之外还要这道：
    // 纯算术证不了**接线**。就算 sourceTimeAt 全对，App 只要仍然把 `playhead` 当源时间
    // 传下去、或者仍然按 `selection.clipId` 选素材，纯逻辑那道闸门照样全绿。
    // 这道专门盯住三件只有真机才成立的事：
    //   1. **预览跟播放头，不跟选中**：选中乙、把播放头走到甲上，必须显示甲。
    //      一条断言同时否掉"按选中挑素材"和"按选中挑源时间"两种写法。
    //   2. **区间左闭右开**：播放头正好落在接缝上时归后一个片段。闭区间会让
    //      前一个片段一直赢，表现为"接缝那一帧停在上一个画面"。
    //   3. **空白处退回选中并夹到末帧**：既不显示空白、也不把越界值交给 <video>。
    // 期望的源时间一律按 offset+(t-start) 手算（33.000 / 50.000 / 52.000 / 55.000 / 70.500），
    // 不从被测代码取；播放头靠**真按方向键**推进（N 次 = N/30 秒），顺带验了按键派发。
    // 源时间从 `.wb-player[data-source-time]` 读，不读 `<video>.currentTime`（后者是异步生效的，必 flaky）。
    expected: 18,
    marker: /PREVIEW_E2E_OK/,
    count: /PREVIEW_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'timeline-play',
    name: '客户端 E2E（整条时间线连续播放：跨接缝不换 src + 转场提前挂载）',
    argv: [NODE, 'tools/timeline-play-e2e.mjs'],
    // 稳定数字 17。这道是"按时间线合成预览"唯一的**行为级**证据：
    // 预览以前只有一个 <video>，跨片段时换它的 src ⇒ 每过一个接缝都要重新加载 +
    // 重新解码 ⇒ 接缝处必黑一帧；转场尤其明显，因为后一段是在交叠窗口开始的那一刻
    // 才被新建出来的。这种缺陷静态扫描全绿、构建全绿、**逐像素截图也全绿**
    // （截图永远拍在稳定态，拍不到切换那一帧），只有从头播一遍才知道。
    // 判据是**元素身份**而不是 src 字符串：给每个 <video> 打一个只增不减的标记，
    // 跨接缝之后标记不变 ⇒ 元素从未被重建 ⇒ 没有换 src。
    //   · 1.0s：画面层必须是 2 个（后一段已提前挂载，只有一段可见）
    //   · 2.5s：转场层里的后一段必须就是 1.0s 时那个元素（转场第一帧不黑）
    //   · 4.0s：两层的标记与 src 都和 1.0s 完全一致（跨接缝没换元素）
    // 素材是 ffmpeg 现造的两段 3 秒影片，播放头靠真按键推进，最后真按一次播放键。
    expected: 17,
    marker: /TIMELINE_PLAY_OK/,
    count: /TIMELINE_PLAY_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'speed-ui',
    name: '客户端 E2E（倍速：时间线占位减半 + 预览源时间与 playbackRate 双判据）',
    argv: [NODE, 'tools/speed-ui-e2e.mjs'],
    // 稳定数字 12。倍速落在三个地方，任意一处漏掉都不报错、也不空屏：
    //   ① 时间线占位（duration × 速度 守恒重算） ② 预览（源时间乘倍速 **且** 设 playbackRate）
    //   ③ 导出（trim 取源跨度 + setpts/atempo）。
    // ③ 由 render-e2e 的 6 条逐像素断言钉住；①② 只有真点一遍才知道 ——
    // 只对齐源时间、不设 playbackRate，刚点下去那一帧是对的、越播越落后，
    // 而静态扫描、构建、截图（永远拍稳定态）全部全绿。
    // 判据取两个行为量：片段显示时长 00:00:04 → 00:00:02；播放头走 1 秒 ⇒ 源时间走 2 秒。
    expected: 12,
    marker: /SPEED_UI_OK/,
    count: /SPEED_UI_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'curve-export',
    name: '真导出·曲线变速（分段拼接真的跑得过 ffmpeg：四种音高组合 · 时长 · 音轨 · 切点一致）',
    argv: [NODE, 'tools/check-curve-export.mjs'],
    // 稳定数字 19 = 夹具 2 + 滤镜图与分段 5 + 三种音高组合各 3（共 9）+ 曲线音频轨 3。
    // 这道是**唯一**能证明"曲线变速真的能导出"的证据：分段拼接是一串拼出来的滤镜图，
    // 拼错的样子不是"算错一个数"，而是 ffmpeg 直接报 `No such filter: ''` 或者
    // concat 因采样格式不一致失败（首跑就踩到过一次：尾段整段为空时链里零个滤镜）。
    // 判据全取成片本身：时长 = 时间线占位、音轨还在、视频与音频的切点逐个相等。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 19,
    marker: /CURVE_EXPORT_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'compound',
    name: '自检 + 真导出·复合片段（新建 / 展开 / 裁剪 / 倍速 / 倒放 / 嵌套 / 解除 / 成片像素）',
    argv: [NODE, 'tools/check-compound.mjs'],
    // 稳定数字 70 = 新建 11 + 展开 10 + 裁剪 6 + 倍速 7 + 倒放 4 + 空隙 2 + 嵌套 4
    //   + 解除 7 + 轨道开关穿透 5 + 不改入参 2 + 音量穿透 2 + 真导出 10。
    //
    // 这块的错法全是"不报错"的：展开时坐标算错半秒（画面照播、只是内容错位）、
    // 裁剪时漏乘倍速（右半段从头再播一遍）、导出侧忘了展开（成片只剩第一段、后面全黑）。
    // 所以判据两头钉：纯算术取展开后的片段表，成片侧**真跑 ffmpeg 读中心像素** ——
    // 0.6 秒必须是第一段的红、3.0 秒必须是第二段的蓝（"只有第一段被渲染"时这一条必红）。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 70,
    marker: /COMPOUND_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'compound-e2e',
    name: '客户端 E2E（复合片段：Ctrl 多选 / 右键合成 / 预览展开 / 预览点选落外层 / 解除还原）',
    argv: [NODE, 'tools/compound-e2e.mjs'],
    // 稳定数字 15。这一族全是"界面到算术之间那三根线"：
    //   ① Ctrl 多选没进集合（菜单只合成一段）② 合成后预览没展开（时间线变成一个片段、画面黑掉）
    //   ③ 预览里选中内部子 id（模型里没有这个 id ⇒ 右栏空、选框不出现）。
    // 判据取消费端：时间线片段数与角标、预览主画面层的 data-layer 是否 `父id~子id`、谁带 .selected。
    expected: 15,
    marker: /COMPOUND_E2E_OK/,
    count: /COMPOUND_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'multicam',
    name: '自检 + 真导出·多机位（新建 / 同步 / 切换点 / 展开 / 裁剪 / 倍速 / 倒放 / 轨道开关 / 解除 / 成片像素）',
    argv: [NODE, 'tools/check-multicam.mjs'],
    // 稳定数字 69 = 新建 10 + 切换点 11 + 展开 21 + 裁剪倍速倒放 9 + 轨道开关 4
    //   + 解除 4 + 与复合互操作 2 + 真导出 8。
    //
    // 这块的错法全是"不报错"的：同步 offset 少算半秒（切角瞬间画面里的人跳一下）、
    // 切换点按时间线秒存（2 倍速下每个点都偏一半）、末段没延伸到节目末尾（结尾黑掉）、
    // 取声音轨与画面层都没静音（两路声音叠在一起，听着只是"更响"）、
    // 导出侧忘了展开（成片里那段是黑的，时间线上却好好摆着）。
    // 所以判据两头钉：展开后的片段表逐项对源入点/音量，成片侧**真跑 ffmpeg 读中心像素**
    // —— 0.8 秒必须是第 1 路的红、3.0 秒必须是第 2 路的蓝，并且把切换点挪到 3 秒后
    // 2.0 秒处必须仍然是红（证明颜色由切换点决定，不是素材碰巧那样）。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 69,
    marker: /MULTICAM_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'region',
    name: '自检 + 真导出·时间区域（规范化 / 裁剪入点 / 曲线子区间 / ripple 删除 / 复制粘贴 / 只导出区间）',
    argv: [NODE, 'tools/check-region.mjs'],
    // 稳定数字 75 = 规格 10 + 切一刀 13 + 曲线 6 + 删除 18 + 复制粘贴 10 + 只导出 9 + 真导出 9。
    //
    // 这块的错法全是"不报错"的：右残段忘了按 ripple 前移（留一个空洞）、
    // 切曲线片段时把整条曲线原样搬给残段（速度分布整个变形）、
    // 倒放片段的残段入点取错端点（从另一个位置开始播，甚至越界变黑）、
    // 导出侧「只导出区域」没接上（面板上选了、成片还是整条）。
    // 判据两头钉：片段表逐项对 start / duration / offset / 子曲线，
    // 成片侧**真跑 ffmpeg 读中心像素** —— 区间 [1,3) 的成片必须 2 秒，
    // 0.4 秒红、1.6 秒蓝，并与"手工把这段拖到 0"的对照组同色。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 75,
    marker: /REGION_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'region-e2e',
    name: '客户端 E2E（时间区域：Shift 拖动框选 / 复制粘贴 / 只导出面板 / 删除前移 / I O 键 / Shift+Delete）',
    argv: [NODE, 'tools/region-e2e.mjs'],
    // 稳定数字 25。这一族测的是"界面到算术之间"那几根线：
    //   ① Shift+拖动没接上（拖完没反应）② 区域画出来了但工具栏没出现
    //   ③ 复制了不让粘贴 ④ 导出面板不知道有区间 ⑤ 删除只删内容不前移。
    // 判据取消费端：.wb-region 上真实写出的秒数、片段卡片的 DOM 数与几何（px/46=秒）、
    // 导出面板的 aria-pressed 与成片时长。
    expected: 25,
    marker: /REGION_E2E_OK/,
    count: /REGION_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'recorder-e2e',
    name: '客户端 E2E（录音配音：假麦克风 / 电平条 / 计时器 / 真落盘 / 落点在播放头）',
    argv: [NODE, 'tools/recorder-e2e.mjs'],
    // 稳定数字 16。这一族测的是「点下去到底发生了什么」：
    //   ① 权限闸没放开 ⇒ getUserMedia 抛错，界面只是弹一句（或什么都不弹）
    //   ② 录到了但没落盘 ⇒ 时间线上多一根看不见的细线，重开草稿就没了
    //   ③ 落了盘但没进 yjai-media:// 白名单 ⇒ 卡片画得好好的，播放无声
    //   ④ 落点写在轨道末尾而不是播放头 ⇒ "对着画面说"根本不成立
    // 判据取消费端且**跨进程**：DOM 读 data-rec-phase / 计时器 / 电平格 / 音频轨片段几何
    // （px/46=秒），磁盘读 `<userData>/recordings` 下真有 >5KB 的文件。
    // ⚠️ 假麦克风只开 use-fake-device 时轨道是**纯静音**，电平条恒 0 格；
    //    必须配 `--use-file-for-fake-audio-capture=<wav>`（脚本每次现造 440Hz 正弦波），
    //    否则"电平条没接"和"环境本来没声音"分不开 —— 这种假红/漏检都极难查。
    expected: 16,
    marker: /RECORDER_E2E_OK/,
    count: /RECORDER_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'layer-order',
    name: '自检 + 真导出·画面层级（自由层级：层号规格 / 比较器 / 上移下移重编号 / 成片谁压住谁）',
    argv: [NODE, 'tools/check-layer-order.mjs'],
    // 稳定数字 37 = 层号规格 8 + 比较器 7 + 上移下移 9 + 预览排序 3 + 真导出 10。
    //
    // 这一块的错全都不报错，而且两头都可能错：层号只落在数据里、预览不按它排
    // （点了没反应）；预览排了、导出不排（预览里 A 压住 B，成片里 B 压住 A）；
    // 「上移一层」写成 `z += 1`（两段同 z 时点了毫无反应）；老草稿缺 z 处理错
    // （所有历史项目的层叠顺序整体变掉）。
    // 判据三层：纯算术 + composite.layerOrder 排序 + **真跑 ffmpeg 读中心像素**
    // （红/蓝两层画中画铺满中央，谁在上由中心像素的 RGB 直接回答）。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 37,
    marker: /LAYER_ORDER_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'layer-e2e',
    name: '客户端 E2E（画面层级：右键上移/下移 / 置灰跟着真实层号 / 主轨不许调 / 落草稿）',
    argv: [NODE, 'tools/layer-e2e.mjs'],
    // 稳定数字 12。只测「界面到算术之间」的几根线：菜单点了有没有写回 clips、
    // 该置灰的有没有置灰、主轨（顺序链）上那两个项是不是也被误开、层号有没有落进草稿。
    // 判据取消费端：时间线片段上的 data-clip-z 真实数值、菜单项的 disabled、磁盘草稿 JSON 的 z。
    expected: 12,
    marker: /LAYER_E2E_OK/,
    count: /LAYER_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'scenes',
    name: '自检 + 真检测·场景切换（解析 pts/scene_score / 入点与倍速换算 / 去噪 / 切片守恒 / 真跑 ffmpeg）',
    argv: [NODE, 'tools/check-scenes.mjs'],
    // 稳定数字 40 = 解析 6 + 支持范围 4 + 换算 10 + 切片 7 + 真检测 8 + 夹具 1 + 阈值/空片 4。
    //
    // 这一块的错都表现为"切得出来、看着差不多"：pts_time 是源文件绝对秒（漏减入点就整体偏移）、
    // 漏除倍速（2 倍速下每个切点偏一半）、不做过近过滤（切出一串 0.0x 秒的碎段）、
    // 切片不复用 region 的算术（曲线片段残段速度分布整个变掉）。
    // 判据：解析真 ffmpeg 输出格式 + 换算逐项对数字 + **真跑 ffmpeg** 检测红/蓝/绿三段的切点
    // 落在 1s / 2s 附近，并用阈值 0.9 反向验证"阈值真的喂进去了"。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 40,
    marker: /SCENES_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'proxy',
    name: '自检 + 真转码·预览画质（档位表 / 规范化 / 代理命名 / 缩放滤镜 / 真生成 540p 且不放大）',
    argv: [NODE, 'tools/check-proxy.mjs'],
    // 稳定数字 28 = 档位表 6 + 规范化 5 + 命名 6 + 缩放滤镜 4 + 真生成 7。
    //
    // 这一块的错全都是"点了什么都没发生"或"看着像成了、其实方向错了"：
    //   · 档位名与界面文案对不上 ⇒ 设置里写着 540p，heightFor 却给 0（预览根本没换文件）；
    //   · 不认识的档位回落成 `undefined` 而不是 `full` ⇒ 神秘地变糊，用户以为素材坏了；
    //   · 代理文件名不带高度 ⇒ 切档位时复用上一档的旧代理（画面糊着，档位显示完整）；
    //   · 缩放写成 `scale=-2:H` ⇒ 480p 源被插值**放大**到 540p，更糊更慢，
    //     而用户以为自己开了"画质增强"；
    //   · 无音轨源转代理失败 ⇒ 静默回落原片（成片没问题，只是预览一直卡）。
    // 判据：纯算术逐项对数字 + **真跑 ffmpeg** 生成代理，用 ffprobe 读高度与像素数，
    // 并反验"源比目标矮时不放大"。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 28,
    marker: /PROXY_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'proxy-e2e',
    name: '客户端 E2E（预览画质：设置三档 → 真生成代理 → 预览换文件 / 导出仍用原片 / 切回即复原）',
    argv: [NODE, 'tools/proxy-e2e.mjs'],
    // 稳定数字 13。验的是"设置 → ffmpeg → 预览取哪个文件"这条链，外加一条**反向不变式**：
    //   · 代理目录一开始是空的（不做"打开草稿就整库转一遍"，20 段素材要等 10 分钟）；
    //   · 切到 540p 后 `<video>` 的 src 真的指向 proxies 目录（不是"设置里写着 540p"）；
    //   · 草稿 JSON 里的 path 从头到尾仍是原片 —— 导出读它，结构上就碰不到代理；
    //   · 切回「完整」预览立刻回原片（不是"要重启才生效"）。
    // ⚠️ 判据必须解码 src 反推路径再比，字符串里出现 "proxies" 也可能是巧合。
    expected: 13,
    marker: /PROXY_E2E_OK/,
    count: /PROXY_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'pack',
    name: '契约 + 真 ZIP·素材包（收集三种藏法 / 双向改写 / CRC 标准 / 外部解压器核对 / zip-slip）',
    argv: [NODE, 'tools/check-pack.mjs'],
    // 稳定数字 54 = 文件名与路径 5 + 收集引用 6 + 双向改写 9 + 清单 7 + 真 ZIP 6
    //   + 外部解压器 3 + zip-slip 1 + export/import 全链路 17。
    //
    // 这一族错全是"包打出来了、也解开了，但里面是错的"：
    //   · 漏收复合片段的孩子 / 多机位的机位文件 ⇒ 对面那几段黑屏；
    //   · 只改 path 不清 url ⇒ 对面读**我这台机器**的绝对路径（白名单恰好登记过，时好时坏）；
    //   · CRC32 或中央目录偏移写错 ⇒ 我们自己读没问题，7-Zip 报「CRC 校验失败」；
    //   · 解包不挡 `../` ⇒ 恶意包能往包外写文件（zip-slip）。
    // 判据三层：纯算术 → 自己写读往返 → **Windows Expand-Archive 独立解一遍**
    // （换一套完全不同的实现，才真正证明"这是标准 ZIP"）。
    expected: 54,
    marker: /PACK_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'pack-e2e',
    name: '客户端 E2E（素材包：菜单 → 真打包 → 真解包 → 打开新草稿 → 预览指向解出来的文件）',
    argv: [NODE, 'tools/pack-e2e.mjs'],
    // 稳定数字 15。纯逻辑那道证明"算术对"，这一道证明「界面上点得到、点下去真发生」——
    // `onExportPack` 忘了接到 TopBar 上，纯逻辑照样全绿。
    // 关键判据：包内 draft.json 的 path 是 `media/...` 且 url 为空；
    //           导入后**预览 `<video>` 的 src 解码后落在 `<userData>/packs/`**；
    //           反向：本机原草稿的 path 全程没被改动。
    // ⚠️ 原生对话框必须打桩（真弹框 = 用例永久卡住），打桩要等页面起来之后再打。
    expected: 15,
    marker: /PACK_E2E_OK/,
    count: /PACK_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'hdr',
    name: '契约 + 真转码·HDR（只认 color_transfer / 滤镜串成分 / 计划里只有 HDR 才有 tonemap / 真像素变化）',
    argv: [NODE, 'tools/check-hdr.mjs'],
    // 稳定数字 33 = 判据 9 + 滤镜串 9 + 计划 6 + 真渲染 9。
    //
    // 这一族的错全都"尺寸/时长/帧率正确，只有颜色错"：
    //   · 不转 ⇒ 超白被裁成死白；转了但排在调色之后 ⇒ 调色按 HDR 亮度算，整体偏色；
    //   · 转了不改输出标签 ⇒ 像素是 SDR、文件还标 HDR，**别人那儿发灰**（本机复现不出来）；
    //   · 给 SDR 也转 ⇒ 老工程成片颜色整体变掉，且没有任何迹象指向这一步。
    // 判据三层：纯规则 → buildPlan 的滤镜图（HDR 才有 / SDR 一个字都不多）→
    // **真渲染两份同像素不同标签的片子，用信号统计证明画面真的变了**。
    // ⚠️ 判据不带方向：实测 PQ 映射后**变亮**（134 vs 124），HLG 几乎不动（0.2）——
    //    早先按"一定变暗"写，红的是尺子。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 33,
    marker: /HDR_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'warp',
    name: '契约 + 真渲染·自由变形（单应矩阵 / 角顺序TL-TR-BL-BR / 框外透明 / transform 顺序）',
    argv: [NODE, 'tools/check-warp.mjs'],
    // 稳定数字 37 = 参数 3 + 中性 3 + 四角 2 + 单应 2 + 退化 3 + CSS 4 + perspective 4
    //               + 计划 2 + 真渲染 5 + 静态 9（含预览四角手柄的 4 条）。
    //
    // 这一族的错全都"看起来像生效了"，错在几何本身：
    //   · 角顺序按顺时针传 ⇒ 左右镜像；四角对称的夹具**完全看不出来**，所以夹具是四象限彩图；
    //   · 只变形不补 alpha ⇒ 框外是 perspective 的边缘 clamp（一圈被拉长的像素）；
    //   · `anyTransparent` 漏掉 warp ⇒ 链落回 yuv420p，补好的 alpha 被整体丢弃；
    //   · CSS matrix3d 没拿到元素像素尺寸 ⇒ 窗口一缩放透视就歪；
    //   · 预览拖角点反解了含 warp 的整串矩阵 ⇒ 换算到"变形之前"的坐标，越拖越偏。
    // 本机没有 ffmpeg 时退出码 2（verify 记为 SKIP，不假装通过）。
    expected: 37,
    marker: /WARP_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'fx-styles',
    name: '契约 + 真渲染·描边四样式与内阴影（层次表 / 虚线断口 / 内阴影落差 / 防回退接线）',
    argv: [NODE, 'tools/check-fx-styles.mjs'],
    // 稳定数字 33 = 描边规则 8 + 阴影互斥 2 + 预览导出同源 7 + 真渲染 12 + 静态 7（含 3 条对照/多段）。
    //
    // 这一族的错是"代码接上了、成片一个像素没变、ffmpeg 不报错"。本轮真踩到四种：
    //   ① 内阴影把阴影图当 overlay 的**底图** ⇒ 被不透明画面整层盖掉；
    //   ② 内阴影用"线性场 + σ13 模糊" ⇒ 20px 带子平均成 3/255，看着像没开；
    //   ③ 双线第二圈接着第一圈的**结果**算 alpha ⇒ 环往外长，双线变粗边；
    //   ④ 虚线 `onH*inDashX` 少括号 ⇒ 上边恒亮，虚线退化成实线。
    // 每条都有对应的像素判据，不是靠"代码看着对"。
    expected: 33,
    marker: /FXSTYLE_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'ui-spec',
    name: '静态·界面规格（设计令牌被真的消费 / 状态三态 / 主按钮唯一 / 图标尺寸显式）',
    argv: [NODE, 'tools/check-ui-spec.mjs'],
    // 稳定数字 14 = 令牌定义 1 + 消费 4 + 状态层 4 + 主按钮 3 + 图标 2。
    //
    // 这一族全是"构建通过、静态扫描也过、只有盯着看才发现"的错：
    //   · 令牌定义了没人用 ⇒ 字号仍在 9/10/11/12/13/15 六个值上散着；
    //   · 选中态只改字色 ⇒ 深底上整排标签看着一样平；
    //   · 选中亮条写成真 border ⇒ 选中那枚比旁边高二像素，整排不齐；
    //   · 主按钮与次级按钮都带底板 ⇒ 一屏里三个"最重要"；
    //   · 禁用态用 opacity ⇒ 底板与字形一起偏色（实测把峰值从 123 抬到 141）。
    // 判据取**级联后最终生效值**，不取"某个块里有没有 var()"。
    expected: 14,
    marker: /UISPEC_OK/,
    count: /通过\s*(?<p>\d+)\s*项\s*\/\s*失败\s*(?<f>\d+)\s*项/
  },
  {
    id: 'hdr-e2e',
    name: '客户端 E2E（HDR 标注：真 HLG 文件 → IPC 结论 → 右栏那一行 / SDR 不许假标注）',
    argv: [NODE, 'tools/hdr-e2e.mjs'],
    // 稳定数字 12。check-hdr 证明"导出真的转了"，这一道证明「界面真的说出来了」：
    // 主进程探到 HLG、IPC 通了、右栏渲染出那一行 —— 三处缺一处，
    // 用户还是"看着发灰不知道为啥"（第③类"接对了看不见"）。
    // 反向判据同样重要：SDR 素材必须**没有**这一行，否则等于给所有素材贴假标签。
    expected: 12,
    marker: /HDR_E2E_OK/,
    count: /HDR_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'scenes-e2e',
    name: '客户端 E2E（按场景分割：右键 → 真 ffmpeg 检测 → 时间线切成三段且首尾相接 → 落盘）',
    argv: [NODE, 'tools/scenes-e2e.mjs'],
    // 稳定数字 11。验的是「界面到 ffmpeg 之间」那条链：菜单项点了有没有接上、
    // 切点有没有换算（切歪了不报错）、切完总时长有没有变、有没有落草稿。
    // 判据取消费端：片段卡片的 DOM 数与几何（px ÷ 46 = 秒）、草稿 JSON 的片段数。
    expected: 11,
    marker: /SCENES_E2E_OK/,
    count: /SCENES_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'multicam-e2e',
    name: '客户端 E2E（多机位：Ctrl 多选 / 右键建多机位 / 检查器切角 / 数字键切角 / 预览换画面 / 取声 / 解除）',
    argv: [NODE, 'tools/multicam-e2e.mjs'],
    // 稳定数字 23。这一族测的是"界面到算术之间的那几根线"：
    //   ① Ctrl 多选没进集合 ⇒ 菜单项一直禁用 ② 建好后预览没展开 ⇒ 画面黑掉
    //   ③ 点机位按钮只改面板、没写回片段 ⇒ 高亮变了画面没变 ④ 数字键没接
    //   ⑤ 解除后片段数不对。
    // 判据取消费端：时间线片段数与角标、预览主层的 data-layer（`父id~m<机位>_<起点>`）、
    // 检查器按钮的 aria-pressed。
    expected: 23,
    marker: /MULTICAM_E2E_OK/,
    count: /MULTICAM_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'preview-select',
    name: '客户端 E2E（预览直接操作：点选 / 拖移 / 四角缩放 / 双击复位 / 吸附辅助线 / 特效只动内容）',
    argv: [NODE, 'tools/preview-select-e2e.mjs'],
    // 稳定数字 19。这一族全是"看着有、其实没接"的高危区：
    //   ① 选框画出来但拖动不写数据 ② 写了但没写进导出用的字段
    //   ③ 吸附算错方向（只吸前缘） ④ 画面特效挂在画框上（圆角/阴影跟着抖，成片里却没有画框）
    // 判据取消费端：右栏数值、画布的内联 transform 矩阵、animation-name 挂在哪一层、
    //   片段左边界与播放头的**像素**差。
    expected: 19,
    marker: /PREVIEW_SELECT_OK/,
    count: /PREVIEW_SELECT_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'curve-speed',
    name: '客户端 E2E（曲线变速：预设 / 拖点 / 时间线占位 / preview playbackRate / 按标记卡点）',
    argv: [NODE, 'tools/curve-speed-e2e.mjs'],
    // 稳定数字 24。这道是曲线变速唯一的**行为级**证据 —— 三件事任意一件没接上都
    // 不报错、不黑屏：① 编辑器只是装饰（拖了没写数据）② 时间线占位没跟着面积走
    // ③ 预览只换源时间不换 playbackRate（起点对、越播越歪）。
    // 判据全部取消费端：clip-dur 文本、SVG path 的 d 串、面板上的「平均倍速」
    // 与真源算出的面积是否相等、`<video>.playbackRate` 是否等于 curveAt(p)。
    expected: 24,
    marker: /CURVE_SPEED_OK/,
    count: /CURVE_SPEED_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/,
    timeoutMs: 6 * 60 * 1000
  },
  {
    id: 'home',
    name: '客户端 E2E（首页入口逐个点，全部通向真实去处）',
    argv: [NODE, 'tools/home-entries-e2e.mjs'],
    // 稳定数字 20 = 8(骨架 · 含"启动不许有账号闸门") + 7(工具卡逐个点) + 5(本地页与收尾)。
    // 找不到 electron 或中途出错时逐条补成 SKIP，总数守恒。
    // 这道闸门专治"入口都在、样式都对、点下去也跳转了，但落的是一个空壳面板"——
    // 这类缺陷不报错、不让构建变红，只有真点一遍才发现。
    // 开源版没有账号：第 2 条断言（启动后不许有遮罩/弹窗）就是为此而设 ——
    //   任何账号闸门在这版里的正确行为是**不存在**。
    // 需要真机 Electron（要真的点开每个入口），所以标 needsElectron。
    expected: 20,
    marker: /HOME_E2E_OK/,
    count: /HOME_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/,
    // 单独调小墙钟上限（默认 20 分钟）：这道闸门的断言实测 1 分钟内就跑完
    // （2026-09-22：进程 23:09:12 起、23:09:21 就把 22 条全打完了），
    // 剩下的全是收尾 —— 而收尾有过"同步调用堵死主线程、10 分半不返回"的实录。
    // 配合上面的 salvage 分支，这种堵法现在是「4 分钟后按有效记账」，
    // 而不是「20 分钟后判失败」。调小不调大：调大只会掩盖卡住的事实。
    timeoutMs: 4 * 60 * 1000
  },
  {
    id: 'art-consumed',
    name: '界面·配图有没有真的被用上（孤儿素材 / 导了不用）',
    argv: [NODE, 'tools/check-art-consumed.mjs'],
    // 稳定数字 3：① 防空转（素材与导入都真扫到）② 无孤儿素材 ③ 无"导了不用"。
    //
    // 为什么条数只有 3：这三条**都是汇总判据**，失败时 detail 里逐条列出是哪几张图
    // （而不是"每张图一条断言"）。理由是素材数会随正常改动增长 —— 那种数字该用
    // `minExpected` 表达下界，与其如此，不如让断言数恒定、把"哪些图"放进 detail。
    //
    // 这道闸门治的是「导图只导了一半」的两种形态，两种都静默：
    //   ① 孤儿素材 —— 文件进了仓库，没人 import ⇒ 磁盘上有、界面上永远看不到。
    //      占位清单只管文件在不在/指纹对不对，`check-imports` 只管"导入的路径能不能解析"，
    //      两者对"没人导入"都无话可说。
    //   ② 导了不用 —— Rollup 直接 tree-shake：**构建成功、产物里没有这张图、
    //      界面一片空白、日志 0 warning**。与 check-imports 治的"少写一个 import"互为镜像。
    //
    // ⚠️ 判据 ② 是启发式（"正文里至少出现 1 次"），不是数据流分析：`export default artX`
    //    这种转手导出会被算作"用了"。界线刻意划在"**有没有写使用点**"上 ——
    //    "用了但用错了"归 workbench-tabs / workbench-buttons 那两道真点一遍的闸门。
    expected: 3,
    marker: /REF_ART_CONSUMED_OK/,
    count: /REF_ART_CONSUMED_STATS\s+ok=(?<p>\d+)\s+total=(?<t>\d+)\s+problems=(?<f>\d+)/
  },
  {
    id: 'art-consumed-selftest',
    name: '自证·配图消费点看门狗本身会说「不」（合成夹具正反两面）',
    argv: [NODE, 'tools/check-art-consumed.mjs', '--selftest'],
    // 稳定数字 4。
    //
    // 这道自证存在的直接理由：**它第一次跑就抓出了上面那道闸门的一个真 bug**。
    // 原判据是"标识符在**全文件**里出现 ≥2 次"，而夹具写的短名 `b` 会命中
    // 导入路径 `'.../good/b.png'` 里那个 `b`（前后都是非单词字符）⇒ 只有声明、
    // 正文一次没用也算"用过" = **这条检测恒绿**。
    // 真仓里因为标识符都起得长（`artLimitAudio`）恰好没暴露 —— 也就是说：
    // 不写这个夹具，这道闸门会一直绿着、什么都不查。
    // ⇒ 夹具里的标识符**故意用短名**（a / b），就是为了让"路径里的字符被算进来"暴露出来。
    // 断言：孤儿被报出 / 导了不用被报出 / 扫描器数到夹具的量（防空转）/ 控制组 3-3 通过。
    expected: 4,
    marker: /REF_ART_CONSUMED_SELFTEST_OK/,
    count: /REF_ART_CONSUMED_SELFTEST\s+pass=(?<p>\d+)\s+total=(?<t>\d+)/
  },
  {
    id: 'gen-script-guard',
    name: '工具链·生成的 Electron 脚本有没有在出门前验过语法（防静默吊死 + 弹框给用户）',
    argv: [NODE, 'tools/check-gen-script-guard.mjs'],
    // 稳定数字 5：① 防空转（两个生成器都真读到、各自都在做那两件事）
    // ② 都接了守卫 ③ 次序对且会早退 ④⑤ 两个生成器 **--gen-only 真跑**的产物语法通过。
    // （③④⑤ 里 ④⑤ 可能因前置输入缺失逐条记 SKIP —— **总数不变**，
    //   这是本项目表达"环境差异"的固定做法，否则"这台机器缺输入"与"有人删了断言"分不出来。）
    //
    // 为什么这道闸门必须存在（2026-09-24，Jason 发来一张 Electron 弹窗截图）：
    //   `tools/shoot-ref-images.mjs` 把主进程入口脚本当**模板字符串**生成到
    //   `_recon/.ref-img-main.cjs`，再让 electron.exe 执行。模板里那段 `try {` 曾漏写 `catch`
    //   ⇒ 生成物本身是语法错。后果两层，两层都踩过：
    //     · 父进程：Electron 加载失败后不打退出码也不退出，spawnSync 又没超时 ⇒
    //       **静默吊死 4 分钟**，现场症状是"跑导出没有任何输出、目录是空的"。
    //     · 用户：Electron 主进程 load 失败会弹系统模态框（路径 + SyntaxError）——
    //       **那个框是弹给用户看的**，而用户无从修起。
    //   触发条件是"模板被编辑坏"，本仓库已踩过两次（往模板注释里混进反引号）。
    //   这类坏法**构建全绿、类型全绿、界面上什么都不显示**，只有跑起来才知道 ——
    //   所以它必须被判在**生成侧**。
    //
    // 判据刻意验**真实产物**（--gen-only 真跑表里的生成器），不在闸门里复制一份模板来验：
    //   复制品必然各自演化，然后其中一份静默失守（教训写在 tools/lib/source-scan.mjs 文件头）。
    //
    // 5 → 4（开源版）：`shoot-ref-images.mjs`（取第三方位图出联络表）随那一版素材
    //   一起删了，生成器表从 2 个变 1 个，少掉的那条是"它的产物真被重写且语法通过"。
    //   数字变小是**功能被移除**，不是断言被删 —— 与"数字凭空变小一律是危险信号"
    //   那条约定不冲突，因为这里能指名是哪一项没了。
    expected: 4,
    marker: /GEN_SCRIPT_GUARD_OK/,
    count: /GEN_SCRIPT_GUARD_STATS\s+ok=(?<p>\d+)\s+total=(?<t>\d+)\s+problems=(?<f>\d+)/
  },
  {
    id: 'gen-script-guard-selftest',
    name: '自证·语法守卫本身会说「不」，且不冤枉好人（行号也必须是真的）',
    argv: [NODE, 'tools/check-gen-script-guard.mjs', '--selftest'],
    // 稳定数字 5：① 合法样本判通过（控制组）② 那次"制造残缺"真的生效（防空转）
    // ③ 残缺样本被判错且错点指向 catch ④ 报出的行号与源码行自洽 ⑤ 补回去重新判通过。
    //
    // 为什么必须单独自证：这道守卫如果**恒绿**（永远返回 null），上面那道闸门会全绿、
    // 而实际保护为零 —— 那正是它出生第一天的处境（模板里的 catch 曾经就是漏的）。
    // ② 是这类自证的命门：夹具靠"删掉一行"造残缺，若 indexOf 没找到或 filter 写错，
    // 坏样本会退化成好样本，③④ 随之恒绿。所以要先断言"try 有 1 个、catch 有 0 个"。
    // ④ 单列一条是因为本仓踩过"剥注释压掉换行 ⇒ 报出的行号指向不存在的行"——
    // 行号是假的比没有行号更坏，人会照着去改另一行。
    expected: 5,
    marker: /GEN_SCRIPT_GUARD_SELFTEST_OK/,
    count: /GEN_SCRIPT_GUARD_SELFTEST\s+pass=(?<p>\d+)\s+total=(?<t>\d+)/
  },
  {
    id: 'card-specs',
    name: '界面·素材卡片规格（各标签中栏排版与参考 QML 逐项对齐）',
    argv: [NODE, 'tools/check-card-specs.mjs'],
    // 稳定数字 20 = ① 防空转（九个功能标签都在）② 静态契约（视频增强的前后对比线
    //   只许挂在 .enh-grid.is-enhance 下）③ 滤镜 6 条 ④ 转场 6 条 ⑤ 背景 5 条
    //   ⑥ 全程 0 个 pageerror。
    //   背景那组少 1 条是因为**内边距不判**（参考的上/左内边距来自页面自己的 8px 空矩形，
    //   我们的来自 `.pane-body`，要对齐得动中栏外壳，那是另一批活）—— 不是漏了一条。
    //
    // 为什么必须存在：这是"排版与参考一致"这句要求里，**唯一能自动判的部分**。
    //   截图看不出卡片宽 100 还是 98、列距 16 还是 15、卡片该不该有名字行 ——
    //   而这三类恰好都是本项目的常客（`* { box-sizing: border-box }` 让 1px 边框
    //   从内容盒里吃掉 2px；`minmax(84px,1fr)` 把固定列宽拉成自适应）。
    //   判据里的 100/122/130/75/16 **全部抄自参考的 .qml 原文**（出处逐条写在脚本里），
    //   不是我们自己测出来再钉死的数字 —— 钉子必须钉在参考那一侧才有意义。
    //
    // 为什么量真实 DOM 而不是读 CSS 文本：读 CSS 只能证明"有人写了 100px"，
    //   证明不了最终生效的是它（本项目踩过 `display:block!important` 盖掉门控）。
    //   这里量的是 getBoundingClientRect()，与用户看到的盒子同源。
    expected: 20,
    marker: /CARD_SPECS_OK/,
    count: /CARD_SPECS_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'card-specs-selftest',
    name: '自证·卡片规格判据可分辨（正控制组全绿 · 每条扰动红在对的断言上）',
    argv: [NODE, 'tools/check-card-specs.mjs', '--selftest'],
    // 稳定数字 33 = 3 条全局（id 不重复 / 每项写明数字出处 / 每项写明名字行选择器）
    //   + 4 条静态契约判据（收窄后通过 / 裸规则不通过 / 规则整个消失不通过 / 收窄+裸混写不通过）
    //   + 滤镜 9（1 正控制组 + 8 条扰动）+ 转场 9 + 背景 8（1 + 7，少的那条是没有内边距扰动）。
    //
    // 为什么必须单独自证：这道闸门的判据是"数字比对"，它的坏法几乎从不抛异常，
    //   而是**判据写在错的字段上**（拿 columnGap 去比行距）或者**判断了元素**
    //   （名字行的类名逐族不同：滤镜/转场是 `.look-name`，配图族是 `.enh-name`）——
    //   两种都会让它永远绿，或者永远红在别处。
    //   本自证第一次跑就抓出了两条真问题：
    //     ① 名字行选择器写死了 `.enh-name` ⇒ 背景"恰好"通过、滤镜/转场报"名字行 0 个"
    //        （看着像界面缺了名字，其实是判据选错了元素）；
    //     ② "卡片宽 -2"只改卡片、不改预览图，结果「图铺满卡片宽」那条也跟着红 ——
    //        弄清了那不是误报（那条本来就是卡与图的**交叉校验**），
    //        于是把扰动改成"卡与图一起窄 2px"，两条控制组各测一件事。
    //   ⇒ 判据的判据只有真的跑起来才有意义。
    expected: 33,
    marker: /CARD_SPECS_SELFTEST_OK/,
    count: /CARD_SPECS_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'workbench-tree',
    name: '界面·左栏功能树（每项都有去向 · 面板名可解析 · 落点不是占位面板）',
    argv: [NODE, 'tools/check-workbench-tree.mjs'],
    // 稳定数字 46 = 9（全局）+ 37（左栏**节点**一项一条）。
    // **左栏加减节点就要同步改这个数字。**
    //
    // 这道闸门兑现的是 AssetTree.jsx 头部注释里早就写下的承诺
    // （"所以由 tools/check-workbench-tree.mjs 断言：除明确的通用项外，每项必须有去向"）
    // —— 注释里点名了一个不存在的脚本，比不写还糟。
    //
    // 它治的是"功能标签点进去没东西"这一类**构建全绿、只有手指能发现**的缺陷：
    //   ① 左栏项既没有 `caps` 也没有 `panel` ⇒ 点了没反应（死入口）；
    //   ② `panel` 名 SidePanels 认不出来（拼错 / 改名只改了一半）⇒ 中间栏只显示
    //      「左侧选一个功能开始」的空壳；
    //   ③ `caps` 里写了不存在的能力码，或写成连字符形式 ⇒ 那个入口永远筛不出素材；
    //   ④ `caps` 引用不存在的组 ⇒ 运行期取 `.codes` 直接抛；
    //   ⑤ 图标没从 icons.jsx 导出 ⇒ 那一格是空白，功能名和图标对不上；
    //   ⑥ **标签落在一个写着"尚未接入"的占位面板上** —— 真的发生过：`素材` 标签
    //      的落点曾是「录制」，导入完素材中间栏显示的是"还没做"的说明。
    //
    // 40 → 46（2026-09-23）：左栏改成**手风琴**（参考实测：根卡片与图标卡片都能展开，
    //   一次只展一组），于是多了 10 个"会渲染成行"的节点（根卡片的 5 个子项 +
    //   「视频增强」的 5 个子项），子项同样要有去向，一条都不能少：
    //     · 节点数从"只数 items"改成"items + 根卡片子项 + 一级项的子项"；
    //     · 子项的新落点轴是 `enhance: <组名>`（中间栏换成增强预设画廊），
    //       它既不是 panel 也不是 caps，所以补了全局 8/9 —— 与 enhancePresets 的
    //       ENHANCE_GROUPS **双向**集合相等（少了入口 = 预设有、图有、就是看不到；
    //       多了组名 = 画廊空着，不抛错、不影响构建，最像"点了没反应"）。
    //
    // ⚠️ 反空洞约定：⑥ 天生容易恒真（占位面板一个都认不出来就永远绿），所以
    // 检查器在识别到 0 个占位面板时会**主动报错**，逼人去改断言而不是留着假绿。
    // 新增的 `enhance` 那条同样带空转判据（组或节点解析到 0 个就报错）。
    // children 的**解析不到**也是一种失败（不能静默当成"没有子项"）——
    // 实测：把它写成推导式之后，5 个子项在检查器眼里一个都不存在，整片看门狗无声消失。
    //
    // 46 → 47（2026-09-23）：全局断言 9 → 10，新增「配图族入口」。节点数没变，
    // 加的是全局那一条。判据与防空转见自证那条的注释。
    //
    // 47 → 48（2026-09-24）：左栏新增 `background`（参考「素材 → 背景」页，见
    // `AssetTree.jsx` 的 media.root.children），节点 37 → 38。**这就是"左栏加减节点
    // 就要同步改这个数字"那条约定生效的一次** —— 闸门当场报 47≠48，没有静默放过。
    //
    // 48 → 80（2026-09-24 下午）：转场/滤镜/特效三标签的左栏换成**参考分组树**
    // （素材缓存逐组提取，11 + 14 + 10 组；另有 色彩匹配/音频效果/画面清理 3 项），
    // 节点 38 → 70（= 10 全局 + 70 节点）。参考没有的「基础转场/动态转场/
    // 基础滤镜/风格色调」四张自创卡随之删除。
    //
    // 80 → 118（2026-09-25）：按 `_evidence/comparison/01-左栏结构对照.md` 补齐五页 ——
    // 数字人（+5）、文字/花字（+8）、字幕（+5）、音频（+5）、贴纸（+10）、
    // 素材库四个子项（+4，其中「背景」从素材根**下移**过来），节点 70 → 108。
    // 同时新增 `kinds` 筛选轴（视频库/图片库/动画库），检查器的"有没有去向"判据
    // 必须一并认它，否则这三项会被误报成死入口。
    //
    // 119 → 70（开源版）：10 条全局断言照旧，**左栏节点从 109 掉到 60** ——
    //   数字人页与素材(贴纸)页整页删除，媒体页去掉生成结果 / 下载 / 角色 / 五个 AI 项，
    //   音频页去掉克隆 / 变声 / AI 音乐，特效页去掉音频效果与画面清理。
    //   同一轮里三条判据按"功能已移除"改了口径（不是放宽）：
    //     · 能力码表与增强预设表**不再要求必须在位**（`capabilityMeta.js` /
    //       `enhancePresets.js` 已删）；表与入口**同时为空**才合法，只有一边出现就照旧判红；
    //     · 配图族只认「被左栏节点点名」这一条挂载路径 —— 能力卡片区已经不存在，
    //       再要求它有样本只会假红；
    //     · 标签下界 8 → 7。
    expected: 75,
    marker: /WORKBENCH_TREE_CHECK_OK/,
    count: /WORKBENCH_TREE_CHECK_STATS\s+ok=(?<p>\d+)\s+total=(?<t>\d+)\s+problems=(?<f>\d+)/
  },
  {
    id: 'workbench-tree-selftest',
    name: '自证·左栏功能树看门狗本身会说「不」（合成夹具正反两面）',
    argv: [NODE, 'tools/check-workbench-tree.mjs', '--selftest'],
    // 稳定数字 18。总数由脚本内 check() 自己累加。
    // 这个脚本第一版真实数据 4 类报错里**有 3 类是它自己的 bug**，所以夹具必须
    // 把每条失败分支都真的触发一遍：死入口 / 面板名认不出 / 错能力码 / 键重复 /
    // 图标未导出 / **落点是占位面板** / **占位检测器空转** / 组引用不存在 /
    // 标签没有 items / 文件读不到不崩 / label 为空，外加两条正向（基准夹具必须
    // 0 报错、断言总数必须等于 9+节点数）—— 否则一个恒红的检查器也能骗过上面那些。
    //
    // 13 → 18（2026-09-23）：随左栏手风琴补的三类新分支 + 两条防空洞。
    //   · enhance 拼错组名 / ENHANCE_GROUPS 有组没入口 / enhance 解析空转；
    //   · children 写成推导式 → 必须报出"解析不到"（不能静默为空）；
    //   · 节点数必须把子项算进来（7 + 7 = 14 那条）。
    //
    // ⚠️ 三条踩过的夹具陷阱，都表现为"断言恒绿"：
    //   · "落点是占位面板"的夹具必须让 record **真的成为落点**（默认落点规则是
    //     "先看显式 landing，否则取第一个带 panel 的项"），把 record 拼在一个带
    //     landing 的项前面是没用的；左栏有手风琴之后还多一层：根卡片的子项
    //     「本地」带 landing 且排在前面，夹具必须把根换成**没有子项**的版本；
    //   · "标签没有 items"的夹具靠正则替换造残缺树，标签键是 `tb` 不是 `t b`
    //     （模板字面量里那个空格是缩进），写错则替换静默失效、断言照样绿。
    //
    // 18 → 22 & 46 → 47（2026-09-23，参考配图画廊）：
    //   左栏多了两个落点轴 —— `panel: 'ref-art'` + `refArt: '<族>'`（专属配图面板），
    //   以及 `GroupPanel` 里按 `refArtOf(capability)` 铺的能力卡片区。
    //   全局断言从 9 条变 10 条，新增的那条治的是"配图族的入口"：
    //     · 拼错族名（`imageEnhnace`）→ RefArtPanel 渲染「未找到配图族」，
    //       不抛错、不影响构建，界面上是一块说明文字，看着像"还没做"；
    //     · 族没人挂载（图导了、数据写了、就是走不到）→ 白占安装包。
    //   ⚠️ 判据必须认**两条**挂载路径（被节点点名 / 能力码可达），只认一条会误报：
    //      实测只认①时报出 5 个假错（字幕/口播/图片/视频模型都是走②的）。
    //      同时两条路径**各自**都要有样本，否则这条断言会变成单边恒真。
    //   自证新增 4 条：refArt 拼错 / 族没人挂载 / refArt 挂在非 ref-art 面板（写了没人读）
    //   / 只靠能力码可达、却没有专属面板入口的族（孤儿族防空转）。
    // 22 → 23（2026-09-24）：#10 规则改成"items 与根子项全空才算缺失"（转场/滤镜/特效
    //   的参考分组树全挂根子项，items 空是合法形态），补一条反向用例钉住。
    expected: 23,
    marker: /WORKBENCH_TREE_CHECK_SELFTEST_OK/,
    count: /WORKBENCH_TREE_CHECK_SELFTEST\s+pass=(?<p>\d+)\s+total=(?<t>\d+)/
  },
  {
    id: 'real-film',
    name: '客户端 E2E（真实影片走完整链路：协议 · 解码 · 帧 · 编辑栏）',
    argv: [NODE, 'tools/real-film-e2e.mjs'],
    // 稳定数字 30。
    //
    // 为什么在 media / render / preview-follow 之外还要一道：那三道用的"视频"是
    // ffmpeg 用 `testsrc` 现造的 2 秒 320×240 合成片，只能证明"协议头齐不齐"。
    // 真实影片有四处本质差别，每处都能让功能静默错位：
    //   ① 体积（138MB vs 几十 KB）—— Range 的偏移算术在大文件上才被真正压到；
    //   ② B 帧/稀疏关键帧 —— seek 到非关键帧要回退解码，失败表现为"能拖但画面不动"；
    //   ③ 真音轨 —— 视频 72.933s / 音频 72.911s 这种真实容器的常见形态；
    //   ④ **真实片长** —— 合成片 2 秒，而片段时长缺失时兜底 5 秒
    //      （DEFAULT_CLIP_SECONDS）。2 秒素材被换成 5 秒兜底时两条路算出同一个数、
    //      缺陷隐身；72.93 秒才会把「片段时长 = 素材真实片长」这条不变式压出来。
    // 判据全部是外部真值、不是"看起来对"：时长/分辨率/音轨对 ffprobe，
    // Range 对**磁盘上那 1024 个字节**逐字节比对，真解码靠 requestVideoFrameCallback
    // 的已呈现帧数（与画布是否被污染无关）。
    //
    // ⚠️ marker 放行 SKIPPED：片源与 ffprobe 都在仓库外（本机才有），
    //   找不到时整组 30 条逐条记 SKIP、total 仍是 30。这是刻意的 ——
    //   环境差异必须用 SKIP 表达，否则"这台机器没片源"和"有人把断言删了"
    //   在闸门眼里长得一模一样。跑起来的日志里会写明跳过了哪些、为什么。
    // 这道闸门立竿见影：它第一次真的按下「导入」，就炸出了 App.jsx 里
    //   `setRail('media')` 这个全仓库都不存在的 setter（导入素材成功后立刻
    //   ReferenceError，素材进库了但提示与自动选中全丢）。原来那 6 条覆盖同一路径的
    //   断言一直因为 contextBridge 冻结而 SKIP，从没真跑到过。
    // 30 → 36（2026-09-22）：新增 [组 G] 轨道可视化与点击定位（6 条）——
    //   视频轨抽帧 2 条（≥2 张真解码的帧 + 帧内容互不相同）、音频轨波形 2 条
    //   （波形画布存在 + 画布上确有柱状像素）、单击片段定位播放头 1 条、
    //   拖动片段时播放头不跟着跑 1 条。数字上调的原因是**新增断言**，不是改口径。
    //   为什么挂在这道闸门：只有它手里有**真实影片素材**（能解出真画面、真音轨），
    //   抽帧与波形要有内容可画才有意义 —— 合成片只有 2 秒纯噪点，
    //   "抽到了帧"和"抽到的是同一帧"分不出来。
    // ⚠️ 同一轮还修掉了一个**能力缺口**：组 D 的像素断言长期只能 SKIP，
    //   根因是 yjai-media:// 没声明 corsEnabled ⇒ drawImage 之后画布恒被污染。
    //   补上该声明 + 探针带 crossOrigin="anonymous"（两处缺一不可）之后，组 D
    //   由 SKIP 变成真通过（亮度均值 71.8 / 方差 3527.1，与 ffmpeg 的真值同量级）。
    //   同一处改动也是时间线抽帧能工作的前提 —— 两件事共用一条契约，
    //   不是两个各修各的 bug。
    // 36 → 38（2026-10-08）：组 G 加 2 条「视频片段底部的内嵌音频波形」——
    //   画布画得出来 1 条 + **列高种类 ≥ 4** 1 条。后一条是这条闸的命门：
    //   "有像素"满足不了它，一条等高直条（假数据 / 全 1 数组）画出来也有像素，
    //   只有各列高度不同才证明喝的是 ffmpeg 抽出的真 PCM 起伏。
    expected: 38,
    marker: /REAL_FILM_OK|REAL_FILM_SKIPPED/,
    count: /REAL_FILM_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'dead-buttons',
    name: '界面·按钮去处（渲染层每个 <button> 都要接上处理函数）',
    argv: [NODE, 'tools/check-dead-buttons.mjs'],
    // 稳定数字 5（脚本内固定）。
    //
    // 为什么在 37 道闸门全绿之后还要补这一道：2026-09-23 实测渲染层有 **7 个
    // 「画好了但没接」的按钮**，一个都没被拦住 ——
    //   · 时间线工具栏右侧那一簇：「时间线音量 / 字幕 / 时间线设置 / 全屏时间线」
    //     四个连 onClick 都没有；
    //   · 同簇的「素材库」与「AI 工具」**接错成了导入**（想开素材库，弹出选文件的框）；
    //   · 预览区喇叭键、首页「在线客服」各一个。
    // 这类缺陷的特点：位置/配色/尺寸/hover/禁用态**全对**（那些都是 CSS），
    // 构建通过、像素比对通过、其它 E2E 只点自己关心的按钮 ⇒ 症状只剩「点下去没反应」。
    //
    // ⚠️ 它只管「有没有接」，**管不了「接错到别的动作」**（`onClick={onImport}` 就是
    //   合法属性）。那一半靠 tools/workbench-tabs-e2e.mjs 点完读效果。
    // ⚠️ 反空洞：扫到 0 个 <button> 时"0 个死按钮"恒真，所以第 1、2 条专门钉扫描器
    //   没空转；第 4、5 条拿仓库常驻的合成夹具自证它**会说不**（多报=误报也判红）。
    expected: 5,
    marker: /DEAD_BUTTON_CHECK_OK/,
    count: /DEAD_BUTTON_CHECK_STATS\s+ok=(?<p>\d+)\s+total=(?<t>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'ui-copy',
    name: '界面·文案体检（渲染层不许有 emoji / 装饰符号 / 开发痕迹词）',
    argv: [NODE, 'tools/check-ui-copy.mjs'],
    // 稳定数字 5（脚本内固定）。
    //
    // 为什么补这一道：2026-10-02 全量复查实测，界面上有 **15 处**用彩色 emoji 当 UI 元素
    //   —— 左栏分组树「万圣节 🎃」「最新 🔥」「秋天 🍂」「梗图贴纸 😺」「SFX 贴纸 🎭」，
    //   以及 materials.js 里三张同名分组表的组名。它们**不是参考真源**（参考语言包里
    //   连「万圣节」「秋天」这两个词都没有：素材分组名是服务端下发的纯文本），
    //   是我们自己加的装饰。
    //
    // 这类缺陷为什么只能靠机器盯：
    //   · 功能、构建、类型检查、其它 58 道闸门**全绿** —— 那只是个字符串，
    //     没有任何一行断言"它长什么样"；
    //   · 但一眼看上去就是演示 demo 而不是商业软件：专业剪辑软件不会用彩色表情
    //     当分类标识；
    //   · emoji 字宽与行高和中文不一致，会把逐像素对齐过的行高顶歪；
    //   · 人眼会习惯，代码评审看不见"多了一个表情"。
    //
    // ⚠️ 判据保守：只查字符串字面量 / JSX 文本 / CSS content，注释不算
    //   （本项目注释里大量使用 ⚠️ 与 →）；← → ↑ ↓ 不禁（快捷键提示要用）。
    // ⚠️ 裸「占位」不算痕迹 —— 「时间线占位随之变成 3.2 秒」是剪辑软件正经术语，
    //    判它就是在制造假红。只查「占位图/占位素材/占位文案/占位内容」这类认账说法。
    // ⚠️ 反空洞：第 3 条钉扫描器没空转；第 4、5 条拿合成夹具自证它会说不。
    expected: 5,
    marker: /UI_COPY_CHECK_OK/,
    count: /UI_COPY_CHECK_STATS\s+ok=(?<p>\d+)\s+total=(?<t>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'recon-hygiene',
    name: '取证·目录卫生（_recon/_evidence 不许堆积运行时残留）',
    argv: [NODE, 'tools/check-recon-hygiene.mjs'],
    // 稳定数字 5（脚本内固定）。
    //
    // 为什么补这一道（2026-10-02 PM 审查 P1-3）：实测 `_recon/` 下堆了 **450 个**
    // 点开头的运行时目录（`.dialogs-profile-15156` / `.home-profile-*` / `.tabs-profile-*`，
    // 名字里带 PID），每个都是 Electron/Chromium 的 Cache / GPUCache / Session Storage /
    // Preferences —— 占盘 3.8GB，且与「静默失效五类母题」里的**静默累积**直接相悖。
    //
    // 为什么以前没人管：**没有一次跑批是错的**（E2E 全 PASS），错的是没人收尾；
    // 而"目录多了"不会让任何一道闸门变红，人翻取证目录时也只当是"看不懂的目录"。
    //
    // ⚠️ 判据保守：只认点开头且命中我们自己命名（profile/shoot/fs-probe/menu-shoot）的目录，
    //   **真实取证素材一律不碰** —— 防的是"为了清零把判据放宽到什么都删"。
    // ⚠️ 判据与 `tools/clean-recon-profiles.mjs` **共用同一份** `isRuntimeLeftover()`，
    //   不是抄一份（第 5 条钉这条）。抄的那一刻两份就开始各自演化：清得掉却判不出来。
    // ⚠️ 反空洞：第 2 条钉扫描器没空转；第 3/4 条自证它该认的认、不该认的不认。
    expected: 5,
    marker: /RECON_HYGIENE_OK/,
    count: /RECON_HYGIENE_STATS\s+ok=(?<p>\d+)\s+total=(?<t>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'version-sync',
    name: '发布·版本号口径（权威唯一 · 该同号的同号 · 不许写死）',
    argv: [NODE, 'tools/check-version-sync.mjs'],
    // 稳定数字 7（脚本内固定）。
    //
    // 为什么补这一道（2026-10-02 PM 审查 P1-5）：仓库里有 4 个 package.json 各自写 `1.0.0`，
    // **谁也不消费谁**。发布时不知道该 bump 哪个数，改漏一个就出现
    // 「安装包叫 1.1.0、客户端关于页显示 1.0.0」这种自相矛盾的产物 ——
    // 而每个文件单独看都是合法版本号，没有任何一道闸门会说不。
    //
    // 口径（真源写在 tools/version.mjs 头注释，发布时用它 bump，别手改）：
    //   权威 = packages/desktop/package.json 的 version
    //     → 客户端「设置 → 关于我们」的「版本」行（main/index.js 的 appVersion()）
    //     → 安装包文件名 YiJingAIEditor-${version}-Windows-x64
    //     → git 发布标签 v<version>-stable
    //   必须同号：根 package.json、installer。
    //   独立演进（不同号不算错）：server / admin-panel —— 服务端按自己的部署节奏发版。
    //
    // ⚠️ 第 3、4 条钉的是「不许写死」：artifactName 里出现 x.y.z 字面量、
    //   或界面把版本号写成常量，都会让文件名/显示值与包内版本各走各的。
    expected: 7,
    marker: /VERSION_SYNC_OK/,
    count: /VERSION_SYNC_STATS\s+ok=(?<p>\d+)\s+total=(?<t>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'workbench-tabs',
    name: '客户端 E2E（七个功能标签 + 左栏全部项逐个点过，中栏不是空壳）',
    argv: [NODE, 'tools/workbench-tabs-e2e.mjs'],
    // 稳定数字 180 = 1(首页导航项数) + 2(逐项点击) + 7×3(标签) + **60×2(左栏项)**
    //   + 7×2(根卡片) + 6(面板内子标签) + 1(record 出路) + 13(时间线工具栏) + 2。
    // 281 → 180（开源版）：数字人 / 素材(贴纸)两个标签整页移除，媒体页去掉
    //   生成结果·下载·角色·五个 AI 项，音频去掉克隆/变声/AI 音乐，特效页去掉
    //   音频效果与画面清理 —— 逐个点过的左栏项 109 → 60。数字随脚本里的 TABS 表走。
    // 137 → 139（2026-09-24）：左栏新增 `background`，32 → 33 项。
    //   实测口径：左栏项从 12 → 13 时，**先红了一条**（"12 个二级项齐全"），
    //   而那次的 total 只有 137 —— 因为 C 段在失败处就收了，少发 2 条。
    //   这段值得记：**失败那次的 total 不能当基线**，它可能比正常轮少，
    //   照它去改 expected 会把"少跑了断言"固化成"预期如此"。要用全绿那轮的 total。
    // 139 → 203（2026-09-24 下午）：转场/滤镜/特效左栏换成参考分组树，33 → 65 项。
    //
    // 为什么必须单独立一道：左栏在这套闸门里是**静态**检查的
    // （workbench-tree 只验那张数据表写得对不对），顶部七个功能标签更是
    // 从来没人点过 —— desktop-shoot.mjs 只是 `page.$$('.wb-tab')` 数了个数。
    // 于是「点下去中栏显示『左侧选一个功能开始』的空壳 / 中栏是空的 /
    // 点了什么都没变 / 点下去抛异常」这四类缺陷，之前一个都拦不住。
    //
    // 期望值全部在脚本里**独立写死**（2 个首页导航项、7 个标签、7 个根卡片、
    // 32 个左栏项），
    // 不从被测代码 import —— 从被测代码取期望等于让被测代码自己出考卷，
    // 删掉一个标签它也会跟着"通过"。写死的另一面是：源码少一个/多一个入口会当场红。
    //
    // ⚠️ 不需要后端（开源版没有服务端）：断言只涉及结构（有没有东西、是不是空壳）。
    // ⚠️ 反空洞：脚本里若中途抛异常，**必须记一条 fail 并立 aborted 旗标**，
    //   不能只把没跑到的补成 SKIP —— 那样「跑到一半炸了」会变成
    //   「失败 0 / 跳过 105」判通过，也就是空洞绿。
    // 203 → 279（2026-09-25）：左栏按参考补齐五页（数字人 +7 / 文字 +8 / 字幕 +5 /
    // 音频 +6 / 贴纸 +9 / 素材库 +4 且「背景」下移），逐个点过的项从 65 → 108。
    // 同一轮里判据也改了两处，都是被结构变化逼出来的真问题：
    //   · B 段从「表里每一项此刻都在 DOM」改成「没有表外节点」—— 左栏是手风琴，
    //     展开一组就收起另一组，"N 项同时存在"从这一天起永不成立；
    //     存在性交给 C 段逐点（点不到会超时并指名哪一项）。
    //   · E 段不再写死落点节点 —— 顺带抓出一个**真缺陷**：时间线「素材库」按钮
    //     写死了 `'stock-local'`，而这个 key 在本次对齐后已不存在 ⇒
    //     `nodeOf` 返回 null ⇒ 左栏没有高亮、中栏退回"显示全部素材"（点了没反应）。
    //     现在一律走 `defaultNodeOf(tab)`。
    expected: 195,
    marker: /TABS_E2E_OK/,
    count: /TABS_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'workbench-buttons',
    name: '客户端 E2E（工作台每个按钮真点一遍，按"点完去了哪"分桶）',
    argv: [NODE, 'tools/workbench-buttons-e2e.mjs'],
    // 稳定数字 14。
    //
    // 为什么在 dead-buttons + workbench-tabs 两道之后还要再补一道 ——
    // 前三道加起来仍然答不了"所有按钮都点过了吗"：
    //   · dead-buttons 是**静态**的，只答"有没有接处理函数"；`onClick={onImport}`
    //     是完全合法的属性，它一个字都不会说 ⇒ **「接错到别的动作」它结构上看不见**；
    //   · workbench-tabs 点的是 62 个**入口**（导航/标签/左栏/根卡片/子标签/时间线工具栏），
    //     标签进去之后**面板里的按钮**不在它的盘子里；
    //   · 其余 E2E 各自只点自己关心的那几个，覆盖面向量，不是按钮全集。
    //
    // 2026-09-23 首次跑就抓到第二拨"接错"（第一拨是被 tabs 闸门抓的素材库→onImport）：
    // 顶栏「文件」、「下载」图标、「侧栏」图标**三个不同语义的入口全都接到了 onHome**
    // （点下去退回创作中心）。其中「文件」在参考里是**下拉菜单**，一级文案在参考自己的
    // 语言包里就有真值（cn 188~192：新草稿 / 打开最近项目 / 保存草稿 / 将草稿另存为），
    // 已照此补齐；「侧栏」图标改为真折叠左栏；「下载」改为打开下载任务面板。
    //
    // ⚠️ 这道闸门**自带打桩**：把主进程的 showOpenDialog/showSaveDialog/showMessageBox
    //   换成"用户取消"、shell.openExternal 换成记录 —— 否则点到"导入"会弹系统文件框
    //   把用例永久吊死，点到"帮助"会真的拉起浏览器。
    // ⚠️ 反空洞：A1/B2 钉"扫到的按钮数不能是 0"；A2 钉"首轮扫到的一个都不许漏"；
    //   跳过/禁用的每一条都必须带书面原因（C3/D3），不许静默缩小覆盖。
    // ⚠️ 中断时补 SKIP 的同时**必须记一条 fail**，否则"跑到一半炸了"会变成满分绿。
    // ⚠️ 它依赖 dist-renderer 是**新构建的**（跑的是构建产物，不是源码）——
    //   改完渲染层要先 `npm run desktop:build`，否则这道门在验旧代码。
    expected: 14,
    marker: /BTN_E2E_OK/,
    count: /BTN_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'hardware-accel',
    name: '客户端 E2E（硬件加速开关真落盘·真重启·真生效）',
    argv: [NODE, 'tools/check-hardware-accel.mjs'],
    // 稳定数字 6。
    //
    // 为什么不能只做"静态查源码 + 查 JSON 字段"：`app.disableHardwareAcceleration()`
    // 是**启动期 API**，必须在 `app.whenReady()` 之前调；ready 之后再调
    // **不报错、也不生效**。这种错法三层伪装：
    //   · 界面点了有 toast 反馈 ⇒ 像成功了；
    //   · 设置文件里确实写进去了 ⇒ 查盘查不出问题；
    //   · 构建、类型、其它闸门全绿 ⇒ 没有任何一处会响。
    // 只有**重启一次、再问主进程"你现在到底开没开"**才能发现。
    // 所以这道闸门不查代码、不查字段，它真的启动三次，每次以 app:info 报的
    // **实际生效值**为准（关→重启=关，开→重启=开，缺省=开）。
    //
    // ⚠️ 每个 profile 必须在跑之前清干净，否则上一轮留下的 false 会让第 1 条假绿。
    // ⚠️ 收尾不许裸 `app.close()`：实测会一直不返回（挂过 7 分钟），必须 race + taskkill。
    expected: 6,
    marker: /HW_ACCEL_OK/,
    count: /HW_ACCEL_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'preview-effects',
    name: '客户端 E2E（预览区真的画出「字幕叠加 / 转场 / 滤镜 / 画面特效」）',
    argv: [NODE, 'tools/check-preview-effects.mjs'],
    // 稳定数字 34 = 静态契约 1（不许有动画给画布/内容层动 filter，且**不许挂在画框上**）
    //   + 夹具 2（draft 真的写进去了 / 片段数对得上）
    //   + 2.0s 段 10（含"画框自身无动画"那条）+ 4.5s 段 5 + 7.0s 段 5 + 面板端到端 8
    //   + 空时间线 2 + 全程页面错误 1。
    //
    // 为什么必须存在：这是本仓最贵的一类缺陷 —— **「加上了，但画面里一个像素都没变」**。
    //   在它之前，字幕 / 转场 / 滤镜 / 特效这四件事能通过所有既有闸门：
    //     · 卡片点得开、状态确实写进了 clips、还弹了 toast（看着像成功）；
    //     · 静态闸门查得到 JSX 里有组件、CSS 里有类名；
    //     · workbench-buttons 甚至能证明"点完去了哪"。
    //   唯独**没人看画面** —— 四件事都只在时间线上多了一个标记。
    //   ⇒ 这道闸门量的就是"用户眼睛能看到的东西"：
    //     叠加层节点与它的 computed 字号/底色、`.canvas-frame` 的 computed filter、
    //     转场进度 p、第二路 video 是否真在，以及**三者能不能同时存在**。
    //
    // 反空洞约定（都踩过）：
    //   · 真值**写死在脚本里**（1280 基宽、sub-bar 的字号/底色、vivid 的滤镜串），
    //     绝不从被测代码 import —— 否则代码一改判据跟着改，闸门退化成复印机。
    //   · 必须读 **computed style**：`.canvas-frame` 的调色是内联 filter，只有真渲染了才在；
    //     读 CSS 文本只能证明"有人写了 filter"。
    //   · 静态契约那条治的是**本仓特有的一个陷阱**：预览区调色住在 `.canvas-frame` 的
    //     内联 filter 上，任何 `@keyframes` 只要动 filter 就会**静默压掉调色**（不报错、
    //     只是数值渐变突然消失）⇒ 画面特效用例一律走 `.canvas-fx` 叠加层。
    //     所以「危险动画集合 ∩ 挂在 .canvas-frame 上的动画集合」必须为空，且**不能为空集**
    //     （一个不挂 = 特效整个丢了，也是红）。
    //   · 「空时间线」那两条是**真的把视频片段删光**再点样式卡（第一次用的现场）。
    //     它抓到过一个只有截图才看得见的真 bug：时间线上没有视频片段时，
    //     叠加层判据挂在"播放头下有没有视频"上 ⇒ 字幕一条都画不出来（层数 0）。
    //   · 收尾不许在裸 `app.close()` 之后再读 `app.process()`：实测 tear-down 后读会抛，
    //     断言全绿而退出码变 1（看着像闸门坏了）—— 已 try/catch。
    expected: 34,
    marker: /PREVIEW_FX_OK/,
    count: /PREVIEW_FX_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)\s+skip=(?<s>\d+)/
  },
  {
    id: 'preview-effects-selftest',
    name: '自证·画面特效禁令判据可分辨（正控制组全绿 · 危险动画红在对的断言上）',
    argv: [NODE, 'tools/check-preview-effects.mjs', '--selftest'],
    // 稳定数字 7 = 1 条正控制组 + 6 条反控制组 / 判据自身（纯逻辑，不起 Electron）。
    //
    // 为什么必须单独自证：上面那条「动画不许给 .canvas-frame 动 filter」的禁令，
    //   唯一的坏法是**恒绿** —— 判据永远返回 ok。那样的话，哪天有人给画面加一个动
    //   filter 的动画，调色被静默顶掉（画面渐变突然没了），三层伪装：
    //   构建绿、类型绿、其它闸门绿。这份自证逐条钉住它的分辨力：
    //     · 挂在文字上的 glow（动 filter 但不在 .canvas-frame 上）必须**通过**
    //       —— 不然这条禁令会把合法的文字发光也一起禁掉，变成假红；
    //     · 挂在 .canvas-frame 上的必须**红**，且**只点出危险的那个**（混写不许误伤）；
    //     · 一个动画都不挂也必须红（特效整个丢了）；
    //     · 逗号多选择器、嵌套花括号的块边界都要切得准 —— 切错就是漏报。
    expected: 7,
    marker: /PREVIEW_FX_SELFTEST_OK/,
    count: /PREVIEW_FX_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'preview-aspect',
    name: '客户端 E2E（预览区画面比例：七个比例逐个点，画布真的换形状）',
    argv: [NODE, 'tools/check-preview-aspect.mjs'],
    // 稳定数字 16 = 前置 1 + 静态契约 3 + 夹具 1 + 按钮 1 + 默认 1 + 七比例 7 +
    //             重启仍在 1 + 无页面错误 1。
    //
    // 为什么单独一道（preview-effects 已经很全了还要再加）：
    // 比例有两类缺陷是纯静态看不出来、也不在"效果有没有画出来"那个盘子里的 ——
    //   ① **能选但画布不变**：按钮换了 data 属性、状态也存了，可 aspect-ratio 写死在
    //      CSS 里 ⇒ "切到 1:1，画面还是横的"。这正是「状态变了、画面一个像素没变」；
    //   ② **框外的东西漏出来**：字幕 / 画中画 / 画面特效都是画布内的绝对定位层，
    //      画布不裁（overflow 不是 hidden）时它们会飘到框外 ——
    //      而"预览窗内实现、窗口外不显示"正是这个功能的要求。
    // ⇒ 所以这里断言的是**真机量出来的盒子**：点了按钮之后 .canvas-frame 的实际
    //   宽高比是不是真的变成了那个比例。只读 data 属性的话，第 ① 类照样能绿。
    //
    // ⚠️ 重启那条不能只等固定时间：自动保存有 1.2s 防抖，没落盘就重启等于什么都没验到，
    //    而且失败信息会写成"还是 16:9"，看着像没持久化、真因其实是没写到盘上。
    //    现在改成轮询草稿里那个字段，等不到才判失败。
    expected: 16,
    marker: /ASPECT_E2E_OK/,
    count: /ASPECT_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'preview-aspect-selftest',
    name: '自证·画面比例判据可分辨（写死比例 / 改 contain / 去 overflow 各红在对的断言上）',
    argv: [NODE, 'tools/check-preview-aspect.mjs', '--selftest'],
    // 稳定数字 16（与真机那条同数） = 1 条正控制组 + 3 条逐项扰动 + 1 条整条消失
    //   + 1 条真值表完整性 + 补齐 10 条。
    //
    // 三条扰动必须**各红在一条上、且互不牵连** —— 否则"改哪儿都全红"的检查器
    // 分不清到底坏在哪，等于没有。
    // 真值表那条治的是另一件事：比例表是"界面该有几个比例"的唯一依据，
    // 被人删掉一个却没人发现的话，上面几条照样绿 —— 所以它点名要求表里有 7 个。
    expected: 16,
    marker: /ASPECT_E2E_OK/,
    count: /ASPECT_E2E_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'layout-split',
    name: '客户端 E2E（四根分隔条：真拖真量、键盘微调、双击复位、重启仍在）',
    argv: [NODE, 'tools/check-layout-split.mjs'],
    // 稳定数字 17 = 前置 1 + 静态契约 4 + 夹具 1 + 把手齐全 1 + 左栏拖/键 2
    //   + 中栏拖/守恒 2 + 信息栏 1 + 时间线拖 1 + 持久化 1 + 复位 3（左栏/时间线/复位前偏离）+ 健康 1。
    //
    // 这道闸治「把手画了但没有行为」一类：分隔条是 5px 的缝，看着像分隔缝、
    // 静态全绿，只有真拖一下才知道有没有行为。所以判据全部是**实测盒子**
    // （getBoundingClientRect），不读 data 属性。
    //   · 2026-10-08 实录：键盘微调"0px 变化"的真相是 Splitter 里一个三元
    //     优先级错误 —— v 分支整个表达式是数组恒真，**Shift 键自己**触发了
    //     一次 -40 的反向 nudge，随后的 +40 正好把它顶回去，宽度"看起来没动"。
    //     四条探针（capture 探针 / console / 状态变量 / dispatchEvent 对照）
    //     才把它钉出来 —— 只有实测盒子 + 全链路日志能定位这种缺陷。
    expected: 17,
    marker: /LAYOUT_SPLIT_OK/,
    count: /LAYOUT_SPLIT_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'layout-split-selftest',
    name: '自证·分隔条判据可分辨（光标反配 / 横条入流 / 删列定位 各红在对的断言上）',
    argv: [NODE, 'tools/check-layout-split.mjs', '--selftest'],
    // 稳定数字 17 = 正控制组 1 + 扰动 4（光标反配 / 横条 position / 删列定位 / 整组消失）
    //   + 现场 CSS 同判据 1 + 真值表 1 + 补齐 10。其中"现场 CSS"一条让判据
    //   与实现永远同源演化：改了分隔条样式而不改判据，这条当场红。
    expected: 17,
    marker: /LAYOUT_SPLIT_OK/,
    count: /LAYOUT_SPLIT_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'track-controls',
    name: '客户端 E2E（轨道开关：静音/隐藏/锁定/独奏/停用/替换 真的接进预览与菜单）',
    argv: [NODE, 'tools/check-track-controls.mjs'],
    // 稳定数字 21 = 静态接线契约 1 + 夹具 2（草稿写入 / 片段数）+ 轨道头 2（开关数 / 字幕轨不该有喇叭）
    //   + 前置 audio 1 + 静音/取消 2 + 独奏/取消 2 + 隐藏 2（前置主层 / 隐藏后换人）
    //   + 停用 2（V 标记 / 再按恢复）+ 锁定 2（替换片段禁用 / 菜单禁用）+ 落盘 1 + 无页面错误 1。
    //
    // 这道闸治「轨道灯亮了、成片照旧」一类：上一版隐藏/静音只活在时间线本地
    // state，lane 变灰了但预览照播、导出照渲。判据全部读**消费端**——
    // 预览里的 <audio> 元素、主画面层的 data-layer、菜单按钮的 disabled。
    expected: 21,
    marker: /TRACK_CONTROLS_OK/,
    count: /TRACK_CONTROLS_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'track-controls-selftest',
    name: '自证·轨道接线判据可分辨（十处接线逐条扰动 各红在对的断言上）',
    argv: [NODE, 'tools/check-track-controls.mjs', '--selftest'],
    // 稳定数字 11 = 正控制组 1 + 扰动 10（toggleHooks / lockHooks / trackStateProp /
    //   lockedGuard / effectiveClips / renderClipsToExport / disableAction /
    //   trackStatePersisted / soloHooks / replaceWired）。
    // 11 → 12（2026-10-19）：新增「剪辑联动」一条扰动（按钮→App→拖动→落盘四段）。
    expected: 12,
    marker: /TRACK_CONTROLS_SELFTEST_OK/,
    count: /TRACK_CONTROLS_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'draft-params',
    name: '客户端 E2E（无选中时的草稿参数：分辨率由比例算出 / 保存位置是真的 / 修改真可编辑）',
    argv: [NODE, 'tools/check-draft-params.mjs'],
    // 稳定数字 9 = 夹具 1 + 面板在 1 + 保存位置 1 + 16:9 分辨率 1 + 修改切控件 1
    //   + 改比例重算 1 + 改时间线名回显 1 + 重启仍在 1 + 无页面错误 1。
    //
    // 挡的是「把 12 行字段写死成字符串」这类装饰：静态扫描全绿、构建全绿，
    // 但改比例时分辨率不动、"保存位置"是编的、"修改"点了没反应。
    // 所以判据一律读消费端，且分辨率必须**算出来**而不是写死。
    expected: 9,
    marker: /DRAFT_PARAMS_OK/,
    count: /DRAFT_PARAMS_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'draft-params-selftest',
    name: '自证·草稿参数判据可分辨（五处接线逐条扰动 各红在对的断言上）',
    argv: [NODE, 'tools/check-draft-params.mjs', '--selftest'],
    // 稳定数字 6 = 正控制组 1 + 扰动 5（panelHook / resolutionComputed /
    //   saveLocationReal / editableFields / writeBack）。
    expected: 6,
    marker: /DRAFT_PARAMS_SELFTEST_OK/,
    count: /DRAFT_PARAMS_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'inspector-fx',
    name: '客户端 E2E（检查器效果：调节/美颜/位置真的改预览，且与导出同一组换算）',
    argv: [NODE, 'tools/check-inspector-effects.mjs'],
    // 稳定数字 44 = 换算同源 8（中性 1 + 亮度 1 + 色温 1 + 饱和度 1 + 磨皮 1
    //   + 位置旋转 1 + 越界夹取 1 + 字幕覆写 1）
    //   + 效果换算同源 10（中性 1 + 圆角 1 + 斜切 1 + 抠像 1 + 蒙版矩形 1 + 圆角进遮罩表达式 1
    //     + 混合映射 1 + 描边 1 + 阴影 1 + 关键帧 1）
    //   + 真机 24（原 22：夹具 1 + 整排页签 1（信息 + 画面/音频/变速/调整）+ 亮度挂矩阵 1
    //     + 矩阵红增益>1 1 + 色温红变大 1
    //     + 色温蓝<红 1 + 磨皮有 blur 1 + 磨皮半径比例 1 + 淡入写回片段 1 + 字幕字号变大 1
    //     + 无页面错误 1；
    //     效果面板 8：六子页签 1 + 圆角剪裁盒与比例 1 + 斜切 transform 1 + 抠像矩阵 1
    //     + 蒙版 mask-image 1 + 描边 8 向 drop-shadow 1 + 阴影叠第 9 条 1 + 效果写回草稿 1；
    //     裁剪与镜像 2：点「裁剪 1:1」画面真的放大到 1.78 倍 1 + 点「左右镜像」x 缩放变负数 1；
    //     右栏排版 3：「信息」横排且与「画面」同一行 1 + 字幕片段[信息][字幕] 1
    //     + 点「字幕」真的换屏 1）。
    //
    // 挡的是「右栏滑杆是根会动的装饰」：位置、图标、数值全对，拖下去预览
    // 一个像素都不变（或预览变了、成片不变）。所以分三层：换算同源（CSS↔ffmpeg）、
    // 判据可分辨（逐条扰动）、真机生效（读 computed style / 草稿落盘值，不读 data 属性）。
    //
    // ⚠️ 新增的 10 条「效果换算同源」是真源 effects.js 的**跨侧一致性**判据：
    //   圆角（cqw ↔ radiusPx 等比）、斜切（deg ↔ tan）、抠像（alpha 行 ↔ colorkey）、
    //   蒙版（geq 表达式只许用 X/Y/W/H）、混合（css 名 ↔ ffmpeg 名映射）、
    //   描边（基准宽度折算）、阴影（blur 与 sigma 的 2:1）、关键帧（线性 + 两端夹取）。
    //   每一条的坏法都是"两侧各写一份、有一边漏掉"，构建与静态扫描全都看不见。
    //
    // ⚠️ 新增的 2 条「裁剪与镜像」治的是**面板长出来了但没接线**：
    //   自由裁剪与镜像都是这一个版本新加的真源（crop.js / effects.js 的 mirrorFilters），
    //   面板画得出来、数据也写回片段，但只要 Stage.jsx 的 transform 列表漏一项，
    //   预览就一个像素不动（导出反而是对的 —— 只查草稿值发现不了）。所以读 computed matrix()。
    //
    // ⚠️ 新增的 3 条「右栏排版」治的是**外形与去向脱节**：页签画出来了但点了不换屏、
    //   「字幕」页签在画面片段上也冒出来（点下去没东西可看）、以及「信息」被别的
    //   选择器压成竖排/被挤到另一行（看着不像页签）。前者读 DOM、后者量矩形，都是消费端。
    // +2（2026-10-19 文字系统）：点「入场·上浮」预览真的挂上 ta-up-in 动画；
    //   点「左对齐」外框的 justify-content 真的变 flex-start。
    expected: 44,
    marker: /INSPECTOR_FX_OK/,
    count: /INSPECTOR_FX_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'inspector-fx-selftest',
    name: '自证·检查器效果判据可分辨（预览空/导出空/丢位移/硬塞矩阵/不乘字号 各红在对的断言上）',
    argv: [NODE, 'tools/check-inspector-effects.mjs', '--selftest'],
    // 稳定数字 16 = 正控制组 2（调节/美颜/字幕一组 + 效果换算一组）
    //   + 扰动 5 + 效果扰动 9。
    expected: 16,
    marker: /INSPECTOR_FX_SELFTEST_OK/,
    count: /INSPECTOR_FX_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'e2e-teardown',
    name: '静态·E2E 脚本收尾（不许裸等 app.close / 不许管道 spawnSync）',
    argv: [NODE, 'tools/check-e2e-teardown.mjs'],
    // 稳定数字 6 = 覆盖面 1 + 不许裸等 1 + 超时兜底 1 + 强制退出 1 + 不许管道 spawn 1 + 补齐 1。
    //
    // 这道闸治的是「**检查器自己坏了**」，它比「被测代码坏了」贵得多：
    //   · 2026-10-08 实录：新写的 check-preview-aspect.mjs 收尾是裸 `await app.close()`，
    //     而这个环境里 app.close() 永不返回 —— 断言早就跑完、结论也落盘了（16/16），
    //     卡住的只是退出那一步，于是整套一键验证停在 42/45 不动 28 分钟，
    //     看上去像"Electron 崩了"，真因只是没人去关它。
    //   · 同一轮的第二个：脚本里 `spawnSync(cmd, args, { encoding: 'utf8' })` 跑 ffmpeg，
    //     本机 spawnSync 走管道恒 EBUSY ⇒ 探测函数恒返回"没找到" ⇒ 整组静默变 SKIP，
    //     闸门照样绿、一条没验（修完：media 18P/17S→26P/9S，real-film 33P/3S→36P/0S）。
    //
    // 两者共性是「无声无息，且报出的方向与被验的东西无关」，静态扫一遍就能钉住。
    // ⚠️ 判据按 **app.close 前后 300 字符的窗口** 查超时包裹，不是按行、也不是查
    //    "文件里有没有出现过 withTimeout" —— 后两者会把 Promise.race([app.close(), …])
    //    这种多行写法全判成缺兜底，一上线就是一片假红。
    expected: 6,
    marker: /E2E_TEARDOWN_OK/,
    count: /E2E_TEARDOWN_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'e2e-teardown-selftest',
    name: '自证·E2E 收尾判据可分辨（正控制组全绿 · 裸等/无兜底/管道 spawn 各红在对的断言上）',
    argv: [NODE, 'tools/check-e2e-teardown.mjs', '--selftest'],
    expected: 6,
    marker: /E2E_TEARDOWN_SELFTEST_OK/,
    count: /E2E_TEARDOWN_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'oss-clean',
    name: '开源洁净（源码里不许有第三方品牌 / 生产地址 / 密钥 / 账号与支付残留）',
    argv: [NODE, 'tools/check-oss-clean.mjs'],
    // 稳定数字 37 = 禁用词条数（每条一票，命中就红）。
    //
    // 这道闸是针对"发布那一刻才变成问题"的那一类东西：一个写在注释里的第三方产品名、
    // 一个留在常量里的生产域名，都**不报错、不影响运行**，构建全绿、别的闸门也全绿。
    //
    // 三类各钉一条：
    //   ① 第三方品牌 / 厂商 / 素材服务（含模型名与厂商域名）；
    //   ② 生产服务地址、远端接口前缀、密钥字段；
    //   ③ 支付与账号体系残留 —— 中文同义词一并收录（完整词条表在
    //      tools/check-oss-clean.mjs 里），因为这版要能纯开源，这些东西一个都不该出现。
    //
    // ⚠️ 三条防假红的设计（都踩过）：
    //   · 中文没有词边界 ⇒ 「节点数」会被计费类词条命中、「升级安装」会被商业化词条命中，
    //     所以每条能声明 `notBefore` / `notAfter`（前/后一个字不能是什么）；
    //   · 构建产物目录（dist* / out / build / release）不扫 —— 那是复制过去的旧内容，
    //     改它没意义，还会把闸门染红；
    //   · **看门狗自己得写出禁用词**（要检测某个词就得写下它），所以文件里可以写一行
    //     `oss-clean-allow` 声明（该语法见 tools/check-oss-clean.mjs 的注释），
    //     但只允许放行**表里已有**的词，声明表外的词会被判失败 ——
    //     否则加一行注释就能放行任何东西。
    //     ⚠️ 这里刻意**不写出**那个声明的完整样例：扫描器是全文逐字匹配的，
    //     在注释里举例子等于真声明了一次，会把这道闸自己顶红（刚踩过）。
    expected: 40,
    marker: /OSS_CLEAN_OK/,
    count: /OSS_CLEAN_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'oss-clean-selftest',
    name: '自证·开源洁净判据可分辨（造一个禁用词必须被抓出来 · 中文词同样在生效）',
    argv: [NODE, 'tools/check-oss-clean.mjs', '--selftest'],
    // 稳定数字 4。**两面都要有**：
    //   必须红 —— 往干净仓库里塞一个第三方产品名，检查器必须报出来；
    //   绝不能红 —— 清掉之后必须归零（否则"恒红"的检查器也会被当成通过）；
    //   第三条最要紧：中文词条必须也在生效 —— 只留英文判据的话，
    //   哪天有人把中文那半张表删掉，前两条照样绿，闸门就空转了；
    //   第四条管住上面那条豁免：声明表内的词要放行、声明表外的词必须判红。
    expected: 4,
    marker: /OSS_CLEAN_SELFTEST_OK/,
    count: /OSS_CLEAN_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'mcp-bridge',
    name: '契约·MCP 桥（镜枢 ↔ 剪辑软件：9 工具 · stdout 纯洁 · 自动注册 · 打包覆盖）',
    argv: [NODE, 'tools/check-mcp-bridge.mjs'],
    // 稳定数字 18。这道闸盯的是"坏掉都不报错"的一整组东西：
    //   · 四个文件在不在、工具表是不是**恰好**那 9 个（少一个 agent 就少一项能力）；
    //   · stdout 纯洁性 —— MCP 靠 stdout 跑 JSON-RPC，一行 console.log 就让对面解析失败、
    //     整条链路静默断掉（只能靠"源码里不许有 console.log"钉）；
    //   · 自动注册**真跑一次**写临时目录（判据读消费端，不是 grep），并验合并不覆盖别人；
    //   · ⚠️ **打包覆盖**：主进程 5 个模块在运行期 require `../shared/*`，而
    //     electron-builder 的 files 是白名单。漏掉 `src/shared` 那层时开发全绿、
    //     vite 构建也绿，**装出来的 exe 一导出就 MODULE_NOT_FOUND**。反向验过：
    //     把白名单里那行拿掉，第 12 条立刻红，并逐条列出会崩的 10 个 require。
    //   · 第 14 条：**隔离运行不写用户全局配置**。E2E/取证都带 `--user-data-dir=<临时>`，
    //     但 `appData` 仍是真实 `%APPDATA%` —— 没守卫时一次全量 verify 就会把用户
    //     真实的 `%APPDATA%\yegin\mcp.json` 冲成 `Temp/yjai-e2e/.insp-fx-*`（实测踩过）。
    expected: 18,
    marker: /MCP_BRIDGE_OK/,
    count: /MCP_BRIDGE_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
  {
    id: 'mcp-bridge-selftest',
    name: '自证·MCP 桥判据可分辨（白名单漏项 / 目标缺失 / glob 过宽 / 隔离守卫 各红在对的断言上）',
    argv: [NODE, 'tools/check-mcp-bridge.mjs', '--selftest'],
    // 稳定数字 8。喂合成输入证明判据本身能分辨：
    //   · 白名单漏 `src/shared` 时必须报"未覆盖"；补上必须归零；
    //   · 目标文件不存在要单独判"缺失"（不能被算成"已覆盖"而蒙混过关）；
    //   · glob 的两个方向各钉一条（不过宽：src/main 不许匹配到 src/shared；
    //     不漏：src/main 必须匹配自己子树）——只验一个方向的话，
    //     把匹配器写成"恒真"或"恒假"都会漏网；
    //   · 白名单解析必须剔除 `!` 排除项，否则排除项会被误当成覆盖；
    //   · 隔离守卫正反两面（有 hasSwitch 判"已守卫"、无则判"未守卫"）。
    expected: 8,
    marker: /MCP_BRIDGE_SELFTEST_OK/,
    count: /MCP_BRIDGE_SELFTEST_STATS\s+total=(?<t>\d+)\s+pass=(?<p>\d+)\s+fail=(?<f>\d+)/
  },
]

// ------------------------------------------------------------------ 工具

const results = []
let serverProc = null
let serverStarted = false

function log(msg = '') {
  console.log(msg)
}

/** 探活：不只看端口通不通，还要看返回内容对不对（防止挂载根指错） */
function probeServer() {
  return new Promise((resolve) => {
    const req = http.get(`${SERVER_URL}${HEALTH_PATH}`, { timeout: 2500 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
        if (body.length > 65536) req.destroy()
      })
      res.on('end', () =>
        resolve(
          res.statusCode === 200
            ? { ok: true, how: `已有服务在跑（${HEALTH_PATH} 返回 200）` }
            : { ok: false, why: `${HEALTH_PATH} 返回 ${res.statusCode}，端口有人听但服务不对` }
        )
      )
    })
    req.on('error', (e) => resolve({ ok: false, why: `不可达（${e.code || e.message}）` }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, why: '探活超时' })
    })
  })
}

async function ensureServer() {
  const first = await probeServer()
  if (first.ok) return { ok: true, how: first.how }

  log(`  后端未就绪（${first.why}），自动拉起…`)
  const out = fs.openSync(path.join(EVIDENCE, 'server.log'), 'w')
  serverProc = spawn(NODE, ['--no-warnings=ExperimentalWarning', 'packages/server/src/index.js'], {
    cwd: root,
    stdio: ['ignore', out, out],
    windowsHide: true
  })
  serverStarted = true
  serverProc.on('exit', (code) => {
    if (serverStarted) log(`  [警告] 后端进程提前退出（code=${code}），详见 _evidence/verify/server.log`)
  })

  for (let i = 1; i <= 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const p = await probeServer()
    if (p.ok) return { ok: true, how: `本次自动拉起（第 ${i} 次探测就绪）` }
  }
  return { ok: false, why: '自动拉起后 20 秒内仍未就绪，详见 _evidence/verify/server.log' }
}

function stopServer() {
  if (serverProc && serverStarted && !keepServer) {
    try {
      serverProc.kill()
    } catch {
      /* ignore */
    }
    log('  已关闭本次拉起的后端')
  } else if (serverProc && keepServer) {
    log('  按 --keep-server 保留后端进程')
  }
}

/**
 * 单个闸门的墙钟上限。必须有：spawnSync 不传 timeout 时，一个卡住的 E2E
 * （典型是 Windows 上 Electron 退出不了）会让整个套件永久挂住，而且不产出任何
 * 可读输出 —— 比"失败"更难查。到点会被杀掉，走下面的超时分支报出来。
 *
 * ⚠️ "收尾卡住"与"断言没跑完"是两件事，必须分开判（2026-09-22 实录）：
 *   第 22 道（home）出现过 22 条断言全绿、汇总行没打出来、进程以 0 CPU 挂死
 *   10 分半的情况 —— 那是**收尾里的同步调用把主线程堵死了**（定时器一起停摆，
 *   所以闸门自己的看门狗也没机会触发）。若只看退出码，这道会被判成"超时失败"，
 *   而事实上断言全过了；更糟的是它白占 20 分钟。所以下面加了 salvage 分支。
 * 闸门可以在自己的 GATES 条目里声明 `timeoutMs` 覆盖这个默认值（只调小，别调大）。
 */
const GATE_TIMEOUT_MS = 20 * 60 * 1000

/**
 * 判断"结论是否已经完整落盘"：通过标记 + 能解析出断言数 + 断言数与预期一致。
 * 三条同时成立，说明这个闸门该说的话已经说完了，剩下的只是收尾。
 */
function conclusionOnDisk(gate, out) {
  if (!gate.marker.test(out)) return false
  const m = gate.count.exec(out)
  if (!m || !m.groups) return false
  const g = m.groups
  let total = null
  if (g.t !== undefined) total = Number(g.t)
  else if (g.p !== undefined) total = Number(g.p) + Number(g.f || 0) + Number(g.s || 0)
  if (total === null) return false
  // expected 是**合约数**（精确、必须相等）；minExpected 是**事实数的下界**。
  // 事实数（"扫到多少条相对导入"这类）会随正常的代码变更增长，钉死它必然假红 ——
  // 而假红会训练人无脑忽略这道闸门，代价远大于它带来的那点保护。
  // 但它**掉下来**是危险方向（说明扫描器漏看了东西、闸门在悄悄变瞎），所以留下界。
  if (gate.minExpected !== undefined) return total >= gate.minExpected
  return gate.expected === null || total === gate.expected
}

/** 跑一个闸门：输出落盘 + 收集退出码与断言数 */
function runGate(gate, index) {
  const logFile = path.join(EVIDENCE, `${String(index + 1).padStart(2, '0')}-${gate.id}.log`)

  /* ⚠️ 用**文件 fd** 接子进程的 stdout/stderr，**不要用管道**。
   *
   * 实测（`_recon/probe-pipe-parent.mjs`，2026-09-22）：`spawnSync` 等的是**管道 EOF**，
   * 不是"子进程已退出" —— 探针里子进程立刻退出，但它的孙进程继承了那条管道，
   * spawnSync 就结结实实等了 8.2 秒（= 孙进程活多久）。结论一句话：
   * **只要有任何一个后代进程还攥着那条管道的写端，这个闸门就永远"不返回"。**
   *
   * 本项目的闸门都会启 Electron，而 Electron 的子孙进程**未必随闸门一起消失**
   * （沙箱里 taskkill 跨进程命名空间杀不掉，见 MEMORY 的"本机环境"）。
   * 于是出现过这种现象：闸门进程其实已经退了（ps 里查得到、也会自行消失），
   * 但整套 verify 卡在那一道不动 —— 报出来的却是"超过 20 分钟被强杀"。
   * 换文件 fd 之后这条路径根本不存在，另有两个顺带的好处：
   *   ① 闸门卡住时日志里能看到它**已经打出来的部分**（管道模式只能等它退出才有内容）——
   *      这次定位"卡在哪一步"就是靠它；
   *   ② 不再受 `maxBuffer` 限制（原 64MB，撑爆会报 ENOBUFS）。
   */
  const outFd = fs.openSync(logFile, 'w')
  /** 本闸门的墙钟上限：允许在 GATES 条目里单独调小（见 home 那一条的理由） */
  const timeoutMs = gate.timeoutMs || GATE_TIMEOUT_MS
  let r
  try {
    r = spawnSync(gate.argv[0], gate.argv.slice(1), {
      cwd: root,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', outFd, outFd],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: 'production' }
    })
  } finally {
    fs.closeSync(outFd)
  }

  const out = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''

  // 先判超时：被杀掉的进程 r.status 是 null，接着往下走会报成"退出码 null"，指错方向
  if (r.error && r.error.code === 'ETIMEDOUT') {
    /* salvage：断言已经全部跑完、只是收尾把主线程堵死的那种"假超时"。
     * 判据不是"看起来像"，而是**结论本身在盘上且自洽**（通过标记 + 断言数与该闸门的
     * 预期一致）—— 与正常路径用的是同一套判据，所以救回来的条目照样受"总数守恒"约束，
     * 不存在"超时了所以放宽"的口子：断言数对不上、或标记没打出来，一律还是失败。
     * 救回来的条目在日志尾部与汇总行里都会显式标注 `salvage`，不会被当成正常跑完。 */
    if (conclusionOnDisk(gate, out)) {
      return judgeOutput(gate, logFile, out, { status: null, salvedFrom: 'timeout' })
    }
    return {
      gate,
      logFile,
      exit: null,
      total: null,
      passed: null,
      failed: null,
      skippedN: null,
      salvedFrom: null,
      note: null,
      problem: `超过 ${Math.round(timeoutMs / 60000)} 分钟被强杀（闸门卡住，不是断言失败）`
    }
  }

  return judgeOutput(gate, logFile, out, { status: r.status })
}

/** 对"已经拿到的完整输出"做判定。正常路径与 salvage 路径共用，保证判据只有一套。 */
function judgeOutput(gate, logFile, out, { status, salvedFrom = null }) {
  const rec = {
    gate,
    logFile,
    exit: status,
    total: null,
    passed: null,
    failed: null,
    skippedN: null,
    salvedFrom,
    note: null,
    problem: null
  }

  // 编码自检：出现替换字符说明按 UTF-8 解错了，后面的关键词匹配全都不可信
  if (out.includes('\uFFFD')) {
    rec.problem = '输出解码出现替换字符（U+FFFD），关键词匹配不可信'
    return rec
  }
  /* 退出码：salvage 的来源就是"收尾被强杀"，退出码必然非 0，那不是断言层面的信息，
   * 所以这条只在非 salvage 路径上判。 */
  if (status !== 0 && !salvedFrom) {
    rec.problem = `退出码 ${status}`
  }
  if (!gate.marker.test(out)) {
    rec.problem = (rec.problem ? rec.problem + '；' : '') + '未出现通过标记'
  }

  const m = gate.count.exec(out)
  if (m && m.groups) {
    const g = m.groups
    rec.passed = g.p === undefined ? null : Number(g.p)
    rec.failed = g.f === undefined ? null : Number(g.f)
    rec.skippedN = g.s === undefined ? null : Number(g.s)
    if (g.t !== undefined) rec.total = Number(g.t)
    else if (rec.passed !== null && rec.failed !== null) rec.total = rec.passed + (rec.failed || 0) + (rec.skippedN || 0)
  }

  if (rec.total === null) {
    rec.problem = (rec.problem ? rec.problem + '；' : '') + '解析不到断言数'
  } else if (gate.minExpected !== undefined && rec.total < gate.minExpected) {
    // 事实数的**下界**。掉下来是危险方向（说明扫描器看不见东西了），涨上去是正常的。
    rec.problem =
      (rec.problem ? rec.problem + '；' : '') +
      `扫描到的条数掉到了 ${rec.total}，低于下界 ${gate.minExpected}（扫描器漏看了什么？）`
  } else if (gate.expected !== null && rec.total !== gate.expected) {
    rec.problem =
      (rec.problem ? rec.problem + '；' : '') +
      `断言数不符：预期 ${gate.expected}，实际 ${rec.total}（有断言被删/被跳过？）`
  }

  if (salvedFrom && !rec.problem) {
    rec.note = `salvage：${Math.round((gate.timeoutMs || GATE_TIMEOUT_MS) / 60000)} 分钟到点被强杀，但结论已完整落盘 ⇒ 按有效记账`
  }
  return rec
}

function argline(a) {
  return a.join(' ')
}

// ------------------------------------------------------------------ 主流程

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true })

  if (listOnly) {
    log('可用闸门：')
    for (const g of GATES) log(`  ${g.id.padEnd(10)} ${g.name}`)
    return
  }

  const gates = only.length ? GATES.filter((g) => only.includes(g.id)) : GATES
  if (!gates.length) {
    log(`--only 没匹配到任何闸门。可用：${GATES.map((g) => g.id).join(' / ')}`)
    process.exitCode = 2
    return
  }

  log('='.repeat(64))
  log(`一键验证：${gates.length} 道闸门`)
  log('='.repeat(64))

  const needServer = gates.some((g) => g.needsServer)
  let serverNote = ''
  let serverOk = true
  if (needServer) {
    const s = await ensureServer()
    serverOk = s.ok
    serverNote = s.ok ? s.how : s.why
    if (!s.ok) {
      log(`\n[失败] 后端前置条件不满足：${s.why}`)
      log('       依赖后端的闸门整组跳过，其余闸门继续。')
    }
  }

  /**
   * 后端没起来时不能算通过。
   * 之前这里只是把 needsServer 的闸门逐条 SKIP，最后照样打印 VERIFY_PASSED ——
   * 于是"服务根本没启动"和"全部真跑过一遍"给出同一个绿灯，是最坏的一类假绿。
   */
  const serverBlocked = needServer && !serverOk

  log(`\n后端前置：${needServer ? serverNote : '本次闸门不需要'}\n`)

  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i]
    const idx = GATES.indexOf(gate)
    log('-'.repeat(64))
    log(`[${i + 1}/${gates.length}] ${gate.name}`)
    log(`         ${argline(gate.argv.slice(1))}`)
    log('-'.repeat(64))

    if (gate.needsServer && !serverOk) {
      results.push({ gate, skipped: true, why: `后端未就绪：${serverNote}` })
      log(`[SKIP] ${gate.name} :: 后端未就绪`)
      continue
    }

    const rec = runGate(gate, idx)
    // 回显留给现场的尾部，避免刷屏又能看到结论
    const tail = fs.readFileSync(rec.logFile, 'utf8').trimEnd().split('\n').slice(-4).join('\n')
    log(tail)

    if (rec.problem) {
      results.push({ gate, ok: false, detail: rec.problem, logFile: rec.logFile })
      log(`[FAIL] ${gate.name} :: ${rec.problem}  （完整日志：${path.relative(root, rec.logFile)}）`)
    } else {
      // 有的闸门只报总数（如静态检查：校验了 N 条），没有通过/失败之分，
      // 这里不能硬拼 "通过 undefined"。
      const detail =
        rec.passed === null
          ? `断言 ${rec.total} 项`
          : `断言 ${rec.total} 项，通过 ${rec.passed}${rec.skippedN ? `，跳过 ${rec.skippedN}` : ''}`
      // salvage 救回来的条目必须**看得见**：不标注的话，"收尾卡住"会变成一种
      // 无声的常态，下一次真出现"断言没跑完"时也没人会多看一眼。
      const detailWithNote = rec.note ? `${detail}；${rec.note}` : detail
      results.push({ gate, ok: true, detail: detailWithNote, logFile: rec.logFile })
      log(`[PASS] ${gate.name} :: ${detailWithNote}`)
    }
    log('')

    /**
     * 闸门之间的喘息间隔（700ms，只对**真跑过 Electron/ffmpeg 的闸门**生效）。
     *
     * 为什么要有（2026-10-02 全量实测）：全量轮跑到后段时，前几道 E2E 的
     * Electron 进程还没退干净、句柄还没释放，紧接着的 spawn 类系统调用开始
     * 间歇性 EBUSY —— 表现为「ffmpeg -version 拉不起来」「测试 profile 重试后
     * 仍被占用」。**同一份产物隔离复跑全部 36/36、12/12、71 项全绿** ⇒
     * 不是代码回归，是资源竞争。全量一次 10 分钟，加 700ms×~40 = 28s，
     * 换掉每轮 3-4 道假红（假红会训练人无脑忽略闸门），划算。
     */
    const heavy = /e2e|installer|render|media|shoot/i.test(gate.id)
    if (heavy && i < gates.length - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700)
    }
  }

  stopServer()

  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => r.ok === false).length
  const skipped = results.filter((r) => r.skipped).length

  log('='.repeat(64))
  log(`一键验证：${passed}/${results.length} 通过，${failed} 失败，${skipped} 跳过`)
  if (skipped) {
    log('跳过项：')
    for (const r of results.filter((x) => x.skipped)) log(`  - ${r.gate.name} :: ${r.why}`)
  }
  if (serverBlocked) {
    log(`后端未就绪（${serverNote}），依赖后端的闸门整组没跑 —— 本次不判通过。`)
  }
  if (failed || serverBlocked) {
    if (failed) {
      log('失败项：')
      for (const r of results.filter((x) => x.ok === false)) log(`  - ${r.gate.name} :: ${r.detail}`)
    }
    log('VERIFY_FAILED')
  } else {
    log('VERIFY_PASSED')
  }
  log(`日志目录：${path.relative(root, EVIDENCE)}`)
  log('='.repeat(64))

  process.exitCode = failed > 0 || serverBlocked ? 1 : 0
}

main()
  .catch((e) => {
    console.error('\n[verify 自身异常]', e && e.stack ? e.stack : e)
    stopServer()
    process.exitCode = 2
  })
  .finally(() => {
    // 显式退出：闸门里的 playwright / Electron 连接会让事件循环常驻
    process.exit(process.exitCode || 0)
  })
