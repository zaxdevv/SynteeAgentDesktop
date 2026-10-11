export type TaskSummaryStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'
export type TaskSummaryTodoStatus = 'pending' | 'in_progress' | 'done' | 'skipped'
export interface TaskSummaryResult { id: string; title: string; kind: 'file' | 'url' | 'image'; target: string; messageId: string }
export interface TaskSummaryChange { path: string; diff?: string; messageId: string }
export interface TaskSummaryCheck { id: string; title: string; status: 'passed' | 'failed' | 'unknown'; detail: string; messageId: string }
export type TaskSummaryParticipantStatus = 'starting' | 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'idle'
export interface TaskSummaryParticipant {
  id: string; kind: 'subagent' | 'chat'; title: string; task: string; status: TaskSummaryParticipantStatus
  createdAt: number; finishedAt?: number; model?: string; role?: string; stepsCount?: number; toolCallsCount?: number
  summary?: string; error?: string; chatId?: string; requestId?: string; agentId?: string; sourceMessageId: string; readAt?: number
}
export interface TaskSummary { 
  id: string; chatId: string; title: string; status: TaskSummaryStatus; createdAt: number; updatedAt: number
  messageIds: string[]; todo: Array<{ text: string; status: TaskSummaryTodoStatus }>
  participants?: TaskSummaryParticipant[]
  results: TaskSummaryResult[]; changes: TaskSummaryChange[]; checks: TaskSummaryCheck[]; summary?: string; remaining?: string
}
export interface TaskSummaryState {
  tasks: TaskSummary[]; selectedTaskId?: string; pinned: boolean
  manualPins: Array<{ id: string; text: string; messageId?: string }>; newTaskRequested?: boolean
}
export interface TaskSummaryPatch { pinned?: boolean; selectedTaskId?: string; newTaskRequested?: boolean }

/** Inserts the default row idempotently; used by persistence and state-row regression tests. */
export function ensureTaskSummaryStateRow(db: { prepare(sql: string): { run(...params: unknown[]): unknown } }, chatId: string): void {
  db.prepare(`INSERT INTO task_summary_state(chat_id, state) VALUES (?, ?)
    ON CONFLICT(chat_id) DO NOTHING`).run(chatId, JSON.stringify({ pinned: false, manualPins: [], newTaskRequested: false }))
}

/** Continuation is deliberately opt-in by explicit linguistic cues, never message length. */
export function isExplicitTaskContinuation(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase().replace(/[.!?]+$/g, '').trim()
  if (!normalized || normalized.length > 1000) return false
  return /^(?:(?:продолжай(?:те)?|давай дальше|продолжи(?:м)?|continue|go on|carry on|keep going)(?=$|[\s:,.])|вот (?:ошибка|ошибки|результат|вывод)(?: после| с| теперь|:)|here(?:'s| is) (?:the )?(?:error|result|output)(?: after| from|:)|после твоего (?:изменения|исправления)|after your (?:change|fix))/iu.test(normalized)
}

/** Only direct verification commands; shell pipelines can hide the check's exit code. */
export function isVerificationCommand(command: string): boolean {
  if (/[|;&\r\n]/.test(command)) return false
  return /^(?:(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?(?:test(?::[\w-]+)?|build(?::[\w-]+)?|lint(?::[\w-]+)?|typecheck(?::[\w-]+)?)\b|(?:npx\s+)?(?:tsc|eslint|vitest|jest|pytest)(?:\.cmd)?\b|(?:python(?:3)?\s+-m\s+(?:pytest|unittest)|cargo\s+(?:test|check|build)|go\s+(?:test|build|vet)|dotnet\s+(?:test|build))\b)/i.test(command.trim())
}

/** A diagnostic pass is only genuine for a completed, supported run with no failures. */
export function classifyDiagnosticOutcome(input: {
  supported: boolean
  completed: boolean
  executionFailed?: boolean
  findingsFailed?: boolean
}): 'passed' | 'failed' | 'unknown' {
  if (!input.supported || !input.completed || input.executionFailed) return 'unknown'
  return input.findingsFailed ? 'failed' : 'passed'
}
