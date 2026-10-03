import type { Message, ToolStep, QueueItemMeta } from '../../../shared/types'
import { useChatStore, type LiveIter, type ChatLiveState } from '../store/chat.store'

// Per-chat mutable буферы для высокочастотных обновлений (токены стриминга).
// Не React-state — обновляется синхронно на каждый токен, а Zustand store
// обновляется через RAF throttle (60fps). Раньше эти буферы лежали в
// useState ChatPage и были общими для всех чатов — при переключении чатов
// токены чужого чата silently дропались фильтром chatId !== current.
// Теперь: один буфер на chatId в module-level Map. ChatPage читает
// отображаемое состояние из liveByChat[currentChatId] в Zustand.
export interface ChatBuffers {
  text: string               // liveTextAfter — текст после последних тулов
  thinking: string           // pendingThinking — накопленный reasoning раунда
  thinkingMs?: number        // длительность reasoning текущего раунда
  isThinkingLive: boolean    // reasoning ещё стримится
  iters: LiveIter[]          // итерации тула (textBefore + steps)
  steps: ToolStep[]          // плоский список шагов (для финального сохранения)
  todo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  agentStatus: string | null
  rateLimitSec: number
  rateLimitCountdown?: ReturnType<typeof setInterval>
  tokenBuf: string           // time-based throttle буфер для text-токенов
  thinkingBuf: string        // time-based throttle буфер для thinking-токенов
  flushTimer: ReturnType<typeof setTimeout> | null  // id setTimeout для батч-флеша
  streamMsgId: string | null // msgId текущего стрима (для матчинга step→итерация)
  toolProgress: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
  /** Live-маппинг саб-агентов текущего стрима (для мгновенной карточки). */
  spawnedAgents: Array<{ agentId: string; callId?: string; task: string; msgId: string; model?: string; role?: string; ts: number }>
  retry: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  lastError: string | null
}

export const buffers = new Map<string, ChatBuffers>()

// Отложенные user-сообщения для queued-запросов. Ключ — assistantMsgId
// (будущий id ответа), значение — user-сообщение. Когда queued-запрос
// стартует (статус 'running' с этим msgId), сообщение достаётся отсюда и
// addMessage'ится в чат — это сохраняет порядок: user1 → assistant1 →
// user2 → assistant2, вместо user1 user2 user3 → assistant1 assistant2 assistant3.
export const pendingUserMsgs = new Map<string, Message>()

// ── Periodic cleanup orphaned buffers ──────────────────────────────────
// Очистка буферов без активного стрима (worker упал без эвита события,
// IPC разорвался, окно закрылось во время стрима). Без этого буфер с
// текстом/шагами/токенами остаётся в Map навсегда.
if (typeof window !== 'undefined') {
  const CLEANUP_INTERVAL_MS = 5 * 60 * 1000  // проверка раз в 5 минут
  setInterval(() => {
    for (const [id, buf] of buffers) {
      // streamMsgId === 'streaming-pending' и нет flushTimer → стрим не идёт
      if (buf.streamMsgId === 'streaming-pending' && buf.flushTimer === null) {
        if (!buf.rateLimitCountdown) {
          buffers.delete(id)
        }
      }
    }
    // Также чистим pendingUserMsgs (orphaned queued-сообщения)
    if (pendingUserMsgs.size > 50) {
      const oldest = pendingUserMsgs.keys().next().value
      if (oldest) pendingUserMsgs.delete(oldest)
    }
  }, CLEANUP_INTERVAL_MS)
}

/**
 * Регистрирует user-сообщение как отложенное для queued-запроса.
 * Вызывается из ChatPage.handleSend когда chat:send вернул queued: true.
 * Сообщение будет добавлено в чат когда запрос стартует (статус 'running').
 */
export function enqueuePendingUserMsg(assistantMsgId: string, userMsg: Message) {
  pendingUserMsgs.set(assistantMsgId, userMsg)
}

/**
 * Убирает отложенное user-сообщение (например, при cancel из очереди).
 * Вызывается из QueuePanel при remove элемента очереди.
 */
export function removePendingUserMsg(assistantMsgId: string) {
  pendingUserMsgs.delete(assistantMsgId)
}

export function getBuf(chatId: string): ChatBuffers {
  let buf = buffers.get(chatId)
  if (!buf) {
    buf = {
      text: '', thinking: '', thinkingMs: undefined, isThinkingLive: false,
      iters: [], steps: [], todo: [], agentStatus: null, rateLimitSec: 0,
      tokenBuf: '', thinkingBuf: '', flushTimer: null, streamMsgId: null,
      toolProgress: {}, retry: null, lastError: null, spawnedAgents: [],
    }
    buffers.set(chatId, buf)
  }
  return buf
}

/**
 * Инициализация буфера для нового запуска chat:send. Вызывается из ChatPage
 * перед отправкой сообщения. Устанавливает streamMsgId = 'streaming-pending'
 * и выставляет isTyping в store, чтобы live-пузырь появился сразу.
 * Если в этом чате уже есть активный буфер (например, ждёт в очереди) —
 * не трогаем его, новый send встанет в очередь в main-процессе.
 */
export function initChatSend(chatId: string) {
  // Если буфер уже есть и активен — не перезаписываем (main поставит в очередь)
  if (buffers.has(chatId)) return
  const buf = getBuf(chatId)
  buf.streamMsgId = 'streaming-pending'
  buf.text = ''
  buf.thinking = ''
  buf.thinkingMs = undefined
  buf.isThinkingLive = false
  buf.iters = []
  buf.steps = []
  buf.todo = []
  buf.agentStatus = null
  buf.rateLimitSec = 0
  buf.tokenBuf = ''
  buf.thinkingBuf = ''
  buf.retry = null
  buf.lastError = null
  buf.spawnedAgents = []
  useChatStore.getState().hydrateLiveState(chatId, {
    msgId: 'streaming-pending',
    text: '',
    thinking: '',
    isThinkingLive: false,
    iters: [],
    steps: [],
    todo: [],
    agentStatus: null,
    rateLimitSec: 0,
    retry: null,
    lastError: null,
    isTyping: true,
    isAgentRunning: false,
  })
  // Оптимистичный runStatus='running' — спиннер в сайдбаре/табах появляется
  // мгновенно. Реальный CHAT_RUN_STATUS:'running' из main эмитится только
  // после тяжёлой инициализации внутри runChatSend (чтение store, запись в
  // БД, system prompt, создание worker'а — 100-500мс+). В этом окне чат
  // выглядел idle: при быстром переключении в другой чат у прошлого не было
  // никакого индикатора работы. Перезаписывается тем же 'running' из main
  // (фактически no-op) или терминальным статусом по завершении. Guard
  // выше (buffers.has) отсекает queued-посылки — для них main сам эмитит
  // 'queued' и ставит корректный статус.
  useChatStore.getState().setRunStatus(chatId, 'running')
}

/**
 * Гидрация буфера из main при возврате в чат с активным агентом.
 * ChatPage вызывает это при selectChat — если в main есть ActiveRun,
 * копируем его буферы сюда, чтобы продолжить стрим с того же места.
 */
export async function hydrateFromMain(chatId: string): Promise<boolean> {
  try {
    const live = await window.syntee.chat.getLiveState(chatId) as {
      chatId: string; msgId: string; isRunning: boolean
      bufferedText: string; bufferedThinking: string; bufferedThinkingMs?: number
      bufferedSteps: unknown[]; bufferedIters: unknown[]
      bufferedTodo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
      bufferedAgentStatus: string | null; bufferedRateLimitSec: number
      bufferedRetry: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
      liveState?: {
        toolProgress: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
        spawnedAgents: Array<{ agentId: string; callId?: string; task: string; msgId: string; model?: string; role?: string; ts: number }>
      }
      meta: QueueItemMeta | null
    } | null
    if (!live || !live.isRunning) {
      // В main нет активного запуска — чистим локальный буфер если был
      buffers.delete(chatId)
      useChatStore.getState().clearLiveState(chatId)
      useChatStore.getState().setActiveRun(chatId, null)
      return false
    }
    const buf = getBuf(chatId)
    buf.streamMsgId = live.msgId
    buf.text = live.bufferedText || ''
    buf.thinking = live.bufferedThinking || ''
    buf.thinkingMs = live.bufferedThinkingMs
    buf.isThinkingLive = false
    buf.iters = (live.bufferedIters as LiveIter[]) || []
    buf.steps = (live.bufferedSteps as ToolStep[]) || []
    buf.todo = live.bufferedTodo || []
    buf.agentStatus = live.bufferedAgentStatus
    buf.rateLimitSec = live.bufferedRateLimitSec || 0
    buf.tokenBuf = ''
    // Восстанавливаем ephemeral live-состояние из единого снапшота main.
    // Универсально: любые будущие ephemeral-блоки добавляются в bufferedLiveState
    // в main и автоматически подхватываются здесь.
    buf.toolProgress = live.liveState?.toolProgress ?? {}
    buf.spawnedAgents = live.liveState?.spawnedAgents ?? []
    useChatStore.getState().hydrateLiveState(chatId, {
      msgId: live.msgId,
      text: buf.text,
      thinking: buf.thinking,
      thinkingMs: buf.thinkingMs,
      isThinkingLive: false,
      iters: buf.iters,
      steps: buf.steps,
      todo: buf.todo,
      agentStatus: buf.agentStatus,
      rateLimitSec: buf.rateLimitSec,
      retry: live.bufferedRetry ?? null,
      toolProgress: buf.toolProgress,
      spawnedAgents: buf.spawnedAgents,
      isTyping: true,
      isAgentRunning: buf.iters.length > 0 || buf.steps.length > 0,
    })
    // Восстанавливаем meta активного запуска для UI-панели очереди.
    if (live.meta) useChatStore.getState().setActiveRun(chatId, live.meta)
    return true
  } catch {
    return false
  }
}

// ── Side chat helpers ──────────────────────────────────────────────────
// Side-чат имеет chatId = 'sidechat:'+parentChatId. События стриминга
// приходят с этим chatId — нужно маршрутизировать их в sideChatByChat
// вместо обычных messages/liveByChat.
const SIDE_PREFIX = 'sidechat:'
export function isSideChat(chatId: string | undefined | null): boolean {
  return typeof chatId === 'string' && chatId.startsWith(SIDE_PREFIX)
}
export function sideParent(chatId: string): string { return chatId.slice(SIDE_PREFIX.length) }

// Aux-окна (spotlight/overlay/voice) грузят тот же renderer bundle и
// выполняют полный App.tsx со всеми эффектами. Но стрим-события чатов
// (chat:stream-token и др.) адресованы только главному окну — получать
// их здесь бессмысленно и вызывает спам в консоль (isSideChat на каждом
// токене) + лишнюю нагрузку. Гейт по hash маршрута.
export function isAuxWindow(): boolean {
  const hash = window.location.hash.replace('#/', '')
  return hash === 'spotlight' || hash === 'overlay' || hash === 'voice' || hash === 'notifications'
}

/**
 * Инициализация live-буфера для side-чата. Вызывается из SideChatPanel
 * перед отправкой сообщения. Аналог initChatSend, но пишет в sideChatByChat.
 */
export function initSideChatSend(parentChatId: string) {
  const sideChatId = SIDE_PREFIX + parentChatId
  if (buffers.has(sideChatId)) return
  const buf = getBuf(sideChatId)
  buf.streamMsgId = 'streaming-pending'
  buf.text = ''
  buf.thinking = ''
  buf.thinkingMs = undefined
  buf.isThinkingLive = false
  buf.iters = []
  buf.steps = []
  buf.todo = []
  buf.agentStatus = null
  buf.rateLimitSec = 0
  buf.tokenBuf = ''
  buf.thinkingBuf = ''
  buf.retry = null
  buf.lastError = null
  useChatStore.getState().hydrateSideLiveState(parentChatId, {
    msgId: 'streaming-pending',
    text: '',
    thinking: '',
    isThinkingLive: false,
    iters: [],
    steps: [],
    todo: [],
    agentStatus: null,
    rateLimitSec: 0,
    retry: null,
    lastError: null,
    isTyping: true,
    isAgentRunning: false,
  })
}

// ── Side-chat-aware wrappers ──────────────────────────────────────────
// Детектят 'sidechat:' префикс и маршрутизируют в sideChatByChat
// вместо обычных messages/liveByChat.
export const liveSet = (chatId: string, partial: Partial<ChatLiveState>) => {
  if (isSideChat(chatId)) {
    useChatStore.getState().setSideLiveState(sideParent(chatId), partial)
  } else {
    useChatStore.getState().setLiveState(chatId, partial)
  }
}
export const liveClear = (chatId: string) => {
  if (isSideChat(chatId)) {
    useChatStore.getState().clearSideLiveState(sideParent(chatId))
  } else {
    useChatStore.getState().clearLiveState(chatId)
  }
}

// ── Time-based throttle (50мс / ~20fps) ────────────────────────────
// Раньше использовался requestAnimationFrame (~16мс / 60fps): каждый
// кадр ре-парсил ВЕСЬ накопленный markdown (ReactMarkdown + SyntaxHighlighter),
// стоимость росла O(n) на кадр → main thread блокировался на длинных
// ответах → падение FPS всего приложения. 50мс визуально неотличимо от
// 60fps (токены и так приходят кусками), но ре-парс в 3 раза реже.
// Финальный flush при done/tool_call — синхронный, ничего не теряется.
export const FLUSH_MS = 50

export const flushTokens = (chatId: string) => {
  const buf = getBuf(chatId)
  buf.flushTimer = null
  const partial: Partial<ChatLiveState> = {}
  if (buf.tokenBuf) {
    buf.text += buf.tokenBuf
    buf.tokenBuf = ''
    partial.text = buf.text
  }
  if (buf.thinkingBuf) {
    buf.thinking += buf.thinkingBuf
    buf.thinkingBuf = ''
    partial.thinking = buf.thinking
  }
  if (Object.keys(partial).length > 0) {
    liveSet(chatId, partial)
  }
}

export const scheduleFlush = (chatId: string) => {
  const buf = getBuf(chatId)
  if (buf.flushTimer !== null) return
  buf.flushTimer = setTimeout(() => flushTokens(chatId), FLUSH_MS)
}

// Синхронный drain буферов в buf.text/buf.thinking БЕЗ store-обновления.
// Возвращает partial для последующего батч-коммита. Используется в
// tool_call/tool_call_pending перед захватом text/thinking в итерацию,
// чтобы ничего не потерялось (точное поведение как раньше).
export const drainBufs = (chatId: string): Partial<ChatLiveState> => {
  const buf = getBuf(chatId)
  const partial: Partial<ChatLiveState> = {}
  if (buf.tokenBuf) {
    buf.text += buf.tokenBuf
    buf.tokenBuf = ''
    partial.text = buf.text
  }
  if (buf.thinkingBuf) {
    buf.thinking += buf.thinkingBuf
    buf.thinkingBuf = ''
    partial.thinking = buf.thinking
  }
  return partial
}

// Промоут msgId из 'streaming-pending' → реальный id — один раз.
// Раньше setLiveState({ msgId, isTyping: true }) звался на КАЖДЫЙ токен,
// хотя значения не меняются после первого. Теперь только при промоуте.
export const promoteMsgId = (chatId: string, msgId: string) => {
  const buf = getBuf(chatId)
  if (buf.streamMsgId === 'streaming-pending') {
    buf.streamMsgId = msgId
    liveSet(chatId, { msgId, isTyping: true })
  }
}
