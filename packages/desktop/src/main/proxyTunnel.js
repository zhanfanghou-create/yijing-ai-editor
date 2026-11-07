'use strict'

/**
 * 代理发现 + HTTPS CONNECT 隧道（纯 Node，不 require electron）。
 *
 * ── 为什么非做不可（2026-11-06 实测）────────────────────────────────────
 * 下载器走 `node:https`，而 `node:https` **不读** `https_proxy` 环境变量，
 * 也不看 Windows 的「系统代理」开关 —— 它只会直连。于是：
 *   ① 用户开着 Clash / V2Ray（系统代理已开）⇒ 应用仍在裸奔，
 *      github.com / huggingface.co 直连超时；
 *   ② 同一个地址 `curl` 能下、应用下不动 ⇒ 现场看起来像「软件坏了」。
 * 这两条本机都撞过：curl 认代理、node:https 不认，所以**不能拿 curl 自证**。
 *
 * ── 支持的形态 ───────────────────────────────────────────────────────
 *   http://host:port          最常见（先 CONNECT 再在隧道里跑 TLS）
 *   https://host:port         代理自身是 TLS
 *   http://user:pass@host:port
 * 明确**不支持 socks5**：Node 标准库没有 SOCKS 客户端，自己实现握手是另一个量级的
 * 风险（写错的表现是「偶尔能连」，比连不上更难查）。而开 socks 的用户
 * 在客户端里通常同时开着一个 HTTP 端口，够用。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 * 隧道只有两种结局：CONNECT 回 200 且字节能双向流，或明确报错。
 * 不许「先假装成功、等 TLS 握手时才失败」—— 那个错会落在 https 层，
 * 提示是 `socket hang up`，跟代理没关系，查起来要命。
 */

const net = require('node:net')
const tls = require('node:tls')
const http = require('node:http')
const https = require('node:https')
const { execFile } = require('node:child_process')

/** CONNECT 握手本身的上限（不含真实传输）。局域网代理通常 <100ms，15s 已经很宽 */
const HANDSHAKE_TIMEOUT_MS = 15000
/** 系统代理查一次用一阵子：用户改代理设置后最多等这么久才生效，换取不每次下载都 spawn */
const REGISTRY_CACHE_MS = 30000
/** 代理返回的响应头上限，防止对端狂发数据把内存吃满 */
const MAX_HEAD_BYTES = 64 * 1024

/**
 * 解析一个代理地址字符串。
 *
 * 注册表里 `ProxyServer` 常见两种写法：`127.0.0.1:7890` 和
 * `http=127.0.0.1:7890;https=127.0.0.1:7890`（后者由 parseWindowsProxyServer 先拆）。
 *
 * @returns {{protocol:string, host:string, port:number, auth:string, raw:string}|null}
 */
function parseProxyString(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  // 没有 scheme 时按 HTTP 代理处理（注册表的裸 host:port 就是这个意思）
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let u
  try {
    u = new URL(withScheme)
  } catch {
    return null
  }
  // socks 明确不支持：宁可当作「没有代理」（走直连），也不要在隧道里假装成功
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  if (!u.hostname || !port) return null
  const auth = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}` : ''
  return { protocol: u.protocol, host: u.hostname, port, auth, raw: withScheme }
}

/** 环境变量里挑代理：大小写两种都认，`all_proxy` 排后面（它也可能是 socks，解析时会被挡掉） */
function pickProxyFromEnv(env = process.env) {
  const order = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']
  for (const name of order) {
    const value = String(env[name] || '').trim()
    if (value) return { raw: value, source: name }
  }
  return null
}

/**
 * 拆 Windows `ProxyServer` 的值。
 * `http=a:1;https=b:2;socks=c:3` → 优先 https 项；只有 socks 项时返回 null（不支持）。
 */
function parseWindowsProxyServer(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  if (!text.includes('=')) return text
  const table = {}
  for (const part of text.split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const key = part.slice(0, at).trim().toLowerCase()
    const value = part.slice(at + 1).trim()
    if (key && value) table[key] = value
  }
  return table.https || table.http || null
}

/**
 * `no_proxy` / `NO_PROXY`：本机地址、内网段不该走代理。
 * 支持 `*`、后缀匹配（`.corp.local` 与 `corp.local` 等价）、带端口写法。
 */
function shouldBypass(host, env = process.env) {
  const text = String(env.no_proxy || env.NO_PROXY || '').trim()
  if (!text) return false
  const target = String(host || '').toLowerCase()
  if (!target) return false
  return text
    .split(/[,\s]+/)
    .filter(Boolean)
    .some((item) => {
      const rule = item.trim().toLowerCase().replace(/^\./, '')
      if (rule === '*') return true
      const name = rule.includes(':') ? rule.split(':')[0] : rule
      return target === name || target.endsWith(`.${name}`)
    })
}

/**
 * 读 Windows 系统代理。
 *
 * 只认 `ProxyEnable=0x1` —— 值为 0 时 `ProxyServer` 往往是**上次留下的陈旧地址**
 * （本机就有一条 `127.0.0.1:3067`，代理早关了），照着它连只会让所有下载都失败，
 * 而错误长得像「网络不通」。
 */
function readWindowsProxy() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const text = String(stdout)
        if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(text)) return resolve(null)
        const hit = text.match(/ProxyServer\s+REG_SZ\s+(.+)/i)
        resolve(hit ? hit[1].trim() : null)
      }
    )
  })
}

let registryCache = { at: 0, value: null }

/**
 * 找出「这次下载该不该走代理」。
 *
 * 顺序：环境变量（开发/CLI 场景）→ Windows 注册表（普通用户场景）。
 * macOS/Linux 上只认环境变量：那边系统代理存在 GNOME/KDE 的配置里，
 * 没有命令行可读的稳定接口，硬读不如不读。
 *
 * @param {{env?:object, platform?:string, readRegistry?:Function, noCache?:boolean}} [opts]
 * @returns {Promise<{protocol:string,host:string,port:number,auth:string,raw:string,source:string}|null>}
 */
async function detectProxy(opts = {}) {
  const env = opts.env || process.env
  const fromEnv = pickProxyFromEnv(env)
  if (fromEnv) {
    const parsed = parseProxyString(fromEnv.raw)
    if (parsed) return { ...parsed, source: fromEnv.source }
  }

  const platform = opts.platform || process.platform
  if (platform !== 'win32') return null

  const now = Date.now()
  if (!opts.noCache && !opts.readRegistry && now - registryCache.at < REGISTRY_CACHE_MS) {
    return registryCache.value
  }
  const reader = opts.readRegistry || readWindowsProxy
  const raw = parseWindowsProxyServer(await reader())
  const parsed = parseProxyString(raw)
  const result = parsed ? { ...parsed, source: 'win32-registry' } : null
  if (!opts.readRegistry) registryCache = { at: now, value: result }
  return result
}

/**
 * 在代理上开一条隧道连到 host:port（成功时返回**已握手完成**的 socket）。
 *
 * 隧道里的字节是原样的（对 TLS 来说就是一个干净的 TCP 通道）。
 * 单独导出是为了能被闸门直接测：本机起一个真 CONNECT 代理，
 * 断言请求行、认证头、以及隧道内的双向字节。
 */
function openTunnel(proxy, host, port, options = {}) {
  const timeout = options.timeout || HANDSHAKE_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const proxyTls = proxy.protocol === 'https:'
    const carrier = proxyTls
      ? tls.connect({
          host: proxy.host,
          port: proxy.port,
          servername: proxy.host,
          rejectUnauthorized: options.rejectUnauthorized !== false
        })
      : net.connect({ host: proxy.host, port: proxy.port })

    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      carrier.destroy()
      /* 打上标记：调用方据此判断「这条路根本没建起来」。
         这类错**必须能退回直连** —— 用户把系统代理留在注册表里但代理程序早关了，
         是极常见的情形（本机的 ProxyServer 就留着一条 3067 的陈旧值），
         不退回直连的话，下载功能在那种机器上等于不存在。 */
      if (err && !err.proxyTunnel) err.proxyTunnel = true
      reject(err)
    }

    const timer = setTimeout(() => {
      fail(new Error(`代理握手超时（${proxy.host}:${proxy.port}）`))
    }, timeout)

    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > MAX_HEAD_BYTES) fail(new Error('代理返回的响应头过大（不是 HTTP 代理？）'))
        return
      }
      carrier.removeListener('data', onData)
      clearTimeout(timer)

      const head = buf.subarray(0, end).toString('latin1')
      const rest = buf.subarray(end + 4)
      const status = Number((head.match(/^HTTP\/1\.[01]\s+(\d{3})/i) || [])[1] || 0)
      if (status !== 200) {
        // 407 是没给认证 / 认证错；403 是代理策略不许连这个站
        fail(new Error(`代理拒绝建立隧道：HTTP ${status || '?'}（${proxy.host}:${proxy.port}）`))
        return
      }
      if (rest.length) carrier.unshift(rest)
      settled = true
      carrier.setTimeout(0)
      resolve(carrier)
    }

    carrier.on('data', onData)
    carrier.on('error', (err) => {
      fail(new Error(`连不上代理 ${proxy.host}:${proxy.port}：${err.message}`))
    })

    const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'Proxy-Connection: keep-alive']
    if (proxy.auth) {
      lines.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}`)
    }
    const send = () => {
      if (settled) return
      carrier.write(`${lines.join('\r\n')}\r\n\r\n`)
    }
    if (proxyTls) carrier.once('secureConnect', send)
    else carrier.once('connect', send)
  })
}

/** https 走隧道：隧道里再起 TLS（servername 必须是目标站，不是代理） */
class HttpsTunnelAgent extends https.Agent {
  constructor(proxy, options = {}) {
    super({ keepAlive: false, ...options })
    this.proxy = proxy
  }

  createConnection(options, callback) {
    const host = options.host
    const port = Number(options.port) || 443
    openTunnel(this.proxy, host, port, { rejectUnauthorized: options.rejectUnauthorized })
      .then((carrier) => {
        const secure = tls.connect({
          socket: carrier,
          servername: host,
          rejectUnauthorized: options.rejectUnauthorized !== false
        })
        secure.once('error', (err) => callback(err))
        secure.once('secureConnect', () => callback(null, secure))
      })
      .catch((err) => callback(err))
  }
}

/** http 走隧道：CONNECT 到 80 端口，隧道里直接说明文 HTTP（代理只转字节，不解析） */
class HttpTunnelAgent extends http.Agent {
  constructor(proxy, options = {}) {
    super({ keepAlive: false, ...options })
    this.proxy = proxy
  }

  createConnection(options, callback) {
    openTunnel(this.proxy, options.host, Number(options.port) || 80)
      .then((carrier) => callback(null, carrier))
      .catch((err) => callback(err))
  }
}

const agentCache = new Map()

/**
 * 取（并缓存）一个走隧道的 agent。没有代理时返回 `undefined` ——
 * `http(s).get` 收到 undefined 就是默认直连，不用特判。
 */
function agentFor(proxy, secure) {
  if (!proxy) return undefined
  const key = `${secure ? 'https' : 'http'}|${proxy.raw || `${proxy.host}:${proxy.port}`}`
  if (!agentCache.has(key)) {
    agentCache.set(key, secure ? new HttpsTunnelAgent(proxy) : new HttpTunnelAgent(proxy))
  }
  return agentCache.get(key)
}

/** 给界面/日志用的一句话描述（不暴露账号密码） */
function describe(proxy) {
  if (!proxy) return '直连'
  const auth = proxy.auth ? '（带认证）' : ''
  return `经代理 ${proxy.host}:${proxy.port}${auth}`
}

module.exports = {
  HANDSHAKE_TIMEOUT_MS,
  parseProxyString,
  parseWindowsProxyServer,
  pickProxyFromEnv,
  shouldBypass,
  readWindowsProxy,
  detectProxy,
  openTunnel,
  agentFor,
  describe
}
