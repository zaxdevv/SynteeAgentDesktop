import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { threadId, isMainThread } from 'node:worker_threads'

const ENABLED = process.env.SYNTEE_PERF_DIAGNOSTICS === '1'
let outputPath: string | undefined
let writeChain: Promise<void> = Promise.resolve()

export function isPerformanceDiagnosticsEnabled(): boolean { return ENABLED }

/** Configure per-process output location; no-op unless explicitly enabled. */
export function configurePerformanceDiagnostics(directory: string): void {
  if (!ENABLED) return
  outputPath = join(directory, `performance-${isMainThread ? 'main' : `worker-${threadId}`}.jsonl`)
}

export function perfMark(): number { return ENABLED ? performance.now() : 0 }

export function perfEvent(name: string, durationMs: number, fields?: Record<string, number | string | boolean | null>): void {
  if (!ENABLED) return
  const event = { ts: new Date().toISOString(), name, durationMs: Math.max(0, Number(durationMs.toFixed(2))), pid: process.pid, threadId, ...fields }
  const line = `${JSON.stringify(event)}\n`
  if (!outputPath) { console.info(`[perf] ${line.trimEnd()}`); return }
  const path = outputPath
  writeChain = writeChain.then(async () => {
    try { await mkdir(join(path, '..'), { recursive: true }); await appendFile(path, line, 'utf8') }
    catch { /* diagnostics must never affect application behavior */ }
  })
}

export function perfPhase<T>(name: string, fn: () => T, fields?: Record<string, number | string | boolean | null>): T {
  if (!ENABLED) return fn()
  const started = performance.now()
  try { return fn() } finally { perfEvent(name, performance.now() - started, fields) }
}

export async function perfPhaseAsync<T>(name: string, fn: () => Promise<T>, fields?: Record<string, number | string | boolean | null>): Promise<T> {
  if (!ENABLED) return fn()
  const started = performance.now()
  try { return await fn() } finally { perfEvent(name, performance.now() - started, fields) }
}

/** Opt-in event-loop delay, CPU and RSS sampler. Caller owns lifecycle. */
export function startPerformanceSampling(intervalMs = 10_000): () => void {
  if (!ENABLED) return () => undefined
  let previous = performance.now()
  let previousCpu = process.cpuUsage()
  const lag = monitorEventLoopDelay({ resolution: 20 })
  lag.enable()
  const sample = () => {
    const now = performance.now()
    const cpu = process.cpuUsage()
    perfEvent('process.sample', now - previous, {
      eventLoopDelayMs: Math.max(0, now - previous - intervalMs),
      eventLoopP95Ms: lag.percentile(95) / 1e6,
      eventLoopMaxMs: lag.max / 1e6,
      cpuUserMs: (cpu.user - previousCpu.user) / 1000,
      cpuSystemMs: (cpu.system - previousCpu.system) / 1000,
      rssBytes: process.memoryUsage().rss,
    })
    previous = now
    previousCpu = cpu
    lag.reset()
  }
  const timer = setInterval(sample, intervalMs)
  timer.unref()
  return () => { clearInterval(timer); lag.disable() }
}
