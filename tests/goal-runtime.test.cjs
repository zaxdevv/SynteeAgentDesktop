const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
function load(file, deps = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => name in deps ? deps[name] : require(name), module, module.exports)
  return module.exports
}
const { GoalRuntime } = load('src/core/agent/goalRuntime.ts')
const baseGoal = criteria => ({ id: 'g', chatId: 'c', objective: 'test', criteria, constraints: [], progress: [], evidence: [], status: 'running', steps: 0, maxSteps: 8, createdAt: 1, updatedAt: 1 })
const report = status => JSON.stringify({ goal_report: { status, progress: 'checkpoint', ...(status === 'blocked' ? { blocker: 'User input required' } : {}) } })
test('completion words, unknown criteria and missing reports cannot complete', () => {
  let runtime = new GoalRuntime(baseGoal(['works correctly']), undefined, () => {})
  assert.equal(runtime.checkpoint(report('completed')), 'stop')
  assert.equal(runtime.goal.status, 'unverified')
  runtime = new GoalRuntime(baseGoal([]), undefined, () => {})
  assert.equal(runtime.checkpoint('Done!'), 'continue')
  assert.equal(runtime.checkpoint('Done!'), 'stop')
  assert.equal(runtime.goal.status, 'unverified')
})
test('full numbered file contents verify, partial reads/header text/stale files do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-test-'))
  try {
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'verified')
    const goal = baseGoal(['file_contains:a.txt::verified', 'file_not_contains:a.txt::absent'])
    const runtime = new GoalRuntime(goal, dir, () => {})
    runtime.observe('read_file', { path: 'a.txt' }, true, `[File: ${file} | 1 lines]\n1|verified`, 'read-1', false)
    runtime.checkpoint(report('completed'))
    assert.equal(runtime.goal.status, 'completed')
    assert.equal(runtime.goal.evidence.length, 2)
    const partial = new GoalRuntime(goal, dir, () => {})
    partial.observe('read_file', { path: 'a.txt' }, true, `[File: ${file} | Lines 2-2 of 2]\n2|verified`, 'read-2', false)
    partial.checkpoint(report('completed'))
    assert.equal(partial.goal.status, 'unverified')
    const stale = new GoalRuntime(goal, dir, () => {})
    stale.observe('read_file', { path: 'a.txt' }, true, `[File: ${file} | 1 lines]\n1|verified`, 'read-3', false)
    fs.writeFileSync(file, 'changed contents')
    stale.checkpoint(report('completed'))
    assert.equal(stale.goal.status, 'unverified')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('mutations including failed ones invalidate diagnostics, dry-run cannot prove completion', () => {
  for (const mutationSuccess of [true, false]) {
    const runtime = new GoalRuntime(baseGoal(['diagnostics_passed']), undefined, () => {})
    runtime.observe('get_diagnostics', {}, true, 'No errors found', 'diag', false)
    runtime.observe('edit_file', {}, mutationSuccess, 'partial change', 'edit', false)
    runtime.checkpoint(report('completed'))
    assert.equal(runtime.goal.status, 'unverified')
  }
  for (const [success, output, dryRun] of [[false, 'No errors', false], [true, 'DIAGNOSTICS_UNKNOWN', false], [true, 'Found 2 errors', false], [true, 'No errors found', true]]) {
    const runtime = new GoalRuntime(baseGoal(['diagnostics_passed']), undefined, () => {})
    runtime.observe('get_diagnostics', {}, success, output, 'diag', dryRun)
    runtime.checkpoint(report('completed'))
    assert.equal(runtime.goal.status, 'unverified')
  }
})
test('round/tool/time limits, no-progress and blocked stop are bounded', () => {
  const runtime = new GoalRuntime({ ...baseGoal([]), maxSteps: 2 }, undefined, () => {})
  assert.equal(runtime.beginRound(), undefined)
  assert.equal(runtime.beginRound(), undefined)
  assert.match(runtime.beginRound(), /round budget/)
  for (let i = 0; i < runtime.maxToolCalls; i++) assert.equal(runtime.reserveTool(), true)
  assert.equal(runtime.reserveTool(), false)
  const expired = new GoalRuntime(baseGoal([]), undefined, () => {})
  expired.deadline = Date.now() - 1
  assert.match(expired.beginRound(), /time budget/)
  const stalled = new GoalRuntime(baseGoal([]), undefined, () => {})
  stalled.checkpoint(report('continue')); stalled.checkpoint(report('continue'))
  assert.equal(stalled.goal.status, 'unverified')
  const blocked = new GoalRuntime(baseGoal([]), undefined, () => {})
  blocked.checkpoint(report('blocked'))
  assert.equal(blocked.reserveTool(), false)
  assert.equal(blocked.goal.status, 'blocked')
})
test('getChatGoal is read-only; startup alone recovers running goals', () => {
  let data
  const db = { exec() {}, transaction: fn => fn, prepare(sql) { return {
    get: () => data ? { data } : undefined,
    all: () => sql.includes('FROM chat_goals') && data ? [{ chat_id: 'c', data }] : [],
    run: (_chat, next) => { if (sql.includes('INSERT INTO chat_goals')) data = next },
  } } }
  const api = load('src/core/db/taskSummaries.ts', { './handle': { getDB: () => db }, uuid: { v4: () => 'uuid' }, '../../shared/types/taskSummary': { ensureTaskSummaryStateRow() {} } })
  const first = api.setChatGoal(baseGoal([]))
  const paused = api.setChatGoal({ ...first, status: 'paused' })
  const resumed = api.setChatGoal({ ...paused, status: 'running' })
  assert.ok(paused.updatedAt > first.updatedAt)
  assert.ok(resumed.updatedAt > paused.updatedAt)
  assert.equal(api.getChatGoal('c').status, 'running')
  assert.equal(api.getChatGoal('c').status, 'running')
  api.recoverInterruptedTaskSummaries()
  assert.equal(api.getChatGoal('c').status, 'paused')
})
// Mock only I/O dependencies; execute the real Agent.run control flow.
const empty = new Proxy({}, { get: () => () => {} })
const tools = { TOOL_SCHEMAS: [], runCommand: async () => { throw Error('auto verification bypass') } }
const { Agent } = load('src/core/agent/Agent.ts', {
  '../ai/AIClient': { AIClient: class {} }, '../ai/visionSupport': { agentModelSupportsVision: () => false },
  '../ai/toolImageHistory': { hydrateToolImageContent: m => m.content },
  './nativeImageAnalysis': { NativeImageAnalysis: class { fail() {} respond() {} get size() { return 0 } } },
  './commandSafety': { ...empty, needsApproval: () => ({ block: false, confirm: false }), resolveAutoModeSettings: () => ({}), mergeForbiddenPaths: () => [], isAllowlisted: () => false },
  './injectionGuard': { isScannedTool: () => false, isMutatingTool: () => false },
  '../context/structuredMemory': empty, '../tools': tools,
  '../context/contextManager': { getContextSettings: () => ({}), getModelContextWindow: () => 128000, getHardLimitTokens: () => 120000, getHardLimitTargetTokens: () => 100000 },
  '../tokens/usageTracker': { computeContextSnapshot: () => ({ promptTokens: 0, breakdown: {} }) },
  '../ai/shared': { MAX_TOOL_TIMEOUT_MS: 100 }, '../../shared/modes': empty, '../../shared/subagent-roles': empty,
  '../logger': { log() {} }, './utils': { FALLBACK_SYSTEM_PROMPT: 'test', normalizeToolName: x => x, isSequentialTool: () => true, dropOldestRoundsIfOverflow: x => x },
  './validateArgs': empty, './toolDispatcher': { ToolDispatcher: class { maskSecretValuesInText(text) { return text } } }, jsonrepair: { jsonrepair: x => x },
  '../../shared/toolSettings': { getToolSettings: () => ({}), filterToolSchemas: x => x, isToolDisabled: () => false },
  '../prompts/buildSystemPrompt': { sanitizeToolInstructions: x => x }, './goalRuntime': { GoalRuntime },
})
test('Agent.run continues a no-tool final internally, then stops blocked without a second UI send', async () => {
  const agent = new Agent({ get() {} })
  agent.goal = baseGoal(['works'])
  let calls = 0; let done = 0; const progress = []
  agent.onGoalProgress = goal => progress.push(goal.status)
  agent.client = { chatWithTools: async messages => {
    calls++
    if (calls === 2) assert.ok(messages.some(m => String(m.content).includes('Continue within this run')))
    return { content: report(calls === 1 ? 'continue' : 'blocked'), hadStreamedTokens: true }
  } }
  agent.buildSummaryDetails = () => ({})
  await agent.run('test', { onStep() {}, onDone() { done++ }, onError(error) { throw error } })
  assert.equal(calls, 2); assert.equal(done, 1)
  assert.equal(agent.goal.status, 'blocked')
  assert.ok(progress.includes('running'))
})
test('Agent.run applies goal round limit instead of the main 1024-step ceiling', async () => {
  const agent = new Agent({ get() {} })
  agent.goal = { ...baseGoal([]), maxSteps: 1 }
  let calls = 0
  agent.client = { chatWithTools: async () => { calls++; return { content: report('continue'), hadStreamedTokens: true } } }
  agent.buildSummaryDetails = () => ({})
  await agent.run('test', { onStep() {}, onDone() {}, onError(error) { throw error } })
  assert.equal(calls, 1)
  assert.equal(agent.goal.status, 'limit')
})
test('Agent.run aborts a pending LLM wait and persists paused before done', async () => {
  const agent = new Agent({ get() {} })
  const abort = new AbortController()
  agent.goal = baseGoal([])
  agent.client = { chatWithTools: async () => new Promise(() => {}) }
  agent.buildSummaryDetails = () => ({})
  let statusAtDone
  setTimeout(() => abort.abort(), 10)
  await agent.run('test', { onStep() {}, onDone() { statusAtDone = agent.goal.status }, onError(error) { throw error } }, 8, abort.signal)
  assert.equal(statusAtDone, 'paused')
})
