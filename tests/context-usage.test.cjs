/* global require, __dirname, TextEncoder, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production token accounting with isolated dependencies. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports, TextEncoder, setTimeout, clearTimeout,
    require: name => (name in dependencies ? dependencies[name] : require(name)),
    ...globals,
  })
  return module.exports
}

const contract = load('src/shared/contextUsage.ts')
const usage = load('src/core/tokens/usageTracker.ts', {
  './modelCatalog': {}, './gatewayModelsCache': {}, '../../shared/data/builtinModels': {},
  '../../shared/imageFormat': { IMAGE_TOKEN_COST: 1000 }, './ModelPricing': {},
  '../../shared/contextUsage': contract,
})

test('one set of thresholds: 60% warn, 85% critical, and pct is a single formula', () => {
  assert.equal(contract.contextPct(0, 1000), 0)
  assert.equal(contract.contextPct(500, 1000), 50)
  assert.equal(contract.contextPct(2000, 1000), 100, 'pct never exceeds 100')
  assert.equal(contract.contextPct(10, 0), 0, 'a zero window cannot divide by zero')
  assert.equal(contract.contextStatus(59), 'ok')
  assert.equal(contract.contextStatus(60), 'warn')
  assert.equal(contract.contextStatus(84), 'warn')
  assert.equal(contract.contextStatus(85), 'critical')
  // Snapshot path and payload path must agree — раньше main считал 60/85, а
  // renderer 80/95, и кольцо с панелью показывали разное состояние.
  const snapshot = usage.buildSnapshotFromReal({ promptTokens: 850, completionTokens: 1 }, 1000)
  assert.equal(snapshot.status, 'critical')
  const payload = contract.buildContextUsagePayload({ chatId: 'c', snapshot, source: 'real' })
  assert.equal(payload.status, 'critical')
  assert.equal(payload.pct, 85)
})

test('every emitted payload carries chatId and recomputes pct instead of trusting the caller', () => {
  const payload = contract.buildContextUsagePayload({
    chatId: 'chat-1',
    snapshot: { estimated: 250, limit: 1000, breakdown: { history: 250, system: 0, tools: 0, current: 0 } },
    source: 'estimate',
    scope: 'request',
    pct: 99, // приходит «снаружи» — должен быть пересчитан
    status: 'critical',
  })
  assert.equal(payload.chatId, 'chat-1', 'renderer filters by chatId; without it foreign chats leak in')
  assert.equal(payload.pct, 25)
  assert.equal(payload.status, 'ok')
  assert.equal(payload.source, 'estimate')
  assert.equal(payload.scope, 'request')
})

test('reasoning_content in history is not billed by the provider, thinking_blocks are', () => {
  const thinking = 'думаю '.repeat(200)
  const plain = usage.estimateMessagesTokensFull([{ role: 'assistant', content: 'ok' }])
  // reasoning_content отправляется (LiteLLM-прокси иначе отдаёт 400), но
  // провайдер его в prompt_tokens НЕ считает — замерено на живых чатах:
  // оценка была 368k против real 207k, и вся разница — 191k reasoning.
  const withEcho = usage.estimateMessagesTokensFull([{ role: 'assistant', content: 'ok', reasoning_content: thinking }])
  assert.equal(withEcho, plain, 'reasoning_content must not inflate the estimate')
  // Нативные Anthropic thinking blocks — часть входа, их считаем.
  const withBlocks = usage.estimateMessagesTokensFull([{
    role: 'assistant', content: 'ok', thinking_blocks: [{ thinking, signature: 'sig' }],
  }])
  assert.ok(withBlocks > plain, 'thinking_blocks are part of the billed prompt')
  // Оба поля одновременно — reasoning_content не добавляет ничего сверху.
  const both = usage.estimateMessagesTokensFull([{
    role: 'assistant', content: 'ok', reasoning_content: thinking, thinking_blocks: [{ thinking, signature: 'sig' }],
  }])
  assert.equal(both, withBlocks, 'no double counting when both fields are present')
})

test('calibration learns from provider truth and the next estimate uses it', () => {
  usage.setCalibrationModel('prov', 'model-x')
  const messages = [{ role: 'user', content: 'Проверка токенизации русского текста. '.repeat(50) }]
  const before = usage.computeContextSnapshot(messages, 200_000, { systemPrompt: 'system' }).estimated
  const actual = Math.round(before / 2)
  for (let i = 0; i < 12; i++) {
    const request = usage.computeContextSnapshot(messages, 200_000, { systemPrompt: 'system' })
    assert.equal(request.calibrationBaseTokens, before)
    usage.recordEstimateCalibration(request.calibrationBaseTokens, actual)
  }
  const after = usage.computeContextSnapshot(messages, 200_000, { systemPrompt: 'system' }).estimated
  assert.ok(Math.abs(after - actual) <= 2, `estimate must converge to provider usage (${after} vs ${actual})`)
  assert.ok(usage.estimateCalibrationFactor() < 1)
  // Другая модель — свой коэффициент, оценки не смешиваются.
  usage.setCalibrationModel('prov', 'model-y')
  assert.equal(usage.estimateCalibrationFactor(), 1)
})

test('calibration ignores outliers instead of chasing them', () => {
  usage.setCalibrationModel('prov', 'model-z')
  usage.recordEstimateCalibration(1000, 5)      // мусор: в 200 раз меньше
  usage.recordEstimateCalibration(1000, 200_000) // мусор: в 200 раз больше
  assert.equal(usage.estimateCalibrationFactor(), 1)
})

test('calibration state is exportable and restorable (main → store → worker)', () => {
  usage.setCalibrationModel('prov', 'model-w')
  for (let i = 0; i < 12; i++) usage.recordEstimateCalibration(1000, 600)
  const exported = usage.exportCalibration()
  assert.ok(Object.keys(exported).length > 0)
  // Ключ включает эпоху семантики оценки — старые коэффициенты несовместимы
  // с новой формулой и не должны применяться.
  const key = usage.calibrationKey('prov', 'model-w')
  assert.ok(key.endsWith('prov:model-w'))
  assert.ok(exported[key] < 1)
  usage.importCalibration({ [usage.calibrationKey('prov', 'fresh')]: 0.7 })
  usage.setCalibrationModel('prov', 'fresh')
  assert.equal(usage.estimateCalibrationFactor(), 0.7)
  // Старый (до-эпоховый) ключ игнорируется: иначе занизил бы контекст.
  usage.importCalibration({ 'prov:model-w': 0.2 })
  usage.setCalibrationModel('prov', 'model-w')
  assert.ok(usage.estimateCalibrationFactor() > 0.5)
})

test('janitor savings are reported in the calibrated scale of the context ring', () => {
  usage.setCalibrationModel('savings', 'model')
  const big = 'lorem ipsum dolor sit amet '.repeat(400)
  const summary = '[janitor] короткое резюме'
  const rawSaved = usage.estimateTokens(big) - usage.estimateTokens(summary)
  assert.ok(rawSaved > 0)
  for (let i = 0; i < 14; i++) usage.recordEstimateCalibration(1000, 500)
  const factor = usage.estimateCalibrationFactor()
  assert.ok(factor < 0.9, 'calibration must have moved')
  const calibratedSaved = usage.estimateTokensCalibrated(big) - usage.estimateTokensCalibrated(summary)
  assert.ok(calibratedSaved < rawSaved, `economy must shrink with the factor (${rawSaved} → ${calibratedSaved})`)
})

test('estimating and reconciling a same-request partition counts every input token once', () => {
  const estimate = usage.computeRequestContextSnapshot([
    { role: 'system', content: 'Follow the current task.' },
    { role: 'user', content: 'Read the file.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't', content: 'The actual file output. '.repeat(200) },
  ], 1_048_576, [{ type: 'function', function: { name: 'read_file' } }], 'uncalibrated')
  const inputParts = ({ history, system, tools, current, toolResults, protocol }) =>
    history + system + tools + current + (toolResults ?? 0) + (protocol ?? 0)
  assert.equal(estimate.estimated, inputParts(estimate.breakdown))
  assert.ok(estimate.breakdown.toolResults > 400)
  assert.ok(estimate.breakdown.history < 100)
  const real = usage.buildSnapshotFromReal({
    promptTokens: 387, completionTokens: 41, cacheReadTokens: 190, cacheWriteTokens: 19,
  }, 1_048_576, estimate.breakdown)
  assert.equal(real.estimated, 387)
  assert.equal(inputParts(real.breakdown), 387, 'cache and completion are informational subsets/separate counts')
  assert.ok(real.breakdown.toolResults > real.breakdown.history)
  assert.equal(real.breakdown.cacheReadTokens, 190)
  const missingEstimate = usage.buildSnapshotFromReal({ promptTokens: 200, completionTokens: 15 }, 128_000)
  assert.equal(missingEstimate.breakdown.history, 0, 'provider total alone cannot identify history usage')
})

test('per-provider context limits do not mix same-model IDs across assignments or phases', () => {
  const { getModelContextWindow } = load('src/core/context/contextManager.ts', {
    '../tokens/usageTracker': usage,
    '../tokens/modelCatalog': { getCatalogModel: () => null },
    '../tokens/ModelContextLimits': { getContextLimit: () => 128_000 },
    '../../shared/data/builtinModels': { BUILTIN_MODELS: [] },
    '../../shared/constants': { DEFAULT_SETTINGS: { mainModel: 'legacy-default' } },
    '../tokens/gatewayModelsCache': {
      GATEWAY_PROVIDER_ID: 'syntee-gateway',
      getGatewayModelsCache: () => [{ id: 'routed', contextWindow: 1_048_576 }],
    },
  })
  const store = {
    modelAssignments: [{ role: 'main', modelId: 'routed', providerId: 'syntee-gateway' }],
    customModels: [{ id: 'routed', providerId: 'custom', contextWindow: 32_000 }],
  }
  assert.equal(getModelContextWindow(store), 1_048_576)
  assert.equal(getModelContextWindow(store, 'main', { modelId: 'routed', providerId: 'custom' }), 32_000)
})
