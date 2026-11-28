/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise Agent.run and persistence with an isolated provider. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(file, deps = {}, fallback) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => name in deps ? deps[name] : fallback && name.startsWith('.') ? fallback : require(name), module, module.exports)
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
