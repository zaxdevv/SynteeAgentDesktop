/* eslint-disable @typescript-eslint/no-require-imports -- Run the production TypeScript scheduler in node:test. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/core/agent/toolSchedule.ts'), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const scheduler = {}
new Function('require', 'exports', js)(require, scheduler)
const call = (name, args = {}) => ({ fn: { name }, args })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('independent reads overlap while a write, plugin, MCP and command remain ordered barriers', async () => {
  const names = ['read_file', 'read_file', 'edit_file', 'read_file', 'plugin__p__log', 'search_code', 'mcp__s__unknown', 'run_command']
  const calls = names.map((name, i) => call(name, { path: i === 1 ? 'b' : 'a' }))
  const started = []
  const finish = []
  const run = scheduler.runOrderedTools(calls, process.cwd(), item => new Promise(resolve => {
    started.push(calls.indexOf(item))
    finish.push(resolve)
  }))
  await tick()
  assert.deepEqual(started, [0, 1])
  finish[1]()
  await tick()
  assert.deepEqual(started, [0, 1])
  finish[0]()
  for (let i = 2; i < calls.length; i++) {
    await tick()
    assert.equal(started.length, i + 1)
    assert.equal(started[i], i)
    finish[i]()
  }
  await run
})

test('paging reads of overlapping paths, including multi-file aliases, finish in original order', async () => {
  const calls = [call('read_file', { path: 'a' }), call('read_files', { paths: ['b', 'sub/../a'] }), call('read_file', { path: './b' })]
  const events = []
  await scheduler.runOrderedTools(calls, process.cwd(), async item => {
    const i = calls.indexOf(item)
    events.push('start' + i)
    await tick()
    events.push('end' + i)
  })
  assert.deepEqual(events, ['start0', 'end0', 'start1', 'end1', 'start2', 'end2'])
})

test('a failed read group drains its siblings and does not start a later write', async () => {
  const events = []
  const run = scheduler.runOrderedTools([call('find_files'), call('list_directory'), call('write_file')], process.cwd(), async item => {
    events.push(item.fn.name)
    if (item.fn.name === 'find_files') throw Error('read failed')
    await tick()
    events.push('done')
  })
  await assert.rejects(run, /read failed/)
  assert.deepEqual(events, ['find_files', 'list_directory', 'done'])
})
