import { useEffect } from 'react'
import { useChatStore } from '../store/chat.store'
import { getBuf, liveSet, isAuxWindow } from './chatRunRuntime'

/**
 * События агента для live-панели: agent:todo (чек-лист плана),
 * agent:status (текущий статус), agent:retry (счётчик «повтор 3/5»).
 */
export function useAgentEvents() {
  useEffect(() => {
    if (isAuxWindow()) return

    // agent:todo — чек-лист плана
    const offTodo = window.syntee.on('agent:todo', (data: {
      items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
      msgId?: string; chatId?: string
    }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      if (buf.streamMsgId === 'streaming-pending' && data.msgId) {
        buf.streamMsgId = data.msgId
        liveSet(data.chatId, { msgId: data.msgId })
      }
      if (data.msgId && buf.streamMsgId && data.msgId !== buf.streamMsgId) return
      buf.todo = data.items
      liveSet(data.chatId, { todo: data.items })
    })

    // agent:status — текущий статус агента
    const offStatus = window.syntee.on('agent:status', (data: { msgId: string; chatId: string; text: string }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      buf.agentStatus = data.text
      liveSet(data.chatId, { agentStatus: data.text })
    })

    // agent:retry — структурированный ретрай для UI-счётчика «повтор 3/5».
    // Не затирается следующим onStatus (в отличие от agent_status) —
    // хранится отдельно в live-стейте как retry. Сбрасывается в null
    // при успехе (новый токен/шаг) в обработчиках CHAT_STREAM_TOKEN/step.
    const offRetry = window.syntee.on('agent:retry', (data: {
      msgId: string; chatId: string
      attempt: number; maxAttempts?: number; reason: string; waitSec?: number
    }) => {
      if (!data.chatId) return
      console.log('[chat-flow] agent:retry chatId=%s attempt=%d/%s reason=%s waitSec=%s',
        data.chatId, data.attempt, data.maxAttempts ?? '?', data.reason, data.waitSec ?? '?')
      const buf = getBuf(data.chatId)
      buf.retry = { attempt: data.attempt, maxAttempts: data.maxAttempts, reason: data.reason, waitSec: data.waitSec }
      // При rate_limit persist lastError как причину для индикатора
      if (data.reason === 'rate_limit') {
        buf.lastError = `Лимит запросов (повтор ${data.attempt}${data.maxAttempts ? `/${data.maxAttempts}` : ''})`
      } else {
        buf.lastError = `Ошибка сети (повтор ${data.attempt}${data.maxAttempts ? `/${data.maxAttempts}` : ''})`
      }
      liveSet(data.chatId, { retry: buf.retry, lastError: buf.lastError })
    })

    return () => {
      offTodo(); offStatus(); offRetry()
    }
  }, [])
}
