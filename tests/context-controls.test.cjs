const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
function load(file, deps) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require: name => {
    if (!(name in deps)) throw new Error('Unexpected dependency: ' + name)
    return deps[name]
  } })
  return module.exports
}
const types = load('src/shared/types/contextControls.ts', {})
function fixture() {
  let prefs
  const rows = [
    { id: 'old-pin', chatId: 'c', role: 'user', content: 'pin', createdAt: 1, isPinned: 1 },
    { id: 'hidden-pin', chatId: 'c', role: 'assistant', content: 'secret', createdAt: 2, isPinned: 1, hiddenFromContext: 1 },
    { id: 'divider', chatId: 'c', role: 'system', content: 'compact', createdAt: 3, isPinned: 1, slashCommand: { name: 'compact' } },
    { id: 'tail', chatId: 'c', role: 'assistant', content: 'answer', createdAt: 4, toolSteps: [{ type: 'tool_call' }, { type: 'tool_result', content: 'result' }], iterations: [{}] },
    { id: 'now', chatId: 'c', role: 'user', content: 'current', createdAt: 5 },
  ]
  const db = { exec() {}, prepare(sql) { return {
    get(...args) {
      if (sql.includes('FROM chat_context_preferences')) return prefs ? { preferences: prefs } : undefined
      if (sql.includes('FROM chats')) return args[0] === 'c' ? { id: 'c' } : undefined
      return rows.find(r => r.id === args[0] && r.chatId === args[1])
    },
    all() { return rows.filter(r => r.isPinned).map(r => ({ id: r.id })) },
    run(id, data) { prefs = data },
  } } }
  const api = load('src/core/db/contextControls.ts', {
    './handle': { getDB: () => db },
    './messages': { getMessageById: id => rows.find(r => r.id === id), pinMessage: id => { rows.find(r => r.id === id).isPinned = 1 }, unpinMessage: id => { rows.find(r => r.id === id).isPinned = 0 }, setMessageHidden: (id, flag) => { rows.find(r => r.id === id).hiddenFromContext = Number(flag); return true } },
    '../../shared/types/contextControls': types,
  })
  return { api, rows }
}
test('defaults and persisted partial source preferences', () => {
  const { api } = fixture()
  assert.equal(api.getContextPreferences('c').sources.memory, true)
  api.setContextPreferences('c', { sources: { memory: false } })
  api.setContextPreferences('c', { excludedFiles: ['AGENTS.md', 'AGENTS.md', 42] })
  assert.equal(api.getContextPreferences('c').sources.memory, false)
  assert.equal(api.getContextPreferences('c').sources.tools, true)
  assert.equal(JSON.stringify(api.getContextPreferences('c').excludedFiles), '["AGENTS.md"]')
})
test('pins survive compact, hidden wins, current user excluded, no duplicates', () => {
  const { api, rows } = fixture()
  assert.equal(JSON.stringify(api.filterContextHistory('c', [rows[3], rows[4]], 'now').map(r => r.id)), '["old-pin","tail"]')
  api.setContextPreferences('c', { sources: { history: false } })
  assert.equal(JSON.stringify(api.filterContextHistory('c', rows.slice(3)).map(r => r.id)), '["old-pin"]')
})
test('tool traces removed as complete messages without mutating cached rows', () => {
  const { api, rows } = fixture()
  api.setContextPreferences('c', { sources: { tools: false } })
  const tail = api.filterContextHistory('c', [rows[3]]).find(r => r.id === 'tail')
  assert.equal(tail.content, 'answer')
  assert.equal(tail.toolSteps, undefined)
  assert.equal(tail.iterations, undefined)
  assert.equal(rows[3].toolSteps.length, 2)
})
test('message changes scoped to chat, flags validated, hidden/pin independently retained', () => {
  const { api, rows } = fixture()
  assert.throws(() => api.setContextMessageHidden('other', 'tail', true))
  assert.throws(() => api.setContextMessagePinned('c', 'missing', true))
  assert.throws(() => api.setContextMessageHidden('c', 'tail', 'false'))
  api.setContextMessagePinned('c', 'tail', true)
  api.setContextMessageHidden('c', 'tail', true)
  assert.equal(api.filterContextHistory('c', [rows[3]]).some(r => r.id === 'tail'), false)
  api.setContextMessageHidden('c', 'tail', false)
  assert.equal(api.filterContextHistory('c', []).some(r => r.id === 'tail'), true)
})
test('prompt inputs and auto-recall are gated; calculator shares history filter', () => {
  const chat = fs.readFileSync(path.join(root, 'src/main/ipc/chat.ipc.ts'), 'utf8')
  for (const expected of ['customSystemPrompt: sources.instructions ?', 'projectContext: sources.projectFiles ?', 'memoryContext: sources.memory ?', 'workingMemory: sources.memory ?', 'projectInstructions: includedFiles', 'contextPrefs.excludedFiles.includes(file.source)', 'getContextPreferences(dbChatId).sources.memory &&', 'filterContextHistory(chatId, getMessagesAfterLatestCompactCached(chatId))']) assert.ok(chat.includes(expected), expected)
})
