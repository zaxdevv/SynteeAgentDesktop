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
      return typeof next === 'string' ? RESPONSE(next) : next
    }
    async complete() { return 'judged' }
  }
  const { Agent } = loadAgent({
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
      isSequentialTool: () => false,
      buildToolFingerprint: (name, args) => ({ toolName: name, argsKey: JSON.stringify(args ?? {}) }),
      dropOldestRoundsIfOverflow: messages => messages,
      extractMcpServerName: () => null, imagePayloadInfos: () => [],
      tryRepairJson: raw => ({ fixed: false, repaired: raw, fixes: [] }),
      salvageEditFileArgs: () => null,
    },
    './validateArgs': { validateAndCoerceArgs: options.validateArgs ?? ((_name, args) => ({ fixes: [], errors: [], args })) },
    './toolDispatcher': {
      ToolDispatcher: class {
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
