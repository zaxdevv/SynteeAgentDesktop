import { memo, useEffect, useMemo, useRef, useState, useDeferredValue } from 'react'
import { Search, X } from 'lucide-react'
import type { Message } from '../../../../../shared/types'
import { PSEUDO_IDS, snippet, roleLabel, formatTime } from './minimapShared'

// ── ChatMinimapPanel — панель «все сообщения» миникарты ────────────────────
// Открывается кнопкой-лупой над полосой точек или ховером точки (350 мс).
// Внутри: поиск по тексту, сортировка (порядок ↑/↓, новые, по роли),
// кликабельный список всех сообщений с подсветкой активного.

type SortMode = 'order-asc' | 'order-desc' | 'time-desc' | 'role'

const SORTS: Array<{ id: SortMode; label: string; title: string }> = [
  { id: 'order-asc', label: '↑ Порядок', title: 'По порядку: старые сверху' },
  { id: 'order-desc', label: '↓ Порядок', title: 'По порядку: новые сверху' },
  { id: 'time-desc', label: 'Новые', title: 'Сначала самые свежие по времени' },
  { id: 'role', label: 'По роли', title: 'Группами: Вы → Syntee → Система' }
]

function roleWeight(role: Message['role']): number {
  if (role === 'user') return 0
  if (role === 'assistant') return 1
  return 2
}

interface ChatMinimapPanelProps {
  /** displayMessages страницы (включая псевдо — фильтруются внутри). */
  messages: Message[]
  /** Активное сообщение (в центре вьюпорта) — подсветка в списке. */
  activeOrigIndex: number
  /** Y-координата якоря (курсор/кнопка) — панель раскрывается рядом. */
  anchorY: number
  /** Прыжок к сообщению по индексу ПОЛНОГО массива displayMessages. */
  onJump: (origIndex: number) => void
  onClose: () => void
  /** Ховеры для grace-закрытия (курсор ушёл с панели — закрываем с задержкой). */
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  /** Автофокус в поиск — только при открытии КНОПКОЙ (не ховером, чтобы не
   *  красть фокус у чат-инпута, когда пользователь печатает). */
  autoFocus?: boolean
}

function ChatMinimapPanelInner({
  messages,
  activeOrigIndex,
  anchorY,
  onJump,
  onClose,
  onMouseEnter,
  onMouseLeave,
  autoFocus = false
}: ChatMinimapPanelProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [sort, setSort] = useState<SortMode>('order-asc')
  const inputRef = useRef<HTMLInputElement>(null)

  // Esc — закрыть панель.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  // Реальные сообщения + фильтр поиска + сортировка. Поиск — по сырому
  // content (не сниппету), чтобы находилось и внутри длинных сообщений.
  const { list, total } = useMemo(() => {
    const real: Array<{ origIndex: number; msg: Message }> = []
    for (let i = 0; i < messages.length; i++) {
      if (PSEUDO_IDS.has(messages[i].id)) continue
      real.push({ origIndex: i, msg: messages[i] })
    }
    const q = deferredQuery.trim().toLowerCase()
    const filtered = q
      ? real.filter(it => (it.msg.content ?? '').toLowerCase().includes(q))
      : real
    const sorted = [...filtered]
    if (sort === 'order-desc') sorted.reverse()
    else if (sort === 'time-desc')
      sorted.sort((a, b) => (b.msg.createdAt || 0) - (a.msg.createdAt || 0))
    else if (sort === 'role')
      sorted.sort(
        (a, b) => roleWeight(a.msg.role) - roleWeight(b.msg.role) || a.origIndex - b.origIndex
      )
    return { list: sorted, total: real.length }
  }, [messages, deferredQuery, sort])

  const top = Math.min(Math.max(anchorY - 180, 8), Math.max(window.innerHeight - 420, 8))
  const isFiltered = deferredQuery.trim().length > 0

  return (
    <div
      className="chat-minimap-panel"
      style={{ top }}
      role="dialog"
      aria-label="Навигация по сообщениям"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="chat-minimap-panel-head">
        <span className="chat-minimap-panel-title">
          Сообщения
          <span className="chat-minimap-panel-count">
            {isFiltered ? `${list.length} из ${total}` : total}
          </span>
        </span>
        <button
          type="button"
          className="chat-minimap-panel-close"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <X size={13} />
        </button>
      </div>

      <div className="chat-minimap-panel-search">
        <Search size={12} className="chat-minimap-panel-search-icon" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Поиск по сообщениям…"
          spellCheck={false}
        />
        {query && (
          <button
            type="button"
            className="chat-minimap-panel-search-clear"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
            aria-label="Очистить поиск"
          >
            <X size={11} />
          </button>
        )}
      </div>

      <div className="chat-minimap-panel-sorts">
        {SORTS.map(s => (
          <button
            key={s.id}
            type="button"
            title={s.title}
            className={[
              'chat-minimap-sort-btn',
              sort === s.id ? 'chat-minimap-sort-btn--active' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setSort(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="chat-minimap-panel-list">
        {list.length === 0 ? (
          <div className="chat-minimap-panel-empty">Ничего не найдено</div>
        ) : (
          list.map(it => (
            <button
              key={it.msg.id}
              type="button"
              className={[
                'chat-minimap-panel-row',
                it.origIndex === activeOrigIndex ? 'chat-minimap-panel-row--active' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onJump(it.origIndex)}
            >
              <span className="chat-minimap-panel-row-head">
                <span
                  className={`chat-minimap-panel-row-role chat-minimap-panel-row-role--${it.msg.role}`}
                >
                  {roleLabel(it.msg.role)}
                </span>
                <span className="chat-minimap-panel-row-time">
                  {formatTime(it.msg.createdAt)}
                </span>
              </span>
              <span className="chat-minimap-panel-row-text">
                {snippet(it.msg.content) || '[вложение]'}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export const ChatMinimapPanel = memo(ChatMinimapPanelInner)
