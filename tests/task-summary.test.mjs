import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import * as summaryHelpers from '../src/shared/types/taskSummary.ts'

const require = createRequire(import.meta.url)
import { ensureTaskSummaryStateRow, isExplicitTaskContinuation, classifyDiagnosticOutcome, isVerificationCommand } from '../src/shared/types/taskSummary.ts'

test('persisted task API survives updates, retains pins and recovers interrupted work', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO chats VALUES (\'chat-1\')')
  const source = readFileSync(new URL('../src/core/db/taskSummaries.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => {
    if (name === './handle') return { getDB: () => db }
    if (name.endsWith('/taskSummary')) return summaryHelpers
    return require(name)
  }, module, module.exports)
  const api = module.exports
  const task = api.createTaskSummary('chat-1', 'Test task', 'message-1')
  assert.equal(api.upsertTaskSummary(task).tasks[0].id, task.id)
  api.updateTaskSummaryState('chat-1', { pinned: true, selectedTaskId: task.id })
  api.addTaskSummaryPin('chat-1', 'Keep this decision')
  task.todo = [{ text: 'Verify', status: 'pending' }]
  api.upsertTaskSummary(task)
  assert.equal(api.getTaskSummaryState('chat-1').pinned, true)
  assert.equal(api.getTaskSummaryState('chat-1').manualPins.length, 1)
  api.recoverInterruptedTaskSummaries()
  assert.equal(api.getTaskSummaryState('chat-1').tasks[0].status, 'interrupted')
  db.prepare('DELETE FROM chats WHERE id=?').run('chat-1')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_summaries').get().n, 0)
  db.close()
})

test('first task insertion creates readable default state row', () => {
  const db = new Database(':memory:')
  db.exec("CREATE TABLE task_summary_state(chat_id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE task_summaries(id TEXT PRIMARY KEY, chat_id TEXT, data TEXT, updated_at INTEGER);")
  db.prepare('INSERT INTO task_summaries VALUES (?, ?, ?, ?)').run('task-1', 'chat-1', '{}', 1)
  ensureTaskSummaryStateRow(db, 'chat-1')
  assert.deepEqual(JSON.parse(db.prepare('SELECT state FROM task_summary_state WHERE chat_id=?').get('chat-1').state), { pinned: false, manualPins: [], newTaskRequested: false })
  db.close()
})

test('continuation detection requires explicit continuation language', () => {
  assert.equal(isExplicitTaskContinuation('Продолжай'), true)
  assert.equal(isExplicitTaskContinuation('Продолжай исправлять'), true)
  assert.equal(isExplicitTaskContinuation('continue fixing this'), true)
  assert.equal(isExplicitTaskContinuation('Вот ошибка после твоего исправления'), true)
  assert.equal(isExplicitTaskContinuation('да'), false)
  assert.equal(isExplicitTaskContinuation('Сделай новую страницу'), false)
})

test('only direct verification commands are classified as checks', () => {
  assert.equal(isVerificationCommand('npm run build'), true)
  assert.equal(isVerificationCommand('npx tsc --noEmit'), true)
  assert.equal(isVerificationCommand('echo npm test'), false)
  assert.equal(isVerificationCommand('Get-Content test.ts'), false)
  assert.equal(isVerificationCommand('npx tsc | Select-String error'), false)
})

test('participants contract has normalized statuses and distinct delegated request identity', () => {
  const contract = readFileSync(new URL('../src/shared/types/taskSummary.ts', import.meta.url), 'utf8')
  assert.match(contract, /TaskSummaryParticipantStatus = 'starting' \| 'queued' \| 'running' \| 'done' \| 'error' \| 'cancelled' \| 'interrupted'/)
  assert.match(contract, /kind: 'subagent' \| 'chat'/)
  assert.match(contract, /requestId\?: string/)
})

test('delegated request persistence maps task source/read explicitly and avoids list/status coupling', () => {
  const source = readFileSync(new URL('../src/core/db/delegatedChats.ts', import.meta.url), 'utf8')
  assert.match(source, /source_message_id as sourceMessageId/)
  assert.match(source, /read_at as readAt/)
  assert.match(source, /WHERE source_chat_id = \? ORDER BY created_at/)
  const service = readFileSync(new URL('../src/main/services/delegatedChats.ts', import.meta.url), 'utf8')
  assert.ok(service.includes('markDelegatedRequestRead(chatId, state.request_id)'))
  assert.ok(service.includes("state.status === 'done'"))
  assert.match(service, /sourceMessageId: context\.sourceMessageId/)
})

test('participant hydration is identity-based, bounded, and uses authoritative status', () => {
  const ipc = readFileSync(new URL('../src/main/ipc/chat.ipc.ts', import.meta.url), 'utf8')
  assert.match(ipc, /messageIds\.has\(agent\.parentId\)/)
  assert.match(ipc, /messageIds\.has\(sourceMessageId\)/)
  assert.match(ipc, /requestState\(request\.chatId, request\.requestId\)/)
  assert.match(ipc, /slice\(0, 6000\)/)
  assert.match(ipc, /participants\.slice\(-50\)/)
  assert.ok(ipc.includes('broadcastTaskSummary = emitTaskSummary'))
  assert.ok(!ipc.includes("if (!task || task.status === 'running') return"))
})

test('incognito task summary and delegated persistence are guarded', () => {
  const service = readFileSync(new URL('../src/main/services/delegatedChats.ts', import.meta.url), 'utf8')
  const ipc = readFileSync(new URL('../src/main/ipc/chat.ipc.ts', import.meta.url), 'utf8')
  assert.match(service, /context\.incognito \|\| !source \|\| source\.isIncognito/)
  assert.match(ipc, /if \(!params\.incognito && !params\.sideChatParentId\)/)
  assert.match(ipc, /child\.isIncognito/)
})

test('diagnostic status never passes unsupported, incomplete or failed checks', () => {
  assert.equal(classifyDiagnosticOutcome({ supported: false, completed: false }), 'unknown')
  assert.equal(classifyDiagnosticOutcome({ supported: true, completed: false }), 'unknown')
  assert.equal(classifyDiagnosticOutcome({ supported: true, completed: true, executionFailed: true }), 'unknown')
  assert.equal(classifyDiagnosticOutcome({ supported: true, completed: true, findingsFailed: true }), 'failed')
  assert.equal(classifyDiagnosticOutcome({ supported: true, completed: true }), 'passed')
})
