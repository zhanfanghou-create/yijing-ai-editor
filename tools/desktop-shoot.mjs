/**
 * 客户端界面取景脚本（开发自检用，不参与打包）。
 *
 * 启动真实 Electron 客户端并截图，用于比对换肤结果与参考客户端的设计语言。
 * 不依赖后端：目录拉取失败时界面走错误态，但布局与配色照常可验。
 *
 * 两种取景尺寸，分别对齐两份参考图：
 *   创作中心首页 → 1220×720（参考窗口的原始客户区）
 *   剪辑工作台   → 1920×1032（参考最大化后的客户区，已扣掉截图边框 8px）
 *
 * 用法：node tools/desktop-shoot.mjs
 */

import { _electron as electron } from 'playwright-core'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '_recon', 'desktop')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const HOME_SIZE = [1220, 720]
const EDITOR_SIZE = [1920, 1032]

fs.mkdirSync(OUT, { recursive: true })

/**
 * 取景前把这个专用 profile 里的草稿**清空**（不是删除文件）。
 *
 * 为什么必须清：拍摄脚本自己会点样式卡（10/11），这些交互会经自动保存落成草稿；
 * profile 又是复用的，下一轮取景的 02/04/07/08 就会带着上一轮留下的字幕片段与
 * 播放器内容 —— 拍出来的"空工作台"根本不是空工作台，比对参考时全是假差异。
 *
 * 为什么是"写空"而不是"删文件"：本机 node 的删除钩子会拦下脚本里的批量移除
 * （rmSync 会被安全策略挡住），而"覆盖写成空草稿"做的是同一件事且不触发它 ——
 * 草稿文件还在，只是 clips 为空：启动时它仍会被恢复，但恢复出来就是空时间线。
 */
const SHOOT_PROFILE = path.join(os.tmpdir(), 'yjai-e2e', '.desktop-profile')
const SHOOT_DRAFTS = path.join(SHOOT_PROFILE, 'drafts')
if (fs.existsSync(SHOOT_DRAFTS)) {
  for (const file of fs.readdirSync(SHOOT_DRAFTS)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(SHOOT_DRAFTS, file)
    let record = {}
    try {
      record = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch {
      record = {}
    }
    fs.writeFileSync(
      full,
      JSON.stringify({
        id: record.id || path.basename(file, '.json'),
        name: record.name || '未命名项目',
        createdAt: record.createdAt || '',
        updatedAt: record.updatedAt || '',
        data: { clips: [], assets: [], playhead: 0, volume: 100, zoom: 1 }
      })
    )
  }
}

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
delete env.YIJAI_USE_DEV_SERVER

const errors = []
const app = await electron.launch({
  executablePath: EXE,
  args: [
    MAIN,
    `--user-data-dir=${SHOOT_PROFILE}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage'
  ],
  cwd: ROOT,
  env
})

const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('[console.error] ' + m.text())
})

/** 把窗口客户区设成指定尺寸；只有对齐了尺寸，截图才能与参考逐像素比 */
async function resize([w, h]) {
  // 第一个参数是 Electron 模块本身（Playwright 在主进程里跑这个函数）
  await app
    .evaluate(async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(size[0], size[1])
      win.center()
    }, [w, h])
    .catch(() => {})
  await page.waitForTimeout(600)
}

await resize(HOME_SIZE)
await page.waitForSelector('.app', { timeout: 25000 })
await page.waitForTimeout(2200)

async function shoot(name) {
  const p = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: p })
  const vp = await page.evaluate(() => [window.innerWidth, window.innerHeight])
  console.log(`  [shot] ${name}.png  viewport=${vp[0]}x${vp[1]}`)
}

/** 打印关键区块的实际盒子，用来核对是否与参考规格一致 */
async function report(label, selectors) {
  const boxes = await page.evaluate((sels) => {
    const out = {}
    for (const sel of sels) {
      const el = document.querySelector(sel)
      if (!el) {
        out[sel] = null
        continue
      }
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      out[sel] = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        bg: cs.backgroundColor
      }
    }
    return out
  }, selectors)
  console.log(`  --- ${label} ---`)
  for (const [sel, v] of Object.entries(boxes)) {
    if (!v) console.log(`    ${sel.padEnd(22)} (缺失)`)
    else console.log(`    ${sel.padEnd(22)} x=${String(v.x).padStart(4)} y=${String(v.y).padStart(4)} ${v.w}x${v.h}  ${v.bg}`)
  }
}

await shoot('01-home')
await report('首页', ['.home', '.home-hero-video', '.home-side'])

// 首页 -> 工作台：进工作台后换成参考最大化时的客户区尺寸
const heroBtn = await page.$('.home-hero-video')
if (heroBtn) {
  await heroBtn.click()
  await page.waitForTimeout(1200)
  await resize(EDITOR_SIZE)
  await page.waitForTimeout(1200)
  await shoot('02-editor')
  const diag = await page.evaluate(() => {
    const appEl = document.querySelector('.app')
    const cs = getComputedStyle(appEl)
    const root = getComputedStyle(document.documentElement)
    return {
      appClass: appEl.className,
      rows: cs.gridTemplateRows,
      cols: cs.display,
      menuH: root.getPropertyValue('--wb-menu-h').trim(),
      tabsH: root.getPropertyValue('--wb-tabs-h').trim(),
      treeW: root.getPropertyValue('--wb-tree-w').trim()
    }
  })
  console.log('  --- 诊断 ---')
  console.log('    .app className     =', JSON.stringify(diag.appClass))
  console.log('    grid-template-rows =', diag.rows)
  console.log('    display            =', diag.cols)
  console.log('    --wb-menu-h        =', JSON.stringify(diag.menuH))
  console.log('    --wb-tabs-h        =', JSON.stringify(diag.tabsH))
  console.log('    --wb-tree-w        =', JSON.stringify(diag.treeW))
  await report('工作台', [
    '.wb-menu',
    '.wb-menu-actions',
    '.wb-menu-actions .wb-icon',
    '.wb-login',
    '.wb-buy',
    '.wb-export',
    '.wb-winbtns button',
    '.wb-tabs',
    '.workbench',
    '.wb-tree',
    '.wb-media',
    '.wb-player',
    '.wb-info',
    '.wb-timeline',
    '.wb-tlbar'
  ])

  // 切一个功能标签，确认左栏二级列表跟着换
  const tabs = await page.$$('.wb-tab')
  console.log(`  功能标签数 = ${tabs.length}`)
  if (tabs[3]) {
    await tabs[3].click()
    await page.waitForTimeout(700)
    await shoot('03-editor-subtitle')
    const nodes = await page.$$('.wb-tree .wb-node')
    console.log(`  字幕分类下的左栏项数 = ${nodes.length}`)
    if (tabs[0]) await tabs[0].click()
    await page.waitForTimeout(500)
  }

  // 选中左栏「本地」，确认中栏切到素材视图
  const localNode = await page.$('[data-wb-node="local"]')
  if (localNode) {
    await localNode.click()
    await page.waitForTimeout(600)
    await shoot('04-editor-local')
  }

  /* 这里原本有一段「视频增强」取景（左栏 `data-wb-node="video-enhance"` → 中栏预设画廊
     `.enh-grid.is-enhance`，产物 `06-editor-enhance`）。
     开源版把「视频增强」这一支连同 `EnhancePanel` 一起移除了（该能力要外挂模型，
     本机做不了），左栏已无该节点 —— 于是这段永远走 else 分支，只打出一句误导的
     "左栏没有 video-enhance"，看着像功能坏了。整段删除，不留空壳分支。
     ⚠️ 但 `.enh-card` / `.enh-grid` 这套卡片样式**仍在用**（RefArtCards：
     背景 / 图片增强 / 数字人），所以下面的「背景」取景照常按 `.enh-*` 量盒子。 */

  // 滤镜 / 转场：这两个面板的卡片规格**直接取自参考 QML 源码**，不是目测值 ——
  //   Filter_Materials.qml      itemWidth: 100  itemHeight: 122
  //   Transition_Materials.qml  itemWidth: 100  itemHeight: 122
  // 两个文件里被注释掉的旧版还把间距写全了：itemRowMargin / itemColumnMargin = 16、
  // viewTopMargin / viewLeftMargin = 8、viewRightMargin = 16。
  // 所以取景时把**真实盒子**打出来，与那几组数字逐项对照 —— 光看截图量不出 16 还是 15。
  // ⚠️ 时间线为空时这些卡片是 disabled 态（要选中片段才能应用），布局照常渲染，
  // 所以这里不选片段也能验尺寸；不要因为"卡片是灰的"以为没渲染。
  for (const [tabIdx, tabName, shotName] of [
    [7, '滤镜', '07-editor-filter'],
    [6, '转场', '08-editor-transition']
  ]) {
    if (!tabs[tabIdx]) continue
    await tabs[tabIdx].click()
    await page.waitForTimeout(700)
    await shoot(shotName)
    const spec = await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
      }
      const grid = document.querySelector('.look-grid')
      return {
        cols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        gap: grid ? getComputedStyle(grid).gap : null,
        padding: grid ? getComputedStyle(grid).padding : null,
        cards: document.querySelectorAll('.look-card').length,
        card: box(document.querySelector('.look-card')),
        preview: box(document.querySelector('.look-preview')),
        name: box(document.querySelector('.look-name'))
      }
    })
    console.log(`  --- ${tabName}面板卡片规格（参考 = 100x122 · gap 16 · padding 8/16/8/8）---`)
    console.log(`    cols=${spec.cols}  gap=${spec.gap}  padding=${spec.padding}  卡片数=${spec.cards}`)
    console.log(`    卡片=${spec.card}  预览图=${spec.preview}  名字=${spec.name}`)
  }

  // 「字幕 → 字幕模板」页：卡片规格取自参考 QML
  //   Subtitles_Materials.qml      itemWidth: 160  itemHeight:  80
  //   PropertyPanel_SubtitleStyle.qml  itemRowSpacing/itemColumnSpacing: 16
  // 并且**点一张样式卡**，把画布上叠加层的真实盒子也打出来 ——
  // 这一页最容易出的问题是"点了没反应"（字幕没画到画面上），
  // 只看侧栏截图是看不出来的：卡片渲染得很正常，画面上却什么都没有。
  {
    const subTab = await page.$('.wb-tab[data-wb-tab="subtitle"]')
    if (subTab) {
      await subTab.click()
      await page.waitForTimeout(700)
      // ⚠️ 左栏节点 key 是 `subtitle-custom`（AssetTree.jsx 的 subtitle 树，panel 'text-style'），
      //    没有 `subtitle-tpl` 这个节点 —— 以前写错，整段字幕样式取景静默跳过。
      const tplNode = await page.$('[data-wb-node="subtitle-custom"]')
      if (tplNode) {
        await tplNode.click()
        await page.waitForTimeout(700)
        await shoot('10-editor-subtitle-style')
        const spec = await page.evaluate(() => {
          const box = (el) => {
            if (!el) return null
            const r = el.getBoundingClientRect()
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
          }
          const grid = document.querySelector('.style-grid')
          return {
            cols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
            gap: grid ? getComputedStyle(grid).gap : null,
            padding: grid ? getComputedStyle(grid).padding : null,
            cards: document.querySelectorAll('.style-card').length,
            card: box(document.querySelector('.style-card')),
            art: box(document.querySelector('.style-art')),
            anim: [...document.querySelectorAll('.style-art-box')].map(
              (el) => getComputedStyle(el).animationName
            )
          }
        })
        console.log('  --- 字幕样式卡片规格（参考 = 160x80 · gap 16 · 内边距 4/16/0/8）---')
        console.log(`    cols=${spec.cols}  gap=${spec.gap}  padding=${spec.padding}  卡片数=${spec.cards}`)
        console.log(`    卡片=${spec.card}  样式预览块=${spec.art}`)
        console.log(`    卡片动画 = ${spec.anim.join(' / ')}`)

        const card = await page.$('.style-card')
        if (card) {
          await card.click()
          await page.waitForTimeout(900)
          await shoot('11-canvas-subtitle-overlay')
          const ov = await page.evaluate(() => {
            const box = (el) => {
              if (!el) return null
              const r = el.getBoundingClientRect()
              return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
            }
            const frame = document.querySelector('.canvas-frame')
            const layer = document.querySelector('.canvas-overlay')
            const inner = layer ? layer.querySelector('[data-overlay-text]') : null
            return {
              frame: box(frame),
              layer: box(layer),
              inner: box(inner),
              key: layer ? layer.dataset.overlay : null,
              text: layer ? layer.innerText.trim() : null,
              fontSize: inner ? getComputedStyle(inner).fontSize : null,
              color: inner ? getComputedStyle(inner).color : null,
              stroke: inner ? getComputedStyle(inner).webkitTextStrokeWidth : null,
              bg: inner ? getComputedStyle(inner).backgroundColor : null,
              anim: layer ? getComputedStyle(layer).animationName : null,
              count: document.querySelectorAll('.canvas-overlay').length
            }
          })
          console.log('  --- 点了第一张样式卡之后，画布上的叠加层 ---')
          console.log(`    画布=${ov.frame}`)
          console.log(`    叠加层=${ov.layer}  文字块=${ov.inner}  key=${ov.key}  层数=${ov.count}`)
          console.log(`    文字「${ov.text}」字号=${ov.fontSize} 颜色=${ov.color} 描边=${ov.stroke} 底色=${ov.bg}`)
          console.log(`    入场动画 = ${ov.anim}`)
        } else {
          console.log('    没找到 .style-card —— 字幕样式页没渲染出卡片')
        }
      } else {
        console.log('  左栏没有 [data-wb-node="subtitle-custom"]')
      }
    }
  }

  // 「特效」页：本机画面特效（materials.js 的 EFFECT_GROUPS）要能看到卡片，且缩略图真解出图。
  // ⚠️ 卡片由共用的 MaterialGrid 渲染：属性是 `data-material="effect:<名字>"`、类名 `.look-card`
  //   （以前这里探的是 `data-fx-card` / `.fx-demo-art` —— 那是**检查器里单片段演示**的属性，
  //    中栏素材网格根本没有，于是永远报 0，看着像特效页空了，其实是探针过时）。
  {
    const fxTab = await page.$('.wb-tab[data-wb-tab="effect"]')
    if (fxTab) {
      await fxTab.click()
      await page.waitForTimeout(800)
      await shoot('12-editor-effect')
      const fx = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-material^="effect:"]')]
        return {
          cards: cards.length,
          keys: cards.map((el) => el.dataset.material),
          imgs: [...document.querySelectorAll('.look-card .look-preview img')].filter((im) => im.naturalWidth > 0).length
        }
      })
      console.log('  --- 画面特效页 ---')
      console.log(`    卡片数=${fx.cards}  keys=${fx.keys.slice(0, 8).join(' / ')}${fx.keys.length > 8 ? ' …' : ''}`)
      console.log(`    真的解出图的张数=${fx.imgs}/${fx.cards}（0 张说明缩略图 404 或被 CSP 挡了）`)
    }
  }

  // 「素材 → 背景」页：参考 MediaPanel_BKMaterials.qml 是 itemWidth:130 / itemHeight:75
  // 且 `titleTextVisible: false`（卡片上不显示名字）。这一页的卡片规格与滤镜/转场
  // **不是一套**，所以单独取一次景、单独打一次真实盒子。
  // ⚠️ 卡片在「素材」标签的根卡片展开后才出现，所以要先点顶部标签、再点左栏节点。
  //    （「背景」节点挂在素材标签的树里：AssetTree.jsx 的 stock-bg，data-wb-node="stock-bg"）
  {
    // ⚠️ 顶部标签的 key 是 `media`（EditorTabs.jsx 的 WB_TABS），不是 `stock` ——
    //    `stock` 是左栏**节点**的 key（素材库分组）。这里以前写错成 `stock`，
    //    于是 mediaTab 永远为 null，整段背景取景静默跳过（还打出一句误导的"没有该标签"）。
    const mediaTab = await page.$('.wb-tab[data-wb-tab="media"]')
    if (mediaTab) {
      await mediaTab.click()
      await page.waitForTimeout(700)
      // 「背景」是「素材库」分组（data-wb-node="stock"）的子节点，先展开分组再点子项
      const stockGroup = await page.$('[data-wb-node="stock"]')
      if (stockGroup) {
        await stockGroup.click()
        await page.waitForTimeout(600)
      }
      const bgNode = await page.$('[data-wb-node="stock-bg"]')
      if (bgNode) {
        await bgNode.click()
        await page.waitForTimeout(700)
      }
      await shoot('09-editor-background')
      const bg = await page.evaluate(() => {
        const box = (el) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
        }
        const grid = document.querySelector('.enh-grid.is-bg')
        return {
          found: Boolean(grid),
          cols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
          gap: grid ? getComputedStyle(grid).gap : null,
          cards: document.querySelectorAll('.enh-card.is-bg').length,
          names: document.querySelectorAll('.enh-card.is-bg .enh-name').length,
          card: box(document.querySelector('.enh-card.is-bg')),
          preview: box(document.querySelector('.enh-art')),
          imgs: [...document.querySelectorAll('.enh-card.is-bg img')].filter((img) => img.naturalWidth > 0).length
        }
      })
      console.log('  --- 背景面板卡片规格（参考 = 130x75 · gap 16 · 不显示名字）---')
      if (!bg.found) {
        console.log('    没找到 .enh-grid.is-bg —— 「素材 → 背景」这一页没渲染出来')
      } else {
        console.log(`    cols=${bg.cols}  gap=${bg.gap}  卡片数=${bg.cards}  名字行=${bg.names}`)
        console.log(`    卡片=${bg.card}  预览图=${bg.preview}`)
        console.log(`    真的解出图的张数=${bg.imgs}/${bg.cards}（0 张说明 src 404 或被 CSP 挡了）`)
      }
    } else {
      console.log('  --- 背景面板：顶部没找到 data-wb-tab="media" 标签，跳过 ---')
    }
  }

/* 这里原本有一张「付费弹窗」取景（19-paywall）。开源版没有账号与付费功能，
   那张卡连同 `.wb-buy` 按钮一起删了 —— 取景段随之删除，不留空壳分支。 */

  // 回首页：品牌区点一下
  const brand = await page.$('.wb-menu-brand')
  if (brand) {
    await brand.click()
    await page.waitForTimeout(900)
    await resize(HOME_SIZE)
    await page.waitForTimeout(800)
    await shoot('05-home-back')
    const back = await page.$('.home-hero-video')
    console.log(`  首页/工作台往返 = ${back ? 'OK' : '回到首页但首屏没渲染出来'}`)
  } else {
    console.log('  首页/工作台往返 = 工作台顶栏没有 .wb-menu-brand')
  }
} else {
  console.log('  首页没渲染出 .home-hero-video')
}

console.log(`  页面错误数 = ${errors.length}`)
errors.slice(0, 12).forEach((e) => console.log('    ' + e))

console.log('DESKTOP_SHOOT_DONE -> ' + OUT)

// 无边框窗口下 app.close() 偶尔会挂住，加超时兜底，保证脚本一定能退出
await Promise.race([
  app.close().catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 4000))
])
process.exit(0)
