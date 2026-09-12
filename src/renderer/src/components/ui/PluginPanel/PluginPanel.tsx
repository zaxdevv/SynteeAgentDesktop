/**
 * PluginPanel — модальная iframe-панель кастомного UI плагина (slot 'modal').
 *
 * Контент плагина (entry из ui-вклада/манифеста) грузится через
 * syntee-plugin://{pluginId}/... протокол (main отдаёт файлы ТОЛЬКО из
 * папки плагина) в sandboxed iframe БЕЗ allow-same-origin — DOM приложения
 * недоступен, только postMessage.
 *
 * Весь мост (RPC / legacy push / тема) инкапсулирован в PluginIframe.
 * Кнопка DevTools — удобная отладка iframe (открывает DevTools окна).
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import PluginIframe from '../PluginSlot/PluginIframe'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useExtensionsStore } from '../../../store/extensions.store'
import './PluginPanel.css'

export default function PluginPanel(): JSX.Element | null {
  const open = usePluginPanelStore(s => s.open)
  const closePanel = usePluginPanelStore(s => s.closePanel)

  // ESC — закрыть.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePanel() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open, closePanel])

  // Путь до HTML плагина: entry из ui-вклада (registerPanel), иначе manifest.ui.
  // Модальную панель открывают вклады slot 'modal'/'sidebar' — не берём 'right'.
  const plugin = useExtensionsStore(s => s.plugins.find(p => p.id === open?.pluginId))
  const modalContrib = open
    ? plugin?.ui.find(u => u.slot !== 'right' && (u.panelId || u.entry))
    : undefined
  const uiEntry = modalContrib?.entry ?? plugin?.manifest.ui ?? 'index.html'

  if (!open) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="ext-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseDown={e => { if (e.target === e.currentTarget) closePanel() }}
      >
        <motion.div
          className="plugin-panel"
          initial={{ opacity: 0, y: 20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        >
          <div className="plugin-panel-header">
            <div className="plugin-panel-title">
              <AppIcon name="puzzle" size="sm" tone="accent" />
              <span>{open.title}</span>
            </div>
            <div className="plugin-panel-header-actions">
              <button
                className="plugin-panel-dev"
                onClick={() => { window.syntee.plugins.openDevTools().catch(() => {}) }}
                title="DevTools панели"
                aria-label="DevTools"
              >
                <AppIcon name="terminal" size="sm" />
              </button>
              <button className="ext-modal-close" onClick={closePanel} title="Закрыть" aria-label="Закрыть">
                <AppIcon name="x" size="sm" />
              </button>
            </div>
          </div>
          <div className="plugin-panel-body">
            <PluginIframe
              pluginId={open.pluginId}
              entry={uiEntry}
              title={open.title}
              className="plugin-panel-iframe"
            />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
