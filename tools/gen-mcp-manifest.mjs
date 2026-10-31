#!/usr/bin/env node
/**
 * 生成 / 校验 **MCP 工具清单（机器可读真源）**：`packages/desktop/mcp-tools.json`
 *
 * 为什么需要这个文件：
 *   镜枢（`F:\yj-yegin`）里有一张「艺镜AI剪辑」集成卡片，写着 `toolCount: 9`，
 *   还有一条闸门 `assert.equal(item.toolCount, 9)`。这边扩到 28 之后，
 *   对面**看不到** —— 数字对不上不是小事：用户会以为一半能力不存在，
 *   而对面的测试要么红、要么被人删掉（更坏）。
 *
 *   一份人能看、机器也能读的清单，是把"口头同步"换成"对得上的文件"。
 *
 * 用法：
 *   node tools/gen-mcp-manifest.mjs           # 重新生成
 *   node tools/gen-mcp-manifest.mjs --check   # 只校验（CI/闸门用，不写盘）
 *
 * ⚠️ 清单必须与 `mcp-server.js` 的 TOOLS **运行期**逐字一致。
 *    手改这份 JSON 一定会漂移，所以 --check 是闸门的一部分。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { EXPECTED_TOOLS } from './mcp-tools-list.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'packages', 'desktop', 'mcp-tools.json')
const SERVER = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'mcp-server.js')

export const TOTAL_ASSERTIONS = 5

const require = createRequire(import.meta.url)

/* 隔离 profile：require 服务端会读 userData（草稿目录），不能碰真实的 */
function loadServer() {
  const profile = path.join(os.tmpdir(), `yjai-manifest-${process.pid}`)
  fs.mkdirSync(path.join(profile, 'drafts'), { recursive: true })
  process.env.YIJAI_USER_DATA = profile
  try {
    return require(SERVER)
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      /* 临时目录，删不掉不影响结论 */
    }
  }
}

function build(serverMod) {
  const tools = Object.keys(serverMod.TOOLS).map((name) => {
    const t = serverMod.TOOLS[name]
    const schema = t.inputSchema || {}
    const props = schema.properties || {}
    return {
      name,
      description: String(t.description || '').trim(),
      required: Array.isArray(schema.required) ? schema.required.slice() : [],
      properties: Object.keys(props).map((k) => ({
        name: k,
        type: (props[k] && props[k].type) || 'object',
        description: String((props[k] && props[k].description) || '').trim()
      }))
    }
  })
  return {
    server: 'yijing-editor',
    /* 与 mcp-server.js 的 SERVER_VERSION 同源，别手填 */
    version: String(serverMod.SERVER_VERSION || '').trim(),
    toolCount: tools.length,
    tools
  }
}

const render = (obj) => JSON.stringify(obj, null, 2) + '\n'

function main() {
  const check = process.argv.includes('--check')
  const pass = []
  const failed = []
  const record = (name, ok, detail = '') => {
    ;(ok ? pass : failed).push(name)
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
  }

  let serverMod = null
  try {
    serverMod = loadServer()
  } catch (e) {
    record('1. mcp-server.js 可被 require（清单从运行期读，不读源码文本）', false, String((e && e.message) || e).slice(0, 160))
  }
  if (!serverMod || !serverMod.TOOLS) {
    console.log(`\nMCP_MANIFEST_STATS total=${pass.length + failed.length} pass=${pass.length} fail=${failed.length}`)
    console.log('MCP_MANIFEST_FAILED')
    process.exit(1)
  }
  record('1. mcp-server.js 可被 require（清单从运行期读，不读源码文本）', true, `${Object.keys(serverMod.TOOLS).length} 个工具`)

  const manifest = build(serverMod)
  const names = manifest.tools.map((t) => t.name)
  const sameList =
    names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n))
  record('2. 工具名与唯一清单 `tools/mcp-tools-list.mjs` 完全一致', sameList, sameList ? `${names.length} 个` : `清单 ${EXPECTED_TOOLS.length} vs 运行期 ${names.length}`)

  const noDesc = manifest.tools.filter((t) => t.description.length < 15).map((t) => t.name)
  record('3. 每个工具都有足够长的说明（agent 全靠它决定怎么调）', noDesc.length === 0, noDesc.join(', ') || '全部有说明')

  const hasVersion = /^\d+\.\d+\.\d+$/.test(manifest.version)
  record('4. 清单带协议版本号（对面据此判断能力代际）', hasVersion, manifest.version || '(空)')

  const text = render(manifest)
  const exists = fs.existsSync(OUT)
  const current = exists ? fs.readFileSync(OUT, 'utf8') : ''
  if (check) {
    const identical = exists && current === text
    record('5. 仓库里的 mcp-tools.json 与代码逐字一致（`--check` 模式，不写盘）', identical, identical ? `${manifest.toolCount} 个工具` : '已漂移：重跑 node tools/gen-mcp-manifest.mjs')
  } else {
    fs.writeFileSync(OUT, text, 'utf8')
    record('5. 已写盘 `packages/desktop/mcp-tools.json`', true, `${manifest.toolCount} 个工具 · ${(text.length / 1024).toFixed(1)} KB`)
  }

  console.log(`\nMCP_MANIFEST_STATS total=${pass.length + failed.length} pass=${pass.length} fail=${failed.length}`)
  console.log(failed.length || pass.length + failed.length !== TOTAL_ASSERTIONS ? 'MCP_MANIFEST_FAILED' : 'MCP_MANIFEST_OK')
  process.exit(failed.length || pass.length + failed.length !== TOTAL_ASSERTIONS ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
