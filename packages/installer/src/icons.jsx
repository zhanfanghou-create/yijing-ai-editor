/**
 * 内联 SVG 图标集。
 *
 * 尺寸与线宽严格对齐参考安装器的实测像素：
 *   标题栏最小化 = 12×1 横线；关闭 = 10×10 交叉线；复选框对勾 = 20×20 视图内的细勾。
 * 安装器不引入任何图标库，避免额外依赖与体积。
 */

/** 标题栏「最小化」：一条 12px 横线 */
export const IconWinMin = (p) => (
  <svg viewBox="0 0 12 12" width="12" height="12" {...p}>
    <path d="M0.5 6.5H11.5" stroke="currentColor" strokeWidth="1" fill="none" />
  </svg>
)

/** 标题栏「关闭」：10px 交叉线 */
export const IconWinClose = (p) => (
  <svg viewBox="0 0 12 12" width="12" height="12" {...p}>
    <path
      d="M1.6 1.6 10.4 10.4M10.4 1.6 1.6 10.4"
      stroke="currentColor"
      strokeWidth="1"
      fill="none"
    />
  </svg>
)

/** 复选框对勾：路径取自参考截图逐像素反推（方框 20×20 内的 3,10 → 7,13 → 16,5） */
export const IconCheck = (p) => (
  <svg viewBox="0 0 20 20" width="20" height="20" {...p}>
    <path
      d="M3.2 10.2 7.2 13.4 16.2 4.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="butt"
      strokeLinejoin="miter"
    />
  </svg>
)

/** 下拉箭头：8×5 的 V 形 */
export const IconChevronDown = (p) => (
  <svg viewBox="0 0 8 5" width="8" height="5" {...p}>
    <path d="M0.6 0.6 4 3.9 7.4 0.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

/** 成功对勾（安装完成态） */
export const IconDone = (p) => (
  <svg viewBox="0 0 24 24" width="24" height="24" {...p}>
    <path
      d="m4.6 12.4 5 5L19.6 7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/** 警示（安装失败态） */
export const IconAlert = (p) => (
  <svg viewBox="0 0 24 24" width="24" height="24" {...p}>
    <path
      d="M12 7.2v6.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    />
    <circle cx="12" cy="17.4" r="1.3" fill="currentColor" />
    <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
)

/** 文件夹（打开安装目录） */
export const IconFolder = (p) => (
  <svg viewBox="0 0 24 24" width="24" height="24" {...p}>
    <path
      d="M3.6 7.4a1.8 1.8 0 0 1 1.8-1.8h3.1l1.8 2.1h8.1a1.8 1.8 0 0 1 1.8 1.8v7.3a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
)
