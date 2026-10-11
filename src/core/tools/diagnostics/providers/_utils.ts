// Shared provider helpers.
import { resolve, normalize } from 'path'
import { existsSync, readdirSync } from 'fs'
import type { DiagnosticEntry, DiagRunResult } from '../types'

function normalizedPath(value: string): string {
  const path = normalize(resolve(value))
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function filterEntriesByFiles(entries: DiagnosticEntry[], dir: string, files: string[]): DiagnosticEntry[] {
  const resolvedFiles = new Set(files.map((file) => normalizedPath(resolve(dir, file))))
  return entries.filter((entry) => {
    if (!entry.file) return true
    return resolvedFiles.has(normalizedPath(resolve(dir, entry.file)))
  })
}

export function hasFileWithExt(dir: string, ext: string): boolean {
  try { return readdirSync(dir).some((f) => f.endsWith(ext)) } catch { return false }
}
export function hasFileMatching(dir: string, patterns: string[]): boolean {
  try { return readdirSync(dir).some((f) => patterns.some((p) => f.endsWith(p) || f === p)) } catch { return false }
}
export function hasAnyMarker(dir: string, markers: string[]): boolean { return markers.some((m) => existsSync(resolve(dir, m))) }

/** Preserve the outcome of every executed command; a nonzero status with no parsed diagnostics is not clean. */
export function commandFailure(result: DiagRunResult, label: string, parsedCount?: number): string | undefined {
  result.parsedCount = parsedCount
  if (result.failed) return `${label}: ${result.failureReason || 'command failed to start'}`
  if (result.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0 && parsedCount === 0) {
    return `${label}: exited with code ${result.exitCode} without parseable diagnostics${result.stderr ? ` — ${result.stderr.trim().slice(0, 300)}` : ''}`
  }
  return undefined
}
export function parseJsonStrict<T>(text: string, label: string): { value?: T; error?: string } {
  try { return { value: JSON.parse(text) as T } }
  catch (e) { return { error: `${label}: invalid JSON output — ${String(e)}` } }
}
/** Run a command only if it reports successful exit and parsed output is trustworthy. */
export function guardedResult(result: DiagRunResult, label: string, parsedCount: number): string | undefined {
  return commandFailure(result, label, parsedCount)
}

export function parseColonFormat(output: string, source: string, severityMap?: (s: string) => 'error' | 'warning'): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/)
    if (!m) continue
    const rest = m[4], lower = rest.toLowerCase()
    const severity = lower.startsWith('warning') || lower.startsWith('note') ? 'warning' : severityMap?.(rest) ?? 'error'
    entries.push({ file: m[1].trim(), line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, severity, message: rest.replace(/^(error|warning|note)[:\s]+/i, '').trim(), source })
  }
  return entries
}
