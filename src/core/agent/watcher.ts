import { sidecarSemanticSearch, resolveSemanticModelPaths, type SidecarSemanticHit } from '../sidecar/sidecarClient'
import { getSkillManager } from '../skills/skillManager'
import { getEmbedder, cosineSimilarity, type Embedding } from '../context/embeddings'
import type { HintCandidate, AssistantsSettings } from '../../shared/assistants'
import { log } from '../logger'
import { getMemorySettings } from '../memory/globalMemorySettings'

export type WatcherTrigger =
  | { kind: 'user_message'; text: string }
  | { kind: 'tool_error'; toolName: string; error: string }
  | { kind: 'tool_repeat'; toolName: string; count: number }
  | { kind: 'plan_change'; text: string }
  | { kind: 'task_start'; text: string }
  | { kind: 'periodic'; text: string }
  | { kind: 'stuck'; text: string }
  | { kind: 'capability_gap'; toolName: string; text: string }

/** Возможность, доступная в ране: тул / MCP / plugin / скилл. */
export interface Capability {
  id: string
  kind: 'tool' | 'mcp' | 'plugin' | 'skill'
  name: string
  desc: string
}

/**
 * Дешёвый детерминированный prefilter: overlap ключевых слов контекста и описания.
 * Пустой результат (RU-запрос против EN-имён скиллов — типовой случай, overlap
 * не находится) — сигнал вызвать семантический скоринг scoreCapabilitiesSemantic.
 */
export function prefilterCapabilities(caps: Capability[], query: string, limit = 10): Capability[] {
  const kw = extractKeywords(query)
  if (kw.length === 0) return []
  const scored = caps.map(c => {
    const hay = `${c.name} ${c.desc}`.toLowerCase()
    const hits = kw.filter(k => hay.includes(k)).length
    return { c, hits }
  })
  scored.sort((a, b) => b.hits - a.hits)
  return scored.filter(s => s.hits > 0).slice(0, limit).map(s => s.c)
}

// Кэш эмбеддингов каталога: скиллы меняются редко, а prefilter ходит на каждый
// триггер. Ключ — id+имя+описание, переименование/правка сбрасывают запись.
const capEmbeddingCache = new Map<string, Embedding>()
// MCP catalogues can contain hundreds of tools. A 200-entry FIFO cache
// recomputed an entire 488-tool catalogue on every pass as it evicted itself.
const MAX_CAP_EMBEDDINGS = 4096

/**
 * Семантический скоринг каталога (fallback, когда keyword-overlap пуст —
 * RU-запрос против EN-имён скиллов). TF-IDF/MiniLM косинус; для LLM-судьи
 * важен порядок кандидатов, а не абсолютная величина скоринга.
 */
export async function scoreCapabilitiesSemantic(caps: Capability[], query: string, signal?: AbortSignal): Promise<Array<{ cap: Capability; score: number }>> {
  if (caps.length === 0) return []
  try {
    signal?.throwIfAborted()
    const embedder = await getEmbedder()
    const qv = await embedder.embed(query)
    const scored: Array<{ cap: Capability; score: number }> = []
    for (const cap of caps) {
      signal?.throwIfAborted()
      const key = `${embedder.mode}|${embedder.dim}|${cap.id}|${cap.name}|${cap.desc}`
      let cv = capEmbeddingCache.get(key)
      if (cv) capEmbeddingCache.delete(key)
      if (!cv) {
        cv = await embedder.embed(`${cap.name} ${cap.desc}`)
        signal?.throwIfAborted()
      }
      capEmbeddingCache.set(key, cv)
      if (capEmbeddingCache.size > MAX_CAP_EMBEDDINGS) {
        const oldest = capEmbeddingCache.keys().next().value
        if (oldest) capEmbeddingCache.delete(oldest)
      }
      scored.push({ cap, score: cosineSimilarity(qv, cv) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored
  } catch (err) {
    log('[Watcher] semantic capability scoring failed: %s', (err as Error).message)
    return []
  }
}

/** Простой хэш контекста для novelty-gate (не криптостойкий, только дедуп). */
export function hashContext(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return String(h)
}

const MAX_HINTS_PER_TRIGGER = 2
// E5-cosine: 0.55–0.65 набирает почти любой текст «на похожую тему» — раньше
// планка 0.55 была главным источником мусорных memory-хинтов. 0.65 отсекает
// маргинальную корреляцию, осмысленные совпадения у e5 обычно 0.7+.
const MIN_E5_SCORE = 0.65
// Кандидатный пол поиска: ниже рабочей планки, чтобы вес источника (0.5–1.5)
// мог и повышать (weight > 1 пускает 0.46+), и понижать. Раньше поиск сразу
// резал по MIN_E5_SCORE — умножение на вес было мёртвым кодом: снизить порог
// он мог только у уже прошедших хитов, а поднять — нечего.
const E5_CANDIDATE_FLOOR = MIN_E5_SCORE * 0.7
const SKILL_KEYWORD_MIN_MATCH = 2

function buildQuery(trigger: WatcherTrigger): string {
  switch (trigger.kind) {
    case 'user_message': return trigger.text.slice(0, 300)
    case 'tool_error': return `${trigger.toolName} error: ${trigger.error.slice(0, 200)}`
    case 'tool_repeat': return `${trigger.toolName} repeated ${trigger.count} times, alternative approach`
    case 'plan_change': return trigger.text.slice(0, 300)
    case 'task_start': return trigger.text.slice(0, 300)
    case 'periodic': return trigger.text.slice(0, 300)
    case 'stuck': return trigger.text.slice(0, 300)
    case 'capability_gap': return `${trigger.toolName} unavailable: ${trigger.text.slice(0, 200)}`
  }
}

function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []
  return [...new Set(words)].slice(0, 12)
}

export interface WatcherContext {
  projectWorkdir?: string
  projectId?: string
  chatId?: string
  incognito?: boolean
}

/** The sidecar returns the persisted row, so validate scope again before
 * turning a hit into prompt text. In particular, chat memory is not shared
 * with every chat that happens to belong to the same project. */
function allowedMemoryHit(hit: SidecarSemanticHit, memory: ReturnType<typeof getMemorySettings>, context: WatcherContext): boolean {
  const row = hit.memoryRow
  if (context.incognito || hit.source !== 'memory' || !row) return false
  if (row.scope === 'global') return memory.global
  if (row.scope === 'project') return memory.project && !!context.projectId && row.project_id === context.projectId
  if (row.scope === 'chat') return memory.chat && !!context.chatId && row.chat_id === context.chatId
    && (row.project_id ?? null) === (context.projectId ?? null)
  return false
}

async function searchMemory(query: string, settings: AssistantsSettings, dbPath: string, context: WatcherContext): Promise<HintCandidate[]> {
  if (!settings.sources.memory || context.incognito) return []
  const memory = getMemorySettings()
  if (!memory.enabled || (!memory.global && !memory.project && !memory.chat)) return []
  const paths = resolveSemanticModelPaths()
  if (!paths) return []
  try {
    const hits: SidecarSemanticHit[] = await sidecarSemanticSearch(
      {
        dbPath,
        query,
        limit: 5,
        sources: ['memory'],
        scope: 'all',
        projectId: context.projectId ?? null,
        crossProject: false,
        kind: null,
        memoryEnabled: memory.enabled,
        memoryGlobal: memory.global,
        memoryProject: memory.project,
        memoryChat: memory.chat,
      },
      paths,
    )
    const current = getMemorySettings()
    // A user may disable a scope while the sidecar is still searching.
    if (!current.enabled || current.global !== memory.global || current.project !== memory.project || current.chat !== memory.chat) return []
    return hits
      .filter(hit => allowedMemoryHit(hit, current, context))
      // Кандидатный пол, а не рабочая планка: окончательное решение принимает
      // applyWeightsAndFloor (там учитывается вес источника).
      .filter(h => h.score >= E5_CANDIDATE_FLOOR)
      .slice(0, MAX_HINTS_PER_TRIGGER * 2)
      .map(h => ({
        id: `mem-${h.sourceId}`,
        source: 'memory' as const,
        content: h.content.slice(0, 500),
        score: h.score,
        title: h.chatTitle ?? undefined,
      }))
  } catch (err) {
    log('[Watcher] E5 search failed: %s', (err as Error).message)
    return []
  }
}

function searchSkills(query: string, settings: AssistantsSettings, opts: { projectWorkdir?: string; projectId?: string }): HintCandidate[] {
  if (!settings.sources.skills) return []
  try {
    const manager = getSkillManager()
    const skills = manager.getActiveSkillsForChat(opts)
    const keywords = extractKeywords(query)
    if (keywords.length === 0) return []

    const scored: Array<{ skill: typeof skills[0]; score: number }> = []
    for (const skill of skills) {
      const haystack = `${skill.name} ${skill.description}`.toLowerCase()
      const matches = keywords.filter(k => haystack.includes(k)).length
      if (matches >= SKILL_KEYWORD_MIN_MATCH) {
        scored.push({ skill, score: matches / keywords.length })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, MAX_HINTS_PER_TRIGGER).map(({ skill, score }) => ({
      id: `skill-${skill.id}`,
      source: 'skill' as const,
      content: `Review skill ${JSON.stringify(skill.name)} with get_skill if useful for the current task.`,
      score,
      title: skill.name,
    }))
  } catch (err) {
    log('[Watcher] skill search failed: %s', (err as Error).message)
    return []
  }
}

export class Watcher {
  private settings: AssistantsSettings
  private dbPath: string
  private projectOpts: WatcherContext
  private revision = 0
  private collection = 0
  private recentIds = new Set<string>()
  private lastTriggerTs = 0
  private minIntervalMs = 3000
  /** W1 feedback: вес источника из bridge (0.5–1.5, корректируется после ранов). 1 = без коррекции. */
  private sourceWeightFn: (source: string) => number = () => 1

  constructor(settings: AssistantsSettings, dbPath: string, projectOpts: WatcherContext = {}) {
    this.settings = settings
    this.dbPath = dbPath
    this.projectOpts = { ...projectOpts }
  }

  updateSettings(settings: AssistantsSettings): void {
    this.revision++
    this.settings = settings
  }

  setSourceWeightProvider(fn: (source: string) => number): void {
    this.sourceWeightFn = fn
  }

  updateProject(opts: WatcherContext): void {
    this.revision++
    this.projectOpts = { ...opts }
    this.recentIds.clear()
    this.lastTriggerTs = 0
  }

  /**
   * Один E5/скилл-проход, результат разделён по источникам. Мосту нужен
   * именно такой вызов: memory-хиты он инжектит сразу (без LLM), а скиллы
   * использует только как fallback, когда локальная модель недоступна.
   * Два отдельных onTrigger() подряд не работают: minIntervalMs съедает второй.
   */
  async collect(trigger: WatcherTrigger, extraQueries: string[] = []): Promise<{ memory: HintCandidate[]; skills: HintCandidate[]; throttled?: boolean }> {
    if (!this.settings.enabled || !this.settings.watcherEnabled) return { memory: [], skills: [] }
    const now = Date.now()
    if (now - this.lastTriggerTs < this.minIntervalMs) return { memory: [], skills: [], throttled: true }
    this.lastTriggerTs = now

    const queries = [buildQuery(trigger), ...extraQueries.slice(0, 2)]
    const revision = this.revision
    const collection = ++this.collection
    const context = { ...this.projectOpts }
    const memoryBatches = await Promise.all(queries.map(q => searchMemory(q, this.settings, this.dbPath, context)))
    if (!this.settings.enabled || !this.settings.watcherEnabled || revision !== this.revision || collection !== this.collection) return { memory: [], skills: [] }
    const skillHints = searchSkills(queries[0], this.settings, this.projectOpts)
    const seen = new Set<string>()
    const memoryHints: HintCandidate[] = []
    for (const batch of memoryBatches) {
      if (!this.settings.sources.memory) break
      for (const h of batch) {
        if (seen.has(h.id)) continue
        seen.add(h.id)
        memoryHints.push(h)
      }
    }
    const userFloor = Number.isFinite(this.settings.relevanceThreshold) ? this.settings.relevanceThreshold : MIN_E5_SCORE
    const memoryFloor = Math.max(userFloor, MIN_E5_SCORE / Math.max(1, this.sourceWeightFn('memory')))
    return {
      // Learned weights may raise the prior, but cannot silence the source:
      // no accepted hints means no feedback and therefore no recovery.
      memory: this.finish(memoryHints.filter(h => h.score >= memoryFloor), trigger),
      // На skill порог не распространяем — его keyword-score несравним с E5-cosine.
      skills: this.finish(skillHints, trigger),
    }
  }

  private finish(hints: HintCandidate[], trigger: WatcherTrigger): HintCandidate[] {
    const all = hints
      .filter(h => !this.recentIds.has(h.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HINTS_PER_TRIGGER)

    for (const h of all) {
      this.recentIds.add(h.id)
      if (this.recentIds.size > 100) {
        const first = this.recentIds.values().next().value
        if (first) this.recentIds.delete(first)
      }
    }

    if (all.length > 0) {
      log('[Watcher] trigger=%s → %d hints (top score=%.2f)', trigger.kind, all.length, all[0].score)
    }
    return all
  }

  async onTrigger(trigger: WatcherTrigger, extraQueries: string[] = [], memoryOnly = false): Promise<HintCandidate[]> {
    const { memory, skills } = await this.collect(trigger, extraQueries)
    if (memoryOnly) return memory
    return [...memory, ...skills].sort((a, b) => b.score - a.score).slice(0, MAX_HINTS_PER_TRIGGER)
  }
}
