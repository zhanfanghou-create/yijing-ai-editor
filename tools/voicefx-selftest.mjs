#!/usr/bin/env node
/**
 * 自证·变声与人声增强（`shared/audio.js` 的两个纯函数）
 *
 * 为什么这族错法必须脱机钉住：它们全是**静默**的。
 *   · 变声只改了采样率没跟 `aresample` ⇒ 片段时长变短，音画对不上，
 *     而轨道、预览、属性面板看着全部正常；
 *   · 同理，只变采样率不跟 `atempo` ⇒ 变调的同时变速，时长同样对不上；
 *   · 增强串写错一个冒号 ⇒ ffmpeg 报错在**导出最后一步**，用户等了十分钟才看到失败；
 *   · 函数返回带前导逗号 ⇒ 拼进 `aTail` 后变成 `,,`，ffmpeg 报 "No such filter"；
 *   · 强度不单调 ⇒ 滑杆能拖，声音不变（"看着有、实际没接"的经典形态）。
 *
 * 判据全是纯函数真值，不跑 ffmpeg、不加载模型 —— 毫秒级。
 *
 * 用法：node --no-warnings tools/voicefx-selftest.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const audio = require(path.join(ROOT, 'packages/desktop/src/shared/audio.js'))

/** 固定断言数（改断言必须同步这里与 scripts/verify.mjs 的 expected） */
const EXPECTED = 10

let pass = 0
let fail = 0
const check = (name, ok, note = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${note ? `  —— ${note}` : ''}`)
}

const { VOICE_CHANGES, voiceEnhanceFilter, voiceChangeFilter } = audio

/* ---------- 1. 预设表本身 ---------- */
check(
  '1. 预设表第一项是「原声」且 key 唯一',
  VOICE_CHANGES[0].key === 'none' &&
    new Set(VOICE_CHANGES.map((v) => v.key)).size === VOICE_CHANGES.length &&
    VOICE_CHANGES.length >= 5,
  `${VOICE_CHANGES.length} 项：${VOICE_CHANGES.map((v) => v.label).join('/')}`
)

/* ---------- 2. 0 与「原声」必须返回空串 ----------
   不返回空串的后果：每段都白挂一串滤镜（导出变慢），而且 0 强度也改音色。 */
check(
  '2. 增强 0% / 原声 / 未知键都返回空串（不挂空滤镜）',
  voiceEnhanceFilter(0) === '' &&
    voiceEnhanceFilter(undefined) === '' &&
    voiceChangeFilter('none') === '' &&
    voiceChangeFilter(undefined) === '' &&
    voiceChangeFilter('不存在的预设') === '',
  `enhance(0)=${JSON.stringify(voiceEnhanceFilter(0))} change(none)=${JSON.stringify(voiceChangeFilter('none'))}`
)

/* ---------- 3. 每个非原声预设都要真的产出滤镜 ---------- */
const produced = VOICE_CHANGES.filter((v) => v.key !== 'none' && voiceChangeFilter(v.key).length > 0)
check(
  '3. 每个非原声预设都产出非空滤镜串',
  produced.length === VOICE_CHANGES.length - 1,
  `${produced.length}/${VOICE_CHANGES.length - 1}`
)

/* ---------- 4. 不许带前导/尾随逗号 ----------
   `aTail` 里每个 part 自己带前导逗号，函数再带一个就变成 `,,`
   ⇒ ffmpeg 报 "No such filter: ''"，而且报在导出最后一步。 */
const allParts = [
  voiceEnhanceFilter(50),
  ...VOICE_CHANGES.map((v) => voiceChangeFilter(v.key))
].filter(Boolean)
check(
  '4. 所有滤镜串都不带前导/尾随逗号（拼进 aTail 不会出现 `,,`）',
  allParts.every((s) => !s.startsWith(',') && !s.endsWith(',') && !s.includes(',,')),
  `${allParts.length} 条`
)

/* ---------- 5. 改采样率的预设必须自带采样率归一 ----------
   `asetrate` 的数值是**绝对采样率**：上游若是 44.1kHz（很常见），倍率就不是 1.32。
   漏了链内的 aformat，症状是"变调了、时长也短了一截"，而轨道和面板一切正常。
   最后那句 aresample 保证输出仍是 48k（不改下游的采样率）。 */
const rateChangers = ['chipmunk', 'deep']
check(
  '5. 花栗鼠/低沉都自带采样率归一（aformat 48k → aresample 48k）',
  rateChangers.every((k) => {
    const s = voiceChangeFilter(k)
    return s.startsWith('aformat=sample_rates=48000') && s.includes('aresample=48000')
  }),
  rateChangers.map((k) => `${k}:${voiceChangeFilter(k).slice(0, 34)}`).join(' | ')
)

/* ---------- 6. 变采样率的必须同时 atempo 把时长拉回来 ----------
   只有 asetrate ⇒ 变调又变速，片段短一截（这是最容易漏的一条）。 */
check(
  '6. 花栗鼠/低沉都带 atempo（时长回到原样，片段不缩水）',
  rateChangers.every((k) => voiceChangeFilter(k).includes('atempo=')),
  rateChangers.map((k) => `${k}:${/atempo=([\d.]+)/.exec(voiceChangeFilter(k))?.[1] || '缺'}`).join(' ')
)

/* ---------- 7. atempo 与采样率倍率必须互为倒数 ----------
   写错一个数字时"能出声、时长也接近"，只有精确算才能抓住。
   63360/48000 = 1.32，所以 atempo 应当是 1/1.32 = 0.7576 左右（±2%）。 */
const chip = voiceChangeFilter('chipmunk')
const chipRate = Number(/asetrate=(\d+)/.exec(chip)?.[1] || 0)
const chipTempo = Number(/atempo=([\d.]+)/.exec(chip)?.[1] || 0)
const chipRatio = chipRate / 48000
check(
  '7. 花栗鼠的 atempo 与采样率倍率互为倒数（±2%）',
  chipRate > 0 && Math.abs(chipTempo * chipRatio - 1) < 0.02,
  `倍率 ${chipRatio.toFixed(3)} × atempo ${chipTempo} = ${(chipTempo * chipRatio).toFixed(3)}`
)

/* ---------- 8. 增强三段齐全 ---------- */
const boost = voiceEnhanceFilter(60)
check(
  '8. 增强串含 高通 + 中频 EQ + 压缩器 三段',
  boost.includes('highpass=') && boost.includes('equalizer=') && boost.includes('acompressor='),
  boost.slice(0, 60)
)

/* ---------- 9. 强度单调 ----------
   不单调的症状就是那句"滑杆能拖、声音不变"：判据要读**产出的数字**，
   不能只判"非空"。这里取中频增益那一项。 */
const midOf = (level) => Number(/equalizer=f=2800:[^,]*g=(-?[\d.]+)/.exec(voiceEnhanceFilter(level))?.[1] || NaN)
const mids = [20, 50, 80, 100].map(midOf)
check(
  '9. 中频增益随强度单调上升（滑杆真的接上了）',
  mids.every((v, i) => Number.isFinite(v) && (i === 0 || v > mids[i - 1])),
  mids.join(' → ')
)

/* ---------- 10. 压缩比随强度上升、且始终 ≥ 1 ----------
   压缩比 < 1 是"扩展器"，会把小声压得更小 —— 听感是"加了增强反而听不清"。 */
const ratioOf = (level) => Number(/acompressor=threshold=-?\d+dB:ratio=([\d.]+)/.exec(voiceEnhanceFilter(level))?.[1] || NaN)
const ratios = [20, 60, 100].map(ratioOf)
check(
  '10. 压缩比随强度上升且恒 ≥ 1（不会变成扩展器）',
  ratios.every((v) => Number.isFinite(v) && v >= 1) && ratios[2] > ratios[0],
  ratios.join(' / ')
)

console.log(`VOICEFX_SELFTEST_STATS total=${EXPECTED} pass=${pass} fail=${fail}`)
console.log(fail === 0 && pass === EXPECTED ? 'VOICEFX_SELFTEST_OK' : 'VOICEFX_SELFTEST_FAILED')
process.exit(fail === 0 && pass === EXPECTED ? 0 : 1)
