import { useEffect } from 'react'
import { IPC_EVENTS } from '../../../shared/constants'
import type { Message } from '../../../shared/types'
import { useChatStore } from '../store/chat.store'
import { buffers, getBuf, liveSet, liveClear, isSideChat, sideParent, isAuxWindow, promoteMsgId, scheduleFlush, clearBufTimers } from './chatRunRuntime'

/**
 * Обработка стриминга токенов ответа: CHAT_STREAM_TOKEN (текст + reasoning),
 * CHAT_STREAM_DONE (финальное сохранение в БД), CHAT_STREAM_ERROR (ошибка/стоп).
 */
export function useStreamHandler() {
  useEffect(() => {
    if (isAuxWindow()) return

    // CHAT_STREAM_TOKEN — токены ответа и reasoning
    const offToken = window.syntee.on(IPC_EVENTS.CHAT_STREAM_TOKEN, (data: {
      chatId: string; msgId: string; token?: string
      thinkingToken?: string; thinkingDone?: boolean; thinkingMs?: number
    }) => {
      if (!data || !data.chatId) return
      const buf = getBuf(data.chatId)
      buf.streamMsgId = data.msgId

      if (data.thinkingToken) {
        const tok = typeof data.thinkingToken === 'string' ? data.thinkingToken : String(data.thinkingToken ?? '')
        buf.thinkingBuf += tok
        const wasLive = buf.isThinkingLive
        buf.isThinkingLive = true
        // Промоут msgId один раз (thinking приходит раньше text).
        if (buf.streamMsgId === 'streaming-pending') {
          promoteMsgId(data.chatId, data.msgId)
        }
        // Пушим isThinkingLive=true в store на каждом переходе false → true,
        // а не только при первом промоуте msgId. Иначе в agent-режиме (тулы,
        // итерации) после первого thinkingDone флаг остаётся false в store,
        // и блок размышлений не раскрывается для последующих раундов.
        if (!wasLive) {
          liveSet(data.chatId, { isThinkingLive: true })
        }
        scheduleFlush(data.chatId)
        return
      }
      if (data.thinkingDone) {
        buf.thinkingMs = data.thinkingMs
        buf.isThinkingLive = false
        liveSet(data.chatId, {
          thinkingMs: data.thinkingMs,
          isThinkingLive: false,
        })
        return
      }
      if (data.token) {
        // Промоут msgId один раз (только при первом text-токене).
        if (buf.streamMsgId === 'streaming-pending') {
          promoteMsgId(data.chatId, data.msgId)
        }
        // Пришли новые токены — ретрай/ошибка больше не актуальны,
        // сбрасываем чтобы индикатор не показывал «повтор 3/5» после
        // успешного восстановления.
        if (buf.retry || buf.lastError) {
          buf.retry = null
          buf.lastError = null
          liveSet(data.chatId, { retry: null, lastError: null })
        }
        buf.tokenBuf += data.token
        scheduleFlush(data.chatId)
      }
    })

    // CHAT_STREAM_DONE — финал стрима, сохранение в БД
    const offDone = window.syntee.on(IPC_EVENTS.CHAT_STREAM_DONE, (data: { chatId: string; message: Message }) => {
      console.log('[chat-flow] CHAT_STREAM_DONE chatId=%s msgId=%s content=%d chars steps=%d',
        data.chatId, data.message.id, (data.message.content || '').length, data.message.toolSteps?.length ?? 0)
      const buf = buffers.get(data.chatId)
      // Синхронный финальный flush — ничего не теряется.
      if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) {
        clearTimeout(buf.flushTimer)
      }
      if (buf) {
        buf.tokenBuf = ''
        buf.thinkingBuf = ''
        buf.flushTimer = null
      }
      if (buf?.rateLimitCountdown) {
        clearInterval(buf.rateLimitCountdown)
      }
      buffers.delete(data.chatId)

      if (isSideChat(data.chatId)) {
        const parentId = sideParent(data.chatId)
        liveClear(data.chatId)
        useChatStore.getState().addSideMessage(parentId, data.message)
        useChatStore.getState().setSideRunStatus(parentId, 'done')
      } else {
        // finalizeStreamMessage объединяет clearLiveState + addMessage в один
        // set() — устраняет race (live-пузырь исчезает, а сообщение ещё не
        // добавлено → кратковременная пустота в конце чата).
        useChatStore.getState().finalizeStreamMessage(data.chatId, data.message)
        window.syntee.chat.getAll().then((all) => useChatStore.getState().setChats(all))
        // ── ChangesBadge: загружаем изменения последнего turn'а ──
        // Fire-and-forget: если в этом turn'е были правки файлов — бейдж
        // появится над инпутом. При ошибке IPC — просто не появится.
        window.syntee.chat.getLastTurnChanges?.(data.chatId).then((changes) => {
          if (changes) useChatStore.getState().setLastTurnChanges(data.chatId, changes)
        }).catch(() => {})
      }
    })

    // CHAT_STREAM_ERROR — ошибка/остановка. Раньше для основного чата
    // тут был только liveClear без setRunStatus — сайдбар не показывал ✗,
    // и ошибка пропадала невидимой (пользователь видел "ожидание ответа"
    // пока live-пузырь не схлопнется). Теперь ставим runStatus='error' с
    // текстом ошибки → бейдж ✗ в сайдбаре + сохраняется для показа.
    const offError = window.syntee.on(IPC_EVENTS.CHAT_STREAM_ERROR, (data: { chatId: string; error: string }) => {
      console.log('[chat-flow] CHAT_STREAM_ERROR chatId=%s error=%s', data.chatId, data.error.slice(0, 200))
      const buf = buffers.get(data.chatId)
      if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) {
        clearTimeout(buf.flushTimer)
      }
      if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      liveClear(data.chatId)
      buffers.delete(data.chatId)
      if (isSideChat(data.chatId)) {
        useChatStore.getState().setSideRunStatus(sideParent(data.chatId), 'error')
      } else {
        // Ставим error-статус с текстом — сайдбар покажет ✗ и при наведении
        // текст. Раньше основной чат вообще не получал error-статус здесь.
        useChatStore.getState().setRunStatus(data.chatId, 'error', data.error)
      }
    })

    return () => {
      offToken(); offDone(); offError()
    }
  }, [])
}
