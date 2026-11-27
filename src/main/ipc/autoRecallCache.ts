import { searchAllSources } from '../../core/memory/MemoryStore'
import { getMemorySettings } from '../../core/memory/globalMemorySettings'

// Short-lived cache for auto-recall only. Explicit recall_memory must always
// execute a fresh search and update its hit feedback as before.
const AUTO_RECALL_CACHE_TTL_MS = 5_000
const AUTO_RECALL_CACHE_CAP = 64
const AUTO_RECALL_CACHE_VERSION = 1
const autoRecallCache = new Map<string, { expiresAt: number; results: Awaited<ReturnType<typeof searchAllSources>> }>()
let autoRecallCacheGeneration = 0

/** Invalidate only the short-lived automatic recall cache after a new message
 * enters the searchable corpus. Explicit recall never uses this cache. */
export function invalidateAutoRecallCache(): void {
  autoRecallCacheGeneration++
  autoRecallCache.clear()
}

export async function searchAutoRecallCached(params: Parameters<typeof searchAllSources>[0] & { chatId?: string }): Promise<Awaited<ReturnType<typeof searchAllSources>>> {
  const memory = getMemorySettings()
  if (!memory.enabled) return []
  // This cache serves implicit prompt retrieval only. Explicit cross-project
  // recall goes directly through searchAllSources and retains its opt-in.
  const scopedParams = { ...params, crossProject: false }
  const sources = params.sources === 'all' || params.sources == null ? 'all' : [...params.sources].sort().join(',')
  const key = JSON.stringify({
    version: AUTO_RECALL_CACHE_VERSION,
    generation: autoRecallCacheGeneration,
    project: params.projectId ?? '',
    chat: params.chatId ?? '',
    memory: [memory.enabled, memory.global, memory.project, memory.chat],
    scope: params.scope ?? 'all',
    kind: params.kind ?? '',
    sources,
    crossProject: false,
    limit: params.limit ?? 20,
    minScore: params.minScore ?? 0.01,
    query: params.query,
  })
  const now = Date.now()
  const cached = autoRecallCache.get(key)
  if (cached && cached.expiresAt > now) {
    autoRecallCache.delete(key)
    autoRecallCache.set(key, cached)
    return cached.results.map(result => ({ ...result, item: result.item ? { ...result.item } : undefined }))
  }
  if (cached) autoRecallCache.delete(key)
  const hits = await searchAllSources(scopedParams)
  const current = getMemorySettings()
  if (!current.enabled || current.global !== memory.global || current.project !== memory.project || current.chat !== memory.chat) return []
  const results = hits.filter(hit => {
    if (hit.source === 'graph') return current.project && !!params.projectId
    if (hit.source !== 'memory') return current.chat
    if (hit.item?.scope === 'global') return current.global
    if (hit.item?.scope === 'project') return current.project && !!params.projectId && hit.item.projectId === params.projectId
    if (hit.item?.scope === 'chat') return current.chat && !!params.chatId && hit.item.chatId === params.chatId
      && (hit.item.projectId ?? null) === (params.projectId ?? null)
    return false
  })
  while (autoRecallCache.size >= AUTO_RECALL_CACHE_CAP) {
    const oldest = autoRecallCache.keys().next().value
    if (oldest === undefined) break
    autoRecallCache.delete(oldest)
  }
  autoRecallCache.set(key, { expiresAt: Date.now() + AUTO_RECALL_CACHE_TTL_MS, results })
  return results.map(result => ({ ...result, item: result.item ? { ...result.item } : undefined }))
}

// ── Auto-recall helpers ─────────────────────────────────────────────────────

/** Stopwords для keyword extraction (Russian + English). */
const RECALL_STOPWORDS = new Set<string>([
  // Russian
  'как', 'что', 'это', 'для', 'на', 'по', 'не', 'но', 'или', 'и', 'а', 'то',
  'же', 'бы', 'ли', 'ни', 'какой', 'какая', 'который', 'которая', 'его', 'её',
  'их', 'мы', 'вы', 'он', 'она', 'они', 'меня', 'тебя', 'этом', 'эта', 'эти',
  'эту', 'всё', 'все', 'всех', 'там', 'тут', 'где', 'когда', 'тогда', 'чтобы',
  'потому', 'если', 'уже', 'ещё', 'был', 'была', 'есть', 'нет', 'надо', 'нужно',
  'можно', 'нельзя', 'так', 'такой', 'за', 'из', 'от', 'до', 'об', 'при', 'про',
  'над', 'под', 'без', 'через', 'мне', 'тебе', 'ему', 'ей', 'им', 'вам', 'нам',
  'чтобы', 'тоже', 'ведь', 'вот', 'чем', 'того', 'тому', 'ними', 'ней', 'ним',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'not', 'no', 'yes', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'for', 'in', 'on',
  'at', 'to', 'of', 'from', 'with', 'by', 'as', 'this', 'that', 'these',
  'those', 'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our', 'you',
  'your', 'he', 'his', 'she', 'her', 'what', 'which', 'who', 'when', 'where',
  'why', 'how', 'all', 'each', 'every', 'both', 'about', 'into', 'out', 'up',
  'down', 'over', 'under', 'again', 'just', 'also', 'than', 'then', 'here',
])

/**
 * Извлекает ключевые слова из текста пользователя для auto-recall.
 * Удаляет stopwords, оставляет слова длиной ≥ 3 (trigram-минимум),
 * берёт топ-10 уникальных. Возвращает строку для FTS5/TF-IDF поиска.
 * Если keyword extraction даёт пустой результат — fallback на raw text.
 */
export function extractRecallKeywords(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\w\u0400-\u04FF]/g, ' ') // keep Cyrillic + word chars
    .split(/\s+/)
    .filter(w => w.length >= 3 && !RECALL_STOPWORDS.has(w))
  const seen = new Set<string>()
  const unique: string[] = []
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); unique.push(w) }
  }
  const result = unique.slice(0, 10).join(' ')
  // Fallback: если extraction дал пустой или слишком короткий — берём raw
  return result.length >= 3 ? result : text.slice(0, 200)
}

/**
 * Build dedup key for auto-recall result. Used by cross-message dedup:
 * if the same result was already injected in a previous message, skip it.
 */
export function getRecallDedupKey(r: { source: string; item?: { id?: string }; messageId?: string; content: string }): string {
  if (r.source === 'memory' && r.item?.id) return `mem:${r.item.id}`
  if (r.source === 'messages' && r.messageId) return `msg:${r.messageId}`
  if (r.source === 'pinned' && r.messageId) return `pin:${r.messageId}`
  if (r.source === 'graph') {
    // Для графа ключ — label узла (извлекаем из "[graph:file] contextManager.ts →...")
    const match = r.content.match(/^\[graph:\w+\]\s+(.+?)(?:\s*→|$)/)
    return `graph:${match?.[1]?.trim() ?? r.content.slice(0, 50)}`
  }
  // summaries, agent_logs — по первым 100 символам контента
  return `${r.source}:${r.content.slice(0, 100)}`
}
