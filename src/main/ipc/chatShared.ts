import { BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import type Store from 'electron-store'
import { getAllChats } from '../../core/db'
import { extractAndSaveFacts } from '../../core/memory/extractor'
import { extractAndSaveOutcomes } from '../../core/memory/outcomeExtractor'
import { IPC_EVENTS } from '../../shared/constants'
import { getActivityManager } from '../managers/ActivityManager'
import { log } from '../../core/logger'
import type { QueueItemMeta, AttachmentProcessingResult } from '../../shared/types'

// ── Глобальные callback Maps для confirm/question ──────────────────────
// NotificationManager (permission/ask_user из overlay) вызывает resolveConfirm /
// resolveQuestion напрямую — тот же main процесс, без IPC round-trip.
// ipcMain.once (из главного окна AgentConfirmDialog / QuestionPanel) тоже
// резолвит через эти Map — двойной путь, но callback сработает только один раз.
export const confirmCallbacks = new Map<string, (approved: boolean) => void>()
export const questionCallbacks = new Map<string, (answers: import('../../shared/types').QuestionAnswer[]) => void>()

export function resolveConfirm(reqId: string, approved: boolean): void {
  const cb = confirmCallbacks.get(reqId)
  if (cb) {
    confirmCallbacks.delete(reqId)
    cb(approved)
  }
}

export function resolveQuestion(reqId: string, answers: import('../../shared/types').QuestionAnswer[]): void {
  const cb = questionCallbacks.get(reqId)
  if (cb) {
    questionCallbacks.delete(reqId)
    cb(answers)
  }
}

/**
 * Состояние одного активного запуска chat:send.
 *
 * Раньше эти буферы были module-scoped и разделялись между ВСЕМИ вызовами
 * chat:send — из-за этого новый send обнулял буферы (chat.ipc.ts:165-168)
 * ДО того, как убивал старый воркер (184-188), и весь накопленный старым
 * прогоном контекст терялся безвозвратно (worker.terminate() рвёт поток
 * мгновенно, единственная точка персистентности — sendDone → saveMessage).
 *
 * Теперь каждый запуск держит свой собственный экземпляр ActiveRun, а
 * module-level `activeRuns` — это Map по chatId. Несколько чатов могут
 * работать параллельно, каждый со своим воркером и буферами. В пределах
 * одного chatId запуски сериализуются через chatQueues (FIFO).
 */
export interface ActiveRun {
  worker: Worker
  chatId: string
  msgId: string
  startedAt: number
  // createdAt сообщения assistant — фиксируется при создании run,
  // чтобы периодические checkpoint'ы сохраняли оригинальный created_at
  // (иначе INSERT OR REPLACE сдвинул бы позицию сообщения).
  createdAt: number
  bufferedText: string
  bufferedThinking: string
  bufferedThinkingMs?: number
  bufferedSteps: unknown[]
  bufferedTodo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  bufferedAgentStatus: string | null
  bufferedRateLimitSec: number
  bufferedRetry: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  doneSent: boolean
  sendDone: (fullText: string, thinkingText?: string, thinkingMs?: number, steps?: unknown[], iters?: unknown[], todo?: unknown[], fileSnapshots?: Array<{ path: string; contentBefore: string | null }>, usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void
  // ── Реконструкция итераций (зеркало ai-worker.ts:113-125) ──
  // Раньше bufferedIters был всегда [] — main не группировал шаги в итерации,
  // полагаясь на worker.collectedIters в сообщении 'done'. Но при stop/exit/
  // error воркер не успевает отправить collectedIters, и sendDone сохранял
  // сообщение без iterations → все тулы сливались в одну кучу, а текст
  // рендерился отдельным блоком. Также chat:getLiveState возвращал [] → при
  // возврате в чат во время стриминга тулы теряли позиции. Теперь main сам
  // реконструирует iters из потоковых событий (token/step/thinking).
  pendingTextAfter: string
  pendingThinking: string
  pendingThinkingMs?: number
  // ── UI-батчинг токенов ──
  // Раньше каждый LLM-токен летел отдельным IPC-событием (50-200/сек на
  // быстрых моделях) — structured-clone + dispatch на каждый. Рендерер всё
  // равно буферизует с флешем 50мс, поэтому батчим симметрично: копим в
  // uiTokenBuf/uiThinkingBuf и шлём пачкой раз в UI_FLUSH_MS.
  uiTokenBuf: string
  uiThinkingBuf: string
  uiFlushTimer: ReturnType<typeof setTimeout> | null
  currentIterTextBefore: string
  currentIterSteps: unknown[]
  currentIterThinking: string
  currentIterThinkingMs?: number
  closedIters: unknown[]
  // Фаза 4: кэш args tool_call'ов по callId — для логирования в agent_logs
  // при получении tool_result. tool_result не содержит args (они в tool_call),
  // но для outcome-extraction важен контекст "что пытались сделать".
  toolCallArgsCache: Map<string, { toolName: string; args: Record<string, unknown> }>
  // Результат обработки вложений (processAttachmentsAndStream) — сохраняется
  // в assistantMsg через sendDone для отображения AttachmentProcessingBlock.
  attachmentResult: AttachmentProcessingResult | null
  // imageParts для прямой передачи в основную модель (vision-capable)
  imageParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }>
  // AbortController для прерывания обработки вложений (processAttachmentsAndStream)
  // при chat:stop — воркер ещё не создан, terminate() не помогает.
  attachmentAbort?: AbortController
  // ── Единое зеркало ephemeral live-состояния ──────────────────────────
  // Накапливается параллельно с webContents.send в IPC-хендлерах событий
  // от worker'а (tool_progress, spawn_agent, и любые будущие ephemeral-блоки).
  // chat:getLiveState возвращает это как есть → renderer гидрирует целиком.
  // Универсально: любой новый live-блок добавляется сюда в своём хендлере
  // и автоматически работает при переключении чатов — без изменения схемы
  // снапшота или hydrateFromMain.
  bufferedLiveState: {
    toolProgress: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
    spawnedAgents: Array<{ agentId: string; callId?: string; task: string; msgId: string; model?: string; role?: string; ts: number }>
  }
  // ── Периодический checkpoint стриминга в БД ──
  // Таймер сохраняет накопленный bufferedText/steps/thinking в БД каждые
  // 3 секунды (saveMessage UPSERT — идемпотентен). При жёстком краше
  // процесса (SIGSEGV, kill -9, OOM) ни before-quit, ни worker.on('exit')
  // не срабатывают — теряется весь прогресс. С таймером максимум потерь
  // = 3 секунды стриминга. Очищается в sendDone.
  streamCheckpointTimer: ReturnType<typeof setInterval> | null
  // ── Dirty-flag для checkpoint-таймера ──
  // true = с последнего checkpoint'а пришли новые токены/шаги/thinking.
  // Без этого таймер каждые 3с делал buildFinalIters + JSON.stringify всех
  // steps + saveMessage даже когда ничего не изменилось (воркер ждёт ответа
  // от API, bufferedText не растёт). С dirty-flag — saveMessage только
  // при реальных изменениях → main не блокируется пустой сериализацией.
  checkpointDirty: boolean
}

export const activeRuns = new Map<string, ActiveRun>()
// Последний активный chatId (renderer шлёт chat:setActive). Spotlight-окно
// спрашивает chat:getActive чтобы предложить "спросить в текущем чате".
export let lastActiveChatId: string | null = null
export function setLastActiveChatId(id: string | null): void { lastActiveChatId = id }
// AbortController-ы для отмены /compact. Один на chatId — компакция и
// chat:send взаимоисключающи (chat:compact отклоняет если activeRuns.has).
// Используется chat:compact:cancel чтобы прервать LLM-стрим резюме БЕЗ
// применения частичного/пустого результата к чату.
export const compactRuns = new Map<string, AbortController>()
// Метаданные активного запуска для UI очереди (preview/userMsgId/startedAt).
// Дублирует часть ActiveRun, но хранится отдельно — т.к. ActiveRun содержит
// тяжёлые буферы токенов/шагов, а meta нужна для лёгкого снапшота в renderer.
export const activeRunMeta = new Map<string, QueueItemMeta>()

// FIFO-очередь запусков на один chatId. Новый chat:send в чат, где уже
// работает воркер, ставится в очередь и стартует после завершения старого.
// Каждый элемент хранит meta (queueId/msgId/preview/...) для отображения
// в UI панели очереди и управления (cancel/reorder/remove).
export interface QueuedSend {
  run: () => Promise<void>
  meta: QueueItemMeta
}
export const chatQueues = new Map<string, Array<QueuedSend>>()

// Auto-recall dedup: chatId → Set ключей уже инжектированных результатов.
// Предотвращает повторную инжекцию тех же memory/graph/message результатов
// на follow-up сообщениях в том же топике — экономит ~60-80% токенов на
// типичном диалоге. Сбрасывается при компакции (модель теряет старый контекст)
// и при удалении чата.
export const autoRecallInjectedKeys = new Map<string, Set<string>>()

// Фаза 3: Idle-timer для memory extraction. После каждого chat:send
// ставим setTimeout на 10 минут — если за это время не было нового
// сообщения в этом чате, запускаем LLM-extract фактов из последнего
// turn'а. Сбрасывается при новом chat:send. Map<chatId, {timer, params}>.
export const IDLE_EXTRACT_DELAY_MS = 10 * 60 * 1000 // 10 минут
export interface IdleExtractPending {
  timer: NodeJS.Timeout
  chatId: string
  userMessage: string
  assistantMessage: string
  projectId?: string
}
export const idleExtractTimers = new Map<string, IdleExtractPending>()

export function scheduleIdleExtraction(
  store: Store,
  chatId: string,
  userMessage: string,
  assistantMessage: string,
  projectId?: string,
): void {
  // Сбрасываем предыдущий таймер если был
  const existing = idleExtractTimers.get(chatId)
  if (existing) {
    clearTimeout(existing.timer)
  }

  // Skip-условия (дублирование extractor.ts, но без LLM-вызова — дешевле)
  if (userMessage.trim().length < 20 || userMessage.startsWith('/')) return

  const timer = setTimeout(async () => {
    idleExtractTimers.delete(chatId)
    try {
      const result = await extractAndSaveFacts(store, {
        chatId,
        userMessage,
        assistantMessage,
        projectId,
      })
      log('[chat] idle memory extraction: chatId=%s extracted=%d', chatId, result.extracted)
      // Фаза 4: outcome-extraction из agent_logs (параллельно, не блокирует)
      extractAndSaveOutcomes(store, { chatId, projectId })
        .then(r => log('[chat] idle outcome extraction: chatId=%s extracted=%d', chatId, r.extracted))
        .catch(e => log('[chat] idle outcome extraction failed: %s', (e as Error).message))
    } catch (e) {
      log('[chat] idle memory extraction failed: %s', (e as Error).message)
    }
  }, IDLE_EXTRACT_DELAY_MS)

  // unref — таймер не держит процесс alive при выходе
  if (typeof timer.unref === 'function') timer.unref()

  idleExtractTimers.set(chatId, { timer, chatId, userMessage, assistantMessage, projectId })
}

export function cancelIdleExtraction(chatId: string): void {
  const existing = idleExtractTimers.get(chatId)
  if (existing) {
    clearTimeout(existing.timer)
    idleExtractTimers.delete(chatId)
  }
}

export function emitRunStatus(
  win: BrowserWindow | null,
  chatId: string,
  status: 'running' | 'done' | 'error' | 'cancelled' | 'queued',
  msgId?: string,
  error?: string,
) {
  win?.webContents.send(IPC_EVENTS.CHAT_RUN_STATUS, { chatId, status, msgId, error, ts: Date.now() })
  // Форвард в ActivityManager (overlay-информер активности)
  getActivityManager()?.onRunStatus({ chatId, status, msgId, error })
}

/** Хелпер: получить заголовок чата для уведомления (fallback на "Чат") */
export function getChatTitleForNotif(chatId: string): string {
  try {
    const chat = getAllChats().find(c => c.id === chatId)
    return chat?.title || 'Чат'
  } catch {
    return 'Чат'
  }
}
