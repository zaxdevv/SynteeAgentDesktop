/* global require, __dirname, TextEncoder */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production hints with isolated memory search. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, require: name => name in dependencies ? dependencies[name] : require(name), TextEncoder })
  return module.exports
}
const assistants = load('src/shared/assistants.ts', {})
const contextUsage = load('src/shared/contextUsage.ts', {})
const usage = load('src/core/tokens/usageTracker.ts', {
  './modelCatalog': {}, './gatewayModelsCache': {}, '../../shared/data/builtinModels': {},
  '../../shared/imageFormat': { IMAGE_TOKEN_COST: 1000 }, './ModelPricing': {},
  '../../shared/contextUsage': contextUsage,
})
const { consumeHintBudget } = load('src/core/context/hintBudget.ts', { '../tokens/usageTracker': usage, '../../shared/assistants': assistants })

function watcherHarness(initial = { enabled: true, global: true, project: true, chat: true }) {
  let flags = initial
  const calls = []
  let search = async options => [
    { sourceId: 'global', scope: 'global', content: 'global fact' },
    { sourceId: 'project-A', scope: 'project', projectId: 'A', content: 'private project A' },
    { sourceId: 'project-B', scope: 'project', projectId: 'B', content: 'private project B' },
  ].filter(row => row.scope === 'global' ? options.memoryGlobal : options.memoryProject && row.projectId === options.projectId).map(row => ({ ...row, source: 'memory', score: 0.9, memoryRow: { scope: row.scope, project_id: row.projectId ?? null } }))
  const { Watcher } = load('src/core/agent/watcher.ts', {
    '../sidecar/sidecarClient': { resolveSemanticModelPaths: () => ({}), sidecarSemanticSearch: options => { calls.push(options); return search(options) } },
    '../skills/skillManager': { getSkillManager: () => ({ getActiveSkillsForChat: () => [] }) },
    '../context/embeddings': {}, '../logger': { log() {} },
    '../memory/globalMemorySettings': { getMemorySettings: () => flags },
  })
  return { calls, setFlags: value => { flags = value }, setSearch: value => { search = value }, make: (projectId, opts = {}) => new Watcher(assistants.DEFAULT_ASSISTANTS_SETTINGS, 'test-db', { projectId, ...opts }) }
}

test('Watcher scopes E5 memory to the current project and forwards disabled scope flags', async () => {
  const harness = watcherHarness({ enabled: true, global: false, project: true, chat: false })
  const hintsA = await harness.make('A').onTrigger({ kind: 'user_message', text: 'project configuration' }, [], true)
  const hintsB = await harness.make('B').onTrigger({ kind: 'user_message', text: 'project configuration' }, [], true)
  assert.equal(hintsA.length, 1)
  assert.equal(hintsA[0].content, 'private project A')
  assert.equal(hintsB[0].content, 'private project B')
  assert.equal(harness.calls[0].projectId, 'A')
  assert.equal(harness.calls[0].crossProject, false)
  assert.equal(harness.calls[0].memoryGlobal, false)
  assert.equal(harness.calls[0].memoryChat, false)
})

test('disabled memory never reaches the sidecar, and disabling during a search discards its result', async () => {
  const harness = watcherHarness({ enabled: false, global: true, project: true, chat: true })
  assert.equal((await harness.make('A').onTrigger({ kind: 'task_start', text: 'configuration' })).length, 0)
  assert.equal(harness.calls.length, 0)
  harness.setFlags({ enabled: true, global: true, project: true, chat: true })
  let finish
  harness.setSearch(() => new Promise(resolve => { finish = resolve }))
  const pending = harness.make('A').onTrigger({ kind: 'task_start', text: 'configuration' })
  harness.setFlags({ enabled: false, global: true, project: true, chat: true })
  finish([{ source: 'memory', sourceId: 'private', score: 1, content: 'do not expose' }])
  assert.equal((await pending).length, 0)
})

test('project switches discard in-flight Watcher hits', async () => {
  const harness = watcherHarness()
  let finish
  harness.setSearch(() => new Promise(resolve => { finish = resolve }))
  const watcher = harness.make('A')
  const pending = watcher.onTrigger({ kind: 'task_start', text: 'configuration' }, [], true)
  watcher.updateProject({ projectId: 'B' })
  finish([{ source: 'memory', sourceId: 'A', score: 1, content: 'old project fact' }])
  assert.equal((await pending).length, 0)
})

test('hint token budget includes Russian marker, metadata and message overhead; deferred hints survive', () => {
  const hints = Array.from({ length: 3 }, (_, i) => ({ id: String(i), source: 'memory', title: 'Память проекта', content: 'Сохрани конфигурацию проекта и важные факты. '.repeat(7), score: 1 }))
  const first = consumeHintBudget(hints, 160)
  assert.equal(first.selected.length, 1)
  assert.equal(first.remaining.length, 2)
  assert.ok(first.selected.reduce((sum, item) => sum + usage.estimateTokens(item.message) + 4, 0) <= 160)
  const second = consumeHintBudget(first.remaining, 160)
  assert.equal(second.selected[0].hint.id, '1')
  assert.equal(second.remaining[0].id, '2')
})

test('huge advisory and a disabled budget cannot exceed token budget or grow the pending queue', () => {
  const queue = Array.from({ length: 30 }, (_, i) => ({ id: String(i), source: 'navigator', content: '🚀 日本語 контекст '.repeat(2000), score: 1 }))
  const bounded = consumeHintBudget(queue, 100)
  assert.equal(bounded.selected.length, 1)
  assert.ok(usage.estimateTokens(bounded.selected[0].message) + 4 <= 100)
  assert.ok(bounded.remaining.length <= 3)
  const disabled = consumeHintBudget(queue, 0)
  assert.equal(disabled.selected.length, 0)
  assert.equal(disabled.remaining.length, 3)
})

test('Watcher rejects wrong-project and sibling-chat hits even when the sidecar returns them', async () => {
  const harness = watcherHarness()
  harness.setSearch(async () => [
    ['global', 'global', null, null], ['same-project', 'project', 'A', null],
    ['other-project', 'project', 'B', null], ['same-chat', 'chat', 'A', 'chat-A'],
    ['sibling-chat', 'chat', 'A', 'chat-B'], ['wrong-project-chat', 'chat', 'B', 'chat-A'],
  ].map(([id, scope, project_id, chat_id]) => ({ source: 'memory', sourceId: id, score: 0.9, content: id, memoryRow: { scope, project_id, chat_id } })))
  const watcher = harness.make('A', { chatId: 'chat-A' })
  const hints = await watcher.onTrigger({ kind: 'task_start', text: 'configuration' }, [], true)
  assert.equal(hints.map(hint => hint.content).join(','), 'global,same-project')
  watcher.lastTriggerTs = 0
  const remaining = await watcher.onTrigger({ kind: 'task_start', text: 'configuration' }, [], true)
  assert.equal(remaining.map(hint => hint.content).join(','), 'same-chat')
})

test('incognito Watcher never reads persistent memory but may still retrieve project skills', async () => {
  const harness = watcherHarness()
  const result = await harness.make('A', { chatId: 'private-chat', incognito: true }).collect({ kind: 'task_start', text: 'project configuration' })
  assert.equal(result.memory.length, 0)
  assert.equal(harness.calls.length, 0)
})

test('Watcher without a project returns only enabled global memory and ignores foreign metadata', async () => {
  const harness = watcherHarness({ enabled: true, global: true, project: false, chat: false })
  harness.setSearch(async () => [
    { source: 'memory', sourceId: 'global', score: 1, content: 'global', memoryRow: { scope: 'global' } },
    { source: 'memory', sourceId: 'foreign', score: 1, content: 'foreign', memoryRow: { scope: 'project', project_id: 'B' } },
    { source: 'memory', sourceId: 'unknown', score: 1, content: 'unknown' },
  ])
  const hints = await harness.make(undefined).onTrigger({ kind: 'task_start', text: 'configuration' }, [], true)
  assert.equal(hints.map(hint => hint.content).join(','), 'global')
})

test('project A→B→A and disabled→enabled transitions cannot revive an old search', async () => {
  for (const change of [
    watcher => { watcher.updateProject({ projectId: 'B' }); watcher.updateProject({ projectId: 'A' }) },
    watcher => { watcher.updateSettings({ ...assistants.DEFAULT_ASSISTANTS_SETTINGS, enabled: false }); watcher.updateSettings(assistants.DEFAULT_ASSISTANTS_SETTINGS) },
  ]) {
    const harness = watcherHarness()
    let finish
    harness.setSearch(() => new Promise(resolve => { finish = resolve }))
    const watcher = harness.make('A')
    const pending = watcher.collect({ kind: 'task_start', text: 'configuration' })
    change(watcher)
    finish([{ source: 'memory', sourceId: 'old', score: 1, content: 'old result', memoryRow: { scope: 'global' } }])
    assert.equal((await pending).memory.length, 0)
  }
})

test('newer collect wins over a slower older query without suppressing its results', async () => {
  const harness = watcherHarness()
  const completions = []
  harness.setSearch(() => new Promise(resolve => { completions.push(resolve) }))
  const watcher = harness.make('A')
  const older = watcher.collect({ kind: 'task_start', text: 'old task' })
  watcher.lastTriggerTs = 0
  const newer = watcher.collect({ kind: 'task_start', text: 'new task' })
  const hit = { source: 'memory', sourceId: 'same', score: 1, content: 'same fact', memoryRow: { scope: 'global' } }
  completions[0]([hit])
  assert.equal((await older).memory.length, 0)
  completions[1]([hit])
  assert.equal((await newer).memory.length, 1)
})
