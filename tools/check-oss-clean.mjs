#!/usr/bin/env node
/**
 * 开源洁净检查 —— 把「仓库里不能有第三方的东西」这件事**机械钉住**。
 *
 * 查三类（都是肉眼扫一遍会漏的）：
 *   ① 第三方品牌名 / 厂商标识（含产品名、厂商域名、内部代号）；
 *   ② 生产服务地址与账号体系残留（登录、令牌、支付、云端接口前缀）；
 *   ③ 密钥与生产域名。
 *
 * 为什么必须是闸门：这类东西**不会让构建变红**。一个写在注释里的产品名、
 * 一个留在常量里的生产域名，都不报错、不影响运行，只有发布那一刻才变成问题。
 * 所以要靠一条每次都跑、命中就红的规则，而不是靠"记得别写"。
 *
 * 用法：
 *   node tools/check-oss-clean.mjs
 *   node tools/check-oss-clean.mjs --selftest   # 自检：造一份脏样本，必须被抓出来
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** 扫描范围：随仓库一起发布的东西（_evidence / _recon 是取证与过程产物，不发布） */
const SCAN_DIRS = [
  'packages/desktop/src',
  'packages/installer',
  'tools',
  'scripts'
]
const SCAN_FILES = ['package.json', 'README.md', 'LICENSE']

/**
 * ⚠️ `py` 必须在里面：素材生成脚本（gen-own-art.py / gen-material-thumbs.py）是 Python，
 * 第一版漏了它 —— 于是那两个脚本里写着的第三方模型名**一次都没被扫过**，
 * 闸门照样 36/36 绿。扫描范围少一种扩展名 = 这道闸在这一类文件上完全失效。
 */
const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|json|css|html|md|txt|svg|yml|yaml|qml|py)$/i

/** 禁用词：命中即红。value 是给人的说明（为什么它不能出现） */
const FORBIDDEN = [
  /* ① 第三方品牌 / 厂商 / 素材服务 */
  ['hitpaw', '第三方产品名'],
  ['edimakor', '第三方产品名'],
  ['jianyingpro', '第三方产品名'],
  ['capcut', '第三方产品名'],
  ['剪映', '第三方产品名'],
  ['giphy', '第三方素材服务'],
  ['volcengine', '第三方厂商'],
  ['volces.com', '第三方厂商域名'],
  ['openai', '第三方厂商'],
  ['dashscope', '第三方厂商'],
  ['heygen', '第三方模型 / 厂商'],
  ['hailuo', '第三方模型名'],
  ['mureka', '第三方模型名'],
  ['runway', '第三方模型名'],
  ['kling', '第三方模型名'],
  ['elevenlabs', '第三方厂商'],
  /* ② 生产服务与云端接缝 */
  ['yjai.top', '生产服务地址'],
  ['/v1/ai/', '云端接口前缀'],
  ['apikey', '密钥字段'],
  ['api_key', '密钥字段'],
  ['jwt_secret', '密钥字段'],
  ['secret_key_hex', '密钥字段'],
  /* ③ 支付 / 账号 */
  ['wechat_pay', '支付通道'],
  ['alipay', '支付通道'],
  ['saveToken', '账号体系残留'],
  ['loadToken', '账号体系残留'],
  /* ④ 中文同义：这版要纯开源，登录 / 购买 / 充值 / AI 生成 / 下载内容都不存在。
        ⚠️ 只收"这个功能存在过"才写得出来的词 —— 像「注册」这种（协议处理器也要注册）
        一律不收，否则假红会训练人无脑忽略这道闸门。 */
  ['充值', '充值入口'],
  ['购买', '购买入口'],
  /* 「升级安装」是安装器的正当说法（覆盖安装），不是购买 ⇒ 后一个字是「安」时不算 */
  ['升级', '购买 / 升级入口', { notAfter: '安' }],
  ['会员', '会员体系'],
  ['积分', '积分体系'],
  ['余额', '余额 / 点数'],
  /* 「节点数」里也含"点数" ⇒ 必须排除，否则左栏检查器满屏假红 */
  ['点数', '点数体系', { notBefore: '节' }],
  ['收银', '支付收银台'],
  ['登录', '账号体系残留'],
  ['注册账号', '账号体系残留'],
  ['云端', '云端服务'],
  ['AI 生成', '云端生成入口'],
  ['生成任务', '云端生成入口'],
  ['能力目录', '云端能力目录']
]

/** 本文件必须写下全部禁用词才能描述规则，整份跳过 */
const SKIP_FILES = new Set(['check-oss-clean.mjs'])

const FORBIDDEN_WORDS = new Set(FORBIDDEN.map(([word]) => word))

/**
 * 看门狗自豁免 —— **看门狗自己得写出禁用词**：要检测「登录」就必须写下「登录」两个字。
 *
 * 所以文件里可以声明一行（只对该文件生效）：
 *     // oss-clean-allow: 登录, 会员, 升级
 *
 * ⚠️ 这不是想写就写的后门：声明的**每一个词都必须在 FORBIDDEN 表里**，
 * 声明了表外的词会作为**一条失败**报出来（word 记成 `__bad-allow`）。
 * 否则"加一行注释"就能放行任何东西，这道闸门等于没有。
 */
const ALLOW_RE = /oss-clean-allow:\s*([^\n]+)/g

/** 读出某文件的豁免词；顺手把"声明了表外词"记成失败 */
function readAllows(text, file, hits) {
  const out = new Set()
  for (const m of text.matchAll(ALLOW_RE)) {
    const line = text.slice(0, m.index).split('\n').length
    for (const token of String(m[1]).split(/[,，、\s]+/)) {
      if (!token) continue
      if (!FORBIDDEN_WORDS.has(token)) {
        hits.push({ file, word: '__bad-allow', why: `声明了禁用表里没有的豁免词「${token}」`, line })
        continue
      }
      out.add(token)
    }
  }
  return out
}

/** 构建产物目录不扫：里面是复制过去的旧内容，改它没意义，还会把闸门染红 */
const SKIP_DIRS = /^(node_modules|\.git|dist|dist-.*|out|build|release|_recon|_evidence)$/

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const name of fs.readdirSync(cur)) {
      if (SKIP_DIRS.test(name)) continue
      const full = path.join(cur, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) stack.push(full)
      else if (TEXT_EXT.test(name)) yield full
    }
  }
}

function files() {
  const list = []
  for (const dir of SCAN_DIRS) for (const f of walk(path.join(ROOT, dir))) list.push(f)
  for (const rel of SCAN_FILES) {
    const full = path.join(ROOT, rel)
    if (fs.existsSync(full)) list.push(full)
  }
  return list.filter((f) => !SKIP_FILES.has(path.basename(f)))
}

/** 返回 [{ file, word, why, line }] */
function audit(rootDir) {
  const hits = []
  const list = []
  for (const dir of SCAN_DIRS) for (const f of walk(path.join(rootDir, dir))) list.push(f)
  for (const rel of SCAN_FILES) {
    const full = path.join(rootDir, rel)
    if (fs.existsSync(full)) list.push(full)
  }
  for (const file of list) {
    if (SKIP_FILES.has(path.basename(file))) continue
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lower = text.toLowerCase()
    const allows = readAllows(text, path.relative(rootDir, file), hits)
    for (const [word, why, opt] of FORBIDDEN) {
      if (allows.has(word)) continue
      let idx = lower.indexOf(word)
      while (idx !== -1) {
        /* 中文没有词边界：必须能声明"前一个字 / 后一个字不能是什么"，
           否则「节点数」会被「点数」命中、「升级安装」会被「升级」命中 ——
           假红一屏，闸门就被无视了。 */
        const prev = idx > 0 ? lower[idx - 1] : ''
        const next = lower[idx + word.length] || ''
        const skip =
          (Boolean(opt?.notBefore) && idx > 0 && opt.notBefore.includes(prev)) ||
          (Boolean(opt?.notAfter) && next !== '' && opt.notAfter.includes(next))
        if (!skip) {
          const line = lower.slice(0, idx).split('\n').length
          hits.push({ file: path.relative(rootDir, file), word, why, line })
        }
        idx = lower.indexOf(word, idx + word.length)
      }
    }
  }
  return hits
}

function main() {
  const hits = audit(ROOT)
  const scanned = files().length
  const words = new Set(hits.map((h) => h.word))
  const pass = FORBIDDEN.length - words.size
  console.log(`已扫描 ${scanned} 个文本文件，禁用词 ${FORBIDDEN.length} 个`)
  for (const h of hits) {
    console.log(`FAIL ${h.file}:${h.line} 出现「${h.word}」（${h.why}）`)
  }
  if (!hits.length) console.log('PASS 未发现第三方品牌 / 生产地址 / 密钥 / 账号体系残留')
  console.log(`\n断言：${FORBIDDEN.length} / 通过 ${pass} / 失败 ${words.size}`)
  console.log(`OSS_CLEAN_STATS total=${FORBIDDEN.length} pass=${pass} fail=${words.size}`)
  if (!hits.length) console.log('OSS_CLEAN_OK')
  process.exitCode = hits.length ? 1 : 0
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-clean-'))
  // 造一份最小仓库骨架，里面塞一个禁用词，检查器必须报出来
  fs.mkdirSync(path.join(tmp, 'packages', 'desktop', 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'packages', 'desktop', 'src', 'dirty.js'),
    "// 这里误写了第三方产品名：hitpaw\nconst a = 1\n",
    'utf8'
  )
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}\n', 'utf8')

  const dirty = audit(tmp)
  const ok1 = dirty.length === 1 && dirty[0].word === 'hitpaw'
  console.log(ok1 ? '  PASS 造一个禁用词 → 抓到了' : `  FAIL 禁用词没被抓到（命中 ${dirty.length} 条）`)

  // 干净的仓库必须一条都不报
  fs.writeFileSync(path.join(tmp, 'packages', 'desktop', 'src', 'dirty.js'), 'const a = 1\n', 'utf8')
  const clean = audit(tmp)
  const ok2 = clean.length === 0
  console.log(ok2 ? '  PASS 清掉之后 → 归零' : `  FAIL 干净仓库仍在报（${clean.length} 条）`)

  /* 第三条最要紧：**判据里那条规则本身不许被"优化掉"**。
     中文词是逐字匹配的，只要有人把「充值」从表里删掉，前两条照样绿 ——
     所以这里点名验一条中文词也在生效（删表即红）。 */
  fs.writeFileSync(
    path.join(tmp, 'packages', 'desktop', 'src', 'dirty.js'),
    'const label = "充值"\n',
    'utf8'
  )
  const zh = audit(tmp)
  const ok3 = zh.length === 1 && zh[0].word === '充值'
  console.log(ok3 ? '  PASS 中文禁用词同样在生效' : `  FAIL 中文词没被抓到（命中 ${zh.length} 条）`)

  /* 第四条：看门狗的自豁免必须**双向**成立 ——
     声明了表内的词（登录）→ 该文件里出现不报（否则没人敢写检测「登录」的看门狗）；
     声明了表外的词（随便什么）→ 必须报，否则这行注释就是一道万能后门。 */
  fs.writeFileSync(
    path.join(tmp, 'packages', 'desktop', 'src', 'dirty.js'),
    '// oss-clean-allow: 登录\nconst label = "登录"\n',
    'utf8'
  )
  const allowed = audit(tmp)
  fs.writeFileSync(
    path.join(tmp, 'packages', 'desktop', 'src', 'dirty.js'),
    '// oss-clean-allow: 随便放行\nconst label = "登录"\n',
    'utf8'
  )
  const bogus = audit(tmp)
  const ok4 = allowed.length === 0 && bogus.some((h) => h.word === '__bad-allow')
  console.log(
    ok4
      ? '  PASS 自豁免双向成立（表内词放行 · 表外词判红）'
      : `  FAIL 自豁免判据不对（表内 ${allowed.length} 条 / 表外 ${bogus.length} 条）`
  )

  const ok = ok1 && ok2 && ok3 && ok4
  const pass = [ok1, ok2, ok3, ok4].filter(Boolean).length
  console.log(`\n断言：4 / 通过 ${pass} / 失败 ${4 - pass}`)
  console.log(`OSS_CLEAN_SELFTEST_STATS total=4 pass=${pass} fail=${4 - pass}`)
  if (ok) console.log('OSS_CLEAN_SELFTEST_OK')
  process.exitCode = ok ? 0 : 1
}

if (process.argv.includes('--selftest')) selftest()
else main()
