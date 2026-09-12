/**
 * PluginStatusBar — тонкая полоса внизу главного окна с элементами плагинов
 * (как status bar в VS Code). Источник — pluginPanel.store.statusbarByPlugin,
 * который заполняется push'ем 'plugins:statusbar' (снапшот на плагин).
 *
 * Элементы выстраиваются справа. Клик по элементу с command выполняет
 * команду плагина (plugins:executeCommand) в текущем активном чате.
 * Если элементов нет — компонент не рендерится (zero-height).
 */
import { useMemo } from 'react'
import { selectStatusbarItems, usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useExtensionsStore } from '../../../store/extensions.store'
import { useChatStore } from '../../../store/chat.store'
import './PluginStatusBar.css'

export default function PluginStatusBar(): JSX.Element | null {
  const plugins = useExtensionsStore(s => s.plugins)
  const items = usePluginPanelStore(selectStatusbarItems)

  // Оставляем только элементы запущенных включённых плагинов — выключенные
  // (или ещё не подгрузившиеся в стор) не должны висеть в статус-баре.
  const visible = useMemo(() => {
    return items.filter(it => {
      const p = plugins.find(x => x.id === it.pluginId)
      return p && p.state.enabled && p.status === 'running'
    })
  }, [items, plugins])

  if (visible.length === 0) return null

  const runCommand = (item: (typeof visible)[number]) => {
    if (!item.command) return
    const chatId = useChatStore.getState().currentChatId ?? ''
    window.syntee.plugins.executeCommand({
      chatId,
      pluginId: item.pluginId,
      name: item.command,
      args: '',
      text: `/${item.command}`,
    }).catch((e: unknown) => {
      console.warn('[PluginStatusBar] executeCommand failed', e)
    })
  }

  return (
    <div className="plugin-statusbar">
      {visible.map(it => {
        const tooltip = it.tooltip ?? (it.command ? `Выполнить /${it.command}` : undefined)
        if (it.command) {
          return (
            <button
              key={`${it.pluginId}:${it.id}`}
              className="plugin-statusbar__item plugin-statusbar__item--cmd"
              title={tooltip}
              onClick={() => runCommand(it)}
            >
              <span className="plugin-statusbar__dot" />
              <span className="plugin-statusbar__text">{it.text}</span>
            </button>
          )
        }
        return (
          <div key={`${it.pluginId}:${it.id}`} className="plugin-statusbar__item" title={tooltip}>
            <span className="plugin-statusbar__dot" />
            <span className="plugin-statusbar__text">{it.text}</span>
          </div>
        )
      })}
    </div>
  )
}
