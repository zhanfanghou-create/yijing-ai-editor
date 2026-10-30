#!/usr/bin/env node
/**
 * 闸门：插件页（本地素材包）—— 导入 → 面板可见 → 边框库真的多出来 → 套上片段 → 预览生效。
 *
 * 这道闸门治的是「装进去了但看不见」这一类，每一种都不会报错：
 *
 *   1. 装好了、素材库没变 —— 主进程的 `packCaches` 与渲染层的 `borderCatalog` 是**两份**缓存，
 *      漏清任何一份，面板都会显示"导入成功"而边框页仍是原来那 24 款。
 *   2. 素材库变了、预览不动 —— `borderUrlOf` 拿不到新 key 就返回空串，
 *      `.canvas-border` 整个不渲染，画面一点变化都没有（第 ⑧ 条判据读的是预览 DOM）。
 *   3. 停用了却还在 —— `groupsOf` 忘了过滤 `enabled`，用户关了插件它还在素材库里。
 *   4. 面板说自己支持 .ofx —— 那是要宿主实现 OpenFX C++ API 的事，本工程不做。
 *      这条断言钉的是"不许假装"，文字层面真出现 '支持 .ofx' 就红。
 *
 * 纯静态部分可单独跑：
 *   node tools/check-plugins.mjs --static
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
const SHARED_PLUGIN = path.join(SRC, 'shared', 'pluginPack.js')
const MAIN_PLUGINS = path.join(SRC, 'main', 'plugins.js')
const PACK = path.join(SRC, 'main', 'materialPack.js')
const BORDERS = path.join(SRC, 'main', 'borders.js')
const STICKERS = path.join(SRC, 'main', 'stickers.js')
const MAIN = path.join(SRC, 'main', 'index.js')
const PRELOAD = path.join(SRC, 'preload', 'index.js')
const TREE = path.join(SRC, 'renderer', 'components', 'AssetTree.jsx')
const PANEL = path.join(SRC, 'renderer', 'components', 'SidePanels.jsx')
const TABS = path.join(SRC, 'renderer', 'components', 'EditorTabs.jsx')
const BORDER_CAT = path.join(SRC, 'renderer', 'borderCatalog.js')
const STICKER_INDEX = path.join(SRC, 'renderer', 'stickerIndex.js')
const FIXTURE_DIR = path.join(ROOT, 'tools', 'fixtures', 'plugin-border')
const IMG = path.join(ROOT, 'tools', 'fixtures', 'portrait.jpg')
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

console.log('\n[静态] 数据 / 接线 / 安全面\n')

{
  const shared = read(SHARED_PLUGIN)
  const mainP = read(MAIN_PLUGINS)

  record('纯逻辑模块存在且导出清单校验', /function normalizeManifest/.test(shared) && /module\.exports/.test(shared))
  record(
    '只支持 两种类型（border / sticker），不认别的',
    /key: 'border'/.test(shared) && /key: 'sticker'/.test(shared) && /KINDS\.some/.test(shared)
  )
  /* id 会进目录名、进 yjai-media 路径、进草稿 —— 必须是窄字符集 */
  record(
    'id 只允许小写字母数字与连字符',
    /ID_RE = \/\^\[a-z0-9\]\[a-z0-9-\]\{1,39\}\$\//.test(shared)
  )
  record(
    '条目 key 由「插件 id + 序号」拼（重装同一个插件后草稿不失效）',
    /function itemKeyOf/.test(shared) && /\$\{GROUP_PREFIX\}\$\{id\}-\$\{index\}/.test(shared)
  )
  record('PNG 头自己读宽高（不信清单、不等解码）', /function pngInfo/.test(shared) && /IHDR/.test(shared))

  record('主进程安装模块存在', /function install/.test(mainP) && /function listPlugins/.test(mainP))
  /* 清单是用户可写的：file 字段里一个 `..` 就能让面板读到盘上任意 PNG */
  record(
    '清单里的 file 走路径穿越校验',
    /file\.includes\('\/'\)/.test(mainP) && /file\.includes\('\\\\'\)/.test(mainP)
  )
  record(
    '删除走回收站，没有回收站就拒绝（不退化成直接删）',
    /typeof deps\.trash === 'function'/.test(mainP) && /没有回收站/.test(mainP)
  )
  record(
    '停用的插件不进素材库（groupsOf 过滤 enabled）',
    /\.filter\(\(p\) => p\.enabled && p\.kind === want\)/.test(mainP)
  )
  /* 先写临时目录再整体替换：中途失败不会留半个插件让面板显示残缺 */
  record('安装先落临时目录再原子替换', /\.tmp-/.test(mainP) && /fs\.renameSync\(staging, target\)/.test(mainP))
}

{
  const pack = read(PACK)
  record('素材读取器支持合并插件分组', /deps\.extraGroups/.test(pack) && /for \(const group of extra\)/.test(pack))
  /* 插件图不在 packRoot 底下 —— 走 normalizeItem 的路径校验必然判越界，
     所以必须"已规范化"地塞进来。这条断言防的是有人把它挪进 normalizeItem。 */
  record(
    '插件项不再重复做 packRoot 相对校验（否则必然判越界）',
    !/normalizeItem\(item/.test(pack)
  )
  record('边框库把 extraGroups 透传给读取器', /\.\.\.deps/.test(read(BORDERS)))
  record('贴纸库把 extraGroups 透传给读取器', /\.\.\.deps/.test(read(STICKERS)))
}

{
  const main = read(MAIN)
  record(
    '两个素材库都把插件分组喂给读取器（packCatalog 传 extraGroups）',
    /extraGroups: pluginGroupsOf\(name\)/.test(main) && /function pluginGroupsOf/.test(main)
  )
  record(
    '三个变更动作都清素材缓存（少一处＝"导入成功但看不到"）',
    (main.match(/invalidatePackCaches\(\)/g) || []).length >= 3,
    `实际 ${(main.match(/invalidatePackCaches\(\)/g) || []).length} 处`
  )
  record(
    '插件缩略图登记进 allowedMedia（漏了就是 403 + 面板全白）',
    /allowedMedia\.add\(first\.abs\)/.test(main) && /pluginPayload/.test(main)
  )
  record(
    '安装的 IPC 支持直接传 dir（自动化不弹原生对话框）',
    /payload && payload\.dir/.test(main)
  )
  record('卸载走 shell.trashItem', /trash: \(target\) => shell\.trashItem\(target\)/.test(main))
  record(
    '五个 IPC 都注册了',
    ['plugin:list', 'plugin:install', 'plugin:toggle', 'plugin:remove', 'plugin:reveal'].every((c) =>
      main.includes(`'${c}'`)
    )
  )
}

{
  const pre = read(PRELOAD)
  record(
    'preload 只暴露 5 个动作，不暴露任意路径入口',
    /plugins: \{/.test(pre) &&
      /list: \(\) => ipcRenderer\.invoke\('plugin:list'\)/.test(pre) &&
      /remove: \(id\) =>/.test(pre) &&
      !/plugins[\s\S]{0,400}openPath/.test(pre)
  )
}

{
  const tree = read(TREE)
  record(
    '左栏有「插件」三项（我的插件 / 我的边框 / 我的贴纸）',
    /plugin: \{/.test(tree) && /plug-mine/.test(tree) && /plug-border/.test(tree) && /plug-sticker/.test(tree)
  )
  const tabs = read(TABS)
  record('一级页签里有「插件」', /\{ key: 'plugin', label: '插件'/.test(tabs))
  record('插件页签用的是自己的字形（IconPlugin）', /Icon: IconPlugin/.test(tabs))
  const panel = read(PANEL)
  record('面板会按模式分派到 PluginPanel', /mode === 'plugin'/.test(panel) && /function PluginPanel/.test(panel))
  /* 不许假装：面板文案里出现"支持 .ofx"之类的话就红 */
  record(
    '面板明说不支持 .ofx（不假装）',
    /不支持 \.ofx/.test(panel) && !/支持 \.ofx/.test(panel.replace(/不支持 \.ofx/g, ''))
  )
  record(
    '停用/删除后靠 packsVersion 强制重挂载边框与贴纸面板',
    /key=\{`bd-\$\{packsVersion\}`\}/.test(panel) && /key=\{`sk-\$\{packsVersion\}`\}/.test(panel)
  )
  record(
    '变更后清两份渲染层缓存',
    /resetBorderCatalog\(\)/.test(panel) && /resetStickerCatalog\(\)/.test(panel)
  )
  record('边框清单模块提供 reset', /export function resetBorderCatalog/.test(read(BORDER_CAT)))
  record('贴纸索引模块提供 reset', /export function resetStickerCatalog/.test(read(STICKER_INDEX)))
  record(
    '面板给了可被自动化驱动的钩子',
    ['data-plug-import', 'data-plug-id', 'data-plug-toggle', 'data-plug-remove', 'data-plug-empty'].every((a) =>
      panel.includes(a)
    )
  )
}

{
  const manifest = read(path.join(FIXTURE_DIR, 'manifest.json'))
  record('夹具带清单且类型是边框', /"kind": "border"/.test(manifest))
  const pngs = fs.existsSync(FIXTURE_DIR)
    ? fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.png'))
    : []
  record('夹具里有两张 PNG', pngs.length === 2, `实际 ${pngs.length} 张`)
}

/* ============================ 二、真机 ============================ */

if (!STATIC_ONLY) {
  console.log('\n[真机] 导入 → 面板 → 边框库 → 预览\n')
  let app = null
  let pageErrors = []
  let realDone = false
  let interrupt = ''
  try {
    if (!fs.existsSync(FIXTURE_DIR)) {
      skip('真机：夹具目录存在', `缺 ${path.relative(ROOT, FIXTURE_DIR)}`)
      throw new Error('no-fixture')
    }
    if (!fs.existsSync(IMG)) {
      skip('真机：图片夹具存在', `缺 ${path.relative(ROOT, IMG)}`)
      throw new Error('no-fixture')
    }
    const { _electron: electron } = await import('playwright-core')
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-plug-'))
    const env = { ...process.env, NODE_ENV: 'production' }
    delete env.ELECTRON_RUN_AS_NODE

    app = await electron.launch({
      executablePath: MAIN_EXE,
      args: [
        path.join(SRC, 'main', 'index.js'),
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--disable-dev-shm-usage'
      ],
      cwd: ROOT,
      env
    })
    const page = await app.firstWindow()
    pageErrors = []
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

    const info = await page.evaluate((p) => window.yjai.media.stat([p]), [IMG])
    const url = info && info[0] ? info[0].url : ''
    if (!url) {
      skip('真机：夹具能读出地址', 'media:stat 没返回 url')
      throw new Error('no-url')
    }

    await page.evaluate(
      (payload) => window.yjai.draft.save(payload),
      {
        name: '插件 E2E',
        data: {
          clips: [
            {
              id: 'v1',
              track: 'video',
              name: '静帧',
              assetId: 'a1',
              url,
              path: IMG,
              kind: 'image',
              start: 0,
              duration: 3,
              offset: 0,
              sourceDuration: 3
            }
          ],
          assets: [{ id: 'a1', name: '静帧', url, path: IMG, kind: 'image', duration: 3, source: 'local' }],
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

    /* ① 插件页签 + 左栏三项 */
    await page.locator('.wb-tab[data-wb-tab="plugin"]').click()
    await page.waitForTimeout(400)
    const tabCount = await page.locator('.wb-tab').count()
    const hasMine = await page.locator('.wb-node[data-wb-node="plug-mine"]').count()
    record('真机：插件页签存在且左栏有「我的插件」', tabCount >= 12 && hasMine > 0, `页签 ${tabCount} 枚`)

    /* ② 空状态 + 边界说明（先看文案，不先装东西） */
    await page.locator('.wb-node[data-wb-node="plug-mine"]').click()
    await page.waitForTimeout(500)
    const emptyText = await page
      .locator('[data-plug-empty]')
      .first()
      .textContent()
      .catch(() => '')
    const noteText = await page
      .locator('[data-plug-note]')
      .first()
      .textContent()
      .catch(() => '')
    record('真机：没装插件时给的是说明，不是空白', Boolean(emptyText && emptyText.trim().length > 6), emptyText || '(空)')
    record('真机：面板写明不支持 .ofx', /不支持 \.ofx/.test(noteText), noteText.slice(0, 40))

    /* ③ 真装一次 —— 走**面板按钮**这条产品路径，不在页面里直接调 IPC。
       直调 IPC 的话面板自己的 state 不会更新，测出来的是"外力装进去了"，
       而不是"用户点导入之后看到了"。原生对话框照惯例在主进程打桩（真弹框＝永久卡住）。 */
    const patched = await app.evaluate(async ({ dialog }, dir) => {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') return false
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
      return true
    }, FIXTURE_DIR)
    record('真机：原生目录对话框可被打桩（E2E 不弹框）', patched)

    await page.locator('[data-plug-import]').click()
    let cardCount = 0
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250)
      cardCount = await page.locator('[data-plug-id]').count()
      if (cardCount > 0) break
    }
    const plugId = cardCount
      ? (await page.locator('[data-plug-id]').first().getAttribute('data-plug-id')) || ''
      : ''
    const plugImages = cardCount
      ? (await page.locator('[data-plug-id]').first().getAttribute('data-plug-images')) || ''
      : ''
    record(
      '真机：点「导入」后面板当场多出 1 张卡，且收到 2 张图',
      cardCount === 1 && plugImages === '2',
      `卡片 ${cardCount}，图片 ${plugImages}`
    )
    record('真机：纯中文清单名也能派生出合法 id', /^p-[a-z0-9]+$/.test(plugId), plugId)

    /* ④ 卡片是启用态（刚装完不该是关的） */
    const cardEnabled = cardCount
      ? await page.locator(`[data-plug-id="${plugId}"]`).getAttribute('data-plug-enabled')
      : ''
    record('真机：卡片默认启用', cardEnabled === '1', String(cardEnabled))

    /* ⑤ 边框库真的多出这 2 款（这是整道闸门的核心：缓存清没清） */
    await page.locator('.wb-tab[data-wb-tab="effect"]').click()
    await page.waitForTimeout(400)
    await page.locator('.wb-node[data-wb-node="ef-gb"]').click()
    await page.waitForTimeout(600)
    const builtinCount = await page.locator('.border-cell').count()
    const plugCells = await page.locator('.border-cell[data-border^="pv-"]').count()
    record(
      '真机：边框面板里多出插件的 2 款（内置 24 + 插件 2）',
      plugCells === 2 && builtinCount >= 26,
      `总计 ${builtinCount}，插件 ${plugCells}`
    )

    /* ⑥ 套到片段上：片段真的记了 border */
    await page.locator('.clip[data-clip="v1"]').click()
    await page.waitForTimeout(400)
    const plugCell = page.locator('.border-cell[data-border^="pv-"]').first()
    const plugKey = await plugCell.getAttribute('data-border')
    await plugCell.click()
    await page.waitForTimeout(700)
    const applied = await page.locator('.border-cell.on[data-border^="pv-"]').count()
    record('真机：点插件边框后该格子进入选中态', applied === 1, `key=${plugKey}`)

    /* ⑦ 预览真的画出来了 —— 判据读画布上的 DOM，不读 clip 上的值。
       值写了但 url 解析不出来时 `.canvas-border` 根本不渲染，画面一像素不变。 */
    const preview = await page.evaluate(() => {
      const el = document.querySelector('.canvas-border[data-fx-border]')
      if (!el) return null
      return {
        key: el.getAttribute('data-fx-border'),
        bg: getComputedStyle(el).backgroundImage || '',
        w: el.getBoundingClientRect().width
      }
    })
    record(
      '真机：预览层出现了这个边框，且地址指向插件素材',
      Boolean(preview && preview.key === plugKey && /yjai-media:/.test(preview.bg) && preview.w > 10),
      JSON.stringify(preview)
    )

    /* ⑧ 停用 → 素材库立刻收回（groupsOf 必须过滤 enabled） */
    await page.locator('.wb-tab[data-wb-tab="plugin"]').click()
    await page.waitForTimeout(400)
    await page.locator(`[data-plug-toggle="${plugId}"]`).click()
    await page.waitForTimeout(800)
    const offAttr = await page.locator(`[data-plug-id="${plugId}"]`).getAttribute('data-plug-enabled')
    await page.locator('.wb-tab[data-wb-tab="effect"]').click()
    await page.waitForTimeout(300)
    await page.locator('.wb-node[data-wb-node="ef-gb"]').click()
    await page.waitForTimeout(600)
    const afterOff = await page.locator('.border-cell[data-border^="pv-"]').count()
    record('真机：停用后边框库收回插件那 2 款', offAttr === '0' && afterOff === 0, `卡片=${offAttr} 格子=${afterOff}`)

    /* ⑨ 再启用 → 回来（证明是"可逆的开关"，不是"一次性删除"） */
    await page.locator('.wb-tab[data-wb-tab="plugin"]').click()
    await page.waitForTimeout(300)
    await page.locator(`[data-plug-toggle="${plugId}"]`).click()
    await page.waitForTimeout(800)
    await page.locator('.wb-tab[data-wb-tab="effect"]').click()
    await page.waitForTimeout(300)
    await page.locator('.wb-node[data-wb-node="ef-gb"]').click()
    await page.waitForTimeout(600)
    const afterOn = await page.locator('.border-cell[data-border^="pv-"]').count()
    record('真机：再启用后插件边框回到面板', afterOn === 2, `${afterOn} 款`)

    /* ⑩ 删除（走回收站）→ 列表与素材库都清空 */
    await page.locator('.wb-tab[data-wb-tab="plugin"]').click()
    await page.waitForTimeout(300)
    await page.locator(`[data-plug-remove="${plugId}"]`).click()
    await page.waitForTimeout(1200)
    const afterRemove = await page.locator('[data-plug-id]').count()
    const emptyAgain = await page.locator('[data-plug-empty]').count()
    record('真机：删除后列表空了、回到空状态', afterRemove === 0 && emptyAgain > 0, `卡片 ${afterRemove}`)

    await page.locator('.wb-tab[data-wb-tab="effect"]').click()
    await page.waitForTimeout(300)
    await page.locator('.wb-node[data-wb-node="ef-gb"]').click()
    await page.waitForTimeout(600)
    const finalCount = await page.locator('.border-cell').count()
    record('真机：删除后边框面板回到内置款数', finalCount === builtinCount - 2, `${finalCount} vs ${builtinCount}`)

    record('真机：全程 0 页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
    realDone = true
  } catch (err) {
    interrupt = String((err && err.message) || err)
    const planned = ['no-fixture', 'no-url']
    if (!planned.includes(interrupt)) {
      console.log(`      （真机中断：${interrupt}）`)
      if (pageErrors.length) {
        console.log('      页面错误：\n        ' + pageErrors.slice(0, 6).join('\n        '))
      }
    }
  } finally {
    record('真机：整套跑到底（中断不算通过）', realDone, interrupt ? `中断于：${interrupt}` : '没走到最后一条断言')
    try {
      if (app) await Promise.race([app.close(), sleep(8000)])
    } catch {
      /* 落到强杀 */
    }
  }
}

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok && !r.skipped)
const skipped = results.filter((r) => r.skipped)
console.log(
  `\nPLUGINS_STATS total=${results.length} pass=${results.filter((r) => r.ok).length} fail=${failed.length} skip=${skipped.length}`
)
if (failed.length) {
  console.log('失败项：\n  ' + failed.map((r) => r.name).join('\n  '))
  process.exit(1)
}
console.log('PLUGINS_OK')
