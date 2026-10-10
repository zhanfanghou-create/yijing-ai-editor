#!/usr/bin/env node
/**
 * check-ui-accent.mjs 的非空洞自证。
 *
 * 一道"视觉一致性闸"最危险的失效方式是**它其实什么都没比对却报 OK**，
 * 以及反过来 —— **把注释里的实测色值当成"还在用这套色"判红**（假红会训练人忽略闸门）。
 * 所以每一条正反两面都要有夹具。
 *
 * 夹具（临时目录里现造现删，不碰仓库真源文件）：
 *   good            令牌齐全 + 强调色全走 var()                                     → 绿
 *   cyan-back       工作台里塞回一条 `color: #00C1CD`                               → 红在青色
 *   bare-purple     把 var(--wb-accent) 换成裸的 #c36bf5                            → 红在裸字面量
 *   no-alias        --wb-accent 不指向 --violet（各写一份值）                        → 红在同源
 *   dead-cyan       styles.css 里又长出 --cyan 令牌                                 → 红在废弃令牌
 *   comment-only    注释里写满 #c473f2 / #00C1CD（实测记录），声明里一个不用         → 绿（不许假红）
 *   hollow          令牌定义都在、正文一个引用都没有                                 → 红在覆盖面
 *
 * 用法：node tools/check-ui-accent.selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from './spawn-capture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHECKER = path.join(here, 'check-ui-accent.mjs')

const results = []
let failures = 0

const record = (label, ok, detail = '') => {
  results.push({ label, ok })
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const expect = (label, got, want) => {
  record(label, got === want, got === want ? '' : `期望 ${want}，实得 ${got}`)
}

/* 夹具模板：刻意写小，只要结构像，判据就能套上 */
const STYLES = `
:root {
  --text: #e8e8e9;
  --violet: #c36bf5;
  --violet-bright: #ce76ff;
  --violet-deep: #a855f7;
  --clip-overlay: #1f7f8c;
}
.btn.primary { background: linear-gradient(135deg, var(--violet), var(--violet-deep)); }
.switch:checked { background: var(--violet); }
input[type='range']::-webkit-slider-thumb { background: var(--violet); }
.cap-ico { color: var(--violet); }
.media-card.selected { border-color: var(--violet); }
.app.is-dragging { outline: 2px dashed var(--violet); }
.guide-dot.on { background: linear-gradient(135deg, var(--violet), var(--violet-deep)); }
`

const WORKBENCH = `
:root {
  --wb-text: #e8e8e9;
  --wb-accent: var(--violet);
  --wb-accent-hi: var(--violet-bright);
  --wb-accent-deep: var(--violet-deep);
  --wb-accent-glow: rgba(195, 107, 245, 0.22);
}
.wb-tab.active { color: var(--wb-accent); }
.wb-coltab.on { color: var(--wb-accent); box-shadow: inset 0 -2px 0 var(--wb-accent-hi); }
.wb-subpill.on { background: var(--wb-accent); color: #fff; }
.wb-inspsect-dot { background: var(--wb-accent); }
.wb-switch.on { background: var(--wb-accent-glow); border-color: var(--wb-accent); }
.wb-swatch.on { outline: 2px solid var(--wb-accent); }
.wb-num > input:focus { border-color: var(--wb-accent); }
.wb-transport .wb-time { color: var(--wb-accent); }
.wb-dropzone.drag { border-color: var(--wb-accent-deep); }
.wb-export:hover { background: linear-gradient(to right, var(--wb-accent), var(--wb-accent-deep)); }
`

const mkRoot = (styles = STYLES, workbench = WORKBENCH) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-ua-'))
  const dir = path.join(root, 'packages', 'desktop', 'src', 'renderer')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'styles.css'), styles)
  fs.writeFileSync(path.join(dir, 'workbench.css'), workbench)
  return root
}

const run = (root) => {
  const r = spawnCapture(process.execPath, [CHECKER, root], { cwd: root, timeout: 60000 })
  return { status: r.status, out: String(r.stdout || '') }
}

try {
  /* 1. 完整契约 → 绿 */
  {
    const r = run(mkRoot())
    expect('good：退出码 0', r.status, 0)
    const ok = /UI_ACCENT_OK/.test(r.out)
    record('good：打印 UI_ACCENT_OK', ok)
  }

  /* 2. 青色塞回来 → 必须红，且点名青色 */
  {
    const root = mkRoot(STYLES, WORKBENCH + '\n.wb-something { color: #00C1CD; }\n')
    const r = run(root)
    expect('cyan-back：退出码 1', r.status, 1)
    const onPoint = /青色/.test(r.out)
    record('cyan-back：报错点名「青色」', onPoint)
  }

  /* 3. 裸的品牌紫字面量 → 必须红 */
  {
    /* ⚠️ 替换串必须整行匹配：写成 `color: var(--wb-accent);\n` 会因为行尾还有 ` }`
       而**一处都没替换**，夹具退化成 good ⇒ 这条永远绿（假绿比假红更贵）。 */
    const patched = WORKBENCH.replace(
      '.wb-tab.active { color: var(--wb-accent); }',
      '.wb-tab.active { color: #c36bf5; }'
    )
    record('bare-purple：夹具确实被改动过（不是空替换）', patched !== WORKBENCH)
    const r = run(mkRoot(STYLES, patched))
    expect('bare-purple：退出码 1', r.status, 1)
    const onPoint = /裸的品牌紫/.test(r.out)
    record('bare-purple：报错点名「裸的品牌紫字面量」', onPoint)
  }

  /* 4. 令牌不同源（各写一份值）→ 必须红 */
  {
    const root = mkRoot(STYLES, WORKBENCH.replace('--wb-accent: var(--violet);', '--wb-accent: #c36bf5;'))
    const r = run(root)
    expect('no-alias：退出码 1', r.status, 1)
  }

  /* 5. 废弃的 --cyan 令牌长回来 → 必须红 */
  {
    const root = mkRoot(STYLES.replace('--violet-bright:', '--cyan: #6fb4d6;\n  --violet-bright:'), WORKBENCH)
    const r = run(root)
    expect('dead-cyan：退出码 1', r.status, 1)
    const onPoint = /--cyan/.test(r.out)
    record('dead-cyan：报错点名 --cyan', onPoint)
  }

  /* 6. 注释里的实测色值不许判红（假红防线，最重要的一条） */
  {
    const styles = STYLES.replace(
      ':root {',
      '/* 参考实测：根项文字 top1% rgb(196,115,242)（#c473f2）、图标 #ce76ff、旧强调 #8372fe */\n:root {'
    )
    const wb = WORKBENCH.replace(
      ':root {',
      '/* 参考实测：时码是青色 #00C1CD、子页签选中是青色 —— 这是**换色前的记录**，不是声明 */\n:root {'
    )
    const r = run(mkRoot(styles, wb))
    expect('comment-only：注释里的 #c473f2 / #00C1CD 不算违规（退出码 0）', r.status, 0)
    const ok = /UI_ACCENT_OK/.test(r.out)
    record('comment-only：仍然打印 UI_ACCENT_OK', ok)
  }

  /* 7. 令牌都在、正文一个引用都没有 → 覆盖面必须喊（不许空转报绿） */
  {
    const styles = `:root { --violet: #c36bf5; --violet-bright: #ce76ff; --violet-deep: #a855f7; }\n`
    const wb = `:root { --wb-accent: var(--violet); --wb-accent-hi: var(--violet-bright); }\n.wb-x { color: #e8e8e9; }\n`
    const r = run(mkRoot(styles, wb))
    expect('hollow：覆盖面判据必须说「几乎没有引用」（退出码 1）', r.status, 1)
    const onPoint = /引用只有/.test(r.out)
    record('hollow：报错点名「引用只有 N 处」', onPoint)
  }

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  console.log('')
  console.log(`=== 结果：通过 ${passed} 项 / 失败 ${failures} 项 ===`)
  if (failures === 0) console.log('UI_ACCENT_SELFTEST_OK')
  console.log(`UI_ACCENT_SELFTEST_STATS total=${total} pass=${passed} fail=${failures}`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error('自证脚本自身异常：')
  console.error(String((error && error.stack) || error))
  process.exitCode = 1
}
