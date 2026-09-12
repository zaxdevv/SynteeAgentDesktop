import type Anthropic from '@anthropic-ai/sdk'
import {
  convertToolsToAnthropic,
  convertMessagesToAnthropic,
} from './anthropicConverters'
import { log, sleep, backoffDelay, OVERALL_TIMEOUT_MS } from './shared'

/**
 * Нативный Anthropic Messages API путь с prompt caching.
 *
 * Использует @anthropic-ai/sdk для прямого общения с api.anthropic.com
 * (или Anthropic-совместимым прокси). В отличие от OpenAI-пути:
 *   - system prompt — top-level параметр, не message в массиве
 *   - content — массив content-блоков (tool_use, tool_result, thinking)
 *   - cache_control:{type:'ephemeral'} на system и последнем tool → кэширование
 *   - usage включает cache_read_input_tokens и cache_creation_input_tokens
 *
 * Возвращает тот же формат, что и chatWithTools (OpenAI-совместимый),
 * чтобы Agent.ts работал с обоими путями одинаково.
 */
export async function chatWithToolsAnthropic(
  client: Anthropic,
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>; tool_calls?: unknown[]; tool_call_id?: string; name?: string; thinking_blocks?: Array<{ thinking: string; signature: string }> }>,
  tools: unknown[],
  signal: AbortSignal | undefined,
  model: string,
  temperature: number,
  maxTokens: number,
  reasoningExtra: Record<string, unknown>,
  callbacks: {
    onToken?: (token: string) => void
    onRateLimit?: (waitSec: number) => void
    onRetry?: (attempt: number, reason: string, waitSec?: number, maxAttempts?: number) => void
    onUsage?: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => void
    onThinkingToken?: (token: string) => void
    onThinkingDone?: (ms: number) => void
    onToolCallStarted?: (index: number, toolName: string) => void
  },
): Promise<{ content: string; tool_calls?: unknown[]; reasoning?: string; hadStreamedTokens?: boolean; thinking_blocks?: Array<{ thinking: string; signature: string }> }> {
  const { onToken, onRateLimit, onRetry, onUsage, onThinkingToken, onThinkingDone, onToolCallStarted } = callbacks

  // Конвертируем messages и tools в Anthropic формат (с cache_control)
  const converted = convertMessagesToAnthropic(messages)
  const anthropicTools = convertToolsToAnthropic(tools)

  // Запрос
  const params: Record<string, unknown> = {
    model,
    messages: converted.messages,
    stream: true,
    max_tokens: maxTokens,
  }
  if (converted.system.length > 0) {
    params.system = converted.system
  }
  if (anthropicTools.length > 0) {
    params.tools = anthropicTools
    params.tool_choice = { type: 'auto' }
  }
  // При extended thinking Anthropic требует temperature=1 (или omit).
  // 'none' — явное выключение мышления: thinking не шлём, temperature нужен.
  const effort = typeof reasoningExtra.reasoning_effort === 'string' ? reasoningExtra.reasoning_effort : undefined
  const hasThinking = !!reasoningExtra.thinking || (!!effort && effort !== 'none')
  if (!hasThinking) {
    params.temperature = temperature
  }
  // reasoningExtra для Claude приходит в двух видах:
  //  - effort-модели (Claude 4.6+/5 по models.dev) → {reasoning_effort: level}.
  //    Нативный Messages API его не принимает — переводим в adaptive thinking:
  //    thinking:{type:'adaptive'} + output_config:{effort} (manual budget_tokens
  //    на 4.6 deprecated, на 5.x/4.7+ type:'enabled' возвращает 400).
  //    'none' — «off»: Anthropic не принимает effort:'none' (только
  //    low/medium/high/max) → не шлём thinking вовсе.
  //  - budget-модели (Claude 4.5 и раньше) → {thinking:{type:'enabled',
  //    budget_tokens:N}} — формат уже совместим с нативным API, передаём as-is.
  let reasoningParams = reasoningExtra
  if (effort) {
    reasoningParams = effort === 'none'
      ? {}
      : {
          thinking: { type: 'adaptive' },
          output_config: { effort },
        }
  }
  Object.assign(params, reasoningParams)

  let attempt = 0
  const maxAttempts = 5
  const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS

  while (attempt < maxAttempts) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = await (client.messages.create as any)(params, { signal })

      let content = ''
      let reasoning = ''
      // Accumulate thinking blocks with signatures — required to echo
      // back in next round when the assistant message contains tool_use.
      // Each thinking content_block has its own signature sent via
      // signature_delta events. We track per-block index.
      const thinkingBlocks: Array<{ thinking: string; signature: string }> = []
      const blockThinking: Record<number, string> = {}
      const blockSignature: Record<number, string> = {}
      let thinkingStartMs = 0
      let thinkingDoneSent = false
      const tokenBuffer: string[] = []

      // Tool call accumulation: index → {id, name, jsonBuffer}
      const toolCallMap: Record<number, { id: string; name: string; jsonBuffer: string }> = {}
      const toolCallIndices: number[] = [] // preserve insertion order
      let hasToolCalls = false

      // Usage accumulation (input — из message_start, output — из message_delta)
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const event of stream as any) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

        switch (event.type) {
          case 'message_start': {
            const usage = event.message?.usage
            if (usage) {
              inputTokens = usage.input_tokens ?? 0
              cacheReadTokens = usage.cache_read_input_tokens ?? 0
              cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
            }
            break
          }

          case 'content_block_start': {
            const idx: number = event.index ?? 0
            const block = event.content_block

            // Переход от thinking к контенту/tool_use → сигнал thinking done
            if (thinkingStartMs && !thinkingDoneSent && block?.type !== 'thinking') {
              thinkingDoneSent = true
              onThinkingDone?.(Date.now() - thinkingStartMs)
            }

            if (block?.type === 'tool_use') {
              hasToolCalls = true
              toolCallMap[idx] = {
                id: block.id ?? '',
                name: block.name ?? '',
                jsonBuffer: '',
              }
              toolCallIndices.push(idx)
              if (block.name) {
                onToolCallStarted?.(idx, block.name)
              }
            } else if (block?.type === 'thinking') {
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              // Initialize per-block thinking accumulator (signature comes
              // via signature_delta events after the block's thinking text).
              blockThinking[idx] = ''
              blockSignature[idx] = ''
            }
            break
          }

          case 'content_block_delta': {
            const idx: number = event.index ?? 0
            const delta = event.delta
            if (!delta) break

            if (delta.type === 'text_delta') {
              const text: string = delta.text ?? ''
              if (text) {
                content += text
                if (!hasToolCalls) {
                  tokenBuffer.push(text)
                  onToken?.(text)
                }
              }
            } else if (delta.type === 'input_json_delta') {
              const partial: string = delta.partial_json ?? ''
              if (toolCallMap[idx]) {
                toolCallMap[idx].jsonBuffer += partial
              }
            } else if (delta.type === 'thinking_delta') {
              const think: string = delta.thinking ?? ''
              if (think) {
                if (!thinkingStartMs) thinkingStartMs = Date.now()
                reasoning += think
                if (blockThinking[idx] !== undefined) blockThinking[idx] += think
                onThinkingToken?.(think)
              }
            } else if (delta.type === 'signature_delta') {
              // signature_delta — verification token for the thinking block.
              // MUST be preserved to echo the thinking block back in the
              // next round; Anthropic validates it on resubmission.
              const sig: string = delta.signature ?? ''
              if (sig && blockSignature[idx] !== undefined) blockSignature[idx] += sig
            }
            // (other delta types ignored)
            break
          }

          case 'content_block_stop': {
            // tool_use блок завершён — JSON аргументов накоплен в jsonBuffer
            // thinking блок завершён — финализируем и добавляем в thinkingBlocks
            const idx: number = event.index ?? 0
            if (blockThinking[idx] !== undefined) {
              const text = blockThinking[idx]
              const sig = blockSignature[idx] || ''
              if (text) {
                thinkingBlocks.push({ thinking: text, signature: sig })
              }
              delete blockThinking[idx]
              delete blockSignature[idx]
            }
            break
          }

          case 'message_delta': {
            const usage = event.usage
            if (usage?.output_tokens != null) {
              outputTokens = usage.output_tokens
            }
            break
          }

          case 'message_stop':
            break
        }
      }

      // Финализация thinking
      if (thinkingStartMs && !thinkingDoneSent) {
        onThinkingDone?.(Date.now() - thinkingStartMs)
      }

      // Usage callback с cache-токенами.
      // Anthropic: input_tokens = только non-cached, cache — отдельно.
      // Нормализуем: totalPrompt = input + cacheRead + cacheWrite (как OpenAI),
      // cache-токены передаём отдельно для тарификации и UI.
      if (inputTokens > 0 || outputTokens > 0) {
        const totalPrompt = inputTokens + cacheReadTokens + cacheWriteTokens
        onUsage?.(totalPrompt, outputTokens, cacheReadTokens || undefined, cacheWriteTokens || undefined)
      }

      // Собираем tool_calls в OpenAI-совместимый формат (для Agent.ts)
      const tool_calls = toolCallIndices.length > 0
        ? toolCallIndices.map(idx => {
            const tc = toolCallMap[idx]
            return {
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: tc.jsonBuffer || '{}',
              },
            }
          })
        : undefined

      return {
        content,
        tool_calls,
        reasoning: reasoning || undefined,
        hadStreamedTokens: tokenBuffer.length > 0 && !tool_calls,
        thinking_blocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      }

    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; name?: string; message?: string }
      // AbortError — не ретраим, бросаем сразу
      if (error?.name === 'AbortError' || signal?.aborted) throw err
      // 429 Rate limit — ретраим с backoff + уведомляем
      if (error?.status === 429) {
        const delay = backoffDelay(attempt)
        const waitSec = Math.round(delay / 1000)
        log('[AIClient/Anthropic] 429 rate-limit, retry %d/%d через %ds (model=%s)', attempt + 1, maxAttempts, waitSec, model)
        onRateLimit?.(waitSec)
        onRetry?.(attempt + 1, 'rate_limit', waitSec, maxAttempts)
        if (Date.now() >= deadlineMs) {
          throw new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`)
        }
        await sleep(delay)
        attempt++
        continue
      }
      // Сетевые ошибки — ретраим
      const msg = error?.message?.toLowerCase() ?? ''
      const isNetwork = !error?.status || error.status >= 500 ||
        msg.includes('econnreset') || msg.includes('etimedout') ||
        msg.includes('enotfound') || msg.includes('fetch failed') ||
        msg.includes('network') || msg.includes('socket')
      if (isNetwork && attempt < maxAttempts - 1) {
        const delay = backoffDelay(attempt)
        log('[AIClient/Anthropic] сетевая ошибка, retry %d/%d (model=%s status=%s): %s',
          attempt + 1, maxAttempts, model, error?.status ?? '—', error?.message ?? String(err))
        onRetry?.(attempt + 1, 'network', undefined, maxAttempts)
        if (Date.now() >= deadlineMs) {
          throw new Error(`Overall AI response wait time exceeded (${Math.round(OVERALL_TIMEOUT_MS / 1000)}s). Try again later or switch provider.`)
        }
        await sleep(delay)
        attempt++
        continue
      }
      // Фатальная ошибка (4xx, неизвестная) — бросаем сразу
      log('[AIClient/Anthropic] фатальная ошибка API (model=%s status=%s): %s',
        model, error?.status ?? '—', error?.message ?? String(err))
      throw err
    }
  }
  throw new Error('Agent: превышено число попыток запросов к API')
}
