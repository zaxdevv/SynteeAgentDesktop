/* global require, __dirname, __filename, process, console */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron probe intentionally runs as CommonJS. */
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')

// Import the built worker entry using Electron's worker-thread runtime.
// No chat is started and no provider is contacted.
const root = resolve(__dirname, '..')
const entry = resolve(root, 'out/main/ai-worker.js')

if (process.argv.includes('--electron-probe')) {
  const { Worker } = require('node:worker_threads')
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads')
    const req = require('node:module').createRequire(workerData.entry)
    ;(async () => {
      req(workerData.entry)
      const quickjs = await req('quickjs-emscripten').getQuickJS()
      const context = quickjs.newContext()
      try {
        const result = context.evalCode('21 * 2')
        if (result.error) {
          const error = context.dump(result.error)
          result.error.dispose()
          throw new Error(JSON.stringify(error))
        }
        const value = context.dump(result.value)
        result.value.dispose()
        if (value !== 42) throw new Error('Unexpected QuickJS result: ' + value)
        const Database = req('better-sqlite3')
        const db = new Database(':memory:')
        try { db.prepare('SELECT 1').get() } finally { db.close() }
        parentPort.postMessage({ workerBoot: true, quickjs: true, wasmResult: value, sqlite: true })
      } finally {
        context.dispose()
        parentPort.close()
      }
    })().catch(error => { console.error(error); process.exit(1) })
  `, { eval: true, workerData: { entry, storeData: {} } })
  worker.on('message', result => console.log(JSON.stringify(result)))
  worker.on('error', error => { console.error(error); process.exitCode = 1 })
  worker.on('exit', code => { if (code) process.exitCode = code })
} else if (process.argv.includes('--local-answer-probe')) {
  const { Worker } = require('node:worker_threads')
  const worker = new Worker(entry, { workerData: { storeData: {} } })
  worker.on('message', async message => {
    console.log(JSON.stringify(message))
    if (message.type === 'done') await worker.terminate()
  })
  worker.on('error', error => { console.error(error); process.exitCode = 1 })
  worker.postMessage({
    type: 'local_answer', chatId: 'chat-1', msgId: 'message-1',
    content: 'какая ты модель кратко', answer: 'Модель этого чата — selected/model.',
  })
} else {
  test('built AI worker boots in Electron with a working QuickJS WASM runtime', () => {
    assert.ok(existsSync(entry), 'Build the app with electron-vite build first')
    const electron = require('electron')
    const result = spawnSync(electron, [__filename, '--electron-probe'], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /"workerBoot":true/)
    assert.match(result.stdout, /"quickjs":true/)
    assert.match(result.stdout, /"wasmResult":42/)
    assert.match(result.stdout, /"sqlite":true/)
  })

  test('a standalone model question receives a local reply without tools or provider usage', () => {
    const ts = require('typescript')
    const source = readFileSync(resolve(root, 'src/shared/modelIdentityQuestion.ts'), 'utf8')
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
    const exports = {}
    new Function('exports', js)(exports)
    const { modelIdentityQuestion } = exports
    assert.equal(modelIdentityQuestion('какая ты модель кратко'), 'ru')
    assert.equal(modelIdentityQuestion('What model are you using, briefly?'), 'en')
    assert.equal(modelIdentityQuestion('Какая модель лучше для Arch?'), undefined)
    assert.equal(modelIdentityQuestion('Какая ты модель и что было с REA?'), undefined)
    assert.equal(modelIdentityQuestion('`какая ты модель кратко`'), undefined)

    const result = spawnSync(require('electron'), [__filename, '--local-answer-probe'], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const messages = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    assert.deepEqual(messages, [{
      type: 'done', chatId: 'chat-1', msgId: 'message-1', fullText: 'Модель этого чата — selected/model.',
      content: 'какая ты модель кратко', collectedSteps: [],
    }])
  })
}
