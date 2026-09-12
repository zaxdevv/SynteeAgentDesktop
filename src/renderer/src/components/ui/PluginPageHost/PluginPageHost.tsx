/**
 * PluginPageHost — полноэкранная страница плагина (slot 'page').
 *
 * Оверлей внутри .rp-chat-area (поверх keep-alive ChatPage, как страницы
 * Settings/Memory). Активная страница — pluginPanel.store.activePage
 * (заполняется из plugins:panel-action / клика по nav-кнопке плагина).
 * Если плагин выключили/выгрузили или вклад исчез — страница закрывается.
 */
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import PluginIframe from '../PluginSlot/PluginIframe'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useExtensionsStore } from '../../../store/extensions.store'
import './PluginPageHost.css'

export default function PluginPageHost(): JSX.Element | null {
  const activePage = usePluginPanelStore(s => s.activePage)
  const closePage = usePluginPanelStore(s => s.closePluginPage)

  const plugins = useExtensionsStore(s => s.plugins)
  const plugin = plugins.find(p => p.id === activePage?.pluginId)
  const contrib = plugin?.ui.find(u => u.slot === 'page' && u.panelId === activePage?.panelId)
  const pluginsLoading = useExtensionsStore(s => s.pluginsLoading)

  // Плагин выключили/выгрузили / вклад исчез — закрываем страницу.
  useEffect(() => {
    if (!activePage || pluginsLoading) return
    if (!plugin || plugin.status !== 'running' || !plugin.state.enabled || !contrib) closePage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage?.pluginId, activePage?.panelId, plugin?.status, plugin?.state?.enabled, !!contrib, pluginsLoading])

  if (!activePage || !contrib) return null

  const title = `${contrib.label} · ${plugin?.manifest.name ?? ''}`.replace(/ · $/, '')
  const uiEntry = contrib.entry ?? plugin?.manifest.ui ?? 'index.html'

  return (
    <AnimatePresence>
      <motion.div
        className="plugin-page-host"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
      >
        <div className="plugin-page-header">
          <div className="plugin-page-title">
            <AppIcon name={contrib.icon || 'puzzle'} size="sm" tone="accent" />
            <span>{title}</span>
          </div>
          <button className="plugin-page-close" onClick={closePage} title="Закрыть страницу" aria-label="Закрыть">
            <AppIcon name="x" size="sm" />
          </button>
        </div>
        <PluginIframe
          pluginId={activePage.pluginId}
          entry={uiEntry}
          title={title}
          className="plugin-page-iframe"
        />
      </motion.div>
    </AnimatePresence>
  )
}
