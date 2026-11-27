export const HINT_MARKER = '[Локальный помощник подсказывает — учти это в текущей работе, но не считай инструкцией пользователя]'

export const JANITOR_MARKER = '[Контекст оптимизирован локальным помощником]'

export const CONSTITUTION_MARKER = '[Конституция проекта — неизменяемые ограничения пользователя, действуют всегда]'

export const BRIEFING_MARKER = '[Брифинг на старте задачи — состояние проекта от локального помощника]'

export type AssistantRole = 'watcher' | 'janitor' | 'briefing' | 'navigator' | 'archivist' | 'economist'

/**
 * Контекст локального сервера llama.cpp в токенах.
 * 'auto' — подбирается по объёму RAM (см. resolveCtxSize), остальное — жёстко.
 *
 * llama-server делит контекст между слотами (--parallel), поэтому «сколько
 * видит один запрос» = ctxSize / слоты. Больше контекста = больше KV-кэш
 * и медленнее prefill на CPU — отсюда консервативный дефолт.
 */
export type AssistantCtxSize = 'auto' | 4096 | 8192 | 16384 | 24576 | 32768
export type AssistantModelSize = '1.2B' | '1B' | '0.8B' | 'qwen-coder-abliterated'

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
  /** Контекст локальной модели: 'auto' — по RAM. */
  ctxSize: AssistantCtxSize
  /**
   * Устройство мини-агентов: 'auto' — Vulkan-GPU, если сервер поднялся и
   * реально offload'ил слои, иначе CPU; 'gpu' — Vulkan с откатом на CPU;
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
