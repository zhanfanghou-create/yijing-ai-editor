#!/usr/bin/env node
/**
 * check-imports.mjs 的自证夹具。
 *
 * 为什么要单独写：这个检查器最初的版本只验"路径能不能解析"，看起来在跑、
 * 报告也漂亮，但它对**命名绑定**一无所知 —— 于是「符号用了却忘了写进 import」
 * 这类缺陷可以一路静默到运行时才 ReferenceError（2026-09-21 真实发生）。
 * 更早一轮的 check-node-modules 也是"报 OK 但其实什么都没查"。
 *
 * 所以这里用固定夹具把六类**必须报错**的情形和七类**必须不报错**的情形钉死：
 *   必须报：路径不可解析 / 导入的名字不存在 / 用了但没导入 /
 *           该缺陷落在"被串扰吃掉"的区间里 / 悬空的状态 setter /
 *           自由变量（组件 prop 忘了解构 ⇒ 挂载即 ReferenceError）
 *   必须不报：默认导入与具名导入混写 / 参数解构 / `export function` 自身声明 /
 *             字符串里同时含反引号与另一种引号 / 合法的 setter 写法 /
 *             第 5 条的开放集合（JSX 标签与属性、JSX 纯文案、正则字面量内容）/
 *             第 3 条里"与已导入模块的导出同名的 JSX 属性名"（2026-09-24 加）
 * 后几条都是**真实误报或真实漏报过**的写法，不钉住就会在下次改动里退回去。
 *
 * ⚠️ 新增一条"必须不报"时，**必须同时补一条反向控制组**证明判据只是收窄了位置、
 * 没有把名字整体放过 —— 否则"修假红"很容易修成"把真缺陷一起静音"，
 * 而后者在验收时看起来一模一样（都是绿的）。见 `attr-and-value.jsx`。
 *
 * 输出：IMPORTS_SELFTEST_PASSED / IMPORTS_SELFTEST_FAILED + 「自证：通过 N 项 / 失败 M 项」
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { spawnCapture } from './spawn-capture.mjs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHECKER = path.join(ROOT, 'tools', 'check-imports.mjs')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  ::  ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yijing-imports-selftest-'))

const LIB = `export const alpha = 1
export function fetchHomeAssets(base) { return base }
export const config = { dbFile: 'x' }
export default config
`

/**
 * 字符串里同时出现「反引号」和「另一种引号」—— 这是 2026-09-21 那个缺陷的等价物。
 *
 * 旧版 stripNoise 分五步正则替换，模板串那一步会把 `Backquote: '`'` 中
 * **位于单引号串内部的反引号**当成分隔符，与后面真模板串的反引号配对，
 * 把中间这段真实代码整段吃掉 —— 于是 `comboOf` 明明 `export` 了却报「不存在」。
 * 用逐行数组拼，避免在夹具自身里跟反引号/`${}` 打架。
 */
const QUOTES_IN_STRINGS = [
  "import { alpha } from './lib.js'",
  '',
  'export const KEYS = { Quote: "\'", Backquote: \'`\' }',
  'export const tag = (i) => `F${i}`',
  '',
  'export function comboOf(node) {',
  '  return KEYS.Quote + KEYS.Backquote + tag(alpha) + node',
  '}',
  ''
].join('\n')

/** 三种写法都是**合法且干净**的：混写默认导入、参数解构、export function 自身 */
const CLEAN = {
  'lib.js': LIB,
  'mixed.js': `import config, { alpha, fetchHomeAssets } from './lib.js'

export function useAll() {
  return alpha + fetchHomeAssets(config.dbFile).length
}

export async function parseNotify({ alpha: a, limit = 10, ...rest }) {
  return a + limit + Object.keys(rest).length
}

export default { useAll }
`,
  'params.js': `import { alpha } from './lib.js'

export async function pollUntil({ ok, intervalMs = 3000, onTick }) {
  const first = await ok(1)
  onTick?.(first)
  return alpha + intervalMs
}

export const pick = ({ value: v }) => v
`,
  'quotes.js': QUOTES_IN_STRINGS
}

/**
 * 第 4 类缺陷的干净写法（都**必须不报**）。
 *
 * `setRail` 那类缺陷（全局都不存在的 setter）能不能被抓到，取决于判据够不够紧；
 * 判据越紧越可能反过来咬到合法写法。这一组就是把合法写法钉住：
 *   · `const [rail, setRail] = useState()`
 *   · `const { setDirty } = useContext(F)`（对象解构出来的 setter）
 *   · `setTab` 作为参数传进来
 *   · `setTimeout` / `el.setPointerCapture` 这类全局与方法调用
 *   · **对象字面量的键**（`const api = { setHeight: (h) => ... }`）——
 *     这一条是被误报咬过之后补的：installer 的 preload.js 就是这么写的，
 *     把属性名当成标识符使用会稳定误报。
 */
const SETTER_CLEAN = {
  'lib.js': LIB,
  'hooks.js': `import { useState, useContext } from 'react'

export function useRails(initial) {
  const [rail, setRail] = useState(initial)
  const setDirty = useContext(Context).setDirty
  const withSetter = (setTab) => setTab(rail)
  const later = () => setTimeout(() => setRail('media'), 0)
  const node = document.createElement('div')
  node.setPointerCapture?.(1)
  setDirty(true)
  return { rail, later, withSetter }
}

/** 属性名不是标识符使用 —— 同名函数可以根本不存在 */
export const apiShape = { setHeight: (h) => h, setWidth: (w) => w }

export const keep = 1
`
}

/**
 * 第 5 类（自由变量）的干净写法 —— 都**必须不报**。
 *
 * 判据是"全库找不到出生证明"，所以它的敌人全是**开放集合**：JSX 标签名、
 * JSX 属性名（含 `muted` / `playsInline` 这种没有等号的布尔属性）、
 * JSX 纯文案（`Ready or Empty` 里的 `or` 就是个小写英文词）、
 * 正则字面量里的内容（`/&quot;/g`、`/\.(mp4|mov|webm)$/i`）……
 * 这些要么手写名单会漏，要么必须靠词法器吃掉，漏一个就是一条误报。
 * 这组夹具就是把它们一次钉住 —— 同时它**非空洞**：文件里确实有
 * 「带对象解构参数的组件」，第 5 条会真的在这份夹具上跑起来。
 */
const FREEFORM_CLEAN = {
  'lib.js': LIB,
  'panel.jsx': [
    "import { useState } from 'react'",
    '',
    '/** props 一个不少地解构出来 —— 第 5 条不许在这里报任何东西 */',
    'export default function Panel({ client, initialCapability, initialPreset, onReady }) {',
    "  const [tab, setTab] = useState('media')",
    '  const rows = client?.items?.filter((item) => item.ok) || []',
    '  const ratio = rows.length / 3',
    "  const label = rows.length > 1 ? 'many' : 'one'",
    "  const clean = (text) => text.replace(/&quot;/g, '\"').replace(/\\.(mp4|mov|webm)$/i, '')",
    '  return (',
    '    <section className="wb-panel" data-wb-tool="ai" aria-hidden={false}>',
    "      <button type=\"button\" muted disabled={!rows.length} onClick={() => setTab('video')}>",
    '        {label}{tab}',
    '      </button>',
    '      <video src={client.url} playsInline preload="metadata" />',
    '      <small>Ready or Empty</small>',
    "      <span>{initialCapability}{initialPreset}{ratio}{clean('x')}{onReady}</span>",
    '    </section>',
    '  )',
    '}',
    ''
  ].join('\n'),
  /**
   * ← 2026-09-23：**中文文案里的拉丁词**必须不被误报。
   *
   * 三条形状全部来自真实误报（`px` / `shared` / `media`）：
   *   · 文案与 `{}` 表达式交错 → `{preset.size}px · 默认 {preset.duration}s`；
   *   · 文案里有 `.` 和 `/`  → `（src/shared/looks.json），改一处不需要改两处。`；
   *   · 中文句子里夹英文词   → `media 权限（现基线是「拒一切权限申请」）`。
   * 外加两条**单位后缀**：`{Math.round(x)}f` 与 `{preset.duration}s`。
   *
   * 这个夹具同时钉住"属性值里的表达式不算属性名"：`onClick={onImport}` 里
   * `onImport` 是**值**，一旦被当成属性名收进白名单，第 5 条对
   * "prop 忘了解构"这个主场景就整体失灵（脏夹具里的 prop-used-elsewhere.jsx 会假绿）。
   */
  'prose.jsx': [
    "import { useState } from 'react'",
    '',
    'const FILTERS = [{ key: "warm", label: "暖阳", size: 16, sample: "AaBbCc", duration: 0.6 }]',
    '',
    'export default function LookPanel({ onPick }) {',
    '  const [frame] = useState(0)',
    '  return (',
    '    <section className="look-grid">',
    '      <span className="look-hint">',
    '        {FILTERS[0].size}px · 默认 {FILTERS[0].duration}s',
    '      </span>',
    '      <span>',
    '        滤镜与转场的数据来源收在同一份表里（src/shared/looks.json），改一处不需要改两处。',
    '      </span>',
    '      <small>',
    '        应用内录制需要放开渲染进程的 media 权限（现基线是「拒一切权限申请」），',
    '        这个取舍需要单独确认后才会动。',
    '      </small>',
    '      <b>{Math.round(frame * 30)}f</b>',
    '      <button type="button" onClick={() => onPick(FILTERS[0].key)}>',
    '        应用',
    '      </button>',
    '    </section>',
    '  )',
    '}',
    ''
  ].join('\n'),
  /**
   * ← 2026-09-23：**解构项里嵌套花括号**之后的名字必须仍有出生证明。
   *
   * 真实假报来自 `SidePanels.jsx`：
   *   `const { mode, catalog = { models: [] }, clips = [], …, enhanceGroup = null } = props`
   * 取解构内容的写法若是 `\{([^}]*)\}`，会在 `catalog` 那一项的 `}` 处**提前收尾**，
   * 于是它**后面**的每一个名字都失去出生证明，被第 5 条整片报成假自由变量。
   *
   * 夹具刻意把名字放在**嵌套项的后面**（`enhanceGroup` / `grid` / `onImport`）——
   * 只修一半（例如"一路取到最后一个 `}`"）过不了这条；
   * 另外 `grid = [[1, 2], [3, 4]]` 钉住数组解构那条循环也不能用 `[^\]]*`。
   */
  'props-destructure.jsx': [
    "import { useState } from 'react'",
    '',
    'export default function SidePanels(props) {',
    '  const {',
    '    mode,',
    '    catalog = { models: [] },',
    '    clips = [],',
    '    enhanceGroup = null,',
    '    grid = [[1, 2], [3, 4]],',
    '    onImport',
    '  } = props',
    '  const [busy, setBusy] = useState(false)',
    '  return (',
    '    <section className={mode} data-models={catalog.models.length} data-group={enhanceGroup}>',
    '      <button type="button" onClick={onImport} disabled={busy}>',
    '        {clips.length + grid.length}',
    '      </button>',
    '      <button type="button" onPointerDown={() => setBusy(true)}>',
    '        开始',
    '      </button>',
    '    </section>',
    '  )',
    '}',
    ''
  ].join('\n'),
  /**
   * ← 2026-10-10：**对象属性里的箭头处理函数**的解构参数必须算已绑定。
   *
   * 真实假红来自 `src/main/mcp-server.js`：工具表写成
   *   `handler: ({ draftId }) => readDraftData(draftId)`
   * 而 `draftId` 同时又是 `function addClips({ draftId })` 的解构参数 ⇒ 它进了
   * "解构参数名单"（按函数级判），但 `propScopesOf()` 只认 `function Name(` 与
   * `const Name = (`，**不认对象属性里的箭头** ⇒ 那个箭头里的 `draftId` 落在
   * "声明它的函数体"之外 ⇒ 被第 5 条报成自由变量（实测 3 条：draftId/aspectKey/clipId）。
   *
   * 夹具刻意让**同一个名字**同时出现在
   *   · `export function addThing({ draftId, clipId })`（函数解构 ⇒ 进 propNames）
   *   · `read: ({ draftId }) => …` / `write: ({ clipId }) => …`（对象箭头解构）
   * 两处 —— 只补一处（例如只让 propNamesOf 认、没让 propScopesOf 认）过不了这条。
   */
  'handler-arrows.js': [
    "import { useState } from 'react'",
    '',
    '/** 对象属性里的箭头处理函数：解构参数在自己那个箭头里必须算已绑定 */',
    'export function addThing({ draftId, clipId }) {',
    '  return draftId + clipId',
    '}',
    '',
    'export const TOOLS = {',
    '  read: ({ draftId }) => addThing({ draftId, clipId: 1 }),',
    '  write: async ({ clipId }) => {',
    '    return clipId',
    '  },',
    '  plain: (args) => args.draftId',
    '}',
    ''
  ].join('\n')
}

/**
 * 第 3 条（"用了但没导入"）的**干净写法** —— 必须不报。
 *
 * 这一组钉的是 2026-09-24 实测到的一次**假红**：
 *   App.jsx 里早就有一行 `<MediaPanel filterLabel={currentNode?.label} />`，
 *   而 `looks.js` 导出一个同名函数 `filterLabel()`。只要 App.jsx **也**从 looks.js
 *   import 点什么（那天加的是 `effectiveTransitions`），第 3 条立刻把那个**属性名**
 *   报成"漏导入"。
 *
 * 关键点：属性名**不是标识符引用**，它只是恰好同名。所以第 3 条必须和
 * 上面第 3 类自由变量的判据一样，把 `NAME={...}` / `NAME = ...` 这个**位置**排除掉。
 *
 * 为什么不能改成"这个名字是属性名就整体跳过"：那样夹具里的
 * `filterLabel('warm')`（当**值**用）也会一起被放过 —— 那才是真缺陷。
 * 反向由脏夹具 `attr-and-value.jsx` 钉住。
 */
const REACHABLE_CLEAN = {
  'lib.js': `export const effectiveTransitions = (clips) => clips
export const filterLabel = (key) => key
`,
  /**
   * ⚠️ 属性名 `filterLabel` 必须与 `./lib.js` 的导出**同名**，否则这条夹具是空洞的
   * （不同名的话，第 3 条根本不会看它，改不改都绿）。断言里会复查这一点。
   * 另外首行必须是"从 ./lib.js 具名导入" —— 触发第 3 条的前提就是"本文件已 import 该模块"。
   */
  'panel.jsx': `import { effectiveTransitions } from './lib.js'
import MediaPanel from './media.jsx'

export default function Shell({ clips, currentNode }) {
  const marks = effectiveTransitions(clips)
  return <MediaPanel marks={marks} filterLabel={currentNode?.label} />
}
`,
  /** 被导入的组件 —— 顺带钉住"默认导入"也不被误报 */
  'media.jsx': `export default function MediaPanel({ marks, filterLabel }) {
  return <section aria-label={filterLabel}>{(marks || []).length}</section>
}
`
}

/**
 * 六种都**必须被报出来**。
 *
 * `nested-backtick.js` 是新增的那一类：自由变量 `fetchHomeAssets` 落在
 * 「引号串内的反引号 → 下一个反引号」这段区间里。旧版实现会把这段整块吃掉，
 * 于是这个缺陷**一条都不会报**（假绿）—— 这正是夹具要钉住的失败方向。
 *
 * `dangling-setter.js` 是 2026-09-22 新增的第五类：`setRail` 这种名字
 * **在整个仓库里都不存在**，所以第 3 条（只在"本文件已 import 的模块的导出"里找）
 * 结构上就看不到它 —— App.jsx 里那个真实缺陷因此活了下来，直到真实影片 E2E
 * 第一次真的按下「导入」才炸出 ReferenceError。这里把它钉成必须报的第五种。
 *
 * `missing-prop.jsx` 是 2026-09-22 同一天抓到的**第六类**（第 5 条判据）：
 * 组件用了 props 里没解构的 `initialCapability`。App.jsx 一直在传这个 prop，
 * 所以从调用点看"接得好好的"；实际是渲染层里的自由变量 ⇒
 * **AI 面板一挂载就 ReferenceError、整棵 React 树被卸载、界面白屏**，
 * 而构建 0 报错 0 告警。它同时躲过了前四条：没有任何模块导出这个名字（第 3 条够不着），
 * 也不是 `set`+大写（第 4 条够不着）。
 */
const DIRTY = {
  'lib.js': LIB,
  // ← 这就是 2026-09-21 线上构建静默通过的那个缺陷的等价物
  'free-var.js': `import { alpha } from './lib.js'

export function go() {
  return fetchHomeAssets('https://example.com')
}

export const keep = alpha
`,
  'bad-path.js': `import { alpha } from './nope.js'

export const use = alpha
`,
  'bad-name.js': `import { alpha, noSuchExport } from './lib.js'

export const use = alpha + noSuchExport
`,
  'nested-backtick.js': [
    "import { alpha } from './lib.js'",
    '',
    "export const KEYS = { Backquote: '`' }",
    '',
    'export function go2() {',
    "  return fetchHomeAssets('https://example.com')",
    '}',
    '',
    'export const TAG = `F${1}`',
    'export const keep = alpha',
    ''
  ].join('\n'),
  // ← 2026-09-22 真实缺陷（App.jsx 的 setRail）的等价物：名字全局不存在
  'dangling-setter.js': `import { alpha } from './lib.js'

export function importThenSwitch() {
  setRail('media')
  return alpha
}
`,
  // ← 2026-09-22 真实缺陷（AiPanel 的 initialCapability）的等价物：
  //    prop 忘了解构 ⇒ 全库无声明 ⇒ 面板挂载即 ReferenceError
  'missing-prop.jsx': `import { useEffect } from 'react'

export default function Panel({ catalog, onReady }) {
  useEffect(() => {
    if (initialCapability && catalog.length) onReady(initialCapability)
  }, [catalog])
  return <div className="pane" aria-label="panel" />
}
`,
  /**
   * ← 2026-09-23 真实缺陷（SidePanels.jsx 的 onImport）的等价物。
   *
   * 与 missing-prop.jsx 的**差别只在一点**：那个名字在**同一个文件**的另一处
   * 作为"对象解构参数"出现过。原实现用"全库并集"当出生证明，于是这种情况会被洗白；
   * 而 prop 名是全项目复用率最高的一类标识符（`onImport` / `onClick` / `clips`…），
   * 所以"某个 prop 名 A 组件解构了、B 组件没解构"恰恰是**最常见**的形状 ——
   * 全库并集等于把第 5 条对这类缺陷整个关掉。
   *
   * ⚠️ 夹具刻意**不出现** `onImport` 这个**属性名**（即不写 `<X onImport={...} />`）。
   * 属性名位置会被按文件的白名单放过，那是本判据已知的残留缺口（见文件末尾说明），
   * 想钉的正是"解构参数的作用域被错误地提升到了文件级"这一点。
   */
  'prop-used-elsewhere.jsx': `import { useState } from 'react'

function Inner({ onImport }) {
  return <button type="button" onClick={onImport} />
}

export default function Host(props) {
  const [busy, setBusy] = useState(false)
  return <button type="button" onClick={() => setBusy(onImport)} />
}
`,
  /**
   * ← 2026-09-24 新增的**反向控制组**，专治"修假红修过了头"。
   *
   * 修完上面那条假红（属性名不算引用）之后，最省事的坏修法是
   * "这个名字在本文件里当过属性名 ⇒ 整个名字放过"。那样确实不假红了，
   * 但**真缺陷也跟着隐身**：同一个名字当**值**用时是货真价实的"漏导入"，
   * 构建 0 报错、运行时 ReferenceError。
   *
   * 所以这个夹具让同名标识符**两种位置都出现**，且**属性名位置在前**：
   *   · `fetchHomeAssets={marks}`                    ⇒ 属性名，必须**放过**
   *   · `title={fetchHomeAssets('https://…')}`        ⇒ 当值调用，必须**报出来**
   * 位置在前的那个先被扫到 —— 若实现写成"按名字整体跳过"或错误地 `break`，
   * 第 2 处就永远走不到，这条断言立刻红。⇒ 钉住的是"排的是位置不是名字"。
   *
   * ⚠️ 名字必须取自**本夹具目录的 `lib.js` 真实导出**（`alpha` / `fetchHomeAssets` / `config`）。
   * 第一版随手写了 `filterLabel`（那是干净夹具 lib.js 的导出），结果这条夹具报的是
   * "导出的名字不存在" —— 断言照样红，但红在**错的判据**上，等于没测到想测的东西。
   *
   * ⚠️ 而且这个名字**不许在本文件里被声明/解构**（第二版把 `fetchHomeAssets` 写进了
   * `Panel({ marks, fetchHomeAssets })` 的 props ⇒ 拿到文件级出生证明 ⇒ 第 3 条直接跳过
   * 整个名字，夹具退化成 0 处报告、断言又红在错的地方）。属性名不需要声明就能当属性名，
   * 这正是要利用的点：**名字在文件里没有任何出生证明，只有"当属性名"和"当值用"两处出现**。
   */
  'attr-and-value.jsx': `import { alpha } from './lib.js'

function Panel({ marks }) {
  return <section data-label={marks} />
}

export default function Shell({ clips }) {
  const marks = alpha
  return (
    <Panel
      marks={marks}
      fetchHomeAssets={marks}
      title={fetchHomeAssets('https://example.com')}
    />
  )
}
`,
  /**
   * ← 2026-10-10 新增的**反向控制组**，专治"修对象属性箭头那条假红修过了头"。
   *
   * 修假红的省事坏修法有两种，都必须被这条钉住：
   *   · 把对象属性箭头的解构参数**整体写进文件级白名单**（最省事）⇒ 该箭头里
   *     真正的自由变量一起隐身；
   *   · 让 `propNamesOf` 认这种写法、却让 `propScopesOf` 算错作用域区间（例如
   *     不要求收尾 `=>`，把 `key: (expr)` 也当函数头）⇒ 区间吞掉后面代码。
   *
   * 夹具里同一支箭头**同时**含：
   *   · `draftId` —— 该箭头的解构参数 ⇒ 必须**放过**；
   *   · `missingThing` —— 全无出生证明 ⇒ 必须**报出来**（`自由变量`）。
   * 两者位置分开，缺任一前提这条就退化：没有 `draftId` 则测不到"作用域有没有被算对"，
   * 没有 `missingThing` 则测不到"有没有把真缺陷一起静音"。
   */
  'prop-arrow-freevar.js': `export const api = {
  run: ({ draftId }) => draftId + missingThing(1),
  stop: ({ clipId }) => clipId
}
`
}

function writeFixture(dir, files) {
  const full = path.join(tmp, dir)
  fs.mkdirSync(full, { recursive: true })
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(full, name), body, 'utf8')
  return full
}

function run(dir) {
  // 走 spawnCapture：进程内 spawn node 时 stdio 管道会 EBUSY（见 tools/spawn-capture.mjs）
  const r = spawnCapture(process.execPath, [CHECKER, dir], { cwd: ROOT })
  return { code: r.status, out: r.stdout || '' }
}

const cleanDir = writeFixture('clean', CLEAN)
const setterCleanDir = writeFixture('setter-clean', SETTER_CLEAN)
const freeformCleanDir = writeFixture('freeform-clean', FREEFORM_CLEAN)
const reachableCleanDir = writeFixture('reachable-clean', REACHABLE_CLEAN)
const dirtyDir = writeFixture('dirty', DIRTY)

/* ---------------------------------------------------- 干净夹具：必须全绿 */

const clean = run(cleanDir)
check('干净夹具退出码为 0', clean.code === 0, `实际 ${clean.code}\n${clean.out}`)
check('干净夹具出现 IMPORTS_OK', /IMPORTS_OK/.test(clean.out), clean.out)
check('干净夹具没有被判为失败', !/IMPORTS_FAILED/.test(clean.out), clean.out)
check('默认导入与具名导入混写未被误报', !/mixed\.js/.test(clean.out), clean.out)
check('参数解构未被误报（ok / value / a / limit）', !/params\.js/.test(clean.out), clean.out)
check('export function 自身声明未被误报', !/parseNotify|pollUntil/.test(clean.out), clean.out)
check(
  '串里的反引号/另一种引号未把后续 export 吃掉（comboOf 必须被看到）',
  !/quotes\.js/.test(clean.out),
  clean.out
)

/* ---------------------------------------- 悬空 setter 判据的干净写法：必须不误报 */

const setterClean = run(setterCleanDir)
check('合法 setter 写法退出码为 0', setterClean.code === 0, `实际 ${setterClean.code}\n${setterClean.out}`)
check(
  'useState 解构 / context 解构 / 参数传入 / setTimeout / 成员方法 / 对象键都不算未定义',
  /IMPORTS_OK/.test(setterClean.out) && !setterClean.out.split('\n').some((l) => l.startsWith('BAD ')),
  setterClean.out
)

/* -------------------------------- 第 5 条（自由变量）的开放集合：必须不误报 */

const freeformClean = run(freeformCleanDir)
check('自由变量判据的开放集合夹具退出码为 0', freeformClean.code === 0, `实际 ${freeformClean.code}\n${freeformClean.out}`)
check(
  'JSX 标签/属性（含无值布尔属性 muted、连字符名 data-wb-tool）、JSX 文案、正则字面量内容都不算自由变量',
  /IMPORTS_OK/.test(freeformClean.out) && !freeformClean.out.split('\n').some((l) => l.startsWith('BAD ')),
  freeformClean.out
)
/* 「夹具是不是真的有对抗性」本身也要钉住：否则把 prose.jsx 换成空文件，
 * 上面那条断言照样全绿 —— 那就成了空洞自证。 */
check(
  '文案夹具确实含对抗形状（中文句里的拉丁词 / 文案与 {} 交错 / 单位后缀）',
  /media 权限/.test(FREEFORM_CLEAN['prose.jsx']) &&
    /\}px · 默认 \{[^}]*\}s/.test(FREEFORM_CLEAN['prose.jsx']) &&
    /src\/shared\/looks\.json/.test(FREEFORM_CLEAN['prose.jsx']) &&
    /\}f</.test(FREEFORM_CLEAN['prose.jsx']),
  '夹具被弱化了：去掉了中文文案里的拉丁词或单位后缀，这条断言会失真'
)
/* 解构里嵌套花括号之后的名字（真实缺陷：SidePanels 的 enhanceGroup） */
check(
  '解构项里嵌套花括号 / 嵌套数组之后的名字未被误报（enhanceGroup / grid / onImport）',
  !/props-destructure\.jsx/.test(freeformClean.out),
  freeformClean.out
)
check(
  '解构夹具确实含嵌套花括号与嵌套数组（否则上一条是空洞自证）',
  /catalog = \{ models: \[\] \}/.test(FREEFORM_CLEAN['props-destructure.jsx']) &&
    /grid = \[\[1, 2\], \[3, 4\]\]/.test(FREEFORM_CLEAN['props-destructure.jsx']) &&
    /enhanceGroup/.test(FREEFORM_CLEAN['props-destructure.jsx']),
  '夹具被弱化了：嵌套项或"嵌套项之后的名字"被删掉，上一条断言会失真'
)

/* 对象属性里的箭头处理函数（`handler: ({ a }) => …`）的解构参数必须算已绑定（2026-10-10） */
check(
  '对象属性箭头处理函数的解构参数未被误报（handler-arrows.js）',
  !/handler-arrows\.js/.test(freeformClean.out),
  freeformClean.out
)
check(
  '该夹具确实含对抗形状（同一名字既在函数解构、又在对象箭头里解构并使用）',
  /function addThing\(\{ draftId, clipId \}\)/.test(FREEFORM_CLEAN['handler-arrows.js']) &&
    /read: \(\{ draftId \}\) => addThing\(/.test(FREEFORM_CLEAN['handler-arrows.js']) &&
    /write: async \(\{ clipId \}\) =>/.test(FREEFORM_CLEAN['handler-arrows.js']),
  '夹具被弱化了：少了「同名两处解构」或「对象箭头里使用」，这条断言会失真'
)

/* ------------------ 第 3 条（用了但没导入）的假红：与导出同名的 JSX 属性名必须放过 */

const reachableClean = run(reachableCleanDir)
check('与导出同名的 JSX 属性名夹具退出码为 0', reachableClean.code === 0, `实际 ${reachableClean.code}\n${reachableClean.out}`)
check(
  '与已导入模块的导出同名、但只出现在「属性名位置」的标识符未被误报（filterLabel）',
  /IMPORTS_OK/.test(reachableClean.out) && !reachableClean.out.split('\n').some((l) => l.startsWith('BAD ')),
  reachableClean.out
)
/* 非空洞：属性名必须真的与 ./lib.js 的导出同名，且该文件真的从 ./lib.js 具名导入过。
 * 少任何一个前提，第 3 条都不会看这个属性名 —— 断言就会退化成"改不改都绿"。 */
check(
  '该夹具确实含对抗形状（同名的导出 + 具名导入 + 属性名出现在前）',
  /export const filterLabel/.test(REACHABLE_CLEAN['lib.js']) &&
    /import \{ effectiveTransitions \} from '\.\/lib\.js'/.test(REACHABLE_CLEAN['panel.jsx']) &&
    /filterLabel=\{currentNode\?\.label\}/.test(REACHABLE_CLEAN['panel.jsx']),
  '夹具被弱化了：导出名与属性名不同名、或该文件不再从 ./lib.js 导入，这条断言会失真'
)

/* ---------------------------------------------------- 脏夹具：必须逐条报出 */

const dirty = run(dirtyDir)
check('脏夹具退出码为 1', dirty.code === 1, `实际 ${dirty.code}\n${dirty.out}`)
check('脏夹具出现 IMPORTS_FAILED', /IMPORTS_FAILED/.test(dirty.out), dirty.out)
check('报出「路径无法解析」', /路径无法解析[\s\S]*bad-path\.js/.test(dirty.out), dirty.out)
check('报出「导出的名字不存在」', /导出的名字不存在[\s\S]*bad-name\.js/.test(dirty.out), dirty.out)
check('报出缺失的导出名 noSuchExport', /noSuchExport/.test(dirty.out), dirty.out)
check('报出「使用了但未导入」', /使用了但未导入/.test(dirty.out), dirty.out)
check('精确定位自由变量 fetchHomeAssets', /使用了但未导入[\s\S]*free-var\.js[\s\S]*fetchHomeAssets/.test(dirty.out), dirty.out)
check(
  '落在"串扰吃掉区间"里的自由变量同样被报出（旧实现漏报）',
  /使用了但未导入[\s\S]*nested-backtick\.js[\s\S]*fetchHomeAssets/.test(dirty.out),
  dirty.out
)
check(
  '报出悬空的状态 setter（全局都不存在的名字，第 3 条结构上看不到）',
  /悬空setter[\s\S]*dangling-setter\.js[\s\S]*setRail/.test(dirty.out),
  dirty.out
)
check(
  '报出自由变量（组件 prop 忘了解构，第 3/4 条都够不着）',
  /自由变量[\s\S]*missing-prop\.jsx[\s\S]*initialCapability/.test(dirty.out),
  dirty.out
)
check(
  '报出自由变量（同名解构参数就在同文件另一处，作用域不许被提升到文件级）',
  /自由变量[\s\S]*prop-used-elsewhere\.jsx[\s\S]*onImport/.test(dirty.out),
  dirty.out
)
/* 反向控制组：同一个名字在**属性名位置**放过、在**值位置**必须照报 ——
 * 证明修的是"位置"而不是"名字"（修过头会让真缺陷一起隐身）。 */
check(
  '同名标识符在「属性名」位置放过、在「当值调用」位置照报（attr-and-value.jsx，属性名在前）',
  /使用了但未导入[\s\S]*attr-and-value\.jsx[\s\S]*fetchHomeAssets/.test(dirty.out),
  dirty.out
)
/* 反向控制组（2026-10-10）：修"对象属性箭头解构参数"那条假红时，不许把该箭头里的**真自由变量**
 * 一起静音。同一条箭头里 `draftId`（解构参数）必须放过、`missingThing`（无出生证明）必须报出。 */
check(
  '对象属性箭头里的真自由变量仍被报出（prop-arrow-freevar.js，反向控制组）',
  /自由变量[\s\S]*prop-arrow-freevar\.js[\s\S]*missingThing/.test(dirty.out),
  dirty.out
)
check(
  '该脏夹具确实含对抗形状（同一支箭头既有解构参数、又有自由变量）',
  /run: \(\{ draftId \}\) => draftId \+ missingThing/.test(DIRTY['prop-arrow-freevar.js']),
  '夹具被弱化了：解构参数或自由变量被删掉，上一条断言会失真'
)

/**
 * 逐行判定，且**不能**用「行里出现 /lib.js」来判断文件名 ——
 * 导入说明符本身写作 `./lib.js`，一样会被匹配到，实测连着写错两版。
 * 报告行的格式固定为 `BAD  <消息>  <被检查文件的绝对路径>  [-> <spec>]  [:: <名字>]`，
 * 消息里不含空格，所以第三段一定就是文件路径。
 */
const badLines = dirty.out.split('\n').filter((line) => line.startsWith('BAD '))
const badFiles = badLines.map((line) => path.basename(line.split(/\s+/)[2] || '')).sort()
/* 7 → 8（2026-09-24）：新增 attr-and-value.jsx（属性名放过 / 当值照报的反向控制组）。
 * ⚠️ 它**只**产出一行（`使用了但未导入`）—— 没有伴生的 `自由变量` 行，因为路径属性名
 * 白名单把该名字在第 1 条判据里整体放过了（那是已知的残留缺口）。
 * 8 → 9（2026-10-10）：新增 prop-arrow-freevar.js（对象属性箭头解构的反向控制组），
 * 产出一行 `自由变量`（missingThing）。
 * 改这个数字前先确认"多出来的那一行红在对的判据上"，别为了让总数对上而放宽断言。 */
check('脏夹具恰好报出 9 处（不多不少）', badLines.length === 9, `实际 ${badLines.length} 处\n${dirty.out}`)
check(
  '报出的文件恰好是那九个，且未牵连 dirty/lib.js',
  badFiles.join(',') ===
    'attr-and-value.jsx,bad-name.js,bad-path.js,dangling-setter.js,free-var.js,missing-prop.jsx,nested-backtick.js,prop-arrow-freevar.js,prop-used-elsewhere.jsx',
  badFiles.join(',')
)

fs.rmSync(tmp, { recursive: true, force: true })

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\n自证：通过 ${passed} 项 / 失败 ${failed} 项`)
/**
 * 设 `exitCode` 让 Node 自然退出，而不是 `process.exit()`：
 * 后者在 stdout 被重定向到管道/文件时存在"结论行还没刷出去就退出"的风险，
 * 而「自证：通过 N 项」正是 verify 用来数断言的唯一依据，丢了会变成假红。
 * 本脚本没有需要收尾的句柄，自然退出最干净。
 */
if (failed) {
  console.log('IMPORTS_SELFTEST_FAILED')
  process.exitCode = 1
} else {
  console.log('IMPORTS_SELFTEST_PASSED')
  process.exitCode = 0
}
