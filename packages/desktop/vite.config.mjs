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
        /shared[\\/]effects\.js$/
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
