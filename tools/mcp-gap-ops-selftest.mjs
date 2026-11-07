#!/usr/bin/env node
/**
 * MCP 能力层 · 双通道缺口自检（删除素材 / 导入字体 / 素材包导入 / 节拍检测）
 *
 * 这四件事原先**只有界面能做**，agent 做不到（`tools/dual-channel-map.json` 的
 * `expectedGaps` 里登记着）。补上之后数字要能证明它们真的通了，而不是"多了个名字"：
 *
 *   · 删除素材：只删素材不删片段 ⇒ 草稿里留下"片段还在、源文件没了"的行，
 *     预览黑屏、导出时才炸，而错误信息指向 ffmpeg —— 所以必须一起删，且不能误删别人。
 *   · 导入字体：只复制不写设置 ⇒ agent 导的字体在界面上永远不出现；
 *     只写设置不复制 ⇒ 重启就坏。两条都要钉。
 *   · 素材包：`unpackDraft` 的 registerUrl 忘了传 ⇒ 草稿能打开、画面全黑，
 *     而 `missing` 里也不会提（它只查文件在不在）。所以这里查**新草稿里的 url 非空**。
 *   · 节拍：包络、找重音、生成曲线三段都要与界面同源。这里用一个**节拍位置已知**的
 *     点击声素材（每 0.5 秒一下）来判：找到的点必须落在 ±0.05s 内。
 *     只判"返回了数组"的话，把灵敏度写反、把步长算错都照样绿。
 *
 * 用法：node tools/mcp-gap-ops-selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDraftStore } = require('../packages/desktop/src/main/drafts.js')
const { createOps } = require('../packages/desktop/src/main/mcp-ops.js')

let pass = 0
let skipped = 0
const fails = []

/* 检查函数可以是 async：`ops.detectBeats` 是真异步（要抽包络），
   同步调只会拿到 Promise —— 于是每条断言都在拿 undefined 做比较，
   报出来的错还长得像"实现有问题"。这里统一 await。 */
async function check(name, fn) {
  try {
    const detail = await fn()
    pass += 1
    console.log(`  ok   ${name}${detail ? ` :: ${detail}` : ''}`)
  } catch (error) {
    fails.push(`${name} :: ${error && error.message ? error.message : error}`)
    console.log(`  FAIL ${name} :: ${error && error.message ? error.message : error}`)
  }
}

function skip(name, why) {
  skipped += 1
  console.log(`  skip ${name} :: ${why}`)
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败')
}

function expectThrow(fn, keyword) {
  try {
    fn()
  } catch (error) {
    const text = String((error && error.message) || error)
    if (keyword && !text.includes(keyword)) throw new Error(`报错了但内容不对：${text}`)
    return text
  }
  throw new Error('本该报错，却静默成功了')
}

/* 异步版：`op()` 返回 rejected promise 时，同步 try/catch 抓不到（会变成
   unhandled rejection，进程照样退出 0）。异步 op 一律用这个。 */
async function expectReject(fn, keyword) {
  try {
    await fn()
  } catch (error) {
    const text = String((error && error.message) || error)
    if (keyword && !text.includes(keyword)) throw new Error(`报错了但内容不对：${text}`)
    return text
  }
  throw new Error('本该报错，却静默成功了')
}

/* ------------------------------ 夹具 ------------------------------ */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-gap-'))
const store = createDraftStore(() => root)
const ops = createOps({
  store,
  userDataDir: root,
  resourcesPath: path.join(process.cwd(), 'packages/desktop'),
  mainDir: path.join(process.cwd(), 'packages/desktop')
})

/* 两张真实存在的小图：素材包要能把它们复制进去，`mediaCount` 才不是 0 */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const mediaA = path.join(root, 'a.png')
const mediaB = path.join(root, 'b.png')
fs.writeFileSync(mediaA, Buffer.from(PNG_1PX, 'base64'))
fs.writeFileSync(mediaB, Buffer.from(PNG_1PX, 'base64'))

function seedDraft() {
  const summary = store.save({ name: '缺口夹具', data: { aspect: '16:9', clips: [], assets: [] } })
  const record = store.load(summary.id)
  record.data.assets = [
    { id: 'a1', path: mediaA, name: 'a.png', displayName: 'a', kind: 'image', duration: 3 },
    { id: 'a2', path: mediaB, name: 'b.png', displayName: 'b', kind: 'image', duration: 3 }
  ]
  record.data.clips = [
    { id: 'c1', assetId: 'a1', track: 'video', start: 0, duration: 3 },
    { id: 'c2', assetId: 'a1', track: 'video', start: 3, duration: 3 },
    { id: 'c3', assetId: 'a2', track: 'video', start: 6, duration: 3 }
  ]
  store.save({ id: summary.id, name: record.name, data: record.data })
  return summary.id
}

/* ------------------------- 1. 删除素材 ------------------------- */

const draftId = seedDraft()

await check('删除素材会连带删掉引用它的片段（2 条），且不动别的素材', () => {
  const result = ops.removeMedia({ draftId, assetId: 'a1' })
  assert(result.removedAssets === 1, `素材只该少 1 条，实际 ${result.removedAssets}`)
  assert(result.removedClips === 2, `片段该少 2 条，实际 ${result.removedClips}`)
  const after = store.load(draftId).data
  assert(after.assets.length === 1 && after.assets[0].id === 'a2', '剩下的素材不对')
  assert(after.clips.length === 1 && after.clips[0].id === 'c3', '剩下的片段不对')
  return `素材 2→${after.assets.length} · 片段 3→${after.clips.length}`
})

await check('素材 id 不存在时报错，不静默成功', () => {
  const message = expectThrow(() => ops.removeMedia({ draftId, assetId: 'nope' }), '没有这些素材')
  return message.slice(0, 30)
})

await check('不清楚要删哪个（一个 id 都没给）时报错', () => {
  expectThrow(() => ops.removeMedia({ draftId, assetIds: [] }), '要删哪个素材')
  return '空参数被拒'
})

await check('批量删（assetIds）删得掉最后一条，草稿变空但结构完整', () => {
  const result = ops.removeMedia({ draftId, assetIds: ['a2'] })
  const after = store.load(draftId).data
  assert(result.removedAssets === 1, '素材没删掉')
  assert(after.assets.length === 0 && after.clips.length === 0, '应该都空')
  assert(Array.isArray(after.clips), 'clips 必须还是数组，不能变 undefined')
  return '素材 0 · 片段 0'
})

/* ------------------------- 2. 导入字体 ------------------------- */

const FONT_SRC = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((item) => {
  try {
    return fs.statSync(item).isFile()
  } catch {
    return false
  }
})

if (!FONT_SRC) {
  skip('字体三条', '本机没有可用于测试的 ttf/otf/ttc')
} else {
  const settingsFile = path.join(root, 'settings.json')
  const readFontsSetting = () => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).fonts || []
    } catch {
      return []
    }
  }

  await check('导入字体：复制进 fonts/ 且字节数与源文件一致', () => {
    const result = ops.importFont({ paths: [FONT_SRC] })
    assert(result.imported.length === 1, '没导进来')
    const font = result.imported[0]
    assert(font.path.startsWith(path.join(root, 'fonts')), `落点不在 fonts 目录：${font.path}`)
    const src = fs.statSync(FONT_SRC).size
    const dst = fs.statSync(font.path).size
    assert(src === dst, `字节数不一致：${src} vs ${dst}`)
    return `${dst} 字节 · ${path.basename(font.path)}`
  })

  await check('导入字体同时写进 settings.json 的 fonts（否则界面永远看不见）', () => {
    const fonts = readFontsSetting()
    assert(fonts.length === 1, `settings.fonts 应该有 1 条，实际 ${fonts.length}`)
    assert(fonts[0].id && fonts[0].path && fonts[0].name, '条目缺字段')
    return `fonts=${fonts.length}`
  })

  await check('重复导入同一个文件不会产生第二条', () => {
    const before = fs.readdirSync(path.join(root, 'fonts')).length
    const again = ops.importFont({ paths: [FONT_SRC] })
    const after = fs.readdirSync(path.join(root, 'fonts')).length
    assert(again.total === 1, `settings 里变成 ${again.total} 条`)
    assert(after === before, `磁盘上多出文件：${before} → ${after}`)
    return `磁盘 ${after} 个 · 设置 ${again.total} 条`
  })

  await check('非字体文件被拒（且设置没被写坏）', () => {
    expectThrow(() => ops.importFont({ paths: [mediaA] }), '一个都没导进来')
    assert(readFontsSetting().length === 1, 'settings.fonts 被这次失败的导入弄乱了')
    return '.png 被拒'
  })

  await check('listFonts 读的是磁盘（删掉文件后列表立刻变短）', () => {
    const before = ops.listFonts().total
    const file = fs.readdirSync(path.join(root, 'fonts'))[0]
    fs.unlinkSync(path.join(root, 'fonts', file))
    const after = ops.listFonts().total
    assert(before === 1 && after === 0, `删除前后应为 1/0，实际 ${before}/${after}`)
    return `1 → 0（设置里那条还在，说明确实没读设置）`
  })
}

/* ------------------------- 3. 素材包导入 ------------------------- */

const packDraftId = seedDraft()
const packPath = path.join(root, 'roundtrip.yjpack')

await check('打包 → 导入得到**新草稿**，不覆盖原稿', () => {
  ops.packDraft({ draftId: packDraftId, outPath: packPath })
  assert(fs.existsSync(packPath), '包没生成')
  const result = ops.unpackDraft({ packPath })
  assert(result.draftId && result.draftId !== packDraftId, '新草稿 id 与原稿相同，说明覆盖了')
  assert(store.load(packDraftId), '原草稿不见了')
  return `新草稿 ${result.draftId}`
})

await check('解出来的片段（数量/轨道/起点）与包里一致，素材 url 非空', () => {
  const result = ops.unpackDraft({ packPath })
  const data = store.load(result.draftId).data
  assert(result.mediaCount === 2, `媒体数应为 2，实际 ${result.mediaCount}（missing=${result.missing.length}）`)
  assert(data.clips.length === 3, `片段数应为 3，实际 ${data.clips.length}`)
  const tracks = data.clips.map((clip) => `${clip.track}@${clip.start}`).join(',')
  assert(tracks === 'video@0,video@3,video@6', `片段几何不对：${tracks}`)
  const emptyUrl = (data.assets || []).filter((asset) => !asset.url)
  assert(emptyUrl.length === 0, `${emptyUrl.length} 条素材的 url 是空的（画面会全黑）`)
  return `3 段 · ${data.assets.length} 素材都有 url`
})

await check('不是素材包的文件报错，而不是解出一份空草稿', () => {
  const bogus = path.join(root, 'bogus.yjpack')
  fs.writeFileSync(bogus, 'not a zip at all')
  expectThrow(() => ops.unpackDraft({ packPath: bogus }), '包')
  return '假包被拒'
})

/* ------------------------- 4. 节拍检测 ------------------------- */

function findFfmpeg() {
  const fromEnv = String(process.env.FFMPEG_PATH || '')
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return 'ffmpeg'
  } catch {
    return ''
  }
}

const ffmpeg = findFfmpeg()
const BEAT_TOTAL = 3
if (!ffmpeg) {
  for (const name of ['节拍位置', 'apply 写曲线', '无音轨片段报错']) {
    skip(`节拍 · ${name}`, '本机没有 ffmpeg，抽不出振幅包络（这是环境不足，不是功能坏了）')
  }
} else {
  const wav = path.join(root, 'clicks.wav')
  /* 每 0.5 秒一个 30ms 的 1kHz 短音：节拍位置是**已知**的，判据才有意义 */
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'aevalsrc=if(lt(mod(t\\,0.5)\\,0.03)\\,sin(2*PI*1000*t)*0.9\\,0):s=44100:d=4',
    wav
  ])

  const beatDraft = store.save({ name: '节拍夹具', data: { aspect: '16:9', clips: [], assets: [] } })
  const beatRecord = store.load(beatDraft.id)
  beatRecord.data.assets = [
    { id: 'a1', path: wav, name: 'clicks.wav', displayName: 'clicks', kind: 'audio', duration: 4 }
  ]
  beatRecord.data.clips = [
    { id: 'c1', assetId: 'a1', track: 'audio', kind: 'audio', start: 0, duration: 4, offset: 0 },
    /* 文字片段没有素材文件：这条用来证明"没音频时给的是清楚的报错" */
    { id: 'c2', kind: 'text', track: 'text', text: '字幕', start: 0, duration: 2 }
  ]
  store.save({ id: beatDraft.id, name: beatRecord.name, data: beatRecord.data })

  await check('节拍位置：已知每 0.5s 一下的点击声，找到的点都落在 ±0.05s 内', async () => {
    const result = await ops.detectBeats({ draftId: beatDraft.id, clipId: 'c1', sensitivity: undefined })
    assert(result.count === 7, `该找到 7 个，实际 ${result.count}（${result.beats.map((v) => v.toFixed(2))}）`)
    const want = [0.5, 1, 1.5, 2, 2.5, 3, 3.5]
    const worst = Math.max(...want.map((t, i) => Math.abs(result.beats[i] - t)))
    assert(worst <= 0.05, `最差偏差 ${worst.toFixed(3)}s > 0.05s`)
    return `7 个 · 步长 ${result.step.toFixed(4)}s · 最差偏差 ${worst.toFixed(3)}s`
  })

  await check('apply=true 时把曲线写进片段（speed 变了，控制点不为空）', async () => {
    const result = await ops.detectBeats({ draftId: beatDraft.id, clipId: 'c1', apply: true })
    const clip = store.load(beatDraft.id).data.clips.find((item) => item.id === 'c1')
    assert(result.applied && result.applied.hits > 0, '没生成曲线')
    assert(clip.speedCurve && clip.speedCurve.points.length > 0, '片段上没有 speedCurve')
    assert(Number(clip.speed) !== 1, 'speed 没被改（曲线等于没生效）')
    return `${clip.speedCurve.points.length} 个点 · speed=${clip.speed}`
  })

  await check('没有音轨的片段给的是清楚的报错，不是空数组', async () => {
    const message = await expectReject(() => ops.detectBeats({ draftId: beatDraft.id, clipId: 'c2' }), '可分析的音频')
    return message.slice(0, 34)
  })
}

/* ------------------------------ 汇总 ------------------------------ */

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉不影响结论 */
}

const total = pass + fails.length + skipped
console.log(`MCP_GAP_OPS_STATS total=${total} pass=${pass} fail=${fails.length} skip=${skipped}`)
if (!fails.length) console.log('MCP_GAP_OPS_OK')
else {
  console.log('MCP_GAP_OPS_FAILED')
  for (const line of fails) console.log(`  · ${line}`)
}
process.exit(fails.length ? 1 : 0)
