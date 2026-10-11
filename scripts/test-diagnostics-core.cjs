const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', 'src/core/tools/diagnostics')

function makeLoader(overrides = {}) {
  const cache = new Map()
  function load(file) {
    file = path.resolve(file)
    if (cache.has(file)) return cache.get(file).exports
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText
    const mod = { exports: {} }
    cache.set(file, mod)
    const req = id => {
      const key = `${file}::${id}`
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key]
      if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id]
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
  return load
}

async function testFormatter() {
  const load = makeLoader()
  const { formatDiagnosticsOutput } = load(path.join(root, 'formatter.ts'))
  const entries = Array.from({ length: 4 }, (_, i) => ({ file: `${i}.ts`, line: i + 1, severity: 'error', message: 'record-' + i, source: 'test' }))
  const page = formatDiagnosticsOutput({ entries, failures: [], notes: [], detectedProviders: ['x'], offset: 0, limit: 3, maxChars: 10000 })
  assert.equal((page.output.match(/ERROR/g) || []).length, 3, 'limit must select whole records')
  assert.match(page.output, /Showing records 1-3 of 4/)
  const changed = formatDiagnosticsOutput({ entries, failures: [], notes: [], detectedProviders: ['x'], changedFiles: new Set(['2.ts']), cwd: process.cwd(), maxChars: 10000 })
  assert.ok(changed.output.indexOf('2.ts') < changed.output.indexOf('0.ts'), 'changed records must come first')
  const partial = formatDiagnosticsOutput({ entries: [], failures: [], notes: ['skipped target'], detectedProviders: ['x'], partial: true })
  assert.equal(partial.success, true, 'partial diagnostics are still a successful tool response')
  const long = formatDiagnosticsOutput({ entries: [{ ...entries[0], message: 'LONG'.repeat(2000) }], failures: [], notes: [], detectedProviders: ['x'], maxChars: 1000 })
  assert(!long.output.includes('LONGLONG'), 'oversized records must not be sliced')
  assert.match(long.output, /offset=0/)
}

async function testRunner() {
  const load = makeLoader()
  const runner = load(path.join(root, 'runner.ts'))
  assert.equal(await runner.isCommandAvailable('diagnostics-command-that-does-not-exist-xyz', process.cwd()), false)
  const command = process.platform === 'win32' ? 'exit /b 7' : 'exit 7'
  const failed = await runner.runDiagnosticCommand(command, process.cwd())
  assert.equal(failed.exitCode, 7)
  assert.equal(failed.failed, false, 'ordinary tool exit codes are distinct from infrastructure failure')
  assert.equal(await runner.isCommandAvailable(process.platform === 'win32' ? 'cmd /c exit 0' : 'node --version'), true)
  const source = fs.readFileSync(path.join(root, 'runner.ts'), 'utf8')
  assert.match(source, /npx --no-install/, 'runner must never auto-install probes')
  assert.ok(source.includes("process.env.SystemRoot || 'C:\\\\Windows'"), 'Windows shell must have a SystemRoot fallback')
}

async function testIndex() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-index-'))
  const calls = [], active = { n: 0, max: 0 }, state = { trace: null }
  const provider = (name, marker, extensions, run) => ({
    name, extensions,
    detect(dir) { return fs.existsSync(path.join(dir, marker)) },
    async run(...args) { return run(...args) }
  })
  const mocks = [
    provider('python', 'backend.marker', ['.py'], async (dir, files) => {
      calls.push(['python', dir, files]); active.n++; active.max = Math.max(active.max, active.n)
      await new Promise(r => setTimeout(r, 20)); active.n--
      return { entries: [{ file: '', line: 0, severity: 'error', message: 'global', source: 'python' }] }
    }),
    provider('typescript', 'frontend.marker', ['.ts'], async (dir, files) => {
      calls.push(['typescript', dir, files]); active.n++; active.max = Math.max(active.max, active.n)
      await new Promise(r => setTimeout(r, 10)); active.n--
      return { entries: [{ file: 'src/app.ts', line: 1, severity: 'error', message: 'frontend', source: 'tsc' }] }
    }),
    provider('json', '.github', ['.json'], async (dir, files) => {
      calls.push(['json', dir, files]);
      await new Promise(r => setTimeout(r, 5))
      return { entries: [] }
    }),
    provider('trace', 'trace.marker', ['.trace'], async () => {
      state.trace.results.push({ exitCode: 9 })
      state.trace.failed = true
      state.trace.output.push('unparsed failure')
      return { entries: [] }
    })
  ]
  // The index's custom transpile-loader seam replaces the provider registry and runner.
  const runnerMock = {
    withDiagnosticCommandTrace(trace, fn) { state.trace = trace; return fn() },
    async runDiagnosticCommand() { state.trace.results.push({ exitCode: 9 }); state.trace.failed = true; state.trace.output.push('unparsed failure') }
  }
  const providersMock = { DIAGNOSTIC_PROVIDERS: mocks }
  const indexFile = path.join(root, 'index.ts')
  const load = makeLoader({ [`${indexFile}::./providers`]: providersMock, [`${indexFile}::./runner`]: runnerMock })
  try {
    const backend = path.join(temp, 'backend'), frontend = path.join(temp, 'frontend')
    fs.mkdirSync(path.join(backend, 'nested'), { recursive: true }); fs.mkdirSync(path.join(frontend, 'src', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(backend, 'backend.marker'), ''); fs.writeFileSync(path.join(backend, 'nested', 'service.py'), '')
    fs.writeFileSync(path.join(frontend, 'frontend.marker'), ''); fs.writeFileSync(path.join(frontend, 'src', 'app.ts'), '')
    fs.writeFileSync(path.join(frontend, 'src', 'nested', 'frontend.marker'), ''); fs.writeFileSync(path.join(frontend, 'src', 'nested', 'other.ts'), '')
    fs.writeFileSync(path.join(frontend, 'junk.txt'), '')
    fs.mkdirSync(path.join(temp, '.github', 'workflows'), { recursive: true }); fs.writeFileSync(path.join(temp, '.github', 'workflows', 'config.json'), '{}')
    fs.writeFileSync(path.join(temp, 'trace.marker'), ''); fs.writeFileSync(path.join(temp, 'x.trace'), '')
    const { getDiagnostics } = load(indexFile)
    const result = await getDiagnostics(temp)
    assert.equal(result.success, true)
    assert.match(result.output, /PARTIAL/)
    assert.match(result.output, /incomplete command check/)
    assert.match(result.output, /unparsed failure/)
    assert.equal(calls.filter(c => c[0] === 'python').length, 1)
    assert.equal(calls.filter(c => c[0] === 'typescript').length, 2, 'both frontend configs must run')
    assert.equal(calls.find(c => c[0] === 'python')[2], undefined, 'project providers receive no unrelated file list')
    assert.ok(calls.filter(c => c[0] === 'typescript').every(c => c[2] === undefined), 'frontend project checks receive no unrelated file list')
    assert.ok(calls.find(c => c[0] === 'json')[2].some(f => f.includes('.github')))
    assert.ok(calls.every(c => !c[2] || c[2].every(f => !f.endsWith('junk.txt'))), 'unrelated files must not be passed')
    assert.equal(calls.filter(c => c[0] === 'python').length, 1, 'nested backend marker must not duplicate parent run')
    assert.ok(active.max <= 4, 'diagnostic execution must be bounded')
    assert.ok(calls.find(c => c[0] === 'python'), 'nested provider marker must be detected')
    assert.ok(result.output.includes('global'), 'global file="" entries must be retained')
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

;(async () => {
  await testFormatter(); await testRunner(); await testIndex()
  if (process.argv.includes('--smoke')) {
    const { getDiagnostics } = makeLoader()(path.join(root, 'index.ts'))
    const result = await getDiagnostics(path.resolve(__dirname, '..'), [
      'src/core/tools/diagnostics/index.ts', 'src/core/tools/diagnostics/runner.ts',
      'src/core/tools/diagnostics/formatter.ts', 'src/core/tools/diagnostics/providers/go.ts',
      'src/core/tools/diagnostics/providers/python.ts', 'src/core/tools/diagnostics/providers/typescript.ts',
      'src/core/tools/schemas/system.ts', 'src/core/agent/toolDispatcher.ts',
    ], { max_chars: 10000 })
    assert.equal(result.success, true)
    assert(!result.output.includes('[json-parse]'), 'TypeScript files must not reach JSON provider')
    console.log(result.output)
  }
  console.log('diagnostics core regression: PASS')
})().catch(error => { console.error(error); process.exitCode = 1 })
