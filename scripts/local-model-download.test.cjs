/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, Buffer, AbortController, AbortSignal, Response */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const ts = require('typescript')

function load(file, overrides, globals = {}, sourceTransform = source => source) {
  const exports = {}
  const code = ts.transpileModule(sourceTransform(fs.readFileSync(file, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  vm.runInNewContext(code, {
    exports, process, console, Buffer, AbortController, AbortSignal,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name), ...globals
  }, { filename: file })
  return exports
}

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'syntee-model-download-'))
  try {
    const requests = []
    const mockHttps = { get(_url, _options, callback) {
      const request = new EventEmitter()
      request.setTimeout = () => request
      requests.push(status => {
        const response = Readable.from([Buffer.alloc(65536, 65), Buffer.from('finished')])
        response.statusCode = status
        response.headers = { 'content-length': '65544' }
        callback(response)
      })
      return request
    } }
    const models = load(path.resolve('src/main/assistants/modelManager.ts'), {
      electron: { app: { getPath: () => root } }, https: mockHttps, '../../core/logger': { log() {} },
      './hardware': { assessAssistantHardware: () => ({ recommendation: null }) }
    })
    const progress = []
    const first = models.downloadModel('1.2B', () => { throw new Error('fixture observer failure') })
    const second = models.downloadModel('1.2B', value => progress.push(value.phase))
    assert.equal(first, second)
    assert.equal(requests.length, 1)
    requests[0](200)
    const result = await second
    assert.equal((await fsp.stat(result)).size, 65544)
    assert.equal(progress.at(-1), 'done')
    assert.equal(fs.existsSync(result + '.tmp'), false)
    const failed = models.downloadModel('1B', () => {})
    requests[1](500)
    await assert.rejects(failed, /HTTP 500/)
    const retry = models.downloadModel('1B', () => {})
    assert.equal(requests.length, 3)
    requests[2](200)
    await retry
    const pinnedModels = load(path.resolve('src/main/assistants/modelManager.ts'), {
      electron: { app: { getPath: () => root } }, https: mockHttps, '../../core/logger': { log() {} },
      './hardware': { assessAssistantHardware: () => ({ recommendation: null }) },
    }, {}, source => source.replace('1_117_321_696', '65544')
      .replace('389b8172028c874b79a11358d258222dbce272b56ab3512ccc743893a25e06b4',
        createHash('sha256').update(Buffer.alloc(65536, 65)).update('finished').digest('hex')))
    const pinned = pinnedModels.downloadModel('qwen-coder-abliterated', () => {})
    requests[3](200)
    await pinned
    assert.equal(pinnedModels.isModelDownloaded('qwen-coder-abliterated'), true)
    await fsp.rm(pinnedModels.getModelPath('qwen-coder-abliterated'))
    const mismatch = models.downloadModel('qwen-coder-abliterated', () => {})
    requests[4](200)
    await assert.rejects(mismatch, /integrity verification/)
    assert.equal(fs.existsSync(models.getModelPath('qwen-coder-abliterated') + '.tmp'), false)
    console.log('PASS model download single-flight, progress observers, streamed file, failed request retry and temporary cleanup')

    if (process.platform !== 'linux') return
    const archiveRoot = path.join(root, 'fixture-archive')
    const release = path.join(archiveRoot, 'llama-fixture')
    await fsp.mkdir(release, { recursive: true })
    await fsp.writeFile(path.join(release, 'llama-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await fsp.writeFile(path.join(release, 'libggml.so.0'), 'fixture shared object')
    await fsp.symlink('libggml.so.0', path.join(release, 'libggml.so'))
    const archive = path.join(root, 'fixture.tar.gz')
    const tar = spawnSync('tar', ['-czf', archive, '-C', archiveRoot, 'llama-fixture'], { encoding: 'utf8' })
    assert.equal(tar.status, 0, tar.stderr)
    const bytes = await fsp.readFile(archive)
    let fetches = 0
    const binaries = load(path.resolve('src/main/assistants/binaryManager.ts'), {
      electron: { app: { getPath: () => root } }, '../../core/logger': { log() {} },
      './hardware': { hasAssistantRuntimeTarget: () => process.arch === 'x64' },
    }, {
      fetch: async () => { fetches++; return new Response(bytes) }
    }, source => source.replace('23_310_281', String(bytes.length))
      .replace('b60dc211e4ba206bb04bbc9eb06294364c43d0aab8fc308c44a361477466ba4c', createHash('sha256').update(bytes).digest('hex')))
    const binary = binaries.getLlamaServerPath('cpu')
    await fsp.mkdir(path.dirname(binary), { recursive: true })
    await fsp.writeFile(path.join(path.dirname(binary), 'incomplete-cache'), 'old download')
    await Promise.all([binaries.downloadBinary('cpu', () => {}), binaries.downloadBinary('cpu', () => {})])
    assert.equal(binaries.isBinaryReady('cpu'), true)
    assert.equal(fs.existsSync(path.join(path.dirname(binary), 'incomplete-cache')), false)
    assert.equal((await fsp.lstat(path.join(path.dirname(binary), 'libggml.so'))).isSymbolicLink(), true)
    await binaries.downloadBinary('cpu', () => {})
    assert.equal(fetches, 2, 'ready cache does not redownload')
    const canceled = new AbortController()
    canceled.abort()
    assert.throws(() => binaries.downloadBinary('cpu', () => {}, canceled.signal), /abort/i)
    assert.equal((await fsp.readdir(path.join(root, 'assistants'))).some(name => name.startsWith('.llama-')), false)
    console.log('PASS concurrent repair of incomplete Linux cache, preserved library links, cache hit and canceled request')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
