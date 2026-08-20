import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Reply, Copy } from 'lucide-react'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { AnimatePresence, motion } from 'framer-motion'
import { springHover, whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, whileHoverListItem, whileTapListItem } from '../../utils/motionPresets'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import { v4 as uuid } from 'uuid'
import { useContextCounter } from '../../hooks/useContextCounter'
import { useChatAutoscroll } from '../../hooks/useChatAutoscroll'
import { useBackgroundLoadFullChat } from '../../hooks/useBackgroundLoadFullChat'
import { initChatSend, hydrateFromMain, enqueuePendingUserMsg } from '../../hooks/useChatRunSubscription'
import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import { playDoneSound } from '../../utils/sounds'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import { ChatRemeasureContext } from '../../components/ui/MessageBubble/remeasure'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import LiveTodoBar from '../../components/ui/LiveTodoBar/LiveTodoBar'
import AnimatedBackground from '../../components/ui/AnimatedBackground/AnimatedBackground'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import ToastContainer, { useToast } from '../../components/ui/Toast/Toast'
import ChatSearch from '../../components/ui/ChatSearch/ChatSearch'
import HelpModal from '../../components/ui/HelpModal/HelpModal'
import { PersonaSuggestionModal } from '../../components/ui/PersonaSuggestionModal/PersonaSuggestionModal'
import { detectPersona, isPersonaSuggestionsDisabled, disablePersonaSuggestions } from '../../utils/personaDetect'
import Logo from '../../components/ui/Logo/Logo'
import SplitChatPane from '../../components/ui/SplitChatPane/SplitChatPane'
import FileEditorPane from '../../components/ui/FileEditorPane/FileEditorPane'
import ChatMinimap from '../../components/ui/ChatMinimap/ChatMinimap'
import { useSettingsStore } from '../../store/settings.store'
import { useChatStore, EMPTY_LIVE, selectIsLargeChat } from '../../store/chat.store'
import { computeLiveChanges } from '../../utils/changes'
import { useExtensionsStore } from '../../store/extensions.store'
import { useNavStore } from '../../store/nav.store'
import { useUIStore } from '../../store/ui.store'
import { useTabsStore, tabActions } from '../../store/tabs.store'
import { useFileTabsStore } from '../../store/fileTabs.store'
import { parseSlashCommandWithCustom } from '../../../../shared/slashCommands'
import type { SlashCommand } from '../../../../shared/slashCommands'
import type { Chat, Message, ToolOutputMode, Project, QueueItemMeta, CheckpointMeta, Attachment } from '../../../../shared/types'
import { DEFAULT_PERSONA, isValidPersona, type PersonaId } from '../../../../shared/modes'
import { DEFAULT_HOTKEYS } from '../../../../shared/constants'
import './ChatPage.css'

const itemStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
}

const VirtualMessageItem = memo(function VirtualMessageItem({
  msg, vItemStart, vItemIndex, measureRef,
  toolOutputMode, onPin, onCopy, onReply, onRewind,
  searchQuery, liveThinking, isStreaming, isWaiting, rateLimitSec, shouldAnimate,
}: {
  msg: Message
  vItemStart: number
  vItemIndex: number
  measureRef: (el: Element | null) => void
  toolOutputMode: ToolOutputMode
  onPin?: (id: string) => void
  onCopy?: () => void
  onReply?: (message: Message) => void
  onRewind?: (userMessageId: string) => void
  searchQuery?: string
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming?: boolean
  isWaiting?: boolean
  rateLimitSec?: number
  shouldAnimate?: boolean
}) {
  return (
    <div
      data-index={vItemIndex}
      data-msg-id={msg.id}
      ref={measureRef}
      style={{ ...itemStyle, transform: `translateY(${vItemStart}px)` }}
    >
      <MessageBubble
        message={msg}
        toolOutputMode={toolOutputMode}
        onPin={onPin}
        onCopy={onCopy}
        onReply={onReply}
        onRewind={onRewind}
        searchQuery={searchQuery}
        liveThinking={liveThinking}
        isStreaming={isStreaming}
        isWaiting={isWaiting}
        rateLimitSec={rateLimitSec}
        shouldAnimate={shouldAnimate}
      />
    </div>
  )
}, (prev, next) =>
  prev.msg === next.msg &&
  prev.vItemStart === next.vItemStart &&
  // vItemIndex обязателен: индекс ряда (data-index) — единственный канал, по
  // которому виртуализатор сопоставляет DOM-ноду со слотом измерений. Если
  // индекс сменился при совпавшем start (редко, но возможно при сдвиге окна),
  // без этого сравнения data-index протухнет → RO-замеры уйдут в чужой слот.
  prev.vItemIndex === next.vItemIndex &&
  prev.toolOutputMode === next.toolOutputMode &&
  prev.onPin === next.onPin &&
  prev.onCopy === next.onCopy &&
  prev.onReply === next.onReply &&
  prev.onRewind === next.onRewind &&
  prev.searchQuery === next.searchQuery &&
  prev.liveThinking === next.liveThinking &&
  prev.isStreaming === next.isStreaming &&
  prev.isWaiting === next.isWaiting &&
  prev.rateLimitSec === next.rateLimitSec &&
  prev.shouldAnimate === next.shouldAnimate
)

function ChatPage({ embedded = false }: { embedded?: boolean }) {
  // Узкие селекторы: подписываемся только на нужные поля. Раньше был
  // useChatStore() без селектора — ре-рендер на любое изменение store
  // (чужой чат стримит → liveByChat меняется → ChatPage ре-рендер 20×/сек).
  // Теперь data-поля выбираем по одному, actions — через useShallow
  // (стабильные ссылки, shallow-сравнение всегда равно → без ре-рендеров).
  const currentChatId = useChatStore(s => s.currentChatId)
  const messages = useChatStore(s => s.messages)
  const hasOlderMessages = useChatStore(s => s.hasOlderMessages)
  const isLoadingOlder = useChatStore(s => s.isLoadingOlder)
  const chats = useChatStore(s => s.chats)
  // isLargeChat — по messageCount из списка chats (БД COUNT(*)). Большие чаты
  // (> LARGE_CHAT_THRESHOLD) не догружаются фоном целиком — для них остаётся
  // reverse-infinite scroll со спиннером; малые грузятся тихо в фоне.
  const isLargeChat = useChatStore(s => selectIsLargeChat(s.chats, s.currentChatId))
  const isIncognito = useChatStore(s => s.isIncognito)
  const activeMode = useChatStore(s => s.activeMode)
  const projects = useChatStore(s => s.projects)
  const activeProjectId = useChatStore(s => s.activeProjectId)
  // Сплит-режим: второй чат рядом с основным (50/50). Рендерим панель только
  // если сплит-чат жив, ≠ текущему (подписка в tabs.store закрывает такой
  // сплит, здесь — страховка от кадра-гонки) и не в архиве.
  const splitChatId = useChatStore(s => s.splitChatId)
  const setSplitChat = useChatStore(s => s.setSplitChat)
  // ── Файловые табы (просмотр/редактирование файлов как в VSCode) ──
  // activeFileTab — активный файловый таб (null = показывается чат).
  // При клике по файловому табу в шапке — показываем FileEditorPane
  // вместо сообщений чата. Клик по chat-табу — возвращает к чату.
  const activeFileTab = useFileTabsStore(s =>
    s.activeFileTabId ? s.openFileTabs.find(t => t.id === s.activeFileTabId) : null
  )
  // Live-состояние ТОЛЬКО текущего чата. Селектор возвращает ссылку на
  // liveByChat[currentChatId] — она меняется только при setLiveState для
  // ЭТОГО chatId (спред копирует ссылки остальных). Чужой чат стримит —
  // ref текущего не меняется → без ре-рендера.
  const live = (useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId] : undefined) ?? EMPTY_LIVE)
  const runStatus = useChatStore(s => s.currentChatId ? s.runStatusByChat[s.currentChatId] : undefined)
  const lastTurnChanges = useChatStore(s => s.currentChatId ? s.lastTurnChangesByChat[s.currentChatId] : null)
  // Live-изменения: вычисляем из live.steps во время выполнения запроса.
  // Бейдж показывается сразу при правках файлов, с shimmer/glow анимацией.
  const liveChanges = useMemo(() => computeLiveChanges(live.steps), [live.steps])
  const badgeChanges = lastTurnChanges ?? (live.isAgentRunning ? liveChanges : null)
  const badgeLive = live.isAgentRunning && !!liveChanges && !lastTurnChanges
  const { setChats, setCurrentChat, setMessages, setMessagesWindow, prependOlderMessages,
    setIsLoadingOlder, setHasOlderMessages, addMessage, pinMessage,
    setProjects, setActiveProject, markChatRead } = useChatStore(useShallow(s => ({
    setChats: s.setChats, setCurrentChat: s.setCurrentChat, setMessages: s.setMessages,
    setMessagesWindow: s.setMessagesWindow, prependOlderMessages: s.prependOlderMessages,
    setIsLoadingOlder: s.setIsLoadingOlder, setHasOlderMessages: s.setHasOlderMessages,
    addMessage: s.addMessage, pinMessage: s.pinMessage, setProjects: s.setProjects,
    setActiveProject: s.setActiveProject, markChatRead: s.markChatRead,
  })))
  const isTyping = live.isTyping
  const isAgentRunning = live.isAgentRunning
  const streamingText = live.text

  const { add: toast } = useToast()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const chatInputWrapRef = useRef<HTMLDivElement>(null)
  const [toolOutputMode, setToolOutputMode] = useState<ToolOutputMode>('normal')
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)
  const isInitialScrollRef = useRef(true)
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guard: при manual /compact мы сами вызываем setMessages(result.messages)
  // с синхронным возвратом IPC. Но main также эмитит CHAT_COMPACTED, и
  // листенер дёрнет getMessagesPage(20)→setMessagesWindow — второй апдейт
  // массива. С id-based getItemKey это безопасно, но лишний IPC-раунд и
  // ререндр. Флаг выставается до invoke, гасится в листенере.
  const manualCompactJustDoneRef = useRef(false)

  // Fix C: множество id сообщений, чья entrance-анимация уже отыграла.
  // Виртуализатор монтирует/демонтирует элементы при скролле; без этого
  // флага motion.div каждый раз пере-проигрывает initial→animate →
  // «интерфейс плывёт». Анимируем только первое появление сообщения.
  // При смене чата (currentChatId) множество чистится — новые сообщения
  // анимируются свежо, как и было раньше при полном перемонте.
  const animatedMsgIdsRef = useRef<Set<string>>(new Set())

  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIds, setSearchMatchIds] = useState<string[]>([])
  const [replyTo, setReplyTo] = useState<Message[]>([])
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string } | null>(null)
  // ── Per-chat UI state (переживает перезапуск приложения) ──
  // draft — текст в поле ввода (черновик). inputHistory — предыдущие
  // user-запросы чата (DESC, самый свежий первым), для навигации стрелками.
  // planning/image/askMode — тумблеры плюсик-меню инпут-бара.
  // Все четыре сохраняются в chats/messages через IPC. Для инкогнито —
  // только in-memory на сессию (после рестарта чисто).
  const [draft, setDraft] = useState('')
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [planningMode, setPlanningMode] = useState(false)
  const [imageMode, setImageMode] = useState(false)
  const [askMode, setAskMode] = useState(false)
  // Persona — single-select run mode (classic/architect/debugger/...).
  // Orthogonal to the three toggles above. Persisted per-chat in chats.persona.
  const [persona, setPersonaState] = useState<PersonaId>(DEFAULT_PERSONA)
  // ── Вложения черновика (attachments) — переживают рестарт как и draft. ──
  // Хранятся в chat_draft_attachments + файлы в userData/draft-attachments/.
  // При отправке передаются в chat.send, draft очищается.
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([])

  // ── Boot gate: сигнал App.tsx что ChatPage отрисовал контент ────────────
  // Двойной rAF после монтирования — к этому моменту первый paint уже прошёл,
  // store-данные (chats/messages из preload) отражены в DOM. App удерживает
  // BootScreen пока это false, иначе UI мелькал пустым шеллом. rAF даёт
  // браузеру шанс выполнить layout/paint перед снятием сплэша.
  useEffect(() => {
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(() => {
      useChatStore.getState().setBootRendered(true)
    }))
    return () => cancelAnimationFrame(raf2)
  }, [])
  // замыкание в useEffect видит значения на момент создания, а нам нужны
  // свежие draft/modes при переключении chatId.
  const draftRef = useRef('')
  const draftAttachmentsRef = useRef<Attachment[]>([])
  const planningModeRef = useRef(false)
  const imageModeRef = useRef(false)
  const askModeRef = useRef(false)
  const personaRef = useRef<PersonaId>(DEFAULT_PERSONA)
  const prevChatIdRef = useRef<string | null>(null)
  const prevIsIncognitoRef = useRef(false)
  // In-memory история для инкогнито-чатов (chatId → DESC массив), чтобы
  // стрелки работали в инкогнито в рамках сессии, но не писались в БД.
  const incognitoHistoryRef = useRef<Map<string, string[]>>(new Map())
  // Debounce-таймер для черновика — чтобы не писать в БД на каждый символ.
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Debounce-таймер для вложений черновика — аналогично draft.
  const attachmentsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => { draftAttachmentsRef.current = draftAttachments }, [draftAttachments])
  useEffect(() => { planningModeRef.current = planningMode }, [planningMode])
  useEffect(() => { imageModeRef.current = imageMode }, [imageMode])
  useEffect(() => { askModeRef.current = askMode }, [askMode])
  useEffect(() => { personaRef.current = persona }, [persona])

  const [showContextRing, setShowContextRing] = useState(true)
  const [mainModelId, setMainModelId] = useState('claude-sonnet-4-6')
  const [reasoningValue, setReasoningValue] = useState('')
  const [isCompacting, setIsCompacting] = useState(false)
  // Стрим резюме при manual /compact: AI пишет резюме контекста в реальном
  // времени, токены приходят через IPC chat:compact-stream и показываются
  // в compacting-индикаторе (внизу чата). Сбрасывается при start-сигнале,
  // смене чата и завершении /compact.
  const [compactingSummary, setCompactingSummary] = useState('')

  // ── Кастомные slash-команды (из .md-файлов через CommandManager) ──
  // Загружаются при mount и при смене workdir (проектные команды).
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([])
  // ── /help модалка ──
  const [showHelp, setShowHelp] = useState(false)
  // Persona auto-suggest modal: показываем когда detect находит персону по
  // первой реплике нового чата. Блокирующий — пользователь выбирает до send.
  const [personaSuggest, setPersonaSuggest] = useState<{ id: PersonaId; preview: string; pendingText: string } | null>(null)
  // Флаг для повторного handleSend после ответа в modal — пропускаем детект,
  // иначе уйдём в рекурсию (модал → accept → handleSend → детект → модал).
  const skipPersonaSuggestRef = useRef(false)
  // ── /restore пикер именованных снапшотов ──
  const [snapshotPicker, setSnapshotPicker] = useState<CheckpointMeta[] | null>(null)

  // Хендлеры ниже обёрнуты в useCallback — ChatInput/Sidebar/LiveTodoBar
  // мемоизированы (React.memo), нестабильные ссылки на функции пробивали
  // бы memo при каждом ре-рендере ChatPage (стриминг 20×/сек, скролл).
  const handleReasoningChange = useCallback((value: string) => {
    setReasoningValue(value)
    window.syntee.settings.set('reasoningValue', value).catch(() => {})
  }, [])

  const handleMainModelChange = useCallback(async (modelId: string, providerId: string) => {
    try {
      await window.syntee.models.setAssignment({ role: 'main', modelId, providerId })
      setMainModelId(modelId)
    } catch (e) {
      console.error('[ChatPage] setAssignment error', e)
    }
  }, [])

  useEffect(() => {
    window.syntee.settings.get('showContextRing').then((v: unknown) => {
      if (v !== null && v !== undefined) setShowContextRing(v as boolean)
    }).catch(() => {})
    window.syntee.settings.get('modelAssignments').then((v: unknown) => {
      if (Array.isArray(v)) {
        const main = (v as Array<{ role: string; modelId: string }>).find(a => a.role === 'main')
        if (main) setMainModelId(main.modelId)
      }
    }).catch(() => {})
    window.syntee.settings.get('reasoningValue').then((v: unknown) => {
      if (typeof v === 'string' && v) setReasoningValue(v)
    }).catch(() => {})
  }, [])

  // Уведомляем fast context watcher о смене активного проекта —
  // активный проект индексируется быстрее (priority, progress events).
  useEffect(() => {
    window.syntee.fastContext.setActive(activeProjectId).catch(() => {})
    // Перезагружаем списки MCP/skills для этого проекта — иначе бейдж и
    // ExtensionsPopover показывают только глобальные серверы, без проектных
    // из .mcp.json. Без этого проектные MCP появляются только после ручного
    // открытия popover.
    if (activeProjectId) {
      useExtensionsStore.getState().loadMcpServers(activeProjectId)
      useExtensionsStore.getState().loadSkills(activeProjectId)
    } else {
      useExtensionsStore.getState().loadMcpServers()
      useExtensionsStore.getState().loadSkills()
    }
  }, [activeProjectId])

  // rateLimitSec читаем напрямую из live (live.rateLimitSec) — раньше был
  // зеркальный local state + effect, что добавляло лишний ре-рендер на
  // каждый тик countdown'а при rate-limit.

  // Тосты при терминальных статусах запуска (ошибка/отмена) — только для текущего чата
  const prevRunStatusRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!runStatus) return
    const prev = prevRunStatusRef.current
    // Показываем тост только при переходе в error (не при cancel — это штатная остановка)
    if (runStatus.status === 'error' && prev !== 'error') {
      console.log('[chat-flow] runStatus=error chatId=%s error=%s', currentChatId, runStatus.error)
      toast('Ошибка: ' + (runStatus.error ?? 'неизвестная'), 'error')
    }
    prevRunStatusRef.current = runStatus.status
  }, [runStatus, toast])

  // Звук завершения — при переходе running → done/error для текущего чата
  const prevIsTypingRef = useRef(false)
  useEffect(() => {
    if (prevIsTypingRef.current && !isTyping) {
      playDoneSound()
      // При завершении стрима принудительно скроллим к низу — финальное
      // сообщение может быть за вьюпортом если пользователь отскроллил вверх
      // во время стриминга. Без этого сообщение рендерится но не видно.
      requestAnimationFrame(() => pinAutoscroll(true))
    }
    if (!prevIsTypingRef.current && isTyping) {
      // Стрим начался (в т.ч. queued-запрос стартовал). Если всё ещё
      // закреплены — прыгаем к низу: покажет user-сообщение + начало
      // ответа. Для queued-сообщений addMessage+initChatSend происходят
      // в useChatRunSubscription БЕЗ pinAutoscroll — это единственный
      // скролл для них. Если пользователь отскроллил вверх после отправки
      // (pinnedRef=false) — не навязываем скролл.
      requestAnimationFrame(() => { if (pinnedRef.current) pinAutoscroll(true) })
    }
    prevIsTypingRef.current = isTyping
    // pinAutoscroll объявлен ниже по коду (const), включать в deps нельзя —
    // упадёт с TDZ. Ссылка внутри тела эффекта безопасна (выполняется после рендера).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTyping])

  // CHAT_COMPACTED — реакция на сжатие контекста в main (как авто-компакция
  // внутри chat:send когда токенов накопилось > rollingTriggerPct, так и
  // ручной /compact из другого окна). Перечитываем ленту из БД, чтобы в
  // renderer-store появился новый system-разделитель «Контекст сжат» —
  // иначе при авто-компакции renderer не знает что divider был сохранён.
  useEffect(() => {
    const off = window.syntee.on('chat:compacted', (data: unknown) => {
      const d = data as { chatId: string; trigger: 'auto' | 'manual' }
      if (d.chatId !== currentChatId) return
      // Manual /compact: invoke уже сделал setMessages(allMessages) с divider'ом
      // в КОНЦЕ ленты (createdAt = Date.now()). НЕ дублируем getMessagesPage —
      // иначе перетрёт последними 20, а divider может быть не в последних 20
      // если сообщений > 20 (он в конце, но... нет, в конце — попадёт). Всё же
      // не рискуем — guard пропускает setMessagesWindow. Скроллим в низ (divider
      // там) + контекст-расчёт.
      if (manualCompactJustDoneRef.current) {
        manualCompactJustDoneRef.current = false
        isInitialScrollRef.current = true
        requestAnimationFrame(() => pinAutoscroll(true))
        window.syntee.context.calculate(d.chatId).catch(() => {})
        return
      }
      // Compact меняет историю (удаляет старые сообщения, добавляет divider
      // у хвоста). Сбрасываем окно к свежей последней странице — это корректно
      // отражает пост-compact состояние и авто-скроллит к низу.
      window.syntee.chat.getMessagesPage(d.chatId, 50).then((res: { messages: Message[]; hasMore: boolean }) => {
        if (useChatStore.getState().currentChatId !== d.chatId) return
        setMessagesWindow(d.chatId, res.messages, res.hasMore)
        isInitialScrollRef.current = true
        requestAnimationFrame(() => pinAutoscroll(true))
        if (d.trigger === 'auto') {
          toast('Контекст автоматически сжат', 'info')
        }
        // Двойная страховка: main уже эмитит CONTEXT_USAGE с source:'real'
        // после compaction, но если push не дошёл — попросим свежий расчёт.
        // lastRealRef в useContextCounter уже сброшен по этому же событию,
        // так что context:calculate (даже с source:'estimate') будет принят.
        window.syntee.context.calculate(d.chatId).catch(() => {})
      }).catch(() => {})
    })
    return () => { off() }
    // pinAutoscroll объявлен ниже по коду (const), включать его в deps нельзя —
    // deps вычисляется во время рендера и упал бы с TDZ (ReferenceError:
    // cannot access before initialization). Ссылка внутри тела эффекта
    // безопасна — оно выполняется после рендера.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId, setMessagesWindow, toast])

  // CHAT_COMPACT_STREAM — стрим резюме при manual /compact. AI пишет резюме
  // контекста в реальном времени; токены аккумулируются в compactingSummary и
  // показываются в compacting-индикаторе (внизу чата) как live-markdown. При
  // start-сигнале — сброс, при chunk — аккумулямуляция. Только для manual
  // /compact (авто-компакция стрим не шлёт — индикатора нет).
  useEffect(() => {
    const off = window.syntee.on('chat:compact-stream', (data: unknown) => {
      const d = data as { chatId: string; chunk?: string; start?: boolean }
      if (d.chatId !== currentChatId) return
      if (d.start) { setCompactingSummary(''); return }
      if (d.chunk) setCompactingSummary(s => s + d.chunk)
    })
    return () => { off() }
  }, [currentChatId])

  // Сброс стрима резюме при смене чата — иначе при возврате в чат, где
  // ранее было сжатие, в индикаторе остался бы прошлогодний текст.
  useEffect(() => { setCompactingSummary('') }, [currentChatId])

  // Смена чата — очищаем множество анимированных id, чтобы сообщения нового
  // чата анимировались при появлении (как при полном перемонте раньше).
  useEffect(() => { animatedMsgIdsRef.current = new Set() }, [currentChatId])

  // Счётчик контекста
  const contextInfo = useContextCounter({
    chatId: currentChatId || '',
    currentInput: draft,
    modelId: mainModelId,
    incognito: isIncognito,
    enabled: showContextRing && !isIncognito,
    messageCount: messages.length,
    isRunning: isTyping,
  })

  // ── Wrapper'ы режимов инпут-бара ──
  // Каждый тумблер сохраняет ТОЛЬКО свой режим в БД (chats.planning_mode /
  // image_mode / ask_mode) — индивидуальный IPC-сеттер, не затрагивая
  // остальные два. Раньше писали все 3 разом через setModes, что вызывало
  // кросс-контаминацию: stale ref'ы других режимов затирали значения
  // чужого чата при race condition. Инкогнито не пишется — только in-memory.
  const handlePlanningModeChange = useCallback((v: boolean) => {
    setPlanningMode(v)
    if (!currentChatId || isIncognito) return
    window.syntee.chat.setPlanningMode(currentChatId, v).catch(e => console.error('[planningMode] IPC fail:', e))
  }, [currentChatId, isIncognito])
  const handleImageModeChange = useCallback((v: boolean) => {
    setImageMode(v)
    if (!currentChatId || isIncognito) return
    window.syntee.chat.setImageMode(currentChatId, v).catch(e => console.error('[imageMode] IPC fail:', e))
  }, [currentChatId, isIncognito])
  const handleAskModeChange = useCallback((v: boolean) => {
    setAskMode(v)
    if (!currentChatId || isIncognito) return
    window.syntee.chat.setAskMode(currentChatId, v).catch(e => console.error('[askMode] IPC fail:', e))
  }, [currentChatId, isIncognito])

  // ── In-app hotkeys для переключения режимов чата ──────────────────────
  // Ctrl+1 — toggle Ask (режим чтения), Ctrl+2 — toggle Planning.
  // Хоткеи читаются из settings.hotkeys (настраиваются в Настройки → Горячие клавиши).
  // Работают только внутри приложения (не глобальные).
  // Не перехватываем в полях ввода, вне страницы чата, и когда правая панель
  // открыта (Ctrl+1..6 заняты переключением табов панели).
  useEffect(() => {
    const formatCombo = (e: KeyboardEvent): string => {
      const parts: string[] = []
      if (e.ctrlKey)  parts.push('Ctrl')
      if (e.altKey)   parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey)  parts.push('Meta')
      const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
      if (!['Control','Alt','Shift','Meta'].includes(e.key)) parts.push(key)
      return parts.join('+')
    }
    const handler = (e: KeyboardEvent) => {
      // Только на странице чата
      if (useNavStore.getState().mainPage !== 'chat') return
      // Если правая панель открыта — Ctrl+1..6 заняты табами, не мешаем
      const { agentPanelOpen } = useUIStore.getState()
      if (agentPanelOpen) return

      // Fallback к DEFAULT_HOTKEYS: если settings ещё не загружен (load()
      // не завершился или упал), hotkeys будет пустым — используем дефолты,
      // чтобы кейбинды работали сразу при старте, без открытия настроек.
      const hotkeys = (useSettingsStore.getState().settings['hotkeys'] as Record<string, string>)
        ?? DEFAULT_HOTKEYS as Record<string, string>
      const combo = formatCombo(e)

      // Режим чтения (Ask) — fallback к DEFAULT_HOTKEYS.chatAskMode
      const askKey = hotkeys.chatAskMode ?? DEFAULT_HOTKEYS.chatAskMode
      if (askKey && combo === askKey) {
        e.preventDefault()
        const next = !askModeRef.current
        handleAskModeChange(next)
        // Снимаем planning если включаем ask (взаимоисключающие по смыслу)
        if (next && planningModeRef.current) handlePlanningModeChange(false)
        return
      }
      // Режим планирования (Planning) — fallback к DEFAULT_HOTKEYS.chatPlanningMode
      const planKey = hotkeys.chatPlanningMode ?? DEFAULT_HOTKEYS.chatPlanningMode
      if (planKey && combo === planKey) {
        e.preventDefault()
        const next = !planningModeRef.current
        handlePlanningModeChange(next)
        // Снимаем ask если включаем planning
        if (next && askModeRef.current) handleAskModeChange(false)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleAskModeChange, handlePlanningModeChange])

  // ── Persona — single-select run mode. Persisted in chats.persona (one
  //  UPDATE per change). 'classic' is the neutral default (no badge, no
  //  injection). Invalid stored values fall back to 'classic' on load.
  const handlePersonaChange = useCallback((v: PersonaId) => {
    setPersonaState(v)
    personaRef.current = v
    if (!currentChatId || isIncognito) return
    window.syntee.chat.setPersona(currentChatId, v).catch(() => {})
  }, [currentChatId, isIncognito])

  // ── Persona auto-suggest modal handlers ──
  // accept: переключаем персону + повторный handleSend (skip-detect ref,
  // чтобы не уйти в рекурсию). dismiss: повторный handleSend с classic.
  // never: opt-out + повторный handleSend с classic.
  const handlePersonaSuggestAccept = useCallback(() => {
    if (!personaSuggest) return
    const { id, pendingText } = personaSuggest
    setPersonaSuggest(null)
    handlePersonaChange(id)
    skipPersonaSuggestRef.current = true
    void handleSend(pendingText)
  }, [personaSuggest, handlePersonaChange])

  const handlePersonaSuggestDismiss = useCallback(() => {
    if (!personaSuggest) return
    const { pendingText } = personaSuggest
    setPersonaSuggest(null)
    skipPersonaSuggestRef.current = true
    void handleSend(pendingText)
  }, [personaSuggest])

  const handlePersonaSuggestNever = useCallback(() => {
    if (!personaSuggest) return
    const { pendingText } = personaSuggest
    setPersonaSuggest(null)
    disablePersonaSuggestions()
    skipPersonaSuggestRef.current = true
    void handleSend(pendingText)
  }, [personaSuggest])

  // ── Черновик: debounced-сохранение в БД ──
  // 300мс задержка — чтобы не дёргать IPC на каждое нажатие. При смене
  // чата / размонтировании pending-таймер отменяется и сохранение идёт
  // синхронно в эффекте ниже.
  const handleDraftChange = useCallback((text: string) => {
    setDraft(text)
    draftRef.current = text
    if (currentChatId && !isIncognito) {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
      draftSaveTimerRef.current = setTimeout(() => {
        window.syntee.chat.setDraft(currentChatId, text).catch(() => {})
        draftSaveTimerRef.current = null
      }, 300)
    }
  }, [currentChatId, isIncognito])

  // ── Вложения черновика: debounced-сохранение в БД ──
  // Аналогично draft — 300мс дебаунс. При смене чата сохраняем синхронно.
  // Инкогнито-чаты: только in-memory (не персистим).
  const handleAttachmentsChange = useCallback((atts: Attachment[]) => {
    setDraftAttachments(atts)
    draftAttachmentsRef.current = atts
    if (currentChatId && !isIncognito) {
      if (attachmentsSaveTimerRef.current) clearTimeout(attachmentsSaveTimerRef.current)
      attachmentsSaveTimerRef.current = setTimeout(() => {
        window.syntee.draft.setAttachments(currentChatId, atts).catch(() => {})
        attachmentsSaveTimerRef.current = null
      }, 300)
    }
  }, [currentChatId, isIncognito])

  // ── Загрузка/сохранение per-chat UI state при смене чата ──
  // При переключении chatId: сначала сохраняем draft/modes предыдущего
  // чата (если не инкогнито), затем загружаем draft/modes/history нового.
  // Инкогнито-чаты: сбрасываем режимы/черновик в дефолт, историю берём
  // из in-memory Map (если уже обращались к этому инкогнито-чату).
  useEffect(() => {
    const prevId = prevChatIdRef.current
    const prevIncog = prevIsIncognitoRef.current
    // Сохраняем старый чат (если был и не инкогнито)
    if (prevId && prevId !== currentChatId && !prevIncog) {
      if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null }
      if (attachmentsSaveTimerRef.current) { clearTimeout(attachmentsSaveTimerRef.current); attachmentsSaveTimerRef.current = null }
      window.syntee.chat.setDraft(prevId, draftRef.current).catch(() => {})
      window.syntee.draft.setAttachments(prevId, draftAttachmentsRef.current).catch(() => {})
      // Режимы (planning/image/ask) НЕ сохраняем при свитче — они пишутся
      // немедленно при тумблинге через индивидуальные IPC-сеттеры. Save-on-switch
      // здесь вызывал race condition: stale ref'ы затирали режимы чужого чата.
      if (personaRef.current !== DEFAULT_PERSONA) {
        window.syntee.chat.setPersona(prevId, personaRef.current).catch(() => {})
      }
    }
    prevChatIdRef.current = currentChatId
    prevIsIncognitoRef.current = isIncognito

    if (!currentChatId) {
      setDraft('')
      setInputHistory([])
      setPlanningMode(false); setImageMode(false); setAskMode(false)
      setPersonaState(DEFAULT_PERSONA); personaRef.current = DEFAULT_PERSONA
      setDraftAttachments([])
      draftRef.current = ''
      draftAttachmentsRef.current = []
      return
    }
    // Отменяем pending-debounce от прежнего чата
    if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null }
    if (attachmentsSaveTimerRef.current) { clearTimeout(attachmentsSaveTimerRef.current); attachmentsSaveTimerRef.current = null }

    if (isIncognito) {
      // Инкогнито: дефолт-значения, история из in-memory Map
      setDraft('')
      setPlanningMode(false); setImageMode(false); setAskMode(false)
      setPersonaState(DEFAULT_PERSONA); personaRef.current = DEFAULT_PERSONA
      setDraftAttachments([])
      draftRef.current = ''
      draftAttachmentsRef.current = []
      setInputHistory(incognitoHistoryRef.current.get(currentChatId) ?? [])
      return
    }
    // Обычный чат: грузим modes/draft/history/attachments из БД параллельно.
    // Сначала сбрасываем режимы в false синхронно — чтобы UI не показывал
    // вспышку режимов предыдущего чата пока async-load не завершится.
    setPlanningMode(false); setImageMode(false); setAskMode(false)
    planningModeRef.current = false; imageModeRef.current = false; askModeRef.current = false
    let cancelled = false
    Promise.all([
      window.syntee.chat.getModes(currentChatId),
      window.syntee.chat.getDraft(currentChatId),
      window.syntee.chat.getInputHistory(currentChatId),
      window.syntee.draft.getAttachments(currentChatId),
      window.syntee.chat.getPersona(currentChatId),
      window.syntee.chat.getLastTurnChanges?.(currentChatId).catch(() => null),
    ]).then(([modes, draftText, history, attachments, loadedPersona, lastChanges]) => {
      if (cancelled || currentChatId !== prevChatIdRef.current) return
      useChatStore.getState().setLastTurnChanges(currentChatId, lastChanges ?? null)
      setPlanningMode(!!modes.planningMode)
      setImageMode(!!modes.imageMode)
      setAskMode(!!modes.askMode)
      planningModeRef.current = !!modes.planningMode
      imageModeRef.current = !!modes.imageMode
      askModeRef.current = !!modes.askMode
      const safePersona = isValidPersona(loadedPersona) ? loadedPersona : DEFAULT_PERSONA
      setPersonaState(safePersona)
      personaRef.current = safePersona
      const d = typeof draftText === 'string' ? draftText : ''
      setDraft(d)
      draftRef.current = d
      // Вложения черновика
      const atts = Array.isArray(attachments) ? attachments : []
      setDraftAttachments(atts)
      draftAttachmentsRef.current = atts
      // Дедупликация подряд идущих дубликатов + reverse → DESC (свежий первым)
      const raw = Array.isArray(history) ? history : []
      const dedup: string[] = []
      for (const s of raw) {
        if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s)
      }
      dedup.reverse()
      setInputHistory(dedup)
    }).catch(() => {
      if (cancelled) return
      setDraft(''); setPlanningMode(false); setImageMode(false); setAskMode(false)
      setPersonaState(DEFAULT_PERSONA); personaRef.current = DEFAULT_PERSONA
      setInputHistory([])
      setDraftAttachments([]); draftAttachmentsRef.current = []
    })
    return () => { cancelled = true }
  }, [currentChatId, isIncognito])

  // ── beforeunload: сохраняем черновик текущего чата при закрытии окна ──
  // Debounce 300мс может не успеть сработать перед закрытием. Fire-and-forget
  // через ipcRenderer.send — без ожидания ответа. Не гарантируется доставка,
  // но покрывает большинство случаев.
  useEffect(() => {
    const handler = () => {
      const id = prevChatIdRef.current
      if (id && !prevIsIncognitoRef.current) {
        try {
          window.syntee.chat.setDraft(id, draftRef.current).catch(() => {})
          window.syntee.draft.setAttachments(id, draftAttachmentsRef.current).catch(() => {})
          // Режимы НЕ сохраняем — они уже сохранены при тумблинге.
          if (personaRef.current !== DEFAULT_PERSONA) {
            window.syntee.chat.setPersona(id, personaRef.current).catch(() => {})
          }
        } catch { /* окно уже закрывается — ок */ }
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Selection reply — выделил текст в чате → popup с кнопкой Reply
  useEffect(() => {
    let lastFireTime = 0
    const handleMouseUp = (e: MouseEvent) => {
      // ChatPage keep-alive — игнорируем выделение, пока чат не активен.
      if (useNavStore.getState().mainPage !== 'chat') return
      const now = Date.now()
      if (now - lastFireTime < 100) return
      lastFireTime = now

      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!text || text.length < 5) { setSelectionPopup(null); return }
      const anchor = sel?.anchorNode?.parentElement
      if (!anchor?.closest('.chat-messages')) { setSelectionPopup(null); return }
      const range = sel?.getRangeAt(0)
      if (!range) return
      // Позиционируем popup по концу выделения (где курсор), а не по полному rect —
      // иначе при многострочном выделении popup улетает далеко.
      const endRange = document.createRange()
      endRange.setStart(range.endContainer, range.endOffset)
      endRange.setEnd(range.endContainer, range.endOffset)
      let r = endRange.getBoundingClientRect()
      // Если caret-rect пустой — fallback на полный rect
      if (!r || (r.width === 0 && r.height === 0)) {
        r = range.getBoundingClientRect()
      }
      if (!r) return
      const POPUP_W = 200, POPUP_H = 40, MARGIN = 8
      let px = r.left + r.width / 2
      let py = r.bottom + MARGIN
      if (py + POPUP_H > window.innerHeight - MARGIN) {
        py = r.top - POPUP_H - MARGIN
      }
      if (py < MARGIN) py = MARGIN
      px = Math.max(POPUP_W / 2 + MARGIN, Math.min(px, window.innerWidth - POPUP_W / 2 - MARGIN))
      setSelectionPopup({ x: px, y: py, text })
    }
    const handleMouseDown = (e: MouseEvent) => {
      if (useNavStore.getState().mainPage !== 'chat') return
      if ((e.target as HTMLElement)?.closest('.selection-reply-popup')) return
      setSelectionPopup(null)
    }
    const handleScroll = () => {
      if (useNavStore.getState().mainPage !== 'chat') return
      setSelectionPopup(null)
    }
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('scroll', handleScroll, true)
    }
  }, [])

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { toolOutputMode?: ToolOutputMode }) => {
      if (s.toolOutputMode) setToolOutputMode(s.toolOutputMode)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ChatPage теперь keep-alive (всегда смонтирован) — не реагируем на
      // горячие клавиши чата, пока активна другая вкладка (settings/memory/...).
      if (useNavStore.getState().mainPage !== 'chat') return
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(v => !v)
      }
      if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchMatchIds([]) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Загрузка чатов и проектов.
  // На ПЕРВОМ старте (currentChatId === null) — открываем первый чат.
  // На REMOUNT (возврат из настроек/памяти, currentChatId уже есть) — НЕ
  // дёргаем selectChat (он бы перерисовал текущий чат с stale-сообщениями
  // из store, а потом ещё раз перезагрузил из БД → двойная загрузка).
  // Вместо этого тихо освежаем chats (sidebar) и в фоне подтягиваем
  // свежие messages для текущего чата — но только если они отличаются,
  // иначе нулевой ре-рендер (нулевой визуальный флэш).
  useEffect(() => {
    window.syntee.projects.getAll().then((all: Project[]) => {
      setProjects(all)
    })
    window.syntee.chat.getAll().then((all: Chat[]) => {
      setChats(all)
      const store = useChatStore.getState()
      const curId = store.currentChatId
      // Чат удалён/архивирован пока пользователя не было — сброс.
      const curExists = curId && all.some(c => c.id === curId)
      if (!curExists) {
        if (all.length > 0) selectChat(all[0].id)
        return
      }
      // Первый запуск — выбираем первый чат.
      if (!curId) {
        if (all.length > 0) selectChat(all[0].id)
        return
      }
      // Remount: тихий фоновый refresh хвоста сообщений для текущего чата.
      // С пагинацией: если окно полное (hasOlder=false) — сверяем хвост с
      // свежей последней страницей и при расхождении заменяем окно. Если
      // hasOlder=true (пользователь догрузил старые страницы) — НЕ трогаем
      // messages, чтобы не сбросить позицию прокрутки; лишь правим флаг hasMore.
      window.syntee.chat.getMessagesPage(curId, 50).then((res: { messages: Message[]; hasMore: boolean }) => {
        const st = useChatStore.getState()
        const isCurrent = st.currentChatId === curId
        // НЕ отменяем сверку при свитче — обновляем кеш silently.
        if (isCurrent && st.hasOlderMessages) {
          if (st.hasOlderMessages !== res.hasMore) setHasOlderMessages(res.hasMore)
          return
        }
        // RACE GUARD: пока стрим активен, checkpoint-таймер main сохраняет
        // partial-сообщение в БД каждые 3с. getMessagesPage может вернуть
        // partial (незаконченный ответ) → попадёт в кэш → раздвоение с
        // live-пузырём. Не трогаем кэш пока liveByChat[chatId].isTyping.
        if (st.liveByChat[curId]?.isTyping) return
        const cached = st.messagesByChat[curId]
        const curLastId = cached?.messages.length ? cached.messages[cached.messages.length - 1].id : null
        const freshLastId = res.messages.length ? res.messages[res.messages.length - 1].id : null
        if (curLastId !== freshLastId) {
          setMessagesWindow(curId, res.messages, res.hasMore)
        } else if (isCurrent && st.hasOlderMessages !== res.hasMore) {
          setHasOlderMessages(res.hasMore)
        }
      }).catch(() => { /* ok — оставляем stale, не критично */ })
    })
    // Намеренно mount-once: selectChat объявлен ниже по коду (const), включать
    // его в deps нельзя — deps вычисляется во время рендера и упал бы с TDZ
    // (ReferenceError: cannot access before initialization). Ссылки внутри
    // тела эффекта безопасны — оно выполняется после рендера.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // АВТОСКРОЛЛ — умный движок «прилип/отлип» (useChatAutoscroll).
  // Прилип к низу → rAF-loop плавно догоняет любой рост контента; колесо
  // вверх / touch-drag вверх / скроллбар вверх → мгновенный отлип; ручной
  // доезд до низа / отправка / кнопка «вниз» → прилип. Подробности — в хуке.
  // Хук подключается ниже (после loadOlderMessagesRef — onScrollExtra едит его).

  // ── Reverse-infinite scroll: догрузка старых сообщений вверх ──────────────
  // prependingRef хранит scroll-геометрию ДО догрузки; useLayoutEffect после
  // рендера компенсирует прирост высоты, выставляя scrollTop так, чтобы
  // визуальная позиция чтения не прыгнула (иначе prepend «уезжает» к низу).
  const prependingRef = useRef<{ oldScrollHeight: number; oldScrollTop: number } | null>(null)

  const loadOlderMessages = useCallback(async () => {
    const st = useChatStore.getState()
    if (st.isLoadingOlder || !st.hasOlderMessages || !st.currentChatId) return
    const oldest = st.messages[0]
    if (!oldest) return
    const el = scrollContainerRef.current
    if (el) prependingRef.current = { oldScrollHeight: el.scrollHeight, oldScrollTop: el.scrollTop }
    setIsLoadingOlder(true)
    try {
      const res = await window.syntee.chat.getMessagesPage(st.currentChatId, 50, oldest.createdAt, oldest.id) as { messages: Message[]; hasMore: boolean }
      // Пока грузили — пользователь мог сменить чат. Не пишем в чужое окно.
      if (useChatStore.getState().currentChatId !== st.currentChatId) return
      prependOlderMessages(st.currentChatId, res.messages, res.hasMore)
    } catch {
      setIsLoadingOlder(false)
    }
  }, [prependOlderMessages, setIsLoadingOlder])

  // Стабильный ref для handleScroll (чтобы не плодить её ре-рендеры).
  const loadOlderMessagesRef = useRef(loadOlderMessages)
  loadOlderMessagesRef.current = loadOlderMessages

  // Подключение движка автоскролла. onScrollExtra — догрузка старых сообщений
  // у верхнего края (reverse-infinite scroll), вызывается в rAF-throttled
  // scroll-хендлере хука.
  const {
    pinnedRef,
    showScrollDownBtn,
    pin: pinAutoscroll,
    unpin: unpinAutoscroll,
    syncScrollState,
    handleScroll,
    handleWheel,
    handleMouseDown,
    handleTouchStart,
    handleTouchMove,
  } = useChatAutoscroll({
    scrollContainerRef,
    isStreaming: isTyping,
    onScrollExtra: () => {
      const el = scrollContainerRef.current
      if (!el) return
      // Reverse-infinite scroll: близко к верху и есть ещё старые → грузим.
      if (el.scrollTop < 200 && hasOlderMessages && !isLoadingOlder && currentChatId) {
        loadOlderMessagesRef.current()
      }
    },
  })

  // Плавный скролл вниз по клику на floating-кнопку + закрепление.
  const handleScrollDownClick = () => pinAutoscroll()

  // Компенсация скролла после prepend: визуальная позиция чтения сохраняется.
  // Срабатывает только когда prependingRef выставлен (т.е. после догрузки).
  useLayoutEffect(() => {
    const snap = prependingRef.current
    if (!snap) return
    const el = scrollContainerRef.current
    prependingRef.current = null
    if (!el) return
    const delta = el.scrollHeight - snap.oldScrollHeight
    if (delta > 0) {
      el.scrollTop = snap.oldScrollTop + delta
      // Внешняя запись scrollTop — синхронизируем refs движка автоскролла.
      syncScrollState()
    }
  }, [messages.length, syncScrollState])

  // ── Тихая фоновая догрузка всей истории (для чатов ≤ LARGE_CHAT_THRESHOLD)
  // Переиспользует prependingRef для скролл-компенсации (тот же useLayoutEffect
  // выше). Большие чаты пропускаются — для них reverse-infinite scroll со
  // спиннером. Дедуп со скролл-триггером — через стор-флаг isLoadingOlder
  // (он же используется loadOlderMessages). Подробности — в хуке.
  useBackgroundLoadFullChat({
    chatId: currentChatId,
    isLargeChat,
    prependingRef,
    scrollContainerRef,
    isBusy: () => useChatStore.getState().isLoadingOlder,
    setBusy: (v) => useChatStore.getState().setIsLoadingOlder(v),
  })

  // Загрузка тоггла миникарты сообщений в settings store — дальше компонент
  // ChatMinimap читает его оттуда (переключение в настройках применяется live,
  // без перезапуска; дефолт — включено).
  useEffect(() => {
    window.syntee.settings.get('chatMinimap').then((v: unknown) => {
      if (v !== null && v !== undefined) {
        useSettingsStore.setState(s => ({ settings: { ...s.settings, chatMinimap: v } }))
      }
    }).catch(() => {})
  }, [])

  // Динамический отступ под ChatInput
  // Зависит от activeFileTab: когда файл открыт — chatInputWrap размонтируется,
  // при возврате к чату — монтируется заново. Без activeFileTab в deps
  // ResizeObserver остаётся на старом (удалённом) элементе → --chat-input-h stale.
  useEffect(() => {
    const holder = chatInputWrapRef.current
    const container = holder?.parentElement
    const wrap = holder?.firstElementChild as HTMLElement | undefined
    if (!wrap || !container) return
    const apply = () => {
      container.style.setProperty('--chat-input-h', `${wrap.offsetHeight}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [activeFileTab])

  // Первый скролл при открытии чата — мгновенно к низу + прилип. Дальнейшее
  // следование за ростом контента (токены, тулы, todo) делает rAF-loop
  // движка автоскролла — отдельные эффекты/RO не нужны.
  useEffect(() => {
    if (isLoadingMessages || displayMessages.length === 0) return
    if (isInitialScrollRef.current) {
      requestAnimationFrame(() => { pinAutoscroll(true); isInitialScrollRef.current = false })
    }
  }, [messages.length, isTyping, isLoadingMessages, isCompacting, pinAutoscroll])

  const selectChat = useCallback(async (id: string) => {
    setIsLoadingMessages(true)
    isInitialScrollRef.current = true
    pinAutoscroll()
    skeletonTimerRef.current = setTimeout(() => setShowSkeleton(true), 120)
    setCurrentChat(id)
    // Сбрасываем unread-бейдж этого чата (пользователь его увидел)
    markChatRead(id)
    // Гидрируем live-состояние из main — если в чате работает агент,
    // показываем накопленный прогресс (текст/шаги/thinking), а не пустой пузырь.
    // hydrateFromMain также подтягивает meta активного запуска для панели очереди.
    await hydrateFromMain(id)
    // Race-guard: пока шли await'ы, пользователь мог кликнуть другой чат
    // или переключить вкладку. Не пишем stale-данные в store.
    if (useChatStore.getState().currentChatId !== id) return
    // Подтягиваем очередь ожидающих запросов из main — чтобы бейдж очереди
    // сразу показал счётчик при возврате в чат с queued-запросами.
    try {
      const queue = await window.syntee.chat.getQueue(id) as QueueItemMeta[]
      if (useChatStore.getState().currentChatId !== id) return
      useChatStore.getState().setQueue(id, queue)
    } catch { /* ok — очередь пуста или ещё не загружена */ }

    // ── LRU-кеш окон сообщений ──
    // Если чат недавно открывался — его окно уже в кеше. Показываем мгновенно
    // (без IPC + JSON-парсинга всего чата), затем в фоне сверяем хвост: если
    // пока пользователя не было пришли новые сообщения — заменяем окно на
    // свежую последнюю страницу и авто-скроллим вниз.
    const cached = useChatStore.getState().messagesByChat[id]
    if (cached) {
      setMessagesWindow(id, cached.messages, cached.hasOlder)
      if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
      setShowSkeleton(false)
      setIsLoadingMessages(false)
      // Фоновая сверка хвоста.
      void (async () => {
        try {
          const res = await window.syntee.chat.getMessagesPage(id, 50) as { messages: Message[]; hasMore: boolean }
          const st = useChatStore.getState()
          const isCurrent = st.currentChatId === id
          // НЕ отменяем сверку при свитче — обновляем кеш silently.
          // setMessagesWindow для non-current chatId НЕ трогает s.messages.
          // RACE GUARD: пока стрим активен, checkpoint-таймер main сохраняет
          // partial-сообщение в БД каждые 3с. getMessagesPage может вернуть
          // partial (незаконченный ответ) → попадёт в кэш → раздвоение с
          // live-пузырём. Не трогаем кэш пока liveByChat[chatId].isTyping.
          if (st.liveByChat[id]?.isTyping) return
          const cached = st.messagesByChat[id]
          const cachedLastId = cached?.messages.length ? cached.messages[cached.messages.length - 1].id : null
          const freshLastId = res.messages.length ? res.messages[res.messages.length - 1].id : null
          if (cachedLastId !== freshLastId) {
            setMessagesWindow(id, res.messages, res.hasMore)
            if (isCurrent) {
              isInitialScrollRef.current = true
              requestAnimationFrame(() => pinAutoscroll(true))
            }
          } else if (isCurrent && st.hasOlderMessages !== res.hasMore) {
            setHasOlderMessages(res.hasMore)
          }
        } catch { /* ok — оставляем кеш, не критично */ }
      })()
      return
    }

    // Cache miss → грузим последнюю страницу (newest 20).
    const res = await window.syntee.chat.getMessagesPage(id, 50) as { messages: Message[]; hasMore: boolean }
    if (useChatStore.getState().currentChatId !== id) return
    setMessagesWindow(id, res.messages, res.hasMore)
    if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
    setShowSkeleton(false)
    setIsLoadingMessages(false)
    // Deps: все используемые значения — стабильные store-actions/useCallback'и.
  }, [setCurrentChat, markChatRead, setMessagesWindow, setHasOlderMessages, pinAutoscroll])

  const createNewChat = useCallback(async (projectId?: string) => {
    let pid = projectId ?? activeProjectId
    if (!pid) {
      const picked = await window.syntee.projects.pickWorkdir()
      if (!picked) return
      const project: Project = await window.syntee.projects.create(picked)
      const allProjects: Project[] = await window.syntee.projects.getAll()
      setProjects(allProjects)
      setActiveProject(project.id)
      pid = project.id
    }
    const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, pid)
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chat.id)
    setMessages([])
    pinAutoscroll()
    isInitialScrollRef.current = true
  }, [activeProjectId, isIncognito, activeMode, setProjects, setActiveProject, setChats, setCurrentChat, setMessages, pinAutoscroll])

  const createNewProject = useCallback(async (mode: 'empty' | 'existing' = 'existing') => {
    const picked = mode === 'empty'
      ? await window.syntee.projects.pickNewWorkdir()
      : await window.syntee.projects.pickWorkdir()
    if (!picked) return
    const project: Project = await window.syntee.projects.create(picked)
    const allProjects: Project[] = await window.syntee.projects.getAll()
    setProjects(allProjects)
    setActiveProject(project.id)
  }, [setProjects, setActiveProject])

  const createChatWithoutProject = useCallback(async () => {
    const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, undefined)
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chat.id)
    setMessages([])
    pinAutoscroll()
    isInitialScrollRef.current = true
  }, [isIncognito, activeMode, setChats, setCurrentChat, setMessages, pinAutoscroll])

  /**
   * Вызывается после установки MCP/Skill через маркетплейс расширений —
   * чат уже создан и chat:send уже отправлен (агент начал работать).
   * Переключаемся на чат и инициализируем live-стрим ТОЧНО как в handleSend:
   * addMessage(userMsg) + initChatSend(chatId) — без этого live-буфер стрима
   * не инициализируется (streamMsgId остаётся null) и прогресс агента/финальный
   * ответ не отображаются, хотя агент реально работает в фоне.
   */
  const handleExtensionInstalled = useCallback(async (chatId: string, projectId: string | undefined, userMsg: Message) => {
    if (projectId) {
      const allProjects: Project[] = await window.syntee.projects.getAll()
      setProjects(allProjects)
      setActiveProject(projectId)
    }
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chatId)
    setMessages([])
    addMessage(userMsg)
    initChatSend(chatId)
    pinAutoscroll()
    isInitialScrollRef.current = true
  }, [setProjects, setActiveProject, setChats, setCurrentChat, setMessages, addMessage, pinAutoscroll])

  // ── Вкладки чатов в шапке ──
  // Любой путь выбора чата (сайдбар, boot, fork, slash-команды, установка
  // расширений) идёт через setCurrentChat → вкладка открывается здесь,
  // одной точкой. Заодно персистим активную вкладку для восстановления
  // сессии при следующем запуске.
  useEffect(() => {
    if (!currentChatId) return
    useTabsStore.getState().openTab(currentChatId)
    window.syntee.settings.set('activeChatTab', currentChatId)
  }, [currentChatId])

  // Мост для TitleBar (он рендерится в App и не видит колбэки ChatPage).
  // ChatPage keep-alive (всегда смонтирован) → регистрация живёт всю сессию.
  useEffect(() => {
    tabActions.selectChat = (id) => { void selectChat(id) }
    tabActions.createInContext = () => {
      // Новый чат в контексте текущего: чат проекта → новый чат в том же
      // проекте; чат без проекта → новый чат без проекта.
      const st = useChatStore.getState()
      const chat = st.chats.find(c => c.id === st.currentChatId)
      if (chat?.projectId) void createNewChat(chat.projectId)
      else void createChatWithoutProject()
    }
    return () => { tabActions.selectChat = null; tabActions.createInContext = null }
  }, [selectChat, createNewChat, createChatWithoutProject])

  const handleSend = useCallback(async (text: string) => {
    const raw = text.trim()
    const slash = parseSlashCommandWithCustom(raw, customCommands)

    // При отправке сообщения — принудительно закрепляем автоскролл.
    // Пользователь ожидает увидеть своё сообщение и ответ, даже если до этого
    // скроллил вверх по истории. instant=true — мгновенный прыжок (не ждём
    // rAF-loop), работает даже если предыдущий стрим ещё не завершился.
    pinAutoscroll(true)

    if (slash?.command.name === 'clear') {
      if (currentChatId) { setMessages([]); toast('Чат очищен', 'info') }
      return
    }
    if (slash?.command.name === 'sys') {
      if (!slash.args) { toast('Укажи промпт: /sys ты поэт', 'info'); return }
      await window.syntee.models.setParams({ systemPrompt: slash.args })
      toast('Системный промпт обновлен', 'success')
      return
    }
    if (slash?.command.name === 'image') {
      if (!slash.args) { toast('Укажи описание: /image красивый закат', 'info'); return }
    }
    // /ask — одноразовый read-only режим для текущего сообщения. Без args
    // не имеет смысла (нечего спросить). С args — включаем read-only тулы
    // + ask-инъекцию только для этого запроса, не меняя глобальный тоггл askMode.
    if (slash?.command.name === 'ask') {
      if (!slash.args) { toast('Укажи вопрос: /ask как работает этот модуль?', 'info'); return }
    }

    // ── /help — открыть модалку (без аргументов) ──
    if (slash?.command.name === 'help') {
      setShowHelp(true)
      return
    }

    // ── /fork — дублировать чат с этого места ──
    // Копирует сообщения + working memory + summary + project в новый чат.
    // Без currentChatId — нет смысла (нечего форкать).
    if (slash?.command.name === 'fork') {
      if (!currentChatId) { toast('Создай чат перед /fork', 'info'); return }
      try {
        const result = await window.syntee.chat.fork(currentChatId, slash.args || undefined) as {
          chatId?: string; messages?: Message[]; title?: string; error?: string
        }
        if (result.error) { toast(result.error, 'error'); return }
        if (result.chatId) {
          const all: Chat[] = await window.syntee.chat.getAll()
          setChats(all)
          setCurrentChat(result.chatId)
        if (result.messages) {
          setMessages(result.messages)
          // Скроллим к divider'у (он в середине ленты, не внизу), чтобы
          // пользователь увидел результат сжатия. useEffect ниже найдёт
          // индекс по id и вызовет virtualizer.scrollToIndex(center).
          if (result.stats?.dividerMessageId) {
            pendingScrollToDividerRef.current = result.stats.dividerMessageId
          }
        }
          toast(`Чат форкнут: ${result.title ?? 'новый чат'}`, 'success')
        }
      } catch (e) {
        toast('Ошибка форка: ' + String((e as Error)?.message ?? e), 'error')
      }
      return
    }

    // ── /snapshot <name> — именованный снапшот ──
    if (slash?.command.name === 'snapshot') {
      if (!currentChatId) { toast('Создай чат перед /snapshot', 'info'); return }
      if (!slash.args) { toast('Укажи имя: /snapshot my-feature', 'info'); return }
      try {
        const result = await window.syntee.chat.snapshotCreate(currentChatId, slash.args) as {
          snapshot?: CheckpointMeta; error?: string
        }
        if (result.error) { toast(result.error, 'error'); return }
        if (result.snapshot) {
          toast(`Снапшот сохранён: ${result.snapshot.name}`, 'success')
        }
      } catch (e) {
        toast('Ошибка снапшота: ' + String((e as Error)?.message ?? e), 'error')
      }
      return
    }

    // ── /restore [id|name] — восстановить снапшот ──
    // Без аргумента — открываем пикер именованных снапшотов.
    // С аргументом — пытаемся найти по name и восстановить.
    if (slash?.command.name === 'restore') {
      if (!currentChatId) { toast('Создай чат перед /restore', 'info'); return }
      // Если аргумент указан — ищем по имени и восстанавливаем сразу.
      if (slash.args) {
        try {
          const snapshots = await window.syntee.chat.snapshotList(currentChatId) as CheckpointMeta[]
          const found = snapshots.find(s => s.name === slash.args)
          if (!found) {
            toast(`Снапшот "${slash.args}" не найден. Доступные: ${snapshots.map(s => s.name).join(', ') || 'нет'}`, 'error')
            return
          }
          const result = await window.syntee.chat.rewindTo(currentChatId, found.userMessageId) as { messages?: Message[]; error?: string }
          if (result.error) { toast(result.error, 'error'); return }
          if (result.messages) {
            setMessages(result.messages)
            toast(`Восстановлен снапшот: ${found.name}`, 'success')
          }
        } catch (e) {
          toast('Ошибка восстановления: ' + String((e as Error)?.message ?? e), 'error')
        }
        return
      }
      // Без аргумента — открываем пикер.
      try {
        const snapshots = await window.syntee.chat.snapshotList(currentChatId) as CheckpointMeta[]
        if (snapshots.length === 0) {
          toast('Нет именованных снапшотов. Создайте через /snapshot <имя>', 'info')
          return
        }
        setSnapshotPicker(snapshots)
      } catch (e) {
        toast('Ошибка загрузки снапшотов: ' + String((e as Error)?.message ?? e), 'error')
      }
      return
    }

    // ── /persona [name] — sticky switch чата ──
    // Short-circuit: НЕ отправляет сообщение агенту, только переключает персону.
    // /persona без арг → ошибка (choices-picker обрабатывается в SlashMenu на
    //   этапе выбора, но если пользователь ввёл вручную — подсказываем).
    // /persona architect → setPersona + chat:setPersona + toast.
    // Аргументы — короткие имена (classic/architect/debug/review/refactor/test/mentor);
    // маппим в полный PersonaId.
    if (slash?.command.name === 'persona') {
      const SHORT_TO_ID: Record<string, PersonaId> = {
        classic: 'classic', architect: 'architect', debug: 'debugger',
        review: 'reviewer', refactor: 'refactorer', test: 'test-writer', mentor: 'mentor',
      }
      const arg = slash.args?.trim().toLowerCase()
      if (!arg || !(arg in SHORT_TO_ID)) {
        toast('Укажи персону: /persona classic | architect | debug | review | refactor | test | mentor', 'info')
        return
      }
      const id = SHORT_TO_ID[arg]
      handlePersonaChange(id)
      const label = id === 'classic' ? 'Classic (без персоны)' : id.charAt(0).toUpperCase() + id.slice(1)
      toast(`Персона чата: ${label}`, 'success')
      return
    }

    // /compact — ручное сжатие контекста чата. Не создаёт user-сообщения
    // (по поведению ближе к rewind): main гоняет applyRollingWindowAsync с
    // forceCompress=true, вставляет в БД system-разделитель «Контекст сжат»
    // и эмитит chat:compacted. Возвращённый messages — обновлённая лента
    // с этим разделителем.
    //
    // Во время сжатия (AI-суммаризация занимает несколько секунд) показываем
    // compacting-индикатор внизу чата — без него пользователь видит тишину
    // и не понимает что команда вообще сработала. Инпут блокируется.
    if (slash?.command.name === 'compact') {
      if (!currentChatId) { toast('Создай чат перед /compact', 'info'); return }
      setIsCompacting(true)
      pinAutoscroll()
      // Guard выставляем ДО invoke. Main эмитит CHAT_COMPACTED ещё во время
      // хендлера (event.sender.send до return), invoke резолвится после.
      // Guard НЕ гасим в finally — только в listener (по приходу CHAT_COMPACTED).
      // Если погасить в finally раньше CHAT_COMPACTED → setMessagesWindow(20)
      // перетрёт setMessages(allMessages) и divider (в конце ленты) может
      // потеряться при > 20 сообщений. Timeout 10s — safety net.
      manualCompactJustDoneRef.current = true
      const compactGuardTimer = setTimeout(() => { manualCompactJustDoneRef.current = false }, 10000)
      try {
        const result = await window.syntee.chat.compact(currentChatId, slash.args || undefined) as {
          messages?: Message[]
          stats?: { removedCount: number; tokensBefore: number; tokensAfter: number; tokensSaved: number; dividerMessageId: string }
          error?: string
          cancelled?: boolean
        }
        // User-initiated cancel (Stop-кнопка) — чат остался без изменений,
        // summary/divider не применялись. Мягкий info-toast, не error.
        if (result.cancelled) {
          toast('Сжатие отменено — контекст не изменён', 'info')
          return
        }
        if (result.error) {
          toast(result.error, 'error')
          return
        }
        if (result.messages) setMessages(result.messages)
        if (result.stats) {
          const tk = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
          toast(`Контекст сжат: удалено ${result.stats.removedCount} сообщ. · ${tk(result.stats.tokensBefore)}→${tk(result.stats.tokensAfter)} tok · сэкономлено ~${tk(result.stats.tokensSaved)}`, 'success')
        }
      } catch (e) {
        toast('Ошибка сжатия: ' + String((e as Error)?.message ?? e), 'error')
      } finally {
        clearTimeout(compactGuardTimer)
        setIsCompacting(false)
        setCompactingSummary('')
      }
      return
    }

    let chatId = currentChatId
    if (!chatId) {
      let pid = activeProjectId
      if (!pid) {
        const picked = await window.syntee.projects.pickWorkdir()
        if (!picked) return
        const project: Project = await window.syntee.projects.create(picked)
        const allProjects: Project[] = await window.syntee.projects.getAll()
        setProjects(allProjects)
        setActiveProject(project.id)
        pid = project.id
      }
      const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, pid)
      chatId = chat.id
      setCurrentChat(chatId)
      setMessages([])
      const all: Chat[] = await window.syntee.chat.getAll()
      setChats(all)
    }

    const displayContent = raw
    let aiContent: string = raw

    // ── One-shot параметры для команд ──
    // Поддерживаются и custom (.md) и builtin (personaOverride/skill).
    //   - personaOverride: /debug /review /architect ... — одно сообщение
    //     в указанной персоне, без персистенции (sticky persona не меняется).
    //   - skill: инструкции скилла инъектируются на этот прогон.
    //   - mode/allowedTools: только для custom .md-команд.
    let oneShotSkill: { name: string; instructions: string } | undefined
    let oneShotAllowedTools: string[] | undefined
    let oneShotMode: 'ask' | 'plan' | 'code' | undefined
    let oneShotPersona: PersonaId | undefined

    if (slash) {
      const sysPrompt = slash.command.systemPrompt(slash.args)
      if (sysPrompt) aiContent = sysPrompt

      // Per-message persona override — работает для builtin (/debug, /review,
      // /architect, ...) и для custom .md-команд с `personaOverride` в frontmatter.
      if (slash.command.personaOverride) {
        oneShotPersona = slash.command.personaOverride
      }

      // Custom-команды: mode + allowedTools (builtin управляют режимом сами).
      if (slash.command.custom) {
        if (slash.command.mode) oneShotMode = slash.command.mode
        if (slash.command.allowedTools && slash.command.allowedTools.length > 0) {
          oneShotAllowedTools = slash.command.allowedTools
        }
      }

      // Skill — резолвится для builtin и custom (новые builtin /debug /review
      // /refactor /test имеют skill, ссылающийся на resources/skills/*.md).
      if (slash.command.skill) {
        try {
          const skills = await window.syntee.skills.getAll({
            projectId: activeProjectId || undefined,
          }) as Array<{ name: string; instructions: string; source: string; state?: { enabled: boolean } }>
          // Ищем по имени — preferring builtin (они в дистрибутиве).
          const found = skills.find(s => s.name === slash.command.skill)
          if (found) {
            oneShotSkill = { name: found.name, instructions: found.instructions }
          } else {
            toast(`Скилл "${slash.command.skill}" не найден. Команда выполнится без скилла.`, 'info')
          }
        } catch (e) {
          console.error('[ChatPage] skills.getAll failed for oneShotSkill', e)
        }
      }
    }

    if (replyTo.length > 0) {
      const quotes = replyTo.map(r => {
        const who = r.role === 'user' ? 'Пользователь' : 'Syntee'
        return `> [${who}]: ${r.content.slice(0, 300)}${r.content.length > 300 ? '…' : ''}`
      }).join('\n')
      aiContent = `${quotes}\n\n${aiContent}`
    }

    // ── Persona auto-suggest (блокирующий modal) ──
    // Только для первой реплики нового чата, когда sticky persona = classic
    // и пользователь не отключил предложения. Detect ищет совпадение по
    // ключевым словам (ru/en). Если найдено — показываем modal: пользователь
    // выбирает Switch (persona меняется + send продолжается), Not now
    // (send с classic), или Never (opt-out + send с classic).
    // Блокирует ДО создания userMsg и очистки draft — иначе потеряли бы текст.
    if (
      !skipPersonaSuggestRef.current &&
      persona === 'classic' &&
      messages.filter(m => m.role === 'user').length === 0 &&
      !oneShotPersona &&
      !isPersonaSuggestionsDisabled() &&
      !slash // slash-команда — не детектим (/debug сам задаст персону)
    ) {
      const detected = detectPersona(raw)
      if (detected) {
        // Сохраняем весь контекст для продолжения send после ответа.
        setPersonaSuggest({ id: detected, preview: raw, pendingText: raw })
        return
      }
    }
    // Если пришли из modal-обработчика — сбрасываем флаг.
    skipPersonaSuggestRef.current = false

    const userMsg: Message = {
      id: uuid(), chatId,
      role: 'user',
      content: displayContent,
      createdAt: Date.now(),
      isPinned: 0,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      attachments: draftAttachmentsRef.current.length > 0 ? draftAttachmentsRef.current : undefined,
    }
    setReplyTo([])

    // Копия вложений для отправки — очистим draft до await, чтобы UI сразу
    // обновился (чипы пропадут из инпута). main-процесс получит их в params.
    const attachmentsToSend = [...draftAttachmentsRef.current]
    if (!isIncognito && chatId) {
      setDraftAttachments([])
      draftAttachmentsRef.current = []
      window.syntee.draft.clearAttachments(chatId).catch(() => {})
    }

    // Отправляем запрос. Если в чате уже идёт генерация — main поставит
    // в очередь и вернёт { queued: true }. В этом случае НЕ добавляем
    // user-сообщение сразу и НЕ инициализируем live-буфер — иначе все
    // queued-сообщения появятся в чате подряд (user1 user2 user3), а
    // ответы придут позже (assistant1 assistant2 assistant3). Вместо этого
    // откладываем до статуса 'running' (когда запрос реально стартует) —
    // порядок будет нормальным: user1 → assistant1 → user2 → assistant2.
    const result = await window.syntee.chat.send({
      chatId,
      content: aiContent,
      displayContent: displayContent !== aiContent ? displayContent : undefined,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      userMsgId: userMsg.id,
      planningMode,
      // askMode активируется тогглом ИЛИ одноразовой /ask <текст>. Для
      // /ask без тоггла — askMode true только для этого сообщения.
      askMode: askMode || slash?.command.name === 'ask',
      imageMode,
      // persona из ref — мгновенно отражает актуальное значение (state
      // асинхронно). Важно для persona auto-suggest modal: после accept
      // повторный handleSend должен увидеть новую персону, а не старую.
      persona: personaRef.current,
      mode: activeMode,
      // One-shot параметры кастомной команды (skill/mode/allowedTools).
      oneShotSkill,
      oneShotAllowedTools,
      oneShotMode,
      // Per-message persona override (/debug, /review, ...). Не персистится —
      // sticky persona чата не меняется, только этот прогон.
      oneShotPersona,
      // Прикреплённые файлы/изображения. main-процесс инлайнит текстовые
      // файлы в content, картинки передаёт как путь (vision — Phase 2).
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
    }) as { queued?: boolean; assistantMsgId?: string }

    if (result.queued && result.assistantMsgId) {
      // Запрос поставлен в очередь — откладываем user-сообщение до старта.
      enqueuePendingUserMsg(result.assistantMsgId, userMsg)
    } else {
      // Запрос стартовал сразу — показываем user-сообщение и live-пузырь.
      addMessage(userMsg)
      initChatSend(chatId)
      // Принудительно скроллим вниз — addMessage обновит DOM, и scrollHeight
      // станет актуальным. Двойной rAF: первый кадр — React коммитит DOM +
      // виртуализатор рендерит новый item с оценочным размером, второй кадр —
      // scrollHeight актуален, прыгаем к низу. Без двойного rAF виртуализатор
      // может ещё не отдать итоговую высоту → скролл к позиции «без сообщения».
      requestAnimationFrame(() => requestAnimationFrame(() => pinAutoscroll(true)))
    }

    // ── Обновляем историю навигации по стрелкам ──
    // displayContent — то, что ввёл пользователь (без quotes/sysPrompt).
    // Для обычных чатов — ре-фетч из БД (там уже сохранено). Для инкогнито —
    // поддерживаем in-memory Map на сессию. Дедупликация подряд-дубликатов.
    if (isIncognito && chatId) {
      const prev = incognitoHistoryRef.current.get(chatId) ?? []
      if (prev.length === 0 || prev[0] !== displayContent) {
        const next = [displayContent, ...prev]
        incognitoHistoryRef.current.set(chatId, next)
        if (chatId === currentChatId) setInputHistory(next)
      }
    } else if (chatId) {
      window.syntee.chat.getInputHistory(chatId).then((history: string[]) => {
        if (chatId !== currentChatId) return
        const raw = Array.isArray(history) ? history : []
        const dedup: string[] = []
        for (const s of raw) {
          if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s)
        }
        dedup.reverse()
        setInputHistory(dedup)
      }).catch(() => {})
    }
    // Deps: refs и store-actions стабильны; меняются только редкие
    // data-значения (режимы, replyTo, customCommands) — во время стриминга
    // ссылка handleSend стабильна, memo ChatInput не пробивается.
  }, [customCommands, currentChatId, activeProjectId, isIncognito, activeMode, planningMode, askMode, imageMode, persona, replyTo, toast, setMessages, setChats, setCurrentChat, setProjects, setActiveProject, addMessage, pinAutoscroll])

  const handlePin = useCallback(async (id: string) => {
    await window.syntee.chat.pin(id)
    pinMessage(id)
    toast('Сообщение закреплено', 'info')
  }, [pinMessage, toast])

  const handleCopy = useCallback(() => toast('Скопировано', 'success'), [toast])

  const handleReply = useCallback((msg: Message) => {
    setReplyTo(prev => prev.find(r => r.id === msg.id) ? prev : [...prev, msg])
  }, [])

  const handleCancelReply = useCallback((id: string) => {
    setReplyTo(prev => prev.filter(r => r.id !== id))
  }, [])

  const handleStop = useCallback(() => {
    if (!currentChatId) return
    if (isCompacting) {
      window.syntee.chat.compactCancel(currentChatId)
      manualCompactJustDoneRef.current = false
    } else {
      // Оптимально сбрасываем live-state, чтобы UI мгновенно отразил стоп
      // (stop-кнопка → send, live-пузырь схлопывается, "формулирую" гаснет).
      // Бэкендовые CHAT_STREAM_DONE/CHAT_RUN_STATUS работают как страховка;
      // clearLiveState идемпотентна (no-op если уже очищено).
      useChatStore.getState().clearLiveState(currentChatId)
      window.syntee.chat.stop(currentChatId)
    }
  }, [currentChatId, isCompacting])

  const handleRewind = useCallback(async (userMessageId: string) => {
    if (!currentChatId) return
    const result = await window.syntee.chat.rewindTo(currentChatId, userMessageId) as { messages?: Message[]; error?: string }
    if (result.error) {
      toast(result.error, 'error')
      return
    }
    if (result.messages) {
      setMessages(result.messages)
      toast('Сессия откатана', 'success')
    }
  }, [currentChatId, setMessages, toast])

  // Собираем отображаемые сообщения (включая live-пузырь текущего чата)
  const hasLiveContent = !!streamingText || !!live.thinking || live.steps.length > 0 ||
    live.iters.length > 0 || !!live.text || Object.keys(live.toolProgress).length > 0
  const showLiveBubble = (hasLiveContent || isTyping) && !!live.msgId

  const currentWorkdir = useMemo(() => {
    if (!currentChatId || isIncognito) return undefined
    return chats.find(c => c.id === currentChatId)?.workdir
  }, [chats, currentChatId, isIncognito])

  // ── Загрузка кастомных slash-команд (из .md-файлов) ──
  // Грузим при mount и при смене workdir (проектные команды из .syntee/commands/).
  // builtin из SLASH_COMMANDS не входят в этот список — они в filterCommands.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const cmds = await window.syntee.commands.list({ projectWorkdir: currentWorkdir }) as SlashCommand[]
        if (!cancelled) setCustomCommands(cmds)
      } catch (e) {
        console.error('[ChatPage] commands.list failed', e)
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentWorkdir])

  // ── File indexer для @mention-пикера ──
  // Раньше запускали chokidar+scanDir(10k stat) в main-процессе на маунте —
  // это забивало libuv thread pool и вешало UI на пару секунд при открытии
  // большого проекта. Теперь индексация стартует ЛЕНИВО при первом вызове
  // mentions:search (когда юзер вводит @) — см. mentions.ipc.ts:95.

  const activeProject = useMemo(() => {
    if (!currentChatId) return undefined
    const chat = chats.find(c => c.id === currentChatId)
    if (!chat?.projectId) return undefined
    return projects.find(p => p.id === chat.projectId)
  }, [chats, currentChatId, projects])

  // ── Оверлей-план (LiveTodoBar): показываем последний актуальный todo.
  // Приоритет:
  //  1) live.todo — текущий стримящийся план (или только что завершённый,
  //     пока clearLiveState не сбросил состояние).
  //  2) Самый свежий todo из истории сообщений (message.todo), сканируем
  //     с конца. Берём ПЕРВЫЙ найденный todo — более свежий перекрывает
  //     старые (решение "Заменить на новый" при конфликте). Если этот
  //     todo незавершённый — показываем. Если завершён (все done/skipped)
  //     — оверлей скрываем, даже если более старые todo висят незавершёнными.
  //     Это исправляет баг: AI закрыл todo в новом сообщении, но оверлей
  //     продолжал показывать старый незавершённый.
  const overlayTodo = useMemo(() => {
    type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }
    if (live.todo.length > 0) return live.todo as TodoItem[]
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant' || !m.todo?.length) continue
      // Нашли самый свежий todo. Если незавершён — показываем.
      // Если завершён — оверлей не нужен (возвращаем пустой массив,
      // более старые todo перекрыты этим).
      const unfinished = m.todo.some(it => it.status === 'pending' || it.status === 'in_progress')
      return unfinished ? m.todo : []
    }
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.todo, messages])

  const overlayActive = isTyping || overlayTodo.length > 0

  // Статистика сжатий сессии — кол-во compact-разделителей и суммарно
  // сэкономлено токенов. Берётся из messages (compactStats сохраняется в БД
  // у каждого compact-разделителя). Показывается в ContextRing панели.
  const compactSessionStats = useMemo(() => {
    let count = 0
    let totalTokensSaved = 0
    for (const m of messages) {
      if (m.slashCommand?.name === 'compact' && m.compactStats) {
        count++
        totalTokensSaved += m.compactStats.tokensSaved
      }
    }
    return { count, totalTokensSaved }
  }, [messages])

  const displayMessages = useMemo(() => {
    let result = messages
    if (showLiveBubble) {
      result = [...result, {
        // Фиксированный id/key для live-пузыря на весь период стриминга.
        // Раньше id = live.msgId, который менялся 'streaming-pending' →
        // реальному uuid при приходе первого токена/step — это вызывало
        // размонтирование/монтирование элемента и скачок перемера высоты
        // → рывок скролла в начале ответа. Фиксированный id сохраняет
        // React-элемент между фазами, перемер проходит гладко.
        id: 'live-streaming-bubble',
        chatId: currentChatId || '',
        role: 'assistant' as const,
        content: streamingText || '',
        createdAt: Date.now(),
        isPinned: 0,
        toolSteps: live.steps.length > 0 ? live.steps as Message['toolSteps'] : undefined,
        // liveIters/liveTextAfter/liveTodo/agentStatus передаются через
        // расширение объекта — MessageBubble читает их через cast.
        liveIters: live.iters,
        liveTextAfter: live.text,
        liveTodo: live.todo,
        agentStatus: live.agentStatus,
        toolProgress: live.toolProgress,
        spawnedAgents: live.spawnedAgents,
        livePlanningMode: planningMode,
        rateLimitSec: live.rateLimitSec > 0 ? live.rateLimitSec : undefined,
        retry: live.retry,
        lastError: live.lastError,
      } as Message & Record<string, unknown>]
    }
    if (isCompacting) {
      // Compacting-индикатор — временный system-разделитель внизу чата со
      // спиннером. Показывает что /compact работает (AI-суммаризация занимает
      // несколько секунд). После завершения заменяется реальным compact-
      // разделителем из обновлённой ленты messages.
      // compactLiveSummary — стримящееся резюме (токены приходят через
      // chat:compact-stream), показывается как live-markdown под бейджем.
      result = [...result, {
        id: 'compacting-indicator',
        chatId: currentChatId || '',
        role: 'system' as const,
        content: 'Сжимаю контекст…',
        createdAt: Date.now(),
        isPinned: 0,
        slashCommand: { name: 'compact', args: 'pending' },
        compactLiveSummary: compactingSummary,
      } as Message & { compactLiveSummary?: string }]
    }
    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, showLiveBubble, streamingText, live.steps, live.iters, live.text, live.todo, live.msgId, live.toolProgress, live.spawnedAgents, live.rateLimitSec, isCompacting, planningMode, compactingSummary])

  // getItemKey: привязываем кэш высот к message.id (не к индексу позиции) —
  // иначе при замене массива (compact вставляет divider, окно сдвигается на 1)
  // кэш по индексу протухает → разделитель налезает на соседа.
  //
  // КРИТИЧНО: ссылка useCallback ДОЛЖНА меняться при каждой смене маппинга
  // index→id, т.е. зависеть от displayMessages. В virtual-core getItemKey
  // входит в deps мемо getMeasurementOptions (сравнение по ссылке); смена
  // ссылки сбрасывает pendingMin → getMeasurements делает ПОЛНЫЙ пересчёт
  // start/size из itemSizeCache (высоты по id — корректные, сдвиг не страшен).
  // Со стабильной ссылкой (useCallback []) замена окна ТОЙ ЖЕ ДЛИНЫ со
  // сдвинутыми id (авто-компакция → chat:compacted → setMessagesWindow;
  // фоновая сверка хвоста в selectChat; boot-refresh) НЕ инвалидирует мемо:
  // ряды остаются на позициях ПРЕЖНИХ occupants → новые сообщения налезают
  // на старые. DOM-ноды при сдвиге переносятся (не remount) → RO/ref молчат
  // → баг жил до перемонта чата (перезаход «чинил»). Лишний полный пересчёт
  // на токен-флеш — O(count≈20-40), ничтожен (рендер на flush и так идёт).
  const getItemKey = useCallback(
    (index: number) => displayMessages[index]?.id ?? index,
    [displayMessages],
  )

  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    getItemKey,
    // overscan 5 (вместо 10): вдвое меньше ResizeObservers и активных
    // MessageBubble listeners → меньше CPU в idle. Плавность скролла
    // визуально не страдает (5 рядов сверху/снизу достаточно).
    overscan: 5,
    // useAnimationFrameWithResizeObserver (v3.17): батчит колбэки ResizeObserver
    // с requestAnimationFrame вместо синхронного срабатывания. Во время стрима
    // RO может стрелять на каждом flush'е токенов (50мс) → без батчинга
    // возникают reflow-бури и рассинхрон кэша высот с реальным DOM. С rAF-батчингом
    // замеры стабильнее → реже «прилипание» сообщений к соседу. Визуально ноль.
    useAnimationFrameWithResizeObserver: true,
    // measureElement убран — отдаём tanstack дефолтный (ResizeObserver-based,
    // батчит измерения вместо getBoundingClientRect на каждый вызов, который
    // форсит synchronous reflow на каждом токене стрима).
  })

  // Принудительный перемер смонтированных рядов: дёргает virtualizer.resizeItem
  // с реальной высотой DOM для каждого видимого ряда. Лечит устаревший кэш высот
  // (когда RO не успел поймать финальную высоту — анимация height:0→'auto' у
  // SystemDivider, асинхронный Mermaid SVG, нагруженный main thread) — иначе
  // следующий ряд позиционируется по устаревшей (меньшей) высоте и налезает на
  // предыдущий. См. комментарии в remeasure.ts. Вызывается листьями
  // (MermaidBlock, SystemDivider) по факту дорисовки, НЕ на каждом токене.
  // rAF-дедуп: если перемер уже запланирован, новые вызовы no-op → батчит
  // всплеск remeasure-вызовов (раскрытие нескольких тул-блоков подряд) в один
  // замер на следующем кадре вместо N синхронных reflow-циклов.
  const remeasureRafRef = useRef<number | null>(null)
  const requestRemeasure = useCallback(() => {
    if (remeasureRafRef.current !== null) return
    remeasureRafRef.current = requestAnimationFrame(() => {
      remeasureRafRef.current = null
      const el = scrollContainerRef.current
      if (!el) return
      const rows = el.querySelectorAll('[data-index]')
      if (rows.length === 0) return
      rows.forEach((node) => {
        const idx = Number((node as HTMLElement).getAttribute('data-index'))
        if (!Number.isFinite(idx)) return
        virtualizer.resizeItem(idx, Math.ceil(node.getBoundingClientRect().height))
      })
    })
  }, [virtualizer])

  return (
    <div className={`chat-layout ${embedded ? 'chat-layout--embedded' : ''}`}>
      {!embedded && <AnimatedBackground />}
      {!embedded && <TitleBar onSettingsClick={() => {}} />}
      <div className="chat-body">
        <Sidebar
          chats={chats}
          projects={projects}
          activeProjectId={activeProjectId}
          currentChatId={currentChatId}
          onSelectChat={selectChat}
          onNewChat={createNewChat}
          onNewChatWithoutProject={createChatWithoutProject}
          onNewProject={createNewProject}
          onChatsUpdate={setChats}
          onProjectsUpdate={setProjects}
          onSelectProject={setActiveProject}
          onExtensionInstalled={handleExtensionInstalled}
        />
        <main className="chat-main">
          <LiveTodoBar items={overlayTodo} active={overlayActive} />

          {/* ── Режим просмотра/редактирования файла (как в VSCode) ──
              Когда активен файловый таб — показываем Monaco-редактор
              вместо сообщений чата. Клик по chat-табу сбрасывает
              activeFileTabId → возвращаемся к чату. */}
          {activeFileTab ? (
            <FileEditorPane key={activeFileTab.id} tab={activeFileTab} />
          ) : (
          <>
          <AnimatePresence>
            {showSearch && (
              <motion.div key="search" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
                <ChatSearch
                  messages={messages}
                  onMatchIds={(ids, q) => { setSearchMatchIds(ids); setSearchQuery(q) }}
                  onClose={() => { setShowSearch(false); setSearchQuery(''); setSearchMatchIds([]) }}
                />
              </motion.div>
            )}
          </AnimatePresence>
          {showSkeleton ? (
            <motion.div
              key="skeleton"
              className="chat-skeleton"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {[0.4, 0.7, 0.5, 0.9, 0.6, 0.8, 0.45, 0.75].map((w, i) => (
                <div key={i} className={`chat-skeleton-row ${i % 3 === 0 ? 'chat-skeleton-row--user' : ''}`}>
                  <div className="chat-skeleton-bubble" style={{ width: `${w * 100}%` }} />
                </div>
              ))}
            </motion.div>
          ) : displayMessages.length === 0 && !isTyping ? (
            <div className="chat-empty-state">
              <div className="chat-empty-icon">
                <Logo size={52} />
              </div>
              <h2>Привет! Я Syntee.</h2>
              <p>Чем могу помочь сегодня?</p>
              {isIncognito && (
                <div className="incognito-hint">
                  <AppIcon name="lock" size="sm" tone="accent" />
                  <span>Режим инкогнито — чат не сохраняется</span>
                </div>
              )}
              {!isIncognito && activeProject && currentWorkdir && (
                <div className="chat-empty-workdir-hint">
                  <AppIcon name="folder" size="sm" tone="accent" />
                  <span>Проект: <strong>{activeProject.name}</strong> · {currentWorkdir}</span>
                </div>
              )}
              {!isIncognito && !activeProject && currentChatId && (
                <div className="chat-empty-workdir-hint chat-empty-workdir-hint--warn">
                  <AppIcon name="folder" size="sm" />
                  <span>Чат без проекта. Файловые операции работают относительно текущей директории процесса.</span>
                </div>
              )}
            </div>
          ) : (
            <div
              className="chat-messages"
              ref={scrollContainerRef}
              onScroll={handleScroll}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
            >
              {isLoadingOlder && isLargeChat && (
                <div
                  style={{
                    position: 'absolute', top: 0, left: 0, right: 0,
                    display: 'flex', justifyContent: 'center', alignItems: 'center',
                    padding: '6px 0', zIndex: 2, pointerEvents: 'none',
                  }}
                >
                  <div
                    style={{
                      width: 18, height: 18, borderRadius: '50%',
                      border: '2px solid rgba(127,127,127,0.25)',
                      borderTopColor: 'rgba(127,127,127,0.7)',
                      animation: 'chat-older-spin 0.7s linear infinite',
                    }}
                  />
                </div>
              )}
              <ChatRemeasureContext.Provider value={requestRemeasure}>
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {virtualizer.getVirtualItems().map(vItem => {
                  const msg = displayMessages[vItem.index]
                  const isLive = msg.id === 'live-streaming-bubble'
                  const liveThinking = isLive && live.thinking
                    ? { text: live.thinking, isLive: live.isThinkingLive, ms: live.thinkingMs }
                    : undefined
                  // Анимируем только первое появление сообщения; при scroll-remount
                  // того же id виртуализатором — shouldAnimate=false (иначе «плывёт»).
                  const shouldAnimate = !animatedMsgIdsRef.current.has(msg.id)
                  if (shouldAnimate) animatedMsgIdsRef.current.add(msg.id)
                  return (
                    <VirtualMessageItem
                      key={msg.id}
                      msg={msg}
                      vItemStart={vItem.start}
                      vItemIndex={vItem.index}
                      measureRef={virtualizer.measureElement}
                      toolOutputMode={toolOutputMode}
                      onPin={handlePin}
                      onCopy={handleCopy}
                      onReply={handleReply}
                      onRewind={handleRewind}
                      searchQuery={searchMatchIds.includes(msg.id) ? searchQuery : undefined}
                      liveThinking={liveThinking}
                      isStreaming={isLive && isTyping}
                      isWaiting={isLive && isTyping}
                      rateLimitSec={isLive ? live.rateLimitSec : undefined}
                      shouldAnimate={shouldAnimate}
                    />
                  )
                })}
                </div>
              </ChatRemeasureContext.Provider>
            </div>
          )}

          {/* Floating-кнопка «прокрутить вниз» — компактная, по центру,
              чуть выше инпут-бара. Появляется когда пользователь отошёл
              от низа (autoScroll=false). Клик — плавный скролл + закрепление. */}
          {/* Миникарта сообщений — точки навигации справа по центру. */}
          <ChatMinimap
            virtualizer={virtualizer}
            messages={displayMessages}
            scrollContainerRef={scrollContainerRef}
            onJump={unpinAutoscroll}
          />

          <AnimatePresence>
            {showScrollDownBtn && (
              <motion.button
                className="chat-scroll-down-btn"
                onClick={handleScrollDownClick}
                initial={{ opacity: 0, y: 8, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.8 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                whileTap={{ scale: 0.9 }}
                whileHover={{ scale: 1.08 }}
                title="Прокрутить вниз"
              >
                <AppIcon name="chevronDown" size="sm" />
              </motion.button>
            )}
          </AnimatePresence>

          <div ref={chatInputWrapRef} style={{ display: 'contents' }}>
            <ChatInput
              chatId={currentChatId ?? undefined}
              onSend={handleSend}
              disabled={isTyping || isCompacting}
              isIncognito={isIncognito}
              replyTo={replyTo}
              onCancelReply={handleCancelReply}
              isGenerating={isTyping || isAgentRunning || isCompacting}
              onStop={handleStop}
              contextInfo={contextInfo}
              showContextRing={showContextRing}
              value={draft}
              onChangeValue={handleDraftChange}
              inputHistory={inputHistory}
              mainModelId={mainModelId}
              onMainModelChange={handleMainModelChange}
              reasoningValue={reasoningValue}
              onReasoningChange={handleReasoningChange}
              planningMode={planningMode}
              onPlanningModeChange={handlePlanningModeChange}
              imageMode={imageMode}
              onImageModeChange={handleImageModeChange}
              askMode={askMode}
              onAskModeChange={handleAskModeChange}
              persona={persona}
              onPersonaChange={handlePersonaChange}
              workdir={currentWorkdir}
              compactSessionStats={compactSessionStats}
              customCommands={customCommands}
              attachments={draftAttachments}
              onAttachmentsChange={handleAttachmentsChange}
              lastTurnChanges={badgeChanges}
              badgeLive={badgeLive}
            />
          </div>

          {selectionPopup && createPortal(
            <div
              className="selection-reply-popup"
              style={{ left: selectionPopup.x, top: selectionPopup.y }}
              onMouseDown={e => e.preventDefault()}
            >
              <motion.button
                className="selection-reply-btn"
                onClick={() => {
                  const syntheticMsg = { id: `sel-${Date.now()}`, role: 'user', content: selectionPopup.text, createdAt: Date.now() } as Message
                  setReplyTo(prev => [...prev, syntheticMsg])
                  setSelectionPopup(null)
                  window.getSelection()?.removeAllRanges()
                }}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <Reply size={13} /> Reply
              </motion.button>
              <motion.button
                className="selection-reply-copy"
                onClick={async () => {
                  await copyToClipboard(selectionPopup.text)
                  setSelectionPopup(null)
                }}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <Copy size={13} /> Copy
              </motion.button>
            </div>,
            document.body
          )}

          {/* /help модалка — список команд + горячих клавиш */}
          <HelpModal open={showHelp} onClose={() => setShowHelp(false)} customCommands={customCommands} />
          {personaSuggest && (
            <PersonaSuggestionModal
              personaId={personaSuggest.id}
              messagePreview={personaSuggest.preview}
              onAccept={handlePersonaSuggestAccept}
              onDismiss={handlePersonaSuggestDismiss}
              onNeverAsk={handlePersonaSuggestNever}
            />
          )}

          {/* /restore пикер именованных снапшотов */}
          {snapshotPicker && createPortal(
            <div
              className="snapshot-picker-overlay"
              onClick={() => setSnapshotPicker(null)}
            >
              <div
                className="snapshot-picker"
                onClick={e => e.stopPropagation()}
              >
                <div className="snapshot-picker-header">
                  <h3>Восстановить снапшот</h3>
                  <motion.button
                    className="snapshot-picker-close"
                    onClick={() => setSnapshotPicker(null)}
                    title="Закрыть"
                    whileHover={whileHoverTiny}
                    whileTap={whileTapTiny}
                    transition={springHover}
                  >
                    <AppIcon name="x" size="sm" />
                  </motion.button>
                </div>
                <div className="snapshot-picker-list">
                  {snapshotPicker.map(snap => (
                    <motion.button
                      key={snap.id}
                      className="snapshot-picker-item"
                      onClick={async () => {
                        if (!currentChatId) return
                        try {
                          const result = await window.syntee.chat.rewindTo(currentChatId, snap.userMessageId) as { messages?: Message[]; error?: string }
                          if (result.error) {
                            toast(result.error, 'error')
                            return
                          }
                          if (result.messages) {
                            setMessages(result.messages)
                            toast(`Восстановлен снапшот: ${snap.name}`, 'success')
                          }
                        } catch (e) {
                          toast('Ошибка восстановления: ' + String((e as Error)?.message ?? e), 'error')
                        } finally {
                          setSnapshotPicker(null)
                        }
                      }}
                      whileHover={whileHoverListItem}
                      whileTap={whileTapListItem}
                      transition={springHover}
                    >
                      <span className="snapshot-picker-icon">
                        <AppIcon name="camera" size="sm" />
                      </span>
                      <span className="snapshot-picker-name">{snap.name}</span>
                      <span className="snapshot-picker-date">
                        {new Date(snap.createdAt).toLocaleString('ru')}
                      </span>
                      {snap.filesChanged > 0 && (
                        <span className="snapshot-picker-files" title="Файлов изменено в этом turn'е">
                          {snap.filesChanged} ф.
                        </span>
                      )}
                    </motion.button>
                  ))}
                </div>
              </div>
            </div>,
            document.body,
          )}
          </>
          )}
        </main>

        {/* Сплит-панель: второй чат в правой половине (50/50 с основным).
            showSplit — страховка от кадра-гонки: автозакрытие (удаление/архив/
            активация сплит-чата) идёт через подписки в tabs.store, между
            событием и ре-рендером splitChatId может указывать на мёртвый чат. */}
        {splitChatId && splitChatId !== currentChatId &&
          chats.some(c => c.id === splitChatId && !c.isArchived) && (
          <SplitChatPane
            chatId={splitChatId}
            onClose={() => setSplitChat(null)}
          />
        )}
      </div>
      {!embedded && (
        <ToastContainer />
      )}
    </div>
  )
}

// React.memo — ChatPage ре-рендерится только когда меняются его props
// (embedded всегда true, константа). Без этого любое изменение в App
// (например agentPanelOpen при открытии/закрытии правой панели) вызывало
// ре-рендер ChatPage с виртуализацией и MessageBubble → подвисание.
export default memo(ChatPage)
