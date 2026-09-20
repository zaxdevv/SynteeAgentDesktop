import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, useMotionValue, animate, AnimatePresence } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import AppIcon from '../AppIcon/AppIcon'
import FileIcon from '../FileIcon/FileIcon'
import ResizeHandle from '../ResizeHandle/ResizeHandle'
import AgentPanel from '../AgentPanel/AgentPanel'
import FileExplorer from '../FileExplorer/FileExplorer'
import FileEditorPane from '../FileEditorPane/FileEditorPane'
import GitPanel from '../GitPanel/GitPanel'
import SessionChangesPanel from '../SessionChangesPanel/SessionChangesPanel'
import SideChatPanel from '../SideChatPanel/SideChatPanel'
import TerminalPanel from '../TerminalPanel/TerminalPanel'
import NotesPanel from '../NotesPanel/NotesPanel'
import ChartPreviewPanel from './ChartPreviewPanel'
import FileTabContextMenu from '../../layout/TitleBar/FileTabContextMenu'
import { useUIStore, type RightPanelTab, type BuiltinRightPanelTab, PLUGIN_TAB_PREFIX, buildPluginTabId, parsePluginTabId } from '../../../store/ui.store'
import { useRightPanelTabsStore } from '../../../store/rightPanelTabs.store'
import { useFileTabsStore } from '../../../store/fileTabs.store'
import { useExtensionsStore } from '../../../store/extensions.store'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import PluginIframe from '../PluginSlot/PluginIframe'
import type { PluginRuntime, PluginUiContribution } from '@shared/types/plugin'
import type { MenuPos } from '../../../utils/contextMenuPosition'
import './RightPanel.css'

export type { RightPanelTab }

interface RightPanelProps {
  open: boolean
  onClose: () => void
  focusAgentId?: string | null
  currentChatId?: string | null
}

// Все доступные панели для меню "+" (статичные встроенные).
const ALL_PANELS: Array<{ id: BuiltinRightPanelTab; label: string; icon: string; shortcut?: string }> = [
  { id: 'files', label: 'Файлы', icon: 'folder', shortcut: 'Ctrl+P' },
  { id: 'sidechat', label: 'Боковой чат', icon: 'messageSquare', shortcut: 'Ctrl+Alt+S' },
  { id: 'git', label: 'Проверка', icon: 'git', shortcut: 'Ctrl+Shift+G' },
  { id: 'terminal', label: 'Терминал', icon: 'terminal', shortcut: 'Ctrl+`' },
  { id: 'agents', label: 'Агенты', icon: 'git-branch' },
  { id: 'session', label: 'Сессия', icon: 'history' },
  { id: 'notes', label: 'Заметки', icon: 'fileText' },
  { id: 'chart', label: 'График', icon: 'chart' },
]

const PANEL_META: Record<BuiltinRightPanelTab, { label: string; icon: string }> = {
  files: { label: 'Файлы', icon: 'folder' },
  sidechat: { label: 'Чат', icon: 'messageSquare' },
  git: { label: 'Git', icon: 'git' },
  terminal: { label: 'Терминал', icon: 'terminal' },
  agents: { label: 'Агенты', icon: 'git-branch' },
  session: { label: 'Сессия', icon: 'history' },
  notes: { label: 'Заметки', icon: 'fileText' },
  chart: { label: 'График', icon: 'chart' },
}

function isRunningPlugin(p: PluginRuntime): boolean {
  return p.state.enabled && p.status === 'running'
}

/** Найти ui-вклад по полному id таба plugin:{pluginId}:{panelId} у запущенных плагинов. */
function findPluginContribution(plugins: PluginRuntime[], tabId: string): PluginUiContribution | null {
  const parsed = parsePluginTabId(tabId)
  if (!parsed) return null
  const p = plugins.find(x => x.id === parsed.pluginId && isRunningPlugin(x))
  if (!p) return null
  return p.ui.find(u => u.panelId === parsed.panelId) ?? null
}

function pluginEntryOf(p: PluginRuntime, c: PluginUiContribution): string {
  return c.entry ?? p.manifest.ui ?? 'index.html'
}

// Табы правой панели со slot 'right' у запущенных плагинов.
function collectPluginRightPanels(plugins: PluginRuntime[]): Array<{ id: string; label: string; icon: string; shortcut?: string }> {
  const items: Array<{ id: string; label: string; icon: string; shortcut?: string }> = []
  for (const p of plugins) {
    if (!isRunningPlugin(p)) continue
    for (const u of p.ui) {
      if (u.slot === 'right' && u.type === 'panel' && u.panelId) {
        items.push({
          id: buildPluginTabId(p.id, u.panelId),
          label: u.label,
          icon: u.icon || 'puzzle',
        })
      }
    }
  }
  return items
}

// Контент plugin-таба (keep-alive через mountedPanels).
function PluginRightPanelContent({ plugins, tabId }: { plugins: PluginRuntime[]; tabId: string }) {
  const parsed = parsePluginTabId(tabId)
  const c = findPluginContribution(plugins, tabId)
  if (!parsed || !c) return null
  const p = plugins.find(x => x.id === parsed.pluginId)
  if (!p) return null
  return (
    <PluginIframe
      pluginId={parsed.pluginId}
      entry={pluginEntryOf(p, c)}
      title={c.label}
      className="rp-plugin-frame"
    />
  )
}

export default function RightPanel({ open, onClose, focusAgentId, currentChatId }: RightPanelProps) {
  const tab = useUIStore(s => s.agentPanelTab)
  const setTab = useUIStore(s => s.setAgentPanelTab)
  const expanded = useUIStore(s => s.agentPanelExpanded)
  const setExpanded = useUIStore(s => s.setAgentPanelExpanded)
  const setAgentPanelWidth = useUIStore(s => s.setAgentPanelWidth)

  const { openPanels, openPanel, closePanel } = useRightPanelTabsStore(
    useShallow(s => ({ openPanels: s.openPanels, openPanel: s.openPanel, closePanel: s.closePanel }))
  )

  // Плагины (для plugin-табов правой панели) и их бейджи.
  const plugins = useExtensionsStore(s => s.plugins)
  const pluginsLoading = useExtensionsStore(s => s.pluginsLoading)
  const pluginBadges = usePluginPanelStore(s => s.badges)

  // Метаданные таба: для встроенных — из PANEL_META, для plugin:{pluginId}:{panelId} —
  // из ui-вкладов запущенных плагинов (label/icon), иначе null (вклад не валиден).
  const panelMeta = (kind: RightPanelTab): { label: string; icon: string } | null => {
    if (kind.startsWith(PLUGIN_TAB_PREFIX)) {
      const c = findPluginContribution(plugins, kind)
      return c ? { label: c.label, icon: c.icon || 'puzzle' } : null
    }
    return PANEL_META[kind as BuiltinRightPanelTab] ?? null
  }

  // Плагиновые панели со slot 'right' — пункты меню "+" и empty-state.
  const pluginPanels = useMemo(
    () => collectPluginRightPanels(plugins),
    [plugins],
  )

  // Если плагин выключен/удалён — вычищаем его табы из openPanels, иначе
  // пустой таб-хедер без контента висит до конца сессии (rpOpenPanels
  // персистится в settings и переживает перезапуск).
  useEffect(() => {
    // Ждём первую загрузку плагинов — иначе при boot-restore (rpOpenPanels из
    // settings) plugins ещё пуст и можно ошибочно вычистить валидные табы.
    if (pluginsLoading) return
    const rp = useRightPanelTabsStore.getState()
    const stale = rp.openPanels.filter(p => p.startsWith(PLUGIN_TAB_PREFIX) && !findPluginContribution(plugins, p))
    if (stale.length === 0) return
    for (const t of stale) rp.closePanel(t)
    // Если закрыли активный таб — переключаемся на оставшийся (или sidechat).
    const active = useUIStore.getState().agentPanelTab
    if (stale.includes(active)) {
      const ui = useUIStore.getState()
      const remaining = rp.openPanels.filter(p => !stale.includes(p))
      if (remaining.length > 0) {
        ui.setAgentPanelTab(remaining[0])
      } else {
        rp.openPanel('sidechat')
        ui.setAgentPanelTab('sidechat')
      }
    }
  }, [plugins, pluginsLoading])

  const [prevFocusAgentId, setPrevFocusAgentId] = useState<string | null>(null)
  const [workdir, setWorkdir] = useState<string | null>(null)
  const [contentReady, setContentReady] = useState(false)
  const [showPanelMenu, setShowPanelMenu] = useState(false)
  const [fileCtxMenu, setFileCtxMenu] = useState<{ tabId: string; pos: MenuPos } | null>(null)
  const [treeOpen, setTreeOpen] = useState(false)

  // Keep-alive: множество панелей, которые хотя бы раз были открыты.
  const [mountedPanels, setMountedPanels] = useState<Set<RightPanelTab>>(new Set())

  // Файловые табы
  const openFileTabs = useFileTabsStore(useShallow(s => s.openFileTabs))
  const activeFileTabId = useFileTabsStore(s => s.activeFileTabId)
  const closeFileTab = useFileTabsStore(s => s.closeFileTab)
  const setActiveFileTab = useFileTabsStore(s => s.setActiveFileTab)

  const menuRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)

  // Клик по карточке саб-агента → переключаем на 'agents'
  if (prevFocusAgentId !== focusAgentId) {
    setPrevFocusAgentId(focusAgentId ?? null)
    if (focusAgentId) {
      setTab('agents')
      openPanel('agents')
      setActiveFileTab(null)
    }
  }

  // Keep-alive: добавляем открытые панели в mountedPanels
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMountedPanels(prev => {
      const next = new Set(prev)
      for (const p of openPanels) next.add(p)
      return next
    })
  }, [openPanels])

  // contentReady — one-way flag
  useEffect(() => {
    if (open && !contentReady) {
      const timer = setTimeout(() => setContentReady(true), 150)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [open, contentReady])

  useEffect(() => {
    if (!currentChatId) return
    let cancelled = false
    window.syntee.fs.getWorkdir(currentChatId).then((wd: string | null) => {
      if (!cancelled) setWorkdir(wd)
    })
    return () => { cancelled = true }
  }, [currentChatId])

  // Открытие меню: считаем позицию от кнопки "+"
  const openMenu = useCallback(() => {
    const btn = addBtnRef.current
    if (btn) {
      const rect = btn.getBoundingClientRect()
      setMenuPos({ x: rect.left, y: rect.bottom + 4 })
    }
    setShowPanelMenu(true)
  }, [])

  // Закрытие меню по клику вне или Esc
  useEffect(() => {
    if (!showPanelMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowPanelMenu(false)
      }
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowPanelMenu(false) }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', onEsc)
    }
  }, [showPanelMenu])

  // ── Resize: motion value для drag ──
  const widthMV = useMotionValue(0)
  // Ref для остановки анимации при начале drag
  const animCtrlRef = useRef<ReturnType<typeof animate> | null>(null)
  // Флаг — идёт ли drag-resize (не реагируем на window resize во время drag)
  const isDraggingRef = useRef(false)

  // Адаптивный максимум: на больших окнах 60%, на маленьких 50%.
  // 70% было слишком много — панель перекрывала чат при сворачивании окна.
  const getMaxWidth = useCallback(() => {
    const w = window.innerWidth
    if (w < 900) return Math.floor(w * 0.5)
    if (w < 1200) return Math.floor(w * 0.55)
    return Math.min(Math.floor(w * 0.6), 1600)
  }, [])

  // Анимация open/close/expand — плавный tween (не spring, чтобы не лагало).
  // Drag-resize пишет в widthMV напрямую (мгновенно), анимация останавливается.
  useEffect(() => {
    // Останавливаем предыдущую анимацию
    animCtrlRef.current?.stop()
    if (!open) {
      // Закрытие — всегда схлопываем в 0 (даже если были expanded)
      animCtrlRef.current = animate(widthMV, 0, { duration: 0.18, ease: [0.4, 0, 1, 1] })
    } else if (expanded) {
      // Разворот на весь экран — анимируем ширину, чат плавно сжимается
      animCtrlRef.current = animate(widthMV, window.innerWidth, { duration: 0.22, ease: [0.4, 0, 0.2, 1] })
    } else {
      const w = useUIStore.getState().agentPanelWidth
      const maxW = getMaxWidth()
      const clamped = Math.min(w, maxW)
      animCtrlRef.current = animate(widthMV, clamped, { duration: 0.22, ease: [0.4, 0, 0.2, 1] })
    }
    return () => { animCtrlRef.current?.stop() }
  }, [open, expanded, widthMV, getMaxWidth])

  // ── Window resize: авто-подстройка ширины панели ──
  // При сворачивании/изменении размера окна — клампим widthMV чтобы панель
  // не перекрывала чат. Дебаунс 100мс чтобы не спамить во время drag.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (isDraggingRef.current) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!open) return
        // В expanded-режиме панель всегда ровно на всю ширину окна
        if (expanded) {
          widthMV.set(window.innerWidth)
          return
        }
        const current = widthMV.get()
        const maxW = getMaxWidth()
        if (current > maxW) {
          // Плавная анимация к новой ширине
          animCtrlRef.current?.stop()
          animCtrlRef.current = animate(widthMV, maxW, { duration: 0.2, ease: [0.4, 0, 0.2, 1] })
          // Сохраняем в store
          setAgentPanelWidth(maxW)
          window.syntee.settings.set('agentPanelWidth', maxW)
        }
      }, 100)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    }
  }, [open, expanded, widthMV, getMaxWidth, setAgentPanelWidth])

  const handleResize = useCallback((w: number) => {
    // Останавливаем анимацию при начале drag — пишем напрямую
    animCtrlRef.current?.stop()
    isDraggingRef.current = true
    const max = getMaxWidth()
    const clamped = Math.min(Math.max(Math.round(w), 280), max)
    widthMV.set(clamped)
  }, [widthMV, getMaxWidth])

  const handleResizeEnd = useCallback(() => {
    isDraggingRef.current = false
    const w = widthMV.get()
    setAgentPanelWidth(w)
    window.syntee.settings.set('agentPanelWidth', w)
  }, [widthMV, setAgentPanelWidth])

  // ── Активный файловый таб ──
  const activeFileTab = activeFileTabId
    ? openFileTabs.find(t => t.id === activeFileTabId) ?? null
    : null

  // ── Обработчики ──
  const handlePanelTabClick = (tId: RightPanelTab) => {
    setTab(tId)
    setActiveFileTab(null)
    window.syntee.settings.set('agentPanelTab', tId)
  }

  const handlePanelTabClose = (e: React.MouseEvent, kind: RightPanelTab) => {
    e.stopPropagation()
    closePanel(kind)
    if (tab === kind && !activeFileTabId) {
      const remaining = openPanels.filter(p => p !== kind)
      if (remaining.length > 0) {
        setTab(remaining[0])
        window.syntee.settings.set('agentPanelTab', remaining[0])
      } else if (openFileTabs.length > 0) {
        setActiveFileTab(openFileTabs[0].id)
      }
    }
  }

  const handleFileTabClick = (id: string) => {
    if (id === activeFileTabId) return
    setActiveFileTab(id)
  }

  const handleFileTabClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    closeFileTab(id)
  }

  const handleFileCtx = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setFileCtxMenu({ tabId, pos: { x: e.clientX, y: e.clientY } })
  }

  const handleAddPanel = (kind: RightPanelTab) => {
    openPanel(kind)
    setTab(kind)
    setActiveFileTab(null)
    window.syntee.settings.set('agentPanelTab', kind)
    setShowPanelMenu(false)
  }

  const handleExpand = () => {
    const next = !expanded
    setExpanded(next)
    window.syntee.settings.set('agentPanelExpanded', next)
  }

  // Скролл табов колесиком
  const handleTabsWheel = useCallback((e: React.WheelEvent) => {
    const el = tabsScrollRef.current
    if (!el) return
    el.scrollLeft += e.deltaY
  }, [])

  // Доступные панели для меню (не открытые): встроенные + правые табы плагинов.
  const availablePanels = useMemo(() => {
    const all = [
      ...ALL_PANELS.map(p => ({ ...p, id: p.id as RightPanelTab })),
      ...pluginPanels,
    ]
    return all.filter(p => !openPanels.includes(p.id))
  }, [openPanels, pluginPanels])

  // Нет ни одного таба — показываем empty state
  const noTabs = openPanels.length === 0 && openFileTabs.length === 0

  // ── HTML5 Drag-and-drop для табов ──
  const [dragTabId, setDragTabId] = useState<string | null>(null)

  const handleDragStart = (e: React.DragEvent, id: string, _isPanel: boolean) => {
    setDragTabId(id)
    e.dataTransfer.effectAllowed = 'move'
    // Необходимый фиктивный data для Firefox
    e.dataTransfer.setData('text/plain', id)
  }

  const handleDragOver = (e: React.DragEvent, id: string) => {
    if (dragTabId === null || dragTabId === id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = (e: React.DragEvent, dropId: string) => {
    e.preventDefault()
    if (dragTabId === null || dragTabId === dropId) return
    // Переставляем в unified списке
    const allItems: Array<{ id: string; isPanel: boolean; kind?: RightPanelTab; fileId?: string }> = [
      ...openPanels.map(p => ({ id: `panel:${p}`, isPanel: true, kind: p })),
      ...openFileTabs.map(t => ({ id: `file:${t.id}`, isPanel: false, fileId: t.id })),
    ]
    const fromIdx = allItems.findIndex(i => i.id === dragTabId)
    const toIdx = allItems.findIndex(i => i.id === dropId)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = allItems.splice(fromIdx, 1)
    allItems.splice(toIdx, 0, moved)
    // Разделяем обратно
    const newPanels = allItems.filter(i => i.isPanel).map(i => i.kind!) as RightPanelTab[]
    const newFileIds = allItems.filter(i => !i.isPanel).map(i => i.fileId!) as string[]
    if (newPanels.join(',') !== openPanels.join(',')) {
      useRightPanelTabsStore.getState().setPanels(newPanels)
    }
    if (newFileIds.length > 0 && newFileIds.join(',') !== openFileTabs.map(t => t.id).join(',')) {
      useFileTabsStore.getState().reorderFileTabs(newFileIds)
    }
    setDragTabId(null)
  }

  const handleDragEnd = () => setDragTabId(null)

  return (
    <motion.div
      className={`right-panel-wrapper ${open ? 'right-panel-wrapper--open' : ''} ${expanded ? 'right-panel-wrapper--expanded' : ''}`}
      style={{ width: widthMV }}
    >
      <div className="right-panel-inner">
        {!expanded && <ResizeHandle side="right" onResize={handleResize} onResizeEnd={handleResizeEnd} />}
        <div className="right-panel">
          {/* ── Header: единая полоса табов ── */}
          <div className="right-panel__header">
            <div className="right-panel__tabs" ref={tabsScrollRef} onWheel={handleTabsWheel}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1px', height: '100%' }}>
                {openPanels.map(kind => {
                  const meta = panelMeta(kind)
                  if (!meta) return null
                  const isActive = tab === kind && !activeFileTabId
                  const tabId = `panel:${kind}`
                  const badge = pluginBadges[kind]
                  return (
                    <div
                      key={kind}
                      className={`rp-tab ${isActive ? 'rp-tab--active' : ''} ${dragTabId === tabId ? 'rp-tab--dragging' : ''}`}
                      onClick={() => handlePanelTabClick(kind)}
                      draggable
                      onDragStart={(e) => handleDragStart(e, tabId, true)}
                      onDragOver={(e) => handleDragOver(e, tabId)}
                      onDrop={(e) => handleDrop(e, tabId)}
                      onDragEnd={handleDragEnd}
                    >
                      <AppIcon name={meta.icon as 'folder'} size="xs" />
                      <span>{meta.label}</span>
                      {typeof badge === 'number' && (
                        <span className="rp-tab__badge">{badge > 99 ? '99+' : badge}</span>
                      )}
                      <button
                        className="rp-tab__close"
                        onPointerDown={e => e.stopPropagation()}
                        onClick={(e) => handlePanelTabClose(e, kind)}
                        title="Закрыть"
                      >
                        <AppIcon name="x" size="xs" />
                      </button>
                    </div>
                  )
                })}

                {openFileTabs.map(ft => {
                  const isActive = ft.id === activeFileTabId
                  const tabId = `file:${ft.id}`
                  return (
                    <div
                      key={ft.id}
                      className={`rp-tab rp-tab--file ${isActive ? 'rp-tab--active' : ''} ${dragTabId === tabId ? 'rp-tab--dragging' : ''}`}
                      onClick={() => handleFileTabClick(ft.id)}
                      onContextMenu={e => handleFileCtx(e, ft.id)}
                      onMouseDown={(e: React.MouseEvent) => { if (e.button === 1) e.preventDefault() }}
                      onAuxClick={(e: React.MouseEvent) => {
                        e.preventDefault()
                        if (e.button === 1) { e.stopPropagation(); closeFileTab(ft.id) }
                      }}
                      title={ft.relPath}
                      draggable
                      onDragStart={(e) => handleDragStart(e, tabId, false)}
                      onDragOver={(e) => handleDragOver(e, tabId)}
                      onDrop={(e) => handleDrop(e, tabId)}
                      onDragEnd={handleDragEnd}
                    >
                      <FileIcon name={ft.name} size={12} />
                      <span>{ft.name}</span>
                      {ft.dirty ? (
                        <span className="rp-tab__dirty" title="Несохранённые изменения" />
                      ) : ft.conflict ? (
                        <span className="rp-tab__conflict" title="Файл изменён внешне" />
                      ) : null}
                      <button
                        className="rp-tab__close"
                        onPointerDown={e => e.stopPropagation()}
                        onClick={(e) => handleFileTabClose(e, ft.id)}
                        title="Закрыть"
                      >
                        <AppIcon name="x" size="xs" />
                      </button>
                    </div>
                  )
                })}
              </div>

              {/* + button */}
              <div className="rp-tab-add-wrap">
                <button
                  ref={addBtnRef}
                  className="rp-tab-add"
                  onClick={() => showPanelMenu ? setShowPanelMenu(false) : openMenu()}
                  title="Открыть панель"
                >
                  <AppIcon name="plus" size="xs" />
                </button>
              </div>
            </div>

            {/* Action buttons */}
            <div className="right-panel__actions">
              <button
                className="rp-action-btn"
                onClick={handleExpand}
                title={expanded ? 'Свернуть панель' : 'Развернуть на весь экран'}
              >
                <AppIcon name={(expanded ? 'minimize' : 'maximize') as 'maximize'} size="xs" />
              </button>
              <button
                className="rp-action-btn"
                onClick={onClose}
                title="Закрыть панель"
              >
                <AppIcon name="x" size="xs" />
              </button>
            </div>
          </div>

          {/* ── Content ── */}
          <div className="right-panel__content">
            <div className="right-panel__content-fade">
              {contentReady && (
                <>
                  {noTabs ? (
                    <div className="rp-empty-state">
                      <p className="rp-empty-title">Открыть панель</p>
                      <div className="rp-empty-panels">
                        {[...ALL_PANELS, ...pluginPanels].map(p => (
                          <button
                            key={p.id}
                            className="rp-empty-panel-btn"
                            onClick={() => handleAddPanel(p.id)}
                          >
                            <AppIcon name={p.icon as 'folder'} size="sm" />
                            <span>{p.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : activeFileTab ? (
                    /* File view: редактор слева + tree справа */
                    <div className="rp-file-view">
                      <div className="rp-file-view__editor" style={{ display: 'flex', flex: 1, minWidth: 0 }}>
                        <FileEditorPane
                          key={activeFileTab.id}
                          tab={activeFileTab}
                          treeOpen={treeOpen}
                          onToggleTree={() => setTreeOpen(v => !v)}
                        />
                      </div>
                      <AnimatePresence initial={false}>
                        {treeOpen && (
                          <motion.div
                            className="rp-tree-sidebar"
                            initial={{ width: 0 }}
                            animate={{ width: 220 }}
                            exit={{ width: 0 }}
                            transition={{ duration: 0.18, ease: 'easeOut' }}
                            style={{ overflow: 'hidden', flexShrink: 0 }}
                          >
                            <FileExplorer key={workdir ?? 'no-workdir'} workdir={workdir} />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  ) : (
                    Array.from(mountedPanels).map(panelKind => (
                      <div
                        key={panelKind}
                        className="right-panel__tab-content"
                        style={{ display: tab === panelKind ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}
                      >
                        {panelKind === 'agents' && (
                          <AgentPanel focusAgentId={focusAgentId} currentChatId={currentChatId} isVisible={tab === 'agents'} />
                        )}
                        {panelKind === 'sidechat' && (
                          <SideChatPanel currentChatId={currentChatId ?? null} />
                        )}
                        {panelKind === 'files' && (
                          <FileExplorer key={workdir ?? 'no-workdir'} workdir={workdir} />
                        )}
                        {panelKind === 'git' && (
                          <GitPanel key={workdir ?? 'no-workdir'} workdir={workdir} />
                        )}
                        {panelKind === 'session' && (
                          <SessionChangesPanel key={currentChatId ?? 'no-chat'} chatId={currentChatId} />
                        )}
                        {panelKind === 'terminal' && (
                          <TerminalPanel currentChatId={currentChatId} />
                        )}
                        {panelKind === 'notes' && (
                          <NotesPanel currentChatId={currentChatId ?? null} />
                        )}
                        {panelKind === 'chart' && (
                          <ChartPreviewPanel />
                        )}
                        {panelKind.startsWith(PLUGIN_TAB_PREFIX) && (
                          <PluginRightPanelContent plugins={plugins} tabId={panelKind} />
                        )}
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <FileTabContextMenu
        tabId={fileCtxMenu?.tabId ?? null}
        pos={fileCtxMenu?.pos ?? null}
        onClose={() => setFileCtxMenu(null)}
        tabsCount={openFileTabs.length}
      />


      {/* Panel menu через portal — не обрезается overflow */}
      {showPanelMenu && menuPos && createPortal(
        <div ref={menuRef} style={{ position: 'fixed', left: menuPos.x, top: menuPos.y, zIndex: 9999 }}>
          <AnimatePresence>
            <motion.div
              className="rp-panel-menu"
              initial={{ opacity: 0, y: -4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.97 }}
              transition={{ duration: 0.12 }}
            >
              {availablePanels.length === 0 ? (
                <div className="rp-panel-menu__empty">Все панели открыты</div>
              ) : (
                availablePanels.map(p => (
                  <button
                    key={p.id}
                    className="rp-panel-menu__item"
                    onClick={() => handleAddPanel(p.id)}
                  >
                    <AppIcon name={p.icon as 'folder'} size="xs" />
                    <span>{p.label}</span>
                    {p.shortcut && <span className="rp-panel-menu__shortcut">{p.shortcut}</span>}
                  </button>
                ))
              )}
            </motion.div>
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </motion.div>
  )
}
