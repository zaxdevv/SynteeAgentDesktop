// ── ToolDispatcher: extracted from Agent.ts executeTool ────────────────
// Encapsulates the big tool-dispatch switch and all mutable state that
// executeTool needs (readFileCache, fileCache, filesReadInSession,
// readFileMaxLine, fileMap, lastShellCwd, commandsRun, etc.).
// The Agent class creates a ToolDispatcher and delegates executeTool calls.

import type Store from 'electron-store'
import { resolve } from 'path'
import { statSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import {
  runCommand, readFile, writeFile, listDirectory,
  findFiles,
  searchWeb, getSystemInfo, generateImage, analyzeImageFile,
  readFiles, searchCode, analyzeProject,
  fetchPage, searchImages, getDiagnostics,
  type SearchImagesOpts,
  type ToolResult, editFile,
} from '../tools'
import {
  getContextSettings,
} from '../context/contextManager'
import { runFastContext, bumpRelevanceBoost, type FastContextResult } from '../context/fastContext'
import type { FileCacheEntry } from '../context/fileCacheTypes'
import type { DiffEntry } from '../context/structuredMemory'
import type { AgentCallbacks, AgentSummaryDetails } from './types'
import type { ToolDispatcherContext } from './types'
import { SECRET_PLACEHOLDER_PREFIX, SECRET_PLACEHOLDER_SUFFIX } from '../prompts/sections/secretsSection'

/**
 * ToolDispatcher — владеет всем mutable state, который нужен для выполнения
 * тулов (readFileCache, fileCache, filesReadInSession, readFileMaxLine,
 * fileMap, lastShellCwd, commandsRun, undoStack, pendingDiffEntries).
 * Agent.run() создаёт/сбрасывает dispatcher и делегирует executeTool ему.
 */
export class ToolDispatcher {
  private store: Store
  workdir?: string
  /** userData path — для fallback-поиска картинок-вложений в draft-attachments,
   *  когда AI вызывает analyze_image с именем файла-вложения (без полного пути). */
  userDataPath?: string
  projectId?: string
  chatId?: string
  gatewayToken?: string
  gatewayApiUrl?: string
  onUpdateWorkingMemory?: (chatId: string, content: string, mode: 'replace' | 'append') => void
  onGetWorkingMemory?: (chatId: string) => string
  /** Колбэк после записи/редактирования файла агентом — для live-обновления UI */
  onFileChanged?: (path: string) => void
  /** Защищённые переменные: key → decrypted value. Подстановка ${{KEY}} в
   *  аргументы тулов и обратная маскировка в результатах. */
  secretValues?: Map<string, string>

  // ── Mutable tool-execution state ──
  readFileCache = new Map<string, string>()
  readFileCacheEnabled = true
  fileMap = new Map<string, { reads: number; writes: number; note: string }>()
  fileCache = new Map<string, FileCacheEntry>()
  dirtyFileCacheKeys = new Set<string>()
  filesReadInSession = new Set<string>()
  readFileMaxLine = new Map<string, number>()
  commandsRun: Array<{ command: string; exitCode?: string; success: boolean; cwd?: string }> = []
  lastShellCwd: string | undefined
  pendingDiffEntries: DiffEntry[] = []
  undoStack: Array<{ path: string; originalContent: string | null }> = []

  constructor(ctx: ToolDispatcherContext) {
    this.store = ctx.store
    this.workdir = ctx.workdir
    this.userDataPath = ctx.userDataPath
    this.projectId = ctx.projectId
    this.chatId = ctx.chatId
    this.gatewayToken = ctx.gatewayToken
    this.gatewayApiUrl = ctx.gatewayApiUrl
    this.onUpdateWorkingMemory = ctx.onUpdateWorkingMemory
    this.onGetWorkingMemory = ctx.onGetWorkingMemory
    this.secretValues = ctx.secretValues
  }

  /** Сброс per-run state (вызывается из Agent.run() в начале каждого turn'а). */
  resetForRun(options?: {
    readFileCacheEnabled?: boolean
    fileCacheSnapshot?: Record<string, FileCacheEntry>
  }): void {
    this.readFileCacheEnabled = options?.readFileCacheEnabled !== false
    this.readFileCache = new Map<string, string>()
    this.pendingDiffEntries = []
    this.fileMap = new Map()
    this.readFileMaxLine = new Map()
    this.commandsRun = []
    this.lastShellCwd = undefined
    this.fileCache = new Map(Object.entries(options?.fileCacheSnapshot ?? {}))
    this.dirtyFileCacheKeys = new Set()
  }

  /** Auto-advance helper: обновляет readFileMaxLine из output. */
  private updateReadFileMaxLine(absPath: string, output: string): void {
    const rangedMatch = output.match(/Lines (\d+)-(\d+) of (\d+)/)
    if (rangedMatch) {
      const toLine = parseInt(rangedMatch[2], 10)
      this.readFileMaxLine.set(absPath, Math.max(this.readFileMaxLine.get(absPath) ?? 0, toLine))
      return
    }
    const totalMatch = output.match(/\[File: [^\]]+ \| (\d+) lines\]/)
    if (totalMatch) {
      const totalLines = parseInt(totalMatch[1], 10)
      this.readFileMaxLine.set(absPath, Math.max(this.readFileMaxLine.get(absPath) ?? 0, Math.min(totalLines, 400)))
    }
  }

  /**
   * Рекурсивная подстановка ${{KEY}} плейсхолдеров в аргументы тулов.
   * Заменяет все вхождения на реальные значения из secretValues.
   */
  private substituteSecrets(obj: unknown): unknown {
    if (!this.secretValues || this.secretValues.size === 0) return obj
    if (typeof obj === 'string') {
      let result = obj
      for (const [key, value] of this.secretValues) {
        const placeholder = `${SECRET_PLACEHOLDER_PREFIX}${key}${SECRET_PLACEHOLDER_SUFFIX}`
        // replaceAll для всех вхождений
        while (result.includes(placeholder)) {
          result = result.replace(placeholder, value)
        }
      }
      return result
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.substituteSecrets(item))
    }
    if (obj !== null && typeof obj === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = this.substituteSecrets(v)
      }
      return out
    }
    return obj
  }

  /**
   * Обратная маскировка: заменяет реальные значения секретов на ${{KEY}}
   * в строке (результат тула). Чтобы AI никогда не видела значение.
   */
  maskSecretValuesInText(text: string): string {
    if (!this.secretValues || this.secretValues.size === 0) return text
    let result = text
    for (const [key, value] of this.secretValues) {
      if (!value || value.length < 2) continue // пропускаем пустые/короткие
      const placeholder = `${SECRET_PLACEHOLDER_PREFIX}${key}${SECRET_PLACEHOLDER_SUFFIX}`
      while (result.includes(value)) {
        result = result.replace(value, placeholder)
      }
    }
    return result
  }

  /**
   * Главный dispatch — switch по имени тула.
   * Извлечён из Agent.ts executeTool (строки 1276-1894).
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    callbacks?: AgentCallbacks,
    dryRun?: boolean,
    callId?: string
  ): Promise<ToolResult> {
    // Подстановка ${{KEY}} → реальное значение в аргументах тула
    const resolvedArgs = this.substituteSecrets(args) as Record<string, unknown>

    // Уведомление о вызове любого тула (событие tool:call у плагинов).
    if (!dryRun) {
      try { callbacks?.onToolCall?.(name, resolvedArgs) } catch { /* ignore */ }
    }
    switch (name) {
      case 'run_command': {
        const cmd = (resolvedArgs.command ?? resolvedArgs.cmd ?? resolvedArgs.shell ?? resolvedArgs.script) as string | undefined
        if (!cmd || typeof cmd !== 'string') {
          return { success: false, output: '', error: `run_command: missing "command". Received: ${JSON.stringify(resolvedArgs)}` }
        }
        if (dryRun) {
          return { success: true, output: `[DRY RUN] Command not executed. Would have been run:\n${cmd}`.slice(0, 4000) }
        }
        const effectiveCwd = (resolvedArgs.cwd as string | undefined) ?? this.lastShellCwd ?? this.workdir
        const rawTimeout = resolvedArgs.timeout
        const timeoutSec = typeof rawTimeout === 'number' ? rawTimeout : Number(rawTimeout) || 60
        const cmdResult: ToolResult = await runCommand(cmd, effectiveCwd, resolvedArgs.shell as string | undefined, timeoutSec)
        if (cmdResult.cwd) {
          this.lastShellCwd = cmdResult.cwd
        }
        const exitMatch = cmdResult.output.match(/\[exit: (\d+)\]/)
        this.commandsRun.push({
          command: cmd,
          exitCode: exitMatch?.[1],
          success: cmdResult.success,
          cwd: cmdResult.cwd,
        })
        return cmdResult
      }
      case 'read_file': {
        const filePath = resolvedArgs.path as string
        const cacheKey = `${filePath}:${resolvedArgs.offset ?? 0}:${resolvedArgs.limit ?? 'all'}:${resolvedArgs.full ? 'full' : 'std'}`

        let absPath: string
        try { absPath = resolve(this.workdir ?? process.cwd(), filePath) } catch { absPath = filePath }

        const readNoOffset = resolvedArgs.offset === undefined
        const maxLineKnown = this.readFileMaxLine.get(absPath)
        const shouldAutoAdvance = readNoOffset && maxLineKnown !== undefined && maxLineKnown > 0

        if (shouldAutoAdvance) {
          const autoOffset = maxLineKnown! + 1
          const autoLimit = (resolvedArgs.limit as number | undefined) ?? 400
          const result = await readFile(filePath, autoOffset, autoLimit, this.workdir, resolvedArgs.full as boolean | undefined)
          if (result.success) {
            const hasLines = /^[0-9]+\|/m.test(result.output)
            if (!hasLines) {
              return { success: true, output: `[File fully read: ${filePath} — all lines have been read in this session. No more content to show. Use offset=1 to re-read from the beginning if needed.]` }
            }
            this.updateReadFileMaxLine(absPath, result.output)
            result.output = `[Auto-advanced to offset=${autoOffset}: lines 1-${autoOffset - 1} were already read in this session. Pass offset explicitly to jump to a specific line.]\n${result.output}`
            try { this.filesReadInSession.add(absPath) } catch { /* ok */ }
            const advCacheKey = `${filePath}:${autoOffset}:${autoLimit}:${resolvedArgs.full ? 'full' : 'std'}`
            if (this.readFileCacheEnabled) {
              this.readFileCache.set(advCacheKey, result.output)
              try {
                const stat = statSync(filePath)
                this.fileCache.set(advCacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, output: result.output, cachedAt: Date.now() })
                this.dirtyFileCacheKeys.add(advCacheKey)
              } catch { /* ok */ }
            }
            const localCtx = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})
            if (localCtx.fileMapEnabled) {
              const existing = this.fileMap.get(filePath)
              this.fileMap.set(filePath, { reads: (existing?.reads ?? 0) + 1, writes: existing?.writes ?? 0, note: existing?.note || result.output.slice(0, 400).replace(/\n/g, ' ') })
            }
          }
          return result
        }

        // 1. Быстрый in-session кэш
        if (this.readFileCacheEnabled && this.readFileCache.has(cacheKey)) {
          try { this.filesReadInSession.add(absPath) } catch { /* ok */ }
          this.updateReadFileMaxLine(absPath, this.readFileCache.get(cacheKey)!)
          return { success: true, output: this.readFileCache.get(cacheKey)! }
        }

        // 2. Персистентный кэш на весь чат
        if (this.readFileCacheEnabled) {
          const cached = this.fileCache.get(cacheKey)
          if (cached) {
            try {
              const stat = statSync(filePath)
              if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
                this.readFileCache.set(cacheKey, cached.output)
                try { this.filesReadInSession.add(absPath) } catch { /* ok */ }
                this.updateReadFileMaxLine(absPath, cached.output)
                return { success: true, output: cached.output }
              }
            } catch { /* statSync упал — продолжаем */ }
          }
        }

        const result = await readFile(filePath, resolvedArgs.offset as number | undefined, resolvedArgs.limit as number | undefined, this.workdir, resolvedArgs.full as boolean | undefined)
        const alreadyReadNoOffset = this.readFileCache.has(`${filePath}:0:all:${resolvedArgs.full ? 'full' : 'std'}`) ||
          (this.fileMap.get(filePath)?.reads ?? 0) > 0
        if (readNoOffset && alreadyReadNoOffset && result.success) {
          const linesMatch = result.output.match(/(\d+)\s+lines\]/)
          const totalLines = linesMatch ? parseInt(linesMatch[1], 10) : 400
          if (totalLines <= 400) {
            result.output = `[STOP] You already read this file (all ${totalLines} lines shown). The file is only ${totalLines} lines — you have seen ALL of it. Do not call read_file on this file again without offset. If you need a specific section, pass offset/limit.\n${result.output}`
          } else {
            result.output = `[HINT] You already read this file without offset (lines 1-${Math.min(totalLines, 400)} shown previously). Use offset=${Math.min(totalLines, 400) + 1} to continue reading, or pass offset/limit for a specific range.\n${result.output}`
          }
        }

        if (result.success) {
          try { this.filesReadInSession.add(absPath) } catch { /* ok */ }
          this.updateReadFileMaxLine(absPath, result.output)
          const rbProjectId = this.projectId
            ?? `fc:${createHash('sha1').update(resolve(this.workdir ?? process.cwd())).digest('hex').slice(0, 16)}`
          bumpRelevanceBoost(rbProjectId, filePath, 1)
          if (this.readFileCacheEnabled) this.readFileCache.set(cacheKey, result.output)
          if (this.readFileCacheEnabled) {
            try {
              const stat = statSync(filePath)
              this.fileCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, output: result.output, cachedAt: Date.now() })
              this.dirtyFileCacheKeys.add(cacheKey)
            } catch { /* ok */ }
          }
          const localCtx = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})
          if (localCtx.fileMapEnabled) {
            const existing = this.fileMap.get(filePath)
            this.fileMap.set(filePath, {
              reads: (existing?.reads ?? 0) + 1,
              writes: existing?.writes ?? 0,
              note: existing?.note || result.output.slice(0, 400).replace(/\n/g, ' '),
            })
          }
        }
        return result
      }
      case 'find_files':
        return findFiles(resolvedArgs.pattern as string, resolvedArgs.path as string, { maxResults: resolvedArgs.max_results as number | undefined, workdir: this.workdir })
      case 'get_diagnostics':
        return getDiagnostics(
          (resolvedArgs.cwd as string | undefined) ?? this.workdir,
          resolvedArgs.files as string[] | undefined,
        )
      case 'fetch_page':
        return fetchPage(resolvedArgs.url as string, {
          section: resolvedArgs.section as string | undefined,
          maxChars: resolvedArgs.max_chars as number | undefined,
          onRenderPage: callbacks?.onRenderPage,
        })
      case 'search_images':
        return searchImages(resolvedArgs.query as string, {
          size: resolvedArgs.size as SearchImagesOpts['size'],
          type: resolvedArgs.type as SearchImagesOpts['type'],
          color: resolvedArgs.color as string | undefined,
          maxResults: resolvedArgs.max_results as number | undefined,
          download: resolvedArgs.download as boolean | undefined,
          downloadIndex: resolvedArgs.download_index as number | undefined,
          userDataPath: this.userDataPath,
        })
      case 'write_file': {
        const wfResult = await writeFile(resolvedArgs.path as string, resolvedArgs.content as string, { dryRun, workdir: this.workdir })
        if (wfResult.success && !dryRun) {
          let absPath: string
          try { absPath = resolve(this.workdir ?? process.cwd(), resolvedArgs.path as string) } catch { absPath = resolvedArgs.path as string }
          this.onFileChanged?.(absPath)
        }
        return wfResult
      }
      case 'edit_file': {
        const editPath = resolvedArgs.path as string
        const createNew = resolvedArgs.create_if_not_exists === true
        let readWarning = ''
        if (editPath && !createNew) {
          let absPath: string
          try { absPath = resolve(this.workdir ?? process.cwd(), editPath) } catch { absPath = editPath }
          const fileExists = existsSync(absPath)
          if (fileExists && !this.filesReadInSession.has(absPath)) {
            readWarning = `[Warning: this file was not read via read_file in the current session. If old_str is not found, read the file first with read_file.]`
          }
        }
        const editResult = await editFile({ ...(resolvedArgs as Parameters<typeof editFile>[0]), dryRun, workdir: this.workdir })
        if (readWarning && editResult.success) {
          editResult.output = `${readWarning}\n${editResult.output}`
        } else if (readWarning && !editResult.success) {
          editResult.error = `${readWarning}\n${editResult.error ?? ''}`
        }
        if (editResult.success && !dryRun) {
          let absPath: string
          try { absPath = resolve(this.workdir ?? process.cwd(), editPath) } catch { absPath = editPath }
          this.onFileChanged?.(absPath)
        }
        return editResult
      }
      case 'list_directory':
        return listDirectory(resolvedArgs.path as string, {
          recursive: resolvedArgs.recursive as boolean | undefined,
          depth: resolvedArgs.depth as number | undefined,
          workdir: this.workdir,
        })
      case 'search_web':
        return searchWeb(resolvedArgs.query as string, {
          tavilyKey: (this.store.get('integrations') as { tavily?: { key: string } } | undefined)?.tavily?.key,
          gatewayToken: this.gatewayToken,
          gatewayApiUrl: this.gatewayApiUrl ?? process.env.SYNTEE_API_URL,
        })
      case 'get_system_info':
        return getSystemInfo()
      case 'generate_image':
        // gatewayToken — JWT Syntee-Gateway для image-провайдера (worker-поток:
        // тул сам токен не достанет, electron-store недоступен). userDataPath —
        // куда сохранять b64_json-ответы gpt-image-*.
        return generateImage(resolvedArgs as { prompt: string; model?: string; size?: string; quality?: string; style?: string }, this.store, {
          gatewayToken: this.gatewayToken,
          userDataPath: this.userDataPath,
        })
      case 'analyze_image':
        // Распознавание картинки с диска: прямой пас (imageParts) для
        // vision-способной основной модели, иначе — описание от vision-модели.
        // userDataPath — для fallback-поиска картинок-вложений в draft-attachments.
        return analyzeImageFile(resolvedArgs as { path: string; question?: string }, this.store, this.workdir, this.userDataPath)
      case 'read_files': {
        const rfResult = await readFiles(resolvedArgs.paths as string[], this.workdir)
        if (rfResult.success) {
          for (const p of (resolvedArgs.paths as string[])) {
            try { this.filesReadInSession.add(resolve(this.workdir ?? process.cwd(), p)) } catch { /* ok */ }
          }
        }
        return rfResult
      }
      case 'search_code':
        return searchCode(
          resolvedArgs.pattern as string,
          resolvedArgs.path as string | undefined,
          {
            fileGlob: resolvedArgs.file_glob as string | undefined,
            ignoreCase: resolvedArgs.ignore_case as boolean | undefined,
            literal: resolvedArgs.literal as boolean | undefined,
            filesOnly: resolvedArgs.files_only as boolean | undefined,
            maxResults: resolvedArgs.max_results as number | undefined,
            context: resolvedArgs.context as number | undefined,
            maxChars: resolvedArgs.max_chars as number | undefined,
            workdir: this.workdir,
          }
        )
      case 'analyze_project':
        return analyzeProject((resolvedArgs.path as string) ?? this.workdir ?? '.', this.workdir)
      case 'get_fast_context': {
        const fcQuery = resolvedArgs.query as string
        if (!fcQuery) return { success: false, output: '', error: 'query is required' }
        if (!this.workdir) {
          const fallback = await analyzeProject(this.workdir ?? '.', this.workdir)
          return {
            success: true,
            output: JSON.stringify({
              files: [],
              summary: 'Fast context недоступен (нет workdir). Использован analyze_project как fallback. ' + (fallback.output.slice(0, 200)),
              ms: 0,
              indexedFilesCount: 0,
              fallback: true,
            } as FastContextResult & { fallback: boolean }),
          }
        }
        const fcProjectId = this.projectId
          ?? `fc:${createHash('sha1').update(resolve(this.workdir ?? process.cwd())).digest('hex').slice(0, 16)}`
        const fcResult = await runFastContext(
          fcProjectId,
          this.workdir,
          fcQuery,
          this.store,
          {
            maxFiles: resolvedArgs.maxFiles as number | undefined,
            maxTokens: resolvedArgs.maxTokens as number | undefined,
            signal: callbacks?.signal,
          },
          (p) => {
            callbacks?.onToolProgress?.({
              toolName: 'get_fast_context',
              stage: p.stage,
              detail: p.detail,
              filesProcessed: p.filesProcessed,
              filesTotal: p.filesTotal,
              filesFound: p.filesFound,
            })
          },
        )
        return { success: true, output: JSON.stringify(fcResult) }
      }
      case 'spawn_agent': {
        if (!callbacks?.onSpawnAgent) {
          return { success: false, output: '', error: 'spawn_agent is not supported in this context' }
        }
        const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const result = await callbacks.onSpawnAgent({
          id: agentId,
          task: resolvedArgs.task as string,
          model: resolvedArgs.model as string | undefined,
          approvalMode: resolvedArgs.approval_mode as 'auto' | 'ask' | 'full' | undefined,
          isolation: resolvedArgs.isolation as 'auto' | 'worktree' | 'none' | undefined,
          role: resolvedArgs.role as string | undefined,
          callId,
        })
        if (result.error) return {
          success: false, output: '',
          error: `[AGENT:${agentId}] ${result.error}`,
        }
        return {
          success: true,
          output: `[AGENT:${agentId}] Subagent finished: ${result.summary}`,
        }
      }
      case 'get_agent_status': {
        if (!callbacks?.onGetAgentStatus) {
          return { success: false, output: '', error: 'get_agent_status is not supported' }
        }
        const agentId = resolvedArgs.agent_id as string
        const status = await callbacks.onGetAgentStatus(agentId)
        if (!status) return { success: false, output: '', error: `Agent ${agentId} not found` }
        return {
          success: true,
          output: `Agent ${agentId}: status=${status.status}, steps=${status.stepsCount}${status.currentStep ? `, current=${status.currentStep}` : ''}`,
        }
      }
      case 'update_working_memory': {
        const content = resolvedArgs.content as string
        const mode = (resolvedArgs.mode as 'replace' | 'append') ?? 'replace'
        if (!content) return { success: false, output: '', error: 'content is required' }
        if (this.chatId && this.onUpdateWorkingMemory) {
          this.onUpdateWorkingMemory(this.chatId, content, mode)
          return { success: true, output: `Working memory updated (${mode}, ${content.length} chars)`, hidden: true }
        }
        return { success: false, output: '', error: 'chatId is not set - update_working_memory unavailable' }
      }
      case 'save_memory': {
        const content = resolvedArgs.content as string
        if (!content) return { success: false, output: '', error: 'content is required' }
        const kind = resolvedArgs.kind as string
        if (!kind) return { success: false, output: '', error: 'kind is required' }
        if (!callbacks?.onSaveMemory) {
          return { success: false, output: '', error: 'save_memory unavailable (no memory backend)' }
        }
        try {
          const result = await callbacks.onSaveMemory({
            content, kind,
            scope: resolvedArgs.scope as string | undefined,
            key: resolvedArgs.key as string | undefined,
            category: resolvedArgs.category as string | undefined,
            importance: resolvedArgs.importance as number | undefined,
            projectId: this.projectId,
            chatId: this.chatId,
          })
          if (!result.success) return { success: false, output: '', error: result.error ?? 'save failed' }
          return { success: true, output: `Saved to memory (id: ${result.id ?? '?'}, kind: ${kind})` }
        } catch (e) {
          return { success: false, output: '', error: (e as Error).message }
        }
      }
      case 'recall_memory': {
        const query = resolvedArgs.query as string
        if (!query) return { success: false, output: '', error: 'query is required' }
        if (!callbacks?.onRecallMemory) {
          return { success: false, output: '', error: 'recall_memory unavailable (no memory backend)' }
        }
        try {
          const result = await callbacks.onRecallMemory({
            query,
            kind: resolvedArgs.kind as string | undefined,
            scope: resolvedArgs.scope as string | undefined,
            projectId: this.projectId,
            limit: resolvedArgs.limit as number | undefined,
            sources: resolvedArgs.sources as string[] | undefined,
            crossProject: resolvedArgs.crossProject as boolean | undefined,
          })
          if (!result.success) return { success: false, output: '', error: result.error ?? 'recall failed' }
          if (result.results.length === 0) {
            return { success: true, output: 'Nothing found in memory. Try a different query, use different keywords, or try crossProject: true to search across all projects.' }
          }
          const sourceLabels: Record<string, string> = {
            memory: '🧠 Memory', messages: '💬 Messages', summaries: '📋 Summaries',
            agent_logs: '⚡ Agent logs', pinned: '📌 Pinned', graph: '🔗 Graph',
          }
          const sourceCounts: Record<string, number> = {}
          for (const r of result.results) {
            sourceCounts[r.source] = (sourceCounts[r.source] ?? 0) + 1
          }
          const sourceSummary = Object.entries(sourceCounts)
            .map(([s, c]) => `${sourceLabels[s] ?? s}: ${c}`)
            .join(', ')

          const lines: string[] = []
          let idx = 1
          // Sort by score — no source bias, pure relevance ranking
          const sorted = [...result.results].sort((a, b) => b.score - a.score)
          for (const r of sorted) {
            const scoreStr = r.score.toFixed(2)
            const meta: string[] = []
            if (r.chatTitle) meta.push(`chat: ${r.chatTitle}`)
            if (r.role) meta.push(r.role)
            if (r.date) meta.push(new Date(r.date).toISOString().slice(0, 10))
            if (r.kind && r.source === 'memory') meta.push(r.kind)
            if (r.scope && r.source === 'memory') meta.push(r.scope)
            const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : ''
            const titleStr = r.title ? `${r.title}: ` : ''
            const sourceLabel = sourceLabels[r.source] ?? r.source
            // Show up to 400 chars of content for richer context
            const contentStr = r.content.length > 400
              ? r.content.slice(0, 400) + '…'
              : r.content
            lines.push(`${idx}. [${sourceLabel}] (релевантность: ${scoreStr})${metaStr}`)
            lines.push(`   ${titleStr}${contentStr}`)
            idx++
          }
          return { success: true, output: `Found ${result.results.length} results across ${Object.keys(sourceCounts).length} sources (${sourceSummary}):\n\n${lines.join('\n')}` }
        } catch (e) {
          return { success: false, output: '', error: (e as Error).message }
        }
      }
      case 'manage_notes': {
        const action = resolvedArgs.action as string
        const scope = resolvedArgs.scope as string
        if (!action || !['create', 'update', 'delete', 'list'].includes(action)) {
          return { success: false, output: '', error: 'action must be one of: create, update, delete, list' }
        }
        if (!scope || !['project', 'chat'].includes(scope)) {
          return { success: false, output: '', error: 'scope must be "project" or "chat"' }
        }
        if (!callbacks?.onManageNotes) {
          return { success: false, output: '', error: 'manage_notes unavailable (no notes backend)' }
        }
        try {
          const result = await callbacks.onManageNotes({
            action: action as 'create' | 'update' | 'delete' | 'list',
            scope: scope as 'project' | 'chat',
            title: resolvedArgs.title as string | undefined,
            content: resolvedArgs.content as string | undefined,
            noteId: resolvedArgs.note_id as string | undefined,
            projectId: this.projectId,
            chatId: this.chatId,
          })
          if (!result.success) return { success: false, output: '', error: result.error ?? 'manage_notes failed' }
          if (action === 'list') {
            const notes = result.notes ?? []
            if (notes.length === 0) return { success: true, output: `No ${scope} notes found.` }
            const lines = notes.map((n, i) =>
              `${i + 1}. **${n.title}** (id: ${n.id}, updated: ${new Date(n.updatedAt).toISOString().slice(0, 10)})\n   ${n.content.slice(0, 200)}${n.content.length > 200 ? '...' : ''}`
            )
            return { success: true, output: `${scope} notes (${notes.length}):\n\n${lines.join('\n\n')}` }
          }
          if (action === 'create') return { success: true, output: `Created ${scope} note "${result.note?.title ?? '?'}" (id: ${result.note?.id ?? '?'}).` }
          if (action === 'update') return { success: true, output: `Updated ${scope} note "${result.note?.title ?? '?'}" (id: ${result.note?.id ?? '?'}).` }
          if (action === 'delete') return { success: true, output: `Deleted ${scope} note.` }
          return { success: true, output: 'OK' }
        } catch (e) {
          return { success: false, output: '', error: (e as Error).message }
        }
      }
      case 'think': {
        const thought = resolvedArgs.thought as string
        if (!thought) return { success: false, output: '', error: 'thought is required' }
        return { success: true, output: 'OK. Continue with the plan.', hidden: true }
      }
      case 'update_todo': {
        const items = (resolvedArgs.items as Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>) ?? []
        if (callbacks?.onTodoUpdate) callbacks.onTodoUpdate(items)
        const done = items.filter(i => i.status === 'done').length
        const total = items.length
        return { success: true, output: `Todo updated: ${done}/${total} done`, hidden: true }
      }
      case 'save_plan': {
        return { success: false, output: '', error: 'save_plan is removed. Write the plan directly in the answer, wrapped in <plan title="..." summary="...">plan markdown</plan>. Do not call this tool.' }
      }
      case 'ask_user': {
        const questions = (resolvedArgs.questions as import('../../shared/types').QuestionSpec[]) ?? []
        if (questions.length === 0) {
          return { success: false, output: '', error: 'ask_user: questions array is empty' }
        }
        if (!callbacks?.onQuestion) {
          return { success: false, output: '', error: 'ask_user: нет UI-обработчика (onQuestion). Действуй по разумным предположениям.' }
        }
        const withIds = questions.map((q, i) => ({ ...q, id: q.id || `q_${Date.now()}_${i}` }))
        const typed = withIds.map(q => ({
          ...q,
          type: q.type || (q.options && q.options.length > 0 ? 'choice' : 'text'),
        }))
        try {
          const answers = await callbacks.onQuestion(typed)
          const lines = answers.map(a => {
            const parts: string[] = []
            if (a.value !== undefined) parts.push(`answer: ${a.value ? 'Yes' : 'No'}`)
            if (a.values && a.values.length > 0) parts.push(`selected: ${a.values.join(', ')}`)
            if (a.text) parts.push(`text: ${a.text}`)
            return `- [${a.id}] ${parts.join(' | ') || '(пропущено)'}`
          })
          return { success: true, output: `The user answered:\n${lines.join('\n')}\n\nJSON: ${JSON.stringify(answers)}` }
        } catch (e: unknown) {
          return { success: false, output: '', error: `ask_user: ${String(e)}` }
        }
      }
      case 'get_main_chat_messages': {
        if (!callbacks?.onGetMainChatMessages) {
          return { success: false, output: '', error: 'get_main_chat_messages: нет доступа к основному чату' }
        }
        const limit = Math.min(Math.max((resolvedArgs.limit as number) ?? 15, 1), 50)
        const search = (resolvedArgs.search as string) || undefined
        const result = await callbacks.onGetMainChatMessages({ limit, search })
        return { success: true, output: result }
      }
      case 'list_extensions': {
        if (!callbacks?.onListExtensions) {
          return { success: false, output: '', error: 'list_extensions: нет доступа к расширениям' }
        }
        const report = await callbacks.onListExtensions()
        return { success: true, output: report }
      }
      case 'get_skill': {
        if (!callbacks?.onGetSkill) {
          return { success: false, output: '', error: 'get_skill: нет доступа к скиллам' }
        }
        const skillName = resolvedArgs.name as string
        if (!skillName) return { success: false, output: '', error: 'name обязательный параметр' }
        const instructions = await callbacks.onGetSkill(skillName)
        return { success: true, output: instructions }
      }
      default:
        if (name.startsWith('mcp__') && callbacks?.onMcpCall) {
          const result = await callbacks.onMcpCall(name, resolvedArgs)
          return result
        }
        if (name.startsWith('plugin__') && callbacks?.onPluginCall) {
          const result = await callbacks.onPluginCall(name, resolvedArgs)
          return result
        }
        return { success: false, output: '', error: `Unknown tool: ${name}` }
    }
  }

  // ── Accessors for Agent.ts ──

  getFileCacheUpdates(): Record<string, FileCacheEntry> {
    const result: Record<string, FileCacheEntry> = {}
    for (const key of this.dirtyFileCacheKeys) {
      const entry = this.fileCache.get(key)
      if (entry) result[key] = entry
    }
    this.dirtyFileCacheKeys.clear()
    return result
  }

  getFileSnapshots(): Array<{ path: string; contentBefore: string | null }> {
    return this.undoStack.map(e => ({ path: e.path, contentBefore: e.originalContent }))
  }

  buildSummaryDetails(modifiedFiles: Set<string>): AgentSummaryDetails {
    return {
      modifiedFiles: Array.from(modifiedFiles),
      diffs: [...this.pendingDiffEntries],
      commandsRun: [...this.commandsRun],
      filesRead: Array.from(this.fileMap.keys()),
      fileSnapshots: this.undoStack.map(e => ({ path: e.path, contentBefore: e.originalContent })),
    }
  }
}
