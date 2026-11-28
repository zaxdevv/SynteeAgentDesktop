/* global require, __dirname, process */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the real command wrapper with a child process. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { readFileSync, realpathSync } = require('node:fs')
const { resolve } = require('node:path')
const { promisify } = require('node:util')
const ts = require('typescript')

const commandFile = resolve(__dirname, '../src/core/tools/command.ts')
const source = readFileSync(commandFile, 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const bindings = {}
new Function('require', 'exports', js)(
  name => name === './_shared' ? { execAsync: promisify(exec), smartTrimOutput: text => text } : require(name),
  bindings,
)
const { runCommand } = bindings

for (const shell of process.platform === 'win32' ? ['powershell', 'cmd'] : ['bash']) {
  test(`${shell} retains the real command status and the working directory`, async () => {
    const cwd = realpathSync(resolve(__dirname, '..'))
    const failed = await runCommand('node -e "process.exit(7)"', cwd, shell, 10)
    assert.equal(failed.success, false, failed.output)
    assert.match(failed.output, /^\[exit: 7\]/)
    assert.equal(realpathSync(failed.cwd), cwd)

    const passed = await runCommand('node -e "process.exit(0)"', cwd, shell, 10)
    assert.equal(passed.success, true, passed.output)
    assert.equal(realpathSync(passed.cwd), cwd)
  })
}
