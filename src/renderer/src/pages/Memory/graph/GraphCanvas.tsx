/**
 * GraphCanvas — React component for Obsidian-style knowledge graph.
 *
 * Связывает d3-force симуляцию, canvas-рендерер и обработку взаимодействий.
 *  - RAF loop для непрерывного рендеринга (60fps)
 *  - ResizeObserver для адаптивного размера canvas
 *  - DPR-aware rendering для Retina/HiDPI
 *  - Camera state в ref (не React state) — без ре-ренеров при zoom/pan
 *  - Imperative handle: zoomIn, zoomOut, fit, reheat
 */

import { useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react'
import type { IconName } from '../../../components/ui/AppIcon/AppIcon'
import {
  type PhysicsNode,
  type PhysicsLink,
  createSimulation,
  reheat,
  dragNode,
  releaseNode,
  stopSimulation,
  preservePositions,
  applyPreservedPositions,
} from './graphPhysics'
import {
  type Camera,
  render,
  fitCamera,
  zoomAt,
  clearLabelMetricsCache,
} from './graphRenderer'
import { createInteractions } from './graphInteractions'
import type { Simulation } from 'd3-force'

// ─── Types (mirror graphStore.ts) ────────────────────────────────────────────

export interface GraphNode {
  id: string
  type: string
  label: string
  weight: number
  pinned: boolean
  sourceKind: string | null
  sourceId: string | null
}

export interface GraphEdge {
  id: string
  fromNode: string
  toNode: string
  type: string
  weight: number
}

// ─── Shared constants ─────────────────────────────────────────────────────────

export const NODE_TYPE_META: Record<string, { label: string; color: string; icon: IconName }> = {
  decision: { label: 'Решение', color: '#3b82f6', icon: 'folder' },
  concept: { label: 'Концепция', color: '#10b981', icon: 'sparkles' },
  file: { label: 'Файл', color: '#f59e0b', icon: 'fileText' },
  symbol: { label: 'Символ', color: '#8b5cf6', icon: 'code' },
  conversation: { label: 'Диалог', color: '#ec4899', icon: 'messageSquare' },
  task: { label: 'Задача', color: '#ef4444', icon: 'check' },
}

export const EDGE_TYPE_LABELS: Record<string, string> = {
  affects: 'влияет на',
  mentions: 'упоминает',
  implemented_in: 'реализован в',
  depends_on: 'зависит от',
  supersedes: 'заменяет',
  references: 'ссылается',
  imports: 'импортирует',
  calls: 'вызывает',
  implements: 'реализует',
}

// Общий пустой набор — чтобы не аллоцировать Set на каждый кадр без focus.
const EMPTY_NEIGHBORS: Set<string> = new Set<string>()

// ─── Component ───────────────────────────────────────────────────────────────

export interface GraphCanvasHandle {
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  reheat: () => void
}

interface GraphCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedNodeId: string | null
  searchMatchIds: Set<string> | null
  onSelectNode: (id: string | null) => void
}

const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { nodes, edges, selectedNodeId, searchMatchIds, onSelectNode },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const simRef = useRef<Simulation<PhysicsNode, undefined> | null>(null)
  const physicsNodesRef = useRef<PhysicsNode[]>([])
  const physicsLinksRef = useRef<PhysicsLink[]>([])
  const cameraRef = useRef<Camera>({ scale: 1, tx: 0, ty: 0 })
  const hoverIdRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const searchRef = useRef<Set<string> | null>(null)
  const rafRef = useRef<number>(0)
  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 })
  const interactionsRef = useRef<{ destroy: () => void } | null>(null)
  // Adjacency (id → neighbor ids), пересобирается при смене данных.
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map())
  // Кэш соседей по focusId (валиден в пределах одних данных/рёбер).
  const neighborCacheRef = useRef<Map<string, Set<string>>>(new Map())
  // Планировщик кадров: рисуем по требованию, а не бесконечным RAF.
  const dirtyRef = useRef(false)
  const hasPinnedRef = useRef(false)

  // Keep refs in sync with props
  selectedIdRef.current = selectedNodeId
  searchRef.current = searchMatchIds

  // ── Build physics nodes/links from raw data ──
  const buildPhysics = useCallback((rawNodes: GraphNode[], rawEdges: GraphEdge[]) => {
    // Compute degree map
    const degreeMap: Record<string, number> = {}
    for (const e of rawEdges) {
      degreeMap[e.fromNode] = (degreeMap[e.fromNode] ?? 0) + 1
      degreeMap[e.toNode] = (degreeMap[e.toNode] ?? 0) + 1
    }

    // Preserve old positions
    const preserved = preservePositions(physicsNodesRef.current)

    const pNodes: PhysicsNode[] = rawNodes.map(n => {
      const meta = NODE_TYPE_META[n.type] ?? { color: '#6b7280' }
      const degree = degreeMap[n.id] ?? 0
      const radius = Math.min(22, 5 + n.weight * 1.8 + degree * 0.7)
      return {
        id: n.id,
        type: n.type,
        label: n.label,
        weight: n.weight,
        pinned: n.pinned,
        sourceKind: n.sourceKind,
        sourceId: n.sourceId,
        radius,
        color: meta.color,
        degree,
        x: undefined,
        y: undefined,
      }
    })

    // Apply preserved positions
    applyPreservedPositions(pNodes, preserved)

    // Initialize new nodes in a circle
    const { w, h } = sizeRef.current
    const cx = w / 2 || 400
    const cy = h / 2 || 300
    const radius = Math.min(w, h) * 0.35 || 200
    let angle = 0
    for (const n of pNodes) {
      if (n.x == null) {
        n.x = cx + Math.cos(angle) * radius
        n.y = cy + Math.sin(angle) * radius
        angle += (2 * Math.PI) / Math.max(1, pNodes.length)
      }
    }

    const nodeIds = new Set(pNodes.map(n => n.id))
    const pLinks: PhysicsLink[] = rawEdges
      .filter(e => nodeIds.has(e.fromNode) && nodeIds.has(e.toNode))
      .map(e => ({
        id: e.id,
        source: e.fromNode,
        target: e.toNode,
        type: e.type,
        weight: e.weight,
      }))

    physicsNodesRef.current = pNodes
    physicsLinksRef.current = pLinks

    // Adjacency map: строим один раз на смену данных, чтобы не сканировать
    // все рёбра каждый кадр при hover/selection.
    const adjacency = new Map<string, Set<string>>()
    for (const l of pLinks) {
      const s = l.source as string
      const t = l.target as string
      let a = adjacency.get(s)
      if (!a) {
        a = new Set<string>()
        adjacency.set(s, a)
      }
      a.add(t)
      let b = adjacency.get(t)
      if (!b) {
        b = new Set<string>()
        adjacency.set(t, b)
      }
      b.add(s)
    }
    adjacencyRef.current = adjacency
    neighborCacheRef.current = new Map()
    hasPinnedRef.current = pNodes.some(n => n.pinned)
  }, [])

  // ── Compute neighbor IDs for hover/selected ──
  const computeNeighbors = useCallback((focusId: string | null): Set<string> => {
    if (!focusId) return EMPTY_NEIGHBORS
    const cached = neighborCacheRef.current.get(focusId)
    if (cached) return cached
    const adj = adjacencyRef.current.get(focusId)
    const result = adj ? new Set(adj) : new Set<string>()
    neighborCacheRef.current.set(focusId, result)
    return result
  }, [])

  // ── Frame scheduler ──
  // Кадр рисуется по требованию. Непрерывный RAF крутится только пока:
  //  • симуляция жива (есть видимое движение),
  //  • есть pinned-узлы (их пульсация сохраняет ту же каденцию кадров и ту же
  //    time-функцию — performance.now() * 0.003),
  //  • или запрошен ещё один кадр (interaction/resize/selection/search/data).
  // d3 вручную не тормозим: он сам гасит alpha, а reheat()/drag снова запускают
  // его таймер; каждый tick будит кадр. При возврате в видимость/на вкладку
  // сцена перерисовывается, движение не меняется.
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { w, h, dpr } = sizeRef.current
    const focusId = hoverIdRef.current ?? selectedIdRef.current
    const neighborIds = computeNeighbors(focusId)

    render(ctx, {
      nodes: physicsNodesRef.current,
      links: physicsLinksRef.current,
      camera: cameraRef.current,
      hoverId: hoverIdRef.current,
      selectedId: selectedIdRef.current,
      neighborIds,
      searchMatchIds: searchRef.current,
      width: w,
      height: h,
      dpr,
      time: performance.now(),
    })
  }, [computeNeighbors])

  const scheduleFrame = useCallback(() => {
    if (rafRef.current !== 0) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      dirtyRef.current = false
      drawFrame()
      const sim = simRef.current
      const simActive = sim != null && sim.alpha() > sim.alphaMin()
      if (dirtyRef.current || simActive || hasPinnedRef.current) scheduleFrame()
    })
  }, [drawFrame])

  const requestFrame = useCallback(() => {
    dirtyRef.current = true
    scheduleFrame()
  }, [scheduleFrame])

  // ── Resize observer ──
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = rect.width
      const h = rect.height
      sizeRef.current = { w, h, dpr }
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      // canvas.width/height сбрасывает битмап — нужен немедленный репейнт,
      // в том числе когда RAF уже остановлен (idle).
      requestFrame()
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    return () => ro.disconnect()
  }, [requestFrame])

  // ── Setup interactions ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const interactions = createInteractions(
      canvas,
      () => ({
        camera: cameraRef.current,
        nodes: physicsNodesRef.current,
      }),
      {
        onSelectNode: (id) => onSelectNode(id),
        onHoverNode: (id) => {
          // Реагируем только на фактическую смену hover — иначе idle-loop
          // просыпался бы на каждый mousemove.
          if (hoverIdRef.current === id) return
          hoverIdRef.current = id
          requestFrame()
        },
        onCameraChange: (cam) => {
          cameraRef.current = cam
          requestFrame()
        },
        onDragNode: (node, x, y) => {
          if (simRef.current) dragNode(simRef.current, node, x, y)
          requestFrame()
        },
        onReleaseNode: (node) => {
          if (simRef.current) releaseNode(simRef.current, node)
          requestFrame()
        },
      },
    )
    interactionsRef.current = interactions
    return () => interactions.destroy()
  }, [onSelectNode, requestFrame])

  // ── Rebuild simulation when data changes ──
  useEffect(() => {
    if (nodes.length === 0) {
      physicsNodesRef.current = []
      physicsLinksRef.current = []
      adjacencyRef.current = new Map()
      neighborCacheRef.current = new Map()
      hasPinnedRef.current = false
      if (simRef.current) {
        stopSimulation(simRef.current)
        simRef.current = null
      }
      requestFrame()
      return
    }

    buildPhysics(nodes, edges)

    const { w, h } = sizeRef.current
    const sim = createSimulation(physicsNodesRef.current, physicsLinksRef.current, w || 800, h || 600)
    simRef.current = sim

    // Каждый tick симуляции будит кадр — движение остаётся тем же.
    sim.on('tick', () => requestFrame())
    requestFrame()

    // Fit camera after initial layout settles
    requestAnimationFrame(() => {
      const { w: cw, h: ch } = sizeRef.current
      cameraRef.current = fitCamera(physicsNodesRef.current, cw, ch)
      requestFrame()
    })

    return () => {
      stopSimulation(sim)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  // ── Запуск планировщика кадров + wake-события ──
  useEffect(() => {
    requestFrame()
    return () => {
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [requestFrame])

  // Wake при возврате окна/вкладки в видимость.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') requestFrame()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [requestFrame])

  // Wake при смене выделения/поиска (они приходят пропсами).
  useEffect(() => {
    requestFrame()
  }, [selectedNodeId, searchMatchIds, requestFrame])

  // Wake при загрузке/смене шрифтов: кэш метрик текста инвалидируется.
  useEffect(() => {
    const fonts: FontFaceSet | undefined = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts) return
    let cancelled = false
    const onFonts = () => {
      clearLabelMetricsCache()
      requestFrame()
    }
    fonts.ready.then(() => { if (!cancelled) onFonts() }).catch(() => { /* шрифты недоступны */ })
    fonts.addEventListener('loadingdone', onFonts)
    return () => {
      cancelled = true
      fonts.removeEventListener('loadingdone', onFonts)
    }
  }, [requestFrame])

  // ── Imperative handle ──
  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      const { w, h } = sizeRef.current
      cameraRef.current = zoomAt(cameraRef.current, w / 2, h / 2, 1.3)
      requestFrame()
    },
    zoomOut: () => {
      const { w, h } = sizeRef.current
      cameraRef.current = zoomAt(cameraRef.current, w / 2, h / 2, 1 / 1.3)
      requestFrame()
    },
    fit: () => {
      const { w, h } = sizeRef.current
      cameraRef.current = fitCamera(physicsNodesRef.current, w, h)
      requestFrame()
    },
    reheat: () => {
      if (simRef.current) reheat(simRef.current, 0.8)
      requestFrame()
    },
  }), [requestFrame])

  return (
    <div className="graph-canvas-container" ref={containerRef}>
      <canvas ref={canvasRef} className="graph-canvas" />
    </div>
  )
})

export default GraphCanvas
