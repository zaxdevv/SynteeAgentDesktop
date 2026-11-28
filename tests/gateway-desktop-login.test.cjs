/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise Agent.run and persistence with an isolated provider. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(file, deps = {}, fallback, globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(
    name => name in deps ? deps[name] : fallback && name.startsWith('.') ? fallback : require(name),
    module, module.exports, ...Object.values(globals),
  )
  return module.exports
}
function anyStub() {
  return new Proxy(function () {}, {
    get: (_, key) => key === 'then' || key === Symbol.toPrimitive ? undefined : anyStub(),
    apply: () => undefined, construct: () => ({}),
  })
}

test('normal login opens hosted Syntee authentication without desktop environment overrides', async () => {
  const opened = []
  let launch
  const gateway = load('src/main/services/gatewayClient.ts', {
    'electron-store': { default: class {} },
    './tokenStore': {},
    '../../shared/constants': {},
  }, anyStub())
  load('src/main/ipc/auth.ipc.ts', {
    electron: { shell: { openExternal: async url => opened.push(url) }, ipcMain: { handle: (channel, fn) => {
      if (channel === 'auth:login') launch = fn
    } } },
    '../services/gatewayClient': gateway,
    '@electron-toolkit/utils': { is: { dev: false } },
  }, anyStub()).registerAuthIPC(() => null)
  if (!process.env.SYNTEE_WEB_URL) {
    await launch()
    const login = new URL(opened[0])
    assert.equal(login.origin, 'https://syntee.fun')
    assert.equal(login.pathname, '/auth/desktop')
    assert.equal(login.searchParams.get('redirect'), 'synteehelper://auth/callback')
  }
  if (!process.env.SYNTEE_API_URL) assert.equal(gateway.getGatewayApiUrl(), 'https://syntee.fun')
})

test('hosted catalog uses the session and a delayed response cannot repopulate another account', async () => {
  const handlers = {}
  const requests = []
  let account = 1
  let cached = []
  let oldResponse
  const gateway = load('src/main/ipc/gateway.ipc.ts', {
    electron: { ipcMain: { handle: (channel, handler) => { handlers[channel] = handler } } },
    '../services/gatewayClient': {
      getGatewayAuthToken: async () => `account-${account}`,
      getGatewayApiUrl: () => 'https://syntee.test',
      GatewayAuthError: class extends Error {},
    },
    '../services/tokenStore': { getTokenSessionGeneration: () => account, hasTokens: () => true },
    '../../core/tokens/gatewayModelsCache': {
      GATEWAY_PROVIDER_ID: 'syntee-gateway',
      setGatewayModelsCache: models => { cached = models },
    },
  }, undefined, {
    fetch: (url, { headers }) => {
      requests.push([url, headers.Authorization])
      if (account === 1) return new Promise(resolve => { oldResponse = resolve })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [
        { id: 'new-model', display_name: 'New Model', max_tokens: 1_048_576, pricing: { input_price: 2, output_price: 5, unit: 'per_1m_tokens' } },
        { id: '' },
      ] }) })
    },
  })
  gateway.registerGatewayIPC()
  const stale = handlers['gateway:fetchModels']()
  assert.equal(stale, gateway.fetchGatewayModels())
  await Promise.resolve()
  account++
  gateway.clearGatewayCatalog()
  const result = await gateway.fetchGatewayModels()
  const rejected = assert.rejects(stale, /No active Syntee session/)
  oldResponse({ ok: true, status: 200, json: async () => ({ data: [{ id: 'old-model' }] }) })
  await rejected
  assert.deepEqual(result.models.map(model => model.id), ['new-model'])
  assert.deepEqual(cached.map(model => [model.id, model.providerId, model.contextWindow, model.inputPrice]),
    [['new-model', 'syntee-gateway', 1_048_576, 2]])
  assert.deepEqual(requests, [
    ['https://syntee.test/v1/models', 'Bearer account-1'],
    ['https://syntee.test/v1/models', 'Bearer account-2'],
  ])
})
