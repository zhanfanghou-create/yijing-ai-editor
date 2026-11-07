/**
 * 内嵌网页面板 —— 首页左栏「无线画布」点开后，占满右侧那块窗口。
 *
 * 位置：首页的**主区**（左栏右边整块）。不是覆盖层、不是弹窗：
 * 用户点左栏那一项，就相当于从「创作视频」切到「无线画布」这一页，
 * 再点回来就回到创作页。因为它在首页而不是剪辑器里，
 * 没有"盖住播放器"的问题，也不需要关闭按钮。
 *
 * 为什么用 <iframe> 而不是 <webview> / WebContentsView：
 *   · <webview> 要在 BrowserWindow 上开 `webviewTag`，那会拆掉当前的安全基线
 *     （contextIsolation + sandbox 的收益会被 webview 的 attach 能力抵掉）；
 *   · WebContentsView 是主进程里的独立图层，它**永远浮在渲染层之上** ——
 *     下拉菜单、toast、弹窗都会被它盖住，还要手工同步矩形（一改窗口大小就飘）；
 *   · 目标站没有 X-Frame-Options、也没有 frame-ancestors，可以直接被嵌入，
 *     而 iframe 跟着 flex 布局走：改窗口尺寸、折叠侧栏都不需要额外一行代码。
 *
 * 安全边界（这三条是"不加 sandbox 属性"的前提，改任何一条都要重新评估）：
 *   ① 跨源：iframe 的文档源是对方站点，拿不到我们渲染层的 DOM、摸不到 preload；
 *   ② 顶层导航：主进程 `will-navigate` 已接管，非本应用地址一律 preventDefault
 *      并转系统浏览器（src/main/index.js），iframe 里 target=_top 也跳不出去；
 *   ③ 弹窗：`setWindowOpenHandler` 同样接管，window.open 一律交系统浏览器。
 * 不加 `sandbox` 属性是**故意的**：sandbox 下漏写一个 token（localStorage、
 * 弹窗、下载、剪贴板）就让站内某功能静默失效，而上面三条已经把 sandbox 能防的事
 * 都防住了 —— 收益抵不上排查成本。
 */
import { useEffect, useState } from 'react'

/** 多久还没 load 就换一句文案。正常首屏 1~3 秒；12 秒是宁可慢报也别误报。 */
const SLOW_MS = 12000

export default function WebPane({ link }) {
  const [ready, setReady] = useState(false)
  const [slow, setSlow] = useState(false)

  /* 换链接（或切走再切回来、重新挂载）时把"加载中"重置 ——
     少了这个，第二次进来会直接显示一个空白的 frame（遮罩状态还停在上一轮的 ready）。 */
  useEffect(() => {
    setReady(false)
    setSlow(false)
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [link.url])

  return (
    <section className="app-web" data-web-pane={link.key} aria-label={link.label}>
      {!ready ? (
        <div className="app-web-mask" data-web-state={slow ? 'slow' : 'loading'}>
          <span className="app-web-spin" aria-hidden="true" />
          <p>{slow ? `网络有点慢，${link.label}还在加载` : `正在打开${link.label}…`}</p>
        </div>
      ) : null}

      <iframe
        className={`app-web-frame ${ready ? 'is-ready' : ''}`}
        src={link.url}
        title={link.label}
        /* 站内可能要全屏预览与"复制分享链接"，其余权限一概不给 */
        allow="fullscreen; clipboard-write"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => setReady(true)}
      />
    </section>
  )
}
