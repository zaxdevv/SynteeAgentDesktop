import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon, { type IconName } from '../ui/AppIcon/AppIcon'

// ── Общие примитивы страницы настроек ──────────────────────────────
// Используются SettingsPage и саб-табами (Контекст, Индексация) для
// единого карточного layout'а в стиле macOS System Settings.
// CSS-классы (.settings-card, .settings-field и т.д.) живут в
// SettingsPage.css — он загружается вместе со страницей настроек,
// внутри которой рендерятся все саб-табы.

export function SectionTitle({ children, description }: { children: React.ReactNode; description?: string }) {
  return (
    <div className="settings-section-title-wrap">
      <h2 className="settings-section-title">{children}</h2>
      {description && <p className="settings-section-desc">{description}</p>}
    </div>
  )
}

// Единая шапка категории настроек: иконка в accent-чипе + uppercase-заголовок
// + тонкая линия до края (визуально связывает группу, как в macOS Settings)
// + опциональная пометка справа.
export function GroupHeader({ icon, title, note, right }: {
  icon: IconName; title: string; note?: string; right?: React.ReactNode
}) {
  return (
    <div className="settings-group-header">
      <span className="settings-group-header-icon"><AppIcon name={icon} size="xs" /></span>
      <span className="settings-group-header-title">{title}</span>
      <span className="settings-group-header-line" />
      {note && <span className="settings-group-header-note">{note}</span>}
      {right && <div className="settings-group-header-right" onClick={e => e.stopPropagation()}>{right}</div>}
    </div>
  )
}

export function Field({ id, label, description, children, block }: {
  id?: string; label: string; description?: string; children: React.ReactNode; block?: boolean
}) {
  return (
    <div className={`settings-field${block ? ' settings-field--block' : ''}`} data-field-id={id}>
      <div className="settings-field-label">
        <span>{label}</span>
        {description && <p className="settings-field-desc">{description}</p>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}

// ── Карточка группы настроек ──
// Оборачивает GroupHeader + поля в единую карточку (macOS Settings style):
// фон, рамка, скругление, hover-подсветка строк внутри. Клик по шапке
// сворачивает/разворачивает карточку (состояние — на сессию, Set модульного
// уровня). GROUP_TOGGLE_EVENT — раскрытие карточки извне (поиск по полям).
export const GROUP_TOGGLE_EVENT = 'syntee-settings-group-toggle'
const collapsedGroups = new Set<string>()

export function Group({ id, icon, title, note, right, children }: {
  id: string; icon: IconName; title: string; note?: string; right?: React.ReactNode; children: React.ReactNode
}) {
  const [open, setOpen] = useState(!collapsedGroups.has(id))

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail === id) setOpen(true)
    }
    window.addEventListener(GROUP_TOGGLE_EVENT, handler)
    return () => window.removeEventListener(GROUP_TOGGLE_EVENT, handler)
  }, [id])

  const toggle = () => {
    setOpen(o => {
      const next = !o
      if (next) collapsedGroups.delete(id)
      else collapsedGroups.add(id)
      return next
    })
  }

  return (
    <div className={`settings-card${open ? '' : ' settings-card--collapsed'}`} data-group-id={id}>
      <div className="settings-card-header" onClick={toggle} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}>
        <GroupHeader icon={icon} title={title} note={note} right={right} />
        <motion.span
          className="settings-card-chevron"
          animate={{ rotate: open ? 0 : -90 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        >
          <AppIcon name="chevronDown" size="xs" tone="muted" />
        </motion.span>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="settings-card-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            style={{ overflow: 'hidden' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Кнопка с подтверждением для опасных действий ──
// Первый клик «взводит» кнопку (красная пульсация, текст «Точно?...»),
// второй — выполняет. Автосброс через 3с. Защита от случайного клика
// по «Очистить историю» / «Сбросить память».
export function ConfirmButton({ label, confirmLabel = 'Точно? Нажмите ещё раз', onConfirm, className = 'settings-btn settings-btn--danger', title, disabled }: {
  label: string; confirmLabel?: string; onConfirm: () => void; className?: string; title?: string; disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<number | null>(null)
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const handleClick = () => {
    if (disabled) return
    if (!armed) {
      setArmed(true)
      timerRef.current = window.setTimeout(() => setArmed(false), 3000)
    } else {
      if (timerRef.current) clearTimeout(timerRef.current)
      setArmed(false)
      onConfirm()
    }
  }

  return (
    <motion.button
      type="button"
      className={`${className}${armed ? ' settings-btn--armed' : ''}`}
      onClick={handleClick}
      whileTap={{ scale: 0.95 }}
      title={title}
      disabled={disabled}
    >
      {armed ? confirmLabel : label}
    </motion.button>
  )
}
