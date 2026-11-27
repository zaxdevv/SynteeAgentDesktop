/** Batched diagnostics with one file writer across main and worker threads. */
import * as path from 'node:path'
import { homedir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { BroadcastChannel, isMainThread } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { RotatingLogFile, redactLogText, safeLogValue } from './logFiles'

const configRoot = process.platform === 'win32'
  ? process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
  : process.platform === 'darwin' ? path.join(homedir(), 'Library', 'Application Support')
    : path.isAbsolute(process.env.XDG_CONFIG_HOME || '') ? process.env.XDG_CONFIG_HOME! : path.join(homedir(), '.config')
export const logDirectory = path.join(process.env.SYNTEE_USER_DATA_DIR || path.join(configRoot, 'SynteeHelper'), 'logs')
const channelName = `syntee-diagnostics-${createHash('sha256').update(logDirectory).digest('hex').slice(0, 24)}`
const privacy = new AsyncLocalStorage<boolean>()
let defaultPrivate = false
export function setDefaultLogPrivacy(incognito: boolean): void { defaultPrivate = incognito }
export function isPrivateLogContext(): boolean { return privacy.getStore() ?? defaultPrivate }
export function withLogPrivacy<T>(incognito: boolean, run: () => T): T { return privacy.run(incognito, run) }

const MAX_BATCH_BYTES = 64 * 1024
let buffer: string[] = []
let bufferBytes = 0
let timer: NodeJS.Timeout | null = null
let writer: RotatingLogFile | null = null
let channel: BroadcastChannel | null = null
let reportedFailure = false

function reportFailure(): void {
  if (!reportedFailure) console.warn('[logger] Cannot write diagnostic log')
  reportedFailure = true
}

export function flushLogs(): void {
  if (timer) { clearTimeout(timer); timer = null }
  if (!buffer.length) return
  const lines = buffer
  buffer = []
  bufferBytes = 0
  try {
    if (isMainThread) {
      writer ??= new RotatingLogFile(path.join(logDirectory, 'debug.log'))
      writer.append(lines.join(''))
    } else channel?.postMessage(lines)
  } catch { reportFailure() }
}

function queueLine(line: string): void {
  const bounded = `${redactLogText(line).slice(0, 8000).replace(/[\r\n]+/g, ' ')}\n`
  // Send immediately: terminate() can stop a worker before any timer/exit
  // handler runs. Only the main process buffers and touches rotating files.
  if (!isMainThread) {
    try { channel?.postMessage([bounded]) } catch { reportFailure() }
    return
  }
  const bytes = Buffer.byteLength(bounded)
  if (bufferBytes + bytes > MAX_BATCH_BYTES) flushLogs()
  if (buffer.length >= 100) flushLogs()
  buffer.push(bounded)
  bufferBytes += bytes
  if (!timer) {
    timer = setTimeout(flushLogs, 1000)
    timer.unref()
  }
}

try {
  channel = new BroadcastChannel(channelName)
  channel.unref()
  if (isMainThread) {
    channel.onmessage = event => {
      if (!Array.isArray(event.data)) return
      for (const line of event.data.slice(0, 100)) if (typeof line === 'string') queueLine(line)
    }
    queueLine(`[${new Date().toISOString()}] === SynteeHelper session started ===`)
  }
} catch { reportFailure() }

process.on('exit', flushLogs)

export function log(...args: unknown[]): void {
  if (isPrivateLogContext()) return
  try {
    const values = args.slice(0, 20).map(value => safeLogValue(value))
    queueLine(`[${new Date().toISOString()}] ${values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}`)
  } catch { /* Diagnostic arguments must never fail a user operation. */ }
}
