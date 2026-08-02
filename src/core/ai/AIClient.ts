import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type Store from 'electron-store'
// СТАТИЧЕСКИЙ импорт: нативный import() не работает внутри V8-байткода
// (bytenode-лоадер компилирует через vm.Script без importModuleDynamically —
// "A dynamic import callback was not specified"). require — безопасен.
import { isMainThread, workerData } from 'worker_threads'
import { buildReasoningParams } from '../../shared/reasoningModels'
import { getNextApiKey } from '../../shared/roundRobin'
import type { Provider } from '../../shared/types'
import { isAnthropicProvider } from './anthropicConverters'
import { log, sleep, backoffDelay, OVERALL_TIMEOUT_MS, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, extractReasoningText } from './shared'
import { chatWithToolsAnthropic } from './anthropicNative'
import { computeContextSnapshot } from '../tokens/usageTracker'
import type { ContextCountedInfo } from '../agent/types'

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

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: (fullText: string) => void
  onError: (error: Error) => void
  onRateLimit?: (waitSec: number) => void
  onThinkingToken?: (token: string) => void
  onThinkingDone?: (ms: number) => void
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void
  onContextCounted?: (info: ContextCountedInfo) => void
  onWaiting?: () => void                                      // запрос ушёл, ждём первый токен
  onRetry?: (attempt: number, reason: string, waitSec?: number, maxAttempts?: number) => void  // ретрай с причиной + лимит для UI «повтор 3/5»
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export class AIClient {
  private client: OpenAI
  private maxRetries = 6

  constructor(private store: Store) {
    this.client = this.createClient()
  }

  private createClient(): OpenAI {
    const apiKey = (this.store.get('apiKey') as string) || '***'
    // Только явный URL из настроек. OnlySQ-дефолт удалён — модели идут через
    // мульти-провайдерную систему. Если endpoint пуст, клиент всё равно
    // создаётся (для совместимости), но запросы без назначения упадут.
    const endpoint = (this.store.get('apiEndpoint') as string) || ''
    return new OpenAI({ apiKey, baseURL: endpoint || undefined })
  }

  reload(): void {
    this.client = this.createClient()
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

  private getModel(type: 'main' | 'fast' | 'fastContext' | 'vision' | 'summary' | 'router' | 'emotion' | 'subagent'): string {
    const defaults: Record<string, string> = {
      main: 'claude-sonnet-4-6', fast: 'north-mini-code-free',
      fastContext: 'inclusionai/ling-3.0-flash:free',
      vision: 'gpt-4o', summary: 'claude-haiku-4-5',
      router: 'claude-haiku-4-5', emotion: 'claude-haiku-4-5',
      subagent: '',
    }
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const found = assignments?.find(a => a.role === type)
    if (found?.modelId) return found.modelId
    return (this.store.get(`${type}Model`) as string) || defaults[type]
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

    // Round-robin: выбираем следующий ключ из списка
    const { key, updatedProviders } = getNextApiKey(providers || [], assignment.providerId)
    if (!key) return null

    // Сохраняем обновлённый индекс в store
    this.store.set('providers', updatedProviders)

    return { provider, apiKey: key }
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
      console.log(`[AIClient] gateway token: ${token ? 'OK (' + token.slice(0, 20) + '...)' : 'NULL'}`)
      if (!token) {
        throw new Error('Не авторизован в Syntee-Gateway. Войдите через Профиль → Войти.')
      }
      return new OpenAI({ apiKey: token, baseURL: info.provider.baseUrl })
    }
    return new OpenAI({ apiKey: info.apiKey, baseURL: info.provider.baseUrl })
  }

  async streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    modelType: 'main' | 'fast' | 'fastContext' = 'main',
    systemPrompt?: string,
    signal?: AbortSignal,
    temperatureOverride?: number,
  ): Promise<void> {
    const model = this.getModel(modelType)
    let client = await this.getClientForRoleAsync(modelType)

    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt })
    allMessages.push(...messages)

    // Считаем реальный контекст через tiktoken — то что идёт в запрос.
    // Единая функция: breakdown {system, history, tools:0 (no-tools path), current:0}.
    if (callbacks.onContextCounted && modelType === 'main') {
      try {
        const systemMsg = allMessages[0]?.role === 'system' ? allMessages[0] : undefined
        const rest = (systemMsg ? allMessages.slice(1) : allMessages) as Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string; name?: string }>
        const snap = computeContextSnapshot(rest, Number.MAX_SAFE_INTEGER, {
          systemPrompt: typeof systemMsg?.content === 'string' ? systemMsg.content : undefined,
          includeToolSchemas: false,
        })
        callbacks.onContextCounted({
          promptTokens: snap.estimated,
          breakdown: snap.breakdown as ContextCountedInfo['breakdown'],
        })
      } catch { /* ok — tiktoken не критичен */ }
    }

    // Берём reasoning параметры из store (выбраны пользователем в UI)
    const reasoningValue = (this.store.get('reasoningValue') as string) || ''
    const reasoningExtra = reasoningValue ? buildReasoningParams(model, reasoningValue) : {}

    let attempt = 0
    let retried401 = false
    let fullText = ''
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

        for await (const chunk of stream) {
          if (signal?.aborted) break

          // Реальные токены из провайдера — последний чанк содержит usage
          if (chunk.usage) {
            const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
            if (u.prompt_tokens != null) {
              callbacks.onUsage?.({
                promptTokens: u.prompt_tokens,
                completionTokens: u.completion_tokens ?? 0,
                totalTokens: u.total_tokens ?? (u.prompt_tokens + (u.completion_tokens ?? 0)),
              })
            }
          }

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
        }

        callbacks.onDone(fullText)
        return

      } catch (err: unknown) {
        const error = err as { status?: number; message?: string; name?: string }
        if (error?.name === 'AbortError' || signal?.aborted) {
          callbacks.onDone(fullText ?? '')
          return
        }
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          const waitSec = Math.round(delay / 1000)
          callbacks.onRateLimit?.(waitSec)
          callbacks.onRetry?.(attempt + 1, 'rate_limit', waitSec, this.maxRetries + 1)
          if (Date.now() >= deadlineMs) {
            callbacks.onError(new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`))
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
          callbacks.onError(new Error('Сессия Syntee истекла — войдите заново (Профиль → Войти).'))
          return
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
            callbacks.onError(new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`))
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

  async complete(
    messages: ChatMessage[],
    modelType: 'main' | 'fast' | 'fastContext' | 'summary' | 'router' | 'emotion' = 'fast',
    systemPrompt?: string
  ): Promise<string> {
    const model = this.getModel(modelType)
    let client = await this.getClientForRoleAsync(modelType)
    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt })
    allMessages.push(...messages)

    let attempt = 0
    let retried401 = false
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt <= this.maxRetries) {
      try {
        const res = await client.chat.completions.create({
          model, messages: allMessages, stream: false,
          temperature: 0.3, max_tokens: 1024,
        })
        return res.choices[0]?.message?.content || ''
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          if (Date.now() >= deadlineMs) {
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
          }
          await sleep(backoffDelay(attempt)); attempt++; continue
        }
        // 401 от gateway — форс-рефреш JWT + один ретрай (см. chatWithTools)
        if (error?.status === 401 && !retried401 && this.isGatewayRole(modelType)) {
          retried401 = true
          const fresh = await refreshGatewayTokenAfter401()
          if (fresh) { client = await this.getClientForRoleAsync(modelType); continue }
          throw new Error('Сессия Syntee истекла — войдите заново (Профиль → Войти).')
        }
        throw err
      }
    }
    throw new Error('Rate limit: превышено число попыток')
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

  async chatWithTools(
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: unknown[],
    signal?: AbortSignal,
    role: 'main' | 'subagent' = 'main',
    onToken?: (token: string) => void,
    onContextCounted?: (info: ContextCountedInfo) => void,
    onRateLimit?: (waitSec: number) => void,
    onRetry?: (attempt: number, reason: string, waitSec?: number) => void,
    onUsage?: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => void,
    onThinkingToken?: (token: string) => void,
    onThinkingDone?: (ms: number) => void,
    // Вызывается один раз на каждый tool_call, как только известно его имя —
    // ЕЩЁ ДО того, как модель полностью догенерирует JSON аргументов (который
    // может быть большим для edit_file/write_file и занимать заметное время).
    // index стабилен в рамках раунда (см. tc.index у провайдера) — по нему
    // Agent.ts матчит этот ранний сигнал с финальным tool_call.
    onToolCallStarted?: (index: number, toolName: string) => void,
  ): Promise<{ content: string; tool_calls?: unknown[]; reasoning?: string; hadStreamedTokens?: boolean }> {
    const effectiveRole = role === 'subagent' ? 'subagent' as never : 'main'
    const subagentModel = role === 'subagent' ? this.getModel('subagent' as never) : ''
    const resolvedRole = (subagentModel && subagentModel !== '') ? effectiveRole : 'main'
    const model = this.getModel(resolvedRole) || this.getModel('main')
    const providerInfo = this.getProviderInfoForRole(resolvedRole)
    // Для syntee-gateway apiKey === '__JWT__' — реальный JWT получаем ниже.
    const isGateway = providerInfo?.apiKey === '__JWT__'
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
        throw new Error('Не авторизован в Syntee-Gateway. Войдите через Профиль → Войти.')
      }
    }
    const temperature = DEFAULT_TEMPERATURE
    const maxTokensRaw = DEFAULT_MAX_TOKENS
    const reasoningValue = (this.store.get('reasoningValue') as string) || ''
    const reasoningExtra = reasoningValue ? buildReasoningParams(model, reasoningValue) : {}

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

    // Считаем реальный контекст через tiktoken перед каждым раундом агента.
    // messages уже содержат system[0] + history (с tool_calls) + current user.
    // Единая функция computeContextSnapshot даёт консистентный breakdown
    // (раньше тут был inline `+3800+2` и весь breakdown клался в history).
    if (onContextCounted) {
      try {
        const systemMsg = messages[0]?.role === 'system' ? messages[0] : undefined
        const rest = systemMsg ? messages.slice(1) : messages
        const snap = computeContextSnapshot(rest, Number.MAX_SAFE_INTEGER, {
          systemPrompt: systemMsg?.content as string | undefined,
          includeToolSchemas: true,
        })
        onContextCounted({
          promptTokens: snap.estimated,
          breakdown: snap.breakdown as ContextCountedInfo['breakdown'],
        })
      } catch { /* ok */ }
    }

    // Anthropic-нативный путь с prompt caching (cache_control на system + tools).
    // Срабатывает когда провайдер имеет type='anthropic' или baseUrl=api.anthropic.com.
    // OnlySQ-прокси больше не используется; gateway-провайдер идёт через JWT.
    if (providerInfo && isAnthropicProvider(providerInfo.provider)) {
      const anthropicApiKey = isGateway ? gatewayToken! : providerInfo.apiKey
      const anthropicClient = new Anthropic({
        apiKey: anthropicApiKey,
        baseURL: providerInfo.provider.baseUrl,
      })
      return chatWithToolsAnthropic(
        anthropicClient, messages, tools, signal, model, temperature, maxTokens, reasoningExtra,
        { onToken, onRateLimit, onRetry, onUsage, onThinkingToken, onThinkingDone, onToolCallStarted }
      )
    }

    // OpenAI-совместимый путь (включая syntee-gateway через JWT)
    let client = providerInfo
      ? new OpenAI({
          apiKey: isGateway ? gatewayToken! : providerInfo.apiKey,
          baseURL: providerInfo.provider.baseUrl,
        })
      : this.client

    let attempt = 0
    let retried401 = false
    const maxAttempts = 5
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt < maxAttempts) {
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
            if (usage.prompt_tokens != null) {
              // OpenAI/прокси может вернуть cached_tokens — передаём как cacheReadTokens.
              // cacheWriteTokens для OpenAI не применим (автокэширование без маркеров).
              onUsage?.(usage.prompt_tokens, usage.completion_tokens ?? 0, usage.prompt_tokens_details?.cached_tokens)
            }
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
        if (error?.name === 'AbortError' || signal?.aborted) throw err
        const errMsg = error?.message ?? String(err)
        const errLower = errMsg.toLowerCase()
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
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
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
            client = new OpenAI({ apiKey: fresh, baseURL: providerInfo!.provider.baseUrl })
            continue
          }
          throw new Error('Сессия Syntee истекла — войдите заново (Профиль → Войти).')
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
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
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



  async analyzeImage(imageBase64: string, prompt: string, callbacks: StreamCallbacks): Promise<void> {
    const model = this.getModel('vision')
    let client = await this.getClientForRoleAsync('vision')
    let attempt = 0
    let retried401 = false
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt <= this.maxRetries) {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ]}],
          stream: true, max_tokens: 2048,
        })
        let fullText = ''
        for await (const chunk of stream) {
          const token = chunk.choices[0]?.delta?.content || ''
          if (token) { fullText += token; callbacks.onToken(token) }
        }
        callbacks.onDone(fullText)
        return
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          callbacks.onRateLimit?.(Math.round(delay / 1000))
          if (Date.now() >= deadlineMs) {
            callbacks.onError(new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`))
            return
          }
          await sleep(delay); attempt++; continue
        }
        // 401 от gateway — форс-рефреш JWT + один ретрай (см. chatWithTools)
        if (error?.status === 401 && !retried401 && this.isGatewayRole('vision')) {
          retried401 = true
          const fresh = await refreshGatewayTokenAfter401()
          if (fresh) { client = await this.getClientForRoleAsync('vision'); continue }
          callbacks.onError(new Error('Сессия Syntee истекла — войдите заново (Профиль → Войти).'))
          return
        }
        callbacks.onError(err as Error)
        return
      }
    }
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
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
          }
          await sleep(backoffDelay(attempt)); attempt++; continue
        }
        throw err
      }
    }
    throw new Error('Embed: rate limit')
  }
}
