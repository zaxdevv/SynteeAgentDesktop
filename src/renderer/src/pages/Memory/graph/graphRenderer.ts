/**
 * graphRenderer — canvas 2D rendering for knowledge graph.
 *
 * Obsidian-style visual:
 *  - Glow-узлы (radial halo via shadowBlur)
 *  - Изогнутые рёбра (quadratic bezier с лёгким изгибом)
 *  - Адаптивные метки (появляются при достаточном zoom)
 *  - Hover-подсветка: соседи яркие, остальной граф затемнён
 *  - Pinned-узлы: золотое кольцо + пульсация
 *  - Search-подсветка: совпадения яркие, остальное затемнено
 *  - Плавный zoom к курсору
 */

import type { PhysicsNode, PhysicsLink } from './graphPhysics'

// ─── Camera ──────────────────────────────────────────────────────────────────

export interface Camera {
  scale: number
  tx: number
  ty: number
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.tx) / cam.scale, y: (sy - cam.ty) / cam.scale }
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.scale + cam.tx, y: wy * cam.scale + cam.ty }
}

export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const newScale = Math.max(0.05, Math.min(8, cam.scale * factor))
  const wx = (sx - cam.tx) / cam.scale
  const wy = (sy - cam.ty) / cam.scale
  return { scale: newScale, tx: sx - wx * newScale, ty: sy - wy * newScale }
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { scale: cam.scale, tx: cam.tx + dx, ty: cam.ty + dy }
}

export function fitCamera(nodes: PhysicsNode[], width: number, height: number, padding = 80): Camera {
  if (nodes.length === 0) return { scale: 1, tx: width / 2, ty: height / 2 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    const r = n.radius + 10
    minX = Math.min(minX, (n.x ?? 0) - r)
    minY = Math.min(minY, (n.y ?? 0) - r)
    maxX = Math.max(maxX, (n.x ?? 0) + r)
    maxY = Math.max(maxY, (n.y ?? 0) + r)
  }
  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)
  const scale = Math.min((width - padding * 2) / w, (height - padding * 2) / h, 2.5)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { scale, tx: width / 2 - cx * scale, ty: height / 2 - cy * scale }
}

// ─── Render State ────────────────────────────────────────────────────────────

export interface RenderState {
  nodes: PhysicsNode[]
  links: PhysicsLink[]
  camera: Camera
  hoverId: string | null
  selectedId: string | null
  neighborIds: Set<string>
  searchMatchIds: Set<string> | null
  width: number
  height: number
  dpr: number
  time: number  // performance.now() — for pulse animations
}

// ─── Color helpers ───────────────────────────────────────────────────────────

/**
 * hexToRgba вызывается десятки раз на кадр (рёбра/узлы/кольца). Парсинг hex
 * детерминирован и зависит только от строки цвета, поэтому кэшируем разбор
 * (r,g,b) в маленьком bounded-кэше. Сама строка rgba собирается как раньше —
 * цвет/альфа/порядок вывода не меняются.
 */
const HEX_RGB_CACHE_MAX = 64
const hexRgbCache = new Map<string, readonly [number, number, number]>()

function parseHexRgb(hex: string): readonly [number, number, number] {
  let rgb = hexRgbCache.get(hex)
  if (rgb === undefined) {
    rgb = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ]
    if (hexRgbCache.size >= HEX_RGB_CACHE_MAX) hexRgbCache.clear()
    hexRgbCache.set(hex, rgb)
  }
  return rgb
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHexRgb(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

// ─── Edge drawing ────────────────────────────────────────────────────────────

function drawEdge(
  ctx: CanvasRenderingContext2D,
  src: PhysicsNode,
  tgt: PhysicsNode,
  link: PhysicsLink,
  alpha: number,
  highlighted: boolean,
): void {
  const sx = src.x ?? 0
  const sy = src.y ?? 0
  const tx = tgt.x ?? 0
  const ty = tgt.y ?? 0

  // Self-loop
  if (src.id === tgt.id) {
    ctx.beginPath()
    ctx.arc(sx, sy - src.radius - 8, 12, 0, Math.PI * 2)
    ctx.strokeStyle = hexToRgba('#8b8ba0', alpha)
    ctx.lineWidth = Math.max(0.5, Math.min(2, link.weight * 0.5))
    ctx.stroke()
    return
  }

  // Quadratic bezier control point — slight perpendicular offset
  const dx = tx - sx
  const dy = ty - sy
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1) return

  // Curve offset: 15% of distance, perpendicular
  const offset = dist * 0.12
  const mx = (sx + tx) / 2
  const my = (sy + ty) / 2
  const px = -dy / dist * offset
  const py = dx / dist * offset
  const cx = mx + px
  const cy = my + py

  // Trim endpoints to node radii
  const angleSrc = Math.atan2(cy - sy, cx - sx)
  const angleTgt = Math.atan2(ty - cy, tx - cx)
  const trimSrc = src.radius + 2
  const trimTgt = tgt.radius + 4 // extra for arrow
  const x1 = sx + Math.cos(angleSrc) * trimSrc
  const y1 = sy + Math.sin(angleSrc) * trimSrc
  const x2 = tx - Math.cos(angleTgt) * trimTgt
  const y2 = ty - Math.sin(angleTgt) * trimTgt

  // Draw curve
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.quadraticCurveTo(cx, cy, x2, y2)

  if (highlighted) {
    // Gradient stroke for highlighted edges
    const grad = ctx.createLinearGradient(x1, y1, x2, y2)
    grad.addColorStop(0, hexToRgba(src.color, alpha))
    grad.addColorStop(1, hexToRgba(tgt.color, alpha))
    ctx.strokeStyle = grad
    ctx.lineWidth = Math.max(1.5, Math.min(3.5, link.weight * 0.8))
  } else {
    ctx.strokeStyle = hexToRgba('#8b8ba0', alpha)
    ctx.lineWidth = Math.max(0.4, Math.min(2, link.weight * 0.4))
  }

  ctx.stroke()

  // Arrow at target
  if (alpha > 0.1) {
    const arrowSize = highlighted ? 6 : 4
    const arrowAngle = Math.PI / 6
    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(
      x2 - Math.cos(angleTgt - arrowAngle) * arrowSize,
      y2 - Math.sin(angleTgt - arrowAngle) * arrowSize,
    )
    ctx.lineTo(
      x2 - Math.cos(angleTgt + arrowAngle) * arrowSize,
      y2 - Math.sin(angleTgt + arrowAngle) * arrowSize,
    )
    ctx.closePath()
    ctx.fillStyle = highlighted ? hexToRgba(tgt.color, alpha) : hexToRgba('#8b8ba0', alpha)
    ctx.fill()
  }
}

// ─── Node drawing ────────────────────────────────────────────────────────────

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: PhysicsNode,
  alpha: number,
  hovered: boolean,
  selected: boolean,
  time: number,
): void {
  const x = node.x ?? 0
  const y = node.y ?? 0
  const r = node.radius

  // Glow halo — radial gradient
  const glowR = r * (hovered ? 3.5 : 2.2)
  const pulseAmount = node.pinned ? 0.15 * Math.sin(time * 0.003) : 0
  const glowAlpha = (hovered ? 0.5 : 0.25) * alpha * (1 + pulseAmount)

  const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, glowR)
  grad.addColorStop(0, hexToRgba(node.color, glowAlpha))
  grad.addColorStop(0.5, hexToRgba(node.color, glowAlpha * 0.4))
  grad.addColorStop(1, hexToRgba(node.color, 0))
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(x, y, glowR, 0, Math.PI * 2)
  ctx.fill()

  // Main circle
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = node.color
  ctx.fill()

  // Inner highlight (3D effect)
  ctx.beginPath()
  ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.4, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba('#ffffff', 0.25 * alpha)
  ctx.fill()

  // Border
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.strokeStyle = hexToRgba('#ffffff', 0.3 * alpha)
  ctx.lineWidth = 1
  ctx.stroke()

  // Pinned: golden ring
  if (node.pinned) {
    const ringR = r + 4 + pulseAmount * 2
    ctx.beginPath()
    ctx.arc(x, y, ringR, 0, Math.PI * 2)
    ctx.strokeStyle = hexToRgba('#fbbf24', 0.8 * alpha)
    ctx.lineWidth = 2
    ctx.stroke()
  }

  // Selected: white ring
  if (selected) {
    ctx.beginPath()
    ctx.arc(x, y, r + 5, 0, Math.PI * 2)
    ctx.strokeStyle = hexToRgba('#ffffff', 0.7 * alpha)
    ctx.lineWidth = 2
    ctx.stroke()
  }

  // Hovered: outer glow ring
  if (hovered) {
    ctx.beginPath()
    ctx.arc(x, y, r + 8, 0, Math.PI * 2)
    ctx.strokeStyle = hexToRgba(node.color, 0.5 * alpha)
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  ctx.globalAlpha = 1
}

// ─── Label drawing ───────────────────────────────────────────────────────────

/**
 * measureText — самая дорогая часть drawLabel, а результат зависит только от
 * пары (font, text). Кэшируем ширину, ограничивая размер. При загрузке/смене
 * шрифтов кэш нужно сбросить — см. clearLabelMetricsCache().
 */
const LABEL_METRICS_CACHE_MAX = 2048
const labelMetricsCache = new Map<string, number>()

/** Сброс кэша метрик текста (вызывать при font-loading / смене шрифта). */
export function clearLabelMetricsCache(): void {
  labelMetricsCache.clear()
}

function measureLabelWidth(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = font + '\u0000' + text
  const cached = labelMetricsCache.get(key)
  if (cached !== undefined) return cached
  const width = ctx.measureText(text).width
  if (labelMetricsCache.size >= LABEL_METRICS_CACHE_MAX) labelMetricsCache.clear()
  labelMetricsCache.set(key, width)
  return width
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  node: PhysicsNode,
  sx: number,
  sy: number,
  emphasized: boolean,
): void {
  const label = node.label.length > 28 ? node.label.slice(0, 25) + '…' : node.label
  const fontSize = emphasized ? 13 : 11
  const font = `${emphasized ? 600 : 500} ${fontSize}px system-ui, -apple-system, sans-serif`
  ctx.font = font
  const tw = measureLabelWidth(ctx, font, label)
  const th = fontSize * 1.2
  const px = sx
  const py = sy + node.radius + 12

  // Background pill
  const padX = 6
  const padY = 3
  ctx.beginPath()
  ctx.roundRect(px - tw / 2 - padX, py - padY, tw + padX * 2, th + padY, 4)
  ctx.fillStyle = emphasized ? 'rgba(30, 30, 40, 0.92)' : 'rgba(20, 20, 28, 0.75)'
  ctx.fill()

  // Text
  ctx.fillStyle = emphasized ? '#f0f0f5' : '#b0b0c0'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, px, py + th / 2)
}

// ─── Main render ─────────────────────────────────────────────────────────────

export function render(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const {
    nodes, links, camera, hoverId, selectedId, neighborIds,
    searchMatchIds, width, height, dpr, time,
  } = state

  // Clear
  ctx.clearRect(0, 0, width * dpr, height * dpr)

  // ── World-space pass: edges + nodes ──
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.translate(camera.tx, camera.ty)
  ctx.scale(camera.scale, camera.scale)

  const focusId = hoverId ?? selectedId
  const hasFocus = focusId != null

  // Draw edges
  for (const link of links) {
    const src = typeof link.source === 'object' ? link.source : null
    const tgt = typeof link.target === 'object' ? link.target : null
    if (!src || !tgt) continue

    const isConn = hasFocus && (src.id === focusId || tgt.id === focusId)
    const isNeighbor = hasFocus && neighborIds.has(src.id) && neighborIds.has(tgt.id)

    let alpha: number
    if (!hasFocus) {
      alpha = 0.15 + Math.min(0.25, link.weight * 0.04)
    } else if (isConn) {
      alpha = 0.75
    } else if (isNeighbor) {
      alpha = 0.25
    } else {
      alpha = 0.03
    }

    if (searchMatchIds && !searchMatchIds.has(src.id) && !searchMatchIds.has(tgt.id)) {
      alpha *= 0.2
    }

    drawEdge(ctx, src, tgt, link, alpha, isConn)
  }

  // Draw nodes
  for (const node of nodes) {
    const isFocused = hasFocus && (node.id === focusId || neighborIds.has(node.id))
    const isHovered = node.id === hoverId
    const isSelected = node.id === selectedId

    let alpha = 1
    if (hasFocus && !isFocused) alpha = 0.1
    if (searchMatchIds && !searchMatchIds.has(node.id)) alpha *= 0.12

    drawNode(ctx, node, alpha, isHovered, isSelected, time)
  }

  ctx.restore()

  // ── Screen-space pass: labels ──
  ctx.save()
  ctx.scale(dpr, dpr)

  for (const node of nodes) {
    const isFocused = hasFocus && (node.id === focusId || neighborIds.has(node.id))
    const isHovered = node.id === hoverId
    const isSelected = node.id === selectedId

    const screenSize = node.radius * camera.scale
    const showLabel =
      isHovered ||
      isSelected ||
      screenSize > 16 ||
      (node.degree >= 5 && camera.scale > 0.6) ||
      (camera.scale > 1.5 && screenSize > 8)

    if (!showLabel) continue
    if (hasFocus && !isFocused && !isHovered) continue
    if (searchMatchIds && !searchMatchIds.has(node.id) && !isHovered && !isSelected) continue

    const sp = worldToScreen(camera, node.x ?? 0, node.y ?? 0)
    drawLabel(ctx, node, sp.x, sp.y, isHovered || isSelected)
  }

  ctx.restore()
}

// ─── Hit testing ─────────────────────────────────────────────────────────────

export function hitTest(nodes: PhysicsNode[], camera: Camera, sx: number, sy: number): PhysicsNode | null {
  const { x: wx, y: wy } = screenToWorld(camera, sx, sy)
  let closest: PhysicsNode | null = null
  let closestDist = Infinity
  for (const n of nodes) {
    const dx = (n.x ?? 0) - wx
    const dy = (n.y ?? 0) - wy
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist <= n.radius + 3 && dist < closestDist) {
      closest = n
      closestDist = dist
    }
  }
  return closest
}
