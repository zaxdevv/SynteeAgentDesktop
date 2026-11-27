const assert = require('node:assert/strict')
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { resolve, posix, win32 } = require('node:path')
const { tmpdir } = require('node:os')
const { test } = require('node:test')
const ts = require('typescript')

const root = resolve(__dirname, '..')

function load(file, mocks = {}, platform = 'linux', extraSource = '', globals = {}) {
  const source = readFileSync(resolve(root, file), 'utf8') + extraSource
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const module = { exports: {} }
  const runtimeProcess = { ...process, platform, env: { ...process.env, PATH: platform === 'win32' ? 'C:\\bin' : '/bin' } }
  const names = ['require', 'module', 'exports', 'process', ...Object.keys(globals)]
  const values = [id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports, runtimeProcess, ...Object.values(globals)]
  new Function(...names, output)(...values)
  return module.exports
}

function loadPty(platform = 'linux') {
  const paths = platform === 'win32' ? win32 : posix
  const names = platform === 'win32' ? ['pwsh.exe', 'cmd.exe'] : ['bash', 'zsh', 'fish', 'nu']
  const executables = new Set(names.map(name => paths.join(platform === 'win32' ? 'C:\\bin' : '/bin', name)))
  const launches = []
  const fs = {
    constants: { X_OK: 1 },
    existsSync: path => executables.has(path),
    accessSync(path) { if (!executables.has(path)) throw new Error('ENOENT') },
    statSync: () => ({ isFile: () => true })
  }
  const batcher = class { push() {} flush() {} releaseFlow() {} dispose() {} }
  const pty = { spawn(file, args, options) {
    launches.push({ file, args, options })
    return { onData() {}, onExit() {}, write() {}, kill() {}, pause() {}, resume() {} }
  } }
  return { launches, ...load('src/main/managers/PtyManager.ts', {
    'node-pty': pty, electron: {}, fs, path: paths,
    '../../core/tools/_shared': { stripAnsi: text => text },
    './ptyOutputBatcher': { PtyOutputBatcher: batcher }
  }, platform) }
}

test('Unix shells retain distinct identities and create the selected executable', () => {
  const { detectShells, ptyManager, launches } = loadPty()
  assert.deepEqual(detectShells().map(shell => shell.type), ['bash', 'zsh', 'nushell', 'fish'])
  for (const shell of detectShells()) {
    const id = ptyManager.create('chat', shell.type, '/tmp')
    assert.equal(launches.at(-1).file, shell.file)
    assert.equal(launches.at(-1).options.env.LC_ALL, 'C.UTF-8')
    assert.equal(ptyManager.getMeta(id).shell, shell.type)
  }
  ptyManager.killAll()
})

test('Windows shell detection still resolves executable names from PATH', () => {
  const { detectShells, ptyManager, launches } = loadPty('win32')
  assert.deepEqual(detectShells().map(shell => shell.type), ['powershell', 'cmd'])
  ptyManager.create('chat', 'cmd', 'C:\\work')
  assert.equal(launches[0].file, 'C:\\bin\\cmd.exe')
  ptyManager.killAll()
})

test('cwd commands quote apostrophes for each shell grammar', () => {
  const { ptyManager } = loadPty()
  assert.equal(ptyManager.buildCdCommand('zsh', "/tmp/a'b"), "cd '/tmp/a'\\''b'")
  assert.equal(ptyManager.buildCdCommand('fish', "/tmp/a'b"), "cd '/tmp/a\\'b'")
  assert.equal(ptyManager.buildCdCommand('nushell', '/tmp/a"b'), 'cd "/tmp/a\\"b"')
  assert.equal(ptyManager.buildCdCommand('powershell', "C:\\a'b"), "Set-Location -LiteralPath 'C:\\a''b'")
})

test('core and code-mode prompts describe the active platform and shell', () => {
  for (const [platform, osName, shell] of [['linux', 'Linux', 'Bash'], ['darwin', 'macOS', 'Bash'], ['win32', 'Windows', 'PowerShell']]) {
    const sections = new Proxy({}, { get: () => () => '' })
    const builder = load('src/core/prompts/buildSystemPrompt.ts', { './sections': sections, '../../shared/toolSettings': {} }, platform)
    assert.ok(builder.buildSystemPromptParts({}).staticPart.startsWith(`You are Syntee — a personal AI assistant for ${osName}.`))
    const codeMode = load('src/core/prompts/sections/codeModeSection.ts', {
      '../../../shared/codeNavigationGuidance': load('src/shared/codeNavigationGuidance.ts', {}, platform),
    }, platform).buildCodeModeBlock()
    assert.ok(codeMode.includes(`You are running on ${osName}.`))
    assert.ok(codeMode.includes(`use ${shell}-compatible commands by default`))
  }
})

test('visualizer skips hidden windows and silent FFT while preserving decay and immediate resume', () => {
  let visible = true
  let minimized = false
  let fftCount = 0
  const frames = []
  const window = { isVisible: () => visible, isMinimized: () => minimized, webContents: { send: (_channel, frame) => frames.push(frame) } }
  const mainWindow = { getWindow: () => window }
  const state = load('src/main/ipc/audioVisualizer.ipc.ts', {
    electron: {}, '../audio/nativeAudio': {}, '../audio/pulseAudio': {}
  }, 'linux', `
    exports.probe = {
      chunk: handlePcmChunk,
      tick() { lastEmitAt = 0 },
      init() { controller = { stop() {} }; format = { channels: 2 }; computeBandEdges(48000) },
      get filled() { return ringFilled },
      get level() { return smoothLevel }
    };
    const actualFft = fft;
    fft = (...args) => { countFft(); actualFft(...args) };
  `, { countFft: () => fftCount++ })
  state.probe.init()
  const signal = Buffer.alloc(2048 * 4)
  for (let i = 0; i < 2048; i++) {
    const sample = Math.round(Math.sin(i * Math.PI / 20) * 8000)
    signal.writeInt16LE(sample, i * 4)
    signal.writeInt16LE(sample, i * 4 + 2)
  }
  state.probe.chunk(mainWindow, signal)
  assert.equal(fftCount, 1)
  assert.ok(state.probe.level > 0)
  const previousLevel = state.probe.level
  state.probe.tick()
  state.probe.chunk(mainWindow, Buffer.alloc(signal.length))
  assert.equal(fftCount, 1)
  assert.ok(state.probe.level > 0 && state.probe.level < previousLevel)
  assert.ok(frames.length >= 2)
  visible = false
  state.probe.chunk(mainWindow, signal)
  assert.equal(state.probe.filled, 0)
  assert.equal(state.probe.level, 0)
  assert.equal(fftCount, 1)
  visible = true
  minimized = true
  state.probe.chunk(mainWindow, signal)
  assert.equal(fftCount, 1)
  minimized = false
  state.probe.chunk(mainWindow, signal)
  assert.equal(fftCount, 2)
  assert.ok(state.probe.level > 0)
})

test('project analysis keeps names and reads no manifests or subtrees', async () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'syntee-project-'))
  const directory = resolve(fixture, 'project $name `text`')
  mkdirSync(directory)
  writeFileSync(resolve(directory, 'README.md'), '# Fixture')
  mkdirSync(resolve(directory, 'node_modules'))
  writeFileSync(resolve(directory, 'node_modules', 'ignored.txt'), 'ignored')
  try {
    const { analyzeProject } = load('src/core/tools/projectAnalyze.ts', {
      '../projectMap/projectScan': load('src/core/projectMap/projectScan.ts'),
      './_shared': {
        DEFAULT_IGNORE_DIRS: ['node_modules', '.git'],
        resolveToolPath: path => path,
      }
    })
    const result = await analyzeProject(directory)
    assert.equal(result.success, true)
    assert.ok(result.output.includes('README.md'))
    assert.ok(!result.output.includes('# Fixture'))
    assert.ok(!result.output.includes('ignored.txt'))
    assert.ok(!result.output.includes('node_modules'))
    assert.ok(!result.output.includes(directory))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

function loadSearch(run, platform = 'linux') {
  let shellCalls = 0
  const module = load('src/core/tools/codeSearch.ts', {
    fs: { existsSync: () => true },
    '@vscode/ripgrep': {},
    './_shared': {
      DEFAULT_IGNORE_DIRS: [], execFileAsync: run,
      execAsync: async () => { shellCalls++; return { stdout: '/tmp/main.ts:1: needle' } }
    }
  }, platform)
  return { ...module, shellCalls: () => shellCalls }
}

test('Linux search discovers system rg directly and retains structured matches', async () => {
  const calls = []
  const search = loadSearch(async (file, args) => {
    calls.push({ file, args })
    if (args[0] === '--version') return { stdout: 'ripgrep 15', stderr: '' }
    if (args[0] === '--count-matches') return { stdout: '/tmp/main.ts:1\n', stderr: '' }
    return { stdout: [
      { type: 'begin', data: { path: { text: '/tmp/main.ts' } } },
      { type: 'match', data: { path: { text: '/tmp/main.ts' }, line_number: 1, lines: { text: 'needle\n' } } }
    ].map(value => JSON.stringify(value)).join('\n'), stderr: '' }
  })
  const result = await search.searchCode('needle', '/tmp', { workdir: '/tmp' })
  assert.equal(result.success, true)
  assert.ok(result.output.includes('needle'))
  assert.deepEqual(calls[0], { file: 'rg', args: ['--version'] })
  assert.equal(search.shellCalls(), 0)
})

test('Linux search reports execution errors without a false empty result or PowerShell call', async () => {
  const search = loadSearch(async (_file, args) => {
    if (args[0] === '--version') return { stdout: 'ripgrep 15', stderr: '' }
    throw Object.assign(new Error('spawn rg EACCES'), { code: 'EACCES' })
  })
  const result = await search.searchCode('needle', '/tmp')
  assert.equal(result.success, false)
  assert.ok(result.error.includes('EACCES'))
  assert.equal(search.shellCalls(), 0)
})

test('missing rg on Linux reports the missing dependency and Windows retains its fallback', async () => {
  const fail = async () => { throw Object.assign(new Error('missing executable'), { code: 'ENOENT' }) }
  const linux = loadSearch(fail)
  const result = await linux.searchCode('needle', '/tmp')
  assert.equal(result.success, false)
  assert.ok(result.error.includes('ripgrep executable was not found'))
  assert.equal(linux.shellCalls(), 0)
  const windows = loadSearch(fail, 'win32')
  assert.equal((await windows.searchCode('needle', '/tmp')).success, true)
  assert.equal(windows.shellCalls(), 1)
})

test('superseded audio start cannot remove listeners belonging to the current capture', async () => {
  const starts = []
  const frameListeners = new Set()
  const stoppedListeners = new Set()
  const api = {
    start: () => new Promise((resolve, reject) => starts.push({ resolve, reject })),
    stop: async () => {},
    onFrame(callback) { frameListeners.add(callback); return () => frameListeners.delete(callback) },
    onStopped(callback) { stoppedListeners.add(callback); return () => stoppedListeners.delete(callback) }
  }
  const visualizer = load('src/renderer/src/utils/systemAudioVisualizer.ts', {
    '../store/settings.store': { useSettingsStore: { getState: () => ({ settings: {} }) } }
  }, 'linux', '', { window: { syntee: { audioVisualizer: api } } })
  const received = []
  const unsubscribe = visualizer.subscribeAudioVisualizer(frame => received.push(frame))
  const previous = visualizer.startSystemAudioVisualizer('old')
  const previousFailure = assert.rejects(previous, /cancelled/)
  const current = visualizer.startSystemAudioVisualizer('new')
  starts[0].reject(new Error('cancelled'))
  await previousFailure
  starts[1].resolve()
  await current
  assert.equal(frameListeners.size, 1)
  assert.equal(stoppedListeners.size, 1)
  const frame = { level: 0.5 }
  for (const callback of frameListeners) callback(frame)
  assert.equal(received.at(-1), frame)
  visualizer.stopSystemAudioVisualizer()
  assert.equal(frameListeners.size, 0)
  assert.equal(stoppedListeners.size, 0)
  unsubscribe()
})
