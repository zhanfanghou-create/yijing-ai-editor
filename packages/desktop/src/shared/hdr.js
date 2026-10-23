'use strict'
/**
 * HDR（高动态范围）素材 —— 规则真源。
 *
 * ## 这条为什么必须有
 * 手机与相机现在默认就拍 HLG / HDR10。这种片子直接按 SDR 解，画面会**发灰、发白**：
 * 预览里像蒙了层雾，成片里也一样 —— 用户的第一反应是"这软件把我的素材弄坏了"。
 * 正确的做法是导出时做一次**色调映射（tone mapping）**：把 HDR 的超标亮度压回 0–100%，
 * 色彩空间从 BT.2020 转到 BT.709。不转的话，超出 100% 的亮部会被直接裁掉（一片死白），
 * 而**画面尺寸、时长、帧率全都正常** —— 这是"看不出报错、但成片是错的"典型。
 *
 * ## 判据是标签，不是位深
 * 10-bit 不等于 HDR（10-bit SDR 也存在），8-bit 也可能是"HDR 转出来的 SDR"。
 * 唯一可靠的信号是 `color_transfer`：
 *   · `smpte2084` —— PQ（HDR10 / HDR10+ / Dolby Vision 的底层）
 *   · `arib-std-b67` —— HLG（广播 / 手机常用）
 * 所以这里只认这两个值。标签缺失（`unknown` / 空）一律**按 SDR 处理**：
 * 宁可少转一次（画面与以前完全一致），也不要凭空给 SDR 片子加一层 tonemap
 * —— 那会让老工程的成片颜色整体变掉，且没有任何迹象说明是这一步干的。
 *
 * ## 为什么把源标签**显式**写进滤镜
 * `zscale` 能自己读输入标签，但读到的可能是 `unknown`（很多 mp4 的 transfer 没写进去，
 * 或者被前面某个滤镜清掉了）。显式写 `tin/pin/min` 用的是**探测出来的真值**，
 * 于是"标签对不对"与"滤镜有没有生效"解耦：只要探测到了，就一定会按它转。
 *
 * ⚠️ 本文件是 **CommonJS**（主进程 require 拼滤镜，渲染层由 vite 的 commonjs 插件转来标注）。
 *    新增模块必须同步 `packages/desktop/src/vite.config.mjs` 之外的
 *    `packages/desktop/vite.config.mjs` 的 `commonjsOptions.include`。
 */

/** transfer → 人话（界面上直接显示，别在组件里再写一份映射） */
const HDR_TRANSFERS = {
  smpte2084: 'PQ（HDR10）',
  'arib-std-b67': 'HLG'
}

/** 色调映射算法。hable 最稳（不会把肤色推成灰），mobius 保亮部细节，none 只转色彩空间 */
const TONE_ALGOS = ['hable', 'mobius', 'none']
const DEFAULT_ALGO = 'hable'

/**
 * 目标白点（nits）。100 = 按 SDR 参考白处理，是"看起来和普通片子一样亮"的那一档。
 * 调大会整体变暗（HDR 的亮部被压得更多），一般不需要动。
 */
const REFERENCE_NITS = 100

/** 探测结果 → 规范化的四元组（缺字段一律空串，别用 undefined 拼进滤镜） */
function normalizeInfo(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const pick = (value) => {
    const text = String(value || '').trim().toLowerCase()
    return text === 'unknown' || text === 'reserved' || text === 'unspecified' ? '' : text
  }
  return {
    transfer: pick(src.transfer || src.colorTransfer || src.color_transfer),
    primaries: pick(src.primaries || src.colorPrimaries || src.color_primaries),
    matrix: pick(src.matrix || src.colorSpace || src.color_space),
    pixFmt: String(src.pixFmt || src.pix_fmt || '')
  }
}

/** 是不是 HDR（只认 transfer；见文件头"判据是标签，不是位深"） */
function isHdr(raw) {
  const info = normalizeInfo(raw)
  return Object.prototype.hasOwnProperty.call(HDR_TRANSFERS, info.transfer)
}

/** 界面上显示的短标签（'' = SDR，不用标注） */
function hdrLabel(raw) {
  const info = normalizeInfo(raw)
  const name = HDR_TRANSFERS[info.transfer]
  return name ? `HDR · ${name}` : ''
}

/** 导出时要给输出流打的标签（转完就是 SDR，标签必须跟着改，否则播放器继续按 HDR 解） */
const SDR_TAGS = { transfer: 'bt709', primaries: 'bt709', matrix: 'bt709' }

/**
 * 色调映射滤镜链（HDR → SDR）。非 HDR 输入返回空串 —— 调用方不必自己判断。
 *
 * 四步，每一步都不能省：
 *   ① `zscale ... :t=linear` —— 转到**线性**光空间（tonemap 只能在线性域里算），
 *      同时把超白（>100%）保留下来，而不是在这一步就被裁掉；
 *   ② `format=gbrpf32le` —— 32 位浮点，中间结果不能被 8/10 位量化掉；
 *   ③ `tonemap` —— 真正的"压亮度"，`desat=0` 表示不做去饱和（默认会给高光去色，
 *      看起来发灰）；`none` 时只做色彩空间转换；
 *   ④ 回 BT.709 + `format=yuv420p` —— 后面整条链（调色 / 特效 / concat）都按 8-bit 走。
 *
 * ⚠️ `tin/pin/min` 都显式写：源标签缺失或已被上游滤镜清掉时，zscale 会按 unknown 猜，
 *    猜错的表现是"画面颜色整个偏掉"（通常是偏绿或偏品红），而命令不报错。
 */
function tonemapChain(raw, options) {
  const info = normalizeInfo(raw)
  if (!isHdr(info)) return ''
  const opts = options || {}
  const algo = TONE_ALGOS.includes(String(opts.algo)) ? String(opts.algo) : DEFAULT_ALGO
  const nits = Number(opts.nits) > 0 ? Math.round(Number(opts.nits)) : REFERENCE_NITS
  /* 源矩阵缺省按 BT.2020 非恒定亮度：HDR 素材的绝大多数都是它 */
  const inMatrix = info.matrix || 'bt2020nc'
  const inPrimaries = info.primaries || 'bt2020'
  const tone = algo === 'none' ? 'tonemap=clip:desat=0' : `tonemap=${algo}:desat=0`
  return [
    `zscale=tin=${info.transfer}:pin=${inPrimaries}:min=${inMatrix}:t=linear:npl=${nits}`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    tone,
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p'
  ].join(',')
}

/**
 * 导出时给编码器补的色彩标签参数。
 *
 * 不做这一步的后果：像素**已经**是 SDR 了，但文件还标着 HDR/bt2020 ——
 * 播放器（与各种平台）继续按 HDR 解释，于是"我们自己看着正常，别人那儿发灰"。
 * 这类问题在本机永远复现不出来，只能靠标签判据。
 */
function encoderTagArgs() {
  return ['-color_primaries', SDR_TAGS.primaries, '-color_trc', SDR_TAGS.transfer, '-colorspace', SDR_TAGS.matrix]
}

/** 界面提示语（一处写清，别在两三个组件里各抄一句不一样的话） */
function previewHint(raw) {
  return isHdr(raw)
    ? 'HDR 素材：预览由浏览器直出，可能比成片略灰；导出会自动做 SDR 色调映射（BT.2020 → BT.709）。'
    : ''
}

module.exports = {
  HDR_TRANSFERS,
  TONE_ALGOS,
  DEFAULT_ALGO,
  REFERENCE_NITS,
  SDR_TAGS,
  normalizeInfo,
  isHdr,
  hdrLabel,
  tonemapChain,
  encoderTagArgs,
  previewHint
}
