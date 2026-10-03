// Run with Electron's Node ABI (better-sqlite3 is built for Electron):
// $env:ELECTRON_RUN_AS_NODE='1'; & node_modules/electron/dist/electron.exe scripts/delegated-chats.test.cjs
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve, dirname } = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const Database = require('better-sqlite3')

const mocks = new Map()
const cache = new Map()
function load(path) {
  path = resolve(path)
  if (mocks.has(path)) return mocks.get(path)
  if (cache.has(path)) return cache.get(path).exports
  const module = { exports: {} }
  cache.set(path, module)
  const source = readFileSync(path, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  new Function('require', 'module', 'exports', output)(id => {
    if (!id.startsWith('.')) return require(id)
    const absolute = resolve(dirname(path), id)
    if (mocks.has(absolute)) return mocks.get(absolute)
    return load(`${absolute}.ts`)
  }, module, module.exports)
  return module.exports
}
const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
mocks.set(resolve('src/core/db/handle'), { getDB: () => db })
// Use actual production schema and DB CRUD, not a simulated persistence layer.
load('src/core/db/migrations/index.ts').runMigrations(db)
const chatDB = load('src/core/db/chats.ts')
const messageDB = load('src/core/db/messages.ts')
const bufferDB = load('src/core/db/streamingBuffers.ts')
mocks.set(resolve('src/core/db'), { ...chatDB, ...messageDB, ...bufferDB, getDB: () => db })
const requestDB = load('src/core/db/delegatedChats.ts')
const runtime = { activeRuns: new Map(), activeRunMeta: new Map(), chatQueues: new Map(), runStatusListeners: new Set() }
mocks.set(resolve('src/main/ipc/chatShared'), runtime)
const service = load('src/main/services/delegatedChats.ts')
service.initializeDelegatedChats()
const emit = (chatId, status, requestId, error) => {
  for (const listener of runtime.runStatusListeners) listener(chatId, status, requestId, error)
}
function fixture(options = {}) {
  const source = chatDB.createChat()
  const context = { chatId: source.id, modelId: 'test-model', providerId: 'test-provider',
    reasoningValue: 'high', planningMode: false, askMode: false,
    allowedTools: ['manage_chats', 'read_file', 'write_file'], incognito: false, ...options }
  const sends = []
  const backend = {
    send: async params => {
      sends.push(params)
      const busy = runtime.activeRunMeta.has(params.chatId)
      if (busy) {
        const queue = runtime.chatQueues.get(params.chatId) ?? []
        queue.push({ meta: { msgId: params.assistantMsgId } })
        runtime.chatQueues.set(params.chatId, queue)
        emit(params.chatId, 'queued', params.assistantMsgId)
      } else {
        runtime.activeRunMeta.set(params.chatId, { msgId: params.assistantMsgId })
        emit(params.chatId, 'running', params.assistantMsgId)
      }
      return { assistantMsgId: params.assistantMsgId, queued: busy }
    },
    stop: (chatId, requestId) => {
      const queue = runtime.chatQueues.get(chatId) ?? []
      const index = queue.findIndex(q => q.meta.msgId === requestId)
      if (index >= 0) { queue.splice(index, 1); return true }
      if (runtime.activeRunMeta.get(chatId)?.msgId !== requestId) return false
      runtime.activeRunMeta.delete(chatId)
      runtime.activeRuns.delete(chatId)
      return true
    },
    changed: () => {},
  }
  const execute = params => service.executeManageChats(params, context, backend)
  const call = async params => {
    const result = await execute(params)
    assert.equal(result.success, true, result.error)
    return JSON.parse(result.output)
  }
  const finish = (chatId, requestId, text = 'RESULT', finishReason = 'done') => {
    messageDB.saveMessage({ id: requestId, chatId, role: 'assistant', content: text,
      createdAt: Date.now(), isPinned: 0, finishReason })
    runtime.activeRunMeta.delete(chatId)
    runtime.activeRuns.delete(chatId)
    emit(chatId, 'done', requestId)
  }
  return { source, context, sends, backend, call, execute, finish }
}

test('create returns before completion; inherits effective model, reasoning, project/workdir; no parent-history copy', async () => {
  const f = fixture()
  db.prepare('UPDATE chats SET workdir = ?, project_context = ? WHERE id = ?').run('C:/legacy', 'context', f.source.id)
  const created = await f.call({ action: 'create', title: 'Research', message: 'Inspect code' })
  assert.equal(created.status, 'running')
  assert.ok(created.request_id)
  assert.equal(chatDB.getChatModel(created.chat_id).modelId, 'test-model')
  assert.equal(chatDB.getChatModel(created.chat_id).modelProvider, 'test-provider')
  assert.equal(chatDB.getChatReasoning(created.chat_id), 'high')
  assert.equal(chatDB.getChatWorkdirContext(created.chat_id).workdir, 'C:/legacy')
  assert.equal(messageDB.getMessages(created.chat_id).length, 0)
  assert.equal(f.sends[0].content, 'Inspect code')
  assert.ok(requestDB.getDelegatedRequest(created.chat_id, created.request_id))
  f.finish(created.chat_id, created.request_id)
})

test('project and Ask/Plan restrictions inherited; sending cannot escalate allowed tools', async () => {
  const f = fixture({ askMode: true, planningMode: true, allowedTools: ['manage_chats', 'read_file'] })
  db.prepare(`INSERT INTO projects (id, name, workdir, created_at, last_used) VALUES ('project-test','Project','C:/project',?,?)`).run(Date.now(), Date.now())
  db.prepare('UPDATE chats SET project_id = ? WHERE id = ?').run('project-test', f.source.id)
  const created = await f.call({ action: 'create', message: 'Read only' })
  assert.equal(requestDB.getDelegationChat(created.chat_id).projectId, 'project-test')
  assert.equal(chatDB.getChatWorkdirContext(created.chat_id).workdir, 'C:/project')
  assert.equal(chatDB.getChatModes(created.chat_id).askMode, true)
  assert.equal(f.sends[0].planningMode, true)
  assert.deepEqual(f.sends[0].oneShotAllowedTools, ['manage_chats', 'read_file'])
  f.finish(created.chat_id, created.request_id)
})

test('follow-up queues immediately; explicit request ID reads old result, not live follow-up', async () => {
  const f = fixture()
  const first = await f.call({ action: 'create', message: 'First' })
  const second = await f.call({ action: 'send', chat_id: first.chat_id, message: 'Second' })
  assert.equal(second.status, 'queued')
  assert.notEqual(first.request_id, second.request_id)
  f.finish(first.chat_id, first.request_id, 'First answer')
  runtime.chatQueues.delete(first.chat_id)
  runtime.activeRunMeta.set(first.chat_id, { msgId: second.request_id })
  runtime.activeRuns.set(first.chat_id, { msgId: second.request_id, bufferedText: 'Second partial', bufferedAgentStatus: 'working' })
  emit(first.chat_id, 'running', second.request_id)
  const readFirst = await f.call({ action: 'read', chat_id: first.chat_id, request_id: first.request_id })
  assert.equal(readFirst.content, 'First answer')
  assert.equal(readFirst.partial, false)
  const readLatest = await f.call({ action: 'read', chat_id: first.chat_id })
  assert.equal(readLatest.content, 'Second partial')
  assert.equal(readLatest.partial, true)
  f.finish(first.chat_id, second.request_id)
})

test('stop queued request leaves currently running request alone', async () => {
  const f = fixture()
  const first = await f.call({ action: 'create', message: 'First' })
  const second = await f.call({ action: 'send', chat_id: first.chat_id, message: 'Second' })
  const stopped = await f.call({ action: 'stop', chat_id: first.chat_id, request_id: second.request_id })
  assert.equal(stopped.status, 'cancelled')
  assert.equal(runtime.activeRunMeta.get(first.chat_id).msgId, first.request_id)
  const status = await f.call({ action: 'status', chat_id: first.chat_id, request_id: first.request_id })
  assert.equal(status.status, 'running')
  f.finish(first.chat_id, first.request_id)
})

test('read supports result pagination/history and rejects foreign chats/request IDs', async () => {
  const f = fixture()
  const other = fixture()
  const first = await f.call({ action: 'create', message: 'Task' })
  const foreign = await other.call({ action: 'create', title: 'Other chat' })
  f.finish(first.chat_id, first.request_id, 'X'.repeat(300))
  const read = await f.call({ action: 'read', chat_id: first.chat_id, max_chars: 100 })
  assert.equal(read.content.length, 100)
  assert.equal(read.next_offset, 100)
  const tail = await f.call({ action: 'read', chat_id: first.chat_id, max_chars: 100, offset: 200 })
  assert.equal(tail.next_offset, null)
  assert.equal((await f.call({ action: 'read', chat_id: first.chat_id, view: 'history' })).content.includes('[assistant]'), true)
  assert.equal((await f.execute({ action: 'read', chat_id: foreign.chat_id })).success, false)
  assert.equal((await f.execute({ action: 'read', chat_id: first.chat_id, request_id: 'invalid' })).success, false)
})

test('list is scoped to parent; create-only does not start a model; invalid inputs have no side effects', async () => {
  const f = fixture()
  const chat = await f.call({ action: 'create', title: 'Empty' })
  assert.equal(f.sends.length, 0)
  assert.equal(chat.status, 'idle')
  assert.equal((await f.call({ action: 'list' })).chats[0].chat_id, chat.chat_id)
  assert.equal((await f.execute({ action: 'create', message: '' })).success, false)
  assert.equal((await f.execute({ action: 'send', chat_id: chat.chat_id })).success, false)
  assert.equal(f.sends.length, 0)
})

test('read-only/incognito/schema restrictions, depth and pending-request limits', async () => {
  assert.equal((await fixture({ incognito: true }).execute({ action: 'create' })).success, false)
  assert.equal((await fixture({ allowedTools: ['read_file'] }).execute({ action: 'create' })).success, false)
  const f = fixture()
  const child = await f.call({ action: 'create' })
  const grandchildResult = await service.executeManageChats({ action: 'create' }, { ...f.context, chatId: child.chat_id }, f.backend)
  assert.equal(grandchildResult.success, true)
  const grandchild = JSON.parse(grandchildResult.output)
  const nested = await service.executeManageChats({ action: 'create' }, { ...f.context, chatId: grandchild.chat_id }, f.backend)
  assert.equal(nested.success, false)
  const pending = []
  for (let i = 0; i < 8; i++) pending.push(await f.call({ action: 'create', message: `Task ${i}` }))
  assert.equal((await f.execute({ action: 'create', message: 'Excess' })).success, false)
  for (const p of pending) f.finish(p.chat_id, p.request_id)
})

test('errors/stopped status and restart checkpoints are preserved; FK deletion does not delete child chat', async () => {
  const f = fixture()
  const stopped = await f.call({ action: 'create', message: 'Stop this' })
  f.finish(stopped.chat_id, stopped.request_id, 'Partial', 'stopped')
  assert.equal((await f.call({ action: 'status', chat_id: stopped.chat_id })).status, 'cancelled')
  const crashed = await f.call({ action: 'create', message: 'Crash' })
  bufferDB.saveStreamingBuffer(crashed.request_id, crashed.chat_id, JSON.stringify({ content: 'Checkpoint text' }))
  runtime.activeRunMeta.delete(crashed.chat_id)
  requestDB.recoverDelegatedRequests()
  const read = await f.call({ action: 'read', chat_id: crashed.chat_id })
  assert.equal(read.status, 'interrupted')
  assert.equal(read.content, 'Checkpoint text')
  assert.equal(read.partial, true)
  db.prepare('DELETE FROM chats WHERE id = ?').run(f.source.id)
  assert.ok(requestDB.getDelegationChat(crashed.chat_id))
  assert.equal(requestDB.getDelegationParent(crashed.chat_id), undefined)
})

test('failed startup returns error and retains failed request instead of waiting', async () => {
  const f = fixture()
  f.backend.send = async () => { throw new Error('Startup failed') }
  const reply = await f.execute({ action: 'create', message: 'Task' })
  assert.equal(reply.success, false)
  const list = await f.call({ action: 'list' })
  assert.equal(list.chats[0].status, 'error')
  assert.equal(list.chats[0].error, 'Startup failed')
})

test('production integration passes reserved IDs, main context and excludes double truncation', () => {
  const ipc = readFileSync('src/main/ipc/chat.ipc.ts', 'utf8')
  const worker = readFileSync('src/main/workers/ai-worker.ts', 'utf8')
  const agent = readFileSync('src/core/agent/Agent.ts', 'utf8')
  assert.match(ipc, /const assistantMsgId = params.assistantMsgId \?\? uuid\(\)/)
  assert.match(ipc, /chatSendHandler\(\{ \.\.\.params, assistantMsgId: undefined \}\)/)
  assert.match(ipc, /case 'manage_chats'/)
  assert.match(ipc, /modelId: mainAssignment\?\.modelId/)
  assert.match(worker, /onManageChats:/)
  assert.match(agent, /fn.name === 'manage_chats'/)
  assert.match(ipc, /params.incognito \? \[\] : getMessagesCached\(params.chatId\), assistantMsgId\)/)
})

test('one multifunction schema is exposed in normal, Ask, Plan and persona toolsets', () => {
  const { getToolSchemas } = load('src/core/tools/schemas/index.ts')
  for (const options of [{}, { askMode: true }, { planningMode: true }, { persona: 'reviewer' }, { persona: 'architect' }]) {
    const tools = getToolSchemas(options)
    const chats = tools.filter(t => t.function.name === 'manage_chats')
    assert.equal(chats.length, 1)
    assert.deepEqual(chats[0].function.parameters.properties.action.enum, ['create', 'send', 'status', 'read', 'list', 'stop'])
  }
})

test('production request-stop bridge handles queued, running and preparation requests independently', () => {
  const source = readFileSync('src/main/ipc/chat.ipc.ts', 'utf8')
  const start = source.indexOf('  chatStopImpl = (chatId, requestId) => {')
  const end = source.indexOf("  ipcMain.handle('chat:stop'", start)
  const snippet = ts.transpileModule(source.slice(start, end), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const activeRuns = new Map()
  const activeRunMeta = new Map()
  const chatQueues = new Map()
  const cancelledDelegatedStarts = new Set()
  const stopped = []
  const events = []
  const stop = new Function('activeRuns', 'activeRunMeta', 'chatQueues', 'cancelledDelegatedStarts',
    'mainWindow', 'stopRun', 'emitRunStatus', 'emitQueueUpdate', `let chatStopImpl; ${snippet}; return chatStopImpl`)(
    activeRuns, activeRunMeta, chatQueues, cancelledDelegatedStarts, { getWindow: () => null },
    run => stopped.push(run.msgId), (...args) => events.push(args), () => {})
  activeRuns.set('chat', { msgId: 'running' })
  chatQueues.set('chat', [{ meta: { msgId: 'queued' } }])
  assert.equal(stop('chat', 'queued'), true)
  assert.equal(stopped.length, 0)
  assert.equal(events.length, 0)
  assert.equal(activeRuns.get('chat').msgId, 'running')
  assert.equal(stop('chat', 'running'), true)
  assert.deepEqual(stopped, ['running'])
  activeRuns.delete('chat')
  activeRunMeta.set('chat', { msgId: 'preparing' })
  assert.equal(stop('chat', 'preparing'), true)
  assert.ok(cancelledDelegatedStarts.has('preparing'))
  assert.equal(activeRunMeta.get('chat').msgId, 'preparing')
  assert.equal(stop('chat', 'unrelated'), false)
})
