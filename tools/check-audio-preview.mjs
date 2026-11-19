#!/usr/bin/env node
/**
 * 声音效果"进没进预览"的看门狗。
 *
 * 治的是这一类缺陷（本项目最贵的一类）：**面板上能调、脏点亮、数字在变，
 * 预览里一丁点变化都没有 —— 而成片反而是对的**。声音比画面更难发现：
 * 画面错了一眼能看出来，声音错了要戴着耳机逐段对比才知道。
 *
 * 2026-11-16 之前的状态：
 *   · 淡入 / 淡出 —— 只有导出认（`afade`），预览完全没接，界面上也没写「仅导出」；
 *   · 立体声平衡 / 人声增强 / 电话·电台·机器人变声 —— 只有导出认，界面写了「仅导出」
 *     （诚实，但功能等于缺一半）。
 * 现在前三类都接到了预览（`shared/audioGraph.js` 出计划 → `renderer/previewAudio.js`
 * 建 WebAudio 节点），淡入淡出折进 `gain` 走 `<video>.volume`。
 *
 * 判据分三层，缺一层就会出现"全部通过但功能不存在"：
 *   ① 数学：淡入淡出的斜坡与 `afade` 的线性形状一致，边界夹取正确；
 *   ② 计划：片段 → WebAudio 节点（声像系数、滤波频点、压缩器、位深、颤动、导出专属项）；
 *   ③ 接线：合成器投影 → Stage 三个渲染分支 → 引擎 → vite 白名单 → 面板文案。
 *
 * 断言总数写死在 verify.mjs 的 expected 里，增减条目要同步改。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

const audio = require(path.join(ROOT, 'packages/desktop/src/shared/audio.js'))
const graph = require(path.join(ROOT, 'packages/desktop/src/shared/audioGraph.js'))

const P = {
  audio: path.join(ROOT, 'packages/desktop/src/shared/audio.js'),
  graph: path.join(ROOT, 'packages/desktop/src/shared/audioGraph.js'),
  engine: path.join(ROOT, 'packages/desktop/src/renderer/previewAudio.js'),
  composite: path.join(ROOT, 'packages/desktop/src/renderer/composite.js'),
  stage: path.join(ROOT, 'packages/desktop/src/renderer/components/Stage.jsx'),
  inspector: path.join(ROOT, 'packages/desktop/src/renderer/components/Inspector.jsx'),
  render: path.join(ROOT, 'packages/desktop/src/main/render.js'),
  vite: path.join(ROOT, 'packages/desktop/vite.config.mjs')
}

let total = 0
let failures = 0
const rows = []

function check(name, ok, detail = '') {
  total += 1
  if (!ok) failures += 1
  rows.push(`${ok ? '✓' : '✗'} ${String(total).padStart(2, '0')} ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 剥注释：静态断言读源码时，注释里写一句 `afade` 会被当成真实现 */
function source(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps

/* ------------------------- ① 淡入淡出的斜坡 ------------------------- */

check('没有淡入淡出时增益恒为 1（不能悄悄削 3dB）', near(audio.fadeGainAt({}, 0, 10), 1) && near(audio.fadeGainAt({}, 9.9, 10), 1))

const fin = { fadeIn: 2 }
check(
  '淡入 2 秒：0s→0、1s→0.5、2s→1、3s→1（线性，与 afade 的 tri 同形）',
  near(audio.fadeGainAt(fin, 0, 10), 0) &&
    near(audio.fadeGainAt(fin, 1, 10), 0.5) &&
    near(audio.fadeGainAt(fin, 2, 10), 1) &&
    near(audio.fadeGainAt(fin, 3, 10), 1)
)

const fout = { fadeOut: 2 }
check(
  '淡出 2 秒（dur=10）：8s→1、9s→0.5、9.5s→0.25、10s→0（起点是 dur−fadeOut，不是素材时间）',
  near(audio.fadeGainAt(fout, 7, 10), 1) &&
    near(audio.fadeGainAt(fout, 8, 10), 1) &&
    near(audio.fadeGainAt(fout, 9, 10), 0.5) &&
    near(audio.fadeGainAt(fout, 9.5, 10), 0.25) &&
    near(audio.fadeGainAt(fout, 10, 10), 0)
)

check(
  '淡入淡出同时存在：取两者较小值（4s 片段各 1s ⇒ 0.5s 处 0.5、2s 处 1、3.5s 处 0.5）',
  near(audio.fadeGainAt({ fadeIn: 1, fadeOut: 1 }, 0.5, 4), 0.5) &&
    near(audio.fadeGainAt({ fadeIn: 1, fadeOut: 1 }, 2, 4), 1) &&
    near(audio.fadeGainAt({ fadeIn: 1, fadeOut: 1 }, 3.5, 4), 0.5)
)

check(
  '淡入时长超过片段时长时夹到片段内（fadeIn=99 / dur=2 ⇒ 1s 处 0.5，不是 0.01）',
  near(audio.fadeGainAt({ fadeIn: 99 }, 1, 2), 0.5) && near(audio.fadeGainAt({ fadeIn: 99 }, 2, 2), 1)
)

check('负数 / 非法值不让增益越界（-5s → 0，NaN 时长 → 1）', audio.fadeGainAt({ fadeIn: 1 }, -5, 10) === 0 && audio.fadeGainAt({ fadeIn: 1 }, 1, NaN) === 1)

const renderSrc = source(P.render)
check(
  '导出侧仍然是 afade（同一条线性斜坡），两边的形状不是"看着差不多"',
  /afade=t=in:st=0:d=/.test(renderSrc) && /afade=t=out:st=/.test(renderSrc)
)

/* ------------------------- ② 片段 → 节点计划 ------------------------- */

const neutralPlan = graph.planOf({})
check('没调过任何声音效果 ⇒ 计划中性（不碰 WebAudio，零风险）', neutralPlan.neutral === true && neutralPlan.chain.length === 0)

const panPlan = graph.planOf({ pan: -100 })
check(
  '拖到最左 ⇒ 左声道 ×1、右声道 ×0（平衡语义，系数来自 panGains）',
  panPlan.chain.length === 1 &&
    panPlan.chain[0].kind === 'pan' &&
    near(panPlan.chain[0].left, 1) &&
    near(panPlan.chain[0].right, 0)
)
check('居中（pan=0）不算效果，计划仍是中性', graph.planOf({ pan: 0 }).neutral === true)
check(
  'pan=50 ⇒ 右 1、左 0.5（线性、中心恰好 1/1）',
  near(graph.planOf({ pan: 50 }).chain[0].left, 0.5) && near(graph.planOf({ pan: 50 }).chain[0].right, 1)
)

const boostPlan = graph.planOf({ voiceBoost: 100 })
check(
  '人声增强 ⇒ 高通 → 低通 → 峰值 ×2 → 压缩器 → 补偿增益（与导出 ffmpeg 链同序）',
  boostPlan.chain.map((n) => n.kind).join(',') === 'highpass,lowpass,peaking,peaking,compressor,gain'
)
check(
  '人声增强的数值与导出同源（85/12000Hz、280Hz 压、2800Hz 提、makeup 2dB）',
  boostPlan.chain[0].freq === 85 &&
    boostPlan.chain[1].freq === 12000 &&
    boostPlan.chain[2].freq === 280 &&
    boostPlan.chain[2].gain < 0 &&
    boostPlan.chain[3].freq === 2800 &&
    boostPlan.chain[3].gain > 0 &&
    boostPlan.chain[5].db === 2
)

const phonePlan = graph.planOf({ voiceFx: 'phone' })
check(
  '电话 ⇒ 300–3400Hz 带限 + 位深压缩（bits 10 / mix 0.25）',
  phonePlan.chain.some((n) => n.kind === 'highpass' && n.freq === 300) &&
    phonePlan.chain.some((n) => n.kind === 'lowpass' && n.freq === 3400) &&
    phonePlan.chain.some((n) => n.kind === 'crush' && n.bits === 10 && near(n.mix, 0.25))
)

const robotPlan = graph.planOf({ voiceFx: 'robot' })
check(
  '机器人 ⇒ 位深压缩 + 32Hz 颤动（深度 0.75）',
  robotPlan.chain.some((n) => n.kind === 'crush' && n.bits === 6) &&
    robotPlan.chain.some((n) => n.kind === 'tremolo' && n.freq === 32 && near(n.depth, 0.75))
)

const radioPlan = graph.planOf({ voiceFx: 'radio' })
check(
  '电台 ⇒ 180–6200Hz + 压缩器（阈值 −16dB / 比 5）',
  radioPlan.chain.some((n) => n.kind === 'highpass' && n.freq === 180) &&
    radioPlan.chain.some((n) => n.kind === 'lowpass' && n.freq === 6200) &&
    radioPlan.chain.some((n) => n.kind === 'compressor' && n.threshold === -16 && n.ratio === 5)
)

const chipPlan = graph.planOf({ voiceFx: 'chipmunk' })
check(
  '花栗鼠 / 低沉明确"预览做不到"：计划为空 + exportOnly 点名（不许假装生效）',
  chipPlan.chain.length === 0 && chipPlan.exportOnly.includes('chipmunk') && graph.planOf({ voiceFx: 'deep' }).chain.length === 0
)

const dnPlan = graph.planOf({ audioDenoise: 60 })
check('音频降噪仍是导出专属：计划中性 + exportOnly 点名', dnPlan.neutral === true && dnPlan.exportOnly.includes('denoise'))

check(
  '倍频程 → Q 的换算（1 个倍频程 ≈ 1.414）',
  near(graph.octaveToQ(1), 1.4142, 0.001) && graph.octaveToQ(2) < graph.octaveToQ(1)
)

const idCurve = graph.crushCurve(8, 0, 64)
const wetCurve = graph.crushCurve(2, 1, 64)
check(
  '位深曲线：mix=0 时是直线（不变声）、mix=1 时是阶梯（真糙）',
  near(idCurve[0], -1, 0.01) &&
    near(idCurve[32], 0, 0.05) &&
    near(idCurve[63], 1, 0.01) &&
    new Set(Array.from(idCurve)).size > 55 &&
    new Set(Array.from(wetCurve)).size <= 5
)

check(
  '计划签名稳定：同参数两次相同、参数一变就不同（渲染层靠它判断要不要重建链路）',
  graph.signatureOf(graph.planOf({ pan: -40, voiceBoost: 30 })) ===
    graph.signatureOf(graph.planOf({ pan: -40, voiceBoost: 30 })) &&
    graph.signatureOf(graph.planOf({ pan: -40 })) !== graph.signatureOf(graph.planOf({ pan: -41 })) &&
    graph.signatureOf(neutralPlan) === ''
)

/* --------------------------- ③ 接线 --------------------------- */

const compSrc = source(P.composite)
check(
  '合成器把四个声音字段投影给预览（漏一行 ⇒ 滑杆能动、画面不动的那类失效）',
  /pan: clip\.pan/.test(compSrc) &&
    /voiceBoost: clip\.voiceBoost/.test(compSrc) &&
    /voiceFx: clip\.voiceFx/.test(compSrc) &&
    /audioDenoise: clip\.audioDenoise/.test(compSrc)
)
check(
  '合成器把淡入淡出折进 gain（画面层与音频轨各一处）',
  (compSrc.match(/fadeGainAt\(/g) || []).length >= 2
)

const stageSrc = source(P.stage)
check(
  'Stage 三个发声分支都接了引擎（主画面 / 音频轨 / 画中画）',
  (stageSrc.match(/applyAudioFx\(/g) || []).length >= 3 &&
    /applyAudioFx\(el, layer\)/.test(stageSrc) &&
    /applyAudioFx\(el, track\)/.test(stageSrc) &&
    /applyAudioFx\(el, \{ pan, voiceBoost, voiceFx, audioDenoise \}\)/.test(stageSrc)
)
check(
  '依赖只放四个标量（放整个层对象会让这个副作用每帧重跑：play / 音量赋值 60 次/秒）',
  /layer\.pan,\s*layer\.speed/.test(stageSrc) && !/\blayer,\s*layer\.speed/.test(stageSrc)
)
check(
  '元素卸载时拆链（同一个元素上 createMediaElementSource 只能建一次）',
  (stageSrc.match(/detachAudioFx\(el\)/g) || []).length >= 2
)

const engineSrc = source(P.engine)
check('引擎真的用 createMediaElementSource 接管元素', /createMediaElementSource\(el\)/.test(engineSrc))
check('声像用左右两个增益 + 声道分离/合并，不是 StereoPanner（后者会压窄声场）', /createChannelSplitter\(2\)/.test(engineSrc) && /createChannelMerger\(2\)/.test(engineSrc) && !/createStereoPanner/.test(engineSrc))
check('左右增益真的来自计划里的系数', /left\.gain\.value = Number\(spec\.left/.test(engineSrc) && /right\.gain\.value = Number\(spec\.right/.test(engineSrc))
check('中性计划时早退、完全不碰元素', /if \(plan\.neutral\)[\s\S]{0,700}?return 'none'/.test(engineSrc))
check('建失败的元素永久放弃（不重试，避免一半有声一半没声）', /graphs\.set\(el, false\)/.test(engineSrc) && /graph === false/.test(engineSrc))
check('链路末端挂了左右声道电平表（真机判据靠它，Analyser 单只会混单声道）', /attachMeter\(/.test(engineSrc) && /data-audio-level|dataset\.audioLevelL/.test(engineSrc))

const viteSrc = fs.readFileSync(P.vite, 'utf8')
check('vite 的 commonjs 白名单里有 audioGraph（漏了 ⇒ import 到空对象）', viteSrc.includes('audioGraph\\.js$'))

const inspSrc = source(P.inspector)
check(
  '面板文案跟上了实际能力（人声增强 / 平衡 / 变声不再一律写"只在导出时生效"）',
  (inspSrc.match(/预览里实时生效/g) || []).length >= 3
)
check(
  '仍然诚实的部分：降噪与变调照实写"只在导出时生效"/导出专属',
  /只在导出时生效/.test(inspSrc)
)

/* ------------------------------- 输出 ------------------------------- */

for (const row of rows) console.log(`  ${row}`)
const pass = total - failures
console.log(`AUDIO_PREVIEW_STATS total=${total} pass=${pass} fail=${failures} skip=0`)
if (failures) {
  console.log(`\nAUDIO_PREVIEW_FAILED  ${failures} 条不成立`)
  process.exitCode = 1
} else {
  console.log('\nAUDIO_PREVIEW_OK  淡入淡出 / 声像 / 人声增强 / 电话·电台·机器人变声 都在预览里生效')
}
