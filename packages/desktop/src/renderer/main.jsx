// styles.css 必须排在最前：home.css / workbench.css 要靠后加载才能覆盖基础令牌与骨架规则。
// 若把 App 的 import 写在前面，ES module 会先求值 App 的依赖链，
// 结果基础样式反过来盖住主题样式（表现为高度、行高全按旧值走）。
import './styles.css'

import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { ToastProvider } from './ui.jsx'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>
)
