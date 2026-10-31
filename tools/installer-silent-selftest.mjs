#!/usr/bin/env node
/**
 * 自证：安装器的**静默参数解析**（智能体无人值守安装的入口）。
 *
 * 为什么要单独自证而不是只靠"装一遍试试"：
 *   · 参数解析错了的表现是"双击安装器还弹窗"或"装到默认目录去了"，
 *     而装一遍的 E2E 在 CI 机器上很贵、还污染注册表；
 *   · 这里喂合成 argv，把「什么时候算静默 / 目录从哪来 / 结果写哪」逐条钉死。
 *
 * 用法：node tools/installer-silent-selftest.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)
const silent = require(path.join(ROOT, 'packages', 'installer', 'electron', 'silent.js'))

export const TOTAL_ASSERTIONS = 14

const pass = []
const fail = []
const check = (name, ok, detail = '') => {
  ;(ok ? pass : fail).push(name)
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
}

const TMP = 'C:\\Temp'
const parse = (argv) => silent.parseSilentArgs(argv, { tmpdir: TMP })

/* 1. 不带参数：不是静默 */
const plain = parse(['YiJingAIEditor-Setup.exe'])
check('1. 不带 --silent 时不是静默模式（双击仍走图形安装）', plain.silent === false)

/* 2. 三种静默写法 */
check('2. --silent / -s / /S 三种写法都认', parse(['--silent']).silent && parse(['-s']).silent && parse(['/S']).silent)

/* 3. 默认行为 */
const base = parse(['--silent'])
check('3. 默认建快捷方式、写登记、不自动启动、不自启', base.shortcuts === true && base.register === true && base.launch === false && base.autoStart === false)
check('4. 默认结果文件落在 %TEMP%\\yijing-install-result.json', base.resultFile === path.join(TMP, 'yijing-install-result.json'), base.resultFile)

/* 5-6. 安装目录两种写法 */
const dir1 = parse(['--silent', '--install-dir', 'D:\\Apps\\YJAI'])
check('5. --install-dir <dir> 空格写法', dir1.targetPath === 'D:\\Apps\\YJAI', dir1.targetPath)
const dir2 = parse(['--silent', '--install-dir=E:\\Soft\\YJ'])
check('6. --install-dir=<dir> 等号写法', dir2.targetPath === 'E:\\Soft\\YJ', dir2.targetPath)

/* 7. 结果文件自定义 */
const rf = parse(['--silent', '--result', 'D:\\out\\r.json'])
check('7. --result 指定结果文件（会被解析成绝对路径）', rf.resultFile === path.resolve('D:\\out\\r.json'), rf.resultFile)

/* 8. 三个开关 */
const sw = parse(['--silent', '--no-shortcuts', '--no-register', '--autostart', '--launch'])
check('8. --no-shortcuts / --no-register / --autostart / --launch 都生效', sw.shortcuts === false && sw.register === false && sw.autoStart === true && sw.launch === true)

/* 9. 未知参数被记录，不影响安装 */
const unk = parse(['--silent', '--whatever', '--install-dir', 'D:\\A'])
check('9. 未知 --xxx 记录但不致命（安装照跑）', unk.silent === true && unk.unknown.includes('--whatever') && unk.targetPath === 'D:\\A', JSON.stringify(unk.unknown))

/* 10. 参数值缺失时不把它当目录 */
const dangling = parse(['--silent', '--install-dir'])
check('10. --install-dir 后面没值时不当成目录（回落默认）', dangling.targetPath === '' && dangling.silent === true)

/* 11. 非静默时参数一律不生效（防止图形安装被外部参数带偏） */
const ignored = parse(['--install-dir', 'D:\\X', '--result', 'D:\\r.json'])
check('11. 非静默模式下 install-dir/result 一律不生效', ignored.targetPath === '' && ignored.resultFile === path.join(TMP, 'yijing-install-result.json'))

/* 12. installOptions 形状与图形界面那条路一致 */
const opts = silent.installOptions({ targetPath: 'D:\\A', shortcuts: false, autoStart: true, register: false }, '1.0.1')
check(
  '12. installOptions 交给 runInstall 的字段齐全（含 register 开关）',
  opts.targetPath === 'D:\\A' && opts.createDesktopShortcut === false && opts.createStartMenuShortcut === false && opts.autoStart === true && opts.register === false && opts.version === '1.0.1',
  JSON.stringify(opts)
)

/* 13. 结果文件可原子写（先 tmp 再 rename） */
import fs from 'node:fs'
import os from 'node:os'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-silent-'))
const file = path.join(tmpDir, 'r.json')
const wrote = silent.writeResult(file, { ok: true, code: 0 })
const back = wrote ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
check('13. writeResult 原子写并能读回', wrote === true && back && back.ok === true && back.code === 0)

/* 14. 写不进去时返回 false 而不是抛 */
const badFile = silent.writeResult(path.join(tmpDir, 'nope', '\u0000bad', 'r.json'), { ok: true })
check('14. writeResult 写失败返回 false（不抛，退出码仍然有效）', badFile === false)

fs.rmSync(tmpDir, { recursive: true, force: true })

const total = pass.length + fail.length
console.log(`\nINSTALLER_SILENT_STATS total=${total} pass=${pass.length} fail=${fail.length}`)
console.log(fail.length || total !== TOTAL_ASSERTIONS ? 'INSTALLER_SILENT_FAILED' : 'INSTALLER_SILENT_OK')
process.exit(fail.length || total !== TOTAL_ASSERTIONS ? 1 : 0)
