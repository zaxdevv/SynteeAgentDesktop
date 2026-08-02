import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import { v4 as uuid } from 'uuid'
import { useContextCounter } from '../../hooks/useContextCounter'
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
import Logo from '../../components/ui/Logo/Logo'
import { useChatStore, EMPTY_LIVE } from '../../store/chat.store'
import { useNavStore } from '../../store/nav.store'
import { useTabsStore, tabActions } from '../../store/tabs.store'
import { parseSlashCommandWithCustom } from '../../../../shared/slashCommands'
import type { SlashCommand } from '../../../../shared/slashCommands'
import type { Chat, Message, ToolOutputMode, Project, QueueItemMeta, CheckpointMeta, Attachment } from '../../../../shared/types'
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
  const isIncognito = useChatStore(s => s.isIncognito)
  const activeMode = useChatStore(s => s.activeMode)
  const projects = useChatStore(s => s.projects)
  const activeProjectId = useChatStore(s => s.activeProjectId)
  // Live-состояние ТОЛЬКО текущего чата. Селектор возвращает ссылку на
  // liveByChat[currentChatId] — она меняется только при setLiveState для
  // ЭТОГО chatId (спред копирует ссылки остальных). Чужой чат стримит —
  // ref текущего не меняется → без ре-рендера.
  const live = (useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId] : undefined) ?? EMPTY_LIVE)
  const runStatus = useChatStore(s => s.currentChatId ? s.runStatusByChat[s.currentChatId] : undefined)
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
  // Ref-зеркало isTyping для ResizeObserver (RO замыкается один раз при mount,
  // иначе не видел бы смены стриминг→idle). Используется чтобы гейтить
  // авто-скролл по росту высоты ТОЛЬКО во время стриминга — иначе открытие/
  // ресайз боковой панели (ширина меняется → сообщения пере-флоуются → высота
  // растёт) ложно запускали smoothScrollToBottom rAF-цикл → лаги.
  const isTypingRef = useRef(isTyping)
  isTypingRef.current = isTyping
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
    }
    prevIsTypingRef.current = isTyping
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
        autoScrollRef.current = true
        requestAnimationFrame(() => scrollToBottomInstant())
        window.syntee.context.calculate(d.chatId).catch(() => {})
        return
      }
      // Compact меняет историю (удаляет старые сообщения, добавляет divider
      // у хвоста). Сбрасываем окно к свежей последней странице — это корректно
      // отражает пост-compact состояние и авто-скроллит к низу.
      window.syntee.chat.getMessagesPage(d.chatId, 20).then((res: { messages: Message[]; hasMore: boolean }) => {
        if (useChatStore.getState().currentChatId !== d.chatId) return
        setMessagesWindow(d.chatId, res.messages, res.hasMore)
        isInitialScrollRef.current = true
        autoScrollRef.current = true
        requestAnimationFrame(() => scrollToBottomInstant())
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
  // Каждый тумблер сохраняет своё состояние в БД (chats.planning_mode /
  // image_mode / ask_mode) для переживания перезапуска. Инкогнито не
  // пишется — только in-memory state. Пишем все 3 режима разом: один
  // UPDATE в SQLite дешевле, чем три IPC-вызова.
  const persistModes = useCallback((chatId: string, p: boolean, i: boolean, a: boolean) => {
    if (!chatId || isIncognito) return
    window.syntee.chat.setModes(chatId, { planningMode: p, imageMode: i, askMode: a }).catch(() => {})
  }, [isIncognito])
  const handlePlanningModeChange = useCallback((v: boolean) => {
    setPlanningMode(v)
    persistModes(currentChatId ?? '', v, imageModeRef.current, askModeRef.current)
  }, [currentChatId, persistModes])
  const handleImageModeChange = useCallback((v: boolean) => {
    setImageMode(v)
    persistModes(currentChatId ?? '', planningModeRef.current, v, askModeRef.current)
  }, [currentChatId, persistModes])
  const handleAskModeChange = useCallback((v: boolean) => {
    setAskMode(v)
    persistModes(currentChatId ?? '', planningModeRef.current, imageModeRef.current, v)
  }, [currentChatId, persistModes])

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
      window.syntee.chat.setModes(prevId, {
        planningMode: planningModeRef.current,
        imageMode: imageModeRef.current,
        askMode: askModeRef.current,
      }).catch(() => {})
    }
    prevChatIdRef.current = currentChatId
    prevIsIncognitoRef.current = isIncognito

    if (!currentChatId) {
      setDraft('')
      setInputHistory([])
      setPlanningMode(false); setImageMode(false); setAskMode(false)
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
      setDraftAttachments([])
      draftRef.current = ''
      draftAttachmentsRef.current = []
      setInputHistory(incognitoHistoryRef.current.get(currentChatId) ?? [])
      return
    }
    // Обычный чат: грузим modes/draft/history/attachments из БД параллельно
    let cancelled = false
    Promise.all([
      window.syntee.chat.getModes(currentChatId),
      window.syntee.chat.getDraft(currentChatId),
      window.syntee.chat.getInputHistory(currentChatId),
      window.syntee.draft.getAttachments(currentChatId),
    ]).then(([modes, draftText, history, attachments]) => {
      if (cancelled || currentChatId !== prevChatIdRef.current) return
      setPlanningMode(!!modes.planningMode)
      setImageMode(!!modes.imageMode)
      setAskMode(!!modes.askMode)
      planningModeRef.current = !!modes.planningMode
      imageModeRef.current = !!modes.imageMode
      askModeRef.current = !!modes.askMode
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
      setDraft(''); setPlanningMode(false); setImageMode(false); setAskMode(false); setInputHistory([])
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
          window.syntee.chat.setModes(id, {
            planningMode: planningModeRef.current,
            imageMode: imageModeRef.current,
            askMode: askModeRef.current,
          }).catch(() => {})
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
      if (!text || text.length < 2) { setSelectionPopup(null); return }
      const anchor = sel?.anchorNode?.parentElement
      if (!anchor?.closest('.chat-messages')) { setSelectionPopup(null); return }
      const range = sel?.getRangeAt(0)
      const rect = range?.getBoundingClientRect()
      if (!rect) return
      setSelectionPopup({ x: rect.left + rect.width / 2, y: rect.top - 8, text })
    }
    const handleMouseDown = (e: MouseEvent) => {
      if (useNavStore.getState().mainPage !== 'chat') return
      if ((e.target as HTMLElement)?.closest('.selection-reply-popup')) return
      setSelectionPopup(null)
    }
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleMouseDown)
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
      window.syntee.chat.getMessagesPage(curId, 20).then((res: { messages: Message[]; hasMore: boolean }) => {
        if (useChatStore.getState().currentChatId !== curId) return
        const st = useChatStore.getState()
        if (st.hasOlderMessages) {
          if (st.hasOlderMessages !== res.hasMore) setHasOlderMessages(res.hasMore)
          return
        }
        const cur = st.messages
        const curLastId = cur.length ? cur[cur.length - 1].id : null
        const freshLastId = res.messages.length ? res.messages[res.messages.length - 1].id : null
        if (curLastId !== freshLastId) {
          setMessagesWindow(curId, res.messages, res.hasMore)
        } else if (st.hasOlderMessages !== res.hasMore) {
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

  // АВТОСКРОЛЛ — один источник истины (autoScrollRef), плавный RAF-loop
  // АВТОСКРОЛЛ — максимально простая и надёжная модель.
  //
  // autoScrollRef меняется ТОЛЬКО в трёх случаях:
  //   1. onWheel с deltaY < 0 (колесо вверх) → false (пользователь ушёл вверх)
  //   2. handleSend / selectChat / initial scroll → true (принудительное закрепление)
  //   3. handleScroll когда distFromBottom < 24 → true (пользователь сам доехал до низа)
  //
  // onScroll НЕ отключает autoScroll при отходе от низа — это была главная
  // причина багов: virtualizer перемеряет элементы → scrollHeight меняется →
  // scroll event → ложное отключение. Теперь отключение только через onWheel.
  // onScroll используется исключительно для показа/скрытия кнопки "вниз".
  const autoScrollRef           = useRef(true)
  const scrollRafRef            = useRef<number | null>(null)
  const scrollRafPendingRef     = useRef(false)
  // Последний известный scrollTop — для детектирования пользовательского
  // скролла ВВЕРХ. Программный скролл (rAF-цикл к низу) и prepend-компенсация
  // УВЕЛИЧИВАЮТ scrollTop; уменьшение = пользователь тянет вверх любым способом
  // (полоса прокрутки / trackpad / PageUp). onWheel ловит только колесо —
  // остальные способы уходили с autoScroll=true → rAF-цикл тянул обратно
  // вниз → конкуренция → фризы/«плывёт» на 144Гц.
  const lastScrollTopRef        = useRef(0)
  const [showScrollDownBtn, setShowScrollDownBtn] = useState(false)

  const hasScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return false
    return el.scrollHeight - el.clientHeight > 24
  }, [])

  const smoothScrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    // Если loop уже активен — не перезапускаем. Loop в каждом кадре читает
    // свежий scrollHeight и сам двигается к актуальному низу. Перезапуск
    // (cancel + start) создавал "покадровый" дёрганый скролл.
    if (scrollRafRef.current !== null) return

    const animate = () => {
      if (!el) return
      // Пользователь скроллил вверх (onWheel выставил false) — останавливаемся.
      if (!autoScrollRef.current) {
        scrollRafRef.current = null
        return
      }
      const target = el.scrollHeight - el.clientHeight
      const current = el.scrollTop
      const diff = target - current
      if (diff <= 1) {
        if (diff > 0) el.scrollTop = target
        scrollRafRef.current = null
        return
      }
      // Если отставание большое (>40px — контент вырос быстрее) — прыгаем
      // мгновенно к низу. Это убирает "не успевает за ответом": при быстром
      // стриминге скролл следует за контентом без отставания.
      // Если diff маленький — плавный шаг для мягкого сближения у низа.
      if (diff > 40) {
        el.scrollTop = target
      } else {
        // Плавный шаг: Math.max(diff * 0.5, 4) — быстро сходится, минимум 4px.
        const step = Math.max(diff * 0.5, 4)
        el.scrollTop = current + Math.min(step, diff)
      }
      // Программный скролл вниз — обновляем lastScrollTopRef, чтобы onScroll
      // не воспринял это как пользовательский скролл вверх (уменьшение).
      lastScrollTopRef.current = el.scrollTop
      scrollRafRef.current = requestAnimationFrame(animate)
    }
    scrollRafRef.current = requestAnimationFrame(animate)
  }, [])

  const scrollToBottomInstant = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
    el.scrollTop = el.scrollHeight - el.clientHeight
    // Обновляем lastScrollTopRef, иначе первый onScroll после программного
    // прыжка вниз воспринял бы уменьшение (старое значение было меньше) и
    // ложно отключил бы авто-скролл.
    lastScrollTopRef.current = el.scrollTop
  }, [])

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
      const res = await window.syntee.chat.getMessagesPage(st.currentChatId, 20, oldest.createdAt, oldest.id) as { messages: Message[]; hasMore: boolean }
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
      lastScrollTopRef.current = el.scrollTop
    }
  }, [messages.length])

  const handleScroll = useCallback(() => {
    if (scrollRafPendingRef.current) return
    scrollRafPendingRef.current = true
    requestAnimationFrame(() => {
      scrollRafPendingRef.current = false
      const el = scrollContainerRef.current
      if (!el) return
      // Reverse-infinite scroll: близко к верху и есть ещё старые → грузим.
      if (el.scrollTop < 200 && hasOlderMessages && !isLoadingOlder && currentChatId) {
        loadOlderMessagesRef.current()
      }
      if (!hasScroll()) {
        setShowScrollDownBtn(false)
        return
      }
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      // Пользовательский скролл ВВЕРХ (scrollTop уменьшился) — отключаем
      // авто-скролл, чтобы rAF-цикл smoothScrollToBottom не конкурировал
      // (особенно для полосы прокрутки/trackpad, где onWheel не срабатывает).
      // Программный скролл вниз увеличивает scrollTop → не триггерит.
      if (el.scrollTop < lastScrollTopRef.current - 2) {
        autoScrollRef.current = false
      }
      lastScrollTopRef.current = el.scrollTop
      if (distFromBottom < 24) {
        autoScrollRef.current = true
        setShowScrollDownBtn(false)
        return
      }
      setShowScrollDownBtn(true)
    })
  }, [hasScroll, hasOlderMessages, isLoadingOlder, currentChatId])

  // Колесо вверх → мгновенно отключаем авто-скролл.
  // onWheel срабатывает ТОЛЬКО от пользователя, никогда от scrollTop=.
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      autoScrollRef.current = false
      setShowScrollDownBtn(true)
    }
  }, [])

  // Плавный скролл вниз по клику на floating-кнопку + закрепление.
  const handleScrollDownClick = useCallback(() => {
    autoScrollRef.current = true
    setShowScrollDownBtn(false)
    smoothScrollToBottom()
  }, [smoothScrollToBottom])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    // ResizeObserver на inner нужен для авто-скролла при росте контента
    // (стриминг токенов). Но он срабатывает и при изменении ШИРИНЫ контейнера
    // (открытие/закрытие/ресайз боковой панели) — сообщения пере-флоуются,
    // высота растёт, и RO ложно запускал smoothScrollToBottom rAF-цикл
    // (forced layout каждый кадр всю spring-анимацию панели) → лаги/«плывёт».
    // Guard: скроллим только если autoScroll включён И идёт стриминг (isTyping).
    // Не-стриминговый рост (ресайз панели, prepend старых) — не трогаем скролл.
    let prevH = (el.firstElementChild as HTMLElement | null)?.scrollHeight ?? 0
    const ro = new ResizeObserver(() => {
      const inner = el.firstElementChild as HTMLElement | null
      if (!inner) return
      const newH = inner.scrollHeight
      if (autoScrollRef.current && isTypingRef.current && newH > prevH) {
        smoothScrollToBottom()
      }
      prevH = newH
    })
    const inner = el.firstElementChild
    if (inner) ro.observe(inner as Element)
    return () => ro.disconnect()
  }, [smoothScrollToBottom])

  // Динамический отступ под ChatInput
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
  }, [])

  // Скролл при новых сообщениях / начале стриминга
  useEffect(() => {
    if (isLoadingMessages || displayMessages.length === 0) return
    if (isInitialScrollRef.current) {
      requestAnimationFrame(() => { scrollToBottomInstant(); isInitialScrollRef.current = false })
      autoScrollRef.current = true
      setShowScrollDownBtn(false)
    } else if (autoScrollRef.current) {
      smoothScrollToBottom()
    }
  }, [messages.length, isTyping, isLoadingMessages, isCompacting, smoothScrollToBottom, scrollToBottomInstant])

  // Автоскролл при стриминге покрывается ResizeObserver-эффектом выше
  // (inner элемент растёт каждый токен → RO → smoothScrollToBottom). Раньше
  // тут был отдельный effect на [streamingText, live.iters, live.steps],
  // который дублировал RO и добавлял лишний ре-рендер/ре-флоу каждый токен.
  // RO уже батчит и рейлит на rAF-loop — этого достаточно.

  const selectChat = useCallback(async (id: string) => {
    setIsLoadingMessages(true)
    isInitialScrollRef.current = true
    autoScrollRef.current = true
    if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null }
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
          const res = await window.syntee.chat.getMessagesPage(id, 20) as { messages: Message[]; hasMore: boolean }
          if (useChatStore.getState().currentChatId !== id) return
          const st = useChatStore.getState()
          const cachedLastId = st.messages.length ? st.messages[st.messages.length - 1].id : null
          const freshLastId = res.messages.length ? res.messages[res.messages.length - 1].id : null
          if (cachedLastId !== freshLastId) {
            // Пока пользователя не было — пришли новые сообщения. Сбрасываем
            // окно к свежей последней странице и прыгаем вниз.
            setMessagesWindow(id, res.messages, res.hasMore)
            isInitialScrollRef.current = true
            autoScrollRef.current = true
            requestAnimationFrame(() => scrollToBottomInstant())
          } else if (st.hasOlderMessages !== res.hasMore) {
            setHasOlderMessages(res.hasMore)
          }
        } catch { /* ok — оставляем кеш, не критично */ }
      })()
      return
    }

    // Cache miss → грузим последнюю страницу (newest 20).
    const res = await window.syntee.chat.getMessagesPage(id, 20) as { messages: Message[]; hasMore: boolean }
    if (useChatStore.getState().currentChatId !== id) return
    setMessagesWindow(id, res.messages, res.hasMore)
    if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
    setShowSkeleton(false)
    setIsLoadingMessages(false)
    // Deps: все используемые значения — стабильные store-actions/useCallback'и.
  }, [setCurrentChat, markChatRead, setMessagesWindow, setHasOlderMessages, scrollToBottomInstant])

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
    autoScrollRef.current = true
    isInitialScrollRef.current = true
  }, [activeProjectId, isIncognito, activeMode, setProjects, setActiveProject, setChats, setCurrentChat, setMessages])

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
    autoScrollRef.current = true
    isInitialScrollRef.current = true
  }, [isIncognito, activeMode, setChats, setCurrentChat, setMessages])

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
    autoScrollRef.current = true
    isInitialScrollRef.current = true
  }, [setProjects, setActiveProject, setChats, setCurrentChat, setMessages, addMessage])

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

    // При отправке сообщения — принудительно закрепляем авто-скролл.
    // Пользователь ожидает увидеть своё сообщение и ответ, даже если до этого
    // скроллил вверх по истории.
    autoScrollRef.current = true
    setShowScrollDownBtn(false)

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
      autoScrollRef.current = true
      setShowScrollDownBtn(false)
      // Guard выставляем ДО invoke. Main эмитит CHAT_COMPACTED ещё во время
      // хендлера (event.sender.send до return), invoke резолвится после.
      // Guard НЕ гасим в finally — только в listener (по приходу CHAT_COMPACTED).
      // Если погасить в finally раньше CHAT_COMPACTED → setMessagesWindow(20)
      // перетрёт setMessages(allMessages) и divider (в конце ленты) может
      // потеряться при > 20 сообщений. Timeout 10s — safety net.
      manualCompactJustDoneRef.current = true
      const compactGuardTimer = setTimeout(() => { manualCompactJustDoneRef.current = false }, 10000)
      try {
        const result = await window.syntee.chat.compact(currentChatId) as {
          messages?: Message[]
          stats?: { removedCount: number; tokensBefore: number; tokensAfter: number; tokensSaved: number; dividerMessageId: string }
          error?: string
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

    // ── One-shot параметры для кастомных команд ──
    // Если команда custom (из .md) и имеет skill/mode/allowedTools —
    // прокидываем их в chat:send как oneShot*. Это активирует скилл на этот
    // прогон без записи в skillsState, фильтрует тулы и/или включает read-only.
    let oneShotSkill: { name: string; instructions: string } | undefined
    let oneShotAllowedTools: string[] | undefined
    let oneShotMode: 'ask' | 'plan' | 'code' | undefined

    if (slash) {
      const sysPrompt = slash.command.systemPrompt(slash.args)
      if (sysPrompt) aiContent = sysPrompt

      // Кастомная команда с one-shot параметрами
      if (slash.command.custom) {
        if (slash.command.mode) oneShotMode = slash.command.mode
        if (slash.command.allowedTools && slash.command.allowedTools.length > 0) {
          oneShotAllowedTools = slash.command.allowedTools
        }
        // Если указан skill — резолвим его инструкции через skills:getAll.
        // Скилл может быть builtin (в resources/skills) или user/project.
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
    }

    if (replyTo.length > 0) {
      const quotes = replyTo.map(r => {
        const who = r.role === 'user' ? 'Пользователь' : 'Syntee'
        return `> [${who}]: ${r.content.slice(0, 300)}${r.content.length > 300 ? '…' : ''}`
      }).join('\n')
      aiContent = `${quotes}\n\n${aiContent}`
    }

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
      mode: activeMode,
      // One-shot параметры кастомной команды (skill/mode/allowedTools).
      oneShotSkill,
      oneShotAllowedTools,
      oneShotMode,
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
      // Принудительно скроллим вниз в следующем кадре — addMessage обновит
      // DOM, и scrollHeight станет актуальным. Без этого в новом чате
      // (где isInitialScrollRef=true) эффект мог не сработать вовремя.
      requestAnimationFrame(() => {
        autoScrollRef.current = true
        setShowScrollDownBtn(false)
        scrollToBottomInstant()
  })
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
  }, [customCommands, currentChatId, activeProjectId, isIncognito, activeMode, planningMode, askMode, imageMode, replyTo, toast, setMessages, setChats, setCurrentChat, setProjects, setActiveProject, addMessage, scrollToBottomInstant])

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
    if (currentChatId) window.syntee.chat.stop(currentChatId)
  }, [currentChatId])

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

  // ── Запуск file indexer для @mention-пикера ──
  // При смене workdir — запускаем chokidar-индексацию в main-процессе.
  // Indexer держит in-memory кэш файлов для быстрого fuzzy-поиска в @пикере.
  useEffect(() => {
    if (!currentWorkdir) return
    window.syntee.mentions.startIndexing(currentWorkdir).catch(() => {})
    // Не останавливаем при размонтировании — main держит один watcher на
    // workdir, может использоваться другими чатами того же проекта.
  }, [currentWorkdir])

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
  }, [messages, showLiveBubble, streamingText, live.steps, live.iters, live.text, live.todo, live.msgId, live.toolProgress, live.rateLimitSec, isCompacting, planningMode, compactingSummary])

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
    // overscan 10 (вместо 5): больше элементов держится смонтированными вокруг
    // вьюпорта → меньше mount/unmount циклов при скролле → меньше ре-парсов
    // markdown больших сообщений при переходе границы. Памяти чуть больше,
    // но плавность скролла важнее.
    overscan: 10,
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
  const requestRemeasure = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const rows = el.querySelectorAll('[data-index]')
    if (rows.length === 0) return
    rows.forEach((node) => {
      const idx = Number((node as HTMLElement).getAttribute('data-index'))
      if (!Number.isFinite(idx)) return
      virtualizer.resizeItem(idx, Math.ceil(node.getBoundingClientRect().height))
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
            >
              {isLoadingOlder && (
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
              workdir={currentWorkdir}
              compactSessionStats={compactSessionStats}
              customCommands={customCommands}
              attachments={draftAttachments}
              onAttachmentsChange={handleAttachmentsChange}
            />
          </div>

          {selectionPopup && createPortal(
            <div
              className="selection-reply-popup"
              style={{ left: selectionPopup.x, top: selectionPopup.y }}
              onMouseDown={e => e.preventDefault()}
            >
              <button
                className="selection-reply-btn"
                onClick={() => {
                  const syntheticMsg = { id: `sel-${Date.now()}`, role: 'user', content: selectionPopup.text, createdAt: Date.now() } as Message
                  setReplyTo(prev => [...prev, syntheticMsg])
                  setSelectionPopup(null)
                  window.getSelection()?.removeAllRanges()
                }}
              >
                ↩ Reply
              </button>
              <button
                className="selection-reply-copy"
                onClick={() => {
                  navigator.clipboard.writeText(selectionPopup.text)
                  setSelectionPopup(null)
                }}
              >
                Copy
              </button>
            </div>,
            document.body
          )}

          {/* /help модалка — список команд + горячих клавиш */}
          <HelpModal open={showHelp} onClose={() => setShowHelp(false)} customCommands={customCommands} />

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
                  <button
                    className="snapshot-picker-close"
                    onClick={() => setSnapshotPicker(null)}
                    title="Закрыть"
                  >
                    <AppIcon name="x" size="sm" />
                  </button>
                </div>
                <div className="snapshot-picker-list">
                  {snapshotPicker.map(snap => (
                    <button
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
                    </button>
                  ))}
                </div>
              </div>
            </div>,
            document.body,
          )}
        </main>
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
