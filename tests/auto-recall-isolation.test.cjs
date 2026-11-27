/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated automatic-recall boundary tests. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function harness() {
  let flags = { enabled: true, global: true, project: true, chat: true }
  let search = async () => []
  const calls = []
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, '../src/main/ipc/autoRecallCache.ts'), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', code)(name => {
    if (name.endsWith('globalMemorySettings')) return { getMemorySettings: () => flags }
    if (name.endsWith('MemoryStore')) return { searchAllSources: params => { calls.push(params); return search(params) } }
    throw new Error(`unexpected dependency: ${name}`)
  }, module, module.exports)
  return { ...module.exports, calls, setFlags: next => { flags = next }, setSearch: next => { search = next } }
}
const item = (id, scope, projectId, chatId) => ({ source: 'memory', content: id, score: 1, item: { id, scope, projectId, chatId } })

test('automatic recall never requests cross-project fallback and rejects foreign memory rows', async () => {
  const h = harness()
  h.setSearch(async () => [item('global', 'global'), item('project-A', 'project', 'A'), item('project-B', 'project', 'B'), item('chat-A', 'chat', 'A', 'a'), item('chat-B', 'chat', 'A', 'b')])
  const result = await h.searchAutoRecallCached({ query: 'build', projectId: 'A', chatId: 'a', crossProject: true })
  assert.equal(h.calls[0].crossProject, false)
  assert.equal(result.map(hit => hit.content).join(','), 'global,project-A,chat-A')
})

test('automatic recall cache is partitioned by project, chat and live memory toggles', async () => {
  const h = harness()
  h.setSearch(async () => [item('global', 'global'), item('project-A', 'project', 'A'), item('chat-A', 'chat', 'A', 'a')])
  const params = { query: 'build', projectId: 'A', chatId: 'a' }
  assert.equal((await h.searchAutoRecallCached(params)).length, 3)
  assert.equal((await h.searchAutoRecallCached(params)).length, 3)
  assert.equal(h.calls.length, 1)
  assert.equal((await h.searchAutoRecallCached({ ...params, chatId: 'b' })).length, 2)
  h.setFlags({ enabled: true, global: false, project: false, chat: true })
  assert.equal((await h.searchAutoRecallCached(params)).map(hit => hit.content).join(','), 'chat-A')
  h.setFlags({ enabled: false, global: true, project: true, chat: true })
  assert.equal((await h.searchAutoRecallCached(params)).length, 0)
  assert.equal(h.calls.length, 3)
})

test('switching off memory during a search discards its response and does not cache it', async () => {
  const h = harness()
  let finish
  h.setSearch(() => new Promise(resolve => { finish = resolve }))
  const pending = h.searchAutoRecallCached({ query: 'build', projectId: 'A' })
  h.setFlags({ enabled: false, global: true, project: true, chat: true })
  finish([item('private', 'project', 'A')])
  assert.equal((await pending).length, 0)
  h.setFlags({ enabled: true, global: true, project: true, chat: true })
  h.setSearch(async () => [])
  await h.searchAutoRecallCached({ query: 'build', projectId: 'A' })
  assert.equal(h.calls.length, 2)
})

test('no-project automatic recall keeps global facts and disabled project/chat scopes stay hidden', async () => {
  const h = harness()
  h.setSearch(async () => [item('global', 'global'), item('foreign', 'project', 'B'),
    { source: 'graph', content: 'project graph', score: 1 }, { source: 'messages', content: 'old chat', score: 1 }])
  h.setFlags({ enabled: true, global: true, project: false, chat: false })
  assert.equal((await h.searchAutoRecallCached({ query: 'build' })).map(hit => hit.content).join(','), 'global')
})

test('send adapter passes trusted incognito context and explicit cross-project recall remains opt-in', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/ipc/chatSendEngine.ts'), 'utf8')
  assert.match(source, /attachAssistants\(params\.chatId, worker, \{[^\n]+incognito: !!params\.incognito/)
  const automatic = source.slice(source.indexOf('// ── Auto-recall: всегда'), source.indexOf('// Goal runtime transport'))
  assert.doesNotMatch(automatic, /crossProject:\s*true/)
  assert.match(automatic, /projectId: chatProjectId/)
  assert.match(source, /crossProject: msg\.crossProject as boolean/)
})
