'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 只暴露白名单方法，不透传 ipcRenderer 本身。
 * sandbox: true 下 preload 仅能 require('electron') 及少量内置模块，这里只用 electron。
 */
const api = {
  getMeta: () => ipcRenderer.invoke('installer:getMeta'),
  pickDirectory: (current) => ipcRenderer.invoke('installer:pickDirectory', current),
  dirInfo: (p) => ipcRenderer.invoke('installer:dirInfo', p),
  start: (opts) => ipcRenderer.invoke('installer:start', opts),
  openPath: (p) => ipcRenderer.invoke('installer:openPath', p),
  launchApp: (dir) => ipcRenderer.invoke('installer:launchApp', dir),
  minimize: () => ipcRenderer.invoke('installer:minimize'),
  setHeight: (h) => ipcRenderer.invoke('installer:setHeight', h),
  quit: () => ipcRenderer.invoke('installer:quit'),
  onProgress: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('installer:progress', h)
    return () => ipcRenderer.removeListener('installer:progress', h)
  },
  onLog: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('installer:log', h)
    return () => ipcRenderer.removeListener('installer:log', h)
  }
}

contextBridge.exposeInMainWorld('installer', api)
