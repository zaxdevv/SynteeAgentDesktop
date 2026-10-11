const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), assert = require('node:assert/strict')
const source = fs.readFileSync(path.join(__dirname, '../src/core/agent/goalRuntime.ts'), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', output)(id => id === 'fs' ? { statSync: () => ({ mtimeMs: 1, ctimeMs: 1, size: 2 }), readFileSync: () => 'OK' } : require(id), mod, mod.exports)
const fileOutput = `[File: ${path.resolve('test.txt').replace(/\\/g, '/')} | 1 lines]\n1|OK`
const { GoalRuntime } = mod.exports
function runtime(criteria, opts = {}) {
  const goal = { id: 'goal', chatId: 'chat', objective: 'Verify', criteria, constraints: [], progress: [], evidence: [], status: 'running', steps: 0, maxSteps: 5, createdAt: 1, updatedAt: 1, ...opts }
  const saved = []
  const r = new GoalRuntime(goal, process.cwd(), value => saved.push(value))
  return { r, saved }
}
const report = status => JSON.stringify({ goal_report: { status, progress: 'Checked current state', blocker: 'Need input' } })
{
  const { r } = runtime(['file_contains:test.txt::OK'])
  r.beginRound()
  r.observe('read_file', { path: 'test.txt' }, true, fileOutput, 'read-1', false)
  assert.equal(r.checkpoint(report('completed')), 'stop')
  assert.equal(r.goal.status, 'completed')
  assert.match(r.goal.evidence[0], /read-1/)
}
for (const mode of ['failed', 'dryRun', 'partial', 'mutation', 'freeform']) {
  const { r } = runtime([mode === 'freeform' ? 'Make beautiful' : 'file_contains:test.txt::OK'])
  r.beginRound()
  r.observe('read_file', { path: 'test.txt' }, mode !== 'failed', mode === 'partial' ? 'OK [shown 400 of 900 lines]' : fileOutput, 'read-1', mode === 'dryRun')
  if (mode === 'mutation') r.observe('edit_file', { path: 'test.txt' }, false, 'partial failure', 'edit-1', false)
  r.checkpoint(report('completed'))
  assert.equal(r.goal.status, 'unverified', mode)
}
{
  const { r } = runtime(['diagnostics_passed'])
  r.observe('get_diagnostics', {}, true, 'DIAGNOSTICS_UNKNOWN', 'diag', false)
  r.checkpoint(report('completed'))
  assert.equal(r.goal.status, 'unverified')
}
{
  const { r } = runtime(['file_contains:test.txt::OK'], { maxSteps: 1 })
  assert.equal(r.beginRound(), undefined)
  assert.match(r.beginRound(), /budget/i)
}
{
  const { r } = runtime(['anything'])
  assert.equal(r.checkpoint('unstructured answer'), 'continue')
  assert.equal(r.checkpoint('unstructured answer'), 'stop')
  assert.equal(r.goal.status, 'unverified')
}
{
  const { r } = runtime(['anything'])
  assert.equal(r.checkpoint(report('blocked')), 'stop')
  assert.equal(r.goal.status, 'blocked')
}
{
  const { r } = runtime(['anything'])
  r.beginRound()
  r.checkpoint(report('continue'))
  r.beginRound()
  assert.equal(r.checkpoint(report('continue')), 'stop')
  assert.equal(r.goal.status, 'unverified')
}
console.log('goal runtime regressions passed')
