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

  /**
   * 素材包：把草稿与它引用的全部素材打成一个 `.yjpack`（标准 zip），
   * 或者把别人给的包解出来、存成一份新草稿。
   *
   * ⚠️ 渲染层只交"草稿数据"和"名字"，**路径与解包目录全在主进程决定** ——
   *    否则等于把"往任意位置写文件"的能力交给页面。
   */
  pack: {
    inspect: (data) => ipcRenderer.invoke('pack:inspect', data),
    export: (payload) => ipcRenderer.invoke('pack:export', payload),
    import: () => ipcRenderer.invoke('pack:import')
  },

  media: {
    /* options.mode = 'link'（留在原处）| 'copy'（复制进草稿目录）。
       以前这里不接受参数，界面上那个"导入方式"开关就只能是个装饰。 */
    pick: (options) => ipcRenderer.invoke('media:pick', options || {}),
    stat: (paths) => ipcRenderer.invoke('media:stat', paths),
    url: (filePath) => ipcRenderer.invoke('media:url', filePath),
    extractAudio: (payload) => ipcRenderer.invoke('media:extractAudio', payload),
    /** 波形峰值：主进程用 ffmpeg 抽 PCM 算好再给回渲染层（视频容器也稳） */
    peaks: (payload) => ipcRenderer.invoke('media:peaks', payload),
    /** 场景切换检测：ffmpeg 的画面差异检测（返回源文件里的绝对秒数，换算在渲染层） */
    scenes: (payload) => ipcRenderer.invoke('media:scenes', payload),
    /** 预览代理：按画质档位生成（或复用）一份低分辨率文件，**只给预览用** */
    proxy: (payload) => ipcRenderer.invoke('media:proxy', payload),
    /** HDR 体检：返回 [{ path, hdr, label, hint }]（导出会自动做 SDR 色调映射） */
    hdr: (paths) => ipcRenderer.invoke('media:hdr', paths),
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

  /**
   * 自定义字体：pick 打开字体对话框（复制进 userData/fonts 并登记白名单），
   * allow 在恢复草稿时把已导入字体的路径重新登记（进程重启后白名单是空的）。
   *
   * ⚠️ 只暴露这两个方法，不暴露"任意路径进白名单"——那等于把访问控制交给渲染层。
   *    allow 只接受**已经导入过**的路径（主进程仍会校验它是不是一个存在的文件）。
   */
  font: {
    pick: () => ipcRenderer.invoke('font:pick'),
    allow: (paths) => ipcRenderer.invoke('font:allow', paths)
  },

  /**
   * 录音配音（麦克风在**渲染层**采，落盘在主进程）。
   * 只暴露"把字节交给主进程保存"这一个动作，不暴露任何路径参数 ——
   * 与 extractAudio 同一道防线：渲染层拿不到"往任意位置写文件"的能力。
   */
  recorder: {
    save: (payload) => ipcRenderer.invoke('recording:save', payload)
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
