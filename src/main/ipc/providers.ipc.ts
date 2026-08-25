import { ipcMain } from 'electron'
import type Store from 'electron-store'
import type { Provider, ModelMeta, ModelAssignment, ModelParams } from '../../shared/types'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { getCatalogModel, inferSpeed, getCatalogStatus, type CatalogModelInfo } from '../../core/tokens/modelCatalog'
import { getGatewayModelsCache } from '../../core/tokens/gatewayModelsCache'
import { getOpencodeZenHeaders, isOpencodeProvider } from '../../shared/constants'

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
  { role: 'fast',      modelId: 'north-mini-code-free', providerId: 'opencode-free' },
  { role: 'fastContext', modelId: 'inclusionai/ling-3.0-flash:free', providerId: 'openrouter' },
  { role: 'vision',    modelId: 'gpt-4o',             providerId: 'openai' },
  { role: 'stt',       modelId: '',                   providerId: '' },
  { role: 'tts',       modelId: '',                   providerId: '' },
  { role: 'embedding', modelId: '',                   providerId: '' },
  { role: 'memory',    modelId: 'claude-haiku-4-5',   providerId: 'anthropic' },
  { role: 'summary',   modelId: 'claude-haiku-4-5',   providerId: 'anthropic' },
]

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

  // ── Auto-seed Syntee-Gateway (disabled — активируется после входа) ────────
  // baseUrl пустой на старте; при каждом getAll обновляем его из env-переменной
  // SYNTEE_API_URL (см. providers:getAll ниже). JWT-авторизация обрабатывается
  // в AIClient.getClientForRoleAsync — apiKey тут не используется.
  {
    const list = store.get('providers', []) as Provider[]
    if (!list.find(p => p.id === 'syntee-gateway')) {
      list.push({
        id: 'syntee-gateway',
        type: 'syntee-gateway',
        name: 'Syntee Gateway',
        baseUrl: '',
        apiKey: '',
        enabled: true,           // включён всегда — доступен когда юзер залогинен
        isCustom: false,
        anonymous: undefined,
      } as Provider)
      store.set('providers', list)
    }
  }

  // ── Round-robin helper (экспортируем для AIClient) ─────────────────────────
  // Возвращает следующий ключ для провайдера и сохраняет индекс в store
  // Вызывается из AIClient перед каждым запросом

  // ── Providers ─────────────────────────────────────────────────────────────

  ipcMain.handle('providers:getAll', () => {
    const list = store.get('providers', []) as Provider[]
    // Обновляем baseUrl gateway-провайдера из env (может поменяться при запуске
    // через run-debug.bat или run-prod.bat).
    const gwIdx = list.findIndex(p => p.id === 'syntee-gateway')
    if (gwIdx >= 0) {
      const envUrl = (process.env.SYNTEE_API_URL ?? '').replace(/\/$/, '')
      if (envUrl && list[gwIdx].baseUrl !== `${envUrl}/v1`) {
        list[gwIdx] = { ...list[gwIdx], baseUrl: `${envUrl}/v1` }
        store.set('providers', list)
      }
    }
    return list
  })

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

  ipcMain.handle('providers:testKey', async (_e, providerId: string) => {
    const list = store.get('providers', []) as Provider[]
    const provider = list.find(p => p.id === providerId)
    if (!provider) return { ok: false, error: 'Провайдер не найден' }
    try {
      const res = await fetch(`${provider.baseUrl}/models`, {
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
    const list = store.get('providers', []) as Provider[]
    const provider = list.find(p => p.id === providerId)
    if (!provider) return { ok: false, error: 'Провайдер не найден', models: [] }

    let fetched: ModelMeta[] = []
    let error: string | null = null

    try {
      const url = provider.baseUrl.replace(/\/$/, '') + (provider.modelsEndpoint || '/models')
      const res = await fetch(url, {
        headers: {
          // Анонимные провайдеры (opencode-free) шлют apiKey 'public' → Bearer public.
          // Если apiKey пуст — fallback на 'public' (как делает opencode CLI).
          'Authorization': `Bearer ${provider.apiKey || 'public'}`,
          'Content-Type': 'application/json',
          // Zen-провайдерам — cli-заголовки (иначе анонимные rate-лимиты)
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
        // Live-endpoint /zen/v1/models возвращает все id; дискриминатор free — суффикс -free.
        if (provider.id === 'opencode-free') {
          ids = ids.filter(id => id.endsWith('-free'))
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

        // Обновляем timestamp провайдера
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
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
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

    return { ok: !error, error, models: fetched, count: fetched.length }
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

    const all = [...builtin]

    // Cached/custom модели. Дозаполняем статы из каталога models.dev «на лету»:
    // каталог мог расшириться после сохранения модели (новые capabilities,
    // цены, описания). Триггер — хоть один пробел в данных модели.
    for (const m of [...cached, ...custom]) {
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
    // contextWindow не может быть меньше max_output.
    const gatewayModels = getGatewayModelsCache()
    for (const m of gatewayModels) {
      if (!all.find(x => x.id === m.id && x.providerId === m.providerId)) {
        const fromCatalog = getCatalogModelCached(m.providerId, m.id)
        if (fromCatalog && fromCatalog.contextWindow > (m.contextWindow ?? 0)) {
          all.push({
            ...m,
            contextWindow: fromCatalog.contextWindow,
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
}
