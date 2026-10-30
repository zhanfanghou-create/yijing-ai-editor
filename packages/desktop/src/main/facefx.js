/**
 * 人物特效的随包运行时（MediaPipe Face Landmarker）。
 *
 * 这一层只做三件事：**找目录、登记白名单、告诉渲染层去哪取**。
 * 真正的推理在渲染层（需要 WebGL / Canvas / <video>），主进程不碰。
 *
 * ⚠️ 三个文件缺一不可，少任何一个的表现都不是"报错"而是：
 *    · 少 `.task`（模型）→ createFromOptions 抛 "Failed to fetch"；
 *    · 少 `.wasm`      → WebAssembly 编译失败，同样是 fetch 报错；
 *    · 少 `.js`（加载器）→ 注入 <script> 404，控制台只有一条资源错误。
 *    三种错在界面上长得一样，所以这里**一次把缺的列全**（`missing`），
 *    面板据此显示"运行时未就绪：缺 xxx"，而不是笼统的"加载失败"。
 *
 * ⚠️ wasm 与模型**必须**登记进 allowedMedia，否则 `yjai-media://` 回 403。
 *    这条坑与贴纸、字体完全同源（见 materialPack.js 的注释）：
 *    403 在 Console 里只是一条 "Failed to load resource"，看起来像文件不存在。
 *
 * ⚠️ 不加 catalog.json 之类清单：这里的文件是固定三个，不是可扩展素材库。
 *    真要做成"可换模型"，那时再引入清单 —— 现在加只会多一个会写坏的输入。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 必须存在的三个文件，顺序即报错时的展示顺序 */
const REQUIRED = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'face_landmarker.task']

/**
 * 找运行时目录。判据是「目录里真有那个模型」，光有目录不算。
 *
 * 三种情形与 materialPack 一致（打包 → 源码 → appPath），
 * 但**不能复用 packRootOf**：那个函数要求 catalog.json，而这里没有清单。
 *
 * @param {object} deps
 * @returns {string} 绝对路径；都没命中则空串
 */
function faceRootOf({ resourcesPath, appPath, mainDir } = {}) {
  const candidates = []
  if (resourcesPath) candidates.push(path.join(String(resourcesPath), 'mediapipe'))
  if (mainDir) candidates.push(path.resolve(String(mainDir), '..', '..', 'resources', 'mediapipe'))
  if (appPath) candidates.push(path.join(String(appPath), 'resources', 'mediapipe'))
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'face_landmarker.task'))) return dir
    } catch {
      /* 权限 / 路径非法：当作这处没有 */
    }
  }
  return ''
}

/**
 * 解析运行时。
 *
 * @param {object} deps 与 faceRootOf 相同
 * @param {(abs:string)=>string} [deps.mediaUrlOf] 把磁盘路径转成 `yjai-media://` 地址
 * @param {(abs:string)=>void} [deps.allow] 登记进协议白名单
 * @returns {{ ok:boolean, dir:string, missing:string[], loader:string, wasm:string, model:string }}
 */
function faceRuntime(deps = {}) {
  const dir = faceRootOf(deps)
  const out = { ok: false, dir, missing: [], loader: '', wasm: '', model: '' }
  if (!dir) {
    out.missing = REQUIRED.slice()
    return out
  }

  for (const name of REQUIRED) {
    let exists = false
    try {
      const abs = path.join(dir, name)
      exists = fs.statSync(abs).isFile() && fs.statSync(abs).size > 0
    } catch {
      exists = false
    }
    if (!exists) out.missing.push(name)
  }

  /* 加载器（.js）走渲染层的 blob 注入，**不经过** yjai-media：
     脚本从素材协议取意味着"任何能写进素材目录的文件都能被执行"，
     那是真正的洞。这里只回磁盘路径，由渲染层读文本后转 blob。 */
  out.loader = path.join(dir, 'vision_wasm_internal.js')
  if (!out.missing.length) {
    const wasmAbs = path.join(dir, 'vision_wasm_internal.wasm')
    const modelAbs = path.join(dir, 'face_landmarker.task')
    if (typeof deps.allow === 'function') {
      deps.allow(wasmAbs)
      deps.allow(modelAbs)
    }
    if (typeof deps.mediaUrlOf === 'function') {
      out.wasm = deps.mediaUrlOf(wasmAbs)
      out.model = deps.mediaUrlOf(modelAbs)
    }
  }
  out.ok = out.missing.length === 0 && Boolean(out.wasm) && Boolean(out.model)
  return out
}

/**
 * 取人物特效的两枚贴图（遮罩 / 描边）的磁盘路径。
 *
 * 与运行时目录分开找：贴图是**本工程生成的**（tools/gen-facefx.py），
 * 入库；wasm 与模型是第三方二进制，不入库。混在一个目录里，
 * 一次 `fetch-mediapipe` 清理就会把贴图一起删掉。
 *
 * @param {'mask-ellipse.png'|'frame-ellipse.png'} name
 * @returns {string} 绝对路径；没有则空串
 */
function faceAsset(name, { resourcesPath, appPath, mainDir } = {}) {
  const file = String(name || '')
  if (!file) return ''
  const candidates = []
  if (resourcesPath) candidates.push(path.join(String(resourcesPath), 'facefx', file))
  if (mainDir) candidates.push(path.resolve(String(mainDir), '..', '..', 'resources', 'facefx', file))
  if (appPath) candidates.push(path.join(String(appPath), 'resources', 'facefx', file))
  for (const abs of candidates) {
    try {
      if (fs.statSync(abs).isFile()) return abs
    } catch {
      /* 继续试下一处 */
    }
  }
  return ''
}

module.exports = { REQUIRED, faceRootOf, faceRuntime, faceAsset }
