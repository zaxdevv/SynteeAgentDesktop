import * as path from 'path'
import { app } from 'electron'
import type Store from 'electron-store'
import {
  getAllProjects, getWorkingMemory, getChatSummary, getChatModes, getChatBrowserMode,
  getChatGoal, getChatWorkdirContext,
} from '../../core/db'
import { getContextPreferences } from '../../core/db/contextControls'
import type { ContextInspection } from '../../shared/types/contextControls'
import { buildCuratedSummary, getMemoryStatsForProject } from '../../core/memory/MemoryStore'
import { getGlobalMemoryEnabled, getMemorySettings } from '../../core/memory/globalMemorySettings'
import { buildProjectGraph } from '../../core/memory/graphBuilder'
import { getGraphStats } from '../../core/memory/graphStore'
import { compactWorkingMemoryForPrompt } from '../../core/context/structuredMemory'
import { buildSystemPrompt } from '../../core/prompts/buildSystemPrompt'
import type { ProtectedVarPromptInfo } from '../../core/prompts/buildSystemPrompt'
import { getStatus as getProjectMapStatus } from '../../core/projectMap/mapStore'
import { compactStoredProjectScan } from '../../core/projectMap/projectScan'
import { readProjectContextFiles } from '../../core/prompts/projectInstructions'
import { resolveActive } from '../services/protectedVarsStore'
import { getSkillManager } from '../../core/skills/skillManager'
import { getMcpManager } from '../../core/mcp/McpManager'
import { getPluginManager } from '../../core/plugins/pluginManager'
import { perfPhase, perfPhaseAsync } from '../../core/performanceDiagnostics'
import { log } from '../../core/logger'
import { formatSkillSearch } from '../../core/skills/skillSearch'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/types'
import type { AgentSettings } from '../../shared/types'

export async function getSystemPrompt(store: Store, chatId?: string, isIncognito?: boolean, oneShotSkill?: { name: string; instructions: string }, inspection?: Pick<ContextInspection, 'sources' | 'files'>, imageModeOverride?: boolean): Promise<string> {
    const contextPrefs = getContextPreferences(chatId)
    const memorySettings = getMemorySettings()
    const includeMemory = !isIncognito && contextPrefs.sources.memory && memorySettings.enabled
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
        projectContext = compactStoredProjectScan(wctx.projectContext, workdir)
        if (workdir) {
          const normalizedWorkdir = path.resolve(workdir)
          const found = getAllProjects().find(p => path.resolve(p.workdir) === normalizedWorkdir)
          promptProjectId = found?.id
        }
      }
    } catch (e: any) {
      console.warn('[getSystemPrompt] workdir resolution failed:', e?.message ?? e)
      log('[getSystemPrompt] workdir failed: %s', (e?.message ?? String(e)).slice(0, 200))
    }
    // Curated memory summary: top global user_facts + top project_decisions.
    // Replaces the full getAllMemoriesForContext dump — ~400 token budget.
    memoryContext = includeMemory
      ? withRetrySync('buildCuratedSummary', () => buildCuratedSummary(memorySettings.project ? promptProjectId : undefined), '')
      : ''
    workingMemory = includeMemory && memorySettings.chat
      ? withRetrySync('workingMemory', () => chatId ? getWorkingMemory(chatId) : '', '')
      : ''
    summary = includeMemory && memorySettings.chat
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

    const promptWorkingMemory = compactWorkingMemoryForPrompt(workingMemory)
    const mergedWorkingMemory = summary
      ? `${promptWorkingMemory ? promptWorkingMemory + '\n\n' : ''}## Earlier conversation summary\n${summary}`
      : promptWorkingMemory

    // Global system prompt from Settings → AI → Parameters (or /sys command)
    const customSystemPrompt = (store.get('modelParams') as { systemPrompt?: string } | undefined)?.systemPrompt

    // Memory counters for the system prompt — the agent sees how much memory it has.
    const memoryStats: { globalCount: number; projectCount: number; globalByKind: Record<string, number>; projectByKind: Record<string, number> } | undefined =
      includeMemory
        ? withRetrySync('memoryStats', () => getMemoryStatsForProject(memorySettings.project ? promptProjectId : undefined), undefined)
        : undefined

    // Knowledge graph stats — the agent sees the project structure.
    let graphStats: ReturnType<typeof getGraphStats> | undefined
    graphStats = includeMemory && memorySettings.project
      ? withRetrySync('graphStats', () => promptProjectId ? getGraphStats(promptProjectId) : undefined, undefined)
      : undefined

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

    // Only index state goes in the session tail; tool guidance stays static.
    const projectMapInfo = withRetrySync('projectMap', () => {
      if (!promptProjectId) return undefined
      const st = getProjectMapStatus(promptProjectId)
      return {
        state: st.state,
        files: st.indexedFiles,
        nodes: st.totalNodes,
        edges: st.totalEdges,
      }
    }, undefined)

    // Absolute path to the global skills folder — for the install reference in the prompt.
    let globalSkillsDir = ''
    try { globalSkillsDir = path.join(app.getPath('userData'), 'skills') } catch { /* app may be unavailable */ }
    // Absolute path to the global plugins folder — same purpose.
    let globalPluginsDir = ''
    try { globalPluginsDir = path.join(app.getPath('userData'), 'plugins') } catch { /* app may be unavailable */ }

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
    const promptImageMode = imageModeOverride ?? (chatId ? getChatModes(chatId).imageMode : false)
    // Source controls affect actual builder inputs, not just inspector labels.
    const sources = contextPrefs.sources
    const includedFiles = projectInstructions.filter(file => sources.instructions && sources.projectFiles && !contextPrefs.excludedFiles.includes(file.source))
    if (inspection) {
      inspection.files = projectInstructions.map(file => ({ source: file.source, characters: file.content.length, included: includedFiles.includes(file) }))
      inspection.sources = [
        { key: 'instructions', label: 'Дополнительные инструкции', enabled: sources.instructions, detail: 'Custom system prompt, инструкции проекта и статические секции плагинов. Базовые правила и режимы остаются.', characters: (customSystemPrompt?.length ?? 0) + projectInstructions.reduce((n, f) => n + f.content.length, 0) + pluginSections.reduce((n, f) => n + f.content.length, 0) },
        { key: 'projectFiles', label: 'Контекст проекта и файлы', enabled: sources.projectFiles, detail: 'Скан проекта, файлы инструкций и живой контекст плагинов. Workdir и доступ к файлам остаются.', characters: (projectContext?.length ?? 0) + projectInstructions.reduce((n, f) => n + f.content.length, 0) + pluginContext.reduce((n, f) => n + f.content.length, 0) },
        { key: 'memory', label: 'Память в system prompt', enabled: includeMemory, detail: 'Curated memory, working memory, summary и граф. Явные вызовы recall_memory не блокируются.', characters: memoryContext.length + mergedWorkingMemory.length },
        { key: 'history', label: 'История сообщений', enabled: sources.history, detail: 'После последнего сжатия. Закреплённые сообщения включаются даже при выключенной истории.', characters: 0 },
        { key: 'tools', label: 'История инструментов', enabled: sources.tools, detail: 'Прошлые tool calls и результаты. Доступность инструментов текущего запуска не меняется.', characters: 0 },
      ]
    }
    let systemPrompt = perfPhase('chat.system_prompt.build', () => buildSystemPrompt({ userName, memoryContext: sources.memory ? memoryContext : '', memoryStats: sources.memory ? memoryStats : undefined, graphStats: sources.memory ? graphStats : undefined, projectMap: projectMapInfo, workingMemory: sources.memory ? mergedWorkingMemory : '', customSystemPrompt: sources.instructions ? customSystemPrompt : undefined, workdir, projectContext: sources.projectFiles ? projectContext : undefined, projectInstructions: includedFiles, activeSkills, activePlugins, oneShotSkill, globalSkillsDir, globalPluginsDir, browserMode: promptBrowserMode, imageMode: promptImageMode, maxParallelSubAgents: (store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings)?.maxParallelSubAgents, pluginContext: sources.projectFiles ? pluginContext : [], pluginSections: sources.instructions ? pluginSections : [], protectedVars }))

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
        systemPrompt += `\n\n## ACTIVE USER GOAL (persistent, /goal)\nCompletion condition: ${goal.objective}\n` +
          `An INDEPENDENT evaluator reads this transcript after every turn and decides met / not_met / impossible — your own claim of completion is not evidence. Make the check visible: run it and let the real output appear in the conversation.\n` +
          `Progress: ${goal.progress.slice(-12).join(' | ') || '(none yet)'}\n` +
          (goal.lastReason ? `Last verdict: not yet met — ${goal.lastReason}\n` : '') +
          `Turn ${goal.turnsEvaluated} evaluated${goal.maxSteps > 0 ? `, round budget ${goal.steps}/${goal.maxSteps}` : ', no round cap'}. ` +
          'If the condition cannot be satisfied, say so explicitly. Never bypass tool permissions, and never repeat irreversible side effects without checking the current state. ' +
          `Goal status: ${goal.status}.`
      }
    }
    return systemPrompt

}

/**
 * Строит текстовый отчёт об установленных расширениях для агента
 * (тул list_extensions). Включает MCP-серверы (статус, тулы) и skills.
 */
export async function buildExtensionsReport(chatId: string, options?: { scope?: string; query?: string; offset?: number }): Promise<string> {
    if (options?.scope === 'skills') {
      const { workdir } = getChatWorkdirContext(chatId)
      const projectId = workdir ? getAllProjects().find(p => path.resolve(p.workdir) === path.resolve(workdir))?.id : undefined
      const skills = getSkillManager().getAllWithState({ projectWorkdir: workdir, projectId })
      return formatSkillSearch(skills, options.query, options.offset)
    }
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
