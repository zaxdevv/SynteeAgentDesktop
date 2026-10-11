import { resolve } from 'path'
import type { DiagnosticEntry } from './types'

export interface FormatInput {
  entries: DiagnosticEntry[]; failures: string[]; notes: string[]; detectedProviders: string[]
  changedFiles?: Set<string> | null; cwd?: string; checked?: number; skipped?: number; partial?: boolean
  offset?: number; limit?: number; maxChars?: number; reportPath?: string; scope?: string
}
export function formatDiagnosticsOutput(input: FormatInput): { success: boolean; output: string } {
  const { entries, failures, notes, detectedProviders, cwd = process.cwd() } = input
  const normalize = (f: string) => process.platform === 'win32' ? resolve(cwd, f).toLowerCase() : resolve(cwd, f)
  const changed = new Set([...(input.changedFiles ?? [])].map(normalize))
  const sorted = [...entries].sort((a, b) => Number(!changed.has(normalize(a.file))) - Number(!changed.has(normalize(b.file))) || a.file.localeCompare(b.file) || a.line - b.line)
  const errors = entries.filter(e => e.severity === 'error').length
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  const limit = Math.max(1, Math.floor(input.limit ?? (sorted.length || 1)))
  const partial = !!input.partial || failures.length > 0 || notes.length > 0
  const header = [
    `Diagnostics: ${partial ? 'PARTIAL — cannot claim the project is clean' : 'COMPLETE'}`,
    `Checked: ${input.checked ?? detectedProviders.length}; skipped: ${input.skipped ?? 0}; entries: ${entries.length} (${errors} errors, ${entries.length - errors} warnings).`,
    `Stacks: ${[...new Set(detectedProviders)].join(', ') || 'none'}.`,
  ]
  if (input.scope) header.push(`Scope: ${input.scope}`)
  if (input.reportPath) header.push(`Full report: ${input.reportPath}`)
  const max = input.maxChars ?? 8000
  // Summary always survives; verbose failures/notes and records are separate whole units.
  const output = [...header]
  let used = output.join('\n').length
  let omittedDetails = 0
  for (const detail of [...failures.map(f => `DIAGNOSTICS FAILURE: ${f}`), ...notes]) {
    if (used + detail.length + 150 <= max) { output.push(detail); used += detail.length + 1 }
    else omittedDetails++
  }
  if (omittedDetails) output.push(`${omittedDetails} detail(s) omitted; see full report or increase max_chars.`)
  let shown = 0
  for (const e of sorted.slice(offset, offset + limit)) {
    const line = `[${e.source}] ${e.severity === 'error' ? 'ERROR' : 'WARN'} ${e.file || '<project>'}:${e.line}${e.col ? ':' + e.col : ''} — ${e.message}`
    if (used + line.length + 150 > max) break
    output.push(line); used += line.length + 1; shown++
  }
  if (offset + shown < sorted.length) {
    output.push(`Showing records ${offset + 1}-${offset + shown} of ${sorted.length}. Pass offset=${offset + shown} to continue.`)
    if (!shown) output.push('Next record exceeds the response budget. Increase max_chars or read the full report.')
  }
  return { success: true, output: output.join('\n') }
}
