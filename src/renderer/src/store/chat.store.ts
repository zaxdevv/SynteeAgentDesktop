import { create } from 'zustand'
import type { Chat, Message, ChatMode, Project, ToolStep, QueueItemMeta, LastTurnChanges } from '../../../shared/types'

// ── Per-chat live state ────────────────────────────────────────────────
// Раньше всё live-состояние (стриминг-текст, шаги тулов, thinking, todo)
// лежало в useState одного компонента ChatPage и не было разделено по chatId.
// При переключении чатов оно утекало в чужой чат или терялось. Теперь это
//.per-chat словарь в Zustand: каждый активный чат имеет свой LiveState,
// привязанный к chatId. ChatPage читает только liveByChat[currentChatId].
export interface LiveIter {
  textBefore: string
  thinking?: string
  thinkingMs?: number
  steps: ToolStep[]
}

export interface ChatLiveState {
  msgId: string | null
  text: string
  thinking: string
  thinkingMs?: number
  isThinkingLive: boolean
  iters: LiveIter[]
  steps: ToolStep[]
  todo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  agentStatus: string | null
  rateLimitSec: number
  isTyping: boolean
  isAgentRunning: boolean
  /** Live progress для долгих тулов (get_fast_context / run_command): {toolName → {stage, detail, sessionId, files...}} */
  toolProgress: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
  /** Live-маппинг саб-агентов, запущенных в текущем стриме. Ключ — agentId.
   *  Заполняется событием agent:spawn (эмитится из main ДО запуска worker'а
   *  суб-агента). Renderer матчит запись с live-шагом tool_call spawn_agent
   *  по callId (или по task как fallback) и сразу рисует карточку саб-агента. */
  spawnedAgents: Array<{ agentId: string; callId?: string; task: string; msgId: string; model?: string; role?: string; ts: number }>
  /** Структурированный ретрай для UI-счётчика «повтор 3/5». Не затирается
   *  следующим onStatus (в отличие от agentStatus). Сбрасывается в null
   *  при успехе/новом раунде. */
  retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  /** Последняя ошибка тула/API для индикатора ожидания. Не затирается
   *  generic «Думаю…» — показывается пока не придёт новый токен/успех. */
  lastError?: string | null
}

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface RunStatusInfo {
  status: RunStatus
  error?: string
  msgId?: string
  ts: number
}

// Терминальные статусы, после которых показываем бейдж ✓/✗ в сайдбаре.
// 'queued' и 'running' — spinner, не бейдж.
export const TERMINAL_RUN_STATUSES: ReadonlyArray<RunStatus> = ['done', 'error', 'cancelled']

export const EMPTY_LIVE: ChatLiveState = {
  msgId: null,
  text: '',
  thinking: '',
  isThinkingLive: false,
  iters: [],
  steps: [],
  todo: [],
  agentStatus: null,
  rateLimitSec: 0,
  isTyping: false,
  isAgentRunning: false,
  toolProgress: {},
  spawnedAgents: [],
}

// ── Side chat (параллельный доп-чат в правой панели) ───────────────────
// Эфемерный чат-в-чате: хранится только в памяти (Zustand), не пишется в БД.
// Ключ — parentId (id основного чата). Один side-чат на основной чат.
// ИИ side-чата получает сводку основного чата в системном промпте + тул
// get_main_chat_messages для запроса конкретных сообщений по мере нужды.
export interface SideChatState {
  messages: Message[]
  live: ChatLiveState
  runStatus: RunStatus | null
}

export const EMPTY_SIDE_CHAT: SideChatState = {
  messages: [],
  live: { ...EMPTY_LIVE },
  runStatus: null,
}

interface ChatStore {
  chats: Chat[]
  projects: Project[]
  activeProjectId: string | null
  currentChatId: string | null
  messages: Message[]
  // Пагинация сообщений (reverse-infinite scroll). `messages` — загруженное
  // окно (старейшее-загруженное → новейшее), а НЕ обязательно вся история.
  // hasOlderMessages = в БД есть ещё более старые сообщения (не загружены).
  // isLoadingOlder = идёт догрузка старой страницы (индикатор сверху).
  hasOlderMessages: boolean
  isLoadingOlder: boolean
  isTyping: boolean
  streamingText: string
  pinnedMessages: Message[]
  isIncognito: boolean
  activeMode: ChatMode  // оставлен как 'code' — Work-режим удалён, но поле нужно для обратной совместимости с IPC

  // ── Сплит-режим (второй чат рядом с основным, 50/50) ────────────────────
  // splitChatId — id чата в правой половине экрана (null = сплит закрыт).
  // Сплит-чат ≠ вкладка: закрытие сплита не закрывает вкладку в шапке.
  // Персистится в electron-store ('splitChatTab'), восстанавливается в App.tsx
  // при boot (валидация: чат жив, ≠ активному, не архив).
  // Автозакрытие: чат удалён (dropChatState) или заархивирован/стал активным
  // (подписка в tabs.store.ts) → splitChatId сбрасывается в null.
  splitChatId: string | null

  // Per-chat live state — ключом является chatId. Параллельные чаты
  // каждый имеют свой LiveState, не перетирая друг друга.
  liveByChat: Record<string, ChatLiveState>
  // Статус запуска chat:send для каждого chatId — для сайдбар-индикатора.
  runStatusByChat: Record<string, RunStatusInfo>
  // Непрочитанные терминальные статусы — для бейджа ✓/✗ в сайдбаре.
  // Сбрасывается в markChatRead когда пользователь открыл чат.
  unreadStatusByChat: Record<string, RunStatus>

  // ── Очередь запросов чата ──
  // Ожидающие запросы (queued) по chatId — для UI-панели очереди.
  queueByChat: Record<string, QueueItemMeta[]>
  // Активный запуск (running) по chatId. null если ничего не выполняется.
  // Отличается от runStatusByChat тем, что хранит preview/startedAt для
  // отображения в панели; сбрасывается в null на терминальном статусе.
  activeRunByChat: Record<string, QueueItemMeta | null>

  // ── ChangesBadge: изменения последнего turn'а (per-chat) ──
  // Заполняется после CHAT_STREAM_DONE (если были правки файлов),
  // сбрасывается при новом send (CHAT_RUN_STATUS='running') или undo.
  lastTurnChangesByChat: Record<string, LastTurnChanges | null>

  // Actions
  setChats: (chats: Chat[]) => void
  setProjects: (projects: Project[]) => void
  setActiveProject: (id: string | null) => void
  setCurrentChat: (id: string | null) => void
  setMessages: (messages: Message[]) => void
  // Установить окно сообщений (пагинированный загруз). Обновляет messages +
  // hasOlderMessages + LRU-кеш messagesByChat[chatId]. messages (текущий чат)
  // обновляется только если chatId === currentChatId.
  setMessagesWindow: (chatId: string, messages: Message[], hasOlder: boolean) => void
  // Догрузить старую страницу вперёд (reverse-infinite scroll). Присоединяет
  // olderMessages в начало messages и обновляет hasOlderMessages + кеш.
  prependOlderMessages: (chatId: string, olderMessages: Message[], hasOlder: boolean) => void
  setIsLoadingOlder: (v: boolean) => void
  setHasOlderMessages: (v: boolean) => void
  addMessage: (message: Message) => void
  // Атомарный (один set()) коммит: очистка live-состояния + добавление финального
  // сообщения. Устраняет race между liveClear и addMessage — два раздельных set()
  // могли дать кратковременную пустоту в конце чата (live-пузырь исчез, сообщение
  // ещё не добавлено). Также не пишет в s.messages для чужого chatId.
  finalizeStreamMessage: (chatId: string, message: Message) => void
  appendStreamToken: (token: string) => void
  clearStream: () => void
  setTyping: (typing: boolean) => void
  pinMessage: (id: string) => void
  unpinMessage: (id: string) => void
  toggleIncognito: () => void
  setActiveMode: (mode: ChatMode) => void
  setSplitChat: (id: string | null) => void

  // Live-state actions
  setLiveState: (chatId: string, partial: Partial<ChatLiveState>) => void
  hydrateLiveState: (chatId: string, full: Partial<ChatLiveState> & { msgId: string | null }) => void
  clearLiveState: (chatId: string) => void
  setRunStatus: (chatId: string, status: RunStatus, error?: string, msgId?: string) => void
  markChatRead: (chatId: string) => void
  dropChatState: (chatId: string) => void

  // ── Очередь запросов ──
  setQueue: (chatId: string, queue: QueueItemMeta[]) => void
  setActiveRun: (chatId: string, meta: QueueItemMeta | null) => void
  setLastTurnChanges: (chatId: string, changes: LastTurnChanges | null) => void

  // ── Prune stale per-chat state ──────────────────────────────────────
  // Удаляет liveByChat/activeRunByChat записи для неактивных, не-running
  // чатов. Вызывается из setRunStatus при терминальном статусе — момент,
  // когда чат гарантированно закончил работу. Оставляет currentChatId и
  // чаты со статусом running/queued.
  pruneStaleChatState: () => void

  // ── Side chat (параллельный доп-чат) ──
  sideChatByChat: Record<string, SideChatState>
  addSideMessage: (parentId: string, message: Message) => void
  setSideLiveState: (parentId: string, partial: Partial<ChatLiveState>) => void
  hydrateSideLiveState: (parentId: string, full: Partial<ChatLiveState> & { msgId: string | null }) => void
  clearSideLiveState: (parentId: string) => void
  setSideRunStatus: (parentId: string, status: RunStatus | null) => void
  resetSideChat: (parentId: string) => void

  // ── LRU-кеш загруженных окон сообщений ──────────────────────────────────
  // Переживает переключение чатов: при возврате в недавно открытый чат
  // сообщения показываются мгновенно из кеша, без IPC + JSON-парсинга. Кеш
  // хранит окно { messages, hasOlder } по chatId. cacheOrder — порядок доступа
  // (новейшие первыми); при превышении CACHE_CAP старейшие вытесняются.
  // Ограничение: лучше держать пару чатов под рукой (типичный back-and-forth).
  messagesByChat: Record<string, { messages: Message[]; hasOlder: boolean }>
  cacheOrder: string[]

  // ── Boot gate ──
  // bootRendered — ChatPage подтвердил что отрисовал реальный контент
  // (сообщения или empty-state) после первого монтирования. App.tsx
  // удерживает BootScreen пока это false, иначе UI мелькал пустым
  // шеллом (чаты/сообщения появляются с задержкой после исчезновения сплэша).
  bootRendered: boolean
  setBootRendered: (v: boolean) => void
}

// LRU-кеш окон сообщений: максимум хранимых чатов. Сообщения идут в
// renderer только в slim-виде (slimMessages.ts урезает tool-пейлоады),
// окно — 50 сообщений → типичный чат в кеше занимает единицы МБ. Капа 12
// покрывает частое переключение между 10+ чатами без скелетона загрузки
// (раньше капа 4 — пятый чат в цикле всегда грузился с IPC-раундом).
const MSG_CACHE_CAP = 12

// Порог «большого чата»: чаты с messageCount > порога НЕ догружаются тихим
// фоном целиком (рисково по памяти/перформансу на 10k+). Для них остаётся
// старый reverse-infinite scroll по требованию (со спиннером сверху). Чаты
// меньше порога грузятся полностью в фоне — минимапа стабильна, спиннер
// не показывается никогда. См. хук useBackgroundLoadFullChat.
export const LARGE_CHAT_THRESHOLD = 200

/** Селектор: является ли чат «большим» (по messageCount из списка chats).
 *  messageCount приходит из БД (COUNT(*)) при загрузке списка чатов. */
export function selectIsLargeChat(chats: Chat[], chatId: string | null | undefined): boolean {
  if (!chatId) return false
  const chat = chats.find(c => c.id === chatId)
  return (chat?.messageCount ?? 0) > LARGE_CHAT_THRESHOLD
}

export const useChatStore = create<ChatStore>((set, get) => ({
  chats: [],
  projects: [],
  activeProjectId: null,
  currentChatId: null,
  messages: [],
  hasOlderMessages: false,
  isLoadingOlder: false,
  isTyping: false,
  streamingText: '',
  pinnedMessages: [],
  isIncognito: false,
  activeMode: 'code',
  splitChatId: null,

  liveByChat: {},
  runStatusByChat: {},
  unreadStatusByChat: {},

  queueByChat: {},
  activeRunByChat: {},

  lastTurnChangesByChat: {},

  sideChatByChat: {},

  messagesByChat: {},
  cacheOrder: [],

  bootRendered: false,
  setBootRendered: (bootRendered) => set({ bootRendered }),

  setChats: (chats) => set({ chats }),
  setProjects: (projects) => set({ projects }),
  setActiveProject: (activeProjectId) => set({ activeProjectId }),
  setCurrentChat: (currentChatId) => set({ currentChatId }),
  // setMessages — «полная» установка messages (вызывается rewind/compact/fork/
  // snapshot IPC, которые возвращают всю историю, а также createNewChat с []).
  // Для таких вызовов окно = вся история → hasOlderMessages=false. Кеш
  // текущего чата обновляем полной версией.
  setMessages: (messages) =>
    set((s) => {
      const cid = s.currentChatId
      if (!cid) return { messages, hasOlderMessages: false, isLoadingOlder: false }
      const byChat = { ...s.messagesByChat, [cid]: { messages, hasOlder: false } }
      let order = [cid, ...s.cacheOrder.filter(c => c !== cid)]
      if (order.length > MSG_CACHE_CAP) {
        for (const c of order.slice(MSG_CACHE_CAP)) delete byChat[c]
        order = order.slice(0, MSG_CACHE_CAP)
      }
      return { messages, hasOlderMessages: false, isLoadingOlder: false, messagesByChat: byChat, cacheOrder: order }
    }),
  // setMessagesWindow — пагинированная установка (selectChat, boot, compacted).
  // messages (текущий чат) обновляется только если chatId === currentChatId,
  // иначе правится только кеш (безопасно при фоновой сверке чужого чата).
  setMessagesWindow: (chatId, messages, hasOlder) =>
    set((s) => {
      const byChat = { ...s.messagesByChat, [chatId]: { messages, hasOlder } }
      let order = [chatId, ...s.cacheOrder.filter(c => c !== chatId)]
      if (order.length > MSG_CACHE_CAP) {
        for (const c of order.slice(MSG_CACHE_CAP)) delete byChat[c]
        order = order.slice(0, MSG_CACHE_CAP)
      }
      const base = { messagesByChat: byChat, cacheOrder: order, isLoadingOlder: false }
      if (s.currentChatId === chatId) return { ...base, messages, hasOlderMessages: hasOlder }
      return base
    }),
  prependOlderMessages: (chatId, olderMessages, hasOlder) =>
    set((s) => {
      if (!olderMessages.length) return { hasOlderMessages: hasOlder, isLoadingOlder: false }
      // ── Баг-фикс: используем кеш целевого чата, а не s.messages ──
      // s.messages — ВСЕГДА окно ТЕКУЩЕГО чата (currentChatId). Если сплит-чат
      // (chatId !== currentChatId) скроллит вверх → prependOlderMessages(B, olderB)
      // merge = olderB + s.messages (сообщения чата A) → кеш сплита затирается
      // сообщениями основного чата → дублирование. Теперь: берём кеш целевого чата.
      const existing = s.currentChatId === chatId
        ? s.messages
        : (s.messagesByChat[chatId]?.messages ?? [])
      const merged = [...olderMessages, ...existing]
      const byChat = { ...s.messagesByChat, [chatId]: { messages: merged, hasOlder } }
      let order = [chatId, ...s.cacheOrder.filter(c => c !== chatId)]
      if (order.length > MSG_CACHE_CAP) {
        for (const c of order.slice(MSG_CACHE_CAP)) delete byChat[c]
        order = order.slice(0, MSG_CACHE_CAP)
      }
      const base = { messagesByChat: byChat, cacheOrder: order, isLoadingOlder: false }
      if (s.currentChatId === chatId) return { ...base, messages: merged, hasOlderMessages: hasOlder }
      return base
    }),
  setIsLoadingOlder: (isLoadingOlder) => set({ isLoadingOlder }),
  setHasOlderMessages: (hasOlderMessages) => set({ hasOlderMessages }),
  addMessage: (message) =>
    set((s) => {
      if (s.messages.some(m => m.id === message.id)) return s
      // Держим кеш тёплым для chatId этого сообщения (чтобы при возврате в чат
      // финальное сообщение уже было в окне).
      const cached = s.messagesByChat[message.chatId]
      let byChat = s.messagesByChat
      if (cached) {
        byChat = {
          ...s.messagesByChat,
          [message.chatId]: { messages: [...cached.messages, message], hasOlder: cached.hasOlder },
        }
      }
      // s.messages обновляем ТОЛЬКО если сообщение принадлежит текущему чату.
      // Иначе чужое сообщение (стрим завершился в фоне) попадёт в массив
      // текущего чата → коррупция UI: сообщение A видно в чате B, а кеш B
      // при этом не обновлён → при следующем selectChat(B) оно затрётся.
      //
      // RACE GUARD: при быстром переключении чатов (send в A → switch на B
      // → switch обратно на A) selectChat делает setCurrentChat(B) синхронно,
      // но s.messages ещё содержит сообщения A пока hydrateFromMain(B) не
      // завершится и setMessagesWindow(B) не отработает. В этом окне
      // addMessage с chatId=A и currentChatId=A пройдёт проверку выше, но
      // запишет сообщение A поверх сообщений B (если setMessagesWindow(B)
      // успел выполниться). Проверяем последний элемент: если он чужого
      // chatId — s.messages contaminated, пишем только в кеш.
      if (message.chatId === s.currentChatId) {
        const lastMsg = s.messages[s.messages.length - 1]
        if (lastMsg && lastMsg.chatId !== message.chatId) {
          return { messagesByChat: byChat }
        }
        return { messages: [...s.messages, message], messagesByChat: byChat }
      }
      return { messagesByChat: byChat }
    }),
  // finalizeStreamMessage — объединяет clearLiveState + addMessage в один set().
  // Вызывается из обработчика CHAT_STREAM_DONE. Устраняет race: два раздельных
  // set() (liveClear → addMessage) давали кратковременную пустоту — live-пузырь
  // уже схлопнулся, финальное сообщение ещё не в массиве. Также не пишет в
  // s.messages для чужого chatId (см. addMessage выше).
  finalizeStreamMessage: (chatId, message) =>
    set((s) => {
      // 1. Очистка live-состояния (live-пузырь схлопывается)
      const nextLive = { ...s.liveByChat }
      delete nextLive[chatId]
      // 2. Финальное сообщение. Checkpoint-таймер main мог сохранить partial
      // с тем же id в БД, и фоновая сверка могла тащить его в кэш/messages.
      // Заменяем partial по id, не пропускаем (иначе огрызок остаётся навсегда).
      const cached = s.messagesByChat[message.chatId]
      let byChat = s.messagesByChat
      if (cached) {
        const idx = cached.messages.findIndex(m => m.id === message.id)
        if (idx >= 0) {
          const newMsgs = [...cached.messages]
          newMsgs[idx] = message
          byChat = { ...s.messagesByChat, [message.chatId]: { messages: newMsgs, hasOlder: cached.hasOlder } }
        } else {
          byChat = { ...s.messagesByChat, [message.chatId]: { messages: [...cached.messages, message], hasOlder: cached.hasOlder } }
        }
      }
      // s.messages: заменяем partial если найден, иначе добавляем (с race guard)
      if (message.chatId === s.currentChatId) {
        const idx = s.messages.findIndex(m => m.id === message.id)
        if (idx >= 0) {
          const newMsgs = [...s.messages]
          newMsgs[idx] = message
          return { liveByChat: nextLive, messages: newMsgs, messagesByChat: byChat }
        }
        const lastMsg = s.messages[s.messages.length - 1]
        if (lastMsg && lastMsg.chatId !== message.chatId) {
          return { liveByChat: nextLive, messagesByChat: byChat }
        }
        return { liveByChat: nextLive, messages: [...s.messages, message], messagesByChat: byChat }
      }
      return { liveByChat: nextLive, messagesByChat: byChat }
    }),
  appendStreamToken: (token) =>
    set((s) => ({ streamingText: s.streamingText + token })),
  clearStream: () => set({ streamingText: '', isTyping: false }),
  setTyping: (isTyping) => set({ isTyping }),
  pinMessage: (id) =>
    set((s) => {
      const msg = s.messages.find((m) => m.id === id)
      if (!msg) return s
      return { pinnedMessages: [...s.pinnedMessages, msg] }
    }),
  unpinMessage: (id) =>
    set((s) => ({ pinnedMessages: s.pinnedMessages.filter((m) => m.id !== id) })),
  toggleIncognito: () => set((s) => ({ isIncognito: !s.isIncognito })),
  setActiveMode: (activeMode) => set({ activeMode }),

  setSplitChat: (splitChatId) => {
    set({ splitChatId })
    try {
      void window.syntee?.settings?.set('splitChatTab', splitChatId)
    } catch { /* ок — вне electron (браузерный dev) */ }
  },

  setLiveState: (chatId, partial) =>
    set((s) => {
      const prev = s.liveByChat[chatId] ?? EMPTY_LIVE
      return {
        liveByChat: {
          ...s.liveByChat,
          [chatId]: { ...prev, ...partial },
        },
      }
    }),

  hydrateLiveState: (chatId, full) =>
    set((s) => ({
      liveByChat: {
        ...s.liveByChat,
        [chatId]: { ...EMPTY_LIVE, ...full },
      },
    })),

  clearLiveState: (chatId) =>
    set((s) => {
      if (!s.liveByChat[chatId]) return s
      const next = { ...s.liveByChat }
      delete next[chatId]
      return { liveByChat: next }
    }),

  setRunStatus: (chatId, status, error, msgId) =>
    set((s) => {
      const nextRunStatus: RunStatusInfo = { status, error, msgId, ts: Date.now() }
      // Для терминальных статусов — помечаем как unread (бейдж в сайдбаре).
      // Для running/queued — просто обновляем runStatus (spinner).
      const isTerminal = TERMINAL_RUN_STATUSES.includes(status)
      if (!isTerminal) {
        return {
          runStatusByChat: {
            ...s.runStatusByChat,
            [chatId]: nextRunStatus,
          },
        }
      }
      // Терминальный статус — заодно чистим stale live-состояние чужих чатов.
      const cur = s.currentChatId
      const split = s.splitChatId
      const nextLive = { ...s.liveByChat }
      const nextActive = { ...s.activeRunByChat }
      for (const id of Object.keys(nextLive)) {
        if (id === cur || id === split || id === chatId) continue
        const rs = s.runStatusByChat[id]
        if (rs && (rs.status === 'running' || rs.status === 'queued')) continue
        delete nextLive[id]
      }
      for (const id of Object.keys(nextActive)) {
        if (id === cur || id === chatId) continue
        const rs = s.runStatusByChat[id]
        if (rs && (rs.status === 'running' || rs.status === 'queued')) continue
        delete nextActive[id]
      }
      return {
        runStatusByChat: {
          ...s.runStatusByChat,
          [chatId]: nextRunStatus,
        },
        unreadStatusByChat: { ...s.unreadStatusByChat, [chatId]: status },
        liveByChat: nextLive,
        activeRunByChat: nextActive,
      }
    }),

  markChatRead: (chatId) =>
    set((s) => {
      if (!s.unreadStatusByChat[chatId]) return s
      const next = { ...s.unreadStatusByChat }
      delete next[chatId]
      return { unreadStatusByChat: next }
    }),

  dropChatState: (chatId) => {
    // Удалённый чат был открыт в сплите — закрываем сплит.
    if (get().splitChatId === chatId) get().setSplitChat(null)
    set((s) => {
      const nextLive = { ...s.liveByChat }
      const nextRun = { ...s.runStatusByChat }
      const nextUnread = { ...s.unreadStatusByChat }
      const nextQueue = { ...s.queueByChat }
      const nextActive = { ...s.activeRunByChat }
      const nextSide = { ...s.sideChatByChat }
      const nextByChat = { ...s.messagesByChat }
      const nextChanges = { ...s.lastTurnChangesByChat }
      const nextOrder = s.cacheOrder.filter(c => c !== chatId)
      delete nextLive[chatId]
      delete nextRun[chatId]
      delete nextUnread[chatId]
      delete nextQueue[chatId]
      delete nextActive[chatId]
      delete nextSide[chatId]
      delete nextByChat[chatId]
      delete nextChanges[chatId]
      return {
        liveByChat: nextLive,
        runStatusByChat: nextRun,
        unreadStatusByChat: nextUnread,
        queueByChat: nextQueue,
        activeRunByChat: nextActive,
        sideChatByChat: nextSide,
        messagesByChat: nextByChat,
        lastTurnChangesByChat: nextChanges,
        cacheOrder: nextOrder,
      }
    })
  },

  setQueue: (chatId, queue) =>
    set((s) => ({
      queueByChat: { ...s.queueByChat, [chatId]: queue },
    })),

  setActiveRun: (chatId, meta) =>
    set((s) => {
      const next = { ...s.activeRunByChat }
      if (meta === null) delete next[chatId]
      else next[chatId] = meta
      return { activeRunByChat: next }
    }),

  setLastTurnChanges: (chatId, changes) =>
    set((s) => {
      const next = { ...s.lastTurnChangesByChat }
      if (changes === null) delete next[chatId]
      else next[chatId] = changes
      return { lastTurnChangesByChat: next }
    }),

  pruneStaleChatState: () =>
    set((s) => {
      const cur = s.currentChatId
      const split = s.splitChatId
      let changed = false
      // liveByChat — оставляем только current + split + running
      const nextLive = { ...s.liveByChat }
      for (const id of Object.keys(nextLive)) {
        if (id === cur || id === split) continue
        const rs = s.runStatusByChat[id]
        if (rs && (rs.status === 'running' || rs.status === 'queued')) continue
        delete nextLive[id]
        changed = true
      }
      // activeRunByChat — оставляем только running
      const nextActive = { ...s.activeRunByChat }
      for (const id of Object.keys(nextActive)) {
        if (id === cur) continue
        const rs = s.runStatusByChat[id]
        if (rs && (rs.status === 'running' || rs.status === 'queued')) continue
        delete nextActive[id]
        changed = true
      }
      if (!changed) return s
      return { liveByChat: nextLive, activeRunByChat: nextActive }
    }),

  // ── Side chat actions ──
  addSideMessage: (parentId, message) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId] ?? EMPTY_SIDE_CHAT
      if (prev.messages.some(m => m.id === message.id)) return s
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, messages: [...prev.messages, message] },
        },
      }
    }),

  setSideLiveState: (parentId, partial) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId] ?? EMPTY_SIDE_CHAT
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, live: { ...prev.live, ...partial } },
        },
      }
    }),

  hydrateSideLiveState: (parentId, full) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId] ?? EMPTY_SIDE_CHAT
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, live: { ...EMPTY_LIVE, ...full } },
        },
      }
    }),

  clearSideLiveState: (parentId) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId]
      if (!prev) return s
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, live: { ...EMPTY_LIVE } },
        },
      }
    }),

  setSideRunStatus: (parentId, status) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId] ?? EMPTY_SIDE_CHAT
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, runStatus: status },
        },
      }
    }),

  resetSideChat: (parentId) =>
    set((s) => {
      const next = { ...s.sideChatByChat }
      delete next[parentId]
      return { sideChatByChat: next }
    }),
}))
