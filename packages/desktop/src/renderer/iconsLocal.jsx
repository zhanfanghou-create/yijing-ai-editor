/**
 * 手绘图标全集（已被参考图标接管的角色不再从这里导出，见 icons.jsx 汇总层）。
 * 统一 24x24 视图框、stroke 用 currentColor，方便跟随主题色。
 */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
}

const make = (paths) =>
  function Icon({ size = 18, ...rest }) {
    return (
      <svg width={size} height={size} {...base} {...rest} aria-hidden="true">
        {paths}
      </svg>
    )
  }
/*
 * 实心图标怎么写 —— 参考客户端的界面图标走的是**这一路**：
 * 整块 `fill="currentColor"`，镂空处靠 `fillRule="evenodd"` 的**子路径相减**做出来，
 * 而不是描一条线。左栏那几个图标（AI视频 / 视频增强 / 素材库…）在参考里全是这种画法。
 *
 * 为什么必须显式覆盖 fill/stroke：本文件 `make()` 的底色是 `fill:none + stroke:currentColor`，
 * 同一份 path 在描边模式下会变成"轮廓线"，覆盖率只有实心版的**一半**
 * （实测左栏图标列覆盖率 10.37% vs 参考 19.88%、墨水量 11.4 vs 28.7）——
 * 盒子、位置、颜色全对，只有"看着不像"，正是最难被闸门发现的那一类。
 *
 * ⚠️ 写法上必须仍然用 `make(...)`：tools/build-icons.mjs 的 parseDefs 只按
 *    `^export const X = make\(` 收集定义，别的工厂函数会被**静默丢掉**
 *    （试过加一个 makeSolid：脚本重写 iconsLocal.jsx 后该定义整个消失，且不报错）。
 *    所以实心写法是"在 path 上写 fill/stroke"，不是"换一个工厂"。
 */
export const IconMedia = make(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M8 4v16M16 4v16" />
  </>
)

/*
 * 长箭头（带箭杆）。参考首页 banner 的两个按钮用的是**这种**「→」，
 * 不是 chevron「›」：实测箭头墨迹宽 16px、且左侧有明显的横杆。
 * 用 chevron 顶替时，按钮里那 16px 的差异会被 6 倍放大的差异图直接标出来。
 */
export const IconArrowRight = make(
  <>
    <path d="M4 12h15" />
    <path d="m13.5 6.5 5.5 5.5-5.5 5.5" />
  </>
)

export const IconSparkle = make(
  <>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="m6.5 6.5 2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5" />
    <circle cx="12" cy="12" r="2.4" />
  </>
)

export const IconMusic = make(
  <>
    <path d="M9 18V6l10-2v12" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="16.5" cy="16" r="2.5" />
  </>
)

export const IconCaption = make(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 11h5M7 15h3M14.5 11H17M12.5 15H17" />
  </>
)

export const IconWand = make(
  <>
    <path d="M4 20 16 8" />
    <path d="M14 4v3M20 10h-3M18.5 5.5 16.5 7.5M18.5 14.5 16.5 12.5" />
    <path d="m12 6 2 2" />
  </>
)

export const IconFolder = make(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </>
)

export const IconExport = make(
  <>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </>
)

export const IconSettings = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a7.9 7.9 0 0 0 .1-1 7.9 7.9 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.7-1L15 4.6h-4L10.7 7a8 8 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 13a7.9 7.9 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 1.7 1L11 22.6h2l.3-2.6a8 8 0 0 0 1.7-1l2.4 1 2-3.4Z" />
  </>
)

export const IconPlay = make(<path d="M7 4 20 12 7 20Z" fill="currentColor" stroke="none" />)

export const IconPause = make(
  <>
    <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
  </>
)

export const IconSkipBack = make(
  <>
    <path d="M18 5v14L8 12Z" fill="currentColor" stroke="none" />
    <path d="M6 5v14" />
  </>
)

export const IconSkipForward = make(
  <>
    <path d="M6 5v14l10-7Z" fill="currentColor" stroke="none" />
    <path d="M18 5v14" />
  </>
)

export const IconScissors = make(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <path d="M8.2 7.6 20 18M8.2 16.4 20 6" />
  </>
)

export const IconPlus = make(<path d="M12 5v14M5 12h14" />)

export const IconTrash = make(
  <>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </>
)

export const IconRefresh = make(
  <>
    <path d="M20 7v5h-5M4 17v-5h5" />
    <path d="M18.5 12a6.5 6.5 0 0 0-11-4.6L5 10M5.5 12a6.5 6.5 0 0 0 11 4.6L19 14" />
  </>
)

export const IconDownload = make(
  <>
    <path d="M12 4v12M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </>
)

export const IconUpload = make(
  <>
    <path d="M12 20V8M7 13l5-5 5 5" />
    <path d="M4 4h16" />
  </>
)

export const IconExternal = make(
  <>
    <path d="M14 4h6v6" />
    <path d="M20 4 10 14" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </>
)

/** 礼盒：参考里最左那个金色入口（活动/福利）。用 currentColor 描边，
 *  金色由 CSS 给（.wb-icon.is-gift），这样 hover 换色不用改图标本身。
 *  ⚠️ 所有 y 坐标统一 +1.15：蝴蝶结的曲线把整幅画的墨迹包围盒顶到 y0.45..21.25，
 *  中心 10.85 而视框中心是 12 ⇒ 画出来天然高 1px（实测参考墨迹盒 y8..25，
 *  我们 y7..24）。平移后包围盒 1.6..22.4，中心回到 12。 */
export const IconGift = make(
  <>
    <rect x="3.2" y="5.75" width="17.6" height="4.6" rx="0.9" />
    <path d="M4.7 10.35h14.6v10.2a1 1 0 0 1-1 1H5.7a1 1 0 0 1-1-1z" />
    <path d="M12 5.75v15.8" />
    <path d="M12 5.75C10.9 2.85 8.5 2.45 7.7 3.45c-.9 1.1.4 2.3 4.3 2.3zM12 5.75c1.1-2.9 3.5-3.3 4.3-2.3.9 1.1-.4 2.3-4.3 2.3z" />
  </>
)

/** 侧边栏：方框里竖着切一刀 */
export const IconPanel = make(
  <>
    <rect x="3" y="4.2" width="18" height="15.6" rx="3.2" />
    <path d="M9.6 4.2v15.6" />
  </>
)

/** 消息：带小尾巴的气泡，里面一道短横（参考的形态） */
export const IconChat = make(
  <>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.2V16H6.5A2.5 2.5 0 0 1 4 13.5z" />
    <path d="M9.4 10h5.2" />
  </>
)

/** 下载：圆圈里一个下箭头 */
export const IconDownloadCircle = make(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.6v7.4M9 12.2l3 3 3-3" />
  </>
)

/** 导出：圆圈里一个上箭头 */
export const IconExportCircle = make(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 16.4V9M9 11.8l3-3 3 3" />
  </>
)

/** 「导入」按钮上的图标：圆角方块里一个加号（照参考画的） */
export const IconAddSquare = make(
  <>
    <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4.6" />
    <path d="M12 8.4v7.2M8.4 12h7.2" />
  </>
)

export const IconClose = make(<path d="m6 6 12 12M18 6 6 18" />)

export const IconMinimize = make(<path d="M5 12h14" />)

export const IconMaximize = make(<rect x="5" y="5" width="14" height="14" rx="1.5" />)

/** 还原：两个叠起来的圆角方块（窗口已最大化时显示） */
export const IconRestore = make(
  <>
    <rect x="4.2" y="7.4" width="12.4" height="12.4" rx="1.6" />
    <path d="M8.2 7.4V5.8a1.6 1.6 0 0 1 1.6-1.6h8.4a1.6 1.6 0 0 1 1.6 1.6v8.4a1.6 1.6 0 0 1-1.6 1.6h-1.6" />
  </>
)

export const IconCheck = make(<path d="m5 12 4.5 4.5L19 6" />)

export const IconAlert = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.2v.3" />
  </>
)

export const IconInfo = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8v.2" />
  </>
)

/*
 * 八角环 + 中心方块。
 *
 * 形状是从参考顶栏右侧第二枚图标的 **9 倍放大图**上量的，有两点不能想当然：
 *   1. **它不是正圆** —— 是一个尖角朝上的圆角八边形环。用正圆顶替，
 *      放大后的差异图会把八个角逐一标出来，一眼能看出不是同一个图标；
 *   2. 外接圆直径 20、宽 18.48（2r·cos22.5°），与参考实测「宽 18 / 高 20」
 *      正好吻合 —— 这条也反过来证实了它就是正八边形，不是随手画的圆。
 * 环线宽实测约 2 屏幕像素，所以单独把 strokeWidth 提上去（其余图标仍是 1.7）。
 */
export const IconRingDot = make(
  <>
    <path
      d="M12 2L19.07 4.93L22 12L19.07 19.07L12 22L4.93 19.07L2 12L4.93 4.93Z"
      strokeWidth={2.1}
    />
    <rect x="10.4" y="10.4" width="3.2" height="3.2" fill="currentColor" stroke="none" />
  </>
)

export const IconSearch = make(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </>
)

export const IconLock = make(
  <>
    <rect x="5" y="10" width="14" height="10" rx="2" />
    <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
  </>
)

export const IconUser = make(
  <>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
  </>
)

export const IconCoins = make(
  <>
    <ellipse cx="12" cy="7" rx="7" ry="3" />
    <path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7" />
    <path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
  </>
)

export const IconLayers = make(
  <>
    <path d="m12 3 8 4.5-8 4.5-8-4.5Z" />
    <path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" />
  </>
)

export const IconFilter = make(<path d="M4 5h16l-6.2 7.3V19l-3.6 2v-8.7Z" />)

export const IconVolume = make(
  <>
    <path d="M5 9h3l4-3v12l-4-3H5Z" />
    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
  </>
)

export const IconVolumeOff = make(
  <>
    <path d="M5 9h3l4-3v12l-4-3H5Z" />
    <path d="m16 10 4 4M20 10l-4 4" />
  </>
)

export const IconEye = make(
  <>
    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.6" />
  </>
)

export const IconEyeOff = make(
  <>
    <path d="M4 4 20 20" />
    <path d="M9.5 9.6A2.6 2.6 0 0 0 12 14.6" />
    <path d="M6.4 6.6C4.3 8 2.5 12 2.5 12s3.5 6 9.5 6c1.6 0 3-.4 4.2-1" />
    <path d="M18.4 15.2c1.9-1.4 3.1-3.2 3.1-3.2s-3.5-6-9.5-6c-.7 0-1.3.1-1.9.2" />
  </>
)

export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />)

export const IconChevronRight = make(<path d="m9 6 6 6-6 6" />)

export const IconZoomIn = make(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M11 8.5v5M8.5 11h5M20 20l-4.2-4.2" />
  </>
)

export const IconZoomOut = make(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M8.5 11h5M20 20l-4.2-4.2" />
  </>
)

export const IconText = make(
  <>
    <path d="M5 6h14M12 6v13M9 19h6" />
  </>
)

export const IconClock = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>
)

export const IconMenu = make(<path d="M4 7h16M4 12h16M4 17h16" />)

export const IconUndo = make(
  <>
    <path d="M9 7 4.5 11.5 9 16" />
    <path d="M4.5 11.5H14a5.5 5.5 0 0 1 0 11h-2" />
  </>
)

export const IconRedo = make(
  <>
    <path d="m15 7 4.5 4.5L15 16" />
    <path d="M19.5 11.5H10a5.5 5.5 0 0 0 0 11h2" />
  </>
)

export const IconSplit = make(
  <>
    <path d="M12 3v18" />
    <path d="M7 7.5 4 12l3 4.5M17 7.5 20 12l-3 4.5" />
  </>
)

export const IconMagnet = make(
  <>
    <path d="M6 4v7a6 6 0 0 0 12 0V4" />
    <path d="M6 9h4M14 9h4" />
  </>
)

export const IconLink = make(
  <>
    <path d="M10 13a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6" />
    <path d="M14 11a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7L12.6 18" />
  </>
)

export const IconStar = make(
  <path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8z" />
)

export const IconFlag = make(
  <>
    <path d="M6 21V4" />
    <path d="M6 5h9l-2 3 2 3H6" />
  </>
)

export const IconRatio = make(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M8 15V9h3.5M14 15l3-6" />
  </>
)

export const IconFullscreen = make(
  <>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </>
)

export const IconCreateVideo = make(
  <>
    <rect x="3" y="5.5" width="18" height="13" rx="3" />
    <path d="M10 9.6 15 12l-5 2.4Z" fill="currentColor" stroke="none" />
  </>
)

export const IconDraft = make(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M10.2 8.6 15.8 12l-5.6 3.4Z" fill="currentColor" stroke="none" />
  </>
)

export const IconTemplate = make(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2.6" />
    <path d="M3 9.2h18M9.4 9.2V20" />
    <circle cx="6.2" cy="6.7" r=".9" fill="currentColor" stroke="none" />
  </>
)

export const IconToolbox = make(
  <>
    <rect x="3" y="3" width="7.2" height="7.2" rx="1.7" />
    <rect x="13.8" y="3" width="7.2" height="7.2" rx="1.7" />
    <rect x="3" y="13.8" width="7.2" height="7.2" rx="1.7" />
    <rect x="13.8" y="13.8" width="7.2" height="7.2" rx="1.7" />
  </>
)

export const IconCrown = make(
  <path d="M3 8.6 6.6 12 12 5.6 17.4 12 21 8.6V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" fill="currentColor" stroke="none" />
)

export const IconHeadset = make(
  <>
    <path d="M4.6 14v-2.2a7.4 7.4 0 0 1 14.8 0V14" />
    <rect x="3" y="13" width="3.6" height="6.2" rx="1.7" />
    <rect x="17.4" y="13" width="3.6" height="6.2" rx="1.7" />
  </>
)

export const IconTalkingPhoto = make(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2.6" />
    <circle cx="10" cy="10" r="2.4" />
    <path d="M6.4 16.6c.9-1.7 2.1-2.5 3.6-2.5s2.7.8 3.6 2.5" />
    <path d="M16.6 9.4v3.2M19.2 10.5v1" />
  </>
)

export const IconFaceSwap = make(
  <>
    <path d="M4 9.4A4.6 4.6 0 0 1 8.6 5h3" />
    <path d="M9.3 3.2 11.5 5 9.3 6.8" />
    <path d="M20 14.6A4.6 4.6 0 0 1 15.4 19h-3" />
    <path d="M14.7 20.8 12.5 19l2.2-1.8" />
    <circle cx="12" cy="12" r="2.6" />
  </>
)

/*
 * 「AI更换」左栏专用的**实心**字形。
 *
 * 参考那一格画的是「一颗实心圆 + 一条把圆切成两半的斜向缺口」，属于
 * "实心块 + evenodd 镂空"那一路，和同排的 AI视频 / 素材库 是同一套画法。
 * 池子里 2205 个原版 SVG 里没有它 —— 换脸模块 FsFaceSwap.dll 的 62 个
 * 全是勾 / 垃圾桶 / 铅笔这类通用件，所以这一枚按参考截图比着画。
 *
 * 尺寸依据：参考该图标墨迹 14×16px（x21..34 / y393..408），
 * 圆直径 16 ⇒ 在 24 视框里取 r=8、圆心 (12,12)；缺口带宽 1.6px。
 * 斜向按参考取"左上→右下"，evenodd 让第二个子路径从圆里减掉。
 */
export const IconAiSwap = make(
  <path
    fill="currentColor"
    stroke="none"
    fillRule="evenodd"
    d="M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-9.2-1.1 1.4-1.4 20 20-1.4 1.4z"
  />
)

export const IconEraser = make(
  <>
    <path d="M4.6 15.6 12 8.2l5.4 5.4-4 4H7.2Z" />
    <path d="M9.2 20h11" />
  </>
)

export const IconSmartEdit = make(
  <>
    <path d="M6.2 20 17 6.2" />
    <circle cx="5.4" cy="7.4" r="2.2" />
    <circle cx="5.4" cy="16.6" r="2.2" />
    <path d="M15.2 4v2.6M19.8 8.8h-2.6M18.4 5.6 16.8 7.2" />
  </>
)

export const IconEnhance = make(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.6" />
    <path d="m14.4 9.4 1.2 2.1 2.1 1.2-2.1 1.2-1.2 2.1-1.2-2.1-2.1-1.2 2.1-1.2Z" fill="currentColor" stroke="none" />
    <path d="M7 10.4v5.2M4.4 13h5.2" />
  </>
)

export const IconUpscale = make(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.6" />
    <path d="M7.2 15.2v-3.4M7.2 15.2h3.4" />
    <path d="M16.8 8.8v3.4M16.8 8.8h-3.4" />
    <rect x="10.2" y="10" width="3.6" height="4" rx="1" fill="currentColor" stroke="none" />
  </>
)

export const IconCameraEmpty = make(
  <>
    <rect x="2.6" y="6.6" width="12.6" height="10.8" rx="2.2" />
    <path d="m15.2 10.6 6.2-3.2v9.2l-6.2-3.2Z" />
    <path d="M6 10.4h6v3.2H6Z" fill="currentColor" stroke="none" />
  </>
)

export const IconGridView = make(
  <>
    <rect x="3" y="3" width="8" height="8" rx="1.6" />
    <rect x="13" y="3" width="8" height="8" rx="1.6" />
    <rect x="3" y="13" width="8" height="8" rx="1.6" />
    <rect x="13" y="13" width="8" height="8" rx="1.6" />
  </>
)

export const IconListView = make(
  <>
    <rect x="3" y="4" width="5" height="5" rx="1.3" />
    <rect x="10" y="4.8" width="11" height="3.4" rx="1.7" fill="currentColor" stroke="none" />
    <rect x="3" y="12" width="5" height="5" rx="1.3" />
    <rect x="10" y="12.8" width="11" height="3.4" rx="1.7" fill="currentColor" stroke="none" />
  </>
)

/** 文生图：左文字行 → 右图片框 */
export const IconTextImage = make(
  <>
    <path d="M3 7.5h7M3 11h5M3 14.5h7" />
    <rect x="13.4" y="4.6" width="7.6" height="14.8" rx="2" />
    <circle cx="15.9" cy="8.4" r="1.05" />
    <path d="m14.7 15.6 2.2-2.6 1.8 2 1.2-1.4 1.1 1.5" />
  </>
)

/** 图生图：图片 + 编辑笔 */
export const IconImageEdit = make(
  <>
    <rect x="3" y="4" width="11" height="11" rx="2.2" />
    <circle cx="6.6" cy="7.6" r="1.2" />
    <path d="m3.6 13.4 3.2-3.4 2.8 3 1.8-1.8 2.6 2.6" />
    <path d="M15.4 20.6 21 15l-1.9-1.9-5.6 5.6-.7 2.6Z" />
  </>
)

/** 图生视频：图片 + 播放徽标 */
export const IconImageVideo = make(
  <>
    <rect x="3" y="4.4" width="14.6" height="11.4" rx="2.2" />
    <circle cx="7" cy="8.6" r="1.3" />
    <path d="m3.4 15.2 3.8-4 2.8 3" />
    <circle cx="17.4" cy="17" r="4.2" />
    <path d="m16.2 15.2 3.2 1.8-3.2 1.8Z" fill="currentColor" stroke="none" />
  </>
)

/** 视频延长：片段 + 向右延伸 */
export const IconExtend = make(
  <>
    <rect x="2.8" y="6" width="11" height="12" rx="2" />
    <path d="M6.4 12h4.2" strokeDasharray="2 2" />
    <path d="M16.8 12h4.2" />
    <path d="m19.2 9.8 2.2 2.2-2.2 2.2" />
  </>
)

/** 视频超分：片段 + 放大指示 */
export const IconVideoUpscale = make(
  <>
    <rect x="3" y="7" width="12" height="10" rx="2.2" />
    <path d="M6.6 12h4.8M9 9.6V14.4" />
    <path d="M16.2 6.8h4.6v4.6" />
    <path d="M20.8 6.8 15.6 12.2" />
  </>
)

/** 视频插帧：两帧之间插入 */
export const IconInterpolate = make(
  <>
    <rect x="2.6" y="8" width="6.2" height="8" rx="1.6" />
    <rect x="15.2" y="8" width="6.2" height="8" rx="1.6" />
    <path d="M10.2 12h3.6" />
    <path d="m12.2 10.4 1.6 1.6-1.6 1.6" />
    <path d="M4.6 12h1.4M18 12h1.4" />
  </>
)

/** 字幕翻译：文字 + A */
export const IconTranslate = make(
  <>
    <path d="M2.8 6h7.4M6.5 6V3.8" />
    <path d="M5.6 9.4c.4 2.4 1.8 4.4 3.6 5.6" />
    <path d="M3.4 15.6c2-.2 3.8-1.6 4.8-3.4" />
    <path d="M12.6 20.2 16.2 10.4l3.6 9.8" />
    <path d="M14 17.2h4.4" />
  </>
)

/** 视频配乐：影片框 + 双音符 */
export const IconMusicVideo = make(
  <>
    <rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2.4" />
    <circle cx="9.4" cy="15" r="2.2" />
    <path d="M11.6 15V8.6l5.4-1.2V13" />
    <circle cx="14.8" cy="13.6" r="2.2" />
  </>
)

/** 数字人：人像 + 光晕 */
export const IconDigitalHuman = make(
  <>
    <circle cx="12" cy="8.8" r="4" />
    <path d="M5.2 20.4c1.3-3.2 3.8-4.8 6.8-4.8s5.5 1.6 6.8 4.8" />
    <path d="M4.8 5 3.6 3.8M19.2 5l1.2-1.2M12 2.6V1.2" />
  </>
)

/** 物体消除：虚线框选 + 叉 */
export const IconObjectRemove = make(
  <>
    <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.4" strokeDasharray="3 2.6" />
    <path d="m8.6 8.6 6.8 6.8M15.4 8.6l-6.8 6.8" />
  </>
)

/** 转场：两块画面交叠 + 过渡箭头 */
export const IconTransition = make(
  <>
    <path d="M3.2 7.2a2 2 0 0 1 2-2H10v13.6H5.2a2 2 0 0 1-2-2Z" />
    <path d="M20.8 7.2a2 2 0 0 0-2-2H14v13.6h4.8a2 2 0 0 0 2-2Z" />
    <path d="M10.4 12h3.2" />
    <path d="M12.4 10.4 14 12l-1.6 1.6" />
  </>
)

/** 录音配音：一支干净的麦克风（配音按钮用；不带任何角标 —— 它是"动作"，不是"AI 能力"） */
export const IconMic = make(
  <>
    <rect x="9" y="2.8" width="6" height="10.4" rx="3" />
    <path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0" />
    <path d="M12 17.8v3.4" />
    <path d="M8.6 21.2h6.8" />
  </>
)

/** 音色克隆：麦克风 + 右上复制角标 */
export const IconVoiceClone = make(
  <>
    <rect x="9" y="2.8" width="6" height="10.4" rx="3" />
    <path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0" />
    <path d="M12 17.8v3.4" />
    <path d="M17.6 3.4h3.2v3.2" />
    <path d="M20.8 3.4 17.2 7" />
  </>
)

/** 视频变声：声波被折了一道（声音"变形"） */
export const IconVoiceChange = make(
  <>
    <path d="M2.6 12h2.6l2.2-4.4 2.6 8.8L12.6 12h2.2" />
    <path d="M17.4 8.2a4.2 4.2 0 0 1 0 7.6" />
    <path d="M20.2 5.6a7.6 7.6 0 0 1 0 12.8" />
    <path d="M14.8 12h6.2" />
    <path d="m19.4 10.6 1.6 1.4-1.6 1.4" />
  </>
)

/** AI 音效：喇叭 + 闪光（短促的"音效感"） */
export const IconSfx = make(
  <>
    <path d="M4 9.6h3l4.4-3.6v12L7 14.4H4Z" />
    <path d="M16.4 8.6v6.8" />
    <path d="M13.6 11.2v1.6" />
    <path d="M18.2 4.8 17.4 7l-2.2.8 2.2.8.8 2.2.8-2.2 2.2-.8-2.2-.8Z" />
  </>
)

/** 自动歌词：音符 + 两行唱词 */
export const IconLyrics = make(
  <>
    <circle cx="6.4" cy="16.6" r="2.6" />
    <path d="M9 16.6V7.2l7.4-1.6v9" />
    <path d="M2.6 5.4h7.8M2.6 8.4h5.4" />
    <path d="M14.4 17.6h6.8M14.4 20.2h4.6" />
  </>
)

/** 口播剪辑：声波条被剪断（去掉废话）
 *  ⚠️ 名字不能叫 IconSmartCut —— 那是参考图标已接管的角色（「智能剪辑」），
 *  同名定义会被 tools/build-icons.mjs 静默丢掉（自绘优先），界面上就换成另一个字形。 */
export const IconSpeechCut = make(
  <>
    <path d="M3.4 12h2.2M8 8.6v6.8M11.4 6v12M14.8 9.4v5.2" />
    <circle cx="6.6" cy="18.4" r="2.2" />
    <circle cx="17.4" cy="18.4" r="2.2" />
    <path d="m6.1 16.8 9.2.3M6.3 20.1 15.5 20" />
    <path d="M18.4 6.4v4.2M16.2 8.6h4.4" />
  </>
)

/** 让图片唱歌：相片 + 飘出的音符 */
export const IconSingingPhoto = make(
  <>
    <rect x="2.8" y="5.6" width="13.6" height="12.8" rx="2" />
    <path d="M2.8 15.4l3.6-3.2 3 2.6 2.6-2.2 4.4 3.4" />
    <circle cx="7.2" cy="9.4" r="1.4" />
    <path d="M18.6 4.2v6.6" />
    <circle cx="17" cy="12" r="1.9" />
    <path d="M18.9 12V9.2l2.6-.6v2.6" />
  </>
)

/** 对话数字人：两个对话气泡 + 人像 */
export const IconDialogue = make(
  <>
    <path d="M3 6.6a2 2 0 0 1 2-2h7.4a2 2 0 0 1 2 2v4.6a2 2 0 0 1-2 2H7.8L5 15.6v-2.4a2 2 0 0 1-2-2Z" />
    <path d="M20.8 12.6a2 2 0 0 0-2-2H11.6a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h3.4l2.6 2.4v-2.4h1.2a2 2 0 0 0 2-2Z" />
    <circle cx="7.6" cy="8.8" r="1.1" />
    <circle cx="10.4" cy="8.8" r="1.1" />
    <circle cx="14.8" cy="14.6" r="1.1" />
    <circle cx="17.6" cy="14.6" r="1.1" />
  </>
)

export const IconAdjust = make(
  <>
    <path d="M3.5 7h17M3.5 12h17M3.5 17h17" />
    <circle cx="9" cy="7" r="2.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="12" r="2.1" fill="currentColor" stroke="none" />
    <circle cx="7.5" cy="17" r="2.1" fill="currentColor" stroke="none" />
  </>
)

export const IconColorFilter = make(
  <>
    <circle cx="9.4" cy="9.6" r="5.4" />
    <circle cx="14.6" cy="9.6" r="5.4" />
    <circle cx="12" cy="14.4" r="5.4" />
  </>
)
