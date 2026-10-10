import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 安装器渲染层：产物固定输出到 dist-renderer，供 electron/main.js 以 loadFile 加载。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    target: 'chrome120',
    assetsDir: 'assets'
  },
  server: {
    // 与 desktop 同理：显式绑 127.0.0.1。安装器主进程的 will-navigate 白名单
    // 就是按字符串比对 'http://127.0.0.1:5190' 的，绑到 ::1 会让 dev 模式被自己的白名单挡掉。
    host: '127.0.0.1',
    port: 5190,
    strictPort: true
  }
})
