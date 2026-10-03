import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { PERSONAS, type PersonaId } from '../../../../../shared/modes'
import { whileHoverBtn, whileTapBtn, springHover } from '../../../utils/motionPresets'
import { menuContainer, menuItem } from './ChatInputHelpers'

interface ChatInputPlusMenuProps {
  onAttachClick: () => void
  /** Кол-во защищённых переменных (секретов) — бейдж у пункта меню. */
  secretsCount?: number
  /** Открыть модалку защищённых переменных. */
  onProtectedVarsClick?: () => void
  planningMode?: boolean
  onPlanningModeChange?: (v: boolean) => void
  imageMode?: boolean
  onImageModeChange?: (v: boolean) => void
  askMode?: boolean
  onAskModeChange?: (v: boolean) => void
  browserMode?: boolean
  onBrowserModeChange?: (v: boolean) => void
  persona?: PersonaId
  onPersonaChange?: (v: PersonaId) => void
  lang: 'ru' | 'en'
}

/**
 * Кнопка «+» с выпадающим меню: «Прикрепить файл», toggles режимов
 * (планирование / генерация изображений / ask) и пикер персоны.
 * Управляет собственным состоянием открытия и позицией меню (portal в body).
 */
export function ChatInputPlusMenu({
  onAttachClick,
  secretsCount = 0,
  onProtectedVarsClick,
  planningMode,
  onPlanningModeChange,
  imageMode,
  onImageModeChange,
  askMode,
  onAskModeChange,
  browserMode,
  onBrowserModeChange,
  persona,
  onPersonaChange,
  lang,
}: ChatInputPlusMenuProps) {
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const plusBtnRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)

  // Закрытие + меню по клику снаружи
  const plusWrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!plusMenuOpen) return
    const close = (e: MouseEvent) => {
      if (plusWrapRef.current?.contains(e.target as Node)) return
      if (menuRef.current?.contains(e.target as Node)) return
      setPlusMenuOpen(false)
    }
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [plusMenuOpen])

  // Корректировка позиции меню после mount: начальная оценка menuH может
  // отличаться от реальной высоты (меню содержит скролл-секцию персонов).
  // После первого paint измеряем menuRef и сдвигаем top, чтобы меню
  // поместилось на экране и не обрезалось.
  useEffect(() => {
    if (!plusMenuOpen || !menuPos || !menuRef.current || !plusBtnRef.current) return
    // offsetHeight НЕ зависит от CSS-трансформов (scale) — даёт реальную высоту.
    // getBoundingClientRect вернула бы ~половину из-за scale: 0.5 на старте анимации.
    const menuH = menuRef.current.offsetHeight + 8
    const btnRect = plusBtnRef.current.getBoundingClientRect()
    let top = btnRect.top - menuH
    if (top < 8) top = btnRect.bottom + 8
    const maxTop = window.innerHeight - menuH - 8
    if (top > maxTop) top = Math.max(8, maxTop)
    setMenuPos({ top, left: menuPos.left, openUp: top < btnRect.top })
  }, [plusMenuOpen, menuPos?.left])

  return (
    <div className="chat-input-plus-wrap" ref={plusWrapRef}>
      <motion.button
        ref={plusBtnRef}
        className={`chat-input-plus-btn${plusMenuOpen ? ' chat-input-plus-btn--open' : ''}`}
        onClick={() => {
          if (!plusBtnRef.current) return
          const r = plusBtnRef.current.getBoundingClientRect()
          // Начальная оценка высоты: attach + divider + 3 toggle + divider
          // + persona-section (7 компактных пунктов + заголовок). Реальная
          // высота измеряется после mount через useEffect-корректировку выше.
          const menuH = 380
          setMenuPos({
            top: r.top - menuH - 8,
            left: r.left,
            openUp: true,
          })
          setPlusMenuOpen(v => !v)
        }}
        whileHover={whileHoverBtn}
        whileTap={whileTapBtn}
        transition={springHover}
        title="Прикрепить / Режим"
      >
        <motion.svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" animate={{ rotate: plusMenuOpen ? 45 : 0 }} transition={{ type: 'spring', stiffness: 400, damping: 18 }}>
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </motion.svg>
      </motion.button>

      {createPortal(
        <AnimatePresence>
          {plusMenuOpen && menuPos && (
            <motion.div
              ref={menuRef}
              className="chat-input-plus-menu"
              variants={menuContainer}
              initial="hidden"
              animate="visible"
              exit="exit"
              style={{ position: 'fixed', left: menuPos.left, top: menuPos.top, zIndex: 9999, transformOrigin: menuPos.openUp ? 'bottom left' : 'top left' }}
              onMouseDown={e => e.stopPropagation()}
            >
              <motion.button variants={menuItem} className="chat-input-plus-item" onClick={() => { onAttachClick(); setPlusMenuOpen(false) }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                </svg>
                Прикрепить файл
              </motion.button>
              <motion.button variants={menuItem} className="chat-input-plus-item" onClick={() => { onProtectedVarsClick?.(); setPlusMenuOpen(false) }} title="Защищённые переменные — секреты (IP, пароли, ключи), которые AI использует, не спрашивая каждый раз">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Защищённые переменные
                {secretsCount > 0 && (
                  <span className="chat-input-plus-badge">{secretsCount}</span>
                )}
              </motion.button>
              <div className="chat-input-plus-divider" />
              <motion.div variants={menuItem} className="chat-input-plus-item chat-input-plus-item--toggle" onClick={() => { onPlanningModeChange?.(!planningMode) }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
                Планирование
                <motion.button
                  className={`plus-menu-toggle${planningMode ? ' plus-menu-toggle--on' : ''}`}
                  onClick={e => { e.stopPropagation(); onPlanningModeChange?.(!planningMode) }}
                  whileTap={{ scale: 0.93 }}
                >
                  <motion.span
                    className="plus-menu-toggle-thumb"
                    animate={{ x: planningMode ? 16 : 2 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  />
                </motion.button>
              </motion.div>
              <motion.div variants={menuItem} className="chat-input-plus-item chat-input-plus-item--toggle" onClick={() => { onImageModeChange?.(!imageMode) }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
                Генерация изображений
                <motion.button
                  className={`plus-menu-toggle${imageMode ? ' plus-menu-toggle--on' : ''}`}
                  onClick={e => { e.stopPropagation(); onImageModeChange?.(!imageMode) }}
                  whileTap={{ scale: 0.93 }}
                >
                  <motion.span
                    className="plus-menu-toggle-thumb"
                    animate={{ x: imageMode ? 16 : 2 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  />
                </motion.button>
              </motion.div>
              <motion.div variants={menuItem} className="chat-input-plus-item chat-input-plus-item--toggle" onClick={() => { onAskModeChange?.(!askMode) }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                {lang === 'en' ? 'Ask — read only' : 'Ask — только чтение'}
                <motion.button
                  className={`plus-menu-toggle${askMode ? ' plus-menu-toggle--on' : ''}`}
                  onClick={e => { e.stopPropagation(); onAskModeChange?.(!askMode) }}
                  whileTap={{ scale: 0.93 }}
                >
                  <motion.span
                    className="plus-menu-toggle-thumb"
                    animate={{ x: askMode ? 16 : 2 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  />
                </motion.button>
              </motion.div>
              <motion.div variants={menuItem} className="chat-input-plus-item chat-input-plus-item--toggle" onClick={() => { onBrowserModeChange?.(!browserMode) }} title={lang === 'en' ? 'Browser control: the agent gets browser_* tools to drive the built-in browser (right panel)' : 'Управление браузером: агент получает browser_*-тулы для управления встроенным браузером (правая панель)'}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2"/>
                  <path d="M2 8h20"/>
                  <path d="m9.5 10 3.2 8 1.1-3.3 3.3-1.1z"/>
                </svg>
                {lang === 'en' ? 'Browser control' : 'Управление браузером'}
                <motion.button
                  className={`plus-menu-toggle${browserMode ? ' plus-menu-toggle--on' : ''}`}
                  onClick={e => { e.stopPropagation(); onBrowserModeChange?.(!browserMode) }}
                  whileTap={{ scale: 0.93 }}
                >
                  <motion.span
                    className="plus-menu-toggle-thumb"
                    animate={{ x: browserMode ? 16 : 2 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  />
                </motion.button>
              </motion.div>

              <div className="chat-input-plus-divider" />
              <motion.div variants={menuItem} className="chat-input-plus-section-label">
                {lang === 'en' ? 'Mode' : 'Режим'}
              </motion.div>
              <motion.div variants={menuItem} className="chat-input-plus-personas">
                {PERSONAS.map(p => {
                  const selected = p.id === persona
                  return (
                    <div
                      key={p.id}
                      className={`chat-input-persona-item${selected ? ' chat-input-persona-item--selected' : ''}${p.id === 'classic' ? ' chat-input-persona-item--classic' : ''}`}
                      style={p.color ? ({ '--persona-color': p.color } as React.CSSProperties) : undefined}
                      onClick={() => { onPersonaChange?.(p.id); setPlusMenuOpen(false) }}
                    >
                      <span className="chat-input-persona-icon">
                        {p.iconSvg
                          ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: p.iconSvg }} />
                          : <span className="chat-input-persona-dot" />}
                      </span>
                      <span className="chat-input-persona-text">
                        <span className="chat-input-persona-name">{lang === 'en' ? p.nameEn : p.nameRu}</span>
                        <span className="chat-input-persona-desc">{lang === 'en' ? p.descEn : p.descRu}</span>
                      </span>
                      {selected && (
                        <motion.span
                          className="chat-input-persona-check"
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        </motion.span>
                      )}
                    </div>
                  )
                })}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
