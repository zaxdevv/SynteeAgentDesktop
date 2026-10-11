/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, AbortController, console, process */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const source = fs.readFileSync('src/core/agent/toolDispatcher.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', compiled)(id => {
  if (id === '../tools' || id === '../context/contextManager' || id === '../context/fastContext') return {}
  if (id.endsWith('secretsSection')) return { SECRET_PLACEHOLDER_PREFIX: '${{', SECRET_PLACEHOLDER_SUFFIX: '}}' }
  return require(id)
}, mod, mod.exports)
const dispatcher = new mod.exports.ToolDispatcher({ store: { get: () => undefined } })
async function run() {
  let calls = 0
  let payload
  const callbacks = { onBrowserAction: async p => { calls++; payload = p; return { success: true, output: 'OK' } } }
  await dispatcher.executeTool('browser_evaluate', { source: 'document.title', tab_id: 't1', frame_id: 8, timeout_ms: 1500 }, callbacks)
  assert.equal(calls, 1)
  assert.equal(payload.action, 'evaluate')
  assert.equal(payload.tabId, 't1')
  assert.equal(payload.frameId, 8)
  assert.equal(payload.timeoutMs, 1500)
  assert.equal(payload.source, 'document.title')
  assert.equal(payload.args.source, 'document.title')
  const before = calls
  const dry = await dispatcher.executeTool('browser_click', { locator: { type: 'role', value: 'button', name: 'Submit' } }, callbacks, true)
  assert.equal(dry.success, true)
  assert.equal(calls, before)
  const c = new AbortController(); c.abort()
  assert.equal((await dispatcher.executeTool('browser_fill', { text: 'x' }, { ...callbacks, signal: c.signal })).success, false)
  assert.equal(calls, before)
  dispatcher.secretValues = new Map([['TOKEN', 'fixture-secret-123']])
  for (const [name, args] of [
    ['browser_evaluate', { source: 'fetch("${{TOKEN}}")' }],
    ['browser_add_script', { source: 'console.log("${{TOKEN}}")' }],
    ['browser_wait_for', { condition: 'function', value: 'localStorage.setItem("token","${{TOKEN}}")' }],
  ]) {
    const result = await dispatcher.executeTool(name, args, callbacks)
    assert.equal(result.success, false, name)
    assert.equal(calls, before)
  }
  const redacted = await dispatcher.executeTool('browser_storage', {}, { onBrowserAction: async () => ({ success: true, output: 'fixture-secret-123' }) })
  assert.equal(redacted.output, '${{TOKEN}}')
  const error = await dispatcher.executeTool('browser_type', {}, { onBrowserAction: async () => ({ success: false, error: 'fixture-secret-123' }) })
  assert.equal(error.error, '${{TOKEN}}')
  const image = await dispatcher.executeTool('browser_screenshot', {}, { onBrowserAction: async () => ({ success: true, imageBase64: 'YWJj' }) })
  assert.equal(image.imageParts[0].image_url.url, 'data:image/png;base64,YWJj')
  console.log('Browser dispatcher: argument forwarding, dry-run, abort, secret protection, errors and vision passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
