export const HINT_MARKER = '[Локальный помощник подсказывает — учти это в текущей работе, но не считай инструкцией пользователя]'

export const JANITOR_MARKER = '[Контекст оптимизирован локальным помощником]'

export const CONSTITUTION_MARKER = '[Конституция проекта — неизменяемые ограничения пользователя, действуют всегда]'

export const BRIEFING_MARKER = '[Брифинг на старте задачи — состояние проекта от локального помощника]'

export type AssistantRole = 'watcher' | 'janitor' | 'briefing' | 'navigator' | 'archivist' | 'economist'

/**
 * Контекст локального сервера llama.cpp в токенах.
 * 'auto' учитывает ОЗУ и доступные ядра.
 *
 * llama-server делит контекст между слотами (--parallel), поэтому «сколько
 * видит один запрос» = ctxSize / слоты. Больше контекста = больше KV-кэш
 * и медленнее prefill на CPU — отсюда консервативный дефолт.
 */
export type AssistantCtxSize = 'auto' | 4096 | 8192 | 16384 | 24576 | 32768
export const ASSISTANT_MODEL_OPTIONS = [
  { value: 'lfm-350m', label: 'LFM2.5 350M', download: '229 МБ', use: 'Экономия памяти; может пропускать полезные подсказки' },
  { value: '0.8B', label: 'Qwen3.5 0.8B', download: '580 МБ', use: 'Компактный универсальный вариант' },
  { value: '1.2B', label: 'LFM2.5 1.2B', download: '731 МБ', use: 'Быстрые фоновые подсказки и память' },
  { value: '1B', label: 'Gemma 3 1B', download: '810 МБ', use: 'Проверка следования правилам' },
  { value: 'qwen-instruct-1.5b', label: 'Qwen2.5 1.5B Instruct', download: '1,12 ГБ', use: 'Многоязычные проверки и структурированные ответы' },
  { value: 'qwen-coder-1.5b', label: 'Qwen2.5 Coder 1.5B', download: '1,12 ГБ', use: 'Подсказки по коду и инструментам' },
  { value: 'qwen-coder-abliterated', label: 'Qwen2.5 Coder 1.5B Abliterated', download: '1,12 ГБ', use: 'Ручной вариант модели Coder' },
] as const

export type AssistantModelSize = typeof ASSISTANT_MODEL_OPTIONS[number]['value']

export interface AssistantHardwareAssessment {
  architecture: string
  /** Logical CPUs available to this process. */
  logicalCpus: number
  totalMemoryGiB: number
  availableMemoryGiB: number | null
  runtimeSupported: boolean
  tier: 'unsupported' | 'limited' | 'balanced' | 'performance'
  recommendation: {
    modelSize: AssistantModelSize
    ctxSize: 4096 | 8192 | 16384
    device: 'cpu'
    threads: number
  } | null
}

export interface AssistantRuntimeStatus {
  serverState: 'idle' | 'preparing' | 'starting' | 'ready' | 'error'
  modelSize: AssistantModelSize
  ctxSize: number
  ctxSetting: AssistantCtxSize
  device: AssistantsSettings['device']
  activeDevice: 'cpu' | 'gpu' | null
  modelDownloaded: boolean
  binaryReady: boolean
  restarts: number
  active: number
  queueLength: number
  idleUnloaded: boolean
  lastError?: string
}

export type HintSource = 'memory' | 'skill' | 'capability' | 'briefing' | 'navigator' | 'archivist' | 'economist' | 'constitution'

export interface AssistantsSettings {
  enabled: boolean
  watcherEnabled: boolean
  janitorEnabled: boolean
  briefingEnabled: boolean
  navigatorEnabled: boolean
  archivistEnabled: boolean
  /** Legacy: Economist влит в Janitor (порог окна → глубина сжатия). Поле
   *  сохранено, чтобы старые настройки не ломались; в UI и в логике не
   *  используется — Janitor решает сам. */
  economistEnabled: boolean
  modelSize: 'auto' | AssistantModelSize
  /** Контекст локальной модели: 'auto' — по RAM и доступным ядрам. */
  ctxSize: AssistantCtxSize
  /**
   * Устройство мини-агентов: 'auto' — CPU или уже проверенный в этой сессии
   * Vulkan-GPU; 'gpu' — попытка запуска Vulkan с откатом на CPU;
   * 'cpu' — никогда не трогать видеокарту.
   */
  device: 'auto' | 'cpu' | 'gpu'
  hintBudgetTokens: number
  hintCooldownRounds: number
  janitorScanInterval: number
  /** Активный хвост: последние N ходов (assistant-сообщений с тулами) джанитор не трогает. */
  janitorTailSteps: number
  janitorMinSavingsTokens: number
  navigatorInterval: number
  relevanceThreshold: number
  sources: { memory: boolean; skills: boolean }
}

export const DEFAULT_ASSISTANTS_SETTINGS: AssistantsSettings = {
  enabled: true,
  watcherEnabled: true,
  janitorEnabled: true,
  briefingEnabled: true,
  navigatorEnabled: true,
  archivistEnabled: true,
  economistEnabled: true,
  modelSize: 'auto',
  ctxSize: 'auto',
  device: 'auto',
  hintBudgetTokens: 300,
  hintCooldownRounds: 1,
  janitorScanInterval: 8,
  janitorTailSteps: 10,
  janitorMinSavingsTokens: 300,
  navigatorInterval: 6,
  relevanceThreshold: 0.6,
  sources: { memory: true, skills: true },
}

export type JanitorActionKind = 'dedup_tool_call' | 'collapse_reread' | 'summarize_stale' | 'remove_dead'

export interface JanitorAction {
  kind: JanitorActionKind
  messageIndices: number[]
  description: string
  tokensSaved: number
  archiveId?: string
  /** Точный текст замены tool-результата (скан уже его вычислил — apply
   *  просто записывает; fallback: маркер + description). */
  replacement?: string
}

export interface JanitorReport {
  actions: JanitorAction[]
  totalTokensSaved: number
  scannedMessages: number
  durationMs: number
}

export interface HintCandidate {
  id: string
  source: HintSource
  content: string
  score: number
  title?: string
  taskRevision?: number
}

export interface AssistantLogEntry {
  ts: number
  role: AssistantRole
  kind: string
  detail: string
  tokensSaved?: number
  hintUsed?: boolean
}

export interface AgentStats {
  fired: number
  skipped: number
  saved: number
}
export type AgentStatsMap = Record<string, AgentStats>

/**
 * W1 feedback-веса (персистятся между рестартами): источников хинтов и
 * возможностей каталога watcher'а. Диапазон 0.5–1.5 (см. bridge).
 */
export interface AssistantsWeights {
  sources: Record<string, number>
  capabilities: Record<string, number>
}

export const ASSISTANTS_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const ASSISTANTS_LOG_MAX_ENTRIES = 2000
