/**
 * PluginSidebarSlots — декларативные UI-вклады плагинов в слот 'sidebar'
 * (низ сайдбара, над кнопкой «Расширения»).
 *
 * type='button' → выполняет команду плагина (registerCommand) — результат
 *                показывается тостом (короткий) или открывает панель.
 * type='panel'  → открывает iframe-панель кастомного UI плагина.
 *
 * Данные — extensions.store.plugins (ui-вклады приходят из запущенных
 * плагинов). Клик по кнопке типа 'button' выполняет команду и показывает
 * результат тостом.
 */
import './PluginSidebarSlots.css'
import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { useExtensionsStore } from '../../../store/extensions.store'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useToast } from '../Toast/Toast'

export default function PluginSidebarSlots(): JSX.Element | null {
  const plugins = useExtensionsStore(s => s.plugins)
  const openPanel = usePluginPanelStore(s => s.openPanel)
  const openPluginTab = usePluginPanelStore(s => s.openPluginTab)
  const openPluginPage = usePluginPanelStore(s => s.openPluginPage)
  const closePluginPage = usePluginPanelStore(s => s.closePluginPage)
  const openPluginBottomTab = usePluginPanelStore(s => s.openPluginBottomTab)
  const closePluginBottomTab = usePluginPanelStore(s => s.closePluginBottomTab)
  const openPluginModal = usePluginPanelStore(s => s.openPluginModal)
  const closePluginModal = usePluginPanelStore(s => s.closePluginModal)
  const bottomTabs = usePluginPanelStore(s => s.bottomTabs)
  const activePage = usePluginPanelStore(s => s.activePage)
  const toast = useToast(s => s.add)

  // Собираем UI-вклады из запущенных включённых плагинов. В одном ряду
  // показываем sidebar-, right-, page-, bottom- и modal-кнопки; различие
  // только в обработчике:
  //   right + panel   → таб правой панели (openPluginTab)
  //   page + panel    → полноэкранная страница (openPluginPage)
  //   bottom + panel  → таб нижнего дока (openPluginBottomTab)
  //   modal + panel   → модальная панель (openPluginModal)
  //   sidebar + panel → legacy модальная панель (openPanel)
  //   button          → выполнить команду плагина
  const contributions = plugins
    .filter(p => p.state.enabled && p.status === 'running')
    .flatMap(p => p.ui.map(u => ({ ...u, pluginName: p.manifest.name })))

  if (contributions.length === 0) return null

  const handleClick = async (c: (typeof contributions)[number]) => {
    if (c.type === 'panel') {
      if (c.slot === 'right' && c.panelId) {
        openPluginTab(c.pluginId, c.panelId, c.label)
        return
      }
      if (c.slot === 'page' && c.panelId) {
        const isOpen = activePage?.pluginId === c.pluginId && activePage?.panelId === c.panelId
        if (isOpen) closePluginPage()
        else openPluginPage(c.pluginId, c.panelId)
        return
      }
      if (c.slot === 'bottom' && c.panelId) {
        const isOpen = bottomTabs.some(t => t.pluginId === c.pluginId && t.panelId === c.panelId)
        if (isOpen) closePluginBottomTab(c.pluginId, c.panelId)
        else openPluginBottomTab(c.pluginId, c.panelId)
        return
      }
      if (c.slot === 'modal' && c.panelId) {
        const modal = usePluginPanelStore.getState().modal
        const isOpen = modal?.pluginId === c.pluginId
        if (isOpen) closePluginModal()
        else openPluginModal({ pluginId: c.pluginId, title: `${c.label} · ${c.pluginName}`, entry: c.entry })
        return
      }
      openPanel(c.pluginId, `${c.label} · ${c.pluginName}`)
      return
    }
    // button → выполняем команду плагина, результат — тостом
    // (короткий показ целиком, длинный обрезаем).
    try {
      const res = await window.syntee.plugins.executeCommand({
        chatId: '',
        pluginId: c.pluginId,
        name: c.command ?? '',
        args: '',
        text: `/${c.command ?? ''}`,
      }) as { ok: boolean; output?: string; error?: string }
      const text = res.ok
        ? (res.output || 'Готово')
        : `Ошибка: ${res.error ?? 'неизвестно'}`
      toast(text.slice(0, 300), res.ok ? 'success' : 'error')
    } catch (e) {
      toast(`Ошибка: ${(e as Error).message}`, 'error')
    }
  }

  return (
    <div className="plugin-slots">
      {contributions.map((c, i) => (
        <motion.button
          key={`${c.pluginId}-${c.label}-${i}`}
          type="button"
          className="plugin-slot-btn"
          title={`${c.label} · ${c.pluginName}`}
          onClick={() => handleClick(c)}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
        >
          <AppIcon name={c.icon || 'puzzle'} size="xs" />
          <span className="plugin-slot-btn-label">{c.label}</span>
        </motion.button>
      ))}
    </div>
  )
}
