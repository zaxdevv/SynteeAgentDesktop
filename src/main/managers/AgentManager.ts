import { BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import type Store from 'electron-store'
import type { ChatMode } from '../../shared/types'
import { getToolSchemas } from '../../core/tools'
import { getFileCacheSnapshot, mergeFileCache } from '../../core/context/fileReadCache'
import { getAccessToken } from '../services/tokenStore'
import { getGatewayAuthToken, forceRefreshGatewayToken } from '../services/gatewayClient'
import { getGatewayModelsCache } from '../../core/tokens/gatewayModelsCache'
import {
  createSubagentWorktree,
  mergeWorktreeBack,
  discardWorktree,
  cleanupWorktree,
  type WorktreeInfo,
} from './WorktreeIsolation'
import { saveSubagent, loadAllSubagents, deleteSubagentsByChat, type SubagentRow } from '../../core/db/subagents'
import { getSubagentRole } from '../../shared/subagent-roles'

export type AgentStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/**
 * Режим изоляции файлов суб-агента.
 * - 'none'     — писать в workdir родителя (shared). Sequential суб-агент видит
 *                WIP родителя; безопасно только при отсутствии параллелизма.
 * - 'worktree' — отдельный git worktree от HEAD родителя; дельта сливается
 *                обратно через `git apply --3way` после завершения.
 * - 'auto'     — 'worktree' если уже есть pending/running суб-агент на этом
 *                workdir (реальный параллелизм), иначе 'none'.
 */
export type IsolationMode = 'auto' | 'worktree' | 'none'

export interface AgentStep {
  id: string
  type: 'tool_call' | 'tool_result' | 'thought'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string
  diff?: string
}

export interface AgentRecord {
  id: string
  parentId: string | null
  chatId: string
  task: string
  status: AgentStatus
  model: string
  mode: ChatMode
  steps: AgentStep[]
  result: string
  summary: string
  createdAt: number
  finishedAt?: number
  error?: string
  /** workdir родительского чата — для merge-back/cleanup worktree. */
  workdir?: string
  /** Резолвнутый режим изоляции ('auto' свернут в 'worktree'|'none' до старта). */
  isolationMode: 'worktree' | 'none'
  /** Созданный worktree, если isolationMode === 'worktree' и creation удалось. */
  worktreeInfo?: WorktreeInfo
  /** Роль суб-агента (researcher/deep-researcher/editor/implementer/reviewer).
   *  undefined = старая запись до миграции → fallback на implementer. */
  role?: string
  /** Накопленный thinking/reasoning текст (extended thinking, reasoning_content).
   *  Стримится live через thinking_token сообщения от worker'а. */
  thinking?: string
  /** Время thinking в мс (от первого thinking_token до thinking_done). */
  thinkingMs?: number
  /** Live-статус агента ("Думаю...", "Анализирую...", "Rate limit — жду 3с..."). */
  statusText?: string
}

export interface SubagentContext {
  systemPrompt?: string
  // История родителя, передаваемая суб-агенту как контекст. Должна включать
  // reasoning_content и thinking_blocks — иначе строгие провайдеры thinking-mode
  // (LiteLLM proxy для GLM/DeepSeek) роняют 400 "reasoning_content in thinking
  // mode must be passed back to the API" на 2-м раунде суб-агента. См.
  // chatContextHelpers.messageToContextMessages — именно оттуда приходят
  // сообщения с этими полями (processedHistory.slice(-12) в chat.ipc.ts:1790).
  history?: Array<{
    role: string
    content: string
    tool_calls?: unknown[]
    tool_call_id?: string
    name?: string
    thinking_blocks?: Array<{ thinking: string; signature: string }>
    reasoning_content?: string
  }>
  workingMemory?: string
  mode?: ChatMode
  workdir?: string
  projectId?: string
  fastContextDbPath?: string
  fastContextWasmDir?: string
  /** Запрошенный режим изоляции (default 'auto'). */
  isolation?: IsolationMode
}

class AgentManager {
  private agents = new Map<string, AgentRecord>()
  private workers = new Map<string, Worker>()
  /** Throttle: последний broadcast thinking_token (мс). */
  private _lastThinkingBroadcast = 0
  /** Throttle: последний broadcast token (стриминг result). */
  private _lastTokenBroadcast = 0
  /**
   * Динамический getter окна для broadcast. Раньше был статический Set
   * `windows`, заполняемый один раз в registerWindow(). Но registerAgentIPC
   * вызывается ДО mainWindow.create() (index.ts:128 vs :168), и в Set попадал
   * null → broadcast('agent:update') уходил в пустой Set → live-карточки
   * суб-агентов не обновлялись во время стриминга (шаги/статус/summary не
   * доходили до renderer). Getter resolution в момент broadcast закрывает
   * этот race и заодно покрывает пересоздание окна (MainWindow обнуляет this.win
   * на closed).
   */
  private windowGetter: (() => BrowserWindow | BrowserWindow[] | null) | null = null
  private store: Store | null = null
  private resolvers = new Map<string, (result: { summary: string; error?: string }) => void>()
  /**
   * Chain-mutex merge-back per workdir: одновременно завершающиеся суб-агенты
   * одного проекта сериализуют `git apply` в общее рабочее дерево родителя,
   * чтобы не соревноваться за index/objects.
   */
  private mergeChain = new Map<string, Promise<unknown>>()
  /**
   * Троттлинг записи в БД по record.id. Шаги летят часто (каждый tool_call/
   * tool_result), и без debounce мы бы писали JSON-сериализованные steps в БД
   * на каждое событие. Финальные переходы (done/error/cancelled) пишут сразу
   * через persistNow — таймер при этом сбрасывается.
   */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

  init(store: Store) {
    this.store = store
    this.loadPersisted()
  }

  /**
   * Загружает все записи суб-агентов из БД в in-memory мапу. Вызывается один
   * раз при init(). running/pending на момент рестарта логически мертвы —
   * воркеры в worker_threads убиты рестартом процесса, продолжить их нельзя.
   * Помечаем 'cancelled' с понятной причиной, чтобы UI не показывал вечный
   * spinner, и персистим это состояние обратно в БД.
   */
  private loadPersisted() {
    let loaded = 0
    let repaired = 0
    for (const row of loadAllSubagents()) {
      const record = this.rowToRecord(row)
      if (record.status === 'running' || record.status === 'pending') {
        record.status = 'cancelled'
        record.error = 'Прервано рестартом приложения'
        if (!record.finishedAt) record.finishedAt = record.createdAt
        saveSubagent(this.recordToRow(record))
        repaired++
      }
      this.agents.set(record.id, record)
      loaded++
    }
    if (loaded > 0) {
      console.log(`[AgentManager] loaded ${loaded} persisted subagents (${repaired} repaired to cancelled)`)
    }
  }

  private recordToRow(record: AgentRecord): SubagentRow {
    return {
      id: record.id,
      parentId: record.parentId,
      chatId: record.chatId,
      task: record.task,
      status: record.status,
      model: record.model,
      mode: record.mode,
      steps: record.steps,
      result: record.result,
      summary: record.summary,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt ?? null,
      error: record.error ?? null,
      workdir: record.workdir ?? null,
      isolationMode: record.isolationMode ?? null,
      role: record.role ?? null,
    }
  }

  private rowToRecord(row: SubagentRow): AgentRecord {
    return {
      id: row.id,
      parentId: row.parentId,
      chatId: row.chatId,
      task: row.task,
      status: row.status as AgentStatus,
      model: row.model ?? '',
      mode: (row.mode as ChatMode) ?? 'code',
      steps: row.steps as AgentStep[],
      result: row.result,
      summary: row.summary,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt ?? undefined,
      error: row.error ?? undefined,
      workdir: row.workdir ?? undefined,
      isolationMode: (row.isolationMode as 'worktree' | 'none') ?? 'none',
      role: row.role ?? undefined,
    }
  }

  /**
   * Троттлированная запись (debounce ~400мс). Для шагов — её и используем,
   * чтобы не долбить БД на каждый tool_call. Финальные переходы вызывают
   * persistNow напрямую.
   */
  private persist(record: AgentRecord) {
    const existing = this.persistTimers.get(record.id)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this.persistTimers.delete(record.id)
      try {
        saveSubagent(this.recordToRow(record))
      } catch (e: any) {
        console.warn(`[AgentManager] persist failed for ${record.id}: ${e.message}`)
      }
    }, 400)
    this.persistTimers.set(record.id, t)
  }

  /**
   * Мгновенная запись в БД (финальные переходы done/error/cancelled). Таймер
   * троттлинга при этом сбрасывается, чтобы «догоняющая» запись не перетёрла
   * финальный статус более ранним snapshot'ом.
   */
  private persistNow(record: AgentRecord) {
    const existing = this.persistTimers.get(record.id)
    if (existing) {
      clearTimeout(existing)
      this.persistTimers.delete(record.id)
    }
    try {
      saveSubagent(this.recordToRow(record))
    } catch (e: any) {
      console.warn(`[AgentManager] persistNow failed for ${record.id}: ${e.message}`)
    }
    // ── LRU eviction: terminated записи (done/error/cancelled) уже в БД —
    // нет нужды держать их в памяти с полным steps-массивом (мегабайты).
    // Оставляем последние 50, остальное UI достанет из БД по IPC.
    if (this.agents.size > 50) {
      const terminated = [...this.agents.entries()]
        .filter(([, r]) => r.status === 'done' || r.status === 'cancelled' || r.status === 'error')
        .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0))
      const toEvict = this.agents.size - 40
      for (let i = 0; i < toEvict && i < terminated.length; i++) {
        this.agents.delete(terminated[i][0])
      }
    }
  }

  /**
   * Регистрирует getter окна для broadcast. Принимает getter (а не само окно),
   * потому что registerAgentIPC вызывается ДО mainWindow.create() — на момент
   * регистрации окно ещё null. Resolution происходит в момент broadcast.
   * Также покрывает пересоздание окна: getter всегда возвращает актуальное.
   */
  registerWindowGetter(getter: () => BrowserWindow | BrowserWindow[] | null) {
    this.windowGetter = getter
  }

  /**
   * @deprecated использовать registerWindowGetter. Оставлен для обратной
   * совместимости — сразу регистрирует окно как константный getter.
   */
  registerWindow(win: BrowserWindow) {
    this.windowGetter = () => win
  }

  private broadcast(channel: string, payload: unknown) {
    const target = this.windowGetter?.()
    if (!target) return
    const wins = Array.isArray(target) ? target : [target]
    for (const win of wins) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  getAll(): AgentRecord[] {
    return Array.from(this.agents.values()).sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id)
  }

  getChildren(parentId: string): AgentRecord[] {
    return this.getAll().filter(a => a.parentId === parentId)
  }

  getMaxParallel(): number {
    return (this.store?.get('agentSettings.maxParallelSubAgents', 5) as number) ?? 5
  }

  getRunningCount(parentId?: string): number {
    return this.getAll().filter(a =>
      a.status === 'running' &&
      (parentId == null || a.parentId === parentId)
    ).length
  }

  /**
   * Число pending+running суб-агентов на данном workdir. Считаем и 'pending'
   * (между agents.set и переходом в 'running' есть окно) — это закрывает TOCTOU:
   * второй spawn, проверяя count в той же синхронной секции, где делает set,
   * видит первого ещё до старта его worker'а.
   */
  getRunningCountByWorkdir(workdir: string): number {
    return this.getAll().filter(a =>
      (a.status === 'pending' || a.status === 'running') &&
      a.workdir === workdir
    ).length
  }

  /**
   * Сериализует merge-back per workdir (chain-mutex). Параллельные завершения
   * суб-агентов одного проекта выстраиваются в цепочку, чтобы `git apply`
   * не соревновался за index родителя.
   */
  private serializedMerge(workdir: string, info: WorktreeInfo): Promise<{ ok: boolean; conflict: boolean; worktreeKept: boolean; error?: string }> {
    const prev = this.mergeChain.get(workdir) ?? Promise.resolve()
    const result = prev.then(() => mergeWorktreeBack(workdir, info))
    // В цепочку кладём promise без rejection — чтобы один упавший merge не валил всех.
    this.mergeChain.set(workdir, result.then(() => undefined, () => undefined))
    return result
  }

  async spawn(opts: {
    id: string
    parentId: string
    chatId: string
    task: string
    model?: string
    mode?: ChatMode
    storeData: Record<string, unknown>
    context?: SubagentContext
    approvalMode?: 'auto' | 'ask' | 'full'  // §1.10 — override глобального режима
    isolation?: IsolationMode  // §изоляция — override режима worktree
    role?: string  // §roles — специализация суб-агента (researcher/editor/...)
  }): Promise<{ summary: string; error?: string }> {
    const maxParallel = this.getMaxParallel()
    const running = this.getRunningCount()
    if (running >= maxParallel) {
      return { summary: '', error: `Достигнут лимит параллельных агентов (${maxParallel}). Подождите завершения текущих.` }
    }

    const model = opts.model ||
      (opts.storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
        ?.find(a => a.role === 'subagent')?.modelId ||
      (opts.storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
        ?.find(a => a.role === 'main')?.modelId ||
      'claude-sonnet-4-6'

    // Резолвим режим изоляции синхронно — в той же секции, что и agents.set,
    // чтобы getRunningCountByWorkdir был атомарным с регистрацией записи.
    // isGitRepo проверяется позже в _runWorker (асинхронно); если не-git —
    // fallback на 'none' там.
    const workdir = opts.context?.workdir
    const roleDef = getSubagentRole(opts.role)
    // Isolation: явный override > context > role default > 'auto'.
    // Read-only роли (researcher/deep-researcher/reviewer) → 'none' (безопасно),
    // пишущие (editor/implementer) → 'worktree' (защита от гонок).
    const isolationRequest: IsolationMode = opts.isolation ?? opts.context?.isolation ?? roleDef.defaultIsolation
    let isolationMode: 'worktree' | 'none' = 'none'
    if (isolationRequest === 'worktree') {
      isolationMode = 'worktree'
    } else if (isolationRequest === 'auto' && workdir) {
      isolationMode = this.getRunningCountByWorkdir(workdir) > 0 ? 'worktree' : 'none'
    }

    const record: AgentRecord = {
      id: opts.id,
      parentId: opts.parentId,
      chatId: opts.chatId,
      task: opts.task,
      status: 'pending',
      model,
      mode: opts.mode ?? opts.context?.mode ?? 'code',
      steps: [],
      result: '',
      summary: '',
      createdAt: Date.now(),
      workdir,
      isolationMode,
      role: opts.role ?? 'implementer',
    }

    this.agents.set(opts.id, record)
    this.persist(record)
    this.broadcast('agent:update', record)

    return this._runWorker(record, opts.storeData, opts.context, opts.approvalMode)
  }

  private async _runWorker(
    record: AgentRecord,
    storeData: Record<string, unknown>,
    context?: SubagentContext,
    approvalModeOverride?: 'auto' | 'ask' | 'full',
  ): Promise<{ summary: string; error?: string }> {
    // §roles — получаем roleDef из record.role (roleDef из spawn здесь не виден).
    const roleDef = getSubagentRole(record.role)
    // §изоляция — если режим 'worktree', создаём отдельный git worktree ДО старта
    // worker'а и подменяем workdir. Не-git workdir → fallback на 'none' (shared).
    // Cancel во время создания: cancel() ставит status='cancelled' синхронно,
    // здесь мы это видим и делаем discard + return.
    if (record.isolationMode === 'worktree' && record.workdir) {
      try {
        const info = await createSubagentWorktree(record.workdir, record.id)
        if (info) {
          record.worktreeInfo = info
          this.persist(record)
          this.broadcast('agent:update', record)
        } else {
          // не-git → shared, как и без изоляции
          record.isolationMode = 'none'
        }
      } catch (e: any) {
        // Не удалось создать worktree (git error, нет прав и т.п.) — fallback на
        // shared, чтобы суб-агент хотя бы запустился. Логируем для диагностики.
        record.isolationMode = 'none'
        this.persist(record)
        console.warn(`[AgentManager] worktree creation failed for ${record.id} (fallback to shared): ${e.message}`)
      }
      // Cancel мог прийти во время await — не стартуем worker, чистим worktree.
      if (record.status === 'cancelled') {
        if (record.worktreeInfo) {
          try { await discardWorktree(record.workdir, record.worktreeInfo) } catch { /* noop */ }
        }
        return { summary: '', error: 'Суб-агент отменен пользователем' }
      }
    }
    const effectiveWorkdir = record.worktreeInfo?.worktreePath ?? context?.workdir

    // Токен для воркера — с авто-refresh (сам воркер рефрешить не может:
    // electron-store/tokenStore в worker_threads недоступны).
    const gatewayToken = await getGatewayAuthToken().catch(() => getAccessToken())

    return new Promise((resolve) => {
      const workerPath = join(__dirname, 'ai-worker.js')
      this.resolvers.set(record.id, resolve)

      let worker: Worker
      try {
        worker = new Worker(workerPath, {
          workerData: {
            storeData,
            isSubAgent: true,
            mode: record.mode,
            // Снапшот кэша gateway-моделей — worker не может фетчить сам
            // (gateway:fetchModels только в main), а getModelContextWindow
            // для 'syntee-gateway' берёт contextWindow из этого кэша.
            gatewayModels: getGatewayModelsCache(),
            gatewayToken,
            fileCacheSnapshot: getFileCacheSnapshot(record.chatId),
            workdir: effectiveWorkdir,
            projectId: context?.projectId,
            fastContextDbPath: context?.fastContextDbPath,
            fastContextWasmDir: context?.fastContextWasmDir,
          },
          env: process.env,
        })
      } catch (e: any) {
        record.status = 'error'
        record.error = e.message
        record.finishedAt = Date.now()
        this.persistNow(record)
        this.broadcast('agent:update', record)
        resolve({ summary: '', error: e.message })
        return
      }

      record.status = 'running'
      this.workers.set(record.id, worker)
      this.persist(record)
      this.broadcast('agent:update', record)

      const agentSettings = (storeData.agentSettings as Record<string, unknown> | undefined) ?? {
        maxSteps: 20,
        approvalMode: 'auto',
        toolOutputMode: 'normal',
        enableThinking: false,
      }
      // §1.10 — позволяем суб-агенту иметь свой approval режим
      if (approvalModeOverride) {
        agentSettings.approvalMode = approvalModeOverride
      }
      // §roles — maxSteps: единый потолок 1024 для всех ролей (как у main agent).
      // Раньше был per-role лимит, но это искусственно ограничивало суб-агентов.
      agentSettings.maxSteps = 1024
      // §roles — tool filtering: отдаём только тулы из role allowlist.
      // Пустой allowlist (implementer) = полный набор (обратная совместимость).
      // MCP tools (префикс mcp__) всегда проходят.
      // §no-nested-subagents — spawn_agent и get_agent_status ВСЕГДА вырезаются
      // из тулов саб-агента, независимо от роли. Саб-агент не может спавнить
      // вложенных саб-агентов — только основной агент имеет этот тул.
      const NO_NESTED_TOOLS = new Set(['spawn_agent', 'get_agent_status'])
      const fullSchemas = getToolSchemas({ mode: record.mode })
      const effectiveToolSchemas = (roleDef.allowedTools.length > 0
        ? fullSchemas.filter(s => {
            const name = (s as { function: { name: string } }).function.name
            return name.startsWith('mcp__') || roleDef.allowedTools.includes(name)
          })
        : fullSchemas
      ).filter(s => !NO_NESTED_TOOLS.has((s as { function: { name: string } }).function.name))
      // §roles — subagentRole для Agent.run() options (defense-in-depth в Agent.ts)
      const subagentRole = record.role

      // Work-режим удалён — всегда Code-формулировка для суб-агентов.
      const subModeIntro = `Работай только в рамках этой подзадачи.
Сначала пойми релевантный код и контекст, затем выполни работу.

Ты суб-агент, а не основной агент. Будь эффективным:
- Делай только то, что нужно для задачи — не исследуй лишнее.
- Используй минимальное количество tool calls. Не повторяй уже сделанные действия.
- Как только задача выполнена — сразу давай финальный ответ.`
      const subModeOutro = `- что найдено или сделано
- какие файлы важны
- какие есть риски или следующий шаг
Не включай рассуждения, только результат.`
      // §roles — fallback systemPrompt с role injection (когда context?.systemPrompt
      // не передан, т.е. chat.ipc.ts не сформировал промпт).
      const fallbackRoleInjection = roleDef.id !== 'implementer' ? `\n${roleDef.systemPromptInjection}\n` : ''
      const fallbackRoleLabel = roleDef.id !== 'implementer' ? ` (${roleDef.nameEn})` : ''
      const fallbackSystemPrompt = `Ты суб-агент${fallbackRoleLabel}. Твоя задача: ${record.task}

${fallbackRoleInjection}${subModeIntro}
Финальный ответ дай кратко:
${subModeOutro}`

      worker.postMessage({
        chatId: `subagent:${record.id}`,
        msgId: record.id,
        content: record.task,
        history: context?.history ?? [],
        systemPrompt: context?.systemPrompt ?? fallbackSystemPrompt,
        enableTools: true,
        incognito: false,
        agentSettings,
        storeData,
        workingMemory: context?.workingMemory ?? '',
        toolSchemas: effectiveToolSchemas,
        subagentRole,
      })

      worker.on('message', (msg: Record<string, unknown>) => {
        switch (msg.type) {
          // Worker поймал 401 от gateway и просит свежий JWT (сам рефрешить
          // не может — electron-store в worker недоступен). Отвечаем токеном
          // (или null, если refresh-токен тоже мёртв).
          case 'gateway_token_refresh': {
            const replyId = msg.replyId as string
            forceRefreshGatewayToken()
              .then((token) => worker.postMessage({ replyId, token }))
              .catch(() => worker.postMessage({ replyId, token: null }))
            break
          }
          case 'step': {
            const step = msg.step as AgentStep & { imageUrl?: string }
            if (step.type === 'tool_call' || step.type === 'tool_result') {
              const ts: AgentStep = {
                id: `${Date.now()}-${Math.random()}`,
                type: step.type,
                toolName: step.toolName,
                toolArgs: step.toolArgs,
                content: step.content,
                success: step.success,
                timestamp: Date.now(),
                imageUrl: step.imageUrl,
              }
              record.steps.push(ts)
              this.persist(record)
              this.broadcast('agent:update', record)
            } else if (step.type === 'thought') {
              // Сохраняем reasoning агента как thought-шаг — для отображения
              // "процесса мышления" в панели агентов (как в чате).
              const ts: AgentStep = {
                id: `${Date.now()}-${Math.random()}`,
                type: 'thought',
                content: step.content,
                timestamp: Date.now(),
              }
              record.steps.push(ts)
              this.persist(record)
              this.broadcast('agent:update', record)
            }
            break
          }
          case 'thinking_token': {
            // Накапливаем thinking текст и стримим в UI
            const token = msg.token as string
            record.thinking = (record.thinking ?? '') + token
            // Throttled broadcast — не на каждый токен, а каждые ~150мс
            const now = Date.now()
            if (!this._lastThinkingBroadcast || now - this._lastThinkingBroadcast > 150) {
              this._lastThinkingBroadcast = now
              this.broadcast('agent:update', record)
            }
            break
          }
          case 'thinking_done': {
            record.thinkingMs = msg.thinkingMs as number
            this.broadcast('agent:update', record)
            break
          }
          case 'agent_status': {
            // Live-статус агента ("Думаю...", "Rate limit — жду 3с...")
            record.statusText = msg.text as string
            this.broadcast('agent:update', record)
            break
          }
          case 'token': {
            record.result += msg.token as string
            // Throttled broadcast — стриминг result в UI без флуда
            const now = Date.now()
            if (!this._lastTokenBroadcast || now - this._lastTokenBroadcast > 150) {
              this._lastTokenBroadcast = now
              this.broadcast('agent:update', record)
            }
            break
          }
          case 'done': {
            // Персистим round-robin индекс ключей провайдера, обновлённый суб-агентом
            if (msg.updatedProviders && this.store) {
              this.store.set('providers', msg.updatedProviders)
            }
            // Мержим обновлённый кэш файлов в кэш родительского чата
            if (msg.fileCacheUpdates) {
              mergeFileCache(record.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
            }
            // §изоляция — фиксируем факт cancel до перезаписи status. Если cancel
            // уже discard'нул worktree, merge не запускаем (race: terminate → 'done').
            const wasCancelled = record.status === 'cancelled'
            record.status = 'done'
            record.finishedAt = Date.now()
            record.summary = buildSubagentSummary(record.result.trim(), msg.agentSummary)
            this.workers.delete(record.id)
            this.resolvers.delete(record.id)
            // §изоляция — merge-back worktree в родительский workdir (сериализованно
            // per workdir). Отменённый суб-агент уже discard'нут cancel() — не трогаем.
            if (record.worktreeInfo && record.workdir && !wasCancelled) {
              ;(async () => {
                try {
                  const mergeResult = await this.serializedMerge(record.workdir!, record.worktreeInfo!)
                  if (mergeResult.conflict) {
                    record.summary += `\n\n[Внимание: конфликт слияния worktree с WIP родителя. Изменения суб-агента сохранены в: ${record.worktreeInfo!.worktreePath}]`
                  } else if (!mergeResult.ok) {
                    record.summary += `\n\n[Ошибка слияния worktree: ${mergeResult.error}. Worktree сохранён: ${record.worktreeInfo!.worktreePath}]`
                  }
                  if (!mergeResult.worktreeKept) {
                    try { await cleanupWorktree(record.workdir!, record.worktreeInfo!) } catch { /* noop */ }
                  }
                 } catch (e: any) {
                   record.summary += `\n\n[Необработанная ошибка merge worktree: ${e.message}. Worktree сохранён: ${record.worktreeInfo!.worktreePath}]`
                 }
                 this.persistNow(record)
                 this.broadcast('agent:update', record)
                 resolve({ summary: record.summary })
               })()
             } else {
               this.persistNow(record)
               this.broadcast('agent:update', record)
               resolve({ summary: record.summary })
             }
             break
           }
            case 'error': {
             // Персистим round-robin если суб-агент успел его обновить перед ошибкой
             if (msg.updatedProviders && this.store) {
               this.store.set('providers', msg.updatedProviders)
             }
             if (msg.fileCacheUpdates) {
               mergeFileCache(record.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
             }
             record.status = 'error'
             record.error = msg.error as string
             record.finishedAt = Date.now()
             // Если суб-агент успел накопить текст/шаги до ошибки — отдаём это
             // родителю как частичный summary вместо пустой строки, иначе
             // родительский агент теряет весь прогресс суб-агента.
             record.summary = buildSubagentSummary(record.result.trim(), msg.agentSummary)
             this.workers.delete(record.id)
             this.resolvers.delete(record.id)
             // §изоляция — при ошибке discard worktree (правки суб-агента не нужны).
             if (record.worktreeInfo && record.workdir) {
               ;(async () => {
                 try { await discardWorktree(record.workdir!, record.worktreeInfo!) } catch { /* noop */ }
                 this.persistNow(record)
                 this.broadcast('agent:update', record)
                 resolve({ summary: record.summary, error: record.error })
               })()
             } else {
               this.persistNow(record)
               this.broadcast('agent:update', record)
               resolve({ summary: record.summary, error: record.error })
             }
             break
           }
        }
      })

      worker.on('error', (e) => {
        record.status = 'error'
        record.error = e.message
        record.finishedAt = Date.now()
        this.workers.delete(record.id)
        // §изоляция — discard worktree при crash worker'а.
        if (record.worktreeInfo && record.workdir) {
          ;(async () => {
            try { await discardWorktree(record.workdir!, record.worktreeInfo!) } catch { /* noop */ }
            this.persistNow(record)
            this.broadcast('agent:update', record)
            resolve({ summary: '', error: e.message })
          })()
        } else {
          this.persistNow(record)
          this.broadcast('agent:update', record)
          resolve({ summary: '', error: e.message })
        }
      })

      worker.on('exit', (code) => {
        if (record.status === 'running') {
          record.status = code === 0 ? 'done' : 'error'
          record.error = code !== 0 ? `Worker завершился с кодом ${code}` : undefined
          record.finishedAt = Date.now()
          this.workers.delete(record.id)
          // §изоляция — discard worktree при неожиданном exit (если ещё не очищен).
          if (record.worktreeInfo && record.workdir) {
            ;(async () => {
              try { await discardWorktree(record.workdir!, record.worktreeInfo!) } catch { /* noop */ }
              this.persistNow(record)
              this.broadcast('agent:update', record)
              resolve({ summary: record.summary || '', error: record.error })
            })()
          } else {
            this.persistNow(record)
            this.broadcast('agent:update', record)
            resolve({ summary: record.summary || '', error: record.error })
          }
        }
      })
    })
  }

  cancel(id: string) {
    const worker = this.workers.get(id)
    const record = this.agents.get(id)
    if (worker) {
      worker.terminate()
      this.workers.delete(id)
    }
    if (record) {
      record.status = 'cancelled'
      record.finishedAt = Date.now()
      this.persistNow(record)
      this.broadcast('agent:update', record)
      // §изоляция — discard worktree при cancel. Если worktree ещё создаётся
      // (record.worktreeInfo не установлен), discard сделает _runWorker по
      // проверке status === 'cancelled'. Идемпотентен — двойной discard безопасен.
      if (record.worktreeInfo && record.workdir) {
        ;(async () => {
          try { await discardWorktree(record.workdir!, record.worktreeInfo!) } catch { /* noop */ }
        })()
      }
    }
    const resolver = this.resolvers.get(id)
    if (resolver) {
      this.resolvers.delete(id)
      resolver({ summary: '', error: 'Суб-агент отменен пользователем' })
    }
    for (const child of this.getChildren(id)) {
      this.cancel(child.id)
    }
  }

  clearChat(chatId: string) {
    Array.from(this.agents.entries()).forEach(([id, record]) => {
      if (record.chatId === chatId) {
        this.cancel(id)
        this.agents.delete(id)
      }
    })
    // FK ON DELETE CASCADE обычно срабатывает при удалении чата, но clearChat
    // может вызываться без удаления чата — подчищаем явно.
    try { deleteSubagentsByChat(chatId) } catch { /* noop */ }
  }
}

/**
 * Строит расширенный summary суб-агента: финальный текст (до 3000 симв.) +
 * структурированный хвост (изменённые файлы, diff-и, команды), общий кап ~4000 симв.
 * Заменяет старый подход с обрезкой до 500 симв. без деталей.
 */
function buildSubagentSummary(text: string, details?: unknown): string {
  const textPart = text.length > 3000 ? text.slice(0, 3000) + '...' : text

  if (!details || typeof details !== 'object') return textPart

  const d = details as {
    modifiedFiles?: string[]
    diffs?: Array<{ file: string; summary: string }>
    commandsRun?: Array<{ command: string; exitCode?: string; success: boolean }>
    filesRead?: string[]
  }

  const parts: string[] = [textPart]

  if (d.modifiedFiles && d.modifiedFiles.length > 0) {
    parts.push(`\n[Modified files]\n${d.modifiedFiles.map(f => `- ${f}`).join('\n')}`)
  }
  if (d.diffs && d.diffs.length > 0) {
    const diffLines = d.diffs.slice(-15).map(e => `- ${e.file}: ${e.summary}`)
    parts.push(`\n[Diffs]\n${diffLines.join('\n')}`)
  }
  if (d.commandsRun && d.commandsRun.length > 0) {
    const cmdLines = d.commandsRun.slice(-15).map(c => `- ${c.command} → exit ${c.exitCode ?? '?'} (${c.success ? 'ok' : 'error'})`)
    parts.push(`\n[Commands]\n${cmdLines.join('\n')}`)
  }
  if (d.filesRead && d.filesRead.length > 0) {
    parts.push(`\n[Files read]\n${d.filesRead.map(f => `- ${f}`).join('\n')}`)
  }

  const result = parts.join('\n')
  return result.length > 4000 ? result.slice(0, 4000) + '\n...' : result
}

export const agentManager = new AgentManager()
