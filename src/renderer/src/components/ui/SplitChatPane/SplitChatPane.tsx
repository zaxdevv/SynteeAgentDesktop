import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { v4 as uuid } from 'uuid'
import type { Message, Attachment, ToolOutputMode, ReplyTarget } from '../../../../../shared/types'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import { DEFAULT_PERSONA, isValidPersona, type PersonaId } from '../../../../../shared/modes'
import { initChatSend, hydrateFromMain, enqueuePendingUserMsg } from '../../../hooks/useChatRunSubscription'
import { useChatAutoscroll } from '../../../hooks/useChatAutoscroll'
import { useBackgroundLoadFullChat } from '../../../hooks/useBackgroundLoadFullChat'
import { useContextCounter } from '../../../hooks/useContextCounter'
import { useChatEditor } from '../../../hooks/useChatEditor'
import MessageBubble from '../MessageBubble/MessageBubble'
import { ChatRemeasureContext } from '../MessageBubble/remeasure'
import ChatInput from '../ChatInput/ChatInput'
import ChatMinimap from '../ChatMinimap/ChatMinimap'
import LiveTodoBar from '../LiveTodoBar/LiveTodoBar'
import AppIcon from '../AppIcon/AppIcon'
import Logo from '../Logo/Logo'
import { useChatStore, EMPTY_LIVE, selectIsLargeChat } from '../../../store/chat.store'
import { computeLiveChanges } from '../../../utils/changes'
import { playDoneSound } from '../../../utils/sounds'
import { parseSlashCommandWithCustom } from '../../../../../shared/slashCommands'
// Общие классы чата (chat-main/chat-messages/chat-skeleton/chat-empty-state/
// chat-scroll-down-btn/chat-older-spin). ChatPage keep-alive и тоже импортирует
// этот CSS — Vite дедуплицирует, двойной загрузки нет.
import '../../../pages/Chat/ChatPage.css'
import './SplitChatPane.css'

const itemStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
}

// Module-level empty константы для узких live-селекторов
const EMPTY_STEPS = EMPTY_LIVE.steps
const EMPTY_ITERS = EMPTY_LIVE.iters
const EMPTY_TODO = EMPTY_LIVE.todo
const EMPTY_TOOL_PROGRESS = EMPTY_LIVE.toolProgress
const EMPTY_SPAWNED_AGENTS = EMPTY_LIVE.spawnedAgents

interface VirtualMessageItemProps {
  msg: Message
  vItemStart: number
  vItemIndex: number
  measureRef: (node: Element | null) => void
  toolOutputMode: ToolOutputMode
  onPin: (id: string) => void
  onCopy: (content: string) => void
  onReply: (message: Message) => void
  onRewind: (userMessageId: string) => void
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming: boolean
  isWaiting: boolean
  rateLimitSec?: number
  shouldAnimate: boolean
  editorAvailable?: boolean
}

const VirtualMessageItem = memo(function VirtualMessageItem({
  msg, vItemStart, vItemIndex, measureRef, toolOutputMode,
  onPin, onCopy, onReply, onRewind, liveThinking,
  isStreaming, isWaiting, rateLimitSec, shouldAnimate, editorAvailable,
}: VirtualMessageItemProps) {
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
        liveThinking={liveThinking}
        isStreaming={isStreaming}
        isWaiting={isWaiting}
        rateLimitSec={rateLimitSec}
        shouldAnimate={shouldAnimate}
        editorAvailable={editorAvailable}
      />
    </div>
  )
}, (prev, next) =>
  prev.msg === next.msg &&
  prev.vItemStart === next.vItemStart &&
  prev.vItemIndex === next.vItemIndex &&
  prev.toolOutputMode === next.toolOutputMode &&
  prev.onPin === next.onPin &&
  prev.onCopy === next.onCopy &&
  prev.onReply === next.onReply &&
  prev.onRewind === next.onRewind &&
  prev.liveThinking === next.liveThinking &&
  prev.isStreaming === next.isStreaming &&
  prev.isWaiting === next.isWaiting &&
  prev.rateLimitSec === next.rateLimitSec &&
  prev.shouldAnimate === next.shouldAnimate &&
  prev.editorAvailable === next.editorAvailable
)

// ── SplitChatPane — второй параллельный чат (сплит-панель) ──────────────────
// Полноценный чат рядом с основным: виртуализированная лента, reverse-infinite
// scroll, live-пузырь стриминга, autoscroll, свой ChatInput (draft/моды/reply/
// attachments/customCommands/модель/stop). Сообщения читаются из LRU-кеша
// messagesByChat[chatId] (не из messages — это окно ТЕКУЩЕГО чата), live-статус
// из liveByChat[chatId] (per-chat). Отправка — через тот же chat:send IPC с
// chatId = сплит-чат; main не знает про сплит, для него это обычный чат.
function SplitChatPane({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  // ── Сообщения из LRU-кеша (не из messages — то окно текущего чата) ──
  // Селектор возвращает запись messagesByChat[chatId]; ref меняется только при
  // setMessagesWindow/prependOlderMessages/addMessage ДЛЯ ЭТОГО chatId. Чужой
  // чат стримит → ref стабилен → без ре-рендера сплита.
  const cacheEntry = useChatStore(s => s.messagesByChat[chatId])
  const messages = useMemo(() => cacheEntry?.messages ?? [], [cacheEntry])
  const hasOlderMessages = cacheEntry?.hasOlder ?? false
  // ── Узкие live-селекторы (как в ChatPage) ──────────────────────────
  // setLiveState делает { ...prev, ...partial } — при text-флаше (50мс)
  // меняется только text → Object.is по неизменным полям → без ре-рендера.
  const liveIsTyping = useChatStore(s => s.liveByChat[chatId]?.isTyping) ?? false
  const liveIsAgentRunning = useChatStore(s => s.liveByChat[chatId]?.isAgentRunning) ?? false
  const liveIsThinkingLive = useChatStore(s => s.liveByChat[chatId]?.isThinkingLive) ?? false
  const liveThinkingMs = useChatStore(s => s.liveByChat[chatId]?.thinkingMs)
  const liveSteps = useChatStore(s => s.liveByChat[chatId]?.steps) ?? EMPTY_STEPS
  const liveIters = useChatStore(s => s.liveByChat[chatId]?.iters) ?? EMPTY_ITERS
  const liveTodo = useChatStore(s => s.liveByChat[chatId]?.todo) ?? EMPTY_TODO
  const liveMsgId = useChatStore(s => s.liveByChat[chatId]?.msgId) ?? null
  const liveToolProgress = useChatStore(s => s.liveByChat[chatId]?.toolProgress) ?? EMPTY_TOOL_PROGRESS
  const liveSpawnedAgents = useChatStore(s => s.liveByChat[chatId]?.spawnedAgents) ?? EMPTY_SPAWNED_AGENTS
  const liveRateLimitSec = useChatStore(s => s.liveByChat[chatId]?.rateLimitSec) ?? 0
  const liveAgentStatus = useChatStore(s => s.liveByChat[chatId]?.agentStatus) ?? null
  const liveRetry = useChatStore(s => s.liveByChat[chatId]?.retry)
  const liveLastError = useChatStore(s => s.liveByChat[chatId]?.lastError)
  const hasLiveText = useChatStore(s => !!(s.liveByChat[chatId]?.text))
  const lastTurnChanges = useChatStore(s => s.lastTurnChangesByChat[chatId]) ?? null
  const liveChanges = useMemo(() => computeLiveChanges(liveSteps), [liveSteps])
  const badgeChanges = lastTurnChanges ?? (liveIsAgentRunning ? liveChanges : null)
  const badgeLive = liveIsAgentRunning && !!liveChanges && !lastTurnChanges
  const chats = useChatStore(s => s.chats)
  const setMessagesWindow = useChatStore(s => s.setMessagesWindow)

  // ── Редактор чата (inline-правка) — общий хук с ChatPage ──
  const {
    editorMode: splitEditorMode,
    draftsCount: splitEditorDraftsCount,
    editsCount: splitEditorEditsCount,
    hiddenCount: splitEditorHiddenCount,
    deletedCount: splitEditorDeletedCount,
    applying: splitEditorApplying,
    apply: splitEditorApply,
    discard: splitEditorDiscard,
  } = useChatEditor(chatId)
  const prependOlderMessages = useChatStore(s => s.prependOlderMessages)
  const addMessage = useChatStore(s => s.addMessage)
  const clearLiveState = useChatStore(s => s.clearLiveState)
  const chat = useMemo(() => chats.find(c => c.id === chatId), [chats, chatId])
  const isIncognito = !!chat?.isIncognito
  const currentWorkdir = chat?.workdir
  const activeMode = useChatStore(s => s.activeMode)
  const isTyping = liveIsTyping
  const isAgentRunning = liveIsAgentRunning

  const [toolOutputMode] = useState<ToolOutputMode>('normal')
  // isLoadingOlder — ЛОКАЛЬНЫЙ (не стор!), чтобы в split-режиме не контамини-
  // ровать спиннер ChatPage (две панели грузятся независимо). Связка ref+state:
  // ref — свежий read для bg-хука/скролл-триггера (без stale-closure), state —
  // для ререндера спиннера. Раньше state не сбрасывался на успехе → повторные
  // скролл-загрузки блокировались; теперь setIsLoadingOlder единообразно
  // сбрасывает через finally в loadOlderMessages и в bg-хуковом finally.
  const [isLoadingOlder, setIsLoadingOlderState] = useState(false)
  const isLoadingOlderRef = useRef(false)
  const setIsLoadingOlder = useCallback((v: boolean) => {
    isLoadingOlderRef.current = v
    setIsLoadingOlderState(v)
  }, [])
  const isLargeChat = useChatStore(s => selectIsLargeChat(s.chats, chatId))
  const [showSkeleton, setShowSkeleton] = useState(false)
  const isInitialScrollRef = useRef(true)
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animatedMsgIdsRef = useRef(new Set<string>())

  const [draft, setDraft] = useState('')
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [planningMode, setPlanningMode] = useState(false)
  const [imageMode, setImageMode] = useState(false)
  const [askMode, setAskMode] = useState(false)
  const [persona, setPersonaState] = useState<PersonaId>(DEFAULT_PERSONA)
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([])
  const draftAttachmentsRef = useRef<Attachment[]>([])
  const planningModeRef = useRef(false)
  const imageModeRef = useRef(false)
  const askModeRef = useRef(false)
  const personaRef = useRef<PersonaId>(DEFAULT_PERSONA)
  useEffect(() => { draftAttachmentsRef.current = draftAttachments }, [draftAttachments])
  useEffect(() => { planningModeRef.current = planningMode }, [planningMode])
  useEffect(() => { imageModeRef.current = imageMode }, [imageMode])
  useEffect(() => { askModeRef.current = askMode }, [askMode])
  useEffect(() => { personaRef.current = persona }, [persona])

  const [replyTo, setReplyTo] = useState<Message[]>([])
  const [mainModelId, setMainModelId] = useState('claude-sonnet-4-6')
  const [mainModelProviderId, setMainModelProviderId] = useState('anthropic')
  const [reasoningValue, setReasoningValue] = useState('')
  // Pick-guard (см. ChatPage.lastUserPickRef): поздний restore не затирает
  // свежий ручной выбор пользователя.
  const lastUserPickRef = useRef<{ chatId: string; ts: number } | null>(null)
  const [showContextRing] = useState(true)
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([])

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const chatInputWrapRef = useRef<HTMLDivElement>(null)

  // ── Загрузка модели / reasoning при монтировании ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [assignments, reason, chatModel, chatReasoning] = await Promise.all([
          window.syntee.settings.get('modelAssignments'),
          window.syntee.settings.get('reasoningValue'),
          // Per-chat модель имеет приоритет над глобальным назначением.
          (chat && !isIncognito)
            ? window.syntee.chat.getModel(chatId).catch(() => null)
            : Promise.resolve(null),
          (chat && !isIncognito)
            ? window.syntee.chat.getReasoning(chatId).catch(() => null)
            : Promise.resolve(null),
        ])
        if (cancelled) return
        if (chatModel) {
          setMainModelId(chatModel.modelId)
          setMainModelProviderId(chatModel.modelProvider)
        } else if (Array.isArray(assignments)) {
          const main = (assignments as Array<{ role: string; modelId: string; providerId?: string }>).find(a => a.role === 'main')
          if (main) {
            setMainModelId(main.modelId)
            setMainModelProviderId(main.providerId ?? 'anthropic')
          }
        }
        // Per-chat reasoning имеет приоритет; глобальный — дефолт.
        if (typeof chatReasoning === 'string') setReasoningValue(chatReasoning)
        else if (typeof reason === 'string' && reason) setReasoningValue(reason)
      } catch { /* ok */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Загрузка кастомных команд и modes/draft для этого chatId
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cmds = await window.syntee.commands.list({ projectWorkdir: currentWorkdir }) as SlashCommand[]
        if (!cancelled) setCustomCommands(cmds)
      } catch { /* ok */ }
      if (!chat || isIncognito) {
        setDraft('')
        setPlanningMode(false)
        setImageMode(false)
        setAskMode(false)
        setPersonaState(DEFAULT_PERSONA); personaRef.current = DEFAULT_PERSONA
        setDraftAttachments([])
        return
      }
      try {
        // Сбрасываем режимы синхронно — чтобы UI не показывал вспышку
        // режимов предыдущего чата пока async-load не завершится.
        setPlanningMode(false); setImageMode(false); setAskMode(false)
        // Модель + reasoning — ОТДЕЛЬНАЯ цепочка (как в ChatPage): падение
        // modes/draft-загрузки не должно блокировать их восстановление.
        // PICK-GUARD: поздний restore не затирает свежий ручной выбор.
        const targetChatId = chatId
        const restoreStartedAt = Date.now()
        Promise.all([
          window.syntee.chat.getModel(targetChatId).catch(() => null),
          window.syntee.chat.getReasoning(targetChatId).catch(() => null),
        ]).then(([m, r]) => {
          if (cancelled || targetChatId !== chatId) return
          const pick = lastUserPickRef.current
          if (pick && pick.chatId === targetChatId && pick.ts > restoreStartedAt) return
          if (m) {
            setMainModelId(m.modelId)
            setMainModelProviderId(m.modelProvider)
          }
          if (typeof r === 'string') setReasoningValue(r)
        }).catch(() => {})
        const [modes, draftText, history, attachments, loadedPersona] = await Promise.all([
          window.syntee.chat.getModes(chatId).catch(() => null),
          window.syntee.chat.getDraft(chatId).catch(() => null),
          window.syntee.chat.getInputHistory(chatId).catch(() => null),
          window.syntee.draft.getAttachments(chatId).catch(() => null),
          window.syntee.chat.getPersona(chatId).catch(() => null),
        ])
        if (cancelled) return
        if (modes) {
          setPlanningMode(!!modes.planningMode)
          setImageMode(!!modes.imageMode)
          setAskMode(!!modes.askMode)
        }
        const safePersona = isValidPersona(loadedPersona) ? loadedPersona : DEFAULT_PERSONA
        setPersonaState(safePersona); personaRef.current = safePersona
        setDraft(typeof draftText === 'string' ? draftText : '')
        setDraftAttachments(Array.isArray(attachments) ? attachments as Attachment[] : [])
        setInputHistory(Array.isArray(history) ? history.reverse() : [])
      } catch { /* ok */ }
    })()
    return () => { cancelled = true }
  }, [chatId, currentWorkdir, isIncognito, chat])

  // ── Загрузка сообщений (первая страница) + гидрация live ──
  useEffect(() => {
    let cancelled = false
    isInitialScrollRef.current = true
    animatedMsgIdsRef.current = new Set()
    ;(async () => {
      // Если уже в кеше — не дёргаем IPC, кеш актуален.
      const cached = useChatStore.getState().messagesByChat[chatId]
      if (cached) {
        setShowSkeleton(false)
        return
      }
      skeletonTimerRef.current = setTimeout(() => { if (!cancelled) setShowSkeleton(true) }, 120)
      await hydrateFromMain(chatId)
      try {
        const res = await window.syntee.chat.getMessagesPage(chatId, 50)
        if (cancelled) return
        setMessagesWindow(chatId, res.messages, res.hasMore)
        if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
        setShowSkeleton(false)
      } catch {
        if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
        setShowSkeleton(false)
      }
    })()
    return () => {
      cancelled = true
      if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
    }
  }, [chatId, setMessagesWindow])

  // ── Autoscroll — общий движок «прилип/отлип» (useChatAutoscroll, как в
  // основном чате). Прилип → rAF-loop плавно догоняет любой рост; колесо/
  // touch/скроллбар вверх → мгновенный отлип; ручной доезд до низа → прилип.

  // Reverse-infinite scroll
  const prependingRef = useRef<{ oldScrollHeight: number; oldScrollTop: number } | null>(null)
  const loadOlderMessages = useCallback(async () => {
    const st = useChatStore.getState()
    if (st.messagesByChat[chatId]?.hasOlder === false || isLoadingOlderRef.current) return
    const entry = st.messagesByChat[chatId]
    const oldest = entry?.messages[0]
    if (!oldest) return
    const el = scrollContainerRef.current
    if (el) prependingRef.current = { oldScrollHeight: el.scrollHeight, oldScrollTop: el.scrollTop }
    setIsLoadingOlder(true)
    try {
      const res = await window.syntee.chat.getMessagesPage(chatId, 50, oldest.createdAt, oldest.id)
      prependOlderMessages(chatId, res.messages, res.hasMore)
    } catch {
      // Ошибка — молча. Слот освободит finally.
    } finally {
      // Явный сброс: раньше на успехе state НЕ сбрасывался (prependOlderMessages
      // правит только стор-флаг, не локальный) → повторные скролл-загрузки
      // блокировались навсегда. Теперь единообразно через finally.
      setIsLoadingOlder(false)
    }
  }, [chatId, prependOlderMessages, setIsLoadingOlder])
  const loadOlderRef = useRef(loadOlderMessages)
  loadOlderRef.current = loadOlderMessages

  const {
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
      if (el.scrollTop < 200 && hasOlderMessages && !isLoadingOlderRef.current) loadOlderRef.current()
    },
  })

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
  // Переиспользует prependingRef для скролл-компенсации. Большие чаты —
  // reverse-infinite scroll со спиннером. Дедуп со скролл-триггером через
  // ЛОКАЛЬНЫЙ флаг (независимость от ChatPage в split-режиме).
  useBackgroundLoadFullChat({
    chatId,
    isLargeChat,
    prependingRef,
    scrollContainerRef,
    isBusy: () => isLoadingOlderRef.current,
    setBusy: setIsLoadingOlder,
  })

  // Мгновенный скролл вниз по клику на floating-кнопку + закрепление.
  // instant=true — прыжок без анимации даже во время стрима + «липкий низ».
  const handleScrollDownClick = () => pinAutoscroll(true)

  // Первый скролл при открытии чата — мгновенно к низу + прилип. Дальнейшее
  // следование за ростом контента делает rAF-loop движка автоскролла.
  useEffect(() => {
    if (messages.length === 0) return
    if (isInitialScrollRef.current) {
      requestAnimationFrame(() => { pinAutoscroll(true); isInitialScrollRef.current = false })
    }
  }, [messages.length, isTyping, pinAutoscroll])

  // Отступ под ChatInput
  useEffect(() => {
    const holder = chatInputWrapRef.current
    const container = holder?.parentElement
    const wrap = holder?.firstElementChild as HTMLElement | null
    if (!wrap || !container) return
    const apply = () => container.style.setProperty('--chat-input-h', `${wrap.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Звук завершения. RACE GUARD (смена chatId-пропа): при переключении
  // сплита на другой чат isTyping падает в false не из-за завершения
  // стрима, а потому что live теперь указывает на другой чат — не играем
  // звук, только синхронизируем ref.
  const prevIsTypingRef = useRef(false)
  const prevSoundChatIdRef = useRef(chatId)
  useEffect(() => {
    if (prevSoundChatIdRef.current !== chatId) {
      prevSoundChatIdRef.current = chatId
      prevIsTypingRef.current = isTyping
      return
    }
    if (prevIsTypingRef.current && !isTyping) playDoneSound()
    prevIsTypingRef.current = isTyping
  }, [isTyping, chatId])

  // ── Контекст-счётчик ──
  const contextInfo = useContextCounter({
    chatId,
    currentInput: draft,
    modelId: mainModelId,
    incognito: isIncognito,
    enabled: showContextRing && !isIncognito,
    messageCount: messages.length,
    isRunning: isTyping,
  })

  // Индивидуальные персисты — каждый пишет только свой режим, не затрагивая
  // остальные. Устраняет кросс-контаминацию через stale ref'ы.
  const persistPlanningMode = useCallback((v: boolean) => {
    if (!chatId || isIncognito) return
    window.syntee.chat.setPlanningMode(chatId, v).catch(() => {})
  }, [chatId, isIncognito])
  const persistImageMode = useCallback((v: boolean) => {
    if (!chatId || isIncognito) return
    window.syntee.chat.setImageMode(chatId, v).catch(() => {})
  }, [chatId, isIncognito])
  const persistAskMode = useCallback((v: boolean) => {
    if (!chatId || isIncognito) return
    window.syntee.chat.setAskMode(chatId, v).catch(() => {})
  }, [chatId, isIncognito])

  const persistPersona = useCallback((v: PersonaId) => {
    if (!chatId || isIncognito) return
    window.syntee.chat.setPersona(chatId, v).catch(() => {})
  }, [chatId, isIncognito])

  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleDraftChange = useCallback((text: string) => {
    setDraft(text)
    if (!chatId || isIncognito) return
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
    draftSaveTimerRef.current = setTimeout(() => {
      window.syntee.chat.setDraft(chatId, text).catch(() => {})
    }, 300)
  }, [chatId, isIncognito])

  const attTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleAttachmentsChange = useCallback((atts: Attachment[]) => {
    setDraftAttachments(atts)
    if (!chatId || isIncognito) return
    if (attTimerRef.current) clearTimeout(attTimerRef.current)
    attTimerRef.current = setTimeout(() => {
      window.syntee.draft.setAttachments(chatId, atts).catch(() => {})
    }, 300)
  }, [chatId, isIncognito])

  const handleReasoningChange = useCallback((value: string) => {
    setReasoningValue(value)
    // Per-chat reasoning (см. ChatPage.handleReasoningChange): пишем в чат,
    // глобальная настройка — дефолт для новых чатов.
    if (!isIncognito) {
      lastUserPickRef.current = { chatId, ts: Date.now() }
      window.syntee.chat.setReasoning(chatId, value).catch(() => {})
    }
    window.syntee.settings.set('reasoningValue', value).catch(() => {})
  }, [chatId, isIncognito])

  const handleMainModelChange = useCallback(async (modelId: string, providerId: string) => {
    setMainModelId(modelId)
    setMainModelProviderId(providerId)
    // Per-chat модель сплит-чата (см. ChatPage.handleMainModelChange).
    if (!isIncognito) {
      lastUserPickRef.current = { chatId, ts: Date.now() }
      window.syntee.chat.setModel(chatId, modelId, providerId).catch((e: unknown) => {
        console.error('[SplitChatPane] chat:setModel', e)
      })
    }
  }, [chatId, isIncognito])

  const handleStop = useCallback(() => {
    clearLiveState(chatId)
    window.syntee.chat.stop(chatId)
  }, [chatId, clearLiveState])

  const handlePin = useCallback(() => {}, [])
  const handleCopy = useCallback(() => {}, [])
  const handleReply = useCallback((message: Message) => {
    setReplyTo(prev => prev.some(m => m.id === message.id) ? prev : [...prev, message])
  }, [])
  const handleCancelReply = useCallback((id: string) => {
    setReplyTo(prev => prev.filter(m => m.id !== id))
  }, [])

  const handleRewind = useCallback(async (userMessageId: string) => {
    const result = await window.syntee.chat.rewindTo(chatId, userMessageId) as { messages?: Message[]; error?: string }
    if (result.error) return
    if (result.messages) setMessagesWindow(chatId, result.messages, false)
  }, [chatId, setMessagesWindow])

  const compactSessionStats = useMemo(() => {
    let count = 0, totalTokensSaved = 0
    for (const m of messages) {
      if (m.slashCommand?.name === 'compact' && m.compactStats) {
        count++
        totalTokensSaved += m.compactStats.tokensSaved
      }
    }
    return { count, totalTokensSaved }
  }, [messages])

  const overlayTodo = useMemo(() => {
    if (liveTodo.length > 0) return liveTodo
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant' || !m.todo?.length) continue
      const unfinished = m.todo.some(it => it.status === 'pending' || it.status === 'in_progress')
      return unfinished ? m.todo : []
    }
    return []
  }, [liveTodo, messages])
  const overlayActive = isTyping || overlayTodo.length > 0

  const hasLiveContent = hasLiveText || liveIsThinkingLive || liveSteps.length > 0 ||
    liveIters.length > 0 || Object.keys(liveToolProgress).length > 0
  const showLiveBubble = (hasLiveContent || isTyping) && !!liveMsgId

  const displayMessages = useMemo(() => {
    let result = messages
    if (showLiveBubble) {
      result = [...result, {
        id: 'split-live-streaming-bubble',
        chatId,
        role: 'assistant' as const,
        content: '',
        createdAt: Date.now(),
        isPinned: 0,
        toolSteps: liveSteps.length > 0 ? liveSteps as Message['toolSteps'] : undefined,
        liveIters: liveIters,
        liveTextAfter: undefined,
        liveTodo: liveTodo,
        agentStatus: liveAgentStatus,
        toolProgress: liveToolProgress,
        spawnedAgents: liveSpawnedAgents,
        livePlanningMode: planningMode,
        rateLimitSec: liveRateLimitSec > 0 ? liveRateLimitSec : undefined,
        retry: liveRetry,
        lastError: liveLastError,
      } as Message & Record<string, unknown>]
    }
    return result
  }, [messages, showLiveBubble, chatId, liveSteps, liveIters, liveTodo, liveToolProgress, liveSpawnedAgents, liveRateLimitSec, liveAgentStatus, liveRetry, liveLastError, planningMode])

  const getItemKey = useCallback(
    (index: number) => displayMessages[index]?.id ?? index,
    [displayMessages],
  )

  // ── Module-level кэш высот рядов (переживает remount виртуализатора) ──
  // См. подробное описание в ChatPage.tsx — идентичная логика для сплит-панели.
  const rowHeightsRef = useRef<Map<string, number>>(new Map())

  const estimateSize = useCallback(
    (index: number) => {
      const id = displayMessages[index]?.id
      if (id) {
        const cached = rowHeightsRef.current.get(id)
        if (cached) return cached
      }
      return 120
    },
    [displayMessages],
  )

  // Сброс кэша при смене chatId сплит-панели.
  useEffect(() => {
    rowHeightsRef.current.clear()
  }, [chatId])

  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    getItemKey,
    overscan: 5,
    useAnimationFrameWithResizeObserver: true,
  })

  // Обёртка над virtualizer.measureElement (после virtualizer, т.к. зависит от него)
  const measureRef = useCallback((el: Element | null) => {
    if (el) {
      const id = el.getAttribute('data-msg-id')
      if (id) {
        const h = (el as HTMLElement).getBoundingClientRect().height
        if (h > 0) rowHeightsRef.current.set(id, h)
      }
    }
    return virtualizer.measureElement(el)
  }, [virtualizer])

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

  // ── Отправка ──
  const handleSend = useCallback(async (text: string) => {
    const raw = text.trim()
    if (!raw) return
    const slash = parseSlashCommandWithCustom(raw, customCommands)
    // При отправке — принудительный прилип к низу (как в основном чате).
    pinAutoscroll()

    if (slash?.command.name === 'clear') {
      setMessagesWindow(chatId, [], false)
      return
    }
    if (slash?.command.name === 'sys') {
      if (!slash.args) return
      await window.syntee.models.setParams({ systemPrompt: slash.args })
      return
    }

    const displayContent = raw
    let aiContent: string = raw
    let oneShotSkill: { name: string; instructions: string } | undefined
    let oneShotAllowedTools: string[] | undefined
    let oneShotMode: 'ask' | 'plan' | 'code' | undefined
    let oneShotPersona: PersonaId | undefined

    if (slash) {
      const sysPrompt = slash.command.systemPrompt(slash.args)
      if (sysPrompt) aiContent = sysPrompt
      if (slash.command.personaOverride) oneShotPersona = slash.command.personaOverride
      if (slash.command.custom) {
        if (slash.command.mode) oneShotMode = slash.command.mode
        if (slash.command.allowedTools?.length) oneShotAllowedTools = slash.command.allowedTools
      }
      if (slash.command.skill) {
        try {
          const skills = await window.syntee.skills.getAll({ projectId: chat?.projectId }) as Array<{ name: string; instructions: string }>
          const found = skills.find(s => s.name === slash.command.skill)
          if (found) oneShotSkill = { name: found.name, instructions: found.instructions }
        } catch { /* ok */ }
      }
    }

    // ── Реплай-цитаты ── метаданные в main (цитата строится там), вложения
    // исходных сообщений сливаются в отправку с source:'reply' (см. ChatPage).
    const replyMeta: ReplyTarget[] | undefined = replyTo.length > 0
      ? replyTo.map(r => ({
          id: r.id,
          // сужение role: у Message есть 'system', у реплай-цели — нет
          role: r.role === 'user' ? 'user' as const : 'assistant' as const,
          content: r.content,
          attachmentsCount: r.attachments?.filter(a => (a.kind === 'file' || a.kind === 'image' || a.kind === 'audio' || a.kind === 'video') && a.path).length || undefined,
        }))
      : undefined
    const replyAttachments: Attachment[] = []
    for (const r of replyTo) {
      for (const a of r.attachments ?? []) {
        if ((a.kind === 'file' || a.kind === 'image' || a.kind === 'audio' || a.kind === 'video') && a.path) {
          replyAttachments.push({ ...a, id: uuid(), source: 'reply' })
        }
      }
    }
    const mergedAttachments = [...draftAttachmentsRef.current, ...replyAttachments]

    const userMsg: Message = {
      id: uuid(), chatId, role: 'user',
      content: displayContent, createdAt: Date.now(), isPinned: 0,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
      replyTo: replyMeta,
    }
    setReplyTo([])
    const attachmentsToSend = mergedAttachments
    if (!isIncognito) {
      setDraftAttachments([])
      draftAttachmentsRef.current = []
      window.syntee.draft.clearAttachments(chatId).catch(() => {})
    }
    setDraft('')

    const result = await window.syntee.chat.send({
      chatId,
      content: aiContent,
      displayContent: displayContent !== aiContent ? displayContent : undefined,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      userMsgId: userMsg.id,
      planningMode,
      askMode: askMode || slash?.command.name === 'ask',
      imageMode,
      persona,
      mode: activeMode,
      oneShotSkill, oneShotAllowedTools, oneShotMode, oneShotPersona,
      // Уровень мышления из UI на момент клика (source of truth, см. ChatPage).
      reasoningValue: reasoningValue,
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
      // Реплай-цитаты — main строит из них цитату для AI и персистит в БД.
      replyTo: replyMeta,
    }) as { queued?: boolean; assistantMsgId?: string }

    if (result.queued && result.assistantMsgId) {
      enqueuePendingUserMsg(result.assistantMsgId, userMsg)
    } else {
      addMessage(userMsg)
      initChatSend(chatId)
      requestAnimationFrame(() => pinAutoscroll(true))
    }
  }, [chatId, customCommands, replyTo, isIncognito, planningMode, askMode, imageMode, persona, activeMode, reasoningValue, addMessage, setMessagesWindow, pinAutoscroll, chat])

  const chatTitle = chat?.title ?? 'Чат'

  return (
    <main className="chat-main split-chat-pane">
      <div className="split-chat-header no-drag">
        <span className="split-chat-header-icon">
          <AppIcon name="columns" size="xs" tone="accent" />
        </span>
        <span className="split-chat-header-title" title={chatTitle}>{chatTitle}</span>
        {!isIncognito && (
          <button
            className={`split-chat-editor-btn${splitEditorMode ? ' split-chat-editor-btn--active' : ''}`}
            onClick={() => { if (!splitEditorMode) useChatStore.getState().enterEditorMode(chatId) }}
            title={splitEditorMode ? 'Редактор активен' : 'Редактор чата'}
            aria-label="Редактор чата"
          >
            <AppIcon name="edit" size="xs" />
          </button>
        )}
        <button className="split-chat-close" onClick={onClose} title="Закрыть сплит">
          <AppIcon name="x" size="sm" />
        </button>
      </div>
      <LiveTodoBar items={overlayTodo} active={overlayActive} />

      {/* ── Редактор чата: компактная плашка режима правки (общий хук
          useChatEditor — та же логика применения, что в ChatPage) ── */}
      <AnimatePresence>
        {splitEditorMode && (
          <motion.div
            key="split-editor-bar"
            className="chat-editor-bar chat-editor-bar--split"
            initial={{ opacity: 0, y: -14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
          >
            <span className="chat-editor-bar__icon">
              <AppIcon name="edit" size="xs" />
            </span>
            <span className="chat-editor-bar__label">Редактирование</span>
            {splitEditorDraftsCount > 0 && (
              <span className="chat-editor-bar__chips">
                {splitEditorEditsCount > 0 && (
                  <span className="chat-editor-bar__chip chat-editor-bar__chip--edit">
                    <AppIcon name="edit" size="xs" /> {splitEditorEditsCount}
                  </span>
                )}
                {splitEditorHiddenCount > 0 && (
                  <span className="chat-editor-bar__chip chat-editor-bar__chip--hidden">
                    <AppIcon name="eyeOff" size="xs" /> {splitEditorHiddenCount}
                  </span>
                )}
                {splitEditorDeletedCount > 0 && (
                  <span className="chat-editor-bar__chip chat-editor-bar__chip--deleted">
                    <AppIcon name="trash" size="xs" /> {splitEditorDeletedCount}
                  </span>
                )}
              </span>
            )}
            <div className="chat-editor-bar__actions">
              <button type="button" className="chat-editor-bar__btn chat-editor-bar__btn--ghost" onClick={splitEditorDiscard} disabled={splitEditorApplying}>
                <AppIcon name="x" size="xs" />
                <span>Отменить</span>
              </button>
              <button type="button" className="chat-editor-bar__btn chat-editor-bar__btn--primary" onClick={() => void splitEditorApply()} disabled={splitEditorApplying}>
                <AppIcon name="check" size="xs" />
                <span>{splitEditorApplying ? '…' : splitEditorDraftsCount === 0 ? 'Закрыть' : `Применить (${splitEditorDraftsCount})`}</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {showSkeleton ? (
        <motion.div key="skel" className="chat-skeleton" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          {[0.4, 0.7, 0.5, 0.9, 0.6, 0.8].map((w, i) => (
            <div key={i} className={`chat-skeleton-row ${i % 3 === 0 ? 'chat-skeleton-row--user' : ''}`}>
              <div className="chat-skeleton-bubble" style={{ width: `${w * 100}%` }} />
            </div>
          ))}
        </motion.div>
      ) : displayMessages.length === 0 && !isTyping ? (
        <div className="chat-empty-state">
          <div className="chat-empty-icon"><Logo size={40} /></div>
          <h2>{chatTitle}</h2>
          <p>Сплит-чат. Напишите сообщение…</p>
        </div>
      ) : (
        <div className="chat-messages" ref={scrollContainerRef} onScroll={handleScroll} onWheel={handleWheel} onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove}>
          {isLoadingOlder && isLargeChat && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', padding: '6px 0', zIndex: 2, pointerEvents: 'none' }}>
              <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid rgba(127,127,127,0.25)', borderTopColor: 'rgba(127,127,127,0.7)', animation: 'chat-older-spin 0.7s linear infinite' }} />
            </div>
          )}
          <ChatRemeasureContext.Provider value={requestRemeasure}>
            <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vItem => {
                const msg = displayMessages[vItem.index]
                const isLive = msg.id === 'split-live-streaming-bubble'
                const liveThinking = isLive && (liveIsThinkingLive || liveThinkingMs !== undefined)
                  ? { isLive: liveIsThinkingLive, ms: liveThinkingMs, storeChatId: chatId }
                  : undefined
                const shouldAnimate = !animatedMsgIdsRef.current.has(msg.id)
                if (shouldAnimate) animatedMsgIdsRef.current.add(msg.id)
                return (
                  <VirtualMessageItem
                    key={msg.id}
                    msg={msg}
                    vItemStart={vItem.start}
                    vItemIndex={vItem.index}
                    measureRef={measureRef}
                    toolOutputMode={toolOutputMode}
                    onPin={handlePin}
                    onCopy={handleCopy}
                    onReply={handleReply}
                    onRewind={handleRewind}
                    liveThinking={liveThinking}
                    isStreaming={isLive && isTyping}
                    isWaiting={isLive && isTyping}
                    rateLimitSec={isLive ? liveRateLimitSec : undefined}
                    shouldAnimate={shouldAnimate}
                    editorAvailable={!isIncognito}
                  />
                )
              })}
            </div>
          </ChatRemeasureContext.Provider>
        </div>
      )}

      {/* Миникарта сообщений — точки навигации справа по центру панели. */}
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
          chatId={chatId}
          onSend={handleSend}
          disabled={isTyping || splitEditorMode}
          isIncognito={isIncognito}
          replyTo={replyTo}
          onCancelReply={handleCancelReply}
          isGenerating={isTyping || isAgentRunning}
          onStop={handleStop}
          contextInfo={contextInfo}
          showContextRing={showContextRing}
          value={draft}
          onChangeValue={handleDraftChange}
          inputHistory={inputHistory}
          mainModelId={mainModelId}
          mainModelProviderId={mainModelProviderId}
          onMainModelChange={handleMainModelChange}
          reasoningValue={reasoningValue}
          onReasoningChange={handleReasoningChange}
          planningMode={planningMode}
          onPlanningModeChange={(v) => { setPlanningMode(v); persistPlanningMode(v) }}
          imageMode={imageMode}
          onImageModeChange={(v) => { setImageMode(v); persistImageMode(v) }}
          askMode={askMode}
          onAskModeChange={(v) => { setAskMode(v); persistAskMode(v) }}
          persona={persona}
          onPersonaChange={(v) => { setPersonaState(v); personaRef.current = v; persistPersona(v) }}
          workdir={currentWorkdir}
          compactSessionStats={compactSessionStats}
          customCommands={customCommands}
          attachments={draftAttachments}
          onAttachmentsChange={handleAttachmentsChange}
          lastTurnChanges={badgeChanges}
          badgeLive={badgeLive}
        />
      </div>
    </main>
  )
}

export default memo(SplitChatPane)
