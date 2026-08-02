import { BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import type Store from 'electron-store'
import type { ChatMode } from '../shared/types'
import { getToolSchemas } from '../core/tools'
import { getFileCacheSnapshot, mergeFileCache } from '../core/context/fileReadCache'
import { getAccessToken } from './services/tokenStore'
import { getGatewayAuthToken, forceRefreshGatewayToken } from './services/gatewayClient'
import {
  createSubagentWorktree,
  mergeWorktreeBack,
  discardWorktree,
  cleanupWorktree,
  type WorktreeInfo,
} from './WorktreeIsolation'

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
  type: 'tool_call' | 'tool_result'
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
}

export interface SubagentContext {
  systemPrompt?: string
  history?: Array<{ role: string; content: string }>
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
  private windows = new Set<BrowserWindow>()
  private store: Store | null = null
  private resolvers = new Map<string, (result: { summary: string; error?: string }) => void>()
  /**
   * Chain-mutex merge-back per workdir: одновременно завершающиеся суб-агенты
   * одного проекта сериализуют `git apply` в общее рабочее дерево родителя,
   * чтобы не соревноваться за index/objects.
   */
  private mergeChain = new Map<string, Promise<unknown>>()

  init(store: Store) {
    this.store = store
  }

  registerWindow(win: BrowserWindow) {
    this.windows.add(win)
    win.on('closed', () => this.windows.delete(win))
  }

  private broadcast(channel: string, payload: unknown) {
    Array.from(this.windows).forEach(win => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    })
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
    return (this.store?.get('agentSettings.maxParallelSubAgents', 3) as number) ?? 3
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
    const isolationRequest: IsolationMode = opts.isolation ?? opts.context?.isolation ?? 'auto'
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
    }

    this.agents.set(opts.id, record)
    this.broadcast('agent:update', record)

    return this._runWorker(record, opts.storeData, opts.context, opts.approvalMode)
  }

  private async _runWorker(
    record: AgentRecord,
    storeData: Record<string, unknown>,
    context?: SubagentContext,
    approvalModeOverride?: 'auto' | 'ask' | 'full',
  ): Promise<{ summary: string; error?: string }> {
    // §изоляция — если режим 'worktree', создаём отдельный git worktree ДО старта
    // worker'а и подменяем workdir. Не-git workdir → fallback на 'none' (shared).
    // Cancel во время создания: cancel() ставит status='cancelled' синхронно,
    // здесь мы это видим и делаем discard + return.
    if (record.isolationMode === 'worktree' && record.workdir) {
      try {
        const info = await createSubagentWorktree(record.workdir, record.id)
        if (info) {
          record.worktreeInfo = info
          this.broadcast('agent:update', record)
        } else {
          // не-git → shared, как и без изоляции
          record.isolationMode = 'none'
        }
      } catch (e: any) {
        // Не удалось создать worktree (git error, нет прав и т.п.) — fallback на
        // shared, чтобы суб-агент хотя бы запустился. Логируем для диагностики.
        record.isolationMode = 'none'
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
        this.broadcast('agent:update', record)
        resolve({ summary: '', error: e.message })
        return
      }

      record.status = 'running'
      this.workers.set(record.id, worker)
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

      // Work-режим удалён — всегда Code-формулировка для суб-агентов.
      const subModeIntro = 'Работай только в рамках этой подзадачи.\nСначала пойми релевантный код и контекст, затем выполни работу.'
      const subModeOutro = '- что найдено или сделано\n- какие файлы важны\n- какие есть риски или следующий шаг'

      worker.postMessage({
        chatId: `subagent:${record.id}`,
        msgId: record.id,
        content: record.task,
        history: context?.history ?? [],
        systemPrompt: context?.systemPrompt ?? `Ты суб-агент. Твоя задача: ${record.task}

${subModeIntro}
Финальный ответ дай кратко:
${subModeOutro}`,
        enableTools: true,
        incognito: false,
        agentSettings,
        storeData,
        workingMemory: context?.workingMemory ?? '',
        toolSchemas: getToolSchemas({ mode: record.mode }),
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
              this.broadcast('agent:update', record)
            }
            break
          }
          case 'token':
            record.result += msg.token as string
            break
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
                this.broadcast('agent:update', record)
                resolve({ summary: record.summary })
              })()
            } else {
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
                this.broadcast('agent:update', record)
                resolve({ summary: record.summary, error: record.error })
              })()
            } else {
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
            this.broadcast('agent:update', record)
            resolve({ summary: '', error: e.message })
          })()
        } else {
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
              this.broadcast('agent:update', record)
              resolve({ summary: record.summary || '', error: record.error })
            })()
          } else {
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
