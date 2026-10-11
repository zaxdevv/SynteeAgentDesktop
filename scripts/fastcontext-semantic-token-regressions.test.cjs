/* global require, __dirname, setImmediate */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { getEncoding } = require('js-tiktoken')
const root = require('node:path').join(__dirname, '..')

function loadWorkerQueue() {
  const src = fs.readFileSync(require('node:path').join(root, 'src/main/workers/fastContext-worker.ts'), 'utf8')
  const start = src.indexOf('interface ProjectQueue')
  const end = src.indexOf('// Safety net —', start)
  const queueCode = src.slice(start, end).replace(/interface ProjectQueue[\s\S]*?\n}\n/, '')
  const context = { Map, Array, Date, Promise, console: { warn() {} }, perfMark: () => 1, perfEvent() {} }
  context._projectQueues = new Map()
  vm.createContext(context)
  vm.runInContext(ts.transpile(queueCode, { target: ts.ScriptTarget.ES2022 }), context)
  return context
}

test('worker queue: watcher events coalesce; safety and explicit jobs, including overlapping explicit, all finish', async () => {
  const c = loadWorkerQueue()
  let release
  const first = new Promise(r => { release = r })
  const events = []
  c.enqueueProjectJob('p', 'explicit', async () => { events.push('explicit-running-start'); await first; events.push('explicit-running-end') })
  c.enqueueProjectJob('p', 'watcher', async () => events.push('watcher-1'))
  c.enqueueProjectJob('p', 'watcher', async () => events.push('watcher-2'))
  c.enqueueProjectJob('p', 'safety', async () => events.push('safety'))
  c.enqueueProjectJob('p', 'safety', async () => events.push('safety-duplicate'))
  c.enqueueProjectJob('p', 'explicit', async () => events.push('explicit-queued'))
  let signalDone
  const drained = new Promise(r => { signalDone = r })
  c.enqueueProjectJob('p', 'explicit', async () => { signalDone() })
  release()
  await drained
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
  assert.equal(JSON.stringify(events), JSON.stringify(['explicit-running-start', 'explicit-running-end', 'watcher-1', 'safety', 'explicit-queued']))
})

test('old watcher task is invalidated after stop/restart; current watcher task runs', async () => {
  const src = fs.readFileSync(require('node:path').join(root, 'src/main/workers/fastContext-worker.ts'), 'utf8')
  assert.match(src, /if \(!watcherState \|\| _watchStates\.get\(projectId\) !== watcherState\) return/)
  assert.match(src, /_watchStates\.delete\(projectId\)\s*if \(state\.debounceTimer\)/)
})

test('semantic foreground wait gates page SELECT, skipped rows and orphan cleanup, and requires 2s idle', () => {
  const src = fs.readFileSync(require('node:path').join(root, 'src/core/memory/semanticIndex.ts'), 'utf8')
  assert.match(src, /_foregroundQuietUntil = Date\.now\(\) \+ 2_000/)
  assert.match(src, /if \(Date\.now\(\) >= _foregroundQuietUntil\) return true/)
  assert.match(src, /if \(!await waitForForegroundIdle\(\)\) return stats\s*const rows = fetchSourcePage/)
  assert.match(src, /existing\.content_hash === hash[\s\S]*if \(!await waitForForegroundIdle\(\)\) return stats[\s\S]*stats\.skipped\+\+/)
  assert.match(src, /if \(!await waitForForegroundIdle\(\)\) return stats\s*const orphans = cleanupOrphans/)
  assert.match(src, /stopSemanticIndexer\(\): void \{\s*_stopRequested = true/)
})

test('usage token LRU source invokes tiktoken with allowed special token array; exact count matches installed API', () => {
  const src = fs.readFileSync(require('node:path').join(root, 'src/core/tokens/usageTracker.ts'), 'utf8')
  assert.match(src, /encode\(text, \[\], \['all'\]\)/)
  assert.match(src, /TOKEN_CACHE_MAX_ENTRIES = 500/)
  assert.match(src, /TOKEN_CACHE_MAX_BYTES = 4 \* 1024 \* 1024/)
  assert.match(src, /_tokenCache\.delete\(text\)[\s\S]*_tokenCache\.set\(text, cached\)/)
  const encoder = getEncoding('cl100k_base')
  const text = 'ordinary text <|endoftext|>'
  assert.throws(() => encoder.encode(text, [], 'all'), /special token/i)
  const exact = encoder.encode(text, [], ['all']).length
  assert.equal(exact, 8)
  assert.equal(encoder.encode(text, [], ['all']).length, exact)
})
