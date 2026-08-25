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
