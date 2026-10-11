import { BrowserWindow, ipcMain } from 'electron'
import { Worker } from 'worker_threads'
import { attachBrowserWorkerBroker, disposeBrowserWorkerBroker } from '../../core/agent/browserWorkerBroker'
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
  hasWorktreeChanges,
  cleanupAbandonedWorktree,
  type WorktreeInfo,
} from './WorktreeIsolation'
import { saveSubagent, loadAllSubagents, deleteSubagentsByChat, type SubagentRow } from '../../core/db/subagents'
import { getChatBrowserMode } from '../../core/db/chats'
import { getSubagentRole } from '../../shared/subagent-roles'
import { confirmCallbacks, questionCallbacks } from '../ipc/chatShared'
import { getNotificationManager } from './NotificationManager'
import { searchAllSources, saveMemoryItem, type SaveMemoryInput } from '../../core/memory/MemoryStore'
import { bumpMemoryHit } from '../../core/memory/store/utils'
import { getMemorySettings, getGlobalMemoryEnabled } from '../../core/memory/globalMemorySettings'
import { persistApprovalGrant } from '../services/approvalAllowlist'

export type AgentStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/**
 * §roles — резолвит эффективную модель+провайдера для суб-агента.
 *
 * Приоритет: role-specific (`subagent:<id>`) > явный/унаследованный opts.model
 * > generic `subagent` > `main`. Пустой modelId в назначении = «не
 * переопределять» (уровень пропускается). Возвращает undefined, если ни один
 * уровень не задаёт модель — тогда AIClient сам упадёт на 'main'.
 */
function resolveSubagentModelAssignment(
  assignments: Array<{ role: string; modelId: string; providerId: string }> | undefined,
  roleId: string,
  explicitModel?: string,
): { modelId: string; providerId: string } | undefined {
  const list = assignments ?? []
  const find = (role: string): { role: string; modelId: string; providerId: string } | undefined =>
    list.find(a => a.role === role)

  const roleSpecific = find(`subagent:${roleId}`)
  const generic = find('subagent')
  const main = find('main')

  // Уровень, задавший модель: role-specific > opts.model > generic > main.
  // Пустой modelId = «не переопределять» (уровень пропускается).
  const chosen = roleSpecific?.modelId
    ? roleSpecific
    : explicitModel
      ? { role: '', modelId: explicitModel, providerId: '' }
      : generic?.modelId
        ? generic
        : main?.modelId
          ? main
          : undefined

  if (!chosen) return undefined

  // Провайдера берём у выбранного уровня; если пуст — наследуем generic/main.
  const providerId = chosen.providerId || generic?.providerId || main?.providerId || ''
  return { modelId: chosen.modelId, providerId }
}

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
  /**
   * §изоляция — reason, если запрошенная worktree-изоляция не сработала и
   * суб-агент работал в общей папке проекта (shared). Не персистится:
   * живёт только в текущей сессии (после рестарта воркеры всё равно мертвы).
   * По нему в done/error к summary добавляется предупреждение — раньше
   * fallback был виден только в console.warn main-процесса.
   */
  isolationFallback?: 'not-git' | 'error'
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
        // §изоляция — worktree суб-агента, убитого рестартом, иначе остаётся
        // сиротой (папка в userData/worktrees + ветка syntee-sub/*) навсегда.
        // Есть изменения → сохраняем и дописываем путь в error (правки можно
        // спасти вручную); нет → удаляем.
        if (record.isolationMode === 'worktree' && record.workdir) {
          void cleanupAbandonedWorktree(record.workdir, record.id)
            .then((kept) => {
              if (kept) {
                record.error = `${record.error}. Правки суб-агента сохранены в worktree: ${kept}`
                try { saveSubagent(this.recordToRow(record)) } catch { /* noop */ }
              }
            })
            .catch(() => { /* noop */ })
        }
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

  onUpdate(listener: (record: AgentRecord) => void): () => void {
    this.updateListeners.add(listener)
    return () => this.updateListeners.delete(listener)
  }

  private updateListeners = new Set<(record: AgentRecord) => void>()

  /**
   * @deprecated использовать registerWindowGetter. Оставлен для обратной
   * совместимости — сразу регистрирует окно как константный getter.
   */
  registerWindow(win: BrowserWindow) {
    this.windowGetter = () => win
  }

  private broadcast(channel: string, payload: unknown) {
    if (channel === 'agent:update' && payload && typeof payload === 'object') for (const listener of this.updateListeners) { try { listener(payload as AgentRecord) } catch { /* UI observers are isolated */ } }
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

  /**
   * §изоляция — note в summary, если worktree-изоляция не сработала и
   * суб-агент работал в общей папке проекта напрямую (в обход undoStack
   * родителя). Раньше об этом знал только console.warn main-процесса.
   */
  private appendIsolationFallbackNote(record: AgentRecord): void {
    const reason = record.isolationFallback === 'not-git'
      ? 'проект не является git-репозиторием'
      : 'не удалось создать worktree'
    record.summary += `\n\n[Внимание: worktree-изоляция не сработала (${reason}) — суб-агент работал в общей рабочей папке проекта напрямую.]`
  }

  /**
   * §изоляция — финализация worktree при ошибке/краше суб-агента: правки не
   * выбрасываем молча. Есть изменения → сохраняем worktree + note в summary
   * (данные можно спасти вручную); нет изменений → discard. Ошибки самой
   * проверки не блокируют финализацию записи.
   */
  private async finalizeWorktreeOnError(record: AgentRecord): Promise<void> {
    if (!record.worktreeInfo || !record.workdir) return
    try {
      const hasChanges = await hasWorktreeChanges(record.worktreeInfo.worktreePath)
      if (hasChanges) {
        record.summary += `\n\n[Суб-агент завершился с ошибкой, но успел изменить файлы — правки сохранены в worktree: ${record.worktreeInfo.worktreePath}]`
      } else {
        await discardWorktree(record.workdir, record.worktreeInfo)
      }
    } catch { /* noop */ }
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

    // §roles — роль резолвится ДО модели: role-specific назначение
    // `subagent:<id>` приоритетнее opts.model / generic subagent / main.
    const roleDef = getSubagentRole(opts.role)
    const resolvedAssignment = resolveSubagentModelAssignment(
      opts.storeData.modelAssignments as Array<{ role: string; modelId: string; providerId: string }> | undefined,
      roleDef.id,
      opts.model,
    )
    const model = resolvedAssignment?.modelId || ''

    // §roles — прокидываем резолвленное назначение в storeData суб-агента под
    // ключом 'subagent': именно его читают AIClient (getModel /
    // getProviderInfoForRole) и getModelContextWindow(storeData, 'subagent').
    // Копируем storeData/assignments, чтобы не мутировать родительский прогон.
    const parentAssignments =
      (opts.storeData.modelAssignments as Array<{ role: string; modelId: string; providerId: string }> | undefined) ?? []
    const subStoreData: Record<string, unknown> = {
      ...opts.storeData,
      chatApprovalAllowlist: this.store?.get('chatApprovalAllowlist', {}) ?? opts.storeData.chatApprovalAllowlist,
      modelAssignments: [
        ...parentAssignments.filter(a => a.role !== 'subagent'),
        ...(resolvedAssignment ? [{ role: 'subagent', ...resolvedAssignment }] : []),
      ],
    }

    // Резолвим режим изоляции синхронно — в той же секции, что и agents.set,
    // чтобы getRunningCountByWorkdir был атомарным с регистрацией записи.
    // isGitRepo проверяется позже в _runWorker (асинхронно); если не-git —
    // fallback на 'none' там.
    const workdir = opts.context?.workdir
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
      role: roleDef.id,
    }

    this.agents.set(opts.id, record)
    this.persist(record)
    this.broadcast('agent:update', record)

    return this._runWorker(record, subStoreData, opts.context, opts.approvalMode)
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
          record.isolationFallback = 'not-git'
        }
      } catch (e: any) {
        // Не удалось создать worktree (git error, нет прав и т.п.) — fallback на
        // shared, чтобы суб-агент хотя бы запустился. Логируем для диагностики.
        record.isolationMode = 'none'
        record.isolationFallback = 'error'
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
    // §worktree — маппинг projectRoot → worktreePath для авто-перенаправления
    // путей мутирующих тулов суб-агента (см. Agent.worktreeMap).
    const worktreeMap = record.worktreeInfo && record.workdir
      ? { projectRoot: record.workdir, worktreePath: record.worktreeInfo.worktreePath }
      : undefined
    // §worktree — суб-агент должен знать свою реальную рабочую директорию:
    // раньше промпт не содержал пути, модель получала от родителя абсолютные
    // пути проекта и работала с ними (спам approval «вне workdir» + правки
    // мимо worktree). Добавляем явный блок в system prompt.
    const workdirNotice = record.worktreeInfo
      ? `\n\nВАЖНО — твоя рабочая директория (workdir): "${record.worktreeInfo.worktreePath}"\nЭто отдельная git-worktree копия проекта (снапшот HEAD). Все файловые операции (edit_file, write_file, cwd для run_command) выполняй ТОЛЬКО с путями внутри этой директории — используй относительные пути или пути внутри workdir. Пути исходного проекта (${record.workdir}\\...) автоматически перенаправляются в workdir, но лучше сразу указывай верные пути. НЕ пиши в исходную папку проекта — твои изменения смержатся обратно автоматически после завершения.`
      : effectiveWorkdir
        ? `\n\nТвоя рабочая директория (workdir): "${effectiveWorkdir}". Файловые операции и команды выполняй относительно неё (или указывай cwd).`
        : ''

    // Токен для воркера — с авто-refresh (сам воркер рефрешить не может:
    // electron-store/tokenStore в worker_threads недоступны).
    const gatewayToken = await getGatewayAuthToken().catch(() => getAccessToken())
    if (record.status === 'cancelled') return { summary: '', error: 'Суб-агент отменен пользователем' }

    return new Promise((resolvePromise) => {
      const workerPath = join(__dirname, 'ai-worker.js')
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      const pendingRequests = new Map<string, 'confirm' | 'question'>()
      const resolve = (result: { summary: string; error?: string }) => {
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined }
        this.resolvers.delete(record.id)
        for (const [reqId, kind] of pendingRequests) {
          if (kind === 'confirm') confirmCallbacks.delete(reqId)
          else questionCallbacks.delete(reqId)
          ipcMain.removeAllListeners(`agent:${kind}:response:${reqId}`)
        }
        pendingRequests.clear()
        resolvePromise(result)
      }
      this.resolvers.set(record.id, resolve)

      const browserMode = getChatBrowserMode(record.chatId)
      let worker: Worker
      try {
        worker = new Worker(workerPath, {
          workerData: {
            storeData: {
              ...storeData,
              chatApprovalAllowlist: this.store?.get('chatApprovalAllowlist', {}) ?? storeData.chatApprovalAllowlist,
              customToolsEnabled: this.store?.get('customToolsEnabled', false) === true,
              disabledTools: this.store?.get('disabledTools', []) ?? [],
            },
            isSubAgent: true,
            mode: record.mode,
            // Снапшот кэша gateway-моделей — worker не может фетчить сам
            // (gateway:fetchModels только в main), а getModelContextWindow
            // для 'syntee-gateway' берёт contextWindow из этого кэша.
            gatewayModels: getGatewayModelsCache(),
            gatewayToken,
            fileCacheSnapshot: getFileCacheSnapshot(record.chatId),
            workdir: effectiveWorkdir,
            // §worktree — маппинг путей projectRoot → worktreePath (Agent.worktreeMap)
            worktreeMap,
            projectId: context?.projectId,
            fastContextDbPath: context?.fastContextDbPath,
            fastContextWasmDir: context?.fastContextWasmDir,
            // Тумблер «Управление браузером» чата — суб-агент наследует.
            browserMode,
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

      attachBrowserWorkerBroker(worker, async (payload, signal) => {
        const { browserManager } = await import('./BrowserManager')
        if (signal.aborted || record.status !== 'running') return { success: false, error: 'Browser run stopped.' }
        return browserManager.execute(record.chatId, { ...payload, action: String(payload.action ?? '') } as Parameters<typeof browserManager.execute>[1], signal)
      })
      record.status = 'running'
      this.workers.set(record.id, worker)
      // A parent turn must not wait forever for a delegated job. This is an
      // outer safety net; individual tools and the worker still have their
      // own timeouts. Keep it long enough for genuine implementation tasks.
      timeoutTimer = setTimeout(() => {
        if (record.status !== 'running') return
        record.status = 'error'
        record.error = 'Суб-агент превысил общий лимит времени (60 минут)'
        record.finishedAt = Date.now()
        disposeBrowserWorkerBroker(worker)
        void worker.terminate().then(async () => {
          record.summary = buildSubagentSummary(record.result.trim(), undefined)
          if (record.worktreeInfo && record.workdir) await this.finalizeWorktreeOnError(record)
        }).catch(() => {
          if (record.worktreeInfo) record.summary += `\nWorktree сохранён: ${record.worktreeInfo.worktreePath}`
        }).finally(() => {
          this.workers.delete(record.id)
          this.persistNow(record)
          this.broadcast('agent:update', record)
          resolve({ summary: record.summary, error: record.error })
        })
      }, 60 * 60 * 1000)
      this.persist(record)
      this.broadcast('agent:update', record)

      const agentSettings: Record<string, unknown> = {
        approvalMode: 'auto', toolOutputMode: 'normal', enableThinking: false,
        ...((storeData.agentSettings as Record<string, unknown> | undefined) ?? {}),
      }
      // §1.10 — позволяем суб-агенту иметь свой approval режим
      if (approvalModeOverride) {
        agentSettings.approvalMode = approvalModeOverride
      }
      // §roles — keep sub-agent runs bounded. The previous hard-coded 1024
      // made a delegation potentially run for a very long time. Respect an
      // explicit setting, otherwise use a practical default for one-shot work.
      const configuredMaxSteps = Number(agentSettings.subagentMaxSteps)
      agentSettings.maxSteps = Number.isFinite(configuredMaxSteps) && configuredMaxSteps > 0
        ? Math.min(1024, Math.floor(configuredMaxSteps))
        : 256
      // §roles — tool filtering: отдаём только тулы из role allowlist.
      // Пустой allowlist (implementer) = полный набор (обратная совместимость).
      // MCP tools (префикс mcp__) всегда проходят.
      // §no-nested-subagents — spawn_agent и get_agent_status ВСЕГДА вырезаются
      // из тулов саб-агента, независимо от роли. Саб-агент не может спавнить
      // вложенных саб-агентов — только основной агент имеет этот тул.
      // manage_dots тоже: round-trip идёт через message-handler основного
      // чат-воркера, которого у саб-агента нет — тул бы завис.
      const NO_NESTED_TOOLS = new Set(['spawn_agent', 'get_agent_status', 'manage_dots', 'manage_chats', 'get_main_chat_messages'])
      const fullSchemas = getToolSchemas({
        mode: record.mode,
        browserMode,
        customToolsEnabled: this.store?.get('customToolsEnabled', false) === true,
        disabledTools: (this.store?.get('disabledTools', []) ?? []) as string[],
      })
      const effectiveToolSchemas = (roleDef.allowedTools.length > 0
        ? fullSchemas.filter(s => {
            const name = (s as { function: { name: string } }).function.name
            // Unknown external tools cannot safely bypass a read-only role.
            return roleDef.allowedTools.includes(name)
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
      const fallbackRoleInjection = `\n${roleDef.systemPromptInjection}\n`
      const fallbackRoleLabel = roleDef.id !== 'implementer' ? ` (${roleDef.nameEn})` : ''
      const fallbackSystemPrompt = `Ты суб-агент${fallbackRoleLabel}. Твоя задача: ${record.task}

${fallbackRoleInjection}${subModeIntro}
Финальный ответ дай кратко:
${subModeOutro}`
      // §worktree — добавляем блок с реальной workdir суб-агента (worktree или
      // workdir проекта) к промпту из контекста или fallback.
      const effectiveSystemPrompt = (context?.systemPrompt ?? fallbackSystemPrompt) + workdirNotice

      worker.postMessage({
        chatId: `subagent:${record.id}`,
        msgId: record.id,
        content: record.task,
        history: context?.history ?? [],
        systemPrompt: effectiveSystemPrompt,
        enableTools: true,
        incognito: false,
        agentSettings,
        storeData,
        workingMemory: context?.workingMemory ?? '',
        toolSchemas: effectiveToolSchemas,
        subagentRole,
        // §roles — резолвленная модель/провайдер суб-агента: используется
        // воркером для учёта стоимости сессии (recordSessionCost).
        modelId: record.model || undefined,
        providerId: (storeData.modelAssignments as Array<{ role: string; providerId: string }> | undefined)
          ?.find(a => a.role === 'subagent')?.providerId || undefined,
      })

      worker.on('message', (msg: Record<string, unknown>) => {
        if (record.status !== 'running') return
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
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined }
            // Персистим round-robin индекс ключей провайдера, обновлённый суб-агентом
            if (msg.updatedProviders && this.store) {
              this.store.set('providers', msg.updatedProviders)
            }
            // Мержим обновлённый кэш файлов в кэш родительского чата
            if (msg.fileCacheUpdates) {
              mergeFileCache(record.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
            }
            // Cancelled/timed-out workers are filtered at the message boundary.
            record.status = 'done'
            record.finishedAt = Date.now()
            record.summary = buildSubagentSummary(record.result.trim(), msg.agentSummary)
            // §изоляция — предупредить, что суб-агент работал в общей папке
            // проекта (worktree не создался), а не в изолированной копии.
            if (record.isolationFallback) this.appendIsolationFallbackNote(record)
            this.workers.delete(record.id)
            disposeBrowserWorkerBroker(worker)
            worker.terminate()
            this.resolvers.delete(record.id)
            // §изоляция — merge-back worktree в родительский workdir (сериализованно
            // per workdir). Отменённый суб-агент уже discard'нут cancel() — не трогаем.
            if (record.worktreeInfo && record.workdir) {
              ;(async () => {
                try {
                  const mergeResult = await this.serializedMerge(record.workdir!, record.worktreeInfo!)
                  if (mergeResult.conflict) {
                    record.summary += `\n\n[Внимание: конфликт слияния worktree с WIP родителя. Конфликтные файлы возвращены к версии родителя; изменения суб-агента полностью сохранены в worktree: ${record.worktreeInfo!.worktreePath}. Часть неконфликтных правок могла примениться — проверь git status.]`
                  } else if (!mergeResult.ok) {
                    record.summary += `\n\n[Ошибка слияния worktree: ${mergeResult.error}.${mergeResult.worktreeKept ? ` Worktree сохранён: ${record.worktreeInfo!.worktreePath}` : ' Изменения суб-агента НЕ применены.'}]`
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
              if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined }
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
            if (record.isolationFallback) this.appendIsolationFallbackNote(record)
            this.workers.delete(record.id)
            disposeBrowserWorkerBroker(worker)
            worker.terminate()
            this.resolvers.delete(record.id)
             // §изоляция — при ошибке суб-агент мог успеть сделать полезные
             // правки (ошибка API на последнем шаге, rate limit и т.п.).
             // Раньше worktree безусловно discard'ился — правки молча
             // терялись. Теперь: есть изменения → сохраняем worktree + note;
             // нет → discard.
             if (record.worktreeInfo && record.workdir) {
               ;(async () => {
                 await this.finalizeWorktreeOnError(record)
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

          // Like recall, saves must be serviced in main and always receive a reply.
          case 'save_memory': {
            const replyId = msg.replyId as string
            ;(async () => {
              try {
                if (!getMemorySettings().enabled) {
                  worker.postMessage({ type: 'save_memory_reply', replyId, success: false, error: 'Память выключена.' })
                  return
                }
                const item = await saveMemoryItem({
                  title: msg.title as string,
                  content: msg.content as string,
                  kind: msg.kind as SaveMemoryInput['kind'],
                  scope: msg.scope as SaveMemoryInput['scope'],
                  key: msg.key as string | undefined,
                  category: msg.category as string | undefined,
                  importance: msg.importance as number | undefined,
                  projectId: msg.projectId as string | undefined,
                  chatId: msg.chatId as string | undefined,
                  source: 'agent_tool',
                })
                worker.postMessage({ type: 'save_memory_reply', replyId, success: true, id: item.id })
              } catch (e) {
                worker.postMessage({ type: 'save_memory_reply', replyId, success: false, error: e instanceof Error ? e.message : String(e) })
              }
            })()
            break
          }

          // Recall runs in main: the worker thread has no initialized DB/settings
          // store. Always answer the request, including disabled/search failure.
          case 'recall_memory': {
            const replyId = msg.replyId as string
            ;(async () => {
              try {
                const scope = msg.scope as 'global' | 'project' | 'all' | undefined
                if (!getMemorySettings().enabled) {
                  worker.postMessage({ type: 'recall_memory_reply', replyId, success: false, results: [], error: 'Память выключена.' })
                  return
                }
                if (!getGlobalMemoryEnabled() && scope === 'global') {
                  worker.postMessage({ type: 'recall_memory_reply', replyId, success: false, results: [], error: 'Глобальная память выключена.' })
                  return
                }
                const results = await searchAllSources({
                  query: msg.query as string,
                  kind: msg.kind as never,
                  scope,
                  projectId: msg.projectId as string | undefined,
                  limit: msg.limit as number | undefined,
                  sources: msg.sources as never,
                  crossProject: msg.crossProject as boolean | undefined,
                })
                try {
                  const ids = results.filter(r => r.source === 'memory' && r.item?.id).map(r => r.item!.id)
                  if (ids.length) bumpMemoryHit(ids)
                } catch (e) { console.warn('[AgentManager] recall feedback failed:', e) }
                worker.postMessage({ type: 'recall_memory_reply', replyId, success: true, results: results.map(r => ({
                  source: r.source, title: r.item?.title ?? null, content: r.content, score: r.score,
                  kind: r.item?.kind, scope: r.item?.scope, key: r.item?.key ?? null,
                  chatId: r.chatId, chatTitle: r.chatTitle, messageId: r.messageId, role: r.role, date: r.date,
                })) })
              } catch (e) {
                worker.postMessage({ type: 'recall_memory_reply', replyId, success: false, results: [], error: e instanceof Error ? e.message : String(e) })
              }
            })()
            break
          }

          // ── confirm: суб-агент запрашивает разрешение на dangerous-тул ──
          // Зеркало chat.ipc.ts:1981-2015. Без этого case worker Promise
          // висит вечно → суб-агент зависает на await onConfirm.
          case 'confirm': {
            const { reqId, toolName, args } = msg as { reqId: string; toolName: string; args: Record<string, unknown>; dangerLevel?: string; dangerReason?: string; previewDiff?: string }
            pendingRequests.set(reqId, 'confirm')
            confirmCallbacks.set(reqId, (approved: boolean, always?: string, toolWide?: boolean) => {
              const grant = this.store ? persistApprovalGrant(this.store, { toolName, args, chatId: record.chatId, approved, always, toolWide, role: 'subagent' }) : undefined
              pendingRequests.delete(reqId)
              ipcMain.removeAllListeners(`agent:confirm:response:${reqId}`)
              if (record.status !== 'running') return
              worker.postMessage({ type: 'confirm_reply', replyId: `confirm-reply-${reqId}`, approved, always: grant?.scope, match: grant?.match })
            })
            ipcMain.once(`agent:confirm:response:${reqId}`, (_, approved: boolean, always?: string, toolWide?: boolean) => {
              const cb = confirmCallbacks.get(reqId)
              if (cb) { confirmCallbacks.delete(reqId); cb(approved, always, toolWide) }
            })
            const win = this.windowGetter?.()
            const target = Array.isArray(win) ? win[0] : win
            target?.webContents.send('agent:confirm', {
              reqId, toolName, args,
              dangerLevel: msg.dangerLevel,
              dangerReason: msg.dangerReason,
              previewDiff: msg.previewDiff,
            })
            {
              const nm = getNotificationManager()
              const dangerLevel = (msg as { dangerLevel?: string }).dangerLevel
              const toolLabel = toolName === 'run_command' ? 'Команда' : toolName === 'write_file' ? 'Запись файла' : toolName === 'edit_file' ? 'Правка файла' : toolName
              nm?.push({
                type: 'permission',
                title: `Суб-агент: запрос разрешения — ${toolLabel}`,
                body: (msg as { dangerReason?: string }).dangerReason || `Суб-агент хочет выполнить ${toolName}`,
                priority: dangerLevel === 'high' ? 'urgent' : 'warning',
                actions: [
                  { id: 'approve', label: 'Разрешить' },
                  { id: 'deny', label: 'Отклонить' },
                ],
                reqId,
                chatId: record.chatId,
              })
            }
            break
          }

          // ── question: суб-агент вызывает ask_user ──
          // Зеркало chat.ipc.ts:2018-2050.
          case 'question': {
            const reqId = msg.reqId as string
            const questions = msg.questions as import('../../shared/types').QuestionSpec[]
            pendingRequests.set(reqId, 'question')
            questionCallbacks.set(reqId, (answers: import('../../shared/types').QuestionAnswer[]) => {
              pendingRequests.delete(reqId)
              ipcMain.removeAllListeners(`agent:question:response:${reqId}`)
              if (record.status !== 'running') return
              worker.postMessage({ type: 'question_reply', replyId: `question-reply-${reqId}`, answers })
            })
            ipcMain.once(`agent:question:response:${reqId}`, (_e, answers: import('../../shared/types').QuestionAnswer[]) => {
              const cb = questionCallbacks.get(reqId)
              if (cb) { questionCallbacks.delete(reqId); cb(answers) }
            })
            {
              const win = this.windowGetter?.()
              const target = Array.isArray(win) ? win[0] : win
              target?.webContents.send('agent:question', {
                reqId, questions, chatId: record.chatId, msgId: msg.msgId,
              })
              const nm = getNotificationManager()
              const firstQ = questions[0]
              if (firstQ) {
                nm?.push({
                  type: 'ask_user',
                  title: firstQ.header || 'Вопрос от суб-агента',
                  body: firstQ.question,
                  priority: 'warning',
                  actions: [{ id: 'open', label: 'Открыть' }],
                  reqId,
                  chatId: record.chatId,
                })
              }
            }
            break
          }

          // ── render_page: суб-агент просит отрендерить SPA-страницу ──
          // Зеркало chat.ipc.ts:2281-2327. BrowserWindow доступен только в main.
          case 'render_page': {
            const replyId = msg.replyId as string
            const renderUrl = msg.url as string
            const waitSelector = msg.waitSelector as string | undefined
            const renderTimeoutMs = (msg.timeoutMs as number | undefined) ?? 25000
            const renderMsgId = msg.msgId as string
            const renderChatId = record.chatId
            ;(async () => {
              try {
                {
                  const win = this.windowGetter?.()
                  const target = Array.isArray(win) ? win[0] : win
                  target?.webContents.send('agent:tool_progress', {
                    msgId: renderMsgId, chatId: renderChatId,
                    toolName: 'fetch_page', stage: 'rendering',
                    detail: `Rendering: ${renderUrl}`,
                    ts: Date.now(),
                  })
                }
                const { renderSpaPage } = await import('../tools/spaRenderer')
                const result = await renderSpaPage(renderUrl, { waitSelector, timeoutMs: renderTimeoutMs })
                {
                  const win = this.windowGetter?.()
                  const target = Array.isArray(win) ? win[0] : win
                  target?.webContents.send('agent:tool_progress', {
                    msgId: renderMsgId, chatId: renderChatId,
                    toolName: 'fetch_page', stage: 'done',
                    ts: Date.now(),
                  })
                }
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
                {
                  const win = this.windowGetter?.()
                  const target = Array.isArray(win) ? win[0] : win
                  target?.webContents.send('agent:tool_progress', {
                    msgId: renderMsgId, chatId: renderChatId,
                    toolName: 'fetch_page', stage: 'error',
                    ts: Date.now(),
                  })
                }
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

          // ── browser_op: суб-агент вызывает browser-тулы (зеркало
          // chat.ipc.ts). Гейтинг browserMode чата — в BrowserManager. ──
          case 'browser_op':
          case 'browser_op_cancel':
            // Handled by the same scoped broker as ordinary chat workers.
            break
        }
      })

      worker.on('error', (e) => {
        if (record.status !== 'running') return
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined }
        record.summary = buildSubagentSummary(record.result.trim(), undefined)
        record.status = 'error'
        record.error = e.message
        record.finishedAt = Date.now()
        this.workers.delete(record.id)
        disposeBrowserWorkerBroker(worker)
        worker.terminate()
        // §изоляция — при crash worker'а правки не выбрасываем молча:
        // есть изменения → сохраняем worktree + note в summary.
        if (record.worktreeInfo && record.workdir) {
          ;(async () => {
            await this.finalizeWorktreeOnError(record)
            this.persistNow(record)
            this.broadcast('agent:update', record)
            resolve({ summary: record.summary, error: e.message })
          })()
        } else {
          this.persistNow(record)
          this.broadcast('agent:update', record)
          resolve({ summary: '', error: e.message })
        }
      })

      worker.on('exit', (code) => {
        if (record.status === 'running') {
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined }
          record.status = code === 0 ? 'done' : 'error'
          record.error = code !== 0 ? `Worker завершился с кодом ${code}` : undefined
          record.finishedAt = Date.now()
          this.workers.delete(record.id)
          // §изоляция — при неожиданном exit правки не выбрасываем молча:
          // есть изменения → сохраняем worktree + note в summary.
          if (record.worktreeInfo && record.workdir) {
            ;(async () => {
              await this.finalizeWorktreeOnError(record)
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
      disposeBrowserWorkerBroker(worker)
      try { worker.postMessage({ type: 'abort_run' }) } catch { /* worker already stopped */ }
      worker.terminate()
      this.workers.delete(id)
    }
    if (record) {
      // The outer timeout also checks status, so cancellation is idempotent.
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
 * Строит расширенный summary суб-агента: финальный текст (до 30000 симв.) +
 * структурированный хвост (изменённые файлы, diff-и, команды), общий кап ~50000 симв.
 * Результат суб-агента НЕ должен обрезаться — родительский агент получает полные
 * данные для синтеза. Кап 50000 — защитный потолок от аномально раздутого вывода.
 */
function buildSubagentSummary(text: string, details?: unknown): string {
  const textPart = text.length > 30000 ? text.slice(0, 30000) + '...' : text

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
    const diffLines = d.diffs.map(e => `- ${e.file}: ${e.summary}`)
    parts.push(`\n[Diffs]\n${diffLines.join('\n')}`)
  }
  if (d.commandsRun && d.commandsRun.length > 0) {
    const cmdLines = d.commandsRun.map(c => `- ${c.command} → exit ${c.exitCode ?? '?'} (${c.success ? 'ok' : 'error'})`)
    parts.push(`\n[Commands]\n${cmdLines.join('\n')}`)
  }
  if (d.filesRead && d.filesRead.length > 0) {
    parts.push(`\n[Files read]\n${d.filesRead.map(f => `- ${f}`).join('\n')}`)
  }

  const result = parts.join('\n')
  return result.length > 50000 ? result.slice(0, 50000) + '\n...' : result
}

export const agentManager = new AgentManager()
