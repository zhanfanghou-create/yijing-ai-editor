/**
 * 渲染层品牌常量。
 *
 * 与 electron/product.js 保持同步：product.js 是主进程/构建期的唯一定义源
 * （因为 preload 在 sandbox 下不能 import 渲染层模块），这里仅为界面文案提供同一组名字。
 * 改产品名时两处都要改。
 */

export const BRAND = {
  /** 完整产品名：产品名区、窗口标题、快捷方式名 */
  name: '艺镜AI剪辑',
  /** 标题栏品牌简称 */
  shortName: '艺镜AI',
  /** 英文名 */
  nameEn: 'YiJing AI Editor',
  /** 发布方 */
  publisher: '艺镜 AI 团队',
  /** 主可执行文件名 */
  exe: 'YiJingAIEditor.exe'
}
