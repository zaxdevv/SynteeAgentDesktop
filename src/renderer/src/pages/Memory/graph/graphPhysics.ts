/**
 * graphPhysics — d3-force simulation wrapper.
 *
 * Создаёт force-directed симуляцию для knowledge graph:
 *  - forceManyBody: отталкивание узлов друг от друга
 *  - forceLink: пружины между связанными узлами
 *  - forceCollide: предотвращение наложения
 *  - forceX/forceY: мягкое притяжение к центру
 *  - forceCenter: центрирование
 *
 * Simulation работает в RAF loop (вызывается из GraphCanvas).
 * После alphaDecay симуляция останавливается автоматически.
 */

import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PhysicsNode extends SimulationNodeDatum {
  id: string
  type: string
  label: string
  weight: number
  pinned: boolean
  sourceKind: string | null
  sourceId: string | null
  // visual (pre-computed by renderer)
  radius: number
  color: string
  // degree (pre-computed)
  degree: number
}

export interface PhysicsLink {
  id: string
  source: string | PhysicsNode
  target: string | PhysicsNode
  type: string
  weight: number
}

export interface PhysicsOptions {
  chargeStrength?: number
  linkDistance?: number
  linkStrength?: number
  collidePadding?: number
  centerStrength?: number
}

// ─── Create Simulation ───────────────────────────────────────────────────────

export function createSimulation(
  nodes: PhysicsNode[],
  links: PhysicsLink[],
  width: number,
  height: number,
  opts: PhysicsOptions = {},
): Simulation<PhysicsNode, undefined> {
  const {
    chargeStrength = -80,
    linkDistance = 50,
    linkStrength = 0.15,
    collidePadding = 3,
    centerStrength = 0.03,
  } = opts

  const cx = width / 2
  const cy = height / 2

  const sim = forceSimulation<PhysicsNode>(nodes)
    .force('charge', forceManyBody<PhysicsNode>().strength(d => chargeStrength * (1 / (d.radius / 8))))
    .force(
      'link',
      forceLink<PhysicsNode, PhysicsLink>(links)
        .id(d => d.id)
        .distance(l => linkDistance + (l as PhysicsLink).weight * 8)
        .strength(l => linkStrength * Math.min(1, (l as PhysicsLink).weight * 0.3)),
    )
    .force('collide', forceCollide<PhysicsNode>().radius(d => d.radius + collidePadding).strength(0.7))
    .force('x', forceX(cx).strength(centerStrength))
    .force('y', forceY(cy).strength(centerStrength))
    .alpha(1)
    .alphaDecay(0.025)
    .alphaMin(0.005)
    .velocityDecay(0.3)

  // Run initial ticks for faster convergence (saves ~2s of visible jitter)
  for (let i = 0; i < 50; i++) sim.tick()

  return sim
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function reheat(sim: Simulation<PhysicsNode, undefined>, alpha = 0.3): void {
  sim.alpha(alpha).restart()
}

export function dragNode(sim: Simulation<PhysicsNode, undefined>, node: PhysicsNode, x: number, y: number): void {
  node.fx = x
  node.fy = y
  reheat(sim, 0.5)
}

export function releaseNode(sim: Simulation<PhysicsNode, undefined>, node: PhysicsNode): void {
  node.fx = null
  node.fy = null
  reheat(sim, 0.2)
}

export function stopSimulation(sim: Simulation<PhysicsNode, undefined>): void {
  sim.stop()
  sim.on('tick', null as unknown as () => void)
}

/**
 * Preserve positions of existing nodes when data changes.
 * Returns a map of id → {x, y, vx, vy} for nodes that had positions.
 */
export function preservePositions(oldNodes: PhysicsNode[]): Map<string, { x: number; y: number; vx: number; vy: number }> {
  const map = new Map<string, { x: number; y: number; vx: number; vy: number }>()
  for (const n of oldNodes) {
    if (n.x != null && n.y != null) {
      map.set(n.id, { x: n.x, y: n.y, vx: n.vx ?? 0, vy: n.vy ?? 0 })
    }
  }
  return map
}

export function applyPreservedPositions(nodes: PhysicsNode[], preserved: Map<string, { x: number; y: number; vx: number; vy: number }>): void {
  for (const n of nodes) {
    const p = preserved.get(n.id)
    if (p) {
      n.x = p.x
      n.y = p.y
      n.vx = p.vx
      n.vy = p.vy
    }
  }
}
