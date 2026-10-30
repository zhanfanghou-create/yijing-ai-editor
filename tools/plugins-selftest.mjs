#!/usr/bin/env node
/**
 * 本地插件包的纯逻辑自检。
 *
 * 这一层管的是「清单校验得对不对、key 会不会漂、PNG 头读得准不准」。
 * 装上之后边框面板有没有多出格子、套到片段上画面变不变，由
 * `tools/check-plugins.mjs` 管 —— 两层都要，缺一层就是相信"接线不会错"。
 *
 *   node tools/plugins-selftest.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const P = require('../packages/desktop/src/shared/pluginPack.js')
const INSTALL = require('../packages/desktop/src/main/plugins.js')

let total = 0
let pass = 0
const failures = []

function ok(name, cond, detail = '') {
  total += 1
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`)
  }
}

/** 造一个最小合法 PNG（只有签名 + IHDR，够 pngInfo 读尺寸） */
function fakePng(w, h) {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

console.log('\n[清单校验]')
{
  const r = P.normalizeManifest({ id: 'my-frames', name: '我的边框', kind: 'border', version: '2.1' }, '随便')
  ok('合法清单能过', r.ok === true)
  ok('id 原样保留（不二次改写）', r.manifest.id === 'my-frames')
  ok('name 保留中文', r.manifest.name === '我的边框')
  ok('kind 带出中文名', r.manifest.kindLabel === '边框')
  ok('schema 被写成当前版本', r.manifest.schema === P.SCHEMA)

  const r2 = P.normalizeManifest({ kind: 'sticker' }, '我的贴纸夹')
  ok('缺 id 时从目录名派生', r2.ok && r2.manifest.id === 'p-' + P.hashOf('我的贴纸夹'))
  ok('缺 name 时用目录名兜底', r2.manifest.name === '我的贴纸夹')
  ok('缺 version 时给 1.0.0', r2.manifest.version === '1.0.0')

  /* 硬错误只有一种：类型不认识。装进去也是"导入成功但哪都找不到" */
  ok('kind 缺失 = 硬错误', P.normalizeManifest({ name: 'x' }, 'x').ok === false)
  ok('kind 乱写 = 硬错误', P.normalizeManifest({ kind: 'effect' }, 'x').ok === false)
  ok('错误文案点了允许的类型', /border/.test(P.normalizeManifest({ kind: 'nope' }, 'x').error))

  /* 清单里写了非法 id：忽略它、改从 name 派生。直接把 '我的 边框!' 当目录名会造出怪路径 */
  const badId = P.normalizeManifest({ id: '我的 边框!', name: 'Frames', kind: 'border' }, 'x')
  ok('非法 id 被忽略、改由 name 派生', badId.ok && badId.manifest.id === 'frames', badId.manifest.id)

  const longName = P.normalizeManifest({ kind: 'border', name: 'x'.repeat(120) }, 'x')
  ok('超长 name 被截到 40 字', longName.manifest.name.length === 40)
}

console.log('\n[类型表]')
{
  ok('只支持两种类型', P.KINDS.map((k) => k.key).join(',') === 'border,sticker')
  ok('两种类型都有中文名', P.KINDS.every((k) => k.label))
  ok('kindLabel 对未知类型返回空串', P.kindLabel('zzz') === '' && P.kindLabel('sticker') === '贴纸')
}

console.log('\n[id 与 hash 的稳定性]')
{
  ok('纯中文名 → p- 前缀哈希', P.slugOf('我的插件') === 'p-' + P.hashOf('我的插件'))
  ok('纯英文名 → 直接用', P.slugOf('My Frames') === 'my-frames')
  ok('首尾连字符被剪掉', P.slugOf('--abc--') === 'abc' && P.slugOf('  a b  ') === 'a-b')
  ok('同一个名字两次结果一致', P.slugOf('我的插件') === P.slugOf('我的插件'))
  ok('不同名字不同 id', P.slugOf('甲') !== P.slugOf('乙'))
  ok('单字符名退回哈希（太短当不了 id）', P.slugOf('a').startsWith('p-'))
  ok('空名不炸', typeof P.slugOf('') === 'string' && P.slugOf('').length > 0)
}

console.log('\n[分组与条目 key]')
{
  ok('分组 key 带 pv- 前缀', P.groupKeyOf('my-frames') === 'pv-my-frames')
  ok('空 id 不给分组 key', P.groupKeyOf('') === '')
  ok('条目 key 稳定且序号化', P.itemKeyOf('my-frames', 3) === 'pv-my-frames-3')
  ok('同一个 (id,序号) 两次一致', P.itemKeyOf('a-b', 0) === P.itemKeyOf('a-b', 0))
  ok('不同插件不会撞 key', P.itemKeyOf('ab', 1) !== P.itemKeyOf('a', 1))
  /* 这一条是防"卸载重装后草稿里的边框全丢"的根 —— 见 pluginPack.js 顶部说明 */
  const key = P.itemKeyOf(P.slugOf('我的边框'), 0)
  ok('重装后 key 一致（草稿里的 clip.border 不失效）', key === P.itemKeyOf(P.slugOf('我的边框'), 0), key)
  ok('用户分组不会跟内置分组撞', !P.groupKeyOf('x').startsWith('ef-') && !P.groupKeyOf('x').startsWith('stk-'))
}

console.log('\n[排序与汇总]')
{
  const list = [
    { id: 'b', name: '乙', enabled: true, imageCount: 3 },
    { id: 'a', name: '甲', enabled: true, imageCount: 2 },
    { id: 'c', name: '丙', enabled: false, imageCount: 5 }
  ]
  const sorted = P.sortPlugins(list)
  ok('排序不改原数组', list[0].id === 'b')
  /* 拼音序：丙(bing) < 甲(jia) < 乙(yi)。**不是**按笔画也不是按 Unicode 码位 ——
     码位序会排成 丙>乙>甲，面板看起来像"乱序"。这里故意用这三个字当锚点。 */
  ok('中文按拼音排（丙 → 甲 → 乙）', sorted.map((p) => p.id).join(',') === 'c,a,b', sorted.map((p) => p.name).join('>'))
  const same = P.sortPlugins([{ id: 'z', name: '同名' }, { id: 'a', name: '同名' }])
  ok('同名按 id 兜底（顺序不会抖）', same.map((p) => p.id).join(',') === 'a,z')
  const s = P.summaryOf(list)
  ok('汇总只数已启用的图片', s.total === 3 && s.enabled === 2 && s.images === 5, JSON.stringify(s))
  ok('空列表汇总不炸', JSON.stringify(P.summaryOf([])) === '{"total":0,"enabled":0,"images":0}')
  ok('传 null 也不炸', P.summaryOf(null).total === 0)
}

console.log('\n[PNG 头]')
{
  const good = P.pngInfo(fakePng(1080, 1080))
  ok('读得出宽高', good.ok && good.w === 1080 && good.h === 1080)
  ok('非 PNG 被拒', P.pngInfo(Buffer.from('not a png at all, really')).ok === false)
  ok('太短的被拒', P.pngInfo(Buffer.alloc(4)).ok === false)
  ok('null 不炸', P.pngInfo(null).ok === false)
  /* 超大图挡在最前面：8K 往上的 PNG 进画布只剩噪点，而且解码能吃满内存 */
  const huge = P.pngInfo(fakePng(9000, 120))
  ok('超 8192 被拒且报出尺寸', huge.ok === false && /9000/.test(huge.error))
  ok('正好 8192 能过', P.pngInfo(fakePng(8192, 8192)).ok === true)
  const notHdr = fakePng(10, 10)
  notHdr.write('IHDX', 12, 'ascii')
  ok('IHDR 标记不对被拒', P.pngInfo(notHdr).ok === false)
}

console.log('\n[上限常量]')
{
  ok('单张 20MB', P.MAX_BYTES === 20 * 1024 * 1024)
  ok('单个插件 200 张', P.MAX_IMAGES === 200)
  ok('id 正则不接受大写/下划线/中文', !P.ID_RE.test('Abc') && !P.ID_RE.test('a_b') && !P.ID_RE.test('边框') && P.ID_RE.test('a-1'))
}

/*
 * 安装/列表/启停/卸载 —— 真写盘，但只在 os.tmpdir() 下的临时目录里。
 * 这一层必须真跑：路径校验、改名、原子替换这些**只有真落盘才会露**，
 * 纯函数测不到。
 */
console.log('\n[安装 / 列表 / 启停 / 卸载（真落盘）]')
{
  const sandbox = path.join(os.tmpdir(), 'yjai-plugin-selftest')
  const userData = path.join(sandbox, 'userData')
  const srcDir = path.join(sandbox, '我的边框')
  const cleanup = () => {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true })
    } catch {
      /* 删不掉留着，不影响结论 */
    }
  }
  cleanup()
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'manifest.json'), JSON.stringify({ name: '我的边框', kind: 'border' }), 'utf8')
  fs.writeFileSync(path.join(srcDir, '金色 边框(1).png'), fakePng(1080, 1080))
  fs.writeFileSync(path.join(srcDir, 'second.png'), fakePng(720, 720))
  fs.writeFileSync(path.join(srcDir, '不是图.png'), Buffer.from('NOPE'))
  fs.writeFileSync(path.join(srcDir, '说明.txt'), 'hello')

  const deps = { userData }
  const inst = INSTALL.install(srcDir, deps)
  ok('安装成功', inst.ok === true, inst.ok ? '' : inst.error)
  ok('id 由中文名哈希派生', inst.ok && /^p-[a-z0-9]+$/.test(inst.plugin.id), inst.ok ? inst.plugin.id : '')
  ok('只收 PNG（txt 不进）', inst.ok && inst.plugin.imageCount === 2, String(inst.ok && inst.plugin.imageCount))
  ok('非 PNG 被跳过并给出原因', inst.ok && inst.skipped.some((s) => /不是图/.test(s)), (inst.skipped || []).join(' / '))
  ok('图片被改名成序号（原名只留在清单里）', inst.ok && inst.plugin.images.map((i) => i.file).join(',') === '001.png,002.png')
  ok('原文件名仍可读', inst.ok && inst.plugin.images.some((i) => /金色 边框/.test(i.name)))

  const list = INSTALL.listPlugins(deps)
  ok('列表读得回来', list.length === 1 && list[0].id === inst.plugin.id)
  ok('默认是启用状态', list[0].enabled === true)
  ok('宽高从 PNG 头读出来写进清单', list[0].images[0].w === 1080 && list[0].images[0].h === 1080)

  const groups = INSTALL.groupsOf('border', deps)
  ok('边框库拿得到这一组', groups.length === 1 && groups[0].key === P.groupKeyOf(inst.plugin.id))
  ok('条目 key 与纯逻辑一致', groups[0].items[0].key === P.itemKeyOf(inst.plugin.id, 0))
  ok('贴纸库不会混进边框插件', INSTALL.groupsOf('sticker', deps).length === 0)

  INSTALL.setEnabled(inst.plugin.id, false, deps)
  ok('停用后从素材库消失', INSTALL.groupsOf('border', deps).length === 0)
  ok('停用后列表里还在（只是关着）', INSTALL.listPlugins(deps)[0].enabled === false)
  INSTALL.setEnabled(inst.plugin.id, true, deps)
  ok('再启用回来', INSTALL.groupsOf('border', deps).length === 1)

  /* 重装同一个：目录被整体替换，不能出现"001.png 在原地被追加了一份" */
  const again = INSTALL.install(srcDir, deps)
  ok('重装成功且不叠加', again.ok && INSTALL.listPlugins(deps).length === 1 && INSTALL.listPlugins(deps)[0].imageCount === 2)

  /* 硬错误路径 */
  const emptyDir = path.join(sandbox, 'empty')
  fs.mkdirSync(emptyDir, { recursive: true })
  ok('没有 manifest.json 被拒', INSTALL.install(emptyDir, deps).ok === false)
  const noPng = path.join(sandbox, 'noPng')
  fs.mkdirSync(noPng, { recursive: true })
  fs.writeFileSync(path.join(noPng, 'manifest.json'), JSON.stringify({ kind: 'sticker' }), 'utf8')
  ok('一张 PNG 都没有被拒', INSTALL.install(noPng, deps).ok === false)
  ok('不存在的目录被拒', INSTALL.install(path.join(sandbox, 'nope'), deps).ok === false)
  ok('什么都不传也不炸', INSTALL.install('', deps).ok === false)

  /* 清单里写 `../` 想读盘上任意 PNG ⇒ readOne 必须把它丢掉 */
  const evilId = INSTALL.listPlugins(deps)[0].id
  const evilFile = path.join(userData, 'plugins', evilId, 'manifest.json')
  const evil = JSON.parse(fs.readFileSync(evilFile, 'utf8'))
  evil.images.push({ file: '../../evil.png', name: '越界', w: 10, h: 10 })
  fs.writeFileSync(evilFile, JSON.stringify(evil), 'utf8')
  const afterEvil = INSTALL.listPlugins(deps)[0]
  ok('清单里的路径穿越被丢弃', afterEvil.imageCount === 2, String(afterEvil.imageCount))
  ok('列表里没有越界那条', !afterEvil.images.some((i) => i.name === '越界'))

  /* 卸载必须有回收站，没有就拒绝（不能退化成直接删） */
  const noTrash = await INSTALL.remove(evilId, deps)
  ok('没有回收站时拒绝删除', noTrash.ok === false && /回收站/.test(noTrash.error))
  ok('拒绝之后插件还在', INSTALL.listPlugins(deps).length === 1)
  let trashed = ''
  /* 桩要**真删**：只记路径的话，"卸载后列表空了"永远绿，
     而真实环境里 shell.trashItem 是会把目录搬走的 */
  const removed = await INSTALL.remove(evilId, {
    ...deps,
    trash: async (t) => {
      trashed = t
      fs.rmSync(t, { recursive: true, force: true })
    }
  })
  ok('注入回收站后能卸载', removed.ok === true && trashed.endsWith(evilId))
  ok('卸载后列表空了', INSTALL.listPlugins(deps).length === 0)
  ok('id 不合法时拒绝', (await INSTALL.remove('../x', { ...deps, trash: async () => {} })).ok === false)

  cleanup()
}

console.log(`\nPLUGINS_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
if (failures.length) {
  console.log('失败项：\n  ' + failures.join('\n  '))
  process.exit(1)
}
console.log('PLUGINS_SELFTEST_PASSED')
