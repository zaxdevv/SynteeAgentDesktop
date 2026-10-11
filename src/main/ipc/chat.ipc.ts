import { ipcMain, BrowserWindow, app } from 'electron'
import { Worker } from 'worker_threads'
import { attachBrowserWorkerBroker, disposeBrowserWorkerBroker } from '../../core/agent/browserWorkerBroker'
import * as path from 'path'
import type Store from 'electron-store'
import { agentManager } from '../managers/AgentManager'
import { assertContextChat, getContextPreferences, setContextPreferences, filterContextHistory, setContextMessageHidden, setContextMessagePinned } from '../../core/db/contextControls'
import { invalidateHistoryCache } from './historyCache'
import type { ContextInspection, ContextPreferences } from '../../shared/types/contextControls'
import { getSubagentRole } from '../../shared/subagent-roles'
import {
  createChat, getAllChats, getMessages, getMessagesPage, saveMessage,
  deleteChat, renameChat, pinMessage, unpinMessage, initDB, getDB,
  archiveChat, pinChat, setChatColor, duplicateChat, exportChat,
  DEFAULT_CHAT_TITLE,
  getWorkingMemory, setWorkingMemory, getChatSummary, setChatSummary,
  getChatMode, getChatWorkdirContext,
  getChatModel, setChatModel,
  getChatReasoning, setChatReasoning,
  getChatModes, setChatModes, setChatPlanningMode, setChatImageMode, setChatAskMode,
  getChatBrowserMode,
  getChatPersona, setChatPersona,
  getChatDraft, setChatDraft, getUserMessageContents,
  setChatLastUsage, getChatLastUsage, clearChatLastUsage,
  getAllProjects,
  getProjectById,
  saveFileSnapshots, saveContextSnapshot, saveCheckpointMeta, getMessageCount,
  getCheckpoints, pruneOldCheckpoints, deleteMessageById, editMessageContent, setMessageHidden,
  saveStreamingBuffer, deleteStreamingBuffer,
  logAgentAction,
  getDotByChatId,
  getTaskSummaryState, updateTaskSummaryState, addTaskSummaryPin, removeTaskSummaryPin, getMessageById,
  getChatGoal, setChatGoal,
  createTaskSummary, upsertTaskSummary, recoverInterruptedTaskSummaries,
} from '../../core/db'
import { extractMemoriesFromConversation, saveMemory } from '../../core/memory/MemoryEngine'
import { saveMemoryItem, buildCuratedSummary, getMemoryStatsForProject, bumpMemoryHit, searchAllSources } from '../../core/memory/MemoryStore'
import { getGlobalMemoryEnabled, getMemorySettings } from '../../core/memory/globalMemorySettings'
import { listNotes, createNote, updateNote, deleteNote, getProjectNotesInfo } from '../../core/db/notes'

import { onCompactionTrigger } from '../../core/memory/extractor'
import { setGlobalMemorySettingsStore } from '../../core/memory/globalMemorySettings'
import { incrementalUpdateDecision, incrementalUpdateConversation, buildProjectGraph } from '../../core/memory/graphBuilder'
import { getGraphStats } from '../../core/memory/graphStore'
import { buildSystemPrompt, SYSTEM_PROMPT_CACHE_BREAK } from '../../core/prompts/buildSystemPrompt'
import type { ProtectedVarPromptInfo } from '../../core/prompts/buildSystemPrompt'
import { secretPlaceholder } from '../../core/prompts/sections/secretsSection'
import { resolveActive } from '../services/protectedVarsStore'
import { readProjectContextFiles } from '../../core/prompts/projectInstructions'
import { AIClient } from '../../core/ai/AIClient'
import { modelSupportsVisionByHeuristic } from '../../core/ai/visionSupport'
import { getAccessToken } from '../services/tokenStore'
import { getGatewayAuthToken, forceRefreshGatewayToken } from '../services/gatewayClient'
import { getToolSchemas, GET_MAIN_CHAT_MESSAGES_SCHEMA, savePlanToFileSync } from '../../core/tools'
import { extractFinalPlan, stripPlanTags } from '../../shared/planParser'
import { stripAttachTokens } from '../../shared/attachmentMarkdown'
import { getToolSettings, isToolDisabled } from '../../shared/toolSettings'
import { mimeFromExt } from '../../shared/mentions'
import { IPC_EVENTS } from '../../shared/constants'
import type { Dot, DotConfig } from '../../shared/types'
import { getNotificationManager } from '../managers/NotificationManager'
import { persistApprovalGrant } from '../services/approvalAllowlist'
import { getActivityManager } from '../managers/ActivityManager'

import { v4 as uuid } from 'uuid'
import {
  applyRollingWindowAsync, getContextSettings, estimateTokens, estimateMessagesTokens,
  getModelContextWindow,
  type ChatMessage,
} from '../../core/context/contextManager'
import { buildSnapshotFromEstimate, buildSnapshotFromReal, getSessionCost, resetSessionCost } from '../../core/tokens/usageTracker'
import { getGatewayModelsCache } from '../../core/tokens/gatewayModelsCache'
import { getFileCacheSnapshot, mergeFileCache, clearFileCache } from '../../core/context/fileReadCache'
import { setFastContextPaths, registerProjectWorkdir } from '../../core/context/fastContextWatcher'
import { initFastContextDb, initFastContextWasmDir } from '../../core/context/fastContext'
import { existsSync } from 'fs'
import { ptyManager } from '../managers/PtyManager'
import { log } from '../../core/logger'
import { perfMark, perfEvent, perfPhase, perfPhaseAsync } from '../../core/performanceDiagnostics'
import { getSkillManager } from '../../core/skills/skillManager'
import { getSkillInstructions } from '../../core/skills/skillInstructions'
import { getMcpManager } from '../../core/mcp/McpManager'
import { getPluginManager } from '../../core/plugins/pluginManager'
import type { Message, AgentSettings, ChatMode, QueueItemMeta, Attachment, AttachmentProcessingResult, ReplyTarget } from '../../shared/types'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/types'
import { messageToContextMessages, formatReplyQuote } from './chatContextHelpers'
import { slimMessageForUI, slimMessagesForUI } from './slimMessages'
import { getMessagesCached, getMessagesAfterLatestCompactCached, recoverStreamingBuffersForChat } from './historyCache'
import {
  confirmCallbacks, questionCallbacks,
  activeRuns, lastActiveChatId, setLastActiveChatId, compactRuns, activeRunMeta,
  chatQueues, autoRecallInjectedKeys, scheduleIdleExtraction, cancelIdleExtraction, emitRunStatus, getChatTitleForNotif, runStatusListeners,
  type ActiveRun, type QueuedSend,
} from './chatShared'
import { registerProjectsIPC } from './projects.ipc'
import { registerCheckpointIPC } from './chatCheckpoint.ipc'
import { registerForkIPC } from './chatFork.ipc'
import { cleanupOrphanDraftFiles } from './mentions.ipc'
import { executeManageChats, initializeDelegatedChats, requestState } from '../services/delegatedChats'
import { getDelegatedRequest, listDelegatedRequests, listDelegatedChatCreations, ownsDelegatedChat, getDelegationChat } from '../../core/db/delegatedChats'
import { classifyDiagnosticOutcome, isExplicitTaskContinuation, isVerificationCommand } from '../../shared/types/taskSummary'
import type { TaskSummary, TaskSummaryParticipant } from '../../shared/types/taskSummary'

// Installed by registerChatIPC; all events must include authoritative participants.
let broadcastTaskSummary: ((chatId: string, state: ReturnType<typeof getTaskSummaryState>) => void) | undefined
let refreshDelegationSummary: ((chatId: string, requestId: string) => void) | undefined

// ── Pending attachment paths ─────────────────────────────────────────────────
// Пути вложений отправок, чьи user-сообщения ещё НЕ сохранены в БД:
// - текущая отправка (runChatSend сохраняет userMsg только после обработки
//   вложений);
// - queued-отправки (могут стартовать спустя минуты).
// cleanupOrphanDraftFiles получает их как extraKeepPaths и не удаляет.
// Заполняется в chat:send, очищается в runChatSend после saveMessage(userMsg).
// Записи старше 30 минут считаются протухшими (runChatSend упал до saveMessage)
// и отбрасываются — чтобы файлы-сироты не «спасались» вечно.
const PENDING_ATTACH_TTL_MS = 30 * 60_000
const pendingAttachmentPaths = new Map<string, Map<string, number>>()

// ── Auto-recall helpers ─────────────────────────────────────────────────────

/** Stopwords для keyword extraction (Russian + English). */
const RECALL_STOPWORDS = new Set<string>([
  // Russian
  'как', 'что', 'это', 'для', 'на', 'по', 'не', 'но', 'или', 'и', 'а', 'то',
  'же', 'бы', 'ли', 'ни', 'какой', 'какая', 'который', 'которая', 'его', 'её',
  'их', 'мы', 'вы', 'он', 'она', 'они', 'меня', 'тебя', 'этом', 'эта', 'эти',
  'эту', 'всё', 'все', 'всех', 'там', 'тут', 'где', 'когда', 'тогда', 'чтобы',
  'потому', 'если', 'уже', 'ещё', 'был', 'была', 'есть', 'нет', 'надо', 'нужно',
  'можно', 'нельзя', 'так', 'такой', 'за', 'из', 'от', 'до', 'об', 'при', 'про',
  'над', 'под', 'без', 'через', 'мне', 'тебе', 'ему', 'ей', 'им', 'вам', 'нам',
  'чтобы', 'тоже', 'ведь', 'вот', 'чем', 'того', 'тому', 'ними', 'ней', 'ним',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'not', 'no', 'yes', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'for', 'in', 'on',
  'at', 'to', 'of', 'from', 'with', 'by', 'as', 'this', 'that', 'these',
  'those', 'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our', 'you',
  'your', 'he', 'his', 'she', 'her', 'what', 'which', 'who', 'when', 'where',
  'why', 'how', 'all', 'each', 'every', 'both', 'about', 'into', 'out', 'up',
  'down', 'over', 'under', 'again', 'just', 'also', 'than', 'then', 'here',
])

/**
 * Извлекает ключевые слова из текста пользователя для auto-recall.
 * Удаляет stopwords, оставляет слова длиной ≥ 3 (trigram-минимум),
 * берёт топ-10 уникальных. Возвращает строку для FTS5/TF-IDF поиска.
 * Если keyword extraction даёт пустой результат — fallback на raw text.
 */
function extractRecallKeywords(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\w\u0400-\u04FF]/g, ' ') // keep Cyrillic + word chars
    .split(/\s+/)
    .filter(w => w.length >= 3 && !RECALL_STOPWORDS.has(w))
  const seen = new Set<string>()
  const unique: string[] = []
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); unique.push(w) }
  }
  const result = unique.slice(0, 10).join(' ')
  // Fallback: если extraction дал пустой или слишком короткий — берём raw
  return result.length >= 3 ? result : text.slice(0, 200)
}

/**
 * Build dedup key for auto-recall result. Used by cross-message dedup:
 * if the same result was already injected in a previous message, skip it.
 */
function getRecallDedupKey(r: { source: string; item?: { id?: string }; messageId?: string; content: string }): string {
  if (r.source === 'memory' && r.item?.id) return `mem:${r.item.id}`
  if (r.source === 'messages' && r.messageId) return `msg:${r.messageId}`
  if (r.source === 'pinned' && r.messageId) return `pin:${r.messageId}`
  if (r.source === 'graph') {
    // Для графа ключ — label узла (извлекаем из "[graph:file] contextManager.ts →...")
    const match = r.content.match(/^\[graph:\w+\]\s+(.+?)(?:\s*→|$)/)
    return `graph:${match?.[1]?.trim() ?? r.content.slice(0, 50)}`
  }
  // summaries, agent_logs — по первым 100 символам контента
  return `${r.source}:${r.content.slice(0, 100)}`
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

// ── Programmatic chat:send для main-процессных модулей (DotManager) ──────
// registerChatIPC при старте кладёт сюда реализацию chat:send. DotManager
// будит Dot'ов (фоновые пробуждения по cron/webhook/fs) прямым вызовом из
// main — без IPC round-trip через renderer. Результат тот же, что у
// renderer-отправки: { userMsg, assistantMsgId, queued? }.
export interface ProgrammaticChatSendParams {
  chatId: string
  content: string
  displayContent?: string
  slashCommand?: { name: string; args: string }
  incognito?: boolean
  userMsgId?: string
  /** Reserved ID for delegated requests, persisted before asynchronous startup. */
  assistantMsgId?: string
  planningMode?: boolean
  askMode?: boolean
  imageMode?: boolean
  /** Тумблер «Управление браузером»: browser_* тулы (гейтится также
   *  chats.browser_mode из БД — request_access пишет туда). */
  browserMode?: boolean
  mode?: ChatMode
  oneShotSkill?: { name: string; instructions: string }
  oneShotAllowedTools?: string[]
  oneShotMode?: 'ask' | 'plan' | 'code'
  reasoningValue?: string
  attachments?: Attachment[]
  replyTo?: ReplyTarget[]
}
// Request-scoped cancellation during async preparation, before a Worker exists.
const cancelledDelegatedStarts = new Set<string>()
let chatStopImpl: ((chatId: string, requestId: string) => boolean) | null = null
let chatSendImpl: ((params: ProgrammaticChatSendParams) => Promise<{ userMsg: Message; assistantMsgId: string; queued?: boolean }>) | null = null

/** Отправить сообщение в чат из main-процесса (DotManager: пробуждение Dot'ов). */
export function sendChatMessageProgrammatic(params: ProgrammaticChatSendParams): Promise<{ userMsg: Message; assistantMsgId: string; queued?: boolean }> {
  if (!chatSendImpl) {
    return Promise.reject(new Error('chat:send не зарегистрирован — registerChatIPC ещё не вызван'))
  }
  return chatSendImpl(params)
}

/**
 * Флешит все активные стримящиеся запуски в БД — вызывается при before-quit/will-quit.
 * Каждый ActiveRun, у которого есть накопленный текст/шаги, сохраняется через
 * sendDone (saveMessage UPSERT — идемпотентен). Воркеры terminate'ятся отдельно.
 * Без этого при резком выходе частичный ответ ассистента терялся бы.
 */
export function flushAllActiveRuns(): void {
  for (const [chatId, run] of activeRuns) {
    if (run.doneSent) continue
    // Останавливаем checkpoint-таймер перед флешем — sendDone ниже
    // сохранит финальную версию и перезапишет любой частичный checkpoint.
    if (run.streamCheckpointTimer) {
      clearInterval(run.streamCheckpointTimer)
      run.streamCheckpointTimer = null
    }
    const hasContent = run.bufferedText.trim() || run.bufferedSteps.length > 0 || run.bufferedThinking.trim()
    if (!hasContent) continue
    try {
      const iters = buildFinalIters(run)
      run.sendDone(
        run.bufferedText,
        run.bufferedThinking || undefined,
        run.bufferedThinkingMs,
        run.bufferedSteps.length > 0 ? run.bufferedSteps : undefined,
        iters,
        run.bufferedTodo.length > 0 ? run.bufferedTodo : undefined,
      )
      log('[flushAllActiveRuns] flushed chatId=%s msgId=%s text=%d chars', chatId, run.msgId, run.bufferedText.length)
    } catch (e) {
      log('[flushAllActiveRuns] failed chatId=%s: %s', chatId, (e as Error).message)
    }
  }
}


/**
 * Аварийная очистка после НЕОЖИДАННОГО падения runChatSend (throw вне
 * штатных путей: исключение в getSystemPrompt, компакции, построении
 * workerData и т.п.). Штатные ошибки (worker 'error'/'exit') чистят своё
 * сами. Без этой очистки чат оставался «занятым» НАВСЕГДА: activeRunMeta
 * не удалялся → каждый следующий chat:send молча уходил в очередь,
 * UI крутил «работает», Стоп не работал, очередь не дрейнилась.
 */
function failRunCleanup(
  win: BrowserWindow | null,
  chatId: string,
  assistantMsgId: string,
  e: unknown,
): void {
  // If setup failed before the worker's terminal event, close only a summary
  // explicitly associated with this assistant message. Incognito runs never create one.
  const closeSummary = (status: 'error' | 'cancelled', detail: string) => {
    try {
      const state = getTaskSummaryState(chatId)
      const task = state.tasks.find(item => item.status === 'running' && item.messageIds.includes(assistantMsgId))
      if (!task) return
      task.status = status
      task.updatedAt = Date.now()
      task.summary = detail.slice(0, 500)
      const next = upsertTaskSummary(task)
      broadcastTaskSummary?.(chatId, next)
    } catch (summaryError) { log('[task-summary] terminal update failed: %s', (summaryError as Error).message) }
  }
  if (cancelledDelegatedStarts.delete(assistantMsgId)) {
    const cancelledRun = activeRuns.get(chatId)
    if (cancelledRun?.msgId === assistantMsgId) {
      cancelledRun.doneSent = true // worker exit must not finalize a cancelled preparation as error
      if (cancelledRun.streamCheckpointTimer) clearInterval(cancelledRun.streamCheckpointTimer)
      if (cancelledRun.uiFlushTimer) clearTimeout(cancelledRun.uiFlushTimer)
      disposeBrowserWorkerBroker(cancelledRun.worker)
      void cancelledRun.worker?.terminate()
      activeRuns.delete(chatId)
    }
    if (activeRunMeta.get(chatId)?.msgId === assistantMsgId) activeRunMeta.delete(chatId)
    closeSummary('cancelled', 'Работа остановлена до запуска агента')
    emitRunStatus(win, chatId, 'cancelled', assistantMsgId)
    drainQueue(win, chatId)
    return
  }
  const message = e instanceof Error ? e.message : String(e)
  log('[chat:send] runChatSend CRASHED chatId=%s: %s', chatId, message)
  console.error('[chat:send] runChatSend CRASHED:', e)
  closeSummary('error', message)
  // Воркер мог быть создан до падения — терминируем, не течём потоками.
  const run = activeRuns.get(chatId)
  if (run?.streamCheckpointTimer) {
    clearInterval(run.streamCheckpointTimer)
    run.streamCheckpointTimer = null
  }
  if (run?.uiFlushTimer) {
    clearTimeout(run.uiFlushTimer)
    run.uiFlushTimer = null
  }
  if (run?.worker) {
    ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
    disposeBrowserWorkerBroker(run.worker)
    try { run.worker.terminate() } catch { /* уже мёртв */ }
  }
  activeRuns.delete(chatId)
  activeRunMeta.delete(chatId)
  emitRunStatus(win, chatId, 'error', assistantMsgId, message)
  try {
    win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, { chatId, error: message })
  } catch { /* окно могло закрыться */ }
  drainQueue(win, chatId)
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
  void next.run().catch((e) => failRunCleanup(win, chatId, next.meta.msgId, e))
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
// Legacy in-memory filter for caller-owned ephemeral histories (side/incognito).
// Keep its divider boundary semantics while applying context visibility.
function getLiveMessages(history: Message[]): Message[] {
  let latestDividerAt = -Infinity
  for (const message of history) {
    if (message.role === 'system' && message.slashCommand?.name === 'compact') {
      latestDividerAt = Math.max(latestDividerAt, message.createdAt)
    }
  }
  return history.filter(message =>
    !(message.role === 'system' && message.slashCommand?.name === 'compact')
    && message.createdAt > latestDividerAt,
  )
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
  recoverInterruptedTaskSummaries()
  const broadcastGoal = (chatId: string, goal: import('../../shared/types/goal').ChatGoal | null): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('goal:updated', { chatId, goal })
    }
  }
  setGlobalMemorySettingsStore(store)

  // Fast Context: инициализируем main-процессное connection к БД для watcher'а
  // (getFastContextStats/recordHistory/graph sync читают из main). Worker
  // открывает своё отдельное connection через initFastContextDb в fastContext-worker.
  // WAL mode → все работают concurrently с одним файлом.
  const fastContextDbPath = path.join(app.getPath('userData'), 'syntee.db')
  const fastContextWasmDir = resolveTreeSitterWasmDir()
  try {
    initFastContextDb(fastContextDbPath)
    initFastContextWasmDir(fastContextWasmDir)
    // Передаём пути в watcher — нужны для спавна worker_thread.
    setFastContextPaths(fastContextDbPath, fastContextWasmDir)
  } catch (e) {
    log('[registerChatIPC] fast context init failed: %s', (e as Error).message)
  }

  // Watcher стартует ТОЛЬКО для активного проекта (через setActiveProject из
  // fastContext.ipc при активации чата). Раньше здесь был цикл по всем проектам —
  // это порождало N chokidar-watchers в простое и N pre-warm job'ов, которые
  // блокировали main-процесс. Pre-warm теперь откладывается на 30с и идёт в
  // worker_thread (мягкий режим, BATCH=1).
  // Здесь только регистрируем workdir'ы — setActiveProject подхватит при активации.
  try {
    for (const p of getAllProjects()) {
      registerProjectWorkdir(p.id, p.workdir)
    }
  } catch { /* БД ещё пуста — ок */ }

  const getSystemPrompt = async (chatId?: string, isIncognito?: boolean, oneShotSkill?: { name: string; instructions: string }, planningMode?: boolean, askMode?: boolean, inspection?: Pick<ContextInspection, 'sources' | 'files'>): Promise<string> => {
    const contextPrefs = getContextPreferences(chatId)
    const userName = store.get('userName') as string || ''
    let memoryContext = ''
    let workingMemory = ''
    let summary = ''
    let workdir: string | undefined
    let projectContext: string | undefined
    let promptProjectId: string | undefined
    // Retry helper for transient SQLITE_BUSY/SQLITE_LOCKED. Previously all
    // 9 reads below were wrapped in `catch { /* ok */ }` — one transient
    // lock = the agent started with NO working memory, NO summary, NO
    // project instructions, NO MCP, NO skills — silently. The AI "forgot"
    // everything with no signal in the UI or logs. Now we retry transient
    // locks (3× with 50ms backoff) and log any remaining failures so the
    // issue is diagnosable instead of a silent ghost.
    const withRetry = async <T>(label: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await fn()
        } catch (e: any) {
          const code = String(e?.code ?? e?.errno ?? '')
          const isBusy = code === '5' || code === '6' || e?.message?.toLowerCase().includes('database is locked') || e?.message?.toLowerCase().includes('sqlite_busy')
          if (isBusy && attempt < 3) {
            await new Promise(r => setTimeout(r, 50 * attempt))
            continue
          }
          console.warn(`[getSystemPrompt] ${label} failed (attempt ${attempt}): ${e?.message ?? e}`)
          log('[getSystemPrompt] %s failed: %s', label, (e?.message ?? String(e)).slice(0, 200))
          return fallback
        }
      }
      return fallback
    }
    // Sync variant (better-sqlite3 is sync) — same retry logic but for sync fns
    const withRetrySync = <T>(label: string, fn: () => T, fallback: T): T => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return fn()
        } catch (e: any) {
          const code = String(e?.code ?? e?.errno ?? '')
          const isBusy = code === '5' || code === '6' || e?.message?.toLowerCase().includes('database is locked') || e?.message?.toLowerCase().includes('sqlite_busy')
          if (isBusy && attempt < 3) {
            // Не блокируем Electron main process на время retry. Atomics.wait
            // останавливал весь IPC/UI на 50–100мс при каждом SQLITE_BUSY,
            // что особенно заметно на HDD и во время фоновой индексации.
            // Для prompt-контекста безопаснее сразу использовать fallback:
            // следующий send перечитает данные после освобождения SQLite.
            console.warn(`[getSystemPrompt] ${label} busy — using fallback without blocking retry`)
            return fallback
          }
          console.warn(`[getSystemPrompt] ${label} failed (attempt ${attempt}): ${e?.message ?? e}`)
          log('[getSystemPrompt] %s failed: %s', label, (e?.message ?? String(e)).slice(0, 200))
          return fallback
        }
      }
      return fallback
    }
    try {
      if (chatId) {
        const wctx = withRetrySync('getChatWorkdirContext', () => getChatWorkdirContext(chatId), { workdir: undefined as string | undefined, projectContext: undefined as string | undefined })
        workdir = wctx.workdir
        projectContext = wctx.projectContext
        if (workdir) {
          const found = getAllProjects().find(p => p.workdir === workdir)
          promptProjectId = found?.id
        }
      }
    } catch (e: any) {
      console.warn('[getSystemPrompt] workdir resolution failed:', e?.message ?? e)
      log('[getSystemPrompt] workdir failed: %s', (e?.message ?? String(e)).slice(0, 200))
    }
    // Curated memory summary: top global user_facts + top project_decisions.
    // Replaces the full getAllMemoriesForContext dump — ~400 token budget.
    memoryContext = getMemorySettings().enabled
      ? withRetrySync('buildCuratedSummary', () => buildCuratedSummary(promptProjectId), '')
      : ''
    workingMemory = getMemorySettings().enabled
      ? withRetrySync('workingMemory', () => chatId ? getWorkingMemory(chatId) : '', '')
      : ''
    summary = getMemorySettings().enabled
      ? withRetrySync('chatSummary', () => chatId ? getChatSummary(chatId) : '', '')
      : ''

    // Live-read project instructions: авто-дискавери AGENTS.md/CLAUDE.md +
    // кастомные .md файлы из настроек проекта. mtime-кэш — повторные вызовы дёшевы.
    let projectInstructions: Awaited<ReturnType<typeof readProjectContextFiles>> = []
    projectInstructions = await withRetry('readProjectContextFiles', () => {
      const found = workdir ? getAllProjects().find(p => p.workdir === workdir) : undefined
      return readProjectContextFiles(workdir, found?.contextFiles, found?.autoDiscoverInstructions, found?.disabledDiscoveryFiles)
    }, [])

    // Active skills for the chat. In incognito — empty (privacy).
    // projectId is pulled via the projects table by workdir.
    let activeSkills: import('../../shared/types').Skill[] = []
    if (!isIncognito) {
      activeSkills = withRetrySync('activeSkills', () => {
        let skillProjectId: string | undefined
        if (workdir) {
          const found = getAllProjects().find(p => p.workdir === workdir)
          skillProjectId = found?.id
        }
        return getSkillManager().getActiveSkillsForChat({
          projectWorkdir: workdir,
          projectId: skillProjectId,
          isIncognito,
        })
      }, [])
    }

    // Active MCP servers for a brief note in the system prompt.
    // In incognito — empty (privacy).
    let activeMcpServers: import('../../core/prompts/buildSystemPrompt').McpPromptInfo[] = []
    if (!isIncognito) {
      activeMcpServers = withRetrySync('activeMcpServers', () => {
        const mgr = getMcpManager()
        let mcpProjectId: string | undefined
        if (workdir) {
          const found = getAllProjects().find(p => p.workdir === workdir)
          mcpProjectId = found?.id
        }
        const allServers = mgr.getAllServers({ projectWorkdir: workdir, projectId: mcpProjectId })
        return allServers
          .filter(s => s.enabled && s.status === 'connected' && s.tools.length > 0
            && mgr.isScopeApplicable(s.scope, mcpProjectId))
          .map(s => ({
            name: s.name,
            tools: s.tools.map(t => ({ shortName: t.shortName, description: t.description })),
          }))
      }, [])
    }

    // Active plugins for a brief note in the system prompt.
    // In incognito — empty (privacy).
    let activePlugins: import('../../core/prompts/buildSystemPrompt').PluginPromptInfo[] = []
    if (!isIncognito) {
      activePlugins = withRetrySync('activePlugins', () => {
        let pluginProjectId: string | undefined
        if (workdir) {
          pluginProjectId = getAllProjects().find(p => p.workdir === workdir)?.id
        }
        return getPluginManager().getActivePluginsForChat({
          projectWorkdir: workdir,
          projectId: pluginProjectId,
          isIncognito,
        })
      }, [])
    }

    const mergedWorkingMemory = summary
      ? `${workingMemory ? workingMemory + '\n\n' : ''}## Summary of previous conversation context\n(Summary of earlier messages. Use this for context — tasks, decisions, files, and state from before compaction. Continue from where the conversation left off.)\n${summary}`
      : workingMemory

    // Global system prompt from Settings → AI → Parameters (or /sys command)
    const customSystemPrompt = (store.get('modelParams') as { systemPrompt?: string } | undefined)?.systemPrompt

    // Memory counters for the system prompt — the agent sees how much memory it has.
    const memoryStats: { globalCount: number; projectCount: number; globalByKind: Record<string, number>; projectByKind: Record<string, number> } | undefined =
      getMemorySettings().enabled
        ? withRetrySync('memoryStats', () => getMemoryStatsForProject(promptProjectId), undefined)
        : undefined

    // Knowledge graph stats — the agent sees the project structure.
    let graphStats: ReturnType<typeof getGraphStats> | undefined
    graphStats = withRetrySync('graphStats', () => promptProjectId ? getGraphStats(promptProjectId) : undefined, undefined)

    // Auto-build graph if empty (first project open)
    if (graphStats && graphStats.nodeCount === 0 && promptProjectId) {
      try {
        const buildResult = buildProjectGraph(promptProjectId)
        log('[getSystemPrompt] auto-built graph: nodes=%d edges=%d', buildResult.nodes, buildResult.edges)
        // Re-fetch stats after build
        graphStats = withRetrySync('graphStats', () => getGraphStats(promptProjectId), undefined)
      } catch (e) {
        log('[getSystemPrompt] auto-build graph failed: %s', (e as Error).message)
      }
    }

    // Absolute path to the global skills folder — for the install reference in the prompt.
    let globalSkillsDir = ''
    try { globalSkillsDir = path.join(app.getPath('userData'), 'skills') } catch { /* app may be unavailable */ }
    // Absolute path to the global plugins folder — same purpose.
    let globalPluginsDir = ''
    try { globalPluginsDir = path.join(app.getPath('userData'), 'plugins') } catch { /* app may be unavailable */ }

    // Project notes — agent sees note titles in the system prompt.
    // In incognito — skip (privacy). Only project notes, not chat notes.
    let notesInfo: { notes: Array<{ id: string; title: string }>; count: number } | undefined
    if (!isIncognito && promptProjectId) {
      notesInfo = withRetrySync('notesInfo', () => getProjectNotesInfo(promptProjectId!), undefined)
    }

    // Context providers плагинов: живой контекст в system prompt.
    // Инкогнито — пропуск (приватность). Таймауты внутри collectContext.
    let pluginContext: Array<{ name: string; content: string }> = []
    if (!isIncognito) {
      try {
        pluginContext = await getPluginManager().collectContext(chatId)
      } catch { /* плагины не должны ломать промпт */ }
    }

    // Статические секции промпта плагинов (registerPromptSection).
    let pluginSections: Array<{ title: string; content: string }> = []
    if (!isIncognito) {
      try {
        pluginSections = withRetrySync('pluginSections', () =>
          getPluginManager().collectPromptSections({
            projectWorkdir: workdir,
            projectId: promptProjectId,
            isIncognito,
          }), [])
      } catch { /* плагины не должны ломать промпт */ }
    }

    // Защищённые переменные (секреты юзера) — расшифровываются здесь.
    // В промпт идут только ключи-плейсхолдеры (${{KEY}}), реальные значения
    // НЕ попадают в промпт (см. secretsSection.ts). Инкогнито — пропуск.
    let protectedVars: ProtectedVarPromptInfo[] | undefined
    if (!isIncognito) {
      try {
        protectedVars = resolveActive()
      } catch { /* не ломаем промпт из-за секретов */ }
    }

    // browserMode для промпта: тумблер чата из БД (params/browserMode-флаг
    // отправки здесь недоступны — это отдельная функция с chatId-параметром;
    // раньше здесь было !!params.browserMode || getChatBrowserMode(dbChatId) —
    // ReferenceError, валивший КАЖДЫЙ chat:send).
    const promptBrowserMode = chatId ? getChatBrowserMode(chatId) : false
    // Source controls affect actual builder inputs, not just inspector labels.
    const sources = contextPrefs.sources
    const includedFiles = projectInstructions.filter(file => sources.instructions && sources.projectFiles && !contextPrefs.excludedFiles.includes(file.source))
    if (inspection) {
      inspection.files = projectInstructions.map(file => ({ source: file.source, characters: file.content.length, included: includedFiles.includes(file) }))
      inspection.sources = [
        { key: 'instructions', label: 'Дополнительные инструкции', enabled: sources.instructions, detail: 'Custom system prompt, инструкции проекта и статические секции плагинов. Базовые правила и режимы остаются.', characters: (customSystemPrompt?.length ?? 0) + projectInstructions.reduce((n, f) => n + f.content.length, 0) + pluginSections.reduce((n, f) => n + f.content.length, 0) },
        { key: 'projectFiles', label: 'Контекст проекта и файлы', enabled: sources.projectFiles, detail: 'Скан проекта, файлы инструкций и живой контекст плагинов. Workdir и доступ к файлам остаются.', characters: (projectContext?.length ?? 0) + projectInstructions.reduce((n, f) => n + f.content.length, 0) + pluginContext.reduce((n, f) => n + f.content.length, 0) },
        { key: 'memory', label: 'Память в system prompt', enabled: sources.memory && getMemorySettings().enabled, detail: 'Curated memory, working memory, summary, граф и заметки. Явные вызовы recall_memory не блокируются.', characters: memoryContext.length + mergedWorkingMemory.length },
        { key: 'history', label: 'История сообщений', enabled: sources.history, detail: 'После последнего сжатия. Закреплённые сообщения включаются даже при выключенной истории.', characters: 0 },
        { key: 'tools', label: 'История инструментов', enabled: sources.tools, detail: 'Прошлые tool calls и результаты. Доступность инструментов текущего запуска не меняется.', characters: 0 },
      ]
    }
    let systemPrompt = perfPhase('chat.system_prompt.build', () => buildSystemPrompt({ userName, memoryContext: sources.memory ? memoryContext : '', memoryStats: sources.memory ? memoryStats : undefined, graphStats: sources.memory ? graphStats : undefined, workingMemory: sources.memory ? mergedWorkingMemory : '', customSystemPrompt: sources.instructions ? customSystemPrompt : undefined, workdir, projectContext: sources.projectFiles ? projectContext : undefined, projectInstructions: includedFiles, activeSkills, activeMcpServers, activePlugins, oneShotSkill, globalSkillsDir, globalPluginsDir, planningMode, askMode, browserMode: promptBrowserMode, notesInfo: sources.memory ? notesInfo : undefined, maxParallelSubAgents: (store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings)?.maxParallelSubAgents, pluginContext: sources.projectFiles ? pluginContext : [], pluginSections: sources.instructions ? pluginSections : [], protectedVars }))

    // Хук prompt:before-build — последняя точка вмешательства плагинов
    // в system prompt (modify → новый текст).
    if (!isIncognito && !inspection && contextPrefs.sources.instructions) {
      try {
        systemPrompt = await perfPhaseAsync('chat.system_prompt.plugin_hook', () => getPluginManager().runPromptHook(chatId, systemPrompt))
      } catch { /* ignore */ }
    }

    if (!getMemorySettings().enabled) {
      systemPrompt += '\n\n## Memory — DISABLED by user\nAll Syntee memory is OFF. Do not read or write global, project, chat, working, summary, or recall memory. Do not claim memory is enabled or available.\n'
    } else if (!getGlobalMemoryEnabled()) {
      systemPrompt += '\n\n## Global memory — DISABLED by user\nGlobal long-term memory is OFF. Do not claim it is enabled or available.\n'
    }
    if (!isIncognito && chatId) {
      const goal = getChatGoal(chatId)
      if (goal && ['running', 'paused', 'blocked'].includes(goal.status)) {
        systemPrompt += `\n\n## ACTIVE USER GOAL (persistent)\nObjective: ${goal.objective}\nCompletion criteria: ${goal.criteria.join('; ')}\nConstraints: ${goal.constraints.join('; ')}\nProgress: ${goal.progress.slice(-12).join(' | ')}\nStep budget: ${goal.steps}/${goal.maxSteps}. Do not claim completion without concrete evidence. Stop for blockers or approvals; never bypass tool permissions. Goal status: ${goal.status}.`
      }
    }
    return systemPrompt

  }

  // Билдер system prompt для плагинов (syntee.prompt.get) и превью в UI.
  // Без рекурсии: getSystemPrompt не зовёт хук prompt:before-build повторно
  // сам по себе — хук выполняется внутри только при реальных запросах агента.
  try {
    getPluginManager().setPromptBuilder(async (chatId) => getSystemPrompt(chatId))
  } catch { /* плагины не инициализированы — ок */ }

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
    lines.push('Skills — инструкции для подходящих задач. Сначала вызови get_skill(name или точный id), затем следуй инструкциям. Папки содержат вложенные скиллы и связанные материалы; get_skill возвращает базовую папку для относительных ссылок.')
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
            lines.push(`- **${s.name}** [${s.source}] (id: ${s.id}; путь: ${s.relativePath ?? s.filePath}): ${s.description || '(без описания)'}`)
          }
        }
        if (inactive.length > 0) {
          lines.push(`Неактивные (${inactive.length}, можно включить в Настройки → Расширения):`)
          for (const s of inactive) {
            lines.push(`- ${s.name} [${s.source}] (id: ${s.id}; путь: ${s.relativePath ?? s.filePath}): ${s.description || '(без описания)'}`)
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      log('[list_extensions] Skills error:', msg)
      lines.push(`Ошибка загрузки скиллов: ${msg}`)
    }

    // Plugins
    lines.push('')
    lines.push('## Плагины')
    lines.push('Плагины — локальные расширения с кодом (utilityProcess). Их тулы имеют формат plugin__{pluginId}__{toolName} и вызываются как обычные тулы.')
    try {
      const wctx = (() => {
        try { return getChatWorkdirContext(chatId) } catch { return {} as ReturnType<typeof getChatWorkdirContext> }
      })()
      const workdir = wctx.workdir
      let pluginProjectId: string | undefined
      if (workdir) {
        pluginProjectId = getAllProjects().find(p => p.workdir === workdir)?.id
      }
      const allPlugins = getPluginManager().getAllWithState({
        projectWorkdir: workdir,
        projectId: pluginProjectId,
      })
      if (allPlugins.length === 0) {
        lines.push('Плагины не установлены. Папка плагина: plugin.json + entry (см. секцию Where to install extensions).')
      } else {
        for (const p of allPlugins) {
          const statusIcon = p.status === 'running' ? '✓' : p.status === 'error' ? '✗' : '○'
          lines.push(`- ${statusIcon} **${p.manifest.name}** (id: ${p.id}, v${p.manifest.version}, ${p.status})${p.state.enabled ? '' : ' [отключён]'}${p.source === 'global' ? '' : ' [проект]'}`)
          if (p.error) lines.push(`  Ошибка: ${p.error.slice(0, 200)}`)
          if (p.manifest.description) lines.push(`  ${p.manifest.description}`)
          if (p.tools.length > 0) {
            lines.push(`  Тулы: ${p.tools.map(t => t.shortName).join(', ')}`)
          }
          if (p.manifest.permissions?.length) {
            lines.push(`  Права: ${p.manifest.permissions.join(', ')}`)
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      log('[list_extensions] Plugins error:', msg)
      lines.push(`Ошибка загрузки плагинов: ${msg}`)
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
   *  - Картинки: vision-модель → direct pass (imageParts, без путей в
   *    content — модель видит пиксели сама). Text-only → только пути в
   *    content, модель сама вызывает analyze_image тул когда нужно.
   *  - Бинарные — только путь+имя+размер.
   *
   * Для vision direct pass эмитим agent:tool_progress с toolName
   * 'vision_recognition' — renderer показывает shimmer «Распознаю
   * изображения...» вместо обычного «Думаю...».
   *
   * Возвращает { content, result, imageParts } — augmented content,
   * структурированный результат (для БД) и imageParts для прямого пасса.
   */
  async function processAttachmentsAndStream(
    win: BrowserWindow | null,
    chatId: string,
    msgId: string,
    content: string,
    attachments: Attachment[],
  ): Promise<{ content: string; result: AttachmentProcessingResult | null; imageParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> }> {
    if (attachments.length === 0) return { content, result: null, imageParts: [] }

    // require вместо await import для builtin: нативный import() не работает в V8-байткоде.
    // (относительные import() ниже rollup компилирует в require — они безопасны)
    const { readFile: fsReadFile, stat: fsStat, readdir: fsReaddir } = require('fs/promises')
    const { readFileSync } = require('fs')
    const { isTextMime, isImageMime } = await import('../../shared/mentions')

    const startedAt = Date.now()

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

    // ── Vision capability check: если основная модель поддерживает vision,
    //    передаём картинки напрямую (без промежуточного описания через vision-модель).
    //    ВНИМАНИЕ: storeData из runChatSend НЕ доступен тут (processAttachmentsAndStream —
    //    сиблинг runChatSend, не вложенная функция). Используем store.get() напрямую.
    const modelAssignments = store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    let mainAssignment = modelAssignments?.find(a => a.role === 'main')
    // Per-chat модель: если у чата задана своя — она важнее глобального
    // назначения main (решает, видит ли модель картинки напрямую).
    try {
      const chatModel = getChatModel(chatId)
      if (chatModel) mainAssignment = { role: 'main', modelId: chatModel.modelId, providerId: chatModel.modelProvider }
    } catch { /* ok */ }

    // Эвристика vision-способности вынесена в src/core/ai/visionSupport.ts —
    // общий модуль: используется и здесь (вложения), и в тулe analyze_image
    // (core/tools/image.ts). Решение «модель видит сама / нужна вспомогательная
    // vision-модель» всегда принимается одинаково, в одном месте.
    let mainModelSupportsVision = false
    if (mainAssignment) {
      mainModelSupportsVision = modelSupportsVisionByHeuristic(mainAssignment.providerId, mainAssignment.modelId)
    }
    const imageParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> = []


    // ── Phase 1: Первый проход — некартинки (последовательно, быстрый I/O) ──
    // Картинки собираем в imageAtts для параллельной обработки во втором проходе.
    const imageAtts: Array<{ att: Attachment; index: number }> = []

    for (const att of attachments) {
      // ── Ссылка на чат (@пикер): инлайним титул + summary + последние
      //    сообщения — модель понимает, на какой чат ссылается юзер
      //    («@чат про рефакторинг — что там решили?»). ──
      if (att.kind === 'chat') {
        if (!att.chatId) {
          processedFiles.push({ name: att.name, kind: att.kind, status: 'skipped', detail: 'Чат без ID (ссылка битая)' })
          continue
        }
        try {
          const chat = getAllChats().find(c => c.id === att.chatId)
          if (!chat) throw new Error('Чат не найден (удалён?)')
          const parts: string[] = [`Чат «${chat.title}» (${chat.messageCount ?? '?'} сообщений, обновлён ${new Date(chat.updatedAt).toLocaleString('ru')})`]
          const summary = getChatSummary(att.chatId)
          if (summary) parts.push(`Краткое содержание чата:\n${summary.slice(0, 2000)}${summary.length > 2000 ? '\n…(обрезано)' : ''}`)
          // Последние сообщения: getMessagesPage без курсора = новейшие N в ASC.
          // Берём с запасом (system-сообщения отфильтруются), slice(-6) — итог.
          const msgs = getMessagesPage(att.chatId, 12).messages.filter(m => m.role !== 'system').slice(-6)
          if (msgs.length > 0) {
            const dialog = msgs.map(m => {
              const who = m.role === 'user' ? 'Пользователь' : 'Ассистент'
              const clean = stripAttachTokens(stripPlanTags(m.content)).trim()
              return `${who}: ${clean.slice(0, 600)}${clean.length > 600 ? '…' : ''}`
            }).join('\n\n')
            parts.push(`Последние сообщения (${msgs.length}):\n${dialog}`)
          }
          textBlocks.push(`─── Чат: ${chat.title} ───\n${parts.join('\n\n')}\n─── Конец чата: ${chat.title} ───`)
          processedFiles.push({
            name: att.name,
            kind: att.kind,
            status: 'text_inlined',
            detail: `Чат: summary + ${Math.min(6, Math.max(0, (chat.messageCount ?? 0)))} последних сообщений инлайнено`,
          })
        } catch (e) {
          hasErrors = true
          const errMsg = (e as Error).message
          textBlocks.push(`[Ссылка на чат «${att.name}» недоступна: ${errMsg}]`)
          processedFiles.push({ name: att.name, kind: att.kind, status: 'error', detail: errMsg })
        }
        continue
      }

      // ── Ссылка на проект (@пикер): инлайним имя + workdir + projectContext
      //    (результат analyzeProject, сохранённый при создании) — модель
      //    получает контекст проекта без повторного анализа. ──
      if (att.kind === 'project') {
        if (!att.projectId) {
          processedFiles.push({ name: att.name, kind: att.kind, status: 'skipped', detail: 'Проект без ID (ссылка битая)' })
          continue
        }
        try {
          const proj = getProjectById(att.projectId)
          if (!proj) throw new Error('Проект не найден (удалён?)')
          const parts: string[] = [`Проект «${proj.name}»\nРабочая директория: ${proj.workdir}`]
          if (proj.projectContext) {
            parts.push(`Контекст проекта (анализ при создании):\n${proj.projectContext.slice(0, 4000)}${proj.projectContext.length > 4000 ? '\n…(обрезано)' : ''}`)
          }
          if (proj.verificationCommand) parts.push(`Команда проверки: ${proj.verificationCommand}`)
          textBlocks.push(`─── Проект: ${proj.name} ───\n${parts.join('\n\n')}\n─── Конец проекта: ${proj.name} ───`)
          processedFiles.push({
            name: att.name,
            kind: att.kind,
            status: 'text_inlined',
            detail: `Проект: workdir${proj.projectContext ? ' + контекст' : ''} инлайнено`,
          })
        } catch (e) {
          hasErrors = true
          const errMsg = (e as Error).message
          textBlocks.push(`[Ссылка на проект «${att.name}» недоступна: ${errMsg}]`)
          processedFiles.push({ name: att.name, kind: att.kind, status: 'error', detail: errMsg })
        }
        continue
      }

      if (att.kind === 'skill' || att.kind === 'command' || !att.path) {
        processedFiles.push({
          name: att.name,
          kind: att.kind,
          status: 'skipped',
          detail: att.kind === 'skill' ? 'Скилл (обрабатывается отдельно)'
            : att.kind === 'command' ? 'Команда (обрабатывается отдельно)'
            : 'Без пути к файлу',
        })
        continue
      }

      try {
        const st = await fsStat(att.path)
        if (st.isDirectory()) {
          // Листинг содержимого: агент видит, что внутри, и может читать
          // файлы по пути (read_file) без дополнительных запросов к юзеру.
          let listing = ''
          let total = 0
          const dirPath = String(att.path ?? '')
          try {
            const entries = await fsReaddir(dirPath, { withFileTypes: true })
            const visible = entries.filter((e: { name: string }) =>
              !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'out')
            total = visible.length
            const shown = visible.slice(0, 100)
            const { statSync, join: pathJoin } = require('path') as typeof import('path') & { statSync: (p: string) => { size: number } }
            const lines = shown.map((e: { name: string; isDirectory: () => boolean }) => {
              if (e.isDirectory()) return `- ${e.name}/`
              try {
                const sz = statSync(pathJoin(dirPath, e.name)).size
                return `- ${e.name} (${(sz / 1024).toFixed(1)} KB)`
              } catch { return `- ${e.name}` }
            })
            listing = lines.length > 0
              ? `\n${lines.join('\n')}${total > 100 ? `\n…и ещё ${total - 100} записей` : ''}`
              : '\n(пусто)'
          } catch { /* нет доступа — просто путь */ }
          textBlocks.push(`[Директория: ${att.name}] (путь: ${att.path}, записей: ${total})${listing}\nЧитай нужные файлы из директории по полному пути.`)
          processedFiles.push({ name: att.name, kind: att.kind, status: 'binary_path', size: 0, detail: `Директория (${total} записей, листинг в контексте)` })
        } else if (att.kind === 'image' || isImageMime(att.mime)) {
          // Картинку откладываем для параллельной обработки во втором проходе.
          const idx = processedFiles.length
          imageAtts.push({ att, index: idx })
          processedFiles.push({ name: att.name, kind: att.kind, status: 'image_described', size: st.size, description: '' })
        } else if (att.kind === 'video' || att.kind === 'audio' || /^(video|audio)\//.test(att.mime || mimeFromExt(att.path))) {
          const mediaKind = att.kind === 'video' || (att.mime || mimeFromExt(att.path)).startsWith('video/') ? 'video' : 'audio'
          const toolName = mediaKind === 'video' ? 'analyze_video' : 'analyze_audio'
          const disabled = isToolDisabled(toolName, getToolSettings(store))
          const detail = disabled
            ? `${toolName} выключен в настройках — содержимое не проанализировано.`
            : `Используй ${toolName} с этим локальным путём и вопросом пользователя; содержимое ещё не проанализировано. Нужна назначенная модель и поддерживаемый транспорт.`
          textBlocks.push(`[Прикреплён ${mediaKind === 'video' ? 'видеофайл' : 'аудиофайл'}: ${att.name}] (${(st.size / 1024).toFixed(1)} KB, путь: ${att.path})\n${detail}`)
          processedFiles.push({ name: att.name, kind: mediaKind, status: 'binary_path', size: st.size, detail })
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
    }

    // ── Phase 2: Обработка картинок ──
    // Если основная модель поддерживает vision — direct pass (без vision-модели).
    if (imageAtts.length > 0 && mainModelSupportsVision) {
      for (const { att } of imageAtts) {
        try {
          const base64 = readFileSync(att.path!).toString('base64')
          const mime = att.mime || 'image/png'
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' },
          })
          const attIdx = imageAtts.findIndex(x => x.att === att)
          if (attIdx >= 0) {
            processedFiles[attIdx] = {
              ...processedFiles[attIdx],
              status: 'image_described',
              description: 'Передано напрямую в основную модель (vision)',
            }
          }
        } catch (e) {
          const errMsg = (e as Error).message
          textBlocks.push(`[Ошибка чтения изображения: ${att.name} — ${errMsg}]`)
          const attIdx = imageAtts.findIndex(x => x.att === att)
          if (attIdx >= 0) {
            processedFiles[attIdx] = { ...processedFiles[attIdx], status: 'error', detail: errMsg }
          }
          hasErrors = true
        }
      }
      // Эмитим vision_recognition — для shimmer-индикатора «Распознаю изображения...»
      // (вместо убранного блока AttachmentProcessingBlock). Промоутит streamMsgId.
      if (imageParts.length > 0) {
        win?.webContents.send('agent:tool_progress', {
          msgId, chatId,
          toolName: 'vision_recognition',
          stage: 'analyzing',
          detail: `Распознаю ${imageParts.length} ${imageParts.length === 1 ? 'изображение' : 'изображений'}...`,
          ts: Date.now(),
        })
      }
      // Пути НЕ добавляем — модель уже видит пиксели через imageParts,
      // пути только сбивают её и заставляют вызывать analyze_image тул.
    } else if (imageAtts.length > 0) {
      // Text-only модель: НЕ делаем upfront-анализ через vision-модель.
      // Просто передаём пути картинок — модель сама вызовет analyze_image
      // тул с нужными параметрами (вопрос, фокус) когда ей понадобится.
      const pathsList = imageAtts.map(({ att }) => `- ${att.name}: ${att.path}`).join('\n')
      textBlocks.push(`[Прикреплённые изображения (доступны через analyze_image):]\n${pathsList}`)
      for (const { index } of imageAtts) {
        processedFiles[index] = {
          ...processedFiles[index],
          status: 'image_described',
          description: 'Путь передан модели — analyze_image по требованию',
        }
      }
    }

    // Собираем augmented content.
    // Если пользователь отправил ТОЛЬКО вложение (без текста) — content пустой,
    // и модель получала бы голый блок «[Прикреплённые изображения...]» без
    // задачи → часто отвечала «не вижу вложения». Подставляем дефолтную
    // инструкцию, чтобы у модели был явный повод обработать вложение
    // (analyze_image для картинок / ответ по содержимому файла).
    const baseContent = content.trim()
      ? content
      : 'Проанализируй прикреплённые вложения: опиши содержимое и дай ответ.'
    const augmentedContent = textBlocks.length > 0
      ? `${baseContent}\n\n${textBlocks.join('\n\n')}`
      : baseContent

    // Структурированный результат для сохранения в message
    const result: AttachmentProcessingResult = {
      files: processedFiles,
      totalProcessed: processedFiles.filter(f => f.status !== 'skipped' && f.status !== 'error').length,
      totalErrors: processedFiles.filter(f => f.status === 'error').length,
      totalImages: processedFiles.filter(f => f.status === 'image_described').length,
      ms: Date.now() - startedAt,
      hasErrors,
    }

    return { content: augmentedContent, result, imageParts }
  }

  async function runChatSend(
    params: {
      chatId: string
      projectId?: string
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
      /** Уровень мышления из UI на момент клика «Отправить» (source of truth).
       *  Приоритет над БД и глобальной настройкой — устраняет гонки
       *  restore-цепочки и записи chat:setReasoning. */
      reasoningValue?: string
      /** One-shot скилл — инструкции временно инъектируются на этот прогон
       *  (без записи в skillsState). Используется командами типа /review. */
      oneShotSkill?: { name: string; instructions: string }
      /** Ограничение тулов на этот прогон (для кастомных команд с allowed-tools).
       *  Builtin-команды не используют — их режим задаётся planning/askMode. */
      oneShotAllowedTools?: string[]
      /** Режим для кастомной команды: 'ask' (read-only) | 'plan' | 'code'. */
      oneShotMode?: 'ask' | 'plan' | 'code'
      /** Вложения отправки (включая реплайнутые с source:'reply') —
       *  обрабатываются processAttachmentsAndStream. Поле не было объявлено
       *  в типе, хотя код использовал params.attachments (TS2339). */
      attachments?: Attachment[]
      /** Реплай-цитаты — цитата для AI строится из userMsg.replyTo ниже. */
      replyTo?: ReplyTarget[]
      /** Тумблер «Управление браузером»: browser_* тулы с первого раунда. */
      browserMode?: boolean
    },
    win: BrowserWindow | null,
    chatMode: ChatMode,
    agentSettings: AgentSettings,
    userMsg: Message,
    history: Message[],
    assistantMsgId: string,
  ): Promise<{ userMsg: Message; assistantMsgId: string }> {
    let summaryTaskId: string | undefined
    if (!params.incognito && !params.sideChatParentId) {
      try {
        const state = getTaskSummaryState(params.chatId)
        const latest = state.tasks[0]
        const continuation = !state.newTaskRequested && latest && latest.status !== 'running' && isExplicitTaskContinuation(params.content)
        let task = continuation ? latest : undefined
        if (!task) task = createTaskSummary(params.chatId, params.content.trim().replace(/\s+/g, ' ').slice(0, 90) || 'Задача', assistantMsgId)
        else if (!task.messageIds.includes(assistantMsgId)) task.messageIds.push(assistantMsgId)
        task.status = 'running'; task.updatedAt = Date.now(); summaryTaskId = task.id
        upsertTaskSummary(task)
        updateTaskSummaryState(params.chatId, { newTaskRequested: false, selectedTaskId: task.id })
        emitTaskSummary(params.chatId, getTaskSummaryState(params.chatId))
      } catch (e) { log('[task-summary] start failed: %s', (e as Error).message) }
    }
    const storeData: Record<string, unknown> = {}
      const storeKeys = [
        'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels',
        'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'projectPermissions', 'chatApprovalAllowlist', 'integrations',
        'voiceId', 'embeddingModel',
        'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
        'contextSettings',
        'customToolsEnabled', 'disabledTools',
      ]
    for (const k of storeKeys) {
      const v = store.get(k)
      if (v !== undefined) storeData[k] = v
    }

    // ── Per-chat модель + уровень мышления ────────────────────────────────────
    // Если у чата задана своя модель (chats.model_id/model_provider) —
    // подменяем запись role:'main' в storeData. Тогда ВСЁ ниже по потоку
    // (mainAssignment → workerData.modelId, getModelContextWindow для
    // rolling-компакции, checkpoint-метка model) автоматически использует
    // модель чата, а не глобальную. NULL у колонки = глобальное назначение
    // (все чаты, созданные до фичи, ведут себя как раньше).
    // Side-чаты (sideChatParentId) наследуют модель родителя.
    // Аналогично reasoning_value: подменяем storeData.reasoningValue —
    // worker (fakeStore поверх storeData) и AIClient читают его при
    // построении reasoning-параметров запроса.
    // ПРИОРИТЕТ: params.reasoningValue (значение из UI на момент клика
    // «Отправить») > chats.reasoning_value (БД) > глобальная настройка.
    // UI-значение — высший приоритет: устраняет гонки, когда restore-цепочка
    // или запись в БД не успели, и в запрос уходило значение прошлого чата.
    try {
      const dbId = params.sideChatParentId ?? params.chatId
      const chatModel = getChatModel(dbId)
      if (chatModel) {
        const assignments = (storeData.modelAssignments as Array<{ role: string; modelId: string; providerId: string }> | undefined) ?? []
        const idx = assignments.findIndex(a => a.role === 'main')
        const override = { role: 'main', modelId: chatModel.modelId, providerId: chatModel.modelProvider }
        if (idx >= 0) assignments[idx] = override
        else assignments.push(override)
        storeData.modelAssignments = assignments
      }
      if (params.reasoningValue !== undefined) {
        storeData.reasoningValue = params.reasoningValue
      } else {
        const chatReasoning = getChatReasoning(dbId)
        if (chatReasoning !== null) storeData.reasoningValue = chatReasoning
      }
    } catch { /* ok — чат мог быть удалён */ }

    const ctxSettings = getContextSettings(storeData)
    // Для side-чата DB-lookups (working memory, summary, workdir, system prompt)
    // делаем по parentChatId — side-чат эфемерный (incognito), не имеет своих
    // записей в БД, но разделяет контекст родителя.
    const dbChatId = params.sideChatParentId ?? params.chatId
    let currentWorkingMemory = ''
    let storedSummary = ''
    if (getContextPreferences(dbChatId).sources.memory) {
      try { currentWorkingMemory = getWorkingMemory(dbChatId) } catch { /* ok */ }
      try { storedSummary = getChatSummary(dbChatId) } catch { /* ok */ }
    }

    // Обновляем createdAt на момент реального старта. Для queued-запросов
    // userMsg.createdAt был зафиксирован в chat:send при отправке (до очереди),
    // а saveMessage происходит только сейчас. Без этого БД (сортировка по
    // created_at ASC) поставит user2/user3 перед assistant1 — порядок
    // диалога сломается при перезаходе в чат.
    userMsg.createdAt = Date.now()
    if (!params.incognito) saveMessage(userMsg)
    if (!params.incognito && getDelegatedRequest(params.chatId, assistantMsgId)) {
      win?.webContents.send('chat:delegated-message', { message: slimMessageForUI(userMsg) })
    }

    // ── Очистка осиротевших файлов черновика ──────────────────────────────
    // СТРОГО после saveMessage(userMsg): пути вложений этой отправки уже в
    // БД → не попадут под удаление. Пути вложений queued-отправок (userMsg
    // ещё не в БД) передаём как extraKeepPaths. Раньше очистку вызывал
    // renderer ДО chat:send — из-за FIFO в IPC файл свежей отправки
    // удалялся до сохранения сообщения, и вложения «не доходили» до модели.
    if (!params.incognito) {
      const pending = pendingAttachmentPaths.get(params.chatId)
      if (pending) {
        for (const a of (params.attachments ?? [])) {
          if (a?.path) pending.delete(path.resolve(a.path).toLowerCase())
        }
        // Отбрасываем протухшие записи (runChatSend упал до saveMessage).
        const ttlCutoff = Date.now() - PENDING_ATTACH_TTL_MS
        for (const [p, ts] of pending) {
          if (ts < ttlCutoff) pending.delete(p)
        }
        const extraKeep = [...pending.keys()]
        if (pending.size === 0) pendingAttachmentPaths.delete(params.chatId)
        try { cleanupOrphanDraftFiles(params.chatId, extraKeep) } catch { /* ignore */ }
      } else {
        try { cleanupOrphanDraftFiles(params.chatId) } catch { /* ignore */ }
      }
    }

    // ── Режимные флаги текущего прогона ──────────────────────────────────────
    // Объявляем ДО первого использования в getSystemPrompt (token estimation,
    // см. ниже) и workerData. oneShotMode активирует read-only (ask) или
    // planning-режим на этот прогон, не меняя глобальные тогглы. planning имеет
    // приоритет над ask (он строже — требует <plan>).
    const effectivePlanningMode = !!params.planningMode || params.oneShotMode === 'plan'
    const effectiveAskMode = !!params.askMode
      || params.slashCommand?.name === 'ask'
      || params.oneShotMode === 'ask'

    // §secrets — защищённые переменные: резолвим ОДИН раз на прогон.
    // 1) tool-результаты в истории из БД маскируются (шаги, записанные до
    //    фикса onStep-маскировки в Agent, могли сохранить сырые значения);
    // 2) map уходит в worker для подстановки ${{KEY}} в аргументы тулов.
    // Инкогнито — секреты не резолвим вовсе (приватность).
    let secretValuesMap: Record<string, string> | undefined
    if (!params.incognito) {
      try {
        const resolvedSecrets = resolveActive()
        if (resolvedSecrets.length > 0) {
          secretValuesMap = {}
          for (const v of resolvedSecrets) {
            secretValuesMap[v.key] = v.value
          }
        }
      } catch { /* секреты не должны ломать чат */ }
    }
    const maskSecretsInHistory = (text: string): string => {
      if (!secretValuesMap) return text
      let result = text
      for (const [key, value] of Object.entries(secretValuesMap)) {
        if (!value || value.length < 2) continue
        const placeholder = secretPlaceholder(key)
        while (result.includes(value)) {
          result = result.replace(value, placeholder)
        }
      }
      return result
    }

    // Live-подмножество истории: сообщения ПОСЛЕ последнего compaction-divider'а.
    // Старые (summarized) сообщения остаются в БД (UI хранит всю историю),
    // но в контекст модели не грузятся — их заменяет summary в system prompt.
    // messageId тегируется здесь (на flatMap), чтобы compaction-логика могла
    // вычислить boundary (createdAt граничного Message) для divider'а без
    // удаления из БД.
    // Full history is retained for UI/export/undo, but AI only needs the live
    // tail after the latest compact divider. Preserve the original ASC order.
    const historyStarted = perfMark()
    // Ephemeral side/incognito sends must use their caller-provided history;
    // persistent sends query scoped DB history and exclude the user row saved above.
    const liveMessages = params.incognito
      ? getLiveMessages(history)
      : filterContextHistory(params.chatId, getMessagesAfterLatestCompactCached(params.chatId, userMsg.id), userMsg.id)
    perfEvent('chat.history.load', perfMark() - historyStarted)
    const rawHistory: ChatMessage[] = liveMessages.flatMap(m =>
      messageToContextMessages(m).map(cm => ({ ...cm, messageId: m.id })),
    )
    // §secrets — маскируем tool-результаты в истории: шаги в БД хранят output
    // тулов, и до фикса onStep-маскировки туда попадали сырые значения секретов
    // → история «возвращала» их модели на следующих ходах. Роль 'tool' —
    // только результаты тулов; user/assistant не трогаем (там свои тексты).
    if (secretValuesMap) {
      for (const cm of rawHistory) {
        if (cm.role === 'tool' && typeof cm.content === 'string') {
          cm.content = maskSecretsInHistory(cm.content)
        }
      }
    }
    log('[chat:send] chatId=%s history loaded: dbMsgs=%d liveMsgs=%d → contextMsgs=%d (after messageToContextMessages)',
      params.chatId, history.length, liveMessages.length, rawHistory.length)
    console.log('[chat.ipc] history loaded: dbMsgs=%d liveMsgs=%d contextMsgs=%d (chatId=%s)', history.length, liveMessages.length, rawHistory.length, params.chatId)

    let processedHistory = rawHistory
    let contextCompressed = false
    if (ctxSettings.rollingEnabled && rawHistory.length > 0) {
      const realContextWindow = getModelContextWindow(storeData)
      const rollingSettings = { ...ctxSettings, contextLimitTokens: realContextWindow }

      const summaryFn = async (systemPrompt: string, userContent: string): Promise<string> => {
        const aiClient = new AIClient(store)
        let result = ''
        try {
          await aiClient.streamChat(
            [{ role: 'user', content: userContent }],
            { onToken: (t) => { result += t }, onDone: () => {}, onError: () => {} },
            'summary',
            systemPrompt,
          )
          // streamChat вызывает onError() и возвращается БЕЗ throw —
          // result остаётся пустым. Проверяем и бросаем, чтобы catch
          // переключил на main-модель, а при повторном пустом —
          // applyRollingWindowAsync активировал механический fallback.
          if (!result) throw new Error('summary model returned empty')
        } catch {
          // Если summary-модель не сработала — fallback на main (модель чата)
          result = ''
          await aiClient.streamChat(
            [{ role: 'user', content: userContent }],
            { onToken: (t) => { result += t }, onDone: () => {}, onError: () => {} },
            'main',
            systemPrompt,
          )
          if (!result) throw new Error('main model returned empty')
        }
        return result
      }

      const result = await perfPhaseAsync('chat.rolling_window', () => applyRollingWindowAsync(rawHistory, rollingSettings, summaryFn, storedSummary || undefined, false), { messageCount: rawHistory.length })
      if (result.compressed) {
        // Сброс dedup-кэша auto-recall: после компакции модель теряет старый
        // контекст (старые сообщения заменены summary), старые auto-recall
        // результаты больше не видны — следующий follow-up инжектит как first.
        autoRecallInjectedKeys.delete(params.chatId)
        const triggerTokens = Math.floor(realContextWindow * ctxSettings.rollingTriggerPct / 100)
        log('[chat:send] rolling-window компакция chatId=%s: contextWindow=%d triggerTokens=%d(=%d%%) removed=%d сообщений',
          params.chatId, realContextWindow, triggerTokens, ctxSettings.rollingTriggerPct, result.removedCount)
        processedHistory = result.messages
        contextCompressed = true
        if (result.summaryContent && !params.incognito) {
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
          // Atomic: setChatSummary + divider save in one transaction.
          // Previously these were two separate writes — if the process
          // crashed between them (or an abort arrived mid-flight) the AI
          // got a divider pointing at a summary that was never persisted,
          // so getChatSummary() returned empty and the agent started the
          // next round with no memory of the conversation. Now both writes
          // commit together or not at all.
          const tokensBefore = perfPhase('chat.token_calc.before', () => estimateMessagesTokens(rawHistory), { messageCount: rawHistory.length })
          const tokensAfter = perfPhase('chat.token_calc.after', () => estimateMessagesTokens(result.messages), { messageCount: result.messages.length })
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
          try {
            getDB().transaction(() => {
              if (result.summaryContent) setChatSummary(params.chatId, result.summaryContent)
              saveMessage(divider)
            })()
          } catch (e) {
            log('[chat:send] compaction transaction failed: %s', (e as Error).message)
            throw e
          }

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

    // Freeze prompt inputs once per run so estimate and worker startup use the
    // same snapshot even if settings/memory change between asynchronous phases.
    const sendSystemPrompt = params.sideChatParentId
      ? undefined
      : await getSystemPrompt(dbChatId, params.incognito, params.oneShotSkill, effectivePlanningMode, effectiveAskMode)
    if (ctxSettings.tokenCounterEnabled) {
      const contextWindow = getModelContextWindow(storeData)
      const sysPrompt = sendSystemPrompt
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
      createdAt: Date.now(),
      bufferedText: '',
      bufferedThinking: '',
      bufferedThinkingMs: undefined,
      bufferedSteps: [],
      bufferedTodo: [],
      bufferedAgentStatus: null,
      bufferedRateLimitSec: 0,
      bufferedRetry: null,
      bufferedUsage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      streamingMs: 0,
      lastOutputAt: 0,
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
      imageParts: [] as Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }>,
      bufferedLiveState: { toolProgress: {}, spawnedAgents: [] },
      streamCheckpointTimer: null,
      checkpointDirty: false,
    }

    // ── UI-батчинг токенов: флеш накопленного перед любыми другими
    // событиями (step/done/thinking_done), чтобы порядок текста и шагов
    // в рендерере сохранялся. ──
    const UI_FLUSH_MS = 50
    const flushUiTokens = () => {
      if (run.uiFlushTimer) { clearTimeout(run.uiFlushTimer); run.uiFlushTimer = null }
      if (run.uiTokenBuf) {
        const text = run.uiTokenBuf
        win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
          chatId: run.chatId, msgId: run.msgId, token: text,
        })
        run.uiTokenBuf = ''
        // Plugins: message:delta (троттлинг 250мс внутри менеджера,
        // подписавшимся плагинам). Инкогнито не утекает.
        if (!isIncognitoRun) {
          try { getPluginManager().emitMessageDelta(run.chatId, text) } catch { /* ignore */ }
        }
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

    // ── Учёт фактического времени стриминга (для скорости ток/с) ──
    // Вызывается на каждый text/thinking-токен. Гэп между токенами > 3с —
    // это пауза (выполнение тулов, ожидание следующего раунда LLM), её НЕ
    // считаем. Итог: streamingMs ≈ чистое время генерации токенов.
    const OUTPUT_GAP_MAX_MS = 3000
    const noteOutputActivity = () => {
      const now = Date.now()
      if (run.lastOutputAt > 0) {
        const gap = now - run.lastOutputAt
        if (gap <= OUTPUT_GAP_MAX_MS) run.streamingMs += gap
        // gap > порога: новая волна генерации после тулов — не засчитываем
      }
      run.lastOutputAt = now
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
      finishReason: 'done' | 'stopped' | 'error' = 'done',
    ) => {
      if (run.doneSent) return
      run.doneSent = true
      // Останавливаем периодический checkpoint-таймер — финальный save
      // ниже перезапишет любую частичную запись полностью.
      if (run.streamCheckpointTimer) {
        clearInterval(run.streamCheckpointTimer)
        run.streamCheckpointTimer = null
      }
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
      if (summaryTaskId) {
        const state = getTaskSummaryState(params.chatId); const task = state.tasks.find(t => t.id === summaryTaskId)
        if (task) {
          task.status = finishReason === 'done' ? 'done' : finishReason === 'stopped' ? 'cancelled' : 'error'
          task.updatedAt = Date.now()
          const finalTodo = todoArr?.length ? todoArr : run.bufferedTodo.length ? run.bufferedTodo : task.todo
          task.todo = finalTodo.slice(0, 100).map(item => ({ text: String(item.text).slice(0, 300), status: item.status }))
          const completed = task.todo.filter(item => item.status === 'done').map(item => item.text)
          task.remaining = task.todo.filter(item => item.status === 'pending' || item.status === 'in_progress').map(item => item.text).join('; ').slice(0, 500) || undefined
          const facts = [
            completed.length ? `Сделано: ${completed.slice(0, 8).join('; ')}` : '',
            task.results.length ? `Результаты: ${task.results.slice(0, 5).map(item => item.title).join('; ')}` : '',
            task.checks.length ? `Проверки: ${task.checks.slice(0, 5).map(item => `${item.title} — ${item.status === 'passed' ? 'пройдена' : item.status === 'failed' ? 'ошибка' : 'не подтверждена'}`).join('; ')}` : '',
            task.changes.length ? `Изменено файлов: ${new Set(task.changes.map(item => item.path)).size}` : '',
            task.remaining ? `Осталось: ${task.remaining}` : '',
          ].filter(Boolean)
          task.summary = (facts.join('. ') || (task.status === 'cancelled' ? 'Работа остановлена; выполненные действия сохранены.' : 'Нет структурированных событий результата.')).slice(0, 1200)
          task.messageIds = task.messageIds.slice(-200)
          const next = upsertTaskSummary(task)
          emitTaskSummary(params.chatId, next)
        }
      }
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
      // Usage: приоритет — явный usage из done/error воркера; fallback —
      // накопленный в run.bufferedUsage из context_usage source:'real'
      // (при Стопе/краше воркер terminate()ится до отправки done — но сырые
      // суммы токенов уже доехали в main заранее, на каждом LLM-вызове).
      const effUsage = (usage && (usage.promptTokens != null || usage.completionTokens != null))
        ? usage
        : ((run.bufferedUsage.promptTokens > 0 || run.bufferedUsage.completionTokens > 0)
            ? {
                promptTokens: run.bufferedUsage.promptTokens || undefined,
                completionTokens: run.bufferedUsage.completionTokens || undefined,
                cacheReadTokens: run.bufferedUsage.cacheReadTokens || undefined,
                cacheWriteTokens: run.bufferedUsage.cacheWriteTokens || undefined,
              }
            : undefined)
      const assistantMsg: Message & { iterations?: unknown } = {
        id: assistantMsgId,
        chatId: params.chatId,
        role: 'assistant',
        content: fullText,
        // Финальный save — реальное время завершения ответа.
        // Checkpoint-таймер сохранял с run.createdAt (стабильный timestamp
        // для UPSERT), но финальный sendDone перезаписывает правильным.
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
        // Чистое время генерации (без тулов/обработки промпта) — для
        // честной скорости ток/с. 0/undefined → UI fallback на durationMs.
        streamingMs: run.streamingMs > 0 ? run.streamingMs : undefined,
        promptTokens: effUsage?.promptTokens,
        completionTokens: effUsage?.completionTokens,
        cacheReadTokens: effUsage?.cacheReadTokens,
        cacheWriteTokens: effUsage?.cacheWriteTokens,
        toolCallsCount: toolCallsCount > 0 ? toolCallsCount : undefined,
        // Как завершился turn: done/stopped/error — UI показывает бейдж
        // «Остановлено»/«Обрыв» на оборванных сообщениях.
        finishReason,
      }

      if (!params.incognito) saveMessage(assistantMsg)
      // Буфер стриминга отработал: финальная полная версия записана в messages.
      // Удаляем, чтобы краш-рекавери (historyCache) при следующей загрузке чата
      // не восстановил устаревшую частичную копию поверх финальной.
      deleteStreamingBuffer(assistantMsgId)
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
      // Автоимя чата: на первом сообщении, а если название тогда не
      // сгенерировалось (fast-модель лежала / сеть) — ретрай на следующих
      // сообщениях, пока титул остаётся дефолтным. Ручной rename снимает
      // ретрай (титул перестаёт быть DEFAULT_CHAT_TITLE).
      if (!params.incognito && (history.length === 0 || isChatTitleDefault(params.chatId))) {
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

      // Plugins: agent:status 'finished' + chat:completed (подписавшимся).
      if (!params.incognito) {
        try {
          getPluginManager().emitAgentStatus(params.chatId, 'finished')
          getPluginManager().emitChatCompleted(params.chatId)
        } catch { /* ignore */ }
      }

      // ── Notification overlay ──
      // Не показываем уведомление для incognito-чатов (приватность).
      // Agent_done показываем только если были toolCalls (агентный режим),
      // иначе — обычный ai_response.
      if (!params.incognito) {
        const nm = getNotificationManager()
        const hadToolCalls = (assistantMsg.toolSteps?.length ?? 0) > 0
        if (hadToolCalls) {
          nm?.push({
            type: 'agent_done',
            title: 'Задача выполнена',
            body: getChatTitleForNotif(params.chatId),
            priority: 'success',
            actions: [{ id: 'open', label: 'Открыть' }],
            chatId: params.chatId,
          })
        } else {
          nm?.push({
            type: 'ai_response',
            title: 'Ответ готов',
            body: getChatTitleForNotif(params.chatId),
            priority: 'info',
            actions: [{ id: 'open', label: 'Открыть' }],
            chatId: params.chatId,
          })
        }
      }

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

    // Plugins: сбор тулов запущенных плагинов для агента. Синхронно —
    // getActiveToolsForChat возвращает только тулы уже запущенных процессов.
    let pluginTools: Array<{ name: string; shortName: string; description: string; inputSchema: Record<string, unknown>; pluginId: string }> = []
    // Approval map: тулы плагинов с requiresApproval:true требуют подтверждения.
    const pluginApprovalMap: Record<string, boolean> = {}
    try {
      pluginTools = getPluginManager().getActiveToolsForChat({
        projectWorkdir: chatWorkdir,
        projectId: (() => {
          if (!chatWorkdir) return undefined
          return getAllProjects().find(p => p.workdir === chatWorkdir)?.id
        })(),
        isIncognito: isIncognitoRun,
      })
      for (const t of pluginTools) {
        if ((t as { requiresApproval?: boolean }).requiresApproval === true) {
          pluginApprovalMap[t.name] = true
        }
      }
    } catch (e) {
      console.error('[chat:send] plugins load failed:', (e as Error).message)
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
    // oneShotSkill инъектирует инструкции скилла в system prompt.
    // oneShotAllowedTools фильтрует schemas до указанного списка.
    // effectivePlanningMode/effectiveAskMode объявлены выше (до token
    // estimation) — workerData ниже использует эти значения.

    // §secrets — secretValuesMap резолвится ОДИН раз в начале прогона (до
    // построения истории — для маскировки tool-результатов) и переиспользуется
    // здесь для workerData.

    if (cancelledDelegatedStarts.has(assistantMsgId)) throw new Error('Delegated request cancelled during preparation')
    const worker = new Worker(workerPath, {
      workerData: {
        storeData,
        planningMode: effectivePlanningMode,
        askMode: effectiveAskMode,
        // Тумблер «Управление браузером»: browser_* тулы с первого раунда.
        // Включение посреди рана (request_access) — через мутацию тулсета
        // в воркере (enableBrowserToolsMidRun).
        browserMode: !!params.browserMode || getChatBrowserMode(params.chatId),
        workingMemory: currentWorkingMemory,
        mode: chatMode,
        catalogCachePath,
        // Снапшот кэша gateway-моделей — worker не может фетчить сам
        // (gateway:fetchModels только в main), а getModelContextWindow для
        // 'syntee-gateway' берёт contextWindow из этого кэша.
        gatewayModels: getGatewayModelsCache(),
        modelId: mainAssignment?.modelId,
        providerId: mainAssignment?.providerId,
        // Свежий токен с авто-refresh: воркер не может рефрешить сам
        // (electron-store/tokenStore в worker_threads недоступны).
        gatewayToken: await getGatewayAuthToken().catch(() => getAccessToken()),
        fileCacheSnapshot: getFileCacheSnapshot(params.chatId),
        workdir: chatWorkdir,
        // userData path — для fallback-поиска картинок-вложений в
        // draft-attachments, когда AI вызывает analyze_image с именем
        // файла-вложения (без полного пути).
        userDataPath: app.getPath('userData'),
        verificationCommand,
        projectId: fastContextProjectId,
        fastContextDbPath,
        fastContextWasmDir,
        mcpTools,
        mcpApprovalMap,
        pluginTools,
        pluginApprovalMap,
        // Защищённые переменные: key → decrypted value. Worker строит Map и
        // передаёт в Agent/ToolDispatcher для подстановки ${{KEY}} в аргументы
        // тулов и обратной маскировки значений в результатах.
        secretValues: secretValuesMap,
      },
      env: process.env,
    })
    attachBrowserWorkerBroker(worker, async (payload, signal) => {
      const { browserManager } = await import('../managers/BrowserManager')
      if (signal.aborted || run.doneSent) return { success: false, error: 'Browser run stopped.' }
      // Preserve args, locator, frame/snapshot ids and all future backend fields.
      // BrowserManager owns action gating and live access revocation.
      return browserManager.execute(params.chatId, { ...payload, action: String(payload.action ?? '') } as Parameters<typeof browserManager.execute>[1], signal)
    })
    run.worker = worker
    activeRuns.set(params.chatId, run)

    // Plugins: хук chat:message — fire-and-forget, не блокирует чат.
    // Инкогнито-чаты не отправляются плагинам (приватность).
    if (!isIncognitoRun) {
      try {
        getPluginManager().emitChatMessage(params.chatId, params.content ?? '', {
          role: 'user',
          messageId: userMsg.id,
          attachments: (userMsg.attachments ?? []).map(a => ({ name: a.name, kind: a.kind, path: a.path })),
        })
        // agent:status 'started' — подписавшимся плагинам.
        getPluginManager().emitAgentStatus(params.chatId, 'started')
      } catch { /* плагины недоступны — не роняем чат */ }
    }

    // ── Периодический checkpoint стриминга в БД (каждые 8 сек) ──
    // При жёстком краше процесса (SIGSEGV, kill -9, OOM, BSOD) ни before-quit,
    // ни worker.on('exit'), ни uncaughtException не гарантированно срабатывают.
    // Без этого таймера весь накопленный bufferedText/steps/thinking живёт
    // только в RAM и теряется безвозвратно. С таймером максимум потерь = 3с.
    // Пишем в streaming_buffers (БЕЗ FTS-триггеров): INSERT OR REPLACE в
    // messages пересобирал messages_fts на каждый чекпоинт (синхронная
    // переиндексация всего content) → фризы main на слабых машинах.
    // Финальный sendDone пишет полную версию в messages и удаляет буфер;
    // после краша буфер переносится в messages при загрузке чата (краш-рекавери).
    // 8 секунд заметно снижают sync SQLite/JSON пики на слабых дисках,
    // сохраняя recovery почти в реальном времени.
    run.streamCheckpointTimer = setInterval(() => {
      if (run.doneSent) return
      // Dirty-flag: пропускаем запись если с последнего checkpoint'а
      // не было новых токенов/шагов/thinking. Без этого каждые 3с таймер
      // делал buildFinalIters + JSON.stringify всех steps + saveMessage даже
      // когда воркер ждёт ответа API (bufferedText не растёт) → main
      // блокировался пустой сериализацией на чатах с тяжёлыми tool-вызовами.
      if (!run.checkpointDirty) return
      const hasContent = run.bufferedText.trim() || run.bufferedSteps.length > 0 || run.bufferedThinking.trim()
      if (!hasContent) return
      try {
        const iters = buildFinalIters(run)
        const safeSteps = run.bufferedSteps.length > 0 ? ensureToolResults(run.bufferedSteps) : undefined
        const checkpointMsg: Message & { iterations?: unknown } = {
          id: assistantMsgId,
          chatId: params.chatId,
          role: 'assistant',
          content: run.bufferedText,
          createdAt: run.createdAt,
          isPinned: 0,
          model: (storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
            ?.find(a => a.role === 'main')?.modelId || 'claude-sonnet-4-6',
          toolSteps: safeSteps && safeSteps.length > 0 ? safeSteps as never : undefined,
          iterations: iters && iters.length > 0 ? iters as never : undefined,
          thinking: run.bufferedThinking || undefined,
          thinkingMs: run.bufferedThinkingMs,
          todo: run.bufferedTodo.length > 0 ? run.bufferedTodo : undefined,
          attachmentResult: run.attachmentResult ?? undefined,
          durationMs: Date.now() - run.startedAt,
        }
        // Только в буфер, не в messages: чекпоинты не должны дёргать
        // FTS5-триггеры каждые 3с. Incognito не пишем вообще.
        if (!params.incognito) saveStreamingBuffer(assistantMsgId, params.chatId, JSON.stringify(checkpointMsg))
        run.checkpointDirty = false
      } catch (e) {
        log('[streamCheckpoint] failed chatId=%s: %s', params.chatId, (e as Error).message)
      }
    }, 8000)
    // unref — таймер не держит процесс alive при выходе
    if (typeof run.streamCheckpointTimer.unref === 'function') run.streamCheckpointTimer.unref()

    // Эмитим стартовый статус для сайдбара (spinner).
    emitRunStatus(win, params.chatId, 'running', assistantMsgId)

    // ── Обработка вложений (до старта воркера) ──────────────────────────────
    // Если есть attachments — обрабатываем их:
    //  - текстовые файлы инлайним в content
    //  - картинки: vision-модель → direct pass (imageParts), text-only →
    //    описание от вспомогательной vision-модели
    // Заменяем params.content на augmented-версию для передачи в worker.
    // Результат сохраняем в run.attachmentResult — sendDone добавит его в
    // assistantMsg (поле в БД, UI-блок удалён).
    let effectiveContent = params.content
    // ── Реплай-цитаты ─────────────────────────────────────────────────────
    // Вложения реплайнутых сообщений уже слиты в params.attachments
    // (source:'reply') и обрабатываются общим пайплайном ниже. Текст исходных
    // сообщений цитируем поверх — AI видит, на что отвечает пользователь.
    // В истории (следующие ходы) ту же цитату восстановит
    // messageToContextMessages из userMsg.replyTo — формат един (formatReplyQuote).
    if (userMsg.replyTo?.length) {
      effectiveContent = `${formatReplyQuote(userMsg.replyTo)}\n\n${effectiveContent}`
    }
    if (params.attachments && params.attachments.length > 0) {
      // AbortController для прерывания обработки вложений при chat:stop.
      // Воркер ещё не создан, terminate() не помогает — нужен отдельный signal.
      const attachmentAbort = new AbortController()
      run.attachmentAbort = attachmentAbort
      try {
        // Promise.race с таймаутом 2 минуты — если processAttachmentsAndStream
        // зависнет (vision-модель не отвечает, Promise.all висит), не блокируем
        // весь чат навсегда. Таймаут в analyzeImage (60с) покрывает стрим, но
        // для надёжности добавляем общий потолок на все вложения.
        const ATTACHMENT_TIMEOUT_MS = 120_000
        const processed = await Promise.race([
          processAttachmentsAndStream(
            // effectiveContent (не params.content): уже может содержать
            // реплай-цитату поверх — инлайн-блоки файлов добавляются после неё.
            win, params.chatId, assistantMsgId, effectiveContent, params.attachments,
          ),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('Таймаут обработки вложений')), ATTACHMENT_TIMEOUT_MS)
            // Очистка таймера если abort сработал раньше
            attachmentAbort.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Обработка вложений прервана')) })
          }),
        ])
        effectiveContent = processed.content
        run.attachmentResult = processed.result
        run.imageParts = processed.imageParts
      } catch (e) {
        log('[runChatSend] processAttachments failed: %s', (e as Error).message)
        // Продолжаем с исходным content — лучше чем уронить весь запрос
      } finally {
        run.attachmentAbort = undefined
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
          run.checkpointDirty = true
          noteOutputActivity()
          // Батчинг: IPC пачкой раз в UI_FLUSH_MS, а не на каждый токен.
          run.uiTokenBuf += (msg.token as string) || ''
          scheduleUiFlush()
          break

        case 'thinking_token': {
          const tok = typeof msg.token === 'string' ? msg.token : ''
          run.bufferedThinking += tok
          run.pendingThinking += tok
          run.checkpointDirty = true
          noteOutputActivity()
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
          if (summaryTaskId && rawStep.type === 'tool_result' && ['publish_result', 'get_diagnostics', 'run_command'].includes(String(rawStep.toolName)) && msg.msgId === assistantMsgId && typeof rawStep.content === 'string') {
            const state = getTaskSummaryState(params.chatId); const task = state.tasks.find(t => t.id === summaryTaskId)
            if (task) {
              const output = rawStep.content.slice(0, 4000)
              if (rawStep.toolName === 'publish_result' && rawStep.success === true) {
                try {
                  const parsed = JSON.parse(output) as { taskSummaryResult?: { title?: string; kind?: 'file'|'url'|'image'; target?: string } }
                  const result = parsed.taskSummaryResult
                  if (typeof result?.title === 'string' && typeof result.target === 'string' && ['file', 'url', 'image'].includes(result.kind ?? '')) {
                    task.results = task.results.filter(item => item.target !== result.target)
                    task.results.unshift({ id: uuid(), title: result.title.slice(0, 120), kind: result.kind!, target: result.target.slice(0, 2000), messageId: assistantMsgId })
                  }
                } catch { /* malformed publication is not an artifact */ }
              }
              const toolName=String(rawStep.toolName||'')
              if (toolName === 'get_diagnostics') {
                const unknown = /DIAGNOSTICS_UNKNOWN|check DID NOT run completely|не удалось определить/i.test(output)
                const errorCount = output.match(/Found\s+(\d+)\s+errors?/i)?.[1]
                const hasErrors = (errorCount !== undefined && Number(errorCount) > 0) || /\[.+\] ERROR /i.test(output)
                const status = classifyDiagnosticOutcome({ supported: !unknown, completed: rawStep.success === true && !unknown, executionFailed: unknown, findingsFailed: hasErrors })
                task.checks.unshift({ id: uuid(), title: 'Диагностика', status, detail: output.replace(/DIAGNOSTICS_UNKNOWN:\s*/g, '').slice(0, 6000), messageId: assistantMsgId })
              }
              if (toolName === 'run_command') {
                const args = run.toolCallArgsCache.get(String(rawStep.callId || ''))?.args
                const command = String(args?.command || '')
                if (isVerificationCommand(command)) {
                  const exitCode = output.match(/^\[exit: (-?\d+)\]/m)?.[1]
                  const status = exitCode === undefined ? 'unknown' : Number(exitCode) === 0 && rawStep.success === true ? 'passed' : 'failed'
                  task.checks.unshift({ id: uuid(), title: command.slice(0, 100), status, detail: output.slice(-6000), messageId: assistantMsgId })
                }
              }
              task.results=task.results.slice(0,30); task.checks=task.checks.slice(0,30); task.updatedAt=Date.now(); const next=upsertTaskSummary(task); broadcastTaskSummary?.(params.chatId, next)
            }
          }
          // tool_call_pending — временный ранний сигнал для UI (см. Agent.ts
          // onToolCallStarted), заменяется настоящим tool_call через
          // pendingCallId матчинг на фронтенде. Не персистим в bufferedSteps —
          // иначе попал бы в БД как "фантомный" шаг (зеркало ai-worker.ts:273-280).
          if (rawStep.type === 'tool_result_update') {
            // Mirror the worker's in-place update for checkpoints/Stop/quit paths.
            // Never persist an update event as a new tool result/iteration.
            const apply = (saved: unknown) => {
              const result = saved as Record<string, unknown>
              if (result.type !== 'tool_result' || !rawStep.callId || result.callId !== rawStep.callId) return
              if (rawStep.visualAnalysis) result.visualAnalysis = rawStep.visualAnalysis
              if (rawStep.imagePaths) result.imagePaths = rawStep.imagePaths
              if (rawStep.success !== undefined) result.success = rawStep.success
            }
            run.bufferedSteps.forEach(apply)
            run.currentIterSteps.forEach(apply)
            run.closedIters.forEach(iter => (iter as { steps: unknown[] }).steps.forEach(apply))
            run.checkpointDirty = true
          } else if (rawStep.type !== 'tool_call_pending') {
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
              imagePaths: rawStep.imagePaths,
              visualAnalysis: rawStep.visualAnalysis,
              diff: rawStep.diff,
              callId: rawStep.callId,
              pendingCallId: rawStep.pendingCallId,
              serverName: rawStep.serverName,
            }
            run.bufferedSteps.push(ts)
            if (summaryTaskId && rawStep.type === 'tool_result' && rawStep.success === true && (rawStep.toolName === 'edit_file' || rawStep.toolName === 'write_file') && msg.msgId === assistantMsgId) {
              const state = getTaskSummaryState(params.chatId); const task = state.tasks.find(t => t.id === summaryTaskId); const args=run.toolCallArgsCache.get(String(rawStep.callId||''))?.args; const rel=typeof args?.path==='string'?args.path:''
              if(task && rel){ const diff=typeof rawStep.diff==='string'?rawStep.diff:typeof rawStep.content==='string'?rawStep.content:''; const existing=task.changes.find(c=>c.path===rel); if(existing){ existing.diff=[existing.diff,diff].filter(Boolean).join('\n\n--- subsequent patch ---\n\n').slice(-12000)||undefined; existing.messageId=assistantMsgId; task.changes=task.changes.filter(c=>c!==existing); task.changes.unshift(existing) } else task.changes.unshift({path:rel.slice(0,500),diff:diff.slice(-12000)||undefined,messageId:assistantMsgId}); task.changes=task.changes.slice(0,50); task.updatedAt=Date.now(); const next=upsertTaskSummary(task); broadcastTaskSummary?.(params.chatId, next) }
            }
            run.checkpointDirty = true
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
          // с args (из кэша) + result/error. Скрытые тулы (update_working_memory/
          // update_todo) не логируем — они не tool actions в смысле agent_outcome.
          if (!params.incognito) {
            const stepType = rawStep.type as string
            const stepToolName = rawStep.toolName as string | undefined
            const stepCallId = rawStep.callId as string | undefined
            const HIDDEN_TOOLS = new Set(['update_working_memory', 'update_todo'])
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
          refreshDelegationSummary?.(params.chatId, assistantMsgId)
          // Форвард в ActivityManager (overlay-информер активности)
          getActivityManager()?.onStep({ ...(msg.step as object), msgId: msg.msgId, chatId: msg.chatId })
          break
        }

        case 'confirm': {
          const { reqId, toolName, args } = msg as { reqId: string; toolName: string; args: Record<string, unknown>; dangerLevel?: string; dangerReason?: string; previewDiff?: string }
          // Регистрируем callback в глобальной Map — NotificationManager
          // вызовет resolveConfirm() напрямую (тот же процесс, без IPC).
          confirmCallbacks.set(reqId, (approved: boolean, always?: string, toolWide?: boolean) => {
            const grant = persistApprovalGrant(store, { toolName, args, chatId: params.chatId, projectId: fastContextProjectId, workdir: chatWorkdir, approved, always, toolWide })
            worker.postMessage({ type: 'confirm_reply', replyId: `confirm-reply-${reqId}`, approved, always: grant?.scope, match: grant?.match })
          })
          // ipcMain.once — для главного окна (AgentConfirmDialog шлёт через ipcRenderer.send)
          ipcMain.once(`agent:confirm:response:${reqId}`, (_, approved: boolean, always?: string, toolWide?: boolean) => {
            const cb = confirmCallbacks.get(reqId)
            if (cb) { confirmCallbacks.delete(reqId); cb(approved, always, toolWide) }
          })
          win?.webContents.send('agent:confirm', {
            reqId, toolName, args,
            dangerLevel: msg.dangerLevel,
            dangerReason: msg.dangerReason,
            previewDiff: msg.previewDiff,
          })
          // ── Notification overlay: запрос разрешения ──
          const nm = getNotificationManager()
          const dangerLevel = (msg as { dangerLevel?: string }).dangerLevel
          const toolLabel = toolName === 'run_command' ? 'Команда' : toolName === 'write_file' ? 'Запись файла' : toolName === 'edit_file' ? 'Правка файла' : toolName
          nm?.push({
            type: 'permission',
            title: `Запрос разрешения: ${toolLabel}`,
            body: (msg as { dangerReason?: string }).dangerReason || `Агент хочет выполнить ${toolName}`,
            priority: dangerLevel === 'high' ? 'urgent' : 'warning',
            actions: [
              { id: 'approve', label: 'Разрешить' },
              { id: 'deny', label: 'Отклонить' },
            ],
            reqId,
            chatId: msg.chatId,
          })
          break
        }

        case 'question': {
          // ask_user-тул: AI задаёт уточняющие вопросы пользователю.
          const reqId = msg.reqId as string
          const questions = msg.questions as import('../../shared/types').QuestionSpec[]
          // Глобальный callback Map — для notification overlay
          questionCallbacks.set(reqId, (answers: import('../../shared/types').QuestionAnswer[]) => {
            worker.postMessage({ type: 'question_reply', replyId: `question-reply-${reqId}`, answers })
          })
          // ipcMain.once — для главного окна (QuestionPanel)
          ipcMain.once(`agent:question:response:${reqId}`, (_e, answers: import('../../shared/types').QuestionAnswer[]) => {
            const cb = questionCallbacks.get(reqId)
            if (cb) { questionCallbacks.delete(reqId); cb(answers) }
          })
          win?.webContents.send('agent:question', {
            reqId, questions, chatId: msg.chatId, msgId: msg.msgId,
          })
          // ── Notification overlay: вопрос от агента ──
          // Простая кнопка "Открыть" — разворачивает приложение.
          // Ответ пользователь даёт в самом приложении (QuestionPanel).
          const nm = getNotificationManager()
          const firstQ = questions[0]
          if (firstQ) {
            nm?.push({
              type: 'ask_user',
              title: firstQ.header || 'Вопрос от агента',
              body: firstQ.question,
              priority: 'warning',
              actions: [{ id: 'open', label: 'Открыть' }],
              reqId,
              chatId: msg.chatId,
            })
          }
          break
        }

        case 'agent_status':
          run.bufferedAgentStatus = msg.text as string
          win?.webContents.send('agent:status', { msgId: msg.msgId, chatId: msg.chatId, text: msg.text })
          break

        case 'todo_update':
          run.bufferedTodo = msg.items as typeof run.bufferedTodo
          run.checkpointDirty = true
          if (summaryTaskId && msg.msgId === assistantMsgId) {
            const state = getTaskSummaryState(params.chatId); const task = state.tasks.find(t => t.id === summaryTaskId)
            if (task) { task.todo = run.bufferedTodo.slice(0, 100).map(x => ({ text: String(x.text).slice(0, 300), status: x.status })); task.updatedAt = Date.now(); const next = upsertTaskSummary(task); broadcastTaskSummary?.(params.chatId, next) }
          }
          win?.webContents.send('agent:todo', { msgId: msg.msgId, chatId: msg.chatId, items: msg.items })
          break

        case 'tool_progress':
          // Progress для долгих тулов (get_fast_context) — live-индикация этапов.
          // Не персистим в БД (ephemeral), только в live state renderer'а.
          // Накапливаем в ActiveRun.bufferedLiveState чтобы при переключении
          // чата и возврате hydrateFromMain мог восстановить прогресс.
          {
            const tpRun = activeRuns.get(msg.chatId as string)
            if (tpRun) {
              tpRun.bufferedLiveState.toolProgress = {
                ...tpRun.bufferedLiveState.toolProgress,
                [msg.toolName as string]: {
                  stage: msg.stage as string,
                  detail: msg.detail as string | undefined,
                  sessionId: msg.sessionId as string | undefined,
                  filesProcessed: msg.filesProcessed as number | undefined,
                  filesTotal: msg.filesTotal as number | undefined,
                  filesFound: msg.filesFound as Array<{ path: string; score: number; why: string }> | undefined,
                  ts: Date.now(),
                },
              }
            }
          }
          win?.webContents.send('agent:tool_progress', {
            msgId: msg.msgId, chatId: msg.chatId,
            toolName: msg.toolName, stage: msg.stage, detail: msg.detail,
            filesProcessed: msg.filesProcessed, filesTotal: msg.filesTotal,
            filesFound: msg.filesFound,
          })
          // Форвард в ActivityManager (overlay-информер активности)
          getActivityManager()?.onToolProgress({
            msgId: msg.msgId, chatId: msg.chatId,
            toolName: msg.toolName, stage: msg.stage, detail: msg.detail,
            filesProcessed: msg.filesProcessed, filesTotal: msg.filesTotal,
          })
          break

        case 'spawn_agent': {
          ;(async () => {
            // Эмитим agent:spawn ДО запуска суб-агента — renderer сразу
            // показывает live-карточку на позиции tool_call'а (маппинг по
            // callId из live-итерации), не дожидаясь финального tool_result.
            // Накапливаем в ActiveRun.bufferedLiveState чтобы при переключении
            // чата и возврате hydrateFromMain мог восстановить карточки.
            const saRun = activeRuns.get(msg.chatId as string)
            if (saRun) {
              const agentId = msg.id as string
              if (!saRun.bufferedLiveState.spawnedAgents.some(a => a.agentId === agentId)) {
                saRun.bufferedLiveState.spawnedAgents = [...saRun.bufferedLiveState.spawnedAgents, {
                  agentId,
                  callId: msg.callId as string | undefined,
                  task: msg.task as string,
                  msgId: msg.msgId as string,
                  model: msg.model as string | undefined,
                  role: (msg.role as string | undefined) ?? 'implementer',
                  ts: Date.now(),
                }]
              }
            }
            win?.webContents.send('agent:spawn', {
              agentId: msg.id as string,
              task: msg.task as string,
              callId: msg.callId as string | undefined,
              msgId: msg.msgId as string,
              chatId: msg.chatId as string,
              model: msg.model as string | undefined,
              role: (msg.role as string | undefined) ?? 'implementer',
              ts: Date.now(),
            })
            const parentSummary = getChatSummary(msg.chatId as string)
            const parentWorkingMemory = getWorkingMemory(msg.chatId as string)
            const subModeIntro = `Сначала пойми релевантный код и ограничения, потом выполни только свою часть работы.

Ты суб-агент, а не основной агент. Будь эффективным:
- Делай только то, что нужно для задачи — не исследуй лишнее.
- Используй минимальное количество tool calls. Не повторяй уже сделанные действия.
- Не читай файлы «для полноты картины» — только те, что нужны для задачи.
- Как только задача выполнена — сразу давай финальный ответ, не продолжай исследовать.`
            const subModeOutro = `Финальный ответ дай по существу, без искусственного ограничения длины:
- что найдено или сделано
- какие файлы важны (пути + ключевые строки)
- какие есть риски или следующий шаг
Не включай рассуждения, только результат.`
            // §roles — role injection в system prompt суб-агента
            const roleDef = getSubagentRole(msg.role as string | undefined)
            const roleLabel = roleDef.id !== 'implementer' ? ` (${roleDef.nameEn})` : ''
            // Every role, including the default implementer, must receive its
            // specialized instructions. Previously implementer was omitted,
            // making its role prompt effectively dead code.
            const spawnResult = await agentManager.spawn({
              id: msg.id as string,
              parentId: msg.msgId as string,
              chatId: msg.chatId as string,
              task: msg.task as string,
              model: msg.model as string | undefined,
              approvalMode: msg.approval_mode as 'auto' | 'ask' | 'full' | undefined,
              isolation: msg.isolation as 'auto' | 'worktree' | 'none' | undefined,
              role: msg.role as string | undefined,
              mode: chatMode,
              storeData,
              context: {
                systemPrompt: `Ты суб-агент${roleLabel}. Твоя задача: ${msg.task as string}
\n${roleDef.systemPromptInjection}
\nКонтекст родителя:
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

        case 'manage_chats': {
          void (async () => {
            // Trust run context, not model-provided IDs or permission overrides.
            if (run.doneSent || activeRuns.get(params.chatId) !== run) return
            const requestedTools = Array.isArray(msg.allowedTools) ? msg.allowedTools as string[] : []
            const allowedTools = sideToolSchemas.map(t => t.function.name)
            // request_access can enable browser tools in this worker during the run.
            if (getChatBrowserMode(params.chatId)) {
              for (const name of requestedTools) {
                if (name.startsWith('browser_') && !allowedTools.includes(name)) allowedTools.push(name)
              }
            }
            const result = await executeManageChats(msg.payload as import('../../shared/delegatedChats').ManageChatsParams, {
              chatId: params.chatId,
              sourceMessageId: assistantMsgId,
              modelId: mainAssignment?.modelId,
              providerId: mainAssignment?.providerId,
              reasoningValue: storeData.reasoningValue as string | undefined,
              planningMode: effectivePlanningMode,
              askMode: effectiveAskMode,
              allowedTools,
              incognito: !!params.incognito,
            }, {
              send: sendChatMessageProgrammatic,
              stop: (chatId, requestId) => chatStopImpl?.(chatId, requestId) ?? false,
              changed: (chatId) => {
                win?.webContents.send('chat:delegated-changed', { chatId })
                if (summaryTaskId) broadcastTaskSummary?.(params.chatId, getTaskSummaryState(params.chatId))
              },
            })
            if (!run.doneSent) worker.postMessage({ type: 'manage_chats_reply', replyId: msg.replyId, result })
          })().catch(e => {
            if (!run.doneSent) worker.postMessage({ type: 'manage_chats_reply', replyId: msg.replyId,
              result: { success: false, output: '', error: String(e) } })
          })
          break
        }
        // ── Dots: manage_dots-тул агента (round-trip worker → DotManager) ──
        // Форматирование отчёта здесь же, в main — воркер получает готовый text.
        case 'manage_dots': {
          ;(async () => {
            const reply = (result: { success: boolean; error?: string; text?: string }) => {
              worker.postMessage({ type: 'manage_dots_reply', replyId: msg.replyId, result })
            }
            try {
              // Динамический импорт: DotManager статически импортирует
              // sendChatMessageProgrammatic отсюда — статический импорт
              // создал бы цикл (spaRenderer использует тот же паттерн).
              const { dotManager } = await import('../managers/DotManager')
              const p = (msg.payload ?? {}) as {
                action?: string
                dotId?: string
                name?: string
                purpose?: string
                rules?: string
                scheduleKind?: 'cron' | 'interval'
                scheduleValue?: string
                watchPaths?: string[]
                webhookEnabled?: boolean
                modelId?: string | null
                modelProvider?: string | null
                enabled?: boolean
                icon?: string
                color?: string
              }
              const action = p.action ?? ''

              /** Dot по dot_id или точному имени (регистронезависимо). */
              const findDot = (): Dot | null => {
                const dots = dotManager.getDots()
                if (p.dotId) {
                  const byId = dots.find(d => d.id === p.dotId)
                  if (byId) return byId
                }
                if (p.name) {
                  const nm = p.name.trim().toLowerCase()
                  return dots.find(d => d.name.toLowerCase() === nm) ?? null
                }
                return null
              }

              const fmtDot = (d: Dot): string => {
                const st = d.state
                const lines = [
                  `«${d.name}» (id: ${d.id}) — ${st.status}${d.enabled ? '' : ' (выключен)'}`,
                  `Задача: ${d.purpose}`,
                ]
                if (d.rules) lines.push(`Правила: ${d.rules}`)
                if (d.schedule) {
                  lines.push(
                    `Расписание: ${d.schedule.kind} '${d.schedule.value}'`
                    + (st.nextRunAt ? ` (следующее: ${new Date(st.nextRunAt).toLocaleString('ru-RU')})` : ''),
                  )
                }
                if (d.watchPaths && d.watchPaths.length > 0) lines.push(`Наблюдение: ${d.watchPaths.join(', ')}`)
                if (d.webhookEnabled) lines.push(`Webhook: ${dotManager.getWebhookUrl(d.id)}`)
                lines.push(`Модель: ${d.modelId ?? 'глобальная модель Dots'}`)
                lines.push(
                  `Раны: ${st.runCount} (отчёты ${st.reportCount}, тихие ${st.silentCount}, ошибки ${st.errorCount})`
                  + (st.lastRunAt ? `, последний: ${new Date(st.lastRunAt).toLocaleString('ru-RU')} (${st.lastRunTrigger ?? '?'})` : ''),
                )
                if (st.lastError) lines.push(`Последняя ошибка: ${st.lastError}`)
                return lines.join('\n')
              }

              if (action === 'create') {
                const dot = dotManager.createDot({
                  name: p.name ?? '',
                  icon: p.icon ?? 'bot',
                  color: p.color ?? '#7c6cff',
                  purpose: p.purpose ?? '',
                  rules: p.rules,
                  schedule: p.scheduleKind ? { kind: p.scheduleKind, value: p.scheduleValue ?? '' } : undefined,
                  watchPaths: p.watchPaths,
                  webhookEnabled: p.webhookEnabled,
                  modelId: p.modelId ?? undefined,
                  modelProvider: p.modelProvider ?? undefined,
                })
                // Тост: DOTS_CHANGED с payload (dots.store payload игнорирует,
                // App.tsx тостит только source:'agent' — UI-визард не дублируется).
                win?.webContents.send(IPC_EVENTS.DOTS_CHANGED, { source: 'agent', action: 'create', name: dot.name })
                reply({
                  success: true,
                  text: `Dot создан.\n${fmtDot(dot)}\n\nDot живёт на странице «Dots»: спит в фоне, просыпается по триггеру и пишет отчёты в свой чат «Dot · ${dot.name}». Если триггеры не заданы — будить только вручную (action: wake или кнопка «Разбудить»).`,
                })
              } else if (action === 'list') {
                const dots = dotManager.getDots()
                if (dots.length === 0) {
                  reply({ success: true, text: 'Dot\'ов пока нет. Создать можно через manage_dots action=create (name + purpose обязательны).' })
                } else {
                  reply({ success: true, text: `Dot'ы (${dots.length}):\n\n${dots.map((d, i) => `${i + 1}. ${fmtDot(d)}`).join('\n\n')}` })
                }
              } else if (action === 'get') {
                const dot = findDot()
                if (!dot) { reply({ success: false, error: 'Dot не найден (передай dot_id из list или точное имя)' }); return }
                const runs = dotManager.getRuns(dot.id, 10)
                const runsText = runs.length === 0
                  ? 'Ранов ещё не было.'
                  : `Последние раны:\n${runs.map(r => `- ${new Date(r.startedAt).toLocaleString('ru-RU')} [${r.trigger}] ${r.status}${r.summary ? `: ${r.summary.slice(0, 120)}` : ''}`).join('\n')}`
                reply({ success: true, text: `${fmtDot(dot)}\n\n${runsText}` })
              } else if (action === 'update') {
                const dot = findDot()
                if (!dot) { reply({ success: false, error: 'Dot не найден (передай dot_id из list или точное имя)' }); return }
                const patch: Partial<DotConfig> = {}
                if (p.name !== undefined) patch.name = p.name
                if (p.purpose !== undefined) patch.purpose = p.purpose
                if (p.rules !== undefined) patch.rules = p.rules
                if (p.scheduleKind !== undefined) {
                  patch.schedule = p.scheduleKind ? { kind: p.scheduleKind, value: p.scheduleValue ?? '' } : undefined
                }
                if (p.watchPaths !== undefined) patch.watchPaths = p.watchPaths
                if (p.webhookEnabled !== undefined) patch.webhookEnabled = p.webhookEnabled
                if (p.modelId !== undefined) patch.modelId = p.modelId
                if (p.modelProvider !== undefined) patch.modelProvider = p.modelProvider
                if (p.enabled !== undefined) patch.enabled = p.enabled
                if (p.icon !== undefined) patch.icon = p.icon
                if (p.color !== undefined) patch.color = p.color
                const updated = dotManager.updateDot(dot.id, patch)
                reply({ success: true, text: `Dot обновлён.\n${fmtDot(updated)}` })
              } else if (action === 'delete') {
                const dot = findDot()
                if (!dot) { reply({ success: false, error: 'Dot не найден (передай dot_id из list или точное имя)' }); return }
                dotManager.deleteDot(dot.id)
                win?.webContents.send(IPC_EVENTS.DOTS_CHANGED, { source: 'agent', action: 'delete', name: dot.name })
                reply({ success: true, text: `Dot «${dot.name}» удалён (вместе с его чатом «Dot · ${dot.name}»).` })
              } else if (action === 'wake') {
                const dot = findDot()
                if (!dot) { reply({ success: false, error: 'Dot не найден (передай dot_id из list или точное имя)' }); return }
                dotManager.runNow(dot.id)
                reply({ success: true, text: `Dot «${dot.name}» разбужен — ран запущен. Отчёт появится в его чате «Dot · ${dot.name}» (или уведомлением, если есть что сказать).` })
              } else {
                reply({ success: false, error: `Неизвестный action: ${action}` })
              }
            } catch (e) {
              reply({ success: false, error: (e as Error).message })
            }
          })()
          break
        }

        // ── SPA-рендер через скрытый BrowserWindow (основной путь для SPA) ──
        // Worker просит main-процесс отрендерить JS-heavy страницу.
        // Main использует пул hidden BrowserWindow (персистентное окно),
        // грузит URL, ждёт network idle, извлекает HTML, отправляет обратно.
        // BrowserWindow доступен только в main-процессе.
        case 'render_page': {
          const replyId = msg.replyId as string
          const renderUrl = msg.url as string
          const waitSelector = msg.waitSelector as string | undefined
          const renderTimeoutMs = (msg.timeoutMs as number | undefined) ?? 25000
          const renderMsgId = msg.msgId as string
          const renderChatId = msg.chatId as string
          ;(async () => {
            try {
              // Live-прогресс в UI — стадия 'rendering'
              win?.webContents.send('agent:tool_progress', {
                msgId: renderMsgId, chatId: renderChatId,
                toolName: 'fetch_page', stage: 'rendering',
                detail: `Rendering: ${renderUrl}`,
                ts: Date.now(),
              })
              const { renderSpaPage } = await import('../tools/spaRenderer')
              const result = await renderSpaPage(renderUrl, { waitSelector, timeoutMs: renderTimeoutMs })
              win?.webContents.send('agent:tool_progress', {
                msgId: renderMsgId, chatId: renderChatId,
                toolName: 'fetch_page', stage: 'done',
                ts: Date.now(),
              })
              worker.postMessage({
                type: 'render_page_reply',
                replyId,
                html: result.html,
                title: result.title,
                text: result.text,
                apiEndpoints: result.apiEndpoints,
                error: result.error,
              })
            } catch (e: unknown) {
              const errMsg = e instanceof Error ? e.message : String(e)
              win?.webContents.send('agent:tool_progress', {
                msgId: renderMsgId, chatId: renderChatId,
                toolName: 'fetch_page', stage: 'error',
                ts: Date.now(),
              })
              worker.postMessage({
                type: 'render_page_reply',
                replyId,
                html: '',
                error: errMsg,
              })
            }
          })()
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

        case 'plugin_call': {
          ;(async () => {
            try {
              // Событие tool:call для плагинов (fire-and-forget).
              try { getPluginManager().emitToolCall(msg.toolName as string, (msg.args as Record<string, unknown>) ?? {}) } catch { /* ignore */ }
              const result = await getPluginManager().callToolByName(
                msg.toolName as string,
                (msg.args as Record<string, unknown>) ?? {},
              )
              // Хук tool:result — плагины могут модифицировать результат
              // до того, как его увидит модель.
              let output = result.output
              try {
                output = await getPluginManager().runToolResultHook(
                  msg.toolName as string,
                  (msg.args as Record<string, unknown>) ?? {},
                  output,
                )
              } catch { /* хук не должен ломать вызов */ }
              worker.postMessage({
                type: 'plugin_call_reply',
                replyId: msg.replyId,
                success: result.success,
                output,
                error: result.error,
              })
            } catch (e) {
              worker.postMessage({
                type: 'plugin_call_reply',
                replyId: msg.replyId,
                success: false,
                output: '',
                error: (e as Error).message,
              })
            }
          })()
          break
        }

        case 'tool_call_event': {
          // Любой тул агента вызван (worker → main) → событие tool:call
          // всем запущенным плагинам. Fire-and-forget.
          try {
            getPluginManager().emitToolCall(msg.toolName as string, (msg.args as Record<string, unknown>) ?? {})
          } catch { /* ignore */ }
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
              worker.postMessage({
                type: 'get_skill_reply',
                replyId: msg.replyId,
                instructions: getSkillInstructions(allSkills, skillName),
              })
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
          // Retry on SQLITE_BUSY: previously a `catch { /* ok */ }` here
          // meant a transient lock silently discarded the agent's
          // working-memory update — the next round the AI saw stale
          // memory and could not understand why its notes were lost.
          try {
            const apply = () => {
              if (wMode === 'append') {
                const existing = getWorkingMemory(wChatId)
                setWorkingMemory(wChatId, existing ? existing + '\n' + wContent : wContent)
              } else {
                setWorkingMemory(wChatId, wContent)
              }
            }
            let attempt = 0
            for (; attempt < 3; attempt++) {
              try { apply(); break } catch (e: any) {
                const code = String(e?.code ?? e?.errno ?? '')
                const isBusy = code === '5' || code === '6' || e?.message?.toLowerCase().includes('database is locked')
                if (!isBusy || attempt === 2) throw e
                try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1)) } catch { /* SAB unavailable */ }
              }
            }
          } catch (e) {
            log('[update_working_memory] failed: %s', (e as Error).message)
          }
          break
        }

        // Agent записал/отредактировал файл — форвардим в renderer
        // для live-обновления открытых файловых табов (Monaco editor).
        case 'file_changed': {
          const filePath = msg.path as string
          if (filePath) {
            win?.webContents.send('file:changed', { path: filePath })
          }
          break
        }

        case 'save_memory': {
          ;(async () => {
            try {
              if (!getMemorySettings().enabled || (!getGlobalMemoryEnabled() && (msg.scope === 'global' || (!msg.scope && !msg.projectId)))) {
                worker.postMessage({ type: 'save_memory_reply', replyId: msg.replyId, success: false, error: 'Глобальная память выключена' })
                return
              }
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
              // Knowledge graph: heuristic extract из project_decision/convention
              if ((item.kind === 'project_decision' || item.kind === 'convention') && item.projectId) {
                try {
                  const r = incrementalUpdateDecision(item)
                  log('[chat:send] graph decision update: nodes=%d edges=%d', r.nodes, r.edges)
                } catch (e) {
                  log('[chat:send] graph decision update failed: %s', (e as Error).message)
                }

                // Async LLM extraction for richer connections (debounced, non-blocking)
                if (item.content.length > 100) {
                  ;(async () => {
                    try {
                      // Debounce: wait 3 sec before LLM extraction
                      await new Promise(r => setTimeout(r, 3000))
                      const { extractFromConversationLLM, saveExtractionToGraph } = await import('../../core/memory/graphExtractor')
                      const { extraction } = await extractFromConversationLLM(store, {
                        projectId: item.projectId!,
                        chatId: item.chatId ?? item.id,
                        summary: `${item.title}: ${item.content}`.slice(0, 4000),
                      })
                      if (extraction.nodes.length > 0 || extraction.edges.length > 0) {
                        const result = saveExtractionToGraph(item.projectId!, extraction)
                        log('[chat:send] graph LLM extraction: nodes=%d edges=%d', result.nodes, result.edges)
                      }
                    } catch (e) {
                      log('[chat:send] graph LLM extraction failed: %s', (e as Error).message)
                    }
                  })()
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
              const requestedScope = msg.scope as 'global' | 'project' | 'all' | undefined
              if (!getMemorySettings().enabled) {
                worker.postMessage({ type: 'recall_memory_reply', replyId: msg.replyId, success: false, results: [], error: 'Память Syntee выключена пользователем: чтение запрещено.' })
                return
              }
              if (!getGlobalMemoryEnabled() && requestedScope === 'global') {
                worker.postMessage({ type: 'recall_memory_reply', replyId: msg.replyId, success: false, results: [], error: 'Глобальная память выключена пользователем: чтение запрещено. Проектная память — отдельная область.' })
                return
              }
              const effectiveScope = requestedScope
              const results = await searchAllSources({
                query: msg.query as string,
                kind: msg.kind as 'user_fact' | 'project_decision' | 'convention' | 'conversation' | 'agent_outcome' | undefined,
                scope: effectiveScope,
                projectId: msg.projectId as string | undefined,
                limit: msg.limit as number | undefined,
                sources: msg.sources as 'all' | ('memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned')[] | undefined,
                crossProject: msg.crossProject as boolean | undefined,
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
        case 'manage_notes': {
          ;(async () => {
            try {
              const action = msg.action as 'create' | 'update' | 'delete' | 'list'
              const scope = msg.scope as 'project' | 'chat'
              const projectId = msg.projectId as string | undefined
              const chatId = msg.chatId as string | undefined

              if (action === 'list') {
                const notes = listNotes({ scope, projectId, chatId })
                worker.postMessage({
                  type: 'manage_notes_reply',
                  replyId: msg.replyId,
                  success: true,
                  notes: notes.map(n => ({ id: n.id, title: n.title, content: n.content, updatedAt: n.updatedAt })),
                })
              } else if (action === 'create') {
                const result = createNote({
                  scope,
                  projectId,
                  chatId,
                  title: msg.title as string,
                  content: msg.content as string | undefined,
                })
                if (result.success && result.note) {
                  try {
                    const win = mainWindow.getWindow()
                    if (win && !win.isDestroyed()) {
                      win.webContents.send('notes:changed', { scope, projectId: projectId ?? null, chatId: chatId ?? null })
                    }
                  } catch { /* ok */ }
                  worker.postMessage({
                    type: 'manage_notes_reply',
                    replyId: msg.replyId,
                    success: true,
                    note: { id: result.note.id, title: result.note.title },
                  })
                } else {
                  worker.postMessage({
                    type: 'manage_notes_reply',
                    replyId: msg.replyId,
                    success: false,
                    error: result.error ?? 'create failed',
                  })
                }
              } else if (action === 'update') {
                const result = updateNote({
                  id: msg.noteId as string,
                  title: msg.title as string | undefined,
                  content: msg.content as string | undefined,
                })
                if (result.success && result.note) {
                  try {
                    const win = mainWindow.getWindow()
                    if (win && !win.isDestroyed()) {
                      win.webContents.send('notes:changed', { scope, projectId: result.note.projectId, chatId: result.note.chatId })
                    }
                  } catch { /* ok */ }
                  worker.postMessage({
                    type: 'manage_notes_reply',
                    replyId: msg.replyId,
                    success: true,
                    note: { id: result.note.id, title: result.note.title },
                  })
                } else {
                  worker.postMessage({
                    type: 'manage_notes_reply',
                    replyId: msg.replyId,
                    success: false,
                    error: result.error ?? 'update failed',
                  })
                }
              } else if (action === 'delete') {
                let noteScope: 'project' | 'chat' = 'chat'
                let noteProjectId: string | null = null
                let noteChatId: string | null = null
                try {
                  const row = getDB().prepare(`SELECT scope, project_id, chat_id FROM notes WHERE id=?`).get(msg.noteId) as
                    | { scope: 'project' | 'chat'; project_id: string | null; chat_id: string | null }
                    | undefined
                  if (row) {
                    noteScope = row.scope
                    noteProjectId = row.project_id
                    noteChatId = row.chat_id
                  }
                } catch { /* ok */ }

                const result = deleteNote(msg.noteId as string)
                if (result.success) {
                  try {
                    const win = mainWindow.getWindow()
                    if (win && !win.isDestroyed()) {
                      win.webContents.send('notes:changed', { scope: noteScope, projectId: noteProjectId, chatId: noteChatId })
                    }
                  } catch { /* ok */ }
                  worker.postMessage({
                    type: 'manage_notes_reply',
                    replyId: msg.replyId,
                    success: true,
                  })
                } else {
                  worker.postMessage({
                    type: 'manage_notes_reply',
                    replyId: msg.replyId,
                    success: false,
                    error: result.error ?? 'delete failed',
                  })
                }
              } else {
                worker.postMessage({
                  type: 'manage_notes_reply',
                  replyId: msg.replyId,
                  success: false,
                  error: `Unknown action: ${action}`,
                })
              }
            } catch (e) {
              worker.postMessage({
                type: 'manage_notes_reply',
                replyId: msg.replyId,
                success: false,
                error: (e as Error).message,
              })
            }
          })()
          break
        }

        // ── Browser: browser_*-тулы + request_access (round-trip worker →
        // BrowserManager). Гейтинг browserMode и confirm-диалог — в main.
        case 'browser_op':
        case 'browser_op_cancel':
          // Handled by the scoped browser broker attached to this worker.
          break

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
            // Аккумулируем сырые токены turn'а в run-буфер: при Стопе/краше
            // воркера done/error не приходят, но статистика токенов уже
            // известна main'у — sendDone возьмёт её из bufferedUsage.
            if (typeof msg.rawPromptTokens === 'number' || typeof msg.rawCompletionTokens === 'number') {
              run.bufferedUsage.promptTokens = Math.max(run.bufferedUsage.promptTokens, (msg.rawPromptTokens as number) || 0)
              run.bufferedUsage.completionTokens = Math.max(run.bufferedUsage.completionTokens, (msg.rawCompletionTokens as number) || 0)
              run.bufferedUsage.cacheReadTokens = Math.max(run.bufferedUsage.cacheReadTokens, (msg.rawCacheReadTokens as number) || 0)
              run.bufferedUsage.cacheWriteTokens = Math.max(run.bufferedUsage.cacheWriteTokens, (msg.rawCacheWriteTokens as number) || 0)
            }
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
            ((msg.fullText as string) || run.bufferedText).trim() ? ((msg.fullText as string) || run.bufferedText) : '⚠ **Ошибка:** провайдер завершил ответ без текста.',
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
            ((msg.fullText as string) || run.bufferedText).trim() ? 'done' : 'error',
          )
          // Воркер своё отработал — убиваем поток, иначе течёт ~40-120МБ на каждый запрос
          ;(worker as unknown as { _terminated?: boolean })._terminated = true
          disposeBrowserWorkerBroker(worker)
          worker.terminate()
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
              'error',
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
              // Статистика всё равно сохраняется: часть LLM-вызовов могла
              // пройти до ошибки (токены уже в run.bufferedUsage).
              promptTokens: run.bufferedUsage.promptTokens || undefined,
              completionTokens: run.bufferedUsage.completionTokens || undefined,
              cacheReadTokens: run.bufferedUsage.cacheReadTokens || undefined,
              cacheWriteTokens: run.bufferedUsage.cacheWriteTokens || undefined,
              finishReason: 'error',
            }
            if (!params.incognito) saveMessage(errorAssistantMsg)
            run.doneSent = true
            if (summaryTaskId) { const state=getTaskSummaryState(params.chatId); const task=state.tasks.find(t=>t.id===summaryTaskId); if(task){task.status='error';task.updatedAt=Date.now();task.summary='Запуск завершился ошибкой';const next=upsertTaskSummary(task);broadcastTaskSummary?.(params.chatId, next)} }
            // Сливаем накопленные UI-токены (могли остаться thinking-токены).
            flushUiTokens()
            if (activeRuns.get(params.chatId) === run) activeRuns.delete(params.chatId)
            activeRunMeta.delete(params.chatId)
            win?.webContents.send(IPC_EVENTS.CHAT_STREAM_DONE, {
              chatId: params.chatId,
              msgId: assistantMsgId,
              message: errorAssistantMsg,
            })
            // Plugins: agent:status 'error' + chat:completed (подписавшимся).
            if (!params.incognito) {
              try {
                getPluginManager().emitAgentStatus(params.chatId, 'error')
                getPluginManager().emitChatCompleted(params.chatId)
              } catch { /* ignore */ }
            }
            drainQueue(win, params.chatId)
          }
          emitRunStatus(win, params.chatId, 'error', assistantMsgId, msg.error as string)
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
            chatId: msg.chatId,
            error: msg.error,
          })
          // Воркер упал — убиваем поток, не течём памятью
          ;(worker as unknown as { _terminated?: boolean })._terminated = true
          disposeBrowserWorkerBroker(worker)
          worker.terminate()
          break
        }
      }
    })

    worker.on('error', (err) => {
      console.log('[chat.ipc] Worker CRASH: %s', err.message)
      log('[Worker] CRASH chatId=%s: %s', params.chatId, err.message)
      console.error('[Worker] CRASH:', err)
      sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, buildFinalIters(run), run.bufferedTodo, undefined, undefined, 'error')
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
          sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, buildFinalIters(run), run.bufferedTodo, undefined, undefined, 'error')
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

${await getSystemPrompt(dbChatId, params.incognito, params.oneShotSkill, effectivePlanningMode, effectiveAskMode)}`
      : undefined

    let sideToolSchemas = getToolSchemas({
      customToolsEnabled: store.get('customToolsEnabled', false) === true,
      disabledTools: store.get('disabledTools', []) as string[],
      planningMode: effectivePlanningMode,
      askMode: effectiveAskMode,
      imageMode: !!params.imageMode || params.slashCommand?.name === 'image',
      browserMode: !!params.browserMode || getChatBrowserMode(params.chatId),
      mode: chatMode,
      mcpTools: params.incognito ? undefined : mcpTools,
      pluginTools: params.incognito ? undefined : pluginTools,
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
        'update_todo',
      ])
      sideToolSchemas = sideToolSchemas.filter(
        (s) => SIDE_CHAT_READONLY_TOOLS.has((s as { function: { name: string } }).function.name),
      )
      sideToolSchemas.push(GET_MAIN_CHAT_MESSAGES_SCHEMA as any)
    } else if (params.oneShotAllowedTools && params.oneShotAllowedTools.length > 0) {
      // Кастомная команда с allowed-tools — фильтруем schemas до разрешённого списка.
      // update_todo/update_working_memory/save_memory/recall_memory/ask_user
      // всегда доступны (управляющие тулы, не violating read-only).
      const ALLOWED_ALWAYS = new Set([
        'update_todo', 'update_working_memory',
        'save_memory', 'recall_memory', 'ask_user',
        'list_extensions', 'get_skill',
      ])
      const allowed = new Set([...params.oneShotAllowedTools, ...ALLOWED_ALWAYS])
      sideToolSchemas = sideToolSchemas.filter(
        (s) => allowed.has((s as { function: { name: string } }).function.name),
      )
    }

    // ── Auto-recall: inject relevant past context ──
    // First message in a chat: full multi-source recall (memory + chat history)
    // — continuity without explicit recall_memory calls.
    // Follow-up messages: light memory-only recall (top-3, score ≥ 0.55) —
    // тема может смениться посреди диалога; только memory-источник, чтобы
    // FTS по messages не эхал только что сохранённое текущее сообщение.
    let systemPrompt = sideSystemPrompt
    if (!systemPrompt) {
      // Reuse the prompt built for this send's context estimate. This is scoped
      // to the run (no cross-send cache; plugins/secrets remain live-read).
      systemPrompt = sendSystemPrompt
    }

    // ── Auto-recall: всегда запускается (даже при sideSystemPrompt) ──
    // A1: вынесено из-под guard !sideSystemPrompt — recall работает всегда.
    // A2: follow-up включает messages + summaries (не только memory).
    // A3: порог follow-up понижен с 0.55 до 0.40.
    // C1: keyword extraction из user message вместо raw text.
    // D3: cross-project fallback если project-scope дал 0 результатов.
    const isFirstMessage = processedHistory.length === 0
    if (!params.incognito && getContextPreferences(dbChatId).sources.memory && effectiveContent.trim().length > (isFirstMessage ? 10 : 20)) {
      try {
        let autoRecallProjectId: string | undefined
        const wctx = (() => { try { return getChatWorkdirContext(dbChatId) } catch { return null } })()
        if (wctx?.workdir) {
          const found = getAllProjects().find(p => p.workdir === wctx.workdir)
          autoRecallProjectId = found?.id
        }

        // C1: keyword extraction — убирает stopwords, оставляет значимые термины
        const recallQuery = extractRecallKeywords(effectiveContent.slice(0, 500))

        let results = await searchAllSources({
          query: recallQuery,
          projectId: autoRecallProjectId,
          limit: isFirstMessage ? 10 : 5,
          sources: isFirstMessage ? 'all' : ['memory', 'messages', 'summaries'],
        })

        // D3: cross-project fallback — если project-scope дал 0, ищем глобально
        if (results.length === 0 && autoRecallProjectId) {
          results = await searchAllSources({
            query: recallQuery,
            crossProject: true,
            limit: isFirstMessage ? 10 : 5,
            sources: isFirstMessage ? 'all' : ['memory', 'messages', 'summaries'],
          })
        }

        // A3: порог для follow-up понижен (0.55 → 0.40)
        const filtered = isFirstMessage ? results : results.filter(r => r.score >= 0.40)

        // ── Cross-message dedup: пропускаем то, что модель уже видела ──
        // На follow-up в том же топике те же memory/graph результаты найдутся
        // повторно — инжектить их бессмысленно (модель уже имеет контекст).
        // First message: всё новое (Set пуст). После компакции: Set очищен.
        const injectedKeys = isFirstMessage
          ? new Set<string>()
          : autoRecallInjectedKeys.get(params.chatId) ?? new Set<string>()

        const newResults = isFirstMessage
          ? filtered
          : filtered.filter(r => !injectedKeys.has(getRecallDedupKey(r)))

        if (newResults.length > 0) {
          const toInject = newResults.slice(0, isFirstMessage ? 8 : 4)
          const recallLines = toInject.map(r => {
            const tag = r.source === 'memory' ? `[${r.item?.kind ?? 'memory'}]` : `[${r.source}]`
            return `- ${tag} ${r.content.slice(0, 300)}`
          })
          systemPrompt += `\n## Relevant past context (auto-recall)\n${recallLines.join('\n')}\n`
          log('[chat:send] auto-recall: %d new results (%d deduped) for %s message (chatId=%s)',
            newResults.length, filtered.length - newResults.length,
            isFirstMessage ? 'first' : 'follow-up', params.chatId)

          // Обновляем Set: добавляем ключи инжектированных результатов
          const updatedKeys = new Set(injectedKeys)
          for (const r of toInject) {
            updatedKeys.add(getRecallDedupKey(r))
          }
          autoRecallInjectedKeys.set(params.chatId, updatedKeys)
        } else if (filtered.length > 0) {
          log('[chat:send] auto-recall: 0 new results (%d already seen) for follow-up (chatId=%s)',
            filtered.length, params.chatId)
        }
      } catch (e) {
        log('[chat:send] auto-recall failed: %s', (e as Error).message)
      }
    }

    if (cancelledDelegatedStarts.has(assistantMsgId) || run.doneSent) {
      disposeBrowserWorkerBroker(worker)
      void worker.terminate()
      if (cancelledDelegatedStarts.has(assistantMsgId)) throw new Error('Delegated request cancelled during preparation')
      return { userMsg, assistantMsgId }
    }
    // Goal runtime transport is scoped to this worker/run; no new UI send or IPC handler.
    const runtimeGoal = !params.incognito ? getChatGoal(params.chatId) : null
    // Only explicit /goal launches autonomous continuation. Ordinary questions
    // may reference the pinned objective but must retain normal chat semantics.
    const activeGoal = params.slashCommand?.name === 'goal' && runtimeGoal?.status === 'running' ? runtimeGoal : null
    let goalRevision = activeGoal?.updatedAt
    worker.on('message', (event: Record<string, unknown>) => {
      if (event.type !== 'goal_progress' || !activeGoal) return
      try {
        const current = getChatGoal(params.chatId)
        const next = event.goal as import('../../shared/types/goal').ChatGoal | undefined
        // Never resurrect a goal stopped/replaced/edited by the user mid-run.
        if (!current || current.id !== activeGoal.id || current.status !== 'running' || current.updatedAt !== goalRevision) {
          worker.postMessage({ type: 'abort_run' })
          return
        }
        if (!next || next.id !== current.id || next.chatId !== params.chatId) return
        const saved = setChatGoal({ ...current, status: next.status, steps: next.steps,
          progress: next.progress, evidence: next.evidence, blocker: next.blocker })
        goalRevision = saved?.updatedAt
        broadcastGoal(params.chatId, saved)
      } catch (error) {
        log('[goal-runtime] persistence failed: %s', String(error))
        worker.postMessage({ type: 'abort_run' })
      }
    })
    worker.once('exit', () => {
      if (!activeGoal) return
      const current = getChatGoal(params.chatId)
      if (current?.id === activeGoal.id && current.status === 'running' && current.updatedAt === goalRevision) {
        const saved = setChatGoal({ ...current, status: 'paused', blocker: 'Worker interrupted; inspect side effects before explicit resume' })
        broadcastGoal(params.chatId, saved)
      }
    })
    worker.postMessage({
      goal: activeGoal,
      chatId: params.chatId,
      msgId: assistantMsgId,
      // effectiveContent — с инлайн-блоками из processAttachmentsAndStream
      // (текстовые файлы + описания картинок от vision-модели).
      content: effectiveContent,
      // imageParts — картинки для прямой передачи в основную модель (vision).
      imageParts: run.imageParts,
      history: processedHistory,
      systemPrompt,
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

  // ── Проекты (рабочие директории) — вынесены в projects.ipc.ts ────────
  registerProjectsIPC(mainWindow)

  ipcMain.handle('chat:create', async (_, isIncognito = false, mode: ChatMode = 'code', projectId?: string, model?: { modelId?: string; modelProvider?: string; reasoningValue?: string }) => {
    return createChat(isIncognito, mode, projectId, model)
  })

  ipcMain.handle('chat:getAll', () => getAllChats())
  const validChatId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128 && !!getDB().prepare('SELECT 1 FROM chats WHERE id=? AND is_incognito=0').get(id)
  const hydrateTaskSummary = (chatId: string, task: TaskSummary): TaskSummary => {
    const messageIds = new Set(task.messageIds)
    const participants: TaskSummaryParticipant[] = []
    for (const agent of agentManager.getAll()) {
      if (agent.chatId !== chatId || !agent.parentId || !messageIds.has(agent.parentId)) continue
      const safeSummary = (agent.summary || agent.result || '').replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '').slice(0, 6000)
              const status = agent.status === 'pending' ? 'starting' : agent.status as TaskSummaryParticipant['status']
        participants.push({ id: `agent:${agent.id}`, kind: 'subagent', title: agent.role || agent.task.slice(0, 120), task: agent.task.slice(0, 6000), status, createdAt: agent.createdAt, finishedAt: agent.finishedAt, model: agent.model || undefined, role: agent.role || undefined, stepsCount: agent.steps.length, toolCallsCount: agent.steps.filter(s => s.type === 'tool_call').length, summary: safeSummary || undefined, error: agent.error?.slice(0, 1000), agentId: agent.id, sourceMessageId: agent.parentId })
    }
    for (const request of listDelegatedRequests(chatId)) {
      const sourceMessageId = request.sourceMessageId ?? ''
      const child = getDelegationChat(request.chatId)
      if (!messageIds.has(sourceMessageId) || !request.task || request.sourceChatId !== chatId || !ownsDelegatedChat(chatId, request.chatId) || !child || child.isIncognito) continue
      // requestState reconciles queued/running records against the authoritative
      // queue/run/message state. Do not render the stale row status here.
      const currentState = requestState(request.chatId, request.requestId)
      const status = currentState?.status && currentState.status !== 'idle' ? currentState.status : request.status
      const resultMessage = ['done', 'error', 'cancelled', 'interrupted'].includes(status) ? getMessageById(request.requestId) : undefined
      const clean = resultMessage?.content?.replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '').slice(0, 6000)
      const liveSteps = activeRuns.get(request.chatId)?.msgId === request.requestId ? activeRuns.get(request.chatId)?.bufferedSteps : undefined
      const childSteps = (liveSteps ?? resultMessage?.toolSteps ?? []) as Array<{ type?: string }>
      const updatedRequest = getDelegatedRequest(request.chatId, request.requestId) ?? request
      const titleRow = getDB().prepare('SELECT title FROM chats WHERE id=? AND is_incognito=0').get(request.chatId) as { title?: string } | undefined
      const model = getChatModel(request.chatId)
      participants.push({ id: `chat:${request.requestId}`, kind: 'chat', title: titleRow?.title || 'Связанный чат', task: request.task.slice(0, 6000), status: status as TaskSummaryParticipant['status'], createdAt: request.createdAt, finishedAt: ['done','error','cancelled','interrupted'].includes(status) ? updatedRequest.updatedAt : undefined, model: model?.modelId, stepsCount: childSteps.length, toolCallsCount: childSteps.filter(step => step.type === 'tool_call').length, summary: clean, error: updatedRequest.error?.slice(0, 1000), chatId: request.chatId, requestId: request.requestId, sourceMessageId, readAt: updatedRequest.readAt })
    }
    for (const creation of listDelegatedChatCreations(chatId)) {
      if (!messageIds.has(creation.sourceMessageId) || participants.some(item => item.kind === 'chat' && item.chatId === creation.chatId)) continue
      participants.push({ id: `created:${creation.chatId}`, kind: 'chat', title: creation.title, task: 'Чат создан без поручения в этой задаче.', status: 'idle', chatId: creation.chatId, sourceMessageId: creation.sourceMessageId, createdAt: creation.createdAt })
    }
    return { ...task, participants: participants.slice(-50) }
  }
  const hydrateState = (chatId: string, state: ReturnType<typeof getTaskSummaryState>) => ({ ...state, tasks: state.tasks.map(task => hydrateTaskSummary(chatId, task)) })
  const emitTaskSummary = (chatId: string, state: ReturnType<typeof getTaskSummaryState>) => { const hydrated = hydrateState(chatId, state); mainWindow.getWindow()?.webContents.send(IPC_EVENTS.TASK_SUMMARY_CHANGED, { chatId, state: hydrated }); return hydrated }
  broadcastTaskSummary = emitTaskSummary
  initializeDelegatedChats() // Persist child status before observers hydrate its parent.
  const participantTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const refreshParticipants = (chatId: string) => {
    if (!validChatId(chatId) || participantTimers.has(chatId)) return
    participantTimers.set(chatId, setTimeout(() => {
      participantTimers.delete(chatId)
      if (validChatId(chatId)) emitTaskSummary(chatId, getTaskSummaryState(chatId))
    }, 180))
  }
  refreshDelegationSummary = (childChatId, requestId) => {
    const request = getDelegatedRequest(childChatId, requestId)
    if (request?.sourceMessageId && validChatId(request.sourceChatId)) refreshParticipants(request.sourceChatId)
  }
  agentManager.registerWindowGetter(() => mainWindow.getWindow())
  agentManager.onUpdate(agent => {
    // AgentManager is authoritative for both live and terminal subagent state.
    // Hydration is keyed by parent message, never by title/time.
    if (!agent.parentId) return
    const taskState = getTaskSummaryState(agent.chatId)
    if (taskState.tasks.some(task => task.messageIds.includes(agent.parentId!))) refreshParticipants(agent.chatId)
  })
  runStatusListeners.add((childChatId, status, requestId) => {
    if (!requestId || status === 'compacting') return
    const request = getDelegatedRequest(childChatId, requestId)
    if (!request || request.sourceChatId === childChatId) return
    const taskState = getTaskSummaryState(request.sourceChatId)
    if (request.sourceMessageId && taskState.tasks.some(task => task.messageIds.includes(request.sourceMessageId!))) refreshParticipants(request.sourceChatId)
  })
  ipcMain.handle('task-summary:get', (_e, chatId: unknown) => validChatId(chatId) ? hydrateState(chatId, getTaskSummaryState(chatId)) : { tasks: [], pinned: false, manualPins: [] })
  ipcMain.handle('task-summary:update', (_e, chatId: unknown, patch: unknown) => {
    if (!validChatId(chatId) || !patch || typeof patch !== 'object' || Array.isArray(patch)) return { tasks: [], pinned: false, manualPins: [] }
    const p=patch as Record<string,unknown>; if(Object.keys(p).some(k=>!['pinned','selectedTaskId','newTaskRequested'].includes(k)) || (p.pinned!==undefined&&typeof p.pinned!=='boolean') || (p.newTaskRequested!==undefined&&typeof p.newTaskRequested!=='boolean') || (p.selectedTaskId!==undefined&&(typeof p.selectedTaskId!=='string'||p.selectedTaskId.length>128))) return getTaskSummaryState(chatId)
    return emitTaskSummary(chatId,updateTaskSummaryState(chatId,p as import('../../shared/types/taskSummary').TaskSummaryPatch))
  })
  ipcMain.handle('task-summary:addPin', (_e, chatId: unknown, text: unknown, messageId?: unknown) => {
    if (!validChatId(chatId) || typeof text!=='string' || !text.trim() || text.length>500 || (messageId!==undefined && (typeof messageId!=='string' || !getDB().prepare('SELECT 1 FROM messages WHERE id=? AND chat_id=?').get(messageId,chatId)))) return { tasks: [], pinned: false, manualPins: [] }
    return emitTaskSummary(chatId,addTaskSummaryPin(chatId,text.trim(),messageId as string|undefined))
  })
  ipcMain.handle('task-summary:removePin', (_e, chatId: unknown, id: unknown) => !validChatId(chatId)||typeof id!=='string' ? {tasks:[],pinned:false,manualPins:[]} : emitTaskSummary(chatId,removeTaskSummaryPin(chatId,id)))
  // ── Активный чат (для Spotlight "спросить в текущем") ───────────────────
  // Renderer шлёт chat:setActive при каждой смене currentChatId в zustand.
  // Spotlight (отдельное BrowserWindow) спрашивает chat:getActive чтобы
  // знать, в какой чат отправить быстрый запрос вместо создания нового.
  ipcMain.handle('chat:setActive', (_, chatId: string | null) => {
    setLastActiveChatId(chatId ?? null)
    // Плагинам: подписчики 'chat:switched' узнают о смене активного чата.
    try { getPluginManager().emitChatSwitched(chatId ?? null) } catch { /* plugins не должны ломать чат */ }
  })
  ipcMain.handle('chat:getActive', () => lastActiveChatId)
  // Превью финального system prompt (UI: просмотр в карточке плагина /
  // настройках агента). Инкогнито-режим не применяется — это явный
  // запрос пользователя посмотреть свой промпт.
  ipcMain.handle('chat:previewSystemPrompt', async (_, chatId?: string) => {
    try {
      const prompt = await getSystemPrompt(chatId ?? lastActiveChatId ?? undefined)
      // Маркер кэш-разрыва — служебный, в UI-превью не показываем.
      return { ok: true, prompt: prompt.replaceAll(SYSTEM_PROMPT_CACHE_BREAK, '\n\n') }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })
  // ВНИМАНИЕ: в renderer сообщения уходят ТОЛЬКО через slimMessagesForUI —
  // полные tool-пейлоады (тела файлов, diff'ы, выводы) остаются в БД для
  // AI-контекста (messageToContextMessages), UI показывает урезанную копию.
  ipcMain.handle('chat:getMessages', (_, chatId: string) => {
    // Краш-рекавери: частичный ответ из streaming_buffers → messages
    // (см. historyCache). Делаем ДО чтения, чтобы восстановленное сообщение
    // попало в выдачу. Пропускаем при активном стриминге этого чата — там
    // буфер пишется чекпоинт-таймером, а восстановление дёрнуло бы FTS
    // (saveMessage) на каждый скролл/обновление. Буфер удаляется внутри
    // recovery — повторные вызовы после краша дешёвые.
    if (!activeRuns.has(chatId)) recoverStreamingBuffersForChat(chatId)
    return slimMessagesForUI(getMessages(chatId))
  })
  // Окно сообщений для пагинации (reverse-infinite scroll). Возвращает
  // { messages, hasMore } — последние `limit` сообщений либо старее курсора
  // (beforeCreatedAt, beforeId). См. db/messages.ts getMessagesPage.
  ipcMain.handle('chat:getMessagesPage', (_, chatId: string, limit?: number, beforeCreatedAt?: number, beforeId?: string) => {
    // Краш-рекавери — основной путь загрузки истории при открытии чата
    // (renderer грузит первую страницу через getMessagesPage, не getMessages).
    if (!activeRuns.has(chatId)) recoverStreamingBuffersForChat(chatId)
    const res = getMessagesPage(chatId, limit ?? 20, beforeCreatedAt, beforeId)
    return { ...res, messages: slimMessagesForUI(res.messages) }
  })
  ipcMain.handle('chat:delete', (_, chatId: string) => {
    // Dots: чат Dot'а удалили из сайдбара основного чата — каскадом удаляем
    // и самого Dot'а (иначе он останется сиротой: каждый wake-ран будет
    // падать на несуществующем чате). Динамический импорт — как в
    // manage_dots (статический импорт DotManager создаёт цикл).
    try {
      const dot = getDotByChatId(chatId)
      if (dot) {
        void import('../managers/DotManager').then(m => {
          m.dotManager.deleteDot(dot.id)
          log('[chat:delete] каскад: удалён Dot "%s" вместе с чатом', dot.name)
        })
      }
    } catch { /* dots-таблица недоступна — удаляем просто чат */ }
    // Если в удаляемом чате работает воркер — убиваем его и чистим очередь.
    const run = activeRuns.get(chatId)
    if (run) {
      if (run.streamCheckpointTimer) {
        clearInterval(run.streamCheckpointTimer)
        run.streamCheckpointTimer = null
      }
      ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
      disposeBrowserWorkerBroker(run.worker)
      run.worker.terminate()
      run.doneSent = true
      activeRuns.delete(chatId)
    }
    activeRunMeta.delete(chatId)
    chatQueues.delete(chatId)
    autoRecallInjectedKeys.delete(chatId)
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

  // ── Редактор чата: правка текста / скрытие из контекста / удаление ──────
  // iterTexts — правка текстовых сегментов iterations[].textBefore у
  // сообщений с тулами (мерж в полную запись БД внутри editMessageContent).
  ipcMain.handle('chat:editMessage', (_, messageId: string, content: string, iterTexts?: string[]) =>
    editMessageContent(messageId, content, iterTexts))
  ipcMain.handle('chat:setMessageHidden', (_, messageId: string, hidden: boolean) => setMessageHidden(messageId, hidden))
  ipcMain.handle('goal:get', (_, chatId: string) => getChatGoal(chatId))
  ipcMain.handle('goal:set', (_, chatId: string, goal: import('../../shared/types/goal').ChatGoal | null) => {
    if (typeof chatId !== 'string' || !chatId.trim()) throw new Error('Некорректный чат')
    if (goal && (goal.chatId !== chatId || !goal.objective?.trim() || !Array.isArray(goal.criteria) || !Array.isArray(goal.constraints) || !Array.isArray(goal.progress) || !Array.isArray(goal.evidence) || !['running', 'paused', 'blocked', 'completed', 'unverified', 'stopped', 'limit'].includes(goal.status))) throw new Error('Некорректная цель')
    const saved = setChatGoal(goal, chatId)
    broadcastGoal(chatId, saved)
    return saved
  })
  ipcMain.handle('chat:deleteMessage', (_, messageId: string) => { deleteMessageById(messageId); return true })

  // ── Per-chat UI state: режимы инпут-бара, черновик, история ввода ──
  // Хранятся в chats/messages, переживают перезапуск. Для инкогнито
  // рендерер не вызывает эти методы (guard в ChatPage), но на уровне IPC
  // тоже ничего не проверяем — БД-запросы идемпотентны и безопасны.
  ipcMain.handle('chat:getModes', (_, chatId: string) => getChatModes(chatId))
  ipcMain.handle('chat:setModes', (_, chatId: string, modes: { planningMode: boolean; imageMode: boolean; askMode: boolean }) => {
    setChatModes(chatId, modes)
    return true
  })
  // Индивидуальные сеттеры — пишут ОДНУ колонку, не затрагивая остальные.
  // Устраняют кросс-контаминацию режимов при race condition save-on-switch.
  ipcMain.handle('chat:setPlanningMode', (_, chatId: string, val: boolean) => { setChatPlanningMode(chatId, val); return true })
  ipcMain.handle('chat:setImageMode', (_, chatId: string, val: boolean) => { setChatImageMode(chatId, val); return true })
  ipcMain.handle('chat:setAskMode', (_, chatId: string, val: boolean) => { setChatAskMode(chatId, val); return true })
  // Persona — single-select run mode (classic/architect/debugger/...).
  ipcMain.handle('chat:getPersona', (_, chatId: string) => getChatPersona(chatId))
  ipcMain.handle('chat:setPersona', (_, chatId: string, persona: import('../../shared/modes').PersonaId) => { setChatPersona(chatId, persona); return true })
  // Per-chat модель: NULL = глобальное назначение role:'main'. Пишется при
  // смене модели в пикере чата; новый чат наследует модель чата-родителя.
  ipcMain.handle('chat:getModel', (_, chatId: string) => getChatModel(chatId))
  ipcMain.handle('chat:setModel', (_, chatId: string, modelId: string | null, modelProvider: string | null) => {
    setChatModel(chatId, modelId, modelProvider)
    return true
  })
  // Per-chat уровень мышления: NULL = глобальный settings.reasoningValue.
  ipcMain.handle('chat:getReasoning', (_, chatId: string) => getChatReasoning(chatId))
  ipcMain.handle('chat:setReasoning', (_, chatId: string, value: string | null) => {
    setChatReasoning(chatId, value)
    return true
  })
  ipcMain.handle('chat:getDraft', (_, chatId: string) => getChatDraft(chatId))
  ipcMain.handle('chat:setDraft', (_, chatId: string, draft: string) => {
    setChatDraft(chatId, draft)
    return true
  })
  ipcMain.handle('chat:getInputHistory', (_, chatId: string) => getUserMessageContents(chatId))

  ipcMain.handle('context:getPreferences', (_, chatId: string) => {
    assertContextChat(chatId)
    return getContextPreferences(chatId)
  })
  ipcMain.handle('context:setPreferences', (_, chatId: string, patch: Partial<ContextPreferences>) => {
    const result = setContextPreferences(chatId, patch)
    invalidateHistoryCache(chatId)
    clearChatLastUsage(chatId)
    return result
  })
  ipcMain.handle('context:setMessageHidden', (_, chatId: string, messageId: string, hidden: boolean) => {
    const result = setContextMessageHidden(chatId, messageId, hidden)
    invalidateHistoryCache(chatId)
    clearChatLastUsage(chatId)
    return result
  })
  ipcMain.handle('context:setMessagePinned', (_, chatId: string, messageId: string, pinned: boolean) => {
    const result = setContextMessagePinned(chatId, messageId, pinned)
    invalidateHistoryCache(chatId)
    clearChatLastUsage(chatId)
    return result
  })
  ipcMain.handle('context:inspect', async (_, chatId: string): Promise<ContextInspection> => {
    assertContextChat(chatId)
    const preferences = getContextPreferences(chatId)
    const inspection: ContextInspection = { preferences, sources: [], files: [], messages: [] }
    await getSystemPrompt(chatId, false, undefined, undefined, undefined, inspection)
    const included = filterContextHistory(chatId, getMessagesAfterLatestCompactCached(chatId))
    const ids = new Set(included.map(m => m.id))
    inspection.messages = getMessagesCached(chatId).map(m => ({
      id: m.id, role: m.role, preview: (m.content || '').slice(0, 350),
      isPinned: !!m.isPinned, isHidden: !!m.hiddenFromContext, included: ids.has(m.id),
    }))
    const historySource = inspection.sources.find(s => s.key === 'history')!
    historySource.characters = included.reduce((n, m) => n + m.content.length, 0)
    const toolsSource = inspection.sources.find(s => s.key === 'tools')!
    toolsSource.characters = included.reduce((n, m) => n + (m.toolSteps ? JSON.stringify(m.toolSteps).length : 0), 0)
    return inspection
  })

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
        'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'projectPermissions', 'chatApprovalAllowlist', 'integrations',
        'voiceId', 'embeddingModel',
        'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
        'contextSettings',
      ]
      for (const k of storeKeys) {
        const v = store.get(k)
        if (v !== undefined) storeData[k] = v
      }

      // Per-chat модель: подменяем role:'main' на модель чата, чтобы окно
      // контекста считалось от неё (как в runChatSend).
      try {
        const chatModel = getChatModel(chatId)
        if (chatModel) {
          const assignments = (storeData.modelAssignments as Array<{ role: string; modelId: string; providerId: string }> | undefined) ?? []
          const idx = assignments.findIndex(a => a.role === 'main')
          const override = { role: 'main', modelId: chatModel.modelId, providerId: chatModel.modelProvider }
          if (idx >= 0) assignments[idx] = override
          else assignments.push(override)
          storeData.modelAssignments = assignments
        }
      } catch { /* ok */ }

      const ctxSettings = getContextSettings(storeData)
      if (!ctxSettings.tokenCounterEnabled) return

      const contextWindow = getModelContextWindow(storeData)
      const sysPrompt = await getSystemPrompt(chatId)

      // Загружаем историю (как в chat:send) — для incognito-чатов она пуста.
      // Live-подмножество: сообщения после последнего divider'а (старые
      // summarized не грузятся в модель — их заменяет summary в system prompt).
      const liveMessages = filterContextHistory(chatId, getMessagesAfterLatestCompactCached(chatId))
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
      const history = getMessagesCached(chatId)
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

  // ── chat:send — ядро вынесено в локальную chatSendHandler ───────────────
  // Регистрируется и как IPC-хендлер, и как programmatic-API (см.
  // sendChatMessageProgrammatic выше): DotManager будит Dot'ов из main.
  const chatSendHandler = async (params: {
    chatId: string
    content: string
    displayContent?: string
    slashCommand?: { name: string; args: string }
    incognito?: boolean
    userMsgId?: string
    assistantMsgId?: string
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
    /** Уровень мышления из UI на момент клика «Отправить» (source of truth,
     *  приоритет над БД/глобальной настройкой — см. runChatSend). */
    reasoningValue?: string
    /** Прикреплённые файлы/изображения из @mention/drag&drop/paste/dialog.
     *  Текстовые файлы инлайним в content, картинки — путь (vision Phase 2).
     *  Вложения реплайнутых сообщений приходят здесь же с source:'reply'. */
    attachments?: Attachment[]
    /** Реплай-цитаты: метаданные сообщений, на которые отвечает эта отправка
     *  (из контекстного меню «Ответить»). Персистится в userMsg.replyTo → БД
     *  (reply_to); цитата для AI строится в runChatSend + messageToContextMessages. */
    replyTo?: ReplyTarget[]
    /** Тумблер «Управление браузером»: browser_* тулы с первого раунда.
     *  Дублируется chats.browser_mode из БД (main читает обе — request_access
     *  включает режим посреди сессии и пишет в БД). */
    browserMode?: boolean
  }): Promise<{ userMsg: Message; assistantMsgId: string; queued?: boolean }> => {
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
      replyTo: params.replyTo,
    }
    const history = params.incognito ? [] : getMessagesAfterLatestCompactCached(params.chatId, userMsg.id)
    const assistantMsgId = params.assistantMsgId ?? uuid()

    // Регистрируем пути вложений этой отправки как pending — защита от
    // cleanupOrphanDraftFiles: пока userMsg не сохранён в БД (для queued-
    // отправок это может случиться спустя минуты), файлы не считаются
    // сиротами. Снимается в runChatSend сразу после saveMessage(userMsg).
    if (!params.incognito && attachments.length > 0) {
      const pending = pendingAttachmentPaths.get(params.chatId) ?? new Map<string, number>()
      const now = Date.now()
      for (const a of attachments) {
        if (a?.path) pending.set(path.resolve(a.path).toLowerCase(), now)
      }
      pendingAttachmentPaths.set(params.chatId, pending)
    }

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
    if (activeRuns.has(params.chatId) || activeRunMeta.has(params.chatId) || compactRuns.has(params.chatId)) {
      log('[chat:send] chatId=%s уже работает (или идёт сжатие) — ставим в очередь', params.chatId)
      emitRunStatus(win, params.chatId, 'queued', assistantMsgId)
      const queued: QueuedSend = {
        // Read history when the queued task actually starts: it must see the
        // previous answer, which did not exist at enqueue time.
        run: async () => { await runChatSend(params, win, chatMode, agentSettings, userMsg,
          params.incognito ? [] : getMessagesAfterLatestCompactCached(params.chatId, userMsg.id), assistantMsgId) },
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
    void runChatSend(params, win, chatMode, agentSettings, userMsg, history, assistantMsgId)
      .catch((e) => failRunCleanup(win, params.chatId, assistantMsgId, e))
    return { userMsg, assistantMsgId }
  }

  // Programmatic-API для main-модулей (DotManager) + IPC-регистрация.
  chatSendImpl = chatSendHandler
  initializeDelegatedChats()
  // Reserved response IDs are main-only; renderer may not overwrite stored messages.
  ipcMain.handle('chat:send', (_, params: Parameters<typeof chatSendHandler>[0]) => chatSendHandler({ ...params, assistantMsgId: undefined }))

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
      .catch((e) => failRunCleanup(win, sideChatId, assistantMsgId, e))
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
      // Единый снапшот ephemeral live-состояния (toolProgress, spawnedAgents,
      // и любые будущие ephemeral-блоки). Renderer гидрирует их целиком.
      liveState: run.bufferedLiveState,
      meta: activeRunMeta.get(chatId) ?? null,
    }
  })

  // ── chat:stop — остановка активного запуска. Если передан chatId,
  //    останавливаем только этот чат (новое поведение для параллельных чатов).
  //    Если chatId не передан — backward compat: останавливаем все активные.
  const stopRun = (run: ActiveRun) => {
      const win = mainWindow.getWindow()
      // Прерываем обработку вложений если она ещё идёт (воркер ещё не создан).
      // Без этого chat:stop во время "Подготовки файлов" не прерывает
      // processAttachmentsAndStream — Promise.all висит на analyzeImage.
      if (run.attachmentAbort) run.attachmentAbort.abort()
      // Останавливаем checkpoint-таймер — sendDone ниже сохранит финал.
      if (run.streamCheckpointTimer) {
        clearInterval(run.streamCheckpointTimer)
        run.streamCheckpointTimer = null
      }
      disposeBrowserWorkerBroker(run.worker)
      try { run.worker.postMessage({ type: 'abort_run' }) } catch { /* worker already stopped */ }
      ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
      run.worker.terminate()
      // Прерываем agent PTY: Ctrl+C + очистка pending. Без этого сессия
      // остаётся в '[shell busy]' и следующий run_command зависает.
      ptyManager.interruptByChat(run.chatId)
      // Флешим накопленный прогресс — пользователь увидит частичный ответ,
      // сохранённый в историю. sendDone также сбрасывает activeRunMeta и
      // дрейнит очередь этого чата. usage не передаём — sendDone возьмёт
      // накопленный run.bufferedUsage (воркер terminate()ится раньше, чем
      // успел бы отправить done с usage).
      run.sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, buildFinalIters(run), run.bufferedTodo, undefined, undefined, 'stopped')
      // 'cancelled' шлём ТОЛЬКО если sendDone не зарегистрировал 'done'.
      // sendDone первым делом ставит doneSent=true и в норме эмитит 'done'
      // (CHAT_STREAM_DONE + CHAT_RUN_STATUS:'done'). Переопределение 'done'
      // на 'cancelled' давало рандомный бейдж «Отменено» в сайдбаре на чате,
      // который по факту завершился штатно (пусть и досрочно).
      if (!run.doneSent) emitRunStatus(win, run.chatId, 'cancelled', run.msgId)
  }
  chatStopImpl = (chatId, requestId) => {
    const win = mainWindow.getWindow()
    const queue = chatQueues.get(chatId)
    const index = queue?.findIndex(item => item.meta.msgId === requestId) ?? -1
    if (queue && index >= 0) {
      queue.splice(index, 1)
      if (!queue.length) chatQueues.delete(chatId)
      emitQueueUpdate(win, chatId)
      // Do not emit a chat-wide terminal event: another request may still run.
      return true
    }
    const run = activeRuns.get(chatId)
    if (run?.msgId !== requestId) {
      if (activeRunMeta.get(chatId)?.msgId !== requestId) return false
      cancelledDelegatedStarts.add(requestId)
      // Keep the slot reserved until preparation observes cancellation.
      emitRunStatus(win, chatId, 'cancelled', requestId)
      return true
    }
    stopRun(run)
    emitQueueUpdate(win, chatId)
    return true
  }
  ipcMain.handle('chat:stop', (_, chatId?: string) => {
    const win = mainWindow.getWindow()
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
        // ПЛЮС: чистим застрявший activeRunMeta (ран упал до создания
        // run-объекта — failRunCleanup обычно чистит сам, но stop должен
        // гарантированно освобождать слот) и шлём terminal 'cancelled',
        // чтобы renderer сбросил live-state (defensive liveClear в
        // терминальной ветке CHAT_RUN_STATUS). Без этого UI для
        // queued/зависшего запроса никогда не получал терминального
        // события и live-пузырь зависал — «Стоп не работает».
        const hadQueue = chatQueues.has(chatId)
        const hadMeta = activeRunMeta.has(chatId)
        if (hadQueue) chatQueues.delete(chatId)
        if (hadMeta) activeRunMeta.delete(chatId)
        if (hadQueue || hadMeta) {
          emitQueueUpdate(win, chatId)
          emitRunStatus(win, chatId, 'cancelled')
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

  // === CHECKPOINT / REWIND — вынесены в chatCheckpoint.ipc.ts ===
  registerCheckpointIPC(mainWindow)

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
  ipcMain.handle('chat:compact', async (event, chatId: string, mode?: string) => {
    // Sidechat-чаты (incognito, префикс 'sidechat:') — эфемерны:
    // история не в БД, summary не сохраняется — компакция бессмысленна.
    if (chatId.startsWith('sidechat:')) {
      return { error: 'Компакция недоступна для параллельного side-чата.' }
    }
    if (activeRuns.has(chatId) || activeRunMeta.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа перед сжатием.' }
    }
    if (compactRuns.has(chatId)) {
      return { error: 'Сжатие уже идёт — дождитесь завершения.' }
    }

    // Итог компакции для терминального run-статуса в finally
    // (done/cancelled/error) — сайдбар-бейдж после завершения сжатия.
    let compactOutcome: 'done' | 'cancelled' | 'error' = 'done'

    try {
      const storeData: Record<string, unknown> = {}
      const storeKeys = [
        'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels',
        'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'projectPermissions', 'chatApprovalAllowlist', 'integrations',
        'voiceId', 'embeddingModel',
        'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
        'contextSettings',
      ]
      for (const k of storeKeys) {
        const v = store.get(k)
        if (v !== undefined) storeData[k] = v
      }
      const ctxSettings = getContextSettings(storeData)

      // Manual compaction still needs full-history statistics for UI.
      const history = getMessagesCached(chatId)
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

      // AbortController для отмены /compact пользователем (Stop-кнопка).
      // chat:compact:cancel зовёт controller.abort() → streamChat разрывает
      // стрим и onDone'ит с partial-текстом; summaryFn возвращает partial;
      // applyRollingWindowAsync возвращает CompressResult; но пост-awaits
      // guard'ы ниже НЕ пускают запись summary/divider в БД — чат остаётся
      // байт-идентичным состоянию до компакции.
      const controller = new AbortController()
      compactRuns.set(chatId, controller)
      // Статус для сайдбара/табов: чат «сжимает контекст» (спиннер в списке
      // чатов). Терминальный статус эмитится в finally ниже.
      emitRunStatus(mainWindow.getWindow(), chatId, 'compacting')

      const summaryFn = async (systemPrompt: string, userContent: string): Promise<string> => {
        const aiClient = new AIClient(store)
        let result = ''
        // Сигнал рендереру: начало стрима резюме (сброс накопленного текста
        // в compacting-индикаторе). Только manual /compact — авто-компакция
        // идёт перед AI-ответом, индикатора нет, стримить бессмысленно.
        const sender = event.sender
        if (!sender.isDestroyed()) {
          sender.send(IPC_EVENTS.CHAT_COMPACT_STREAM, { chatId, start: true })
        }
        const streamOpts = {
          onToken: (t: string) => {
            result += t
            if (!sender.isDestroyed()) {
              sender.send(IPC_EVENTS.CHAT_COMPACT_STREAM, { chatId, chunk: t })
            }
          },
          onDone: () => {},
          onError: () => {},
        }
        try {
          await aiClient.streamChat(
            [{ role: 'user', content: userContent }],
            streamOpts,
            'summary',
            systemPrompt,
            controller.signal,
          )
          // streamChat вызывает onError() и возвращается БЕЗ throw —
          // result остаётся пустым. Проверяем и бросаем, чтобы catch
          // переключил на main-модель, а при повторном пустом результате —
          // applyRollingWindowAsync активировал механический fallback.
          if (!result) throw new Error('summary model returned empty')
        } catch {
          // Если summary-модель не сработала — fallback на main (модель чата)
          if (controller.signal.aborted) throw new Error('aborted')
          result = ''
          await aiClient.streamChat(
            [{ role: 'user', content: userContent }],
            streamOpts,
            'main',
            systemPrompt,
            controller.signal,
          )
          if (!result) throw new Error('main model returned empty')
        }
        return result
      }

      // forceCompress=true — форсируем сжатие даже если порог токенов
      // не достигнут (пользователь явно попросил /compact). applyRollingWindowAsync
      // адаптирует keepLast/keepFirst для коротких историй, чтобы middle
      // был непустым. Если совсем нечего сжимать (1-2 сообщения) —
      // вернёт compressed=false → сообщим пользователю.
      const tokensBefore = estimateMessagesTokens(rawHistory)
      const compactMode = mode === 'last' ? 'last' : 'full'
      const result = await applyRollingWindowAsync(rawHistory, rollingSettings, summaryFn, storedSummary || undefined, true, compactMode)
      if (!result.compressed) {
        compactOutcome = 'error'
        return { error: 'Недостаточно сообщений для сжатия (нужно больше 2).' }
      }

      const tokensAfter = estimateMessagesTokens(result.messages)

      // ═══════ Guard от user-initiated cancel ═══════
      // Если пользователь нажал Stop во время LLM-стрима summaryFn,
      // controller.signal.aborted=true. В этом случае НЕ применяем
      // результат к чату: не пишем summary, не вставляем divider, не шлём
      // CONTEXT_USAGE/CHAT_COMPACTED. Чат остаётся байт-идентичен
      // состоянию до компакции (прежнее summary в chat_summaries на месте,
      // новый divider не вставлен, getLiveMessages следующего chat:send
      // вернёт то же live-подмножество что и раньше).
      //
      // Проверку делаем ДВАЖДЫ — перед транзакцией и внутри неё перед
      // commit — чтобы закрыть race-окно между setChatSummary и
      // saveMessage(divider) (abort прилетает между двумя writes).
      if (controller.signal.aborted) {
        log('[chat:compact] aborted chatId=%s — summary & divider NOT applied', chatId)
        compactOutcome = 'cancelled'
        return { cancelled: true, error: 'Сжатие отменено' }
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

      // Атомарная транзакция: summary + divider коммитятся вместе. Если abort
      // прилетит между двумя writes — rollback отменит оба. Defense-in-depth
      // поверх основного guard'а выше.
      const db = getDB()
      const tx = db.transaction(() => {
        if (result.summaryContent) setChatSummary(chatId, result.summaryContent)
        saveMessage(divider)
      })
      if (controller.signal.aborted) {
        log('[chat:compact] aborted (pre-tx) chatId=%s — summary & divider NOT applied', chatId)
        compactOutcome = 'cancelled'
        return { cancelled: true, error: 'Сжатие отменено' }
      }
      tx()

      // Пишем summary в chat_summaries (перезаписывает старое, как при
      // авто-компакции). Это нужно для будущего system prompt AI.
      // (Выше уже выполнено в транзакции; этот блок памяти extraction
      // запускаем только если summary реально записан.)
      if (result.summaryContent) {
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
      compactOutcome = 'error'
      return { error: `Ошибка сжатия контекста: ${(e as Error).message}` }
    } finally {
      // Всегда убираем AbortController из map — даже на cancel/error/early-return.
      // Без этого повторный /compact после cancel думал бы что он ещё активен.
      compactRuns.delete(chatId)
      // Терминальный статус для сайдбара (гасим «compacting»-спиннер, ставим
      // бейдж ✓/✗/— как unread). Эмитим ПОСЛЕ compactRuns.delete, чтобы
      // renderer не видел «compacting» у уже свободного чата.
      emitRunStatus(mainWindow.getWindow(), chatId, compactOutcome)
      // Запускаем накопленные запросы из очереди (если во время сжатия пришли
      // новые chat:send — они стояли в chatQueues, т.к. compactRuns.has
      // блокировал их старт). drainQueue безопасен при пустой очереди.
      drainQueue(mainWindow.getWindow(), chatId)
    }
  })

  // ── chat:compact:cancel — отмена ручной компакции по Stop-кнопке ──────
  // Прерывает LLM-стрим резюме (controller.abort) БЕЗ применения частичного
  // результата. chat:compact сам выйдет через guard `if (aborted)` и вернёт
  // {cancelled:true} — renderer покажет toast и сбросит isCompacting.
  // Идемпотентно: повторный cancel для уже завершённого/несуществующего
  // run'а возвращает {cancelled:false} — UI это игнорирует.
  ipcMain.handle('chat:compact:cancel', (_, chatId?: string) => {
    if (!chatId) return { cancelled: false }
    const controller = compactRuns.get(chatId)
    if (!controller) return { cancelled: false }
    controller.abort()
    // Удаление из map сделает сам chat:compact в своём finally; здесь
    // не трогаем — иначе abort потеряет ссылку на controller до того,
    // как chat:compact проверит signal.aborted.
    log('[chat:compact:cancel] aborted chatId=%s', chatId)
    return { cancelled: true }
  })

  registerForkIPC()

}

/** Титул чата всё ещё дефолтный (название не сгенерировано)? */
function isChatTitleDefault(chatId: string): boolean {
  try {
    const row = getDB().prepare('SELECT title FROM chats WHERE id = ?').get(chatId) as { title: string } | undefined
    return row?.title === DEFAULT_CHAT_TITLE
  } catch {
    return false
  }
}

// Защита от параллельных запусков autoNameChat для одного чата: ретрай на
// 2-м сообщении может прийти, пока 1-я попытка ещё в полёте (ретраи 429/сети).
const autoNameInFlight = new Set<string>()

/** Чистит ответ модели: префикс «Название:», обрамляющие кавычки, длина. */
function cleanAutoTitle(raw: string): string {
  let t = raw.trim()
  t = t.replace(/^(?:название|chat title|title)\s*[:\-–—]\s*/i, '')
  t = t.replace(/^["'«“]+/, '').replace(/["'»”]+$/, '')
  return t.trim().slice(0, 60)
}

/** Локальный фолбэк без LLM: первые слова сообщения пользователя. */
function localAutoTitle(message: string): string {
  const t = message.trim().replace(/\s+/g, ' ')
  // Slash-команды и слишком короткие сообщения — не название.
  if (!t || t.startsWith('/') || t.length < 3) return ''
  return t.slice(0, 40)
}

/**
 * Генерация названия чата по первому сообщению. Цепочка фолбэков:
 *   1. fast-модель (дефолт — бесплатная opencode-free, бывает лежит/429)
 *   2. main-модель чата
 *   3. локальный фолбэк — первые слова сообщения (без LLM)
 * Ошибки логируются (раньше — тихий catch, падение было невидимо).
 */
async function autoNameChat(chatId: string, firstMessage: string, store: Store, win?: BrowserWindow | null): Promise<void> {
  if (autoNameInFlight.has(chatId)) return
  autoNameInFlight.add(chatId)
  try {
    const prompt = `Придумай короткое название (3-5 слов) для чата, который начинается с этого сообщения: "${firstMessage.slice(0, 200)}". Ответь только названием без кавычек и лишних слов.`
    const client = new AIClient(store)
    const messages = [{ role: 'user' as const, content: prompt }]

    // 1. fast-модель
    let title = ''
    try {
      title = cleanAutoTitle(await client.complete(messages, 'fast'))
    } catch (e) {
      log('[autoNameChat] fast model failed chatId=%s: %s', chatId, (e as Error).message)
    }

    // 2. Фолбэк на основную модель чата (один маленький запрос ~100 токенов)
    if (!title) {
      try {
        title = cleanAutoTitle(await client.complete(messages, 'main'))
        if (title) log('[autoNameChat] used main-model fallback chatId=%s', chatId)
      } catch (e) {
        log('[autoNameChat] main model failed chatId=%s: %s', chatId, (e as Error).message)
      }
    }

    // 3. Локальный фолбэк без LLM
    if (!title) {
      title = localAutoTitle(firstMessage)
      if (title) log('[autoNameChat] used local fallback chatId=%s', chatId)
    }

    if (title) {
      renameChat(chatId, title)
      win?.webContents.send('chat:renamed', { chatId, title })
    }
  } catch (e) {
    log('[autoNameChat] unexpected error chatId=%s: %s', chatId, (e as Error).message)
  } finally {
    autoNameInFlight.delete(chatId)
  }
}
