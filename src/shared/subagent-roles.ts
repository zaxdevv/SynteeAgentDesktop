/**
 * Специализированные роли суб-агентов для spawn_agent.
 *
 * В отличие от personas (modes.ts) — которые привязаны к UI-выбору пользователя,
 * имеют skillId (загружают скиллы) и промпты для интерактивного режима, —
 * sub-agent roles программные, вызываются из spawn_agent, без UI-выбора,
 * без skills, с краткими промптами для one-shot задачи.
 *
 * Каждая роль определяет:
 * - allowedTools — tool allowlist (MCP tools добавляются всегда поверх)
 * - systemPromptInjection — встроенный промпт роли
 * - defaultIsolation — режим изоляции по умолчанию
 * - color — цвет для UI badge
 */

export type SubagentRole = 'researcher' | 'deep-researcher' | 'editor' | 'implementer' | 'reviewer'

export interface SubagentRoleDef {
  id: SubagentRole
  /** English display name (badge). */
  nameEn: string
  /** Badge / accent color (hex). */
  color: string
  /**
   * Tool allowlist — имена builtin тулов. MCP tools (префикс mcp__) добавляются
   * всегда поверх, независимо от allowlist. Пустой массив = полный набор
   * (для implementer — обратная совместимость).
   */
  allowedTools: string[]
  /** System prompt injection — добавляется к базовому sub-agent промпту. */
  systemPromptInjection: string
  /** Режим изоляции по умолчанию (если caller не указал isolation явно). */
  defaultIsolation: 'auto' | 'worktree' | 'none'
}

// ── Tool sets ──────────────────────────────────────────────────────────────
// Переиспользуем паттерн из modes.ts: BASE + RESEARCH + EDIT_NO_RUN.

const READ_TOOLS = [
  'read_file', 'read_files', 'find_files', 'search_code', 'list_directory',
  'think', 'get_fast_context', 'analyze_project', 'get_diagnostics',
  'recall_memory', 'manage_notes',
] as const

const WEB_TOOLS = [
  'search_web', 'http_request',
] as const

const EDIT_TOOLS = [
  'edit_file', 'write_file',
] as const

// run_command — только для implementer (включён через пустой allowedTools,
// т.е. полный набор getToolSchemas). Не выделен в отдельный массив, т.к.
// больше ни одна роль его не использует.

// ── Roles ──────────────────────────────────────────────────────────────────

export const SUBAGENT_ROLES: Record<SubagentRole, SubagentRoleDef> = {
  // ── RESEARCHER — read-only code investigation ──
  researcher: {
    id: 'researcher',
    nameEn: 'Researcher',
    color: '#60a5fa',
    allowedTools: [...READ_TOOLS],
    systemPromptInjection: `You are a READ-ONLY research sub-agent.
Your job: investigate code, find relevant files, understand architecture.
You CANNOT edit files or run commands — use read tools only.
Return: list of relevant files with line ranges, key findings, risks.
Do NOT attempt to fix anything — report only.

You are a SUB-AGENT, not the main agent. Be efficient:
- Complete the task with minimal tool calls — do not explore beyond what the task requires.
- Do not read files "for completeness" — only those needed for the task.
- Do not repeat already-done actions (e.g. re-reading the same file).
- As soon as the task is answered — return the result immediately, do not continue investigating.`,
    defaultIsolation: 'none',
  },

  // ── DEEP RESEARCHER — read-only + web search/HTTP ──
  'deep-researcher': {
    id: 'deep-researcher',
    nameEn: 'Deep Researcher',
    color: '#a78bfa',
    allowedTools: [...READ_TOOLS, ...WEB_TOOLS],
    systemPromptInjection: `You are a DEEP RESEARCH sub-agent.
Your job: thorough investigation combining codebase analysis AND external research.
Use search_web for documentation, best practices, library APIs, security advisories.
Use http_request for direct API checks.
Cross-reference findings from code with external sources.
Return: comprehensive report with citations (code paths + URLs).
You CANNOT edit files or run commands — research only.

You are a SUB-AGENT, not the main agent. Be efficient:
- Complete the task with minimal tool calls — do not explore beyond what the task requires.
- Do not read files "for completeness" — only those needed for the task.
- Do not repeat already-done actions (e.g. re-reading the same file or re-searching the same query).
- As soon as the task is answered — return the result immediately, do not continue investigating.`,
    defaultIsolation: 'none',
  },

  // ── EDITOR — read + edit, NO run_command ──
  editor: {
    id: 'editor',
    nameEn: 'Editor',
    color: '#f59e0b',
    allowedTools: [...READ_TOOLS, ...EDIT_TOOLS],
    systemPromptInjection: `You are a CODE EDITOR sub-agent.
Your job: implement changes in the specified files.
Read the target files FIRST, then apply precise edits.
After editing — run get_diagnostics to verify no compilation errors.
You CANNOT run commands (no run_command) — use get_diagnostics for verification.
Return: list of modified files, summary of changes, any issues found.

You are a SUB-AGENT, not the main agent. Be efficient:
- Complete the task with minimal tool calls — do not explore beyond what the task requires.
- Read each file once, then edit — do not re-read files you already have.
- Do not repeat already-done actions (e.g. re-reading the same file, re-running diagnostics without new edits).
- As soon as the changes are done and verified — return the result immediately, do not continue investigating.`,
    defaultIsolation: 'worktree',
  },

  // ── IMPLEMENTER — full capabilities (read + edit + run_command) ──
  implementer: {
    id: 'implementer',
    nameEn: 'Implementer',
    color: '#34d399',
    // Полный набор = обратная совместимость (текущее поведение sub-agent).
    // Пустой allowedTools = не фильтровать, отдаём весь getToolSchemas.
    allowedTools: [],
    systemPromptInjection: `You are a full-capability IMPLEMENTER sub-agent.
Your job: implement the task end-to-end — read, edit, run commands, verify.
After edits — run get_diagnostics and relevant tests/commands to verify.
Return: what was done, files changed, commands run, verification results.

You are a SUB-AGENT, not the main agent. Be efficient:
- Complete the task with minimal tool calls — do not explore beyond what the task requires.
- Read each file once, then edit — do not re-read files you already have.
- Do not repeat already-done actions (e.g. re-running the same command, re-reading the same file).
- As soon as the task is done and verified — return the result immediately, do not continue investigating.`,
    defaultIsolation: 'worktree',
  },

  // ── REVIEWER — read-only code review ──
  reviewer: {
    id: 'reviewer',
    nameEn: 'Reviewer',
    color: '#f472b6',
    allowedTools: [...READ_TOOLS],
    systemPromptInjection: `You are a CODE REVIEW sub-agent.
Your job: review the specified code for bugs, security issues, performance, style.
Report findings by severity (critical/warning/info) with file:line references.
Do NOT edit anything — report only.
Return: structured review with actionable recommendations.

You are a SUB-AGENT, not the main agent. Be efficient:
- Complete the task with minimal tool calls — do not explore beyond what the task requires.
- Do not read files "for completeness" — only those needed for the review.
- Do not repeat already-done actions (e.g. re-reading the same file).
- As soon as the review is done — return the result immediately, do not continue investigating.`,
    defaultIsolation: 'none',
  },
}

export const DEFAULT_SUBAGENT_ROLE: SubagentRole = 'implementer'

const SUBAGENT_ROLE_MAP: Record<SubagentRole, SubagentRoleDef> = SUBAGENT_ROLES

/**
 * Возвращает определение роли по id. Unknown/undefined → implementer (default).
 * Безопасна для вызова с любым значением (включая null, мусор из БД).
 */
export function getSubagentRole(id: string | undefined | null): SubagentRoleDef {
  if (id && id in SUBAGENT_ROLE_MAP) {
    return SUBAGENT_ROLE_MAP[id as SubagentRole]
  }
  return SUBAGENT_ROLE_MAP[DEFAULT_SUBAGENT_ROLE]
}

/** True если id — валидная роль суб-агента. */
export function isValidSubagentRole(id: string | undefined | null): id is SubagentRole {
  return !!id && id in SUBAGENT_ROLE_MAP
}
