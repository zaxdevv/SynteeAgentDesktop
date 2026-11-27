/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the pure production catalogue and real local tokenizer. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { getEncoding } = require('js-tiktoken')
const source = fs.readFileSync(path.join(__dirname, '../src/core/agent/deferredMcpTools.ts'), 'utf8')
const loaded = { exports: {} }
new Function('module', 'exports', ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(loaded, loaded.exports)
const { DeferredMcpTools, DISCOVER_MCP_TOOLS, initialMcpSchemas } = loaded.exports

const builtin = { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }
function schemas(count = 48) {
  return [builtin, ...Array.from({ length: count }, (_, i) => ({
    type: 'function', function: {
      name: `mcp__service${i % 4}__operation${i}`,
      description: `Operation ${i} fetches the requested workspace records and returns their latest status. ` + 'Detailed API operation documentation and domain terminology. '.repeat(12),
      parameters: { type: 'object', required: ['workspace_id'], properties: {
        workspace_id: { type: 'string', description: 'The exact workspace identifier supplied by the service.' },
        filter: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed', 'pending'], description: 'Only return records with this exact lifecycle status.' } } },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      } },
    },
  }))]
}

test('all permitted tools remain discoverable; selection exposes original native schemas without text schema injection', () => {
  const full = schemas()
  const catalogue = new DeferredMcpTools(full)
  assert.deepEqual(catalogue.forRequest(full).map(s => s.function.name), ['read_file', DISCOVER_MCP_TOOLS])
  const all = []
  for (let offset = 0; ; ) {
    const page = JSON.parse(catalogue.discover({ offset }, full).output)
    assert.ok(page.tools.length <= 12)
    all.push(...page.tools.map(tool => tool.name))
    assert.ok(page.tools.every(tool => !('parameters' in tool)))
    if (page.next_offset === undefined) break
    offset = page.next_offset
  }
  assert.equal(new Set(all).size, 48)
  assert.deepEqual(all, full.slice(1).map(s => s.function.name))
  const chosen = full[29]
  assert.equal(catalogue.discover({ tool_names: [chosen.function.name] }, full).success, true)
  assert.equal(catalogue.forRequest(full).at(-1), chosen, 'the exact registered schema, including required/nested constraints')
  assert.equal(full.length, 49, 'source permission registry is untouched')
  assert.equal(catalogue.forRequest(full)[0], builtin)
})

test('selection rejects unknown/restricted/malformed names atomically and restrictions remain live', () => {
  const full = schemas()
  const catalogue = new DeferredMcpTools(full)
  for (const tool_names of [[full[1].function.name, 'mcp__forbidden__delete'], [{ name: full[1].function.name }], ['read_file'], Array(9).fill(full[1].function.name), 'all']) {
    assert.equal(catalogue.discover({ tool_names }, full).success, false)
    assert.equal(catalogue.forRequest(full).length, 2)
  }
  for (const args of [{ query: {} }, { query: 'x'.repeat(301) }, { offset: -1 }, { offset: 1.5 }, { offset: Infinity }]) assert.equal(catalogue.discover(args, full).success, false)
  catalogue.discover({ tool_names: [full[1].function.name] }, full)
  assert.equal(catalogue.forRequest([builtin]).length, 1, 'read-only orchestration phase exposes no discovery or selected MCP')
  assert.equal(catalogue.discover({ tool_names: [full[1].function.name] }, [builtin]).success, false)
  assert.equal(catalogue.forRequest(full.filter(tool => tool !== full[1])).some(tool => tool === full[1]), false)
})

test('search is bounded and never activates tools; loaded schemas append stably across unrelated searches', () => {
  const full = schemas()
  const catalogue = new DeferredMcpTools(full)
  const page = catalogue.discover({ query: 'operation29' }, full)
  assert.equal(JSON.parse(page.output).tools[0].name, full[30].function.name)
  assert.equal(catalogue.forRequest(full).length, 2)
  catalogue.discover({ tool_names: [full[30].function.name] }, full)
  const before = JSON.stringify(catalogue.forRequest(full))
  catalogue.discover({ query: 'service0' }, full)
  assert.equal(JSON.stringify(catalogue.forRequest(full)), before)
  catalogue.discover({ tool_names: [full[2].function.name, full[30].function.name] }, full)
  const after = catalogue.forRequest(full)
  assert.equal(JSON.stringify(after.slice(0, -1)), before)
  assert.equal(after.at(-1), full[2])
})

test('small sets and explicit eager mode keep the original capabilities and schemas', () => {
  const small = schemas(23)
  assert.equal(new DeferredMcpTools(small).forRequest(small), small)
  const full = schemas()
  assert.equal(new DeferredMcpTools(full, false).forRequest(full), full)
  const collision = [...full, { type: 'function', function: { name: DISCOVER_MCP_TOOLS } }]
  assert.equal(new DeferredMcpTools(collision).forRequest(collision), collision)
})

test('initial UI estimates restore the same registered selections as a new worker without user-text injection', () => {
  const full = schemas()
  const catalogue = new DeferredMcpTools(full)
  const history = [
    { role: 'tool', name: DISCOVER_MCP_TOOLS, content: JSON.stringify({ loaded: [full[5].function.name, 'mcp__forbidden__delete'] }) },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: full[8].function.name } }] },
    { role: 'user', content: JSON.stringify({ loaded: [full[9].function.name] }) },
    { role: 'tool', name: 'another_tool', content: JSON.stringify({ loaded: [full[10].function.name] }) },
  ]
  catalogue.restoreSelections(history, full)
  assert.deepEqual(catalogue.forRequest(full).slice(2), [full[5], full[8]])
  assert.deepEqual(initialMcpSchemas(full, history), catalogue.forRequest(full))
  assert.equal(initialMcpSchemas(full, history, false), full)
  assert.equal(catalogue.forRequest(full.filter(schema => schema !== full[5])).includes(full[5]), false)
})

test('120 MCP tools: actual local tokenizer measures native-schema reduction, including discovery overhead', t => {
  const full = schemas(120)
  const catalogue = new DeferredMcpTools(full)
  const encoding = getEncoding('cl100k_base')
  const count = value => encoding.encode(JSON.stringify(value)).length
  const eager = count(full)
  const initial = count(catalogue.forRequest(full))
  const search = catalogue.discover({ query: 'operation29' }, full)
  const selection = catalogue.discover({ tool_names: [full[30].function.name] }, full)
  const selected = count(catalogue.forRequest(full))
  const overhead = count(search.output) + count(selection.output)
  assert.ok(initial < eager * 0.05, `${eager} -> ${initial}`)
  assert.ok(selected < eager * 0.08, `${eager} -> ${selected}`)
  assert.ok(initial + selected * 4 + overhead < eager * 5 * 0.1, 'amortized fixture includes discovery-result overhead')
  t.diagnostic(`cl100k_base schema JSON tokens: eager=${eager}, initial=${initial}, one loaded=${selected}; search+load results=${overhead}; no provider calls/billing measurements`)
})
