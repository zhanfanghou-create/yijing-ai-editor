#!/usr/bin/env node
/**
 * 闸门：内置贴纸库（素材 → 清单 → 面板 → 叠加轨）。
 *
 * 这道闸门治的是**贴纸"看起来有、其实用不了"**的三类缺陷，它们各自都不报错：
 *
 *   1. 清单与源码表分叉 —— `AssetTree.jsx` 的分组 key 与 `catalog.json` 的 group key
 *      对不上时，点分类是"中栏空着"，而不是报错。所以两边逐条比对（连中文名一起）。
 *   2. 素材进不了渲染层 —— `yjai-media://` 有白名单，漏登记就 403，
 *      面板上是一片空白，Console 只有一条 Failed to load resource。
 *      判据因此落在 **`img.naturalWidth > 0`** 上，不能只数格子数。
 *   3. 叠上去不透明 —— ffmpeg 链上一旦没有 alpha，透明区会被填黑。
 *      那一条在 `render-e2e`（成片像素），这里管界面到轨道这一段。
 *
 * 真机部分要启动 Electron，会弹窗；纯静态部分（前 6 条）可单独跑：
 *   node tools/check-stickers.mjs --static
 *
 * 用法：
 *   node tools/check-stickers.mjs            # 全部
 *   node tools/check-stickers.mjs --static   # 只跑静态（不弹窗）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const STATIC_ONLY = process.argv.includes('--static')

const STICKER_DIR = path.join(ROOT, 'packages', 'desktop', 'resources', 'stickers')
const CATALOG = path.join(STICKER_DIR, 'catalog.json')
const TREE = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'components', 'AssetTree.jsx')
const TABS = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'components', 'EditorTabs.jsx')
const BUILDER = path.join(ROOT, 'packages', 'desktop', 'electron-builder.yml')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const PRELOAD = path.join(ROOT, 'packages', 'desktop', 'src', 'preload', 'index.js')
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

/* ========================== 一、静态：清单与素材 ========================== */

if (!fs.existsSync(CATALOG)) {
  console.error('STICKERS_FAILED  清单不存在，先跑 node tools/fetch-stickers.mjs')
  process.exit(1)
}

let catalog = null
try {
  catalog = JSON.parse(read(CATALOG))
} catch (err) {
  console.error(`STICKERS_FAILED  清单不是合法 JSON：${(err && err.message) || ''}`)
  process.exit(1)
}

const groups = Array.isArray(catalog.groups) ? catalog.groups : []
const items = groups.flatMap((g) => (Array.isArray(g.items) ? g.items : []))

record(
  '贴纸清单是**真数据**：8 组、至少 100 枚',
  groups.length === 8 && items.length >= 100,
  `实测 ${groups.length} 组 / ${items.length} 枚（少于 100 说明素材没抓全，面板会显得空）`
)

/**
 * 读 PNG 的头与 chunk 链。
 *
 * ⚠️ 透明信息**不只在 IHDR 里**。`colorType` 4/6 自带 alpha 通道，但调色板图
 *    （`colorType` 3）的透明是靠 `tRNS` 块声明的 —— 本批素材里有 81 张正是这一类
 *    （手臂、点赞这些笔画细的，Noto 存成了调色板 + tRNS）。
 *    只判 IHDR 会把它们全判成"不带 alpha"，然后为了让它绿去放宽阈值 ——
 *    那等于把闸门拆了。所以这里老实走一遍 chunk 链。
 */
function pngInfo(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  const colorType = buf[25]
  let hasTrns = false
  let at = 8
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    if (type === 'tRNS') hasTrns = true
    if (type === 'IEND') break
    at += 12 + len
  }
  return { w, h, colorType, hasTrns, alpha: colorType === 4 || colorType === 6 || hasTrns }
}

/** 每一条都必须在盘上、是 PNG、尺寸与清单一致、且带透明信息 */
const badFiles = []
const noAlpha = []
for (const item of items) {
  const abs = path.join(STICKER_DIR, String(item.file || ''))
  let info = null
  try {
    info = pngInfo(fs.readFileSync(abs))
  } catch {
    info = null
  }
  if (!info || info.w !== Number(item.w) || info.h !== Number(item.h)) {
    badFiles.push(item.file)
    continue
  }
  if (!info.alpha) noAlpha.push(item.file)
}

record(
  '清单里每一条都在盘上、是 PNG、宽高与记录一致',
  badFiles.length === 0,
  `不一致 ${badFiles.length} 条：${badFiles.slice(0, 5).join(', ')}`
)

record(
  '每张素材都带透明信息（否则叠到画面上是个方框）',
  noAlpha.length === 0,
  `无透明 ${noAlpha.length} 条：${noAlpha.slice(0, 5).join(', ')}（RGBA 或调色板 + tRNS 都算）`
)


/* ===================== 二、静态：源码表与清单不分叉 ===================== */

const treeSrc = read(TREE)
const tabSrc = read(TABS)

/** 从 AssetTree 里抠出 STICKER_GROUP_CHILDREN 的分组（顺序 + key + 中文名） */
const treeGroups = []
for (const line of treeSrc.split('\n')) {
  if (!/panel:\s*'sticker'/.test(line)) continue
  const key = /sticker:\s*'([a-z]+)'/.exec(line)
  const label = /label:\s*'([^']+)'/.exec(line)
  if (key && label) treeGroups.push({ key: key[1], label: label[1] })
}

record(
  '左栏分组（AssetTree）与清单的 group key / 中文名逐条一致',
  treeGroups.length === groups.length &&
    treeGroups.every((g, i) => g.key === groups[i].key && g.label === groups[i].name),
  `源码 ${JSON.stringify(treeGroups.map((g) => g.key))} vs 清单 ${JSON.stringify(groups.map((g) => g.key))}`
)

/* ===================== 三、静态：页签与图标不撞车 ===================== */

const tabBlock = tabSrc.slice(tabSrc.indexOf('WB_TABS'), tabSrc.indexOf('export default'))
const tabIcons = [...tabBlock.matchAll(/Icon:\s*(Icon[A-Za-z]+)/g)].map((m) => m[1])
const hasStickerTab = /\{\s*key:\s*'sticker'/.test(tabBlock)

record(
  '顶栏有「贴纸」页签，且十二枚页签各用不同图标',
  hasStickerTab && tabIcons.length === 12 && new Set(tabIcons).size === tabIcons.length,
  hasStickerTab
    ? `图标 ${tabIcons.join(' ')}（重复 ${tabIcons.length - new Set(tabIcons).size} 个）`
    : 'WB_TABS 里没有 key: sticker'
)

/* ===================== 四、静态：随包与 IPC 接线 ===================== */

const builderSrc = read(BUILDER)
record(
  'electron-builder 把贴纸目录放进 extraResources',
  /from:\s*resources\/stickers/.test(builderSrc) && /to:\s*stickers/.test(builderSrc),
  '不随包 ⇒ 开发模式一切正常、装出来贴纸页是空的（这个差别在开发模式下永远看不到）'
)

const mainSrc = read(MAIN)
const preloadSrc = read(PRELOAD)
record(
  '主进程与 preload 都接上了贴纸清单（sticker:catalog / yjai.stickers.catalog）',
  mainSrc.includes("ipcMain.handle('sticker:catalog'") &&
    preloadSrc.includes("ipcRenderer.invoke('sticker:catalog'") &&
    preloadSrc.includes('stickers:'),
  '三段缺一：handler / preload 白名单 / 渲染层调用，任缺一处面板都读不到清单'
)

/* ============================ 五、真机 ============================ */

if (STATIC_ONLY) {
  console.log('\n（--static：跳过真机部分）')
} else if (!fs.existsSync(MAIN_EXE)) {
  skip('真机：贴纸页可用', `找不到 ${path.relative(ROOT, MAIN_EXE)}`)
} else {
  const { _electron: electron } = await import('playwright-core')
  const outDir = path.join(ROOT, '_evidence', 'stickers')
  fs.mkdirSync(outDir, { recursive: true })

  const profile = path.join(os.tmpdir(), 'yjai-e2e', '.sticker-gate')
  const drafts = path.join(profile, 'drafts')
  if (fs.existsSync(drafts)) {
    for (const file of fs.readdirSync(drafts)) {
      if (file.endsWith('.json')) {
        fs.writeFileSync(path.join(drafts, file), JSON.stringify({ clips: [], assets: [] }), 'utf8')
      }
    }
  }

  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.YIJAI_USE_DEV_SERVER

  const pageErrors = []
  let app = null
  try {
    app = await electron.launch({
      executablePath: MAIN_EXE,
      args: [path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js'),
        `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      cwd: ROOT,
      env
    })
    const page = await app.firstWindow()
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

    const tabKeys = await page.$$eval('.wb-tab', (els) => els.map((e) => e.getAttribute('data-wb-tab')))
    record(
      '真机：顶栏 12 枚页签，含「贴纸」',
      tabKeys.length === 12 && tabKeys.includes('sticker'),
      `实测 ${tabKeys.length} 枚：${tabKeys.join(' ')}`
    )

    const stickerTab = page.locator('.wb-tab[data-wb-tab="sticker"]')
    if (!(await stickerTab.count())) {
      skip('真机：贴纸页交互', '页签点不进去')
    } else {
      await stickerTab.click()
      await page.waitForTimeout(1200)

      /* 左栏 8 个分组（纯文字行） */
      const treeLabels = await page.$$eval('.wb-tree-row, .wb-tree button, [data-tree-node]', (els) =>
        els.map((e) => e.textContent.trim()).filter(Boolean)
      )
      const hitGroups = groups.filter((g) => treeLabels.some((t) => t.startsWith(g.name)))
      record(
        '真机：左栏列出全部 8 个分组',
        hitGroups.length === groups.length,
        `左栏读到 ${JSON.stringify(treeLabels.slice(0, 12))}`
      )

      /* 网格：数量 + **每张图真的加载了** */
      const gridInfo = await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('[data-sticker]'))
        const imgs = cells.map((c) => c.querySelector('img')).filter(Boolean)
        return {
          cells: cells.length,
          imgs: imgs.length,
          loaded: imgs.filter((i) => i.naturalWidth > 0).length,
          broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
          firstSrc: imgs[0] ? String(imgs[0].currentSrc || imgs[0].src).slice(0, 32) : '',
          error: document.querySelector('[data-sticker-error]')?.textContent || ''
        }
      })
      const firstGroup = groups[0]
      record(
        '真机：网格数量与本组清单一致，且每张图都真的加载出来了',
        gridInfo.cells === firstGroup.items.length &&
          gridInfo.imgs === gridInfo.cells &&
          gridInfo.loaded === gridInfo.imgs &&
          gridInfo.broken === 0,
        `格子 ${gridInfo.cells}/${firstGroup.items.length}、img ${gridInfo.imgs}、已加载 ${gridInfo.loaded}、破图 ${gridInfo.broken}、src=${gridInfo.firstSrc}、错误=${gridInfo.error || '-'}`
      )

      /* 点一枚 → 叠加轨多一条 + 画面上出现它 */
      const before = await page.evaluate(() => ({
        clips: document.querySelectorAll('[data-clip]').length,
        canvasImgs: document.querySelectorAll('.canvas-frame img').length
      }))
      const first = page.locator('[data-sticker]').first()
      await first.click()
      await page.waitForTimeout(1200)
      const after = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('.canvas-frame img'))
        const last = imgs[imgs.length - 1]
        return {
          clips: document.querySelectorAll('[data-clip]').length,
          canvasImgs: imgs.length,
          lastW: last ? last.naturalWidth : 0,
          lastSrc: last ? String(last.currentSrc || last.src).slice(0, 32) : ''
        }
      })
      record(
        '真机：点一枚贴纸 → 叠加轨多一条片段、画面上真的出现它',
        after.clips === before.clips + 1 && after.canvasImgs > before.canvasImgs && after.lastW > 0,
        `片段 ${before.clips}→${after.clips}、画面图 ${before.canvasImgs}→${after.canvasImgs}、新图宽 ${after.lastW}、src=${after.lastSrc}`
      )
      await page.screenshot({ path: path.join(outDir, 'sticker-added.png') })

      /* 切分组 → 网格内容真的变了（不是"数字变了、内容没变"） */
      const otherNode = page.locator('.wb-tree-row, .wb-tree button, [data-tree-node]').filter({ hasText: groups[1].name }).first()
      let switched = { ok: false, detail: '左栏没找到第二个分组' }
      if (await otherNode.count()) {
        await otherNode.click()
        await page.waitForTimeout(900)
        const second = await page.evaluate(() => {
          const cells = Array.from(document.querySelectorAll('[data-sticker]'))
          return {
            grid: document.querySelector('[data-sticker-grid]')?.getAttribute('data-sticker-grid') || '',
            cells: cells.length,
            first: cells[0] ? cells[0].getAttribute('data-sticker') : ''
          }
        })
        switched = {
          ok:
            second.grid === groups[1].key &&
            second.cells === groups[1].items.length &&
            second.first === groups[1].items[0].key,
          detail: `切到「${groups[1].name}」→ 容器 ${second.grid}、格子 ${second.cells}/${groups[1].items.length}、首枚 ${second.first}`
        }
      }
      record('真机：切换分组真的换了内容（不只是数字变了）', switched.ok, switched.detail)
    }

    record(
      '真机：全程 0 条页面错误',
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | ')
    )
  } catch (err) {
    record('真机：贴纸页可用', false, String((err && err.message) || err).slice(0, 300))
  } finally {
    /**
     * ⚠️ 不许裸等 `app.close()`：真挂住时整套一键验证会停在原地（有过 28 分钟的先例），
     * 看起来像"Electron 崩了"，真因只是没人去关它。8 秒没关掉就交给 process.exit ——
     * 断言早已记完，收尾只是在收拾场地。
     */
    if (app) {
      try {
        await Promise.race([app.close(), sleep(8000)])
      } catch {
        /* 落到 process.exit */
      }
    }
  }
}

/** 收尾兜底用的等待（不引第三方依赖） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* -------------------------------- 汇总 -------------------------------- */

const failed = results.filter((r) => !r.ok).length
const skipped = results.filter((r) => r.skipped).length
if (failed) {
  console.error(`\nSTICKERS_FAILED  ${failed} / ${results.length} 项不成立${skipped ? `（其中 ${skipped} 项跳过）` : ''}`)
} else {
  console.error(`\nSTICKERS_OK  内置贴纸库成链：${groups.length} 组 ${items.length} 枚，面板→叠加轨→成片`)
}
console.log(`STICKERS_STATS total=${results.length} pass=${results.length - failed} fail=${failed}`)
process.exitCode = failed ? 1 : 0
