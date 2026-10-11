/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, __dirname, process, console, AbortController */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const filename = path.resolve(__dirname, '../src/main/browser/accessibility.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const loaded = new Module(filename, module)
loaded.filename = filename
loaded.paths = module.paths
loaded._compile(compiled, filename)
const { captureAccessibility } = loaded.exports

function mock(nodes, external = false) {
  const debuggerMock = {
    attached: external,
    attachCalls: 0,
    detachCalls: 0,
    commandCalls: [],
    isAttached() { return this.attached },
    attach() { this.attachCalls++; this.attached = true },
    detach() { this.detachCalls++; this.attached = false },
    async sendCommand(method, params) {
      this.commandCalls.push({ method, params })
      return { nodes }
    },
  }
  return { debugger: debuggerMock }
}

async function main() {
  const nodes = [
    { role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'person@example.test' }, properties: [{ name: 'focused', value: { value: true } }] },
    { role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'DO NOT LEAK' }, properties: [{ name: 'autocomplete', value: { value: 'current-password' } }] },
    { role: { value: 'button' }, name: { value: 'Submit' }, properties: [{ name: 'disabled', value: { value: true } }] },
  ]
  const wc = mock(nodes)
  const result = await captureAccessibility(wc, { frameId: 'raw-frame-id', maxNodes: 2 })
  assert.equal(result.nodes.length, 2)
  assert.equal(result.truncated, true)
  assert.equal(wc.debugger.attachCalls, 1)
  assert.equal(wc.debugger.detachCalls, 0)
  assert.deepEqual(wc.debugger.commandCalls[0], { method: 'Accessibility.getFullAXTree', params: { frameId: 'raw-frame-id' } })
  assert.equal(result.nodes[0].value, 'person@example.test')
  assert.ok(!JSON.stringify(result.nodes).includes('DO NOT LEAK'))

  const existing = mock(nodes, true)
  await captureAccessibility(existing, { maxNodes: 1201 })
  assert.equal(existing.debugger.attachCalls, 0)
  assert.equal(existing.debugger.detachCalls, 0)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => captureAccessibility(mock(nodes), {}, controller.signal), /Accessibility capture aborted/)

  let release
  const pending = new Promise(resolve => { release = resolve })
  const cancellingDebugger = mock(nodes)
  cancellingDebugger.debugger.sendCommand = async function (method, params) {
    this.commandCalls.push({ method, params })
    await pending
    return { nodes }
  }
  const during = new AbortController()
  const capture = captureAccessibility(cancellingDebugger, {}, during.signal)
  during.abort()
  release()
  await assert.rejects(() => capture, /Accessibility capture aborted/)
  assert.equal(cancellingDebugger.debugger.detachCalls, 0)
  console.log('browser-accessibility tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
