/**
 * 预加载脚本：渲染进程唯一的出口。
 *
 * 只暴露白名单方法，不透传 ipcRenderer 本身 —— 否则等于把主进程 IPC 全开给页面。
 * 本文件必须保持 CommonJS：sandbox 为 true 时 preload 不走 ESM。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('yjai', {
  /** 运行环境信息（版本、平台、打包状态、硬件加速是否生效） */
  info: () => ipcRenderer.invoke('app:info'),

  /** 重启应用（硬件加速这类启动期开关改完只能重启生效） */
  restart: () => ipcRenderer.invoke('app:restart'),

  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value)
  },

  /** 本地草稿：列表 / 覆盖保存 / 读取 / 删除，文件落在 userData/drafts */
  draft: {
    list: () => ipcRenderer.invoke('draft:list'),
    save: (payload) => ipcRenderer.invoke('draft:save', payload),
    load: (id) => ipcRenderer.invoke('draft:load', id),
    remove: (id) => ipcRenderer.invoke('draft:remove', id)
  },

  media: {
    pick: () => ipcRenderer.invoke('media:pick'),
    stat: (paths) => ipcRenderer.invoke('media:stat', paths),
    url: (filePath) => ipcRenderer.invoke('media:url', filePath),
    extractAudio: (payload) => ipcRenderer.invoke('media:extractAudio', payload),
    /** 波形峰值：主进程用 ffmpeg 抽 PCM 算好再给回渲染层（视频容器也稳） */
    peaks: (payload) => ipcRenderer.invoke('media:peaks', payload),
    /**
     * Electron 32 起 File.path 被移除，取拖拽文件的真实路径官方只给 webUtils.getPathForFile。
     * 这个方法必须在 preload 里包一层再交出去 —— File 对象过不了 contextBridge 的序列化。
     */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || ''
      } catch {
        return ''
      }
    }
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath)
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    /** 当前是否最大化（主进程是唯一事实来源） */
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    /** 最大化状态变化订阅，返回退订函数（与 render.onProgress 同一套约定） */
    onMaximizeChange: (handler) => {
      const listener = (_event, value) => handler(Boolean(value))
      ipcRenderer.on('window:maximizeChanged', listener)
      return () => ipcRenderer.removeListener('window:maximizeChanged', listener)
    }
  },

  /**
   * 成片渲染。ffmpeg 只跑在主进程（渲染进程拿不到 child_process），
   * 进度用单向事件推回来，回调返回一个退订函数。
   */
  render: {
    probe: () => ipcRenderer.invoke('render:probe'),
    pickOutput: (suggested) => ipcRenderer.invoke('render:pickOutput', suggested),
    start: (payload) => ipcRenderer.invoke('render:start', payload),
    cancel: () => ipcRenderer.invoke('render:cancel'),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload)
      ipcRenderer.on('render:progress', listener)
      return () => ipcRenderer.removeListener('render:progress', listener)
    }
  }
})
