/**
 * 智能抠像的运行时定位（主进程）。
 *
 * 这一层只做三件事：**找 wasm 运行时、找分割模型、把两者变成渲染层能 fetch 的地址**。
 * 真正的推理在渲染层（要 WebGL / Canvas / <video>），主进程不碰 ——
 * 与人物特效（facefx.js）完全同源，原因也一样。
 *
 * ⚠️ 为什么**不复用** `faceRootOf`：
 *    那个函数的判据是"三个文件齐全"（含 `face_landmarker.task` 3.7MB）。
 *    抠像只需要 wasm + 加载器两个，不需要人脸模型。直接复用会让
 *    "用户删掉了人脸模型、只留 wasm"这种情况下抠像跟着一起坏掉，
 *    而报错会写成"缺 face_landmarker.task" —— 与用户想做的事毫无关系。
 *    所以这里自己的判据先看两个 wasm 文件，模型单独查注册表。
 *
 * ⚠️ 模型走 `models.js` 的注册表而不是随包目录：
 *    抠像模型是**按需下载**的（0.25MB，多数用户不抠像），
 *    随包会让安装包无谓变大，也让这个模型永远锁在发版那一天。
 */
const fs = require('node:fs')
const path = require('node:path')
const models = require('./models')

/** MediaPipe 推理所需的两个文件（缺任何一个都跑不起来） */
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']

/** 抠像模型在注册表里的 id */
const MODEL_ID = 'matte-person'

/**
 * 找 wasm 运行时目录。判据 = 两个文件都存在且非空。
 *
 * 候选顺序与 facefx.faceRootOf 一致（本机安装优先 → 随包 → 源码 → appPath），
 * 但**不要求人脸模型**。本机安装优先是为了让"设置里下载的运行时"真的能覆盖随包版本。
 *
 * @param {object} deps
 * @returns {string} 绝对路径；都没命中则空串
 */
function visionDirOf({ resourcesPath, appPath, mainDir, userData } = {}) {
  const candidates = []
  if (userData) candidates.push(path.join(String(userData), 'models', 'face-runtime'))
  if (resourcesPath) candidates.push(path.join(String(resourcesPath), 'mediapipe'))
  if (mainDir) candidates.push(path.resolve(String(mainDir), '..', '..', 'resources', 'mediapipe'))
  if (appPath) candidates.push(path.join(String(appPath), 'resources', 'mediapipe'))
  for (const dir of candidates) {
    try {
      const complete = WASM_FILES.every((name) => fs.statSync(path.join(dir, name)).size > 0)
      if (complete) return dir
    } catch {
      /* 缺文件 / 权限 / 路径非法：继续试下一处 */
    }
  }
  return ''
}

/**
 * 解析抠像运行时。
 *
 * @param {object} deps 与 visionDirOf 相同，另加：
 * @param {(abs:string)=>string} [deps.mediaUrlOf] 磁盘路径 → `yjai-media://` 地址
 * @param {(abs:string)=>void} [deps.allow] 登记进协议白名单
 * @returns {{ ok:boolean, dir:string, missing:string[], loader:string, wasm:string, model:string, modelDir:string }}
 */
function matteRuntime(deps = {}) {
  const out = { ok: false, dir: '', missing: [], loader: '', wasm: '', model: '', modelDir: '' }

  /* ---- ① wasm 运行时 ---- */
  const dir = visionDirOf(deps)
  out.dir = dir
  if (!dir) {
    out.missing.push(...WASM_FILES)
  } else {
    for (const name of WASM_FILES) {
      let ok = false
      try {
        const abs = path.join(dir, name)
        ok = fs.statSync(abs).isFile() && fs.statSync(abs).size > 0
      } catch {
        ok = false
      }
      if (!ok) out.missing.push(name)
    }
    out.loader = path.join(dir, 'vision_wasm_internal.js')
  }

  /* ---- ② 分割模型（注册表 → 本机安装目录 / 随包目录） ---- */
  const entry = models.byId(MODEL_ID)
  if (!entry) {
    out.missing.push('（注册表里没有 matte-person）')
  } else {
    const st = models.stateOf(entry, deps)
    out.modelDir = st.dir || ''
    if (!st.dir || st.missing.length) {
      for (const name of st.missing) out.missing.push(name)
      if (!st.dir) out.missing.push(entry.files[0].name)
    } else {
      const abs = path.join(st.dir, entry.files[0].name)
      if (typeof deps.allow === 'function') deps.allow(abs)
      if (typeof deps.mediaUrlOf === 'function') out.model = deps.mediaUrlOf(abs)
    }
  }

  /* ---- ③ wasm 地址（白名单必须在给 URL 之前登记，否则渲染层 fetch 403） ---- */
  if (out.dir && !out.missing.length) {
    const wasmAbs = path.join(out.dir, 'vision_wasm_internal.wasm')
    if (typeof deps.allow === 'function') deps.allow(wasmAbs)
    if (typeof deps.mediaUrlOf === 'function') out.wasm = deps.mediaUrlOf(wasmAbs)
  }

  out.ok = out.missing.length === 0 && Boolean(out.wasm) && Boolean(out.model)
  return out
}

/**
 * 模型是否已装（界面据此决定按钮是「抠像」还是「下载模型并抠像」）。
 *
 * 单独一个函数而不是让面板自己算：判据必须与 matteRuntime 的 `ok` 完全一致，
 * 两边各写一份就会出现"按钮说装了、点下去说没装"。
 */
function modelState(deps = {}) {
  const entry = models.byId(MODEL_ID)
  if (!entry) return { ready: false, missing: ['matte-person'], bytes: 0 }
  const st = models.stateOf(entry, deps)
  return { ready: Boolean(st.dir) && st.missing.length === 0, missing: st.missing.slice(), bytes: st.bytes || 0 }
}

module.exports = { WASM_FILES, MODEL_ID, visionDirOf, matteRuntime, modelState }
