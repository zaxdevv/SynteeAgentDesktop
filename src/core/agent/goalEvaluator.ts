/**
 * Независимый оценщик цели — ядро `/goal` в семантике [CC].
 *
 * Ключевая идея: работу судит НЕ тот, кто её делает. После каждого хода
 * отдельная быстрая модель читает транскрипт и выносит один из трёх вердиктов:
 *   met        — условие выполнено → цель снимается как достигнутая;
 *   not_met    — ещё нет; reason уходит в следующий ход как указание;
 *   impossible — условие невыполнимо → цель снимается с причиной.
 *
 * Оценщик не вызывает инструменты: он судит только то, что уже видно в
 * транскрипте. Поэтому условие должно быть проверяемым по выводу модели
 * («npm test выходит с кодом 0»), а не по её словам «готово».
 *
 * Файл намеренно разделён на чистые функции (форматирование транскрипта,
 * разбор вердикта) и тонкую обёртку над LLM — чистые части покрыты тестами.
 */

import type { GoalVerdict } from '../../shared/types/goal'

export interface GoalVerdictResult {
  verdict: GoalVerdict
  reason: string
}

export interface GoalJudgeInput {
  condition: string
  transcript: string
  turn: number
}

export type GoalJudge = (input: GoalJudgeInput) => Promise<GoalVerdictResult>

/** Транспорт к быстрой модели (AIClient.complete в проде, шпион в тестах). */
export type CompleteFn = (
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  modelType: 'fast' | 'main',
  systemPrompt?: string,
  opts?: { maxTokens?: number },
) => Promise<string>

const DEFAULT_MAX_CHARS = 24_000
const DEFAULT_PER_MESSAGE = 1_200
const TOOL_RESULT_CHARS = 700

export const GOAL_EVALUATOR_SYSTEM_PROMPT = [
  'You are the goal evaluator for an autonomous coding agent.',
  'You do NOT do the work and you cannot run tools. You only read the transcript and decide whether the user\'s completion condition holds.',
  '',
  'Rules:',
  '- Judge the condition as written, strictly. The agent\'s own claims ("done", "all tests pass") are NOT evidence unless the transcript shows the actual result (command output, exit code, file contents, tool result).',
  '- If the transcript does not contain evidence that the condition holds, answer not_met — never guess in the agent\'s favour.',
  '- Answer impossible only when the condition can never be satisfied in this session (contradictory requirement, missing access, wrong premise). Do not use impossible merely because the work is hard or slow.',
  '- The reason must be one short sentence of concrete guidance for the next turn: what exactly is still missing or what to check next.',
  '',
  'Answer with ONLY this JSON, no prose and no code fences:',
  '{"verdict":"met|not_met|impossible","reason":"one short sentence"}',
].join('\n')

export interface TranscriptMessage {
  role: string
  content?: unknown
  name?: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part || typeof part !== 'object') return ''
      const value = part as Record<string, unknown>
      if (value.type === 'text' && typeof value.text === 'string') return value.text
      if (value.type === 'image_url' || value.type === 'image') return '[image]'
      return ''
    }).filter(Boolean).join('\n')
  }
  if (content && typeof content === 'object') return JSON.stringify(content)
  return ''
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…[truncated ${trimmed.length - limit} chars]`
}

/**
 * Компактная выжимка транскрипта для оценщика: без system-сообщений (условие
 * передаётся отдельно), с обрезкой длинных текстов и tool-выводов.
 * При переполнении сохраняется начало (исходная задача) и свежий хвост.
 */
export function formatTranscript(
  messages: readonly TranscriptMessage[],
  opts?: { maxChars?: number; perMessageChars?: number; advisory?: boolean },
): string {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS
  const perMessage = opts?.perMessageChars ?? DEFAULT_PER_MESSAGE
  const advisory = opts?.advisory === true
  const lines: string[] = []
  for (const message of messages) {
    const role = String(message.role || 'user')
    if (role === 'system') continue
    const parts: string[] = []
    const content = contentToText(message.content)
    const text = advisory ? content.replace(/[\r\n]+/g, ' ') : content
    const limit = role !== 'tool' ? perMessage : advisory ? Math.min(TOOL_RESULT_CHARS, perMessage) : TOOL_RESULT_CHARS
    if (text.trim()) parts.push(clip(text, limit))
    if (Array.isArray(message.tool_calls)) {
      const calls = advisory ? message.tool_calls.slice(-3) : message.tool_calls
      for (const raw of calls) {
        const call = (raw ?? {}) as { function?: { name?: string; arguments?: string } }
        const rawName = call.function?.name ?? 'tool'
        const name = advisory ? String(rawName).replace(/[\r\n]+/g, ' ').slice(0, 100) : rawName
        const rawArgs = String(call.function?.arguments ?? '')
        const args = clip(advisory ? rawArgs.replace(/[\r\n]+/g, ' ') : rawArgs, advisory ? 150 : 300)
        parts.push(`→ calls ${name}(${args})`)
      }
    }
    if (!parts.length) continue
    const name = advisory ? message.name?.replace(/[()\r\n]/g, ' ').slice(0, 100) : message.name
    const label = role === 'tool' ? `tool result${name ? ` (${name})` : ''}` : role
    lines.push(`${label}: ${parts.join('\n')}`)
  }
  if (!lines.length) return '(empty transcript)'
  const joined = lines.join('\n\n')
  if (joined.length <= maxChars) return joined
  if (advisory) {
    // Preserve complete role-labelled blocks and the newest action. Flattened
    // message content cannot introduce a new role label.
    let start = lines.length - 1
    let size = lines[start].length
    while (start > 0 && size + 2 + lines[start - 1].length <= maxChars) size += 2 + lines[--start].length
    return lines.slice(start).join('\n\n').slice(0, maxChars)
  }
  // Хвост важнее середины, но исходная постановка задачи нужна всегда.
  const head = lines[0].slice(0, 2_000)
  const tailBudget = maxChars - head.length - 40
  let tail = ''
  for (let i = lines.length - 1; i > 0; i--) {
    const next = lines[i] + (tail ? `\n\n${tail}` : '')
    if (next.length > tailBudget) break
    tail = next
  }
  return `${head}\n\n…[earlier messages omitted]…\n\n${tail}`
}

const VERDICT_ALIASES: Record<string, GoalVerdict> = {
  met: 'met',
  achieved: 'met',
  done: 'met',
  satisfied: 'met',
  true: 'met',
  not_met: 'not_met',
  'not met': 'not_met',
  'not yet met': 'not_met',
  unmet: 'not_met',
  continue: 'not_met',
  false: 'not_met',
  impossible: 'impossible',
  blocked: 'impossible',
  failed: 'impossible',
}

/**
 * Разбор ответа оценщика. JSON — основной путь; при мусоре пробуем вытащить
 * вердикт из текста, но никогда не считаем это подтверждением выполнения.
 */
export function parseVerdict(raw: string): GoalVerdictResult | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1))
      if (parsed && typeof parsed === 'object') {
        const value = parsed as Record<string, unknown>
        const rawVerdict = value.verdict ?? value.status ?? value.result ?? value.outcome
        const key = typeof rawVerdict === 'string' ? rawVerdict.trim().toLowerCase().replace(/[\s-]+/g, '_') : ''
        const verdict = VERDICT_ALIASES[key] ?? VERDICT_ALIASES[key.replace(/_/g, ' ')]
        if (verdict) {
          const rawReason = value.reason ?? value.explanation ?? value.details ?? value.note
          return { verdict, reason: typeof rawReason === 'string' ? rawReason.trim().slice(0, 600) : '' }
        }
      }
    } catch { /* fall through to keyword scan */ }
  }
  const lower = text.toLowerCase()
  if (lower.includes('impossible')) return { verdict: 'impossible', reason: clip(text, 300) }
  if (/not\s+yet\s+met|not\s+met|unmet/.test(lower)) return { verdict: 'not_met', reason: clip(text, 300) }
  if (/\bmet\b/.test(lower)) return { verdict: 'met', reason: clip(text, 300) }
  return undefined
}

/**
 * Обёртка над быстрой моделью. Один вызов, без инструментов, temperature 0.
 * При пустом/неразборчивом ответе — повтор один раз, затем not_met
 * (оценщик никогда не «выполняет» цель по ошибке транспорта).
 */
export function makeGoalJudge(complete: CompleteFn, modelType: 'fast' | 'main' = 'fast'): GoalJudge {
  return async ({ condition, transcript, turn }) => {
    const userContent = [
      `Completion condition (turn ${turn}):`,
      condition,
      '',
      'Transcript of the work so far:',
      transcript,
      '',
      'Decide: does the transcript show the condition is satisfied? Answer with the JSON only.',
    ].join('\n')
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await complete(
        [{ role: 'user', content: userContent }],
        modelType,
        GOAL_EVALUATOR_SYSTEM_PROMPT,
        { maxTokens: 400 },
      )
      const parsed = parseVerdict(raw)
      if (parsed) return parsed
    }
    return { verdict: 'not_met', reason: 'Evaluator returned an unreadable verdict; continuing toward the condition.' }
  }
}

/**
 * Ошибки, после которых цель снимается (как в [CC]): их нельзя обойти
 * повтором — нужен человек. Транзиентные (сеть, 5xx, rate limit) цель
 * сохраняют.
 */
export function isUnrecoverableGoalError(message: string): boolean {
  const text = String(message ?? '').toLowerCase()
  if (!text) return false
  return [
    'session expired',
    'sign in again',
    'invalid api key',
    'incorrect api key',
    'unauthorized',
    'authentication',
    'insufficient credit',
    'insufficient balance',
    'quota exceeded',
    'billing',
    'context overflow',
    'context length',
    'maximum context',
    'model not found',
    'model_not_found',
    'not available for this account',
  ].some(token => text.includes(token))
}
