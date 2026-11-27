/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise Agent.run and persistence with an isolated provider. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

function load(file, deps = {}, fallback) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => name in deps ? deps[name] : fallback && name.startsWith('.') ? fallback : require(name), module, module.exports)
  return module.exports
}
function anyStub() {
  return new Proxy(function () {}, {
    get: (_, key) => key === 'then' || key === Symbol.toPrimitive ? undefined : anyStub(),
    apply: () => undefined, construct: () => ({}),
  })
}
const assistants = load('src/shared/assistants.ts')
// estimateTokensCalibrated — та же шкала, что у кольца контекста (в тестах
// калибровки нет, поэтому совпадает с estimateTokens).
const tokens = {
  estimateTokens: text => Math.ceil(text.length / 4),
  estimateTokensCalibrated: text => Math.ceil(text.length / 4),
  computeRequestContextSnapshot: (messages, maxTokens = 128000) => {
    const estimated = messages.reduce((n, message) => n + Math.ceil((typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).length / 4), 0)
    return { estimated, pct: Math.round(estimated / maxTokens * 100), maxTokens, breakdown: {} }
  },
}
const janitorModule = load('src/core/context/janitor.ts', { '../tokens/usageTracker': tokens, '../../shared/assistants': assistants })
const state = load('src/core/context/assistantState.ts')
const constitution = load('src/core/context/constitution.ts', { '../../shared/assistants': assistants })
const { Agent } = load('src/core/agent/Agent.ts', {
  './deferredMcpTools': load('src/core/agent/deferredMcpTools.ts'),
  '../ai/AIClient': { AIClient: class {} },
  '../ai/visionSupport': { agentModelSupportsVision: () => false },
  '../ai/toolImageHistory': { hydrateHistoryContents: history => history.map(message => message.content) },
  './nativeImageAnalysis': { NativeImageAnalysis: class { fail() {} respond() {} } },
  '../context/janitor': janitorModule, '../context/assistantState': state, '../context/constitution': constitution,
  '../../shared/assistants': assistants,
  '../tokens/usageTracker': tokens,
  '../tools': { TOOL_SCHEMAS: [] },
  '../context/contextManager': { getContextSettings: () => ({}), getModelContextWindow: () => 128000, getHardLimitTokens: () => 120000, getHardLimitTargetTokens: () => 100000 },
  '../logger': { log() {} },
  './utils': { FALLBACK_SYSTEM_PROMPT: 'test' },
  './toolDispatcher': { ToolDispatcher: class { maskSecretValuesInText(text) { return text } } },
  '../../shared/toolSettings': { getToolSettings: () => ({}), filterToolSchemas: schemas => schemas, isToolDisabled: () => false },
  '../prompts/buildSystemPrompt': {
    sanitizeToolInstructions: text => text,
    // Реальный сплиттер: без него Agent не соберёт сообщения (§prompt-cache).
    splitSystemPromptForCache: p => ({ staticPart: p || '', dynamicPart: '' }),
  },
  './goalEvaluator': {
    formatTranscript: messages => messages.map(message => `${message.role}: ${message.content ?? ''}`).join('\n'),
    makeGoalJudge: () => async () => 'met',
  },
  '../context/hintBudget': {
    consumeHintBudget: (hints = []) => ({
      selected: hints.map(hint => ({ hint, text: hint.content, message: `[hint] ${hint.content}` })),
      remaining: [],
    }),
    MAX_PENDING_HINTS: 10,
  },
}, anyStub())

test('new Agent.run worker restores persisted summaries before its first provider request, with recall available when minis are disabled', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-agent-restart-'))
  try {
    const original = 'REA unique result\n' + 'middle facts '.repeat(600) + '\nterminal detail'
    const history = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'analysis-1', type: 'function', function: { name: 'mcp__rea__analysis', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'analysis-1', name: 'mcp__rea__analysis', content: original },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tail-1', type: 'function', function: { name: 'update_todo', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tail-1', name: 'update_todo', content: 'ok' },
    ]
    const first = new Agent({ get() {} })
    first.chatId = 'restart'; first.userDataPath = temp; first.persistAssistantState = true
    first.setAssistantsSettings({ ...assistants.DEFAULT_ASSISTANTS_SETTINGS, janitorTailSteps: 1 })
    const report = first.janitor.scan(history, 8)
    const applied = first.janitor.apply(history, report)
    first.persistStateNow()
    const second = new Agent({ get() {} })
    second.chatId = 'restart'; second.userDataPath = temp; second.persistAssistantState = true
    second.setAssistantsSettings({ ...assistants.DEFAULT_ASSISTANTS_SETTINGS, enabled: false })
    second.buildSummaryDetails = () => ({})
    let requests = 0
    second.client = { chatWithTools: async (messages, schemas) => {
      requests++
      assert.equal(messages.find(message => message.tool_call_id === 'analysis-1').content, applied[1].content)
      assert.ok(schemas.some(schema => schema.function.name === 'recall_context'))
      return { content: 'done', hadStreamedTokens: true }
    } }
    let done
    await second.run('continue', { onStep() {}, onDone: answer => { done = answer }, onError: error => { throw error } }, 8, undefined, 'test', history)
    assert.equal(requests, 1)
    assert.equal(done, 'done')
    const result = await second.executeTool('recall_context', { archive_id: report.actions[0].archiveId, offset: original.length - 15, limit: 100 })
    assert.equal(result.success, true)
    assert.ok(result.output.endsWith(original.slice(-15)))
  } finally {
    const file = path.join(temp, 'assistants-state', 'restart.json')
    if (fs.existsSync(file)) fs.unlinkSync(file)
    const directory = path.join(temp, 'assistants-state')
    if (fs.existsSync(directory)) fs.rmdirSync(directory)
    fs.rmdirSync(temp)
  }
})

test('injected hints report hint_applied and archivist runs on an ordinary successful finish', async () => {
  const agent = new Agent({ get() {} })
  agent.chatId = 'run-hooks'
  agent.setAssistantsSettings({ ...assistants.DEFAULT_ASSISTANTS_SETTINGS })
  agent.buildSummaryDetails = () => ({})
  const events = []
  agent.onAssistantEvent = event => events.push(event)
  agent.pushHint({ id: 'nav-1', source: 'navigator', content: 'Возвращайся к цели: проверь тесты', score: 1 })
  agent.client = { chatWithTools: async () => ({ content: 'done', hadStreamedTokens: true }) }
  const steps = []
  let done
  await agent.run('finish the task', {
    onStep: step => steps.push(step),
    onDone: answer => { done = answer },
    onError: error => { throw error },
  }, 8, undefined, 'test', [])
  assert.equal(done, 'done')
  const applied = events.filter(event => event.kind === 'hint_applied')
  assert.deepEqual(applied.map(event => event.hintId), ['nav-1'], 'real prompt insertion is reported for feedback weights')
  assert.equal(agent.navigatorLastUsefulStep, 0, 'navigator knows the round its hint actually landed in')
  const archivist = events.filter(event => event.kind === 'archivist')
  assert.equal(archivist.length, 1, 'ordinary successful finish still distills the final transcript')
  assert.match(archivist[0].transcript, /finish the task/)
})

test('archivist is emitted for a successfully completed goal as well', async () => {
  const agent = new Agent({ get() {} })
  agent.chatId = 'goal-hooks'
  agent.setAssistantsSettings({ ...assistants.DEFAULT_ASSISTANTS_SETTINGS })
  const events = []
  agent.onAssistantEvent = event => events.push(event)
  const messages = [{ role: 'user', content: 'goal task' }, { role: 'assistant', content: 'all checks pass' }]
  agent.emitArchivist(messages, new Set(['src/a.ts']))
  const archivist = events.filter(event => event.kind === 'archivist')
  assert.equal(archivist.length, 1)
  assert.deepEqual(archivist[0].modifiedFiles, ['src/a.ts'])
  assert.match(archivist[0].transcript, /all checks pass/)
  // Выключенная роль — тишина.
  agent.setAssistantsSettings({ ...assistants.DEFAULT_ASSISTANTS_SETTINGS, archivistEnabled: false })
  agent.emitArchivist(messages, new Set())
  assert.equal(events.filter(event => event.kind === 'archivist').length, 1)
})

test('pressure compacts the first provider request, preserves a one-round tail, and reports request savings', async () => {
  const original = 'same search evidence '.repeat(12000)
  const history = [1, 2].flatMap(id => [
    { role: 'assistant', content: '', tool_calls: [{ id: `pressure-${id}`, type: 'function', function: { name: 'search_code', arguments: '{"pattern":"same"}' } }] },
    { role: 'tool', content: original, tool_call_id: `pressure-${id}`, name: 'search_code' },
  ])
  const agent = new Agent({ get() {} })
  agent.setAssistantsSettings({ ...assistants.DEFAULT_ASSISTANTS_SETTINGS, janitorTailSteps: 1 })
  agent.buildSummaryDetails = () => ({})
  const steps = []
  const contextUpdates = []
  let sent
  agent.client = { chatWithTools: async messages => {
    sent = messages.map(message => ({ ...message }))
    assert.ok(messages.find(message => message.tool_call_id === 'pressure-1').content.includes(assistants.JANITOR_MARKER))
    assert.equal(messages.find(message => message.tool_call_id === 'pressure-2').content, original)
    return { content: 'done', hadStreamedTokens: true }
  } }
  await agent.run('continue', {
    onStep: step => steps.push(step), onContextUpdate: update => contextUpdates.push(update), onDone() {}, onError: error => { throw error },
  }, 8, undefined, 'test', history)
  const compact = steps.find(step => step.type === 'janitor')
  assert.ok(compact, 'pressure bypasses the interval even on the first round')
  const retained = sent.find(message => message.tool_call_id === 'pressure-1').content
  assert.equal(compact.janitorTokensSaved, tokens.estimateTokens(original) - tokens.estimateTokens(retained))
  assert.equal(compact.janitorActions[0].kind, 'dedup_tool_call')
  assert.equal(agent.janitor.getArchiveSize(), 0)
  assert.ok(contextUpdates.some(update => update.promptTokens === tokens.computeRequestContextSnapshot(sent).estimated))
})

test('history conversion carries failure, diff and visual protection through Agent.run', async () => {
  const { messageToContextMessages } = load('src/main/ipc/chatContextHelpers.ts', {
    '../../shared/attachmentMarkdown': { stripAttachTokens: text => text }, '../../shared/steer': { STEER_MARKER: '[steer]' },
  })
  for (const extra of [{ success: false }, { success: true, diff: '+ source' }, { success: true, imagePaths: ['image.png'] }, { success: true, visualAnalysis: { status: 'responded' } }]) {
    const row = {
      id: 'row', role: 'assistant', content: '', toolSteps: [
        { type: 'tool_call', callId: 'protected', toolName: 'example', toolArgs: {} },
        { type: 'tool_result', callId: 'protected', toolName: 'example', content: 'important result', ...extra },
      ],
    }
    const history = messageToContextMessages(row)
    assert.equal(history.find(message => message.role === 'tool').janitorProtected, true)
    const agent = new Agent({ get() {} })
    agent.setAssistantsSettings({ ...assistants.DEFAULT_ASSISTANTS_SETTINGS, enabled: false })
    agent.buildSummaryDetails = () => ({})
    agent.client = { chatWithTools: async messages => {
      assert.equal(messages.find(message => message.tool_call_id === 'protected').janitorProtected, true)
      return { content: 'done', hadStreamedTokens: true }
    } }
    await agent.run('continue', { onStep() {}, onDone() {}, onError: error => { throw error } }, 8, undefined, 'test', history)
  }
})
