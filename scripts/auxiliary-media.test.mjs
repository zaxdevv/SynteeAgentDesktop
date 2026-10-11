/* global AbortController */
import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
// Production code runs with lexical fetch/timer injection, never real network or Electron.
function load(path, mocks = {}, globals = {}, inertImports = false) {
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), output)(
    id => Object.hasOwn(mocks, id) ? mocks[id] : inertImports ? {} : require(id),
    module, module.exports, ...Object.values(globals),
  )
  return module.exports
}
const neverFetch = () => { throw new Error('Unexpected fetch: all tests are network-free') }
function support(fetch = neverFetch, timers = {}) {
  return load('src/core/ai/mediaSupport.ts', {}, { fetch, ...timers })
}
const google = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }
const openai = { baseUrl: 'https://api.openai.com/v1' }
const input = { kind: 'audio', mime: 'audio/wav', base64: 'UklGRg==', question: 'What is audible?' }
const ok = data => ({ ok: true, json: async () => data })
const googleResult = { candidates: [{ content: { parts: [{ text: 'private reasoning', thought: true }, { text: 'audible speech' }] } }] }

function harness(fetch = neverFetch) {
  const media = support(fetch)
  const { AIClient } = load('src/core/ai/AIClient.ts', {
    openai: class OpenAI {},
    './mediaSupport': media,
    '../../shared/constants': { getIdentityHeaders: () => ({}) },
    '../../shared/roundRobin': {
      getNextApiKey: (providers, id) => ({ key: providers.find(p => p.id === id)?.apiKey, updatedProviders: providers }),
    },
  }, {}, true)
  const tools = load('src/core/tools/media.ts', {
    '../ai/AIClient': { AIClient },
    './_shared': { resolveToolPath: (path, cwd) => resolve(cwd ?? '.', path) },
  })
  const values = {
    modelAssignments: [{ role: 'audio', modelId: 'gemini-2.5-flash', providerId: 'google' }, { role: 'video', modelId: 'gemini-2.5-flash', providerId: 'google' }],
    providers: [{ ...google, id: 'google', enabled: true, apiKey: 'test-key' }],
  }
  const store = { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value } }
  return { ...tools, AIClient, store, values }
}
async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'syntee-aux-media-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const wav = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt audio fixture')

test('Gemini video/audio payloads use inline_data, official endpoint and API-key header only', async () => {
  const requests = []
  const api = support(async (url, options) => { requests.push({ url, options }); return ok(googleResult) })
  for (const kind of ['video', 'audio']) {
    const transport = api.resolveMediaTransport(google, 'models/gemini-2.5-flash', kind)
    const result = await api.requestMediaAnalysis(transport, 'models/gemini-2.5-flash', 'secret-key', { ...input, kind, mime: kind === 'video' ? 'video/mp4' : 'audio/wav' })
    assert.equal(result, 'audible speech')
    const { url, options } = requests.at(-1)
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'x-goog-api-key': 'secret-key' })
    assert.equal(options.redirect, 'error')
    const body = JSON.parse(options.body)
    assert.deepEqual(body.contents[0].parts[1], { inline_data: { mime_type: kind === 'video' ? 'video/mp4' : 'audio/wav', data: input.base64 } })
    assert.equal(body.contents[0].parts[0].text, input.question)
    assert.ok(!options.body.includes('video_url'))
    assert.ok(!url.includes('secret-key'))
  }
})

test('OpenAI WAV/MP3 requests use input_audio, bearer header, text-only output and transcription prompt', async () => {
  let request
  const api = support(async (url, options) => { request = { url, options }; return ok({ choices: [{ message: { content: 'hello' } }] }) })
  for (const [mime, format] of [['audio/wav', 'wav'], ['audio/mpeg', 'mp3']]) {
    const result = await api.requestMediaAnalysis(api.resolveMediaTransport(openai, 'gpt-4o-audio-preview', 'audio'), 'gpt-4o-audio-preview', 'key', { ...input, mime, task: 'transcribe' })
    assert.equal(result, 'hello')
    assert.equal(request.url, 'https://api.openai.com/v1/chat/completions')
    assert.deepEqual(request.options.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer key' })
    const body = JSON.parse(request.options.body)
    assert.deepEqual(body.modalities, ['text'])
    assert.equal(body.model, 'gpt-4o-audio-preview')
    assert.deepEqual(body.messages[0].content[1], { type: 'input_audio', input_audio: { data: input.base64, format } })
    assert.match(body.messages[0].content[0].text, /Transcribe.*original language/)
  }
})

test('Unknown proxies, spoofed official hosts, models and incompatible formats fail closed', async () => {
  const api = support()
  for (const baseUrl of ['https://proxy.example/v1', 'https://api.openai.com.evil/v1', 'http://api.openai.com/v1', 'https://generativelanguage.googleapis.com/other', 'https://key@api.openai.com/v1', 'https://api.openai.com/v1?key=value']) {
    assert.throws(() => api.resolveMediaTransport({ baseUrl }, 'gemini-2.5-flash', 'video'), /Unsupported/)
  }
  assert.throws(() => api.resolveMediaTransport(openai, 'gpt-4o', 'audio'), /Unsupported/)
  assert.throws(() => api.resolveMediaTransport(openai, 'gpt-4o-audio-preview', 'video'), /Unsupported/)
  const transport = api.resolveMediaTransport(openai, 'gpt-4o-audio-preview', 'audio')
  await assert.rejects(api.requestMediaAnalysis(transport, 'gpt-4o-audio-preview', 'key', { ...input, mime: 'audio/flac' }), /WAV\/MP3/)
})

test('HTTP errors do not expose response body, credentials or payload; empty/blocked responses fail', async () => {
  const api = support(async () => ({ ok: false, status: 403, json: () => { throw new Error('must not read response body') } }))
  await assert.rejects(api.requestMediaAnalysis({ type: 'google', endpoint: 'unused' }, 'gemini-2.5-flash', 'secret', input), /^Error: Media provider returned HTTP 403/)
  for (const response of [{}, { promptFeedback: { blockReason: 'SAFETY' } }, { candidates: [{ content: { parts: [{ text: 'hidden', thought: true }] } }] }]) {
    const empty = support(async () => ok(response))
    await assert.rejects(empty.requestMediaAnalysis({ type: 'google', endpoint: 'unused' }, 'gemini-2.5-flash', 'key', input), /no text/)
  }
})

function abortingFetch(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
test('Pre-aborted and in-flight signals cancel requests', async () => {
  const api = support(abortingFetch)
  const transport = { type: 'google', endpoint: 'unused' }
  const before = new AbortController()
  before.abort()
  await assert.rejects(api.requestMediaAnalysis(transport, 'gemini-2.5-flash', 'key', { ...input, signal: before.signal }), /cancelled/)
  const during = new AbortController()
  const pending = api.requestMediaAnalysis(transport, 'gemini-2.5-flash', 'key', { ...input, signal: during.signal })
  during.abort()
  await assert.rejects(pending, /cancelled/)
})

test('Timeout aborts fetch and clears its timer (virtual clock, no sleep)', async () => {
  let tick, delay, cleared
  const api = support(abortingFetch, { setTimeout: (callback, ms) => { tick = callback; delay = ms; return 42 }, clearTimeout: id => { cleared = id } })
  const pending = api.requestMediaAnalysis({ type: 'google', endpoint: 'unused' }, 'gemini-2.5-flash', 'key', { ...input, timeoutMs: 2500 })
  assert.equal(delay, 2500)
  tick()
  await assert.rejects(pending, /timed out/)
  assert.equal(cleared, 42)
})

test('Actual AIClient uses capable primary Gemini without duplicate media assignment', async () => {
  let request
  const { AIClient, store, values } = harness(async (url, options) => { request = { url, options }; return ok(googleResult) })
  values.modelAssignments = [{ role: 'main', modelId: 'gemini-2.5-flash', providerId: 'google' }]
  const client = new AIClient(store)
  assert.equal(await client.analyzeMedia(input), 'audible speech')
  assert.match(request.url, /gemini-2\.5-flash:generateContent/)
})

test('Actual AIClient falls back only when primary transport unsupported; never borrows main for subagent', async () => {
  let request
  const { AIClient, store, values } = harness(async (url, options) => { request = { url, options }; return ok(googleResult) })
  values.providers.push({ id: 'proxy', baseUrl: 'https://proxy.example/v1', enabled: true, apiKey: 'proxy-key' })
  values.modelAssignments = [
    { role: 'main', modelId: 'gemini-2.5-flash', providerId: 'proxy' },
    { role: 'subagent', modelId: 'gpt-4o', providerId: 'proxy' },
    { role: 'audio', modelId: 'gemini-2.5-flash', providerId: 'google' },
  ]
  const client = new AIClient(store)
  assert.equal(await client.analyzeMedia(input), 'audible speech')
  assert.match(request.url, /generativelanguage\.googleapis\.com/)
  assert.equal(await client.analyzeMedia({ ...input, modelRole: 'subagent' }), 'audible speech')
  assert.match(request.url, /generativelanguage\.googleapis\.com/)
  assert.equal(request.options.headers['x-goog-api-key'], 'test-key') // uses audio fallback, not main's proxy model
  values.modelAssignments = [{ role: 'main', modelId: 'gemini-2.5-flash', providerId: 'google' }]
  values.providers[0].enabled = false
  await assert.rejects(client.analyzeMedia(input), /no API key|missing or disabled|No supported primary/)
})

test('Unsupported primary and absent auxiliary assignment fail clearly before upload', async () => {
  const { AIClient, store, values } = harness()
  values.providers[0].baseUrl = 'https://proxy.example/v1'
  values.modelAssignments = [{ role: 'main', modelId: 'gemini-2.5-flash', providerId: 'google' }]
  await assert.rejects(new AIClient(store).analyzeMedia(input), /No supported primary media model|Unsupported/)
})

test('Local tool reads valid media, passes auxiliary assignment and signal, and returns text only', async () => fixture(async dir => {
  let request
  const { analyzeAudioFile, store } = harness(async (_url, options) => { request = options; return ok(googleResult) })
  writeFileSync(join(dir, 'valid.wav'), wav)
  const controller = new AbortController()
  const result = await analyzeAudioFile({ path: 'valid.wav', task: 'transcribe' }, store, dir, { signal: controller.signal })
  assert.deepEqual(result, { success: true, output: 'audible speech' })
  assert.equal(JSON.parse(request.body).contents[0].parts[1].inline_data.data, wav.toString('base64'))
  controller.abort()
  assert.match((await analyzeAudioFile({ path: 'valid.wav' }, store, dir, { signal: controller.signal })).error, /cancelled/)
}))

test('Tool → AIClient → fetch propagates an in-flight abort', async () => fixture(async dir => {
  let started
  const ready = new Promise(resolve => { started = resolve })
  const { analyzeAudioFile, store } = harness((url, options) => { started(); return abortingFetch(url, options) })
  writeFileSync(join(dir, 'valid.wav'), wav)
  const controller = new AbortController()
  const pending = analyzeAudioFile({ path: 'valid.wav' }, store, dir, { signal: controller.signal })
  await ready
  controller.abort()
  const result = await pending
  assert.equal(result.success, false)
  assert.match(result.error, /cancelled/)
}))

test('File size, empty file, header mismatch, directory and missing path fail before fetch', async () => fixture(async dir => {
  const { analyzeAudioFile, store } = harness()
  mkdirSync(join(dir, 'directory.wav'))
  const directory = await analyzeAudioFile({ path: 'directory.wav' }, store, dir)
  assert.equal(directory.success, false)
  assert.match(directory.error, /regular local file|EISDIR|EPERM/)
  writeFileSync(join(dir, 'empty.wav'), '')
  writeFileSync(join(dir, 'bad.wav'), 'not a WAV')
  writeFileSync(join(dir, 'large.wav'), wav)
  truncateSync(join(dir, 'large.wav'), 14 * 1024 * 1024 + 1)
  for (const [path, expected] of [['empty.wav', /non-empty/], ['bad.wav', /header/], ['large.wav', /14 MiB/], ['missing.wav', /ENOENT/]]) {
    const result = await analyzeAudioFile({ path }, store, dir)
    assert.equal(result.success, false)
    assert.match(result.error, expected)
  }
  assert.match((await analyzeAudioFile({ path: 'https://example.com/audio.wav' }, store, dir)).error, /Only local/)
  assert.match((await analyzeAudioFile({ path: '' }, store, dir)).error, /path is required/)
}))

test('Dispatcher forwards mediaSignal to both handlers and dry runs never call them', async () => {
  const calls = []
  const { ToolDispatcher } = load('src/core/agent/toolDispatcher.ts', {
    '../tools': {
      analyzeAudioFile: (...args) => { calls.push(args); return { success: true, output: 'audio' } },
      analyzeVideoFile: (...args) => { calls.push(args); return { success: true, output: 'video' } },
    },
  }, {}, true)
  const store = {}
  const dispatcher = new ToolDispatcher({ store, workdir: 'C:/test' })
  const signal = new AbortController().signal
  dispatcher.mediaSignal = signal
  for (const name of ['analyze_audio', 'analyze_video']) {
    await dispatcher.executeTool(name, { path: 'fixture' })
    assert.equal(calls.at(-1)[1], store)
    assert.equal(calls.at(-1)[2], 'C:/test')
    assert.equal(calls.at(-1)[3].signal, signal)
    const count = calls.length
    await dispatcher.executeTool(name, { path: 'fixture' }, undefined, true)
    assert.equal(calls.length, count)
  }
})

test('Parent attachment MIME extensions remain explicitly unsupported by these auxiliary tools', async () => {
  const { analyzeAudioFile, analyzeVideoFile, store } = harness()
  for (const ext of ['m4a', 'opus']) assert.match((await analyzeAudioFile({ path: `track.${ext}` }, store)).error, /Unsupported audio file type.*No automatic conversion/)
  for (const ext of ['mkv', 'avi']) assert.match((await analyzeVideoFile({ path: `clip.${ext}` }, store)).error, /Unsupported video file type.*No automatic conversion/)
})
