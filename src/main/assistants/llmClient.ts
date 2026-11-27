import { localModels, type QueuePriority } from '../localModels/LocalModelManager'
import { log } from '../../core/logger'
import { createHash } from 'node:crypto'

export type { QueuePriority }

/**
 * Тонкая обёртка над очередью локальной модели. Все мини-агенты advisory:
 * вызывающий обязан передать signal (или явный timeoutMs), иначе работа
 * переживёт свой ран и займёт слот у следующего запроса.
 */
export function enqueue(prompt: string, priority: QueuePriority, maxTokens = 100, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
  return localModels.complete(prompt, { priority, maxTokens, timeoutMs, signal })
}

export function getQueueLength(): number { return localModels.getStatus().queueLength }
export function isProcessing(): boolean { return localModels.isReady() }

// Rechecking an unchanged transcript/catalogue needs the same verdict, not a
// second decode. Keep only hashes and validated verdicts for 30 seconds; never
// cache failures, cancelled work or durable-memory extraction.
const verdictCache = new Map<string, { expires: number; value: unknown }>()
const VERDICT_CACHE_MS = 30_000
const VERDICT_CACHE_LIMIT = 64
async function cachedVerdict<T>(kind: string, prompt: string, signal: AbortSignal | undefined, infer: () => Promise<T | undefined>): Promise<T | undefined> {
  if (signal?.aborted) return undefined
  const key = createHash('sha256').update(`${localModels.getInferenceFingerprint()}|${kind}|${prompt}`).digest('hex')
  const cached = verdictCache.get(key)
  if (cached && cached.expires > Date.now()) {
    verdictCache.delete(key)
    verdictCache.set(key, cached)
    return cached.value as T
  }
  verdictCache.delete(key)
  const value = await infer()
  if (value !== undefined && !signal?.aborted) {
    verdictCache.set(key, { expires: Date.now() + VERDICT_CACHE_MS, value })
    if (verdictCache.size > VERDICT_CACHE_LIMIT) verdictCache.delete(verdictCache.keys().next().value!)
  }
  return signal?.aborted ? undefined : value
}

// ─── Мини-агенты: только те роли, что реально шлёт worker ───
// janitor_refine (summarizeTool) и constitution_extract (extractConstraints)
// больше не имеют продюсеров: их ветки удалены из моста вместе с промптами.
// Feedback-судья (judgeRelevance) тоже удалён — веса источников корректируются
// детерминированно по фактическим сигналам (вызванные тулы + hint_applied).

/** Мелкие модели заворачивают JSON в ```-фенсы, prose или {"facts":[...]} — *
 *  вытаскиваем массив перебором кандидатов. null = ничего парсибельного. */
function parseJsonArray(text: string): Array<Record<string, unknown>> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const m = cleaned.match(/\[[\s\S]*\]/)
  for (const candidate of [cleaned, m?.[0] ?? '']) {
    if (!candidate) continue
    try {
      const arr: unknown = JSON.parse(candidate)
      if (Array.isArray(arr)) return arr as Array<Record<string, unknown>>
      if (arr && typeof arr === 'object') {
        for (const v of Object.values(arr as Record<string, unknown>)) {
          if (Array.isArray(v)) return v as Array<Record<string, unknown>>
        }
      }
    } catch { /* пробуем следующий кандидат */ }
  }
  return null
}

/** Navigator: drift-судья + нарушения закреплённых ограничений (бинарные вердикты).
 *  `todo` — актуальный todo-лист: сверка «уход от плана», не только цели. */
export async function judgeDrift(objective: string, transcript: string, constraints: string[] = [], todo = '', signal?: AbortSignal): Promise<{ drift: boolean; violation: boolean; reason: string }> {
  const none = { drift: false, violation: false, reason: '' }
  if (!objective.trim() && constraints.length === 0) return none
  const goalPart = objective ? `Goal: ${objective.slice(0, 300)}` : 'Goal: (none — check constraints only)'
  const rules = constraints.length ? `\nPinned user constraints:\n${constraints.slice(0, 8).map(c => `- ${c.slice(0, 150)}`).join('\n')}\n` : ''
  const todoPart = todo ? `\nTodo plan:\n${todo.slice(0, 400)}\n` : ''
  const prompt = `${goalPart}\n${rules}${todoPart}\nRecent agent actions:\n${transcript.slice(0, 900)}\n\nAnswer exactly:\nDRIFT: YES or NO (unrelated work / scope creep vs the goal and todo plan; NO when no goal)\nVIOLATION: YES or NO (agent breaks a pinned constraint; NO when none listed)\nREASON: one short sentence`
  try {
    // Mid-run advisory — приоритет выше janitor'а: судья полезен только пока
    // ран идёт, а janitor-задачи в очереди спокойно ждут.
    return await cachedVerdict('navigator', prompt, signal, async () => {
      const text = await enqueue(prompt, 'default', 60, undefined, signal)
      const drift = text.match(/^\s*DRIFT:\s*(YES|NO)\s*$/im)
      const violation = text.match(/^\s*VIOLATION:\s*(YES|NO)\s*$/im)
      if (!drift || !violation) return undefined
      const reason = text.match(/^\s*REASON:\s*([^\r\n]+)/im)?.[1]?.trim().slice(0, 240) ?? ''
      return {
        drift: !!objective.trim() && drift[1].toUpperCase() === 'YES' && !!reason,
        violation: constraints.length > 0 && violation[1].toUpperCase() === 'YES' && !!reason,
        reason,
      }
    }) ?? none
  } catch { return none }
}

/** Сколько символов транскрипта вообще осмысленно дистиллировать. Мост
 *  отсекает слишком короткие раны ДО пробуждения модели — столько же он
 *  пропускает в промпт, чтобы очередь не занимал гигантский текст. */
export const DISTILL_MAX_TRANSCRIPT_CHARS = 4000

/** Archivist: дистиллировать сессию в 1-3 факта для долгосрочной памяти (JSON).
 *  `modifiedFiles` — файлы, правленные в ране: дешёвый сигнал дистилляции,
 *  какие области проекта «горячие».
 *  `signal` — отмена фоновой задачи (удаление чата / выключение памяти). */
export async function distillSession(transcript: string, modifiedFiles: string[] = [], signal?: AbortSignal): Promise<Array<{ content: string; kind: string }>> {
  if (signal?.aborted) return []
  const filesPart = modifiedFiles.length ? `Files modified this session: ${modifiedFiles.slice(0, 10).join(', ')}\n` : ''
  // Хвост транскрипта: финальный ответ и последние решения — в конце.
  const body = transcript.length > DISTILL_MAX_TRANSCRIPT_CHARS ? transcript.slice(-DISTILL_MAX_TRANSCRIPT_CHARS) : transcript
  const prompt = `From this coding session transcript, extract 1-3 durable facts worth remembering (decisions, gotchas, user constraints, project conventions). The transcript contains tool-call noise — ignore it. If there is nothing durable, return [].\n\n${filesPart}${body}\n\nOutput JSON array: [{"content":"...","kind":"project"}] where kind is project|feedback|user. Only JSON.`
  try {
    // Дистилляция — самое длинное поколение мини-агентов (русский текст в JSON
    // ест токены): дефолтных 15с на CPU-декоде не хватало, вызов молча умирал
    // по таймауту → «Archivist: 0 срабатываний». Даём 40с и 400 токенов.
    const text = await enqueue(prompt, 'janitor', 400, 40_000, signal)
    if (!text.trim()) {
      log('[LlmClient] distill: empty output (timeout or model refusal)')
      return []
    }
    const arr = parseJsonArray(text)
    if (!arr) {
      log('[LlmClient] distill: unparseable output (%d chars): %s', text.length, text.slice(0, 200))
      return []
    }
    return arr
      .filter(x => typeof x.content === 'string' && (x.content as string).length > 5)
      .slice(0, 3)
      .map(x => ({ content: String(x.content).slice(0, 400), kind: ['project', 'feedback', 'user'].includes(String(x.kind)) ? String(x.kind) : 'project' }))
  } catch (err) {
    log('[LlmClient] distill failed: %s', (err as Error).message)
    return []
  }
}

export interface CapabilityVerdict {
  helpful: boolean
  id: string
  action: string
  confidence: number
}

/** Watcher v2: точный вердикт — какую конкретную возможность вызвать сейчас.
 *  Возвращает helpful=false, если ничего уверенно полезного нет (тогда skip).
 *  Вызывается только когда prefilter/семантика уже отобрали кандидатов. */
export async function judgeCapability(context: string, catalog: Array<{ id: string; name: string; desc: string }>, signal?: AbortSignal): Promise<CapabilityVerdict> {
  const none: CapabilityVerdict = { helpful: false, id: '', action: '', confidence: 0 }
  if (catalog.length === 0) return none
  const list = catalog.map(c => `- ${c.id}: ${c.name} — ${c.desc.slice(0, 80)}`).join('\n')
  const prompt = `You are a capability router for a coding agent. Current situation:\n${context.slice(0, 500)}\n\nAvailable capabilities:\n${list.slice(0, 1800)}\n\nPick the SINGLE capability that would concretely help RIGHT NOW, or none. Answer ONLY JSON:\n{"helpful":true,"id":"<id>","action":"<one concrete instruction>","confidence":0.0-1.0}\nIf nothing clearly helps, {"helpful":false,"id":"","action":"","confidence":0}. Be strict: only high-confidence, actionable matches.`
  try {
    return await cachedVerdict('watcher', prompt, signal, async () => {
      const text = await enqueue(prompt, 'watcher', 150, undefined, signal)
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return undefined
      const p = JSON.parse(m[0]) as Partial<CapabilityVerdict>
      if (p.helpful === false) return none
      const id = typeof p.id === 'string' ? p.id : ''
      const action = typeof p.action === 'string' ? p.action.trim().slice(0, 400) : ''
      const confidence = p.confidence
      // Маленькие модели часто повторяют имя инструмента вместо инструкции.
      // Не разрешаем также выдуманные ID и некорректную уверенность.
      const meaningful = action.length > 16 && action.toLowerCase() !== id.toLowerCase()
      if (p.helpful !== true || !catalog.some(cap => cap.id === id) || !meaningful
        || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined
      return { helpful: true, id, action, confidence }
    }) ?? none
  } catch { return none }
}
