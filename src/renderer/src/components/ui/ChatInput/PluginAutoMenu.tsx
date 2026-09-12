import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { PluginAutoResult } from '../../../utils/pluginExtApi'

interface Props {
  auto: PluginAutoResult | null
  selectedIndex: number
  anchorRef: React.RefObject<HTMLElement>
  onSelect: (idx: number) => void
}

/**
 * Меню подсказок autocomplete-провайдера плагина (registerAutocomplete).
 * Показывается над инпут-боксом, как слеш-меню. Заголовок — trigger-слово,
 * строки — suggestions из ответа плагина.
 */
export function PluginAutoMenu({ auto, selectedIndex, anchorRef, onSelect }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Позиционирование над anchor (как SlashMenu).
  useEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const rect = anchor.getBoundingClientRect()
    menu.style.visibility = 'hidden'
    menu.style.top = '0px'
    menu.style.left = rect.left + 'px'
    menu.style.width = Math.min(rect.width, 420) + 'px'
    requestAnimationFrame(() => {
      const h = menu.offsetHeight
      menu.style.top = Math.max(8, rect.top - h - 6) + 'px'
      menu.style.visibility = 'visible'
    })
  })

  // Скролл к выбранному.
  useEffect(() => {
    const item = menuRef.current?.querySelectorAll('.slash-menu-item')[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!auto || !auto.suggestions || auto.suggestions.length === 0) return null

  return createPortal(
    <div className="slash-menu plugin-auto-menu" ref={menuRef}>
      {auto.suggestions.map((s, i) => (
        <button
          key={s.label + '-' + i}
          className={`slash-menu-item ${i === selectedIndex ? 'slash-menu-item--active' : ''}`}
          onMouseDown={e => { e.preventDefault(); onSelect(i) }}
          title={s.insertText || s.label}
        >
          <span className="slash-menu-icon"><span className="plugin-auto-menu-badge">/</span></span>
          <span className="slash-menu-label">{s.label}</span>
          {s.command && <span className="slash-menu-desc">команда</span>}
          {s.insertText && <span className="slash-menu-desc">вставить</span>}
        </button>
      ))}
    </div>,
    document.body,
  )
}
