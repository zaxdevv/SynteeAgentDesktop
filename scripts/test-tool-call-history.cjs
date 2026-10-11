const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const Module = require('node:module')
const path = require('node:path')
const file = path.resolve('src/core/ai/toolCallHistory.ts')
const mod = new Module(file)
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, file)
const { repairToolCallHistory: repair } = mod.exports
const call = id => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })
const assistant = ids => ({ role: 'assistant', content: 'Reading', tool_calls: ids.map(call) })
const output = id => ({ role: 'tool', content: 'result', tool_call_id: id })
const good = [assistant(['fc_a', 'fc_b']), output('fc_b'), output('fc_a')]
assert.deepEqual(repair(good), good)
assert.deepEqual(repair([output('fc_orphan'), { role: 'user', content: 'task' }]), [{ role: 'user', content: 'task' }])
assert.deepEqual(repair([assistant(['fc_a']), output('fc_a'), output('fc_a')]), [assistant(['fc_a']), output('fc_a')])
assert.deepEqual(repair([assistant(['fc_a', 'fc_missing']), output('fc_a')]), [assistant(['fc_a']), output('fc_a')])
assert.deepEqual(repair([assistant(['fc_a']), { role: 'user', content: 'next' }, output('fc_a')]), [{ role: 'assistant', content: 'Reading' }, { role: 'user', content: 'next' }])
for (let start = 0; start < good.length; start++) {
  const repaired = repair(good.slice(start))
  const ids = new Set(repaired.flatMap(m => (m.tool_calls || []).map(c => c.id)))
  assert(repaired.filter(m => m.role === 'tool').every(m => ids.has(m.tool_call_id)))
}
const before = JSON.stringify(good)
repair(good)
assert.equal(JSON.stringify(good), before, 'source must not be mutated')
assert.deepEqual(repair(repair(good)), good, 'repair must be idempotent')
console.log('PASS: valid parallel pairs, orphan sliced outputs, duplicates, incomplete calls, interrupted rounds, every slice boundary, immutability, idempotence')
