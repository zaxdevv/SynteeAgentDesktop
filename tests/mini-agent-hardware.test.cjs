/* global require, __dirname, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const GiB = 1024 ** 3
const source = fs.readFileSync(path.join(__dirname, '../src/main/assistants/hardware.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText

function load(os = require('node:os'), runtime = process) {
  const exports = {}
  vm.runInNewContext(code, { exports, process: runtime, require: name => name === 'node:os' ? os : require(name) })
  return exports
}

const { assessAssistantHardware, getAssistantStartupError } = load()
const host = {
  platform: 'win32', architecture: 'x64', logicalCpus: 4,
  totalMemory: 8 * GiB, availableMemory: 4 * GiB,
}

test('recommendations scale with available CPU and memory and always offer a normal CPU model', () => {
  const low = assessAssistantHardware({ ...host, logicalCpus: 1 })
  const balanced = assessAssistantHardware(host)
  const workstation = assessAssistantHardware({ ...host, platform: 'linux', logicalCpus: 32, totalMemory: 32 * GiB })
  assert.equal(low.tier, 'limited')
  assert.equal(low.recommendation.modelSize, '0.8B')
  assert.equal(low.recommendation.ctxSize, 4096)
  assert.equal(low.recommendation.threads, 1)
  assert.equal(balanced.tier, 'balanced')
  assert.equal(balanced.recommendation.modelSize, '1.2B')
  assert.equal(balanced.recommendation.ctxSize, 8192)
  assert.equal(workstation.tier, 'performance')
  assert.equal(workstation.recommendation.modelSize, 'qwen-coder-1.5b')
  assert.equal(workstation.recommendation.ctxSize, 16384)
  assert.equal(workstation.recommendation.threads, 8)
  for (const assessment of [low, balanced, workstation]) assert.equal(assessment.recommendation.device, 'cpu')
  assert.equal(assessAssistantHardware({ ...host, totalMemory: 7 * GiB }).recommendation.modelSize, '0.8B')
})

test('OS memory limits inform recommendations without assuming total host memory', () => {
  const { assessAssistantHardware } = load({
    availableParallelism: () => 8, totalmem: () => 32 * GiB, freemem: () => 24 * GiB,
  }, {
    platform: 'linux', arch: 'x64', constrainedMemory: () => 4 * GiB, availableMemory: () => 2 * GiB,
  })
  const assessment = assessAssistantHardware()
  assert.equal(assessment.totalMemoryGiB, 4)
  assert.equal(assessment.availableMemoryGiB, 2)
  assert.equal(assessment.recommendation.modelSize, '0.8B')
})

test('startup rejects unsupported targets and reserves more memory for larger contexts', () => {
  const unsupported = { ...host, architecture: 'arm64' }
  const minimal = { ...host, totalMemory: 2 * GiB, availableMemory: 2 * GiB }
  const freeMemory = 2 * GiB
  const weights = 731_000_000
  assert.equal(assessAssistantHardware(unsupported).runtimeSupported, false)
  assert.equal(assessAssistantHardware(unsupported).recommendation, null)
  assert.equal(assessAssistantHardware(minimal).recommendation, null)
  assert.match(getAssistantStartupError(weights, 4096, unsupported), /Windows.*Linux x64/)
  assert.match(getAssistantStartupError(weights, 4096, minimal), /3 ГиБ/)
  assert.equal(getAssistantStartupError(weights, 4096, { ...host, availableMemory: freeMemory }), undefined)
  assert.match(getAssistantStartupError(weights, 32768, { ...host, availableMemory: freeMemory }), /освободите ОЗУ/)
  assert.equal(getAssistantStartupError(weights, 4096, { ...host, availableMemory: null }), undefined)
})
