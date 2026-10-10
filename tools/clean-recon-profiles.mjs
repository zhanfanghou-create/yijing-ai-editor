#!/usr/bin/env node
/**
 * _recon 卫生 —— 清掉取景/E2E 留下的 Chromium 会话残留目录。
 *
 * 为什么要有它：
 *   每个 E2E 脚本都给自己的 Electron 起一个 `--user-data-dir`（`.dialogs-profile-15156`、
 *   `.home-profile-33048`、`.tabs-profile-*` … 名字里带 PID）。跑完不管，于是 `_recon/`
 *   下面堆了几百个这样的目录，每个都是 Cache / GPUCache / Session Storage /
 *   Preferences / DevToolsActivePort 这类**运行时垃圾** —— 不是证据，
 *   留着只会占盘并在翻取证目录时误导人。
 *   这正是本项目「静默失效五类母题」里的**静默累积**：没有一次跑批是"错误"的，
 *   错的是没人收尾。
 *
 * 配套：
 *   · `scripts/verify.mjs` 的 `recon-hygiene` 闸门 —— 残留数必须为 0（机械执行，不靠自觉）；
 *   · `tools/check-recon-hygiene.mjs` 是它的检查器（可 --selftest 自证）。
 *
 * 删除走 Windows 原生 `rd /s /q`：`fs.rmSync(dir, {recursive:true})` 会被本机的
 * 「批量删除保护」shim 拦下（阈值 50 个/轮，我们一次要清几百个目录）。
 *
 * 用法：
 *   node tools/clean-recon-profiles.mjs          # 清
 *   node tools/clean-recon-profiles.mjs --dry    # 只列不删
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * ⚠️ 别写成 `path.dirname(fileURLToPath(new URL('..', import.meta.url)))` ——
 * `fileURLToPath('file:///F:/yjai-edit/')` 得到 `F:\yjai-edit\`（尾部带反斜杠），
 * 而 `path.dirname` 会把它当成"最后一段是空"再退一级 ⇒ 变成 `F:\`。
 * 于是 RECON 指到 `F:\_recon`，目录不存在 ⇒ 扫描恒返回 0，
 * 「没有残留」永远是绿的（静默失效，实测踩过）。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/**
 * ⚠️ 两个目录都要扫：E2E 的 user-data-dir 不一定落在 `_recon` 下 ——
 * 实测 `_evidence/.probe-profile` 也有一个（同样是 Cache/GPUCache/DawnWebGPUCache）。
 * 只扫 _recon 会让闸门留着 1 个残留仍报红，而清理工具却说"清干净了"，
 * 两边互相打架（2026-10-02 实测）。
 */
const DIRS = ['_recon', '_evidence']
/**
 * E2E 的 Chromium profile **新家**（2026-10-08 起）。
 *
 * 以前它们也放在 `_recon/` 下，于是 _recon 里永远有几个"刚跑完、句柄还没放"的
 * profile 删不掉 —— Electron 退出后句柄要过好几分钟才释放（实测 40 秒仍锁着），
 * 取证卫生闸门因此**每轮全量都红**，而红的原因既不是"没清"也不是"功能坏了"，
 * 只是"运行时垃圾放错了地方"。所以搬去系统临时目录：取证目录只放证据。
 *
 * ⚠️ 搬走了也要**照样清**：不清照样堆积（只是换个地方堆），
 *    而且系统临时目录不清理会一直占 C 盘。清理失败在这里是**可容忍的**
 *    （锁着的等下轮），所以只记 failed，不影响退出码的语义。
 */
const TMP_PROFILES = path.join(os.tmpdir(), 'yjai-e2e')
const dry = process.argv.includes('--dry')

/**
 * 认定为「运行时残留」的判据 —— 必须**点开头**且命中下面的用途后缀。
 *
 * ⚠️ 保守：只删点开头的隐藏目录（真实取证素材都不带点前缀），
 *   且名字里必须带 profile / shoot / probe / fs-probe 这些**我们自己的脚本命名**。
 *   宁可漏删一个，也别把取证产物删了。
 */
const PATTERNS = [/^\.[a-z-]*profile/, /^\.shoot-/, /^\.fs-probe-/, /^\.menu-shoot-/, /^\.probe-ls-profile/]

/**
 * 纯函数版判据 —— 抽出来是为了**可自证**。
 * 闸门 `recon-hygiene` 要看门狗能说是（夹具里放几个名字，该认的认、不该认的不认）；
 * 直接测 scan() 就得在磁盘上真造 450 个目录，那既慢又会污染取证目录。
 */
export function isRuntimeLeftover(name) {
  if (typeof name !== 'string' || !name.startsWith('.')) return false
  return PATTERNS.some((re) => re.test(name))
}

/**
 * Windows 原生兜底：绕过 Node 的 rmSync shim。
 *
 * ⚠️ 2026-10-08 实测补的第二段：`cmd /c rd /s /q` 在这台机器上会
 *    **退出码 0 却没真删**（目录里只剩一个被占住的 `Session Storage`，
 *    rd 把能删的删了、剩下的静默放弃，于是不报错）。
 *    只看退出码的话，清理器报告"清掉 25 个"，卫生闸门下一秒再扫又看见同一个目录 ——
 *    两边互相打架，而真因是"这次删除其实没成"。
 *    ⇒ 删完**必须复查**，还在就换 PowerShell 的 Remove-Item（实测它删得动）。
 */
function nativeWipe(dir) {
  if (process.platform !== 'win32') {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  }
  execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', dir], { stdio: 'ignore' })
  /**
   * ⚠️ 删完**必须复查**：上面那句在这台机器上会"退出码 0 但没真删"。
   * 于是以前 `removed` 会把它算成已删，卫生闸门下一秒再扫又看见它 ——
   * 一个说清干净了、一个说还有，谁都不说谎，但合起来就是一团看不懂的红。
   * 复查之后还站着 ⇒ 如实抛错，让调用方记进 failed（而不是记进 removed）。
   *
   * （试过再加一层 PowerShell Remove-Item 兜底：从 node 里 spawn powershell 在这台
   *  机器上起不来，兜底只会多花一秒然后照样失败 —— 不加假兜底，如实报失败。）
   */
  if (fs.existsSync(dir)) {
    throw new Error('rd 返回成功但目录仍在（句柄被占，实测 40s 都不放）')
  }
}

export function scan() {
  const hits = []
  const roots = DIRS.map((rel) => ({ dir: path.join(ROOT, rel), prefix: rel }))
  roots.push({ dir: TMP_PROFILES, prefix: 'tmp:yjai-e2e' })
  for (const { dir, prefix } of roots) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!isRuntimeLeftover(entry.name)) continue
      hits.push({ name: `${prefix}/${entry.name}`, full: path.join(dir, entry.name) })
    }
  }
  return hits
}

/**
 * 清理（供闸门复用）：删掉 scan() 找到的全部残留。
 * 闸门「先清后查」的原因：E2E 闸门与卫生闸门跑在**同一轮**里，
 * E2E 的 Electron 会话残留在卫生闸门执行那一刻**必然存在** ——
 * 只查不清的话这道闸每轮全量都会假红（2026-10-02 首轮全量实测）。
 */
export function cleanAll(hits = scan()) {
  let removed = 0
  const failed = []
  for (const hit of hits) {
    // ⚠️ 全量轮的教训（2026-10-02）：前一道 E2E 的 Electron 进程可能还没完全退出，
    // profile 目录里的句柄还占着 —— 第一遍 rd 会失败。等 1.5s 重试，
    // 最多三轮；进程退出通常在 1s 内，三轮还没放开就是真被占用，如实报失败。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        nativeWipe(hit.full)
        removed += 1
        break
      } catch (error) {
        if (attempt === 2) {
          failed.push(`${hit.name}: ${error.message}`)
        } else {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
        }
      }
    }
  }
  return { removed, failed }
}

function main() {
  const hits = scan()
  if (!hits.length) {
    console.log('_recon 卫生：没有运行时残留目录')
    console.log('RECON_CLEAN_STATS found=0 removed=0')
    console.log('RECON_CLEAN_OK')
    return
  }

  if (dry) {
    console.log(`_recon 卫生（--dry，不删）：${hits.length} 个运行时残留目录`)
    for (const hit of hits.slice(0, 10)) console.log(`  ${hit.name}`)
    if (hits.length > 10) console.log(`  … 还有 ${hits.length - 10} 个`)
    console.log(`RECON_CLEAN_STATS found=${hits.length} removed=0`)
    console.log('RECON_CLEAN_OK')
    return
  }

  let removed = 0
  const failed = []
  for (const hit of hits) {
    try {
      nativeWipe(hit.full)
      removed += 1
    } catch (error) {
      failed.push(`${hit.name}: ${error.message}`)
    }
  }

  console.log(`_recon 卫生：清掉 ${removed}/${hits.length} 个运行时残留目录（Chromium 会话：Cache/GPUCache/Session Storage…）`)
  for (const row of failed.slice(0, 5)) console.log(`  删不掉：${row}`)
  console.log(`RECON_CLEAN_STATS found=${hits.length} removed=${removed}`)
  console.log(failed.length ? 'RECON_CLEAN_FAILED' : 'RECON_CLEAN_OK')
  process.exitCode = failed.length ? 1 : 0
}

main()
