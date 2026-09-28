import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { MentionItem, MentionItemType } from '../../../../../shared/types'
import './MentionMenu.css'

interface MentionMenuProps {
  items: MentionItem[]
  selectedIndex: number
  anchorRef: React.RefObject<HTMLElement>
  onSelect: (item: MentionItem) => void
  onClose: () => void
}

// Иконка по типу элемента — компактная SVG-голова (как в SlashMenu),
// чтобы не тянуть lucide-react напрямую (размер бандла + единый стиль).
function TypeIcon({ type }: { type: MentionItemType }): JSX.Element {
  if (type === 'image') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    )
  }
  if (type === 'skill') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l3 7 7 .5-5.5 4.5 1.5 7L12 17l-6 4 1.5-7L2 9.5 9 9z" />
      </svg>
    )
  }
  if (type === 'command') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    )
  }
  if (type === 'chat') {
    // message-circle (lucide) — ссылка на чат
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    )
  }
  if (type === 'project') {
    // folder (lucide) — ссылка на проект
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    )
  }
  // file — default
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

// Бейдж типа — короткая метка справа (F/S/C/I/CHAT/PROJ).
function TypeBadge({ type }: { type: MentionItemType }): JSX.Element {
  const label = type === 'file' ? 'FILE'
    : type === 'image' ? 'IMG'
    : type === 'skill' ? 'SKILL'
    : type === 'chat' ? 'CHAT'
    : type === 'project' ? 'PROJ'
    : 'CMD'
  return <span className={`mention-menu-badge mention-menu-badge--${type}`}>{label}</span>
}

export default function MentionMenu({ items, selectedIndex, anchorRef, onSelect, onClose }: MentionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Пересчитываем позицию после каждого рендера — как в SlashMenu.
  useEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return

    const rect = anchor.getBoundingClientRect()
    menu.style.visibility = 'hidden'
    menu.style.top = '0px'
    menu.style.left = rect.left + 'px'
    menu.style.width = Math.max(rect.width, 380) + 'px'

    requestAnimationFrame(() => {
      const h = menu.offsetHeight
      const viewportH = window.innerHeight
      // Если не помещается сверху — открываем снизу
      if (rect.top - h - 6 < 8 && rect.bottom + h + 6 < viewportH) {
        menu.style.top = (rect.bottom + 6) + 'px'
      } else {
        menu.style.top = (rect.top - h - 6) + 'px'
      }
      menu.style.visibility = 'visible'
    })
  })

  // Скроллим к выбранному
  useEffect(() => {
    const item = menuRef.current?.querySelectorAll('.mention-menu-item')[selectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Закрытие по клику снаружи
  useEffect(() => {
    if (items.length === 0) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      if (anchorRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [items.length, onClose, anchorRef])

  return createPortal(
    <AnimatePresence>
      {items.length > 0 && (
        <motion.div
          className="mention-menu"
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.92, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 6 }}
          transition={{ type: 'spring', stiffness: 480, damping: 28 }}
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              className={`mention-menu-item ${i === selectedIndex ? 'mention-menu-item--active' : ''}`}
              onMouseDown={e => { e.preventDefault(); onSelect(item) }}
              onMouseEnter={() => {
                // Не двигаем selectedIndex — он управляется с клавиатуры.
                // Но даём визуальный feedback через CSS :hover.
              }}
            >
              <span className={`mention-menu-icon mention-menu-icon--${item.type}`}>
                <TypeIcon type={item.type} />
              </span>
              <span className="mention-menu-text">
                <span className="mention-menu-label">{item.label}</span>
                {item.description && (
                  <span className="mention-menu-desc">{item.description}</span>
                )}
              </span>
              {item.size !== undefined && item.size > 0 && (
                <span className="mention-menu-size">
                  {item.size < 1024 ? `${item.size}B`
                    : item.size < 1024 * 1024 ? `${(item.size / 1024).toFixed(1)}KB`
                    : `${(item.size / 1024 / 1024).toFixed(1)}MB`}
                </span>
              )}
              <TypeBadge type={item.type} />
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
