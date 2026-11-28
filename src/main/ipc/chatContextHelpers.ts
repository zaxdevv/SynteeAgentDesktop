import type { Message, ReplyTarget } from '../../shared/types'
import type { ChatMessage } from '../../core/context/contextManager'
import { stripAttachTokens } from '../../shared/attachmentMarkdown'
import { STEER_MARKER } from '../../shared/steer'

/**
 * Сколько tool-call'ов было в чате — для метаданных кольца контекста.
 *
 * Раньше этот reduce был скопирован в трёх эмиттерах CONTEXT_USAGE
 * (chat:send, context:calculate, post-compact). Один список — одно место.
 */
export function countToolCalls(messages: Message[]): number {
  return messages.reduce((sum, message) => {
    const steps = message.toolSteps as Array<{ type: string }> | undefined
    return sum + (steps?.filter(step => step.type === 'tool_call').length ?? 0)
  }, 0)
}

/**
 * Форматирует реплай-цитаты для AI-контекста: на какое сообщение отвечает
 * пользователь. Полный текст исходника (до 2000 симв.) с построчным «>»-
 * цитированием; serve-токены вложений [[attach:id]] вычищаются.
 *
 * Единая точка сборки цитаты — используется в двух местах:
 *   - runChatSend (chat.ipc.ts) — текущий запрос;
 *   - messageToContextMessages — история на следующих ходах.
 * Благодаря этому формат идентичен и цитата не дублируется (в текущем
 * запросе user-сообщение ещё не в истории, в следующих — берётся из БД).
 */
export function formatReplyQuote(replyTo: ReplyTarget[]): string {
  return replyTo.map(r => {
    const who = r.role === 'user' ? 'Пользователь' : 'Syntee'
    let body = stripAttachTokens(r.content || '')
    if (!body && r.attachmentsCount) body = `[сообщение с вложением: ${r.attachmentsCount} файл(ов)]`
    if (body.length > 2000) body = body.slice(0, 2000) + '…'
    const quoted = body.split('\n').map(l => `> ${l}`).join('\n')
    return `> [Ответ на сообщение ${who}]:\n${quoted}`
  }).join('\n\n')
}

/**
 * Разворачивает Message с toolSteps в массив полноценных OpenAI-совместимых
 * сообщений: assistant (с tool_calls) + tool (с результатами).
 *
 * Раньше toolSteps сжимались в компактный текстовый trace (400 симв. на шаг),
 * из-за чего агент терял результаты предыдущих tool-вызовов (содержимое
 * файлов, результаты команд) и был вынужден перечитывать всё заново.
 * Теперь полная история tool-вызовов передаётся в нативном формате API.
 *
 * ВАЖНО: planData больше НЕ является особым случаем. Раньше при наличии
 * planData функция делала ранний return, отдавая только компактный текст
 * плана — при этом все toolSteps (результаты исследований: чтения файлов,
 * поисков) терялись. При переходе из planning mode в execution mode агент
 * не видел результатов своих исследований и перечитывал всё заново.
 * Теперь planData обрабатывается наравне с обычными сообщениями:
 *   - planData без toolSteps → message.content (содержит <plan> теги)
 *   - planData с toolSteps → полный разворот tool_calls + tool_results
 * UI PlanCard читает planData из БД напрямую, эта функция его не затрагивает.
 */
export function messageToContextMessages(message: Message, includeTodo = true): ChatMessage[] {
  const steps = message.toolSteps ?? []
  const todo = includeTodo ? message.todo : undefined

  // Нет toolSteps — обычное текстовое сообщение
  if (message.role !== 'assistant' || steps.length === 0) {
    // Даже для текстового сообщения без toolSteps — если есть todo,
    // инжектим его (user-роль, после assistant) чтобы AI видел свой
    // незавершённый план из прошлой итерации. Без этого AI не знает
    // что todo сохраняется между сообщениями и не может продолжить.
    if (message.role === 'assistant' && todo?.length) {
      return [
        {
          role: 'assistant' as const,
          content: message.content,
          ...(message.thinkingBlocks?.length ? { thinking_blocks: message.thinkingBlocks } : {}),
          ...(message.thinking ? { reasoning_content: message.thinking } : {}),
        },
        { role: 'user' as const, content: formatTodoForContext(todo) },
      ]
    }
    if (message.role === 'assistant' && message.thinkingBlocks?.length) {
      return [{
        role: message.role as ChatMessage['role'],
        content: message.content,
        thinking_blocks: message.thinkingBlocks,
        ...(message.thinking ? { reasoning_content: message.thinking } : {}),
      }]
    }
    if (message.role === 'assistant' && message.thinking) {
      return [{
        role: message.role as ChatMessage['role'],
        content: message.content,
        reasoning_content: message.thinking,
      }]
    }
    // Реплай-цитаты user-сообщения: AI видит на какие сообщения отвечал
    // пользователь не только в текущем запросе (цитата в runChatSend), но и
    // в истории на следующих ходах — цитата восстанавливается из message.replyTo.
    if (message.role === 'user' && message.replyTo?.length) {
      return [{
        role: 'user' as const,
        content: `${formatReplyQuote(message.replyTo)}\n\n${message.content}`,
      }]
    }
    return [{ role: message.role as ChatMessage['role'], content: message.content }]
  }

  // Группируем steps по итерациям: каждая итерация = assistant с tool_calls
  // + последующие tool results. Сохраняем текст между итерациями.
  type Iteration = {
    textBefore?: string
    calls: Array<{ callId: string; toolName: string; toolArgs: Record<string, unknown> }>
    results: Map<string, { content: string; success?: boolean; toolName?: string; imagePaths?: string[]; janitorProtected?: boolean }>
  }

  const iterations: Iteration[] = []
  // §steer — реплики пользователя, внедрённые в контекст посреди этого рана.
  // Отдельного user-сообщения в БД они не создают (живут шагами внутри
  // assistant-сообщения), поэтому при пересборке истории восстанавливаем их
  // как user-сообщения — иначе следующий ход «забыл бы» о правке.
  const steerTexts: string[] = []
  let currentIter: Iteration | null = null
  let pendingCall: { callId: string; toolName: string; toolArgs: Record<string, unknown> } | null = null

  for (const step of steps) {
    if (step.type === 'steer') {
      // §steer — content хранится с [[attach:id]]-токенами (карточка рендерит
      // по ним чипы); в контекст истории они не должны попадать — вычищаем.
      // Сами вложения, как у обычных user-сообщений, пикселями в историю не
      // возвращаются: инлайн-блоки файлов модель видела в момент внедрения.
      if (typeof step.content === 'string' && step.content.trim()) {
        const clean = stripAttachTokens(step.content).trim()
        if (clean) steerTexts.push(clean)
      }
      continue
    }
    if (step.type === 'tool_call') {
      // Новая итерация только если предыдущая уже имеет results
      // (т.е. предыдущий раунд завершён). Раньше условие было
      // `calls.length > 0 || results.size > 0` — это разбивало
      // параллельные tool_calls (из одного раунда) на отдельные
      // итерации, и результаты попадали не в ту итерацию →
      // assistant с tool_calls без results → провайдер 400 →
      // чат ломался навсегда после первого раунда с параллельными тулами.
      if (!currentIter || currentIter.results.size > 0) {
        currentIter = { calls: [], results: new Map() }
        iterations.push(currentIter)
      }
      const callId = step.callId || `call_${iterations.length}_${currentIter.calls.length}`
      currentIter.calls.push({
        callId,
        toolName: step.toolName || 'tool',
        toolArgs: step.toolArgs || {},
      })
      pendingCall = { callId, toolName: step.toolName || 'tool', toolArgs: step.toolArgs || {} }
    } else if (step.type === 'tool_result') {
      if (!currentIter) {
        currentIter = { calls: [], results: new Map() }
        iterations.push(currentIter)
      }
      const callId = step.callId || pendingCall?.callId || `call_${iterations.length}_${currentIter.results.size}`
      currentIter.results.set(callId, {
        content: step.toolName === 'analyze_image' && !step.imagePaths?.length && step.content?.includes('приложено к этому результату')
          ? `${step.content}\n[History: this old tool record contains only text; the image is NOT attached. Call analyze_image again if pixels are needed.]`
          : step.content || '',
        success: step.success,
        janitorProtected: !!message.isPinned || step.success === false
          || !!(step.diff || step.imageUrl || step.imagePaths?.length || step.visualAnalysis),
        imagePaths: step.imagePaths,
        toolName: step.toolName || pendingCall?.toolName,
      })
      pendingCall = null
    }
  }

  // Если итераций нет — просто текст (но мог быть todo и/или §steer)
  const steerMessages: ChatMessage[] = steerTexts.map(t => ({
    role: 'user' as const,
    content: `${STEER_MARKER}\n\n${t}`,
  }))
  if (iterations.length === 0) {
    if (todo?.length) {
      return [
        ...steerMessages,
        {
          role: 'assistant' as const,
          content: message.content,
          ...(message.thinking ? { reasoning_content: message.thinking } : {}),
        },
        { role: 'user' as const, content: formatTodoForContext(todo) },
      ]
    }
    if (message.thinking) {
      return [...steerMessages, { role: 'assistant', content: message.content, reasoning_content: message.thinking }]
    }
    return [...steerMessages, { role: 'assistant', content: message.content }]
  }

  // Если есть content до первой итерации и он непустой — добавляем как отдельное сообщение
  // §steer — реплики пользователя идут ПЕРЕД ответом ассистента: они пришли
  // по ходу рана, и финальный ответ уже их учитывает.
  const result: ChatMessage[] = [...steerMessages]
  const contentBefore = message.content || ''
  const hasContentBefore = contentBefore.trim().length > 0

  for (let i = 0; i < iterations.length; i++) {
    const iter = iterations[i]
    const assistantContent = (i === 0 && hasContentBefore) ? contentBefore : ''

    // Sanitization: a strict provider (glm/litellm) returns 400 on
    // tool_calls without paired results. If an iteration survived without
    // results (error/crash before ensureToolResults in older versions) —
    // we previously rendered it as plain text and dropped the tool_calls,
    // so the AI did not know it had tried and failed, and repeated the
    // same calls. Now we emit a synthetic tool_result with a clear message
    // so the AI sees "I tried this and it did not complete" instead of
    // "I never tried it". Also skip tool_calls with empty callId (broken
    // id → 400).
    const validCalls = iter.calls.filter(c => c.callId && c.callId.length > 0)
    if (validCalls.length === 0) {
      // No valid calls — but without tool_calls this is an empty message; skip.
      if (i === 0 && hasContentBefore) {
        const emptyIterThinking = message.iterations?.[0]?.thinking ?? message.thinking
        result.push({
          role: 'assistant',
          content: assistantContent,
          ...(emptyIterThinking ? { reasoning_content: emptyIterThinking } : {}),
        })
      }
      continue
    }
    if (iter.results.size === 0) {
      // Calls exist but no results — emit assistant with tool_calls + a
      // synthetic tool_result for each call so the AI knows it tried and
      // the call did not complete (old/broken history). Previously the
      // whole iteration was silently dropped → AI repeated the same calls.
      const synthIterThinking = message.iterations?.[i]?.thinking
        ?? (i === 0 ? message.thinking : undefined)
      result.push({
        role: 'assistant',
        content: assistantContent,
        tool_calls: validCalls.map(c => ({
          id: c.callId,
          type: 'function' as const,
          function: { name: c.toolName, arguments: JSON.stringify(c.toolArgs) },
        })),
        ...(synthIterThinking ? { reasoning_content: synthIterThinking } : {}),
      })
      for (const call of validCalls) {
        result.push({
          role: 'tool',
          content: `[No result was captured for this tool call — it was likely interrupted or failed before a result was saved. Do not retry blindly: check the current state of the file/project first.]`,
          tool_call_id: call.callId,
          janitorProtected: true,
          name: call.toolName,
        })
      }
      continue
    }

    // Assistant сообщение с tool_calls (включает текст ответа перед тулаами)
    const toolCalls = validCalls.map(c => ({
      id: c.callId,
      type: 'function' as const,
      function: {
        name: c.toolName,
        arguments: JSON.stringify(c.toolArgs),
      },
    }))

    // Per-iteration reasoning (OpenAI reasoning_content). Prefer the
    // saved iteration's own thinking when available — message.thinking is
    // cumulative across all rounds of the turn and would be wrong for i>0.
    // For i===0 fall back to message.thinking (covers old messages without
    // per-iteration thinking, and single-round turns where they're equal).
    const iterThinking = message.iterations?.[i]?.thinking
      ?? (i === 0 ? message.thinking : undefined)

    result.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: toolCalls,
      // Anthropic extended thinking blocks must be echoed back alongside
      // the first assistant tool_use message — attach to iteration 0 only.
      // Subsequent iterations within one Message are separate model rounds;
      // their thinking blocks were not preserved separately and would be
      // rejected with invalid signatures if reused.
      ...(i === 0 && message.thinkingBlocks && message.thinkingBlocks.length > 0
        ? { thinking_blocks: message.thinkingBlocks }
        : {}),
      // OpenAI-compatible reasoning_content echo (GLM/DeepSeek/Qwen thinking
      // mode). Some providers (LiteLLM proxy for glm-*) return 400 if the
      // assistant turn that produced reasoning_content is sent back in the
      // next request WITHOUT the field — the proxy validates thinking-mode
      // output is round-tripped. Anthropic native path ignores this field.
      ...(iterThinking ? { reasoning_content: iterThinking } : {}),
    })

    // Tool результаты только для calls'ов, у которых есть результат.
    // Раньше push'или tool с пустым content даже без result (строка
    // toolResult?.content ?? '') — строгий провайдер 400 на пустой
    // tool_call_id или на tool без парного assistant.tool_calls.
    for (const call of validCalls) {
      const toolResult = iter.results.get(call.callId)
      if (!toolResult) continue  // скип — result отсутствует
      result.push({
        role: 'tool',
        content: toolResult.content ?? '',
        ...(toolResult.janitorProtected ? { janitorProtected: true } : {}),
        ...(toolResult.imagePaths?.length ? { imagePaths: toolResult.imagePaths } : {}),
        tool_call_id: call.callId,
        name: call.toolName,
      })
    }
  }

  // Если у assistant-сообщения есть todo — добавляем user-напоминание
  // ПОСЛЕ всей цепочки assistant(tool_calls)→tool results. User-роль
  // работает со всеми провайдерами (system в середине некоторые
  // прокси отбрасывают). AI видит свой незавершённый план и может
  // продолжить работу по нему в следующем ответе.
  if (todo?.length) {
    result.push({ role: 'user' as const, content: formatTodoForContext(todo) })
  }

  return result
}

/** A todo is a complete snapshot. Replay the latest visible snapshot only. */
export function buildContextHistory(messages: Message[]): ChatMessage[] {
  let latestTodo = messages.length - 1
  while (latestTodo >= 0) {
    const message = messages[latestTodo]
    if (message.role === 'assistant' && Array.isArray(message.todo)) break
    latestTodo--
  }
  return messages.flatMap((message, index) =>
    messageToContextMessages(message, index === latestTodo)
      .map(entry => ({ ...entry, messageId: message.id })),
  )
}

// Форматирует todo-список для инъекции в контекст истории.
// Используется в messageToContextMessages — AI видит это как user-сообщение
// после своего прошлого ответа, чтобы понимать что осталось сделать.
export function formatTodoForContext(todo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>): string {
  const lines = todo.map(t => {
    const mark = t.status === 'done' ? '[x]'
      : t.status === 'in_progress' ? '[~]'
      : t.status === 'skipped' ? '[-]'
      : '[ ]'
    return `${mark} ${t.text}`
  })
  return `[CURRENT TASK PLAN]\n${lines.join('\n')}`
}
