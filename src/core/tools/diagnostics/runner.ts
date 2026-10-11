import { execAsync } from '../_shared'
import { resolve, join } from 'path'
import { AsyncLocalStorage } from 'async_hooks'
import type { DiagRunResult } from './types'

export interface CommandTrace { failed: boolean; output: string[]; results: DiagRunResult[] }
const traceStorage = new AsyncLocalStorage<CommandTrace>()
export function withDiagnosticCommandTrace<T>(trace: CommandTrace, run: () => Promise<T>): Promise<T> {
  return traceStorage.run(trace, run)
}
function shell(): string {
  return process.platform === 'win32'
    ? (process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'))
    : '/bin/bash'
}
function safeCommand(command: string): string {
  return command.replace(/(^|[&|;]\s*)npx\s+(?!--no-install\b)/g, '$1npx --no-install ')
}
export async function runDiagnosticCommand(cmd: string, cwd: string, timeoutMs = 120_000): Promise<DiagRunResult> {
  const trace = traceStorage.getStore()
  let outcome: DiagRunResult
  try {
    const result = await execAsync(safeCommand(cmd), {
      cwd: resolve(cwd), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
      shell: shell(), windowsHide: true, encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', npm_config_yes: 'false' },
    })
    const stdout = String(result.stdout ?? ''), stderr = String(result.stderr ?? '')
    outcome = { stdout, stderr, rawStdout: stdout, rawStderr: stderr, exitCode: 0, signal: null, timedOut: false, failed: false, failureReason: '' }
  } catch (error: any) {
    const stdout = String(error?.stdout ?? ''), stderr = String(error?.stderr ?? '')
    const timedOut = error?.killed === true || error?.code === 'ETIMEDOUT'
    const exitCode = typeof error?.code === 'number' ? error.code : null
    const signal = error?.signal ?? null
    const infrastructure = typeof error?.code === 'string' || signal !== null || exitCode === 127 || exitCode === 9009
    const reason = timedOut ? `command exceeded ${timeoutMs / 1000}s timeout`
      : infrastructure ? `command failed (${error.code ?? signal}): ${error.message}` : ''
    outcome = { stdout, stderr, rawStdout: stdout, rawStderr: stderr, exitCode, signal, timedOut, failed: timedOut || infrastructure, failureReason: reason }
  }
  outcome.stdout = outcome.stdout.replace(/\r\n/g, '\n')
  outcome.stderr = outcome.stderr.replace(/\r\n/g, '\n')
  if (trace) {
    trace.results.push(outcome)
    if (outcome.failed) trace.failed = true
    if (outcome.failed || outcome.exitCode !== 0) {
      trace.output.push(`${cmd}: exit=${outcome.exitCode}; ${outcome.failureReason}\n${outcome.stdout}\n${outcome.stderr}`)
    }
  }
  return outcome
}
/** Callers supply the complete probe (for example, 'ruff --version'). */
export async function isCommandAvailable(cmd: string, cwd = process.cwd()): Promise<boolean> {
  try {
    await execAsync(safeCommand(cmd), { cwd: resolve(cwd), timeout: 10_000, maxBuffer: 256 * 1024,
      shell: shell(), windowsHide: true, encoding: 'utf8', env: { ...process.env, npm_config_yes: 'false' } })
    return true
  } catch { return false }
}
