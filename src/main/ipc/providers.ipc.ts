import { ipcMain } from 'electron'
import type Store from 'electron-store'
import type { Provider, ModelMeta, ModelAssignment, ModelParams } from '../../shared/types'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { getCatalogModel, inferSpeed, getCatalogStatus, type CatalogModelInfo } from '../../core/tokens/modelCatalog'
import { getGatewayModelsCache, GATEWAY_PROVIDER_ID } from '../../core/tokens/gatewayModelsCache'
import { getOpencodeZenHeaders, isOpencodeProvider } from '../../shared/constants'
import { fetchCodexModels } from '../services/codexAuth'
import { getGatewayApiUrl } from '../services/gatewayClient'
import { hasTokens } from '../services/tokenStore'
import { fetchGatewayModels } from './gateway.ipc'

// ── Кэш моделей Syntee-Gateway ─────────────────────────────────────────────
// Переехал в core/tokens/gatewayModelsCache.ts: его теперь читает и core-код
// (contextManager.getModelContextWindow / usageTracker.getModelPriceInfo —
// gateway-моделям contextWindow и цены отдаёт сам gateway, каталог models.dev
// провайдера не знает). Обновляется через gateway:fetchModels (renderer тянет
// после входа и при polling); models:getAll берёт кэш синхронно, без сети.

// ── Кэш enrichment для models:getAll ────────────────────────────────────────
// getCatalogModel() в худшем случае (проксирующие провайдеры) сканирует весь
// кэш models.dev (globalSearch), что дорого при большом списке custom/cached
// моделей. Кэшируем результат по паре providerId:modelId в памяти процесса
// и сбрасываем кэш, когда каталог сам обновился (см. lastFetch ниже) —
// иначе после refreshCatalog() (раз в 24ч) enrichment остался бы старым.
const enrichCache = new Map<string, CatalogModelInfo | null>()
let enrichCacheBuiltAtFetch: number | null = null

function getCatalogModelCached(providerId: string, modelId: string): CatalogModelInfo | null {
  const { lastFetch } = getCatalogStatus()
  if (lastFetch !== enrichCacheBuiltAtFetch) {
    enrichCache.clear()
    enrichCacheBuiltAtFetch = lastFetch
  }
  const key = `${providerId}:${modelId}`
  if (enrichCache.has(key)) return enrichCache.get(key) ?? null
  const result = getCatalogModel(providerId, modelId)
  enrichCache.set(key, result)
  return result
}

/** Merge media metadata without implying endpoint/adapter transport support.
 * Explicit modalities correct stale capability unions; old caches retain tags. */
export function mergeModelMediaMetadata(model: ModelMeta, catalog: CatalogModelInfo | null): ModelMeta {
  const inputModalities = model.inputModalities ?? catalog?.inputModalities
  const outputModalities = model.outputModalities ?? catalog?.outputModalities
  const caps = new Set([...model.capabilities, ...(catalog?.capabilities ?? [])])
  const set = (cap: ModelMeta['capabilities'][number], enabled: boolean): void => {
    if (enabled) caps.add(cap)
    else caps.delete(cap)
  }
  if (inputModalities !== undefined) {
    set('vision', inputModalities.includes('image'))
    set('video', inputModalities.includes('video'))
    set('audio_input', inputModalities.includes('audio'))
    set('stt', inputModalities.includes('audio'))
  } else if (caps.has('stt')) caps.add('audio_input')
  if (outputModalities !== undefined) {
    set('audio_output', outputModalities.includes('audio'))
    set('tts', outputModalities.includes('audio'))
    set('image_gen', outputModalities.includes('image'))
  } else if (caps.has('tts')) caps.add('audio_output')
  return { ...model, inputModalities, outputModalities, capabilities: [...caps] }
}

const DEFAULT_PARAMS: ModelParams = {
  systemPrompt: '',
  streaming: true,
  anonymousUserAgent: false,
}

/**
 * Round-robin: возвращает следующий ключ провайдера и обновляет индекс в store.
 * Если apiKeys пустой или не задан — возвращает apiKey (основной).
 */
export function getNextApiKey(store: Store, providerId: string): string {
  const list = store.get('providers', []) as Provider[]
  const idx = list.findIndex(p => p.id === providerId)
  if (idx < 0) return ''
  const p = list[idx]
  const keys = (p.apiKeys || []).filter(k => k.trim())
  if (keys.length === 0) return p.apiKey || ''
  if (keys.length === 1) return keys[0]
  const current = (p.rrIndex ?? 0) % keys.length
  const key = keys[current]
  list[idx] = { ...p, rrIndex: (current + 1) % keys.length }
  store.set('providers', list)
  return key
}

const DEFAULT_ASSIGNMENTS: ModelAssignment[] = [
  { role: 'main',      modelId: 'claude-sonnet-4-6',  providerId: 'anthropic' },
  { role: 'fast',      modelId: 'mimo-v2.5-free',     providerId: 'opencode-free' },
  { role: 'vision',    modelId: 'gpt-4o',             providerId: 'openai' },
  { role: 'video',     modelId: '',                   providerId: '' },
  { role: 'audio',     modelId: '',                   providerId: '' },
  { role: 'stt',       modelId: '',                   providerId: '' },
  { role: 'tts',       modelId: '',                   providerId: '' },
  { role: 'embedding', modelId: '',                   providerId: '' },
  { role: 'memory',    modelId: 'inclusionai/ling-3.0-flash:free', providerId: 'openrouter' },
  { role: 'summary',   modelId: 'claude-haiku-4-5',   providerId: 'anthropic' },
]

// ── Fetch моделей провайдера ───────────────────────────────────────────────
// Вынесен из ipcMain.handle('providers:fetchModels') — теперь его вызывает и
// авто-обновление opencode-провайдеров (см. autoRefreshOpencodeModels).

async function fetchProviderModels(
  store: Store,
  providerId: string,
): Promise<{ ok: boolean; error: string | null; models: ModelMeta[]; count: number }> {
  const list = store.get('providers', []) as Provider[]
  const provider = list.find(p => p.id === providerId)
  if (!provider) return { ok: false, error: 'Провайдер не найден', models: [], count: 0 }

  let fetched: ModelMeta[] = []
  let error: string | null = null

  if (provider.id === GATEWAY_PROVIDER_ID) {
    try {
      const result = await fetchGatewayModels()
      const models = getGatewayModelsCache()
      return { ok: result.error === null, error: result.error, models, count: models.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), models: [], count: 0 }
    }
  }

  if (provider.type === 'openai-codex') {
    // ChatGPT-подписка: список моделей живёт не на provider.baseUrl + '/models',
    // а на бэкенде Codex (/backend-api/codex/models?client_version=…). Бэкенд
    // сам фильтрует по тарифу аккаунта и отдаёт display_name, контекст и уровни
    // reasoning — поэтому каталога в BUILTIN_MODELS для этой ветки нет.
    const result = await fetchCodexModels()
    error = result.error ?? null
    fetched = result.models
  } else {
    try {
      const url = provider.baseUrl.replace(/\/$/, '') + (provider.modelsEndpoint || '/models')
      const res = await fetch(url, {
        headers: {
          // Анонимные провайдеры (opencode-free) шлют apiKey 'public' → Bearer public.
          // Если apiKey пуст — fallback на 'public' (как делает opencode CLI).
          'Authorization': `Bearer ${provider.apiKey || 'public'}`,
          'Content-Type': 'application/json',
          // Zen-провайдерам — cli-заголовки (иначе Cloudflare 403 / анонимные rate-лимиты)
          ...(isOpencodeProvider(provider.id, provider.type) ? getOpencodeZenHeaders() : {}),
        },
      })
      if (!res.ok) {
        error = `HTTP ${res.status}: ${res.statusText}`
      } else {
        const data = await res.json() as { data?: { id: string }[]; models?: { id: string }[] }
        // Поддерживаем оба формата: { data: [...] } и { models: [...] }
        const items = data.data || data.models || []
        let ids: string[] = items.map((m: { id: string }) => m.id).filter(Boolean)

        // OpenCode Zen Free — анонимный провайдер, оставляем только free-модели.
        // Live-endpoint /zen/v1/models возвращает все id; дискриминатор free —
        // суффикс -free. Исключения:
        //   big-pickle — free без суффикса (stealth-модель, Free в доке Zen);
        //   deepseek-v4-flash-free — фантом: есть в /models, но отсутствует в
        //     доке free-моделей и бэкенд отдаёт 400 «Model is unavailable».
        if (provider.id === 'opencode-free') {
          ids = ids.filter(id => (id.endsWith('-free') || id === 'big-pickle') && id !== 'deepseek-v4-flash-free')
        }

        fetched = ids.map(id => {
          const known = BUILTIN_MODELS.find(b => b.id === id)
          if (known) return { ...known, providerId }
          // Пытаемся получить статы из каталога models.dev
          const fromCatalog = getCatalogModel(providerId, id)
          return {
            id, providerId,
            name: fromCatalog?.displayName ?? id,
            contextWindow: fromCatalog?.contextWindow ?? 0,
            // Цена — только если models.dev реально отдал cost (hasPricing);
            // иначе undefined = «цена неизвестна» (не путаем с «бесплатно»).
            inputPrice: fromCatalog?.hasPricing ? fromCatalog.inputPricePerM / 100 : undefined,
            outputPrice: fromCatalog?.hasPricing ? fromCatalog.outputPricePerM / 100 : undefined,
            speed: inferSpeed(id),
            capabilities: fromCatalog?.capabilities ?? [],
            description: fromCatalog?.description ?? '',
          }
        })
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  // Timestamp провайдера + кэш моделей — общий шаг для обоих источников.
  if (!error) {
    const idx = list.findIndex(p => p.id === providerId)
    if (idx >= 0) {
      list[idx].lastModelsFetch = Date.now()
      store.set('providers', list)
    }

    // Сохраняем модели в cachedModels — убираем старые от этого провайдера, добавляем новые
    const cached = store.get('cachedModels', []) as ModelMeta[]
    const filtered = cached.filter(m => m.providerId !== providerId)
    store.set('cachedModels', [...filtered, ...fetched])
  }

  // Добавляем ручные переопределения
  const overrides = provider.modelsOverride || []
  for (const id of overrides) {
    if (!fetched.find(m => m.id === id)) {
      const fromCatalog = getCatalogModel(providerId, id)
      fetched.push({
        id, providerId,
        name: fromCatalog?.displayName ?? id,
        contextWindow: fromCatalog?.contextWindow ?? 0,
        inputPrice: fromCatalog ? fromCatalog.inputPricePerM / 100 : undefined,
        outputPrice: fromCatalog ? fromCatalog.outputPricePerM / 100 : undefined,
        speed: inferSpeed(id),
        capabilities: fromCatalog?.capabilities ?? [],
        description: fromCatalog?.description ?? '',
      })
    }
  }

  fetched = fetched.map(m => mergeModelMediaMetadata(m, getCatalogModelCached(m.providerId, m.id)))
  // Persist enriched modalities as well as returning them to the picker.
  if (!error) {
    const cached = store.get('cachedModels', []) as ModelMeta[]
    store.set('cachedModels', [...cached.filter(m => m.providerId !== providerId), ...fetched])
  }
  return { ok: !error, error, models: fetched, count: fetched.length }
}

// ── Auto-refresh моделей OpenCode-провайдеров ──────────────────────────────
// Zen регулярно ротирует free-модели (за 09.2026 удалены north-mini-code-free,
// laguna-s-2.1-free, ling-3.0-flash-free; добавлены nemotron-3.5-lightning-free,
// ling-3.0-flash-fin-free, muse-spark-*-contributor-free). Чтобы список в
// пикере всегда был актуален, фетчим /models автоматически: на старте (если
// кэш старше 30 мин) и далее каждые 6 часов. Только opencode-провайдеры —
// ключевые провайдеры не трогаем (квоты, лишние запросы).

const AUTO_FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000   // период фонового обновления
const AUTO_FETCH_MIN_STALE_MS = 30 * 60 * 1000      // на старте — только если кэш старше 30 мин

/** Известно мёртвые opencode-free модели → живые замены (миграция assignments). */
const DEAD_OPENCODE_MODEL_REPLACEMENTS: Record<string, string> = {
  'north-mini-code-free': 'mimo-v2.5-free',
  'laguna-s-2.1-free': 'ling-3.0-flash-fin-free',
  'ling-3.0-flash-free': 'ling-3.0-flash-fin-free',
}

/**
 * Миграция назначений: если роль указывает на удалённую с Zen модель —
 * заменяем на живую. С fetchedIds (фактический live-список) проверяем любое
 * отсутствие; без него — только статическую карту мёртвых.
 */
function migrateDeadOpencodeAssignments(store: Store, fetchedIds?: Set<string>): void {
  const assignments = store.get('modelAssignments', DEFAULT_ASSIGNMENTS) as ModelAssignment[]
  let changed = false
  for (const a of assignments) {
    if (a.providerId !== 'opencode-free' || !a.modelId) continue
    const isDead = fetchedIds
      ? !fetchedIds.has(a.modelId)
      : a.modelId in DEAD_OPENCODE_MODEL_REPLACEMENTS
    if (!isDead) continue
    // Приоритет замен: карта → mimo (проверенная быстрая) → первая из live-списка
    const replacement = DEAD_OPENCODE_MODEL_REPLACEMENTS[a.modelId]
      ?? (fetchedIds?.has('mimo-v2.5-free') ? 'mimo-v2.5-free' : undefined)
      ?? (fetchedIds ? [...fetchedIds][0] : undefined)
    if (replacement && replacement !== a.modelId) {
      changed = true
      a.modelId = replacement
    }
  }
  if (changed) store.set('modelAssignments', assignments)
}

/** Тихий фоновый фетч моделей всех включённых opencode-провайдеров. */
function autoRefreshOpencodeModels(store: Store, force = false): void {
  const list = store.get('providers', []) as Provider[]
  for (const p of list) {
    if (!p.enabled || !p.baseUrl) continue
    if (!isOpencodeProvider(p.id, p.type)) continue
    if (!force && p.lastModelsFetch && Date.now() - p.lastModelsFetch < AUTO_FETCH_MIN_STALE_MS) continue
    fetchProviderModels(store, p.id)
      .then(res => {
        // После успешного live-фетча — миграция назначений с мёртвых моделей
        if (res.ok && p.id === 'opencode-free') {
          migrateDeadOpencodeAssignments(store, new Set(res.models.map(m => m.id)))
        }
      })
      .catch(() => { /* тихий фоновой фетч — ошибки не критичны, ретрай через 6ч */ })
  }
}

export function registerProviderIPC(store: Store): void {

  // ── Auto-seed OpenCode Zen Free ────────────────────────────────────────────
  // Анонимный провайдер (без ключа) — готов «из коробки». Idempotent: если
  // уже есть в store (вкл. если юзер выключил) — не трогаем.
  {
    const list = store.get('providers', []) as Provider[]
    if (!list.find(p => p.id === 'opencode-free')) {
      list.push({
        id: 'opencode-free',
        type: 'opencode-free',
        name: 'OpenCode Zen Free',
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKey: 'public',
        enabled: true,
        isCustom: false,
        anonymous: true,
      } as Provider)
      store.set('providers', list)
    }
  }

  // ── Auto-seed OpenRouter (disabled — юзер включает и вводит ключ сам) ──────
  // Появляется в списке провайдеров, но не активен пока юзер не добавит ключ.
  // Idempotent: если уже есть — не трогаем.
  {
    const list = store.get('providers', []) as Provider[]
    if (!list.find(p => p.id === 'openrouter')) {
      list.push({
        id: 'openrouter',
        type: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        enabled: false,
        isCustom: false,
      } as Provider)
      store.set('providers', list)
    }
  }

  // Keep the built-in route on the same host as desktop authentication.
  {
    const list = store.get('providers', []) as Provider[]
    const baseUrl = `${getGatewayApiUrl()}/v1`
    const existing = list.findIndex(p => p.id === GATEWAY_PROVIDER_ID)
    if (existing < 0) {
      list.push({
        id: GATEWAY_PROVIDER_ID,
        type: 'syntee-gateway',
        name: 'Syntee Gateway',
        baseUrl,
        apiKey: '',
        enabled: true,           // включён всегда — доступен когда юзер залогинен
        isCustom: false,
        anonymous: undefined,
      } as Provider)
      store.set('providers', list)
    } else if (list[existing].baseUrl !== baseUrl || !list[existing].enabled) {
      list[existing] = { ...list[existing], baseUrl, enabled: true }
      store.set('providers', list)
    }
  }

  // ── Миграция мёртвых opencode-моделей в назначениях ──────────────────────
  // north-mini-code-free / laguna-s-2.1-free / ling-3.0-flash-free удалены
  // с Zen — назначения на них падали «ошибкой сети». Заменяем на живые.
  migrateDeadOpencodeAssignments(store)

  // ── Round-robin helper (экспортируем для AIClient) ─────────────────────────
  // Возвращает следующий ключ для провайдера и сохраняет индекс в store
  // Вызывается из AIClient перед каждым запросом

  // ── Providers ─────────────────────────────────────────────────────────────

  ipcMain.handle('providers:getAll', () => store.get('providers', []) as Provider[])

  ipcMain.handle('providers:save', (_e, provider: Provider) => {
    const list = store.get('providers', []) as Provider[]
    const idx = list.findIndex(p => p.id === provider.id)
    if (idx >= 0) list[idx] = provider
    else list.push(provider)
    store.set('providers', list)
  })

  ipcMain.handle('providers:delete', (_e, id: string) => {
    const list = (store.get('providers', []) as Provider[]).filter(p => p.id !== id)
    store.set('providers', list)
    // Удаляем все модели этого провайдера: кастомные и закэшированные.
    // Ранее cachedModels не фильтровались — модели удалённого провайдера
    // оставались в models:getAll и показывались в UI как «висячие».
    const custom = (store.get('customModels', []) as ModelMeta[]).filter(m => m.providerId !== id)
    store.set('customModels', custom)
    const cached = (store.get('cachedModels', []) as ModelMeta[]).filter(m => m.providerId !== id)
    store.set('cachedModels', cached)
  })

  ipcMain.handle('providers:testKey', async (_e, providerId: string, draft?: Provider) => {
    const list = store.get('providers', []) as Provider[]
    const provider = draft?.id === providerId ? draft : list.find(p => p.id === providerId)
    if (!provider) return { ok: false, error: 'Провайдер не найден' }
    try {
      const url = provider.baseUrl.replace(/\/$/, '') + (provider.modelsEndpoint || '/models')
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'x-api-key': provider.apiKey,
          // Zen-провайдерам — cli-заголовки (иначе анонимные rate-лимиты)
          ...(isOpencodeProvider(provider.id, provider.type) ? getOpencodeZenHeaders() : {}),
        },
      })
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('providers:fetchModels', async (_e, providerId: string) => {
    return fetchProviderModels(store, providerId)
  })

  // ── Models ─────────────────────────────────────────────────────────────────

  ipcMain.handle('models:getAll', () => {
    const providers = store.get('providers', []) as Provider[]
    const custom = store.get('customModels', []) as ModelMeta[]
    const cached = store.get('cachedModels', []) as ModelMeta[]

    // Если провайдеры ещё не настроены — показываем все встроенные
    // Если настроены — только для тех у которых есть ключ (enabled)
    const enabledIds = providers.filter(p => p.enabled).map(p => p.id)
  const builtin = enabledIds.length > 0
    ? BUILTIN_MODELS.filter(m => enabledIds.includes(m.providerId))
    : BUILTIN_MODELS

  // ── OpenCode: live-кэш авторитетнее builtin ──────────────────────────────
  // Zen ротирует free-модели; builtin — лишь pre-seed до первого фетча.
  // Если для opencode-провайдера есть закэшированный список (fetchModels /
  // авто-обновление), builtin-модели этого провайдера, которых нет в кэше,
  // скрываем — иначе в пикере висят мёртвые модели с ошибкой при выборе.
  const opencodeCachedIds = new Map<string, Set<string>>()
  for (const m of cached) {
    if (!isOpencodeProvider(m.providerId)) continue
    let s = opencodeCachedIds.get(m.providerId)
    if (!s) { s = new Set(); opencodeCachedIds.set(m.providerId, s) }
    s.add(m.id)
  }
  const builtinFresh = builtin.filter(m =>
    !isOpencodeProvider(m.providerId)
    || !opencodeCachedIds.has(m.providerId)
    || opencodeCachedIds.get(m.providerId)!.has(m.id),
  )

  const all = builtinFresh.filter(model => model.providerId !== GATEWAY_PROVIDER_ID)

    // Cached/custom модели. Дозаполняем статы из каталога models.dev «на лету»:
    // каталог мог расшириться после сохранения модели (новые capabilities,
    // цены, описания). Триггер — хоть один пробел в данных модели.
    for (const m of [...cached, ...custom]) {
      if (m.providerId === GATEWAY_PROVIDER_ID) continue
      if (all.find(x => x.id === m.id && x.providerId === m.providerId)) continue
      const needsEnrich = m.capabilities.length === 0 || !m.description
        || m.inputPrice === undefined || m.contextWindow === 0
      if (needsEnrich) {
        const fromCatalog = getCatalogModelCached(m.providerId, m.id)
        if (fromCatalog) {
          all.push({
            ...m,
            name: m.name === m.id ? (fromCatalog.displayName ?? m.name) : m.name,
            contextWindow: m.contextWindow || fromCatalog.contextWindow,
            // Цена — только известная (hasPricing); своя цена приоритетнее.
            inputPrice: m.inputPrice ?? (fromCatalog.hasPricing ? fromCatalog.inputPricePerM / 100 : undefined),
            outputPrice: m.outputPrice ?? (fromCatalog.hasPricing ? fromCatalog.outputPricePerM / 100 : undefined),
            // Union capabilities: свои + свежие из каталога (без дублей).
            capabilities: [...new Set([...m.capabilities, ...(fromCatalog.capabilities ?? [])])],
            description: m.description || (fromCatalog.description ?? ''),
          })
          continue
        }
      }
      all.push(m)
    }

    for (const p of providers) {
      if (p.id === GATEWAY_PROVIDER_ID) continue
      for (const id of (p.modelsOverride || [])) {
        if (!all.find(x => x.id === id && x.providerId === p.id)) {
          const fromCatalog = getCatalogModelCached(p.id, id)
          all.push({
            id, providerId: p.id,
            name: fromCatalog?.displayName ?? id,
            contextWindow: fromCatalog?.contextWindow ?? 0,
            // Цена — только если models.dev реально отдал cost (hasPricing);
            // иначе undefined = «цена неизвестна» (не путаем с «бесплатно»).
            inputPrice: fromCatalog?.hasPricing ? fromCatalog.inputPricePerM / 100 : undefined,
            outputPrice: fromCatalog?.hasPricing ? fromCatalog.outputPricePerM / 100 : undefined,
            speed: inferSpeed(id),
            capabilities: fromCatalog?.capabilities ?? [],
            description: fromCatalog?.description ?? '',
          })
        }
      }
    }

    // ── Модели Syntee-Gateway (если юзер залогинен) ────────────────────────
    // Берём из кэша, который обновляется отдельным IPC-вызовом из renderer
    // (gateway:fetchModels → setGatewayModelsCache). Это позволяет держать
    // models:getAll синхронным и не блокировать UI на сетевой запрос.
    // Enrichment: gateway отдаёт max_tokens (часто output-лимит), каталог
    // models.dev знает честный contextWindow. Берём max(gateway, catalog) —
    // contextWindow не может быть меньше max_output. Capabilities всегда
    // объединяем (раньше — только при большем contextWindow у каталога,
    // из-за чего фильтры UI теряли vision/tools/reasoning у части моделей).
    const gatewayModels = hasTokens() ? getGatewayModelsCache() : []
    for (const m of gatewayModels) {
      if (!all.find(x => x.id === m.id && x.providerId === m.providerId)) {
        const fromCatalog = getCatalogModelCached(m.providerId, m.id)
        if (fromCatalog) {
          all.push({
            ...m,
            contextWindow: Math.max(m.contextWindow ?? 0, fromCatalog.contextWindow),
            // Цена — только если каталог реально отдал cost; своя цена приоритетнее.
            inputPrice: m.inputPrice ?? (fromCatalog.hasPricing ? fromCatalog.inputPricePerM / 100 : undefined),
            outputPrice: m.outputPrice ?? (fromCatalog.hasPricing ? fromCatalog.outputPricePerM / 100 : undefined),
            capabilities: [...new Set([...m.capabilities, ...(fromCatalog.capabilities ?? [])])],
            description: m.description || (fromCatalog.description ?? ''),
          })
        } else {
          all.push(m)
        }
      }
    }

    // ── Reasoning-спеки из models.dev для всех моделей ─────────────────────
    // reasoning_options — единственный источник уровней мышления для
    // не-gateway моделей (builtin/cached/custom/override/gateway). Без этого
    // ReasoningSelector не видит реальные контролы модели.
    for (let i = 0; i < all.length; i++) {
      const cat = getCatalogModelCached(all[i].providerId, all[i].id)
      // Enrich every source (including builtins and fully populated old caches).
      all[i] = mergeModelMediaMetadata(all[i], cat)
      if (!all[i].reasoningOptions && cat?.reasoningOptions) {
        all[i] = { ...all[i], reasoningOptions: cat.reasoningOptions }
      }
    }

    return all
  })

  ipcMain.handle('models:saveCustom', (_e, model: ModelMeta) => {
    const list = store.get('customModels', []) as ModelMeta[]
    const idx = list.findIndex(m => m.id === model.id && m.providerId === model.providerId)
    if (idx >= 0) list[idx] = { ...model, isCustom: true }
    else list.push({ ...model, isCustom: true })
    store.set('customModels', list)
  })

  ipcMain.handle('models:deleteCustom', (_e, modelId: string, providerId: string) => {
    const list = (store.get('customModels', []) as ModelMeta[])
      .filter(m => !(m.id === modelId && m.providerId === providerId))
    store.set('customModels', list)
  })

  // ── Assignments ────────────────────────────────────────────────────────────

  ipcMain.handle('models:getAssignments', () => {
    return store.get('modelAssignments', DEFAULT_ASSIGNMENTS) as ModelAssignment[]
  })

  ipcMain.handle('models:setAssignment', (_e, assignment: ModelAssignment) => {
    const list = store.get('modelAssignments', DEFAULT_ASSIGNMENTS) as ModelAssignment[]
    const idx = list.findIndex(a => a.role === assignment.role)
    if (idx >= 0) list[idx] = assignment
    else list.push(assignment)
    store.set('modelAssignments', list)
  })

  // ── Params ─────────────────────────────────────────────────────────────────

  ipcMain.handle('models:getParams', () => {
    return store.get('modelParams', DEFAULT_PARAMS) as ModelParams
  })

  ipcMain.handle('models:setParams', (_e, params: Partial<ModelParams>) => {
    const current = store.get('modelParams', DEFAULT_PARAMS) as ModelParams
    store.set('modelParams', { ...current, ...params })
  })

  // ── Recent models (недавно использованные) ─────────────────────────────────

  ipcMain.handle('models:getRecent', (): { modelId: string; providerId: string; usedAt: number }[] => {
    return (store.get('recentModels', []) as { modelId: string; providerId: string; usedAt: number }[]).slice(0, 5)
  })

  ipcMain.handle('models:addRecent', (_e, modelId: string, providerId: string) => {
    const list = store.get('recentModels', []) as { modelId: string; providerId: string; usedAt: number }[]
    // Удаляем дубликаты
    const filtered = list.filter(r => !(r.modelId === modelId && r.providerId === providerId))
    // Добавляем в начало
    filtered.unshift({ modelId, providerId, usedAt: Date.now() })
    // Ограничиваем 5 элементами
    store.set('recentModels', filtered.slice(0, 5))
  })

  // ── Pinned models (закреплённые пользователем) ─────────────────────────────

  ipcMain.handle('models:getPinned', (): { modelId: string; providerId: string }[] => {
    return (store.get('pinnedModels', []) as { modelId: string; providerId: string }[])
  })

  ipcMain.handle('models:togglePin', (_e, modelId: string, providerId: string) => {
    const list = store.get('pinnedModels', []) as { modelId: string; providerId: string }[]
    const idx = list.findIndex(p => p.modelId === modelId && p.providerId === providerId)
    if (idx >= 0) {
      list.splice(idx, 1)
    } else {
      list.push({ modelId, providerId })
    }
    store.set('pinnedModels', list)
    return list
  })

  // ── Авто-обновление списка моделей opencode ────────────────────────────────
  // На старте (через 10с — не конкурируем с инициализацией) + каждые 6ч.
  // Держит пикер актуальным без ручного нажатия «Модели» в настройках.
  setTimeout(() => autoRefreshOpencodeModels(store), 10_000)
  setInterval(() => autoRefreshOpencodeModels(store, true), AUTO_FETCH_INTERVAL_MS)
}
