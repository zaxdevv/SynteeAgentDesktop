import { useEffect, useRef, useState } from 'react'
import type { PluginBackgroundContribution } from '../../../../../shared/types/plugin'
import { pluginFileUrl } from '../../../utils/pluginExtApi'

/** z-index-слой позади UI (как canvas AnimatedBackground). */
const LAYER_CLASS = 'animated-bg plugin-bg-media'

/**
 * Фон от плагина (registerBackground). kind:
 *  - 'image'/'video' — <img>/<video> с URL syntee-plugin://{pluginId}/{src};
 *  - 'shader'       — fetch GLSL-кода и рендер в WebGL2 fullscreen-треугольник
 *                     (u_time / u_resolution / u_mouse / u_opacity uniforms).
 */
export default function PluginBackgroundLayer({ bg }: { bg: PluginBackgroundContribution }) {
  if (bg.kind === 'shader') return <PluginShaderLayer src={pluginFileUrl(bg.pluginId, bg.src)} />
  if (bg.kind === 'video') {
    return (
      <video
        className={LAYER_CLASS}
        src={pluginFileUrl(bg.pluginId, bg.src)}
        autoPlay
        muted
        loop
        playsInline
        style={{ objectFit: 'cover', width: '100%', height: '100%' }}
      />
    )
  }
  // image
  return (
    <img
      className={LAYER_CLASS}
      src={pluginFileUrl(bg.pluginId, bg.src)}
      alt=""
      draggable={false}
      style={{ objectFit: 'cover', width: '100%', height: '100%' }}
    />
  )
}

const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`

function PluginShaderLayer({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let raf = 0
    const canvas = canvasRef.current
    if (!canvas) return
    let gl: WebGL2RenderingContext | null = null
    let program: WebGLProgram | null = null
    let timeLoc: WebGLUniformLocation | null = null
    let resLoc: WebGLUniformLocation | null = null
    let mouseLoc: WebGLUniformLocation | null = null
    let opacityLoc: WebGLUniformLocation | null = null
    const mouse = { x: 0.5, y: 0.5 }

    const start = async () => {
      try {
        const res = await fetch(src)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        let frag = await res.text()
        if (!frag.includes('#version')) {
          frag = '#version 300 es\nprecision highp float;\n' + frag
        }
        if (cancelled) return
        gl = canvas.getContext('webgl2')
        if (!gl) { setError('WebGL2 недоступен'); return }
        const compile = (type: number, code: string) => {
          const sh = gl!.createShader(type)!
          gl!.shaderSource(sh, code)
          gl!.compileShader(sh)
          if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
            const log = gl!.getShaderInfoLog(sh) || 'shader compile error'
            gl!.deleteShader(sh)
            throw new Error(log)
          }
          return sh
        }
        const vs = compile(gl.VERTEX_SHADER, VERT)
        const fs = compile(gl.FRAGMENT_SHADER, frag)
        program = gl.createProgram()!
        gl.attachShader(program, vs)
        gl.attachShader(program, fs)
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(program) || 'link error')
        }
        gl.useProgram(program)

        // Fullscreen triangle.
        const buf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
        const aPos = gl.getAttribLocation(program, 'aPos')
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

        timeLoc = gl.getUniformLocation(program, 'u_time')
        resLoc = gl.getUniformLocation(program, 'u_resolution')
        mouseLoc = gl.getUniformLocation(program, 'u_mouse')
        opacityLoc = gl.getUniformLocation(program, 'u_opacity')

        const onMouse = (e: MouseEvent) => {
          mouse.x = e.clientX / Math.max(1, window.innerWidth)
          mouse.y = 1 - e.clientY / Math.max(1, window.innerHeight)
        }
        window.addEventListener('mousemove', onMouse, { passive: true })
        const t0 = performance.now()
        const render = (now: number) => {
          if (!gl || !program) return
          gl.clearColor(0, 0, 0, 1)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.useProgram(program)
          if (timeLoc) gl.uniform1f(timeLoc, (now - t0) / 1000)
          if (resLoc) gl.uniform2f(resLoc, canvas.width, canvas.height)
          if (mouseLoc) gl.uniform2f(mouseLoc, mouse.x, mouse.y)
          if (opacityLoc) gl.uniform1f(opacityLoc, 1)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          raf = requestAnimationFrame(render)
        }
        raf = requestAnimationFrame(render)
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e))
      }
    }
    void start()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (gl && program) {
        gl.deleteProgram(program)
      }
    }
  }, [src])

  if (error) {
    // Плагинный шейдер не загрузился — тихо без фона (мягкая деградация).
    return <div className="plugin-bg-layer plugin-bg-layer--error" title={error} />
  }
  return <canvas ref={canvasRef} className="animated-bg plugin-bg-media" style={{ width: '100%', height: '100%' }} />
}
