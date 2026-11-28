/* global require, __dirname, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, process, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production Agent loop with mocked providers. */
// §orchestration — функциональная интеграция РЕАЛЬНОГО цикла Agent.run()
// с фазовым автоматом: провайдер замокан, все внешние модули — заглушки.
//
// Проверяем именно поведение рана, а не текст исходников:
//  1) планировщик отвечает сам на read-only вопрос → исполнитель не вызывается;
//  2) план → исполнение → ревью approve → в ответ уходит работа исполнителя,
//     а промежуточные ответы фаз НЕ стримятся в answer;
//  3) явный блокер исполнителя уводит ран в replanning, затем работа доводится.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const IDENTITY = value => value

/** Транспиляция «чистого» модуля проекта (orchestration.ts импортирует только типы). */
function loadTsModule(relPath) {
  const file = path.join(__dirname, '..', relPath)
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: file,
  })
  const mod = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    mod.exports, require, mod, file, path.dirname(file),
  )
  return mod.exports
}

function loadAgent(stubs) {
  const file = path.join(__dirname, '..', 'src/core/agent/Agent.ts')
  const module = { exports: {} }
  const source = fs.readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file,
  })
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : require(name),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    process, Buffer, Promise, Date, Math, JSON, Map, Set, Number, String, Array, Object, RegExp, Error,
  }, { filename: file })
  return module.exports
}

const EMPTY_SETTINGS = {
  enabled: false, navigatorEnabled: false, watcherEnabled: false, janitorEnabled: false,
  hintBudgetTokens: 0, hintCooldownRounds: 0, orchestratorEnabled: false,
}

const RESPONSE = content => ({ content, tool_calls: [], hadStreamedTokens: false })

function harness(responses, options = {}) {
  const calls = []
  const steps = []
  const approvalModes = []
  const confirmations = []
  const executedTools = []
  const persistedLogs = []
  let done = null
  const error = null
  const AIClient = class {
    constructor() {}
    async chatWithTools(messages, schemas, signal, role, onToken, _onCtx, _onRate, _onRetry, onUsage, _onThink, _onThinkDone, _onToolStart, phaseModelOverride) {
      calls.push({ messages: messages.slice(), schemas, phaseModelOverride })
      const next = responses.shift()
      if (!next) throw new Error('unexpected provider call #' + calls.length)
      if (typeof next === 'function') return next(messages)
      return typeof next === 'string' ? RESPONSE(next) : next
    }
    async complete() { return 'judged' }
  }
  const { Agent } = loadAgent({
    './toolSchedule': loadTsModule('src/core/agent/toolSchedule.ts'),
    './mcpResultPages': loadTsModule('src/core/agent/mcpResultPages.ts'),
    './deferredMcpTools': loadTsModule('src/core/agent/deferredMcpTools.ts'),
    './orchestration': loadTsModule('src/core/agent/orchestration.ts'),
    '../ai/AIClient': { AIClient },
    '../ai/visionSupport': { agentModelSupportsVision: () => false },
    '../ai/toolImageHistory': { hydrateHistoryContents: () => [] },
    '../ai/shared': { MAX_TOOL_TIMEOUT_MS: 1000 },
    '../../shared/imageFormat': { ImageRequestBudget: class { accept() {} } },
    '../../shared/steer': { STEER_MARKER: '[[steer]]' },
    '../../shared/finalAnswer': {
      isFinalAnswerToolName: () => false,
      takeFinalAnswerToolCalls: calls => ({ calls, removed: 0, text: '' }),
    },
    '../../shared/assistants': { DEFAULT_ASSISTANTS_SETTINGS: EMPTY_SETTINGS },
    '../../shared/subagent-roles': { getSubagentRole: () => undefined },
    '../../shared/toolSettings': {
      filterToolSchemas: schemas => schemas,
      getToolSettings: () => ({}),
      isToolDisabled: () => false,
    },
    './nativeImageAnalysis': { NativeImageAnalysis: class { fail() {} respond() {} } },
    './commandSafety': {
      needsApproval: (_name, _args, mode) => {
        approvalModes.push(mode)
        return { confirm: mode === 'ask', block: false, level: 'safe' }
      },
      resolveAutoModeSettings: () => options.autoSettings ?? ({}), mergeForbiddenPaths: () => [],
      isAllowlisted: () => false, isSecretPath: () => false,
      maskSecretValues: IDENTITY, actionAllowlistKey: () => '',
    },
    './injectionGuard': {
      scanForInjection: () => ({ suspicious: false }), wrapUntrustedContent: IDENTITY,
      isMutatingTool: () => false, isScannedTool: () => false, isWebSourceTool: () => false,
      INJECTION_ESCALATION_STEPS: [],
    },
    './utils': {
      FALLBACK_SYSTEM_PROMPT: 'system', VERIFICATION_INTERVAL: 5,
      normalizeToolName: name => name, findMissingRequiredArgs: () => [],
      formatMissingArgsMessage: () => '', getToolErrorHint: () => '',
      buildToolFingerprint: (name, args) => ({ toolName: name, argsKey: JSON.stringify(args ?? {}) }),
      dropOldestRoundsIfOverflow: messages => messages,
      extractMcpServerName: () => null, imagePayloadInfos: () => [],
      tryRepairJson: raw => ({ fixed: false, repaired: raw, fixes: [] }),
      salvageEditFileArgs: () => null,
    },
    './validateArgs': { validateAndCoerceArgs: options.validateArgs ?? ((_name, args) => ({ fixes: [], errors: [], args })) },
    './toolDispatcher': {
      ToolDispatcher: class {
        resetForRun() { this.fileMap = new Map() }
        canAdvanceRead() { return false }
        acknowledgeRead() {}
        async executeTool(name) { executedTools.push(name); return { success: true, output: 'ok' } }
        maskSecretValuesInText(text) { return text }
        buildSummaryDetails() { return {} }
        getFileCacheUpdates() { return {} }
        getFileSnapshots() { return {} }
      },
    },
    './goalRuntime': { GoalRuntime: class {} },
    './goalEvaluator': { formatTranscript: () => '', makeGoalJudge: () => () => 'done' },
    'jsonrepair': { jsonrepair: raw => raw },
    '../context/structuredMemory': { updateStructuredMemory: () => '' },
    '../context/contextManager': {
      truncateToolResult: IDENTITY,
      getContextSettings: () => ({ diffJournalEnabled: false, diffJournalLines: 0, fileMapEnabled: false }),
      getModelContextWindow: () => 128000,
      getHardLimitTokens: () => 1000000,
      getHardLimitTargetTokens: () => 500000,
    },
    '../context/janitor': {
      Janitor: class {
        getArchiveEntries() { return [] }
        apply(messages) { return messages }
        updateSettings() {}
        recall() { return '' }
        hydrateArchive() {}
        restoreSummaries() {}
        getArchiveSize() { return 0 }
        shouldScan() { return false }
        scan() { return null }
        recallPage() { return '' }
      },
    },
    '../context/assistantState': {
      loadAssistantState: () => ({}), saveAssistantState: () => {}, ASSISTANT_STATE_VERSION: 1,
    },
    '../context/constitution': {
      Constitution: class {
        list() { return [] }
        serialize() { return '' }
        hydrate() {}
        addExplicit() { return [] }
      },
    },
    '../context/hintBudget': { consumeHintBudget: () => ({ selected: [], remaining: [] }), MAX_PENDING_HINTS: 10 },
    '../skills/skillManager': { getSkillManager: () => ({}) },
    '../tokens/usageTracker': { computeRequestContextSnapshot: () => ({ estimated: 0, breakdown: {} }) },
    '../prompts/buildSystemPrompt': {
      sanitizeToolInstructions: IDENTITY,
      splitSystemPromptForCache: text => ({ staticPart: text, dynamicPart: '' }),
    },
    '../codeMode': { executeCode: options.executeCode ?? (async () => ({ success: true, output: '' })), EphemeralArtifactStore: class {} },
    '../tools': { runCommand: async () => ({ success: true, output: '' }), TOOL_SCHEMAS: [] },
    '../logger': { log: (...args) => persistedLogs.push(args) },
  })
  const store = { get: key => options.store?.[key], set: () => {}, delete: () => {}, has: () => false }
  const agent = new Agent(store, options.role ?? 'main')
  agent.projectId = options.projectId
  const callbacks = {
    ...(options.mcpRequiresApproval ? { onMcpRequiresApproval: options.mcpRequiresApproval } : {}),
    approvalMode: options.approvalMode,
    onConfirm: async name => { confirmations.push(name); return false },
    onStep: step => steps.push(step),
    onDone: (answer, details) => { done = { answer, details } },
    onError: err => { throw err },
  }
  return {
    calls, steps, agent, approvalModes, confirmations, executedTools, persistedLogs,
    get done() { return done },
    get error() { return error },
    answers: () => steps.filter(s => s.type === 'answer').map(s => s.content),
    run: (userMessage, runOptions) => agent.run(userMessage, callbacks, 8, undefined, 'system prompt', [], options.schemas ?? [], runOptions),
  }
}

const mcpSchemas = () => Array.from({ length: 24 }, (_, i) => ({
  type: 'function', function: {
    name: `mcp__test__operation${i}`, description: `Workspace operation ${i}`,
    parameters: { type: 'object', required: ['workspace_id'], properties: { workspace_id: { type: 'string' } } },
  },
}))
const toolResponse = (id, name, args = {}) => ({ ...RESPONSE(''), tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

test('MCP discovery activates exact native schemas next round, leaves hidden native calls blocked, and preserves validation', async () => {
  const schemas = mcpSchemas()
  const name = schemas[7].function.name
  const validations = []
  const h = harness([
    toolResponse('hidden', name, { workspace_id: 'w' }),
    toolResponse('load', 'discover_mcp_tools', { tool_names: [name] }),
    toolResponse('missing', name),
    toolResponse('valid', name, { workspace_id: 'w' }),
    'done',
  ], {
    schemas,
    validateArgs: (tool, args, allowed) => {
      const schema = allowed.find(schema => schema.function.name === tool)
      if (tool === name) validations.push(schema)
      return { fixes: [], args, errors: schema?.function.parameters?.required?.some(key => args[key] === undefined) ? ['workspace_id is required'] : [] }
    },
  })
  await h.run('use connected workspace')
  assert.deepEqual(h.calls[0].schemas.map(schema => schema.function.name), ['discover_mcp_tools'])
  assert.equal(h.calls[1].schemas.length, 1, 'failed hidden call did not activate itself')
  assert.equal(h.calls[2].schemas[1], schemas[7], 'exact registered schema reaches native provider request')
  assert.equal(h.calls[4].schemas[1], schemas[7], 'selected schema remains stable')
  assert.equal(h.calls[2].schemas.length, 2)
  assert.ok(h.steps.some(step => step.callId === 'hidden' && step.success === false))
  assert.ok(h.steps.some(step => step.callId === 'missing' && step.success === false))
  assert.deepEqual(h.executedTools, [name])
  assert.equal(validations[0], undefined, 'unadvertised tool was not validated against a model-provided definition')
  assert.equal(validations.at(-1), schemas[7])
})

test('MCP discovery does not call MCP or remove per-tool approval requirements', async () => {
  const schemas = mcpSchemas()
  const name = schemas[3].function.name
  const h = harness([
    toolResponse('load', 'discover_mcp_tools', { tool_names: [name] }),
    toolResponse('call', name, { workspace_id: 'w' }),
    'done',
  ], { schemas, mcpRequiresApproval: () => true })
  await h.run('use connected workspace')
  assert.deepEqual(h.confirmations, [name], 'metadata search is local; selected MCP execution still asks')
  assert.deepEqual(h.executedTools, [], 'rejected MCP call never executes')
})

test('Code Mode can discover and call permitted hidden MCP with original schema checks, without making native calls eager', async () => {
  const schemas = mcpSchemas()
  const name = schemas[13].function.name
  const nested = []
  const h = harness([toolResponse('code', 'execute_code', { code: 'test' }), 'done'], {
    schemas: [{ type: 'function', function: { name: 'execute_code' } }, ...schemas],
    executeCode: async ({ callTool }) => {
      const signal = new AbortController().signal
      nested.push(await callTool('discover_mcp_tools', { query: 'operation13' }, signal))
      nested.push(await callTool(name, { workspace_id: 'w' }, signal))
      nested.push(await callTool('mcp__forbidden__delete', {}, signal))
      return { success: true, output: JSON.stringify(nested) }
    },
    validateArgs: (tool, args, allowed) => {
      if (tool === name) assert.equal(allowed.find(schema => schema.function.name === name), schemas[13])
      return { fixes: [], errors: [], args }
    },
  })
  await h.run('use connected workspace')
  assert.deepEqual(h.calls[0].schemas.map(schema => schema.function.name), ['execute_code', 'discover_mcp_tools'])
  assert.equal(nested[0].success, true)
  assert.equal(nested[1].success, true)
  assert.equal(nested[2].success, false)
  assert.deepEqual(h.executedTools, [name])
  assert.equal(h.calls[1].schemas.length, 2, 'search did not load native tools')
})

test('Code Mode read-only policy still blocks permitted hidden MCP side effects', async () => {
  const schemas = mcpSchemas()
  let nested
  const h = harness([toolResponse('code', 'execute_code', { code: 'test' }), 'done'], {
    schemas: [{ type: 'function', function: { name: 'execute_code' } }, ...schemas],
    autoSettings: { codeModePolicy: 'read-only' },
    executeCode: async ({ callTool }) => {
      nested = await callTool(schemas[0].function.name, { workspace_id: 'w' }, new AbortController().signal)
      return { success: true, output: JSON.stringify(nested) }
    },
  })
  await h.run('inspect connected workspace')
  assert.equal(nested.success, false)
  assert.deepEqual(h.executedTools, [])
})

test('MCP discovery eager fallback and phase restrictions preserve existing capabilities', async () => {
  const schemas = mcpSchemas()
  const eager = harness(['done'], { schemas })
  await eager.run('use MCP', { deferredMcpTools: false })
  assert.deepEqual(eager.calls[0].schemas.map(schema => schema.function.name), schemas.map(schema => schema.function.name))
  const phases = harness([
    toolResponse('load-forbidden', 'discover_mcp_tools', { tool_names: [schemas[0].function.name] }),
    '<answer/> done',
  ], { schemas })
  await phases.run('research only', { orchestration: {
    planner: { providerId: 'p', model: 'planner' }, executor: { providerId: 'p', model: 'executor' },
  } })
  assert.equal(phases.calls[0].schemas.length, 0)
  assert.ok(phases.steps.some(step => step.callId === 'load-forbidden' && step.success === false))
  assert.deepEqual(phases.executedTools, [])
})

test('invalid tool arguments never persist raw user text in parser/repair logs', async () => {
  const secret = 'PRIVATE_CREDENTIAL_98765'
  const response = toolResponse('invalid', 'read_file')
  response.tool_calls[0].function.arguments = `{"path":"${secret}",broken}`
  const h = harness([response, 'done'], { schemas: [{ type: 'function', function: { name: 'read_file' } }] })
  await h.run('inspect')
  assert.equal(JSON.stringify(h.persistedLogs).includes(secret), false)
  assert.ok(h.persistedLogs.some(args => String(args[0]).includes('JSON.parse tool arguments failed')))
})

test('subagent uses the same project → global approval precedence as its parent', async () => {
  const schema = { type: 'function', function: { name: 'read_file' } }
  for (const [approvalMode, projectMode, expected] of [
    ['auto', 'full', 'full'], ['full', 'ask', 'ask'], ['full', undefined, 'full'],
  ]) {
    for (const role of ['main', 'subagent']) {
      const h = harness([
        { ...RESPONSE(''), tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
        'done',
      ], {
        role, projectId: 'project', approvalMode, schemas: [schema],
        store: { projectPermissions: { project: { approvalMode: projectMode } } },
      })
      await h.run('read config')
      assert.deepEqual(h.approvalModes, [expected], `${role}: ${approvalMode} / ${projectMode}`)
      assert.deepEqual(h.confirmations, expected === 'ask' ? ['read_file'] : [])
      assert.deepEqual(h.executedTools, expected === 'ask' ? [] : ['read_file'])
    }
  }
})

const RUN = {
  planner: { providerId: 'openai', modelId: 'gpt-5-plan' },
  executor: { providerId: 'anthropic', modelId: 'claude-exec' },
  reviewer: { providerId: 'openai', modelId: 'gpt-5-review' },
}

test('agent/orchestration: планировщик отвечает сам — исполнитель не вызывается', async () => {
  const h = harness(['Ответ: код в src/core/agent/Agent.ts.\n<answer/>'])
  await h.run('где лежит цикл агента?', { orchestration: RUN })

  assert.equal(h.calls.length, 1, 'исполнитель не должен вызываться на read-only вопрос')
  assert.equal(h.calls[0].phaseModelOverride.modelId, 'gpt-5-plan')
  // Ровно один answer — реальный ответ планировщика, без служебного тега.
  assert.deepEqual(h.answers(), ['Ответ: код в src/core/agent/Agent.ts.'])
  assert.equal(h.done.answer, 'Ответ: код в src/core/agent/Agent.ts.')
})

test('agent/orchestration: plan → executing → reviewing approve, промежуточные ответы не стримятся', async () => {
  const h = harness([
    '1. поправить parser.ts',
    'Готово: parser.ts обновлён, тесты прошли.',
    '<review verdict="approve">ок</review>',
  ])
  await h.run('поправь парсер', { orchestration: RUN })

  assert.equal(h.calls.length, 3)
  assert.deepEqual(
    h.calls.map(c => c.phaseModelOverride.modelId),
    ['gpt-5-plan', 'claude-exec', 'gpt-5-review'],
  )
  // Единственный answer — работа исполнителя (не план и не вердикт).
  assert.deepEqual(h.answers(), ['Готово: parser.ts обновлён, тесты прошли.'])
  assert.equal(h.done.answer, 'Готово: parser.ts обновлён, тесты прошли.')
})

test('agent/orchestration: блокер исполнителя уводит ран в replanning, затем работа доводится', async () => {
  const h = harness([
    '1. прочитать конфиг',
    'Не могу: файл конфига недоступен.\n<blocker>файл конфига недоступен</blocker>',
    '1. спросить путь у пользователя, затем прочитать конфиг',
    'Готово: конфиг прочитан через путь по умолчанию.',
    '<review verdict="approve">ок</review>',
  ])
  await h.run('обнови конфиг', { orchestration: RUN })

  assert.equal(h.calls.length, 5)
  assert.deepEqual(
    h.calls.map(c => c.phaseModelOverride.modelId),
    ['gpt-5-plan', 'claude-exec', 'gpt-5-plan', 'claude-exec', 'gpt-5-review'],
  )
  assert.deepEqual(h.answers(), ['Готово: конфиг прочитан через путь по умолчанию.'])
  assert.equal(h.done.answer, 'Готово: конфиг прочитан через путь по умолчанию.')
})
test('a write and verification read in one provider turn record the snapshot before the read', async () => {
  const h = harness([{
    ...RESPONSE(''),
    tool_calls: [
      ...toolResponse('edit', 'write_file', { path: 'entry.ts', content: 'new' }).tool_calls,
      ...toolResponse('check', 'read_file', { path: 'entry.ts' }).tool_calls,
    ],
  }, 'done'], { schemas: ['write_file', 'read_file'].map(name => ({ type: 'function', function: { name } })) })
  let content = 'old'
  const snapshots = []
  h.agent.onFileSnapshot = snapshot => snapshots.push(snapshot.contentBefore)
  h.agent.toolDispatcher.executeTool = async name => {
    if (name === 'write_file') {
      const originalContent = content
      content = 'new'
      return { success: true, output: 'ok', originalContent }
    }
    return { success: true, output: JSON.stringify([content, snapshots.slice()]) }
  }
  await h.run('write and verify')
  const tools = h.calls[1].messages.filter(message => message.role === 'tool')
  assert.deepEqual(Array.from(tools, tool => tool.tool_call_id), ['edit', 'check'])
  assert.deepEqual(JSON.parse(tools[1].content), ['new', ['old']])
})

test('large MCP output is paged after redaction, including the persisted UI step; search does not rerun MCP', async t => {
  const secret = 'example-fixture-secret'
  const needle = 'unique function at 0x9900'
  const line = 'address=0x1100 | size=64 | name=framework_function | confidence=high\n'
  const raw = ('g'.repeat(1395) + secret + line.repeat(3000)).slice(0, 179850)
    + (needle + ' secret=' + secret).padEnd(150, '.')
  const idFrom = messages => JSON.parse(messages.find(m => m.tool_call_id === 'original').content).result_id
  const h = harness([
    toolResponse('original', 'mcp__test__scan', {}),
    messages => toolResponse('find', 'read_mcp_result', { result_id: idFrom(messages), query: needle, limit: 250 }),
    messages => toolResponse('boundary', 'read_mcp_result', { result_id: idFrom(messages), offset: 1395, limit: 40 }),
    'done',
  ], { schemas: [{ type: 'function', function: { name: 'mcp__test__scan' } }] })
  let remote = 0
  h.agent.toolDispatcher.executeTool = async () => { remote++; return { success: true, output: raw } }
  h.agent.toolDispatcher.maskSecretValuesInText = value => value.replaceAll(secret, '[MASKED]')
  await h.run('locate one record')
  assert.equal(raw.length, 180000)
  assert.equal(remote, 1)
  assert.deepEqual(h.calls[0].schemas.map(s => s.function.name), ['mcp__test__scan'])
  assert.equal(h.calls[1].schemas.at(-1).function.name, 'read_mcp_result')
  const first = h.calls[1].messages.find(m => m.tool_call_id === 'original').content
  const match = h.calls[2].messages.find(m => m.tool_call_id === 'find').content
  const page = h.calls[3].messages.find(m => m.tool_call_id === 'boundary').content
  assert.equal(h.steps.find(s => s.callId === 'original' && s.type === 'tool_result').content, first)
  assert.ok(first.length < 2000 && match.length < 550)
  assert.ok(!first.includes('examp'), 'secret crossing preview boundary masked before slicing')
  assert.ok(JSON.parse(page).text.startsWith('[MASKED]'))
  assert.ok(JSON.parse(match).text.includes(needle + ' secret=[MASKED]'))
  assert.equal(JSON.parse(match).source, 'untrusted MCP data')
  assert.equal(JSON.parse(page).source, JSON.parse(first).source)
  t.diagnostic('MCP fixture chars: raw=' + raw.length + ' preview=' + first.length + ' search=' + match.length + ' remote=' + remote)
})

test('MCP pages enforce run isolation, memory limits, continuation and search bounds', () => {
  const { McpResultPages } = loadTsModule('src/core/agent/mcpResultPages.ts')
  const pages = new McpResultPages()
  assert.equal(pages.preview('short', true), undefined)
  const data = 'abcdef'.repeat(1001)
  const first = JSON.parse(pages.preview(data, false, 'check input'))
  assert.equal(first.status, 'error')
  assert.equal(first.error, 'check input')
  assert.equal(new McpResultPages().read({ result_id: first.result_id }).success, false)
  let assembled = first.preview, offset = first.next_offset
  do {
    const page = JSON.parse(pages.read({ result_id: first.result_id, offset }).output)
    assembled += page.text
    offset = page.next_offset
  } while (offset !== undefined)
  assert.equal(assembled, data)
  for (const args of [{ offset: -1 }, { limit: 0 }, { query: '' }, { offset: 8000 }])
    assert.equal(pages.read({ result_id: first.result_id, ...args }).success, false)
  const oversized = JSON.parse(pages.preview('a'.repeat(4 * 1024 * 1024 + 1), true))
  assert.equal(oversized.retained_chars, oversized.chars - 1)
  assert.equal(pages.read({ result_id: first.result_id }).success, false)
  assert.equal(JSON.parse(pages.read({ result_id: oversized.result_id, query: 'z' }).output).searched_until, oversized.retained_chars)
})

test('persisted MCP pages survive a worker restart, isolate chats and follow deletions', t => {
  const { DatabaseSync } = require('node:sqlite')
  const { McpResultPages } = loadTsModule('src/core/agent/mcpResultPages.ts')
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'syntee-pages-'))
  const db = new DatabaseSync(path.join(root, 'syntee.db'))
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  loadTsModule('src/core/db/migrations/initialSchema.ts').runInitialSchema(db)
  db.exec("INSERT INTO chats(id,created_at,updated_at,is_incognito) VALUES ('a',0,0,0),('b',0,0,0),('p',0,0,1)")
  const pages = (chatId, messageId = 'm') => new McpResultPages({ userDataPath: root, chatId, messageId })
  const data = 'header'.repeat(1001) + 'tail fact'
  const id = JSON.parse(pages('a').preview(data, true)).result_id
  assert.match(pages('a','next').read({ result_id: id, query: 'tail fact' }).output, /tail fact/)
  assert.equal(pages('b').read({ result_id: id }).success, false)
  const privateId = JSON.parse(pages('p').preview(data, true)).result_id
  assert.equal(pages('p').read({ result_id: privateId }).success, false)
  db.exec("INSERT INTO messages(id,chat_id,role,content,created_at) VALUES ('m','a','assistant','',0); DELETE FROM messages WHERE id='m'")
  assert.equal(pages('a').read({ result_id: id }).success, false)
  pages('a','second').preview(data, true)
  db.exec("DELETE FROM chats WHERE id='a'")
  assert.equal(db.prepare('SELECT count(*) n FROM mcp_result_cache').get().n, 0)
})
