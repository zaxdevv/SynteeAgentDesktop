import { ipcMain, BrowserWindow, app } from 'electron'
import { Worker } from 'worker_threads'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import type Store from 'electron-store'
import {
  saveMessage, saveMessageAndDeleteStreamingBuffer, deleteStreamingBuffer, saveStreamingBuffer,
  getMessages, getMessagesAfterLatestCompact,
  getDB, getAllProjects, getWorkingMemory, setWorkingMemory, getChatSummary, setChatSummary,
  getChatModes, getChatModel, getChatReasoning, getChatMode, getChatBrowserMode,
  getChatGoal, setChatGoal,
  getMessageCount, pickSnapshots, firstSnapshotPerPath,
  saveFileSnapshots, saveContextSnapshot, saveCheckpointMeta, getCheckpoints, pruneOldCheckpoints,
  logAgentAction,
  getTaskSummaryState, updateTaskSummaryState, createTaskSummary, upsertTaskSummary,
  getChatWorkdirContext, setChatLastUsage, clearChatLastUsage,
} from '../../core/db'
import { getDelegatedRequest } from '../../core/db/delegatedChats'
import { updateMessageToolSteps } from '../../core/db/messages'
import { getContextPreferences, filterContextHistory } from '../../core/db/contextControls'
import { extractMemoriesFromConversation, saveMemory } from '../../core/memory/MemoryEngine'
import { saveMemoryItem, bumpMemoryHit, searchAllSources } from '../../core/memory/MemoryStore'
import { getGlobalMemoryEnabled, getMemorySettings } from '../../core/memory/globalMemorySettings'
import { onCompactionTrigger, extractAndSaveFacts } from '../../core/memory/extractor'
import { extractAndSaveOutcomes } from '../../core/memory/outcomeExtractor'
import { incrementalUpdateDecision, incrementalUpdateConversation } from '../../core/memory/graphBuilder'
import { getSubagentRole, buildSubagentSystemPrompt } from '../../shared/subagent-roles'
import { AIClient } from '../../core/ai/AIClient'
import { initialMcpSchemas } from '../../core/agent/deferredMcpTools'
import { filterSchemasForPhase } from '../../core/agent/orchestration'
import { getToolSettings, isToolDisabled } from '../../shared/toolSettings'
import { getAccessToken } from '../services/tokenStore'
import { getGatewayAuthToken, forceRefreshGatewayToken } from '../services/gatewayClient'
import { getCodexAccessToken, getCodexAccountId, forceRefreshCodexToken } from '../services/codexAuth'
import { getToolSchemas, GET_MAIN_CHAT_MESSAGES_SCHEMA, savePlanToFileSync } from '../../core/tools'
import { projectMapQuery } from '../../core/tools/projectMap'
import { extractFinalPlan } from '../../shared/planParser'
import { stripFinalMarkers } from '../../shared/finalAnswer'
import { IPC_EVENTS } from '../../shared/constants'
import { getNotificationManager } from '../managers/NotificationManager'
import { persistApprovalGrant } from '../services/approvalAllowlist'
import { getActivityManager } from '../managers/ActivityManager'
import { getGitSyncManager } from '../managers/GitSyncManager'
import { agentManager } from '../managers/AgentManager'
import { attachAssistants, onAgentEvent, onAssistantEvent, onRunDone, onJanitorAction, getAssistantsSettings } from '../assistants/bridge'
import { getBriefingContinuityWithin, noteBriefingChanges } from '../assistants/gitBriefingCache'
import { attachBrowserWorkerBroker, disposeBrowserWorkerBroker } from '../../core/agent/browserWorkerBroker'
import { attachMcpWorkerBroker } from '../../core/mcp/mcpWorkerBroker'
import { compressStoredMessages } from '../../core/context/historyCompressor'
import { applyJanitorSummaries, loadAssistantState } from '../../core/context/assistantState'
import {
  applyRollingWindowAsync, getContextSettings, estimateTokens, estimateMessagesTokensAsync,
  getModelContextWindow,
} from '../../core/context/contextManager'
import {
  calibrationKey, computeRequestContextSnapshot, exportCalibration, recordEstimateCalibration, setCalibrationModel,
} from '../../core/tokens/usageTracker'
import { withAIUsageContext, type AIRequestUsage } from '../../core/ai/requestUsage'
import { acceptAIUsage, getChatCost } from '../services/usageLedger'
import { getGatewayModelsCache } from '../../core/tokens/gatewayModelsCache'
import { getFileCacheSnapshot, mergeFileCache } from '../../core/context/fileReadCache'
import { invalidateHistoryCache, getMessagesAfterLatestCompactCached } from './historyCache'
import { buildContextHistory, countToolCalls, formatReplyQuote } from './chatContextHelpers'
import { buildContextUsagePayload, type ContextUsageBreakdown, type ContextUsagePayload } from '../../shared/contextUsage'
import { slimMessageForUI } from './slimMessages'
import { log, withLogPrivacy } from '../../core/logger'
import { perfMark, perfEvent, perfPhaseAsync } from '../../core/performanceDiagnostics'
import { getMcpManager } from '../../core/mcp/McpManager'
import { getPluginManager } from '../../core/plugins/pluginManager'
import { getSkillManager } from '../../core/skills/skillManager'
import { getSkillInstructions } from '../../core/skills/skillInstructions'
import { resolveActive } from '../services/protectedVarsStore'
import { secretPlaceholder } from '../../core/prompts/sections/secretsSection'
import { classifyDiagnosticOutcome, isExplicitTaskContinuation, isVerificationCommand } from '../../shared/types/taskSummary'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/types'
import type { Message, AgentSettings, ChatMode, QueueItemMeta, Attachment, AttachmentProcessingResult, ReplyTarget, Dot, DotConfig, Provider } from '../../shared/types'
import type { OrchestrationModel, OrchestrationProgress, OrchestrationRun, OrchestrationSelection } from '../../shared/orchestration'
import {
  blockRunningOrchestrationPhase, freezeOrchestrationRun, mergeOrchestrationProgress,
  orchestrationModeIssue, orchestrationProviderIssue, orchestrationSelectionIssue,
  slimOrchestrationPhases,
} from './orchestrationRun'
import { executeManageChats } from '../services/delegatedChats'
import { cleanupOrphanDraftFiles } from './mentions.ipc'
// Разбитые модули chat.ipc (рефакторинг — код перенесён как есть).
import { emitTaskSummary } from './taskSummary.ipc'
import { buildExtensionsReport, getSystemPrompt } from './chatSystemPrompt'
import { processAttachmentsAndStream } from './chatAttachments'
import { createCompactDivider, emitChatCompacted, getLiveMessages, persistTailToolTrim } from './chatCompaction'
import { autoNameChat, isChatTitleDefault } from './chatAutoTitle'
import { extractRecallKeywords, getRecallDedupKey, invalidateAutoRecallCache, searchAutoRecallCached } from './autoRecallCache'
import {
  broadcastGoal, broadcastTaskSummary, cancelledDelegatedStarts, chatStopImpl, drainQueue,
  emitQueueUpdate, ensureToolResults, failRunCleanup, flushRunIter, buildFinalIters,
  refreshDelegationSummary, sendChatMessageProgrammatic, updateForegroundBusy, type IpcMainWindow,
} from './chatRunSupport'
import {
  activeRuns, activeRunMeta, chatQueues, compactRuns, autoRecallInjectedKeys,
  confirmCallbacks, questionCallbacks, emitRunStatus, scheduleIdleExtraction,
  cancelIdleExtraction, getChatTitleForNotif, type ActiveRun, type QueuedSend,
} from './chatShared'

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

  /**
   * Реальный запуск воркера для chat:send. Вынесено из ipcMain.handle чтобы
   *  можно было ставить запросы в очередь на один chatId (если воркер уже
   *  работает) и вызывать drainQueue после терминального статуса.
   *
   *  Все ссылки на глобальные синглтоны (activeRuns, chatQueues) — module-level.
   *  store / mainWindow / getSystemPrompt — из замыкания registerChatIPC.
   */

async function runChatSendScoped(
    store: Store,
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
      /** §orchestration — one-turn оркестрация: выбор из UI (executor/reviewer).
       *  Планировщик снимает main на момент приёма запроса (см. chatSendHandler). */
      orchestration?: OrchestrationSelection
      /** Замороженный снапшот рана (planner+executor+reviewer), собранный при
       *  приёме запроса в очередь. Именно он уходит в workerData.orchestration —
       *  смена модели чата/настроек после постановки в очередь ран не меняет. */
    orchestrationRun?: OrchestrationRun
    /** §resume — «Продолжить»: план и сделанное из прерванного рана. */
    orchestrationResume?: unknown
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
    if ((!params.incognito || !!params.sideChatParentId) && getContextPreferences(dbChatId).sources.memory) {
      try { currentWorkingMemory = getWorkingMemory(dbChatId) } catch { /* ok */ }
      try { storedSummary = getChatSummary(dbChatId) } catch { /* ok */ }
    }

    // Обновляем createdAt на момент реального старта. Для queued-запросов
    // userMsg.createdAt был зафиксирован в chat:send при отправке (до очереди),
    // а saveMessage происходит только сейчас. Без этого БД (сортировка по
    // created_at ASC) поставит user2/user3 перед assistant1 — порядок
    // диалога сломается при перезаходе в чат.
    userMsg.createdAt = Date.now()
    if (!params.incognito) {
      saveMessage(userMsg)
      invalidateAutoRecallCache()
    }
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
    const rawHistory = buildContextHistory(liveMessages)
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
        log('[chat:send] rolling-window компакция chatId=%s: contextWindow=%d triggerTokens=%d(=%d%%) removed=%d сообщений, trimmed=%d tool-рез.',
          params.chatId, realContextWindow, triggerTokens, ctxSettings.rollingTriggerPct, result.removedCount, result.trimmedToolResults ?? 0)
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
          const tokensBefore = await perfPhaseAsync('chat.token_calc.before', () => estimateMessagesTokensAsync(rawHistory), { messageCount: rawHistory.length })
          // Пост-сжатый footprint = tail + summary (summary живёт в system
          // prompt следующих запросов) — иначе «сэкономлено» в divider'е
          // и toast'е завышено.
          const tailTokens = await perfPhaseAsync('chat.token_calc.after', () => estimateMessagesTokensAsync(result.messages), { messageCount: result.messages.length })
          const tokensAfter = tailTokens + (result.summaryContent ? estimateTokens(result.summaryContent) : 0)
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
              // Персистентный трим tail'а (см. chatCompaction.persistTailToolTrim):
              // иначе следующий запрос пересобрал бы из БД полный вес мега-хода.
              const trimmedMsgs = persistTailToolTrim(result.messages, liveMessages)
              if (trimmedMsgs > 0) {
                log('[chat:send] персистентный трим tool_steps в %d Message (chatId=%s)', trimmedMsgs, params.chatId)
              }
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
      : await getSystemPrompt(store, dbChatId, params.incognito, params.oneShotSkill, undefined,
        !!params.imageMode || params.slashCommand?.name === 'image' || getChatModes(dbChatId).imageMode)

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
      bufferedLiveState: { toolProgress: {}, spawnedAgents: [], steers: [] },
      streamCheckpointTimer: null,
      checkpointDirty: false,
      liveSnapshots: [],
      pendingQuestions: new Set<string>(),
      orchestration: [],
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
      updateForegroundBusy()

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
                        task.checks.length ? `Проверки:
 ${task.checks.slice(0, 5).map(item => `${item.title} — ${item.status === 'passed' ? 'пройдена' : item.status === 'failed' ? 'ошибка' : 'не подтверждена'}`).join('; ')}` : '',
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
      // §orchestration — финальный слим-снапшот фаз. При Стопе/обрыве фаза,
      // оставшаяся в статусе 'running', закрывается как 'blocked': иначе
      // карточка в истории навсегда показывала бы «выполняется».
      const orchestrationPhases = run.orchestration.length > 0
        ? slimOrchestrationPhases(finishReason === 'done'
          ? run.orchestration
          : blockRunningOrchestrationPhase(
              run.orchestration,
              finishReason === 'stopped' ? 'stopped by the user' : 'run failed',
            ))
        : undefined
      const assistantMsg: Message & { iterations?: unknown } = {
        id: assistantMsgId,
        chatId: params.chatId,
        role: 'assistant',
        // Теги <final_answer> — служебные: в content (превью чата, копирование,
        // озвучка, контекст без итераций) они не нужны. В iterations текст
        // остаётся С тегами — по ним UI понимает, что это ответ (см. finalAnswer.ts).
        content: stripFinalMarkers(fullText),
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
        // §orchestration — компактная карточка фаз для истории (после рестарта
        // live-событий уже нет, снапшот приходит из БД).
        orchestration: orchestrationPhases,
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

      if (!params.incognito) {
        // Commit final row and recovery-buffer removal together. The message
        // cache/chat touch callback runs after the transaction in the DB helper.
        saveMessageAndDeleteStreamingBuffer(assistantMsg)
        invalidateAutoRecallCache()
      } else {
        deleteStreamingBuffer(assistantMsgId)
      }
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
          // §rollback-live — при Stop/краше воркера финальный fileSnapshots не
          // приходит: берём накопленный по ходу рана буфер (иначе чекпоинт
          // сохранялся с filesChanged=0 и правки было не откатить).
          const snaps = pickSnapshots(run.liveSnapshots, fileSnapshots)
          // filesChanged/filePaths — это ФАЙЛЫ, а не число правок: снапшот
          // пишется на каждую правку, поэтому файл, изменённый 3 раза за turn,
          // иначе считался трижды (бейдж «3 файла» на один файл).
          let chatWorkdir: string | undefined
          try { chatWorkdir = getChatWorkdirContext(params.chatId).workdir } catch { /* ok */ }
          const filePaths = firstSnapshotPerPath(snaps, chatWorkdir).map(s => s.path)
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
    // §orchestration — ревалидация провайдеров на СТАРТЕ рана. Снапшот
    // заморожен на момент приёма запроса (chat:send), но пока запрос ждал в
    // очереди, провайдера могли отключить/удалить. Никакого fallback на модель
    // чата: ран не стартует, пользователь получает причину (failRunCleanup →
    // error-статус), а не тихую подмену исполнителя.
    const orchestrationRun = params.orchestrationRun ?? null
    if (orchestrationRun) {
      const providerIssue = orchestrationProviderIssue(
        orchestrationRun,
        store.get('providers') as Provider[] | undefined,
      )
      if (providerIssue) throw new Error(providerIssue)
    }
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
    let mcpProjectId: string | undefined
    try {
      const mgr = getMcpManager()
      // projectId для scope-фильтрации MCP-серверов
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
      if (mcpTools.length) {
        const configs = new Map(mgr.getAllServers({ projectWorkdir: chatWorkdir, projectId: mcpProjectId }).map(c => [c.id, c]))
        for (const tool of mcpTools) {
          const config = configs.get(tool.serverId)
          mcpApprovalMap[tool.name] = config ? mgr.requiresApproval(config, tool.name) : true
        }
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

    // projectId для привязки памяти/графа к проекту
    let chatProjectId: string | undefined
    if (chatWorkdir) {
      // Нормализуем через path.resolve — иначе trailing slash / регистр
      // на Windows дают path-mismatch и projectId не резолвится.
      const normWorkdir = path.resolve(chatWorkdir)
      const found = getAllProjects().find(p => path.resolve(p.workdir) === normWorkdir)
      chatProjectId = found?.id
    }

    // dbPath — абсолютный путь к syntee.db (worker открывает своё connection, WAL safe)
    // ── Применение one-shot параметров кастомной команды ──
    // oneShotSkill инъектирует инструкции скилла в system prompt.
    // oneShotAllowedTools фильтрует schemas до указанного списка.
    // effectivePlanningMode/effectiveAskMode объявлены выше (до token
    // estimation) — workerData ниже использует эти значения.

    // §secrets — secretValuesMap резолвится ОДИН раз в начале прогона (до
    // построения истории — для маскировки tool-результатов) и переиспользуется
    // здесь для workerData.

    if (cancelledDelegatedStarts.has(assistantMsgId)) throw new Error('Delegated request cancelled during preparation')
    // ── Мини-агенты: снапшот настроек и briefing-continuity на старте воркера ──
    // Настройки передаём в workerData, чтобы глобальный Off действовал с ПЕРВОГО
    // раунда: attachAssistants() при выключенных мини-агентах вообще не шлёт
    // 'assistants_settings', а воркер до этого жил на DEFAULT (enabled: true).
    const assistantsSettingsSnapshot = getAssistantsSettings()
    // Briefing continuity (git log/status) считает main — кеш на проект,
    // коалесинг параллельных чатов, git не запускается, если подпись
    // репозитория/изменённые файлы не менялись
    // (src/main/assistants/gitBriefingCache.ts). Воркер git больше не спавнит.
    // Within(...) — с бюджетом ожидания: старт чата не блокируется на git.
    const briefingContinuity = assistantsSettingsSnapshot.enabled && assistantsSettingsSnapshot.briefingEnabled
      ? await getBriefingContinuityWithin(chatWorkdir)
      : ''
    const worker = new Worker(workerPath, {
      workerData: {
        storeData,
        planningMode: effectivePlanningMode,
        askMode: effectiveAskMode,
        imageMode: !!params.imageMode || params.slashCommand?.name === 'image' || getChatModes(params.chatId).imageMode,
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
        // Калибровка оценки контекста (см. usageTracker.recordEstimateCalibration):
        // воркер не имеет доступа к electron-store, поэтому получает снапшот.
        contextCalibration: exportCalibration(),
        // Свежий токен с авто-refresh: воркер не может рефрешить сам
        // (electron-store/tokenStore в worker_threads недоступны).
        gatewayToken: await getGatewayAuthToken().catch(() => getAccessToken()),
        // ChatGPT-подписка (Codex): worker не умеет читать codexAuth
        // (electron-store + safeStorage живут в main), поэтому передаём токен
        // и account id снапшотом; refresh идёт round-trip'ом 'codex_token_refresh'.
        codexToken: await getCodexAccessToken().catch(() => null),
        codexAccountId: getCodexAccountId(),
        fileCacheSnapshot: getFileCacheSnapshot(params.chatId),
        workdir: chatWorkdir,
        // userData path — для fallback-поиска картинок-вложений в
        // draft-attachments, когда AI вызывает analyze_image с именем
        // файла-вложения (без полного пути).
        userDataPath: app.getPath('userData'),
        verificationCommand,
        projectId: chatProjectId,
        mcpTools,
        mcpApprovalMap,
        pluginTools,
        pluginApprovalMap,
        // Защищённые переменные: key → decrypted value. Worker строит Map и
        // передаёт в Agent/ToolDispatcher для подстановки ${{KEY}} в аргументы
        // тулов и обратной маскировки значений в результатах.
        secretValues: secretValuesMap,
        // Мини-агенты: применяются воркером ДО первого раунда (см. ai-worker).
        assistantsSettings: assistantsSettingsSnapshot,
        briefingContinuity,
        // §orchestration — замороженный снапшот ролей (planner/executor/reviewer).
        // undefined → воркер работает как обычно (ни фаз, ни инструкций).
        orchestration: orchestrationRun ?? undefined,
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
    const mcpServersByTool = new Map(mcpTools.map(tool => [tool.name, tool.serverId]))
    attachMcpWorkerBroker(worker, async (toolName, args, signal) => {
      const serverId = mcpServersByTool.get(toolName)
      if (!serverId || run.doneSent) return { success: false, output: '', error: 'MCP-инструмент недоступен в этом запуске' }
      return getMcpManager().callToolByName(toolName, args, {
        serverId, projectWorkdir: chatWorkdir, projectId: mcpProjectId, signal,
      })
    })
    run.worker = worker
    activeRuns.set(params.chatId, run)
    attachAssistants(params.chatId, worker, { projectWorkdir: chatWorkdir, projectId: chatProjectId, incognito: !!params.incognito })
    void onAgentEvent(params.chatId, { kind: 'task_start', text: params.content.slice(0, 300) })
    updateForegroundBusy()

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
          content: stripFinalMarkers(run.bufferedText),
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
          // §orchestration — фазы попадают в recovery-буфер: после краша
          // процесса буфер переносится в messages (historyCache) и карточка
          // прогресса не теряется.
          orchestration: slimOrchestrationPhases(run.orchestration),
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
          processAttachmentsAndStream(store,
            // effectiveContent (не params.content): уже может содержать
            // реплай-цитату поверх — инлайн-блоки файлов добавляются после неё.
            win, params.chatId, assistantMsgId, effectiveContent, params.attachments, getModelContextWindow(storeData),
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

    // Оценка контекста последнего запроса этого рана — нужна для калибровки:
    // когда придёт реальный usage, сравним его с этой оценкой (usageTracker).
    let lastEstimate: { estimated: number } | null = null

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

        // Worker поймал 401 от бэкенда ChatGPT — просит свежий Codex-токен.
        case 'codex_token_refresh': {
          const replyId = msg.replyId as string
          forceRefreshCodexToken()
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

        // Мини-агенты (navigator/archivist/constitution/refine):
        // worker шлёт событие, main решает запускать ли локальную модель.
        case 'assistant_event': {
          void onAssistantEvent(params.chatId, msg as Record<string, unknown>)
          break
        }
        // §rollback-live — воркер отдаёт {path, contentBefore} на каждую
        // правку файла. Копим в run.liveSnapshots: если финальный done не
        // придёт (Stop/краш воркера), sendDone возьмёт этот буфер, и правки
        // прогона останутся откатываемыми.
        case 'file_snapshot': {
          const snap = msg.snapshot as { path?: unknown; contentBefore?: unknown } | undefined
          if (snap && typeof snap.path === 'string') {
            run.liveSnapshots.push({
              path: snap.path,
              contentBefore: typeof snap.contentBefore === 'string' ? snap.contentBefore : null,
            })
            // Защита от неограниченного роста (марафонский рефакторинг):
            // undoStack агента всё равно ограничен 50 записями.
            if (run.liveSnapshots.length > 500) run.liveSnapshots.splice(0, run.liveSnapshots.length - 500)
          }
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
          if (summaryTaskId && rawStep.type === 'tool_result' && ['get_diagnostics', 'run_command'].includes(String(rawStep.toolName)) && msg.msgId === assistantMsgId && typeof rawStep.content === 'string') {
            const state = getTaskSummaryState(params.chatId); const task = state.tasks.find(t => t.id === summaryTaskId)
            if (task) {
              const output = rawStep.content.slice(0, 4000)
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
              task.checks=task.checks.slice(0,30); task.updatedAt=Date.now(); const next=upsertTaskSummary(task); broadcastTaskSummary?.(params.chatId, next)
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
              if (rawStep.codeMode) result.codeMode = rawStep.codeMode
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
              fileSnapshots: rawStep.fileSnapshots,
              diff: rawStep.diff,
              callId: rawStep.callId,
              pendingCallId: rawStep.pendingCallId,
              serverName: rawStep.serverName,
              codeMode: rawStep.codeMode,
              // §steer — реплика пользователя, применённая внутри рана.
              steerId: rawStep.steerId,
              steerApplied: rawStep.steerApplied,
              attachments: rawStep.attachments,
            }
            run.bufferedSteps.push(ts)
            run.checkpointDirty = true
            // §rollback-subagent — снапшоты merge-back'а уже встроены в
            // tool_result spawn_agent; добавляем их в live-буфер родителя
            // сразу, чтобы Stop/краш родительского worker'а тоже переживался.
            if (rawStep.type === 'tool_result' && rawStep.toolName === 'spawn_agent' && Array.isArray(rawStep.fileSnapshots)) {
              for (const snap of rawStep.fileSnapshots as Array<{ path?: unknown; contentBefore?: unknown }>) {
                if (typeof snap.path === 'string') {
                  const normalized = {
                    path: snap.path,
                    contentBefore: typeof snap.contentBefore === 'string' ? snap.contentBefore : null,
                  }
                  const duplicate = run.liveSnapshots.some(existing =>
                    existing.path === normalized.path && existing.contentBefore === normalized.contentBefore,
                  )
                  if (!duplicate) run.liveSnapshots.push(normalized)
                }
              }
            }
            if (rawStep.type === 'steer' && typeof rawStep.steerId === 'string') {
              const card = run.bufferedLiveState.steers.find(s => s.steerId === rawStep.steerId)
              if (card) {
                card.applied = true
                // Мета вложений могла не доехать в card при принятии (renderer
                // прислал, а push в steers был до обработки) — дозаполняем.
                if (!card.attachments && Array.isArray(rawStep.attachments)) card.attachments = rawStep.attachments
              }
              else run.bufferedLiveState.steers.push({
                steerId: rawStep.steerId,
                text: typeof rawStep.content === 'string' ? rawStep.content : '',
                ts: Date.now(),
                applied: true,
                ...(Array.isArray(rawStep.attachments) ? { attachments: rawStep.attachments } : {}),
              })
            }
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
            } else if (rawStep.type === 'tool_result' || rawStep.type === 'steer' || rawStep.type === 'hint' || rawStep.type === 'janitor') {
              // §steer — карточка встаёт в текущую итерацию: хронологически
              // реплика приходит после tool_result предыдущего раунда и до
              // tool_call следующего, то есть в хвост уже открытой итерации.
              run.currentIterSteps.push(ts)
              if (rawStep.type === 'tool_result' && rawStep.success === false && rawStep.toolName) {
                const errText = String(rawStep.content ?? '')
                void onAgentEvent(params.chatId, { kind: 'tool_error', toolName: String(rawStep.toolName), error: errText.slice(0, 200) })
                if (/unavailable in the current run|is disabled|not available in the current mode|Permission denied|blocked by/i.test(errText)) {
                  void onAgentEvent(params.chatId, { kind: 'capability_gap', toolName: String(rawStep.toolName), text: errText.slice(0, 200) })
                }
              }
              if (rawStep.type === 'janitor') {
                onJanitorAction(params.chatId, String(rawStep.janitorKind ?? ''), String(rawStep.content ?? ''), Number(rawStep.janitorTokensSaved ?? 0))
              }
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
            const grant = persistApprovalGrant(store, { toolName, args, chatId: params.chatId, projectId: chatProjectId, workdir: chatWorkdir, approved, always, toolWide })
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
          // Помечаем запрос как висящий — при Стопе/падении run его надо снять
          // с панели (иначе QuestionPanel показывал бы вопрос мёртвого рана).
          run.pendingQuestions?.add(reqId)
          // Глобальный callback Map — для notification overlay
          questionCallbacks.set(reqId, (answers: import('../../shared/types').QuestionAnswer[]) => {
            run.pendingQuestions?.delete(reqId)
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

        case 'orchestration_progress': {
          // §orchestration — прогресс фаз one-turn оркестрации. Одно событие на
          // переход (running при входе в фазу, done/blocked при выходе).
          // msgId в событии — id assistant-сообщения рана, но источником истины
          // для UI/live-буфера считаем run.msgId: событие чужого (уже
          // завершённого) рана не должно оживлять карточку нового пузыря.
          const progress = msg.progress as OrchestrationProgress | undefined
          // Событие принадлежит КОНКРЕТНОМУ рану: воркер шлёт id своего
          // assistant-сообщения. Позднее событие прошлого рана (terminate не
          // мгновенный) не должно ни оживлять карточку нового пузыря, ни
          // попадать в буфер нового рана.
          if (!progress || !progress.phase || (msg.msgId && msg.msgId !== assistantMsgId)) break
          const orchRun = activeRuns.get(msg.chatId as string)
          if (orchRun && orchRun.msgId === assistantMsgId) {
            orchRun.orchestration = mergeOrchestrationProgress(orchRun.orchestration, progress)
            // Фаза сменилась — checkpoint-таймер должен записать снапшот даже
            // если токенов с прошлого чекпоинта не было.
            orchRun.checkpointDirty = true
          }
          win?.webContents.send(IPC_EVENTS.AGENT_ORCHESTRATION_PROGRESS, {
            chatId: params.chatId,
            msgId: assistantMsgId,
            progress,
          })
          break
        }

        case 'tool_progress':
          // Progress для долгих тулов — live-индикация этапов.
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

        case 'code_trace':
          // Живой трейс вложенных тулов execute_code (status:'running' →
          // финал, апсерт по id в renderer). Ephemeral: в БД не персистим —
          // итоговый трейс приходит в самом tool_result.
          win?.webContents.send('agent:code_trace', {
            msgId: msg.msgId, chatId: msg.chatId, entry: msg.entry,
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
            const roleDef = getSubagentRole(msg.role as string | undefined)
            // Every role, including the default implementer, must receive its
            // specialized instructions. Previously implementer was omitted,
            // making its role prompt effectively dead code.
            const spawnResult = await agentManager.spawn({
              id: msg.id as string,
              parentId: msg.msgId as string,
              chatId: msg.chatId as string,
              task: msg.task as string,
              model: msg.model as string | undefined,
              isolation: msg.isolation as 'auto' | 'worktree' | 'none' | undefined,
              role: msg.role as string | undefined,
              onFileSnapshot: (snapshots) => {
                const parentRun = activeRuns.get(msg.chatId as string)
                if (parentRun && !parentRun.doneSent) {
                  parentRun.liveSnapshots.push(...snapshots)
                  parentRun.checkpointDirty = true
                }
              },
              mode: chatMode,
              storeData: { ...storeData, agentSettings },
              context: {
                systemPrompt: buildSubagentSystemPrompt({
                  role: roleDef,
                  task: msg.task as string,
                  parentSummary,
                  parentWorkingMemory,
                }),
                history: processedHistory.slice(-12),
                workingMemory: parentWorkingMemory,
                mode: chatMode,
                workdir: chatWorkdir,
                projectId: chatProjectId,
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
              const report = await buildExtensionsReport(params.chatId, msg.options as Parameters<typeof buildExtensionsReport>[1])
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
            noteBriefingChanges(chatWorkdir, [filePath])
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
              invalidateAutoRecallCache()
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

        // project_map runs in main: the worker thread has no initialized DB
        // (pattern recall_memory). Зеркало случая в AgentManager (суб-агенты).
        case 'project_map': {
          ;(async () => {
            const rpcStarted = Date.now()
            try {
              const result = await projectMapQuery(
                {
                  action: msg.action as
                    | 'search' | 'semantic' | 'callers' | 'callees' | 'file' | 'overview'
                    | 'god' | 'communities' | 'path' | 'explain' | 'affected',
                  query: msg.query as string | undefined,
                  // Второй узел для action=path + обход/бюджет. Без этих полей
                  // `path` всегда отвечал «requires query and to», хотя агент их присылал.
                  to: msg.to as string | undefined,
                  path: msg.path as string | undefined,
                  nodeId: msg.nodeId as string | undefined,
                  limit: msg.limit as number | undefined,
                  depth: msg.depth as number | undefined,
                  relations: msg.relations as Array<'calls' | 'references' | 'imports'> | undefined,
                  budget: msg.budget as number | undefined,
                },
                (msg.projectId as string | undefined) ?? undefined,
              )
              log('[project_map] rpc done in %dms (success=%s)', Date.now() - rpcStarted, result.success)
              worker.postMessage({ type: 'project_map_reply', replyId: msg.replyId, ...result })
            } catch (e) {
              log('[project_map] rpc FAILED in %dms: %s', Date.now() - rpcStarted, (e as Error).message)
              worker.postMessage({ type: 'project_map_reply', replyId: msg.replyId, success: false, output: '', error: (e as Error).message })
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

        case 'request_usage':
          acceptAIUsage({ ...(msg.event as AIRequestUsage), chatId: params.chatId })
          break

        case 'context_usage': {
          // Payload воркера приходит как Record<string, unknown> — приводим к
          // контракту один раз, чтобы не раскидывать as-касты по всему блоку.
          const workerUsage = msg as unknown as ContextUsagePayload & {
            rawPromptTokens?: number
            rawCompletionTokens?: number
            rawCacheReadTokens?: number
            rawCacheWriteTokens?: number
          }
          const usageSnapshot = {
            estimated: Number(workerUsage.estimated) || 0,
            limit: Number(workerUsage.limit) || 0,
            breakdown: (workerUsage.breakdown ?? { history: 0, system: 0, tools: 0, current: 0 }) as ContextUsageBreakdown,
            compressed: contextCompressed,
          }
          // Сохраняем последний real usage в БД — переживает перезапуск.
          // context:calculate читает его, чтобы показывать точный контекст
          // после перезахода (tiktoken-оценка без этого занижает до 12k).
          if (workerUsage.source === 'real' && params.chatId) {
            try {
              setChatLastUsage(params.chatId, {
                promptTokens: usageSnapshot.estimated,
                completionTokens: usageSnapshot.breakdown.completionTokens ?? 0,
                cacheReadTokens: usageSnapshot.breakdown.cacheReadTokens,
                cacheWriteTokens: usageSnapshot.breakdown.cacheWriteTokens,
                ts: Date.now(),
              })
            } catch { /* ok — не критично */ }
            // Калибровка: сравниваем реальный prompt_tokens с последней
            // оценкой ЭТОГО ЖЕ запроса (её запомнил emit ниже). Так оценка
            // перестаёт систематически завышать (cl100k vs токенизатор модели).
            if (lastEstimate?.estimated) {
              // Ключ — из самого замера провайдера, а не из общего состояния:
              // чаты с разными моделями не должны учить друг друга.
              recordEstimateCalibration(
                lastEstimate.estimated,
                usageSnapshot.estimated,
                calibrationKey(workerUsage.providerId, workerUsage.modelId),
              )
            }
            // Аккумулируем сырые токены turn'а в run-буфер: при Стопе/краше
            // воркера done/error не приходят, но статистика токенов уже
            // известна main'у — sendDone возьмёт её из bufferedUsage.
            if (typeof workerUsage.rawPromptTokens === 'number' || typeof workerUsage.rawCompletionTokens === 'number') {
              run.bufferedUsage.promptTokens = Math.max(run.bufferedUsage.promptTokens, workerUsage.rawPromptTokens || 0)
              run.bufferedUsage.completionTokens = Math.max(run.bufferedUsage.completionTokens, workerUsage.rawCompletionTokens || 0)
              run.bufferedUsage.cacheReadTokens = Math.max(run.bufferedUsage.cacheReadTokens, workerUsage.rawCacheReadTokens || 0)
              run.bufferedUsage.cacheWriteTokens = Math.max(run.bufferedUsage.cacheWriteTokens, workerUsage.rawCacheWriteTokens || 0)
            }
          } else if (params.chatId) {
            // Запоминаем оценку текущего запроса: именно её сравним с реальным
            // prompt_tokens, когда он придёт (см. recordEstimateCalibration).
            // Оценка с scope='request' — самая точная пара: она посчитана по
            // тому же массиву messages + schemas, что ушёл провайдеру.
            lastEstimate = { estimated: usageSnapshot.estimated }
          }
          win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
            ...buildContextUsagePayload({
              chatId: params.chatId,
              snapshot: usageSnapshot,
              source: workerUsage.source === 'real' ? 'real' : 'estimate',
              scope: workerUsage.scope === 'request' ? 'request' : undefined,
              compressed: contextCompressed,
              historyMessages: history.length,
              toolCallsCount: countToolCalls(history),
              pricing: workerUsage.pricing ?? null,
              estimatedCostCents: workerUsage.estimatedCostCents ?? null,
              providerId: workerUsage.providerId,
              modelId: workerUsage.modelId,
            }),
            ...getChatCost(params.chatId),
          })
          break
        }

        case 'done':
          // W1 feedback: реально вызванные тулы/скиллы рана (из шагов) —
          // точный сигнал для весов возможностей watcher'а.
          {
            const runSteps = ((msg.collectedSteps as Array<Record<string, unknown>> | undefined) ?? run.bufferedSteps) as Array<Record<string, unknown>>
            const invokedTools: string[] = []
            const invokedSkills: string[] = []
            for (const s of runSteps ?? []) {
              if (!s || s.type !== 'tool_call') continue
              const name = String(s.toolName ?? '')
              if (!name) continue
              invokedTools.push(name)
              if (name === 'get_skill') {
                const skill = (s.toolArgs as { name?: unknown } | undefined)?.name
                if (typeof skill === 'string' && skill) invokedSkills.push(skill)
              }
            }
            void onRunDone(params.chatId, String(msg.fullText ?? run.bufferedText ?? ''), { tools: invokedTools, skills: invokedSkills })
          }
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
          // Сообщение уже в БД — сжимаем сохранённую историю (вариант B):
          // следующий запрос получит сжатые tool-результаты вместо сырых.
          persistHistoryCompression(params.chatId)
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
            updateForegroundBusy()
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
      ? `Ты параллельный доп-агент в правой панели. У тебя есть read-only доступ к файловой системе (read_file, read_files, list_directory, find_files, search_code) и к основному чату через тул get_main_chat_messages — используй его чтобы запросить конкретные сообщения из истории основного чата, если нужен контекст или детали диалога. Ты НЕ можешь изменять файлы или выполнять команды — только читать и искать.

Ниже — системный промпт и контекст основного чата (проект, рабочая память, сводка):

${await getSystemPrompt(store, dbChatId, params.incognito, params.oneShotSkill)}`
      : undefined

    let sideToolSchemas = getToolSchemas({
      customToolsEnabled: store.get('customToolsEnabled', false) === true,
      disabledTools: store.get('disabledTools', []) as string[],
      planningMode: effectivePlanningMode,
      askMode: effectiveAskMode,
      imageMode: !!params.imageMode || params.slashCommand?.name === 'image' || getChatModes(params.chatId).imageMode,
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
    // Automatic retrieval stays in the current project; explicit recall_memory
    // retains its separately requested cross-project option.
    const isFirstMessage = processedHistory.length === 0
    if (!params.incognito && getContextPreferences(dbChatId).sources.memory && effectiveContent.trim().length > (isFirstMessage ? 10 : 20)) {
      try {
        // C1: keyword extraction — убирает stopwords, оставляет значимые термины
        const recallQuery = extractRecallKeywords(effectiveContent.slice(0, 500))

        const results = await searchAutoRecallCached({
          query: recallQuery,
          projectId: chatProjectId,
          chatId: dbChatId,
          limit: isFirstMessage ? 10 : 5,
          sources: isFirstMessage ? 'all' : ['memory', 'messages', 'summaries'],
        })

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
    // §goal (семантика Claude Code): пока цель set (running) или приостановлена
    // (paused — ждёт следующего сообщения), ЛЮБОЙ ход в чате продолжает работу
    // к цели. Оценщик проверяет условие после каждого хода.
    const activeGoal = runtimeGoal && (runtimeGoal.status === 'running' || runtimeGoal.status === 'paused')
      ? runtimeGoal : null
    let goalRevision = activeGoal?.updatedAt
    worker.on('message', (event: Record<string, unknown>) => {
      if (event.type !== 'goal_progress' || !activeGoal) return
      try {
        const current = getChatGoal(params.chatId)
        const next = event.goal as import('../../shared/types/goal').ChatGoal | undefined
        // Never resurrect a goal stopped/replaced/edited by the user mid-run.
        if (!current || current.id !== activeGoal.id || current.updatedAt !== goalRevision) {
          worker.postMessage({ type: 'abort_run' })
          return
        }
        if (!next || next.id !== current.id || next.chatId !== params.chatId) return
        const saved = setChatGoal({ ...current, status: next.status, steps: next.steps,
          progress: next.progress, evidence: next.evidence, blocker: next.blocker,
          turnsEvaluated: next.turnsEvaluated, tokensSpent: next.tokensSpent,
          lastReason: next.lastReason, idleTurns: next.idleTurns, startedAt: next.startedAt })
        goalRevision = saved?.updatedAt
        broadcastGoal(params.chatId, saved)
      } catch (error) {
        log('[goal-runtime] persistence failed: %s', String(error))
        worker.postMessage({ type: 'abort_run' })
      }
    })
    worker.once('exit', () => {
      if (!activeGoal || run.doneSent) return
      const current = getChatGoal(params.chatId)
      if (current?.id === activeGoal.id && current.updatedAt === goalRevision) {
        // Прогон оборвался (крэш/терминация): цель НЕ снимается — как в [CC]
        // она восстанавливается, и следующий ход продолжает работу.
        const saved = setChatGoal({ ...current,
          progress: [...current.progress, 'Прогон прерван; проверь состояние перед продолжением'].slice(-100) })
        broadcastGoal(params.chatId, saved)
      }
    })
    if (ctxSettings.tokenCounterEnabled) {
      // Калибровка привязана к паре provider:model. Ключ передаём явно: в main
      // параллельно живут разные чаты с разными моделями.
      const calibration = calibrationKey(mainAssignment?.providerId, mainAssignment?.modelId)
      setCalibrationModel(mainAssignment?.providerId ?? '', mainAssignment?.modelId ?? '')
      // Джанитор свёртывает tool-результаты в памяти воркера, в БД они лежат
      // целиком. Применяем те же резюме к копии истории ДО оценки и ДО отправки
      // воркеру — иначе стартовая оценка круга считает несжатый контекст и
      // расходится с реальным usage (и с тем, что агент реально увидит).
      const collapsed = applyJanitorSummaries(processedHistory, loadAssistantState(app.getPath('userData'), params.chatId)?.janitorArchive)
      if (collapsed > 0) {
        log('[chat:send] chatId=%s janitor summaries applied to %d tool results', params.chatId, collapsed)
      }
      const initialPermittedSchemas = orchestrationRun
        ? filterSchemasForPhase(sideToolSchemas, orchestrationRun.resume ? 'executing' : 'planning')
        : sideToolSchemas
      const requestSchemas = initialMcpSchemas(initialPermittedSchemas, processedHistory,
        ctxSettings.deferredMcpTools !== false && !isToolDisabled('discover_mcp_tools', getToolSettings(store)))
      const requestSnapshot = computeRequestContextSnapshot([
        { role: 'system', content: systemPrompt ?? '' },
        ...processedHistory,
        { role: 'user', content: run.imageParts?.length
          ? [...run.imageParts, { type: 'text', text: effectiveContent }] : effectiveContent },
      ], getModelContextWindow(storeData), requestSchemas, calibration)
      win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
        ...buildContextUsagePayload({
          chatId: params.chatId,
          snapshot: requestSnapshot,
          source: 'estimate',
          scope: 'request',
          compressed: contextCompressed,
          historyMessages: processedHistory.length,
          toolCallsCount: countToolCalls(history),
        }),
        ...getChatCost(params.chatId),
      })
    }
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


  // ── Персистентная компрессия истории (вариант B) ─────────────────────────
  // Джанитор рана сжимает контекст только в памяти — БД хранит сырые
  // tool-результаты, и каждый новый запрос разворачивает их заново
  // (кольцо осциллирует: сжалось в ране → новый запрос вернуло всё).
  // Детерминированная компрессия записей в БД на конце рана делает сжатие
  // постоянным: следующий запрос сразу получает сжатую историю.
  function persistHistoryCompression(chatId: string): void {
    try {
      const s = getAssistantsSettings()
      if (!s.enabled || !s.janitorEnabled) return
      const rows = getMessagesAfterLatestCompact(chatId)
      // Модель чата — для калибровки «сэкономлено токенов» (та же шкала, что у кольца).
      const modelForCalibration = getChatModel(chatId)
      const plans = compressStoredMessages(rows, {
        minSavingsTokens: s.janitorMinSavingsTokens,
        tailKeep: Math.max(1, s.janitorTailSteps ?? 10),
        calibrationKey: calibrationKey(modelForCalibration?.modelProvider, modelForCalibration?.modelId),
      })
      let totalSaved = 0
      for (const [id, plan] of plans) {
        updateMessageToolSteps(id, plan.toolSteps, plan.iterations)
        totalSaved += plan.savedTokens
        onJanitorAction(chatId, 'persist_compress', `сжато в БД: ${plan.actions.join(', ')}`, plan.savedTokens)
      }
      if (plans.size > 0) {
        invalidateHistoryCache(chatId)
        log('[chat:send] history compressed in DB: chatId=%s rows=%d saved=%d tokens', chatId, plans.size, totalSaved)
      }
    } catch (e) {
      log('[chat:send] history compression failed chatId=%s: %s', chatId, (e as Error).message)
    }
  }


  // Регистрируется и как IPC-хендлер, и как programmatic-API (см.
  // sendChatMessageProgrammatic выше): DotManager будит Dot'ов из main.
export function runChatSend(...args: Parameters<typeof runChatSendScoped>): ReturnType<typeof runChatSendScoped> {
  return withLogPrivacy(!!args[1].incognito, () => withAIUsageContext({ chatId: args[1].chatId }, () => runChatSendScoped(...args)))
}

/**
 * §orchestration — модель-планировщик на момент приёма запроса.
 *
 * Планировщик = текущая модель чата (chats.model_id/provider) либо глобальное
 * назначение role:'main', плюс её уровень мышления. Та же приоритетность, что
 * у основного рана (params.reasoningValue > chats.reasoning_value > store),
 * поэтому планировщик видит ровно тот reasoning, который видит чат.
 */
function resolvePlannerModel(
  store: Store,
  dbChatId: string,
  reasoningValue?: string,
): OrchestrationModel | null {
  let providerId = ''
  let modelId = ''
  try {
    const chatModel = getChatModel(dbChatId)
    if (chatModel) {
      providerId = chatModel.modelProvider
      modelId = chatModel.modelId
    }
  } catch { /* чат мог быть удалён */ }
  if (!providerId || !modelId) {
    const assignment = (store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined)
      ?.find(a => a.role === 'main')
    providerId = assignment?.providerId ?? ''
    modelId = assignment?.modelId ?? ''
  }
  if (!providerId || !modelId) return null
  let reasoning = reasoningValue
  if (reasoning === undefined) {
    try {
      const chatReasoning = getChatReasoning(dbChatId)
      if (chatReasoning !== null) reasoning = chatReasoning
    } catch { /* ok */ }
  }
  if (reasoning === undefined) {
    const globalReasoning = store.get('reasoningValue')
    if (typeof globalReasoning === 'string') reasoning = globalReasoning
  }
  const model: OrchestrationModel = { providerId, modelId }
  if (typeof reasoning === 'string' && reasoning.length > 0) model.reasoningValue = reasoning
  return model
}

export async function chatSendHandler(store: Store, mainWindow: IpcMainWindow, params: {
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
    /** Side-чат: DB-lookups (модель/reasoning/workdir) идут по родителю. */
    sideChatParentId?: string
    /** §orchestration — one-turn оркестрация (renderer шлёт только роли
     *  executor/reviewer; планировщика снимает main). */
    orchestration?: OrchestrationSelection
    /** Замороженный снапшот рана — заполняется ниже (внутреннее поле). */
    orchestrationRun?: OrchestrationRun
    /** §resume — «Продолжить» с карточки прерванного рана. */
    orchestrationResume?: unknown
  }): Promise<{ userMsg: Message; assistantMsgId: string; queued?: boolean }> {
    const win = mainWindow.getWindow()

    // Фаза 3: сбрасываем idle-extraction timer — пользователь снова активен.
    if (!params.incognito) cancelIdleExtraction(params.chatId)

    // Читаем режим из БД — надёжнее чем доверять клиенту (защита от рассинхрона)
    const chatMode: ChatMode = params.mode ?? (() => { try { return getChatMode(params.chatId) } catch { return 'code' } })()

    const agentSettings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings

    // ── §orchestration — one-turn оркестрация (/orchestrate) ────────────────
    // Валидация ДО любых side-effect'ов (user-сообщение, pending-вложения,
    // очередь): renderer показывает текст ошибки в блоке оркестрации и НЕ
    // чистит черновик. Бросок отсюда = отказ старта (renderer ловит и
    // показывает «Оркестрация не запустилась: <причина>»).
    // Снапшот замораживается ЗДЕСЬ — на момент приёма запроса в очередь:
    // планировщик = текущая модель чата (+её reasoning), ревьюер по умолчанию
    // = планировщик (явно; core при undefined фазу ревью ПРОПУСКАЕТ).
    if (params.orchestration) {
      // Флаги режимов берём из запроса И из БД (chats.ask_mode/planning_mode/
      // image_mode): клиент может не прислать тоггл, но права рана от этого не
      // должны расширяться — Ask/Plan остаются запретом на запись/реализацию.
      let dbModes: { askMode?: boolean; planningMode?: boolean; imageMode?: boolean } = {}
      try { dbModes = getChatModes(params.sideChatParentId ?? params.chatId) } catch { /* чат мог быть удалён */ }
      const modeIssue = orchestrationModeIssue({
        askMode: params.askMode || dbModes.askMode || params.slashCommand?.name === 'ask',
        planningMode: params.planningMode || dbModes.planningMode,
        imageMode: params.imageMode || dbModes.imageMode || params.slashCommand?.name === 'image',
        oneShotMode: params.oneShotMode,
      })
      if (modeIssue) throw new Error(modeIssue)
      const selectionIssue = orchestrationSelectionIssue(params.orchestration)
      if (selectionIssue) throw new Error(selectionIssue)
      const planner = resolvePlannerModel(store, params.sideChatParentId ?? params.chatId, params.reasoningValue)
      if (!planner) throw new Error('модель чата не выбрана — оркестрация невозможна')
      const frozen = freezeOrchestrationRun(params.orchestration, planner, params.orchestrationResume)
      if (!frozen) throw new Error('некорректный выбор моделей оркестрации')
      // Провайдеры сверяем уже на приёме: ран не должен «повиснуть» на
      // недоступной модели. На старте рана проверка повторяется (см. ниже) —
      // без fallback в обоих местах.
      const providerIssue = orchestrationProviderIssue(frozen, store.get('providers') as Provider[] | undefined)
      if (providerIssue) throw new Error(providerIssue)
      params.orchestrationRun = frozen
      log('[chat:send] orchestration chatId=%s planner=%s/%s executor=%s/%s reviewer=%s/%s',
        params.chatId,
        frozen.planner.providerId, frozen.planner.modelId,
        frozen.executor.providerId, frozen.executor.modelId,
        frozen.reviewer?.providerId, frozen.reviewer?.modelId)
    }

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
        run: async () => { await runChatSend(store, params, win, chatMode, agentSettings, userMsg,
          params.incognito ? [] : getMessagesAfterLatestCompactCached(params.chatId, userMsg.id), assistantMsgId) },
        meta,
      }
      const q = chatQueues.get(params.chatId) ?? []
      q.push(queued)
      chatQueues.set(params.chatId, q)
      // Эмитим обновление очереди — UI покажет новый ожидающий запрос.
      emitQueueUpdate(win, params.chatId)
      // Даже queued-сообщение считается отправленным: Git-проверка запускается
      // отдельно и не ждёт освобождения AI-слота.
      if (!params.incognito) {
        setImmediate(() => {
          try {
            const workdir = getChatWorkdirContext(params.chatId).workdir
            if (workdir) getGitSyncManager()?.checkWorkdir(workdir, true)
          } catch (error) {
            log('[chat:send] queued git sync background check skipped: %s', String((error as Error)?.message ?? error))
          }
        })
      }
      return { userMsg, assistantMsgId, queued: true }
    }

    // Слот свободен — стартуем сразу. Запоминаем meta как активный запуск.
    activeRunMeta.set(params.chatId, { ...meta, startedAt: Date.now() })
    updateForegroundBusy()
    // Fire-and-forget: runChatSend await-ит processAttachmentsAndStream
    // (vision-модель, чтение файлов — секунды), но chat:send должен вернуть
    // результат немедленно, чтобы renderer вызвал addMessage(userMsg) +
    // initChatSend(chatId) и показал live-пузырь с прогрессом обработки
    // вложений. Без этого пользователь видит пустой чат всё время обработки.
    void runChatSend(store, params, win, chatMode, agentSettings, userMsg, history, assistantMsgId)
      .catch((e) => failRunCleanup(win, params.chatId, assistantMsgId, e))

    // Git Sync — не входит в критический путь отправки. Сначала chat:send
    // возвращает результат и запускает AI-run, затем в следующем event-loop
    // тике фоном проверяем только репозиторий этого чата. Ошибка/таймаут Git
    // не влияет на текущий запрос и не останавливает его.
    if (!params.incognito) {
      setImmediate(() => {
        try {
          const workdir = getChatWorkdirContext(params.chatId).workdir
          if (workdir) getGitSyncManager()?.checkWorkdir(workdir, true)
        } catch (error) {
          log('[chat:send] git sync background check skipped: %s', String((error as Error)?.message ?? error))
        }
      })
    }
    return { userMsg, assistantMsgId }
  }
