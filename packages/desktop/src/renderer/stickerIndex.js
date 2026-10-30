/**
 * 内置贴纸清单的**进程内索引**（key → name/url/group）。
 *
 * 两处消费者：
 *   · 「贴纸」面板 —— 列 140 枚网格；
 *   · 「模板」面板 —— 模板里按 key 引用贴纸（`shared/templates.json` 的 `sticker` 字段），
 *     套用时必须把 key 换成 `yjai-media://` 地址，否则贴纸那一条只能被跳过。
 *
 * 为什么只有这一份：两处各缓存一份的话，会出现"先开贴纸页再套模板正常、
 * 直接套模板就少一枚贴纸"这类**跟操作顺序有关**的问题 ——
 * 两边单独跑都正常，只有连起来用才露，最难查。
 *
 * 缓存的是 **Promise** 而不是结果：面板与模板同时挂载时只发一次 IPC。
 * 失败也缓存（返回 null），否则切页签会把同一条失败重试十几次。
 */
import { isDesktop } from './platform.js'

let PENDING = null
let RESULT = null

/**
 * @returns {Promise<{ groups: object[], index: Map<string, object>, license?: string } | null>}
 *          null = 桌面端不可用 / 读取失败（调用方给一句人话提示，不要静默）
 */
export function loadStickerCatalog() {
  if (RESULT) return Promise.resolve(RESULT)
  if (PENDING) return PENDING
  if (!isDesktop || !window.yjai?.stickers?.catalog) {
    RESULT = null
    return Promise.resolve(null)
  }

  PENDING = window.yjai.stickers
    .catalog()
    .then((res) => {
      if (!res || !res.ok) return null
      const index = new Map()
      for (const group of res.groups || []) {
        for (const item of group.items || []) {
          index.set(item.key, {
            key: item.key,
            name: item.name,
            url: item.url,
            group: group.key,
            w: item.w,
            h: item.h
          })
        }
      }
      RESULT = { groups: res.groups || [], index, license: res.license || '', source: res.source || '' }
      return RESULT
    })
    .catch(() => null)
    .finally(() => {
      PENDING = null
    })

  return PENDING
}

/** 测试与"换库后要重读"用：清掉缓存（正常运行时不必调） */
export function resetStickerCatalog() {
  RESULT = null
  PENDING = null
}
