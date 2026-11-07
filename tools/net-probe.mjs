#!/usr/bin/env node
/* 下载源可达性探测 —— 给「必须真联网」的闸门做前置判断。
 *
 * 为什么必须有前置判断（2026-11-03 实录）：
 *   识别字幕那道闸门要真下 78MB，镜像站一抖就整道红。于是"红"这一个信号
 *   同时代表两件完全不同的事：① 功能坏了；② 这台机器此刻上不了网。
 *   两者的处置完全相反，却长得一样 —— 结果是人先去查功能，白花半小时
 *   （本轮就在 hf-mirror/DNS/代理上绕了很久，最后发现网络当时确实断了一下）。
 *   更糟的是长期代价：一道"经常红但不是我们的错"的闸门，会训练人无脑忽略它，
 *   那时它连真缺陷也挡不住了。
 *
 * 所以：**网络不可达 ⇒ SKIP（如实说没验证），可达但下不下来 ⇒ 红（真问题）**。
 *   这个划分和项目既有的"没有 ffmpeg 就记 SKIP"是同一条纪律。
 *
 * ⚠️ 必须用 node:https，不能用 curl：
 *   curl 会读 https_proxy（本机 127.0.0.1:12709），而应用下载走的是 node:https，
 *   不认代理变量。拿 curl 的"能下"当"应用能下"的证据会得出完全相反的结论 ——
 *   本轮就是靠这条差别才定位到 GitHub 源在国内恒不可用。
 */
import https from 'node:https'

/**
 * 探一个地址是否可达。判据是「连上并拿到 HTTP 响应」，不要求 2xx ——
 * 镜像站常用 307 跳转到真实存储，那也是可达。
 * @param {string} url
 * @param {number} timeoutMs 默认 15s（够慢网握手，又不至于让闸门干等）
 * @returns {Promise<boolean>}
 */
export function reachable(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    try {
      const req = https.get(
        url,
        { headers: { 'User-Agent': 'YJAI-ModelManager' }, timeout: timeoutMs },
        (res) => {
          /* 不读 body：只想知道"通不通"，读 78MB 就本末倒置了 */
          res.resume()
          done(true)
        }
      )
      req.on('timeout', () => {
        req.destroy()
        done(false)
      })
      req.on('error', () => done(false))
    } catch {
      done(false)
    }
  })
}
