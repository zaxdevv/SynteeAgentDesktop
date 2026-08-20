/**
 * graphInteractions — input handling for canvas graph.
 *
 *  - Mouse hover → hit test → hover highlight
 *  - Mouse drag on node → drag node (reheat physics)
 *  - Mouse drag on empty → pan camera
 *  - Wheel → zoom to cursor (smooth)
 *  - Click → select node / deselect
 *  - Touch: single-finger drag, two-finger pinch zoom
 *  - Right-click → context menu callback
 */

import type { PhysicsNode } from './graphPhysics'
import type { Camera } from './graphRenderer'
import { hitTest, screenToWorld, zoomAt, panBy } from './graphRenderer'

export interface InteractionCallbacks {
  onSelectNode: (id: string | null) => void
  onHoverNode: (id: string | null) => void
  onCameraChange: (cam: Camera) => void
  onDragNode: (node: PhysicsNode, x: number, y: number) => void
  onReleaseNode: (node: PhysicsNode) => void
  onContextMenu?: (node: PhysicsNode | null, sx: number, sy: number) => void
}

export interface InteractionState {
  camera: Camera
  nodes: PhysicsNode[]
}

const CLICK_THRESHOLD = 4 // px — max movement to count as click
const ZOOM_SMOOTHNESS = 0.0015

export function createInteractions(
  canvas: HTMLCanvasElement,
  getState: () => InteractionState,
  callbacks: InteractionCallbacks,
): { destroy: () => void } {
  // ── Internal state ──
  let mode: 'idle' | 'pan' | 'drag' = 'idle'
  let dragNode: PhysicsNode | null = null
  let downX = 0
  let downY = 0
  let lastX = 0
  let lastY = 0
  let moved = false

  // Touch state
  let touchMode: 'idle' | 'pan' | 'drag' | 'pinch' = 'idle'
  let pinchDist = 0
  let pinchCenter = { x: 0, y: 0 }
  let touchDragNode: PhysicsNode | null = null

  // ── Helpers ──
  function getMousePos(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function getTouchPos(t: Touch): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect()
    return { x: t.clientX - rect.left, y: t.clientY - rect.top }
  }

  // ── Mouse events ──

  function onMouseDown(e: MouseEvent) {
    if (e.button === 2) return // right-click handled separately
    const pos = getMousePos(e)
    downX = pos.x
    downY = pos.y
    lastX = pos.x
    lastY = pos.y
    moved = false

    const { camera, nodes } = getState()
    const hit = hitTest(nodes, camera, pos.x, pos.y)
    if (hit) {
      mode = 'drag'
      dragNode = hit
      canvas.style.cursor = 'grabbing'
    } else {
      mode = 'pan'
      canvas.style.cursor = 'grabbing'
    }
  }

  function onMouseMove(e: MouseEvent) {
    const pos = getMousePos(e)
    const dx = pos.x - lastX
    const dy = pos.y - lastY

    if (Math.abs(pos.x - downX) > CLICK_THRESHOLD || Math.abs(pos.y - downY) > CLICK_THRESHOLD) {
      moved = true
    }

    if (mode === 'drag' && dragNode) {
      const { camera } = getState()
      const world = screenToWorld(camera, pos.x, pos.y)
      callbacks.onDragNode(dragNode, world.x, world.y)
      callbacks.onCameraChange(camera) // trigger re-render
    } else if (mode === 'pan') {
      const { camera } = getState()
      const newCam = panBy(camera, dx, dy)
      callbacks.onCameraChange(newCam)
    } else if (mode === 'idle') {
      // Hover detection
      const { camera, nodes } = getState()
      const hit = hitTest(nodes, camera, pos.x, pos.y)
      const hitId = hit?.id ?? null
      callbacks.onHoverNode(hitId)
      canvas.style.cursor = hit ? 'pointer' : 'default'
    }

    lastX = pos.x
    lastY = pos.y
  }

  function onMouseUp(e: MouseEvent) {
    if (e.button === 2) return

    if (mode === 'drag' && dragNode) {
      if (!moved) {
        // Click on node → select
        callbacks.onSelectNode(dragNode.id)
      } else {
        callbacks.onReleaseNode(dragNode)
      }
    } else if (mode === 'pan' && !moved) {
      // Click on empty → deselect
      callbacks.onSelectNode(null)
    }

    mode = 'idle'
    dragNode = null
    canvas.style.cursor = 'default'
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const pos = getMousePos(e)
    const { camera } = getState()
    // Smooth zoom: exponential mapping of deltaY
    const factor = Math.exp(-e.deltaY * ZOOM_SMOOTHNESS)
    const newCam = zoomAt(camera, pos.x, pos.y, factor)
    callbacks.onCameraChange(newCam)
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault()
    const pos = getMousePos(e)
    const { camera, nodes } = getState()
    const hit = hitTest(nodes, camera, pos.x, pos.y)
    callbacks.onContextMenu?.(hit, pos.x, pos.y)
  }

  function onMouseLeave() {
    if (mode === 'drag' && dragNode) {
      callbacks.onReleaseNode(dragNode)
    }
    mode = 'idle'
    dragNode = null
    callbacks.onHoverNode(null)
    canvas.style.cursor = 'default'
  }

  // ── Touch events ──

  function onTouchStart(e: TouchEvent) {
    e.preventDefault()
    if (e.touches.length === 1) {
      const pos = getTouchPos(e.touches[0])
      downX = pos.x
      downY = pos.y
      lastX = pos.x
      lastY = pos.y
      moved = false

      const { camera, nodes } = getState()
      const hit = hitTest(nodes, camera, pos.x, pos.y)
      if (hit) {
        touchMode = 'drag'
        touchDragNode = hit
      } else {
        touchMode = 'pan'
      }
    } else if (e.touches.length === 2) {
      const t1 = getTouchPos(e.touches[0])
      const t2 = getTouchPos(e.touches[1])
      pinchDist = Math.hypot(t2.x - t1.x, t2.y - t1.y)
      pinchCenter = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 }
      touchMode = 'pinch'
      touchDragNode = null
    }
  }

  function onTouchMove(e: TouchEvent) {
    e.preventDefault()
    if (touchMode === 'drag' && touchDragNode && e.touches.length === 1) {
      const pos = getTouchPos(e.touches[0])
      const { camera } = getState()
      const world = screenToWorld(camera, pos.x, pos.y)
      callbacks.onDragNode(touchDragNode, world.x, world.y)
      callbacks.onCameraChange(camera)
      moved = true
    } else if (touchMode === 'pan' && e.touches.length === 1) {
      const pos = getTouchPos(e.touches[0])
      const dx = pos.x - lastX
      const dy = pos.y - lastY
      const { camera } = getState()
      const newCam = panBy(camera, dx, dy)
      callbacks.onCameraChange(newCam)
      lastX = pos.x
      lastY = pos.y
      moved = true
    } else if (touchMode === 'pinch' && e.touches.length === 2) {
      const t1 = getTouchPos(e.touches[0])
      const t2 = getTouchPos(e.touches[1])
      const newDist = Math.hypot(t2.x - t1.x, t2.y - t1.y)
      const center = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 }
      if (pinchDist > 0) {
        const factor = newDist / pinchDist
        const { camera } = getState()
        const zoomed = zoomAt(camera, center.x, center.y, factor)
        // Also pan by center delta
        const dx = center.x - pinchCenter.x
        const dy = center.y - pinchCenter.y
        const panned = panBy(zoomed, dx, dy)
        callbacks.onCameraChange(panned)
      }
      pinchDist = newDist
      pinchCenter = center
    }
  }

  function onTouchEnd(_e: TouchEvent) {
    if (touchMode === 'drag' && touchDragNode) {
      if (!moved) {
        callbacks.onSelectNode(touchDragNode.id)
      } else {
        callbacks.onReleaseNode(touchDragNode)
      }
    } else if (touchMode === 'pan' && !moved) {
      callbacks.onSelectNode(null)
    }
    touchMode = 'idle'
    touchDragNode = null
    pinchDist = 0
  }

  // ── Attach listeners ──
  canvas.addEventListener('mousedown', onMouseDown)
  // mousemove on window to track outside canvas
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)
  canvas.addEventListener('mouseleave', onMouseLeave)

  canvas.addEventListener('touchstart', onTouchStart, { passive: false })
  canvas.addEventListener('touchmove', onTouchMove, { passive: false })
  canvas.addEventListener('touchend', onTouchEnd)

  // ── Destroy ──
  return {
    destroy() {
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
    },
  }
}
