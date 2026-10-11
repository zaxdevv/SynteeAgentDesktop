const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), assert = require('node:assert/strict')
const rows = new Map()
const db = {
  exec() {},
  transaction(fn) { return fn },
  prepare(sql) {
    return {
      get(chat) { return rows.has(chat) ? { data: rows.get(chat) } : undefined },
      run(...args) {
        if (sql.startsWith('INSERT INTO chat_goals')) rows.set(args[0], args[1])
        else if (sql.startsWith('DELETE FROM chat_goals')) rows.delete(args[0])
        else if (sql.startsWith('UPDATE chat_goals')) rows.set(args[2] ?? args[1], args[0])
      },
      all() {
        if (sql.includes('FROM chat_goals')) return [...rows].map(([chat_id, data]) => ({ chat_id, data }))
        return []
      },
    }
  },
}
const source = fs.readFileSync(path.join(__dirname, '../src/core/db/taskSummaries.ts'), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', output)(id => {
  if (id === './handle') return { getDB: () => db }
  if (id === 'uuid') return { v4: () => 'id' }
  if (id.includes('taskSummary')) return { ensureTaskSummaryStateRow() {} }
  throw new Error(id)
}, mod, mod.exports)
const { getChatGoal, setChatGoal, recoverInterruptedTaskSummaries } = mod.exports
const goal = { id: 'goal', chatId: 'chat', objective: 'Run tests', criteria: ['tests pass'], constraints: [], progress: [], evidence: [], status: 'running', steps: 0, maxSteps: 5, createdAt: 1, updatedAt: 1 }
setChatGoal(goal)
assert.equal(getChatGoal('chat').status, 'running', 'reading a goal must NOT pause active execution')
assert.equal(getChatGoal('other'), null)
recoverInterruptedTaskSummaries()
assert.equal(getChatGoal('chat').status, 'paused', 'startup recovery requires explicit resume')
assert.equal(getChatGoal('chat').objective, goal.objective)
setChatGoal({ ...goal, status: 'completed', evidence: ['test output'] })
recoverInterruptedTaskSummaries()
assert.equal(getChatGoal('chat').status, 'completed', 'recovery preserves terminal states')
assert.equal(getChatGoal('chat').evidence[0], 'test output')
setChatGoal(null, 'chat')
assert.equal(getChatGoal('chat'), null)
console.log('goal persistence regressions passed')
