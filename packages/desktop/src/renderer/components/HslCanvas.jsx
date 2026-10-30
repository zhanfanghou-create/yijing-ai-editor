import { useEffect, useMemo, useRef } from 'react'
import { LUT_SIZE, buildLutGpu, isNeutral, readBands } from '../../shared/hslBands.js'

/**
 * 分区 HSL 的预览层：把画面（video / img）画进 canvas，用 3D LUT 换色。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须另起一个 canvas（而不是在现有滤镜链里加一段）
 * ══════════════════════════════════════════════════════════════════
 * 现有调色走 SVG 滤镜（`feComponentTransfer` 的 256 项表 + `feColorMatrix`）。
 * 那套东西只能表达"逐通道一维映射"和"线性矩阵"，**算不出** `权重 = f(像素色相)`。
 * 分区 HSL 的核心恰恰是这条式子，所以它只能走查表（3D LUT）：
 *   · 这里：LUT 上传成 WebGL 的 3D 纹理，片元着色器一次三线性采样；
 *   · 导出：同一份 LUT 写成 `.cube`，ffmpeg `lut3d interp=trilinear`。
 * 两侧**共用 shared/hslBands.js 的同一个烘焙函数**，所以不存在"两边各写一份数学"。
 *
 * ⚠️ 这个 canvas **只在内联样式里替换画面本身**，外层的 `filter` 仍然挂在
 *    MediaLayer 的 span 上（调色/调节/特效都不动）。于是顺序是
 *    「HSL → 其它调色」，导出侧也必须把 lut3d 放在滤镜链最前面（见 main/render.js）。
 *    顺序反过来不会报错，只会让两者对不上。
 *
 * ⚠️ 中性参数时**不渲染这个组件**（调用处判断），所以没开 HSL 的用户
 *    完全不会有 WebGL 上下文、不会有每帧上传 —— 零性能代价、零回归面。
 */
const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform sampler3D uLut;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  fragColor = vec4(texture(uLut, c).rgb, 1.0);
}`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    return { shader: null, log }
  }
  return { shader, log: '' }
}

/** LUT 的 RGB 字节流 → RGBA（WebGL2 里 RGBA8 是各驱动兼容性最好的内部格式） */
function toRgba(rgb) {
  const count = rgb.length / 3
  const out = new Uint8Array(count * 4)
  for (let i = 0; i < count; i += 1) {
    out[i * 4] = rgb[i * 3]
    out[i * 4 + 1] = rgb[i * 3 + 1]
    out[i * 4 + 2] = rgb[i * 3 + 2]
    out[i * 4 + 3] = 255
  }
  return out
}

export default function HslCanvas({ sourceRef, kind = 'video', bands = null, style = null, onFail = null }) {
  const canvasRef = useRef(null)
  const glRef = useRef(null)
  const lutRef = useRef({ texture: null, size: 0 })

  /* 参数用 JSON 当依赖：bands 每次渲染都是新对象，直接进依赖表会每帧重烘一遍 LUT */
  const bandsKey = useMemo(() => JSON.stringify(readBands(bands)), [bands])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false
    })
    if (!gl) {
      /* 没有 WebGL2（极老的显卡驱动）时**必须明说**，不能静默留一块黑：
         用户会以为"这个片段坏了"。调用方据此退回原画面并提示。 */
      onFail?.('这台机器的显卡不支持 WebGL2，分区 HSL 无法预览')
      return undefined
    }

    const vert = compile(gl, gl.VERTEX_SHADER, VERT)
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vert.shader || !frag.shader) {
      onFail?.(`着色器编译失败：${vert.log || frag.log || '未知原因'}`)
      return undefined
    }
    const program = gl.createProgram()
    gl.attachShader(program, vert.shader)
    gl.attachShader(program, frag.shader)
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      onFail?.(`着色器链接失败：${gl.getProgramInfoLog(program) || '未知原因'}`)
      return undefined
    }
    gl.useProgram(program)
    glRef.current = gl

    /* 全屏两个三角（用 TRIANGLE_STRIP，顶点顺序左下 → 右下 → 左上 → 右上） */
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    const sourceTex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const lutTex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, lutTex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    /* CLAMP 而不是 REPEAT：3D 纹理的 s/t/r 三轴都不能环绕 —— 环绕会让纯红旁边的
       值取自纯蓝那一端，画面出现莫名的青色溢色。 */
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    lutRef.current = { texture: lutTex, size: 0 }

    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0)
    gl.uniform1i(gl.getUniformLocation(program, 'uLut'), 1)

    let raf = 0
    let lastStamp = NaN
    let failed = false

    const uploadSource = (source) => {
      const width = kind === 'image' ? source.naturalWidth : source.videoWidth
      const height = kind === 'image' ? source.naturalHeight : source.videoHeight
      if (!width || !height) return false
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
      }
      /* 视频源的像素行序是"上到下"，而纹理坐标 v 是"下到上"⇒ 必须翻一次。
         不翻的画面是上下颠倒的 —— 这种错在纯色测试图上完全看不出来。 */
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      } catch (error) {
        /* 跨域污染的视频不能上传（我们的 yjai-media 是自有协议，正常不会走到这里）。
           一旦发生就停下来并报出去，不要每帧 try/catch 刷日志。 */
        if (!failed) {
          failed = true
          onFail?.('这张画面不能送进显卡处理（跨域限制）')
        }
        return false
      }
      return true
    }

    const renderFrame = () => {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (failed) return
      const source = sourceRef?.current
      if (!source) return
      const ready = kind === 'image' ? source.complete && source.naturalWidth > 0 : source.readyState >= 2
      if (!ready) return
      /* 暂停时 currentTime 不变 ⇒ 不重复上传（1080p 每帧上传是实打实的带宽）。
         seek 之后 currentTime 变了，自然重画；图片则用一个恒定戳，只画一次。 */
      const stamp = kind === 'image' ? 1 : source.currentTime
      if (stamp === lastStamp) return
      lastStamp = stamp
      if (!uploadSource(source)) return
      renderFrame()
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      gl.deleteTexture(sourceTex)
      gl.deleteTexture(lutTex)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vert.shader)
      gl.deleteShader(frag.shader)
      glRef.current = null
      lutRef.current = { texture: null, size: 0 }
      /* 主动丢上下文：一个页面能同时存在的 WebGL 上下文有上限（通常 16 个），
         多片段来回切换时不释放会把整页的 WebGL 用光，表现为"后面所有片段都黑屏"。 */
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
    }
    // 只在挂载/卸载时建上下文；参数变化走下面那条 effect（重传 LUT，不重建上下文）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, sourceRef])

  useEffect(() => {
    const gl = glRef.current
    const texture = lutRef.current.texture
    if (!gl || !texture) return
    const data = toRgba(buildLutGpu(bands, LUT_SIZE))
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, LUT_SIZE, LUT_SIZE, LUT_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    lutRef.current.size = LUT_SIZE
    /* LUT 换了之后必须重画一帧：画面暂停时 tick 会因为 currentTime 没变而跳过，
       于是"拖了滑杆、画面不动"—— 直到用户播放才突然变色。 */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandsKey])

  /* 中性的画面不该被 GPU 重画一遍（等于多一层采样损失），调用处会直接不渲染本组件；
     这里再兜一次：真被渲染了也不报错，只是照原样输出。 */
  const active = !isNeutral(bands)

  return <canvas ref={canvasRef} className="canvas-hsl" data-hsl-canvas={active ? '1' : '0'} style={style || undefined} />
}
