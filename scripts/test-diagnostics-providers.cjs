const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '../src/core/tools/diagnostics')
const cache = new Map()
const mocks = { commands: [], available: true, result: null }

function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText
  const mod = { exports: {} }
  cache.set(file, mod)
  const req = (id) => {
    if (id === '../runner') return {
      isCommandAvailable: async () => mocks.available,
      runDiagnosticCommand: async (command) => { mocks.commands.push(command); return mocks.result }
    }
    if (id === 'typescript') return require('typescript')
    if (['path', 'fs', 'fs/promises', 'os', 'async_hooks', 'child_process', 'util'].includes(id)) return require(id)
    if (id.startsWith('.')) {
      const base = path.resolve(path.dirname(file), id)
      const target = fs.existsSync(base + '.ts') ? base + '.ts' : base + '/index.ts'
      return load(target)
    }
    return require(id)
  }
  new Function('require', 'module', 'exports', '__filename', '__dirname', js)(req, mod, mod.exports, file, path.dirname(file))
  return mod.exports
}

;(async () => {
  const utils = load(path.join(root, 'providers/_utils.ts'))
  const global = { file: '', line: 0, severity: 'error', message: 'global', source: 'tsc' }
  const selected = { file: 'src/A.ts', line: 1, severity: 'error', message: 'selected', source: 'tsc' }
  const filtered = utils.filterEntriesByFiles([global, selected], '/work', ['/work/src/a.ts'])
  assert.deepEqual(filtered, [global, selected], 'global diagnostics are retained and Windows path matching is case insensitive')

  const python = load(path.join(root, 'providers/python.ts')).pythonProvider
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-providers-'))
  try {
    const pyFile = path.join(temp, 'bad python.py')
    fs.writeFileSync(pyFile, 'def broken(:\n')
    mocks.available = false
    mocks.commands.length = 0
    mocks.result = { stdout: '', stderr: '', exitCode: null, failed: true, failureReason: 'missing python' }
    const pythonResult = await python.run(temp, [pyFile])
    assert.equal(mocks.commands.length, 1)
    assert.match(mocks.commands[0], /compile\(/)
    assert.match(mocks.commands[0], /".*bad python\.py"/)
    assert(!mocks.commands[0].includes('py_compile'))
    assert(pythonResult.failed, 'missing python during fallback must be a failed run')

    const markdown = load(path.join(root, 'providers/markdown.ts')).markdownProvider
    mocks.available = true
    mocks.commands.length = 0
    mocks.result = { stdout: JSON.stringify([{ fileName: 'README.md', lineNumber: 7, ruleNames: ['MD001', 'heading-increment'], ruleDescription: 'Heading levels should increment by one' }]),
      stderr: '', exitCode: 1, failed: false }
    const markdownResult = await markdown.run(temp, ['README.md'])
    assert.equal(markdownResult.entries.length, 1, 'markdownlint JSON is a flattened issue array')
    assert.equal(markdownResult.entries[0].file, 'README.md')
    assert.match(markdownResult.entries[0].message, /MD001\/heading-increment/)

    mocks.commands.length = 0
    mocks.result = { stdout: '[]', stderr: 'warning text', exitCode: 0, failed: false }
    const stderrResult = await markdown.run(temp, ['README.md'])
    assert.match(stderrResult.failed, /stderr/)

    const typescript = load(path.join(root, 'providers/typescript.ts')).typescriptProvider
    const project = path.join(temp, 'ts-project')
    fs.mkdirSync(path.join(project, 'packages', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(project, 'tsconfig.json'), '{"references":[{"path":"./packages/lib"}]}')
    fs.writeFileSync(path.join(project, 'packages/lib/tsconfig.json'), '{"compilerOptions":{"composite":true},"files":[]}')
    fs.writeFileSync(path.join(project, 'tsconfig.updates-check.json'), '{"files":[]}')
    mocks.commands.length = 0
    mocks.result = { stdout: '', stderr: '', exitCode: 0, failed: false }
    const tsResult = await typescript.run(project)
    assert.equal(mocks.commands.length, 2, 'root config and referenced configs are processed, not random tsconfig variants')
    assert(mocks.commands.some((command) => command.includes('packages/lib/tsconfig.json')))
    assert(!mocks.commands.some((command) => command.includes('tsconfig.updates-check.json')))
    assert.equal(tsResult.failed, undefined)
    mocks.result = { stdout: 'src/test.ts(2,3): error TS2322: bad type\r\nerror TS5023: invalid option\r\n', stderr: '', exitCode: 2, failed: false }
    const crlfResult = await typescript.run(project, ['src/test.ts'])
    assert(crlfResult.entries.some(e => e.line === 2), 'Windows CRLF diagnostics must parse')
    assert(crlfResult.entries.some(e => e.file === ''), 'global config errors must survive the files filter')

    const yaml = load(path.join(root, 'providers/yaml.ts')).yamlProvider
    mocks.result = { stdout: 'test.yml:3:2: [error] bad indent (indentation)\r\n', stderr: '', exitCode: 1, failed: false }
    const yamlResult = await yaml.run(temp, ['test.yml'])
    assert.equal(yamlResult.entries.length, 1)
    assert(mocks.commands.at(-1).includes('-f parsable'))
    mocks.result = { stdout: '', stderr: '', exitCode: 0, failed: false }

    const emptyProject = path.join(temp, 'without-config')
    fs.mkdirSync(emptyProject)
    const skipped = await typescript.run(emptyProject)
    assert.equal(skipped.note && skipped.note.includes('skipped'), true)
    assert.equal(skipped.failed, undefined)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
  console.log('diagnostics providers regression: PASS')
})().catch((error) => { console.error(error); process.exitCode = 1 })
