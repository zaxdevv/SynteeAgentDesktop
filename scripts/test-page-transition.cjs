/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node CommonJS test */
/* global require, console, process */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

// Test actual navigation code with controllable native capture promises.
const context = vm.createContext({ console })
let reduced = false
let timerId = 0
const timers = new Map()
const attributes = new Map()
let blurred = 0
class Element { blur() { blurred++ } }
const native = []
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const doc = {
  activeElement: new Element(),
  querySelector: () => ({ contains: () => true }),
  documentElement: {
    setAttribute: (k, v) => attributes.set(k, v),
    removeAttribute: k => attributes.delete(k),
  },
  startViewTransition(update) {
    const ready = deferred(), finished = deferred(), done = deferred()
    const entry = {
      update,
      ready: ready.promise, finished: finished.promise, updateCallbackDone: done.promise,
      skipTransition() { entry.skipped = true; finished.resolve() },
      skipped: false,
      resolve: finished.resolve, reject: finished.reject, rejectReady: ready.reject,
      resolveDone: done.resolve,
    }
    native.push(entry)
    return entry
  },
}
Object.assign(context, {
  document: doc, HTMLElement: Element,
  window: { matchMedia: () => ({ matches: reduced }) },
  setTimeout: fn => { timers.set(++timerId, fn); return timerId },
  clearTimeout: id => timers.delete(id),
})
function load(file, imports) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  context.exports = exports
  context.require = name => {
    assert.ok(name in imports, `unexpected import ${name}`)
    return imports[name]
  }
  vm.runInContext(code, context, { filename: file })
  return exports
}
const utility = load('src/renderer/src/utils/pageNavigationTransition.ts', {
  'react-dom': { flushSync: fn => fn() },
})
const store = load('src/renderer/src/store/nav.store.ts', {
  '../utils/pageNavigationTransition': utility,
  zustand: { create: initializer => {
    let state
    const set = patch => { state = { ...state, ...patch } }
    state = initializer(set, () => state)
    return { getState: () => state }
  } },
}).useNavStore
const get = () => store.getState()
const tick = () => new Promise(resolve => process.nextTick(resolve))

async function main() {
  get().toggleMainPage('dots')
  get().toggleMainPage('dots') // before first capture: must close pending Dot
  assert.equal(native[0].skipped, true)
  native[0].update()
  native[1].update()
  assert.equal(get().mainPage, 'chat')
  assert.deepEqual([...get().history], ['chat', 'dots', 'chat'])
  native[1].resolve()
  await tick()
  assert.equal(attributes.size, 0)
  assert.equal(timers.size, 0)

  get().openSettings('voice')
  get().setSettingsSection('models')
  native.at(-1).update()
  assert.equal(get().mainPage, 'settings')
  assert.equal(get().settingsSection, 'models')
  get().setMainPage('memory')
  get().setMainPage('messenger')
  get().setMainPage('dots')
  const winner = native.at(-1)
  for (const transition of native) transition.update()
  assert.equal(get().mainPage, 'dots')
  await tick()
  assert.equal(attributes.get('data-syntee-page-transition'), 'open', 'old cleanup cannot clear new transition')
  winner.resolve()
  await tick()
  assert.equal(timers.size, 0)
  assert.equal(get().goBack(), true)
  assert.equal(get().goBack(), true)
  native.at(-1).update()
  assert.equal(get().mainPage, 'memory')
  assert.equal(get().goForward(), true)
  native.at(-1).update()
  assert.equal(get().mainPage, 'messenger')

  // Failed native capture, even without invoking the update callback.
  get().setMainPage('chat')
  native.at(-1).rejectReady(new Error('hidden window'))
  native.at(-1).reject(new Error('capture aborted'))
  await tick()
  assert.equal(get().mainPage, 'chat')
  assert.equal(attributes.size, 0)
  get().setMainPage('dots')
  const late = native.at(-1)
  for (const fn of [...timers.values()]) fn()
  assert.equal(get().mainPage, 'dots', 'deadline commits if capture stalls')
  get().setMainPage('memory')
  late.update()
  assert.equal(get().mainPage, 'dots', 'stale callback cannot resurrect old page')
  native.at(-1).update()
  native.at(-1).resolve()
  await tick()
  assert.equal(get().mainPage, 'memory')
  assert.equal(timers.size, 0)

  reduced = true
  get().toggleMainPage('memory')
  assert.equal(get().mainPage, 'chat')
  assert.equal(attributes.size, 0)
  reduced = false
  doc.startViewTransition = () => { throw new Error('not supported') }
  get().setMainPage('dots')
  assert.equal(get().mainPage, 'dots')
  doc.startViewTransition = undefined
  get().setMainPage('chat')
  assert.equal(get().mainPage, 'chat')
  assert.ok(blurred > 0)
  assert.equal(attributes.size, 0)
  assert.equal(timers.size, 0)
  console.log('PASS: rapid toggles, navigation/history intent, stale callbacks/cleanup, failed capture, deadline, reduced motion, unsupported API')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
