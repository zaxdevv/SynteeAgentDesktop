/**
 * outcomeExtractor.ts — LLM-извлечение уроков из agent_logs.
 *
 * Фаза 4: agent_logs теперь пишется (logAgentAction в chat.ipc.ts:case 'step').
 * Этот модуль читает недавние логи, через fast-LLM извлекает уроки
 * («что сработало/не сработало») и сохраняет их в memory_items как
 * kind='agent_outcome' — для future recall_memory.
 *
 * Триггеры:
 *   - onCompactionTrigger (в extractor.ts) — после extract фактов
 *   - Idle-extraction (10 мин) — в chat.ipc.ts scheduleIdleExtraction
 *   - Ручной запуск через IPC (memory:extractOutcomes) — для UI кнопки
 *
 * Cost-control:
 *   - Skip если agent_logs пуст или <5 записей (нечего извлекать)
 *   - Skip если последний extract был недавно (metadata->last_outcome_extract)
 *   - Бесплатная fast-модель (роль 'fastContext')
 *   - Throttle: не чаще раза в час на чат
 */

import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { saveMemoryItem } from './MemoryStore'
import { getRecentAgentLogs, type AgentLogEntry } from '../db/memory'
import { extractJsonFromLlmResponse } from '../context/fastContext/annotator'

// ─── Типы ────────────────────────────────────────────────────────────────────

export interface ExtractedOutcome {
  title: string
  content: string
  key?: string
  importance?: number
}

export interface OutcomeExtractResult {
  extracted: number
  error?: string
}

const OUTCOME_SYSTEM_PROMPT = `You are an analyzer of AI agent action logs. Your task is to extract LESSONS from tool-call outcomes: what worked, what did not work, what patterns are visible.

Extract agent_outcome — long-term lessons for future sessions:
- What led to an error and how to avoid it ("edit_file crashes on files >5MB — read in chunks")
- What works well and is worth repeating ("tests run via npm test, ~3 sec")
- Project environment patterns ("PowerShell requires \\ in paths", "tsc crashes on circular imports")
- Non-obvious dependencies ("after editing types.ts you need to restart the dev server")

DO NOT extract:
- Trivial successes ("read_file successfully read the file")
- One-time details of the current task
- Duplicates of already known facts
- General banalities ("tests are important")

Answer — JSON only, no markdown:
{"outcomes":[{"title":"short title 1-5 words","content":"specific lesson","key":"dedup_key_optional","importance":0.0-1.0}]}

Rules:
- title — short title (1-5 words): "Edit crashes on >5MB", "Tests via npm test". Do NOT use a full sentence.
- content — self-contained lesson: "Edit tool crashes on files >5MB — use read_file in chunks"
- key — optional, for deduplication (e.g. "large_file_edit", "powershell_paths")
- importance — 0.0-1.0 (higher for critical lessons, lower for minor ones). Facts with importance < 0.4 will be discarded.
- If there are no lessons — return {"outcomes":[]}
- Do not invent, rely only on the provided logs`

// ─── Главная функция ─────────────────────────────────────────────────────────

/**
 * Извлекает уроки из недавних agent_logs через fast-LLM.
 *
 * @param chatId — если задан, логи берутся только для этого чата; иначе все
 * @param limit — сколько последних логов анализировать (default 30)
 */
export async function extractOutcomesFromLogs(
  store: Store,
  chatId?: string,
  limit = 30,
): Promise<{ outcomes: ExtractedOutcome[]; error?: string }> {
  // Skip если логов мало
  const logs = getRecentAgentLogs(chatId, limit)
  if (logs.length < 5) {
    return { outcomes: [] }
  }

  // Формируем промпт из логов
  const logsText = formatLogsForPrompt(logs)
  const prompt = `Analyze the AI agent action logs and extract long-term lessons (agent_outcome).\n\n${logsText}\n\nReturn JSON with lessons (or {"outcomes":[]} if there are no lessons).`

  // LLM-вызов
  const aiClient = new AIClient(store)
  let raw = ''
  try {
    await aiClient.streamChat(
      [{ role: 'user', content: prompt }],
      {
        onToken: (t) => { raw += t },
        onDone: () => {},
        onError: () => {},
      },
      'fastContext',
      OUTCOME_SYSTEM_PROMPT,
      undefined,
      0.1,
    )
  } catch (e) {
    return { outcomes: [], error: (e as Error).message }
  }

  // Парсим JSON
  const parsed = extractJsonFromLlmResponse(raw)
  if (!parsed || !Array.isArray(parsed.outcomes)) {
    return { outcomes: [], error: 'invalid JSON response' }
  }

  const outcomes: ExtractedOutcome[] = []
  for (const o of parsed.outcomes) {
    if (typeof o !== 'object' || o === null) continue
    const obj = o as Record<string, unknown>
    const content = typeof obj.content === 'string' ? obj.content.trim() : ''
    if (!content) continue
    // importance threshold — skip low-importance outcomes (anti-noise)
    const importance = typeof obj.importance === 'number' ? Math.max(0, Math.min(1, obj.importance)) : 0.5
    if (importance < 0.4) continue
    // title — required, fallback to content slice if missing
    const title = typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim().slice(0, 120)
      : content.slice(0, 80)
    outcomes.push({
      title,
      content,
      key: typeof obj.key === 'string' && obj.key.trim() ? obj.key.trim() : undefined,
      importance,
    })
  }

  return { outcomes }
}

function formatLogsForPrompt(logs: AgentLogEntry[]): string {
  // Группируем по tool + success/error для компактности
  // Инвертируем порядок (старые → новые) для логичности нарратива
  const sorted = [...logs].reverse()
  const lines: string[] = ['Agent action logs (oldest to newest):', '']
  for (const log of sorted) {
    const time = new Date(log.createdAt).toLocaleTimeString('ru')
    const tool = log.tool ?? '?'
    const success = !log.error
    const status = success ? 'OK' : 'FAIL'
    const argsStr = log.args ? JSON.stringify(log.args).slice(0, 150) : ''
    const resultStr = log.result?.slice(0, 200) ?? log.error?.slice(0, 200) ?? ''
    lines.push(`[${time}] ${tool} → ${status}${argsStr ? ` | args: ${argsStr}` : ''}${resultStr ? ` | ${resultStr}` : ''}`)
  }
  return lines.join('\n')
}

// ─── Сохранение ──────────────────────────────────────────────────────────────

/**
 * Извлекает уроки из agent_logs и сохраняет в memory_items.
 * chatId используется для scope (project если есть projectId, иначе global).
 */
export async function extractAndSaveOutcomes(
  store: Store,
  params: { chatId?: string; projectId?: string },
): Promise<OutcomeExtractResult> {
  const { outcomes, error } = await extractOutcomesFromLogs(store, params.chatId)
  if (error) return { extracted: 0, error }
  if (outcomes.length === 0) return { extracted: 0 }

  let saved = 0
  for (const outcome of outcomes) {
    try {
      await saveMemoryItem({
        title: outcome.title,
        content: outcome.content,
        kind: 'agent_outcome',
        scope: params.projectId ? 'project' : 'global',
        projectId: params.projectId,
        chatId: params.chatId,
        key: outcome.key,
        source: 'agent_log',
        confidence: 0.7, // LLM-извлечённое — умеренная уверенность
        importance: outcome.importance ?? 0.5,
        // agent_log НЕ pinned — подлежит decay-prune если не используется
      })
      saved++
    } catch (e) {
      console.warn('[outcomeExtractor] saveMemoryItem failed:', (e as Error).message)
    }
  }

  return { extracted: saved }
}
