/* global require, __dirname */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')

function load(file, deps = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(id => id in deps ? deps[id] : require(id), module, module.exports)
  return module.exports
}

const shared = load('src/core/tools/_shared.ts')
const { readFile } = load('src/core/tools/fileRead.ts', { './_shared': shared, '../sidecar/sidecarClient': {} })
const { ToolDispatcher } = load('src/core/agent/toolDispatcher.ts', {
  '../tools': { readFile },
  '../context/contextManager': { getContextSettings: () => ({ fileMapEnabled: false }) },
  '../prompts/sections/secretsSection': {},
})

function project(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-read-pages-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'page.txt')
  fs.writeFileSync(file, text)
  const dispatcher = new ToolDispatcher({ workdir: dir, store: { get: () => ({}) } })
  const read = async (args = {}, visible = output => output) => {
    const result = await dispatcher.executeTool('read_file', { path: 'page.txt', ...args })
    assert.equal(result.success, true, result.error)
    dispatcher.acknowledgeRead(result, visible(result.output))
    return result.output
  }
  return { file, dispatcher, read }
}

test('reading later offsets first fills each gap then stops; explicit offsets always retrieve text', async t => {
  const { read, dispatcher } = project(t, Array.from({ length: 1000 }, (_, i) => 'row ' + (i + 1)).join('\n'))
  await read({ offset: 900, limit: 51 })
  await read({ offset: 100, limit: 101 })
  assert.equal(dispatcher.canAdvanceRead('page.txt'), false)
  assert.match(await read(), /Lines 1-99 of 1000/)
  assert.match(await read(), /Lines 201-600 of 1000/)
  assert.match(await read(), /Lines 601-899 of 1000/)
  assert.match(await read(), /Lines 951-1000 of 1000/)
  assert.match(await read(), /All 1000 lines/)
  assert.match(await read({ offset: 900, limit: 1 }), /900\|row 900$/)
})

test('project-relative paths validate cached output and version changes reset progress', async t => {
  const { read, dispatcher, file } = project(t, 'one\ntwo')
  await read({ limit: 1 })
  const snapshot = dispatcher.getFileCacheUpdates()
  assert.ok(Object.keys(snapshot).some(key => key.startsWith(file + ':')))
  dispatcher.resetForRun({ fileCacheSnapshot: snapshot })
  assert.match(await read({ limit: 1 }), /1\|one$/)
  assert.deepEqual(dispatcher.getFileCacheUpdates(), {}, 'warm read used the snapshot')
  fs.writeFileSync(file, 'six\nten')
  fs.utimesSync(file, new Date(1), new Date(1))
  assert.match(await read({ limit: 1 }), /1\|six$/)
  assert.match(await read({ limit: 1 }), /2\|ten$/)
  fs.unlinkSync(file)
  const missing = await dispatcher.executeTool('read_file', { path: 'page.txt' })
  assert.equal(missing.success, false)
})

test('truncation leaves missing and partial lines readable even with the cache disabled', async t => {
  const { read, dispatcher } = project(t, 'aaa\nbbb\nccc\nddd\neee\nfff')
  dispatcher.resetForRun({ readFileCacheEnabled: false })
  await read({}, out => out.slice(0, out.indexOf('2|bbb') + 3) + '\n\n...[обрезано 13 симв, показано начало и конец]...\n\n' + out.slice(out.indexOf('5|eee') + 2))
  assert.match(await read(), /Lines 2-5 of 6/)
  assert.match(await read(), /All 6 lines/)
  assert.deepEqual(dispatcher.getFileCacheUpdates(), {})
})

test('restored ranges require an exact visible tool page and the same file version', async t => {
  const { read, dispatcher, file } = project(t, 'one\ntwo\nthree')
  const first = await read({ limit: 1 })
  const snapshot = dispatcher.getFileCacheUpdates()
  const visible = new Set([first])
  const reset = () => dispatcher.resetForRun({ fileCacheSnapshot: snapshot, historyPages: () => visible })
  reset()
  assert.match(await read(), /Lines 2-3 of 3/)
  visible.clear()
  assert.match(await read(), /Lines 1-1 of 3/)
  visible.add(first + ' [compacted]')
  reset()
  assert.match(await read({ limit: 1 }), /1\|one$/)
  visible.add(first)
  fs.writeFileSync(file, 'six\nten\nseven')
  reset()
  assert.match(await read({ limit: 1 }), /1\|six$/)
})
