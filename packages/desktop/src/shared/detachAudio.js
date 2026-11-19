/**
 * 「把这一段的声音拆到音频轨上」—— **界面与 MCP 共用这一份**。
 *
 * 这件事看着只是一次 `push`，实际上有五个连带后果，漏一个就留下说不清的状态：
 *   ① 原片段必须静音（`gain = 0`），否则同一段声音播两遍、还自带 0~30ms 的梳状差；
 *   ② 原片段要记下**原来的音量**（`detachedGain`），删掉音频片段时才能**原样**还回去；
 *   ③ 原片段要打 `audioDetached` 标记，防止重复分离；
 *   ④ 新片段要记 `detachedFrom`，判重、还原、右栏说明"这条声音是从哪一段拆出来的"；
 *   ⑤ 删掉音频片段时要把原片段解静音（`restoreDetached`）—— 这是"分离"的另一半。
 *      不做的话：音频轨上那条没了、原片段 `gain` 还是 0 ⇒ 画面在播、完全没声音，
 *      而片段上一点提示都没有（用户会以为音频被删坏了）。
 *
 * 为什么放在 `shared/`：界面侧（`App.jsx`）和 agent 侧（`mcp-ops.js` 的
 * `timeline-op`）都要做这一件事。写两份的必然结果是"人点得出来、agent 调不动"，
 * 或者两边算出的时间区间差一点点 —— 正是双通道要防的后门。
 *
 * 纯函数：不改入参，返回新数组；失败返回 `{ ok: false, code, message }`，
 * `message` 直接可给用户看（界面弹 toast、MCP 当错误文案），措辞只有一份。
 */

/** 无法从片段读到时长的兜底（与渲染层 `DEFAULT_CLIP_SECONDS` 同一个数） */
const FALLBACK_SECONDS = 5

const numOr = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const reason = (code, message) => ({ ok: false, code, message })

/**
 * 把一个片段拆成「画面片段（静音）」+「音频片段」。
 *
 * @param {Array<object>} clips   片段表（不改）
 * @param {string} clipId         要分离的片段 id
 * @param {object} [options]
 * @param {() => string} [options.nextId]      发号器，缺省用时间戳兜底
 * @param {string[]} [options.lockedTracks]    锁定的轨道（锁定音频轨时拒绝）
 * @returns {{ok:true,clips:Array,audio:object,source:object}
 *          |{ok:false,code:string,message:string}}
 */
function detachAudio(clips, clipId, options = {}) {
  const list = Array.isArray(clips) ? clips : []
  const target = list.find((item) => item && item.id === clipId)
  if (!target) return reason('missing', '先选中一个带画面的片段')
  if (target.track === 'audio') return reason('already-audio', '它已经在音频轨上了')
  if (target.track === 'text' || target.kind === 'image' || target.kind === 'text' || target.kind === 'compound') {
    return reason('no-sound', '只有视频 / 叠加轨上的片段才有可分离的声音')
  }
  if (list.some((item) => item && item.detachedFrom === target.id)) {
    return reason('already-detached', '这一段的音频已经分离过了，它就在下面的音频轨上')
  }
  const locked = Array.isArray(options.lockedTracks) ? options.lockedTracks : []
  if (locked.includes('audio')) {
    return reason('audio-locked', '音频轨已锁定，解除锁定后才能放分离出来的声音')
  }
  if (!target.path && !target.url) return reason('no-source', '这一段的源文件地址丢了，找不到声音')

  const sourceGain = numOr(target.gain, 100)
  const id = typeof options.nextId === 'function' ? options.nextId() : `clip_${Date.now().toString(36)}`

  /* 音频片段 = 原片段的**同源、同区间、同速度**。
     速度必须带上：分离前后声音的时长要跟画面一致，否则后半段开始对不上口型。 */
  const audio = {
    id,
    track: 'audio',
    assetId: target.assetId,
    name: `${target.name || '片段'} · 音频`,
    url: target.url,
    path: target.path,
    kind: 'audio',
    start: numOr(target.start, 0),
    duration: numOr(target.duration, FALLBACK_SECONDS),
    offset: numOr(target.offset, 0),
    sourceDuration: numOr(target.sourceDuration, 0),
    gain: sourceGain,
    keepPitch: target.keepPitch !== false,
    speed: target.speed,
    detachedFrom: target.id
  }

  const next = list.map((item) =>
    item && item.id === target.id
      ? { ...item, gain: 0, audioDetached: true, detachedGain: sourceGain }
      : item
  )
  next.push(audio)
  return { ok: true, clips: next, audio, source: { id: target.id, gain: sourceGain } }
}

/**
 * 删除片段时把「被我分离出去的声音」还回去。
 *
 * 删掉的若是分离出来的音频片段，原片段必须解静音 —— 音量还成**分离前那个值**
 * （`detachedGain`），不是音频片段当前的 gain：用户在音频轨上把它调到 60、
 * 然后又删掉，意思显然是"不要这次分离了"，不是"我要 60"。
 *
 * @param {Array<object>} clips
 * @param {string[]} goneIds 要删的片段 id
 * @returns {Array<object>} 新数组
 */
function restoreDetached(clips, goneIds) {
  const list = Array.isArray(clips) ? clips : []
  const gone = new Set((Array.isArray(goneIds) ? goneIds : [goneIds]).filter(Boolean))
  if (!gone.size) return list
  const back = new Map()
  list.forEach((item) => {
    if (item && gone.has(item.id) && item.detachedFrom) {
      back.set(item.detachedFrom, item)
    }
  })
  const out = []
  list.forEach((item) => {
    if (!item || gone.has(item.id)) return
    const from = back.get(item.id)
    if (!from) {
      out.push(item)
      return
    }
    /* 用解构摘掉两个标记，而不是给它们赋 undefined ——
       赋 undefined 的键在 `JSON.stringify` 里会消失，但 `Object.keys` 里还在，
       静态闸门和草稿 diff 都会被这种"看起来有、其实没有"的键绕进去。 */
    const { audioDetached, detachedGain, ...rest } = item
    void audioDetached
    /* 只认分离前记下的那个数。读不到（旧草稿 / 手工改过）才退回 100 —— 不能退回
       `item.gain`：它此刻必然是 0（就是被分离动作静音的那个值）。 */
    const backGain = Number(detachedGain)
    out.push({ ...rest, gain: Number.isFinite(backGain) ? backGain : 100 })
  })
  return out
}

module.exports = { detachAudio, restoreDetached, FALLBACK_SECONDS }
