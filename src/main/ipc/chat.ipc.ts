import { app, ipcMain, BrowserWindow } from 'electron'
import { disposeBrowserWorkerBroker } from '../../core/agent/browserWorkerBroker'
import type Store from 'electron-store'
import { agentManager } from '../managers/AgentManager'
import { assertContextChat, getContextPreferences, setContextPreferences, filterContextHistory, setContextMessageHidden, setContextMessagePinned } from '../../core/db/contextControls'
import { invalidateHistoryCache } from './historyCache'
import type { ContextInspection, ContextPreferences } from '../../shared/types/contextControls'
import {
  createChat, getAllChats, getMessages, getMessagesPage, saveMessage, 
  deleteChat, renameChat, pinMessage, unpinMessage, initDB, getDB,
  archiveChat, pinChat, setChatColor, exportChat,
  getChatSummary, setChatSummary,
  getChatMode, getChatWorkdirContext,
  getChatModel, setChatModel,
  getChatReasoning, setChatReasoning,
  getChatModes, setChatModes, setChatPlanningMode, setChatImageMode, setChatAskMode,
  
  getChatDraft, setChatDraft, getUserMessageContents,
  clearChatLastUsage,
  getAllProjects,

  
  
  deleteMessageById, editMessageContent, setMessageHidden,
  
  
  getDotByChatId,
  
  getChatGoal, setChatGoal,
  recoverInterruptedTaskSummaries,
} from '../../core/db'

import { onCompactionTrigger } from '../../core/memory/extractor'
import { setGlobalMemorySettingsStore } from '../../core/memory/globalMemorySettings'
import { SYSTEM_PROMPT_CACHE_BREAK } from '../../core/prompts/buildSystemPrompt'
import {} from '../../core/prompts/sections/secretsSection'
import {} from '../services/protectedVarsStore'
import { AIClient } from '../../core/ai/AIClient'
import {} from '../services/tokenStore'
import {} from '../../shared/planParser'
import {} from '../../shared/finalAnswer'
import { stripAttachTokens } from '../../shared/attachmentMarkdown'
import { DEFAULT_SETTINGS, IPC_EVENTS } from '../../shared/constants'
import {} from '../managers/NotificationManager'
import {} from '../services/approvalAllowlist'
import {} from '../managers/ActivityManager'
import {} from '../managers/GitSyncManager'

import { v4 as uuid } from 'uuid'
import {
  applyRollingWindowAsync, getContextSettings, estimateMessagesTokensAsync,
  estimateTokens, getModelContextWindow,
} from '../../core/context/contextManager'
import {
  buildSnapshotFromEstimate, calibrationKey, getModelPriceInfo,
  importCalibration, setCalibrationListener,
} from '../../core/tokens/usageTracker'
import { buildContextToolSchemas } from './contextToolSchemas'
import { getChatCost, deleteChatCosts, installUsageAccounting } from '../services/usageLedger'
import {} from '../../core/tokens/gatewayModelsCache'
import { clearFileCache } from '../../core/context/fileReadCache'
import { projectRequestHistory } from '../../core/context/historyCompressor'
import { ptyManager } from '../managers/PtyManager'
import { log } from '../../core/logger'
import { onChatDeleted, getAssistantsSettings, setActiveAssistantMemoryAllowed } from '../assistants/bridge'
import {} from '../../core/skills/skillManager'
import {} from '../../core/skills/skillInstructions'
import {} from '../../core/mcp/McpManager'
import { getPluginManager } from '../../core/plugins/pluginManager'
import type { Message, AgentSettings, ChatMode, QueueItemMeta, Attachment, SteerAttachmentMeta } from '../../shared/types'
import { toSteerAttachmentMeta } from '../../shared/steer'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/types'
import { parseCompactArgs } from '../../shared/slashCommands'
import { buildContextHistory, countToolCalls } from './chatContextHelpers'
import { loadAssistantState } from '../../core/context/assistantState'
import { buildContextUsagePayload } from '../../shared/contextUsage'
import { slimMessagesForUI } from './slimMessages'
import { getMessagesCached, getMessagesAfterLatestCompactCached, recoverStreamingBuffersForChat } from './historyCache'
import {
  
  activeRuns, lastActiveChatId, setLastActiveChatId, compactRuns, activeRunMeta,
  chatQueues, cancelIdleExtraction, emitRunStatus,
  type ActiveRun, type QueuedSend,
} from './chatShared'
import { registerProjectsIPC } from './projects.ipc'
import { registerCheckpointIPC } from './chatCheckpoint.ipc'
import { registerForkIPC } from './chatFork.ipc'
import {} from './mentions.ipc'
import { initializeDelegatedChats } from '../services/delegatedChats'
import {} from '../../core/db/delegatedChats'

// Разбитые модули chat.ipc (рефакторинг — код перенесён как есть).
import { registerTaskSummaryIPC } from './taskSummary.ipc'
import { getSystemPrompt } from './chatSystemPrompt'
import { processAttachmentsAndStream } from './chatAttachments'
import { runChatSend, chatSendHandler } from './chatSendEngine'
import { compactDividerCreatedAt, createCompactDivider, emitChatCompacted, getLiveMessages, persistTailToolTrim } from './chatCompaction'
import {
  broadcastGoal, buildFinalIters, buildLiveIters, cancelledDelegatedStarts,
  
  dismissPendingQuestions, drainQueue, emitQueueUpdate, failRunCleanup,
  
  setChatSendImpl, setChatStopImpl, updateForegroundBusy,
} from './chatRunSupport'

// Публичный API модуля (импортеры: index.ts, DotManager.ts, delegatedChats.ts).
export { sendChatMessageProgrammatic, flushAllActiveRuns } from './chatRunSupport'
export type { ProgrammaticChatSendParams } from './chatRunSupport'








export function registerChatIPC(store: Store, mainWindow: { getWindow: () => BrowserWindow | null }): void {
  initDB(app.getPath('userData'))
  installUsageAccounting(snapshot => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('context:cost', snapshot)
    }
  })
  // Калибровка оценки контекста: коэффициенты provider:model живут в сторе,
  // чтобы не учиться заново после каждого перезапуска. Воркеры получают их
  // через workerData (electron-store в worker_threads недоступен).
  importCalibration(store.get('contextCalibration') as Record<string, number> | undefined)
  // Запись в стор — не на каждый замер: EWMA обновляется по нескольку раз за
  // ход, а диск дёргать на каждое изменение незачем.
  let calibrationSaveTimer: ReturnType<typeof setTimeout> | null = null
  let calibrationPending: Record<string, number> | null = null
  setCalibrationListener((entries) => {
    calibrationPending = entries
    if (calibrationSaveTimer) return
    calibrationSaveTimer = setTimeout(() => {
      calibrationSaveTimer = null
      const next = calibrationPending
      calibrationPending = null
      if (!next) return
      try { store.set('contextCalibration', next) } catch { /* не критично */ }
    }, 5_000)
    calibrationSaveTimer.unref?.()
  })
  recoverInterruptedTaskSummaries()
  setGlobalMemorySettingsStore(store)


  // Билдер system prompt для плагинов (syntee.prompt.get) и превью в UI.
  // Без рекурсии: getSystemPrompt не зовёт хук prompt:before-build повторно
  // сам по себе — хук выполняется внутри только при реальных запросах агента.
  try {
    getPluginManager().setPromptBuilder(async (chatId) => getSystemPrompt(store, chatId))
  } catch { /* плагины не инициализированы — ок */ }



  // ── Проекты (рабочие директории) — вынесены в projects.ipc.ts ────────
  registerProjectsIPC(mainWindow)

  ipcMain.handle('chat:create', async (_, isIncognito = false, mode: ChatMode = 'code', projectId?: string, model?: { modelId?: string; modelProvider?: string; reasoningValue?: string }) => {
    return createChat(isIncognito, mode, projectId, model)
  })

  ipcMain.handle('chat:getAll', () => getAllChats())
  registerTaskSummaryIPC(mainWindow)
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
      const prompt = await getSystemPrompt(store, chatId ?? lastActiveChatId ?? undefined)
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
    updateForegroundBusy()
    chatQueues.delete(chatId)
    cancelIdleExtraction(chatId)
    // Archivist может дописывать факты уже после удаления чата — отменяем и
    // ставим томбстон, чтобы строки памяти не «воскресли» для мёртвого чата.
    onChatDeleted(chatId)
    deleteChat(chatId)
    clearFileCache(chatId)
    agentManager.clearChat(chatId)
    ptyManager.killByChat(chatId)
    deleteChatCosts(chatId)
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
    setActiveAssistantMemoryAllowed(chatId, result.sources.memory)
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
    await getSystemPrompt(store, chatId, false, undefined, inspection)
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

  const contextCalculations = new Map<string, symbol>()
  ipcMain.handle('context:calculate', async (_, chatId: string) => {
    const calculation = Symbol()
    contextCalculations.set(chatId, calculation)
    try {
      const win = mainWindow.getWindow()
      if (!win || activeRuns.has(chatId) || activeRunMeta.has(chatId)) return

      const storeData: Record<string, unknown> = {}
      const storeKeys = [
        'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels', 'mainModel',
        'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'projectPermissions', 'chatApprovalAllowlist', 'integrations',
        'voiceId', 'embeddingModel',
        'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
        'contextSettings',
      ]
      for (const k of storeKeys) {
        const v = store.get(k)
        if (v !== undefined) storeData[k] = v
      }

      const chatModel = getChatModel(chatId)
      const main = (storeData.modelAssignments as Array<{ role: string; modelId: string; providerId: string }> | undefined)
        ?.find(a => a.role === 'main')
      const modelId = chatModel?.modelId || main?.modelId || (storeData.mainModel as string | undefined) || DEFAULT_SETTINGS.mainModel
      const providerId = chatModel?.modelProvider ?? main?.providerId ?? ''

      const ctxSettings = getContextSettings(storeData)
      if (!ctxSettings.tokenCounterEnabled) return

      const contextWindow = getModelContextWindow(storeData, 'main', { modelId, providerId })
      const calibration = calibrationKey(providerId, modelId)
      const sysPrompt = await getSystemPrompt(store, chatId)
      if (contextCalculations.get(chatId) !== calculation || win.isDestroyed()
        || activeRuns.has(chatId) || activeRunMeta.has(chatId)) return

      // Загружаем историю (как в chat:send) — для incognito-чатов она пуста.
      // Live-подмножество: сообщения после последнего divider'а (старые
      // summarized не грузятся в модель — их заменяет summary в system prompt).
      const liveMessages = filterContextHistory(chatId, getMessagesAfterLatestCompactCached(chatId))
      const rawHistory = buildContextHistory(liveMessages)
      const assistants = getAssistantsSettings()
      const archive = assistants.enabled && assistants.janitorEnabled
        ? loadAssistantState(app.getPath('userData'), chatId)?.janitorArchive : undefined
      const estimatedHistory = projectRequestHistory(rawHistory, assistants, calibration, archive)

      const toolSchemas = buildContextToolSchemas(store, chatId, estimatedHistory)
      const snapshot = buildSnapshotFromEstimate(estimatedHistory, contextWindow, {
        systemPrompt: sysPrompt,
        includeToolSchemas: true,
        toolSchemas,
        calibrationKey: calibration,
      })

      win.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
        ...buildContextUsagePayload({
          chatId,
          snapshot,
          source: 'estimate',
          scope: 'next_request',
          providerId,
          modelId,
          pricing: getModelPriceInfo(providerId, modelId),
          historyMessages: liveMessages.length,
          toolCallsCount: countToolCalls(liveMessages),
        }),
        ...getChatCost(chatId),
      })
    } catch (e) {
      log('[context:calculate] error chatId=%s: %s', chatId, (e as Error).message)
    } finally {
      if (contextCalculations.get(chatId) === calculation) contextCalculations.delete(chatId)
    }
  })

  // Programmatic-API для main-модулей (DotManager) + IPC-регистрация.
  setChatSendImpl((params) => chatSendHandler(store, mainWindow, params))
  initializeDelegatedChats()
  // Reserved response IDs are main-only; renderer may not overwrite stored messages.
  ipcMain.handle('chat:send', (_, params: Parameters<typeof chatSendHandler>[2]) => chatSendHandler(store, mainWindow, { ...params, assistantMsgId: undefined }))

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
        run: async () => { await runChatSend(store, sideParams, win, chatMode, agentSettings, userMsg, history, assistantMsgId) },
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
    void runChatSend(store, sideParams, win, chatMode, agentSettings, userMsg, history, assistantMsgId)
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
      // §orchestration — прогресс фаз one-turn оркестрации активного рана.
      // Отдаём на ВЕРХНЕМ уровне (renderer читает live.orchestration ??
      // live.liveState?.orchestration): карточка сразу показывает актуальные
      // фазы при возврате в чат, не дожидаясь следующего события.
      orchestration: run.orchestration,
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
      // Суб-агенты работают в отдельных worker_threads AgentManager'а, поэтому
      // terminate() воркера чата их не трогает: без явной отмены они догорали
      // в фоне после «Стоп» и попадали в «Завершённые» с галочкой, хотя
      // запрос остановлен. Отменяем их первыми — пока запись родителя жива.
      agentManager.cancelRunningInChat(run.chatId)
      // Висящие ask_user этого запуска больше некому отвечать — снимаем их с
      // панели до флеша (иначе пользователь отвечал бы в убитый воркер).
      dismissPendingQuestions(win, run)
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
  setChatStopImpl((chatId, requestId) => {
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
  })
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

  // ── chat:steer — внедрить реплику пользователя прямо в контекст активного
  //    рана (long-press на кнопке отправки). Сообщение НЕ встаёт в очередь и
  //    НЕ ждёт завершения прогона: воркер передаёт его Agent'у, а тот вставит
  //    его в messages на границе следующего раунда (pendingSteers в Agent.ts).
  //    Текущий стрим/тул не обрывается — уже сделанная работа сохраняется.
  //    Вложения (§steer как в обычной отправке): processAttachmentsAndStream
  //    инлайнит текстовые файлы в AI-текст и собирает imageParts (vision) либо
  //    пути analyze_image; displayText остаётся с [[attach:id]]-токенами —
  //    карточка в ленте рендерит по ним чипы, история на следующих ходах
  //    токены вычищает.
  //    accepted:false — активного рана нет (или он уже отдаёт done): renderer
  //    откатывается на обычную отправку, чтобы сообщение не пропало.
  ipcMain.handle('chat:steer', async (_, chatId: string, text: string, steerId: string, attachments?: Attachment[]) => {
    const raw = typeof text === 'string' ? text.trim() : ''
    if (!raw) return { accepted: false, reason: 'empty' }
    const id = typeof steerId === 'string' && steerId ? steerId : `steer-${Date.now()}`
    const run = activeRuns.get(chatId)
    if (!run || run.doneSent) return { accepted: false, reason: 'no_active_run' }
    // ── Вложения ── те же лимиты и тот же пайплайн, что в runChatSend
    // (processAttachmentsAndStream). Прогресс vision_recognition шлём с
    // msgId активного рана — shimmer встанет в его блок «хода работы».
    let aiText = stripAttachTokens(raw)
    let steerImageParts: typeof run.imageParts = []
    let steerMeta: SteerAttachmentMeta[] | undefined
    const atts = Array.isArray(attachments) ? attachments.filter(a => a && a.id) : []
    if (atts.length > 0) {
      steerMeta = atts.map(toSteerAttachmentMeta)
      try {
        const processed = await processAttachmentsAndStream(store, mainWindow.getWindow(), chatId, run.msgId, aiText, atts)
        aiText = processed.content
        steerImageParts = processed.imageParts
      } catch (e) {
        log('[chat:steer] attachments failed chatId=%s: %s', chatId, (e as Error).message)
        // Продолжаем с чистым текстом — лучше чем уронить жест целиком
      }
      // Обработка картинок заняла время — ран мог завершиться в паузе. Тогда
      // внедрять некуда: accepted:false → renderer откатится на обычную
      // отправку (текст + вложения), ничего не потеряется.
      if (run.doneSent) return { accepted: false, reason: 'no_active_run' }
    }
    run.bufferedLiveState.steers.push({
      steerId: id,
      text: raw,
      ts: Date.now(),
      applied: false,
      ...(steerMeta?.length ? { attachments: steerMeta } : {}),
    })
    try {
      run.worker.postMessage({
        type: 'steer',
        steerId: id,
        text: aiText,
        ...(raw !== aiText ? { displayText: raw } : {}),
        ...(steerImageParts.length ? { imageParts: steerImageParts } : {}),
        ...(steerMeta?.length ? { attachments: steerMeta } : {}),
      })
    } catch (e) {
      log('[chat:steer] worker недоступен chatId=%s: %s', chatId, (e as Error).message)
      const card = run.bufferedLiveState.steers.find(s => s.steerId === id)
      if (card) run.bufferedLiveState.steers = run.bufferedLiveState.steers.filter(s => s !== card)
      return { accepted: false, reason: 'worker_dead' }
    }
    log('[chat:steer] внедряю в активный ран chatId=%s steerId=%s len=%d atts=%d', chatId, id, aiText.length, steerMeta?.length ?? 0)
    return { accepted: true, steerId: id }
  })

  // ── chat:steer:cancel — пользователь передумал ДО внедрения ────────────
  // Снимаем реплику из очереди Agent'а и из live-состояния рана. Если реплика
  // уже вставлена в messages (applied:true) — отменить нельзя: она часть
  // контекста, откат делается только откатом сообщения.
  ipcMain.handle('chat:steer:cancel', (_, chatId: string, steerId: string) => {
    if (!chatId || !steerId) return { cancelled: false }
    const run = activeRuns.get(chatId)
    if (!run) return { cancelled: false }
    const card = run.bufferedLiveState.steers.find(s => s.steerId === steerId)
    if (card?.applied) return { cancelled: false, reason: 'already_applied' }
    run.bufferedLiveState.steers = run.bufferedLiveState.steers.filter(s => s.steerId !== steerId)
    try {
      run.worker.postMessage({ type: 'steer_cancel', steerId })
    } catch { /* воркер уже умер — карточки в live-состоянии достаточно */ }
    log('[chat:steer:cancel] реплика снята chatId=%s steerId=%s', chatId, steerId)
    return { cancelled: true }
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

  // chat:duplicate зарегистрирован в chatFork.ipc.ts и направлен в общий forkChat.
  ipcMain.handle('chat:export', (_, chatId: string, format: 'txt' | 'md') => exportChat(chatId, format))

  // === CHECKPOINT / REWIND — вынесены в chatCheckpoint.ipc.ts ===
  registerCheckpointIPC(mainWindow)

  /**
   * chat:compact — ручное сжатие контекста чата через slash-команду /compact.
   *
   * Аргументы команды: `[full|last] [фокус...]` (разбор — parseCompactArgs).
   *   full — сжать ВСЮ live-историю в summary: tail пустой, модель начинает
   *          с «нового чата + резюме» (фокус-текст без режима — тоже full);
   *   last — сжать всё, кроме последнего сообщения (сегмента); если это
   *          мега-ход — его tool-результаты ужимаются токен-капом (10% окна,
   *          последние 8 дословно) и персистентно пишутся в БД;
   *   фокус — свободный текст, приоритет при отборе деталей в резюме.
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
  ipcMain.handle('chat:compact', async (event, chatId: string, args?: string) => {
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
      const rawHistory = buildContextHistory(liveMessages)
      if (rawHistory.length === 0) {
        return { error: 'Чат пуст — нечего сжимать.' }
      }

      let storedSummary = ''
      try { storedSummary = getChatSummary(chatId) } catch { /* ok */ }

      const realContextWindow = getModelContextWindow(storeData)
      const rollingSettings = { ...ctxSettings, contextLimitTokens: realContextWindow }
      // Ключ калибровки оценки для пост-сжатого снапшота (см. context:calculate).
      const calibration = calibrationKey(
        (storeData.modelAssignments as Array<{ role: string; providerId?: string }> | undefined)?.find(a => a.role === 'main')?.providerId,
        (storeData.modelAssignments as Array<{ role: string; modelId?: string }> | undefined)?.find(a => a.role === 'main')?.modelId,
      )

      // AbortController для отмены /compact пользователем (Stop-кнопка).
      // chat:compact:cancel зовёт controller.abort() → streamChat разрывает
      // стрим и onDone'ит с partial-текстом; summaryFn возвращает partial;
      // applyRollingWindowAsync возвращает CompressResult; но пост-awaits
      // guard'ы ниже НЕ пускают запись summary/divider в БД — чат остаётся
      // байт-идентичным состоянию до компакции.
      const controller = new AbortController()
      compactRuns.set(chatId, controller)
      updateForegroundBusy()
      // Статус для сайдбара/табов: чат «сжимает контекст» (спиннер в списке
      // чатов). Терминальный статус эмитится в finally ниже.
      emitRunStatus(mainWindow.getWindow(), chatId, 'compacting')

      const summaryFn = async (systemPrompt: string, userContent: string): Promise<string> => {
        const aiClient = new AIClient(store, { chatId, source: 'compaction' })
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
      // не достигнут (пользователь явно попросил /compact). Tail выбирается
      // по целым обменам (не разрезая Message); если вся live-история —
      // свежий хвост (1 сообщение, повторный /compact, /compact last на
      // одном обмене) — вернёт compressed=false → сообщим пользователю.
      const tokensBefore = await estimateMessagesTokensAsync(rawHistory)
      // /compact [full|last] [фокус...] — режим + свободный фокус для резюме.
      const { mode: compactMode, focus } = parseCompactArgs(args)
      log('[chat:compact] chatId=%s mode=%s focus=%s', chatId, compactMode, focus ? `"${focus.slice(0, 80)}"` : '—')
      const result = await applyRollingWindowAsync(rawHistory, rollingSettings, summaryFn, storedSummary || undefined, true, compactMode, focus || undefined)
      if (!result.compressed) {
        compactOutcome = 'error'
        return { error: 'Сжимать нечего — вся история уже в свежем хвосте контекста.' }
      }

      // Пост-сжатый footprint = tail + summary (summary живёт в system prompt
      // следующих запросов). Без слагаемого summary «сэкономлено ~X» в
      // divider'е и toast'е завышено.
      const tokensAfter = await estimateMessagesTokensAsync(result.messages)
        + (result.summaryContent ? estimateTokens(result.summaryContent) : 0)

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

      // Видимый разделитель «Контекст сжат» ставится на ГРАНИЦУ middle|tail
      // (createdAt = первый tail Message минус 1) — ровно как в авто-компакции
      // внутри runChatSend. Раньше здесь стоял createdAt = Date.now(): следующее
      // чтение live-истории (created_at > divider.created_at) отсекало ВСЁ,
      // включая tail, который applyRollingWindowAsync только что сохранил
      // (/compact last → последний обмен, /compact → свежий хвост).
      // При этом в summary tail тоже не попадал (middle его исключает) —
      // последние сообщения исчезали из контекста модели молча. Теперь:
      //   middle → summary (в system prompt)
      //   tail   → остаётся live ПОСЛЕ divider'а и грузится в контекст как есть
      const divider = createCompactDivider(chatId, {
        removedCount: result.removedCount,
        tokensBefore,
        tokensAfter,
        summaryContent: result.summaryContent ?? '',
        createdAt: compactDividerCreatedAt(result.messages, liveMessages),
        modeLabel: focus ? `${compactMode} + фокус` : compactMode,
      })

      // Атомарная транзакция: summary + divider коммитятся вместе. Если abort
      // прилетит между двумя writes — rollback отменит оба. Defense-in-depth
      // поверх основного guard'а выше.
      const db = getDB()
      const tx = db.transaction(() => {
        if (result.summaryContent) setChatSummary(chatId, result.summaryContent)
        // Персистентный трим tail'а: без него ужатые tool-результаты жили бы
        // только в текущем контексте — следующий chat:send пересобрал бы из БД
        // полный вес мега-хода. saveMessage ниже инвалидирует кэш истории.
        const trimmedMsgs = persistTailToolTrim(result.messages, liveMessages)
        if (trimmedMsgs > 0) {
          log('[chat:compact] chatId=%s: персистентный трим tool_steps в %d Message', chatId, trimmedMsgs)
        }
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
        // Захватываем в константу: внутри async-замыкания ниже TS теряет
        // narrowing по result.summaryContent (string | undefined).
        const summaryText = result.summaryContent
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
              summary: summaryText,
              projectId: compactionProjectId,
            })
          } catch (e) {
            log('[chat:compact] memory extraction failed: %s', (e as Error).message)
          }
        })()
      }

      // Сообщения НЕ удаляем из БД. AI-контекст ограничен live-подмножеством
      // (после divider'а) + summary в system prompt.
      log('[chat:compact] chatId=%s: removed=%d сообщ., trimmed=%d tool-рез., tokens %d→%d (saved %d)',
        chatId, result.removedCount, result.trimmedToolResults ?? 0, tokensBefore, tokensAfter, tokensBefore - tokensAfter)

      // Сброс last_usage — иначе context:calculate пересоберёт real-снапшот
      // из устаревшего promptTokens (до-сжатия), и индикатор контекста
      // покажет старое значение. Эмитим пост-сжатый estimate честно как
      // 'estimate' (в UI «≈»): provider usage после сжатия ещё не существует.
      clearChatLastUsage(chatId)
      if (ctxSettings.tokenCounterEnabled) {
        try {
          const contextWindow = realContextWindow
          const sysPrompt = await getSystemPrompt(store, chatId)
          const snapshot = buildSnapshotFromEstimate(result.messages, contextWindow, {
            systemPrompt: sysPrompt,
            currentMsgTokens: 0,
            includeToolSchemas: true,
            toolSchemas: buildContextToolSchemas(store, chatId, result.messages),
            calibrationKey: calibration,
          })
          const win = mainWindow.getWindow()
          win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
            ...buildContextUsagePayload({
              chatId,
              snapshot,
              source: 'estimate',
              scope: 'next_request',
              compressed: true,
              // Кол-во сообщений должно соответствовать breakdown.history —
              // он посчитан по result.messages (tail). Раньше здесь стоял
              // liveMessages.length (до-сжатия) и ринг показывал «5k tok (40 сообщ.)»,
              // хотя 5k — это токены tail'а.
              historyMessages: result.messages.length,
              toolCallsCount: countToolCalls(history),
            }),
            ...getChatCost(chatId),
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
          mode: compactMode,
          focus: focus || undefined,
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
      updateForegroundBusy()
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

