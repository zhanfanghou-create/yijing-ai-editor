/**
 * 艺镜AI剪辑 · 时间线片段修剪（纯逻辑）
 *
 * 为什么单独一个文件：这段算术**错了也不会报错**，只在导出时表现为
 * "右半段画面从源文件开头重播"。把它从 Timeline.jsx 里抽出来，是为了
 * `tools/trim-selftest.mjs` 能在 node 里直接断言 —— 挂在组件里的算术只能靠手拖，
 * 而手拖是没人会回归的。
 *
 * 术语（与 App.jsx 里的片段结构一致）：
 *   - `start`    片段在**时间线**上的起点（秒）
 *   - `duration` 片段时长（秒）
 *   - `offset`   这段素材在**源文件**里的入点（秒）
 *   - `speed`    播放倍速（1 = 原速）。**时间线走 1 秒，源素材要走掉 speed 秒**
 *   - `sourceDuration` 源片总长（秒）。**0 或缺省 = 不确定 = 不设上限**（图片就属于这种）
 *
 * `start` 与 `offset` 是两件事：往右剪左端，画面上"少了一截"，
 * 时间线起点右移、源入点也必须同步右移，否则同一帧会被播两遍。
 *
 * 全函数只维护**一条不变式**：`offset + duration * speed <= sourceDuration`（当 sourceDuration > 0）。
 * 它同时管住两端：右端拉过头会超上限（尾部黑帧），左端往左拖会推小 offset（不能小于 0）。
 *
 * ⚠️ 不变式里的 `speed` 不是后来加的补丁，而是这条式子本来就该有的项 ——
 *    2 倍速的片段在时间线上占 3 秒，吃掉的源素材是 6 秒。漏掉它，快放片段就能被
 *    拖到远超素材长度（拖动时看不出来，导出时尾部是黑帧），而且**不报错**。
 *
 * 注意这条不变式的**方向**：右端修剪负责**收敛**（一次就能把超长的片段拉回上限以内，
 * 所以历史草稿里的超长片段是可自愈的）；左端修剪只移动左边界，改变不了尾部，
 * 因此它保证的是"不把超出量放大"，而不是"修完一定合法"。别把前提当结论去断言。
 *
 * 本文件另外提供 `sourceTimeAt(clip, t)`：把时间线时刻映射到源文件时间。
 * 它和修剪是同一件事的两面（都是 `start` / `offset` 这两个坐标系之间的换算），
 * 一起放在这里是为了让"预览里看到的画面"和"导出时取到的画面"能共用同一套算术。
 */

/** 片段最短时长：再短就没法用鼠标抓回来了 */
export const MIN_CLIP_SECONDS = 0.2

/** 判定"没有变化"的阈值：小于一帧（1/30≈0.033）的位移不值得写一次状态 */
export const EPSILON = 0.001

/**
 * 倍速的真源在 `shared/speed.js`（渲染层与主进程共用同一份，不许各写一份 ——
 * 理由见那个文件的头注释）。这里取出来原样转出，让已有的 import 路径不用改。
 *
 * 那边是 CJS（主进程要用），所以这里走**默认导入再解构**：Node 的原生 ESM 保证
 * 默认导入拿到 module.exports，而具名导入要靠 cjs-module-lexer 静态分析、
 * 在 module.exports 写得稍复杂时就会取不到。
 *
 * ⚠️ 别在这一带的注释里写"整条 import 语句 + 模块路径"形状的示例：imports 那道闸
 *    是按「import/export … 加模块路径」的**文本形状**找导入子句的（不看是不是注释），
 *    注释里的示例会被当成真导入，然后报"路径无法解析"。
 */
import speedTable from '../shared/speed.js'
import reverseTable from '../shared/reverse.js'

const { SPEED_MAX, SPEED_MIN, clipSpeed, clipRateAt, curveSourceTime, readCurve, sourceSpan } = speedTable
export { SPEED_MAX, SPEED_MIN, clipSpeed, clipRateAt, curveSourceTime, readCurve, sourceSpan }

/* 倒放的局部时间翻转。真源在 shared/reverse.js —— 导出侧拼的是 ffmpeg 的 reverse/areverse，
   两侧**实现方式完全不同**（浏览器不能负速播放），所以更要共用同一份局部秒口径。 */
const { isReversed, reverseLocal } = reverseTable
export { isReversed, reverseLocal }

/**
 * 计算一次修剪产生的片段增量。
 *
 * @param {{start:number, duration:number, offset?:number}} clip 当前片段
 * @param {'start'|'end'} edge 拖的是哪一端
 * @param {number} at 指针所在的**绝对**秒数（已由调用方做过吸附）
 * @param {number} [min] 最短时长
 * @returns {{start:number, duration:number, offset:number}|null} null = 无变化，不要写状态
 */
export function trimPatch(clip, edge, at, min = MIN_CLIP_SECONDS) {
  const start = Number(clip && clip.start) || 0
  const duration = Number(clip && clip.duration) || 0
  const offset = Number(clip && clip.offset) || 0
  /** 0 / 缺失 / 非数字都视为"源片长度未知"，此时右端不设上限 */
  const limit = Number(clip && clip.sourceDuration) || 0
  const speed = clipSpeed(clip)
  const target = Number(at)

  if (!Number.isFinite(target)) return null
  if (!(duration > 0)) return null

  if (edge === 'start') {
    // 右边界：时长不能被压到 min 以下
    const maxStart = start + duration - min
    let next = Math.min(maxStart, Math.max(0, target))
    // 左边界：源入点不能被推到负数（推过头就会取到不存在的画面）。
    // offset 是"素材已经播掉的部分"，所以最多只能往左退 offset 秒；
    // ⚠️ 换算回时间线要**除以倍速** —— 源里的 offset 秒在 2 倍速片段上只占 offset/2 秒。
    const earliest = Math.max(0, start - offset / speed)
    if (next < earliest) next = earliest

    const delta = next - start
    if (Math.abs(delta) < EPSILON) return null
    return { start: next, duration: duration - delta, offset: offset + delta * speed }
  }

  if (edge === 'end') {
    let next = Math.max(start + min, target)
    // 上限：不能超过源片还剩多少（offset + duration * speed <= sourceDuration）。
    // 没有这一条就能把片段拖得比素材还长，拖动时看不出来，导出时尾部是黑帧。
    // ⚠️ 源里剩的秒数要**除以倍速**才是时间线上还能占多长。
    if (limit > 0) {
      const latest = start + Math.max(min, (limit - offset) / speed)
      if (next > latest) next = latest
    }
    const nextDuration = next - start
    if (Math.abs(nextDuration - duration) < EPSILON) return null
    // 右端修剪**不动** offset：只是提前收尾，源入点还是原来那个
    return { start, duration: nextDuration, offset }
  }

  return null
}

/**
 * 改倍速：返回要写回片段的增量，或 null（无变化）。
 *
 * ⚠️ 语义（这是这一条最容易被做错的地方，改之前先读完）：
 *   **换速不改变"这段片段吃掉源素材的哪一段"，只改变它在时间线上占多长。**
 *   即 `duration * speed` 守恒 —— 2 倍速就是同一段源内容用一半时间播完，
 *   于是片段在时间线上变短一半，画面内容不跳变。
 *   反过来做（保持时间线长度去改吃多少源）会让"调个速度画面整个换了一批"，
 *   而界面上一句提示都没有，属于「状态变了、画面变得莫名其妙」那一类。
 *
 * 收敛：源素材不够时按剩余量夹住（否则不变式 `offset + duration*speed <= sourceDuration`
 * 会被破坏，导出尾部照样黑帧）。
 *
 * @param {object} clip 当前片段
 * @param {number} nextSpeed 目标倍速（会被夹进 [SPEED_MIN, SPEED_MAX]）
 * @param {number} [min] 最短时长
 * @returns {{speed:number, duration:number}|null} null = 无变化，不要写状态
 */
export function speedPatch(clip, nextSpeed, min = MIN_CLIP_SECONDS) {
  const duration = Number(clip && clip.duration) || 0
  if (!(duration > 0)) return null
  const from = clipSpeed(clip)
  const raw = Number(nextSpeed)
  if (!Number.isFinite(raw)) return null
  const to = Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw))
  if (Math.abs(to - from) < 1e-4) return null

  // 源消耗守恒 ⇒ 新的时间线占位 = 旧的源跨度 / 新倍速
  let nextDuration = (duration * from) / to

  const limit = Number(clip && clip.sourceDuration) || 0
  const offset = Number(clip && clip.offset) || 0
  if (limit > 0) {
    const room = Math.max(0, (limit - offset) / to)
    if (nextDuration > room) nextDuration = room
  }
  nextDuration = Math.max(min, nextDuration)
  if (Math.abs(nextDuration - duration) < EPSILON && Math.abs(to - from) < 1e-4) return null
  return { speed: Number(to.toFixed(4)), duration: Number(nextDuration.toFixed(3)) }
}

/**
 * 「替换片段」的补丁：换**源**不换位置。
 *
 * 三件最容易静默算错的事全在这里，且每一件错了都不报错 ——
 * 只是"换了素材之后时间线悄悄变了形"：
 *
 *   ① **倍速守恒**：时间线占位 = 源时长 / 倍速（见 speed.js 的守恒口径）。
 *      2 倍速的片段换了素材却按 1 倍速去取时长，成片就会凭空多出一截；
 *      反过来按源时长硬填，则会超出新素材能吃到的范围。
 *   ② **源入点归零**：新素材从头开始吃。沿用旧 offset 会指向一个不存在的位置 ——
 *      轻则首帧不对，重则整段解码失败而预览只有黑屏。
 *   ③ **时长上限**：新素材比旧片段短时，占位必须收短到新素材的长度；
 *      比旧片段长时**保持原占位**（换素材不该把剪辑结果打乱）。
 *
 * 拿不到新素材时长（元数据读不出来）时**不动时长**：
 * 改成一个猜出来的值比保持现状更容易把时间线搞乱。
 *
 * 抽成纯函数是为了能被逐条测：这三件事的错法在界面上都是"看不出问题"，
 * 只有拿数字对才抓得到（见 composite-selftest 的 K 组）。
 *
 * @param {object} clip 被替换的片段
 * @param {{url:string, path?:string, name?:string, kind?:string, assetId?:string}} source 新素材
 * @param {number} [sourceDuration] 新素材真实片长（秒）；0 / NaN = 探测失败
 * @param {number} [min] 最短时长
 * @returns {object} 补丁（含 offset:0）；新素材没有 url 时返回 null
 */
export function replacePatch(clip, source, sourceDuration, min = MIN_CLIP_SECONDS) {
  if (!clip || !source || !source.url) return null
  const speed = clipSpeed(clip)
  const rate = speed > 0 ? speed : 1
  const current = Number(clip.duration) || 0
  const raw = Number(sourceDuration)
  const known = Number.isFinite(raw) && raw > 0 ? raw : 0
  /* 上限 = 新素材能吃到的时间线占位；探测失败时退回原占位（不动时长） */
  const ceiling = known > 0 ? known / rate : current
  const duration = Math.max(min, Math.min(current > 0 ? current : min, ceiling))
  return {
    url: source.url,
    path: source.path || '',
    name: source.name || clip.name,
    kind: source.kind || clip.kind,
    assetId: source.assetId || clip.assetId,
    offset: 0,
    duration: Number(duration.toFixed(3)),
    sourceDuration: known > 0 ? Number(known.toFixed(3)) : undefined
  }
}

/**
 * 联动组：同一个源素材在时间线上被拆成的所有片段（视频本体 + 被分离出来的音频）。
 *
 * 为什么按 `assetId` 而不是"选中的那几条"：用户从没手动"创建过组"，
 * 他理解的"联动"就是"这条片子的画面和声音要一起动"。按 assetId 分组天然符合这个直觉，
 * 而且不需要维护一张会过期的成员表（片段被删掉后，成员表里留着幽灵 id，
 * 下一次拖动就会静默少动一条）。
 *
 * ⚠️ 没有 assetId 的片段（字幕 / 纯文字 / 素材库拖进来的占位）**不参与联动**：
 *    它们的 assetId 是空的，若也按空值分组，所有字幕会被绑成一团一起动。
 */
export function linkedIds(clips, clipId) {
  const list = Array.isArray(clips) ? clips : []
  const target = list.find((item) => item.id === clipId)
  if (!target) return []
  if (!target.assetId) return [target.id]
  return list.filter((item) => item.assetId === target.assetId).map((item) => item.id)
}

/**
 * 联动平移：把 `clipId` 拖到 `nextStart` 时，整组片段各自应该落到的起点。
 *
 * 返回 `[{ id, start }]`（含被拖的那一条），调用方直接逐条 patch。
 *
 * ⚠️ 必须**整组夹住**而不是只夹被拖的那一条：单个夹的话，把视频往左拖到 0 时，
 *    声音还留在原地 —— 画面与声音直接错开，而且拖的过程中看不出来（两条都在动），
 *    只有播放时才发现"没声音"或"声音晚半秒"。
 *    所以这里先算整组能平移多少（受组内最早起点限制），再统一用这个量。
 *
 * @param {Array} clips 全部片段
 * @param {string} clipId 被拖的片段
 * @param {number} nextStart 被拖片段的目标起点（秒）
 * @param {boolean} enabled 联动开关（关掉 = 只动自己，行为与旧版一致）
 */
export function linkMovePatches(clips, clipId, nextStart, enabled = true) {
  const list = Array.isArray(clips) ? clips : []
  const target = list.find((item) => item.id === clipId)
  if (!target) return []
  const want = Number(nextStart)
  const from = Number(target.start) || 0
  if (!Number.isFinite(want)) return []
  if (!enabled) return [{ id: target.id, start: Math.max(0, want) }]

  const group = list.filter((item) => (target.assetId ? item.assetId === target.assetId : item.id === target.id))
  /* 整组的最小起点就是"最多还能往左挪多少" */
  const floor = Math.min(...group.map((item) => Number(item.start) || 0))
  const delta = Math.max(want - from, -floor)
  return group.map((item) => ({
    id: item.id,
    start: Number(((Number(item.start) || 0) + delta).toFixed(3))
  }))
}

/**
 * 播放头位于时间线某时刻时，该时刻对应的**源文件时间**（秒）。
 *
 * 为什么必须单独有这个函数：预览区原来直接把 `playhead` 赋给 `<video>.currentTime`。
 * 这两个值**只有**在片段正好从时间线 0 开始、且源入点也是 0 时才相等。片段一旦被拖到
 * 别处（start ≠ 0）或被剪过左端（offset ≠ 0），预览就会取到源文件里**另一处**的画面：
 * 表现为"画面比时间线早/晚一截"，而且剪得越多偏得越多 —— 和修剪忘了同步 offset 是同一族缺陷，
 * 只是一个在预览里现形、一个在导出后现形。
 *
 * 映射：时间线上的 t 落在片段内 → 源文件里的 `offset + (t - start) * speed`。
 * ⚠️ 倍速必须乘进去：2 倍速的片段，时间线走过 1 秒时源素材已经走掉 2 秒。
 * 漏了它就是"调了 2 倍速，预览画面还是原速"（导出却是 2 倍速）——
 * 预览与成片对不上，且两边单独看都没错，是最难查的那一类。
 *
 * 越界一律**夹**到片段两端（取首帧/末帧），而不是返回越界值让 `<video>` 自己去 clamp ——
 * 各浏览器/Electron 对越界 currentTime 的处理并不一致，不能把正确性寄托在它上面。
 *
 * @param {{start:number, duration:number, offset?:number, speed?:number}} clip 片段
 * @param {number} timelineSeconds 时间线秒数（播放头位置）
 * @returns {number} 源文件秒数；片段时长无意义时返回 0；时间非数字时退回入点
 */
export function sourceTimeAt(clip, timelineSeconds) {
  /* 实现已经搬到 `shared/speed.js`（主进程算「时间区域」裁剪时也要这份口径），
     这里只是转出同名函数，让已有的 import 路径与行为一字不变。
     ⚠️ 别再在这里补逻辑 —— 补了就是两份真源，预览与成片会各走一条。 */
  return speedTable.sourceTimeAt(clip, timelineSeconds)
}

