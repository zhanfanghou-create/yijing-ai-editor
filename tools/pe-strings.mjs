#!/usr/bin/env node
/**
 * pe-strings.mjs —— 本机没有 `strings`（Git Bash / Windows 都没带），
 * 而取证参考客户端的 DLL / EXE 时又要**经常**看字符串表，所以自备一个。
 * 纯 Node，零依赖，只读。
 *
 * 为什么不是 `grep -a` 就够：
 *   `grep -a` 能告诉你"这个 DLL 里有 GeneralEnhance"，但**给不出上下文顺序**。
 *   而参考的资源名与界面文案在字符串表里是**按声明顺序相邻**的，
 *   「相邻」正是我们判定「哪张图配哪个名字」的依据（`FsVideoEnhancer.dll` 就是这么定的）。
 *   所以这个工具的核心价值是 `--around` / `--window`：把命中点前后若干条字符串打出来。
 *
 * 用法：
 *   # 1) 列出全部字符串（带文件偏移，按出现顺序）
 *   node tools/pe-strings.mjs <文件> [--min 5] [--an]
 *   # 2) 看某条命中的上下文（前后各 N 条）
 *   node tools/pe-strings.mjs <文件> --around RemoveMosaic --window 12
 *   # 3) 只在窗口内按正则过滤
 *   node tools/pe-strings.mjs <文件> --around Denoise --window 40 --grep '\.webp$'
 *   # 4) 统计某个名字出现几次
 *   node tools/pe-strings.mjs <文件> --count RemoveMosaic
 *
 * --an：只保留可打印 ASCII（默认就是）。加 `--utf16` 可一并抽 UTF-16LE 字符串
 *       （Qt 的 QString 常量常以 UTF-16 落盘，中文文案多在这个形态里）。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const file = argv.find((a) => !a.startsWith('--') && !/^-?\d+$/.test(a) && !isValueOfPrevFlag(a))
function isValueOfPrevFlag(a) {
  // 参数值（如 --min 5 的 5、--around X 的 X）不算位置参数
  const i = argv.indexOf(a)
  return i > 0 && ['--min', '--max', '--around', '--window', '--grep', '--count'].includes(argv[i - 1])
}

if (!file || !fs.existsSync(file)) {
  console.error('用法：node tools/pe-strings.mjs <文件> [--min 5] [--around <文本>] [--window 30] [--grep <正则>] [--utf16] [--count <文本>]')
  process.exit(2)
}

const MIN = Number(arg('min', 5))
const MAX = Number(arg('max', 4096))
const AROUND = arg('around', null)
const WINDOW = Number(arg('window', 20))
const GREP = arg('grep', null)
const COUNT = arg('count', null)
const UTF16 = Boolean(arg('utf16', false))
const buf = fs.readFileSync(file)

/**
 * 抽可打印字符串。`stride` 支持 ASCII（1 字节）与 UTF-16LE（2 字节）。
 * UTF-16LE 的判据：低字节可打印、高字节为 0。
 */
function scan(stride) {
  const out = []
  let start = -1
  for (let i = 0; i <= buf.length; i += stride) {
    let printable = false
    if (i < buf.length) {
      const lo = buf[i]
      if (stride === 1) {
        printable = lo >= 0x20 && lo < 0x7f
      } else {
        const hi = i + 1 < buf.length ? buf[i + 1] : 1
        printable = lo >= 0x20 && lo < 0x7f && hi === 0
        // 中文标点会被 UTF-16 存成高位非 0，这里只收 ASCII 那一半；
        // 真要中文请用 --utf16 配合 --grep 在完整串上过滤（见下）
      }
    }
    if (printable) {
      if (start === -1) start = i
      continue
    }
    if (start !== -1) {
      const len = (i - start) / stride
      if (len >= MIN && len <= MAX) {
        out.push({ at: start, s: stride === 1 ? buf.toString('latin1', start, i) : buf.toString('utf16le', start, i) })
      }
      start = -1
    }
  }
  return out
}

let list = scan(1)
if (UTF16) {
  // UTF-16LE：按 2 字节对齐扫，收完整的 UTF-16 串（含中文）
  const u16 = []
  let start = -1
  for (let i = 0; i + 1 <= buf.length; i += 2) {
    const c = buf.readUInt16LE(i)
    const printable = (c >= 0x20 && c < 0x7f) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)
    if (printable) {
      if (start === -1) start = i
      continue
    }
    if (start !== -1) {
      const len = (i - start) / 2
      if (len >= MIN && len <= MAX) {
        const s = buf.toString('utf16le', start, i)
        if (/[\u4e00-\u9fff]/.test(s)) u16.push({ at: start, s })
      }
      start = -1
    }
  }
  list = list.concat(u16).sort((a, b) => a.at - b.at)
}

if (COUNT) {
  const hits = list.filter((x) => x.s.includes(String(COUNT)))
  console.log(`${COUNT} 命中 ${hits.length} 条：`)
  hits.forEach((h) => console.log(`  0x${h.at.toString(16).padStart(8, '0')}  ${JSON.stringify(h.s)}`))
  process.exit(0)
}

let view = list
if (AROUND) {
  const idx = list.findIndex((x) => x.s.includes(String(AROUND)))
  if (idx < 0) {
    console.error(`没找到含「${AROUND}」的字符串`)
    process.exit(1)
  }
  const lo = Math.max(0, idx - WINDOW)
  const hi = Math.min(list.length, idx + WINDOW + 1)
  view = list.slice(lo, hi)
  console.log(`# 命中于第 ${idx} 条（0x${list[idx].at.toString(16)}），显示 ${lo}..${hi - 1}`)
}

if (GREP) {
  const re = new RegExp(String(GREP))
  view = view.filter((x) => re.test(x.s))
  console.log(`# --grep ${GREP} → ${view.length} 条`)
}

view.forEach((x) => console.log(`0x${x.at.toString(16).padStart(8, '0')}  ${JSON.stringify(x.s)}`))
console.log(`# 共 ${view.length} 条（全文件 ${list.length} 条，min=${MIN}）`)
