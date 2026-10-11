/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __filename, process, console, Buffer, setTimeout, clearTimeout */
'use strict'
// Run: node scripts/browser-import-smoke.cjs. Electron ABI; temp fixtures only.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
if (!process.versions.electron) {
  const child = require('node:child_process').spawn(require('electron'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true
  })
  const timer = setTimeout(() => child.kill(), 60000)
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1 })
  child.on('error', e => { clearTimeout(timer); console.error(e); process.exitCode = 1 })
} else run().catch(e => { console.error(e); process.exitCode = 1 })

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-browser-import-'))
  const Module = require('node:module'); const ts = require('typescript')
  const originalLoad = Module._load; const originalTs = Module._extensions['.ts']
  Module._extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, filename)
  let db; let lock
  try {
    const { BrowserImporter } = require('../src/main/browser/browserImport.ts')
    const Database = require('better-sqlite3')
    const local = path.join(root, 'local'); const user = path.join(root, 'user')
    const chrome = path.join(local, 'Google/Chrome/User Data/Default')
    const edge = path.join(local, 'Microsoft/Edge/User Data/Profile 1')
    fs.mkdirSync(chrome, { recursive: true }); fs.mkdirSync(edge, { recursive: true })
    const bookmarks = { roots: { bookmark_bar: { type: 'folder', name: 'Bar', children: [
      { type: 'url', name: 'Example', url: 'https://example.test/' },
      { type: 'folder', name: 'Nested', children: [{ type: 'url', name: 'Nested URL', url: 'https://nested.test/' }] },
      { type: 'url', name: 'Unsafe', url: 'javascript:alert(1)' }
    ] } } }
    fs.writeFileSync(path.join(chrome, 'Bookmarks'), JSON.stringify(bookmarks))
    fs.writeFileSync(path.join(edge, 'Bookmarks'), '{invalid')
    const historyFile = path.join(chrome, 'History')
    db = new Database(historyFile)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE urls(url TEXT, title TEXT, last_visit_time INTEGER)')
    const epoch = (Date.now() + 11644473600000) * 1000
    const insert = db.prepare('INSERT INTO urls VALUES (?, ?, ?)')
    db.transaction(() => {
      for (let i = 0; i < 50003; i++) insert.run(`https://history.test/${i}`, `History ${i}`, epoch + i * 1000)
    })()
    const profiles = [{ id: 'default', name: 'Personal' }]
    const importer = new BrowserImporter(local, user, () => profiles, p => profiles.push(p))
    const sources = await importer.importSources()
    assert.equal(sources.length, 2)
    assert.ok(sources.every(s => !('directory' in s)))
    assert.equal(sources.find(s => s.browser === 'chrome').history, true)
    const options = { sourceId: 'chrome:Default', name: 'Imported', bookmarks: true, history: true }
    const result = await importer.importData(options)
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.bookmarks, 2); assert.equal(result.history, 50000)
    assert.equal(profiles.length, 2)
    assert.ok(result.warnings.some(s => s.includes('50000')))
    const page = await importer.importedData(result.profile.id, 'history', '', 0)
    assert.equal(page.total, 50000); assert.equal(page.items.length, 100)
    assert.equal(page.items[0].url, 'https://history.test/50002')
    assert.ok(Math.abs(page.items[0].lastVisited - (epoch / 1000 - 11644473600000 + 50002)) < 2)
    const next = await importer.importedData(result.profile.id, 'history', '', 100)
    assert.notEqual(next.items[0].url, page.items[0].url)
    const found = await importer.importedData(result.profile.id, 'bookmarks', 'nested', 0)
    assert.equal(found.total, 1); assert.equal(found.items[0].folder, 'Bar / Nested')
    assert.deepEqual(await importer.importedData('default', 'history', '', 0), { items: [], total: 0 })
    console.log('PASS sources, WAL snapshot, history cap, timestamp, folders, pagination, search')
    for (const value of [null, {}, { ...options, sourceId: historyFile }, { ...options, bookmarks: false, history: false }, { ...options, history: 'yes' }, { ...options, name: ' '.repeat(2) }]) {
      assert.equal((await importer.importData(value)).ok, false)
    }
    await assert.rejects(importer.importedData('../escape', 'history', '', 0))
    await assert.rejects(importer.importedData(result.profile.id, 'history', '', -1))
    await assert.rejects(importer.importedData(result.profile.id, 'cookies', '', 0))
    assert.equal((await importer.importData({ ...options, sourceId: 'edge:Profile 1' })).ok, false)
    assert.equal(profiles.length, 2)
    console.log('PASS invalid options, arbitrary paths, bad paging and empty/failing source denied')
    db.close(); db = null
    fs.writeFileSync(historyFile, 'not sqlite')
    const partial = await importer.importData(options)
    assert.equal(partial.ok, true); assert.equal(partial.bookmarks, 2); assert.equal(partial.history, 0)
    assert.ok(partial.warnings.some(s => s.startsWith('history:')))
    fs.writeFileSync(path.join(chrome, 'Bookmarks'), JSON.stringify({ roots: {} }))
    const empty = await importer.importData({ ...options, history: false })
    assert.equal(empty.ok, false); assert.equal(profiles.length, 3)
    fs.writeFileSync(path.join(chrome, 'Bookmarks'), Buffer.alloc(16 * 1024 * 1024 + 1, 32))
    assert.equal((await importer.importData({ ...options, history: false })).ok, false)
    console.log('PASS partial errors, empty data and oversized bookmarks create no empty profiles')
    fs.unlinkSync(historyFile)
    lock = new Database(historyFile); lock.exec('CREATE TABLE urls(url TEXT, title TEXT, last_visit_time INTEGER)')
    lock.exec('BEGIN EXCLUSIVE')
    const locked = await importer.importData({ ...options, bookmarks: false })
    assert.equal(locked.ok, false); assert.ok(locked.warnings.some(s => /закройте/.test(s)))
    lock.exec('ROLLBACK'); lock.close(); lock = null
    fs.writeFileSync(path.join(chrome, 'Bookmarks'), JSON.stringify(bookmarks))
    const failing = new BrowserImporter(local, user, () => profiles, () => { throw new Error('fixture store failure') })
    const before = fs.readdirSync(path.join(user, 'browser-imports'))
    assert.equal((await failing.importData({ ...options, history: false })).ok, false)
    assert.deepEqual(fs.readdirSync(path.join(user, 'browser-imports')), before)
    console.log('PASS lock close-browser warning, persistence rollback')
    // Import real IPC module with dependency mocks only; no production DB or profile init.
    const handlers = new Map(); const frame = {}; const sender = { getType: () => 'window', mainFrame: frame }
    const win = { isDestroyed: () => false, webContents: sender }
    Module._load = function(request, parent, isMain) {
      if (parent?.filename.endsWith('browser.ipc.ts')) {
        if (request === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: { getPath: () => user } }
        if (request.includes('BrowserManager')) return { browserManager: { setSettingsStore() {}, setProfileStore() {}, listProfiles: () => profiles }, setBrowserExtras() {} }
        if (request.includes('BrowserExtras')) return { BrowserExtras: {} }
        if (request.includes('/db/chats')) return {}
        if (request.includes('constants')) return { IPC_EVENTS: {} }
        if (request === '../browser/extensions') return {}
        if (request === '../browser/browserImport') return { BrowserImporter }
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    const oldLocal = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = local
    try {
      require('../src/main/ipc/browser.ipc.ts').registerBrowserIPC({ set() {} }, () => win)
      const event = { sender, senderFrame: frame }
      assert.equal((await handlers.get('browser:importSources')(event)).length, 2)
      for (const channel of ['browser:importSources', 'browser:importData', 'browser:importedData']) {
        await assert.rejects(handlers.get(channel)({ sender: { getType: () => 'webview' }, senderFrame: frame }))
        await assert.rejects(handlers.get(channel)({ sender, senderFrame: {} }))
      }
      console.log('PASS main-UI IPC allowed; guests, other windows and subframes denied')
    } finally { if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal }
    // Rediscovery: a previously visible source disappears, stale ID must fail.
    fs.rmSync(edge, { recursive: true })
    assert.equal((await importer.importData({ ...options, sourceId: 'edge:Profile 1' })).ok, false)
    console.log('PASS rediscovery/stale source; all browser import smoke tests passed')
  } finally {
    if (db) db.close()
    if (lock) lock.close()
    Module._load = originalLoad; Module._extensions['.ts'] = originalTs
    fs.rmSync(root, { recursive: true, force: true })
  }
}
