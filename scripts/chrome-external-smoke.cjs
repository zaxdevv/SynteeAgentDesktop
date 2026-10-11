/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, setImmediate, setTimeout */
'use strict'
// Fixture-only test; never starts the real Chrome executable.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-chrome-smoke-'))
  const originalLoad = Module._load
  const originalTs = Module._extensions['.ts']
  const savedEnv = Object.fromEntries(['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'].map(k => [k, process.env[k]]))
  try {
    const local = path.join(root, 'local')
    const programFiles = path.join(root, 'program-files')
    const exe = path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
    const userData = path.join(local, 'Google', 'Chrome', 'User Data')
    fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'fixture executable')
    for (const id of ['Default', 'Profile 1']) fs.mkdirSync(path.join(userData, id), { recursive: true })
    fs.mkdirSync(path.join(programFiles, 'Google', 'Chrome', 'Application'), { recursive: true })
    fs.writeFileSync(path.join(userData, 'Local State'), JSON.stringify({ profile: { info_cache: {
      Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' }, 'Profile 2': { name: 'Missing' }, Bad: { name: 'Invalid' }
    } }, profile_info_cache: { Default: { name: 'WRONG' } } }))
    process.env.LOCALAPPDATA = local
    process.env.PROGRAMFILES = programFiles
    delete process.env['PROGRAMFILES(X86)']

    Module._extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename)
    Module._load = function(request, parent, isMain) {
      if (request === 'better-sqlite3' && parent?.filename.endsWith('browserImport.ts')) return class MockDatabase {}
      return originalLoad.call(this, request, parent, isMain)
    }
    const { discoverChromeProfiles, openChromeProfile } = require('../src/main/browser/browserImport.ts')
    const discovered = await discoverChromeProfiles()
    assert.equal(discovered.available, true)
    assert.deepEqual(discovered.profiles, [{ id: 'Default', name: 'Personal' }, { id: 'Profile 1', name: 'Work' }])

    let calls = 0
    const launcher = (actualExe, args) => { calls++; assert.equal(actualExe, exe); const child = new EventEmitter(); child.unrefCalled = false; child.unref = () => { child.unrefCalled = true }; launchChild = child; launchArgs = args; return child }
    let launchChild; let launchArgs
    for (const [profile, url] of [['Unknown', 'https://example.test'], ['Default', 'file:///secret'], ['Default', 'javascript:alert(1)']]) {
      const denied = await openChromeProfile(profile, url, launcher)
      assert.equal(denied.ok, false); assert.equal(calls, 0)
    }
    const pending = openChromeProfile('Profile 1', 'https://example.test/path', launcher)
    for (let i = 0; calls === 0 && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(calls, 1)
    assert.deepEqual(launchArgs, ['--profile-directory=Profile 1', '--new-window', 'https://example.test/path'])
    let settled = false; pending.then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'no early success before spawn')
    launchChild.emit('spawn')
    assert.deepEqual(await pending, { ok: true }); assert.equal(launchChild.unrefCalled, true)

    const failing = openChromeProfile('Default', undefined, () => { calls++; const child = new EventEmitter(); child.unref = () => assert.fail('failed launch must not unref'); setImmediate(() => child.emit('error', new Error('fixture spawn failure'))); return child })
    assert.deepEqual(await failing, { ok: false, error: 'fixture spawn failure' })
    assert.equal(calls, 2)
    console.log('PASS Chrome profile discovery, validation, exact launch args, spawn/unref and async launch failure')
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    Module._load = originalLoad
    if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts']
    fs.rmSync(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
