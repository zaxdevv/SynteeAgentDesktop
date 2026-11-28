import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chatSource = fs.readFileSync(path.join(root, 'src/main/ipc/chat.ipc.ts'), 'utf8')
// С распила chat.ipc.ts на модули (801a59d) getLiveMessages живёт в
// chatCompaction.ts, а send-путь — в chatSendEngine.ts. Раньше тест искал
// их в chat.ipc.ts и падал.
const compactionSource = fs.readFileSync(path.join(root, 'src/main/ipc/chatCompaction.ts'), 'utf8')
const sendEngineSource = fs.readFileSync(path.join(root, 'src/main/ipc/chatSendEngine.ts'), 'utf8')
const dbSource = fs.readFileSync(path.join(root, 'src/core/db/messages.ts'), 'utf8')

function ephemeralFilter() {
  const start = compactionSource.indexOf('export function getLiveMessages(')
  const end = compactionSource.indexOf('\n}', start) + 2
  assert.ok(start >= 0 && end > start)
  const fn = compactionSource.slice(start, end).replace(/: Message\[\]/g, '')
  return vm.runInNewContext(`(${fn.replace(/^export function getLiveMessages/, 'function')})`)
}

test('ephemeral history preserves passed messages and filters compact boundary', () => {
  const filter = ephemeralFilter()
  const msgs = [
    { id: 'before', role: 'user', createdAt: 1 },
    { id: 'divider', role: 'system', createdAt: 2, slashCommand: { name: 'compact' } },
    { id: 'tail', role: 'assistant', createdAt: 3 },
    { id: 'current', role: 'user', createdAt: 4 },
  ]
  assert.deepEqual(Array.from(filter(msgs), m => m.id), ['tail', 'current'])
})

test('persistent scoped SQL excludes just-saved current user and retains system rows with null name', () => {
  assert.match(dbSource, /COALESCE\(NOT \(role = 'system'.*\), 1\)/s)
  const db = new Database(':memory:')
  db.exec('CREATE TABLE messages (id TEXT, chat_id TEXT, role TEXT, content TEXT, created_at INTEGER, is_pinned INTEGER, model TEXT, tool_steps TEXT, thinking TEXT, thinking_ms INTEGER, slash_command TEXT, iterations TEXT, plan_data TEXT, todo TEXT, compact_summary TEXT, compact_stats TEXT, attachments TEXT, attachment_result TEXT, duration_ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, tool_calls_count INTEGER, thinking_blocks TEXT, finish_reason TEXT, streaming_ms INTEGER, hidden_from_context INTEGER, reply_to TEXT)')
  const insert = db.prepare('INSERT INTO messages (id,chat_id,role,content,created_at,slash_command) VALUES (?,?,?,?,?,?)')
  insert.run('system-no-name', 'c', 'system', 'keep', 1, '{"other":"x"}')
  insert.run('current', 'c', 'user', 'now', 2, null)
  insert.run('divider', 'c', 'system', 'compact', 3, '{"name":"compact"}')
  insert.run('tail', 'c', 'assistant', 'tail', 4, null)
  const divider = db.prepare("SELECT MAX(created_at) AS createdAt FROM messages WHERE chat_id = ? AND role = 'system' AND slash_command IS NOT NULL AND CASE WHEN json_valid(slash_command) THEN json_extract(slash_command, '$.name') END = 'compact'").get('c')
  const rows = db.prepare(`SELECT id FROM messages WHERE chat_id=? AND COALESCE(hidden_from_context,0)=0 AND created_at>? AND id<>? AND COALESCE(NOT (role='system' AND slash_command IS NOT NULL AND CASE WHEN json_valid(slash_command) THEN json_extract(slash_command,'$.name') END='compact'),1) ORDER BY created_at`).all('c', divider.createdAt, 'current')
  assert.deepEqual(rows.map(r => r.id), ['tail'])
  const withoutDivider = db.prepare(`SELECT id FROM messages WHERE chat_id=? AND id<>? AND COALESCE(NOT (role='system' AND slash_command IS NOT NULL AND CASE WHEN json_valid(slash_command) THEN json_extract(slash_command,'$.name') END='compact'),1) ORDER BY created_at`).all('c', 'current')
  assert.ok(withoutDivider.some(r => r.id === 'system-no-name'))
  db.close()
})

test('send path uses ephemeral supplied history and persistent exclusion; send prompt is snapshotted once', () => {
  assert.match(sendEngineSource, /params\.incognito\s*\?\s*getLiveMessages\(history\)\s*:\s*filterContextHistory\(params\.chatId,\s*getMessagesAfterLatestCompactCached\(params\.chatId, userMsg\.id\),\s*userMsg\.id\)/)
  assert.equal((sendEngineSource.match(/const sendSystemPrompt = [^\n]+[\s\S]{0,120}await getSystemPrompt\(/g) ?? []).length, 1)
  assert.match(sendEngineSource, /systemPrompt = sideSystemPrompt \?\? sendSystemPrompt/)
})

test('automatic memory is delegated to the scoped Watcher and explicit recall preserves its opt-in', () => {
  assert.match(sendEngineSource, /attachAssistants\(params\.chatId, worker, \{\s*projectWorkdir: chatWorkdir, projectId: chatProjectId, incognito: !!params\.incognito, memoryAllowed/)
  assert.doesNotMatch(sendEngineSource, /searchAutoRecallCached|Relevant past context/)
  assert.match(sendEngineSource, /crossProject: msg\.crossProject as boolean/)
})
