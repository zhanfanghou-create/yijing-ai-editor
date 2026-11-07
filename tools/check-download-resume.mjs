#!/usr/bin/env node
/**
 * 闸门 · 下载器的真实路径：断点续传 / 换源重下 / 416 / 并行分段 / 代理隧道。
 *
 * ── 为什么这道闸门非有不可 ────────────────────────────────────────────
 * 模型下载是"用户感知最贵"的一段：78MB 的中文识别模型、228MB 的多语种模型。
 * 它出错的方式**全都长得像网络问题**，而真正的错因在自己代码里：
 *   · 每次失败都删 `.part` ⇒ 慢网下"进度条反复弹回 0，永远装不完"；
 *   · 追加写却没看状态码 ⇒ 服务器忽略 Range 时拼出"长度刚好对、内容前后两半"的文件，
 *     体积校验（promote）照样放行 ⇒ 模型能加载、识别结果是乱码；
 *   · 换镜像后沿用旧 `.part` ⇒ 两个版本拼在一起，同上；
 *   · `node:https` 不读 `https_proxy` ⇒ 用户开着系统代理，应用仍在裸奔；
 *   · 分段并发把某一段写错位 / 重试把已下完的段重下一遍 ⇒ 前者拼出坏文件，
 *     后者让 228MB 再走一趟，而用户只看到"又在装"。
 * 这五条里前四条只要**一次真下载失败**就能触发，第五条在开了并发的机器上天天发生。
 *
 * ── 为什么不在真网上下 ──────────────────────────────────────────────
 * 真网会抖，抖了就得判 SKIP —— 而 SKIP 一旦变常态，这道闸门等于不存在。
 * 所以这里在 127.0.0.1 起一个**行为可控**的 HTTP 服务（能准时在 40% 处掐断连接、
 * 能假装不认 Range、能回 416、能 302），再起一个**真 CONNECT 代理**，
 * 逐条断言。整个过程不碰外网，任何机器上结果都一样。
 *
 * 用法：node tools/check-download-resume.mjs
 * 退出码：0 通过 / 1 失败
 */
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const models = require(path.join(ROOT, 'packages/desktop/src/main/models.js'))
const proxyTunnel = require(path.join(ROOT, 'packages/desktop/src/main/proxyTunnel.js'))

const TOTAL_ASSERTIONS = 43
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'yjai-dl-resume-'))

const BODY = crypto.randomBytes(700 * 1024)
// 与 BODY 等长但内容不同：用来证明"换源时若沿用旧 .part，体积校验拦不住"
const OTHER = crypto.randomBytes(BODY.length)
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')
const BODY_SHA = sha1(BODY)
const OTHER_SHA = sha1(OTHER)

let failures = 0
let ran = 0

/** 给"本该失败"的下载加个上限：看门狗一旦失灵，这里会判失败而不是把整个套件挂住 */
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`超过 ${ms}ms 仍未结束（看门狗没生效？）`)), ms))
  ])
const check = (name, ok, detail = '') => {
  ran += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

/* ── 可控的源站 ──────────────────────────────────────────────────────
 * 每个路径模拟一种真实的坏情况；用请求计数而不是随机，保证每次跑都一样。 */
const state = { flakyHits: 0, ranges: [], cutOnce: new Set(), segCut: 0, inflight: 0, maxInflight: 0 }

/** 慢速响应：每一小块之间等一会儿，好让"并发"变成可观测的事实（而不是猜） */
function sendThrottled(res, slice, step = 4096, gap = 20) {
  let at = 0
  let closed = false
  res.on('close', () => {
    closed = true
  })
  const tick = () => {
    if (closed) return
    if (at >= slice.length) {
      res.end()
      return
    }
    res.write(slice.subarray(at, at + step))
    at += step
    setTimeout(tick, gap)
  }
  tick()
}
/** 分段测试用：4 段里的第 3 段（从这个偏移起）掐断一次 */
const CUT_SEG_FROM = Math.floor((BODY.length / 4) * 2)

function sendFull(res, body, etag) {
  res.writeHead(200, { 'Content-Length': body.length, ETag: etag, 'Accept-Ranges': 'bytes' })
  res.end(body)
}

function parseRange(header, total) {
  const m = String(header || '').match(/^bytes=(\d+)-(\d*)$/)
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
  if (start > end || start >= total) return { bad: true }
  return { start, end }
}

/** 认 Range 就回 206（含闭合区间）；没带 Range 回 false，交给调用方发整份 */
function sendRange(req, res, body, etag) {
  const row = parseRange(req.headers.range, body.length)
  if (!row) return false
  if (row.bad) {
    res.writeHead(416, { 'Content-Range': `bytes */${body.length}` })
    res.end()
    return true
  }
  const slice = body.subarray(row.start, row.end + 1)
  res.writeHead(206, {
    'Content-Length': slice.length,
    'Content-Range': `bytes ${row.start}-${row.end}/${body.length}`,
    ETag: etag
  })
  res.end(slice)
  return true
}

const server = http.createServer((req, res) => {
  const range = String(req.headers.range || '')
  if (range) state.ranges.push({ path: req.url, range, ifRange: String(req.headers['if-range'] || '') })

  /* 同时在飞的连接数：并发下载必须真的并起来，这一条比"总耗时"可靠得多
     （总耗时会被机器负载和网络抖动带跑，在飞连接数不会）。
     探测请求（bytes=0-0）不算：它只有 1 个字节，掐着表收尾时会被算成"第 5 条在飞"。 */
  if (req.url === '/slow' && range !== 'bytes=0-0') {
    state.inflight += 1
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    res.on('close', () => {
      state.inflight -= 1
    })
  }

  /* 探测请求（bytes=0-0）单独认出来：它不该消耗"第一次就掐断"这类一次性剧本，
     否则闸门测的就不是真实下载路径了。 */
  const isProbe = range === 'bytes=0-0'

  if (req.url === '/redir') {
    res.writeHead(302, { Location: '/solid' })
    res.end()
    return
  }

  if (req.url === '/norange') {
    // 完全不认 Range：永远整份 200（老 CDN / 中间层缓存常这样）
    sendFull(res, BODY, '"solid"')
    return
  }

  if (req.url === '/r416') {
    if (range) {
      res.writeHead(416, { 'Content-Range': `bytes */${BODY.length}` })
      res.end()
      return
    }
    sendFull(res, BODY, '"solid"')
    return
  }

  /* 停滞源站：发一小段之后**既不继续发、也不关连接**。
     这正是"下载卡在 99% 永远不动"的样子 —— 它不触发任何"连接断开"的错误。 */
  if (req.url === '/stall') {
    res.writeHead(200, { 'Content-Length': BODY.length, ETag: '"solid"', 'Accept-Ranges': 'bytes' })
    res.write(BODY.subarray(0, 10 * 1024))
    return
  }

  if (req.url === '/other') {
    sendFull(res, OTHER, '"other"')
    return
  }

  /* 分段测试：第 3 段第一次只发一半就掐断，其余段正常 ——
     用来证明"重试只补缺的那一段，已下完的段不再重下"。 */
  if (req.url === '/cutseg' && !isProbe) {
    const row = parseRange(range, BODY.length)
    if (row && !row.bad && row.start >= CUT_SEG_FROM && state.segCut === 0) {
      state.segCut += 1
      const slice = BODY.subarray(row.start, row.end + 1)
      res.writeHead(206, {
        'Content-Length': slice.length,
        'Content-Range': `bytes ${row.start}-${row.end}/${BODY.length}`,
        ETag: '"solid"'
      })
      res.write(slice.subarray(0, Math.floor(slice.length * 0.5)))
      setTimeout(() => res.socket && res.socket.destroy(), 30)
      return
    }
  }

  /* 慢速源站：用来证明"四条连接是同时在跑"，而不是排队跑完再拼 */
  if (req.url === '/slow') {
    const row = parseRange(range, BODY.length)
    if (!row) {
      res.writeHead(200, { 'Content-Length': BODY.length, ETag: '"solid"', 'Accept-Ranges': 'bytes' })
      sendThrottled(res, BODY)
      return
    }
    if (row.bad) {
      res.writeHead(416, { 'Content-Range': `bytes */${BODY.length}` })
      res.end()
      return
    }
    const slice = BODY.subarray(row.start, row.end + 1)
    res.writeHead(206, {
      'Content-Length': slice.length,
      'Content-Range': `bytes ${row.start}-${row.end}/${BODY.length}`,
      ETag: '"solid"'
    })
    sendThrottled(res, slice)
    return
  }

  if ((req.url === '/flaky' || req.url === '/flaky2') && !isProbe && !state.cutOnce.has(req.url)) {
    // 第一次：把响应头与 40% 的字节发出去，然后**掐断连接**
    state.cutOnce.add(req.url)
    state.flakyHits += 1
    res.writeHead(200, { 'Content-Length': BODY.length, ETag: '"solid"', 'Accept-Ranges': 'bytes' })
    res.write(BODY.subarray(0, Math.floor(BODY.length * 0.4)))
    setTimeout(() => res.socket && res.socket.destroy(), 30)
    return
  }

  if (['/flaky', '/flaky2', '/solid', '/cutseg'].includes(req.url)) {
    if (sendRange(req, res, BODY, '"solid"')) return
    sendFull(res, BODY, '"solid"')
    return
  }

  res.writeHead(404)
  res.end()
})

/* ── 真 CONNECT 代理（不是假的：它真的去连目标、真的双向转发字节） ── */
const tunnelLog = []
const proxyServer = net.createServer((client) => {
  let buf = ''
  const onData = (chunk) => {
    buf += chunk.toString('latin1')
    const end = buf.indexOf('\r\n\r\n')
    if (end < 0) return
    client.removeListener('data', onData)
    const head = buf.slice(0, end)
    const first = head.split('\r\n')[0]
    tunnelLog.push({ head: first, auth: /Proxy-Authorization: Basic (.+)/i.exec(head) ? RegExp.$1 : '' })
    const m = first.match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]$/i)
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const upstream = net.connect({ host: m[1], port: Number(m[2]) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const rest = buf.slice(end + 4)
      if (rest) upstream.write(Buffer.from(rest, 'latin1'))
      client.pipe(upstream)
      upstream.pipe(client)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  }
  client.on('data', onData)
  client.on('error', () => {})
})

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

const port = await listen(server)
const proxyPort = await listen(proxyServer)

const url = (p) => `http://127.0.0.1:${port}${p}`
const partOf = (dest) => `${dest}.part`
const readPart = (dest) => {
  const file = partOf(dest)
  return fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
}
/** 还剩几个分段文件（下完必须为 0；留着就是残渣） */
const segLeft = (dest) => {
  const dir = path.dirname(dest)
  const base = path.basename(partOf(dest))
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(base + '.seg')).length
  } catch {
    return 0
  }
}

console.log('=== 断点续传 / 换源 / 416 / 代理 ===')

/* ① 正常一次下完（后面每条都拿它当基准） */
{
  const dest = path.join(WORK, 'solid.bin')
  const r = await models.fetchTo(url('/solid'), dest, null, { proxy: null })
  check('一次下完：字节数与内容都对', sha1(readPart(dest)) === BODY_SHA && r.bytes === BODY.length, `${r.bytes} 字节`)
}

/* ② 中途掐断：必须是"失败"，且**半截文件留着**（留着才有得续） */
{
  const dest = path.join(WORK, 'flaky.bin')
  let err = null
  try {
    await models.fetchTo(url('/flaky'), dest, null, { proxy: null })
  } catch (e) {
    err = e
  }
  const half = readPart(dest).length
  check(
    '传输中途被掐断：如实报错（不许当成下完）',
    Boolean(err),
    err ? String(err.message).slice(0, 60) : '居然成功了'
  )
  check(
    '半截文件必须留下（删掉就等于没有续传）',
    half > 0 && half < BODY.length,
    `留下 ${half}/${BODY.length} 字节`
  )

  /* ③ 再调一次：必须带 Range 接着下，最终字节完全一致 */
  state.ranges.length = 0
  const r2 = await models.fetchTo(url('/flaky'), dest, null, { proxy: null })
  const used = state.ranges.find((row) => row.path === '/flaky')
  check(
    '第二次请求带上了 Range（从断点开始，不是从 0）',
    Boolean(used) && used.range === `bytes=${half}-`,
    used ? used.range : '没带 Range'
  )
  check('续传之后内容与源文件逐字节一致', sha1(readPart(dest)) === BODY_SHA, `${r2.bytes} 字节`)
}

/* ④ 下载器内部的"重试两次"必须**接着下**，而不是从 0 重来
 *    （这条钉的是 downloadOne：它曾经在 catch 里删 .part，于是每次抖动都清零，
 *      表现是进度条反复弹回 0 —— 闸门只测 fetchTo 的话根本看不见这一层） */
{
  const dest = path.join(WORK, 'one-attempt.bin')
  state.ranges.length = 0
  let err = null
  try {
    await models.downloadOne([url('/flaky2')], dest, null, { proxy: null })
  } catch (e) {
    err = e
  }
  const pick = state.ranges.filter((row) => row.path === '/flaky2')
  // 探测请求（bytes=0-0）不算"带断点"，它只是问一句"能不能分段"
  const retry = pick.find((row) => row.range && row.range !== 'bytes=0-0')
  check(
    'downloadOne 内部重试成功后拿到完整文件',
    !err && sha1(readPart(dest)) === BODY_SHA,
    err ? String(err.message).slice(0, 60) : `${readPart(dest).length} 字节`
  )
  check(
    '重试带的是断点 Range（不是从 0 重来）',
    Boolean(retry) && Number(retry.range.replace(/[^0-9]/g, '')) > 0,
    retry ? retry.range : '重试时没带 Range'
  )
}

/* ⑤ 服务器不认 Range（回 200 整份）⇒ 必须整份重写，不能追加 */
{
  const dest = path.join(WORK, 'norange.bin')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(partOf(dest), Buffer.alloc(1024, 0x7a)) // 假装上次留下的半截（内容其实是垃圾）
  fs.writeFileSync(
    `${partOf(dest)}.json`,
    JSON.stringify({ url: url('/norange'), etag: '"solid"', total: BODY.length })
  )
  await models.fetchTo(url('/norange'), dest, null, { proxy: null })
  const got = readPart(dest)
  check(
    '服务器忽略 Range（回 200）时整份重写，不把旧字节留在开头',
    got.length === BODY.length && sha1(got) === BODY_SHA,
    `${got.length} 字节`
  )
}

/* ⑥ 416（手里的比服务器上的还长）⇒ 丢掉半截从头再来一次 */
{
  const dest = path.join(WORK, 'r416.bin')
  fs.writeFileSync(partOf(dest), Buffer.alloc(BODY.length + 1000, 0x11))
  fs.writeFileSync(`${partOf(dest)}.json`, JSON.stringify({ url: url('/r416'), etag: '"solid"' }))
  let err = null
  try {
    await models.fetchTo(url('/r416'), dest, null, { proxy: null })
  } catch (e) {
    err = e
  }
  check(
    '416 之后自动从 0 重下（不是直接把错抛给用户）',
    !err && sha1(readPart(dest)) === BODY_SHA,
    err ? String(err.message).slice(0, 60) : '重下成功'
  )
}

/* ⑦ 换源：半截文件来自另一个地址，只能从头下（否则拼出"体积对、内容错"） */
{
  const dest = path.join(WORK, 'switch.bin')
  fs.writeFileSync(partOf(dest), BODY.subarray(0, 300 * 1024))
  fs.writeFileSync(`${partOf(dest)}.json`, JSON.stringify({ url: url('/solid'), etag: '"solid"' }))
  const r = await models.fetchTo(url('/other'), dest, null, { proxy: null })
  const got = readPart(dest)
  check(
    '换源后从 0 重下（旧 .part 不参与拼接）',
    got.length === OTHER.length && sha1(got) === OTHER_SHA,
    `${r.resumedFrom} 字节起点`
  )
  check('换源结果不等于旧源内容（证明没有拼接）', sha1(got) !== BODY_SHA, '')
}

/* ⑧ 302 重定向要跟（HF 镜像会 302 到 CDN） */
{
  const dest = path.join(WORK, 'redir.bin')
  await models.fetchTo(url('/redir'), dest, null, { proxy: null })
  check('302 跟到真地址并把文件下完', sha1(readPart(dest)) === BODY_SHA, '')
}

/* ⑨ 代理：真 CONNECT 代理 + 端到端下载 */
{
  proxyTunnel.agentFor.cache && proxyTunnel.agentFor.cache.clear?.()
  const proxy = { protocol: 'http:', host: '127.0.0.1', port: proxyPort, auth: 'u:p', raw: `http://127.0.0.1:${proxyPort}` }
  const dest = path.join(WORK, 'via-proxy.bin')
  tunnelLog.length = 0
  let err = null
  try {
    await models.fetchTo(url('/solid'), dest, null, { proxy })
  } catch (e) {
    err = e
  }
  const line = tunnelLog[0]
  check(
    '走代理时先发 CONNECT（而不是裸连目标）',
    Boolean(line) && line.head.startsWith(`CONNECT 127.0.0.1:${port} `),
    line ? line.head : '代理没收到 CONNECT'
  )
  check(
    '代理认证头按 Basic 送出',
    Boolean(line) && line.auth === Buffer.from('u:p').toString('base64'),
    line ? line.auth : '空'
  )
  check('经代理下载的内容与直连逐字节一致', !err && sha1(readPart(dest)) === BODY_SHA, err ? String(err.message).slice(0, 60) : '')
}

/* ⑩ 代理连不上时必须退回直连
 *    （陈旧系统代理是常态：注册表里 ProxyEnable=1、端口却是上次那个代理程序的，
 *      不退回的话「下载模型」在那种机器上等于永久坏掉，而错因看起来只是"服务器无响应"） */
{
  const probe = net.createServer()
  const closedPort = await listen(probe)
  probe.close() // 关掉之后这个端口一定没人监听
  const deadProxy = {
    protocol: 'http:',
    host: '127.0.0.1',
    port: closedPort,
    auth: '',
    raw: `http://127.0.0.1:${closedPort}`
  }
  const dest = path.join(WORK, 'dead-proxy.bin')
  let err = null
  try {
    await models.fetchTo(url('/solid'), dest, null, { proxy: deadProxy })
  } catch (e) {
    err = e
  }
  check(
    '代理连不上时自动退回直连（一条死代理不该废掉下载）',
    !err && sha1(readPart(dest)) === BODY_SHA,
    err ? String(err.message).slice(0, 70) : '直连兜底成功'
  )
}

/* ⑪ 代理解析：环境变量 / 注册表两种写法都要认 */
{
  const p1 = proxyTunnel.parseProxyString('127.0.0.1:7890')
  check('裸 host:port 当作 http 代理', p1 && p1.protocol === 'http:' && p1.host === '127.0.0.1' && p1.port === 7890, JSON.stringify(p1))
  const p2 = proxyTunnel.parseProxyString('http://u:p@127.0.0.1:8080')
  check('带账号密码的代理能解析出认证串', p2 && p2.auth === 'u:p', p2 ? p2.auth : 'null')
  check('socks5 明确不支持（返回 null，退回直连而不是假装成功）', proxyTunnel.parseProxyString('socks5://127.0.0.1:1080') === null, '')
  check(
    '注册表多协议写法优先取 https 项',
    proxyTunnel.parseWindowsProxyServer('http=1.2.3.4:80;https=5.6.7.8:8080') === '5.6.7.8:8080',
    String(proxyTunnel.parseWindowsProxyServer('http=1.2.3.4:80;https=5.6.7.8:8080'))
  )
  const env = proxyTunnel.pickProxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' })
  check('环境变量按 https_proxy 优先', env && env.source === 'HTTPS_PROXY', env ? env.source : 'null')
  check('no_proxy 里的本机地址要绕开代理', proxyTunnel.shouldBypass('127.0.0.1', { no_proxy: 'localhost,127.0.0.1' }), '')
}

/* ⑫ 多连接并行下载：什么时候并发、断了一段怎么续、不支持 Range 怎么退
 *
 *  这一层的错法全都"看起来像下载成功"：
 *    · 服务器把整份发给了某一段 ⇒ 拼出来长度对、内容全错（体积校验失明）；
 *    · 重试时把已下完的段重下一遍 ⇒ 228MB 再走一趟，用户只看到"又在装"；
 *    · 段长差一字节 ⇒ 拼出来首尾错位。
 *  所以这里逐条钉：请求形状、字节内容、重试范围、残渣清理。 */
{
  // 几百 KB 的样本上验分段：阈值调到 64KB / 16KB，行为与 78MB 的模型完全同一条代码路径
  const fast = { parts: 4, minBytes: 64 * 1024, minPartBytes: 16 * 1024 }
  const segReqs = (pathname) =>
    state.ranges
      .filter((row) => row.path === pathname)
      .map((row) => row.range)
      .filter((x) => /^bytes=\d+-\d+$/.test(x) && x !== 'bytes=0-0')

  /* ⑫-1 支持 Range 的大文件：先探测，再发多个闭合区间，拼出来逐字节一致 */
  {
    const dest = path.join(WORK, 'seg.bin')
    state.ranges.length = 0
    const r = await models.fetchTo(url('/solid'), dest, null, { proxy: null, parallel: fast })
    const rows = state.ranges.filter((row) => row.path === '/solid').map((row) => row.range)
    const starts = segReqs('/solid').map((x) => Number(x.match(/^bytes=(\d+)-/)[1]))
    check(
      '大文件走分段：先探测，再发 4 个不同起点的闭合区间请求',
      rows.includes('bytes=0-0') && new Set(starts).size === 4,
      starts.length ? starts.sort((a, b) => a - b).join(',') : `只发了 ${rows.join(' ')}`
    )
    check('分段下载结果与源文件逐字节一致', sha1(readPart(dest)) === BODY_SHA, `${r.bytes} 字节`)
    check('分段下完不留 .seg 残渣', segLeft(dest) === 0, `剩 ${segLeft(dest)} 个`)
  }

  /* ⑫-2 慢速源站：四条连接**真的同时在飞**，而且确实换来提速
   *
   *  「发了 4 个 Range 请求」不等于并发 —— 串行发也是 4 个请求。
   *  所以这里既看同时在飞的连接数（确定性判据），也看总耗时（人真正感知的东西）。
   *  两条都要，缺一条就会漏掉"看起来并发了、其实是排队"这种实现。 */
  {
    state.maxInflight = 0
    state.ranges.length = 0
    const t0 = Date.now()
    await models.fetchTo(url('/slow'), path.join(WORK, 'slow-single.bin'), null, { proxy: null, parallel: { parts: 1 } })
    const singleMs = Date.now() - t0
    const singleInflight = state.maxInflight

    state.maxInflight = 0
    const t1 = Date.now()
    await models.fetchTo(url('/slow'), path.join(WORK, 'slow-multi.bin'), null, { proxy: null, parallel: fast })
    const multiMs = Date.now() - t1

    /* 先证明这把尺子本身是准的：单路时最多只该有 1 条在飞。
       没有这一条，"观测到 4 条"可能只是计数器写错了。 */
    check('单路下载时在飞连接数是 1（尺子本身可信）', singleInflight === 1, `观测到 ${singleInflight} 条`)
    check('慢速源站上四条连接真的同时在飞（不是排队）', state.maxInflight === 4, `观测到同时在飞 ${state.maxInflight} 条`)
    check(
      '并发确实换来提速（4 路耗时不到单路的 60%）',
      multiMs < singleMs * 0.6,
      `单路 ${singleMs}ms → 4 路 ${multiMs}ms（${(singleMs / multiMs).toFixed(2)}×）`
    )
    check(
      '两条路下到的字节完全一致',
      sha1(readPart(path.join(WORK, 'slow-single.bin'))) === sha1(readPart(path.join(WORK, 'slow-multi.bin'))),
      ''
    )
  }

  /* ⑫-3 停滞：既不报错也不结束的下载必须被看门狗掐断
   *
   *  30 秒的 socket 空闲超时抓不到"每秒挤几个字节"或"发一段就不动了"——
   *  本机实测 4 路里有一路十分钟只收到 123KB，其余三路各下了十几 MB，
   *  而它一直算"有数据"。没有这条看门狗，并发反而会把整次下载拖死。 */
  {
    const dest = path.join(WORK, 'stalled.bin')
    const t0 = Date.now()
    let err = null
    try {
      await withTimeout(models.fetchTo(url('/stall'), dest, null, { proxy: null, stallMs: 1200, stallBytes: 64 * 1024 }), 15000)
    } catch (e) {
      err = e
    }
    const ms = Date.now() - t0
    check('停滞的下载被掐断并报错（不是无限挂着）', Boolean(err) && /停滞/.test(String(err.message)), err ? String(err.message).slice(0, 60) : '居然成功了')
    check('掐断发生在看门狗时限内（没有空等到天荒地老）', ms < 6000, `${ms}ms`)
    check('掐断后半截字节留着（下次能续）', readPart(dest).length > 0, `留下 ${readPart(dest).length} 字节`)
  }

  /* ⑫-4 某一段被掐断 ⇒ 重试**只补那一段**（这条是本轮真正的目的） */
  {
    const dest = path.join(WORK, 'seg-retry.bin')
    let err = null
    try {
      await models.fetchTo(url('/cutseg'), dest, null, { proxy: null, parallel: fast })
    } catch (e) {
      err = e
    }
    check('分段中途有一段被掐断：如实报错（不许拼出残缺文件）', Boolean(err), err ? String(err.message).slice(0, 50) : '居然成功了')

    state.ranges.length = 0
    const r2 = await models.fetchTo(url('/cutseg'), dest, null, { proxy: null, parallel: fast })
    const again = segReqs('/cutseg')
    const from = again.length ? Number(again[0].match(/^bytes=(\d+)-/)[1]) : -1
    check(
      '重试只补缺的那一段（已下完的三段不再请求）',
      again.length === 1 && from >= CUT_SEG_FROM,
      `${again.length} 段 · 起点 ${from}（被掐的那段从 ${CUT_SEG_FROM} 起）`
    )
    check('分段续传之后内容与源文件一致', sha1(readPart(dest)) === BODY_SHA, `${r2.bytes} 字节`)
  }

  /* ⑫-3 服务器不认 Range：探测就该发现，一个分段请求都不发，直接单流下完 */
  {
    const dest = path.join(WORK, 'seg-norange.bin')
    state.ranges.length = 0
    await models.fetchTo(url('/norange'), dest, null, { proxy: null, parallel: fast })
    const sent = segReqs('/norange')
    check('探测发现不认 Range 时一个分段请求都不发', sent.length === 0, sent.join(' ') || '一个都没发')
    check('退回单流后内容正确且不留分段文件', sha1(readPart(dest)) === BODY_SHA && segLeft(dest) === 0, `剩 ${segLeft(dest)} 个`)
  }

  /* ⑫-4 小文件不分段：几条连接的握手比省下的时间还贵 */
  {
    const dest = path.join(WORK, 'seg-small.bin')
    state.ranges.length = 0
    await models.fetchTo(url('/solid'), dest, null, { proxy: null })
    const sent = segReqs('/solid')
    check('低于阈值的文件不分段（默认参数下 700KB 走单流）', sent.length === 0 && segLeft(dest) === 0, `${sent.length} 个分段请求`)
  }

  /* ⑫-5 换源：旧的分段文件必须一起清掉，否则会拼进另一个版本 */
  {
    const dest = path.join(WORK, 'seg-switch.bin')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(`${partOf(dest)}.seg0`, Buffer.alloc(1024, 0x22))
    fs.writeFileSync(`${partOf(dest)}.seg3`, Buffer.alloc(1024, 0x33))
    fs.writeFileSync(
      `${partOf(dest)}.json`,
      JSON.stringify({ url: url('/other'), etag: '"other"', total: 4096, mode: 'segmented', parts: 4 })
    )
    await models.fetchTo(url('/solid'), dest, null, { proxy: null, parallel: fast })
    check(
      '换源时旧的分段文件一起清掉（否则两个版本会拼在一起）',
      segLeft(dest) === 0 && sha1(readPart(dest)) === BODY_SHA,
      `剩 ${segLeft(dest)} 个`
    )
  }
}

/* ⑭ 删除模型要连带清掉分段残留
 *
 *  「删了模型，磁盘没变」这类残留没人会发现：占用统计把它算进去，用户以为没删掉；
 *  下次装的时候这些段还会被当成"上次下到一半"直接复用 —— 而它来自另一次安装。 */
{
  const userData = path.join(WORK, 'ud-remove')
  const entry = models.REGISTRY.find((e) => e.id === 'speech-paraformer')
  const dir = path.join(userData, 'models', entry.id)
  fs.mkdirSync(dir, { recursive: true })
  for (const item of entry.files) {
    for (const name of [item.name, `${item.name}.part`, `${item.name}.part.json`, `${item.name}.part.seg0`, `${item.name}.part.seg1`]) {
      fs.writeFileSync(path.join(dir, name), Buffer.alloc(16, 1))
    }
  }
  const before = fs.readdirSync(dir).length
  models.remove('speech-paraformer', { userData })
  const left = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0
  check('删除模型时连带清掉 .part.seg 残留（否则占磁盘、骗占用统计）', before > 0 && left === 0, `删前 ${before} 个 / 删后 ${left} 个`)
}

/* ⑬ 注册表：每个 HF 文件都必须有真镜像在前，且三个地址指向同一个仓库路径 */
{
  const files = models.REGISTRY.flatMap((e) => e.files.map((f) => ({ id: e.id, name: f.name, url: f.url || '', alt: f.alt || [] })))
  const hfFiles = files.filter((f) => /^https:\/\/hf-mirror\.com\//.test(f.url))
  const missingMirror = hfFiles.filter((f) => !f.alt.some((u) => u.startsWith('https://hf-mirror.net/')))
  check(
    `HF 的 ${hfFiles.length} 个文件都挂了第二镜像（hf-mirror.net）`,
    hfFiles.length >= 15 && missingMirror.length === 0,
    missingMirror.map((f) => `${f.id}/${f.name}`).join(', ') || '全齐'
  )
  const officialFirst = files.filter((f) => /^https:\/\/(huggingface\.co|github\.com)\//.test(f.url))
  check(
    '没有任何文件把官方源（huggingface.co / github.com）排在第一位',
    officialFirst.length === 0,
    officialFirst.map((f) => `${f.id}/${f.name}`).join(', ') || '无'
  )
  const pathMismatch = hfFiles.filter((f) => {
    const p0 = new URL(f.url).pathname
    return f.alt.some((u) => {
      try {
        return new URL(u).pathname !== p0
      } catch {
        return true
      }
    })
  })
  check(
    '同一文件的三个地址路径一致（否则会下到不同版本，体积校验拦不住）',
    pathMismatch.length === 0,
    pathMismatch.map((f) => `${f.id}/${f.name}`).join(', ') || '一致'
  )
}

server.close()
proxyServer.close()
try {
  fs.rmSync(WORK, { recursive: true, force: true })
} catch {
  /* 临时目录删不掉不影响判定 */
}

const coverage = ran === TOTAL_ASSERTIONS ? 0 : 1
if (coverage) console.log(`  [FAIL] 断言覆盖 · 期望 ${TOTAL_ASSERTIONS} 项，实际跑了 ${ran} 项`)
const fail = failures + coverage
const pass = ran - failures
console.log(`\n=== 结果：通过 ${pass} 项 / 失败 ${fail} 项 ===`)
console.log(`DOWNLOAD_RESUME_STATS total=${TOTAL_ASSERTIONS} pass=${pass} fail=${fail} skip=0`)
if (!fail) console.log('DOWNLOAD_RESUME_OK')
process.exit(fail ? 1 : 0)
