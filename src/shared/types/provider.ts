// ── AI Providers & Models ───────────────────────────────────────────────

export type ProviderType =
  | 'openai' | 'anthropic' | 'google' | 'groq' | 'cerebras' | 'mistral'
  | 'ollama' | 'cohere' | 'together' | 'fireworks' | 'deepseek'
  | 'xai' | 'voidai' | 'custom'
  | 'opencode' | 'opencode-free' | 'opencode-go'
  | 'openrouter'
  | 'syntee-gateway'

export interface Provider {
  id: string               // уникальный slug: 'openai', 'my-custom-1'
  type: ProviderType
  name: string             // отображаемое название
  baseUrl: string          // https://api.openai.com/v1
  apiKey: string           // основной ключ (обратная совместимость)
  apiKeys?: string[]       // несколько ключей — round-robin
  rrIndex?: number         // текущий индекс round-robin
  enabled: boolean
  isCustom: boolean
  iconUrl?: string         // для кастомных провайдеров
  lastModelsFetch?: number // timestamp последнего парсинга
  modelsOverride?: string[]// ручные модели добавленные пользователем
  /** Кастомный путь к endpoint /models (например '/v1/models'). По умолчанию '/models'. */
  modelsEndpoint?: string
  /** Провайдер работает без API-ключа (анонимный, шлёт Bearer public). */
  anonymous?: boolean
}

export type ModelCapability = 'vision' | 'tools' | 'reasoning' | 'code' | 'embedding' | 'tts' | 'stt' | 'image_gen'

/**
 * Спека режима мышления из каталога models.dev (поле reasoning_options).
 * Для каждой reasoning-модели каталог отдаёт массив контролов её API:
 *   [{ type: 'effort', values: ['low','medium','high','max'] }]
 *   [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024 }]
 *   [] — модель размышляет всегда, управлять нельзя (always-on)
 */
export interface ReasoningOptionSpec {
  type: 'effort' | 'toggle' | 'budget_tokens'
  /** effort: допустимые уровни ('none' = выключено). */
  values?: string[]
  /** budget_tokens: границы бюджета в токенах. */
  min?: number
  max?: number
}

export type ModelSpeed = 'fast' | 'medium' | 'slow'

export interface ModelMeta {
  id: string               // 'gpt-4o', 'claude-3-5-sonnet-20241022'
  providerId: string       // ссылка на Provider.id
  name: string             // красивое название
  contextWindow: number    // в токенах
  inputPrice?: number      // $ за 1M input токенов
  outputPrice?: number     // $ за 1M output токенов
  speed: ModelSpeed
  capabilities: ModelCapability[]
  description?: string
  isCustom?: boolean       // добавлена пользователем вручную
  /** Режимы мышления (reasoning_effort) — из /v1/models Syntee-Gateway. */
  reasoning?: { supported: boolean; levels: string[] }
  /** Спеки режимов мышления из каталога models.dev (reasoning_options). */
  reasoningOptions?: ReasoningOptionSpec[]
}

export type ModelRole =
  | 'main'        // основной чат
  | 'fast'        // быстрые ответы, автотайтлы
  | 'fastContext' // fast context retrieval (tree-sitter + fast LLM)
  | 'vision'      // анализ изображений
  | 'stt'         // speech-to-text
  | 'tts'         // text-to-speech
  | 'embedding'   // векторный поиск / память
  | 'memory'      // анализ памяти
  | 'summary'     // авто-заголовки чатов
  | 'subagent'    // суб-агенты

export interface ModelAssignment {
  role: ModelRole
  modelId: string
  providerId: string
}

export interface ModelParams {
  systemPrompt: string     // глобальная доп. инструкция (аппендится, не перезаписывает)
  streaming: boolean
  /** Скрывать кастомный User-Agent — SDK шлёт свой стандартный (как обычная openai-либа). */
  anonymousUserAgent?: boolean
}

export type ApprovalMode = 'ask' | 'auto' | 'full'
export type ToolOutputMode = 'compact' | 'normal' | 'detailed'

/**
 * Политика сетевых команд в авто-режиме:
 *   'ask-all' — спрашивать любую сетевую команду (npm install, curl, ssh...)
 *   'smart'   — пропускать пакеты из официальных реестров (npm/pip/winget
 *               без --registry и git-URL), спрашивать произвольные URL и ssh
 *   'off'     — не спрашивать сетевые команды вовсе (dangerous всё равно
 *               ловится классификатором)
 */
export type NetworkPolicy = 'ask-all' | 'smart' | 'off'

/**
 * Гранулярные настройки авто-режима (approvalMode='auto'): какие категории
 * действий всё-таки запрашивают подтверждение. Хранятся в
 * store.agentPermissions.autoMode (глобально) и могут быть переопределены
 * per-project через ProjectPermissionOverride.auto.
 */
export interface AutoModeSettings {
  /** DANGEROUS-уровень (rm -rf, reg add, git push -f...) — спрашивать. */
  askOnDangerous: boolean
  /** WARN-уровень (rm без -r, chmod, schtasks...) — спрашивать. */
  askOnWarn: boolean
  /** git push (без force) — отдельная кнопка от остальных warn. */
  askGitPush: boolean
  /** @deprecated legacy — заменено на networkPolicy (true→smart, false→off). */
  askNetwork?: boolean
  /** Сетевые команды — политика (см. NetworkPolicy). */
  networkPolicy: NetworkPolicy
  /** Файловые тулы (write/edit) и run_command с cwd вне папки проекта. */
  askOutsideWorkdir: boolean
}

export const DEFAULT_AUTO_MODE_SETTINGS: AutoModeSettings = {
  askOnDangerous: true,
  askOnWarn: false,
  askGitPush: true,
  networkPolicy: 'smart',
  askOutsideWorkdir: true,
}

/** Куда пишет панель настроек защиты: глобальный store или override проекта. */
export type PermissionScope = 'global' | 'project'

/** Scope записи «Всегда разрешать» из диалога подтверждения. */
export type AllowScope = 'session' | 'project' | 'global'

/**
 * Правило allowlist «Всегда разрешать»: команда/путь, не требующие
 * подтверждения в авто-режиме. pattern для run_command — нормализованная
 * команда или шаблон с '*' на конце ('npm install *'); для файловых тулов —
 * точный путь. DANGEROUS-действия allowlist'ом не покрываются.
 */
export interface ApprovalAllowlistEntry {
  tool: string
  pattern: string
  scope: AllowScope
  createdAt: number
}

/**
 * Per-project переопределение разрешений: store.projectPermissions[projectId].
 * Все поля опциональны — незаданные наследуются от глобальных настроек.
 */
export interface ProjectPermissionOverride {
  /** Режим подтверждения только для этого проекта (undefined = как глобально). */
  approvalMode?: ApprovalMode
  /** Переопределение отдельных настроек авто-режима (мерж поверх глобальных). */
  auto?: Partial<AutoModeSettings>
  /** Дополнительные запрещённые пути (мерж с глобальными forbiddenPaths). */
  forbiddenPaths?: string[]
  /** Проектный allowlist «Всегда разрешать» (мерж с глобальным). */
  approvalAllowlist?: ApprovalAllowlistEntry[]
}

export interface AgentSettings {
  approvalMode: ApprovalMode
  maxSteps: number
  toolOutputMode: ToolOutputMode
  enableThinking: boolean
  maxParallelSubAgents: number
  readFileCache: boolean
  autoMemoryInterval: number
  maxRepeatedToolCalls: number
  maxRepeatedErrors: number
}

// Дефолтные настройки агента. Вынесены в shared, чтобы renderer (SettingsPage)
// мог использовать их для кнопок «восстановить по умолчанию» без IPC-запроса.
// main/ipc/agent.ipc.ts и main/ipc/chat.ipc.ts импортируют отсюда же.
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approvalMode: 'ask',
  maxSteps: 50,
  toolOutputMode: 'normal',
  enableThinking: false,
  maxParallelSubAgents: 5,
  readFileCache: true,
  autoMemoryInterval: 5,
  maxRepeatedToolCalls: 3,
  maxRepeatedErrors: 2,
}

// IPC channels для провайдеров/моделей
export interface ProviderIPC {
  'providers:getAll': () => Provider[]
  'providers:save': (provider: Provider) => void
  'providers:delete': (id: string) => void
  'providers:fetchModels': (providerId: string) => ModelMeta[]
  'providers:testKey': (providerId: string) => { ok: boolean; error?: string }
  'models:getAll': () => ModelMeta[]
  'models:saveCustom': (model: ModelMeta) => void
  'models:deleteCustom': (modelId: string, providerId: string) => void
  'models:getAssignments': () => ModelAssignment[]
  'models:setAssignment': (assignment: ModelAssignment) => void
  'models:getParams': () => ModelParams
  'models:setParams': (params: Partial<ModelParams>) => void
}
