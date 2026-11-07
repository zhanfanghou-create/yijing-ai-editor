#!/usr/bin/env node
/**
 * 自证·本机配音（音色包注册表 / 文本闸门）
 *
 * 这一族错法全是静默的，所以必须脱机钉住：
 *   · 注册表 `bytes` 抄错一个数字 ⇒ 用户点下载、下完被判"体积不符"删掉，界面只说"失败"；
 *   · 少登记一个 dict 文件 ⇒ 能出声，但多音字全读错（听着不对，却没有任何报错）；
 *   · `.onnx` 多于一个 ⇒ 合成器挑到错的模型，加载"成功"但输出噪声；
 *   · 空文本 / 超长文本不拦 ⇒ 主进程同步阻塞几十秒，界面看着像死机。
 *
 * 判据都是"纯函数 + 注册表真值"，不加载模型、不联网 —— 所以毫秒级。
 *
 * 用法：node --no-warnings tools/tts-selftest.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const models = require(path.join(ROOT, 'packages/desktop/src/main/models.js'))
const speech = require(path.join(ROOT, 'packages/desktop/src/main/speech.js'))

/** 固定断言数（改断言必须同步这里与 scripts/verify.mjs 的 expected） */
const EXPECTED = 8

let pass = 0
let fail = 0
const check = (name, ok, note = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${note ? `  —— ${note}` : ''}`)
}

/* ---------- 1. 注册表 ---------- */
const entry = models.byId('speech-voice-zh')
check(
  '1. 注册表里有中文配音音色包（group=speech / kind=voice）',
  Boolean(entry) && entry.group === 'speech' && entry.kind === 'voice',
  entry ? `${entry.name} · ${entry.license}` : '缺失'
)

const files = (entry && entry.files) || []
/* 真值来自实际下载到磁盘的那一份（2026-11-02 量过）：
   model 121266652 + tokens 331 + lexicon 2457843 + dict 8 个 = 137466840 */
const TOTAL = 137466840
const sum = files.reduce((n, f) => n + Number(f.bytes || 0), 0)
check('2. 文件数 12，字节合计与实测一致', files.length === 12 && sum === TOTAL, `${files.length} 个 / ${sum} 字节`)

check(
  '3. 每个文件都有绝对可下的地址（url + alt）且字节数 > 0',
  files.length > 0 && files.every((f) => f.bytes > 0 && /^https:\/\//.test(f.url) && Array.isArray(f.alt) && f.alt.length > 0),
  files.filter((f) => !(f.bytes > 0 && f.url && f.alt && f.alt.length)).map((f) => f.name).join(',') || '全部齐备'
)

const onnx = files.filter((f) => /\.onnx$/i.test(f.name))
check(
  '4. 正好一个 .onnx（合成器靠它定位；多个会挑错模型）',
  onnx.length === 1,
  onnx.map((f) => f.name).join(',') || '没有 onnx'
)

check(
  '5. 分词词典登记齐（缺了能出声但多音字读错）',
  /* 9 个：dict/ 下 5 个（jieba / hmm / user / idf / stop_words）+ pos_dict/ 下 4 个 */
  files.filter((f) => f.name.startsWith('dict/')).length === 9 &&
    files.some((f) => f.name === 'lexicon.txt') &&
    files.some((f) => f.name === 'tokens.txt'),
  `${files.filter((f) => f.name.startsWith('dict/')).length} 个 dict 文件`
)

/* ---------- 2. 文本闸门（纯函数） ---------- */
check(
  '6. 换行 / 制表 / 连续空格压成一个空格，首尾不留白',
  speech.cleanSpeechText('  第一句\n\n第二句\t\t第三句   ') === '第一句 第二句 第三句',
  JSON.stringify(speech.cleanSpeechText('  第一句\n\n第二句\t\t第三句   '))
)

const empty = speech.prepareSpeechText('   \n\t ')
check('7. 空文本被拦下（否则主进程白加载 131MB 模型）', empty.ok === false && empty.reason === 'empty-text', empty.reason || 'ok')

const longText = '字'.repeat(speech.TTS_MAX_CHARS + 1)
const tooLong = speech.prepareSpeechText(longText)
check(
  '8. 超长文本被拦下并报出实际字数',
  tooLong.ok === false && tooLong.reason === 'too-long' && String(tooLong.error).includes(String(speech.TTS_MAX_CHARS + 1)),
  tooLong.error ? tooLong.error.slice(0, 40) : 'ok'
)

console.log(`TTS_SELFTEST_STATS total=${EXPECTED} pass=${pass} fail=${fail}`)
console.log(fail === 0 && pass === EXPECTED ? 'TTS_SELFTEST_OK' : 'TTS_SELFTEST_FAILED')
process.exit(fail === 0 && pass === EXPECTED ? 0 : 1)
