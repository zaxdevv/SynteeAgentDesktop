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
const recallRelevance = load('src/core/memory/recallRelevance.ts', {})
const { consumeHintBudget } = load('src/core/context/hintBudget.ts', { '../tokens/usageTracker': usage, '../../shared/assistants': assistants })

function watcherHarness(initial = { enabled: true, global: true, project: true, chat: true }) {
  let flags = initial
  const calls = []
  let search = async options => [
    { sourceId: 'global', scope: 'global', content: 'global cookie configuration fact' },
    { sourceId: 'project-A', scope: 'project', projectId: 'A', content: 'private cookie configuration for project A' },
    { sourceId: 'project-B', scope: 'project', projectId: 'B', content: 'private cookie configuration for project B' },
  ].filter(row => row.scope === 'global' ? options.memoryGlobal : options.memoryProject && row.projectId === options.projectId).map(row => ({ ...row, source: 'memory', score: 0.9, memoryRow: { scope: row.scope, project_id: row.projectId ?? null } }))
  let skills = () => []
  const { Watcher } = load('src/core/agent/watcher.ts', {
    '../sidecar/sidecarClient': { resolveSemanticModelPaths: () => ({}), sidecarSemanticSearch: options => { calls.push(options); return search(options) } },
    '../skills/skillManager': { getSkillManager: () => ({ getActiveSkillsForChat: options => skills(options) }) },
    '../logger': { log() {} },
    '../memory/recallRelevance': recallRelevance,
    '../memory/globalMemorySettings': { getMemorySettings: () => flags },
  })
  return { calls, setFlags: value => { flags = value }, setSearch: value => { search = value }, setSkills: value => { skills = value }, make: (projectId, opts = {}) => new Watcher(assistants.DEFAULT_ASSISTANTS_SETTINGS, 'test-db', { projectId, ...opts }) }
}

test('Watcher scopes E5 memory to the current project and forwards disabled scope flags', async () => {
  const harness = watcherHarness({ enabled: true, global: false, project: true, chat: false })
  const hintsA = await harness.make('A').onTrigger({ kind: 'user_message', text: 'cookie configuration' }, true)
  const hintsB = await harness.make('B').onTrigger({ kind: 'user_message', text: 'cookie configuration' }, true)
  assert.equal(hintsA.length, 1)
  assert.equal(hintsA[0].content, 'private cookie configuration for project A')
  assert.equal(hintsB[0].content, 'private cookie configuration for project B')
  assert.equal(harness.calls[0].projectId, 'A')
  assert.equal(harness.calls[0].crossProject, false)
  assert.equal(harness.calls[0].memoryGlobal, false)
  assert.equal(harness.calls[0].memoryChat, false)
})

test('disabled memory never reaches the sidecar, and disabling during a search discards its result', async () => {
  const harness = watcherHarness({ enabled: false, global: true, project: true, chat: true })
  assert.equal((await harness.make('A').onTrigger({ kind: 'task_start', text: 'cookie configuration' })).length, 0)
  assert.equal(harness.calls.length, 0)
  harness.setFlags({ enabled: true, global: true, project: true, chat: true })
  let finish
  harness.setSearch(() => new Promise(resolve => { finish = resolve }))
  const pending = harness.make('A').onTrigger({ kind: 'task_start', text: 'cookie configuration' })
  harness.setFlags({ enabled: false, global: true, project: true, chat: true })
  finish([{ source: 'memory', sourceId: 'private', score: 1, content: 'do not expose' }])
  assert.equal((await pending).length, 0)
})

test('project switches discard in-flight Watcher hits', async () => {
  const harness = watcherHarness()
  let finish
  harness.setSearch(() => new Promise(resolve => { finish = resolve }))
  const watcher = harness.make('A')
  const pending = watcher.onTrigger({ kind: 'task_start', text: 'cookie configuration' }, true)
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
  ].map(([id, scope, project_id, chat_id]) => ({ source: 'memory', sourceId: id, score: 0.9, content: id + ' cookie configuration', memoryRow: { scope, project_id, chat_id } })))
  const watcher = harness.make('A', { chatId: 'chat-A' })
  const hints = await watcher.onTrigger({ kind: 'task_start', text: 'cookie configuration' }, true)
  assert.equal(hints.map(hint => hint.id).join(','), 'mem-same-project,mem-same-chat')
  assert.equal(harness.calls[0].chatId, 'chat-A')
})

test('incognito Watcher stays within the private chat and skips persistent sources', async () => {
  const harness = watcherHarness()
  harness.setSkills(() => { throw new Error('Private chat should not scan skills') })
  const result = await harness.make('A', { chatId: 'private-chat', incognito: true }).collect({ kind: 'task_start', text: 'cookie configuration' })
  assert.equal(result.memory.length, 0)
  assert.equal(result.skills.length, 0)
  assert.equal(harness.calls.length, 0)
})

test('Watcher without a project uses only memory for this exact unprojected chat', async () => {
  const harness = watcherHarness()
  harness.setSearch(async () => [
    { source: 'memory', sourceId: 'global', score: 1, content: 'global cookie configuration', memoryRow: { scope: 'global' } },
    { source: 'memory', sourceId: 'foreign', score: 1, content: 'cookie configuration', memoryRow: { scope: 'project', project_id: 'B' } },
    { source: 'memory', sourceId: 'local', score: 1, content: 'cookie configuration', memoryRow: { scope: 'chat', chat_id: 'standalone', project_id: null } },
  ])
  const hints = await harness.make(undefined, { chatId: 'standalone' }).onTrigger({ kind: 'task_start', text: 'cookie configuration' }, true)
  assert.equal(hints.map(hint => hint.id).join(','), 'mem-local')
  assert.equal(harness.calls[0].memoryGlobal, false)
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
    const pending = watcher.collect({ kind: 'task_start', text: 'cookie configuration' })
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
  const older = watcher.collect({ kind: 'task_start', text: 'database configuration' })
  const newer = watcher.collect({ kind: 'task_start', text: 'SQLite configuration' })
  const hit = { source: 'memory', sourceId: 'same', score: 1, content: 'SQLite database configuration', memoryRow: { scope: 'project', project_id: 'A' } }
  completions[0]([hit])
  assert.equal((await older).memory.length, 0)
  completions[1]([hit])
  assert.equal((await newer).memory.length, 1)
})

test('automatic memory requires evidence in the delivered excerpt even with a high semantic score', async () => {
  const harness = watcherHarness()
  harness.setSearch(async () => [
    { source: 'memory', sourceId: 'unrelated', score: 0.99, content: 'REA version rollback and schema limits', memoryRow: { scope: 'global' } },
    { source: 'memory', sourceId: 'generic', score: 0.96, content: 'Project configuration has changed', memoryRow: { scope: 'project', project_id: 'A' } },
    { source: 'memory', sourceId: 'real', score: 0.82, content: 'Конфигурация авторизации использует фиксированный cookie domain.', memoryRow: { scope: 'project', project_id: 'A' } },
  ])
  const hints = await harness.make('A').onTrigger({ kind: 'task_start', text: 'конфигурацию авторизации' }, true)
  assert.equal(hints.map(item => item.id).join(','), 'mem-real')
})

test('Watcher skips automatic memory for identity, periodic transcript and chat memory opt-out', async () => {
  const harness = watcherHarness()
  for (const [opts, trigger] of [
    [{}, { kind: 'task_start', text: 'какая ты модель кратко' }],
    [{}, { kind: 'task_start', text: 'привет, подскажи, какая ты модель?' }],
    [{}, { kind: 'periodic', text: 'cookie configuration' }],
    [{}, { kind: 'stuck', text: 'cookie configuration' }],
    [{}, { kind: 'task_start', text: 'project configuration' }],
    [{ memoryAllowed: false }, { kind: 'task_start', text: 'cookie configuration' }],
  ]) {
    const watcher = harness.make('A', opts)
    assert.equal((await watcher.collect(trigger)).memory.length, 0)
  }
  assert.equal(harness.calls.length, 0)
})

test('Watcher requires memory to match both the failure and the current task', async () => {
  const harness = watcherHarness()
  const watcher = harness.make('A')
  await watcher.collect({ kind: 'task_start', text: 'Проверь authClient.ts' })
  watcher.lastTriggerTs = 0
  const memoryRow = { scope: 'project', project_id: 'A' }
  harness.setSearch(async () => [
    { source: 'memory', sourceId: 'tool', score: 0.98, content: 'The read_file tool accepts UTF-8 authClient.ts files.', memoryRow },
    { source: 'memory', sourceId: 'other', score: 0.93, content: 'ENOENT may mean an unrelated generated file is missing.', memoryRow },
    { source: 'memory', sourceId: 'enoent', score: 0.87, content: 'ENOENT: authClient.ts is generated before bundling.', memoryRow },
  ])
  const hints = await watcher.onTrigger({ kind: 'tool_error', toolName: 'read_file', error: 'ENOENT' }, true)
  assert.equal(hints.map(item => item.id).join(','), 'mem-enoent')
})

test('exact technical identifiers anchor recall while words require full token matches', () => {
  const { buildRecallEvidence, hasRecallEvidence } = recallRelevance
  assert.equal(hasRecallEvidence(buildRecallEvidence('Find the root cause in authClient.ts'), 'Updated src/services/authClient.ts after a regression.'), true)
  assert.equal(hasRecallEvidence(buildRecallEvidence('подскажи про режим кэша'), 'Кэширование было отключено в прошлом эксперименте.'), false)
  assert.equal(hasRecallEvidence(buildRecallEvidence('SQLite database locks'), 'SQLite database lock under concurrent writes.'), true)
  assert.equal(hasRecallEvidence(buildRecallEvidence('redis auth issue'), 'A painless authorization library.'), false)
  assert.equal(hasRecallEvidence(buildRecallEvidence('проверь src/auth/session.ts'), 'src/cache/session.ts works offline.'), false)
})

test('current project skills need an exact technical label or strong lexical overlap', async () => {
  const harness = watcherHarness({ enabled: false, global: false, project: false, chat: false })
  let skillsReads = 0
  harness.setSkills(opts => {
    skillsReads++
    assert.equal(opts.projectId, 'A')
    assert.equal(opts.projectWorkdir, 'project-a')
    return [
      { id: 'project:A:build-check', name: 'build-check', description: 'Run local build checks' },
      { id: 'builtin:office', name: 'office', description: 'Generate business reports' },
    ]
  })
  const watcher = harness.make('A', { projectWorkdir: 'project-a' })
  const mixed = await watcher.collect({ kind: 'task_start', text: 'Пожалуйста, запусти build-check для сборки' })
  assert.equal(mixed.skills.map(skill => skill.title).join(','), 'build-check')
  const unrelated = await watcher.collect({ kind: 'task_start', text: 'Проверь конфигурацию авторизации' })
  assert.equal(unrelated.skills.length, 0)
  const generic = await watcher.collect({ kind: 'task_start', text: 'help please' })
  assert.equal(generic.skills.length, 0)
  assert.equal(skillsReads, 2)
})
