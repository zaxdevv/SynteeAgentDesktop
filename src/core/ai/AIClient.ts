import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type Store from 'electron-store'
// СТАТИЧЕСКИЙ импорт: динамический import() в worker-потоке main-процесса
// требует importModuleDynamically в vm-контексте и падает с
// "A dynamic import callback was not specified". require — безопасен.
import { isMainThread, workerData } from 'worker_threads'
import { buildReasoningParams, responsesReasoningParam } from '../../shared/reasoningModels'
import { getGatewayModelsCache } from '../tokens/gatewayModelsCache'
import { getCatalogModel } from '../tokens/modelCatalog'
import { getNextApiKey } from '../../shared/roundRobin'
import { getIdentityHeaders, getOpencodeZenHeaders, isOpencodeProvider } from '../../shared/constants'
import type { Provider, ModelParams, ReasoningOptionSpec, ModelMeta } from '../../shared/types'
import { isAnthropicProvider } from './anthropicConverters'
import { log, sleep, backoffDelay, OVERALL_TIMEOUT_MS, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, extractReasoningText } from './shared'
import { chatWithToolsAnthropic } from './anthropicNative'
import { routeToolImagesToUser, summarizeImagePayload } from './toolImageMessages'
import { repairToolCallHistory } from './toolCallHistory'
import { calibrationKey, computeContextSnapshot, getModelPriceInfo } from '../tokens/usageTracker'
import type { ContextCountedInfo } from '../agent/types'
import { resolveMediaTransport, requestMediaAnalysis, type AuxiliaryMediaInput, type MediaKind } from './mediaSupport'
import { observeAIRequest, cacheReadTokensOf, cacheWriteTokensOf, type AIUsageContext } from './requestUsage'
import type { RealUsage } from '../tokens/usageTracker'
import { randomUUID } from 'node:crypto'

// ── Gateway token holder + refresher (ретрай на 401) ────────────────────────
// Worker thread не может импортировать gatewayClient/tokenStore (electron-store
// делает require('electron'), которого нет в worker). Токен приходит через
// workerData при старте воркера; если он протух ПОСРЕДИ длинного агент-рана —
// worker запрашивает свежий у main-процесса через зарегистрированный refresher
// (ai-worker.ts: postMessage round-trip 'gateway_token_refresh').
// В main-процессе refresher не нужен — токен обновляется напрямую через
// dynamic import gatewayClient.forceRefreshGatewayToken.
let gatewayTokenOverride: string | null = null
let gatewayTokenRefresher: (() => Promise<string | null>) | null = null

/** Обновить gateway-токен в текущем процессе (вызывается после успешного refresh). */
export function setGatewayToken(token: string | null): void {
  gatewayTokenOverride = token
}

/** Зарегистрировать refresher для worker thread (из ai-worker.ts). */
export function setGatewayTokenRefresher(fn: (() => Promise<string | null>) | null): void {
  gatewayTokenRefresher = fn
}

/** Текущий gateway-токен в worker: override (после refresh) приоритетнее workerData. */
function getWorkerGatewayToken(): string | null {
  return gatewayTokenOverride
    ?? ((workerData as Record<string, unknown> | undefined)?.gatewayToken as string | null)
}

/**
 * Форс-refresh gateway-токена после 401. Main thread — напрямую через
 * gatewayClient (там singleton refreshPromise сливает параллельные рефреши),
 * worker — через зарегистрированный refresher (round-trip в main).
 * При успехе обновляет override. Null — сессия мертва (refresh-токен протух).
 */
async function refreshGatewayTokenAfter401(): Promise<string | null> {
  if (!isMainThread) {
    try {
      const fresh = (await gatewayTokenRefresher?.()) ?? null
      if (fresh) gatewayTokenOverride = fresh
      return fresh
    } catch {
      return null
    }
  }
  try {
    const { forceRefreshGatewayToken } = await import('../../main/services/gatewayClient')
    const fresh = await forceRefreshGatewayToken()
    if (fresh) gatewayTokenOverride = fresh
    return fresh
  } catch {
    return null
  }
}

// ── ChatGPT-подписка (Codex) ───────────────────────────────────────────────
// API-ключа нет: авторизация идёт OAuth-токеном, который обновляется по exp.
// В main-процессе токен берётся из codexAuth (с авто-refresh), в worker —
// из workerData.codexToken (обновлённый override приоритетнее).
let codexTokenOverride: string | null = null
let codexTokenRefresher: (() => Promise<string | null>) | null = null

/** Обновить Codex-токен в текущем процессе (после refresh или входа). */
export function setCodexToken(token: string | null): void {
  codexTokenOverride = token
}

/** Зарегистрировать refresher для worker thread (из ai-worker.ts). */
export function setCodexTokenRefresher(fn: (() => Promise<string | null>) | null): void {
  codexTokenRefresher = fn
}

function getWorkerCodexToken(): string | null {
  return codexTokenOverride
    ?? ((workerData as Record<string, unknown> | undefined)?.codexToken as string | null)
}

function getCodexAccountIdFromWorker(): string | null {
  return (workerData as Record<string, unknown> | undefined)?.codexAccountId as string | null ?? null
}

/**
 * Форс-refresh Codex-токена после 401. Main thread — напрямую через codexAuth
 * (там singleton refreshPromise), worker — round-trip в main через refresher.
 */
async function refreshCodexTokenAfter401(): Promise<string | null> {
  if (!isMainThread) {
    try {
      const fresh = (await codexTokenRefresher?.()) ?? null
      if (fresh) codexTokenOverride = fresh
      return fresh
    } catch {
      return null
    }
  }
  try {
    const { forceRefreshCodexToken } = await import('../../main/services/codexAuth')
    const fresh = await forceRefreshCodexToken()
    if (fresh) codexTokenOverride = fresh
    return fresh
  } catch {
    return null
  }
}

/** Маркер в apiKey провайдера: «токен берётся из ChatGPT-авторизации». */
const CODEX_KEY_MARKER = '__CODEX__'

/**
 * Заголовки бэкенда ChatGPT для Codex-запросов (всё, кроме Authorization —
 * его SDK ставит из apiKey). Дублирует codexAuth.getCodexHeaders, но без
 * зависимостей от electron — чтобы работать и в worker-потоке.
 */
function codexHeaders(accountId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental',
    'session_id': randomUUID().replace(/-/g, ''),
  }
  if (accountId) headers['chatgpt-account-id'] = accountId
  return headers
}

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: (fullText: string) => void
  onError: (error: Error) => void
  onRateLimit?: (waitSec: number) => void
  onThinkingToken?: (token: string) => void
  onThinkingDone?: (ms: number) => void
  onUsage?: (usage: RealUsage & { totalTokens: number }) => void
  onContextCounted?: (info: ContextCountedInfo) => void
  onWaiting?: () => void                                      // запрос ушёл, ждём первый токен
  onRetry?: (attempt: number, reason: string, waitSec?: number, maxAttempts?: number) => void  // ретрай с причиной + лимит для UI «повтор 3/5»
}

type StreamUsage = RealUsage & { totalTokens: number }

function mergeCompletionUsage(usage: unknown, previous: StreamUsage | null): StreamUsage | null {
  if (!usage || typeof usage !== 'object') return previous
  const packet = usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  const promptTokens = packet.prompt_tokens ?? previous?.promptTokens
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens < 0) return previous
  const completionTokens = packet.completion_tokens ?? previous?.completionTokens ?? 0
  return {
    promptTokens,
    completionTokens,
    totalTokens: packet.total_tokens ?? promptTokens + completionTokens,
    cacheReadTokens: cacheReadTokensOf(packet) ?? previous?.cacheReadTokens,
    cacheWriteTokens: cacheWriteTokensOf(packet) ?? previous?.cacheWriteTokens,
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * §orchestration — явная модель/провайдер/effort для ОДНОГО вызова.
 *
 * Нужен фазовому рану: planning/reviewing идут на одной модели, executing — на
 * другой. Никакого неявного fallback: если providerId задан и недоступен,
 * chatWithTools бросает ошибку, а не подставляет провайдера роли.
 */
export interface ModelOverride {
  providerId?: string
  modelId?: string
  reasoningValue?: string
}

type ChatUsage = RealUsage & { totalTokens: number }

function mergeChatUsage(previous: ChatUsage | null, packet: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}): ChatUsage | null {
  const promptTokens = packet.prompt_tokens ?? previous?.promptTokens
  if (promptTokens == null) return previous
  const completionTokens = packet.completion_tokens ?? previous?.completionTokens ?? 0
  return {
    promptTokens,
    completionTokens,
    totalTokens: packet.total_tokens ?? promptTokens + completionTokens,
    cacheReadTokens: cacheReadTokensOf(packet) ?? previous?.cacheReadTokens,
    cacheWriteTokens: cacheWriteTokensOf(packet) ?? previous?.cacheWriteTokens,
  }
}

export class AIClient {
  private client: OpenAI
  private maxRetries = 6

  constructor(private store: Store, private usageContext: AIUsageContext = {}) {
    this.client = this.createClient()
  }

  /** Wrap only SDK request creation; existing streaming/UI callbacks stay intact. */
  private observeClient<T>(client: T, providerId: string, source: string, anthropic = false): T {
    // SDK create overloads return APIPromise/Stream; our call sites await them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = client as any
    // OpenRouter reports USD-denominated credit usage in usage.cost. Compatible
    // custom APIs can use the same field with different billing semantics.
    let reportsUsdCost = false
    if (typeof sdk.baseURL === 'string') {
      try {
        const url = new URL(sdk.baseURL)
        reportsUsdCost = url.protocol === 'https:' && ['openrouter.ai', 'eu.openrouter.ai', 'us.openrouter.ai'].includes(url.host)
          && /^\/api\/v1\/?$/.test(url.pathname)
      } catch { /* unknown URL or transport */ }
    }
    const wrap = (resource: { create: (...args: unknown[]) => unknown }, api: 'openai' | 'responses' | 'anthropic' | 'embedding'): void => {
      const original = resource.create.bind(resource)
      resource.create = (...args: unknown[]) => {
        const params = args[0] as { model?: string } | undefined
        return observeAIRequest(() => original(...args) as PromiseLike<unknown>, {
          providerId, modelId: params?.model ?? '', source, reportsUsdCost,
          pricing: getModelPriceInfo(providerId, params?.model ?? '', this.store.get('customModels', []) as ModelMeta[]),
        }, this.usageContext, api)
      }
    }
    if (anthropic) wrap(sdk.messages, 'anthropic')
    else { wrap(sdk.chat.completions, 'openai'); wrap(sdk.responses, 'responses'); wrap(sdk.embeddings, 'embedding') }
    return client
  }

  private createClient(): OpenAI {
    const apiKey = (this.store.get('apiKey') as string) || '***'
    // Только явный URL из настроек. OnlySQ-дефолт удалён — модели идут через
    // мульти-провайдерную систему. Если endpoint пуст, клиент всё равно
    // создаётся (для совместимости), но запросы без назначения упадут.
    const endpoint = (this.store.get('apiEndpoint') as string) || ''
    return this.observeClient(new OpenAI({ apiKey, baseURL: endpoint || undefined, defaultHeaders: this.identityHeaders() }), '', 'default')
  }

  reload(): void {
    this.client = this.createClient()
  }

  /** Prefer the actual chat/run model when its native media API is confirmed; auxiliary assignment is fallback. */
  private mediaAssignment(kind: MediaKind, modelRole: 'main' | 'subagent' = 'main') {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const providers = this.store.get('providers', []) as Provider[]
    const primaryRole = modelRole === 'subagent' ? 'subagent' : 'main'
    const primary = assignments?.find(a => a.role === primaryRole)
    let primaryTransportError: unknown
    if (primary?.modelId && primary.providerId) {
      const provider = providers.find(p => p.id === primary.providerId && p.enabled)
      if (provider) {
        try { return { assignment: primary, provider, transport: resolveMediaTransport(provider, primary.modelId, kind), providers, primary: true } }
        catch (error) { primaryTransportError = error }
      }
    }
    const assignment = assignments?.find(a => a.role === kind)
    if (!assignment?.modelId || !assignment.providerId) {
      if (primaryTransportError) throw primaryTransportError
      throw new Error(`No supported primary media model or assigned ${kind} analysis model. Configure a supported Gemini/provider or set the ${kind} model assignment.`)
    }
    const provider = providers.find(p => p.id === assignment.providerId && p.enabled)
    if (!provider) throw new Error(`Assigned ${kind} provider is missing or disabled. Update Settings → AI & Models → Assignments.`)
    return { assignment, provider, transport: resolveMediaTransport(provider, assignment.modelId, kind), providers, primary: false }
  }

  /** Preflight before reading/encoding the file; only documented native transports qualify. */
  validateMediaAssignment(kind: MediaKind, modelRole: 'main' | 'subagent' = 'main'): void {
    this.mediaAssignment(kind, modelRole)
  }

  async analyzeMedia(input: AuxiliaryMediaInput & { modelRole?: 'main' | 'subagent' }): Promise<string> {
    input.signal?.throwIfAborted()
    const { assignment, transport, providers, primary } = this.mediaAssignment(input.kind, input.modelRole)
    const { key, updatedProviders } = getNextApiKey(providers, assignment.providerId)
    if (!key) throw new Error(`${primary ? 'Primary' : `Assigned ${input.kind}`} provider has no API key. Configure its credentials in Settings → AI & Models → Providers.`)
    this.store.set('providers', updatedProviders)
    return requestMediaAnalysis(transport, assignment.modelId, key, input)
  }

  /** Заголовки идентификации с учётом настройки anonymousUserAgent. */
  private identityHeaders(): Record<string, string> {
    const params = this.store.get('modelParams') as ModelParams | undefined
    return getIdentityHeaders(params?.anonymousUserAgent ?? false)
  }

  /**
   * Заголовки для конкретного провайдера. Для OpenCode Zen добавляются
   * opencode-cli-совместимые заголовки (x-opencode-*) — без них бэкенд Zen
   * считает запрос анонимным и режет жёсткими rate-лимитами (429).
   */
  private providerHeaders(provider?: Provider): Record<string, string> {
    const base = this.identityHeaders()
    if (provider && isOpencodeProvider(provider.id, provider.type)) {
      return { ...base, ...getOpencodeZenHeaders() }
    }
    return base
  }

  /**
   * Быстрая проверка «роль назначена на syntee-gateway» БЕЗ round-robin
   * ротации ключей (в отличие от getProviderInfoForRole). Используется в
   * catch-ветках 401-ретрая, где лишняя ротация нежелательна.
   */
  private isGatewayRole(type: string): boolean {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const assignment = assignments?.find(a => a.role === type)
    if (!assignment?.providerId) return false
    const providers = this.store.get('providers') as Provider[] | undefined
    const provider = providers?.find(p => p.id === assignment.providerId && p.enabled)
    return provider?.id === 'syntee-gateway' || provider?.type === 'syntee-gateway'
  }

  private getModel(type: 'main' | 'fast' | 'memory' | 'vision' | 'summary' | 'router' | 'emotion' | 'subagent'): string {
    const defaults: Record<string, string> = {
      main: 'claude-sonnet-4-6', fast: 'mimo-v2.5-free',
      memory: 'inclusionai/ling-3.0-flash:free',
      vision: 'gpt-4o', summary: 'claude-haiku-4-5',
      router: 'claude-haiku-4-5', emotion: 'claude-haiku-4-5',
      subagent: '',
    }
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const found = assignments?.find(a => a.role === type)
    if (found?.modelId) return found.modelId
    const storeModel = this.store.get(`${type}Model`) as string
    if (storeModel) return storeModel
    // summary: если не настроена явно — используем модель чата (main),
    // чтобы суммаризация шла на той же модели что отвечает в чате.
    if (type === 'summary') return this.getModel('main')
    return defaults[type]
  }

  /**
   * Возвращает информацию о провайдере для указанной роли (с round-robin key rotation).
   * Используется как OpenAI-путём (getClientForRole), так и Anthropic-путём
   * (chatWithToolsAnthropic) для единой логики выбора провайдера и ключа.
   * Возвращает null если назначение не задано — в этом случае используется
   * дефолтный клиент (this.client).
   *
   * Для syntee-gateway apiKey НЕ берётся из Provider.apiKey — вместо этого
   * возвращается маркер '__JWT__', и getClientForRoleAsync подставит JWT.
   */
  private getProviderInfoForRole(type: string): { provider: Provider; apiKey: string } | null {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const assignment = assignments?.find(a => a.role === type)
    if (!assignment?.providerId) return null
    const providers = this.store.get('providers') as Provider[] | undefined
    const provider = providers?.find(p => p.id === assignment.providerId && p.enabled)
    if (!provider?.baseUrl) return null

    // Syntee-Gateway: авторизация через JWT, не через статический apiKey.
    // Возвращаем маркер — реальный токен подставится в getClientForRoleAsync.
    if (provider.id === 'syntee-gateway' || provider.type === 'syntee-gateway') {
      return { provider, apiKey: '__JWT__' }
    }

    // ChatGPT-подписка (Codex): ключа нет — авторизация OAuth-токеном.
    // Маркер подставится в getClientForRoleAsync вместе с codex-заголовками.
    if (provider.type === 'openai-codex') {
      return { provider, apiKey: CODEX_KEY_MARKER }
    }

    // Round-robin: выбираем следующий ключ из списка
    const { key, updatedProviders } = getNextApiKey(providers || [], assignment.providerId)
    if (!key) return null

    // Сохраняем обновлённый индекс в store
    this.store.set('providers', updatedProviders)

    return { provider, apiKey: key }
  }

  /**
   * §orchestration — провайдер, заданный ЯВНО (фазовая модель), без участия
   * modelAssignments. Возвращает null, если провайдер выключен/без baseUrl/без
   * ключа: вызывающая сторона обязана бросить ошибку (fallback запрещён).
   */
  private getProviderInfoExplicit(providerId: string): { provider: Provider; apiKey: string } | null {
    const providers = this.store.get('providers') as Provider[] | undefined
    const provider = providers?.find(p => p.id === providerId && p.enabled)
    if (!provider?.baseUrl) return null
    if (provider.id === 'syntee-gateway' || provider.type === 'syntee-gateway') {
      return { provider, apiKey: '__JWT__' }
    }
    if (provider.type === 'openai-codex') {
      return { provider, apiKey: CODEX_KEY_MARKER }
    }
    const { key, updatedProviders } = getNextApiKey(providers || [], providerId)
    if (!key) return null
    this.store.set('providers', updatedProviders)
    return { provider, apiKey: key }
  }

  /** Responses-API нужен модели по её провайдеру (фазовый override). */
  private usesResponsesApiForProvider(model: string, provider: Provider | undefined): boolean {
    if (this.responsesOnlyModels.has(model)) return true
    return provider?.type === 'openai-codex'
  }

  /**
   * Meta для buildReasoningParams: если модель принадлежит Syntee-Gateway —
   * кэш /v1/models (authoritative: reasoning.supported + levels группы).
   * Иначе — каталог models.dev (reasoning_options: effort/toggle/budget).
   * Работает и в main, и в worker (каталог в worker инициализируется из
   * кэш-файла через workerData.catalogCachePath).
   */
  private getReasoningMeta(
    model: string,
    role: string,
    providerIdOverride?: string,
  ): { reasoning?: { supported: boolean; levels: string[] }; reasoningOptions?: ReasoningOptionSpec[] } | null {
    const providerId = providerIdOverride ?? this.getProviderInfoForRole(role)?.provider.id
    if (!providerId) return null
    if (providerId === 'syntee-gateway') {
      return getGatewayModelsCache().find(m => m.id === model) ?? null
    }
    // ChatGPT-подписка: уровни reasoning берём из живого каталога бэкенда
    // (supported_reasoning_levels), который сохранён в cachedModels при фетче.
    if (providerId === 'openai-codex') {
      const cached = this.store.get('cachedModels', []) as ModelMeta[] | undefined
      const found = cached?.find(m => m.id === model && m.providerId === providerId)
      return found?.reasoningOptions ? { reasoningOptions: found.reasoningOptions } : null
    }
    const cat = getCatalogModel(providerId, model)
    return cat?.reasoningOptions ? { reasoningOptions: cat.reasoningOptions } : null
  }

  /**
   * Асинхронная версия getClientForRole — для syntee-gateway получает JWT
   * через getGatewayAuthToken() (с авто-refresh). Для остальных провайдеров
   * работает синхронно как getClientForRole.
   */
  private async getClientForRoleAsync(type: string): Promise<OpenAI> {
    const info = this.getProviderInfoForRole(type)
    if (!info) {
      console.log(`[AIClient] getClientForRoleAsync(${type}): no provider info, using default client`)
      return this.client
    }
    console.log(`[AIClient] getClientForRoleAsync(${type}): provider=${info.provider.id} baseUrl=${info.provider.baseUrl}`)
    if (info.apiKey === '__JWT__') {
      // Worker thread не имеет доступа к electron-store/tokenStore.
      // Токен передаётся из main через workerData.gatewayToken.
      // В main-процессе workerData недоступен, используем lazy import.
      let token: string | null = null
      if (!isMainThread) {
        // Worker thread: gatewayClient/tokenStore импортировать НЕЛЬЗЯ —
        // electron-store делает require('electron') на верхнем уровне, а его
        // нет в worker (в packaged-сборке падает с MODULE_NOT_FOUND).
        // Токен приходит через workerData от main-процесса; если посреди рана
        // был 401-ретрай — берём обновлённый override (см. выше).
        token = getWorkerGatewayToken()
      } else {
        const { getGatewayAuthToken } = await import('../../main/services/gatewayClient')
        token = await getGatewayAuthToken()
      }
      console.log('[AIClient] gateway authentication: %s', token ? 'ready' : 'missing')
      if (!token) {
        throw new Error('Not authenticated with Syntee-Gateway. Sign in via Profile → Sign In.')
      }
      return this.observeClient(new OpenAI({ apiKey: token, baseURL: info.provider.baseUrl, defaultHeaders: this.identityHeaders() }), info.provider.id, type)
    }
    if (info.apiKey === CODEX_KEY_MARKER) {
      // ChatGPT-подписка: apiKey = access_token (SDK сам поставит Bearer),
      // плюс заголовки бэкенда Codex. accountId нужен для chatgpt-account-id.
      let token: string | null = null
      let accountId: string | null = null
      if (!isMainThread) {
        token = getWorkerCodexToken()
        accountId = getCodexAccountIdFromWorker()
      } else {
        const { getCodexAccessToken, getCodexAccountId } = await import('../../main/services/codexAuth')
        token = await getCodexAccessToken()
        accountId = getCodexAccountId()
      }
      if (!token) {
        throw new Error('ChatGPT не подключён — войдите по подписке в Настройках → ИИ и модели.')
      }
      return this.observeClient(new OpenAI({
        apiKey: token,
        baseURL: info.provider.baseUrl,
        defaultHeaders: { ...this.identityHeaders(), ...codexHeaders(accountId) },
      }), info.provider.id, type)
    }
    return this.observeClient(new OpenAI({ apiKey: info.apiKey, baseURL: info.provider.baseUrl, defaultHeaders: this.providerHeaders(info.provider) }), info.provider.id, type)
  }

  /**
   * Codex access-токен: в worker — из workerData (main обновляет его при
   * входе/refresh), в main-процессе — напрямую из codexAuth (с авто-refresh).
   */
  private async resolveCodexToken(): Promise<string | null> {
    if (!isMainThread) return getWorkerCodexToken()
    try {
      const { getCodexAccessToken } = await import('../../main/services/codexAuth')
      return await getCodexAccessToken()
    } catch {
      return null
    }
  }

  /** account id подписки (заголовок chatgpt-account-id). */
  private async resolveCodexAccountId(): Promise<string | null> {
    if (!isMainThread) return getCodexAccountIdFromWorker()
    try {
      const { getCodexAccountId } = await import('../../main/services/codexAuth')
      return getCodexAccountId()
    } catch {
      return null
    }
  }

  /**
   * Быстрая проверка «роль назначена на открытый ChatGPT-провайдер» БЕЗ
   * round-robin ротации ключей. Для выбора API-пути: Codex отвечает только
   * через Responses API, а body требует store:false и не терпит max_output_tokens.
   */
  private isCodexRole(type: string): boolean {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; providerId: string }> | undefined
    const assignment = assignments?.find(a => a.role === type)
    if (!assignment?.providerId) return false
    const providers = this.store.get('providers') as Provider[] | undefined
    return providers?.find(p => p.id === assignment.providerId)?.type === 'openai-codex'
  }

  /**
   * Быстрая проверка «роль назначена на opencode-провайдера» БЕЗ round-robin
   * ротации ключей. Для выбора API-пути (muse-spark → Responses API).
   */
  private isOpencodeRole(type: string): boolean {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; providerId: string }> | undefined
    const assignment = assignments?.find(a => a.role === type)
    return isOpencodeProvider(assignment?.providerId)
  }

  /**
   * Модели, для которых в runtime выяснено: chat/completions не работает,
   * отвечает только Responses API. Заполняется авто-фоллбэком (см. streamChat
   * / complete) — после первого успешного ответа через /responses модель
   * запоминается и дальше идёт туда сразу, без заведомо падающей попытки.
   */
  private responsesOnlyModels = new Set<string>()

  /**
   * Модели OpenCode Zen, отвечающие только через Responses API (/responses,
   * формат OpenAI Responses) — chat/completions для них отдаёт HTTP 500.
   * Известные заранее (muse-spark*) идут туда сразу; остальные определяются
   * автоматически: первая ошибка completions → пробуем /responses → запоминаем.
   */
  /**
   * prompt_cache_key — «липкий» роутинг OpenAI: запросы с одинаковым ключом
   * попадают на тот же инстанс модели, что заметно повышает долю попаданий в
   * prompt cache (у OpenAI кеш живёт на машине, а не в общем хранилище).
   * Отправляется ТОЛЬКО официальному OpenAI и только моделям, которые этот
   * параметр знают (gpt-5+/gpt-6): прочие OpenAI-совместимые эндпоинты
   * отвечают 400 на незнакомое поле запроса, а нам нужен нулевой риск.
   */
  private promptCacheKeyParam(provider: Provider | undefined, model: string): Record<string, string> {
    if (!provider || provider.type !== 'openai') return {}
    if (!/^gpt-(5|6)/i.test(model)) return {}
    const chatId = this.usageContext?.chatId
    return chatId ? { prompt_cache_key: `syntee-${chatId}` } : {}
  }

  private usesResponsesApi(model: string, modelType: string): boolean {
    if (this.responsesOnlyModels.has(model)) return true
    // ChatGPT-подписка (Codex): chat/completions на этом бэкенде нет вообще.
    if (this.isCodexRole(modelType)) return true
    return model.startsWith('muse-spark') && this.isOpencodeRole(modelType)
  }

  /**
   * Похоже ли, что модель не поддерживает chat/completions (кандидат на
   * фоллбэк к Responses API). 400/404/500/501 или характерные тексты ошибок.
   */
  private isCompletionsUnsupported(error: { status?: number; message?: string }): boolean {
    if ([400, 404, 500, 501].includes(error?.status ?? 0)) return true
    const msg = (error?.message ?? '').toLowerCase()
    return msg.includes('not supported') || msg.includes('internal server error')
      || msg.includes('model is unavailable') || msg.includes('no endpoints found')
  }

  /** Маппит SSE-события Responses API на колбэки streamChat. */
  private async streamViaResponses(
    client: OpenAI,
    model: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    maxOutputTokens?: number,
    reasoningExtra: Record<string, unknown> = {},
    codex = false,
  ): Promise<string> {
    const systemMsg = messages[0]?.role === 'system' ? messages[0] : undefined
    const input = (systemMsg ? messages.slice(1) : messages).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))
    const stream = await client.responses.create({
      model,
      instructions: typeof systemMsg?.content === 'string' ? systemMsg.content : undefined,
      input,
      stream: true,
      // Бэкенд Codex не принимает max_output_tokens и требует store:false.
      ...(codex ? { store: false, include: ['reasoning.encrypted_content'] } : {}),
      ...(maxOutputTokens && !codex ? { max_output_tokens: maxOutputTokens } : {}),
      // reasoning_effort → reasoning:{effort} (формат Responses API)
      ...responsesReasoningParam(reasoningExtra),
    }, { signal })

    let fullText = ''
    let thinkingStartMs = 0
    let thinkingDoneSent = false
    for await (const event of stream) {
      if (signal?.aborted) break
      switch (event.type) {
        case 'response.output_text.delta':
          if (thinkingStartMs && !thinkingDoneSent) {
            thinkingDoneSent = true
            callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
          }
          fullText += event.delta
          callbacks.onToken(event.delta)
          break
        case 'response.reasoning_summary_text.delta':
          if (!thinkingStartMs) thinkingStartMs = Date.now()
          callbacks.onThinkingToken?.((event as { delta: string }).delta)
          break
        case 'response.completed': {
          const u = (event as { response?: { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } }).response?.usage
          if (u) {
            callbacks.onUsage?.({
              promptTokens: u.input_tokens ?? 0,
              completionTokens: u.output_tokens ?? 0,
              totalTokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
              cacheReadTokens: cacheReadTokensOf(u),
              cacheWriteTokens: cacheWriteTokensOf(u),
            })
          }
          break
        }
        case 'response.failed':
        case 'error': {
          const err = (event as { response?: { error?: { message?: string } }; message?: string })
          throw new Error(err.response?.error?.message || err.message || `Responses API ${event.type}`)
        }
      }
    }
    if (thinkingStartMs && !thinkingDoneSent) {
      callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
    }
    return fullText
  }

  async streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    modelType: 'main' | 'fast' | 'memory' | 'summary' = 'main',
    systemPrompt?: string,
    signal?: AbortSignal,
    temperatureOverride?: number,
  ): Promise<void> {
    const model = this.getModel(modelType)
    let client = await this.getClientForRoleAsync(modelType)

    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt })
    allMessages.push(...messages)

    if (callbacks.onContextCounted && modelType === 'main') {
      try {
        const assignment = (this.store.get('modelAssignments') as Array<{ role: string; providerId: string }> | undefined)
          ?.find(item => item.role === modelType)
        const providerId = assignment?.providerId ?? ''
        const systemMsg = allMessages[0]?.role === 'system' ? allMessages[0] : undefined
        const rest = (systemMsg ? allMessages.slice(1) : allMessages) as Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string; name?: string }>
        const snap = computeContextSnapshot(rest, Number.MAX_SAFE_INTEGER, {
          systemPrompt: typeof systemMsg?.content === 'string' ? systemMsg.content : undefined,
          includeToolSchemas: false,
          calibrationKey: calibrationKey(providerId, model),
        })
        callbacks.onContextCounted({
          promptTokens: snap.estimated,
          calibrationBaseTokens: snap.calibrationBaseTokens,
          breakdown: snap.breakdown,
          modelId: model,
          providerId,
        })
      } catch { /* ok — tiktoken не критичен */ }
    }

    // Берём reasoning параметры из store (выбраны пользователем в UI).
    // Уровень проверяется по целевой модели: совпадение либо ближайший ниже.
    // Это также адаптирует общий reasoningValue для модели суб-агента.
    const reasoningValue = (this.store.get('reasoningValue') as string) || ''
    const reasoningExtra = buildReasoningParams(reasoningValue, this.getReasoningMeta(model, modelType))

    // ── Модели только с Responses API (muse-spark и runtime-выявленные) ─────
    // Известные модели идут в /responses сразу; остальные определяются
    // автоматически — авто-фоллбэком в catch ниже (completions упал → пробуем
    // Responses → запоминаем в responsesOnlyModels).
    if (this.usesResponsesApi(model, modelType)) {
      callbacks.onWaiting?.()
      const isCodex = this.isCodexRole(modelType)
      try {
        const text = await this.streamViaResponses(client, model, allMessages, callbacks, signal, DEFAULT_MAX_TOKENS, reasoningExtra, isCodex)
        callbacks.onDone(text)
      } catch (err: unknown) {
        const error = err as { status?: number; name?: string; message?: string }
        if (error?.name === 'AbortError' || signal?.aborted) {
          callbacks.onDone('')
          return
        }
        // 401 на Codex-бэкенде = access-токен протух: форс-рефреш и один ретрай.
        if (isCodex && error?.status === 401) {
          const fresh = await refreshCodexTokenAfter401()
          if (fresh) {
            try {
              client = await this.getClientForRoleAsync(modelType)
              const text = await this.streamViaResponses(client, model, allMessages, callbacks, signal, DEFAULT_MAX_TOKENS, reasoningExtra, true)
              callbacks.onDone(text)
              return
            } catch (retryErr: unknown) {
              callbacks.onError(new Error((retryErr as { message?: string })?.message || String(retryErr)))
              return
            }
          }
          callbacks.onError(new Error('ChatGPT-сессия истекла — подключите подписку заново (Настройки → ИИ и модели).'))
          return
        }
        callbacks.onError(new Error(error?.message || String(err)))
      }
      return
    }

    let attempt = 0
    let retried401 = false
    let fullText = ''
    // Usage текущего запроса — ровно один onUsage на вызов модели (см. ниже).
    let requestUsage: ChatUsage | null = null
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS

    while (attempt <= this.maxRetries) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callbacks.onWaiting?.()
        const stream = await (client.chat.completions.create as any)({
          model,
          messages: allMessages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: DEFAULT_TEMPERATURE,
          max_tokens: DEFAULT_MAX_TOKENS,
          ...reasoningExtra,
        }, { signal })

        let thinkingStartMs = 0
        let thinkingDoneSent = false
        let inThinkTag = false
        let thinkBuffer = ''
        // Провайдеры (gateway'и, DeepSeek через прокси) кладут `usage` в КАЖДЫЙ
        // чанк, а не только в финальный. Раньше onUsage вызывался на каждом
        // таком чанке, а воркер суммировал вызовы (accPromptTokens) → один и тот
        // же prompt считался 2-3 раза: статистика хода показывала 400-450k при
        // реальных 225k и «нормализовалась» на ходах с одним пакетом usage.
        // Теперь берём ПОСЛЕДНИЙ пакет и отдаём его один раз, после стрима.
        requestUsage = null


        for await (const chunk of stream) {
          if (signal?.aborted) break

          if (chunk.usage) requestUsage = mergeChatUsage(requestUsage, chunk.usage)

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const delta = (chunk.choices?.[0]?.delta ?? {}) as Record<string, any>

          // --- Формат 1: delta.reasoning_content ---
          if (delta.reasoning_content != null) {
            const tok = extractReasoningText(delta.reasoning_content)
            if (tok) {
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              callbacks.onThinkingToken?.(tok)
            }
            continue
          }

          // --- Формат 2: delta.thinking (Anthropic extended thinking) ---
          if (delta.thinking != null) {
            const tok = extractReasoningText(delta.thinking)
            if (tok) {
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              callbacks.onThinkingToken?.(tok)
            }
            continue
          }

          // Если был reasoning и теперь его нет — шлём done
          if (thinkingStartMs && !thinkingDoneSent) {
            thinkingDoneSent = true
            callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
          }

          // --- Формат 3: <think>...</think> теги внутри delta.content ---
          const rawContent: string = delta.content ?? ''
          if (!rawContent) continue

          if (inThinkTag || rawContent.includes('<think>')) {
            thinkBuffer += rawContent
            let searchFrom = 0

            while (true) {
              if (!inThinkTag) {
                const openIdx = thinkBuffer.indexOf('<think>', searchFrom)
                if (openIdx === -1) {
                  const plain = thinkBuffer.slice(searchFrom)
                  if (plain) { fullText += plain; callbacks.onToken(plain) }
                  thinkBuffer = ''
                  break
                }
                const before = thinkBuffer.slice(searchFrom, openIdx)
                if (before) { fullText += before; callbacks.onToken(before) }
                inThinkTag = true
                searchFrom = openIdx + '<think>'.length
                if (!thinkingStartMs) thinkingStartMs = Date.now()
              }

              const closeIdx = thinkBuffer.indexOf('</think>', searchFrom)
              if (closeIdx === -1) {
                // тег ещё не закрыт — накапливаем и шлём partial
                const partial = thinkBuffer.slice(searchFrom)
                if (partial) callbacks.onThinkingToken?.(partial)
                thinkBuffer = '<think>' + thinkBuffer.slice(searchFrom)
                break
              }

              const thinkContent = thinkBuffer.slice(searchFrom, closeIdx)
              if (thinkContent) callbacks.onThinkingToken?.(thinkContent)
              if (!thinkingDoneSent) {
                thinkingDoneSent = true
                callbacks.onThinkingDone?.(Date.now() - (thinkingStartMs || Date.now()))
              }
              inThinkTag = false
              searchFrom = closeIdx + '</think>'.length
            }
          } else {
            // Обычный контент
            fullText += rawContent
            callbacks.onToken(rawContent)
          }
        }

        if (thinkingStartMs && !thinkingDoneSent) {
          callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
        }

        // Фоллбэк: стрим дал 0 токенов
        if (!fullText) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await (client.chat.completions.create as any)({
            model, messages: allMessages, stream: false,
          temperature: temperatureOverride ?? DEFAULT_TEMPERATURE,
            max_tokens: DEFAULT_MAX_TOKENS,
          })
          fullText = res.choices[0]?.message?.content || ''
          if (fullText) callbacks.onToken(fullText)
          const u = res.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
          if (u?.prompt_tokens != null) {
            requestUsage = {
              promptTokens: u.prompt_tokens,
              completionTokens: u.completion_tokens ?? 0,
              totalTokens: u.total_tokens ?? (u.prompt_tokens + (u.completion_tokens ?? 0)),
            }
          }
        }

        // Ровно один usage на один вызов модели.
        if (requestUsage) callbacks.onUsage?.(requestUsage)
        callbacks.onDone(fullText)
        return

      } catch (err: unknown) {
        const error = err as { status?: number; message?: string; name?: string }
        if (error?.name === 'AbortError' || signal?.aborted) {
          // Стоп посреди стрима: провайдер уже списал prompt — отдаём то, что
          // успели получить, чтобы статистика хода и ledger не теряли вызов.
          if (requestUsage) callbacks.onUsage?.(requestUsage)
          callbacks.onDone(fullText ?? '')
          return
        }
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          const waitSec = Math.round(delay / 1000)
          callbacks.onRateLimit?.(waitSec)
          callbacks.onRetry?.(attempt + 1, 'rate_limit', waitSec, this.maxRetries + 1)
          if (Date.now() >= deadlineMs) {
            callbacks.onError(new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`))
            return
          }
          await sleep(delay)
          attempt++
          continue
        }
        // 401 от gateway — access JWT протух: форс-рефреш + один ретрай
        // с новым клиентом (токен уже в holder'е, getClientForRoleAsync
        // его подхватит). Попытку не инкрементируем — не сетевой сбой.
        if (error?.status === 401 && !retried401 && this.isGatewayRole(modelType)) {
          retried401 = true
          log('[AIClient] streamChat: 401 от gateway (model=%s) — форс-рефреш токена и ретрай', model)
          const fresh = await refreshGatewayTokenAfter401()
          if (fresh) {
            client = await this.getClientForRoleAsync(modelType)
            continue
          }
          callbacks.onError(new Error('Syntee session expired — sign in again (Profile → Sign In).'))
          return
        }
        // ── Авто-фоллбэк на Responses API (только opencode-провайдеры) ──────
        // Если chat/completions не поддерживается моделью (500/400/«not
        // supported») — Zen-модели могут отвечать только через /responses.
        // Пробуем Responses API до сетевых ретраев: для таких моделей ретраи
        // completions бессмысленны. Успех → запоминаем модель (в следующий
        // раз идём в /responses сразу), провал → обычная обработка ниже.
        if (this.isOpencodeRole(modelType) && !this.usesResponsesApi(model, modelType)
          && !signal?.aborted && this.isCompletionsUnsupported(error)) {
          try {
            const text = await this.streamViaResponses(client, model, allMessages, callbacks, signal, DEFAULT_MAX_TOKENS, reasoningExtra)
            this.responsesOnlyModels.add(model)
            callbacks.onDone(text)
            return
          } catch { /* Responses тоже не сработал — идём в обычную обработку */ }
        }
        const msg = (error?.message ?? '').toLowerCase()
        const isNetwork = !error?.status || error.status >= 500 ||
          msg.includes('econnreset') || msg.includes('etimedout') ||
          msg.includes('enotfound') || msg.includes('fetch failed') ||
          msg.includes('network') || msg.includes('socket')
        if (isNetwork && attempt < this.maxRetries) {
          const delay = backoffDelay(attempt)
          callbacks.onRetry?.(attempt + 1, 'network', undefined, this.maxRetries + 1)
          if (Date.now() >= deadlineMs) {
            callbacks.onError(new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`))
            return
          }
          await sleep(delay)
          attempt++
          continue
        }
        callbacks.onError(new Error(error?.message || 'Unknown AI error'))
        return
      }
    }

    callbacks.onError(new Error('Превышено число попыток'))
  }

  /** Нестриминговый запрос через Responses API (Zen-модели без completions). */
  private async completeViaResponses(
    client: OpenAI,
    model: string,
    messages: ChatMessage[],
    systemPrompt?: string,
    maxTokens?: number,
    reasoningExtra: Record<string, unknown> = {},
    codex = false,
  ): Promise<string> {
    const res = await client.responses.create({
      model,
      instructions: systemPrompt,
      input: messages.map(m => ({ role: m.role, content: m.content })),
      ...(codex
        // Бэкенд Codex: store:false обязателен, max_output_tokens не принимается.
        ? { store: false, include: ['reasoning.encrypted_content'] }
        // Reasoning-модели (muse-spark) сжигают бюджет на скрытые рассуждения —
        // 1024 не хватает даже на короткий ответ → минимум 4096.
        : { max_output_tokens: Math.max(maxTokens ?? 1024, 4096) }),
      // reasoning_effort → reasoning:{effort} (формат Responses API)
      ...responsesReasoningParam(reasoningExtra),
    })
    return res.output_text || ''
  }

  async complete(
    messages: ChatMessage[],
    modelType: 'main' | 'fast' | 'memory' | 'summary' | 'router' | 'emotion' = 'fast',
    systemPrompt?: string,
    opts?: { model?: string; maxTokens?: number },
  ): Promise<string> {
    const model = opts?.model || this.getModel(modelType)
    let client = await this.getClientForRoleAsync(modelType)
    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt })
    allMessages.push(...messages)

    // Reasoning-параметры — как в streamChat: валидируем по целевой модели.
    // Для моделей без reasoning-спек buildReasoningParams вернёт {}.
    const reasoningValue = (this.store.get('reasoningValue') as string) || ''
    const reasoningExtra = buildReasoningParams(reasoningValue, this.getReasoningMeta(model, modelType))

    // ── Модели только с Responses API (muse-spark и runtime-выявленные) ─────
    if (this.usesResponsesApi(model, modelType)) {
      const isCodex = this.isCodexRole(modelType)
      try {
        return await this.completeViaResponses(client, model, messages, systemPrompt, opts?.maxTokens, reasoningExtra, isCodex)
      } catch (err: unknown) {
        // 401 на Codex-бэкенде = access-токен протух: форс-рефреш и один ретрай.
        const error = err as { status?: number }
        if (isCodex && error?.status === 401) {
          const fresh = await refreshCodexTokenAfter401()
          if (!fresh) throw new Error('ChatGPT-сессия истекла — подключите подписку заново (Настройки → ИИ и модели).')
          client = await this.getClientForRoleAsync(modelType)
          return this.completeViaResponses(client, model, messages, systemPrompt, opts?.maxTokens, reasoningExtra, true)
        }
        throw err
      }
    }

    let attempt = 0
    let retried401 = false
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt <= this.maxRetries) {
      try {
        const res = await client.chat.completions.create({
          model, messages: allMessages, stream: false,
          temperature: 0.3, max_tokens: opts?.maxTokens ?? 1024,
          ...reasoningExtra,
        })
        return res.choices[0]?.message?.content || ''
      } catch (err: unknown) {
        const error = err as { status?: number; message?: string }
        if (error?.status === 429) {
          if (Date.now() >= deadlineMs) {
            throw new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`)
          }
          await sleep(backoffDelay(attempt)); attempt++; continue
        }
        // 401 от gateway — форс-рефреш JWT + один ретрай (см. chatWithTools)
        if (error?.status === 401 && !retried401 && this.isGatewayRole(modelType)) {
          retried401 = true
          const fresh = await refreshGatewayTokenAfter401()
          if (fresh) { client = await this.getClientForRoleAsync(modelType); continue }
          throw new Error('Syntee session expired — sign in again (Profile → Sign In).')
        }
        // ── Авто-фоллбэк на Responses API (только opencode-провайдеры) ──────
        // Аналогично streamChat: completions не поддерживается → пробуем
        // /responses, успех запоминаем (responsesOnlyModels).
        if (this.isOpencodeRole(modelType) && !this.usesResponsesApi(model, modelType)
          && this.isCompletionsUnsupported(error)) {
          try {
            const text = await this.completeViaResponses(client, model, messages, systemPrompt, opts?.maxTokens, reasoningExtra)
            this.responsesOnlyModels.add(model)
            return text
          } catch { /* Responses тоже не сработал — идём в обычную обработку */ }
        }
        // Сетевые ошибки / 5xx — ретрай с бэккоффом (как в streamChat).
        // Раньше пробрасывались сразу — из-за этого, например, молча
        // падала генерация названий чатов (autoNameChat).
        const errMessage = (error?.message || '').toLowerCase()
        const isNetwork = !error?.status || error.status >= 500 ||
          errMessage.includes('econnreset') || errMessage.includes('etimedout') ||
          errMessage.includes('enotfound') || errMessage.includes('fetch failed') ||
          errMessage.includes('network') || errMessage.includes('socket')
        if (isNetwork && attempt < this.maxRetries) {
          if (Date.now() >= deadlineMs) {
            throw new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`)
          }
          await sleep(backoffDelay(attempt)); attempt++; continue
        }
        throw err
      }
    }
    throw new Error('Rate limit: превышено число попыток')
  }

  /**
   * complete с function calling (для ai.chat плагинов с opts.tools):
   * цикл «модель вызывает тул → execTool → результат обратно в модель»,
   * максимум 8 раундов, финал — текстовый ответ модели.
   */
  async completeWithTools(
    messages: ChatMessage[],
    tools: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>,
    execTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    modelType: 'main' | 'fast' = 'main',
    systemPrompt?: string,
    opts?: { model?: string; maxTokens?: number },
  ): Promise<string> {
    const model = opts?.model || this.getModel(modelType)
    const client = await this.getClientForRoleAsync(modelType)
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt })
    msgs.push(...messages)
    const MAX_ROUNDS = 8
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const resp = await client.chat.completions.create({
        model,
        messages: msgs,
        tools: tools as OpenAI.Chat.ChatCompletionTool[],
        tool_choice: 'auto',
        max_tokens: opts?.maxTokens ?? 2048,
      })
      const choice = resp.choices?.[0]
      const toolCalls = choice?.message?.tool_calls
      if (toolCalls?.length) {
        msgs.push(choice.message)
        for (const call of toolCalls) {
          if (call.type !== 'function') continue
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown> } catch { /* пустые args */ }
          let result: unknown
          try {
            result = await execTool(call.function.name, args)
          } catch (e) {
            result = `Error: ${(e as Error).message}`
          }
          msgs.push({
            role: 'tool',
            tool_call_id: call.id,
            content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
          })
        }
        continue
      }
      return choice?.message?.content ?? ''
    }
    throw new Error('ai.chat: превышен лимит раундов вызова тулов (8)')
  }

  async textToSpeech(text: string): Promise<string> {
    const apiKey = this.store.get('apiKey') as string
    const endpoint = (this.store.get('apiEndpoint') as string) || ''
    if (!endpoint) {
      throw new Error('TTS endpoint не настроен — укажите провайдера в Настройках → ИИ и Модели')
    }
    const voice = (this.store.get('voiceId') as string) || 'alloy'
    const response = await fetch(`${endpoint}/audio/speech`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: text, voice }),
    })
    const buffer = await response.arrayBuffer()
    return Buffer.from(buffer).toString('base64')
  }

  /**
   * chatWithTools через Responses API (/responses, формат OpenAI Responses).
   * Для Zen-моделей без поддержки chat/completions (muse-spark* и любые
   * новые, выявленные авто-фоллбэком). Конвертирует:
   *  - chat-tools {type:'function',function:{...}} → responses-tools (flat)
   *  - messages с tool_calls / role:'tool' → items function_call /
   *    function_call_output
   * Возвращает тот же контракт, что основной путь chatWithTools.
   */
  private async chatWithToolsViaResponses(
    client: OpenAI,
    model: string,
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: unknown[],
    signal: AbortSignal | undefined,
    maxTokens: number,
    reasoningExtra: Record<string, unknown>,
    codex: boolean,
    cb: {
      onToken?: (token: string) => void
      onUsage?: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => void
      onThinkingToken?: (token: string) => void
      onThinkingDone?: (ms: number) => void
      onToolCallStarted?: (index: number, toolName: string) => void
    },
  ): Promise<{ content: string; tool_calls?: unknown[]; reasoning?: string; hadStreamedTokens?: boolean; thinking_blocks?: Array<{ thinking: string; signature: string }> }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type AnyItem = Record<string, any>

    // 1. System-сообщение → instructions, остальное → items
    const systemMsg = messages[0]?.role === 'system' ? messages[0] : undefined
    const rest = systemMsg ? messages.slice(1) : messages
    const input: AnyItem[] = []
    // Also safe for direct callers: never serialize visual payloads as JSON text.
    for (const m of routeToolImagesToUser(rest)) {
      // Результат тула (role:'tool') → function_call_output
      if (m.role === 'tool' && m.tool_call_id) {
        input.push({
          type: 'function_call_output',
          call_id: m.tool_call_id,
          output: typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n'),
        })
        continue
      }
      // Ассистент с tool_calls → отдельные items function_call (+ текст)
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        if (typeof m.content === 'string' && m.content) {
          input.push({ role: 'assistant', content: m.content })
        }
        for (const tcRaw of m.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
          input.push({
            type: 'function_call',
            call_id: tcRaw.id ?? '',
            name: tcRaw.function?.name ?? '',
            arguments: tcRaw.function?.arguments ?? '{}',
          })
        }
        continue
      }
      // Обычные user/assistant сообщения; контент может быть multipart.
      if (typeof m.content === 'string') {
        input.push({ role: m.role, content: m.content })
      } else if (Array.isArray(m.content)) {
        const parts: AnyItem[] = []
        for (const p of m.content) {
          if (p.type === 'text' && p.text) parts.push({ type: 'input_text', text: p.text })
          else if (p.type === 'image_url' && p.image_url?.url) parts.push({ type: 'input_image', image_url: p.image_url.url, detail: p.image_url.detail ?? 'auto' })
        }
        input.push({ role: m.role, content: parts })
      }
    }

    const responseImages = input.reduce((count, item) => count + (Array.isArray(item.content)
      ? item.content.filter((part: AnyItem) => part.type === 'input_image').length : 0), 0)
    if (responseImages) log('[vision:send]', { model, api: 'responses', format: 'input_image', images: responseImages })

    // 2. Chat-tools → responses-tools (плоский формат)
    const responsesTools = (tools as Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>)
      .filter(t => t?.function?.name)
      .map(t => ({
        type: 'function',
        name: t.function!.name!,
        description: t.function!.description,
        parameters: t.function!.parameters,
      }))

    // 3. Стрим (input — гетерогенные items, типизируем свободно)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await (client.responses.create as any)({
      model,
      instructions: typeof systemMsg?.content === 'string' ? systemMsg.content : undefined,
      input,
      tools: responsesTools,
      tool_choice: 'auto',
      stream: true,
      // Reasoning-модели сжигают бюджет на скрытые рассуждения → запас.
      // Бэкенд Codex не принимает max_output_tokens и требует store:false.
      ...(codex
        ? { store: false, include: ['reasoning.encrypted_content'] }
        : { max_output_tokens: Math.max(maxTokens, 4096) }),
      // reasoning_effort → reasoning:{effort} (формат Responses API)
      ...responsesReasoningParam(reasoningExtra),
    }, { signal })

    let content = ''
    let reasoning = ''
    let thinkingStartMs = 0
    let thinkingDoneSent = false
    let hasToolCalls = false
    let tcIndex = 0
    // item_id (responses) → { index, call } для сбора аргументов по дельтам
    const callByItemId = new Map<string, { index: number; call: { id: string; name: string; arguments: string } }>()
    const calls: Array<{ id: string; name: string; arguments: string }> = []

    for await (const event of stream) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      switch (event.type) {
        case 'response.output_text.delta':
          if (thinkingStartMs && !thinkingDoneSent) {
            thinkingDoneSent = true
            cb.onThinkingDone?.(Date.now() - thinkingStartMs)
          }
          content += event.delta
          if (!hasToolCalls) cb.onToken?.(event.delta)
          break
        case 'response.reasoning_summary_text.delta':
          if (!thinkingStartMs) thinkingStartMs = Date.now()
          reasoning += event.delta
          cb.onThinkingToken?.(event.delta)
          break
        case 'response.output_item.added': {
          const item = (event as AnyItem).item
          if (item?.type === 'function_call') {
            hasToolCalls = true
            const call = { id: item.call_id ?? item.id ?? '', name: item.name ?? '', arguments: '' }
            callByItemId.set(item.id, { index: tcIndex, call })
            calls.push(call)
            if (call.name) cb.onToolCallStarted?.(tcIndex, call.name)
            tcIndex++
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const entry = callByItemId.get((event as AnyItem).item_id)
          if (entry) entry.call.arguments += (event as AnyItem).delta ?? ''
          break
        }
        case 'response.completed': {
          const usage = (event as AnyItem).response?.usage
          if (usage?.input_tokens != null) {
            cb.onUsage?.(usage.input_tokens, usage.output_tokens ?? 0, cacheReadTokensOf(usage), cacheWriteTokensOf(usage))
          }
          break
        }
        case 'response.failed':
        case 'error': {
          const e = (event as AnyItem)
          throw new Error(e.response?.error?.message || e.message || `Responses API ${event.type}`)
        }
      }
    }

    if (thinkingStartMs && !thinkingDoneSent) {
      cb.onThinkingDone?.(Date.now() - thinkingStartMs)
    }

    const tool_calls = calls.length > 0
      ? calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        }))
      : undefined

    return {
      content,
      tool_calls,
      reasoning: reasoning || undefined,
      hadStreamedTokens: content.length > 0 && !tool_calls,
    }
  }

  async chatWithTools(
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: unknown[],
    signal?: AbortSignal,
    role: 'main' | 'subagent' = 'main',
    onToken?: (token: string) => void,
    onContextCounted?: (info: ContextCountedInfo) => void,
    onRateLimit?: (waitSec: number) => void,
    onRetry?: (attempt: number, reason: string, waitSec?: number, maxAttempts?: number) => void,
    onUsage?: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => void,
    onThinkingToken?: (token: string) => void,
    onThinkingDone?: (ms: number) => void,
    // Вызывается один раз на каждый tool_call, как только известно его имя —
    // ЕЩЁ ДО того, как модель полностью догенерирует JSON аргументов (который
    // может быть большим для edit_file/write_file и занимать заметное время).
    // index стабилен в рамках раунда (см. tc.index у провайдера) — по нему
    // Agent.ts матчит этот ранний сигнал с финальным tool_call.
    onToolCallStarted?: (index: number, toolName: string) => void,
    // §orchestration — явная модель фазы (provider/model/effort). undefined =
    // прежнее поведение: модель и провайдер берутся из назначений роли.
    override?: ModelOverride,
  ): Promise<{ content: string; tool_calls?: unknown[]; reasoning?: string; hadStreamedTokens?: boolean; thinking_blocks?: Array<{ thinking: string; signature: string }> }> {
    // Slicing inherited history/compaction may leave orphan tool outputs.
    // Repair before both API paths, including gateways converting to Responses.
    messages = repairToolCallHistory(messages).map(message => {
      // Compaction flags belong to live history, not the provider schema.
      // Strip from a copy: deleting them in-place would unprotect failures
      // and visual results before the next Janitor scan.
      const clean = { ...message } as typeof message & { janitorProtected?: boolean; janitorCollapsed?: boolean }
      delete clean.janitorProtected
      delete clean.janitorCollapsed
      return clean
    })
    const effectiveRole = role === 'subagent' ? 'subagent' as never : 'main'
    const subagentModel = role === 'subagent' ? this.getModel('subagent' as never) : ''
    const resolvedRole = (subagentModel && subagentModel !== '') ? effectiveRole : 'main'
    // §orchestration: фазовая модель перекрывает роль ПОЛНОСТЬЮ (и модель, и
    // провайдера, и reasoning). Провайдер резолвится явно — никакого
    // «провайдера роли по умолчанию», иначе ран молча уедет на другую модель.
    const model = override?.modelId || this.getModel(resolvedRole) || this.getModel('main')
    const providerInfo = override?.providerId
      ? this.getProviderInfoExplicit(override.providerId)
      : this.getProviderInfoForRole(resolvedRole)
    if (override?.providerId && !providerInfo) {
      throw new Error(
        `Orchestration: provider "${override.providerId}" is not available (disabled, missing base URL or API key). `
        + 'Fix the orchestration model selection — no fallback provider is used.',
      )
    }
    // Для syntee-gateway apiKey === '__JWT__' — реальный JWT получаем ниже.
    const isGateway = providerInfo?.apiKey === '__JWT__'
    // ChatGPT-подписка: ключа нет, токен и accountId резолвим отдельно.
    const isCodex = providerInfo?.apiKey === CODEX_KEY_MARKER
    let gatewayToken: string | null = null
    if (isGateway) {
      // Worker thread не имеет доступа к electron-store/tokenStore.
      // Токен передаётся из main через workerData.gatewayToken.
      if (!isMainThread) {
        // Worker thread: gatewayClient/tokenStore импортировать НЕЛЬЗЯ —
        // electron-store делает require('electron') на верхнем уровне, а его
        // нет в worker (в packaged-сборке падает с MODULE_NOT_FOUND).
        // Токен приходит через workerData от main-процесса; если посреди рана
        // был 401-ретрай — берём обновлённый override.
        gatewayToken = getWorkerGatewayToken()
      } else {
        const { getGatewayAuthToken } = await import('../../main/services/gatewayClient')
        gatewayToken = await getGatewayAuthToken()
      }
      if (!gatewayToken) {
        throw new Error('Not authenticated with Syntee-Gateway. Sign in via Profile → Sign In.')
      }
    }
    const temperature = DEFAULT_TEMPERATURE
    const maxTokensRaw = DEFAULT_MAX_TOKENS
    // §orchestration: effort фазы (если задан) перекрывает глобальный тумблер.
    const reasoningValue = override?.reasoningValue ?? ((this.store.get('reasoningValue') as string) || '')
    const reasoningExtra = reasoningValue
      ? buildReasoningParams(
          reasoningValue,
          this.getReasoningMeta(model, resolvedRole, override?.providerId),
        )
      : {}
    // Responses-API решается провайдером фазы, а не ролью чата.
    const responsesApi = override?.providerId
      ? this.usesResponsesApiForProvider(model, providerInfo?.provider)
      : this.usesResponsesApi(model, resolvedRole)

    // Для Anthropic extended thinking: max_tokens ВКЛЮЧАЕТ reasoning токены.
    // Если budget_tokens > max_tokens, API обрежет на max_tokens и ответ будет пустой.
    // Решение: max_tokens = max(budget_tokens + maxTokensRaw, maxTokensRaw)
    let maxTokens = maxTokensRaw
    if (reasoningExtra.thinking && typeof reasoningExtra.thinking === 'object') {
      const budget = (reasoningExtra.thinking as { budget_tokens?: number }).budget_tokens
      if (budget && budget > 0) {
        maxTokens = budget + maxTokensRaw
      }
    }
    // Adaptive thinking (Claude 4.6+/5 — effort-модели по models.dev): мысли
    // берутся из max_tokens; без запаса длинное мышление обрежет ответ.
    // Бампим только для нативного Anthropic-пути (gateway делает то же сам).
    // 'none' — мышление выключено, запас не нужен.
    if (reasoningExtra.reasoning_effort && reasoningExtra.reasoning_effort !== 'none'
      && providerInfo && isAnthropicProvider(providerInfo.provider)) {
      maxTokens = Math.max(maxTokens, 64000)
    }

    const reportContextEstimate = () => {
      if (!onContextCounted) return
      try {
        const providerId = providerInfo?.provider.id ?? ''
        const systemMsg = messages[0]?.role === 'system' ? messages[0] : undefined
        const rest = systemMsg ? messages.slice(1) : messages
        const snap = computeContextSnapshot(rest, Number.MAX_SAFE_INTEGER, {
          systemPrompt: systemMsg?.content as string | undefined,
          includeToolSchemas: true,
          toolSchemas: tools,
          calibrationKey: calibrationKey(providerId, model),
        })
        onContextCounted({
          promptTokens: snap.estimated,
          calibrationBaseTokens: snap.calibrationBaseTokens,
          breakdown: snap.breakdown,
          modelId: model,
          providerId,
        })
      } catch { /* ok */ }
    }

    // Anthropic-нативный путь с prompt caching (cache_control на system + tools).
    // Срабатывает когда провайдер имеет type='anthropic' или baseUrl=api.anthropic.com.
    // OnlySQ-прокси больше не используется; gateway-провайдер идёт через JWT.
    if (providerInfo && isAnthropicProvider(providerInfo.provider)) {
      reportContextEstimate()
      const visualPayload = summarizeImagePayload(messages)
      if (visualPayload.images) log('[vision:send]', { model, provider: providerInfo.provider.id, api: 'anthropic', format: 'image/source', ...visualPayload })
      const anthropicApiKey = isGateway ? gatewayToken! : providerInfo.apiKey
      const anthropicClient = this.observeClient(new Anthropic({
        apiKey: anthropicApiKey,
        baseURL: providerInfo.provider.baseUrl,
        defaultHeaders: this.identityHeaders(),
      }), providerInfo.provider.id, resolvedRole, true)
      return chatWithToolsAnthropic(
        anthropicClient, messages, tools, signal, model, temperature, maxTokens, reasoningExtra,
        { onToken, onRateLimit, onRetry, onUsage, onThinkingToken, onThinkingDone, onToolCallStarted }
      )
    }

    // cacheAnchor — служебный маркер Anthropic-конвертера (cache_control на
    // последнем блоке сообщения). Anthropic-ветка выше уже отработала и
    // вернулась; OpenAI-совместимые эндпоинты отклоняют незнакомые поля
    // сообщения (400 Unrecognized request argument), поэтому дальше маркер
    // обязан быть снят с массива ДО отправки (в т.ч. через /responses).
    for (const m of messages) {
      if ((m as { cacheAnchor?: boolean }).cacheAnchor) delete (m as { cacheAnchor?: boolean }).cacheAnchor
    }

    // Native Anthropic above supports images inside tool_result. OpenAI-compatible
    // endpoints require visual input in user messages; keep tool pairs intact.
    const originalVisualPayload = summarizeImagePayload(messages)
    messages = routeToolImagesToUser(messages)
    const routedVisualPayload = summarizeImagePayload(messages)
    if (routedVisualPayload.images !== originalVisualPayload.images) {
      throw new Error('Visual payload routing lost image blocks; refusing to continue with text only.')
    }
    if (routedVisualPayload.images) log('[vision:send]', {
      model, provider: providerInfo?.provider.id ?? 'default',
      api: responsesApi ? 'responses' : 'chat-completions',
      format: 'user/image_url', ...routedVisualPayload,
    })

    // OpenAI-совместимый путь (включая syntee-gateway через JWT и Codex-подписку)
    let codexToken: string | null = null
    let codexHeaderExtras: Record<string, string> = {}
    if (isCodex) {
      codexToken = getWorkerCodexToken() ?? await this.resolveCodexToken()
      if (!codexToken) {
        throw new Error('ChatGPT не подключён — войдите по подписке в Настройках → ИИ и модели.')
      }
      codexHeaderExtras = codexHeaders(getCodexAccountIdFromWorker() ?? await this.resolveCodexAccountId())
    }
    let client = providerInfo
      ? this.observeClient(new OpenAI({
          apiKey: isGateway ? gatewayToken! : isCodex ? codexToken! : providerInfo.apiKey,
          baseURL: providerInfo.provider.baseUrl,
          defaultHeaders: isCodex
            ? { ...this.identityHeaders(), ...codexHeaderExtras }
            : this.providerHeaders(providerInfo.provider),
        }), providerInfo.provider.id, resolvedRole)
      : this.client
    reportContextEstimate()

    // ── Модели только с Responses API (muse-spark и runtime-выявленные) ─────
    // Известные модели идут в /responses сразу; остальные — авто-фоллбэком
    // в catch ниже (completions упал → пробуем Responses → запоминаем).
    if (responsesApi) {
      const viaResponses = () => this.chatWithToolsViaResponses(client, model, messages, tools, signal, maxTokens, reasoningExtra, isCodex, {
        onToken, onUsage, onThinkingToken, onThinkingDone, onToolCallStarted,
      })
      if (!isCodex) return viaResponses()
      try {
        return await viaResponses()
      } catch (err: unknown) {
        // 401 на Codex-бэкенде = access-токен протух: форс-рефреш и один ретрай.
        if ((err as { status?: number })?.status !== 401) throw err
        const fresh = await refreshCodexTokenAfter401()
        if (!fresh) throw new Error('ChatGPT-сессия истекла — подключите подписку заново (Настройки → ИИ и модели).')
        setCodexToken(fresh)
        client = this.observeClient(new OpenAI({
          apiKey: fresh,
          baseURL: providerInfo!.provider.baseUrl,
          defaultHeaders: { ...this.identityHeaders(), ...codexHeaderExtras },
        }), providerInfo!.provider.id, resolvedRole)
        return viaResponses()
      }
    }

    let attempt = 0
    let retried401 = false
    // Usage текущего вызова модели. Объявлен вне попытки, чтобы отдать его и
    // при Abort/ошибке после получения пакета; сбрасывается на каждой попытке,
    // иначе ретрай сложил бы usage двух запросов в один.
    let usageOfRequest: ChatUsage | null = null
    const maxAttempts = 5
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt < maxAttempts) {
      usageOfRequest = null
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        console.log('[AIClient] chatWithTools: model=%s attempt=%d/%d messages=%d tools=%d', model, attempt + 1, maxAttempts, messages.length, tools.length)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = await (client.chat.completions.create as any)({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          stream: true,
          stream_options: { include_usage: true },
          ...this.promptCacheKeyParam(providerInfo?.provider, model),
          temperature,
          max_tokens: maxTokens,
          ...reasoningExtra,
        }, { signal })
        console.log('[AIClient] stream opened, reading chunks...')

        let content = ''
        let reasoning = ''
        let thinkingStartMs = 0
        let thinkingDoneSent = false
        const toolCallMap: Record<number, { id: string; name: string; arguments: string }> = {}
        const tokenBuffer: string[] = []
        let hasToolCalls = false

        for await (const chunk of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          if (chunk.usage) {
            const usage = chunk.usage as {
              prompt_tokens?: number
              completion_tokens?: number
              prompt_tokens_details?: { cached_tokens?: number }
            }
            usageOfRequest = mergeChatUsage(usageOfRequest, usage)
          }
          const delta = chunk.choices[0]?.delta
          if (!delta) continue

          // Текстовые токены — буферизуем, стримим только если нет tool_calls
          if (delta.content) {
            content += delta.content
            if (!hasToolCalls) {
              tokenBuffer.push(delta.content)
              onToken?.(delta.content)
            }
          }

          // Reasoning токены — стримим в реальном времени
          const rTok = delta.reasoning_content ?? delta.thinking ?? delta.reasoning_summary
          const reasoningChunk = extractReasoningText(rTok)
          if (reasoningChunk) {
            if (!thinkingStartMs) thinkingStartMs = Date.now()
            reasoning += reasoningChunk
            onThinkingToken?.(reasoningChunk)
          } else if (thinkingStartMs && !thinkingDoneSent && (delta.content || delta.tool_calls)) {
            // Reasoning закончился, пошёл контент или tool_calls
            thinkingDoneSent = true
            onThinkingDone?.(Date.now() - thinkingStartMs)
          }

          // Tool call чанки — собираем по index
          if (delta.tool_calls) {
            hasToolCalls = true
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const isNewCall = !toolCallMap[idx]
              if (!toolCallMap[idx]) {
                toolCallMap[idx] = {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                }
              } else {
                if (tc.id && !toolCallMap[idx].id) toolCallMap[idx].id = tc.id
                if (tc.function?.name && !toolCallMap[idx].name) toolCallMap[idx].name = tc.function.name
                if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments
              }
              // Имя тула обычно приходит целиком в первом чанке этого index —
              // сигналим сразу, не дожидаясь аргументов (которые могут ещё
              // долго стримиться для edit_file/write_file с большим content).
              if (isNewCall && toolCallMap[idx].name) {
                onToolCallStarted?.(idx, toolCallMap[idx].name)
              }
            }
          }
        }

        // Финализация thinking — если стрим закончился, а done не был отправлен
        if (thinkingStartMs && !thinkingDoneSent) {
          onThinkingDone?.(Date.now() - thinkingStartMs)
        }

        // Ровно один usage на один вызов модели (провайдер мог дублировать
        // пакет usage в нескольких чанках — см. комментарий в цикле).
        if (usageOfRequest) {
          onUsage?.(usageOfRequest.promptTokens, usageOfRequest.completionTokens, usageOfRequest.cacheReadTokens, usageOfRequest.cacheWriteTokens)
        }

        // Собираем tool_calls в финальный формат
        const tool_calls = Object.values(toolCallMap).length > 0
          ? Object.values(toolCallMap).map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            }))
          : undefined

        return {
          content,
          tool_calls,
          reasoning: reasoning ? extractReasoningText(reasoning) : undefined,
          hadStreamedTokens: tokenBuffer.length > 0 && !tool_calls,
        }
      } catch (err: unknown) {
        const error = err as { status?: number; statusCode?: number; code?: string; name?: string; message?: string }
        const realStatus = error?.status ?? error?.statusCode ?? 0
        console.log('[AIClient] chatWithTools CATCH: status=%s statusCode=%s name=%s msg=%s (attempt=%d/%d)',
          error?.status ?? '—', error?.statusCode ?? '—', error?.name ?? '—',
          (error?.message ?? String(err)).slice(0, 200), attempt + 1, maxAttempts)
        log('[AIClient] chatWithTools CATCH: status=%s statusCode=%s name=%s msg=%s (attempt=%d/%d)',
          error?.status ?? '—', error?.statusCode ?? '—', error?.name ?? '—',
          (error?.message ?? String(err)).slice(0, 200), attempt + 1, maxAttempts)
        if (error?.name === 'AbortError' || signal?.aborted) {
          // Стоп посреди стрима: провайдер уже списал prompt — отдаём usage,
          // чтобы статистика хода и ledger не теряли оплаченный вызов.
          if (usageOfRequest) {
            onUsage?.(usageOfRequest.promptTokens, usageOfRequest.completionTokens, usageOfRequest.cacheReadTokens, usageOfRequest.cacheWriteTokens)
          }
          throw err
        }
        const errMsg = error?.message ?? String(err)
        const errLower = errMsg.toLowerCase()
        // ── Авто-фоллбэк на Responses API (только opencode-провайдеры) ──────
        // completions не поддерживается моделью (500/400/«not supported») →
        // пробуем /responses ДО сетевых ретраев (для таких моделей ретраи
        // completions бессмысленны — в логе это выглядело как 5×500).
        // Успех → запоминаем модель (в следующий раз идём в /responses сразу).
        if (!override?.providerId && this.isOpencodeRole(resolvedRole) && !responsesApi
          && !signal?.aborted
          && this.isCompletionsUnsupported({ status: realStatus || undefined, message: errMsg })) {
          try {
            log('[AIClient] completions не поддерживается (model=%s) — авто-фоллбэк на Responses API', model)
            const result = await this.chatWithToolsViaResponses(client, model, messages, tools, signal, maxTokens, reasoningExtra, isCodex, {
              onToken, onUsage, onThinkingToken, onThinkingDone, onToolCallStarted,
            })
            this.responsesOnlyModels.add(model)
            return result
          } catch (fbErr: unknown) {
            log('[AIClient] Responses-фоллбэк тоже не сработал (model=%s): %s', model,
              (fbErr as Error)?.message ?? String(fbErr))
          }
        }
        // 413 — Request too large. НЕРЕКУПЕРИРУЕМО: tool schemas не помещаются
        // в лимит TPM модели (например Groq gpt-oss-120b: TPM=8000, schemas=35K).
        // Ретраи бесполезны — контекст не уменьшится. Кидаем сразу с status=413
        // чтобы Agent.ts пошёл в ветку 413 → dropOldestRoundsIfOverflow → onError.
        if (realStatus === 413 || (errLower.includes('413') && errLower.includes('too large'))) {
          console.log('[AIClient] 413 Request too large — НЕ ретраим, кидаем сразу')
          log('[AIClient] 413 Request too large (model=%s): %s', model, errMsg.slice(0, 300))
          if (!error?.status) {
            try { (error as { status?: number }).status = 413 } catch { /* frozen */ }
          }
          throw err
        }
        // 429 Rate limit — ретраим с backoff + уведомляем
        if (realStatus === 429) {
          const delay = backoffDelay(attempt)
          const waitSec = Math.round(delay / 1000)
          log('[AIClient] 429 rate-limit, retry %d/%d через %ds (model=%s)', attempt + 1, maxAttempts, waitSec, model)
          onRateLimit?.(waitSec)
          onRetry?.(attempt + 1, 'rate_limit', waitSec, maxAttempts)
          if (Date.now() >= deadlineMs) {
            throw new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`)
          }
          await sleep(delay)
          attempt++
          continue
        }
        // 401 от gateway — access JWT протух (в т.ч. посреди длинного рана:
        // токен выдаётся на старте воркера и мог истечь за время цикла).
        // Один раз форс-рефрешим (worker → round-trip в main) и ретраим с
        // новым клиентом. Попытку НЕ инкрементируем — это не сетевой сбой.
        // Refresh вернул null — refresh-токен тоже мёртв → понятное сообщение
        // вместо сырого «401 status code (no body)».
        if (realStatus === 401 && isGateway && !retried401) {
          retried401 = true
          log('[AIClient] 401 от gateway (model=%s) — форс-рефреш токена и ретрай', model)
          const fresh = await refreshGatewayTokenAfter401()
          if (fresh) {
            gatewayToken = fresh
            client = this.observeClient(new OpenAI({ apiKey: fresh, baseURL: providerInfo!.provider.baseUrl, defaultHeaders: this.identityHeaders() }), providerInfo!.provider.id, resolvedRole)
            continue
          }
          throw new Error('Syntee session expired — sign in again (Profile → Sign In).')
        }
        // Сетевые ошибки (ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failed) — ретраим.
        // ВАЖНО: `!error?.status` раньше ловил ВСЕ ошибки без status (включая
        // 413 от прокси, который не выставляет .status) как "сетевые" →
        // 413 ретраился 4 раза, потом кидался в Agent.ts где status=0 →
        // попадал в generic catch → push user msg → continue → снова 413 →
        // бесконечный цикл до maxSteps. Теперь: без status ретраим только если
        // сообщение похоже на сетевую ошибку (fetch failed / connection и т.д.).
        const hasNetworkKeyword = errLower.includes('econnreset') || errLower.includes('etimedout') ||
          errLower.includes('enotfound') || errLower.includes('fetch failed') ||
          errLower.includes('network') || errLower.includes('socket') || errLower.includes('connection')
        const isNetwork = (realStatus === 0 && hasNetworkKeyword) || realStatus >= 500
        if (isNetwork && attempt < maxAttempts - 1) {
          const delay = backoffDelay(attempt)
          // Это единственная точка, где видна сырая причина обрыва стрима/
          // сетевого сбоя до того, как она превратится в обезличенный текст
          // статуса для UI. Логируем для последующей диагностики инцидентов
          // вида «зависло и само перезапустилось».
          log('[AIClient] сетевая ошибка, retry %d/%d (model=%s status=%s): %s',
            attempt + 1, maxAttempts, model, error?.status ?? '—', error?.message ?? String(err))
          onRetry?.(attempt + 1, 'network', undefined, maxAttempts)
          if (Date.now() >= deadlineMs) {
            throw new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`)
          }
          await sleep(delay)
          attempt++
          continue
        }
        // Фатальная ошибка (4xx, неизвестная) — бросаем сразу.
        // ВАЖНО: если прокси не выставил error.status, добавляем его
        // вручную из statusCode или из текста ошибки (413/429/400 и т.д.),
        // чтобы Agent.ts мог правильно выбрать ветку обработки.
        log('[AIClient] фатальная ошибка API (model=%s status=%s statusCode=%s): %s',
          model, error?.status ?? '—', error?.statusCode ?? '—', error?.message ?? String(err))
        if (!error?.status && realStatus > 0) {
          try { (error as { status?: number }).status = realStatus } catch { /* frozen */ }
        }
        if (!error?.status) {
          // Пытаемся извлечь status из текста ошибки ("413 Request too large...")
          const statusMatch = (error?.message ?? '').match(/^(\d{3})\s/)
          if (statusMatch) {
            try { (error as { status?: number }).status = parseInt(statusMatch[1]) } catch { /* frozen */ }
          }
        }
        throw err
      }
    }
    throw new Error('Agent: превышено число попыток запросов к API')
  }



  async analyzeImage(imageBase64: string, prompt: string, callbacks: StreamCallbacks, mime?: string): Promise<void> {
    const model = this.getModel('vision')
    let client = await this.getClientForRoleAsync('vision')
    let attempt = 0
    let retried401 = false
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    const VISION_STREAM_TIMEOUT_MS = 60_000 // 60с — таймаут на стрим vision-модели
    while (attempt <= this.maxRetries) {
      // AbortController для таймаута стрима — если провайдер держит соединение,
      // но не шлёт данные, прерываем через 60с вместо бесконечного ожидания.
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), VISION_STREAM_TIMEOUT_MS)
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${mime || 'image/png'};base64,${imageBase64}`, detail: 'high' } },
            { type: 'text', text: prompt },
          ]}],
          stream: true, stream_options: { include_usage: true }, max_tokens: 4096, temperature: 0,
        }, { signal: controller.signal })
        let fullText = ''
        for await (const chunk of stream) {
          const token = chunk.choices[0]?.delta?.content || ''
          if (token) { fullText += token; callbacks.onToken(token) }
        }
        clearTimeout(timeoutId)
        callbacks.onDone(fullText)
        return
      } catch (err: unknown) {
        clearTimeout(timeoutId)
        const error = err as { status?: number; name?: string }
        // AbortError — таймаут стрима
        if (error?.name === 'AbortError' || (err as Error)?.message?.includes('abort')) {
          callbacks.onError(new Error(`Vision stream timeout (${VISION_STREAM_TIMEOUT_MS / 1000}s) — провайдер не отвечает.`))
          return
        }
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          callbacks.onRateLimit?.(Math.round(delay / 1000))
          if (Date.now() >= deadlineMs) {
            callbacks.onError(new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`))
            return
          }
          await sleep(delay); attempt++; continue
        }
        // 401 от gateway — форс-рефреш JWT + один ретрай (см. chatWithTools)
        if (error?.status === 401 && !retried401 && this.isGatewayRole('vision')) {
          retried401 = true
          const fresh = await refreshGatewayTokenAfter401()
          if (fresh) { client = await this.getClientForRoleAsync('vision'); continue }
          callbacks.onError(new Error('Syntee session expired — sign in again (Profile → Sign In).'))
          return
        }
        callbacks.onError(err as Error)
        return
      }
    }
    // Все retry-попытки исчерпаны (429 на каждой) — не оставляем Promise висеть.
    callbacks.onError(new Error(`Max retries (${this.maxRetries}) exceeded — rate limit persists.`))
  }

  async embed(text: string): Promise<number[]> {
    const model = (this.store.get('embeddingModel') as string) || 'gemini-embedding-2'
    let attempt = 0
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt <= this.maxRetries) {
      try {
        const res = await this.client.embeddings.create({ model, input: text })
        return res.data[0].embedding
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          if (Date.now() >= deadlineMs) {
            throw new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`)
          }
          await sleep(backoffDelay(attempt)); attempt++; continue
        }
        throw err
      }
    }
    throw new Error('Embed: rate limit')
  }
}
