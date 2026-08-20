import { useState, useEffect, useLayoutEffect, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { Chat, Project, Message } from '../../../../../shared/types'
import AppIcon from '../../ui/AppIcon/AppIcon'
import IconButton from '../../ui/IconButton/IconButton'
import ChatContextMenu, { type ContextMenuPos } from '../../ui/ChatContextMenu/ChatContextMenu'
import ExtensionsPopover from '../../ui/ExtensionsPopover/ExtensionsPopover'
import { ProjectIndexModal } from '../../ui/ProjectIndexModal/ProjectIndexModal'
import ShareChatModal from '../../ui/ShareChatModal/ShareChatModal'
import UserCard from './UserCard'
import { useChatStore } from '../../../store/chat.store'
import { useTabsStore } from '../../../store/tabs.store'
import { getContextMenuPosition } from '../../../utils/contextMenuPosition'
import { springHover, whileHoverTiny, whileTapTiny, whileHoverWide, whileTapWide, whileHoverSm, whileTapSm } from '../../../utils/motionPresets'
import './Sidebar.css'

interface SidebarProps {
  chats?: Chat[]
  projects?: Project[]
  activeProjectId?: string | null
  currentChatId?: string | null
  onSelectChat?: (id: string) => void
  onNewChat?: (projectId?: string) => void
  onNewChatWithoutProject?: () => void
  onNewProject?: (mode: 'empty' | 'existing') => void
  onChatsUpdate?: (chats: Chat[]) => void
  onProjectsUpdate?: (projects: Project[]) => void
  onSelectProject?: (id: string | null) => void
  /** Вызывается после установки MCP/Skill через маркетплейс — открывает новый чат установки. */
  onExtensionInstalled?: (chatId: string, projectId: string | undefined, userMsg: Message) => void
}

type ChatFilter = 'all' | 'favorites' | 'archive'

const CHAT_FILTERS: { value: ChatFilter; label: string }[] = [
  { value: 'all', label: 'Все чаты' },
  { value: 'favorites', label: 'Избранные' },
  { value: 'archive', label: 'Архив' },
]

function formatTime(ts: number): string {
  if (!ts || ts < 1000000) return ''
  const now = Date.now()
  const diff = now - ts
  const D = 86400000
  if (diff < D) return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  if (diff < 7 * D) return new Date(ts).toLocaleDateString('ru', { weekday: 'short' })
  return new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
}

function cleanPreview(text: string | undefined): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, '[код]')
    .replace(/`[^`]+`/g, '[код]')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 60)
}

function shortWorkdir(workdir: string): string {
  const segs = workdir.split(/[\\/]/).filter(Boolean)
  if (segs.length <= 2) return segs.join(' / ')
  return '… / ' + segs.slice(-2).join(' / ')
}

// memo: ChatPage ре-рендерится ~20×/сек при стриминге и на каждый
// scroll-range-change виртуализатора — без memo Sidebar (806 строк JSX,
// весь список чатов) перерисовывался бы каждый раз. Пропсы стабилизированы
// в ChatPage (useCallback-хендлеры, store-refs).
function Sidebar({
  chats = [],
  projects = [],
  activeProjectId = null,
  currentChatId,
  onSelectChat,
  onNewChat,
  onNewChatWithoutProject,
  onNewProject,
  onChatsUpdate,
  onProjectsUpdate,
  onSelectProject,
  onExtensionInstalled,
}: SidebarProps) {
  const [search, setSearch] = useState('')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  // Скрытые проекты (по id) — чаты этих проектов не показываются в списке.
  // '__noproject__' — чаты без project_id. Пустой set = показать все.
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(new Set())
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false)
  const filterPopoverRef = useRef<HTMLDivElement>(null)
  const filterToggleRef = useRef<HTMLButtonElement>(null)
  const [filterPopoverPos, setFilterPopoverPos] = useState<{ top: number; left: number; right: number } | null>(null)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ chat: Chat; pos: ContextMenuPos } | null>(null)
  const [projectCtxMenu, setProjectCtxMenu] = useState<{ project: Project; pos: ContextMenuPos } | null>(null)
  const projectCtxRef = useRef<HTMLDivElement>(null)
  const [newProjectMenu, setNewProjectMenu] = useState<ContextMenuPos | null>(null)
  const newProjectMenuRef = useRef<HTMLDivElement>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renameProjectVal, setRenameProjectVal] = useState('')
  const [editingVerifyCmdId, setEditingVerifyCmdId] = useState<string | null>(null)
  const [verifyCmdVal, setVerifyCmdVal] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const renameProjectRef = useRef<HTMLInputElement>(null)
  const verifyCmdRef = useRef<HTMLInputElement>(null)
  const [extPopoverOpen, setExtPopoverOpen] = useState(false)
  const [indexModalProject, setIndexModalProject] = useState<{ id: string; name: string } | null>(null)
  const [shareTarget, setShareTarget] = useState<{ id: string; title: string } | null>(null)
  // Модалка удаления проекта: хранит проект + состояние чекбокса «удалить чаты».
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [deleteProjectWithChats, setDeleteProjectWithChats] = useState(false)
  // Мультивыбор чатов через Shift+клик. Эфемерный UI-state — только сайдбар.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkExportOpen, setBulkExportOpen] = useState(false)
  const bulkExportRef = useRef<HTMLDivElement>(null)

  // Статусы запусков чатов для индикаторов (spinner/✓/✗). Подписываемся на
  // весь объект — Sidebar не большой, ре-рендер недорогой. Альтернатива
  // (useSyncExternalStore + selector на каждый chatId) усложняет код.
  const runStatusByChat = useChatStore(s => s.runStatusByChat)
  const unreadStatusByChat = useChatStore(s => s.unreadStatusByChat)
  const dropChatState = useChatStore(s => s.dropChatState)

  // Ref для chats чтобы chat:renamed effect не ре-подписывался при каждом
  // изменении chats (после каждого ответа setChats(all) → новый ref →
  // teardown+resubscribe IPC listener). Невидимо — тот же behaviour.
  const chatsRef = useRef(chats)
  const listRef = useRef<HTMLDivElement>(null)
  const onChatsUpdateRef = useRef(onChatsUpdate)
  useEffect(() => { chatsRef.current = chats })
  useEffect(() => { onChatsUpdateRef.current = onChatsUpdate })

  useEffect(() => {
    const off = window.syntee.on('chat:renamed', ({ chatId, title }: { chatId: string; title: string }) => {
      onChatsUpdateRef.current?.(chatsRef.current.map(c => c.id === chatId ? { ...c, title } : c))
    })
    return () => off()
  }, [])

  useEffect(() => { if (renamingId) renameRef.current?.focus() }, [renamingId])
  useEffect(() => { if (renamingProjectId) renameProjectRef.current?.focus() }, [renamingProjectId])
  useEffect(() => { if (editingVerifyCmdId) verifyCmdRef.current?.focus() }, [editingVerifyCmdId])

  // Закрытие контекстного меню проекта по клику вне его
  useEffect(() => {
    if (!projectCtxMenu) return
    const handler = (e: MouseEvent) => {
      if (projectCtxRef.current && !projectCtxRef.current.contains(e.target as Node)) {
        setProjectCtxMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [projectCtxMenu])

  // Закрытие меню «Новый проект» по клику вне его. Клик по самой кнопке +/—
  // обрабатывается отдельно (через data-атрибут), чтобы не закрывать тут же.
  useEffect(() => {
    if (!newProjectMenu) return
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-new-project-btn]')) return
      if (newProjectMenuRef.current && !newProjectMenuRef.current.contains(t)) {
        setNewProjectMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [newProjectMenu])

  // Escape сбрасывает мультивыбор чатов
  useEffect(() => {
    if (selectedIds.size === 0) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedIds(new Set())
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedIds.size])

  // Закрытие export-дропдауна в bulk-панели по клику вне
  useEffect(() => {
    if (!bulkExportOpen) return
    const handler = (e: MouseEvent) => {
      if (bulkExportRef.current && !bulkExportRef.current.contains(e.target as Node)) {
        setBulkExportOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [bulkExportOpen])

  // Закрытие фильтр-поповера по клику вне его и вне кнопки-фильтра
  useEffect(() => {
    if (!filterPopoverOpen) return
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.sidebar-filter-toggle')) return
      if (filterPopoverRef.current && !filterPopoverRef.current.contains(t)) {
        setFilterPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [filterPopoverOpen])

  // Авто-скролл списка чатов к активному чату: при смене currentChatId
  // (и при первом входе) подскролливаем активный чат в зону видимости.
  // Скроллим вручную через scrollTop (без scrollIntoView — он скроллит
  // всех прокручиваемых предков, что вызывает лаг/дёрганье). Раскрываем
  // свёрнутую группу только если элемента нет в DOM. Если чат уже виден —
  // ничего не делаем (убирает лишнюю работу при возврате на видимый чат).
  // useLayoutEffect (вместо useEffect) — выполняется ДО отрисовки браузера,
  // иначе при ремонте сайдбара (chat→settings→chat) scrollTop сбрасывается в 0,
  // а скролл прыгает в следующем кадре → видимый прыжок/«лаг».
  useLayoutEffect(() => {
    if (!currentChatId) return
    const container = listRef.current
    if (!container) return

    const tryScroll = (): boolean => {
      const el = container.querySelector<HTMLElement>(`[data-chat-id="${currentChatId}"]`)
      if (!el) return false
      const cRect = container.getBoundingClientRect()
      const eRect = el.getBoundingClientRect()
      // Уже в зоне видимости — скроллить не нужно.
      if (eRect.top >= cRect.top && eRect.bottom <= cRect.bottom) return true
      // Элемент выше — выравниваем по верху (с маленьким отступом).
      // Элемент ниже — по низу.
      const margin = 4
      const target = eRect.top < cRect.top
        ? container.scrollTop + (eRect.top - cRect.top) - margin
        : container.scrollTop + (eRect.bottom - cRect.bottom) + margin
      container.scrollTop = target
      return true
    }

    // Если элемент уже в DOM (группа раскрыта) — скроллим сразу.
    if (tryScroll()) return

    // Элемента нет — возможно в свёрнутой группе. Раскрываем.
    const chat = chatsRef.current.find(c => c.id === currentChatId)
    if (!chat) return
    const groupId = chat.projectId ?? '__noproject__'
    setCollapsedProjects(prev => {
      if (!prev.has(groupId)) return prev
      const next = new Set(prev)
      next.delete(groupId)
      return next
    })
    // После раскрытия (framer-motion анимация ~150мс) скроллим на следующем rAF.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => tryScroll()))
    return () => cancelAnimationFrame(raf)
  }, [currentChatId])

  // Фильтрация по поиску + виду (Все/Избранные/Архив) + скрытым проектам.
  // archive-чаты по умолчанию скрыты (filter = 'all' показывает только не-архивные);
  // для просмотра архива пользователь явно выбирает «Архив» в фильтр-поповере.
  const searchLower = search.toLowerCase()
  const matchesSearch = (c: Chat) => !search || c.title.toLowerCase().includes(searchLower)
  const matchesFilter = (c: Chat) => {
    switch (chatFilter) {
      case 'all':       return !c.isArchived
      case 'favorites': return !!c.isPinned && !c.isArchived
      case 'archive':   return !!c.isArchived
    }
  }
  // Скрытые проекты: чаты с projectId из hiddenProjects не показываются.
  // '__noproject__' — чаты без project_id.
  const matchesProjectFilter = (c: Chat) => {
    const key = c.projectId ?? '__noproject__'
    return !hiddenProjects.has(key)
  }

  // Чаты по проектам
  const chatsByProject = (projectId: string | null) =>
    chats.filter(c => (c.projectId ?? null) === projectId && matchesFilter(c) && matchesProjectFilter(c) && matchesSearch(c))

  const projectChats = (p: Project) => chatsByProject(p.id)
  const noProjectChats = chatsByProject(null)

  // Для режимов «Избранные» и «Архив» группировка по проектам избыточна —
  // показываем плоский список.
  const flatChats = chatFilter === 'favorites' || chatFilter === 'archive'
    ? chats.filter(c => matchesFilter(c) && matchesProjectFilter(c) && matchesSearch(c))
    : []

  const toggleCollapse = (id: string) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCtx = (e: React.MouseEvent, chat: Chat) => {
    e.preventDefault(); e.stopPropagation()
    setCtxMenu({ chat, pos: { x: e.clientX, y: e.clientY } })
  }

  const handleProjectCtx = (e: React.MouseEvent, project: Project) => {
    e.preventDefault(); e.stopPropagation()
    setProjectCtxMenu({ project, pos: { x: e.clientX, y: e.clientY } })
  }

  const handleRename = async (chat: Chat) => {
    setRenamingId(chat.id); setRenameVal(chat.title)
  }

  const commitRename = async (chatId: string) => {
    if (renameVal.trim()) {
      await window.syntee.chat.rename(chatId, renameVal.trim())
      onChatsUpdate?.(chats.map(c => c.id === chatId ? { ...c, title: renameVal.trim() } : c))
    }
    setRenamingId(null)
  }

  const handlePin = async (chat: Chat) => {
    const updated = await window.syntee.chat.pinChat(chat.id, !chat.isPinned) as Chat[]
    onChatsUpdate?.(updated)
  }

  const handleArchive = async (chat: Chat) => {
    const updated = await window.syntee.chat.archive(chat.id, !chat.isArchived) as Chat[]
    onChatsUpdate?.(updated)
    if (chat.id === currentChatId) onSelectChat?.(updated.find(c => !c.isArchived)?.id ?? '')
  }

  const handleDuplicate = async (chat: Chat) => {
    await window.syntee.chat.duplicate(chat.id)
    const updated = await window.syntee.chat.getAll() as Chat[]
    onChatsUpdate?.(updated)
  }

  const handleShare = (chat: Chat) => {
    setShareTarget({ id: chat.id, title: chat.title })
  }

  const handleDelete = async (chat: Chat) => {
    await window.syntee.chat.delete(chat.id)
    // Чистим live-state и статусы удалённого чата из store
    dropChatState(chat.id)
    const updated = await window.syntee.chat.getAll() as Chat[]
    onChatsUpdate?.(updated)
    if (chat.id === currentChatId) onSelectChat?.(updated[0]?.id ?? '')
  }

  const handleExport = async (chat: Chat, fmt: 'txt' | 'md') => {
    const content = await window.syntee.chat.export(chat.id, fmt) as string
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${chat.title}.${fmt}`; a.click()
    URL.revokeObjectURL(url)
  }

  const handleColor = async (chat: Chat, color: string | null) => {
    await window.syntee.chat.setColor(chat.id, color)
    onChatsUpdate?.(chats.map(c => c.id === chat.id ? { ...c, color: color ?? undefined } : c))
  }

  // ── Bulk actions (мультивыбор через Shift+клик) ──
  // Переиспользуем существующие single-chat IPC в цикле — chat:delete в main
  // делает критичную очистку (worker/queue/PTY/cost), не дублируем её.
  const clearSelection = () => setSelectedIds(new Set())

  const bulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (!confirm(`Удалить ${ids.length} ${ids.length === 1 ? 'чат' : 'чатов'}? Это необратимо.`)) return
    for (const id of ids) {
      await window.syntee.chat.delete(id)
      dropChatState(id)
    }
    const updated = await window.syntee.chat.getAll() as Chat[]
    onChatsUpdate?.(updated)
    if (ids.includes(currentChatId ?? '')) {
      onSelectChat?.(updated.find(c => !c.isArchived)?.id ?? '')
    }
    clearSelection()
  }

  const bulkArchive = async (archive: boolean) => {
    const ids = Array.from(selectedIds)
    for (const id of ids) {
      await window.syntee.chat.archive(id, archive)
    }
    const updated = await window.syntee.chat.getAll() as Chat[]
    onChatsUpdate?.(updated)
    if (archive && ids.includes(currentChatId ?? '')) {
      onSelectChat?.(updated.find(c => !c.isArchived)?.id ?? '')
    }
    clearSelection()
  }

  const bulkPin = async (pin: boolean) => {
    const ids = Array.from(selectedIds)
    for (const id of ids) {
      await window.syntee.chat.pinChat(id, pin)
    }
    const updated = await window.syntee.chat.getAll() as Chat[]
    onChatsUpdate?.(updated)
    clearSelection()
  }

  const bulkExport = async (fmt: 'txt' | 'md') => {
    const ids = Array.from(selectedIds)
    for (const id of ids) {
      const chat = chats.find(c => c.id === id)
      if (!chat) continue
      const content = await window.syntee.chat.export(id, fmt) as string
      const blob = new Blob([content], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${chat.title}.${fmt}`; a.click()
      URL.revokeObjectURL(url)
    }
    setBulkExportOpen(false)
    clearSelection()
  }

  // Лейблы кнопок зависят от состояния выбранных чатов
  const selectedChats = chats.filter(c => selectedIds.has(c.id))
  const anyNonArchived = selectedChats.some(c => !c.isArchived)
  const anyUnpinned = selectedChats.some(c => !c.isPinned)

  // Индикатор активного фильтра для кнопки-фильтра
  const hasActiveFilters = chatFilter !== 'all' || hiddenProjects.size > 0

  const openFilterPopover = () => {
    if (filterPopoverOpen) {
      setFilterPopoverOpen(false)
      return
    }
    // Позиция от строки поиска (вся ширина сайдбара), не от маленькой кнопки
    const searchEl = filterToggleRef.current?.closest('.sidebar-search') as HTMLElement | null
    const rect = searchEl?.getBoundingClientRect() ?? filterToggleRef.current?.getBoundingClientRect()
    if (rect) {
      setFilterPopoverPos({ top: rect.bottom + 4, left: rect.left, right: window.innerWidth - rect.right })
    }
    setFilterPopoverOpen(true)
  }

  const resetAllFilters = () => {
    setChatFilter('all')
    setHiddenProjects(new Set())
    clearSelection()
  }

  const toggleProjectHidden = (id: string) => {
    setHiddenProjects(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    clearSelection()
  }

  // ── Project actions ──
  const handleProjectRename = (project: Project) => {
    setRenamingProjectId(project.id); setRenameProjectVal(project.name)
  }

  const commitProjectRename = async (projectId: string) => {
    if (renameProjectVal.trim()) {
      await window.syntee.projects.rename(projectId, renameProjectVal.trim())
      onProjectsUpdate?.(projects.map(p => p.id === projectId ? { ...p, name: renameProjectVal.trim() } : p))
    }
    setRenamingProjectId(null)
  }

  const handleProjectDelete = async (project: Project) => {
    // Открываем модалку с галочкой «удалить чаты» вместо confirm().
    setDeleteProjectWithChats(false)
    setDeleteProjectTarget(project)
  }

  const confirmProjectDelete = async () => {
    const project = deleteProjectTarget
    if (!project) return
    setDeleteProjectTarget(null)
    await window.syntee.projects.delete(project.id, deleteProjectWithChats)
    const updated = await window.syntee.projects.getAll() as Project[]
    onProjectsUpdate?.(updated)
    // Если удалили с чатами — нужно обновить и список чатов
    if (deleteProjectWithChats) {
      const allChats = await window.syntee.chat.getAll() as Chat[]
      onChatsUpdate?.(allChats)
    }
    if (activeProjectId === project.id) onSelectProject?.(null)
  }

  const handleProjectOpenFolder = (project: Project) => {
    window.syntee.shell.openPath(project.workdir)
  }

  const handleEditVerifyCmd = (project: Project) => {
    setEditingVerifyCmdId(project.id); setVerifyCmdVal(project.verificationCommand ?? '')
  }

  const commitVerifyCmd = async (projectId: string) => {
    const value = verifyCmdVal.trim() || null
    await window.syntee.projects.setVerificationCommand(projectId, value)
    onProjectsUpdate?.(projects.map(p => p.id === projectId ? { ...p, verificationCommand: value ?? undefined } : p))
    setEditingVerifyCmdId(null)
  }

  const renderChatItem = (chat: Chat) => {
    // Индикатор статуса запуска: spinner пока агент работает, бейдж ✓/✗ после.
    // Бейдж исчезает при открытии чата (markChatRead в selectChat).
    const status = runStatusByChat[chat.id]?.status
    const unread = unreadStatusByChat[chat.id]
    // cleanPreview (5 regex-проходов) считаем один раз — раньше звучало дважды
    // на строку на каждый рендер Sidebar.
    const preview = chat.lastMessage ? cleanPreview(chat.lastMessage) : ''
    return (
    <motion.div
      key={chat.id}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      {renamingId === chat.id ? (
        <div className="sidebar-rename">
          <input
            ref={renameRef}
            className="sidebar-rename-input"
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onBlur={() => commitRename(chat.id)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename(chat.id)
              if (e.key === 'Escape') setRenamingId(null)
            }}
          />
        </div>
      ) : (
        <motion.button
          className={`sidebar-chat-item ${currentChatId === chat.id ? 'sidebar-chat-item--active' : ''} ${selectedIds.has(chat.id) ? 'sidebar-chat-item--selected' : ''}`}
          data-chat-id={chat.id}
          onClick={(e) => {
            if (e.shiftKey) {
              e.preventDefault()
              setSelectedIds(prev => {
                const next = new Set(prev)
                if (next.has(chat.id)) next.delete(chat.id)
                else next.add(chat.id)
                return next
              })
            } else {
              if (selectedIds.size > 0) setSelectedIds(new Set())
              onSelectChat?.(chat.id)
            }
          }}
          onContextMenu={e => handleCtx(e, chat)}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
          transition={springHover}
        >
          {chat.color && (
            <span className="sidebar-chat-color" style={{ background: chat.color }} />
          )}
          <div className="sidebar-chat-content">
            <div className="sidebar-chat-title">
              {!!chat.isPinned && <AppIcon name="pin" size="xs" tone="accent" />}
              <span className="sidebar-chat-title-text">{chat.title}</span>
            </div>
            {preview && (
              <div className="sidebar-chat-preview">
                {preview}
              </div>
            )}
          </div>
          <div className="sidebar-chat-meta">
            {/* Индикатор статуса агента: spinner (работает) или бейдж ✓/✗ (завершено, непрочитано) */}
            {(status === 'running' || status === 'queued') && (
              <span className="sidebar-chat-spinner" title={status === 'queued' ? 'В очереди' : 'Работает'} />
            )}
            {unread === 'done' && (
              <span className="sidebar-chat-status sidebar-chat-status--done" title="Завершено">
                <AppIcon name="check" size="xs" tone="accent" />
              </span>
            )}
            {unread === 'error' && (
              <span className="sidebar-chat-status sidebar-chat-status--error" title="Ошибка">
                <AppIcon name="x" size="xs" />
              </span>
            )}
            {unread === 'cancelled' && (
              <span className="sidebar-chat-status sidebar-chat-status--cancelled" title="Отменено">
                <AppIcon name="minus" size="xs" />
              </span>
            )}
            <span className="sidebar-chat-time">
              {formatTime(chat.updatedAt)}
            </span>
          </div>
        </motion.button>
      )}
    </motion.div>
    )
  }

  const renderProject = (project: Project) => {
    const items = projectChats(project)
    const isCollapsed = collapsedProjects.has(project.id)
    const isActive = activeProjectId === project.id
    return (
      <div key={project.id} className={`sidebar-project ${isActive ? 'sidebar-project--active' : ''}`}>
        <motion.div
          className="sidebar-project-header"
          onClick={() => onSelectProject?.(project.id)}
          onContextMenu={e => handleProjectCtx(e, project)}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
          transition={springHover}
        >
          <motion.button
            className="sidebar-project-chevron"
            onClick={(e) => { e.stopPropagation(); toggleCollapse(project.id) }}
            title={isCollapsed ? 'Развернуть' : 'Свернуть'}
            whileHover={whileHoverTiny}
            whileTap={whileTapTiny}
            transition={springHover}
          >
            <motion.span
              style={{ display: 'inline-flex' }}
              animate={{ rotate: isCollapsed ? 0 : 0 }}
            >
              <AppIcon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size="xs" />
            </motion.span>
          </motion.button>
          <AppIcon name="folder" size="xs" tone={isActive ? 'accent' : 'default'} />
          {renamingProjectId === project.id ? (
            <input
              ref={renameProjectRef}
              className="sidebar-project-rename-input"
              value={renameProjectVal}
              onChange={e => setRenameProjectVal(e.target.value)}
              onClick={e => e.stopPropagation()}
              onBlur={() => commitProjectRename(project.id)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitProjectRename(project.id)
                if (e.key === 'Escape') setRenamingProjectId(null)
              }}
            />
          ) : (
            <span className="sidebar-project-name" title={project.workdir}>{project.name}</span>
          )}
          <motion.button
            className="sidebar-project-add"
            onClick={(e) => { e.stopPropagation(); onNewChat?.(project.id) }}
            title="Новый чат в проекте"
            whileHover={whileHoverTiny}
            whileTap={whileTapTiny}
            transition={springHover}
          >
            <AppIcon name="plus" size="xs" />
          </motion.button>
        </motion.div>
        <div className="sidebar-project-workdir" title={project.workdir}>
          {shortWorkdir(project.workdir)}
        </div>
        {editingVerifyCmdId === project.id ? (
          <input
            ref={verifyCmdRef}
            className="sidebar-project-verifycmd-input"
            placeholder="Команда проверки, напр. npm test"
            value={verifyCmdVal}
            onChange={e => setVerifyCmdVal(e.target.value)}
            onClick={e => e.stopPropagation()}
            onBlur={() => commitVerifyCmd(project.id)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitVerifyCmd(project.id)
              if (e.key === 'Escape') setEditingVerifyCmdId(null)
            }}
          />
        ) : project.verificationCommand ? (
          <div className="sidebar-project-verifycmd" title={project.verificationCommand}>
            ✓ {project.verificationCommand}
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {!isCollapsed && (
            <motion.div
              className="sidebar-project-chats"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {items.length === 0 && (
                <div className="sidebar-project-empty">Нет чатов</div>
              )}
              {items.map(renderChatItem)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  const hasAnyChats = chats.filter(c => !c.isArchived && matchesProjectFilter(c)).length > 0

  return (
    <aside className="sidebar">
      {/* Шапка */}
      <div className="sidebar-header">
        <span className="sidebar-title">Проекты</span>
        <div className="sidebar-header-actions">
          <IconButton
            icon="messageSquare"
            label="Новый чат без проекта"
            onClick={() => onNewChatWithoutProject?.()}
          />
          <IconButton
            icon="plus"
            label="Новый проект"
            data-new-project-btn
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              // Меню шириной 240 — прижимаем к правому краю кнопки
              const menuW = 240
              setNewProjectMenu({ x: Math.max(8, rect.right - menuW), y: rect.bottom + 4 })
            }}
          />
        </div>
      </div>

      {/* Расширения (MCP и Skills) — отдельная широкая кнопка на всю ширину. */}
      <motion.button
        type="button"
        className="sidebar-extensions-btn"
        data-extensions-btn
        onClick={() => setExtPopoverOpen(true)}
        whileHover={whileHoverWide}
        whileTap={whileTapWide}
        transition={springHover}
      >
        <span className="sidebar-extensions-btn-icon">
          <AppIcon name="puzzle" size="sm" />
        </span>
        <span className="sidebar-extensions-btn-label">Расширения</span>
        <span className="sidebar-extensions-btn-sub">MCP и Skills</span>
        <AppIcon name="chevronRight" size="xs" className="sidebar-extensions-btn-chevron" />
      </motion.button>

      {/* Поиск + кнопка-фильтр */}
      <div className="sidebar-search">
        <AppIcon name="search" size="xs" />
        <input
          className="sidebar-search-input"
          placeholder="Поиск чатов..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <motion.button
          ref={filterToggleRef}
          className={`sidebar-filter-toggle ${hasActiveFilters ? 'sidebar-filter-toggle--active' : ''} ${filterPopoverOpen ? 'sidebar-filter-toggle--open' : ''}`}
          title="Фильтры"
          onClick={openFilterPopover}
          whileHover={whileHoverSm}
          whileTap={whileTapSm}
          transition={springHover}
        >
          <AppIcon name="filter" size="xs" />
          {hasActiveFilters && <span className="sidebar-filter-toggle-dot" />}
        </motion.button>
        {search && (
          <motion.button
            className="sidebar-search-clear"
            onClick={() => setSearch('')}
            whileHover={whileHoverTiny}
            whileTap={whileTapTiny}
            transition={springHover}
          >
            <AppIcon name="x" size="xs" />
          </motion.button>
        )}
      </div>

      {/* Список */}
      <div className="sidebar-list" ref={listRef}>
        {chatFilter === 'favorites' || chatFilter === 'archive' ? (
          flatChats.length === 0 ? (
            <div className="sidebar-empty">
              {search ? 'Ничего не найдено' : chatFilter === 'favorites' ? 'Нет избранных чатов' : 'Архив пуст'}
            </div>
          ) : (
            flatChats.map(renderChatItem)
          )
        ) : (
          <>
            {projects.length === 0 && noProjectChats.length === 0 && (
              <div className="sidebar-empty">
                {search ? 'Ничего не найдено' : 'Нет проектов. Нажмите + чтобы создать.'}
              </div>
            )}

            {projects.filter(p => !hiddenProjects.has(p.id)).map(renderProject)}

            {/* Без проекта — чаты без project_id (старые, инкогнито).
                Скрываем, если пользователь скрыл «Без проекта» в фильтрах. */}
            {!hiddenProjects.has('__noproject__') && noProjectChats.length > 0 && (
              <div className="sidebar-project sidebar-project--noproject">
                <motion.div
                  className="sidebar-project-header"
                  onClick={() => onSelectProject?.(null)}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  transition={springHover}
                >
                  <motion.button
                    className="sidebar-project-chevron"
                    onClick={(e) => { e.stopPropagation(); toggleCollapse('__noproject__') }}
                    whileHover={whileHoverTiny}
                    whileTap={whileTapTiny}
                    transition={springHover}
                  >
                    <AppIcon name={collapsedProjects.has('__noproject__') ? 'chevronRight' : 'chevronDown'} size="xs" />
                  </motion.button>
                  <AppIcon name="layers" size="xs" tone="muted" />
                  <span className="sidebar-project-name">Без проекта</span>
                </motion.div>
                <AnimatePresence initial={false}>
                  {!collapsedProjects.has('__noproject__') && (
                    <motion.div
                      className="sidebar-project-chats"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      {noProjectChats.map(renderChatItem)}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {!hasAnyChats && projects.length > 0 && (
              <div className="sidebar-empty sidebar-empty--subtle">
                Создайте чат кнопкой + рядом с проектом
              </div>
            )}
          </>
        )}
      </div>

      <ChatContextMenu
        chat={ctxMenu?.chat ?? null}
        pos={ctxMenu?.pos ?? null}
        onClose={() => setCtxMenu(null)}
        onOpenInTab={(chat) => useTabsStore.getState().openTab(chat.id)}
        onRename={handleRename}
        onPin={handlePin}
        onArchive={handleArchive}
        onDuplicate={handleDuplicate}
        onShare={handleShare}
        onExport={handleExport}
        onDelete={handleDelete}
        onColor={handleColor}
      />

      <ShareChatModal
        open={shareTarget !== null}
        onClose={() => setShareTarget(null)}
        chatId={shareTarget?.id ?? null}
        chatTitle={shareTarget?.title ?? ''}
      />

      {/* Контекстное меню проекта. Рендерим всегда (без условия), чтобы
          AnimatePresence оставался смонтированным и проигрывал exit-анимацию. */}
      <ProjectContextMenu
        state={projectCtxMenu}
        menuRef={projectCtxRef}
        handlers={{
          onClose: () => setProjectCtxMenu(null),
          onRename: handleProjectRename,
          onDelete: handleProjectDelete,
          onOpenFolder: handleProjectOpenFolder,
          onNewChat: (p) => { onNewChat?.(p.id); setProjectCtxMenu(null) },
          onEditVerifyCmd: handleEditVerifyCmd,
          onIndexStatus: (p) => setIndexModalProject({ id: p.id, name: p.name }),
        }}
      />

      {/* Меню «Новый проект»: создать пустой или выбрать существующую папку.
          Тоже всегда смонтировано ради exit-анимации. */}
      <NewProjectMenu
        pos={newProjectMenu}
        menuRef={newProjectMenuRef}
        handlers={{
          onClose: () => setNewProjectMenu(null),
          onEmpty: () => { onNewProject?.('empty'); setNewProjectMenu(null) },
          onExisting: () => { onNewProject?.('existing'); setNewProjectMenu(null) },
        }}
      />

      {/* Модальное окно управления расширениями (MCP и Skills). */}
      <ExtensionsPopover
        open={extPopoverOpen}
        projectId={activeProjectId ?? undefined}
        onClose={() => setExtPopoverOpen(false)}
        onInstalled={onExtensionInstalled}
      />

      <ProjectIndexModal
        open={!!indexModalProject}
        projectId={indexModalProject?.id ?? null}
        projectName={indexModalProject?.name}
        onClose={() => setIndexModalProject(null)}
      />

      {/* Модалка удаления проекта с галочкой «удалить чаты». */}
      {deleteProjectTarget && createPortal(
        <AnimatePresence>
          <motion.div
            className="agent-confirm-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setDeleteProjectTarget(null)}
          >
            <motion.div
              className="agent-confirm-dialog"
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="agent-confirm-icon agent-confirm-icon--danger">
                <AppIcon name="trash" size="md" />
              </div>
              <div className="agent-confirm-body">
                <div className="agent-confirm-title">Удалить проект</div>
                <div className="agent-confirm-tool">«{deleteProjectTarget.name}»</div>
                <label className="sidebar-delete-chats-toggle">
                  <input
                    type="checkbox"
                    checked={deleteProjectWithChats}
                    onChange={(e) => setDeleteProjectWithChats(e.target.checked)}
                  />
                  <span>Удалить все чаты внутри проекта</span>
                </label>
                <div className="agent-confirm-reason">
                  {deleteProjectWithChats
                    ? 'Проект и все его чаты будут безвозвратно удалены.'
                    : 'Чаты останутся, но перейдут в «Без проекта».'}
                </div>
              </div>
              <div className="agent-confirm-actions">
                <motion.button
                  className="agent-confirm-btn agent-confirm-btn--deny"
                  onClick={() => setDeleteProjectTarget(null)}
                  whileTap={{ scale: 0.95 }}
                >
                  <AppIcon name="x" size="sm" />
                  Отмена
                </motion.button>
                <motion.button
                  className="agent-confirm-btn agent-confirm-btn--allow"
                  onClick={confirmProjectDelete}
                  whileTap={{ scale: 0.95 }}
                >
                  <AppIcon name="check" size="sm" />
                  Удалить
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        </AnimatePresence>,
        document.body
      )}

      {/* Панель массовых действий — появляется при мультивыборе (Shift+клик) */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <motion.div
            className="sidebar-bulk-bar"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            <span className="sidebar-bulk-count">{selectedIds.size} выбрано</span>
            <div className="sidebar-bulk-actions">
              <motion.button
                className="sidebar-bulk-btn"
                title={anyUnpinned ? 'Закрепить' : 'Открепить'}
                onClick={() => bulkPin(anyUnpinned)}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <AppIcon name="pin" size="sm" />
              </motion.button>
              <motion.button
                className="sidebar-bulk-btn"
                title={anyNonArchived ? 'Архивировать' : 'Разархивировать'}
                onClick={() => bulkArchive(anyNonArchived)}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <AppIcon name="archive" size="sm" />
              </motion.button>
              <div className="sidebar-bulk-export-wrap" ref={bulkExportRef}>
                <motion.button
                  className="sidebar-bulk-btn"
                  title="Экспорт"
                  onClick={() => setBulkExportOpen(v => !v)}
                  whileHover={whileHoverSm}
                  whileTap={whileTapSm}
                  transition={springHover}
                >
                  <AppIcon name="fileText" size="sm" />
                </motion.button>
                {bulkExportOpen && (
                  <div className="sidebar-bulk-export-menu">
                    <button onClick={() => bulkExport('md')}>Markdown (.md)</button>
                    <button onClick={() => bulkExport('txt')}>Текст (.txt)</button>
                  </div>
                )}
              </div>
              <motion.button
                className="sidebar-bulk-btn sidebar-bulk-btn--danger"
                title="Удалить"
                onClick={bulkDelete}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <AppIcon name="trash" size="sm" />
              </motion.button>
            </div>
            <motion.button
              className="sidebar-bulk-clear"
              title="Снять выделение (Esc)"
              onClick={clearSelection}
              whileHover={whileHoverTiny}
              whileTap={whileTapTiny}
              transition={springHover}
            >
              <AppIcon name="x" size="xs" />
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Поповер фильтров сайдбара */}
      <ChatFilterPopover
        open={filterPopoverOpen}
        pos={filterPopoverPos}
        popoverRef={filterPopoverRef}
        chatFilter={chatFilter}
        hiddenProjects={hiddenProjects}
        projects={projects}
        hasNoProjectChats={chats.some(c => !c.projectId)}
        hasActiveFilters={hasActiveFilters}
        onSetFilter={(f) => { setChatFilter(f); clearSelection() }}
        onToggleProject={toggleProjectHidden}
        onShowAllProjects={() => { setHiddenProjects(new Set()); clearSelection() }}
        onResetAll={resetAllFilters}
      />

      <UserCard />
    </aside>
  )
}

// Контекстное меню для проекта — отдельный портал (аналог ChatContextMenu).
// Компонент рендерится всегда (даже когда state === null), чтобы AnimatePresence
// оставался смонтированным и проигрывал exit-анимацию при закрытии.
function ProjectContextMenu({ state, menuRef, handlers }: {
  state: { project: Project; pos: ContextMenuPos } | null
  menuRef: React.RefObject<HTMLDivElement>
  handlers: {
    onClose: () => void
    onRename: (p: Project) => void
    onDelete: (p: Project) => void
    onOpenFolder: (p: Project) => void
    onNewChat: (p: Project) => void
    onEditVerifyCmd: (p: Project) => void
    onIndexStatus: (p: Project) => void
  }
}) {
  const project = state?.project
  const pos = state?.pos ?? null
  // В нижней половине окна меню открывается ВВЕРХ от клика — низ не уйдёт
  // за окно независимо от высоты (хардкод menuH = 200 занижал её → обрезка).
  const mp = pos ? getContextMenuPosition(pos) : null
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: mp?.left ?? 0,
    top: mp?.top,
    bottom: mp?.bottom,
    maxHeight: mp?.maxHeight,
    zIndex: 9999,
  }
  return createPortal(
    <AnimatePresence>
      {project && pos && (
        <motion.div
          ref={menuRef}
          className="chat-ctx-menu"
          style={menuStyle}
          initial={{ opacity: 0, scale: 0.95, y: mp?.openUp ? 6 : -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          <button className="ctx-item" onClick={() => { handlers.onNewChat(project); }}>
            <AppIcon name="plus" size="sm" />
            <span>Новый чат здесь</span>
          </button>
          <div className="ctx-divider" />
          <button className="ctx-item" onClick={() => { handlers.onRename(project); handlers.onClose() }}>
            <AppIcon name="edit" size="sm" />
            <span>Переименовать</span>
          </button>
          <button className="ctx-item" onClick={() => { handlers.onOpenFolder(project); handlers.onClose() }}>
            <AppIcon name="folder" size="sm" />
            <span>Открыть папку</span>
          </button>
          <button className="ctx-item" onClick={() => { handlers.onEditVerifyCmd(project); handlers.onClose() }}>
            <AppIcon name="terminal" size="sm" />
            <span>Команда проверки</span>
          </button>
          <button className="ctx-item" onClick={() => { handlers.onIndexStatus(project); handlers.onClose() }}>
            <AppIcon name="database" size="sm" />
            <span>Статус индекса</span>
          </button>
          <div className="ctx-divider" />
          <button className="ctx-item ctx-item--danger" onClick={() => { handlers.onDelete(project); handlers.onClose() }}>
            <AppIcon name="trash" size="sm" />
            <span>Удалить проект</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

// Меню «Новый проект»: выбор между созданием пустой папки и выбором
// существующей. Появляется по клику на + в шапке сайдбара.
// Всегда смонтировано ради exit-анимации. Позиция — по реальному размеру.
function NewProjectMenu({ pos, menuRef, handlers }: {
  pos: ContextMenuPos | null
  menuRef: React.RefObject<HTMLDivElement>
  handlers: {
    onClose: () => void
    onEmpty: () => void
    onExisting: () => void
  }
}) {
  const mp = pos ? getContextMenuPosition(pos) : null
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: mp?.left ?? 0,
    top: mp?.top,
    bottom: mp?.bottom,
    maxHeight: mp?.maxHeight,
    zIndex: 9999,
  }
  return createPortal(
    <AnimatePresence>
      {pos && (
        <motion.div
          ref={menuRef}
          className="chat-ctx-menu"
          style={menuStyle}
          initial={{ opacity: 0, scale: 0.95, y: mp?.openUp ? 6 : -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          <button className="ctx-item" onClick={handlers.onEmpty}>
            <AppIcon name="plus" size="sm" />
            <span>Создать пустой проект</span>
          </button>
          <button className="ctx-item" onClick={handlers.onExisting}>
            <AppIcon name="folder" size="sm" />
            <span>Выбрать существующую папку</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

// Поповер фильтров сайдбара: выбор вида (Все/Избранные/Архив) и
// видимости отдельных проектов (чекбоксы). Portal в document.body,
// позиция — от кнопки-фильтра (fixed). Анимация — выпадает сверху-вниз.
function ChatFilterPopover({
  open, pos, popoverRef,
  chatFilter, hiddenProjects, projects, hasNoProjectChats, hasActiveFilters,
  onSetFilter, onToggleProject, onShowAllProjects, onResetAll,
}: {
  open: boolean
  pos: { top: number; left: number; right: number } | null
  popoverRef: React.RefObject<HTMLDivElement>
  chatFilter: ChatFilter
  hiddenProjects: Set<string>
  projects: Project[]
  hasNoProjectChats: boolean
  hasActiveFilters: boolean
  onSetFilter: (f: ChatFilter) => void
  onToggleProject: (id: string) => void
  onShowAllProjects: () => void
  onResetAll: () => void
}) {
  if (!pos) return null
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    top: pos.top,
    left: pos.left,
    right: pos.right,
    zIndex: 9999,
  }
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={popoverRef}
          className="chat-filter-popover"
          style={menuStyle}
          initial={{ opacity: 0, y: -6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          {/* Заголовок */}
          <div className="cfp-header">
            <span className="cfp-title">Фильтры</span>
          </div>

          {/* Секция: Вид */}
          <div className="cfp-section">
            <div className="cfp-section-label">Вид</div>
            {CHAT_FILTERS.map(f => (
              <button
                key={f.value}
                className={`cfp-radio ${chatFilter === f.value ? 'cfp-radio--active' : ''}`}
                onClick={() => onSetFilter(f.value)}
              >
                <span className={`cfp-radio-dot ${chatFilter === f.value ? 'cfp-radio-dot--filled' : ''}`} />
                <span className="cfp-radio-label">{f.label}</span>
              </button>
            ))}
          </div>

          {/* Секция: Проекты — только если есть хотя бы один проект или чаты без проекта */}
          {(projects.length > 0 || hasNoProjectChats) && (
            <div className="cfp-section">
              <div className="cfp-section-header">
                <span className="cfp-section-label">Проекты</span>
                {hiddenProjects.size > 0 && (
                  <button className="cfp-link" onClick={onShowAllProjects}>Показать все</button>
                )}
              </div>
              <div className="cfp-project-list">
                {projects.map(p => {
                  const visible = !hiddenProjects.has(p.id)
                  return (
                    <button
                      key={p.id}
                      className={`cfp-check ${visible ? 'cfp-check--checked' : ''}`}
                      onClick={() => onToggleProject(p.id)}
                    >
                      <span className={`cfp-checkbox ${visible ? 'cfp-checkbox--checked' : ''}`}>
                        {visible && <AppIcon name="check" size="xs" />}
                      </span>
                      <AppIcon name="folder" size="xs" tone={visible ? 'default' : 'muted'} />
                      <span className="cfp-check-label" title={p.workdir}>{p.name}</span>
                    </button>
                  )
                })}
                {hasNoProjectChats && (
                  <button
                    className={`cfp-check ${!hiddenProjects.has('__noproject__') ? 'cfp-check--checked' : ''}`}
                    onClick={() => onToggleProject('__noproject__')}
                  >
                    <span className={`cfp-checkbox ${!hiddenProjects.has('__noproject__') ? 'cfp-checkbox--checked' : ''}`}>
                      {!hiddenProjects.has('__noproject__') && <AppIcon name="check" size="xs" />}
                    </span>
                    <AppIcon name="layers" size="xs" tone={!hiddenProjects.has('__noproject__') ? 'default' : 'muted'} />
                    <span className="cfp-check-label">Без проекта</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Сбросить всё */}
          {hasActiveFilters && (
            <button className="cfp-reset" onClick={onResetAll}>
              Сбросить фильтры
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

export default memo(Sidebar)
