/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, __dirname, process, console, AbortController */
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.resolve(__dirname, '../src/main/browser/BrowserExtras.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
const loaded = new Module(filename, module)
loaded.filename = filename
loaded.paths = module.paths
const helperFilename = path.resolve(__dirname, '../src/main/browser/accessibility.ts')
const helper = new Module(helperFilename, module)
helper.filename = helperFilename
helper.paths = module.paths
helper._compile(ts.transpileModule(fs.readFileSync(helperFilename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, helperFilename)
const originalRequire = loaded.require.bind(loaded)
loaded.require = id => id === './accessibility' ? helper.exports : originalRequire(id)
loaded._compile(compiled, filename)
const { BrowserExtras } = loaded.exports
function mock(external = false) {
  const wc = new EventEmitter()
  wc.url = 'https://example.test/private?token=secret'
  wc.getURL = () => wc.url
  wc.isDestroyed = () => false
  wc.mainFrame = { framesInSubtree: [] }
  wc.setUserAgent = ua => { wc.ua = ua }
  wc.setZoomFactor = factor => { wc.factor = factor }
  wc.getZoomFactor = () => wc.factor ?? 1
  wc.debugger = new EventEmitter()
  const d = wc.debugger
  d.attached = external
  d.calls = []
  d.isAttached = () => d.attached
  d.attach = version => { assert.equal(version, '1.3'); d.attached = true }
  d.detach = () => { d.attached = false; d.emit('detach', {}, 'test') }
  d.sendCommand = async (method, args) => {
    d.calls.push({ method, args })
    if (method === 'Runtime.evaluate') return args.returnByValue ? { result: { value: { exists: true, value: '[masked]' } } } : { result: { objectId: 'input' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: { valid: true, multiple: true } } }
    if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Nodes', value: 42 }] }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [
      { role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'AXPASSWORDSECRET' }, properties: [{ name: 'protected', value: { value: true } }] },
      { role: { value: 'button' }, name: { value: 'Submit' } }
    ] }
    return {}
  }
  wc.session = new EventEmitter()
  wc.session.cookies = {
    get: async () => [{ name: 'token', value: 'secret', hostOnly: true, domain: 'example.test', path: '/', secure: true },
      { name: 'shared', value: 'othersecret', hostOnly: false, domain: '.example.test', path: '/' }],
    set: async value => { wc.cookieSet = value },
    remove: async (url, name) => { wc.cookieRemoved = { url, name } }
  }
  return wc
}
function context(confirm = async () => true) { return { signal: new AbortController().signal, confirm } }
async function run(wc, action, args = {}, ctx = context()) { return BrowserExtras.execute(wc, { action, args }, ctx) }
async function main() {
  const wc = mock()
  BrowserExtras.attach(wc)
  BrowserExtras.attach(wc)
  assert.equal(wc.debugger.listenerCount('message'), 1)
  assert.equal(wc.session.listenerCount('will-download'), 1)
  assert.equal(await run(wc, 'navigate'), undefined)
  for (let i = 0; i < 320; i++) {
    wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'SECRET' }] })
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', { requestId: i, request: {
      method: 'GET', url: 'https://user:password@example.test/secret?token=SECRET',
      headers: { Authorization: 'SECRET', Cookie: 'SECRET', 'Content-Type': 'application/json' }
    } })
  }
  let r = await run(wc, 'console')
  assert.equal(JSON.parse(r.output).events.length, 300)
  assert.ok(!r.output.includes('SECRET'))
  r = await run(wc, 'network')
  assert.equal(JSON.parse(r.output).events.length, 300)
  assert.ok(!r.output.includes('SECRET') && !r.output.includes('password'))
  assert.ok(r.output.includes('https://example.test'))
  await run(wc, 'network', { operation: 'clear' })
  assert.equal(JSON.parse((await run(wc, 'network')).output).events.length, 0)
  wc.debugger.emit('message', {}, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'SECRET', url: 'https://example.test/SECRET', lineNumber: 4 } })
  assert.ok(!(await run(wc, 'errors')).output.includes('SECRET'))
  await run(wc, 'trace_start')
  for (let i = 0; i < 350; i++) wc.debugger.emit('message', {}, 'Network.loadingFailed', { requestId: i, errorText: 'SECRET' })
  const trace = JSON.parse((await run(wc, 'trace_stop')).output)
  assert.equal(trace.retained, 300)
  assert.equal(trace.dropped, 50)
  assert.equal(trace.counts['Network.loadingFailed'], 300)
  wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'SECRET', defaultPrompt: 'SECRET', url: wc.url })
  assert.ok(!(await run(wc, 'dialog')).output.includes('SECRET'))
  assert.equal((await run(wc, 'dialog', { operation: 'dismiss' }, context(async () => false))).success, false)
  await run(wc, 'dialog', { operation: 'accept', prompt_text: 'answer' })
  assert.equal(wc.debugger.calls.at(-1).method, 'Page.handleJavaScriptDialog')
  wc.debugger.emit('message', {}, 'Page.javascriptDialogClosed', { result: true })
  assert.equal((await run(wc, 'dialog', { operation: 'accept' })).success, false)
  assert.equal((await run(wc, 'cookies', {}, context(async () => false))).success, false)
  r = await run(wc, 'cookies')
  assert.ok(r.output.includes('[masked]') && !r.output.includes('secret'))
  assert.equal(JSON.parse(r.output).length, 1)
  assert.ok((await run(wc, 'cookies', { reveal: true })).output.includes('secret'))
  await run(wc, 'cookies', { operation: 'set', name: 'n', value: 'secret', domain: '.attacker.test' })
  assert.equal(wc.cookieSet.url, 'https://example.test/')
  assert.equal(wc.cookieSet.domain, undefined)
  const callsBefore = wc.debugger.calls.length
  assert.equal((await run(wc, 'storage', { operation: 'set', key: 'password', value: 'secret' }, context(async () => false))).success, false)
  assert.equal(wc.debugger.calls.length, callsBefore)
  await run(wc, 'storage', { operation: 'get', key: 'k' })
  const evaluation = wc.debugger.calls.at(-1)
  assert.equal(evaluation.args.awaitPromise, true)
  assert.ok(evaluation.args.expression.includes('location.origin'))
  assert.equal((await run(wc, 'clear_cache', {}, context(async () => { wc.url = 'https://other.test/'; return true }))).success, false)
  wc.url = 'https://example.test/'
  await run(wc, 'clear_cache')
  assert.deepEqual(wc.debugger.calls.at(-1), { method: 'Storage.clearDataForOrigin', args: { origin: 'https://example.test', storageTypes: 'cache_storage' } })
  await run(wc, 'zoom', { factor: 1.5 })
  assert.equal(wc.factor, 1.5)
  assert.equal((await run(wc, 'zoom', { factor: 10 })).success, false)
  await run(wc, 'set_user_agent', { user_agent: 'Test Agent' })
  assert.equal(wc.ua, 'Test Agent')
  assert.ok((await run(wc, 'performance')).output.includes('Nodes'))
  const ax = await run(wc, 'accessibility', { cdp_frame_id: 'raw-cdp-frame', max_nodes: 1, reveal: true })
  assert.equal(ax.success, true)
  assert.deepEqual(wc.debugger.calls.at(-1), { method: 'Accessibility.getFullAXTree', args: { frameId: 'raw-cdp-frame' } })
  assert.equal(JSON.parse(ax.output).nodes.length, 1)
  assert.equal(JSON.parse(ax.output).truncated, true)
  assert.ok(!ax.output.includes('AXPASSWORDSECRET'))
  assert.equal((await run(wc, 'accessibility', { max_nodes: -1 })).success, false)
  const axLifecycle = mock(true)
  assert.equal((await run(axLifecycle, 'accessibility')).success, true)
  axLifecycle.debugger.detach()
  assert.equal((await run(axLifecycle, 'accessibility')).success, true)
  assert.equal(axLifecycle.debugger.listenerCount('message'), 1)
  BrowserExtras.detach(axLifecycle)
  assert.equal(axLifecycle.debugger.attached, false)
  assert.equal((await run(wc, 'permissions', { name: 'camera', operation: 'request' })).success, true)
  assert.ok(wc.debugger.calls.at(-1).args.expression.includes('getTracks'))
  assert.equal((await run(wc, 'permissions', { name: 'clipboard-read', operation: 'request' })).success, false)
  // A named permission defaults to query; no-name list returns the supported names.
  assert.equal((await run(wc, 'permissions', { name: 'camera' })).success, true)
  assert.equal((await run(wc, 'permissions')).success, true)
  assert.equal((await run(wc, 'upload', { paths: ['relative.txt'], selector: 'input' })).success, false)
  let confirmed
  const uploaded = await run(wc, 'upload', { paths: [filename], selector: 'input[type=file]' }, context(async (_title, details) => { confirmed = details; return true }))
  assert.equal(uploaded.success, true)
  assert.deepEqual(confirmed.paths, [filename])
  assert.ok(wc.debugger.calls.some(c => c.method === 'DOM.setFileInputFiles'))
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'syntee-upload-'))
  const tempFile = path.join(tempDir, 'approved.txt')
  try {
    fs.writeFileSync(tempFile, 'before')
    const uploadsBefore = wc.debugger.calls.filter(c => c.method === 'DOM.setFileInputFiles').length
    assert.equal((await run(wc, 'upload', { paths: [tempFile], selector: 'input' }, context(async () => {
      fs.writeFileSync(tempFile, 'change'); return true
    }))).success, false)
    assert.equal(wc.debugger.calls.filter(c => c.method === 'DOM.setFileInputFiles').length, uploadsBefore)
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
  // args cannot override parent-owned frame/snapshot identity.
  await run(wc, 'upload', { paths: [filename], selector: 'input', snapshotId: 'parent', args: { snapshotId: 'evil' } })
  const identityExpression = wc.debugger.calls.filter(c => c.method === 'Runtime.evaluate').at(-1).args.expression
  assert.ok(identityExpression.includes('"parent"') && !identityExpression.includes('"evil"'))
  const item = new EventEmitter()
  item.getFilename = () => 'SECRET-password.zip'
  item.getTotalBytes = () => 100
  item.getReceivedBytes = () => 75
  wc.session.emit('will-download', {}, item, wc)
  item.emit('updated', {}, 'progressing')
  r = await run(wc, 'downloads')
  assert.ok(r.output.includes('download.zip') && !r.output.includes('SECRET'))
  item.emit('done', {}, 'completed')
  assert.equal(item.listenerCount('updated'), 0)
  // Detailed capture is prospective: neither denial nor pending confirmation stores values.
  const diagnostic = mock()
  await run(diagnostic, 'console')
  diagnostic.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', url: diagnostic.url } })
  diagnostic.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 7, auxData: { isDefault: true, frameId: 'main' } } })
  const emitConsole = message => diagnostic.debugger.emit('message', {}, 'Runtime.consoleAPICalled', {
    executionContextId: 7, type: 'error', args: [{ type: 'string', value: message }], stackTrace: { callFrames: [{ functionName: 'render', url: 'https://example.test/app.js?token=STACKSECRET', lineNumber: 5 }] }
  })
  emitConsole('BEFORE_APPROVAL')
  assert.equal((await run(diagnostic, 'console', { reveal: true }, context(async () => { emitConsole('WHILE_PENDING'); return false }))).success, false)
  let events = JSON.parse((await run(diagnostic, 'console')).output).events
  assert.ok(events.every(e => e.message === undefined))
  await run(diagnostic, 'console', { reveal: true })
  emitConsole('Render failed password=PASSWORDSECRET token=TOKENSECRET Bearer BEARERSECRET https://user:URLSECRET@example.test/api?access_token=QUERYSECRET&mode=fast')
  diagnostic.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 8, auxData: { isDefault: true, frameId: 'cross-frame' } } })
  diagnostic.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'cross-frame', parentId: 'main', url: 'https://cross.example.test/frame' } })
  diagnostic.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { executionContextId: 8, type: 'error', args: [{ type: 'string', value: 'CROSS_CONSOLE_SECRET' }], stackTrace: { callFrames: [{ functionName: 'cross', url: 'https://cross.example.test/private/CROSS_STACK_SECRET' }] } })
  diagnostic.debugger.emit('message', {}, 'Runtime.exceptionThrown', { exceptionDetails: { executionContextId: 8, text: 'CROSS_ERROR_SECRET', url: 'https://cross.example.test/private/CROSS_ERROR_SECRET' } })
  diagnostic.debugger.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'cross', request: { method: 'GET', url: 'https://cross.example.test/private/CROSS_NETWORK_SECRET?value=secret' } })
  const crossEvents = JSON.parse((await run(diagnostic, 'console')).output).events
  assert.equal(crossEvents.at(-1).message, undefined)
  assert.equal(JSON.parse((await run(diagnostic, 'errors')).output).events.at(-1).message, undefined)
  assert.ok(!JSON.stringify(JSON.parse((await run(diagnostic, 'network')).output)).includes('CROSS_NETWORK_SECRET'))
  let details = await run(diagnostic, 'console')
  assert.ok(details.output.includes('Render failed'))
  for (const secret of ['PASSWORDSECRET', 'TOKENSECRET', 'BEARERSECRET', 'URLSECRET', 'QUERYSECRET', 'STACKSECRET']) assert.ok(!details.output.includes(secret), secret)
  await run(diagnostic, 'console', { clear: true })
  assert.equal(JSON.parse((await run(diagnostic, 'console')).output).events.length, 0)
  emitConsole('x'.repeat(20000))
  assert.equal(JSON.parse((await run(diagnostic, 'console')).output).events[0].message.length, 2048)
  diagnostic.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/new-page' } })
  emitConsole('AFTER_SAME_ORIGIN_NAVIGATION')
  assert.equal(JSON.parse((await run(diagnostic, 'console')).output).events.at(-1).message, undefined)
  diagnostic.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 9, auxData: { isDefault: true, frameId: 'main' } } })
  const emitReapproved = () => diagnostic.debugger.emit('message', {}, 'Runtime.consoleAPICalled', {
    executionContextId: 9, type: 'error', args: [{ type: 'string', value: 'REAPPROVED' }]
  })
  await run(diagnostic, 'console', { reveal: true })
  emitReapproved()

  assert.equal(JSON.parse((await run(diagnostic, 'console')).output).events.at(-1).message, 'REAPPROVED')
  await run(diagnostic, 'errors', { reveal: true })
  diagnostic.debugger.emit('message', {}, 'Runtime.exceptionThrown', { exceptionDetails: {
    executionContextId: 9, text: 'Uncaught', exception: { description: 'TypeError: render failed secret=ERRORSECRET' },
    stackTrace: { callFrames: Array.from({ length: 20 }, () => ({ functionName: 'render', url: 'https://example.test/app.js' })) }
  } })
  details = await run(diagnostic, 'errors')
  assert.ok(details.output.includes('TypeError: render failed') && !details.output.includes('ERRORSECRET'))
  assert.equal(JSON.parse(details.output).events.at(-1).stack.length, 8)
  await run(diagnostic, 'errors', { clear: true })
  assert.equal(JSON.parse((await run(diagnostic, 'errors')).output).events.length, 0)
  await run(diagnostic, 'network', { reveal: true })
  diagnostic.debugger.emit('message', {}, 'Network.requestWillBeSent', { requestId: '1', request: {
    method: 'GET', url: 'https://user:URLSECRET@example.test/api/search?token=NETSECRET&mode=fast#SECRET',
    headers: { Authorization: 'HEADERSECRET', Cookie: 'COOKIESECRET' }, postData: 'BODYSECRET'
  } })
  details = await run(diagnostic, 'network', { clear: true })
  assert.ok(details.output.includes('/api/search') && details.output.includes('mode=fast'))
  for (const secret of ['NETSECRET', 'URLSECRET', 'HEADERSECRET', 'COOKIESECRET', 'BODYSECRET']) assert.ok(!details.output.includes(secret))
  assert.equal(JSON.parse((await run(diagnostic, 'network')).output).events.length, 0)
  diagnostic.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'prompt', url: diagnostic.url })
  await run(diagnostic, 'dialog', { action: 'accept', text: 'alias answer' })
  assert.deepEqual(diagnostic.debugger.calls.at(-1).args, { accept: true, promptText: 'alias answer' })
  await run(diagnostic, 'cookies', { operation: 'remove', name: 'token' })
  assert.equal(diagnostic.cookieRemoved.name, 'token')
  diagnostic.debugger.detach()
  const beforeReconnect = diagnostic.debugger.calls.length
  assert.equal((await run(diagnostic, 'console')).success, true)
  assert.equal(diagnostic.debugger.attached, true)
  assert.ok(diagnostic.debugger.calls.slice(beforeReconnect).some(c => c.method === 'Runtime.enable'))
  assert.equal(diagnostic.debugger.listenerCount('message'), 1)
  assert.equal(diagnostic.session.listenerCount('will-download'), 1)
  emitConsole('AFTER_DISCONNECT')
  events = JSON.parse((await run(diagnostic, 'console')).output).events
  assert.equal(events.at(-1).message, undefined)
  diagnostic.debugger.detach()
  diagnostic.debugger.attach = () => { throw new Error('cannot reconnect') }
  assert.equal((await run(diagnostic, 'network')).success, false)
  BrowserExtras.detach(diagnostic)
  // Execute the upload resolution expression against a real JS world, rather than returning a fake node.
  const vm = require('node:vm')
  const attrs = { 'aria-labelledby': 'first second' }
  const first = { textContent: ' Upload\n' }, second = { textContent: ' documents ' }
  const shadow = { children: [], getElementById: id => ({ first, second })[id] }
  const target = { isConnected: true, tagName: 'INPUT', type: 'file', id: 'file', textContent: '', children: [], labels: [],
    getAttribute: key => attrs[key] ?? null, hasAttribute: key => key in attrs,
    getRootNode: () => shadow, matches: selector => selector === 'input' || selector === 'input[type=file]',
    closest: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }), contains: node => node === target }
  shadow.children = [target]
  const host = { tagName: 'DIV', children: [], shadowRoot: shadow, getAttribute: () => null,
    hasAttribute: () => false, getRootNode: () => world.document, matches: () => false, closest: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }) }
  const world = { window: {}, document: { children: [host], getElementById: () => null },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) }
  // Generate the nonce ref using the actual latest snapshot implementation.
  const pageFilename = path.resolve(__dirname, '../src/main/browser/pageAutomation.ts')
  const page = new Module(pageFilename, module)
  page.filename = pageFilename; page.paths = module.paths
  page._compile(ts.transpileModule(fs.readFileSync(pageFilename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, pageFilename)
  const snapshotWC = { mainFrame: { executeJavaScript: expression => vm.runInNewContext(expression, world) } }
  const snapshotText = await page.exports.snapshot(snapshotWC, {})
  const fresh = world.window.__synteeAutomation.snapshot
  const ref = [...world.window.__synteeAutomation.refs.keys()][0]
  assert.ok(ref.startsWith('r-') && snapshotText.includes(ref))
  assert.equal(world.window.__synteeAutomation.refs.get(ref).signature, 'INPUT|file|Upload documents|')
  const strict = mock()
  const originalCommand = strict.debugger.sendCommand
  strict.debugger.sendCommand = async (method, args) => {
    if (method === 'Runtime.evaluate' && args.returnByValue === false) {
      try { const node = vm.runInNewContext(args.expression, world); return { result: node ? { objectId: 'input' } : {} } }
      catch { return { exceptionDetails: {} } }
    }
    return originalCommand(method, args)
  }
  assert.equal((await run(strict, 'upload', { paths: [filename], by: 'css', value: 'input', snapshot_id: fresh })).success, true)
  assert.equal((await run(strict, 'upload', { paths: [filename], ref, snapshot_id: 'stale' })).success, false)
  assert.equal((await run(strict, 'upload', { paths: [filename], selector: 'input', snapshot_id: 'stale' })).success, false)
  assert.equal((await run(strict, 'upload', { paths: [filename], selector: 'input', frame_id: 'missing' })).success, false)
  assert.equal((await run(strict, 'upload', { paths: [filename], ref, snapshot_id: fresh })).success, true)
  assert.equal((await run(strict, 'upload', { paths: [filename], locator: { type: 'role', value: 'textbox', name: ' Upload   documents ', exact: true } })).success, true)
  assert.equal((await run(strict, 'upload', { paths: [filename], locator: { type: 'role', value: 'textbox', name: 'wrong', exact: true } })).success, false)
  second.textContent = 'changed'
  assert.equal((await run(strict, 'upload', { paths: [filename], ref, snapshot_id: fresh })).success, false)
  second.textContent = ' documents '
  // All associated labels and full names (not the old truncated 80 characters).
  delete attrs['aria-labelledby']
  target.labels = [{ textContent: ' First ' }, { textContent: 'Second ' + 'x'.repeat(100) }]
  await page.exports.snapshot(snapshotWC, {})
  const labelsRef = [...world.window.__synteeAutomation.refs.keys()][0]
  assert.equal((await run(strict, 'upload', { paths: [filename], ref: labelsRef })).success, true)
  assert.equal((await run(strict, 'upload', { paths: [filename], locator: { type: 'label', value: 'First', exact: true } })).success, true)
  shadow.children.push({ ...target, id: 'duplicate' })
  assert.equal((await run(strict, 'upload', { paths: [filename], selector: 'input' })).success, false)
  shadow.children.pop()
  target.id = 'replaced'
  assert.equal((await run(strict, 'upload', { paths: [filename], ref: labelsRef })).success, false)
  BrowserExtras.detach(strict)
  const controller = new AbortController(); controller.abort()
  assert.equal((await run(wc, 'zoom', {}, { ...context(), signal: controller.signal })).success, false)
  BrowserExtras.detach(wc)
  assert.equal(wc.debugger.attached, false)
  assert.equal(wc.debugger.listenerCount('message'), 0)
  assert.equal(wc.session.listenerCount('will-download'), 0)
  const external = mock(true)
  BrowserExtras.attach(external)
  await run(external, 'console')
  BrowserExtras.detach(external)
  assert.equal(external.debugger.attached, true)
  console.log('BrowserExtras: all mocked tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
