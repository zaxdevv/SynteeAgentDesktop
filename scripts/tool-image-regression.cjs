/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- standalone Node regression runner */
// Run: node scripts/tool-image-regression.cjs (no live API requests or new dependencies).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')

function loadTS(relative, mocks = {}) {
  const filename = path.join(root, relative)
  const source = fs.readFileSync(filename, 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id]
    return require(require.resolve(id, { paths: [path.dirname(filename)] }))
  }
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, Buffer, console, setTimeout, clearTimeout, AbortController, DOMException, process }, { filename })
  return module.exports
}
const plain = value => JSON.parse(JSON.stringify(value))
const { routeToolImagesToUser } = loadTS('src/core/ai/toolImageMessages.ts')
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'high' } }
const source = [
  { role: 'system', content: 'system' },
  { role: 'assistant', content: '', tool_calls: [
    { id: 'a', type: 'function', function: { name: 'analyze_image', arguments: '{}' } },
    { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
  ], reasoning_content: 'reason', thinking_blocks: [{ thinking: 'thought', signature: 'sig' }] },
  { role: 'tool', tool_call_id: 'a', name: 'analyze_image', content: [image, { type: 'text', text: 'question' }] },
  { role: 'tool', tool_call_id: 'b', name: 'read_file', content: 'file text' },
]
const before = JSON.stringify(source)
const routed = routeToolImagesToUser(source)
assert.deepEqual(plain(routed.map(m => m.role)), ['system', 'assistant', 'tool', 'tool', 'user'])
assert.equal(routed[2].content, 'question')
assert.equal(routed[3].content, 'file text')
assert.equal(routed[4].content[1].image_url.url, image.image_url.url)
assert.match(routed[4].content[0].text, /call_id: a/)
assert.equal(routed[1].reasoning_content, 'reason')
assert.equal(routed[1].thinking_blocks[0].signature, 'sig')
assert.equal(JSON.stringify(source), before, 'routing must not mutate canonical messages')
assert.equal(JSON.stringify(routeToolImagesToUser(routed)), JSON.stringify(routed), 'routing is idempotent')
const twoImages = routeToolImagesToUser([...source, { role: 'tool', tool_call_id: 'c', content: [image, { type: 'text', text: 'second' }] }])
assert.equal(twoImages.at(-1).content.filter(p => p.type === 'image_url').length, 2)
const multiRound = routeToolImagesToUser([...source, { role: 'assistant', content: 'followup' }, source[2], { role: 'user', content: 'next user' }])
assert.deepEqual(plain(multiRound.map(m => m.role)), ['system', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user', 'user'])
console.log('PASS Chat Completions: images routed after all parallel tool results, attribution, immutability, idempotency, multi-round')

const { convertMessagesToAnthropic } = loadTS('src/core/ai/anthropicConverters.ts', {
  '../prompts/buildSystemPrompt': { SYSTEM_PROMPT_CACHE_BREAK: '<break>' },
})
const anthropic = convertMessagesToAnthropic(source)
assert.equal(anthropic.messages[1].content[0].type, 'tool_result')
assert.equal(anthropic.messages[1].content[0].content[0].type, 'image')
assert.equal(anthropic.messages[1].content[0].content[0].source.data, 'aGVsbG8=')
assert.equal(anthropic.messages[1].content[1].tool_use_id, 'b')
console.log('PASS native Anthropic: pixels remain inside paired tool_result')

const mentions = loadTS('src/shared/mentions.ts')
const { hydrateToolImageContent } = loadTS('src/core/ai/toolImageHistory.ts', { '../../shared/mentions': mentions })
const { messageToContextMessages } = loadTS('src/main/ipc/chatContextHelpers.ts', {
  '../../shared/attachmentMarkdown': { stripAttachTokens: text => text },
})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-image-test-'))

async function main() {
  try {
    const file = path.join(tmp, 'test.png')
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=', 'base64'))
    const saved = {
      role: 'assistant', content: 'answer',
      toolSteps: [
        { type: 'tool_call', callId: 'a', toolName: 'analyze_image', toolArgs: { path: file }, content: '' },
        { type: 'tool_result', callId: 'a', toolName: 'analyze_image', content: 'Prepared image', imagePaths: [file], success: true },
      ],
    }
    const history = messageToContextMessages(JSON.parse(JSON.stringify(saved)))
    const tool = history.find(m => m.role === 'tool')
    assert.deepEqual(plain(tool.imagePaths), [file])
    const hydrated = hydrateToolImageContent(tool, true)
    assert.equal(hydrated[0].type, 'image_url')
    assert.equal(hydrated[0].image_url.url, `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`)
    assert.equal(hydrated.at(-1).text, 'Prepared image')
    assert.doesNotMatch(JSON.stringify(saved), /base64/)
    assert.match(hydrateToolImageContent(tool, false), /text-only model/)
    const missing = hydrateToolImageContent({ content: 'Prepared', imagePaths: [path.join(tmp, 'gone.png')] }, true)
    assert.equal(typeof missing, 'string')
    assert.match(missing, /No pixels were attached/)
    const mixed = hydrateToolImageContent({ content: 'Prepared', imagePaths: [file, path.join(tmp, 'gone.png')] }, true)
    assert.equal(mixed[0].type, 'image_url')
    assert.match(mixed.at(-1).text, /gone.png/)
    const svg = path.join(tmp, 'test.svg')
    fs.writeFileSync(svg, '<svg/>')
    assert.equal(typeof hydrateToolImageContent({ content: '', imagePaths: [svg] }, true), 'string')
    assert.equal(typeof hydrateToolImageContent({ content: '', imagePaths: ['relative.png'] }, true), 'string')
    const big = path.join(tmp, 'big.png')
    fs.writeFileSync(big, Buffer.alloc(20 * 1024 * 1024 + 1))
    assert.equal(typeof hydrateToolImageContent({ content: '', imagePaths: [big] }, true), 'string')
    delete saved.toolSteps[1].imagePaths
    saved.toolSteps[1].content = 'Изображение «old.png» приложено к этому результату.'
    const legacy = messageToContextMessages(saved).find(m => m.role === 'tool')
    assert.match(legacy.content, /image is NOT attached/)
    assert.equal(legacy.imagePaths, undefined)
    console.log('PASS history: JSON path persistence, exact pixels, missing/mixed/text-only/SVG/relative/oversize handling, legacy warning')

    const catalog = { isCatalogReady: () => false }
    const vision = loadTS('src/core/ai/visionSupport.ts', { '../tokens/modelCatalog': catalog })
    const storeData = { modelAssignments: [
      { role: 'main', modelId: 'claude-sonnet-4-6', providerId: 'test' },
      { role: 'subagent', modelId: 'glm-5', providerId: 'test' },
    ] }
    const store = { get: (key, def) => storeData[key] ?? def }
    assert.equal(vision.agentModelSupportsVision(store, 'main'), true)
    assert.equal(vision.agentModelSupportsVision(store, 'subagent'), false)
    storeData.modelAssignments.pop()
    assert.equal(vision.agentModelSupportsVision(store, 'subagent'), true)
    storeData.subagentModel = 'qwen-vl'
    assert.equal(vision.agentModelSupportsVision(store, 'subagent'), true)
    console.log('PASS model routing: effective main/subagent assignment and fallback')

    const { analyzeImageFile } = loadTS('src/core/tools/image.ts', {
      openai: class {}, '../ai/AIClient': {}, '../ai/visionSupport': vision,
      '../../shared/constants': {}, '../../shared/mentions': mentions,
      './_shared': { resolveToolPath: (p, cwd) => path.resolve(cwd || root, p) },
    })
    const analyzed = await analyzeImageFile({ path: file, question: 'What is shown?' }, store)
    assert.equal(analyzed.success, true)
    assert.deepEqual(plain(analyzed.imagePaths), [file])
    assert.equal(analyzed.imageParts[0].type, 'image_url')
    assert.match(analyzed.output, /не готовое описание/)
    assert.match(analyzed.output, /What is shown/)
    console.log('PASS analyze_image: real file -> visual result + saved absolute path + honest status')

    let nativeCalled = false
    const { AIClient } = loadTS('src/core/ai/AIClient.ts', {
      openai: { default: class {} }, '@anthropic-ai/sdk': { default: class {} },
      '../../shared/reasoningModels': { responsesReasoningParam: () => ({}) },
      '../tokens/gatewayModelsCache': {}, '../tokens/modelCatalog': {},
      '../../shared/roundRobin': {}, '../../shared/constants': {},
      './anthropicConverters': { isAnthropicProvider: p => p.type === 'anthropic' },
      './shared': { DEFAULT_TEMPERATURE: 0, DEFAULT_MAX_TOKENS: 4096, OVERALL_TIMEOUT_MS: 10000, extractReasoningText: () => '', log: () => {} },
      './anthropicNative': { chatWithToolsAnthropic: async (_c, messages) => {
        nativeCalled = true
        assert.equal(messages[2].content[0].type, 'image_url')
        return { content: 'native' }
      } },
      './toolImageMessages': { routeToolImagesToUser }, '../tokens/usageTracker': {},
    })
    const ai = Object.create(AIClient.prototype)
    ai.store = { get: () => '' }
    ai.getModel = () => 'test-model'
    ai.getProviderInfoForRole = () => null
    ai.usesResponsesApi = () => false
    const fakeStream = async function* () { yield { choices: [{ delta: { content: 'ok' } }] } }
    let chatPayload
    ai.client = { chat: { completions: { create: async payload => { chatPayload = payload; return fakeStream() } } } }
    const chatResult = await ai.chatWithTools(source, [])
    assert.equal(chatResult.content, 'ok')
    assert.equal(typeof chatPayload.messages[2].content, 'string')
    assert.equal(chatPayload.messages.at(-1).content[1].type, 'image_url')
    assert.equal(JSON.stringify(source), before)
    let responsePayload
    const client = { responses: { create: async payload => { responsePayload = payload; return (async function* () {})() } } }
    await ai.chatWithToolsViaResponses(client, 'test', source, [], undefined, 4096, {}, {})
    const outputs = responsePayload.input.filter(i => i.type === 'function_call_output')
    assert.equal(outputs[0].output, 'question')
    assert.equal(outputs[1].output, 'file text')
    assert.doesNotMatch(JSON.stringify(outputs), /base64|image_url/)
    const visualInput = responsePayload.input.at(-1).content.find(p => p.type === 'input_image')
    assert.equal(visualInput.image_url, image.image_url.url)
    assert.equal(visualInput.detail, 'high')
    assert.equal(responsePayload.input[2].type, 'function_call_output')
    assert.equal(responsePayload.input[3].type, 'function_call_output')
    ai.getProviderInfoForRole = () => ({ provider: { type: 'anthropic' }, apiKey: 'fake' })
    ai.identityHeaders = () => ({})
    await ai.chatWithTools(source, [])
    assert.equal(nativeCalled, true)
    ai.getProviderInfoForRole = () => null
    ai.isOpencodeRole = () => false
    ai.client.chat.completions.create = async payload => {
      assert.equal(payload.messages.at(-1).content[1].type, 'image_url')
      throw Object.assign(new Error('Provider rejected visual input'), { status: 400 })
    }
    await assert.rejects(ai.chatWithTools(source, []), /Provider rejected visual input/)
    assert.equal(JSON.stringify(source), before, 'provider rejection must never remove canonical pixels')
    console.log('PASS actual AIClient request payloads: Chat Completions, Responses input_image (not JSON), native Anthropic branch, 400 preserves images')
    console.log('All tool image regression checks passed.')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
