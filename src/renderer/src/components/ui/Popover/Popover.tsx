import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import './Popover.css'

export interface PopoverProps {
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement>
  children: ReactNode
  className?: string
  side?: 'bottom' | 'top' | 'auto'
  align?: 'start' | 'center' | 'end'
  offsetX?: number
  offsetY?: number
  closeOnOverlay?: boolean
}

interface Pos { top: number; left: number; side: 'bottom' | 'top'; align: 'start' | 'center' | 'end' }

const POPOVER_MARGIN = 8

export default function Popover({
  open, onClose, anchorRef, children, className,
  side = 'bottom', align = 'start',
  offsetX = 0, offsetY = 0,
  closeOnOverlay = true,
}: PopoverProps) {
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  const compute = () => {
    const anchor = anchorRef.current
    if (!anchor) return
    const ar = anchor.getBoundingClientRect()
    const pw = popRef.current?.offsetWidth ?? 260
    const ph = popRef.current?.offsetHeight ?? 360
    const vw = window.innerWidth
    const vh = window.innerHeight

    let resolvedSide: 'bottom' | 'top'
    if (side === 'auto') {
      resolvedSide = ar.bottom + POPOVER_MARGIN + ph < vh ? 'bottom' : 'top'
    } else {
      resolvedSide = side
    }
    if (resolvedSide === 'bottom' && ar.bottom + POPOVER_MARGIN + ph > vh && ar.top - POPOVER_MARGIN - ph > 0) {
      resolvedSide = 'top'
    }

    let resolvedAlign: 'start' | 'center' | 'end' = align
    if (align === 'start' && ar.left + pw > vw - 8) resolvedAlign = 'end'
    if (align === 'end' && ar.right - pw < 8) resolvedAlign = 'start'
    if (align === 'center' && (ar.left + ar.width / 2 - pw / 2 < 8 || ar.left + ar.width / 2 + pw / 2 > vw - 8)) {
      resolvedAlign = ar.left + ar.width / 2 + pw / 2 > vw - 8 ? 'end' : 'start'
    }

    let left: number
    if (resolvedAlign === 'start') left = ar.left + offsetX
    else if (resolvedAlign === 'end') left = ar.right - pw - offsetX
    else left = ar.left + ar.width / 2 - pw / 2 + offsetX

    left = Math.max(8, Math.min(vw - pw - 8, left))

    const top = resolvedSide === 'bottom'
      ? ar.bottom + POPOVER_MARGIN + offsetY
      : ar.top - POPOVER_MARGIN - ph - offsetY

    setPos({ top: Math.max(8, top), left, side: resolvedSide, align: resolvedAlign })
  }

  useLayoutEffect(() => {
    if (open) compute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onReposition = () => compute()
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Не создаём невидимый полноэкранный слой. Несколько открытых меню
  // (например, popover + select) иначе складываются друг на друга и после
  // закрытия верхнего меню могут оставить под ним слой, перехватывающий все
  // клики. Outside-click закрывает только сам popover и не блокирует UI.
  useEffect(() => {
    if (!open || !closeOnOverlay) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    const id = window.setTimeout(() => document.addEventListener('pointerdown', onPointerDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, closeOnOverlay, onClose, anchorRef])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={popRef}
          className={`popover ${pos?.side ?? side} ${pos?.align ?? align} ${className || ''}`}
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
          initial={{ opacity: 0, scale: 0.92, y: pos?.side === 'top' ? 8 : -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: pos?.side === 'top' ? 8 : -8 }}
          transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
