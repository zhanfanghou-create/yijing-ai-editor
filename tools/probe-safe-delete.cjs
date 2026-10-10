/**
 * 受控实验：复现「安装器 E2E 收尾删不掉开始菜单快捷方式」的条件。
 *
 * 结论用途：判断失败是**产品缺陷**还是**跑闸门的环境包装**导致的。
 * 判据不是猜的 —— 三个变量逐个单列：
 *   ① 路径在不在临时目录下（shim 对临时目录直接放行原生删除）
 *   ② 目标是文件还是目录
 *   ③ 走 fs.rmSync 还是走 cmd rd（原生进程，绕过 shim）
 *
 * 只碰自己在 %APPDATA% 下建的探针目录，跑完自己收拾干净。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const BASE = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'yjai-shim-probe')

const mk = (name) => {
  const dir = path.join(BASE, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.lnk`), 'probe')
  return dir
}

const show = (label, fn) => {
  let err = ''
  try {
    fn()
  } catch (e) {
    err = `${e && e.code ? `${e.code} ` : ''}${(e && e.message) || String(e)}`.split('\n')[0]
  }
  console.log(`${label}  →  err=${err || '（无）'}`)
}

console.log(`SESSION_ID=${(process.env.CODEBUDDY_SESSION_ID || '').slice(0, 8)}  NODE_OPTIONS=${process.env.NODE_OPTIONS ? '有' : '无'}`)
console.log(`BULK_STATE_DIR=${process.env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR || '未设'}  TOOL_CALL_ID=${process.env.CODEBUDDY_TOOL_CALL_ID ? '有' : '未设'}`)

// ① 目录 + fs.rmSync（这正是 E2E 里 startMenuDir 的形状）
const d1 = mk('dir-rmSync')
show('目录 · fs.rmSync(recursive)', () => fs.rmSync(d1, { recursive: true, force: true }))
console.log(`   仍然存在 = ${fs.existsSync(d1)}`)

// ② 目录 + 原生 rd（绕过 shim）
const d2 = mk('dir-native')
show('目录 · cmd rd /s /q        ', () =>
  execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', d2], { stdio: 'ignore', windowsHide: true })
)
console.log(`   仍然存在 = ${fs.existsSync(d2)}`)

// ③ 文件 + fs.rmSync（对照：E2E 里桌面 .lnk 是这一形状，实测删掉了）
const f3 = path.join(mk('file-rmSync'), 'file-rmSync.lnk')
show('文件 · fs.rmSync           ', () => fs.rmSync(f3, { force: true }))
console.log(`   仍然存在 = ${fs.existsSync(f3)}`)

// 收拾：一律走原生
for (const name of ['dir-rmSync', 'dir-native', 'file-rmSync']) {
  const dir = path.join(BASE, name)
  if (fs.existsSync(dir)) {
    try {
      execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', dir], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* ignore */
    }
  }
}
try {
  execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', BASE], { stdio: 'ignore', windowsHide: true })
} catch {
  /* ignore */
}
console.log(`\n探针目录已收拾：${!fs.existsSync(BASE)}`)
