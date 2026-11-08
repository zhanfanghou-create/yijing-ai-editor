'use strict'
/**
 * 手写字幕的字体族 —— **唯一真源**（渲染层面板 + MCP catalog 都读这一份）。
 *
 * 为什么是"系统字体"而不是随包字体：
 *   · 手写体（楷体 / 行楷 / 仿宋）Windows 自带，随包再塞一份 30MB 中文字体既费体积
 *     又要处理授权；而这三个族的字形区别正是用户要的那种"手写味"；
 *   · 导出侧 `main/subtitles.js` 拿到的是**片段上的绝对路径**（`textFontPath`），
 *     它自己会 `fs.existsSync` 兜底 —— 字体被删/换了机器就退回系统黑体，
 *     不会让这条字幕凭空消失。
 *
 * ⚠️ 路径一律写**正斜杠**：`C:/Windows/Fonts/xxx.ttf`。
 *    Windows 的 fs/API 都认正斜杠，而 drawtext 的 `fontfile='...'` 里反斜杠是转义符，
 *    写成 `C:\Windows\...` 会变成"路径里丢了几个字符"，报的却是字体加载失败。
 *
 * ⚠️ 家族名必须是 ASCII 标识符：片段上落在 `textFont` 里，而
 *    `shared/textOverrides.js` 用 `^[\w-]{1,64}$` 做白名单校验 ——
 *    中文家族名（"楷体"）过不了校验，预览会静默退回默认字体。
 *
 * ⚠️ **刻意不做"本机装没装"的探测**（2026-11-09 实测后删掉的）：
 *    · `document.fonts.check('40px KaiTi')` 对任意名字都返回 true，连不存在的字体名也 true；
 *    · 用 canvas 量宽度的老办法在**中文字体上失效**：汉字是全角，任何中文字体量同一个
 *      汉字串都是"字号 × 字数"，四款手写体的实测宽度一模一样（320、320、320、320）；
 *    · 换成拉丁串也只能"确认存在"、无法"确认不存在"（楷体/仿宋/宋体都量出与 monospace
 *      相同的 400px，而宋体显然装了）。
 *    探测不可靠时**标注比不标更糟**：四张卡全写"本机没有"，用户会认定功能坏了。
 *    所以这里只给清单，把判断留给消费端 —— 点一下，预览里的字形立刻说明一切。
 *
 * CommonJS（与 shared/textOverrides.js、shared/textAnim.js 同一形制）。
 * ⚠️ 新增 shared 下的 CJS 模块必须同步加进 packages/desktop/vite.config.mjs 的
 *    `commonjsOptions.include`，否则渲染层 import 到的是空对象。
 */

/** 四个手写族。`hint` 是给用户看的差别，不是技术说明。 */
const HAND_FONTS = [
  {
    key: 'kai',
    label: '楷体',
    family: 'KaiTi',
    path: 'C:/Windows/Fonts/simkai.ttf',
    hint: '一笔一画，最像手写'
  },
  {
    key: 'stkaiti',
    label: '华文楷体',
    family: 'STKaiti',
    path: 'C:/Windows/Fonts/STKAITI.TTF',
    hint: '端正清秀'
  },
  {
    key: 'xingkai',
    label: '华文行楷',
    family: 'STXingkai',
    path: 'C:/Windows/Fonts/STXINGKA.TTF',
    hint: '连笔行书，手写味最重'
  },
  {
    key: 'fangsong',
    label: '仿宋',
    family: 'FangSong',
    path: 'C:/Windows/Fonts/simfang.ttf',
    hint: '钢笔字，适合旁白'
  }
]

/** 已导入字体的 CSS 家族名（与 renderer/fonts.js 的 fontFamilyOf 同一规则） */
const importedFamilyOf = (id) => `YJF_${String(id || '').replace(/[^\w-]/g, '')}`

/**
 * 手写字体 + 已导入字体 → 面板要列的清单。
 *
 * 已导入的字体也列进来：用户很可能自己装了手写体（站酷快乐体、汉仪手写…），
 * 那才是最像"他本人手写"的字体。
 *
 * @param {Array} imported App 里的 settings.fonts（{id,name,path}）
 */
function handFontChoices(imported) {
  const own = Array.isArray(imported) ? imported : []
  const systems = HAND_FONTS.map((item) => ({ ...item, source: 'system' }))
  const customs = own
    .filter((font) => font && font.id && font.path)
    .map((font) => ({
      key: `own-${String(font.id)}`,
      label: font.name || String(font.id),
      family: importedFamilyOf(font.id),
      path: font.path,
      hint: '已导入的字体',
      source: 'imported'
    }))
  return [...systems, ...customs]
}

module.exports = { HAND_FONTS, importedFamilyOf, handFontChoices }
