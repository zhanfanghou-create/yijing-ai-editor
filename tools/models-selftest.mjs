#!/usr/bin/env node
/**
 * 本地 AI 模型管理 · 纯逻辑自检（脱机，不联网，不依赖 Electron）。
 *
 * 为什么要单独一道：模型管理的失败几乎全是**静默**的 ——
 *   · 下载写到一半断网，目标文件已存在、只是短了几 MB ⇒ 下次判定"已安装"，推理时才炸；
 *   · 半套文件被当成"装好了" ⇒ 功能坏掉而我们显示"已就绪"；
 *   · 删除时把随包那份一起删了 ⇒ 功能永久坏，下次发版前都没救。
 * 这三条都不会抛错、不会让构建变红，只能靠夹具把结论钉住。
 *
 * 用法：node tools/models-selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const models = require('../packages/desktop/src/main/models.js')

let pass = 0
const fails = []

function check(name, fn) {
  try {
    const detail = fn()
    pass += 1
    console.log(`  ✓ ${name}${detail ? `　${detail}` : ''}`)
  } catch (err) {
    fails.push(`${name} —— ${err.message}`)
    console.log(`  ✗ ${name} —— ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const ENTRY = models.byId('face-runtime')
assert(ENTRY, '注册表里必须有 face-runtime')

/** 造一套"文件内容长度恰好等于标称值"的假目录，避免依赖真实大文件 */
function makeDir(root, sizes) {
  fs.mkdirSync(root, { recursive: true })
  for (const item of ENTRY.files) {
    const size = sizes && sizes[item.name] !== undefined ? sizes[item.name] : 8
    const file = path.join(root, item.name)
    if (size <= 0) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 本来就没有 */
      }
      continue
    }
    fs.writeFileSync(file, Buffer.alloc(size, 1))
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-models-'))
const userData = path.join(tmp, 'userData')
/* 随包目录必须叫 mediapipe：bundleRootOf 按 resourcesPath/<bundle> 找，改个名字它就找不到 */
const bundle = path.join(tmp, 'mediapipe')

console.log('\n本地 AI 模型管理 · 自检\n')

check('注册表只登记真的在被使用的组件', () => {
  assert(models.REGISTRY.length >= 1, '注册表为空')
  for (const entry of models.REGISTRY) {
    assert(entry.id && entry.name && entry.purpose, '每条都要有 id / name / purpose')
    assert(entry.files.length > 0, `${entry.id} 没有文件清单`)
    assert(entry.license, `${entry.id} 没写许可证`)
  }
  return `${models.REGISTRY.length} 条`
})

check('两处都没有 ⇒ 判定未安装，且把缺的文件名全列出来', () => {
  const state = models.stateOf(ENTRY, { userData, resourcesPath: path.join(tmp, 'nope') })
  assert(state.source === 'missing', `source 应为 missing，实际 ${state.source}`)
  assert(state.missing.length === ENTRY.files.length, `应列全 ${ENTRY.files.length} 个缺口，实际 ${state.missing.length}`)
  return `缺 ${state.missing.length} 个`
})

check('只有随包一份 ⇒ 判定 packaged 已就绪', () => {
  makeDir(bundle)
  const state = models.stateOf(ENTRY, { userData, resourcesPath: tmp })
  assert(state.source === 'bundled', `source 应为 bundled，实际 ${state.source}`)
  return `bytes=${state.bytes}`
})

check('本机那份完整 ⇒ 优先于随包（下载必须真的能盖过随包版本）', () => {
  const install = path.join(userData, 'models', ENTRY.id)
  makeDir(install, Object.fromEntries(ENTRY.files.map((item) => [item.name, 16])))
  const state = models.stateOf(ENTRY, { userData, resourcesPath: tmp })
  assert(state.source === 'local', `source 应为 local，实际 ${state.source}`)
  assert(state.dir === install, `生效目录应指向本机那份，实际 ${state.dir}`)
  return state.dir.replace(tmp, '…')
})

check('本机那份缺一个文件 ⇒ 回落随包，不把半套当可用', () => {
  const install = path.join(userData, 'models', ENTRY.id)
  makeDir(install, { [ENTRY.files[0].name]: 0 })
  const state = models.stateOf(ENTRY, { userData, resourcesPath: tmp })
  assert(state.source === 'bundled', `半套时应回落 bundled，实际 ${state.source}`)
  return '半套不接管'
})

check('从文件安装：文件名不在清单里 ⇒ 明确拒绝', () => {
  const stray = path.join(tmp, 'random.bin')
  fs.writeFileSync(stray, Buffer.alloc(8, 1))
  let error = ''
  try {
    models.importFrom(ENTRY, stray, { userData })
  } catch (err) {
    error = err.message
  }
  assert(error, '应该抛错')
  assert(/文件名不符/.test(error), `报错要指出文件名不符，实际：${error}`)
  return error.slice(0, 24)
})

check('从文件安装：体积不符 ⇒ 拒绝（模型被截断是最常见的一种坏文件）', () => {
  const fake = path.join(tmp, ENTRY.files[2].name)
  /* 标称 3758596，这里只给 8 字节 */
  fs.writeFileSync(fake, Buffer.alloc(8, 1))
  let error = ''
  try {
    models.importFrom(ENTRY, fake, { userData })
  } catch (err) {
    error = err.message
  }
  assert(/体积不符/.test(error), `报错应指出体积不符，实际：${error}`)
  return '体积校验生效'
})

check('从文件安装：合法文件 ⇒ 落到本机目录并变成 local', () => {
  const install = path.join(userData, 'models', ENTRY.id)
  /* 三个文件按标称体积造，逐个装进去 */
  for (const item of ENTRY.files) {
    /* 文件名必须与清单一致：importFrom 是按 basename 认领的，加前缀会被当成别的文件 */
    const incoming = path.join(tmp, 'incoming')
    fs.mkdirSync(incoming, { recursive: true })
    const src = path.join(incoming, item.name)
    fs.writeFileSync(src, Buffer.alloc(item.bytes, 1))
    models.importFrom(ENTRY, src, { userData })
  }
  const state = models.stateOf(ENTRY, { userData, resourcesPath: tmp })
  assert(state.source === 'local', `source 应为 local，实际 ${state.source}`)
  return `${fs.readdirSync(install).length} 个文件`
})

check('删除本机副本 ⇒ 回落到随包，且绝不碰随包文件', () => {
  const row = models.remove(ENTRY, { userData, resourcesPath: tmp })
  assert(row.source === 'bundled', `删完应回落 bundled，实际 ${row.source}`)
  for (const item of ENTRY.files) {
    const bundled = path.join(bundle, item.name)
    assert(fs.existsSync(bundled), `随包文件被误删：${item.name}`)
  }
  return '随包完好'
})

check('删除时清掉 .part 残留（否则它会被当成已安装的半套）', () => {
  const install = path.join(userData, 'models', ENTRY.id)
  fs.mkdirSync(install, { recursive: true })
  const part = path.join(install, `${ENTRY.files[0].name}.part`)
  fs.writeFileSync(part, Buffer.alloc(4, 1))
  models.remove(ENTRY, { userData, resourcesPath: tmp })
  assert(!fs.existsSync(part), '.part 没被清掉')
  return '.part 已清'
})

check('占用统计只算本机那份，不把随包算成用户占用', () => {
  const before = models.totalBytes({ userData })
  assert(before.total === 0, `本机为空时应为 0，实际 ${before.total}`)
  const install = path.join(userData, 'models', ENTRY.id)
  makeDir(install, Object.fromEntries(ENTRY.files.map((item) => [item.name, 16])))
  const after = models.totalBytes({ userData })
  assert(after.total === 16 * ENTRY.files.length, `应为 ${16 * ENTRY.files.length}，实际 ${after.total}`)
  models.remove(ENTRY, { userData, resourcesPath: tmp })
  return `${after.total} B`
})

check('list() 的字段够界面直接用（不缺状态 / 体积 / 缺项）', () => {
  const rows = models.list({ userData, resourcesPath: tmp })
  const row = rows.find((item) => item.id === ENTRY.id)
  assert(row, 'list 里没有这个组件')
  for (const key of ['id', 'name', 'purpose', 'license', 'size', 'bytes', 'source', 'dir', 'missing', 'files', 'downloadable']) {
    assert(key in row, `缺字段 ${key}`)
  }
  assert(row.size === ENTRY.files.reduce((n, item) => n + item.bytes, 0), 'size 应等于各文件标称体积之和')
  return `size=${row.size}`
})

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉不影响结论 */
}

if (!fails.length) console.log('MODELS_SELFTEST_PASSED')
console.log(`MODELS_SELFTEST_STATS total=${pass + fails.length} pass=${pass} fail=${fails.length}`)
console.log(`\n模型管理自检：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  for (const line of fails) console.log(`  · ${line}`)
  process.exit(1)
}
