#!/usr/bin/env node
/**
 * 闸门：MCP 桥（镜枢 ↔ 剪辑软件）的接线与**打包覆盖**。
 *
 * 背景（2026-10-10）：剪辑软件内置了一个 MCP stdio server（`src/main/mcp-server.js`），
 * 让镜枢的 agent 能直接建草稿 / 加片段 / 加字幕 / 加特效 / 导出成片。首次运行由主进程把
 * 自己写进 `%APPDATA%\yegin\mcp.json`，镜枢下次启动即自动发现 —— 用户不用装任何别的东西。
 *
 * 这些东西的共同点是：**坏掉都不报错**。所以逐条钉死：
 *
 *   1. 文件在不在（mcp-server / drafts / media / mcp-register 四个）。
 *   2. 工具表是不是**恰好那 9 个** —— 少一个 agent 就少一项能力，而它不会说
 *      "我少了"，只会默默做不出来。多一个半成品更糟（agent 会去调）。
 *   3. stdout 纯洁性 —— MCP 用 stdout 跑 JSON-RPC，往 stdout 写一行日志就会让对面
 *      解析失败、整条链路静默断掉；这条只能靠"源码里不许有 console.log"来钉。
 *   4. 自动注册真的能跑（**真调一次 `registerMcpServer` 写临时目录**，而不是 grep）：
 *      没镜枢时不写、有镜枢时写对形状、且**合并不覆盖别人的条目**。
 *   5. **打包覆盖**（最要命的一条）—— 主进程侧 5 个模块在**运行期** require
 *      `../shared/` 下的文件，而 `electron-builder.yml` 的 files 是**白名单**。
 *      白名单漏掉 `src/shared` 这一层时：开发模式一切正常、vite 构建也绿，
 *      **装出来的 exe 里一导出就 MODULE_NOT_FOUND**。这类"开发看不见、装机才崩"
 *      正是本闸门存在的理由。
 *   6. **隔离运行不写全局配置** —— E2E/取证都带 `--user-data-dir=<临时>`，而 `appData`
 *      仍是真实 `%APPDATA%`；没守卫时一次测试就会把用户真实的镜枢配置冲成临时路径。
 *
 * 用法：
 *   node tools/check-mcp-bridge.mjs             # 校验（闸门用）
 *   node tools/check-mcp-bridge.mjs --selftest  # 只跑判据自证
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const APP = path.join(ROOT, 'packages', 'desktop')
const MAIN = path.join(APP, 'src', 'main')

const require = createRequire(import.meta.url)

/** 真实仓库断言的条数。改动断言必须同步改这里 + scripts/verify.mjs 的 expected。 */
export const TOTAL_ASSERTIONS = 18

/** 预期工具表：少一个 = 少一项能力；多一个 = agent 会去调半成品。 */
export const EXPECTED_TOOLS = [
  'yijing_list_drafts',
  'yijing_read_draft',
  'yijing_create_draft',
  'yijing_probe_media',
  'yijing_add_clips',
  'yijing_add_subtitles',
  'yijing_update_clip',
  'yijing_delete_clip',
  'yijing_export_video'
]

/* --------------------------------------------------- 纯函数（可被自证复用） */

/**
 * 把 electron-builder 的 glob 翻成正则。只支持本项目用到的形态：
 *   `**` 跨目录、`*` 段内、其余字符字面量。别拿它当通用 glob 用。
 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1
        if (glob[i + 1] === '/') {
          i += 1
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** rel 是相对**应用目录**（packages/desktop）的 posix 路径；patterns 是白名单正向项。 */
export function isCovered(rel, patterns) {
  return patterns.some((p) => globToRegExp(p).test(rel))
}

/**
 * 从白名单里挑出**正向**项（`!` 是排除项，不构成覆盖）。
 * 只取 `files:` 段内、`- ` 开头的行。
 */
export function parseWhitelist(yamlText) {
  const lines = yamlText.split('\n')
  const out = []
  let inFiles = false
  for (const line of lines) {
    if (/^files\s*:/.test(line)) {
      inFiles = true
      continue
    }
    if (inFiles) {
      if (/^\S/.test(line)) break // 顶格 ⇒ 出了 files 段
      const m = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/)
      if (m) {
        const p = m[1].trim()
        if (p && !p.startsWith('!')) out.push(p.replace(/\\/g, '/'))
      }
    }
  }
  return out
}

/** 扫一个目录下所有 .js/.cjs 里的相对 require('..')，返回 {from, req, targetRel}。 */
export function collectRelativeRequires(baseDir, appDir) {
  const out = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(c?js|mjs)$/.test(name)) continue
      const text = fs.readFileSync(full, 'utf8')
      const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g
      let m
      while ((m = re.exec(text))) {
        const req = m[1]
        const target = path.resolve(path.dirname(full), req)
        const withExt = path.extname(target) ? target : target + '.js'
        out.push({
          from: path.relative(appDir, full).replace(/\\/g, '/'),
          req,
          targetRel: path.relative(appDir, withExt).replace(/\\/g, '/')
        })
      }
    }
  }
  walk(baseDir)
  return out
}

/**
 * 给一组 require 判「是否存在 + 是否被白名单覆盖」。纯函数，供自证喂合成输入。
 */
export function assessCoverage(requires, patterns, existsFn) {
  const missing = []
  const uncovered = []
  for (const r of requires) {
    if (!existsFn(r.targetRel)) missing.push(r)
    else if (!isCovered(r.targetRel, patterns)) uncovered.push(r)
  }
  return { missing, uncovered }
}

/**
 * index.js 的自动注册是否被「隔离 profile 不写全局配置」的守卫包着。
 *
 * 为什么必须钉：E2E / 截图取证都带 `--user-data-dir=<临时目录>`，但 `app.getPath('appData')`
 * 仍是**真实** `%APPDATA%` —— 没有守卫时，一次测试就会把用户真实的
 * `%APPDATA%\yegin\mcp.json` 冲成临时/dev 路径（实测踩过一次：全量 verify 把用户配置
 * 指向了 `.../Temp/yjai-e2e/.insp-fx-xxxx`，镜枢下次启动就会去连一个不存在的目录）。
 * 判据：源码里出现 `commandLine.hasSwitch('user-data-dir')`。
 */
export function registrationGuarded(indexText) {
  return /commandLine\s*\.\s*hasSwitch\s*\(\s*['"]user-data-dir['"]\s*\)/.test(indexText)
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const selftest = process.argv.includes('--selftest')
  let pass = 0
  let fail = 0
  const check = (name, ok, detail = '') => {
    if (ok) pass += 1
    else fail += 1
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
  }

  // ── 自证：只验判据本身能不能分辨，不碰真实仓库 ──────────────────────
  if (selftest) {
    const patternsWithShared = ['src/main/**/*', 'src/preload/**/*', 'src/shared/**/*']
    const patternsMissingShared = ['src/main/**/*', 'src/preload/**/*']
    const req = [{ from: 'src/main/render.js', req: '../shared/aspect.js', targetRel: 'src/shared/aspect.js' }]
    const allExist = () => true

    const bad = assessCoverage(req, patternsMissingShared, allExist)
    check('1. 自证：白名单漏 src/shared/**/* 时，shared 的 require 被判「未覆盖」', bad.uncovered.length === 1, `uncovered=${bad.uncovered.length}`)

    const good = assessCoverage(req, patternsWithShared, allExist)
    check('2. 自证：补上 src/shared/**/* 后不再报未覆盖', good.uncovered.length === 0, `uncovered=${good.uncovered.length}`)

    const gone = assessCoverage(req, patternsWithShared, () => false)
    check('3. 自证：目标文件不存在会被单独判「缺失」（而非算作已覆盖）', gone.missing.length === 1 && gone.uncovered.length === 0, `missing=${gone.missing.length}`)

    check('4. 自证：glob 不过宽 —— src/main/**/* 不该匹配 src/shared/a.js', isCovered('src/shared/a.js', ['src/main/**/*']) === false)
    check('5. 自证：glob 能正确匹配自身子树 —— src/main/**/* 匹配 src/main/render.js', isCovered('src/main/render.js', ['src/main/**/*']) === true)

    // 白名单解析：排除项（!）不得被当成覆盖项
    const parsed = parseWhitelist('files:\n  - src/main/**/*\n  - "!**/*.map"\n  - src/shared/**/*\nafter: 1\n')
    check('6. 自证：白名单解析剔除 ! 排除项，只留正向项', parsed.length === 2 && !parsed.some((p) => p.startsWith('!')), JSON.stringify(parsed))

    // 隔离守卫：正反两面
    const guardedSrc = "const iso = app.commandLine.hasSwitch('user-data-dir')\nif (!iso) registerMcpServer({})"
    const unguardedSrc = 'registerMcpServer({ appDataDir: app.getPath(\'appData\') })'
    check('7. 自证：带 hasSwitch 守卫的源码判「已守卫」', registrationGuarded(guardedSrc) === true)
    check('8. 自证：去掉守卫的源码判「未守卫」（正反都能分辨）', registrationGuarded(unguardedSrc) === false)

    console.log(`\nMCP_BRIDGE_SELFTEST_STATS total=${pass + fail} pass=${pass} fail=${fail}`)
    console.log(fail ? 'MCP_BRIDGE_SELFTEST_FAILED' : 'MCP_BRIDGE_SELFTEST_OK')
    process.exitCode = fail ? 1 : 0
    return
  }

  // ── 真实仓库 ────────────────────────────────────────────────────────
  console.log('MCP 桥（镜枢 ↔ 剪辑软件）\n')

  const files = {
    server: path.join(MAIN, 'mcp-server.js'),
    drafts: path.join(MAIN, 'drafts.js'),
    media: path.join(MAIN, 'media.js'),
    register: path.join(MAIN, 'mcp-register.js'),
    index: path.join(MAIN, 'index.js')
  }
  for (const [k, p] of Object.entries(files)) {
    check(`1.${k} 存在`, fs.existsSync(p), path.relative(ROOT, p))
  }

  // 工具表恰好 9 个
  const serverText = fs.existsSync(files.server) ? fs.readFileSync(files.server, 'utf8') : ''
  const toolNames = [...serverText.matchAll(/^\s*(yijing_[a-z_]+)\s*:\s*\{/gm)].map((m) => m[1])
  const toolSetOk =
    toolNames.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => toolNames.includes(n))
  check(
    '2. 工具表恰好 9 个且名字齐全',
    toolSetOk,
    `实际 ${toolNames.length} 个：${toolNames.join(', ')}`
  )

  // stdout 纯洁性：不许 console.log
  const hasConsoleLog = /\bconsole\.log\s*\(/.test(serverText)
  const usesStdoutWrite = /process\.stdout\.write\s*\(/.test(serverText)
  check('3. mcp-server.js 不许往 stdout 打日志（console.log）', !hasConsoleLog, hasConsoleLog ? '发现 console.log' : '干净')
  check('4. mcp-server.js 用 process.stdout.write 发 JSON-RPC', usesStdoutWrite)

  // 自动注册接线（index.js）
  const indexText = fs.existsSync(files.index) ? fs.readFileSync(files.index, 'utf8') : ''
  check('5. index.js require 了 ./mcp-register', /require\(\s*['"]\.\/mcp-register['"]\s*\)/.test(indexText))
  check('6. index.js 真的调用了 registerMcpServer(', /registerMcpServer\s*\(/.test(indexText))
  check('7. index.js 用 createDraftStore（草稿规则已下沉，无第二份实现）', /createDraftStore\s*\(/.test(indexText))

  // 自动注册功能（真跑一次，写临时目录）
  let regMod = null
  try {
    regMod = require(files.register)
  } catch (e) {
    regMod = null
  }
  if (!regMod) {
    check('8. mcp-register 可被 require', false, 'require 失败')
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-mcpgate-'))
    try {
      const appData = path.join(tmp, 'Roaming')
      fs.mkdirSync(path.join(appData, 'yegin'), { recursive: true })
      const exe = 'C:\\Program Files\\Y\\App.exe'
      const first = regMod.registerMcpServer({
        appDataDir: appData,
        localAppDataDir: '',
        execPath: exe,
        serverScript: 'C:\\Program Files\\Y\\mcp-server.js',
        userDataDir: 'U:\\ud'
      })
      const doc = JSON.parse(fs.readFileSync(path.join(appData, 'yegin', 'mcp.json'), 'utf8'))
      const ent = doc.mcpServers && doc.mcpServers[regMod.SERVER_KEY]
      const shapeOk =
        first.written === true &&
        ent &&
        ent.command === `"${exe}"` &&
        ent.env &&
        ent.env.ELECTRON_RUN_AS_NODE === '1' &&
        ent.env.YIJAI_USER_DATA === 'U:\\ud'
      check('8. 自动注册写出正确形状（引号 / ELECTRON_RUN_AS_NODE / userData）', !!shapeOk, ent ? JSON.stringify(ent) : '无条目')

      // 合并：不得覆盖别人
      fs.writeFileSync(
        path.join(appData, 'yegin', 'mcp.json'),
        JSON.stringify({ mcpServers: { 'someone-else': { command: 'foo' }, [regMod.SERVER_KEY]: ent } }, null, 2)
      )
      regMod.registerMcpServer({
        appDataDir: appData,
        localAppDataDir: '',
        execPath: exe,
        serverScript: 'C:\\Program Files\\Y\\mcp-server.js',
        userDataDir: 'U:\\ud'
      })
      const doc2 = JSON.parse(fs.readFileSync(path.join(appData, 'yegin', 'mcp.json'), 'utf8'))
      check('9. 合并写入不覆盖别人的 server 条目', !!doc2.mcpServers['someone-else'])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  // 打包覆盖（核心）
  const ymlPath = path.join(APP, 'electron-builder.yml')
  const patterns = fs.existsSync(ymlPath) ? parseWhitelist(fs.readFileSync(ymlPath, 'utf8')) : []
  check('10. electron-builder.yml 可解析出非空白名单', patterns.length > 0, `${patterns.length} 项`)

  const requires = collectRelativeRequires(MAIN, APP)
  const existsFn = (rel) => fs.existsSync(path.join(APP, rel))
  const { missing, uncovered } = assessCoverage(requires, patterns, existsFn)
  check('11. 主进程相对 require 的目标文件全都存在', missing.length === 0, missing.map((m) => m.targetRel).join(', ') || `${requires.length} 条全在`)
  check(
    '12. 主进程运行期 require 的文件全被打包白名单覆盖（漏了会「装机才崩」）',
    uncovered.length === 0,
    uncovered.length ? uncovered.map((u) => `${u.targetRel} ← ${u.from}`).join('; ') : `${requires.length} 条全覆盖`
  )

  // mcp-server.js 自身必须随包（agent 靠 args 指过来）
  const serverRel = path.relative(APP, files.server).replace(/\\/g, '/')
  check('13. mcp-server.js 自身被白名单覆盖（镜枢按此路径拉起）', isCovered(serverRel, patterns), serverRel)

  // 隔离 profile 不得改用户**全局**的镜枢配置（见 registrationGuarded 说明）
  check(
    '14. index.js 的自动注册被「隔离 profile 不写全局配置」守卫包着（--user-data-dir 时不写）',
    registrationGuarded(indexText),
    registrationGuarded(indexText) ? '有守卫' : '缺守卫：E2E/取证会把用户 %APPDATA%\\yegin\\mcp.json 冲坏'
  )

  console.log(`\nMCP_BRIDGE_STATS total=${pass + fail} pass=${pass} fail=${fail}`)
  console.log(fail ? 'MCP_BRIDGE_FAILED' : 'MCP_BRIDGE_OK')
  process.exitCode = fail ? 1 : 0
}

main()
