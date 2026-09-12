import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import Logo from '../../components/ui/Logo/Logo'
import './TrayMenuPage.css'

type ActionId = 'showMain' | 'showVoice' | 'showSpotlight' | 'openSettings' | 'quit'

interface MenuItem {
  id: string
  icon: IconName
  label: string
  sub?: string
  action: ActionId
  danger?: boolean
}

/** Пункт меню от плагина (tray.setMenu). */
interface PluginTrayItem {
  pluginId: string
  label: string
  command?: string
  type: 'item' | 'separator'
}

const MENU_ITEMS: MenuItem[] = [
  { id: 'open', icon: 'sparkles', label: 'Открыть Syntee', sub: 'Ctrl+Shift+Space', action: 'showMain' },
  { id: 'voice', icon: 'mic', label: 'Голосовой режим', sub: 'Ctrl+Shift+V', action: 'showVoice' },
  { id: 'spotlight', icon: 'search', label: 'Spotlight', sub: 'Ctrl+Space', action: 'showSpotlight' },
  { id: 'settings', icon: 'settings', label: 'Настройки', action: 'openSettings' },
]

export default function TrayMenuPage() {
  const [selected, setSelected] = useState(0)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [gatewayOk, setGatewayOk] = useState<boolean | null>(null)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [pluginItems, setPluginItems] = useState<PluginTrayItem[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // Метаданные (версия) + статус gateway/обновлений для блока «О программе».
  useEffect(() => {
    window.syntee.trayMenu.getMeta().then(m => setVersion(m.version)).catch(() => {})
    window.syntee.gateway?.isAvailable().then(setGatewayOk).catch(() => {})
    window.syntee.updates?.getStatus().then(s => {
      if (s.status === 'available' && s.available) setUpdateVersion(s.available.version)
    }).catch(() => {})
  }, [])

  // Plugins: пункты от плагинов — при монтировании + push при изменении
  // (main шлёт свежие при каждом show() окна).
  useEffect(() => {
    window.syntee.trayMenu.getPluginItems?.().then(items => setPluginItems(items ?? [])).catch(() => {})
    const unsub = window.syntee.trayMenu.onPluginItemsChanged?.(items => setPluginItems(items ?? []))
    return () => { unsub?.() }
  }, [])

  const runPluginAction = useCallback((item: PluginTrayItem) => {
    window.syntee.trayMenu.pluginAction?.(item.pluginId, item.label, item.command)
    close()
  }, [])

  const close = useCallback(() => {
    window.syntee.trayMenu.hide()
  }, [])

  const runAction = useCallback((action: ActionId) => {
    window.syntee.trayMenu.action(action)
    close()
  }, [close])

  // Клавиатура: ↑↓ навигация, Enter — выполнить, Esc — закрыть.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, MENU_ITEMS.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = MENU_ITEMS[selected]
        if (item) runAction(item.action)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, close, runAction])

  // Прокрутка к выбранному пункту при клавиатурной навигации.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div className="tray-menu-root" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <motion.div
        className="tray-menu-card"
        initial={{ opacity: 0, scale: 0.94, y: -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: -6 }}
        transition={{ type: 'spring', stiffness: 460, damping: 30 }}
      >
        {/* Хедер */}
        <div className="tray-menu-header">
          <Logo size={22} />
          <div className="tray-menu-header-text">
            <span className="tray-menu-header-title">Syntee Helper</span>
            {version && <span className="tray-menu-header-version">v{version}</span>}
          </div>
          {updateVersion && (
            <span className="tray-menu-update-badge" title={`Доступно обновление v${updateVersion}`}>
              <AppIcon name="downloadCloud" size="xs" tone="accent" />
            </span>
          )}
        </div>

        {/* Пункты меню */}
        <div className="tray-menu-list" ref={listRef} role="menu">
          {MENU_ITEMS.map((item, i) => (
            <motion.button
              key={item.id}
              data-idx={i}
              role="menuitem"
              className={`tray-menu-item${i === selected ? ' tray-menu-item--active' : ''}`}
              onClick={() => runAction(item.action)}
              onMouseEnter={() => setSelected(i)}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.02 * i, duration: 0.16 }}
            >
              <span className="tray-menu-item-icon">
                <AppIcon name={item.icon} size="md" tone={i === selected ? 'accent' : 'muted'} />
              </span>
              <span className="tray-menu-item-label">{item.label}</span>
              {item.sub && <span className="tray-menu-item-sub">{item.sub}</span>}
            </motion.button>
          ))}

          {/* О программе — раскрывающийся блок */}
          <motion.button
            data-idx={MENU_ITEMS.length}
            role="menuitem"
            className={`tray-menu-item tray-menu-item--about${aboutOpen ? ' tray-menu-item--active' : ''}`}
            onClick={() => setAboutOpen(v => !v)}
            onMouseEnter={() => setSelected(MENU_ITEMS.length)}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.02 * MENU_ITEMS.length, duration: 0.16 }}
          >
            <span className="tray-menu-item-icon">
              <AppIcon name="info" size="md" tone={aboutOpen ? 'accent' : 'muted'} />
            </span>
            <span className="tray-menu-item-label">О программе</span>
            <span className="tray-menu-item-chevron">
              <AppIcon name={aboutOpen ? 'chevronUp' : 'chevronDown'} size="xs" tone="muted" />
            </span>
          </motion.button>

          <AnimatePresence initial={false}>
            {aboutOpen && (
              <motion.div
                className="tray-menu-about"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                <div className="tray-menu-about-row">
                  <span className="tray-menu-about-key">Версия</span>
                  <span className="tray-menu-about-val">{version || '—'}</span>
                </div>
                <div className="tray-menu-about-row">
                  <span className="tray-menu-about-key">Gateway</span>
                  <span className={`tray-menu-about-val tray-menu-about-val--${gatewayOk === null ? 'muted' : gatewayOk ? 'ok' : 'off'}`}>
                    {gatewayOk === null ? 'проверка…' : gatewayOk ? 'подключено' : 'недоступно'}
                  </span>
                </div>
                {updateVersion && (
                  <div className="tray-menu-about-row">
                    <span className="tray-menu-about-key">Обновление</span>
                    <span className="tray-menu-about-val tray-menu-about-val--accent">v{updateVersion}</span>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Плагины: пункты от tray.setMenu */}
          {pluginItems.length > 0 && (
            <>
              <div className="tray-menu-divider" />
              {pluginItems.map((item, i) => item.type === 'separator' ? (
                <div key={`sep-${i}`} className="tray-menu-divider" />
              ) : (
                <motion.button
                  key={`${item.pluginId}-${item.label}-${i}`}
                  role="menuitem"
                  className="tray-menu-item tray-menu-item--plugin"
                  onClick={() => runPluginAction(item)}
                  onMouseEnter={() => setSelected(-1)}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.02 * i, duration: 0.16 }}
                >
                  <span className="tray-menu-item-icon">
                    <AppIcon name="puzzle" size="md" tone="muted" />
                  </span>
                  <span className="tray-menu-item-label">{item.label}</span>
                </motion.button>
              ))}
            </>
          )}

          <div className="tray-menu-divider" />

          {/* Выход */}
          <motion.button
            data-idx={MENU_ITEMS.length + 1}
            role="menuitem"
            className={`tray-menu-item tray-menu-item--danger${selected === MENU_ITEMS.length + 1 ? ' tray-menu-item--active' : ''}`}
            onClick={() => runAction('quit')}
            onMouseEnter={() => setSelected(MENU_ITEMS.length + 1)}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.02 * (MENU_ITEMS.length + 1), duration: 0.16 }}
          >
            <span className="tray-menu-item-icon">
              <AppIcon name="power" size="md" tone="danger" />
            </span>
            <span className="tray-menu-item-label">Выход</span>
          </motion.button>
        </div>
      </motion.div>
    </div>
  )
}
