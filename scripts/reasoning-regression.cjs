/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node CommonJS regression test */
/* global require, __dirname */
// Run: node scripts/reasoning-regression.cjs
// Compile the actual TS helper in memory; no generated files or Electron required.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { test } = require('node:test')
const source = fs.readFileSync(path.join(__dirname, '../src/shared/reasoningModels.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } })
const mod = { exports: {} }
new Function('exports', 'require', 'module', compiled.outputText)(mod.exports, require, mod)
const { buildReasoningParams: build } = mod.exports
const gateway = levels => ({ reasoning: { supported: true, levels } })
const effort = values => ({ reasoningOptions: [{ type: 'effort', values }] })

for (const [name, value, meta, expected] of [
  ['exact gateway', 'medium', gateway(['high', 'medium']), { reasoning_effort: 'medium' }],
  ['max falls to high', 'max', gateway(['low', 'high', 'medium']), { reasoning_effort: 'high' }],
  ['high falls to medium', 'high', effort(['low', 'medium']), { reasoning_effort: 'medium' }],
  ['nearest lower regardless of order', 'xhigh', effort(['low', 'high']), { reasoning_effort: 'high' }],
  ['never raise', 'low', effort(['medium', 'high']), {}],
  ['unknown exact level', 'custom', gateway(['custom']), { reasoning_effort: 'custom' }],
  ['unknown incompatible level', 'custom', gateway(['high']), {}],
  ['budget not effort', '4096', effort(['low', 'high']), {}],
  ['gateway disabled authoritative', 'high', { ...effort(['high']), reasoning: { supported: false, levels: [] } }, {}],
  ['gateway off', '', gateway(['high']), {}],
  ['none is off', 'none', gateway(['none', 'high']), {}],
  ['native explicit off', '', effort(['none', 'low']), { reasoning_effort: 'none' }],
  ['toggle on', 'high', { reasoningOptions: [{ type: 'toggle' }] }, { thinking: { type: 'enabled' } }],
  ['toggle off', '', { reasoningOptions: [{ type: 'toggle' }] }, { thinking: { type: 'disabled' } }],
  ['always on', 'high', { reasoningOptions: [] }, {}],
  ['no metadata', 'high', null, {}],
  ['budget exact', '4096', { reasoningOptions: [{ type: 'budget_tokens', min: 1024 }] }, { thinking: { type: 'enabled', budget_tokens: 4096 } }],
  ['budget capped down', '24000', { reasoningOptions: [{ type: 'budget_tokens', max: 8192 }] }, { thinking: { type: 'enabled', budget_tokens: 8192 } }],
  ['budget below minimum', '100', { reasoningOptions: [{ type: 'budget_tokens', min: 1024 }] }, {}],
  ['effort not arbitrary budget', 'high', { reasoningOptions: [{ type: 'budget_tokens' }] }, {}],
  ['invalid partial number', '4096oops', { reasoningOptions: [{ type: 'budget_tokens' }] }, {}],
]) {
  test(name, () => assert.deepEqual(build(value, meta), expected))
}
