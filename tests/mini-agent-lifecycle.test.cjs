/* global require, __dirname, console, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, process, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production lifecycle code with isolated dependencies. */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { AsyncLocalStorage } = require('node:async_hooks')
const ts = require('typescript')

function load(file, stubs, globals = {}) {
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    module, exports: module.exports,
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : require(name),
    console, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    process, Buffer, ...globals,
  })
  return module.exports
}

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

function managerHarness() {
  const requests = []
  const queueTimers = new Set()
  const manager = load('src/main/localModels/LocalModelManager.ts', {
    electron: { app: {}, webContents: { getAllWebContents: () => [] } },
    '../../core/logger': { log: () => {} },
    '../assistants/modelManager': {
      detectModelSize: () => '1.2B', resolveCtxSize: () => 4096, isModelDownloaded: () => true,
      getModelInfo: () => ({ expectedBytes: 731_000_000 }),
    },
    '../assistants/binaryManager': {},
    '../assistants/hardware': { getAssistantStartupError: () => undefined },
    'node:timers/promises': { setTimeout: async () => {} },
  }, {
    setTimeout: (fn, ms) => {
      if (ms !== 45000) return setTimeout(fn, ms)
      const timer = { fire: fn }
      queueTimers.add(timer)
      return timer
    },
    clearTimeout: timer => queueTimers.has(timer) ? queueTimers.delete(timer) : clearTimeout(timer),
    fetch: (_url, options) => new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('aborted'))
      options.signal.addEventListener('abort', onAbort, { once: true })
      requests.push({
        prompt: JSON.parse(options.body).messages[0].content,
        finish: () => {
          options.signal.removeEventListener('abort', onAbort)
          resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })
        },
      })
    }),
  }).localModels
  manager.state = 'ready'
  manager.prepareBinary = async () => ({ flavor: 'cpu' })
  manager.spawnServer = async () => true
  manager.startWatchdog = () => {}
  return { manager, requests, queueTimers }
}

test('cancelling one chat removes queued work and frees an active slot for another chat', async () => {
  const { manager, requests, queueTimers } = managerHarness()
  const a = new AbortController()
  const queued = new AbortController()
  const pa = manager.complete('chat A running', { signal: a.signal }).catch(error => error.message)
  await tick()
  const pb = manager.complete('chat B running')
  await tick()
  const pq = manager.complete('chat A queued', { signal: queued.signal }).catch(error => error.message)
  const pc = manager.complete('chat C queued')
  await tick()
  assert.equal(requests.length, 2)
  queued.abort()
  assert.match(await pq, /cancel/i)
  assert.equal(manager.queue.length, 1)
  a.abort()
  assert.match(await pa, /aborted/)
  await tick()
  assert.equal(requests.length, 3)
  assert.equal(requests[2].prompt, 'chat C queued')
  requests[1].finish()
  requests[2].finish()
  assert.equal(await pb, 'ok')
  assert.equal(await pc, 'ok')
  assert.equal(queueTimers.size, 0)
})

test('recovered server resumes retained queued jobs without a new completion request', async () => {
  const { manager, requests } = managerHarness()
  const start = deferred()
  manager.spawnServer = () => start.promise
  const pa = manager.complete('a').catch(() => '')
  const pb = manager.complete('b').catch(() => '')
  const pc = manager.complete('survives crash')
  await tick()
  const recovery = manager.handleCrash(manager.lifecycle.signal)
  await tick()
  assert.equal(manager.inFlight, 0)
  assert.equal(manager.queue.length, 1)
  start.resolve(true)
  await recovery
  await tick()
  assert.equal(requests[2].prompt, 'survives crash')
  requests[2].finish()
  assert.equal(await pc, 'ok')
  await Promise.all([pa, pb])
})

test('queued jobs expire while all slots are occupied', async () => {
  const { manager, requests, queueTimers } = managerHarness()
  const pa = manager.complete('a')
  const pb = manager.complete('b')
  const pq = manager.complete('expires').catch(error => error.message)
  await tick()
  assert.equal(queueTimers.size, 1)
  for (const timer of [...queueTimers]) timer.fire()
  assert.match(await pq, /queue timed out/)
  assert.equal(manager.queue.length, 0)
  requests.forEach(request => request.finish())
  await Promise.all([pa, pb])
})

test('cancellation during cold start settles before startup completes and never queues the job', async () => {
  const { manager } = managerHarness()
  const start = deferred()
  manager.ensureReady = () => start.promise
  const controller = new AbortController()
  const completion = manager.complete('cancel cold start', { signal: controller.signal }).catch(() => 'cancelled')
  controller.abort()
  assert.equal(await completion, 'cancelled')
  assert.equal(manager.queue.length, 0)
  start.resolve(true)
})

test('permanent startup failure rejects retained queued jobs and cleans deadline timers', async () => {
  const { manager, queueTimers } = managerHarness()
  manager.state = 'error'
  const completion = manager.enqueue('pending', {}).catch(error => error.message)
  manager.spawnServer = async () => false
  assert.equal(await manager.doEnsure(new AbortController().signal), false)
  assert.match(await completion, /failed to start/)
  assert.equal(queueTimers.size, 0)
})

test('488-tool semantic catalogue reuses embeddings and invalidates cache on embedding mode change', async () => {
  let calls = 0
  let mode = 'tfidf'
  const watcher = load('src/core/agent/watcher.ts', {
    '../memory/globalMemorySettings': { getMemorySettings: () => ({ enabled: false }) },
    '../sidecar/sidecarClient': {}, '../skills/skillManager': {}, '../logger': { log: () => {} },
    '../context/embeddings': {
      getEmbedder: async () => ({ mode, dim: 1, embed: async () => { calls++; return new Float32Array([1]) } }),
      cosineSimilarity: () => 1,
    },
  })
  const catalogue = Array.from({ length: 488 }, (_, i) => ({ id: String(i), name: `tool${i}`, desc: `description${i}` }))
  await watcher.scoreCapabilitiesSemantic(catalogue, 'query')
  assert.equal(calls, 489)
  await watcher.scoreCapabilitiesSemantic(catalogue, 'new query')
  assert.equal(calls, 490)
  mode = 'neural'
  await watcher.scoreCapabilitiesSemantic(catalogue, 'query')
  assert.equal(calls, 979)
})

function bridgeHarness(overrides = {}) {
  const privacy = new AsyncLocalStorage()
  const persistedLogs = []
  const counts = { wake: 0, saved: 0 }
  const settings = {
    enabled: true, watcherEnabled: true, navigatorEnabled: true, archivistEnabled: true,
    janitorEnabled: true, modelSize: 'auto', ctxSize: 'auto', device: 'auto',
    sources: { memory: true, skills: true },
  }
  let memory = overrides.memory ?? { enabled: true, global: true, project: true, chat: true, auto: true }
  const bridge = load('src/main/assistants/bridge.ts', {
    '../../core/agent/watcher': {
      Watcher: class {
        setSourceWeightProvider() {} updateSettings() {}
        async collect() { return { memory: overrides.memoryHints ?? [], skills: overrides.skillHints ?? [] } }
        async onTrigger() { return overrides.memoryHints ?? [] }
      },
      prefilterCapabilities: catalogue => catalogue,
      hashContext: text => text,
    },
    '../../shared/assistants': { DEFAULT_ASSISTANTS_SETTINGS: settings, ASSISTANTS_LOG_MAX_ENTRIES: 500, ASSISTANTS_LOG_RETENTION_MS: 24 * 3600 * 1000 },
    '../../core/logger': {
      log: () => {}, isPrivateLogContext: () => privacy.getStore() ?? false,
      withLogPrivacy: (incognito, run) => privacy.run(incognito, run),
    },
    './llmClient': overrides.llm ?? {},
    './llmServer': { getServerState: () => overrides.ready === false ? 'idle' : 'ready' },
    '../../core/memory/MemoryStore': {
      saveMemoryItem: async () => { counts.saved++ },
      decayAutoFacts: () => 0,
    },
    '../../core/memory/globalMemorySettings': { getMemorySettings: () => memory },
    '../../core/sidecar/sidecarClient': { resolveSemanticModelPaths: () => null },
    '../localModels/LocalModelManager': {
      localModels: {
        setModelSize() {}, setCtxSetting() {}, setDevice() {}, shutdown() {},
        ensureReady: async () => { counts.wake++; return true }, getState: () => 'idle',
      },
    },
    './modelManager': { detectModelSize: () => '1.2B', isModelSize: value => ['1.2B', '1B', '0.8B'].includes(value) },
  })
  bridge.initAssistants({ load: () => settings, persist: () => {}, dbPath: () => '', chatAlive: overrides.chatAlive,
    loadLog: () => overrides.savedLog, persistLog: entries => persistedLogs.push(entries),
  })
  function attach(chatId, opts = {}) {
    const worker = new EventEmitter()
    worker.messages = []
    worker.postMessage = message => worker.messages.push(message)
    bridge.attachAssistants(chatId, worker, opts)
    return worker
  }
  return { bridge, attach, counts, persistedLogs, setMemory: next => { memory = next } }
}

test('incognito assistant attachment blocks persistent memory hints and Archivist writes', async () => {
  let distillations = 0
  const { bridge, attach, counts } = bridgeHarness({
    memoryHints: [{ id: 'private-memory', source: 'memory', content: 'persistent fact', score: 1 }],
    llm: { distillSession: async () => { distillations++; return [{ content: 'do not persist', kind: 'project' }] } },
  })
  const worker = attach('incognito-a', { incognito: true, projectId: 'A' })
  await bridge.onAgentEvent('incognito-a', { kind: 'task_start', text: 'configuration' })
  await bridge.onAssistantEvent('incognito-a', { kind: 'archivist', transcript: 'private transcript '.repeat(100), projectId: 'B' })
  await tick()
  assert.equal(worker.messages.filter(message => message.type === 'hint' && message.hint.source === 'memory').length, 0)
  assert.equal(distillations, 0)
  assert.equal(counts.saved, 0)
  bridge.detachAssistants('incognito-a')
})

test('Archivist respects the target scope switch before distillation and after an in-flight result', async () => {
  for (const projectId of [undefined, 'A']) {
    let distillations = 0
    const scope = projectId ? 'project' : 'global'
    const base = { enabled: true, global: true, project: true, chat: true, auto: true }
    const result = deferred()
    const { bridge, attach, counts, setMemory } = bridgeHarness({ memory: { ...base, [scope]: false }, llm: {
      distillSession: () => { distillations++; return result.promise },
    } })
    attach('scope-test', { projectId })
    const event = { kind: 'archivist', transcript: 'durable convention '.repeat(100) }
    await bridge.onAssistantEvent('scope-test', event)
    await tick()
    assert.equal(distillations, 0)
    setMemory(base)
    await bridge.onAssistantEvent('scope-test', event)
    await tick()
    assert.equal(distillations, 1)
    setMemory({ ...base, [scope]: false })
    result.resolve([{ content: 'durable fact that must not be saved', kind: 'project' }])
    await tick(); await tick()
    assert.equal(counts.saved, 0)
    bridge.detachAssistants('scope-test')
  }
})

test('bookkeeping and disabled roles do not start a model or wait for readiness', async () => {
  const { bridge, attach, counts } = bridgeHarness({ ready: false })
  attach('a')
  for (const kind of ['capabilities', 'economist', 'briefing', 'janitor_skip']) {
    await bridge.onAssistantEvent('a', { kind, capabilities: [] })
  }
  bridge.updateAssistantsSettings({ navigatorEnabled: false })
  await bridge.onAssistantEvent('a', { kind: 'navigator' })
  assert.equal(counts.wake, 0)
})

test('enabling mini-agents applies settings without starting a model', async () => {
  const { bridge, counts } = bridgeHarness({ ready: false })
  bridge.updateAssistantsSettings({ enabled: false })
  assert.equal((await bridge.downloadAndStart()).ok, false)
  bridge.updateAssistantsSettings({ enabled: true })
  assert.equal(counts.wake, 0)
  assert.equal((await bridge.downloadAndStart()).ok, true)
  assert.equal(counts.wake, 1)
})

test('journal limit returns the newest entries in chronological order', () => {
  const now = Date.now()
  const { bridge } = bridgeHarness({ savedLog: [0, 1, 2].map(offset => ({
    ts: now + offset, role: 'watcher', kind: 'trigger', detail: 'fixture',
  })) })
  assert.equal(bridge.getAssistantLog().length, 3)
  assert.deepEqual(Array.from(bridge.getAssistantLog(undefined, 2), entry => entry.ts), [now + 1, now + 2])
  assert.equal(bridge.getAssistantLog(now + 2, 2).length, 1)
  assert.equal(bridge.getAssistantLog(undefined, 0).length, 0)
})

test('replacing one worker aborts its jobs, rejects late hints, and preserves another chat', async () => {
  const tasks = []
  const { bridge, attach } = bridgeHarness({ llm: {
    judgeDrift: (...args) => { const task = deferred(); tasks.push({ ...task, signal: args[4] }); return task.promise },
  } })
  const oldA = attach('a')
  const workerB = attach('b')
  const pa = bridge.onAssistantEvent('a', { kind: 'navigator' })
  const pb = bridge.onAssistantEvent('b', { kind: 'navigator' })
  await tick()
  const newA = attach('a')
  oldA.emit('exit')
  assert.equal(tasks[0].signal.aborted, true)
  assert.equal(tasks[1].signal.aborted, false)
  tasks.forEach(task => task.resolve({ drift: true, reason: 'finish goal' }))
  await Promise.all([pa, pb])
  assert.equal(oldA.messages.filter(message => message.type === 'hint').length, 0)
  assert.equal(newA.messages.filter(message => message.type === 'hint').length, 0)
  assert.equal(workerB.messages.filter(message => message.type === 'hint').length, 1)
  bridge.detachAssistants('a')
  bridge.detachAssistants('b')
})

test('Archivist persists final-run facts after its worker exits', async () => {
  const result = deferred()
  const { bridge, attach, counts } = bridgeHarness({ llm: { distillSession: () => result.promise } })
  const worker = attach('a')
  void bridge.onAssistantEvent('a', { kind: 'archivist', transcript: 'durable project decisions '.repeat(30) })
  await tick()
  worker.emit('exit')
  result.resolve([{ content: 'Use the project convention for future code', kind: 'project' }])
  await tick()
  await tick()
  assert.equal(counts.saved, 1)
  bridge.detachAssistants('a')
})

test('Archivist gates short transcripts and disabled memory in main before waking the model', async () => {
  let distilled = 0
  const { bridge, attach, counts, setMemory } = bridgeHarness({ llm: { distillSession: async () => { distilled++; return [] } } })
  attach('short')
  await bridge.onAssistantEvent('short', { kind: 'archivist', transcript: 'готово' })
  await tick()
  assert.equal(distilled, 0, 'short run is not distilled')
  setMemory({ enabled: false, global: true, project: true, chat: true, auto: false })
  await bridge.onAssistantEvent('short', { kind: 'archivist', transcript: 'durable decisions '.repeat(30) })
  await tick()
  assert.equal(distilled, 0, 'memory disabled → no generation')
  assert.equal(counts.wake, 0, 'gates run before any server wake')
  bridge.detachAssistants('short')
})

test('deleting a chat cancels its archivist job and never writes memory afterwards', async () => {
  const result = deferred()
  const { bridge, attach, counts } = bridgeHarness({ llm: { distillSession: () => result.promise } })
  const worker = attach('gone')
  void bridge.onAssistantEvent('gone', { kind: 'archivist', transcript: 'durable project decisions '.repeat(30) })
  await tick()
  worker.emit('exit')
  bridge.onChatDeleted('gone')
  result.resolve([{ content: 'Use the project convention for future code', kind: 'project' }])
  await tick()
  await tick()
  assert.equal(counts.saved, 0)
})

test('navigator drops events beyond the round lag and pre-steer revisions without a model call', async () => {
  let judgements = 0
  const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: async () => { judgements++; return { drift: true, reason: 'keep going' } } } })
  const worker = attach('a')
  await bridge.onAssistantEvent('a', { kind: 'round_advanced', round: 10 })
  await bridge.onAssistantEvent('a', { kind: 'navigator', round: 1, taskRevision: 0 })
  assert.equal(judgements, 0)
  await bridge.onAssistantEvent('a', { kind: 'task_revised' })
  await bridge.onAssistantEvent('a', { kind: 'navigator', round: 9, taskRevision: 0 })
  assert.equal(judgements, 0, 'verdict for the pre-steer task is not requested')
  await bridge.onAssistantEvent('a', { kind: 'navigator', round: 9, taskRevision: 1 })
  assert.equal(judgements, 1)
  assert.equal(worker.messages.filter(message => message.type === 'hint').length, 1)
  bridge.detachAssistants('a')
})

test('round progress does not abort an in-flight navigator verdict (only a real task revision does)', async () => {
  const tasks = []
  const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: (...args) => {
    const task = deferred()
    tasks.push({ ...task, signal: args[4] })
    return task.promise
  } } })
  const worker = attach('a')
  const pending = bridge.onAssistantEvent('a', { kind: 'navigator', round: 1, taskRevision: 0, lastUsefulRound: -100 })
  await tick()
  // Следующий раунд рана — судья ещё считает: это НЕ повод отменять вызов.
  await bridge.onAssistantEvent('a', { kind: 'round_advanced', round: 2 })
  assert.equal(tasks[0].signal.aborted, false)
  tasks[0].resolve({ drift: true, reason: 'step back to the goal' })
  await pending
  assert.equal(worker.messages.filter(message => message.type === 'hint').length, 1)
  bridge.detachAssistants('a')
})

test('navigator does not re-judge the same round nor repeat a just-applied hint', async () => {
  let judgements = 0
  const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: async () => { judgements++; return { drift: true, reason: 'return to the goal now' } } } })
  attach('a')
  await bridge.onAssistantEvent('a', { kind: 'navigator', round: 4, taskRevision: 0, lastUsefulRound: -100 })
  assert.equal(judgements, 1)
  await bridge.onAssistantEvent('a', { kind: 'navigator', round: 4, taskRevision: 0, lastUsefulRound: -100 })
  assert.equal(judgements, 1, 'same round is not judged twice')
  await bridge.onAssistantEvent('a', { kind: 'navigator', round: 5, taskRevision: 0, lastUsefulRound: 4 })
  assert.equal(judgements, 1, 'a hint applied in the previous round gets time to work')
  await bridge.onAssistantEvent('a', { kind: 'navigator', round: 7, taskRevision: 0, lastUsefulRound: 4 })
  assert.equal(judgements, 2)
  bridge.detachAssistants('a')
})

test('hint_applied is deterministic feedback for real prompt insertions and needs no generation', async () => {
  let generations = 0
  const { bridge, attach } = bridgeHarness({ llm: {
    judgeCapability: async () => ({ helpful: true, id: 'read_file', confidence: 1, action: 'Read package.json to identify the available build script' }),
    judgeRelevance: async () => { generations++; return { relevant: true } },
  } })
  const worker = attach('a')
  await bridge.onAssistantEvent('a', { kind: 'capabilities', capabilities: [{ id: 'read_file', name: 'Read file', desc: 'Read project files' }] })
  await bridge.onAgentEvent('a', { kind: 'task_start', text: 'Build the application' })
  const hint = worker.messages.find(message => message.type === 'hint').hint
  await bridge.onAssistantEvent('a', { kind: 'hint_applied', hintId: hint.id })
  const applied = bridge.getAssistantLog().filter(entry => entry.kind === 'applied')
  assert.equal(applied.length, 1)
  assert.equal(applied[0].detail, 'Подсказка добавлена в запрос.')
  await bridge.onRunDone('a', 'Built application after reading the package.json build script', { tools: ['read_file'], skills: [] })
  assert.equal(generations, 0, 'no feedback generation after the run')
  bridge.detachAssistants('a')
})

test('disable then re-enable cannot revive a stale advisory response', async () => {
  const result = deferred()
  const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: () => result.promise } })
  const worker = attach('a')
  const pending = bridge.onAssistantEvent('a', { kind: 'navigator' })
  await tick()
  bridge.updateAssistantsSettings({ enabled: false })
  bridge.updateAssistantsSettings({ enabled: true })
  result.resolve({ drift: true, reason: 'old run judgement' })
  await pending
  assert.equal(worker.messages.filter(message => message.type === 'hint').length, 0)
  bridge.detachAssistants('a')
})

test('disabling a single role suppresses its already-running late response', async () => {
  const result = deferred()
  const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: () => result.promise } })
  const worker = attach('a')
  const pending = bridge.onAssistantEvent('a', { kind: 'navigator' })
  await tick()
  bridge.updateAssistantsSettings({ navigatorEnabled: false })
  result.resolve({ drift: true, reason: 'late judgement' })
  await pending
  assert.equal(worker.messages.filter(message => message.type === 'hint').length, 0)
  bridge.detachAssistants('a')
})

test('role and source disable then re-enable cannot revive stale advisory work', async () => {
  for (const setting of ['navigatorEnabled', 'watcherEnabled', 'janitorEnabled', 'memory', 'skills']) {
    const tasks = []
    const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: (...args) => {
      const task = deferred()
      tasks.push({ ...task, signal: args[4] })
      return task.promise
    } } })
    const worker = attach('a')
    const pending = bridge.onAssistantEvent('a', { kind: 'navigator' })
    await tick()
    const patch = enabled => ['memory', 'skills'].includes(setting)
      ? { sources: { memory: true, skills: true, [setting]: enabled } }
      : { [setting]: enabled }
    bridge.updateAssistantsSettings(patch(false))
    bridge.updateAssistantsSettings(patch(true))
    assert.equal(tasks[0].signal.aborted, true, setting)
    tasks[0].resolve({ drift: true, reason: `stale ${setting}` })
    await pending
    assert.equal(worker.messages.filter(message => message.type === 'hint').length, 0, setting)
    const fresh = bridge.onAssistantEvent('a', { kind: 'navigator' })
    await tick()
    assert.equal(tasks[1].signal.aborted, false, setting)
    tasks[1].resolve({ drift: true, reason: `fresh ${setting}` })
    await fresh
    assert.equal(worker.messages.filter(message => message.type === 'hint').length, 1, setting)
    bridge.detachAssistants('a')
  }
})

test('semantic scoring stops after cancellation instead of computing the rest of the catalogue', async () => {
  const controller = new AbortController()
  let calls = 0
  const watcher = load('src/core/agent/watcher.ts', {
    '../memory/globalMemorySettings': { getMemorySettings: () => ({ enabled: false }) },
    '../sidecar/sidecarClient': {}, '../skills/skillManager': {}, '../logger': { log: () => {} },
    '../context/embeddings': {
      getEmbedder: async () => ({ mode: 'neural', dim: 1, embed: async () => {
        calls++
        if (calls === 2) controller.abort()
        return new Float32Array([1])
      } }),
      cosineSimilarity: () => 1,
    },
  })
  const catalogue = Array.from({ length: 488 }, (_, i) => ({ id: String(i), name: `tool${i}`, desc: 'description' }))
  const result = await watcher.scoreCapabilitiesSemantic(catalogue, 'query', controller.signal)
  assert.equal(result.length, 0)
  assert.equal(calls, 2)
})

test('worker cleanup preserves duplicate-hint suppression across successful turns', async () => {
  const { bridge, attach } = bridgeHarness({ llm: {
    judgeDrift: async () => ({ drift: true, reason: 'Check the pending goal before continuing' }),
  } })
  const first = attach('a')
  await bridge.onAssistantEvent('a', { kind: 'navigator' })
  assert.equal(first.messages.filter(message => message.type === 'hint').length, 1)
  first.emit('exit')
  const next = attach('a')
  await bridge.onAssistantEvent('a', { kind: 'navigator' })
  assert.equal(next.messages.filter(message => message.type === 'hint').length, 0)
  bridge.detachAssistants('a')
})

test('janitor burst keeps the queue bounded and releases every timer on shutdown', async () => {
  const { manager, queueTimers } = managerHarness()
  const tasks = Array.from({ length: 24 }, (_, i) => manager.complete(`refine ${i}`, { priority: 'janitor' }).catch(error => error.message))
  await tick()
  assert.equal(manager.inFlight, 1, 'background work reserves the second slot for foreground advice')
  assert.equal(manager.queue.length, 8)
  assert.equal(queueTimers.size, 8)
  manager.shutdown()
  const results = await Promise.all(tasks)
  assert.equal(results.filter(result => /overflow/.test(result)).length, 15)
  assert.equal(queueTimers.size, 0)
  assert.equal(manager.queue.length, 0)
  assert.equal(manager.inFlight, 0)
})

test('a local memory hit uses the one-hint budget before capability inference', async () => {
  let generations = 0
  const { bridge, attach } = bridgeHarness({
    memoryHints: [{ id: 'mem-a', source: 'memory', content: 'Use the existing project setting', score: 0.9 }],
    llm: { judgeCapability: async () => { generations++; return { helpful: false, confidence: 0 } } },
  })
  const worker = attach('memory-ready')
  await bridge.onAssistantEvent('memory-ready', { kind: 'capabilities', capabilities: [{ id: 'read_file', name: 'Read file', desc: 'Read project files' }] })
  await bridge.onAgentEvent('memory-ready', { kind: 'task_start', text: 'project configuration' })
  assert.equal(generations, 0, 'retrieval already supplied the useful hint')
  await bridge.onAgentEvent('memory-ready', { kind: 'task_start', text: 'project configuration' })
  assert.equal(generations, 1, 'a duplicate retrieval permits one capability judgement')
  assert.equal(worker.messages.filter(message => message.type === 'hint' && message.hint.source === 'memory').length, 1)
  bridge.detachAssistants('memory-ready')
})

test('Watcher suggests an exact skill lookup and respects disabled skill sources', async () => {
  let generations = 0
  const { bridge, attach } = bridgeHarness({
    llm: { judgeCapability: async () => { generations++; return { helpful: true, id: 'build-check', confidence: 0.9, action: 'Free-form suggestion.' } } },
  })
  const worker = attach('skills-ready')
  await bridge.onAssistantEvent('skills-ready', { kind: 'capabilities', capabilities: [{ id: 'build-check', kind: 'skill', name: 'build-check', desc: 'Run local build checks' }] })
  await bridge.onAgentEvent('skills-ready', { kind: 'task_start', text: 'build checks' })
  const hints = worker.messages.filter(message => message.type === 'hint')
  assert.equal(hints.length, 1)
  assert.match(hints[0].hint.content, /"build-check" with get_skill/)
  assert.doesNotMatch(hints[0].hint.content, /Free-form/)
  bridge.updateAssistantsSettings({ sources: { memory: true, skills: false } })
  await bridge.onAgentEvent('skills-ready', { kind: 'task_start', text: 'repeat build checks' })
  assert.equal(generations, 1)
  bridge.detachAssistants('skills-ready')
})

test('an empty capability catalogue never wakes the model and still injects local memory', async () => {
  let generations = 0
  const { bridge, attach, counts } = bridgeHarness({
    memoryHints: [{ id: 'mem-b', source: 'memory', content: 'Existing project rule', score: 0.9 }],
    llm: { judgeCapability: async () => { generations++; return { helpful: true, id: 'x', confidence: 1, action: 'Do something concrete right now' } } },
  })
  const worker = attach('empty-catalogue')
  await bridge.onAgentEvent('empty-catalogue', { kind: 'task_start', text: 'project configuration' })
  assert.equal(generations, 0, 'no candidates → judge is never called')
  assert.equal(counts.wake, 0, 'no server wake for an empty catalogue')
  assert.equal(worker.messages.filter(message => message.type === 'hint' && message.hint.source === 'memory').length, 1)
  bridge.detachAssistants('empty-catalogue')
})

test('a long background burst leaves a slot immediately available for interactive advice', async () => {
  const { manager, requests } = managerHarness()
  const backgroundA = manager.complete('distill A', { priority: 'janitor' })
  const backgroundB = manager.complete('distill B', { priority: 'janitor' })
  await tick()
  assert.equal(requests.length, 1)
  const foreground = manager.complete('check current action', { priority: 'watcher' })
  await tick()
  assert.equal(requests.length, 2, 'watcher starts without waiting for either long background response')
  assert.equal(requests[1].prompt, 'check current action')
  requests[0].finish()
  await backgroundA
  await tick()
  assert.equal(requests[2].prompt, 'distill B', 'the queued background role still runs')
  requests[1].finish()
  requests[2].finish()
  await Promise.all([foreground, backgroundB])
  assert.equal(manager.backgroundInFlight, 0)
})

test('a task revision starts a fresh navigator before the cancelled old inference settles', async () => {
  const tasks = []
  const { bridge, attach } = bridgeHarness({ llm: {
    judgeDrift: (...args) => { const task = deferred(); tasks.push({ ...task, signal: args[4] }); return task.promise },
  } })
  const worker = attach('revise-now')
  const old = bridge.onAssistantEvent('revise-now', { kind: 'navigator', objective: 'old goal' })
  await tick()
  await bridge.onAssistantEvent('revise-now', { kind: 'task_revised' })
  const fresh = bridge.onAssistantEvent('revise-now', { kind: 'navigator', objective: 'new goal' })
  await tick()
  assert.equal(tasks.length, 2, 'fresh task must not join the cancelled task promise')
  assert.equal(tasks[0].signal.aborted, true)
  tasks[0].resolve({ drift: true, reason: 'stale old task' })
  await old
  // The old finally must not clear a newer singleflight entry.
  const duplicate = bridge.onAssistantEvent('revise-now', { kind: 'navigator', objective: 'new goal' })
  await tick()
  assert.equal(tasks.length, 2)
  tasks[1].resolve({ drift: true, reason: 'follow the new task instructions' })
  await Promise.all([fresh, duplicate])
  assert.equal(worker.messages.filter(message => message.type === 'hint').length, 1)
  bridge.detachAssistants('revise-now')
})

function llmHarness(outputs) {
  const calls = []
  let fingerprint = 'model-a|cpu|4096'
  let now = 100_000
  const llm = load('src/main/assistants/llmClient.ts', {
    '../localModels/LocalModelManager': { localModels: {
      getInferenceFingerprint: () => fingerprint,
      complete: async (prompt, options) => {
        calls.push({ prompt, options })
        const next = typeof outputs === 'function' ? outputs(calls.length) : outputs.shift()
        return typeof next === 'function' ? next(options) : next
      },
    } },
    '../../core/logger': { log: () => {} },
  }, { Date: class extends Date { static now() { return now } } })
  return { llm, calls, changeModel: value => { fingerprint = value }, advance: ms => { now += ms } }
}

test('unchanged navigator observations reuse validated verdicts; changed action/model/time invokes inference', async () => {
  const { llm, calls, changeModel, advance } = llmHarness(() => '{"drift":false,"violation":false,"reason":"working on the assigned task"}')
  for (let round = 0; round < 8; round++) await llm.judgeDrift('Build project', 'Reading build configuration')
  assert.equal(calls.length, 1, 'eight identical checks use one decode, rather than eight')
  await llm.judgeDrift('Build project', 'Deleting unrelated project files')
  assert.equal(calls.length, 2, 'changed actions must be judged again')
  changeModel('model-b|gpu|8192')
  await llm.judgeDrift('Build project', 'Reading build configuration')
  assert.equal(calls.length, 3)
  advance(30_001)
  await llm.judgeDrift('Build project', 'Reading build configuration')
  assert.equal(calls.length, 4)
})

test('navigator fixture evaluation rejects malformed accusations and absent constraints', async () => {
  const cases = [
    { output: '{"drift":true,"violation":false,"reason":"observed unrelated work","evidence":"Current actions","driftBasis":"Build application"}', goal: 'Build application', rules: [], drift: true, violation: false },
    { output: '{"drift":false,"violation":true,"reason":"observed protected test edits","evidence":"Current actions","constraint":"Do not modify tests"}', goal: 'Build application', rules: ['Do not modify tests'], drift: false, violation: true },
    { output: 'DRIFT: NO\nVIOLATION: YES\nREASON: imagined constraint', goal: 'Build application', rules: [], drift: false, violation: false },
    { output: 'DRIFT: YES\nVIOLATION: NO\nREASON: no goal was provided', goal: '', rules: ['Use pnpm'], drift: false, violation: false },
    { output: 'DRIFT: YES or NO\nVIOLATION: YES or NO\nREASON: echoed format', goal: 'Build application', rules: [], drift: false, violation: false },
    { output: 'DRIFT: YES\nVIOLATION: NO', goal: 'Build application', rules: [], drift: false, violation: false },
  ]
  for (const fixture of cases) {
    const { llm } = llmHarness([fixture.output])
    const actual = await llm.judgeDrift(fixture.goal, 'Current actions', fixture.rules)
    assert.equal(actual.drift, fixture.drift, fixture.output)
    assert.equal(actual.violation, fixture.violation, fixture.output)
  }
  const { llm, calls } = llmHarness([])
  await llm.judgeDrift('', 'Current actions', [])
  assert.equal(calls.length, 0, 'nothing to judge without a goal or constraints')
})

test('capability evaluations accept only available IDs and finite bounded confidence; malformed output is retried', async () => {
  const catalogue = [{ id: 'read_file', name: 'Read file', desc: 'Read project configuration' }]
  const valid = { helpful: true, id: 'read_file', evidence: 'Build app', capabilityEvidence: 'Read project configuration', confidence: 0.9 }
  for (const invalid of [
    { ...valid, id: 'invented_tool' }, { ...valid, confidence: '0.9' },
    { ...valid, confidence: 2 }, { ...valid, evidence: 'invented need' },
  ]) {
    const { llm, calls } = llmHarness([JSON.stringify(invalid), JSON.stringify(valid)])
    assert.equal((await llm.judgeCapability('Build app', catalogue)).helpful, false)
    assert.equal((await llm.judgeCapability('Build app', catalogue)).helpful, true)
    assert.equal(calls.length, 2, 'invalid result must not poison the verdict cache')
    await llm.judgeCapability('Build app', catalogue)
    assert.equal(calls.length, 2)
  }
})

test('cancelled verdicts are never reused and verdict cache remains bounded', async () => {
  const controller = new AbortController()
  const { llm, calls } = llmHarness([
    () => { controller.abort(); return 'DRIFT: YES\nVIOLATION: NO\nREASON: stale cancelled result' },
    '{"drift":false,"violation":false,"reason":"follows the goal"}',
  ])
  assert.equal((await llm.judgeDrift('Build app', 'read config', [], '', controller.signal)).drift, false)
  await llm.judgeDrift('Build app', 'read config')
  assert.equal(calls.length, 2)
  const bounded = llmHarness(() => '{"drift":false,"violation":false,"reason":"follows goal"}')
  for (let index = 0; index < 65; index++) await bounded.llm.judgeDrift(`Goal ${index}`, 'work')
  await bounded.llm.judgeDrift('Goal 0', 'work')
  assert.equal(bounded.calls.length, 66, 'oldest verdict is evicted rather than retaining unlimited state')
})

test('assistant history survives reload with retention/cap bounds and no prompt or hint payloads', async () => {
  const now = Date.now()
  const savedLog = [
    { ts: 1, role: 'watcher', kind: 'trigger', detail: 'expired prompt' },
    { ts: now, role: 'invalid_role', kind: 'trigger', detail: 'invalid' },
    ...Array.from({ length: 520 }, (_, index) => ({ ts: now, role: 'watcher', kind: 'hint_injected', detail: `PRIVATE_RESTORED_HINT_${index}` })),
  ]
  const { bridge, attach, persistedLogs } = bridgeHarness({ savedLog,
    llm: { judgeDrift: async () => ({ drift: true, reason: 'PRIVATE_FRESH_HINT' }) },
  })
  assert.equal(bridge.getAssistantLog().length, 500)
  attach('logged')
  await bridge.onAssistantEvent('logged', { kind: 'navigator' })
  await bridge.onAssistantEvent('logged', { kind: 'briefing', detail: 'PRIVATE_PROJECT_STATE' })
  await bridge.onAssistantEvent('logged', { kind: 'briefing_empty' })
  assert.deepEqual(Array.from(bridge.getAssistantLog().filter(e => e.role === 'briefing'), e => e.kind), ['briefing', 'no_context'])
  bridge.onJanitorAction('logged', 'summarize_stale', 'PRIVATE_TOOL_RESULT', 123)
  bridge.flushAssistantLog()
  const persisted = persistedLogs.at(-1)
  assert.equal(persisted.length, 500)
  assert.equal(persisted.at(-1).tokensSaved, 123)
  assert.equal(JSON.stringify(persisted).includes('PRIVATE_'), false)
  const reloaded = bridgeHarness({ savedLog: persisted })
  assert.equal(reloaded.bridge.getAssistantLog().length, 500)
  bridge.detachAssistants('logged')
})

test('private assistant runs add no durable diagnostic history even when Navigator produces a hint', async () => {
  const { bridge, attach, persistedLogs } = bridgeHarness({
    llm: { judgeDrift: async () => ({ drift: true, reason: 'PRIVATE_CONTEXT' }) },
  })
  attach('private-log', { incognito: true })
  await bridge.onAgentEvent('private-log', { kind: 'task_start', text: 'PRIVATE_PROMPT' })
  await bridge.onAssistantEvent('private-log', { kind: 'navigator' })
  await bridge.onAssistantEvent('private-log', { kind: 'briefing', detail: 'PRIVATE_BRIEFING' })
  bridge.onJanitorAction('private-log', 'summarize_stale', 'PRIVATE_TOOL_RESULT', 42)
  bridge.flushAssistantLog()
  assert.equal(bridge.getAssistantLog().length, 0)
  assert.equal(persistedLogs.at(-1).length, 0)
  bridge.detachAssistants('private-log')
})
