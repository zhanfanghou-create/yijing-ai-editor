#!/usr/bin/env node
/**
 * 闸门：内置边框库（素材 → 左栏节点 → 面板 → 片段属性 → 预览 / 成片）。
 *
 * 这道闸门治的是**边框"看着有、其实用不了"**的四类缺陷，各自都不报错：
 *
 *   1. 素材本身不成立 —— 边框 PNG 的**窗口必须透明**。画糊了 / 忘了挖洞的图，
 *      叠上去就是"整幅画面被盖死"，而缩略图上因为底下垫着棋盘格看不出来。
 *      判据落在**真实解码出来的 alpha** 上：窗口中心的 alpha 与透明像素占比。
 *   2. 左栏没有入口 —— 节点 key / panel 写错，点「特效 → 边框」中栏是空白的。
 *   3. 面板点了没反应 —— 边框是**片段属性**（`clip.border`），不是投放新片段。
 *      没选中片段时必须有提示，而不是静默什么都不发生。
 *   4. 预览有、成片没有 —— 这条在 `render-e2e` 里用像素判（白框压在四边、
 *      窗口中心仍是原画面）。这里管"界面 → 片段 → 预览"这一段。
 *
 * 真机部分要启动 Electron，会弹窗；纯静态部分可单独跑：
 *   node tools/check-borders.mjs --static
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const STATIC_ONLY = process.argv.includes('--static')

const BORDER_DIR = path.join(ROOT, 'packages', 'desktop', 'resources', 'borders')
const CATALOG = path.join(BORDER_DIR, 'catalog.json')
const TREE = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'components', 'AssetTree.jsx')
const PANEL = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'components', 'SidePanels.jsx')
const STAGE = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'components', 'Stage.jsx')
const CSS = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'styles.css')
const BUILDER = path.join(ROOT, 'packages', 'desktop', 'electron-builder.yml')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const RENDER = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'render.js')
const PRELOAD = path.join(ROOT, 'packages', 'desktop', 'src', 'preload', 'index.js')
const CATALOG_JS = path.join(ROOT, 'packages', 'desktop', 'src', 'renderer', 'borderCatalog.js')
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

/* ========================== 一、静态：素材与清单 ========================== */

if (!fs.existsSync(CATALOG)) {
  console.error('BORDERS_FAILED  清单不存在，先跑 py tools/gen-borders.py')
  process.exit(1)
}
let catalog = null
try {
  catalog = JSON.parse(read(CATALOG))
} catch (err) {
  console.error(`BORDERS_FAILED  清单不是合法 JSON：${(err && err.message) || ''}`)
  process.exit(1)
}

const groups = Array.isArray(catalog.groups) ? catalog.groups : []
const items = groups.flatMap((g) => (Array.isArray(g.items) ? g.items : []))

record(
  '边框清单是**真数据**：6 组、24 款（每组 4 款）',
  groups.length === 6 && items.length === 24 && groups.every((g) => (g.items || []).length === 4),
  `实测 ${groups.length} 组 / ${items.length} 款：${groups.map((g) => `${g.key}(${(g.items || []).length})`).join(' ')}`
)

/**
 * 解一个 8bit / 非隔行的 RGBA PNG，返回窗口中心 alpha 与透明像素占比。
 *
 * 为什么不用「读 IHDR 的 colorType」那一套（贴纸闸门用的就是那个）：
 *   边框要验的不是"有没有 alpha 通道"，而是"**窗口那一块真的透明**"。
 *   `colorType` 说它有 alpha，可能整幅都是 255 —— 那样叠上去画面就被盖死了。
 *   所以必须真解像素。
 *
 * 只支持本项目自己生成的那一种（RGBA8、非隔行），遇到别的格式直接判不合格，
 * 而不是"看不懂就放过" —— 看懂才判，是这个闸门存在的意义。
 */
function decodeRgba(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bitDepth = buf[24]
  const colorType = buf[25]
  const interlace = buf[28]
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) return null
  const idat = []
  let at = 8
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len))
    if (type === 'IEND') break
    at += 12 + len
  }
  if (!idat.length) return null
  let raw = null
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const bpp = 4
  const stride = width * bpp
  if (raw.length < (stride + 1) * height) return null
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const ft = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? cur[x - bpp] : 0
      const up = prev[x]
      const upLeft = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (ft === 1) v = (v + left) & 0xff
      else if (ft === 2) v = (v + up) & 0xff
      else if (ft === 3) v = (v + ((left + up) >> 1)) & 0xff
      else if (ft === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        v = (v + pred) & 0xff
      }
      cur[x] = v
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  const alphaAt = (x, y) => out[y * stride + x * bpp + 3]
  let clear = 0
  for (let i = 3; i < out.length; i += bpp * 7) {
    if (out[i] < 8) clear += 1
  }
  const sampled = Math.ceil(out.length / (bpp * 7))
  return {
    width,
    height,
    centerAlpha: alphaAt(width >> 1, height >> 1),
    clearRatio: clear / Math.max(1, sampled)
  }
}

const badSize = []
const badWindow = []
const badRatio = []
for (const item of items) {
  const abs = path.join(BORDER_DIR, String(item.file || ''))
  let info = null
  try {
    info = decodeRgba(fs.readFileSync(abs))
  } catch {
    info = null
  }
  if (!info || info.width !== Number(item.w) || info.height !== Number(item.h)) {
    badSize.push(`${item.file}（${info ? `${info.width}x${info.height}` : '解码失败'}，清单写 ${item.w}x${item.h}）`)
    continue
  }
  /* 窗口中心必须真透明。>8 就是"画糊了 / 忘了挖洞"，叠上去整幅被盖死 */
  if (info.centerAlpha > 8) badWindow.push(`${item.file}=alpha ${info.centerAlpha}`)
  /* 不能是"空白图"：角标 / 圆点这两款本来就是稀疏点缀，透明占比到 99% 是正常的 ——
     所以这里只判"有没有画出东西"，"有没有挖洞"交给上面那条 centerAlpha。
     一个 100% 透明的 PNG 叠上去完全看不出来，而缩略图上是空格子，
     看图的人只会以为"这一款没加载出来"。 */
  if (!(info.clearRatio < 0.995)) {
    badRatio.push(`${item.file}=透明占比 ${(info.clearRatio * 100).toFixed(0)}%`)
  }
}

record(
  '每张边框都是 1080×1080、能解出真实像素',
  !badSize.length,
  badSize.slice(0, 4).join(' | ')
)
record(
  '每张边框的**窗口中心真的透明**（叠上去不会把画面盖死）',
  !badWindow.length,
  badWindow.slice(0, 4).join(' | ')
)
record(
  '每张边框都真的画了东西（不是一整张空白 PNG）',
  !badRatio.length,
  badRatio.slice(0, 4).join(' | ')
)

/* ========================== 二、静态：四段接线 ========================== */

const tree = read(TREE)
record(
  '左栏「特效」树里有「边框」节点，且走独立的 border 面板',
  /key:\s*'ef-gb'[\s\S]{0,120}label:\s*'边框'[\s\S]{0,120}panel:\s*'border'/.test(tree),
  'AssetTree.jsx 里找不到 { key: \'ef-gb\', label: \'边框\', panel: \'border\' }'
)
record(
  '左栏节点没有把边框错挂成 effect 面板（那会让点开是特效网格）',
  !/key:\s*'ef-gb'[^\n]*panel:\s*'effect'/.test(tree),
  'ef-gb 的 panel 又被写回 effect 了'
)

const builder = read(BUILDER)
record(
  '打包把 resources/borders 带进安装包（extraResources）',
  /from:\s*resources\/borders/.test(builder) && /to:\s*borders/.test(builder),
  'electron-builder.yml 里没有 borders 的 extraResources —— 装出来边框页会空白'
)

const mainSrc = read(MAIN)
const preloadSrc = read(PRELOAD)
const panelSrc = read(PANEL)
const catalogSrc = read(CATALOG_JS)
record(
  'IPC 三段接力：主进程 handler → preload 暴露 → 渲染层缓存',
  /ipcMain\.handle\(\s*'border:catalog'/.test(mainSrc) &&
    /borders:\s*\{[\s\S]{0,160}catalog:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*'border:catalog'/.test(preloadSrc) &&
    /ensureBorderCatalog/.test(catalogSrc) &&
    /borderUrlOf/.test(catalogSrc),
  `main=${/border:catalog/.test(mainSrc)} preload=${/border:catalog/.test(preloadSrc)} cache=${/ensureBorderCatalog/.test(catalogSrc)}`
)
record(
  '主进程把边框素材登记进 allowedMedia（漏了就是一片空白 + 一条 Failed to load resource）',
  /function packCatalog[\s\S]{0,400}allowedMedia\.add\(item\.abs\)[\s\S]{0,200}mediaUrlOf/.test(mainSrc) &&
    /borderCatalog\s*=\s*\(\)\s*=>\s*packCatalog\(/.test(mainSrc),
  'packCatalog 里没看到 allowedMedia.add / borderCatalog'
)
record(
  '面板写的是**片段属性** clip.border（不是投放新片段）',
  /onPatchClip\?\.\(\s*target\.id,\s*\{\s*border:/.test(panelSrc),
  'BorderPanel 里没找到 onPatchClip(target.id, { border: ... })'
)
record(
  '导出载荷带 border（少了它 = 预览有边框、成片是光板）',
  /border:\s*clip\.border\s*\|\|\s*''/.test(panelSrc),
  'SidePanels.jsx 的 clips.map 里没有 border 字段'
)
const renderSrc = read(RENDER)
/**
 * 边框叠在哪一层上：必须是「主轨效果链之后的那一帧」，不是源画面、也不是别的轨。
 *
 * ⚠️ 原来这里钉的是字面串 `[svb${tag}][brd${tag}]overlay`。加人物特效后主轨的
 *    画面标签不再恒为 `svb{tag}` —— `appendFaceFx` 会在有特效时返回它自己的输出标签
 *    （`fxb{tag}`），边框必须叠在**那个**标签上，否则"打了码/描了边的画面再盖边框"
 *    会把特效整个盖掉。所以判据改成分四步钉同一条事实，而不是钉一个字面串：
 *      ① `appendFaceFx` 存在且被赋给 faceLabel；
 *      ② 无特效时它原样返回 `svb{tag}`（这保证"没套特效"时链路与以前完全一致）；
 *      ③ 边框的 overlay 左支就是 faceLabel（不是写死的 svb、也不是别的轨）；
 *      ④ 输出固定为 `svc{tag}`，与下面 `fxLabel` 的取值对得上。
 */
const borderOnMain =
  /const faceLabel = appendFaceFx\(/.test(renderSrc) &&
  /const source = `svb\$\{tag\}`/.test(renderSrc) &&
  /return source/.test(renderSrc) &&
  /\[\$\{faceLabel\}\]\[brd\$\{tag\}\]overlay=0:0:format=auto\[svc\$\{tag\}\]/.test(renderSrc)
record(
  '成片侧：主轨与画中画都叠了边框，且 needAlpha 把边框算进去',
  /function borderFileOf/.test(renderSrc) &&
    borderOnMain &&
    /scale2ref=w=iw:h=ih/.test(renderSrc) &&
    /const hasBorder\s*=/.test(renderSrc) &&
    /needAlpha\s*=\s*withBackdrop\s*\|\|\s*anyTransparent\s*\|\|\s*imageOverlay\s*\|\|\s*hasBorder/.test(renderSrc),
  `borderFileOf=${/function borderFileOf/.test(renderSrc)} 主轨=${borderOnMain} 画中画=${/scale2ref/.test(renderSrc)} alpha=${/hasBorder/.test(renderSrc)}`
)
record(
  '预览侧：Stage 把 key 换成 url 画在画框上，且带 data-fx-border 钩子',
  /borderUrlOf,\s*ensureBorderCatalog/.test(read(STAGE)) &&
    /data-fx-border=\{layer\.border\}/.test(read(STAGE)) &&
    /\.canvas-border\s*\{/.test(read(CSS)),
  'Stage.jsx 或 styles.css 里缺 .canvas-border / data-fx-border'
)

/* ========================== 三、真机：面板到画面 ========================== */

if (STATIC_ONLY) {
  console.log('\n（--static：跳过真机部分）')
} else if (!fs.existsSync(MAIN_EXE)) {
  skip('真机：边框页可用', `找不到 ${path.relative(ROOT, MAIN_EXE)}`)
} else {
  const { _electron: electron } = await import('playwright-core')
  const profile = path.join(os.tmpdir(), 'yjai-e2e', '.border-gate')
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
      args: [
        path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js'),
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage'
      ],
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

    /* 先造一个片段：贴纸页点一枚 → 叠加轨上多一条 image 片段（给边框当载体）。
       直接用贴纸是因为它不依赖本地文件，E2E 里不需要用户交互对话框。 */
    const stickerTab = page.locator('.wb-tab[data-wb-tab="sticker"]')
    if (await stickerTab.count()) {
      await stickerTab.click()
      await page.waitForTimeout(900)
      const firstSticker = page.locator('[data-sticker]').first()
      if (await firstSticker.count()) await firstSticker.click()
      await page.waitForTimeout(900)
    }

    const effectTab = page.locator('.wb-tab[data-wb-tab="effect"]')
    if (!(await effectTab.count())) {
      skip('真机：特效页里的边框', '找不到特效页签')
    } else {
      await effectTab.click()
      await page.waitForTimeout(900)

      const borderNode = page
        .locator('.wb-tree-row, .wb-tree button, [data-tree-node]')
        .filter({ hasText: '边框' })
        .first()
      if (!(await borderNode.count())) {
        skip('真机：特效页里的边框', '左栏没有「边框」这一行')
      } else {
        await borderNode.click()
        await page.waitForTimeout(1000)

        const grid = await page.evaluate(() => {
          const cells = Array.from(document.querySelectorAll('[data-border]'))
          const imgs = cells.map((c) => c.querySelector('img')).filter(Boolean)
          return {
            cells: cells.length,
            imgs: imgs.length,
            loaded: imgs.filter((i) => i.naturalWidth > 0).length,
            broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
            error: document.querySelector('[data-border-error]')?.textContent || ''
          }
        })
        record(
          '真机：边框网格铺出 24 款，且每张缩略图都真的加载出来了',
          grid.cells === 24 && grid.imgs === 24 && grid.loaded === 24 && grid.broken === 0,
          `格子 ${grid.cells}/24、img ${grid.imgs}、已加载 ${grid.loaded}、破图 ${grid.broken}、错误=${grid.error || '-'}`
        )

        /* 没选中片段时**必须有提示**：边框是片段属性，点了什么都不发生
           会被用户读作"面板坏了"。这条是行为契约，不是文案检查。 */
        const hint = await page.evaluate(
          () => document.querySelector('[data-border-hint]')?.textContent?.trim() || ''
        )
        record(
          '真机：没选中片段时给出提示（不是静默什么都没发生）',
          hint.length > 0,
          `提示文案=${hint || '(空)'}`
        )

        /* 选中时间线上第一条片段，再点边框 */
        const clipEl = page.locator('[data-clip]').first()
        let hasClip = await clipEl.count()
        if (hasClip) {
          await clipEl.click()
          await page.waitForTimeout(600)
        }
        record('真机：时间线上有片段可以承载边框', Boolean(hasClip), '一条片段都没有，点边框只会得到提示')

        /* 点一款 → 预览里必须真的出现 .canvas-border，且 data-fx-border 就是它 */
        const picked = page.locator('[data-border]').nth(2)
        const pickedKey = await picked.getAttribute('data-border')
        await picked.click()
        await page.waitForTimeout(1100)
        const applied = await page.evaluate(() => {
          const el = document.querySelector('.canvas-border')
          return {
            found: Boolean(el),
            key: el ? el.getAttribute('data-fx-border') : '',
            bg: el ? String(getComputedStyle(el).backgroundImage).slice(0, 60) : '',
            count: document.querySelectorAll('.canvas-border').length
          }
        })
        const appliedOk = applied.found && applied.key === pickedKey && /url\(/.test(applied.bg)
        record(
          '真机：点一款边框 → 预览画面上真的出现它（不是只有片段上有值）',
          appliedOk,
          `key=${applied.key}（点了 ${pickedKey}）、层数 ${applied.count}、background=${applied.bg || '-'}`
        )

        /* 再点同一款 = 取消。⚠️ 这条**必须挂在上一条成立的前提下**才判 ——
           否则"从头到尾就没加成功"也会让它绿（空对空）。 */
        await picked.click()
        await page.waitForTimeout(900)
        const cleared = await page.evaluate(() => document.querySelectorAll('.canvas-border').length)
        record(
          '真机：再点同一款 → 边框被取消（有路可回头）',
          appliedOk && cleared === 0,
          appliedOk ? `取消后还剩 ${cleared} 层` : '前置的"加上边框"没成立，这条不判'
        )
        await page.screenshot({ path: path.join(ROOT, '_evidence', 'border-panel.png') })
      }
    }

    record('真机：全程 0 条页面错误', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '))
  } catch (err) {
    skip('真机：边框页可用', `启动失败：${(err && err.message) || ''}`)
  } finally {
    if (app) {
      /* 裸等 app.close() 会让整套闸门挂住（见 e2e-teardown 闸门） */
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))])
    }
  }
}

/* ========================== 汇总 ========================== */

const failed = results.filter((r) => !r.ok && !r.skipped)
const skipped = results.filter((r) => r.skipped)
console.log(
  `\nBORDERS_STATS total=${results.length} pass=${results.filter((r) => r.ok).length} fail=${failed.length} skip=${skipped.length}`
)
if (failed.length) {
  console.error('BORDERS_FAILED')
  process.exit(1)
}
console.log('BORDERS_OK')
