import { useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import type { ToolStep } from '../../../shared/types'
import { useChatStore } from '../store/chat.store'
import { buffers, getBuf, liveSet, drainBufs, isAuxWindow } from './chatRunRuntime'

// ── Time-based throttle для agent:tool_progress → liveSet ──────────────
// Паттерн как у tokenBuf (FLUSH_MS в chatRunRuntime): события прогресса
// копятся в buf.toolProgress, store-обновление — не чаще 80мс. Индексатор
// fastContext эмитит прогресс per-batch (каждый батч файлов), run_command —
// построчно: без троттлинга каждое событие = store-обновление + полный
// ре-рендер стримящегося сообщения. Trailing-флеш доносит последнее
// состояние; guard по buffers.get — если стрим уже завершён (buffers.delete
// в CHAT_STREAM_DONE/ERROR), поздний флеш не реанимирует live-state.
const TOOL_PROGRESS_FLUSH_MS = 80
const tpFlushTimers = new Map<string, ReturnType<typeof setTimeout>>()

function flushToolProgressNow(chatId: string): void {
  const timer = tpFlushTimers.get(chatId)
  if (timer) { clearTimeout(timer); tpFlushTimers.delete(chatId) }
  const buf = getBuf(chatId)
  liveSet(chatId, { toolProgress: { ...buf.toolProgress } })
}

function scheduleToolProgressFlush(chatId: string): void {
  if (tpFlushTimers.has(chatId)) return
  tpFlushTimers.set(chatId, setTimeout(() => {
    tpFlushTimers.delete(chatId)
    const buf = buffers.get(chatId)
    if (!buf) return // стрим завершён — буфер удалён, live-state не трогаем
    liveSet(chatId, { toolProgress: { ...buf.toolProgress } })
  }, TOOL_PROGRESS_FLUSH_MS))
}

/**
 * Прогресс тулов: agent:tool_progress (live-прогресс долгих тулов),
 * agent:spawn (мгновенная карточка саб-агента) и agent:step
 * (шаги тулов — tool_call_pending/tool_call/tool_result, матчинг в итерации).
 */
export function useToolProgress() {
  useEffect(() => {
    if (isAuxWindow()) return

    // agent:tool_progress — live progress для долгих тулов (get_fast_context,
    // run_command, process_attachments). Эфемерный — не персистится в БД.
    const offToolProgress = window.syntee.on('agent:tool_progress', (data: {
      msgId: string; chatId: string; toolName: string; stage: string
      detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number
      filesFound?: Array<{ path: string; score: number; why: string }>
    }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      // Усваиваем реальный msgId из первого события (как в offToken/offStep).
      // process_attachments стримит ДО первого токена, поэтому именно тут
      // промоутим 'streaming-pending' → реальный msgId + включаем isTyping,
      // чтобы showLiveBubble стал true и блок отрисовался немедленно.
      // ВАЖНО: buf.streamMsgId может быть null (не только 'streaming-pending'),
      // если chat:send ещё не вернулся из main (runChatSend await-ит
      // processAttachmentsAndStream, и initChatSend не успел вызваться в
      // renderer). Трактуем null так же как 'streaming-pending'.
      if ((!buf.streamMsgId || buf.streamMsgId === 'streaming-pending') && data.msgId) {
        buf.streamMsgId = data.msgId
        liveSet(data.chatId, { msgId: data.msgId, isTyping: true })
      }
      if (data.msgId && buf.streamMsgId && data.msgId !== buf.streamMsgId) return
      const prevEntry = buf.toolProgress[data.toolName]
      buf.toolProgress = {
        ...buf.toolProgress,
        [data.toolName]: {
          stage: data.stage,
          detail: data.detail,
          sessionId: data.sessionId,
          filesProcessed: data.filesProcessed,
          filesTotal: data.filesTotal,
          filesFound: data.filesFound,
          ts: Date.now(),
        },
      }
      // ── Троттлинг liveSet ─────────────────────────────────────────────
      // Счётчики (filesProcessed/detail) флешим не чаще 80мс; смену stage
      // и терминальные stage ('done'/'error') — мгновенно: переход между
      // этапами и завершение должны отражаться в UI сразу. Визуально
      // неотличимо: счётчик N/M обновляется чуть реже.
      if (!prevEntry || prevEntry.stage !== data.stage || data.stage === 'done' || data.stage === 'error') {
        flushToolProgressNow(data.chatId)
      } else {
        scheduleToolProgressFlush(data.chatId)
      }
    })

    // agent:spawn — main эмитит это СРАЗУ при получении spawn_agent от
    // worker'а, до запуска суб-агента. Renderer фиксирует маппинг
    // {agentId, callId, task} в live.spawnedAgents — MessageBubble матчит
    // его с live-шагом tool_call spawn_agent (по callId, fallback — по task)
    // и мгновенно рисует карточку саб-агента, не дожидаясь tool_result.
    const offSpawn = window.syntee.on('agent:spawn', (data: {
      agentId: string; task: string; callId?: string
      msgId: string; chatId: string; model?: string; role?: string; ts: number
    }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      // Усваиваем реальный msgId из первого события (как в offStep).
      if ((!buf.streamMsgId || buf.streamMsgId === 'streaming-pending') && data.msgId) {
        buf.streamMsgId = data.msgId
        liveSet(data.chatId, { msgId: data.msgId, isTyping: true })
      }
      if (data.msgId && buf.streamMsgId && data.msgId !== buf.streamMsgId) return
      // Не дублируем запись (agent:spawn может теоретически прийти дважды).
      if (buf.spawnedAgents.some(a => a.agentId === data.agentId)) return
      buf.spawnedAgents = [...buf.spawnedAgents, {
        agentId: data.agentId,
        callId: data.callId,
        task: data.task,
        msgId: data.msgId,
        model: data.model,
        role: data.role,
        ts: data.ts,
      }]
      liveSet(data.chatId, { spawnedAgents: [...buf.spawnedAgents] })
    })

    // agent:step — шаги тулов (tool_call_pending/tool_call/tool_result).
    // Самая нетривиальная часть: матчинг pending→call по pendingCallId,
    // группировка в итерации по textBefore/thinking.
    const offStep = window.syntee.on('agent:step', (step: {
      type: string; toolName?: string; toolArgs?: Record<string, unknown>
      content: string; success?: boolean; imageUrl?: string; imagePaths?: string[]
      msgId?: string; callId?: string; pendingCallId?: string; chatId?: string
      diff?: string
      // Native analyze_image lifecycle: 'tool_result' несёт pending, отдельный
      // 'tool_result_update' (тот же callId) — responded/failed + findings.
      visualAnalysis?: { status: 'pending' | 'responded' | 'failed'; findings?: string }
    }) => {
      if (!step.chatId) return
      const chatId = step.chatId
      const buf = getBuf(chatId)
      if (!buf.streamMsgId) return

      // Усваиваем реальный msgId из первого события (как в offToken)
      if (buf.streamMsgId === 'streaming-pending' && step.msgId) {
        buf.streamMsgId = step.msgId
        liveSet(chatId, { msgId: step.msgId })
      }
      if (step.msgId && step.msgId !== buf.streamMsgId) return

      // ── Батчинг setLiveState ──────────────────────────────────────────
      // Раньше каждая ветка звала 2-4 последовательных setLiveState (commitIters,
      // commitSteps, reset, drain-text) — каждый триггерил отдельный ре-рендер.
      // Теперь ОДИН setLiveState на шаг с финальным состоянием. Логика
      // группировки/матчинга не изменилась — только количество store-обновлений.
      if (step.type === 'tool_call_pending') {
        // Синхронный drain pending-токенов в buf.text/buf.thinking перед
        // захватом в итерацию (чтобы ничего не потерялось).
        if (buf.flushTimer !== null) { clearTimeout(buf.flushTimer); buf.flushTimer = null }
        drainBufs(chatId)

        const pendingStep: ToolStep = {
          id: uuid(), type: 'tool_call' as const,
          toolName: step.toolName, toolArgs: undefined,
          content: step.content, success: undefined,
          timestamp: Date.now(), imageUrl: undefined,
          callId: step.callId,
          serverName: step.serverName,
          pending: true,
        }
        const iters = buf.iters
        const last = iters[iters.length - 1]
        const textBetween = buf.text
        const thinkingNow = buf.thinking
        const thinkingMsNow = buf.thinkingMs
        let newIters: typeof iters
        if (!last || textBetween.trim() || thinkingNow) {
          newIters = [...iters, {
            textBefore: textBetween,
            thinking: thinkingNow || undefined,
            thinkingMs: thinkingMsNow,
            steps: [pendingStep],
          }]
        } else {
          iters[iters.length - 1] = { ...last, steps: [...last.steps, pendingStep] }
          newIters = iters
        }
        buf.iters = newIters
        buf.text = ''
        buf.thinking = ''
        buf.thinkingMs = undefined
        buf.isThinkingLive = false
        // ОДИН setLiveState вместо двух (commitIters + reset).
        liveSet(chatId, {
          iters: [...buf.iters],
          isAgentRunning: true,
          isTyping: true,
          text: '',
          thinking: '',
          thinkingMs: undefined,
          isThinkingLive: false,
        })
      } else if (step.type === 'tool_call') {
        // Синхронный drain pending-токенов перед захватом в итерацию.
        if (buf.flushTimer !== null) { clearTimeout(buf.flushTimer); buf.flushTimer = null }
        drainBufs(chatId)

        const newStep: ToolStep = {
          id: uuid(), type: 'tool_call' as const,
          toolName: step.toolName, toolArgs: step.toolArgs,
          content: step.content, success: step.success,
          timestamp: Date.now(), imageUrl: step.imageUrl,
          callId: step.callId,
          serverName: step.serverName,
        }
        buf.steps.push(newStep)

        // Заменяем pending-карточку in-place. Сначала по pendingCallId
        // (точный ключ), затем — если pendingCallId не совпал — по
        // toolName в последней итерации, чтобы не плодить дубль
        // (раньше при несовпадении создавалась вторая итерация, а
        // pending-карточка оставалась без результата → бесконечный спиннер).
        let replacedPending = false
        if (step.pendingCallId) {
          const itersForReplace = buf.iters.map(iter => {
            const stepIdx = iter.steps.findIndex(s => s.type === 'tool_call' && s.callId === step.pendingCallId)
            if (stepIdx === -1) return iter
            replacedPending = true
            const nextSteps = [...iter.steps]
            nextSteps[stepIdx] = newStep
            return { ...iter, steps: nextSteps }
          })
          if (replacedPending) {
            buf.iters = itersForReplace
          }
        }
        if (!replacedPending && step.toolName) {
          // Fallback: pending-карточка по toolName в последней итерации
          // (pending-шаги не имеют реального callId, только pending-*).
          const last = buf.iters[buf.iters.length - 1]
          if (last) {
            const stepIdx = last.steps.findIndex(s =>
              s.type === 'tool_call' && s.toolName === step.toolName && s.pending
            )
            if (stepIdx !== -1) {
              const nextSteps = [...last.steps]
              nextSteps[stepIdx] = newStep
              buf.iters = [...buf.iters.slice(0, -1), { ...last, steps: nextSteps }]
              replacedPending = true
            }
          }
        }

        if (!replacedPending) {
          const iters = buf.iters
          const last = iters[iters.length - 1]
          const textBetween = buf.text
          const thinkingNow = buf.thinking
          const thinkingMsNow = buf.thinkingMs
          let newIters: typeof iters
          if (!last || textBetween.trim() || thinkingNow) {
            newIters = [...iters, {
              textBefore: textBetween,
              thinking: thinkingNow || undefined,
              thinkingMs: thinkingMsNow,
              steps: [newStep],
            }]
          } else {
            iters[iters.length - 1] = { ...last, steps: [...last.steps, newStep] }
            newIters = iters
          }
          buf.iters = newIters
        }
        buf.text = ''
        buf.thinking = ''
        buf.thinkingMs = undefined
        buf.isThinkingLive = false
        // ОДИН setLiveState вместо четырёх (drain-text + commitIters + commitSteps + reset).
        liveSet(chatId, {
          iters: [...buf.iters],
          steps: [...buf.steps],
          isAgentRunning: true,
          isTyping: true,
          text: '',
          thinking: '',
          thinkingMs: undefined,
          isThinkingLive: false,
        })
      } else if (step.type === 'tool_result') {
        const newStep: ToolStep = {
          id: uuid(), type: 'tool_result' as const,
          toolName: step.toolName, toolArgs: step.toolArgs,
          content: step.content, success: step.success,
          timestamp: Date.now(), imageUrl: step.imageUrl,
          diff: step.diff,
          imagePaths: step.imagePaths,
          callId: step.callId,
          visualAnalysis: step.visualAnalysis,
        }
        buf.steps.push(newStep)
        if (buf.iters.length === 0) {
          liveSet(chatId, { steps: [...buf.steps] })
          return
        }
        const iters = buf.iters
        // Матчим result в правильную итерацию. Раньше дефолтом была
        // последняя итерация (targetIterIdx = iters.length - 1) — при
        // результате без callId (блок/отказ/MCP-ошибка) и дубликате
        // toolName в нескольких итерациях findIndex брал первую, а
        // дефолт оставлял последнюю → рассинхрон: реальный вызов без
        // result → бесконечный спиннер. Теперь ищем самую старую
        // resultless-итерацию с тем же toolName, иначе — самую старую
        // resultless вообще (чтобы orphan-результат не повис).
        let targetIterIdx = -1
        if (step.callId) {
          const idx = iters.findIndex(iter =>
            iter.steps.some(s => s.type === 'tool_call' && s.callId === step.callId)
          )
          if (idx !== -1) targetIterIdx = idx
        }
        if (targetIterIdx === -1 && step.toolName) {
          // Самая старая итерация с toolName-вызовом и без результата
          const idx = iters.findIndex(iter =>
            iter.steps.some(s => s.type === 'tool_call' && s.toolName === step.toolName) &&
            !iter.steps.some(s => s.type === 'tool_result')
          )
          if (idx !== -1) targetIterIdx = idx
        }
        if (targetIterIdx === -1) {
          // Самая старая итерация без любого результата — покрывает
          // orphan-результаты (_error/_limit без парного tool_call).
          const idx = iters.findIndex(iter =>
            !iter.steps.some(s => s.type === 'tool_result')
          )
          if (idx !== -1) targetIterIdx = idx
        }
        if (targetIterIdx === -1) {
          // Нет подходящей итерации — создаём синтетическую, чтобы
          // orphan-результат не потерялся (зеркало buildIterations).
          buf.iters = [...iters, {
            textBefore: '',
            thinking: undefined,
            thinkingMs: undefined,
            steps: [
              {
                id: uuid(), type: 'tool_call' as const,
                toolName: step.toolName, toolArgs: undefined,
                content: step.toolName ?? 'tool', success: undefined,
                timestamp: Date.now(), callId: step.callId,
                pending: false,
              } as ToolStep,
              newStep,
            ],
          }]
        } else {
          iters[targetIterIdx] = { ...iters[targetIterIdx], steps: [...iters[targetIterIdx].steps, newStep] }
        }
        // ОДИН setLiveState вместо двух (commitIters + commitSteps).
        // При успешном результате тула сбрасываем retry/lastError —
        // ретрай/ошибка больше не актуальны.
        if (step.success && (buf.retry || buf.lastError)) {
          buf.retry = null
          buf.lastError = null
          liveSet(chatId, {
            iters: [...buf.iters],
            steps: [...buf.steps],
            retry: null,
            lastError: null,
            isAgentRunning: true,
            isTyping: true,
          })
        } else {
          liveSet(chatId, {
            iters: [...buf.iters],
            steps: [...buf.steps],
            isAgentRunning: true,
            isTyping: true,
          })
        }
      } else if (step.type === 'tool_result_update') {
        // Native analyze_image lifecycle: обновление уже показанного result.
        // Immutable-замена по callId (fallback — toolName) в buf.steps и во
        // ВСЕХ buf.iters — НЕ добавляем новый шаг и НЕ создаём итерацию, иначе
        // получим дубль карточки и осиротевшую итерацию.
        const va = step.visualAnalysis
        const matchesResult = (s: ToolStep): boolean => {
          if (s.type !== 'tool_result') return false
          if (step.callId) return s.callId === step.callId
          return s.toolName === step.toolName
        }
        let changed = false
        const nextSteps = buf.steps.map(s => {
          if (!matchesResult(s)) return s
          changed = true
          return {
            ...s,
            visualAnalysis: va ?? s.visualAnalysis,
            success: step.success !== undefined ? step.success : s.success,
          }
        })
        const nextIters = buf.iters.map(iter => {
          let iterChanged = false
          const steps = iter.steps.map(s => {
            if (!matchesResult(s)) return s
            iterChanged = true
            changed = true
            return {
              ...s,
              visualAnalysis: va ?? s.visualAnalysis,
              success: step.success !== undefined ? step.success : s.success,
            }
          })
          return iterChanged ? { ...iter, steps } : iter
        })
        // Если исходный result ещё не пришёл в renderer — нечего обновлять.
        if (!changed) return
        buf.steps = nextSteps
        buf.iters = nextIters
        liveSet(chatId, {
          steps: [...buf.steps],
          iters: [...buf.iters],
          isAgentRunning: true,
          isTyping: true,
        })
      }
    })

    return () => {
      offToolProgress(); offSpawn(); offStep()
    }
  }, [])
}
