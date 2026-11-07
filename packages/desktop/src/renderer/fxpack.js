/**
 * 特效素材包 —— 渲染层侧的状态。
 *
 * ## 为什么是一个小 store 而不是各自去 invoke
 *   特效覆盖层（Stage）和特效页（SidePanels）都要问"这个效果有没有素材"。
 *   两处各发一次 IPC ⇒ 出现"面板说有、画面说没有"这种只差一次时序的假象。
 *   这里只发一次，谁需要谁来读同一份快照。
 *
 * ## 为什么 ready 与空要分开
 *   `ready: false` = 还在问主进程；`ready: true` + 空 effects = **确实没装素材包**。
 *   混成一个的话，界面在启动头几十毫秒里会把所有素材卡标成"未安装"，
 *   然后跳回来 —— 用户看到的是闪一下的错误提示。
 */
import { useEffect, useState } from 'react'

const listeners = new Set()
let snapshot = { ready: false, effects: {}, packs: [] }
let booted = null

function emit() {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* 某个订阅者报错不该拖垮其它订阅者 */
    }
  }
}

export function subscribeFxPacks(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const fxPackSnapshot = () => snapshot

/**
 * 问主进程要一次状态（幂等：并发调用共用同一个 promise）。
 * 主进程在第一次问的时候会顺手把内置包装好，所以这里不需要单独"安装"一步。
 */
export async function ensureFxPacks() {
  if (booted) return booted
  const api = typeof window !== 'undefined' ? window.yjai && window.yjai.fxpack : null
  if (!api) {
    snapshot = { ready: true, effects: {}, packs: [], unsupported: true }
    emit()
    booted = Promise.resolve(snapshot)
    return booted
  }
  booted = (async () => {
    try {
      const res = await api.state()
      snapshot = {
        ready: true,
        effects: (res && res.effects) || {},
        packs: (res && res.packs) || []
      }
    } catch (error) {
      /* 素材包坏了不该让整个界面白屏：如实标成"没有素材"，卡片退化成不可用 */
      snapshot = { ready: true, effects: {}, packs: [], error: String(error && error.message) }
    }
    emit()
    return snapshot
  })()
  return booted
}

/** 某个效果对应的素材（没有就是 null）。调用方必须能接受 null。 */
export function fxPackOf(key) {
  return snapshot.effects[key] || null
}

/** 组件用：拿快照，并在数据到达后自动重渲染一次 */
export function useFxPacks() {
  const [snap, setSnap] = useState(snapshot)
  useEffect(() => {
    let live = true
    const sync = () => {
      if (live) setSnap(snapshot)
    }
    listeners.add(sync)
    ensureFxPacks().then(sync).catch(() => {})
    return () => {
      live = false
      listeners.delete(sync)
    }
  }, [])
  return snap
}
