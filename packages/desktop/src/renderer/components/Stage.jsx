import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconFullscreen,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipForward
} from '../icons.jsx'
import { FRAME_RATE } from '../keymap.js'
import { frameEffectClass, frameEffectDuration, overlayEffectClass } from '../frameEffects.js'
import { cssFilterFor, filterDef, isNoopFilter } from '../looks.js'
import { animClassOf, textStyleCss } from '../textStyles.js'
import { pipBoxCss } from '../pip.js'
import { timecodeFrames } from '../ui.jsx'
/* 调节 / 美颜 / 位置旋转（真源在 shared/adjust.js，导出侧 render.js 用的是同一份换算） */
import { cssFilterOps, gradeMatrix, poseStyle } from '../../shared/adjust.js'
/* 效果（圆角 / 蒙版 / 抠像 / 混合 / 变形 / 描边 / 阴影）—— 真源在 shared/effects.js，
   导出侧 render.js 用的是同一份换算（见那份文件的说明：两侧不许各写一遍）。 */
import {
  cssMaskFor,
  cssRadius,
  cssSkew,
  blendCss,
  hasClip,
  keyAlphaRow,
  readEffects,
  shadowFilter,
  strokeShadows
} from '../../shared/effects.js'
/**
 * 画面比例的真源（与导出共用同一份表，见 shared/aspect.js 的说明）。
 *
 * ⚠️ `ASPECTS` 是**界面上那一排按钮的唯一来源**：加一个比例只改那份表，
 *    这里不做第二张清单 —— 否则"表里有了、按钮上没有"或反过来，
 *    都是不报错、只有盯着看才发现的缺陷。
 */
import { ASPECTS, aspectRatioOf, normalizeAspect } from '../../shared/aspect.js'

/** 预览画布：图片/视频直接播，音频给波形占位，文本直接显示正文 */
function Previews({ asset, videoRef, onReady, style }) {
  if (!asset) {
    return (
      <div className="canvas-placeholder">
        <strong>预览区</strong>
        <small>把素材拖到时间线上，这里跟随播放头显示画面</small>
      </div>
    )
  }

  if (asset.kind === 'image' && asset.url) return <img src={asset.url} alt={asset.name} style={style} />
  if (asset.kind === 'video' && asset.url) {
    return (
      <video
        ref={videoRef}
        src={asset.url}
        /* ⚠️ 不要在这里写 muted：主画面**带声**（音量由喇叭键/滑杆统一控制）。
           以前这里写死了 muted，于是"加了视频预览却听不到声音"——
           界面上有音量滑杆、有喇叭键，点下去却毫无变化，属于典型的静默失效。
           转场交叠时那一段（IncomingLayer）才需要静音，理由见那里。 */
        playsInline
        preload="auto"
        style={style}
        /* metadata 到位才知道 el.duration，此时再对齐一次源时间（首帧不能停在 0） */
        onLoadedMetadata={onReady}
      />
    )
  }
  if (asset.kind === 'audio' && asset.url) {
    return (
      <div className="canvas-placeholder">
        <strong>{asset.name}</strong>
        <small>音频素材没有画面，已按波形摆放在音频轨</small>
      </div>
    )
  }
  if (asset.kind === 'text') {
    return (
      /* ⚠️ `style` 必须一起挂上：这是「位置大小 / 缩放 / 旋转 / 斜切」落地的那一层。
         文字类片段（把文字素材拖到画面轨）漏了这一句，右栏那些滑杆在预览里
         就一个像素都不动 —— 而导出侧照旧生效，属于最难查的那种"两侧不一致"。 */
      <div className="canvas-placeholder" style={{ maxWidth: 560, textAlign: 'left', ...(style || null) }}>
        <strong>{asset.name}</strong>
        <small style={{ whiteSpace: 'pre-wrap', color: 'var(--wb-muted)' }}>{asset.text || '（无正文）'}</small>
      </div>
    )
  }
  return (
    <div className="canvas-placeholder">
      <strong>{asset.name}</strong>
      <small>这类产物没有可视预览，已记录在媒体库里</small>
    </div>
  )
}

/**
 * 转场时叠在画面上的「后一段」由 MediaLayer 承担（`role: 'incoming'`）。
 *
 * ⚠️ 它必须是**自己一个 <video>**，不能复用主层那个：主层正在播前一段，
 * 两个片段要同时出现（这才是转场）。共用一个元素就只能二选一，
 * 那正是"加了转场但预览里看不出来"的原因。
 *
 * ⚠️ 而且它必须**提前**就在 DOM 里（见 composite.js 的热点窗口）：
 * 以前它是在交叠窗口开始的那一刻才新建元素的，于是每个转场的第一帧都是黑的 ——
 * 元素刚挂载、解码器还没起步。现在它和主层一样是常驻的一层，只是平时不显示。
 */
/**
 * 音频轨的播放层（BGM / 配音 / 音效）。
 *
 * 为什么必须单独一层 <audio>：时间线的音频轨与视频轨是**并列**的两条轨，
 * 视频轨放的是素材自己的声音，音频轨放的是后加的配乐或配音。以前预览只渲染
 * 「播放头所在的那个片段」，于是音频轨上的片段在预览里完全不发声 ——
 * 用户拖一段 BGM 进时间线、按播放，什么也听不到，只能导出成片才知道有没有加上。
 * 这正是"功能看着有、实际没接"的那类缺陷。
 *
 * 同步口径与画面同源：对齐**源文件时间**（sourceTime）、阈值 0.25s，
 * 播放/暂停/音量跟主播放器一起走。
 */
function AudioTrackLayer({ track, playing, volume }) {
  const ref = useRef(null)
  const url = track?.url || ''
  const sourceTime = Number(track?.sourceTime) || 0

  const apply = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (!Number.isFinite(el.duration) || el.duration <= 0) return
    const want = Math.max(0, Math.min(sourceTime, el.duration - 0.05))
    if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want
  }, [sourceTime])

  useEffect(() => {
    const el = ref.current
    if (!el || !url) return
    const gain = Math.max(0, Math.min(1, Number(track?.gain) ?? 1))
    el.volume = Math.max(0, Math.min(1, ((volume ?? 100) / 100) * gain))
    /* 倍速与画面同一口径：只对齐源时间不设 playbackRate，声音就会"越播越落后" */
    const rate = Math.min(16, Math.max(0.0625, Number(track?.speed) || 1))
    if (typeof el.playbackRate === 'number') el.playbackRate = rate
    apply()
    if (playing) el.play().catch(() => {})
    else el.pause()
  }, [apply, playing, url, volume, track?.gain, track?.speed])

  if (!url) return null
  return <audio ref={ref} src={url} preload="auto" onLoadedMetadata={apply} data-audio-track={track?.id || ''} />
}

/**
 * 音频轨的播放层可以有多条（重叠的配乐 / 配音同时在场），所以外面再套一层。
 * 以前只取"id 最大的那一条"，重叠区间里另一条凭空不发声 ——
 * 而导出是两条都混的，于是又变成"预览与成片不一致"。
 */
function AudioLayers({ tracks, playing, volume }) {
  if (!tracks || !tracks.length) return null
  return (
    <>
      {tracks.map((track) => (
        <AudioTrackLayer key={track.id} track={track} playing={playing} volume={volume} />
      ))}
    </>
  )
}

/**
 * 片段级缩放 / 位置 / 旋转 / 不透明度（属性面板「画面」页的值）。
 *
 * ⚠️ 换算**不在这里** —— 全在 `shared/adjust.js` 的 `poseStyle()` 里，
 *    因为导出侧 render.js 用的是同一组数（translateX% ↔ crop 偏移、scale ↔ iw*k、
 *    磨皮的 1.02 保边放大）—— 两边各写一遍迟早出现"预览挪了、成片没挪"，
 *    而那种缺陷界面上一眼看不出、只有导出成片才知道。
 *
 * ⚠️ 只写 transform / opacity，**不写 filter** —— 调色住在这一层自己的内联 filter 上
 *    （见 MediaLayer），这里再写会把它顶掉；而 CSS 动画的优先级又高于内联样式，
 *    所以两类效果必须各占一个属性，谁也不能挤谁。
 */
function mediaStyleOf(layer, fx) {
  const pose = poseStyle(layer) || {}
  const skew = fx ? cssSkew(fx) : ''
  /* 斜切要**先于**位置/缩放作用在内容上（导出侧 render.js 里 shear 也排在 pose 之前）。
     CSS 的 transform 列表是从右往左作用，所以 skew 写在最后 = 最先作用。 */
  const transform = [pose.transform, skew].filter(Boolean).join(' ')
  const out = {}
  if (transform) out.transform = transform
  if (pose.opacity) out.opacity = pose.opacity
  return Object.keys(out).length ? out : undefined
}

/**
 * 逐通道增益（亮度 / 美白 / 色温 / 色调）走 **SVG feColorMatrix**。
 *
 * 为什么非它不可：CSS 那套 `brightness()/contrast()/saturate()` 都是"整体"算子，
 * 没有"按通道乘一个系数"的写法，而色温/色调的本质就是红蓝/绿三通道各自乘。
 * 用 `sepia()` 之类的近似会让画面整片发棕（观感完全不对），而 ffmpeg 那边的
 * `colorchannelmixer` 就是一个纯粹的对角增益 —— 用矩阵才能两侧真的对上。
 *
 * ⚠️ 定义必须跟着层**一起常驻**：`filter` 里一旦引用了不存在的 id，
 *    浏览器会把**整串** filter 判为无效 —— 连 looks 的调色一起静默失效，
 *    而构建、静态扫描、逐像素比对都看不出来。
 *    所以这里对每一层都渲染（中性层不生成矩阵、也就不引用它）。
 */
function GradeDefs({ layers }) {
  const list = (layers || [])
    .map((layer) => ({ id: layer.id, matrix: gradeMatrix(layer.adjust, layer.beauty) }))
    .filter((item) => item.matrix)
  if (!list.length) return null
  return (
    <svg className="canvas-grade-defs" aria-hidden="true" focusable="false">
      <defs>
        {list.map((item) => (
          <filter id={`yjai-grade-${item.id}`} key={item.id} colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={item.matrix} />
          </filter>
        ))}
      </defs>
    </svg>
  )
}

/**
 * 抠像的 `feColorMatrix` 定义（绿幕 / 蓝幕）。
 *
 * 为什么要 SVG：CSS 没有任何"按通道算 alpha"的算子，而抠像的本质就是
 * 「把键色的那一路通道压下去、其余通道之和当成不透明度」—— 只有矩阵能表达。
 * ⚠️ 与 GradeDefs 同一个坑：`filter` 里引用一个不存在的 id，浏览器会把**整串**
 *    filter 判为无效（连调色、描边、阴影一起静默消失），所以定义必须与引用了它的层
 *    同处一棵树，且只在真的要抠像时才生成。
 */
function KeyDefs({ layers }) {
  const list = (layers || [])
    .map((layer) => {
      const fx = readEffects(layer.effects)
      return { id: layer.id, row: keyAlphaRow(fx) }
    })
    .filter((item) => item.row)
  if (!list.length) return null
  return (
    <svg className="canvas-grade-defs" aria-hidden="true" focusable="false">
      <defs>
        {list.map((item) => (
          <filter id={`yjai-key-${item.id}`} key={item.id} colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  ${item.row}`} />
          </filter>
        ))}
      </defs>
    </svg>
  )
}

/**
 * 一层画面上一整套「效果」的装配（**预览侧唯一的装配点**）。
 *
 * 顺序与导出侧 render.js 的 ffmpeg 链一致：
 *   抠像 → 调色/调节 → 描边 → 阴影；
 *   圆角与蒙版是**剪裁**（挂在里层的遮罩盒上，见 MediaLayer）——
 *   剪裁必须在描边之前，否则描边会被剪掉一半。
 *
 * ⚠️ 抠像与蒙版都是 alpha 操作、"相乘"关系，所以两者先后不影响结果；
 *    但**描边/阴影必须排在剪裁之后**（它们是从最终 alpha 推出来的）。
 */
function effectFilterParts(layer, fx, gradeRef, adjustOps, cssFilter) {
  const keyRef = fx.key.on ? `url(#yjai-key-${layer.id})` : ''
  return [keyRef, gradeRef, adjustOps, cssFilter, strokeShadows(fx), shadowFilter(fx)].filter(Boolean)
}

/**
 * 「剪裁类」效果（圆角 + 蒙版）→ 一个可以挂到**里层**元素上的 style。
 *
 * ⚠️ 为什么必须挂在里层、不能和 filter 挤同一个元素：
 *    CSS 的合成顺序是 **filter → clip → mask**。把圆角/蒙版和描边/阴影挂在同一个
 *    元素上，描边会被圆角切掉一圈；而模板里我们想要的是"先有形状，再给形状描边"。
 *    所以：外层 span 挂 filter（描边/阴影/调色/抠像），里层这个盒子只管剪裁。
 *
 * ⚠️ 没有剪裁类效果时返回 null，DOM 保持改动前的原样（零回归）。
 *
 * @param {number} aspectRatio 画框宽高比（正圆要用它换算，见 shared/effects.js）
 */
function clipStyleFor(fx, aspectRatio) {
  if (!hasClip(fx)) return null
  const style = {}
  const radius = cssRadius(fx)
  if (radius) {
    style.borderRadius = radius
    style.overflow = 'hidden'
  }
  const mask = cssMaskFor(fx, aspectRatio)
  if (mask && mask.maskImage) {
    style.WebkitMaskImage = mask.maskImage
    style.maskImage = mask.maskImage
    if (mask.maskComposite) {
      style.WebkitMaskComposite = 'source-in, source-in'
      style.maskComposite = mask.maskComposite
    }
  }
  return Object.keys(style).length ? style : null
}

/**
 * 一层画面 —— 时间线上一个片段在这一帧的样子。
 *
 * ⚠️ 每层**自己持有一个媒体元素**，并且 `key` 用片段 id（见调用处）。
 *    这是「整条时间线连续播放」的全部关键：
 *      以前整块预览只有**一个** <video>，跨片段时是**换它的 src** ——
 *      于是每过一个接缝都要重新加载、重新解码，接缝处必黑一帧；
 *      转场尤其明显，因为后一段是在交叠窗口开始的那一刻才被新建出来的。
 *    现在同一条时间线上的片段各自有一个元素、并**提前挂载**（composite.js 的热点窗口），
 *    切换只是"显示哪一层"，从头到尾不碰 src。
 *
 * 时间对齐与主层同源：**对齐源文件时间**（不是播放头秒数）、阈值 0.25s。
 * 层的可见性、层叠顺序、谁是主层，全部由 composite.js 算好，这里只负责画。
 */
function MediaLayer({ layer, playing, volume, audible, aspectRatio }) {
  const ref = useRef(null)
  const sourceTime = Number(layer.sourceTime) || 0
  const url = layer.url || ''

  const align = useCallback(() => {
    const el = ref.current
    if (!el || typeof el.currentTime !== 'number') return
    if (!Number.isFinite(el.duration) || el.duration <= 0) return
    const want = Math.max(0, Math.min(sourceTime, el.duration - 0.05))
    if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want
  }, [sourceTime])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof el.currentTime !== 'number') return
    /* 只有**听得到**的那一层出声：多层同时响会糊成一片。
       谁是主层由合成器算好（转场时后一段画在最上面，但主层仍是前一段）。 */
    el.muted = !audible
    /* 片段音量（属性面板的音量滑杆）。⚠️ 以前它只进导出、没进预览：
       滑杆改了片段上的 gain，成片真的变小声，预览一点变化都没有。 */
    const gain = Math.max(0, Math.min(1, Number(layer.gain) / 100))
    el.volume = Math.max(0, Math.min(1, ((volume ?? 100) / 100) * gain))
    /**
     * 倍速。
     *
     * ⚠️ 光把源时间乘上倍速（sourceTimeAt 已经做了）**不够** —— 那只对齐了"这一刻
     *    对应源里哪一秒"，而 `<video>` 自己往后播的速度还是 1 倍。于是 2 倍速的片段
     *    在预览里一开始是对的，越播越落后（播放头走 1 秒、画面只走 0.5 秒的源内容），
     *    表现为"预览慢半拍、成片却是快的"。
     *    同理只设 playbackRate 而不换算源时间，起点就会错。两者必须同时成立。
     */
    const rate = Math.min(16, Math.max(0.0625, Number(layer.speed) || 1))
    if (typeof el.playbackRate === 'number') el.playbackRate = rate
    /**
     * ⚠️ **不可见的层也要对齐**：它们就是"提前挂载"的那一批，
     *   对齐到自己的入点（未来片段）或末帧（已播完的片段），
     *   等到轮到它出场时 currentTime 已经在正确的位置 ——
     *   这是"接缝不黑帧"的另一半（另一半是元素本身已经挂载）。
     */
    align()
    if (layer.visible && playing) el.play().catch(() => {})
    else el.pause()
  }, [align, audible, layer.gain, layer.speed, layer.visible, playing, url, volume])

  /**
   * 调色（CSS filter）、调节/美颜、缩放/位置/旋转分开挂：
   *   · filter 挂**层**上 —— 每个片段各带各的调色，转场时后一段才不会
   *     莫名其妙套上前一段的滤镜（成片里两段是各转各的）；
   *   · transform / opacity 挂**媒体元素**上 —— 滤镜与变换叠在同一个元素上
   *     会互相影响（transform 会改变滤镜的作用域），分开最省心。
   *
   * 三个来源（逐通道增益的 SVG 矩阵 / 调节美颜的对比度饱和度磨皮 / looks 调色）
   * 合成**一条** filter 声明，顺序与 render.js 的 ffmpeg 链一致：
   *   增益 → 磨皮 → 对比度/饱和度 → 调色。
   */
  const cssFilter = cssFilterFor(layer.filter, layer.filterIntensity)
  const adjustOps = cssFilterOps(layer.adjust, layer.beauty)
  const gradeRef = gradeMatrix(layer.adjust, layer.beauty) ? `url(#yjai-grade-${layer.id})` : ''
  const fx = readEffects(layer.effects)
  const filterParts = effectFilterParts(layer, fx, gradeRef, adjustOps, cssFilter)
  const layerFilter = filterParts.length ? filterParts.join(' ') : ''
  const boxStyle = {}
  if (layerFilter) boxStyle.filter = layerFilter
  if (!layer.visible) boxStyle.display = 'none'
  /* 混合模式只对**叠在别的画面上**的层有意义（主画面底下没有东西可混）——
     导出侧 render.js 也只在 overlay 合成那一处用 blend。 */
  const mix = layer.role === 'main' ? '' : blendCss(fx)
  if (mix) boxStyle.mixBlendMode = mix

  const clipBox = clipStyleFor(fx, aspectRatio)
  const mediaStyle = mediaStyleOf(layer, fx)

  const inner = (
    <Previews
      asset={{
        kind: layer.kind,
        url,
        name: layer.name,
        text: layer.text
      }}
      videoRef={ref}
      onReady={align}
      style={mediaStyle}
    />
  )

  /* 圆角 / 蒙版挂在里层的剪裁盒上（外层 span 的 filter 里有描边/阴影，见 clipStyleFor 的说明）。
     没有剪裁类效果时**不插盒子**，DOM 与改动前逐字相同（零回归）。 */
  const media = clipBox ? (
    <span className="canvas-clipbox" style={clipBox}>
      {inner}
    </span>
  ) : (
    inner
  )

  /* 转场层：后一段"正在盖过来"，铺满画布并自行裁剪（clip-path / transform 都要靠它） */
  if (layer.xfade) {
    return (
      <span
        className="canvas-xfade"
        data-layer={layer.id}
        data-layer-role={layer.role}
        /* 效果落点：闸门按这几个属性断言"面板上拖了、预览里真的有东西"，
           而不是去反解拼出来的 filter / mask 串（那种串每次构建都可能不一样）。 */
        data-fx-radius={fx.radius > 0.01 ? String(fx.radius) : ''}
        data-fx-mask={fx.mask.shape}
        data-fx-key={fx.key.on ? '1' : ''}
        data-fx-key-map={fx.key.on ? 'approx' : ''}
        data-fx-stroke={fx.stroke.on ? String(fx.stroke.width) : ''}
        data-fx-shadow={fx.shadow.on ? '1' : ''}
        data-fx-skew={Math.abs(fx.skewX) > 0.01 || Math.abs(fx.skewY) > 0.01 ? '1' : ''}
        data-xfade={layer.xfade.key}
        /* exact / approx：CSS 能一比一表达哪些、近似表达哪些，如实标出来，
           免得后来有人把"近似"当成"已经和参考一模一样" */
        data-xfade-map={EXACT_XFADE.includes(layer.xfade.key) ? 'exact' : 'approx'}
        data-xfade-p={Number(layer.xfade.progress).toFixed(3)}
        style={{ ...xfadeStyle(layer.xfade.key, layer.xfade.progress), ...(layerFilter ? { filter: layerFilter } : null) }}
      >
        {media}
      </span>
    )
  }

  return (
    <span
      className="canvas-layer"
      data-layer={layer.id}
      data-layer-role={layer.role}
      data-fx-radius={fx.radius > 0.01 ? String(fx.radius) : ''}
      data-fx-mask={fx.mask.shape}
      data-fx-key={fx.key.on ? '1' : ''}
      data-fx-key-map={fx.key.on ? 'approx' : ''}
      data-fx-stroke={fx.stroke.on ? String(fx.stroke.width) : ''}
      data-fx-shadow={fx.shadow.on ? '1' : ''}
      data-fx-skew={Math.abs(fx.skewX) > 0.01 || Math.abs(fx.skewY) > 0.01 ? '1' : ''}
      style={Object.keys(boxStyle).length ? boxStyle : undefined}
    >
      {media}
    </span>
  )
}

/**
 * 转场层的内联样式。
 *
 * 全部由 **progress ∈ [0,1]** 推出，且只用 clip-path / transform / opacity / mask，
 * 这几类都是合成器友好的属性，播放时不会掉帧；也不用 JS 逐帧改样式。
 *
 * `dissolve`（溶解）用**点阵遮罩的半径随 progress 长大**来近似：
 * 半径 0 时整层不可见，半径涨到超过格子边长时点阵彼此重叠、覆盖率接近 100%。
 * 参考的溶解是颗粒化的，浏览器里没有等价的滤镜，这是最接近的一种；
 * 差异明确记在 data-xfade-map 上（exact / approx），闸门按这个属性断言，
 * 免得以后有人把它当成"已经和参考一模一样"。
 */
function xfadeStyle(key, progress) {
  const p = Math.min(1, Math.max(0, Number(progress) || 0))
  switch (key) {
    case 'dissolve': {
      const mask = 'radial-gradient(circle, #000 calc(var(--dp) * 1px), transparent 0)'
      return {
        WebkitMaskImage: mask,
        maskImage: mask,
        WebkitMaskSize: '3px 3px',
        maskSize: '3px 3px',
        '--dp': (p * 2.35).toFixed(3)
      }
    }
    /* 从右往左推开：露出区域从左边界往右长，视觉上等于"后一段从右边压过来" */
    case 'wipeleft':
      return { clipPath: `inset(0 0 0 ${((1 - p) * 100).toFixed(2)}%)` }
    /* 后一段整体从右侧滑入盖住前一段 */
    case 'slideleft':
      return { transform: `translateX(${((1 - p) * 100).toFixed(2)}%)` }
    /* 从下方滑上来，竖屏转场 */
    case 'slideup':
      return { transform: `translateY(${((1 - p) * 100).toFixed(2)}%)` }
    case 'circleopen':
      return { clipPath: `circle(${(p * 75).toFixed(2)}% at 50% 50%)` }
    case 'fade':
    default:
      return { opacity: p.toFixed(4) }
  }
}

/** CSS 能一比一表达的转场只有 fade；其余都是"最接近的一种"，如实标出来 */
const EXACT_XFADE = ['fade', 'wipeleft', 'slideleft', 'slideup', 'circleopen']

/**
 * 画中画自己的 <video>。
 *
 * ⚠️ 必须**独立一个元素**：主层正在播底下的画面，两层要同时出现（这才是画中画）。
 * 共用一个元素就只能二选一，那正是"加了画中画但预览里根本没有"的原因。
 *
 * 时间对齐与主层同源：对齐**源文件时间**（不是播放头秒数）、阈值 0.25s，
 * 所以片段被拖到别处或被剪过左端之后，取到的仍是该取的那一帧。
 */
function PipVideo({ url, sourceTime, playing, volume, gain = 100, speed = 1 }) {
  const ref = useRef(null)
  const align = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (!Number.isFinite(el.duration) || el.duration <= 0) return
    const want = Math.max(0, Math.min(Number(sourceTime) || 0, el.duration - 0.05))
    if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want
  }, [sourceTime])

  useEffect(() => {
    align()
  }, [align, url])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    /* 画中画自己的音量（属性面板的音量滑杆）也要进预览，口径与主画面一致 */
    el.volume = Math.max(0, Math.min(1, ((volume ?? 100) / 100) * (Number(gain) / 100)))
    const rate = Math.min(16, Math.max(0.0625, Number(speed) || 1))
    if (typeof el.playbackRate === 'number') el.playbackRate = rate
    if (playing) el.play().catch(() => {})
    else el.pause()
  }, [gain, playing, speed, url, volume])

  return (
    <video
      ref={ref}
      src={url}
      playsInline
      preload="auto"
      onLoadedMetadata={align}
      data-pip-video="1"
    />
  )
}

export default function Stage({
  /* 整条时间线在这一帧的合成结果（由 App 用 composite.js 算好）。
     ⚠️ layers 是**热点窗口内的全部层**（含"提前挂载但当前不显示"的那些），
        所以切换片段只是换显示哪一层，不换 <video> 的 src ⇒ 接缝不黑帧。 */
  layers = [],
  /* 顶层可见层（主层）：负责发声、负责 data-source-time、负责角标。
     没有就是 null（时间线空白且没有兜底片段）。 */
  main = null,
  /* 当前播放头位置的字幕/文字叠加层（由 App 从字幕轨算好传进来）。
     ⚠️ 它**不是**画面层 —— 画面层决定底下播什么、overlays 决定画面上写什么，
     两者必须能同时存在。以前字幕片段只有在"底下没有画面片段"时才被当成 asset 显示，
     于是"给视频加字幕"在预览里根本看不见（只有一张占位卡片，不是字幕）。
     这是「添加后要有效果」这件事最核心的一条。 */
  overlays = [],
  /* 预览底图（参考「素材 → 背景」选的那张）。铺在 .canvas-frame 上，
     素材本身按自己的比例居中盖在上面 —— 素材比画布小的时候四周就是这张图。 */
  backdrop = null,
  /* 画面特效 key（记录在片段上，跟主层走） */
  frameFx = 'none',
  /* 音频轨上此刻在播的**全部**片段（BGM/配音）。与画面**同时**发声，
     见 AudioTrackLayer 的说明 —— 少了它，"加了配乐预览听不到"。 */
  audio = [],
  /* 叠加轨（画中画）此刻在场的**全部**片段。与画面**并列**，
     底下照常播主画面，它压在上面（DOM 顺序 = 层叠顺序）。 */
  pip = [],
  playing,
  playhead,
  totalDuration,
  volume,
  onTogglePlay,
  onSeek,
  onSkip,
  onFrame,
  playerRef,
  fullscreen,
  onToggleFullscreen,
  /* 画面比例（画布形状）。真源在 shared/aspect.js。
     ⚠️ 它与导出共用同一份表与同一个"裁切"口径：预览这里切到 1:1，
        成片也必须是 1:1 —— 否则"预览与成片对不上"，两边单独看都没错。 */
  aspect,
  onAspect
}) {
  const rafRef = useRef(0)
  /** 比例 chip 的展开态。点外面或 Esc 收起 —— 展开着不关会盖住画布下沿 */
  const [aspectOpen, setAspectOpen] = useState(false)
  const aspectWrapRef = useRef(null)

  useEffect(() => {
    if (!aspectOpen) return undefined
    const onDown = (event) => {
      if (aspectWrapRef.current && !aspectWrapRef.current.contains(event.target)) setAspectOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setAspectOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [aspectOpen])

  // 播放头按真实时间推进；这是剪辑软件的基本手感，不能只做个静态三角
  useEffect(() => {
    if (!playing) return undefined
    let last = performance.now()
    const step = (now) => {
      const delta = (now - last) / 1000
      last = now
      onSeek((value) => {
        const next = value + delta
        return next >= totalDuration ? totalDuration : next
      })
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, totalDuration, onSeek])

  /**
   * 预览底图。
   *
   * ⚠️ 这里**只留底图**：调色（CSS filter）已经移到每个画面层自己身上（见 MediaLayer），
   *    因为转场交叠时前后两段各有各的调色，挂在画布上会让后一段莫名其妙套上前一段的滤镜
   *    —— 而成片里两段是各转各的。
   *
   * ⚠️ 没有底图时**必须返回 `undefined`**，不能返回空对象 —— 空对象会在 DOM 上留一个空的
   *    style 属性（E2E 里按 `style` 判"有没有底图"会误判）。
   */
  const previewStyle = backdrop
    ? {
        backgroundImage: `url(${backdrop})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center'
      }
    : undefined

  /**
   * 画布什么时候出现。
   *
   * 参考在没有素材时确实是一片纯 #14141C、连 16:9 黑框都不画，但这**只对"什么都没加"成立**：
   * 一旦选了背景、或加了一条字幕，就必须有画布可以承载它 ——
   * 否则会出现"操作成功了但屏幕上什么都没有"，这正是「添加后要有效果」要杜绝的那一类。
   */
  const showFrame = Boolean(
    layers.some((item) => item.visible) || backdrop || overlays.length || pip.length
  )

  const frameRoles = [frameEffectClass(frameFx)].filter(Boolean)
  const frameClass = ['canvas-frame', ...frameRoles].join(' ')

  /**
   * 画布宽高比。
   *
   * ⚠️ 用**内联 CSS 变量**而不是给每个比例写一条 CSS 类：
   * 七种比例 × 三种上下文（面板内 / 全屏 / 兜底铺满）= 二十一条规则，
   * 加一个比例就要改三处 —— 那种写法迟早有一处漏掉，表现为"切了比例画布不变"。
   * 变量一处赋值，下面所有 `calc()` 跟着变，加比例只改 shared/aspect.js 那张表。
   *
   * ⚠️ 同时挂成 `data-aspect`：闸门与 E2E 断言的是这个属性（读 DOM 属性比
   * 反解内联 style 里的变量稳），也是"切了之后真的换了"这件事唯一的可见证据。
   */
  const aspectKey = normalizeAspect(aspect)
  const aspectValue = aspectRatioOf(aspectKey)

  return (
    <section
      className="wb-player"
      ref={playerRef}
      data-fullscreen={fullscreen ? '1' : '0'}
      /* 源文件时间挂成属性：E2E 断言的就是这个数，不用去读 <video>.currentTime
         （那个值会被 seek/play 的异步时序影响，断言起来必然 flaky）。
         取的是**主层**的源时间 —— 转场期间画面上有两层，主层才是"播放头所在的那一段"。 */
      data-source-time={Number(main?.sourceTime || 0).toFixed(3)}
      /* 这一帧画面上同时有几层（含提前挂载但不可见的）：
         "连续播放不换 src"这件事在 DOM 上就体现为这个数 ≥ 2 */
      data-layer-count={layers.length}
    >
      <div className="wb-player-stage">
        {/* 没有素材时参考的播放器区是一片纯 #14141C，连 16:9 黑框都不画，
           所以这里不能常驻 .canvas-frame。但"有东西要画在画面上"时必须给画布（见 showFrame）。 */}
        {showFrame ? (
          <div
            className={frameClass}
            /* 主层的调色 key（真正的 filter 挂在主层那一层上，见 MediaLayer） */
            data-filter={main?.filter || 'none'}
            /* 底图状态挂成属性：E2E/闸门断言"选了背景之后画面上真的有底图"时，
               读这个比读内联 style 的 backgroundImage 稳（后者是拼出来的 URL，
               哈希化之后每次构建都不一样）。 */
            data-backdrop={backdrop ? '1' : '0'}
            data-frame-fx={frameFx}
            data-aspect={aspectKey}
            style={{ ...(previewStyle || null), '--canvas-ar': String(aspectValue) }}
          >
            {/* 逐通道增益的 SVG 定义（色温/色调/亮度/美白）。必须与引用了它的层
                同处一棵树 —— 定义缺失时整串 filter 会被判无效，连调色一起没了。 */}
            <GradeDefs layers={layers} />
            {/* 抠像的 SVG 定义（同一棵树、同一个道理） */}
            <KeyDefs layers={layers} />

            {/* 画面层：底 → 顶（顺序由 composite.js 排好）。
                ⚠️ key 必须是**片段 id** —— 同一个元素跟着同一个片段走，
                   跨片段时 React 复用各自的层，而不是把某一个的 src 换掉。 */}
            {layers.map((layer) => (
              <MediaLayer
                key={layer.id}
                layer={layer}
                playing={playing}
                volume={volume}
                audible={layer.role === 'main'}
                /* 正圆蒙版要按画框宽高比换算 y 半径（见 shared/effects.js 的 cssMaskFor） */
                aspectRatio={aspectValue}
              />
            ))}

            {/* 画面特效的覆盖层：闪光/故障/扫描线/漏光/暗角都画在这一层，
                不去动 .canvas-frame 的 filter（那上面挂着调色，CSS 动画会把它顶掉） */}
            {overlayEffectClass(frameFx) ? (
              <span
                className={`canvas-fx ${overlayEffectClass(frameFx)}`}
                data-fx={frameFx}
                style={{ animationDuration: frameEffectDuration(frameFx) }}
              />
            ) : null}

            {/* 画中画（叠加轨）压在主画面之上、字幕之下。可以有多条同时在场。
                ⚠️ 这一层必须声明 container-type（见 CSS）：盒子用的是 cqw 单位，
                   少了它画中画会按视口算尺寸，跑到屏幕角上去。 */}
            {pip.map((item) => {
              const pfx = readEffects(item.effects)
              const pKeyRef = pfx.key.on ? `url(#yjai-key-${item.id})` : ''
              const pFilter = [pKeyRef, strokeShadows(pfx), shadowFilter(pfx)].filter(Boolean).join(' ')
              const pClip = clipStyleFor(pfx, aspectValue)
              const pMix = blendCss(pfx)
              return (
                <span
                  key={item.id}
                  className="canvas-pip-layer"
                  data-pip="1"
                  data-pip-id={item.id}
                  data-pip-anchor={item.anchor}
                  data-pip-size={item.size}
                  data-fx-radius={pfx.radius > 0.01 ? String(pfx.radius) : ''}
                  data-fx-mask={pfx.mask.shape}
                  data-fx-key={pfx.key.on ? '1' : ''}
                  data-fx-key-map={pfx.key.on ? 'approx' : ''}
                  data-fx-blend={pMix}
                  data-fx-stroke={pfx.stroke.on ? String(pfx.stroke.width) : ''}
                  data-fx-shadow={pfx.shadow.on ? '1' : ''}
                >
                  <span
                    className="canvas-pip"
                    data-pip-box="1"
                    style={{
                      ...pipBoxCss(item.anchor, item.size),
                      ...(Number(item.opacity) < 99.5 ? { opacity: String(Number(item.opacity) / 100) } : null),
                      ...(pFilter ? { filter: pFilter } : null),
                      ...(pMix ? { mixBlendMode: pMix } : null)
                    }}
                  >
                    {/* 剪裁盒单独一层：filter 与 mask 挤同一个元素时，圆角会把描边切掉一圈
                        （CSS 合成顺序是 filter → clip → mask，见 clipStyleFor 的说明）。 */}
                    <span className="canvas-pip-clip" style={pClip || undefined}>
                      {item.kind === 'image' ? (
                        <img src={item.url} alt="" data-pip-img="1" />
                      ) : (
                        <PipVideo
                          url={item.url}
                          sourceTime={item.sourceTime}
                          playing={playing}
                          volume={volume}
                          gain={item.gain}
                          speed={item.speed}
                        />
                      )}
                    </span>
                  </span>
                </span>
              )
            })}

            {/* 字幕/文字叠加层：位置与样式全部由 textStyles.js 从参数表推导，
                单位是 cqw（画布宽度的百分比），所以窗口缩放与全屏都自动等比 */}
            {overlays.length ? (
              <div className="canvas-overlays" data-overlay-count={overlays.length}>
                {overlays.map((item) => {
                  /* 第三个参数是**这一条**字幕的片段覆写（字号/颜色/位置）——
                     与导出侧 main/subtitles.js 走同一个 applyTextOverrides，
                     所以"右侧调过的字幕"在预览与成片里长得一样。 */
                  const { def, box, inner } = textStyleCss(item.style, undefined, item)
                  return (
                    <div
                      key={item.id}
                      className={`canvas-overlay ${animClassOf(def)}`}
                      data-overlay={def.key}
                      style={box}
                    >
                      <span data-overlay-text={def.key} style={inner}>
                        {item.text}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}

            {main && !isNoopFilter(main.filter) ? (
              <span className="canvas-badge" title="当前片段的调色">
                {filterDef(main.filter).label}
                {Number(main.filterIntensity) < 1 ? ` ${Math.round(Number(main.filterIntensity) * 100)}%` : ''}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* 音频轨播放层：挂在画布**之外**（它只是发声，没有画面），
            但与画面共用同一套 playing / volume，所以永远同步 */}
        <AudioLayers tracks={audio} playing={playing} volume={volume} />
      </div>

      {/* 播放条：形制照参考客户端的播放器底条 —— 左 = 双值帧号时码（青色），
          **中 = 播放键**（grid 三区，真居中，不随两侧宽度偏），
          右 = 逐帧两键 + 比例 chip + 全屏。
          音量 / 静音在时间线工具栏（同一 volume 状态），字幕在右侧检查器 ——
          播放条上不再放重复入口。

          ⚠️ 「比例」不再是单独一行，而是右端的一个 chip（参考就是这样）：
             单独一行会把画布挤矮一截，而参考的播放器底条只有这一行。 */}
      <div className="wb-transport">
        <div className="wb-transport-left">
          <span className="wb-time" title={`播放头位置（${FRAME_RATE} 帧/秒）`}>
            <b>{timecodeFrames(playhead, FRAME_RATE)}</b>
          </span>
          <span className="wb-time">{timecodeFrames(totalDuration, FRAME_RATE)}</span>
        </div>

        <div className="wb-transport-btns">
          <button className="play" type="button" onClick={onTogglePlay} title={playing ? '暂停（空格）' : '播放（空格）'}>
            {playing ? <IconPause size={17} /> : <IconPlay size={17} />}
          </button>
        </div>

        <div className="wb-transport-right">
          <button type="button" onClick={() => onFrame(-1)} title="前一帧（←）">
            <IconSkipBack size={14} />
          </button>
          <button type="button" onClick={() => onFrame(1)} title="后一帧（→）">
            <IconSkipForward size={14} />
          </button>

          {/*
            画面比例 chip。

            ⚠️ 这一栏**以前不存在**（传输栏右侧只有一个写死的 `16:9` 文字 ——
               看着像"当前比例"，既点不动也改不了）。现在它是个真按钮：
               点开下面是七个比例，按钮由 shared/aspect.js 的 `ASPECTS` 直接铺出来，
               不在这里另写一份清单 —— 加一个比例只改那份表，两边不可能对不上。
            ⚠️ 每个比例按钮带 `data-aspect-btn`：E2E 靠它定位、也靠它读当前值。
          */}
          <div className="wb-chip-wrap" ref={aspectWrapRef}>
            <button
              type="button"
              className={`wb-chip ${aspectOpen ? 'on' : ''}`}
              data-aspect-chip="1"
              aria-haspopup="true"
              aria-expanded={aspectOpen}
              title={`画面比例：${aspectKey}（点击选择，画面按这个比例裁切）`}
              onClick={() => setAspectOpen((value) => !value)}
            >
              {aspectKey}
            </button>
            {aspectOpen ? (
              <div className="wb-chip-pop" role="group" aria-label="画面比例">
                {ASPECTS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`wb-aspect-btn ${item.key === aspectKey ? 'on' : ''}`}
                    data-aspect-btn={item.key}
                    aria-pressed={item.key === aspectKey}
                    title={item.key === aspectKey ? `当前画面比例 ${item.label}` : `切换到 ${item.label}`}
                    onClick={() => {
                      onAspect && onAspect(item.key)
                      setAspectOpen(false)
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className={fullscreen ? 'on' : ''}
            title={fullscreen ? '退出全屏（F11 / Esc）' : '全屏预览（F11）'}
            onClick={onToggleFullscreen}
          >
            <IconFullscreen size={15} />
          </button>
        </div>
      </div>
    </section>
  )
}
