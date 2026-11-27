/**
 * ProjectMapCanvas — canvas-рендер графа кода на d3-force.
 * Переиспользует физику из Memory graph (createSimulation). Pan/zoom, drag
 * узлов, клик — выбор, двойной клик — открыть файл. Пунктир = неточное ребро.
 */
import { useEffect, useRef, useCallback } from 'react'
import type { Simulation } from 'd3-force'
import {
  createSimulation, dragNode, releaseNode, stopSimulation,
  type PhysicsNode, type PhysicsLink,
} from '../../../pages/Memory/graph/graphPhysics'
import type { CodeEdgePrecision } from '../../../../../shared/projectMap'

export const KIND_COLORS: Record<string, string> = {
  file: '#6366f1',
  package: '#64748b',
  function: '#22c55e',
  class: '#f59e0b',
  method: '#84cc16',
  variable: '#06b6d4',
  field: '#14b8a6',
  interface: '#a855f7',
  enum: '#ec4899',
  struct: '#f97316',
  type: '#8b5cf6',
  module: '#0ea5e9',
  impl: '#f97316',
  constructor: '#eab308',
  macro: '#d946ef',
  definition: '#94a3b8',
  /** Секция markdown/ADR — «где это описано». */
  section: '#0891b2',
}

interface Props {
  nodes: PhysicsNode[]
  links: PhysicsLink[]
  precision: Map<string, CodeEdgePrecision>
  selectedId: string | null
  highlightIds: Set<string>
  onSelect: (id: string | null) => void
  onOpen: (id: string) => void
}

interface Camera { x: number; y: number; k: number }

export default function ProjectMapCanvas({ nodes, links, precision, selectedId, highlightIds, onSelect, onOpen }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const simRef = useRef<Simulation<PhysicsNode, undefined> | null>(null)
  const camRef = useRef<Camera>({ x: 0, y: 0, k: 1 })
  const rafRef = useRef<number>(0)
  const dragRef = useRef<{ node: PhysicsNode | null; moved: boolean; startX: number; startY: number }>({ node: null, moved: false, startX: 0, startY: 0 })
  const panRef = useRef<{ active: boolean; startX: number; startY: number; camX: number; camY: number }>({ active: false, startX: 0, startY: 0, camX: 0, camY: 0 })
  const nodesRef = useRef(nodes)
  const linksRef = useRef(links)
  const selRef = useRef(selectedId)
  const hlRef = useRef(highlightIds)
  const precRef = useRef(precision)
  nodesRef.current = nodes
  linksRef.current = links
  selRef.current = selectedId
  hlRef.current = highlightIds
  precRef.current = precision

  const toWorld = useCallback((sx: number, sy: number) => {
    const cam = camRef.current
    return { x: (sx - cam.x) / cam.k, y: (sy - cam.y) / cam.k }
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    const pixelWidth = Math.round(w * dpr)
    const pixelHeight = Math.round(h * dpr)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cam = camRef.current
    ctx.translate(cam.x, cam.y)
    ctx.scale(cam.k, cam.k)

    const ns = nodesRef.current
    const ls = linksRef.current
    const sel = selRef.current
    const hl = hlRef.current

    // Edges
    for (const l of ls) {
      const s = l.source as PhysicsNode
      const t = l.target as PhysicsNode
      if (s.x == null || t.x == null) continue
      const prec = precRef.current.get(l.id) ?? 'resolved'
      ctx.beginPath()
      ctx.moveTo(s.x, s.y!)
      ctx.lineTo(t.x, t.y!)
      ctx.strokeStyle = prec === 'external' ? 'rgba(100,116,139,0.25)' : 'rgba(148,163,184,0.35)'
      ctx.lineWidth = 1 / cam.k
      ctx.setLineDash(prec === 'heuristic' ? [4 / cam.k, 3 / cam.k] : prec === 'ambiguous' ? [2 / cam.k, 3 / cam.k] : [])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Nodes
    for (const n of ns) {
      if (n.x == null) continue
      const isSel = n.id === sel
      const isHl = hl.has(n.id)
      const r = n.radius
      ctx.beginPath()
      ctx.arc(n.x, n.y!, r, 0, Math.PI * 2)
      ctx.fillStyle = n.color
      ctx.globalAlpha = hl.size > 0 && !isHl && !isSel ? 0.25 : 1
      ctx.fill()
      if (isSel) {
        ctx.lineWidth = 2.5 / cam.k
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()
      } else if (isHl) {
        ctx.lineWidth = 2 / cam.k
        ctx.strokeStyle = '#fbbf24'
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      // Label (only when zoomed in enough or selected/highlighted)
      if (cam.k > 0.6 || isSel || isHl) {
        ctx.font = `${11 / cam.k}px system-ui, sans-serif`
        ctx.fillStyle = 'rgba(226,232,240,0.9)'
        ctx.textAlign = 'center'
        ctx.fillText(n.label, n.x, n.y! + r + 12 / cam.k)
      }
    }
  }, [])

  const requestDraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }, [draw])

  // Simulation lifecycle
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const w = wrap.clientWidth || 800
    const h = wrap.clientHeight || 600
    if (simRef.current) stopSimulation(simRef.current)
    const sim = createSimulation(nodes, links, w, h, {
      chargeStrength: -120,
      linkDistance: 70,
      linkStrength: 0.12,
      collidePadding: 6,
      centerStrength: 0.04,
      // Large maps can take seconds to run 50 synchronous warmup ticks.
      initialTicks: nodes.length <= 200 ? 12 : 0,
    })
    simRef.current = sim
    camRef.current = { x: w * 0.05, y: h * 0.05, k: 0.9 }
    // d3 drives its own ticks and cools on its own. A settled graph only
    // repaints in response to interaction, highlighting or a resize.
    sim.on('tick.project-map', requestDraw)
    const observer = new ResizeObserver(requestDraw)
    observer.observe(wrap)
    requestDraw()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      sim.on('tick.project-map', null)
      stopSimulation(sim)
      simRef.current = null
    }
  }, [nodes, links, requestDraw])

  useEffect(() => { requestDraw() }, [selectedId, highlightIds, precision, requestDraw])

  const hitTest = useCallback((sx: number, sy: number): PhysicsNode | null => {
    const { x, y } = toWorld(sx, sy)
    const ns = nodesRef.current
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]
      if (n.x == null) continue
      const dx = x - n.x
      const dy = y - n.y!
      if (dx * dx + dy * dy <= (n.radius + 3) * (n.radius + 3)) return n
    }
    return null
  }, [toWorld])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const node = hitTest(sx, sy)
    if (node) {
      dragRef.current = { node, moved: false, startX: sx, startY: sy }
    } else {
      const cam = camRef.current
      panRef.current = { active: true, startX: sx, startY: sy, camX: cam.x, camY: cam.y }
    }
  }, [hitTest])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const drag = dragRef.current
    if (drag.node) {
      if (Math.abs(sx - drag.startX) + Math.abs(sy - drag.startY) > 3) drag.moved = true
      const { x, y } = toWorld(sx, sy)
      if (simRef.current) dragNode(simRef.current, drag.node, x, y)
      return
    }
    const pan = panRef.current
    if (pan.active) {
      camRef.current.x = pan.camX + (sx - pan.startX)
      camRef.current.y = pan.camY + (sy - pan.startY)
      requestDraw()
    }
  }, [toWorld, requestDraw])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current
    if (drag.node) {
      if (!drag.moved) onSelect(drag.node.id)
      if (simRef.current) releaseNode(simRef.current, drag.node)
      dragRef.current = { node: null, moved: false, startX: 0, startY: 0 }
    }
    panRef.current.active = false
    void e
  }, [onSelect])

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const node = hitTest(e.clientX - rect.left, e.clientY - rect.top)
    if (node) onOpen(node.id)
  }, [hitTest, onOpen])

  const onWheel = useCallback((e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const cam = camRef.current
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    const k = Math.max(0.15, Math.min(4, cam.k * factor))
    // Zoom toward cursor.
    cam.x = sx - (sx - cam.x) * (k / cam.k)
    cam.y = sy - (sy - cam.y) * (k / cam.k)
    cam.k = k
    requestDraw()
  }, [requestDraw])

  return (
    <div ref={wrapRef} className="pmap-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="pmap-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
    </div>
  )
}
