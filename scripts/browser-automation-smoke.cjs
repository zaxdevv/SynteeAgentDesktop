/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, __filename, process, console, Buffer, AbortController, setTimeout, clearTimeout, setImmediate */
'use strict'

// Run: node scripts/browser-automation-smoke.cjs
// Never imports main/index.ts. Only this script and OS-temp fixtures are written.
// Uses a separate Electron process, fresh userData/sessionData and sandboxed hidden
// windows. No remote debugger port; debugger extras use Electron's local pipe.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const ROOT = path.resolve(__dirname, '..')
const PREFIX = 'syntee-browser-smoke-'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function launch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  const report = path.join(root, 'report.json')
  const env = { ...process.env, SYNTEE_SMOKE_ROOT: root, SYNTEE_SMOKE_REPORT: report }
  delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawn(require('electron'), [__filename, '--smoke-child'], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env
  })
  let stderr = ''; let done = false
  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-24000) })
  // This watchdog terminates only the isolated child spawned above, never other
  // Electron instances. Temp profile is removed after that child's exit.
  const watchdog = setTimeout(() => child.kill(), 100000)
  const finish = (code, error) => {
    if (done) return
    done = true; clearTimeout(watchdog)
    let result
    try { result = JSON.parse(fs.readFileSync(report, 'utf8')) } catch { /* startup failed */ }
    if (result) {
      for (const entry of result.results) {
        const detail = (entry.error || '').split('\n    at ')[0].replace(/\s+/g, ' ').slice(0, 480)
        console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.ok ? '' : ': ' + detail}`)
      }
      console.log(`Browser automation smoke: ${result.passed}/${result.results.length} passed; ${result.failed} failed; 0 skipped`)
      if (result.fatal) console.error(result.fatal)
    } else console.error(`Smoke child produced no report (${error?.message || 'exit ' + code}).`)
    if (stderr && (!result || result.failed || result.fatal)) console.error(stderr)
    process.exitCode = code === 0 && result && result.failed === 0 && !result.fatal ? 0 : 1
    // Safety: remove only this freshly created directory inside the OS tmp folder.
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith(PREFIX)) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) }
      catch (cleanupError) { console.error(`Temp cleanup failed: ${cleanupError.message}`); process.exitCode = 1 }
    }
  }
  child.once('error', error => finish(1, error))
  child.once('exit', code => finish(code))
}

async function run() {
  const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
  const root = process.env.SYNTEE_SMOKE_ROOT
  assert.ok(root && path.basename(root).startsWith(PREFIX), 'Missing isolated fixture root')
  app.setPath('userData', path.join(root, 'userData'))
  app.setPath('sessionData', path.join(root, 'sessionData'))
  app.commandLine.appendSwitch('disable-background-networking')
  const results = []; const windows = []; const requestLog = []; const blocked = []
  let fatal; let server; let manager; let extras
  let restoreLoader = () => {}; let approve = true
  const confirmations = []
  // No auto-exit on the last window: report/cleanup must complete first.
  app.on('window-all-closed', () => {})
  const test = async (name, fn) => {
    console.log('RUN ' + name)
    try { await fn(); results.push({ name, ok: true }); console.log('OK ' + name) }
    catch (error) { results.push({ name, ok: false, error: error.stack || String(error) }); console.log('ERROR ' + name + ': ' + String(error)) }
  }
  const eventually = async (fn, timeout = 1500) => {
    const end = Date.now() + timeout
    while (!await fn()) { if (Date.now() >= end) throw new Error('Observable page state did not settle'); await delay(20) }
  }
  try {
    await app.whenReady()
    // A source-first TS loader avoids stale .js mirrors. Mock DB/logger before any
    // import is evaluated, and reject accidental production database initialization.
    const ts = require('typescript'); const originalLoad = Module._load
    const originalTs = Module._extensions['.ts']
    Module._extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename)
    Module._load = function (request, parent, isMain) {
      let candidate = request
      if (parent && (request.startsWith('.') || path.isAbsolute(request))) {
        candidate = path.resolve(path.dirname(parent.filename), request)
        const normalized = candidate.split(path.sep).join('/').replace(/\.(ts|js)$/, '')
        if (normalized.endsWith('/src/core/logger')) return { log() {} }
        if (normalized.endsWith('/src/core/db/chats')) return { getChatBrowserMode: () => true, setChatBrowserMode() {} }
        if (normalized.includes('/src/core/db/')) throw new Error(`Unexpected real DB dependency: ${candidate}`)
        if (!path.extname(candidate) && fs.existsSync(candidate + '.ts')) candidate += '.ts'
      }
      return originalLoad.call(this, candidate, parent, isMain)
    }
    restoreLoader = () => { Module._load = originalLoad; Module._extensions['.ts'] = originalTs }
    const backend = require(path.join(ROOT, 'src/main/managers/BrowserManager.ts'))
    manager = backend.browserManager
    extras = require(path.join(ROOT, 'src/main/browser/BrowserExtras.ts')).BrowserExtras
    backend.setBrowserExtras(extras)

    const fixture = label => `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
      <style>body{font:16px sans-serif;margin:20px}input,button,select{margin:4px}#shadow{display:block;width:200px;height:40px}iframe{height:100px}</style></head><body>
      <h1>${label}</h1><input id="name" aria-label="Name" value="old"><input id="nextinput" aria-label="Next input">
      <button id="native" type="button">Native</button><label><input id="checkbox" type="checkbox" aria-label="Accept">Accept</label>
      <select id="choice" aria-label="Choice"><option value="one">One</option><option value="two">Two</option></select>
      <input id="file" type="file" aria-label="Upload"><div id="shadow"></div><div id="result"></div>
      <form id="form"><button id="submit" type="submit">Submit</button></form><iframe name="child" src="/frame"></iframe>
      <script>
      window.events=[]; document.querySelector('#native').onclick=e=>events.push({name:'native',trusted:e.isTrusted});
      document.querySelector('#form').onsubmit=e=>{e.preventDefault();events.push({name:'submit'})};
      const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<button>Shadow Button</button>';
      shadow.querySelector('button').onclick=()=>document.querySelector('#result').textContent='shadow-click';
      </script></body></html>`
    server = require('node:http').createServer((req, res) => {
      requestLog.push(req.url)
      res.setHeader('Cache-Control', 'no-store')
      if (req.url.startsWith('/api')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return }
      if (req.url === '/frame') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><button id="framebutton">Frame Button</button>'); return }
      if (req.url === '/slow-script.js') { setTimeout(() => res.end('window.slowLoaded=true'), 220); return }
      if (req.url === '/abort-script.js') { setTimeout(() => res.end('window.abortLoaded=true'), 2000); return }
      if (req.url === '/abort-slow') { res.setHeader('content-type', 'text/html'); res.end('<h1>Abort fixture</h1><script src="/abort-script.js"></script>'); return }
      if (req.url === '/slow') { res.setHeader('content-type', 'text/html'); res.end('<h1>Slow fixture</h1><script src="/slow-script.js"></script>'); return }
      if (req.url === '/first' || req.url === '/second') { res.setHeader('content-type', 'text/html'); res.end(fixture(req.url === '/first' ? 'First' : 'Second')); return }
      res.statusCode = 404; res.end('not found')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const partition = 'persist:isolated-browser-smoke'
    const makeWindow = () => {
      const win = new BrowserWindow({ show: false, width: 960, height: 720, webPreferences: {
        partition, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false
      } })
      windows.push(win); return win
    }
    const first = makeWindow(); const second = makeWindow()
    first.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(base + '/') || details.url === 'about:blank' || details.url.startsWith('data:')
      if (!allowed) blocked.push(details.url)
      callback({ cancel: !allowed })
    })
    first.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    manager.setWindowGetter(() => first)
    // Intercept ONLY fixture main-window outbound confirmation IPC. Responses go
    // through the real manager listener; no production confirmation method is mocked.
    const originalSend = first.webContents.send.bind(first.webContents)
    first.webContents.send = (channel, ...args) => {
      if (channel === 'agent:confirm') {
        const payload = args[0]; confirmations.push(payload)
        setImmediate(() => ipcMain.emit(`agent:confirm:response:${payload.reqId}`, { sender: first.webContents }, approve))
        return
      }
      return originalSend(channel, ...args)
    }
    await first.loadURL(base + '/first'); await second.loadURL(base + '/second')
    manager.registerTab('one', first.webContents.id); manager.registerTab('two', second.webContents.id); manager.setActiveTab('one')
    const exec = (p, signal) => manager.execute('fixture-chat', { tabId: 'one', ...p }, signal)
    const ok = r => { assert.equal(r.success, true, r.error || r.output || 'operation failed'); return r.output || '' }
    const value = code => first.webContents.executeJavaScript(code, false)
    const click = locator => exec({ action: 'click', locator })
    const refFrom = (snapshot, name) => {
      const line = snapshot.split('\n').find(line => line.includes(`"${name}"`) && /\[ref=/.test(line))
      assert.ok(line, `Missing interactive ref: ${name}`)
      return /\[ref=([^\]]+)/.exec(line)[1]
    }
    const snapshot = async () => ok(await exec({ action: 'snapshot' }))

    await test('snapshot refs unique within and across snapshots; old refs rejected', async () => {
      const a = await snapshot(); const b = await snapshot()
      const aRefs = [...a.matchAll(/\[ref=([^\]]+)\]/g)].map(m => m[1]); const bRefs = [...b.matchAll(/\[ref=([^\]]+)\]/g)].map(m => m[1])
      assert.ok(aRefs.length >= 7, a); assert.equal(new Set(aRefs).size, aRefs.length)
      assert.ok(aRefs.every(ref => !bRefs.includes(ref)), 'A new snapshot must not silently rebind old refs')
      const r = await exec({ action: 'click', ref: refFrom(a, 'Native') }); assert.equal(r.success, false); assert.match(r.error, /stale|snapshot|not found/i)
    })
    await test('refs from another tab cannot target an identically named element', async () => {
      const one = await snapshot()
      const two = ok(await exec({ action: 'snapshot', tabId: 'two' }))
      const oneRef = refFrom(one, 'Native'); const twoRef = refFrom(two, 'Native')
      assert.notEqual(oneRef, twoRef)
      await value('events=[]')
      await second.webContents.executeJavaScript('events=[]', false)
      for (const [tabId, ref] of [['one', twoRef], ['two', oneRef]]) {
        const result = await exec({ action: 'click', tabId, ref })
        assert.equal(result.success, false); assert.match(result.error, /stale|snapshot/i)
      }
      assert.deepEqual(await value('events'), [])
      assert.deepEqual(await second.webContents.executeJavaScript('events', false), [])
    })
    await test('refs and snapshot IDs from a previous document are rejected after reload', async () => {
      const old = await snapshot(); const oldRef = refFrom(old, 'Native')
      const oldId = /Snapshot: (\S+)/.exec(old)[1]
      ok(await exec({ action: 'reload' }))
      // Hidden fixture windows need a compositor frame after reload before native
      // input is routed; document load alone does not guarantee that frame.
      await first.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true })
      const fresh = await snapshot(); const freshRef = refFrom(fresh, 'Native')
      assert.notEqual(oldRef, freshRef)
      for (const payload of [{ ref: oldRef }, { ref: freshRef, snapshotId: oldId }]) {
        const result = await exec({ action: 'click', ...payload })
        assert.equal(result.success, false); assert.match(result.error, /stale|snapshot/i)
      }
      assert.deepEqual(await value('events'), [])
      ok(await exec({ action: 'click', ref: freshRef }))
      await eventually(async () => (await value('events')).length === 1)
      assert.deepEqual(await value('events'), [{ name: 'native', trusted: true }])
    })
    await test('native button role/name locator performs trusted click', async () => {
      await value('events=[]')
      ok(await click({ type: 'role', value: 'button', name: 'Native', exact: true }))
      await eventually(async () => (await value('events')).length > 0)
      assert.deepEqual(await value('events'), [{ name: 'native', trusted: true }])
    })
    await test('open shadow-root native role locator and snapshot', async () => {
      assert.match(await snapshot(), /Shadow Button.*ref=/)
      ok(await click({ type: 'role', value: 'button', name: 'Shadow Button', exact: true }))
      await eventually(async () => await value('document.querySelector("#result").textContent') === 'shadow-click')
    })
    await test('type appends while fill replaces and dispatches input', async () => {
      await value('document.querySelector("#name").value="old";window.inputCount=0;document.querySelector("#name").oninput=()=>inputCount++;void 0')
      const ref = refFrom(await snapshot(), 'Name')
      ok(await exec({ action: 'type', ref, text: 'tail' }))
      assert.equal(await value('document.querySelector("#name").value'), 'oldtail')
      ok(await exec({ action: 'fill', ref, text: 'replacement' }))
      assert.equal(await value('document.querySelector("#name").value'), 'replacement')
      assert.ok(await value('inputCount>=2'))
    })
    await test('check/uncheck and select_option update native state and change events', async () => {
      await value('window.changes=0;document.querySelector("#choice").onchange=()=>changes++;void 0')
      const s = await snapshot(); const checkbox = refFrom(s, 'Accept'); const choice = refFrom(s, 'Choice')
      ok(await exec({ action: 'check', ref: checkbox })); assert.equal(await value('document.querySelector("#checkbox").checked'), true)
      ok(await exec({ action: 'uncheck', ref: checkbox })); assert.equal(await value('document.querySelector("#checkbox").checked'), false)
      ok(await exec({ action: 'select_option', ref: choice, value: 'two' })); assert.equal(await value('document.querySelector("#choice").value'), 'two'); assert.equal(await value('changes'), 1)
    })
    await test('Control+A replaces entire input; Tab advances focus', async () => {
      await value('document.querySelector("#name").value="abcdef"')
      const ref = refFrom(await snapshot(), 'Name')
      ok(await exec({ action: 'focus', ref }))
      ok(await exec({ action: 'press_key', key: 'Control+A' }))
      assert.deepEqual(await value('(()=>{const e=document.querySelector("#name");return [e.selectionStart,e.selectionEnd]})()'), [0, 6])
      ok(await exec({ action: 'press_key', key: 'Tab' }))
      await eventually(async () => await value('document.activeElement.id') === 'nextinput')
    })
    await test('navigation waits for load; back/forward/reload complete before returning', async () => {
      manager.setActiveTab('one')
      ok(await exec({ action: 'navigate', url: base + '/first' }))
      ok(await exec({ action: 'navigate', url: base + '/slow' })); assert.equal(await value('window.slowLoaded'), true)
      ok(await exec({ action: 'back' })); assert.equal(first.webContents.getURL(), base + '/first'); assert.equal(first.webContents.isLoading(), false)
      ok(await exec({ action: 'forward' })); assert.equal(first.webContents.getURL(), base + '/slow'); assert.equal(await value('window.slowLoaded'), true)
      const requests = requestLog.filter(url => url === '/slow-script.js').length
      ok(await exec({ action: 'reload' })); assert.equal(await value('window.slowLoaded'), true)
      assert.equal(requestLog.filter(url => url === '/slow-script.js').length, requests + 1)
    })
    await test('explicit tabs do not follow active-tab switches including in-flight op', async () => {
      await first.loadURL(base + '/first'); await second.loadURL(base + '/second'); manager.setActiveTab('one')
      const pending = exec({ action: 'navigate', tabId: 'two', url: base + '/slow' })
      manager.setActiveTab('two'); ok(await pending)
      assert.equal(first.webContents.getURL(), base + '/first'); assert.equal(second.webContents.getURL(), base + '/slow')
      assert.match(ok(await exec({ action: 'snapshot', tabId: 'one' })), /First/)
      manager.setActiveTab('one')
    })
    await test('evaluate sandbox: Node globals absent; decline prevents side effect', async () => {
      const before = confirmations.length
      approve = false
      try { const r = await exec({ action: 'evaluate', args: { source: 'window.__denied=1' } }); assert.equal(r.success, false); assert.equal(await value('window.__denied'), undefined) }
      finally { approve = true }
      assert.equal(confirmations.length, before + 1)
      assert.deepEqual(JSON.parse(ok(await exec({ action: 'evaluate', args: { source: '[typeof require,typeof process,typeof Buffer]' } }))), ['undefined', 'undefined', 'undefined'])
    })
    await test('submit approval declined then accepted, without duplicate submission', async () => {
      await value('events=[]')
      const ref = refFrom(await snapshot(), 'Submit'); const before = confirmations.length
      approve = false
      try { await exec({ action: 'click', ref }); await delay(50); assert.equal((await value('events')).length, 0) }
      finally { approve = true }
      assert.equal(confirmations.length, before + 1)
      ok(await exec({ action: 'click', ref })); await eventually(async () => (await value('events')).length === 1)
      assert.deepEqual(await value('events'), [{ name: 'submit' }])
    })
    await test('add_style and add_script affect only current document', async () => {
      ok(await exec({ action: 'add_style', args: { source: 'body{background-color:rgb(1,2,3)}' } }))
      assert.equal(await value('getComputedStyle(document.body).backgroundColor'), 'rgb(1, 2, 3)')
      ok(await exec({ action: 'add_script', args: { source: 'window.__smokeScript=7' } })); assert.equal(await value('__smokeScript'), 7)
      await first.loadURL(base + '/first'); assert.equal(await value('window.__smokeScript'), undefined)
    })
    await test('selector wait times out and in-flight wait cancels promptly', async () => {
      const started = Date.now()
      const r = await exec({ action: 'wait_for', args: { condition: 'selector', value: '#never-exists' }, timeoutMs: 200 })
      assert.equal(r.success, false); assert.match(r.error, /timed|abort/i); assert.ok(Date.now() - started < 1200)
      const controller = new AbortController(); const start = Date.now()
      const pending = exec({ action: 'wait', ms: 5000, timeoutMs: 8000 }, controller.signal)
      const timer = setTimeout(() => controller.abort(), 80)
      let canceled
      try { canceled = await pending } finally { clearTimeout(timer) }
      assert.equal(canceled.success, false); assert.match(canceled.error, /abort/i); assert.ok(Date.now() - start < 1200)
      ok(await exec({ action: 'wait', ms: 100 }))
    })
    await test('wait operation deadline enforces timeout, not eventual success', async () => {
      const started = Date.now(); const r = await exec({ action: 'wait', ms: 2000, timeoutMs: 150 })
      assert.equal(r.success, false); assert.match(r.error, /abort|timeout|timed/i); assert.ok(Date.now() - started < 1000)
    })
    await test('frames enumerate and child snapshot works; unsupported child input fails explicitly', async () => {
      await first.loadURL(base + '/first')
      const frames = JSON.parse(ok(await exec({ action: 'frames' })))
      const frame = frames.find(f => f.url === base + '/frame'); assert.ok(frame)
      const s = ok(await exec({ action: 'snapshot', frameId: frame.frameId })); assert.match(s, /Frame Button/)
      const r = await exec({ action: 'click', frameId: frame.frameId, ref: refFrom(s, 'Frame Button') })
      assert.equal(r.success, false); assert.match(r.error, /child|frame|unsupported|not supported/i)
      const unknown = await exec({ action: 'unimplemented_fixture_action' }); assert.equal(unknown.success, false); assert.match(unknown.error, /unknown|unsupported|not implemented/i)
    })
    await test('screenshot is nonempty decodable PNG', async () => {
      const r = await exec({ action: 'screenshot' }); ok(r)
      const png = Buffer.from(r.imageBase64 || '', 'base64'); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      const image = nativeImage.createFromBuffer(png); assert.equal(image.isEmpty(), false); assert.ok(image.getSize().width > 0)
    })
    await test('console/network diagnostics observe real events and omit secrets', async () => {
      ok(await exec({ action: 'console', args: { operation: 'clear' } }))
      ok(await exec({ action: 'network', args: { operation: 'clear' } }))
      await value('console.log("smoke-console-secret");fetch("/api?token=smoke-network-secret",{headers:{Authorization:"smoke-header-secret"}}).then(r=>r.json())')
      const c = ok(await exec({ action: 'console' })); const n = ok(await exec({ action: 'network' }))
      assert.ok(JSON.parse(c).events.length > 0); assert.ok(JSON.parse(n).events.some(e => e.event === 'request'))
      assert.doesNotMatch(c + n, /smoke-console-secret|smoke-network-secret|smoke-header-secret/)
      assert.ok(requestLog.some(url => url.includes('smoke-network-secret')))
    })
    await test('storage/cookie defaults masked; denial prevents mutation', async () => {
      await value('localStorage.setItem("smoke-secret-key","smoke-secret-value");document.cookie="smoke_cookie=smoke-cookie-value; Path=/"')
      const before = confirmations.length
      const s = ok(await exec({ action: 'storage', args: { operation: 'list' } })); assert.doesNotMatch(s, /smoke-secret-key|smoke-secret-value/); assert.match(s, /masked/)
      const c = ok(await exec({ action: 'cookies' })); assert.doesNotMatch(c, /smoke-cookie-value/); assert.match(c, /masked/)
      approve = false
      try { const r = await exec({ action: 'storage', args: { operation: 'set', key: 'denied', value: 'no' } }); assert.equal(r.success, false); assert.equal(await value('localStorage.getItem("denied")'), null) }
      finally { approve = true }
      assert.equal(confirmations.length, before + 3)
    })
    await test('upload exact temp fixture, refusal preserves empty input', async () => {
      await first.loadURL(base + '/first')
      const file = path.join(root, 'fixture.txt'); fs.writeFileSync(file, 'local fixture upload')
      approve = false
      try { const r = await exec({ action: 'upload', args: { paths: [file], selector: '#file' } }); assert.equal(r.success, false); assert.equal(await value('document.querySelector("#file").files.length'), 0) }
      finally { approve = true }
      const before = confirmations.length
      ok(await exec({ action: 'upload', args: { paths: [file], selector: '#file' } }))
      assert.equal(confirmations.length, before + 1); assert.deepEqual(confirmations.at(-1).args.paths, [file])
      assert.deepEqual(await value('(()=>{const f=document.querySelector("#file").files[0];return {name:f.name,size:f.size}})()'), { name: 'fixture.txt', size: 20 })
    })
    await test('password fill/type verified without values in snapshot or inspect', async () => {
      await value('document.body.insertAdjacentHTML("beforeend", \'<input id="password" type="password" aria-label="Password">\');void 0')
      const locator = { type: 'css', value: '#password' }
      const r = await exec({ action: 'fill', locator, text: 'fixture-private-password' }); ok(r)
      ok(await exec({ action: 'type', locator, text: '-tail' }))
      assert.equal(await value('document.querySelector("#password").value'), 'fixture-private-password-tail')
      assert.doesNotMatch(JSON.stringify(r) + await snapshot(), /fixture-private-password/)
      const engine = require(path.join(ROOT, 'src/main/browser/pageAutomation.ts'))
      const state = await engine.inspect(first.webContents, { action: 'type', locator })
      assert.equal(state.password, true); assert.equal(state.value, '')
    })
    await test('noneditable and readonly controls reject typing', async () => {
      await value('document.querySelector("#name").readOnly=true;void 0')
      const r = await exec({ action: 'fill', locator: { type: 'css', value: '#name' }, text: 'forbidden' })
      assert.equal(r.success, false); assert.match(r.error, /editable/)
      await value('document.querySelector("#name").readOnly=false;void 0')
      const button = await exec({ action: 'type', locator: { type: 'css', value: '#native' }, text: 'forbidden' })
      assert.equal(button.success, false); assert.match(button.error, /editable/)
    })
    await test('Enter and type submit cannot bypass declined confirmation', async () => {
      const before = confirmations.length
      approve = false
      try {
        const enter = await exec({ action: 'press_key', key: 'Enter' }); assert.equal(enter.success, false)
        const typing = await exec({ action: 'fill', locator: { type: 'css', value: '#name' }, text: 'denied-submit', submit: true }); assert.equal(typing.success, false)
        assert.notEqual(await value('document.querySelector("#name").value'), 'denied-submit')
      } finally { approve = true }
      assert.equal(confirmations.length, before + 2)
    })
    await test('full page and clip args produce bounded screenshots; child rejected', async () => {
      await value('document.body.style.minHeight="2000px";void 0')
      const full = await exec({ action: 'screenshot', args: { full_page: true } }); ok(full)
      assert.ok(nativeImage.createFromBuffer(Buffer.from(full.imageBase64, 'base64')).getSize().height >= 2000)
      const clip = await exec({ action: 'screenshot', args: { clip: { x: 0, y: 0, width: 100, height: 80 } } }); ok(clip)
      assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(clip.imageBase64, 'base64')).getSize(), { width: 100, height: 80 })
      const invalid = await exec({ action: 'screenshot', args: { clip: { x: 0, y: 0, width: 100000, height: 80 } } }); assert.equal(invalid.success, false)
      const frames = JSON.parse(ok(await exec({ action: 'frames' })))
      const child = frames.find(f => f.url === base + '/frame')
      assert.equal((await exec({ action: 'screenshot', frameId: child.frameId })).success, false)
    })
    await test('persistent script survives navigation and remove_id stops future injection', async () => {
      const result = ok(await exec({ action: 'add_script', args: { persistent: true, source: 'window.__persistentFixture=73' } }))
      const id = /Persistent script identifier: ([^\n]+)/.exec(result)[1]
      ok(await exec({ action: 'navigate', url: base + '/first' })); assert.equal(await value('window.__persistentFixture'), 73)
      ok(await exec({ action: 'add_script', args: { remove_id: id } }))
      ok(await exec({ action: 'navigate', url: base + '/second' })); assert.equal(await value('window.__persistentFixture'), undefined)
      assert.equal((await exec({ action: 'add_script', args: { remove_id: id } })).success, false)
    })
    await test('aborted navigation stops loading and next operation drains safely', async () => {
      const controller = new AbortController()
      const pending = exec({ action: 'navigate', url: base + '/abort-slow' }, controller.signal)
      const timer = setTimeout(() => controller.abort(), 50)
      let result
      try { result = await pending } finally { clearTimeout(timer) }
      assert.equal(result.success, false, 'Aborted navigation must not report success: ' + JSON.stringify(result))
      await eventually(async () => !first.webContents.isLoading(), 700)
      assert.notEqual(await value('window.abortLoaded'), true, 'Aborted external script must not finish executing')
      ok(await exec({ action: 'navigate', url: base + '/first' }))
      assert.equal(first.webContents.isLoading(), false, 'Next navigation must finish loading before return'); assert.equal(first.webContents.getURL(), base + '/first')
    })
    await test('new/select waits for delayed WC registration; closing tab cancels active wait', async () => {
      const original = first.webContents.send
      first.webContents.send = (channel, ...args) => {
        if (channel === 'browser:tabState' || args[0]?.tabs) {
          for (const entry of args[0]?.tabs ?? []) {
            if (entry.webContentsId === -1) {
              const win = makeWindow()
              setTimeout(async () => { await win.loadURL(base + '/first'); manager.registerTab(entry.tabId, win.webContents.id) }, 80)
            }
          }
        }
        return original(channel, ...args)
      }
      let id
      try {
        ok(await exec({ action: 'tab_new', url: base + '/first' }))
        id = manager.getActiveTabId(); assert.notEqual(id, 'one')
        const entry = manager.getTabs().find(t => t.tabId === id); assert.ok(entry.webContentsId > 0)
        ok(await exec({ action: 'tab_select', tabId: id }))
        const pending = exec({ action: 'wait', ms: 5000, tabId: id })
        await delay(40)
        ok(await exec({ action: 'tab_close', tabId: id }))
        assert.equal((await pending).success, false)
        assert.equal(manager.getTabs().some(t => t.tabId === id), false)
      } finally { first.webContents.send = original; manager.setActiveTab('one') }
    })
    await test('element screenshot captures PNG and secret code preview is redacted', async () => {
      const shot = await exec({ action: 'screenshot', locator: { type: 'css', value: '#native' } }); ok(shot)
      assert.ok(nativeImage.createFromBuffer(Buffer.from(shot.imageBase64, 'base64')).getSize().width > 0)
      ok(await exec({ action: 'evaluate', source: 'window.token="preview-secret"; void 0' }))
      const details = confirmations.at(-1).args
      assert.doesNotMatch(details.sourcePreview, /preview-secret/); assert.match(details.sourceSHA256, /^[a-f0-9]{64}$/)
    })
    await test('click auto-waits for a delayed actionable locator', async () => {
      await value('window.delayedClicks=0;setTimeout(()=>{const b=document.createElement("button");b.id="delayed-click";b.textContent="Delayed";b.onclick=e=>{if(e.isTrusted)delayedClicks++};document.body.prepend(b)},250);void 0')
      ok(await exec({ action: 'click', locator: { type: 'css', value: '#delayed-click' }, timeoutMs: 3000 }))
      await eventually(async () => await value('delayedClicks') === 1)
      await value('document.querySelector("#delayed-click").remove();void 0')
    })
    await test('scroll defaults down 600 and targets nested container via locator and ref', async () => {
      await value('document.body.style.minHeight="3000px";scrollTo(0,0);document.body.insertAdjacentHTML("afterbegin",\'<div id="scroll-target" role="region" style="width:300px;height:120px;overflow:auto"><div style="width:1500px;height:2000px">scroll fixture</div><button type="button" style="position:sticky;bottom:0" aria-label="Scroll target button">Scroll target button</button></div>\');void 0')
      await first.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true })
      ok(await exec({ action: 'scroll' }))
      await eventually(async () => await value('scrollY') > 0)
      const locator = { type: 'css', value: '#scroll-target' }
      ok(await exec({ action: 'scroll', locator }))
      assert.equal(await value('document.querySelector("#scroll-target").scrollTop'), 600)
      ok(await exec({ action: 'scroll', locator, direction: 'right', amount: 150 }))
      assert.equal(await value('document.querySelector("#scroll-target").scrollLeft'), 150)
      // A native scrollable textarea gets a ref in the same engine.
      await value('document.body.insertAdjacentHTML("afterbegin",\'<textarea id="scroll-ref" aria-label="Scrollable text" style="height:60px;width:200px"></textarea>\');document.querySelector("#scroll-ref").value="line\\n".repeat(100);void 0')
      const ref = refFrom(await snapshot(), 'Scrollable text')
      ok(await exec({ action: 'scroll', ref, amount: 120 }))
      assert.equal(await value('document.querySelector("#scroll-ref").scrollTop'), 120)
      await value('document.querySelector("#scroll-target").remove();document.querySelector("#scroll-ref").remove();document.body.style.minHeight="";scrollTo(0,0);void 0')
    })
    await test('replacement aborts running/queued work and disposes old guest state/listeners', async () => {
      const old = makeWindow(); const replacement = makeWindow()
      await old.loadURL(base + '/first'); await replacement.loadURL(base + '/second')
      const baseline = old.webContents.listenerCount('page-title-updated')
      manager.registerTab('lifecycle', old.webContents.id)
      const run = p => exec({ tabId: 'lifecycle', ...p })
      ok(await run({ action: 'add_script', args: { source: 'window.lifecyclePersistent=1', persistent: true } }))
      assert.equal(manager.persistentScripts.has(old.webContents.id), true)
      const pending = run({ action: 'wait', ms: 5000 })
      const queued = run({ action: 'evaluate', source: 'window.lateReplacementMutation=1' })
      await delay(40)
      manager.registerTab('lifecycle', replacement.webContents.id)
      assert.equal((await pending).success, false); assert.equal((await queued).success, false)
      assert.equal(manager.persistentScripts.has(old.webContents.id), false)
      assert.equal(old.webContents.debugger.isAttached(), false)
      assert.equal(old.webContents.listenerCount('page-title-updated'), baseline)
      await old.webContents.executeJavaScript('document.title="Old guest stale title";void 0', false)
      await delay(80)
      assert.notEqual(manager.getTabs().find(t => t.tabId === 'lifecycle').title, 'Old guest stale title')
      assert.equal(await replacement.webContents.executeJavaScript('window.lateReplacementMutation', false), undefined)
      // Old guest destruction must not cancel work on its replacement.
      const fresh = run({ action: 'wait', ms: 150 })
      old.destroy(); ok(await fresh)
      manager.unregisterTab('lifecycle'); replacement.destroy()
    })
    await test('unregister aborts queued work before same-id recreation and detaches extras', async () => {
      const old = makeWindow(); const replacement = makeWindow()
      await old.loadURL(base + '/first'); await replacement.loadURL(base + '/second')
      manager.registerTab('unregister-fixture', old.webContents.id)
      const run = p => exec({ tabId: 'unregister-fixture', ...p })
      ok(await run({ action: 'add_script', args: { source: 'window.unregisterPersistent=1', persistent: true } }))
      const pending = run({ action: 'wait', ms: 5000 })
      const queued = run({ action: 'evaluate', source: 'window.lateRecreationMutation=1' })
      await delay(40)
      manager.unregisterTab('unregister-fixture')
      assert.equal(manager.persistentScripts.has(old.webContents.id), false)
      assert.equal(old.webContents.debugger.isAttached(), false)
      manager.registerTab('unregister-fixture', replacement.webContents.id)
      assert.equal((await pending).success, false); assert.equal((await queued).success, false)
      ok(await run({ action: 'snapshot' }))
      assert.equal(await replacement.webContents.executeJavaScript('window.lateRecreationMutation', false), undefined)
      manager.unregisterTab('unregister-fixture'); old.destroy(); replacement.destroy()
    })
    await test('tab_close cancels queued mutation before same-id replacement', async () => {
      const old = makeWindow(); const replacement = makeWindow()
      await old.loadURL(base + '/first'); await replacement.loadURL(base + '/second')
      manager.registerTab('close-recreate', old.webContents.id)
      const pending = exec({ action: 'wait', ms: 5000, tabId: 'close-recreate' })
      const queued = exec({ action: 'evaluate', source: 'window.lateCloseMutation=1', tabId: 'close-recreate' })
      await delay(40)
      ok(await exec({ action: 'tab_close', tabId: 'close-recreate' }))
      manager.registerTab('close-recreate', replacement.webContents.id)
      assert.equal((await pending).success, false); assert.equal((await queued).success, false)
      ok(await exec({ action: 'snapshot', tabId: 'close-recreate' }))
      assert.equal(await replacement.webContents.executeJavaScript('window.lateCloseMutation', false), undefined)
      manager.unregisterTab('close-recreate'); old.destroy(); replacement.destroy()
    })
    await test('tab readiness fails promptly on replacement or destruction of loading guest', async () => {
      for (const destroy of [false, true]) {
        const old = makeWindow(); const replacement = makeWindow()
        await old.loadURL(base + '/first'); await replacement.loadURL(base + '/second')
        manager.registerTab('ready-fixture', old.webContents.id)
        const loading = old.loadURL(base + '/abort-slow').catch(() => {})
        await eventually(async () => old.webContents.isLoading())
        const pending = exec({ action: 'tab_select', tabId: 'ready-fixture', timeoutMs: 3000 })
        await delay(60)
        const start = Date.now()
        if (destroy) old.destroy()
        else manager.registerTab('ready-fixture', replacement.webContents.id)
        const result = await pending
        assert.equal(result.success, false); assert.match(result.error, /abort|changed|destroyed/i)
        assert.ok(Date.now() - start < 1000)
        manager.unregisterTab('ready-fixture')
        if (!old.isDestroyed()) { old.webContents.stop(); old.destroy() }
        replacement.destroy(); await loading
      }
      manager.setActiveTab('one')
    })
    await test('keyboard rejects arbitrary modifiers and dangerous shortcuts before dispatch', async () => {
      const wc = first.webContents; const original = wc.sendInputEvent.bind(wc); const sent = []
      wc.sendInputEvent = event => { sent.push(event); return original(event) }
      try {
        for (const key of ['Bogus+A', 'Ctrl+Control+A', 'Ctrl+W', 'Ctrl+L', 'Ctrl+Shift+I', 'F12', 'Alt+F4', 'Meta+W', 'Ctrl+Tab']) {
          const count = sent.length
          const result = await exec({ action: 'press_key', key })
          assert.equal(result.success, false, key); assert.match(result.error, /modifier|unsupported|dangerous/i)
          assert.equal(sent.length, count, 'Rejected key was dispatched: ' + key)
        }
        ok(await exec({ action: 'focus', locator: { type: 'css', value: '#name' } }))
        for (const key of ['Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Home', 'Ctrl+End', 'Home', 'End', 'Shift+Left']) {
          const count = sent.length
          ok(await exec({ action: 'press_key', key }))
          assert.ok(sent.length > count, 'Safe key not dispatched: ' + key)
        }
      } finally { wc.sendInputEvent = original }
    })
    await test('all page requests stayed within temporary loopback fixture', async () => {
      assert.equal(blocked.length, 0, 'Blocked off-fixture requests: ' + blocked.join(', ')); assert.ok(requestLog.length >= 6)
    })
  } catch (error) { fatal = error.stack || String(error) }
  finally {
    // app.exit below ends the manager's private housekeeping timers too. Only
    // resources in this fixture process are touched. Parent removes the profile
    // after Electron has released its file handles.
    for (const win of windows) {
      try { extras?.detach(win.webContents) } catch { /* destroyed guest */ }
      if (!win.isDestroyed()) win.destroy()
    }
    restoreLoader()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    const failed = results.filter(r => !r.ok).length
    fs.writeFileSync(process.env.SYNTEE_SMOKE_REPORT, JSON.stringify({ results, passed: results.length - failed, failed, fatal }, null, 2))
    app.exit(failed || fatal ? 1 : 0)
  }
}

if (process.versions.electron && process.argv.includes('--smoke-child')) {
  run().catch(error => { console.error(error); require('electron').app.exit(1) })
} else launch()
