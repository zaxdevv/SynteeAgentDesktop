import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import './Select.css'

export interface SelectOption {
  value: string
  label: string
  /** Серая подсказка справа от label в дропдауне */
  hint?: string
  /** Стиль превью пункта — например fontFamily при выборе шрифтов */
  previewStyle?: React.CSSProperties
}

export interface SelectProps {
  value: string
  onChange: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  /** Фиксированная ширина триггера */
  width?: number | string
  /** Минимальная ширина триггера и дропдауна */
  minWidth?: number
  className?: string
  'aria-label'?: string
}

/**
 * Кастомный select вместо нативного <select> — нативный на Windows
 * рисует системный белый дропдаун, чужеродный для тёмных тем.
 * Портальное меню с якорем под триггером, клавиатурная навигация
 * (↑↓ / Enter / Escape), check у выбранного пункта, превью-стили
 * (шрифты рендерятся самим шрифтом).
 */
export default function Select({
  value, onChange, options, placeholder = 'Выбрать...', disabled,
  width, minWidth = 180, className, ...rest
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = options.find(o => o.value === value)

  // Позиция меню: под триггером (или над ним, если внизу экрана)
  const compute = () => {
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const listH = Math.min(300, options.length * 34 + 14)
    const up = r.bottom + 6 + listH > window.innerHeight && r.top - 6 - listH > 0
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left: r.left, width: Math.max(r.width, minWidth), up })
  }

  useLayoutEffect(() => {
    if (open) compute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Меню «приклеено» к триггеру при скролле/ресайзе
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

  // При открытии — активный пункт на текущем значении. Инициализация в
  // обработчике открытия (а не в effect) — без каскадных рендеров.
  const openMenu = () => {
    const idx = options.findIndex(o => o.value === value)
    setActiveIdx(idx >= 0 ? idx : 0)
    setOpen(true)
  }

  // Активный пункт всегда в зоне видимости списка
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector(`[data-idx="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  const select = (v: string) => {
    onChange(v)
    setOpen(false)
    btnRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const o = options[activeIdx]; if (o) select(o.value) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'Tab') { setOpen(false) }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`ui-select${open ? ' ui-select--open' : ''}${disabled ? ' ui-select--disabled' : ''}${className ? ` ${className}` : ''}`}
        style={{ width, minWidth }}
        onClick={() => { if (!disabled) { if (open) setOpen(false); else openMenu() } }}
        onKeyDown={onKeyDown}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        {...rest}
      >
        <span className="ui-select__label" style={selected?.previewStyle}>
          {selected?.label ?? placeholder}
        </span>
        <motion.span
          className="ui-select__chevron"
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        >
          <AppIcon name="chevronDown" size="xs" tone="muted" />
        </motion.span>
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <>
              <div className="ui-select__overlay" onClick={() => setOpen(false)} />
              <motion.div
                ref={listRef}
                className="ui-select__dropdown"
                role="listbox"
                style={{
                  top: pos.top, left: pos.left, width: pos.width,
                  transformOrigin: pos.up ? 'bottom left' : 'top left',
                }}
                initial={{ opacity: 0, scale: 0.96, y: pos.up ? 6 : -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: pos.up ? 6 : -6 }}
                transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              >
                {options.map((o, i) => (
                  <button
                    key={o.value}
                    type="button"
                    data-idx={i}
                    role="option"
                    aria-selected={o.value === value}
                    className={`ui-select__option${i === activeIdx ? ' ui-select__option--active' : ''}${o.value === value ? ' ui-select__option--selected' : ''}`}
                    onClick={() => select(o.value)}
                    onMouseEnter={() => setActiveIdx(i)}
                  >
                    <span className="ui-select__option-label" style={o.previewStyle}>{o.label}</span>
                    {o.hint && <span className="ui-select__option-hint">{o.hint}</span>}
                    {o.value === value && <AppIcon name="check" size="xs" tone="accent" />}
                  </button>
                ))}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
