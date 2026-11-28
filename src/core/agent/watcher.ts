import { sidecarSemanticSearch, resolveSemanticModelPaths, type SidecarSemanticHit } from '../sidecar/sidecarClient'
import { getSkillManager } from '../skills/skillManager'
import type { HintCandidate, AssistantsSettings } from '../../shared/assistants'
import { log } from '../logger'
import { getMemorySettings } from '../memory/globalMemorySettings'
import { buildRecallEvidence, hasRecallAnchor, hasRecallEvidence } from '../memory/recallRelevance'

export type WatcherTrigger =
  | { kind: 'user_message'; text: string }
  | { kind: 'tool_error'; toolName: string; error: string }
  | { kind: 'tool_repeat'; toolName: string; count: number }
  | { kind: 'plan_change'; text: string }
  | { kind: 'task_start'; text: string }
  | { kind: 'periodic'; text: string }
  | { kind: 'stuck'; text: string }
  | { kind: 'capability_gap'; toolName: string; text: string }

/** Простой хэш контекста для novelty-gate (не криптостойкий, только дедуп). */
export function hashContext(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return String(h)
}

const MAX_HINTS_PER_TRIGGER = 2
const MIN_E5_SCORE = 0.65

export interface WatcherContext {
  projectWorkdir?: string
  projectId?: string
  chatId?: string
  incognito?: boolean
  memoryAllowed?: boolean
}

/** The sidecar returns the persisted row, so validate scope again before
 * turning a hit into prompt text. In particular, chat memory is not shared
 * with every chat that happens to belong to the same project. */
function allowedMemoryHit(hit: SidecarSemanticHit, memory: ReturnType<typeof getMemorySettings>, context: WatcherContext): boolean {
  const row = hit.memoryRow
  if (context.incognito || hit.source !== 'memory' || !row) return false
  if (row.scope === 'project') return memory.project && !!context.projectId && row.project_id === context.projectId
  if (row.scope === 'chat') return memory.chat && !!context.chatId && row.chat_id === context.chatId
    && (row.project_id ?? null) === (context.projectId ?? null)
  return false
}

type RecallEvidence = ReturnType<typeof buildRecallEvidence>

async function searchMemory(query: string, evidence: RecallEvidence, taskEvidence: RecallEvidence, settings: AssistantsSettings, dbPath: string, context: WatcherContext): Promise<HintCandidate[]> {
  if (!settings.sources.memory || context.incognito || context.memoryAllowed === false) return []
  const memory = getMemorySettings()
  const project = memory.project && !!context.projectId
  const chat = memory.chat && !!context.chatId
  if (!memory.enabled || (!project && !chat)) return []
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
        chatId: context.chatId ?? null,
        crossProject: false,
        kind: null,
        memoryEnabled: memory.enabled,
        memoryGlobal: false,
        memoryProject: project,
        memoryChat: chat,
      },
      paths,
    )
    const current = getMemorySettings()
    // A user may disable a scope while the sidecar is still searching.
    if (!current.enabled || current.project !== memory.project || current.chat !== memory.chat) return []
    const userFloor = Number.isFinite(settings.relevanceThreshold) ? settings.relevanceThreshold : MIN_E5_SCORE
    const floor = Math.max(MIN_E5_SCORE, userFloor)
    return hits
      .filter(hit => {
        if (!(hit.score >= floor) || !allowedMemoryHit(hit, current, context)) return false
        const text = hit.content.slice(0, 500)
        return hasRecallEvidence(evidence, text) && (taskEvidence === evidence || hasRecallEvidence(taskEvidence, text))
      })
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

function searchSkills(evidence: RecallEvidence, settings: AssistantsSettings, opts: WatcherContext): HintCandidate[] {
  if (!settings.sources.skills || opts.incognito) return []
  try {
    const skills = getSkillManager().getActiveSkillsForChat(opts)
    return skills.flatMap(skill => {
      if (!hasRecallEvidence(evidence, `${skill.name} ${skill.description ?? ''}`)) return []
      return [{
        id: `skill-${skill.id}`,
        source: 'skill' as const,
        content: `Review skill ${JSON.stringify(skill.name)} with get_skill if useful for the current task.`,
        score: hasRecallEvidence(evidence, skill.name) ? 1 : 0.85,
        title: skill.name,
      }]
    })
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
  private taskEvidence?: RecallEvidence
  private recentIds = new Set<string>()
  private lastTriggerTs = 0
  private minIntervalMs = 3000

  constructor(settings: AssistantsSettings, dbPath: string, projectOpts: WatcherContext = {}) {
    this.settings = settings
    this.dbPath = dbPath
    this.projectOpts = { ...projectOpts }
  }

  updateSettings(settings: AssistantsSettings, memoryAllowed = this.projectOpts.memoryAllowed): void {
    this.invalidateSearch()
    this.settings = settings
    this.projectOpts.memoryAllowed = memoryAllowed
  }

  updateProject(opts: WatcherContext): void {
    this.resetTask()
    this.projectOpts = { ...opts }
    this.recentIds.clear()
  }

  resetTask(): void {
    this.invalidateSearch()
    this.taskEvidence = undefined
  }

  invalidateSearch(): void {
    this.revision++
    this.lastTriggerTs = 0
  }

  /** Retrieve both local sources within one throttle window. */
  async collect(trigger: WatcherTrigger): Promise<{ memory: HintCandidate[]; skills: HintCandidate[]; throttled?: boolean }> {
    if (!this.settings.enabled || !this.settings.watcherEnabled) return { memory: [], skills: [] }
    const beginsTask = trigger.kind === 'task_start' || trigger.kind === 'user_message'
    if (!beginsTask && trigger.kind !== 'tool_error') return { memory: [], skills: [] }
    // The tool name describes where a failure happened. Match the error itself
    // and require the retrieved excerpt to also match the current user's task.
    const query = (trigger.kind === 'tool_error' ? trigger.error : trigger.text).slice(0, 500)
    const evidence = buildRecallEvidence(query)
    if (beginsTask) {
      this.invalidateSearch()
      this.taskEvidence = evidence
    }
    const taskEvidence = this.taskEvidence
    if (!taskEvidence || !hasRecallAnchor(evidence) || !hasRecallAnchor(taskEvidence)) return { memory: [], skills: [] }
    const now = Date.now()
    if (now - this.lastTriggerTs < this.minIntervalMs) return { memory: [], skills: [], throttled: true }
    this.lastTriggerTs = now

    const revision = ++this.revision
    const context = { ...this.projectOpts }
    const memory = await searchMemory(query, evidence, taskEvidence, this.settings, this.dbPath, context)
    if (revision !== this.revision) {
      return { memory: [], skills: [], throttled: true }
    }
    const skills = beginsTask ? searchSkills(evidence, this.settings, context) : []
    return {
      memory: this.finish(memory, trigger),
      skills: this.finish(skills, trigger),
    }
  }

  private finish(hints: HintCandidate[], trigger: WatcherTrigger): HintCandidate[] {
    const all = hints
      .filter(h => !this.recentIds.has(h.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HINTS_PER_TRIGGER)

    if (all.length > 0) {
      log('[Watcher] trigger=%s → %d hints (top score=%.2f)', trigger.kind, all.length, all[0].score)
    }
    return all
  }

  markDelivered(hintId: string): void {
    this.recentIds.add(hintId)
    if (this.recentIds.size > 100) {
      const first = this.recentIds.values().next().value
      if (first) this.recentIds.delete(first)
    }
  }

  async onTrigger(trigger: WatcherTrigger, memoryOnly = false): Promise<HintCandidate[]> {
    const { memory, skills } = await this.collect(trigger)
    const selected = memoryOnly ? memory : [...memory, ...skills].sort((a, b) => b.score - a.score).slice(0, MAX_HINTS_PER_TRIGGER)
    for (const hint of selected) this.markDelivered(hint.id)
    return selected
  }
}
