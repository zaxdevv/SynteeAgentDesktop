/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, Buffer, AbortController, AbortSignal, setImmediate, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createServer } = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')
const ts = require('typescript')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(options = {}) {
  const children = []
  const readyBinaries = new Set(options.binaryReady === false ? [] : ['cpu', 'vulkan'])
  let modelReady = options.modelReady !== false
  const response = { ok: true, body: { cancel: async () => {} } }
  const exports = {}
  const spawn = (binary, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)) }
    children.push({ binary, args, child })
    if (args[0] === '--list-devices' && !options.silentProbe) {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('Vulkan0: Fixture GPU\n'))
        child.emit('exit', 0)
      })
    } else if (options.failGpuSpawn && binary.endsWith('vulkan')) {
      setImmediate(() => { child.emit('error', new Error('fixture Vulkan load failure')); child.emit('exit', 1) })
    }
    return child
  }
  const binaryManager = {
    LLAMA_SERVER_NAME: 'llama-server',
    getLlamaServerPath: flavor => `/cache/${flavor}`,
    isBinaryReady: flavor => readyBinaries.has(flavor),
    downloadBinary: async (flavor, progress, signal) => {
      if (options.downloadBinary) await options.downloadBinary(flavor, progress, signal)
      readyBinaries.add(flavor)
      return `/cache/${flavor}`
    }
  }
  const modelManager = {
    detectModelSize: () => '1.2B', resolveCtxSize: value => value === 'auto' ? 4096 : value,
    getModelInfo: () => ({ expectedBytes: 731_000_000 }),
    getModelPath: size => `/models/${size}`, isModelDownloaded: () => modelReady,
    downloadModel: async () => { await options.downloadModel?.(); modelReady = true }
  }
  const filename = path.resolve('src/main/localModels/LocalModelManager.ts')
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  vm.runInNewContext(source, {
    exports, process, console, Buffer, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => {
      if (name === 'child_process') return { spawn }
      if (name === 'fs') return { existsSync: () => false }
      if (name === 'electron') return { app: { getAppPath: () => '/fixture' }, webContents: { getAllWebContents: () => [] } }
      if (name.endsWith('/logger')) return { log() {} }
      if (name.endsWith('/modelManager')) return modelManager
      if (name.endsWith('/binaryManager')) return binaryManager
      if (name.endsWith('/hardware')) return { getAssistantCpuThreads: () => 2, getAssistantStartupError: options.startupError ?? (() => undefined) }
      return require(name)
    },
    fetch: (url, request) => {
      if (url.endsWith('/health')) return options.health ? options.health(request) : Promise.resolve(response)
      return options.completion(request)
    }
  }, { filename })
  const manager = exports.localModels
  manager.port = 0
  manager.setDevice(options.device || 'cpu')
  return { manager, children, servers: () => children.filter(entry => entry.args[0] !== '--list-devices') }
}

async function run() {
  const auto = fixture({ device: 'auto' })
  assert.equal(await auto.manager.ensureReady(), true)
  assert.equal(auto.manager.getStatus().activeDevice, 'cpu')
  assert.equal(auto.children.length, 1, 'auto skips Vulkan probes on a cold start')
  auto.manager.shutdown()
  auto.manager.setDevice('gpu')
  assert.equal(await auto.manager.ensureReady(), true)
  assert.equal(auto.manager.getStatus().activeDevice, 'gpu')
  auto.manager.shutdown()
  auto.manager.setDevice('auto')
  assert.equal(await auto.manager.ensureReady(), true)
  assert.equal(auto.manager.getStatus().activeDevice, 'gpu')
  auto.manager.shutdown()
  console.log('PASS auto uses CPU until an explicit Vulkan launch is verified')

  let preparations = 0
  let blocked = fixture({ binaryReady: false, modelReady: false, startupError: () => 'Insufficient memory',
    downloadBinary: () => { preparations++ }, downloadModel: () => { preparations++ } })
  assert.equal(await blocked.manager.ensureReady(), false)
  assert.equal(blocked.manager.getStatus().lastError, 'Insufficient memory')
  assert.equal(blocked.children.length, 0)
  assert.equal(preparations, 0)
  let checks = 0
  blocked = fixture({ startupError: () => ++checks === 1 ? undefined : 'Memory pressure during setup' })
  assert.equal(await blocked.manager.ensureReady(), false)
  assert.equal(blocked.manager.getStatus().lastError, 'Memory pressure during setup')
  assert.equal(blocked.children.length, 0)
  console.log('PASS memory guard blocks downloads and rechecks before launch')

  const binaryGate = deferred()
  let binarySignal
  let f = fixture({ binaryReady: false, downloadBinary: async (_flavor, _progress, signal) => {
    binarySignal = signal
    await binaryGate.promise
  } })
  let pending = f.manager.ensureReady()
  f.manager.shutdown()
  binaryGate.resolve()
  assert.equal(await pending, false)
  assert.equal(binarySignal.aborted, true)
  assert.equal(f.children.length, 0)
  assert.equal(f.manager.getState(), 'idle')

  const modelGate = deferred()
  f = fixture({ modelReady: false, downloadModel: () => modelGate.promise })
  pending = f.manager.ensureReady()
  await delay(5)
  f.manager.shutdown()
  modelGate.resolve()
  assert.equal(await pending, false)
  assert.equal(f.children.length, 0)
  assert.equal(f.manager.getState(), 'idle')
  console.log('PASS shutdown during binary/model download cannot resurrect server')

  f = fixture({ device: 'gpu', silentProbe: true })
  pending = f.manager.ensureReady()
  await delay(5)
  f.manager.shutdown()
  assert.equal(await pending, false)
  assert.equal(f.children[0].child.killed, true)
  assert.equal(f.servers().length, 0)

  f = fixture({ health: request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  pending = f.manager.ensureReady()
  await delay(5)
  f.manager.shutdown()
  assert.equal(await pending, false)
  assert.equal(f.servers()[0].child.killed, true)
  console.log('PASS shutdown aborts Vulkan probe and pending health request')

  f = fixture()
  assert.equal(await f.manager.ensureReady(), true)
  const oldChild = f.servers()[0].child
  f.manager.setModelSize('1B')
  f.manager.setCtxSetting(8192)
  f.manager.setDevice('gpu')
  await delay(25)
  assert.equal(f.manager.getState(), 'ready')
  assert.equal(f.servers().length, 2, 'one restart for related settings changes')
  oldChild.emit('exit', 0)
  assert.equal(f.manager.getState(), 'ready')
  assert.equal(f.manager.process, f.servers()[1].child, 'old process cannot clear the replacement')
  f.manager.shutdown()

  f = fixture()
  await f.manager.ensureReady()
  f.servers()[0].child.emit('exit', 1)
  const restart = f.manager.ensurePromise
  f.manager.shutdown()
  assert.equal(await restart, false)
  assert.equal(f.servers().length, 1)
  assert.equal(f.manager.getState(), 'idle')
  console.log('PASS coalesced configuration restart, stale exit and canceled crash backoff')

  f = fixture({ device: 'gpu', failGpuSpawn: true, health: async () => { await delay(10); return { ok: true } } })
  assert.equal(await f.manager.ensureReady(), true)
  assert.equal(f.manager.getStatus().activeDevice, 'cpu')
  f.manager.shutdown()

  const occupied = createServer()
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  f = fixture()
  f.manager.port = occupied.address().port
  assert.equal(await f.manager.ensureReady(), false)
  assert.match(f.manager.getStatus().lastError, /already in use/)
  assert.equal(f.children.length, 0)
  f.manager.shutdown()
  await new Promise(resolve => occupied.close(resolve))
  console.log('PASS failed Vulkan spawn falls back to CPU, occupied port cannot claim ready')

  let wakes = 0
  const bridgeExports = {}
  const bridgeFile = path.resolve('src/main/assistants/bridge.ts')
  const bridgeSource = ts.transpileModule(fs.readFileSync(bridgeFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  vm.runInNewContext(bridgeSource + '\nexports.testWake = serverReadyOrWake\n', {
    exports: bridgeExports, console, process, setTimeout, clearTimeout,
    require: name => {
      if (name.endsWith('/assistants')) return { DEFAULT_ASSISTANTS_SETTINGS: { enabled: true, modelSize: 'auto', ctxSize: 'auto', device: 'auto' } }
      if (name.endsWith('/logger')) return { log() {} }
      if (name.endsWith('/LocalModelManager')) return { localModels: {
        ensureReady: async () => { wakes++; return false }, getState: () => 'idle', shutdown() {},
        setModelSize() {}, setCtxSetting() {}, setDevice() {}
      } }
      if (name.endsWith('/llmServer')) return { getServerState: () => 'idle' }
      if (name.endsWith('/modelManager')) return { detectModelSize: () => '1.2B', isModelSize: value => value === '1.2B' }
      if (name === 'fs' || name === 'path') return require(name)
      return {}
    }
  }, { filename: bridgeFile })
  bridgeExports.initAssistants({ load: () => ({ enabled: true }), persist() {}, dbPath: () => '/fixture.db' })
  assert.equal(wakes, 0, 'startup only applies settings')
  const waking = bridgeExports.testWake()
  assert.equal(wakes, 1)
  bridgeExports.updateAssistantsSettings({ enabled: false })
  assert.equal(await waking, false)
  assert.equal(await bridgeExports.testWake(), false)
  assert.equal(wakes, 1, 'disabled advisory event must not restart local server')
  console.log('PASS assistant startup remains lazy and disable cancels advisory wake retries')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
