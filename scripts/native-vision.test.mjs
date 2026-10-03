import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
// Compile the production functions without Electron, network calls or logger side effects.
function load(path, mocks = {}, source = readFileSync(path, 'utf8')) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports)
  return module.exports
}
const { routeToolImagesToUser, summarizeImagePayload } = load('src/core/ai/toolImageMessages.ts')
const { NativeImageAnalysis } = load('src/core/agent/nativeImageAnalysis.ts')
const { convertMessagesToAnthropic } = load('src/core/ai/anthropicConverters.ts', {
  '../prompts/buildSystemPrompt': { SYSTEM_PROMPT_CACHE_BREAK: '<CACHE_BREAK>' },
})
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz', detail: 'high' } }
const text = { type: 'text', text: 'Inspect this image.' }
const tool = (callId) => ({ role: 'tool', tool_call_id: callId, name: 'analyze_image', content: [image, text] })

test('OpenAI: image goes after all adjacent paired tool results, pixels preserved', () => {
  const messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] }, tool('a'), { role: 'tool', tool_call_id: 'b', content: 'second result' }]
  const before = JSON.stringify(messages)
  const routed = routeToolImagesToUser(messages)
  assert.deepEqual(routed.map(m => m.role), ['assistant', 'tool', 'tool', 'user'])
  assert.equal(routed[1].tool_call_id, 'a')
  assert.equal(routed[2].tool_call_id, 'b')
  assert.deepEqual(routed[3].content[1], image)
  assert.equal(JSON.stringify(messages), before)
})

test('Multiple parallel images and repeated routing do not lose or duplicate pixels', () => {
  const routed = routeToolImagesToUser([tool('a'), tool('b'), { role: 'user', content: 'Continue' }])
  assert.equal(summarizeImagePayload(routed).images, 2)
  assert.deepEqual(routeToolImagesToUser(routed), routed)
  assert.deepEqual(summarizeImagePayload(routed).byRole, { user: 2 })
})

test('Diagnostics contain metadata only, no URL/base64/text', () => {
  const summary = summarizeImagePayload([tool('a')])
  assert.deepEqual(summary, { images: 1, byRole: { tool: 1 }, mimeTypes: ['image/png'] })
  assert.ok(!JSON.stringify(summary).includes('cGl4ZWxz'))
  assert.ok(!JSON.stringify(summary).includes(text.text))
})

test('Native Anthropic retains base64 image inside tool_result', () => {
  const converted = convertMessagesToAnthropic([tool('a')])
  const result = converted.messages[0].content[0]
  assert.equal(result.type, 'tool_result')
  assert.equal(result.tool_use_id, 'a')
  assert.deepEqual(result.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWxz' } })
})

test('Lifecycle: loaded is pending until a model response; empty response is not success', () => {
  const lifecycle = new NativeImageAnalysis()
  const steps = []
  lifecycle.add('a', 'Loaded', ['C:/preview.png'])
  lifecycle.respond('', false, s => steps.push(s))
  assert.equal(lifecycle.size, 1)
  assert.equal(steps.length, 0)
  lifecycle.respond('The image has an orange stock.', false, s => steps.push(s))
  assert.equal(lifecycle.size, 0)
  assert.equal(steps[0].type, 'tool_result_update')
  assert.equal(steps[0].callId, 'a')
  assert.equal(steps[0].content, 'Loaded')
  assert.deepEqual(steps[0].imagePaths, ['C:/preview.png'])
  assert.equal(steps[0].visualAnalysis.status, 'responded')
  assert.match(steps[0].visualAnalysis.findings, /orange stock/)
})

test('Tool-only response does not invent observations and failure resolves all call IDs once', () => {
  const lifecycle = new NativeImageAnalysis()
  const steps = []
  lifecycle.add('a', 'Loaded')
  lifecycle.respond('', true, s => steps.push(s))
  assert.match(steps[0].visualAnalysis.findings, /не предоставила/)
  lifecycle.add('b', 'Loaded')
  lifecycle.add('c', 'Loaded')
  lifecycle.fail('Stopped', s => steps.push(s))
  lifecycle.fail('Stopped', s => steps.push(s))
  assert.deepEqual(steps.map(s => s.callId), ['a', 'b', 'c'])
  assert.ok(steps.slice(1).every(s => s.success === undefined && s.visualAnalysis.status === 'failed'))
})

test('Native tool reads the actual path and returns pixels without calling a helper model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syntee-vision-test-'))
  let visionCalls = 0
  try {
    const file = join(dir, 'preview.png')
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6r9sAAAAASUVORK5CYII=', 'base64')
    writeFileSync(file, bytes)
    const { analyzeImageFile } = load('src/core/tools/image.ts', {
      '../ai/visionSupport': { agentModelSupportsVision: () => true },
      '../ai/AIClient': { AIClient: class { analyzeImage() { visionCalls++ } } },
      './_shared': { resolveToolPath: (p, cwd) => resolve(cwd ?? '.', p) },
      '../../shared/mentions': { mimeFromExt: () => 'image/png', isImageMime: () => true },
      '../../shared/constants': { getIdentityHeaders: () => ({}) },
    })
    const result = await analyzeImageFile({ path: 'preview.png', question: 'What is visible?' }, {}, dir)
    assert.equal(result.success, true)
    assert.deepEqual(result.imagePaths, [file])
    assert.equal(result.imageParts[0].image_url.url, `data:image/png;base64,${bytes.toString('base64')}`)
    assert.match(result.output, /What is visible/)
    assert.equal(visionCalls, 0)
    assert.equal((await analyzeImageFile({ path: 'missing.png' }, {}, dir)).success, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Pending visual result keeps ToolChain unfinished until response', () => {
  const source = readFileSync('src/renderer/src/components/ui/ToolChain/ToolChain.tsx', 'utf8')
  const start = source.indexOf('export function hasUnfinishedCalls(')
  const end = source.indexOf('// ── Группировка', start)
  const { hasUnfinishedCalls } = load('ToolChain', {}, source.slice(start, end))
  const steps = [{ id: '1', type: 'tool_call', callId: 'a' }, { id: '2', type: 'tool_result', callId: 'a', visualAnalysis: { status: 'pending' } }]
  assert.equal(hasUnfinishedCalls(steps), true)
  steps[1].visualAnalysis.status = 'responded'
  assert.equal(hasUnfinishedCalls(steps), false)
})

test('Main-process checkpoint update retains paths and updates the existing result without duplicates', () => {
  const source = readFileSync('src/main/ipc/chat.ipc.ts', 'utf8')
  const start = source.indexOf("if (rawStep.type === 'tool_result_update') {")
  const end = source.indexOf("} else if (rawStep.type !== 'tool_call_pending')", start)
  assert.ok(start > 0 && end > start)
  const compiled = ts.transpileModule(source.slice(start, end) + '}', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const applyUpdate = new Function('rawStep', 'run', compiled)
  const saved = { type: 'tool_result', callId: 'a', success: true, imagePaths: ['C:/preview.png'], visualAnalysis: { status: 'pending' } }
  const run = { bufferedSteps: [saved], currentIterSteps: [saved], closedIters: [{ steps: [saved] }], checkpointDirty: false }
  applyUpdate({ type: 'tool_result_update', callId: 'a', visualAnalysis: { status: 'responded', findings: 'Orange stock' } }, run)
  assert.equal(run.bufferedSteps.length, 1)
  assert.equal(run.currentIterSteps.length, 1)
  assert.deepEqual(saved.imagePaths, ['C:/preview.png'])
  assert.equal(saved.visualAnalysis.status, 'responded')
  assert.equal(saved.success, true)
  assert.equal(run.checkpointDirty, true)
})

test('Renderer replaces visual result immutably across iterations without duplicating steps', () => {
  const source = readFileSync('src/renderer/src/hooks/useToolProgress.ts', 'utf8')
  const start = source.indexOf("} else if (step.type === 'tool_result_update') {")
  const end = source.indexOf('\n      }\n    })', start)
  const compiled = ts.transpileModule('export function update(step: any, buf: any, liveSet: any, chatId: string) {' + source.slice(start + "} else if (step.type === 'tool_result_update') {".length, end) + '}', { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  new Function('module', 'exports', compiled)(module, module.exports)
  const original = { id: '1', type: 'tool_result', callId: 'a', success: true, imagePaths: ['C:/preview.png'], visualAnalysis: { status: 'pending' } }
  const buf = { steps: [original], iters: [{ steps: [original] }, { steps: [{ type: 'tool_call', callId: 'b' }] }] }
  let live
  module.exports.update({ type: 'tool_result_update', callId: 'a', visualAnalysis: { status: 'responded', findings: 'Orange stock' } }, buf, (_, value) => { live = value }, 'chat')
  assert.equal(buf.steps.length, 1)
  assert.equal(buf.iters[0].steps.length, 1)
  assert.equal(buf.iters[1].steps.length, 1)
  assert.equal(original.visualAnalysis.status, 'pending')
  assert.equal(buf.steps[0].visualAnalysis.status, 'responded')
  assert.deepEqual(buf.iters[0].steps[0].imagePaths, ['C:/preview.png'])
  assert.ok(live)
})
