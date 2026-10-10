import { useEffect, useState } from 'react'
import {
  IconClose,
  IconExportCircle,
  IconMaximize,
  IconMinimize,
  IconPanel,
  IconRestore
} from '../icons.jsx'
import { isDesktop } from '../platform.js'
// 与首页同一个来源（ico/ 解出的真 logo），避免两处品牌标各画一个
import logoUrl from '../assets/logo-256.png'

/**
 * 顶栏下拉菜单（「文件」「帮助」）。
 *
 * 「文件」四项：新草稿 / 打开最近项目 / 保存草稿 / 将草稿另存为。
 * 「帮助」两项：使用指引 / 关于 —— 商业化入口与甩去外链的「反馈」
 * 在开源版里整体删掉了，不是漏接（少一项要由 tools/workbench-buttons-e2e.mjs 顶红）。
 * 我们此前把「文件」直接接成 `onHome`（点了退回创作中心）——
 * 那是"图标/文案标的是 A、处理函数干的是 B"，静态检查一个字都不会说。
 *
 * 关闭行为：点菜单外任意处 / Esc，二者都退化成"关闭"——不阻断别的交互。
 * ⚠️ 顶栏整条是 `-webkit-app-region: drag`，下拉的每一步都必须 no-drag，
 * 否则被系统当成拖窗口吞掉，点了没反应。
 */
function TopMenu({ id, label, items }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest(`[data-top-menu="${id}"]`)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, id])

  return (
    <div className="wb-menu-drop no-drag" data-top-menu={id}>
      <button
        type="button"
        className={`wb-menu-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu-trigger={id}
      >
        {label}
      </button>
      {open ? (
        <div className="wb-menu-list" role="menu" data-menu-list={id}>
          {items.map((item) =>
            item.group ? (
              /* 分组标题不是可点项：渲染成 div 而不是禁用 button ——
                 禁用按钮仍会进 Tab 焦点序列并被读屏念出来，语义是错的 */
              <div className="wb-menu-group" key={item.key} data-menu-group={item.key}>
                {item.label}
              </div>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className="wb-menu-item"
                data-menu-item={item.key}
                disabled={Boolean(item.disabled)}
                title={item.title || ''}
                onClick={() => {
                  setOpen(false)
                  item.run?.()
                }}
              >
                <span className="wb-menu-item-label">{item.label}</span>
                {item.hint ? <span className="wb-menu-item-hint">{item.hint}</span> : null}
              </button>
            )
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 工作台顶栏（35px 菜单栏）。
 *
 * 形态：左侧「品牌 + 文件/设置/帮助」，中间居中显示项目名，
 * 右侧「收起素材栏 / 导出」＋ 窗口三键。
 *
 * 开源版没有账号体系，所以顶栏没有账号 / 消息 / 下载这些入口 ——
 * 它们要么依赖账号，要么依赖远端服务，留着就是点了没反应的死按钮。
 */
export default function TopBar({
  info,
  projectName,
  projectDirty = false,
  drafts = [],
  onProjectNameChange,
  onOpenSettings,
  onHome,
  onExport,
  canExport = false,
  onNewDraft,
  onOpenDraft,
  onSaveDraft,
  onSaveDraftAs,
  onOpenGuide,
  onAbout,
  railHidden = false,
  onToggleRail
}) {
  const bridge = isDesktop && typeof window !== 'undefined' ? window.yjai : null
  /** 「打开最近项目」下面直接列草稿名（参考里这是一级菜单，不是二级弹窗） */
  const recent = Array.isArray(drafts) ? drafts.slice(0, 5) : []
  const fileItems = [
    { key: 'new', label: '新草稿', run: onNewDraft },
    { key: 'recent-head', label: '打开最近项目', group: true },
    ...(recent.length
      ? recent.map((item) => ({
          key: `open:${item.id}`,
          label: item.name || '未命名草稿',
          hint: String(item.updatedAt || '').slice(0, 16).replace('T', ' '),
          title: `打开「${item.name || '未命名草稿'}」`,
          run: () => onOpenDraft?.(item)
        }))
      : [{ key: 'recent-empty', label: '没有历史记录', disabled: true }]),
    { key: 'save', label: '保存草稿', hint: projectDirty ? '有未保存改动' : '已是最新', run: onSaveDraft },
    { key: 'save-as', label: '将草稿另存为', run: onSaveDraftAs }
  ]
  const helpItems = [
    { key: 'guide', label: '使用指引', run: onOpenGuide },
    { key: 'about', label: '关于', hint: info?.version ? `v${info.version}` : '', run: onAbout }
  ]

  /* 窗口最大化状态。中间那颗窗口键要按状态画「最大化 / 还原」两套字形，
     而且用户双击标题栏、按 Win+↑、拖出屏幕等**非本应用发起**的最大化也要跟得上，
     所以走主进程的 maximize/unmaximize 事件，不是在 onClick 里自己翻转布尔值。 */
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!bridge?.window?.onMaximizeChange) return
    let alive = true
    bridge.window
      .isMaximized?.()
      .then((value) => alive && setMaximized(Boolean(value)))
      .catch(() => {})
    const off = bridge.window.onMaximizeChange((value) => setMaximized(Boolean(value)))
    return () => {
      alive = false
      if (typeof off === 'function') off()
    }
  }, [bridge])

  return (
    <header className="wb-menu topbar">
      {/* 品牌区是「回创作中心」的入口，必须 no-drag —— 处于 -webkit-app-region: drag
          区域内的元素收不到 click，会被系统当作拖动窗口吞掉 */}
      <button className="wb-menu-brand" type="button" onClick={onHome} title="返回创作中心">
        {/* 徽章 = 品牌色底板 + 图形。图形自身是「整块 256×256 都是图标」的方图，
            底色近黑，直接贴到 #0e0e13 顶栏上几乎看不出边界（实测底板只有 #000008）。
            所以底板用 CSS 渐变，图形用 screen 混合 —— 暗底被吃掉、亮部保留，
            得到「紫底板 + 亮色图形」，与参考那枚亮紫色徽章的视觉重量一致。 */}
        <span className="wb-menu-logo">
          <img src={logoUrl} alt="" />
        </span>
        <b>艺镜AI剪辑</b>
      </button>

      <div className="wb-menu-items">
        <TopMenu id="file" label="文件" items={fileItems} />
        <button type="button" onClick={onOpenSettings}>
          设置
        </button>
        <TopMenu id="help" label="帮助" items={helpItems} />
      </div>

      {/* ⚠️ 这个 input 的 style 里**不能**再写 color:'inherit' —— 行内样式优先级高于
          .wb-menu-title 的类规则，会把菜单栏的 --wb-text(#e8e8e9) 继承过来
          （实测峰值 lum 232）。参考的项目名是 **muted 灰**：峰值 #8f9497 lum 147，
          与「文件/设置/帮助」同一档。颜色交给样式表里的 var(--wb-muted)。 */}
      <input
        className="wb-menu-title no-drag"
        style={{ background: 'transparent', border: 0, textAlign: 'center', outline: 'none' }}
        value={projectName}
        onChange={(event) => onProjectNameChange(event.target.value)}
        placeholder="未命名项目"
        aria-label="项目名称"
        title="项目名称（可编辑）"
      />

      <div className="wb-menu-actions">
        {/* 侧栏折叠：图形是"侧栏"，功能就必须是折叠/展开侧栏 */}
        <button
          className={`wb-icon ${railHidden ? 'is-off' : ''}`}
          type="button"
          title={railHidden ? '展开素材栏' : '收起素材栏'}
          aria-pressed={railHidden}
          onClick={onToggleRail}
          data-topbar="rail"
        >
          <IconPanel size={22} />
        </button>

        {/* 时间线为空时导出是**禁用态**（深紫底 + 灰紫字），与参考一致；
            这不只是照着画 —— render 层对空时间线本来就返回 reason:'empty'，
            按钮亮着但点了必然失败才是真的错。
            图标 18px 是反推的：参考「导出」内芯图标墨迹宽 14，本图标墨迹比 0.7875。 */}
        <button
          className="wb-export"
          type="button"
          onClick={onExport}
          disabled={!canExport}
          title={canExport ? '导出成片' : '时间线上还没有内容，先加一段素材'}
        >
          <IconExportCircle size={18} />
          导出
        </button>

        {bridge ? (
          /* 尺寸同样是实测反推（参考三个窗口键字形墨迹：最小化 16×2、还原 18×18、关闭 12×12）。
             手绘笔画在 24 视框里留白不同 ⇒ 24 / 27 / 21 三个 size 才各自落到 16 / 18 / 12。
             ⚠️ 中间那颗是**状态相关**的：窗口最大化时参考显示的是「还原」（两个叠起来的方块）。
             我们原来一直画「最大化」，跟参考截图对不上 —— 不是图标画错，是状态没接。 */
          <div className="wb-winbtns">
            <button type="button" onClick={() => bridge.window.minimize()} aria-label="最小化">
              <IconMinimize size={24} />
            </button>
            <button
              type="button"
              onClick={() => bridge.window.toggleMaximize()}
              aria-label={maximized ? '还原' : '最大化'}
              title={maximized ? '还原' : '最大化'}
            >
              {maximized ? <IconRestore size={25} /> : <IconMaximize size={27} />}
            </button>
            <button className="danger" type="button" onClick={() => bridge.window.close()} aria-label="关闭">
              <IconClose size={21} />
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
