/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, console, process, AbortController, setTimeout */
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const ts = require('typescript')
const moduleObject = { exports: {} }
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync('src/core/agent/browserWorkerBroker.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(require, moduleObject, moduleObject.exports)
const { browserOperationTimeout, requestBrowserOperation, attachBrowserWorkerBroker, disposeBrowserWorkerBroker } = moduleObject.exports
async function run() {
  assert.equal(browserOperationTimeout({ action: 'evaluate' }), 120000)
  assert.equal(browserOperationTimeout({ action: 'evaluate', timeoutMs: 500 }), 500)
  assert.equal(browserOperationTimeout({ action: 'snapshot', args: { timeout_ms: 800 } }), 800)
  const handlers = new Map(); let sent
  const abort = new AbortController()
  const reply = requestBrowserOperation({ action: 'snapshot', tabId: 't' }, handlers, m => { sent = m }, abort.signal)
  assert.equal(handlers.size, 1)
  handlers.get(sent.replyId)({ result: { success: true, output: 'ok' } })
  assert.equal((await reply).output, 'ok'); assert.equal(handlers.size, 0)
  const cancel = new AbortController(); const messages = []
  const pending = requestBrowserOperation({ action: 'wait' }, handlers, m => messages.push(m), cancel.signal)
  cancel.abort(); assert.equal((await pending).success, false); assert.equal(handlers.size, 0)
  assert.equal(messages.at(-1).type, 'browser_op_cancel')
  const worker = new EventEmitter(); const replies = []; worker.postMessage = m => replies.push(m)
  let operationSignal; let finish
  attachBrowserWorkerBroker(worker, async (p, s) => { operationSignal = s; assert.equal(p.args.source, 'document.title'); return new Promise(r => { finish = r }) })
  worker.emit('message', { type: 'browser_op', replyId: 'x', payload: { action: 'evaluate', args: { source: 'document.title' } } })
  await new Promise(r => setTimeout(r, 0))
  disposeBrowserWorkerBroker(worker); assert.equal(operationSignal.aborted, true)
  finish({ success: true }); await new Promise(r => setTimeout(r, 0))
  assert.equal(replies.length, 0); assert.equal(worker.listenerCount('message'), 0)
  console.log('Browser broker: timeout policy, reply cleanup, cancellation, stop and late replies passed')
}
run().catch(e => { console.error(e); process.exitCode = 1 })
