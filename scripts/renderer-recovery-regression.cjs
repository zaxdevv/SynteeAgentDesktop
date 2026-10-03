/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node regression test */
/* global require, __dirname */
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/main/windows/rendererRecovery.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText

function setup() {
  const timers = new Map()
  let nextId = 0
  let loads = 0
  let dialogs = 0
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScript: async () => false,
  })
  const win = Object.assign(new EventEmitter(), {
    webContents: wc, isDestroyed: () => false, show() {}, hide() {},
  })
  const mod = { exports: {} }
  const fakeRequire = name => {
    if (name === 'electron') return {
      app: { getPath: () => 'test-profile' },
      dialog: { showMessageBox: async () => { dialogs++; return { response: 1 } } },
    }
    if (name === '../../core/logger') return { log() {} }
    if (name === 'fs') return { appendFileSync() {}, mkdirSync() {} }
    return require(name)
  }
  new Function('exports', 'require', 'module', 'setTimeout', 'clearTimeout', 'console', code)(
    mod.exports, fakeRequire, mod,
    (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id },
    id => timers.delete(id), { error() {} },
  )
  const recovery = mod.exports.attachRendererRecovery(win, async () => { loads++ })
  const fire = delay => {
    for (const [id, entry] of timers) {
      if (entry.delay === delay) { timers.delete(id); entry.fn(); return }
    }
    throw Error(`No ${delay}ms timer`)
  }
  return { wc, win, timers, fire, recovery, loads: () => loads, dialogs: () => dialogs }
}

test('renderer crash reloads UI once and duplicate load failure is coalesced', () => {
  const s = setup()
  s.wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  s.recovery.failed('same failure')
  assert.equal(s.timers.size, 1)
  s.fire(1000)
  assert.equal(s.loads(), 1)
})
test('two retries then user-facing dialog, no infinite loop', async () => {
  const s = setup()
  for (let i = 0; i < 2; i++) { s.recovery.failed('crash'); s.fire(1000) }
  s.recovery.failed('crash')
  await Promise.resolve()
  assert.equal(s.loads(), 2)
  assert.equal(s.dialogs(), 1)
  assert.equal(s.timers.size, 0)
})
test('ignore aborted navigation and subframe failures', () => {
  const s = setup()
  s.wc.emit('did-fail-load', {}, -3, 'aborted', 'url', true)
  s.wc.emit('did-fail-load', {}, -2, 'failed', 'url', false)
  assert.equal(s.timers.size, 0)
})
test('main frame failure and preload error initiate recovery', () => {
  const s = setup()
  s.wc.emit('did-fail-load', {}, -2, 'failed', 'url', true)
  s.wc.emit('preload-error', {}, 'preload.js', Error('failed'))
  s.fire(1000)
  assert.equal(s.loads(), 1)
})
test('hung initial navigation times out', () => {
  const s = setup()
  s.wc.emit('did-start-loading')
  s.fire(30000)
  s.fire(1000)
  assert.equal(s.loads(), 1)
})
test('loaded HTML with unmounted React triggers recovery', async () => {
  const s = setup()
  s.wc.executeJavaScript = async () => true
  s.wc.emit('did-finish-load')
  s.fire(30000)
  await Promise.resolve()
  s.fire(1000)
  assert.equal(s.loads(), 1)
})
test('healthy mounted UI is not reloaded', async () => {
  const s = setup()
  s.wc.emit('did-finish-load')
  s.fire(30000)
  await Promise.resolve()
  assert.equal(s.loads(), 0)
  assert.equal(s.timers.size, 0)
})
test('closing cancels retry and prevents later recovery', () => {
  const s = setup()
  s.recovery.failed('crash')
  s.win.emit('closed')
  s.recovery.failed('late failure')
  assert.equal(s.timers.size, 0)
})
test('busy renderer is logged but never automatically reloaded', () => {
  const s = setup()
  s.win.emit('unresponsive')
  assert.equal(s.timers.size, 0)
  assert.equal(s.loads(), 0)
})
