#!/usr/bin/env node
/* 集成卡片对账：镜枢侧 builtin/mcp/yijing-editor/integration.json 说的工具面，
   是否与我方真实工具表一致。

   为什么需要这道闸：卡片是给 agent 看的说明书，它不属于任何一侧的构建产物 ——
   我方加工具不会让对面重新生成它，对面也不会主动发现。于是"卡片写 28、实际 37"
   这种漂移可以存在几个月而两边套件全绿（2026-11-03 就是这样被发现的）。
   已经出过的两类事故：
     ① toolCount 落后 ⇒ agent 按旧数量规划步骤，会漏掉能做的事；
     ② 卡片点名了不存在的工具 ⇒ agent 照着调，每次都报"没有这个工具"，
        而报错长得像"环境没装好"，人和 agent 都会往错方向查。

   环境的两种"不在"，处理必须分开（这正是最容易写成假绿的两种坏法）：
     · 对面仓库根本没 clone（换机器 / CI）⇒ 三条记 SKIP，总数不变；
     · 仓库在、卡片文件却没了（被删或被改名）⇒ 必须红 —— 那是真的丢了说明书。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CARD = process.env.YJ_CARD_PATH || 'F:/yj-yegin/desktop-electron/builtin/mcp/yijing-editor/integration.json'
const MANIFEST = path.join(ROOT, 'packages', 'desktop', 'mcp-tools.json')
/* 卡片在 <repo>/desktop-electron/builtin/mcp/yijing-editor/integration.json，上溯四层是仓库根 */
const REPO_ROOT = path.resolve(path.dirname(CARD), '..', '..', '..', '..')

let total = 0
let pass = 0
let skip = 0
const fails = []
function check(name, ok, detail) {
  total += 1
  if (ok) pass += 1
  else fails.push(`${name} :: ${detail}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` :: ${detail}` : ''}`)
}
function skipped(name, detail) {
  total += 1
  skip += 1
  console.log(`  – ${name} ［跳过］${detail ? ` :: ${detail}` : ''}`)
}

const NAMES = [
  '卡片声明的 toolCount 与真实工具数一致',
  '卡片里点名的工具全部真实存在（没有指向已改名/不存在工具的说明）',
  'playbook 仍覆盖主线四步（查环境/取取值/上片段/导出）'
]

function summary(marker) {
  console.log('')
  console.log(`CARD_SYNC_STATS total=${total} pass=${pass} fail=${total - pass - skip} skip=${skip}`)
  if (fails.length) {
    console.log('未通过：')
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  if (marker) console.log('CARD_SYNC_OK 集成卡片与真实工具面一致')
  else console.log('CARD_SYNC_PARTIAL 对面仓库不在本机，本条只做了「卡片在不在」之外能做的部分')
}

/* ---------- 0. 对面仓库在不在：不在就三条全 SKIP ---------- */
if (!fs.existsSync(REPO_ROOT)) {
  for (const n of NAMES) skipped(n, `对面仓库不在本机（${REPO_ROOT}）`)
  summary(false)
  process.exit(0)
}

/* 仓库在、卡片没了 ⇒ 真丢东西，落到下面读文件时抛错之前先明确报出来 */
if (!fs.existsSync(CARD)) {
  check(NAMES[0], false, `对面仓库在，但卡片文件不见了：${CARD}`)
  skipped(NAMES[1], '卡片不存在')
  skipped(NAMES[2], '卡片不存在')
  summary(false)
  process.exit(1)
}

const card = JSON.parse(fs.readFileSync(CARD, 'utf8'))
const tools = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).tools
const mine = new Set(tools.map((t) => t.name))

/* ---------- 1. 数字：卡片声明的工具数 == 真实工具数 ---------- */
const diff = mine.size - Number(card.toolCount || 0)
check(
  NAMES[0],
  card.toolCount === mine.size,
  `卡片 ${card.toolCount} · 实际 ${mine.size}${diff === 0 ? '' : `（差 ${diff > 0 ? '+' : ''}${diff}）`}`
)

/* ---------- 2. 卡片点名的工具都真实存在（没有死名字） ---------- */
const named = [...new Set(String(JSON.stringify(card)).match(/\byijing_[a-z_]+\b/g) || [])].sort()
const missing = named.filter((n) => !mine.has(n))
check(
  NAMES[1],
  missing.length === 0,
  missing.length ? `${missing.length} 个查无此工具：${missing.join(', ')}` : `点名 ${named.length} 个，全部命中`
)

/* ---------- 3. 卡片必须真的在讲这批工具，不是个空壳 ---------- */
/* 防止"把 playbook 清空让前两条恒真"—— 那时 toolCount 仍可能是对的。 */
const playbook = Array.isArray(card.playbook) ? card.playbook : []
const coreLines = ['yijing_status', 'yijing_catalog', 'yijing_add_clips', 'yijing_export_video']
const covered = coreLines.filter((w) => playbook.some((line) => String(line).includes(w)))
check(
  NAMES[2],
  playbook.length >= 10 && covered.length === coreLines.length,
  `${playbook.length} 条 · 覆盖 ${covered.length}/${coreLines.length}`
)

summary(true)
