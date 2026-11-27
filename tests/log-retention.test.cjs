/* global require, __dirname, Buffer, process */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise filesystem and worker logging in isolated Node processes. */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
function compiled(file) {
  return ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
}
const filesModule = { exports: {} }
vm.runInNewContext(compiled('src/core/logFiles.ts'), { module: filesModule, exports: filesModule.exports, require, Buffer })
const { RotatingLogFile, redactLogText, safeLogValue } = filesModule.exports
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-log-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('rotating logs survive reopening, retain recent batches and keep a hard size/file count bound', t => {
  const dir = temp(t)
  const file = path.join(dir, 'debug.log')
  new RotatingLogFile(file, 64, 2).append('original session\n')
  const reopened = new RotatingLogFile(file, 64, 2)
  reopened.append('second session\n')
  assert.match(fs.readFileSync(file, 'utf8'), /original session\nsecond session/)
  for (let index = 0; index < 20; index++) reopened.append(`batch ${index} ${'x'.repeat(24)}\n`)
  assert.equal(fs.readdirSync(dir).length, 3)
  for (const entry of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, entry)).size <= 64)
  assert.match(fs.readFileSync(file, 'utf8'), /batch 19/)
  reopened.append('y'.repeat(200))
  assert.equal(fs.statSync(file).size, 64, 'a single oversized caller cannot bypass the cap')
})

test('retention removes only old owned log files, never unrelated user files', t => {
  const dir = temp(t)
  const file = path.join(dir, 'debug.log')
  for (const name of ['debug.log', 'debug.log.1', 'unrelated.txt']) {
    const target = path.join(dir, name)
    fs.writeFileSync(target, 'old content')
    fs.utimesSync(target, new Date(0), new Date(0))
  }
  new RotatingLogFile(file, 64, 2, 1000).append('new content')
  assert.equal(fs.readFileSync(file, 'utf8'), 'new content')
  assert.equal(fs.existsSync(`${file}.1`), false)
  assert.equal(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8'), 'old content')
})

test('diagnostic serialization redacts credentials and payload objects and tolerates cycles', () => {
  const raw = 'Bearer topsecret api_key="abc123" https://user:pass@example.com/?token=abc sk-abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
  const clean = redactLogText(raw)
  for (const secret of ['topsecret', 'abc123', 'user:pass', 'token=abc', 'sk-abcdefghijklmnop', 'eyJhbGci']) assert.equal(clean.includes(secret), false, secret)
  const value = { inputTokens: 120, contentChars: 700, messages: ['private prompt'], apiKey: 'opaque-key', nested: { transcript: 'private answer' } }
  value.self = value
  const serialized = JSON.stringify(safeLogValue(value))
  assert.match(serialized, /"inputTokens":120/)
  assert.match(serialized, /"contentChars":700/)
  for (const secret of ['private prompt', 'private answer', 'opaque-key']) assert.equal(serialized.includes(secret), false)
  assert.match(serialized, /circular/)
})

test('one main writer retains all concurrent worker logs across restarts and suppresses private async logs', t => {
  const dir = temp(t)
  fs.writeFileSync(path.join(dir, 'logFiles.js'), compiled('src/core/logFiles.ts'))
  fs.writeFileSync(path.join(dir, 'logger.js'), compiled('src/core/logger.ts'))
  const script = `
    const { Worker } = require('node:worker_threads')
    const logger = require('./logger.js')
    logger.log('MAIN_SESSION_MARKER')
    logger.log('payload', { messages: ['PRIVATE_PROMPT'], apiKey: 'opaque-credential' })
    ;(async () => {
      await logger.withLogPrivacy(true, async () => { await Promise.resolve(); logger.log('PRIVATE_ASYNC_MARKER') })
      await Promise.all(Array.from({length:3}, (_, worker) => new Promise((resolve,reject) => {
        const thread = new Worker(\`
          const { workerData } = require('node:worker_threads')
          const logger = require(workerData.logger)
          logger.setDefaultLogPrivacy(workerData.private)
          for(let n=0;n<130;n++) logger.log('WORKER_'+workerData.worker+'_'+n+'_END')
          logger.flushLogs()
        \`, { eval:true, workerData:{worker, logger:require.resolve('./logger.js'), private:worker===2} })
        thread.once('error',reject);thread.once('exit',code=>code ? reject(new Error('worker '+code)) : resolve())
      })))
      await new Promise(resolve=>setTimeout(resolve,100))
      logger.flushLogs()
    })().catch(error=>{console.error(error);process.exitCode=1})
  `
  fs.writeFileSync(path.join(dir, 'probe.cjs'), script)
  for (let launch = 0; launch < 2; launch++) {
    const run = spawnSync(process.execPath, ['probe.cjs'], {
      cwd: dir, env: { ...process.env, SYNTEE_USER_DATA_DIR: dir }, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    assert.equal(run.status, 0, run.stderr)
  }
  const log = fs.readFileSync(path.join(dir, 'logs', 'debug.log'), 'utf8')
  assert.equal(log.match(/MAIN_SESSION_MARKER/g).length, 2)
  assert.equal(log.match(/session started/g).length, 2, 'workers never restart/truncate the session log')
  for (let worker = 0; worker < 2; worker++) for (let line = 0; line < 130; line++) {
    assert.equal(log.split(`WORKER_${worker}_${line}_END`).length - 1, 2, `worker ${worker} line ${line}`)
  }
  for (const privateText of ['WORKER_2_', 'PRIVATE_PROMPT', 'opaque-credential', 'PRIVATE_ASYNC_MARKER']) assert.equal(log.includes(privateText), false)
  assert.equal(fs.readdirSync(path.join(dir, 'logs')).length, 1, 'worker IDs never create unbounded files')
})
