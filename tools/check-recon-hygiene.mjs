#!/usr/bin/env node
/**
 * 「取证目录卫生」的看门狗 —— _recon / _evidence 下不许堆积运行时残留。
 *
 * 为什么需要它：2026-10-02 PM 审查实测 `_recon/` 有 **450 个** 点开头的运行时目录
 *   （`.dialogs-profile-15156` / `.home-profile-*` / `.tabs-profile-*` … 名字里带 PID），
 *   每个都是 Electron/Chromium 的 Cache / GPUCache / Session Storage / Preferences。
 *
 * 为什么之前没人管：这是本项目「静默失效五类母题」里的**静默累积** ——
 *   没有一次跑批是"错误"的（E2E 全都 PASS），错的是没人收尾；
 *   而"目录多了"这件事**不会让任何一道闸门变红**，直到盘被吃掉 3.8GB。
 *   人也看不出来：翻 _recon 找证据时它们只是"多了几百个看不懂的目录"。
 *
 * 判据（保守，宁可漏删不误删证据）：
 *   · 只认**点开头**的隐藏目录（真实取证素材都不带点前缀）；
 *   · 且名字必须命中我们自己脚本的命名：profile / shoot / fs-probe / menu-shoot；
 *   · 判据是与 `tools/clean-recon-profiles.mjs` **共用同一份** `isRuntimeLeftover()`，
 *     不是抄一份 —— 抄的那一刻两份定义就开始各自演化，清得掉却判不出来。
 *
 * ⚠️ 2026-10-08 起，E2E 的 Chromium profile **不再放** `_recon`：
 *   Electron 退出后句柄要过好几分钟才释放（实测 40 秒仍锁着），于是"刚跑完的
 *   profile"在这道闸执行时**必然删不掉** —— 每轮全量都红，而真因既不是没清、
 *   也不是功能坏了，只是运行时垃圾放错了地方。现在它们一律去系统临时目录
 *   （`os.tmpdir()/yjai-e2e/`），取证目录只放证据；临时目录那边的清理由
 *   `clean-recon-profiles.mjs` 顺带做（那里锁着是可容忍的，等下轮）。
 *   所以这道闸现在的语义是：**取证目录里不许出现运行时垃圾**（谁再把 profile
 *   写回 _recon，这里立刻红）。
 *
 * 断言总数恒为 5（见 TOTAL_ASSERTIONS）。
 * 用法：
 *   node tools/check-recon-hygiene.mjs            # 校验（闸门用）
 *   node tools/check-recon-hygiene.mjs --selftest # 只跑检测器自证
 */
import fs from 'node:fs'
import path from 'node:path'
import { cleanAll, isRuntimeLeftover, scan } from './clean-recon-profiles.mjs'

/** 同步睡眠（这个脚本是纯同步流程，不引入 await） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const DIRS = ['_recon', '_evidence']

/** 断言总数：闸门用它钉死"断言有没有被悄悄删掉" */
export const TOTAL_ASSERTIONS = 5

function scanDirs() {
  const hits = []
  let scanned = 0
  for (const rel of DIRS) {
    const dir = path.join(ROOT, rel)
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      scanned += 1
      if (!isRuntimeLeftover(entry.name)) continue
      hits.push(`${rel}/${entry.name}`)
    }
  }
  return { hits, scanned }
}

/* ------------------------------------------------------------------ 夹具 */

/**
 * 自证夹具：该认的（4 个真实残留命名）与不该认的（4 个**长得像但其实是证据**的）。
 * 后半段是防「为了清零而把判据放宽到什么都删」—— 那会连取证素材一起删掉。
 */
const SHOULD_MATCH = [
  '.dialogs-profile-15156',
  '.home-profile-33048',
  '.tabs-profile-992',
  '.shoot-composite-14868'
]
const SHOULD_NOT_MATCH = [
  'desktop', // 真实取证目录（截图产物）
  'ref-ui', // 参考界面截图
  '.git', // 隐藏，但不是我们的残留
  '01-home.png' // 文件（不是目录，判据只认目录）
]

/* ------------------------------------------------------------------ 主流程 */

/**
 * 一个残留目录**为什么还在** —— 分得清"我们没清"和"本机不让删"。
 *
 * 2026-10-08 实测：这台机器把 Node 的 `fs.rmSync/unlinkSync` 换成了走**回收站**的实现
 * （`fs.rmSync.toString()` 是 `wrappedRmSync`），对 `_recon/.draft-profile` 这类
 * 隐藏目录会抛 `[safe-delete] 操作失败 … Error during a 'trash' operation`。
 * 于是目录**真的删不掉**，但原因与项目代码、与"有没有人收尾"**毫无关系** ——
 * 不分清楚的话，这道闸会永远红，而红的原因没人能改，最后只能被当成噪音忽略掉。
 *
 * ⇒ 被回收站拦下的：单列出来点名，记 SKIP（不通过也不失败，附真因）；
 *    其它（压根没删 / 删了但还在且没被拦）：该红就红。
 */
function classifyStuck(full) {
  try {
    fs.rmSync(full, { recursive: true, force: true })
    return fs.existsSync(full) ? 'stuck-quiet' : 'gone'
  } catch (error) {
    return /safe-delete/.test(String(error?.message || '')) ? 'env-blocked' : 'stuck-other'
  }
}

function main() {
  const selftest = process.argv.includes('--selftest')
  let pass = 0
  let fail = 0
  let skip = 0
  const check = (name, ok, detail = '') => {
    if (ok) pass += 1
    else fail += 1
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
  }

  if (!selftest) {
    // 先清后查：E2E 与本闸门跑在同一轮，E2E 的会话残留在这一刻必然存在。
    // 闸门的语义因此是「取证目录**必须保持**干净，脏了就当场清掉」—— 自愈，而不是报给人看。
    // （只查不清的首轮全量实测：4 个 E2E 刚跑完，本闸门必然假红。）
    let autoCleaned = 0
    /**
     * ⚠️ 必须**多轮**清 + 等，不能只清一遍就判。
     *
     * 2026-10-08 实录：一键验证第 35 道在这里红了，日志是"清掉 6 个、再扫还在 6 个"。
     * 看起来像"删除失败（文件被占）"，但同一批目录**几分钟后自己就没了** ——
     * 这台机器上删目录是**延迟生效**的（索引/杀软句柄晚一步放），
     * 清一遍立刻复查必然假红，而这道假红会让人以为"E2E 又没关干净"，往错的地方查。
     * ⇒ 清完等一下再看，最多 5 轮；5 轮之后还在，那才是真删不掉。
     */
    let hits = []
    for (let round = 0; round < 5; round += 1) {
      const found = scan()
      if (!found.length) {
        hits = []
        break
      }
      autoCleaned += cleanAll(found).removed
      hits = scanDirs().hits
      if (!hits.length) break
      sleepSync(700)
    }
    const { scanned } = scanDirs()
    console.log('取证目录卫生（_recon / _evidence：运行时残留必须为 0）\n')
    if (autoCleaned) console.log(`  自动清掉本轮 E2E 留下的 ${autoCleaned} 个会话残留（先清后查，自愈）\n`)

    /* 剩下的逐个问一句"你为什么还在"：被本机回收站拦下的单列，其余的才是真问题 */
    const stuck = hits.map((hit) => ({ hit, kind: classifyStuck(path.join(ROOT, ...hit.split('/'))) }))
    const envBlocked = stuck.filter((s) => s.kind === 'env-blocked')
    const realStuck = stuck.filter((s) => s.kind !== 'env-blocked')

    if (realStuck.length) {
      console.log(`  ✗ 运行时残留（${realStuck.length} 个，多轮自愈后仍存在 = 真删不掉）：`)
      for (const s of realStuck.slice(0, 10)) console.log(`    ${s.hit}（${s.kind}）`)
      if (realStuck.length > 10) console.log(`    … 还有 ${realStuck.length - 10} 个`)
      console.log('')
    }
    if (envBlocked.length) {
      console.log(
        `  - 有 ${envBlocked.length} 个残留是**本机回收站实现拦着不让删**（不是没清，也不是代码问题）：`
      )
      for (const s of envBlocked.slice(0, 10)) console.log(`    ${s.hit}`)
      console.log('    判据：fs.rmSync 抛 [safe-delete] … Error during a trash operation。')
      console.log('    这类目录在句柄释放后会自己消失；记为「跳过」而不是失败，免得这道闸被当噪音。\n')
    }
    /* ⚠️ 计数必须让「总数恒为 5」成立：env-blocked 那一种是 **SKIP**，不是 PASS。
       算成 PASS 的话总数会变成 6，而 verify.mjs 钉的是 5 ⇒ 直接"断言数不符"变红，
       红的原因却是**这道闸自己数错了**，与被测的东西无关。 */
    const LABEL1 = '1. _recon / _evidence 下没有运行时残留目录'
    if (realStuck.length) {
      check(LABEL1, false, `${realStuck.length} 个（多轮清理失败，需人工处理）`)
    } else if (envBlocked.length) {
      skip += 1
      console.log(`  --   ${LABEL1}  —— [SKIP] 仅剩本机回收站拦着不让删的 ${envBlocked.length} 个，见上`)
    } else {
      check(LABEL1, true, '0 个')
    }
    check('2. 扫描覆盖面非空（取证目录确实被扫到了，不是空转）', scanned > 0, `扫到 ${scanned} 个目录`)
  }

  const matched = SHOULD_MATCH.filter(isRuntimeLeftover)
  const wronglyMatched = SHOULD_NOT_MATCH.filter(isRuntimeLeftover)
  check(
    `${selftest ? '1' : '3'}. 自证：4 个真实残留命名全被认出来（少认 = 漏删）`,
    matched.length === SHOULD_MATCH.length,
    `认出 ${matched.length}/${SHOULD_MATCH.length}`
  )
  check(
    `${selftest ? '2' : '4'}. 自证：取证目录 / 隐藏目录 / 文件一个都没被误认（多认 = 误删证据）`,
    wronglyMatched.length === 0,
    wronglyMatched.length ? `误认：${wronglyMatched.join(' ')}` : '0 个'
  )
  check(
    `${selftest ? '3' : '5'}. 自证：判据与 clean-recon-profiles.mjs 是同一份（不是抄本）`,
    typeof isRuntimeLeftover === 'function' && isRuntimeLeftover('.x-profile-1') && !isRuntimeLeftover('desktop'),
    '共用 isRuntimeLeftover()'
  )

  console.log(`\nRECON_HYGIENE_STATS ok=${pass} total=${pass + fail + skip} fail=${fail} skip=${skip}`)
  console.log(fail ? 'RECON_HYGIENE_FAILED' : 'RECON_HYGIENE_OK')
  process.exitCode = fail ? 1 : 0
}

main()
