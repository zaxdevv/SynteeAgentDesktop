import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import ts from 'typescript'

function serviceHarness(text) {
  let reads = 0
  const request = { requestId: 'request', chatId: 'child', sourceChatId: 'parent', userMessageId: 'user', status: 'done', createdAt: 1, updatedAt: 2 }
  const rows = {
    parent: { id: 'parent', title: 'Parent', isIncognito: 0 },
    child: { id: 'child', title: 'Child', isIncognito: 0 },
  }
  const source = readFileSync(new URL('../src/main/services/delegatedChats.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => {
    if (name === 'uuid') return { v4: () => 'new-id' }
    if (name === '../../core/db') return {
      getMessageById: () => ({ content: text, finishReason: 'done' }), getStreamingBuffer: () => null,
      getDB: () => ({ prepare: () => ({ get: () => rows.child }) }),
    }
    if (name.endsWith('/db/delegatedChats')) return {
      getDelegationChat: id => rows[id], ownsDelegatedChat: (parent, child) => parent === 'parent' && child === 'child',
      getDelegatedRequest: () => request, markDelegatedRequestRead: () => { reads++ },
      updateDelegatedRequest: () => {}, delegatedRequestListeners: new Set(),
    }
    if (name.endsWith('/ipc/chatShared')) return { activeRuns: new Map(), activeRunMeta: new Map(), chatQueues: new Map(), runStatusListeners: new Set() }
    throw new Error(`Unexpected import ${name}`)
  }, module, module.exports)
  return { api: module.exports, reads: () => reads }
}
const context = { chatId: 'parent', planningMode: false, askMode: false, allowedTools: ['manage_chats'], incognito: false }
const backend = { changed: () => {}, stop: () => false }

test('only a nonempty completed result read marks delegation as consumed', async () => {
  const harness = serviceHarness('Result')
  const beyond = await harness.api.executeManageChats({ action: 'read', chat_id: 'child', offset: 999 }, context, backend)
  assert.equal(beyond.success, true)
  assert.equal(harness.reads(), 0)
  await harness.api.executeManageChats({ action: 'status', chat_id: 'child' }, context, backend)
  assert.equal(harness.reads(), 0)
  const result = await harness.api.executeManageChats({ action: 'read', chat_id: 'child' }, context, backend)
  assert.equal(JSON.parse(result.output).content, 'Result')
  assert.equal(harness.reads(), 1)
})

test('empty completed result is not marked read', async () => {
  const harness = serviceHarness('   ')
  const result = await harness.api.executeManageChats({ action: 'read', chat_id: 'child' }, context, backend)
  assert.equal(result.success, true)
  assert.equal(harness.reads(), 0)
})

test('delegated access rejects unrelated children and incognito', async () => {
  const harness = serviceHarness('Result')
  const denied = await harness.api.executeManageChats({ action: 'read', chat_id: 'unowned' }, context, backend)
  assert.equal(denied.success, false)
  const privateRead = await harness.api.executeManageChats({ action: 'read', chat_id: 'child' }, { ...context, incognito: true }, backend)
  assert.equal(privateRead.success, false)
  assert.equal(harness.reads(), 0)
})
