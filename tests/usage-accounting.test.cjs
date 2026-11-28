/* global require, __dirname, TextEncoder, URL, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- Test production modules with fake providers and a real temporary SQLite ledger. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const Database = require('better-sqlite3')

function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText
  const loaded = { exports: {} }
  vm.runInNewContext(code, { module: loaded, exports: loaded.exports, TextEncoder, URL, setTimeout, clearTimeout,
    require: name => name in dependencies ? dependencies[name] : require(name) })
  return loaded.exports
}
const gateway = [{ id: 'exact-model', inputPrice: 0.001, outputPrice: 0.002 }]
const contextUsage = load('src/shared/contextUsage.ts')
const usage = load('src/core/tokens/usageTracker.ts', {
  './modelCatalog': { getExactCatalogModel: (provider, model) => {
    if (provider !== 'test-provider') return null
    if (model === 'free') return { inputPricePerM: 0, outputPricePerM: 0, hasCompleteTokenPricing: true }
    if (model === 'partial') return { inputPricePerM: 10, outputPricePerM: 0, hasPricing: true }
    return null
  } },
  './gatewayModelsCache': { GATEWAY_PROVIDER_ID: 'syntee-gateway', getGatewayModelsCache: () => gateway },
  '../../shared/data/builtinModels': { BUILTIN_MODELS: [] },
  '../../shared/imageFormat': { IMAGE_TOKEN_COST: 1000 },
  '../../shared/contextUsage': contextUsage,
})
const observer = load('src/core/ai/requestUsage.ts', { '../tokens/usageTracker': usage })
const schema = load('src/core/db/migrations/aiUsage.ts')
const ledger = load('src/main/services/usageLedger.ts', {
  '../../core/db/handle': {}, '../../core/tokens/usageTracker': usage,
  '../../core/ai/requestUsage': observer, '../../core/logger': { log: () => {} },
})

test('unknown cache rates retain ordinary input cost; explicit free cache stays free', () => {
  const price = { inputPerM: 100, outputPerM: 200 }
  assert.equal(usage.calculateUsageCost(price, 1_000_000, 0, 1_000_000), 100)
  assert.equal(usage.calculateUsageCost({ ...price, cacheReadPerM: 0 }, 1_000_000, 0, 1_000_000), 0)
  assert.equal(usage.calculateUsageCost({ ...price, cacheReadPerM: 10, cacheWritePerM: 125 }, 1_000_000, 100_000, 500_000, 200_000), 80)
  assert.equal(usage.calculateUsageCost(price, -1, 1), null)
})

test('gateway never guesses another model tariff and small rates keep their precision', () => {
  assert.equal(usage.getModelPriceInfo('syntee-gateway', 'unknown'), null)
  assert.equal(usage.getModelPriceInfo('syntee-gateway', 'exact-model').inputPerM, 0.1)
  assert.equal(usage.getModelPriceInfo('custom', 'exact', [{ providerId: 'custom', id: 'exact', inputPrice: 0.001, outputPrice: 2 }]).inputPerM, 0.1)
  assert.equal(usage.getModelPriceInfo('another', 'exact', [{ providerId: 'custom', id: 'exact', inputPrice: 1, outputPrice: 2 }]), null)
  assert.equal(usage.getModelPriceInfo('test-provider', 'free').inputPerM, 0)
  assert.equal(usage.getModelPriceInfo('test-provider', 'partial'), null)
})

async function* packets(values) { for (const value of values) yield value }
const identity = { providerId: 'custom', modelId: 'test', pricing: { inputPerM: 100, outputPerM: 200 } }

test('dated mini models use their own tariff and unknown variants stay unpriced', () => {
  const { getModelPrice } = load('src/core/tokens/ModelPricing.ts')
  assert.equal(getModelPrice('openai/gpt-4o-mini-2024-07-18').inputPerM, 15)
  assert.equal(getModelPrice('gpt-4.1-mini-2025-04-14').inputPerM, 40)
  assert.equal(getModelPrice('not-gpt-4o'), null)
  assert.equal(getModelPrice('gpt-4o-other-vendor-special'), null)
})

test('accepted OpenAI stream is visible before final usage or forced worker termination', async () => {
  const events = []
  observer.setAIUsageSink(event => events.push(event))
  const stream = await observer.observeAIRequest(() => Promise.resolve(packets([
    { choices: [], usage: { prompt_tokens: 100_000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 50_000 } } },
  ])), identity, { chatId: 'chat' })
  assert.equal(events.length, 1)
  assert.equal(events[0].complete, false)
  assert.equal(events[0].inputTokens, undefined)
  for await (const unused of stream) void unused
  const last = events.at(-1)
  assert.equal(last.complete, true)
  assert.equal(last.finished, true)
  assert.equal(last.cacheReadTokens, 50_000)
  assert.equal(new Set(events.map(event => event.requestId)).size, 1)
  observer.setAIUsageSink(null)
})

test('Responses incomplete and non-stream auxiliary calls retain provider usage', async () => {
  const events = []
  observer.setAIUsageSink(event => events.push(event))
  const stream = await observer.observeAIRequest(() => Promise.resolve(packets([
    { type: 'response.incomplete', response: { usage: { input_tokens: 40, output_tokens: 6, input_tokens_details: { cached_tokens: 20 } } } },
  ])), identity, { chatId: 'r' }, 'responses')
  for await (const unused of stream) void unused
  assert.equal(events.at(-1).inputTokens, 40)
  assert.equal(events.at(-1).outputTokens, 6)
  assert.equal(events.at(-1).complete, true)
  await observer.observeAIRequest(() => Promise.resolve({ usage: { prompt_tokens: 20, completion_tokens: 5 } }), identity, { chatId: 'aux', source: 'memory' })
  assert.equal(events.at(-1).source, 'memory')
  assert.equal(events.at(-1).outputTokens, 5)
  observer.setAIUsageSink(null)
})

test('sparse usage packets retain both token counts and cache writes', async () => {
  const events = []
  observer.setAIUsageSink(event => events.push(event))
  try {
    const stream = await observer.observeAIRequest(() => Promise.resolve(packets([
      { usage: { prompt_tokens: 1_000, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 } } },
      { usage: { completion_tokens: 50 } },
    ])), identity)
    for await (const unused of stream) void unused
    const result = events.at(-1)
    assert.equal(result.inputTokens, 1_000)
    assert.equal(result.outputTokens, 50)
    assert.equal(result.cacheReadTokens, 100)
    assert.equal(result.cacheWriteTokens, 200)
    assert.equal(result.complete, true)
  } finally { observer.setAIUsageSink(null) }
})

test('an interrupted compatible stream cannot settle from an early partial usage packet', async () => {
  const events = []
  observer.setAIUsageSink(event => events.push(event))
  try {
    const stream = await observer.observeAIRequest(() => Promise.resolve((async function* () {
      yield { usage: { prompt_tokens: 100, completion_tokens: 0 } }
      throw new Error('connection lost before final usage')
    })()), identity)
    await assert.rejects(async () => { for await (const unused of stream) void unused }, /connection lost/)
    assert.equal(events.at(-1).inputTokens, 100)
    assert.equal(events.at(-1).complete, false)
    assert.equal(events.at(-1).finished, true)
  } finally { observer.setAIUsageSink(null) }
})

test('reported amounts settle once per request, even without token counts or a tariff', async () => {
  const db = new Database(':memory:')
  schema.runAIUsageSchema(db)
  observer.setAIUsageSink(usage => ledger.recordAIUsage(usage, db))
  try {
    const request = () => Promise.resolve(packets([
      { type: 'response.completed', response: { usage: { cost: 0.0235 } } },
    ]))
    const stream = await observer.observeAIRequest(request,
      { ...identity, providerId: 'openrouter', reportsUsdCost: true, pricing: null }, { chatId: 'chat' }, 'responses')
    for await (const unused of stream) void unused
    const result = ledger.getChatCost('chat', db)
    assert.equal(result.sessionRequests, 1)
    assert.equal(result.sessionReportedRequests, 1)
    assert.equal(result.sessionUnpricedRequests, 0)
    assert.equal(result.lastRequestCostReported, true)
    assert.equal(result.sessionCostCents, 2.35)
    const customStream = await observer.observeAIRequest(request,
      { ...identity, pricing: null }, { chatId: 'custom-chat' }, 'responses')
    for await (const unused of customStream) void unused
    assert.equal(ledger.getChatCost('custom-chat', db).sessionCostCents, null)
    assert.equal(ledger.getChatCost('custom-chat', db).sessionUnpricedRequests, 1)
  } finally { observer.setAIUsageSink(null); db.close() }
})

test('Anthropic input/cache/output cumulative packets normalize once and survive interruption', async () => {
  const events = []
  observer.setAIUsageSink(event => events.push(event))
  const stream = await observer.observeAIRequest(() => Promise.resolve(packets([
    { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } } },
    { type: 'message_delta', usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ])), identity, { chatId: 'anthropic' }, 'anthropic')
  for await (const unused of stream) void unused
  assert.equal(events.at(-1).inputTokens, 350)
  assert.equal(events.at(-1).cacheReadTokens, 200)
  assert.equal(events.at(-1).outputTokens, 30)
  assert.equal(events.at(-1).complete, true)
  const interrupted = await observer.observeAIRequest(() => Promise.resolve((async function* () {
    yield { type: 'message_start', message: { usage: { input_tokens: 50 } } }
    throw new Error('socket closed')
  })()), identity, { chatId: 'anthropic' }, 'anthropic')
  await assert.rejects(async () => { for await (const unused of interrupted) void unused }, /socket closed/)
  assert.equal(events.at(-1).inputTokens, 50)
  assert.equal(events.at(-1).complete, false)
  observer.setAIUsageSink(null)
})

test('async usage contexts isolate concurrent main/background chats', async () => {
  const events = []
  observer.setAIUsageSink(event => events.push(event))
  await Promise.all(['chat-a', 'chat-b'].map(chatId => observer.withAIUsageContext({ chatId }, async () => {
    await Promise.resolve()
    return observer.observeAIRequest(() => Promise.resolve({ usage: { prompt_tokens: 10, completion_tokens: 1 } }), identity)
  })))
  assert.deepEqual(events.map(event => event.chatId).sort(), ['chat-a', 'chat-b'])
  observer.setAIUsageSink(null)
})

function event(overrides = {}) {
  return { ...identity, requestId: 'request-1', chatId: 'chat', source: 'main', timestamp: 1000,
    inputTokens: 100_000, outputTokens: 1000, cacheReadTokens: 50_000, complete: true, finished: true, ...overrides }
}

test('SQLite ledger deduplicates cumulative packets and persists main/subagent/background totals', () => {
  const db = new Database(':memory:')
  schema.runAIUsageSchema(db)
  try {
    ledger.recordAIUsage(event({ complete: false, finished: false, outputTokens: undefined }), db)
    assert.equal(ledger.getChatCost('chat', db).sessionUnpricedRequests, 1)
    ledger.recordAIUsage(event(), db)
    ledger.recordAIUsage(event(), db)
    ledger.recordAIUsage(event({ requestId: 'subagent', modelId: 'other-model', source: 'subagent', timestamp: 2000 }), db)
    ledger.recordAIUsage(event({ requestId: 'memory', source: 'memory', timestamp: 3000 }), db)
    const result = ledger.getChatCost('chat', db)
    assert.equal(result.sessionRequests, 3)
    assert.equal(result.sessionUnpricedRequests, 0)
    assert.ok(Math.abs(result.sessionCostCents - 30.6) < 1e-10)
    assert.equal(result.lastRequestCostCents, 10.2)
    assert.equal(result.accountingStartedAt, 1000)
    // A reloaded service/worker reads the DB rather than a process-local map.
    const reloaded = load('src/main/services/usageLedger.ts', {
      '../../core/db/handle': {}, '../../core/tokens/usageTracker': usage,
      '../../core/ai/requestUsage': observer, '../../core/logger': { log: () => {} },
    })
    assert.equal(reloaded.getChatCost('chat', db).sessionCostCents, result.sessionCostCents)
    ledger.recordAIUsage(event({ outputTokens: 9999 }), db)
    assert.equal(ledger.getChatCost('chat', db).lastRequestCostCents, 10.2)
    assert.equal(ledger.getChatCost('chat', db).sessionCostCents, result.sessionCostCents)
    ledger.recordAIUsage(event({ complete: false, outputTokens: undefined }), db)
    assert.equal(ledger.getChatCost('chat', db).sessionUnpricedRequests, 0)
  } finally { db.close() }
})

test('missing usage/tariffs remain visibly unpriced and detail retention preserves lifetime totals', () => {
  const db = new Database(':memory:')
  schema.runAIUsageSchema(db)
  try {
    ledger.recordAIUsage(event({ inputTokens: undefined, outputTokens: undefined, complete: false }), db)
    assert.equal(ledger.getChatCost('chat', db).sessionCostCents, null)
    ledger.recordAIUsage(event({ requestId: 'no-tariff', pricing: null }), db)
    assert.equal(ledger.getChatCost('chat', db).sessionUnpricedRequests, 2)
    for (let i = 0; i < 2005; i++) ledger.recordAIUsage(event({ requestId: `r${i}`, timestamp: 2000 + i }), db)
    const summary = ledger.getChatCost('chat', db)
    assert.equal(summary.sessionRequests, 2007)
    assert.equal(summary.sessionUnpricedRequests, 2)
    assert.ok(Math.abs(summary.sessionCostCents - 2005 * 10.2) < 1e-6)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage_requests WHERE chat_id = ?').get('chat').n, 2000)
  } finally { db.close() }
})

test('existing usage databases retain totals and treat legacy prices as estimates', () => {
  const db = new Database(':memory:')
  try {
    schema.runAIUsageSchema(db)
    ledger.recordAIUsage(event(), db)
    // Remove the new fields to represent an installed database from the prior build.
    db.exec(`ALTER TABLE ai_usage_requests DROP COLUMN cost_reported;
      ALTER TABLE ai_usage_totals DROP COLUMN last_cost_reported;
      ALTER TABLE ai_usage_totals DROP COLUMN reported_requests;`)
    schema.runAIUsageSchema(db)
    schema.runAIUsageSchema(db)
    const legacy = ledger.getChatCost('chat', db)
    assert.equal(legacy.sessionCostCents, 10.2)
    assert.equal(legacy.sessionReportedRequests, 0)
    assert.equal(legacy.lastRequestCostReported, false)
    ledger.recordAIUsage(event({ requestId: 'reported', reportedCostCents: 2, timestamp: 2000 }), db)
    const mixed = ledger.getChatCost('chat', db)
    assert.equal(mixed.sessionRequests, 2)
    assert.equal(mixed.sessionCostCents, 12.2)
    assert.equal(mixed.sessionReportedRequests, 1)
    assert.equal(mixed.lastRequestCostReported, true)
  } finally { db.close() }
})

test('AIClient SDK boundary counts complete, plugin tools, empty-stream fallback and embedding usage without paid calls', async () => {
  const queued = []
  const calls = []
  class FakeSDK {
    constructor(options) {
      this.baseURL = options.baseURL
      const resource = () => ({ create: async params => {
        calls.push(params)
        assert.ok(queued.length, 'unexpected extra API request')
        const response = queued.shift()
        if (response instanceof Error) throw response
        return response
      } })
      this.chat = { completions: resource() }
      this.responses = resource()
      this.embeddings = resource()
    }
  }
  const { AIClient, setCodexTokenRefresher } = load('src/core/ai/AIClient.ts', {
    openai: FakeSDK, '@anthropic-ai/sdk': FakeSDK,
    worker_threads: { isMainThread: false, workerData: { codexToken: 'expired-fixture', codexAccountId: 'fixture-account' } },
    '../../shared/reasoningModels': { buildReasoningParams: () => ({}), responsesReasoningParam: () => ({}) },
    '../tokens/gatewayModelsCache': { getGatewayModelsCache: () => [] },
    '../tokens/modelCatalog': { getCatalogModel: () => null },
    '../../shared/roundRobin': { getNextApiKey: providers => ({ key: 'fixture', updatedProviders: providers }) },
    '../../shared/constants': { getIdentityHeaders: () => ({}), getOpencodeZenHeaders: () => ({}), isOpencodeProvider: () => false },
    './anthropicConverters': { isAnthropicProvider: () => false },
    './shared': { log: () => {}, sleep: async () => {}, backoffDelay: () => 0, OVERALL_TIMEOUT_MS: 1000, DEFAULT_TEMPERATURE: 0.3, DEFAULT_MAX_TOKENS: 1024, extractReasoningText: value => value },
    './anthropicNative': {},
    './toolImageMessages': { routeToolImagesToUser: messages => messages, summarizeImagePayload: () => ({ images: 0 }) },
    './toolCallHistory': { repairToolCallHistory: messages => messages },
    '../tokens/usageTracker': usage, './mediaSupport': {}, './requestUsage': observer,
  })
  const values = {
    providers: [{ id: 'fixture', enabled: true, baseUrl: 'http://fixture.invalid' }],
    modelAssignments: [{ role: 'main', providerId: 'fixture', modelId: 'fixture-model' }],
    customModels: [{ id: 'fixture-model', providerId: 'fixture', inputPrice: 1, outputPrice: 2 }],
  }
  const store = { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value } }
  const client = new AIClient(store, { chatId: 'fixture-chat' })
  const events = []
  observer.setAIUsageSink(value => events.push(value))
  try {
    queued.push({ choices: [{ message: { content: 'plain' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } })
    assert.equal(await client.complete([{ role: 'user', content: 'hello' }], 'main'), 'plain')
    assert.equal(events.at(-1).pricing.inputPerM, 100)
    assert.equal(events.at(-1).chatId, 'fixture-chat')

    queued.push(packets([{ choices: [], usage: { prompt_tokens: 30, completion_tokens: 0 } }]))
    queued.push({ choices: [{ message: { content: 'fallback' } }], usage: { prompt_tokens: 30, completion_tokens: 3 } })
    let text = ''
    await client.streamChat([{ role: 'user', content: 'hello' }], { onToken: token => { text += token }, onDone: () => {}, onError: error => { throw error } })
    assert.equal(text, 'fallback')

    queued.push({ choices: [{ message: { tool_calls: [{ id: 't1', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } }] } }], usage: { prompt_tokens: 40, completion_tokens: 4 } })
    queued.push({ choices: [{ message: { content: 'tool-result' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } })
    assert.equal(await client.completeWithTools([{ role: 'user', content: 'hello' }], [], async () => 'tool output'), 'tool-result')

    queued.push({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 7, total_tokens: 7 } })
    assert.deepEqual(await client.embed('fixture'), [0.1, 0.2])
    assert.equal(events.at(-1).outputTokens, 0)
    assert.equal(events.at(-1).complete, true)
    assert.equal(new Set(events.map(value => value.requestId)).size, 6)
    assert.equal(calls.length, 6)
    assert.equal(queued.length, 0)

    // Codex's first HTTP request returns 401; only the accepted request after
    // token refresh must enter the ledger, through the newly created SDK.
    values.providers = [{ id: 'fixture-codex', type: 'openai-codex', enabled: true, baseUrl: 'http://fixture.invalid' }]
    values.modelAssignments = [{ role: 'main', providerId: 'fixture-codex', modelId: 'fixture-model' }]
    values.customModels = [{ id: 'fixture-model', providerId: 'fixture-codex', inputPrice: 1, outputPrice: 2 }]
    let refreshes = 0
    setCodexTokenRefresher(async () => { refreshes++; return 'refreshed-fixture' })
    const beforeRefreshEvents = events.length
    queued.push(Object.assign(new Error('fixture session expired'), { status: 401 }))
    queued.push(packets([
      { type: 'response.output_text.delta', delta: 'refreshed answer' },
      { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 500 } } } },
    ]))
    assert.equal((await client.chatWithTools([{ role: 'user', content: 'hello' }], [])).content, 'refreshed answer')
    assert.equal(refreshes, 1)
    assert.equal(calls.length, 8)
    const refreshedEvents = events.slice(beforeRefreshEvents)
    assert.equal(new Set(refreshedEvents.map(value => value.requestId)).size, 1, 'successful refreshed SDK request must be observed once')
    const final = refreshedEvents.at(-1)
    assert.equal(final.complete, true)
    assert.equal(final.providerId, 'fixture-codex')
    assert.equal(final.modelId, 'fixture-model')
    assert.equal(final.chatId, 'fixture-chat')
    assert.equal(final.cacheReadTokens, 500)
    const db = new Database(':memory:')
    schema.runAIUsageSchema(db)
    try {
      for (const event of refreshedEvents) ledger.recordAIUsage(event, db)
      const total = ledger.getChatCost('fixture-chat', db)
      assert.equal(total.sessionRequests, 1)
      assert.equal(total.sessionUnpricedRequests, 0)
      assert.equal(total.sessionCostCents, 0.104)
    } finally { db.close() }

    values.modelAssignments = [{ role: 'main', providerId: 'fixture', modelId: 'fixture-model' }]
    for (const [baseUrl, expected] of [
      ['https://openrouter.ai/api/v1', 2.5],
      ['https://openrouter.ai.fixture.invalid/api/v1', undefined],
      ['http://openrouter.ai/api/v1', undefined],
    ]) {
      values.providers = [{ id: 'fixture', enabled: true, baseUrl }]
      queued.push({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0.025 } })
      await client.complete([{ role: 'user', content: 'Hello' }], 'main')
      assert.equal(events.at(-1).reportedCostCents, expected)
    }
  } finally { observer.setAIUsageSink(null) }
})
