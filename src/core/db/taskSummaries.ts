import { getDB } from './handle'
import { v4 as uuid } from 'uuid'
import { ensureTaskSummaryStateRow } from '../../shared/types/taskSummary'
import type { TaskSummary, TaskSummaryState, TaskSummaryPatch } from '../../shared/types/taskSummary'
import type { ChatGoal } from '../../shared/types/goal'

let initializedFor: ReturnType<typeof getDB> | undefined

function ensureSchema(): void {
  const db = getDB()
  if (initializedFor === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_summary_state (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_goals (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_summaries (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_summaries_chat_updated
      ON task_summaries(chat_id, updated_at DESC);
  `)
  initializedFor = db
}

function readState(chatId: string): TaskSummaryState {
  const db = getDB()
  const row = db.prepare('SELECT state FROM task_summary_state WHERE chat_id = ?').get(chatId) as { state: string } | undefined
  let stored: Partial<TaskSummaryState> = {}
  try { if (row) stored = JSON.parse(row.state) as Partial<TaskSummaryState> } catch { /* recover with defaults */ }
  const rows = db.prepare('SELECT data FROM task_summaries WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 20').all(chatId) as { data: string }[]
  const tasks: TaskSummary[] = []
  for (const item of rows) {
    try { const task = JSON.parse(item.data) as TaskSummary; delete task.participants; tasks.push(task) } catch { /* ignore corrupt row */ }
  }
  return {
    tasks,
    pinned: stored.pinned === true,
    selectedTaskId: tasks.some(task => task.id === stored.selectedTaskId) ? stored.selectedTaskId : undefined,
    manualPins: Array.isArray(stored.manualPins) ? stored.manualPins.slice(0, 50) : [],
    newTaskRequested: stored.newTaskRequested === true,
  }
}


function writeState(chatId: string, state: TaskSummaryState): void {
  getDB().prepare(`INSERT INTO task_summary_state(chat_id, state) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state`).run(chatId, JSON.stringify({
    pinned: state.pinned,
    selectedTaskId: state.selectedTaskId,
    manualPins: state.manualPins.slice(0, 50),
    newTaskRequested: state.newTaskRequested === true,
  }))
}

export function getChatGoal(chatId: string): ChatGoal | null {
  ensureSchema()
  const row = getDB().prepare('SELECT data FROM chat_goals WHERE chat_id = ?').get(chatId) as { data: string } | undefined
  if (!row) return null
  try {
    const goal = JSON.parse(row.data) as ChatGoal
    return goal
  } catch { return null }
}

export function setChatGoal(goal: ChatGoal | null, chatId?: string): ChatGoal | null {
  ensureSchema()
  const id = goal?.chatId ?? chatId
  if (!id) return null
  if (!goal) { getDB().prepare('DELETE FROM chat_goals WHERE chat_id = ?').run(id); return null }
  const maxSteps = Number.isFinite(goal.maxSteps) ? Math.max(1, Math.min(12, Math.floor(goal.maxSteps))) : 8
  const steps = Number.isFinite(goal.steps) ? Math.max(0, Math.min(Math.floor(goal.steps), maxSteps)) : 0
  // A strict revision even for multiple writes in one millisecond: pause/resume
  // must invalidate an old worker snapshot, not accidentally reuse its revision.
  const previousRevision = getChatGoal(id)?.updatedAt ?? 0
  const updatedAt = Math.max(Date.now(), Number.isFinite(previousRevision) ? previousRevision + 1 : 0)
  const safe: ChatGoal = { ...goal, objective: goal.objective.slice(0, 2000), criteria: goal.criteria.slice(0, 20), constraints: goal.constraints.slice(0, 20), progress: goal.progress.slice(-100), evidence: goal.evidence.slice(-50), steps, maxSteps, updatedAt }
  getDB().prepare('INSERT INTO chat_goals(chat_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').run(id, JSON.stringify(safe), safe.updatedAt)
  return safe
}

export function getTaskSummaryState(chatId: string): TaskSummaryState {
  ensureSchema()
  return readState(chatId)
}

export function updateTaskSummaryState(chatId: string, patch: TaskSummaryPatch): TaskSummaryState {
  ensureSchema()
  const db = getDB()
  return db.transaction(() => {
    const state = readState(chatId)
    if (typeof patch.pinned === 'boolean') state.pinned = patch.pinned
    if (patch.selectedTaskId !== undefined) state.selectedTaskId = state.tasks.some(task => task.id === patch.selectedTaskId) ? patch.selectedTaskId : undefined
    if (typeof patch.newTaskRequested === 'boolean') state.newTaskRequested = patch.newTaskRequested
    writeState(chatId, state)
    return readState(chatId)
  })()
}

export function addTaskSummaryPin(chatId: string, text: string, messageId?: string): TaskSummaryState {
  ensureSchema()
  const db = getDB()
  return db.transaction(() => {
    const state = readState(chatId)
    state.manualPins.unshift({ id: uuid(), text: text.slice(0, 500), messageId })
    state.manualPins = state.manualPins.slice(0, 50)
    writeState(chatId, state)
    return readState(chatId)
  })()
}

export function removeTaskSummaryPin(chatId: string, id: string): TaskSummaryState {
  ensureSchema()
  const db = getDB()
  return db.transaction(() => {
    const state = readState(chatId)
    state.manualPins = state.manualPins.filter(pin => pin.id !== id)
    writeState(chatId, state)
    return readState(chatId)
  })()
}

export function upsertTaskSummary(task: TaskSummary): TaskSummaryState {
  ensureSchema()
  const db = getDB()
  return db.transaction(() => {
    db.prepare(`INSERT INTO task_summaries(id, chat_id, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, data = excluded.data, updated_at = excluded.updated_at`)
      .run(task.id, task.chatId, JSON.stringify(task), task.updatedAt)
    db.prepare(`DELETE FROM task_summaries WHERE chat_id = ? AND id NOT IN
      (SELECT id FROM task_summaries WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 20)`).run(task.chatId, task.chatId)
    // Critical invariant: task state exists even when this is the first operation for a chat.
    ensureTaskSummaryStateRow(db, task.chatId)
    const state = readState(task.chatId)
    writeState(task.chatId, state)
    return readState(task.chatId)
  })()
}

export function createTaskSummary(chatId: string, title: string, messageId: string): TaskSummary {
  const now = Date.now()
  return { id: uuid(), chatId, title: title.slice(0, 120), status: 'running', createdAt: now, updatedAt: now, messageIds: [messageId], todo: [], results: [], changes: [], checks: [] }
}

export function recoverInterruptedTaskSummaries(): void {
  ensureSchema()
  const db = getDB()
  db.transaction(() => {
    const goals = db.prepare('SELECT chat_id, data FROM chat_goals').all() as { chat_id: string; data: string }[]
    for (const row of goals) {
      try {
        const goal = JSON.parse(row.data) as ChatGoal
        if (goal.status !== 'running') continue
        goal.status = 'paused'
        goal.blocker = 'Прервано перезапуском; проверь состояние и явно возобнови через /goal'
        setChatGoal(goal)
      } catch { /* ignore corrupt goal rows */ }
    }
    const rows = db.prepare('SELECT id, chat_id, data FROM task_summaries').all() as { id: string; chat_id: string; data: string }[]
    for (const row of rows) {
      try {
        const task = JSON.parse(row.data) as TaskSummary
        if (task.status !== 'running') continue
        task.status = 'interrupted'
        task.updatedAt = Date.now()
        db.prepare('UPDATE task_summaries SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(task), task.updatedAt, row.id)
        const state = readState(row.chat_id)
        writeState(row.chat_id, state)
      } catch { /* ignore corrupt task rows */ }
    }
  })()
}
