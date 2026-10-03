/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node test harness mocks Electron via vm. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

function harness() {
  const timers = new Map()
  let id = 0
  let reloads = 0
  let dialogs = 0
  const wc = new EventEmitter()
  const win = new EventEmitter()
  wc.isDestroyed = win.isDestroyed = () => false
  wc.executeJavaScript = async () => false
  win.webContents = wc
  win.show = win.hide = () => {}
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync('src/main/windows/rendererRecovery.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: name => {
      if (name === 'electron') return {
        app: { getPath: () => '.' },
        dialog: { showMessageBox: async () => { dialogs++; return { response: 1 } } }
      }
      if (name === 'fs') return { mkdirSync() {}, appendFileSync() {} }
      if (name === 'path') return require('node:path')
      return { log() {} }
    },
    console: { error() {} }, Date,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id },
    clearTimeout: key => timers.delete(key)
  })
  module.exports.attachRendererRecovery(win, async () => { reloads++ })
  return {
    wc, win, timers,
    get reloads() { return reloads }, get dialogs() { return dialogs },
    async tick(delay) {
      const due = [...timers].filter(([, timer]) => timer.delay === delay)
      for (const [key, timer] of due) { timers.delete(key); timer.fn() }
      await Promise.resolve(); await Promise.resolve()
    },
    navigate() { wc.emit('did-start-navigation', {}, 'file:///index.html', false, true) }
  }
}

test('subframe/loading activity and SPA navigation never arm watchdog', () => {
  const h = harness()
  h.wc.emit('did-start-loading')
  h.wc.emit('did-start-navigation', {}, 'https://google.com', false, false)
  h.wc.emit('did-start-navigation', {}, 'file:///index.html#chat', true, true)
  h.wc.emit('did-frame-finish-load', {}, false)
  assert.equal(h.timers.size, 0)
})
test('ready React UI is not reloaded even if loading never finishes', async () => {
  const h = harness(); h.navigate()
  await h.tick(30000); await h.tick(1000)
  assert.equal(h.reloads, 0)
})
test('blank boot and missing React mount recover', async () => {
  for (const finished of [false, true]) {
    const h = harness(); h.wc.executeJavaScript = async () => true
    h.navigate()
    if (finished) h.wc.emit('did-frame-finish-load', {}, true)
    await h.tick(30000); await h.tick(1000)
    assert.equal(h.reloads, 1)
  }
})
test('stale readiness result cannot reload a new navigation', async () => {
  const h = harness(); let resolve
  h.wc.executeJavaScript = () => new Promise(r => { resolve = r })
  h.navigate(); await h.tick(30000); h.navigate()
  resolve(true); await Promise.resolve(); await h.tick(1000)
  assert.equal(h.reloads, 0)
})
test('crashes coalesce and retry limit is preserved', async () => {
  const h = harness()
  for (let i = 0; i < 3; i++) {
    h.wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    if (i === 0) h.wc.emit('did-fail-load', {}, -2, 'failed', '', true)
    await h.tick(1000)
  }
  assert.equal(h.reloads, 2); assert.equal(h.dialogs, 1)
})
test('close clears timer and diagnostic failure does not reload UI', async () => {
  const h = harness(); h.navigate(); h.win.emit('closed')
  assert.equal(h.timers.size, 0)
  const other = harness()
  other.wc.executeJavaScript = async () => { throw new Error('context changed') }
  other.navigate(); await other.tick(30000); await other.tick(1000)
  assert.equal(other.reloads, 0)
})
