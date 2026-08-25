import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { ApprovalMode } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import { chatColumnRight } from '../../../utils/popupAnchor'
import './ApprovalModeSelector.css'

const MODES: { value: ApprovalMode; label: string; icon: string; desc: string }[] = [
  { value: 'ask',  label: 'Спрашивать',    icon: 'alertCircle', desc: 'Подтверждать каждое действие' },
  { value: 'auto', label: 'Авто',          icon: 'zap',         desc: 'Авто для безопасных, спрашивать для опасных' },
  { value: 'full', label: 'Полный доступ', icon: 'shield',      desc: 'Выполнять всё без подтверждений' },
]

const DROPDOWN_H = 160 // примерная высота дропдауна

interface ApprovalModeSelectorProps {
  value: ApprovalMode
  onChange: (mode: ApprovalMode) => void
  compact?: boolean
}

export default function ApprovalModeSelector({ value, onChange, compact }: ApprovalModeSelectorProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = MODES.find(m => m.value === value) || MODES[0]

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const openUp = spaceBelow < DROPDOWN_H + 12
    const dropW = 240
    // кламп по правому краю колонки чата (а не окна) — не выезжаем
    // в пустоту справа от центрированной колонки
    const left = Math.max(8, Math.min(r.left, chatColumnRight(btnRef.current) - dropW))
    setPos({
      top: openUp ? r.top - 8 : r.bottom + 6,
      left,
      openUp,
    })
    setOpen(o => !o)
  }

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className={`approval-selector ${compact ? 'approval-selector--compact' : ''}`}>
      <motion.button
        ref={btnRef}
        className={`approval-btn approval-btn--${value}`}
        onClick={handleOpen}
        whileTap={{ scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={current.desc}
      >
        <AppIcon name={current.icon as 'zap'} size="xs" />
        {!compact && <span className="approval-btn-label">{current.label}</span>}
        <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
      </motion.button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              className="approval-dropdown"
              style={{
                position: 'fixed',
                left: pos.left,
                ...(pos.openUp
                  ? { bottom: window.innerHeight - pos.top, top: 'auto' }
                  : { top: pos.top }),
                zIndex: 9999,
              }}
              initial={{ opacity: 0, y: pos.openUp ? 6 : -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: pos.openUp ? 6 : -6 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              onMouseDown={e => e.stopPropagation()}
            >
              {MODES.map(mode => (
                <motion.button
                  key={mode.value}
                  className={`approval-option ${value === mode.value ? 'approval-option--active' : ''}`}
                  onClick={() => { onChange(mode.value); setOpen(false) }}
                  whileHover={{ x: 3 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                >
                  <div className={`approval-option-icon approval-option-icon--${mode.value}`}>
                    <AppIcon name={mode.icon as 'zap'} size="xs" />
                  </div>
                  <div className="approval-option-text">
                    <span className="approval-option-label">{mode.label}</span>
                    <span className="approval-option-desc">{mode.desc}</span>
                  </div>
                  {value === mode.value && <AppIcon name="check" size="xs" tone="accent" />}
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
