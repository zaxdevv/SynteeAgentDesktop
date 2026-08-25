import { useState, useEffect, useLayoutEffect, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { Chat, Project, Message } from '../../../../../shared/types'
import AppIcon from '../../ui/AppIcon/AppIcon'
import IconButton from '../../ui/IconButton/IconButton'
import ChatContextMenu, { type ContextMenuPos } from '../../ui/ChatContextMenu/ChatContextMenu'
import ExtensionsPopover from '../../ui/ExtensionsPopover/ExtensionsPopover'
import { ProjectIndexModal } from '../../ui/ProjectIndexModal/ProjectIndexModal'
import { ProjectSettingsModal } from '../../ui/ProjectSettingsModal/ProjectSettingsModal'
import ShareChatModal from '../../ui/ShareChatModal/ShareChatModal'
import Identicon from '../../ui/Identicon/Identicon'
import UserCard, { fmtCost, fmtReset } from './UserCard'
import { useChatStore, type RunStatus, type RunStatusInfo } from '../../../store/chat.store'
import { useAuthStore } from '../../../store/auth.store'
import { useNavStore } from '../../../store/nav.store'
import { useBillingStore } from '../../../store/billing.store'
import { useTabsStore } from '../../../store/tabs.store'
import { getContextMenuPosition } from '../../../utils/contextMenuPosition'
import { springHover, whileHoverTiny, whileTapTiny, whileHoverWide, whileTapWide, whileHoverSm, whileTapSm, whileHoverListItem, whileTapListItem } from '../../../utils/motionPresets'
import './Sidebar.css'
// Классы usercard-panel-* используются RailUserAvatar (ховер-панель юзера в rail)
import './UserCard.css'

// ── Прелоад чата по hover в сайдбаре ────────────────────────────────────
// Наведение мыши на чат → фоном грузим последнюю страницу сообщений в
// LRU-кеш. Клик через 200-400мс → кэш-хит → мгновенный показ без скелетона.
// Прелоад идёт только для чатов, которых ещё нет в кеше (не трогаем активные).
// Дебаунс 150мс: быстрое проведение мыши по списку не спамит IPC.
const HOVER_PRELOAD_DELAY = 150
let _hoverPreloadTimer: ReturnType<typeof setTimeout> | null = null
function preloadChatOnHover(chatId: string): void {
  if (_hoverPreloadTimer) clearTimeout(_hoverPreloadTimer)
  _hoverPreloadTimer = setTimeout(() => {
    _hoverPreloadTimer = null
    const st = useChatStore.getState()
    // Уже в кеше — не дёргаем IPC. Или чат сейчас активный — тоже не нужен.
    if (st.messagesByChat[chatId] || st.currentChatId === chatId) return
    // Грузим последнюю страницу фоном, пишем в кеш (setMessagesWindow для
    // non-current chatId НЕ трогает s.messages — безопасно).
    window.syntee.chat.getMessagesPage(chatId, 50).then((res: unknown) => {
      const r = res as { messages: Message[]; hasMore: boolean }
      // Проверяем: пока летел IPC, чат мог стать активным или попасть в кеш.
      const cur = useChatStore.getState()
      if (cur.messagesByChat[chatId] || cur.currentChatId === chatId) return
      cur.setMessagesWindow(chatId, r.messages, r.hasMore)
    }).catch(() => { /* ok — preload не критичен */ })
  }, HOVER_PRELOAD_DELAY)
}

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

// Детерминированный цвет проекта из его id — одинаков между сессиями,
// без хранения. Hue из простого строкового хеша. alpha < 1 → hsla-форма.
function projectColor(id: string, alpha = 1): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  return alpha >= 1
    ? `hsl(${hue}, 55%, 58%)`
    : `hsla(${hue}, 55%, 58%, ${alpha})`
}

// ── Дата-группировка для плоских списков (Избранные/Архив) ──
const DAY_MS = 86400000
type DateGroupKey = 'today' | 'yesterday' | 'week' | 'earlier'
const DATE_GROUPS: { key: DateGroupKey; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'week', label: 'На этой неделе' },
  { key: 'earlier', label: 'Ранее' },
]
function dateGroup(ts: number): DateGroupKey {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= start) return 'today'
  if (ts >= start - DAY_MS) return 'yesterday'
  if (ts >= start - 7 * DAY_MS) return 'week'
  return 'earlier'
}

// Rail-режим сайдбара (узкая панель 48px) — персист в localStorage,
// переживает перезапуск приложения. По умолчанию — раскрытая форма.
const RAIL_KEY = 'syntee:sidebarRail'

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
  const [settingsModalProject, setSettingsModalProject] = useState<Project | null>(null)
  const [shareTarget, setShareTarget] = useState<{ id: string; title: string } | null>(null)
  // Модалка удаления проекта: хранит проект + состояние чекбокса «удалить чаты».
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [deleteProjectWithChats, setDeleteProjectWithChats] = useState(false)
  // Мультивыбор чатов через Shift+клик. Эфемерный UI-state — только сайдбар.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkExportOpen, setBulkExportOpen] = useState(false)
  const bulkExportRef = useRef<HTMLDivElement>(null)
  // Rail-режим: узкая панель 48px вместо полного сайдбара. Персист в localStorage.
  const [rail, setRail] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  // Клавиатурная навигация из поиска: индекс чата в visibleChatIds (-1 = нет).
  const [kbIndex, setKbIndex] = useState(-1)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Ховер-флайаут проекта в rail: наведение на плитку → сбоку панель с чатами.
  const [railFlyout, setRailFlyout] = useState<{ projectId: string; top: number; maxHeight: number } | null>(null)
  const railFlyoutOpenT = useRef<number | null>(null)
  const railFlyoutCloseT = useRef<number | null>(null)
  // Меню быстрого создания в rail (клик/ховер по messageSquare): обычный чат,
  // чат в проекте или новый проект — БЕЗ разворачивания сайдбара.
  const [railCreateMenu, setRailCreateMenu] = useState<{ top: number; maxHeight: number } | null>(null)
  // Поисковый флайаут в rail (ковер/клик по search или Ctrl+K): инпут + список
  // всех чатов, БЕЗ разворачивания сайдбара.
  const [railSearchFlyout, setRailSearchFlyout] = useState<{ top: number; maxHeight: number } | null>(null)
  const railSearchInputRef = useRef<HTMLInputElement>(null)

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

  // Персист rail-режима — форма сайдбара сохраняется после перезапуска приложения
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, rail ? '1' : '0') } catch { /* noop */ }
  }, [rail])

  // Ctrl+K — фокус в поиск сайдбара из любого места приложения.
  // В rail-режиме открывает поисковый флайаут сбоку (не разворачивает сайдбар).
  // e.code (физическая клавиша), не e.key: при русской раскладке e.key
  // возвращает кириллическую «к», и проверка === 'k' молча не срабатывала.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault()
        if (rail) {
          // Открываем поисковый флайаут в rail — сайдбар не разворачивается.
          // Позиция: от верха rail-панели (кнопка поиска ~70px от верха).
          const top = 70
          setRailSearchFlyout({ top, maxHeight: window.innerHeight - top - 12 })
          setRailFlyout(null)
          setRailCreateMenu(null)
          // Фокус в инпут флайаута после анимации появления (spring ~200ms)
          setTimeout(() => {
            railSearchInputRef.current?.focus()
            railSearchInputRef.current?.select()
          }, 220)
        } else {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [rail])

  // Таймеры rail-флайаутов не должны стрелять после размонтирования
  useEffect(() => () => {
    if (railFlyoutOpenT.current) clearTimeout(railFlyoutOpenT.current)
    if (railFlyoutCloseT.current) clearTimeout(railFlyoutCloseT.current)
  }, [])

  // ── Универсальные ховеры для rail-кнопок ──
  // Каждая rail-кнопка (messageSquare, search, плитка проекта) открывает
  // свой флайаут по ховеру с задержкой 120мс (быстрое проведение мыши не
  // дёргает панели). Закрытие — 180мс (курсор успевает дойти до панели).
  const railHoverOpenT = useRef<number | null>(null)
  const railHoverCloseT = useRef<number | null>(null)

  const cancelRailHoverClose = () => {
    if (railHoverCloseT.current) { clearTimeout(railHoverCloseT.current); railHoverCloseT.current = null }
  }
  const cancelRailHoverOpen = () => {
    if (railHoverOpenT.current) { clearTimeout(railHoverOpenT.current); railHoverOpenT.current = null }
  }

  // Открыть флайаут по ховеру на кнопке. type определяет какой флайаут.
  const hoverRailButton = (
    type: 'create' | 'search',
    el: HTMLElement,
    immediate = false,
  ) => {
    cancelRailHoverClose()
    cancelRailHoverOpen()
    const open = () => {
      railHoverOpenT.current = null
      const rect = el.getBoundingClientRect()
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 320))
      const maxHeight = window.innerHeight - top - 12
      // Закрываем другие флайауты, открываем нужный
      setRailFlyout(null)
      if (type === 'create') {
        setRailSearchFlyout(null)
        setRailCreateMenu({ top, maxHeight })
      } else {
        setRailCreateMenu(null)
        setRailSearchFlyout({ top, maxHeight })
        setTimeout(() => {
          railSearchInputRef.current?.focus()
          railSearchInputRef.current?.select()
        }, 220)
      }
    }
    if (immediate) { open(); return }
    railHoverOpenT.current = window.setTimeout(open, 120)
  }

  const scheduleHoverClose = () => {
    cancelRailHoverOpen()
    cancelRailHoverClose()
    railHoverCloseT.current = window.setTimeout(() => {
      railHoverCloseT.current = null
      setRailCreateMenu(null)
      setRailSearchFlyout(null)
    }, 180)
  }

  // Закрытие меню быстрого создания (rail) по клику вне его и вне кнопки.
  // Кнопка exempt через data-атрибут — повторный клик = toggle (в onClick).
  useEffect(() => {
    if (!railCreateMenu && !railSearchFlyout) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-rail-create-menu]')) return
      if (t.closest('[data-rail-create-btn]')) return
      if (t.closest('[data-rail-search-flyout]')) return
      if (t.closest('[data-rail-search-btn]')) return
      setRailCreateMenu(null)
      setRailSearchFlyout(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setRailCreateMenu(null); setRailSearchFlyout(null) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [railCreateMenu, railSearchFlyout])

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

  // Плоский список по убыванию updatedAt — для дата-группировки
  const flatSorted = [...flatChats].sort((a, b) => b.updatedAt - a.updatedAt)

  // Идентификаторы чатов в порядке рендера — для навигации стрелками
  // из поиска (↑↓ + Enter). Учитывает свёрнутые группы и скрытые проекты.
  const visibleChatIds: string[] = chatFilter === 'favorites' || chatFilter === 'archive'
    ? flatSorted.map(c => c.id)
    : [
        ...projects
          .filter(p => !hiddenProjects.has(p.id))
          .flatMap(p => (collapsedProjects.has(p.id) ? [] : projectChats(p).map(c => c.id))),
        ...(!hiddenProjects.has('__noproject__') && !collapsedProjects.has('__noproject__')
          ? noProjectChats.map(c => c.id)
          : []),
      ]

  // Клавиатурная навигация в поиске: ↑↓ двигают выделение, Enter открывает,
  // Esc сбрасывает. Выделенный чат подсвечивается и скроллится в вид.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (visibleChatIds.length === 0) return
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(Math.max(kbIndex + dir, 0), visibleChatIds.length - 1)
      setKbIndex(next)
      listRef.current
        ?.querySelector(`[data-chat-id="${visibleChatIds[next]}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      const id = kbIndex >= 0 ? visibleChatIds[kbIndex] : visibleChatIds[0]
      if (id) {
        onSelectChat?.(id)
        searchInputRef.current?.blur()
      }
    } else if (e.key === 'Escape') {
      if (search) setSearch('')
      setKbIndex(-1)
      searchInputRef.current?.blur()
    }
  }

  const toggleCollapse = (id: string) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── Rail flyout (ховер по плитке проекта) ──
  // Открытие с задержкой 200мс: быстрое проведение мыши по плиткам не дёргает
  // панели. Закрытие с задержкой 180мс: курсор успевает дойти до самой панели
  // (зазор rail→панель 6px), не дав ей закрыться.
  const clearRailFlyoutTimers = () => {
    if (railFlyoutOpenT.current) { clearTimeout(railFlyoutOpenT.current); railFlyoutOpenT.current = null }
    if (railFlyoutCloseT.current) { clearTimeout(railFlyoutCloseT.current); railFlyoutCloseT.current = null }
  }

  const openRailFlyout = (projectId: string, el: HTMLElement, immediate = false) => {
    if (railFlyoutCloseT.current) { clearTimeout(railFlyoutCloseT.current); railFlyoutCloseT.current = null }
    if (railFlyoutOpenT.current) clearTimeout(railFlyoutOpenT.current)
    cancelRailHoverClose() // закрыть create/search flyout если открыт
    cancelRailHoverOpen()
    const open = () => {
      railFlyoutOpenT.current = null
      const rect = el.getBoundingClientRect()
      // Панель не должна уйти за низ окна — оставляем ей минимум ~320px
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 320))
      setRailCreateMenu(null)
      setRailSearchFlyout(null)
      setRailFlyout({ projectId, top, maxHeight: window.innerHeight - top - 12 })
    }
    // immediate — по клику на плитку: без задержки ховера
    if (immediate) { open(); return }
    railFlyoutOpenT.current = window.setTimeout(open, 120)
  }

  const scheduleCloseRailFlyout = () => {
    if (railFlyoutOpenT.current) { clearTimeout(railFlyoutOpenT.current); railFlyoutOpenT.current = null }
    if (railFlyoutCloseT.current) clearTimeout(railFlyoutCloseT.current)
    railFlyoutCloseT.current = window.setTimeout(() => {
      railFlyoutCloseT.current = null
      setRailFlyout(null)
    }, 180)
  }

  const closeRailFlyout = () => {
    clearRailFlyoutTimers()
    setRailFlyout(null)
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
    setKbIndex(-1)
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
    // V2-плотность: ВСЕ айтемы однострочные — единая высота у всего списка.
    // (V1 с превью у активного чата давала смесь высоких/низких строк и
    // прыжки списка при переключении.) Превью доступно через title-tooltip.
    const tooltip = preview ? `${chat.title}\n${preview}` : chat.title
    const isActive = currentChatId === chat.id
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
          className={`sidebar-chat-item ${isActive ? 'sidebar-chat-item--active' : ''} ${selectedIds.has(chat.id) ? 'sidebar-chat-item--selected' : ''} ${kbIndex >= 0 && visibleChatIds[kbIndex] === chat.id ? 'sidebar-chat-item--kb' : ''}`}
          data-chat-id={chat.id}
          title={tooltip}
          onMouseEnter={() => preloadChatOnHover(chat.id)}
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
    // Цвет проекта — детерминированный из id, одинаковый между сессиями
    const dotColor = projectColor(project.id)
    const dotGlow = projectColor(project.id, 0.35)
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
          <span
            className="sidebar-project-dot"
            style={{ background: dotColor, boxShadow: `0 0 8px ${dotGlow}` }}
          />
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
          {items.length > 0 && (
            <span className="sidebar-project-count" title={`${items.length} чат.`}>{items.length}</span>
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
        {/* Инлайн-редактор команды проверки — открывается из контекстного
            меню проекта. Статичное отображение убрано ради компактности. */}
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
    <aside className={`sidebar ${rail ? 'sidebar--rail' : ''}`}>
      <div className={`sidebar-full ${rail ? 'sidebar-full--hidden' : ''}`} aria-hidden={rail}>
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
          <IconButton
            icon="panelLeft"
            label="Свернуть панель"
            onClick={() => setRail(true)}
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
          ref={searchInputRef}
          className="sidebar-search-input"
          placeholder="Поиск чатов…  Ctrl+K"
          value={search}
          onChange={e => { setSearch(e.target.value); setKbIndex(-1) }}
          onKeyDown={onSearchKeyDown}
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
            onClick={() => { setSearch(''); setKbIndex(-1) }}
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
          flatSorted.length === 0 ? (
            <div className="sidebar-empty">
              {search ? 'Ничего не найдено' : chatFilter === 'favorites' ? 'Нет избранных чатов' : 'Архив пуст'}
            </div>
          ) : (
            /* Плоский список с дата-группами: Сегодня / Вчера / Неделя / Ранее */
            DATE_GROUPS.map(({ key, label }) => {
              const items = flatSorted.filter(c => dateGroup(c.updatedAt) === key)
              if (items.length === 0) return null
              return (
                <div key={key} className="sidebar-date-group">
                  <div className="sidebar-date-label">{label}</div>
                  {items.map(renderChatItem)}
                </div>
              )
            })
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
                  {noProjectChats.length > 0 && (
                    <span className="sidebar-project-count">{noProjectChats.length}</span>
                  )}
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
          onSettings: (p) => setSettingsModalProject(p),
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

      <ProjectSettingsModal
        open={!!settingsModalProject}
        project={settingsModalProject}
        onClose={() => setSettingsModalProject(null)}
        onSaved={(updated) => {
          onProjectsUpdate?.(projects.map(p => p.id === updated.id ? { ...p, ...updated } : p))
        }}
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
        onSetFilter={(f) => { setChatFilter(f); setKbIndex(-1); clearSelection() }}
        onToggleProject={toggleProjectHidden}
        onShowAllProjects={() => { setHiddenProjects(new Set()); clearSelection() }}
        onResetAll={resetAllFilters}
      />

      <UserCard />
      </div>{/* /.sidebar-full */}

      {/* Rail — узкая панель 48px. Показывается вместо полного содержимого:
          быстрые действия сверху + цветные плитки проектов. Клик по плитке
          раскрывает сайдбар и выбирает проект. */}
      <AnimatePresence>
        {rail && (
          <motion.div
            className="sidebar-rail"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
          >
            <motion.button
              className="sidebar-rail-btn"
              title="Развернуть панель"
              onClick={() => { setRail(false); setRailFlyout(null); setRailCreateMenu(null) }}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name="panelLeft" size="sm" />
            </motion.button>

            <div className="sidebar-rail-sep" />

            <motion.button
              className="sidebar-rail-btn"
              data-rail-create-btn
              title="Новый чат"
              onClick={(e) => {
                // Toggle: повторный клик по кнопке закрывает меню
                if (railCreateMenu) { setRailCreateMenu(null); return }
                hoverRailButton('create', e.currentTarget, true)
              }}
              onMouseEnter={(e) => hoverRailButton('create', e.currentTarget)}
              onMouseLeave={scheduleHoverClose}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name="messageSquare" size="sm" />
            </motion.button>

            <motion.button
              className="sidebar-rail-btn"
              data-rail-search-btn
              title="Поиск чатов (Ctrl+K)"
              onClick={(e) => {
                if (railSearchFlyout) { setRailSearchFlyout(null); return }
                hoverRailButton('search', e.currentTarget, true)
              }}
              onMouseEnter={(e) => hoverRailButton('search', e.currentTarget)}
              onMouseLeave={scheduleHoverClose}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name="search" size="sm" />
            </motion.button>

            <motion.button
              className="sidebar-rail-btn"
              title="Расширения (MCP и Skills)"
              onClick={() => setExtPopoverOpen(true)}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name="puzzle" size="sm" />
            </motion.button>

            <div className="sidebar-rail-sep" />

            <div className="sidebar-rail-projects" onScroll={closeRailFlyout}>
              {projects.filter(p => !hiddenProjects.has(p.id)).map(p => {
                const color = projectColor(p.id)
                const isActive = activeProjectId === p.id
                const count = projectChats(p).length
                // Точка на плитке: внутри проекта сейчас открыт активный чат
                const hasActiveChat = chats.some(c => c.id === currentChatId && (c.projectId ?? null) === p.id)
                return (
                  <motion.button
                    key={p.id}
                    className={`sidebar-rail-proj ${isActive ? 'sidebar-rail-proj--active' : ''}`}
                    title={`${p.name}${count > 0 ? ` — ${count} чат.` : ''}`}
                    style={{
                      background: `color-mix(in srgb, ${color} 20%, var(--bg-primary))`,
                      color: `color-mix(in srgb, ${color} 70%, var(--text-primary))`,
                      borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
                    }}
                    onClick={(e) => { onSelectProject?.(p.id); openRailFlyout(p.id, e.currentTarget, true) }}
                    onMouseEnter={(e) => { openRailFlyout(p.id, e.currentTarget); cancelRailHoverClose() }}
                    onMouseLeave={() => { scheduleCloseRailFlyout(); scheduleHoverClose() }}
                    whileHover={{ scale: 1.12 }}
                    whileTap={{ scale: 0.9 }}
                    transition={springHover}
                  >
                    {p.name.charAt(0).toUpperCase()}
                    {hasActiveChat && <span className="sidebar-rail-proj-live" />}
                  </motion.button>
                )
              })}
              {/* Без проекта — плитка с layers-иконкой, нейтральный цвет.
                  Открывает флайаут с чатами без project_id (тот же механизм). */}
              {!hiddenProjects.has('__noproject__') && noProjectChats.length > 0 && (
                <motion.button
                  className="sidebar-rail-proj sidebar-rail-proj--noproject"
                  title={`Без проекта — ${noProjectChats.length} чат.`}
                  onClick={(e) => { openRailFlyout('__noproject__', e.currentTarget, true) }}
                  onMouseEnter={(e) => { openRailFlyout('__noproject__', e.currentTarget); cancelRailHoverClose() }}
                  onMouseLeave={() => { scheduleCloseRailFlyout(); scheduleHoverClose() }}
                  whileHover={{ scale: 1.12 }}
                  whileTap={{ scale: 0.9 }}
                  transition={springHover}
                >
                  <AppIcon name="layers" size="xs" />
                  {chats.some(c => c.id === currentChatId && (c.projectId ?? null) === null) && (
                    <span className="sidebar-rail-proj-live" />
                  )}
                </motion.button>
              )}
            </div>

            {/* Аватар профиля: ховер → сбоку панель с юзер-инфо */}
            <RailUserAvatar />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Ховер-флайаут проекта в rail: панель с чатами сбоку от плитки.
          Клик по чату переключает его БЕЗ раскрытия сайдбара. */}
      <RailProjectFlyout
        state={rail ? railFlyout : null}
        project={
          railFlyout?.projectId === '__noproject__'
            ? ({ id: '__noproject__', name: 'Без проекта', workdir: '', createdAt: 0, lastUsed: 0 } as Project)
            : projects.find(p => p.id === railFlyout?.projectId) ?? null
        }
        chats={chats}
        currentChatId={currentChatId}
        runStatusByChat={runStatusByChat}
        unreadStatusByChat={unreadStatusByChat}
        onKeepOpen={() => {
          if (railFlyoutCloseT.current) { clearTimeout(railFlyoutCloseT.current); railFlyoutCloseT.current = null }
          cancelRailHoverClose()
        }}
        onLeave={() => { scheduleCloseRailFlyout(); scheduleHoverClose() }}
        onOpenChat={(id) => { onSelectChat?.(id); closeRailFlyout() }}
        onExpand={(id) => { onSelectProject?.(id === '__noproject__' ? null : id); setRail(false); setRailFlyout(null); setRailCreateMenu(null) }}
        onNewChat={(id) => {
          if (id === '__noproject__') onNewChatWithoutProject?.()
          else onNewChat?.(id)
          closeRailFlyout()
        }}
      />

      {/* Меню быстрого создания в rail (клик/ховер по messageSquare): обычный чат,
          чат в проекте или новый проект — сайдбар не разворачивается. */}
      <RailCreateMenu
        state={rail ? railCreateMenu : null}
        projects={projects.filter(p => !hiddenProjects.has(p.id))}
        onNewChat={(id) => { setRailCreateMenu(null); onNewChat?.(id) }}
        onNewChatWithoutProject={() => { setRailCreateMenu(null); onNewChatWithoutProject?.() }}
        onNewProjectMenu={(pos) => { setRailCreateMenu(null); setNewProjectMenu(pos) }}
        onKeepOpen={cancelRailHoverClose}
        onLeave={scheduleHoverClose}
      />

      {/* Поисковый флайаут в rail (ковер/клик по search или Ctrl+K). */}
      <RailSearchFlyout
        state={rail ? railSearchFlyout : null}
        chats={chats}
        currentChatId={currentChatId}
        runStatusByChat={runStatusByChat}
        unreadStatusByChat={unreadStatusByChat}
        onKeepOpen={cancelRailHoverClose}
        onLeave={scheduleHoverClose}
        onOpenChat={(id) => { onSelectChat?.(id); setRailSearchFlyout(null) }}
        inputRef={railSearchInputRef}
      />
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
    onSettings: (p: Project) => void
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
          <button className="ctx-item" onClick={() => { handlers.onSettings(project); handlers.onClose() }}>
            <AppIcon name="settings" size="sm" />
            <span>Настройки проекта</span>
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

// Ховер-флайаут проекта в rail-режиме: наведение на цветную плитку →
// сбоку выезжает панель с чатами проекта (заголовок + workdir + список).
// Клик по чату переключает его БЕЗ раскрытия сайдбара — быстрый
// переключатель из свёрнутого состояния. Клик по шапке — раскрыть.
function RailProjectFlyout({
  state, project, chats, currentChatId, runStatusByChat, unreadStatusByChat,
  onKeepOpen, onLeave, onOpenChat, onExpand, onNewChat,
}: {
  state: { projectId: string; top: number; maxHeight: number } | null
  project: Project | null
  chats: Chat[]
  currentChatId?: string | null
  runStatusByChat: Record<string, RunStatusInfo>
  unreadStatusByChat: Record<string, RunStatus>
  onKeepOpen: () => void
  onLeave: () => void
  onOpenChat: (chatId: string) => void
  onExpand: (projectId: string) => void
  onNewChat: (projectId: string) => void
}) {
  // Считаем без guard-выхода: AnimatePresence должен оставаться смонтированным,
  // чтобы проигрывать exit-анимацию исчезновения панели.
  const isNoProject = project?.id === '__noproject__'
  const items = project
    ? chats
        .filter(c => (isNoProject
          ? (c.projectId ?? null) === null
          : (c.projectId ?? null) === project.id) && !c.isArchived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : []
  const color = project
    ? (isNoProject ? 'var(--text-muted)' : projectColor(project.id))
    : 'transparent'
  return createPortal(
    <AnimatePresence>
      {state && project && (
        <motion.div
          key={project.id}
          className="sidebar-rail-flyout"
          style={{ top: state.top, maxHeight: state.maxHeight }}
          onMouseEnter={onKeepOpen}
          onMouseLeave={onLeave}
          initial={{ opacity: 0, x: -10, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: -10, scale: 0.98, transition: { duration: 0.14 } }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        >
      <button className="srf-header" onClick={() => onExpand(project.id)} title="Раскрыть сайдбар">
        <span className="srf-dot" style={{ background: color }} />
        <span className="srf-name">{project.name}</span>
        {items.length > 0 && <span className="srf-count">{items.length}</span>}
        <AppIcon name="chevronRight" size="xs" tone="muted" />
      </button>
      {!isNoProject && (
        <div className="srf-workdir" title={project.workdir}>{project.workdir}</div>
      )}
      <div className="srf-list">
        {items.length === 0 && <div className="srf-empty">Нет чатов</div>}
        {items.map(chat => {
          const status = runStatusByChat[chat.id]?.status
          const unread = unreadStatusByChat[chat.id]
          // V2-плотность (как в основном списке): однострочные айтемы,
          // превью — в title-tooltip.
          const preview = chat.lastMessage ? cleanPreview(chat.lastMessage) : ''
          const tooltip = preview ? `${chat.title}\n${preview}` : chat.title
          return (
            <button
              key={chat.id}
              className={`srf-chat ${currentChatId === chat.id ? 'srf-chat--active' : ''}`}
              title={tooltip}
              onClick={() => onOpenChat(chat.id)}
            >
              <div className="srf-chat-main">
                <div className="srf-chat-title">
                  {!!chat.isPinned && <AppIcon name="pin" size="xs" tone="accent" />}
                  <span className="srf-chat-title-text">{chat.title}</span>
                </div>
              </div>
              <div className="srf-chat-meta">
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
                <span className="srf-chat-time">{formatTime(chat.updatedAt)}</span>
              </div>
            </button>
          )
        })}
      </div>
      <button className="srf-new" onClick={() => onNewChat(project.id)}>
        <AppIcon name="plus" size="xs" />
        <span>Новый чат</span>
      </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

// Меню быстрого создания чата в rail (клик/ховер по messageSquare):
// обычный чат / чат в конкретном проекте / новый проект. Сайдбар остаётся
// свёрнутым. «Новый проект» открывает существующее NewProjectMenu рядом —
// data-new-project-btn exempts пункт от outside-close того меню.
function RailCreateMenu({
  state, projects, onNewChat, onNewChatWithoutProject, onNewProjectMenu,
  onKeepOpen, onLeave,
}: {
  state: { top: number; maxHeight: number } | null
  projects: Project[]
  onNewChat: (projectId: string) => void
  onNewChatWithoutProject: () => void
  onNewProjectMenu: (pos: { x: number; y: number }) => void
  onKeepOpen: () => void
  onLeave: () => void
}) {
  return createPortal(
    <AnimatePresence>
      {state && (
        <motion.div
          data-rail-create-menu
          className="sidebar-rail-flyout srcm"
          style={{ top: state.top, maxHeight: state.maxHeight }}
          onMouseEnter={onKeepOpen}
          onMouseLeave={onLeave}
          initial={{ opacity: 0, x: -10, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: -10, scale: 0.98, transition: { duration: 0.14 } }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        >
          <div className="srcm-title">Создать</div>
          <button className="srcm-item" onClick={onNewChatWithoutProject}>
            <AppIcon name="messageSquare" size="sm" />
            <span className="srcm-item-text">Новый чат</span>
          </button>
          {projects.length > 0 && (
            <>
              <div className="srcm-label">Чат в проекте</div>
              <div className="srcm-list">
                {projects.map(p => (
                  <button key={p.id} className="srcm-item" onClick={() => onNewChat(p.id)}>
                    <span className="srcm-dot" style={{ background: projectColor(p.id) }} />
                    <span className="srcm-item-text">{p.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="srcm-sep" />
          <button
            className="srcm-item"
            data-new-project-btn
            onClick={() => onNewProjectMenu({ x: 60, y: state.top + 12 })}
          >
            <AppIcon name="plus" size="sm" />
            <span className="srcm-item-text">Новый проект</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

// Поисковый флайаут в rail (ховер/клик по search или Ctrl+K): инпут +
// отфильтрованный список всех чатов. Сайдбар не разворачивается.
// ↑↓ — навигация, Enter — выбор, Esc — сброс/закрытие.
function RailSearchFlyout({
  state, chats, currentChatId, runStatusByChat, unreadStatusByChat,
  onKeepOpen, onLeave, onOpenChat, inputRef,
}: {
  state: { top: number; maxHeight: number } | null
  chats: Chat[]
  currentChatId?: string | null
  runStatusByChat: Record<string, RunStatusInfo>
  unreadStatusByChat: Record<string, RunStatus>
  onKeepOpen: () => void
  onLeave: () => void
  onOpenChat: (chatId: string) => void
  inputRef: React.RefObject<HTMLInputElement>
}) {
  const [query, setQuery] = useState('')
  const [kbIdx, setKbIdx] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)

  // Сброс при закрытии: используем key-проп вместо effect (state → remount).
  // Когда флайаут закрывается и открывается заново — компонент получает
  // новый key (через AnimatePresence key), state сбрасывается естественнно.

  // Фильтр: только не-архивные, по заголовку
  const q = query.toLowerCase()
  const filtered = chats.filter(c => !c.isArchived && (!q || c.title.toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (filtered.length === 0) return
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(Math.max(kbIdx + dir, 0), filtered.length - 1)
      setKbIdx(next)
      listRef.current?.querySelector(`[data-chat-id="${filtered[next].id}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      const id = kbIdx >= 0 ? filtered[kbIdx].id : filtered[0]?.id
      if (id) onOpenChat(id)
    } else if (e.key === 'Escape') {
      if (query) { setQuery(''); setKbIdx(-1) }
      else onLeave()
    }
  }

  return createPortal(
    <AnimatePresence>
      {state && (
        <motion.div
          data-rail-search-flyout
          className="sidebar-rail-flyout srf-search"
          style={{ top: state.top, maxHeight: state.maxHeight }}
          onMouseEnter={onKeepOpen}
          onMouseLeave={onLeave}
          initial={{ opacity: 0, x: -10, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: -10, scale: 0.98, transition: { duration: 0.14 } }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        >
          <div className="srf-search-bar">
            <AppIcon name="search" size="xs" tone="muted" />
            <input
              ref={inputRef}
              className="srf-search-input"
              placeholder="Поиск чатов…"
              value={query}
              onChange={e => { setQuery(e.target.value); setKbIdx(-1) }}
              onKeyDown={onKey}
            />
          </div>
          <div className="srf-list" ref={listRef}>
            {filtered.length === 0 && <div className="srf-empty">{query ? 'Ничего не найдено' : 'Нет чатов'}</div>}
            {filtered.map((chat, i) => {
              const status = runStatusByChat[chat.id]?.status
              const unread = unreadStatusByChat[chat.id]
              // V2-плотность (как в основном списке): однострочные айтемы,
              // превью — в title-tooltip.
              const preview = chat.lastMessage ? cleanPreview(chat.lastMessage) : ''
              const tooltip = preview ? `${chat.title}\n${preview}` : chat.title
              return (
                <button
                  key={chat.id}
                  data-chat-id={chat.id}
                  className={`srf-chat ${currentChatId === chat.id ? 'srf-chat--active' : ''} ${kbIdx === i ? 'srf-chat--kb' : ''}`}
                  title={tooltip}
                  onClick={() => onOpenChat(chat.id)}
                >
                  <div className="srf-chat-main">
                    <div className="srf-chat-title">
                      {!!chat.isPinned && <AppIcon name="pin" size="xs" tone="accent" />}
                      <span className="srf-chat-title-text">{chat.title}</span>
                    </div>
                  </div>
                  <div className="srf-chat-meta">
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
                    <span className="srf-chat-time">{formatTime(chat.updatedAt)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

// Аватар профиля внизу rail-панели. Ховер → сбоку выезжает панель с
// юзер-инфо (имя, план, баланс, лимиты) — переиспользует разметку и стили
// UserCard (классы usercard-panel-*), но в непрозрачном контейнере.
// Отдельный компонент (не внутри Sidebar): подписки на auth/billing сторы
// не должны ре-рендерить весь список чатов.
function RailUserAvatar() {
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const openSettings = useNavStore(s => s.openSettings)
  const planUsage = useBillingStore(s => s.planUsage)

  const [pos, setPos] = useState<{ bottom: number; maxHeight: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const openT = useRef<number | null>(null)
  const closeT = useRef<number | null>(null)

  const planName = planUsage?.plan?.name
  const fiveHourLimit = planUsage?.usage?.five_hour?.limit ?? 0
  const fiveHourUsed = planUsage?.usage?.five_hour?.used ?? 0
  const fiveHourPct = planUsage && fiveHourLimit > 0
    ? Math.min(100, (fiveHourUsed / fiveHourLimit) * 100)
    : null
  const fiveHourCritical = fiveHourPct !== null && fiveHourPct >= 90
  const fiveHourWarning = fiveHourPct !== null && fiveHourPct >= 70 && fiveHourPct < 90
  const weeklyLimit = planUsage?.usage?.weekly?.limit ?? 0
  const weeklyUsed = planUsage?.usage?.weekly?.used ?? 0
  const weeklyLimitPct = planUsage && weeklyLimit > 0
    ? Math.min(100, (weeklyUsed / weeklyLimit) * 100)
    : null
  const weeklyCritical = weeklyLimitPct !== null && weeklyLimitPct >= 90
  const weeklyWarning = weeklyLimitPct !== null && weeklyLimitPct >= 70 && weeklyLimitPct < 90
  const balanceVal = planUsage?.balance?.balance
  const heldVal = planUsage?.balance?.held ?? 0

  // Таймеры не должны стрелять после размонтирования
  useEffect(() => () => {
    if (openT.current) clearTimeout(openT.current)
    if (closeT.current) clearTimeout(closeT.current)
  }, [])

  const openPanel = () => {
    if (!user) return
    if (closeT.current) { clearTimeout(closeT.current); closeT.current = null }
    if (openT.current) clearTimeout(openT.current)
    openT.current = window.setTimeout(() => {
      openT.current = null
      const rect = btnRef.current?.getBoundingClientRect()
      if (!rect) return
      // Панель растёт ВВЕРХ от аватара (bottom-anchored); при нехватке
      // высоты — скроллится внутри (maxHeight).
      setPos({ bottom: window.innerHeight - rect.top + 10, maxHeight: rect.top - 16 })
    }, 200)
  }

  const scheduleClose = () => {
    if (openT.current) { clearTimeout(openT.current); openT.current = null }
    if (closeT.current) clearTimeout(closeT.current)
    closeT.current = window.setTimeout(() => {
      closeT.current = null
      setPos(null)
    }, 180)
  }

  const closeNow = () => {
    if (openT.current) { clearTimeout(openT.current); openT.current = null }
    if (closeT.current) { clearTimeout(closeT.current); closeT.current = null }
    setPos(null)
  }

  if (!user) {
    return (
      <motion.button
        ref={btnRef}
        type="button"
        className="sidebar-rail-avatar"
        title="Войти в Syntee-Gateway"
        onClick={() => openSettings('profile')}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92 }}
        transition={springHover}
      >
        <span className="sidebar-rail-avatar-guest">
          <AppIcon name="user" size="sm" />
        </span>
      </motion.button>
    )
  }

  const handle = user.username ? `@${user.username}` : user.email.split('@')[0]
  const displayName = user.display_name || handle

  return (
    <>
      <motion.button
        ref={btnRef}
        type="button"
        className="sidebar-rail-avatar"
        title={displayName}
        onClick={openPanel}
        onMouseEnter={openPanel}
        onMouseLeave={scheduleClose}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92 }}
        transition={springHover}
      >
        <Identicon seed={user.id || user.email} src={user.avatar_url} size={28} alt={displayName} />
      </motion.button>

      {createPortal(
        <AnimatePresence>
          {pos && (
            <motion.div
              className="sidebar-rail-user"
              style={{ bottom: pos.bottom, maxHeight: pos.maxHeight }}
              onMouseEnter={() => {
                if (closeT.current) { clearTimeout(closeT.current); closeT.current = null }
              }}
              onMouseLeave={scheduleClose}
              initial={{ opacity: 0, x: -10, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -10, scale: 0.96, transition: { duration: 0.14 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            >
            <div className="usercard-panel-header">
              <Identicon seed={user.id || user.email} src={user.avatar_url} size={40} alt={displayName} />
              <div className="usercard-panel-user">
                <div className="usercard-panel-name">{displayName}</div>
                <div className="usercard-panel-email">{handle}</div>
                {planName && (
                  <span className="usercard-panel-plan">{planName}</span>
                )}
                {balanceVal !== undefined && (
                  <div className="usercard-panel-balance">
                    <span className="usercard-panel-balance-value">${balanceVal.toFixed(4)}</span>
                    {heldVal > 0 && (
                      <span className="usercard-panel-balance-held">· холд ${heldVal.toFixed(4)}</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {fiveHourPct !== null && (
              <div className="usercard-panel-limit">
                <div className="usercard-panel-limit-header">
                  <span className="usercard-panel-limit-label">5 часов</span>
                  <span
                    className={`usercard-panel-limit-pct ${
                      fiveHourCritical ? 'usercard-panel-limit-pct--critical' :
                      fiveHourWarning ? 'usercard-panel-limit-pct--warning' : ''
                    }`}
                  >
                    {Math.round(fiveHourPct)}%
                  </span>
                </div>
                <div className="usercard-panel-limit-bar">
                  <div
                    className={`usercard-panel-limit-fill ${
                      fiveHourCritical ? 'usercard-panel-limit-fill--critical' :
                      fiveHourWarning ? 'usercard-panel-limit-fill--warning' : ''
                    }`}
                    style={{ width: `${fiveHourPct}%` }}
                  />
                </div>
                <div className="usercard-panel-limit-foot">
                  <span>{fmtCost(fiveHourUsed)} / {fmtCost(fiveHourLimit)}</span>
                  {planUsage?.usage?.five_hour?.reset_at && (
                    <span className="usercard-panel-limit-reset">
                      сброс {fmtReset(planUsage.usage.five_hour.reset_at)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {weeklyLimitPct !== null && (
              <div className="usercard-panel-limit usercard-panel-limit--last">
                <div className="usercard-panel-limit-header">
                  <span className="usercard-panel-limit-label">Неделя</span>
                  <span
                    className={`usercard-panel-limit-pct ${
                      weeklyCritical ? 'usercard-panel-limit-pct--critical' :
                      weeklyWarning ? 'usercard-panel-limit-pct--warning' : ''
                    }`}
                  >
                    {Math.round(weeklyLimitPct)}%
                  </span>
                </div>
                <div className="usercard-panel-limit-bar">
                  <div
                    className={`usercard-panel-limit-fill ${
                      weeklyCritical ? 'usercard-panel-limit-fill--critical' :
                      weeklyWarning ? 'usercard-panel-limit-fill--warning' : ''
                    }`}
                    style={{ width: `${weeklyLimitPct}%` }}
                  />
                </div>
                <div className="usercard-panel-limit-foot">
                  <span>{fmtCost(weeklyUsed)} / {fmtCost(weeklyLimit)}</span>
                  {planUsage?.usage?.weekly?.reset_at && (
                    <span className="usercard-panel-limit-reset">
                      сброс {fmtReset(planUsage.usage.weekly.reset_at)}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="usercard-panel-actions">
              <motion.button
                className="usercard-panel-action"
                onClick={() => { closeNow(); openSettings('profile') }}
                whileHover={whileHoverListItem}
                whileTap={whileTapListItem}
                transition={springHover}
              >
                <AppIcon name="user" size="sm" />
                <span>Профиль</span>
              </motion.button>
              <motion.button
                className="usercard-panel-action"
                onClick={() => { closeNow(); openSettings('general') }}
                whileHover={whileHoverListItem}
                whileTap={whileTapListItem}
                transition={springHover}
              >
                <AppIcon name="settings" size="sm" />
                <span>Настройки</span>
              </motion.button>
              <div className="usercard-panel-divider" />
              <motion.button
                className="usercard-panel-action usercard-panel-action--danger"
                onClick={() => { closeNow(); logout() }}
                whileHover={whileHoverListItem}
                whileTap={whileTapListItem}
                transition={springHover}
              >
                <AppIcon name="power" size="sm" />
                <span>Выйти</span>
              </motion.button>
            </div>
          </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

export default memo(Sidebar)
