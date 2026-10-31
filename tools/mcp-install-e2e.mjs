#!/usr/bin/env node
/**
 * 闸门：**智能体装软件 + 唤起软件**（镜枢 ↔ 安装包 ↔ 主程序的真机取证）。
 *
 * 为什么单开一道闸（别的闸门都验不了这条链）：
 *   · `installer-silent-selftest` 只验"参数 → 选项"的映射，**不跑安装包**；
 *   · `mcp-agent-e2e` 验的是"已有软件时 agent 能不能剪片"，**不装软件**；
 *   · `app-cli-e2e` 验的是"直接拉 exe 能不能开草稿"，**不经过 agent**。
 *   于是"agent 装完打不开"这一段从来没人验过 —— 而它恰恰是交付给用户的第一公里。
 *
 * 做法与镜枢完全一致：把 `mcp-server.js` 当 stdio 子进程拉起，只发 JSON-RPC，
 * 调 `yijing_install` → `yijing_open_app`，全程不碰内部函数。
 *
 * ⚠️ 这道闸**故意保留** `ELECTRON_RUN_AS_NODE=1`：
 *   镜枢自己就是带着这个变量跑的，子进程会继承它。而安装包与主程序**本身就是
 *   Electron 应用**，一拿到它就退化成纯 node（`bad option: --silent`，退出码 9，
 *   连结果文件都不写）。所以"带着这个变量还能装成功、还能起得来"才是真结论；
 *   把它删掉再跑，等于把要验的东西藏起来（实测：删掉时 25 条断言全绿，装上却打不开）。
 *
 * 前置：先出安装包 —— `npm run installer:build`（产物在 packages/installer/dist-installer/）。
 *
 * 用法：node tools/mcp-install-e2e.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SERVER = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'mcp-server.js')
const INSTALLER_CANDIDATES = [
  path.join(ROOT, 'packages', 'installer', 'dist-installer', 'YiJingAIEditor-Setup-Windows-x64.exe'),
  path.join(os.tmpdir(), 'yjai-build', 'dist-installer', 'YiJingAIEditor-Setup-Windows-x64.exe')
]

/** 断言的条数（改动断言必须同步 scripts/verify.mjs 的 expected） */
export const TOTAL_ASSERTIONS = 11

const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')

/* ------------------------------ MCP 客户端 ------------------------------ */
/* 只留这道闸用得到的最小实现；完整的取证套件在 mcp-agent-e2e.mjs 里。 */
class Client {
  constructor(proc) {
    this.proc = proc
    this.id = 0
    this.pending = new Map()
    this.buf = ''
    this.stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      this.buf += chunk
      const lines = this.buf.split('\n')
      this.buf = lines.pop() || ''
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        let msg = null
        try {
          msg = JSON.parse(text)
        } catch {
          continue
        }
        const waiter = this.pending.get(msg.id)
        if (waiter) {
          this.pending.delete(msg.id)
          waiter(msg)
        }
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (c) => {
      this.stderr += c
    })
  }

  rpc(method, params, timeoutMs = 300000) {
    const id = ++this.id
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      this.proc.stdin.write(JSON.stringify(payload) + '\n')
    })
  }

  async tool(name, args = {}) {
    const msg = await this.rpc('tools/call', { name, arguments: args })
    const result = msg.result || {}
    const text = result.content && result.content[0] ? result.content[0].text : ''
    if (result.isError) {
      const err = new Error(text || '工具报错')
      err.isError = true
      throw err
    }
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text }
    }
  }

  close() {
    try {
      this.proc.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill()
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 度量 ------------------------------ */

/** 进程是否还活着（Windows 上 process.kill(pid,0) 可用） */
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    spawnCapture(TASKKILL, ['/PID', String(pid), '/T', '/F'], { timeout: 20000 })
  } catch {
    /* 已经不在了 */
  }
}

/** 软删：删不掉不算失败（临时目录，系统会回收），但不能因此判"成功" */
function softRemove(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

async function main() {
  const pass = []
  const failed = []
  const record = (name, ok, detail = '') => {
    ;(ok ? pass : failed).push(name)
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
  }

  const installer = INSTALLER_CANDIDATES.find((p) => fs.existsSync(p))
  if (!installer) {
    console.error('缺安装包：')
    for (const p of INSTALLER_CANDIDATES) console.error('  ', p)
    console.error('  先出包：npm run installer:build')
    console.log(`MCP_INSTALL_STATS total=${TOTAL_ASSERTIONS} pass=0 fail=1`)
    console.log('MCP_INSTALL_FAILED')
    process.exit(1)
  }

  const stamp = `${process.pid}-${Date.now().toString(36)}`
  const profile = path.join(os.tmpdir(), `yjai-inst-e2e-${stamp}`)
  const installDir = path.join(os.tmpdir(), `yjai-inst-out-${stamp}`)
  fs.mkdirSync(path.join(profile, 'drafts'), { recursive: true })

  /* ⚠️ 故意不删 ELECTRON_RUN_AS_NODE —— 见文件头 */
  const env = { ...process.env, YIJAI_USER_DATA: profile, ELECTRON_RUN_AS_NODE: '1' }

  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const client = new Client(proc)
  let appPid = 0
  let realDone = false

  try {
    const init = await client.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'yjai-install-e2e', version: '1.0.0' }
    })
    record('1. MCP 服务能握手（镜枢按 stdio 拉起）', Boolean(init.result && init.result.serverInfo), init.result && init.result.serverInfo ? init.result.serverInfo.version : '无')

    record(
      '2. 本闸确实跑在 `ELECTRON_RUN_AS_NODE=1` 的环境里（镜枢的真实环境）',
      env.ELECTRON_RUN_AS_NODE === '1',
      '故意保留：删掉它这道闸就失去意义'
    )

    const before = await client.tool('yijing_status', {})
    /* 不能假设"这台机器没装过"—— 开发机常常本来就装着一份。
       钉的不是"未安装"，而是**不许撒谎**：报告与文件系统必须一致。 */
    const beforeHonest =
      Boolean(before.app) && before.app.installed === Boolean(before.app.exe && fs.existsSync(before.app.exe))
    record(
      '3. 装之前 yijing_status 如实反映这台机器（已装就说已装，没有就说没有）',
      beforeHonest,
      before.app ? `installed=${before.app.installed} exe=${before.app.exe || '(无)'}` : '无 app 字段'
    )

    const t0 = Date.now()
    const inst = await client.tool('yijing_install', {
      installerPath: installer,
      installDir,
      shortcuts: false,
      noRegister: true
    })
    const seconds = (Date.now() - t0) / 1000
    record('4. yijing_install 在继承 ELECTRON_RUN_AS_NODE 的环境下仍然装成功', inst && inst.ok === true, `code=${inst && inst.code} ${seconds.toFixed(1)}s`)

    const exe = inst && inst.exe ? inst.exe : path.join(installDir, 'YiJingAIEditor.exe')
    const exeOk = (() => {
      try {
        return fs.statSync(exe).size > 100 * 1024 * 1024
      } catch {
        return false
      }
    })()
    record('5. 装出来的主程序 exe 真实存在且体积正常（>100MB，不是空壳）', exeOk, exe)

    const asar = path.join(path.dirname(exe), 'resources', 'app.asar')
    const asarSize = (() => {
      try {
        return fs.statSync(asar).size
      } catch {
        return 0
      }
    })()
    record('6. resources/app.asar 随包装好（漏了就是启动白屏）', asarSize > 1024 * 1024, `${(asarSize / 1024 / 1024).toFixed(1)} MB`)

    record('7. 安装耗时在合理区间（<180s，无人值守不能挂）', seconds > 0 && seconds < 180, `${seconds.toFixed(1)}s`)

    const after = await client.tool('yijing_status', {})
    record(
      '8. 装完之后 yijing_status 能看见已安装（装完自己知道）',
      Boolean(after.app) && after.app.installed === true && fs.existsSync(after.app.exe || ''),
      after.app ? `exe=${path.basename(after.app.exe || '')}` : '无 app 字段'
    )

    const opened = await client.tool('yijing_open_app', { installDir })
    appPid = Number(opened && opened.pid) || 0
    record('9. yijing_open_app 报出真实 pid（不是"喊了一声成功"）', opened && opened.launched === true && appPid > 0, `pid=${appPid}`)

    /* 等一会儿再看：被 ELECTRON_RUN_AS_NODE 带偏的进程会在几十毫秒内以 code 9 退出。
       "spawn 成功"与"窗口真的立住了"是两件事，只有等这一下才分得开。 */
    await new Promise((r) => setTimeout(r, 2500))
    record('10. 唤起 2.5 秒后主程序仍活着（真立住了，不是退化成 node 立刻退出）', alive(appPid), `pid=${appPid}`)

    realDone = true
    record(`11. 整套跑到底（${TOTAL_ASSERTIONS} 条都执行了，中断不算通过）`, realDone, `已执行 ${pass.length + failed.length + 1} 条`)
  } catch (e) {
    record('11. 整套跑到底（中断不算通过）', false, String((e && e.message) || e).slice(0, 200))
  } finally {
    killTree(appPid)
    client.close()
    await new Promise((r) => setTimeout(r, 300))
    if (!softRemove(installDir)) {
      console.log(`  (提示) 临时安装目录没删掉（不影响结论）：${installDir}`)
    }
    softRemove(profile)
    if (client.stderr) console.log(`  (server stderr) ${client.stderr.trim().split('\n').slice(-5).join(' | ')}`)
  }

  const total = pass.length + failed.length
  console.log(`\nMCP_INSTALL_STATS total=${total} pass=${pass.length} fail=${failed.length}`)
  console.log(failed.length || total !== TOTAL_ASSERTIONS ? 'MCP_INSTALL_FAILED' : 'MCP_INSTALL_OK')
  process.exit(failed.length || total !== TOTAL_ASSERTIONS ? 1 : 0)
}

main().catch((e) => {
  console.error('[mcp-install-e2e] 自身异常：', e && e.stack ? e.stack : e)
  process.exit(1)
})
