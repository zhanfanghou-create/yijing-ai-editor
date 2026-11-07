/**
 * 首页左栏「无线画布」—— 发行方在线工作台的入口地址**唯一真源**。
 *
 * 为什么要有这个文件，而不是把地址写在组件里：
 *   ① 地址同时被两处用（首页导航文案的判据、iframe 的 src），
 *      各写一份的结果是"改了地址只有一处生效"——最典型的症状是导航还在、
 *      点开的却是老页面，用户以为是缓存问题。
 *   ② CSP 的 `frame-src` 是静态 HTML，无法 import 这里，但必须是同一个源；
 *      改地址时两处一起改（index.html 的注释里也写了这条，互相指认）。
 *
 * ⚠️ 下面这行豁免是**显式的、必须留痕的**：本仓库的开源洁净闸门（tools/check-oss-clean.mjs）
 *    把生产服务地址列为禁用词，因为这个版本对外承诺「纯单机、无服务端」。
 *    这个入口是发行方自己的在线工作台，属于**已知且有意**的例外，所以写一条豁免声明
 *    而不是换个目录藏起来 —— 闸门失明比闸门报红危险得多。
 *    如果你要一个"零服务地址"的纯净构建：把 APP_LINK.url 置成空串，
 *    首页左栏那一项会自己消失（见 appLinkOf），其余功能不受影响。
 */
// oss-clean-allow: yjai.top
const APP_LINK = {
  key: 'canvas',
  /** 首页左栏那一项的文案 */
  label: '无线画布',
  url: 'https://www.yjai.top/app/'
}

/**
 * 解析出入口；不可用（空地址 / 非法 URL）时返回 null，调用方据此**不渲染**这一项。
 *
 * 不做「出错也显示入口」的兜底：地址坏了还留一颗点不动的按钮，
 * 比没有这个入口更糟 —— 用户只会觉得软件坏了。
 *
 * @returns {{key:string, label:string, url:string, origin:string}|null}
 */
function appLinkOf() {
  const url = String(APP_LINK.url || '').trim()
  if (!url) return null
  try {
    const parsed = new URL(url)
    /* 只接受 http/https：file: / javascript: 这类如果被误配进常量，
       塞进 iframe 就是本地文件读取或脚本执行。 */
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return { key: APP_LINK.key, label: APP_LINK.label, url, origin: parsed.origin }
  } catch {
    return null
  }
}

module.exports = { APP_LINK, appLinkOf }
