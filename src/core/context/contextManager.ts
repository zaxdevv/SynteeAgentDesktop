/**
 * Context Manager — управление контекстом чата и результатами тулов.
 * Использует js-tiktoken для точного подсчёта токенов (cl100k_base — стандарт OpenAI/Anthropic/Gemini).
 */

// ─── ТОЧНЫЙ ПОДСЧЁТ ТОКЕНОВ — делегируем в usageTracker ──────────────────────
// (encoder кэширован в одном месте, без дублирования)

export {
  estimateTokens, estimateMessagesTokens, TOOL_SCHEMAS_OVERHEAD,
  getHardLimitTokens, getHardLimitTargetTokens, ROLLING_TRIGGER_PCT,
} from '../tokens/usageTracker'
import { estimateTokens, estimateMessagesTokens, TOOL_SCHEMAS_OVERHEAD } from '../tokens/usageTracker'
import { getCatalogModel } from '../tokens/modelCatalog'

// ─── OVERHEAD: реальные постоянные расходы контекста ─────────────────────────

// служебные структуры OpenAI API ≈ 100 токенов
const API_OVERHEAD = 100            // служебные токены протокола

export function calcSystemPromptTokens(systemPrompt: string): number {
  return estimateTokens(systemPrompt) + 4  // +4 служебных
}

// ─── ПОЛУЧЕНИЕ contextWindow ОТ АКТИВНОЙ МОДЕЛИ ──────────────────────────────
// Единый источник истины — делегируем в ModelContextLimits

import { getContextLimit } from '../tokens/ModelContextLimits'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { getGatewayModelsCache, GATEWAY_PROVIDER_ID } from '../tokens/gatewayModelsCache'
import type { ModelMeta, ModelAssignment } from '../../shared/types'

export function getModelContextWindow(storeData: Record<string, unknown>, role: 'main' | 'subagent' = 'main'): number {
  const assignments = storeData.modelAssignments as ModelAssignment[] | undefined
  // Суб-агент может иметь свою модель — если она не назначена, поведение
  // совпадает с AIClient.chatWithTools (fallback на 'main').
  const roleAssignment = role === 'subagent' ? assignments?.find(a => a.role === 'subagent') : undefined
  const mainAssignment = (roleAssignment?.modelId ? roleAssignment : assignments?.find(a => a.role === 'main'))
  if (!mainAssignment?.modelId) return 128_000

  const modelId = mainAssignment.modelId
  const providerId = mainAssignment.providerId ?? ''

  // 1. Кастомные модели — пользователь мог задать явно
  const customModels = storeData.customModels as ModelMeta[] | undefined
  const custom = customModels?.find(m => m.id === modelId)
  if (custom?.contextWindow && custom.contextWindow > 0) return custom.contextWindow

  // 2. Модели Syntee-Gateway + каталог models.dev — берём МАКСИМУМ.
  // Gateway отдаёт max_tokens (часто это output-лимит, а не контекстное окно),
  // каталог models.dev знает честный contextWindow, но не знает провайдера
  // 'syntee-gateway' и через vendor-sniff может не найти модель (glm-5.3 нет в
  // каталоге → только gateway). Берём max(gateway, catalog): contextWindow не
  // может быть меньше max_output, так что большее число — корректный контекст.
  if (providerId === GATEWAY_PROVIDER_ID) {
    const gw = getGatewayModelsCache().find(m => m.id === modelId)
    const gwCtx = gw?.contextWindow ?? 0
    const fromCatalog = getCatalogModel(providerId, modelId)
    const catalogCtx = fromCatalog?.contextWindow ?? 0
    const best = Math.max(gwCtx, catalogCtx)
    if (best > 0) return best
  }

  // 3. Каталог models.dev (живые данные) — для не-gateway провайдеров
  const fromCatalog = getCatalogModel(providerId, modelId)
  if (fromCatalog?.contextWindow && fromCatalog.contextWindow > 0) return fromCatalog.contextWindow

  // 4. Builtin модели
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId)
  if (builtin?.contextWindow && builtin.contextWindow > 0) return builtin.contextWindow

  // 5. Единая таблица ModelContextLimits (частичное совпадение)
  const limit = getContextLimit(modelId)
  if (limit > 0) return limit

  return 128_000  // безопасный дефолт — лучше занижать чем завышать
}

// ─── НАСТРОЙКИ КОНТЕКСТА ──────────────────────────────────────────────────────

export interface ContextSettings {
  // Tool truncation
  toolTruncEnabled: boolean
  toolMaxChars: number

  // Rolling window + summary
  rollingEnabled: boolean
  rollingTriggerPct: number
  rollingKeepFirst: number
  rollingKeepLast: number
  contextLimitTokens: number

  // Token counter
  tokenCounterEnabled: boolean

  // Diff journal
  diffJournalEnabled: boolean
  diffJournalLines: number

  // File Map
  fileMapEnabled: boolean
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  toolTruncEnabled: true,
  toolMaxChars: 6000,          // было 8000 — достаточно, outline компенсирует
  rollingEnabled: true,
  rollingTriggerPct: 85,       // авто-компакция на 85% контекста
  rollingKeepFirst: 2,
  rollingKeepLast: 20,         // было 12 — больше свежей истории
  contextLimitTokens: 200_000,
  tokenCounterEnabled: true,
  diffJournalEnabled: true,
  diffJournalLines: 15,        // было 5 — больше деталей о правках в рабочей памяти
  fileMapEnabled: true,
}

export function getContextSettings(input: Record<string, unknown> | Partial<ContextSettings>): ContextSettings {
  const rec = input as Record<string, unknown>
  const saved = ('toolTruncEnabled' in rec || 'rollingEnabled' in rec || 'tokenCounterEnabled' in rec)
    ? rec as Partial<ContextSettings>
    : (rec['contextSettings'] ?? {}) as Partial<ContextSettings>
  return { ...DEFAULT_CONTEXT_SETTINGS, ...saved }
}

// ─── 1. TOOL RESULT TRUNCATION ───────────────────────────────────────────────

export function truncateToolResult(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  const half = Math.floor(maxChars / 2)
  const head = output.slice(0, half)
  const tail = output.slice(-Math.floor(half * 0.3))
  const removed = output.length - half - Math.floor(half * 0.3)
  return `${head}\n\n...[обрезано ${removed} симв, показано начало и конец]...\n\n${tail}`
}

// ─── 2. ROLLING WINDOW + SUMMARY ─────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** Visual tool-result sources; hydrated only at the agent request boundary. */
  imagePaths?: string[]
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  /** ID исходного Message из БД. Ставится messageToContextMessages.
   *  Нужен compaction-логике для вычисления boundary (границы middle/tail)
   *  без удаления из БД: по tail-messageIds находим createdAt граничного
   *  Message и ставим divider.createdAt = boundary - 1. */
  messageId?: string
  /** Anthropic extended thinking blocks (with signatures). Echoed back in
   *  subsequent rounds alongside tool_use — Anthropic API rejects the next
   *  request with 400 if thinking blocks are stripped from the assistant
   *  message that also contained tool_use. */
  thinking_blocks?: Array<{ thinking: string; signature: string }>
  /** OpenAI-compatible reasoning_content (GLM/DeepSeek/Qwen thinking mode).
   *  Some providers (LiteLLM proxy for glm and deepseek-r1) return 400 if the
   *  assistant message that produced reasoning_content is echoed back in the
   *  next round WITHOUT the field — the proxy validates thinking-mode output
   *  is round-tripped. Filled from message.thinking in chatContextHelpers.
   *  Anthropic native path ignores it (convertMessagesToAnthropic drops it). */
  reasoning_content?: string
}

export interface CompressResult {
  messages: ChatMessage[]
  compressed: boolean
  removedCount: number
  summaryAdded: boolean
  summaryContent?: string
  /** Фактическое кол-во ChatMessage оставленных в head. Нужно вызывающему
   *  коду для вычисления middle-индексов в исходном Message[] (удаление из БД). */
  headCount?: number
  /** Фактическое кол-во ChatMessage оставленных в tail. */
  tailCount?: number
}

// Умный summarize tool result — компактная но информативная замена.
// В отличие от старой версии (1-строчные заглушки), передаёт суть содержимого:
// ключевые сигнатуры для read_file, добавленные строки для edit_file,
// хвост вывода для run_command (где ошибки) и т.д.
function smartSummarizeToolResult(toolName: string, content: string): string {
  const lines = content.split('\n').length
  const chars = content.length

  // read_file / read_files — файл + первые ~300 символов содержимого
  // (сигнатуры, импорты, структура — чтобы суммаризатор знал что в файле)
  if (toolName === 'read_file' || toolName === 'read_files') {
    const fileMatch = content.match(/\[Файл: ([^\]|]+)/)
    const totalMatch = content.match(/из (\d+) строк/)
    const file = fileMatch?.[1]?.trim() ?? '?'
    const total = totalMatch?.[1] ?? lines
    // Извлекаем содержимое после заголовка файла
    const bodyStart = content.indexOf('\n')
    const body = bodyStart >= 0 ? content.slice(bodyStart + 1) : content
    const snippet = body.slice(0, 300).replace(/\n/g, ' ').trim()
    return `[${toolName}] ${file} (${total} строк): ${snippet}${body.length > 300 ? '…' : ''}`
  }
  // edit_file — файл + добавленные/изменённые строки из diff
  if (toolName === 'edit_file') {
    const fileMatch = content.match(/([^\s]+\.[a-z]+)/i)
    const file = fileMatch?.[1] ?? '?'
    // Извлекаем добавленные строки (начинаются с +, но не +++ заголовок diff)
    const addedLines = (content.match(/^\+[^+]/gm) ?? []).slice(0, 8).map(l => l.slice(1).trim()).filter(Boolean)
    const removedLines = (content.match(/^-[^-]/gm) ?? []).slice(0, 3).map(l => l.slice(1).trim()).filter(Boolean)
    const changes = addedLines.length ? `+${addedLines.join(' | ')}` : ''
    const removed = removedLines.length ? ` -${removedLines.join(' | ')}` : ''
    return `[edit_file] ${file}: ${changes}${removed}`.slice(0, 400)
  }
  // write_file — файл + первые ~200 символов содержимого
  if (toolName === 'write_file') {
    const fileMatch = content.match(/([^\s]+\.[a-z]+)/i)
    const file = fileMatch?.[1] ?? '?'
    const bodyStart = content.indexOf('\n')
    const body = bodyStart >= 0 ? content.slice(bodyStart + 1) : content
    const snippet = body.slice(0, 200).replace(/\n/g, ' ').trim()
    return `[write_file] ${file} (${chars} симв): ${snippet}${body.length > 200 ? '…' : ''}`
  }
  // run_command — exit code + последние ~300 символов (ошибки обычно в конце)
  if (toolName === 'run_command') {
    const exitMatch = content.match(/\[exit: (\d+)\]/)
    const exitCode = exitMatch?.[1] ?? '?'
    const tail = content.slice(-300).replace(/\n/g, ' ').trim()
    return `[run_command] exit ${exitCode}: …${tail}`
  }
  // search_code — имена файлов с совпадениями (до 10)
  if (toolName === 'search_code') {
    const fileMatches = (content.match(/●\s+(\S+\.\w+)/g) ?? []).slice(0, 10).map(m => m.replace(/●\s+/, ''))
    return `[search_code] ${fileMatches.length} файлов: ${fileMatches.join(', ')}`
  }
  // search_web — первые ~200 символов результатов
  if (toolName === 'search_web') {
    const snippet = content.slice(0, 200).replace(/\n/g, ' ').trim()
    return `[search_web] ${snippet}${content.length > 200 ? '…' : ''}`
  }
  // fetch_page — URL + первые ~200 символов содержимого
  if (toolName === 'fetch_page') {
    const urlMatch = content.match(/Page: (\S+)/)
    const bodyStart = content.indexOf('\n\n')
    const body = bodyStart >= 0 ? content.slice(bodyStart + 2) : ''
    const snippet = body.slice(0, 200).replace(/\n/g, ' ').trim()
    return `[fetch_page] ${urlMatch?.[1] ?? '?'}: ${snippet}${body.length > 200 ? '…' : ''}`
  }
  // search_images — query + количество результатов
  if (toolName === 'search_images') {
    const queryMatch = content.match(/results for "([^"]+)"/)
    const count = (content.match(/^\[\d+\]/gm) ?? []).length
    return `[search_images] ${count} images for "${queryMatch?.[1] ?? '?'}"`
  }
  // find_files / list_directory — список файлов (первые ~300 символов)
  if (toolName === 'find_files' || toolName === 'list_directory') {
    const snippet = content.slice(0, 300).replace(/\n/g, ' ').trim()
    return `[${toolName}] ${snippet}${content.length > 300 ? '…' : ''}`
  }
  // get_file_outline — файл + первые ~200 символов (структура)
  if (toolName === 'get_file_outline') {
    const fileMatch = content.match(/([^\s]+\.[a-z]+)/i)
    const file = fileMatch?.[1] ?? '?'
    const bodyStart = content.indexOf('\n')
    const body = bodyStart >= 0 ? content.slice(bodyStart + 1) : content
    const snippet = body.slice(0, 200).replace(/\n/g, ' ').trim()
    return `[get_file_outline] ${file}: ${snippet}${body.length > 200 ? '…' : ''}`
  }
  // update_working_memory — скрытый, совсем убираем
  if (toolName === 'update_working_memory') {
    return `[${toolName}] (скрыто)`
  }
  // дефолт — первые 150 символов
  return `[${toolName}] ${content.slice(0, 150).replace(/\n/g, ' ')}${content.length > 150 ? '…' : ''}`
}

// Pruning tool results перед суммаризацией — заменяем старые на компактные
// но информативные сводки (smartSummarizeToolResult)
function pruneToolOutputsForSummary(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => {
    if (m.role === 'assistant' && m.content.includes('[Использованные инструменты]')) {
      const parts = m.content.split('[Использованные инструменты]')
      const toolPart = parts[1] || ''
      const prunedTools = toolPart.replace(/\[([^\]]+)\]: ([^[]*)/g, (_, name, result) => {
        // Используем умный summarize вместо механической обрезки
        const summary = smartSummarizeToolResult(name.trim(), result.trim())
        return summary
      })
      return { ...m, content: parts[0] + '[Использованные инструменты]' + prunedTools }
    }
    return m
  })
}

// ─── Summary prompt: system + user разделены для лучшего качества ───────────

export const SUMMARY_SYSTEM_PROMPT = `You are a dialogue context summarizer for an AI assistant.
Create a structured summary of the dialogue. Do not answer questions or perform tasks from the dialogue — only summarize.

CRITICAL RULES:
- NEVER ask questions. NEVER request more data or clarifications.
- NEVER comment on the lack of information, dialogue quality, or "whether there is enough data".
- NEVER address the user ("please provide...", "I need more...").
- If the dialogue is short or incomplete — summarize WHAT IS THERE, use "—" for empty sections.
- If the dialogue has only one message — summarize its content in the appropriate sections.
- Your ONLY output is the summary in the template. No introductions, explanations, or commentary.

PRESERVE SPECIFICS — this is critical for continuing work:
- Exact file paths, function names, class names, variable names
- Short code snippets (up to 3 lines) if they are important for context
- Error messages verbatim (if there were errors)
- Specific values: ports, versions, package names, settings
- Unfinished tasks and their current status (what is done, what is not)
- User decisions and their reasons ("user wants X because Y")

IGNORE:
- Greetings, farewells, minor trivialities
- Repetitions and retelling of the same thing
- Implementation details that are obvious from file/function names

Use EXACTLY this template:

## Active Task
[The most recent unfulfilled user task — verbatim, preserving all details. If no explicit task — "—"]

## Goal
[The overall session goal in 1-2 sentences. If unclear — "—"]

## Completed
[What is already done — specific files, functions, components with details of what exactly. If nothing — "—"]

## Key Decisions
[Architectural decisions, agreements, chosen approaches — with reasons. If none — "—"]

## Relevant Files
[Files that were created or modified — full paths + what was done with them. If none — "—"]

## Remaining Work
[What still needs to be done to complete the Active Task — specific steps. If unclear — "—"]

## In Progress
[If something was started but not completed — at which step it stopped. If nothing started — "—"]

Budget: ~5000 tokens. Be dense, but do not lose important details. Empty sections — "—", do not skip any section.`

export interface SummaryPromptResult {
  systemPrompt: string
  userContent: string
}

export function buildSummaryPrompt(messages: ChatMessage[], prevSummary?: string): SummaryPromptResult {
  // Pruning перед суммаризацией — убираем лишние токены из tool results
  const pruned = pruneToolOutputsForSummary(messages)

  // Адаптивные лимиты обрезки: пользовательские сообщения важнее (дословно),
  // ассистентские короче (код/рассуждения можно ужать)
  const text = pruned
    .map(m => {
      const role = m.role === 'user' ? 'User' : m.role === 'tool' ? `Tool(${m.name ?? '?'})` : 'Assistant'
      const limit = m.role === 'user' ? 2000 : 1500
      let content = m.content.slice(0, limit)
      // Сохраняем tool_calls — какие тулы вызывались
      if (m.tool_calls?.length) {
        const tools = m.tool_calls.map(tc => tc.function.name).join(', ')
        content += `\n[Tools called: ${tools}]`
      }
      return `${role}: ${content}`
    })
    .join('\n\n')

  const updateInstruction = prevSummary
    ? `Below is the existing summary. Incorporate the new messages into it.\nKEEP everything important from the existing summary — do not delete facts, files, decisions.\nAdd new information, update statuses (completed/in-progress), fix if something changed.\nIf the new dialogue has no information for a section — keep the old one.\n\n<existing_summary>\n${prevSummary}\n</existing_summary>\n\n`
    : ''

  return {
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userContent: `${updateInstruction}---\nDialogue for summarization:\n\n${text}`,
  }
}

export async function applyRollingWindowAsync(
  messages: ChatMessage[],
  settings: Pick<ContextSettings, 'rollingKeepFirst' | 'rollingKeepLast' | 'rollingTriggerPct' | 'contextLimitTokens'>,
  summaryFn?: (systemPrompt: string, userContent: string) => Promise<string>,
  prevSummary?: string,
  forceCompress?: boolean,
  compactMode?: 'full' | 'last',
): Promise<CompressResult> {
  const totalTokens = estimateMessagesTokens(messages)
  const limitTokens = settings.contextLimitTokens
  const triggerTokens = Math.floor(limitTokens * settings.rollingTriggerPct / 100)

  // ── Пороги ─
  // Авто-компакция (forceCompress=false): только если токенов >= trigger И
  // сообщений достаточно чтобы middle был непустым (> keepLast). Head не
  // держим в AI-контексте (модель «новый чат + summary»): head уходит в
  // summary, AI видит только tail + summary (в system prompt).
  // Ручная /compact (forceCompress=true): сразу к адаптации.
  if (!forceCompress) {
    if (totalTokens < triggerTokens) {
      return { messages, compressed: false, removedCount: 0, summaryAdded: false }
    }
    if (messages.length <= settings.rollingKeepLast) {
      return { messages, compressed: false, removedCount: 0, summaryAdded: false }
    }
  }

  // Адаптация окна для коротких историй: keepLast не может превышать длину.
  // Оставляем минимум 1 middle сообщение для сжатия.
  // Если total = 5, keepLast=20 → берём keepLast=4 (5-1), middle = 1 сообщение.
  //
  // compactMode='last': keepLast=1 — оставляем только последнее сообщение,
  // всё остальное уходит в summary. Экстремальное сжатие для длинных чатов.
  const baseKeepLast = compactMode === 'last' ? 1 : settings.rollingKeepLast
  const keepLast = Math.min(baseKeepLast, Math.max(0, messages.length - 1))
  if (keepLast >= messages.length) {
    // Совсем короткая история (1 сообщение) — сжать невозможно.
    return { messages, compressed: false, removedCount: 0, summaryAdded: false }
  }

  let tailMessages = messages.slice(messages.length - keepLast)
  // Если keepLast=0, slice(length-0) = slice(length) → []. Норм.

  // Не разрываем tool-раунды: если tail начинается с tool-сообщения без
  // парного assistant с tool_calls — отбрасываем непарные tool-сообщения.
  while (tailMessages.length > 0 && tailMessages[0].role === 'tool') {
    tailMessages = tailMessages.slice(1)
  }

  // middle = всё, что до tail (включая бывший head). Head не выделяем —
  // он суммаризуется вместе с middle. Это даёт модели «чистый старт»:
  // AI видит только summary (в system prompt) + последние tail-сообщения.
  const middleMessages = messages.slice(0, messages.length - tailMessages.length)

  if (middleMessages.length === 0) {
    return { messages, compressed: false, removedCount: 0, summaryAdded: false }
  }

  let summaryContent: string
  if (summaryFn) {
    try {
      const { systemPrompt, userContent } = buildSummaryPrompt(middleMessages, prevSummary)
      summaryContent = await summaryFn(systemPrompt, userContent)
    } catch {
      // Fallback: извлекаем ключевые факты структурно вместо механической
      // обрезки. Пользовательские сообщения целиком (до 800 символов),
      // ассистентские — кратко (до 400). Бюджет 3000 символов.
      summaryContent = middleMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => m.role === 'user'
          ? `User: ${m.content.slice(0, 800)}`
          : `AI: ${m.content.slice(0, 400)}`)
        .join('\n\n')
        .slice(0, 3000)
    }
  } else {
    summaryContent = middleMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => m.role === 'user'
        ? `User: ${m.content.slice(0, 800)}`
        : `AI: ${m.content.slice(0, 400)}`)
      .join('\n\n')
      .slice(0, 3000)
  }

  // Cap на размер summary: модель может выдать слишком много и
  // иногда регургитирует вместо суммаризации. Ограничиваем ~6000 токенов
  // (было 4000 — увеличено для сохранения больше деталей длинных диалогов).
  // Транкейт по словам, чтобы не разрезать токен посередине.
  const SUMMARY_MAX_TOKENS = 6000
  if (estimateTokens(summaryContent) > SUMMARY_MAX_TOKENS) {
    const words = summaryContent.split(/\s+/)
    let truncated = ''
    let curTokens = 0
    for (const w of words) {
      const wTokens = estimateTokens(w)
      if (curTokens + wTokens > SUMMARY_MAX_TOKENS) break
      truncated += (truncated ? ' ' : '') + w
      curTokens += wTokens
    }
    summaryContent = truncated + '\n[…резюме обрезано до ~6000 токенов]'
  }

  // summaryMsg НЕ добавляется в messages — summary живёт только в system
  // prompt (через setChatSummary → getSystemPrompt). Раньше summaryMsg
  // дублировался: один раз в history, второй — в system prompt. Теперь
  // AI получает summary единственный раз, в system prompt.
  return {
    messages: [...tailMessages],
    compressed: true,
    removedCount: middleMessages.length,
    summaryAdded: true,
    summaryContent,
    headCount: 0,
    tailCount: tailMessages.length,
  }
}

// ─── 3. TOKEN COUNTER — ПОЛНЫЙ РЕАЛЬНЫЙ ПОДСЧЁТ ──────────────────────────────

export interface TokenUsage {
  estimated: number           // реальная оценка через tiktoken
  historyTokens: number       // токены истории
  systemPromptTokens: number  // токены system prompt
  toolSchemasTokens: number   // токены tool schemas (константа)
  currentMsgTokens: number    // токены текущего сообщения
  limit: number               // лимит контекста модели
  pct: number                 // 0-100
  status: 'ok' | 'warn' | 'critical'
}

export function calcTokenUsage(
  messages: ChatMessage[],
  limitTokens: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    includeToolSchemas?: boolean
  } = {}
): TokenUsage {
  const historyTokens = estimateMessagesTokens(messages)
  const systemPromptTokens = opts.systemPrompt ? calcSystemPromptTokens(opts.systemPrompt) : 600
  const toolSchemasTokens = opts.includeToolSchemas === true ? TOOL_SCHEMAS_OVERHEAD : 0
  const currentMsgTokens = opts.currentMsgTokens ?? 0

  const estimated = historyTokens + systemPromptTokens + toolSchemasTokens + currentMsgTokens + API_OVERHEAD
  const pct = Math.min(100, Math.round(estimated / limitTokens * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'

  return { estimated, historyTokens, systemPromptTokens, toolSchemasTokens, currentMsgTokens, limit: limitTokens, pct, status }
}

// ─── 4. STRUCTURED AGENT STATE ───────────────────────────────────────────────

export interface AgentState {
  task: string
  completedSteps: string[]
  currentStep: string
  keyFindings: Record<string, string>
  pendingActions: string[]
  iterCount: number
}

export function buildAgentStateBlock(state: AgentState): string {
  return [
    `[Agent State]`,
    `Task: ${state.task}`,
    state.completedSteps.length > 0 ? `Done: ${state.completedSteps.join(' | ')}` : '',
    `Current: ${state.currentStep}`,
    Object.keys(state.keyFindings).length > 0
      ? `Findings: ${Object.entries(state.keyFindings).map(([k, v]) => `${k}=${v}`).join('; ')}`
      : '',
    state.pendingActions.length > 0 ? `Next: ${state.pendingActions.join(', ')}` : '',
    `[/Agent State]`,
  ].filter(Boolean).join('\n')
}
