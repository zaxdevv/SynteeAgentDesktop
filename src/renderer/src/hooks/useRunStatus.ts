import { useEffect } from 'react'
import { IPC_EVENTS } from '../../../shared/constants'
import type { Chat, Message, QueueItemMeta } from '../../../shared/types'
import { useChatStore, type RunStatus } from '../store/chat.store'
import { buffers, getBuf, liveSet, liveClear, isSideChat, sideParent, isAuxWindow, initChatSend, pendingUserMsgs } from './chatRunRuntime'

/**
 * Статусы запуска и события очереди/сессии:
 * CHAT_RUN_STATUS (queued/running/done/error/cancelled для сайдбара и очереди),
 * CHAT_QUEUE_UPDATED (снапшот очереди), CHAT_FILES_RESTORED (undo правок),
 * CHAT_REWOUND (откат сессии), RATE_LIMIT (ожидание перед retry).
 */
export function useRunStatus() {
  useEffect(() => {
    if (isAuxWindow()) return

    // Programmatic delegation creates ordinary chats without a renderer send.
    let disposed = false
    const offDelegatedChanged = window.syntee.on('chat:delegated-changed', () => {
      void window.syntee.chat.getAll().then((chats: Chat[]) => {
        if (!disposed) useChatStore.getState().setChats(chats)
      }).catch(() => {})
    })
    const offDelegatedMessage = window.syntee.on('chat:delegated-message', (payload: unknown) => {
      const data = payload as { message: Message }
      const st = useChatStore.getState()
      const cached = st.messagesByChat[data.message.chatId]?.messages
      if (!cached?.some(m => m.id === data.message.id)) st.addMessage(data.message)
      initChatSend(data.message.chatId)
    })

    // CHAT_RUN_STATUS — статус запуска для сайдбара
    const offRunStatus = window.syntee.on(IPC_EVENTS.CHAT_RUN_STATUS, (data: {
      chatId: string; status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'compacting'
      msgId?: string; error?: string; ts: number
    }) => {
      // Side chat: обновляем только runStatus, без логики очереди/pending.
      if (isSideChat(data.chatId)) {
        const parentId = sideParent(data.chatId)
        useChatStore.getState().setSideRunStatus(parentId, data.status as RunStatus)
        if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
          const buf = buffers.get(data.chatId)
          if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) clearTimeout(buf.flushTimer)
          if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
          // Defensive cleanup (см. аналог в основной ветке ниже).
          liveClear(data.chatId)
          buffers.delete(data.chatId)
        }
        return
      }
      useChatStore.getState().setRunStatus(data.chatId, data.status, data.error, data.msgId)
      // Управляем activeRunByChat для UI-панели очереди.
      // На 'running' — асинхронно подтягиваем meta из main (там она уже установлена).
      // На терминальных — сбрасываем activeRun.
      if (data.status === 'running') {
        // ── ChangesBadge: сбрасываем бейдж при старте нового запроса ──
        useChatStore.getState().setLastTurnChanges(data.chatId, null)
        // Если это старт queued-запроса — достаём отложенное user-сообщение
        // и добавляем его в чат + инициализируем live-буфер. Это сохраняет
        // порядок диалога: предыдущий ответ уже добавлен (CHAT_STREAM_DONE),
        // затем это user-сообщение, затем live-пузырь нового ответа.
        const pending = data.msgId ? pendingUserMsgs.get(data.msgId) : undefined
        if (pending) {
          pendingUserMsgs.delete(data.msgId!)
          useChatStore.getState().addMessage(pending)
          initChatSend(data.chatId)
        }
        window.syntee.chat.getLiveState(data.chatId).then((live: { meta?: QueueItemMeta | null } | null) => {
          if (live?.meta) useChatStore.getState().setActiveRun(data.chatId, live.meta)
        }).catch(() => {})
      } else if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
        useChatStore.getState().setActiveRun(data.chatId, null)
        const buf = buffers.get(data.chatId)
        if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) clearTimeout(buf.flushTimer)
        if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
        // Defensive cleanup: CHAT_STREAM_DONE/CHAT_STREAM_ERROR обычно уже
        // почистили live+buffers, но если событие потеряно/запаздывает/
        // пришло не в том порядке (например при user-initiated stop, когда
        // бэк шлёт 'done' из sendDone, а затем 'cancelled' из stopRun),
        // терминальный статус сам сбрасывает isTyping/isThinkingLive/msgId.
        // Идемпотентно — delete на отсутствующем ключе это noop.
        liveClear(data.chatId)
        buffers.delete(data.chatId)
      }
    })

    // CHAT_QUEUE_UPDATED — снапшот очереди ожидающих запросов chatId.
    // Эмитится main-процессом при add/remove/reorder/drain. Обновляем store
    // для UI-панели очереди.
    const offQueue = window.syntee.on(IPC_EVENTS.CHAT_QUEUE_UPDATED, (data: {
      chatId: string; queue: QueueItemMeta[]; ts: number
    }) => {
      useChatStore.getState().setQueue(data.chatId, data.queue)
    })

    // CHAT_FILES_RESTORED — undo правок файлов (из ChangesBadge).
    // Сбрасываем lastTurnChanges — бейдж исчезает после undo.
    const offFilesRestored = window.syntee.on(IPC_EVENTS.CHAT_FILES_RESTORED, (data: { chatId: string }) => {
      useChatStore.getState().setLastTurnChanges(data.chatId, null)
    })

    // CHAT_REWOUND — откат сессии (из правой панели или кнопки на сообщении).
    // Перезагружаем messages из БД — main уже всё удалил/вставил.
    // Также сбрасываем live state — иначе isTyping/isAgentRunning могут
    // остаться true и input bar будет disabled после отката.
    const offRewound = window.syntee.on(IPC_EVENTS.CHAT_REWOUND, async (data: { chatId: string; userMessageId: string }) => {
      liveClear(data.chatId)
      const buf = buffers.get(data.chatId)
      if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) {
        clearTimeout(buf.flushTimer)
      }
      if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      buffers.delete(data.chatId)
      const msgs = await window.syntee.chat.getMessages(data.chatId) as Message[]
      useChatStore.getState().setMessages(msgs)
    })

    // RATE_LIMIT — ожидание перед retry
    const offRateLimit = window.syntee.on(IPC_EVENTS.RATE_LIMIT, (data: { waitSec: number; chatId?: string }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      buf.rateLimitSec = data.waitSec
      liveSet(data.chatId, { rateLimitSec: data.waitSec })
      let remaining = data.waitSec
      if (buf.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      buf.rateLimitCountdown = setInterval(() => {
        remaining -= 1
        if (remaining <= 0) {
          clearInterval(buf.rateLimitCountdown!)
          buf.rateLimitSec = 0
          liveSet(data.chatId, { rateLimitSec: 0 })
        } else {
          buf.rateLimitSec = remaining
          liveSet(data.chatId, { rateLimitSec: remaining })
        }
      }, 1000)
    })

    return () => {
      disposed = true
      offDelegatedChanged(); offDelegatedMessage()
      offRunStatus(); offQueue(); offFilesRestored(); offRewound(); offRateLimit()
    }
  }, [])
}
