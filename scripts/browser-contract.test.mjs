import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const cache = new Map()
function load(path) {
  path = resolve(path)
  if (cache.has(path)) return cache.get(path).exports
  const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  cache.set(path, module)
  new Function('require', 'module', 'exports', source)(id => id.startsWith('.') ? load(resolve(dirname(path), `${id}.ts`)) : require(id), module, module.exports)
  return module.exports
}
const { BROWSER_TOOL_SCHEMAS, BROWSER_RESEARCH_TOOL_NAMES } = load('src/core/tools/schemas/browser.ts')
const { getToolSchemas } = load('src/core/tools/schemas/index.ts')
const { OPTIONAL_TOOL_GROUPS } = load('src/shared/toolSettings.ts')
const names = options => getToolSchemas(options).map(s => s.function.name)
test('All browser tools are registered once and expose timeout/tab context', () => {
  const toolNames = BROWSER_TOOL_SCHEMAS.map(s => s.function.name)
  assert.equal(new Set(toolNames).size, toolNames.length)
  for (const schema of BROWSER_TOOL_SCHEMAS) {
    assert.ok(names({ browserMode: true }).includes(schema.function.name), schema.function.name)
    assert.ok(schema.function.parameters.properties.tab_id)
    assert.ok(schema.function.parameters.properties.timeout_ms)
    assert.equal(schema.function.parameters.additionalProperties, false)
    assert.ok(OPTIONAL_TOOL_GROUPS.some(g => g.tools.some(t => t.name === schema.function.name)), schema.function.name)
  }
})
test('Disabled browser access and disabled preferences cannot expose tools', () => {
  assert.ok(!names({}).some(n => n.startsWith('browser_')))
  assert.ok(names({}).includes('request_access'))
  assert.ok(!names({ browserMode: true, customToolsEnabled: true, disabledTools: ['browser_evaluate'] }).includes('browser_evaluate'))
})
test('Research modes never grant arbitrary JS or private state mutations', () => {
  for (const options of [{ askMode: true }, { planningMode: true }, { persona: 'reviewer' }]) {
    const actual = names({ browserMode: true, ...options })
    assert.ok(actual.includes('browser_snapshot'))
    for (const n of actual.filter(n => n.startsWith('browser_'))) assert.ok(BROWSER_RESEARCH_TOOL_NAMES.has(n), n)
    for (const n of ['browser_evaluate', 'browser_add_script', 'browser_upload', 'browser_fill', 'browser_cookies', 'browser_storage']) assert.ok(!actual.includes(n), n)
  }
})
test('Every browser schema has dispatcher handling and complete argument forwarding', () => {
  const source = readFileSync('src/core/agent/toolDispatcher.ts', 'utf8')
  for (const s of BROWSER_TOOL_SCHEMAS) assert.ok(source.includes(`case '${s.function.name}':`), s.function.name)
  for (const s of ['args: resolvedArgs', 'resolvedArgs.frame_id', 'resolvedArgs.timeout_ms', 'resolvedArgs.snapshot_id', '[DRY RUN] Browser operation was not executed.']) assert.ok(source.includes(s), s)
})
