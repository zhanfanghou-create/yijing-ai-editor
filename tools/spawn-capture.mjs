/**
 * 以「文件重定向」代替「管道」来跑子进程并取回输出。
 *
 * 为什么要这么绕：本机（2026-09-26 实测）在**进程内部** spawn 另一个 node 时，
 * 只要 stdio 走管道就会 EBUSY —— `spawnSync(node, ['-v'])` 直接 error=EBUSY、
 * status=null，而同样的命令在 shell 里跑得好好的。换成把子进程的 stdout/stderr
 * **重定向到文件描述符**就正常（项目里 tools/shoot-ref-images.mjs 早就在用这个写法）。
 *
 * 于是有一批「检查器自己 spawn 一个脚本、再解析它的输出」的自证闸门，一直在报
 * EBUSY 而不是真的在验东西 —— 表面上是一道红闸门，实际是**检查器整个没在工作**。
 * 这类"工具自己坏了"比"被测代码坏了"更危险，所以单独抽出来共用。
 *
 * 用法：
 *   const r = spawnCapture(process.execPath, [script, ...args], { cwd })
 *   r.stdout  // 子进程写到 stdout+stderr 的全部文本（两者合并，顺序与写入一致）
 *   r.status  // 退出码（spawn 本身失败时为 null，此时 r.error 有原因）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpName = (tag) =>
  path.join(os.tmpdir(), `yjai-cap-${process.pid}-${Date.now().toString(36)}-${tag}.txt`)

export function spawnCapture(command, args = [], options = {}) {
  const { cwd, env, timeout, input, tag = 'out' } = options
  const file = tmpName(tag)
  let fd = -1
  try {
    fd = fs.openSync(file, 'w')
    if (input !== undefined) fs.writeSync(fd, String(input))
    const result = spawnSync(command, args, {
      cwd,
      env,
      timeout,
      // stdout/stderr 都指到同一个文件：调用方要的是"子进程打印了什么"，
      // 分成两个文件反而要处理交错顺序，合并成一个更贴近管道的原始语义
      stdio: ['ignore', fd, fd]
    })
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      text = ''
    }
    return { ...result, stdout: text, stderr: '' }
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}

export default spawnCapture
