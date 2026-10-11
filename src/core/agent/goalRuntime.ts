import type { ChatGoal, GoalStatus } from '../../shared/types/goal'
import { resolve } from 'path'
import { statSync, readFileSync } from 'fs'

export interface GoalReport {
  status: 'continue' | 'completed' | 'blocked'
  progress: string
  blocker?: string
}

/** Pure: untrusted model text is parsed, never treated as verification evidence. */
export function parseGoalReport(answer: string): GoalReport | undefined {
  try {
    const text = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const report: unknown = JSON.parse(text).goal_report
    if (!report || typeof report !== 'object') return undefined
    const value = report as Record<string, unknown>
    if (!['continue', 'completed', 'blocked'].includes(String(value.status)) ||
      typeof value.progress !== 'string' || !value.progress.trim() ||
      (value.status === 'blocked' && (typeof value.blocker !== 'string' || !value.blocker.trim()))) return undefined
    return { status: value.status as GoalReport['status'], progress: value.progress,
      ...(typeof value.blocker === 'string' ? { blocker: value.blocker } : {}) }
  } catch { return undefined }
}

export interface GoalCriterionEvidence {
  criterion: string
  callId: string
  /** Set only by the trusted tool observer after freshness/scope checks. */
  verified: boolean
}

/** Pure completion decision. Model claims and partial coverage cannot pass. */
export function verifyGoalCompletion(
  goal: Pick<ChatGoal, 'criteria' | 'constraints'>,
  observations: readonly GoalCriterionEvidence[],
): { passed: boolean; evidence: string[] } {
  const evidence: string[] = []
  const passed = goal.constraints.length === 0 && goal.criteria.length > 0 && goal.criteria.every(criterion => {
    if (criterion !== 'diagnostics_passed' && !/^(file_contains|file_not_contains):(.+?)::([\s\S]+)$/.test(criterion)) return false
    const check = observations.find(item => item.criterion === criterion && item.verified && item.callId)
    if (!check) return false
    evidence.push(`${criterion}: tool call ${check.callId}`)
    return true
  })
  return { passed, evidence }
}

/** I/O adapter around the pure report parser and completion decision above. */
export class GoalRuntime {
  readonly goal: ChatGoal
  readonly maxToolCalls: number
  readonly deadline = Date.now() + 10 * 60_000
  toolCalls = 0
  private observations = new Map<string, { output: string; id: string; stamp?: string }>()
  private stamp(path: string): string | undefined {
    try { const s = statSync(path); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}` } catch { return undefined }
  }
  private seen = new Set<string>()
  private revision = 0
  private lastRevision = 0
  private stagnant = 0
  private reportRetries = 0
  private idleRounds = 0

  constructor(goal: ChatGoal, private workdir: string | undefined, private persist: (goal: ChatGoal) => void) {
    const maxSteps = Number.isFinite(goal.maxSteps) ? Math.max(1, Math.min(12, Math.floor(goal.maxSteps))) : 8
    this.goal = { ...goal, maxSteps, steps: Number.isFinite(goal.steps) ? Math.max(0, Math.floor(goal.steps)) : 0,
      progress: [...goal.progress], evidence: [], blocker: undefined }
    this.maxToolCalls = maxSteps * 8
  }

  save(): void { this.goal.updatedAt = Date.now(); this.persist({ ...this.goal, progress: [...this.goal.progress], evidence: [...this.goal.evidence] }) }
  stop(status: GoalStatus, reason: string): void { this.goal.status = status; this.goal.blocker = reason; this.save() }
  get active(): boolean { return this.goal.status === 'running' }
  instruction(): string {
    return `[goal-runtime] Objective: ${JSON.stringify(this.goal.objective)}. Criteria: ${JSON.stringify(this.goal.criteria)}. Constraints: ${JSON.stringify(this.goal.constraints)}. ` +
      `At a no-tool-call checkpoint return ONLY JSON {"goal_report":{"status":"continue|completed|blocked","progress":"short concrete summary","blocker":"if blocked"}}. ` +
      `Completion is runtime-verified, not accepted from your words. Supported deterministic criteria: file_contains:<path>::<literal>, file_not_contains:<path>::<literal> (full read_file after last mutation); diagnostics_passed (successful supported get_diagnostics). ` +
      `Other criteria require human verification. Never reinterpret free-form criteria into machine criteria. Tools and approvals remain unchanged. Budget: ${this.goal.steps}/${this.goal.maxSteps} rounds, ${this.toolCalls}/${this.maxToolCalls} tool calls.`
  }
  beginRound(): string | undefined {
    if (Date.now() >= this.deadline) return 'Goal time budget exhausted (10 minutes)'
    if (this.goal.steps >= this.goal.maxSteps) return 'Goal round budget exhausted'
    if (this.toolCalls >= this.maxToolCalls) return 'Goal tool-call budget exhausted'
    if (this.revision === this.lastRevision) this.idleRounds++
    else this.idleRounds = 0
    this.lastRevision = this.revision
    if (this.idleRounds > 3) { this.stop('unverified', 'No new observable tool progress for three rounds'); return this.goal.blocker }
    this.goal.steps++
    this.save()
    return undefined
  }
  reserveTool(): boolean {
    if (!this.active || Date.now() >= this.deadline || this.toolCalls >= this.maxToolCalls) return false
    this.toolCalls++
    return true
  }
  observe(name: string, args: Record<string, unknown>, success: boolean, output: string, id: string, dryRun: boolean): void {
    if (dryRun || !this.active) return
    // Even failed mutations can have partial side effects; invalidate before success gating.
    if (!['read_file', 'read_files', 'search_code', 'find_files', 'get_file_outline', 'get_diagnostics', 'get_fast_context', 'list_directory', 'recall_memory'].includes(name)) {
      this.observations.clear()
    }
    if (!success) return
    const fingerprint = JSON.stringify([name, args, output])
    if (!this.seen.has(fingerprint)) {
      this.seen.add(fingerprint); this.revision++
      this.goal.progress.push(`Observed ${name} (${id})`)
      this.goal.progress = this.goal.progress.slice(-100)
      this.save()
    }
    if (name === 'read_file' && typeof args.path === 'string') {
      // Validate numbered coverage, not just absence of a truncation warning.
      // Header/line numbers are metadata, never evidence of file contents.
      const header = /^\[File: (.+) \| (?:(\d+) lines|Lines (\d+)-(\d+) of (\d+)(?: \| full mode)?)\]\r?\n/.exec(output)
      if (header && !/\$\{\{/.test(output)) {
        const total = Number(header[2] ?? header[5])
        const start = Number(header[3] ?? 1)
        const end = Number(header[4] ?? total)
        const lines = output.slice(header[0].length).split('\n')
        if (start === 1 && end === total && lines.length === total && lines.every((line, i) => line.startsWith(`${i + 1}|`))) {
          const key = this.path(header[1])
          const stamp = this.stamp(key)
          const content = lines.map(line => line.replace(/^\d+\|/, '')).join('\n')
          try {
            // Cached/model-visible reads alone are insufficient: compare the disk.
            const disk = readFileSync(key, 'utf8').replace(/^\uFEFF/, '')
            if (stamp && disk === content.replace(/^\uFEFF/, '')) this.observations.set(key, { output: disk, id, stamp })
          } catch { /* unreadable or stale evidence cannot pass */ }
        }
      }
    }
    if (name === 'get_diagnostics' && /^No errors found\./.test(output) && !args.files && (!args.cwd || this.path(String(args.cwd)) === this.path(this.workdir ?? process.cwd())) && !/DIAGNOSTICS_UNKNOWN|DID NOT run completely|не удалось определить|Found\s+[1-9]\d*\s+errors?|\[.+\] ERROR /i.test(output)) {
      this.observations.set('diagnostics_passed', { output, id })
    }
  }
  private path(path: string): string { return resolve(this.workdir ?? process.cwd(), path).replace(/\\/g, '/').toLowerCase() }
  checkpoint(answer: string): 'continue' | 'stop' {
    const report = parseGoalReport(answer)
    if (!report) {
      if (++this.reportRetries <= 1) return 'continue'
      this.stop('unverified', 'Missing or invalid structured goal_report after verification retry')
      return 'stop'
    }
    this.reportRetries = 0
    if (typeof report.progress === 'string' && report.progress.trim()) this.goal.progress.push(report.progress.slice(0, 1000))
    this.goal.progress = this.goal.progress.slice(-100)
    if (report.status === 'blocked') { this.stop('blocked', typeof report.blocker === 'string' ? report.blocker.slice(0, 1000) : 'Model reported a blocker'); return 'stop' }
    if (report.status === 'completed') {
      const observations: GoalCriterionEvidence[] = this.goal.criteria.map(criterion => {
        if (criterion === 'diagnostics_passed') {
          const check = this.observations.get(criterion)
          return { criterion, callId: check?.id ?? '', verified: !!check }
        }
        const match = /^(file_contains|file_not_contains):(.+?)::([\s\S]+)$/.exec(criterion)
        if (!match) return { criterion, callId: '', verified: false }
        const check = this.observations.get(this.path(match[2]))
        const fresh = !!check?.stamp && this.stamp(this.path(match[2])) === check.stamp
        const contains = check?.output.includes(match[3]) ?? false
        return { criterion, callId: check?.id ?? '', verified: fresh && (match[1] === 'file_contains' ? contains : !contains) }
      })
      const { passed, evidence } = verifyGoalCompletion(this.goal, observations)
      this.goal.evidence = evidence
      this.stop(passed ? 'completed' : 'unverified', passed ? 'All deterministic criteria verified against current-run tool evidence' : 'Completion claim lacks verified evidence for every criterion; human review required')
      return 'stop'
    }
    if (this.revision === this.lastRevision) this.stagnant++
    else this.stagnant = 0
    if (this.stagnant >= 2) { this.stop('unverified', 'No new observable progress at two checkpoints'); return 'stop' }
    this.save()
    return 'continue'
  }
}
