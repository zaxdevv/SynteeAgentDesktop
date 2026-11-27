/* global require, AbortController, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- Run Code Mode on the project's Node runtime. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { executeCode, EphemeralArtifactStore } = require('../src/core/codeMode/index.ts')
const call = async (name, args) => {
  if (name === 'first') return { success: true, output: String(args.n + 1) }
  if (name === 'second') return { success: true, output: `got:${args.v}` }
  if (name === 'fail') return { success: false, output: '', error: 'expected failure' }
  if (name === 'execute_code') throw new Error('should never call')
  return { success: true, output: JSON.stringify(args) }
}
test('basic TypeScript execution', async () => {
  const r = await executeCode({ code: 'const n: number = 2; return n * 3;', callTool: call })
  assert.equal(r.success, true); assert.match(r.output, /6/)
})
test('dependent and parallel tools; structured failure returned', async () => {
  const r = await executeCode({ code: "const a = await tools.first({n: 4}); const b = await tools.second({v: a.output}); const both = await Promise.all([tools.first({n:1}), tools.first({n:2})]); const bad = await tools.fail({}); return [b.output, both.length, bad.success];", callTool: call })
  assert.equal(r.success, true); assert.match(r.output, /got:5/)
})
test('recursive execute_code is denied', async () => {
  const r = await executeCode({ code: "return await tools.call('execute_code', {});", callTool: call })
  assert.equal(r.success, true); assert.match(r.output, /Recursive Code Mode/)
})
test('infinite loop respects interrupt timeout', async () => {
  const r = await executeCode({ code: 'while (true) {}', callTool: call, timeoutMs: 100 })
  assert.equal(r.success, false); assert.match(r.error, /timed out/i)
})
test('abort is honored', async () => {
  const controller = new AbortController(); setTimeout(() => controller.abort(), 30)
  const r = await executeCode({ code: "await tools.wait({}); return 'done';", callTool: async () => new Promise(resolve => setTimeout(() => resolve({success:true, output:'ok'}), 300)), signal: controller.signal, timeoutMs: 3000 })
  assert.equal(r.success, false); assert.match(r.error, /abort/i)
})
test('host globals unavailable', async () => {
  const r = await executeCode({ code: "return [typeof process, typeof require, typeof fetch, typeof Buffer];", callTool: call })
  assert.equal(r.success, true); assert.match(r.output, /undefined/)
})
test('artifacts are scoped by chat and require chatId', () => {
  const store = new EphemeralArtifactStore()
  const id = store.save('chat-a', { secret: 'x' })
  assert.deepEqual(store.load('chat-a', id), { secret: 'x' }); assert.equal(store.load('chat-b', id), undefined)
  assert.throws(() => store.save('', 1), /chatId/)
})
test('artifact API works inside guest', async () => {
  const r = await executeCode({ chatId: 'chat', artifacts: new EphemeralArtifactStore(), callTool: call, code: "const id = await artifacts.save({n: 7}); return await artifacts.load(id);" })
  assert.equal(r.success, true); assert.match(r.output, /7/)
})
test('long host call does not consume the script time budget', async () => {
  // Бюджет CPU гостя отдельно от абсолютного лимита wall-clock.
  const r = await executeCode({
    code: "const a = await tools.slow({}); return 'ok:' + a.success;",
    callTool: async () => new Promise(resolve => setTimeout(() => resolve({ success: true, output: 'slow done' }), 300)),
    timeoutMs: 100,
    wallTimeoutMs: 1000,
  })
  assert.equal(r.success, true); assert.match(r.output, /ok:true/)
})
test('a hung host call hits the absolute wall-clock limit and aborts its signal', async () => {
  let sawAbort = false
  const r = await executeCode({
    code: "await tools.never({}); return 'should not finish';",
    callTool: (_name, _args, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => { sawAbort = true; resolve({ success: false, output: '', error: 'aborted' }) }, { once: true })
    }),
    timeoutMs: 10_000,
    wallTimeoutMs: 80,
  })
  assert.equal(r.success, false)
  assert.match(r.error, /wall-clock limit/i)
  assert.equal(sawAbort, true)
})
test('a TypeScript batch can wait beyond its ordinary wall limit for MCP', async () => {
  const result = await executeCode({
    code: "const first = await tools.call('mcp__fixture__analyze', {}); return (await tools.call('mcp__fixture__summarize', { text: first.output })).output;",
    callTool: async (name, args) => {
      if (name.endsWith('__analyze')) {
        await new Promise(resolve => setTimeout(resolve, 180))
        return { success: true, output: 'raw' }
      }
      return { success: true, output: 'summary of ' + args.text }
    },
    wallTimeoutMs: 100,
    mcpWaitBudgetMs: 1000,
  })
  assert.equal(result.success, true)
  assert.equal(result.output, 'summary of raw')
})
test('MCP waiting is bounded and interrupted on expiry', async () => {
  let nestedSignal
  const result = await executeCode({
    code: "return await tools.call('mcp__fixture__never', {});",
    callTool: (_name, _args, signal) => {
      nestedSignal = signal
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({ success: false, output: '' }), { once: true }))
    },
    wallTimeoutMs: 100,
    mcpWaitBudgetMs: 50,
  })
  assert.match(result.error, /wall-clock limit/i)
  assert.equal(nestedSignal?.aborted, true)
})
test('returning early cancels any started tool the script did not await', async () => {
  let nestedSignal
  const result = await executeCode({
    code: "tools.call('mcp__fixture__never', {}); await tools.first({}); return 'done';",
    callTool: (name, _args, signal) => {
      if (name === 'first') return { success: true, output: '' }
      nestedSignal = signal
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({ success: false, output: '' }), { once: true }))
    },
  })
  assert.equal(result.output, 'done')
  assert.equal(nestedSignal?.aborted, true)
})
test('failed nested tool output preserves the error text in its trace', async () => {
  const r = await executeCode({
    code: "await tools.fail({}); return 'done';",
    callTool: async () => ({ success: false, output: '', error: 'blocked by approval' }),
  })
  assert.equal(r.success, true)
  assert.equal(r.trace?.[0]?.status, 'failure')
  assert.equal(r.trace?.[0]?.result, 'blocked by approval')
})
test('denied nested call is returned to the guest instead of aborting the program', async () => {
  const r = await executeCode({
    code: "const denied = await tools.write_file({ path: 'x' }); const next = await tools.read_file({ path: 'y' }); return [denied.success, String(denied.error || '').includes('Rejected'), next.success];",
    callTool: async name => name === 'write_file'
      ? { success: false, output: 'Rejected by the user', error: 'Rejected by the user' }
      : { success: true, output: 'file body' },
  })
  assert.equal(r.success, true); assert.match(r.output, /false,true,true/)
})
test('Agent blocks execute_code recursion and unknown tools at the bridge', () => {
  const source = readFileSync('src/core/agent/Agent.ts', 'utf8')
  // Ре-энтри execute_code и тулы вне схем раунда блокируются на мосту.
  assert.match(source, /toolName === 'execute_code' \|\| !schemasForRequest\(permittedSchemas\)\.concat\(permittedSchemas\)\.some\(s => s\.function\.name === toolName\)/)
  // §orchestration — фазовый allowlist проверяется и для вложенных вызовов:
  // read-only фаза не даёт «убежать» через Code Mode.
  assert.match(source, /orchestration && !isToolAllowedInPhase\(orchestration\.phase, toolName\)/)
})
test('ToolChain shows execute_code calls in the collapsed card and arguments/results after opening', () => {
  const source = readFileSync('src/renderer/src/components/ui/ToolChain/ToolChain.tsx', 'utf8')
  assert.ok(source.includes('function CodeModeSummary'))
  // Трейс берётся с шага результата, а до его прихода — с шага вызова
  // (живой трейс agent:code_trace), иначе во время выполнения карточка пуста.
  assert.ok(source.includes('iter.result?.codeMode ?? iter.call.codeMode'))
  assert.match(source, /<CodeModeSummary trace=\{codeMode\.trace\}/)
  assert.ok(source.includes('codeTraceArgs(entry.args)'))
  assert.ok(source.includes('result={{ content: entry.result, success:'))
  assert.ok(source.includes('title="Скрипт TypeScript"'))
})
test('code mode streams nested tool trace while the script runs', () => {
  const codeMode = readFileSync('src/core/codeMode/index.ts', 'utf8')
  // Запись появляется со status:'running' ДО ответа тула, затем апсертится.
  assert.ok(codeMode.includes("status: 'running'"))
  assert.match(codeMode, /emitTrace\(traceEntry\)/)
  const agent = readFileSync('src/core/agent/Agent.ts', 'utf8')
  assert.match(agent, /onTrace: entry => \{/)
  const hook = readFileSync('src/renderer/src/hooks/useToolProgress.ts', 'utf8')
  assert.ok(hook.includes("window.syntee.on('agent:code_trace'"))
})
test('onTrace fires running first and final status with the same id', async () => {
  const seen = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const promise = executeCode({
    code: "const r = await tools.slow({}); return r.output;",
    callTool: async () => {
      await gate
      return { success: true, output: 'ok' }
    },
    onTrace: entry => seen.push({ id: entry.id, status: entry.status, result: entry.result }),
  })
  // Дать гостю дойти до вызова тула (он ждёт gate).
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].status, 'running')
  assert.ok(seen[0].id)
  release()
  const r = await promise
  assert.equal(r.success, true)
  assert.equal(seen.length, 2)
  assert.equal(seen[1].id, seen[0].id)
  assert.equal(seen[1].status, 'success')
  assert.equal(seen[1].result, 'ok')
})
test('live agent:step preserves execute_code trace in ToolStep', () => {
  const source = readFileSync('src/renderer/src/hooks/useToolProgress.ts', 'utf8')
  assert.match(source, /codeMode\?: \{ code: string; trace\?: Array/)
  assert.match(source, /codeMode: step\.codeMode/)
})
test('Agent does not abort the script when a nested call is blocked', () => {
  const source = readFileSync('src/core/agent/Agent.ts', 'utf8')
  assert.ok(!source.includes('if (blocked) codeAbort.abort()'), 'blocked nested call must not kill the script')
  assert.ok(!source.includes("codeModeEnabled"), 'execute_code must not be gated by a global setting')
})
