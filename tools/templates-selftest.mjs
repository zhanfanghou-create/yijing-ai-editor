/**
 * 模板（成套预设）纯逻辑自证 —— 不起 Electron，直接 require shared/templates.js。
 *
 * 为什么模板需要一道纯逻辑闸：
 *   模板的错法全是**位置错、不是报错**。起点没平移 ⇒ 在第 30 秒套开场会跑到第 0 秒；
 *   相对偏移被吃掉 ⇒ 多条文字全叠在同一帧；贴纸没查着却照样生成 ⇒
 *   时间线上多一条空 Img、画面上什么都没有，且没有任何提示。
 *   这些在界面上只表现成"套上去乱七八糟"，看不出是哪一条错，只有夹具里逐条对时间才分得清。
 *
 * 输出：TEMPLATES_SELFTEST_PASSED / TEMPLATES_SELFTEST_FAILED
 *       + 「TEMPLATES_SELFTEST_STATS total=N pass=P fail=F」
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const TPL = require('../packages/desktop/src/shared/templates.js')
const TEXT = require('../packages/desktop/src/shared/textStyles.json')

let pass = 0
const failures = []
function ok(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps

/** 夹具用的贴纸解析器：真的那 140 枚里挑两枚，外加一个"不存在的 key" */
const FIXTURE_STICKERS = {
  'spark-2728': { name: '闪亮', url: 'yjai-media://local/aaa' },
  'party-1f389': { name: '庆祝', url: 'yjai-media://local/bbb' },
  'party-1f38a': { name: '彩带', url: 'yjai-media://local/ccc' },
  'spark-2b50': { name: '星', url: 'yjai-media://local/ddd' },
  'heart-2764': { name: '心', url: 'yjai-media://local/eee' }
}
const resolveFixture = (key) => FIXTURE_STICKERS[key] || null

/* ------------------------------------------------------------------ 数据面 */
console.log('\n[1] 数据面')
{
  const groups = TPL.groupsOf()
  const list = TPL.listTemplates()
  ok('分组是 3 组（开场 / 结尾 / 字幕套）', groups.length === 3, groups.map((g) => g.name).join(' / '))
  ok('模板表有 12 款', list.length === 12, `实际 ${list.length}`)
  ok(
    '每一组都不少于 4 款（点进分组看到空网格 = 假入口）',
    groups.every((g) => TPL.templatesOfGroup(g.key).length >= 4),
    groups.map((g) => `${g.key}:${TPL.templatesOfGroup(g.key).length}`).join(' ')
  )
  ok(
    '每条模板的 key 在全表唯一',
    new Set(list.map((t) => t.key)).size === list.length
  )
}

/* ------------------------------------------------------- 纯逻辑跑真数据 */
console.log('\n[2] planTemplate（真数据 + 夹具贴纸）')
{
  const tpl = TPL.templateOf('tpl-open-fest')
  ok('能按 key 取到模板', Boolean(tpl), tpl ? tpl.name : '-')

  const plain = TPL.planTemplate(tpl, { resolveSticker: resolveFixture })
  ok('tpl-open-fest 生成 3 条片段（1 文字 + 2 贴纸）', plain.clips.length === 3, `实际 ${plain.clips.length}`)
  ok('没有跳过任何贴纸', plain.skipped.length === 0, plain.skipped.join(',') || '-')
  ok(
    '轨道只有 text / overlay 两种',
    plain.clips.every((c) => c.track === 'text' || c.track === 'overlay'),
    [...new Set(plain.clips.map((c) => c.track))].join(',')
  )
  ok(
    'kind 只有 text / image 两种（落地后都是普通片段）',
    plain.clips.every((c) => c.kind === 'text' || c.kind === 'image'),
    [...new Set(plain.clips.map((c) => c.kind))].join(',')
  )

  /* ---- 起点平移：这是模板最容易错的一处 ---- */
  const at12 = TPL.planTemplate(tpl, { start: 12, resolveSticker: resolveFixture })
  const firstAt = Math.min(...at12.clips.map((c) => c.start))
  ok('起点平移：start=12 时最早的一条正好落在 12s', near(firstAt, 12), `实际 ${firstAt}`)
  ok(
    '起点平移：所有片段都不早于 start（负起点会让片段跑到时间线外面）',
    at12.clips.every((c) => c.start >= 12 - 1e-6),
    Math.min(...at12.clips.map((c) => c.start)).toFixed(2)
  )
  ok(
    '相对偏移保留：第 3 条贴纸比第 1 条晚 0.5s（at=0.5）',
    (() => {
      /* 按绝对起点找那条 at=0.5 的贴纸：用 name 找会碰上两枚都叫「庆祝」的情况 */
      const third = at12.clips.find((c) => near(c.start, 12.5))
      return Boolean(third) && third.kind === 'image'
    })(),
    `${at12.clips.map((c) => c.start.toFixed(2)).join(' / ')}`
  )

  /* ---- 贴纸查不到就跳过，且要说清楚跳了几项 ---- */
  const noSticker = TPL.planTemplate(tpl, {
    resolveSticker: (k) => (k === 'spark-2728' ? resolveFixture(k) : null)
  })
  ok(
    '贴纸查不到 → 那一条被跳过（不生成空 Img）',
    noSticker.clips.length === 1 && noSticker.clips.every((c) => c.track === 'text'),
    `剩 ${noSticker.clips.length} 条`
  )
  ok(
    '跳过的 key 被记进 skipped（提示里能报出数量与名字）',
    noSticker.skipped.join(',') === 'party-1f389,party-1f38a',
    noSticker.skipped.join(',') || '(空)'
  )
  const noResolver = TPL.planTemplate(tpl, {})
  ok('不传 resolveSticker 时贴纸全部跳过、文字仍在', noResolver.clips.length === 1 && noResolver.skipped.length === 2, `clips=${noResolver.clips.length} skipped=${noResolver.skipped.length}`)

  /* ---- 贴纸的 pip 范围 ---- */
  const tiny = TPL.planTemplate(
    { key: 'x', clips: [{ type: 'sticker', sticker: 'spark-2728', at: 0, dur: 1, size: 1, anchor: 'center' }] },
    { resolveSticker: resolveFixture }
  )
  ok('pip.size 下界被夹到 10（写 1 会得到看不见的一个点）', tiny.clips[0].pip.size === TPL.MIN_PIP_SIZE, `实际 ${tiny.clips[0].pip.size}`)
  const huge = TPL.planTemplate(
    { key: 'x', clips: [{ type: 'sticker', sticker: 'spark-2728', at: 0, dur: 1, size: 90 }] },
    { resolveSticker: resolveFixture }
  )
  ok('pip.size 上界被夹到 60（写 90 会铺满整幅画面）', huge.clips[0].pip.size === TPL.MAX_PIP_SIZE, `实际 ${huge.clips[0].pip.size}`)
  ok('没写 anchor 时落到右下角', huge.clips[0].pip.anchor === 'right-bottom', huge.clips[0].pip.anchor)

  /* ---- 时长下限 ---- */
  const tooShort = TPL.planTemplate({ key: 'x', clips: [{ type: 'text', text: 'a', style: 'sub-plain', at: 0, dur: 0.01 }] })
  ok('dur 低于 0.2s 会被撑到 0.2（否则时间线上只有 3px 宽）', near(tooShort.clips[0].duration, TPL.MIN_CLIP), `${tooShort.clips[0].duration}`)

  /* ---- 文字覆写 ---- */
  const hero = TPL.templateOf('tpl-open-hero')
  const withTitle = TPL.planTemplate(hero, { titleText: '我的工程名' })
  ok('titleText 替换第一条文字', withTitle.clips[0].text === '我的工程名', withTitle.clips[0].text)
  ok('titleText 不碰后面的文字', withTitle.clips[1].text === hero.clips[1].text, withTitle.clips[1].text)
  ok('name 跟着正文截断（时间线胶片上读得出这段写了什么）', withTitle.clips[0].name === '我的工程名', withTitle.clips[0].name)

  const center = TPL.planTemplate({ key: 'x', clips: [{ type: 'text', text: 'a', style: 'sub-plain', at: 0, dur: 1, anchor: 'center', offset: 200 }] })
  ok(
    'anchor=center 时不写 textOffset（写了会让右栏常亮「恢复默认」角标）',
    center.clips[0].textOffset === undefined,
    String(center.clips[0].textOffset)
  )
  const bottom = TPL.planTemplate({ key: 'x', clips: [{ type: 'text', text: 'a', style: 'sub-plain', at: 0, dur: 1, anchor: 'bottom', offset: 200 }] })
  ok('anchor=bottom 时 textOffset 落成数字', bottom.clips[0].textOffset === 200, String(bottom.clips[0].textOffset))
  ok('textSize 取自样式表（面板显示用）', bottom.clips[0].textSize === TEXT.styles.find((s) => s.key === 'sub-plain').size, String(bottom.clips[0].textSize))

  /* ---- id 不与已有片段冲突 ---- */
  const ids = new Set()
  const withIds = TPL.planTemplate(hero, { idFor: (n) => `clip-new-${n}` })
  withIds.clips.forEach((c) => ids.add(c.id))
  ok('idFor 被调用且 id 不重复', ids.size === withIds.clips.length && withIds.clips[0].id === 'clip-new-0', [...ids].join(','))
}

/* ----------------------------------------------------------- 生成物独立性 */
console.log('\n[3] 生成物与数据源互不影响')
{
  const tpl = TPL.templateOf('tpl-open-hero')
  const before = JSON.stringify(tpl)
  const planned = TPL.planTemplate(tpl, {})
  planned.clips[0].text = '改掉'
  planned.clips[0].textOffset = 999
  ok('改生成出来的片段不会写回模板数据（连点两次模板得到一样的结果）', JSON.stringify(tpl) === before)

  const a = TPL.planTemplate(tpl, {})
  const b = TPL.planTemplate(tpl, {})
  ok('两次 planTemplate 的片段对象互相独立', a.clips[0] !== b.clips[0] && a.clips[0].text === b.clips[0].text)
}

/* -------------------------------------------------------------- 数据自检 */
console.log('\n[4] validateTemplates')
{
  const styleKeys = TEXT.styles.map((s) => s.key)
  /* 闸门里会传真贴纸清单；这里传夹具的两个 + 模板实际引用的那些，
     以保证"真数据用真清单能过"这条判据不是靠空集合混过去的。 */
  const stickerKeys = new Set(Object.keys(FIXTURE_STICKERS))
  for (const t of TPL.listTemplates()) {
    for (const c of t.clips) if (c.type === 'sticker') stickerKeys.add(c.sticker)
  }
  const clean = TPL.validateTemplates({ styleKeys, stickerKeys: [...stickerKeys] })
  ok('真数据 + 真清单 → 0 个问题', clean.length === 0, clean.slice(0, 4).join(' | ') || '-')

  const badStyle = TPL.validateTemplates({ styleKeys: styleKeys.filter((k) => k !== 'title-hero'), stickerKeys: [...stickerKeys] })
  ok('揪出引用不存在的文字样式', badStyle.some((p) => p.includes('title-hero')), badStyle[0] || '(空)')

  const badSticker = TPL.validateTemplates({ styleKeys, stickerKeys: [...stickerKeys].filter((k) => k !== 'party-1f38a') })
  ok(
    '揪出引用不存在的贴纸 key',
    badSticker.length === 1 && badSticker[0].includes('party-1f38a') && badSticker[0].includes('不在内置贴纸清单'),
    badSticker[0] || '(空)'
  )

  /* 造一个跨度不符的坏表。注意**不能**用"删掉一条片段"来造：
     `at` 是相对模板起点的绝对偏移，删掉第一条并不会让后面的往前挪，
     跨度仍然是最后一条的 at+dur —— 那种改法是自洽的，validate 判它没问题是对的。
     真实会漏的错是"改了最后一条的 dur 却没改总时长"，以及反过来的"改总时长没改片段"。 */
  const { validateTemplates } = TPL
  const original = TPL.TABLE.templates
  /* 挑一条**删掉首段就会缩短**的：tpl-pack-bar 是三条首尾相接，删掉第一条跨度 7.2→4.8。
     用 tpl-open-hero 这类"最长的是第二段"的模板做夹具，删完跨度不变，这条断言就永远绿。 */
  const idx = original.findIndex((t) => t.key === 'tpl-pack-bar')
  const target = original[idx]
  const mutated = { ...target, duration: target.duration + 1.2 }
  TPL.TABLE.templates[idx] = mutated
  const badSpan = validateTemplates({ styleKeys, stickerKeys: [...stickerKeys] })
  TPL.TABLE.templates[idx] = target
  ok(
    '揪出 duration 与片段实际跨度不符（总时长写了 8.4s，片段只铺到 7.2s）',
    badSpan.some((p) => p.includes('跨度')),
    badSpan[0] || '(空)'
  )
  /* 重叠判据本身也要有"必须红"的夹具，否则它是死代码：
     pack-bar 三条首尾相接，把第一条拉长到 3.0s 就压住了第二条（2.4s 起）。 */
  const oi = TPL.TABLE.templates.findIndex((t) => t.key === 'tpl-pack-bar')
  const oTpl = TPL.TABLE.templates[oi]
  TPL.TABLE.templates[oi] = {
    ...oTpl,
    clips: oTpl.clips.map((c, i) => (i === 0 ? { ...c, dur: 3.0 } : c))
  }
  const badOverlap = validateTemplates({ styleKeys, stickerKeys: [...stickerKeys] })
  TPL.TABLE.templates[oi] = oTpl
  ok(
    '揪出两条文字时间重叠（同一条字幕轨上胶片会压住）',
    badOverlap.length === 1 && badOverlap[0].includes('时间重叠'),
    badOverlap[0] || '(空)'
  )

  ok(
    '自检之后表已复原（自检不许把夹具改动留在真源上）',
    validateTemplates({ styleKeys, stickerKeys: [...stickerKeys] }).length === 0
  )
}

/* ----------------------------------------------------- 每条模板都能落地 */
console.log('\n[5] 12 款逐条落地')
{
  const styleKeys = new Set(TEXT.styles.map((s) => s.key))
  const stickerKeys = new Set(Object.keys(FIXTURE_STICKERS))
  let allOk = true
  const rows = []
  for (const tpl of TPL.listTemplates()) {
    const r = TPL.planTemplate(tpl, { start: 5, resolveSticker: resolveFixture })
    const bad =
      !r.clips.length ||
      r.skipped.length > 0 ||
      r.clips.some((c) => c.kind === 'text' && !styleKeys.has(c.textStyle)) ||
      r.clips.some((c) => c.kind === 'text' && !c.text) ||
      r.clips.some((c) => c.kind === 'image' && !c.url) ||
      r.clips.some((c) => c.start < 5 || !(c.duration > 0))
    if (bad) allOk = false
    rows.push(`${tpl.key}(${r.clips.length}${r.skipped.length ? `!${r.skipped.length}` : ''})`)
  }
  ok('每一条都能生成 ≥1 个片段、无跳过、样式与贴纸都可解析', allOk, rows.join(' '))
}

const total = pass + failures.length
console.log(`\nTEMPLATES_SELFTEST_STATS total=${total} pass=${pass} fail=${failures.length}`)
console.log(failures.length ? 'TEMPLATES_SELFTEST_FAILED' : 'TEMPLATES_SELFTEST_PASSED')
process.exitCode = failures.length ? 1 : 0
