#!/usr/bin/env node
/**
 * 闸门 · 素材卡片规格：各标签的中栏卡片排版是否与参考客户端一致。
 *
 * ---------------------------------------------------------------------------
 * 为什么要在"看截图"之外再做一道闸门
 * ---------------------------------------------------------------------------
 * 「排版一致」这件事一直只能靠人眼看截图。而截图看不出下面这几种差别：
 *   · 卡片宽 100 还是 98 —— 差 2px，肉眼分不出，但那 2px 是被 `border` 吃掉的
 *     （styles.css 顶部有全局 `* { box-sizing: border-box }`，给卡片加 1px 边框
 *      就等于从内容区里扣掉 2px，预览图随之溢出、被 `overflow:hidden` 裁掉一条边）；
 *   · 列距 16 还是 15、内边距是 `8/16/8/8` 还是四个 8 —— 差 1px，同样看不出；
 *   · 卡片是"固定 100px 宽"还是"`1fr` 自适应拉宽" —— 截图里都填满一整行；
 *   · 卡片该不该有名字行 —— 参考用 `titleTextVisible: false` 关掉的那些页
 *     多出一行 22px 的名字，整页行节距就不对了。
 * 这几类恰好都是本项目的常客：**构建绿、E2E 绿、只有量真实盒子才发现**。
 *
 * ---------------------------------------------------------------------------
 * 判据从哪来（不是我们自己编的数）
 * ---------------------------------------------------------------------------
 * 参考是 Qt/QML 应用，.qml 源码以明文编在它的 exe/dll 里，所以排版常量可以直接读
 * （`tools/extract-ref-qml.mjs` 抽到 `_recon/ref-qml/`）：
 *
 *   Filter_Materials.qml        itemWidth: 100   itemHeight: 122   （第 16~17 行）
 *   Transition_Materials.qml    itemWidth: 100   itemHeight: 122   （第 14~15 行）
 *   Subtitles_Materials.qml     itemWidth: 160   itemHeight:  80   （第 31~32 行）
 *   MediaPanel_BKMaterials.qml  itemWidth: 130   itemHeight:  75   （第 110~111 行）
 *                               titleTextVisible: false            （第 105 行）
 *
 * 间距 16 / 内边距 8-16-8-8 来自滤镜/转场那两个文件里**被注释掉的旧版** `Com_Materials`：
 *     itemRowMargin: 16 / itemColumnMargin: 16 / viewTopMargin: 8 / viewLeftMargin: 8
 *     / viewRightMargin: 16
 * 之所以要引用旧版：新版这两个页改成了 `Com_MaterialPage` 包装，边距收进包装组件里了，
 * 页面上只剩 itemWidth/itemHeight；旧版注释是仓库里唯一写着这几个数的原始出处。
 *
 * ⚠️ 真值是**写死在本脚本里**的，不从被测代码 import —— 从被测代码取期望等于让
 *    被测代码自己出考卷。这里的一百、一百二十二都是参考的原文数字。
 *
 * ---------------------------------------------------------------------------
 * 为什么是 E2E（真起 Electron）而不是"读 CSS 文本"
 * ---------------------------------------------------------------------------
 * 读 CSS 只能证明"有人写了 100px"，证不了**最终生效的是不是它**：
 *   · 后面还有一条同特异性的规则把它盖掉了（本项目踩过：`display:block!important`
 *     干掉四模式门控的 `display:none`）；
 *   · 继承来的 `box-sizing` / `min-width` / `flex-shrink` 让实际盒子不等于声明值；
 *   · 网格容器的实际列宽还取决于容器宽度与 `justify-content`；
 *   · `.enh-art::after` 那种"顺带命中的后代选择器"会把装饰画到本不该有的卡片上
 *     （2026-09-24 真的发生了：视频增强的前后对比白线被画到了全部 7 个配图族上）。
 * 所以这里量的是 `getBoundingClientRect()` 的真实结果 —— 与用户看到的那个盒子同源。
 *
 * ---------------------------------------------------------------------------
 * 反空洞约定
 * ---------------------------------------------------------------------------
 * · 每个面板**必须**真的量到卡片（卡片数 0 ⇒ 报错并计 fail），否则"规格全对"会在
 *   空集合上恒真；
 * · 中途抛异常时**记一条 fail 并立 aborted 旗标**，不把没跑到的补成 SKIP ——
 *   那会把"跑到一半炸了"变成满分绿；
 * · 判据抽成纯函数 `judge()`，配 `--selftest` 做**正反两面**自证：
 *   正控制组（按真值表造的"完全正确"测量结果）必须全过；反控制组（逐条扰动）
 *   必须让**对应的那一条**红，且不许误伤别的条 —— 只证明"能红"不够，
 *   还得证明"红在对的地方"（判据名写错时，扰动会红在别的条上，看着仍然像在干活）。
 * · ⚠️ 本闸门跑的是 dist-renderer 的**构建产物**，改完渲染层要先构建。
 *
 * 用法：
 *   node tools/check-card-specs.mjs              # 真起 Electron 量真实盒子
 *   node tools/check-card-specs.mjs --selftest   # 只跑判据自证（不起 Electron，秒级）
 */

import { _electron as electron } from 'playwright-core'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
/** 工作台取景尺寸：与参考截图同尺寸，卡片规格才可比 */
const EDITOR_SIZE = [1920, 1032]
/** 中栏网格的内边距（参考 viewTopMargin / viewRightMargin / viewBottomMargin / viewLeftMargin） */
const LIGHT_GRID_PADDING = '8px 16px 8px 8px'

/**
 * 参考真值表。
 *
 * tab/node  —— 走到的路径（点顶部功能标签，再点左栏节点）
 * grid/card/preview —— 三个选择器
 * w/h/gap   —— 参考 QML 里的原文数字
 * padding   —— 要判就写字符串；写 `null` = **这条不判**（并在输出里说明为什么不判）
 * showName  —— 参考这一页有没有名字行
 * src       —— 每个数字的出处，失败时打进 detail，让人能直接去复查
 */
const EXPECT = [
  {
    id: 'filter',
    tab: 'filter',
    node: 'fl-g0',
    label: '滤镜',
    grid: '.look-grid',
    card: '.look-card',
    preview: '.look-preview',
    w: 100,
    h: 122,
    gap: 16,
    padding: LIGHT_GRID_PADDING,
    showName: true,
    /* ⚠️ 名字行的类名**逐族不同**（滤镜/转场走 `.look-*`，参考配图族走 `.enh-*`），
       所以必须写进真值表，不能写死一个 `.enh-name` —— 写死的话背景那次会"恰好"通过，
       而滤镜/转场会报"名字行 0 个"，看着像界面缺了名字，其实是判据选错了元素。 */
    nameSel: '.look-name',
    src: 'Filter_Materials.qml:16-17（itemWidth/itemHeight）+ 同文件旧版注释的 itemRowMargin/itemColumnMargin/viewTopMargin/viewLeftMargin/viewRightMargin'
  },
  {
    id: 'transition',
    tab: 'transition',
    node: 'tr-g0',
    label: '转场',
    grid: '.look-grid',
    card: '.look-card',
    preview: '.look-preview',
    w: 100,
    h: 122,
    gap: 16,
    padding: LIGHT_GRID_PADDING,
    showName: true,
    nameSel: '.look-name',
    src: 'Transition_Materials.qml:14-15（itemWidth/itemHeight）+ 同文件旧版注释的间距'
  },
  {
    id: 'background',
    tab: 'media',
    /* 2026-09-25：参考实拍确认「背景」挂在**「素材库」卡片下**（子项 背景/视频库/
       图片库/动画库），不在「素材」根下，key 随之改为 `stock-bg`。
       ⚠️ 子项要先点父卡片展开才渲染（左栏是手风琴），见下面 openNode。 */
    node: 'stock-bg',
    openNode: 'stock',
    label: '背景',
    grid: '.enh-grid.is-bg',
    card: '.enh-card.is-bg',
    preview: '.enh-art',
    w: 130,
    h: 75,
    gap: 16,
    /* ⚠️ 这一页**不判内边距**：参考只用 ColumnLayout 的 8px 空矩形 + `Layout.leftMargin: 8`
       顶出上/左内边距（MediaPanel_BKMaterials.qml 第 47~95 行），而我们的中栏内边距统一
       由 `.pane-body` 的 `padding: 12px 13px` 提供 —— 要对齐它就得动 `.pane-body`，
       而那会同时影响七个标签。那是"中栏外壳"那一批的活，不该在这里假装已经对齐。 */
    padding: null,
    /* 参考第 105 行 `titleTextVisible: false`：这一页卡片上不显示名字 */
    showName: false,
    nameSel: '.enh-name',
    src: 'MediaPanel_BKMaterials.qml:110-111（itemWidth/itemHeight）+ 第 105 行 titleTextVisible:false'
  }
]

/* ------------------------------------------------------------ 判据（纯函数） */

/**
 * 名字行那条断言的名字。
 *
 * ⚠️ 抽成函数是为了**只有一处**：`judge()` 与 `--selftest` 都要用这个名字，
 *    各写一份的话改一边忘一边，自检会去"验证"一条已经不存在的断言，
 *    而它报出来的话是"没找到断言，判据名改了？"—— 看着像脚本坏了，不像判据坏了。
 */
const nameAssertOf = (exp) =>
  `${exp.label} · ${exp.showName ? '卡片有名字行' : '卡片无名字行（参考 titleTextVisible:false）'}`

/**
 * 把"一份测量结果"判成若干条断言。
 *
 * @param exp  参考真值表的某一项
 * @param spec 真实测量结果（见下面的 page.evaluate），或自检里按真值表造出来的
 * @returns {{name: string, ok: boolean, detail: string}[]}
 *
 * ⚠️ 所有失败项的 `detail` **必须非空**：空的失败信息分不清"检测器没触发"还是
 *    "报了别的问题被过滤掉了"（这条规矩在本仓库被写死过一次，见 MEMORY）。
 */
function judge(exp, spec) {
  const out = []

  /**
   * 防空转：一条都没量到就**只报这一条**并返回。
   * 不返回的话后面每条断言都会在一个空对象上"通过"，凑出一个满分绿。
   */
  if (!spec || !spec.gridFound || !spec.cards) {
    out.push({
      name: `${exp.label} · 真的量到了卡片`,
      ok: false,
      detail: `grid=${spec ? spec.gridFound : '（没有测量结果）'} 卡片数=${spec ? spec.cards : '—'}（选择器 ${exp.grid} / ${exp.card} 一个都没命中；面板没打开、类名改了、或构建产物是旧的）`
    })
    return out
  }

  out.push({ name: `${exp.label} · 真的量到了卡片`, ok: true, detail: `${spec.cards} 张` })

  out.push({
    name: `${exp.label} · 卡片 ${exp.w}×${exp.h}`,
    ok: spec.card && spec.card.w === exp.w && spec.card.h === exp.h,
    detail: `实测 ${spec.card ? `${spec.card.w}×${spec.card.h}` : '（没量到卡片）'}（参考 ${exp.src}）`
  })

  out.push({
    name: `${exp.label} · 图铺满卡片宽（防 border 吃掉内容盒）`,
    ok: Boolean(spec.preview) && Boolean(spec.card) && spec.preview.w === spec.card.w,
    detail: `预览图 ${spec.preview ? spec.preview.w : '缺失'} vs 卡片 ${spec.card ? spec.card.w : '缺失'} —— 不等说明有东西（border/padding）在占布局`
  })

  out.push({
    name: `${exp.label} · 网格 gap ${exp.gap}px`,
    ok: spec.rowGap === `${exp.gap}px` && spec.columnGap === `${exp.gap}px`,
    detail: `rowGap=${spec.rowGap} columnGap=${spec.columnGap}`
  })

  if (exp.padding) {
    out.push({
      name: `${exp.label} · 网格内边距 ${exp.padding}`,
      ok: spec.padding === exp.padding,
      detail: `实测 ${spec.padding}`
    })
  }

  out.push({
    name: nameAssertOf(exp),
    ok: exp.showName ? spec.names === spec.cards : spec.names === 0,
    detail: `实测名字行 ${spec.names} 个 / 卡片 ${spec.cards} 个`
  })

  return out
}

/**
 * 静态契约的判据：`workbench.css` 里那条"前后对比白线"有没有收窄到视频增强。
 *
 * 抽成纯函数是为了能自证 —— 这条判据**第一次跑就自己错了**：
 * 一开始写成 `/(^|[\s,}])\.enh-art::after\s*\{/`，而收窄后的规则
 * `.enh-grid.is-enhance .enh-art::after` 里 `.enh-art` 前面**正是个空格**，
 * 于是它把收窄后的规则也当成"裸规则"，闸门自己对着一份正确的 CSS 报假红。
 * 改用"逐行取规则、再看同一行 `.enh-art::after` 之前的限定符"。
 * （本文件的这条规则写在一行里，按行判足够；将来换行了要改成按规则块切。）
 *
 * @returns {{ok: boolean, detail: string}}
 */
function dividerContract(cssText) {
  const rules = cssText
    .split('\n')
    .filter((line) => /\.enh-art::after\s*\{/.test(line))
    .map((line) => ({
      line: line.trim(),
      scoped: /\.enh-grid\.is-enhance\s/.test(line.split('.enh-art::after')[0])
    }))

  if (!rules.length) {
    return { ok: false, detail: '一条 `.enh-art::after` 规则都没有 —— 视频增强的前后对比线丢了（卡片上该有线）' }
  }
  const bare = rules.find((r) => !r.scoped)
  if (bare) {
    return { ok: false, detail: `存在没加限定符的规则：\`${bare.line}\` —— 白线会被画到全部配图族（57 张卡）上` }
  }
  return { ok: true, detail: `已收窄到 .enh-grid.is-enhance（共 ${rules.length} 条规则，全部带限定）` }
}

/* ------------------------------------------------------------------ 自检 */

/**
 * 判据自证：正控制组 + 反控制组。
 *
 * 为什么必须有：这道闸门本身只有一段正则级别的"聪明"（数字比对），
 * 出错的典型方式不是抛异常，而是**判据写在错的字段上**（比如拿 `columnGap`
 * 去比行距），于是它永远绿、或者永远在别的条上红。这些都不会自己暴露。
 */
function selfTest() {
  let pass = 0
  let fail = 0
  const problems = []
  const rec = (name, ok, detail) => {
    if (ok) {
      pass++
      console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`)
    } else {
      fail++
      const d = detail || '（没有给出原因）'
      problems.push(`${name} :: ${d}`)
      console.log(`[FAIL] ${name} :: ${d}`)
    }
  }

  /** 按真值表造一份"完全正确"的测量结果 */
  const goodSpec = (exp) => ({
    gridFound: true,
    cards: 3,
    card: { x: 0, y: 0, w: exp.w, h: exp.h },
    preview: { x: 0, y: 0, w: exp.w, h: exp.h },
    names: exp.showName ? 3 : 0,
    rowGap: `${exp.gap}px`,
    columnGap: `${exp.gap}px`,
    padding: exp.padding || '0px'
  })

  rec('自检 · 真值表的 id 不重复', new Set(EXPECT.map((e) => e.id)).size === EXPECT.length, `共 ${EXPECT.length} 项`)
  const noSrc = EXPECT.filter((e) => !e.src)
  rec('自检 · 每一项都写明了数字出处', noSrc.length === 0, noSrc.length ? `缺出处：${noSrc.map((e) => e.id).join('、')}` : `${EXPECT.length}/${EXPECT.length}`)
  /* 名字行的类名逐族不同，漏写就会静默数出 0 个 → 对 showName:true 的项会假红、
     对 showName:false 的项会**假绿**（"无名字行"本来就期望 0）。所以单独钉一条。 */
  const noNameSel = EXPECT.filter((e) => !e.nameSel)
  rec('自检 · 每一项都写明了名字行选择器', noNameSel.length === 0, noNameSel.length ? `缺 nameSel：${noNameSel.map((e) => e.id).join('、')}` : `${EXPECT.length}/${EXPECT.length}`)

  /* ---- 静态契约判据（dividerContract）的自证 ----
     这条判据第一次跑就把一份**正确**的 CSS 判成红的（正则把收窄后的规则也算成裸规则），
     所以它自己必须被自证：正控制组 + 两个方向的残缺。 */
  const dcGood = dividerContract('.enh-grid.is-enhance .enh-art::after {\n  content: "";\n}')
  rec('自检 · dividerContract 收窄后的 CSS 判通过（正控制组）', dcGood.ok, dcGood.detail)
  const dcBare = dividerContract('.enh-art::after {\n  content: "";\n}')
  rec(
    '自检 · dividerContract 裸规则判不通过',
    !dcBare.ok && /enh-art::after/.test(dcBare.detail),
    dcBare.ok ? '判成了通过 —— 收窄规则一旦被改回裸的，这条契约就不再报警' : dcBare.detail
  )
  const dcNone = dividerContract('.enh-grid { display: grid; }')
  rec(
    '自检 · dividerContract 规则整个消失判不通过',
    !dcNone.ok && /丢了/.test(dcNone.detail),
    dcNone.ok ? '判成了通过 —— 视频增强的前后对比线被删掉也没人管' : dcNone.detail
  )
  /* 混合：既有收窄的、又有裸的 ⇒ 必须判不通过（这是真实的坏法：新写一条规则时忘了加限定） */
  const dcMixed = dividerContract(
    '.enh-grid.is-enhance .enh-art::after {\n  content: "";\n}\n.enh-art::after {\n  content: "";\n}'
  )
  rec('自检 · dividerContract 收窄+裸混写判不通过', !dcMixed.ok, dcMixed.ok ? '判成了通过' : dcMixed.detail)

  for (const exp of EXPECT) {
    // ---- 正控制组：完全正确 ⇒ 必须一条不红 ----
    const all = judge(exp, goodSpec(exp))
    const red = all.filter((x) => !x.ok)
    rec(`自检 · ${exp.label} 正控制组全绿`, all.length > 0 && red.length === 0, `共 ${all.length} 条，红 ${red.length} 条${red.length ? `：${red.map((x) => x.name).join('；')}` : ''}`)

    // ---- 反控制组：逐条扰动 ⇒ 必须红在**对的那一条**上，且不误伤 ----
    /* ⚠️ 扰动要**只动一个变量**，否则测的就不是"这条判据灵不灵"。
       踩过的坑：一开始写的是"卡片宽 -2"只改 `card.w`，结果「图铺满卡片宽」那条也红了 ——
       不是误报，那条本来就是**卡与图的交叉校验**（图仍 100、卡变 98，当然不等）。
       所以这里改成"卡与图一起窄 2px"：这是"整张卡做窄了"，只该红尺寸那条；
       而"图比卡少 2px"（border 吃掉内容盒）由下一条单独覆盖。两条控制组各测一件事。 */
    const perturbs = [
      ['卡片整体窄 2px', (s) => { s.card.w = exp.w - 2; s.preview.w = exp.w - 2 }, `${exp.label} · 卡片 ${exp.w}×${exp.h}`],
      ['卡片高 -1', (s) => { s.card.h = exp.h - 1 }, `${exp.label} · 卡片 ${exp.w}×${exp.h}`],
      ['图片被吃掉 2px', (s) => { s.preview.w = exp.w - 2 }, `${exp.label} · 图铺满卡片宽（防 border 吃掉内容盒）`],
      ['列距 -1', (s) => { s.columnGap = `${exp.gap - 1}px` }, `${exp.label} · 网格 gap ${exp.gap}px`],
      ['行距 -1', (s) => { s.rowGap = `${exp.gap - 1}px` }, `${exp.label} · 网格 gap ${exp.gap}px`],
      ['卡片数为 0（空集合防空洞）', (s) => { s.cards = 0 }, `${exp.label} · 真的量到了卡片`],
      ['名字行数量反了', (s) => { s.names = exp.showName ? 0 : 3 }, nameAssertOf(exp)]
    ]
    if (exp.padding) {
      perturbs.push(['内边距换成四个 8', (s) => { s.padding = '8px' }, `${exp.label} · 网格内边距 ${exp.padding}`])
    }

    for (const [title, mutate, expectFailName] of perturbs) {
      const spec = goodSpec(exp)
      mutate(spec)
      const got = judge(exp, spec)
      const hit = got.find((x) => x.name === expectFailName)
      const others = got.filter((x) => !x.ok && x.name !== expectFailName)
      rec(
        `自检 · ${exp.label}「${title}」→ 红在「${expectFailName.replace(`${exp.label} · `, '')}」`,
        Boolean(hit) && !hit.ok && others.length === 0 && Boolean(hit.detail && hit.detail.length),
        hit
          ? `该条=${hit.ok ? '仍绿（判据没生效）' : '红'}；detail=${hit.detail && hit.detail.length ? '非空' : '空串（不允许）'}；误伤 ${others.length} 条${others.length ? `：${others.map((x) => x.name).join('；')}` : ''}`
          : `没有名为「${expectFailName}」的断言 —— 判据名与自检不一致`
      )
    }
  }

  const total = pass + fail
  console.log(`\nCARD_SPECS_SELFTEST_STATS total=${total} pass=${pass} fail=${fail}`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  if (fail) {
    console.log('CARD_SPECS_SELFTEST_FAILED')
    return 1
  }
  console.log('自检通过：判据可分辨（正控制组全绿、每条扰动都红在对的断言上）。')
  console.log('CARD_SPECS_SELFTEST_OK')
  return 0
}

/* ---------------------------------------------------------------- 结果收集 */

let pass = 0
let fail = 0
const problems = []
/** 中途炸掉时立起来：此后所有"没跑到"的项都不许静默算过 */
let aborted = null

function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`)
  } else {
    fail++
    // detail 不允许为空串 —— 空的失败信息分不清"检测器没触发"还是"报了别的问题被过滤"
    problems.push(`${name} :: ${detail || '（没有给出原因）'}`)
    console.log(`[FAIL] ${name} :: ${detail || '（没有给出原因）'}`)
  }
}

function summarize() {
  const total = pass + fail
  console.log(`\nCARD_SPECS_STATS total=${total} pass=${pass} fail=${fail}`)
  if (fail || aborted) {
    if (aborted) console.log(`CARD_SPECS_ABORTED ${aborted}`)
    for (const p of problems) console.log(`  ✗ ${p}`)
    console.log('CARD_SPECS_FAILED')
    return 1
  }
  console.log('已覆盖的标签卡片规格与参考一致。')
  console.log('CARD_SPECS_OK')
  return 0
}

/* ------------------------------------------------------------------ 主流程 */

if (process.argv.includes('--selftest')) {
  process.exit(selfTest())
}

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
delete env.YIJAI_USE_DEV_SERVER

let app = null
const pageErrors = []

try {
  // 前置：产物必须存在（否则起的是空白窗口，量不到任何东西，报出来却是"卡片数 0"）
  const dist = path.join(ROOT, 'packages', 'desktop', 'dist-renderer', 'index.html')
  if (!fs.existsSync(dist)) {
    console.log(`[FAIL] 前置 :: 构建产物不存在（${path.relative(ROOT, dist)}）—— 先构建渲染层`)
    fail++
    problems.push('前置 :: 构建产物不存在')
    aborted = 'dist-renderer/index.html 缺失'
    process.exit(summarize())
  }

  app = await electron.launch({
    executablePath: EXE,
    args: [
      MAIN,
      `--user-data-dir=${path.join(os.tmpdir(), 'yjai-e2e', '.card-specs-profile')}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ],
    cwd: ROOT,
    env
  })

  const page = await app.firstWindow()
  page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))

  const resize = async () => {
    await app
      .evaluate(async ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        if (win.isMaximized()) win.unmaximize()
        win.setContentSize(size[0], size[1])
      }, EDITOR_SIZE)
      .catch(() => {})
  }

  await resize()
  await page.waitForSelector('.app', { timeout: 25000 })
  await page.waitForTimeout(2000)

  // 首页 → 工作台
  const hero = await page.$('.home-hero-video')
  if (!hero) throw new Error('首页没渲染出 .home-hero-video，进不了工作台')
  await hero.click()
  await page.waitForTimeout(1200)
  await resize()
  await page.waitForTimeout(1200)

  /* 防空转：八个功能标签都得在（素材 / 音频 / 文字 / 特效 / 转场 / 字幕 / 滤镜 / 调节）。
     数字人页、贴纸页与在线素材页随那一版的功能一起删掉了，这里是新的基线；
     「调节」是 2026-10-22 补的真功能（写 clip.adjust，与右栏「调整」页同源）。 */
  const tabCount = await page.$$eval('.wb-tab', (els) => els.length)
  check('防空转 · 工作台有八个功能标签', tabCount === 8, `实测 ${tabCount} 个`)

  /**
   * 静态契约：「视频增强」的**前后对比白线**只许挂在 `.enh-grid.is-enhance` 下。
   *
   * 2026-09-24 的真实事故：这条线原来写成裸的 `.enh-art::after`，而 `.enh-art` 同时服务
   * `RefArtCards` —— 于是**全部 7 个配图族、共 57 张卡片**中间都被画了一道白线，
   * 而它在缩略截图里几乎看不出来（构建绿、E2E 绿、看截图也没发现）。
   *
   * 为什么这条用静态判、不量的真实 DOM：判的是"选择器有没有收窄"这一件事，
   * 静态一读就准；而要用 DOM 覆盖 57 张卡就得把 7 个族全点一遍 —— 代价大得多，
   * 且只能覆盖"当前这一个像素"，选择器怎么写照样管不住。
   * 正反两面都判：收窄后的规则**必须在**、裸的规则**必须不在**。
   */
  const wbCss = fs.readFileSync(path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'workbench.css'), 'utf8')
  const dc = dividerContract(wbCss)
  check('静态 · 前后对比线只挂在视频增强（.enh-grid.is-enhance）下', dc.ok, dc.detail)

  for (const exp of EXPECT) {
    const tab = await page.$(`.wb-tab[data-wb-tab="${exp.tab}"]`)
    if (!tab) {
      check(`${exp.label} · 标签存在`, false, `找不到 .wb-tab[data-wb-tab="${exp.tab}"]`)
      continue
    }
    await tab.click()
    await page.waitForTimeout(600)

    /* 要验的是子项时先点它的父卡片把组展开 —— 左栏是手风琴，
       子项只有在父项展开时才渲染，直接找子项会"找不到节点"。 */
    if (exp.openNode) {
      const opener = await page.$(`[data-wb-node="${exp.openNode}"]`)
      if (opener) {
        await opener.click()
        await page.waitForTimeout(400)
      }
    }

    const node = await page.$(`[data-wb-node="${exp.node}"]`)
    if (!node) {
      // 节点找不到 = 这一页根本走不到，后面量到的多半是上一页的残留
      check(`${exp.label} · 左栏节点存在`, false, `找不到 [data-wb-node="${exp.node}"]`)
      continue
    }
    await node.click()
    await page.waitForTimeout(500)

    const spec = await page.evaluate(
      ({ gridSel, cardSel, prevSel, nameSel }) => {
        const box = (el) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        }
        const grid = document.querySelector(gridSel)
        const cards = document.querySelectorAll(cardSel)
        const cs = grid ? getComputedStyle(grid) : null
        return {
          gridFound: Boolean(grid),
          cards: cards.length,
          card: box(cards[0] || null),
          preview: box(document.querySelector(prevSel)),
          /* 名字行数量：参考用 titleTextVisible 控制这一页有没有名字，
             所以数的是"卡片里面的名字行"，不是"这一页有没有 .enh-name 这种类" */
          names: document.querySelectorAll(`${cardSel} ${nameSel}`).length,
          rowGap: cs ? cs.rowGap : null,
          columnGap: cs ? cs.columnGap : null,
          padding: cs ? cs.padding : null,
          cols: cs ? cs.gridTemplateColumns : null
        }
      },
      { gridSel: exp.grid, cardSel: exp.card, prevSel: exp.preview, nameSel: exp.nameSel }
    )

    for (const r of judge(exp, spec)) check(r.name, r.ok, r.detail)
    if (!exp.padding) {
      console.log(`        （${exp.label}不判内边距：参考的上/左内边距来自页面自己的 8px 空矩形，我们的来自 .pane-body，要对齐得动中栏外壳）`)
    }
    console.log(`        （列轨：${spec.cols}；内边距：${spec.padding}）`)
  }

  // 页面错误：只记不判 —— 离线时后端请求会 403，那不是排版回归。
  // 但真出 pageerror 说明渲染层崩了，量到的盒子不可信。
  check('全程 0 个 pageerror', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '))
} catch (e) {
  // 中途炸了：记一条 fail + 立旗标，**不**把没跑到的补成 SKIP
  aborted = e && e.stack ? e.stack.split('\n')[0] : String(e)
  fail++
  problems.push(`闸门自身异常 :: ${aborted}`)
  console.log(`[FAIL] 闸门自身异常 :: ${aborted}`)
}

// 收尾：裸 await app.close() 在这个环境会一直不返回（实测挂过 7 分钟），
// 所以 race 一个 4 秒上限，到点直接退。
if (app) {
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 4000))])
}

process.exit(summarize())
