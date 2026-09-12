/**
 * PluginChatOverlayHost — плавающий iframe-оверлей плагина ПОВЕРХ области
 * чата в главном окне (ui.showChatOverlay / ui.hideChatOverlay).
 *
 * В отличие от overlay.show (отдельное always-on-top окно) и ui.openModal
 * (модалка с затемнением) — компактная панель, висящая над перепиской:
 * живые виджеты, пуш данных через ui.emit, закрытие крестиком.
 *
 * Состояние: pluginPanel.store.chatOverlay (заполняется из push
 * 'plugins:chat-overlay' в extensions.store). Один оверлей одновременно.
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import PluginIframe from '../PluginSlot/PluginIframe'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useExtensionsStore } from '../../../store/extensions.store'
import '../PluginPanel/PluginPanel.css'
import './PluginChatOverlayHost.css'

export default function PluginChatOverlayHost(): JSX.Element | null {
  const overlay = usePluginPanelStore(s => s.chatOverlay)
  const closeOverlay = usePluginPanelStore(s => s.closeChatOverlay)

  const plugins = useExtensionsStore(s => s.plugins)
  const plugin = plugins.find(p => p.id === overlay?.pluginId)
  const pluginsLoading = useExtensionsStore(s => s.pluginsLoading)

  // Плагин выключили/выгрузили — закрываем оверлей.
  useEffect(() => {
    if (!overlay || pluginsLoading) return
    if (!plugin || plugin.status !== 'running' || !plugin.state.enabled) closeOverlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay?.pluginId, plugin?.status, plugin?.state?.enabled, pluginsLoading])

  if (!overlay) return null

  const width = typeof overlay.width === 'number' && overlay.width > 0
    ? Math.min(overlay.width, Math.floor(window.innerWidth * 0.5))
    : 360
  const height = typeof overlay.height === 'number' && overlay.height > 0
    ? Math.min(overlay.height, Math.floor(window.innerHeight * 0.7))
    : 300

  const posClass = overlay.position === 'left'
    ? 'plugin-chat-overlay--left'
    : overlay.position === 'center'
      ? 'plugin-chat-overlay--center'
      : 'plugin-chat-overlay--right'

  return createPortal(
    <AnimatePresence>
      <motion.div
        className={`plugin-chat-overlay ${posClass}`}
        style={{ width, height }}
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 400, damping: 34 }}
      >
        <div className="plugin-panel-header">
          <div className="plugin-panel-title">
            <AppIcon name="puzzle" size="sm" tone="accent" />
            <span>{overlay.title || plugin?.manifest.name || overlay.pluginId}</span>
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
            <button className="ext-modal-close" onClick={closeOverlay} title="Закрыть" aria-label="Закрыть">
              <AppIcon name="x" size="sm" />
            </button>
          </div>
        </div>
        <div className="plugin-panel-body">
          <PluginIframe
            pluginId={overlay.pluginId}
            entry={overlay.entry}
            title={overlay.title || overlay.pluginId}
            className="plugin-panel-iframe"
          />
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
