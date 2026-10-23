import { useCallback, useEffect, useRef } from 'react'
import { poseStyle } from '../../shared/adjust.js'
import { cssMirror, cssSkew, hasWarp, readEffects, warpTable } from '../../shared/effects.js'
import { cssCropTransform } from '../../shared/crop.js'
import { pipBoxCss, PIP_MAX_SIZE, PIP_MIN_SIZE, PIP_ANCHORS } from '../pip.js'

/**
 * 预览框里的**直接操作**（点选 / 拖移 / 四角缩放 / 旋转）。
 *
 * 为什么要有这一层：剪辑软件里 90% 的位置调整是「在预览里拖一下」，
 * 只有精确对齐才去右栏填数字。少了这一层，用户会在预览里按住拖动、
 * 结果什么也不发生 —— 那种"看着能操作、其实不能"最伤熟悉感。
 *
 * ## 几何为什么完全不测量 DOM
 *
 * 选框用的是**和画面元素同一串 transform**（pose / 斜切 / 镜像 / 裁剪，全部来自
 * shared/*），并且同样铺满画布、同样以元素中心为原点。浏览器把它们算出来的结果
 * 必然重合，于是：
 *   · 旋转时选框跟着转（不用自己算包围盒）；
 *   · 窗口缩放、全屏、换比例都自动正确（没有 ResizeObserver、没有首帧错位）；
 *   · 拖动过程中不需要"再测一次"，也就不会出现选框追着画面跑一帧的滞后。
 *
 * 只有**画中画**走另一套（它的盒子由锚点 + 尺寸决定，见 renderer/pip.js），
 * 但同样是复用导出那套公式，不是另写一份。
 */

/**
 * 这一层在**模型里**是谁。
 *
 * 复合片段展开之后，画面层是内部的子片段，id 形如 `父~子` —— 它在模型的片段表里
 * 根本不存在。选中、patch、右栏都只认外层那个复合片段，所以凡是要"回写模型"的地方
 * 一律先过这里（`selectionTargetOf` 与 Stage 的 `data-selectable` 用的是同一个函数，
 * 两边分开写就会出现"点得到、拖不动"或"选得中、右栏空着"）。
 */
export function layerOwnerId(layer) {
  if (!layer) return ''
  return layer.ownerId || layer.id || ''
}

/**
 * 这一层是不是"展开出来的内部区间"（复合片段 / 多机位）。
 *
 * 判据：它带着 `ownerId` 且 `ownerId !== id`。这样的层在模型里**不存在**
 * （id 是 `父id~子id` 拼出来的），它的 `posX / scale / rotate` 没有任何地方读 ——
 * 拖它只会往**外层**容器上写这些字段，而容器在渲染时会被摊平，于是：
 * 拖了、数字变了、画面一个像素没变（本项目最怕的第⑤类静默失效）。
 *
 * 所以这类层**不给选框**：点一下还能选中（进右栏、看信息），但不能直接拖。
 * 想调位置就解除复合 / 解除多机位，或者到内部片段上改。宁可"没有框"，
 * 也不要"框在、拖得动、成片里没生效"。
 */
function isExpandedLayer(layer) {
  if (!layer) return false
  return Boolean(layer.ownerId) && layer.ownerId !== layer.id
}

/** 选中目标：这一帧画面上被选中、且**真的能直接操作**的那个元素 */
export function selectionTargetOf({ selectedClipId, main, pip }) {
  if (!selectedClipId) return null
  if (main && layerOwnerId(main) === selectedClipId) {
    if (isExpandedLayer(main)) return null
    return { kind: 'main', id: layerOwnerId(main), item: main }
  }
  const hit = (pip || []).find((item) => layerOwnerId(item) === selectedClipId)
  if (hit) {
    if (isExpandedLayer(hit)) return null
    return { kind: 'pip', id: layerOwnerId(hit), item: hit }
  }
  /* 字幕 / 文字：位置来自样式表（贴边 + 偏移），拖动它等于改样式而不是改几何，
     所以不在这里做 —— 免得"拖了字幕、样式被改掉"这种难以撤销的事。 */
  return null
}

/**
 * 主画面选框的样式：与 MediaLayer 的 mediaStyleOf**同一串** transform。
 *
 * ⚠️ 自由变形（matrix3d）必须也在这里、且位置完全一致 —— 选框的几何不测 DOM，
 *    靠的就是"两处拼出同一串 transform，浏览器算出来必然重合"。
 *    少拼一段的后果是选框停在原矩形上、画面已经变成梯形，用户以为拖错了。
 *
 * @param {{w:number,h:number}} box 画框的布局像素尺寸（matrix3d 需要绝对像素）
 */
function mainBoxStyle(layer, aspectRatio, box) {
  const pose = poseStyle(layer) || {}
  const fx = readEffects(layer.effects)
  const warpT = hasWarp(fx) ? warpTable.cssWarpTransform(fx.warp, box && box.w, box && box.h) : ''
  const transform = [pose.transform, cssSkew(fx), cssMirror(fx), cssCropTransform(layer.crop), warpT]
    .filter(Boolean)
    .join(' ')
  return {
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    transform: transform || undefined
  }
}

/** 画中画选框的样式：与预览里那个盒子同一套（也同一套与导出对应的公式） */
function pipBoxStyle(item) {
  const box = pipBoxCss(item.anchor, item.size)
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    transform: box.transform
  }
}

/**
 * 选框的定位样式。
 *
 * `hit` 区域是**整块**（不只是边框）：参考客户端里点画面内部就能拖，
 * 不需要精准点到边框上。
 */
export function selectionBoxOf(target, aspectRatio, box) {
  if (!target) return null
  if (target.kind === 'main') {
    return { kind: 'main', style: mainBoxStyle(target.item, aspectRatio, box) }
  }
  if (target.kind === 'pip') {
    return { kind: 'pip', style: pipBoxStyle(target.item) }
  }
  return null
}

const CORNERS = [
  { key: 'nw', label: '左上' },
  { key: 'ne', label: '右上' },
  { key: 'sw', label: '左下' },
  { key: 'se', label: '右下' }
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/**
 * 拖动过程中的**指针坐标 → 参数**换算。
 *
 * 全部按"按下时的参数 + 指针位移"算绝对位置，不累加增量：
 * 指针被拖出窗口/丢事件时，累加会永久跑偏，绝对定位最多是这一帧没跟上。
 */
function nextPose(mode, drag, pointer, rect) {
  /* ⚠️ 入参是**拖动快照**（含 start.x/start.y 与扁平的 posX/posY/scale/rotate），
     不是单独的 start。早先把它拆成 start 之后 `start.posX` 全是 undefined ——
     算出来是 NaN，而 NaN 在 CSS 里等于"这条 transform 整条不输出"：
     拖动画面上什么都没发生、也不报错。 */
  const dx = pointer.x - drag.start.x
  const dy = pointer.y - drag.start.y
  const w = Math.max(1, rect.width)
  const h = Math.max(1, rect.height)

  if (mode === 'move') {
    /* posX/posY 的单位是**元素自身宽度的百分比**（translateX(50%) = 右移半个元素），
       而画面元素铺满画布 ⇒ 等于画布宽度的百分比。这里按画布像素换算。 */
    return {
      posX: Number((drag.posX + (dx / w) * 100).toFixed(2)),
      posY: Number((drag.posY + (dy / h) * 100).toFixed(2))
    }
  }
  if (mode === 'rotate') {
    /* 以画布中心为轴：指针相对中心的角度差，加上按下的角度。
       用 atan2 而不是"横向位移乘系数"，是为了让手感与指针位置一致
       （指针转多少度，画面就转多少度）。 */
    const cx = rect.left + w / 2
    const cy = rect.top + h / 2
    const a0 = Math.atan2(drag.start.y - cy, drag.start.x - cx)
    const a1 = Math.atan2(pointer.y - cy, pointer.x - cx)
    const delta = ((a1 - a0) * 180) / Math.PI
    return { rotate: Number(clamp(drag.rotate + delta, -180, 180).toFixed(1)) }
  }
  /* 四角缩放：按"指针到中心的距离比"。等比 —— 剪辑里拖角几乎总是想等比，
     自由变形另有面板（见「画面 → 自由变形」）。 */
  const cx = rect.left + w / 2
  const cy = rect.top + h / 2
  const d0 = Math.hypot(drag.start.x - cx, drag.start.y - cy) || 1
  const d1 = Math.hypot(pointer.x - cx, pointer.y - cy)
  const ratio = clamp(d1 / d0, 0.1, 10)
  return { scale: Number(clamp(drag.scale * ratio, 10, 400).toFixed(1)) }
}

/**
 * 主画面的**仿射链**（pose → 斜切 → 镜像 → 裁剪），**不含自由变形**。
 *
 * 为什么要单独拆出来：拖自由变形的角点时，要把屏幕位移换算回"变形之后、其它变换之前"
 * 的像素坐标 —— 也就是只反解仿射那一段。把 matrix3d（含变形本身）一起反解，
 * 得到的是"变形之前"的坐标，换算出来角点会越拖越偏，而且偏得很"合理"，看不出是错的。
 *
 * 拿浏览器算出来的矩阵而不是自己手写 4 个矩阵乘法：拼接顺序、transform-origin、
 * 百分比位移的口径全都由浏览器负责，和画面上真正渲染的那一串**同一份**。
 */
function affineMatrixOf(layer, fx) {
  if (typeof DOMMatrix === 'undefined') return null
  const pose = poseStyle(layer) || {}
  const parts = [pose.transform, cssSkew(fx), cssMirror(fx), cssCropTransform(layer.crop)].filter(Boolean)
  try {
    return parts.reduce((acc, str) => acc.multiply(new DOMMatrix(str)), new DOMMatrix())
  } catch (err) {
    return null
  }
}

/** 角点 key → 它在单位方形里的位置（与 warp.cornerPoints 的基准一致） */
const CORNER_BASE = {
  tl: { x: 0, y: 0 },
  tr: { x: 1, y: 0 },
  br: { x: 1, y: 1 },
  bl: { x: 0, y: 1 }
}

/** 手柄的四个 key（选框上只有这四个位置能拖角） */
const HANDLE_CORNER = { nw: 'tl', ne: 'tr', sw: 'bl', se: 'br' }

/**
 * 指针 → 这个角点应该被放到哪里（warp 参数的百分比口径）。
 *
 * 步骤：屏幕坐标 → 减去画框原点与中心 → 乘仿射逆 → 回到"变形后"的局部像素
 *      → 除以宽高得到归一化 → 减去该角的基准位置，就是 warp 里那个百分比偏移。
 *
 * 越界（±WARP_LIMIT）与自交/退化都返回 null：调用方保留上一帧的值，
 * 而不是把画面拉成蝴蝶结。
 */
function nextWarpCorner(drag, pointer) {
  const inv = drag.affineInv
  if (!inv || typeof DOMPoint === 'undefined') return null
  const W = drag.boxW
  const H = drag.boxH
  if (!(W > 0) || !(H > 0)) return null
  const qx = pointer.x - drag.frame.left - W / 2
  const qy = pointer.y - drag.frame.top - H / 2
  let local
  try {
    local = inv.transformPoint(new DOMPoint(qx, qy))
  } catch (err) {
    return null
  }
  const tx = (local.x + W / 2) / W
  const ty = (local.y + H / 2) / H
  const base = CORNER_BASE[drag.corner]
  if (!base) return null
  const x = Number(((tx - base.x) * 100).toFixed(2))
  const y = Number(((ty - base.y) * 100).toFixed(2))
  if (!warpTable.canPlaceCorner(drag.warp, drag.corner, x, y)) return null
  return { x, y }
}

/** 画中画：拖到哪儿就吸到最近的那个锚点（九宫格），尺寸由四角改 */
function nearestAnchor(pointer, rect) {
  const fx = clamp((pointer.x - rect.left) / Math.max(1, rect.width), 0, 1)
  const fy = clamp((pointer.y - rect.top) / Math.max(1, rect.height), 0, 1)
  let best = PIP_ANCHORS[0]
  let bestGap = Infinity
  PIP_ANCHORS.forEach((item) => {
    const gap = Math.hypot(item.fx - fx, item.fy - fy)
    if (gap < bestGap) {
      bestGap = gap
      best = item
    }
  })
  return best.key
}

/**
 * 选框组件。
 *
 * 手柄用 8px 的小方块（四角）+ 顶部一个旋转点，与参考客户端的选框同形。
 * 每个手柄都带 `data-sel-handle`，E2E 靠它定位（不靠坐标猜）。
 */
export default function SelectionBox({ box, frameRef, target, onPatch, onSnapshot }) {
  const dragRef = useRef(null)

  const begin = useCallback(
    (event, mode, corner) => {
      if (!box || !target) return
      event.stopPropagation()
      event.preventDefault()
      const frame = frameRef && frameRef.current
      if (!frame) return
      const rect = frame.getBoundingClientRect()
      const item = target.item || {}
      const fx = readEffects(item.effects)
      const warp = fx && fx.warp ? fx.warp : warpTable.readWarp(null)
      let affineInv = null
      if (mode === 'warp' && fx) {
        const affine = affineMatrixOf(item, fx)
        try {
          affineInv = affine ? affine.inverse() : null
        } catch (err) {
          affineInv = null
        }
      }
      if (onSnapshot) onSnapshot()
      dragRef.current = {
        mode,
        target,
        rect,
        start: { x: event.clientX, y: event.clientY },
        posX: Number(item.posX) || 0,
        posY: Number(item.posY) || 0,
        scale: Number(item.scale) || 100,
        rotate: Number(item.rotate) || 0,
        size: Number(item.size) || 0,
        moved: false,
        /* 自由变形：拖的是"变形后局部像素坐标"，需要画框尺寸与仿射逆 */
        corner,
        warp,
        affineInv,
        /* 用布局尺寸而不是 getBoundingClientRect：后者已经被 transform 缩放污染 */
        boxW: frame.clientWidth,
        boxH: frame.clientHeight,
        frame: { left: rect.left, top: rect.top }
      }
    },
    [box, frameRef, onPatch, onSnapshot, target]
  )

  useEffect(() => {
    const onMove = (event) => {
      const drag = dragRef.current
      if (!drag) return
      event.preventDefault()
      drag.moved = true
      if (drag.mode === 'warp') {
        /* 自由变形的角点：落不到合法位置（越界 / 自交 / 退化）就保留上一帧，
           宁可"拖到这里不动"，也不要画出撕裂的四边形。 */
        const next = nextWarpCorner(drag, { x: event.clientX, y: event.clientY })
        if (next) {
          const warp = { ...drag.warp, on: true, [drag.corner]: next }
          drag.warp = warp
          onPatch(drag.target.id, { effects: { ...(drag.target.item.effects || {}), warp } })
        }
        return
      }
      if (drag.target.kind === 'main') {
        onPatch(drag.target.id, nextPose(drag.mode, drag, { x: event.clientX, y: event.clientY }, drag.rect))
        return
      }
      /* 画中画：拖动改锚点（吸到最近的一格），四角改尺寸（按距离比，与主画面同口径） */
      if (drag.mode === 'move') {
        onPatch(drag.target.id, { pip: { anchor: nearestAnchor({ x: event.clientX, y: event.clientY }, drag.rect), size: drag.target.item.size } })
        return
      }
      const cx = drag.rect.left + drag.rect.width / 2
      const cy = drag.rect.top + drag.rect.height / 2
      const d0 = Math.hypot(drag.start.x - cx, drag.start.y - cy) || 1
      const d1 = Math.hypot(event.clientX - cx, event.clientY - cy)
      const size = clamp(Math.round((drag.size || 30) * (d1 / d0)), PIP_MIN_SIZE, PIP_MAX_SIZE)
      onPatch(drag.target.id, { pip: { anchor: drag.target.item.anchor, size } })
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [onPatch])

  if (!box || !target) return null

  /* 开了「自由变形」之后，四角手柄改成拖动对应的角点（这是这个功能的操作方式本身）。
     ⚠️ 手柄仍然放在选框的四个角上 —— 选框的边框在变形后本来就是那个四边形
        （单应把直线映成直线），所以手柄位置天然就是四个角点，不需要另算一遍。 */
  const fxNow = readEffects(target.item && target.item.effects)
  const warpOn = box.kind === 'main' && Boolean(fxNow && fxNow.warp && fxNow.warp.on)

  return (
    <div
      className={`canvas-sel canvas-sel-${box.kind}`}
      data-sel="1"
      data-sel-kind={box.kind}
      data-sel-id={target.id}
      data-sel-warp-on={warpOn ? '1' : undefined}
      style={box.style}
      /* 拖动整块：点画面内部就能拖（不必精准点到边框） */
      onPointerDown={(event) => begin(event, 'move')}
      /* 双击复位：位置 / 缩放 / 旋转一起回默认。剪辑里"拖歪了"最常见的收场 */
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (box.kind === 'main') onPatch(target.id, { posX: 0, posY: 0, scale: 100, rotate: 0 })
      }}
      title={warpOn ? '拖动可移动；四角拖动改变形；双击复位位置' : '拖动可移动；四角缩放；顶部圆点旋转；双击复位'}
    >
      {/* 四角手柄：主画面 = 等比缩放（开变形时 = 拖角点），画中画 = 改尺寸 */}
      {CORNERS.map((corner) => (
        <span
          key={corner.key}
          className={`canvas-sel-handle canvas-sel-${corner.key}${warpOn ? ' canvas-sel-corner-warp' : ''}`}
          data-sel-handle={corner.key}
          data-sel-warp={warpOn ? HANDLE_CORNER[corner.key] : undefined}
          role="presentation"
          title={warpOn ? `拖动${corner.label}角改变透视` : `拖动${corner.label}角${box.kind === 'main' ? '等比缩放' : '改尺寸'}`}
          onPointerDown={(event) => begin(event, warpOn ? 'warp' : 'scale', HANDLE_CORNER[corner.key])}
        />
      ))}
      {box.kind === 'main' ? (
        <span
          className="canvas-sel-rot"
          data-sel-handle="rotate"
          role="presentation"
          title="拖动旋转"
          onPointerDown={(event) => begin(event, 'rotate')}
        />
      ) : null}
    </div>
  )
}
