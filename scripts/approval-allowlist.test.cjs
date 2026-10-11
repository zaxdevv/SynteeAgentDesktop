const fs = require('fs'), ts = require('typescript'), assert = require('assert'), path = require('path')
const src = fs.readFileSync(path.join(__dirname, '../src/main/services/approvalAllowlist.ts'), 'utf8')
const output = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', output)((id) => id.includes('commandSafety') ? {
  actionAllowlistKey: (tool, args) => `${tool}|${JSON.stringify(args)}`,
  normalizeCommandKey: value => value.trim().toLowerCase(),
  classifyTool: (_tool, args) => ({ level: args.danger ? 'dangerous' : 'warn' }),
} : require, mod, mod.exports)
const { persistApprovalGrant } = mod.exports
const state = {}
const store = { get: key => state[key], set: (key, value) => { state[key] = value } }
const save = (opts = {}) => persistApprovalGrant(store, { toolName: 'custom', args: {}, chatId: 'chat-1', approved: true, always: 'session', ...opts })
assert.ok(save())
assert.equal(state.chatApprovalAllowlist['chat-1'].length, 1) // available in subsequent worker snapshots
assert.equal(state.chatApprovalAllowlist['chat-2'], undefined)
assert.equal(save({ approved: false }), undefined)
assert.equal(save({ args: { danger: true }, always: 'global' }), undefined)
assert.equal(save({ always: 'project' }), undefined)
assert.equal(save({ always: 'project', projectId: 'p', role: 'subagent' }), undefined)
const one = save({ always: 'global', args: { a: 1 } }), two = save({ always: 'global', args: { a: 2 } })
assert.notEqual(one.pattern, two.pattern)
// Exercise the real matcher (legacy patterns remain action-scoped, including '*').
const safetySrc = fs.readFileSync(path.join(__dirname, '../src/core/agent/commandSafety.ts'), 'utf8')
const safetyOut = ts.transpileModule(safetySrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const safetyMod = { exports: {} }
new Function('require', 'module', 'exports', safetyOut)((id) => id === 'path' ? path : id.includes('../../shared/types') ? { DEFAULT_AUTO_MODE_SETTINGS: {} } : require, safetyMod, safetyMod.exports)
const { isAllowlisted } = safetyMod.exports
const toolGrant = save({ toolWide: true })
assert.equal(toolGrant.match, 'tool')
assert.ok(isAllowlisted('custom', { different: 'args' }, { entries: [toolGrant] }))
assert.ok(!isAllowlisted('other', {}, { entries: [toolGrant] }))
const legacyStar = { tool: 'run_command', pattern: 'npm install *', scope: 'global', createdAt: Date.now() }
assert.ok(isAllowlisted('run_command', { command: 'npm install package-a' }, { entries: [legacyStar] }))
assert.ok(!isAllowlisted('run_command', { command: 'git status' }, { entries: [legacyStar] }))
const persistedTool = save({ toolName: 'custom', args: {}, always: 'global', toolWide: true })
assert.ok(isAllowlisted('custom', { nextMessage: true }, { entries: [persistedTool] }))
assert.equal(save({ toolWide: true, args: { danger: true } }), undefined)
// Both mouse and keyboard approval must transmit the explicit tool-wide choice.
const dialog = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/ui/AgentConfirmDialog/AgentConfirmDialog.tsx'), 'utf8')
assert.ok(dialog.includes('onClick={() => respond(current.reqId, true, always && canAlways ? allowScope : undefined, always && canAlways && toolWide)}'))
assert.ok(dialog.includes('respond(current.reqId, true, always && canAlways ? allowScope : undefined, always && canAlways && toolWide)'))
console.log('approval allowlist tests passed')
