#!/usr/bin/env node
/**
 * 版本号单一真源 —— 发布时该 bump 哪个数，由这里说了算。
 *
 * 为什么要有它（2026-10-02 PM 审查 P1-5）：此前仓库里有 4 个 package.json 各自写着
 * `1.0.0`，谁也不消费谁 —— 发布时根本不知道该改哪个数，改漏一个就出现
 * 「安装包叫 1.1.0，客户端关于页显示 1.0.0」这种自相矛盾的产物。
 *
 * **口径（写死在这里，别再靠记忆）**：
 *
 *   权威版本 = `packages/desktop/package.json` 的 `version`
 *
 *   它一路被消费到：
 *     · 客户端「设置 → 关于我们」的「版本」行 —— main/index.js 的 appVersion()
 *       打包后走 app.getVersion()（读打进包里的 package.json），未打包时回退读源文件；
 *     · 安装包文件名 `YiJingAIEditor-${version}-Windows-x64` —— desktop/electron-builder.yml；
 *     · git 发布标签 `v<version>-stable`。
 *
 *   必须同步（同号）：根 package.json（仓库版本 / 标签来源）、installer（安装器版本）。
 *   独立演进（不同号）：server / admin-panel —— 服务端按自己的部署节奏发版，
 *     与客户端版本没有绑定关系，强行同号只会制造假的一致性。
 *
 * 用法：
 *   node tools/version.mjs                 # 打印当前版本与对照
 *   node tools/version.mjs --bump patch    # patch | minor | major，三处一起 +1
 *   node tools/version.mjs --set 1.2.3
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 权威版本所在 */
const AUTHORITY = 'packages/desktop/package.json'
/** 必须与权威同号 */
const SYNCED = ['package.json', 'packages/installer/package.json']
/** 独立演进，只汇报不同号 */
const INDEPENDENT = ['packages/server/package.json']

export function readVersion(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')).version || ''
  } catch {
    return ''
  }
}

export function bump(version, part) {
  const [major, minor, patch] = String(version).split('.').map((n) => Number(n) || 0)
  if (part === 'major') return `${major + 1}.0.0`
  if (part === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function writeVersion(rel, version) {
  const full = path.join(ROOT, rel)
  const text = fs.readFileSync(full, 'utf8')
  // 只替换**第一个** "version": —— package.json 里依赖版本也会出现这个键名，
  // 但它们都在 dependencies 段，靠 `{…}` 缩进与顺序都不可靠；
  // 用「顶层」这个约束：正规格式的 package.json 顶层 version 一定在文件前几行。
  const idx = text.indexOf('"version"')
  if (idx === -1) throw new Error(`${rel} 里找不到 "version"`)
  const end = text.indexOf('\n', idx)
  const line = text.slice(idx, end)
  const next = line.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`)
  fs.writeFileSync(full, text.slice(0, idx) + next + text.slice(end))
}

function main() {
  const current = readVersion(AUTHORITY)
  const argv = process.argv.slice(2)
  const bumpIdx = argv.indexOf('--bump')
  const setIdx = argv.indexOf('--set')

  let next = null
  if (bumpIdx !== -1 && argv[bumpIdx + 1]) next = bump(current, argv[bumpIdx + 1])
  else if (setIdx !== -1 && argv[setIdx + 1]) next = argv[setIdx + 1]

  if (next) {
    if (!/^\d+\.\d+\.\d+$/.test(next)) {
      console.error(`版本号必须是 x.y.z：${next}`)
      process.exit(1)
    }
    for (const rel of [AUTHORITY, ...SYNCED]) writeVersion(rel, next)
    console.log(`版本 ${current} → ${next}（同步写 ${[AUTHORITY, ...SYNCED].join(' / ')}）`)
    return
  }

  console.log(`权威版本（${AUTHORITY}）：${current}`)
  for (const rel of SYNCED) {
    const value = readVersion(rel)
    console.log(`  ${value === current ? '同号' : '不同号'}  ${rel} = ${value}`)
  }
  for (const rel of INDEPENDENT) {
    console.log(`  独立演进  ${rel} = ${readVersion(rel)}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('version.mjs')) main()
