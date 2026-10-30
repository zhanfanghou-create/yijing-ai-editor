#!/usr/bin/env node
/**
 * 闸门：模板（成套预设 —— 数据表 → 左栏分组 → 面板卡片 → 时间线片段 → 预览画面）。
 *
 * 这道闸门治的是**模板"看着有、其实加不上去"**那几类缺陷，全都不报错：
 *
 *   1. 数据本身不成立 —— 引用了不存在的文字样式 / 贴纸 key，或两条文字时间重叠。
 *      前者的表现是"套上去少了半套"，后者是"时间线胶片上的名字压成一团"。
 *      判据不是数模型，是 `validateTemplates()` 对着**真样式表 + 真贴纸清单**逐条核。
 *   2. 左栏没有入口 / 分组 key 写成了中文名 —— 点分类中栏空着。
 *   3. 面板点了没反应 —— 片段没进时间线，或者进去了但画面上什么都没有。
 *      这里量的是预览 DOM：`.canvas-overlay` 真的出现、正文真的是模板里那句。
 *   4. 文字排版回归 —— `maxWidth: 92%` 写在一个被 `.ta-move` 包住的内联块上时，
 *      百分比相对的是**外层那个已被内容撑开的盒子**，于是"5 个字断成 4+1 两行"。
 *      这条在真机上量**行数**，不看字号也不看宽度 —— 只有行数能直接说明它。
 *
 * 纯静态部分可单独跑（不起 Electron、不弹窗）：
 *   node tools/check-templates.mjs --static
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const STATIC_ONLY = process.argv.includes('--static')

const SRC = path.join(ROOT, 'packages', 'desktop', 'src')
const TPL_JSON = path.join(SRC, 'shared', 'templates.json')
const TPL_JS = path.join(SRC, 'shared', 'templates.js')
const TEXT_JSON = path.join(SRC, 'shared', 'textStyles.json')
const TEXT_JS = path.join(SRC, 'renderer', 'textStyles.js')
const STICKER_CATALOG = path.join(ROOT, 'packages', 'desktop', 'resources', 'stickers', 'catalog.json')
const TREE = path.join(SRC, 'renderer', 'components', 'AssetTree.jsx')
const PANEL = path.join(SRC, 'renderer', 'components', 'SidePanels.jsx')
const TABS = path.join(SRC, 'renderer', 'components', 'EditorTabs.jsx')
const APP = path.join(SRC, 'renderer', 'App.jsx')
const VITE = path.join(ROOT, 'packages', 'desktop', 'vite.config.mjs')
const MAIN_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail) console.log(`      ${detail}`)
}
const skip = (name, why) => {
  results.push({ name, ok: false, skipped: true })
  console.log(`SKIP  ${name}`)
  console.log(`      ${why}`)
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')

/* ============================ 一、静态 ============================ */

console.log('\n[静态] 数据表与接线\n')

const TPL = require(TPL_JS)
const textTable = JSON.parse(read(TEXT_JSON) || '{}')
const stickerCatalog = JSON.parse(read(STICKER_CATALOG) || '{}')

/* 1) 规模：3 组 12 款，每组都有货。点进分组看到空网格 = 假入口。 */
{
  const groups = TPL.groupsOf()
  const list = TPL.listTemplates()
  const perGroup = groups.map((g) => `${g.name}:${TPL.templatesOfGroup(g.key).length}`).join(' ')
  record(
    '数据表有 3 组 12 款，且每组不少于 4 款',
    groups.length === 3 && list.length === 12 && groups.every((g) => TPL.templatesOfGroup(g.key).length >= 4),
    `${groups.length} 组 / ${list.length} 款 / ${perGroup}`
  )
}

/* 2) 数据自检：对着**真**样式表与**真**贴纸清单逐条核。
      ⚠️ 清单必须是真读出来的非空集合 —— 传空集合时 validateTemplates 会跳过
      那两项检查，得到一个"0 问题"的假绿。 */
{
  const styleKeys = (textTable.styles || []).map((s) => s.key)
  const stickerKeys = []
  for (const g of stickerCatalog.groups || []) {
    for (const it of g.items || []) stickerKeys.push(it.key)
  }
  const problems = TPL.validateTemplates({ styleKeys, stickerKeys })
  const ok = styleKeys.length >= 15 && stickerKeys.length >= 100 && problems.length === 0
  record(
    '数据自检通过：样式/贴纸 key 都真实存在、文字不重叠、时长与跨度一致',
    ok,
    problems.length
      ? problems.slice(0, 4).join(' | ')
      : `样式表 ${styleKeys.length} 项、贴纸清单 ${stickerKeys.length} 枚（数量不足也算失败）`
  )
}

/* 3) 左栏分组与数据表逐条一致（key + 中文名都要对）。
      两边都是字面量，分叉时不会报错，只会"点第 2 组看到第 3 组的内容"。 */
{
  const treeSrc = read(TREE)
  const seg = treeSrc.slice(treeSrc.indexOf('TEMPLATE_GROUP_CHILDREN'), treeSrc.indexOf('每个一级标签下的左栏树'))
  const pairs = [...seg.matchAll(/template: '([a-z]+)'[\s\S]{0,40}?/g)].map((m) => m[1])
  const declared = [...seg.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  const groups = TPL.groupsOf()
  const sameKey = groups.length === pairs.length && groups.every((g, i) => g.key === pairs[i])
  const sameName = groups.length === declared.length && groups.every((g, i) => g.name === declared[i])
  record(
    '左栏三组的 key 与中文名和数据表逐条一致',
    sameKey && sameName,
    `左栏 ${pairs.join(',')} / ${declared.join(',')} ≠ 数据表 ${groups.map((g) => `${g.key}(${g.name})`).join(',')}`
  )
}

/* 4) 接线三段：左栏节点 → 面板分支 → App 传参。少一段就是"点了没反应"。 */
{
  const treeSrc = read(TREE)
  const panelSrc = read(PANEL)
  const appSrc = read(APP)
  const parts = {
    tree: /template:\s*\{[\s\S]{0,600}?panel:\s*'template'/.test(treeSrc),
    panel: /if \(mode === 'template'\)[\s\S]{0,200}?<TemplatePanel/.test(panelSrc),
    app: /templateGroup=\{currentNode\.template/.test(appSrc) && /onApplyTemplate=\{applyTemplate\}/.test(appSrc)
  }
  record(
    '接线三段齐全（左栏节点 / 面板分支 / App 传 templateGroup+onApplyTemplate）',
    parts.tree && parts.panel && parts.app,
    JSON.stringify(parts)
  )
}

/* 5) 渲染层要用 planTemplate，CJS 必须进 vite 的 commonjs 白名单。
      漏了这一行 ⇒ import 到空对象，点模板抛 TypeError，构建与静态扫描都看不见。 */
{
  const viteSrc = read(VITE)
  /* 逐行找比拼正则稳：白名单那一行的字面量里本身带反斜杠转义（`/shared[\\/]templates\.js$/`），
     多层转义写在正则里极容易把自己写坏（写成 "Invalid regular expression flags"）。 */
  const hasTplLine = viteSrc
    .split('\n')
    .some((line) => line.includes('templates') && line.includes('shared'))
  record(
    'shared/templates.js 已加入 vite 的 commonjsOptions.include',
    hasTplLine,
    '白名单里没有 templates.js'
  )
}

/* 6) 页签 12 枚且「模板」紧跟在「调节」之后（参考的顺序）。
      ⚠️ 别写「模板排在最后一位」——2026-10-30 之后又补了「智能包装」，
      那种写法会把"正常新加一枚页签"判成模板回归。判**相对位置**，不判绝对名次。 */
{
  const src = read(TABS)
  const keys = [...src.matchAll(/key: '([a-z]+)', label: '([^']+)', Icon:/g)].map((m) => `${m[1]}:${m[2]}`)
  const at = keys.indexOf('template:模板')
  record(
    '页签 12 枚，且「模板」紧跟在「调节」之后',
    keys.length === 12 && at > 0 && keys[at - 1] === 'adjust:调节',
    `${keys.length} 枚：${keys.join(' ')}`
  )
}

/* 7) 文字宽度上限必须是 cqw，不能是 %。
      改回 `%` 的症状是"5 个字的标题被挤成两行"，而字号、位置、颜色全都正常。 */
{
  const src = read(TEXT_JS)
  const usesCqw = /maxWidth:\s*def\.align[^\n]*cqw'/.test(src)
  const usesPercent = /maxWidth:\s*def\.align[^\n]*'8[0-9]%'/.test(src)
  record(
    '文字 maxWidth 用 cqw 而不是 %（外层 .ta-move 是 shrink-to-fit，% 会把末字挤下去）',
    usesCqw && !usesPercent,
    `cqw=${usesCqw} percent=${usesPercent}`
  )
}

/* ============================ 二、真机 ============================ */

if (!STATIC_ONLY) {
  console.log('\n[真机] 页签 → 面板 → 时间线 → 预览\n')
  let app = null
  try {
    const { _electron: electron } = await import('playwright-core')
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-tpl-'))
    const env = { ...process.env, NODE_ENV: 'production' }
    delete env.ELECTRON_RUN_AS_NODE

    app = await electron.launch({
      executablePath: MAIN_EXE,
      args: [
        path.join(SRC, 'main', 'index.js'),
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage'
      ],
      cwd: ROOT,
      env
    })
    const page = await app.firstWindow()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push('[console.error] ' + m.text())
    })

    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMaximized()) win.unmaximize()
        win.setContentSize(1920, 1032)
        win.center()
      }
    }, null)
    await page.waitForTimeout(1500)
    const hero = await page.$('.home-hero-video')
    if (hero) await hero.click()
    await page.waitForTimeout(1500)

    /* ① 页签 */
    const tabs = await page.$$eval('.wb-tab', (els) => els.map((e) => e.getAttribute('data-wb-tab')))
    record(
      '真机：顶栏 12 枚页签，含「模板」',
      tabs.length === 12 && tabs.includes('template'),
      `${tabs.length} 枚：${tabs.join(',')}`
    )

    /* ② 面板卡片（开场组 4 张，每张都有名字 / 副标题 / 版式示意） */
    await page.locator('.wb-tab[data-wb-tab="template"]').click()
    await page.waitForTimeout(800)
    const grid = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-tpl]'))
      return {
        group: document.querySelector('[data-tpl-grid]')?.getAttribute('data-tpl-grid') || '',
        keys: cards.map((c) => c.getAttribute('data-tpl')),
        names: cards.map((c) => c.querySelector('.tpl-name')?.textContent || ''),
        subs: cards.map((c) => c.querySelector('.tpl-sub')?.textContent || ''),
        bars: document.querySelectorAll('.tpl-bar').length,
        dots: document.querySelectorAll('.tpl-dot').length
      }
    })
    record(
      '真机：模板页默认落在「开场」组，4 张卡都有名字、时长与版式示意',
      grid.group === 'open' &&
        grid.keys.length === 4 &&
        grid.names.every((n) => n.length > 0) &&
        grid.subs.every((s) => /\d+\.\d+s/.test(s)) &&
        grid.bars >= 4 &&
        grid.dots >= 1,
      `group=${grid.group} keys=${grid.keys.join(',')} names=${grid.names.join(',')} bars=${grid.bars} dots=${grid.dots}`
    )

    /* ③ 点第一款 → 片段真的进了时间线（条数与该模板的 clips 数一致） */
    const heroTpl = TPL.templateOf('tpl-open-hero')
    const before = await page.$$eval('[data-clip]', (els) => els.length)
    await page.locator('[data-tpl="tpl-open-hero"]').click()
    await page.waitForTimeout(1200)
    const after = await page.$$eval('[data-clip]', (els) => els.length)
    const toastText = await page.evaluate(
      () => document.querySelector('.toast')?.textContent || document.querySelector('[class*="toast"]')?.textContent || ''
    )
    record(
      '真机：点一款模板 → 片段数按该模板的条目数增加，并给出落地提示',
      after - before === heroTpl.clips.length && /已套用/.test(toastText),
      `片段 ${before} → ${after}（模板 ${heroTpl.clips.length} 条）、提示「${toastText.slice(0, 30)}」`
    )

    /* ④ 预览里真的有这段文字，而且是**一行**（钉住 maxWidth 那个回归） */
    const overlay = await page.evaluate(() => {
      const el = document.querySelector('[data-overlay-text]')
      if (!el) return null
      const cs = getComputedStyle(el)
      const lh = parseFloat(cs.lineHeight) || 1
      return {
        text: el.textContent || '',
        lines: Math.round(el.getBoundingClientRect().height / lh),
        width: Math.round(el.getBoundingClientRect().width),
        frame: Math.round(document.querySelector('.canvas-frame')?.getBoundingClientRect().width || 0)
      }
    })
    record(
      '真机：预览画面上真的出现这段文字，且标题是**一行**（5 个汉字不被挤成两行）',
      Boolean(overlay) && overlay.text.length > 0 && overlay.lines === 1 && overlay.width < overlay.frame,
      overlay
        ? `「${overlay.text}」${overlay.lines} 行 / 宽 ${overlay.width}（画布 ${overlay.frame}）`
        : '(画面上没有 .canvas-overlay)'
    )

    /* ⑤ 切分组真的换内容（不是只有标题变了） */
    await page.locator('[data-wb-node="tpl-g-pack"]').click()
    await page.waitForTimeout(800)
    const pack = await page.evaluate(() => ({
      group: document.querySelector('[data-tpl-grid]')?.getAttribute('data-tpl-grid') || '',
      keys: Array.from(document.querySelectorAll('[data-tpl]')).map((c) => c.getAttribute('data-tpl'))
    }))
    record(
      '真机：切到「字幕套」→ 网格换成 pack 组的 4 款',
      pack.group === 'pack' && pack.keys.length === 4 && pack.keys.every((k) => k.startsWith('tpl-pack-')),
      `group=${pack.group} keys=${pack.keys.join(',')}`
    )

    /* ⑥ 带贴纸的模板：贴纸 key 必须真的换成 yjai-media 地址落成片段。
          ⚠️ 换不到 key 时 planTemplate 会**跳过并计数**（不报错）——只看"片段数增加了"
          根本发现不了，症状是"模板里有贴纸、套完只剩文字"。所以这里读叠加轨的
          data-visual（= clip.url 非空）与提示里有没有"缺失"。 */
    await page.locator('[data-wb-node="tpl-g-open"]').click()
    await page.waitForTimeout(600)
    const festTpl = TPL.templateOf('tpl-open-fest')
    const beforeFest = await page.$$eval('[data-clip]', (els) => els.length)
    await page.locator('[data-tpl="tpl-open-fest"]').click()
    await page.waitForTimeout(1300)
    const fest = await page.evaluate(() => {
      const lane = document.querySelector('.wb-tllane[data-lane="overlay"]')
      const clips = lane ? Array.from(lane.querySelectorAll('.clip')) : []
      return {
        total: document.querySelectorAll('[data-clip]').length,
        overlay: clips.length,
        withUrl: clips.filter((c) => c.getAttribute('data-visual') === '1').length,
        toast: document.querySelector('.toast')?.textContent || ''
      }
    })
    const festStickers = festTpl.clips.filter((c) => c.type === 'sticker').length
    record(
      '真机：带贴纸的模板套完，贴纸真的落成叠加片段（url 已解析，不是被跳过）',
      festStickers === 2 &&
        fest.total - beforeFest === festTpl.clips.length &&
        fest.overlay >= festStickers &&
        fest.withUrl >= festStickers &&
        !/缺失|跳过/.test(fest.toast),
      `叠加轨 ${fest.overlay} 条（有 url ${fest.withUrl}）/ 片段 ${beforeFest} → ${fest.total}、提示「${fest.toast.slice(0, 40)}」`
    )

    /* ⑦ 无页面错误 */
    record('真机：全程 0 页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } catch (err) {
    skip('真机：模板页可用', `启动失败：${(err && err.message) || ''}`)
  } finally {
    if (app) {
      /* 裸等 app.close() 会让整套闸门挂住（见 e2e-teardown 闸门） */
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))])
    }
  }
}

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok && !r.skipped)
const skipped = results.filter((r) => r.skipped)
console.log(
  `\nTEMPLATES_STATS total=${results.length} pass=${results.filter((r) => r.ok).length} fail=${failed.length} skip=${skipped.length}`
)
if (failed.length) {
  console.error('TEMPLATES_FAILED')
  process.exit(1)
}
console.log('TEMPLATES_OK')
