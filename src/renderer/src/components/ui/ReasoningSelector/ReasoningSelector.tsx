import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getReasoningConfig } from '../../../../../shared/reasoningModels'
import { whileHoverSm, whileTapSm, whileHoverListItem, whileTapListItem, springHover } from '../../../utils/motionPresets'
import { chatColumnRight } from '../../../utils/popupAnchor'
import './ReasoningSelector.css'

interface ReasoningSelectorProps {
  modelId: string
  value: string
  onChange: (value: string) => void
}

const PANEL_WIDTH = 220

export default function ReasoningSelector({ modelId, value, onChange }: ReasoningSelectorProps) {
  const [open, setOpen] = useState(false)
  const [panelPos, setPanelPos] = useState({ bottom: 0, left: 0 })
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const config = getReasoningConfig(modelId)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      const panel = document.getElementById('rs-panel')
      if (!panel?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!config) return null

  if (config.paramType === 'always_on') {
    return (
      <span className="rs-badge" title={config.hint}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
            stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
        </svg>
        thinking
      </span>
    )
  }

  const effectiveValue = value || config.default
  const current = config.options.find(o => o.value === effectiveValue) ?? config.options[0]

  const openPanel = () => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const bottom = window.innerHeight - rect.top + 6
    let left = rect.left
    // не выезжаем за правый край колонки чата (а не окна — колонка
    // центрирована, справа от неё пустота)
    const colRight = chatColumnRight(btnRef.current)
    if (left + PANEL_WIDTH > colRight) {
      left = colRight - PANEL_WIDTH
    }
    if (left < 8) left = 8
    setPanelPos({ bottom, left })
    setTooltipPos(null)
    setOpen(v => !v)
  }

  return (
    <>
      <motion.button
        ref={btnRef}
        className={`rs-btn${open ? ' rs-btn--active' : ''}`}
        onClick={openPanel}
        onMouseEnter={() => {
          if (open || !btnRef.current) return
          const rect = btnRef.current.getBoundingClientRect()
          setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top })
        }}
        onMouseLeave={() => setTooltipPos(null)}
        title=""
        whileHover={whileHoverSm}
        whileTap={whileTapSm}
        transition={springHover}
      >
        <svg className="rs-btn-icon" width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
            stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
          <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
        </svg>
        <span className="rs-btn-val">{current.label}</span>
        <svg className="rs-btn-chevron" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </motion.button>

      {/* Тултип */}
      {tooltipPos && createPortal(
        <div className="rs-tooltip" style={{ left: tooltipPos.x, top: tooltipPos.y - 38 }}>
          {config.hint}
        </div>,
        document.body
      )}

      {/* Дропдаун — AnimatePresence даёт анимацию и открытия, и закрытия
          (раньше был обычный conditional render без exit-transition). */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              id="rs-panel"
              className="rs-panel"
              style={{ bottom: panelPos.bottom, left: panelPos.left, width: PANEL_WIDTH }}
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <div className="rs-panel-hint">{config.hint}</div>
              <div className="rs-panel-param">{config.apiParam}</div>
              <div className="rs-panel-options">
                {config.options.map(opt => (
                  <motion.button
                    key={opt.value}
                    className={`rs-option${opt.value === current.value ? ' rs-option--active' : ''}`}
                    onClick={() => { onChange(opt.value); setOpen(false) }}
                    whileHover={whileHoverListItem}
                    whileTap={whileTapListItem}
                    transition={springHover}
                  >
                    <span className="rs-option-val">{opt.label}</span>
                    {opt.value === current.value && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="#a78bfa" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
