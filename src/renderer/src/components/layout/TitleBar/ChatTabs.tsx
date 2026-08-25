import { useState, useRef, useCallback, useEffect } from 'react'
import { Reorder, motion } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import FileIcon from '../../ui/FileIcon/FileIcon'
import ChatTabContextMenu from './ChatTabContextMenu'
import FileTabContextMenu from './FileTabContextMenu'
import { useChatStore } from '../../../store/chat.store'
import { useNavStore } from '../../../store/nav.store'
import { useTabsStore, tabActions } from '../../../store/tabs.store'
import { useFileTabsStore } from '../../../store/fileTabs.store'
import type { MenuPos } from '../../../utils/contextMenuPosition'
import type { Chat } from '../../../../../shared/types'
import { springHover, whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny } from '../../../utils/motionPresets'

// ── Полоса вкладок чатов в шапке ───────────────────────────────────────
// Табы чатов — переключение по клику, drag&drop для перестановки,
// закрытие крестиком или средней кнопкой мыши, контекстное меню.
// Файловые табы перенесены в правую панель (RightPanel).

export default function ChatTabs() {
  // ── Chat tabs ──
  const openTabIds = useTabsStore(s => s.openTabIds)
  const reorderTabs = useTabsStore(s => s.reorderTabs)
  const closeTab = useTabsStore(s => s.closeTab)
  const chats = useChatStore(s => s.chats)
  const currentChatId = useChatStore(s => s.currentChatId)
  const runStatusByChat = useChatStore(s => s.runStatusByChat)
  const splitChatId = useChatStore(s => s.splitChatId)
  const setSplitChat = useChatStore(s => s.setSplitChat)
  const [ctxMenu, setCtxMenu] = useState<{ chat: Chat; pos: MenuPos } | null>(null)

  // ── File tabs (в той же полосе, тот же стиль) ──
  const openFileTabs = useFileTabsStore(s => s.openFileTabs)
  const activeFileTabId = useFileTabsStore(s => s.activeFileTabId)
  const reorderFileTabs = useFileTabsStore(s => s.reorderFileTabs)
  const closeFileTab = useFileTabsStore(s => s.closeFileTab)
  const setActiveFileTab = useFileTabsStore(s => s.setActiveFileTab)
  const [fileCtxMenu, setFileCtxMenu] = useState<{ tabId: string; pos: MenuPos } | null>(null)

  // Значения Reorder.Group должны 1:1 соответствовать Reorder.Item —
  // фильтруем вкладки без живого чата (гонка удаления/переименования).
  const chatById = new Map(chats.map(c => [c.id, c]))
  const tabIds = openTabIds.filter(id => chatById.has(id))
  const fileTabIds = openFileTabs.map(t => t.id)

  const handleClose = (id: string) => {
    const neighbor = closeTab(id)
    if (id === currentChatId && neighbor) {
      useNavStore.getState().setMainPage('chat')
      tabActions.selectChat?.(neighbor)
    }
  }

  // Клик по вкладке чата — переключаем чат.
  const handleSelect = (id: string) => {
    useFileTabsStore.getState().setActiveFileTab(null)
    if (id === currentChatId) return
    useNavStore.getState().setMainPage('chat')
    tabActions.selectChat?.(id)
  }

  const handleCreate = () => {
    useNavStore.getState().setMainPage('chat')
    tabActions.createInContext?.()
  }

  const handleCtx = (e: React.MouseEvent, chat: Chat) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ chat, pos: { x: e.clientX, y: e.clientY } })
  }

  const splitChat = splitChatId ? chatById.get(splitChatId) : undefined

  // ── Кастомный скроллбар + горизонтальный скролл колесиком ──
  const tabsRef = useRef<HTMLDivElement>(null)
  const [scrollThumb, setScrollThumb] = useState<{ left: number; width: number } | null>(null)

  const updateScrollbar = useCallback(() => {
    const el = tabsRef.current
    if (!el) return
    const { scrollWidth, clientWidth, scrollLeft } = el
    if (scrollWidth <= clientWidth) {
      setScrollThumb(null)
      return
    }
    // Скроллбар-трек имеет padding 8px с каждой стороны (left:8, right:8)
    const trackWidth = clientWidth - 16
    const ratio = clientWidth / scrollWidth
    const width = Math.max(20, ratio * trackWidth)
    const left = (scrollLeft / (scrollWidth - clientWidth)) * (trackWidth - width)
    setScrollThumb({ left, width })
  }, [])

  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    updateScrollbar()
    // Нативный scroll-listener — надёжнее React onScroll (срабатывает при
    // программном scrollLeft += ... из handleWheel)
    const onScroll = () => updateScrollbar()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(updateScrollbar)
    ro.observe(el)
    const mo = new MutationObserver(updateScrollbar)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      mo.disconnect()
    }
  }, [updateScrollbar, tabIds.length])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const el = tabsRef.current
    if (!el) return
    el.scrollLeft += e.deltaY
  }, [])

  return (
    <div className="titlebar-tabs-wrap drag-region">
    <div className="titlebar-tabs" ref={tabsRef} onWheel={handleWheel}>
      {/* ── Табы чатов ── */}
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
          const active = id === currentChatId && !activeFileTabId
          return (
            <Reorder.Item
              as="div"
              key={id}
              value={id}
              className={`titlebar-tab no-drag ${active ? 'titlebar-tab--active' : ''}`}
              onClick={() => handleSelect(id)}
              onContextMenu={e => handleCtx(e, chat)}
              onMouseDown={(e: React.MouseEvent) => {
                if (e.button === 1) e.preventDefault() // подавить автоскролл
              }}
              onAuxClick={(e: React.MouseEvent) => {
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
              {tabIds.length > 1 && (
                <motion.button
                  className="titlebar-tab-close"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); handleClose(id) }}
                  title="Закрыть вкладку"
                  whileHover={whileHoverTiny}
                  whileTap={whileTapTiny}
                  transition={springHover}
                >
                  <AppIcon name="x" size="xs" />
                </motion.button>
              )}
            </Reorder.Item>
          )
        })}
      </Reorder.Group>

      <motion.button
        type="button"
        className="titlebar-tab-add no-drag"
        onClick={handleCreate}
        title="Новый чат"
        whileHover={whileHoverSm}
        whileTap={whileTapSm}
        transition={springHover}
      >
        <AppIcon name="plus" size="sm" />
      </motion.button>

      {/* ── Табы файлов — в той же полосе, тот же стиль (titlebar-tab) ── */}
      {fileTabIds.length > 0 && (
        <Reorder.Group
          as="div"
          axis="x"
          values={fileTabIds}
          onReorder={reorderFileTabs}
          className="titlebar-tabs-list"
        >
          {openFileTabs.map(tab => {
            const active = tab.id === activeFileTabId
            return (
              <Reorder.Item
                as="div"
                key={tab.id}
                value={tab.id}
                className={`titlebar-tab no-drag ${active ? 'titlebar-tab--active' : ''}`}
                onClick={() => handleFileSelect(tab.id)}
                onContextMenu={e => handleFileCtx(e, tab.id)}
                onMouseDown={(e: React.MouseEvent) => {
                  if (e.button === 1) e.preventDefault() // подавить автоскролл
                }}
                onAuxClick={(e: React.MouseEvent) => {
                  e.preventDefault()
                  if (e.button === 1) handleFileClose(tab.id)
                }}
                title={tab.relPath}
                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              >
                <FileIcon name={tab.name} size={14} />
                <span className="titlebar-tab-title">{tab.name}</span>
                {/* Dirty indicator — точка для несохранённых правок */}
                {tab.dirty && (
                  <span className="titlebar-tab-dirty" title="Несохранённые изменения" />
                )}
                {/* Conflict indicator — жёлтая точка */}
                {tab.conflict && !tab.dirty && (
                  <span className="titlebar-tab-conflict" title="Файл изменён внешне" />
                )}
                <motion.button
                  className="titlebar-tab-close"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); handleFileClose(tab.id) }}
                  title="Закрыть"
                  whileHover={whileHoverTiny}
                  whileTap={whileTapTiny}
                  transition={springHover}
                >
                  <AppIcon name="x" size="xs" />
                </motion.button>
              </Reorder.Item>
            )
          })}
        </Reorder.Group>
      )}

      {/* Чип сплит-чата: виден пока открыта вторая половина экрана.
          Крестик закрывает сплит (вкладка чата остаётся). */}
      {splitChat && (() => {
        const splitStatus = runStatusByChat[splitChat.id]?.status
        const splitRunning = splitStatus === 'running' || splitStatus === 'queued'
        return (
        <div className="titlebar-split-chip no-drag" title={`Сплит: ${splitChat.title}`}>
          <AppIcon name="columns" size="xs" tone="accent" />
          {splitRunning ? (
            <span className="titlebar-tab-spinner" title={splitStatus === 'queued' ? 'В очереди' : 'Работает'} />
          ) : (
            splitChat.color && <span className="titlebar-tab-color" style={{ background: splitChat.color }} />
          )}
          <span className="titlebar-split-chip-title">{splitChat.title}</span>
          <motion.button
            className="titlebar-tab-close titlebar-split-chip-close"
            onClick={() => setSplitChat(null)}
            title="Закрыть сплит"
            whileHover={whileHoverTiny}
            whileTap={whileTapTiny}
            transition={springHover}
          >
            <AppIcon name="x" size="xs" />
          </motion.button>
        </div>
        )
      })()}

      <ChatTabContextMenu
        chat={ctxMenu?.chat ?? null}
        pos={ctxMenu?.pos ?? null}
        onClose={() => setCtxMenu(null)}
        onSelectChat={handleSelect}
        onCloseTab={handleClose}
        tabsCount={tabIds.length}
      />

      {/* Кастомный скроллбар-индикатор (без стрелок, тонкий) — OUTSIDE скролл-контейнера */}
      {scrollThumb && (
        <div className="titlebar-tabs-scrollbar">
          <div
            className="titlebar-tabs-scrollbar-thumb"
            style={{ left: `${scrollThumb.left}px`, width: `${scrollThumb.width}px` }}
          />
        </div>
      )}
    </div>
    </div>
  )
}
