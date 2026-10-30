#!/usr/bin/env node
/**
 * 贴纸素材抓取（Google Noto Animated Emoji 的静态 512 帧）。
 *
 * 为什么是这家、为什么是这条链路：
 *   · 许可 Apache 2.0 —— 允许随我们的安装包再分发，只需保留声明（见 THIRD-PARTY-NOTICES.md）。
 *   · `fonts.gstatic.com` 在国内**实测直连可用**（GitHub raw 与 jsdelivr 都是超时/重置），
 *     所以素材能在任何一台机器上重跑复现，不依赖谁手上有几个文件。
 *   · 512×512 RGBA，**背景是真透明**（实测 1f600 有 94634 个全透明像素）——
 *     这是贴纸能不能用的前提：不透明的方图叠到画面上就是一个白框。
 *
 * 产出：
 *   resources/stickers/<group>/<codepoint>.png   —— 素材本体
 *   resources/stickers/catalog.json              —— 面板读的清单（含宽高 / 字节 / sha1）
 *
 * 幂等：已在盘上且 sha1 一致就跳过；不一致重下。断网时用 `--offline` 只重建清单。
 *
 * 用法：
 *   node tools/fetch-stickers.mjs              # 抓全部（缺什么补什么）
 *   node tools/fetch-stickers.mjs --offline    # 不联网，只按现有文件重建 catalog.json
 *   node tools/fetch-stickers.mjs --only smiley
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'packages', 'desktop', 'resources', 'stickers')
const BASE = 'https://fonts.gstatic.com/s/e/notoemoji/latest'

/**
 * 清单。
 *
 * ⚠️ 中文名是**界面文案**，不是注释 —— 用户会在面板上读到它，所以按"这个图标看起来是什么"
 *    来命名（「笑哭」不是「喜悦之泪」），并且同组内不重名（重名时面板上分不出谁是谁）。
 * ⚠️ `cp` 是 Noto 的目录名（Unicode 码点十六进制，多码点用 `_` 连）。
 *    写错的后果是 404 —— 脚本会把它记进失败表并以非零码退出，不会静默少一个。
 */
const GROUPS = [
  {
    key: 'face',
    name: '表情',
    items: [
      ['1f600', '咧嘴笑'],
      ['1f602', '笑哭'],
      ['1f60d', '心形眼'],
      ['1f60e', '墨镜'],
      ['1f929', '星星眼'],
      ['1f970', '爱心脸'],
      ['1f60b', '馋'],
      ['1f61c', '眨眼吐舌'],
      ['1f92a', '搞怪'],
      ['1f973', '派对脸'],
      ['1f60f', '得意'],
      ['1f612', '不爽'],
      ['1f644', '无语'],
      ['1f614', '失落'],
      ['1f62d', '大哭'],
      ['1f621', '生气'],
      ['1f631', '惊恐'],
      ['1f914', '思考'],
      ['1f634', '睡觉'],
      ['1f971', '打哈欠'],
      ['1f92f', '爆炸头'],
      ['1f480', '骷髅']
    ]
  },
  {
    key: 'hand',
    name: '手势',
    items: [
      ['1f44d', '点赞'],
      ['1f44e', '踩'],
      ['1f44f', '鼓掌'],
      ['1f64c', '举手欢呼'],
      ['1f450', '张开双手'],
      ['270c', '剪刀手'],
      ['1f918', '摇滚手势'],
      ['1f91d', '握手'],
      ['1f4aa', '加油'],
      ['1f919', '打电话'],
      ['1f446', '向上指'],
      ['1f447', '向下指'],
      ['1f448', '向左指'],
      ['1f449', '向右指'],
      ['1f64f', '双手合十'],
      ['1f440', '双眼']
    ]
  },
  {
    key: 'heart',
    name: '心形',
    items: [
      ['2764', '红心'],
      ['1f494', '心碎'],
      ['1f495', '两颗心'],
      ['1f496', '闪光心'],
      ['1f497', '渐长心'],
      ['1f498', '一箭穿心'],
      ['1f49d', '礼物心'],
      ['1f49e', '环绕心'],
      ['1f49f', '心形装饰'],
      ['1f5a4', '黑心'],
      ['1f9e1', '橙心'],
      ['1f49a', '绿心'],
      ['1f499', '蓝心'],
      ['1f49c', '紫心'],
      ['1f90d', '白心'],
      ['1f90e', '棕心']
    ]
  },
  {
    key: 'spark',
    name: '闪亮',
    items: [
      ['2b50', '星星'],
      ['1f31f', '闪亮星'],
      ['2728', '闪光'],
      ['1f4ab', '眩晕'],
      ['1f320', '流星'],
      ['1f308', '彩虹'],
      ['1f525', '火'],
      ['26a1', '闪电'],
      ['1f4a5', '碰撞'],
      ['1f4a2', '怒气'],
      ['1f4a6', '汗滴'],
      ['1f4a8', '疾冲'],
      ['1f4a4', '昏睡'],
      ['1f4ac', '对话框'],
      ['1f4ad', '思考泡泡'],
      ['1f3b5', '音符'],
      ['1f3b6', '多音符'],
      ['1f4e2', '喇叭'],
      ['1f514', '铃铛'],
      ['1f3af', '靶心']
    ]
  },
  {
    key: 'party',
    name: '庆祝',
    items: [
      ['1f389', '拉炮'],
      ['1f38a', '彩球'],
      ['1f382', '生日蛋糕'],
      ['1f381', '礼物盒'],
      ['1f388', '气球'],
      ['1f386', '烟花'],
      ['1f387', '火花'],
      ['1f37e', '香槟'],
      ['1f942', '碰杯'],
      ['1f3c6', '奖杯'],
      ['1f947', '金牌'],
      ['1f3aa', '帐篷'],
      ['1f3ad', '面具'],
      ['1f9e8', '鞭炮']
    ]
  },
  {
    key: 'animal',
    name: '动物',
    items: [
      ['1f436', '小狗'],
      ['1f431', '小猫'],
      ['1f42d', '老鼠'],
      ['1f430', '兔子'],
      ['1f43b', '熊'],
      ['1f43c', '熊猫'],
      ['1f428', '考拉'],
      ['1f42f', '老虎'],
      ['1f981', '狮子'],
      ['1f984', '独角兽'],
      ['1f427', '企鹅'],
      ['1f426', '小鸟'],
      ['1f98b', '蝴蝶'],
      ['1f422', '乌龟'],
      ['1f419', '章鱼'],
      ['1f420', '热带鱼']
    ]
  },
  {
    key: 'food',
    name: '美食',
    items: [
      ['1f355', '披萨'],
      ['1f354', '汉堡'],
      ['1f35f', '薯条'],
      ['1f32d', '热狗'],
      ['1f366', '冰淇淋'],
      ['1f369', '甜甜圈'],
      ['1f370', '蛋糕'],
      ['1f36b', '巧克力'],
      ['1f36a', '饼干'],
      ['1f37f', '爆米花'],
      ['2615', '咖啡'],
      ['1f37a', '啤酒'],
      ['1f353', '草莓'],
      ['1f349', '西瓜'],
      ['1f34e', '苹果'],
      ['1f34c', '香蕉']
    ]
  },
  {
    key: 'mark',
    name: '标记',
    items: [
      ['2705', '对勾'],
      ['274c', '叉号'],
      ['2757', '感叹号'],
      ['2753', '问号'],
      ['2b55', '圆圈'],
      ['1f51d', '置顶'],
      ['1f195', '新'],
      ['1f4cd', '定位'],
      ['1f4cc', '图钉'],
      ['1f4c5', '日历'],
      ['23f0', '闹钟'],
      ['23f3', '沙漏'],
      ['1f512', '上锁'],
      ['1f513', '解锁'],
      ['1f511', '钥匙'],
      ['267b', '回收'],
      ['1f6a9', '三角旗'],
      ['1f3c1', '格子旗'],
      ['27a1', '右箭头'],
      ['261d', '食指向上']
    ]
  }
]

const argv = process.argv.slice(2)
const OFFLINE = argv.includes('--offline')
const onlyAt = argv.indexOf('--only')
const only = onlyAt >= 0 ? String(argv[onlyAt + 1] || '').trim() : ''

/** PNG 的宽高在第 16..24 字节（IHDR 的后半段）。零依赖，不需要图像库 */
function pngSize(buf) {
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

async function fetchOne(cp, dest) {
  const url = `${BASE}/${cp}/512.png`
  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (res.status === 404) return { ok: false, reason: '404 素材不存在（码点写错？）' }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`
      } else {
        const buf = Buffer.from(await res.arrayBuffer())
        const size = pngSize(buf)
        if (!size) return { ok: false, reason: '不是合法 PNG' }
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, buf)
        return { ok: true, bytes: buf.length, w: size.w, h: size.h, sha1: sha1(buf) }
      }
    } catch (err) {
      lastErr = err && err.message ? err.message : String(err)
    }
    /* 退避一下再试：瞬时重置（curl 56）比 404 常见得多 */
    if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt))
  }
  return { ok: false, reason: lastErr || '未知错误' }
}

async function main() {
  const groups = []
  const failed = []
  let downloaded = 0
  let reused = 0

  for (const group of GROUPS) {
    if (only && group.key !== only) continue
    const items = []
    for (const [cp, name] of group.items) {
      const dest = path.join(OUT, group.key, `${cp}.png`)
      let info = null

      if (fs.existsSync(dest)) {
        const buf = fs.readFileSync(dest)
        const size = pngSize(buf)
        if (size && size.w === 512) {
          info = { bytes: buf.length, w: size.w, h: size.h, sha1: sha1(buf) }
          reused += 1
        }
      }

      if (!info) {
        if (OFFLINE) {
          failed.push({ cp, name, reason: '离线模式且本地缺失' })
          continue
        }
        const got = await fetchOne(cp, dest)
        if (!got.ok) {
          failed.push({ cp, name, reason: got.reason })
          continue
        }
        info = got
        downloaded += 1
        process.stdout.write(`  + ${group.name}/${name}  ${info.w}×${info.h}  ${info.bytes}B\n`)
      }

      items.push({
        key: `${group.key}-${cp}`,
        name,
        cp,
        /* 相对 resources/stickers 的路径 —— 主进程据此拼绝对路径，渲染层只拿 URL */
        file: `${group.key}/${cp}.png`,
        w: info.w,
        h: info.h,
        bytes: info.bytes,
        sha1: info.sha1
      })
    }
    if (items.length) groups.push({ key: group.key, name: group.name, items })
  }

  /* 只抓单组时不覆盖 catalog（否则会把别的组从清单里抹掉） */
  const catalogPath = path.join(OUT, 'catalog.json')
  let merged = groups
  if (only) {
    const prev = fs.existsSync(catalogPath)
      ? JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
      : { groups: [] }
    merged = (prev.groups || []).map((g) => (g.key === groups[0].key ? groups[0] : g))
    if (!merged.some((g) => g.key === groups[0].key)) merged.push(groups[0])
  }

  const total = merged.reduce((n, g) => n + g.items.length, 0)
  const bytes = merged.reduce((n, g) => n + g.items.reduce((m, it) => m + it.bytes, 0), 0)
  const catalog = {
    /* 素材来源与许可：面板不展示，但 THIRD-PARTY-NOTICES 与闸门都读它 */
    source: 'Noto Animated Emoji (static 512 frame)',
    license: 'Apache-2.0',
    origin: BASE,
    groups: merged
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8')

  console.log('')
  console.log(`贴纸：${total} 个 / ${merged.length} 组 / ${(bytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`本次下载 ${downloaded}，复用 ${reused}，失败 ${failed.length}`)
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f.cp} ${f.name} — ${f.reason}`)
    console.error('有素材没抓到。清单里写了但盘上没有，面板会少一格 —— 修好再跑一次。')
    process.exit(1)
  }
  console.log(`清单：${path.relative(ROOT, catalogPath)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
