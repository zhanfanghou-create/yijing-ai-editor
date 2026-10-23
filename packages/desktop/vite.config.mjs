import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 打包后由 Electron 用 file:// 加载，必须用相对路径
  base: './',
  plugins: [react()],
  /**
   * 只放行 `src/shared/` 下那两个 CJS 真源文件（speed.js / aspect.js）。
   *
   * 倍速的换算因子、画面比例，都必须**渲染层与主进程共用同一份**（各写一份就会有
   * 一边漏掉，症状是"预览与成片速度不一致""预览 1:1、成片还是 16:9"，两边单独看都没错）。
   * 但主进程是 CommonJS、且 Electron 33 内置的是 Node 20（还不支持 require 一个 ESM 文件），
   * 所以那两份真源只能写成 CJS，再由这里转成 ESM 给渲染层用。
   *
   * 只 include 这两个文件，别顺手把整个 src 都放进 commonjs 插件 ——
   * 那会让所有源码都过一遍 CJS→ESM 转换，出问题更难定位。
   */
  build: {
    commonjsOptions: {
      include: [
        /node_modules/,
        /shared[\\/]speed\.js$/,
        /shared[\\/]aspect\.js$/,
        /* ⚠️ 新增 shared 下的 CJS 模块必须同时加进这张白名单，否则渲染层 import 到的是
           一个没有 default 的空对象 —— 症状是"面板里的调节永远显示 0/滑杆拖不动"，
           构建不报错、静态扫描也看不见。 */
        /shared[\\/]adjust\.js$/,
        /shared[\\/]textOverrides\.js$/,
        /shared[\\/]effects\.js$/,
        /shared[\\/]crop\.js$/,
        /shared[\\/]audio\.js$/,
        /* 文字动画：预览必须 import 到它（否则 readTextAnim 是空对象 ⇒ 动画永远是 none） */
        /shared[\\/]textAnim\.js$/,
        /shared[\\/]reverse\.js$/,
        /* 节拍检测：检查器里的「按音频检测」要调它。
           漏了这一行 ⇒ detectBeats 是 undefined，按钮点下去直接抛 TypeError，
           而构建与静态扫描都看不见（同 speed.js 那条注释里说的道理）。 */
        /shared[\\/]beat\.js$/,
        /* 复合片段：预览侧要展开它。漏了这一行 ⇒ expandCompounds 是 undefined，
           渲染层在 useMemo 里直接抛错（整块工作台白屏）；即便不抛，复合片段也会
           被当成普通片段、画成一张空占位卡 —— "复合之后画面没了"。 */
        /shared[\\/]compound\.js$/,
        /* 多机位：预览与导出都要展开它。漏了这一行 ⇒ expandMulticams 是 undefined，
           渲染层 useMemo 直接抛错（工作台白屏），或者更糟：多机位片段被当成普通片段，
           它没有 url/path ⇒ 画面整段黑掉，而时间线上那个方块还好端端地摆着。 */
        /shared[\\/]multicam\.js$/,
        /* 时间区域：删除/复制/只导出区间都要在渲染层算一遍（主进程 require 的是同一份）。
           漏了这一行 ⇒ region 是空对象，点「删除区域」时 removeRegion 是 undefined，
           按钮点下去抛 TypeError 或者（更糟）什么都不发生，而时间线看上去毫无异常。 */
        /shared[\\/]region\.js$/,
        /* 画面层级（自由层级）：预览的层叠顺序与导出 overlay 链顺序必须是同一份比较函数。
           漏了这一行 ⇒ compareLayers 是 undefined ⇒ 排序比较器抛错或退化成"原顺序"，
           表现是「点了上移一层，预览里没动 / 成片里却动了」这种两头不一致。 */
        /shared[\\/]layers\.js$/,
        /* 场景检测：渲染层要把 ffmpeg 的时间换算成时间线秒（主进程解析同一份输出）。
           漏了这一行 ⇒ timelineCuts 是 undefined，右键「按场景分割」点下去抛 TypeError，
           而菜单看上去完全正常。 */
        /shared[\\/]scenes\.js$/,
        /* 代理/预览画质：渲染层要算「这一档要不要代理、代理文件叫什么、缩放滤镜怎么写」。
           漏了这一行 ⇒ normalizeQuality/needsProxy/proxyName 全是 undefined，
           表现是「设置里点了 540p 什么都没发生」——不报错、不白屏，最难查的那种。 */
        /shared[\\/]proxy\.js$/,
        /* 素材包：渲染层要知道"这份草稿引用了哪些素材、有几个找不到"，
           与主进程写包时用的是同一份 walk。漏了这一行 ⇒ collectSources 是 undefined，
           「导出素材包」点下去抛 TypeError，或者更糟：算出 0 个素材，
           打出一个只有 draft.json 的空包，还提示"导出成功"。 */
        /shared[\\/]pack\.js$/,
        /* 自由变形：渲染层要算四角单应矩阵 → CSS matrix3d（导出侧走 ffmpeg perspective，
           两份参数都从这一份来）。漏了 ⇒ cssWarpTransform 是 undefined，
           表现是"四角拖了、选框动了、画面一动不动"，构建完全不报错。 */
        /shared[\\/]warp\.js$/
      ]
    },
    outDir: 'dist-renderer',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200
  },
  server: {
    // 必须显式绑 127.0.0.1：不写 host 时 vite 会绑到 localhost，在 Windows 上
    // 通常落到 IPv6 回环（::1），于是 electron 主进程按 127.0.0.1:5173 去 loadURL
    // 会连不上（ECONNREFUSED），表现为"开发模式打开是白屏"。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
})
