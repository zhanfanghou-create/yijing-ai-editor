/**
 * gen-script-guard.mjs —— 「生成出来、交给别的进程执行的脚本」在出门之前先验一遍语法。
 *
 * 为什么需要（2026-09-24，Jason 发来一张 Electron 弹窗截图）：
 *
 *   `tools/shoot-ref-images.mjs` 会在仓库里生成 `_recon/.ref-img-main.cjs`，再让
 *   electron.exe 去执行它。模板里那段 `try {` 曾经**漏写 catch** ⇒ 生成出来的脚本
 *   本身就是语法错。后果分两层，两层都很坏：
 *
 *     · 对**父进程**：Electron 加载失败后既不打退出码也不退出，而 spawnSync 当时没有
 *       timeout ⇒ 整条命令**静默吊死**（实测吊满 4 分钟直到手工 kill）。现场症状是
 *       "跑导出没有任何输出、输出目录是空的"，看着像图有问题，其实一行代码都没跑。
 *     · 对**人**：Electron 主进程 load 失败时会弹一个系统模态框，上面写着
 *       `A JavaScript error occurred in the main process` + 生成文件的路径 + `SyntaxError`。
 *       这个框是**弹给用户看的**，而用户既不知道那是构建期临时文件，也无从修起。
 *
 *   补 catch 是修"那一次"，加 timeout 是兜底"吊死"。这道守卫修的是**这一类**：
 *   模板被编辑坏（最典型的是注释里混进一个反引号，把模板字面量提前截断 —— 同一个坑
 *   在本仓库踩过两次）时，**错误必须在生成侧立刻暴露，并且指回模板本身**，
 *   而不是在 60 秒后变成 Electron 的一个看不懂的弹窗。
 *
 * 判据为什么用 vm.Script 而不是 spawn 一个 `node --check`：
 *   ① 零进程开销（每跑一次取图工具都要验一次，不值得起进程）；
 *   ② 报错形状**与 Electron 弹的那个框同构** —— 实测 `err.stack` 首部就是
 *      `文件名:行号` + 源码行 + 脱字符，于是我们可以把它原样印给用户，
 *      两边的行号能对上（这正是排查时最需要的东西）；
 *   ③ 不需要落盘就能验 —— 于是**坏的脚本根本不会写进仓库**，
 *      仓库里也就不会留下一个"手工点一下就会弹框"的定时炸弹。
 *
 * 适用范围：**CommonJS / 顶层脚本**（本仓库生成的 Electron 入口都是这一路）。
 * 若哪天要验带 `import`/`export` 的 ESM，得换 `new vm.SourceTextModule`，
 * 届时不要在调用处偷偷放宽 —— 那会让这道守卫变成"看着验过了、其实没验"。
 */
import vm from 'node:vm'

/**
 * 验一段将被交给别的进程执行的源码。
 * @param {string} src 源码全文
 * @param {string} filename 报错时显示的名字（用相对仓库的路径，别用绝对路径 —— 日志里好读）
 * @returns {null | { line: number|null, message: string, snippet: string, stackHead: string }}
 *          null 表示语法通过
 */
export function syntaxErrorOf(src, filename = 'generated-script.cjs') {
  try {
    // 只编译不执行。副作用为零，但能拿到与 Electron 同源的 V8 语法诊断。
    new vm.Script(src, { filename })
    return null
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    const stack = String(err.stack || '')
    // V8 的语法诊断固定长这样（首部就是 Electron 弹框里那几行）：
    //   <filename>:<line>
    //   <源码那一行>
    //   ^
    //
    //   SyntaxError: <message>
    const stackHead = stack.split('\n').slice(0, 3).join('\n').trimEnd()
    // ⚠️ 只认**第一行行尾**的行号。不要全文搜 `:(\d+)` —— 文件名或源码里
    //    （比如 `setTimeout(r, 120)`）到处都有数字，全文搜必然指错行，
    //    "报出的行号是真的"这件事在本仓库是踩过坑的（见 MEMORY 的剥注释条）。
    const firstLine = stack.split('\n')[0] || ''
    const m = /:(\d+)\s*$/.exec(firstLine)
    const line = m ? Number(m[1]) : null
    const snippet = line ? (src.split(/\r?\n/)[line - 1] ?? '') : ''
    return { line, message: String(err.message || err), snippet, stackHead }
  }
}

/**
 * 把 syntaxErrorOf 的返回值拼成一段能直接 console.error 的说明。
 * 两个生成器共用一份，是为了让两边的报错长得一样 —— 现场只有一种格式要认。
 */
export function formatScriptGuardFailure(bad, filename, templateHint) {
  const at = bad.line ? `${filename}:${bad.line}` : filename
  return [
    '',
    '✗ 生成的脚本有语法错，**已拦在启动 Electron 之前**（没有写盘、没有起进程）。',
    '',
    bad.stackHead,
    '',
    `  语法错：${bad.message}`,
    `  位置　：${at}`,
    bad.snippet ? `  那一行：${bad.snippet.trim()}` : '',
    '',
    '  这多半是**模板本身写坏了**（不是输入数据的问题）：模板字面量被提前截断最常见',
    '  ——往模板里写注释时混进一个反引号，就会把模板在那个位置切断。修模板，别修生成物。',
    templateHint ? `  模板在：${templateHint}` : '',
    '',
    '  （为什么必须拦在这里：这份脚本是要交给 electron.exe 执行的。带着语法错交出去，',
    '    父进程会因为没有退出码而静默吊死，同时 Electron 会给用户弹一个',
    '    "A JavaScript error occurred in the main process" 的模态框 —— 那是给用户看的，',
    '    而用户无从修起。详见 tools/lib/gen-script-guard.mjs 的文件头。）'
  ]
    .filter((l) => l !== '')
    .join('\n')
}
