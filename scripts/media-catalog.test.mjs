import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(id => mocks[id] ?? require(id), module, module.exports)
  return module.exports
}

test('Catalog retains directional modalities and does not label video/PDF as image vision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syntee-media-catalog-'))
  const previous = globalThis.fetch
  try {
    const models = {
      video: { limit: { context: 1000 }, attachment: true, modalities: { input: ['text', 'video'], output: ['text'] } },
      audio: { limit: { context: 1000 }, modalities: { input: ['audio'], output: ['text', 'audio'] } },
      pdf: { limit: { context: 1000 }, attachment: true, modalities: { input: ['pdf'], output: ['text'] } },
      image: { limit: { context: 1000 }, modalities: { input: ['image'], output: ['text'] } },
      empty: { limit: { context: 1000 }, attachment: true, modalities: { input: [], output: [] } },
      legacy: { limit: { context: 1000 }, attachment: true },
    }
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ google: { models } }) })
    const catalog = load('src/core/tokens/modelCatalog.ts')
    assert.equal((await catalog.refreshCatalog(join(dir, 'cache.json'), true)).ok, true)
    const get = id => catalog.getCatalogModel('google', id)
    assert.deepEqual(get('video').inputModalities, ['text', 'video'])
    assert.ok(get('video').capabilities.includes('video'))
    assert.ok(!get('video').capabilities.includes('vision'))
    assert.ok(!get('pdf').capabilities.includes('vision'))
    assert.ok(get('image').capabilities.includes('vision'))
    assert.ok(!get('empty').capabilities.includes('vision'))
    assert.ok(get('legacy').capabilities.includes('vision'))
    for (const cap of ['audio_input', 'audio_output', 'stt', 'tts']) assert.ok(get('audio').capabilities.includes(cap), cap)
    assert.deepEqual(get('audio').outputModalities, ['text', 'audio'])
  } finally {
    globalThis.fetch = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Filters honor explicit modalities over stale capabilities and keep audio direction distinct', () => {
  const { matchesCaps, matchesModelRole } = load('src/renderer/src/utils/modelFilters.ts', { './modelFormat': { formatPrice: () => '' } })
  const model = { capabilities: ['vision', 'video', 'stt', 'tts'], inputModalities: ['audio'], outputModalities: ['text'] }
  assert.equal(matchesCaps(model, ['vision']), false)
  assert.equal(matchesCaps(model, ['video']), false)
  assert.equal(matchesCaps(model, ['audio_input']), true)
  assert.equal(matchesCaps(model, ['audio_output']), false)
  assert.equal(matchesModelRole(model, 'audio'), true)
  assert.equal(matchesModelRole(model, 'video'), false)
  assert.equal(matchesModelRole({ ...model, outputModalities: ['audio'] }, 'audio'), false)
  assert.equal(matchesModelRole({ capabilities: ['stt'] }, 'audio'), true)
  assert.equal(matchesModelRole({ capabilities: ['video'] }, 'video'), true)
  assert.equal(matchesModelRole({ capabilities: ['video'], inputModalities: [] }, 'video'), false)
})
