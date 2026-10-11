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
const settings = load('src/shared/toolSettings.ts')
const { getToolSchemas } = load('src/core/tools/schemas/index.ts')
const names = options => getToolSchemas(options).map(s => s.function.name)

test('Master off preserves standard schemas and default settings enable optional tools', () => {
  assert.deepEqual(names({ customToolsEnabled: false, disabledTools: ['search_web', 'spawn_agent'] }), names({}))
  assert.deepEqual(names({ customToolsEnabled: true, disabledTools: [] }), names({}))
  assert.equal(settings.DEFAULT_TOOL_SETTINGS.customToolsEnabled, false)
  assert.deepEqual(settings.DEFAULT_TOOL_SETTINGS.disabledTools, [])
})
test('Custom list subtracts only optional builtins and cannot disable protected core or dynamic tools', () => {
  const disabledTools = ['search_web', 'read_file', 'request_access', 'mcp__s__t', 'plugin__p__t']
  const options = { customToolsEnabled: true, disabledTools, mcpTools: [{ name: 'mcp__s__t' }], pluginTools: [{ name: 'plugin__p__t' }] }
  const actual = names(options)
  assert.ok(!actual.includes('search_web'))
  for (const n of ['read_file', 'request_access', 'mcp__s__t', 'plugin__p__t']) assert.ok(actual.includes(n), n)
  assert.deepEqual(settings.normalizeDisabledTools([...disabledTools, 'search_web', null, 1]), ['search_web'])
})
test('Preferences never expand Ask/browser/image gating', () => {
  const actual = names({ askMode: true, customToolsEnabled: true, disabledTools: [] })
  for (const n of ['edit_file', 'write_file', 'run_command', 'generate_image', 'browser_navigate']) assert.ok(!actual.includes(n), n)
  assert.ok(names({ browserMode: true, customToolsEnabled: true, disabledTools: ['browser_click'] }).includes('browser_navigate'))
  assert.ok(!names({ browserMode: true, customToolsEnabled: true, disabledTools: ['browser_click'] }).includes('browser_click'))
})
test('Media schemas are registered, enabled by default and can be disabled individually', () => {
  for (const name of ['analyze_video', 'analyze_audio']) {
    assert.ok(names({}).includes(name), name)
    assert.ok(names({ askMode: true }).includes(name), name)
    assert.ok(!names({ customToolsEnabled: true, disabledTools: [name] }).includes(name), name)
    assert.ok(settings.OPTIONAL_TOOL_GROUPS.some(group => group.tools.some(tool => tool.name === name)), name)
  }
})
test('Agent preserves worker array identity for live browser access and forwards media cancellation', () => {
  const source = readFileSync('src/core/agent/Agent.ts', 'utf8')
  assert.ok(source.includes('this.toolDispatcher.mediaSignal = signal'))
  assert.ok(source.includes('activeSchemas.splice(0, activeSchemas.length, ...filteredSchemas)'))
})
test('Unknown future optional builtin is enabled unless explicitly disabled', () => {
  assert.equal(settings.isToolDisabled('future_tool', { customToolsEnabled: true, disabledTools: [] }), false)
  assert.equal(settings.isToolDisabled('future_tool', { customToolsEnabled: false, disabledTools: ['future_tool'] }), false)
})
