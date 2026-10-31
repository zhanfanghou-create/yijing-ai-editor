#!/usr/bin/env node
/**
 * 闸门：**智能体全流程自动化**（镜枢 ↔ 剪辑软件的真实取证）。
 *
 * 别的闸门验的是"代码里有没有那行"，这一道验的是"agent 只靠工具调用，能不能把
 * 一条片子做出来"。做法与镜枢完全一致：把 `mcp-server.js` 当 stdio 子进程拉起，
 * 一句句发 JSON-RPC，全程不碰界面、不碰内部函数。
 *
 * 判据一律读**消费端**：
 *   · 编码/分辨率/帧率/时长/有没有音轨 → ffprobe 读成片；
 *   · 滤镜真的进去了没有 → 抽一帧算 `max|r-g|`（纯红素材套 mono 之后必须变灰）；
 *   · 字幕真的烧进去了没有 → 底部区域亮像素数（白字描边，不是靠"返回 ok"）；
 *   · 封面真的生成了没有 → 文件存在 + 尺寸可解。
 *
 * 用法：node tools/mcp-agent-e2e.mjs
 * 依赖：tools/fixtures/mcp-base.mp4（node tools/gen-mcp-fixture.mjs 可重建）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnCapture } from './spawn-capture.mjs'
import { EXPECTED_TOOLS } from './mcp-tools-list.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SERVER = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'mcp-server.js')
const FIX_VIDEO = path.join(__dirname, 'fixtures', 'mcp-base.mp4')
const FIX_SRT = path.join(__dirname, 'fixtures', 'mcp-subs.srt')

const require = createRequire(import.meta.url)
/* 画面比例的尺寸推导与界面**同一份**（shared/aspect.js）：
   9:16 是"从基准分辨率里裁出竖屏最大内接矩形"，不是把 720p 放大到 1280 高 */
const ASPECT = require(path.join(ROOT, 'packages', 'desktop', 'src', 'shared', 'aspect.js'))

/** 断言的条数（改动断言必须同步 scripts/verify.mjs 的 expected） */
export const TOTAL_ASSERTIONS = 25

const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobeBin = () => {
  const ff = ffmpegBin()
  const dir = path.dirname(ff)
  const probe = path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  return fs.existsSync(probe) ? probe : 'ffprobe'
}

/* ------------------------------ MCP 客户端 ------------------------------ */

class Client {
  constructor(proc) {
    this.proc = proc
    this.id = 0
    this.pending = new Map()
    this.buf = ''
    this.stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      this.buf += chunk
      const lines = this.buf.split('\n')
      this.buf = lines.pop() || ''
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        let msg = null
        try {
          msg = JSON.parse(text)
        } catch {
          continue
        }
        const waiter = this.pending.get(msg.id)
        if (waiter) {
          this.pending.delete(msg.id)
          waiter.resolve(msg)
        }
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (c) => {
      this.stderr += c
    })
  }

  rpc(method, params, timeoutMs = 180000) {
    const id = ++this.id
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg)
        }
      })
      this.proc.stdin.write(JSON.stringify(payload) + '\n')
    })
  }

  async tool(name, args = {}) {
    const msg = await this.rpc('tools/call', { name, arguments: args })
    const result = msg.result || {}
    const text = result.content && result.content[0] ? result.content[0].text : ''
    if (result.isError) {
      const err = new Error(text || '工具报错')
      err.isError = true
      throw err
    }
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text }
    }
  }

  close() {
    try {
      this.proc.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill()
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 度量工具 ------------------------------ */

function probeFile(file) {
  const res = spawnCapture(ffprobeBin(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 60000 })
  if (res.status !== 0) return null
  try {
    return JSON.parse(res.stdout)
  } catch {
    return null
  }
}

/** 抽一帧成 rgb24 原始像素（不落盘：走临时文件，本机管道 EBUSY） */
function frameAt(file, at, width, height) {
  const tmp = path.join(os.tmpdir(), `yjai-frame-${process.pid}-${Date.now().toString(36)}.rgb`)
  const res = spawnCapture(
    ffmpegBin(),
    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', tmp],
    { timeout: 60000 }
  )
  if (res.status !== 0 || !fs.existsSync(tmp)) return null
  const buf = fs.readFileSync(tmp)
  try {
    fs.unlinkSync(tmp)
  } catch {
    /* ignore */
  }
  if (buf.length < width * height * 3) return null
  return buf
}

function metrics(buf, width, height, region = { x: 0, y: 0, w: 1, h: 1 }) {
  const x0 = Math.floor(region.x * width)
  const y0 = Math.floor(region.y * height)
  const x1 = Math.min(width, Math.floor((region.x + region.w) * width))
  const y1 = Math.min(height, Math.floor((region.y + region.h) * height))
  let maxSpread = 0
  let bright = 0
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 3
      const r = buf[i]
      const g = buf[i + 1]
      const b = buf[i + 2]
      const spread = Math.max(r, g, b) - Math.min(r, g, b)
      if (spread > maxSpread) maxSpread = spread
      if (r > 200 && g > 200 && b > 200) bright += 1
      sum += (r + g + b) / 3
      n += 1
    }
  }
  return { maxSpread, bright, mean: n ? sum / n : 0, pixels: n }
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const pass = []
  const failed = []
  const record = (name, ok, detail = '') => {
    ;(ok ? pass : failed).push(name)
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —— ${detail}` : ''}`)
  }

  const missing = [SERVER, FIX_VIDEO, FIX_SRT].filter((p) => !fs.existsSync(p))
  if (missing.length) {
    console.error('缺输入：', missing.join(', '))
    console.log(`MCP_AGENT_STATS total=${TOTAL_ASSERTIONS} pass=0 fail=1`)
    console.log('MCP_AGENT_FAILED')
    process.exit(1)
  }

  const profile = path.join(os.tmpdir(), `yjai-mcp-e2e-${process.pid}`)
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(path.join(profile, 'drafts'), { recursive: true })
  const outDir = path.join(profile, 'out')
  fs.mkdirSync(outDir, { recursive: true })

  const env = { ...process.env, YIJAI_USER_DATA: profile, FFMPEG_PATH: ffmpegBin() }
  delete env.ELECTRON_RUN_AS_NODE

  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const client = new Client(proc)
  let realDone = false
  let pageErrors = ''

  try {
    /* 1. 握手 */
    const init = await client.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'yjai-e2e', version: '1.0.0' }
    })
    const info = init.result && init.result.serverInfo
    record('1. initialize 返回 serverInfo', Boolean(info && info.name === 'yijing-editor'), info ? `${info.name} ${info.version}` : '无')

    /* 2. 工具表 */
    const list = await client.rpc('tools/list')
    const tools = (list.result && list.result.tools) || []
    const names = tools.map((t) => t.name)
    const sameTable = names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n))
    record(`2. 工具表恰好 ${EXPECTED_TOOLS.length} 个且名字齐全`, sameTable, `实际 ${names.length}`)
    const schemaOk = tools.every((t) => t.description && t.description.length > 15 && t.inputSchema && t.inputSchema.type === 'object')
    record('3. 每个工具都有说明与 inputSchema（agent 靠它决定怎么调）', schemaOk)

    /* 4. 目录 */
    const cat = await client.tool('yijing_catalog')
    record(
      '4. catalog 给出贴纸/边框/滤镜清单',
      (cat.stickers || []).length >= 100 && (cat.borders || []).length >= 20 && (cat.filters || []).some((f) => f.key === 'mono'),
      `贴纸 ${(cat.stickers || []).length} / 边框 ${(cat.borders || []).length} / 滤镜 ${(cat.filters || []).length}`
    )

    /* 5. 建草稿 */
    const created = await client.tool('yijing_create_draft', { name: 'E2E 全流程', aspect: '16:9' })
    const draftId = created.draftId
    record('5. create_draft 返回 draftId', Boolean(draftId), draftId)

    /* 6. 上主轨（带 filter=mono，留给后面像素核验） */
    const added = await client.tool('yijing_add_clips', {
      draftId,
      clips: [{ path: FIX_VIDEO, track: 'video', start: 0, duration: 4, patch: { filter: 'mono', filterIntensity: 1 } }]
    })
    const mainClipId = added.added && added.added[0] && added.added[0].id
    record('6. add_clips 落地主轨片段（时长取自素材）', Boolean(mainClipId) && added.added[0].duration === 4, JSON.stringify(added.added && added.added[0]))

    /* 7. 字幕：直接读 SRT 文件（走界面同一份解析器） */
    const subs = await client.tool('yijing_add_subtitles', { draftId, file: FIX_SRT, style: 'sub-plain' })
    record('7. add_subtitles 从 SRT 解析出 3 条', subs.added === 3, `added=${subs.added}`)

    /* 8. 读回：片段数、四类轨道 */
    const draft1 = await client.tool('yijing_read_draft', { draftId })
    const tracks = new Set((draft1.data.clips || []).map((c) => c.track))
    record('8. read_draft 读回 4 个片段且含 video/text 两轨', (draft1.data.clips || []).length === 4 && tracks.has('video') && tracks.has('text'), `clips=${(draft1.data.clips || []).length}`)

    /* 9. 改属性：边框 / 转场 / 画面特效 / 关键帧 / 调节 —— 走归一化 */
    const patched = await client.tool('yijing_update_clip', {
      draftId,
      clipId: mainClipId,
      patch: {
        border: 'br-basic-white',
        transition: 'fade',
        transitionDuration: 0.6,
        frameFx: 'fx-vignette',
        adjust: { bright: 8, contrast: 12 },
        keyframes: [
          { prop: 'scale', at: 0, value: 100 },
          { prop: 'scale', at: 3, value: 112 }
        ]
      }
    })
    const pc = patched.clip || {}
    record(
      '9. update_clip 写入边框/转场/特效/关键帧（归一化生效）',
      pc.border === 'br-basic-white' && pc.transition === 'fade' && pc.frameFx === 'fx-vignette' && Array.isArray(pc.keyframes) && pc.keyframes.length === 2 && pc.adjust && pc.adjust.bright === 8,
      JSON.stringify({ border: pc.border, transition: pc.transition, frameFx: pc.frameFx, kf: (pc.keyframes || []).length })
    )

    /* 10. 非法 key 必须报错，不许静默无效 */
    let rejected = false
    let rejectMsg = ''
    try {
      await client.tool('yijing_update_clip', { draftId, clipId: mainClipId, patch: { filter: 'no-such-filter' } })
    } catch (e) {
      rejected = true
      rejectMsg = e.message
    }
    record('10. 写错滤镜 key 直接报错（静默无效是最坏的结果）', rejected && /滤镜/.test(rejectMsg), rejectMsg.slice(0, 80))

    /* 11. 导出 1：16:9 / 720p / 25fps */
    const out1 = path.join(outDir, 'stage1.mp4')
    const exp1 = await client.tool('yijing_export_video', {
      draftId,
      outPath: out1,
      resolution: '720p',
      fps: 25,
      aspect: '16:9',
      codec: 'h264',
      quality: 80
    })
    const size1 = fs.existsSync(out1) ? fs.statSync(out1).size : 0
    record('11. export_video 真的产出成片文件', fs.existsSync(out1) && size1 > 20000, `${(size1 / 1024).toFixed(0)} KB`)

    /* 12. ffprobe：分辨率 / 帧率 / 时长 / 音轨 */
    const info1 = probeFile(out1)
    const v1 = info1 && (info1.streams || []).find((s) => s.codec_type === 'video')
    const a1 = info1 && (info1.streams || []).find((s) => s.codec_type === 'audio')
    const dur1 = info1 ? Number(info1.format.duration) : 0
    record(
      '12. 成片规格与请求一致（1280x720 / 25fps / ~4s）',
      Boolean(v1) && v1.width === 1280 && v1.height === 720 && String(v1.r_frame_rate) === '25/1' && Math.abs(dur1 - 4) < 0.4,
      v1 ? `${v1.width}x${v1.height} ${v1.r_frame_rate} ${dur1.toFixed(2)}s` : '无视频流'
    )
    record('13. 成片带音轨（不是一条静音视频）', Boolean(a1), a1 ? a1.codec_name : '无音频流')

    /* 14. 像素：mono 滤镜必须真的进了成片 */
    const f1 = frameAt(out1, 1.0, 1280, 720)
    const m1 = f1 ? metrics(f1, 1280, 720) : null
    record('14. filter=mono 真的进了成片（整帧灰度，max|r-g| ≤ 12）', Boolean(m1) && m1.maxSpread <= 12, m1 ? `maxSpread=${m1.maxSpread}` : '抽帧失败')

    /* 15. 像素：字幕烧进画面（底部亮像素） */
    const bottom = f1 ? metrics(f1, 1280, 720, { x: 0.1, y: 0.72, w: 0.8, h: 0.22 }) : null
    record('15. 字幕真的烧进画面（底部亮像素 > 300）', Boolean(bottom) && bottom.bright > 300, bottom ? `bright=${bottom.bright}` : '抽帧失败')

    /* 16. 调色三件套：曲线 / 色轮 / 分区 HSL —— 写入即归一化 */
    const colored = await client.tool('yijing_update_clip', {
      draftId,
      clipId: mainClipId,
      patch: {
        curves: {
          rgb: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.62 },
            { x: 1, y: 1 }
          ]
        },
        wheels: { mid: { x: 0.2, y: 0.1, level: 0.1 } },
        hslBands: { red: { h: 0, s: 0.25, l: 0.05 } }
      }
    })
    const cc = colored.clip || {}
    record(
      '16. 曲线/色轮/HSL 写入即归一化（三路表与 8 色带都在）',
      Boolean(cc.curves && Array.isArray(cc.curves.rgb) && cc.curves.rgb.length === 3) &&
        Boolean(cc.wheels && cc.wheels.mid && Math.abs(cc.wheels.mid.level - 0.1) < 1e-6) &&
        Boolean(cc.hslBands && cc.hslBands.red && Math.abs(cc.hslBands.red.s - 0.25) < 1e-6),
      JSON.stringify({ rgb: cc.curves && cc.curves.rgb.length, wheels: Boolean(cc.wheels && cc.wheels.mid), bands: Boolean(cc.hslBands && cc.hslBands.red) })
    )

    /* 17. 贴纸 → 叠加轨图片片段（走 yjai-media 地址，预览/导出都认） */
    const stickerKey = (cat.stickers || []).find((s) => s.key) ? cat.stickers[0].key : ''
    const sticker = await client.tool('yijing_add_sticker', { draftId, stickerKeys: [stickerKey], start: 1, duration: 2, anchor: 'right-top', size: 25 })
    const stickerClip = sticker.added && sticker.added[0]
    record('17. add_sticker 落成叠加轨图片片段', Boolean(stickerClip && stickerClip.id), JSON.stringify(stickerClip))

    /* 18. 智能包装（按字幕逐句套） */
    const pack = await client.tool('yijing_apply_packaging', { draftId, mode: 'line', style: 'web-yellow', level: 'normal' })
    record('18. apply_packaging 命中字幕并加贴纸', pack.patched >= 3, `patched=${pack.patched} stickers=${pack.stickers}`)

    /* 19. 时间线：切分 + 修剪 */
    const split = await client.tool('yijing_timeline_op', { draftId, op: 'split', clipId: mainClipId, at: 2 })
    const trim = split.right
      ? await client.tool('yijing_timeline_op', { draftId, op: 'trim', clipId: split.right, from: 2.2, to: 3 })
      : null
    record('19. split 切出两段且 trim 改了起点/时长', Boolean(split.left && split.right && trim && trim.clip.start === 2.2 && Math.abs(trim.clip.duration - 0.8) < 1e-6), JSON.stringify(trim && { start: trim.clip.start, duration: trim.clip.duration }))

    /* 20. 导出 2：9:16 + 封面 + 30fps */
    const out2 = path.join(outDir, 'stage2.mp4')
    const exp2 = await client.tool('yijing_export_video', {
      draftId,
      outPath: out2,
      resolution: '720p',
      fps: 30,
      aspect: '9:16',
      codec: 'h264',
      cover: { enabled: true, at: 1.5 }
    })
    const info2 = probeFile(out2)
    const v2 = info2 && (info2.streams || []).find((s) => s.codec_type === 'video')
    const want2 = ASPECT.outputSizeFor(1280, 720, '9:16')
    record(
      `20. 换画面比例后成片尺寸与界面同口径（9:16 → ${want2.width}x${want2.height}）`,
      Boolean(v2) && v2.width === want2.width && v2.height === want2.height,
      v2 ? `${v2.width}x${v2.height}` : '无视频流'
    )
    record('21. 封面 jpg 真的写出来了', Boolean(exp2.coverPath) && fs.existsSync(exp2.coverPath), exp2.coverPath || '无')

    /* 22. 工程包 */
    const packPath = path.join(outDir, 'project.yjpack')
    const packed = await client.tool('yijing_pack_draft', { draftId, outPath: packPath })
    const packSize = fs.existsSync(packPath) ? fs.statSync(packPath).size : 0
    record('22. pack_draft 产出 .yjpack（含素材）', packed.ok !== false && packSize > 10000, `${(packSize / 1024).toFixed(0)} KB`)

    /* 23. 状态 */
    const st = await client.tool('yijing_status')
    record('23. status 报告 ffmpeg 可用', st.ready === true && Boolean(st.ffmpeg), `${st.ffmpeg} · 贴纸 ${st.stickerCount} 边框 ${st.borderCount}`)

    /* 24. 删除 */
    const del = await client.tool('yijing_delete_clips', { draftId, clipIds: [stickerClip.id] })
    record('24. delete_clips 生效', del.removed >= 1, `removed=${del.removed}`)

    realDone = true
  } catch (e) {
    pageErrors = String((e && e.stack) || e)
  } finally {
    client.close()
    /**
     * ⚠️ 中途抛错默认会"全绿"：上面每条 record 只记自己那一条，
     * 抛出去之后剩下的断言一条都不会跑，如果没有这条硬断言，闸门会打印
     * `total=24 pass=9` 却仍然 `_OK`。这里显式把"跑到底"作为一条断言。
     */
    record(`真机：${TOTAL_ASSERTIONS} 条断言全跑到底（中断不算通过）`, realDone, realDone ? '' : pageErrors.slice(0, 400))
    if (!realDone) console.error('中断原因：\n' + pageErrors)

    const total = pass.length + failed.length
    console.log(`\nMCP_AGENT_STATS total=${total} pass=${pass.length} fail=${failed.length}`)
    console.log(failed.length || total !== TOTAL_ASSERTIONS ? 'MCP_AGENT_FAILED' : 'MCP_AGENT_OK')
    fs.rmSync(profile, { recursive: true, force: true })
    process.exit(failed.length || total !== TOTAL_ASSERTIONS ? 1 : 0)
  }
}

main()
