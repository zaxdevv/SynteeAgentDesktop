import { Reorder } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { useChatStore } from '../../../store/chat.store'
import { useNavStore } from '../../../store/nav.store'
import { useTabsStore, tabActions } from '../../../store/tabs.store'

// Вкладки открытых чатов в шапке — как в браузере: переключение по клику,
// drag&drop для перестановки (Reorder из framer-motion, прецедент —
// QueuePanel), закрытие крестиком или средней кнопкой мыши.
// Данные чатов — из chat.store, порядок вкладок — из tabs.store, действия
// (select/create) — через tabActions (мост в ChatPage, который keep-alive).
// no-drag на вкладках и «+»: шапка — drag-region окна, без no-drag клики
// не дошли бы до renderer. Пустое место полосы остаётся drag-зоной.
export default function ChatTabs() {
  const openTabIds = useTabsStore(s => s.openTabIds)
  const reorderTabs = useTabsStore(s => s.reorderTabs)
  const closeTab = useTabsStore(s => s.closeTab)
  const chats = useChatStore(s => s.chats)
  const currentChatId = useChatStore(s => s.currentChatId)
  const runStatusByChat = useChatStore(s => s.runStatusByChat)

  // Значения Reorder.Group должны 1:1 соответствовать Reorder.Item —
  // фильтруем вкладки без живого чата (гонка удаления/переименования).
  const chatById = new Map(chats.map(c => [c.id, c]))
  const tabIds = openTabIds.filter(id => chatById.has(id))

  const handleClose = (id: string) => {
    const neighbor = closeTab(id)
    // Закрыли активную — переключаемся на соседнюю (правая, иначе левая).
    if (id === currentChatId && neighbor) {
      useNavStore.getState().setMainPage('chat')
      tabActions.selectChat?.(neighbor)
    }
  }

  // Клик по вкладке / «+» из любой страницы (настройки, мессенджер) —
  // возвращаем на страницу чата, иначе переключение было бы не видно.
  const handleSelect = (id: string) => {
    if (id === currentChatId) return
    useNavStore.getState().setMainPage('chat')
    tabActions.selectChat?.(id)
  }

  // «+» — новый чат в контексте текущего (чат проекта → чат в том же проекте).
  const handleCreate = () => {
    useNavStore.getState().setMainPage('chat')
    tabActions.createInContext?.()
  }

  return (
    <div className="titlebar-tabs">
      <Reorder.Group
        as="div"
        axis="x"
        values={tabIds}
        onReorder={reorderTabs}
        className="titlebar-tabs-list"
      >
        {tabIds.map(id => {
          const chat = chatById.get(id)!
          const status = runStatusByChat[id]?.status
          const running = status === 'running' || status === 'queued'
          const active = id === currentChatId
          return (
            <Reorder.Item
              as="div"
              key={id}
              value={id}
              className={`titlebar-tab no-drag ${active ? 'titlebar-tab--active' : ''}`}
              onClick={() => handleSelect(id)}
              onAuxClick={(e: React.MouseEvent) => {
                // Средняя кнопка — закрытие, как в браузере.
                // preventDefault — не дать Chromium включить auto-scroll.
                e.preventDefault()
                if (e.button === 1 && tabIds.length > 1) handleClose(id)
              }}
              title={chat.title}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            >
              {running ? (
                <span className="titlebar-tab-spinner" title={status === 'queued' ? 'В очереди' : 'Работает'} />
              ) : (
                chat.color && <span className="titlebar-tab-color" style={{ background: chat.color }} />
              )}
              <span className="titlebar-tab-title">{chat.title}</span>
              {/* Последнюю вкладку закрыть нельзя — всегда есть хотя бы одна. */}
              {tabIds.length > 1 && (
                <button
                  className="titlebar-tab-close"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); handleClose(id) }}
                  title="Закрыть вкладку"
                >
                  <AppIcon name="x" size="xs" />
                </button>
              )}
            </Reorder.Item>
          )
        })}
      </Reorder.Group>
      <button
        type="button"
        className="titlebar-tab-add no-drag"
        onClick={handleCreate}
        title="Новый чат"
      >
        <AppIcon name="plus" size="sm" />
      </button>
    </div>
  )
}
