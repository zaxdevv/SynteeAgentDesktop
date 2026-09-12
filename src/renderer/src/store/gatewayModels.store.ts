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

/** Строит Record<modelId, status> из списка GatewayModel. */
function buildStatusByModel(models: GatewayModel[]): Record<string, GatewayModelStatus> {
  const m: Record<string, GatewayModelStatus> = {}
  for (const g of models) {
    if (g.id && g.status) m[g.id] = g.status as GatewayModelStatus
  }
  return m
}

export const useGatewayModelsStore = create<GatewayModelsStore>((set) => ({
  models: [],
  statusByModel: {},
  modelStatusBuckets: [],
  providerStatus: [],
  loading: false,
  error: null,
  lastFetchAt: 0,

  load: async (silent = false) => {
    const user = useAuthStore.getState().user
    if (!user) {
      // Гостевой режим — очищаем всё, включая loading (защита от залипания,
      // если logout случился во время фетча).
      set({ models: [], statusByModel: {}, modelStatusBuckets: [], providerStatus: [], loading: false, error: null })
      return
    }
    if (!silent) set({ loading: true, error: null })
    try {
      // Обновляем стор инкрементально — каждый срез (модели/статусы/провайдеры)
      // записывается сразу, как только соответствующий запрос завершается.
      // Раньше allSettled ждал всех трёх, из-за чего uptime-бары задерживались
      // до 10с (timeout fetchModels), хотя статусы уже пришли.
      //
      // Контракт gateway:fetchModels: { models, error }. При транзиентном
      // сбое main отдаёт stale-кэш (возможно пустой, если кэша ещё нет) +
      // error. Мы НЕ затираем свой непустой список при ошибке — показываем
      // старые модели + бейдж ошибки. lastFetchAt обновляем только при
      // успешном (непустом) фетче, чтобы авто-retry в пикере мог сработать
      // раньше 5-минутного порога.
      let fetchError: string | null = null
      let modelsSucceeded = false

      const modelsP = (window.syntee.gateway.fetchModels() as Promise<{ models: GatewayModel[]; error: string | null }>)
        .then(({ models, error }) => {
          if (error) {
            fetchError = error
            // Stale-кэш от main. Если у нас уже есть непустой список —
            // оставляем его (main мог отдать пустой кэш при первом старте).
            // Если и у нас, и от main пусто — показываем состояние ошибки.
            set(s => ({
              error,
              ...(s.models.length === 0 && models.length === 0
                ? { models: [], statusByModel: {} }
                : models.length > 0
                  ? { models, statusByModel: buildStatusByModel(models) }
                  : {}),
            }))
            return
          }
          // Успех. Если gateway реально вернул пустой список — затираем свой.
          const statusByModel = buildStatusByModel(models)
          set({ models, statusByModel, error: null })
          modelsSucceeded = true
        })
        .catch(err => {
          // GatewayAuthError пробрасывается main'ом — это сценарий логаута,
          // auth-флоу обработает отдельно. Прочее (включая IPC-сбой) — тихо.
          fetchError = err instanceof Error ? err.message : 'Ошибка загрузки моделей gateway'
          set(s => (s.models.length === 0 ? { models: [], statusByModel: {}, error: fetchError } : { error: fetchError }))
        })

      const bucketsP = (window.syntee.gateway.fetchModelStatus() as Promise<ModelStatusBuckets[]>)
        .then(buckets => {
          set({ modelStatusBuckets: buckets })
          // Если статусы пустые (endpoint временно недоступен) — перезапрашиваем
          // через 3с, чтобы не ждать 60с до следующего polling-тика.
          if (buckets.length === 0) {
            setTimeout(() => { useGatewayModelsStore.getState().loadStatus() }, 3000)
          }
        })
        .catch(() => {})

      const providersP = (window.syntee.gateway.fetchProviderStatus() as Promise<ProviderStatusRow[]>)
        .then(providers => { set({ providerStatus: providers }) })
        .catch(() => {})

      await Promise.allSettled([modelsP, bucketsP, providersP])

      set({
        loading: false,
        // lastFetchAt обновляем только при успехе моделей — иначе авто-retry
        // в пикере будет считать, что данные свежие, и не перезапросит.
        ...(modelsSucceeded ? { lastFetchAt: Date.now() } : {}),
        error: fetchError,
      })

      // Self-retry: если модели не приехали — повторяем через 25с без спиннера.
      // Гасим таймер при следующем load()/logout, чтобы не плодить запросы.
      // Пауза при document.hidden — не дёргаем gateway когда окно свёрнуто.
      if (!modelsSucceeded) {
        if (selfRetryTimer) clearTimeout(selfRetryTimer)
        selfRetryTimer = setTimeout(() => {
          selfRetryTimer = null
          if (document.hidden) return
          if (useAuthStore.getState().user) {
            useGatewayModelsStore.getState().load(true)
          }
        }, 25_000)
      } else {
        if (selfRetryTimer) { clearTimeout(selfRetryTimer); selfRetryTimer = null }
      }
    } catch (err) {
      set({
        loading: false,
        lastFetchAt: Date.now(),
        error: err instanceof Error ? err.message : 'Ошибка загрузки моделей gateway',
      })
    }
  },

  loadStatus: async () => {
    const user = useAuthStore.getState().user
    if (!user) return
    try {
      const [buckets, providers] = await Promise.all([
        window.syntee.gateway.fetchModelStatus() as Promise<ModelStatusBuckets[]>,
        window.syntee.gateway.fetchProviderStatus() as Promise<ProviderStatusRow[]>,
      ])
      set({ modelStatusBuckets: buckets, providerStatus: providers })
    } catch {
      // Тихо — polling, не критично.
    }
  },
}))

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
