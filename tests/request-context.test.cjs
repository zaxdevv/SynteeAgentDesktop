/* global require, __dirname, TextEncoder, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production context helpers with isolated dependencies. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const loaded = { exports: {} }
  vm.runInNewContext(code, {
    module: loaded, exports: loaded.exports, TextEncoder, setTimeout, clearTimeout,
    require: name => name in dependencies ? dependencies[name] : require(name),
    ...globals,
  })
  return loaded.exports
}
// Единый контракт счётчика контекста (пороги/процент/overhead) — реальный
// модуль, а не копия констант: иначе тесты закрепят устаревшие значения.
const contextUsage = load('src/shared/contextUsage.ts', {})
const usage = load('src/core/tokens/usageTracker.ts', {
  './modelCatalog': {},
  './gatewayModelsCache': {},
  '../../shared/data/builtinModels': {},
  '../../shared/imageFormat': { IMAGE_TOKEN_COST: 1000 },
  './ModelPricing': {},
  '../../shared/contextUsage': contextUsage,
})

test('billing panel shows incomplete totals even when every accepted request lacks usage', () => {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  let state = 0
  const states = [true, null, null, { bottom: 0, left: 0 }, null, false]
  const { default: ContextRing } = load('src/renderer/src/components/ui/ContextRing/ContextRing.tsx', {
    react: { useState: initial => [states[state++] ?? initial, () => {}], useRef: current => ({ current }), useEffect: () => {} },
    'react-dom': { createPortal: children => children },
    'framer-motion': { motion: { div: ({ children, id, className, style }) => React.createElement('div', { id, className, style }, children) }, AnimatePresence: ({ children }) => children },
    '../AppIcon/AppIcon': { default: () => null, __esModule: true },
    '../ContextManager/ContextManager': { default: () => null, __esModule: true },
    '../../../store/auth.store': { useAuthStore: selector => selector({ user: null }) },
    '../../../utils/popupAnchor': {},
    './ContextRing.css': {},
  }, { document: { body: {} } })
  const markup = renderToStaticMarkup(React.createElement(ContextRing, { info: {
    total: 174500, limit: 1000000, percent: 17.45, modelId: 'audit', source: 'real',
    breakdown: {}, systemPrompt: 12600, history: 13900, historyMessages: 2,
    toolCallsTokens: 148000, toolCallsCount: 0, currentInput: 0, reserved: 0,
    pricing: null, estimatedCostCents: 20, sessionCostCents: null, lastRequestCostCents: null,
    sessionRequests: 3, sessionUnpricedRequests: 3, sessionIncludesAuxiliary: true,
  } }))
  assert.match(markup, /Сумма неполная/)
  assert.match(markup, /Чат · 3 выз\. API/)
  assert.match(markup, /Схемы инструментов/)
  assert.doesNotMatch(markup, /0 вызовов/)
  assert.doesNotMatch(markup, /\$0\.200/, 'unpriced last request must not show a stale request estimate')
})
const { previewAttachmentText } = load('src/core/context/attachmentText.ts', { '../tokens/usageTracker': usage })

test('huge attached logs have a bounded preview with beginning, end and a full-content notice', async () => {
  const text = 'LOG_START\n' + 'line 42: some diagnostic output repeated with source paths\n'.repeat(25000) + '\nLOG_END'
  const preview = await previewAttachmentText(text, 7900)
  assert.equal(preview.truncated, true)
  assert.ok(preview.text.startsWith('LOG_START\n'))
  assert.ok(preview.text.endsWith('LOG_END'))
  assert.match(preview.text, /middle omitted.*read_file/)
  assert.ok(usage.estimateTokens(preview.text) <= 7900)
  assert.ok(preview.text.length < 40_000)
})

test('small attachments and fallback token truncation preserve whitespace and line breaks', async () => {
  const content = 'def f():\n    return "value"\n\nprint(f())\n'
  assert.equal((await previewAttachmentText(content, 100)).text, content)
  const result = await usage.truncateToTokensAsync(content, 8)
  assert.ok(content.startsWith(result.text))
  assert.ok(result.text.includes('\n'))
  assert.ok(result.tokens <= 8)
})

test('request counts include all 488 tool schemas and the inline input', () => {
  const tools = Array.from({ length: 488 }, (_, index) => ({
    type: 'function', function: { name: 'lookup_' + index, description: 'Search indexed metadata.', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  }))
  const snapshot = usage.computeRequestContextSnapshot([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'attached log text' },
  ], 1_050_000, tools)
  assert.equal(snapshot.breakdown.tools, usage.estimateTokens(JSON.stringify(tools)))
  assert.ok(snapshot.breakdown.tools > 4200)
  assert.equal(snapshot.estimated, snapshot.breakdown.tools + snapshot.breakdown.system + snapshot.breakdown.history + 100)
})

test('reasoning_content is echoed but not billed, thinking_blocks are billed, both stay in parity', async () => {
  const message = { role: 'assistant', content: 'done' }
  const before = usage.estimateMessagesTokensFull([message])
  // reasoning_content отправляется обратно провайдеру (LiteLLM-прокси для GLM
  // иначе отдаёт 400), но в prompt_tokens он НЕ входит — проверено на живых
  // чатах: 368k оценки против 207k real, вся разница — reasoning в истории.
  message.reasoning_content = 'reasoning '.repeat(100)
  assert.equal(usage.estimateMessagesTokensFull([message]), before)
  // Нативные Anthropic thinking blocks — часть оплачиваемого входа.
  message.thinking_blocks = [{ thinking: 'reasoning '.repeat(100), signature: 'sig' }]
  const withBlocks = usage.estimateMessagesTokensFull([message])
  assert.ok(withBlocks > before)
  usage.setRemoteTokenCounter({ countBatch: async texts => texts.map(usage.estimateTokens) })
  usage.clearTokenCountCache()
  try { assert.equal(await usage.estimateMessagesTokensAsync([message]), withBlocks) }
  finally { usage.setRemoteTokenCounter(null) }
})

test('incremental token count sends only unseen inputs to the sidecar and ignores unbilled bytes', async () => {
  const batches = []
  const text = { role: 'user', content: 'a large repeated result' }
  const photo = { role: 'user', content: [{ type: 'image_url', get image_url() { throw new Error('image bytes must not be read') } }] }
  const echo = { ...text, get reasoning_content() { throw new Error('reasoning echo must not be read') } }
  usage.clearTokenCountCache()
  usage.setRemoteTokenCounter({ countBatch: async texts => {
    batches.push([...texts])
    return texts.map(usage.estimateTokens)
  } })
  try {
    const before = await usage.estimateMessagesTokensAsync([echo, text, photo])
    assert.equal(before, usage.estimateMessagesTokensFull([echo, text, photo]))
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0], [text.content, ''])
    const next = { role: 'assistant', content: 'next result' }
    const after = await usage.estimateMessagesTokensAsync([echo, text, photo, next])
    assert.equal(after - before, usage.estimateMessagesTokensFull([next]))
    assert.deepEqual(batches[1], [next.content])
    assert.equal(await usage.estimateMessagesTokensAsync([echo, text, photo, next]), after)
    assert.equal(batches.length, 2)
  } finally {
    usage.setRemoteTokenCounter(null)
    usage.clearTokenCountCache()
  }
})

test('the latest measurement wins and a foreign chat never leaks in', () => {
  const events = new Map()
  const cleanup = []
  let value
  const react = {
    useState: () => [null, next => { value = next }],
    useRef: current => ({ current }),
    useEffect: effect => { const dispose = effect(); if (dispose) cleanup.push(dispose) },
  }
  const { useContextCounter } = load('src/renderer/src/hooks/useContextCounter.ts', {
    react,
    '@shared/constants': { IPC_EVENTS: { CONTEXT_USAGE: 'usage', CHAT_COMPACTED: 'compact' } },
    '@shared/contextUsage': contextUsage,
  }, {
    window: { syntee: {
      on: (event, handler) => { events.set(event, handler); return () => events.delete(event) },
      context: { calculate: async () => {} },
    } },
  })
  try {
    useContextCounter({ chatId: 'a', currentInput: '', modelId: 'm', isRunning: true })
    const emit = events.get('usage')
    emit({ chatId: 'a', source: 'real', estimated: 800_000, limit: 1_000_000, breakdown: { history: 800_000, system: 0, tools: 0, current: 0 } })
    events.get('context:cost')({ chatId: 'a', sessionCostCents: 400, sessionRequests: 12, lastRequestCostCents: 30, sessionIncludesAuxiliary: true, sessionUnpricedRequests: 1 })
    assert.equal(value.total, 800_000, 'auxiliary billing must not alter main model context')
    assert.equal(value.sessionCostCents, 400)
    assert.equal(value.sessionUnpricedRequests, 1)
    events.get('context:cost')({ chatId: 'b', sessionCostCents: 999, sessionRequests: 20 })
    assert.equal(value.sessionCostCents, 400, 'another chat must not change this total')
    // Каждый раунд реально меняет prompt (tool-результаты, новый ответ), поэтому
    // последний замер побеждает — и estimate тоже. Точность оценки обеспечивает
    // калибровка по реальным prompt_tokens, а не «замороженный» первый real.
    emit({ chatId: 'a', source: 'estimate', estimated: 100_000, limit: 1_000_000, breakdown: { history: 100_000, system: 0, tools: 0, current: 0 } })
    assert.equal(value.total, 100_000, 'a newer estimate describes the next request and wins')
    emit({ chatId: 'a', source: 'estimate', scope: 'request', estimated: 120_000, limit: 1_000_000, breakdown: { history: 120_000, system: 0, tools: 0, current: 0 } })
    assert.equal(value.total, 120_000)
    assert.equal(value.source, 'estimate')
    assert.equal(value.sessionCostCents, 400, 'new context estimates must retain the persistent total')
    assert.equal(value.lastRequestCostCents, 30)
    emit({ chatId: 'a', source: 'real', estimated: 110_000, limit: 1_000_000, sessionCostCents: null, sessionRequests: 0, breakdown: { history: 110_000, system: 0, tools: 0, current: 0 } })
    assert.equal(value.sessionRequests, 12, 'legacy worker-local cost must not reset the ledger')
    assert.equal(value.total, 110_000)
    emit({ chatId: 'b', source: 'real', estimated: 900_000, limit: 1_000_000 })
    assert.equal(value.total, 110_000, 'a foreign chat must never overwrite this ring')
  } finally {
    for (const dispose of cleanup) dispose()
  }
})

test('draft tokens only change the idle next-request estimate', () => {
  const events = new Map()
  let value
  const react = {
    useState: () => [null, next => { value = next }],
    useRef: current => ({ current }),
    useEffect: effect => effect(),
  }
  const { useContextCounter } = load('src/renderer/src/hooks/useContextCounter.ts', {
    react, '@shared/constants': { IPC_EVENTS: { CONTEXT_USAGE: 'usage' } },
    '@shared/contextUsage': contextUsage,
  }, {
    setTimeout: fn => { fn(); return 1 },
    window: { syntee: {
      on: (event, handler) => { events.set(event, handler); return () => events.delete(event) },
      context: { calculate: async () => {} },
    } },
  })
  useContextCounter({ chatId: 'a', currentInput: 'draft '.repeat(100), modelId: 'm' })
  const event = { chatId: 'a', estimated: 800, limit: 1000, breakdown: { history: 800, system: 0, tools: 0, current: 0 } }
  events.get('usage')({ ...event, source: 'real', scope: 'request', modelId: 'phase-model' })
  assert.equal(value.total, 800)
  assert.equal(value.currentInput, 0)
  assert.equal(value.modelId, 'phase-model')
  events.get('usage')({ ...event, source: 'estimate', scope: 'request' })
  assert.equal(value.total, 800)
  events.get('usage')({ ...event, source: 'estimate', scope: 'next_request' })
  assert.equal(value.total, 800 + contextUsage.estimateDraftTokens('draft '.repeat(100)))
})
