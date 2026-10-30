#!/usr/bin/env node
/**
 * 闸门：智能包装（词库判定 → 面板 → 字幕/画面真的被改 → 能原样清回去）。
 *
 * 这道闸门治的是**"包装"这一类功能最典型的五种静默失效**，没有一种会报错：
 *
 *   1. 判定不准 —— 该放大的句子没放大。判据不能只看"有没有变"，要**两条句子的字号差**：
 *      关键句必须比普通句大，否则"整条轨一起放大"也会让"变了"成立。
 *   2. 放大叠乘 —— `textSize` 与 `textScale` 同时写，1.18 变成 1.39。静态那条直接钉死
 *      "packaging.js 里不许出现 textSize 赋值"（那是死字段，写了没人读）。
 *   3. 配了贴纸但地址没解析 —— 时间线上多一条空 img，画面上什么都没有。
 *   4. 清除不干净 —— 包装时新增的键（textLoop）在片段上原本不存在，只写回旧值会永远留着，
 *      症状是"点了清除，字幕还在呼吸"。
 *   5. 面板接错 —— 左栏两项（口播 / 画面）共用 panel='packaging'，packMode 写错就是
 *      "点画面包装，改的是字幕"。
 *
 * 纯静态部分可单独跑（不起 Electron、不弹窗）：
 *   node tools/check-packaging.mjs --static
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
const PACK_JS = path.join(SRC, 'shared', 'packaging.js')
const TEXT_JSON = path.join(SRC, 'shared', 'textStyles.json')
const LOOKS_JSON = path.join(SRC, 'shared', 'looks.json')
const BORDER_CATALOG = path.join(ROOT, 'packages', 'desktop', 'resources', 'borders', 'catalog.json')
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ============================ 一、静态 ============================ */

console.log('\n[静态] 数据表与接线\n')

const PACK = require(PACK_JS)
const textTable = JSON.parse(read(TEXT_JSON) || '{}')
const looks = JSON.parse(read(LOOKS_JSON) || '{}')
const borderCatalog = JSON.parse(read(BORDER_CATALOG) || '{}')

/* 1) 风格 / 强度 / 组合三张表的 key 必须指向**真实存在**的样式、边框与滤镜。
      写成不存在的 key 不会报错：样式回落到默认、边框不显示、滤镜没反应 ——
      三种都表现为"点了没什么变化"，比报错难查得多。 */
{
  const styleKeys = new Set((textTable.styles || []).map((s) => s.key))
  const filterKeys = new Set((looks.filters || []).map((f) => f.key))
  const borderKeys = new Set()
  for (const group of borderCatalog.groups || []) {
    for (const item of group.items || []) borderKeys.add(item.key)
  }

  const badStyle = PACK.PACK_STYLES.filter((s) => !styleKeys.has(s.style)).map((s) => `${s.key}→${s.style}`)
  const badBorder = PACK.SCENE_COMBOS.filter((c) => !borderKeys.has(c.border)).map((c) => `${c.key}→${c.border}`)
  const badFilter = PACK.SCENE_COMBOS.filter((c) => !filterKeys.has(c.filter)).map((c) => `${c.key}→${c.filter}`)
  record(
    '四种风格指向真样式、四种画面组合指向真边框与真滤镜',
    PACK.PACK_STYLES.length === 4 &&
      PACK.SCENE_COMBOS.length === 4 &&
      !badStyle.length &&
      !badBorder.length &&
      !badFilter.length &&
      styleKeys.size >= 15 &&
      filterKeys.size >= 5 &&
      borderKeys.size >= 20,
    `样式 ${badStyle.join(',')} / 边框 ${badBorder.join(',')} / 滤镜 ${badFilter.join(',')}` +
      `（表规模：样式 ${styleKeys.size}、滤镜 ${filterKeys.size}、边框 ${borderKeys.size}）`
  )
}

/* 2) 词库：三类各要够用，且**不许重复** —— 重复词会让同一句被算两次分
      （"这句为什么变黄了"只因为词库里同一个词写了两遍，谁也想不到）。 */
{
  const bank = PACK.BANK
  const all = Object.values(bank).flat()
  const kinds = Object.keys(bank)
  const dup = all.filter((w, i) => all.indexOf(w) !== i)
  record(
    '词库三类都够用、没有重复词、没有空串',
    kinds.length === 3 &&
      kinds.every((k) => bank[k].length >= 10) &&
      dup.length === 0 &&
      all.every((w) => typeof w === 'string' && w.length > 0),
    dup.length ? `重复：${[...new Set(dup)].join(',')}` : kinds.map((k) => `${k}:${bank[k].length}`).join(' ')
  )
}

/* 3) 字号只准走 textScale。
      `textSize` 在 App / templates / MCP 里都写了，但渲染与导出两侧没人读 ——
      写它的症状是"面板说放大了、画面一点没变"，构建与静态扫描都不报。 */
{
  const src = read(PACK_JS)
  const writesSize = /textSize\s*:/.test(src)
  record(
    '包装只改 textScale，不写 textSize（那是死字段，写了没人读）',
    !writesSize,
    writesSize ? 'packaging.js 里出现了 textSize 赋值' : ''
  )
}

/* 4) 接线三段：左栏两项 → 面板分支 → App 传参。少一段就是"点了没反应"，
      而 packMode 写错则是更坏的一种：点了画面包装，动的是字幕。 */
{
  const treeSrc = read(TREE)
  const panelSrc = read(PANEL)
  const appSrc = read(APP)
  const treeOk =
    /packaging:\s*\{[\s\S]{0,700}?panel:\s*'packaging'/.test(treeSrc) &&
    /packMode:\s*'line'/.test(treeSrc) &&
    /packMode:\s*'scene'/.test(treeSrc)
  const panelOk =
    /if \(mode === 'packaging'\)[\s\S]{0,220}?<PackPanel/.test(panelSrc) &&
    /mode=\{packMode \|\| 'line'\}/.test(panelSrc)
  const appOk =
    /packMode=\{currentNode\.packMode/.test(appSrc) &&
    /onApplyPack=\{applyPack\}/.test(appSrc) &&
    /onApplyScene=\{applyScenePack\}/.test(appSrc) &&
    /onClearPack=\{\(\) => clearPack\('line'\)\}/.test(appSrc) &&
    /onClearScene=\{\(\) => clearPack\('scene'\)\}/.test(appSrc)
  record(
    '接线三段齐全（左栏 packMode / 面板分支 / App 四个回调）',
    treeOk && panelOk && appOk,
    `tree=${treeOk} panel=${panelOk} app=${appOk}`
  )
}

/* 5) 渲染层要 import shared/packaging.js，CJS 必须进 vite 的 commonjs 白名单。
      漏了这一行 ⇒ import 到空对象，点「一键包装」抛 TypeError，构建不报、静态扫描也看不见。 */
{
  const viteSrc = read(VITE)
  const hasLine = viteSrc.split('\n').some((line) => line.includes('packaging') && line.includes('shared'))
  record('shared/packaging.js 已加入 vite 的 commonjsOptions.include', hasLine, '白名单里没有 packaging.js')
}

/* 6) 页签 12 枚，且「智能包装」紧跟在「模板」之后（同类：收尾美化，不是第一步）。
      ⚠️ 别写「智能包装排在最后一位」——2026-10-31 又补了「插件」，那种写法会把
      “正常新加一枚页签”判成智能包装回归。判**相对位置**，不判绝对名次。 */
{
  const src = read(TABS)
  const keys = [...src.matchAll(/key: '([a-z]+)', label: '([^']+)', Icon:/g)].map((m) => `${m[1]}:${m[2]}`)
  record(
    '页签 12 枚，且「智能包装」紧跟在「模板」之后',
    keys.length === 12 &&
      keys.indexOf('packaging:智能包装') > 0 &&
      keys[keys.indexOf('packaging:智能包装') - 1] === 'template:模板',
    `${keys.length} 枚：${keys.join(' ')}`
  )
}

/* 7) 面板上每颗可点的东西都要有 data-* 钩子 —— 否则真机断言只能"点位置"，点偏了照样绿。 */
{
  const src = read(PANEL)
  const hooks = ['data-pack-style', 'data-pack-level', 'data-pack-combo', 'data-pack-apply', 'data-pack-clear', 'data-pack-stat']
  const missing = hooks.filter((hook) => !src.includes(hook))
  record('面板四类钩子齐全（风格 / 强度 / 组合 / 动作 / 统计）', missing.length === 0, missing.join(','))
}

/* ============================ 二、真机 ============================ */

if (!STATIC_ONLY) {
  console.log('\n[真机] 左栏 → 面板 → 字幕真的变了 → 能清回去\n')
  let app = null
  try {
    const { _electron: electron } = await import('playwright-core')
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-pack-'))
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

    /* 预置一份草稿：一条主轨画面 + 两句字幕（一句有情绪词、一句平铺直叙）。
       这两句就是"关键句 vs 普通句"的对照组 —— 判据是两者的字号差，不是"有没有变大"。 */
    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: '包装 E2E',
        data: {
          clips: [
            { id: 'v1', track: 'video', name: '画面一', url: '', path: '', kind: 'video', start: 0, duration: 4, offset: 0, sourceDuration: 4 },
            { id: 't1', track: 'text', assetId: '', name: '关键句', url: '', path: '', kind: 'text', text: '这个方法真的绝了！', textStyle: 'sub-plain', textSize: 32, start: 0, duration: 2, offset: 0, sourceDuration: 0 },
            { id: 't2', track: 'text', assetId: '', name: '普通句', url: '', path: '', kind: 'text', text: '今天下午我们去拍一段素材', textStyle: 'sub-plain', textSize: 32, start: 2, duration: 2, offset: 0, sourceDuration: 0 }
          ],
          assets: [],
          playhead: 0,
          volume: 100,
          zoom: 1
        }
      }
    )
    await page.reload()
    await page.waitForSelector('.home', { timeout: 30000 })
    await page.waitForTimeout(400)
    await page.locator('.home-nav-item', { hasText: '最近草稿' }).click()
    await page.waitForSelector('.home-draft-row', { timeout: 10000 })
    await page.locator('.home-draft-open').first().click()
    await page.waitForSelector('.wb-timeline', { timeout: 15000 })
    await page.waitForTimeout(600)

    /* 读预览里那条正在显示的字幕：字号与颜色都取 computed（消费端，不读数据） */
    const readLine = async () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-overlay-text]')
        if (!el) return null
        const cs = getComputedStyle(el)
        return { text: el.textContent || '', size: parseFloat(cs.fontSize) || 0, color: cs.color }
      })

    const beforeKey = await readLine()

    /* ① 页签 */
    const tabs = await page.$$eval('.wb-tab', (els) => els.map((e) => e.getAttribute('data-wb-tab')))
    record(
      '真机：顶栏 12 枚页签，含「智能包装」',
      tabs.length === 12 && tabs.includes('packaging'),
      `${tabs.length} 枚：${tabs.join(',')}`
    )

    /* ② 左栏两项 + 面板卡片 */
    await page.locator('.wb-tab[data-wb-tab="packaging"]').click()
    await page.waitForTimeout(700)
    const tree = await page.$$eval('[data-wb-node^="pack-"]', (els) => els.map((e) => e.getAttribute('data-wb-node')))
    const sheet = await page.evaluate(() => ({
      grid: document.querySelector('[data-pack-grid]')?.getAttribute('data-pack-grid') || '',
      styles: document.querySelectorAll('[data-pack-style]').length,
      levels: document.querySelectorAll('[data-pack-level]').length,
      apply: document.querySelectorAll('[data-pack-apply="line"]').length,
      clear: document.querySelectorAll('[data-pack-clear="line"]').length,
      sampled: document.querySelectorAll('.pack-sample').length,
      keys: document.querySelectorAll('[data-pack-key]').length,
      stat: (document.querySelector('[data-pack-stat="line"]')?.textContent || '').trim()
    }))
    record(
      '真机：左栏有「口播包装 / 画面包装」两项，面板给 4 种风格 + 3 档强度 + 两颗按钮',
      tree.includes('pack-line') &&
        tree.includes('pack-scene') &&
        sheet.grid === 'line' &&
        sheet.styles === 4 &&
        sheet.levels === 3 &&
        sheet.apply === 1 &&
        sheet.clear === 1 &&
        sheet.sampled === 4,
      `左栏 ${tree.join(',')} / 风格 ${sheet.styles} / 强度 ${sheet.levels} / 字样 ${sheet.sampled}`
    )

    /* ③ 面板读到了字幕轨：2 条字幕、1 条关键句（词库判得对不对看这里） */
    record(
      '真机：面板统计到 2 条字幕、并把带情绪词的那句认成 1 条关键句',
      /2\s*条字幕/.test(sheet.stat) && sheet.keys === 1,
      `统计「${sheet.stat}」/ 关键句标签 ${sheet.keys} 个`
    )

    /* ④ 点「一键包装」→ 预览里这句真的变了（样式色 + 字号） */
    await page.locator('[data-pack-apply="line"]').click()
    await page.waitForTimeout(1400)
    const afterKey = await readLine()
    record(
      '真机：点「一键包装」后预览里那句字幕真的换了样式与颜色',
      Boolean(beforeKey && afterKey) &&
        afterKey.text === beforeKey.text &&
        afterKey.size > beforeKey.size &&
        afterKey.color !== beforeKey.color,
      beforeKey && afterKey
        ? `${beforeKey.size}px ${beforeKey.color} → ${afterKey.size}px ${afterKey.color}`
        : '(预览里没有字幕)'
    )

    /* ⑤ 关键句必须比普通句**更大** —— 这条才是"智能"的判据。
          整条轨一起放大也会让上一条成立，只有两句对比才分得清。 */
    await page.evaluate(() => {
      /* 直接把播放头挪到第 2.6 秒（普通句那条），走真实的事件而不是改 state */
      const ruler = document.querySelector('[data-ruler]')
      const box = ruler?.getBoundingClientRect()
      if (!box) return
      const dps = Number(getComputedStyle(document.querySelector('.wb-tllane')).getPropertyValue('--beat').replace('px', '')) || 0
      const x = box.left + (dps > 0 ? 2.6 * dps : 0)
      ruler.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: box.top + box.height / 2, bubbles: true }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: box.top + box.height / 2, bubbles: true }))
    })
    await page.waitForTimeout(700)
    const normalLine = await readLine()
    record(
      '真机：关键句的字号真的比普通句大（不是整轨一起放大）',
      Boolean(normalLine && afterKey) && afterKey.size > normalLine.size + 0.5,
      normalLine && afterKey ? `关键句 ${afterKey.size}px vs 普通句 ${normalLine.size}px` : '(读不到普通句)'
    )

    /* ⑥ 贴纸：关键句配了 spark 组的一枚，且 url 已解析（时间线上有、画面上也有） */
    const sticker = await page.evaluate(() => {
      const lane = document.querySelector('.wb-tllane[data-lane="overlay"]')
      const clips = lane ? Array.from(lane.querySelectorAll('.clip')) : []
      return {
        count: clips.length,
        withUrl: clips.filter((c) => c.getAttribute('data-visual') === '1').length
      }
    })
    record(
      '真机：自动配的贴纸真的落成叠加片段（url 已解析，不是空 img）',
      sticker.count === 1 && sticker.withUrl === 1,
      `叠加轨 ${sticker.count} 条（有 url ${sticker.withUrl}）`
    )

    /* ⑦ 清除：字号回到原值、贴纸被删掉、面板统计归零 */
    await page.locator('[data-pack-clear="line"]').click()
    await page.waitForTimeout(900)
    const cleared = await readLine()
    const afterClear = await page.evaluate(() => {
      const lane = document.querySelector('.wb-tllane[data-lane="overlay"]')
      return {
        stickers: lane ? lane.querySelectorAll('.clip').length : 0,
        stat: (document.querySelector('[data-pack-stat="line"]')?.textContent || '').trim()
      }
    })
    record(
      '真机：点「清除」后字号回到包装前、自动贴纸被删掉',
      Boolean(cleared) && Math.abs(cleared.size - Number(beforeKey?.size || 0)) < 0.6 && afterClear.stickers === 0,
      cleared
        ? `字号 ${afterKey?.size} → ${cleared.size}（原始 ${beforeKey?.size}）/ 叠加轨 ${afterClear.stickers} 条`
        : '(预览里没有字幕)'
    )

    /* ⑧ 画面包装：点左栏「画面包装」→ 面板换成组合卡；套用后预览上真的出现边框 */
    await page.locator('[data-wb-node="pack-scene"]').click()
    await page.waitForTimeout(700)
    const scene = await page.evaluate(() => ({
      grid: document.querySelector('[data-pack-grid]')?.getAttribute('data-pack-grid') || '',
      combos: document.querySelectorAll('[data-pack-combo]').length,
      apply: document.querySelectorAll('[data-pack-apply="scene"]').length
    }))
    await page.locator('[data-pack-combo="film"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-pack-apply="scene"]').click()
    await page.waitForTimeout(1200)
    const framed = await page.evaluate(() => {
      const el = document.querySelector('.canvas-border')
      return { present: Boolean(el), key: el ? el.getAttribute('data-fx-border') : '' }
    })
    record(
      '真机：切到「画面包装」后是 4 张组合卡，套用后预览上真的出现了那款边框',
      scene.grid === 'scene' && scene.combos === 4 && scene.apply === 1 && framed.present && framed.key === 'br-retro-film',
      `网格 ${scene.grid} / 组合 ${scene.combos} / 边框 ${framed.key || '（没有）'}`
    )

    /* ⑨ 无页面错误 */
    record('真机：全程 0 页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } catch (err) {
    skip('真机：智能包装可用', `启动失败：${(err && err.message) || ''}`)
  } finally {
    if (app) {
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))])
    }
  }
}

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok && !r.skipped)
const skipped = results.filter((r) => r.skipped)
console.log(
  `\nPACKAGING_STATS total=${results.length} pass=${results.filter((r) => r.ok).length} fail=${failed.length} skip=${skipped.length}`
)
if (failed.length) {
  console.error('PACKAGING_FAILED')
  process.exit(1)
}
console.log('PACKAGING_OK')
