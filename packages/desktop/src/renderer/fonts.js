/**
 * 自定义字体（渲染层）。
 *
 * 导入流程：主进程把 .ttf/.otf/.ttc 复制进 `userData/fonts/` 并把路径登记进
 * `yjai-media` 白名单 → 这里 `fetch(url)` 取二进制 → `new FontFace(家族名, buffer)`
 * → `document.fonts.add()`。
 *
 * 为什么用 FontFace + ArrayBuffer 而不是 `@font-face { src: url(yjai-media://...) }`：
 *   1. 自定义协议在 CSS 里的字体加载路径没有被实测过（Chromium 对未知 scheme 的
 *      font-face 处理各不相同），失败时**没有任何报错**，只是字体不生效；
 *   2. 走 fetch 能拿到明确的异常（403 / 404），可以把"字体没加载上"如实告诉用户，
 *      而不是让预览静默退回系统字体。
 *
 * ⚠️ 家族名必须是**纯 ASCII 标识符**（`YJF_<hash>`）：中文字体名进 CSS 需要转义，
 *    一旦漏转义，整条 font-family 会失效，而且是静默的。
 */

/** 字体 id → CSS 家族名。⚠️ 与 shared/textOverrides.js 的白名单校验 `^[\w-]+$` 对齐 */
export const fontFamilyOf = (id) => `YJF_${String(id || '').replace(/[^\w-]/g, '')}`

/** 已注册的家族名集合（避免重复 add；重复 add 同一个家族会多占一份内存） */
const loaded = new Set()

/**
 * 注册一个字体。返回 true 表示**浏览器里真的能用了**。
 *
 * ⚠️ 失败必须返回 false 且不抛：字体是增强项，加载失败不该让整个界面炸掉，
 *    但也**不能当成功** —— 调用方要据此在界面上标出"这个字体没加载上"。
 */
export async function registerFont(font) {
  const id = font && font.id
  const url = font && font.url
  if (!id || !url) return false
  const family = fontFamilyOf(id)
  if (loaded.has(family)) return true
  try {
    const response = await fetch(url)
    if (!response.ok) return false
    const buffer = await response.arrayBuffer()
    if (!buffer.byteLength) return false
    const face = new FontFace(family, buffer)
    await face.load()
    document.fonts.add(face)
    loaded.add(family)
    return true
  } catch {
    return false
  }
}

/** 批量注册；返回成功与失败的 id 列表（失败的要能说出来，不能静默） */
export async function registerFonts(list) {
  const ok = []
  const failed = []
  for (const font of Array.isArray(list) ? list : []) {
    // eslint-disable-next-line no-await-in-loop
    const fine = await registerFont(font)
    if (fine) ok.push(font.id)
    else failed.push(font.id)
  }
  return { ok, failed }
}

/** 这个字体家族目前在浏览器里是不是真的可用（面板据此显示"未加载"） */
export const fontReady = (font) => Boolean(font && loaded.has(fontFamilyOf(font.id)))
