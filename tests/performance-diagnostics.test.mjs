import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = new URL('../src/core/performanceDiagnostics.ts', import.meta.url)

async function loadDiagnostics(enabled) {
  process.env.SYNTEE_PERF_DIAGNOSTICS = enabled ? '1' : '0'
  const text = await readFile(source, 'utf8')
  const js = ts.transpile(text, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })
  const Module = require('node:module')
  const mod = new Module(join(tmpdir(), `perf-diag-${enabled ? 'on' : 'off'}.cjs`))
  mod.filename = join(tmpdir(), `perf-diag-${enabled ? 'on' : 'off'}.cjs`)
  mod.paths = []
  mod._compile(js, mod.filename)
  return mod.exports
}

test('disabled instrumentation transparently executes phases and does not sample', async () => {
  const diag = await loadDiagnostics(false)
  assert.equal(diag.isPerformanceDiagnosticsEnabled(), false)
  assert.equal(diag.perfPhase('test', () => 42), 42)
  assert.equal(await diag.perfPhaseAsync('test', async () => 43), 43)
  assert.doesNotThrow(() => diag.startPerformanceSampling(10)())
})

test('enabled instrumentation records phase timings and process sample', async () => {
  const diag = await loadDiagnostics(true)
  const original = console.info
  const lines = []
  console.info = line => lines.push(line)
  try {
    assert.equal(diag.perfPhase('test.sync', () => 'ok'), 'ok')
    assert.equal(await diag.perfPhaseAsync('test.async', async () => 'ok'), 'ok')
    const stop = diag.startPerformanceSampling(5)
    await new Promise(resolve => setTimeout(resolve, 15))
    stop()
    assert(lines.some(line => line.includes('test.sync')))
    assert(lines.some(line => line.includes('test.async')))
    assert(lines.some(line => line.includes('process.sample')))
    assert(lines.every(line => !line.includes('user content')))
  } finally { console.info = original }
})
