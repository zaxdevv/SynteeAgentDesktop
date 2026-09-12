/**
 * PluginModalHost — модальная iframe-панель плагина (PLUGINS_MODAL_ACTION).
 *
 * Слушает store.modal (заполняется из push 'plugins:modal-action' в
 * extensions.store или из кнопок сайдбара/карточек). Один модал одновременно:
 * новый open заменяет предыдущий. ESC / клик по подложке закрывают.
 *
 * Если плагин выключили/выгрузили — модал закрывается (эффект ниже).
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import PluginIframe from '../PluginSlot/PluginIframe'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useExtensionsStore } from '../../../store/extensions.store'
import '../PluginPanel/PluginPanel.css'
import './PluginModalHost.css'

export default function PluginModalHost(): JSX.Element | null {
  const modal = usePluginPanelStore(s => s.modal)
  const closeModal = usePluginPanelStore(s => s.closePluginModal)

  const plugins = useExtensionsStore(s => s.plugins)
  const plugin = plugins.find(p => p.id === modal?.pluginId)
  const pluginsLoading = useExtensionsStore(s => s.pluginsLoading)

  // ESC — закрыть.
  useEffect(() => {
    if (!modal) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [modal, closeModal])

  // Плагин выключили/выгрузили — закрываем модал.
  useEffect(() => {
    if (!modal || pluginsLoading) return
    if (!plugin || plugin.status !== 'running' || !plugin.state.enabled) closeModal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal?.pluginId, plugin?.status, plugin?.state?.enabled, pluginsLoading])

  if (!modal) return null

  // Путь до HTML: entry из payload (modal-action) → ui-вклад → manifest.ui.
  const uiEntry = modal.entry
    ?? plugin?.ui.find(u => u.slot !== 'right' && (u.panelId || u.entry))?.entry
    ?? plugin?.manifest.ui
    ?? 'index.html'

  const width = typeof modal.width === 'number' && modal.width > 0
    ? Math.min(modal.width, Math.floor(window.innerWidth * 0.92))
    : Math.min(640, Math.floor(window.innerWidth * 0.92))
  const height = typeof modal.height === 'number' && modal.height > 0
    ? Math.min(modal.height, Math.floor(window.innerHeight * 0.86))
    : Math.min(480, Math.floor(window.innerHeight * 0.86))

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="ext-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseDown={e => { if (e.target === e.currentTarget) closeModal() }}
      >
        <motion.div
          className="plugin-panel plugin-modal-host"
          style={{ width, height }}
          initial={{ opacity: 0, y: 20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        >
          <div className="plugin-panel-header">
            <div className="plugin-panel-title">
              <AppIcon name="puzzle" size="sm" tone="accent" />
              <span>{modal.title}</span>
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
              <button className="ext-modal-close" onClick={closeModal} title="Закрыть" aria-label="Закрыть">
                <AppIcon name="x" size="sm" />
              </button>
            </div>
          </div>
          <div className="plugin-panel-body">
            <PluginIframe
              pluginId={modal.pluginId}
              entry={uiEntry}
              title={modal.title}
              className="plugin-panel-iframe"
            />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
