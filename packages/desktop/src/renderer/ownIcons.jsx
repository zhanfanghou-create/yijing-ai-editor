/**
 * 自有图标组件 —— **本文件由 tools/build-icons.mjs 从 assets/icons/raw/ 的自绘 SVG 生成，请勿手改。**
 *
 * 版权：全部图标由 `tools/build-own-icons.mjs` 按统一规格**程序生成**（几何由脚本算出，
 * 不是描摹、不是从任何第三方资源里提取）。规格：24×24 网格、四周留 2px 安全边、
 * 线宽 1.7、圆角端点与圆角转折、单色 `currentColor`。
 *
 * 生成时做了三件归一化（原因见生成脚本注释）：
 *   1. 剥掉满画布的实心底板（本项目图标一律不带底板，底板由 CSS 提供）；
 *   2. 所有颜色 → currentColor，交给 CSS 决定实际颜色与 hover/禁用态；
 *   3. 去掉 fill-opacity / stroke-opacity / opacity，避免个别图标比周围暗一档。
 *
 * 共同 props：`size`（默认 18，同时作为宽高），其余透传到 <svg>。
 */

/** 播放　来源 IconPlay.svg */
export function IconPlay({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M8 5.5L19 12L8 18.5Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 暂停　来源 IconPause.svg */
export function IconPause({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M9.5 5v14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M14.5 5v14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 回到开头/上一帧　来源 IconSkipBack.svg */
export function IconSkipBack({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M18 6v12L8.5 12Z" fill="currentColor" stroke="none" /><path d="M6 6v12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 跳到结尾/下一帧　来源 IconSkipForward.svg */
export function IconSkipForward({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M6 6v12L15.5 12Z" fill="currentColor" stroke="none" /><path d="M18 6v12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 撤销　来源 IconUndo.svg */
export function IconUndo({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M9 14L4 9L9 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 重做　来源 IconRedo.svg */
export function IconRedo({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M15 14L20 9L15 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 20v-7a4 4 0 0 1 4-4h12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 剪刀/剪切　来源 IconScissors.svg */
export function IconScissors({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="6.5" cy="17.5" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="6.5" cy="6.5" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M8.9 8.9L19 19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M8.9 15.1L19 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 删除　来源 IconTrash.svg */
export function IconTrash({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M4 7h16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M9.5 7V5.2h5V7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.6 7L7.7 19.6h8.6L17.4 7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M10.4 10.6v6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M13.6 10.6v6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 添加　来源 IconPlus.svg */
export function IconPlus({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M12 5v14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 关闭　来源 IconClose.svg */
export function IconClose({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 确定/勾选　来源 IconCheck.svg */
export function IconCheck({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M4.5 12.5L9.5 17.5L19.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 搜索　来源 IconSearch.svg */
export function IconSearch({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M15.4 15.4L20.5 20.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 设置　来源 IconSettings.svg */
export function IconSettings({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M17.80 12.00L21.00 12.00" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /><path d="M16.10 16.10L18.36 18.36" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /><path d="M12.00 17.80L12.00 21.00" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /><path d="M7.90 16.10L5.64 18.36" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.20 12.00L3.00 12.00" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /><path d="M7.90 7.90L5.64 5.64" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /><path d="M12.00 6.20L12.00 3.00" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /><path d="M16.10 7.90L18.36 5.64" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 刷新/重置　来源 IconRefresh.svg */
export function IconRefresh({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M17.66 1v5.34h5.34" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 素材/媒体　来源 IconMedia.svg */
export function IconMedia({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3" y="4.5" width="18" height="15" rx="3" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M10.5 9.5L16 12L10.5 14.5Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 音乐　来源 IconMusic.svg */
export function IconMusic({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M9 17.5V5l10-2v12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><circle cx="6.5" cy="17.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="16.5" cy="15.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

/** 字幕　来源 IconCaption.svg */
export function IconCaption({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M6.5 15.5h8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.5 11.5h11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 文本　来源 IconText.svg */
export function IconText({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M5 6h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 6v13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 文件夹　来源 IconFolder.svg */
export function IconFolder({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M3 7.5A2 2 0 0 1 5 5.5h3.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 图层　来源 IconLayers.svg */
export function IconLayers({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M12 2.5L21.5 8L12 13.5L2.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M2.5 13L12 18.5L21.5 13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 魔法棒/AI　来源 IconWand.svg */
export function IconWand({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M4.5 19.5L15 9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /><path d="M18.50 2.30L19.33 4.67L21.70 5.50L19.33 6.33L18.50 8.70L17.67 6.33L15.30 5.50L17.67 4.67Z" fill="currentColor" stroke="none" /><path d="M9.00 2.50L9.52 3.98L11.00 4.50L9.52 5.02L9.00 6.50L8.48 5.02L7.00 4.50L8.48 3.98Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 时间/历史　来源 IconClock.svg */
export function IconClock({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 6.5v5.5L16 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 导出　来源 IconExport.svg */
export function IconExport({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M21 15v3.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M7.5 10L12 5.5L16.5 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 5.5V15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 下载　来源 IconDownload.svg */
export function IconDownload({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M21 15v3.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M7.5 8L12 12.5L16.5 8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 12.5V3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 上传　来源 IconUpload.svg */
export function IconUpload({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M16 16L12 12L8 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 12v9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M20.4 18.4A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 全屏　来源 IconFullscreen.svg */
export function IconFullscreen({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 音量　来源 IconVolume.svg */
export function IconVolume({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M4 9.5h3L12 5.5v13L7 14.5H4Z" fill="currentColor" stroke="none" /><path d="M15.5 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 静音　来源 IconVolumeOff.svg */
export function IconVolumeOff({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M4 9.5h3L12 5.5v13L7 14.5H4Z" fill="currentColor" stroke="none" /><path d="M16 9.5l5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M21 9.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 显示　来源 IconEye.svg */
export function IconEye({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M2.5 12S6 6.5 12 6.5S21.5 12 21.5 12S18 17.5 12 17.5S2.5 12 2.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

/** 隐藏　来源 IconEyeOff.svg */
export function IconEyeOff({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M2.5 12S6 6.5 12 6.5S21.5 12 21.5 12S18 17.5 12 17.5S2.5 12 2.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 20L20 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 放大　来源 IconZoomIn.svg */
export function IconZoomIn({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M16.2 16.2L21 21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M8.5 11h5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M11 8.5v5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 网格视图　来源 IconGridView.svg */
export function IconGridView({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="13" y="13" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

/** 列表视图　来源 IconListView.svg */
export function IconListView({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3.5" y="5" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M11.5 7.5h9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><rect x="3.5" y="14" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M11.5 16.5h9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 菜单　来源 IconMenu.svg */
export function IconMenu({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M4 7h16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 下拉箭头　来源 IconChevronDown.svg */
export function IconChevronDown({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M6 9.5l6 6l6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 右箭头　来源 IconChevronRight.svg */
export function IconChevronRight({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M9.5 6l6 6l-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 用户　来源 IconUser.svg */
export function IconUser({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M4.5 20.5c0-3.6 3.4-5.8 7.5-5.8s7.5 2.2 7.5 5.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 警告　来源 IconAlert.svg */
export function IconAlert({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M12 3.5L21.5 20.5h-19Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 9.5v4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="17" r="1.05" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 信息　来源 IconInfo.svg */
export function IconInfo({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 11v6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="7.8" r="1.05" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 创作视频（首页左栏）　来源 IconCreateVideo.svg */
export function IconCreateVideo({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3" y="4.5" width="18" height="15" rx="3" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 8.5v7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M8.5 12h7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 最近草稿（首页左栏）　来源 IconDraft.svg */
export function IconDraft({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M13.5 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M13.5 3.5v6h6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M8.5 13.5h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M8.5 16.8h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** AI 模板（首页左栏）　来源 IconTemplate.svg */
export function IconTemplate({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3.5" y="7.5" width="17" height="11.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M5 4.2h14l1.5 3.3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M7.2 4.4L8.7 7.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 4.4L13.5 7.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M16.8 4.4L18.3 7.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M10.6 11L14.4 13.2L10.6 15.4Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** AI 工具箱（首页左栏）　来源 IconToolbox.svg */
export function IconToolbox({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3" y="7.5" width="18" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M8 7.5V5.5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M3 12.5h18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M9.5 12.5v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M14.5 12.5v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** AI视频　来源 IconAiVideo.svg */
export function IconAiVideo({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="2.5" y="5.5" width="13.5" height="13" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M6.5 9.4L11 12L6.5 14.6Z" fill="currentColor" stroke="none" /><path d="M19.50 2.50L20.28 4.72L22.50 5.50L20.28 6.28L19.50 8.50L18.72 6.28L16.50 5.50L18.72 4.72Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** AI图片　来源 IconAiImage.svg */
export function IconAiImage({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="2.5" y="5" width="13.5" height="14" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="7" cy="9.2" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M3.6 17.6L8 12.6L10.6 15.4L12.6 13.4L15.6 17.6Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M19.50 2.00L20.28 4.22L22.50 5.00L20.28 5.78L19.50 8.00L18.72 5.78L16.50 5.00L18.72 4.22Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 视频增强　来源 IconVideoBoost.svg */
export function IconVideoBoost({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="2.5" y="5.5" width="13.5" height="13" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M6 15L9.2 11.2L11.4 13.6L15 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 9h-2.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 9v2.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M19.50 2.50L20.28 4.72L22.50 5.50L20.28 6.28L19.50 8.50L18.72 6.28L16.50 5.50L18.72 4.72Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 图片增强　来源 IconImageBoost.svg */
export function IconImageBoost({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="2.5" y="5" width="13.5" height="14" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="7" cy="9.2" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M3.6 17.6L8 12.6L10.6 15.4L12.6 13.4L15.6 17.6Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.40 12.20L7.02 13.98L8.80 14.60L7.02 15.22L6.40 17.00L5.78 15.22L4.00 14.60L5.78 13.98Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 素材库　来源 IconLibrary.svg */
export function IconLibrary({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3" y="6" width="5.5" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="9.5" y="6" width="5.5" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="16" y="6" width="5.5" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

/** 智能剪辑　来源 IconSmartCut.svg */
export function IconSmartCut({ size = 18, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3" y="6.5" width="18" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 4.2v15.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M19.60 1.70L20.30 3.70L22.30 4.40L20.30 5.10L19.60 7.10L18.90 5.10L16.90 4.40L18.90 3.70Z" fill="currentColor" stroke="none" />
    </svg>
  )
}
