/**
 * Context Manager — управление контекстом чата и результатами тулов.
 * Использует js-tiktoken для точного подсчёта токенов (cl100k_base — стандарт OpenAI/Anthropic/Gemini).
 */

// ─── ТОЧНЫЙ ПОДСЧЁТ ТОКЕНОВ — делегируем в usageTracker ──────────────────────
// (encoder кэширован в одном месте, без дублирования)

export {
  estimateTokens, estimateMessagesTokens, estimateMessagesTokensAsync,
  truncateToTokensAsync, TOOL_SCHEMAS_OVERHEAD,
  getHardLimitTokens, getHardLimitTargetTokens, ROLLING_TRIGGER_PCT,
} from '../tokens/usageTracker'
import { estimateMessagesTokensAsync, truncateToTokensAsync } from '../tokens/usageTracker'
import { getCatalogModel } from '../tokens/modelCatalog'

// ─── ПОЛУЧЕНИЕ contextWindow ОТ АКТИВНОЙ МОДЕЛИ ──────────────────────────────
// Единый источник истины — делегируем в ModelContextLimits

import { getContextLimit } from '../tokens/ModelContextLimits'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { DEFAULT_SETTINGS } from '../../shared/constants'
import { getGatewayModelsCache, GATEWAY_PROVIDER_ID } from '../tokens/gatewayModelsCache'
import type { ModelMeta, ModelAssignment } from '../../shared/types'

export function getModelContextWindow(
  storeData: Record<string, unknown>,
  role: 'main' | 'subagent' = 'main',
  requested?: { modelId: string; providerId?: string },
): number {
  const assignments = storeData.modelAssignments as ModelAssignment[] | undefined
  // Суб-агент может иметь свою модель — если она не назначена, поведение
  // совпадает с AIClient.chatWithTools (fallback на 'main').
  const roleAssignment = role === 'subagent' ? assignments?.find(a => a.role === 'subagent') : undefined
  const mainAssignment = assignments?.find(a => a.role === 'main')
  const assignment = roleAssignment?.modelId ? roleAssignment : mainAssignment
  const legacySubagentModel = role === 'subagent' ? storeData.subagentModel as string | undefined : undefined
  const modelId = requested?.modelId || roleAssignment?.modelId || legacySubagentModel
    || mainAssignment?.modelId || (storeData.mainModel as string | undefined) || DEFAULT_SETTINGS.mainModel
  const providerId = requested ? requested.providerId ?? '' : legacySubagentModel && !roleAssignment?.modelId
    ? roleAssignment?.providerId ?? '' : assignment?.providerId ?? ''

  // 1. Кастомные модели — пользователь мог задать явно
  const customModels = storeData.customModels as ModelMeta[] | undefined
  const custom = customModels?.find(m => m.id === modelId && m.providerId === providerId)
  if (custom?.contextWindow && Number.isFinite(custom.contextWindow) && custom.contextWindow > 0) return custom.contextWindow

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
  /** Load large MCP tool catalogues on demand. */
  deferredMcpTools: boolean

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
  deferredMcpTools: true,
  diffJournalEnabled: true,
  diffJournalLines: 15,        // было 5 — больше деталей о правках в рабочей памяти
  fileMapEnabled: true,
}

export function getContextSettings(input: Record<string, unknown> | Partial<ContextSettings>): ContextSettings {
  const rec = input as Record<string, unknown>
  const saved = ('toolTruncEnabled' in rec || 'rollingEnabled' in rec || 'tokenCounterEnabled' in rec || 'deferredMcpTools' in rec)
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
  /** Джанитор заменил content резюме/свёрткой — точного контента здесь больше
   *  нет. Точный текст можно получить через recall или новым чтением. */
  janitorCollapsed?: boolean
  /** Failed, visual or diff results must retain their exact contents. */
  janitorProtected?: boolean
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
  /** J2 cache-friendly: маркер стабильной границы истории для Anthropic prompt
   *  caching. Ставится Agent'ом только в момент компакции (эпохи), между
   *  компакциями не двигается → префикс до якоря кэшируется и даёт cache hit. */
  cacheAnchor?: boolean
}

export interface CompressResult {
  messages: ChatMessage[]
  compressed: boolean
  /** Кол-во РЕАЛЬНЫХ сообщений (Message), ушедших в summary — не ChatMessages
   *  (один Message разворачивается в десятки ChatMessages). */
  removedCount: number
  /** Кол-во tool-результатов в tail, ужатых токен-капом (структура целая). */
  trimmedToolResults?: number
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

// Pruning tool results перед суммаризацией: сырые результаты тулов (содержимое
// файлов, выводы команд) заменяются компактными сводками (smartSummarizeToolResult).
// Раньше функция искала маркер «[Использованные инструменты]» из старого
// compact-trace формата — после перехода на нативную развёртку tool_calls
// (messageToContextMessages) его никто не производит, и pruning никогда
// не срабатывал. Теперь режем role='tool' напрямую: короткие результаты
// остаются дословно (ошибки, подтверждения), длинные сжимаются в сводки —
// иначе промпт суммаризатора превращается в свалку и резюме чаще упирается
// в кап ~6000 токенов, теряя важное.
function pruneToolOutputsForSummary(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => {
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 400) {
      return { ...m, content: smartSummarizeToolResult(m.name ?? 'tool', m.content) }
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

export function buildSummaryPrompt(messages: ChatMessage[], prevSummary?: string, focus?: string): SummaryPromptResult {
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

  // Фокус пользователя (/compact [mode] <текст>): резюме строится ВОКРУГ
  // фокуса — по нему максимально подробно (точные значения, пути, код,
  // решения), остальное кратко. Шаблон не отменяется — фокус задаёт
  // приоритет отбора деталей в каждом разделе.
  const trimmedFocus = focus?.trim()
  const focusBlock = trimmedFocus
    ? `USER FOCUS FOR THIS COMPACTION — the user named what this compaction is FOR (their own words):\n${trimmedFocus}\n\nThe focus is the TOP priority for every section of the template:\n- Focus-related facts: preserve in MAXIMUM detail — exact values, file paths, code snippets, decisions with reasons, current status. When in doubt whether a detail belongs to the focus — include it.\n- Everything NOT related to the focus: compress hard, one line each, only critical facts (files touched, decisions, unfinished work).\n- The focus must be richly present in the summary — a thin mention is a failure.\n\n`
    : ''

  return {
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userContent: `${updateInstruction}${focusBlock}---\nDialogue for summarization:\n\n${text}`,
  }
}

// ── Токен-кап на tail ────────────────────────────────────────────────────────
// Tail — целые обмены, и последний агентский ход может весить сотни тысяч
// токенов (сотня tool-результатов). Без капа /compact full «сжимал»
// 307k→216k: весь мега-ход оставался живым, токены фактически не падали.
const TAIL_MAX_TOKENS_PCT = 10      // кап = 10% окна контекста (min 3000)
// Свежие tool-результаты tail'а остаются дословно — это рабочее «сейчас»
// модели, по ним продолжается задача.
const TAIL_VERBATIM_TOOL_RESULTS = 8
// Старые tool-результаты в tail сжимаются до head+хвоста (структура пар
// tool_call→tool_result не ломается, вопрос/ответ не трогаются).
const TAIL_TOOL_CAP_CHARS = 400

export async function applyRollingWindowAsync(
  messages: ChatMessage[],
  settings: Pick<ContextSettings, 'rollingKeepFirst' | 'rollingKeepLast' | 'rollingTriggerPct' | 'contextLimitTokens'>,
  summaryFn?: (systemPrompt: string, userContent: string) => Promise<string>,
  prevSummary?: string,
  forceCompress?: boolean,
  compactMode?: 'full' | 'last',
  /** Свободный фокус пользователя (/compact <mode> <focus>) — приоритет в резюме. */
  focus?: string,
): Promise<CompressResult> {
  // Exact count, computed in Rust when the sidecar is up: this is the full
  // history, the single most expensive BPE call in the send path.
  const totalTokens = await estimateMessagesTokensAsync(messages)
  const limitTokens = settings.contextLimitTokens
  const triggerTokens = Math.floor(limitTokens * settings.rollingTriggerPct / 100)

  // ── Порог ─
  // Авто-компакция (forceCompress=false): только если токенов >= trigger.
  // Guard «история слишком коротка» делается ниже по сегментам (middle пуст
  // → compressed=false): счёт ChatMessages врёт — один агентский ход
  // разворачивается в десятки ChatMessages (assistant + tool-результаты +
  // §steer/todo). Head не держим в AI-контексте (модель «новый чат +
  // summary»): всё до tail уходит в summary, AI видит только tail +
  // summary (в system prompt). Ручная /compact (forceCompress=true):
  // сразу к выбору tail.
  if (!forceCompress && totalTokens < triggerTokens) {
    return { messages, compressed: false, removedCount: 0, summaryAdded: false }
  }

  // ── Сегментация: один Message → один сегмент ──────────────────────────────
  // Развёрнутые ChatMessages одного Message несут одинаковый messageId
  // (проставляется в chat.ipc.ts / chatSendEngine.ts на flatMap). Tail
  // выбирается по СЕГМЕНТАМ (реальным сообщениям), а не по счёту ChatMessages:
  // сегмент = целое сообщение со всей его развёрткой → tool-раунды не рвутся
  // (assistant с tool_calls не остаётся без своих tool-результатов), и
  // boundary divider'а всегда совпадает с первым tail-Message.
  const segments: ChatMessage[][] = []
  for (const m of messages) {
    const lastSeg = segments[segments.length - 1]
    if (lastSeg && lastSeg[0].messageId && m.messageId && lastSeg[0].messageId === m.messageId) {
      lastSeg.push(m)
    } else {
      segments.push([m])
    }
  }

  // ── Индекс первого tail-сегмента ─
  // full (и фокус-текст без режима): tail ПУСТОЙ — вся live-история уходит
  // в summary. Модель начинает с «нового чата»: только резюме в system prompt.
  // last: tail = последний сегмент — последнее сообщение (обычно ответ агента
  // со всем его тул-трафиком). Остальное — в summary. Если это мега-ход,
  // его tool-результаты ужимаются токен-капом (см. ниже).
  const tailStart = compactMode === 'last'
    ? Math.max(segments.length - 1, 0)
    : segments.length

  // tail = целые сегменты после границы; middle = всё до неё. Это даёт
  // модели «чистый старт»: AI видит только summary (в system prompt) +
  // последние tail-сообщения.
  const tailMessages = segments.slice(tailStart).flat()
  const middleMessages = segments.slice(0, tailStart).flat()

  // Токен-кап на tail: 10% окна (min 3000) — см. TAIL_MAX_TOKENS_PCT выше.
  const tailCapTokens = Math.max(3000, Math.floor(limitTokens * TAIL_MAX_TOKENS_PCT / 100))

  // Middle пуст (сжимать, кроме хвоста, нечего). Лёгкий хвост — честный отказ:
  // короткий чат, /compact last на единственном сообщении, повторный /compact
  // без новых сообщений. Тяжёлый хвост — TRIM-ONLY компакция: middle=[],
  // новое summary не пишется (старое chat_summaries остаётся), вес съедает
  // трим tool-результатов ниже (реальный кейс: единственный мега-ход на 195k
  // с 231 tool-вызовом — без этого он был несжимаем).
  if (middleMessages.length === 0 && await estimateMessagesTokensAsync(tailMessages) <= tailCapTokens) {
    return { messages, compressed: false, removedCount: 0, summaryAdded: false }
  }

  // ── Токен-кап на tail: старые tool-результаты ужимаются ────────────────────
  // Считаем токены tail'а; если он тяжелее капа — режем содержимое tool-
  // сообщений (кроме последних TAIL_VERBATIM_TOOL_RESULTS). Пары
  // tool_call→tool_result и user/assistant остаются целыми, поэтому никакой
  // ломки API и divider-механики: divider по-прежнему стоит перед первым
  // tail-Message, а «лишний вес» хода съеден на содержимом результатов.
  let trimmedToolResults = 0
  if (await estimateMessagesTokensAsync(tailMessages) > tailCapTokens) {
    let verbatim = 0
    for (let i = tailMessages.length - 1; i >= 0; i--) {
      const m = tailMessages[i]
      if (m.role !== 'tool' || typeof m.content !== 'string') continue
      verbatim++
      if (verbatim <= TAIL_VERBATIM_TOOL_RESULTS) continue
      if (m.content.length > TAIL_TOOL_CAP_CHARS) {
        tailMessages[i] = { ...m, content: truncateToolResult(m.content, TAIL_TOOL_CAP_CHARS) }
        trimmedToolResults++
      }
    }
  }

  // Summary строится только из middle. В trim-only компакции middle пуст —
  // новое summary не пишется (старое chat_summaries остаётся как было),
  // вес снижает трим.
  let summaryContent: string | undefined
  if (middleMessages.length > 0) {
    if (summaryFn) {
      try {
        const { systemPrompt, userContent } = buildSummaryPrompt(middleMessages, prevSummary, focus)
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
    // One native truncate instead of re-encoding every word: the old loop ran a
    // BPE encode per word, which thrashed the 500-entry token cache and blocked
    // the thread for the whole summary.
    const cappedSummary = await truncateToTokensAsync(summaryContent, SUMMARY_MAX_TOKENS)
    if (cappedSummary.truncated) {
      summaryContent = cappedSummary.text + '\n[…резюме обрезано до ~6000 токенов]'
    }
  }

  // summaryMsg НЕ добавляется в messages — summary живёт только в system
  // prompt (через setChatSummary → getSystemPrompt). Раньше summaryMsg
  // дублировался: один раз в history, второй — в system prompt. Теперь
  // AI получает summary единственный раз, в system prompt.
  return {
    messages: tailMessages,
    compressed: true,
    // Кол-во РЕАЛЬНЫХ сообщений (Message), ушедших в summary — не ChatMessages:
    // один агентский ход разворачивается в десятки ChatMessages, и divider/
    // toast с ними рисовали «удалено 47 сообщ.» при 3 реальных.
    removedCount: segments.slice(0, tailStart).length,
    trimmedToolResults,
    summaryAdded: middleMessages.length > 0,
    summaryContent,
    headCount: 0,
    tailCount: tailMessages.length,
  }
}

// ─── 3. TOKEN COUNTER ────────────────────────────────────────────────────────
// Единственная реализация подсчёта живёт в usageTracker (`computeContextSnapshot`
// / `buildSnapshotFromEstimate`). Локальный дубль `calcTokenUsage` +
// `calcSystemPromptTokens` удалён: он считал по своей формуле (system=600 по
// умолчанию, свой overhead, свои пороги 85/60) и давал числа, расходящиеся с
// остальными эмиттерами.

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
