// ── MCP (Model Context Protocol) ────────────────────────────────────────

/** Транспорт подключения к MCP-серверу. */
export type McpTransport = 'stdio' | 'sse' | 'streamable-http'

/**
 * Область применения расширения (MCP-сервера или скилла).
 * - global  → применяется ко всем чатам
 * - projects → применяется только к чатам выбранных проектов (projectIds)
 */
export interface ExtensionScope {
  type: 'global' | 'projects'
  projectIds?: string[]
}

/** Конфигурация MCP-сервера (хранится в electron-store / .mcp.json). */
export interface McpServerConfig {
  /** Уникальный slug. Для проектных серверов — имя из .mcp.json. */
  id: string
  /** Отображаемое имя. */
  name: string
  transport: McpTransport
  // stdio-only
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse-only
  url?: string
  headers?: Record<string, string>
  /** Включён ли сервер (глобальный тумблер). */
  enabled: boolean
  scope: ExtensionScope
  /** 'global' (из electron-store) или 'project' (из .mcp.json). */
  source: 'global' | 'project'
  /** Для проектных серверов — id проекта, из workdir которого загружен. */
  projectId?: string
}

/** Per-tool состояние (включён / подтверждение) — хранится отдельно от конфига. */
export interface McpToolState {
  enabled: boolean
  /** Спрашивать подтверждение перед вызовом этого тула. */
  requireApproval: boolean
}

/** Runtime-описание тула MCP, агрегированное McpManager-ом для агента. */
export interface McpToolRuntime {
  serverId: string
  serverName: string
  /** Полное имя тула: mcp__{serverName}__{toolName}. */
  name: string
  /** Короткое имя тула (без префикса). */
  shortName: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Статус подключения MCP-сервера. */
export type McpConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

/** Уровень записи в журнале подключения MCP-сервера. */
export type McpLogLevel = 'info' | 'warn' | 'error'

/** Одна запись журнала подключения MCP-сервера (для UI лог-вьюера). */
export interface McpLogEntry {
  /** Unix ms. */
  ts: number
  level: McpLogLevel
  message: string
}

/** Полное состояние сервера для UI (конфиг + runtime). */
export interface McpServerRuntime extends McpServerConfig {
  status: McpConnectionStatus
  error?: string
  tools: McpToolRuntime[]
  /** Per-tool состояние, сгруппированное по полному имени тула. */
  toolStates: Record<string, McpToolState>
  /** Timestamp начала последней попытки подключения (для UI-таймера). */
  connectStartedAt?: number
  /** Журнал подключения (хронологически; накопительно, cap на стороне main). */
  logs?: McpLogEntry[]
}
