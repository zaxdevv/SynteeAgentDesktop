/**
 * PluginBottomHost — нижний док iframe-панелей плагинов (slot 'bottom').
 *
 * В отличие от BottomDock (терминалы) — отдельная сворачиваемая панель
 * ~240px с вкладками плагинов. Открытые табы живут в pluginPanel.store
 * (plugins:panel-action / кнопка сайдбара). Если плагин выгружен или вклад
 * исчез — таб вычищается автоматически.
 *
 * Кнопка «свернуть» закрывает все плагиновые табы (док исчезает). Снова
 * открыть панель можно через ui-кнопку плагина в сайдбаре.
 */
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import PluginIframe from '../PluginSlot/PluginIframe'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useExtensionsStore } from '../../../store/extensions.store'
import './PluginBottomHost.css'

const DOCK_HEIGHT = 240

export default function PluginBottomHost(): JSX.Element | null {
  const bottomTabs = usePluginPanelStore(s => s.bottomTabs)
  const activeTab = usePluginPanelStore(s => s.activeBottomTab)
  const closeTab = usePluginPanelStore(s => s.closePluginBottomTab)
  const setActive = usePluginPanelStore(s => s.setActivePluginBottomTab)

  const plugins = useExtensionsStore(s => s.plugins)
  const pluginsLoading = useExtensionsStore(s => s.pluginsLoading)

  // Вычищаем табы плагинов, чей ui-вклад slot 'bottom' пропал (выгружен/
  // выключен/изменён) — иначе пустой таб без контента висит вечно.
  useEffect(() => {
    if (bottomTabs.length === 0 || pluginsLoading) return
    const st = usePluginPanelStore.getState()
    for (const t of bottomTabs) {
      const p = plugins.find(x => x.id === t.pluginId && x.state.enabled && x.status === 'running')
      const has = !!p?.ui.find(u => u.slot === 'bottom' && u.panelId === t.panelId)
      if (!has) st.closePluginBottomTab(t.pluginId, t.panelId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, pluginsLoading])

  if (bottomTabs.length === 0) return null

  // Мета по табу для заголовка/иконки/entry.
  const metaOf = (pluginId: string, panelId: string) => {
    const p = plugins.find(x => x.id === pluginId)
    const c = p?.ui.find(u => u.slot === 'bottom' && u.panelId === panelId)
    if (!p || !c) return null
    return {
      label: c.label,
      icon: c.icon || 'puzzle',
      entry: c.entry ?? p.manifest.ui ?? 'index.html',
    }
  }

  const active = activeTab && bottomTabs.some(t => t.pluginId === activeTab.pluginId && t.panelId === activeTab.panelId)
    ? activeTab
    : bottomTabs[bottomTabs.length - 1]

  return (
    <AnimatePresence>
      <motion.div
        className="plugin-bottom-host"
        style={{ height: DOCK_HEIGHT }}
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: DOCK_HEIGHT, opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      >
        <div className="plugin-bottom__header">
          <div className="plugin-bottom__tabs">
            {bottomTabs.map(t => {
              const meta = metaOf(t.pluginId, t.panelId)
              if (!meta) return null
              const isActive = t.pluginId === active.pluginId && t.panelId === active.panelId
              return (
                <motion.button
                  key={`${t.pluginId}:${t.panelId}`}
                  className={`plugin-bottom__tab ${isActive ? 'plugin-bottom__tab--active' : ''}`}
                  onClick={() => setActive(t.pluginId, t.panelId)}
                  whileHover={{ backgroundColor: 'var(--overlay-3)' }}
                  whileTap={{ scale: 0.98 }}
                >
                  <AppIcon name={meta.icon as 'puzzle'} size="xs" />
                  <span className="plugin-bottom__tab-title">{meta.label}</span>
                  <span
                    className="plugin-bottom__tab-close"
                    onClick={(e) => { e.stopPropagation(); closeTab(t.pluginId, t.panelId) }}
                  >
                    <AppIcon name="x" size="xs" />
                  </span>
                </motion.button>
              )
            })}
          </div>
          <div className="plugin-bottom__actions">
            <button
              className="plugin-bottom__collapse"
              onClick={() => { for (const t of [...bottomTabs]) closeTab(t.pluginId, t.panelId) }}
              title="Свернуть панели плагинов"
            >
              <AppIcon name="chevronDown" size="xs" />
            </button>
          </div>
        </div>
        <div className="plugin-bottom__body">
          {bottomTabs.map(t => {
            const meta = metaOf(t.pluginId, t.panelId)
            if (!meta) return null
            const isActive = t.pluginId === active.pluginId && t.panelId === active.panelId
            return (
              <div
                key={`${t.pluginId}:${t.panelId}`}
                style={{ display: isActive ? 'block' : 'none', width: '100%', height: '100%' }}
              >
                <PluginIframe pluginId={t.pluginId} entry={meta.entry} title={meta.label} className="plugin-bottom__iframe" />
              </div>
            )
          })}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
