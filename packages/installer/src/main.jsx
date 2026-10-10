import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// 有意不启用 StrictMode：安装流程是一次性副作用，开发态的双重挂载会触发重复安装。
createRoot(document.getElementById('root')).render(<App />)
