/**
 * Model Catalog — живой каталог лимитов/цен моделей через models.dev.
 *
 * Фетчит https://models.dev/api.json (бесплатный, без авторизации), кэширует
 * уплощённую карту на диск. При старте main-процесса и worker-потока читает
 * кэш синхронно в память, обновление происходит в фоне (только main).
 *
 * Модуль не зависит от electron — принимает путь к кэш-файлю параметром,
 * чтобы быть доступным из worker_threads.
 *
 * Матчинг: 3 уровня — точный провайдер → vendor-sniff для прокси →
 * глобальный поиск по всем провайдерам с приоритетом каноничных вендоров.
 */

// fs импортируется лениво внутри функций, чтобы renderer-бандл не пытался
// статически резолвить Node-модули (getCatalogModel работает только с in-memory кэшем)

import type { ModelCapability, ModelSpeed, ReasoningOptionSpec } from '../../shared/types'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const ONE_DAY_MS = 86_400_000

export interface CatalogModelInfo {
  contextWindow: number
  maxOutput: number
  inputPricePerM: number   // центы за 1M input токенов (для совместимости с ModelPricing)
  outputPricePerM: number  // центы за 1M output токенов
  cacheReadPerM?: number
  cacheWritePerM?: number
  /** true, если models.dev отдал cost-данные по модели. Отличает «бесплатно»
   *  (цена известна и равна $0) от «цена неизвестна» (cost отсутствует). */
  hasPricing?: boolean
  // Расширенные статы из models.dev:
  displayName?: string               // models.dev: model.name — отображаемое имя
  description?: string               // models.dev: model.description
  capabilities?: ModelCapability[]   // деривится из modalities/reasoning/tool_call
  /** Спеки режимов мышления (models.dev reasoning_options). */
  reasoningOptions?: ReasoningOptionSpec[]
}

interface CachedCatalog {
  fetchedAt: number
  models: Record<string, CatalogModelInfo>  // key: `${providerId}:${modelId}`
}

// ─── In-memory state ──────────────────────────────────────────────────────────

let _cache: CachedCatalog | null = null
let _cachePath: string | null = null
let _lastFetchAt: number | null = null
let _refreshing = false

// ─── Provider remap: наш providerId → models.dev provider key ─────────────────
// null = проксирующий/не-LLM провайдер, нет прямой записи в models.dev
const PROVIDER_REMAP: Record<string, string | null> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  groq: 'groq',
  cerebras: 'cerebras',
  mistral: 'mistral',
  cohere: 'cohere',
  together: 'togetherai',       // models.dev использует 'togetherai', не 'together'
  fireworks: 'fireworks-ai',    // models.dev использует 'fireworks-ai', не 'fireworks'
  deepseek: 'deepseek',
  xai: 'xai',
  xiaomi: 'xiaomi',
  // OpenCode Zen — публичный шлюз opencode.ai/zen, есть в models.dev
  opencode: 'opencode',
  'opencode-free': 'opencode',  // тот же каталог; free-модели тоже там
  'opencode-go': 'opencode-go',
  // проксирующие / не в models.dev — обрабатываются через vendor-sniff + global fallback
  onlysq: null,
  voidai: null,
  bfl: null,
  ollama: null,
  // OpenRouter — агрегатор; модели имеют вид 'vendor/model-name'. Каталог
  // models.dev не имеет записи 'openrouter', но inferProviderFromModelId
  // разрулит vendor по префиксу (например 'inclusionai/...' → null → global).
  openrouter: null,
}

// Каноничные вендоры — приоритет при глобальном поиске (их цены/лимиты самые точные)
const CANONICAL_VENDORS = [
  'openai', 'anthropic', 'google', 'xai', 'deepseek',
  'mistral', 'cohere', 'groq', 'cerebras', 'togetherai', 'fireworks-ai', 'xiaomi',
  'zai', 'zhipuai',
]

// Эвристика vendor-sniff для проксирующих провайдеров (onlysq и т.п.)
function inferProviderFromModelId(modelId: string): string | null {
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return 'anthropic'
  if (id.startsWith('gpt') || id.startsWith('o3') || id.startsWith('o4') || id.startsWith('o1')) return 'openai'
  if (id.includes('gemini') || id.includes('gemma')) return 'google'
  if (id.includes('grok')) return 'xai'
  if (id.includes('deepseek')) return 'deepseek'
  if (id.includes('mimo')) return 'xiaomi'
  if (id.includes('glm')) return 'zai'
  if (id.includes('qwen')) return 'togetherai'
  if (id.includes('llama')) return 'togetherai'
  if (id.includes('mistral') || id.includes('mixtral') || id.includes('codestral')) return 'mistral'
  if (id.includes('gemma')) return 'google'
  if (id.includes('kimi')) return 'togetherai'
  if (id.includes('minimax')) return 'minimax'
  return null
}

// Нормализация model id для матчинга (lowercase, срез после /, срез суффиксов даты,
// срез trailing контекст-размеров вроде -32768)
function normalizeModelId(id: string): string {
  let s = id.toLowerCase()
  // slash-пути (Together/Fireworks) — берём последнюю часть
  const slashIdx = s.lastIndexOf('/')
  if (slashIdx >= 0) s = s.slice(slashIdx + 1)
  // срезаем суффиксы даты вроде -20241022
  s = s.replace(/-\d{8}$/, '')
  // срезаем trailing контекст-размеры (Groq: mixtral-8x7b-32768 → mixtral-8x7b)
  s = s.replace(/-\d{4,}$/, '')
  return s
}

/**
 * Loose-матчинг id моделей с защитой от версионных бампов.
 *
 * Разрешён только префикс-матчинг, где остаток начинается с '-' — это
 * суффикс-варианты одной модели ('qwen2.5-72b-instruct' → '…-turbo',
 * 'deepseek-v4-flash' → '…-free', 'mixtral-8x7b' → '…-32768').
 *
 * Запрещено:
 *  - остаток, начинающийся с '.' — версионный бамп ('glm-5' → 'glm-5.3'):
 *    у новой версии контекст/цены могут отличаться радикально (баг:
 *    glm-5.3 получал contextWindow 204800 от zai:glm-5 вместо 1M);
 *  - срединные includes-матчи ('abc' внутри 'x-abc-y') — слишком шумные.
 */
function isVariantMatch(normA: string, normB: string): boolean {
  if (normA === normB) return true
  const [short, long] = normA.length < normB.length ? [normA, normB] : [normB, normA]
  return long.startsWith(short) && long.slice(short.length).startsWith('-')
}

/**
 * Эвристический вывод скорости модели по id — models.dev не отдаёт speed.
 * Используется для не-builtin моделей, у которых нет hand-curated статов.
 */
export function inferSpeed(modelId: string): ModelSpeed {
  const id = modelId.toLowerCase()
  if (/(flash|mini|haiku|schnell|instant|fast|small|nano|tiny|8b|7b)/.test(id)) return 'fast'
  if (/(opus|pro|max|o3-|reason|ultra|large)/.test(id) && !/(flash|mini|haiku)/.test(id)) return 'slow'
  return 'medium'
}

// ─── Инициализация (читает диск-кэш синхронно) ────────────────────────────────

export function initModelCatalog(cachePath: string): void {
  _cachePath = cachePath
  try {
    const { existsSync, readFileSync } = require('fs') as typeof import('fs')
    if (existsSync(cachePath)) {
      const raw = readFileSync(cachePath, 'utf-8')
      const parsed = JSON.parse(raw) as CachedCatalog
      if (parsed && parsed.models && typeof parsed.fetchedAt === 'number') {
        _cache = parsed
        _lastFetchAt = parsed.fetchedAt
      }
    }
  } catch {
    // битый кэш — не критично, работаем без него
    _cache = null
  }
}

// ─── Основной lookup ───────────────────────────────────────────────────────────

export function getCatalogModel(providerId: string, modelId: string): CatalogModelInfo | null {
  if (!_cache) return null

  // 1. Прямой провайдер (если замапплен в models.dev)
  const providerKey = PROVIDER_REMAP[providerId]
  if (providerKey) {
    const hit = lookupInProvider(providerKey, modelId)
    if (hit) return hit
  }

  // 2. Проксирующий провайдер — vendor-sniff по modelId
  if (providerKey === null || providerKey === undefined) {
    const inferred = inferProviderFromModelId(modelId)
    if (inferred) {
      const hit = lookupInProvider(inferred, modelId)
      if (hit) return hit
    }
  }

  // 3. Глобальный fallback — ищем по ВСЕМ провайдерам
  //    Предпочитаем каноничных вендоров (openai, anthropic, google...)
  //    Это ловит любые модели, которые проксируются под чужими именами
  return globalSearch(modelId)
}

function lookupInProvider(providerKey: string, modelId: string): CatalogModelInfo | null {
  if (!_cache) return null

  // Точное совпадение
  const exactKey = `${providerKey}:${modelId}`
  if (_cache.models[exactKey]) return _cache.models[exactKey]

  // Нормализованное совпадение
  const normId = normalizeModelId(modelId)
  const normKey = `${providerKey}:${normId}`
  if (_cache.models[normKey]) return _cache.models[normKey]

  // Variant fallback в рамках того же провайдера — префикс + '-'-суффикс,
  // версионные бампы ('glm-5.3' → 'glm-5') не матчятся (см. isVariantMatch)
  const prefix = `${providerKey}:`
  for (const [key, val] of Object.entries(_cache.models)) {
    if (!key.startsWith(prefix)) continue
    const catalogModelId = key.slice(prefix.length)
    const normCatalog = normalizeModelId(catalogModelId)
    if (isVariantMatch(normCatalog, normId)) {
      return val
    }
  }

  return null
}

/**
 * Глобальный поиск модели по всем провайдерам в каталоге.
 * Возвращает лучшее совпадение, предпочитая каноничных вендоров.
 * 3 уровня: точное совпадение → нормализованное → substring (для вариантов имён).
 */
function globalSearch(modelId: string): CatalogModelInfo | null {
  if (!_cache) return null

  const normId = normalizeModelId(modelId)

  // Собираем совпадения по уровням
  const exactMatches: Array<{ providerKey: string; info: CatalogModelInfo }> = []
  const normMatches: Array<{ providerKey: string; info: CatalogModelInfo }> = []
  const substringMatches: Array<{ providerKey: string; info: CatalogModelInfo }> = []

  for (const [key, val] of Object.entries(_cache.models)) {
    const colonIdx = key.indexOf(':')
    if (colonIdx < 0) continue
    const provKey = key.slice(0, colonIdx)
    const catalogModelId = key.slice(colonIdx + 1)
    const normCatalog = normalizeModelId(catalogModelId)

    if (catalogModelId === modelId) {
      exactMatches.push({ providerKey: provKey, info: val })
    } else if (normCatalog === normId) {
      normMatches.push({ providerKey: provKey, info: val })
    } else if (isVariantMatch(normCatalog, normId)) {
      // Variant fallback — ловит суффикс-варианты имён вроде
      // 'Qwen2.5-72B-Instruct-Turbo' → 'Qwen2.5-72B-Instruct'
      // 'mixtral-8x7b-32768' → 'mixtral-8x7b'
      // Версионные бампы ('glm-5.3' → 'glm-5') не матчятся (см. isVariantMatch)
      substringMatches.push({ providerKey: provKey, info: val })
    }
  }

  // Приоритет: точное → нормализованное → substring
  for (const candidates of [exactMatches, normMatches, substringMatches]) {
    if (candidates.length === 0) continue
    // Если есть совпадение у каноничного вендора — возвращаем его
    for (const vendor of CANONICAL_VENDORS) {
      const hit = candidates.find(c => c.providerKey === vendor)
      if (hit) return hit.info
    }
    // Иначе — первое попавшееся
    return candidates[0].info
  }

  return null
}

/**
 * Нормализация reasoning_options из models.dev в ReasoningOptionSpec[].
 * undefined → спек нет (модель не reasoning или данные отсутствуют);
 * [] (пустой массив) → модель reasoning, но управлять мышлением нельзя.
 */
function normalizeReasoningOptions(
  raw: ModelsDevModel['reasoning_options'],
): ReasoningOptionSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ReasoningOptionSpec[] = []
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue
    if (o.type === 'effort' && Array.isArray(o.values) && o.values.length > 0) {
      out.push({ type: 'effort', values: o.values.map(String).filter(Boolean) })
    } else if (o.type === 'toggle') {
      out.push({ type: 'toggle' })
    } else if (o.type === 'budget_tokens') {
      out.push({
        type: 'budget_tokens',
        min: typeof o.min === 'number' ? o.min : undefined,
        max: typeof o.max === 'number' ? o.max : undefined,
      })
    }
  }
  return out
}

// ─── Деривация capabilities из сырых полей models.dev ─────────────────────────

interface ModelsDevModel {
  name?: string
  description?: string
  reasoning?: boolean
  reasoning_options?: Array<{ type?: string; values?: unknown; min?: unknown; max?: unknown }>
  tool_call?: boolean
  attachment?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

/**
 * Деривация capabilities из полей models.dev.
 * modalities.input: text/image/audio/video/pdf; output: text/image/video/audio/pdf
 * (проверено по живому api.json — отдельной модальности 'embeddings' нет,
 * embedding-модели определяем по имени, как и code — models.dev не отдаёт
 * для них флагов, а для фильтров в UI теги нужны).
 */
function deriveCapabilities(modelId: string, model: ModelsDevModel): ModelCapability[] {
  const caps = new Set<ModelCapability>()
  const input = model.modalities?.input ?? []
  const output = model.modalities?.output ?? []

  if (input.includes('image') || input.includes('video') || input.includes('pdf') || model.attachment) caps.add('vision')
  if (input.includes('audio')) caps.add('stt')
  if (output.includes('audio')) caps.add('tts')
  if (output.includes('image')) caps.add('image_gen')
  if (model.reasoning) caps.add('reasoning')
  if (model.tool_call) caps.add('tools')
  if (/\bembed|embed-/i.test(modelId)) caps.add('embedding')
  if (/(code|codestral|coder|codex|starcoder|devstral)/i.test(modelId)) caps.add('code')

  return [...caps]
}

// ─── Фоновое обновление (только main-процесс) ─────────────────────────────────

export async function refreshCatalog(cachePath?: string, force?: boolean): Promise<{ ok: boolean; error?: string; modelCount: number }> {
  const path = cachePath ?? _cachePath
  if (!path) return { ok: false, error: 'No cache path set', modelCount: 0 }
  _cachePath = path

  if (_refreshing && !force) {
    return { ok: true, modelCount: _cache?.models ? Object.keys(_cache.models).length : 0 }
  }
  _refreshing = true

  try {
    const res = await fetch(MODELS_DEV_URL)
    if (!res.ok) {
      _refreshing = false
      return { ok: false, error: `HTTP ${res.status}`, modelCount: 0 }
    }

    const data = await res.json() as Record<string, { models?: Record<string, ModelsDevModel> }>

    const flattened: Record<string, CatalogModelInfo> = {}

    for (const [provKey, prov] of Object.entries(data)) {
      if (!prov.models) continue
      for (const [modelKey, model] of Object.entries(prov.models)) {
        const ctx = model.limit?.context ?? 0
        const out = model.limit?.output ?? 0
        // models.dev цены в $ за 1M токенов → переводим в центы за 1M (×100).
        // hasPricing — models.dev отдал cost-поле (даже нулевое → модель
        // бесплатна). Без него «бесплатно» и «цена неизвестна» неотличимы.
        const hasPricing = model.cost != null && (model.cost.input != null || model.cost.output != null)
        const inputCents = model.cost?.input != null ? Math.round(model.cost.input * 100) : 0
        const outputCents = model.cost?.output != null ? Math.round(model.cost.output * 100) : 0
        // Пропускаем записи вообще без полезных данных (нет ни лимитов, ни цен).
        if (ctx === 0 && !hasPricing) continue

        const caps = deriveCapabilities(modelKey, model)

        flattened[`${provKey}:${modelKey}`] = {
          contextWindow: ctx,
          maxOutput: out,
          inputPricePerM: inputCents,
          outputPricePerM: outputCents,
          hasPricing,
          cacheReadPerM: model.cost?.cache_read != null ? Math.round(model.cost.cache_read * 100) : undefined,
          cacheWritePerM: model.cost?.cache_write != null ? Math.round(model.cost.cache_write * 100) : undefined,
          displayName: model.name,
          description: model.description,
          capabilities: caps,
          reasoningOptions: normalizeReasoningOptions(model.reasoning_options),
        }
      }
    }

    const newCache: CachedCatalog = {
      fetchedAt: Date.now(),
      models: flattened,
    }

    // Записываем на диск
    try {
      const { writeFileSync } = require('fs') as typeof import('fs')
      writeFileSync(path, JSON.stringify(newCache), 'utf-8')
    } catch {
      // диск недоступен — обновляем только память
    }

    _cache = newCache
    _lastFetchAt = newCache.fetchedAt
    _refreshing = false

    return { ok: true, modelCount: Object.keys(flattened).length }
  } catch (e: unknown) {
    _refreshing = false
    return { ok: false, error: e instanceof Error ? e.message : String(e), modelCount: 0 }
  }
}

export function getCatalogStatus(): { lastFetch: number | null; modelCount: number; stale: boolean } {
  return {
    lastFetch: _lastFetchAt,
    modelCount: _cache?.models ? Object.keys(_cache.models).length : 0,
    stale: _lastFetchAt != null ? (Date.now() - _lastFetchAt) > ONE_DAY_MS : true,
  }
}

/** true если каталог инициализирован и непустой */
export function isCatalogReady(): boolean {
  return _cache != null && Object.keys(_cache.models).length > 0
}
