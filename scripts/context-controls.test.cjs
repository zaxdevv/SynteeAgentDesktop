const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
function load(file, deps) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => {
    if (!(id in deps)) throw new Error(`Unexpected dependency: ${id}`)
    return deps[id]
  }, mod, mod.exports)
  return mod.exports
}
const shared = load('src/shared/types/contextControls.ts', {})
let prefsJSON
let messages = []
let lastHidden
let lastPin
const db = {
  exec() {},
  prepare(sql) {
    return {
      get(...args) {
        if (sql.includes('SELECT preferences')) return prefsJSON ? { preferences: prefsJSON } : undefined
        if (sql.includes('FROM chats')) return args[0] === 'chat' ? { id: 'chat' } : undefined
        if (sql.includes('FROM messages')) return messages.some(m => m.id === args[0] && m.chatId === args[1]) ? { id: args[0] } : undefined
        throw new Error(sql)
      },
      all() { return messages.filter(m => m.isPinned).map(m => ({ id: m.id })) },
      run(_chat, json) { prefsJSON = json },
    }
  },
}
const api = load('src/core/db/contextControls.ts', {
  './handle': { getDB: () => db },
  './messages': {
    getMessages: () => messages,
    getMessageById: id => messages.find(m => m.id === id),
    getPinnedMessages: () => messages.filter(m => m.isPinned),
    pinMessage: id => { lastPin = [id, true] },
    unpinMessage: id => { lastPin = [id, false] },
    setMessageHidden: (id, value) => { lastHidden = [id, value]; return true },
  },
  '../../shared/types/contextControls': shared,
})
assert.deepEqual(api.getContextPreferences('chat'), shared.DEFAULT_CONTEXT_PREFERENCES)
api.setContextPreferences('chat', { sources: { memory: false }, excludedFiles: ['a', 'a', 9] })
assert.equal(api.getContextPreferences('chat').sources.memory, false)
assert.equal(api.getContextPreferences('chat').sources.instructions, true)
assert.deepEqual(api.getContextPreferences('chat').excludedFiles, ['a'])
assert.throws(() => api.setContextPreferences('wrong', {}), /Chat not found/)
const msg = (id, createdAt, extra = {}) => ({ id, chatId: 'chat', role: 'assistant', content: id, createdAt, ...extra })
messages = [msg('pin', 1, { isPinned: true }), msg('hidden-pin', 2, { isPinned: true, hiddenFromContext: true }), msg('old', 3)]
const live = [msg('live', 4, { toolSteps: [{ type: 'tool_result', content: 'secret tool result' }] }), msg('current', 5)]
assert.deepEqual(api.filterContextHistory('chat', live, 'current').map(m => m.id), ['pin', 'live'])
api.setContextPreferences('chat', { sources: { history: false } })
assert.deepEqual(api.filterContextHistory('chat', live).map(m => m.id), ['pin'])
api.setContextPreferences('chat', { sources: { history: true, tools: false } })
const filtered = api.filterContextHistory('chat', live, 'current')
assert.equal(filtered.find(m => m.id === 'live').toolSteps, undefined)
assert.equal(live[0].toolSteps.length, 1, 'must not mutate cached messages')
api.setContextMessageHidden('chat', 'pin', true)
assert.deepEqual(lastHidden, ['pin', true])
api.setContextMessagePinned('chat', 'pin', false)
assert.deepEqual(lastPin, ['pin', false])
assert.throws(() => api.setContextMessageHidden('chat', 'foreign', true), /does not belong/)
assert.throws(() => api.setContextMessageHidden('chat', 'pin', 'yes'), /Invalid/)
prefsJSON = '{bad'
assert.deepEqual(api.getContextPreferences('chat'), shared.DEFAULT_CONTEXT_PREFERENCES)
console.log('context controls regressions passed')
