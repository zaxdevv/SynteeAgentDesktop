import { ipcMain, BrowserWindow, app, dialog } from 'electron'
import { Worker } from 'worker_threads'
import * as path from 'path'
import type Store from 'electron-store'
import { agentManager } from '../AgentManager'
import {
  createChat, getAllChats, getMessages, getMessagesPage, saveMessage,
  deleteChat, renameChat, pinMessage, unpinMessage, initDB, getDB,
  archiveChat, pinChat, setChatColor, duplicateChat, exportChat,
  getWorkingMemory, setWorkingMemory, getChatSummary, setChatSummary,
  getChatMode, getChatWorkdirContext,
  getChatModes, setChatModes, getChatDraft, setChatDraft, getUserMessageContents,
  setChatLastUsage, getChatLastUsage, clearChatLastUsage,
  createProject, getAllProjects, renameProject, deleteProject, getProjectById, touchProject,
  setProjectVerificationCommand,
  saveFileSnapshots, saveContextSnapshot, saveCheckpointMeta, getMessageCount,
  getCheckpoints, getLastCheckpoint, getSnapshotsAfter, getContextSnapshot,
  deleteCheckpointsAfter, pruneOldCheckpoints, deleteMessagesAfter,
  saveRewindHistory, getRewindHistory, deleteRewindHistory, deleteMessageById,
  saveNamedSnapshot, getNamedSnapshots,
  logAgentAction,
} from '../../core/db'
import { extractMemoriesFromConversation, saveMemory } from '../../core/memory/MemoryEngine'
import { saveMemoryItem, searchAllSources, buildCuratedSummary, getMemoryStatsForProject, bumpMemoryHit } from '../../core/memory/MemoryStore'
import { onCompactionTrigger, extractAndSaveFacts } from '../../core/memory/extractor'
import { incrementalUpdateDecision, incrementalUpdateConversation } from '../../core/memory/graphBuilder'
import { getGraphStats } from '../../core/memory/graphStore'
import { extractAndSaveOutcomes } from '../../core/memory/outcomeExtractor'
import { buildSystemPrompt } from '../../core/prompts/buildSystemPrompt'
import { readProjectInstructions } from '../../core/prompts/projectInstructions'
import { AIClient } from '../../core/ai/AIClient'
import { getAccessToken } from '../services/tokenStore'
import { getGatewayAuthToken, forceRefreshGatewayToken } from '../services/gatewayClient'
import { getToolSchemas, analyzeProject, GET_MAIN_CHAT_MESSAGES_SCHEMA, savePlanToFileSync } from '../../core/tools'
import { extractFinalPlan } from '../../shared/planParser'
import { IPC_EVENTS } from '../../shared/constants'
import { v4 as uuid } from 'uuid'
import {
  applyRollingWindowAsync, getContextSettings, estimateTokens, estimateMessagesTokens,
  getModelContextWindow,
  type ChatMessage,
} from '../../core/context/contextManager'
import { buildSnapshotFromEstimate, buildSnapshotFromReal, getSessionCost, resetSessionCost } from '../../core/tokens/usageTracker'
import { getFileCacheSnapshot, mergeFileCache, clearFileCache } from '../../core/context/fileReadCache'
import { startWatching as startFastContextWatch, stopWatching as stopFastContextWatch } from '../../core/context/fastContextWatcher'
import { initFastContextDb, initFastContextWasmDir } from '../../core/context/fastContext'
import { existsSync } from 'fs'
import { ptyManager, type ShellType } from '../PtyManager'
import { log } from '../../core/logger'
import { getSkillManager } from '../../core/skills/skillManager'
import { getMcpManager } from '../../core/mcp/McpManager'
import type { Message, AgentSettings, ChatMode, QueueItemMeta, Attachment, AttachmentProcessingResult } from '../../shared/types'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/types'
import { messageToContextMessages, formatTodoForContext } from './chatContextHelpers'
import { slimMessageForUI, slimMessagesForUI } from './slimMessages'

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
interface ActiveRun {
  worker: Worker
  chatId: string
  msgId: string
  startedAt: number
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
}

const activeRuns = new Map<string, ActiveRun>()
// Метаданные активного запуска для UI очереди (preview/userMsgId/startedAt).
// Дублирует часть ActiveRun, но хранится отдельно — т.к. ActiveRun содержит
// тяжёлые буферы токенов/шагов, а meta нужна для лёгкого снапшота в renderer.
const activeRunMeta = new Map<string, QueueItemMeta>()

// FIFO-очередь запусков на один chatId. Новый chat:send в чат, где уже
// работает воркер, ставится в очередь и стартует после завершения старого.
// Каждый элемент хранит meta (queueId/msgId/preview/...) для отображения
// в UI панели очереди и управления (cancel/reorder/remove).
interface QueuedSend {
  run: () => Promise<void>
  meta: QueueItemMeta
}
const chatQueues = new Map<string, Array<QueuedSend>>()

// Фаза 3: Idle-timer для memory extraction. После каждого chat:send
// ставим setTimeout на 10 минут — если за это время не было нового
// сообщения в этом чате, запускаем LLM-extract фактов из последнего
// turn'а. Сбрасывается при новом chat:send. Map<chatId, {timer, params}>.
const IDLE_EXTRACT_DELAY_MS = 10 * 60 * 1000 // 10 минут
interface IdleExtractPending {
  timer: NodeJS.Timeout
  chatId: string
  userMessage: string
  assistantMessage: string
  projectId?: string
}
const idleExtractTimers = new Map<string, IdleExtractPending>()

function scheduleIdleExtraction(
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

function cancelIdleExtraction(chatId: string): void {
  const existing = idleExtractTimers.get(chatId)
  if (existing) {
    clearTimeout(existing.timer)
    idleExtractTimers.delete(chatId)
  }
}

function emitRunStatus(
  win: BrowserWindow | null,
  chatId: string,
  status: 'running' | 'done' | 'error' | 'cancelled' | 'queued',
  msgId?: string,
  error?: string,
) {
  win?.webContents.send(IPC_EVENTS.CHAT_RUN_STATUS, { chatId, status, msgId, error, ts: Date.now() })
}

/**
 * Эмитит снапшот текущей очереди chatId для UI (список ожидающих запросов).
 * Вызывается при любом изменении: добавлении, удалении, reorder, drain.
 */
function emitQueueUpdate(win: BrowserWindow | null, chatId: string) {
  const q = chatQueues.get(chatId) ?? []
  const queue = q.map(item => item.meta)
  win?.webContents.send(IPC_EVENTS.CHAT_QUEUE_UPDATED, { chatId, queue, ts: Date.now() })
}

// ── Хелперы реконструкции итераций для ActiveRun ──────────────────────
// Зеркалят логику ai-worker.ts (flushIter + finalize) чтобы main мог строить
// iterations из потоковых событий при stop/exit/error и для chat:getLiveState.
// Без этого при ручной остановке или возврате в чат во время стриминга тулы
// теряли позиции (все сливались в одну кучу, текст — отдельным блоком).

/**
 * Чинит незакрытые markdown code-fences в textBefore. Если агент стримил
 * prose до зависшего тула и не дописал закрывающий ```` ``` ```` — ReactMarkdown
 * проглотил бы весь последующий контент в code-block. Считаем fences (``` и ~~~)
 * и если нечётное — дописываем закрывающий.
 */
function repairMarkdownFence(text: string): string {
  if (!text) return text
  const fenceMatches = text.match(/^[ \t]*(`{3,}|~{3,})/gm)
  if (!fenceMatches) return text
  // Группируем по типу ограды (``` или ~~~) — незакрытый считается только
  // если нечётное число ОДНОТИПНЫХ оград.
  const byChar: Record<string, number> = {}
  for (const f of fenceMatches) {
    const ch = f.trim()[0]
    byChar[ch] = (byChar[ch] || 0) + 1
  }
  let result = text
  for (const [ch, count] of Object.entries(byChar)) {
    if (count % 2 !== 0) {
      result += `\n${ch.repeat(3)} `
    }
  }
  return result
}

/**
 * Добавляет синтетические tool_result для tool_call без парного result.
 * При ручной остановке/падении воркера агент мог эмитить tool_call, но
 * executeTool не успел вернуть результат → в шагах висит orphan call.
 * Без этого ToolChain рендерит карточку без бейджа (ни ✓ ни ✗) — "кривая".
 * Синтетический result даёт ✗ бейдж + текст "[прервано пользователем]".
 */
function ensureToolResults(steps: unknown[]): unknown[] {
  const result = [...steps]
  const calls = result.filter((s: any) => s?.type === 'tool_call')
  const results = result.filter((s: any) => s?.type === 'tool_result')
  for (const call of calls) {
    const c = call as { callId?: string; toolName?: string; id: string }
    const hasResult = results.some((r: any) =>
      (c.callId && r?.callId === c.callId) ||
      (!c.callId && r?.toolName === c.toolName && !(r as any)._matched)
    )
    if (!hasResult) {
      // Помечаем чтобы fallback-матчинг не цеплял один result на несколько call'ов
      result.push({
        id: uuid(),
        type: 'tool_result',
        toolName: c.toolName,
        content: '[прервано пользователем]',
        success: false,
        timestamp: Date.now(),
        callId: c.callId,
      })
    }
  }
  return result
}

function flushRunIter(run: ActiveRun): void {
  if (run.currentIterSteps.length > 0) {
    run.closedIters.push({
      textBefore: repairMarkdownFence(run.currentIterTextBefore),
      thinking: run.currentIterThinking || undefined,
      thinkingMs: run.currentIterThinkingMs,
      steps: run.currentIterSteps,
    })
    run.currentIterTextBefore = ''
    run.currentIterSteps = []
    run.currentIterThinking = ''
    run.currentIterThinkingMs = undefined
  }
}

/**
 * Снапшот для chat:getLiveState: закрытые iters + открытая (текущая) итерация.
 * Включает open-iter чтобы при возврате в чат показать частичный прогресс
 * (тулы на своих местах, незавершённый тулчейн — с isRunning).
 */
function buildLiveIters(run: ActiveRun): unknown[] {
  const iters = [...run.closedIters]
  if (run.currentIterSteps.length > 0) {
    iters.push({
      textBefore: run.currentIterTextBefore,
      thinking: run.currentIterThinking || undefined,
      thinkingMs: run.currentIterThinkingMs,
      steps: [...run.currentIterSteps],
    })
  }
  return iters
}

/**
 * Финальные iters для sendDone: закрытые + открытая + хвостовой text-only iter
 * (зеркало ai-worker.ts finalize 176-187). Возвращает undefined если iters нет
 * (чисто текстовый ответ без тулов — рендерится через message.content).
 * Для каждого tool_call без парного tool_result добавляется синтетический
 * result (success:false, '[прервано]') — иначе ToolChain показывает orphan-карточку.
 */
function buildFinalIters(run: ActiveRun): unknown[] | undefined {
  const iters = [...run.closedIters]
  if (run.currentIterSteps.length > 0) {
    iters.push({
      textBefore: repairMarkdownFence(run.currentIterTextBefore),
      thinking: run.currentIterThinking || undefined,
      thinkingMs: run.currentIterThinkingMs,
      steps: [...run.currentIterSteps],
    })
  }
  if (iters.length > 0 && (run.pendingThinking || run.pendingTextAfter.trim())) {
    iters.push({
      textBefore: repairMarkdownFence(run.pendingTextAfter),
      thinking: run.pendingThinking || undefined,
      thinkingMs: run.pendingThinkingMs,
      steps: [],
    })
  }
  // Чиним orphan tool_call'ы во ВСЕХ итерациях (синтетические tool_result).
  for (const iter of iters as Array<{ steps: unknown[] }>) {
    iter.steps = ensureToolResults(iter.steps)
  }
  return iters.length > 0 ? iters : undefined
}

/**
 * Запускает следующий chat:send из очереди chatId, если он есть.
 * Вызывается после терминального статуса предыдущего запуска (done/error/cancelled).
 */
function drainQueue(win: BrowserWindow | null, chatId: string) {
  const q = chatQueues.get(chatId)
  if (!q || q.length === 0) {
    chatQueues.delete(chatId)
    emitQueueUpdate(win, chatId)
    return
  }
  const next = q.shift()!
  // Переносим meta из очереди в activeRunMeta — запрос стартовал.
  // Добавляем startedAt для UI (отображение длительности выполнения).
  activeRunMeta.set(chatId, { ...next.meta, startedAt: Date.now() })
  emitQueueUpdate(win, chatId)
  // Асинхронный запуск — ошибки внутри run() обрабатываются им самим.
  void next.run().catch((e) => {
    log('[chat:send] queued run failed chatId=%s: %s', chatId, (e as Error).message)
  })
}

// ─── Compact: helpers для разделителя сжатия контекста ──────────────────────
// Применяется и при авто-компакции (внутри runChatSend), и при ручном /compact
// (chat:compact IPC handler). Разделитель — это system-сообщение с
// slashCommand.name === 'compact', сохраняется в БД через saveMessage.
// compactSummary — снимок резюме на момент сжатия (не меняется при будущих
// компакциях в отличие от chat_summaries, который перетирается).

function fmtTokensK(n: number): string {
  // Округляем до десятых k (1200 → "1.2k", 18500 → "18.5k", 600 → "0.6k")
  return (Math.round(n / 100) / 10).toLocaleString('ru') + 'k'
}

function createCompactDivider(chatId: string, opts: {
  removedCount: number
  tokensBefore: number
  tokensAfter: number
  summaryContent: string
  createdAt?: number
}): Message {
  const tokensSaved = Math.max(0, opts.tokensBefore - opts.tokensAfter)
  const content = `Контекст сжат • удалено ${opts.removedCount} сообщ. • ${fmtTokensK(opts.tokensBefore)}→${fmtTokensK(opts.tokensAfter)} токенов • сэкономлено ~${fmtTokensK(tokensSaved)}`
  return {
    id: uuid(),
    chatId,
    role: 'system',
    content,
    createdAt: opts.createdAt ?? Date.now(),
    isPinned: 0,
    slashCommand: { name: 'compact', args: '' },
    compactSummary: opts.summaryContent,
    compactStats: {
      removedCount: opts.removedCount,
      tokensBefore: opts.tokensBefore,
      tokensAfter: opts.tokensAfter,
      tokensSaved,
    },
  }
}

function emitChatCompacted(win: BrowserWindow | null, payload: {
  chatId: string
  dividerMessageId: string
  removedCount: number
  tokensBefore: number
  tokensAfter: number
  trigger: 'auto' | 'manual'
}): void {
  win?.webContents.send(IPC_EVENTS.CHAT_COMPACTED, { ...payload, ts: Date.now() })
}

/**
 * Вычисляет Message.id middle-диапазона (что надо удалить из БД) и удаляет их.
 * Логика симметрична applyRollingWindowAsync: первые keepFirst и последние
 * keepLast Message остаются, middle — удаляется физически (через
 * deleteMessageById). При короткой истории адаптирует keepLast/keepFirst
 * так, чтобы middle содержал хотя бы 1 сообщение.
 *
 * Возвращает реально удалённое кол-во (может отличаться от removedCount в
 * CompressResult, т.к. тот считал ChatMessage, а тут — Message).
 */
function deleteMiddleMessagesFromDB(history: Message[], keepFirst: number, keepLast: number): number {
  let kf = keepFirst
  let kl = keepLast
  if (history.length <= kf + kl + 1) {
    const newKl = Math.max(0, history.length - kf - 1)
    kl = Math.min(kl, newKl)
    if (kf + kl + 1 > history.length) {
      kf = Math.max(0, history.length - kl - 1)
    }
  }
  if (kf + kl >= history.length || kf < 0 || kl < 0) return 0

  const middle = history.slice(kf, history.length - kl)
  let deleted = 0
  for (const msg of middle) {
    try {
      deleteMessageById(msg.id)
      deleted++
    } catch {
      // уже удалён / не существует — ok
    }
  }
  return deleted
}

/**
 * Возвращает «живое» подмножество истории для AI-контекста: сообщения
 * ПОСЛЕ последнего compaction-divider'а. Старые (summarized) сообщения
 * остаются в БД (UI хранит всю историю), но в контекст модели не грузятся
 * — их заменяет summary в system prompt.
 *
 * Модель: «новый чат + summary». После компакции AI видит только:
 *   summary (в system prompt) + tail + новые сообщения.
 *
 * Divider — это system-сообщение с slashCommand.name === 'compact'. Его
 * createdAt = граница между summarized middle и live tail (первый tail
 * минус 1). Сообщения с createdAt > divider.createdAt = tail + новые.
 * Divider-сообщения сами исключаются (они UI-маркеры, не AI-контекст).
 *
 * Если divider'а нет (первая компакция ещё не было) — live = вся история.
 */
function getLiveMessages(history: Message[]): Message[] {
  let lastCompactionAt = 0
  for (const msg of history) {
    if (msg.slashCommand?.name === 'compact' && msg.createdAt > lastCompactionAt) {
      lastCompactionAt = msg.createdAt
    }
  }
  if (lastCompactionAt === 0) return history
  return history.filter(m => m.createdAt > lastCompactionAt && m.slashCommand?.name !== 'compact')
}

/**
 * Резолвит директорию с tree-sitter .wasm файлами.
 * Порядок кандидатов:
 *   1. <cwd>/resources/tree-sitter — dev режим (process.cwd() = project root)
 *   2. <appPath>/resources/tree-sitter — packaged (если appPath НЕ out/main)
 *      или <appPath>/../../resources/tree-sitter — если appPath = out/main (dev build)
 *   3. process.resourcesPath/tree-sitter — packaged electron-builder extraResources
 *   4. process.resourcesPath/resources/tree-sitter — альтернативный layout
 */
function resolveTreeSitterWasmDir(): string {
  const candidates: string[] = [
    path.join(process.cwd(), 'resources', 'tree-sitter'),
  ]
  try {
    const appPath = app.getAppPath()
    if (/[\\/]out[\\/]main$/.test(appPath)) {
      candidates.push(path.join(appPath, '..', '..', 'resources', 'tree-sitter'))
    } else {
      candidates.push(path.join(appPath, 'resources', 'tree-sitter'))
    }
  } catch { /* app недоступен — ok */ }
  candidates.push(path.join(process.resourcesPath ?? '', 'tree-sitter'))
  candidates.push(path.join(process.resourcesPath ?? '', 'resources', 'tree-sitter'))
  for (const c of candidates) {
    try { if (existsSync(path.join(c, 'tree-sitter.wasm')) || existsSync(path.join(c, 'web-tree-sitter.wasm'))) return c } catch { /* ignore */ }
  }
  return candidates[0]
}

export function registerChatIPC(store: Store, mainWindow: { getWindow: () => BrowserWindow | null }): void {
  initDB()

  // Fast Context: инициализируем main-процессное connection к БД для watcher'а.
  // Worker открывает своё отдельное connection через initFastContextDb в ai-worker.ts.
  // WAL mode → оба могут работать concurrently с одним файлом.
  const fastContextDbPath = path.join(app.getPath('userData'), 'syntee.db')
  const fastContextWasmDir = resolveTreeSitterWasmDir()
  try {
    initFastContextDb(fastContextDbPath)
    initFastContextWasmDir(fastContextWasmDir)
  } catch (e) {
    log('[registerChatIPC] fast context init failed: %s', (e as Error).message)
  }

  // Стартуем fast context watchers для всех проектов, но pre-warm индексации
  // происходит только если индекс пустой. Watcher ловит изменения файлов.
  try {
    for (const p of getAllProjects()) {
      try { startFastContextWatch(p.id, p.workdir) } catch { /* отдельный watcher не критичен */ }
    }
  } catch { /* БД ещё пуста — ок */ }

  const getSystemPrompt = async (chatId?: string, isIncognito?: boolean, oneShotSkill?: { name: string; instructions: string }): Promise<string> => {
    const userName = store.get('userName') as string || ''
    let memoryContext = ''
    let workingMemory = ''
    let summary = ''
    let workdir: string | undefined
    let projectContext: string | undefined
    let promptProjectId: string | undefined
    try {
      if (chatId) {
        const wctx = getChatWorkdirContext(chatId)
        workdir = wctx.workdir
        projectContext = wctx.projectContext
        if (workdir) {
          const found = getAllProjects().find(p => p.workdir === workdir)
          promptProjectId = found?.id
        }
      }
    } catch { /* ok */ }
    // Curated memory summary: top global user_facts + top project_decisions.
    // Заменяет полный дамп getAllMemoriesForContext — бюджет ~400 токенов.
    try { memoryContext = buildCuratedSummary(promptProjectId) } catch { /* ok */ }
    try { if (chatId) workingMemory = getWorkingMemory(chatId) } catch { /* ok */ }
    try { if (chatId) summary = getChatSummary(chatId) } catch { /* ok */ }

    // Live-read AGENTS.md/CLAUDE.md/.syntee/instructions.md из workdir.
    // mtime-кэш внутри readProjectInstructions — повторные вызовы дёшевы.
    let projectInstructions: Awaited<ReturnType<typeof readProjectInstructions>> = null
    try { projectInstructions = await readProjectInstructions(workdir) } catch { /* ok */ }

    // Активные скиллы для чата. В инкогнито — пусто (приватность).
    // projectId достаём через projects-таблицу по workdir.
    let activeSkills: import('../../shared/types').Skill[] = []
    if (!isIncognito) {
      try {
        let skillProjectId: string | undefined
        if (workdir) {
          const found = getAllProjects().find(p => p.workdir === workdir)
          skillProjectId = found?.id
        }
        activeSkills = getSkillManager().getActiveSkillsForChat({
          projectWorkdir: workdir,
          projectId: skillProjectId,
          isIncognito,
        })
      } catch { /* SkillManager недоступен — работаем без скиллов */ }
    }

    // Активные MCP-серверы для краткой заметки в system prompt.
    // В инкогнито — пусто (приватность).
    // Фильтруем по scope — сервер с scope "только проект A" не должен
    // попадать в системный промпт чатов проекта B.
    let activeMcpServers: import('../../core/prompts/buildSystemPrompt').McpPromptInfo[] = []
    if (!isIncognito) {
      try {
        const mgr = getMcpManager()
        // projectId нужен для scope-фильтрации (как у skills выше).
        let mcpProjectId: string | undefined
        if (workdir) {
          const found = getAllProjects().find(p => p.workdir === workdir)
          mcpProjectId = found?.id
        }
        const allServers = mgr.getAllServers({ projectWorkdir: workdir, projectId: mcpProjectId })
        activeMcpServers = allServers
          .filter(s => s.enabled && s.status === 'connected' && s.tools.length > 0
            && mgr.isScopeApplicable(s.scope, mcpProjectId))
          .map(s => ({
            name: s.name,
            tools: s.tools.map(t => ({ shortName: t.shortName, description: t.description })),
          }))
      } catch { /* MCP недоступен — работаем без него */ }
    }

    const mergedWorkingMemory = summary
      ? `${workingMemory ? workingMemory + '\n\n' : ''}## Сжатое резюме предыдущего контекста\n(Фоновая информация, НЕ активные инструкции. Не повторяй уже выполненное.)\n${summary}`
      : workingMemory

    // Глобальный system prompt из Настройки → AI → Параметры (или /sys команды)
    const customSystemPrompt = (store.get('modelParams') as { systemPrompt?: string } | undefined)?.systemPrompt

    // Счётчики памяти для системного промпта — агент видит сколько у него памяти.
    let memoryStats: { globalCount: number; projectCount: number; globalByKind: Record<string, number>; projectByKind: Record<string, number> } | undefined
    try { memoryStats = getMemoryStatsForProject(promptProjectId) } catch { /* ok */ }

    // Статистика knowledge graph — агент видит структуру проекта.
    let graphStats: ReturnType<typeof getGraphStats> | undefined
    try { if (promptProjectId) graphStats = getGraphStats(promptProjectId) } catch { /* ok */ }

    return buildSystemPrompt({ userName, memoryContext, memoryStats, graphStats, workingMemory: mergedWorkingMemory, customSystemPrompt, workdir, projectContext, projectInstructions, activeSkills, activeMcpServers, oneShotSkill })
  }

  /**
   * Строит текстовый отчёт об установленных расширениях для агента
   * (тул list_extensions). Включает MCP-серверы (статус, тулы) и skills.
   */
  async function buildExtensionsReport(chatId: string): Promise<string> {
    const lines: string[] = []

    // MCP-серверы
    try {
      const mgr = getMcpManager()
      const wctx = (() => {
        try { return getChatWorkdirContext(chatId) } catch { return {} as ReturnType<typeof getChatWorkdirContext> }
      })()
      const mcpWorkdir = wctx.workdir
      let mcpProjectId: string | undefined
      if (mcpWorkdir) {
        const found = getAllProjects().find(p => p.workdir === mcpWorkdir)
        mcpProjectId = found?.id
      }
      const servers = mgr.getAllServers({ projectWorkdir: mcpWorkdir, projectId: mcpProjectId })
        .filter(s => s.enabled && mgr.isScopeApplicable(s.scope, mcpProjectId))
      lines.push('## MCP-серверы')
      if (servers.length === 0) {
        lines.push('MCP-серверы не установлены.')
      } else {
        for (const srv of servers) {
          const statusIcon = srv.status === 'connected' ? '✓' : srv.status === 'connecting' ? '⏳' : srv.status === 'error' ? '✗' : '○'
          lines.push(`- ${statusIcon} **${srv.name}** (${srv.status})${srv.enabled ? '' : ' [отключён]'}${srv.source === 'global' ? '' : ' [проект]'}`)
          if (srv.error) lines.push(`  Ошибка: ${srv.error.slice(0, 200)}`)
          if (srv.tools.length > 0) {
            lines.push(`  Тулы: ${srv.tools.map(t => t.shortName).join(', ')}`)
          } else if (srv.status === 'connected') {
            lines.push('  Тулы: (нет)')
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      log('[list_extensions] MCP error:', msg)
      lines.push('## MCP-серверы')
      lines.push(`MCP недоступен: ${msg}`)
    }

    // Skills
    lines.push('')
    lines.push('## Skills')
    lines.push('Skills — это инструкции в системном промпте, которым ты следуешь. Это не тулы: их не нужно вызывать, они влияют на твоё поведение автоматически. Используй get_skill(name) чтобы получить инструкции конкретного скилла.')
    try {
      const wctx = (() => {
        try { return getChatWorkdirContext(chatId) } catch { return {} as ReturnType<typeof getChatWorkdirContext> }
      })()
      const workdir = wctx.workdir
      let skillProjectId: string | undefined
      if (workdir) {
        const found = getAllProjects().find(p => p.workdir === workdir)
        skillProjectId = found?.id
      }
      // Показываем ВСЕ skills с состоянием — не только активные.
      const allSkills = getSkillManager().getAllWithState({
        projectWorkdir: workdir,
        projectId: skillProjectId,
      })
      if (allSkills.length === 0) {
        lines.push('Скиллы не установлены. Создайте .md-файл в .syntee/skills/ проекта или userData/skills/.')
      } else {
        const active = allSkills.filter(s => s.state.enabled)
        const inactive = allSkills.filter(s => !s.state.enabled)
        if (active.length > 0) {
          lines.push(`Активные (${active.length}):`)
          for (const s of active) {
            lines.push(`- **${s.name}** [${s.source}]: ${s.description || '(без описания)'}`)
          }
        }
        if (inactive.length > 0) {
          lines.push(`Неактивные (${inactive.length}, можно включить в Настройки → Расширения):`)
          for (const s of inactive) {
            lines.push(`- ${s.name} [${s.source}]: ${s.description || '(без описания)'}`)
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      log('[list_extensions] Skills error:', msg)
      lines.push(`Ошибка загрузки скиллов: ${msg}`)
    }

    return lines.join('\n')
  }

  /**
   * Реальный запуск воркера для chat:send. Вынесено из ipcMain.handle чтобы
   *  можно было ставить запросы в очередь на один chatId (если воркер уже
   *  работает) и вызывать drainQueue после терминального статуса.
   *
   *  Все ссылки на глобальные синглтоны (activeRuns, chatQueues) — module-level.
   *  store / mainWindow / getSystemPrompt — из замыкания registerChatIPC.
   */

  /**
   * Обработка вложений перед запуском агента:
   *  - Текстовые файлы инлайним в content (с лимитом 5МБ).
   *  - Картинки отправляем в vision-модель (через AIClient.analyzeImage),
   *    получаем текстовое описание, инлайним его в content.
   *  - Бинарные — только путь+имя+размер.
   *
   * Процесс стримится в UI как отдельный блок (AttachmentProcessingBlock,
   * аналогичный FastContextBlock) — НЕ ToolStep. Эмитим только
   * agent:tool_progress events (без agent:step tool_call/tool_result),
   * которые попадают в toolProgress['process_attachments'] в ChatLiveState.
   *
   * Возвращает { content, result } — augmented content с инлайн-блоками
   * и структурированный результат для сохранения в message (чтобы блок
   * отображался после рестарта, как FastContextBlock).
   */
  async function processAttachmentsAndStream(
    win: BrowserWindow | null,
    chatId: string,
    msgId: string,
    content: string,
    attachments: Attachment[],
  ): Promise<{ content: string; result: AttachmentProcessingResult | null }> {
    if (attachments.length === 0) return { content, result: null }

    // require вместо await import для builtin: нативный import() не работает в V8-байткоде.
    // (относительные import() ниже rollup компилирует в require — они безопасны)
    const { readFile: fsReadFile, stat: fsStat } = require('fs/promises')
    const { readFileSync } = require('fs')
    const { isTextMime, isImageMime } = await import('../../shared/mentions')
    const { AIClient } = await import('../../core/ai/AIClient')

    const startedAt = Date.now()
    // Подсчитываем кол-во файлов для прогресса (скиллы/команды пропускаем)
    const fileAttachments = attachments.filter(a => a.kind !== 'skill' && a.kind !== 'command' && a.path)
    const total = fileAttachments.length
    let processed = 0

    // Эмитим старт прогресса
    win?.webContents.send('agent:tool_progress', {
      msgId, chatId,
      toolName: 'process_attachments',
      stage: 'start',
      detail: 'Подготовка файлов',
      filesProcessed: 0,
      filesTotal: total,
      ts: Date.now(),
    })

    const textBlocks: string[] = []
    const processedFiles: Array<{
      name: string
      kind: string
      status: 'text_inlined' | 'image_described' | 'binary_path' | 'error' | 'skipped'
      size?: number
      detail?: string
      description?: string
    }> = []
    let hasErrors = false

    for (const att of attachments) {
      if (att.kind === 'skill' || att.kind === 'command' || !att.path) {
        processedFiles.push({
          name: att.name,
          kind: att.kind,
          status: 'skipped',
          detail: att.kind === 'skill' ? 'Скилл (обрабатывается отдельно)' : 'Команда (обрабатывается отдельно)',
        })
        continue
      }

      win?.webContents.send('agent:tool_progress', {
        msgId, chatId,
        toolName: 'process_attachments',
        stage: 'processing',
        detail: att.name,
        filesProcessed: processed,
        filesTotal: total,
        ts: Date.now(),
      })

      try {
        const st = await fsStat(att.path)
        if (st.isDirectory()) {
          textBlocks.push(`[Директория: ${att.name}]`)
          processedFiles.push({ name: att.name, kind: att.kind, status: 'binary_path', size: 0, detail: 'Директория' })
        } else if (att.kind === 'image' || isImageMime(att.mime)) {
          // Картинка → vision-модель
          win?.webContents.send('agent:tool_progress', {
            msgId, chatId,
            toolName: 'process_attachments',
            stage: 'analyzing_image',
            detail: att.name,
            filesProcessed: processed,
            filesTotal: total,
            ts: Date.now(),
          })

          const base64 = readFileSync(att.path).toString('base64')
          const aiClient = new AIClient(store)
          const description = await new Promise<string>((resolve) => {
            let full = ''
            aiClient.analyzeImage(
              base64,
              `Опиши содержимое этого изображения подробно. Это вложение пользователя к вопросу. Отвечай на русском. Опиши: что изображено, любой текст на картинке, контекст, который может быть полезен для ответа на вопрос пользователя.`,
              {
                onToken: (token) => {
                  full += token
                },
                onDone: (text) => resolve(text || full),
                onError: (err) => {
                  resolve(`[Ошибка анализа изображения: ${err.message}]`)
                },
              },
            ).catch(() => resolve('[Ошибка анализа изображения]'))
          })

          textBlocks.push(`─── Изображение: ${att.name} ───\n${description}\n─── Конец описания: ${att.name} ───`)
          processedFiles.push({
            name: att.name,
            kind: att.kind,
            status: 'image_described',
            size: st.size,
            description: description.slice(0, 200) + (description.length > 200 ? '…' : ''),
          })
        } else {
          // Текстовый или бинарный файл
          const mime = att.mime || ''
          if (isTextMime(mime) && st.size <= 5 * 1024 * 1024) {
            const fileContent = await fsReadFile(att.path, 'utf-8')
            textBlocks.push(`─── Файл: ${att.relPath || att.name} ───\n${fileContent}\n─── Конец файла: ${att.relPath || att.name} ───`)
            processedFiles.push({
              name: att.name,
              kind: att.kind,
              status: 'text_inlined',
              size: st.size,
              detail: `${(st.size / 1024).toFixed(1)} KB — содержимое инлайнено`,
            })
          } else {
            textBlocks.push(`[Прикреплён файл: ${att.name}] (${(st.size / 1024).toFixed(1)} KB, путь: ${att.path})`)
            processedFiles.push({
              name: att.name,
              kind: att.kind,
              status: 'binary_path',
              size: st.size,
              detail: `${(st.size / 1024).toFixed(1)} KB — только путь`,
            })
          }
        }
      } catch (e) {
        hasErrors = true
        const errMsg = (e as Error).message
        textBlocks.push(`[Файл недоступен: ${att.name} — ${errMsg}]`)
        processedFiles.push({ name: att.name, kind: att.kind, status: 'error', detail: errMsg })
      }
      processed++
    }

    // Эмитим финальный прогресс — блок в UI покажет финальный результат
    win?.webContents.send('agent:tool_progress', {
      msgId, chatId,
      toolName: 'process_attachments',
      stage: 'done',
      detail: hasErrors ? 'Завершено с ошибками' : 'Готово',
      filesProcessed: total,
      filesTotal: total,
      ts: Date.now(),
    })

    // Собираем augmented content
    const augmentedContent = textBlocks.length > 0
      ? `${content}\n\n${textBlocks.join('\n\n')}`
      : content

    // Структурированный результат для сохранения в message
    const result: AttachmentProcessingResult = {
      files: processedFiles,
      totalProcessed: processedFiles.filter(f => f.status !== 'skipped' && f.status !== 'error').length,
      totalErrors: processedFiles.filter(f => f.status === 'error').length,
      totalImages: processedFiles.filter(f => f.status === 'image_described').length,
      ms: Date.now() - startedAt,
      hasErrors,
    }

    return { content: augmentedContent, result }
  }

  async function runChatSend(
    params: {
      chatId: string
      content: string
      displayContent?: string
      slashCommand?: { name: string; args: string }
      incognito?: boolean
      userMsgId?: string
      planningMode?: boolean
      askMode?: boolean
      imageMode?: boolean
      mode?: ChatMode
      sideChatParentId?: string
      /** One-shot скилл — инструкции временно инъектируются на этот прогон
       *  (без записи в skillsState). Используется командами типа /review. */
      oneShotSkill?: { name: string; instructions: string }
      /** Ограничение тулов на этот прогон (для кастомных команд с allowed-tools).
       *  Builtin-команды не используют — их режим задаётся planning/askMode. */
      oneShotAllowedTools?: string[]
      /** Режим для кастомной команды: 'ask' (read-only) | 'plan' | 'code'. */
      oneShotMode?: 'ask' | 'plan' | 'code'
    },
    win: BrowserWindow | null,
    chatMode: ChatMode,
    agentSettings: AgentSettings,
    userMsg: Message,
    history: Message[],
    assistantMsgId: string,
  ): Promise<{ userMsg: Message; assistantMsgId: string }> {
    const storeData: Record<string, unknown> = {}
    const storeKeys = [
      'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels',
      'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'integrations',
      'voiceId', 'embeddingModel',
      'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
      'contextSettings',
    ]
    for (const k of storeKeys) {
      const v = store.get(k)
      if (v !== undefined) storeData[k] = v
    }

    const ctxSettings = getContextSettings(storeData)
    // Для side-чата DB-lookups (working memory, summary, workdir, system prompt)
    // делаем по parentChatId — side-чат эфемерный (incognito), не имеет своих
    // записей в БД, но разделяет контекст родителя.
    const dbChatId = params.sideChatParentId ?? params.chatId
    let currentWorkingMemory = ''
    let storedSummary = ''
    try { currentWorkingMemory = getWorkingMemory(dbChatId) } catch { /* ok */ }
    try { storedSummary = getChatSummary(dbChatId) } catch { /* ok */ }

    // Обновляем createdAt на момент реального старта. Для queued-запросов
    // userMsg.createdAt был зафиксирован в chat:send при отправке (до очереди),
    // а saveMessage происходит только сейчас. Без этого БД (сортировка по
    // created_at ASC) поставит user2/user3 перед assistant1 — порядок
    // диалога сломается при перезаходе в чат.
    userMsg.createdAt = Date.now()
    if (!params.incognito) saveMessage(userMsg)

    // Live-подмножество истории: сообщения ПОСЛЕ последнего compaction-divider'а.
    // Старые (summarized) сообщения остаются в БД (UI хранит всю историю),
    // но в контекст модели не грузятся — их заменяет summary в system prompt.
    // messageId тегируется здесь (на flatMap), чтобы compaction-логика могла
    // вычислить boundary (createdAt граничного Message) для divider'а без
    // удаления из БД.
    const liveMessages = getLiveMessages(history)
    const rawHistory: ChatMessage[] = liveMessages.flatMap(m =>
      messageToContextMessages(m).map(cm => ({ ...cm, messageId: m.id })),
    )
    log('[chat:send] chatId=%s history loaded: dbMsgs=%d liveMsgs=%d → contextMsgs=%d (after messageToContextMessages)',
      params.chatId, history.length, liveMessages.length, rawHistory.length)
    console.log('[chat.ipc] history loaded: dbMsgs=%d liveMsgs=%d contextMsgs=%d (chatId=%s)', history.length, liveMessages.length, rawHistory.length, params.chatId)

    let processedHistory = rawHistory
    let contextCompressed = false
    if (ctxSettings.rollingEnabled && rawHistory.length > 0) {
      const realContextWindow = getModelContextWindow(storeData)
      const rollingSettings = { ...ctxSettings, contextLimitTokens: realContextWindow }

      const summaryFn = async (prompt: string): Promise<string> => {
        const aiClient = new AIClient(store)
        let result = ''
        await aiClient.streamChat(
          [{ role: 'user', content: prompt }],
          { onToken: (t) => { result += t }, onDone: () => {}, onError: () => {} },
          'fast',
        )
        return result
      }

      const result = await applyRollingWindowAsync(rawHistory, rollingSettings, summaryFn, storedSummary || undefined, false)
      if (result.compressed) {
        const triggerTokens = Math.floor(realContextWindow * ctxSettings.rollingTriggerPct / 100)
        log('[chat:send] rolling-window компакция chatId=%s: contextWindow=%d triggerTokens=%d(=%d%%) removed=%d сообщений',
          params.chatId, realContextWindow, triggerTokens, ctxSettings.rollingTriggerPct, result.removedCount)
        processedHistory = result.messages
        contextCompressed = true
        if (result.summaryContent && !params.incognito) {
          setChatSummary(params.chatId, result.summaryContent)
          storedSummary = result.summaryContent

          // Фаза 3: compaction-триггер памяти — sync summary → memory_items
          // (episodic) + LLM-extract фактов из последнего turn'а.
          // Fire-and-forget — не блокируем основной поток чата.
          ;(async () => {
            try {
              let compactionProjectId: string | undefined
              const wctx = (() => { try { return getChatWorkdirContext(params.chatId) } catch { return null } })()
              if (wctx?.workdir) {
                const found = getAllProjects().find(p => p.workdir === wctx.workdir)
                compactionProjectId = found?.id
              }
              await onCompactionTrigger(store, {
                chatId: params.chatId,
                summary: result.summaryContent,
                projectId: compactionProjectId,
                lastUserMessage: params.content,
                lastAssistantMessage: undefined, // assistant ещё не готов на этом этапе
              })
              // Фаза 4: outcome-extraction из agent_logs (параллельно с fact-extraction)
              extractAndSaveOutcomes(store, { chatId: params.chatId, projectId: compactionProjectId })
                .then(r => log('[chat:send] outcome extraction on compaction: chatId=%s extracted=%d', params.chatId, r.extracted))
                .catch(e => log('[chat:send] outcome extraction failed: %s', (e as Error).message))

              // Knowledge graph: LLM-extract концепций/связей из нового summary
              if (compactionProjectId && result.summaryContent) {
                let chatTitle: string | undefined
                try {
                  const chatRow = getDB().prepare(`SELECT title FROM chats WHERE id = ?`).get(params.chatId) as { title: string } | undefined
                  chatTitle = chatRow?.title
                } catch { /* ok */ }
                incrementalUpdateConversation(store, {
                  projectId: compactionProjectId,
                  chatId: params.chatId,
                  summary: result.summaryContent,
                  chatTitle,
                })
                  .then(r => log('[chat:send] graph extraction on compaction: chatId=%s nodes=%d edges=%d', params.chatId, r.nodes, r.edges))
                  .catch(e => log('[chat:send] graph extraction failed: %s', (e as Error).message))
              }
              log('[chat:send] memory extraction on compaction: chatId=%s', params.chatId)
            } catch (e) {
              log('[chat:send] memory extraction failed: %s', (e as Error).message)
            }
          })()

          // Видимый разделитель «Контекст сжат» — system-сообщение с
          // slashCommand.name === 'compact'. compactSummary — снимок резюме,
          // не меняется при будущих компакциях (в отличие от chat_summaries).
          //
          // createdAt = boundary между summarized middle и live tail (первый
          // tail Message минус 1). Это граница для getLiveMessages следующего
          // запроса: сообщения с createdAt > divider.createdAt = tail + новые.
          // Старые сообщения НЕ удаляются из БД — UI хранит всю историю,
          // divider лишь маркирует «контекст выше сжат в summary».
          const tokensBefore = estimateMessagesTokens(rawHistory)
          const tokensAfter = estimateMessagesTokens(result.messages)
          const firstTailMsgId = result.messages.find(m => m.messageId)?.messageId
          const boundaryMsg = firstTailMsgId ? liveMessages.find(m => m.id === firstTailMsgId) : undefined
          const dividerCreatedAt = boundaryMsg ? boundaryMsg.createdAt - 1 : (userMsg.createdAt - 1)
          const divider = createCompactDivider(params.chatId, {
            removedCount: result.removedCount,
            tokensBefore,
            tokensAfter,
            summaryContent: result.summaryContent ?? '',
            createdAt: dividerCreatedAt,
          })
          saveMessage(divider)

          // Сообщения НЕ удаляем из БД — UI хранит всю историю. AI-контекст
          // ограничивается live-подмножеством (после divider'а) + summary в
          // system prompt. Старые сообщения видны в ленте, но не грузятся
          // в модель (getLiveMessages фильтрует по createdAt > divider'а).

          // Сброс last_usage — иначе context:calculate при перезаходе в чат
          // пересоберёт real-снапшот из устаревшего promptTokens (до-сжатия),
          // и индикатор контекста покажет старое значение. Пост-сжатый
          // estimate ниже эмитится как 'real', чтобы рендерер (real-priority
          // gate) принял его поверх устаревшего real.
          clearChatLastUsage(params.chatId)

          emitChatCompacted(win, {
            chatId: params.chatId,
            dividerMessageId: divider.id,
            removedCount: result.removedCount,
            tokensBefore,
            tokensAfter,
            trigger: 'auto',
          })
        }
      }
    }

    if (ctxSettings.tokenCounterEnabled) {
      const contextWindow = getModelContextWindow(storeData)
      const sysPrompt = await getSystemPrompt(dbChatId, params.incognito)
      const currentMsgTokens = estimateTokens(params.content)
      const snapshot = buildSnapshotFromEstimate(processedHistory, contextWindow, {
        systemPrompt: sysPrompt,
        currentMsgTokens,
        includeToolSchemas: true,
      })
      const sess = getSessionCost(params.chatId)
      // Если сжатие произошло в этом запросе — эмитим как 'real', чтобы
      // рендерер принял значение поверх устаревшего lastRealRef (до-сжатия).
      // tiktoken-оценка пост-сжатого processedHistory достаточно точна для
      // индикатора; следующий ответ модели перезапишет её честным real.
      const compactionSource: 'real' | 'estimate' = contextCompressed ? 'real' : 'estimate'
      win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
        chatId: params.chatId,
        pct: snapshot.pct,
        estimated: snapshot.estimated,
        limit: snapshot.limit,
        status: snapshot.status,
        source: compactionSource,
        compressed: contextCompressed,
        breakdown: snapshot.breakdown,
        sessionCostCents: sess?.totalCents ?? null,
        sessionRequests: sess?.requests ?? 0,
        historyMessages: history.length,
        toolCallsCount: history.reduce((sum, msg) => {
          const steps = msg.toolSteps as Array<{ type: string }> | undefined
          return sum + (steps?.filter(s => s.type === 'tool_call').length ?? 0)
        }, 0),
      })
    }

    // Request-scoped состояние этого запуска. Каждый chat:send имеет свой
    // собственный экземпляр — буферы не пересекаются между запусками.
    const run: ActiveRun = {
      worker: undefined as unknown as Worker,
      chatId: params.chatId,
      msgId: assistantMsgId,
      startedAt: Date.now(),
      bufferedText: '',
      bufferedThinking: '',
      bufferedThinkingMs: undefined,
      bufferedSteps: [],
      bufferedTodo: [],
      bufferedAgentStatus: null,
      bufferedRateLimitSec: 0,
      bufferedRetry: null,
      doneSent: false,
      sendDone: () => { /* присваивается ниже после определения sendDone */ },
      pendingTextAfter: '',
      pendingThinking: '',
      pendingThinkingMs: undefined,
      uiTokenBuf: '',
      uiThinkingBuf: '',
      uiFlushTimer: null,
      currentIterTextBefore: '',
      currentIterSteps: [],
      currentIterThinking: '',
      currentIterThinkingMs: undefined,
      closedIters: [],
      toolCallArgsCache: new Map(),
      // Результат обработки вложений (processAttachmentsAndStream) —
      // сохраняется в assistantMsg через sendDone для отображения
      // AttachmentProcessingBlock после рестарта.
      attachmentResult: null as AttachmentProcessingResult | null,
    }

    // ── UI-батчинг токенов: флеш накопленного перед любыми другими
    // событиями (step/done/thinking_done), чтобы порядок текста и шагов
    // в рендерере сохранялся. ──
    const UI_FLUSH_MS = 50
    const flushUiTokens = () => {
      if (run.uiFlushTimer) { clearTimeout(run.uiFlushTimer); run.uiFlushTimer = null }
      if (run.uiTokenBuf) {
        win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
          chatId: run.chatId, msgId: run.msgId, token: run.uiTokenBuf,
        })
        run.uiTokenBuf = ''
      }
      if (run.uiThinkingBuf) {
        win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
          chatId: run.chatId, msgId: run.msgId, thinkingToken: run.uiThinkingBuf,
        })
        run.uiThinkingBuf = ''
      }
    }
    const scheduleUiFlush = () => {
      if (run.uiFlushTimer) return
      run.uiFlushTimer = setTimeout(flushUiTokens, UI_FLUSH_MS)
    }

    const sendDone = (
      fullText: string,
      thinkingText?: string,
      thinkingMs?: number,
      steps?: unknown[],
      iters?: unknown[],
      todo?: unknown[],
      fileSnapshots?: Array<{ path: string; contentBefore: string | null }>,
      usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
    ) => {
      if (run.doneSent) return
      run.doneSent = true
      // Сначала сливаем накопленные токены — иначе хвост ответа пришёл бы
      // в renderer ПОСЛЕ done-события и потерялся бы.
      flushUiTokens()
      log('[sendDone] chatId=%s msgId=%s text=%d chars steps=%d iters=%d',
        params.chatId, assistantMsgId, fullText.length, steps?.length ?? 0, iters?.length ?? 0)
      console.log('[chat.ipc] sendDone: chatId=%s text=%d steps=%d', params.chatId, fullText.length, steps?.length ?? 0)
      // Снимаем ссылку на активный запуск этого чата — следующий chat:send
      // увидит, что слот свободен, и стартует (или дрейнит очередь).
      if (activeRuns.get(params.chatId) === run) {
        activeRuns.delete(params.chatId)
      }
      // Сбрасываем meta активного запуска — UI очереди уберёт Running-карточку.
      activeRunMeta.delete(params.chatId)

      // Planning-режим: извлекаем <plan>-блок из ответа и сохраняем в файл.
      // Тул save_plan удалён — модель пишет план прямо в ответе, обёрнутый в
      // <plan title="..." summary="...">…</plan>. Здесь парсим и пишем .md.
      let computedPlan: { title: string; content: string; summary: string; filePath: string } | undefined
      if (params.planningMode && fullText) {
        const extracted = extractFinalPlan(fullText)
        if (extracted) {
          try {
            const filePath = savePlanToFileSync(extracted)
            computedPlan = { ...extracted, filePath }
          } catch (e) {
            log('[chat.ipc] savePlanToFile упал: %s', (e as Error).message)
            computedPlan = { ...extracted, filePath: '' }
          }
        }
      }

      const todoArr = (todo as Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }> | undefined)
      // Санитизация steps перед сохранением: ensureToolResults добивает
      // синтетический tool_result для любого tool_call без парного result.
      // Без этого при error/падении воркера сохраняется битая история
      // (assistant с tool_calls без results) → следующий chat:send
      // разворачивает её через messageToContextMessages → строгий
      // провайдер (glm/litellm) возвращает 400 → чат ломается НАВСЕГДА,
      // каждый следующий запрос тоже падает. Раньше ensureToolResults
      // применялся только в buildLiveIters (для live-снапшота), но
      // sendDone при error обходил его.
      const safeSteps = steps && steps.length > 0 ? ensureToolResults(steps as unknown[]) : steps
      // Кол-во вызванных тулов в этом turn'е (число tool_call шагов).
      const toolCallsCount = Array.isArray(safeSteps)
        ? (safeSteps as Array<{ type?: string }>).filter(s => s?.type === 'tool_call').length
        : 0
      // Полная длительность ответа от старта run до завершения.
      const durationMs = Date.now() - run.startedAt
      const assistantMsg: Message & { iterations?: unknown } = {
        id: assistantMsgId,
        chatId: params.chatId,
        role: 'assistant',
        content: fullText,
        createdAt: Date.now(),
        isPinned: 0,
        model: (storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
          ?.find(a => a.role === 'main')?.modelId || 'claude-sonnet-4-6',
        toolSteps: safeSteps && safeSteps.length > 0 ? safeSteps as never : undefined,
        iterations: iters && iters.length > 0 ? iters as never : undefined,
        thinking: thinkingText || undefined,
        thinkingMs,
        planData: computedPlan,
        todo: todoArr && todoArr.length > 0 ? todoArr : undefined,
        // Результат обработки вложений — для AttachmentProcessingBlock.
        // null если вложений не было или обработка не запускалась.
        attachmentResult: run.attachmentResult ?? undefined,
        // Per-message статистика для развёртываемой панели в UI.
        durationMs,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        cacheWriteTokens: usage?.cacheWriteTokens,
        toolCallsCount: toolCallsCount > 0 ? toolCallsCount : undefined,
      }

      if (!params.incognito) saveMessage(assistantMsg)
      if (!params.incognito) {
        // Fast-path: regex-извлечение для явного «запомни X» / «меня зовут X»
        // (мгновенно, без LLM). Фаза 3 добавляет LLM-extract на idle/compaction.
        const facts = extractMemoriesFromConversation(params.content, fullText)
        facts.forEach(f => saveMemory(f))

        // Фаза 3: планируем idle-extraction через 10 минут. Сбрасывается
        // при новом chat:send. Extract делает LLM-вызов на fast-модели.
        try {
          let idleProjectId: string | undefined
          const wctx = (() => { try { return getChatWorkdirContext(params.chatId) } catch { return null } })()
          if (wctx?.workdir) {
            const found = getAllProjects().find(p => p.workdir === wctx.workdir)
            idleProjectId = found?.id
          }
          scheduleIdleExtraction(store, params.chatId, params.content, fullText, idleProjectId)

          // End-of-task триггер: если в этом turn'е НЕ было tool_calls —
          // задача завершена. Запускаем extract немедленно (без 10мин idle),
          // чтобы итоги задачи попали в память сразу. Параллельно с idle-extract
          // (который добавит факты если за 10мин будет ещё turn).
          const hadToolCalls = Array.isArray(steps) && steps.some(
            (s: unknown) => typeof s === 'object' && s !== null && (s as { type: string }).type === 'tool_call'
          )
          if (!hadToolCalls && params.content.trim().length >= 20 && !params.content.startsWith('/')) {
            extractAndSaveFacts(store, {
              chatId: params.chatId,
              userMessage: params.content,
              assistantMessage: fullText,
              projectId: idleProjectId,
            })
              .then(r => log('[chat] end-of-task extraction: chatId=%s extracted=%d', params.chatId, r.extracted))
              .catch(e => log('[chat] end-of-task extraction failed: %s', (e as Error).message))
          }
        } catch { /* ok — extract опционален */ }
      }
      if (history.length === 0 && !params.incognito) {
        autoNameChat(params.chatId, params.content, store, win)
      }

      // === Checkpoint/rewind: снимаем точку отката для этого turn'а ===
      // На каждый user prompt безусловно (даже без правок файлов) — позволяет
      // откатить чисто диалог. file_snapshots пишем только если есть правки.
      if (!params.incognito) {
        try {
          const snaps = fileSnapshots ?? []
          const filePaths = snaps.map(s => s.path)
          saveFileSnapshots(params.chatId, assistantMsgId, userMsg.id, snaps)
          saveContextSnapshot(
            params.chatId, userMsg.id,
            getWorkingMemory(params.chatId),
            getChatSummary(params.chatId),
            getMessageCount(params.chatId),
          )
          saveCheckpointMeta(params.chatId, userMsg.id, assistantMsgId, params.content, filePaths)
          // Ограничиваем историю чекпоинтов последними 100 turn'ами (как Claude Code).
          pruneOldCheckpoints(params.chatId, 100)
          // VERIFY: перечитываем из БД чтобы убедиться что checkpoint реально сохранён
          const verifyCps = getCheckpoints(params.chatId)
          log('[sendDone] checkpoint saved: chatId=%s userMsgId=%s assistantMsgId=%s filesChanged=%d — total checkpoints in DB: %d',
            params.chatId, userMsg.id, assistantMsgId, filePaths.length, verifyCps.length)
          // Уведомляем UI (правая панель "Сессия") о новом чекпоинте.
          win?.webContents.send(IPC_EVENTS.CHAT_CHECKPOINT_CREATED, { chatId: params.chatId })
        } catch (e) {
          log('[sendDone] checkpoint save failed chatId=%s: %s', params.chatId, (e as Error).message)
        }
      }

      win?.webContents.send(IPC_EVENTS.CHAT_STREAM_DONE, {
        chatId: params.chatId,
        msgId: assistantMsgId,
        // В БД выше сохранено полное сообщение; в UI — slim-копия.
        message: slimMessageForUI(assistantMsg),
      })

      // Эмитим терминальный статус для сайдбара (бейдж ✓).
      emitRunStatus(win, params.chatId, 'done', assistantMsgId)

      // Запускаем следующий запрос из очереди этого чата, если он есть.
      // drainQueue сам эмитит CHAT_QUEUE_UPDATED (очередь стала короче,
      // а следующий элемент переехал в activeRunMeta).
      drainQueue(win, params.chatId)
    }
    run.sendDone = sendDone

    const workerPath = path.join(__dirname, 'ai-worker.js')
    const mainAssignment = (storeData.modelAssignments as Array<{ role: string; modelId: string; providerId: string }> | undefined)
      ?.find(a => a.role === 'main')
    const catalogCachePath = path.join(app.getPath('userData'), 'modelsCatalog.json')
    const { workdir: chatWorkdir, verificationCommand } = (() => {
      try { return getChatWorkdirContext(dbChatId) } catch { return {} as ReturnType<typeof getChatWorkdirContext> }
    })()

    // MCP: сбор УЖЕ подключённых тулов для агента. Полностью синхронно —
    // НИКОГДА не ждём подключение сервера здесь. getActiveToolsForChat
    // возвращает только тулы серверов, которые уже в статусе 'connected'
    // (быстрая проверка Map.get), а для неподключённых просто триггерит
    // фоновое подключение (fire-and-forget) и едет дальше без задержки.
    // Раньше здесь был `await` на подключение (с таймаутами 15-35с) —
    // это блокировало резолв IPC-хендлера chat:send, а значит и появление
    // user-сообщения в UI, и возможность отменить/отправить новое — весь
    // чат выглядел зависшим на десятки секунд при каждом сообщении.
    let mcpTools: Array<{ name: string; shortName: string; description: string; inputSchema: Record<string, unknown>; serverId: string; serverName: string }> = []
    const mcpApprovalMap: Record<string, boolean> = {}
    const isIncognitoRun = !!params.incognito
    try {
      const mgr = getMcpManager()
      // projectId для scope-фильтрации MCP-серверов
      let mcpProjectId: string | undefined
      if (chatWorkdir) {
        const found = getAllProjects().find(p => p.workdir === chatWorkdir)
        mcpProjectId = found?.id
      }
      mcpTools = mgr.getActiveToolsForChat({
        projectWorkdir: chatWorkdir,
        projectId: mcpProjectId,
        isIncognito: isIncognitoRun,
      })
      // Approval map: для каждого активного тула — требует ли подтверждение.
      const configs = mgr.getAllServers({ projectWorkdir: chatWorkdir, projectId: mcpProjectId })
      for (const tool of mcpTools) {
        const config = configs.find(c => c.id === tool.serverId)
        mcpApprovalMap[tool.name] = config ? mgr.requiresApproval(config, tool.name) : true
      }
    } catch (e) {
      // MCP недоступен — работаем без него, чат не должен падать из-за этого.
      console.error('[chat:send] MCP load failed:', (e as Error).message)
    }

    // projectId для fast context indexing (tree-sitter индекс привязан к проекту)
    let fastContextProjectId: string | undefined
    if (chatWorkdir) {
      // Нормализуем через path.resolve — иначе trailing slash / регистр
      // на Windows дают path-mismatch и projectId не резолвится.
      const normWorkdir = path.resolve(chatWorkdir)
      const found = getAllProjects().find(p => path.resolve(p.workdir) === normWorkdir)
      fastContextProjectId = found?.id
    }

    // Пути для fast context (worker не имеет доступа к electron app):
    //   dbPath   — абсолютный путь к syntee.db (worker открывает своё connection, WAL safe)
    //   wasmDir  — директория с tree-sitter .wasm файлами
    const fastContextDbPath = path.join(app.getPath('userData'), 'syntee.db')
    // В dev: <project>/resources/tree-sitter, в prod: process.resourcesPath/resources/tree-sitter
    const fastContextWasmDir = resolveTreeSitterWasmDir()

    // ── Применение one-shot параметров кастомной команды ──
    // oneShotMode активирует read-only (ask) или planning-режим на этот прогон,
    // не меняя глобальные тогглы. oneShotSkill инъектирует инструкции скилла в
    // system prompt. oneShotAllowedTools фильтрует schemas до указанного списка.
    // Объявляем ДО создания Worker — workerData ниже использует эти значения.
    const effectivePlanningMode = !!params.planningMode || params.oneShotMode === 'plan'
    const effectiveAskMode = !!params.askMode
      || params.slashCommand?.name === 'ask'
      || params.oneShotMode === 'ask'

    const worker = new Worker(workerPath, {
      workerData: {
        storeData,
        planningMode: effectivePlanningMode,
        askMode: effectiveAskMode,
        workingMemory: currentWorkingMemory,
        mode: chatMode,
        catalogCachePath,
        modelId: mainAssignment?.modelId,
        providerId: mainAssignment?.providerId,
        // Свежий токен с авто-refresh: воркер не может рефрешить сам
        // (electron-store/tokenStore в worker_threads недоступны).
        gatewayToken: await getGatewayAuthToken().catch(() => getAccessToken()),
        fileCacheSnapshot: getFileCacheSnapshot(params.chatId),
        workdir: chatWorkdir,
        verificationCommand,
        projectId: fastContextProjectId,
        fastContextDbPath,
        fastContextWasmDir,
        mcpTools,
        mcpApprovalMap,
      },
      env: process.env,
    })
    run.worker = worker
    activeRuns.set(params.chatId, run)

    // Эмитим стартовый статус для сайдбара (spinner).
    emitRunStatus(win, params.chatId, 'running', assistantMsgId)

    // ── Обработка вложений (до старта воркера) ──────────────────────────────
    // Если есть attachments — обрабатываем их с прогресс-стримингом в UI:
    //  - текстовые файлы инлайним в content
    //  - картинки отправляем в vision-модель, описание инлайним в content
    // В UI это отрисовывается как AttachmentProcessingBlock (аналог FastContextBlock).
    // Заменяем params.content на augmented-версию для передачи в worker.
    // Результат сохраняем в run.attachmentResult — sendDone добавит его в
    // assistantMsg для отображения после рестарта.
    let effectiveContent = params.content
    if (params.attachments && params.attachments.length > 0) {
      try {
        const processed = await processAttachmentsAndStream(
          win, params.chatId, assistantMsgId, params.content, params.attachments,
        )
        effectiveContent = processed.content
        run.attachmentResult = processed.result
      } catch (e) {
        log('[runChatSend] processAttachments failed: %s', (e as Error).message)
        // Продолжаем с исходным content — лучше чем уронить весь запрос
      }
    }

    log('[chat:send] worker created chatId=%s msgId=%s history=%d msgs → %d contextMsgs, content=%d chars',
      params.chatId, assistantMsgId, history.length, processedHistory.length, effectiveContent.length)
    console.log('[chat.ipc] worker start: chatId=%s history=%d→%d content=%d', params.chatId, history.length, processedHistory.length, effectiveContent.length)

    worker.on('message', (msg: Record<string, unknown>) => {
      switch (msg.type) {
        // Worker поймал 401 от gateway и просит свежий JWT (сам рефрешить
        // не может — electron-store в worker недоступен). Отвечаем токеном
        // (или null, если refresh-токен тоже мёртв — worker покажет
        // «Сессия истекла»). Fire-and-forget: ответ уйдёт асинхронно.
        case 'gateway_token_refresh': {
          const replyId = msg.replyId as string
          forceRefreshGatewayToken()
            .then((token) => worker.postMessage({ replyId, token }))
            .catch(() => worker.postMessage({ replyId, token: null }))
          break
        }

        case 'token':
          run.bufferedText += (msg.token as string) || ''
          run.pendingTextAfter += (msg.token as string) || ''
          // Батчинг: IPC пачкой раз в UI_FLUSH_MS, а не на каждый токен.
          run.uiTokenBuf += (msg.token as string) || ''
          scheduleUiFlush()
          break

        case 'thinking_token': {
          const tok = typeof msg.token === 'string' ? msg.token : ''
          run.bufferedThinking += tok
          run.pendingThinking += tok
          run.uiThinkingBuf += tok
          scheduleUiFlush()
          break
        }

        case 'thinking_done':
          run.bufferedThinkingMs = msg.thinkingMs as number
          run.pendingThinkingMs = msg.thinkingMs as number
          // Сливаем накопленные thinking-токены ДО маркера завершения.
          flushUiTokens()
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId, msgId: msg.msgId,
            thinkingDone: true, thinkingMs: msg.thinkingMs,
          })
          break

        case 'step': {
          // Сливаем текст ДО шага — в renderer текст итерации должен
          // зафиксироваться раньше, чем придёт tool_call.
          flushUiTokens()
          const rawStep = msg.step as Record<string, unknown>
          // tool_call_pending — временный ранний сигнал для UI (см. Agent.ts
          // onToolCallStarted), заменяется настоящим tool_call через
          // pendingCallId матчинг на фронтенде. Не персистим в bufferedSteps —
          // иначе попал бы в БД как "фантомный" шаг (зеркало ai-worker.ts:273-280).
          if (rawStep.type !== 'tool_call_pending') {
            // Полноценный ToolStep (с id/timestamp) — раньше в bufferedSteps
            // попадал сырой step без id/timestamp, что ломало React-ключи в
            // ToolChain и было неконсистентно с ts-объектами воркера.
            const ts = {
              id: `${Date.now()}-${Math.random()}`,
              type: rawStep.type,
              toolName: rawStep.toolName,
              toolArgs: rawStep.toolArgs,
              content: rawStep.content,
              success: rawStep.success,
              timestamp: Date.now(),
              imageUrl: rawStep.imageUrl,
              diff: rawStep.diff,
              callId: rawStep.callId,
              pendingCallId: rawStep.pendingCallId,
              serverName: rawStep.serverName,
            }
            run.bufferedSteps.push(ts)
            // Реконструкция итераций (зеркало ai-worker.ts:282-330):
            // tool_call начинает новую итерацию (захватывая pendingTextAfter/
            // pendingThinking как textBefore/thinking), tool_result дописывается
            // в текущую. tool_call_pending игнорируется (как и в воркере).
            if (rawStep.type === 'tool_call') {
              if (run.pendingTextAfter.trim() || run.pendingThinking) {
                flushRunIter(run)
                run.currentIterTextBefore = run.pendingTextAfter
                run.currentIterThinking = run.pendingThinking
                run.currentIterThinkingMs = run.pendingThinkingMs
                run.pendingTextAfter = ''
                run.pendingThinking = ''
                run.pendingThinkingMs = undefined
              } else if (run.currentIterSteps.length === 0) {
                run.currentIterTextBefore = run.pendingTextAfter
                run.pendingTextAfter = ''
              }
              run.currentIterSteps.push(ts)
            } else if (rawStep.type === 'tool_result') {
              run.currentIterSteps.push(ts)
            }
          }
          // Фаза 4: логирование tool-вызовов в agent_logs для outcome-extraction.
          // tool_call — кэшируем args по callId; tool_result — пишем запись в БД
          // с args (из кэша) + result/error. Скрытые тулы (think/update_working_memory/
          // update_todo) не логируем — они не tool actions в смысле agent_outcome.
          if (!params.incognito) {
            const stepType = rawStep.type as string
            const stepToolName = rawStep.toolName as string | undefined
            const stepCallId = rawStep.callId as string | undefined
            const HIDDEN_TOOLS = new Set(['think', 'update_working_memory', 'update_todo'])
            if (stepToolName && !HIDDEN_TOOLS.has(stepToolName)) {
              if (stepType === 'tool_call' && stepCallId) {
                run.toolCallArgsCache.set(stepCallId, {
                  toolName: stepToolName,
                  args: (rawStep.toolArgs as Record<string, unknown>) ?? {},
                })
              } else if (stepType === 'tool_result' && stepCallId) {
                const cached = run.toolCallArgsCache.get(stepCallId)
                run.toolCallArgsCache.delete(stepCallId)
                try {
                  logAgentAction({
                    chatId: params.chatId,
                    type: 'tool_call',
                    tool: stepToolName,
                    args: cached?.args ?? {},
                    result: rawStep.success ? (rawStep.content as string)?.slice(0, 2000) : undefined,
                    error: !rawStep.success ? (rawStep.content as string)?.slice(0, 2000) : undefined,
                  })
                } catch (e) {
                  log('[chat:send] logAgentAction failed: %s', (e as Error).message)
                }
              }
            }
          }
          // chatId добавлен чтобы глобальный хук useChatRunSubscription мог
          // маршрутизировать шаг в нужный чат (раньше фильтрация шла по msgId
          // в локальном стейте ChatPage — не работало для параллельных чатов).
          win?.webContents.send('agent:step', { ...(msg.step as object), msgId: msg.msgId, chatId: msg.chatId })
          break
        }

        case 'confirm': {
          const { reqId, toolName, args } = msg as { reqId: string; toolName: string; args: Record<string, unknown>; dangerLevel?: string; dangerReason?: string; previewDiff?: string }
          ipcMain.once(`agent:confirm:response:${reqId}`, (_, approved: boolean) => {
            worker.postMessage({ type: 'confirm_reply', replyId: `confirm-reply-${reqId}`, approved })
          })
          win?.webContents.send('agent:confirm', {
            reqId, toolName, args,
            dangerLevel: msg.dangerLevel,
            dangerReason: msg.dangerReason,
            previewDiff: msg.previewDiff,
          })
          break
        }

        case 'question': {
          // ask_user-тул: AI задаёт уточняющие вопросы пользователю.
          // Round-trip: worker → main (здесь) → renderer (QuestionPanel) →
          // main (ipcMain.once) → worker (question_reply).
          const reqId = msg.reqId as string
          const questions = msg.questions as import('../../shared/types').QuestionSpec[]
          ipcMain.once(`agent:question:response:${reqId}`, (_e, answers: import('../../shared/types').QuestionAnswer[]) => {
            worker.postMessage({ type: 'question_reply', replyId: `question-reply-${reqId}`, answers })
          })
          win?.webContents.send('agent:question', {
            reqId, questions, chatId: msg.chatId, msgId: msg.msgId,
          })
          break
        }

        case 'agent_status':
          run.bufferedAgentStatus = msg.text as string
          win?.webContents.send('agent:status', { msgId: msg.msgId, chatId: msg.chatId, text: msg.text })
          break

        case 'todo_update':
          run.bufferedTodo = msg.items as typeof run.bufferedTodo
          win?.webContents.send('agent:todo', { msgId: msg.msgId, chatId: msg.chatId, items: msg.items })
          break

        case 'tool_progress':
          // Progress для долгих тулов (get_fast_context) — live-индикация этапов.
          // Не персистим в БД (ephemeral), только в live state renderer'а.
          win?.webContents.send('agent:tool_progress', {
            msgId: msg.msgId, chatId: msg.chatId,
            toolName: msg.toolName, stage: msg.stage, detail: msg.detail,
            filesProcessed: msg.filesProcessed, filesTotal: msg.filesTotal,
            filesFound: msg.filesFound,
          })
          break

        case 'spawn_agent': {
          ;(async () => {
            const parentSummary = getChatSummary(msg.chatId as string)
            const parentWorkingMemory = getWorkingMemory(msg.chatId as string)
            const subModeIntro = 'Сначала пойми релевантный код и ограничения, потом выполни только свою часть работы.'
            const subModeOutro = 'Финальный ответ дай кратко: что найдено или сделано, важные файлы, риски или следующий шаг.'
            const spawnResult = await agentManager.spawn({
              id: msg.id as string,
              parentId: msg.msgId as string,
              chatId: msg.chatId as string,
              task: msg.task as string,
              model: msg.model as string | undefined,
              approvalMode: msg.approval_mode as 'auto' | 'ask' | 'full' | undefined,
              isolation: msg.isolation as 'auto' | 'worktree' | 'none' | undefined,
              mode: chatMode,
              storeData,
              context: {
                systemPrompt: `Ты суб-агент. Твоя задача: ${msg.task as string}

Контекст родителя:
${parentSummary ? `${parentSummary}\n\n` : ''}${parentWorkingMemory ? `Рабочая память:\n${parentWorkingMemory}` : 'Рабочая память отсутствует.'}

${subModeIntro}
${subModeOutro}`,
                history: processedHistory.slice(-12),
                workingMemory: parentWorkingMemory,
                mode: chatMode,
                workdir: chatWorkdir,
                projectId: fastContextProjectId,
                fastContextDbPath,
                fastContextWasmDir,
              },
            })
            worker.postMessage({
              type: 'spawn_agent_reply',
              replyId: msg.replyId,
              summary: spawnResult.summary,
              error: spawnResult.error,
            })
          })()
          break
        }

        case 'shell_exec': {
          ;(async () => {
            // AI run_command → PTY-сессия. Находим agent-сессию чата или
            // создаём новую (видимую в UI). ИИ и юзер видят одну сессию.
            const chatId = msg.chatId as string
            const command = msg.command as string
            const cwd = msg.cwd as string | undefined
            const timeoutSec = (msg.timeoutSec as number | undefined) ?? 60
            const replyId = msg.replyId as string
            const shellMsgId = msg.msgId as string
            try {
              const sessions = ptyManager.listByChat(chatId)
              let agentSession = sessions.find(s => s.source === 'agent' && !s.dead)
              if (!agentSession) {
                // Дефолтный shell: PowerShell на Windows, bash на Unix.
                const defaultShell: ShellType = process.platform === 'win32' ? 'powershell' : 'bash'
                const id = ptyManager.create(chatId, defaultShell, cwd, 'agent', 'AI')
                agentSession = ptyManager.getMeta(id) ?? undefined
              }
              if (!agentSession) {
                worker.postMessage({
                  type: 'shell_exec_reply', replyId,
                  output: '[не удалось создать shell-сессию]', exitCode: 1, timedOut: false,
                })
                return
              }
              // Live-прогресс: сообщаем renderer sessionId запущенной команды,
              // чтобы ToolChain-карточка стримила pty:data внутрь себя.
              win?.webContents.send('agent:tool_progress', {
                msgId: shellMsgId, chatId,
                toolName: 'run_command', stage: 'start',
                detail: command, sessionId: agentSession.id, ts: Date.now(),
              })
              const result = await ptyManager.execInSession(agentSession.id, command, timeoutSec)
              win?.webContents.send('agent:tool_progress', {
                msgId: shellMsgId, chatId,
                toolName: 'run_command', stage: 'done', ts: Date.now(),
              })
              worker.postMessage({
                type: 'shell_exec_reply',
                replyId,
                output: result.output,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
              })
            } catch (err) {
              // spawn-failure / unexpected error — раньше IIFE reject'ился
              // молча, shell_exec_reply не отправлялся, worker Promise
              // висел вечно → агент зависал на await onShellExec.
              const errMsg = err instanceof Error ? err.message : String(err)
              win?.webContents.send('agent:tool_progress', {
                msgId: shellMsgId, chatId,
                toolName: 'run_command', stage: 'error', ts: Date.now(),
              })
              worker.postMessage({
                type: 'shell_exec_reply', replyId,
                output: `[spawn failed: ${errMsg}]`, exitCode: 1, timedOut: false,
              })
            }
          })()
          break
        }

        case 'get_agent_status': {
          const record = agentManager.get(msg.agent_id as string)
          worker.postMessage({
            type: 'get_agent_status_reply',
            replyId: msg.replyId,
            status: record ? {
              status: record.status,
              stepsCount: record.steps.length,
              currentStep: record.steps.length > 0
                ? record.steps[record.steps.length - 1].content?.slice(0, 80)
                : undefined,
            } : null,
          })
          break
        }

        case 'get_main_chat_messages': {
          ;(async () => {
            const parentChatId = params.sideChatParentId ?? (msg.chatId as string).replace(/^sidechat:/, '')
            try {
              const allMessages = getMessages(parentChatId)
              const search = (msg.search as string) || undefined
              const limit = Math.min(Math.max((msg.limit as number) ?? 15, 1), 50)

              const indexed = allMessages.map((m, i) => ({ msg: m, idx: i + 1 }))
              let filtered = indexed
              if (search) {
                const lowerSearch = search.toLowerCase()
                filtered = indexed.filter(({ msg: m }) => m.content.toLowerCase().includes(lowerSearch))
              } else {
                filtered = indexed.slice(-limit)
              }

              const formatted = filtered.map(({ msg: m, idx }) => {
                const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system'
                const date = new Date(m.createdAt).toLocaleString('ru-RU')
                const content = m.content.slice(0, 1500)
                let line = `[Сообщение #${idx}, ${role}, ${date}]\n${content}`
                if (m.content.length > 1500) line += '\n…(обрезано)'
                if (m.role === 'assistant' && m.toolSteps?.length) {
                  const tools = [...new Set(m.toolSteps.filter(s => s.type === 'tool_call').map(s => s.toolName))]
                  if (tools.length > 0) line += `\n[использовал инструменты: ${tools.join(', ')}]`
                }
                return line
              }).join('\n\n')

              worker.postMessage({
                type: 'get_main_chat_messages_reply',
                replyId: msg.replyId,
                result: formatted || 'Сообщения не найдены',
              })
            } catch (e) {
              worker.postMessage({
                type: 'get_main_chat_messages_reply',
                replyId: msg.replyId,
                result: `Ошибка: ${(e as Error).message}`,
              })
            }
          })()
          break
        }

        case 'mcp_call': {
          ;(async () => {
            try {
              const mgr = getMcpManager()
              const wctx = (() => {
                try { return getChatWorkdirContext(params.chatId) } catch { return {} as ReturnType<typeof getChatWorkdirContext> }
              })()
              const mcpWorkdir = wctx.workdir
              // projectId из БД (getChatWorkdirContext не возвращает id).
              let mcpProjectId: string | undefined
              if (mcpWorkdir) {
                const found = getAllProjects().find(p => p.workdir === mcpWorkdir)
                mcpProjectId = found?.id
              }
              const result = await mgr.callToolByName(
                msg.toolName as string,
                (msg.args as Record<string, unknown>) ?? {},
                { projectWorkdir: mcpWorkdir, projectId: mcpProjectId },
              )
              worker.postMessage({
                type: 'mcp_call_reply',
                replyId: msg.replyId,
                success: result.success,
                output: result.output,
                error: result.error,
              })
            } catch (e) {
              worker.postMessage({
                type: 'mcp_call_reply',
                replyId: msg.replyId,
                success: false,
                output: '',
                error: (e as Error).message,
              })
            }
          })()
          break
        }

        case 'list_extensions': {
          ;(async () => {
            try {
              const report = await buildExtensionsReport(params.chatId)
              worker.postMessage({
                type: 'list_extensions_reply',
                replyId: msg.replyId,
                report,
              })
            } catch (e) {
              worker.postMessage({
                type: 'list_extensions_reply',
                replyId: msg.replyId,
                report: `Ошибка получения расширений: ${(e as Error).message}`,
              })
            }
          })()
          break
        }

        case 'get_skill': {
          ;(async () => {
            try {
              const skillName = msg.skillName as string
              const wctx = (() => {
                try { return getChatWorkdirContext(params.chatId) } catch { return {} as ReturnType<typeof getChatWorkdirContext> }
              })()
              const workdir = wctx.workdir
              let skillProjectId: string | undefined
              if (workdir) {
                const found = getAllProjects().find(p => p.workdir === workdir)
                skillProjectId = found?.id
              }
              const allSkills = getSkillManager().getAllWithState({
                projectWorkdir: workdir,
                projectId: skillProjectId,
              })
              const skill = allSkills.find(s => s.name === skillName)
              if (!skill) {
                worker.postMessage({
                  type: 'get_skill_reply',
                  replyId: msg.replyId,
                  instructions: `Скилл "${skillName}" не найден. Доступные: ${allSkills.map(s => s.name).join(', ') || 'нет'}`,
                })
              } else {
                worker.postMessage({
                  type: 'get_skill_reply',
                  replyId: msg.replyId,
                  instructions: `# ${skill.name}\n${skill.description ? `Описание: ${skill.description}\n\n` : ''}${skill.instructions}`,
                })
              }
            } catch (e) {
              worker.postMessage({
                type: 'get_skill_reply',
                replyId: msg.replyId,
                instructions: `Ошибка: ${(e as Error).message}`,
              })
            }
          })()
          break
        }

        case 'rate_limit':
          run.bufferedRateLimitSec = msg.waitSec as number
          win?.webContents.send(IPC_EVENTS.RATE_LIMIT, { waitSec: msg.waitSec, chatId: params.chatId })
          break

        case 'agent_retry': {
          // Структурированный ретрай для UI-счётчика «повтор 3/5».
          // bufferedRetry хранится в live-снапшоте для гидрации при возврате
          // в чат; эвент 'agent:retry' принимается useChatRunSubscription.
          run.bufferedRetry = {
            attempt: msg.attempt as number,
            maxAttempts: msg.maxAttempts as number | undefined,
            reason: msg.reason as string,
            waitSec: msg.waitSec as number | undefined,
          }
          win?.webContents.send('agent:retry', {
            msgId: msg.msgId, chatId: msg.chatId,
            attempt: msg.attempt, maxAttempts: msg.maxAttempts,
            reason: msg.reason, waitSec: msg.waitSec,
          })
          break
        }

        case 'update_working_memory': {
          const { chatId: wChatId, content: wContent, mode: wMode } = msg as { chatId: string; content: string; mode: 'replace' | 'append' }
          try {
            if (wMode === 'append') {
              const existing = getWorkingMemory(wChatId)
              setWorkingMemory(wChatId, existing ? existing + '\n' + wContent : wContent)
            } else {
              setWorkingMemory(wChatId, wContent)
            }
          } catch { /* ok */ }
          break
        }

        case 'save_memory': {
          ;(async () => {
            try {
              const item = await saveMemoryItem({
                title: msg.title as string,
                content: msg.content as string,
                kind: msg.kind as 'user_fact' | 'project_decision' | 'convention' | 'conversation' | 'agent_outcome',
                scope: msg.scope as 'global' | 'project' | undefined,
                key: msg.key as string | undefined,
                category: msg.category as string | undefined,
                importance: msg.importance as number | undefined,
                source: 'agent_tool',
                projectId: msg.projectId as string | undefined,
                chatId: msg.chatId as string | undefined,
              })
              // Knowledge graph: heuristic extract из project_decision
              if (item.kind === 'project_decision' && item.projectId) {
                try {
                  const r = incrementalUpdateDecision(item)
                  log('[chat:send] graph decision update: nodes=%d edges=%d', r.nodes, r.edges)
                } catch (e) {
                  log('[chat:send] graph decision update failed: %s', (e as Error).message)
                }
              }
              worker.postMessage({
                type: 'save_memory_reply',
                replyId: msg.replyId,
                success: true,
                id: item.id,
              })
            } catch (e) {
              worker.postMessage({
                type: 'save_memory_reply',
                replyId: msg.replyId,
                success: false,
                error: (e as Error).message,
              })
            }
          })()
          break
        }

        case 'recall_memory': {
          ;(async () => {
            try {
              const results = await searchAllSources({
                query: msg.query as string,
                kind: msg.kind as 'user_fact' | 'project_decision' | 'convention' | 'conversation' | 'agent_outcome' | undefined,
                scope: msg.scope as 'global' | 'project' | 'all' | undefined,
                projectId: msg.projectId as string | undefined,
                limit: msg.limit as number | undefined,
                sources: msg.sources as 'all' | ('memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned')[] | undefined,
              })
              // Feedback loop: bump access_count + importance для memory_items,
              // которые попали в результаты. Часто вспоминаемые факты получают
              // boost и защищены от decayPrune (access_count > 0).
              try {
                const hitIds = results
                  .filter(r => r.source === 'memory' && r.item?.id)
                  .map(r => r.item!.id)
                if (hitIds.length > 0) {
                  const bumped = bumpMemoryHit(hitIds)
                  if (bumped > 0) log('[chat] memory feedback: bumped %d items (recall query="%s")', bumped, (msg.query as string).slice(0, 50))
                }
              } catch (e) {
                log('[chat] memory feedback bump failed: %s', (e as Error).message)
              }
              worker.postMessage({
                type: 'recall_memory_reply',
                replyId: msg.replyId,
                success: true,
                results: results.map(r => ({
                  source: r.source,
                  title: r.item?.title ?? null,
                  content: r.content,
                  score: r.score,
                  // memory-specific:
                  kind: r.item?.kind,
                  scope: r.item?.scope,
                  key: r.item?.key ?? null,
                  // chat-specific:
                  chatId: r.chatId,
                  chatTitle: r.chatTitle,
                  messageId: r.messageId,
                  role: r.role,
                  date: r.date,
                })),
              })
            } catch (e) {
              worker.postMessage({
                type: 'recall_memory_reply',
                replyId: msg.replyId,
                success: false,
                results: [],
                error: (e as Error).message,
              })
            }
          })()
          break
        }

        case 'context_usage':
          // Сохраняем последний real usage в БД — переживает перезапуск.
          // context:calculate читает его, чтобы показывать точный контекст
          // после перезахода (tiktoken-оценка без этого занижает до 12k).
          if (msg.source === 'real' && params.chatId) {
            try {
              setChatLastUsage(params.chatId, {
                promptTokens: msg.estimated,
                completionTokens: msg.breakdown?.completionTokens ?? 0,
                cacheReadTokens: msg.breakdown?.cacheReadTokens,
                cacheWriteTokens: msg.breakdown?.cacheWriteTokens,
                ts: Date.now(),
              })
            } catch { /* ok — не критично */ }
          }
          win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
            chatId: params.chatId,
            pct: msg.pct,
            estimated: msg.estimated,
            limit: msg.limit,
            status: msg.status,
            source: msg.source ?? 'estimate',
            compressed: contextCompressed,
            breakdown: msg.breakdown,
            sessionCostCents: msg.sessionCostCents ?? null,
            sessionRequests: msg.sessionRequests ?? 0,
            historyMessages: history.length,
            toolCallsCount: history.reduce((sum, m) => {
              const steps = m.toolSteps as Array<{ type: string }> | undefined
              return sum + (steps?.filter(s => s.type === 'tool_call').length ?? 0)
            }, 0),
          })
          break

        case 'done':
          if (msg.updatedProviders) {
            store.set('providers', msg.updatedProviders)
          }
          if (msg.fileCacheUpdates) {
            mergeFileCache(params.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
          }
          sendDone(
            (msg.fullText as string) || run.bufferedText,
            (msg.thinkingText as string) || run.bufferedThinking || undefined,
            (msg.thinkingMs as number) || run.bufferedThinkingMs,
            (msg.collectedSteps as unknown[]) || run.bufferedSteps,
            (msg.collectedIters as unknown[]) || undefined,
            run.bufferedTodo,
            (msg.agentSummary as { fileSnapshots?: Array<{ path: string; contentBefore: string | null }> } | undefined)?.fileSnapshots,
            {
              promptTokens: msg.promptTokens as number | undefined,
              completionTokens: msg.completionTokens as number | undefined,
              cacheReadTokens: msg.cacheReadTokens as number | undefined,
              cacheWriteTokens: msg.cacheWriteTokens as number | undefined,
            },
          )
          break

        case 'error': {
          console.log('[chat.ipc] worker ERROR: %s | fullText=%d steps=%d', msg.error, (msg.fullText as string)?.length ?? run.bufferedText.length, (msg.collectedSteps as unknown[])?.length ?? run.bufferedSteps.length)
          log('[chat.ipc] worker ERROR chatId=%s: %s | fullText=%d steps=%d',
            params.chatId, msg.error, (msg.fullText as string)?.length ?? run.bufferedText.length, (msg.collectedSteps as unknown[])?.length ?? run.bufferedSteps.length)
          // это в историю чата вместо того чтобы просто выбросить прогресс.
          if (msg.updatedProviders) {
            store.set('providers', msg.updatedProviders)
          }
          if (msg.fileCacheUpdates) {
            mergeFileCache(params.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
          }
          const errFullText = (msg.fullText as string) || run.bufferedText
          const errSteps = (msg.collectedSteps as unknown[]) || run.bufferedSteps
          if (errFullText.trim() || errSteps.length > 0) {
            sendDone(
              errFullText,
              (msg.thinkingText as string) || run.bufferedThinking,
              (msg.thinkingMs as number) || run.bufferedThinkingMs,
              errSteps,
              (msg.collectedIters as unknown[]) || undefined,
              run.bufferedTodo,
              (msg.fileSnapshots as Array<{ path: string; contentBefore: string | null }> | undefined),
              {
                promptTokens: msg.promptTokens as number | undefined,
                completionTokens: msg.completionTokens as number | undefined,
                cacheReadTokens: msg.cacheReadTokens as number | undefined,
                cacheWriteTokens: msg.cacheWriteTokens as number | undefined,
              },
            )
          } else {
            // Нет прогресса — сохраняем сообщение с текстом ошибки чтобы
            // пользователь ВИДЕЛ причину в чате, а не только тост.
            log('[chat.ipc] error без прогресса — сохраняем error-сообщение chatId=%s', params.chatId)
            const errorAssistantMsg: Message & { iterations?: unknown } = {
              id: assistantMsgId,
              chatId: params.chatId,
              role: 'assistant',
              content: `⚠ **Ошибка:** ${msg.error}`,
              createdAt: Date.now(),
              isPinned: 0,
              model: 'error',
              toolSteps: undefined,
              iterations: undefined,
              durationMs: Date.now() - run.startedAt,
            }
            if (!params.incognito) saveMessage(errorAssistantMsg)
            run.doneSent = true
            // Сливаем накопленные UI-токены (могли остаться thinking-токены).
            flushUiTokens()
            if (activeRuns.get(params.chatId) === run) activeRuns.delete(params.chatId)
            activeRunMeta.delete(params.chatId)
            win?.webContents.send(IPC_EVENTS.CHAT_STREAM_DONE, {
              chatId: params.chatId,
              msgId: assistantMsgId,
              message: errorAssistantMsg,
            })
            drainQueue(win, params.chatId)
          }
          emitRunStatus(win, params.chatId, 'error', assistantMsgId, msg.error as string)
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
            chatId: msg.chatId,
            error: msg.error,
          })
          break
        }
      }
    })

    worker.on('error', (err) => {
      console.log('[chat.ipc] Worker CRASH: %s', err.message)
      log('[Worker] CRASH chatId=%s: %s', params.chatId, err.message)
      console.error('[Worker] CRASH:', err)
      sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, buildFinalIters(run), run.bufferedTodo)
      emitRunStatus(win, params.chatId, 'error', assistantMsgId, err.message)
      win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
        chatId: params.chatId, error: err.message,
      })
    })

    worker.on('exit', () => {
      setImmediate(() => {
        console.log('[chat.ipc] Worker exit: doneSent=%s text=%d steps=%d', run.doneSent, run.bufferedText.length, run.bufferedSteps.length)
        log('[Worker] exit chatId=%s doneSent=%s text=%d steps=%d',
          params.chatId, run.doneSent, run.bufferedText.length, run.bufferedSteps.length)
        // Если воркер был остановлен кнопкой Стоп или terminated — sendDone
        // уже вызван до terminate(), doneSent=true и flush здесь будет no-op.
        // Если же воркер упал/завершился сам, не дойдя до 'done' — сохраняем
        // накопленный прогресс, чтобы не потерять его.
        if (!run.doneSent) {
          log('[Worker] exit без done — флешим накопленный прогресс chatId=%s (text=%d chars, steps=%d)',
            params.chatId, run.bufferedText.length, run.bufferedSteps.length)
          sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, buildFinalIters(run), run.bufferedTodo)
        }
      })
    })

    // ── Применение one-shot параметров кастомной команды ──
    // (effectivePlanningMode/effectiveAskMode объявлены выше, до создания Worker,
    //  т.к. workerData их использует. Здесь — только построение systemPrompt/schemas.)
    // oneShotSkill инъектирует инструкции скилла в system prompt.
    // oneShotAllowedTools фильтрует schemas до указанного списка.

    // Для side-чата строим кастомный промпт: базовый промпт родителя +
    // инструкция о доступе к основному чату через тул get_main_chat_messages.
    const sideSystemPrompt = params.sideChatParentId
      ? `Ты параллельный доп-агент в правой панели. У тебя есть read-only доступ к файловой системе (read_file, read_files, list_directory, find_files, search_code, get_fast_context) и к основному чату через тул get_main_chat_messages — используй его чтобы запросить конкретные сообщения из истории основного чата, если нужен контекст или детали диалога. Ты НЕ можешь изменять файлы или выполнять команды — только читать и искать.

Ниже — системный промпт и контекст основного чата (проект, рабочая память, сводка):

${await getSystemPrompt(dbChatId, params.incognito, params.oneShotSkill)}`
      : undefined

    let sideToolSchemas = getToolSchemas({
      planningMode: effectivePlanningMode,
      askMode: effectiveAskMode,
      imageMode: !!params.imageMode || params.slashCommand?.name === 'image',
      mode: chatMode,
      mcpTools: params.incognito ? undefined : mcpTools,
    })
    if (params.sideChatParentId) {
      // Side-чат (доп-чат) — read-only набор: только чтение файлов/поиск +
      // get_main_chat_messages. Никаких run_command/edit_file/write_file и т.д.
      // Defense-in-depth: даже если модель попытается вызвать запрещённый тул,
      // его не будет в schemas → function-calling его не пропустит.
      const SIDE_CHAT_READONLY_TOOLS = new Set([
        'read_file',
        'read_files',
        'list_directory',
        'find_files',
        'search_code',
        'get_fast_context',
        'think',
        'update_todo',
      ])
      sideToolSchemas = sideToolSchemas.filter(
        (s) => SIDE_CHAT_READONLY_TOOLS.has((s as { function: { name: string } }).function.name),
      )
      sideToolSchemas.push(GET_MAIN_CHAT_MESSAGES_SCHEMA as any)
    } else if (params.oneShotAllowedTools && params.oneShotAllowedTools.length > 0) {
      // Кастомная команда с allowed-tools — фильтруем schemas до разрешённого списка.
      // think/update_todo/update_working_memory/save_memory/recall_memory/ask_user
      // всегда доступны (управляющие тулы, не violating read-only).
      const ALLOWED_ALWAYS = new Set([
        'think', 'update_todo', 'update_working_memory',
        'save_memory', 'recall_memory', 'ask_user',
        'list_extensions', 'get_skill',
      ])
      const allowed = new Set([...params.oneShotAllowedTools, ...ALLOWED_ALWAYS])
      sideToolSchemas = sideToolSchemas.filter(
        (s) => allowed.has((s as { function: { name: string } }).function.name),
      )
    }

    worker.postMessage({
      chatId: params.chatId,
      msgId: assistantMsgId,
      // effectiveContent — с инлайн-блоками из processAttachmentsAndStream
      // (текстовые файлы + описания картинок от vision-модели).
      content: effectiveContent,
      history: processedHistory,
      systemPrompt: sideSystemPrompt ?? await getSystemPrompt(dbChatId, params.incognito, params.oneShotSkill),
      enableTools: true,
      incognito: !!params.incognito,
      agentSettings,
      slashCommandName: params.slashCommand?.name,
      modelId: mainAssignment?.modelId,
      providerId: mainAssignment?.providerId,
      toolSchemas: sideToolSchemas,
    })

    return { userMsg, assistantMsgId }
  }

  // ── Проекты (рабочие директории) ────────────────────────────────────
  // Проект = именованная привязка к папке + зафиксированный при создании
  // контекст (analyzeProject). Чаты создаются внутри проекта и наследуют
  // его workdir. Пикер папки теперь часть создания проекта, а не чата.

  ipcMain.handle('projects:pickWorkdir', async () => {
    const win = mainWindow.getWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow(), {
      properties: ['openDirectory'],
      title: 'Выберите папку проекта',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Создание НОВОЙ пустой папки для проекта. Используем showSaveDialog, чтобы
  // пользователь мог задать имя папки и выбрать родительский каталог; затем
  // физически создаём каталог через mkdirSync. Если каталог уже существует и
  // не пуст — отказываемся, чтобы не превращать «пустой проект» в скан
  // существующего содержимого.
  ipcMain.handle('projects:pickNewWorkdir', async () => {
    const win = mainWindow.getWindow()
    const result = await dialog.showSaveDialog(win ?? new BrowserWindow(), {
      title: 'Создать папку для нового проекта',
      buttonLabel: 'Создать проект',
      defaultPath: 'new-project',
      properties: ['createDirectory'],
    })
    if (result.canceled || !result.filePath) return null
    try {
      const fs = require('fs') // require: нативный import() не работает в V8-байткоде
      if (fs.existsSync(result.filePath)) {
        const entries = fs.readdirSync(result.filePath)
        if (entries.length > 0) {
          log('[projects:pickNewWorkdir] dir not empty, abort: %s', result.filePath)
          return null
        }
      } else {
        fs.mkdirSync(result.filePath, { recursive: true })
      }
    } catch (e) {
      log('[projects:pickNewWorkdir] mkdir failed: %s', (e as Error).message)
      return null
    }
    return result.filePath
  })

  ipcMain.handle('projects:create', async (_, workdir: string) => {
    // Если проект с таким workdir уже существует — createProject вернёт его
    // (UNIQUE constraint). Скан запускаем только если project_context пуст.
    const existing = getAllProjects().find(p => p.workdir === workdir)
    if (existing && existing.projectContext) {
      // Стартуем fast context watcher даже для существующего проекта
      try { startFastContextWatch(existing.id, existing.workdir) } catch { /* watcher опционален */ }
      return existing
    }
    let projectContext: string | undefined
    try {
      const scan = await analyzeProject(workdir)
      if (scan.success && scan.output) projectContext = scan.output
      else log('[projects:create] analyzeProject не удался для workdir=%s: %s', workdir, scan.error ?? 'no output')
    } catch (e) {
      log('[projects:create] analyzeProject exception для workdir=%s: %s', workdir, (e as Error).message)
    }
    const project = createProject(workdir, projectContext)
    // Стартуем fast context watcher для нового проекта
    try { startFastContextWatch(project.id, project.workdir) } catch { /* watcher опционален */ }
    return project
  })

  ipcMain.handle('projects:getAll', () => getAllProjects())
  ipcMain.handle('projects:rename', (_, id: string, name: string) => renameProject(id, name))
  ipcMain.handle('projects:delete', async (_, id: string) => {
    // Останавливаем fast context watcher перед удалением проекта
    try { await stopFastContextWatch(id) } catch { /* watcher опционален */ }
    deleteProject(id)
  })
  ipcMain.handle('projects:getById', (_, id: string) => getProjectById(id))
  ipcMain.handle('projects:touch', (_, id: string) => touchProject(id))
  ipcMain.handle('projects:setVerificationCommand', (_, id: string, command: string | null) => setProjectVerificationCommand(id, command))

  ipcMain.handle('chat:create', async (_, isIncognito = false, mode: ChatMode = 'code', projectId?: string) => {
    return createChat(isIncognito, mode, projectId)
  })

  ipcMain.handle('chat:getAll', () => getAllChats())
  // ВНИМАНИЕ: в renderer сообщения уходят ТОЛЬКО через slimMessagesForUI —
  // полные tool-пейлоады (тела файлов, diff'ы, выводы) остаются в БД для
  // AI-контекста (messageToContextMessages), UI показывает урезанную копию.
  ipcMain.handle('chat:getMessages', (_, chatId: string) => slimMessagesForUI(getMessages(chatId)))
  // Окно сообщений для пагинации (reverse-infinite scroll). Возвращает
  // { messages, hasMore } — последние `limit` сообщений либо старее курсора
  // (beforeCreatedAt, beforeId). См. db/messages.ts getMessagesPage.
  ipcMain.handle('chat:getMessagesPage', (_, chatId: string, limit?: number, beforeCreatedAt?: number, beforeId?: string) => {
    const res = getMessagesPage(chatId, limit ?? 20, beforeCreatedAt, beforeId)
    return { ...res, messages: slimMessagesForUI(res.messages) }
  })
  ipcMain.handle('chat:delete', (_, chatId: string) => {
    // Если в удаляемом чате работает воркер — убиваем его и чистим очередь.
    const run = activeRuns.get(chatId)
    if (run) {
      ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
      run.worker.terminate()
      run.doneSent = true
      activeRuns.delete(chatId)
    }
    activeRunMeta.delete(chatId)
    chatQueues.delete(chatId)
    cancelIdleExtraction(chatId)
    deleteChat(chatId)
    clearFileCache(chatId)
    agentManager.clearChat(chatId)
    ptyManager.killByChat(chatId)
    resetSessionCost(chatId)
  })
  ipcMain.handle('chat:rename', (_, chatId: string, title: string) => renameChat(chatId, title))
  ipcMain.handle('chat:pinMsg', (_, messageId: string) => pinMessage(messageId))
  ipcMain.handle('chat:unpinMsg', (_, messageId: string) => unpinMessage(messageId))

  // ── Per-chat UI state: режимы инпут-бара, черновик, история ввода ──
  // Хранятся в chats/messages, переживают перезапуск. Для инкогнито
  // рендерер не вызывает эти методы (guard в ChatPage), но на уровне IPC
  // тоже ничего не проверяем — БД-запросы идемпотентны и безопасны.
  ipcMain.handle('chat:getModes', (_, chatId: string) => getChatModes(chatId))
  ipcMain.handle('chat:setModes', (_, chatId: string, modes: { planningMode: boolean; imageMode: boolean; askMode: boolean }) => {
    setChatModes(chatId, modes)
    return true
  })
  ipcMain.handle('chat:getDraft', (_, chatId: string) => getChatDraft(chatId))
  ipcMain.handle('chat:setDraft', (_, chatId: string, draft: string) => {
    setChatDraft(chatId, draft)
    return true
  })
  ipcMain.handle('chat:getInputHistory', (_, chatId: string) => getUserMessageContents(chatId))

  // ── context:calculate — пересчёт контекста чата без отправки сообщения.
  //    Вызывается renderer-хуком useContextCounter при смене activeChatId,
  //    чтобы показатель контекста не был пустым до первого сообщения.
  //    Эмитит CONTEXT_USAGE с тем же payload, что и chat:send.
  ipcMain.handle('context:calculate', async (_, chatId: string) => {
    try {
      const win = mainWindow.getWindow()
      if (!win) return

      const storeData: Record<string, unknown> = {}
      const storeKeys = [
        'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels',
        'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'integrations',
        'voiceId', 'embeddingModel',
        'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
        'contextSettings',
      ]
      for (const k of storeKeys) {
        const v = store.get(k)
        if (v !== undefined) storeData[k] = v
      }

      const ctxSettings = getContextSettings(storeData)
      if (!ctxSettings.tokenCounterEnabled) return

      const contextWindow = getModelContextWindow(storeData)
      const sysPrompt = await getSystemPrompt(chatId)

      // Загружаем историю (как в chat:send) — для incognito-чатов она пуста.
      // Live-подмножество: сообщения после последнего divider'а (старые
      // summarized не грузятся в модель — их заменяет summary в system prompt).
      const history = getMessages(chatId)
      const liveMessages = getLiveMessages(history)
      const rawHistory: ChatMessage[] = liveMessages.flatMap(messageToContextMessages)

      // Priority 1: последний реальный usage от провайдера (переживает перезапуск).
      // tiktoken-оценка без этого занижает — не знает про tool schemas overhead,
      // reasoning токены, служебные токены провайдера. Расхождение до 12k на
      // простом диалоге. real usage — точный promptTokens от провайдера.
      //
      // STALENESS GUARD: после compaction middle-сообщения удаляются, но
      // last_usage всё ещё хранит promptTokens от ДО-сжатого запроса. Чтобы
      // не показывать устаревшее большое значение, ищем последний compact-
      // divider (system-сообщение с slashCommand.name==='compact') и
      // сравниваем его createdAt с lastUsage.ts. Если compaction произошла
      // ПОЗЖЕ последнего ответа модели — usage устарел, используем свежий
      // tiktoken-estimate и очищаем last_usage в БД (самоисцеление для чатов,
      // сжатых до ввода clearChatLastUsage при compaction).
      const lastCompactionAt = history.reduce((max, msg) => {
        if (msg.slashCommand?.name === 'compact' && msg.createdAt > max) return msg.createdAt
        return max
      }, 0)
      const lastUsage = getChatLastUsage(chatId)
      const usageStale = !!(lastUsage && lastCompactionAt > lastUsage.ts)
      if (usageStale) {
        clearChatLastUsage(chatId)
        log('[context:calculate] chatId=%s last_usage STALE (compaction at %d > usage.ts %d) — cleared, using tiktoken estimate',
          chatId, lastCompactionAt, lastUsage!.ts)
      }
      let snapshot: ReturnType<typeof buildSnapshotFromEstimate>
      let source: 'real' | 'estimate' = 'estimate'
      if (lastUsage && !usageStale) {
        // Восстанавливаем breakdown из tiktoken-оценки (пропорции System/History),
        // но estimated = реальный promptTokens. buildSnapshotFromReal с масштабированием.
        const estSnapshot = buildSnapshotFromEstimate(rawHistory, contextWindow, {
          systemPrompt: sysPrompt,
          currentMsgTokens: 0,
          includeToolSchemas: true,
        })
        snapshot = buildSnapshotFromReal(
          {
            promptTokens: lastUsage.promptTokens,
            completionTokens: lastUsage.completionTokens,
            cacheReadTokens: lastUsage.cacheReadTokens,
            cacheWriteTokens: lastUsage.cacheWriteTokens,
          },
          contextWindow,
          estSnapshot.breakdown,
        ) as ReturnType<typeof buildSnapshotFromEstimate>
        source = 'real'
        log('[context:calculate] chatId=%s using LAST_USAGE: promptTokens=%d (estHistory=%d)',
          chatId, lastUsage.promptTokens, estSnapshot.breakdown.history)
      } else {
        snapshot = buildSnapshotFromEstimate(rawHistory, contextWindow, {
          systemPrompt: sysPrompt,
          currentMsgTokens: 0, // при смене чата ввод пуст
          includeToolSchemas: true,
        })
        log('[context:calculate] chatId=%s dbMsgs=%d rawHistoryMsgs=%d historyTokens=%d systemTokens=%d estimated=%d sysPromptLen=%d (no lastUsage — tiktoken estimate)',
          chatId, history.length, rawHistory.length, snapshot.breakdown.history, snapshot.breakdown.system, snapshot.estimated, sysPrompt?.length ?? 0)
      }
      const sess = getSessionCost(chatId)

      // Метаданные для legacy-полей ContextRing (historyMessages / toolCallsCount)
      const historyMessagesCount = history.length
      const toolCallsCount = history.reduce((sum, msg) => {
        const steps = msg.toolSteps as Array<{ type: string }> | undefined
        return sum + (steps?.filter(s => s.type === 'tool_call').length ?? 0)
      }, 0)

      win.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
        chatId,
        pct: snapshot.pct,
        estimated: snapshot.estimated,
        limit: snapshot.limit,
        status: snapshot.status,
        source,
        compressed: false,
        breakdown: snapshot.breakdown,
        sessionCostCents: sess?.totalCents ?? null,
        sessionRequests: sess?.requests ?? 0,
        historyMessages: historyMessagesCount,
        toolCallsCount,
      })
    } catch (e) {
      log('[context:calculate] error chatId=%s: %s', chatId, (e as Error).message)
    }
  })

  ipcMain.handle('chat:send', async (_, params: {
    chatId: string
    content: string
    displayContent?: string
    slashCommand?: { name: string; args: string }
    incognito?: boolean
    userMsgId?: string
    planningMode?: boolean
    askMode?: boolean
    imageMode?: boolean
    mode?: ChatMode
    /** One-shot скилл для кастомных команд (типа /review → skill:code-review). */
    oneShotSkill?: { name: string; instructions: string }
    /** Ограничение тулов на прогон (для кастомных команд с allowed-tools). */
    oneShotAllowedTools?: string[]
    /** Режим для кастомной команды: 'ask' (read-only) | 'plan' | 'code'. */
    oneShotMode?: 'ask' | 'plan' | 'code'
    /** Прикреплённые файлы/изображения из @mention/drag&drop/paste/dialog.
     *  Текстовые файлы инлайним в content, картинки — путь (vision Phase 2). */
    attachments?: Attachment[]
  }) => {
    const win = mainWindow.getWindow()

    // Фаза 3: сбрасываем idle-extraction timer — пользователь снова активен.
    if (!params.incognito) cancelIdleExtraction(params.chatId)

    // Читаем режим из БД — надёжнее чем доверять клиенту (защита от рассинхрона)
    const chatMode: ChatMode = params.mode ?? (() => { try { return getChatMode(params.chatId) } catch { return 'code' } })()

    const agentSettings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings

    const attachments = params.attachments ?? []

    const userMsg: Message = {
      id: params.userMsgId ?? uuid(),
      chatId: params.chatId,
      role: 'user',
      // displayContent — то что ввёл юзер (без инлайн-блоков), сохраняется в БД.
      // effectiveContent (с инлайн-блоками) формируется в runChatSend после
      // processAttachmentsAndStream и отправляется в AI.
      content: params.displayContent ?? params.content,
      createdAt: Date.now(),
      isPinned: 0,
      slashCommand: params.slashCommand,
      attachments: attachments.length > 0 ? attachments : undefined,
    }
    const history = params.incognito ? [] : getMessages(params.chatId)
    const assistantMsgId = uuid()

    // Метаданные для UI очереди: preview первых ~80 симв. запроса.
    const previewSrc = params.displayContent ?? params.content ?? ''
    const preview = previewSrc.replace(/\s+/g, ' ').trim().slice(0, 80)
    const meta: QueueItemMeta = {
      queueId: uuid(),
      chatId: params.chatId,
      msgId: assistantMsgId,
      userMsgId: userMsg.id,
      preview,
      enqueuedAt: Date.now(),
    }

    // Если в этом чате уже работает воркер — ставим в очередь и
    // возвращаемся. Реальный запуск произойдёт после drainQueue(win, chatId).
    // Обработка вложений (processAttachmentsAndStream) тоже откладывается —
    // выполнится внутри runChatSend когда слот освободится.
    // Проверяем activeRunMeta В ДОПОЛНЕНИЕ к activeRuns: при fire-and-forget
    // запуске (ниже) activeRuns.set может задержаться (runChatSend выполняется
    // синхронно только до первого await), а activeRunMeta устанавливается
    // синхронно тут — надёжный индикатор занятости слота.
    if (activeRuns.has(params.chatId) || activeRunMeta.has(params.chatId)) {
      log('[chat:send] chatId=%s уже работает — ставим в очередь', params.chatId)
      emitRunStatus(win, params.chatId, 'queued', assistantMsgId)
      const queued: QueuedSend = {
        run: async () => { await runChatSend(params, win, chatMode, agentSettings, userMsg, history, assistantMsgId, store, mainWindow) },
        meta,
      }
      const q = chatQueues.get(params.chatId) ?? []
      q.push(queued)
      chatQueues.set(params.chatId, q)
      // Эмитим обновление очереди — UI покажет новый ожидающий запрос.
      emitQueueUpdate(win, params.chatId)
      return { userMsg, assistantMsgId, queued: true }
    }

    // Слот свободен — стартуем сразу. Запоминаем meta как активный запуск.
    activeRunMeta.set(params.chatId, { ...meta, startedAt: Date.now() })
    // Fire-and-forget: runChatSend await-ит processAttachmentsAndStream
    // (vision-модель, чтение файлов — секунды), но chat:send должен вернуть
    // результат немедленно, чтобы renderer вызвал addMessage(userMsg) +
    // initChatSend(chatId) и показал live-пузырь с прогрессом обработки
    // вложений. Без этого пользователь видит пустой чат всё время обработки.
    void runChatSend(params, win, chatMode, agentSettings, userMsg, history, assistantMsgId, store, mainWindow)
      .catch((e) => log('[chat:send] runChatSend failed chatId=%s: %s', params.chatId, (e as Error).message))
    return { userMsg, assistantMsgId }
  })

  // ── chat:sideSend — отправка сообщения в параллельный доп-чат (side chat).
  //    Side-чат эфемерный: incognito (не пишется в БД), хранится только в
  //    памяти renderer (sideChatByChat). ИИ получает сводку родителя в
  //    системном промпте + тул get_main_chat_messages для запроса сообщений.
  //    chatId = 'sidechat:'+parentChatId — разные chatId позволяют основному
  //    и доп-чату работать параллельно (activeRuns Map).
  //
  //    ВАЖНО: history очищается от toolSteps/iterations — иначе агент видит
  //    свои прошлые тул-вызовы в развёрнутом виде (tool_calls + tool_results)
  //    и начинает их повторять → зацикливание. Остаётся только role+content,
  //    как у саб-агентов (context.history = [{ role, content }]).
  ipcMain.handle('chat:sideSend', async (_, params: {
    parentChatId: string
    content: string
    sideMessages: Message[]
  }) => {
    const win = mainWindow.getWindow()
    const sideChatId = `sidechat:${params.parentChatId}`
    const chatMode: ChatMode = (() => { try { return getChatMode(params.parentChatId) } catch { return 'code' } })()
    const baseAgentSettings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings
    // Ограничиваем maxSteps как у саб-агентов — доп-чат для коротких вопросов,
    // не для долгих автономных задач. Предотвращает зацикливание.
    const agentSettings: AgentSettings = { ...baseAgentSettings, maxSteps: Math.min(baseAgentSettings.maxSteps, 12) }

    const userMsg: Message = {
      id: uuid(),
      chatId: sideChatId,
      role: 'user',
      content: params.content,
      createdAt: Date.now(),
      isPinned: 0,
    }
    // Очищаем toolSteps/iterations/todo из истории — оставляем только текст.
    // Без этого messageToContextMessages разворачивает toolSteps в полные
    // tool_calls/tool_results, агент видит свои прошлые действия и повторяет их.
    const history: Message[] = params.sideMessages.map(m => ({
      id: m.id,
      chatId: m.chatId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      isPinned: 0,
    }))
    const assistantMsgId = uuid()

    const preview = params.content.replace(/\s+/g, ' ').trim().slice(0, 80)
    const meta: QueueItemMeta = {
      queueId: uuid(),
      chatId: sideChatId,
      msgId: assistantMsgId,
      userMsgId: userMsg.id,
      preview,
      enqueuedAt: Date.now(),
    }

    const sideParams = {
      chatId: sideChatId,
      content: params.content,
      incognito: true as const,
      sideChatParentId: params.parentChatId,
    }

    if (activeRuns.has(sideChatId) || activeRunMeta.has(sideChatId)) {
      emitRunStatus(win, sideChatId, 'queued', assistantMsgId)
      const queued: QueuedSend = {
        run: async () => { await runChatSend(sideParams, win, chatMode, agentSettings, userMsg, history, assistantMsgId, store, mainWindow) },
        meta,
      }
      const q = chatQueues.get(sideChatId) ?? []
      q.push(queued)
      chatQueues.set(sideChatId, q)
      emitQueueUpdate(win, sideChatId)
      return { userMsg, assistantMsgId, queued: true }
    }

    activeRunMeta.set(sideChatId, { ...meta, startedAt: Date.now() })
    // Fire-and-forget (см. комментарий в chat:send выше).
    void runChatSend(sideParams, win, chatMode, agentSettings, userMsg, history, assistantMsgId, store, mainWindow)
      .catch((e) => log('[chat:sideSend] runChatSend failed chatId=%s: %s', sideChatId, (e as Error).message))
    return { userMsg, assistantMsgId }
  })

  // ── chat:getLiveState — снапшот накопленного прогресса активного запуска.
  //    Используется renderer-ом при смене чата, чтобы гидрировать live-пузырь
  //    (текст/шаги/thinking) из main-буферов. Без этого при возврате в чат
  //    с активным агентом пользователь видел бы пустой пузырь и только новые
  //    токены, накопленные уже после переключения.
  ipcMain.handle('chat:getLiveState', (_, chatId: string) => {
    const run = activeRuns.get(chatId)
    if (!run) return null
    return {
      chatId,
      msgId: run.msgId,
      isRunning: !run.doneSent,
      // bufferedText/bufferedThinking — текст/thinking ПОСЛЕ последнего тула
      // (не полный накопленный). Renderer гидрирует их как buf.text/buf.thinking
      // = "текст после последнего тула". Раньше возвращался полный bufferedText
      // → при первом tool_call весь текст захватывался как textBefore → дубли.
      bufferedText: run.pendingTextAfter,
      bufferedThinking: run.pendingThinking,
      bufferedThinkingMs: run.pendingThinkingMs,
      bufferedSteps: run.bufferedSteps,
      bufferedIters: buildLiveIters(run),
      bufferedTodo: run.bufferedTodo,
      bufferedAgentStatus: run.bufferedAgentStatus,
      bufferedRateLimitSec: run.bufferedRateLimitSec,
      bufferedRetry: run.bufferedRetry,
      meta: activeRunMeta.get(chatId) ?? null,
    }
  })

  // ── chat:stop — остановка активного запуска. Если передан chatId,
  //    останавливаем только этот чат (новое поведение для параллельных чатов).
  //    Если chatId не передан — backward compat: останавливаем все активные.
  ipcMain.handle('chat:stop', (_, chatId?: string) => {
    const win = mainWindow.getWindow()
    const stopRun = (run: ActiveRun) => {
      ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
      run.worker.terminate()
      // Прерываем agent PTY: Ctrl+C + очистка pending. Без этого сессия
      // остаётся в '[shell busy]' и следующий run_command зависает.
      ptyManager.interruptByChat(run.chatId)
      // Флешим накопленный прогресс — пользователь увидит частичный ответ,
      // сохранённый в историю. sendDone также сбрасывает activeRunMeta и
      // дрейнит очередь этого чата.
      run.sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, buildFinalIters(run), run.bufferedTodo)
      emitRunStatus(win, run.chatId, 'cancelled', run.msgId)
    }
    if (chatId) {
      const run = activeRuns.get(chatId)
      if (run) {
        stopRun(run)
        // activeRuns/activeRunMeta уже сброшены в sendDone; этот delete —
        // подстраховка на случай если sendDone был no-op (doneSent=true).
        activeRuns.delete(chatId)
        activeRunMeta.delete(chatId)
        emitQueueUpdate(win, chatId)
      } else {
        // Активного запуска нет — но могла быть очередь. Чистим её целиком.
        if (chatQueues.has(chatId)) {
          chatQueues.delete(chatId)
          emitQueueUpdate(win, chatId)
        }
      }
    } else {
      // Legacy: останавливаем все активные запуски
      const chatIds = new Set<string>()
      for (const [cid, run] of activeRuns) {
        chatIds.add(cid)
        stopRun(run)
      }
      activeRuns.clear()
      activeRunMeta.clear()
      chatQueues.clear()
      for (const cid of chatIds) emitQueueUpdate(win, cid)
    }
  })

  // ── chat:getQueue — снапшот очереди ожидающих запросов chatId.
  //    Возвращает массив meta (без активного запуска — он доступен через
  //    chat:getLiveState.meta). Используется UI-панелью очереди при
  //    инициализации и смене чата.
  ipcMain.handle('chat:getQueue', (_, chatId: string): QueueItemMeta[] => {
    const q = chatQueues.get(chatId) ?? []
    return q.map(item => item.meta)
  })

  // ── chat:queueRemove — убирает запрос из очереди по queueId.
  //    Сам воркер не трогается (запрос ещё не стартовал). Если удаляемый
  //    элемент был единственным — очередь очищается. Эмитит обновление.
  ipcMain.handle('chat:queueRemove', (_, chatId: string, queueId: string) => {
    const q = chatQueues.get(chatId)
    if (!q) return false
    const idx = q.findIndex(item => item.meta.queueId === queueId)
    if (idx === -1) return false
    q.splice(idx, 1)
    if (q.length === 0) chatQueues.delete(chatId)
    emitQueueUpdate(mainWindow.getWindow(), chatId)
    return true
  })

  // ── chat:queueReorder — переставляет очередь под новый порядок queueId.
  //    Элементы, не найденные в новом порядке, сохраняют свои позиции в конце.
  //    Активный запуск (если есть) не затрагивается — он не в очереди.
  ipcMain.handle('chat:queueReorder', (_, chatId: string, queueIds: string[]) => {
    const q = chatQueues.get(chatId)
    if (!q || q.length === 0) return false
    const byId = new Map(q.map(item => [item.meta.queueId, item]))
    const next: QueuedSend[] = []
    const used = new Set<string>()
    for (const id of queueIds) {
      const item = byId.get(id)
      if (item && !used.has(id)) {
        next.push(item)
        used.add(id)
      }
    }
    // Дописываем элементы, не указанные в новом порядке (сохраняя порядок).
    for (const item of q) {
      if (!used.has(item.meta.queueId)) next.push(item)
    }
    chatQueues.set(chatId, next)
    emitQueueUpdate(mainWindow.getWindow(), chatId)
    return true
  })

  ipcMain.handle('chat:reloadClient', () => {})

  ipcMain.handle('chat:archive', (_, chatId: string, archived: boolean) => {
    archiveChat(chatId, archived)
    return getAllChats()
  })

  ipcMain.handle('chat:pinChat', (_, chatId: string, pinned: boolean) => {
    pinChat(chatId, pinned)
    return getAllChats()
  })

  ipcMain.handle('chat:setColor', (_, chatId: string, color: string | null) => {
    setChatColor(chatId, color)
  })

  ipcMain.handle('chat:duplicate', (_, chatId: string) => duplicateChat(chatId))
  ipcMain.handle('chat:export', (_, chatId: string, format: 'txt' | 'md') => exportChat(chatId, format))

  // === CHECKPOINT / REWIND ===

  // Возвращает таймлайн всех чекпоинтов чата (для правой панели "Сессия").
  ipcMain.handle('chat:getSessionTimeline', (_, chatId: string) => {
    try { return getCheckpoints(chatId) } catch { return [] }
  })

  // Кол-во изменённых файлов в последнем turn'е — для badge-счётчика на иконке
  // правой панели в TitleBar.
  ipcMain.handle('chat:getLastTurnFilesChanged', (_, chatId: string) => {
    try { return getLastCheckpoint(chatId)?.filesChanged ?? 0 } catch { return 0 }
  })

  /**
   * Откат сессии к указанному user-сообщению.
   *
   * Семантика: "вернуться к состоянию ПОСЛЕ этого turn'а" — user+assistant
   * пара этого turn'а остаётся последними сообщениями, удаляется только всё
   * что было позже. Файлы откатываются к концу этого turn'а (отменяются
   * только правки последующих turn'ов). Контекст (working_memory, summary)
   * восстанавливается из snapshot'а этого turn'а.
   *
   * Возвращает обновлённый массив сообщений чата (для обновления store в
   * renderer) или { error } если откат невозможен.
   */
   ipcMain.handle('chat:rewindTo', async (_, chatId: string, userMessageId: string) => {
    // Блокировка: нельзя откатывать пока чат активен (воркер работает).
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа перед откатом.' }
    }

    try {
      // 1. Находим checkpoint для указанного user-сообщения.
      const checkpoints = getCheckpoints(chatId)
      const cp = checkpoints.find(c => c.userMessageId === userMessageId)
      log('[chat:rewindTo] chatId=%s userMsgId=%s — checkpoints total=%d, found=%s, assistantMsgId=%s, createdAt=%d',
        chatId, userMessageId, checkpoints.length, !!cp, cp?.assistantMessageId ?? 'null', cp?.createdAt ?? 0)
      if (!cp) {
        return { error: 'Чекпоинт для этого сообщения не найден (возможно, оно было до включения фичи отката).' }
      }

      // 2. Получаем file_snapshots всех turn'ов ПОСЛЕ указанного.
      const snapshots = getSnapshotsAfter(chatId, userMessageId)
      log('[chat:rewindTo] snapshots after checkpoint: %d', snapshots.length)

      // REDO: сохраняем текущее состояние файлов (contentAfter) до отката —
      // чтобы при отмене отката вернуть файлы обратно.
      const { readFileSync, existsSync: pathExistsBefore } = require('fs') // require: нативный import() не работает в V8-байткоде
      const fileChangesForRedo: Array<{ path: string; contentAfter: string | null }> = []
      const seenPaths = new Set<string>()
      for (const snap of snapshots) {
        if (seenPaths.has(snap.path)) continue
        seenPaths.add(snap.path)
        try {
          if (pathExistsBefore(snap.path)) {
            fileChangesForRedo.push({ path: snap.path, contentAfter: readFileSync(snap.path, 'utf-8') })
          } else {
            fileChangesForRedo.push({ path: snap.path, contentAfter: null })
          }
        } catch {
          fileChangesForRedo.push({ path: snap.path, contentAfter: null })
        }
      }

      // 3. Восстанавливаем файлы в обратном порядке (последняя правка первой).
      //    contentBefore = null → файл был создан later-turn'ом → удаляем.
      //    Иначе → перезаписываем contentBefore.
      const { writeFileSync, unlinkSync, existsSync: pathExists } = require('fs') // require: нативный import() не работает в V8-байткоде
      const restoredFiles: string[] = []
      const failedFiles: string[] = []
      for (const snap of snapshots) {
        try {
          if (snap.contentBefore === null) {
            // Файл был создан последующим turn'ом — удаляем.
            if (pathExists(snap.path)) {
              unlinkSync(snap.path)
              restoredFiles.push(`удалён: ${snap.path}`)
            }
          } else {
            // Перезаписываем содержимое до правки последующего turn'а.
            const { dirname } = require('path') // require: нативный import() не работает в V8-байткоде
            const { mkdirSync } = require('fs')
            try { mkdirSync(dirname(snap.path), { recursive: true }) } catch { /* ok */ }
            writeFileSync(snap.path, snap.contentBefore, 'utf-8')
            restoredFiles.push(`восстановлен: ${snap.path}`)
          }
        } catch (e) {
          failedFiles.push(`${snap.path}: ${(e as Error).message}`)
        }
      }

      // 4. Восстанавливаем контекст (working_memory + chat_summary) из
      //    snapshot'а этого turn'а (post-turn состояние).
      const ctxSnap = getContextSnapshot(chatId, userMessageId)
      if (ctxSnap) {
        if (ctxSnap.workingMemory !== null) setWorkingMemory(chatId, ctxSnap.workingMemory)
        if (ctxSnap.chatSummary !== null) setChatSummary(chatId, ctxSnap.chatSummary)
      }

      // 5. Удаляем сообщения после этого turn'а.
      //    Порог — createdAt assistant-сообщения этого turn'а (если найдено),
      //    иначе createdAt самого checkpoint'а (чуть позже, но до следующего turn'а).
      let deleteThreshold = cp.createdAt
      let allMsgsBeforeDelete: Message[] = []
      if (cp.assistantMessageId) {
        allMsgsBeforeDelete = getMessages(chatId)
        const assistantMsg = allMsgsBeforeDelete.find(m => m.id === cp.assistantMessageId)
        if (assistantMsg) {
          deleteThreshold = assistantMsg.createdAt
          log('[chat:rewindTo] found assistant msg: id=%s createdAt=%d', assistantMsg.id, assistantMsg.createdAt)
        } else {
          log('[chat:rewindTo] assistant msg NOT FOUND in getMessages — using checkpoint createdAt=%d as threshold', cp.createdAt)
        }
      } else {
        allMsgsBeforeDelete = getMessages(chatId)
        log('[chat:rewindTo] assistantMessageId is null — using checkpoint createdAt=%d as threshold', cp.createdAt)
      }

      // REDO: сохраняем сообщения которые будут удалены (до удаления).
      const msgsToDeleteForRedo = allMsgsBeforeDelete.filter(m => m.createdAt > deleteThreshold)

      const msgsBeforeDelete = getMessageCount(chatId)
      const deletedMessages = deleteMessagesAfter(chatId, deleteThreshold)
      log('[chat:rewindTo] messages before=%d, deleted=%d (threshold=%d)', msgsBeforeDelete, deletedMessages, deleteThreshold)

      // 6. Удаляем чекпоинты и снапшоты последующих turn'ов (они больше не валидны).
      deleteCheckpointsAfter(chatId, userMessageId)

      // 7. Вставляем синтетическое system-сообщение об откате.
      const rewindMsg: Message = {
        id: uuid(),
        chatId,
        role: 'system',
        content: `[ОТКАТ к сообщению от ${new Date(cp.createdAt).toLocaleString('ru')}]\n` +
          `Восстановлено файлов: ${restoredFiles.length}` +
          (failedFiles.length > 0 ? `, не удалось: ${failedFiles.length}` : '') + '\n' +
          `Удалено сообщений: ${deletedMessages}\n` +
          (restoredFiles.length > 0 ? `Файлы:\n${restoredFiles.join('\n')}` : 'Файлы не изменялись.') +
          (failedFiles.length > 0 ? `\nОшибки восстановления:\n${failedFiles.join('\n')}` : ''),
        createdAt: Date.now(),
        isPinned: 0,
        slashCommand: { name: 'rewind', args: userMessageId },
      }
      saveMessage(rewindMsg)

      // REDO: сохраняем redo-точку — можно отменить откат.
      try {
        saveRewindHistory(chatId, rewindMsg.id, msgsToDeleteForRedo, fileChangesForRedo, userMessageId)
        log('[chat:rewindTo] redo history saved: rewindMsgId=%s, msgsToRestore=%d, filesToRestore=%d',
          rewindMsg.id, msgsToDeleteForRedo.length, fileChangesForRedo.length)
      } catch (e) {
        log('[chat:rewindTo] redo history save FAILED: %s', (e as Error).message)
      }

      // 8. Уведомляем UI об откате.
      const rewindWin = mainWindow.getWindow()
      rewindWin?.webContents.send(IPC_EVENTS.CHAT_REWOUND, { chatId, userMessageId, rewindMessageId: rewindMsg.id })

      log('[chat:rewindTo] chatId=%s userMsgId=%s: restored %d files, deleted %d messages',
        chatId, userMessageId, restoredFiles.length, deletedMessages)

      // 9. Возвращаем обновлённые сообщения для renderer (slim-копии).
      return { messages: slimMessagesForUI(getMessages(chatId)) }
    } catch (e) {
      log('[chat:rewindTo] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка отката: ${(e as Error).message}` }
    }
  })

  /**
   * Проверяет, доступна ли отмена отката для данного system-сообщения.
   * Возвращает true если в rewind_history есть запись с этим rewindMessageId.
   */
  ipcMain.handle('chat:canRedo', (_, chatId: string, rewindMessageId: string) => {
    try {
      return getRewindHistory(chatId, rewindMessageId) !== null
    } catch {
      return false
    }
  })

  /**
   * Отмена отката (redo) — возвращает сообщения и файлы, удалённые при rewind.
   * Принимает id system-сообщения отката (rewindMessageId) — по нему находим
   * redo-точку в rewind_history.
   */
  ipcMain.handle('chat:redo', async (_, chatId: string, rewindMessageId: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }

    try {
      const entry = getRewindHistory(chatId, rewindMessageId)
      if (!entry) {
        return { error: 'Точка отката не найдена — возможно, она уже отменена или устарела.' }
      }

      log('[chat:redo] chatId=%s rewindMsgId=%s — msgsToRestore=%d, filesToRestore=%d',
        chatId, rewindMessageId, entry.deletedMessages.length, entry.fileChanges.length)

      // 1. Восстанавливаем файлы — пишем contentAfter (состояние до отката).
      const { writeFileSync, unlinkSync, existsSync: pathExists, mkdirSync } = require('fs') // require: нативный import() не работает в V8-байткоде
      const { dirname } = require('path')
      const restoredFiles: string[] = []
      const failedFiles: string[] = []
      for (const fc of entry.fileChanges) {
        try {
          if (fc.contentAfter === null) {
            // Файла не было до отката (был создан, потом удалён при rewind) → удаляем.
            if (pathExists(fc.path)) {
              unlinkSync(fc.path)
              restoredFiles.push(`удалён: ${fc.path}`)
            }
          } else {
            // Возвращаем содержимое которое было до отката.
            try { mkdirSync(dirname(fc.path), { recursive: true }) } catch { /* ok */ }
            writeFileSync(fc.path, fc.contentAfter, 'utf-8')
            restoredFiles.push(`восстановлен: ${fc.path}`)
          }
        } catch (e) {
          failedFiles.push(`${fc.path}: ${(e as Error).message}`)
        }
      }

      // 2. Удаляем system-сообщение об откате (оно больше не актуально).
      deleteMessageById(rewindMessageId)

      // 3. Восстанавливаем удалённые сообщения.
      for (const msg of entry.deletedMessages) {
        try { saveMessage(msg) } catch { /* может существовать — ok */ }
      }

      // 4. Удаляем redo-точку (одноразовая).
      deleteRewindHistory(chatId, rewindMessageId)

      // 5. Уведомляем UI.
      const redoWin = mainWindow.getWindow()
      redoWin?.webContents.send(IPC_EVENTS.CHAT_REWOUND, { chatId, userMessageId: entry.restoredCheckpointUserMsgId, isRedo: true })

      log('[chat:redo] done: restored %d files, %d messages', restoredFiles.length, entry.deletedMessages.length)

      return { messages: slimMessagesForUI(getMessages(chatId)) }
    } catch (e) {
      log('[chat:redo] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка отмены отката: ${(e as Error).message}` }
    }
  })

  /**
   * chat:compact — ручное сжатие контекста чата через slash-команду /compact.
   *
   * Делает то же, что и авто-компакция внутри chat:send, но с
   * forceCompress=true (срабатывает даже когда порог токенов не достигнут),
   * и сохраняет видимый system-разделитель «Контекст сжат» в ленте чата
   * (аналогично rewind-сообщению). Возвращает обновлённый массив сообщений
   * и краткую статистику для toast'а в renderer.
   *
   * Блокируется как rewind, если чат активен (воркер работает) —
   * компакция гоняет LLM-запрос через summaryFn и не должна проходить
   * параллельно с другим ходом.
   */
  ipcMain.handle('chat:compact', async (event, chatId: string) => {
    // Sidechat-чаты (incognito, префикс 'sidechat:') — эфемерны:
    // история не в БД, summary не сохраняется — компакция бессмысленна.
    if (chatId.startsWith('sidechat:')) {
      return { error: 'Компакция недоступна для параллельного side-чата.' }
    }
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа перед сжатием.' }
    }

    try {
      const storeData: Record<string, unknown> = {}
      const storeKeys = [
        'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels',
        'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'integrations',
        'voiceId', 'embeddingModel',
        'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
        'contextSettings',
      ]
      for (const k of storeKeys) {
        const v = store.get(k)
        if (v !== undefined) storeData[k] = v
      }
      const ctxSettings = getContextSettings(storeData)

      const history = getMessages(chatId)
      // Live-подмножество: сообщения после последнего divider'а (как в chat:send).
      // messageId тегируется для вычисления boundary divider'а.
      const liveMessages = getLiveMessages(history)
      const rawHistory: ChatMessage[] = liveMessages.flatMap(m =>
        messageToContextMessages(m).map(cm => ({ ...cm, messageId: m.id })),
      )
      if (rawHistory.length === 0) {
        return { error: 'Чат пуст — нечего сжимать.' }
      }

      let storedSummary = ''
      try { storedSummary = getChatSummary(chatId) } catch { /* ok */ }

      const realContextWindow = getModelContextWindow(storeData)
      const rollingSettings = { ...ctxSettings, contextLimitTokens: realContextWindow }

      const summaryFn = async (prompt: string): Promise<string> => {
        const aiClient = new AIClient(store)
        let result = ''
        // Сигнал рендереру: начало стрима резюме (сброс накопленного текста
        // в compacting-индикаторе). Только manual /compact — авто-компакция
        // идёт перед AI-ответом, индикатора нет, стримить бессмысленно.
        const sender = event.sender
        if (!sender.isDestroyed()) {
          sender.send(IPC_EVENTS.CHAT_COMPACT_STREAM, { chatId, start: true })
        }
        await aiClient.streamChat(
          [{ role: 'user', content: prompt }],
          {
            onToken: (t) => {
              result += t
              if (!sender.isDestroyed()) {
                sender.send(IPC_EVENTS.CHAT_COMPACT_STREAM, { chatId, chunk: t })
              }
            },
            onDone: () => {},
            onError: () => {},
          },
          'fast',
        )
        return result
      }

      // forceCompress=true — форсируем сжатие даже если порог токенов
      // не достигнут (пользователь явно попросил /compact). applyRollingWindowAsync
      // адаптирует keepLast/keepFirst для коротких историй, чтобы middle
      // был непустым. Если совсем нечего сжимать (1-2 сообщения) —
      // вернёт compressed=false → сообщим пользователю.
      const tokensBefore = estimateMessagesTokens(rawHistory)
      const result = await applyRollingWindowAsync(rawHistory, rollingSettings, summaryFn, storedSummary || undefined, true)
      if (!result.compressed) {
        return { error: 'Недостаточно сообщений для сжатия (нужно больше 2).' }
      }

      const tokensAfter = estimateMessagesTokens(result.messages)

      // Пишем summary в chat_summaries (перезаписывает старое, как при
      // авто-компакции). Это нужно для будущего system prompt AI.
      if (result.summaryContent) {
        setChatSummary(chatId, result.summaryContent)

        // Фаза 3: compaction-триггер памяти — sync summary → memory_items
        // (episodic). Fire-and-forget — не блокируем /compact.
        ;(async () => {
          try {
            let compactionProjectId: string | undefined
            const wctx = (() => { try { return getChatWorkdirContext(chatId) } catch { return null } })()
            if (wctx?.workdir) {
              const found = getAllProjects().find(p => p.workdir === wctx.workdir)
              compactionProjectId = found?.id
            }
            await onCompactionTrigger(store, {
              chatId,
              summary: result.summaryContent,
              projectId: compactionProjectId,
            })
          } catch (e) {
            log('[chat:compact] memory extraction failed: %s', (e as Error).message)
          }
        })()
      }

      // Видимый разделитель «Контекст сжат» — в КОНЦЕ ленты (createdAt = now),
      // не в середине. getLiveMessages следующего chat:send найдёт divider как
      // последний compaction-маркер и вернёт сообщения с createdAt > divider'а
      // (новые сообщения, отправленные после сжатия) + summary в system prompt.
      // Контекст реально сжимается: AI видит только summary + новые сообщения.
      const divider = createCompactDivider(chatId, {
        removedCount: result.removedCount,
        tokensBefore,
        tokensAfter,
        summaryContent: result.summaryContent ?? '',
        createdAt: Date.now(),
      })
      saveMessage(divider)

      // Сообщения НЕ удаляем из БД. AI-контекст ограничен live-подмножеством
      // (после divider'а) + summary в system prompt.
      log('[chat:compact] chatId=%s: removed=%d ChatMessage, tokens %d→%d (saved %d)',
        chatId, result.removedCount, tokensBefore, tokensAfter, tokensBefore - tokensAfter)

      // Сброс last_usage — иначе context:calculate пересоберёт real-снапшот
      // из устаревшего promptTokens (до-сжатия), и индикатор контекста
      // покажет старое значение. Эмитим пост-сжатый estimate как 'real'.
      clearChatLastUsage(chatId)
      if (ctxSettings.tokenCounterEnabled) {
        try {
          const contextWindow = realContextWindow
          const sysPrompt = await getSystemPrompt(chatId)
          const snapshot = buildSnapshotFromEstimate(result.messages, contextWindow, {
            systemPrompt: sysPrompt,
            currentMsgTokens: 0,
            includeToolSchemas: true,
          })
          const sess = getSessionCost(chatId)
          const win = mainWindow.getWindow()
          win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
            chatId,
            pct: snapshot.pct,
            estimated: snapshot.estimated,
            limit: snapshot.limit,
            status: snapshot.status,
            source: 'real',
            compressed: true,
            breakdown: snapshot.breakdown,
            sessionCostCents: sess?.totalCents ?? null,
            sessionRequests: sess?.requests ?? 0,
            historyMessages: liveMessages.length,
            toolCallsCount: history.reduce((sum, msg) => {
              const steps = msg.toolSteps as Array<{ type: string }> | undefined
              return sum + (steps?.filter(s => s.type === 'tool_call').length ?? 0)
            }, 0),
          })
        } catch (e) {
          log('[chat:compact] post-compact CONTEXT_USAGE emit failed: %s', (e as Error).message)
        }
      }

      const win = mainWindow.getWindow()
      emitChatCompacted(win, {
        chatId,
        dividerMessageId: divider.id,
        removedCount: result.removedCount,
        tokensBefore,
        tokensAfter,
        trigger: 'manual',
      })

      return {
        messages: slimMessagesForUI(getMessages(chatId)),
        stats: {
          removedCount: result.removedCount,
          tokensBefore,
          tokensAfter,
          tokensSaved: Math.max(0, tokensBefore - tokensAfter),
          dividerMessageId: divider.id,
        },
      }
    } catch (e) {
      log('[chat:compact] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка сжатия контекста: ${(e as Error).message}` }
    }
  })

  // === /fork — дублировать чат с этого места ==================================
  //
  // Создаёт новый чат, копируя ВСЁ содержимое текущего: сообщения, working
  // memory, summary, project_id, workdir, mode. Пользователь получает точную
  // копию чата на текущий момент и может идти в другом направлении ("what-if"
  // эксперименты без потери оригинала).
  //
  // Возвращает { chatId, messages } нового чата (или { error }).
  ipcMain.handle('chat:fork', async (_, sourceChatId: string, title?: string) => {
    try {
      const sourceMessages = getMessages(sourceChatId)
      if (sourceMessages.length === 0) {
        return { error: 'Исходный чат пуст — нечего форкать.' }
      }

      // Читаем метаданные исходного чата
      const sourceChat = getAllChats().find(c => c.id === sourceChatId)
      if (!sourceChat) {
        return { error: 'Исходный чат не найден.' }
      }

      // Создаём новый чат с теми же параметрами (не инкогнито, тот же режим/проект)
      const forkedChat = createChat(false, sourceChat.mode, sourceChat.projectId)
      const forkedChatId = forkedChat.id
      const forkTitle = (title && title.trim()) || `${sourceChat.title} (fork)`
      renameChat(forkedChatId, forkTitle)

      // Копируем сообщения. saveMessage проставит новый chatId — но чтобы
      // сохранить порядок и структуру, копируем как есть с новыми id.
      // createdAt сохраняем оригинальные — порядок в БД (ORDER BY created_at)
      // остаётся тем же. toolSteps/iterations/thinking/todo/slashCommand тоже
      // копируем (serialized через JSON в saveMessage).
      for (const msg of sourceMessages) {
        const newMsg: Message = {
          ...msg,
          id: uuid(), // новый id, чтобы не было PK-конфликта
          chatId: forkedChatId,
        }
        saveMessage(newMsg)
      }

      // Копируем working memory и summary
      try {
        const wm = getWorkingMemory(sourceChatId)
        if (wm) setWorkingMemory(forkedChatId, wm)
      } catch { /* ok */ }
      try {
        const summary = getChatSummary(sourceChatId)
        if (summary) setChatSummary(forkedChatId, summary)
      } catch { /* ok */ }

      log('[chat:fork] source=%s → forked=%s, messages=%d, title=%s',
        sourceChatId, forkedChatId, sourceMessages.length, forkTitle)

      return {
        chatId: forkedChatId,
        messages: slimMessagesForUI(getMessages(forkedChatId)),
        title: forkTitle,
      }
    } catch (e) {
      log('[chat:fork] error source=%s: %s', sourceChatId, (e as Error).message)
      return { error: `Ошибка форка: ${(e as Error).message}` }
    }
  })

  // === /snapshot <name> — именованный снапшот =================================
  //
  // Создаёт именованную точку отката на основе последнего чекпоинта чата.
  // Именованные снапшоты восстанавливаются через /restore <name> или /restore
  // (с пикером). В отличие от обычных auto-checkpoint'ов на каждый turn,
  // именованные явно создаются пользователем и имеют осмысленное имя.
  //
  // Возвращает { snapshot } (с id, name, createdAt) или { error }.
  ipcMain.handle('chat:snapshot:create', (_, chatId: string, name: string) => {
    try {
      if (activeRuns.has(chatId)) {
        return { error: 'Чат активен — дождитесь завершения ответа перед снапшотом.' }
      }
      const cleanName = (name || '').trim()
      if (!cleanName) {
        return { error: 'Укажите имя снапшота: /snapshot my-feature' }
      }
      if (cleanName.length > 80) {
        return { error: 'Имя снапшота слишком длинное (макс. 80 символов).' }
      }
      const snap = saveNamedSnapshot(chatId, cleanName)
      if (!snap) {
        return { error: 'В чате ещё нет точек отката — отправьте хотя бы одно сообщение перед снапшотом.' }
      }
      log('[chat:snapshot:create] chatId=%s name=%s id=%s', chatId, cleanName, snap.id)
      return { snapshot: snap }
    } catch (e) {
      log('[chat:snapshot:create] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка создания снапшота: ${(e as Error).message}` }
    }
  })

  // === /restore — список именованных снапшотов для пикера ====================
  //
  // Возвращает массив именованных снапшотов чата (новые первыми) для UI-пикера.
  // Само восстановление идёт через существующий chat:rewindTo (по userMessageId).
  ipcMain.handle('chat:snapshot:list', (_, chatId: string) => {
    try {
      return getNamedSnapshots(chatId)
    } catch (e) {
      log('[chat:snapshot:list] error chatId=%s: %s', chatId, (e as Error).message)
      return []
    }
  })
}

async function autoNameChat(chatId: string, firstMessage: string, store: Store, win?: BrowserWindow | null): Promise<void> {
  try {
    const client = new AIClient(store)
    const title = await client.complete(
      [{ role: 'user', content: `Придумай короткое название (3-5 слов) для чата, который начинается с этого сообщения: "${firstMessage.slice(0, 200)}". Ответь только названием без кавычек и лишних слов.` }],
      'fast',
    )
    const clean = title.trim().slice(0, 60)
    if (clean) {
      renameChat(chatId, clean)
      win?.webContents.send('chat:renamed', { chatId, title: clean })
    }
  } catch {
    // not critical
  }
}
