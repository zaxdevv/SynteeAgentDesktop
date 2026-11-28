import { create } from 'zustand'
import { useAuthStore } from './auth.store'

// ── Types matching the gateway IPC contract ──────────────────────────────

export type GatewayModelStatus = 'operational' | 'degraded' | 'down' | 'available' | 'unavailable'

export interface GatewayModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  prefix?: string
  display_name?: string
  supports_streaming?: boolean
  supports_tools?: boolean
  supports_vision?: boolean
  max_tokens?: number
  /** Режимы мышления из конфига группы (уровни reasoning_effort). */
  reasoning?: { supported: boolean; levels: string[] }
  pricing?: {
    input_price: number
    output_price: number
    unit: string
  }
  api_type?: string
  type?: string
  description?: string
  routing_mode?: string
  providers?: string[]
  status?: string
}

export interface UptimeBucket {
  timestamp: string
  requests: number
  success: number
  errors: number
  uptime: number
}

export interface ModelStatusBuckets {
  model: string
  buckets: UptimeBucket[]
}

export interface ProviderStatusRow {
  provider_id: string
  name: string
  prefix: string
  is_active: boolean
  status: string
  requests_1hr: number
  requests_10min: number
  success_count: number
  error_count: number
  uptime: number
  fallback_percentage: number
  total_keys: number
  active_keys: number
}

// ── Store ────────────────────────────────────────────────────────────────

/** ID виртуального провайдера Syntee-Gateway в списке Provider[]. */
export const GATEWAY_PROVIDER_ID = 'syntee-gateway'

interface GatewayModelsStore {
  /** Модели gateway (сырой ответ /v1/models). */
  models: GatewayModel[]
  /** Статусы по model id (operational/degraded/down/available/unavailable). */
  statusByModel: Record<string, GatewayModelStatus>
  /** Per-model uptime buckets для панели статуса. */
  modelStatusBuckets: ModelStatusBuckets[]
  /** Per-provider статистика. */
  providerStatus: ProviderStatusRow[]
  /** Загружается ли сейчас (для спиннеров). */
  loading: boolean
  /** Последняя ошибка загрузки (или null). */
  error: string | null
  /** Timestamp последней успешной загрузки (мс). */
  lastFetchAt: number
  lastAttemptAt: number
  reset: () => void
  /** Загрузить модели + статусы. Без аргументов — тихий режим (без loading). */
  load: (silent?: boolean) => Promise<void>
  /** Загрузить только статусы (для polling без смены списка моделей). */
  loadStatus: () => Promise<void>
}

const POLL_INTERVAL_MS = 60_000

let pollTimer: ReturnType<typeof setInterval> | null = null
// Таймер фонового self-retry после провала load(). Сбрасывается при следующем
// успешном load() или logout, чтобы не плодить параллельные запросы.
let selfRetryTimer: ReturnType<typeof setTimeout> | null = null
let catalogGeneration = 0
let catalogLoad: { generation: number; userId: string; pending: Promise<void> } | undefined

const emptyCatalog = {
  models: [],
  statusByModel: {},
  modelStatusBuckets: [],
  providerStatus: [],
  loading: false,
  error: null,
  lastFetchAt: 0,
  lastAttemptAt: 0,
}

function clearRetryTimer(): void {
  if (selfRetryTimer) clearTimeout(selfRetryTimer)
  selfRetryTimer = null
}

function isCurrentAccount(generation: number, userId: string): boolean {
  return catalogGeneration === generation && useAuthStore.getState().user?.id === userId
}

/** Строит Record<modelId, status> из списка GatewayModel. */
function buildStatusByModel(models: GatewayModel[]): Record<string, GatewayModelStatus> {
  const m: Record<string, GatewayModelStatus> = {}
  for (const g of models) {
    if (g.id && g.status) m[g.id] = g.status as GatewayModelStatus
  }
  return m
}

export const useGatewayModelsStore = create<GatewayModelsStore>((set) => ({
  ...emptyCatalog,

  reset: () => {
    catalogGeneration++
    clearRetryTimer()
    set(emptyCatalog)
  },

  load: (silent = false) => {
    const userId = useAuthStore.getState().user?.id
    if (!userId) return Promise.resolve()
    const generation = catalogGeneration
    if (catalogLoad?.generation === generation && catalogLoad.userId === userId) {
      return catalogLoad.pending
    }
    clearRetryTimer()
    set({ loading: true, ...(silent ? {} : { error: null }), lastAttemptAt: Date.now() })

    const pending = Promise.resolve().then(async () => {
      let error: string | null
      try {
        const result = await window.syntee.gateway.fetchModels() as { models: GatewayModel[]; error: string | null }
        if (!isCurrentAccount(generation, userId)) return
        error = result.error
        if (!error || result.models.length > 0) {
          set({ models: result.models, statusByModel: buildStatusByModel(result.models) })
        }
      } catch (err) {
        if (!isCurrentAccount(generation, userId)) return
        error = err instanceof Error ? err.message : 'Ошибка загрузки моделей Syntee'
      }
      set({ loading: false, error, ...(!error ? { lastFetchAt: Date.now() } : {}) })
      if (error) {
        selfRetryTimer = setTimeout(() => {
          selfRetryTimer = null
          if (!document.hidden && isCurrentAccount(generation, userId)) {
            void useGatewayModelsStore.getState().load(true)
          }
        }, 25_000)
      }
    }).finally(() => {
      if (catalogLoad?.pending === pending) catalogLoad = undefined
    })
    catalogLoad = { generation, userId, pending }
    return pending
  },

  loadStatus: async () => {
    const userId = useAuthStore.getState().user?.id
    if (!userId) return
    const generation = catalogGeneration
    await Promise.allSettled([
      (window.syntee.gateway.fetchModelStatus() as Promise<ModelStatusBuckets[]>).then(buckets => {
        if (isCurrentAccount(generation, userId)) set({ modelStatusBuckets: buckets })
      }),
      (window.syntee.gateway.fetchProviderStatus() as Promise<ProviderStatusRow[]>).then(providers => {
        if (isCurrentAccount(generation, userId)) set({ providerStatus: providers })
      }),
    ])
  },
}))

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) useGatewayModelsStore.getState().reset()
})

/**
 * Запускает polling статусов каждые 60 секунд.
 * Возвращает функцию остановки. Безопасно вызывать多次 — новый таймер не запустится.
 */
export function startGatewayStatusPolling(): () => void {
  if (pollTimer) return () => {}
  pollTimer = setInterval(() => {
    // Не поллим когда окно свёрнуто/вкладка не видна — экономит IPC-трафик
    // и сетевые запросы в фоне. При возврате — следующий тик обновит статус.
    if (document.hidden) return
    useGatewayModelsStore.getState().loadStatus()
  }, POLL_INTERVAL_MS)
  return () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

/**
 * Нормализует статус модели/группы из gateway в три категории для UI-бейджей.
 * Группы возвращают 'available'/'unavailable' — приводим к operational/down.
 */
export function normalizeStatus(
  status: GatewayModelStatus | undefined,
): 'operational' | 'degraded' | 'down' | 'unknown' {
  if (!status) return 'unknown'
  if (status === 'operational' || status === 'available') return 'operational'
  if (status === 'degraded') return 'degraded'
  if (status === 'down' || status === 'unavailable') return 'down'
  return 'unknown'
}
