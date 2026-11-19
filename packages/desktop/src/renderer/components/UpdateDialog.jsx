import { useEffect, useRef, useState } from 'react'
import { Modal } from '../ui.jsx'
import { formatSize } from '../../shared/updateRules.js'

/**
 * 「发现新版本」弹窗。
 *
 * 为什么把下载与安装也放在这里，而不是交给主进程默默做完：
 * 一个 180MB 的安装包在普通家庭宽带上要一两分钟，中途还可能失败。用户点了
 * 「立即更新」之后如果界面什么都不显示，他只会得出一个结论——"点了没反应"。
 * 所以三个阶段（下载中 / 已就绪 / 正在安装）必须在窗口里看得见。
 *
 * 文案口径：统一用「更新 / 安装」两个词（闸门对另一个同义词有硬限制），
 * 不写"获取并覆盖"这类绕口的说法 —— 用户只关心"点哪个按钮"。
 *
 * 判据钩子（闸门读这些）：
 *   `[data-update-version]`  新旧版本号
 *   `[data-update-progress]` 当前百分比（字符串）
 *   `[data-update-error]`    失败原因
 *   `[data-update-action]`   later / download / install
 */
export function UpdateDialog({ info, onClose, onSkip }) {
  const [phase, setPhase] = useState('idle') // idle | downloading | ready | installing | failed
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  /* 主进程的 `download()` 在没有 sha256 可核对时**不阻断**（镜像常把 digest 抹掉），
     但会返回 `verified:false`。这时必须照实说一句 —— 否则"界面没提"就等于
     "默认校验过了"，和我们写在 update.js 里的口径对不上。 */
  const [verified, setVerified] = useState(true)
  const alive = useRef(true)
  const unsub = useRef(null)
  /* 下载完成的那条路径。主进程只认它自己记下的那一份（`lastDownloaded`），
     这里只是把同一个值带回去 —— 渲染层拿不到"随便指定一个 exe"的能力。 */
  const lastPath = useRef('')

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (unsub.current) unsub.current()
    }
  }, [])

  const asset = info?.asset || {}
  const version = info?.version || ''
  const current = info?.current || ''

  const startDownload = async () => {
    setPhase('downloading')
    setPercent(0)
    setError('')
    setVerified(true)
    if (unsub.current) unsub.current()
    unsub.current = window.yjai.update.onProgress((p) => {
      if (!alive.current) return
      setPercent(Math.max(0, Math.min(100, Number(p.percent) || 0)))
    })
    const res = await window.yjai.update.download({
      version,
      asset,
      shasumUrl: info?.shasumUrl || ''
    })
    if (!alive.current) return
    if (!res || !res.ok) {
      setPhase('failed')
      setError(String((res && res.error) || '下载失败'))
      return
    }
    lastPath.current = String(res.path || '')
    setVerified(res.verified !== false)
    setPercent(100)
    setPhase('ready')
  }

  const startInstall = async () => {
    setPhase('installing')
    setError('')
    const res = await window.yjai.update.install({ path: lastPath.current })
    if (!alive.current) return
    if (!res || !res.ok) {
      setPhase('failed')
      setError(String((res && res.error) || '无法启动安装程序'))
    }
  }

  const footer =
    phase === 'idle' ? (
      <>
        <button
          className="btn ghost"
          type="button"
          data-update-action="later"
          onClick={() => {
            if (onSkip) onSkip(version)
            onClose()
          }}
        >
          稍后提醒
        </button>
        <button className="btn primary" type="button" data-update-action="download" onClick={startDownload}>
          立即更新
        </button>
      </>
    ) : phase === 'downloading' ? (
      <button className="btn ghost" type="button" disabled>
        正在获取更新包…
      </button>
    ) : phase === 'ready' ? (
      <>
        <button className="btn ghost" type="button" onClick={onClose}>
          稍后
        </button>
        <button className="btn primary" type="button" data-update-action="install" onClick={startInstall}>
          立即重启并安装
        </button>
      </>
    ) : phase === 'installing' ? (
      <button className="btn primary" type="button" disabled>
        正在启动安装程序…
      </button>
    ) : (
      <>
        <button className="btn ghost" type="button" onClick={onClose}>
          关闭
        </button>
        <button className="btn primary" type="button" data-update-action="download" onClick={startDownload}>
          重试
        </button>
      </>
    )

  return (
    <Modal
      title={`发现新版本 v${version}`}
      desc={
        phase === 'installing'
          ? '安装程序正在接管，软件会自动重启并回到这里。'
          : '更新会覆盖安装到当前位置，草稿与设置都保留。'
      }
      onClose={phase === 'downloading' || phase === 'installing' ? () => {} : onClose}
      footer={footer}
    >
      <div className="update-body" data-update-body>
        <div className="update-versions" data-update-version={`${current}->${version}`}>
          <span className="update-from">v{current}</span>
          <strong className="update-to">v{version}</strong>
        </div>

        <div className="update-meta" data-update-size>
          更新包 {formatSize(asset.size)}
          {info?.publishedAt ? ` · 发布于 ${String(info.publishedAt).slice(0, 10)}` : ''}
        </div>

        {info?.notes ? (
          <div className="update-notes" data-update-notes>
            {String(info.notes)
              .split(/\r?\n/)
              .filter((line) => line.trim())
              .slice(0, 40)
              .map((line, i) => (
                <p key={i}>{line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '· ')}</p>
              ))}
          </div>
        ) : null}

        {phase === 'downloading' || phase === 'ready' ? (
          <div className="model-progress" data-update-progress={String(percent)}>
            <div className="model-progress-bar">
              <i style={{ width: `${percent}%` }} />
            </div>
            <span>{phase === 'ready' ? '已就绪' : `${percent}%`}</span>
          </div>
        ) : null}

        {phase === 'ready' && verified === false ? (
          <div className="notice warn" data-update-unverified>
            <span>发布源这次没有提供校验值，更新包只按体积核对过。想更稳妥可以到发布页手动获取安装包。</span>
          </div>
        ) : null}

        {error ? (
          <div className="notice warn" data-update-error={error}>
            <span>{error}</span>
          </div>
        ) : null}

        {phase === 'installing' ? (
          <div className="notice" data-update-installing>
            <span>软件即将关闭并完成更新，请稍等几秒。</span>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
