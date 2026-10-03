// ── DotCard: карточка Dot'а в списке — «лента» как в мессенджере ──────────
// Двухэтажная карточка: имя + время → превью последнего отчёта →
// мета-строка (триггер · счётчики). Статус — точка на капле (скан глазами
// быстрее текста). Unread-бейдж: отчёты после lastSeen.
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import type { Dot } from '../../../../shared/types'
import { DotBlob } from './DotBlob'

function fmtNext(ts?: number): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  if (diff <= 0) return 'сейчас'
  const min = Math.round(diff / 60_000)
  if (min < 60) return `через ${min} мин`
  const h = Math.floor(min / 60)
  if (h < 24) return `через ${h} ч`
  return `через ${Math.floor(h / 24)} д`
}

function fmtLast(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч`
  return `${Math.floor(h / 24)} д`
}

/** Иконка триггера Dot'а (чем будится). */
function TriggerIcon({ dot }: { dot: Dot }) {
  const hasSchedule = !!dot.schedule
  const hasWatch = !!dot.watchPaths?.length
  const hasWebhook = !!dot.webhookEnabled
  const icon = hasSchedule ? 'clock' : hasWatch ? 'folder' : hasWebhook ? 'link' : 'zap'
  return <AppIcon name={icon as 'clock'} size="xs" tone="muted" className="dot-card-trig-icon" />
}

/** Статусная точка на капле: цвет кодирует состояние. */
function StatusDot({ dot }: { dot: Dot }) {
  const s = dot.state.status
  if (s === 'disabled') return null
  const cls = s === 'running' ? 'dot-status-dot--running'
    : s === 'error' ? 'dot-status-dot--error'
    : 'dot-status-dot--sleeping'
  return <span className={`dot-status-dot ${cls}`} style={{ ['--dot-color' as string]: dot.color }} />
}

/** Варианты появления: stagger задаётся через delay от index (см. ниже).
 *  EXIT — только числовые значения (opacity/scale) + tween: нечисловые
 *  свойства и spring в exit ломают выход из DOM (урок прошлой сессии). */
const CARD_VARIANTS = {
  hidden: { opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const } },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const } },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.14, ease: 'easeOut' as const } },
}

export function DotCard({
  dot,
  selected,
  unread,
  index = 0,
  onSelect,
  onWake,
  onToggle,
  onEdit,
  onDelete,
}: {
  dot: Dot
  selected: boolean
  /** Число непрочитанных отчётов (после lastSeen). */
  unread: number
  /** Порядковый номер в группе — для staggered-появления. */
  index?: number
  onSelect: () => void
  onWake: () => void
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const s = dot.state
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Автосброс подтверждения удаления через 3с
  useEffect(() => {
    if (confirmDelete) {
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 3000)
    }
    return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }
  }, [confirmDelete])

  // Меню «⋯»: включить/выключить, настроить, удалить. Закрытие по клику
  // вне меню и по Escape.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Превью последнего отчёта: ошибка > отчёт > «молчал» > «ещё не просыпался».
  const preview = s.status === 'error' && s.lastError
    ? { text: s.lastError, cls: 'dot-card-preview--error' }
    : s.lastReport?.summary
      ? { text: s.lastReport.summary, cls: unread > 0 ? 'dot-card-preview--unread' : '' }
      : s.silentCount > 0
        ? { text: 'молчал — изменений не было', cls: 'dot-card-preview--muted' }
        : { text: 'ещё не просыпался', cls: 'dot-card-preview--muted' }

  // Мета-строка: триггер + next wake / счётчики.
  const quietPct = s.runCount > 0 ? Math.round((s.silentCount / s.runCount) * 100) : null
  const metaParts: string[] = []
  if (s.status === 'running') metaParts.push('работает…')
  else if (s.nextRunAt) metaParts.push(fmtNext(s.nextRunAt))
  if (quietPct !== null) metaParts.push(`${quietPct}% тихих`)

  const timeTitle = s.lastRunAt
    ? `Последний ран: ${new Date(s.lastRunAt).toLocaleString()} (${s.lastRunTrigger ?? '—'})`
    : 'Ещё ни одного пробуждения'

  return (
    <motion.div
      layout="position"
      className={[
        'dot-card',
        selected ? 'dot-card--selected' : '',
        !dot.enabled ? 'dot-card--disabled' : '',
      ].filter(Boolean).join(' ')}
      style={{ ['--dot-color' as string]: dot.color }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onSelect() }}
      variants={{
        ...CARD_VARIANTS,
        visible: {
          ...CARD_VARIANTS.visible,
          transition: {
            ...CARD_VARIANTS.visible.transition,
            delay: Math.min(index * 0.03, 0.24),
          },
        },
      }}
      initial="hidden"
      animate="visible"
      exit="exit"
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.995 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div className="dot-card-avatar">
        <DotBlob color={dot.color} icon={dot.icon} status={s.status} />
        <StatusDot dot={dot} />
        {unread > 0 && (
          <span className="dot-card-unread" title={`${unread} новых отчёт(ов)`}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </div>
      <div className="dot-card-info">
        <div className="dot-card-top">
          <span className="dot-card-name">{dot.name}</span>
          {s.lastReport && (
            <span className="dot-card-time" title={timeTitle}>{fmtLast(s.lastReport.at)}</span>
          )}
        </div>
        <div className={`dot-card-preview ${preview.cls}`} title={preview.text}>
          {preview.text}
        </div>
        <div className="dot-card-meta">
          <TriggerIcon dot={dot} />
          <span className="dot-card-meta-text">
            {metaParts.length > 0 ? metaParts.join(' · ') : 'без расписания'}
          </span>
          <span className="dot-card-model" title={`Модель: ${dot.modelId ?? 'основная (main)'}`}>
            {dot.modelId ?? 'осн.'}
          </span>
        </div>
      </div>
      {/* Действия: на карточке только «Разбудить» (главное), остальное —
          в меню «⋯»: 4 кнопки в ряд съедали треть карточки и шумели. */}
      <div className="dot-card-actions" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          className="dot-card-action dot-card-action--wake"
          title={s.status === 'running' ? 'Dot уже работает' : 'Разбудить сейчас'}
          disabled={s.status === 'running' || !dot.enabled}
          onClick={onWake}
        >
          <AppIcon name="zap" size="xs" />
        </button>
        <div className="dot-card-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className={`dot-card-action${menuOpen ? ' dot-card-action--open' : ''}`}
            title="Ещё"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(v => !v)}
          >
            <AppIcon name="moreHorizontal" size="xs" />
          </button>
          {menuOpen && (
            <div className="dot-card-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="dot-card-menu-item"
                onClick={() => { setMenuOpen(false); onToggle() }}
              >
                <AppIcon name="power" size="xs" />
                {dot.enabled ? 'Выключить (пауза)' : 'Включить'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="dot-card-menu-item"
                onClick={() => { setMenuOpen(false); onEdit() }}
              >
                <AppIcon name="settings" size="xs" />
                Настроить
              </button>
              {confirmDelete ? (
                <button
                  type="button"
                  role="menuitem"
                  className="dot-card-menu-item dot-card-menu-item--danger"
                  onClick={() => { setMenuOpen(false); setConfirmDelete(false); onDelete() }}
                >
                  <AppIcon name="check" size="xs" />
                  Точно удалить?
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="dot-card-menu-item dot-card-menu-item--danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  <AppIcon name="trash" size="xs" />
                  Удалить…
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}
