import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, Select, TitleBar } from './components/Shell.jsx'
import { IconDone } from './icons.jsx'
import { BRAND } from './brand.js'
import appIconUrl from './assets/app256.png'

/**
 * 艺镜AI剪辑 安装程序。
 *
 * 版式与参考安装器一致：单页式，没有多步向导。
 *   - 收起态窗口 650×360；点「安装设置」→ 650×560，底部展开语言 / 安装路径设置区。
 *   - 未勾选协议时主按钮不动作，并把协议文字标红提示。
 *   - 安装中 / 完成 / 失败三种状态复用同一套版式，不改变视觉语言。
 */

/** 窗口高度（与 styles.css 的 --win-h / --win-h-expanded 保持一致） */
const H_COLLAPSED = 360
const H_EXPANDED = 560

/**
 * 客户端支持的界面语言。
 * 当前产品仅简体中文；将来新增语言 = 在此加一项 + 客户端补语言包，界面无需改动。
 */
const LANG_OPTIONS = [{ value: 'zh-CN', label: '简体中文' }]

const PHASE_ORDER = ['verify', 'prepare', 'extract', 'shortcut', 'register', 'done']

/** 安装期各阶段的说明，用于进度条下方文案（progress 事件已带 label，这里作兜底） */
const PHASE_FALLBACK_LABEL = {
  verify: '校验安装包',
  prepare: '准备安装目录',
  extract: '释放主程序文件',
  shortcut: '创建快捷方式',
  register: '写入系统登记',
  done: '安装完成'
}

function resizeWindow(height) {
  const api = window.installer
  if (api && typeof api.setHeight === 'function') api.setHeight(height)
}

export default function App() {
  const [phase, setPhase] = useState('idle') // idle | installing | done | error
  const [meta, setMeta] = useState(null)
  const [agreed, setAgreed] = useState(true) // 与参考一致：默认勾选
  const [expanded, setExpanded] = useState(false)
  const [targetPath, setTargetPath] = useState('')
  const [lang, setLang] = useState(LANG_OPTIONS[0].value)
  const [progress, setProgress] = useState({ percent: 0, label: '' })
  const [errorText, setErrorText] = useState('')
  const [showLicense, setShowLicense] = useState(false)
  const [agreeHint, setAgreeHint] = useState(false)
  const [busy, setBusy] = useState(false)

  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const logsRef = useRef([])

  // ---------------------------------------------------------------- 元信息

  useEffect(() => {
    const api = window.installer
    if (!api) {
      // 浏览器预览模式：给出可交互的假数据，方便纯前端调版式
      setMeta({
        appName: BRAND.name,
        version: '1.0.0',
        defaultPath: 'C:\\Program Files\\YiJing AI Editor',
        licenseText: `（浏览器预览模式，未连接安装器运行时）\n\n${BRAND.name} 最终用户许可协议`,
        payloadOk: true
      })
      setTargetPath('C:\\Program Files\\YiJing AI Editor')
      return
    }
    api
      .getMeta()
      .then((m) => {
        setMeta(m)
        setTargetPath(m.defaultPath || '')
      })
      .catch(() => setMeta({ appName: BRAND.name, payloadOk: false, payloadError: '读取安装信息失败' }))
  }, [])

  // 卸载时把窗口高度复位，避免下次打开残留展开态
  useEffect(() => () => resizeWindow(H_COLLAPSED), [])

  // ---------------------------------------------------------------- 进度订阅

  useEffect(() => {
    const api = window.installer
    if (!api) return undefined
    const offProgress = api.onProgress((p) => {
      setProgress({ percent: p.percent || 0, label: p.label || PHASE_FALLBACK_LABEL[p.phase] || '' })
    })
    const offLog = api.onLog((l) => {
      logsRef.current = [...logsRef.current.slice(-299), l]
    })
    return () => {
      offProgress()
      offLog()
    }
  }, [])

  // ---------------------------------------------------------------- 窗口关闭

  const requestClose = useCallback(() => {
    const p = phaseRef.current
    if (p === 'installing') {
      // eslint-disable-next-line no-alert
      if (!window.confirm('安装尚未完成，确定要关闭安装程序吗？')) return
    }
    if (window.installer) window.installer.quit()
    else window.close()
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (showLicense) setShowLicense(false)
      else if (expanded && phase === 'idle') setExpanded(false)
      else requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showLicense, expanded, phase, requestClose])

  // Esc 收起设置时同步窗口高度
  useEffect(() => {
    resizeWindow(expanded ? H_EXPANDED : H_COLLAPSED)
  }, [expanded])

  // ---------------------------------------------------------------- 动作

  const toggleExpanded = useCallback(() => {
    if (phaseRef.current !== 'idle') return
    setExpanded((v) => !v)
  }, [])

  const runInstall = useCallback(
    async (path) => {
      const api = window.installer
      setPhase('installing')
      setExpanded(false)
      setErrorText('')
      setProgress({ percent: 0, label: '准备安装' })
      logsRef.current = []
      if (!api) {
        // 预览模式：跑一遍假进度，方便看安装中的版式
        for (const [i, key] of PHASE_ORDER.entries()) {
          setProgress({ percent: Math.round(((i + 1) / PHASE_ORDER.length) * 100), label: PHASE_FALLBACK_LABEL[key] })
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 420))
        }
        setPhase('done')
        return
      }
      const res = await api.start({
        targetPath: path,
        lang,
        // 快捷方式按参考软件的默认行为全部创建；开机自启默认关闭
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        autoStart: false
      })
      if (res && res.ok) {
        setProgress({ percent: 100, label: '安装完成' })
        setPhase('done')
      } else {
        setErrorText((res && res.reason) || '未知错误')
        setPhase('error')
      }
    },
    [lang]
  )

  const handleInstall = useCallback(() => {
    if (!agreed) {
      setAgreeHint(true)
      return
    }
    setAgreeHint(false)
    if (meta && meta.payloadOk === false) {
      setErrorText(meta.payloadError || '安装数据包不完整，无法继续安装')
      setPhase('error')
      return
    }
    setExpanded(false)
    runInstall(targetPath)
  }, [agreed, meta, runInstall, targetPath])

  const handlePickDirectory = useCallback(async () => {
    const api = window.installer
    if (!api) return
    const picked = await api.pickDirectory(targetPath)
    if (picked) setTargetPath(picked)
  }, [targetPath])

  const handleLaunch = useCallback(async () => {
    setBusy(true)
    if (window.installer) await window.installer.launchApp(targetPath)
    if (window.installer) window.installer.quit()
    setBusy(false)
  }, [targetPath])

  const handleOpenFolder = useCallback(async () => {
    if (window.installer && targetPath) await window.installer.openPath(targetPath)
  }, [targetPath])

  // ---------------------------------------------------------------- 派生

  const license = meta?.licenseText || `${BRAND.name} 最终用户许可协议\n\n（协议正文缺失，请重新获取安装包）`

  const primary = useMemo(() => {
    if (phase === 'installing') return null
    if (phase === 'done') return { text: '立即运行', onClick: handleLaunch }
    if (phase === 'error') return { text: '重试安装', onClick: () => runInstall(targetPath) }
    return { text: '安装', onClick: handleInstall }
  }, [phase, handleInstall, handleLaunch, runInstall, targetPath])

  return (
    <div className="window">
      <TitleBar
        onMinimize={() => window.installer && window.installer.minimize()}
        onClose={requestClose}
      />

      <img className="app-icon" src={appIconUrl} alt="" draggable="false" />

      <div className="app-title">
        {phase === 'done' ? '安装完成' : phase === 'error' ? '安装未完成' : BRAND.name}
      </div>

      {phase === 'done' ? (
        <div className="app-sub" style={{ color: '#3aa76d' }}>
          <span style={{ marginRight: 6, display: 'inline-flex', verticalAlign: '-4px' }}>
            <IconDone width={18} height={18} />
          </span>
          {BRAND.name} 已成功安装到本机
        </div>
      ) : null}

      {phase === 'installing' ? (
        <>
          <div className="progress" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="stage-text">
            {progress.label || '正在安装'}
            {/%/.test(progress.label || '') ? null : (
              <span style={{ marginLeft: 6, color: '#9d9d9d' }}>{progress.percent}%</span>
            )}
          </div>
        </>
      ) : null}

      {primary ? (
        <button
          className="btn-primary"
          onClick={primary.onClick}
          disabled={busy || (phase === 'idle' && !meta)}
        >
          {primary.text}
        </button>
      ) : null}

      {/* ---------------------------------------------------------- 底部一行 */}
      {phase === 'idle' ? (
        <div className="agree">
          <Checkbox checked={agreed} onChange={setAgreed} label="同意用户许可协议" />
          <span className="agree-text" style={agreeHint ? { color: '#e5484d' } : undefined}>
            已阅读和同意&nbsp;
            <button type="button" className="link" onClick={() => setShowLicense(true)}>
              {BRAND.name}用户许可协议
            </button>
          </span>
          <span className="agree-right">
            <button type="button" className="text-btn" onClick={toggleExpanded}>
              安装设置
            </button>
          </span>
        </div>
      ) : null}

      {phase === 'installing' ? (
        <div className="agree">
          <span className="hint" title={targetPath}>
            正在安装到 {targetPath}
          </span>
        </div>
      ) : null}

      {phase === 'done' ? (
        <div className="agree">
          <span className="hint" title={targetPath}>
            已安装到 {targetPath}
          </span>
          <span className="agree-right">
            <button type="button" className="text-btn" onClick={handleOpenFolder}>
              打开文件夹
            </button>
          </span>
        </div>
      ) : null}

      {phase === 'error' ? (
        <div className="agree" style={{ height: 'auto', maxHeight: 38, alignItems: 'flex-start' }}>
          <span className="hint warn" title={errorText} style={clampStyle}>
            {errorText}
          </span>
          <span className="agree-right">
            <button type="button" className="text-btn" onClick={handleOpenFolder}>
              打开文件夹
            </button>
          </span>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- 设置展区 */}
      {expanded ? (
        <div className="settings">
          <label className="settings-label lang" htmlFor="set-lang">
            选择语言：
          </label>
          <Select id="set-lang" value={lang} onChange={setLang} options={LANG_OPTIONS} />

          <label className="settings-label path" htmlFor="set-path">
            安装路径：
          </label>
          <div className="field-wrap path">
            <input
              id="set-path"
              className="field"
              value={targetPath}
              spellCheck={false}
              onChange={(e) => setTargetPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setExpanded(false)
              }}
            />
          </div>
          <button type="button" className="browse-btn" onClick={handlePickDirectory}>
            浏览
          </button>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- 协议全文 */}
      {showLicense ? (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setShowLicense(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="用户许可协议">
            <div className="dialog-head">
              <span>{BRAND.name} 用户许可协议</span>
              <span className="spacer" />
            </div>
            <div className="dialog-body">{license}</div>
            <div className="dialog-foot">
              <button type="button" className="dialog-btn" onClick={() => setShowLicense(false)}>
                关闭
              </button>
              <button
                type="button"
                className="dialog-btn primary"
                onClick={() => {
                  setAgreed(true)
                  setAgreeHint(false)
                  setShowLicense(false)
                }}
              >
                同意
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 错误信息最多显示两行，完整内容放 title */
const clampStyle = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  whiteSpace: 'normal',
  lineHeight: '18px'
}
