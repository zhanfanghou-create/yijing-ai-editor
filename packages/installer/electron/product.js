'use strict'

/**
 * 产品常量：安装器与主程序共享的唯一定义源。
 *
 * 命名约定（有意区分，避免中文进入 exe 文件名 / 注册表键名带来编码风险）：
 *   APP_NAME  显示名 —— 窗口标题、快捷方式名、开始菜单文件夹、控制面板显示名
 *   APP_EXE   可执行文件名 —— 必须是纯 ASCII，供 taskkill / 快捷方式 TargetPath 使用
 *   REG_KEY   注册表键名 —— 纯 ASCII
 */

const APP_NAME = '艺镜AI剪辑'
const APP_NAME_EN = 'YiJing AI Editor'
const APP_EXE = 'YiJingAIEditor.exe'
const APP_ID = 'com.yijing.aieditor'
const REG_KEY = 'YiJingAIEditor'
const PUBLISHER = '艺镜 AI 团队'
const UNINSTALLER_NAME = 'Uninstall.exe'
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${REG_KEY}`
const AUTORUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** 安装所需磁盘空间（GB），用于「选择目录」步骤的容量校验 */
const REQUIRED_GB = 2.0

module.exports = {
  APP_NAME,
  APP_NAME_EN,
  APP_EXE,
  APP_ID,
  REG_KEY,
  PUBLISHER,
  UNINSTALLER_NAME,
  UNINSTALL_KEY,
  AUTORUN_KEY,
  REQUIRED_GB
}
