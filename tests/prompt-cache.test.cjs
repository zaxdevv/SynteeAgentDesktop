/* global require, __dirname, TextEncoder, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- Test production modules with stubs and real provider usage shapes. */
/**
 * §prompt-cache — регрессии экономии на prompt caching.
 *
 * Покрывает четыре вещи, которые вместе определяют, попадает ли промпт в кеш
 * провайдера:
 *   1. Сплит system prompt: статика в system, динамический хвост — отдельным
 *      сообщением ПЕРЕД текущей репликой (иначе префикс рвётся каждый ход).
 *   2. Разбор кеш-полей usage у разных провайдеров (OpenAI, DeepSeek, Anthropic
 *      через gateway, прочие совместимые).
 *   3. Anthropic-конвертер: legacy-маркер, отсутствие маркера, якорь на
 *      сообщении.
 *   4. Source-guard: Agent двигает якорь каждый раунд, AIClient снимает
 *      служебный cacheAnchor перед OpenAI-запросом, gateway возвращает
 *      prompt_tokens_details.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText
  const loaded = { exports: {} }
  vm.runInNewContext(code, { module: loaded, exports: loaded.exports, TextEncoder, setTimeout, clearTimeout, process,
    require: name => name in dependencies ? dependencies[name] : require(name) })
  return loaded.exports
}

function readSource(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
}

// ─── stubs ──────────────────────────────────────────────────────────────────
const empty = () => ''
const mapGuidance = load('src/shared/codeNavigationGuidance.ts')
const { buildCodeModeBlock } = load('src/core/prompts/sections/codeModeSection.ts', {
  '../../../shared/codeNavigationGuidance': mapGuidance,
})
const { buildProjectMapBlock } = load('src/core/prompts/sections/projectMapSection.ts')
const builder = load('src/core/prompts/buildSystemPrompt.ts', {
  './sections': {
    buildCodeModeBlock,
    buildSkillsBlock: empty,
    buildOneShotSkillBlock: empty,
    buildPluginsBlock: empty,
    buildInstallPathsBlock: empty,
    buildMemoryStatsBlock: () => '## Memory\nstats-body',
    buildGraphStatsBlock: empty,
    buildProjectMapBlock,
    buildSecretsBlock: empty,
    buildPlanningInjection: empty,
    buildAskInjection: empty,
  },
  '../../shared/toolSettings': { isToolDisabled: () => false },
})
const SYSTEM_PROMPT_CACHE_BREAK = builder.SYSTEM_PROMPT_CACHE_BREAK
const converters = load('src/core/ai/anthropicConverters.ts', {
  '../prompts/buildSystemPrompt': { SYSTEM_PROMPT_CACHE_BREAK },
})
const usageTracker = load('src/core/tokens/usageTracker.ts', {
  './modelCatalog': { getCatalogModel: () => null },
  './gatewayModelsCache': { GATEWAY_PROVIDER_ID: 'syntee-gateway', getGatewayModelsCache: () => [] },
  '../../shared/data/builtinModels': { BUILTIN_MODELS: [] },
  '../../shared/imageFormat': { IMAGE_TOKEN_COST: 1000 },
  './ModelPricing': { getModelPrice: () => null },
  '../../shared/contextUsage': load('src/shared/contextUsage.ts'),
})
const observer = load('src/core/ai/requestUsage.ts', { '../tokens/usageTracker': usageTracker })

// ─── 1. Сплит system prompt ─────────────────────────────────────────────────

test('static prefix carries no volatile line and keeps the marker out', () => {
  const params = { userName: 'Luneex', memoryContext: 'remembered', workingMemory: 'progress' }
  const parts = builder.buildSystemPromptParts(params)
  const prompt = builder.buildSystemPrompt(params)

  // Дата-время — единственная строка, которая гарантированно меняется каждый
  // ход. Она обязана жить в динамическом хвосте, иначе кеш не работает.
  assert.ok(!/Date and time:/.test(parts.staticPart), 'static prefix must not contain the timestamp')
  assert.ok(/Date and time:/.test(parts.dynamicPart), 'dynamic tail must own the timestamp')
  assert.ok(parts.staticPart.startsWith('You are Syntee'), 'static prefix keeps its identity line')

  const split = builder.splitSystemPromptForCache(prompt)
  assert.equal(split.staticPart, parts.staticPart)
  const withoutClock = value => value.replace(/^Date and time: .*$/m, 'Date and time:')
  assert.equal(withoutClock(split.dynamicPart), withoutClock(parts.dynamicPart))
  assert.ok(!split.staticPart.includes('CACHE_BREAK'))
  assert.ok(!split.dynamicPart.includes('CACHE_BREAK'))
})

test('splitSystemPromptForCache is total on prompts without a marker', () => {
  // vm-контекст даёт объекты с чужим прототипом — сравниваем поля, не объекты.
  const plain = builder.splitSystemPromptForCache('plain prompt')
  assert.equal(`${plain.staticPart}|${plain.dynamicPart}`, 'plain prompt|')
  const blank = builder.splitSystemPromptForCache('')
  assert.equal(`${blank.staticPart}|${blank.dynamicPart}`, '|')
  const legacy = builder.splitSystemPromptForCache('STATIC' + SYSTEM_PROMPT_CACHE_BREAK + 'DYNAMIC')
  assert.equal(`${legacy.staticPart}|${legacy.dynamicPart}`, 'STATIC|DYNAMIC')
})

test('static prefix is byte-identical between two consecutive turns', () => {
  // Кеш живёт на префиксе: любая разница (даже в дате) обнуляет попадание.
  const first = builder.buildSystemPromptParts({ userName: 'Luneex', workingMemory: 'step 1' })
  const second = builder.buildSystemPromptParts({ userName: 'Luneex', workingMemory: 'step 2' })
  assert.equal(first.staticPart, second.staticPart, 'static prefix must not drift between turns')
  assert.notEqual(first.dynamicPart, second.dynamicPart, 'dynamic tail is expected to change')
})

// ─── 2. Разбор кеш-полей usage ──────────────────────────────────────────────

test('cache reads are read in every provider shape', () => {
  const { cacheReadTokensOf } = observer
  assert.equal(cacheReadTokensOf({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } }), 900)
  assert.equal(cacheReadTokensOf({ input_tokens: 1000, input_tokens_details: { cached_tokens: 12 } }), 12)
  // DeepSeek: prompt_tokens = hit + miss, отдельного подробного объекта нет.
  assert.equal(cacheReadTokensOf({ prompt_tokens: 1000, prompt_cache_hit_tokens: 768, prompt_cache_miss_tokens: 232 }), 768)
  // Прочие OpenAI-совместимые прокси.
  assert.equal(cacheReadTokensOf({ cached_tokens: 5 }), 5)
  assert.equal(cacheReadTokensOf({ cache_hit_tokens: 6 }), 6)
  assert.equal(cacheReadTokensOf({ cache_read_input_tokens: 7 }), 7)
  // Мусор и отрицательные значения не должны превращаться в токены.
  assert.equal(cacheReadTokensOf(undefined), undefined)
  assert.equal(cacheReadTokensOf(null), undefined)
  assert.equal(cacheReadTokensOf('usage'), undefined)
  assert.equal(cacheReadTokensOf({ prompt_tokens_details: { cached_tokens: -3 } }), undefined)
  assert.equal(cacheReadTokensOf({ prompt_tokens: 10 }), undefined)
})

async function* packets(values) { for (const value of values) yield value }
const identity = { providerId: 'deepseek', modelId: 'deepseek-chat', pricing: { inputPerM: 27, outputPerM: 110 } }

test('DeepSeek cache hits reach the ledger instead of being billed as full input', async () => {
  const events = []
  observer.setAIUsageSink(event => events.push(event))
  const stream = await observer.observeAIRequest(() => Promise.resolve(packets([
    { choices: [], usage: { prompt_tokens: 100_000, completion_tokens: 500, prompt_cache_hit_tokens: 92_000, prompt_cache_miss_tokens: 8_000 } },
  ])), identity, { chatId: 'deepseek' })
  for await (const unused of stream) void unused
  const last = events.at(-1)
  assert.equal(last.cacheReadTokens, 92_000)
  // prompt_tokens у DeepSeek уже total (hit + miss) — не суммируем повторно.
  assert.equal(last.inputTokens, 100_000)
  assert.equal(last.complete, true)
  observer.setAIUsageSink(null)
})

test('a later usage packet without cache fields does not erase the captured value', async () => {
  const events = []
  observer.setAIUsageSink(event => events.push(event))
  await observer.observeAIRequest(() => Promise.resolve({
    usage: { prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 400 },
  }), identity, { chatId: 'aux' })
  assert.equal(events.at(-1).cacheReadTokens, 400)

  const stream = await observer.observeAIRequest(() => Promise.resolve(packets([
    { usage: { prompt_tokens: 500, completion_tokens: 1, prompt_cache_hit_tokens: 400 } },
    { usage: { prompt_tokens: 500, completion_tokens: 2 } },
  ])), identity, { chatId: 'multi' })
  for await (const unused of stream) void unused
  assert.equal(events.at(-1).cacheReadTokens, 400, 'cache read survives a detail-less packet')
  observer.setAIUsageSink(null)
})

// ─── 3. Anthropic-конвертер ─────────────────────────────────────────────────

function systemBlocks(messages) {
  return converters.convertMessagesToAnthropic(messages).system
}

test('legacy marker still splits system into cached + uncached blocks', () => {
  const blocks = systemBlocks([{ role: 'system', content: 'STATIC' + SYSTEM_PROMPT_CACHE_BREAK + 'DYNAMIC' }, { role: 'user', content: 'hi' }])
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, 'STATIC')
  assert.equal(JSON.stringify(blocks[0].cache_control), '{"type":"ephemeral"}')
  assert.equal(blocks[1].text, 'DYNAMIC')
  assert.equal(blocks[1].cache_control, undefined)
})

test('system prompt without a marker becomes one cached block (new agent path)', () => {
  const blocks = systemBlocks([{ role: 'system', content: 'STATIC ONLY' }, { role: 'user', content: 'hi' }])
  assert.equal(blocks.length, 1)
  assert.equal(JSON.stringify(blocks[0].cache_control), '{"type":"ephemeral"}')
})

test('cache anchor moved each round marks the very last block', () => {
  const converted = converters.convertMessagesToAnthropic([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second', cacheAnchor: true },
  ])
  const last = converted.messages.at(-1)
  assert.ok(Array.isArray(last.content), 'anchored message keeps content blocks')
  assert.equal(JSON.stringify(last.content.at(-1).cache_control), '{"type":"ephemeral"}')
  // Предыдущие сообщения не должны тащить маркер — лишние записи кеша стоят премии.
  const first = converted.messages[0]
  const serialized = JSON.stringify(first)
  assert.ok(!serialized.includes('cache_control'))
})

test('consecutive user messages still merge (session context + current turn)', () => {
  const converted = converters.convertMessagesToAnthropic([
    { role: 'user', content: 'older' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: '<session_context>now</session_context>' },
    { role: 'user', content: 'question', cacheAnchor: true },
  ])
  const last = converted.messages.at(-1)
  assert.equal(last.role, 'user')
  assert.equal(last.content.length, 2, 'both user texts land in one message')
  assert.ok(String(last.content[0].text).includes('session_context'))
  assert.equal(last.content[1].text, 'question')
  assert.equal(JSON.stringify(last.content.at(-1).cache_control), '{"type":"ephemeral"}')
})

// ─── 4. Source guards ───────────────────────────────────────────────────────

test('Agent keeps only the static prefix in system and sends context before the turn', () => {
  const src = readSource('src/core/agent/Agent.ts')
  assert.ok(src.includes('splitSystemPromptForCache(sanitizedSystemPrompt)'), 'Agent must split the prompt')
  assert.ok(src.includes("{ role: 'system', content: staticSystemPrompt }"), 'system message carries the static prefix only')
  assert.ok(!src.includes("{ role: 'system', content: sanitizedSystemPrompt }"), 'unstripped prompt must not become the system message')
  assert.ok(src.includes('<session_context>'), 'dynamic tail travels as a session_context message')

  const contextIndex = src.indexOf('...(sessionContextBlock ? [sessionContextBlock] : []),')
  const currentTurnIndex = src.indexOf('const messages: AgentMessage[] = [')
  assert.ok(currentTurnIndex !== -1 && contextIndex > currentTurnIndex, 'context block is placed inside the message array before the current turn')

  const sanitizeAt = src.indexOf('sanitizeToolInstructions(systemPrompt')
  const splitAt = src.indexOf('splitSystemPromptForCache(sanitizedSystemPrompt)')
  assert.ok(sanitizeAt !== -1 && sanitizeAt < splitAt, 'sanitize runs on the full prompt, split afterwards')
})

test('Agent moves the Anthropic cache anchor on every round', () => {
  const src = readSource('src/core/agent/Agent.ts')
  const callAt = src.indexOf('this.client.chatWithTools(')
  const anchorAt = src.lastIndexOf('this.markCacheAnchor(messages)', callAt)
  assert.ok(callAt !== -1, 'round loop calls the model')
  assert.ok(anchorAt !== -1, 'round loop must set the anchor')
  assert.ok(anchorAt < callAt, 'anchor must be set before the model call')
  assert.ok(callAt - anchorAt < 800, 'anchor sits directly before the call, not somewhere else in the file')
})

test('AIClient strips the internal anchor before OpenAI-compatible dispatch', () => {
  const src = readSource('src/core/ai/AIClient.ts')
  const stripAt = src.indexOf('delete (m as { cacheAnchor?: boolean }).cacheAnchor')
  const anthropicReturn = src.indexOf('return chatWithToolsAnthropic(')
  const responsesAt = src.indexOf('this.chatWithToolsViaResponses(')
  assert.ok(stripAt !== -1, 'cacheAnchor must never reach an OpenAI-compatible endpoint')
  assert.ok(anthropicReturn !== -1 && stripAt > anthropicReturn, 'strip happens after the Anthropic branch')
  assert.ok(responsesAt !== -1 && stripAt < responsesAt, 'strip happens before the Responses fallback')
  assert.ok(src.includes('cacheReadTokensOf(usage)'), 'streaming usage parses every provider cache shape')
})

test('prompt_cache_key is sent only where the parameter is known', () => {
  const src = readSource('src/core/ai/AIClient.ts')
  assert.ok(src.includes("provider.type !== 'openai'"), 'gate: official OpenAI only')
  assert.ok(src.includes('/^gpt-(5|6)/i.test(model)'), 'gate: models that accept the parameter')
  assert.ok(src.includes('prompt_cache_key: `syntee-${chatId}`'), 'stable per-chat key')
  assert.ok(src.includes('...this.promptCacheKeyParam(providerInfo?.provider, model)'), 'wired into the chat/completions request')
})

test('gateway reports cache reads back to the client', () => {
  const src = readSource('backend/app/services/routing/anthropic_sdk_adapter.py')
  const occurrences = src.split('"prompt_tokens_details": {"cached_tokens"').length - 1
  assert.ok(occurrences >= 3, 'non-stream, reassembled and streaming paths must all report cached tokens')
  assert.ok(src.includes('cache_read_tokens = getattr(u, "cache_read_input_tokens", 0) or 0')
    || src.includes('cache_read_tokens = getattr(usage, "cache_read_input_tokens", 0) or 0'),
  'cache reads are tracked apart from total prompt tokens')
})

test('worker-side prompts keep the cache marker so Agent can split', () => {
  const src = readSource('src/main/ipc/chatSystemPrompt.ts')
  assert.ok(src.includes('buildSystemPrompt({'), 'chat path builds the prompted string')
  assert.ok(readSource('src/core/prompts/buildSystemPrompt.ts').includes('SYSTEM_PROMPT_CACHE_BREAK + dynamicPart'),
    'buildSystemPrompt still joins parts with the marker')
})
